"""Full offline SIWE -> HTTP preview -> logout flow; only disposable PostgreSQL.

Access JWT verification has separate cryptographic tests. Its transport identity
is mocked here, while SIWE signature verification, private auth state, both HTTP
listeners, both Uniswap adapters and mint calldata inspection are real.
"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import json
import os
from pathlib import Path
import sys
from threading import Event
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg.rows import dict_row
from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi.testclient import TestClient

from dev_postgres import ADMIN, PORT, SOCKET
from onboarding_api import OnboardingGateway, create_onboarding_app
from onboarding_auth import OnboardingAuth
from onboarding_service import OnboardingService
from session_api import SessionGateway, create_session_app
from session_service import SessionService
from session_siwe import SiwePolicy
from session_store import SessionStore, digest
from session_models import CONTRACT_VERSION as SESSION_VERSION
from wallet_access import WalletAccessAdmin
from uniswap_quote import ENDPOINT as QUOTE_ENDPOINT, UniswapQuote
from uniswap_position import ENDPOINT as POSITION_ENDPOINT, UniswapPosition
from test_lp_mint_inspection import fixture as mint_fixture, plan, set_plan
from test_uniswap_quote import A, B, payload as quote_payload
from test_uniswap_position import response as position_payload

ORIGIN = 'https://domino.money'
KEY = 'synthetic-onboarding-provider-key'
SECRET = b'synthetic full flow abuse secret only'
ASSERTION = 'synthetic-service-identity'
VALIDATION = {'method': 'plain_eoa', 'blockNumber': '123', 'blockHash': '0x' + 'ab' * 32}
SWAP_BODY = {'chainId': 4663, 'tokenIn': A, 'tokenOut': B, 'amountRaw': '1000',
             'slippageBps': 50, 'maxPriceImpactBps': 100}


def position_body():
    _, context = position_payload()
    key = context['pool_key']
    return {'chainId': 4663, 'poolId': context['pool_id'],
            'poolKey': {'currency0': key.currency0, 'currency1': key.currency1,
                        'fee_pips': key.fee_pips, 'tick_spacing': key.tick_spacing, 'hooks': key.hooks},
            'independentToken': key.currency0, 'amountRaw': '100',
            'tickLower': -120, 'tickUpper': 180, 'slippageBps': 50,
            'budget0Raw': '110', 'budget1Raw': '220', 'nativeBalanceRaw': '1000',
            'nativeGasReserveRaw': '300'}


class Provider:
    """Synthetic responses dynamically bound to the owner authenticated by SIWE."""
    def __init__(self):
        self.calls = []
        self.effect = None

    def __call__(self, url, body, **options):
        self.calls.append((url, deepcopy(body), deepcopy(options)))
        if self.effect:
            self.effect()
        if url == QUOTE_ENDPOINT:
            result = quote_payload()
            result['quote']['swapper'] = body['swapper']
            result['quote']['output']['recipient'] = body['recipient']
            return result
        if url == POSITION_ENDPOINT:
            result, _ = position_payload()
            transaction, _ = mint_fixture(recipient=body['walletAddress'])
            transaction['from'] = body['walletAddress']
            actions, params, _ = plan(transaction)
            set_plan(transaction, actions, params, deadline=body['deadline'])
            result['create'] = transaction
            return result
        raise AssertionError('Unexpected provider destination')


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1',
                     'set DOMINO_TEST_POSTGRES=1 after prepare-tests')
class OnboardingFlowTests(unittest.TestCase):
    def setUp(self):
        self.settings = {'host': str(SOCKET), 'port': PORT, 'dbname': 'domino_catalogue_tests'}
        self.admin = psycopg.connect(**self.settings, user=ADMIN, autocommit=True, row_factory=dict_row)
        self.addCleanup(self.admin.close)
        self.admin.execute('TRUNCATE domino_sessions.contexts,domino_sessions.challenges,domino_sessions.sessions,'
                           'domino_sessions.rate_limits,domino_sessions.private_limits')
        self.admin.execute('TRUNCATE domino_wallet_access.grants,domino_wallet_access.audit RESTART IDENTITY')
        self.access = WalletAccessAdmin(self.settings)
        self.session_store = SessionStore(self.settings, abuse_secret=SECRET)
        # Separate instances exercise durable shared state as separate processes do.
        self.preview_store = SessionStore(self.settings, abuse_secret=SECRET)
        self.checker = SimpleNamespace(check=Mock(side_effect=lambda owner: dict(VALIDATION)))
        self.verifier = SimpleNamespace(verify=Mock(return_value=True))
        self.provider = Provider()
        self.clock = lambda: 1000.5
        service = SessionService(self.session_store, SiwePolicy(ORIGIN), self.checker)
        session_gateway = SessionGateway(service=service, verifier=self.verifier, origin=ORIGIN, enabled=True)
        self.sessions = self.client(create_session_app(session_gateway), 8879)
        onboarding = OnboardingService(OnboardingAuth(self.preview_store, self.checker),
            UniswapQuote(KEY, transport=self.provider, clock=self.clock),
            UniswapPosition(KEY, transport=self.provider, clock=self.clock),
            clock=self.clock, private_values=(KEY,))
        gateway = OnboardingGateway(service=onboarding, verifier=self.verifier, origin=ORIGIN, enabled=True)
        self.previews = self.client(create_onboarding_app(gateway), 8880)
        # Fail any accidental fallback to a real HTTP/RPC provider. PostgreSQL
        # uses its private Unix socket and TestClient is an in-process ASGI transport.
        blocked = patch('urllib.request.OpenerDirector.open', side_effect=AssertionError('External network forbidden'))
        blocked.start()
        self.addCleanup(blocked.stop)

    def client(self, app, port):
        client = TestClient(app, client=('127.0.0.1', 43100), base_url=f'http://127.0.0.1:{port}')
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        return client

    def post(self, kind, route, body=None, credentials=None, *, client_id='192.0.2.1', extra_headers=None):
        credentials = credentials or {}
        headers = {'Content-Type': 'application/json', 'CF-Access-Jwt-Assertion': ASSERTION,
                   'X-Domino-Browser-Origin': ORIGIN,
                   'X-Domino-Client-Id': credentials.get('client', client_id),
                   f'X-Domino-{kind.title()}-Contract': SESSION_VERSION if kind == 'session' else '1.0.0'}
        for name in ('preauth', 'session', 'csrf'):
            if credentials.get(name) is not None:
                headers['X-Domino-' + name] = credentials[name]
        headers.update(extra_headers or {})
        client = self.sessions if kind == 'session' else self.previews
        # The browser GET /me is mediated as an internal POST by the session BFF.
        return client.post(f'/internal/{kind}/v1/{route}',
                           content=json.dumps(body or {}), headers=headers)

    def login(self, number=1):
        account = Account.from_key(bytes([number]) * 32)
        self.access.grant(account.address)
        client = f'192.0.2.{number}'
        response = self.post('session', 'bootstrap', client_id=client)
        self.assertEqual(response.status_code, 200, response.text)
        first = response.json()
        preauth = {'preauth': first['credentials']['preauth'], 'csrf': first['result']['csrfToken'], 'client': client}
        response = self.post('session', 'challenge', {'address': account.address, 'chainId': 4663}, preauth)
        self.assertEqual(response.status_code, 200, response.text)
        challenge = response.json()['result']
        # This synthetic signature authenticates login only. No transaction is signed.
        signature = '0x' + Account.sign_message(encode_defunct(text=challenge['message']), account.key).signature.hex()
        response = self.post('session', 'verify', {'challengeId': challenge['challengeId'],
                                                  'message': challenge['message'], 'signature': signature}, preauth)
        self.assertEqual(response.status_code, 200, response.text)
        authenticated = response.json()
        self.assertEqual(authenticated['result']['owner'], {'address': account.address.lower(), 'chainId': 4663})
        self.assertIsNone(authenticated['credentials']['preauth'])
        self.assertNotIn('set-cookie', response.headers)
        # The BFF holds this internal bearer in its HttpOnly cookie. The Python
        # integration test keeps the internal directive solely in local memory.
        return {'session': authenticated['credentials']['session'],
                'csrf': authenticated['result']['csrfToken'], 'client': client}, account.address.lower()

    def assert_error(self, response, status, code):
        self.assertEqual(response.status_code, status, response.text)
        self.assertEqual(response.json(), {'error': code})
        self.assertTrue({'no-store', 'no-transform'} <= {value.strip().lower() for value in response.headers['cache-control'].split(',')})
        self.assertNotIn('content-encoding', response.headers)
        self.assertNotIn('set-cookie', response.headers)

    def test_signed_login_then_both_real_adapters_use_authenticated_owner_and_strip_authority(self):
        credentials, owner = self.login()
        for route, body in (('swap-preview', SWAP_BODY), ('position-preview', position_body())):
            response = self.post('onboarding', route, body, credentials,
                                 extra_headers={'X-Domino-Owner': '0x' + 'ef' * 20})
            self.assertEqual(response.status_code, 200, response.text)
            preview = response.json()['preview']
            self.assertEqual(preview['request']['owner'], owner)
            self.assertEqual(preview['request']['chainId'], 4663)
            self.assertFalse(preview['executionAvailable'])
            self.assertEqual(preview['status'], 'preview_only')
            self.assertEqual(response.headers['X-Domino-Onboarding-Contract'], '1.0.0')
            self.assertTrue({'no-store', 'no-transform'} <= {value.strip().lower() for value in response.headers['cache-control'].split(',')})
            self.assertNotIn('content-encoding', response.headers)
            self.assertNotIn('set-cookie', response.headers)
            if route == 'position-preview':
                self.assertEqual(preview['position']['recipient'], owner)
            for secret in (credentials['session'], credentials['csrf'], KEY, ASSERTION, 'dd46508f',
                           'calldata', 'permitTransaction', 'credentials'):
                self.assertNotIn(secret, response.text)
        self.assertEqual(len(self.provider.calls), 2)
        self.assertEqual(self.provider.calls[0][1]['swapper'], owner)
        self.assertEqual(self.provider.calls[0][1]['recipient'], owner)
        self.assertEqual(self.provider.calls[1][1]['walletAddress'], owner)
        self.assertEqual(self.checker.check.call_count, 3)  # SIWE verify, swap, LP preview.
        bucket = self.admin.execute('SELECT count FROM domino_sessions.rate_limits WHERE key_hash=%s',
                                    (self.preview_store._key('onboarding-account', owner),)).fetchone()
        self.assertEqual(bucket['count'], 2)

    def test_logout_through_session_http_revokes_both_preview_routes_before_provider(self):
        credentials, owner = self.login()
        response = self.post('onboarding', 'swap-preview', SWAP_BODY, credentials)
        self.assertEqual(response.status_code, 200, response.text)
        response = self.post('session', 'logout', credentials=credentials)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['result'], {'authenticated': False})
        before = self.checker.check.call_count
        for route, body in (('swap-preview', SWAP_BODY), ('position-preview', position_body())):
            self.assert_error(self.post('onboarding', route, body, credentials), 401, 'session_required')
        self.assertEqual(len(self.provider.calls), 1)
        self.assertEqual(self.checker.check.call_count, before)

    def test_reload_and_two_tabs_keep_csrf_and_both_private_previews_work(self):
        credentials, owner = self.login()
        before = self.admin.execute('SELECT * FROM domino_sessions.sessions').fetchall()
        checks = self.checker.check.call_count
        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(lambda _: self.post('session', 'me', credentials={
                'session': credentials['session'], 'client': credentials['client']}), range(2)))
        for response in responses:
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()['result']['csrfToken'], credentials['csrf'])
        self.assertEqual(self.admin.execute('SELECT * FROM domino_sessions.sessions').fetchall(), before)
        self.assertEqual(self.checker.check.call_count, checks)
        for route, body in (('swap-preview', SWAP_BODY), ('position-preview', position_body())):
            response = self.post('onboarding', route, body, credentials)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()['preview']['request']['owner'], owner)
        self.assertEqual(len(self.provider.calls), 2)

    def test_removed_and_regranted_wallet_cannot_reuse_old_session_before_provider(self):
        credentials, owner = self.login()
        self.access.revoke(owner)
        checks = self.checker.check.call_count
        for regrant in (False, True):
            if regrant:
                self.access.grant(owner)
            for route, body in (('swap-preview', SWAP_BODY), ('position-preview', position_body())):
                self.assert_error(self.post('onboarding', route, body, credentials), 401, 'session_required')
            self.assert_error(self.post('session', 'me', credentials=credentials), 401, 'session_required')
        self.assertEqual(self.provider.calls, [])
        self.assertEqual(self.checker.check.call_count, checks)
        fresh, _ = self.login(1)
        self.assertEqual(self.post('onboarding', 'swap-preview', SWAP_BODY, fresh).status_code, 200)

    def test_logout_expiry_csrf_and_admission_changes_inflight_prevent_delivery(self):
        for number, change in enumerate(('logout', 'absolute_expiry', 'idle_expiry', 'csrf', 'revoke', 'regrant'), start=1):
            with self.subTest(change=change):
                credentials, owner = self.login(number)
                entered, released = Event(), Event()
                def pause_provider():
                    entered.set()
                    if not released.wait(3):
                        raise AssertionError('Test did not release provider')
                self.provider.effect = pause_provider
                before = len(self.provider.calls)
                with ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(self.post, 'onboarding', 'position-preview', position_body(), credentials)
                    try:
                        self.assertTrue(entered.wait(2), 'Provider did not start')
                        if change == 'logout':
                            response = self.post('session', 'logout', credentials=credentials)
                            self.assertEqual(response.status_code, 200, response.text)
                        elif change in ('revoke', 'regrant'):
                            self.access.revoke(owner)
                            if change == 'regrant':
                                self.access.grant(owner)
                        elif change == 'csrf':
                            self.admin.execute('UPDATE domino_sessions.sessions SET csrf_hash=%s WHERE bearer_hash=%s',
                                               (digest('z' * 43), digest(credentials['session'])))
                        elif change == 'absolute_expiry':
                            self.admin.execute("UPDATE domino_sessions.sessions SET created_at=statement_timestamp()-interval '13 hours',"
                                "expires_at=statement_timestamp()-interval '1 hour',last_used_at=statement_timestamp()-interval '2 hours' "
                                'WHERE bearer_hash=%s', (digest(credentials['session']),))
                        else:
                            self.admin.execute("UPDATE domino_sessions.sessions SET created_at=statement_timestamp()-interval '1 hour',"
                                "expires_at=statement_timestamp()+interval '11 hours',last_used_at=statement_timestamp()-interval '31 minutes' "
                                'WHERE bearer_hash=%s', (digest(credentials['session']),))
                    finally:
                        released.set()
                    result = future.result(timeout=3)
                self.provider.effect = None
                self.assert_error(result, 403 if change == 'csrf' else 401,
                                  'csrf_invalid' if change == 'csrf' else 'session_required')
                self.assertEqual(len(self.provider.calls), before + 1)
                bucket = self.admin.execute('SELECT count FROM domino_sessions.rate_limits WHERE key_hash=%s',
                                            (self.preview_store._key('onboarding-account', owner),)).fetchone()
                self.assertEqual(bucket['count'], 1)
                self.assertNotIn('preview', result.json())


if __name__ == '__main__':
    unittest.main()
