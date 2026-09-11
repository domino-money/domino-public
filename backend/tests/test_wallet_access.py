"""Operator admission and auth races on disposable PostgreSQL; no live RPC."""
from concurrent.futures import ThreadPoolExecutor
from datetime import timedelta
import os
from pathlib import Path
import sys
import time
from threading import Barrier, Event
import unittest
from unittest.mock import patch

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from eth_account import Account
from eth_account.messages import encode_defunct

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dev_postgres import ADMIN, PORT, SOCKET
from session_models import CHAIN_ID, SessionError, token, validate_account
from session_service import SessionService
from session_siwe import SiwePolicy
from session_store import SessionStore, _CommitResult, digest, same_hash, LOCK_ID
from wallet_access import WalletAccessAdmin, WalletAccessError, canonical_wallet
from test_session_store import Checker, SECRET, VALIDATION

OPERATOR = 'domino_wallet_access_operator'
AUTH = 'domino_session_auth'
PUBLIC_ROLES = ('domino_catalogue_reader', 'domino_catalogue_writer')
TEST_ADDRESS = Account.from_key(bytes([9]) * 32).address


class DescendantPreviewStore(SessionStore):
    """Frozen preview methods from onboarding commit 5a1baa6741ad987b702da8697363bf18ed356bac.

    Only constants are inlined. This tests inheritance of current _session
    authorization without importing another checkout or requiring a remote ref.
    """
    def begin_preview(self, client, session, csrf):
        def operation(conn, now):
            denied = self._rate(conn, now, 'onboarding-ip', client, 20, 60)
            if denied:
                return denied
            try:
                token(session, required='session_required')
                token(csrf, required='csrf_invalid')
            except SessionError as error:
                return error
            row = self._session(conn, session)
            if not self._active(row, now) or row['chain_id'] != CHAIN_ID:
                return SessionError('session_required')
            if not same_hash(row['csrf_hash'], csrf):
                return SessionError('csrf_invalid')
            for kind, value, maximum in (
                    ('onboarding-account', row['address'], 10), ('onboarding-global', 'all', 60)):
                denied = self._rate(conn, now, kind, value, maximum, 60)
                if denied:
                    return denied
            fresh = conn.execute('SELECT clock_timestamp() AS now').fetchone()['now']
            if not self._active(row, fresh):
                return SessionError('session_required')
            return {'address': row['address'], 'chainId': CHAIN_ID}
        return self._transaction(operation)

    def finish_preview(self, session, csrf, owner, validation):
        token(session, required='session_required')
        token(csrf, required='csrf_invalid')
        validation = validate_account(validation)
        def operation(conn, now):
            row = self._session(conn, session)
            if (not self._active(row, now) or row['chain_id'] != CHAIN_ID or row['address'] != owner):
                return SessionError('session_required')
            if not same_hash(row['csrf_hash'], csrf):
                return SessionError('csrf_invalid')
            conn.execute('UPDATE sessions SET last_used_at=%s,block_number=%s,block_hash=%s WHERE bearer_hash=%s',
                         (now, validation['blockNumber'], validation['blockHash'], digest(session)))
            return _CommitResult(None, min(row['expires_at'], row['last_used_at'] + timedelta(minutes=30)),
                                 'session_required')
        return self._transaction(operation)


class WalletAccessInputTests(unittest.TestCase):
    def test_address_canonicalization_and_fixed_chain_are_explicit(self):
        for value in (TEST_ADDRESS, TEST_ADDRESS.lower()):
            self.assertEqual(canonical_wallet(value), TEST_ADDRESS.lower())
        for value in (None, False, 1, '', '0x' + '0' * 40, TEST_ADDRESS + ' ',
                      '\n' + TEST_ADDRESS, '0X' + TEST_ADDRESS[2:], '0x' + TEST_ADDRESS[2:].upper(),
                      'alice.eth', '0x' + 'g' * 40,
                      '0x' + 'a' * 39, TEST_ADDRESS + "'; DROP TABLE grants;--"):
            with self.subTest(value=value), self.assertRaises(WalletAccessError) as caught:
                canonical_wallet(value)
            self.assertEqual(caught.exception.code, 'wallet_access_invalid_request')
        for chain in (1, 4664, 0, -1, True, 4663.0, '4663', None):
            with self.subTest(chain=chain), self.assertRaises(WalletAccessError) as caught:
                canonical_wallet(TEST_ADDRESS, chain_id=chain)
            self.assertEqual(caught.exception.code, 'wallet_access_invalid_request')


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires disposable PostgreSQL after prepare-tests')
class WalletAccessPostgresTests(unittest.TestCase):
    def setUp(self):
        self.settings = {'host': str(SOCKET), 'port': PORT, 'dbname': 'domino_catalogue_tests'}
        self.admin = psycopg.connect(**self.settings, user=ADMIN, autocommit=True, row_factory=dict_row)
        self.addCleanup(self.admin.close)
        self.admin.execute('TRUNCATE domino_sessions.contexts,domino_sessions.challenges,domino_sessions.sessions,'
                           'domino_sessions.rate_limits,domino_sessions.private_limits')
        self.admin.execute('TRUNCATE domino_wallet_access.grants,domino_wallet_access.audit RESTART IDENTITY')
        self.operator = WalletAccessAdmin(self.settings)
        self.account = Account.from_key(bytes([9]) * 32)
        self.checker = Checker()
        self.store = SessionStore(self.settings, abuse_secret=SECRET)
        self.service = SessionService(self.store, SiwePolicy('https://domino.money'), self.checker)
        self.peer = SessionService(SessionStore(self.settings, abuse_secret=SECRET), self.service.siwe, self.checker)
        self.client_counter = 0

    def call(self, route, body=None, *, service=None, **credentials):
        return (service or self.service).execute(route, body or {}, client=credentials.pop('client', '192.0.2.1'), **credentials)

    def pending(self):
        self.client_counter += 1
        client = f'198.51.100.{self.client_counter}'
        initial = self.call('bootstrap', client=client)
        credentials = {'client': client, 'preauth': initial['credentials']['preauth'], 'csrf': initial['result']['csrfToken']}
        challenge = self.call('challenge', {'address': self.account.address, 'chainId': CHAIN_ID}, **credentials)['result']
        signature = '0x' + Account.sign_message(encode_defunct(text=challenge['message']), self.account.key).signature.hex()
        return credentials, {'challengeId': challenge['challengeId'], 'message': challenge['message'], 'signature': signature}

    def login(self):
        preauth, body = self.pending()
        result = self.call('verify', body, **preauth)
        credentials = {'client': preauth['client'], 'session': result['credentials']['session'], 'csrf': result['result']['csrfToken']}
        return preauth, body, credentials, result

    def denied(self, code, action, exception=SessionError):
        with self.assertRaises(exception) as caught:
            action()
        self.assertEqual(caught.exception.code, code)
        self.assertEqual(str(caught.exception), code)
        if code == 'wallet_not_allowed':
            self.assertEqual(caught.exception.status, 403)

    def rows(self, table):
        return self.admin.execute(sql.SQL('SELECT * FROM {} ORDER BY 1').format(sql.Identifier(*table.split('.')))).fetchall()

    def session_row(self, credentials):
        return self.admin.execute('SELECT * FROM domino_sessions.sessions WHERE bearer_hash=%s',
                                  (digest(credentials['session']),)).fetchone()

    def test_default_deny_follows_valid_proof_but_precedes_eoa_public_reads_unchanged(self):
        with patch.object(self.service.siwe, 'issue', wraps=self.service.siwe.issue) as issue:
            credentials,body=self.pending()
            issue.assert_called_once()
        with patch.object(self.service.siwe,'verify',wraps=self.service.siwe.verify) as verify:
            self.denied('wallet_not_allowed',lambda:self.call('verify',body,**credentials))
            verify.assert_called_once()
        self.assertEqual(self.checker.calls, [])
        self.assertIsNone(self.rows('domino_sessions.challenges')[0]['admission_generation'])
        self.assertEqual(self.rows('domino_sessions.sessions'), [])
        for role in PUBLIC_ROLES:
            with psycopg.connect(**self.settings, user=role, autocommit=True) as conn:
                self.assertEqual(conn.execute('SELECT schema_version FROM domino_catalogue.state').fetchone()[0], 1)

    def test_operator_grant_revoke_are_canonical_idempotent_audited_and_durable(self):
        granted = self.operator.grant(self.account.address)
        self.assertEqual({k:v for k,v in granted.items() if k!='updatedAt'}, {'chainId': CHAIN_ID, 'address': self.account.address.lower(),
            'allowed': True, 'generation': 1, 'changed': True})
        self.assertRegex(granted['updatedAt'], r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$')
        again = WalletAccessAdmin(self.settings).grant(self.account.address.lower())
        self.assertEqual(again, {**granted, 'changed': False})
        revoked = self.operator.revoke(self.account.address)
        self.assertEqual(revoked['generation'], 2); self.assertFalse(revoked['allowed']); self.assertTrue(revoked['changed'])
        self.assertEqual(self.operator.revoke(self.account.address), {**revoked, 'changed': False})
        renewed = self.operator.grant(self.account.address)
        self.assertEqual(renewed['generation'], 3); self.assertTrue(renewed['allowed'])
        audit = self.rows('domino_wallet_access.audit')
        self.assertEqual([row['action'] for row in audit], ['grant', 'revoke', 'grant'])
        self.assertEqual([row['generation'] for row in audit], [1, 2, 3])
        self.assertEqual({row['actor'] for row in audit}, {OPERATOR})
        self.assertEqual({row['chain_id'] for row in audit}, {CHAIN_ID})
        self.assertEqual({row['address'] for row in audit}, {self.account.address.lower()})
        listing = WalletAccessAdmin(self.settings).list()
        self.assertEqual(len(listing['wallets']), 1)
        self.assertEqual(listing['wallets'][0]['generation'], 3)
        self.assertFalse(listing['hasMore']); self.assertIsNone(listing['nextAfter'])

    def test_invalid_operator_inputs_or_chains_cannot_mutate_or_audit(self):
        for method in (self.operator.grant, self.operator.revoke):
            for address in (None, 'alice.eth', self.account.address + ' ', '0x' + '0' * 40):
                self.denied('wallet_access_invalid_request', lambda: method(address), WalletAccessError)
            for chain in (1, 4663.0, True, '4663'):
                self.denied('wallet_access_invalid_request', lambda: method(self.account.address, chain_id=chain), WalletAccessError)
        self.denied('wallet_access_not_found', lambda: self.operator.revoke(self.account.address), WalletAccessError)
        self.assertEqual(self.rows('domino_wallet_access.grants'), []); self.assertEqual(self.rows('domino_wallet_access.audit'), [])

    def test_revoke_and_readd_never_revive_session_or_unconsumed_challenge(self):
        self.operator.grant(self.account.address)
        preauth, body, credentials, result = self.login()
        pending, pending_body = self.pending()
        self.operator.revoke(self.account.address)
        self.denied('session_required', lambda: self.call('me', session=credentials['session']))
        self.operator.grant(self.account.address)
        self.denied('session_required', lambda: self.call('me', service=self.peer, session=credentials['session']))
        self.denied('wallet_not_allowed', lambda: self.call('verify', pending_body, **pending))
        self.denied('session_required', lambda: self.call('refresh', **credentials))
        self.assertEqual(len(self.checker.calls), 1)
        _, _, new_credentials, _ = self.login()
        self.assertNotEqual(new_credentials['session'], credentials['session'])
        self.call('me', session=new_credentials['session'])
        self.assertEqual(self.session_row(new_credentials)['admission_generation'], 3)

    def test_removal_during_valid_siwe_verification_prevents_session_issuance(self):
        self.operator.grant(self.account.address); preauth, body = self.pending()
        original = self.service.siwe.verify
        def remove(*args, **kwargs):
            original(*args, **kwargs)
            self.operator.revoke(self.account.address)
        with patch.object(self.service.siwe, 'verify', side_effect=remove):
            self.denied('wallet_not_allowed', lambda: self.call('verify', body, **preauth))
        self.assertEqual(self.rows('domino_sessions.sessions'), [])

    def test_removal_during_eoa_check_prevents_late_issuance_and_regrant_does_not_help(self):
        self.operator.grant(self.account.address); preauth, body = self.pending()
        entered, released = Event(), Event()
        def wait(_):
            entered.set()
            if not released.wait(3): raise AssertionError('test verifier not released')
            return dict(VALIDATION)
        self.checker.effect = wait
        with ThreadPoolExecutor(1) as pool:
            future = pool.submit(self.call, 'verify', body, **preauth)
            try:
                self.assertTrue(entered.wait(2))
                self.operator.revoke(self.account.address); self.operator.grant(self.account.address)
            finally:
                released.set()
            self.denied('wallet_not_allowed', future.result)
        self.assertEqual(self.rows('domino_sessions.sessions'), [])
        challenge = self.rows('domino_sessions.challenges')[0]
        self.assertEqual(challenge['attempts'], 1); self.assertIsNone(challenge['consumed_at'])

    def test_removal_during_private_check_cannot_touch_or_refresh_session(self):
        self.operator.grant(self.account.address); _, _, credentials, _ = self.login()
        before = self.session_row(credentials)
        def remove(_):
            self.operator.revoke(self.account.address)
            self.operator.grant(self.account.address)
            return {**VALIDATION, 'blockNumber': '999'}
        self.checker.effect = remove
        self.denied('session_required', lambda: self.call('refresh', **credentials))
        after = self.session_row(credentials)
        self.assertEqual(after['last_used_at'], before['last_used_at'])
        self.assertEqual(after['block_number'], before['block_number'])
        self.assertEqual(after['expires_at'], before['expires_at'])

    def test_me_membership_check_remains_read_only_and_logout_works_after_removal(self):
        self.operator.grant(self.account.address); _, _, credentials, _ = self.login()
        tables = ('contexts', 'challenges', 'sessions', 'rate_limits', 'private_limits')
        before = {name: self.rows('domino_sessions.' + name) for name in tables}
        calls = len(self.checker.calls)
        self.call('me', session=credentials['session'])
        self.assertEqual({name: self.rows('domino_sessions.' + name) for name in tables}, before)
        self.operator.revoke(self.account.address)
        self.denied('session_required', lambda: self.call('me', session=credentials['session']))
        self.assertEqual({name: self.rows('domino_sessions.' + name) for name in tables}, before)
        self.assertEqual(len(self.checker.calls), calls)
        result = self.call('logout', **credentials)
        self.assertEqual(result['result'], {'authenticated': False})
        self.assertEqual(result['credentials'], {'session': None, 'preauth': None})
        self.assertEqual(len(self.checker.calls), calls)

    def test_revoke_and_verify_finalization_are_serialized_and_never_leave_access_active(self):
        self.operator.grant(self.account.address); preauth, body = self.pending()
        reserved = self.store.reserve_verify(preauth['client'], preauth['preauth'], preauth['csrf'], body['challengeId'], body['message'])
        barrier = Barrier(2)
        def finish():
            barrier.wait(timeout=3)
            try: return self.store.finish_verify(preauth['preauth'], preauth['csrf'], reserved, VALIDATION)
            except SessionError as error: return error.code
        def remove():
            barrier.wait(timeout=3)
            return self.operator.revoke(self.account.address)
        with ThreadPoolExecutor(2) as pool:
            finished, revoked = pool.submit(finish), pool.submit(remove)
            outcome, change = finished.result(timeout=5), revoked.result(timeout=5)
        self.assertFalse(change['allowed'])
        if isinstance(outcome, dict):
            self.denied('session_required', lambda: self.call('me', session=outcome['credentials']['session']))
        else:
            self.assertEqual(outcome, 'wallet_not_allowed')
            self.assertEqual(self.rows('domino_sessions.sessions'), [])

    def test_descendant_preview_guards_inherit_membership_and_generation_checks(self):
        self.operator.grant(self.account.address); _, _, credentials, _ = self.login()
        preview = DescendantPreviewStore(self.settings, abuse_secret=SECRET)
        owner = preview.begin_preview(credentials['client'], credentials['session'], credentials['csrf'])
        self.assertEqual(owner, {'address': self.account.address.lower(), 'chainId': CHAIN_ID})
        before = self.session_row(credentials)
        self.operator.revoke(self.account.address); self.operator.grant(self.account.address)
        self.denied('session_required', lambda: preview.begin_preview(credentials['client'], credentials['session'], credentials['csrf']))
        self.denied('session_required', lambda: preview.finish_preview(credentials['session'], credentials['csrf'], owner['address'], VALIDATION))
        self.assertEqual(self.session_row(credentials)['last_used_at'], before['last_used_at'])

    def test_revocation_preserves_auth_nonce_and_public_catalogue_evidence(self):
        # This baseline has auth nonces and catalogue archives, not the later
        # deposit issuance ledger; combined-stack verification remains separate.
        self.operator.grant(self.account.address); preauth, body, credentials, _ = self.login()
        self.pending()
        start = 9000000000123
        self.admin.execute('INSERT INTO domino_catalogue.chunks(start_block,end_block,end_hash) VALUES (%s,%s,%s)',
                           (start, start + 10, '0x' + 'fa' * 32))
        self.addCleanup(lambda: self.admin.execute('DELETE FROM domino_catalogue.chunks WHERE start_block=%s', (start,)))
        evidence = self.rows('domino_sessions.challenges')
        sessions = self.rows('domino_sessions.sessions')
        archive = self.admin.execute('SELECT * FROM domino_catalogue.chunks WHERE start_block=%s', (start,)).fetchone()
        self.operator.revoke(self.account.address); self.operator.grant(self.account.address)
        self.assertEqual(self.rows('domino_sessions.challenges'), evidence)
        self.assertEqual(self.rows('domino_sessions.sessions'), sessions)
        self.assertEqual(self.admin.execute('SELECT * FROM domino_catalogue.chunks WHERE start_block=%s', (start,)).fetchone(), archive)
        self.assertTrue(all(row['nonce'] for row in evidence))

    def test_old_null_generation_is_never_backfilled_from_a_later_grant(self):
        self.operator.grant(self.account.address); _, _, credentials, _ = self.login()
        preauth, body = self.pending()
        self.admin.execute('UPDATE domino_sessions.sessions SET admission_generation=NULL')
        self.admin.execute('UPDATE domino_sessions.challenges SET admission_generation=NULL')
        self.denied('session_required', lambda:self.call('me',session=credentials['session']))
        calls=len(self.checker.calls)
        with patch.object(self.service.siwe,'verify',wraps=self.service.siwe.verify) as verify:
            self.denied('wallet_not_allowed', lambda:self.call('verify',body,**preauth))
            verify.assert_called_once()
        self.assertEqual(len(self.checker.calls),calls)
        self.assertIsNone(self.session_row(credentials)['admission_generation'])
        self.assertTrue(all(row['admission_generation'] is None for row in self.rows('domino_sessions.challenges')))

    def test_uniform_challenges_and_invalid_signatures_do_not_reveal_membership(self):
        for admitted in (False,True):
            if admitted:self.operator.grant(self.account.address)
            preauth,body=self.pending()
            wrong=Account.from_key(bytes([10])*32)
            bad={**body,'signature':'0x'+Account.sign_message(encode_defunct(text=body['message']),wrong.key).signature.hex()}
            with patch.object(self.store,'check_verified_admission',wraps=self.store.check_verified_admission) as access:
                self.denied('invalid_signature',lambda:self.call('verify',bad,**preauth))
                access.assert_not_called()
            self.assertEqual(self.checker.calls,[])
        self.assertEqual(len(self.rows('domino_sessions.challenges')),2)
        self.assertEqual(sorted(row['admission_generation'] is None for row in self.rows('domino_sessions.challenges')),[False,True])

    def test_admission_storage_failure_after_proof_denies_before_eoa_rpc(self):
        self.operator.grant(self.account.address);preauth,body=self.pending()
        original=self.service.siwe.verify
        def lose_access(*args,**kwargs):
            original(*args,**kwargs)
            self.admin.execute('REVOKE SELECT ON domino_wallet_access.grants FROM domino_session_auth')
        try:
            with patch.object(self.service.siwe,'verify',side_effect=lose_access) as verify:
                self.denied('session_store_unavailable',lambda:self.call('verify',body,**preauth))
                verify.assert_called_once()
            self.assertEqual(self.checker.calls,[])
            self.assertEqual(self.rows('domino_sessions.sessions'),[])
        finally:self.admin.execute('GRANT SELECT ON domino_wallet_access.grants TO domino_session_auth')

    def test_finalization_cannot_substitute_the_proven_address_during_eoa_work(self):
        self.operator.grant(self.account.address);preauth,body=self.pending()
        other=Account.from_key(bytes([10])*32).address.lower()
        self.operator.grant(other)
        def substitute(_):
            self.admin.execute('UPDATE domino_sessions.challenges SET address=%s WHERE id=%s',(other,body['challengeId']))
            return dict(VALIDATION)
        self.checker.effect=substitute
        self.denied('challenge_invalid',lambda:self.call('verify',body,**preauth))
        self.assertEqual(self.rows('domino_sessions.sessions'),[])

    def test_revoked_or_null_challenge_reserves_without_membership_oracle(self):
        for state in ('unadmitted','revoked','readded'):
            if state=='revoked':self.operator.grant(self.account.address)
            preauth,body=self.pending()
            if state=='revoked':self.operator.revoke(self.account.address)
            if state=='readded':self.operator.grant(self.account.address)
            reserved=self.store.reserve_verify(preauth['client'],preauth['preauth'],preauth['csrf'],body['challengeId'],body['message'])
            self.assertEqual(reserved['address'],self.account.address.lower())
            with patch.object(self.service.siwe,'verify',wraps=self.service.siwe.verify) as verify:
                self.denied('wallet_not_allowed',lambda:self.call('verify',body,**preauth))
                verify.assert_called_once()
            self.assertEqual(self.checker.calls,[])

    def test_unsigned_targeting_cannot_spend_proven_wallet_quota(self):
        self.operator.grant(self.account.address)
        for _ in range(21):self.pending()
        key=self.store._key('verified-address',self.account.address.lower())
        self.assertIsNone(self.admin.execute('SELECT * FROM domino_sessions.rate_limits WHERE key_hash=%s',(key,)).fetchone())
        _,_,credentials,_=self.login()
        self.assertEqual(self.admin.execute('SELECT count FROM domino_sessions.rate_limits WHERE key_hash=%s',(key,)).fetchone()['count'],1)
        self.call('me',session=credentials['session'])

    def test_proven_wallet_budget_is_durable_and_precedes_rpc(self):
        self.operator.grant(self.account.address)
        self.checker.effect=lambda _:(_ for _ in ()).throw(SessionError('account_check_unavailable'))
        for _ in range(20):
            preauth,body=self.pending()
            self.denied('account_check_unavailable',lambda:self.call('verify',body,**preauth))
        preauth,body=self.pending()
        self.denied('session_rate_limited',lambda:self.call('verify',body,service=self.peer,**preauth))
        self.assertEqual(len(self.checker.calls),20)

    def test_shared_global_limits_remain_bounded_before_proof(self):
        with patch('session_store.ISSUANCE_GLOBAL_PER_MINUTE',2):
            self.pending()
            self.denied('session_rate_limited',lambda:self.call('bootstrap',client='192.0.2.123'))
        preauth,body=self.pending()
        with patch('session_store.VERIFY_GLOBAL_PER_MINUTE',1):
            bad={**body,'message':body['message']+'x'}
            self.denied('challenge_invalid',lambda:self.call('verify',bad,**preauth))
            other={**preauth,'client':'192.0.2.124'}
            self.denied('session_rate_limited',lambda:self.call('verify',bad,**other))
        self.assertEqual(self.checker.calls,[])

    def test_operator_sql_itself_waits_for_session_advisory_lock(self):
        self.operator.grant(self.account.address)
        blocker=psycopg.connect(**self.settings,user=AUTH)
        started=Event();pid=[]
        def direct_revoke():
            with psycopg.connect(**self.settings,user=OPERATOR,options='-c statement_timeout=5000 -c lock_timeout=3000') as conn:
                pid.append(conn.info.backend_pid);started.set()
                return conn.execute('SELECT * FROM domino_wallet_access.set_access(%s,false)',(self.account.address.lower(),)).fetchone()
        try:
            blocker.execute('SELECT pg_advisory_xact_lock(%s)',(LOCK_ID,))
            with ThreadPoolExecutor(1) as pool:
                future=pool.submit(direct_revoke)
                try:
                    self.assertTrue(started.wait(2))
                    blocked=False
                    for _ in range(100):
                        state=self.admin.execute('SELECT wait_event FROM pg_stat_activity WHERE pid=%s',(pid[0],)).fetchone()
                        if state and state['wait_event']=='advisory':blocked=True;break
                        if future.done():break
                        time.sleep(.005)
                    self.assertTrue(blocked,'SQL transition did not wait on the session lock')
                    self.assertTrue(self.rows('domino_wallet_access.grants')[0]['allowed'])
                finally:blocker.rollback()
                self.assertFalse(future.result(timeout=3)[2])
        finally:blocker.close()

    def test_database_trigger_blocks_legacy_null_and_wrong_generation_insert(self):
        self.operator.grant(self.account.address);_,_,credentials,_=self.login()
        row=self.session_row(credentials)
        columns=('bearer_hash','csrf_hash','source_context_hash','address','chain_id','policy',
                 'created_at','last_used_at','expires_at','block_number','block_hash')
        values=[row[name] for name in columns]
        values[0]=digest('synthetic-new-bearer');values[2]=digest('synthetic-new-context')
        with psycopg.connect(**self.settings,user=AUTH,autocommit=True) as conn:
            for generation in (None,row['admission_generation']+1):
                names=columns if generation is None else (*columns,'admission_generation')
                parameters=values if generation is None else [*values,generation]
                statement=sql.SQL('INSERT INTO domino_sessions.sessions ({}) VALUES ({})').format(
                    sql.SQL(',').join(map(sql.Identifier,names)),sql.SQL(',').join(sql.Placeholder()*len(names)))
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):conn.execute(statement,parameters)
        self.assertEqual(len(self.rows('domino_sessions.sessions')),1)

    def test_insert_trigger_itself_waits_for_operator_advisory_lock(self):
        self.operator.grant(self.account.address);_,_,credentials,_=self.login()
        blocker=psycopg.connect(**self.settings,user=OPERATOR)
        started=Event();pid=[]
        def direct_insert():
            with psycopg.connect(**self.settings,user=AUTH,options='-c statement_timeout=5000 -c lock_timeout=3000') as conn:
                pid.append(conn.info.backend_pid);started.set()
                conn.execute('INSERT INTO domino_sessions.sessions (bearer_hash,csrf_hash,source_context_hash,address,chain_id,policy,'
                    'created_at,last_used_at,expires_at,block_number,block_hash,admission_generation) '
                    'SELECT %s,csrf_hash,%s,address,chain_id,policy,created_at,last_used_at,expires_at,block_number,block_hash,admission_generation '
                    'FROM domino_sessions.sessions WHERE bearer_hash=%s',
                    (digest('synthetic-trigger-bearer'),digest('synthetic-trigger-context'),digest(credentials['session'])))
        try:
            blocker.execute('SELECT pg_advisory_xact_lock(%s)',(LOCK_ID,))
            with ThreadPoolExecutor(1) as pool:
                future=pool.submit(direct_insert)
                try:
                    self.assertTrue(started.wait(2));blocked=False
                    for _ in range(100):
                        state=self.admin.execute('SELECT wait_event FROM pg_stat_activity WHERE pid=%s',(pid[0],)).fetchone()
                        if state and state['wait_event']=='advisory':blocked=True;break
                        if future.done():break
                        time.sleep(.005)
                    self.assertTrue(blocked,'INSERT trigger did not wait on the operator lock')
                    self.assertEqual(len(self.rows('domino_sessions.sessions')),1)
                finally:blocker.rollback()
                future.result(timeout=3)
            self.assertEqual(len(self.rows('domino_sessions.sessions')),2)
        finally:blocker.close()

    def test_operator_auth_and_public_roles_cannot_cross_privilege_boundaries(self):
        self.operator.grant(self.account.address)
        for role in (*PUBLIC_ROLES, AUTH, OPERATOR):
            with psycopg.connect(**self.settings,user=role,autocommit=True) as conn:
                denied = ['UPDATE domino_wallet_access.grants SET allowed=false',
                          'DELETE FROM domino_wallet_access.audit', 'TRUNCATE domino_wallet_access.grants',
                          "INSERT INTO domino_wallet_access.grants VALUES (4663,'"+self.account.address.lower()+"',1,true,now(),now())"]
                if role != OPERATOR:
                    denied += ["SELECT * FROM domino_wallet_access.set_access('"+self.account.address.lower()+"',false)",
                               'SELECT * FROM domino_wallet_access.audit', 'SET ROLE domino_wallet_access_operator']
                if role in PUBLIC_ROLES:
                    denied += ['SELECT * FROM domino_wallet_access.grants']
                if role == OPERATOR:
                    denied += ['SELECT * FROM domino_sessions.sessions', 'SELECT * FROM domino_sessions.contexts',
                               'SELECT * FROM domino_sessions.challenges', 'SET ROLE domino_session_auth',
                               'SELECT * FROM domino_catalogue.events']
                for statement in denied:
                    with self.subTest(role=role,statement=statement),self.assertRaises(psycopg.errors.InsufficientPrivilege):
                        conn.execute(statement)
                if role in (AUTH,OPERATOR):
                    self.assertEqual(conn.execute('SELECT count(*) FROM domino_wallet_access.grants').fetchone()[0],1)
        self.assertTrue(self.rows('domino_wallet_access.grants')[0]['allowed'])
        self.assertEqual(len(self.rows('domino_wallet_access.audit')),1)

    def test_security_definer_works_with_non_superuser_migration_owner(self):
        owner_role = 'domino_wallet_access_test_owner'
        owner_id = sql.Identifier(owner_role)
        self.admin.execute(sql.SQL('CREATE ROLE {} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS').format(owner_id))
        try:
            self.admin.execute(sql.SQL('GRANT USAGE,CREATE ON SCHEMA domino_wallet_access TO {}').format(owner_id))
            for table in ('grants','audit'):
                self.admin.execute(sql.SQL('ALTER TABLE domino_wallet_access.{} OWNER TO {}').format(sql.Identifier(table),owner_id))
            self.admin.execute(sql.SQL('ALTER FUNCTION domino_wallet_access.set_access(text,boolean) OWNER TO {}').format(owner_id))
            self.admin.execute(sql.SQL('ALTER FUNCTION domino_wallet_access.guard_session_insert() OWNER TO {}').format(owner_id))
            flags = self.admin.execute('SELECT rolsuper,rolcanlogin,rolcreaterole FROM pg_roles WHERE rolname=%s',(owner_role,)).fetchone()
            self.assertEqual(flags,{'rolsuper':False,'rolcanlogin':False,'rolcreaterole':False})
            self.assertTrue(self.operator.grant(self.account.address)['allowed'])
            self.login()  # The INSERT trigger also runs without superuser rights.
            self.assertFalse(self.operator.revoke(self.account.address)['allowed'])
            self.assertEqual({row['actor'] for row in self.rows('domino_wallet_access.audit')},{OPERATOR})
            with psycopg.connect(**self.settings,user=AUTH,autocommit=True) as conn:
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    conn.execute('SELECT * FROM domino_wallet_access.set_access(%s,true)',(self.account.address.lower(),))
        finally:
            self.admin.execute(sql.SQL('ALTER FUNCTION domino_wallet_access.guard_session_insert() OWNER TO {}').format(sql.Identifier(ADMIN)))
            self.admin.execute(sql.SQL('ALTER FUNCTION domino_wallet_access.set_access(text,boolean) OWNER TO {}').format(sql.Identifier(ADMIN)))
            for table in ('grants','audit'):
                self.admin.execute(sql.SQL('ALTER TABLE domino_wallet_access.{} OWNER TO {}').format(sql.Identifier(table),sql.Identifier(ADMIN)))
            self.admin.execute(sql.SQL('REVOKE ALL ON SCHEMA domino_wallet_access FROM {}').format(owner_id))
            self.admin.execute(sql.SQL('DROP ROLE {}').format(owner_id))

    def test_audit_failure_rolls_back_grant_and_revoke_in_the_same_transaction(self):
        self.operator.grant(self.account.address); _, _, credentials, _ = self.login()
        grants = self.rows('domino_wallet_access.grants'); audit = self.rows('domino_wallet_access.audit')
        self.admin.execute("CREATE FUNCTION pg_temp.reject_wallet_audit() RETURNS trigger LANGUAGE plpgsql AS "
                           "$$ BEGIN RAISE EXCEPTION 'private injected failure'; END $$")
        self.admin.execute('CREATE TRIGGER wallet_access_test_audit_failure BEFORE INSERT ON domino_wallet_access.audit '
                           'FOR EACH ROW EXECUTE FUNCTION pg_temp.reject_wallet_audit()')
        try:
            self.denied('wallet_access_unavailable',lambda:self.operator.revoke(self.account.address),WalletAccessError)
            other = Account.from_key(bytes([10])*32).address
            self.denied('wallet_access_unavailable',lambda:self.operator.grant(other),WalletAccessError)
            self.assertEqual(self.rows('domino_wallet_access.grants'),grants)
            self.assertEqual(self.rows('domino_wallet_access.audit'),audit)
            self.call('me',session=credentials['session'])
        finally:
            self.admin.execute('DROP TRIGGER wallet_access_test_audit_failure ON domino_wallet_access.audit')
        self.assertFalse(self.operator.revoke(self.account.address)['allowed'])

    def test_missing_access_store_fails_closed_without_touching_session_or_calling_eoa(self):
        self.operator.grant(self.account.address); _, _, credentials, _ = self.login()
        before=self.session_row(credentials);calls=len(self.checker.calls)
        self.admin.execute('REVOKE SELECT ON domino_wallet_access.grants FROM domino_session_auth')
        try:
            for route in ('me','refresh'):
                self.denied('session_store_unavailable',lambda:self.call(route,**credentials))
            self.assertEqual(self.session_row(credentials),before);self.assertEqual(len(self.checker.calls),calls)
        finally:
            self.admin.execute('GRANT SELECT ON domino_wallet_access.grants TO domino_session_auth')
        self.call('me',session=credentials['session'])
        def unavailable(**kwargs):raise psycopg.OperationalError('private connection details')
        missing=WalletAccessAdmin(self.settings,connect=unavailable)
        self.denied('wallet_access_unavailable',lambda:missing.grant(self.account.address),WalletAccessError)

    def test_operator_listing_is_bounded_stable_and_has_no_auth_side_effects(self):
        for number in range(9,13):self.operator.grant(Account.from_key(bytes([number])*32).address)
        self.operator.revoke(self.account.address)
        audit=self.rows('domino_wallet_access.audit');grants=self.rows('domino_wallet_access.grants')
        first=self.operator.list(limit=2)
        self.assertTrue(first['hasMore']);self.assertEqual(first['nextAfter'],first['wallets'][-1]['address'])
        second=self.operator.list(limit=2,after=first['nextAfter'])
        self.assertFalse(second['hasMore']);self.assertIsNone(second['nextAfter'])
        addresses=[row['address'] for row in first['wallets']+second['wallets']]
        self.assertEqual(addresses,sorted(row['address'] for row in grants));self.assertEqual(len(set(addresses)),4)
        self.assertEqual(self.rows('domino_wallet_access.audit'),audit)
        self.assertEqual(self.rows('domino_wallet_access.grants'),grants)
        for limit in (0,101,True,1.0,'2'):
            self.denied('wallet_access_invalid_request',lambda:self.operator.list(limit=limit),WalletAccessError)
        self.denied('wallet_access_invalid_request',lambda:self.operator.list(after='untrusted'),WalletAccessError)

    def test_grants_stop_before_audit_capacity_without_consuming_reserved_revocation_room(self):
        self.operator.grant(self.account.address)
        self.admin.execute("INSERT INTO domino_wallet_access.audit(chain_id,address,generation,action,changed_at,actor) "
                           "SELECT 4663,%s,i+1,'grant',clock_timestamp(),'domino_wallet_access_operator' "
                           "FROM generate_series(1,89999) i",(self.account.address.lower(),))
        other=Account.from_key(bytes([10])*32).address
        self.denied('wallet_access_capacity',lambda:self.operator.grant(other),WalletAccessError)
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_wallet_access.audit').fetchone()['n'],90000)
        self.assertFalse(self.operator.revoke(self.account.address)['allowed'])
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_wallet_access.audit').fetchone()['n'],90001)
        self.assertEqual(len(self.rows('domino_wallet_access.grants')),1)


if __name__ == '__main__':
    unittest.main()
