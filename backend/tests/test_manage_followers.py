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
from psycopg.types.json import Jsonb

import manage_activity
import manage_catalogue
from activity_store import PgActivity
from catalogue import PgCatalogue
from catalogue_indexer import INITIALIZE_TOPIC, CatalogueIndexer, decode_initialize
from dev_postgres import ADMIN, PORT, SOCKET
from discovery import Block, DataError
from pool_requests import PgRequests
from activity_indexer import ActivityIndexer
from test_catalogue import FakeIndexRpc, block_hash, log, stored_candidate
from test_discovery import POOL
import test_pool_activity as activity_tests

KEY_POOL=decode_initialize(log())['poolId']
ABSENT_POOL='0x'+'ab'*32
REGISTERED_POOL='0x'+'cd'*32


class QueueRpc(activity_tests.ActivityRpc):
    """POOL's activity fixture; any other id has no log, and state only when listed."""
    def __init__(self,initialized=()):
        super().__init__()
        self.initialized=set(initialized)
        self.windows=[]

    def request(self,method,params=()):
        if method=='eth_getLogs' and params[0]['topics'][0]==INITIALIZE_TOPIC:
            query=params[0]
            self.windows.append((query['topics'][1],int(query['fromBlock'],16),int(query['toBlock'],16)))
            if query['topics'][1]!=POOL:return []
        return super().request(method,params)

    def call(self,target,signature,inputs=(),values=(),outputs=(),*,block):
        pool_id='0x'+values[0].hex() if values else None
        if signature=='getSlot0(bytes32)' and pool_id!=POOL:
            return (2**96,0,0,3000) if pool_id in self.initialized else (0,0,0,0)
        return super().call(target,signature,inputs,values,outputs,block=block)


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
                patch.object(module,'load_config',return_value={'rpcUrl':'https://rpc.domino.money/TEST_LOCAL_TOKEN_0123456/'}),
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
        self.rpc=QueueRpc()
        self.store=PgActivity(self.catalogue)
        # The queue is this class's own fixture; the shared activity setUp
        # predates it and would leave another test's request to be claimed.
        # The catalogue's interval is too: the anchor search skips it, and
        # another class may have left one behind.
        with psycopg.connect(**self.catalogue.settings,user=ADMIN) as conn:
            conn.execute('TRUNCATE domino_activity.pool_requests')
            conn.execute('UPDATE domino_catalogue.state SET start_block=NULL,next_block=NULL,base_hash=NULL')

    def catalogue_covers(self,start,through):
        """The catalogue holds every Initialize of [start, through]: none of POOL's (at 10)."""
        with psycopg.connect(**self.catalogue.settings,user=ADMIN) as conn:
            conn.execute('UPDATE domino_catalogue.state SET start_block=%s,next_block=%s,base_hash=%s',
                         (start,through+1,block_hash(start-1)))

    def due(self,*pool_ids):
        """Skip the record's delay: the next run may claim these at once."""
        with psycopg.connect(**self.catalogue.settings,user=ADMIN) as conn:
            conn.execute("UPDATE domino_activity.pool_requests SET due_at=clock_timestamp()-interval '1 second' "
                         'WHERE pool_id=ANY(%s)',(list(pool_ids),))

    def patches(self,reader):
        return [patch.object(manage_activity,'configured_writer_catalogue',return_value=self.catalogue),
                patch.object(manage_activity,'load_config',return_value={'rpcUrl':'https://rpc.domino.money/TEST_LOCAL_TOKEN_0123456/'}),
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
        lines=output.strip().splitlines()
        # Without --quiet every pass is printed before the report.
        self.assertEqual([json.loads(line)['target'] for line in lines[:-1]],[POOL])
        report=json.loads(lines[-1])
        self.assertEqual(report['mode'],'core_pool_activity_follower')
        self.assertEqual(report['follow']['lagBlocks'],100)
        self.assertEqual(report['readFreshnessSeconds'],120)
        target=report['follow']['targets'][POOL]
        self.assertEqual(target['indexedPasses'],1)
        self.assertEqual(target['rewinds'],[])
        self.assertEqual(target['lastResult']['stateReconciled'],True)
        with self.catalogue.connection() as conn:
            self.assertEqual(self.store.pool(conn,POOL)['next_block'],12)

    def catalogued(self,pool_id,block):
        """The catalogue follower has stored the pool's Initialize event at `block`."""
        key=stored_candidate()['poolKey']
        with psycopg.connect(**self.catalogue.settings,user=ADMIN) as conn:
            conn.execute('INSERT INTO domino_catalogue.chunks(start_block,end_block,end_hash) VALUES(%s,%s,%s)',
                         (block,block,block_hash(block)))
            conn.execute('''INSERT INTO domino_catalogue.events(pool_id,currency0,currency1,pool_key,block_number,
              block_hash,tx_hash,log_index,chunk_start) VALUES(%s,%s,%s,%s,%s,%s,%s,0,%s)''',
              (pool_id,key['currency0'],key['currency1'],Jsonb(key),block,block_hash(block),'0x'+'cd'*32,block))
        def forget():
            with psycopg.connect(**self.catalogue.settings,user=ADMIN) as conn:
                conn.execute('DELETE FROM domino_catalogue.chunks WHERE start_block=%s',(block,))
        self.addCleanup(forget)

    def test_domino_positions_follow_every_registered_pool_and_report_the_rest(self):
        argv=['manage_activity.py','--follow','--domino-positions','--quiet','--lag','100','--max-passes','1',
              '--poll-seconds','0']
        running=self.patches(reader_factory(111))
        running.append(patch.object(manage_activity,'position_pools',return_value={POOL:[7,9],ABSENT_POOL:[8]}))
        for item in running:item.start()
        try:
            # POOL is a catalogue hint without its Initialize block; ABSENT_POOL is unknown.
            code,first=run_main(manage_activity,argv)
            self.catalogued(POOL,10)
            again,second=run_main(manage_activity,argv)
        finally:
            for item in running:item.stop()
        self.assertEqual(code,0)
        report=json.loads(first.strip())
        self.assertIsNone(report['follow'])
        self.assertEqual({key:value for key,value in report['dominoPositions'].items() if key!='notRegistered'},
                         {'pools':2,'positions':3,'followed':0,'registeredNow':[]})
        self.assertEqual(sorted((item['poolId'],item['reason']) for item in report['dominoPositions']['notRegistered']),
                         sorted([(POOL,'verified_initialization_block_required'),
                                 (ABSENT_POOL,'pool_not_in_catalogue')]))
        # Once the catalogue holds its Initialize event, the next run registers the pool and follows it.
        self.assertEqual(again,0)
        lines=second.strip().splitlines()
        self.assertEqual(len(lines),1,'--quiet prints the final report only')
        report=json.loads(lines[0])
        self.assertEqual(report['dominoPositions'],
                         {'pools':2,'positions':3,'followed':1,'registeredNow':[POOL],
                          'notRegistered':[{'poolId':ABSENT_POOL,'reason':'pool_not_in_catalogue'}]})
        self.assertEqual(list(report['follow']['targets']),[POOL])
        self.assertEqual(report['follow']['targets'][POOL]['indexedPasses'],1)
        with self.catalogue.connection() as conn:
            self.assertEqual((self.store.pool(conn,POOL)['start_block'],self.store.pool(conn,POOL)['next_block']),
                             (10,12))

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
                # The refused range shrank the span to a quarter; the walked one
                # doubles it again for the next claim.
                self.assertEqual(PgRequests(self.catalogue).status(POOL)['span_blocks'],50000)
                with psycopg.connect(**self.catalogue.settings,user=ADMIN) as conn:
                    conn.execute("UPDATE domino_activity.pool_requests SET due_at=clock_timestamp()-interval '1 second'")
                second,output=run_main(manage_activity,args)
                self.assertEqual(second,0,output)
        finally:
            for item in running:item.stop()
        self.assertEqual(observed,[100000,25000,50000])
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
        """A walk that finished as the run ran out is progress, and the run a success.

        Until 6 Oct 2026 leaving the deadline's scope turned that finished walk
        into the pool's read_deadline_exceeded and the run into exit 1: none of
        about 4,100 production runs since the 3 Oct move succeeded.
        """
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
            # The registered pool is the one walked here; ABSENT_POOL waits.
            with psycopg.connect(**self.catalogue.settings,user=ADMIN) as conn:
                conn.execute("UPDATE domino_activity.pool_requests SET due_at=clock_timestamp()+interval '1 hour' "
                             'WHERE pool_id=%s',(ABSENT_POOL,))
            with patch.object(manage_activity,'ReadDeadline',lambda seconds:ReadDeadline(seconds,clock=lambda:clock[0])),\
                 patch.object(ActivityIndexer,'step',timed):
                code,output=run_main(manage_activity,['manage_activity.py','--queue-worker','--max-pools','64',
                    '--max-steps','1','--span','100000','--max-seconds','50'])
            self.assertEqual(code,0,output)
            report=json.loads(output)
            self.assertEqual(report['stoppedBecause'],'run_budget')
            self.assertEqual([(item['poolId'],item['steps']) for item in report['pools']],[(POOL,['indexed'])])
            self.assertNotIn('reason',report['pools'][0])
            row=requests.status(POOL)
            self.assertEqual((row['status'],row['last_error'],row['consecutive_failures'],row['span_blocks']),
                             ('indexing',None,0,100000))
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

    def test_a_missed_initialize_blocks_the_request_until_its_anchor_is_registered(self):
        """A search that covered all it was given and missed is a verdict, kept until registration."""
        running=self.patches(reader_factory(5000))
        for item in running:item.start()
        requests=PgRequests(self.catalogue)
        try:
            run_main(manage_activity,['manage_activity.py','--request','--pool-id',POOL])
            code,output=run_main(manage_activity,['manage_activity.py','--queue-worker',
                                                  '--search-from','4000','--search-span','1000',
                                                  '--search-max-spans','2','--max-pools','1',
                                                  '--anchor-only'])
            self.assertEqual(code,1,output)
            report=json.loads(output.strip().splitlines()[-1])
            self.assertEqual((report['pools'][0]['status'],report['pools'][0]['reason']),
                             ('blocked','initialize_anchor_not_found'))
            row=requests.status(POOL)
            self.assertEqual((row['status'],row['error_class']),('blocked','identity'))
            self.assertEqual(row['detail']['anchorSearch']['complete'],True)
            self.assertEqual(self.rpc.windows,[(POOL,4000,4000),(POOL,4001,4999)])
            # A verdict is not reopened by the next run.
            self.assertEqual(requests.reopen_unfinished_anchor_searches(),[])
            # Every refresh of an explicit pool asks again: the ask neither
            # reopens the request nor makes it claimable once due.
            requests.enqueue(POOL)
            with psycopg.connect(**self.catalogue.settings,user=ADMIN) as conn:
                conn.execute("UPDATE domino_activity.pool_requests SET due_at=clock_timestamp()-interval '1 second'")
            self.assertEqual(requests.claim(),[])
            registered,output=self.registered(POOL,10)
            self.assertEqual(registered,0,output)
            self.assertEqual(json.loads(output.strip())['reopenedRequests'],[POOL])
            self.assertEqual(requests.status(POOL)['status'],'queued')
            # Registering again reopens a request blocked since; a refused
            # registration reopens nothing.
            requests.enqueue(ABSENT_POOL)
            with psycopg.connect(**self.catalogue.settings,user=ADMIN) as conn:
                conn.execute("UPDATE domino_activity.pool_requests SET status='blocked'")
            again,output=self.registered(POOL,10)
            self.assertEqual(json.loads(output.strip())['pools'][0]['status'],'already_registered')
            self.assertEqual(json.loads(output.strip())['reopenedRequests'],[POOL])
            refused,output=self.registered(ABSENT_POOL,10)
        finally:
            for item in running:item.stop()
        self.assertEqual((again,refused),(0,1))
        self.assertEqual(json.loads(output.strip())['reopenedRequests'],[])
        self.assertEqual(requests.status(ABSENT_POOL)['status'],'blocked')

    def test_a_requested_pool_older_than_the_catalogue_is_found_run_after_run_and_registered_first(self):
        """The four featured pools blocked since 1 Oct 2026 were hints initialized before the catalogue.

        The worker searched 400,000 blocks back from the head, inside the
        catalogue's own interval, so it could never meet them. Each run now
        resumes below the windows the last one proved empty, and a pool the
        ledger lacks is claimed before a registered one asked for just now.
        """
        self.catalogue_covers(100,4000)
        requests=PgRequests(self.catalogue)
        requests.enqueue(POOL);requests.enqueue(REGISTERED_POOL)
        with psycopg.connect(**self.catalogue.settings,user=ADMIN) as conn:
            conn.execute('''INSERT INTO domino_activity.pools(pool_id,pool_key,start_block,base_hash,next_block)
              VALUES(%s,'{}',1,%s,1)''',(REGISTERED_POOL,block_hash(0)))
            # Due first and asked for just now: without the registration rank the
            # registered request would take every run's only claim.
            conn.execute("""UPDATE domino_activity.pool_requests SET last_requested_at='epoch',
              due_at=clock_timestamp()-interval '1 minute' WHERE pool_id=%s""",(POOL,))
            conn.execute("""UPDATE domino_activity.pool_requests SET last_requested_at=clock_timestamp(),
              due_at=clock_timestamp()-interval '1 hour' WHERE pool_id=%s""",(REGISTERED_POOL,))
        args=['manage_activity.py','--queue-worker','--max-pools','1','--max-steps','1',
              '--search-span','40','--search-max-spans','1']
        reports=[]
        running=self.patches(reader_factory(5000))
        for item in running:item.start()
        try:
            for _ in range(3):
                code,output=run_main(manage_activity,args)
                self.assertEqual(code,0,output)
                reports.append(json.loads(output.strip().splitlines()[-1]))
                self.due(POOL)
        finally:
            for item in running:item.stop()
        served=[report['pools'][0] for report in reports]
        self.assertEqual([item['poolId'] for item in served],[POOL]*3)
        # Below the catalogue's start, newest window first, no window twice.
        self.assertEqual(self.rpc.windows[:3],[(POOL,60,99),(POOL,20,59),(POOL,1,19)])
        self.assertEqual([item['anchorSource'] for item in served],
                         ['initialize_search','initialize_search','initialize_log'])
        # Left: the rest below the catalogue, plus the 999 blocks next to the head.
        self.assertEqual([item['anchorSearch']['remainingBlocks'] for item in served[:2]],[59+999,19+999])
        self.assertEqual((served[2]['anchorBlock'],served[2]['steps']),(10,['indexed']))
        with self.catalogue.connection() as conn:
            self.assertEqual((self.store.pool(conn,POOL)['start_block'],self.store.pool(conn,POOL)['next_block']),
                             (10,1010))
        self.assertEqual(requests.status(REGISTERED_POOL)['attempts'],0)

    def test_a_request_the_head_window_blocked_is_reopened_and_found(self):
        """Production's five rows, blocked on 1 Oct by a window that could not hold their anchor.

        Without --search-from/--search-back-blocks the search covers the whole
        history: here the head is 500,000 blocks past the anchor, out of reach
        of the old 400,000-block window.
        """
        self.catalogue_covers(100,4000)
        requests=PgRequests(self.catalogue)
        requests.enqueue(POOL)
        claim=requests.claim()[0]
        requests.record(POOL,'blocked',claim=claim,error='initialize_anchor_not_found',
                        detail={'reason':'initialize_anchor_not_found'})
        running=self.patches(reader_factory(500_010))
        for item in running:item.start()
        try:
            code,output=run_main(manage_activity,['manage_activity.py','--queue-worker','--max-pools','1',
                                                  '--max-steps','1','--search-span','1000000'])
        finally:
            for item in running:item.stop()
        self.assertEqual(code,0,output)
        report=json.loads(output.strip().splitlines()[-1])
        self.assertEqual((report['reopenedRequests'],report['searchFromBlock']),([POOL],1))
        self.assertEqual((report['pools'][0]['poolId'],report['pools'][0]['anchorBlock']),(POOL,10))
        # Above the catalogue up to 1,000 blocks from the head, then below it.
        self.assertEqual(self.rpc.windows[:2],[(POOL,4001,499_010),(POOL,1,99)])
        self.assertEqual(requests.status(POOL)['last_error'],None)

    def test_an_id_nobody_initialized_costs_one_state_read_and_stays_retryable(self):
        requests=PgRequests(self.catalogue)
        requests.enqueue(ABSENT_POOL)
        args=['manage_activity.py','--queue-worker','--max-pools','1','--anchor-only']
        running=self.patches(reader_factory(5000))
        for item in running:item.start()
        try:
            code,output=run_main(manage_activity,args)
            self.assertEqual(code,1,output)
            report=json.loads(output.strip().splitlines()[-1])
            self.assertEqual((report['pools'][0]['status'],report['pools'][0]['reason']),
                             ('indexing','pool_not_initialized'))
            self.assertEqual(self.rpc.windows,[])
            row=requests.status(ABSENT_POOL)
            self.assertEqual((row['status'],row['error_class']),('indexing','discovery_incomplete'))
            # Once the core holds it, the same request searches the whole history.
            self.rpc.initialized.add(ABSENT_POOL);self.due(ABSENT_POOL)
            again,output=run_main(manage_activity,args)
        finally:
            for item in running:item.stop()
        self.assertEqual(again,1,output)
        self.assertEqual(self.rpc.windows,[(ABSENT_POOL,1,4000),(ABSENT_POOL,4001,4999)])
        row=requests.status(ABSENT_POOL)
        self.assertEqual((row['status'],row['last_error'],row['detail']['anchorSearch']['complete']),
                         ('blocked','initialize_anchor_not_found',True))

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
