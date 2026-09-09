import copy
from fractions import Fraction
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from capital_store import capital_point, raw_capital_metrics
from catalogue import checked_key
from discovery import CHAIN_ID, ZERO, DataError
from position_accounting import replay_positions
from price_history import (AlchemyHistorical, PriceQualification, PriceSeries, SOURCE,
                           decimal_string, iso, usd)
from test_discovery import POOL, TOKEN
from test_position_accounting import reference
from valuation import value_window


def point(amount0, amount1=0):
    return {'lpAssetsRaw': [str(amount0), str(amount1)], 'principalRaw': [str(amount0), str(amount1)],
            'unsettledFeesRaw': ['0', '0'], 'roundingResidualRaw': ['0', '0'],
            'sqrtPriceX96': str(1 << 96), 'tick': 0}


def sample_window(end=86400):
    return {'start': 0, 'end': end, 'initializedAt': 0, 'base': {'capital': point(100)},
            'events': [{'timestamp': end//2, 'capital': point(300)}], 'endCapital': point(300),
            'swaps': [{'timestamp': end, 'payload': {'amount0': '-100', 'amount1': '90'},
                       'fees': {'lpFeesRaw': ['10', '0'], 'protocolFeesRaw': ['0', '0']}}],
            'sourceEventCount': 2, 'sourceChunks': 1}


def sample_rows(currency, *, end=86400, source=SOURCE, price='1', decimals=0):
    return [{'chainId': CHAIN_ID, 'currency': currency, 'source': source, 'timestamp': t,
             'retrievedAt': 100000, 'priceUsd': price} for t in range(0, end+301, 300)]


def sample_series(currency, rows=None, decimals=0):
    proof = PriceQualification(currency, decimals, SOURCE, POOL, 'test_fixture_only')
    return PriceSeries(proof, sample_rows(currency) if rows is None else rows)


class CapitalAndValuationTests(unittest.TestCase):
    def test_native_reference_event_observer_captures_every_capital_change(self):
        fixture = reference();points = []
        replay_positions(None, None, [e['event'] for e in fixture['sequence']], POOL,
            checked_key(fixture['poolKey'], POOL), observe=lambda e, a, m: points.append(capital_point(a, m)))
        self.assertEqual(len(points), 20)
        for point_, expected in zip(points, fixture['sequence']):
            self.assertEqual(point_['lpAssetsRaw'], expected['expectedAssetsRaw'])

    def test_capital_average_weights_time_instead_of_endpoint(self):
        result = raw_capital_metrics(sample_window())
        self.assertEqual(result['integralRawSeconds']['lpAssetsRaw'], ['17280000', '0'])
        self.assertEqual(result['averageDenominatorSeconds'], 86400)
        self.assertEqual(result['current']['lpAssetsRaw'][0], '300')

    def test_same_second_last_event_wins_and_endpoint_has_zero_duration(self):
        window = sample_window()
        window['events'] = [{'timestamp': 43200, 'capital': point(900)},
                            {'timestamp': 43200, 'capital': point(300)},
                            {'timestamp': 86400, 'capital': point(600)}]
        window['endCapital'] = point(600)
        result = raw_capital_metrics(window)
        self.assertEqual(result['integralRawSeconds']['lpAssetsRaw'][0], '17280000')
        self.assertEqual(result['current']['lpAssetsRaw'][0], '600')

    def test_full_day_fee_apr_and_input_volume_match_hand_calculation(self):
        result = value_window(sample_window(), [sample_series(ZERO), sample_series(TOKEN)], POOL)
        self.assertEqual(result['tvlUsd'], decimal_string(300))
        self.assertEqual(result['timeWeightedAverageTvlUsd'], decimal_string(200))
        self.assertEqual(result['tradingLpFeesUsd'], decimal_string(10))
        self.assertEqual(result['grossInputVolumeUsd'], decimal_string(100))
        self.assertEqual(result['feeAprPercent'], decimal_string(1825))
        self.assertFalse(result['isApy']);self.assertFalse(result['includesDominoServiceFee'])

    def test_price_changes_between_events_are_integrated(self):
        window = sample_window();window['events'] = [];window['endCapital'] = point(100)
        rows = sample_rows(ZERO)
        for r in rows:
            r['priceUsd'] = '3' if r['timestamp'] >= 43200 else '1'
        result = value_window(window, [sample_series(ZERO, rows), sample_series(TOKEN)], POOL)
        self.assertEqual(result['timeWeightedAverageTvlUsd'], decimal_string(200))
        self.assertEqual(result['tvlUsd'], decimal_string(300))
        self.assertEqual(result['tradingLpFeesUsd'], decimal_string(30))

    def test_pool_younger_than_day_never_extrapolates_partial_fees(self):
        result = value_window(sample_window(3600), [sample_series(ZERO), sample_series(TOKEN)], POOL)
        self.assertIsNone(result['feeAprPercent'])
        self.assertEqual(result['feeAprReason'], 'pool_younger_than_window')

    def test_zero_capital_day_has_no_apr_even_with_zero_fees(self):
        window = sample_window();window.update(base={'capital': point(0)}, events=[], endCapital=point(0), swaps=[])
        result = value_window(window, [sample_series(ZERO), sample_series(TOKEN)], POOL)
        self.assertEqual(result['tradingLpFeesUsd'], decimal_string(0))
        self.assertIsNone(result['feeAprPercent'])
        self.assertEqual(result['feeAprReason'], 'zero_time_weighted_tvl')

    def test_missing_boundary_and_mid_interval_gap_fail_closed(self):
        for removed in (0, 100):
            rows = sample_rows(ZERO);rows.pop(removed)
            with self.subTest(removed=removed), self.assertRaisesRegex(DataError, 'coverage_gap'):
                value_window(sample_window(), [sample_series(ZERO, rows), sample_series(TOKEN)], POOL)

    def test_future_prices_are_never_used_to_fill_history(self):
        series = sample_series(ZERO, [sample_rows(ZERO)[1]])
        with self.assertRaisesRegex(DataError, 'coverage_gap'): series.at(299)
        self.assertEqual(series.at(300), 1)

    def test_price_identity_independence_and_quality_are_mandatory(self):
        with self.assertRaisesRegex(DataError, 'qualified_usd_prices_required'):
            value_window(sample_window(), [sample_series(ZERO), None], POOL)
        with self.assertRaisesRegex(DataError, 'independence'):
            value_window(sample_window(), [sample_series(ZERO), sample_series(TOKEN)], '0x'+'11'*32)
        rows = sample_rows(TOKEN)
        with self.assertRaisesRegex(DataError, 'identity_mismatch'): sample_series(ZERO, rows)
        rows = sample_rows(ZERO);rows[0]['chainId'] = 1
        with self.assertRaisesRegex(DataError, 'identity_mismatch'): sample_series(ZERO, rows)

    def test_exclusive_fee_boundary_and_missing_allocations(self):
        for timestamp_, reason in [(0, 'outside'), (86401, 'outside')]:
            window = sample_window();window['swaps'][0]['timestamp'] = timestamp_
            with self.assertRaisesRegex(DataError, reason):
                value_window(window, [sample_series(ZERO), sample_series(TOKEN)], POOL)
        window = sample_window();window['swaps'][0]['fees'] = None
        with self.assertRaisesRegex(DataError, 'reconciled_swap_fees'):
            value_window(window, [sample_series(ZERO), sample_series(TOKEN)], POOL)

    def test_decimals_extremes_and_huge_raw_values_keep_exact_precision(self):
        series = sample_series(TOKEN, decimals=255)
        self.assertEqual(series.value(10**255+1, 0), Fraction(10**255+1, 10**255))
        self.assertEqual(usd('0.000000000000000000000000000000000001'), Fraction(1, 10**36))
        self.assertEqual(decimal_string(Fraction(1, 3)), '0.333333333333333333')
        for value in [1.2, 'NaN', '-1', '0', 'Infinity', '1e40', True, '1'*129]:
            with self.subTest(value=value), self.assertRaises(DataError): usd(value)

    def test_nonmonotonic_and_wrong_tail_rejected(self):
        window = sample_window();window['events'].append({'timestamp': 100, 'capital': point(300)})
        with self.assertRaisesRegex(DataError, 'not_monotonic'): raw_capital_metrics(window)
        window = sample_window();window['endCapital'] = point(50)
        with self.assertRaisesRegex(DataError, 'tail_mismatch'): raw_capital_metrics(window)


class HistoricalProviderTests(unittest.TestCase):
    def provider(self, response, requests=None):
        def transport(url, body):
            if requests is not None: requests.append(body)
            return response
        return AlchemyHistorical('https://robinhood-mainnet.g.alchemy.com/v2/test', transport=transport, clock=lambda: 10000)

    def test_address_queries_do_not_guess_symbols_or_stable_prices(self):
        body = {'network': 'robinhood-mainnet', 'address': TOKEN, 'currency': 'usd',
                'data': [{'timestamp': iso(600), 'value': '0.97'}]}
        requests = [];rows = self.provider(body, requests).fetch(TOKEN, 300, 900)
        self.assertEqual(requests[0]['address'], TOKEN);self.assertNotIn('symbol', requests[0])
        self.assertEqual(rows[0]['priceUsd'], '0.97')
        self.assertEqual(rows[0]['provenance']['status'], 'external_observation_unqualified')

    def test_native_eth_has_explicit_identity_and_no_weth_alias(self):
        requests = [];response = {'symbol': 'ETH', 'currency': 'usd', 'data': []}
        self.provider(response, requests).fetch(ZERO, 300, 900)
        self.assertEqual(requests[0]['symbol'], 'ETH')
        with self.assertRaisesRegex(DataError, 'asset_mismatch'): self.provider(response).fetch(TOKEN, 300, 900)

    def test_wrong_network_future_points_duplicates_and_non_usd_rejected(self):
        good = {'network': 'robinhood-mainnet', 'address': TOKEN, 'currency': 'usd',
                'data': [{'timestamp': iso(600), 'value': '1'}]}
        bads = [{**good, 'network': 'eth-mainnet'}, {**good, 'currency': 'eur'},
                {**good, 'data': [{'timestamp': iso(901), 'value': '1'}]},
                {**good, 'data': good['data']+[{'timestamp': iso(600), 'value': '2'}]},
                {**good, 'data': [{'timestamp': '2026-09-09T00:00:00', 'value': '1'}]}]
        for bad in bads:
            with self.subTest(bad=bad), self.assertRaises(DataError): self.provider(bad).fetch(TOKEN, 300, 900)

    def test_provider_bounds_prevent_unbounded_or_future_fetch(self):
        provider = self.provider({})
        for start, end in [(True, 800), (100, 100), (-1, 500), (0, 10001)]:
            with self.assertRaisesRegex(DataError, 'invalid_price_history_bounds'): provider.fetch(TOKEN, start, end)
