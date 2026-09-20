"""CLI wiring for the catalogue and activity followers against real PostgreSQL."""
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import psycopg

import manage_activity
import manage_catalogue
from activity_store import PgActivity
from catalogue import PgCatalogue
from catalogue_indexer import CatalogueIndexer, decode_initialize
from dev_postgres import ADMIN, PORT, SOCKET
from discovery import Block, DataError
from pool_requests import PgRequests
from activity_indexer import ActivityIndexer
from test_catalogue import FakeIndexRpc, block_hash, log, stored_candidate
from test_discovery import POOL
import test_pool_activity as activity_tests

KEY_POOL=decode_initialize(log())['poolId']
ABSENT_POOL='0x'+'ab'*32


class StubReader:
    """Head snapshot without a network call; the step still checks everything."""
    def __init__(self,head):
        self.head=head
    def snapshot(self):
        return Block(self.head,block_hash(self.head),self.head)


def reader_factory(head):
    return lambda *args,**kwargs: StubReader(head)


def run_main(module,argv):
    output=io.StringIO()
    with patch('sys.argv',argv), redirect_stdout(output):
        code=module.main()
    return code,output.getvalue()


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1',
                     'set DOMINO_TEST_POSTGRES=1 after dev_postgres.py prepare-tests')
class CatalogueFollowerCliTests(unittest.TestCase):
    """Only the hard-coded disposable DB is touched; no RPC endpoint is reached."""
    settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_catalogue_tests'}

    def setUp(self):
        assert self.settings['dbname']=='domino_catalogue_tests'
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('TRUNCATE domino_catalogue.events,domino_catalogue.hints,domino_catalogue.chunks')
            conn.execute('UPDATE domino_catalogue.state SET start_block=10,next_block=10,base_hash=%s,revision=0',
                         (block_hash(9),))
        self.store=PgCatalogue(self.settings)
        self.rpc=FakeIndexRpc()

    def state(self):
        with self.store.connection() as conn:return self.store.state(conn)

    def patches(self,module,reader):
        return [patch.object(module,'configured_writer_catalogue',return_value=self.store),
                patch.object(module,'load_config',return_value={'rpcUrl':'https://rpc.mainnet.chain.robinhood.com'}),
                patch.object(module,'IndexRpc',lambda *args,**kwargs:self.rpc),
                patch.object(module,'ReadRpc',lambda *args,**kwargs:object()),
                patch.object(module,'DiscoveryReader',reader)]

    def test_catalogue_follow_commits_to_the_lag_and_keeps_the_revision(self):
        self.rpc.logs=[]
        running=self.patches(manage_catalogue,reader_factory(1000))
        for item in running:item.start()
        try:
            code,output=run_main(manage_catalogue,['manage_catalogue.py','follow','--span','1000',
                                                   '--lag','200','--max-passes','1','--poll-seconds','0'])
        finally:
            for item in running:item.stop()
        self.assertEqual(code,0)
        report=json.loads(output.strip().splitlines()[-1])
        self.assertEqual(report['mode'],'catalogue_follower')
        self.assertEqual(report['follow']['lagBlocks'],200)
        self.assertEqual(report['follow']['stoppedBecause'],'max_passes')
        self.assertEqual(report['coverage']['indexedThrough'],800)
        # An empty chunk advances coverage; it does not invalidate paging clients.
        self.assertEqual(report['coverage']['revision'],0)
        self.assertEqual(self.state()['next_block'],801)

    def test_a_rejected_range_is_retried_with_a_smaller_span_in_the_same_pass(self):
        """A dense chunk is refused once, then accepted at a quarter of the span."""
        self.rpc.logs=[]
        seen=[]
        real_step=CatalogueIndexer.step

        def step(self,*,through,span=1000):
            seen.append(span)
            if len(seen)==1:
                raise DataError('invalid_logs_response')
            return real_step(self,through=through,span=span)

        with patch.object(manage_catalogue.CatalogueIndexer,'step',step):
            running=self.patches(manage_catalogue,reader_factory(1000))
            for item in running:item.start()
            try:
                code,output=run_main(manage_catalogue,['manage_catalogue.py','follow','--span','100000',
                                                       '--span-floor','1000','--lag','200',
                                                       '--max-passes','1','--poll-seconds','0'])
            finally:
                for item in running:item.stop()
        self.assertEqual(code,0)
        self.assertEqual(seen[:2],[100000,25000])
        report=json.loads(output.strip().splitlines()[-1])
        self.assertEqual(report['follow']['failures'],[])
        self.assertEqual(report['spanRuntime']['spanBlocks'],25000)

    def test_catalogue_follow_records_a_failed_round_without_losing_the_checkpoint(self):
        self.rpc.fail=True
        running=self.patches(manage_catalogue,reader_factory(1000))
        for item in running:item.start()
        try:
            code,output=run_main(manage_catalogue,['manage_catalogue.py','follow','--lag','200',
                                                   '--max-passes','2','--poll-seconds','0',
                                                   '--max-consecutive-failures','2'])
        finally:
            for item in running:item.stop()
        self.assertEqual(code,0)
        report=json.loads(output.strip().splitlines()[-1])
        self.assertEqual(report['follow']['stoppedBecause'],'failures')
        self.assertEqual([item['reason'] for item in report['follow']['failures']],
                         ['network_unavailable','network_unavailable'])
        self.assertEqual(self.state()['next_block'],10)

    def test_catalogue_reset_requires_confirmation_and_then_replaces_the_interval(self):
        running=self.patches(manage_catalogue,reader_factory(1000))
        for item in running:item.start()
        try:
            refused=run_main(manage_catalogue,['manage_catalogue.py','reset','--start-block','20'])[0]
            unset=self.state()['start_block']
            confirmed,output=run_main(manage_catalogue,['manage_catalogue.py','reset',
                                                        '--start-block','20','--confirm'])
        finally:
            for item in running:item.stop()
        self.assertEqual(refused,1)
        self.assertEqual(unset,10)
        self.assertEqual(confirmed,0)
        self.assertEqual((self.state()['start_block'],self.state()['next_block']),
                         (20,20))
        self.assertEqual(json.loads(output.strip())['status'],'reset')


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1',
                     'set DOMINO_TEST_POSTGRES=1 after dev_postgres.py prepare-tests')
class ActivityFollowerCliTests(unittest.TestCase):
    settings=activity_tests.ActivityPostgresTests.settings

    def setUp(self):
        activity_tests.ActivityPostgresTests.setUp(self)
        self.rpc=activity_tests.ActivityRpc()
        self.store=PgActivity(self.catalogue)
        # The queue is this class's own fixture; the shared activity setUp
        # predates it and would leave another test's request to be claimed.
        with psycopg.connect(**self.catalogue.settings,user=ADMIN) as conn:
            conn.execute('TRUNCATE domino_activity.pool_requests')

    def patches(self,reader):
        return [patch.object(manage_activity,'configured_writer_catalogue',return_value=self.catalogue),
                patch.object(manage_activity,'load_config',return_value={'rpcUrl':'https://rpc.mainnet.chain.robinhood.com'}),
                patch.object(manage_activity,'IndexRpc',lambda *args,**kwargs:self.rpc),
                patch.object(manage_activity,'ReadRpc',lambda *args,**kwargs:object()),
                patch.object(manage_activity,'DiscoveryReader',reader)]

    def registered(self,pool_id,anchor):
        return run_main(manage_activity,['manage_activity.py','--register','--pool-id',pool_id,
                                         '--initialization-anchor',f'{pool_id}={anchor}'])

    def test_register_uses_the_supplied_anchor_and_is_idempotent(self):
        running=self.patches(reader_factory(111))
        for item in running:item.start()
        try:
            code,output=self.registered(POOL,10)
            again,second=self.registered(POOL,10)
        finally:
            for item in running:item.stop()
        self.assertEqual(code,0)
        self.assertEqual(json.loads(output.strip())['pools'],
                         [{'poolId':POOL,'status':'registered','startBlock':10,
                           'anchorSource':'supplied_block'}])
        self.assertEqual(again,0)
        self.assertEqual(json.loads(second.strip())['pools'][0]['status'],'already_registered')

    def test_register_reports_a_pool_the_catalogue_does_not_hold(self):
        running=self.patches(reader_factory(111))
        for item in running:item.start()
        try:
            code,output=self.registered(ABSENT_POOL,10)
        finally:
            for item in running:item.stop()
        self.assertEqual(code,1)
        self.assertEqual(json.loads(output.strip())['pools'],
                         [{'poolId':ABSENT_POOL,'status':'not_registered',
                           'reason':'pool_not_in_catalogue'}])

    def test_follow_indexes_real_events_towards_the_lag_target(self):
        running=self.patches(reader_factory(111))
        for item in running:item.start()
        try:
            self.assertEqual(self.registered(POOL,10)[0],0)
            code,output=run_main(manage_activity,['manage_activity.py','--follow','--pool-id',POOL,
                                                  '--lag','100','--max-passes','1','--poll-seconds','0'])
        finally:
            for item in running:item.stop()
        self.assertEqual(code,0)
        report=json.loads(output.strip().splitlines()[-1])
        self.assertEqual(report['mode'],'core_pool_activity_follower')
        self.assertEqual(report['follow']['lagBlocks'],100)
        self.assertEqual(report['readFreshnessSeconds'],120)
        target=report['follow']['targets'][POOL]
        self.assertEqual(target['indexedPasses'],1)
        self.assertEqual(target['rewinds'],[])
        self.assertEqual(target['lastResult']['stateReconciled'],True)
        with self.catalogue.connection() as conn:
            self.assertEqual(self.store.pool(conn,POOL)['next_block'],12)

    def test_follow_refuses_an_unbounded_run_without_a_stop_condition(self):
        running=self.patches(reader_factory(111))
        for item in running:item.start()
        try:
            code,output=run_main(manage_activity,['manage_activity.py','--follow','--selected',
                                                  '--max-passes','0'])
        finally:
            for item in running:item.stop()
        self.assertEqual(code,1)
        self.assertEqual(json.loads(output.strip())['reason'],'unbounded_follow_needs_a_stop')

    def test_queue_retries_overflow_and_reuses_the_persisted_span(self):
        running=self.patches(reader_factory(111))
        for item in running:item.start()
        observed=[]
        real=ActivityIndexer.step
        def step(worker,*,through,span=1000,**kwargs):
            observed.append(span)
            if len(observed)==1:raise DataError('rpc_log_range_too_large')
            return real(worker,POOL,through=through,span=span)
        def called(worker,pool_id,**kwargs):return step(worker,**kwargs)
        try:
            self.assertEqual(self.registered(POOL,10)[0],0)
            run_main(manage_activity,['manage_activity.py','--request','--pool-id',POOL])
            args=['manage_activity.py','--queue-worker','--max-pools','1','--max-steps','1','--span','100000']
            with patch.object(ActivityIndexer,'step',called):
                code,output=run_main(manage_activity,args)
                self.assertEqual(code,0,output)
                with psycopg.connect(**self.catalogue.settings,user=ADMIN) as conn:
                    conn.execute("UPDATE domino_activity.pool_requests SET due_at=clock_timestamp()-interval '1 second'")
                second,output=run_main(manage_activity,args)
                self.assertEqual(second,0,output)
        finally:
            for item in running:item.stop()
        self.assertEqual(observed,[100000,25000,25000])
        self.assertEqual(PgRequests(self.catalogue).status(POOL)['status'],'following')

    def test_expired_claim_cannot_publish_an_activity_chunk(self):
        running=self.patches(reader_factory(111))
        for item in running:item.start()
        try:self.assertEqual(self.registered(POOL,10)[0],0)
        finally:
            for item in running:item.stop()
        requests=PgRequests(self.catalogue)
        requests.enqueue(POOL);old=requests.claim()[0]
        with psycopg.connect(**self.catalogue.settings,user=ADMIN) as conn:
            conn.execute("UPDATE domino_activity.pool_requests SET lease_until=clock_timestamp()-interval '1 second'")
        requests.claim()
        worker=ActivityIndexer(self.store,self.rpc,publication_guard=lambda conn:requests.guard(old,conn))
        with self.assertRaisesRegex(DataError,'pool_request_lease_lost'):
            worker.step(POOL,through=11)
        with self.catalogue.connection() as conn:
            self.assertEqual(self.store.pool(conn,POOL)['next_block'],10)
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM domino_activity.chunks').fetchone()['n'],0)

    def test_queue_wall_budget_stops_before_claiming_another_pool(self):
        from read_deadline import ReadDeadline
        running=self.patches(reader_factory(111))
        for item in running:item.start()
        clock=[0.0];real=ActivityIndexer.step
        def timed(worker,pool_id,**kwargs):
            result=real(worker,pool_id,**kwargs);clock[0]=51.0
            return result
        try:
            self.assertEqual(self.registered(POOL,10)[0],0)
            requests=PgRequests(self.catalogue)
            requests.enqueue(POOL);requests.enqueue(ABSENT_POOL)
            with patch.object(manage_activity,'ReadDeadline',lambda seconds:ReadDeadline(seconds,clock=lambda:clock[0])),\
                 patch.object(ActivityIndexer,'step',timed):
                code,output=run_main(manage_activity,['manage_activity.py','--queue-worker','--max-pools','64',
                    '--max-steps','1','--span','100000','--max-seconds','50'])
            self.assertEqual(code,1,output)
            self.assertEqual(json.loads(output)['pools'][0]['reason'],'read_deadline_exceeded')
            self.assertEqual(requests.status(ABSENT_POOL)['attempts'],0)
        finally:
            for item in running:item.stop()

    def test_anchor_only_worker_registers_without_writing_a_chunk(self):
        running=self.patches(reader_factory(111))
        for item in running:item.start()
        try:
            queued=run_main(manage_activity,['manage_activity.py','--request','--pool-id',POOL])
            anchored,output=run_main(manage_activity,['manage_activity.py','--queue-worker',
                                                      '--search-from','1','--search-span','1000',
                                                      '--search-max-spans','1','--max-pools','1',
                                                      '--anchor-only'])
        finally:
            for item in running:item.stop()
        self.assertEqual(queued[0],0)
        self.assertEqual(anchored,0)
        report=json.loads(output.strip().splitlines()[-1])
        self.assertEqual(report['mode'],'pool_request_worker')
        self.assertEqual(report['pools'][0]['status'],'indexing')
        self.assertEqual(report['pools'][0]['steps'],[])
        self.assertEqual(report['pools'][0]['anchorBlock'],10)
        with self.catalogue.connection() as conn:
            self.assertEqual(self.store.pool(conn,POOL)['next_block'],10)
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM domino_activity.chunks').fetchone()['n'],0)

    def test_a_registered_pool_is_anchored_from_its_own_registration(self):
        """The verified anchor in the registry beats a search window that misses."""
        running=self.patches(reader_factory(5000))
        for item in running:item.start()
        try:
            self.assertEqual(self.registered(POOL,10)[0],0)
            run_main(manage_activity,['manage_activity.py','--request','--pool-id',POOL])
            code,output=run_main(manage_activity,['manage_activity.py','--queue-worker',
                                                  '--search-from','4000','--search-span','100',
                                                  '--search-max-spans','1','--max-pools','1',
                                                  '--anchor-only','--stale-claim-seconds','1'])
        finally:
            for item in running:item.stop()
        self.assertEqual(code,0)
        report=json.loads(output.strip().splitlines()[-1])
        self.assertEqual(report['pools'][0]['anchorSource'],'stored_registration')
        self.assertEqual(report['pools'][0]['anchorBlock'],10)


if __name__=='__main__':unittest.main()
