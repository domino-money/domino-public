from pathlib import Path
import sys
from threading import Event, Thread
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import DataError
from market_cache import MarketCache

POOL = '0x' + 'ab' * 32
TOKEN = '0x' + '11' * 20
OTHER = '0x' + '22' * 20


class Provider:
    def __init__(self):
        self.calls = []
        self.error = None

    def pool(self, pool_id):
        self.calls.append(('pool', pool_id))
        if self.error:
            raise self.error
        return {'poolId': pool_id, 'reportedLiquidityUsd': '1.23', 'retrievedAt': 1000}

    def hourly_prices(self, pool_id, *, token, currency):
        self.calls.append(('hourly_prices', pool_id, token, currency))
        return {'poolId': pool_id, 'selectedToken': token, 'candles': []}


class MarketCacheTests(unittest.TestCase):
    def setUp(self):
        self.now = 1000.0
        self.provider = Provider()
        self.cache = MarketCache(self.provider, clock=lambda: self.now)

    def test_cache_hit_preserves_original_time_and_cannot_be_mutated(self):
        first = self.cache.get('pool', POOL)
        first['data']['reportedLiquidityUsd'] = 'tampered'
        self.now += 59
        second = self.cache.get('pool', POOL)
        self.assertEqual(second['data']['reportedLiquidityUsd'], '1.23')
        self.assertEqual(second['data']['retrievedAt'], 1000)
        self.assertEqual(second['cache']['ageSeconds'], 59)
        self.assertEqual(second['cache']['status'], 'hit')
        self.assertEqual(len(self.provider.calls), 1)
        self.now += 1
        self.assertEqual(self.cache.get('pool', POOL)['cache']['status'], 'miss')
        self.assertEqual(len(self.provider.calls), 2)

    def test_failure_retains_stale_values_then_expires_without_zeroes(self):
        self.cache.get('pool', POOL)
        self.now += 61
        self.provider.error = DataError('http_429')
        stale = self.cache.get('pool', POOL)
        self.assertEqual(stale['status'], 'stale')
        self.assertEqual(stale['reason'], 'provider_rate_limited')
        self.assertEqual(stale['data']['reportedLiquidityUsd'], '1.23')
        self.now += 1
        self.assertEqual(self.cache.get('pool', POOL)['cache']['status'], 'cooldown')
        self.assertEqual(len(self.provider.calls), 2)
        self.now = 1301
        expired = self.cache.get('pool', POOL)
        self.assertEqual(expired['status'], 'unavailable')
        self.assertIsNone(expired['data'])

    def test_unknown_key_failure_is_cached_and_sanitized(self):
        self.provider.error = RuntimeError('secret-provider-body')
        report = self.cache.get('pool', POOL)
        self.assertEqual(report['status'], 'unavailable')
        self.assertEqual(report['reason'], 'provider_unavailable')
        self.assertNotIn('secret', str(report))
        self.now += 1
        self.cache.get('pool', POOL)
        self.assertEqual(len(self.provider.calls), 1)
        self.now += 15
        self.provider.error = None
        self.assertEqual(self.cache.get('pool', POOL)['status'], 'available')

    def test_pool_and_each_chart_currency_have_separate_entries(self):
        self.cache.get('pool', POOL)
        self.cache.get('pool', POOL, token='quote')
        self.cache.get('hourly_prices', POOL, currency=TOKEN)
        self.cache.get('hourly_prices', POOL, token='quote', currency=OTHER)
        self.assertEqual(len(self.provider.calls), 3)

    def test_rate_budget_is_shared_across_keys_without_sleeping(self):
        for i in range(25):
            self.cache.get('pool', '0x' + format(i, '064x'))
        report = self.cache.get('hourly_prices', POOL, currency=TOKEN)
        self.assertEqual(report['reason'], 'provider_capacity_busy')
        self.assertIsNone(report['data'])
        self.assertEqual(len(self.provider.calls), 25)
        self.now += 60
        self.assertEqual(self.cache.get('hourly_prices', POOL, currency=TOKEN)['status'], 'available')

    def test_capacity_is_bounded_and_lru_hits_keep_entries(self):
        self.cache.capacity = 2
        self.cache.get('pool', POOL)
        self.cache.get('hourly_prices', POOL, currency=TOKEN)
        self.cache.get('pool', POOL)
        self.cache.get('hourly_prices', POOL, token='quote', currency=OTHER)
        self.assertEqual(len(self.cache.entries), 2)
        self.cache.get('pool', POOL)
        self.assertEqual(len(self.provider.calls), 3)
        self.cache.get('hourly_prices', POOL, currency=TOKEN)
        self.assertEqual(len(self.provider.calls), 4)

    def test_concurrent_identical_reads_make_one_provider_request(self):
        entered, release = Event(), Event()
        original = self.provider.pool
        def read(pool_id):
            entered.set()
            if not release.wait(2):
                raise AssertionError('test coordination timeout')
            return original(pool_id)
        self.provider.pool = read
        results = []
        threads = [Thread(target=lambda: results.append(self.cache.get('pool', POOL))) for _ in range(2)]
        threads[0].start()
        try:
            self.assertTrue(entered.wait(1))
            threads[1].start()
        finally:
            release.set()
            for thread in threads:
                if thread.ident is not None:
                    thread.join(3)
        self.assertEqual(len(self.provider.calls), 1)
        self.assertEqual(sorted(r['cache']['status'] for r in results), ['hit', 'miss'])

    def test_invalid_input_is_rejected_before_provider(self):
        for kind, pool, token in [('pool', 'bad', 'base'), ('write', POOL, 'base'),
                                  ('hourly_prices', POOL, 'arbitrary')]:
            with self.assertRaises(DataError):
                self.cache.get(kind, pool, token=token)
        self.assertEqual(self.provider.calls, [])


if __name__ == '__main__':
    unittest.main()
