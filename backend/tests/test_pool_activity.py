import copy
from dataclasses import asdict
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import psycopg
from eth_abi import encode
from fastapi.testclient import TestClient
from activity_indexer import ActivityIndexer
from activity_store import PgActivity
from catalogue import PgCatalogue
from dev_postgres import ADMIN, BIN, PORT, SOCKET, create_database
from discovery import Block, CHAIN_ID, DataError, POOL_MANAGER
from pool_activity import (DONATE, INITIALIZE_TOPIC, MODIFY, PROTOCOL, SWAP, TOPICS,
                           active_liquidity, decode_activity, protocol_directions, replay, window_metrics)
from read_api import ReadGate, create_app
from read_service import ReadService
from test_catalogue import FakeIndexRpc, block_hash, log, stored_candidate
from test_discovery import BLOCK, KEY, POOL, TOKEN, FakeRpc

PACKED=1000+(200<<12)
SENDER='0x'+TOKEN[2:].rjust(64,'0')


def event_log(kind,values,*,number=11,index=0,branch=0):
    types={SWAP:['int128','int128','uint160','uint128','int24','uint24'],
           MODIFY:['int24','int24','int256','bytes32'],DONATE:['uint256','uint256'],PROTOCOL:['uint24']}[kind]
    topics=[kind,POOL]+([SENDER] if kind!=PROTOCOL else [])
    return {'address':POOL_MANAGER,'removed':False,'topics':topics,'data':'0x'+encode(types,values).hex(),
            'blockNumber':hex(number),'blockHash':block_hash(number,branch),
            'transactionHash':block_hash(number+100000,branch),'logIndex':hex(index)}


def initial_logs():
    return [log(10),event_log(MODIFY,[-60,60,100,b'\x01'*32],number=10,index=1),
            event_log(PROTOCOL,[PACKED],number=10,index=2)]


def decoded(raw,timestamp=None):
    value=decode_activity(raw,POOL)
    value['timestamp']=1000+value['blockNumber'] if timestamp is None else timestamp
    return value


def model_with_liquidity():
    return replay(None,[decoded(x) for x in initial_logs()],POOL,stored_candidate()['poolKey'])


class ActivityDomainTests(unittest.TestCase):
    def test_abi_preserves_large_units_and_position_identifiers(self):
        a=2**100+123
        raw=event_log(SWAP,[-a,a-1,2**96,100,0,3997])
        event=decoded(raw)
        self.assertEqual(event['payload']['amount0'],str(-a))
        modified=decoded(initial_logs()[1])['payload']
        self.assertEqual(modified['sender'],TOKEN)
        self.assertEqual(modified['salt'],'0x'+'01'*32)

    def test_invalid_emitters_pool_signs_and_data_are_rejected(self):
        raw=event_log(SWAP,[-1000,995,2**96,100,0,3997])
        for changed in [dict(removed=True),dict(address=TOKEN),dict(data=raw['data']+'00'),
                        dict(topics=[SWAP,'0x'+'ff'*32,SENDER])]:
            with self.subTest(changed=changed),self.assertRaises(DataError):
                decode_activity({**raw,**changed},POOL)
        for amounts in [[1,1],[-1,-1]]:
            with self.assertRaises(DataError):decoded(event_log(SWAP,[*amounts,2**96,100,0,3997]))
        invalid=copy.deepcopy(raw);invalid['topics'][2]='0x'+'ff'*32
        with self.assertRaisesRegex(DataError,'invalid_activity_sender'):decoded(invalid)

    def test_bad_prices_ranges_and_protocol_packing_fail_closed(self):
        for raw in [event_log(SWAP,[-1,1,0,100,0,3997]),
                    event_log(MODIFY,[60,-60,1,b'\0'*32]),
                    event_log(MODIFY,[-60,60,2**127,b'\0'*32]),
                    event_log(DONATE,[2**127,0]),event_log(PROTOCOL,[1001])]:
            with self.assertRaises(DataError):decoded(raw)
        self.assertEqual(protocol_directions(PACKED),[1000,200])

    def test_range_replay_add_remove_poke_and_upper_boundary(self):
        model=model_with_liquidity()
        self.assertEqual(active_liquidity(model),100)
        self.assertEqual(active_liquidity(model,-60),100)
        self.assertEqual(active_liquidity(model,60),0)
        modified=decoded(event_log(MODIFY,[-60,60,-40,b'\x01'*32]))
        poke=decoded(event_log(MODIFY,[-60,60,0,b'\x01'*32],index=1))
        result=replay(model,[modified,poke],POOL,stored_candidate()['poolKey'])
        self.assertEqual(active_liquidity(result),60)
        self.assertEqual(active_liquidity(model),100) # Pure replay does not damage committed state.

    def test_missing_history_negative_ranges_and_unaligned_ticks_rejected(self):
        change=decoded(event_log(MODIFY,[-60,60,-101,b'\0'*32]))
        with self.assertRaisesRegex(DataError,'initialize_anchor_required'):
            replay(None,[change],POOL,stored_candidate()['poolKey'])
        with self.assertRaisesRegex(DataError,'liquidity_history_mismatch'):
            replay(model_with_liquidity(),[change],POOL,stored_candidate()['poolKey'])
        change=decoded(event_log(MODIFY,[-61,60,1,b'\0'*32]))
        with self.assertRaisesRegex(DataError,'unaligned_liquidity_range'):
            replay(model_with_liquidity(),[change],POOL,stored_candidate()['poolKey'])

    def test_swap_fee_uses_directional_protocol_composition(self):
        model=model_with_liquidity()
        for amounts,fee in [([-1000,995],3997),([995,-1000],3200)]:
            value=decoded(event_log(SWAP,[*amounts,2**96,100,0,fee]))
            replay(model,[value],POOL,stored_candidate()['poolKey'])
        incorrect=decoded(event_log(SWAP,[-1000,995,2**96,100,0,3000]))
        with self.assertRaisesRegex(DataError,'swap_fee_schedule_mismatch'):
            replay(model,[incorrect],POOL,stored_candidate()['poolKey'])

    def test_swap_crossing_checks_post_swap_active_liquidity(self):
        model=model_with_liquidity()
        crossing=decoded(event_log(SWAP,[995,-1000,2**96+1,0,60,3200]))
        self.assertEqual(active_liquidity(replay(model,[crossing],POOL,stored_candidate()['poolKey'])),0)
        crossing['payload']['liquidity']='100'
        with self.assertRaisesRegex(DataError,'swap_liquidity_mismatch'):
            replay(model,[crossing],POOL,stored_candidate()['poolKey'])

    def test_donation_is_separate_from_swap_volume_and_fee_earnings(self):
        events=[decoded(event_log(SWAP,[-1000,995,2**96,100,0,3997])),
                decoded(event_log(DONATE,[1000000,2000000],index=1)),
                decoded(event_log(MODIFY,[-60,60,0,b'\0'*32],index=2))]
        result=window_metrics(events,initialized_at=0,as_of=100000)
        # These timestamps are outside the requested rolling interval.
        self.assertEqual(result['swapEventCount'],0)
        result=window_metrics(events,initialized_at=0,as_of=1012)
        self.assertEqual(result['swapLegsRaw'][0]['grossInput'],'1000')
        self.assertEqual(result['swapLegsRaw'][1]['output'],'995')
        self.assertEqual(result['donations']['amountsRaw'],['1000000','2000000'])
        self.assertIsNone(result['lpFeesRaw'])
        self.assertIsNone(result['volumeUsd'])

    def test_true_rolling_window_excludes_lower_boundary_and_future(self):
        swap=event_log(SWAP,[-1000,995,2**96,100,0,3997])
        end=100000;start=end-86400
        events=[decoded(swap,timestamp=t) for t in [start,start+1,end,end+1]]
        result=window_metrics(events,initialized_at=1,as_of=end)
        self.assertTrue(result['completeWindow'])
        self.assertEqual(result['swapEventCount'],2)
        self.assertEqual(result['swapLegsRaw'][0]['absoluteTurnover'],'2000')
        self.assertEqual(result['swapLegsRaw'][1]['absoluteTurnover'],'1990')

    def test_young_pool_and_complete_empty_interval_are_distinct(self):
        young=window_metrics([],initialized_at=99990,as_of=100000)
        self.assertFalse(young['completeWindow']);self.assertEqual(young['observedSeconds'],10)
        full=window_metrics([],initialized_at=1,as_of=100000)
        self.assertTrue(full['completeWindow']);self.assertEqual(full['nonzeroSwapCount'],0)
        self.assertIsNone(full['feeApr'])

    def test_zero_amount_price_move_is_not_a_nonzero_trade(self):
        value=decoded(event_log(SWAP,[0,0,2**96,100,0,3997]))
        result=window_metrics([value],initialized_at=0,as_of=1012)
        self.assertEqual(result['swapEventCount'],1)
        self.assertEqual(result['nonzeroSwapCount'],0)


class ActivityRpc(FakeIndexRpc):
    def __init__(self):
        super().__init__()
        self.logs=initial_logs()+[event_log(SWAP,[-1000,995,2**96,100,0,3997])]
        self.bad_state=False
        self.fail_logs=False

    def request(self,method,params=()):
        if method=='eth_getLogs':
            if self.fail_logs:raise DataError('network_unavailable')
            self.requests.append((method,params))
            q=params[0]
            assert q['address']==POOL_MANAGER and q['topics'][1]==POOL
            accepted=q['topics'][0] if isinstance(q['topics'][0],list) else [q['topics'][0]]
            result=[x for x in self.logs if x['topics'][0] in accepted
                    and int(q['fromBlock'],16)<=int(x['blockNumber'],16)<=int(q['toBlock'],16)]
            if self.after_logs:self.after_logs()
            return result
        return super().request(method,params)

    def call(self,target,signature,inputs=(),values=(),outputs=(),*,block):
        if signature=='getSlot0(bytes32)':return (2**96,0,PACKED,3000)
        if signature=='getLiquidity(bytes32)':return (101 if self.bad_state else 100,)
        if signature=='getFeeGrowthGlobals(bytes32)':return (123456789012345678901234567890,0)
        raise AssertionError(signature)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES')=='1','requires disposable PostgreSQL databases')
class ActivityPostgresTests(unittest.TestCase):
    settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_catalogue_tests'}

    def setUp(self):
        assert self.settings['dbname']=='domino_catalogue_tests'
        with psycopg.connect(**self.settings,user=ADMIN) as conn:
            conn.execute('TRUNCATE domino_activity.historical_work,domino_activity.price_observations,domino_activity.capital_events,domino_activity.capital_chunks,domino_activity.position_settlements,domino_activity.position_chunks,domino_activity.fee_events,domino_activity.fee_chunks,domino_activity.events,domino_activity.chunks,domino_activity.pools')
        self.catalogue=PgCatalogue(self.settings)
        self.catalogue.seed([stored_candidate()],Block(9,block_hash(9),1009))
        self.store=PgActivity(self.catalogue);self.rpc=ActivityRpc()
        self.worker=ActivityIndexer(self.store,self.rpc)

    def row(self):
        with self.catalogue.connection() as conn:return self.store.pool(conn,POOL)

    def register(self):self.worker.register(POOL,10)

    def counts(self):
        with self.catalogue.connection() as conn:
            return tuple(conn.execute('SELECT count(*) AS n FROM domino_activity.'+table).fetchone()['n']
                         for table in ['chunks','events'])

    def test_real_database_reconciled_rollup_and_resume(self):
        self.register()
        result=self.worker.step(POOL,through=11)
        self.assertTrue(result['stateReconciled']);self.assertEqual(result['events'],4)
        reader=PgActivity(PgCatalogue(self.settings))
        data=reader.read(POOL)
        self.assertEqual(data['window24h']['swapLegsRaw'][0]['grossInput'],'1000')
        self.assertEqual(data['liquidity']['activeLiquidityRaw'],'100')
        self.assertFalse(data['liquidity']['isTvl'])
        worker=ActivityIndexer(reader,self.rpc)
        self.assertEqual(worker.step(POOL,through=13)['fromBlock'],12)
        self.assertEqual(worker.step(POOL,through=13)['status'],'caught_up_to_target')
        self.assertEqual(self.counts(),(2,4))

    def test_bad_anchor_does_not_create_activity_record(self):
        with self.assertRaisesRegex(DataError,'initialize_anchor_not_found'):self.worker.register(POOL,12)
        with self.assertRaisesRegex(DataError,'activity_pool_not_registered'):self.store.read(POOL)
        self.register()
        with self.assertRaisesRegex(DataError,'activity_not_indexed'):self.store.read(POOL)
        with self.assertRaisesRegex(DataError,'activity_start_already_set'):self.worker.register(POOL,12)

    def test_state_mismatch_rolls_back_every_event_and_checkpoint(self):
        self.register();self.rpc.bad_state=True
        with self.assertRaisesRegex(DataError,'activity_state_reconciliation_failed'):
            self.worker.step(POOL,through=11)
        self.assertEqual(self.counts(),(0,0));self.assertEqual(self.row()['next_block'],10)
        self.rpc.bad_state=False
        self.worker.step(POOL,through=11)
        self.assertEqual(self.counts(),(1,4))

    def test_network_failure_inside_transaction_preserves_progress(self):
        self.register();self.worker.step(POOL,through=11)
        before=self.row();self.rpc.fail_logs=True
        with self.assertRaisesRegex(DataError,'network_unavailable'):self.worker.step(POOL,through=13)
        self.assertEqual(self.row(),before);self.assertEqual(self.counts(),(1,4))

    def test_empty_chunk_timestamp_cannot_move_backwards(self):
        self.register();self.worker.step(POOL,through=11)
        original=self.rpc.request
        def bad_time(method,params=()):
            result=original(method,params)
            if method=='eth_getBlockByNumber' and params[0]==hex(13):
                result['timestamp']=hex(1000)
            return result
        self.rpc.request=bad_time
        with self.assertRaisesRegex(DataError,'activity_timestamp_regression'):
            self.worker.step(POOL,through=13)
        self.assertEqual(self.row()['next_block'],12)

    def test_missing_modify_event_fails_liquidity_reconciliation(self):
        self.register();self.rpc.logs=[self.rpc.logs[0],*self.rpc.logs[2:]]
        with self.assertRaisesRegex(DataError,'swap_liquidity_mismatch'):self.worker.step(POOL,through=11)
        self.assertEqual(self.counts(),(0,0))

    def test_exact_duplicates_deduplicate_and_different_salt_conflicts(self):
        self.register()
        self.rpc.logs.append(copy.deepcopy(self.rpc.logs[1]))
        self.assertEqual(self.worker.step(POOL,through=11)['events'],4)
        a=event_log(MODIFY,[-60,60,0,b'\0'*32],number=12)
        b=event_log(MODIFY,[-60,60,0,b'\x01'*32],number=12)
        self.rpc.logs=[a,b]
        with self.assertRaisesRegex(DataError,'conflicting_activity_log'):self.worker.step(POOL,through=13)
        self.assertEqual(self.counts(),(1,4))

    def test_reorg_invalidates_window_totals_then_replays_replacement(self):
        self.register();self.worker.step(POOL,through=11)
        self.rpc.logs=[event_log(SWAP,[-2000,1990,2**96,100,0,3997],number=12)]
        self.worker.step(POOL,through=13)
        self.assertEqual(self.store.read(POOL)['window24h']['swapLegsRaw'][0]['grossInput'],'3000')
        self.rpc.fork_at=12
        self.rpc.logs=[event_log(SWAP,[-3000,2985,2**96,100,0,3997],number=12,branch=1)]
        self.assertEqual(self.worker.step(POOL,through=13),{'status':'rewound','through':11})
        self.assertEqual(self.store.read(POOL)['window24h']['swapLegsRaw'][0]['grossInput'],'1000')
        self.worker.step(POOL,through=13)
        self.assertEqual(self.store.read(POOL)['window24h']['swapLegsRaw'][0]['grossInput'],'4000')

    def test_full_window_rewind_clears_published_activity_until_replayed(self):
        self.register();self.worker.step(POOL,through=11)
        self.rpc.fork_at=9
        self.assertEqual(self.worker.step(POOL,through=11)['through'],9)
        with self.assertRaisesRegex(DataError,'activity_not_indexed'):self.store.read(POOL)
        self.assertEqual(self.row()['next_block'],10)

    def test_mid_read_reorg_cannot_publish_mixed_branch(self):
        self.register()
        self.rpc.after_logs=lambda:setattr(self.rpc,'fork_at',11)
        with self.assertRaisesRegex(DataError,'activity_event_block_mismatch'):self.worker.step(POOL,through=11)
        self.assertEqual(self.counts(),(0,0))

    def test_second_writer_is_rejected_without_advancing(self):
        self.register()
        with self.catalogue.connection(writer=True,lock=True):
            with self.assertRaisesRegex(DataError,'catalogue_writer_busy'):self.worker.step(POOL,through=11)
        self.assertEqual(self.row()['next_block'],10)

    def test_wrong_chain_and_invalid_bounds_are_rejected(self):
        self.rpc.chain=1
        with self.assertRaisesRegex(DataError,'wrong_chain'):self.register()
        self.rpc.chain=CHAIN_ID;self.register()
        for args in [dict(through=-1),dict(through=11,span=10001),dict(through=11,span=True)]:
            with self.assertRaisesRegex(DataError,'invalid_activity_bounds'):self.worker.step(POOL,**args)
        self.assertEqual(self.counts(),(0,0))

    def test_donation_and_zero_delta_fee_poke_do_not_inflate_volume(self):
        self.register()
        self.rpc.logs += [event_log(DONATE,[123456789,42],index=1),
                          event_log(MODIFY,[-60,60,0,b'\x01'*32],index=2)]
        self.worker.step(POOL,through=11)
        window=self.store.read(POOL)['window24h']
        self.assertEqual(window['swapEventCount'],1)
        self.assertEqual(window['donations']['count'],1)
        self.assertEqual(window['donations']['amountsRaw'],['123456789','42'])
        self.assertIsNone(window['lpFeesRaw'])

    def test_activity_dump_restore_and_reader_grants(self):
        self.register();self.worker.step(POOL,through=11)
        before=self.store.read(POOL)
        create_database('domino_catalogue_tests')
        with tempfile.TemporaryDirectory() as folder:
            archive=Path(folder)/'activity.dump';common=['-h',str(SOCKET),'-p',str(PORT),'-U',ADMIN]
            subprocess.run([str(BIN/'pg_dump'),*common,'-d','domino_catalogue_tests','-n','domino_activity',
                            '-Fc','-f',str(archive)],check=True,capture_output=True)
            subprocess.run([str(BIN/'pg_restore'),*common,'-d','domino_catalogue_restore_tests',
                            '--clean','--if-exists','--exit-on-error',str(archive)],check=True,capture_output=True)
        other=PgActivity(PgCatalogue({**self.settings,'dbname':'domino_catalogue_restore_tests'}))
        self.assertEqual(other.read(POOL),before)
        with psycopg.connect(**self.settings,user='domino_catalogue_reader') as conn:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute('DELETE FROM domino_activity.events')
            conn.rollback()


class ActivityApiTests(unittest.TestCase):
    def setup_client(self,stored=None,rpc=None):
        service=ReadService(catalogue=object(),rpc_factory=lambda:rpc or FakeRpc(),clock=lambda:1010)
        client=TestClient(create_app(service,gate=ReadGate(interval=0)),base_url='http://127.0.0.1')
        return client

    @staticmethod
    def report(timestamp=1000,number=700):
        return {'snapshot':{'number':number,'hash':BLOCK['hash'],'timestamp':timestamp},
                'coverage':{},'window24h':{'completeWindow':True},'executionAvailable':False}

    def test_http_schema_and_canonical_freshness(self):
        client=self.setup_client()
        with patch('activity_store.PgActivity.read',return_value=self.report()):
            response=client.post('/v1/read/pool-activity',json={'poolId':POOL})
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json()['freshness']['status'],'fresh')
        self.assertTrue(response.json()['window24h']['usableAsCurrent24h'])
        self.assertEqual(response.headers['cache-control'],'no-store')
        for args in [{'poolId':'invalid'},{'poolId':POOL,'rpcUrl':'https://example.test'},
                     {'poolId':POOL,'fromBlock':10},{'poolId':POOL,'windowSeconds':10}]:
            self.assertEqual(client.post('/v1/read/pool-activity',json=args).status_code,422)

    def test_stale_data_is_historical_not_current_24h(self):
        class OldBlock(FakeRpc):
            def request(self,method,params=()):
                if method=='eth_getBlockByNumber' and params[0]=='0x2bb':
                    return {'number':'0x2bb','hash':BLOCK['hash'],'timestamp':hex(800)}
                return super().request(method,params)
        client=self.setup_client(rpc=OldBlock())
        with patch('activity_store.PgActivity.read',return_value=self.report(timestamp=800,number=699)):
            response=client.post('/v1/read/pool-activity',json={'poolId':POOL})
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json()['freshness']['status'],'stale')
        self.assertFalse(response.json()['window24h']['usableAsCurrent24h'])

    def test_orphaned_snapshot_and_missing_history_are_unavailable_not_zero(self):
        client=self.setup_client()
        report=self.report();report['snapshot']['hash']='0x'+'ff'*32
        with patch('activity_store.PgActivity.read',return_value=report):
            response=client.post('/v1/read/pool-activity',json={'poolId':POOL})
        self.assertEqual(response.status_code,503)
        self.assertEqual(response.json()['error'],'activity_snapshot_reorganized')
        with patch('activity_store.PgActivity.read',side_effect=DataError('activity_not_indexed')):
            response=client.post('/v1/read/pool-activity',json={'poolId':POOL})
        self.assertEqual(response.json(),{'error':'activity_not_indexed'})


if __name__=='__main__':unittest.main()
