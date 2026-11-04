"""The private crosschain listener: same admission boundary as onboarding, offline, plus its launcher."""
import io
import json
import os
from contextlib import redirect_stderr
from pathlib import Path
import re
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from crosschain_support import (CSRF, FEE, OWNER, PRIVATE, RC1, SESSION, default_routes, make_service, previous_request,
                                quote_request)
from fastapi.testclient import TestClient
import hop_log
from crosschain_api import CrosschainGateway, build_service, create_crosschain_app, main
from crosschain_config import load_settings
from crosschain_models import CONTRACT_VERSION, PREVIOUS_VERSION
import crosschain_models_rc1
from crosschain_service import DECISION_KEYS
from session_api import acquire_session_lock

ORIGIN = 'https://domino.money'
HEADERS = {'CF-Access-Jwt-Assertion': 'synthetic-service-assertion', 'X-Domino-Client-Id': '192.0.2.1',
           'X-Domino-Browser-Origin': ORIGIN, 'X-Domino-Crosschain-Contract': CONTRACT_VERSION,
           'X-Domino-Session': SESSION, 'X-Domino-CSRF': CSRF}


class CrosschainApiTests(unittest.TestCase):
    def setUp(self):
        relay_routes, across_routes = default_routes()
        self.service, self.relay_http, _ = make_service(relay_routes=relay_routes, across_routes=across_routes)
        self.verifier = SimpleNamespace(verify=Mock())
        gateway = CrosschainGateway(service=self.service, verifier=self.verifier, origin=ORIGIN, enabled=True)
        self.client = TestClient(create_crosschain_app(gateway), client=('127.0.0.1', 43100), base_url='http://127.0.0.1:8910')
        self.client.__enter__()
        self.addCleanup(self.client.__exit__, None, None, None)

    def post(self, route='quote', body=None, headers=None):
        return self.client.post('/internal/crosschain/v1/' + route, content=json.dumps(quote_request() if body is None else body),
                                headers={'content-type': 'application/json', **{k.lower(): v for k, v in (headers or HEADERS).items()}})

    def test_a_quote_is_served_with_the_contract_header_and_one_safe_record(self):
        with redirect_stderr(io.StringIO()) as printed:
            response = self.post()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers['X-Domino-Crosschain-Contract'], CONTRACT_VERSION)
        self.assertIn('no-store', response.headers['cache-control'])
        body = response.json()
        self.assertEqual((body['quote']['decision'], body['quote']['request']['owner']), ('relay', OWNER))
        self.verifier.verify.assert_called_once()
        # The quote's decision, then the request's line (hop_log), each in its own closed vocabulary.
        decision, record = [json.loads(line) for line in printed.getvalue().splitlines() if line]
        self.assertEqual((record['service'], record['route'], record['status']), ('internal-crosschain-v1', 'quote', 200))
        self.assertLessEqual(set(record), hop_log.ALLOWED_KEYS)
        self.assertEqual((decision['service'], decision['record'], decision['decision'], decision['relay']),
                         ('internal-crosschain-v1', 'decision', 'relay', 'quoted'))
        self.assertLessEqual(set(decision), DECISION_KEYS)
        self.assertIsNone(re.search(r'0x[0-9a-fA-F]{40}', printed.getvalue()))
        for value in (*PRIVATE[:2], SESSION, CSRF, FEE):
            self.assertNotIn(value, printed.getvalue())

    def test_all_three_routes(self):
        self.assertEqual(self.post('origins', {'destinationChainId': 4663,
                                               'destinationToken': '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168'}).status_code, 200)
        self.relay_http.routes[('GET', '/intents/status/v3')] = {'status': 'waiting'}
        response = self.post('status', {'provider': 'relay', 'originChainId': 42161, 'destinationChainId': 4663,
                                        'depositTxHash': '0x' + 'd1' * 32, 'requestId': '0x' + '17' * 32, 'previousState': None})
        self.assertEqual((response.status_code, response.json()['status']['state']), (200, 'awaiting_deposit'))

    def test_the_admission_boundary(self):
        self.assertEqual(self.post(body={**quote_request(), 'owner': OWNER}).json(), {'error': 'invalid_request'})
        self.assertEqual(self.post(headers={**HEADERS, 'X-Domino-Crosschain-Contract': '0.9.0'}).json(),
                         {'error': 'upstream_contract_mismatch'})
        self.assertEqual(self.post('execute').status_code, 404)
        self.assertEqual(self.post(headers={**HEADERS, 'X-Domino-Browser-Origin': 'https://evil.example'}).json(),
                         {'error': 'origin_not_allowed'})
        self.assertEqual(self.client.get('/internal/crosschain/v1/quote').status_code, 405)
        response = self.post(body={**quote_request(), 'amountRaw': '1' * 5000})
        self.assertEqual(response.json(), {'error': 'request_too_large'})

    def versioned(self, version, body, route='quote'):
        with redirect_stderr(io.StringIO()) as printed:
            response = self.post(route, body, headers={**HEADERS, 'X-Domino-Crosschain-Contract': version})
        return response, json.loads(printed.getvalue().splitlines()[-1])

    def test_the_switch_window_serves_both_versions_each_in_its_own(self):
        for version, body in ((CONTRACT_VERSION, quote_request()), (PREVIOUS_VERSION, previous_request())):
            with self.subTest(version=version):
                response, record = self.versioned(version, body)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.headers['X-Domino-Crosschain-Contract'], version)
                self.assertEqual(response.json()['contractVersion'], version)
                self.assertEqual((record['contractVersion'], record['status']), (version, 200))
        # A 1.0.0-rc.1 answer is the one main served, byte for byte, for the same provider answers.
        response, _ = self.versioned(PREVIOUS_VERSION, previous_request())
        frozen = json.loads((RC1 / 'responses' / 'quote.json').read_text())
        served = crosschain_models_rc1.RESPONSE_MODELS['quote'].model_validate(frozen).model_dump()
        self.assertEqual(response.content, json.dumps(served, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode())

    def test_the_switch_window_refuses_every_other_version_and_holds_each_to_its_own_request(self):
        for version in ('1.0.0-rc.2', '1.0.0', '1.1.0', '1.1.0-rc.2', f'{CONTRACT_VERSION}, {PREVIOUS_VERSION}', ''):
            with self.subTest(version=version):
                response, record = self.versioned(version, quote_request())
                self.assertEqual(response.json(), {'error': 'upstream_contract_mismatch'})
                self.assertEqual((response.headers['X-Domino-Crosschain-Contract'], record['contractVersion']),
                                 (CONTRACT_VERSION, CONTRACT_VERSION))
        headers = {name: value for name, value in HEADERS.items() if name != 'X-Domino-Crosschain-Contract'}
        self.assertEqual(self.post(headers=headers).json(), {'error': 'upstream_contract_mismatch'})
        # Each version's request is its own: refused before any provider, in the version the request named.
        for version, body in ((CONTRACT_VERSION, previous_request()), (PREVIOUS_VERSION, quote_request())):
            with self.subTest(version=version):
                response, record = self.versioned(version, body)
                self.assertEqual(response.json(), {'error': 'invalid_request'})
                self.assertEqual((response.headers['X-Domino-Crosschain-Contract'], record['contractVersion']), (version, version))
        # A refusal before the header's own check is answered in the version named too, when it is accepted.
        for version, answered in ((CONTRACT_VERSION, CONTRACT_VERSION), (PREVIOUS_VERSION, PREVIOUS_VERSION),
                                  ('1.0.0-rc.2', CONTRACT_VERSION)):
            with self.subTest(version=version), redirect_stderr(io.StringIO()):
                response = self.post(headers={**HEADERS, 'X-Domino-Crosschain-Contract': version,
                                              'X-Domino-Browser-Origin': 'https://evil.example'})
                self.assertEqual((response.json(), response.headers['X-Domino-Crosschain-Contract']),
                                 ({'error': 'origin_not_allowed'}, answered))
        self.assertEqual(self.relay_http.calls, [])

    def test_a_disabled_listener_serves_nothing(self):
        with TestClient(create_crosschain_app(), client=('127.0.0.1', 43000)) as client:
            response = client.post('/internal/crosschain/v1/quote', content=json.dumps(quote_request()),
                                   headers={'content-type': 'application/json'})
        self.assertEqual((response.status_code, response.json()), (404, {'error': 'route_not_available'}))


class LauncherTests(unittest.TestCase):
    def test_disabled_launch_reads_no_configuration(self):
        with tempfile.TemporaryDirectory() as temporary:
            fd = acquire_session_lock(Path(temporary) / 'runtime')
            with patch('crosschain_api.acquire_session_lock', return_value=fd), patch.dict(os.environ, {}, clear=True), \
                 patch.object(sys, 'argv', ['crosschain_api.py']), patch('crosschain_api.load_session_rpc_config') as rpc, \
                 patch('uvicorn.run') as server:
                main()
                rpc.assert_not_called()
                self.assertFalse(server.call_args.args[0].state.gateway.enabled)
                self.assertEqual((server.call_args.kwargs['host'], server.call_args.kwargs['port']), ('127.0.0.1', 8910))

    def test_an_enabled_launch_without_a_fee_recipient_names_the_setting(self):
        with tempfile.TemporaryDirectory() as temporary:
            fd = acquire_session_lock(Path(temporary) / 'runtime')
            stderr = io.StringIO()
            with patch('crosschain_api.acquire_session_lock', return_value=fd), \
                 patch.dict(os.environ, {'DOMINO_RELAY_API_KEY': PRIVATE[0]}, clear=True), \
                 patch.object(sys, 'argv', ['crosschain_api.py', '--enable']), patch('uvicorn.run') as server, \
                 redirect_stderr(stderr), self.assertRaises(SystemExit) as exit_:
                main()
            self.assertEqual(exit_.exception.code, 2)
            server.assert_not_called()
            self.assertIn('crosschain_config_fee_recipient', stderr.getvalue())
            self.assertNotIn(PRIVATE[0], stderr.getvalue())
            with self.assertRaises(OSError):
                os.fstat(fd)

    def test_reserved_ports_and_workers_are_refused(self):
        for argv, env in ((['crosschain_api.py', '--port', '8880'], {}), (['crosschain_api.py'], {'WEB_CONCURRENCY': '2'})):
            with self.subTest(argv=argv), patch.dict(os.environ, env, clear=True), patch.object(sys, 'argv', argv), \
                 patch('crosschain_api.acquire_session_lock') as lock, redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                main()
            lock.assert_not_called()

    def test_build_service_wires_keys_into_headers_and_robinhood_rpc_into_the_proof(self):
        settings = load_settings({'DOMINO_CROSSCHAIN_FEE_RECIPIENT': FEE, 'DOMINO_RELAY_API_KEY': PRIVATE[0],
                                  'DOMINO_ACROSS_API_KEY': PRIVATE[1], 'DOMINO_ACROSS_INTEGRATOR_ID': '0xDEAD'})
        service = build_service(settings, auth=Mock(), robinhood_rpc='https://rpc.domino.money/' + 'k' * 20 + '/')
        self.assertEqual(service.relay.http._headers, {'x-api-key': PRIVATE[0]})
        self.assertEqual(service.across.http._headers, {'Authorization': 'Bearer ' + PRIVATE[1]})
        # Each provider's calls a minute: quotes and listings, then the status reads' own share (3 Nov 2026).
        for http, quotes, status in ((service.relay.http, 30, 15), (service.across.http, 40, 20)):
            self.assertEqual((http.budget.per_minute, http.status_budget.per_minute), (quotes, status))
        self.assertEqual(service.across.integrator_id, '0xdead')
        self.assertTrue(service.relay.has_key)
        self.assertIs(service.across.rpc_factory(4663), service.across.rpc_factory(4663))
        self.assertIsNone(service.across.rpc_factory(8453))
        self.assertIn('https://rpc.domino.money/' + 'k' * 20 + '/', service.private_values)
        self.assertIn(PRIVATE[0], service.private_values)


    def test_build_service_reads_base_and_arbitrum_through_the_registry_unless_a_url_is_set(self):
        from crosschain_across import ChainRpc, EndpointsChainRpc
        from test_crosschain_across import hosted, hosted_url
        url = 'https://arbitrum.example.invalid/v2/' + 'k' * 24
        settings = load_settings({'DOMINO_CROSSCHAIN_FEE_RECIPIENT': FEE, 'DOMINO_CROSSCHAIN_RPC_URL_42161': url})
        endpoints = {8453: hosted(None), 42161: hosted(None, chain=42161)}
        service = build_service(settings, auth=Mock(), chain_endpoints=endpoints)
        base = service.across.rpc_factory(8453)
        self.assertIsInstance(base, EndpointsChainRpc)
        self.assertIs(base.endpoints, endpoints[8453])
        self.assertIs(service.across.rpc_factory(8453), base)
        # A destination's own URL wins over the registry.
        self.assertIs(type(service.across.rpc_factory(42161)), ChainRpc)
        self.assertIsNone(service.across.rpc_factory(4663))
        for name in ('stack', 'alchemy', 'public'):
            self.assertIn(hosted_url(name), service.private_values)
        self.assertIn(url, service.private_values)


class EnabledLaunchTests(unittest.TestCase):
    def test_an_enabled_launch_reads_the_destinations_from_the_v2_chain_rpc_file(self):
        environ = {'DOMINO_CROSSCHAIN_FEE_RECIPIENT': FEE, 'DOMINO_SESSION_ABUSE_SECRET': 'ab' * 32,
                   'DOMINO_V2_CHAIN_RPC_FILE': '/run/domino-financial-crosschain-config/chain-rpc.json',
                   'DOMINO_SESSION_ORIGIN': 'https://domino.money'}
        with tempfile.TemporaryDirectory() as temporary:
            fd = acquire_session_lock(Path(temporary) / 'runtime')
            with patch('crosschain_api.acquire_session_lock', return_value=fd), patch.dict(os.environ, environ, clear=True), \
                 patch.object(sys, 'argv', ['crosschain_api.py', '--enable']), \
                 patch('crosschain_api.load_session_rpc_config', return_value={}), \
                 patch('rpc_config.configured_rpc_urls', return_value=['https://rpc.domino.money/' + 'k' * 20 + '/']), \
                 patch('catalogue.database_settings'), patch('session_store.SessionStore'), patch('session_chain.EoaChecker'), \
                 patch('onboarding_auth.OnboardingAuth'), patch('bridge_identity.AccessVerifier'), \
                 patch('crosschain_across.destination_endpoints', return_value={8453: 'base'}) as destinations, \
                 patch('crosschain_api.build_service') as build, patch('uvicorn.run'):
                main()
        destinations.assert_called_once_with('/run/domino-financial-crosschain-config/chain-rpc.json')
        self.assertEqual(build.call_args.kwargs['chain_endpoints'], {8453: 'base'})
        self.assertEqual(build.call_args.kwargs['robinhood_rpc'], 'https://rpc.domino.money/' + 'k' * 20 + '/')


if __name__ == '__main__':
    unittest.main()
