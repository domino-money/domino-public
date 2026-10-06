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
                ('load_config',{'rpcUrl':'https://rpc.domino.money/TEST_LOCAL_TOKEN_0123456/'}),
                ('IndexRpc',Mock()),('ReadRpc',Mock()),
                ('DiscoveryReader',Mock(snapshot=lambda:Block(111,'0x'+'ab'*32,111))),
                ('ensure_anchor',(10,'stored_registration',None)),('ActivityIndexer',indexer)):
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

    def registered(self,pool_ids):
        """Pools the activity ledger holds; the claim order needs nothing else of them."""
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            for pool_id in pool_ids:
                conn.execute('''INSERT INTO domino_activity.pools(pool_id,pool_key,start_block,base_hash,next_block)
                  VALUES(%s,'{}',1,%s,1)''',(pool_id,'0x'+'00'*32))
        def forget():
            with psycopg.connect(**self.settings,user=ADMIN) as conn:
                conn.execute('DELETE FROM domino_activity.pools WHERE pool_id=ANY(%s)',(list(pool_ids),))
        self.addCleanup(forget)

    def test_a_requested_pool_the_ledger_lacks_comes_first_in_every_lane(self):
        """Registering is what lets a read serve a pool at all; walking only freshens one."""
        background,recent=self.backlog(background=6,recent=3)
        self.registered(recent+background[:4])
        self.assertEqual([row['pool_id'] for row in self.requests.claim(limit=4)],
                         [background[4],background[5],recent[0],background[0]])
        for priority,then in (('recent',recent[0]),('background',background[0])):
            with self.subTest(priority=priority):
                with psycopg.connect(**self.settings,user=ADMIN) as conn:
                    conn.execute('TRUNCATE domino_activity.pool_requests')
                background,recent=self.backlog(background=6,recent=3)
                self.assertEqual([row['pool_id'] for row in self.requests.claim(limit=3,priority=priority)],
                                 [background[4],background[5],then])

    def test_only_a_complete_search_keeps_an_anchor_request_blocked(self):
        """Production's five blocked rows came from a 400,000-block window, not a search of everything."""
        legacy,verdict,mismatch=pool(1),pool(2),pool(3)
        for value in (legacy,verdict,mismatch):self.requests.enqueue(value)
        claims={row['pool_id']:row for row in self.requests.claim(limit=3)}
        self.requests.record(legacy,'blocked',claim=claims[legacy],error='initialize_anchor_not_found',
                             detail={'reason':'initialize_anchor_not_found'})
        self.requests.record(verdict,'blocked',claim=claims[verdict],error='initialize_anchor_not_found',
                             detail={'reason':'initialize_anchor_not_found','anchorSearch':{'complete':True}})
        self.requests.record(mismatch,'blocked',claim=claims[mismatch],error='initialize_anchor_mismatch')
        self.assertEqual(self.requests.reopen_unfinished_anchor_searches(),[legacy])
        row=self.requests.status(legacy)
        self.assertEqual((row['status'],row['last_error'],row['error_class'],row['consecutive_failures']),
                         ('queued',None,None,0))
        self.assertEqual([self.requests.status(value)['status'] for value in (verdict,mismatch)],
                         ['blocked','blocked'])
        self.assertEqual([row['pool_id'] for row in self.requests.claim(limit=3)],[legacy])
        self.assertEqual(self.requests.reopen_unfinished_anchor_searches(),[])

    def timed_worker(self,step,*args,anchor=None):
        """The worker over this queue, on a clock only the walks themselves advance."""
        from read_deadline import ReadDeadline
        clock=[0.0]
        indexer=Mock()
        indexer.step.side_effect=lambda pool_id,*,through,span:step(clock,span)
        output=io.StringIO()
        with ExitStack() as stack:
            for name,value in (
                ('configured_writer_catalogue',self.catalogue),
                ('load_config',{'rpcUrl':'https://rpc.domino.money/TEST_LOCAL_TOKEN_0123456/'}),
                ('IndexRpc',Mock()),('ReadRpc',Mock()),
                ('DiscoveryReader',Mock(snapshot=lambda:Block(111,'0x'+'ab'*32,111))),
                ('ensure_anchor',(10,'stored_registration',None)),('ActivityIndexer',indexer)):
                stack.enter_context(patch.object(manage_activity,name,return_value=value))
            if anchor is not None:
                stack.enter_context(patch.object(manage_activity,'ensure_anchor',anchor))
            stack.enter_context(patch.object(manage_activity,'ReadDeadline',
                                             lambda seconds:ReadDeadline(seconds,clock=lambda:clock[0])))
            stack.enter_context(patch.object(sys,'argv',['manage_activity.py','--queue-worker',
                '--max-pools','64','--max-steps','1','--max-seconds','50','--span','25000',*args]))
            stack.enter_context(redirect_stdout(output))
            code=manage_activity.main()
        return code,json.loads(output.getvalue())

    def test_a_run_claims_only_what_its_budget_can_finish_and_that_is_a_success(self):
        """Production since 3 Oct: every run ended inside a claim, exit 1, about 4,100 times in a row."""
        background,_=self.backlog(background=6,recent=0)
        def step(clock,span):
            clock[0]+=15.0
            return {'status':'indexed'}
        code,report=self.timed_worker(step,'--claim-reserve-seconds','10')
        self.assertEqual(code,0,report)
        self.assertEqual(report['stoppedBecause'],'run_budget')
        # Claims at 0, 15 and 30 s; at 45 s only 5 of the 50 s are left.
        self.assertEqual([item['poolId'] for item in report['pools']],background[:3])
        for pool_id in background[:3]:
            row=self.requests.status(pool_id)
            # A walked span doubles for the next claim; nothing failed.
            self.assertEqual((row['status'],row['last_error'],row['consecutive_failures'],row['span_blocks']),
                             ('indexing',None,0,50000))
        self.assertTrue(all(self.requests.status(pool_id)['attempts']==0 for pool_id in background[3:]))

    def test_the_runs_own_deadline_neither_shrinks_the_span_nor_fails_the_run(self):
        """Every request's span had collapsed to the 1,000-block floor in production."""
        background,_=self.backlog(background=3,recent=0)
        def step(clock,span):
            clock[0]+=35.0
            # What the transport raises once the run's deadline is spent.
            if clock[0]>50:raise DataError('read_deadline_exceeded')
            return {'status':'indexed'}
        code,report=self.timed_worker(step)
        self.assertEqual(code,0,report)
        done,cut=report['pools']
        self.assertEqual((done['poolId'],cut['poolId']),tuple(background[:2]))
        self.assertNotIn('reason',done)
        self.assertEqual((cut['reason'],report['stoppedBecause']),('run_deadline_exceeded','run_budget'))
        row=self.requests.status(background[1])
        self.assertEqual((row['span_blocks'],row['error_class']),(25000,'run_budget'))
        self.assertEqual(self.requests.status(background[2])['attempts'],0)

    def test_one_runs_initialize_searches_share_its_search_seconds(self):
        """A deep search costs the own node 5-9 s a window; a run spends --search-seconds on them in all."""
        self.backlog(background=3,recent=0)
        given=[]
        def ensure(catalogue,rpc,url,pool_id,*,seconds,**kwargs):
            given.append(seconds)
            return None,'initialize_search',{'scanned':[],'complete':False,'remainingBlocks':7,
                                             'windows':2,'seconds':12.5}
        code,report=self.timed_worker(lambda clock,span:{'status':'indexed'},'--search-seconds','20',anchor=ensure)
        self.assertEqual(code,0,report)
        self.assertEqual(given,[20.0,7.5,0.0])
        self.assertEqual([item['anchorSource'] for item in report['pools']],['initialize_search']*3)

    def test_a_search_never_spends_the_reserve_its_claim_needs(self):
        """Started at 30 s of 50 with a 10 s reserve, a search may use 10 s, not its 20."""
        self.backlog(background=2,recent=0)
        given=[]
        def ensure(catalogue,rpc,url,pool_id,*,seconds,**kwargs):
            given.append(seconds)
            if len(given)==1:return 10,'stored_registration',None
            return None,'initialize_search',{'scanned':[],'complete':False,'remainingBlocks':7,
                                             'windows':0,'seconds':0.0}
        def step(clock,span):
            clock[0]+=30.0
            return {'status':'indexed'}
        code,report=self.timed_worker(step,'--search-seconds','20','--claim-reserve-seconds','10',anchor=ensure)
        self.assertEqual(code,0,report)
        self.assertEqual(given,[20.0,10.0])


if __name__=='__main__':unittest.main()
