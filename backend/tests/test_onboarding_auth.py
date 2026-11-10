"""Read authorization/quotas on disposable PostgreSQL, using synthetic SIWE keys."""
from concurrent.futures import ThreadPoolExecutor
from threading import Event
import os
from pathlib import Path
import sys
import time
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg.rows import dict_row
from eth_account import Account
from eth_account.messages import encode_defunct

from dev_postgres import ADMIN, PORT, SOCKET
from discovery import DataError
from onboarding_auth import BUDGETS, OnboardingAuth, preview_budget, serving
from read_deadline import read_deadline
from session_models import SessionError
from session_service import SessionService
from session_siwe import SiwePolicy
from session_store import (CAPACITIES, LOCK_ID, PREVIEW_ACCOUNT_LIMIT, PREVIEW_GLOBAL_LIMIT,
                           PREVIEW_IP_LIMIT, SessionStore,
                           _DeadlineConnection, digest)

VALIDATION = {'method': 'plain_eoa', 'blockNumber': '123', 'blockHash': '0x' + 'ab' * 32}
SECRET = b'synthetic onboarding abuse-key secret only'
PREVIEW = 'https://preview.domino-app-e65.pages.dev'
OWNER = '0x' + '12' * 20
SESSION, CSRF = 's' * 43, 'c' * 43


class Checker:
    def __init__(self):
        self.calls = []
        self.effect = None

    def check(self, owner):
        self.calls.append(owner)
        return self.effect(owner) if self.effect else dict(VALIDATION)


class OnboardingAuthUnitTests(unittest.TestCase):
    def setUp(self):
        self.store = Mock()
        self.store.begin_preview.return_value = {'address': OWNER, 'chainId': 4663}
        self.checker = Checker()
        self.auth = OnboardingAuth(self.store, self.checker)

    def error(self, code, call):
        with self.assertRaises(SessionError) as raised:
            call()
        self.assertEqual(raised.exception.code, code)

    def test_client_scope_matches_siwe_ipv6_prefix_and_mapped_ipv4(self):
        for raw, expected in (('2001:db8:1:2::a', '2001:db8:1:2::/64'),
                              ('::ffff:192.0.2.1', '192.0.2.1'),
                              ('192.0.2.2', '192.0.2.2')):
            with self.subTest(raw=raw):
                self.auth.begin(raw, SESSION, CSRF)
                # Changed on purpose 2026-11-04 (review M1): with the admitted origin, None outside a listener.
                self.store.begin_preview.assert_called_with(expected, SESSION, CSRF, budget='onboarding', origin=None)

    def test_each_kind_of_signed_in_work_spends_its_own_budget(self):
        # 3 Nov 2026 (launch): status polling never spends what a plan or a quote needs.
        for family, route, budget in (('position-plan', 'plan', 'plan'), ('crosschain', 'quote', 'crosschain-quote'),
                                      ('crosschain', 'origins', 'crosschain-quote'),
                                      ('crosschain', 'status', 'crosschain-status'),
                                      ('execution', 'status', 'execution-performance'),
                                      ('execution', 'availability', 'execution-performance'),
                                      ('performance', 'cards', 'execution-performance'),
                                      ('deposit', 'create', 'onboarding'), ('onboarding', 'swap-preview', 'onboarding')):
            with self.subTest(family=family, route=route), serving(family, route):
                self.auth.begin('192.0.2.1', SESSION, CSRF)
                self.store.begin_preview.assert_called_with('192.0.2.1', SESSION, CSRF, budget=budget, origin=None)
            # The worker's next request starts from no family at all.
            self.assertEqual(preview_budget(), 'onboarding')

    def test_every_budgeted_route_is_a_route_its_family_serves(self):
        import crosschain_api, crosschain_models, execution_status, performance_api, performance_models
        import performance_v2_api, performance_v2_models, v2_position_plan_api, v2_position_plan_models
        served = {(module.PREFIX.split('/')[2], route) for module, models in (
            (v2_position_plan_api, v2_position_plan_models), (crosschain_api, crosschain_models),
            (execution_status, execution_status), (performance_api, performance_models),
            (performance_v2_api, performance_v2_models)) for route in models.REQUEST_MODELS}
        self.assertLessEqual(set(BUDGETS), served)

    def test_invalid_client_never_touches_store_or_checker(self):
        for client in (None, {}, 'example.com', '2001:db8::1%en0', '192.0.2.1:443'):
            with self.subTest(client=client):
                self.error('invalid_request', lambda: self.auth.begin(client, SESSION, CSRF))
        self.store.begin_preview.assert_not_called()
        self.assertEqual(self.checker.calls, [])

    def test_order_rechecks_database_before_provider_context_and_after_result(self):
        order = []
        self.store.begin_preview.side_effect = lambda *args, **kwargs: (
            order.append('reserve'), {'address': OWNER, 'chainId': 4663})[-1]
        self.checker.effect = lambda owner: (order.append('account_check'), dict(VALIDATION))[-1]
        self.store.finish_preview.side_effect = lambda *args, **kwargs: order.append('recheck')
        context = self.auth.begin('192.0.2.1', SESSION, CSRF)
        self.assertEqual(order, ['reserve', 'account_check', 'recheck'])
        # Changed on purpose 2026-11-04 (review M1): the context keeps the origin its session checks are held to.
        self.assertEqual(context, {'owner': OWNER, 'session': SESSION, 'csrf': CSRF, 'validation': VALIDATION, 'origin': None})
        self.assertIsNone(self.auth.finish(context))
        self.assertEqual(order, ['reserve', 'account_check', 'recheck', 'recheck'])
        self.assertEqual(self.checker.calls, [OWNER])

    def test_db_denial_or_deadline_prevents_account_check(self):
        self.store.begin_preview.side_effect = SessionError('csrf_invalid')
        self.error('csrf_invalid', lambda: self.auth.begin('192.0.2.1', SESSION, CSRF))
        self.assertEqual(self.checker.calls, [])
        now = [0.0]
        def reserve(*args, **kwargs):
            now[0] = 2.0
            return {'address': OWNER, 'chainId': 4663}
        self.store.begin_preview.side_effect = reserve
        with self.assertRaises(DataError):
            with read_deadline(1, clock=lambda: now[0]):
                self.error('request_timeout', lambda: self.auth.begin('192.0.2.1', SESSION, CSRF))
        self.assertEqual(self.checker.calls, [])
        self.store.finish_preview.assert_not_called()

    def test_checker_rejects_invalid_metadata_and_only_unsupported_revokes(self):
        for failure in ('account_check_unavailable', 'account_unsupported', 'invalid_metadata'):
            self.store.reset_mock()
            def effect(owner):
                if failure == 'invalid_metadata':
                    return {**VALIDATION, 'secret': 'not a public field'}
                raise SessionError(failure)
            self.checker.effect = effect
            expected = 'account_check_unavailable' if failure == 'invalid_metadata' else failure
            self.error(expected, lambda: self.auth.begin('192.0.2.1', SESSION, CSRF))
            self.assertEqual(self.store.revoke.call_count, int(failure == 'account_unsupported'))
            self.store.finish_preview.assert_not_called()


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1',
                     'set DOMINO_TEST_POSTGRES=1 after prepare-tests')
class OnboardingAuthPostgresTests(unittest.TestCase):
    def setUp(self):
        self.settings = {'host': str(SOCKET), 'port': PORT, 'dbname': 'domino_catalogue_tests'}
        self.admin = psycopg.connect(**self.settings, user=ADMIN, autocommit=True, row_factory=dict_row)
        self.addCleanup(self.admin.close)
        self.admin.execute('TRUNCATE domino_sessions.contexts,domino_sessions.challenges,domino_sessions.sessions,'
                           'domino_sessions.rate_limits,domino_sessions.private_limits')
        self.store = SessionStore(self.settings, abuse_secret=SECRET)
        self.peer = SessionStore(self.settings, abuse_secret=SECRET)
        self.checker = Checker()
        self.service = SessionService(self.store, SiwePolicy('https://domino.money'), self.checker)
        self.auth = OnboardingAuth(self.store, self.checker)

    def error(self, code, call):
        with self.assertRaises(SessionError) as raised:
            call()
        self.assertEqual(raised.exception.code, code)

    def login(self, number=1, *, account_number=None):
        client = f'192.0.2.{number}'
        account = Account.from_key(bytes([account_number or number]) * 32)
        first = self.service.execute('bootstrap', {}, client=client)
        preauth = first['credentials']['preauth']
        csrf = first['result']['csrfToken']
        challenge = self.service.execute('challenge', {'address': account.address, 'chainId': 4663},
                                         client=client, preauth=preauth, csrf=csrf)['result']
        signature = '0x' + Account.sign_message(encode_defunct(text=challenge['message']), account.key).signature.hex()
        result = self.service.execute('verify', {'challengeId': challenge['challengeId'],
                                                'message': challenge['message'], 'signature': signature},
                                      client=client, preauth=preauth, csrf=csrf)
        return {'client': client, 'session': result['credentials']['session'],
                'csrf': result['result']['csrfToken']}, account.address.lower()

    def bucket(self, kind, value):
        return self.admin.execute('SELECT count FROM domino_sessions.rate_limits WHERE key_hash=%s',
                                  (self.store._key(kind, value),)).fetchone()

    def preview_login(self, number=1):
        """A session signed in on the listed preview (review M1): its own SIWE message, its row's origin."""
        from session_siwe import siwe_policies
        service = SessionService(self.store, siwe_policies('https://domino.money', PREVIEW), self.checker)
        client = f'192.0.2.{number}'
        account = Account.from_key(bytes([number]) * 32)
        first = service.execute('bootstrap', {}, client=client, origin=PREVIEW)
        preauth, csrf = first['credentials']['preauth'], first['result']['csrfToken']
        challenge = service.execute('challenge', {'address': account.address, 'chainId': 4663}, client=client,
                                    preauth=preauth, csrf=csrf, origin=PREVIEW)['result']
        signature = '0x' + Account.sign_message(encode_defunct(text=challenge['message']), account.key).signature.hex()
        result = service.execute('verify', {'challengeId': challenge['challengeId'], 'message': challenge['message'],
                                            'signature': signature}, client=client, preauth=preauth, csrf=csrf,
                                 origin=PREVIEW)
        return {'client': client, 'session': result['credentials']['session'],
                'csrf': result['result']['csrfToken']}, account.address.lower()

    def test_a_listener_holds_every_session_check_to_the_origin_it_admitted(self):
        """Review M1 (4 Nov 2026): an authenticated listener's session checks take the origin it admitted."""
        preview, preview_owner = self.preview_login(1)
        self.assertEqual(self.row(preview['session'])['origin'], PREVIEW)
        production, owner = self.login(2)
        self.assertIsNone(self.row(production['session'])['origin'])
        checked = self.checker.calls.count(owner)
        with serving('position-plan', 'plan', PREVIEW):
            self.assertEqual(self.auth.begin(**preview)['owner'], preview_owner)
            self.error('session_required', lambda: self.auth.begin(**production))
        # Refused before the account's budget or its chain check, not only at the last recheck.
        self.assertIsNone(self.bucket('plan-account@preview', owner))
        self.assertEqual(self.checker.calls.count(owner), checked)
        with serving('position-plan', 'plan'):
            self.assertEqual(self.auth.begin(**production)['owner'], owner)
            self.error('session_required', lambda: self.auth.begin(**preview))
        # The context's later recheck keeps its origin even outside the listener's scope.
        with serving('position-plan', 'plan', PREVIEW):
            context = self.auth.begin(**preview)
        self.auth.finish(context)
        self.error('session_required', lambda: self.auth.finish({**context, 'origin': None}))
        self.error('session_required', lambda: self.store.finish_preview(preview['session'], preview['csrf'],
                                                                         preview_owner, dict(VALIDATION)))
        # A preview's plans spend the preview's budgets, production's its own. A refused attempt spends the IP budget
        # of the origin it came through, as any refused credential does.
        for kind, value in (('plan-global', 'all'), ('plan-ip', '192.0.2.1'), ('plan-account', preview_owner)):
            self.assertEqual(self.bucket(kind + '@preview', value)['count'], 2, kind)
        self.assertEqual(self.bucket('plan-ip@preview', '192.0.2.2')['count'], 1)
        self.assertEqual(self.bucket('plan-global', 'all')['count'], 1)
        self.assertEqual(self.bucket('plan-account', owner)['count'], 1)
        self.assertEqual(self.bucket('plan-ip', '192.0.2.1')['count'], 1)
        self.assertIsNone(self.bucket('plan-account', preview_owner))

    def row(self, session):
        return self.admin.execute('SELECT * FROM domino_sessions.sessions WHERE bearer_hash=%s',
                                  (digest(session),)).fetchone()

    def test_projection_and_two_rechecks_preserve_csrf_and_absolute_expiry(self):
        credentials, owner = self.login()
        initial = self.row(credentials['session'])
        projection = self.store.begin_preview(**credentials)
        # The delegate the session was admitted with travels too: a cached account check may answer only it.
        self.assertEqual(projection, {'address': owner, 'chainId': 4663, 'delegate': None})
        context = self.auth.begin(**credentials)
        self.assertIsNone(self.auth.finish(context))
        current = self.row(credentials['session'])
        self.assertEqual(bytes(current['csrf_hash']), bytes(initial['csrf_hash']))
        self.assertEqual(current['expires_at'], initial['expires_at'])
        self.assertGreaterEqual(current['last_used_at'], initial['last_used_at'])
        self.assertEqual(current['block_hash'], VALIDATION['blockHash'])
        for secret in (credentials['session'], credentials['csrf']):
            self.assertNotIn(secret, str(projection))
            self.assertNotIn(secret, str(current))

    def test_missing_malformed_unknown_and_wrong_csrf_charge_ip_without_external_read(self):
        credentials, owner = self.login()
        self.checker.calls.clear()
        cases = [({'session': None}, 'session_required'), ({'session': 'bad'}, 'invalid_request'),
                 ({'session': 'x' * 43}, 'session_required'), ({'csrf': None}, 'csrf_invalid'),
                 ({'csrf': '\N{SNOWMAN}'}, 'invalid_request'), ({'csrf': 'x' * 43}, 'csrf_invalid')]
        for change, expected in cases:
            with self.subTest(change=change):
                self.error(expected, lambda: self.auth.begin(**{**credentials, **change}))
        self.assertEqual(self.bucket('onboarding-ip', credentials['client'])['count'], len(cases))
        self.assertIsNone(self.bucket('onboarding-account', owner))
        self.assertIsNone(self.bucket('onboarding-global', 'all'))
        self.assertEqual(self.checker.calls, [])

    def test_expired_idle_revoked_and_wrong_chain_sessions_never_reach_checker(self):
        for number, change in enumerate(('absolute', 'idle', 'revoked', 'chain'), start=1):
            credentials, owner = self.login(number)
            self.checker.calls.clear()
            if change == 'absolute':
                self.admin.execute("UPDATE domino_sessions.sessions SET created_at=statement_timestamp()-interval '13 hours',"
                                   "expires_at=statement_timestamp()-interval '1 hour',last_used_at=statement_timestamp()-interval '2 hours' "
                                   'WHERE bearer_hash=%s', (digest(credentials['session']),))
            elif change == 'idle':
                self.admin.execute("UPDATE domino_sessions.sessions SET created_at=statement_timestamp()-interval '1 hour',"
                                   "expires_at=statement_timestamp()+interval '11 hours',last_used_at=statement_timestamp()-interval '31 minutes' "
                                   'WHERE bearer_hash=%s', (digest(credentials['session']),))
            elif change == 'revoked':
                self.store.revoke(credentials['session'])
            if change == 'chain':
                original = self.store._session
                # The schema also constrains this value. Exercise the helper's
                # explicit defense without weakening the shared database schema.
                with patch.object(self.store, '_session', side_effect=lambda *args: {**original(*args), 'chain_id': 1}):
                    self.error('session_required', lambda: self.auth.begin(**credentials))
            else:
                self.error('session_required', lambda: self.auth.begin(**credentials))
            self.assertEqual(self.checker.calls, [])
            self.assertEqual(self.bucket('onboarding-ip', credentials['client'])['count'], 1)

    def test_finish_rejects_logout_owner_chain_and_csrf_changes(self):
        for number, change in enumerate(('logout', 'owner', 'chain', 'csrf'), start=1):
            credentials, owner = self.login(number)
            context = self.auth.begin(**credentials)
            if change == 'logout':
                self.peer.logout(credentials['client'], None, credentials['session'], credentials['csrf'])
            elif change == 'owner':
                self.admin.execute('UPDATE domino_sessions.sessions SET address=%s WHERE bearer_hash=%s',
                                   (OWNER, digest(credentials['session'])))
            elif change == 'csrf':
                self.admin.execute('UPDATE domino_sessions.sessions SET csrf_hash=%s WHERE bearer_hash=%s',
                                   (digest('z' * 43), digest(credentials['session'])))
            if change == 'chain':
                original = self.store._session
                with patch.object(self.store, '_session', side_effect=lambda *args: {**original(*args), 'chain_id': 1}):
                    self.error('session_required', lambda: self.auth.finish(context))
            else:
                self.error('csrf_invalid' if change == 'csrf' else 'session_required', lambda: self.auth.finish(context))
            self.assertEqual(self.bucket('onboarding-account', owner)['count'], 1)

    def test_logout_during_account_read_denies_before_returning_provider_context(self):
        credentials, owner = self.login()
        self.checker.effect = lambda address: (self.peer.revoke(credentials['session']), dict(VALIDATION))[-1]
        self.error('session_required', lambda: self.auth.begin(**credentials))
        self.assertEqual(self.bucket('onboarding-account', owner)['count'], 1)
        self.assertEqual(self.bucket('onboarding-global', 'all')['count'], 1)

    def test_failures_reserve_account_budget_across_instances_and_session_rotation(self):
        first, owner = self.login()
        second, same_owner = self.login(2, account_number=1)
        self.assertEqual(same_owner, owner)
        self.checker.calls.clear()
        for index in range(PREVIEW_ACCOUNT_LIMIT):
            auth = self.auth if index % 2 == 0 else OnboardingAuth(self.peer, self.checker)
            context = auth.begin(**(first if index % 2 == 0 else second))
            # A provider failure/abandonment never calls finish and has no refund.
            self.assertEqual(context['owner'], owner)
        self.error('session_rate_limited', lambda: self.auth.begin(**second))
        self.assertEqual(len(self.checker.calls), PREVIEW_ACCOUNT_LIMIT)
        self.assertEqual(self.bucket('onboarding-account', owner)['count'], PREVIEW_ACCOUNT_LIMIT)
        # The refused attempt spent neither the site's budget nor its IP's (3 Nov 2026).
        self.assertEqual(self.bucket('onboarding-global', 'all')['count'], PREVIEW_ACCOUNT_LIMIT)
        self.assertEqual(self.bucket('onboarding-ip', second['client'])['count'], PREVIEW_ACCOUNT_LIMIT // 2)

    def test_status_polling_spends_its_own_budget_and_never_a_plans(self):
        credentials, owner = self.login()
        with serving('execution', 'status'):
            for index in range(PREVIEW_ACCOUNT_LIMIT):
                self.auth.begin(**credentials)
            self.error('session_rate_limited', lambda: self.auth.begin(**credentials))
        with serving('position-plan', 'plan'):
            self.assertEqual(self.auth.begin(**credentials)['owner'], owner)
        self.assertEqual(self.bucket('execution-performance-account', owner)['count'], PREVIEW_ACCOUNT_LIMIT)
        self.assertEqual(self.bucket('plan-account', owner)['count'], 1)
        self.assertEqual(self.bucket('plan-ip', credentials['client'])['count'], 1)
        self.assertIsNone(self.bucket('onboarding-account', owner))

    def test_account_check_failures_consume_budget_without_revoke(self):
        credentials, owner = self.login()
        self.checker.calls.clear()
        def fail(address):
            raise SessionError('account_check_unavailable')
        self.checker.effect = fail
        for index in range(PREVIEW_ACCOUNT_LIMIT):
            self.error('account_check_unavailable', lambda: self.auth.begin(**credentials))
        self.error('session_rate_limited', lambda: self.auth.begin(**credentials))
        self.assertEqual(len(self.checker.calls), PREVIEW_ACCOUNT_LIMIT)
        self.assertIsNone(self.row(credentials['session'])['revoked_at'])

    def test_unsupported_account_is_revoked_and_metadata_never_updates(self):
        credentials, owner = self.login()
        def fail(address):
            raise SessionError('account_unsupported')
        self.checker.effect = fail
        self.error('account_unsupported', lambda: self.auth.begin(**credentials))
        self.assertIsNotNone(self.row(credentials['session'])['revoked_at'])
        self.error('session_required', lambda: self.auth.begin(**credentials))

    def test_ip_quota_is_shared_for_ipv6_prefix_and_mapped_ipv4_and_resets(self):
        for prefix in ('ipv6', 'ipv4'):
            for index in range(PREVIEW_IP_LIMIT):
                client = f'2001:db8:1:2::{index+1:x}' if prefix == 'ipv6' else '192.0.2.40'
                self.error('session_required', lambda: self.auth.begin(client, 'x' * 43, CSRF))
            client = '2001:db8:1:2::ffff' if prefix == 'ipv6' else '::ffff:192.0.2.40'
            self.error('session_rate_limited', lambda: OnboardingAuth(self.peer, self.checker).begin(client, 'y' * 43, CSRF))
        self.admin.execute("UPDATE domino_sessions.rate_limits SET reset_at=clock_timestamp()-interval '1 second'")
        self.error('session_required', lambda: self.auth.begin('192.0.2.40', 'x' * 43, CSRF))
        self.assertEqual(self.bucket('onboarding-ip', '192.0.2.40')['count'], 1)
        self.assertEqual(self.checker.calls, [])

    def test_global_quota_is_shared_across_owners_and_its_refusal_charges_nothing(self):
        full, rest = divmod(PREVIEW_GLOBAL_LIMIT, PREVIEW_ACCOUNT_LIMIT)
        for number in range(1, full + 2):
            credentials, owner = self.login(number)
            for index in range(PREVIEW_ACCOUNT_LIMIT if number <= full else rest):
                self.store.begin_preview(**credentials)
        self.assertEqual(self.bucket('onboarding-global', 'all')['count'], PREVIEW_GLOBAL_LIMIT)
        credentials, owner = self.login(full + 2)
        before = len(self.checker.calls)
        self.error('session_rate_limited', lambda: OnboardingAuth(self.peer, self.checker).begin(**credentials))
        self.assertEqual(len(self.checker.calls), before)
        # 3 Nov 2026: a refused attempt no longer spends its own account's and IP's budgets.
        self.assertIsNone(self.bucket('onboarding-account', owner))
        self.assertIsNone(self.bucket('onboarding-ip', credentials['client']))
        self.assertEqual(self.bucket('onboarding-global', 'all')['count'], PREVIEW_GLOBAL_LIMIT)

    def test_the_site_wide_limit_is_read_before_credentials_and_names_its_window(self):
        credentials, owner = self.login()
        self.checker.calls.clear()
        self.admin.execute("INSERT INTO domino_sessions.rate_limits VALUES (%s,clock_timestamp()+interval '42 seconds',%s)",
                           (self.store._key('onboarding-global', 'all'), PREVIEW_GLOBAL_LIMIT))
        # Missing or unknown credentials are refused for the site, not charged to their IP.
        for change in ({}, {'session': 'x' * 43}, {'session': None}):
            with self.subTest(change=change), self.assertRaises(SessionError) as raised:
                self.auth.begin(**{**credentials, **change})
            self.assertEqual(raised.exception.code, 'session_rate_limited')
            self.assertTrue(40 < raised.exception.retry_after <= 42, raised.exception.retry_after)
        self.assertIsNone(self.bucket('onboarding-ip', credentials['client']))
        self.assertIsNone(self.bucket('onboarding-account', owner))
        self.assertEqual(self.checker.calls, [])
        # The longest full window is the one named: the IP's here.
        self.admin.execute("INSERT INTO domino_sessions.rate_limits VALUES (%s,clock_timestamp()+interval '55 seconds',%s)",
                           (self.store._key('onboarding-ip', credentials['client']), PREVIEW_IP_LIMIT))
        with self.assertRaises(SessionError) as raised:
            self.auth.begin(**credentials)
        self.assertTrue(53 < raised.exception.retry_after <= 55, raised.exception.retry_after)

    def test_concurrent_reservations_cannot_exceed_account_limit(self):
        credentials, owner = self.login()
        busy = Event()
        def reserve(index):
            # Lock contention is a retryable admission denial, not a quota
            # decision. Its transaction rolls back without reserving a slot.
            for attempt in range(20):
                try:
                    return (self.store if index % 2 else self.peer).begin_preview(**credentials)
                except SessionError as error:
                    if error.code != 'session_capacity_busy' or attempt == 19:
                        return error.code
                    busy.set()
                    time.sleep(.02)
        with ThreadPoolExecutor(max_workers=4) as pool:
            # Exercise the real 250 ms lock timeout, independent of runner speed.
            # Release before collecting futures, including on assertion failure.
            with self.admin.transaction():
                self.admin.execute('SELECT pg_advisory_xact_lock(%s)', (LOCK_ID,))
                futures = [pool.submit(reserve, index) for index in range(PREVIEW_ACCOUNT_LIMIT + 4)]
                saw_contention = busy.wait(timeout=5)
            self.assertTrue(saw_contention, 'workers did not exercise lock contention')
            results = [future.result() for future in futures]
        self.assertEqual(sum(isinstance(result, dict) for result in results), PREVIEW_ACCOUNT_LIMIT, results)
        self.assertEqual(results.count('session_rate_limited'), 4, results)
        self.assertEqual(self.bucket('onboarding-account', owner)['count'], PREVIEW_ACCOUNT_LIMIT)
        self.assertEqual(self.bucket('onboarding-global', 'all')['count'], PREVIEW_ACCOUNT_LIMIT)
        self.assertEqual(self.bucket('onboarding-ip', credentials['client'])['count'], PREVIEW_ACCOUNT_LIMIT)

    def test_capacity_saturation_never_reaches_checker_and_charges_nothing(self):
        # The signed-in charge needs three new keys (the site's, the IP's and the account's), so room for one or two
        # refuses it after the credentials (7 Nov 2026: the read before them never refuses for room) and before the
        # checker: neither keeps the IP's charge.
        for room in (1, 2):
            with self.subTest(room=room):
                self.setUp()
                credentials, owner = self.login()
                initial = self.admin.execute('SELECT count(*) AS n FROM domino_sessions.rate_limits').fetchone()['n']
                before = len(self.checker.calls)
                with patch.dict(CAPACITIES, {'rate_limits': initial + room}):
                    self.error('session_capacity_busy', lambda: self.auth.begin(**credentials))
                self.assertEqual(len(self.checker.calls), before)
                for kind, value in (('onboarding-ip', credentials['client']), ('onboarding-account', owner),
                                    ('onboarding-global', 'all')):
                    self.assertIsNone(self.bucket(kind, value), kind)

    def rows(self):
        return self.admin.execute('SELECT count(*) AS n FROM domino_sessions.rate_limits').fetchone()['n']

    def test_guesses_take_only_their_share_of_the_table_and_past_it_are_refused_uncounted(self):
        # 7 Nov 2026: nothing global bounds how many clients guess, so their new rows stop at GUESS_ROWS. Past that a
        # guess is refused as before but writes nothing; a client's existing window is still charged, and the rows
        # the global windows bound (sign-in's, a signed-in owner's) still find room.
        credentials, owner = self.login()
        share = self.rows() + 2
        with patch('session_store.GUESS_ROWS', share):
            for number in (1, 2):
                self.error('session_required', lambda: self.auth.begin(f'198.51.100.{number}', 'x' * 43, CSRF))
            self.assertEqual(self.rows(), share)
            self.error('session_required', lambda: self.auth.begin('198.51.100.3', 'x' * 43, CSRF))
            self.assertIsNone(self.bucket('onboarding-ip', '198.51.100.3'))
            self.assertEqual(self.rows(), share)
            self.error('session_required', lambda: self.auth.begin('198.51.100.1', 'x' * 43, CSRF))
            self.assertEqual(self.bucket('onboarding-ip', '198.51.100.1')['count'], 2)
            self.assertEqual(self.auth.begin(**credentials)['owner'], owner)
            self.assertEqual(self.bucket('onboarding-account', owner)['count'], 1)
            self.assertEqual(self.rows(), share + 3)

    def test_no_guess_is_refused_for_room_though_a_signed_in_request_still_is(self):
        # Room is the charge's question (7 Nov 2026): the read before the credentials never refuses for it, so on a
        # full table a guess from a new client keeps its own answer and writes nothing.
        credentials, owner = self.login()
        before, checks = self.rows(), len(self.checker.calls)
        with patch.dict(CAPACITIES, {'rate_limits': before}), patch('session_store.GUESS_ROWS', before):
            self.error('session_required', lambda: self.auth.begin('198.51.100.9', 'x' * 43, CSRF))
            self.error('session_capacity_busy', lambda: self.auth.begin(**credentials))
        self.assertEqual(self.rows(), before)
        self.assertEqual(len(self.checker.calls), checks)

    def test_fresh_expiry_guard_rolls_back_touch_and_keeps_prior_quota(self):
        credentials, owner = self.login()
        context = self.auth.begin(**credentials)
        original = _DeadlineConnection.execute
        touches = []
        def slow(conn, statement, params=None):
            if statement.startswith('SELECT * FROM sessions WHERE bearer_hash='):
                original(conn, "UPDATE sessions SET created_at=statement_timestamp()-interval '1 hour',"
                         "expires_at=statement_timestamp()+interval '11 hours',"
                         "last_used_at=statement_timestamp()-interval '30 minutes'+interval '100 milliseconds' "
                         'WHERE bearer_hash=%s', (digest(credentials['session']),))
            result = original(conn, statement, params)
            if statement.startswith('UPDATE sessions SET last_used_at='):
                touches.append(True)
                time.sleep(.15)
            return result
        before = self.row(credentials['session'])
        with patch.object(_DeadlineConnection, 'execute', slow):
            self.error('session_required', lambda: self.auth.finish(context))
        self.assertEqual(touches, [True])
        self.assertEqual(self.row(credentials['session'])['last_used_at'], before['last_used_at'])
        self.assertEqual(self.bucket('onboarding-account', owner)['count'], 1)

    def test_quota_rows_do_not_expose_client_or_owner_and_public_roles_cannot_read_them(self):
        credentials, owner = self.login()
        self.auth.begin(**credentials)
        rows = self.admin.execute('SELECT * FROM domino_sessions.rate_limits').fetchall()
        for sensitive in (credentials['client'], owner, credentials['session'], credentials['csrf']):
            self.assertNotIn(sensitive, str(rows))
        for role in ('domino_catalogue_reader', 'domino_catalogue_writer'):
            with psycopg.connect(**self.settings, user=role, autocommit=True) as conn:
                for query in ('SELECT * FROM domino_sessions.sessions', 'SELECT * FROM domino_sessions.rate_limits'):
                    with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                        conn.execute(query)


if __name__ == '__main__':
    unittest.main()
