"""The ledgers find a chunk's predecessor through the primary key, with the end_block lookup's answers.

The fee, position and capital steps each read the chunk that ends right before the one they replay. They looked it
up by end_block, which has no index, so PostgreSQL read every chunk of the pool and filtered them by end_block. From
3 to 7 Nov 2026 the fee and position lookups passed the catalogue's 5 s statement timeout 369 times, in pools of
64,000 to 88,000 chunks. Each was stored as catalogue_database_unavailable, and pool-activity answered 503 for those
pools. Chunks are contiguous and never overlap, so the predecessor is the nearest earlier chunk by start_block when
that chunk ends at start_block-1. These tests pin the lookup's shape, how each step accepts its row, its plan in
PostgreSQL, and its answers, which must be the ones the end_block lookup gave.
"""
from contextlib import ExitStack
import os
from pathlib import Path
import re
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

import psycopg
from psycopg.rows import dict_row

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import capital_store
from capital_store import CapitalIndexer, VERSION as CAPITAL_VERSION
from dev_postgres import ADMIN, PORT, SOCKET
from discovery import DataError
from fee_accounting import VERSION as FEE_VERSION
import fee_store
from fee_store import FeeIndexer
from position_accounting import VERSION as POSITION_VERSION
import position_store
from position_store import PositionIndexer

BACKEND = Path(__file__).resolve().parents[1]
# Each store's predecessor lookup, found by the columns only it selects.
MARKERS = {'fee_store.py': 'f.model AS fee_model',
           'position_store.py': 'p.model AS position_model,p.methodology_version',
           'capital_store.py': 'k.methodology_version AS capital_version'}
# The chunks part of each lookup: bounded by start_block, newest first, one row.
CHUNK_READS = {
    'fee_store.py': 'WHERE c.pool_id=%s AND c.start_block<%s ORDER BY c.start_block DESC LIMIT 1',
    'position_store.py': 'WHERE c.pool_id=%s AND c.start_block<%s ORDER BY c.start_block DESC LIMIT 1',
    # The position join is inner: the limit applies to the chunks alone, in a derived table.
    'capital_store.py': ('FROM (SELECT * FROM domino_activity.chunks WHERE pool_id=%s AND start_block<%s '
                         'ORDER BY start_block DESC LIMIT 1) c'),
}
CALL = re.compile(r"'''([^']*?)'''\s*,\s*\(([^()]*)\)\)\.fetchone\(\)")
# The end_block lookups as the stores had them until 7 Nov 2026, bound to start_block-1. They are the control for the
# plan, and their answers are the ones to keep.
ENDED = {
    'fee_store.py': '''SELECT c.*,f.model AS fee_model,f.methodology_version FROM domino_activity.chunks c
      LEFT JOIN domino_activity.fee_chunks f ON f.pool_id=c.pool_id AND f.chunk_start=c.start_block
      WHERE c.pool_id=%s AND c.end_block=%s''',
    'position_store.py': '''SELECT c.*,p.model AS position_model,p.methodology_version
      FROM domino_activity.chunks c LEFT JOIN domino_activity.position_chunks p
      ON p.pool_id=c.pool_id AND p.chunk_start=c.start_block WHERE c.pool_id=%s AND c.end_block=%s''',
    'capital_store.py': '''SELECT c.*,p.model AS position_model,
      p.methodology_version AS position_version,k.methodology_version AS capital_version
      FROM domino_activity.chunks c JOIN domino_activity.position_chunks p
      ON p.pool_id=c.pool_id AND p.chunk_start=c.start_block
      LEFT JOIN domino_activity.capital_chunks k ON k.pool_id=c.pool_id AND k.chunk_start=c.start_block
      WHERE c.pool_id=%s AND c.end_block=%s''',
}


def lookups():
    """Each store's predecessor lookup and the parameters it binds, as its source has them."""
    found = {}
    for name, marker in MARKERS.items():
        found[name] = [(' '.join(query.split()), ''.join(params.split()))
                       for query, params in CALL.findall((BACKEND / name).read_text())
                       if marker in ' '.join(query.split())]
    return found


# The two reads of a pool's newest chunks: the tail (activity_store) and the reconcile's last 64 (activity_indexer).
# test_activity_chunk_index reads their plans; this file stands alone, so a release line can carry it without that one.
NEWEST_READ = re.compile(r"(SELECT [^'\"]*?FROM domino_activity\.chunks\s+"
                         r"WHERE pool_id=%s ORDER BY \w+ DESC LIMIT \d+)")


def newest_reads():
    return {name: [' '.join(query.split()) for query in NEWEST_READ.findall((BACKEND / name).read_text())]
            for name in ('activity_store.py', 'activity_indexer.py')}


def nodes(plan):
    yield plan
    for child in plan.get('Plans', ()):
        yield from nodes(child)


class PredecessorSourceTests(unittest.TestCase):
    def test_each_ledger_looks_its_predecessor_up_by_start_block(self):
        for name, found in lookups().items():
            with self.subTest(store=name):
                self.assertEqual(len(found), 1, found)
                query, params = found[0]
                self.assertIn(CHUNK_READS[name], query)
                self.assertNotIn('end_block', query)
                # Bound by the chunk's own start: start_block-1 would skip a one-block predecessor.
                self.assertEqual(params, "pool_id,chunk['start_block']")

    def test_the_newest_chunks_are_read_by_start_block(self):
        # The tail (activity_store) and the reconcile's last 64 (activity_indexer), fixed on 2 Nov 2026 (#453).
        for name, found in newest_reads().items():
            with self.subTest(store=name):
                self.assertEqual(len(found), 1, found)
                self.assertIn('ORDER BY start_block DESC', found[0])


POOL = '0x' + 'ab' * 32
TAIL = {'start_block': 5000, 'end_block': 5999, 'end_hash': '0x' + '5' * 64}


def chunk(start, end):
    return {'pool_id': POOL, 'start_block': start, 'end_block': end, 'end_hash': '0x' + f'{end:064x}',
            'end_timestamp': end, 'model': {}, 'state_snapshot': {}}


# The chunk each step replays, the chunk that ends right before it, and the nearest earlier chunk across a gap.
CHUNK, ADJACENT, DETACHED = chunk(3000, 3999), chunk(2000, 2999), chunk(1000, 1999)
LEDGERS = {
    'fee': {'worker': FeeIndexer, 'module': fee_store, 'marker': MARKERS['fee_store.py'],
            'before': [('f.pool_id IS NULL ORDER BY c.start_block LIMIT 1', CHUNK)], 'after': [],
            'qualified': {'fee_model': {'version': FEE_VERSION}, 'methodology_version': FEE_VERSION},
            'unqualified': {'fee_model': None, 'methodology_version': None},
            'proceeds': 'fee_activity_reorg_requires_replay', 'mismatch': 'fee_methodology_mismatch',
            'anchor': 'fee_replay_anchor_required'},
    'position': {'worker': PositionIndexer, 'module': position_store, 'marker': MARKERS['position_store.py'],
                 'before': [('p.pool_id IS NULL ORDER BY c.start_block LIMIT 1', CHUNK),
                            ('SELECT * FROM domino_activity.fee_chunks WHERE pool_id=%s AND chunk_start=%s',
                             {'methodology_version': FEE_VERSION, 'model': {}})], 'after': [],
                 'qualified': {'position_model': {'version': POSITION_VERSION},
                               'methodology_version': POSITION_VERSION},
                 'unqualified': {'position_model': None, 'methodology_version': None},
                 'proceeds': 'position_activity_reorg_requires_replay', 'mismatch': 'position_methodology_mismatch',
                 'anchor': 'position_anchor_required'},
    # Capital names a missing and an unqualified predecessor alike; its answers to the gap still differ.
    'capital': {'worker': CapitalIndexer, 'module': capital_store, 'marker': MARKERS['capital_store.py'],
                'before': [('k.pool_id IS NULL ORDER BY c.start_block LIMIT 1', CHUNK),
                           ('SELECT * FROM domino_activity.position_chunks WHERE pool_id=%s AND chunk_start=%s',
                            {'methodology_version': POSITION_VERSION, 'model': {}, 'reconciliation': {}})],
                'after': [('FROM domino_activity.events WHERE pool_id=%s AND chunk_start=%s', [])],
                'qualified': {'position_model': {}, 'position_version': POSITION_VERSION,
                              'capital_version': CAPITAL_VERSION},
                'unqualified': {'position_model': {}, 'position_version': POSITION_VERSION, 'capital_version': None},
                'proceeds': 'capital_activity_reorg_requires_replay', 'mismatch': 'capital_history_anchor_required',
                'anchor': 'capital_history_anchor_required'},
}


class Script:
    """A writer connection that answers a step's queries in order, each checked by a fragment of its text."""
    def __init__(self, *answers):
        self.answers, self.queries = list(answers), []

    def execute(self, query, params=()):
        text = ' '.join(query.split())
        self.queries.append((text, params))
        if not self.answers:
            raise AssertionError('unexpected query: ' + text)
        fragment, value = self.answers.pop(0)
        if fragment not in text:
            raise AssertionError(f'expected a query with {fragment!r}, got {text!r}')
        return SimpleNamespace(fetchone=lambda: value, fetchall=lambda: value)


class PredecessorStepTests(unittest.TestCase):
    def step(self, ledger, previous, *, first=False):
        """The step's error once the predecessor lookup answers `previous`, and the connection's queries."""
        spec = LEDGERS[ledger]
        conn = Script(*spec['before'], (spec['marker'], previous), *spec['after'])
        store = MagicMock()
        store.catalogue.connection.return_value.__enter__.return_value = conn
        store.pool.return_value = {'pool_id': POOL, 'pool_key': {},
                                   'start_block': CHUNK['start_block'] if first else ADJACENT['start_block'] - 1000}
        store.tail.return_value = TAIL
        worker = spec['worker'](store, None)
        worker.activity = MagicMock()
        # The tail is canonical and the replayed chunk is not, so a step that passes the predecessor checks stops at
        # the source check that follows them, before any replay.
        worker.activity.chain.block.side_effect = lambda number: SimpleNamespace(
            number=number, hash=TAIL['end_hash'] if number == TAIL['end_block'] else '0x' + 'f' * 64,
            timestamp=number)
        module = spec['module']
        with ExitStack() as stack:
            stack.enter_context(patch.object(module, 'checked_key', return_value=SimpleNamespace()))
            stack.enter_context(patch.object(module, 'record_failure'))
            if hasattr(module, 'supported'):
                stack.enter_context(patch.object(module, 'supported', return_value=True))
            if module is capital_store:
                stack.enter_context(patch.object(module, 'read_positions',
                                                 return_value={'status': 'reconciled_as_of'}))
            with self.assertRaises(DataError) as caught:
                worker.step(POOL)
        lookup = [params for text, params in conn.queries if spec['marker'] in text]
        self.assertEqual(lookup, [(POOL, CHUNK['start_block'])])
        return str(caught.exception)

    def test_the_chunk_that_ends_right_before_is_the_predecessor(self):
        for ledger, spec in LEDGERS.items():
            with self.subTest(ledger=ledger):
                self.assertEqual(self.step(ledger, {**ADJACENT, **spec['qualified']}), spec['proceeds'])
                # Its ledger is still checked.
                self.assertEqual(self.step(ledger, {**ADJACENT, **spec['unqualified']}), spec['mismatch'])

    def test_an_earlier_chunk_across_a_gap_is_no_predecessor(self):
        # The end_block lookup found no row here, and the step asked for an anchor. A qualified ledger on that
        # earlier chunk must not let the replay continue, and an unqualified one is not what stops it.
        for ledger, spec in LEDGERS.items():
            with self.subTest(ledger=ledger):
                self.assertEqual(self.step(ledger, {**DETACHED, **spec['qualified']}), spec['anchor'])
                self.assertEqual(self.step(ledger, {**DETACHED, **spec['unqualified']}), spec['anchor'])

    def test_no_earlier_chunk_needs_the_pool_start(self):
        for ledger, spec in LEDGERS.items():
            with self.subTest(ledger=ledger):
                self.assertEqual(self.step(ledger, None), spec['anchor'])
                self.assertEqual(self.step(ledger, None, first=True), spec['proceeds'])


# Eight pools of 800 contiguous 1,000-block chunks, under pool ids no other test uses ('d' where
# test_activity_chunk_index has 'c'), so the dead index entries a rolled-back seed leaves never meet another test's
# keys. No events: the lookups never read them. Every chunk has fee and position rows and only the first half has
# capital rows: positions run ahead of capital, as in production, so a plan that scans ledger rows past the chunk
# would show it.
POOLS, CHUNKS = 8, 800
HALF = 1000 + CHUNKS // 2 * 1000
POOL_ID = "'0x'||repeat('d',56)||lpad(to_hex({}),8,'0')"
SEED = f'''
INSERT INTO domino_activity.pools(pool_id,pool_key,start_block,base_hash,next_block,revision,methodology_version)
SELECT {POOL_ID.format('p')},'{{}}'::jsonb,1000,'0x'||repeat('0',64),{1000 + CHUNKS * 1000},0,1
FROM generate_series(1,{POOLS}) p;
INSERT INTO domino_activity.chunks(pool_id,start_block,end_block,end_hash,end_timestamp,model,state_snapshot)
SELECT {POOL_ID.format('p')},1000+k*1000,1999+k*1000,'0x'||repeat('0',64),0,'{{}}'::jsonb,'{{}}'::jsonb
FROM generate_series(0,{CHUNKS - 1}) k,generate_series(1,{POOLS}) p;
INSERT INTO domino_activity.fee_chunks(pool_id,chunk_start,methodology_version,model)
SELECT {POOL_ID.format('p')},1000+k*1000,1,'{{}}'::jsonb
FROM generate_series(0,{CHUNKS - 1}) k,generate_series(1,{POOLS}) p;
INSERT INTO domino_activity.position_chunks(pool_id,chunk_start,methodology_version,model,reconciliation)
SELECT {POOL_ID.format('p')},1000+k*1000,1,'{{}}'::jsonb,'{{}}'::jsonb
FROM generate_series(0,{CHUNKS - 1}) k,generate_series(1,{POOLS}) p;
INSERT INTO domino_activity.capital_chunks(pool_id,chunk_start,methodology_version,event_count,end_capital)
SELECT {POOL_ID.format('p')},1000+k*1000,1,0,'{{}}'::jsonb
FROM generate_series(0,{CHUNKS // 2 - 1}) k,generate_series(1,{POOLS}) p;
ANALYZE domino_activity.pools;
ANALYZE domino_activity.chunks;
ANALYZE domino_activity.fee_chunks;
ANALYZE domino_activity.position_chunks;
ANALYZE domino_activity.capital_chunks;
'''


MIGRATION = BACKEND / 'migrations/060_chunk_end_index.sql'
# The definition production's concurrent build has had since 7 Nov 2026 (pg_get_indexdef).
CHUNK_END = 'CREATE INDEX chunk_end ON domino_activity.chunks USING btree (pool_id, end_block)'


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires disposable PostgreSQL databases')
class PredecessorPostgresTests(unittest.TestCase):
    settings = {'host': str(SOCKET), 'port': PORT, 'dbname': 'domino_catalogue_tests'}

    def definition(self, conn):
        return conn.execute("SELECT pg_get_indexdef(to_regclass('domino_activity.chunk_end')) AS definition"
                            ).fetchone()['definition']

    def seeded(self, conn):
        conn.execute(SEED)
        return conn.execute(f'SELECT {POOL_ID.format(1)} AS pool').fetchone()['pool']

    def connect(self):
        return psycopg.connect(**self.settings, user=ADMIN, row_factory=dict_row)

    def scans(self, conn, query, params):
        plan = conn.execute('EXPLAIN (ANALYZE, FORMAT JSON) ' + query, params).fetchone()['QUERY PLAN']
        return list(nodes(plan[0]['Plan']))

    def test_each_ledger_reads_one_chunk_backwards_through_the_primary_key(self):
        with self.connect() as conn, conn.transaction(force_rollback=True):
            pool = self.seeded(conn)
            for name, ((query, _),) in lookups().items():
                with self.subTest(store=name):
                    row = conn.execute(query, (pool, HALF)).fetchone()
                    self.assertEqual((row['start_block'], row['end_block']), (HALF - 1000, HALF - 1))
                    scans = self.scans(conn, query, (pool, HALF))
                    chunks = [node for node in scans if node.get('Relation Name') == 'chunks']
                    self.assertEqual(len(chunks), 1, scans)
                    self.assertEqual((chunks[0]['Node Type'], chunks[0]['Index Name'], chunks[0]['Scan Direction']),
                                     ('Index Scan', 'chunks_pkey', 'Backward'))
                    self.assertIn('start_block', chunks[0]['Index Cond'])
                    # One chunk and at most one row of each ledger, though ledger rows go on past it; no sort and
                    # no end_block filter.
                    for node in scans:
                        if 'Relation Name' in node:
                            self.assertLessEqual(float(node['Actual Rows']), 1, node)
                    self.assertFalse(any(node['Node Type'] == 'Sort' for node in scans), scans)
                    self.assertFalse(any('end_block' in node.get('Filter', '') for node in scans), scans)

    def test_the_migration_indexes_chunks_by_pool_and_end_block_and_applies_again(self):
        with self.connect() as conn, conn.transaction(force_rollback=True):
            self.assertEqual(self.definition(conn), CHUNK_END)
            # Production built chunk_end concurrently before 060 existed; the migration must create the same index
            # where it is missing and leave it alone where it is not.
            conn.execute('DROP INDEX domino_activity.chunk_end')
            self.assertIsNone(self.definition(conn))
            conn.execute(MIGRATION.read_text())
            self.assertEqual(self.definition(conn), CHUNK_END)
            conn.execute(MIGRATION.read_text())
            self.assertEqual(self.definition(conn), CHUNK_END)

    def test_the_end_block_lookup_needs_chunk_end_or_filters_the_pool(self):
        # The control. With chunk_end (060), the fee and position end_block lookups read one chunk through it, as
        # production's have since 7 Nov 2026 14:34 UTC: an index scan or, with the rolled-back seeds' dead entries
        # a local cluster keeps, a bitmap scan of it. Without it, every end_block lookup reads at least the pool's
        # other chunks to find one. Production planned a bitmap scan of the pool; this small table may get a
        # sequential scan of every pool, which removes more, and capital's lookup may drive from position rows and
        # probe the chunks one by one. EXPLAIN gives a probe's removed rows as a rounded average per loop, so they
        # count once per loop, against half the pool: hundreds of chunks where the lookups now read one.
        # (Capital's lookup can take that route with chunk_end as well, so only the second half covers it.)
        with self.connect() as conn, conn.transaction(force_rollback=True):
            pool = self.seeded(conn)
            for name in ('fee_store.py', 'position_store.py'):
                with self.subTest(store=name, chunk_end=True):
                    scans = self.scans(conn, ENDED[name], (pool, HALF - 1))
                    self.assertTrue(any(node.get('Index Name') == 'chunk_end' for node in scans), scans)
                    chunks = [node for node in scans if node.get('Relation Name') == 'chunks']
                    self.assertEqual(len(chunks), 1, scans)
                    self.assertLessEqual(float(chunks[0]['Actual Rows']), 1, chunks)
                    self.assertNotIn('end_block', chunks[0].get('Filter', ''), chunks)
            conn.execute('DROP INDEX domino_activity.chunk_end')
            for name, query in ENDED.items():
                with self.subTest(store=name, chunk_end=False):
                    chunks = [node for node in self.scans(conn, query, (pool, HALF - 1))
                              if node.get('Relation Name') == 'chunks']
                    self.assertTrue(any('end_block' in node.get('Filter', '') for node in chunks), chunks)
                    removed = sum(float(node.get('Rows Removed by Filter', 0)) * float(node.get('Actual Loops', 1))
                                  for node in chunks)
                    self.assertGreaterEqual(removed, CHUNKS // 2, chunks)

    def test_the_lookups_answer_as_the_end_block_lookups_did(self):
        # Every chunk of a pool with a gap and with one chunk that has no position row (nor capital row): the
        # nearest earlier chunk, accepted only when it ends at start_block-1, is the row the end_block lookup gave.
        gap, unpositioned = 1000 + 300 * 1000, 1000 + 200 * 1000
        with self.connect() as conn, conn.transaction(force_rollback=True):
            pool = self.seeded(conn)
            conn.execute('DELETE FROM domino_activity.chunks WHERE pool_id=%s AND start_block=%s', (pool, gap))
            conn.execute('DELETE FROM domino_activity.position_chunks WHERE pool_id=%s AND chunk_start=%s',
                         (pool, unpositioned))
            starts = [row['start_block'] for row in conn.execute(
                'SELECT start_block FROM domino_activity.chunks WHERE pool_id=%s ORDER BY start_block', (pool,))]
            for name, ((query, _),) in lookups().items():
                with self.subTest(store=name):
                    found = 0
                    for start in starts:
                        before = conn.execute(ENDED[name], (pool, start - 1)).fetchone()
                        nearest = conn.execute(query, (pool, start)).fetchone()
                        accepted = nearest if nearest and nearest['end_block'] == start - 1 else None
                        self.assertEqual(accepted, before, start)
                        found += before is not None
                    # All but the first chunk and the one after the gap; capital's inner join also finds nothing
                    # after the chunk without a position row.
                    self.assertEqual(found, len(starts) - (3 if name == 'capital_store.py' else 2))


if __name__ == '__main__':
    unittest.main()
