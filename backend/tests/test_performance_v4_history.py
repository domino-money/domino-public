"""Synthetic canonical event binding; actual V4 execution has separate EVM tests."""
from copy import deepcopy
from pathlib import Path
import sys
import unittest

from eth_abi import encode
from eth_hash.auto import keccak

sys.path[:0]=[str(Path(__file__).resolve().parents[1]),str(Path(__file__).resolve().parent)]
import execution_v4 as v4
import general_compound_receipts as g
import performance_v4_history as adapter
from performance_collection import CanonicalCollector,CollectionError
from performance_financial_collection import FinancialCollector,FinancialPoint,REGISTERED
from performance_history import open_history,reduce_history
from test_performance_collection import OWNER,VAULT,CODE_HASH,EXECUTION_ENGINE,TOKEN,hash_,topic,transfer_log
from test_performance_financial_collection import FinancialRpc,pool_log,MODIFY
from discovery import ZERO


def fixture(*,swap=False):
    rpc=FinancialRpc(); rpc.version=4
    raw=CanonicalCollector(rpc); financial=FinancialCollector(rpc)
    base=raw.capture(OWNER,VAULT,['1'],CODE_HASH)
    opening=financial.capture_point(base,base.baseline)
    authority=g.CompoundPlan(intentId=hash_(777),tokenId='1',positionIdentity=hash_(92),checkpointId=hash_(91),
        policyVersion='1',limitsVersion='1',stateNonce='0',authorityGeneration='1',observedAtBlock='10',
        observedBlockHash=hash_(10),observedAtTimestamp='1010',deadline='1070',liquidityIncrease='100',
        maxOriginal0='0',maxOriginal1='0',maxCharged0='0',maxCharged1='0',minAdded0='98',minAdded1='0',
        minSqrtPriceX96=str((1<<96)-1),maxSqrtPriceX96=str((1<<96)+1))
    plan=v4.Plan(authority=authority,action=3,destinationTokenId='0',tickLower=-60,tickUpper=60,
        collect=(v4.PositionRef(tokenId='1',positionIdentity=hash_(92),checkpointId=hash_(91)),),
        budgets=tuple([v4.FeeBudget(sourceId=hash_(93),currency=ZERO,maxOriginal='120' if swap else '100',maxCharged='0',minOriginal='0',minCharged='0')]+
            ([v4.FeeBudget(sourceId=hash_(93),currency=TOKEN,maxOriginal='0',maxCharged='18',minOriginal='0',minCharged='0')] if swap else [])),
        swap=v4.SwapPlan(sourceId=hash_(93) if swap else v4.ZERO_ID,currencyIn=ZERO,amountIn='20' if swap else '0',
            maxOriginal='20' if swap else '0',maxCharged='0',minAmountOut='18' if swap else '0',
            sqrtPriceLimitX96=str((1<<96)-1) if swap else '0',priceObservationId=hash_(999)))
    digest='0x'+keccak(encode(['bytes32','uint256','address','bytes32',v4.PLAN_TYPE],
        [keccak(b'DominoExecutionV4'),4663,VAULT,bytes.fromhex(base.opening.sequenceIdentity[2:]),plan.values()])).hex()
    logs=[]
    def emit(address,topics,types=(),values=()):
        ordinal=len(logs)
        logs.append({'address':address,'topics':topics,'data':'0x'+encode(types,values).hex()})
        return ordinal
    logs.append(pool_log())
    realized=emit(EXECUTION_ENGINE,[g.REALIZED,topic(VAULT),authority.intentId,hash_(1)],
        ['bytes32','bytes32','uint128','uint128'],[bytes.fromhex(hash_(901)[2:]),bytes.fromhex(hash_(902)[2:]),599,0])
    conversions=[]
    def amount_dict(values): return {name+'Raw':str(value) for name,value in zip(adapter.AMOUNT_NAMES,values)}
    if swap:
        values=[604,2,0,20,0,0,20,584,2]
        ordinal=emit(EXECUTION_ENGINE,[adapter.CONVERTED,topic(VAULT),authority.intentId,hash_(93)],
            ['address','address','uint128','uint128',g.AMOUNTS_TYPE,'uint128','uint128'],[ZERO,TOKEN,20,18,values,0,18])
        conversions=[{'sourceId':hash_(93),'sourceTokenId':'1','currencyIn':ZERO,'currencyOut':TOKEN,
            'amountInRaw':'20','amountOutRaw':'18','chargedOutputBeforeRaw':'0','chargedOutputAfterRaw':'18',
            'inputAmounts':amount_dict(values),'receiptLogIndex':ordinal}]
    emit(VAULT,[REGISTERED,hash_(2),hash_(192)],['bytes32','bytes32','uint64'],
        [bytes.fromhex(hash_(193)[2:]),bytes.fromhex(hash_(194)[2:]),0])
    logs.append(transfer_log(ZERO,VAULT,2))
    emit(VAULT,[adapter.SUCCESSOR,authority.intentId,hash_(1),hash_(2)])
    logs.append(pool_log(MODIFY,token=1)); logs.append(pool_log(MODIFY,token=2))
    values=[584 if swap else 604,2,0,100,0,2,98,484 if swap else 504,2]
    ordinal=emit(EXECUTION_ENGINE,[adapter.APPLIED,topic(VAULT),authority.intentId,hash_(93)],
        ['address','uint256',g.AMOUNTS_TYPE],[ZERO,2,values])
    applications=[{'sourceId':hash_(93),'sourceTokenId':'1','currency':ZERO,'destinationTokenId':'2',
                   'receiptLogIndex':ordinal,**amount_dict(values)}]
    if swap:
        values=[0,18,0,0,18,0,18,0,0]
        ordinal=emit(EXECUTION_ENGINE,[adapter.APPLIED,topic(VAULT),authority.intentId,hash_(93)],
            ['address','uint256',g.AMOUNTS_TYPE],[TOKEN,2,values])
        applications.append({'sourceId':hash_(93),'sourceTokenId':'1','currency':TOKEN,'destinationTokenId':'2',
                             'receiptLogIndex':ordinal,**amount_dict(values)})
    emit(VAULT,[adapter.COMPLETED,authority.intentId,digest],['uint8','uint256','uint256','uint64'],[3,1,2,1])
    tx=rpc.add_transaction(logs=logs); rpc.transactions[tx]['input']=plan.calldata()
    rpc.second_member_at=11; rpc.finalized=11
    page=financial.capture_points(base,raw.collect(base,base.baseline))
    point=page.points[0].model_dump()
    for member in point['members']:
        member['unsettledFeesRaw']=['0','0']
        member['lastGrowthX128']=member['insideGrowthX128']
        if member['tokenId']=='2': member['liquidityRaw']='100'; member['principalRaw']=['98','18' if swap else '0']
    held=509 if swap else 529; accounted=486 if swap else 506
    point.update(nativeHeldRaw=str(held),nativeSurplusRaw='23',heldRaw=[str(held),'20'],
                 accountedRaw=[str(accounted),'7'],unattributedAccountedRaw=['0','0'])
    for source in point['sources']:
        source['originalRaw']=source['chargedRaw']='0'
        if source['tokenId']=='1' and source['sourceId']==hash_(93) and source['currency']==ZERO:
            source['originalRaw']=str(accounted-2); source['chargedRaw']='2'
        if source['tokenId']=='1' and source['sourceId']==hash_(94) and source['currency']==TOKEN:
            source['originalRaw']='5'; source['chargedRaw']='2'
    page.points[0]=FinancialPoint.model_validate(point)
    report={'transactionHash':tx,'block':{'hash':hash_(11),'number':11,'timestamp':1011},'canonical':True,'finalized':True,
        'intentId':authority.intentId,'planHash':digest,'action':3,'parentTokenId':'1','destinationTokenId':'2',
        'liquidityIncreaseRaw':'100','applications':applications,'conversions':conversions,
        'realizations':[{'tokenId':'1','checkpointBefore':hash_(901),'checkpointAfter':hash_(902),
                         'amount0Raw':'599','amount1Raw':'0','receiptLogIndex':realized}]}
    return base,open_history(base,opening),page,report,plan


class V4HistoryTests(unittest.TestCase):
    def test_canonical_dynamic_calldata_is_distinct_from_v3(self):
        *_,plan=fixture()
        self.assertEqual(adapter.decode_plan(plan.calldata()),plan)
        for data in (plan.authority.calldata(),plan.calldata()+'00',plan.calldata()[:20],'0x'+'00'*20000):
            with self.assertRaises(CollectionError): adapter.decode_plan(data)

    def test_created_successor_is_internal_capital_and_collection_keeps_its_origin(self):
        base,state,page,report,_=fixture()
        after,delta=reduce_history(base,state,page,[report]); row=delta['slices'][0]
        self.assertTrue(row['incomeComplete'],row['issues'])
        self.assertEqual(row['credits'][0]['raw'],'99')
        self.assertEqual(row['credits'][0]['tokenId'],'1')
        self.assertEqual(after.cumulativeKnown['realized'][ZERO],'599')
        self.assertEqual(after.cumulativeKnown['serviceFees'][ZERO],'2')
        self.assertEqual(after.cumulativeKnown['reinvested'][ZERO],'98')
        self.assertEqual(row['externalFlows'],[])
        self.assertEqual({member.tokenId for member in after.members},{'1','2'})
        self.assertEqual(row['reinvestments'][0]['tokenId'],'1')
        self.assertEqual({component['tokenId'] for component in row['capital']},{'1',None})

    def test_conversion_keeps_source_and_does_not_become_income_or_double_reinvestment(self):
        base,state,page,report,_=fixture(swap=True)
        after,delta=reduce_history(base,state,page,[report]); row=delta['slices'][0]
        self.assertTrue(row['incomeComplete'],row['issues'])
        self.assertEqual(after.cumulativeKnown['tradingAccrual'],{ZERO:'99'})
        self.assertEqual(after.cumulativeKnown['realized'],{ZERO:'599',TOKEN:'0'})
        self.assertEqual(after.cumulativeKnown['serviceFees'],{ZERO:'2',TOKEN:'0'})
        self.assertEqual(after.cumulativeKnown['reinvested'],{ZERO:'98',TOKEN:'18'})
        self.assertEqual([change['kind'] for change in row['changes']],['position_entered','fee_reserves_converted'])

    def test_missing_or_changed_effects_cannot_claim_complete_history(self):
        base,state,page,report,_=fixture()
        _,missing=reduce_history(base,state,page,[])
        self.assertFalse(missing['slices'][0]['incomeComplete'])
        self.assertEqual(missing['slices'][0]['credits'],[])
        for key,value in (('sourceTokenId','2'),('serviceFeeRaw','3'),('receiptLogIndex',0)):
            changed=deepcopy(report); changed['applications'][0][key]=value
            with self.assertRaisesRegex(ValueError,'history_v4_effect_mismatch'):
                reduce_history(base,state,page,[changed])
        changed=deepcopy(report); changed['planHash']=hash_(99)
        with self.assertRaisesRegex(ValueError,'history_v4_completion_mismatch'):
            reduce_history(base,state,page,[changed])


if __name__=='__main__': unittest.main()
