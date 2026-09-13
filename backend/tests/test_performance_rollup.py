"""Exact minute math and price invalidation over synthetic trusted journal data."""
from copy import deepcopy
from fractions import Fraction
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path[:0]=[str(Path(__file__).resolve().parents[1]),str(Path(__file__).resolve().parent)]
import price_history as ph
import performance_rollup as r
from performance_history_projection import build_financial_projection
import test_performance_history_projection as fixtures
from test_performance_collection import hash_
from discovery import ZERO


class RollupTests(unittest.TestCase):
    def setUp(self):
        self.registry=patch.dict(ph.PRODUCTION_QUALIFICATIONS,{},clear=True)
        self.registry.start();self.addCleanup(self.registry.stop)

    def prices(self,bundle,**kwargs):return fixtures.FinancialHistoryProjectionTests().value(bundle,**kwargs)

    def compact(self,bundle,valuation):
        base,head=bundle['epoch']['baseline'],bundle['financial']
        end=head['cursor']['timestamp'];start=max(base['baseline']['timestamp'],end-86400)
        first,last=r.bucket_at(start),r.bucket_at(end)
        result={**deepcopy(bundle),'summaries':[],'edges':[],'missingBuckets':[]}
        result.pop('deltas')
        for bucket in range(first,last+1,60):
            a,b=max(start,bucket),min(end,bucket+60)
            if b<a or a==b and start!=base['baseline']['timestamp']:continue
            if bucket in (first,last):result['edges'].append({'bucket':bucket,'deltas':deepcopy(bundle['deltas'])})
            else:
                summary=r.summarize(base,head,bundle['deltas'],valuation,bucket,start=a,end=b)
                result['summaries'].append({'bucket':bucket,'summary':summary.model_dump(),'dirty':False})
        return result

    def test_complete_day_matches_uncompacted_exact_metrics(self):
        bundle=fixtures.fixture();valuation=self.prices(bundle)
        compact=self.compact(bundle,valuation)
        result=r.project(compact,valuation,bundle['epoch']['cursor']['timestamp'])
        expected=build_financial_projection(bundle,valuation,bundle['epoch']['cursor']['timestamp'])
        for name in ('newTradingFeesUsd','actualServiceFeesUsd','netFeeIncomeUsd','timeWeightedCapitalUsd','grossFeeAprPercent','netFeeAprPercent'):
            self.assertEqual(result['performance'][name],expected['performance'][name],name)
        self.assertEqual(result['performance']['status'],'available')
        self.assertEqual(len(compact['summaries'])+len(compact['edges']),1441)
        self.assertEqual(result['reinvestedUsd'],'50.000000000000000000')
        self.assertFalse(result['externalFlowCoverage']['complete'])

    def test_rolling_edge_recomputes_changing_capital_and_event_times(self):
        bundle=fixtures.fixture(duration=30)
        fixtures.append_interval(bundle,30,capital_raw='2000')
        start=bundle['epoch']['baseline']['baseline']['timestamp']
        valuation=self.prices(bundle,prices={ZERO:[(start,'1'),(start+20,'2'),(start+60,'2')]})
        result=r.project(self.compact(bundle,valuation),valuation,start+60)
        expected=build_financial_projection(bundle,valuation,start+60)
        self.assertEqual(result['performance']['timeWeightedCapitalUsd'],expected['performance']['timeWeightedCapitalUsd'])
        self.assertEqual(result['performance']['newTradingFeesUsd'],expected['performance']['newTradingFeesUsd'])
        # The exact average is 2666 2/3; no minute-level sampling or rounding.
        self.assertEqual(result['performance']['timeWeightedCapitalUsd'],'2666.666666666666666666')

    def test_registry_revocation_or_historical_price_change_invalidates_saved_dollars(self):
        bundle=fixtures.fixture();valuation=self.prices(bundle);compact=self.compact(bundle,valuation)
        ph.PRODUCTION_QUALIFICATIONS.clear()
        revoked=r.project(compact,valuation,bundle['epoch']['cursor']['timestamp'])
        self.assertFalse(revoked['performance']['complete24h'])
        self.assertIsNone(revoked['performance']['netFeeAprPercent'])
        self.assertIsNone(revoked['performance']['timeWeightedCapitalUsd'])
        self.assertTrue(revoked['dirtyBuckets'])
        changed=self.prices(bundle,prices={ZERO:[(t,'2') for t in range(bundle['epoch']['baseline']['baseline']['timestamp'],bundle['epoch']['cursor']['timestamp']+1,300)]+[(bundle['epoch']['cursor']['timestamp'],'2')]})
        self.assertTrue(r.project(compact,changed,bundle['epoch']['cursor']['timestamp'])['dirtyBuckets'])

    def test_missing_bucket_or_income_and_capital_gap_never_becomes_complete_apr(self):
        bundle=fixtures.fixture();valuation=self.prices(bundle);compact=self.compact(bundle,valuation)
        omitted=compact['summaries'].pop(20);compact['missingBuckets']=[omitted['bucket']]
        result=r.project(compact,valuation,bundle['epoch']['cursor']['timestamp'])
        self.assertEqual(result['performance']['status'],'partial')
        self.assertIsNone(result['performance']['netFeeAprPercent'])
        self.assertIsNone(result['performance']['newTradingFeesUsd'])
        with self.assertRaises(ValueError):
            bad=deepcopy(omitted['summary']);bad['owner']='0x'+'ab'*20
            compact['summaries'].append({**omitted,'summary':bad})
            r.project(compact,valuation,bundle['epoch']['cursor']['timestamp'])

    def test_opening_second_new_blocks_keep_only_new_earning_events(self):
        bundle=fixtures.fixture(same_second=True);valuation=self.prices(bundle)
        result=r.project(self.compact(bundle,valuation),valuation,bundle['epoch']['cursor']['timestamp'])
        self.assertEqual(result['performance']['newTradingFeesUsd'],'10.000000000000000000')
        self.assertFalse(result['performance']['complete24h'])
        self.assertIsNone(result['performance']['netFeeAprPercent'])

    def test_opening_at_exact_minute_never_counts_same_second_fees_twice(self):
        bundle=fixtures.fixture(same_second=True)
        shift=60-bundle['epoch']['baseline']['baseline']['timestamp']%60
        def move(value):
            if isinstance(value,dict):
                for key,child in value.items():
                    if key in ('timestamp','startedAt','startsAt','endsAt','createdAt','updatedAt') and type(child) is int:
                        value[key]+=shift
                    else:move(child)
            elif isinstance(value,list):
                for child in value:move(child)
        move(bundle)
        fixtures.append_interval(bundle,60)
        valuation=self.prices(bundle)
        result=r.project(self.compact(bundle,valuation),valuation,bundle['epoch']['cursor']['timestamp'])
        self.assertEqual(result['performance']['newTradingFeesUsd'],'20.000000000000000000')
        self.assertEqual(result['performance']['timeWeightedCapitalUsd'],'1000.000000000000000000')


if __name__=='__main__':unittest.main()
