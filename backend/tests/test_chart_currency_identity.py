"""Independent identity/diagnostic regressions, entirely offline."""
from decimal import Decimal
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]
from discovery import DataError, ZERO
from market_data import GeckoMarketData, MarketCandleError
from market_cache import MarketCache
from read_service import ReadService
from test_discovery import FakeRpc, POOL, TOKEN, OTHER
from test_market_data import hourly_response, candle, NOW, BASE, QUOTE
from test_read_contract import MarketTransport


class ChartCurrencyIdentityTests(unittest.TestCase):
    def test_requested_address_must_be_metadata_base_even_when_present_in_quote(self):
        transport = Mock(return_value=hourly_response())
        with self.assertRaisesRegex(DataError, '^market_chart_currency_mismatch$'):
            GeckoMarketData(transport, clock=lambda: NOW).hourly_prices(POOL, token='quote', currency=QUOTE)
        self.assertIn('token='+QUOTE, transport.call_args.args[0])

    def test_both_pool_orientations_preserve_selected_currency_and_literal_candles(self):
        raw = hourly_response([candle(99*3600, volume=Decimal('0'))])
        for role in ('base', 'quote'):
            with self.subTest(role=role):
                observed = GeckoMarketData(lambda *a, **k: raw, clock=lambda: NOW).hourly_prices(
                    POOL, token=role, currency=BASE)
                self.assertEqual(observed['currency'], BASE)
                self.assertEqual(observed[role+'Token'], BASE)
                self.assertEqual(observed['selectedToken'], role)
                self.assertEqual(observed['candles'], [{'startTimestamp': 99*3600,
                    'openUsd': '1.000000000000000001', 'highUsd': '1.1', 'lowUsd': '0.9',
                    'closeUsd': '1.05', 'volumeUsd': '0', 'closed': True}])
                self.assertFalse(observed['coverage']['complete24h'])

    def test_missing_symbol_or_forged_symbol_cannot_change_binding(self):
        raw = hourly_response([])
        raw['meta']['base']['symbol'] = 'USDG';raw['meta']['quote']['symbol'] = 'USDG'
        result = GeckoMarketData(lambda *a, **k: raw, clock=lambda: NOW).hourly_prices(POOL, currency=BASE)
        self.assertEqual(result['currency'], BASE)
        self.assertNotIn('symbol', result)

    def test_malformed_and_missing_currency_are_rejected_before_provider_work(self):
        for currency in (None, 'USDG', POOL, BASE+'&token='+QUOTE, 0):
            with self.subTest(currency=currency):
                transport = Mock();provider = GeckoMarketData(transport)
                with self.assertRaises(DataError): provider.hourly_prices(POOL, currency=currency)
                with self.assertRaises(DataError): MarketCache(provider).get('hourly_prices', POOL, currency=currency)
                transport.assert_not_called()

    def service(self, transport, now):
        cache = MarketCache(GeckoMarketData(transport, clock=lambda: now[0]), clock=lambda: now[0])
        return ReadService(rpc_factory=FakeRpc, clock=lambda: 1010, market_cache=cache), cache

    def test_quote_chart_with_rotated_metadata_passes_real_service(self):
        transport = MarketTransport();now = [1010];service, _ = self.service(transport, now)
        result = service.pool_market(POOL, include_price_history=True, price_token='quote')
        history = result['priceHistory']['data']
        self.assertEqual(result['priceHistory']['status'], 'available')
        self.assertEqual((history['baseToken'], history['quoteToken'], history['currency']), (TOKEN, ZERO, ZERO))
        self.assertEqual(history['selectedToken'], 'quote')
        self.assertEqual(history['candles'][0]['openUsd'], '1.000000000000000001')

    def test_other_pair_is_rejected_even_when_selected_address_is_correct(self):
        original = MarketTransport()
        def transport(url, **kwargs):
            response = original(url, **kwargs)
            if '/ohlcv/' in url: response['meta']['quote']['address'] = OTHER
            return response
        service, _ = self.service(transport, [1010])
        result = service.pool_market(POOL, include_price_history=True)
        self.assertEqual(result['market']['status'], 'available')
        self.assertEqual(result['priceHistory']['reason'], 'provider_currency_or_pool_mismatch')
        self.assertIsNone(result['priceHistory']['data'])

    def test_orientation_change_uses_new_currency_key_and_preserves_old_chart(self):
        original = MarketTransport();calls = []
        def transport(url, **kwargs):
            calls.append(url)
            return original(url, **kwargs)
        now = [1010];service, cache = self.service(transport, now)
        first = service.pool_market(POOL, include_price_history=True)
        self.assertEqual(first['priceHistory']['data']['currency'], TOKEN)
        # Refresh only the pool. The old chart remains fresh in the cache.
        for key in list(cache.entries):
            if key[0] == 'pool': del cache.entries[key]
        original.base, original.quote = ZERO, TOKEN
        second = service.pool_market(POOL, include_price_history=True)
        self.assertEqual(second['priceHistory']['data']['currency'], ZERO)
        self.assertEqual(second['priceHistory']['cache']['status'], 'miss')
        self.assertEqual([u.rsplit('token=', 1)[1] for u in calls if '/ohlcv/' in u], [TOKEN, ZERO])
        self.assertEqual(cache.get('hourly_prices', POOL, currency=TOKEN)['data']['currency'], TOKEN)
        self.assertEqual(len([u for u in calls if '/ohlcv/' in u]), 2)

    def test_duplicate_candle_rejection_keeps_market_and_hides_diagnostics_from_wire(self):
        original = MarketTransport();original.rows *= 2
        service, _ = self.service(original, [1010])
        result = service.pool_market(POOL, include_price_history=True)
        self.assertEqual(result['market']['status'], 'available')
        self.assertEqual(result['market']['data']['volume24hUsd'], '0')
        self.assertEqual(result['priceHistory']['status'], 'unavailable')
        self.assertEqual(result['priceHistory']['reason'], 'provider_unavailable')
        self.assertIsNone(result['priceHistory']['data'])
        self.assertNotIn('diagnostic', json.dumps(result))
        self.assertIsNone(result['feeApr24h'])

    def test_each_candle_rejection_has_safe_specific_diagnostic(self):
        valid = candle(99*3600)
        cases = [('not-a-list', 'invalid_list', None, None),
                 ([valid]*25, 'too_many_candles', None, None),
                 ([valid[:-1]], 'invalid_row', 0, None),
                 ([[True, *valid[1:]]], 'invalid_timestamp', 0, 'timestamp'),
                 ([[101*3600, *valid[1:]]], 'future_timestamp', 0, 'timestamp'),
                 ([[99*3600+1, *valid[1:]]], 'unaligned_timestamp', 0, 'timestamp'),
                 ([valid, valid], 'duplicate_timestamp', 1, 'timestamp'),
                 ([[valid[0], 'provider-secret-body', *valid[2:]]], 'invalid_number', 0, 'open'),
                 ([[valid[0], 1, 0, 2, 1, 0]], 'low_above_high', 0, None),
                 ([[valid[0], 3, 2, 0, 1, 0]], 'open_outside_range', 0, 'open'),
                 ([[valid[0], 1, 2, 0, 3, 0]], 'close_outside_range', 0, 'close')]
        for rows, reason, index, field in cases:
            with self.subTest(reason=reason), self.assertRaises(MarketCandleError) as caught:
                GeckoMarketData(lambda *a, **k: hourly_response(rows), clock=lambda: NOW).hourly_prices(
                    POOL, currency=BASE)
            self.assertEqual(caught.exception.diagnostic, {'reason': reason, 'rowIndex': index, 'field': field})
            self.assertNotIn('provider-secret-body', str(caught.exception)+str(caught.exception.diagnostic))

    def test_observed_zero_is_preserved_but_missing_cell_rejects_whole_history(self):
        raw = hourly_response([[99*3600, 0, 0, 0, 0, 0]])
        provider = GeckoMarketData(lambda *a, **k: raw, clock=lambda: NOW)
        self.assertEqual(provider.hourly_prices(POOL, currency=BASE)['candles'][0]['closeUsd'], '0')
        raw['data']['attributes']['ohlcv_list'][0][4] = None
        with self.assertRaises(MarketCandleError) as caught: provider.hourly_prices(POOL, currency=BASE)
        self.assertEqual(caught.exception.diagnostic, {'reason': 'invalid_number', 'rowIndex': 0, 'field': 'close'})

    def test_public_marlin_samples_reproduce_duplicate_timestamp_without_deduplication(self):
        fixture = json.loads((Path(__file__).parent/'fixtures/public-marlin-duplicate-candles.json').read_text())
        for sample in fixture['samples']:
            with self.subTest(window=sample['window']):
                rows = sample['rows']
                self.assertEqual(rows[0][0], rows[1][0])
                # Exact original public decimal strings, intentionally conflicting.
                self.assertNotEqual(rows[0][1:], rows[1][1:])
                raw = {'data': {'type': 'ohlcv_request_response', 'attributes': {'ohlcv_list': rows}},
                       'meta': {'base': {'address': fixture['currency']},
                                'quote': {'address': fixture['otherCurrency']}}}
                with self.assertRaises(MarketCandleError) as caught:
                    GeckoMarketData(lambda *a, **k: raw, clock=lambda: sample['retrievedAt']).hourly_prices(
                        fixture['poolId'], token='quote', currency=fixture['currency'])
                self.assertEqual(caught.exception.diagnostic, {'reason': 'duplicate_timestamp', 'rowIndex': 1, 'field': 'timestamp'})


if __name__ == '__main__':
    unittest.main()
