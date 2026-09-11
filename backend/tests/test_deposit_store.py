"""Private intent durability, nonce ambiguity and owner RLS on disposable PG."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import psycopg
from psycopg.rows import dict_row
from eth_abi import encode
from eth_hash.auto import keccak

from deposit_store import DepositStore, DepositStoreError, MAX_HISTORY, MAX_SUBMISSION_HASHES, ROLE, _Connection
from dev_postgres import ADMIN, BIN, PORT, ROOT, SOCKET
from discovery import KEY_TYPES, POSITION_MANAGER, ZERO, DataError
from read_deadline import read_deadline

OWNER, OTHER = ('0x' + 'aa'*20, '0x' + 'bb'*20)
TOKEN0, TOKEN1 = ('0x' + '11'*20, '0x' + '22'*20)
POOL_KEY = {'currency0': TOKEN0, 'currency1': TOKEN1, 'fee_pips': 3000, 'tick_spacing': 60, 'hooks': ZERO}
POOL_ID = '0x' + keccak(encode(KEY_TYPES, tuple(POOL_KEY.values()))).hex()
TX_HASH, OTHER_HASH = ('0x' + '12'*32, '0x' + '34'*32)
BLOCK_HASH = '0x' + '56'*32
SELECTION = {'chainId': 4663, 'poolId': POOL_ID, 'poolKey': POOL_KEY,
    'independentToken': TOKEN0, 'amountRaw': '100', 'tickLower': -120, 'tickUpper': 180,
    'slippageBps': 50, 'budget0Raw': '110', 'budget1Raw': '220', 'nativeGasReserveRaw': '300',
    'maxGasLimitRaw': '200000', 'maxFeePerGasRaw': '5', 'maxPriorityFeePerGasRaw': '1'}


def artifact(*, owner=OWNER, kind='mint', nonce=1):
    now = int(time.time())
    return {'kind': kind, 'transaction': {'chainId': 4663, 'from': owner,
        'to': POSITION_MANAGER if kind == 'mint' else TOKEN0, 'data': '0x12345678', 'valueRaw': '0',
        'nonceRaw': str(nonce), 'gasLimitRaw': '100000', 'maxFeePerGasRaw': '5', 'maxPriorityFeePerGasRaw': '1'},
        'sourceBlock': {'number': 100, 'hash': BLOCK_HASH, 'timestamp': now}, 'expiresAt': now+30,
        'preparedDeadline': now+120,
        'mintedBounds': {'amount0MaxRaw': '101', 'amount1MaxRaw': '202', 'mintLiquidityRaw': '23', 'nativeValueRaw': '0'},
        'balances': {'nativeRaw': '10000000', 'token0Raw': '1000', 'token1Raw': '2000'},
        'admission': {'manifestId': 'ab'*32, 'policyVersion': 'direct_existing_pool_v1'},
        'simulation': {'status': 'passed', 'estimatedGasRaw': '90000', 'blockNumber': 100, 'blockHash': BLOCK_HASH}}


def outcome(state='confirmed', *, finalized=True, replacement=False, receipt=True, tx_hash=TX_HASH,
            different_effect=None, cancellation=None):
    observed = None
    if receipt:
        observed = {'transactionHash': tx_hash, 'blockNumber': 101, 'blockHash': BLOCK_HASH,
            'transactionIndex': 0, 'status': 'reverted' if state == 'reverted' else 'success', 'canonical': True,
            'finality': {'status': 'finalized' if finalized else 'pending', 'basis': 'rpc_finalized_tag',
                'observedHead': {'number': 102, 'hash': BLOCK_HASH, 'timestamp': int(time.time())},
                'finalizedHead': {'number': 102 if finalized else 100, 'hash': BLOCK_HASH, 'timestamp': int(time.time())},
                'confirmations': 2, 'absoluteFinalityProven': False},
            'gas': {'gasUsedRaw': '1000', 'effectiveGasPriceRaw': '5', 'executionFeeRaw': '5000',
                    'l1FeeRaw': None, 'totalFeeRaw': None, 'totalFeeStatus': 'l1_fee_unavailable'},
            'mint': None, 'approval': None}
    return {'state': state, 'reason': 'synthetic_observation', 'transactionHash': tx_hash if receipt else None,
        'nonceConsumed': receipt, 'nonceFinalized': finalized and receipt,
        'replacement': replacement, 'differentEffect': replacement if different_effect is None else different_effect,
        'cancellation': replacement if cancellation is None else cancellation,
        'reorgDetected': state == 'reorged',
        'receipt': observed, 'scanCursor': None, 'scanComplete': False, 'retryAllowed': False}


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1',
                     'set DOMINO_TEST_POSTGRES=1 after prepare-tests')
class DepositStoreTests(unittest.TestCase):
    def setUp(self):
        self.settings = {'host': str(SOCKET), 'port': PORT, 'dbname': 'domino_catalogue_tests'}
        self.admin = psycopg.connect(**self.settings, user=ADMIN, autocommit=True, row_factory=dict_row)
        self.addCleanup(self.admin.close)
        self.admin.execute('TRUNCATE domino_deposits.intents')
        self.admin.execute('UPDATE domino_deposits.capacity SET used=0,retained=0')
        self.store, self.peer = DepositStore(self.settings), DepositStore(self.settings)

    def create(self, owner=OWNER, key=None, selection=None):
        return self.store.create(owner, key or str(uuid.uuid4()), selection or deepcopy(SELECTION))

    def issue(self, record, **kwargs):
        return self.store.issue(record['owner'], record['id'], record['version'], artifact(owner=record['owner'], **kwargs))

    def reconcile(self, record, value=None):
        return self.store.reconcile(record['owner'], record['id'], record['version'], value or outcome())

    def error(self, code, call):
        with self.assertRaises(DepositStoreError) as raised:
            call()
        self.assertEqual(raised.exception.code, code)
        self.assertEqual(str(raised.exception), code)

    def test_idempotent_immutable_selection_is_owner_scoped_and_survives_restart(self):
        key = str(uuid.uuid4())
        created = self.create(key=key)
        reordered = dict(reversed(list(SELECTION.items())))
        repeated = self.peer.create(OWNER, key, reordered)
        self.assertEqual(repeated, created)
        self.assertEqual(created['state'], 'draft')
        self.assertEqual(created['version'], 1)
        self.assertIsNone(created['issued'])
        self.assertIsInstance(created['createdAt'], int)
        self.error('deposit_idempotency_conflict', lambda: self.peer.create(OWNER, key, {**SELECTION, 'amountRaw': '99'}))
        other = self.create(OTHER, key=key)
        self.assertNotEqual(other['id'], created['id'])
        self.error('deposit_not_found', lambda: self.store.get(OTHER, created['id']))
        self.assertEqual([row['id'] for row in self.store.list(OTHER)], [other['id']])
        created['selection']['amountRaw'] = '1'
        self.assertEqual(self.store.get(OWNER, repeated['id'])['selection']['amountRaw'], '100')

    def test_concurrent_create_with_one_key_commits_only_one_intent(self):
        key = str(uuid.uuid4())
        with ThreadPoolExecutor(max_workers=4) as pool:
            values = list(pool.map(lambda _: self.peer.create(OWNER, key, SELECTION), range(4)))
        self.assertEqual(len({value['id'] for value in values}), 1)
        self.assertEqual(self.admin.execute('SELECT used FROM domino_deposits.capacity').fetchone()['used'], 1)

    def test_pagination_is_stable_at_equal_timestamps_and_rejects_foreign_anchors(self):
        original = _Connection.execute
        instant = datetime.now(timezone.utc)
        def fixed_time(conn, query, parameters=None):
            result = original(conn, query, parameters)
            return SimpleNamespace(fetchone=lambda: {'now': instant}) if query == 'SELECT clock_timestamp() AS now' else result
        with patch.object(_Connection, 'execute', fixed_time):
            records = [self.create() for _ in range(5)]
        first = self.store.list(OWNER, 2)
        second = self.store.list(OWNER, 2, before=first[-1]['id'])
        last = self.store.list(OWNER, 2, before=second[-1]['id'])
        expected = sorted((row['id'] for row in records), reverse=True)
        self.assertEqual([row['id'] for row in first+second+last], expected)
        self.assertEqual(self.store.list(OWNER, 2, before=last[-1]['id']), [])
        foreign = self.create(OTHER)
        self.error('deposit_not_found', lambda: self.store.list(OWNER, 2, before=foreign['id']))
        self.error('deposit_not_found', lambda: self.store.list(OWNER, 2, before=str(uuid.uuid4())))

    def test_atomic_owner_wide_issuance_and_optimistic_version_races(self):
        first, second = self.create(), self.create()
        def issue(record):
            try:
                return self.issue(record)
            except DepositStoreError as error:
                return error.code
        with ThreadPoolExecutor(max_workers=2) as pool:
            result = list(pool.map(issue, (first, second)))
        self.assertEqual(sum(isinstance(value, dict) for value in result), 1)
        self.assertIn('deposit_owner_busy', result)
        winner = next(value for value in result if isinstance(value, dict))
        self.assertTrue(winner['outstanding'])
        self.assertEqual(self.peer.get(OWNER, winner['id']), winner)
        self.error('deposit_version_conflict', lambda: self.store.issue(OWNER, winner['id'], 1, artifact()))
        self.assertEqual(self.issue(self.create(OTHER))['state'], 'awaiting_wallet')

    def test_same_intent_parallel_issue_cannot_expose_two_payloads(self):
        created = self.create()
        def run(nonce):
            try:
                return self.issue(created, nonce=nonce)
            except DepositStoreError as error:
                return error.code
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(run, (1, 2)))
        self.assertEqual(sum(isinstance(value, dict) for value in results), 1)
        self.assertIn('deposit_version_conflict', results)
        record = self.store.get(OWNER, created['id'])
        self.assertEqual(len(record['history']), 1)

    def test_issue_persists_exact_evidence_before_response_and_no_expiry_eviction(self):
        prepared = artifact()
        created = self.create()
        issued = self.store.issue(OWNER, created['id'], 1, prepared)
        prepared['transaction']['data'] = '0xdeadbeef'
        restored = self.peer.get(OWNER, created['id'])
        self.assertEqual(restored['issued']['transaction']['data'], '0x12345678')
        self.assertEqual(restored['history'][0]['artifact'], restored['issued'])
        self.assertRegex(restored['history'][0]['artifactHash'], r'^[0-9a-f]{64}$')
        # An expired display deadline is not proof that a wallet never signed.
        self.admin.execute("UPDATE domino_deposits.intents SET history=jsonb_set(history,'{0,artifact,expiresAt}','0') WHERE id=%s", (issued['id'],))
        self.error('deposit_owner_busy', lambda: self.issue(self.create()))
        self.assertTrue(self.peer.get(OWNER, issued['id'])['outstanding'])

    def test_issued_cancel_and_unknown_receipt_never_free_nonce(self):
        issued = self.issue(self.create())
        cancelled = self.store.cancel(OWNER, issued['id'], issued['version'])
        self.assertEqual(cancelled['state'], 'cancel_requested')
        self.assertTrue(cancelled['outstanding'])
        pending = self.reconcile(cancelled, outcome('not_found', finalized=False, receipt=False))
        self.assertEqual(pending['state'], 'cancel_requested')
        self.assertTrue(pending['outstanding'])
        self.error('deposit_owner_busy', lambda: self.issue(self.create()))
        self.assertEqual(len(pending['history']), 1)

    def test_draft_cancel_is_terminal_and_does_not_expire_idempotency(self):
        draft = self.create()
        result = self.store.cancel(OWNER, draft['id'], draft['version'])
        self.assertEqual(result['state'], 'cancelled')
        self.assertFalse(result['outstanding'])
        self.assertEqual(self.store.create(OWNER, draft['idempotencyKey'], SELECTION), result)
        self.error('deposit_state_conflict', lambda: self.issue(result))
        self.assertEqual(self.issue(self.create())['state'], 'awaiting_wallet')

    def test_reported_hashes_are_only_hints_and_keep_original_and_replacements(self):
        issued = self.issue(self.create())
        reported = self.store.mark_submitted(OWNER, issued['id'], issued['version'], TX_HASH)
        self.assertEqual(reported['state'], 'pending')
        self.assertTrue(reported['outstanding'])
        self.assertIsNone(reported['history'][0]['receipt'])
        self.assertEqual(self.store.mark_submitted(OWNER, reported['id'], reported['version'], TX_HASH), reported)
        replacement = self.store.mark_submitted(OWNER, reported['id'], reported['version'], OTHER_HASH)
        self.assertEqual(replacement['submissionHash'], OTHER_HASH)
        self.assertEqual(replacement['submissionHashes'], [TX_HASH, OTHER_HASH])
        self.assertEqual(self.peer.get(OWNER, reported['id'])['history'][0]['submissionHashes'], [TX_HASH, OTHER_HASH])
        self.assertTrue(replacement['outstanding'])
        self.assertIsNone(replacement['history'][0]['receipt'])
        self.error('deposit_owner_busy', lambda: self.issue(self.create()))

    def test_reported_replacement_hint_capacity_is_bounded_without_dropping_evidence(self):
        record = self.issue(self.create())
        hints = ['0x' + format(index, '064x') for index in range(MAX_SUBMISSION_HASHES)]
        for hint in hints:
            record = self.store.mark_submitted(OWNER, record['id'], record['version'], hint)
        self.error('deposit_history_full', lambda: self.store.mark_submitted(OWNER, record['id'], record['version'], TX_HASH))
        self.assertEqual(self.peer.get(OWNER, record['id'])['submissionHashes'], hints)
        self.assertTrue(record['outstanding'])

    def test_provisional_inclusion_keeps_issuance_until_finalized_approval_then_mint(self):
        approval = self.issue(self.create(), kind='erc20_approval')
        included = self.reconcile(approval, outcome('pending', finalized=False))
        self.assertEqual(included['state'], 'pending')
        self.assertTrue(included['outstanding'])
        self.error('deposit_state_conflict', lambda: self.issue(included, kind='mint', nonce=2))
        approved = self.reconcile(included)
        self.assertEqual(approved['state'], 'draft')
        self.assertFalse(approved['outstanding'])
        mint = self.issue(approved, nonce=2)
        final = self.reconcile(mint)
        self.assertEqual(final['state'], 'confirmed')
        self.assertFalse(final['outstanding'])
        self.assertEqual(len(final['history']), 2)
        self.assertEqual(final['history'][0]['artifact']['kind'], 'erc20_approval')
        self.assertEqual(final['history'][0]['receipt']['finality']['status'], 'finalized')
        self.assertEqual(self.peer.create(OWNER, final['idempotencyKey'], SELECTION), final)
        self.error('deposit_state_conflict', lambda: self.issue(final, nonce=3))

    def test_finalized_revert_is_terminal_and_keeps_receipt_and_payload(self):
        reverted = self.reconcile(self.issue(self.create()), outcome('reverted'))
        self.assertEqual(reverted['state'], 'reverted')
        self.assertFalse(reverted['outstanding'])
        self.assertEqual(reverted['history'][0]['receipt']['status'], 'reverted')
        self.error('deposit_state_conflict', lambda: self.issue(reverted, nonce=2))
        self.assertEqual(self.issue(self.create(), nonce=2)['state'], 'awaiting_wallet')

    def test_approval_finalization_after_cancel_does_not_start_a_mint(self):
        issued = self.issue(self.create(), kind='permit2_approval')
        cancelling = self.store.cancel(OWNER, issued['id'], issued['version'])
        final = self.reconcile(cancelling)
        self.assertEqual(final['state'], 'cancelled')
        self.assertFalse(final['outstanding'])
        self.error('deposit_state_conflict', lambda: self.issue(final))

    def test_cancelled_mint_request_cannot_hide_a_successful_mint(self):
        issued = self.issue(self.create())
        cancelling = self.store.cancel(OWNER, issued['id'], issued['version'])
        final = self.reconcile(cancelling)
        self.assertEqual(final['state'], 'confirmed')
        self.assertFalse(final['outstanding'])

    def test_only_finalized_replacement_of_cancel_requested_can_release(self):
        issued = self.issue(self.create())
        mismatch = self.reconcile(issued, outcome('mismatched', replacement=True, tx_hash=OTHER_HASH))
        self.assertEqual(mismatch['state'], 'attention')
        self.assertTrue(mismatch['outstanding'])
        cancelling = self.store.cancel(OWNER, mismatch['id'], mismatch['version'])
        provisional = self.reconcile(cancelling, outcome('mismatched', replacement=True, finalized=False, tx_hash=OTHER_HASH))
        self.assertTrue(provisional['outstanding'])
        self.assertEqual(provisional['state'], 'cancel_requested')
        final = self.reconcile(provisional, outcome('mismatched', replacement=True, tx_hash=OTHER_HASH))
        self.assertEqual(final['state'], 'cancelled')
        self.assertFalse(final['outstanding'])

    def test_cancel_accepts_same_already_observed_finalized_replacement_without_new_block(self):
        evidence = outcome('mismatched', replacement=True, tx_hash=OTHER_HASH)
        attention = self.reconcile(self.issue(self.create()), evidence)
        cancelling = self.store.cancel(OWNER, attention['id'], attention['version'])
        final = self.reconcile(cancelling, evidence)
        self.assertEqual(final['state'], 'cancelled')
        self.assertFalse(final['outstanding'])

    def test_gas_only_replacement_does_not_prove_that_requested_mint_was_cancelled(self):
        issued = self.issue(self.create())
        cancelling = self.store.cancel(OWNER, issued['id'], issued['version'])
        observed = outcome('mismatched', replacement=True, different_effect=False)
        unresolved = self.reconcile(cancelling, observed)
        self.assertTrue(unresolved['outstanding'])
        self.assertEqual(unresolved['state'], 'cancel_requested')

    def test_arbitrary_different_effect_replacement_cannot_be_labeled_cancelled(self):
        issued = self.issue(self.create())
        cancelling = self.store.cancel(OWNER, issued['id'], issued['version'])
        observed = outcome('mismatched', replacement=True, different_effect=True, cancellation=False)
        unresolved = self.reconcile(cancelling, observed)
        self.assertTrue(unresolved['outstanding'])
        self.assertEqual(unresolved['state'], 'cancel_requested')

    def test_reorg_preserves_evidence_and_never_rearms_finalized_mint(self):
        final = self.reconcile(self.issue(self.create()))
        reorged = self.reconcile(final, outcome('reorged', finalized=False, receipt=False))
        self.assertEqual(reorged['state'], 'attention')
        self.assertTrue(reorged['outstanding'])
        self.assertTrue(reorged['history'][0]['everReorged'])
        self.assertEqual(reorged['history'][0]['initialFinalizedReceipt']['transactionHash'], TX_HASH)
        self.error('deposit_state_conflict', lambda: self.issue(reorged, nonce=2))
        self.error('deposit_owner_busy', lambda: self.issue(self.create(), nonce=2))

    def test_old_finalized_reorg_is_recorded_even_when_newer_intent_is_outstanding(self):
        final = self.reconcile(self.issue(self.create()))
        newer = self.issue(self.create(), nonce=2)
        reorged = self.reconcile(final, outcome('reorged', finalized=False, receipt=False))
        self.assertEqual(reorged['state'], 'attention')
        self.assertFalse(reorged['outstanding'])
        self.assertTrue(self.store.get(OWNER, newer['id'])['outstanding'])
        newer_final = self.reconcile(newer, outcome(tx_hash=OTHER_HASH))
        self.assertFalse(newer_final['outstanding'])
        self.error('deposit_owner_busy', lambda: self.issue(self.create(), nonce=3))

    def test_capacity_saturation_retains_unresolved_and_terminal_idempotency(self):
        issued = self.issue(self.create())
        self.admin.execute('UPDATE domino_deposits.capacity SET used=10000,retained=10000')
        self.error('deposit_capacity_busy', lambda: self.create(OTHER))
        self.assertEqual(self.peer.get(OWNER, issued['id']), issued)
        self.assertEqual(self.peer.create(OWNER, issued['idempotencyKey'], SELECTION), issued)
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_deposits.intents').fetchone()['n'], 1)

    def test_history_is_bounded_without_discarding_prior_approvals(self):
        record = self.create()
        for nonce in range(MAX_HISTORY):
            record = self.reconcile(self.issue(record, kind='erc20_approval', nonce=nonce))
        self.error('deposit_history_full', lambda: self.issue(record, nonce=MAX_HISTORY))
        restored = self.peer.get(OWNER, record['id'])
        self.assertEqual(len(restored['history']), MAX_HISTORY)
        self.assertEqual([int(step['artifact']['transaction']['nonceRaw']) for step in restored['history']], list(range(MAX_HISTORY)))

    def test_fresh_deadline_guard_rolls_back_issuance_before_exposure(self):
        draft = self.create()
        original = _Connection.execute
        wrote = []
        def expired(conn, query, args=None):
            result = original(conn, query, args)
            if query.startswith('UPDATE intents SET state='):
                wrote.append(True)
            if query.startswith('SELECT extract(epoch FROM clock_timestamp())'):
                return SimpleNamespace(fetchone=lambda: {'valid': False})
            return result
        with patch.object(_Connection, 'execute', expired):
            self.error('deposit_artifact_expired', lambda: self.issue(draft))
        self.assertEqual(wrote, [True])
        self.assertEqual(self.peer.get(OWNER, draft['id']), draft)
        self.assertEqual(self.issue(draft)['state'], 'awaiting_wallet')

    def test_malformed_identity_artifact_receipt_and_limits_fail_closed(self):
        draft = self.create()
        for change in ({'transaction': {**artifact()['transaction'], 'from': OTHER}},
                       {'transaction': {**artifact()['transaction'], 'nonceRaw': str(1 << 64)}},
                       {'transaction': {**artifact()['transaction'], 'authorizationList': []}},
                       {'expiresAt': True}, {'sourceBlock': {'number': 1, 'hash': 'wrong', 'timestamp': 0}},
                       {'unexpected': 'x' * 98304}):
            with self.subTest(change=list(change)):
                self.error('deposit_invalid_request', lambda: self.store.issue(OWNER, draft['id'], 1, {**artifact(), **change}))
        self.error('deposit_artifact_expired', lambda: self.store.issue(OWNER, draft['id'], 1, {**artifact(), 'expiresAt': 1}))
        self.error('deposit_artifact_expired', lambda: self.store.issue(OWNER, draft['id'], 1, {**artifact(), 'expiresAt': int(time.time())+1000}))
        issued = self.issue(draft)
        for change in ({'nonceFinalized': False}, {'receipt': None}, {'retryAllowed': True}, {'nonceConsumed': 1},
                       {'receipt': {**outcome()['receipt'], 'finality': {'status': 'pending', 'basis': 'rpc_finalized_tag'}}},
                       {'receipt': {**outcome()['receipt'], 'transactionHash': OTHER_HASH}}):
            self.error('deposit_invalid_request', lambda: self.reconcile(issued, {**outcome(), **change}))
        self.assertEqual(self.peer.get(OWNER, issued['id']), issued)
        for limit in (True, 0, 51, '20'):
            self.error('deposit_invalid_request', lambda: self.store.list(OWNER, limit))
        self.error('deposit_invalid_request', lambda: self.store.create(OWNER, 'not-uuid', SELECTION))

    def test_forced_owner_rls_and_role_isolation_block_cross_tenant_access(self):
        created = self.create()
        with psycopg.connect(**self.settings, user=ROLE, autocommit=True, row_factory=dict_row) as conn:
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM domino_deposits.intents').fetchone()['n'], 0)
            conn.execute("SELECT set_config('domino.deposit_owner',%s,false)", (OTHER,))
            self.assertEqual(conn.execute('UPDATE domino_deposits.intents SET state=%s WHERE id=%s', ('cancelled', created['id'])).rowcount, 0)
            self.assertEqual(conn.execute('SELECT count(*) AS n FROM domino_deposits.intents').fetchone()['n'], 0)
            for query in ('SELECT * FROM domino_sessions.sessions', 'SELECT * FROM domino_catalogue.events',
                          'SET ROLE domino_session_auth', 'SET ROLE domino_catalogue_writer',
                          'DELETE FROM domino_deposits.intents', 'TRUNCATE domino_deposits.intents',
                          'UPDATE domino_deposits.capacity SET used=0', 'ALTER TABLE domino_deposits.intents DISABLE ROW LEVEL SECURITY'):
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    conn.execute(query)
        for role in ('domino_catalogue_reader', 'domino_catalogue_writer', 'domino_session_auth'):
            with psycopg.connect(**self.settings, user=role, autocommit=True) as conn:
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    conn.execute('SELECT * FROM domino_deposits.intents')
        security = self.admin.execute("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='domino_deposits.intents'::regclass").fetchone()
        self.assertTrue(security['relrowsecurity'])
        self.assertTrue(security['relforcerowsecurity'])

    def test_database_preserves_selection_and_identity_even_for_own_tenant_updates(self):
        created = self.create()
        with psycopg.connect(**self.settings, user=ROLE, autocommit=True) as conn:
            conn.execute("SELECT set_config('domino.deposit_owner',%s,false)", (OWNER,))
            for query, parameters in (
                ("UPDATE domino_deposits.intents SET selection=jsonb_set(selection,'{amountRaw}','\"99\"') WHERE id=%s", (created['id'],)),
                ('UPDATE domino_deposits.intents SET idempotency_key=%s WHERE id=%s', (str(uuid.uuid4()), created['id'])),
                ('UPDATE domino_deposits.intents SET owner=%s WHERE id=%s', (OTHER, created['id']))):
                with self.assertRaises(psycopg.errors.CheckViolation):
                    conn.execute(query, parameters)
        self.assertEqual(self.peer.get(OWNER, created['id']), created)

    def test_database_and_deadline_errors_are_fixed_and_never_expose_details(self):
        def fail(**kwargs):
            raise psycopg.OperationalError('private database configuration')
        store = DepositStore(self.settings, connect=fail)
        self.error('deposit_store_unavailable', lambda: store.create(OWNER, str(uuid.uuid4()), SELECTION))
        clock = [0]
        with self.assertRaises(DataError):
            with read_deadline(1, clock=lambda: clock[0]):
                clock[0] = 2
                self.error('request_timeout', lambda: self.create())
        self.assertEqual(self.store.list(OWNER), [])

    def test_migration_reapply_and_backup_restore_preserve_outstanding_reservation(self):
        issued = self.issue(self.create())
        reported = self.store.mark_submitted(OWNER, issued['id'], issued['version'], TX_HASH)
        pending = self.reconcile(reported, outcome('pending', finalized=False))
        self.admin.execute((ROOT / 'migrations/009_direct_deposits.sql').read_text())
        self.admin.execute((ROOT / 'migrations/010_deposit_recovery.sql').read_text())
        self.admin.execute((ROOT / 'migrations/014_deposit_draft_recovery.sql').read_text())
        self.assertEqual(self.peer.get(OWNER, pending['id']), pending)
        with tempfile.TemporaryDirectory(prefix='domino-deposit-restore-') as directory:
            path = Path(directory) / 'deposits.dump'
            dumped = subprocess.run([str(BIN / 'pg_dump'), '--host', str(SOCKET), '--port', str(PORT),
                '--username', ADMIN, '--dbname', self.settings['dbname'], '--format=custom',
                '--schema=domino_deposits', '--file', str(path)], capture_output=True, timeout=30)
            self.assertEqual(dumped.returncode, 0, dumped.stderr.decode())
            restored = subprocess.run([str(BIN / 'pg_restore'), '--host', str(SOCKET), '--port', str(PORT),
                '--username', ADMIN, '--dbname', 'domino_catalogue_restore_tests', '--clean', '--if-exists',
                '--no-owner', '--exit-on-error', str(path)], capture_output=True, timeout=30)
            self.assertEqual(restored.returncode, 0, restored.stderr.decode())
        store = DepositStore({**self.settings, 'dbname': 'domino_catalogue_restore_tests'})
        self.assertEqual(store.get(OWNER, pending['id']), pending)
        self.assertEqual(store.create(OWNER, pending['idempotencyKey'], SELECTION), pending)
        self.error('deposit_not_found', lambda: store.get(OTHER, pending['id']))
        other = store.create(OWNER, str(uuid.uuid4()), SELECTION)
        self.error('deposit_owner_busy', lambda: store.issue(OWNER, other['id'], other['version'], artifact(nonce=2)))


if __name__ == '__main__':
    unittest.main()
