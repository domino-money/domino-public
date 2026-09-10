"""Synthetic cadence/capacity evidence using the actual causal price engine."""
from pathlib import Path
from fractions import Fraction
import sys
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import CHAIN_ID, ZERO, DataError
from price_history import (MAX_PRICE_ROWS, MAX_PRICE_WINDOW_SECONDS, MAX_PRODUCTION_PRICE_AGE_SECONDS,
    SUPPORTED_MIN_CADENCE_SECONDS, PriceQualification, PriceSeries, SOURCE, CHAINLINK_SOURCE, load_price_series)
from price_history import decimal_string
from test_discovery import POOL, TOKEN
from test_valuation import sample_window
from valuation import value_window

START, END = 300, 86700


def rows(cadence, *, end=END):
    return [{'chainId': CHAIN_ID, 'currency': ZERO, 'source': SOURCE, 'timestamp': at,
             'retrievedAt': end, 'priceUsd': str(1+at % 7)} for at in range(0, end+1, cadence)]


class PriceCapacityTests(unittest.TestCase):
    def setUp(self):
        self.qualification = PriceQualification(ZERO, 0, SOURCE, POOL, 'synthetic_only')

    def load(self, samples, start=START, end=END):
        connection = Mock()
        connection.execute.return_value.fetchall.return_value = samples[:MAX_PRICE_ROWS+1]
        with patch('price_history.PRODUCTION_QUALIFICATIONS', {(POOL, ZERO): self.qualification}):
            result = load_price_series(connection, POOL, [ZERO], start, end)
        return result, connection

    def test_capacity_is_derived_from_full_day_plus_causal_lookback(self):
        self.assertEqual((MAX_PRICE_WINDOW_SECONDS, MAX_PRODUCTION_PRICE_AGE_SECONDS,
                          SUPPORTED_MIN_CADENCE_SECONDS, MAX_PRICE_ROWS), (86400, 300, 60, 1446))
        for cadence in (60, 120, 144, 145, 150, 300):
            with self.subTest(cadence=cadence):
                samples = rows(cadence)
                series = PriceSeries(self.qualification, samples)
                series.require_coverage(START, END)
                (loaded, evidence), conn = self.load(samples)
                self.assertEqual(loaded[0].times, series.times)
                self.assertEqual(evidence[0]['coverage']['status'], 'complete')
                sql, params = conn.execute.call_args.args
                self.assertIn('LIMIT 1447', sql)
                self.assertEqual(params[-2:], (0, END))

    def test_faster_full_day_fails_explicitly_with_sentinel_not_truncation(self):
        samples = rows(30)
        with self.assertRaisesRegex(DataError, '^price_observation_budget_exhausted$'):
            PriceSeries(self.qualification, samples)
        with self.assertRaisesRegex(DataError, '^price_observation_budget_exhausted$'):
            self.load(samples)

    def test_unqualified_candidates_each_have_the_full_source_budget(self):
        samples = rows(60)
        candidates = samples + [{**row, 'source': CHAINLINK_SOURCE, 'priceUsd': '999'} for row in samples]
        connection = Mock()
        def execute(sql, params):
            selected = sorted((row for row in candidates if row['source'] in params[2]),
                              key=lambda row: (row['timestamp'], row['source']))
            return Mock(fetchall=Mock(return_value=selected[:MAX_PRICE_ROWS+1]))
        connection.execute.side_effect = execute
        with patch.dict('price_history.PRODUCTION_QUALIFICATIONS', {}, clear=True):
            series, evidence = load_price_series(connection, POOL, [ZERO], START, END)
        self.assertEqual(series, [None])
        self.assertEqual(evidence[0]['observations'], 2*MAX_PRICE_ROWS)
        self.assertEqual(evidence[0]['observedSources'], [SOURCE, CHAINLINK_SOURCE])
        self.assertEqual((evidence[0]['firstTimestamp'], evidence[0]['lastTimestamp']), (0, END))
        self.assertEqual(evidence[0]['sourceQualification'], 'unqualified')
        self.assertEqual(evidence[0]['status'], 'observed_unqualified')
        self.assertEqual(evidence[0]['reason'], 'price_source_quality_not_qualified')
        self.assertEqual(evidence[0]['coverage']['status'], 'not_assessed')
        with self.assertRaisesRegex(DataError, '^qualified_usd_prices_required$'):
            value_window(sample_window(), [*series, None], POOL)

    def test_unqualified_source_overflow_cannot_use_another_sources_spare_budget(self):
        for dense_source in (SOURCE, CHAINLINK_SOURCE):
            with self.subTest(source=dense_source):
                connection = Mock()
                def execute(sql, params):
                    selected = ([{**row, 'source': dense_source} for row in rows(30)][:MAX_PRICE_ROWS+1]
                                if dense_source in params[2] else [])
                    return Mock(fetchall=Mock(return_value=selected))
                connection.execute.side_effect = execute
                with patch.dict('price_history.PRODUCTION_QUALIFICATIONS', {}, clear=True):
                    with self.assertRaisesRegex(DataError, '^price_observation_budget_exhausted$'):
                        load_price_series(connection, POOL, [ZERO], START, END)

    def test_supported_cadence_is_not_resampling_and_fast_changes_are_exact(self):
        samples = rows(1, end=600)
        samples[137]['priceUsd'] = '9007199254740993.123456789'
        samples.insert(138, dict(samples[137]))
        series = PriceSeries(self.qualification, samples)
        self.assertEqual(len(series.times), 601)
        self.assertEqual(str(series.at(137)), '9007199254740993123456789/1000000000')
        self.assertEqual(series.at(138), 6)
        self.assertEqual(series.times, list(range(601)))

    def test_one_second_spike_between_capital_events_changes_exact_time_integral(self):
        samples = [{**row, 'priceUsd': '1'} for row in rows(1, end=600)]
        spike = '9007199254740993.123456789'
        samples[137]['priceUsd'] = spike
        series0 = PriceSeries(self.qualification, samples)
        q1 = PriceQualification(TOKEN, 0, SOURCE, POOL, 'synthetic_only')
        series1 = PriceSeries(q1, [{**row, 'currency': TOKEN, 'priceUsd': '1'} for row in samples])
        result = value_window(sample_window(600), [series0, series1], POOL)
        # Base capital average is 200. The one-second spike affects 100 units
        # for exactly 1/600 of the interval, with no float or sampled endpoint.
        expected = Fraction(200) + (Fraction(spike)-1)/6
        self.assertEqual(result['timeWeightedAverageTvlUsd'], decimal_string(expected))
        self.assertEqual(result['tvlUsd'], decimal_string(300))
        self.assertIsNone(result['feeAprPercent'])

    def test_slow_feed_still_fails_300_second_policy_despite_small_row_count(self):
        samples = rows(301)
        self.assertLess(len(samples), MAX_PRICE_ROWS)
        with self.assertRaisesRegex(DataError, '^qualified_price_coverage_gap$'):
            PriceSeries(self.qualification, samples).require_coverage(START, END)
        (_, evidence), _ = self.load(samples)
        self.assertEqual(evidence[0]['coverage']['status'], 'incomplete')
        self.assertEqual(evidence[0]['reason'], 'qualified_price_coverage_gap')

    def test_row_overflow_and_conflicting_duplicate_do_not_drop_updates(self):
        samples = rows(60)
        self.assertEqual(len(samples), MAX_PRICE_ROWS)
        samples[-1] = {**samples[-2], 'priceUsd': '999'}
        with self.assertRaisesRegex(DataError, 'conflicting_price_observation'):
            PriceSeries(self.qualification, samples)
        with self.assertRaisesRegex(DataError, 'price_observation_budget_exhausted'):
            PriceSeries(self.qualification, rows(60) + [dict(rows(60)[0])])

    def test_loader_window_and_production_qualification_remain_bounded(self):
        conn = Mock()
        for start, end in ((0, 86401), (-1, 20), (True, 100), (100, 0), (0, 2**63)):
            with self.subTest(start=start, end=end), self.assertRaisesRegex(DataError, 'invalid_price_history_bounds'):
                load_price_series(conn, POOL, [ZERO], start, end)
        conn.execute.assert_not_called()
        with self.assertRaisesRegex(DataError, 'invalid_price_qualification'):
            PriceQualification(ZERO, 0, SOURCE, POOL, 'synthetic_only', max_age=301)


if __name__ == '__main__':
    unittest.main()
