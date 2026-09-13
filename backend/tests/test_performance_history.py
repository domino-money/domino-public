"""Financial attribution regressions using forward canonical acquisition."""
from copy import deepcopy
import unittest
from eth_abi import encode
from test_performance_financial_collection import FinancialRpc, pool_log, selector
from test_performance_collection import OWNER, VAULT, CODE_HASH, TOKEN, token_log, topic, hash_
from performance_collection import CanonicalCollector
from performance_financial_collection import FinancialCollector, FinancialPoint
from performance_history import open_history, reduce_history, capital_components
from pool_activity import DONATE, MODIFY


class HistoryFixture:
    def setup_history(self):
        self.rpc = FinancialRpc()
        self.raw = CanonicalCollector(self.rpc)
        self.collector = FinancialCollector(self.rpc)
        self.base = self.raw.capture(OWNER,VAULT,['1'],CODE_HASH)
        self.opening = self.collector.capture_point(self.base,self.base.baseline)
        self.state = open_history(self.base,self.opening)

    def page(self, logs=None, *, through=11, start=None):
        if logs is not None: self.rpc.add_transaction(block=through,logs=logs)
        self.rpc.finalized = through
        raw = self.raw.collect(self.base,start or self.base.baseline)
        return raw,self.collector.capture_points(self.base,raw)


class HistoryTests(HistoryFixture,unittest.TestCase):
    def setUp(self): self.setup_history()

    def test_opening_pending_and_held_reserves_are_capital_once(self):
        result = capital_components(self.base,self.opening)
        amounts = result['components'][0]['amountsRaw']
        self.assertEqual(amounts[self.opening.currencies[0]],str(int(self.opening.members[0].principalRaw[0])+500))
        self.assertEqual(result['components'][1]['amountsRaw'],dict(zip(self.opening.currencies,self.opening.heldRaw)))
        self.assertEqual(self.state.cumulativeKnown,{})
        invalid = self.opening.model_dump()
        invalid['heldRaw'][1] = '21'
        with self.assertRaisesRegex(ValueError,'opening_balance_mismatch'):
            open_history(self.base,invalid)

    def test_new_collectible_accrual_excludes_opening_and_is_dated_at_block(self):
        raw,page = self.page([pool_log()])
        original = self.state.model_dump()
        state,delta = reduce_history(self.base,self.state,page,[])
        row = delta['slices'][0]
        self.assertTrue(row['incomeComplete'])
        self.assertEqual(row['credits'][0]['raw'],'99')  # exact Q128 collectible floor
        self.assertEqual(row['credits'][0]['timestamp'],1011)
        self.assertEqual(row['credits'][0]['blockNumber'],11)
        self.assertEqual(self.state.model_dump(),original)
        self.assertEqual(state.cumulativeKnown['tradingAccrual'][page.points[0].currencies[0]],'99')
        self.assertEqual(row['serviceDebits'],[])
        self.assertEqual(row['reinvestments'],[])
        self.assertEqual(row['externalFlows'],[])

    def test_donation_or_unobserved_growth_never_becomes_trading_income(self):
        for logs in ([pool_log(DONATE),pool_log()],None):
            with self.subTest(logs=logs):
                self.setup_history()
                _,page = self.page(logs)
                state,delta = reduce_history(self.base,self.state,page,[])
                self.assertFalse(delta['slices'][0]['incomeComplete'])
                self.assertEqual(delta['slices'][0]['credits'],[])
                self.assertEqual(delta['slices'][0]['unclassifiedAccrual'][0]['raw'],'99')
                self.assertNotIn('tradingAccrual',state.cumulativeKnown)

    def test_manual_modify_interrupts_income_but_retains_capital_and_gas(self):
        _,page = self.page([pool_log(MODIFY),pool_log()])
        _,delta = reduce_history(self.base,self.state,page,[])
        row = delta['slices'][0]
        self.assertIn('external_liquidity_change_unreconciled',row['issues'])
        self.assertTrue(row['capitalComplete'])
        self.assertIsNone(row['changes'][0]['amountsRaw'])
        self.assertIsNone(row['gasEvidence'][0]['fullL2CostWei'])
        self.assertFalse(row['gasEvidence'][0]['strategyDebitApplied'])

    def test_unexplained_token_and_reserve_delta_prevents_complete_claim(self):
        _,page = self.page([pool_log()])
        point = page.points[0].model_dump()
        point['heldRaw'][1] = '30'
        point['accountedRaw'][1] = '8'
        page.points[0] = FinancialPoint.model_validate(point)
        _,delta = reduce_history(self.base,self.state,page,[])
        self.assertIn('token_external_flow_unattributed',delta['slices'][0]['issues'])
        self.assertIn('fee_reserve_change_unreconciled',delta['slices'][0]['issues'])

    def test_external_token_deposit_is_not_fee_income_or_service_fee(self):
        _,page = self.page([token_log(),pool_log()])
        point = page.points[0].model_dump()
        point['heldRaw'][1] = '120'
        page.points[0] = FinancialPoint.model_validate(point)
        _,delta = reduce_history(self.base,self.state,page,[])
        row = delta['slices'][0]
        self.assertTrue(row['incomeComplete'])
        self.assertEqual(row['externalFlows'][0]['raw'],'100')
        self.assertEqual(row['externalFlows'][0]['kind'],'external_deposit')
        self.assertEqual(row['credits'][0]['raw'],'99')
        self.assertEqual(row['serviceDebits'],[])

    def test_failure_gap_does_not_taint_later_clean_block_permanently(self):
        raw,page = self.page([pool_log(DONATE)])
        state,first = reduce_history(self.base,self.state,page,[])
        _,next_page = self.page([pool_log()],through=12,start=raw.throughCursor)
        after,second = reduce_history(self.base,state,next_page,[])
        self.assertFalse(first['slices'][0]['incomeComplete'])
        self.assertTrue(second['slices'][0]['incomeComplete'])
        self.assertEqual(second['slices'][0]['credits'][0]['raw'],'100')
        self.assertEqual(after.incompleteBlocks,1)

    def test_unknown_compound_report_is_rejected_not_promoted(self):
        _,page = self.page([pool_log()])
        with self.assertRaisesRegex(ValueError,'invalid_compound_reports'):
            reduce_history(self.base,self.state,page,[{'canonical':True,'finalized':True}])
