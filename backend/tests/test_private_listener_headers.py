"""Private origin headers protect uncompressed JSON on success and rejection."""
import importlib.util
import hashlib
import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from read_gateway import Gateway, create_gateway
from read_contract import CONTRACT_VERSION as READ_VERSION
from session_api import SessionGateway, create_session_app
from session_models import CONTRACT_VERSION as SESSION_VERSION
from onboarding_api import OnboardingGateway, create_onboarding_app
from onboarding_models import CONTRACT_VERSION as ONBOARDING_VERSION
from deposit_api import DepositGateway, create_deposit_app
from deposit_models import CONTRACT_VERSION as DEPOSIT_VERSION

ROOT = Path(__file__).resolve().parents[2]
SERVICES = (
    ('read', 'token', READ_VERSION, Gateway, create_gateway),
    ('session', 'bootstrap', SESSION_VERSION, SessionGateway, create_session_app),
    ('onboarding', 'swap-preview', ONBOARDING_VERSION, OnboardingGateway, create_onboarding_app),
    ('deposit', 'create', DEPOSIT_VERSION, DepositGateway, create_deposit_app),
)


class PrivateListenerHeaderTests(unittest.TestCase):
    def test_contract_manifests_pin_the_actual_listener_header_sources(self):
        sources = {
            'read-v1': ('backend/read_gateway.py',),
            'session-v1': ('backend/session_api.py',),
            'onboarding-v1': ('backend/onboarding_api.py', 'backend/authenticated_api.py'),
            'deposit-v1': ('backend/deposit_api.py', 'backend/authenticated_api.py'),
        }
        for contract, paths in sources.items():
            manifest = json.loads((ROOT/'api-contracts'/contract/'manifest.json').read_text())
            recorded = {entry['path']: entry['sha256'] for entry in manifest['sources']}
            for path in paths:
                with self.subTest(contract=contract, source=path):
                    self.assertEqual(recorded.get(path), hashlib.sha256((ROOT/path).read_bytes()).hexdigest())

    def assert_headers(self, response, kind, version):
        directives = {item.strip().lower() for item in response.headers['cache-control'].split(',')}
        self.assertTrue({'no-store', 'no-transform'} <= directives)
        self.assertNotIn('content-encoding', response.headers)
        self.assertEqual(response.headers['content-length'], str(len(response.content)))
        self.assertEqual(response.headers['content-type'], 'application/json')
        self.assertEqual(response.headers['x-content-type-options'], 'nosniff')
        self.assertEqual(response.headers['content-security-policy'], "default-src 'none'; frame-ancestors 'none'")
        self.assertEqual(response.headers[f'x-domino-{kind}-contract'], version)
        self.assertNotIn('set-cookie', response.headers)

    def test_disabled_routes_keep_identity_bytes_despite_accept_encoding(self):
        for kind, route, version, _, factory in SERVICES:
            with TestClient(factory(), client=('127.0.0.1', 43000)) as client:
                path = f'/internal/{kind}/v1/{route}'
                for encoding in ('identity', 'gzip, br', '*'):
                    for method, target in (('POST', path), ('GET', path), ('OPTIONS', path),
                                           ('POST', path + '/unknown'), ('GET', '/health')):
                        with self.subTest(kind=kind, encoding=encoding, method=method, path=target):
                            response = client.request(method, target, headers={'Accept-Encoding': encoding})
                            status = 405 if kind == 'read' and target == path and method != 'POST' else 404
                            self.assertEqual(response.status_code, status)
                            self.assertEqual(response.json(), {'error': 'method_not_allowed' if status == 405 else 'route_not_available'})
                            self.assert_headers(response, kind, version)

    def test_enabled_browser_rejection_does_not_execute_or_compress(self):
        for kind, route, version, gateway_type, factory in SERVICES:
            verifier = SimpleNamespace(verify=Mock(side_effect=AssertionError('must not verify')))
            service = SimpleNamespace(execute=Mock(side_effect=AssertionError('must not execute')))
            if kind == 'read':
                gateway = gateway_type(enabled=True, enabled_reads=(route,), verifier=verifier)
            else:
                gateway = gateway_type(enabled=True, origin='https://domino.money', service=service, verifier=verifier)
            with self.subTest(kind=kind), TestClient(factory(gateway), client=('127.0.0.1', 43000)) as client:
                response = client.post(f'/internal/{kind}/v1/{route}', json={},
                    headers={'Origin': 'https://domino.money', 'Accept-Encoding': 'gzip, br'})
                self.assertEqual((response.status_code, response.json()), (403, {'error': 'origin_not_allowed'}))
                self.assert_headers(response, kind, version)
                verifier.verify.assert_not_called()
                service.execute.assert_not_called()

    def test_staging_cache_policy_checks_directives_not_literal_order(self):
        spec = importlib.util.spec_from_file_location('disabled_http_smoke', ROOT/'scripts/staging/check_disabled_http.py')
        smoke = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(smoke)
        for value in ('no-store, no-transform', 'No-Transform, NO-STORE', ' no-store , no-transform , private '):
            with self.subTest(value=value):
                smoke.check_cache_policy(value, private=True)
                smoke.check_cache_policy(value, private=False)
        smoke.check_cache_policy('no-store', private=False)
        for value in (None, '', 'public', 'no-transform', 'no-store-extra, no-transform', 'no-store="yes", no-transform'):
            with self.subTest(value=value), self.assertRaisesRegex(AssertionError, 'no_store_required'):
                smoke.check_cache_policy(value, private=True)
        for value in ('no-store', 'no-store, no-transform-extra', 'no-store, no-transform="yes"'):
            with self.subTest(value=value), self.assertRaisesRegex(AssertionError, 'no_transform_required'):
                smoke.check_cache_policy(value, private=True)

    def test_smoke_response_check_rejects_missing_directives_and_compression(self):
        spec = importlib.util.spec_from_file_location('disabled_http_smoke', ROOT/'scripts/staging/check_disabled_http.py')
        smoke = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(smoke)
        # Exercise the actual qualifier using a real ASGI response, with only
        # its HTTP transport replaced. No installed listener or signal is used.
        with TestClient(create_gateway(), client=('127.0.0.1', 43000)) as client:
            response = client.post('/internal/read/v1/token', json={})
        for changes, failure in (
            ({}, None),
            ({'cache-control': 'No-Transform, NO-STORE'}, None),
            ({'content-encoding': 'identity'}, None),
            ({'cache-control': 'no-store'}, 'no_transform_required'),
            ({'cache-control': 'no-transform'}, 'no_store_required'),
            ({'content-encoding': 'gzip'}, 'identity_encoding_required'),
            ({'content-encoding': 'br'}, 'identity_encoding_required'),
        ):
            with self.subTest(changes=changes):
                headers = {**response.headers, **changes}
                raw = SimpleNamespace(status=response.status_code,
                    getheaders=lambda: list(headers.items()), read=lambda maximum: response.content[:maximum])
                connection = SimpleNamespace(request=Mock(), getresponse=lambda: raw, close=Mock())
                smoke.RESULTS, smoke.DEADLINE = [], time.monotonic() + 5
                with patch.object(smoke.http.client, 'HTTPConnection', return_value=connection), \
                     patch.object(smoke.signal, 'setitimer'):
                    smoke.check('gateway', 8878, 'POST', '/internal/read/v1/token', 404,
                                {'error': 'route_not_available'})
                self.assertEqual(smoke.RESULTS[0]['passed'], failure is None, smoke.RESULTS)
                self.assertEqual(smoke.RESULTS[0].get('failure'), failure)
                connection.close.assert_called_once()
