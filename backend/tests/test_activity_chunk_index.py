"""The ledgers' read of one activity chunk goes through migration 053's index.

The fee, position and capital steps each read one chunk's events by pool and
chunk start. On 6 Oct 2026 no index began with those columns: for the two pools
holding 72% of domino_activity.events (about 2.87M rows) the planner read the
whole table, and with a cold cache that read passed the catalogue's 5 s
statement timeout. These tests take the three queries from their stores, give the table
that shape inside a transaction that is rolled back, and read each plan with
the index and without it.
"""
import os
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg.rows import dict_row

from dev_postgres import ADMIN, PORT, SOCKET

BACKEND = Path(__file__).resolve().parents[1]
MIGRATION = BACKEND / 'migrations/053_activity_chunk_index.sql'
STORES = ('fee_store.py', 'position_store.py', 'capital_store.py')
# A store's per-chunk read: its triple-quoted SELECT of events by pool and chunk start.
CHUNK_READ = re.compile(r"'''(SELECT\b[^']*?\bFROM domino_activity\.events\s+"
                        r"WHERE pool_id=%s AND chunk_start=%s\b[^']*?)'''")
INDEX = 'CREATE INDEX activity_chunk ON domino_activity.events USING btree (pool_id, chunk_start)'

# Production's shape, scaled down: pool 1 holds 74% of the rows (two pools held
# 72% of about 2.87M) at 40 events a chunk (their averages were 30 and 41);
# seven smaller pools have 2 events in each of their chunks. Pool ids no other
# test uses.
POOLS, CHUNKS, BIG, SMALL = 8, 800, 40, 2
POOL_ID = "'0x'||repeat('c',56)||lpad(to_hex({}),8,'0')"
SEED = f'''
INSERT INTO domino_activity.pools(pool_id,pool_key,start_block,base_hash,next_block,revision,methodology_version)
SELECT {POOL_ID.format('p')},'{{}}'::jsonb,1000,'0x'||repeat('0',64),{1000 + CHUNKS * 1000},0,1
FROM generate_series(1,{POOLS}) p;
INSERT INTO domino_activity.chunks(pool_id,start_block,end_block,end_hash,end_timestamp,model,state_snapshot)
SELECT {POOL_ID.format('p')},1000+k*1000,1999+k*1000,'0x'||repeat('0',64),0,'{{}}'::jsonb,'{{}}'::jsonb
FROM generate_series(0,{CHUNKS - 1}) k,generate_series(1,{POOLS}) p;
INSERT INTO domino_activity.events(pool_id,chunk_start,block_number,block_hash,block_timestamp,tx_hash,
                                   log_index,kind,payload,raw_fingerprint)
SELECT {POOL_ID.format('p')},1000+k*1000,1000+k*1000+i,'0x'||md5('b'||k||':'||i)||md5('B'||k||':'||i),
       1700000000+k*250+i,'0x'||md5('t'||p||':'||k||':'||i)||md5('T'||p||':'||k||':'||i),i,'swap',
       jsonb_build_object('amount0',repeat('1',40),'amount1','-'||repeat('2',40),
                          'sqrtPriceX96',repeat('3',49),'sender','0x'||repeat('a',40)),
       '0x'||md5('r'||p||':'||k||':'||i)||md5('R'||p||':'||k||':'||i)
FROM generate_series(0,{CHUNKS - 1}) k,generate_series(1,{POOLS}) p,
     generate_series(0,CASE WHEN p=1 THEN {BIG - 1} ELSE {SMALL - 1} END) i
ORDER BY k,p,i;
ANALYZE domino_activity.pools;
ANALYZE domino_activity.chunks;
ANALYZE domino_activity.events;
'''


def chunk_reads():
    """Each ledger store's read of one chunk's events, as its source has it."""
    return {name: CHUNK_READ.findall((BACKEND / name).read_text()) for name in STORES}


def nodes(plan):
    yield plan
    for child in plan.get('Plans', ()):
        yield from nodes(child)


class ChunkReadSourceTests(unittest.TestCase):
    def test_each_ledger_reads_one_chunk_by_pool_and_chunk_start(self):
        for name, reads in chunk_reads().items():
            with self.subTest(store=name):
                self.assertEqual(len(reads), 1)
                self.assertTrue(' '.join(reads[0].split()).endswith(
                    'ORDER BY block_number,log_index LIMIT 2001'))


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires disposable PostgreSQL databases')
class ChunkIndexPostgresTests(unittest.TestCase):
    settings = {'host': str(SOCKET), 'port': PORT, 'dbname': 'domino_catalogue_tests'}

    def connect(self):
        return psycopg.connect(**self.settings, user=ADMIN, row_factory=dict_row)

    def definition(self, conn):
        row = conn.execute("SELECT pg_get_indexdef(to_regclass('domino_activity.activity_chunk')) AS definition"
                           ).fetchone()
        return row['definition']

    def scans(self, conn, query, pool, chunk):
        """Every node of the plan PostgreSQL runs for the store's own query."""
        row = conn.execute('EXPLAIN (ANALYZE, FORMAT JSON) ' + query, (pool, chunk)).fetchone()
        return list(nodes(row['QUERY PLAN'][0]['Plan']))

    def test_the_migration_indexes_events_by_pool_and_chunk_and_applies_again(self):
        with self.connect() as conn, conn.transaction(force_rollback=True):
            self.assertEqual(self.definition(conn), INDEX)
            # dev_postgres.create_database applies every migration again on a restore.
            conn.execute(MIGRATION.read_text())
            self.assertEqual(self.definition(conn), INDEX)

    def test_each_ledger_reads_only_its_chunk_through_the_index(self):
        reads = {name: found[0] for name, found in chunk_reads().items()}
        with self.connect() as conn, conn.transaction(force_rollback=True):
            conn.execute(SEED)
            pool = conn.execute(f'SELECT {POOL_ID.format(1)} AS pool').fetchone()['pool']
            chunk = 1000 + CHUNKS // 2 * 1000
            for name, query in reads.items():
                with self.subTest(store=name, index=True):
                    scans = self.scans(conn, query, pool, chunk)
                    used = [node for node in scans if node.get('Index Name') == 'activity_chunk']
                    self.assertEqual(len(used), 1, scans)
                    self.assertIn('pool_id', used[0]['Index Cond'])
                    self.assertIn('chunk_start', used[0]['Index Cond'])
                    # The chunk's own rows, nothing of the rest of its pool.
                    self.assertEqual(float(used[0]['Actual Rows']), BIG)
                    self.assertFalse(any(node.get('Rows Removed by Filter') for node in scans), scans)
            # The control: without the index the same reads scan the pool's other
            # chunks and filter them out, as production's plan did.
            conn.execute('DROP INDEX domino_activity.activity_chunk')
            for name, query in reads.items():
                with self.subTest(store=name, index=False):
                    scans = self.scans(conn, query, pool, chunk)
                    self.assertFalse(any('chunk_start' in node.get('Index Cond', '') for node in scans), scans)
                    self.assertTrue(any('chunk_start' in node.get('Filter', '') for node in scans), scans)


if __name__ == '__main__':
    unittest.main()
