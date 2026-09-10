from decimal import Decimal
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import DataError, ZERO
from market_data import GeckoMarketData, ROOT

POOL = '0x'+'12'*32
BASE = '0x'+'22'*20
QUOTE = '0x'+'11'*20
NOW = 100*3600+123


def pool_response():
    return {'data': {'id': 'robinhood_'+POOL, 'type': 'pool',
                    'attributes': {'address': POOL, 'name': 'Wrong / symbol 999%',
                                   'reserve_in_usd': '12345.6700', 'volume_usd': {'h24': '0'}},
                    'relationships': {'base_token': {'data': {'id': 'robinhood_'+BASE, 'type': 'token'}},
                                      'quote_token': {'data': {'id': 'robinhood_'+QUOTE, 'type': 'token'}},
                                      'dex': {'data': {'id': 'uniswap-v4-robinhood', 'type': 'dex'}}}}}


def candle(at, *, volume=Decimal('123.456789012345678901')):
    return [at, Decimal('1.000000000000000001'), Decimal('1.1'), Decimal('.9'), Decimal('1.05'), volume]


def hourly_response(rows=None):
    return {'data': {'id': 'unrelated-response-uuid', 'type': 'ohlcv_request_response',
                     'attributes': {'ohlcv_list': [candle(100*3600), candle(99*3600)] if rows is None else rows}},
            'meta': {'base': {'address': BASE, 'name': 'Untrusted'}, 'quote': {'address': QUOTE}}}


class MarketDataTests(unittest.TestCase):
    def adapter(self, response):
        transport = Mock(return_value=response)
        return GeckoMarketData(transport=transport, clock=lambda: NOW), transport

    def test_pool_binds_exact_chain_id_pool_and_sorted_currencies(self):
        adapter, transport = self.adapter(pool_response())
        result = adapter.pool(POOL.upper().replace('0X', '0x'))
        transport.assert_called_once_with(ROOT+'/pools/'+POOL, timeout=5)
        self.assertEqual(result['poolId'], POOL)
        self.assertEqual(result['currencies'], [QUOTE, BASE])
        self.assertEqual((result['baseToken'], result['quoteToken']), (BASE, QUOTE))
        self.assertEqual(result['reportedLiquidityUsd'], '12345.67')
        self.assertEqual(result['volume24hUsd'], '0')
        self.assertTrue(result['providerReported'])
        self.assertEqual(result['retrievedAt'], NOW)
        self.assertIsNone(result['asOfTimestamp']);self.assertIsNone(result['asOfBlock'])
        self.assertEqual(result['source'], 'geckoterminal')

    def test_pool_identity_mismatch_and_v3_length_are_rejected(self):
        for mutate in (lambda d: d.update(id='ethereum_'+POOL), lambda d: d.update(type='token'),
                       lambda d: d.update(id='robinhood_0x'+'34'*32),
                       lambda d: d['attributes'].update(address='0x'+'34'*32),
                       lambda d: d['attributes'].update(address=BASE)):
            raw = pool_response();mutate(raw['data'])
            with self.assertRaisesRegex(DataError, '^market_pool_identity_mismatch$'):
                self.adapter(raw)[0].pool(POOL)
        adapter, transport = self.adapter(pool_response())
        for invalid in (BASE, POOL+'/../other', None):
            with self.assertRaises(DataError): adapter.pool(invalid)
        transport.assert_not_called()

    def test_token_relationships_are_chain_and_address_bound(self):
        for data in ({'id': 'ethereum_'+BASE, 'type': 'token'}, {'id': 'robinhood_'+BASE, 'type': 'pool'},
                     {'id': 'robinhood_MARLIN', 'type': 'token'}, {'id': 'robinhood_'+POOL, 'type': 'token'}):
            raw = pool_response();raw['data']['relationships']['base_token']['data'] = data
            with self.assertRaisesRegex(DataError, '^market_currency_identity_mismatch$'):
                self.adapter(raw)[0].pool(POOL)
        raw = pool_response();raw['data']['relationships']['quote_token']['data']['id'] = 'robinhood_'+BASE
        with self.assertRaisesRegex(DataError, '^market_currency_identity_mismatch$'):
            self.adapter(raw)[0].pool(POOL)

    def test_native_address_and_conflicting_dex_labels_are_preserved_without_inference(self):
        raw = pool_response()
        raw['data']['relationships']['quote_token']['data']['id'] = 'robinhood_'+ZERO
        raw['data']['relationships']['dex']['data']['id'] = 'pons-v2-dex'
        result = self.adapter(raw)[0].pool(POOL)
        self.assertEqual(result['quoteToken'], ZERO)
        self.assertEqual(result['dexLabel'], 'pons-v2-dex')
        for inferred in ('feePips', 'apr', 'feeApr24h', 'compatible', 'name'):
            self.assertNotIn(inferred, result)
        raw['data']['relationships']['dex']['data']['id'] = '<script>untrusted</script>'
        self.assertEqual(self.adapter(raw)[0].pool(POOL)['dexLabel'], '<script>untrusted</script>')

    def test_missing_metrics_are_none_and_observed_zero_stays_zero(self):
        raw = pool_response();raw['data']['attributes'] = {'address': POOL}
        result = self.adapter(raw)[0].pool(POOL)
        self.assertIsNone(result['reportedLiquidityUsd']);self.assertIsNone(result['volume24hUsd'])
        raw['data']['attributes'].update(reserve_in_usd=0, volume_usd={'h24': None})
        self.assertEqual(self.adapter(raw)[0].pool(POOL)['reportedLiquidityUsd'], '0')

    def test_binary_floats_negative_nonfinite_and_unbounded_metrics_are_rejected(self):
        for value in (1.25, True, '-1', 'NaN', Decimal('NaN'), Decimal('Infinity'), '1e999999', '9'*129):
            raw = pool_response();raw['data']['attributes']['reserve_in_usd'] = value
            with self.subTest(value=value), self.assertRaisesRegex(DataError, '^invalid_market_number$'):
                self.adapter(raw)[0].pool(POOL)

    def test_hourly_candles_sort_ascending_and_preserve_exact_decimals(self):
        adapter, transport = self.adapter(hourly_response())
        result = adapter.hourly_prices(POOL)
        transport.assert_called_once_with(ROOT+'/pools/'+POOL+'/ohlcv/hour?aggregate=1&limit=24&currency=usd&token=base', timeout=5)
        self.assertEqual(result['currency'], BASE)
        self.assertEqual(result['selectedToken'], 'base')
        self.assertEqual([c['startTimestamp'] for c in result['candles']], [99*3600, 100*3600])
        self.assertEqual([c['closed'] for c in result['candles']], [True, False])
        self.assertEqual(result['candles'][0]['openUsd'], '1.000000000000000001')
        self.assertEqual(result['candles'][0]['volumeUsd'], '123.456789012345678901')
        self.assertEqual(result['fetchedAt'], NOW)
        self.assertFalse(result['coverage']['complete24h'])
        self.assertEqual(result['coverage']['completeness'], 'not_established')

    def test_quote_chart_is_bound_to_quote_address_not_name_or_canonical_order(self):
        adapter, transport = self.adapter(hourly_response())
        result = adapter.hourly_prices(POOL, token='quote')
        self.assertEqual(result['currency'], QUOTE)
        self.assertEqual(result['quoteToken'], QUOTE)
        self.assertIn('token=quote', transport.call_args.args[0])
        for token in ('usd', BASE, 'base&limit=1000', None):
            adapter, transport = self.adapter(hourly_response())
            with self.assertRaisesRegex(DataError, '^invalid_market_price_token$'):
                adapter.hourly_prices(POOL, token=token)
            transport.assert_not_called()

    def test_chart_requires_both_metadata_addresses_and_distinct_tokens(self):
        for mutate in (lambda d: d.pop('meta'), lambda d: d['meta'].pop('quote'),
                       lambda d: d['meta']['base'].update(address='MARLIN'),
                       lambda d: d['meta']['quote'].update(address=BASE)):
            raw = hourly_response();mutate(raw)
            with self.assertRaises(DataError): self.adapter(raw)[0].hourly_prices(POOL)

    def test_sparse_and_empty_histories_are_explicit_without_zero_fills(self):
        result = self.adapter(hourly_response([candle(95*3600), candle(99*3600)]))[0].hourly_prices(POOL)
        self.assertTrue(result['coverage']['gapsDetected'])
        self.assertEqual(len(result['candles']), 2)
        empty = self.adapter(hourly_response([]))[0].hourly_prices(POOL)
        self.assertEqual(empty['candles'], [])
        self.assertEqual(empty['coverage']['status'], 'missing')
        self.assertIsNone(empty['coverage']['firstTimestamp'])

    def test_duplicate_unaligned_future_and_excess_candles_are_rejected(self):
        for rows in ([candle(99*3600)]*2, [candle(99*3600+1)], [candle(101*3600)],
                     [candle(True)], [candle(-3600)], [candle(i*3600) for i in range(25)]):
            with self.assertRaisesRegex(DataError, '^invalid_market_candles$'):
                self.adapter(hourly_response(rows))[0].hourly_prices(POOL)

    def test_invalid_ohlc_and_missing_cells_do_not_become_partial_fake_candles(self):
        cases = []
        for index, value in ((1, '1.2'), (2, '.8'), (3, '1.1'), (4, '.8'),
                             (5, -1), (1, None), (1, 1.0)):
            row = candle(99*3600);row[index] = value;cases.append(row)
        cases += [candle(99*3600)[:-1], candle(99*3600)+[0]]
        for row in cases:
            with self.subTest(row=row), self.assertRaises(DataError):
                self.adapter(hourly_response([row]))[0].hourly_prices(POOL)

    def test_missing_or_wrong_response_shape_never_claims_empty_history(self):
        for raw in ({}, {'data': None}, {'data': {'type': 'pool'}},
                    {**hourly_response(), 'data': {'type': 'ohlcv_request_response', 'attributes': {}}}):
            with self.assertRaises(DataError): self.adapter(raw)[0].hourly_prices(POOL)

    def test_closed_flag_at_exact_hour_boundary_does_not_establish_rolling_day(self):
        raw = hourly_response([candle(t*3600) for t in range(76,100)])
        result = GeckoMarketData(transport=lambda *a, **k: raw, clock=lambda: 100*3600).hourly_prices(POOL)
        self.assertEqual(result['coverage']['closedCandles'], 24)
        self.assertFalse(result['coverage']['complete24h'])

    def test_network_failures_are_preserved_as_safe_errors(self):
        transport = Mock(side_effect=DataError('http_429'))
        with self.assertRaisesRegex(DataError, '^http_429$'):
            GeckoMarketData(transport=transport, clock=lambda: NOW).pool(POOL)
        self.assertEqual(transport.call_count, 1)

    def test_invalid_clock_is_rejected_before_network(self):
        for clock in (True, -1, float('inf'), float('nan'), 2**63, 2**10000):
            transport = Mock()
            with self.assertRaisesRegex(DataError, '^invalid_market_clock$'):
                GeckoMarketData(transport=transport, clock=lambda: clock).pool(POOL)
            transport.assert_not_called()


if __name__ == '__main__':
    unittest.main()
