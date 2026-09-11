"""Offline capacity, resume and publication proofs; no external RPC."""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import psycopg
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from activity_indexer import ActivityIndexer
from catalogue import checked_key
from dev_postgres import ADMIN, BIN, PORT, SOCKET
from discovery import DataError
from fee_accounting import replay_fees
from fee_store import FeeIndexer
from historical_capacity import PROFILES, capacity_profile, replay_batch
from pool_activity import MODIFY
from position_accounting import core_position_id, inside_growth, position_summary, replay_positions
from position_store import PositionIndexer
import test_pool_activity as activity_tests
from test_pool_activity import ActivityRpc, decoded, event_log
from test_catalogue import log, stored_candidate
from test_discovery import POOL
from test_position_accounting import PositionFixtureRpc, reference


def churn_logs(count):
    logs=[log(10)]
    for index in range(count):
        lo=(2*index+1)*60;hi=lo+60
        for delta in (1000000,-1000000):
            logs.append(event_log(MODIFY,[lo,hi,delta,index.to_bytes(32,'big')],
                                  number=11,index=len(logs)))
    return logs


class ChurnRpc(PositionFixtureRpc):
    """Synthetic fixed-block oracle used only to check persistence mechanics."""
    def __init__(self,count=129):
        ActivityRpc.__init__(self)
        self.logs=churn_logs(count);self.corrupt=None;self.fail_position=False
        self.snapshots={};self.identities={};self.checked=[]
        key=checked_key(stored_candidate()['poolKey'],POOL)
        state=model=None
        for raw in self.logs:
            state,model,_=replay_positions(state,model,[decoded(raw)],POOL,key,capacity=PROFILES['extended'])
        positions={}
        for identity,p in model['positions'].items():
            self.identities[identity]=(p['coreOwner'],p['tickLower'],p['tickUpper'],p['salt'])
            positions[identity]={**p,'insideX128':list(map(str,inside_growth(model,state['tick'],p['tickLower'],p['tickUpper'])))}
        entry={'expectedGrowthX128':model['growthX128'],'expectedPositions':positions,'expectedTicks':model['ticks']}
        self.snapshots[11]=(state,entry)
        self.expected=model

    def call(self,target,signature,inputs=(),values=(),outputs=(),*,block):
        if signature.startswith(('getPositionInfo','getFeeGrowthInside','getTickInfo')):
            self.checked.append((signature,repr(values),block))
        return super().call(target,signature,inputs,values,outputs,block=block)


class CapacityDomainTests(unittest.TestCase):
    def setUp(self):
        self.fixture=reference();self.events=[e['event'] for e in self.fixture['sequence']]
        self.key=checked_key(self.fixture['poolKey'],POOL)

    def test_standard_lifetime_limit_and_extended_closed_identity_conservation(self):
        events=[decoded(raw) for raw in churn_logs(129)]
        with self.assertRaisesRegex(DataError,'core_position_budget_exhausted'):
            replay_positions(None,None,events,POOL,self.key)
        a,m,settlements=replay_positions(None,None,events,POOL,self.key,capacity=PROFILES['extended'])
        self.assertEqual((len(m['positions']),len(m['ticks']),len(settlements)),(129,258,258))
        summary=position_summary(m,a)
        self.assertEqual(summary['nonzeroLiquidityPositionCount'],0)
        self.assertEqual(summary['unsettledFeesRaw'],['0','0'])
        self.assertTrue(all(t['gross']=='0' and t['outsideX128']==['0','0'] for t in m['ticks'].values()))
        reopened=copy.deepcopy(events[1]);reopened['payload']['liquidityDelta']='1000000'
        _,again,changes=replay_positions(a,m,[reopened],POOL,self.key,capacity=PROFILES['extended'])
        self.assertEqual(len(again['positions']),129)
        self.assertEqual(changes[0]['settlement']['settledFeesRaw'],['0','0'])
        with self.assertRaisesRegex(DataError,'core_position_budget_exhausted'):
            replay_positions(a,m,[],POOL,self.key)

    def test_profiles_are_explicit_and_finite(self):
        for invalid in ('unlimited',None,128):
            with self.assertRaisesRegex(DataError,'invalid_historical_capacity_profile'):capacity_profile(invalid)
        self.assertEqual((PROFILES['standard'].positions,PROFILES['standard'].ticks),(128,256))
        self.assertEqual((PROFILES['extended'].positions,PROFILES['extended'].ticks),(1024,2048))

    def test_fee_and_position_event_batches_preserve_all_native_flows(self):
        for replay in (replay_fees,replay_positions):
            expected=replay(None,None,self.events,POOL,self.key)
            a=m=None;rows=[];offset=0
            with patch('historical_capacity.MAX_BATCH_EVENTS',1):
                while offset<len(self.events):
                    a,m,changes,offset=replay_batch(replay,a,m,self.events,offset,POOL,self.key)
                    rows+=changes
            self.assertEqual((a,m,rows),expected)

    def test_shared_step_exhaustion_saves_only_complete_event_prefix(self):
        def bounded(a,m,events,pool,key,*,budget,activity_capacity):
            self.assertEqual(activity_capacity,'standard')
            budget[0]-=60000
            if budget[0]<0:raise DataError('fee_step_budget_exhausted')
            return {'ranges':{},'event':events[0]},events[0],[events[0]]
        a,m,rows,offset=replay_batch(bounded,None,None,[1,2,3],0,POOL,self.key)
        self.assertEqual((a,m,rows,offset),({'ranges':{},'event':1},1,[1],1))
        self.assertEqual(replay_batch(bounded,a,m,[1,2,3],offset,POOL,self.key)[3],2)
        with patch('fee_accounting.MAX_CHUNK_STEPS',1):
            with self.assertRaisesRegex(DataError,'fee_step_budget_exhausted'):
                replay_batch(bounded,None,None,[1],0,POOL,self.key)


class FailureDiagnosticTests(unittest.TestCase):
    def test_diagnostic_connection_query_and_commit_failures_preserve_original_error(self):
        for worker_type in (FeeIndexer,PositionIndexer):
            for stage,reason in (('connect','catalogue_writer_busy'),
                                 ('connect','catalogue_database_unavailable'),
                                 ('query','catalogue_database_unavailable'),
                                 ('commit','catalogue_database_unavailable')):
                with self.subTest(worker=worker_type.__name__,stage=stage,reason=reason):
                    store=MagicMock();worker=worker_type(store,None)
                    original=DataError('historical_work_checkpoint_mismatch')
                    transaction=store.catalogue.connection.return_value
                    conn=transaction.__enter__.return_value
                    conn.execute.return_value.fetchone.side_effect=[
                        {'start_block':10,'end_block':30},None]
                    if stage=='connect':transaction.__enter__.side_effect=DataError(reason)
                    elif stage=='query':conn.execute.side_effect=DataError(reason)
                    else:transaction.__exit__.side_effect=DataError(reason)
                    with patch.object(worker,'_step',side_effect=original):
                        with self.assertRaises(DataError) as caught:worker.step(POOL)
                    self.assertIs(caught.exception,original)
                    store.catalogue.connection.assert_called_once_with(writer=True,lock=True)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','requires disposable PostgreSQL databases')
class CapacityPostgresTests(unittest.TestCase):
    settings=activity_tests.ActivityPostgresTests.settings

    def setUp(self):
        activity_tests.ActivityPostgresTests.setUp(self)
        self.rpc=PositionFixtureRpc();self.worker=ActivityIndexer(self.store,self.rpc)
        self.worker.register(POOL,10);self.worker.step(POOL,through=30)

    def row(self,ledger):
        with self.catalogue.connection() as conn:
            return conn.execute('SELECT * FROM domino_activity.historical_work WHERE pool_id=%s AND ledger=%s',
                                (POOL,ledger)).fetchone()

    def finish(self,worker,limit=80):
        for _ in range(limit):
            result=worker().step(POOL)
            if result['status'] in ('fee_chunk_reconciled','position_chunk_reconciled'):return result
        self.fail('bounded synthetic work did not finish')

    def test_stored_chunk_event_resume_and_all_settlements_match_native(self):
        with patch('historical_capacity.MAX_BATCH_EVENTS',2):
            first=FeeIndexer(self.store,self.rpc).step(POOL)
            self.assertEqual(first['processedEvents'],2)
            self.assertIsNone(self.store.read(POOL)['fees']['accounting']['lpFeesRaw'])
            self.finish(lambda:FeeIndexer(self.store,self.rpc))
            first=PositionIndexer(self.store,self.rpc).step(POOL)
            self.assertEqual(first['processedEvents'],2)
            self.assertIsNone(self.store.read(POOL)['liquidity']['positionAccounting']['lpAssetsRaw'])
            self.finish(lambda:PositionIndexer(self.store,self.rpc))
        report=self.store.read(POOL)['liquidity']['positionAccounting']
        expected=reference()['sequence'][-1]
        self.assertEqual(report['lpAssetsRaw'],expected['expectedAssetsRaw'])
        self.assertIsNone(self.row('fee'));self.assertIsNone(self.row('position'))
        with self.catalogue.connection() as conn:
            count=conn.execute('SELECT count(*) AS n FROM domino_activity.position_settlements').fetchone()['n']
        self.assertEqual(count,sum(e['event']['kind']=='modify_liquidity' for e in reference()['sequence']))

    def test_rpc_batches_resume_without_rechecking_or_publishing_partial_proof(self):
        FeeIndexer(self.store,self.rpc).step(POOL)
        original=self.rpc.call;calls=[]
        def tracked(*args,**kwargs):
            if args[1].startswith(('getPositionInfo','getFeeGrowthInside','getTickInfo')):calls.append((args,kwargs))
            return original(*args,**kwargs)
        with patch.object(self.rpc,'call',side_effect=tracked),patch('position_store.MAX_BATCH_CHECKS',2):
            result=PositionIndexer(self.store,self.rpc).step(POOL)
            self.assertEqual(result['completedChecks'],2)
            self.assertEqual(len(calls),2)
            self.assertEqual(self.store.read(POOL)['liquidity']['positionAccounting']['status'],'unavailable')
            self.finish(lambda:PositionIndexer(self.store,self.rpc))
        self.assertEqual(len(calls),len({repr(c) for c in calls}))
        report=self.store.read(POOL)['liquidity']['positionAccounting']
        proof=report['onchainReconciliation']
        self.assertEqual(len(calls),proof['corePositions']+proof['ticks']+proof['ranges'])

    def test_existing_expensive_chunk_resumes_at_event_boundary_without_repartition(self):
        fixture=reference();events=[e['event'] for e in fixture['sequence']]
        key=checked_key(fixture['poolKey'],POOL)
        with patch('fee_accounting.MAX_CHUNK_STEPS',100):
            with self.assertRaisesRegex(DataError,'fee_step_budget_exhausted'):
                replay_fees(None,None,events,POOL,key)
            first=FeeIndexer(self.store,self.rpc).step(POOL)
            self.assertEqual(first['status'],'fee_chunk_in_progress')
            self.assertGreater(first['processedEvents'],0)
            self.finish(lambda:FeeIndexer(self.store,self.rpc))
            first=PositionIndexer(self.store,self.rpc).step(POOL)
            self.assertEqual(first['status'],'position_chunk_in_progress')
            self.finish(lambda:PositionIndexer(self.store,self.rpc))
        with self.catalogue.connection() as conn:
            chunks=conn.execute('SELECT start_block,end_block FROM domino_activity.chunks').fetchall()
        self.assertEqual(chunks,[{'start_block':10,'end_block':30}])
        report=self.store.read(POOL)['liquidity']['positionAccounting']
        self.assertEqual(report['lpAssetsRaw'],fixture['sequence'][-1]['expectedAssetsRaw'])

    def test_failure_is_durable_and_resume_retains_last_verified_prefix(self):
        FeeIndexer(self.store,self.rpc).step(POOL)
        with patch('position_store.MAX_BATCH_CHECKS',1):
            PositionIndexer(self.store,self.rpc).step(POOL)
            before=self.row('position')['progress']
            self.rpc.fail_position=True
            with self.assertRaisesRegex(DataError,'network_unavailable'):PositionIndexer(self.store,self.rpc).step(POOL)
            row=self.row('position');self.assertEqual(row['progress'],before)
            self.assertEqual(row['diagnostic']['reason'],'network_unavailable')
            report=self.store.read(POOL)['liquidity']['positionAccounting']
            self.assertEqual(report['reason'],'network_unavailable');self.assertIsNone(report['lpAssetsRaw'])
            self.rpc.fail_position=False
            self.finish(lambda:PositionIndexer(self.store,self.rpc))
        self.assertIsNone(self.row('position'))

    def test_failed_diagnostic_preserves_ledger_error_and_checkpoint_then_recovers(self):
        for ledger,worker_type in (('fee',FeeIndexer),('position',PositionIndexer)):
            with self.subTest(ledger=ledger):
                worker=worker_type(self.store,self.rpc)
                with patch('historical_capacity.MAX_BATCH_EVENTS',1):worker.step(POOL)
                before=self.row(ledger)
                original=DataError('network_unavailable')
                connection=self.catalogue.connection
                with patch.object(worker.activity,'read_state',side_effect=original):
                    for reason in ('catalogue_writer_busy','catalogue_database_unavailable'):
                        with self.subTest(reason=reason):
                            with patch.object(self.catalogue,'connection',side_effect=[
                                    connection(writer=True,lock=True),DataError(reason)]) as connect:
                                with self.assertRaises(DataError) as caught:worker.step(POOL)
                            self.assertIs(caught.exception,original)
                            self.assertEqual(connect.call_count,2)
                            self.assertEqual(self.row(ledger),before)
                    # Once persistence recovers, the same original failure is durable.
                    with self.assertRaises(DataError) as caught:worker.step(POOL)
                    self.assertIs(caught.exception,original)
                after=self.row(ledger)
                self.assertEqual(after['progress'],before['progress'])
                self.assertEqual(after['diagnostic']['reason'],'network_unavailable')
                report=self.store.read(POOL)
                accounting=(report['fees']['accounting'] if ledger=='fee' else
                            report['liquidity']['positionAccounting'])
                self.assertEqual(accounting['status'],'unavailable')
                self.assertEqual(accounting['reason'],'network_unavailable')
                self.assertIsNone(accounting['lpFeesRaw' if ledger=='fee' else 'lpAssetsRaw'])
                self.finish(lambda:worker)
                self.assertIsNone(self.row(ledger))

    def test_late_wrong_tick_and_reorg_cannot_publish_accumulated_checks(self):
        FeeIndexer(self.store,self.rpc).step(POOL)
        with patch('position_store.MAX_BATCH_CHECKS',1):
            PositionIndexer(self.store,self.rpc).step(POOL)
            self.rpc.corrupt='tick'
            with self.assertRaisesRegex(DataError,'core_tick_state_reconciliation_failed'):
                self.finish(lambda:PositionIndexer(self.store,self.rpc))
        with self.catalogue.connection() as conn:
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM domino_activity.position_chunks').fetchone()['n'],0)
        self.rpc.corrupt=None;self.rpc.fork_at=30
        with self.assertRaisesRegex(DataError,'reorg_requires_replay'):PositionIndexer(self.store,self.rpc).step(POOL)
        with self.catalogue.connection(writer=True,lock=True) as conn:
            self.store.rewind(conn,self.store.pool(conn,POOL),9)
        self.assertIsNone(self.row('position'))

    def test_byte_budget_failure_and_fee_rewind_keep_qualified_values_unavailable(self):
        with patch('historical_capacity.MAX_BATCH_EVENTS',1),patch('historical_capacity.MAX_PROGRESS_BYTES',1):
            with self.assertRaisesRegex(DataError,'historical_work_byte_budget_exhausted'):FeeIndexer(self.store,self.rpc).step(POOL)
        self.assertEqual(self.row('fee')['diagnostic']['action'],'capacity_review_required')
        self.assertIsNone(self.row('fee')['progress'])
        with patch('historical_capacity.MAX_BATCH_EVENTS',1):FeeIndexer(self.store,self.rpc).step(POOL)
        with self.catalogue.connection(writer=True,lock=True) as conn:
            self.store.rewind(conn,self.store.pool(conn,POOL),9)
        self.assertIsNone(self.row('fee'))

    def test_malformed_resume_offset_is_blocked_without_publishing_or_erasing_progress(self):
        with patch('historical_capacity.MAX_BATCH_EVENTS',1):FeeIndexer(self.store,self.rpc).step(POOL)
        with self.catalogue.connection(writer=True) as conn:
            conn.execute("UPDATE domino_activity.historical_work SET progress=jsonb_set(progress,'{offset}','2001')")
        with self.assertRaisesRegex(DataError,'historical_work_checkpoint_mismatch'):FeeIndexer(self.store,self.rpc).step(POOL)
        record=self.row('fee')
        self.assertEqual(record['progress']['offset'],2001)
        self.assertEqual(record['diagnostic']['status'],'blocked')
        self.assertEqual(record['diagnostic']['reason'],'historical_work_checkpoint_mismatch')
        self.assertIsNone(self.store.read(POOL)['fees']['accounting']['lpFeesRaw'])

    def test_extended_profile_replays_129_closed_identities_and_516_checks(self):
        activity_tests.ActivityPostgresTests.setUp(self)
        self.rpc=ChurnRpc();self.worker=ActivityIndexer(self.store,self.rpc)
        self.worker.register(POOL,10);self.worker.step(POOL,through=11)
        self.finish(lambda:FeeIndexer(self.store,self.rpc))
        with self.assertRaisesRegex(DataError,'core_position_budget_exhausted'):
            self.finish(lambda:PositionIndexer(self.store,self.rpc))
        self.assertEqual(self.row('position')['diagnostic']['action'],'select_extended_profile_and_resume')
        self.assertEqual(self.row('position')['progress']['offset'],256)
        result=self.finish(lambda:PositionIndexer(self.store,self.rpc,capacity='extended'))
        self.assertEqual((result['corePositions'],result['knownTicks']),(129,258))
        self.assertEqual(len(self.rpc.checked),516)
        self.assertEqual(len({repr(c) for c in self.rpc.checked}),516)
        report=self.store.read(POOL)['liquidity']['positionAccounting']
        self.assertEqual(report['lpAssetsRaw'],self.rpc.expected['lpAssetsRaw'])
        self.assertEqual(report['corePositionCount'],129)
        self.assertEqual(report['nonzeroLiquidityPositionCount'],0)
        self.assertEqual(report['unsettledFeesRaw'],['0','0'])

    def test_reader_cannot_mutate_work_and_backup_restores_unpublished_progress(self):
        with patch('historical_capacity.MAX_BATCH_EVENTS',1):FeeIndexer(self.store,self.rpc).step(POOL)
        before=self.row('fee')
        with self.assertRaises(DataError):
            with self.catalogue.connection() as conn:conn.execute('DELETE FROM domino_activity.historical_work')
        with tempfile.TemporaryDirectory() as folder:
            archive=Path(folder)/'work.dump'
            common=['-h',str(SOCKET),'-p',str(PORT),'-U',ADMIN]
            subprocess.run([str(BIN/'pg_dump'),*common,'-Fc','-n','domino_activity','-f',str(archive),'domino_catalogue_tests'],check=True,capture_output=True)
            subprocess.run([str(BIN/'pg_restore'),*common,'--clean','--if-exists','-d','domino_catalogue_restore_tests',str(archive)],check=True,capture_output=True)
        from psycopg.rows import dict_row
        with psycopg.connect(**{**self.settings,'dbname':'domino_catalogue_restore_tests'},user='domino_catalogue_reader',row_factory=dict_row) as conn:
            restored=conn.execute('SELECT * FROM domino_activity.historical_work').fetchone()
        self.assertEqual(restored,before)
