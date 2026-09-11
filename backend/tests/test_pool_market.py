from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from discovery import DataError, ZERO
from market_cache import MarketCache
from read_api import create_app, ReadGate
from read_service import ReadService
from test_discovery import FakeRpc, POOL, TOKEN, OTHER


class Provider:
    def __init__(self):
        self.calls = []
        self.error = False
        self.currencies = [ZERO, TOKEN]
        self.dex = 'uniswap-v4-robinhood'

    def pool(self, pool_id):
        self.calls.append('pool')
        if self.error:
            raise DataError('http_503')
        return {'poolId': pool_id, 'chainId': 4663, 'currencies': self.currencies, 'source': 'geckoterminal',
                'retrievedAt': 1010, 'asOfBlock': None, 'asOfTimestamp': None,
                'baseToken': TOKEN, 'quoteToken': ZERO, 'dexLabel': self.dex,
                'sourceUrl': 'https://www.geckoterminal.com/robinhood/pools/' + pool_id,
                'reportedLiquidityUsd': '50000.25', 'volume24hUsd': '0', 'providerReported': True}

    def hourly_prices(self, pool_id, *, token):
        self.calls.append('history:' + token)
        return {'poolId': pool_id, 'chainId': 4663, 'currencies': self.currencies, 'source': 'geckoterminal',
                'retrievedAt': 1010, 'asOfBlock': None, 'asOfTimestamp': None,
                'sourceUrl': 'https://www.geckoterminal.com/robinhood/pools/' + pool_id,
                'providerReported': True, 'fetchedAt': 1010, 'quoteCurrency': 'usd',
                'intervalSeconds': 3600,
                'baseToken': TOKEN, 'quoteToken': ZERO,
                'selectedToken': token,
                'currency': TOKEN if token == 'base' else ZERO, 'candles': [],
                'coverage': {'status': 'missing', 'complete24h': False, 'requestedLimit': 24,
                             'returnedCandles': 0, 'closedCandles': 0, 'gapsDetected': False,
                             'firstTimestamp': None, 'lastTimestamp': None, 'completeness': 'not_established'}}


class PoolMarketTests(unittest.TestCase):
    def setUp(self):
        self.rpc = FakeRpc()
        self.provider = Provider()
        self.now = 1010
        self.cache = MarketCache(self.provider, clock=lambda: self.now)
        self.service = ReadService(rpc_factory=lambda: self.rpc, clock=lambda: 1010,
                                  market_cache=self.cache, catalogue=None)
        self.app = create_app(self.service, gate=ReadGate(interval=0))
        self.client = TestClient(self.app, base_url='http://127.0.0.1:8876')

    def read(self, **fields):
        return self.client.post('/v1/read/pool-market', json={'poolId': POOL, **fields})

    def test_unknown_to_database_pool_has_current_identity_and_provider_metrics(self):
        response = self.read()
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertFalse(data['requiresLocalHistory'])
        self.assertEqual(data['pool']['identityStatus'], 'verified_at_block')
        self.assertEqual(data['market']['data']['reportedLiquidityUsd'], '50000.25')
        self.assertEqual(data['market']['data']['volume24hUsd'], '0')
        self.assertIsNone(data['market']['data']['asOfBlock'])
        self.assertEqual(data['priceHistory']['status'], 'not_requested')
        self.assertIsNone(data['feeApr24h'])
        self.assertFalse(data['executionAvailable'])
        self.assertEqual(response.headers['cache-control'], 'no-store')
        self.assertEqual(self.provider.calls, ['pool'])

    def test_provider_cache_reuse_still_rechecks_current_chain_state(self):
        self.read()
        reads_before = self.rpc.blocks_read
        self.now += 10
        data = self.read().json()
        self.assertEqual(data['market']['cache']['status'], 'hit')
        self.assertEqual(self.provider.calls, ['pool'])
        self.assertGreater(self.rpc.blocks_read, reads_before)

    def test_missing_history_and_selected_currency_are_explicit(self):
        data = self.read(includePriceHistory=True, priceToken='quote').json()
        self.assertEqual(data['priceHistory']['data']['currency'], ZERO)
        self.assertEqual(data['priceHistory']['data']['coverage']['status'], 'missing')
        self.assertFalse(data['priceHistory']['data']['coverage']['complete24h'])
        self.assertEqual(self.provider.calls, ['pool', 'history:quote'])

    def test_provider_failure_preserves_readable_pool_and_can_use_stale_observation(self):
        self.provider.error = True
        data = self.read().json()
        self.assertEqual(data['market']['status'], 'unavailable')
        self.assertIsNone(data['market']['data'])
        self.assertEqual(data['pool']['poolId'], POOL)
        self.now += 16
        self.provider.error = False
        self.read()
        self.now += 61
        self.provider.error = True
        data = self.read().json()
        self.assertEqual(data['market']['status'], 'stale')
        self.assertEqual(data['market']['cache']['ageSeconds'], 61)
        self.assertFalse(data['providerMetricsReconciled'])

    def test_provider_pair_mismatch_cannot_attach_metrics_or_chart_to_pool(self):
        self.provider.currencies = [ZERO, OTHER]
        data = self.read(includePriceHistory=True).json()
        self.assertEqual(data['market']['status'], 'rejected')
        self.assertEqual(data['market']['reason'], 'provider_currency_or_pool_mismatch')
        self.assertIsNone(data['market']['data'])
        self.assertEqual(data['priceHistory']['reason'], 'provider_market_identity_unavailable')
        self.assertEqual(self.provider.calls, ['pool'])
        self.assertEqual(data['pool']['currencies'], [ZERO, TOKEN])

    def test_dex_label_conflict_is_visible_without_overriding_chain_identity(self):
        self.provider.dex = 'another-dex'
        data = self.read().json()
        self.assertIn('provider_dex_label_unconfirmed', data['issues'])
        self.assertEqual(data['market']['status'], 'rejected')
        self.assertIsNone(data['market']['data'])
        self.assertFalse(data['suggested'])
        self.assertEqual(data['pool']['identityStatus'], 'verified_at_block')

    def test_confirmed_reorg_rejects_even_cached_market_response(self):
        self.read()
        self.rpc.reorg = True
        self.rpc.blocks_read = 0  # Change the hash between this read's two headers.
        response = self.read()
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {'error': 'snapshot_reorganized'})

    def test_http_boundary_rejects_extra_fields_origins_and_nonexact_types(self):
        for payload in ({'poolId': TOKEN}, {'poolId': POOL, 'includePriceHistory': 'true'},
                        {'poolId': POOL, 'priceToken': 'arbitrary'},
                        {'poolId': POOL, 'rpcUrl': 'https://private.invalid'},
                        {'poolId': POOL, 'chainId': 1}, {'poolId': POOL, 'apiKey': 'secret'}):
            response = self.client.post('/v1/read/pool-market', json=payload)
            self.assertEqual(response.status_code, 422)
            self.assertEqual(response.json(), {'error': 'invalid_request'})
        response = self.client.post('/v1/read/pool-market', json={'poolId': POOL},
                                    headers={'Origin': 'https://domino.example'})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.rpc.blocks_read, 0)
        self.assertEqual(self.provider.calls, [])

    def test_capabilities_keep_estimates_and_execution_separate(self):
        data = self.client.get('/v1/capabilities').json()
        self.assertFalse(data['onDemandPoolMarket']['requiresLocalHistory'])
        self.assertFalse(data['feeApr'])
        self.assertFalse(data['ownerTransactions'])
        self.assertFalse(data['automation'])


if __name__ == '__main__':
    unittest.main()
