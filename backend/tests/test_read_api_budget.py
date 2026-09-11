from copy import deepcopy
import json
from pathlib import Path
import sys
from threading import Event, Thread
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from discovery import DataError, ReadRpc
from read_api import create_app, ReadGate
from read_contract import CONTRACT_VERSION
from read_deadline import current_read_deadline, read_deadline, read_timeout
from read_service import ReadService
from test_discovery import FakeRpc, TOKEN
from test_read_deadline import FakeClock


class ReadApiBudgetTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()
        self.payload = ReadService(rpc_factory=FakeRpc, clock=lambda: 1010).token(TOKEN)
        self.service = SimpleNamespace(token=Mock(return_value=deepcopy(self.payload)),
                                       inventory_configured=False, catalogue=None)
        # Give only read contexts a deterministic monotonic clock. Event-loop
        # scheduling, thread coordination and upload timeouts retain real clocks.
        deadline_patch = patch('read_api.read_deadline',
                               side_effect=lambda seconds: read_deadline(seconds, clock=self.clock))
        deadline_patch.start()
        self.addCleanup(deadline_patch.stop)
        self.client = self.reader_client()

    def reader_client(self, budget=15):
        client = TestClient(create_app(self.service, gate=ReadGate(interval=0), read_budget_seconds=budget),
                            base_url='http://127.0.0.1:8876')
        self.addCleanup(client.close)
        return client

    def read(self, value=None, *, client=None, headers=None):
        supplied = {} if value is None else {'X-Domino-Read-Budget-Ms': value}
        return (client or self.client).post('/v1/read/token', json={'token': TOKEN},
                                           headers=supplied if headers is None else headers)

    def test_budget_header_requires_one_canonical_integer_between_one_and_fifteen_thousand(self):
        for value in ('', '0', '-1', '+1', '1.0', '01', '1e3', '15001', '99999', '100000',
                      'Infinity', 'NaN', ' 1000', '1000 ', '1000, 2000', '\t1000'):
            with self.subTest(value=value):
                response = self.read(value)
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(response.json(), {'error': 'invalid_request'})
                self.assertEqual(response.headers['X-Domino-Read-Contract'], CONTRACT_VERSION)
                self.assertRegex(response.headers['X-Domino-Reader-Generation'], '^[0-9a-f]{32}$')
        self.service.token.assert_not_called()
        self.assertFalse(self.client.get('/health').json()['busy'])

    def test_duplicate_budget_headers_are_rejected_even_when_identical_or_differently_cased(self):
        for second_name, second_value in (('X-Domino-Read-Budget-Ms', '1000'),
                                          ('X-Domino-Read-Budget-Ms', '15000'),
                                          ('x-domino-read-budget-ms', '2000')):
            with self.subTest(name=second_name, value=second_value):
                response = self.read(headers=[('X-Domino-Read-Budget-Ms', '1000'),
                                              (second_name, second_value)])
                self.assertEqual(response.status_code, 422, response.text)
                self.assertEqual(response.json(), {'error': 'invalid_request'})
        self.service.token.assert_not_called()

    def test_accepted_header_reaches_worker_context_and_provider_timeout(self):
        observed = []

        def lookup(token):
            observed.append((current_read_deadline().remaining(), read_timeout(5)))
            return deepcopy(self.payload)

        self.service.token.side_effect = lookup
        for value, expected in (('1', .001), ('1250', 1.25), ('15000', 15)):
            with self.subTest(value=value):
                response = self.read(value)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json(), self.payload)
                self.assertAlmostEqual(observed[-1][0], expected)
                self.assertAlmostEqual(observed[-1][1], min(5, expected))
        self.assertIsNone(current_read_deadline())

    def test_header_can_only_shorten_configured_budget_and_absence_keeps_local_default(self):
        observed = []
        self.service.token.side_effect = lambda token: (
            observed.append(current_read_deadline().remaining()) or deepcopy(self.payload))
        shorter = self.reader_client(budget=.75)
        self.assertEqual(self.read('15000', client=shorter).status_code, 200)
        self.assertEqual(observed[-1], .75)
        development = self.reader_client(budget=60)
        self.assertEqual(self.read(client=development).status_code, 200)
        self.assertEqual(observed[-1], 60)
        self.assertEqual(development.get('/health').json()['readBudgetSeconds'], 60)
        self.assertEqual(self.read('2000', client=development).status_code, 200)
        self.assertEqual(observed[-1], 2)

    def test_expired_budget_rejects_late_success_and_does_not_leak_into_next_request(self):
        def late_success(token):
            self.clock.advance(1)
            return deepcopy(self.payload)

        self.service.token.side_effect = late_success
        response = self.read('1000')
        self.assertEqual(response.status_code, 504, response.text)
        self.assertEqual(response.json(), {'error': 'read_deadline_exceeded'})
        self.service.token.side_effect = None
        response = self.read('1000')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(self.client.get('/health').json()['busy'])

    def test_expired_worker_budget_prevents_a_following_rpc_attempt(self):
        calls, rpc_counts = [], []

        def transport(url, body):
            calls.append(body['method'])
            self.clock.advance(2)
            return {'jsonrpc': '2.0', 'id': body['id'], 'result': '0x1237'}

        def lookup(token):
            rpc = ReadRpc(transport=transport)
            try:
                rpc.request('eth_chainId')
            except DataError:
                try:
                    rpc.request('eth_getBlockByNumber', ['latest', False])
                finally:
                    rpc_counts.append(rpc.count)
            return deepcopy(self.payload)

        self.service.token.side_effect = lookup
        response = self.read('1000')
        self.assertEqual(response.status_code, 504, response.text)
        self.assertEqual(response.json(), {'error': 'read_deadline_exceeded'})
        self.assertEqual(calls, ['eth_chainId'])
        self.assertEqual(rpc_counts, [1])

    def test_budget_consumed_by_body_upload_is_not_reset_when_dispatching_worker(self):
        def body():
            yield b'{"token":'
            self.clock.advance(2)
            yield json.dumps(TOKEN).encode() + b'}'

        response = self.client.post('/v1/read/token', content=body(),
                                    headers={'Content-Type': 'application/json', 'X-Domino-Read-Budget-Ms': '1000'})
        self.assertEqual(response.status_code, 504, response.text)
        self.assertEqual(response.json(), {'error': 'read_deadline_exceeded'})
        self.service.token.assert_not_called()

    def test_busy_health_tracks_actual_worker_after_budget_expiry_until_exit(self):
        entered, release, finished = Event(), Event(), Event()
        results, failures = [], []
        initial = self.client.get('/health').json()
        self.assertFalse(initial['busy'])

        def blocked(token):
            entered.set()
            if not release.wait(3):
                raise AssertionError('test coordination timed out')
            return deepcopy(self.payload)

        def request():
            try:
                results.append(self.read('1000'))
            except Exception as error:
                failures.append(type(error).__name__)
            finally:
                finished.set()

        self.service.token.side_effect = blocked
        worker = Thread(target=request)
        worker.start()
        try:
            self.assertTrue(entered.wait(2))
            self.clock.advance(2)  # The request's complete budget is now exhausted.
            self.assertFalse(finished.is_set())
            busy = self.client.get('/health')
            self.assertEqual(busy.status_code, 200, busy.text)
            self.assertTrue(busy.json()['busy'])
            self.assertEqual(busy.json()['generation'], initial['generation'])
            second = self.read('1000')
            self.assertEqual(second.status_code, 429, second.text)
            self.assertEqual(second.json(), {'error': 'read_capacity_busy'})
            self.assertEqual(self.service.token.call_count, 1)
        finally:
            release.set()
            worker.join(4)
        self.assertFalse(worker.is_alive())
        self.assertEqual(failures, [])
        self.assertEqual(results[0].status_code, 504, results[0].text)
        self.assertEqual(results[0].json(), {'error': 'read_deadline_exceeded'})
        after = self.client.get('/health').json()
        self.assertFalse(after['busy'])
        self.assertEqual(after['generation'], initial['generation'])
        self.service.token.side_effect = None
        self.assertEqual(self.read('1000').status_code, 200)


if __name__ == '__main__':
    unittest.main()
