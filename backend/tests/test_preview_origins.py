"""Launch round P3 (4 Nov 2026), item 7, testing without real money: the listeners' exact preview origins.

The session listener and the six authenticated ones (onboarding, deposit, performance, execution status, position plan,
crosschain) admit the exact Pages preview origins their configuration lists besides their canonical origin: none by
default. A listed origin is admitted only as the whole string the bridge Worker sends in X-Domino-Browser-Origin; the
session service writes and checks each origin's own SIWE message. Each guard is pinned here: deleting it fails a test.
The real sign-in across two origins, against PostgreSQL, is in test_session_listener.py.
"""
from contextlib import ExitStack, redirect_stderr
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi.testclient import TestClient

from session_api import SessionGateway, create_session_app
from session_models import CONTRACT_VERSION as SESSION_VERSION, SessionError
from session_service import SessionService
from session_siwe import MAX_PREVIEW_ORIGINS, SiwePolicy, preview_origins, siwe_policies

ORIGIN = 'https://domino.money'
PREVIEW = 'https://preview.domino-app-e65.pages.dev'
SECOND = 'https://p3-testing.domino-app-e65.pages.dev'
# What else another deployment, another Pages project or a near miss can present for PREVIEW.
FOREIGN = (
    'https://other.domino-app-e65.pages.dev',        # another deployment of the same Pages project
    'https://domino-app-e65.pages.dev',              # the project's production pages.dev host
    'https://preview.domino-app.pages.dev',          # another project whose name is a prefix of ours
    'https://evil.preview.domino-app-e65.pages.dev', # a host under the listed one: a suffix match would admit it
    'https://evilpreview.domino-app-e65.pages.dev',  # a string ending in the listed host
    PREVIEW + '.evil.invalid',                       # a string starting with the listed origin
    'http://preview.domino-app-e65.pages.dev', PREVIEW + ':8443', PREVIEW + ':443', PREVIEW + '/',
    'https://PREVIEW.domino-app-e65.pages.dev', 'https://Preview.Domino-App-E65.pages.dev',
    'preview.domino-app-e65.pages.dev', 'null', '', PREVIEW + ',' + ORIGIN, ORIGIN + ',' + PREVIEW,
)
LONGEST = 'https://' + '.'.join(['a' * 63] * 4) + '.dev'
BROKEN = (
    'https://*.domino-app-e65.pages.dev', '*.pages.dev', '.domino-app-e65.pages.dev', 'https://*',
    'http://preview.domino-app-e65.pages.dev', PREVIEW + '/', PREVIEW + '/api', PREVIEW + ':443', PREVIEW + ':8443',
    'https://Preview.domino-app-e65.pages.dev', 'preview.domino-app-e65.pages.dev', 'https://user@' + PREVIEW[8:],
    'https://192.0.2.1', 'https://[2001:db8::1]', PREVIEW + '.', 'https://-preview.domino-app-e65.pages.dev',
    'https://preview_x.domino-app-e65.pages.dev', PREVIEW + ', ' + SECOND, PREVIEW + ',', ',' + PREVIEW,
    PREVIEW + ',' + PREVIEW, ' ', ORIGIN, LONGEST,
    ','.join(f'https://b{n}.domino-app-e65.pages.dev' for n in range(MAX_PREVIEW_ORIGINS + 1)),
    [PREVIEW, PREVIEW], [PREVIEW, 1], [PREVIEW, [SECOND]], [ORIGIN], {'origin': PREVIEW}, 1, True,
    b'https://preview.domino-app-e65.pages.dev',
)


class PreviewOriginListTests(unittest.TestCase):
    def test_none_is_listed_unless_one_is(self):
        for listed in (None, '', [], ()):
            with self.subTest(listed=listed):
                self.assertEqual(preview_origins(listed, ORIGIN), ())

    def test_exact_origins_are_listed_in_order(self):
        self.assertEqual(preview_origins(PREVIEW, ORIGIN), (PREVIEW,))
        self.assertEqual(preview_origins(f'{PREVIEW},{SECOND}', ORIGIN), (PREVIEW, SECOND))
        self.assertEqual(preview_origins([SECOND, PREVIEW], ORIGIN), (SECOND, PREVIEW))
        most = [f'https://b{n}.domino-app-e65.pages.dev' for n in range(MAX_PREVIEW_ORIGINS)]
        self.assertEqual(preview_origins(','.join(most), ORIGIN), tuple(most))
        self.assertEqual(MAX_PREVIEW_ORIGINS, 4)

    def test_anything_but_exact_origins_is_refused(self):
        self.assertGreater(len(LONGEST), 261)
        for listed in BROKEN:
            with self.subTest(listed=listed), self.assertRaises(ValueError):
                preview_origins(listed, ORIGIN)

    def test_each_origin_has_its_own_sign_in_message(self):
        policies = siwe_policies(ORIGIN, f'{PREVIEW},{SECOND}')
        self.assertEqual([(p.origin, p.domain, p.uri) for p in policies],
                         [(ORIGIN, 'domino.money', ORIGIN + '/'), (PREVIEW, PREVIEW[8:], PREVIEW + '/'),
                          (SECOND, SECOND[8:], SECOND + '/')])
        self.assertEqual([p.origin for p in siwe_policies(ORIGIN)], [ORIGIN])
        with self.assertRaises(ValueError):
            siwe_policies(ORIGIN, 'https://*.domino-app-e65.pages.dev')


SESSION_RESULT = {'result': {'status': 'challenge_required', 'csrfToken': 'c' * 43, 'expiresAt': '2026-09-10T20:00:00Z'},
                  'credentials': {'preauth': 'p' * 43}}


class SessionGatewayTests(unittest.TestCase):
    def client(self, **kwargs):
        self.service = SimpleNamespace(execute=Mock(return_value=json.loads(json.dumps(SESSION_RESULT))))
        gateway = SessionGateway(service=self.service, verifier=SimpleNamespace(verify=Mock()), origin=ORIGIN,
                                 enabled=True, **kwargs)
        client = TestClient(create_session_app(gateway), client=('127.0.0.1', 43100), base_url='http://127.0.0.1:8879')
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        return client

    @staticmethod
    def post(client, browser):
        return client.post('/internal/session/v1/bootstrap', content='{}', headers={
            'content-type': 'application/json', 'cf-access-jwt-assertion': 'synthetic-assertion',
            'x-domino-client-id': '192.0.2.1', 'x-domino-browser-origin': browser, 'x-domino-session-contract': SESSION_VERSION})

    def test_a_listed_preview_reaches_the_service_which_is_told_it(self):
        client = self.client(preview_origins=f'{PREVIEW},{SECOND}')
        for browser in (PREVIEW, SECOND, ORIGIN):
            with self.subTest(browser=browser):
                self.service.execute.reset_mock()
                self.assertEqual(self.post(client, browser).status_code, 200)
                self.assertEqual(self.service.execute.call_args.kwargs['origin'], browser)

    def test_no_other_origin_reaches_the_service(self):
        client = self.client(preview_origins=PREVIEW)
        for browser in FOREIGN + (SECOND,):
            with self.subTest(browser=browser):
                response = self.post(client, browser)
                self.assertEqual((response.status_code, response.json()), (403, {'error': 'origin_not_allowed'}))
        self.service.execute.assert_not_called()

    def test_a_preview_is_admitted_only_when_listed(self):
        for kwargs in ({}, {'preview_origins': None}, {'preview_origins': ''}):
            with self.subTest(kwargs=kwargs):
                client = self.client(**kwargs)
                self.assertEqual(self.post(client, PREVIEW).status_code, 403)
                self.assertEqual(self.post(client, ORIGIN).status_code, 200)

    def test_a_broken_list_refuses_to_configure_an_enabled_listener(self):
        for listed in BROKEN:
            with self.subTest(listed=listed), self.assertRaises(ValueError):
                SessionGateway(service=Mock(), verifier=Mock(), origin=ORIGIN, preview_origins=listed, enabled=True)
        # A disabled listener reads no configuration at all, as before.
        self.assertEqual(SessionGateway(preview_origins='https://*.pages.dev').origins, ())


class AuthenticatedGatewayTests(unittest.TestCase):
    """The shared boundary of the six authenticated listeners, through onboarding's real service and contract."""

    def client(self, **kwargs):
        from onboarding_api import OnboardingGateway, create_onboarding_app
        from test_onboarding_service import make_service
        self.service, self.auth, _, self.body = make_service()
        gateway = OnboardingGateway(service=self.service, verifier=SimpleNamespace(verify=Mock()), origin=ORIGIN,
                                    enabled=True, **kwargs)
        client = TestClient(create_onboarding_app(gateway), client=('127.0.0.1', 43100), base_url='http://127.0.0.1:8880')
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        return client

    def post(self, client, browser):
        from onboarding_models import CONTRACT_VERSION
        from test_onboarding_service import CSRF, SESSION
        return client.post('/internal/onboarding/v1/swap-preview', content=json.dumps(self.body), headers={
            'content-type': 'application/json', 'cf-access-jwt-assertion': 'synthetic-assertion',
            'x-domino-client-id': '192.0.2.1', 'x-domino-browser-origin': browser,
            'x-domino-onboarding-contract': CONTRACT_VERSION, 'x-domino-session': SESSION, 'x-domino-csrf': CSRF})

    def test_a_listed_preview_is_served_as_production_is(self):
        client = self.client(preview_origins=[PREVIEW, SECOND])
        for browser in (PREVIEW, SECOND, ORIGIN):
            with self.subTest(browser=browser):
                response = self.post(client, browser)
                self.assertEqual(response.status_code, 200, response.text)

    def test_no_other_origin_reaches_the_session_check(self):
        client = self.client(preview_origins=PREVIEW)
        for browser in FOREIGN + (SECOND,):
            with self.subTest(browser=browser):
                response = self.post(client, browser)
                self.assertEqual((response.status_code, response.json()), (403, {'error': 'origin_not_allowed'}))
        self.auth.begin.assert_not_called()

    def test_a_preview_is_admitted_only_when_listed(self):
        for kwargs in ({}, {'preview_origins': ''}):
            with self.subTest(kwargs=kwargs):
                client = self.client(**kwargs)
                self.assertEqual(self.post(client, PREVIEW).status_code, 403)
                self.assertEqual(self.post(client, ORIGIN).status_code, 200)

    def test_every_family_takes_the_list_and_refuses_a_broken_one(self):
        from crosschain_api import CrosschainGateway
        from deposit_api import DepositGateway
        from execution_status import ExecutionStatusGateway
        from onboarding_api import OnboardingGateway
        from performance_v2_api import PerformanceV2Gateway
        from v2_position_plan_api import PositionPlanGateway
        for family in (OnboardingGateway, DepositGateway, PerformanceV2Gateway, ExecutionStatusGateway,
                       PositionPlanGateway, CrosschainGateway):
            with self.subTest(family=family.__name__):
                gateway = family(service=Mock(), verifier=Mock(), origin=ORIGIN, preview_origins=PREVIEW, enabled=True)
                self.assertEqual(gateway.origins, (ORIGIN, PREVIEW))
                self.assertEqual(family(service=Mock(), verifier=Mock(), origin=ORIGIN, enabled=True).origins, (ORIGIN,))
                for listed in BROKEN:
                    with self.assertRaises(ValueError):
                        family(service=Mock(), verifier=Mock(), origin=ORIGIN, preview_origins=listed, enabled=True)


class IdentityAndRecordTests(unittest.TestCase):
    """Review L1 and M1 (4 Nov 2026): each origin rides its own Access identity, and the record names what was admitted."""

    def session_client(self, identity, preview_service_id):
        self.service = SimpleNamespace(execute=Mock(return_value=json.loads(json.dumps(SESSION_RESULT))))
        verifier = SimpleNamespace(verify=Mock(return_value=identity), preview_service_id=preview_service_id)
        gateway = SessionGateway(service=self.service, verifier=verifier, origin=ORIGIN, preview_origins=PREVIEW, enabled=True)
        client = TestClient(create_session_app(gateway), client=('127.0.0.1', 43100), base_url='http://127.0.0.1:8879')
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        return client

    def onboarding_client(self, identity, preview_service_id, seen):
        from onboarding_api import OnboardingGateway, create_onboarding_app
        from onboarding_auth import serving_origin
        from test_onboarding_service import make_service
        service, auth, _, self.body = make_service()
        begin = auth.begin.side_effect

        def recording(*args, **kwargs):
            seen.append(serving_origin())
            return auth.begin.return_value
        auth.begin.side_effect = recording
        verifier = SimpleNamespace(verify=Mock(return_value=identity), preview_service_id=preview_service_id)
        gateway = OnboardingGateway(service=service, verifier=verifier, origin=ORIGIN, preview_origins=PREVIEW, enabled=True)
        client = TestClient(create_onboarding_app(gateway), client=('127.0.0.1', 43100), base_url='http://127.0.0.1:8880')
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        self.assertIsNone(begin)
        return client

    def onboarding_post(self, client, browser):
        return AuthenticatedGatewayTests.post(self, client, browser)

    def test_the_session_listener_ties_each_origin_to_its_identity(self):
        from bridge_identity import PREVIEW as PREVIEW_IDENTITY, PRODUCTION
        for identity, configured, browser, admitted in (
                (PRODUCTION, None, ORIGIN, True), (PRODUCTION, None, PREVIEW, True),
                (PREVIEW_IDENTITY, 'fixture-preview', PREVIEW, True), (PREVIEW_IDENTITY, 'fixture-preview', ORIGIN, False),
                (PRODUCTION, 'fixture-preview', ORIGIN, True), (PRODUCTION, 'fixture-preview', PREVIEW, False)):
            with self.subTest(identity=identity, configured=configured, browser=browser):
                client = self.session_client(identity, configured)
                response = SessionGatewayTests.post(client, browser)
                self.assertEqual(response.status_code, 200 if admitted else 403, response.text)
                self.assertEqual(self.service.execute.called, admitted)

    def test_the_authenticated_listeners_tie_each_origin_to_its_identity_and_hold_auth_to_it(self):
        from bridge_identity import PREVIEW as PREVIEW_IDENTITY, PRODUCTION
        for identity, configured, browser, bound in (
                (PRODUCTION, None, ORIGIN, None), (PRODUCTION, None, PREVIEW, PREVIEW),
                (PREVIEW_IDENTITY, 'fixture-preview', PREVIEW, PREVIEW), (PREVIEW_IDENTITY, 'fixture-preview', ORIGIN, False),
                (PRODUCTION, 'fixture-preview', ORIGIN, None), (PRODUCTION, 'fixture-preview', PREVIEW, False)):
            with self.subTest(identity=identity, configured=configured, browser=browser):
                seen = []
                response = self.onboarding_post(self.onboarding_client(identity, configured, seen), browser)
                if bound is False:
                    self.assertEqual((response.status_code, response.json()), (403, {'error': 'origin_not_allowed'}))
                    self.assertEqual(seen, [])
                else:
                    self.assertEqual(response.status_code, 200, response.text)
                    # The session check runs held to the admitted origin, as the store keeps it.
                    self.assertEqual(seen, [bound])

    def test_the_record_names_the_admitted_origin_and_never_a_refused_one(self):
        from contextlib import redirect_stderr
        for browser, expected in ((PREVIEW, PREVIEW), (ORIGIN, ORIGIN), ('https://other.domino-app-e65.pages.dev', None)):
            with self.subTest(browser=browser):
                client = self.session_client('production', None)
                with redirect_stderr(io.StringIO()) as printed:
                    SessionGatewayTests.post(client, browser)
                record = json.loads(printed.getvalue().splitlines()[-1])
                self.assertEqual(record.get('origin'), expected)
                if expected is None:
                    self.assertNotIn('other.domino-app', printed.getvalue())
                seen = []
                with redirect_stderr(io.StringIO()) as printed:
                    self.onboarding_post(self.onboarding_client('production', None, seen), browser)
                record = json.loads(printed.getvalue().splitlines()[-1])
                self.assertEqual(record.get('origin'), expected)

    def test_a_malformed_list_is_off_and_said_so(self):
        from session_siwe import configured_preview_origins
        for listed, expected in ((None, ()), ('', ()), (PREVIEW, (PREVIEW,)), ([PREVIEW, SECOND], (PREVIEW, SECOND))):
            stream = io.StringIO()
            self.assertEqual(configured_preview_origins(listed, ORIGIN, 'X_LIST', stream=stream), expected)
            self.assertEqual(stream.getvalue(), '')
        for listed in BROKEN:
            with self.subTest(listed=listed):
                stream = io.StringIO()
                self.assertEqual(configured_preview_origins(listed, ORIGIN, 'X_LIST', stream=stream), ())
                self.assertEqual(stream.getvalue(), '<3>X_LIST is malformed: preview origins are off, the canonical origin serves.\n')
        # A JSON profile's string is malformed, not a comma-separated list.
        stream = io.StringIO()
        self.assertEqual(configured_preview_origins(PREVIEW, ORIGIN, 'X_LIST', comma=False, stream=stream), ())
        self.assertTrue(stream.getvalue().startswith('<3>X_LIST is malformed'))


class SessionServiceOriginTests(unittest.TestCase):
    """The SIWE message is the admitted origin's, at challenge and at verify; no store is reached for another."""

    def setUp(self):
        self.store = Mock()
        self.checker = Mock()
        self.service = SessionService(self.store, siwe_policies(ORIGIN, PREVIEW), self.checker)
        self.account = Account.from_key(bytes([7]) * 32)
        self.issued = datetime.now(timezone.utc).replace(microsecond=0) - timedelta(seconds=5)

    def challenge_message(self, origin):
        self.store.challenge.reset_mock()
        self.service.execute('challenge', {'address': self.account.address, 'chainId': 4663}, client='192.0.2.1',
                             preauth='p' * 43, csrf='c' * 43, origin=origin)
        issue = self.store.challenge.call_args.args[4]
        return issue(self.account.address.lower(), 'n' * 32, self.issued, self.issued + timedelta(minutes=5))

    def test_a_challenge_names_the_origin_it_was_asked_from(self):
        for origin in (ORIGIN, PREVIEW):
            with self.subTest(origin=origin):
                message = self.challenge_message(origin)
                self.assertTrue(message.startswith(f'{origin} wants you to sign in with your Ethereum account:\n'))
                self.assertIn(f'\nURI: {origin}/\n', message)
        # A direct caller that names no origin is the canonical one's, as before.
        self.store.challenge.reset_mock()
        self.service.execute('challenge', {'address': self.account.address, 'chainId': 4663}, client='192.0.2.1',
                             preauth='p' * 43, csrf='c' * 43)
        issue = self.store.challenge.call_args.args[4]
        self.assertTrue(issue(self.account.address.lower(), 'n' * 32, self.issued, self.issued + timedelta(minutes=5))
                        .startswith(ORIGIN + ' wants you'))

    def test_a_signature_signs_in_only_from_the_origin_its_message_names(self):
        message = self.challenge_message(PREVIEW)
        signature = '0x' + Account.sign_message(encode_defunct(text=message), self.account.key).signature.hex()
        challenge = {'id': 'a' * 32, 'address': self.account.address.lower(), 'nonce': 'n' * 32, 'message': message,
                     'issued_at': self.issued, 'expires_at': self.issued + timedelta(minutes=5)}
        self.store.reserve_verify.return_value = challenge
        self.store.finish_verify.return_value = {'result': {}, 'credentials': {}}
        self.checker.check.return_value = {'method': 'plain_eoa', 'blockNumber': '1', 'blockHash': '0x' + 'ab' * 32}
        body = {'challengeId': 'a' * 32, 'message': message, 'signature': signature}
        with self.assertRaisesRegex(SessionError, '^challenge_invalid$'):
            self.service.execute('verify', body, client='192.0.2.1', preauth='p' * 43, csrf='c' * 43, origin=ORIGIN)
        self.store.reserve_verified_address.assert_not_called()
        self.service.execute('verify', body, client='192.0.2.1', preauth='p' * 43, csrf='c' * 43, origin=PREVIEW)
        self.store.finish_verify.assert_called_once()

    def test_an_origin_without_a_policy_reaches_no_store(self):
        for origin in ('https://other.domino-app-e65.pages.dev', PREVIEW + '/', ''):
            with self.subTest(origin=origin), self.assertRaisesRegex(SessionError, '^origin_not_allowed$'):
                self.service.execute('bootstrap', {}, client='192.0.2.1', origin=origin)
        self.assertEqual(self.store.mock_calls, [])

    def test_policies_are_one_per_origin(self):
        self.assertEqual(list(self.service.policies), [ORIGIN, PREVIEW])
        self.assertEqual(self.service.siwe.origin, ORIGIN)
        self.assertEqual(SessionService(self.store, SiwePolicy(ORIGIN), self.checker).policies.keys(), {ORIGIN})
        for policies in ((), (SiwePolicy(ORIGIN), SiwePolicy(ORIGIN))):
            with self.subTest(policies=policies), self.assertRaises(ValueError):
                SessionService(self.store, policies, self.checker)


ENVIRON = {'DOMINO_SESSION_ABUSE_SECRET': 'ab' * 32, 'DOMINO_SESSION_ORIGIN': ORIGIN}


def ENVIRONMENT_FOR(family):
    return {**ENVIRON, f'DOMINO_{family}_ACCESS_SERVICE_ID': f'{family.lower()}.production'}
RPC = 'https://rpc.example.invalid/'


class LauncherTests(unittest.TestCase):
    """Each listener's launcher passes DOMINO_SESSION_PREVIEW_ORIGINS and its own preview Access identity on.

    Changed on purpose 2026-11-04 (review L3): a malformed list or identity turns the preview off with an
    error-priority journal line, and the listener starts for its canonical origin; a malformed list used to stop it.
    """
    FAMILY = None

    def launch(self, main, argv, patches, previews, preview_identity=None):
        """(gateway or exit code, stderr, the preview_service_id the verifier was built with)."""
        verifier = MagicMock()
        with tempfile.TemporaryDirectory() as temporary, ExitStack() as stack:
            lock_file = Path(temporary) / 'lock'
            lock_file.touch()
            environ = {**ENVIRONMENT_FOR(self.FAMILY), 'DOMINO_SESSION_PREVIEW_ORIGINS': previews}
            if preview_identity is not None:
                environ[f'DOMINO_{self.FAMILY}_ACCESS_PREVIEW_SERVICE_ID'] = preview_identity
            stack.enter_context(patch.dict(os.environ, environ, clear=True))
            stack.enter_context(patch.object(sys, 'argv', argv))
            for target, value in patches.items():
                stack.enter_context(patch(target, **value) if isinstance(value, dict) else patch(target, value))
            stack.enter_context(patch('bridge_identity.AccessVerifier', verifier))
            server = stack.enter_context(patch('uvicorn.run'))
            stderr = stack.enter_context(redirect_stderr(io.StringIO()))
            for target in [name for name in patches if name.endswith('acquire_session_lock')]:
                stack.enter_context(patch(target, side_effect=lambda *_: os.open(lock_file, os.O_RDONLY)))
            try:
                main()
            except SystemExit as exit_:
                server.assert_not_called()
                return exit_.code, stderr.getvalue(), None
            return (server.call_args.args[0].state.gateway, stderr.getvalue(),
                    verifier.call_args.kwargs.get('preview_service_id'))

    def check(self, main, argv, patches):
        full, stderr, identity = self.launch(main, argv, patches, f'{PREVIEW},{SECOND}', f'{self.FAMILY.lower()}.preview')
        self.assertTrue(full.enabled)
        self.assertEqual((full.origins, stderr, identity), ((ORIGIN, PREVIEW, SECOND), '', f'{self.FAMILY.lower()}.preview'))
        gateway, stderr, identity = self.launch(main, argv, patches, '')
        self.assertEqual((gateway.origins, stderr, identity), ((ORIGIN,), '', None))
        for listed in ('https://*.domino-app-e65.pages.dev', PREVIEW + '/', ORIGIN, PREVIEW + ', ' + SECOND):
            with self.subTest(listed=listed):
                gateway, stderr, _ = self.launch(main, argv, patches, listed)
                self.assertTrue(gateway.enabled)
                self.assertEqual(gateway.origins, (ORIGIN,))
                self.assertEqual(stderr, '<3>DOMINO_SESSION_PREVIEW_ORIGINS is malformed: preview origins are off, '
                                         'the canonical origin serves.\n')
        for value in ('bad id!', f'{self.FAMILY.lower()}.production'):
            with self.subTest(identity=value):
                gateway, stderr, identity = self.launch(main, argv, patches, PREVIEW, value)
                self.assertEqual((gateway.origins, identity), ((ORIGIN, PREVIEW), None))
                self.assertEqual(stderr, f'<3>DOMINO_{self.FAMILY}_ACCESS_PREVIEW_SERVICE_ID is malformed: the preview '
                                         'Access identity is off, production serves.\n')
        return full

    def test_session(self):
        self.FAMILY = 'SESSION'
        import session_api
        gateway = self.check(session_api.main, ['session_api.py', '--enable', '--rpc-config', '/private/rpc.json'], {
            'session_api.acquire_session_lock': MagicMock(), 'session_api.load_session_rpc_config': {'return_value': {}},
            'rpc_config.configured_rpc_urls': {'return_value': [RPC]}, 'session_chain.EoaChecker': MagicMock(),
            'session_store.SessionStore': MagicMock(),
            'catalogue.database_settings': MagicMock()})
        self.assertEqual(list(gateway.service.policies), [ORIGIN, PREVIEW, SECOND])

    def test_onboarding(self):
        self.FAMILY = 'ONBOARDING'
        import onboarding_api
        self.check(onboarding_api.main, ['onboarding_api.py', '--enable', '--rpc-config', '/private/rpc.json'], {
            'onboarding_api.acquire_session_lock': MagicMock(), 'onboarding_api.load_session_rpc_config': {'return_value': {}},
            'uniswap_config.load_config': {'return_value': {'apiKey': 'synthetic-key'}},
            'rpc_config.configured_rpc_urls': {'return_value': [RPC]}, 'session_chain.EoaChecker': MagicMock(),
            'session_store.SessionStore': MagicMock(), 'onboarding_auth.OnboardingAuth': MagicMock(),
            'onboarding_service.OnboardingService': MagicMock(), 'uniswap_quote.UniswapQuote': MagicMock(),
            'uniswap_position.UniswapPosition': MagicMock(), 'uniswap_route.UniswapRoute': MagicMock(), 'swap_route.SwapRoute': MagicMock(),
            'catalogue.database_settings': MagicMock()})

    def test_deposit(self):
        self.FAMILY = 'DEPOSIT'
        import deposit_api
        self.check(deposit_api.main, ['deposit_api.py', '--enable', '--rpc-config', '/private/rpc.json',
                                      '--admission-file', '/private/admission.json'], {
            'deposit_api.acquire_session_lock': MagicMock(), 'deposit_api.load_session_rpc_config': {'return_value': {}},
            'deposit_api.load_admission': {'return_value': {}},
            'uniswap_config.load_config': {'return_value': {'apiKey': 'synthetic-key'}},
            'rpc_config.configured_rpc_urls': {'return_value': [RPC]}, 'session_chain.EoaChecker': MagicMock(),
            'session_store.SessionStore': MagicMock(), 'onboarding_auth.OnboardingAuth': MagicMock(),
            'deposit_prepare.DirectDepositPreparer': MagicMock(), 'deposit_service.DepositService': MagicMock(),
            'deposit_store.DepositStore': MagicMock(), 'uniswap_position.UniswapPosition': MagicMock(),
            'catalogue.database_settings': MagicMock()})

    def test_performance(self):
        self.FAMILY = 'PERFORMANCE'
        import performance_v2_api
        self.check(performance_v2_api.main, ['performance_v2_api.py', 'serve', '--enable', '--profile', '/private/p.json'], {
            'session_api.acquire_session_lock': MagicMock(), 'performance_runtime.Runtime': MagicMock(),
            'rpc_config.configured_rpc_urls': {'return_value': [RPC]}, 'session_chain.EoaChecker': MagicMock(),
            'session_store.SessionStore': MagicMock(), 'onboarding_auth.OnboardingAuth': MagicMock(),
            'performance_v2_service.PerformanceV2Service': MagicMock()})

    def test_position_plan(self):
        self.FAMILY = 'POSITION_PLAN'
        import v2_position_plan_api
        self.check(v2_position_plan_api.main, ['v2_position_plan_api.py', '--enable', '--rpc-config', '/private/rpc.json'], {
            'session_api.acquire_session_lock': MagicMock(), 'session_api.load_session_rpc_config': {'return_value': {}},
            'v2_position_plan_config.load_settings': MagicMock(), 'local_config.load_config': {'return_value': {}},
            'v2_position_plan_api.build_planners': {'return_value': {}},
            'v2_position_plan_service.PositionPlanService': MagicMock(), 'onboarding_auth.OnboardingAuth': MagicMock(),
            'rpc_config.configured_rpc_urls': {'return_value': [RPC]}, 'session_chain.EoaChecker': MagicMock(),
            'session_store.SessionStore': MagicMock(),
            'catalogue.database_settings': MagicMock()})

    def test_crosschain(self):
        self.FAMILY = 'CROSSCHAIN'
        import crosschain_api
        self.check(crosschain_api.main, ['crosschain_api.py', '--enable', '--rpc-config', '/private/rpc.json'], {
            'crosschain_api.acquire_session_lock': MagicMock(), 'crosschain_api.load_session_rpc_config': {'return_value': {}},
            'crosschain_config.load_settings': MagicMock(), 'crosschain_across.destination_endpoints': {'return_value': {}},
            'crosschain_api.build_service': MagicMock(), 'rpc_config.configured_rpc_urls': {'return_value': [RPC]},
            'session_chain.EoaChecker': MagicMock(), 'session_store.SessionStore': MagicMock(),
            'onboarding_auth.OnboardingAuth': MagicMock(),
            'catalogue.database_settings': MagicMock()})


if __name__ == '__main__':
    unittest.main()
