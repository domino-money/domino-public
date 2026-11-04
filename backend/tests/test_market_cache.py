from pathlib import Path
from copy import deepcopy
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

    def held_call(self, pool_id):
        """A provider call for `pool_id` that stays in progress until the returned event is set."""
        entered, release = Event(), Event()
        original = self.provider.pool
        def read(requested):
            if requested == pool_id:
                entered.set()
                if not release.wait(3):
                    raise AssertionError('test coordination timeout')
            return original(requested)
        self.provider.pool = read
        results = []
        thread = Thread(target=lambda: results.append(self.cache.get('pool', pool_id)), daemon=True)
        thread.start()
        self.assertTrue(entered.wait(1))
        return thread, release, results

    def in_thread(self, *args, **kwargs):
        """A get that must answer within a second; it fails the test, not hangs it, when it waits."""
        results = []
        thread = Thread(target=lambda: results.append(self.cache.get(*args, **kwargs)), daemon=True)
        thread.start()
        thread.join(1)
        return results

    def test_a_hit_never_waits_for_a_provider_call_in_progress(self):
        # 3 Nov 2026 (launch): the reader runs 16 provider reads at once, and a hit queued behind any miss.
        cached = '0x' + 'cd' * 32
        self.cache.get('pool', cached)
        thread, release, results = self.held_call(POOL)
        try:
            hit, = self.in_thread('pool', cached)
            self.assertEqual((hit['status'], hit['cache']['status']), ('available', 'hit'))
            cache_only, = self.in_thread('pool', '0x' + 'ef' * 32, allow_provider=False)
            self.assertEqual(cache_only['cache']['status'], 'miss')
        finally:
            release.set()
            thread.join(3)
        self.assertEqual(results[0]['cache']['status'], 'miss')
        self.assertEqual(self.provider.calls, [('pool', cached), ('pool', POOL)])

    def test_a_refresh_answers_stale_rather_than_queue_behind_a_first_reading(self):
        known = '0x' + 'cd' * 32
        self.cache.get('pool', known)
        self.now += 61
        thread, release, results = self.held_call(POOL)
        first = []
        waiting = Thread(target=lambda: first.append(self.cache.get('pool', '0x' + 'ef' * 32)), daemon=True)
        try:
            # A pool already shown answers its stale value at once, as when the budget is spent...
            refresh, = self.in_thread('pool', known)
            self.assertEqual((refresh['status'], refresh['reason'], refresh['cache']['status']),
                             ('stale', 'provider_capacity_busy', 'rate_limited'))
            self.assertEqual(refresh['data']['reportedLiquidityUsd'], '1.23')
            # ...while a pool read for the first time, with nothing to show, takes its turn.
            waiting.start()
            waiting.join(0.2)
            self.assertEqual(first, [], 'a first reading waits for the call in progress')
        finally:
            release.set()
            thread.join(3)
            if waiting.ident is not None:
                waiting.join(3)
        self.assertEqual(first[0]['cache']['status'], 'miss')
        self.assertEqual(self.provider.calls, [('pool', known), ('pool', POOL), ('pool', '0x' + 'ef' * 32)])
        # With no call in progress, the refresh is made.
        self.assertEqual(self.cache.get('pool', known)['cache']['status'], 'miss')

    def test_invalid_input_is_rejected_before_provider(self):
        for kind, pool, token in [('pool', 'bad', 'base'), ('write', POOL, 'base'),
                                  ('hourly_prices', POOL, 'arbitrary')]:
            with self.assertRaises(DataError):
                self.cache.get(kind, pool, token=token)
        self.assertEqual(self.provider.calls, [])

    def stored_pool(self):
        value=self.cache.get('pool',POOL)
        value['data'].update(chainId=4663,source='geckoterminal')
        return value

    def test_restart_restores_original_age_and_attribution_without_refetching(self):
        stored=self.stored_pool();self.now+=45
        restarted=MarketCache(self.provider,clock=lambda:self.now)
        self.assertTrue(restarted.restore_pool(POOL,stored,elapsed_seconds=45))
        stored['data']['reportedLiquidityUsd']='mutated'
        value=restarted.get('pool',POOL)
        self.assertEqual(value['data']['reportedLiquidityUsd'],'1.23')
        self.assertEqual(value['data']['retrievedAt'],1000)
        self.assertEqual(value['cache']['ageSeconds'],45)
        self.assertEqual(len(self.provider.calls),1)
        # Repeated restarts preserve the age already accumulated before them.
        self.now+=30;again=MarketCache(self.provider,clock=lambda:self.now)
        self.assertTrue(again.restore_pool(POOL,value,elapsed_seconds=30))
        self.provider.error=DataError('http_429')
        stale=again.get('pool',POOL)
        self.assertEqual((stale['status'],stale['reason'],stale['cache']['ageSeconds']),
                         ('stale','provider_rate_limited',75))
        self.assertEqual(stale['data']['retrievedAt'],1000)
        self.now+=226
        self.assertIsNone(again.get('pool',POOL,allow_provider=False)['data'])
        self.assertEqual(len(self.provider.calls),2)

    def test_restore_refuses_rejected_expired_mismatched_or_existing_entries(self):
        stored=self.stored_pool()
        for change,elapsed in (({'status':'rejected'},0),({'status':'unavailable'},0),({},301)):
            with self.subTest(change=change,elapsed=elapsed):
                restarted=MarketCache(self.provider,clock=lambda:self.now)
                self.assertFalse(restarted.restore_pool(POOL,{**stored,**change},elapsed_seconds=elapsed))
        for field,value in (('chainId',1),('poolId','0x'+'cc'*32),('source','unverified')):
            bad=deepcopy(stored);bad['data'][field]=value
            self.assertFalse(MarketCache(self.provider).restore_pool(POOL,bad,elapsed_seconds=0))
        self.assertFalse(self.cache.restore_pool(POOL,stored,elapsed_seconds=0))

    def test_background_cache_only_never_reserves_quota_or_calls_provider(self):
        cache=MarketCache(self.provider,clock=lambda:self.now,
                          reserve_provider=lambda:self.fail('background reserved provider quota'))
        self.assertEqual(cache.get('pool',POOL,allow_provider=False)['status'],'unavailable')
        self.assertEqual(self.provider.calls,[])
        stored=self.stored_pool()
        self.assertTrue(cache.restore_pool(POOL,stored,elapsed_seconds=75))
        value=cache.get('pool',POOL,allow_provider=False)
        self.assertEqual((value['status'],value['cache']['ageSeconds']),('stale',75))
        self.assertEqual(value['data']['retrievedAt'],1000)
        self.assertEqual(len(self.provider.calls),1)


if __name__ == '__main__':
    unittest.main()
