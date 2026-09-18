from copy import deepcopy
import asyncio
import json
import os
from pathlib import Path
import sys
import tempfile
from threading import Event, Thread
import time
import unittest
from unittest.mock import Mock, patch
import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from bridge_http import LocalReaderHTTP
from bridge_state import OpaqueCursors
from dev_read_gateway import DEV_READS, DevGateway, acquire_runtime_lock, create_dev_gateway, main
from dev_read_identity import Admission, DevProfile, PrincipalBudget
from discovery import DataError
from inventory import AlchemyInventory
from read_api import ReadGate
from read_contract import CONTRACT_VERSION
from test_bridge_identity import AUDIENCE, ISSUER, SERVICE, IdentityFixtures
from test_discovery import OWNER, TOKEN
from test_inventory import ProviderTransport, URL, page
from test_read_gateway import Upstream


class DevUpstream(Upstream):
    """Existing real rc3 fixture with the dedicated development health shape."""
    def request(self, route, body=None, *, deadline, request_id=None):
        status, data, metadata = super().request(route, body, deadline=deadline)
        if route == 'health':
            data['devAdmission'] = {'state': 'ready', 'retryAfterSeconds': 0,
                                    'startsPerMinute': 6, 'minimumStartIntervalSeconds': 2}
        return status, data, metadata


class DevGatewayTests(IdentityFixtures, unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.directory = Path(self.temp.name).resolve()
        self.profile_dir = self.directory / 'profile'
        self.profile_dir.mkdir(mode=0o700)
        self.admission_path = self.profile_dir / 'admission.json'
        self.profile_path = self.profile_dir / 'profile.json'
        self.profile_json = {'version': 1, 'issuer': ISSUER, 'audience': AUDIENCE, 'serviceId': SERVICE,
                             'readerPort': 8890, 'gatewayPort': 8891, 'readerCommit': 'a'*40,
                             'gatewayCommit': 'b'*40, 'contractManifestSha256': 'c'*64,
                             'requestsPerMinute': 30, 'burst': 5}
        self.write_json(self.profile_path, self.profile_json)
        self.profile = DevProfile.load(self.profile_path)
        self.grant()
        self.admission = Admission(self.admission_path, SERVICE)
        self.upstream = DevUpstream()
        self.gateway = DevGateway(profile=self.profile, admission=self.admission, enabled=True,
                                  verifier=self.verifier(), upstream=self.upstream, gate=ReadGate(interval=0))
        self.client = self.make_client(self.gateway)
        self.headers = {'Cf-Access-Jwt-Assertion': self.token()}

    @staticmethod
    def write_json(path, value):
        # Atomic replacement exercises re-opening the directory entry per request.
        replacement = path.with_name(path.name + '.new')
        replacement.write_text(json.dumps(value))
        replacement.chmod(0o600)
        replacement.replace(path)

    def grant(self, **changes):
        self.write_json(self.admission_path, {'version': 1, 'enabled': True, 'serviceId': SERVICE,
                                             'expiresAt': int(time.time()) + 3600, **changes})

    def make_client(self, gateway, **kwargs):
        client = TestClient(create_dev_gateway(gateway), base_url='http://127.0.0.1:8891',
                            client=kwargs.get('client', ('127.0.0.1', 40000)))
        self.addCleanup(client.close)
        return client

    def post(self, route='token', body=None, headers=None, client=None):
        return (client or self.client).post('/internal/read/v1/' + route,
                                           json=body if body is not None else {'token': TOKEN},
                                           headers=self.headers if headers is None else headers)

    def get(self, path, headers=None):
        return self.client.get(path, headers=self.headers if headers is None else headers)

    def test_real_reader_execution_and_contract_preserved_without_ip_identity(self):
        with patch.object(self.upstream.client, 'stream', wraps=self.upstream.client.stream) as forwarded:
            response = self.post(headers={**self.headers, 'CF-Connecting-IP': '192.0.2.8',
                                          'X-Forwarded-For': 'forged', 'Forwarded': 'for=other'})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json(), self.upstream.service.token(TOKEN))
        self.assertEqual(response.headers['x-domino-read-contract'], CONTRACT_VERSION)
        self.assertRegex(response.headers['x-domino-request-id'], r'^[0-9a-f]{32}$')
        self.assertEqual(response.headers['cache-control'], 'no-store, no-transform')
        for name in ('set-cookie', 'x-domino-reader-generation', 'content-encoding', 'access-control-allow-origin'):
            self.assertNotIn(name, response.headers)
        for call in forwarded.call_args_list:
            headers = {name.lower() for name in call.kwargs['headers']}
            self.assertTrue(headers.isdisjoint({'cookie', 'authorization', 'cf-access-jwt-assertion',
                                              'cf-connecting-ip', 'x-forwarded-for', 'x-domino-client-id'}))

    def market_gateway(self, *, enabled_v2=False):
        from test_read_v2_gateway import MarketReader
        reader = MarketReader()
        original = reader.request
        def request(route, body=None, *, deadline, request_id=None):
            status, data, metadata = original(route, body, deadline=deadline)
            if route == 'health':
                data['devAdmission'] = {'state': 'ready', 'retryAfterSeconds': 0,
                                        'startsPerMinute': 6, 'minimumStartIntervalSeconds': 2}
                metadata = dict(reader.metadata)
            return status, data, metadata
        reader.request = request
        gateway = DevGateway(profile=self.profile, admission=self.admission, enabled=True,
                             enabled_v2=enabled_v2, verifier=self.verifier(), upstream=reader,
                             gate=ReadGate(interval=0), wall_clock=lambda: 1010)
        return reader, gateway, self.make_client(gateway)

    def test_v2_opt_in_reuses_one_v1_market_read_and_preserves_seven_v1_routes(self):
        reader, gateway, client = self.market_gateway()
        path = '/internal/read/v2/'
        request = {'poolId': reader.data['poolId']}
        self.assertEqual(client.post(path + 'pool-market', json=request, headers=self.headers).status_code, 404)
        capabilities = client.get(path + 'capabilities', headers=self.headers)
        self.assertEqual(capabilities.status_code, 200)
        self.assertEqual(capabilities.json()['enabledReads'], [])
        self.assertEqual(capabilities.headers['x-domino-read-contract'], '2.0.0-rc.1')
        gateway.enabled_v2 = True
        assertion = self.headers['Cf-Access-Jwt-Assertion']
        response = client.post(path + 'pool-market', json=request,
                               headers={**self.headers, 'Cookie': 'CF_Authorization=' + assertion})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['estimate']['feeAprEstimate24hPercent'], '10.95')
        self.assertEqual(response.json()['market'], reader.data)
        self.assertFalse(response.json()['executionAvailable'])
        self.assertEqual(reader.calls, [('health', None), ('pool-market', {**request, 'includePriceHistory': False})])
        self.assertEqual(client.get(path + 'capabilities', headers=self.headers).json()['enabledReads'], ['pool-market'])
        self.assertEqual(client.get('/internal/read/v1/capabilities', headers=self.headers).json()['enabledReads'], list(DEV_READS))
        legacy = client.post('/internal/read/v1/pool-market', json=request, headers=self.headers)
        self.assertEqual(legacy.status_code, 200)
        self.assertEqual(legacy.json(), reader.data)
        self.assertEqual(legacy.headers['x-domino-read-contract'], CONTRACT_VERSION)

    def test_v2_scope_and_revocation_during_health_prevent_new_read(self):
        reader, gateway, client = self.market_gateway(enabled_v2=True)
        request = {'poolId': reader.data['poolId']}
        for route in ('token', 'pool-positions', 'status', 'pool-market/', '%70ool-market'):
            self.assertEqual(client.post('/internal/read/v2/' + route, json=request, headers=self.headers).status_code, 404)
        for body in ({**request, 'includePriceHistory': True}, {**request, 'now': 1010}):
            self.assertEqual(client.post('/internal/read/v2/pool-market', json=body, headers=self.headers).status_code, 422)
        self.assertEqual(client.post('/internal/read/v2/pool-market', json=request,
                                     headers={**self.headers, 'X-Domino-Read-Contract': CONTRACT_VERSION}).status_code, 502)
        self.assertEqual(client.post('/internal/read/v2/pool-market', json=request).status_code, 403)
        self.assertEqual(reader.calls, [])
        reader.on_request = lambda route: self.grant(enabled=False) if route == 'health' else None
        response = client.post('/internal/read/v2/pool-market', json=request, headers=self.headers)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(reader.calls, [('health', None)])

    def test_v2_and_v1_share_the_same_principal_data_budget(self):
        reader, gateway, client = self.market_gateway(enabled_v2=True)
        profile = DevProfile(ISSUER, AUDIENCE, SERVICE, 'a'*40, 'b'*40, 'c'*64, 6, 2)
        gateway.budgets = PrincipalBudget(profile, self.admission, clock=lambda: 100.)
        for version, status in (('v2', 200), ('v1', 200), ('v2', 429)):
            response = client.post('/internal/read/' + version + '/pool-market',
                                   json={'poolId': reader.data['poolId']}, headers=self.headers)
            self.assertEqual(response.status_code, status, response.text)
        self.assertEqual(len(reader.calls), 4)
        self.assertEqual(client.get('/internal/read/v2/capabilities', headers=self.headers).status_code, 200)

    def test_jwt_claims_missing_identity_and_legacy_client_header_fail_closed(self):
        variations = [{}, {'Cf-Access-Jwt-Assertion': 'bad'},
                      {**self.headers, 'X-Domino-Client-Id': '192.0.2.1'}]
        variations += [{'Cf-Access-Jwt-Assertion': self.token(**changes)} for changes in (
            {'aud': ['d'*64]}, {'iss': 'https://other.cloudflareaccess.com'}, {'common_name': 'other.access'},
            {'type': 'org'}, {'sub': 'human'}, {'exp': int(time.time())-1})]
        variations.append({'Cf-Access-Jwt-Assertion': self.headers['Cf-Access-Jwt-Assertion'][:-12] + 'AAAAAAAAAAAA'})
        for headers in variations:
            with self.subTest(headers=list(headers)):
                self.assertEqual(self.post(headers=headers).status_code, 403)
        self.assertEqual(self.upstream.calls, [])

    def test_revocation_atomic_replacement_expiry_and_reenable_old_jwt(self):
        self.assertEqual(self.post().status_code, 200)
        for changes in ({'enabled': False}, {'expiresAt': int(time.time())-1}, {'serviceId': 'another.access'},
                        {'version': True}, {'expiresAt': 'tomorrow'}, {'extra': 'untrusted'}):
            self.grant(**changes)
            self.assertEqual(self.post().status_code, 403)
            self.assertEqual(self.get('/internal/dev/v1/status').status_code, 403)
        self.admission_path.unlink()
        self.assertEqual(self.post().status_code, 403)
        self.admission_path.write_text('{not-json')
        self.admission_path.chmod(0o600)
        self.assertEqual(self.post().status_code, 403)
        self.assertEqual(len(self.upstream.calls), 2)
        self.grant()
        # Same still-valid service JWT works only after an explicit new grant;
        # changing admission does not reset the existing process's quota.
        self.assertEqual(self.post().status_code, 200)
        self.assertEqual(len(self.upstream.calls), 4)

    def test_revocation_during_upload_auth_and_health_prevents_new_read(self):
        def revoke_upload():
            yield b'{"token":'
            self.grant(enabled=False)
            yield json.dumps(TOKEN).encode() + b'}'
        response = self.client.post('/internal/read/v1/token', content=revoke_upload(),
                                    headers={**self.headers, 'Content-Type': 'application/json'})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.upstream.calls, [])
        self.grant()
        original_verify = self.gateway.verifier.verifier.verify
        def revoke_auth(assertion):
            result = original_verify(assertion)
            self.grant(enabled=False)
            return result
        with patch.object(self.gateway.verifier.verifier, 'verify', side_effect=revoke_auth):
            self.assertEqual(self.post().status_code, 403)
        self.assertEqual(self.upstream.calls, [])
        self.grant()
        original_read = self.upstream.request
        def revoke_health(route, body=None, *, deadline, request_id=None):
            result = original_read(route, body, deadline=deadline)
            if route == 'health': self.grant(enabled=False)
            return result
        self.upstream.request = revoke_health
        self.assertEqual(self.post().status_code, 403)
        self.assertEqual([route for route, _ in self.upstream.calls], ['health'])

    def test_exact_host_remote_origin_duplicates_and_cookie_boundary(self):
        assertion = self.headers['Cf-Access-Jwt-Assertion']
        for extra in ({'Host': 'localhost:8891'}, {'Host': '127.0.0.1:8878'}, {'Host': '127.0.0.1'},
                      {'Host': 'dev-read.example'}, {'Origin': 'http://127.0.0.1:5273'},
                      {'Authorization': 'Bearer other'}, {'Cookie': 'session=other'},
                      {'Cookie': 'CF_Authorization=' + assertion + ';'}):
            self.assertEqual(self.post(headers={**self.headers, **extra}).status_code, 403)
        duplicate = list(self.headers.items()) + [('cf-access-jwt-assertion', assertion)]
        self.assertEqual(self.post(headers=duplicate).status_code, 422)
        external = self.make_client(self.gateway, client=('192.0.2.10', 40000))
        self.assertEqual(self.post(client=external).status_code, 403)
        for suffix in (',', ';', '=', '%2E', '\t'):
            invalid = assertion + suffix
            self.assertEqual(self.post(headers={'Cf-Access-Jwt-Assertion': invalid,
                                                'Cookie': 'CF_Authorization=' + invalid}).status_code, 403)
        self.assertEqual(self.upstream.calls, [])
        self.assertEqual(self.post(headers={**self.headers, 'Cookie': 'CF_Authorization=' + assertion}).status_code, 200)

    def test_process_quota_cannot_be_reset_by_ip_headers_callers_or_grant_rotation(self):
        now = [100.]
        profile = DevProfile(ISSUER, AUDIENCE, SERVICE, 'a'*40, 'b'*40, 'c'*64, 6, 2)
        budget = PrincipalBudget(profile, self.admission, clock=lambda: now[0])
        self.gateway.budgets = budget
        other = self.make_client(self.gateway, client=('127.0.0.2', 50000))
        for ip, client in [('192.0.2.1', self.client), ('2001:db8::1', other)]:
            self.assertEqual(self.post(headers={**self.headers, 'CF-Connecting-IP': ip}, client=client).status_code, 200)
        self.grant(enabled=False)
        self.grant()
        self.assertEqual(self.post(headers={**self.headers, 'CF-Connecting-IP': '192.0.2.254'}).status_code, 429)
        self.assertEqual(len(self.upstream.calls), 4)
        now[0] += 10
        self.assertEqual(self.post().status_code, 200)
        with self.assertRaises(DataError): budget.admit('another-principal')

    def test_guarded_metadata_disabled_factory_and_seven_route_capabilities(self):
        paths = ('/internal/read/v1/capabilities', '/internal/dev/v1/status')
        for path in paths:
            self.assertEqual(self.get(path, headers={}).status_code, 403)
        capabilities = self.get(paths[0])
        self.assertEqual(capabilities.status_code, 200)
        self.assertEqual(capabilities.json()['enabledReads'], list(DEV_READS))
        self.assertFalse(capabilities.json()['ownerTransactions'])
        # A plain/production reader is not mislabelled as a qualified dev reader.
        self.upstream.request = lambda route, body=None, *, deadline: Upstream.request(
            self.upstream, route, body, deadline=deadline)
        status = self.get(paths[1])
        self.assertEqual(status.status_code, 200)
        self.assertEqual(status.json()['readerCommit'], 'a'*40)
        self.assertEqual(status.json()['gatewayCommit'], 'b'*40)
        self.assertEqual(status.json()['providerHealth'], 'not_probed')
        self.assertNotIn(SERVICE, status.text)
        self.assertNotIn(ISSUER, status.text)
        self.assertNotIn('frontendCommit', status.json())
        self.assertEqual(status.json()['readerConnection'], {'state': 'incompatible'})
        self.assertEqual([route for route, _ in self.upstream.calls], ['health'])
        self.gateway.enabled = False
        self.assertEqual(self.post().status_code, 404)
        response = self.get(paths[0])
        self.assertEqual(response.json()['dataMode'], 'disabled')
        self.assertEqual(response.json()['enabledReads'], [])
        empty = self.make_client(DevGateway())
        self.assertEqual(self.post(client=empty).status_code, 403)

    def test_status_exposes_only_validated_reader_admission_without_provider_work(self):
        original = self.upstream.request
        state = ['ready']
        changes = [{}]
        def reader_health(route, body=None, *, deadline, request_id=None):
            self.assertEqual(route, 'health')
            self.assertLessEqual(deadline - time.monotonic(), 3)
            status, data, metadata = original(route, body, deadline=deadline)
            data['devAdmission'] = {'state': state[0], 'retryAfterSeconds': 60 if state[0] == 'cooldown' else 0,
                                    'startsPerMinute': 6, 'minimumStartIntervalSeconds': 2, **changes[0]}
            return 200 if state[0] == 'ready' else 503, data, metadata
        self.upstream.request = reader_health
        for value in ('ready', 'cooldown', 'qualification_disabled', 'qualification_expired'):
            state[0] = value
            response = self.get('/internal/dev/v1/status')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.json()['readerConnection']['state'], value)
            self.assertEqual(response.json()['providerHealth'], 'not_probed')
            self.assertNotIn('generation', response.text.lower())
            self.assertEqual(response.json()['gatewayAdmission']['minimumStartIntervalSeconds'], 2)
        changes[0] = {'startsPerMinute': 600}
        self.assertEqual(self.get('/internal/dev/v1/status').json()['readerConnection'], {'state': 'incompatible'})
        self.assertEqual([route for route, _ in self.upstream.calls], ['health'] * 5)

    def test_status_unreachable_reader_is_honest_and_revocation_after_health_denies(self):
        self.upstream.request = Mock(side_effect=DataError('upstream_timeout'))
        response = self.get('/internal/dev/v1/status')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['readerConnection'], {'state': 'unavailable'})
        self.assertEqual(response.json()['providerHealth'], 'not_probed')
        def revoked(route, body=None, *, deadline, request_id=None):
            self.grant(enabled=False)
            raise DataError('upstream_timeout')
        self.upstream.request = revoked
        self.assertEqual(self.get('/internal/dev/v1/status').status_code, 403)

    def test_data_requires_strict_development_health_and_never_posts_when_denied(self):
        now = [0.]
        self.gateway.budgets = PrincipalBudget(self.profile, self.admission, clock=lambda: now[0])
        original = self.upstream.request
        cases = [
            ('legacy', 503, 'upstream_unavailable'),
            ('cooldown', 429, 'read_capacity_busy'),
            ('qualification_disabled', 503, 'upstream_unavailable'),
            ('qualification_expired', 503, 'upstream_unavailable'),
            ('invalid_admission', 503, 'upstream_unavailable'),
            ('wrong_contract', 503, 'upstream_unavailable'),
            ('wrong_generation', 503, 'upstream_unavailable'),
        ]
        for state, expected_status, expected_error in cases:
            def transport(route, body=None, *, deadline, request_id=None):
                self.assertEqual(route, 'health')
                status, data, metadata = original(route, body, deadline=deadline)
                if state == 'legacy':
                    data.pop('devAdmission')
                elif state == 'invalid_admission':
                    data['devAdmission']['startsPerMinute'] = 600
                elif state == 'wrong_contract':
                    metadata['contract'] = 'wrong'
                elif state == 'wrong_generation':
                    metadata['generation'] = 'f' * 32
                else:
                    data['devAdmission'].update(state=state, retryAfterSeconds=2 if state == 'cooldown' else 0)
                    status = 503
                return status, data, metadata
            self.upstream.request = transport
            with self.subTest(state=state):
                response = self.post()
                self.assertEqual(response.status_code, expected_status, response.text)
                self.assertEqual(response.json(), {'error': expected_error})
                if state == 'cooldown': self.assertEqual(response.headers['Retry-After'], '2')
            now[0] += 2
        self.assertEqual([route for route, _ in self.upstream.calls], ['health'] * len(cases))
        self.upstream.request = original
        self.assertEqual(self.post().status_code, 200)

    def test_control_metadata_has_separate_bounded_budget_and_data_cadence(self):
        now = [100.]
        profile = DevProfile(ISSUER, AUDIENCE, SERVICE, 'a'*40, 'b'*40, 'c'*64)
        gateway = DevGateway(profile=profile, admission=self.admission, enabled=True, verifier=self.verifier(),
                             upstream=self.upstream, clock=lambda: now[0])
        client = self.make_client(gateway)
        original = self.upstream.request
        def transport(route, body=None, *, deadline, request_id=None):
            return original(route, body, deadline=time.monotonic() + 15)
        self.upstream.request = transport
        for path in ('/internal/dev/v1/status', '/internal/read/v1/capabilities'):
            self.assertEqual(client.get(path, headers=self.headers).status_code, 200)
        # Authenticated startup GETs do not exhaust the default burst of two reads.
        # Use a fixture transport with the actual monotonic deadline for data.
        self.assertEqual(self.post(client=client).status_code, 200)
        now[0] += 1
        self.assertEqual(self.post(client=client).status_code, 429)
        now[0] += 1
        self.assertEqual(self.post(client=client).status_code, 200)
        for _ in range(4):  # One control token refilled during the two-second data cadence.
            self.assertEqual(client.get('/internal/dev/v1/status', headers=self.headers).status_code, 200)
        self.assertEqual(client.get('/internal/dev/v1/status', headers=self.headers).status_code, 429)

    def test_forbidden_paths_methods_queries_and_strict_body_do_not_dispatch(self):
        for route in ('pool-positions', 'pool-metrics', 'health', 'status', 'token/x', '%74oken',
                      'token?target=http://127.0.0.1:8876', 'token/'):
            self.assertEqual(self.post(route).status_code, 404)
        for path in ('/health', '/openapi.json', '/internal/session/v1/state', '/internal/dev/v1/status/x'):
            self.assertEqual(self.get(path).status_code, 404)
        self.assertEqual(self.get('/internal/read/v1/token').status_code, 405)
        self.assertEqual(self.post('capabilities').status_code, 405)
        self.assertEqual(self.post(body={'token': TOKEN, 'rpcUrl': 'https://example.invalid'}).status_code, 422)
        for raw, status in ((b' '*8193, 413), (b'{"token":"a","token":"b"}', 422), (b'{"token":NaN}', 422)):
            response = self.client.post('/internal/read/v1/token', content=raw,
                                       headers={**self.headers, 'Content-Type': 'application/json'})
            self.assertEqual(response.status_code, status)
        self.assertEqual(self.post(headers={**self.headers, 'Content-Encoding': 'gzip'}).status_code, 415)
        self.assertEqual(self.post(headers={**self.headers, 'X-Domino-Read-Contract': '9.0.0'}).status_code, 502)
        self.assertEqual(self.upstream.calls, [])

    def test_profile_admission_files_and_runtime_lock_fail_closed(self):
        for changes in ({'gatewayPort': 8878}, {'readerPort': 8876}, {'readerPort': 8892}, {'requestsPerMinute': 31},
                        {'burst': 6}, {'burst': True}, {'readerCommit': 'main'}, {'extra': 'value'}):
            self.write_json(self.profile_path, {**self.profile_json, **changes})
            with self.assertRaises(DataError): DevProfile.load(self.profile_path)
        self.write_json(self.profile_path, self.profile_json)
        self.profile_path.chmod(0o644)
        with self.assertRaises(DataError): DevProfile.load(self.profile_path)
        self.profile_path.chmod(0o600)
        link = self.profile_dir / 'linked.json'
        link.symlink_to(self.profile_path)
        with self.assertRaises(OSError): DevProfile.load(link)
        self.profile_dir.chmod(0o755)
        self.assertFalse(self.admission.allowed())
        self.profile_dir.chmod(0o700)
        self.admission_path.chmod(0o644)
        self.assertFalse(self.admission.allowed())
        self.grant()
        self.admission_path.unlink()
        self.admission_path.symlink_to(self.profile_path)
        self.assertFalse(self.admission.allowed())
        runtime = self.directory / 'dev-read-gateway'
        runtime.mkdir(mode=0o700)
        fd = acquire_runtime_lock(runtime, self.profile_path)
        try:
            with self.assertRaises(OSError): acquire_runtime_lock(runtime, self.profile_path)
        finally: os.close(fd)
        fd = acquire_runtime_lock(runtime, self.profile_path)
        os.close(fd)
        with self.assertRaises(DataError): acquire_runtime_lock(self.profile_dir, self.profile_path)
        for port in (8765, 8876, 8878, 8879, 8880, 8881, 8892):
            with self.assertRaises(DataError):
                DevGateway(profile=self.profile, admission=self.admission, upstream=LocalReaderHTTP(port))

    def test_launcher_defaults_disabled_uses_private_lock_and_cannot_enable_revoked_profile(self):
        runtime = self.directory / 'dev-read-gateway'
        runtime.mkdir(mode=0o700)
        argv = ['dev_read_gateway.py', '--profile', str(self.profile_path), '--runtime-dir', str(runtime),
                '--port', '8891', '--reader-port', '8890']
        self.grant(enabled=False)
        with patch.object(sys, 'argv', argv), patch('uvicorn.run') as run:
            main()
        self.assertFalse(run.call_args.args[0].state.gateway.enabled)
        self.assertEqual(run.call_args.kwargs['host'], '127.0.0.1')
        self.assertEqual(run.call_args.kwargs['workers'], 1)
        self.assertFalse(run.call_args.kwargs['proxy_headers'])
        self.assertFalse(run.call_args.kwargs['access_log'])
        with patch.object(sys, 'argv', argv + ['--enable']), patch('uvicorn.run') as run, self.assertRaises(SystemExit) as stopped:
            main()
        self.assertEqual(stopped.exception.code, 2)
        run.assert_not_called()
        fd = acquire_runtime_lock(runtime, self.profile_path)
        os.close(fd)

    def test_opaque_cursor_context_and_gateway_namespace(self):
        inventory = AlchemyInventory(URL, transport=ProviderTransport([page([TOKEN], next_key='private-provider-page')]), clock=lambda: 1010)
        upstream = DevUpstream(inventory=inventory)
        self.gateway.upstream.upstream = upstream
        self.gateway.cursors = OpaqueCursors(clock=lambda: upstream.now)
        response = self.post('wallet-assets', {'wallet': OWNER, 'tokens': [TOKEN]})
        self.assertEqual(response.status_code, 200, response.text)
        handle = response.json()['inventory']['nextCursor']
        self.assertRegex(handle, r'^[0-9a-f]{64}$')
        self.assertNotIn('private-provider-page', response.text)
        response = self.post('wallet-assets', {'wallet': OWNER, 'cursor': handle})
        self.assertEqual(response.status_code, 400)
        self.gateway.cursors = OpaqueCursors(clock=lambda: upstream.now)
        response = self.post('wallet-assets', {'wallet': OWNER, 'tokens': [TOKEN], 'cursor': handle})
        self.assertEqual(response.status_code, 400)
        self.assertEqual([name for name, _ in upstream.calls], ['health', 'wallet-assets', 'health', 'health'])

    def test_timeout_reconciles_busy_and_actual_inflight_work_holds_admission(self):
        original = self.upstream.request
        busy = [False]
        def interrupted(route, body=None, *, deadline, request_id=None):
            if route != 'health' and not busy[0]:
                busy[0] = True
                raise DataError('upstream_timeout')
            result = original(route, body, deadline=deadline)
            if route == 'health': result[1]['busy'] = busy[0]
            return result
        self.upstream.request = interrupted
        self.assertEqual(self.post().status_code, 504)
        self.assertEqual(self.post().status_code, 429)
        self.assertEqual([name for name, _ in self.upstream.calls], ['health', 'health'])
        self.upstream.request = original
        entered, release = Event(), Event()
        def held(route, body=None, *, deadline, request_id=None):
            if route == 'token':
                entered.set()
                if not release.wait(3): raise RuntimeError('test timeout')
            return original(route, body, deadline=deadline)
        self.upstream.request = held
        responses = []
        thread = Thread(target=lambda: responses.append(self.post()))
        thread.start()
        try:
            self.assertTrue(entered.wait(2))
            self.grant(enabled=False)
            self.assertEqual(self.post().status_code, 403)
            self.grant()
            self.assertEqual(self.post().status_code, 429)
        finally:
            release.set()
            thread.join(4)
        self.assertEqual(responses[0].status_code, 200)

    def test_dispatch_failure_releases_slot_and_identity_consumes_total_deadline(self):
        with patch('dev_read_gateway.anyio.to_thread.run_sync', side_effect=RuntimeError('private diagnostic')):
            response = self.post()
        self.assertEqual(response.status_code, 503)
        self.assertNotIn('private', response.text)
        self.assertEqual(self.post().status_code, 200)
        now = [100.]
        self.gateway.clock = lambda: now[0]
        def slow_verify(_): now[0] += 21
        self.gateway.verifier.verifier = Mock()
        self.gateway.verifier.verifier.verify.side_effect = slow_verify
        before = len(self.upstream.calls)
        self.assertEqual(self.post().status_code, 504)
        self.assertEqual(len(self.upstream.calls), before)

    def test_cancelling_http_caller_does_not_release_actual_worker_admission(self):
        entered, release = Event(), Event()
        original = self.upstream.request
        def held(route, body=None, *, deadline, request_id=None):
            if route == 'token':
                entered.set()
                if not release.wait(3): raise RuntimeError('test timeout')
            return original(route, body, deadline=deadline)
        self.upstream.request = held
        async def exercise():
            transport = httpx.ASGITransport(app=create_dev_gateway(self.gateway))
            async with httpx.AsyncClient(transport=transport, base_url='http://127.0.0.1:8891', headers=self.headers) as client:
                first = asyncio.create_task(client.post('/internal/read/v1/token', json={'token': TOKEN}))
                try:
                    self.assertTrue(await asyncio.to_thread(entered.wait, 2))
                    first.cancel()
                    await asyncio.sleep(0)
                    second = await client.post('/internal/read/v1/token', json={'token': TOKEN})
                    self.assertEqual(second.status_code, 429)
                finally:
                    release.set()
                    try: await first
                    except asyncio.CancelledError: pass
        asyncio.run(exercise())

    def test_combined_development_reader_cooldown_ready_contract_and_revocation(self):
        # The #132 integration includes the dedicated reader candidate. Both
        # HTTP hops are in-process; every external RPC uses this fixed fixture.
        from dev_read_service import create_dev_app
        from test_read_rpc_batching import Provider
        from read_contract import validate_response
        runtime = self.directory / 'development-runtime'
        runtime.mkdir(mode=0o700)
        reader_profile = {'version': 1, 'kind': 'domino-development-reader', 'enabled': True,
                          'runtimeDirectory': str(runtime), 'rpcUrls': ['https://rpc.mainnet.chain.robinhood.com'],
                          'inventoryUrl': None, 'catalogue': None,
                          'quotaQualification': {'approved': True, 'expiresAt': 2000, 'receiptSha256': 'd'*64}}
        now, wall, provider = [0.], [1010], Provider()
        def transport(url, body=None, **kwargs): return provider(url, body)
        reader = TestClient(create_dev_app(reader_profile, enable=True, transport=transport,
                                          clock=lambda: wall[0], monotonic=lambda: now[0]),
                            base_url='http://127.0.0.1:8890')
        self.addCleanup(reader.close)
        gateway = DevGateway(profile=self.profile, admission=self.admission, enabled=False,
                             verifier=self.verifier(), upstream=LocalReaderHTTP(8890, client=reader, clock=lambda: now[0]),
                             clock=lambda: now[0])
        client = self.make_client(gateway)
        self.assertEqual(self.post(client=client).status_code, 404)
        gateway.enabled = True
        self.assertEqual(self.post(client=client, headers={}).status_code, 403)
        self.assertEqual(self.post('pool-positions', client=client).status_code, 404)
        status_path = '/internal/dev/v1/status'
        response = client.get(status_path, headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()['readerConnection']['state'], 'cooldown')
        self.assertEqual(response.json()['readerConnection']['retryAfterSeconds'], 60)
        self.assertEqual(self.post(client=client).status_code, 429)
        self.assertEqual(provider.envelopes, [])
        now[0] = 60
        self.assertEqual(client.get(status_path, headers=self.headers).json()['readerConnection']['state'], 'ready')
        default_profile = DevProfile(ISSUER, AUDIENCE, SERVICE, 'a'*40, 'b'*40, 'c'*64)
        gateway.budgets = PrincipalBudget(default_profile, self.admission, clock=lambda: now[0])
        response = self.post(client=client, body={'token': '0x' + '00'*20})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.headers['X-Domino-Read-Contract'], CONTRACT_VERSION)
        validate_response('token', response.json())
        self.assertGreater(provider.logical_count(), 0)
        for instant in (62, 70, 80, 90, 100):
            now[0] = instant
            self.assertEqual(self.post(client=client, body={'token': '0x' + '00'*20}).status_code, 200)
        count = len(provider.envelopes)
        now[0] = 110
        response = self.post(client=client, body={'token': '0x' + '00'*20})
        self.assertEqual(response.status_code, 429)
        self.assertEqual(response.json(), {'error': 'read_capacity_busy'})
        self.assertEqual(len(provider.envelopes), count)
        connection = client.get(status_path, headers=self.headers).json()['readerConnection']
        self.assertEqual(connection['state'], 'cooldown')
        self.assertEqual(connection['retryAfterSeconds'], 10)
        now[0] = 120
        self.assertEqual(self.post(client=client, body={'token': '0x' + '00'*20}).status_code, 200)
        count = len(provider.envelopes)
        self.grant(enabled=False)
        self.assertEqual(self.post(client=client).status_code, 403)
        self.assertEqual(client.get(status_path, headers=self.headers).status_code, 403)
        self.grant()
        response = client.get(status_path, headers=self.headers)
        self.assertEqual(response.json()['readerConnection']['state'], 'cooldown')
        wall[0] = 2000
        now[0] = 130
        self.assertEqual(client.get(status_path, headers=self.headers).json()['readerConnection']['state'], 'qualification_expired')
        self.assertEqual(self.post(client=client).status_code, 503)
        self.assertEqual(len(provider.envelopes), count)


if __name__ == '__main__': unittest.main()
