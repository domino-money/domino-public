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
from fastapi.testclient import TestClient
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from activity_indexer import ActivityIndexer
from activity_store import PgActivity
from catalogue import PgCatalogue, checked_key
from dev_postgres import ADMIN, BIN, PORT, SOCKET
from discovery import DataError
from fee_accounting import reconstruct_swap
from fee_store import FeeIndexer
from pool_activity import DONATE, MODIFY, PROTOCOL, SWAP, active_liquidity, replay
from position_accounting import (core_position_id, inside_growth, pending_fees, principal_amounts,
                                 position_summary, replay_positions)
from position_store import PositionIndexer
from read_api import ReadGate,create_app
from read_service import ReadService
from test_catalogue import block_hash,log,stored_candidate
from test_discovery import BLOCK,POOL,FakeRpc
import test_pool_activity as activity_tests
from test_pool_activity import ActivityRpc,decoded,event_log
from v4_math import Q128,U256

FIXTURE=Path(__file__).parent/'fixtures/position-reference.json'


def reference():return json.loads(FIXTURE.read_text())


class PositionDomainTests(unittest.TestCase):
    def setUp(self):
        self.fixture=reference();self.key=checked_key(self.fixture['poolKey'],POOL)
        self.events=[entry['event'] for entry in self.fixture['sequence']]

    def test_every_recorded_native_state_flow_and_settlement(self):
        activity=model=None
        for entry in self.fixture['sequence']:
            with self.subTest(block=entry['event']['blockNumber']):
                activity,model,settlements=replay_positions(activity,model,[entry['event']],POOL,self.key)
                self.assertEqual(model['growthX128'],entry['expectedGrowthX128'])
                self.assertEqual(model['lpAssetsRaw'],entry['expectedAssetsRaw'])
                self.assertEqual(model['ticks'],entry['expectedTicks'])
                for identity,p in model['positions'].items():
                    expected=entry['expectedPositions'][identity]
                    self.assertEqual(p['liquidityRaw'],expected['liquidityRaw'])
                    self.assertEqual(p['lastInsideX128'],expected['lastInsideX128'])
                    self.assertEqual(list(map(str,inside_growth(model,activity['tick'],p['tickLower'],p['tickUpper']))),expected['insideX128'])
                    self.assertEqual(list(map(str,pending_fees(model,activity,p))),expected['unsettledFeesRaw'])
                    amounts=principal_amounts(activity,p['tickLower'],p['tickUpper'],int(p['liquidityRaw']))
                    self.assertEqual(list(map(str,amounts)),expected['principalRaw'])
                if settlements:self.assertEqual(settlements[0]['settlement'],entry['expectedSettlement'])
                summary=position_summary(model,activity)
                for i in (0,1):
                    self.assertEqual(int(summary['lpAssetsRaw'][i]),sum(int(summary[k][i]) for k in
                                     ('principalRaw','unsettledFeesRaw','roundingResidualRaw')))

    def test_owner_range_and_salt_are_all_part_of_identity(self):
        activity,model,_=replay_positions(None,None,self.events[:4],POOL,self.key)
        self.assertEqual(len(model['positions']),3)
        p=self.events[1]['payload'];salt=p['salt']
        first=core_position_id(p['sender'],p['tickLower'],p['tickUpper'],salt)
        self.assertNotEqual(first,core_position_id('0x'+'33'*20,p['tickLower'],p['tickUpper'],salt))
        self.assertNotEqual(first,core_position_id(p['sender'],p['tickLower'],p['tickUpper'],'0x'+'02'*32))
        self.assertEqual(model['positions'][first]['liquidityRaw'],'1000000000000')

    def test_wrong_salt_cannot_remove_another_positions_range(self):
        activity,model,_=replay_positions(None,None,self.events[:4],POOL,self.key)
        bad=copy.deepcopy(self.events[1]);bad['payload']['salt']='0x'+'ff'*32
        bad['payload']['liquidityDelta']='-1'
        before=copy.deepcopy(model)
        with self.assertRaisesRegex(DataError,'core_position_liquidity_mismatch'):
            replay_positions(activity,model,[bad],POOL,self.key)
        self.assertEqual(model,before)

    def test_collect_partial_remove_close_and_reopen_do_not_rebill_old_fees(self):
        a,m,changes=replay_positions(None,None,self.events[:14],POOL,self.key)
        self.assertTrue(all(p['liquidityRaw']=='0' for p in m['positions'].values()))
        self.assertTrue(all(t['gross']=='0' and t['outsideX128']==['0','0'] for t in m['ticks'].values()))
        self.assertEqual(position_summary(m,a)['unsettledFeesRaw'],['0','0'])
        self.assertGreater(sum(map(int,m['settledFeesRaw'])),0)
        a,m,reopens=replay_positions(a,m,self.events[14:17],POOL,self.key)
        self.assertTrue(all(c['settlement']['settledFeesRaw']==['0','0'] for c in reopens))
        self.assertEqual(len(m['positions']),3)

    def test_empty_poke_and_missing_identity_fail_closed(self):
        a,m,_=replay_positions(None,None,self.events[:1],POOL,self.key)
        bad=copy.deepcopy(self.events[1]);bad['payload']['liquidityDelta']='0'
        with self.assertRaisesRegex(DataError,'liquidity_mismatch'):replay_positions(a,m,[bad],POOL,self.key)
        bad=copy.deepcopy(self.events[1]);del bad['payload']['sender']
        with self.assertRaisesRegex(DataError,'invalid_address'):replay_positions(a,m,[bad],POOL,self.key)

    def test_inside_growth_and_pending_subtraction_wrap_uint256(self):
        a,m,_=replay_positions(None,None,self.events[:2],POOL,self.key)
        p=next(iter(m['positions'].values()));p['liquidityRaw']=str(Q128-1)
        p['lastInsideX128']=[str(U256-10),'0'];m['growthX128']=['3','0']
        self.assertEqual(pending_fees(m,a,p)[0],14*(Q128-1)//Q128)
        m['ticks']['-60000']['outsideX128']=[str(U256-1),'0']
        self.assertEqual(inside_growth(m,0,-60000,60000)[0],5)

    def test_conservation_and_unverified_state_are_explicit(self):
        a,m,_=replay_positions(None,None,self.events,POOL,self.key)
        result=position_summary(m,a,include_positions=True)
        self.assertEqual(result['status'],'reconstructed_unverified')
        self.assertFalse(result['isWithdrawalQuote']);self.assertFalse(result['nftOwnershipResolved'])
        self.assertTrue(result['protocolFeesExcluded']);self.assertTrue(result['donationsIncluded'])
        m['lpAssetsRaw']=['0','0']
        with self.assertRaisesRegex(DataError,'assets_below_liabilities'):position_summary(m,a)

    def test_bounds_version_and_adapter_requirements(self):
        a,m,_=replay_positions(None,None,self.events[:1],POOL,self.key)
        for name in ('MAX_POSITIONS','MAX_TICKS'):
            with patch('position_accounting.'+name,0):
                with self.assertRaisesRegex(DataError,'budget_exhausted'):replay_positions(a,m,self.events[1:2],POOL,self.key)
        with self.assertRaisesRegex(DataError,'methodology_mismatch'):
            replay_positions(a,{**m,'version':999},[],POOL,self.key)
        with self.assertRaisesRegex(DataError,'adapter_required'):
            replay_positions(None,None,[],POOL,replace(self.key,hooks='0x'+'33'*20))

    def test_same_totals_with_different_crossing_growth_are_ambiguous(self):
        a,_,_=replay_positions(None,None,self.events[:5],POOL,self.key)
        p=self.events[5]['payload'];counter=0
        def candidate(*args,**kwargs):
            nonlocal counter
            counter+=1
            return {'grossInput':-int(p['amount1']),'output':int(p['amount0']),
                    'sqrtPriceX96':int(p['sqrtPriceX96']),'tick':p['tick'],'liquidity':int(p['liquidity']),
                    'lp':5,'protocol':1,'growth':10,'crossingGrowth':((60,counter%2),)}
        with patch('fee_accounting.simulate',side_effect=candidate):
            with self.assertRaisesRegex(DataError,'fee_swap_replay_ambiguous'):
                reconstruct_swap(a,self.key,p,with_trace=True)


class PositionFixtureRpc(ActivityRpc):
    def __init__(self):
        super().__init__();self.logs=[log(10)];self.snapshots={};self.identities={}
        self.corrupt=None;self.fail_position=False
        state=None
        for entry in reference()['sequence']:
            event=entry['event'];p=event['payload'];n=event['blockNumber'];i=event['logIndex']
            kind=event['kind']
            if kind=='modify_liquidity':
                self.logs.append(event_log(MODIFY,[p['tickLower'],p['tickUpper'],int(p['liquidityDelta']),bytes.fromhex(p['salt'][2:])],number=n,index=i))
                self.logs[-1]['topics'][2]='0x'+p['sender'][2:].rjust(64,'0')
                identity=core_position_id(p['sender'],p['tickLower'],p['tickUpper'],p['salt'])
                self.identities[identity]=(p['sender'],p['tickLower'],p['tickUpper'],p['salt'])
            elif kind=='protocol_fee':self.logs.append(event_log(PROTOCOL,[p['protocolFeeRaw']],number=n,index=i))
            elif kind=='donate':self.logs.append(event_log(DONATE,[int(p['amount0']),int(p['amount1'])],number=n,index=i))
            elif kind=='swap':
                self.logs.append(event_log(SWAP,[int(p[k]) for k in ('amount0','amount1','sqrtPriceX96','liquidity','tick','swapFeePips')],number=n,index=i))
            state=replay(state,[decoded(self.logs[-1])],POOL,stored_candidate()['poolKey'])
            self.snapshots[n]=(copy.deepcopy(state),entry)

    def call(self,target,signature,inputs=(),values=(),outputs=(),*,block):
        state,entry=self.snapshots[max(n for n in self.snapshots if n<=int(block,16))]
        if signature=='getSlot0(bytes32)':return (int(state['sqrtPriceX96']),state['tick'],state['protocolFeeRaw'],3000)
        if signature=='getLiquidity(bytes32)':return (active_liquidity(state),)
        if signature=='getFeeGrowthGlobals(bytes32)':return tuple(map(int,entry['expectedGrowthX128']))
        if self.fail_position:raise DataError('network_unavailable')
        if signature=='getPositionInfo(bytes32,address,int24,int24,bytes32)':
            _,owner,lo,hi,salt=values;identity=core_position_id(owner,lo,hi,'0x'+salt.hex())
            p=entry['expectedPositions'][identity]
            return (int(p['liquidityRaw'])+int(self.corrupt=='position'),*map(int,p['lastInsideX128']))
        if signature=='getFeeGrowthInside(bytes32,int24,int24)':
            _,lo,hi=values
            for identity,p in entry['expectedPositions'].items():
                if self.identities[identity][1:3]==(lo,hi):
                    return (int(p['insideX128'][0])+int(self.corrupt=='inside'),int(p['insideX128'][1]))
        if signature=='getTickInfo(bytes32,int24)':
            t=entry['expectedTicks'][str(values[1])]
            return (int(t['gross']),int(t['net']),int(t['outsideX128'][0])+int(self.corrupt=='tick'),int(t['outsideX128'][1]))
        raise AssertionError(signature)


class SnapshotRpc(FakeRpc):
    orphan=False
    def request(self,method,params=()):
        if method=='eth_getBlockByNumber':
            if params[0]!='latest' and int(params[0],16)!=700:
                n=int(params[0],16)
                return {'number':hex(n),'timestamp':hex(1000+n),'hash':block_hash(n,1 if self.orphan else 0)}
            return {**BLOCK,'timestamp':hex(2000)}
        return super().request(method,params)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','requires disposable PostgreSQL databases')
class PositionPostgresTests(unittest.TestCase):
    settings=activity_tests.ActivityPostgresTests.settings
    def setUp(self):
        activity_tests.ActivityPostgresTests.setUp(self)
        self.rpc=PositionFixtureRpc();self.worker=ActivityIndexer(self.store,self.rpc)
        self.worker.register(POOL,10);self.worker.step(POOL,through=18)
        self.fees=FeeIndexer(self.store,self.rpc);self.fees.step(POOL)
        self.positions=PositionIndexer(self.store,self.rpc)

    def counts(self):
        with self.catalogue.connection() as conn:
            return tuple(conn.execute('SELECT count(*) AS n FROM domino_activity.'+table).fetchone()['n']
                         for table in ('position_chunks','position_settlements'))

    def test_old_records_require_full_position_reconciliation(self):
        self.assertEqual(self.store.read(POOL)['liquidity']['positionAccounting']['status'],'unavailable')
        result=self.positions.step(POOL)
        self.assertTrue(result['onchainPositionChecksPassed']);self.assertEqual(result['corePositions'],3)
        report=self.store.read(POOL,include_positions=True)
        self.assertEqual(len(report['liquidity']['positionAccounting']['items']),3)
        self.assertEqual(report['liquidity']['positionAccounting']['status'],'reconciled_as_of')
        self.assertEqual(report['liquidity']['tvlReason'],'timestamp_aligned_valuation_unavailable')
        self.assertIsNone(report['liquidity']['tvlUsd']);self.assertIsNone(report['window24h']['feeApr'])

    def test_requires_qualified_fee_source_and_never_advances_it(self):
        with self.catalogue.connection(writer=True) as c:c.execute('DELETE FROM domino_activity.fee_chunks')
        with self.assertRaisesRegex(DataError,'reconciled_fee_chunk_required'):self.positions.step(POOL)
        self.assertEqual(self.counts(),(0,0))

    def test_actual_position_inside_and_tick_state_must_all_match(self):
        for kind,code in [('position','position_state'),('inside','inside_growth'),('tick','tick_state')]:
            self.rpc.corrupt=kind
            with self.subTest(kind=kind),self.assertRaisesRegex(DataError,code):self.positions.step(POOL)
            self.assertEqual(self.counts(),(0,0))
        self.rpc.corrupt=None;self.positions.step(POOL)

    def test_restart_and_lagging_position_ledger_cannot_show_newer_assets(self):
        self.positions.step(POOL);before=self.counts()
        self.worker.step(POOL,through=30);self.fees.step(POOL)
        self.assertIsNone(self.store.read(POOL)['liquidity']['positionAccounting']['lpAssetsRaw'])
        fresh=PositionIndexer(PgActivity(PgCatalogue(self.settings)),self.rpc)
        fresh.step(POOL)
        self.assertEqual(fresh.step(POOL)['status'],'caught_up_to_activity')
        self.assertGreater(self.counts()[1],before[1])

    def test_network_failure_preserves_position_checkpoint(self):
        self.positions.step(POOL);before=self.counts()
        self.worker.step(POOL,through=30);self.fees.step(POOL);self.rpc.fail_position=True
        with self.assertRaisesRegex(DataError,'network_unavailable'):self.positions.step(POOL)
        self.assertEqual(self.counts(),before)
        self.rpc.fail_position=False;self.positions.step(POOL)

    def test_source_rewind_cascades_position_checkpoints_and_settlements(self):
        self.positions.step(POOL);first=self.counts()
        self.worker.step(POOL,through=30);self.fees.step(POOL);self.positions.step(POOL);full=self.counts()
        original=self.positions.activity.chain.block
        def orphan(n):return replace(original(n),hash='0x'+'ff'*32) if n==30 else original(n)
        with patch.object(self.positions.activity.chain,'block',side_effect=orphan):
            with self.assertRaisesRegex(DataError,'reorg_requires_replay'):self.positions.step(POOL)
        self.assertEqual(self.counts(),full)
        with self.catalogue.connection(writer=True,lock=True) as c:self.store.rewind(c,self.store.pool(c,POOL),18)
        self.assertEqual(self.counts(),first)
        self.worker.step(POOL,through=30);self.fees.step(POOL);self.positions.step(POOL)
        self.assertEqual(self.counts(),full)

    def test_reorg_during_position_reads_never_commits(self):
        original=self.positions.check_positions
        def changed(*args):
            result=original(*args);self.rpc.fork_at=18;return result
        with patch.object(self.positions,'check_positions',side_effect=changed):
            with self.assertRaisesRegex(DataError,'reorg_requires_replay'):self.positions.step(POOL)
        self.assertEqual(self.counts(),(0,0))

    def test_writer_serialization_and_missing_settlement_audit(self):
        with self.catalogue.connection(writer=True,lock=True):
            with self.assertRaisesRegex(DataError,'writer_busy'):self.positions.step(POOL)
        self.positions.step(POOL)
        with self.catalogue.connection(writer=True) as c:c.execute('DELETE FROM domino_activity.position_settlements')
        with self.assertRaisesRegex(DataError,'settlements_incomplete'):self.store.read(POOL)

    def test_tampered_position_model_or_proof_cannot_be_read(self):
        self.positions.step(POOL)
        with self.catalogue.connection(writer=True) as c:
            c.execute("UPDATE domino_activity.position_chunks SET reconciliation=jsonb_set(reconciliation,'{corePositions}','999')")
        with self.assertRaisesRegex(DataError,'stored_position_ledger_mismatch'):self.store.read(POOL)

    def test_actual_dump_restore_and_reader_grants_include_positions(self):
        self.positions.step(POOL);before=self.store.read(POOL,include_positions=True)
        with tempfile.TemporaryDirectory() as folder:
            archive=Path(folder)/'positions.dump';common=['-h',str(SOCKET),'-p',str(PORT),'-U',ADMIN]
            subprocess.run([str(BIN/'pg_dump'),*common,'-d','domino_catalogue_tests','-n','domino_activity','-Fc','-f',str(archive)],check=True,capture_output=True)
            subprocess.run([str(BIN/'pg_restore'),*common,'-d','domino_catalogue_restore_tests','--clean','--if-exists','--exit-on-error',str(archive)],check=True,capture_output=True)
        restored=PgActivity(PgCatalogue({**self.settings,'dbname':'domino_catalogue_restore_tests'}))
        self.assertEqual(restored.read(POOL,include_positions=True),before)
        with psycopg.connect(**self.settings,user='domino_catalogue_reader') as c:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):c.execute('DELETE FROM domino_activity.position_chunks')

    def client(self,rpc=None):
        service=ReadService(catalogue=self.catalogue,rpc_factory=lambda:rpc or SnapshotRpc(),clock=lambda:2000)
        return TestClient(create_app(service,gate=ReadGate(interval=0)),base_url='http://127.0.0.1')

    def test_http_schema_amounts_and_core_owner_scope(self):
        self.positions.step(POOL);client=self.client()
        response=client.post('/v1/read/pool-positions',json={'poolId':POOL})
        self.assertEqual(response.status_code,200);data=response.json()
        self.assertEqual(data['freshness']['status'],'stale');self.assertFalse(data['executionAvailable'])
        p=data['positionAccounting'];self.assertFalse(p['nftOwnershipResolved'])
        self.assertEqual(len(p['items']),3)
        self.assertTrue(all(isinstance(x,str) for item in p['items'] for x in item['principalRaw']+item['unsettledFeesRaw']))
        for request in [{'poolId':'bad'},{'poolId':POOL,'owner':'0x'+'11'*20},{'poolId':POOL,'tokenId':1}]:
            self.assertEqual(client.post('/v1/read/pool-positions',json=request).status_code,422)

    def test_http_missing_or_orphaned_position_snapshot_is_unavailable(self):
        client=self.client();response=client.post('/v1/read/pool-positions',json={'poolId':POOL})
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json()['positionAccounting']['reason'],'position_ledger_not_caught_up')
        self.assertIsNone(response.json()['positionAccounting']['principalRaw'])
        self.assertFalse(response.json()['executionAvailable'])
        self.positions.step(POOL);rpc=SnapshotRpc();rpc.orphan=True
        response=self.client(rpc).post('/v1/read/pool-positions',json={'poolId':POOL})
        self.assertEqual(response.status_code,503);self.assertEqual(response.json()['error'],'activity_snapshot_reorganized')
