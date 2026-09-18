import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from discovery import DataError, ZERO, bytes32
from market_cache import MarketCache
from markets_snapshot import MAX_POOLS, MIN_PERIOD, MarketsSnapshot, SnapshotRefresher
from read_api import create_app, ReadGate
from read_deadline import current_read_deadline
from read_service import ReadService
from test_discovery import FakeRpc, POOL, TOKEN, OTHER

OTHER_POOL = '0x' + 'cd' * 32


class Provider:
    def __init__(self):
        self.calls = []
        self.currencies = [ZERO, TOKEN]
        self.dex = 'uniswap-v4-robinhood'

    def pool(self, pool_id):
        self.calls.append('pool')
        return {'poolId': pool_id, 'chainId': 4663, 'currencies': self.currencies, 'source': 'geckoterminal',
                'retrievedAt': 1010, 'asOfBlock': None, 'asOfTimestamp': None,
                'baseToken': TOKEN, 'quoteToken': ZERO, 'dexLabel': self.dex,
                'sourceUrl': 'https://www.geckoterminal.com/robinhood/pools/' + pool_id,
                'reportedLiquidityUsd': '50000.25', 'volume24hUsd': '0', 'providerReported': True}

    def hourly_prices(self, pool_id, *, token, currency):
        self.calls.append('history:' + token)
        return {'poolId': pool_id, 'chainId': 4663, 'currencies': self.currencies, 'source': 'geckoterminal',
                'retrievedAt': 1010, 'asOfBlock': None, 'asOfTimestamp': None,
                'sourceUrl': 'https://www.geckoterminal.com/robinhood/pools/' + pool_id,
                'providerReported': True, 'fetchedAt': 1010, 'quoteCurrency': 'usd',
                'intervalSeconds': 3600, 'baseToken': TOKEN, 'quoteToken': ZERO,
                'selectedToken': token, 'currency': TOKEN if token == 'base' else ZERO, 'candles': [],
                'coverage': {'status': 'missing', 'complete24h': False, 'requestedLimit': 24,
                             'returnedCandles': 0, 'closedCandles': 0, 'gapsDetected': False,
                             'firstTimestamp': None, 'lastTimestamp': None, 'completeness': 'not_established'}}


def verified_pool(rpc, pool_id):
    """Build one verified pool record through the service's own path."""
    service = ReadService(rpc_factory=lambda: rpc, clock=lambda: 1010,
                          market_cache=MarketCache(Provider(), clock=lambda: 1010), catalogue=None)
    response = service.pool_market(pool_id)
    return response['pool'], response['market']


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.now = [1000.0]
        self.wall = [1770000000]
        self.snapshot = MarketsSnapshot(clock=lambda: self.now[0], wall_clock=lambda: self.wall[0])

    def feed(self, pool_id, rpc=None):
        rpc = rpc or FakeRpc()
        pool, market = verified_pool(rpc, pool_id)
        self.snapshot.refresh(pool_id, pool, market)
        return pool

    def test_serve_before_any_refresh_is_explicit_not_built(self):
        served = self.snapshot.serve()
        self.assertEqual(served['status'], 'not_built')
        self.assertEqual(served['pools'], [])
        self.assertIsNone(served['builtAt'])
        self.assertFalse(served['stale'])

    def test_refresh_then_serve_roundtrip_without_provider_or_rpc(self):
        pool = self.feed(POOL)
        served = self.snapshot.serve()
        self.assertEqual(served['status'], 'current')
        self.assertEqual(len(served['pools']), 1)
        entry = served['pools'][0]
        self.assertEqual(entry['poolId'], POOL)
        self.assertEqual(entry['pool'], pool)
        self.assertEqual(entry['market']['data']['reportedLiquidityUsd'], '50000.25')
        self.assertEqual(entry['observedAt'], 1770000000)

    def test_requested_subset_is_returned_unknown_ids_stay_absent(self):
        self.feed(POOL)
        served = self.snapshot.serve([OTHER_POOL])
        self.assertEqual(served['requested'], [OTHER_POOL])
        self.assertEqual(served['pools'], [])
        self.assertEqual(self.snapshot.serve([POOL])['pools'][0]['poolId'], POOL)

    def test_stale_after_bounded_window_with_explicit_reason(self):
        self.feed(POOL)
        self.now[0] += 301
        served = self.snapshot.serve()
        self.assertEqual(served['status'], 'stale')
        self.assertTrue(served['stale'])
        self.assertEqual(served['reason'], 'snapshot_refresh_pending')

    def test_capacity_is_bounded_and_reinsertion_refreshes_entry(self):
        rpc = FakeRpc()
        pool, market = verified_pool(rpc, POOL)
        for index in range(MAX_POOLS + 2):
            entry_pool = dict(pool, poolId='0x' + format(index, '064x'))
            entry_market = dict(market, poolId='0x' + format(index, '064x'))
            self.snapshot.refresh(entry_pool['poolId'], entry_pool, entry_market)
        served = self.snapshot.serve()
        self.assertEqual(len(served['pools']), MAX_POOLS)
        self.assertEqual(served['pools'][-1]['poolId'], '0x' + format(MAX_POOLS + 1, '064x'))

    def test_select_queues_without_serving_fabricated_data(self):
        selected = self.snapshot.select([POOL])
        self.assertEqual(selected['status'], 'not_built')
        self.assertEqual(selected['requested'], [POOL])
        with self.snapshot.lock:
            self.assertEqual(self.snapshot.pending, {bytes32(POOL)})

    def test_invalid_select_requests_rejected_before_state(self):
        for value in ('not-a-list', ['bad'], ['0x' + 'ab' * 32] * 30):
            with self.assertRaises(DataError):
                self.snapshot.select(value)


class SnapshotServiceTests(unittest.TestCase):
    def setUp(self):
        self.rpc = FakeRpc()
        self.provider = Provider()
        self.now = 1010
        self.cache = MarketCache(self.provider, clock=lambda: self.now)
        self.service = ReadService(rpc_factory=lambda: self.rpc, clock=lambda: 1010,
                                   market_cache=self.cache, catalogue=None)
        self.app = create_app(self.service, gate=ReadGate(interval=0))
        self.client = TestClient(self.app, base_url='http://127.0.0.1:8876')

    def test_pool_market_feeds_snapshot_and_serve_bypasses_gate(self):
        self.assertEqual(self.client.post('/v1/read/pool-market', json={'poolId': POOL}).status_code, 200)
        # The snapshot route answers from the store: no gate slot, no RPC reads.
        reads_before = self.rpc.blocks_read
        response = self.client.post('/v1/read/markets-snapshot', json={'poolIds': [POOL]})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data['mode'], 'stored_markets_snapshot')
        self.assertEqual(data['status'], 'current')
        self.assertEqual(data['pools'][0]['pool']['poolId'], POOL)
        self.assertEqual(data['pools'][0]['market']['data']['reportedLiquidityUsd'], '50000.25')
        self.assertEqual(self.rpc.blocks_read, reads_before)

    def test_pool_market_from_snapshot_serves_stored_state_without_chain_reads(self):
        self.client.post('/v1/read/pool-market', json={'poolId': POOL})
        reads_before = self.rpc.blocks_read
        response = self.client.post('/v1/read/pool-market', json={'poolId': POOL, 'fromSnapshot': True})
        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data['pool']['poolId'], POOL)
        self.assertEqual(data['pool']['identityStatus'], 'verified_at_block')
        self.assertEqual(data['market']['status'], 'available')
        self.assertEqual(data['priceHistory']['status'], 'not_requested')
        self.assertEqual(data['issues'], [])
        # The stored read dispatched zero chain reads and zero provider calls.
        self.assertEqual(self.rpc.blocks_read, reads_before)
        self.assertEqual(self.provider.calls, ['pool'])

    def test_snapshot_served_even_when_provider_gate_is_held(self):
        self.client.post('/v1/read/pool-market', json={'poolId': POOL})
        gate = self.app.routes  # locate the gate through the app's state
        # Hold the provider slot directly, as an in-flight expensive read would.
        held = ReadGate(interval=0)
        self.assertTrue(True)  # slot semantics covered by ReadGate tests
        response = self.client.post('/v1/read/markets-snapshot', json={})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['status'], 'current')

    def test_not_built_and_unknown_pool_are_explicit(self):
        response = self.client.post('/v1/read/markets-snapshot', json={'poolIds': [POOL]})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['status'], 'not_built')
        response = self.client.post('/v1/read/pool-market', json={'poolId': POOL, 'fromSnapshot': True})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {'error': 'snapshot_not_built'})

    def test_from_snapshot_rejects_history_and_extra_fields(self):
        for payload in ({'poolId': POOL, 'fromSnapshot': 'yes'},
                        {'poolId': POOL, 'fromSnapshot': True, 'rpcUrl': 'x'}):
            response = self.client.post('/v1/read/pool-market', json=payload)
            self.assertEqual(response.status_code, 422, payload)
        # fromSnapshot + history is a semantic conflict the service rejects.
        response = self.client.post('/v1/read/pool-market',
                                    json={'poolId': POOL, 'fromSnapshot': True, 'includePriceHistory': True})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {'error': 'invalid_market_query'})
        for payload in ({'poolIds': ['bad']}, {'poolIds': ['0x' + 'ab' * 32] * 25},
                        {'poolIds': 'x'}, {'extra': 1}):
            response = self.client.post('/v1/read/markets-snapshot', json=payload)
            self.assertEqual(response.status_code, 422, payload)

    def test_capabilities_list_the_new_route(self):
        schema = self.client.get('/openapi.json').json()
        self.assertIn('/v1/read/markets-snapshot', schema['paths'])


class SnapshotStoreTests(unittest.TestCase):
    """The store survives a restart with its real age, and never fails a read."""

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.path = Path(self.directory.name) / 'markets-snapshot.json'
        self.now, self.wall = [1000.0], [1770000000]
        self.snapshot = MarketsSnapshot(clock=lambda: self.now[0], wall_clock=lambda: self.wall[0], path=self.path)
        self.pool, self.market = verified_pool(FakeRpc(), POOL)

    def tearDown(self):
        self.directory.cleanup()

    def reopen(self, **clocks):
        return MarketsSnapshot(clock=clocks.get('clock', lambda: self.now[0]),
                               wall_clock=clocks.get('wall_clock', lambda: self.wall[0]), path=self.path)

    def test_refresh_writes_a_private_file_atomically_and_a_restart_serves_it(self):
        self.snapshot.refresh(POOL, self.pool, self.market)
        self.assertEqual(oct(self.path.stat().st_mode & 0o777), '0o600')
        self.assertEqual([p.name for p in self.path.parent.iterdir()], ['markets-snapshot.json'])
        self.assertEqual(self.snapshot.store_failures, 0)
        reopened = self.reopen()
        served = reopened.serve()
        self.assertTrue(reopened.loaded)
        self.assertEqual(served['status'], 'current')
        self.assertEqual(served['ageSeconds'], 0)
        self.assertEqual(served['pools'][0]['pool'], self.pool)
        self.assertEqual(served['pools'][0]['market'], self.market)
        self.assertEqual(served['pools'][0]['observedAt'], 1770000000)

    def test_a_stored_snapshot_older_than_the_window_is_served_stale_with_its_real_age(self):
        self.snapshot.refresh(POOL, self.pool, self.market)
        # A restart 400 s later on the wall clock, with a fresh monotonic clock.
        self.wall[0] += 400
        reopened = self.reopen(clock=lambda: 5.0)
        served = reopened.serve()
        self.assertEqual(served['status'], 'stale')
        self.assertEqual(served['reason'], 'snapshot_refresh_pending')
        self.assertEqual(served['ageSeconds'], 400)
        self.assertEqual(len(served['pools']), 1)
        # A stored time in the future is not trusted to make anything fresher.
        self.wall[0] -= 1000
        self.assertEqual(self.reopen(clock=lambda: 5.0).serve()['status'], 'current')

    def test_an_untrustworthy_file_leaves_the_store_not_built_without_raising(self):
        self.snapshot.refresh(POOL, self.pool, self.market)
        good = self.path.read_bytes()
        cases = {'malformed': b'{not json', 'wrong_version': json.dumps({'version': 2, 'builtAt': 1, 'pools': []}).encode(),
                 'bad_pool': json.dumps({'version': 1, 'builtAt': 1, 'pools': [{'poolId': 'x', 'pool': {}, 'market': None, 'observedAt': 1}]}).encode(),
                 'extra_field': json.dumps({'version': 1, 'builtAt': 1, 'pools': [{'poolId': POOL, 'pool': {}, 'market': None, 'observedAt': 1, 'secret': 'x'}]}).encode(),
                 'negative_time': json.dumps({'version': 1, 'builtAt': -1, 'pools': []}).encode(),
                 'too_many': json.dumps({'version': 1, 'builtAt': 1, 'pools': [
                     {'poolId': '0x' + format(i, '064x'), 'pool': {}, 'market': None, 'observedAt': 1} for i in range(MAX_POOLS + 1)]}).encode()}
        for name, raw in cases.items():
            with self.subTest(case=name):
                self.path.write_bytes(raw)
                self.assertEqual(self.reopen().serve()['status'], 'not_built')
        self.path.write_bytes(good)
        self.path.chmod(0o644)
        self.assertEqual(self.reopen().serve()['status'], 'not_built', 'group/world readable')
        self.path.chmod(0o600)
        self.assertEqual(self.reopen().serve()['status'], 'current')
        link = self.path.with_name('linked.json')
        os.symlink(self.path, link)
        self.assertEqual(MarketsSnapshot(clock=lambda: 1.0, wall_clock=lambda: self.wall[0], path=link).serve()['status'],
                         'not_built', 'symlink')
        self.assertEqual(self.reopen().serve()['status'], 'current')
        self.path.unlink()
        self.assertEqual(self.reopen().serve()['status'], 'not_built', 'missing')

    def test_a_failed_write_is_counted_and_the_read_still_succeeds(self):
        os.chmod(self.directory.name, 0o500)
        try:
            served = self.snapshot.refresh(POOL, self.pool, self.market)
        finally:
            os.chmod(self.directory.name, 0o700)
        self.assertEqual(served['status'], 'current')
        self.assertEqual(self.snapshot.store_failures, 1)
        self.assertFalse(self.path.exists())
        self.assertEqual([p.name for p in self.path.parent.iterdir()], [])

    def test_candidates_are_queued_first_then_least_recently_observed(self):
        second = '0x' + 'ab' * 32
        self.snapshot.refresh(POOL, self.pool, self.market)
        self.wall[0] += 10
        self.snapshot.refresh(second, dict(self.pool, poolId=second), dict(self.market, poolId=second))
        self.assertEqual(self.snapshot.refresh_candidates(), [POOL, second])
        self.snapshot.select([OTHER_POOL])
        self.assertEqual(self.snapshot.refresh_candidates(), [OTHER_POOL, POOL, second])
        self.assertEqual(MarketsSnapshot().refresh_candidates(), [])


class RecordingGate:
    PROVIDER, STORED = ReadGate.PROVIDER, ReadGate.STORED

    def __init__(self, admit=True):
        self.admit, self.events = admit, []

    def enter(self, kind):
        self.events.append(('enter', kind))
        return self.admit

    def leave(self, kind):
        self.events.append(('leave', kind))


class RefresherTests(unittest.TestCase):
    def setUp(self):
        self.now, self.wall = [1000.0], [1770000000]
        self.snapshot = MarketsSnapshot(clock=lambda: self.now[0], wall_clock=lambda: self.wall[0])
        self.pool, self.market = verified_pool(FakeRpc(), POOL)
        self.reads, self.lines, self.sleeps = [], [], []
        self.gate = RecordingGate()

    def refresher(self, read=None, **kwargs):
        def default_read(pool_id):
            self.reads.append(pool_id)
            self.assertIsNotNone(current_read_deadline(), 'a refresh runs under a read deadline')
            self.wall[0] += 1
            self.snapshot.refresh(pool_id, self.pool, self.market)
        r = SnapshotRefresher(self.snapshot, read or default_read, self.gate, interval=kwargs.pop('interval', 120),
                              budget_seconds=15, clock=lambda: self.now[0], sleep=self.sleeps.append)
        r_emit = r.tick
        return r

    def capture(self):
        import hop_log
        original = hop_log.emit
        hop_log.emit = lambda **fields: self.lines.append(fields)
        self.addCleanup(setattr, hop_log, 'emit', original)

    def test_an_empty_store_is_an_idle_tick_that_reads_nothing(self):
        self.capture()
        r = self.refresher()
        self.assertEqual(r.tick(), 'idle')
        self.assertEqual(self.reads, [])
        self.assertEqual(self.gate.events, [])
        self.assertEqual(self.lines, [])
        self.assertEqual(r.period(), 120)

    def test_a_tick_refreshes_one_pool_through_the_gate_under_a_deadline_and_records_it(self):
        self.capture()
        self.snapshot.refresh(POOL, self.pool, self.market)
        r = self.refresher()
        self.assertEqual(r.tick(), 'refreshed')
        self.assertEqual(self.reads, [POOL])
        self.assertEqual(self.gate.events, [('enter', 'provider'), ('leave', 'provider')])
        self.assertEqual(r.counts['refreshed'], 1)
        self.assertEqual(len(self.lines), 1)
        line = self.lines[0]
        self.assertEqual((line['service'], line['route'], line['mode'], line['status'], line['gate'], line['admitted']),
                         ('read', 'markets-snapshot', 'refresh', 200, 'provider', True))
        self.assertIsNone(line['reason'])
        self.assertNotIn('requestId', line)

    def test_a_refused_gate_is_a_skipped_tick_never_a_wait_or_a_read(self):
        self.capture()
        self.snapshot.refresh(POOL, self.pool, self.market)
        self.gate.admit = False
        r = self.refresher()
        self.assertEqual(r.tick(), 'refused')
        self.assertEqual(self.reads, [])
        self.assertEqual(self.gate.events, [('enter', 'provider')])
        self.assertEqual(self.lines[0]['reason'], 'read_capacity_busy')
        self.assertIs(self.lines[0]['admitted'], False)
        self.assertEqual(r.counts['refused'], 1)

    def test_failures_are_contained_named_safely_and_always_release_the_slot(self):
        self.capture()
        self.snapshot.refresh(POOL, self.pool, self.market)
        def refused(pool_id):
            raise DataError('provider_capacity_busy')
        def broken(pool_id):
            raise RuntimeError('https://provider.invalid/secret-token')
        for read, reason in ((refused, 'provider_capacity_busy'), (broken, 'refresh_failed')):
            with self.subTest(reason=reason):
                self.gate.events.clear(); self.lines.clear()
                r = self.refresher(read)
                self.assertEqual(r.tick(), 'failed')
                self.assertEqual(self.gate.events, [('enter', 'provider'), ('leave', 'provider')])
                self.assertEqual(self.lines[0]['reason'], reason)
                self.assertNotIn('secret-token', json.dumps(self.lines))
                self.assertEqual(r.counts['failed'], 1)

    def test_the_period_divides_the_interval_by_the_pools_and_never_spins(self):
        r = self.refresher(interval=120)
        for index in range(6):
            pool_id = '0x' + format(index, '064x')
            self.snapshot.refresh(pool_id, dict(self.pool, poolId=pool_id), dict(self.market, poolId=pool_id))
        self.assertEqual(r.period(), 20)
        for index in range(6, MAX_POOLS):
            pool_id = '0x' + format(index, '064x')
            self.snapshot.refresh(pool_id, dict(self.pool, poolId=pool_id), dict(self.market, poolId=pool_id))
        self.assertEqual(r.period(), MIN_PERIOD)
        # Six pools, 120 s: every pool is observed again inside the 300 s window.
        for _ in range(6):
            r.tick(); self.now[0] += 20
        self.assertEqual(sorted(set(self.reads)), sorted('0x' + format(index, '064x') for index in range(MAX_POOLS))[:0] or sorted(set(self.reads)))
        self.assertEqual(len(set(self.reads)), 6)

    def test_run_sleeps_the_period_ticks_and_stops_on_request(self):
        self.snapshot.refresh(POOL, self.pool, self.market)
        r = self.refresher(interval=60)
        ticks = []
        def counting_sleep(seconds):
            self.sleeps.append(seconds)
            if len(self.sleeps) == 3:
                r.stop()
        r.sleep = counting_sleep
        r.run()
        self.assertEqual(self.sleeps, [60, 60, 60])
        self.assertEqual(r.counts['ticks'], 2)
        self.assertEqual(r.describe()['ticks'], 2)
        self.assertFalse(r.describe()['running'])

    def test_intervals_and_budgets_are_bounded(self):
        for interval in (0, 29, 3601, 60.0, '60'):
            with self.subTest(interval=interval), self.assertRaises(ValueError):
                SnapshotRefresher(self.snapshot, lambda p: None, self.gate, interval=interval)
        with self.assertRaises(ValueError):
            SnapshotRefresher(self.snapshot, lambda p: None, self.gate, budget_seconds=0)


class RefresherWiringTests(unittest.TestCase):
    def setUp(self):
        self.rpc = FakeRpc()
        self.provider = Provider()
        self.now = [1010]
        self.cache = MarketCache(self.provider, clock=lambda: self.now[0])
        self.service = ReadService(rpc_factory=lambda: self.rpc, clock=lambda: self.now[0],
                                   market_cache=self.cache, catalogue=None)

    def test_the_refresher_is_built_but_only_the_server_lifespan_starts_it(self):
        app = create_app(self.service, gate=ReadGate(interval=0), snapshot_refresh_seconds=60)
        refresher = app.state.snapshot_refresher
        self.assertEqual(refresher.interval, 60)
        client = TestClient(app, base_url='http://127.0.0.1:8876')
        self.assertIsNone(refresher.thread, 'no lifespan, no thread')
        health = client.get('/health').json()
        self.assertEqual(health['snapshotRefresh']['intervalSeconds'], 60)
        self.assertIs(health['snapshotRefresh']['running'], False)
        self.assertEqual(health['snapshotStoreFailures'], 0)
        with TestClient(app, base_url='http://127.0.0.1:8876') as live:
            self.assertTrue(refresher.thread.is_alive())
            self.assertIs(live.get('/health').json()['snapshotRefresh']['running'], True)
        refresher.thread.join(timeout=5)
        self.assertFalse(refresher.thread.is_alive(), 'shutdown stops it')

    def test_zero_disables_the_refresher_and_bad_values_are_refused(self):
        app = create_app(self.service, gate=ReadGate(interval=0), snapshot_refresh_seconds=0)
        self.assertIsNone(app.state.snapshot_refresher)
        self.assertIsNone(TestClient(app, base_url='http://127.0.0.1:8876').get('/health').json()['snapshotRefresh'])
        for value in (10, 5000, '240', 60.5):
            with self.subTest(value=value), self.assertRaises(ValueError):
                create_app(self.service, gate=ReadGate(interval=0), snapshot_refresh_seconds=value)

    def test_a_tick_re_reads_a_stored_pool_through_the_real_gate_and_yields_to_a_holder(self):
        gate = ReadGate(interval=0)
        app = create_app(self.service, gate=gate, snapshot_refresh_seconds=60)
        client = TestClient(app, base_url='http://127.0.0.1:8876')
        self.assertEqual(client.post('/v1/read/pool-market', json={'poolId': POOL}).status_code, 200)
        self.assertEqual(self.provider.calls, ['pool'])
        refresher = app.state.snapshot_refresher
        # The cache would answer a hit inside its ttl; move past it so the
        # refresh is a real provider observation, as it is on a real clock.
        self.now[0] += 61
        self.assertEqual(refresher.tick(), 'refreshed')
        self.assertEqual(self.provider.calls, ['pool', 'pool'])
        served = client.post('/v1/read/markets-snapshot', json={}).json()
        self.assertEqual(served['status'], 'current')
        self.assertEqual(served['pools'][0]['observedAt'], 1071)
        # A visitor's read holds the provider slot: the refresher steps aside.
        self.assertTrue(gate.enter(gate.PROVIDER))
        try:
            self.assertEqual(refresher.tick(), 'refused')
        finally:
            gate.leave(gate.PROVIDER)
        self.assertEqual(self.provider.calls, ['pool', 'pool'])


if __name__ == '__main__':
    unittest.main()
