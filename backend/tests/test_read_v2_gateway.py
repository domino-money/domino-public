"""Read-v2 integration boundaries over the unchanged local read-v1 producer."""
from copy import deepcopy
import json
from pathlib import Path
import sys
from threading import Event, Thread
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from bridge_state import ClientBudgets
from discovery import DataError
from pool_apr import PoolAprEstimate
from read_api import ReadGate
from read_contract import CONTRACT_VERSION, validate_response
from read_gateway import Gateway, create_gateway
from test_bridge_identity import IdentityFixtures
from test_pool_apr import example, fixture, rekey
from test_read_gateway import Upstream


V2_VERSION = '2.0.0-rc.1'
V1_PATH = '/internal/read/v1/pool-market'
V2_PATH = '/internal/read/v2/pool-market'


def market_example():
    result = example()
    result['priceHistory'] = {'status': 'not_requested', 'reason': None, 'data': None, 'cache': None}
    return result


class MarketReader:
    """A recording reader; tests choose independently valid rc.3 observations."""
    def __init__(self):
        self.data = market_example()
        self.calls = []
        self.deadlines = []
        self.generation = 'a' * 32
        self.metadata = {'generation': self.generation, 'contract': CONTRACT_VERSION}
        self.status = 200
        self.busy = False
        self.on_request = None

    def request(self, route, body=None, *, deadline):
        self.calls.append((route, deepcopy(body)))
        self.deadlines.append(deadline)
        if self.on_request is not None:
            self.on_request(route)
        if route == 'health':
            return 200, {'mode': 'local_read_only', 'status': 'ok', 'readBudgetSeconds': 15,
                         'busy': self.busy, 'generation': self.generation}, {}
        if route != 'pool-market':
            raise AssertionError('v2 must not make additional reader queries')
        return self.status, deepcopy(self.data), dict(self.metadata)


class ReadV2GatewayTests(IdentityFixtures, unittest.TestCase):
    def setUp(self):
        self.reader = MarketReader()
        self.pool_id = self.reader.data['poolId']
        self.wall_time = [1010.75]
        self.monotonic = [100.]
        self.gateway = self.make_gateway()
        self.client = self.make_client(self.gateway)
        self.headers = {'Cf-Access-Jwt-Assertion': self.token(), 'X-Domino-Client-Id': '192.0.2.1'}

    def make_gateway(self, **changes):
        options = dict(enabled=True, enabled_reads=('pool-market',), enabled_v2=True,
                       enabled_v2_reads=('pool-market',), verifier=self.verifier(),
                       upstream=self.reader, gate=ReadGate(interval=0),
                       budgets=ClientBudgets(burst=500), clock=lambda: self.monotonic[0],
                       wall_clock=lambda: self.wall_time[0])
        options.update(changes)
        return Gateway(**options)

    def make_client(self, gateway, *, remote='127.0.0.1'):
        return TestClient(create_gateway(gateway), base_url='http://127.0.0.1:8878',
                          client=(remote, 40000))

    def post(self, *, path=V2_PATH, body=None, client=None, headers=None):
        return (client or self.client).post(path, json={'poolId': self.pool_id} if body is None else body,
                                            headers=self.headers if headers is None else headers)

    def assert_error(self, response, status, code, *, version=V2_VERSION):
        self.assertEqual(response.status_code, status, response.text)
        self.assertEqual(response.json(), {'error': code})
        self.assertEqual(response.headers['x-domino-read-contract'], version)

    def test_one_v1_market_read_yields_separate_exact_estimate_and_preserves_market(self):
        original = deepcopy(self.reader.data)
        response = self.post()
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(set(body), {'schemaVersion', 'chainId', 'poolId', 'market', 'estimate', 'executionAvailable'})
        self.assertEqual((body['schemaVersion'], body['chainId'], body['poolId']), (1, 4663, self.pool_id))
        self.assertIs(body['executionAvailable'], False)
        self.assertEqual(body['market'], original)
        self.assertEqual(self.reader.data, original)
        self.assertIsNone(body['market']['feeApr24h'])
        self.assertIsNone(body['market']['pool']['feeApr24h'])
        estimate = body['estimate']
        PoolAprEstimate.model_validate(estimate)
        self.assertEqual(estimate['status'], 'available')
        self.assertEqual(estimate['feeAprEstimate24hPercent'], '10.95')
        self.assertEqual(estimate['provenance']['evaluatedAt'], 1010)
        self.assertFalse(estimate['providerMetricsReconciled'])
        self.assertFalse(estimate['suggested'])
        self.assertFalse(estimate['executionAvailable'])
        self.assertEqual(self.reader.calls, [('health', None),
                                           ('pool-market', {'poolId': self.pool_id, 'includePriceHistory': False})])
        self.assertEqual(self.reader.deadlines, [115., 115.])
        self.assertEqual(response.headers['x-domino-read-contract'], V2_VERSION)
        self.assertEqual(response.headers['cache-control'], 'no-store, no-transform')
        self.assertNotIn('set-cookie', response.headers)
        self.assertNotIn('x-domino-reader-generation', response.headers)

    def test_v1_payload_and_version_remain_unchanged_when_v2_is_enabled(self):
        response = self.post(path=V1_PATH)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), self.reader.data)
        self.assertEqual(response.headers['x-domino-read-contract'], CONTRACT_VERSION)
        self.assertNotIn('estimate', response.json())
        self.assertEqual(self.reader.calls, [('health', None), ('pool-market', {'poolId': self.pool_id})])

    def test_versions_are_independently_opted_in_and_default_off(self):
        for v1, v2 in ((False, False), (True, False), (False, True), (True, True)):
            with self.subTest(v1=v1, v2=v2):
                self.reader.calls.clear()
                client = self.make_client(self.make_gateway(enabled=v1, enabled_v2=v2))
                self.assertEqual(self.post(path=V1_PATH, client=client).status_code, 200 if v1 else 404)
                self.assertEqual(self.post(client=client).status_code, 200 if v2 else 404)
                self.assertEqual(len(self.reader.calls), 2 * (int(v1) + int(v2)))
        disabled = Gateway(verifier=Mock(), upstream=self.reader)
        self.reader.calls.clear()
        self.assertEqual(self.post(client=self.make_client(disabled)).status_code, 404)
        disabled.verifier.verify.assert_not_called()
        self.assertEqual(self.reader.calls, [])

    def test_v1_allowlist_cannot_enable_v2_and_invalid_v2_configuration_is_refused(self):
        gateway = Gateway(enabled=True, enabled_reads=('pool-market',), verifier=self.verifier(),
                          upstream=self.reader)
        self.assertEqual(self.post(client=self.make_client(gateway)).status_code, 404)
        self.assertEqual(self.reader.calls, [])
        for options in ({'enabled_v2': 1}, {'enabled_v2_reads': ('token',)},
                        {'enabled_v2_reads': ()}, {'verifier': None}):
            with self.subTest(options=tuple(options)), self.assertRaises(DataError):
                self.make_gateway(**options)

    def test_v2_has_one_exact_post_route_and_no_query_or_chart_selectors(self):
        for path in ('/internal/read/v2/token', V2_PATH + '/extra', V2_PATH + '/',
                     V2_PATH + '?includePriceHistory=true', '/internal/read/v2/pool%2dmarket'):
            with self.subTest(path=path):
                self.assertEqual(self.post(path=path).status_code, 404)
        self.assert_error(self.client.get(V2_PATH, headers=self.headers), 405, 'method_not_allowed')
        for body in ({}, {'poolId': None}, {'poolId': 7}, {'poolId': '0x' + 'f' * 63},
                     {'poolId': '0x' + self.pool_id[2:].upper()},
                     {'poolId': self.pool_id, 'includePriceHistory': False},
                     {'poolId': self.pool_id, 'includePriceHistory': True},
                     {'poolId': self.pool_id, 'priceToken': 'base'},
                     {'poolId': self.pool_id, 'chainId': 4663},
                     {'poolId': self.pool_id, 'now': 1010},
                     {'poolId': self.pool_id, 'rpcUrl': 'https://invalid.example/private'}):
            with self.subTest(fields=tuple(body)):
                self.assert_error(self.post(body=body), 422, 'invalid_request')
        duplicate = json.dumps({'poolId': self.pool_id})[:-1] + ',"poolId":"' + self.pool_id + '"}'
        response = self.client.post(V2_PATH, content=duplicate,
                                    headers={**self.headers, 'Content-Type': 'application/json'})
        self.assert_error(response, 422, 'invalid_request')
        self.assertEqual(self.reader.calls, [])

    def test_wall_clock_is_read_after_upstream_and_is_not_the_deadline_clock(self):
        self.wall_time[0] = 1069.75
        def advance_wall_time(route):
            if route == 'pool-market':
                self.wall_time[0] = 1070.75
        self.reader.on_request = advance_wall_time
        response = self.post()
        self.assertEqual(response.status_code, 200, response.text)
        estimate = response.json()['estimate']
        self.assertEqual(estimate['status'], 'stale')
        self.assertEqual(estimate['provenance']['evaluatedAt'], 1070)
        self.assertEqual(estimate['provenance']['effectiveMarketAgeSeconds'], 60)
        self.assertEqual(self.reader.deadlines, [115., 115.])

    def test_stale_expired_and_missing_observations_are_successes_with_honest_states(self):
        for name, status, value in (('success', 'available', '0'), ('stale', 'stale', '0'),
                                    ('expired', 'unavailable', None),
                                    ('missing', 'unavailable', None), ('provider-timeout', 'unavailable', None),
                                    ('provider-rate-limited', 'unavailable', None), ('rejected', 'unavailable', None)):
            with self.subTest(fixture=name):
                self.reader.data = fixture(name)
                self.reader.data['priceHistory'] = {'status': 'not_requested', 'reason': None,
                                                    'data': None, 'cache': None}
                response = self.post()
                self.assertEqual(response.status_code, 200, response.text)
                body = response.json()
                self.assertEqual(body['market'], self.reader.data)
                self.assertEqual(body['estimate']['status'], status)
                self.assertEqual(body['estimate']['feeAprEstimate24hPercent'], value)
                self.assertFalse(body['executionAvailable'])

    def test_elapsed_wall_time_removes_an_expired_value_without_resetting_cache_age(self):
        self.wall_time[0] = 1311.
        response = self.post()
        self.assertEqual(response.status_code, 200, response.text)
        estimate = response.json()['estimate']
        self.assertEqual(estimate['status'], 'unavailable')
        self.assertIsNone(estimate['feeAprEstimate24hPercent'])
        self.assertEqual(estimate['provenance']['cacheAgeSeconds'], 0)
        self.assertEqual(estimate['provenance']['effectiveMarketAgeSeconds'], 301)
        self.assertIn('market_data_expired', estimate['reasons'])

    def test_valid_but_different_pool_cannot_answer_the_requested_identity(self):
        self.reader.data = rekey(market_example(), currency1='0x' + '9' * 40)
        validate_response('pool-market', self.reader.data)
        self.assertNotEqual(self.reader.data['poolId'], self.pool_id)
        self.assert_error(self.post(), 502, 'upstream_contract_mismatch')

    def test_unrequested_chart_payload_is_not_exposed_in_the_v2_response(self):
        self.reader.data = example()
        self.assertNotEqual(self.reader.data['priceHistory']['status'], 'not_requested')
        self.assert_error(self.post(), 502, 'upstream_contract_mismatch')

    def test_schema_contract_and_reader_generation_drift_are_sanitized(self):
        for change, expected in (('wire', 502), ('version', 502), ('generation', 503), ('error', 503)):
            with self.subTest(change=change):
                self.reader = MarketReader()
                self.gateway.upstream = self.reader
                if change == 'wire':
                    self.reader.data['unexpected'] = 'https://invalid.example/private'
                elif change == 'version':
                    self.reader.metadata['contract'] = V2_VERSION
                elif change == 'generation':
                    self.reader.metadata['generation'] = 'b' * 32
                else:
                    self.reader.status = 500
                    self.reader.data = {'error': 'https://invalid.example/private'}
                response = self.post()
                self.assert_error(response, expected, 'upstream_contract_mismatch' if expected == 502 else 'upstream_unavailable')
                self.assertNotIn('private', response.text)

    def test_access_transport_cookie_uses_full_identity_verification_and_never_reaches_reader(self):
        upstream = Upstream()
        upstream.change = lambda status, data, metadata: (200, market_example(), metadata)
        self.gateway.upstream = upstream
        # LocalReaderHTTP needs a real monotonic deadline while this test traverses its actual HTTP client.
        self.gateway.clock = time.monotonic
        assertion = self.headers['Cf-Access-Jwt-Assertion']
        with patch.object(upstream.client, 'stream', wraps=upstream.client.stream) as forwarded:
            response = self.post(headers={**self.headers, 'Cookie': 'CF_Authorization=' + assertion})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(forwarded.call_count, 2)
        for call in forwarded.call_args_list:
            names = {name.lower() for name in call.kwargs['headers']}
            self.assertTrue({'cookie', 'cf-access-jwt-assertion', 'authorization', 'origin'}.isdisjoint(names))
        self.assertEqual(upstream.calls, [('health', None),
                                         ('pool-market', {'poolId': self.pool_id, 'includePriceHistory': False})])
        upstream.calls.clear()
        for invalid in ('invalid', self.token(common_name='other.access'), self.token(sub='human')):
            with self.subTest(identity=invalid == 'invalid'):
                headers = {**self.headers, 'Cf-Access-Jwt-Assertion': invalid, 'Cookie': 'CF_Authorization=' + invalid}
                self.assertEqual(self.post(headers=headers).status_code, 403)
        self.assertEqual(upstream.calls, [])

    def test_browser_credentials_client_spoofing_and_duplicate_headers_do_not_read(self):
        for extra in ({'Origin': 'https://app.example'}, {'Authorization': 'Bearer private'},
                      {'Cookie': 'session=private'}, {'X-Domino-Client-Id': '192.0.2.1,192.0.2.2'}):
            with self.subTest(header=tuple(extra)):
                self.assertEqual(self.post(headers={**self.headers, **extra}).status_code, 403)
        missing = {'X-Domino-Client-Id': '192.0.2.1'}
        self.assertEqual(self.post(headers=missing).status_code, 403)
        duplicate = list(self.headers.items()) + [('X-Domino-Client-Id', '192.0.2.2')]
        self.assert_error(self.post(headers=duplicate), 422, 'invalid_request')
        self.assertEqual(self.post(client=self.make_client(self.gateway, remote='192.0.2.1')).status_code, 403)
        self.assertEqual(self.reader.calls, [])

    def test_identity_and_upstream_time_use_the_same_total_deadline(self):
        self.gateway.verifier = Mock()
        def slow_verify(assertion):
            self.monotonic[0] = 121.
        self.gateway.verifier.verify.side_effect = slow_verify
        self.assert_error(self.post(), 504, 'read_deadline_exceeded')
        self.assertEqual(self.reader.calls, [])
        self.monotonic[0] = 100.
        self.gateway.verifier = self.verifier()
        def slow_upstream(route):
            if route == 'pool-market':
                self.monotonic[0] = 116.
        self.reader.on_request = slow_upstream
        self.assert_error(self.post(), 504, 'upstream_timeout')
        self.assertEqual(len(self.reader.calls), 2)

    def test_expired_v2_dispatch_does_not_start_verification_or_reader_work(self):
        self.gateway.verifier = Mock()
        self.assertTrue(self.gateway.gate.enter())
        status, data = self.gateway.execute('pool-market', {'poolId': self.pool_id}, 'unused',
                                            '192.0.2.1', 99., version='v2')
        self.assertEqual((status, data), (504, {'error': 'upstream_timeout'}))
        self.gateway.verifier.verify.assert_not_called()
        self.assertEqual(self.reader.calls, [])

    def test_reader_timeout_and_busy_state_do_not_start_a_second_read(self):
        def timeout(route):
            if route == 'pool-market':
                self.reader.busy = True
                raise DataError('upstream_timeout')
        self.reader.on_request = timeout
        self.assert_error(self.post(), 504, 'upstream_timeout')
        self.reader.calls.clear()
        self.assert_error(self.post(), 429, 'read_capacity_busy')
        self.assertEqual(self.reader.calls, [('health', None)])

    def test_dispatch_failure_releases_the_shared_admission(self):
        with patch('read_gateway.anyio.to_thread.run_sync', side_effect=RuntimeError('dispatch failed')):
            self.assert_error(self.post(), 503, 'upstream_unavailable')
        self.assertEqual(self.post().status_code, 200)

    def test_client_budget_is_shared_between_v1_and_v2(self):
        self.gateway.budgets = ClientBudgets(clock=lambda: 0., burst=1)
        self.assertEqual(self.post(path=V1_PATH).status_code, 200)
        self.reader.calls.clear()
        self.assert_error(self.post(), 429, 'read_capacity_busy')
        self.assertEqual(self.reader.calls, [])
        self.assertEqual(self.post(headers={**self.headers, 'X-Domino-Client-Id': '192.0.2.2'}).status_code, 200)

    def test_inflight_v1_or_v2_holds_one_shared_gate_until_reader_finishes(self):
        for first, second in ((V1_PATH, V2_PATH), (V2_PATH, V1_PATH)):
            with self.subTest(first=first):
                entered, release = Event(), Event()
                results, failures = [], []
                self.reader.calls.clear()
                def block(route):
                    if route == 'pool-market':
                        entered.set()
                        if not release.wait(3):
                            raise AssertionError('reader release timed out')
                self.reader.on_request = block
                def request():
                    try:
                        results.append(self.post(path=first))
                    except Exception as error:
                        failures.append(error)
                worker = Thread(target=request)
                worker.start()
                try:
                    self.assertTrue(entered.wait(2))
                    response = self.post(path=second)
                    self.assert_error(response, 429, 'read_capacity_busy',
                                      version=V2_VERSION if second == V2_PATH else CONTRACT_VERSION)
                    self.assertEqual(response.headers['retry-after'], '2')
                    self.assertEqual(len(self.reader.calls), 2)
                finally:
                    release.set()
                    worker.join(4)
                self.assertFalse(worker.is_alive())
                self.assertEqual(failures, [])
                self.assertEqual(len(results), 1)
                self.assertEqual(results[0].status_code, 200, results[0].text)


if __name__ == '__main__':
    unittest.main()
