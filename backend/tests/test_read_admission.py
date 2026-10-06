"""Actual read work controls admission, independently of provider latency."""
import asyncio
from copy import deepcopy
import json
from pathlib import Path
import sys
import threading
import time
import unittest
from unittest.mock import patch

sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]
from fastapi.testclient import TestClient
import httpx
from bridge_state import ClientBudgets
from market_cache import MarketCache
from read_api import ReadGate, create_app, public_gate
from read_contract import CONTRACT_VERSION
from read_gateway import Gateway, LocalReaderHTTP, create_gateway
from read_service import ReadService
from test_bridge_identity import IdentityFixtures
from test_discovery import FakeRpc, POOL, TOKEN
from test_markets_snapshot import Provider

FIXTURES = Path(__file__).resolve().parents[2] / 'api-contracts/read-v1/fixtures/producer'
GENERATION = '0123456789abcdef' * 2


class ReadAdmissionTests(IdentityFixtures, unittest.TestCase):
    def setUp(self):
        self.rpc, self.provider = FakeRpc(), Provider()
        self.service = ReadService(rpc_factory=lambda: self.rpc, clock=lambda: 1010,
                                  market_cache=MarketCache(self.provider, clock=lambda: 1010))
        catalogue = json.loads((FIXTURES / 'catalogue.success.json').read_text())
        self.service.catalogue_page = lambda *args, **kwargs: deepcopy(catalogue)
        self.reader_gate, self.gateway_gate = ReadGate(interval=0), ReadGate(interval=0)
        self.reader = TestClient(create_app(self.service, gate=self.reader_gate, read_budget_seconds=15,
                                           snapshot_refresh_seconds=0), base_url='http://127.0.0.1:8876')
        self.gateway = Gateway(enabled=True, enabled_reads=('catalogue', 'markets-snapshot', 'token',
                              'pool-market', 'pool-metrics'), verifier=self.verifier(),
                              upstream=LocalReaderHTTP(client=self.reader), gate=self.gateway_gate,
                              budgets=ClientBudgets(burst=500))
        self.client = TestClient(create_gateway(self.gateway), base_url='http://127.0.0.1:8878',
                                 client=('127.0.0.1', 40000))
        self.headers = {'Cf-Access-Jwt-Assertion': self.token(), 'X-Domino-Client-Id': '192.0.2.1'}
        self.addCleanup(self.reader.close)
        self.addCleanup(self.client.close)

    def post(self, route, body, *, reader=False, headers=None):
        if reader:
            return self.reader.post('/v1/read/' + route, json=body)
        return self.client.post('/internal/read/v1/' + route, json=body,
                                headers=self.headers if headers is None else headers)

    def test_stored_routes_survive_provider_work_and_own_lanes_remain_bounded(self):
        for route, body in [('catalogue', {'token': TOKEN}), ('markets-snapshot', {})]:
            for held_gate in (self.reader_gate, self.gateway_gate):
                for kind, expected in [(ReadGate.PROVIDER, 200), (ReadGate.STORED, 429)]:
                    with self.subTest(route=route, reader=held_gate is self.reader_gate, kind=kind):
                        self.assertTrue(held_gate.enter(kind))
                        try:
                            response = self.post(route, body)
                            self.assertEqual(response.status_code, expected, response.text)
                            if expected == 429:
                                self.assertEqual(response.json(), {'error': 'read_capacity_busy'})
                                self.assertTrue(1 <= int(response.headers['Retry-After']) <= 10)
                        finally:
                            held_gate.leave(kind)
                        self.assertEqual(self.post(route, body).status_code, 200)
        self.assertEqual(self.rpc.blocks_read, 0)
        self.assertEqual(self.provider.calls, [])

    def test_snapshot_reader_itself_uses_bounded_stored_capacity(self):
        self.assertTrue(self.reader_gate.enter(ReadGate.STORED))
        try:
            response = self.post('markets-snapshot', {}, reader=True)
            self.assertEqual(response.status_code, 429)
            self.assertEqual(response.headers['cache-control'], 'no-store')
        finally:
            self.reader_gate.leave(ReadGate.STORED)
        response = self.post('markets-snapshot', {}, reader=True)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['cache-control'], 'no-store')

    def test_snapshot_variant_bypasses_only_provider_work_without_hidden_fallback(self):
        self.service.pool_market(POOL)
        before = self.rpc.blocks_read, list(self.provider.calls)
        self.assertTrue(self.reader_gate.enter(ReadGate.PROVIDER))
        self.assertTrue(self.gateway_gate.enter(ReadGate.PROVIDER))
        try:
            for direct in (True, False):
                response = self.post('pool-market', {'poolId': POOL, 'fromSnapshot': True}, reader=direct)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()['poolId'], POOL)
                missing = self.post('pool-market', {'poolId': '0x' + 'ab' * 32, 'fromSnapshot': True}, reader=direct)
                self.assertEqual((missing.status_code, missing.json()), (503, {'error': 'snapshot_not_built'}))
                self.assertEqual(self.post('pool-market', {'poolId': POOL}, reader=direct).status_code, 429)
                self.assertEqual(self.post('pool-market', {'poolId': POOL, 'fromSnapshot': 'true'}, reader=direct).status_code, 422)
        finally:
            self.gateway_gate.leave(ReadGate.PROVIDER)
            self.reader_gate.leave(ReadGate.PROVIDER)
        self.assertEqual((self.rpc.blocks_read, self.provider.calls), before)

    def test_pool_metrics_canonicality_work_is_not_admitted_as_stored(self):
        metrics = json.loads((FIXTURES / 'pool-metrics.qualified.json').read_text())
        with patch.object(self.service, 'pool_metrics', return_value=metrics) as operation:
            for direct in (True, False):
                gate = self.reader_gate if direct else self.gateway_gate
                self.assertTrue(gate.enter(ReadGate.PROVIDER))
                try:
                    self.assertEqual(self.post('pool-metrics', {'poolId': POOL}, reader=direct).status_code, 429)
                    operation.assert_not_called()
                finally:
                    gate.leave(ReadGate.PROVIDER)
            self.assertTrue(self.reader_gate.enter(ReadGate.STORED))
            self.assertTrue(self.gateway_gate.enter(ReadGate.STORED))
            try:
                self.assertEqual(self.post('pool-metrics', {'poolId': POOL}).status_code, 200)
                operation.assert_called_once_with(POOL)
            finally:
                self.gateway_gate.leave(ReadGate.STORED)
                self.reader_gate.leave(ReadGate.STORED)

    def test_stored_health_uses_its_own_busy_flag_and_retry_hint(self):
        original = self.gateway.upstream.request
        def request(route, body=None, *, deadline, request_id=None):
            result = original(route, body, deadline=deadline, request_id=request_id)
            if route == 'health':
                result[1].update(busy=False, retryAfterSeconds=10,
                                 storedBusy=True, storedRetryAfterSeconds=3)
            else:
                self.fail('a held reader stored lane must not receive a read')
            return result
        self.gateway.upstream.request = request
        response = self.post('markets-snapshot', {})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers['Retry-After'], '3')

    def test_legacy_health_does_not_make_provider_busy_a_stored_veto(self):
        original = self.gateway.upstream.request
        def request(route, body=None, *, deadline, request_id=None):
            result = original(route, body, deadline=deadline, request_id=request_id)
            if route == 'health':
                result[1].update(busy=True, retryAfterSeconds=10)
                result[1].pop('storedBusy')
                result[1].pop('storedRetryAfterSeconds')
            return result
        self.gateway.upstream.request = request
        self.assertEqual(self.post('markets-snapshot', {}).status_code, 200)
        self.assertEqual(self.post('token', {'token': TOKEN}).status_code, 429)

    def test_invalid_stored_health_is_unavailable_not_silently_idle(self):
        original = self.gateway.upstream.request
        def request(route, body=None, *, deadline, request_id=None):
            result = original(route, body, deadline=deadline, request_id=request_id)
            if route == 'health':
                result[1]['storedBusy'] = 'false'
            return result
        self.gateway.upstream.request = request
        self.assertEqual(self.post('markets-snapshot', {}).status_code, 503)

    def test_dispatch_failure_releases_only_the_admitted_stored_slot(self):
        self.assertTrue(self.gateway_gate.enter(ReadGate.PROVIDER))
        try:
            with patch('read_gateway.anyio.to_thread.run_sync', side_effect=RuntimeError('dispatch failed')):
                self.assertEqual(self.post('markets-snapshot', {}).status_code, 503)
            self.assertFalse(self.gateway_gate.slot.acquire(blocking=False))
            self.assertEqual(self.post('markets-snapshot', {}).status_code, 200)
        finally:
            self.gateway_gate.leave(ReadGate.PROVIDER)

    def test_a_visitor_has_a_budget_per_lane_stored_reads_far_more(self):
        # 6 Oct 2026: one visitor's New position asked 9 reads in 2 s; a single budget of 5 refused 18 of his 82.
        from read_gateway import VISITOR_BUDGETS
        self.assertEqual(VISITOR_BUDGETS, {ReadGate.STORED: (30, 240), ReadGate.PROVIDER: (12, 60)})
        now = [time.monotonic()]  # the reader's transport bounds its calls by the real clock
        gateway = Gateway(enabled=True, enabled_reads=('catalogue', 'markets-snapshot', 'token'),
                          verifier=self.verifier(), upstream=LocalReaderHTTP(client=self.reader),
                          gate=ReadGate(interval=0), clock=lambda: now[0])
        client = TestClient(create_gateway(gateway), base_url='http://127.0.0.1:8878', client=('127.0.0.1', 40000))
        self.addCleanup(client.close)

        def post(route, body, visitor='192.0.2.1'):
            return client.post('/internal/read/v1/' + route, json=body,
                               headers={**self.headers, 'X-Domino-Client-Id': visitor})
        for _ in range(30):
            self.assertEqual(post('markets-snapshot', {}).status_code, 200)
        refused = post('markets-snapshot', {})
        self.assertEqual((refused.status_code, refused.json(), refused.headers['Retry-After']),
                         (429, {'error': 'read_capacity_busy'}, '1'))  # four stored reads a second come back
        # The stored lane spent nothing of the provider lane's, nor another visitor's.
        for _ in range(12):
            self.assertEqual(post('token', {'token': TOKEN}).status_code, 200)
        self.assertEqual(post('token', {'token': TOKEN}).status_code, 429)
        self.assertEqual(post('markets-snapshot', {}, visitor='192.0.2.2').status_code, 200)
        now[0] += 1  # a second later: one provider read, four stored
        self.assertEqual(post('token', {'token': TOKEN}).status_code, 200)
        self.assertEqual(post('token', {'token': TOKEN}).status_code, 429)
        self.assertEqual([post('markets-snapshot', {}).status_code for _ in range(5)], [200] * 4 + [429])

    def test_stored_reads_still_require_identity_and_share_client_budget(self):
        self.gateway.budgets = ClientBudgets(burst=1, per_minute=30)
        self.assertEqual(self.post('markets-snapshot', {}, headers={}).status_code, 403)
        self.assertEqual(self.post('markets-snapshot', {}).status_code, 200)
        response = self.post('catalogue', {'token': TOKEN})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.headers['Retry-After'], '2')



class MeetingReader:
    """A reader that answers only once `parties` reads are inside it at the same time."""
    def __init__(self, parties):
        self.meeting = threading.Barrier(parties, timeout=5)
        self.answers = {route: json.loads((FIXTURES / f'{route}.success.json').read_text())
                        for route in ('token', 'markets-snapshot')}

    def request(self, route, body=None, *, deadline, request_id=None, version='v1'):
        metadata = {'generation': GENERATION, 'contract': CONTRACT_VERSION}
        if route == 'health':
            return 200, {'mode': 'local_read_only', 'status': 'ok', 'readBudgetSeconds': 15, 'busy': False,
                         'storedBusy': False, 'generation': GENERATION}, metadata
        self.meeting.wait()
        return 200, deepcopy(self.answers[route]), metadata


class GatewayWorkerTests(IdentityFixtures, unittest.TestCase):
    def gateway(self, gate, upstream=None):
        return Gateway(enabled=True, enabled_reads=('token', 'markets-snapshot'), verifier=self.verifier(),
                       upstream=upstream or MeetingReader(1), gate=gate, budgets=ClientBudgets(burst=500))

    def test_every_read_the_gate_admits_runs_at_once(self):
        gate = public_gate()
        lanes = gate.provider_capacity + gate.stored_capacity
        app = create_gateway(self.gateway(gate, MeetingReader(lanes)))
        headers = {'Cf-Access-Jwt-Assertion': self.token(), 'X-Domino-Client-Id': '192.0.2.1'}

        async def burst():
            transport = httpx.ASGITransport(app=app, client=('127.0.0.1', 40000))
            async with httpx.AsyncClient(transport=transport, base_url='http://127.0.0.1:8878') as client:
                reads = [client.post('/internal/read/v1/token', json={'token': TOKEN}, headers=headers)
                         for _ in range(gate.provider_capacity)]
                reads += [client.post('/internal/read/v1/markets-snapshot', json={}, headers=headers)
                          for _ in range(gate.stored_capacity)]
                return await asyncio.gather(*reads)
        responses = asyncio.run(burst())
        self.assertEqual([response.status_code for response in responses], [200] * lanes,
                         [response.text for response in responses if response.status_code != 200][:1])

    def test_worker_pool_matches_the_lanes_of_each_gate(self):
        for gate, workers in ((public_gate(), 20), (ReadGate(), 2),
                              (ReadGate(provider_capacity=3, stored_capacity=2), 5)):
            with self.subTest(workers=workers):
                app = create_gateway(self.gateway(gate))
                self.assertEqual(app.state.worker_limiter.total_tokens, workers)


if __name__ == '__main__':
    unittest.main()
