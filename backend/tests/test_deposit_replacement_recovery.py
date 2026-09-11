"""Actual receipt reconciliation through service and PostgreSQL recovery.

RPC responses, auth and prepared handoffs are deterministic fixtures. Receipt
classification, NFT/fee checks, service projection and durable store transitions
are real; no synthetic reconciliation outcome is injected. No external network.
"""
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import uuid

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deposit_api import DepositGateway, create_deposit_app
from deposit_models import CONTRACT_VERSION, DepositError, validate_response
from deposit_receipt import ReceiptReconciler
from test_deposit_receipt import synthetic_review
from deposit_service import DepositService
from deposit_store import DepositStoreError, _Connection
from discovery import DataError
from session_models import SessionError
import test_deposit_store as store_tests
from test_deposit_receipt import (Rpc, OWNER, OTHER, HASH, OTHER_HASH, MINED, FINALIZED,
                                  DEADLINE, TOKEN_ID, block_hash)


class FixtureAuth:
    """The tests cover recovery, not the separately tested SIWE authenticator."""
    def begin(self, client, session, csrf):
        assert (client, session, csrf) == ('192.0.2.41', 'fixture-session', 'fixture-csrf')
        return {'owner': OWNER, 'session': session, 'csrf': csrf}

    def finish(self, context):
        assert context['owner'] == OWNER


class FixturePreparer:
    def __init__(self, artifact):
        self.artifact, self.calls = deepcopy(artifact), 0

    def revalidate(self, owner, selection, artifact):
        assert owner == OWNER and artifact == self.artifact

    def prepare(self, owner, selection):
        assert owner == OWNER
        self.calls += 1
        return deepcopy(self.artifact)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1',
                     'requires task-local PostgreSQL')
class DepositReplacementRecoveryTests(unittest.TestCase):
    def setUp(self):
        store_tests.DepositStoreTests.setUp(self)
        self.now = DEADLINE - 120
        original = _Connection.execute

        def sql_clock(conn, query, params=None):
            result = original(conn, query, params)
            if query == 'SELECT clock_timestamp() AS now':
                return SimpleNamespace(fetchone=lambda: {
                    'now': datetime.fromtimestamp(self.now, timezone.utc)})
            if query == 'SELECT extract(epoch FROM clock_timestamp())<%s AS valid':
                return SimpleNamespace(fetchone=lambda: {'valid': self.now < params[0]})
            return result

        clock = patch.object(_Connection, 'execute', sql_clock)
        clock.start(); self.addCleanup(clock.stop)
        network = patch('urllib.request.OpenerDirector.open',
                        side_effect=AssertionError('External network forbidden'))
        network.start(); self.addCleanup(network.stop)

    def call(self, route, record=None, **values):
        if record is not None:
            values = {'intentId': record['id'], **values}
            if route not in ('get', 'allowances'):
                values['version'] = record['version']
        response = self.service.execute(route, values, client='192.0.2.41',
                                        session='fixture-session', csrf='fixture-csrf')
        validate_response(route, response)
        if route != 'prepare':
            self.assertIsNone(response['walletStep'])
        return response

    def start(self, rpc=None, *, cancel=False, token_guard=synthetic_review):
        # Each matrix case has its own rows; failed red subtests cannot poison
        # the next scenario with the intentionally unresolved owner reservation.
        self.admin.execute('TRUNCATE domino_deposits.intents')
        self.admin.execute('UPDATE domino_deposits.capacity SET used=0,retained=0')
        self.now = DEADLINE - 120
        self.rpc = rpc or Rpc()
        self.preparer = FixturePreparer(self.rpc.artifact)
        self.service = DepositService(FixtureAuth(), self.store, self.preparer,
            lambda: ReceiptReconciler(self.rpc, token_guard=token_guard), clock=lambda: self.now)
        created = self.call('create', idempotencyKey=str(uuid.uuid4()),
                            selection=deepcopy(self.rpc.selection))['operation']
        prepared = self.call('prepare', created)
        self.assertEqual(prepared['walletStep'], self.rpc.artifact)
        record = prepared['operation']
        self.initial_artifact = deepcopy(self.rpc.artifact)
        self.initial_selection = deepcopy(self.rpc.selection)
        if cancel:
            record = self.call('cancel', record)['operation']
            self.assertEqual(record['state'], 'cancel_requested')
        return record

    @staticmethod
    def bump(rpc, fields=('gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas')):
        changes = {'gasLimit': ('gas', 300001), 'maxFeePerGas': ('maxFeePerGas', 220),
                   'maxPriorityFeePerGas': ('maxPriorityFeePerGas', 110)}
        for field in fields:
            name, value = changes[field]
            rpc.transaction[name] = hex(value)
        if 'maxFeePerGas' in fields:
            # Actual paid price may exceed the selection's 200 cap, but must
            # remain inside the observed signed transaction's actual 220 cap.
            rpc.receipt['effectiveGasPrice'] = hex(210)

    def report(self, record, transaction_hash=HASH):
        return self.call('report', record, transactionHash=transaction_hash)['operation']

    def assert_immutable(self, record):
        raw = self.store.get(OWNER, record['id'])
        self.assertEqual(raw['selection'], self.initial_selection)
        self.assertEqual(raw['history'][0]['artifact'], self.initial_artifact)
        self.assertEqual(len(raw['history']), 1)
        self.assertEqual(self.preparer.calls, 1)
        return raw

    def assert_busy(self, record):
        self.assertIn(record['state'], ('attention', 'cancel_requested', 'pending', 'awaiting_wallet'))
        draft = self.store.create(OWNER, str(uuid.uuid4()), self.rpc.selection)
        with self.assertRaises(DepositStoreError) as raised:
            self.store.issue(OWNER, draft['id'], draft['version'], self.initial_artifact)
        self.assertEqual(raised.exception.code, 'deposit_owner_busy')

    def assert_transaction_evidence(self, record, exceeded):
        raw = self.assert_immutable(record)
        receipt = raw['history'][0]['receipt']
        evidence = receipt['transaction']
        self.assertEqual(evidence['nonceRaw'], self.initial_artifact['transaction']['nonceRaw'])
        for field, raw_field in [('gasLimitRaw', 'gas'), ('maxFeePerGasRaw', 'maxFeePerGas'),
                                 ('maxPriorityFeePerGasRaw', 'maxPriorityFeePerGas')]:
            self.assertEqual(evidence[field], str(int(self.rpc.transaction[raw_field], 16)))
        self.assertEqual(sorted(evidence['selectedLimitsExceeded']), sorted(exceeded))
        self.assertEqual(len(evidence['selectedLimitsExceeded']), len(exceeded))
        self.assertEqual(record['history'][0]['receipt']['transaction'], evidence)
        paid = int(self.rpc.receipt['gasUsed'], 16) * int(self.rpc.receipt['effectiveGasPrice'], 16)
        self.assertEqual(receipt['gas']['grossGasFeeRaw'], str(paid))
        return raw

    def test_above_selected_caps_mint_confirms_even_after_cancel_request(self):
        groups = [('gasLimit',), ('maxFeePerGas',), ('maxPriorityFeePerGas',),
                  ('gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas')]
        for fields in groups:
            for cancel in (False, True):
                with self.subTest(fields=fields, cancel=cancel):
                    rpc = Rpc(); self.bump(rpc, fields)
                    record = self.report(self.start(rpc, cancel=cancel))
                    self.assertEqual(record['state'], 'confirmed')
                    self.assertFalse(record['outstanding'])
                    raw = self.assert_transaction_evidence(record, fields)
                    self.assertEqual(raw['history'][0]['receipt']['mint']['tokenId'], str(TOKEN_ID))
                    self.assertEqual(record['history'][0]['receipt']['position']['recipient'], OWNER)
                    with self.assertRaises(DepositError) as raised:
                        self.call('prepare', record)
                    self.assertEqual(raised.exception.code, 'deposit_state_conflict')

    def test_above_cap_reverted_mint_and_approval_release_only_actual_revert(self):
        for kind in ('mint', 'erc20_approval'):
            for cancel in (False, True):
                with self.subTest(kind=kind, cancel=cancel):
                    rpc = Rpc(kind=kind); self.bump(rpc)
                    rpc.receipt.update(status='0x0', logs=[])
                    record = self.report(self.start(rpc, cancel=cancel))
                    self.assertEqual(record['state'], 'reverted')
                    self.assertFalse(record['outstanding'])
                    raw = self.assert_transaction_evidence(record,
                        ('gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas'))
                    self.assertIsNone(raw['history'][0]['receipt']['mint'])
                    self.assertIsNone(raw['history'][0]['receipt']['approval'])

    def test_above_cap_confirmed_approval_preserves_cancel_and_allowance_evidence(self):
        for kind in ('erc20_reset', 'erc20_approval', 'permit2_approval'):
            for cancel in (False, True):
                with self.subTest(kind=kind, cancel=cancel):
                    rpc = Rpc(kind=kind); self.bump(rpc)
                    record = self.report(self.start(rpc, cancel=cancel))
                    self.assertEqual(record['state'], 'cancelled' if cancel else 'draft')
                    self.assertFalse(record['outstanding'])
                    raw = self.assert_transaction_evidence(record,
                        ('gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas'))
                    self.assertIsNotNone(raw['history'][0]['receipt']['approval'])
                    self.assertIsNone(raw['history'][0]['receipt']['mint'])

    def test_finality_and_receipt_nft_gates_survive_cap_override(self):
        for missing in ('finality_pending', 'finality_unavailable', 'receipt', 'nft_state'):
            with self.subTest(missing=missing):
                rpc = Rpc(); self.bump(rpc)
                if missing == 'finality_pending': rpc.finalized = MINED - 1
                elif missing == 'finality_unavailable': rpc.finalized = None
                elif missing == 'receipt': rpc.receipts = {}
                else: rpc.fail_receipt_state = True
                record = self.report(self.start(rpc))
                self.assertEqual(record['state'], 'pending')
                self.assertTrue(record['outstanding']); self.assert_busy(record)
                rpc.finalized = FINALIZED; rpc.receipts = {HASH: rpc.receipt}
                rpc.fail_receipt_state = False
                record = self.call('reconcile', record)['operation']
                self.assertEqual(record['state'], 'confirmed')
                self.assertFalse(record['outstanding']); self.assert_immutable(record)

    def test_nft_or_receipt_substitution_never_becomes_cap_override_confirmation(self):
        for corruption in ('nft', 'receipt_index'):
            with self.subTest(corruption=corruption):
                rpc = Rpc(); self.bump(rpc)
                if corruption == 'nft': rpc.bad_nft = True
                else: rpc.receipt['transactionIndex'] = '0x1'
                record = self.report(self.start(rpc))
                self.assertEqual(record['state'], 'attention')
                self.assertTrue(record['outstanding']); self.assert_busy(record)
                self.assert_immutable(record)

    def test_actual_fee_envelope_still_rejects_impossible_receipt_gas(self):
        rpc = Rpc(); self.bump(rpc)
        rpc.receipt['effectiveGasPrice'] = hex(221)
        issued = self.start(rpc)
        with self.assertRaises(DepositError) as raised:
            self.report(issued)
        self.assertEqual(raised.exception.code, 'deposit_reconciliation_unavailable')
        record = self.store.get(OWNER, issued['id'])
        self.assertTrue(record['outstanding']); self.assert_busy(record)

    def test_canonical_mined_bump_wins_over_stale_pending_hash_in_both_orders(self):
        for reverse in (False, True):
            with self.subTest(reverse=reverse):
                rpc = Rpc()
                pending = deepcopy(rpc.transaction)
                pending.update(blockHash=None, blockNumber=None, transactionIndex=None)
                self.bump(rpc)
                rpc.transaction['hash'] = OTHER_HASH
                rpc.receipt['transactionHash'] = OTHER_HASH
                for log in rpc.receipt['logs']: log['transactionHash'] = OTHER_HASH
                rpc.by_hash = {HASH: pending, OTHER_HASH: rpc.transaction}
                rpc.receipts = {OTHER_HASH: rpc.receipt}
                record = self.start(rpc)
                first, second = (OTHER_HASH, HASH) if reverse else (HASH, OTHER_HASH)
                raw = self.store.mark_submitted(OWNER, record['id'], record['version'], first)
                record = self.report(raw, second)
                self.assertEqual(record['state'], 'confirmed')
                self.assertEqual(record['history'][0]['receipt']['transactionHash'], OTHER_HASH)
                self.assert_transaction_evidence(record,
                    ('gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas'))

    def test_canonical_scan_resolves_reported_hash_missing_from_transaction_index(self):
        rpc = Rpc(); self.bump(rpc)
        rpc.by_hash = {}
        record = self.report(self.start(rpc), HASH)
        self.assertEqual(record['state'], 'confirmed'); self.assertFalse(record['outstanding'])
        self.assertEqual(record['history'][0]['receipt']['transactionHash'], HASH)
        raw = self.assert_transaction_evidence(record,
            ('gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas'))
        self.assertIn(HASH, raw['history'][0].get('resolvedSubmissionHashes', []))
        self.assertTrue(any(method == 'eth_getBlockByNumber' and params[1]
                            for method, params in rpc.calls))

    @staticmethod
    def foreign(rpc, *, cancellation=False):
        target = OWNER if cancellation else OTHER
        rpc.transaction.update(to=target, input='0x', value='0x0')
        rpc.receipt.update(to=target, logs=[], gasUsed=hex(21000))

    @staticmethod
    def add_off_nonce(rpc, original, *, mined=False):
        shifted = deepcopy(original)
        shifted.update(hash=OTHER_HASH, nonce='0x6', blockHash=None,
                       blockNumber=None, transactionIndex=None)
        if mined:
            shifted.update(blockHash=block_hash(MINED + 1),
                           blockNumber=hex(MINED + 1), transactionIndex='0x0')
            rpc.blocks[MINED + 1] = [shifted]
            rpc.nonce = 7
        rpc.by_hash[OTHER_HASH] = shifted

    def test_real_foreign_nonce_scan_from_cancel_requested_can_still_resolve(self):
        for cancellation in (False, True):
            with self.subTest(cancellation=cancellation):
                rpc = Rpc(); self.foreign(rpc, cancellation=cancellation)
                record = self.start(rpc, cancel=True)
                self.now = self.initial_artifact['expiresAt'] + 1
                record = self.call('reconcile', record)['operation']
                self.assertEqual(record['state'], 'cancelled' if cancellation else 'superseded')
                self.assertFalse(record['outstanding'])
                self.assertIsNone(record['history'][0]['receipt']['position'])
                self.assertTrue(any(method == 'eth_getBlockByNumber' and params[1]
                                    for method, params in rpc.calls))
                self.assert_immutable(record)

    def test_reported_off_nonce_effect_blocks_foreign_and_self_cancel_release(self):
        for cancellation in (False, True):
            for mined in (False, True):
                with self.subTest(cancellation=cancellation, mined=mined):
                    rpc = Rpc(); original = deepcopy(rpc.transaction)
                    self.foreign(rpc, cancellation=cancellation)
                    self.add_off_nonce(rpc, original, mined=mined)
                    record = self.start(rpc, cancel=True)
                    self.now = self.initial_artifact['expiresAt'] + 1
                    record = self.report(record, OTHER_HASH)
                    self.assertIn(record['state'], ('attention', 'cancel_requested'))
                    self.assertTrue(record['outstanding']); self.assert_busy(record)
                    conflict = [{'transactionHash': OTHER_HASH, 'nonceRaw': '6'}]
                    self.assertEqual(record['history'][0]['reportedEffectConflicts'], conflict)
                    raw = self.assert_immutable(record)
                    self.assertEqual(raw['history'][0]['reconciliation']['reason'],
                                     'reported_effect_nonce_mismatch')

    def test_off_nonce_conflict_survives_lookup_disappearance_and_store_recheck(self):
        rpc = Rpc(); original = deepcopy(rpc.transaction)
        self.foreign(rpc); self.add_off_nonce(rpc, original)
        record = self.start(rpc)
        self.now = self.initial_artifact['expiresAt'] + 1
        record = self.report(record, OTHER_HASH)
        self.assertEqual(record['state'], 'attention')
        conflict = deepcopy(record['history'][0]['reportedEffectConflicts'])
        rpc.by_hash.pop(OTHER_HASH)
        record = self.call('reconcile', record)['operation']
        self.assertEqual(record['state'], 'attention')
        self.assertEqual(record['history'][0]['reportedEffectConflicts'], conflict)
        # Independently defend the store from a later real observation whose
        # caller omitted the saved conflicts. This is not a fabricated outcome.
        fresh = ReceiptReconciler(rpc, token_guard=synthetic_review).reconcile(OWNER, rpc.selection, rpc.artifact,
                                                known_hashes=[HASH])
        raw = self.store.reconcile(OWNER, record['id'], record['version'], fresh)
        self.assertEqual(raw['state'], 'attention'); self.assertTrue(raw['outstanding'])
        current = self.call('get', raw)['operation']
        self.assertEqual(current['history'][0]['reportedEffectConflicts'], conflict)
        self.assert_busy(current)

    def test_conflict_lookup_outage_cannot_erase_last_durable_observation(self):
        rpc = Rpc(); original = deepcopy(rpc.transaction)
        self.foreign(rpc); self.add_off_nonce(rpc, original)
        record = self.start(rpc)
        self.now = self.initial_artifact['expiresAt'] + 1
        record = self.report(record, OTHER_HASH)
        self.assertEqual(record['state'], 'attention')
        before = self.store.get(OWNER, record['id'])
        request = rpc.request

        def unavailable(method, params):
            if method == 'eth_getTransactionByHash' and params[0] == OTHER_HASH:
                raise DataError('synthetic_provider_unavailable')
            return request(method, params)

        rpc.request = unavailable
        with self.assertRaises(DepositError) as raised:
            self.call('reconcile', record)
        self.assertEqual(raised.exception.code, 'deposit_reconciliation_unavailable')
        self.assertEqual(self.store.get(OWNER, record['id']), before)
        self.assert_busy(record)

    def test_first_conflict_observation_survives_later_rpc_failure_and_disappearance(self):
        rpc = Rpc(); original = deepcopy(rpc.transaction)
        self.foreign(rpc); self.add_off_nonce(rpc, original)
        record = self.start(rpc)
        self.now = self.initial_artifact['expiresAt'] + 1
        request = rpc.request

        def fail_after_hint(method, params):
            # The reported N+1 owner/effect has already been read. The next
            # full-block scan for N fails before reconciliation can finish.
            if method == 'eth_getBlockByNumber' and params[1]:
                raise DataError('synthetic_scan_unavailable_after_verified_hint')
            return request(method, params)

        rpc.request = fail_after_hint
        try:
            self.report(record, OTHER_HASH)
        except DepositError as error:
            self.assertEqual(error.code, 'deposit_reconciliation_unavailable')
        self.assertTrue(any(method == 'eth_getTransactionByHash' and params == [OTHER_HASH]
                            for method, params in rpc.calls))
        durable = self.store.get(OWNER, record['id'])
        rpc.request = request; rpc.by_hash.pop(OTHER_HASH)
        record = self.call('reconcile', durable)['operation']
        self.assertEqual(record['state'], 'attention')
        self.assertEqual(record['history'][0]['reportedEffectConflicts'],
                         [{'transactionHash': OTHER_HASH, 'nonceRaw': '6'}])
        self.assert_busy(record)

    def dropped_original_and_mined_bump(self):
        rpc = Rpc()
        original = deepcopy(rpc.transaction)
        original.update(blockHash=None, blockNumber=None, transactionIndex=None)
        self.bump(rpc)
        rpc.transaction['hash'] = OTHER_HASH
        rpc.receipt['transactionHash'] = OTHER_HASH
        for log in rpc.receipt['logs']: log['transactionHash'] = OTHER_HASH
        rpc.by_hash = {HASH: original, OTHER_HASH: rpc.transaction}
        rpc.receipts = {OTHER_HASH: rpc.receipt}
        return rpc, original

    def test_classified_original_nonce_survives_drop_and_allows_mined_fee_bump(self):
        rpc, original = self.dropped_original_and_mined_bump()
        rpc.blocks = {}; rpc.nonce = 5
        record = self.report(self.start(rpc), HASH)
        self.assertEqual(record['state'], 'pending')
        before = self.store.get(OWNER, record['id'])
        self.assertIn(HASH, before['history'][0].get('resolvedSubmissionHashes', []))
        rpc.by_hash.pop(HASH)
        rpc.blocks = {MINED: [rpc.transaction]}; rpc.nonce = 6
        record = self.report(record, OTHER_HASH)
        self.assertEqual(record['state'], 'confirmed'); self.assertFalse(record['outstanding'])
        self.assertEqual(record['history'][0]['reportedEffectConflicts'], [])
        self.assertEqual(record['history'][0]['receipt']['transactionHash'], OTHER_HASH)
        self.assert_transaction_evidence(record,
            ('gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas'))

    def test_never_classified_missing_hint_blocks_release_until_identity_is_resolved(self):
        rpc, original = self.dropped_original_and_mined_bump()
        rpc.by_hash.pop(HASH)
        record = self.start(rpc)
        raw = self.store.mark_submitted(OWNER, record['id'], record['version'], HASH)
        record = self.report(raw, OTHER_HASH)
        self.assertEqual(record['state'], 'attention'); self.assertTrue(record['outstanding'])
        self.assertEqual(record['history'][0]['reportedEffectConflicts'], [])
        self.assertEqual(record['history'][0]['receipt']['transactionHash'], OTHER_HASH)
        self.assert_busy(record)
        # Positive identity evidence, unlike a timeout or absence, resolves the
        # unknown hint. Its original nonce is already consumed by the mined R.
        rpc.by_hash[HASH] = original
        record = self.call('reconcile', record)['operation']
        self.assertEqual(record['state'], 'confirmed'); self.assertFalse(record['outstanding'])
        self.assertIn(HASH, self.store.get(OWNER, record['id'])['history'][0].get('resolvedSubmissionHashes', []))

    def test_positive_nonce_classification_is_checkpointed_before_later_scan_failure(self):
        rpc, original = self.dropped_original_and_mined_bump()
        record = self.start(rpc)
        request = rpc.request

        def scan_failure(method, params):
            if method == 'eth_getBlockByNumber' and params[1]:
                raise DataError('synthetic_scan_failure_after_positive_identity')
            return request(method, params)

        rpc.request = scan_failure
        with self.assertRaises(DepositError) as raised:
            self.report(record, HASH)
        self.assertEqual(raised.exception.code, 'deposit_reconciliation_unavailable')
        durable = self.store.get(OWNER, record['id'])
        self.assertIn(HASH, durable['history'][0].get('resolvedSubmissionHashes', []))
        rpc.request = request; rpc.by_hash.pop(HASH)
        record = self.call('reconcile', durable)['operation']
        self.assertEqual(record['state'], 'confirmed'); self.assertFalse(record['outstanding'])
        self.assertEqual(record['history'][0]['receipt']['transactionHash'], OTHER_HASH)

    def test_unrelated_identity_classification_survives_later_rpc_failure(self):
        for changes in ({'from': OTHER}, {'chainId': '0x1'}, {'value': '0x1'}):
            with self.subTest(changes=changes):
                rpc = Rpc(); original = deepcopy(rpc.transaction)
                self.foreign(rpc); self.add_off_nonce(rpc, original)
                rpc.by_hash[OTHER_HASH].update(changes)
                record = self.start(rpc)
                self.now = self.initial_artifact['expiresAt'] + 1
                request = rpc.request

                def scan_failure(method, params):
                    if method == 'eth_getBlockByNumber' and params[1]:
                        raise DataError('synthetic_scan_failure_after_unrelated_identity')
                    return request(method, params)

                rpc.request = scan_failure
                with self.assertRaises(DepositError):
                    self.report(record, OTHER_HASH)
                durable = self.store.get(OWNER, record['id'])
                self.assertIn(OTHER_HASH, durable['history'][0].get('resolvedSubmissionHashes', []))
                rpc.request = request; rpc.by_hash.pop(OTHER_HASH)
                record = self.call('reconcile', durable)['operation']
                self.assertEqual(record['state'], 'superseded')
                self.assertFalse(record['outstanding'])
                self.assertEqual(record['history'][0]['reportedEffectConflicts'], [])

    def test_previous_receipt_cannot_evict_oldest_unresolved_of_eight_reported_hashes(self):
        rpc = Rpc(); self.foreign(rpc)
        record = self.start(rpc)
        self.now = self.initial_artifact['expiresAt'] + 1
        hints = ['0x' + format(index, '064x') for index in range(1, 9)]
        for index, hint in enumerate(hints):
            if index:
                rpc.by_hash[hint] = {**deepcopy(rpc.transaction), 'hash': hint, 'from': OTHER,
                                     'nonce': '0x9', 'blockHash': None, 'blockNumber': None,
                                     'transactionIndex': None}
            record = self.store.mark_submitted(OWNER, record['id'], record['version'], hint)
        record = self.call('reconcile', record)['operation']
        self.assertEqual(record['state'], 'attention')
        self.assertEqual(record['history'][0]['receipt']['transactionHash'], HASH)
        rpc.calls.clear()
        record = self.call('reconcile', record)['operation']
        self.assertEqual(record['state'], 'attention'); self.assertTrue(record['outstanding'])
        self.assertEqual(self.store.get(OWNER, record['id'])['submissionHashes'], hints)
        self.assertIn(('eth_getTransactionByHash', [hints[0]]), rpc.calls)

    def test_auth_or_deadline_before_identity_checkpoint_keeps_missing_hint_protective(self):
        for failure in ('auth', 'deadline'):
            with self.subTest(failure=failure):
                rpc = Rpc(); original = deepcopy(rpc.transaction)
                self.foreign(rpc); self.add_off_nonce(rpc, original)
                record = self.start(rpc)
                self.now = self.initial_artifact['expiresAt'] + 1
                request = rpc.request
                instant = [0.0]

                def late_lookup(method, params):
                    result = request(method, params)
                    if method == 'eth_getTransactionByHash' and params == [OTHER_HASH]:
                        instant[0] = 100.0
                    return result

                class ExpiringAuth(FixtureAuth):
                    def finish(inner, context):
                        super().finish(context)
                        if any(method == 'eth_getTransactionByHash' and params == [OTHER_HASH]
                               for method, params in rpc.calls):
                            raise SessionError('session_required')

                if failure == 'auth':
                    self.service.auth = ExpiringAuth()
                    with self.assertRaises(SessionError):
                        self.report(record, OTHER_HASH)
                else:
                    rpc.request = late_lookup
                    with patch('read_deadline.time.monotonic', lambda: instant[0]), \
                            self.assertRaises(DepositError) as raised:
                        self.report(record, OTHER_HASH)
                    self.assertEqual(raised.exception.code, 'deposit_reconciliation_unavailable')
                durable = self.store.get(OWNER, record['id'])
                self.assertIn(OTHER_HASH, durable['submissionHashes'])
                self.assertTrue(durable['outstanding'])
                self.service.auth = FixtureAuth(); rpc.request = request
                rpc.by_hash.pop(OTHER_HASH)
                record = self.call('reconcile', durable)['operation']
                self.assertEqual(record['state'], 'attention'); self.assertTrue(record['outstanding'])
                # No successful checkpoint observed an off-nonce identity. An
                # unknown hint must not be mislabeled as a proven conflict.
                self.assertEqual(record['history'][0]['reportedEffectConflicts'], [])
                self.assert_busy(record)

    def test_missing_transaction_target_cannot_resolve_a_reported_off_nonce_hint(self):
        rpc = Rpc(); original = deepcopy(rpc.transaction)
        self.foreign(rpc); self.add_off_nonce(rpc, original)
        # Missing is corrupt provider data; explicit null would instead mean a
        # contract-creation transaction. Do not certify these as equivalent.
        rpc.by_hash[OTHER_HASH].pop('to')
        record = self.start(rpc)
        self.now = self.initial_artifact['expiresAt'] + 1
        with self.assertRaises(DepositError) as raised:
            self.report(record, OTHER_HASH)
        self.assertEqual(raised.exception.code, 'deposit_reconciliation_unavailable')
        durable = self.store.get(OWNER, record['id'])
        self.assertNotIn(OTHER_HASH, durable['history'][0].get('resolvedSubmissionHashes', []))
        rpc.by_hash.pop(OTHER_HASH)
        record = self.call('reconcile', durable)['operation']
        self.assertEqual(record['state'], 'attention'); self.assertTrue(record['outstanding'])
        self.assertEqual(record['history'][0]['reportedEffectConflicts'], [])
        self.assert_busy(record)

    def test_unrelated_owner_chain_or_effect_hint_cannot_create_execution_conflict(self):
        for changes in ({'from': OTHER}, {'chainId': '0x1'}, {'value': '0x1'}, {'input': '0x00'}):
            with self.subTest(changes=changes):
                rpc = Rpc(); original = deepcopy(rpc.transaction)
                self.foreign(rpc); self.add_off_nonce(rpc, original)
                rpc.by_hash[OTHER_HASH].update(changes)
                record = self.start(rpc, cancel=True)
                self.now = self.initial_artifact['expiresAt'] + 1
                record = self.report(record, OTHER_HASH)
                self.assertEqual(record['state'], 'superseded')
                self.assertFalse(record['outstanding'])
                self.assertEqual(record['history'][0].get('reportedEffectConflicts', []), [])

    def test_off_nonce_conflict_prevents_release_even_when_original_confirmed_or_reverted(self):
        for reverted in (False, True):
            with self.subTest(reverted=reverted):
                rpc = Rpc(); self.add_off_nonce(rpc, deepcopy(rpc.transaction))
                if reverted: rpc.receipt.update(status='0x0', logs=[])
                record = self.start(rpc)
                raw = self.store.mark_submitted(OWNER, record['id'], record['version'], HASH)
                record = self.report(raw, OTHER_HASH)
                self.assertEqual(record['state'], 'attention')
                self.assertTrue(record['outstanding']); self.assert_busy(record)
                raw = self.assert_immutable(record)
                self.assertIsNotNone(raw['history'][0]['receipt'])
                self.assertEqual(raw['history'][0]['receipt']['status'], 'reverted' if reverted else 'success')

    def test_same_call_with_unsupported_authorization_is_not_proof_of_no_mint(self):
        rpc = Rpc(); rpc.transaction.update(type='0x4', authorizationList=[{}])
        record = self.start(rpc)
        self.now = self.initial_artifact['expiresAt'] + 1
        record = self.report(record)
        self.assertEqual(record['state'], 'attention')
        self.assertTrue(record['outstanding']); self.assert_busy(record)
        self.assert_immutable(record)

    def test_reorg_of_bumped_mint_preserves_evidence_and_newer_reservation(self):
        rpc = Rpc(); self.bump(rpc)
        record = self.report(self.start(rpc))
        self.assertEqual(record['state'], 'confirmed')
        before = self.store.get(OWNER, record['id'])['history'][0]
        draft = self.store.create(OWNER, str(uuid.uuid4()), rpc.selection)
        next_artifact = deepcopy(self.initial_artifact)
        next_artifact['transaction']['nonceRaw'] = '6'
        newer = self.store.issue(OWNER, draft['id'], draft['version'], next_artifact)
        rpc.hash_overrides[MINED] = '0x' + 'ff' * 32
        rpc.blocks = {}; rpc.by_hash = {}; rpc.nonce = 5
        record = self.call('reconcile', record)['operation']
        self.assertEqual(record['state'], 'attention'); self.assertFalse(record['outstanding'])
        raw = self.store.get(OWNER, record['id'])
        self.assertEqual(raw['history'][0]['receipt'], before['receipt'])
        self.assertEqual(raw['history'][0]['initialFinalizedReceipt'], before['initialFinalizedReceipt'])
        self.assertTrue(raw['history'][0]['everReorged'])
        self.assertTrue(self.store.get(OWNER, newer['id'])['outstanding']); self.assert_busy(record)
        rpc.hash_overrides = {}; rpc.blocks = {MINED: [rpc.transaction]}
        rpc.by_hash = {HASH: rpc.transaction}; rpc.nonce = 6
        record = self.call('reconcile', record)['operation']
        self.assertEqual(record['state'], 'confirmed')
        self.assertTrue(self.store.get(OWNER, newer['id'])['outstanding'])
        self.assertEqual(len(record['history']), 1)

    def test_proxy_review_basis_and_nitro_caps_cannot_clear_cross_nonce_conflicts(self):
        for review_status in ('matched', 'changed', 'unavailable'):
            for conflict in (False, True):
                with self.subTest(review_status=review_status, conflict=conflict):
                    rpc = Rpc(); self.bump(rpc)
                    rpc.artifact['admission'].update(policyVersion='direct_existing_pool_v2',
                        tokenReviews=[{'address': rpc.selection['poolKey'][f'currency{i}'],
                                       'reviewId': 'f'*64} for i in (0, 1)])
                    if conflict:
                        self.add_off_nonce(rpc, deepcopy(rpc.transaction))
                    guard = lambda **values: {'status': review_status, 'reviewId': 'f'*64, 'upgradeable': True}
                    record = self.start(rpc, token_guard=guard)
                    record = self.report(record, OTHER_HASH if conflict else HASH)
                    self.assertEqual(record['state'], 'attention' if conflict else 'confirmed')
                    receipt = record['history'][0]['receipt']
                    self.assertEqual(receipt['position']['tokenId'], str(TOKEN_ID))
                    self.assertEqual(receipt['grossGasFeeRaw'], '21000000')
                    self.assertEqual(receipt['l1GasUsedRaw'], '10000')
                    self.assertEqual(receipt['l1FeeRaw'], '2100000')
                    self.assertIsNone(receipt['totalFeeRaw'])
                    for i, amount in enumerate(('100', '200')):
                        self.assertEqual(receipt['position'][f'amount{i}Raw'], amount if review_status == 'matched' else None)
                        self.assertEqual(receipt['position'][f'amount{i}Basis'],
                            'reviewed_proxy_transfer_events' if review_status == 'matched' else 'token_review_' + review_status)
                    self.assert_transaction_evidence(record,
                        ('gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas'))
                    if conflict:
                        saved = deepcopy(record['history'][0]['reportedEffectConflicts'])
                        self.assertEqual(saved, [{'transactionHash': OTHER_HASH, 'nonceRaw': '6'}])
                        rpc.by_hash.pop(OTHER_HASH)
                        record = self.call('reconcile', record)['operation']
                        self.assertEqual(record['state'], 'attention')
                        self.assertEqual(record['history'][0]['reportedEffectConflicts'], saved)
                        self.assert_busy(record)

    def test_http_bumped_mint_roundtrip_preserves_nitro_cost_and_observed_caps(self):
        for poster_gas in (None, 0, 10000):
            rpc = Rpc(); self.bump(rpc)
            if poster_gas is None:
                rpc.receipt.pop('gasUsedForL1')
            else:
                rpc.receipt['gasUsedForL1'] = hex(poster_gas)
            record = self.start(rpc, cancel=True)
            gateway = DepositGateway(service=self.service, verifier=SimpleNamespace(verify=Mock(return_value=True)),
                                     origin='https://domino.money', enabled=True)
            headers = {'Content-Type': 'application/json', 'CF-Access-Jwt-Assertion': 'fixture-assertion',
                'X-Domino-Browser-Origin': 'https://domino.money', 'X-Domino-Client-Id': '192.0.2.41',
                'X-Domino-Session': 'fixture-session', 'X-Domino-CSRF': 'fixture-csrf',
                'X-Domino-Deposit-Contract': CONTRACT_VERSION}
            with TestClient(create_deposit_app(gateway), base_url='http://127.0.0.1:8881',
                            client=('127.0.0.1', 43100)) as client:
                response = client.post('/internal/deposit/v1/report', headers=headers, content=json.dumps({
                    'intentId': record['id'], 'version': record['version'], 'transactionHash': HASH}))
            self.assertEqual(response.status_code, 200, response.text)
            payload = response.json(); validate_response('report', payload)
            self.assertIsNone(payload['walletStep']); self.assertEqual(payload['operation']['state'], 'confirmed')
            receipt = payload['operation']['history'][0]['receipt']
            self.assertEqual(receipt['l1GasUsedRaw'], None if poster_gas is None else str(poster_gas))
            self.assertEqual(receipt['l1FeeRaw'], None if poster_gas is None else str(poster_gas * 210))
            self.assertIsNone(receipt['totalFeeRaw'])
            self.assertEqual(receipt['grossGasFeeRaw'], '21000000')
            self.assertEqual(response.headers['X-Domino-Deposit-Contract'], CONTRACT_VERSION)
            self.assertFalse(payload['serverBroadcastAvailable']); self.assertFalse(payload['automationAvailable'])
            self.assert_transaction_evidence(payload['operation'],
                ('gasLimit', 'maxFeePerGas', 'maxPriorityFeePerGas'))


if __name__ == '__main__':
    unittest.main()
