"""Synthetic RPC receipts exercise exact-effect, canonicality and recovery gates."""
from copy import deepcopy
from dataclasses import asdict
from pathlib import Path
import sys
import unittest
import json
import os
import socket
import subprocess
import time
import urllib.request
from unittest.mock import patch

from eth_abi import decode, encode
from eth_hash.auto import keccak
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deposit_receipt import ReceiptReconciler, receipt_summary, validate_issued_artifact, PERMIT2, TRANSFER, APPROVAL, PERMIT_APPROVAL, MODIFY
from deposit_models import ReceiptSummary
from discovery import CHAIN_ID, POOL_MANAGER, POSITION_MANAGER, ZERO, DataError
from lp_mint_inspection import inspect_mint
from test_lp_mint_inspection import fixture, OWNER, OTHER, TOKEN0, TOKEN1, DEADLINE

SOURCE = 100
MINED = 105
HEAD = 120
FINALIZED = 110
TOKEN_ID = 7
HASH = '0x'+'aa'*32
OTHER_HASH = '0x'+'bb'*32


def block_hash(number): return '0x'+keccak(str(number).encode()).hex()
def topic_address(value): return '0x'+'0'*24+value[2:]
def event(contract, topics, data='0x'):
    return {'address':contract,'topics':topics,'data':data,'removed':False,
        'transactionHash':HASH,'blockHash':block_hash(MINED),'blockNumber':hex(MINED),'transactionIndex':'0x0','logIndex':'0x0'}


def context(*, native=False, kind='mint'):
    mint, raw_context=fixture(native=native)
    key=raw_context['pool_key']
    bounds=inspect_mint(mint,**raw_context)
    selection={'chainId':CHAIN_ID,'poolId':raw_context['pool_id'],'poolKey':asdict(key),
        'independentToken':key.currency0,'amountRaw':'100','tickLower':-120,'tickUpper':180,'slippageBps':50,
        'budget0Raw':'110','budget1Raw':'220','nativeGasReserveRaw':'30000000',
        'maxGasLimitRaw':'300000','maxFeePerGasRaw':'200','maxPriorityFeePerGasRaw':'100'}
    transaction={'chainId':CHAIN_ID,'from':OWNER,'to':POSITION_MANAGER,'data':mint['data'],
        'valueRaw':bounds['nativeValueRaw'],'nonceRaw':'5','gasLimitRaw':'220000','maxFeePerGasRaw':'150','maxPriorityFeePerGasRaw':'50'}
    if kind in ('erc20_reset','erc20_approval'):
        amount=0 if kind=='erc20_reset' else int(bounds['amount1MaxRaw'])
        transaction.update(to=TOKEN1,data='0x'+(keccak(b'approve(address,uint256)')[:4]+encode(['address','uint256'],[PERMIT2,amount])).hex(),valueRaw='0')
    if kind=='permit2_approval':
        transaction.update(to=PERMIT2,data='0x'+(keccak(b'approve(address,address,uint160,uint48)')[:4]+encode(['address','address','uint160','uint48'],[TOKEN1,POSITION_MANAGER,int(bounds['amount1MaxRaw']),DEADLINE])).hex(),valueRaw='0')
    artifact={'kind':kind,'transaction':transaction,'sourceBlock':{'number':SOURCE,'hash':block_hash(SOURCE),'timestamp':DEADLINE-120},
        'expiresAt':DEADLINE-90,'preparedDeadline':DEADLINE,'mintedBounds':bounds,
        'balances':{'nativeRaw':'999999999','token0Raw':'1000','token1Raw':'2000'},
        'admission':{'manifestId':'a'*64,'policyVersion':'direct_existing_pool_v1'},
        'simulation':{'status':'passed','estimatedGasRaw':'200000','blockNumber':SOURCE,'blockHash':block_hash(SOURCE)}}
    return selection,artifact


class Rpc:
    def __init__(self, *, native=False,kind='mint'):
        self.selection,self.artifact=context(native=native,kind=kind)
        tx=self.artifact['transaction']
        self.transaction={'hash':HASH,'chainId':hex(CHAIN_ID),'from':OWNER,'to':tx['to'],'input':tx['data'],
            'value':hex(int(tx['valueRaw'])),'nonce':'0x5','gas':hex(220000),'maxFeePerGas':hex(150),'maxPriorityFeePerGas':hex(50),
            'type':'0x2','accessList':[],'blockNumber':hex(MINED),'blockHash':block_hash(MINED),'transactionIndex':'0x0'}
        key=self.selection['poolKey']
        logs=[]
        if kind=='mint':
            logs=[event(POSITION_MANAGER,[TRANSFER,topic_address(ZERO),topic_address(OWNER),'0x'+TOKEN_ID.to_bytes(32,'big').hex()]),
                  event(POOL_MANAGER,[MODIFY,self.selection['poolId'],topic_address(POSITION_MANAGER)],
                        '0x'+encode(['int24','int24','int256','bytes32'],[-120,180,12345,TOKEN_ID.to_bytes(32,'big')]).hex())]
            if not native: logs.append(event(key['currency0'],[TRANSFER,topic_address(OWNER),topic_address(POOL_MANAGER)],'0x'+encode(['uint256'],[100]).hex()))
            logs.append(event(key['currency1'],[TRANSFER,topic_address(OWNER),topic_address(POOL_MANAGER)],'0x'+encode(['uint256'],[200]).hex()))
        elif kind=='permit2_approval':
            logs=[event(PERMIT2,[PERMIT_APPROVAL,topic_address(OWNER),topic_address(TOKEN1),topic_address(POSITION_MANAGER)],'0x'+encode(['uint160','uint48'],[202,DEADLINE]).hex())]
        else:
            logs=[event(TOKEN1,[APPROVAL,topic_address(OWNER),topic_address(PERMIT2)],'0x'+encode(['uint256'],[0 if kind=='erc20_reset' else 202]).hex())]
        for index,log in enumerate(logs):log['logIndex']=hex(index)
        self.receipt={'transactionHash':HASH,'blockHash':block_hash(MINED),'blockNumber':hex(MINED),'transactionIndex':'0x0',
            'from':OWNER,'to':tx['to'],'status':'0x1','gasUsed':hex(100000),'effectiveGasPrice':hex(100),
            'gasUsedForL1':hex(10000),'l1Fee':'0xa','logs':logs}
        self.calls=[];self.head=HEAD;self.finalized=FINALIZED;self.nonce=6
        self.blocks={MINED:[self.transaction]};self.by_hash={HASH:self.transaction}
        self.receipts={HASH:self.receipt};self.hash_overrides={};self.block_reads={};self.change_on_read={}
        self.current_owner=OWNER;self.fail_current=False;self.fail_receipt_state=False;self.bad_nft=False

    def request(self,method,params):
        self.calls.append((method,deepcopy(params)))
        if method=='eth_chainId':return hex(CHAIN_ID)
        if method=='eth_getTransactionCount':return hex(self.nonce)
        if method=='eth_getCode':return '0x'
        if method=='eth_getBlockByNumber':
            tag,full=params
            if tag=='finalized' and self.finalized is None:raise DataError('rpc_error')
            number=self.head if tag=='latest' else self.finalized if tag=='finalized' else int(tag,16)
            self.block_reads[number]=self.block_reads.get(number,0)+1
            if self.block_reads[number] == self.change_on_read.get(number):self.hash_overrides[number]='0x'+'f'*64
            return {'number':hex(number),'hash':self.hash_overrides.get(number,block_hash(number)),
                'parentHash':self.hash_overrides.get(number-1,block_hash(number-1)),
                'timestamp':hex(DEADLINE-120+number-SOURCE),
                'transactions':deepcopy(self.blocks.get(number,[])) if full else [tx['hash'] for tx in self.blocks.get(number,[])]}
        if method=='eth_getTransactionByHash':return deepcopy(self.by_hash.get(params[0]))
        if method=='eth_getTransactionReceipt':return deepcopy(self.receipts.get(params[0]))
        if method=='eth_call':
            call,pin=params
            assert pin['requireCanonical'] is True
            at_head=pin['blockHash']==block_hash(self.head)
            if self.fail_current and at_head or self.fail_receipt_state and not at_head:raise DataError('rpc_error')
            selector=call['data'][:10]
            if selector=='0x'+keccak(b'getPoolAndPositionInfo(uint256)')[:4].hex():
                key=tuple(self.selection['poolKey'].values())
                pool=self.selection['poolId']
                info=(int(pool,16)>>56)<<56 | (180<<32) | ((-120&0xffffff)<<8)
                if self.bad_nft:info^=1<<32
                return '0x'+encode(['(address,address,uint24,int24,address)','uint256'],[key,info]).hex()
            if selector=='0x'+keccak(b'ownerOf(uint256)')[:4].hex():return '0x'+encode(['address'],[self.current_owner if at_head else OWNER]).hex()
            if selector=='0x'+keccak(b'getPositionLiquidity(uint256)')[:4].hex():return '0x'+encode(['uint128'],[12345]).hex()
        raise AssertionError(method)


def reconcile(rpc, **changes):
    return ReceiptReconciler(rpc).reconcile(OWNER,rpc.selection,rpc.artifact,known_hashes=[HASH],**changes)


class DepositReceiptTests(unittest.TestCase):
    def test_finalized_receipt_requires_nonce_consumed_at_finalized_snapshot(self):
        rpc=Rpc()
        original=rpc.request
        def request(method,params):
            if method=='eth_getTransactionCount' and params[1]['blockHash']==block_hash(FINALIZED):
                return hex(int(rpc.artifact['transaction']['nonceRaw']))
            return original(method,params)
        rpc.request=request
        with self.assertRaisesRegex(DataError,'deposit_receipt_finalized_nonce_mismatch'): reconcile(rpc)

    def test_mint_exact_gas_transfer_and_current_nft_evidence(self):
        rpc=Rpc();result=reconcile(rpc)
        self.assertEqual(result['state'],'confirmed');self.assertTrue(result['nonceFinalized']);self.assertFalse(result['retryAllowed'])
        receipt=result['receipt']
        self.assertEqual(receipt['gas'],{'gasUsedRaw':'100000','effectiveGasPriceRaw':'100','grossGasFeeRaw':'10000000',
            'l1GasUsedRaw':'10000','l1FeeRaw':'1000000','totalFeeRaw':None,'totalFeeStatus':'net_fee_unavailable'})
        self.assertEqual(receipt['mint']['tokenId'],'7');self.assertEqual(receipt['mint']['tokens'][0]['depositedRaw'],'100')
        self.assertEqual(receipt['mint']['tokens'][1]['depositedRaw'],'200')
        self.assertEqual(receipt['finality']['status'],'finalized');self.assertFalse(receipt['finality']['absoluteFinalityProven'])
        self.assertEqual(receipt_summary(result)['position']['recipient'],OWNER)
        self.assertTrue(all(method not in ('eth_sendTransaction','eth_sendRawTransaction','personal_sign') for method,_ in rpc.calls))

    def test_confirmation_count_alone_never_releases_nonce(self):
        for finalized,reason in [(MINED-1,'finality_pending'),(None,'finality_unavailable')]:
            rpc=Rpc();rpc.finalized=finalized;result=reconcile(rpc)
            self.assertEqual((result['state'],result['reason']),('pending',reason));self.assertFalse(result['nonceFinalized'])
            self.assertGreater(result['receipt']['finality']['confirmations'],1)

    def test_reverted_waits_for_finality_and_has_no_mint(self):
        rpc=Rpc();rpc.receipt.update(status='0x0',logs=[])
        self.assertEqual(reconcile(rpc)['state'],'reverted');self.assertIsNone(receipt_summary(reconcile(rpc))['position'])
        summary=receipt_summary(reconcile(rpc))
        self.assertEqual((summary['grossGasFeeRaw'],summary['l1FeeRaw']),('10000000','1000000'))
        self.assertIsNone(summary['totalFeeRaw'])
        rpc.finalized=MINED-1;self.assertEqual(reconcile(rpc)['state'],'pending')

    def test_missing_poster_gas_is_unknown_and_explicit_zero_is_preserved(self):
        rpc=Rpc();rpc.receipt.pop('gasUsedForL1')
        summary=receipt_summary(reconcile(rpc))
        self.assertIsNone(summary['l1GasUsedRaw']);self.assertIsNone(summary['l1FeeRaw'])
        self.assertEqual(summary['grossGasFeeRaw'],'10000000');self.assertIsNone(summary['totalFeeRaw'])
        rpc.receipt['gasUsedForL1']='0x0'
        summary=receipt_summary(reconcile(rpc))
        self.assertEqual((summary['l1GasUsedRaw'],summary['l1FeeRaw']),('0','0'))
        self.assertIsNone(summary['totalFeeRaw'])

    def test_unqualified_l1_fee_extension_is_never_added_or_interpreted(self):
        for extension in ('0xa','0x00','invalid',str(2**256),None,False,10,{'fee':'secret'}):
            with self.subTest(extension=extension):
                rpc=Rpc();rpc.receipt['l1Fee']=extension
                summary=receipt_summary(reconcile(rpc))
                self.assertEqual(summary['grossGasFeeRaw'],'10000000')
                self.assertEqual(summary['l1FeeRaw'],'1000000');self.assertIsNone(summary['totalFeeRaw'])
                rpc.receipt.pop('gasUsedForL1')
                self.assertIsNone(receipt_summary(reconcile(rpc))['l1FeeRaw'])
        rpc=Rpc();rpc.receipt.pop('l1Fee')
        self.assertEqual(receipt_summary(reconcile(rpc))['l1FeeRaw'],'1000000')

    def test_poster_gas_must_be_canonical_bounded_rpc_quantity(self):
        for value in (None,False,0,'0','0x','0x00','0X0','0x-1',hex(100001),hex(2**256)):
            with self.subTest(value=value):
                rpc=Rpc();rpc.receipt['gasUsedForL1']=value
                with self.assertRaisesRegex(DataError,'^invalid_deposit_receipt_gas$'):
                    reconcile(rpc)

    def test_fee_projection_preserves_integer_precision_and_effective_price(self):
        rpc=Rpc();price=2**60+1
        rpc.selection['maxFeePerGasRaw']=str(price+100)
        rpc.artifact['transaction']['maxFeePerGasRaw']=str(price+50)
        rpc.transaction['maxFeePerGas']=hex(price+50)
        rpc.receipt['effectiveGasPrice']=hex(price)
        summary=receipt_summary(reconcile(rpc))
        self.assertEqual(summary['grossGasFeeRaw'],str(100000*price))
        self.assertEqual(summary['l1FeeRaw'],str(10000*price))
        self.assertIsNone(summary['totalFeeRaw'])

    def test_public_fee_invariants_reject_net_claims_and_inconsistent_components(self):
        summary=receipt_summary(reconcile(Rpc()))
        for changes in ({'grossGasFeeRaw':'1'},{'grossGasFeeRaw':10000000},{'grossGasFeeRaw':str(2**256)},
                        {'l1GasUsedRaw':'100001','l1FeeRaw':'10000100'},{'l1GasUsedRaw':None},
                        {'l1GasUsedRaw':'00'},{'l1GasUsedRaw':10000},{'l1FeeRaw':'10'},
                        {'l1FeeRaw':None},{'totalFeeRaw':'10000000'},{'totalFeeRaw':'0'},
                        {'executionFeeRaw':'9000000'}):
            with self.subTest(changes=changes),self.assertRaises(ValidationError):
                ReceiptSummary.model_validate({**summary,**changes})

    def test_legacy_stored_receipts_recompute_gross_without_reinterpreting_l1(self):
        outcome=reconcile(Rpc());original=deepcopy(outcome)
        outcome['receipt']['gas']={'gasUsedRaw':'100000','effectiveGasPriceRaw':'100',
            'executionFeeRaw':'999','l1FeeRaw':'10','totalFeeRaw':'10000010',
            'totalFeeStatus':'reported_execution_and_l1'}
        legacy=deepcopy(outcome)
        summary=receipt_summary(outcome)
        self.assertEqual(summary['grossGasFeeRaw'],'10000000')
        self.assertIsNone(summary['l1GasUsedRaw']);self.assertIsNone(summary['l1FeeRaw']);self.assertIsNone(summary['totalFeeRaw'])
        self.assertNotIn('executionFeeRaw',summary);self.assertEqual(outcome,legacy)
        self.assertEqual(summary['position'],receipt_summary(original)['position'])
        for key in ('executionFeeRaw','l1FeeRaw','totalFeeRaw'):outcome['receipt']['gas'].pop(key)
        self.assertEqual(receipt_summary(outcome),summary)

    def test_summary_recomputes_new_components_and_validates_persisted_operands(self):
        outcome=reconcile(Rpc());gas=outcome['receipt']['gas']
        gas.update(grossGasFeeRaw='1',l1FeeRaw='2',totalFeeRaw='3')
        summary=receipt_summary(outcome)
        self.assertEqual((summary['grossGasFeeRaw'],summary['l1FeeRaw']),('10000000','1000000'))
        self.assertIsNone(summary['totalFeeRaw'])
        for field,value in (('gasUsedRaw','01'),('effectiveGasPriceRaw',100),('l1GasUsedRaw','100001'),
                            ('l1GasUsedRaw',False),('effectiveGasPriceRaw',str(2**256-1))):
            invalid=deepcopy(outcome);invalid['receipt']['gas'][field]=value
            with self.subTest(field=field,value=value),self.assertRaises((DataError,ValidationError)):
                receipt_summary(invalid)

    def test_native_net_spend_and_refund_never_use_whole_block_balances(self):
        rpc=Rpc(native=True);result=reconcile(rpc)
        self.assertEqual(result['state'],'confirmed')
        self.assertIsNone(result['receipt']['mint']['tokens'][0]['depositedRaw'])
        self.assertIsNone(result['receipt']['mint']['native']['refundRaw'])
        self.assertIsNone(receipt_summary(result)['position']['amount0Raw'])
        self.assertFalse(any(method=='eth_getBalance' for method,_ in rpc.calls))

    def test_later_transfer_is_separate_from_mint_recipient(self):
        rpc=Rpc();rpc.current_owner=OTHER;result=reconcile(rpc)
        self.assertEqual(result['state'],'confirmed')
        self.assertEqual(result['receipt']['mint']['mintRecipient'],OWNER)
        self.assertEqual(receipt_summary(result)['position']['currentOwner'],OTHER)
        rpc.fail_current=True;result=reconcile(rpc)
        self.assertEqual(result['state'],'confirmed');self.assertIsNone(receipt_summary(result)['position']['currentOwner'])

    def test_missing_receipt_block_nft_state_does_not_claim_success(self):
        rpc=Rpc();rpc.fail_receipt_state=True;result=reconcile(rpc)
        self.assertEqual((result['state'],result['reason']),('pending','mint_state_unavailable'))
        self.assertTrue(result['nonceFinalized']);self.assertIsNone(result['receipt']['mint'])

    def test_approvals_require_exact_separate_events(self):
        for kind in ('erc20_reset','erc20_approval','permit2_approval'):
            with self.subTest(kind=kind):
                rpc=Rpc(kind=kind);result=reconcile(rpc)
                self.assertEqual(result['state'],'confirmed');self.assertIsNone(result['receipt']['mint'])
                self.assertIsNone(result['receipt']['approval']['allowanceCurrentlyUsable'])
                rpc.receipt['logs'][0]['data']='0x'+encode(['uint256'],[999]).hex()
                self.assertEqual(reconcile(rpc)['state'],'mismatched')

    def test_unreported_hash_is_found_by_bounded_owner_nonce_scan(self):
        rpc=Rpc();result=ReceiptReconciler(rpc).reconcile(OWNER,rpc.selection,rpc.artifact)
        self.assertEqual(result['transactionHash'],HASH);self.assertEqual(result['state'],'confirmed')
        self.assertTrue(any(method=='eth_getBlockByNumber' and params[1] for method,params in rpc.calls))

    def test_scan_checkpoints_advance_without_lifetime_indexing(self):
        rpc=Rpc();engine=ReceiptReconciler(rpc,max_blocks=2)
        cursor=None
        for attempt in range(3):
            result=engine.reconcile(OWNER,rpc.selection,rpc.artifact,scan_cursor=cursor)
            if attempt<2:self.assertEqual(result['state'],'pending');self.assertGreater(result['scanCursor']['nextBlock'],SOURCE)
            cursor=result['scanCursor']
        self.assertEqual(result['state'],'confirmed')

    def test_dense_block_partial_cursor_progress_and_reorg_reset(self):
        rpc=Rpc();original=rpc.transaction
        filler=deepcopy(original);filler.update(hash=OTHER_HASH,**{'from':OTHER},nonce='0x0')
        original['transactionIndex']='0x1';rpc.receipt['transactionIndex']='0x1'
        for row in rpc.receipt['logs']:row['transactionIndex']='0x1'
        rpc.blocks[MINED]=[filler,original]
        engine=ReceiptReconciler(rpc,max_transactions=1)
        first=engine.reconcile(OWNER,rpc.selection,rpc.artifact)
        self.assertEqual(first['scanCursor']['nextBlock'],MINED);self.assertEqual(first['scanCursor']['nextTransactionIndex'],1)
        second=engine.reconcile(OWNER,rpc.selection,rpc.artifact,scan_cursor=first['scanCursor'])
        self.assertEqual(second['state'],'confirmed')
        rpc.hash_overrides[MINED]='0x'+'f'*64
        changed=engine.reconcile(OWNER,rpc.selection,rpc.artifact,scan_cursor=first['scanCursor'])
        self.assertEqual(changed['state'],'reorged');self.assertEqual(changed['scanCursor']['nextBlock'],SOURCE)

    def test_known_hash_wrong_owner_cannot_grant_success(self):
        rpc=Rpc();rpc.by_hash[OTHER_HASH]={**rpc.transaction,'hash':OTHER_HASH,'from':OTHER};rpc.blocks={};rpc.nonce=5
        result=ReceiptReconciler(rpc).reconcile(OWNER,rpc.selection,rpc.artifact,known_hashes=[OTHER_HASH])
        self.assertNotEqual(result['state'],'confirmed');self.assertFalse(result['nonceFinalized'])

    def test_pending_missing_and_consumed_unknown_never_enable_retry(self):
        rpc=Rpc();rpc.blocks={};rpc.by_hash={};rpc.nonce=5
        result=ReceiptReconciler(rpc).reconcile(OWNER,rpc.selection,rpc.artifact)
        self.assertFalse(result['retryAllowed']);self.assertEqual(result['reason'],'scan_in_progress')
        result=ReceiptReconciler(rpc).reconcile(OWNER,rpc.selection,rpc.artifact,scan_cursor=result['scanCursor'])
        self.assertEqual(result['state'],'not_found')
        rpc.nonce=6;result=ReceiptReconciler(rpc).reconcile(OWNER,rpc.selection,rpc.artifact)
        self.assertEqual(result['reason'],'nonce_consumed_transaction_unresolved')
        rpc.by_hash={HASH:{**rpc.transaction,'blockHash':None,'blockNumber':None,'transactionIndex':None}};rpc.nonce=5
        self.assertEqual(reconcile(rpc)['reason'],'transaction_pending')

    def test_finalized_gas_only_replacement_records_selected_cap_breaches(self):
        rpc=Rpc();rpc.transaction.update(gas=hex(230000),maxFeePerGas=hex(180),maxPriorityFeePerGas=hex(80))
        result=reconcile(rpc);self.assertEqual(result['state'],'confirmed');self.assertTrue(result['replacement'])
        for field,value,bound in [('gas',300001,'gasLimit'),('maxFeePerGas',201,'maxFeePerGas'),('maxPriorityFeePerGas',101,'maxPriorityFeePerGas')]:
            rpc=Rpc();rpc.transaction[field]=hex(value)
            result=reconcile(rpc);self.assertEqual(result['state'],'confirmed');self.assertFalse(result['retryAllowed'])
            self.assertEqual(result['receipt']['transaction']['selectedLimitsExceeded'],[bound])
            self.assertEqual(receipt_summary(result)['transaction'],result['receipt']['transaction'])

    def test_different_effect_finalized_nonce_is_attention_not_success(self):
        for changes in ({'input':'0x'}, {'to':OTHER}, {'value':'0x1'}, {'type':'0x4','authorizationList':[{}]}, {'accessList':[{}]}):
            with self.subTest(changes=changes):
                rpc=Rpc();rpc.transaction.update(changes);rpc.receipt['to']=rpc.transaction['to']
                result=reconcile(rpc)
                self.assertEqual(result['state'],'mismatched');self.assertTrue(result['nonceFinalized']);self.assertFalse(result['retryAllowed'])

    def test_finalized_self_transfer_is_different_effect_but_gas_only_is_not(self):
        rpc=Rpc();rpc.transaction.update(to=OWNER,input='0x',value='0x0');rpc.receipt.update(to=OWNER,logs=[],gasUsed=hex(21000))
        result=reconcile(rpc)
        self.assertEqual(result['state'],'mismatched');self.assertTrue(result['replacement'])
        self.assertTrue(result['differentEffect']);self.assertTrue(result['nonceFinalized']);self.assertFalse(result['retryAllowed']);self.assertTrue(result['cancellation'])
        rpc=Rpc();rpc.transaction['maxFeePerGas']=hex(201);result=reconcile(rpc)
        self.assertEqual(result['state'],'confirmed');self.assertTrue(result['replacement'])
        self.assertFalse(result['differentEffect'])

    def test_delegated_or_nontrivial_self_call_never_proves_cancellation(self):
        for gas, code in [(21001,'0x'),(21000,'0xef0100'+'11'*20)]:
            rpc=Rpc();rpc.transaction.update(to=OWNER,input='0x',value='0x0');rpc.receipt.update(to=OWNER,logs=[],gasUsed=hex(gas))
            original=rpc.request
            def request(method,params):return code if method=='eth_getCode' else original(method,params)
            rpc.request=request
            result=reconcile(rpc)
            self.assertTrue(result['differentEffect']);self.assertFalse(result['cancellation'])

    def test_transaction_mining_after_observed_head_is_pending_not_reorg(self):
        rpc=Rpc();rpc.head=MINED-1
        result=reconcile(rpc)
        self.assertEqual(result['state'],'pending');self.assertFalse(result['reorgDetected'])

    def test_receipt_or_nft_or_transfer_substitution_fails_closed(self):
        for mutation in ('receipt_owner','receipt_status','nft_owner','salt','token_recipient','token_cap','no_transfer','pool','duplicate_log','removed','nft_state'):
            with self.subTest(mutation=mutation):
                rpc=Rpc()
                if mutation=='receipt_owner':rpc.receipt['from']=OTHER
                if mutation=='receipt_status':rpc.receipt['status']='0x2'
                if mutation=='nft_owner':rpc.receipt['logs'][0]['topics'][2]=topic_address(OTHER)
                if mutation=='salt':rpc.receipt['logs'][1]['data']='0x'+encode(['int24','int24','int256','bytes32'],[-120,180,12345,(8).to_bytes(32,'big')]).hex()
                if mutation=='token_recipient':rpc.receipt['logs'][2]['topics'][2]=topic_address(OTHER)
                if mutation=='token_cap':rpc.receipt['logs'][2]['data']='0x'+encode(['uint256'],[102]).hex()
                if mutation=='no_transfer':rpc.receipt['logs']=rpc.receipt['logs'][:2]
                if mutation=='pool':rpc.receipt['logs'][1]['topics'][1]='0x'+'f'*64
                if mutation=='duplicate_log':rpc.receipt['logs'].append(deepcopy(rpc.receipt['logs'][-1]))
                if mutation=='removed':rpc.receipt['logs'][0]['removed']=True
                if mutation=='nft_state':rpc.bad_nft=True
                try:result=reconcile(rpc)
                except DataError:continue
                self.assertEqual(result['state'],'mismatched')

    def test_canonicality_changes_invalidate_old_or_inflight_confirmation(self):
        rpc=Rpc();old=reconcile(rpc)['receipt'];rpc.hash_overrides[MINED]='0x'+'f'*64;rpc.by_hash={};rpc.blocks={};rpc.nonce=5
        result=ReceiptReconciler(rpc).reconcile(OWNER,rpc.selection,rpc.artifact,previous_receipt=old)
        self.assertEqual(result['state'],'reorged');self.assertTrue(result['reorgDetected']);self.assertFalse(result['nonceFinalized'])
        rpc=Rpc();rpc.change_on_read[MINED]=3
        result=reconcile(rpc);self.assertEqual(result['state'],'reorged');self.assertIsNone(result['receipt'])

    def test_chain_height_rollback_invalidates_prior_confirmation_and_cursor(self):
        rpc=Rpc();old=reconcile(rpc)['receipt'];rpc.head=MINED-1;rpc.blocks={};rpc.by_hash={};rpc.nonce=5
        result=ReceiptReconciler(rpc).reconcile(OWNER,rpc.selection,rpc.artifact,previous_receipt=old,
            scan_cursor={'nextBlock':HEAD+1,'nextTransactionIndex':0,'partialBlockHash':None,'previousBlockHash':block_hash(HEAD),'sourceBlockHash':block_hash(SOURCE)})
        self.assertEqual(result['state'],'reorged');self.assertTrue(result['reorgDetected']);self.assertFalse(result['nonceFinalized'])
        rpc=Rpc();rpc.head=SOURCE-1
        result=reconcile(rpc)
        self.assertEqual(result['state'],'reorged');self.assertIsNone(result['scanCursor'])

    def test_stale_known_hash_does_not_prevent_scanning_replacement(self):
        rpc=Rpc();stale=deepcopy(rpc.transaction);stale['blockHash']='0x'+'f'*64
        rpc.by_hash={OTHER_HASH:{**stale,'hash':OTHER_HASH}}
        result=ReceiptReconciler(rpc).reconcile(OWNER,rpc.selection,rpc.artifact,known_hashes=[OTHER_HASH])
        self.assertEqual(result['state'],'confirmed');self.assertTrue(result['reorgDetected'])

    def test_transaction_must_exist_in_canonical_block_and_gas_is_bounded(self):
        for mutation in ('membership','gas','price','l1','hash'):
            rpc=Rpc()
            if mutation=='membership':rpc.blocks[MINED]=[]
            if mutation=='gas':rpc.receipt['gasUsed']=hex(220001)
            if mutation=='price':rpc.receipt['effectiveGasPrice']=hex(151)
            if mutation=='l1':rpc.receipt['gasUsedForL1']='0x00'
            if mutation=='hash':rpc.by_hash[HASH]['hash']=OTHER_HASH
            with self.subTest(mutation=mutation),self.assertRaises(DataError):reconcile(rpc)

    def test_persisted_artifact_revalidation_decodes_effect_not_just_shape(self):
        rpc=Rpc();self.assertEqual(validate_issued_artifact(OWNER,rpc.selection,rpc.artifact),rpc.artifact)
        for field,value in [('data','0x095ea7b3'),('from',OTHER),('valueRaw','1'),('gasLimitRaw','300001')]:
            bad=deepcopy(rpc.artifact);bad['transaction'][field]=value
            with self.subTest(field=field),self.assertRaisesRegex(DataError,'invalid_deposit_receipt_context'):
                validate_issued_artifact(OWNER,rpc.selection,bad)
        self.assertFalse(rpc.calls)

    def test_bounded_hash_cursor_logs_rpc_and_deadline(self):
        rpc=Rpc()
        with self.assertRaises(DataError):ReceiptReconciler(rpc).reconcile(OWNER,rpc.selection,rpc.artifact,known_hashes=[HASH]*9)
        rpc.receipt['logs']*=100
        with self.assertRaises(DataError):reconcile(rpc)
        rpc=Rpc();rpc.blocks={};rpc.by_hash={}
        with self.assertRaises(DataError):ReceiptReconciler(rpc).reconcile(OWNER,rpc.selection,rpc.artifact,scan_cursor={'nextBlock':-1})
        rpc=Rpc();now=[0]
        original=rpc.request
        def slow(method,params):
            value=original(method,params);now[0]+=16;return value
        with patch('read_deadline.time.monotonic',lambda:now[0]),self.assertRaises(DataError):
            ReceiptReconciler(slow).reconcile(OWNER,rpc.selection,rpc.artifact,known_hashes=[HASH])


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1', 'requires isolated local Anvil receipt oracle')
class DepositReceiptEvmTests(unittest.TestCase):
    """A real local EIP-1559 approval/receipt, not a Robinhood fork or broadcast."""
    @classmethod
    def setUpClass(cls):
        root=Path(__file__).resolve().parents[2]
        source = """// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
contract StandardApprovalReceipt {
    event Approval(address indexed owner, address indexed spender, uint256 value);
    function approve(address spender, uint256 amount) external returns (bool) {
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}
"""
        payload={'language':'Solidity','sources':{'Approval.sol':{'content':source}},'settings':{
            'evmVersion':'cancun','outputSelection':{'Approval.sol':{'StandardApprovalReceipt':['evm.deployedBytecode.object']}}}}
        compiled=subprocess.run(['node',str(root/'scripts/solc-compile.cjs')],input=json.dumps(payload),text=True,
                                capture_output=True,timeout=30,check=True)
        parsed=json.loads(compiled.stdout)
        errors=[entry['message'] for entry in parsed.get('errors',[]) if entry['severity']=='error']
        if errors:raise AssertionError(errors)
        code=parsed['contracts']['Approval.sol']['StandardApprovalReceipt']['evm']['deployedBytecode']['object']
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        cls.url=f'http://127.0.0.1:{port}'
        cls.process=subprocess.Popen([str(root/'node_modules/.bin/anvil'),'--host','127.0.0.1',
                                      '--port',str(port),'--chain-id',str(CHAIN_ID),'--silent'],
                                     stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        cls.addClassCleanup(cls.stop)
        for _ in range(100):
            try:
                if cls.rpc('eth_chainId',[])!=hex(CHAIN_ID):raise AssertionError('isolated chain mismatch')
                break
            except OSError:time.sleep(.02)
        else:raise AssertionError('isolated test node unavailable')
        cls.rpc('anvil_setCode',[TOKEN1,'0x'+code])

    @classmethod
    def stop(cls):
        cls.process.terminate();cls.process.wait(timeout=10)

    @classmethod
    def rpc(cls,method,params):
        request=urllib.request.Request(cls.url,json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode(),
                                       {'Content-Type':'application/json'})
        # Test writes are confined to the fresh loopback process above.
        with urllib.request.urlopen(request,timeout=5) as response:payload=json.load(response)
        if 'error' in payload:raise DataError('local_evm_rpc_error')
        return payload['result']

    def test_actual_local_approval_transaction_event_and_gas(self):
        owner=self.rpc('eth_accounts',[])[0]
        source=self.rpc('eth_getBlockByNumber',['latest',False])
        selection,artifact=context(kind='erc20_approval')
        selection.update(maxGasLimitRaw='300000',maxFeePerGasRaw='3000000000',maxPriorityFeePerGasRaw='1000000000')
        tx=artifact['transaction']
        tx.update({'from':owner,'nonceRaw':str(int(self.rpc('eth_getTransactionCount',[owner,'latest']),16)),
                   'maxFeePerGasRaw':'2000000000','maxPriorityFeePerGasRaw':'1000000000'})
        block={'number':int(source['number'],16),'hash':source['hash'],'timestamp':int(source['timestamp'],16)}
        artifact.update(sourceBlock=block,expiresAt=block['timestamp']+30,preparedDeadline=block['timestamp']+120,
                        simulation={'status':'passed','estimatedGasRaw':'200000','blockNumber':block['number'],'blockHash':block['hash']})
        transaction={'from':owner,'to':TOKEN1,'data':tx['data'],'value':'0x0','gas':hex(int(tx['gasLimitRaw'])),
            'maxFeePerGas':hex(int(tx['maxFeePerGasRaw'])),'maxPriorityFeePerGas':hex(int(tx['maxPriorityFeePerGasRaw'])),
            'nonce':hex(int(tx['nonceRaw'])),'chainId':hex(CHAIN_ID),'type':'0x2','accessList':[]}
        digest=self.rpc('eth_sendTransaction',[transaction])
        for _ in range(100):
            raw=self.rpc('eth_getTransactionReceipt',[digest])
            if raw is not None and int(self.rpc('eth_getBlockByNumber',['latest',False])['number'],16) >= int(raw['blockNumber'],16): break
            time.sleep(.01)
        else: self.fail('local receipt unavailable')
        result=ReceiptReconciler(self.rpc).reconcile(owner,selection,artifact,known_hashes=[digest])
        self.assertIn(result['state'],('pending','confirmed'),repr(result))
        self.assertEqual(result['receipt']['approval']['amountRaw'],'202')
        self.assertEqual(result['receipt']['transactionHash'],digest)
        self.assertEqual(int(result['receipt']['gas']['grossGasFeeRaw']),int(raw['gasUsed'],16)*int(raw['effectiveGasPrice'],16))
        self.assertIsNone(result['receipt']['gas']['l1GasUsedRaw'])
        self.assertIsNone(result['receipt']['gas']['l1FeeRaw'])
        self.assertIsNone(result['receipt']['gas']['totalFeeRaw'])
        self.assertFalse(result['retryAllowed'])


if __name__=='__main__':unittest.main()
