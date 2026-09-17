"""Independent, bounded RPC envelopes preserve snapshot identity and budgets."""
from copy import deepcopy
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from eth_abi import encode
from eth_hash.auto import keccak
from discovery import (CHAIN_ID, DEFAULT_READ_CALL_GAS, DataError, DiscoveryReader,
                       POOL_MANAGER, POSITION_MANAGER, STATE_VIEW, ReadRpc, json_http)
from read_deadline import read_deadline
from read_service import ReadService
from rpc_failover import FailoverReadRpc
from test_discovery import BLOCK, KEY, KEY_TYPES, POOL, TOKEN

PRIMARY='https://primary.example.invalid'
SECOND='https://secondary.example.invalid'
HEAD=[('eth_chainId',[]),('eth_getBlockByNumber',['latest',False])]
CODES=[('eth_getCode',[POSITION_MANAGER,BLOCK['number']]),('eth_getCode',[STATE_VIEW,BLOCK['number']])]


class Provider:
    def __init__(self):
        self.envelopes=[]
        self.mutate=None
        self.fail={}
        self.chains={}
        self.blocks={}
        self.codes={}
        self.managers={}
        self.reorg=False
        self.block_reads=0
        self.clock=None

    def __call__(self,url,body):
        self.envelopes.append((url,deepcopy(body)))
        if self.clock is not None:self.clock[0]+=0.5
        batch=isinstance(body,list)
        if (url,batch) in self.fail:raise DataError(self.fail[(url,batch)])
        records=body if batch else [body]
        responses=[]
        for record in records:
            method,params=record['method'],record['params']
            if method=='eth_chainId':result=hex(self.chains.get(url,CHAIN_ID))
            elif method=='eth_getBlockByNumber':
                self.block_reads+=1
                result=deepcopy(self.blocks.get(url,BLOCK))
                if self.reorg and self.block_reads>1:result['hash']='0x'+'ee'*32
            elif method=='eth_getCode':
                assert params[1]==BLOCK['number']
                result=self.codes.get(params[0],'0x6000')
            elif method=='eth_getBalance':result='0x1'
            elif method=='eth_call':
                assert params[1]==BLOCK['number']
                assert 21000<=int(params[0]['gas'],16)<=DEFAULT_READ_CALL_GAS
                selector=params[0]['data'][2:10]
                if selector==keccak(b'poolManager()')[:4].hex():result='0x'+encode(['address'],[self.managers.get(params[0]['to'],POOL_MANAGER)]).hex()
                elif selector==keccak(b'poolKeys(bytes25)')[:4].hex():result='0x'+encode(KEY_TYPES,KEY).hex()
                elif selector==keccak(b'getSlot0(bytes32)')[:4].hex():result='0x'+encode(['uint160','int24','uint24','uint24'],[2**96,0,0,KEY[2]]).hex()
                else:raise AssertionError('unexpected read selector')
            else:raise AssertionError('unexpected RPC method')
            responses.append({'jsonrpc':'2.0','id':record['id'],'result':result})
        response=list(reversed(responses)) if batch else responses[0]
        return self.mutate(response) if batch and self.mutate else response

    def logical_count(self):
        return sum(len(body) if isinstance(body,list) else 1 for _,body in self.envelopes)


class ReadRpcBatchTests(unittest.TestCase):
    def test_out_of_order_results_are_mapped_by_exact_ids_and_each_item_counts(self):
        provider=Provider();rpc=ReadRpc(transport=provider)
        rpc.request('eth_chainId')
        self.assertEqual(rpc.batch(HEAD),[hex(CHAIN_ID),BLOCK])
        self.assertEqual(rpc.count,3)
        self.assertEqual([r['id'] for r in provider.envelopes[-1][1]],[2,3])

    def test_duplicate_missing_foreign_boolean_or_wrong_envelopes_fail_atomically(self):
        def mutate(kind,rows):
            rows=deepcopy(rows)
            if kind=='duplicate':rows[0]['id']=rows[1]['id']
            if kind=='missing':rows.pop()
            if kind=='foreign':rows[0]['id']=999
            if kind=='boolean':rows[0]['id']=True
            if kind=='float':rows[0]['id']=1.0
            if kind=='string':rows[0]['id']='1'
            if kind=='version':rows[0]['jsonrpc']='1.0'
            if kind=='extra':rows[0]['private_url']='must-not-escape'
            if kind=='both':rows[0]['error']={'code':-1,'message':'private-canary'}
            if kind=='neither':del rows[0]['result']
            if kind=='object':return rows[0]
            if kind=='invalid_member':rows[0]=None
            return rows
        for kind in ('duplicate','missing','foreign','boolean','float','string','version','extra','both','neither','object','invalid_member'):
            provider=Provider();provider.mutate=lambda rows:mutate(kind,rows)
            rpc=ReadRpc(transport=provider)
            with self.subTest(kind=kind),self.assertRaisesRegex(DataError,'^invalid_rpc_envelope$'):rpc.batch(HEAD)
            self.assertEqual(rpc.count,2)
            self.assertEqual(len(provider.envelopes),1)

    def test_rpc_error_rejects_whole_batch_without_exporting_provider_text(self):
        provider=Provider()
        provider.mutate=lambda rows:[{**rows[0],'result':BLOCK},{'jsonrpc':'2.0','id':rows[1]['id'],'error':{'code':-32000,'message':'private URL credential'}}]
        with self.assertRaisesRegex(DataError,'^rpc_error$'):ReadRpc(transport=provider).batch(HEAD)
        self.assertEqual(len(provider.envelopes),1)

    def test_item_count_request_size_and_remaining_budget_are_checked_before_dispatch(self):
        cases=[([],160),([HEAD[0]]*9,160),(HEAD,1)]
        for calls,budget in cases:
            provider=Provider();rpc=ReadRpc(transport=provider,max_requests=budget)
            with self.assertRaises(DataError):rpc.batch(calls)
            self.assertEqual(provider.envelopes,[])
            self.assertEqual(rpc.count,0)
        provider=Provider();rpc=ReadRpc(transport=provider)
        data='0x'+'00'*7500
        calls=[('eth_call',[{'to':TOKEN,'data':data,'gas':hex(DEFAULT_READ_CALL_GAS)},BLOCK['number']])]*8
        with self.assertRaisesRegex(DataError,'invalid_rpc_batch'):rpc.batch(calls)
        self.assertEqual(provider.envelopes,[])
        self.assertEqual(len(ReadRpc(transport=Provider()).batch([HEAD[0]]*8)),8)

    def test_failed_attempt_spends_every_item_and_cannot_retry_over_budget(self):
        provider=Provider();provider.fail[(PRIMARY,True)]='network_unavailable'
        rpc=ReadRpc(PRIMARY,transport=provider,max_requests=2)
        with self.assertRaisesRegex(DataError,'network_unavailable'):rpc.batch(HEAD)
        self.assertEqual(rpc.count,2)
        with self.assertRaisesRegex(DataError,'request_budget_exhausted'):rpc.batch(HEAD)
        self.assertEqual(len(provider.envelopes),1)

    def test_batch_rejects_writes_even_when_a_subclass_expands_individual_methods(self):
        class Expanded(ReadRpc):METHODS=ReadRpc.METHODS|{'eth_sendRawTransaction'}
        provider=Provider();rpc=Expanded(transport=provider)
        for name in ('eth_sendRawTransaction','eth_sendTransaction','eth_sign','personal_sign'):
            with self.assertRaisesRegex(DataError,'method_not_read_only'):rpc.batch([(name,[])])
        self.assertEqual(provider.envelopes,[])

    def test_call_gas_numeric_block_and_override_bounds_are_preserved(self):
        provider=Provider();rpc=ReadRpc(transport=provider)
        call=rpc.call_params(POSITION_MANAGER,'poolManager()',block=BLOCK['number'])
        for kind in ('over_gas','no_gas','latest','override','to','odd_data','extra_tx','full_block'):
            params=deepcopy(call);method='eth_call'
            if kind=='over_gas':params[0]['gas']=hex(DEFAULT_READ_CALL_GAS+1)
            if kind=='no_gas':del params[0]['gas']
            if kind=='latest':params[1]='latest'
            if kind=='override':params.append({TOKEN:{'balance':'0x1'}})
            if kind=='to':params[0]['to']='0x1234'
            if kind=='odd_data':params[0]['data']='0x1'
            if kind=='extra_tx':params[0]['from']=TOKEN
            if kind=='full_block':method='eth_getBlockByNumber';params=['latest',True]
            with self.subTest(kind=kind),self.assertRaises(DataError):rpc.batch([(method,params)])
        self.assertEqual(provider.envelopes,[])
        rpc.batch([('eth_call',call)])
        self.assertEqual(provider.envelopes[0][1][0]['params'][0]['gas'],hex(DEFAULT_READ_CALL_GAS))

    def test_shared_deadline_checked_after_noncooperative_batch_transport(self):
        now=[0.];provider=Provider();provider.clock=now
        rpc=ReadRpc(transport=provider)
        with self.assertRaisesRegex(DataError,'read_deadline_exceeded'):
            with read_deadline(0.1,clock=lambda:now[0]):rpc.batch(HEAD)
        self.assertEqual(rpc.count,2)
        self.assertEqual(len(provider.envelopes),1)

    def test_existing_aggregate_http_byte_guard_and_strict_json_apply_to_batch(self):
        rpc=ReadRpc(PRIMARY,transport=lambda url,body:json_http(url,body,opener=lambda *a,**k:io.BytesIO(b' '*2_000_001)))
        with self.assertRaisesRegex(DataError,'response_too_large'):rpc.batch(HEAD)
        duplicate=b'[{"jsonrpc":"2.0","id":1,"id":1,"result":"0x1237"}]'
        rpc=ReadRpc(PRIMARY,transport=lambda url,body:json_http(url,body,opener=lambda *a,**k:io.BytesIO(duplicate)))
        with self.assertRaisesRegex(DataError,'invalid_json'):rpc.batch([HEAD[0]])


class BatchFailoverTests(unittest.TestCase):
    def anchor(self,**kwargs):
        self.provider=Provider();self.rpc=FailoverReadRpc((PRIMARY,SECOND),transport=self.provider,**kwargs)
        self.rpc.request('eth_getBlockByNumber',['latest',False])

    def test_bootstrap_network_failure_falls_back_before_any_batch_is_sent(self):
        provider=Provider();provider.fail[(PRIMARY,False)]='network_unavailable'
        rpc=FailoverReadRpc((PRIMARY,SECOND),transport=provider,batch_reads=True)
        self.assertEqual(DiscoveryReader(rpc,clock=lambda:1010).snapshot().number,700)
        primary=[body for url,body in provider.envelopes if url==PRIMARY]
        second=[body for url,body in provider.envelopes if url==SECOND]
        self.assertEqual([body['method'] for body in primary],['eth_chainId'])
        self.assertEqual([body['method'] if isinstance(body,dict) else len(body) for body in second],['eth_chainId',2,5])
        self.assertEqual(rpc.count,9)
        self.assertEqual(rpc.count,provider.logical_count())
        self.assertIsNone(rpc.failure)

    def test_network_failure_during_anchor_verification_rechecks_all_anchors_on_third_provider(self):
        third='https://third.example.invalid'
        later={**BLOCK,'number':'0x2bd','hash':'0x'+'ab'*32,'timestamp':'0x3e9'}
        blocks={BLOCK['number']:BLOCK,later['number']:later}
        class AnchorProvider(Provider):
            def __call__(self,url,body):
                if isinstance(body,dict) and body['method']=='eth_getBlockByNumber':
                    tag=body['params'][0]
                    if url==SECOND and tag==later['number']:
                        self.envelopes.append((url,deepcopy(body)))
                        raise DataError('network_unavailable')
                    self.blocks[url]=blocks.get(tag,BLOCK)
                return super().__call__(url,body)
        provider=AnchorProvider();rpc=FailoverReadRpc((PRIMARY,SECOND,third),transport=provider)
        rpc.request('eth_getBlockByNumber',['latest',False])
        rpc.request('eth_getBlockByNumber',[later['number'],False])
        before=deepcopy(rpc.anchors)
        provider.fail[(PRIMARY,True)]='http_503'
        self.assertEqual(rpc.batch(CODES),['0x6000']*2)
        for url in (SECOND,third):
            records=[body for endpoint,body in provider.envelopes if endpoint==url]
            self.assertEqual([body['method'] for body in records[:3]],['eth_chainId','eth_getBlockByNumber','eth_getBlockByNumber'])
            self.assertEqual([body['params'][0] for body in records[1:3]],list(blocks))
            self.assertEqual(len(records),3 if url==SECOND else 4)
        self.assertEqual(rpc.anchors,before)
        self.assertEqual(rpc.index,2)
        self.assertEqual(rpc.count,13)
        self.assertEqual(rpc.count,provider.logical_count())
        self.assertIsNone(rpc.failure)

    def test_pre_dispatch_network_fallback_preserves_shared_budget(self):
        provider=Provider();provider.fail[(PRIMARY,False)]='network_unavailable'
        rpc=FailoverReadRpc((PRIMARY,SECOND),transport=provider,max_requests=1)
        with self.assertRaisesRegex(DataError,'^request_budget_exhausted$'):rpc.batch(HEAD)
        self.assertEqual(rpc.failure,'request_budget_exhausted')
        self.assertEqual(rpc.count,1)
        self.assertEqual(len(provider.envelopes),1)
        self.assertEqual(provider.envelopes[0][0],PRIMARY)

    def test_pre_dispatch_network_failure_cannot_fall_back_after_shared_deadline(self):
        now=[0.];provider=Provider();provider.clock=now
        provider.fail[(PRIMARY,False)]='network_unavailable'
        rpc=FailoverReadRpc((PRIMARY,SECOND),transport=provider)
        with self.assertRaisesRegex(DataError,'^read_deadline_exceeded$'):
            with read_deadline(0.1,clock=lambda:now[0]):rpc.batch(HEAD)
        self.assertEqual(rpc.failure,'read_deadline_exceeded')
        self.assertEqual(rpc.count,1)
        self.assertEqual(rpc.index,0)
        self.assertEqual(len(provider.envelopes),1)

    def test_network_ambiguity_after_bootstrap_fallback_does_not_try_third_provider(self):
        third='https://third.example.invalid'
        provider=Provider();provider.fail[(PRIMARY,False)]='network_unavailable'
        provider.fail[(SECOND,True)]='network_unavailable'
        rpc=FailoverReadRpc((PRIMARY,SECOND,third),transport=provider)
        with self.assertRaisesRegex(DataError,'^network_unavailable$'):rpc.batch(HEAD)
        self.assertEqual(rpc.failure,'network_unavailable')
        self.assertEqual(rpc.count,4)
        self.assertEqual([url for url,_ in provider.envelopes],[PRIMARY,SECOND,SECOND])
        self.assertIsInstance(provider.envelopes[-1][1],list)

    def test_explicit_http_failure_requalifies_every_anchor_and_replays_whole_batch(self):
        self.anchor();self.provider.fail[(PRIMARY,True)]='http_503'
        self.assertEqual(self.rpc.batch(CODES),['0x6000']*2)
        second=[body for url,body in self.provider.envelopes if url==SECOND]
        self.assertEqual([body['method'] if isinstance(body,dict) else 'batch' for body in second],['eth_chainId','eth_getBlockByNumber','batch'])
        self.assertEqual(self.rpc.count,8)
        self.assertEqual(self.rpc.count,self.provider.logical_count())

    def test_wrong_chain_or_changed_anchor_on_fallback_poison_future_work(self):
        for kind,reason in (('chain','wrong_chain'),('hash','snapshot_reorganized'),('time','snapshot_reorganized')):
            self.anchor();self.provider.fail[(PRIMARY,True)]='http_503'
            if kind=='chain':self.provider.chains[SECOND]=1
            else:self.provider.blocks[SECOND]={**BLOCK,('hash' if kind=='hash' else 'timestamp'):('0x'+'ee'*32 if kind=='hash' else '0x3e9')}
            with self.subTest(kind=kind),self.assertRaisesRegex(DataError,reason):self.rpc.batch(CODES)
            count=self.provider.logical_count()
            with self.assertRaisesRegex(DataError,reason):self.rpc.request('eth_chainId')
            self.assertEqual(count,self.provider.logical_count())
            self.assertFalse(any(isinstance(body,list) for url,body in self.provider.envelopes if url==SECOND))

    def test_network_timeout_or_invalid_envelope_does_not_retry_another_endpoint(self):
        for reason in ('network_unavailable','invalid_rpc_envelope','rpc_error'):
            self.anchor();self.provider.fail[(PRIMARY,True)]=reason
            with self.assertRaisesRegex(DataError,'^'+reason+'$'):self.rpc.batch(CODES)
            self.assertFalse(any(url==SECOND for url,_ in self.provider.envelopes))
            self.assertEqual(self.rpc.failure,reason)

    def test_expired_deadline_poisoned_without_fallback_or_later_retry(self):
        self.anchor();now=[0.];self.provider.clock=now
        self.provider.fail[(PRIMARY,True)]='http_503'
        with self.assertRaisesRegex(DataError,'read_deadline_exceeded'):
            with read_deadline(0.1,clock=lambda:now[0]):self.rpc.batch(CODES)
        count=self.provider.logical_count()
        with self.assertRaisesRegex(DataError,'read_deadline_exceeded'):self.rpc.batch(CODES)
        self.assertEqual(self.provider.logical_count(),count)
        self.assertEqual(self.rpc.index,0)

    def test_first_batch_cannot_create_and_consume_an_unobserved_state_anchor(self):
        provider=Provider();rpc=FailoverReadRpc((PRIMARY,),transport=provider)
        with self.assertRaisesRegex(DataError,'block_unavailable'):rpc.batch([HEAD[1],CODES[0]])
        self.assertEqual(provider.logical_count(),1)  # identity verification only
        self.assertEqual(rpc.anchors,{})

    def test_wrong_number_or_invalid_final_block_never_commits_partial_anchors(self):
        self.anchor();before=deepcopy(self.rpc.anchors)
        self.provider.blocks[PRIMARY]={**BLOCK,'number':'0x2bd'}
        with self.assertRaisesRegex(DataError,'snapshot_reorganized'):self.rpc.batch([('eth_getBlockByNumber',[BLOCK['number'],False])])
        self.assertEqual(self.rpc.anchors,before)
        self.anchor();self.provider.mutate=lambda rows:[rows[0],{**rows[1],'result':'0x1'}]
        with self.assertRaises(DataError):self.rpc.batch(HEAD)
        self.assertEqual(self.rpc.anchors,before)

    def test_budget_counts_failed_batch_and_all_failover_identity_calls(self):
        self.anchor(max_requests=7);self.provider.fail[(PRIMARY,True)]='http_503'
        with self.assertRaisesRegex(DataError,'request_budget_exhausted'):self.rpc.batch(CODES)
        self.assertEqual(self.rpc.count,6) # full two-item replay cannot fit; no partial dispatch
        self.assertEqual(self.provider.logical_count(),6)


class DiscoveryBatchTests(unittest.TestCase):
    def result(self,batched,provider=None):
        provider=provider or Provider()
        rpc=FailoverReadRpc((PRIMARY,),transport=provider,batch_reads=batched)
        reader=DiscoveryReader(rpc,clock=lambda:1010)
        block=reader.snapshot();pool=reader.pool({'poolId':POOL},block);reader.assert_canonical(block)
        return pool,rpc,provider

    def test_batched_snapshot_matches_sequential_results_and_reduces_round_trips(self):
        old,old_rpc,old_provider=self.result(False)
        new,new_rpc,new_provider=self.result(True)
        self.assertEqual(new,old)
        self.assertEqual((old_rpc.count,new_rpc.count),(11,11))
        self.assertEqual((len(old_provider.envelopes),len(new_provider.envelopes)),(11,6))
        self.assertEqual([len(body) for _,body in new_provider.envelopes if isinstance(body,list)],[2,5])
        for _,body in new_provider.envelopes:
            for item in body if isinstance(body,list) else [body]:
                if item['method'] in ('eth_getCode','eth_call'):self.assertEqual(item['params'][-1],BLOCK['number'])

    def test_all_identity_code_link_freshness_and_final_hash_guards_survive(self):
        for kind,reason in (('chain','wrong_chain'),('code','missing_contract_code'),('link','manager_mismatch'),('reorg','snapshot_reorganized'),('stale','stale_or_future_block')):
            provider=Provider()
            if kind=='chain':provider.chains[PRIMARY]=1
            if kind=='code':provider.codes[POOL_MANAGER]='0x'
            if kind=='link':provider.managers[STATE_VIEW]=TOKEN
            if kind=='reorg':provider.reorg=True
            if kind=='stale':provider.blocks[PRIMARY]={**BLOCK,'timestamp':'0x1'}
            with self.subTest(kind=kind),self.assertRaisesRegex(DataError,reason):self.result(True,provider)
            if kind in ('chain','stale'):self.assertFalse(any(isinstance(body,list) and len(body)==5 for _,body in provider.envelopes))

    def pools(self,batched,candidates,provider=None):
        """Identity reads for many candidates; returns outcomes and their envelopes."""
        provider=provider or Provider()
        rpc=FailoverReadRpc((PRIMARY,),transport=provider,batch_reads=batched)
        reader=DiscoveryReader(rpc,clock=lambda:1010)
        block=reader.snapshot()
        spent=len(provider.envelopes)
        outcomes=[]
        for candidate,prefetch in zip(candidates,reader.pool_reads(candidates,block)):
            try:outcomes.append(reader.pool(candidate,block,reads=prefetch))
            except DataError as error:outcomes.append(str(error))
        return outcomes,rpc,len(provider.envelopes)-spent

    def test_batched_pool_identity_matches_sequential_and_isolates_a_refused_id(self):
        # Nine readable candidates cross the eight-wide envelope, so both call
        # shapes chunk; the tenth is rejected before any read is planned for it.
        candidates=[{'poolId':POOL} for _ in range(9)]+[{'poolId':'0x00'}]
        old,old_rpc,old_envelopes=self.pools(False,candidates)
        new,new_rpc,new_envelopes=self.pools(True,candidates)
        self.assertEqual(new,old)
        self.assertEqual(new[-1],'invalid_bytes32')
        self.assertEqual(sum(isinstance(value,dict) for value in new),9)
        self.assertEqual((old_envelopes,new_envelopes),(18,4))
        self.assertEqual(old_rpc.count,new_rpc.count)

    def test_a_provider_key_is_never_read_back_and_only_slot0_is_fetched(self):
        candidates=[{'poolId':POOL,'poolKey':dict(zip(
            ('currency0','currency1','fee_pips','tick_spacing','hooks'),KEY))} for _ in range(3)]
        old,_,old_envelopes=self.pools(False,candidates)
        new,_,new_envelopes=self.pools(True,candidates)
        self.assertEqual(new,old)
        self.assertEqual((old_envelopes,new_envelopes),(3,1))

    def test_a_failed_envelope_falls_back_to_sequential_reads_for_that_chunk(self):
        candidates=[{'poolId':POOL} for _ in range(9)]
        expected,_,_=self.pools(False,candidates)
        provider=Provider()
        rpc=FailoverReadRpc((PRIMARY,),transport=provider,batch_reads=True)
        reader=DiscoveryReader(rpc,clock=lambda:1010)
        block=reader.snapshot()
        with patch.object(type(rpc),'batch',side_effect=DataError('invalid_rpc_envelope')):
            reads=reader.pool_reads(candidates,block)
        self.assertEqual([reader.pool(candidate,block,reads=prefetch)
                          for candidate,prefetch in zip(candidates,reads)],expected)

    def test_service_enables_batching_but_injected_rpc_retains_its_contract(self):
        service=ReadService(rpc_urls=(PRIMARY,),transport_factory=lambda:Provider())
        self.assertTrue(service._rpc(Provider()).batch_reads)
        legacy=ReadRpc(transport=Provider())
        service=ReadService(rpc_factory=lambda:legacy)
        self.assertIs(service._rpc(Provider()),legacy)
        self.assertFalse(legacy.batch_reads)
        with self.assertRaisesRegex(DataError,'invalid_rpc_batch'):ReadRpc(batch_reads=1)


if __name__=='__main__':unittest.main()
