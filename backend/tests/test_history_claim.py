"""The history lane's claim probes domino_public.entities through its primary key.

The claim picks the next due history job, ordering by whether its pool was requested in the last minute and,
past the demand horizon, keeping only pools the featured selection keeps warm. Both checks are correlated
EXISTS probes on domino_public.entities, run once per due job. Their filter was kind and entity_id only.
The primary key is (chain_id, kind, entity_id), and PostgreSQL 16 cannot skip its leading column, so each
probe walked every pool entry of public_entities_due (kind, next_due, entity_id). In production on
7 Nov 2026 (757 jobs, 22,962 pools) the claim's selection took 1.1 s warm, plus 0.23 s of JIT that its
cost estimate triggered. Its UPDATE passed the 5 s statement timeout 5 times from 2 to 7 Nov. Every
entities row is chain 4663 (CHECK), so naming chain_id keeps the answer and makes each probe one key read:
3.7 ms in production.
"""
from contextlib import contextmanager
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import psycopg
from psycopg.rows import dict_row

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dev_postgres import ADMIN, PORT, SOCKET
from discovery import CHAIN_ID
from public_history import PublicHistory

CLAIM = 'UPDATE domino_public.history_jobs j SET lease_token=%s,'
PROBES = ("warm.chain_id=%s AND warm.kind='pool' AND warm.entity_id=q.pool_id",
          "e.chain_id=%s AND e.kind='pool' AND e.entity_id=q.pool_id")


def claiming(writer, conn):
    """Patch the writer's store so its claim runs on `conn`."""
    @contextmanager
    def connection(*, write=False):
        if not write:
            raise AssertionError('the claim must take a writer connection')
        yield conn
    return patch.object(writer.store, 'connection', connection)


class HistoryClaimShapeTests(unittest.TestCase):
    def test_both_entities_probes_name_the_chain_bound_to_chain_id(self):
        calls = []

        class Conn:
            def execute(self, query, params=()):
                calls.append((' '.join(query.split()), params))
                return SimpleNamespace(fetchone=lambda: {'turn': False} if 'AS turn' in query else None)

        writer = PublicHistory(SimpleNamespace(settings={}), writer=True)
        with claiming(writer, Conn()):
            self.assertIsNone(writer.claim())
        update, params = calls[-1]
        self.assertTrue(update.startswith(CLAIM), update)
        for probe in PROBES:
            self.assertEqual(update.count(probe), 1, probe)
        self.assertEqual(update.count('domino_public.entities'), 2)
        # Bound in order: the lease token, its seconds, the two chains, then the cadence.
        self.assertEqual(params[1:], (90, CHAIN_ID, CHAIN_ID, False))


# Production's proportions, scaled down: many more pools than due jobs. Pool ids no other test uses ('e').
# Half the jobs are past the seven-day demand horizon, so the warm probe runs for them as well. The recent
# day of every job is complete, and a few pools are hot or kept warm.
POOL_ID = "'0x'||repeat('e',56)||lpad(to_hex({}),8,'0')"
POOLS, JOBS = 20000, 300
SEED = f'''
INSERT INTO domino_public.entities(kind,entity_id,last_requested_at)
SELECT 'pool',{POOL_ID.format('n')},clock_timestamp()-interval '2 days' FROM generate_series(1,{POOLS}) n;
UPDATE domino_public.entities SET last_requested_at=clock_timestamp()
WHERE kind='pool' AND entity_id IN (SELECT {POOL_ID.format('n')} FROM generate_series(1,{JOBS},30) n);
UPDATE domino_public.entities SET keep_warm_until=clock_timestamp()+interval '1 hour'
WHERE kind='pool' AND entity_id IN (SELECT {POOL_ID.format('n')} FROM generate_series(2,{JOBS},20) n);
INSERT INTO domino_public.history_jobs(pool_id,window_seconds,last_requested_at,next_due,completed_at)
SELECT {POOL_ID.format('n')},86400,
       clock_timestamp()-CASE WHEN n%2=0 THEN interval '8 days' ELSE interval '1 day' END,
       clock_timestamp()-interval '1 minute',clock_timestamp()-interval '1 hour'
FROM generate_series(1,{JOBS}) n;
ANALYZE domino_public.entities;
ANALYZE domino_public.history_jobs;
'''


def nodes(plan):
    yield plan
    for child in plan.get('Plans', ()):
        yield from nodes(child)


class Explaining:
    """The test's connection, except that the claim's UPDATE runs under EXPLAIN ANALYZE with its own parameters."""
    def __init__(self, conn):
        self.conn, self.plan = conn, None

    def execute(self, query, params=()):
        if query.lstrip().startswith(CLAIM):
            self.plan = self.conn.execute('EXPLAIN (ANALYZE, FORMAT JSON) ' + query, params).fetchone()['QUERY PLAN']
            return SimpleNamespace(fetchone=lambda: None)
        return self.conn.execute(query, params)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires disposable PostgreSQL databases')
class HistoryClaimPlanTests(unittest.TestCase):
    settings = {'host': str(SOCKET), 'port': PORT, 'dbname': 'domino_catalogue_tests'}

    def test_each_entities_probe_reads_one_primary_key_entry(self):
        writer = PublicHistory(SimpleNamespace(settings=self.settings), writer=True)
        with psycopg.connect(**self.settings, user=ADMIN, row_factory=dict_row) as conn, \
                conn.transaction(force_rollback=True):
            conn.execute('TRUNCATE domino_public.history_jobs')
            conn.execute(SEED)
            explaining = Explaining(conn)
            with claiming(writer, explaining):
                writer.claim()
            plan = explaining.plan
            self.assertIsNotNone(plan)
            scans = list(nodes(plan[0]['Plan']))
            # The claim took one job.
            self.assertEqual(float(plan[0]['Plan']['Actual Rows']), 1)
            probes = [node for node in scans if node.get('Relation Name') == 'entities']
            self.assertEqual(len(probes), 2, scans)
            for probe in probes:
                self.assertEqual((probe['Node Type'], probe['Index Name']), ('Index Scan', 'entities_pkey'), probe)
                self.assertIn('chain_id', probe['Index Cond'])
                self.assertLessEqual(float(probe['Actual Rows']), 1, probe)
                self.assertGreaterEqual(int(probe['Actual Loops']), JOBS // 2, probe)
            self.assertFalse(any(node.get('Index Name') == 'public_entities_due' for node in scans), scans)


if __name__ == '__main__':
    unittest.main()
