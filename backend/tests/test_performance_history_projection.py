"""Conditional projections of synthetic journal facts; no live qualification."""
from copy import deepcopy
from fractions import Fraction
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
import managed_performance as calculator
import performance_history_projection as p
import price_history as ph
from performance_collection import CanonicalCollector, Cursor
from performance_financial_collection import FinancialCollector, FinancialPoint
from performance_history import open_history, reduce_history
from performance_valuation import load_managed_valuation
from read_deadline import read_deadline
from test_performance_financial_collection import FinancialRpc, pool_log
from test_performance_collection import OWNER, VAULT, CODE_HASH, TOKEN, hash_
from test_performance_valuation import connection, rows
from discovery import DataError, ZERO


def fixture(*, duration=86400, same_second=False):
    rpc = FinancialRpc()
    base = CanonicalCollector(rpc).capture(OWNER,VAULT,['1'],CODE_HASH)
    opening = FinancialCollector(rpc).capture_point(base,base.baseline)
    start = base.baseline.timestamp
    opening = opening.model_dump()
    opening.update(heldRaw=['0','0'],accountedRaw=['0','0'],nativeHeldRaw='0',nativeSurplusRaw='0',unattributedAccountedRaw=['0','0'])
    opening['members'][0].update(principalRaw=['510','0'],unsettledFeesRaw=['490','0'])
    for source in opening['sources']: source.update(originalRaw='0',chargedRaw='0')
    baseline = base.model_dump()
    baseline['opening'].update(heldRaw=['0','0'],accountedRaw=['0','0'],nativeHeldRaw='0')
    baseline['opening']['members'][0].update(principalRaw=['510','0'],unsettledFeesRaw=['490','0'])
    state = open_history(baseline,opening).model_dump()
    cursor = {'blockNumber':11,'blockHash':hash_(11),'parentHash':hash_(10),'timestamp':start if same_second else start+duration}
    point = deepcopy(opening)
    point['block'] = cursor
    point.update(heldRaw=['449','2'],accountedRaw=['449','0'],nativeHeldRaw='449',nativeSurplusRaw='0')
    point['members'][0].update(principalRaw=['560','0'],unsettledFeesRaw=['0','0'])
    state.update(cursor=cursor,lastPoint=point)
    common = {'tokenId':'1','currency':ZERO,'timestamp':cursor['timestamp'],'blockNumber':11}
    source = {**common,'sourceId':opening['members'][0]['source0'],'transactionHash':hash_(1100)}
    part = {'from':baseline['baseline'],'through':cursor,'incomeComplete':True,'issues':[],
        'capitalComplete':True,'capital':[{'tokenId':'1','amountsRaw':{ZERO:'1000',TOKEN:'0'}},
                                         {'tokenId':None,'amountsRaw':{ZERO:'0',TOKEN:'0'}}],
        'credits':[{**common,'eventId':hash_(700),'feeOriginId':hash_(700),'raw':'10','kind':'new_trading_fee'}],
        'serviceDebits':[{**source,'eventId':hash_(701),'raw':'1','kind':'service_fee','payer':'strategy'}],
        'realizations':[{**source,'raw':'500','kind':'realized_accrual'}],
        'reinvestments':[{**source,'raw':'50','kind':'reinvestment'}],
        'externalFlows':[{'eventId':hash_(702),'transactionHash':hash_(1101),'tokenId':None,'currency':TOKEN,
            'timestamp':cursor['timestamp'],'blockNumber':11,'raw':'3','kind':'external_deposit'},
            {'eventId':hash_(703),'transactionHash':hash_(1102),'tokenId':None,'currency':TOKEN,
             'timestamp':cursor['timestamp'],'blockNumber':11,'raw':'1','kind':'external_withdrawal'}],
        'changes':[],'unclassifiedAccrual':[],
        'gasEvidence':[{'transactionHash':hash_(1100),'payer':OWNER,'gasUsedRaw':'21000','effectiveGasPriceRaw':'1000000000',
                        'receiptGasProductWei':'21000000000000','fullL2CostWei':None,'strategyDebitApplied':False}]}
    delta = {'methodologyVersion':1,'replayGeneration':1,'owner':OWNER,'epochId':base.epochId,'vault':VAULT,
             'fromCursor':baseline['baseline'],'throughCursor':cursor,'slices':[part]}
    epoch = {'owner':OWNER,'epochId':base.epochId,'baseline':baseline,'cursor':cursor,'revision':2,
        'replayGeneration':1,'status':'active','lastError':None,'pageCount':1,'receiptCount':3,'eventCount':6,
        'createdAt':start,'updatedAt':cursor['timestamp']}
    head = {'owner':OWNER,'epochId':base.epochId,'replayGeneration':1,'revision':2,'rawRevision':2,
            'cursor':cursor,'opening':opening,'state':state,'lastError':None,'updatedAt':cursor['timestamp']}
    return json.loads(json.dumps({'epoch':epoch,'financial':head,'deltas':[delta]}))


def append_interval(bundle,duration,*,capital_raw='1000'):
    """Append a separately persisted, synthetic block with unique known facts."""
    previous=deepcopy(bundle['financial']['cursor'])
    block=previous['blockNumber']+1
    cursor={'blockNumber':block,'blockHash':hash_(block),'parentHash':previous['blockHash'],
            'timestamp':previous['timestamp']+duration}
    part=deepcopy(bundle['deltas'][-1]['slices'][-1])
    part.update(**{'from':previous,'through':cursor,'incomeComplete':True,'issues':[],'unclassifiedAccrual':[]})
    part['capital'][0]['amountsRaw'][ZERO]=capital_raw
    for field in ('credits','serviceDebits','realizations','reinvestments','externalFlows'):
        for row in part[field]:
            row.update(timestamp=cursor['timestamp'],blockNumber=block)
            for identity in ('eventId','feeOriginId','transactionHash'):
                if identity in row: row[identity]=hash_(int(row[identity],16)+10000)
    for gas in part['gasEvidence']: gas['transactionHash']=hash_(int(gas['transactionHash'],16)+10000)
    bundle['deltas'].append({**deepcopy(bundle['deltas'][-1]),'fromCursor':previous,
                            'throughCursor':deepcopy(cursor),'slices':[part]})
    for record in (bundle['epoch'],bundle['financial'],bundle['financial']['state']): record['cursor']=deepcopy(cursor)
    bundle['financial']['state']['lastPoint']['block']=deepcopy(cursor)
    return part


class FinancialHistoryProjectionTests(unittest.TestCase):
    def setUp(self):
        self.registry = patch.dict(ph.PRODUCTION_QUALIFICATIONS,{},clear=True)
        self.registry.start()
        self.addCleanup(self.registry.stop)

    def value(self,bundle,*,qualified=True,prices=None,decimals=0):
        baseline = bundle['epoch']['baseline']
        head = bundle['financial']
        start = max(baseline['baseline']['timestamp'],head['cursor']['timestamp']-86400)
        end = head['cursor']['timestamp']
        currencies = sorted(set(baseline['opening']['currencies']+[ZERO]))
        samples = []
        for currency in currencies:
            if qualified:
                ph.PRODUCTION_QUALIFICATIONS[(baseline['opening']['poolId'],currency)] = ph.PriceQualification(
                    currency,decimals,ph.SOURCE,baseline['opening']['poolId'],'synthetic_projection_only')
            points = prices.get(currency) if prices and currency in prices else [(t,'1') for t in range(start,end+1,300)]+[(end,'1')]
            samples.extend(rows(currency,points))
        return load_managed_valuation(connection(samples),pool_id=baseline['opening']['poolId'],
            currencies=currencies,start=start,end=end)

    def run_projection(self,bundle,**kwargs):
        valuation = self.value(bundle,**kwargs)
        return p.build_financial_projection(bundle,valuation,bundle['epoch']['cursor']['timestamp'])

    def test_complete_day_produces_actual_fee_metrics_and_named_flows_without_gas_double_debit(self):
        bundle = fixture()
        original = deepcopy(bundle)
        result = self.run_projection(bundle)
        performance = result['performance']
        self.assertEqual(performance['status'],'available')
        self.assertEqual(performance['newTradingFeesUsd'],'10.000000000000000000')
        self.assertEqual(performance['actualServiceFeesUsd'],'1.000000000000000000')
        self.assertEqual(performance['netFeeIncomeUsd'],'9.000000000000000000')
        self.assertEqual(performance['timeWeightedCapitalUsd'],'1000.000000000000000000')
        self.assertEqual(performance['netFeeAprPercent'],'328.500000000000000000')
        self.assertEqual((result['externalDepositsUsd'],result['externalWithdrawalsUsd'],result['reinvestedUsd']),(None,None,'50'))
        self.assertEqual(result['knownFacts']['knownValuedTotalsUsd']['externalDepositsUsd'],'3')
        self.assertEqual(result['knownFacts']['knownValuedTotalsUsd']['externalWithdrawalsUsd'],'1')
        self.assertEqual(result['externalFlowCoverage'],{'complete':False,'reasons':['native_gross_flows_unavailable']})
        self.assertEqual(result['knownFacts']['rawTotals']['realized'][ZERO],'500')
        self.assertIsNone(performance['operatorCostsUsd'])
        self.assertEqual(performance['operatorCostsReason'],'full_l2_cost_unqualified')
        self.assertFalse(result['executionAvailable'])
        self.assertEqual(bundle,original)

    def test_new_fees_at_later_block_in_opening_second_are_not_opening_income(self):
        bundle = fixture(same_second=True)
        result = self.run_projection(bundle)
        self.assertEqual(result['performance']['newTradingFeesUsd'],'10.000000000000000000')
        self.assertEqual(result['performance']['actualServiceFeesUsd'],'1.000000000000000000')
        self.assertEqual(result['performance']['observedSeconds'],0)
        self.assertIsNone(result['performance']['netFeeAprPercent'])
        self.assertFalse(result['performance']['complete24h'])

    def test_explicit_complete_external_flow_evidence_enables_independent_exact_totals(self):
        bundle=fixture()
        bundle['deltas'][0]['slices'][0].update(externalFlowsComplete=True,externalFlowsReason=None)
        result=self.run_projection(bundle)
        self.assertEqual((result['externalDepositsUsd'],result['externalWithdrawalsUsd']),('3','1'))
        self.assertEqual(result['externalFlowCoverage'],{'complete':True,'reasons':[]})

    def test_unqualified_price_preserves_raw_facts_and_null_decimals_without_fake_zero(self):
        bundle = fixture()
        result = self.run_projection(bundle,qualified=False)
        self.assertIsNone(result['performance']['newTradingFeesUsd'])
        self.assertIsNone(result['performance']['timeWeightedCapitalUsd'])
        self.assertIsNone(result['performance']['netFeeAprPercent'])
        self.assertIsNone(result['externalDepositsUsd'])
        known = result['knownFacts']['records']['tradingAccrual'][0]
        self.assertEqual(known['raw'],'10')
        self.assertIsNone(known['valuation']['denomination'])
        self.assertIsNone(known['valuation']['valueUsd'])

    def test_price_gap_blocks_capital_apr_but_retains_known_event_value(self):
        bundle = fixture(duration=301)
        start = bundle['epoch']['baseline']['baseline']['timestamp']
        result = self.run_projection(bundle,prices={ZERO:[(start,'1'),(start+301,'2')]})
        self.assertEqual(result['performance']['newTradingFeesUsd'],'20.000000000000000000')
        self.assertIsNone(result['performance']['timeWeightedCapitalUsd'])
        self.assertIsNone(result['performance']['netFeeAprPercent'])
        self.assertIn('qualified_price_coverage_gap',result['projectionIssues'])

    def test_exact_fine_denominations_are_not_rounded_before_apr(self):
        bundle = fixture()
        result = self.run_projection(bundle,decimals=255)
        # Display values round down to zero, but exact fee/capital ratio survives.
        self.assertEqual(result['performance']['timeWeightedCapitalUsd'],'0.000000000000000000')
        self.assertEqual(result['performance']['netFeeAprPercent'],'328.500000000000000000')
        exact = result['knownFacts']['records']['tradingAccrual'][0]['valuation']['valueUsd']
        self.assertEqual(Fraction(exact),Fraction(10,10**255))

    def test_price_and_balance_boundaries_integrate_all_components_exactly_across_pages(self):
        bundle=fixture(duration=40000)
        second=append_interval(bundle,46400,capital_raw='2000')
        second['credits'][0]['raw']='20'
        start=bundle['epoch']['baseline']['baseline']['timestamp']
        prices=[(start+t,'1' if t<20000 else '2') for t in range(0,86401,300)]
        prices.append((start+20000,'2'))
        result=self.run_projection(bundle,prices={ZERO:sorted(prices)})
        performance=result['performance']
        average=Fraction(1000*20000+2000*20000+4000*46400,86400)
        self.assertEqual(performance['timeWeightedCapitalUsd'],calculator._decimal(average))
        self.assertEqual(performance['newTradingFeesUsd'],'60.000000000000000000')
        self.assertEqual(performance['actualServiceFeesUsd'],'4.000000000000000000')
        self.assertEqual(performance['netFeeAprPercent'],calculator._decimal(Fraction(56)*36500/average))

    def test_rolling_window_excludes_old_income_gaps_but_requires_its_entire_capital_interval(self):
        bundle=fixture(duration=1)
        old=bundle['deltas'][0]['slices'][0]
        old.update(incomeComplete=False,issues=['old_incomplete_observation'])
        append_interval(bundle,86400)
        for keep_prefix in (True,False):
            candidate=deepcopy(bundle)
            if not keep_prefix: candidate['deltas']=candidate['deltas'][1:]
            result=self.run_projection(candidate)
            self.assertEqual(result['performance']['status'],'available')
            self.assertEqual(result['performance']['newTradingFeesUsd'],'10.000000000000000000')
            self.assertEqual(result['performance']['timeWeightedCapitalUsd'],'1000.000000000000000000')
            self.assertNotIn('old_incomplete_observation',result['projectionIssues'])
            self.assertEqual(len(result['knownFacts']['records']['tradingAccrual']),1)

    def test_closing_second_keeps_attributed_fee_and_service_before_membership_ends(self):
        bundle=fixture()
        bundle['financial']['state']['members'][0]['endsAt']=bundle['financial']['cursor']['timestamp']
        result=self.run_projection(bundle)
        self.assertEqual(result['performance']['newTradingFeesUsd'],'10.000000000000000000')
        self.assertEqual(result['performance']['actualServiceFeesUsd'],'1.000000000000000000')
        self.assertEqual(result['performance']['timeWeightedCapitalUsd'],'1000.000000000000000000')

    def test_unqualified_capital_or_segment_budget_does_not_erase_dated_reinvestment(self):
        for failure in ('unavailable','budget'):
            bundle=fixture(duration=40000)
            append_interval(bundle,46400,capital_raw='2000')
            if failure=='unavailable': bundle['deltas'][0]['slices'][0]['capitalComplete']=False
            with patch.object(p,'MAX_SEGMENTS',1 if failure=='budget' else 4096):
                result=self.run_projection(bundle)
            self.assertIsNone(result['performance']['netFeeAprPercent'])
            self.assertIsNone(result['performance']['timeWeightedCapitalUsd'])
            self.assertEqual(result['reinvestedUsd'],'100')

    def test_noncontiguous_pages_and_old_or_foreign_members_fail_closed(self):
        for fault in ('page_parent','page_from','fact_after_close','unknown_capital'):
            bundle=fixture(duration=40000)
            second=append_interval(bundle,46400)
            if fault=='page_parent': second['through']['parentHash']=hash_(999)
            if fault=='page_from': bundle['deltas'][1]['fromCursor']['blockHash']=hash_(999)
            if fault=='fact_after_close': bundle['financial']['state']['members'][0]['endsAt']=bundle['deltas'][0]['throughCursor']['timestamp']
            if fault=='unknown_capital': second['capital'][0]['tokenId']='999'
            with self.subTest(fault=fault),self.assertRaises(ValueError): self.run_projection(bundle)

    def test_price_boundary_budget_keeps_known_facts_but_deadline_is_never_swallowed(self):
        bundle=fixture()
        valuation=self.value(bundle)
        with patch.object(valuation,'boundaries',side_effect=DataError('performance_price_boundary_budget_exhausted')):
            result=p.build_financial_projection(bundle,valuation,bundle['epoch']['cursor']['timestamp'])
        self.assertIsNone(result['performance']['timeWeightedCapitalUsd'])
        self.assertEqual(result['reinvestedUsd'],'50')
        with patch.object(valuation,'boundaries',side_effect=DataError('read_deadline_exceeded')):
            with self.assertRaisesRegex(DataError,'read_deadline_exceeded'):
                p.build_financial_projection(bundle,valuation,bundle['epoch']['cursor']['timestamp'])
        clock=[0]
        with self.assertRaisesRegex(DataError,'read_deadline_exceeded'):
            with read_deadline(1,clock=lambda:clock[0]):
                clock[0]=2
                p.build_financial_projection(bundle,valuation,bundle['epoch']['cursor']['timestamp'])

    def test_payload_and_record_budgets_fail_before_computation(self):
        bundle=fixture()
        for bound,value in (('MAX_BYTES',1),('MAX_RECORDS',1)):
            with patch.object(p,bound,value):
                with self.assertRaisesRegex(ValueError,'projection_.*budget'): self.run_projection(bundle)

    def test_partial_income_and_unknown_native_flows_do_not_become_zero_totals(self):
        bundle = fixture()
        part = bundle['deltas'][0]['slices'][0]
        part.update(incomeComplete=False,issues=['native_external_flow_unattributed'],credits=[])
        part['changes']=[{'kind':'native_balance_change_unattributed','tokenId':None,'deltaRaw':'7','timestamp':part['through']['timestamp']}]
        result = self.run_projection(bundle)
        self.assertEqual(result['performance']['status'],'partial')
        self.assertIsNone(result['performance']['newTradingFeesUsd'])
        self.assertIsNone(result['externalDepositsUsd'])
        self.assertEqual(result['knownFacts']['rawTotals']['serviceFees'][ZERO],'1')

    def test_stale_and_read_failed_keep_dated_amounts_without_current_apr(self):
        for kind in ('age','raw_failure','financial_failure','behind'):
            bundle = fixture()
            now = bundle['epoch']['cursor']['timestamp']
            if kind=='raw_failure': bundle['epoch'].update(status='read_failed',lastError='rpc_error')
            if kind=='financial_failure': bundle['financial']['lastError']='rpc_error'
            if kind=='behind':
                bundle['epoch']['cursor']={'blockNumber':12,'blockHash':hash_(12),'parentHash':hash_(11),'timestamp':now+1}
                now += 1
            if kind=='age': now += 121
            value = self.value(bundle)
            result = p.build_financial_projection(bundle,value,now)
            self.assertEqual(result['performance']['newTradingFeesUsd'],'10.000000000000000000')
            self.assertIsNone(result['performance']['netFeeAprPercent'])
            self.assertEqual(result['performance']['status'],'partial' if kind=='behind' else 'stale')

    def test_replay_and_baseline_reorg_do_not_publish_orphan_usd_values(self):
        for status in ('replaying','baseline_reorged'):
            bundle = fixture()
            bundle['epoch'].update(status=status,lastError='chain_reorg')
            result = self.run_projection(bundle)
            self.assertIsNone(result['performance']['netFeeIncomeUsd'])
            self.assertIsNone(result['externalDepositsUsd'])
            self.assertFalse(result['knownFacts']['canonical'])
            self.assertIsNone(result['knownFacts']['records']['tradingAccrual'][0]['valuation']['valueUsd'])

    def test_financial_reorg_invalidates_amounts_before_raw_worker_has_replayed(self):
        for reason in ('financial_reorg_detected','financial_receipt_changed'):
            bundle=fixture()
            bundle['financial']['lastError']=reason
            result=self.run_projection(bundle)
            self.assertEqual(result['performance']['status'],'unavailable')
            self.assertIsNone(result['performance']['newTradingFeesUsd'])
            self.assertIsNone(result['performance']['timeWeightedCapitalUsd'])
            self.assertIsNone(result['reinvestedUsd'])
            self.assertIsNone(result['knownFacts']['knownValuedTotalsUsd']['tradingAccrualUsd'])
            self.assertFalse(result['knownFacts']['canonical'])
            self.assertEqual(result['knownFacts']['rawTotals']['tradingAccrual'][ZERO],'10')
            self.assertEqual(result['performance']['snapshot']['canonicality'],'unverified')

    def test_missing_head_or_unprojectable_lifetime_is_explicitly_unavailable(self):
        bundle = fixture()
        bundle.update(financial=None,deltas=[])
        result = p.build_financial_projection(bundle,None,bundle['epoch']['cursor']['timestamp'])
        self.assertEqual(result['performance']['status'],'unavailable')
        self.assertIn('financial_history_unavailable',result['projectionIssues'])
        for kind in ('zero','reentered'):
            bundle=fixture()
            if kind=='zero': bundle['financial']['state']['members'][0]['endsAt']=bundle['financial']['state']['members'][0]['startsAt']
            else: bundle['financial']['state']['membershipAmbiguous']=True
            result=self.run_projection(bundle)
            self.assertEqual(result['performance']['status'],'unavailable')
            self.assertIsNone(result['performance']['netFeeAprPercent'])

    def test_identity_generation_cursor_and_window_corruption_fail_closed(self):
        for kind in ('owner','generation','page_generation','hash','gap','missing','start','location','valuation'):
            bundle=fixture()
            if kind=='owner': bundle['financial']['owner']='0x'+'99'*20
            if kind=='generation': bundle['financial']['replayGeneration']=2
            if kind=='page_generation': bundle['deltas'][0]['replayGeneration']=2
            if kind=='hash': bundle['deltas'][0]['slices'][0]['through']['blockHash']=hash_(999)
            if kind=='gap': bundle['deltas'][0]['slices'][0]['through']['blockNumber']=12
            if kind=='missing': bundle['deltas']=[]
            if kind=='start': bundle['deltas'][0]['slices'][0]['from']['timestamp']+=1
            if kind=='location': bundle['deltas'][0]['slices'][0]['credits'][0]['blockNumber']=12
            value=self.value(bundle)
            if kind=='valuation': value.pool_id=hash_(999)
            with self.subTest(kind=kind),self.assertRaises(ValueError):
                p.build_financial_projection(bundle,value,bundle['epoch']['cursor']['timestamp'])

    def test_duplicate_origins_records_and_gas_receipts_fail(self):
        for kind in ('origin','service','reinvestment','flow','gas'):
            bundle=fixture();part=bundle['deltas'][0]['slices'][0]
            field={'origin':'credits','service':'serviceDebits','reinvestment':'reinvestments','flow':'externalFlows','gas':'gasEvidence'}[kind]
            duplicate=deepcopy(part[field][0])
            if kind=='origin': duplicate['eventId']=hash_(999)
            part[field].append(duplicate)
            with self.subTest(kind=kind),self.assertRaises(ValueError):self.run_projection(bundle)

    def test_capital_or_gas_contradictions_cannot_be_promoted(self):
        for kind in ('capital','gas','native_total','unknown','numeric','missing_native','missing_zero_pair','foreign','opening','flow_flag'):
            bundle=fixture();part=bundle['deltas'][0]['slices'][0]
            if kind=='capital': part['capital'].append(deepcopy(part['capital'][0]))
            if kind=='gas': part['gasEvidence'][0]['receiptGasProductWei']='1'
            if kind=='native_total': part['gasEvidence'][0]['fullL2CostWei']='21000000000000'
            if kind=='unknown': part['qualified']=True
            if kind=='numeric': part['credits'][0]['raw']=10
            if kind=='missing_native': del part['capital'][1]['amountsRaw'][ZERO]
            if kind=='missing_zero_pair': del part['capital'][0]['amountsRaw'][TOKEN]
            if kind=='foreign': part['capital'][0]['amountsRaw']['0x'+'99'*20]='0'
            if kind=='opening': bundle['financial']['opening']['heldRaw'][1]='1'
            if kind=='flow_flag': part['externalFlowsComplete']=True
            with self.subTest(kind=kind),self.assertRaises(ValueError):self.run_projection(bundle)

    def test_actual_collector_and_reducer_delta_feeds_projection_without_reclassifying_opening(self):
        rpc=FinancialRpc();raw=CanonicalCollector(rpc);collector=FinancialCollector(rpc)
        baseline=raw.capture(OWNER,VAULT,['1'],CODE_HASH)
        opening=collector.capture_point(baseline,baseline.baseline)
        state=open_history(baseline,opening)
        rpc.add_transaction(logs=[pool_log()]);rpc.finalized=11
        raw_page=raw.collect(baseline,baseline.baseline)
        page=collector.capture_points(baseline,raw_page)
        state,delta=reduce_history(baseline,state,page,[])
        delta['replayGeneration']=1
        bundle=fixture(duration=1)
        bundle['epoch'].update(baseline=baseline.model_dump(),epochId=baseline.epochId,cursor=page.throughCursor.model_dump())
        bundle['financial'].update(epochId=baseline.epochId,opening=opening.model_dump(),state=state.model_dump(),cursor=page.throughCursor.model_dump())
        bundle['deltas']=[delta]
        result=self.run_projection(bundle)
        self.assertEqual(result['knownFacts']['rawTotals']['tradingAccrual'][ZERO],'99')
        self.assertEqual(result['performance']['newTradingFeesUsd'],'99.000000000000000000')
        self.assertNotEqual(result['performance']['newTradingFeesUsd'],'599.000000000000000000')
        self.assertIsNone(result['performance']['netFeeAprPercent'])


if __name__=='__main__':
    unittest.main()
