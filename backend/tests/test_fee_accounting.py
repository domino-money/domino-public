import copy
from dataclasses import replace
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import psycopg
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from activity_indexer import ActivityIndexer
from activity_store import PgActivity
from catalogue import PgCatalogue, checked_key
from dev_postgres import ADMIN, BIN, PORT, SOCKET
from discovery import DataError, ZERO
from fee_accounting import VERSION, reconstruct_swap, replay_fees
from fee_store import FeeIndexer
from pool_activity import DONATE, MODIFY, PROTOCOL, SWAP, replay
from v4_math import MAX_SQRT, MIN_SQRT, Q128, U256, sqrt_at_tick, tick_at_sqrt
from test_catalogue import block_hash, log, stored_candidate
from test_discovery import POOL
import test_pool_activity as activity_tests
from test_pool_activity import ActivityRpc, decoded, event_log

FIXTURE=Path(__file__).parent/'fixtures/fee-reference.json'


def reference():return json.loads(FIXTURE.read_text())['cases'][0]


class FeeDomainTests(unittest.TestCase):
    def setUp(self):
        self.case=reference();self.key=checked_key(self.case['poolKey'],POOL)
        self.events=[e['event'] for e in self.case['sequence']]

    def test_donation_liquidity_changes_and_protocol_remain_separate(self):
        state,ledger,rows=replay_fees(None,None,self.events,POOL,self.key)
        self.assertEqual(ledger['growthX128'],self.case['sequence'][-1]['expectedGrowthX128'])
        self.assertEqual(ledger['donationsRaw'],['1000000003','10000001'])
        for i in (0,1):
            self.assertEqual(int(ledger['lpFeesRaw'][i]),sum(int(r['fees']['lpFeesRaw'][i]) for r in rows))
        self.assertGreater(sum(map(int,ledger['protocolFeesRaw'])),0)
        self.assertGreater(sum(map(int,ledger['lpFeesRaw'])),0)
        self.assertEqual(self.events[0]['payload']['tick'],0) # Replay is pure.

    def test_mutated_swap_legs_fail_instead_of_estimating(self):
        state,ledger,_=replay_fees(None,None,self.events[:5],POOL,self.key)
        changed=copy.deepcopy(self.events[5]['payload']);changed['amount1']=str(int(changed['amount1'])+1000)
        with self.assertRaisesRegex(DataError,'fee_swap_replay_mismatch'):reconstruct_swap(state,self.key,changed)

    def test_ambiguous_matching_modes_are_rejected(self):
        state,_,_=replay_fees(None,None,self.events[:5],POOL,self.key)
        p=self.events[5]['payload'];calls=0
        def ambiguous(*args,**kwargs):
            nonlocal calls
            calls+=1
            return {'grossInput':-int(p['amount0']),'output':int(p['amount1']),
                    'sqrtPriceX96':int(p['sqrtPriceX96']),'tick':p['tick'],'liquidity':int(p['liquidity']),
                    'lp':calls%2,'protocol':0,'growth':calls%2}
        with patch('fee_accounting.simulate',side_effect=ambiguous):
            with self.assertRaisesRegex(DataError,'fee_swap_replay_ambiguous'):reconstruct_swap(state,self.key,p)

    def test_hooks_and_dynamic_fee_require_adapter_without_token_whitelist(self):
        for key in [replace(self.key,hooks='0x'+'22'*20),replace(self.key,fee_pips=0x800000)]:
            with self.assertRaisesRegex(DataError,'adapter_required'):replay_fees(None,None,[],POOL,key)

    def test_anchor_version_and_step_budget_are_enforced(self):
        state,ledger,_=replay_fees(None,None,self.events[:5],POOL,self.key)
        with self.assertRaisesRegex(DataError,'anchor_required'):replay_fees(state,None,[],POOL,self.key)
        bad={**ledger,'version':999}
        with self.assertRaisesRegex(DataError,'methodology_mismatch'):replay_fees(state,bad,[],POOL,self.key)
        with patch('fee_accounting.MAX_STEPS',0):
            with self.assertRaisesRegex(DataError,'budget_exhausted'):
                reconstruct_swap(state,self.key,self.events[5]['payload'])

    def test_growth_wraps_uint256_but_token_totals_do_not(self):
        state,ledger,_=replay_fees(None,None,self.events[:5],POOL,self.key)
        event=copy.deepcopy(self.events[7]);event['kind']='donate';event['payload']={'amount0':'99','amount1':'0'}
        ledger['growthX128'][0]=str(U256-1);ledger['lpFeesRaw'][0]=str(U256)
        from pool_activity import active_liquidity
        expected=(U256-1+99*Q128//active_liquidity(state))&U256
        _,result,_=replay_fees(state,ledger,[event],POOL,self.key)
        self.assertEqual(int(result['growthX128'][0]),expected)
        self.assertEqual(result['lpFeesRaw'][0],str(U256))

    def test_exact_tick_extremes_and_inverse_rounding(self):
        self.assertEqual(sqrt_at_tick(-887272),MIN_SQRT)
        self.assertEqual(sqrt_at_tick(887272),MAX_SQRT)
        for t in [-887271,-1,0,1,887271]:
            self.assertEqual(tick_at_sqrt(sqrt_at_tick(t)),t)
            self.assertEqual(tick_at_sqrt(sqrt_at_tick(t)-1),t-1)


class FeeFixtureRpc(ActivityRpc):
    def __init__(self):
        super().__init__();self.logs=[log(10)];self.snapshots={};self.bad_growth=False;self.fail_state=False
        state=None
        for entry in reference()['sequence']:
            event=entry['event'];p=event['payload'];n=event['blockNumber'];i=event['logIndex']
            if event['kind']=='modify_liquidity':
                self.logs.append(event_log(MODIFY,[p['tickLower'],p['tickUpper'],int(p['liquidityDelta']),b'\0'*32],number=n,index=i))
            elif event['kind']=='protocol_fee':self.logs.append(event_log(PROTOCOL,[p['protocolFeeRaw']],number=n,index=i))
            elif event['kind']=='donate':self.logs.append(event_log(DONATE,[int(p['amount0']),int(p['amount1'])],number=n,index=i))
            elif event['kind']=='swap':
                values=[int(p[k]) for k in ['amount0','amount1','sqrtPriceX96','liquidity','tick','swapFeePips']]
                self.logs.append(event_log(SWAP,values,number=n,index=i))
            state=replay(state,[decoded(self.logs[-1])],POOL,stored_candidate()['poolKey'])
            self.snapshots[n]=(copy.deepcopy(state),list(map(int,entry['expectedGrowthX128'])))

    def call(self,target,signature,inputs=(),values=(),outputs=(),*,block):
        if self.fail_state:raise DataError('network_unavailable')
        state,growth=self.snapshots[max(n for n in self.snapshots if n<=int(block,16))]
        if signature=='getSlot0(bytes32)':return (int(state['sqrtPriceX96']),state['tick'],state['protocolFeeRaw'],3000)
        if signature=='getLiquidity(bytes32)':
            from pool_activity import active_liquidity
            return (active_liquidity(state),)
        if signature=='getFeeGrowthGlobals(bytes32)':return (growth[0]+int(self.bad_growth),growth[1])
        raise AssertionError(signature)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','requires disposable PostgreSQL databases')
class FeePostgresTests(unittest.TestCase):
    settings=activity_tests.ActivityPostgresTests.settings
    def setUp(self):
        activity_tests.ActivityPostgresTests.setUp(self)
        self.rpc=FeeFixtureRpc();self.worker=ActivityIndexer(self.store,self.rpc)
        self.worker.register(POOL,10)
        self.worker.step(POOL,through=18)
        self.fees=FeeIndexer(self.store,self.rpc)

    def counts(self):
        with self.catalogue.connection() as conn:
            return tuple(conn.execute('SELECT count(*) AS n FROM domino_activity.'+table).fetchone()['n']
                         for table in ('fee_chunks','fee_events'))

    def test_old_activity_is_unavailable_until_independently_reconciled(self):
        before=self.store.read(POOL)
        self.assertIsNone(before['window24h']['lpFeesRaw'])
        self.assertEqual(before['fees']['accounting']['reason'],'fee_ledger_not_caught_up')
        self.assertTrue(self.fees.step(POOL)['feeGrowthReconciled'])
        data=self.store.read(POOL)
        self.assertIsNotNone(data['window24h']['lpFeesRaw'])
        self.assertEqual(data['fees']['accounting']['status'],'reconciled_as_of')
        self.assertFalse(data['fees']['accounting']['isDominoServiceFee'])
        self.assertIsNone(data['window24h']['feeApr'])

    def test_restart_resume_and_new_activity_cannot_use_old_fee_totals(self):
        self.fees.step(POOL);before=self.store.read(POOL)
        self.worker.step(POOL,through=30)
        self.assertIsNone(self.store.read(POOL)['window24h']['lpFeesRaw'])
        FeeIndexer(PgActivity(PgCatalogue(self.settings)),self.rpc).step(POOL)
        after=self.store.read(POOL)
        self.assertEqual(self.fees.step(POOL)['status'],'caught_up_to_activity')
        self.assertEqual(self.counts()[0],2)
        self.assertNotEqual(before['window24h']['lpFeesRaw'],after['window24h']['lpFeesRaw'])

    def test_network_failure_retains_previous_fee_checkpoint(self):
        self.fees.step(POOL);self.worker.step(POOL,through=30);counts=self.counts()
        self.rpc.fail_state=True
        with self.assertRaisesRegex(DataError,'network_unavailable'):self.fees.step(POOL)
        self.assertEqual(self.counts(),counts)
        self.rpc.fail_state=False;self.fees.step(POOL)
        self.assertIsNotNone(self.store.read(POOL)['window24h']['lpFeesRaw'])

    def test_saved_or_new_growth_mismatch_does_not_commit(self):
        self.rpc.bad_growth=True
        with self.assertRaisesRegex(DataError,'fee_state_reconciliation_failed'):self.fees.step(POOL)
        self.assertEqual(self.counts(),(0,0));self.rpc.bad_growth=False
        with self.catalogue.connection(writer=True) as conn:
            conn.execute("UPDATE domino_activity.chunks SET state_snapshot=jsonb_set(state_snapshot,'{feeGrowthGlobalX128,0}','\"999\"')")
        with self.assertRaisesRegex(DataError,'fee_growth_reconciliation_failed'):self.fees.step(POOL)
        self.assertEqual(self.counts(),(0,0))

    def test_omitted_swap_with_same_final_liquidity_fails_fee_gate(self):
        with self.catalogue.connection(writer=True) as conn:
            conn.execute("DELETE FROM domino_activity.events WHERE kind='swap' AND block_number=15")
        with self.assertRaises(DataError):self.fees.step(POOL)
        self.assertEqual(self.counts(),(0,0))

    def test_orphan_requires_activity_replay_and_rewind_cascades_fees(self):
        self.fees.step(POOL);self.worker.step(POOL,through=30);self.fees.step(POOL)
        before=self.counts()
        original=self.fees.activity.chain.block
        from dataclasses import replace
        def orphan(n):return replace(original(n),hash='0x'+'ff'*32) if n==30 else original(n)
        with patch.object(self.fees.activity.chain,'block',side_effect=orphan):
            with self.assertRaisesRegex(DataError,'reorg_requires_replay'):self.fees.step(POOL)
        self.assertEqual(self.counts(),before)
        with self.catalogue.connection(writer=True,lock=True) as conn:
            self.store.rewind(conn,self.store.pool(conn,POOL),18)
        self.assertEqual(self.counts()[0],1)
        self.worker.step(POOL,through=30);self.fees.step(POOL)
        self.assertEqual(self.counts(),before)

    def test_writer_lock_and_incomplete_fee_rows_fail_closed(self):
        with self.catalogue.connection(writer=True,lock=True):
            with self.assertRaisesRegex(DataError,'writer_busy'):self.fees.step(POOL)
        self.fees.step(POOL)
        with self.catalogue.connection(writer=True) as conn:
            conn.execute('DELETE FROM domino_activity.fee_events')
        with self.assertRaisesRegex(DataError,'stored_fee_events_incomplete'):self.store.read(POOL)

    def test_actual_backup_restore_includes_fee_ledger_and_reader_grants(self):
        self.fees.step(POOL);before=self.store.read(POOL)
        with tempfile.TemporaryDirectory() as folder:
            archive=Path(folder)/'fees.dump';common=['-h',str(SOCKET),'-p',str(PORT),'-U',ADMIN]
            subprocess.run([str(BIN/'pg_dump'),*common,'-d','domino_catalogue_tests','-n','domino_activity','-Fc','-f',str(archive)],
                           check=True,capture_output=True)
            subprocess.run([str(BIN/'pg_restore'),*common,'-d','domino_catalogue_restore_tests','--clean','--if-exists','--exit-on-error',str(archive)],
                           check=True,capture_output=True)
        other=PgActivity(PgCatalogue({**self.settings,'dbname':'domino_catalogue_restore_tests'}))
        self.assertEqual(other.read(POOL),before)
        with psycopg.connect(**self.settings,user='domino_catalogue_reader') as conn:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):conn.execute('DELETE FROM domino_activity.fee_chunks')
