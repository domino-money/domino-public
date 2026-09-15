"""Persist activity resource failures without publishing their partial models."""
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import MagicMock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import psycopg
from fastapi.testclient import TestClient

from activity_indexer import ActivityIndexer
from activity_store import PgActivity
from catalogue import PgCatalogue
from dev_postgres import ADMIN, ROOT
from discovery import DataError, POOL_MANAGER
from manage_activity import main
from pool_activity import MAX_RANGES, MODIFY, replay
from read_api import ReadGate, create_app
from read_service import ReadService
from test_catalogue import block_hash, log, stored_candidate
from test_discovery import POOL
import test_pool_activity as activity_tests


class RangeLimitRpc(activity_tests.ActivityRpc):
    """5,001 distinct live ranges, all above tick zero; no token/position ledger."""
    def __init__(self):
        super().__init__()
        self.logs=[log(10)]
        for number in range(1,MAX_RANGES+2):
            block=14 if number==MAX_RANGES+1 else 11+(number-1)//2000
            index=0 if number==MAX_RANGES+1 else (number-1)%2000
            self.logs.append(activity_tests.event_log(MODIFY,
                [number*60,(number+1)*60,1,b'\x01'*32],number=block,index=index))

    def request(self,method,params=()):
        if method=='eth_getBlockByNumber' and params[0]=='latest':
            return super().request(method,[hex(400),False])
        return super().request(method,params)

    def call(self,target,signature,inputs=(),values=(),outputs=(),*,block):
        if signature=='poolManager()':return (POOL_MANAGER,)
        if signature=='getSlot0(bytes32)':return (2**96,0,0,3000)
        if signature=='getLiquidity(bytes32)':return (0,)
        if signature=='getFeeGrowthGlobals(bytes32)':return (0,0)
        raise AssertionError(signature)

    def replacement_within_limit(self):
        # A different, still-unpublished block removes a range before adding one.
        self.fork_at=14
        self.logs=[row for row in self.logs if int(row['blockNumber'],16)<14]
        for index,(lower,delta) in enumerate(((60,-1),(5001*60,1))):
            raw=activity_tests.event_log(MODIFY,[lower,lower+60,delta,b'\x01'*32],number=14,index=index)
            raw['blockHash']=block_hash(14,1)
            raw['transactionHash']=block_hash(100014,1)
            self.logs.append(raw)


class ActivityDiagnosticUnitTests(unittest.TestCase):
    def test_real_model_accepts_5000_and_rejects_5001_without_mutating_input(self):
        self.assertEqual(MAX_RANGES,5000)
        events=[activity_tests.decoded(raw) for raw in RangeLimitRpc().logs]
        model=replay(None,events[:-1],POOL,stored_candidate()['poolKey'])
        self.assertEqual(len(model['ranges']),5000)
        before=copy.deepcopy(model)
        with self.assertRaisesRegex(DataError,'^activity_range_budget_exhausted$'):
            replay(model,events[-1:],POOL,stored_candidate()['poolKey'])
        self.assertEqual(model,before)

    def test_diagnostic_failure_never_masks_original_resource_error(self):
        for reason in ('catalogue_writer_busy','catalogue_database_unavailable'):
            store=MagicMock();worker=ActivityIndexer(store,None)
            original=DataError('activity_range_budget_exhausted')
            def fail(pool_id,*,through,span,attempt):
                attempt['fromBlock']=14
                raise original
            store.record_range_failure.side_effect=DataError(reason)
            with patch.object(worker,'_step',side_effect=fail):
                with self.assertRaises(DataError) as result:worker.step(POOL,through=14)
            self.assertIs(result.exception,original)
            store.record_range_failure.assert_called_once()


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','requires disposable PostgreSQL databases')
class ActivityDiagnosticsPostgresTests(unittest.TestCase):
    settings=activity_tests.ActivityPostgresTests.settings

    def setUp(self):
        activity_tests.ActivityPostgresTests.setUp(self)
        self.rpc=RangeLimitRpc();self.worker=ActivityIndexer(self.store,self.rpc)
        self.worker.register(POOL,10)
        # Every call respects the real 2,000-event limit. The next event is range 5,001.
        for block in (10,11,12,13):self.worker.step(POOL,through=block,span=1)
        self.before=self.published()
        self.assertEqual(len(self.before['tail']['model']['ranges']),5000)

    def published(self):
        with self.catalogue.connection() as conn:
            row=self.store.pool(conn,POOL)
            return {'next':row['next_block'],'revision':row['revision'],
                'tail':self.store.tail(conn,POOL),'counts':tuple(conn.execute(
                    'SELECT count(*) AS n FROM domino_activity.'+table).fetchone()['n'] for table in ('chunks','events'))}

    def blocked(self):
        with self.assertRaisesRegex(DataError,'^activity_range_budget_exhausted$'):
            self.worker.step(POOL,through=14,span=1)
        self.assertEqual(self.published(),self.before)
        result=PgActivity(PgCatalogue(self.settings)).operator_status(POOL)
        self.assertEqual(result['status'],'blocked')
        return result

    def test_failed_chunk_persists_diagnostic_and_preserves_last_published_snapshot(self):
        result=self.blocked();detail=result['diagnostic']
        self.assertEqual(detail['reason'],'activity_range_budget_exhausted')
        self.assertEqual(detail['action'],'select_extended_activity_profile_and_resume')
        self.assertEqual(detail['capacityProfile'],'standard')
        self.assertEqual(detail['fromBlock'],14)
        self.assertEqual(detail['attemptedThroughBlock'],14)
        self.assertEqual(detail['observedLiveRangesAtLeast'],5001)
        self.assertEqual(detail['lastCommittedLiveRanges'],5000)
        self.assertTrue(detail['resumeAboveLimitSupported'])
        self.assertFalse(detail['smallerSpanBypassesLimit'])
        self.assertGreater(detail['recordedAt'],0)
        self.assertEqual(result['lastCommittedSnapshot']['number'],13)
        self.assertEqual(result['lastCommittedSnapshot']['liveRanges'],5000)
        self.assertFalse(result['usableAsCurrent24h'])
        self.assertEqual(result['canonicality'],'not_checked')
        self.assertEqual(self.store.read(POOL)['snapshot']['number'],13)
        # A transient later error does not erase the last recorded resource block.
        self.rpc.fail_logs=True
        with self.assertRaisesRegex(DataError,'network_unavailable'):self.worker.step(POOL,through=14)
        self.assertEqual(self.store.operator_status(POOL),result)

    def test_replacement_within_limit_clears_diagnostic_only_after_atomic_success(self):
        self.blocked();self.rpc.replacement_within_limit()
        result=self.worker.step(POOL,through=14)
        self.assertEqual(result['activeRanges'],5000)
        status=self.store.operator_status(POOL)
        self.assertIsNone(status['diagnostic'])
        self.assertEqual(status['status'],'stored_history')
        self.assertEqual(status['nextBlock'],15)
        self.assertFalse(status['usableAsCurrent24h'])

    def test_sql_failure_keeps_diagnostic_and_published_rows_unchanged(self):
        before=self.blocked();self.rpc.replacement_within_limit()
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('ALTER TABLE domino_activity.events ADD CONSTRAINT test_reject_new_activity CHECK(block_number<14)')
        try:
            with self.assertRaisesRegex(DataError,'catalogue_database_unavailable'):
                self.worker.step(POOL,through=14)
            self.assertEqual(self.published(),self.before)
            self.assertEqual(self.store.operator_status(POOL),before)
        finally:
            with psycopg.connect(**self.settings,user=ADMIN) as conn:
                conn.execute('ALTER TABLE domino_activity.events DROP CONSTRAINT test_reject_new_activity')

    def test_real_diagnostic_write_failure_does_not_publish_or_mask_range_failure(self):
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('ALTER TABLE domino_activity.pools ADD CONSTRAINT test_reject_diagnostic CHECK(activity_diagnostic IS NULL)')
        try:
            with self.assertRaisesRegex(DataError,'^activity_range_budget_exhausted$'):
                self.worker.step(POOL,through=14)
            self.assertEqual(self.published(),self.before)
            self.assertIsNone(self.store.operator_status(POOL)['diagnostic'])
        finally:
            with psycopg.connect(**self.settings,user=ADMIN) as conn:
                conn.execute('ALTER TABLE domino_activity.pools DROP CONSTRAINT test_reject_diagnostic')

    def test_source_reorg_atomically_clears_obsolete_block_and_preserves_earlier_history(self):
        self.blocked();self.rpc.fork_at=13
        result=self.worker.step(POOL,through=14)
        self.assertEqual(result,{'status':'rewound','through':12})
        status=self.store.operator_status(POOL)
        self.assertIsNone(status['diagnostic'])
        self.assertEqual(status['lastCommittedSnapshot']['number'],12)
        self.assertEqual(status['lastCommittedSnapshot']['liveRanges'],4000)
        self.assertEqual(status['nextBlock'],13)
        self.assertEqual(self.published()['counts'],(3,4001))

    def test_late_failure_recorder_cannot_restore_diagnostic_after_revision_or_progress_changes(self):
        detail=self.blocked()['diagnostic']
        with self.catalogue.connection(writer=True,lock=True) as conn:
            # Same next block, new source revision: a diagnostic must still be rejected.
            self.store.rewind(conn,self.store.pool(conn,POOL),13)
        self.assertFalse(self.store.record_range_failure(POOL,detail))
        self.assertIsNone(self.store.operator_status(POOL)['diagnostic'])
        self.rpc.replacement_within_limit();self.worker.step(POOL,through=14)
        self.assertFalse(self.store.record_range_failure(POOL,detail))
        self.assertIsNone(self.store.operator_status(POOL)['diagnostic'])

    def test_status_cli_uses_no_rpc_or_provider_configuration_and_reapply_preserves_record(self):
        before=self.blocked()
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            migration=(ROOT/'migrations/013_activity_diagnostics.sql').read_text()
            conn.execute(migration);conn.execute(migration)
        with self.assertRaises(DataError):
            with self.catalogue.connection() as conn:
                conn.execute('UPDATE domino_activity.pools SET activity_diagnostic=NULL')
        with tempfile.TemporaryDirectory() as folder:
            output=Path(folder)/'status.json';stream=io.StringIO()
            with patch('sys.argv',['manage_activity.py','--pool-id',POOL,'--status','--output',str(output)]), \
                    patch('manage_activity.configured_writer_catalogue',return_value=PgCatalogue(self.settings)), \
                    patch('manage_activity.ReadRpc') as rpc, patch('manage_activity.load_config') as config, \
                    redirect_stdout(stream):
                self.assertEqual(main(),0)
            rpc.assert_not_called();config.assert_not_called()
            self.assertEqual(json.loads(stream.getvalue()),before)
            self.assertEqual(json.loads(output.read_text()),before)
        self.assertEqual(self.published(),self.before)

    def test_public_read_keeps_original_stale_snapshot_and_never_leaks_operator_diagnostic(self):
        self.blocked()
        service=ReadService(catalogue=self.catalogue,rpc_factory=lambda:self.rpc,clock=lambda:1400)
        with TestClient(create_app(service,gate=ReadGate(interval=0)),base_url='http://127.0.0.1') as client:
            response=client.post('/v1/read/pool-activity',json={'poolId':POOL})
        self.assertEqual(response.status_code,200,response.text)
        body=response.json()
        self.assertEqual(body['snapshot']['number'],13)
        self.assertEqual(body['freshness']['status'],'stale')
        self.assertFalse(body['window24h']['usableAsCurrent24h'])
        self.assertIsNone(body['liquidity']['tvlUsd'])
        self.assertNotIn('diagnostic',json.dumps(body))
