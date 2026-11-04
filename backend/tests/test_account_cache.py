"""The account check's cache: read-only routes only, and only for the delegate a session was admitted with.

4 Nov 2026 (launch round P3). Every signed-in call paid the account check, six
sequential chain reads. P2's analysis (3 Nov) stands: a plain positive cache
loops sign-in for a wallet upgraded to EIP-7702 mid-session, because the answer
cached before the upgrade revokes the session signed in after it. These tests
hold the safe version to that: no loop, a changed delegate still revoked by the
next fresh read, never a cached answer for a write, a money path, verify or
refresh, and an entry that expires.
"""
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import sys
from threading import Event
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg.rows import dict_row

from dev_postgres import ADMIN, PORT, SOCKET
from onboarding_auth import BUDGETS, READ_ONLY_ROUTES, OnboardingAuth, serving
from session_chain import ACCOUNT_CACHE_SECONDS, MAX_CACHED_ACCOUNTS, AccountCache
from session_models import SessionError
from session_service import SessionService
from session_siwe import SiwePolicy
from session_store import SessionStore, digest
import test_onboarding_auth
from test_onboarding_auth import CSRF, OWNER, SECRET, SESSION

ACCOUNT, OTHER, THIRD = OWNER, '0x' + '34' * 20, '0x' + '56' * 20
DELEGATE, NEXT_DELEGATE = '0x' + 'de' * 20, '0x' + 'ad' * 20


def answer(delegate=None, block=100):
    """An account check's positive answer: a plain EOA, or one delegated with EIP-7702."""
    found = {'method': 'plain_eoa', 'blockNumber': str(block), 'blockHash': '0x%064x' % block}
    return found if delegate is None else {**found, 'method': 'eip7702_delegated', 'delegate': delegate}


class Chain:
    """The account checker over a chain whose account code the test changes; it counts its reads."""
    def __init__(self):
        self.delegate, self.block, self.failure, self.calls = None, 100, None, []

    def check(self, owner):
        self.calls.append(owner)
        if self.failure:
            raise SessionError(self.failure)
        self.block += 1
        return answer(self.delegate, self.block)


def served_routes():
    """Every (family, route) a signed-in listener serves, as authenticated_api names it."""
    import crosschain_api, crosschain_models, deposit_api, deposit_models, execution_status, onboarding_api
    import onboarding_models, performance_api, performance_models, performance_v2_api, performance_v2_models
    import v2_position_plan_api, v2_position_plan_models
    return {(module.PREFIX.split('/')[2], route) for module, models in (
        (onboarding_api, onboarding_models), (deposit_api, deposit_models),
        (v2_position_plan_api, v2_position_plan_models), (crosschain_api, crosschain_models),
        (execution_status, execution_status), (performance_api, performance_models),
        (performance_v2_api, performance_v2_models)) for route in models.REQUEST_MODELS}


class AccountCacheTests(unittest.TestCase):
    def setUp(self):
        self.chain, self.now = Chain(), [0.0]
        self.cache = AccountCache(self.chain, clock=lambda: self.now[0])

    def test_a_positive_check_is_kept_its_seconds_and_no_longer(self):
        self.assertEqual(ACCOUNT_CACHE_SECONDS, 60)
        first = self.cache.read_only(ACCOUNT, None)
        self.now[0] = ACCOUNT_CACHE_SECONDS - 0.001
        self.assertEqual(self.cache.read_only(ACCOUNT, None), first)
        self.assertEqual(len(self.chain.calls), 1)
        self.now[0] = ACCOUNT_CACHE_SECONDS
        self.assertEqual(self.cache.read_only(ACCOUNT, None)['blockNumber'], '102')
        self.assertEqual(len(self.chain.calls), 2)

    def test_its_age_counts_from_before_the_chain_was_read(self):
        def slow(owner):
            self.now[0] += 10
            return answer()
        self.chain.check = slow
        self.cache.fresh(ACCOUNT)
        self.now[0] = ACCOUNT_CACHE_SECONDS + 1
        calls = []
        self.chain.check = lambda owner: calls.append(owner) or answer()
        self.cache.read_only(ACCOUNT, None)
        self.assertEqual(calls, [ACCOUNT])

    def test_only_a_session_admitted_with_the_entrys_delegate_is_answered_from_it(self):
        self.cache.fresh(ACCOUNT)
        # Admitted with a delegate the entry does not name: the chain answers.
        self.chain.delegate = DELEGATE
        self.assertEqual(self.cache.read_only(ACCOUNT, DELEGATE)['delegate'], DELEGATE)
        self.assertEqual(self.cache.read_only(ACCOUNT, DELEGATE)['delegate'], DELEGATE)
        self.assertEqual(len(self.chain.calls), 2)
        # The entry now names DELEGATE: a session admitted as a plain EOA, or with another delegate, reads again.
        for admitted in (None, NEXT_DELEGATE):
            with self.subTest(admitted=admitted):
                before = len(self.chain.calls)
                self.cache.read_only(ACCOUNT, admitted)
                self.assertEqual(len(self.chain.calls), before + 1)
        # And another account never takes this one's entry.
        self.cache.read_only(OTHER, DELEGATE)
        self.assertEqual(self.chain.calls[-1], OTHER)

    def test_failures_unsupported_and_malformed_answers_are_never_kept(self):
        for failure in ('account_check_unavailable', 'account_unsupported', 'malformed'):
            with self.subTest(failure=failure):
                self.setUp()
                if failure == 'malformed':
                    self.chain.check = lambda owner: {**answer(), 'secret': 'no public field'}
                else:
                    self.chain.failure = failure
                with self.assertRaisesRegex(SessionError, '^account_unsupported$' if failure == 'account_unsupported'
                                            else '^account_check_unavailable$'):
                    self.cache.read_only(ACCOUNT, None)
                self.assertEqual(self.cache.entries, {})
                self.chain.check, self.chain.failure = Chain.check.__get__(self.chain), None
                before = len(self.chain.calls)
                self.cache.read_only(ACCOUNT, None)
                self.assertEqual(len(self.chain.calls), before + 1)

    def test_a_fresh_answer_from_any_route_renews_the_entry(self):
        self.cache.fresh(ACCOUNT)
        self.now[0] = 30
        self.chain.delegate = DELEGATE
        self.cache.fresh(ACCOUNT)
        self.now[0] = 80
        self.assertEqual(self.cache.read_only(ACCOUNT, DELEGATE)['blockNumber'], '102')
        self.assertEqual(len(self.chain.calls), 2)

    def test_an_answer_is_a_copy(self):
        self.cache.read_only(ACCOUNT, None)['method'] = 'contract'
        self.cache.fresh(OTHER)['blockHash'] = None
        self.cache.read_only(ACCOUNT, None)['delegate'] = DELEGATE
        self.assertEqual(self.cache.read_only(ACCOUNT, None), answer(None, 101))
        self.assertEqual(self.cache.read_only(OTHER, None), answer(None, 102))
        self.assertEqual(len(self.chain.calls), 2)

    def test_the_entries_hold_their_capacity_and_the_oldest_leaves_first(self):
        self.assertEqual(MAX_CACHED_ACCOUNTS, 4096)
        cache = AccountCache(self.chain, capacity=2, clock=lambda: self.now[0])
        cache.fresh(ACCOUNT)
        cache.fresh(OTHER)
        # Renewing an account it holds makes no room: nobody leaves.
        cache.fresh(OTHER)
        self.assertEqual(list(cache.entries), [ACCOUNT, OTHER])
        cache.fresh(ACCOUNT)        # renewed: OTHER is now the oldest
        cache.fresh(THIRD)
        self.assertEqual(list(cache.entries), [ACCOUNT, THIRD])
        before = len(self.chain.calls)
        cache.read_only(ACCOUNT, None)
        cache.read_only(THIRD, None)
        self.assertEqual(len(self.chain.calls), before)
        cache.read_only(OTHER, None)
        self.assertEqual(self.chain.calls[-1], OTHER)
        self.assertEqual(len(cache.entries), 2)

    def test_two_workers_never_hold_more_than_the_capacity(self):
        """The listener's workers share the entries: one worker's insert waits for the other's to finish."""
        inside, done = Event(), Event()

        class Entries(dict):
            def __setitem__(self, key, value):
                if key == OTHER:
                    inside.set()
                    # The second worker inserts now, unless the first holds what it needs.
                    done.wait(0.5)
                super().__setitem__(key, value)
                if key == THIRD:
                    done.set()

        cache = AccountCache(self.chain, capacity=2, clock=lambda: self.now[0])
        cache.fresh(ACCOUNT)
        cache.entries = Entries(cache.entries)
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(cache.fresh, OTHER)
            self.assertTrue(inside.wait(5))
            second = pool.submit(cache.fresh, THIRD)
            first.result(timeout=5), second.result(timeout=5)
        self.assertEqual(list(cache.entries), [OTHER, THIRD])


class Store:
    """begin_preview's projection and finish_preview's recheck, as SessionStore answers them."""
    def __init__(self, delegate=None, *, names_delegate=True):
        self.projection = {'address': ACCOUNT, 'chainId': 4663}
        if names_delegate:
            self.projection['delegate'] = delegate
        self.finished, self.revoked = [], 0

    def begin_preview(self, client, session, csrf, *, budget, origin=None):
        return dict(self.projection)

    def finish_preview(self, session, csrf, owner, validation, origin=None):
        self.finished.append(validation)

    def revoke(self, session):
        self.revoked += 1


class ReadOnlyRouteTests(unittest.TestCase):
    def setUp(self):
        self.chain = Chain()
        self.store = Store()
        self.auth = OnboardingAuth(self.store, self.chain)

    def begin(self, family=None, route=None):
        if family is None:
            return self.auth.begin('192.0.2.1', SESSION, CSRF)
        with serving(family, route):
            return self.auth.begin('192.0.2.1', SESSION, CSRF)

    def test_the_read_only_routes_are_the_owners_own_reads_and_public_listings(self):
        self.assertEqual(READ_ONLY_ROUTES, {('execution', 'status'), ('execution', 'list'),
                                            ('execution', 'availability'), ('performance', 'cards'),
                                            ('performance', 'epochs'), ('crosschain', 'origins'),
                                            ('crosschain', 'status')})
        self.assertLessEqual(READ_ONLY_ROUTES, served_routes())
        # Each one also spends a budget of its own kind, never a plan's or a quote's (3 Nov 2026).
        self.assertTrue(all(BUDGETS[route] in ('execution-performance', 'crosschain-quote', 'crosschain-status')
                            for route in READ_ONLY_ROUTES))

    def test_a_read_only_route_takes_the_entry_for_the_admitted_delegate(self):
        for family, route in sorted(READ_ONLY_ROUTES):
            with self.subTest(family=family, route=route):
                self.setUp()
                first = self.begin(family, route)
                again = self.begin(family, route)
                self.assertEqual(self.chain.calls, [ACCOUNT])
                self.assertEqual(again['validation'], first['validation'])
                self.assertEqual(self.store.finished, [first['validation']] * 2)

    def test_the_cache_never_serves_a_write_or_a_money_path(self):
        others = sorted(served_routes() - READ_ONLY_ROUTES)
        # A plan, a quote, an enrollment, every deposit and onboarding route.
        for route in (('position-plan', 'plan'), ('crosschain', 'quote'), ('performance', 'enroll'),
                      ('deposit', 'create'), ('deposit', 'prepare'), ('deposit', 'get'), ('deposit', 'allowances'),
                      ('onboarding', 'swap-route'), ('onboarding', 'position-preview')):
            self.assertIn(route, others)
        self.begin('execution', 'status')
        for family, route in [*others, (None, None), ('unknown-family', 'status')]:
            with self.subTest(family=family, route=route):
                before = len(self.chain.calls)
                self.begin(family, route)
                self.assertEqual(len(self.chain.calls), before + 1)

    def test_a_store_that_does_not_name_the_admitted_delegate_reads_fresh(self):
        self.store = Store(names_delegate=False)
        self.auth = OnboardingAuth(self.store, self.chain)
        for _ in range(3):
            self.begin('execution', 'status')
        self.assertEqual(self.chain.calls, [ACCOUNT] * 3)

    def test_a_writes_fresh_answer_renews_the_entry_for_the_next_read(self):
        now = [0.0]
        self.auth = OnboardingAuth(self.store, self.chain, accounts=AccountCache(self.chain, clock=lambda: now[0]))
        self.begin('execution', 'status')
        now[0] = 50
        self.begin('position-plan', 'plan')
        # Past the first answer's minute, inside the plan's: the plan's answer serves the read.
        now[0] = 100
        self.begin('execution', 'status')
        self.assertEqual(len(self.chain.calls), 2)

    def test_only_a_fresh_unsupported_answer_revokes(self):
        self.begin('execution', 'status')
        self.chain.failure = 'account_unsupported'
        # Inside its minute the entry answers the read for the session it confirms; a write reads and revokes.
        self.begin('execution', 'status')
        with self.assertRaisesRegex(SessionError, '^account_unsupported$'):
            self.begin('position-plan', 'plan')
        self.assertEqual(self.store.revoked, 1)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'set DOMINO_TEST_POSTGRES=1 after prepare-tests')
class AccountCachePostgresTests(unittest.TestCase):
    """The real session store and sign-in, one listener's cache, and the session listener beside it."""
    # Sign-in as the session listener does it (bootstrap, challenge, a synthetic key's SIWE signature, verify).
    login = test_onboarding_auth.OnboardingAuthPostgresTests.login

    def setUp(self):
        self.settings = {'host': str(SOCKET), 'port': PORT, 'dbname': 'domino_catalogue_tests'}
        self.admin = psycopg.connect(**self.settings, user=ADMIN, autocommit=True, row_factory=dict_row)
        self.addCleanup(self.admin.close)
        self.admin.execute('TRUNCATE domino_sessions.contexts,domino_sessions.challenges,domino_sessions.sessions,'
                           'domino_sessions.rate_limits,domino_sessions.private_limits')
        self.store = SessionStore(self.settings, abuse_secret=SECRET)
        self.chain, self.now = Chain(), [0.0]
        # The session listener (verify, refresh) reads the chain itself; the status listener keeps its cache.
        self.service = SessionService(self.store, SiwePolicy('https://domino.money'), self.chain)
        self.auth = OnboardingAuth(self.store, self.chain,
                                   accounts=AccountCache(self.chain, clock=lambda: self.now[0]))

    def status(self, credentials):
        with serving('execution', 'status'):
            return self.auth.begin(**credentials)

    def revoked(self, credentials):
        return self.admin.execute('SELECT revoked_at FROM domino_sessions.sessions WHERE bearer_hash=%s',
                                  (digest(credentials['session']),)).fetchone()['revoked_at'] is not None

    def refresh(self, credentials):
        return self.service.execute('refresh', {}, client=credentials['client'], session=credentials['session'],
                                    csrf=credentials['csrf'])

    def test_a_wallet_upgraded_to_7702_mid_session_signs_in_once_and_stays_signed_in(self):
        first, owner = self.login()
        self.assertEqual(self.store.begin_preview(**first)['delegate'], None)
        self.status(first)
        # The wallet becomes an EIP-7702 account. Inside its minute the entry still answers the plain session.
        self.chain.delegate = DELEGATE
        self.status(first)
        reads = len(self.chain.calls)
        # The browser's refresh reads the chain, sees the delegate and revokes: the wallet signs in once more.
        with self.assertRaisesRegex(SessionError, '^session_required$'):
            self.refresh(first)
        self.assertEqual(len(self.chain.calls), reads + 1)
        second, same = self.login()
        self.assertEqual((same, self.store.begin_preview(**second)['delegate']), (owner, DELEGATE))
        # The entry from before the upgrade still has seconds left, but names no delegate: the status poll reads
        # the chain instead of revoking the new session with it, and from then on the entry answers.
        reads = len(self.chain.calls)
        for _ in range(4):
            self.assertEqual(self.status(second)['validation']['delegate'], DELEGATE)
        self.assertEqual(len(self.chain.calls), reads + 1)
        self.assertFalse(self.revoked(second))
        self.assertEqual(self.refresh(second)['result']['validation']['delegate'], DELEGATE)

    def test_a_changed_delegate_is_revoked_by_the_next_fresh_read(self):
        for revoker in ('write', 'expiry'):
            with self.subTest(revoker=revoker):
                self.setUp()
                self.chain.delegate = DELEGATE
                credentials, owner = self.login()
                self.status(credentials)
                self.chain.delegate = NEXT_DELEGATE
                if revoker == 'write':
                    with serving('position-plan', 'plan'), self.assertRaisesRegex(SessionError, '^session_required$'):
                        self.auth.begin(**credentials)
                else:
                    self.now[0] = ACCOUNT_CACHE_SECONDS
                    with self.assertRaisesRegex(SessionError, '^session_required$'):
                        self.status(credentials)
                self.assertTrue(self.revoked(credentials))
                with self.assertRaisesRegex(SessionError, '^session_required$'):
                    self.status(credentials)

    def test_writes_verify_and_refresh_read_the_chain_while_an_entry_is_young(self):
        credentials, owner = self.login()
        self.status(credentials)
        reads = len(self.chain.calls)
        for family, route in (('position-plan', 'plan'), ('crosschain', 'quote'), ('performance', 'enroll')):
            with serving(family, route):
                self.auth.begin(**credentials)
        self.refresh(credentials)
        self.assertEqual(len(self.chain.calls), reads + 4)
        # A second sign-in for the same wallet verifies against the chain too.
        self.service.execute('logout', {}, client=credentials['client'], session=credentials['session'],
                             csrf=credentials['csrf'])
        reads = len(self.chain.calls)
        self.login()
        self.assertEqual(len(self.chain.calls), reads + 1)

    def test_the_entry_expires_after_its_seconds(self):
        credentials, owner = self.login()
        self.status(credentials)
        reads = len(self.chain.calls)
        self.now[0] = ACCOUNT_CACHE_SECONDS - 1
        self.status(credentials)
        self.assertEqual(len(self.chain.calls), reads)
        self.now[0] = ACCOUNT_CACHE_SECONDS
        self.status(credentials)
        self.assertEqual(len(self.chain.calls), reads + 1)
        # The session's stored snapshot is the answer each call used.
        row = self.admin.execute('SELECT block_number FROM domino_sessions.sessions WHERE bearer_hash=%s',
                                 (digest(credentials['session']),)).fetchone()
        self.assertEqual(row['block_number'], str(self.chain.block))


if __name__ == '__main__':
    unittest.main()
