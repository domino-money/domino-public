"""Demand scheduling in a separate database, with no public-data schema."""
from contextlib import ExitStack, redirect_stdout
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg import sql

from catalogue import PgCatalogue
from dev_postgres import ADMIN, PORT, SOCKET
from discovery import Block, DataError
import manage_activity
from pool_requests import PgRequests, WRITER_ROLE
import test_pool_requests as previous


def pool(number):return '0x'+f'{number:064x}'


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','isolated PostgreSQL required')
class QueuePriorityTests(previous.PoolRequestStoreTests):
    """Also repeat the existing lease/ACL/backoff suite against this database."""
    @classmethod
    def setUpClass(cls):
        cls.settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_queue_priority_tests'}
        with psycopg.connect(host=str(SOCKET),port=PORT,dbname='postgres',user=ADMIN,autocommit=True) as conn:
            if not conn.execute('SELECT 1 FROM pg_database WHERE datname=%s',(cls.settings['dbname'],)).fetchone():
                conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(cls.settings['dbname'])))
        migrations=Path(__file__).resolve().parents[1]/'migrations'
        with psycopg.connect(**cls.settings,user=ADMIN) as conn:
            for name in ('001_catalogue','002_activity','020_pool_requests','023_pool_request_scheduling'):
                conn.execute((migrations/(name+'.sql')).read_text())
            assert conn.execute("SELECT to_regnamespace('domino_public')").fetchone()[0] is None

    def setUp(self):
        self.catalogue=PgCatalogue(self.settings)
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('TRUNCATE domino_activity.pool_requests')
        self.requests=PgRequests(self.catalogue)

    def backlog(self,background=400,recent=17):
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute("""INSERT INTO domino_activity.pool_requests
              (pool_id,reason,last_requested_at,due_at,updated_at)
              SELECT '0x'||lpad(to_hex(n),64,'0'),'read','epoch'::timestamptz,
                statement_timestamp()-interval '1 day',statement_timestamp()-interval '1 day'
              FROM generate_series(1,%s) n""",(background,))
            conn.execute("""INSERT INTO domino_activity.pool_requests
              (pool_id,reason,last_requested_at,due_at,updated_at)
              SELECT '0x'||lpad(to_hex(n),64,'0'),'read',statement_timestamp(),
                statement_timestamp()-interval '1 second',statement_timestamp()-interval '1 second'
              FROM generate_series(10001,10000+%s) n""",(recent,))
        return [pool(n) for n in range(1,background+1)], [pool(n) for n in range(10001,10001+recent)]

    def test_recent_interest_overtakes_400_older_due_requests(self):
        background,recent=self.backlog()
        rows=self.requests.claim(limit=3)
        self.assertEqual([row['pool_id'] for row in rows],recent[:3])
        self.assertTrue(all(row['claim_generation']==1 for row in rows))
        self.assertEqual(self.requests.status(background[0])['attempts'],0)

    def test_quota_survives_new_instances_and_serves_all_17_hot_pools(self):
        background,recent=self.backlog()
        served=[]
        for _ in range(23):
            # Each call is a new worker object/transaction; no in-memory phase.
            claim=PgRequests(self.catalogue,role=WRITER_ROLE).claim()[0]
            served.append(claim['pool_id'])
            self.requests.record(claim['pool_id'],'following',claim=claim)
        self.assertEqual([value for value in served if value in recent],recent)
        self.assertEqual(served[3::4],background[:5])
        self.assertEqual(len(set(served)),23)

    def test_batch_claim_reserves_background_slots_too(self):
        background,recent=self.backlog()
        claimed=[row['pool_id'] for row in self.requests.claim(limit=8)]
        self.assertEqual(claimed,[*recent[:3],background[0],*recent[3:6],background[1]])

    def test_empty_lane_falls_back_and_does_not_waste_a_claim(self):
        background,_=self.backlog(background=5,recent=0)
        self.assertEqual([row['pool_id'] for row in self.requests.claim(limit=5)],background)
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('TRUNCATE domino_activity.pool_requests')
        _,recent=self.backlog(background=0,recent=5)
        self.assertEqual([row['pool_id'] for row in self.requests.claim(limit=5)],recent)

    def test_priority_respects_due_leases_exclusion_and_registration_cooldown(self):
        background,recent=self.backlog(background=2,recent=4)
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute("UPDATE domino_activity.pool_requests SET due_at=clock_timestamp()+interval '1 minute' WHERE pool_id=%s",(recent[0],))
            conn.execute("UPDATE domino_activity.pool_requests SET claim_token=%s,lease_until=clock_timestamp()+interval '1 minute' WHERE pool_id=%s",('ab'*32,recent[1]))
            conn.execute("UPDATE domino_activity.pool_requests SET status='registering',updated_at=clock_timestamp() WHERE pool_id=%s",(recent[2],))
        claimed=self.requests.claim(limit=2,exclude=[recent[3]],priority='recent')
        self.assertEqual([row['pool_id'] for row in claimed],background)

    def test_locked_recent_request_is_skipped_without_blocking_other_work(self):
        background,recent=self.backlog(background=1,recent=1)
        with psycopg.connect(**self.settings,user=ADMIN) as locked:
            locked.execute('SELECT pool_id FROM domino_activity.pool_requests WHERE pool_id=%s FOR UPDATE',(recent[0],))
            self.assertEqual(self.requests.claim()[0]['pool_id'],background[0])

    def test_readmitting_a_background_pool_promotes_it_without_resetting_progress(self):
        background,_=self.backlog(background=5,recent=0)
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute("UPDATE domino_activity.pool_requests SET status='indexing',span_blocks=6250,claim_generation=8 WHERE pool_id=%s",(background[-1],))
        self.requests.enqueue(background[-1])
        claim=self.requests.claim()[0]
        self.assertEqual(claim['pool_id'],background[-1])
        self.assertEqual(claim['span_blocks'],6250)
        self.assertEqual(claim['claim_generation'],9)

    def worker(self,*,max_pools=1,budget_error=False):
        indexer=Mock()
        indexer.step.return_value={'status':'caught_up_to_target'}
        if budget_error:indexer.step.side_effect=DataError('header_budget_exhausted')
        output=io.StringIO()
        with ExitStack() as stack:
            for name,value in (
                ('configured_writer_catalogue',self.catalogue),
                ('load_config',{'rpcUrl':'https://rpc.mainnet.chain.robinhood.com'}),
                ('IndexRpc',Mock()),('ReadRpc',Mock()),
                ('DiscoveryReader',Mock(snapshot=lambda:Block(111,'0x'+'ab'*32,111))),
                ('ensure_anchor',(10,'stored_registration')),('ActivityIndexer',indexer)):
                stack.enter_context(patch.object(manage_activity,name,return_value=value))
            stack.enter_context(patch.object(sys,'argv',['manage_activity.py','--queue-worker',
                '--max-pools',str(max_pools),'--max-steps','1','--max-seconds','50']))
            stack.enter_context(redirect_stdout(output))
            code=manage_activity.main()
        return code,json.loads(output.getvalue())

    def test_worker_preserves_background_quota_when_budget_ends_every_run(self):
        background,recent=self.backlog()
        served=[]
        for _ in range(4):
            code,report=self.worker(max_pools=64,budget_error=True)
            self.assertEqual(code,1)
            self.assertEqual(len(report['pools']),1,'budget exhaustion must end this invocation')
            self.assertEqual(report['pools'][0]['reason'],'header_budget_exhausted')
            served.append(report['pools'][0]['poolId'])
        self.assertEqual(served,[*recent[:3],background[0]])

    def test_worker_drains_hot_requests_and_reserved_background_without_repeating(self):
        background,recent=self.backlog()
        code,report=self.worker(max_pools=24)
        self.assertEqual(code,0,report)
        served=[item['poolId'] for item in report['pools']]
        self.assertEqual(len(set(served)),24)
        self.assertEqual([value for value in served if value in recent],recent)
        self.assertEqual([value for value in served if value in background],background[:7])

    def test_invalid_priority_does_not_claim(self):
        self.backlog(background=1,recent=1)
        with self.assertRaisesRegex(DataError,'invalid_pool_request_claim'):
            self.requests.claim(priority='anything')
        self.assertTrue(all(row['attempts']==0 for row in self.requests.status()))


if __name__=='__main__':unittest.main()
