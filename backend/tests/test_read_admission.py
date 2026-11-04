"""Actual read work controls admission, independently of provider latency."""
import asyncio
from contextlib import redirect_stderr
from copy import deepcopy
import io
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

    def test_the_reader_s_stored_read_waits_for_a_lane_that_frees(self):
        # 3 Nov 2026 (launch): it was refused at once, against a lane free a few milliseconds later.
        gate = ReadGate(interval=0, stored_capacity=1, stored_interval=0, stored_wait=1)
        reader = TestClient(create_app(self.service, gate=gate, read_budget_seconds=15, snapshot_refresh_seconds=0),
                            base_url='http://127.0.0.1:8876')
        self.addCleanup(reader.close)
        self.assertTrue(gate.enter(ReadGate.STORED))
        freed = threading.Timer(0.2, gate.leave, (ReadGate.STORED,))
        freed.start()
        started = time.monotonic()
        response = reader.post('/v1/read/markets-snapshot', json={})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertGreaterEqual(time.monotonic() - started, 0.2)
        freed.join()
        # A lane held past the wait: refused after it, with the gate's own Retry-After.
        self.assertTrue(gate.enter(ReadGate.STORED))
        try:
            response = reader.post('/v1/read/markets-snapshot', json={})
            self.assertEqual((response.status_code, response.json()), (429, {'error': 'read_capacity_busy'}))
            self.assertTrue(1 <= int(response.headers['Retry-After']) <= 10)
        finally:
            gate.leave(ReadGate.STORED)
        self.assertEqual((gate.stored_inflight, gate.stored_waiting), (0, 0))

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
        self.assertEqual(VISITOR_BUDGETS, {ReadGate.STORED: (30, 240), ReadGate.PROVIDER: (30, 300)})
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
        from read_gateway import VISITOR_BUDGETS
        burst, per_minute = VISITOR_BUDGETS[ReadGate.PROVIDER]
        for _ in range(burst):
            self.assertEqual(post('token', {'token': TOKEN}).status_code, 200)
        self.assertEqual(post('token', {'token': TOKEN}).status_code, 429)
        self.assertEqual(post('markets-snapshot', {}, visitor='192.0.2.2').status_code, 200)
        now[0] += 1  # a second later: a second's worth of provider reads, four stored
        self.assertEqual([post('token', {'token': TOKEN}).status_code for _ in range(per_minute // 60 + 1)],
                         [200] * (per_minute // 60) + [429])
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
        # Two visitors: one holds at most half of a lane (F-02).
        headers = [{'Cf-Access-Jwt-Assertion': self.token(), 'X-Domino-Client-Id': visitor}
                   for visitor in ('192.0.2.1', '192.0.2.2')]

        async def burst():
            transport = httpx.ASGITransport(app=app, client=('127.0.0.1', 40000))
            async with httpx.AsyncClient(transport=transport, base_url='http://127.0.0.1:8878') as client:
                reads = [client.post('/internal/read/v1/token', json={'token': TOKEN}, headers=headers[n % 2])
                         for n in range(gate.provider_capacity)]
                reads += [client.post('/internal/read/v1/markets-snapshot', json={}, headers=headers[n % 2])
                          for n in range(gate.stored_capacity)]
                return await asyncio.gather(*reads)
        responses = asyncio.run(burst())
        self.assertEqual([response.status_code for response in responses], [200] * lanes,
                         [response.text for response in responses if response.status_code != 200][:1])

    def test_worker_pool_matches_the_lanes_of_each_gate(self):
        for gate, workers in ((public_gate(), 24), (ReadGate(), 2),
                              (ReadGate(provider_capacity=3, stored_capacity=2), 5)):
            with self.subTest(workers=workers):
                app = create_gateway(self.gateway(gate))
                self.assertEqual(app.state.worker_limiter.total_tokens, workers)


class HeldReader:
    """A reader whose reads answer when the test lets them go, and which counts the reads inside it."""
    def __init__(self, *, held=True):
        self.release, self.lock, self.inside = threading.Event(), threading.Lock(), 0
        if not held:
            self.release.set()
        self.answers = {route: json.loads((FIXTURES / f'{route}.success.json').read_text())
                        for route in ('token', 'markets-snapshot')}

    def request(self, route, body=None, *, deadline, request_id=None, version='v1'):
        metadata = {'generation': GENERATION, 'contract': CONTRACT_VERSION}
        if route == 'health':
            return 200, {'mode': 'local_read_only', 'status': 'ok', 'readBudgetSeconds': 15, 'busy': False,
                         'storedBusy': False, 'generation': GENERATION}, metadata
        with self.lock:
            self.inside += 1
        try:
            if not self.release.wait(5):
                raise AssertionError('test coordination timeout')
            return 200, deepcopy(self.answers[route]), metadata
        finally:
            with self.lock:
                self.inside -= 1


class GatewayAdmissionTests(IdentityFixtures, unittest.TestCase):
    """3 Nov 2026 (launch): a stored read waits for a lane, and one visitor holds at most half of one (F-02)."""

    def run_gateway(self, gate, reader, scenario):
        gateway = Gateway(enabled=True, enabled_reads=('token', 'markets-snapshot'), verifier=self.verifier(),
                          upstream=reader, gate=gate, budgets=ClientBudgets(burst=500))
        app = create_gateway(gateway)
        token = self.token()

        async def main():
            transport = httpx.ASGITransport(app=app, client=('127.0.0.1', 40000))
            async with httpx.AsyncClient(transport=transport, base_url='http://127.0.0.1:8878') as client:
                def post(route, visitor='192.0.2.1'):
                    body = {'token': TOKEN} if route == 'token' else {}
                    return asyncio.ensure_future(client.post(
                        '/internal/read/v1/' + route, json=body,
                        headers={'Cf-Access-Jwt-Assertion': token, 'X-Domino-Client-Id': visitor}))
                return await asyncio.wait_for(scenario(post), 10)
        with redirect_stderr(io.StringIO()) as printed:
            asyncio.run(main())
        records = [json.loads(line) for line in printed.getvalue().splitlines() if line.startswith('{')]
        return gateway, [record for record in records if record.get('service') == 'read-gateway']

    async def until(self, condition, seconds=3):
        deadline = time.monotonic() + seconds
        while not condition():
            self.assertLess(time.monotonic(), deadline, 'condition never held')
            await asyncio.sleep(0.005)

    def test_a_stored_read_waits_for_a_lane_without_holding_up_the_gateway(self):
        gate = ReadGate(interval=0, provider_capacity=2, stored_capacity=1, stored_interval=0, stored_wait=3)
        reader = HeldReader(held=False)

        async def scenario(post):
            self.assertTrue(gate.enter(ReadGate.STORED))
            stored = post('markets-snapshot')
            await asyncio.sleep(0.2)
            self.assertFalse(stored.done(), 'it waits rather than being refused')
            # The event loop is free meanwhile: a provider read is served while the stored one waits.
            self.assertEqual((await post('token')).status_code, 200)
            self.assertFalse(stored.done())
            gate.leave(ReadGate.STORED)
            response = await stored
            self.assertEqual(response.status_code, 200, response.text)
        gateway, _ = self.run_gateway(gate, reader, scenario)
        self.assertEqual((gate.stored_inflight, gate.stored_waiting, gateway.shares[ReadGate.STORED].held),
                         (0, 0, {}))

    def test_a_stored_read_is_refused_after_the_wait_and_only_a_lane_s_worth_waits(self):
        gate = ReadGate(interval=0, stored_capacity=1, stored_interval=0, stored_wait=2)
        reader = HeldReader(held=False)

        async def scenario(post):
            self.assertTrue(gate.enter(ReadGate.STORED))
            first = post('markets-snapshot')
            await self.until(lambda: gate.stored_waiting == 1)
            started = time.monotonic()
            second = await post('markets-snapshot', visitor='192.0.2.2')
            self.assertEqual((second.status_code, second.json()), (429, {'error': 'read_capacity_busy'}))
            self.assertLess(time.monotonic() - started, 1, 'the waiting room is full: refused at once')
            first = await first
            self.assertEqual(first.status_code, 429)
            self.assertTrue(1 <= int(first.headers['Retry-After']) <= 10)
            gate.leave(ReadGate.STORED)
            # Neither refusal kept the lane or the visitor's share of it.
            self.assertEqual((await post('markets-snapshot')).status_code, 200)
        gateway, records = self.run_gateway(gate, reader, scenario)
        self.assertEqual([(r['status'], r.get('limiter')) for r in records],
                         [(429, 'lane'), (429, 'lane'), (200, None)])
        self.assertEqual((gate.stored_waiting, gateway.shares[ReadGate.STORED].held), (0, {}))

    def test_one_visitor_holds_at_most_half_of_a_lane(self):
        # F-02 (21 Oct 2026 pentest): within its budget's burst of 30, one address held all 16 provider lanes.
        gate = public_gate()
        reader = HeldReader()

        async def scenario(post):
            mine = [post('token') for _ in range(gate.provider_capacity // 2)]
            await self.until(lambda: reader.inside == gate.provider_capacity // 2)
            refused = await post('token')
            self.assertEqual((refused.status_code, refused.json(), refused.headers['Retry-After']),
                             (429, {'error': 'read_capacity_busy'}, '1'))
            # The other half is everyone else's.
            theirs = [post('token', visitor=f'192.0.2.{n}') for n in range(2, 10)]
            await self.until(lambda: reader.inside == gate.provider_capacity)
            reader.release.set()
            self.assertEqual([response.status_code for response in await asyncio.gather(*mine, *theirs)],
                             [200] * gate.provider_capacity)
            # Its reads over, the visitor has its share back.
            self.assertEqual((await post('token')).status_code, 200)
        gateway, records = self.run_gateway(gate, reader, scenario)
        self.assertEqual([r.get('limiter') for r in records if r['status'] == 429], ['visitor_share'])
        self.assertEqual((gateway.shares[ReadGate.PROVIDER].held, gate.provider_inflight), ({}, 0))

    def test_a_visitor_s_stored_reads_past_its_share_wait_for_its_own(self):
        gate = public_gate()
        share = gate.stored_capacity // 2
        reader = HeldReader()

        async def scenario(post):
            mine = [post('markets-snapshot') for _ in range(share + 2)]
            await self.until(lambda: reader.inside == share)
            await asyncio.sleep(0.1)
            self.assertEqual(reader.inside, share, 'two wait for its own reads, though lanes are free')
            self.assertFalse(any(read.done() for read in mine))
            theirs = post('markets-snapshot', visitor='192.0.2.2')
            await self.until(lambda: reader.inside == share + 1)
            reader.release.set()
            self.assertEqual([response.status_code for response in await asyncio.gather(*mine, theirs)],
                             [200] * (share + 3))
        gateway, records = self.run_gateway(gate, reader, scenario)
        self.assertEqual([r['status'] for r in records], [200] * (share + 3))
        self.assertEqual((gateway.shares[ReadGate.STORED].held, gate.stored_inflight, gate.stored_waiting),
                         ({}, 0, 0))


if __name__ == '__main__':
    unittest.main()
