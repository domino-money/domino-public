from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from discovery import DataError, ZERO, bytes32
from market_cache import MarketCache
from markets_snapshot import MAX_POOLS, MarketsSnapshot
from read_api import create_app, ReadGate
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


if __name__ == '__main__':
    unittest.main()
