"""24h capacity regression, synthetic canonical evidence; no provider SLA claim."""
from bisect import bisect_right
from copy import deepcopy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]
import price_history as ph
import performance_rollup as r
from performance_valuation import ManagedValuation, _Asset
import test_performance_history_projection as fixtures
from test_performance_collection import hash_
from discovery import ZERO


class RollupScaleTests(unittest.TestCase):
    def test_172800_blocks_at_120_per_minute_form_exact_bounded_day(self):
        with patch.dict(ph.PRODUCTION_QUALIFICATIONS, {}, clear=True):
            bundle = fixtures.fixture()
            base, head = bundle['epoch']['baseline'], bundle['financial']
            start = base['baseline']['timestamp']; end = start + 86400
            final = {'blockNumber': 172810, 'blockHash': hash_(172810),
                     'parentHash': hash_(172809), 'timestamp': end}
            for record in (bundle['epoch'], head, head['state']): record['cursor'] = final
            head['state']['lastPoint']['block'] = final
            value = fixtures.FinancialHistoryProjectionTests().value(bundle)
            template = deepcopy(bundle['deltas'][0]['slices'][0])
            for key in ('credits', 'serviceDebits', 'realizations', 'reinvestments', 'externalFlows', 'gasEvidence'):
                template[key] = []
            template.update(externalFlowsComplete=True, externalFlowsReason=None)
            delta_template = {key: val for key, val in bundle['deltas'][0].items()
                              if key not in ('fromCursor', 'throughCursor', 'slices')}
            result = {key: val for key, val in bundle.items() if key != 'deltas'}
            result.update(summaries=[], edges=[], missingBuckets=[])
            first, last = r.bucket_at(start), r.bucket_at(end)
            previous = base['baseline']; bucket = first; slices = []; total_pages = 0

            def seal(key, parts):
                nonlocal total_pages
                pages = [{**delta_template, 'fromCursor': group[0]['from'],
                          'throughCursor': group[-1]['through'], 'slices': group}
                         for at in range(0, len(parts), 16) if (group := parts[at:at+16])]
                total_pages += len(pages)
                self.assertLessEqual(len(pages), 9)
                a, b = max(start, key), min(end, key+60)
                if key in (first, last):
                    result['edges'].append({'bucket': key, 'deltas': pages})
                else:
                    # Runtime loads just this minute's causal observations, not
                    # all day's prices for each raw block's exact integral.
                    assets = {}
                    for currency, asset in value._assets.items():
                        left = max(0, bisect_right(asset.times, a)-1)
                        right = bisect_right(asset.times, b)
                        assets[currency] = _Asset(asset.qualification, asset.times[left:right],
                                                 asset.values[left:right], asset.unavailable_reason)
                    scoped = ManagedValuation(value.pool_id, a, b, assets)
                    summary = r.summarize(base, head, pages, scoped, key, start=a, end=b)
                    result['summaries'].append({'bucket': key, 'summary': summary.model_dump(), 'dirty': False})

            for i in range(1, 172801):
                current = {'blockNumber': 10+i, 'blockHash': hash_(10+i),
                           'parentHash': previous['blockHash'], 'timestamp': start+i//2}
                next_bucket = r.bucket_at(current['timestamp'])
                if next_bucket != bucket:
                    seal(bucket, slices); bucket = next_bucket; slices = []
                part = deepcopy(template)
                part.update({'from': previous, 'through': current})
                # Positive one-second intervals cycle 1001,1000,1002 exactly.
                part['capital'][0]['amountsRaw'][ZERO] = str(1000+(i-1)%3)
                if i % 2 == 0:
                    part['credits'] = [{'tokenId': '1', 'currency': ZERO, 'timestamp': current['timestamp'],
                        'blockNumber': current['blockNumber'], 'eventId': hash_(1000000+i),
                        'feeOriginId': hash_(1000000+i), 'raw': '1', 'kind': 'new_trading_fee'}]
                slices.append(part); previous = current
            seal(bucket, slices)
            self.assertGreater(total_pages, 4096)  # beyond the previous raw-window ceiling
            self.assertEqual(len(result['summaries'])+len(result['edges']), 1441)
            self.assertLessEqual(sum(len(edge['deltas']) for edge in result['edges']), 18)
            output = r.project(result, value, end)
            metrics = output['performance']
            self.assertEqual(metrics['status'], 'available')
            self.assertTrue(metrics['complete24h'])
            self.assertEqual(metrics['newTradingFeesUsd'], '86400.000000000000000000')
            self.assertEqual(metrics['timeWeightedCapitalUsd'], '1001.000000000000000000')
            self.assertEqual(metrics['netFeeIncomeUsd'], metrics['newTradingFeesUsd'])
            self.assertIsNone(metrics['operatorCostsUsd'])
            self.assertEqual(output['dirtyBuckets'], [])


if __name__ == '__main__': unittest.main()
