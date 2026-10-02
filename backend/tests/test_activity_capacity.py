"""Explicit activity-resource escalation preserves exact models and source history."""
from contextlib import redirect_stdout
from copy import deepcopy
from dataclasses import asdict
import io
import json
import os
from pathlib import Path
import sys
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from activity_indexer import ActivityIndexer
from activity_store import PgActivity
from capital_store import CapitalIndexer, replay_capital
from catalogue import PgCatalogue, checked_key
from discovery import DataError
from fee_accounting import replay_fees
from fee_store import FeeIndexer
from historical_capacity import capacity_profile, diagnostic, replay_batch
from pool_activity import (ACTIVITY_CAPACITY_PROFILES, MAX_RANGES, MODIFY,
                           activity_range_limit, check_activity_capacity, replay)
from position_accounting import replay_positions
from position_store import PositionIndexer
import test_pool_activity as activity_tests
from test_activity_diagnostics import RangeLimitRpc
from test_catalogue import stored_candidate, log
from test_discovery import POOL

KEY=checked_key(stored_candidate()['poolKey'],POOL)


def range_model(count):
    # A structurally valid synthetic predecessor used to test actual limits in
    # one event, without quadratic replay of an already established prefix.
    model=replay(None,[activity_tests.decoded(log(10))],POOL,KEY.__dict__)
    model['ranges']={f'{number*60}:{(number+1)*60}':'1' for number in range(1,count+1)}
    model['eventCount']=count+1
    return model


def change(number,delta=1):
    return activity_tests.decoded(activity_tests.event_log(MODIFY,
        [number*60,(number+1)*60,delta,b'\x01'*32],number=14))


class ActivityCapacityUnitTests(unittest.TestCase):
    def test_real_5000_and_10000_boundaries_preserve_inputs_and_identical_math(self):
        self.assertEqual(ACTIVITY_CAPACITY_PROFILES,{'standard':5000,'extended':10000})
        self.assertEqual(MAX_RANGES,5000)
        for profile,limit in ACTIVITY_CAPACITY_PROFILES.items():
            before=range_model(limit-1)
            result=replay(before,[change(limit)],POOL,KEY.__dict__,capacity=profile)
            self.assertEqual(len(result['ranges']),limit)
            self.assertEqual(len(before['ranges']),limit-1)
            snapshot=deepcopy(result)
            with self.assertRaisesRegex(DataError,'^activity_range_budget_exhausted$'):
                replay(result,[change(limit+1)],POOL,KEY.__dict__,capacity=profile)
            self.assertEqual(result,snapshot)
        before=range_model(4999);events=[change(5000)]
        self.assertEqual(replay(before,events,POOL,KEY.__dict__),
                         replay(before,events,POOL,KEY.__dict__,capacity='extended'))

    def test_default_refuses_inherited_extended_state_even_empty_or_reducing(self):
        model=range_model(5001);snapshot=deepcopy(model)
        for events in ([],[change(5001,-1)]):
            with self.assertRaisesRegex(DataError,'^activity_range_budget_exhausted$'):
                replay(model,events,POOL,KEY.__dict__)
        reduced=replay(model,[change(5001,-1)],POOL,KEY.__dict__,capacity='extended')
        self.assertEqual(len(reduced['ranges']),5000)
        self.assertEqual(replay(reduced,[],POOL,KEY.__dict__),reduced)
        self.assertEqual(model,snapshot)
        with self.assertRaisesRegex(DataError,'^activity_range_budget_exhausted$'):
            replay(range_model(10001),[],POOL,KEY.__dict__,capacity='extended')

    def test_invalid_profiles_never_initialize_chain_or_mutate_state(self):
        for value in (None,False,10000,{},'auto','unlimited'):
            with self.subTest(value=value):
                for operation in (lambda:activity_range_limit(value),
                    lambda:ActivityIndexer(MagicMock(),None,capacity=value),
                    lambda:FeeIndexer(MagicMock(),None,activity_capacity=value),
                    lambda:PositionIndexer(MagicMock(),None,activity_capacity=value),
                    lambda:CapitalIndexer(MagicMock(),None,activity_capacity=value)):
                    with self.assertRaisesRegex(DataError,'^invalid_activity_capacity_profile$'):operation()

    def test_all_descendant_replay_and_completed_prefix_paths_guard_before_effects(self):
        model=range_model(5001);before=deepcopy(model)
        for operation in (replay_fees,replay_positions,replay_capital):
            for events in ([],[change(5001,-1)]):
                with self.subTest(operation=operation.__name__), \
                        self.assertRaisesRegex(DataError,'^activity_range_budget_exhausted$'):
                    operation(model,{},events,POOL,KEY)
        replay_mock=MagicMock()
        with self.assertRaisesRegex(DataError,'^activity_range_budget_exhausted$'):
            replay_batch(replay_mock,model,{},[],0,POOL,KEY)
        replay_mock.assert_not_called()
        self.assertEqual(model,before)
        # Explicit activity escalation cannot raise separate identity/tick limits.
        ledger={'version':1,'positions':{str(i):{} for i in range(1025)},'ticks':{}}
        with self.assertRaisesRegex(DataError,'^core_position_budget_exhausted$'):
            replay_positions(model,ledger,[],POOL,KEY,capacity=capacity_profile('extended'),activity_capacity='extended')
        for indexer in (FeeIndexer,PositionIndexer,CapitalIndexer):
            worker=indexer(MagicMock(),None,activity_capacity='extended')
            self.assertEqual(worker.activity.range_limit,10000)
            self.assertEqual(worker.capacity.positions,128)

    def test_fee_replay_propagates_selection_without_changing_financial_model_shape(self):
        initial=activity_tests.decoded(log(10))
        _,ledger,_=replay_fees(None,None,[initial],POOL,KEY)
        model=range_model(5000)
        with self.assertRaisesRegex(DataError,'^activity_range_budget_exhausted$'):
            replay_batch(replay_fees,model,ledger,[change(5001)],0,POOL,KEY)
        result=replay_batch(replay_fees,model,ledger,[change(5001)],0,POOL,KEY,activity_capacity='extended')
        self.assertEqual(len(result[0]['ranges']),5001)
        self.assertEqual(result[1],ledger)
        self.assertEqual(result[2:],([],1))
        self.assertEqual(set(result[0]),set(model))
        # A proof-only/empty resume still checks the selected range capacity.
        with self.assertRaisesRegex(DataError,'^activity_range_budget_exhausted$'):
            replay_batch(replay_fees,result[0],ledger,[],0,POOL,KEY)
        self.assertEqual(replay_batch(replay_fees,result[0],ledger,[],0,POOL,KEY,activity_capacity='extended')[0],result[0])

    def test_downstream_diagnostic_preserves_shape_and_instructs_explicit_profile_review(self):
        chunk={'start_block':10,'end_block':14}
        ordinary=diagnostic(chunk,capacity_profile('standard'),None)
        blocked=diagnostic(chunk,capacity_profile('standard'),None,'activity_range_budget_exhausted')
        self.assertEqual(set(ordinary),set(blocked))
        self.assertEqual(blocked['limits'],ordinary['limits'])
        self.assertEqual(blocked['action'],'review_activity_capacity_profile_then_resume')
        self.assertNotIn('activityCapacityProfile',blocked)

    def test_cli_profile_reaches_activity_fee_position_and_capital_workers(self):
        import manage_activity, manage_fees, manage_positions, manage_metrics
        with tempfile.TemporaryDirectory() as folder:
            for module,name,flag in ((manage_activity,'ActivityIndexer','--capacity-profile'),
                    (manage_fees,'FeeIndexer','--activity-capacity-profile'),
                    (manage_positions,'PositionIndexer','--activity-capacity-profile')):
                with self.subTest(module=module.__name__):
                    output=Path(folder)/(name+'.json');factory=MagicMock()
                    factory.return_value.step.return_value={'status':'caught_up_to_activity' if module!=manage_activity else 'caught_up_to_target'}
                    with patch('sys.argv',[module.__name__,'--pool-id',POOL,flag,'extended','--output',str(output),'--max-steps','1']), \
                         patch.object(module,'configured_writer_catalogue',return_value=MagicMock()), \
                         patch.object(module,'load_config',return_value={'rpcUrl':'https://rpc.domino.money/TEST_LOCAL_TOKEN_0123456/'}), \
                         patch.object(module,'DiscoveryReader') as reader, \
                         patch.object(module,'PgActivity') as store, \
                         patch.object(module,name,factory), patch.dict(os.environ,{},clear=True),redirect_stdout(io.StringIO()):
                        reader.return_value.snapshot.return_value=activity_tests.Block(1000,'0x'+'ab'*32,2000)
                        store.return_value.read.return_value={'synthetic':True}
                        self.assertEqual(module.main(),0)
                    self.assertEqual(factory.call_args.kwargs['capacity' if module==manage_activity else 'activity_capacity'],'extended')
                    self.assertEqual(json.loads(output.read_text())['activityCapacityProfile'],'extended')
            output=Path(folder)/'metrics.json'
            with patch('sys.argv',['manage_metrics','--pool-id',POOL,'--activity-capacity-profile','extended','--output',str(output)]), \
                 patch.object(manage_metrics,'run',return_value={}) as run:
                self.assertEqual(manage_metrics.main(),0)
                self.assertEqual(run.call_args.kwargs['activity_capacity'],'extended')


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','requires disposable PostgreSQL databases')
class ActivityCapacityPostgresTests(unittest.TestCase):
    settings=activity_tests.ActivityPostgresTests.settings

    def setUp(self):
        activity_tests.ActivityPostgresTests.setUp(self)
        self.rpc=RangeLimitRpc();self.worker=ActivityIndexer(self.store,self.rpc)
        self.worker.register(POOL,10)
        for block in (10,11,12,13):self.worker.step(POOL,through=block,span=1)

    def snapshot(self):
        with self.catalogue.connection() as conn:
            return {'row':self.store.pool(conn,POOL),'tail':self.store.tail(conn,POOL),
                'events':conn.execute('SELECT * FROM domino_activity.events ORDER BY block_number,log_index').fetchall(),
                'chunks':conn.execute('SELECT * FROM domino_activity.chunks ORDER BY start_block').fetchall()}

    def test_5001_resume_restart_empty_default_gate_and_reorg_preserve_exact_prefix(self):
        before=self.snapshot()
        with self.assertRaisesRegex(DataError,'^activity_range_budget_exhausted$'):
            self.worker.step(POOL,through=14,span=1)
        blocked=PgActivity(PgCatalogue(self.settings)).operator_status(POOL)
        self.assertEqual(blocked['diagnostic']['capacityProfile'],'standard')
        self.assertEqual(blocked['diagnostic']['action'],'select_extended_activity_profile_and_resume')
        after_failure=self.snapshot()
        for field in ('tail','events','chunks'):self.assertEqual(after_failure[field],before[field])
        worker=ActivityIndexer(PgActivity(PgCatalogue(self.settings)),self.rpc,capacity='extended')
        result=worker.step(POOL,through=14,span=1)
        self.assertEqual((result['activeRanges'],result['liveRangeLimit']),(5001,10000))
        resumed=self.snapshot()
        self.assertEqual(resumed['row']['next_block'],15)
        self.assertIsNone(resumed['row']['activity_diagnostic'])
        self.assertEqual(resumed['events'][:-1],before['events'])
        self.assertEqual(resumed['chunks'][:-1],before['chunks'])
        expected=replay(before['tail']['model'],[activity_tests.decoded(self.rpc.logs[-1])],POOL,KEY.__dict__,capacity='extended')
        self.assertEqual(resumed['tail']['model'],expected)
        # New process/default profile must reject even a no-event chunk at5001.
        with self.assertRaisesRegex(DataError,'^activity_range_budget_exhausted$'):
            ActivityIndexer(self.store,self.rpc).step(POOL,through=15,span=1)
        failed_empty=self.snapshot()
        for field in ('tail','events','chunks'):self.assertEqual(failed_empty[field],resumed[field])
        self.assertEqual(worker.step(POOL,through=15,span=1)['activeRanges'],5001)
        # A fork clears only the orphaned extended tail and its diagnostic.
        self.rpc.fork_at=14
        self.assertEqual(worker.step(POOL,through=15),{'status':'rewound','through':13})
        rewound=self.snapshot()
        self.assertEqual(rewound['tail'],before['tail'])
        self.assertEqual(rewound['events'],before['events'])
        self.assertEqual(rewound['chunks'],before['chunks'])
        self.assertIsNone(rewound['row']['activity_diagnostic'])

    def test_real_10000_source_boundary_and_10001_failure_are_persistent(self):
        # Continue actual canonical source replay past5k with unchanged2000-event chunks.
        for number in range(5002,10002):
            block=15+(number-5002)//2000 if number<=10000 else 18
            index=(number-5002)%2000 if number<=10000 else 0
            self.rpc.logs.append(activity_tests.event_log(MODIFY,
                [number*60,(number+1)*60,1,b'\x01'*32],number=block,index=index))
        worker=ActivityIndexer(self.store,self.rpc,capacity='extended')
        for block in (14,15,16,17):worker.step(POOL,through=block,span=1)
        before=self.snapshot()
        self.assertEqual(len(before['tail']['model']['ranges']),10000)
        self.assertEqual(len(before['events']),10001)
        with self.assertRaisesRegex(DataError,'^activity_range_budget_exhausted$'):
            worker.step(POOL,through=18,span=1)
        status=PgActivity(PgCatalogue(self.settings)).operator_status(POOL)
        self.assertEqual(status['diagnostic']['capacityProfile'],'extended')
        self.assertEqual(status['diagnostic']['liveRangeLimit'],10000)
        self.assertEqual(status['diagnostic']['observedLiveRangesAtLeast'],10001)
        self.assertFalse(status['diagnostic']['resumeAboveLimitSupported'])
        self.assertFalse(status['resumeAboveLimitSupported'])
        self.assertEqual(status['limits']['liveRanges'],10000)
        self.assertEqual(status['diagnostic']['action'],'capacity_review_required')
        after=self.snapshot()
        for field in ('tail','events','chunks'):self.assertEqual(after[field],before[field])
        self.assertEqual(after['row']['revision'],before['row']['revision'])
        self.assertEqual(after['row']['next_block'],18)
        # Backup/restore retains the extended source and exact blocking evidence.
        from dev_postgres import ADMIN, BIN, PORT, SOCKET
        with tempfile.TemporaryDirectory() as folder:
            archive=Path(folder)/'extended-activity.dump'
            common=['-h',str(SOCKET),'-p',str(PORT),'-U',ADMIN]
            subprocess.run([str(BIN/'pg_dump'),*common,'-d',self.settings['dbname'],'-n','domino_activity',
                '-Fc','-f',str(archive)],check=True,capture_output=True,timeout=15)
            subprocess.run([str(BIN/'pg_restore'),*common,'-d','domino_catalogue_restore_tests',
                '--clean','--if-exists','--exit-on-error',str(archive)],check=True,capture_output=True,timeout=15)
        restored=PgActivity(PgCatalogue({**self.settings,'dbname':'domino_catalogue_restore_tests'}))
        self.assertEqual(restored.operator_status(POOL),status)
        self.assertEqual(restored.read(POOL),self.store.read(POOL))

    def test_fee_checkpoint_resumes_same_source_after_activity_profile_escalation(self):
        # Thirty-two no-change liquidity events are an actually saved fee prefix;
        # event33 introduces range5001. A default worker fails on that same event.
        self.rpc.logs=[raw for raw in self.rpc.logs if int(raw['blockNumber'],16)<14]
        for index in range(32):
            self.rpc.logs.append(activity_tests.event_log(MODIFY,
                [60,120,0,b'\x01'*32],number=14,index=index))
        self.rpc.logs.append(activity_tests.event_log(MODIFY,
            [5001*60,5002*60,1,b'\x01'*32],number=14,index=32))
        ActivityIndexer(self.store,self.rpc,capacity='extended').step(POOL,through=14,span=1)
        fees=FeeIndexer(self.store,self.rpc)
        for _ in range(200):
            result=fees.step(POOL)
            if result['status']=='fee_chunk_in_progress' and result['fromBlock']==14:break
        else:self.fail('bounded fee prefix did not reach the target chunk')
        def fee_state():
            with self.catalogue.connection() as conn:
                return {'work':conn.execute("SELECT * FROM domino_activity.historical_work WHERE ledger='fee'").fetchone(),
                    'qualified':conn.execute('SELECT * FROM domino_activity.fee_chunks ORDER BY chunk_start').fetchall(),
                    'events':conn.execute('SELECT * FROM domino_activity.fee_events ORDER BY log_index').fetchall()}
        before=fee_state()
        self.assertEqual(before['work']['progress']['offset'],32)
        with self.assertRaisesRegex(DataError,'^activity_range_budget_exhausted$'):fees.step(POOL)
        failed=fee_state()
        self.assertEqual(failed['work']['progress'],before['work']['progress'])
        self.assertEqual(failed['qualified'],before['qualified'])
        self.assertEqual(failed['events'],before['events'])
        self.assertEqual(failed['work']['diagnostic']['action'],'review_activity_capacity_profile_then_resume')
        result=FeeIndexer(PgActivity(PgCatalogue(self.settings)),self.rpc,activity_capacity='extended').step(POOL)
        self.assertEqual(result['status'],'fee_chunk_reconciled')
        after=fee_state()
        self.assertIsNone(after['work'])
        self.assertEqual(after['qualified'][:-1],before['qualified'])
        self.assertEqual(after['events'],before['events'])
        self.assertEqual(self.store.read(POOL)['fees']['accounting']['status'],'reconciled_as_of')

    def test_extended_replay_failure_and_sql_failure_keep_prior_diagnostic_and_snapshot(self):
        with self.assertRaises(DataError):self.worker.step(POOL,through=14,span=1)
        before=self.snapshot();worker=ActivityIndexer(self.store,self.rpc,capacity='extended')
        original=self.rpc.call
        def wrong_state(target,signature,*args,**kwargs):
            return (1,) if signature=='getLiquidity(bytes32)' else original(target,signature,*args,**kwargs)
        with patch.object(self.rpc,'call',side_effect=wrong_state):
            with self.assertRaisesRegex(DataError,'^activity_state_reconciliation_failed$'):
                worker.step(POOL,through=14,span=1)
        self.assertEqual(self.snapshot(),before)
        original_commit=self.store.commit
        def fail_commit(conn,row,end,model,snapshot,events):
            original_commit(conn,row,end,model,snapshot,events)
            raise DataError('catalogue_database_unavailable')
        with patch.object(self.store,'commit',side_effect=fail_commit):
            with self.assertRaisesRegex(DataError,'^catalogue_database_unavailable$'):
                worker.step(POOL,through=14,span=1)
        self.assertEqual(self.snapshot(),before)


if __name__=='__main__':unittest.main()
