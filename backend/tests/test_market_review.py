"""Independent market association regressions; no live providers or database."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import CHAIN_ID, ZERO, DataError
from market_cache import MarketCache
from market_data import GeckoMarketData
from read_service import ReadService
from test_discovery import FakeRpc, POOL, TOKEN
import test_market_data as data_fixture
import test_pool_market as service_fixture


class ExactProvider(service_fixture.Provider):
    def __init__(self):
        super().__init__()
        self.pool_overrides, self.history_overrides = {}, {}
        self.history_error = False

    def pool(self, pool_id):
        return {**super().pool(pool_id), 'chainId': CHAIN_ID, **self.pool_overrides}

    def hourly_prices(self, pool_id, *, token):
        if self.history_error:
            raise DataError('http_503')
        return {**super().hourly_prices(pool_id, token=token), 'chainId': CHAIN_ID,
                'selectedToken': token, **self.history_overrides}


class MarketReviewTests(unittest.TestCase):
    def service(self, provider):
        self.cache = MarketCache(provider, clock=lambda: 1010)
        return ReadService(rpc_factory=FakeRpc, clock=lambda: 1010, market_cache=self.cache)

    def test_other_chain_cannot_attach_even_when_pool_and_currencies_match(self):
        provider = ExactProvider()
        provider.pool_overrides = {'chainId': 1}
        provider.history_overrides = {'chainId': 1}
        report = self.service(provider).pool_market(POOL, include_price_history=True)
        for kind in ('market', 'priceHistory'):
            self.assertIsNone(report[kind]['data'])
            self.assertNotEqual(report[kind]['status'], 'available')
        self.assertEqual(report['chainId'], CHAIN_ID)
        self.assertFalse(report['providerMetricsReconciled'])

    def test_chart_currency_must_match_requested_provider_side(self):
        for overrides in ({'currency': ZERO}, {'selectedToken': 'quote'},
                          {'baseToken': ZERO, 'quoteToken': ZERO}):
            provider = ExactProvider();provider.history_overrides = overrides
            with self.subTest(overrides=overrides):
                report = self.service(provider).pool_market(POOL, include_price_history=True, price_token='base')
                self.assertEqual(report['market']['status'], 'available')
                self.assertIsNone(report['priceHistory']['data'])
                self.assertNotEqual(report['priceHistory']['status'], 'available')

    def test_real_adapter_cannot_silently_switch_chart_side_from_pool_metadata(self):
        pool = data_fixture.pool_response()
        pool['data']['id'] = 'robinhood_'+POOL
        pool['data']['attributes']['address'] = POOL
        pool['data']['relationships']['base_token']['data']['id'] = 'robinhood_'+TOKEN
        pool['data']['relationships']['quote_token']['data']['id'] = 'robinhood_'+ZERO
        chart = data_fixture.hourly_response([])
        chart['meta']['base']['address'] = ZERO
        chart['meta']['quote']['address'] = TOKEN
        provider = GeckoMarketData(transport=lambda url, **kw: chart if '/ohlcv/' in url else pool,
                                   clock=lambda: 1010)
        report = self.service(provider).pool_market(POOL, include_price_history=True)
        self.assertEqual(report['market']['data']['baseToken'], TOKEN)
        self.assertIsNone(report['priceHistory']['data'])
        self.assertNotEqual(report['priceHistory']['status'], 'available')

    def test_known_other_dex_is_not_associated_with_canonical_uniswap_pool(self):
        for label in ('another-v4-manager', None):
            provider = ExactProvider();provider.dex = label
            with self.subTest(label=label):
                report = self.service(provider).pool_market(POOL, include_price_history=True)
                for kind in ('market', 'priceHistory'):
                    self.assertIsNone(report[kind]['data'])
                    self.assertNotEqual(report[kind]['status'], 'available')
                self.assertEqual(report['pool']['identityStatus'], 'verified_at_block')
                self.assertIsNone(report['feeApr24h'])
                self.assertEqual(provider.calls, ['pool'])

    def test_unexpected_source_and_missing_provider_pool_cannot_authorize_chart_association(self):
        for failure in ('wrong_source', 'pool_unavailable'):
            provider = ExactProvider()
            if failure == 'wrong_source': provider.pool_overrides = {'source': 'another_provider'}
            else: provider.error = True
            with self.subTest(failure=failure):
                report = self.service(provider).pool_market(POOL, include_price_history=True)
                self.assertIsNone(report['market']['data'])
                self.assertIsNone(report['priceHistory']['data'])
                self.assertEqual(provider.calls, ['pool'])

    def test_stale_cached_chart_cannot_attach_after_pool_base_quote_orientation_changes(self):
        provider = ExactProvider();service = self.service(provider)
        now = [1010]
        self.cache.clock = lambda: now[0]
        first = service.pool_market(POOL, include_price_history=True)
        self.assertEqual(first['priceHistory']['data']['currency'], TOKEN)
        now[0] += 61
        provider.pool_overrides = {'baseToken': ZERO, 'quoteToken': TOKEN}
        provider.history_error = True
        changed = service.pool_market(POOL, include_price_history=True)
        self.assertEqual(changed['market']['status'], 'available')
        self.assertEqual(changed['market']['data']['baseToken'], ZERO)
        self.assertIsNone(changed['priceHistory']['data'])
        self.assertNotEqual(changed['priceHistory']['status'], 'available')
        self.assertEqual(changed['priceHistory']['cache']['ageSeconds'], 61)

    def test_shared_request_limit_can_leave_chart_unavailable_without_erasing_pool_metrics(self):
        provider = ExactProvider();service = self.service(provider)
        for index in range(24):
            self.cache.get('pool', '0x'+format(index, '064x'))
        report = service.pool_market(POOL, include_price_history=True)
        self.assertEqual(report['market']['status'], 'available')
        self.assertEqual(report['market']['data']['volume24hUsd'], '0')
        self.assertEqual(report['priceHistory']['status'], 'unavailable')
        self.assertEqual(report['priceHistory']['reason'], 'provider_capacity_busy')
        self.assertIsNone(report['priceHistory']['data'])
        self.assertEqual(len(provider.calls), 25)
        self.assertIsNone(report['feeApr24h'])
        self.assertFalse(report['suggested'])
        self.assertFalse(report['executionAvailable'])


if __name__ == '__main__':
    unittest.main()
