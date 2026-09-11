"""Offline cryptographic SIWE and owner HTTP deposit lifecycle on real PG.

Preparation/chain observations are synthetic, already-qualified fixtures. Real
services still inspect the prepared mint, persist it, project receipts and check
session/version/owner boundaries. No financial transaction is signed or sent.
"""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
from threading import Event
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg.rows import dict_row
from eth_abi import decode, encode
from eth_account import Account
from eth_account.messages import encode_defunct
from fastapi.testclient import TestClient

from deposit_api import DepositGateway, create_deposit_app
from deposit_service import DepositService
from deposit_store import DepositStore, _Connection
from deposit_models import DepositError
from deposit_prepare import calldata, PERMIT2
from discovery import DataError
from dev_postgres import ADMIN, PORT, SOCKET
from onboarding_auth import OnboardingAuth
from session_api import SessionGateway, create_session_app
from session_service import SessionService
from session_siwe import SiwePolicy
from session_store import SessionStore, digest
from session_models import CONTRACT_VERSION as SESSION_VERSION
from deposit_models import CONTRACT_VERSION as DEPOSIT_VERSION
from wallet_access import WalletAccessAdmin
from deposit_contract_fixtures import artifact as artifact_fixture, selection as selection_fixture
from test_lp_mint_inspection import MINT_TYPES, OWNER as FIXTURE_OWNER, plan, set_plan
from test_deposit_receipt import Rpc, reconcile as receipt_fixture, HASH as TX_HASH

ORIGIN = 'https://domino.money'
ASSERTION = 'synthetic-deposit-service-identity'
SECRET = b'synthetic deposit flow abuse secret only'
PRIVATE = 'synthetic-private-provider-canary'
REPLACEMENT_HASH = '0x' + 'de'*32
VALIDATION = {'method': 'plain_eoa', 'blockNumber': '123', 'blockHash': '0x' + 'ab'*32}


class Preparer:
    def __init__(self):
        self.calls, self.effect, self.nonce = [], None, 7
        self.revalidation_calls, self.revalidation_effect = [], None
        self.kind = 'mint'

    def revalidate(self, owner, selection, artifact):
        self.revalidation_calls.append((owner, deepcopy(selection), deepcopy(artifact)))
        if self.revalidation_effect:
            self.revalidation_effect()

    def prepare(self, owner, selection):
        self.calls.append((owner, deepcopy(selection)))
        if self.effect:
            self.effect()
        result = artifact_fixture(now=int(time.time()))
        tx = result['transaction']
        actions, params, _ = plan(tx)
        mint = list(decode(MINT_TYPES, params[0]))
        mint[6] = owner
        params[0] = encode(MINT_TYPES, mint)
        set_plan(tx, actions, params, deadline=result['preparedDeadline'])
        tx['from'] = owner
        if self.kind == 'erc20_approval':
            result['kind'] = self.kind
            tx.update(to=selection['poolKey']['currency1'], valueRaw='0',
                data=calldata('approve(address,uint256)', ['address', 'uint256'],
                              [PERMIT2, int(result['mintedBounds']['amount1MaxRaw'])]))
        tx['nonceRaw'] = str(self.nonce)
        return result


class Reconciler:
    def __init__(self):
        self.calls, self.mode = [], 'pending'

    def reconcile(self, owner, selection, artifact, **kwargs):
        self.calls.append((owner, deepcopy(selection), deepcopy(artifact), deepcopy(kwargs)))
        if self.mode == 'pending':
            return {'state': 'pending', 'reason': 'receipt_pending',
                'transactionHash': kwargs['known_hashes'][0] if kwargs['known_hashes'] else None,
                'nonceConsumed': False, 'nonceFinalized': False, 'replacement': False,
                'differentEffect': False, 'cancellation': False, 'reorgDetected': False,
                'receipt': None, 'scanCursor': None, 'scanComplete': False, 'retryAllowed': False,
                'resolvedSubmissionHashes': list(kwargs['known_hashes'])}
        # Reuse the independently tested chain-reader producer fixture, binding
        # its synthetic successful NFT recipient/current owner to this login.
        if self.mode in ('changed_approval', 'unavailable_approval'):
            observed = receipt_fixture(Rpc(kind='erc20_approval'), token_guard=lambda **values: {
                'status': 'changed' if self.mode == 'changed_approval' else 'unavailable',
                'reviewId': 'f'*64, 'upgradeable': True})
        else:
            observed = receipt_fixture(Rpc())
        def replace(value):
            if isinstance(value, dict):
                return {key: replace(child) for key, child in value.items()}
            if isinstance(value, list):
                return [replace(child) for child in value]
            return owner if value == FIXTURE_OWNER else value
        observed = replace(observed)
        observed['resolvedSubmissionHashes'] = list(kwargs['known_hashes'])
        observed['receipt']['transaction'] = {**{key: artifact['transaction'][key]
            for key in ('nonceRaw', 'gasLimitRaw', 'maxFeePerGasRaw', 'maxPriorityFeePerGasRaw')},
            'selectedLimitsExceeded': []}
        gas = observed['receipt']['gas']
        gas.update(effectiveGasPriceRaw='10', grossGasFeeRaw='1000000', totalFeeRaw=None)
        gas['l1FeeRaw'] = None if gas['l1GasUsedRaw'] is None else str(int(gas['l1GasUsedRaw'])*10)
        if self.mode in ('cancelled', 'superseded'):
            observed.update(state='mismatched', reason='transaction_mismatch',
                            transactionHash=REPLACEMENT_HASH, replacement=True, differentEffect=True,
                            cancellation=self.mode == 'cancelled')
            observed['receipt'].update(transactionHash=REPLACEMENT_HASH, mint=None, transaction=None)
            gas.update(gasUsedRaw='21000', grossGasFeeRaw='210000', totalFeeRaw=None)
        return observed


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1',
                     'set DOMINO_TEST_POSTGRES=1 after prepare-tests')
class DepositFlowTests(unittest.TestCase):
    def setUp(self):
        self.settings = {'host': str(SOCKET), 'port': PORT, 'dbname': 'domino_catalogue_tests'}
        self.admin = psycopg.connect(**self.settings, user=ADMIN, autocommit=True, row_factory=dict_row)
        self.addCleanup(self.admin.close)
        self.admin.execute('TRUNCATE domino_sessions.contexts,domino_sessions.challenges,domino_sessions.sessions,'
                           'domino_sessions.rate_limits,domino_sessions.private_limits,domino_deposits.intents')
        self.admin.execute('UPDATE domino_deposits.capacity SET used=0,retained=0')
        self.admin.execute('TRUNCATE domino_wallet_access.grants,domino_wallet_access.audit RESTART IDENTITY')
        self.access = WalletAccessAdmin(self.settings)
        self.checker = SimpleNamespace(check=Mock(side_effect=lambda owner: dict(VALIDATION)))
        self.verifier = SimpleNamespace(verify=Mock(return_value=True))
        session_store = SessionStore(self.settings, abuse_secret=SECRET)
        session_service = SessionService(session_store, SiwePolicy(ORIGIN), self.checker)
        self.sessions = self.client(create_session_app(SessionGateway(service=session_service,
            verifier=self.verifier, origin=ORIGIN, enabled=True)), 8879)
        self.auth = OnboardingAuth(SessionStore(self.settings, abuse_secret=SECRET), self.checker)
        self.store = DepositStore(self.settings)
        self.preparer, self.reconciler = Preparer(), Reconciler()
        self.service = DepositService(self.auth, self.store, self.preparer,
                                      lambda: self.reconciler, private_values=(PRIVATE,))
        self.deposits = self.client(create_deposit_app(DepositGateway(service=self.service,
            verifier=self.verifier, origin=ORIGIN, enabled=True)), 8881)
        blocked = patch('urllib.request.OpenerDirector.open', side_effect=AssertionError('External network forbidden'))
        blocked.start()
        self.addCleanup(blocked.stop)

    def client(self, app, port):
        client = TestClient(app, client=('127.0.0.1', 43100), base_url=f'http://127.0.0.1:{port}')
        client.__enter__()
        self.addCleanup(client.__exit__, None, None, None)
        return client

    def post(self, kind, route, body=None, credentials=None, *, client_id='192.0.2.1', headers=None):
        credentials = credentials or {}
        request_headers = {'Content-Type': 'application/json', 'CF-Access-Jwt-Assertion': ASSERTION,
            'X-Domino-Browser-Origin': ORIGIN, 'X-Domino-Client-Id': credentials.get('client', client_id),
            f'X-Domino-{kind.title()}-Contract': SESSION_VERSION if kind == 'session' else DEPOSIT_VERSION}
        for name in ('preauth', 'session', 'csrf'):
            if credentials.get(name) is not None:
                request_headers['X-Domino-' + name] = credentials[name]
        request_headers.update(headers or {})
        client = self.sessions if kind == 'session' else self.deposits
        return client.post(f'/internal/{kind}/v1/{route}', content=json.dumps(body or {}), headers=request_headers)

    def login(self, number=1):
        account = Account.from_key(bytes([number]) * 32)
        self.access.grant(account.address)
        client = f'192.0.2.{number}'
        response = self.post('session', 'bootstrap', client_id=client)
        self.assertEqual(response.status_code, 200, response.text)
        bootstrap = response.json()
        preauth = {'preauth': bootstrap['credentials']['preauth'], 'csrf': bootstrap['result']['csrfToken'], 'client': client}
        response = self.post('session', 'challenge', {'address': account.address, 'chainId': 4663}, preauth)
        self.assertEqual(response.status_code, 200, response.text)
        challenge = response.json()['result']
        signature = '0x' + Account.sign_message(encode_defunct(text=challenge['message']), account.key).signature.hex()
        response = self.post('session', 'verify', {'challengeId': challenge['challengeId'],
            'message': challenge['message'], 'signature': signature}, preauth)
        self.assertEqual(response.status_code, 200, response.text)
        authenticated = response.json()
        self.assertEqual(authenticated['result']['owner']['address'], account.address.lower())
        return {'session': authenticated['credentials']['session'], 'csrf': authenticated['result']['csrfToken'],
                'client': client}, account.address.lower()

    def create(self, credentials, *, key=None):
        body = {'idempotencyKey': key or str(uuid.uuid4()), 'selection': selection_fixture()}
        response = self.post('deposit', 'create', body, credentials)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()['operation'], body

    def change(self, route, record, credentials, **extra):
        return self.post('deposit', route, {'intentId': record['id'], 'version': record['version'], **extra}, credentials)

    def error(self, response, status, code):
        self.assertEqual(response.status_code, status, response.text)
        self.assertEqual(response.json(), {'error': code})
        self.assertTrue({'no-store', 'no-transform'} <= {value.strip().lower() for value in response.headers['cache-control'].split(',')})
        self.assertNotIn('content-encoding', response.headers)
        self.assertEqual(response.headers['X-Domino-Deposit-Contract'], DEPOSIT_VERSION)
        self.assertNotIn('set-cookie', response.headers)
        for private in (PRIVATE, ASSERTION):
            self.assertNotIn(private, response.text)

    def test_changed_token_after_persistence_blocks_wallet_delivery_and_preserves_reservation(self):
        credentials, owner = self.login()
        record, _ = self.create(credentials)
        def changed():
            saved = self.store.get(owner, record['id'])
            self.assertTrue(saved['outstanding'])
            self.assertEqual(saved['version'], 2)
            raise DepositError('deposit_token_changed')
        self.preparer.revalidation_effect = changed
        response = self.change('prepare', record, credentials)
        self.error(response, 409, 'deposit_token_changed')
        saved = DepositStore(self.settings).get(owner, record['id'])
        self.assertEqual(saved['state'], 'awaiting_wallet')
        self.assertTrue(saved['outstanding'])
        self.assertEqual(len(saved['history']), 1)
        self.assertIsNotNone(saved['issued'])
        self.assertNotIn('data', response.json())
        other, _ = self.create(credentials)
        self.error(self.change('prepare', other, credentials), 409, 'deposit_owner_busy')
        self.assertEqual(self.store.get(owner, record['id'])['history'], saved['history'])

    def test_session_revoked_during_final_token_recheck_never_delivers_persisted_step(self):
        credentials, owner = self.login()
        record, _ = self.create(credentials)
        def revoke():
            response = self.post('session', 'logout', credentials=credentials)
            self.assertEqual(response.status_code, 200, response.text)
        self.preparer.revalidation_effect = revoke
        response = self.change('prepare', record, credentials)
        self.error(response, 401, 'session_required')
        saved = self.store.get(owner, record['id'])
        self.assertTrue(saved['outstanding'])
        self.assertEqual(saved['version'], 2)
        self.assertEqual(len(saved['history']), 1)

    def test_token_change_blocks_redelivery_but_not_submitted_receipt_reconciliation(self):
        credentials, owner = self.login()
        record, _ = self.create(credentials)
        prepared = self.change('prepare', record, credentials)
        self.assertEqual(prepared.status_code, 200, prepared.text)
        issued = prepared.json()['operation']
        initial = self.store.get(owner, record['id'])
        self.preparer.revalidation_effect = lambda: (_ for _ in ()).throw(DepositError('deposit_token_changed'))
        self.error(self.change('prepare', issued, credentials), 409, 'deposit_token_changed')
        self.assertEqual(len(self.preparer.calls), 1, 'Re-delivery cannot create another transaction.')
        self.assertEqual(len(self.preparer.revalidation_calls), 2)
        self.assertEqual(self.store.get(owner, record['id'])['history'], initial['history'])
        self.reconciler.mode = 'confirmed'
        response = self.change('report', issued, credentials, transactionHash=TX_HASH)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['operation']['state'], 'confirmed')
        self.assertIsNone(response.json()['walletStep'])
        self.assertEqual(len(self.preparer.revalidation_calls), 2, 'Receipt lookup must survive token admission changes.')

    def test_unavailable_current_review_keeps_handoff_and_existing_facts(self):
        credentials, owner = self.login()
        record, _ = self.create(credentials)
        prepared = self.change('prepare', record, credentials)
        issued = prepared.json()['operation']
        initial = self.store.get(owner, record['id'])
        self.preparer.revalidation_effect = lambda: (_ for _ in ()).throw(DepositError('deposit_token_check_unavailable'))
        self.error(self.change('prepare', issued, credentials), 503, 'deposit_token_check_unavailable')
        restored = DepositStore(self.settings).get(owner, record['id'])
        self.assertTrue(restored['outstanding'])
        self.assertEqual(restored['history'], initial['history'])
        read = self.post('deposit', 'get', {'intentId': record['id']}, credentials)
        self.assertEqual(read.status_code, 200)
        self.assertIsNone(read.json()['walletStep'])

    def test_changed_or_unavailable_approval_retains_owner_reservation_and_canonical_receipt(self):
        for number, mode in enumerate(('changed_approval', 'unavailable_approval'), start=1):
            with self.subTest(mode=mode):
                credentials, owner = self.login(number)
                self.preparer.kind = 'erc20_approval'
                record, _ = self.create(credentials)
                prepared = self.change('prepare', record, credentials)
                self.assertEqual(prepared.status_code, 200, prepared.text)
                self.reconciler.mode = mode
                response = self.change('report', prepared.json()['operation'], credentials, transactionHash=TX_HASH)
                self.assertEqual(response.status_code, 200, response.text)
                operation = response.json()['operation']
                self.assertEqual(operation['state'], 'attention' if mode == 'changed_approval' else 'pending')
                self.assertTrue(operation['outstanding'])
                self.assertIsNone(response.json()['walletStep'])
                saved = DepositStore(self.settings).get(owner, record['id'])
                self.assertTrue(saved['history'][0]['reconciliation']['nonceFinalized'])
                self.assertEqual(saved['history'][0]['receipt']['transactionHash'], TX_HASH)
                self.assertIsNone(saved['history'][0]['receipt']['approval']['amountRaw'])
                self.assertEqual(saved['history'][0]['initialFinalizedReceipt'], saved['history'][0]['receipt'])
                other, _ = self.create(credentials)
                self.error(self.change('prepare', other, credentials), 409, 'deposit_owner_busy')

    def test_signed_session_create_idempotency_get_and_foreign_owner_isolation(self):
        first, owner = self.login()
        record, request = self.create(first)
        self.assertEqual(record['owner'], owner)
        self.assertEqual(record['state'], 'draft')
        self.assertEqual(record['version'], 1)
        repeated = self.post('deposit', 'create', request, first)
        self.assertEqual(repeated.status_code, 200, repeated.text)
        self.assertEqual(repeated.json()['operation'], record)
        changed = deepcopy(request)
        changed['selection']['amountRaw'] = '99'
        self.error(self.post('deposit', 'create', changed, first), 409, 'deposit_idempotency_conflict')
        second, other = self.login(2)
        self.error(self.post('deposit', 'get', {'intentId': record['id']}, second), 404, 'deposit_not_found')
        separate, _ = self.create(second, key=request['idempotencyKey'])
        self.assertEqual(separate['owner'], other)
        self.assertNotEqual(separate['id'], record['id'])
        own = self.post('deposit', 'get', {'intentId': record['id']}, first)
        self.assertEqual(own.status_code, 200, own.text)
        self.assertEqual(own.json()['operation'], record)
        self.assertIsNone(own.json()['walletStep'])
        self.assertEqual(self.preparer.calls, [])

    def test_prepare_persists_before_wallet_delivery_and_get_never_resends_calldata(self):
        credentials, owner = self.login()
        record, _ = self.create(credentials)
        observed = []
        original = self.auth.finish
        def finish(context):
            result = original(context)
            stored = self.store.get(owner, record['id'])
            observed.append(stored['outstanding'])
            return result
        with patch.object(self.auth, 'finish', side_effect=finish):
            response = self.change('prepare', record, credentials)
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body['walletStep']['transaction']['from'], owner)
        self.assertEqual(body['operation']['state'], 'awaiting_wallet')
        self.assertEqual(body['operation']['version'], 2)
        self.assertTrue(observed[-1])
        stored = DepositStore(self.settings).get(owner, record['id'])
        self.assertEqual(stored['issued'], body['walletStep'])
        self.assertEqual(stored['issued'], stored['history'][0]['artifact'])
        self.assertTrue(stored['outstanding'])
        read = self.post('deposit', 'get', {'intentId': record['id']}, credentials)
        self.assertEqual(read.status_code, 200, read.text)
        self.assertIsNone(read.json()['walletStep'])
        self.assertNotIn('dd46508f', read.text)
        for private in (credentials['session'], credentials['csrf'], PRIVATE, ASSERTION):
            self.assertNotIn(private, response.text)
        self.assertFalse(body['serverBroadcastAvailable'])
        self.assertFalse(body['automationAvailable'])

    def test_report_is_a_hint_and_confirmation_ends_the_intent_without_second_mint(self):
        credentials, owner = self.login()
        record, request = self.create(credentials)
        prepared = self.change('prepare', record, credentials)
        self.assertEqual(prepared.status_code, 200, prepared.text)
        issued = prepared.json()['operation']
        report = self.change('report', issued, credentials, transactionHash=TX_HASH)
        self.assertEqual(report.status_code, 200, report.text)
        pending = report.json()['operation']
        self.assertEqual(pending['state'], 'pending')
        self.assertTrue(pending['outstanding'])
        self.assertEqual(pending['version'], 4)
        self.assertIsNone(pending['history'][0]['receipt'])
        self.assertIsNone(report.json()['walletStep'])
        self.assertEqual(self.reconciler.calls[-1][3]['known_hashes'], [TX_HASH])
        self.reconciler.mode = 'confirmed'
        response = self.change('reconcile', pending, credentials)
        self.assertEqual(response.status_code, 200, response.text)
        final = response.json()['operation']
        self.assertEqual(final['version'], 5)
        self.assertEqual(final['state'], 'confirmed')
        self.assertFalse(final['outstanding'])
        self.assertEqual(final['history'][0]['receipt']['position']['recipient'], owner)
        self.assertEqual(final['history'][0]['receipt']['finality'], 'finalized')
        self.error(self.change('prepare', final, credentials), 409, 'deposit_state_conflict')
        repeat = self.post('deposit', 'create', request, credentials)
        self.assertEqual(repeat.status_code, 200, repeat.text)
        self.assertEqual(repeat.json()['operation'], final)
        self.assertEqual(len(self.preparer.calls), 1)
        self.assertEqual(len(self.store.get(owner, record['id'])['history']), 1)

    def test_logout_expiry_csrf_and_admission_changes_during_preparer_prevent_delivery(self):
        for number, action in enumerate(('logout', 'csrf', 'revoke', 'regrant', 'expiry'), start=1):
            with self.subTest(action=action):
                credentials, owner = self.login(number)
                record, _ = self.create(credentials)
                entered, released = Event(), Event()
                def pause():
                    entered.set()
                    if not released.wait(3):
                        raise AssertionError('Preparation not released')
                self.preparer.effect = pause
                with ThreadPoolExecutor(max_workers=1) as pool:
                    future = pool.submit(self.change, 'prepare', record, credentials)
                    try:
                        self.assertTrue(entered.wait(2))
                        if action == 'logout':
                            response = self.post('session', action, credentials=credentials)
                            self.assertEqual(response.status_code, 200, response.text)
                        elif action in ('revoke', 'regrant'):
                            self.access.revoke(owner)
                            if action == 'regrant':
                                self.access.grant(owner)
                        elif action == 'csrf':
                            self.admin.execute('UPDATE domino_sessions.sessions SET csrf_hash=%s WHERE bearer_hash=%s',
                                               (digest('z'*43), digest(credentials['session'])))
                        else:
                            self.admin.execute("UPDATE domino_sessions.sessions SET created_at=statement_timestamp()-interval '1 hour', expires_at=statement_timestamp()+interval '11 hours', last_used_at=statement_timestamp()-interval '31 minutes' WHERE bearer_hash=%s",
                                               (digest(credentials['session']),))
                    finally:
                        released.set()
                    denied = future.result(timeout=3)
                self.preparer.effect = None
                self.error(denied, 403 if action == 'csrf' else 401,
                           'csrf_invalid' if action == 'csrf' else 'session_required')
                stored = self.store.get(owner, record['id'])
                self.assertEqual(stored['state'], 'draft')
                self.assertEqual(stored['version'], 1)
                self.assertIsNone(stored['issued'])

    def test_cookie_only_reload_two_tabs_preserve_csrf_and_deposit_step(self):
        credentials, owner = self.login()
        checks = self.checker.check.call_count
        initial = self.admin.execute('SELECT * FROM domino_sessions.sessions').fetchall()
        for _ in range(2):
            # Public GET /me becomes a private POST at the session BFF.
            response = self.post('session', 'me', credentials={'session': credentials['session']})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()['result']['csrfToken'], credentials['csrf'])
        self.assertEqual(self.admin.execute('SELECT * FROM domino_sessions.sessions').fetchall(), initial)
        self.assertEqual(self.checker.check.call_count, checks)
        record, _ = self.create(credentials)
        response = self.change('prepare', record, credentials)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['operation']['owner'], owner)
        self.assertIsNotNone(response.json()['walletStep'])

    def test_revoke_after_issuance_denies_payload_but_preserves_nonce_for_fresh_login(self):
        credentials, owner = self.login()
        record, _ = self.create(credentials)
        issue = self.store.issue
        def revoke_after_commit(*args, **kwargs):
            issued = issue(*args, **kwargs)
            self.access.revoke(owner)
            return issued
        with patch.object(self.store, 'issue', side_effect=revoke_after_commit):
            denied = self.change('prepare', record, credentials)
        self.error(denied, 401, 'session_required')
        self.assertNotIn('walletStep', denied.json())
        stored = self.store.get(owner, record['id'])
        self.assertTrue(stored['outstanding'])
        self.assertEqual(stored['state'], 'awaiting_wallet')
        self.assertIsNotNone(stored['issued'])
        original_nonce = stored['issued']['transaction']['nonceRaw']
        checks, preparations = self.checker.check.call_count, len(self.preparer.calls)
        self.access.grant(owner)
        self.error(self.post('deposit', 'get', {'intentId': record['id']}, credentials), 401, 'session_required')
        self.assertEqual(self.checker.check.call_count, checks)
        fresh, same_owner = self.login()
        self.assertEqual(same_owner, owner)
        recovered = self.post('deposit', 'get', {'intentId': record['id']}, fresh)
        self.assertEqual(recovered.status_code, 200, recovered.text)
        response = self.change('prepare', recovered.json()['operation'], fresh)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['walletStep']['transaction']['nonceRaw'], original_nonce)
        self.assertEqual(len(self.preparer.calls), preparations)

    def test_report_can_add_wallet_cancel_hash_and_preserves_original_hint(self):
        credentials, owner = self.login()
        record, _ = self.create(credentials)
        prepared = self.change('prepare', record, credentials)
        self.assertEqual(prepared.status_code, 200, prepared.text)
        reported = self.change('report', prepared.json()['operation'], credentials, transactionHash=TX_HASH)
        self.assertEqual(reported.status_code, 200, reported.text)
        cancelling = self.change('cancel', reported.json()['operation'], credentials)
        self.assertEqual(cancelling.status_code, 200, cancelling.text)
        self.assertTrue(cancelling.json()['operation']['outstanding'])
        self.reconciler.mode = 'cancelled'
        response = self.change('report', cancelling.json()['operation'], credentials, transactionHash=REPLACEMENT_HASH)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['operation']['state'], 'cancelled')
        self.assertFalse(response.json()['operation']['outstanding'])
        self.assertEqual(self.reconciler.calls[-1][3]['known_hashes'], [TX_HASH, REPLACEMENT_HASH])
        stored = self.store.get(owner, record['id'])
        self.assertEqual(stored['submissionHashes'], [TX_HASH, REPLACEMENT_HASH])
        self.assertEqual(len(stored['history']), 1)
        self.assertIsNone(response.json()['walletStep'])

    def test_logout_after_persistence_denies_delivery_but_preserves_unresolved_nonce(self):
        credentials, owner = self.login()
        record, _ = self.create(credentials)
        original = self.store.issue
        def issue(*args):
            persisted = original(*args)
            response = self.post('session', 'logout', credentials=credentials)
            self.assertEqual(response.status_code, 200, response.text)
            return persisted
        with patch.object(self.store, 'issue', side_effect=issue):
            denied = self.change('prepare', record, credentials)
        self.error(denied, 401, 'session_required')
        stored = self.store.get(owner, record['id'])
        self.assertTrue(stored['outstanding'])
        self.assertEqual(stored['state'], 'awaiting_wallet')
        self.assertEqual(len(stored['history']), 1)
        self.assertNotIn('walletStep', denied.json())

    def test_browser_authority_and_private_failure_details_never_cross_boundary(self):
        credentials, owner = self.login()
        request = {'idempotencyKey': str(uuid.uuid4()), 'selection': selection_fixture()}
        for key in ('owner', 'wallet', 'recipient', 'tenant', 'calldata', 'transaction', 'apiKey'):
            response = self.post('deposit', 'create', {**request, key: PRIVATE}, credentials)
            self.error(response, 400, 'invalid_request')
        self.assertEqual(self.store.list(owner), [])

        self.assertEqual(self.preparer.calls, [])
        for header in ('Cookie', 'Authorization', 'Origin'):
            self.error(self.post('deposit', 'create', request, credentials, headers={header: PRIVATE}), 403, 'origin_not_allowed')
        record, _ = self.create(credentials)
        def fail():
            raise RuntimeError(PRIVATE)
        self.preparer.effect = fail
        self.error(self.change('prepare', record, credentials), 503, 'upstream_unavailable')
        self.assertIsNone(self.store.get(owner, record['id'])['issued'])
        self.preparer.effect = None
        self.verifier.verify.side_effect = DataError(PRIVATE)
        self.error(self.post('deposit', 'get', {'intentId': record['id']}, credentials), 503, 'upstream_unavailable')

    def test_allowance_read_is_private_csrf_bound_and_never_mutates_or_prepares(self):
        from deposit_contract_fixtures import allowance_report
        credentials, owner = self.login()
        record, _ = self.create(credentials)
        reader = SimpleNamespace(read=Mock(return_value=allowance_report()))
        self.service.allowance_reader_factory = lambda: reader
        response = self.post('deposit', 'allowances', {'intentId': record['id']}, credentials)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(response.json()['walletStep'])
        self.assertEqual(response.json()['operation'], record)
        reader.read.assert_called_once_with(owner, record['selection'])
        self.assertEqual(self.preparer.calls, [])
        second, _ = self.login(2)
        self.error(self.post('deposit','allowances',{'intentId':record['id']},second),404,'deposit_not_found')
        self.error(self.post('deposit','allowances',{'intentId':record['id']},
                            {**credentials,'csrf':'x'*43}),403,'csrf_invalid')
        self.assertEqual(reader.read.call_count, 1)

    def test_foreign_nonce_recovers_through_authenticated_http_without_repeating_mint(self):
        credentials, owner = self.login()
        record, _ = self.create(credentials)
        response = self.change('prepare', record, credentials)
        self.assertEqual(response.status_code,200,response.text)
        issued=response.json()['operation']
        self.reconciler.mode='superseded'
        original=_Connection.execute
        future=datetime.now(timezone.utc)+timedelta(seconds=61)
        def execute(conn, query, params=None):
            result=original(conn,query,params)
            return SimpleNamespace(fetchone=lambda:{'now':future}) if query=='SELECT clock_timestamp() AS now' else result
        with patch.object(_Connection,'execute',execute):
            response=self.change('reconcile',issued,credentials)
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['operation']['state'],'superseded')
        self.assertFalse(response.json()['operation']['outstanding'])
        self.assertIsNone(response.json()['walletStep'])
        self.assertIsNone(response.json()['operation']['history'][-1]['receipt']['position'])
        self.preparer.nonce=8
        again, _=self.create(credentials)
        response=self.change('prepare',again,credentials)
        self.assertEqual(response.status_code,200,response.text)
        self.assertEqual(response.json()['walletStep']['transaction']['nonceRaw'],'8')
        self.assertEqual(len(self.store.get(owner,issued['id'])['history']),1)


if __name__ == '__main__':
    unittest.main()
