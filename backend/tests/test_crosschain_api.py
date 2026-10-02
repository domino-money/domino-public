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

from crosschain_support import CSRF, FEE, OWNER, PRIVATE, SESSION, default_routes, make_service, quote_request
from fastapi.testclient import TestClient
import hop_log
from crosschain_api import CrosschainGateway, build_service, create_crosschain_app, main
from crosschain_config import load_settings
from crosschain_models import CONTRACT_VERSION
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
        records = [json.loads(line) for line in printed.getvalue().splitlines() if line]
        self.assertEqual([(r['service'], r['route'], r['status']) for r in records], [('internal-crosschain-v1', 'quote', 200)])
        self.assertLessEqual(set(records[0]), hop_log.ALLOWED_KEYS)
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
        self.assertEqual(service.across.integrator_id, '0xdead')
        self.assertTrue(service.relay.has_key)
        self.assertIs(service.across.rpc_factory(4663), service.across.rpc_factory(4663))
        self.assertIsNone(service.across.rpc_factory(8453))
        self.assertIn('https://rpc.domino.money/' + 'k' * 20 + '/', service.private_values)
        self.assertIn(PRIVATE[0], service.private_values)


if __name__ == '__main__':
    unittest.main()
