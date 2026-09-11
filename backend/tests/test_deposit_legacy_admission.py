"""A real v1 preparer, its own receipt guard and durable owner recovery.

Only provider/RPC/auth responses and the SQL clock are fixtures. Preparation,
receipt evidence, public projection and PostgreSQL transitions are production
code. These synthetic immutable tokens do not qualify any deployed token.
"""
from copy import deepcopy
from datetime import datetime, timezone
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import uuid

from eth_abi import decode, encode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deposit_models import DepositError, validate_response
from deposit_prepare import DirectDepositPreparer
from deposit_receipt import ReceiptReconciler, receipt_summary
from deposit_service import DepositService
from deposit_store import DepositStore, DepositStoreError, _Connection
from discovery import DataError
from test_deposit_prepare import (CODE, Provider, Rpc as PreparationRpc,
                                 signed_manifest, selection, KEY)
from test_deposit_receipt import (Rpc, OWNER, HASH, TOKEN0, TOKEN1, MINED,
                                  SOURCE, DEADLINE, block_hash)
from test_deposit_replacement_recovery import FixtureAuth
import test_deposit_store as store_tests
from uniswap_position import UniswapPosition
from token_admission import TokenAdmission

NOW = DEADLINE - 120
KINDS = ('erc20_reset', 'erc20_approval', 'permit2_approval', 'mint')


class LegacyRpc(Rpc):
    def __init__(self, selected, artifact):
        super().__init__(kind=artifact['kind'])
        self.selection, self.artifact = deepcopy(selected), deepcopy(artifact)
        self.token_codes = {}
        tx = artifact['transaction']
        self.transaction.update(to=tx['to'], input=tx['data'], value=hex(int(tx['valueRaw'])),
            nonce=hex(int(tx['nonceRaw'])), gas=hex(int(tx['gasLimitRaw'])),
            maxFeePerGas=hex(int(tx['maxFeePerGasRaw'])),
            maxPriorityFeePerGas=hex(int(tx['maxPriorityFeePerGasRaw'])))
        self.receipt['to'] = tx['to']
        self.receipt['effectiveGasPrice'] = '0x8'
        if artifact['kind'] == 'permit2_approval':
            _, _, amount, expiry = decode(['address', 'address', 'uint160', 'uint48'],
                                          bytes.fromhex(tx['data'][10:]))
            self.receipt['logs'][0]['data'] = '0x' + encode(['uint160', 'uint48'], [amount, expiry]).hex()

    def request(self, method, params=()):
        if method == 'eth_getCode' and params[0] in (TOKEN0, TOKEN1):
            self.calls.append((method, deepcopy(params)))
            value = self.token_codes.get((params[0], params[1]['blockHash']), CODE)
            if isinstance(value, Exception):
                raise value
            return value
        return super().request(method, params)


def pipeline(kind, *, manifest_changes=None):
    """Obtain the artifact from prepare(), never from a forged guard/outcome."""
    manifest = signed_manifest(reviewedAt=NOW-100, expiresAt=NOW+1000,
                               **(manifest_changes or {}))
    rpc, provider = PreparationRpc(), Provider()
    rpc.block.update(timestamp=hex(NOW), hash=block_hash(SOURCE))
    rpc.nonce = rpc.pending = rpc.final_nonce = 5
    rpc.permit = {token: (10_000, NOW+1000, 0) for token in (TOKEN0, TOKEN1)}
    if kind in ('erc20_reset', 'erc20_approval'):
        rpc.erc20[TOKEN1] = 1 if kind == 'erc20_reset' else 0
    elif kind == 'permit2_approval':
        rpc.permit[TOKEN1] = (0, NOW+1000, 0)
    selected = selection()
    clock = lambda: int(rpc.block['timestamp'], 16)
    preparer = DirectDepositPreparer(UniswapPosition(KEY, transport=provider, clock=clock),
        lambda: rpc, admission=manifest, clock=clock)
    artifact = preparer.prepare(OWNER, selected)
    assert artifact['kind'] == kind
    return preparer, LegacyRpc(selected, artifact), manifest


def reconcile(preparer, rpc, **kwargs):
    return ReceiptReconciler(rpc, token_guard=preparer.token_guard).reconcile(
        OWNER, rpc.selection, rpc.artifact, known_hashes=[HASH], **kwargs)


class LegacyAdmissionReceiptTests(unittest.TestCase):
    def test_own_v1_manifest_qualifies_every_prepared_kind_at_both_historical_endpoints(self):
        for kind in KINDS:
            with self.subTest(kind=kind):
                preparer, rpc, manifest = pipeline(kind)
                original = deepcopy(rpc.artifact)
                result = reconcile(preparer, rpc)
                self.assertEqual((result['state'], result['nonceFinalized']), ('confirmed', True))
                self.assertEqual(rpc.artifact, original)
                receipt = result['receipt']
                if kind == 'mint':
                    tokens = receipt['mint']['tokens']
                    self.assertEqual([t['depositedRaw'] for t in tokens], ['100', '200'])
                    self.assertTrue(all(t['basis'] == 'admitted_standard_transfer_events' for t in tokens))
                    reviews = [t['review'] for t in tokens]
                    self.assertEqual(receipt_summary(result)['position']['amount1Raw'], '200')
                else:
                    approval = receipt['approval']
                    self.assertEqual(approval['amountRaw'], '0' if kind == 'erc20_reset' else '202')
                    self.assertEqual(approval['basis'], 'canonical_approval_event')
                    reviews = [approval['review']]
                for review in reviews:
                    self.assertEqual((review['status'], review['reviewId'], review['upgradeable']),
                                     ('matched', manifest['manifestId'], False))
                calls = [params for method, params in rpc.calls if method == 'eth_getCode'
                         and params[0] in (TOKEN0, TOKEN1)]
                currencies = (TOKEN0, TOKEN1) if kind == 'mint' else (TOKEN1,)
                self.assertEqual(calls, [[token, {'blockHash': block_hash(number), 'requireCanonical': True}]
                    for token in currencies for number in (MINED-1, MINED)])

    def test_unknown_manifest_and_unreviewed_currency_never_inherit_current_review(self):
        for change in ('manifest', 'currency'):
            with self.subTest(change=change):
                preparer, rpc, _ = pipeline('erc20_approval')
                if change == 'manifest':
                    rpc.artifact['admission']['manifestId'] = 'f'*64
                else:
                    preparer = DirectDepositPreparer(None, lambda: None,
                        admission=signed_manifest(tokens=[], reviewedAt=NOW-100, expiresAt=NOW+1000),
                        clock=lambda: NOW)
                    rpc.artifact['admission']['manifestId'] = preparer.admission['manifestId']
                result = reconcile(preparer, rpc)
                self.assertEqual((result['state'], result['reason']), ('mismatched', 'token_review_unavailable'))
                self.assertIsNone(result['receipt']['approval']['amountRaw'])

    def test_changed_unavailable_or_malformed_code_at_either_endpoint_never_confirms(self):
        for number in (MINED-1, MINED):
            for code, state, reason in (('0x6001', 'mismatched', 'token_review_changed'),
                    (DataError('rpc_error'), 'pending', 'token_review_unavailable'),
                    ('not-hex', 'pending', 'token_review_unavailable')):
                with self.subTest(number=number, state=state, code=type(code).__name__):
                    preparer, rpc, _ = pipeline('erc20_approval')
                    rpc.token_codes[(TOKEN1, block_hash(number))] = code
                    result = reconcile(preparer, rpc)
                    self.assertEqual((result['state'], result['reason']), (state, reason))
                    self.assertIsNone(result['receipt']['approval']['amountRaw'])
                    self.assertTrue(result['nonceFinalized'])

    def test_receipt_review_is_detached_and_survives_preparation_expiry(self):
        preparer, rpc, manifest = pipeline('erc20_approval')
        # Neither caller edits nor an expired/new active manifest relabel the
        # review bound to an already issued artifact in this process.
        manifest['tokens'][1]['codeHash'] = '0x'+'ff'*32
        preparer.admission['tokens'][1]['codeHash'] = '0x'+'ee'*32
        preparer.clock = lambda: NOW+2000
        self.assertEqual(reconcile(preparer, rpc)['state'], 'confirmed')
        with self.assertRaisesRegex(DepositError, 'deposit_admission_required'):
            preparer.prepare(OWNER, rpc.selection)

    def test_v1_guard_does_not_bypass_approval_event_or_finality_checks(self):
        preparer, rpc, _ = pipeline('erc20_approval')
        rpc.receipt['logs'][0]['data'] = '0x' + encode(['uint256'], [201]).hex()
        self.assertEqual(reconcile(preparer, rpc)['reason'], 'receipt_mismatch')
        preparer, rpc, _ = pipeline('erc20_approval')
        rpc.finalized = MINED-1
        result = reconcile(preparer, rpc)
        self.assertEqual(result['state'], 'pending')
        self.assertFalse(result['nonceFinalized'])
        self.assertEqual(result['receipt']['approval']['amountRaw'], '202')


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires task-local PostgreSQL')
class LegacyAdmissionRecoveryTests(unittest.TestCase):
    def setUp(self):
        store_tests.DepositStoreTests.setUp(self)
        self.now = NOW
        original = _Connection.execute
        def sql_clock(conn, query, params=None):
            result = original(conn, query, params)
            if query == 'SELECT clock_timestamp() AS now':
                return SimpleNamespace(fetchone=lambda: {'now': datetime.fromtimestamp(self.now, timezone.utc)})
            if query == 'SELECT extract(epoch FROM clock_timestamp())<%s AS valid':
                return SimpleNamespace(fetchone=lambda: {'valid': self.now < params[0]})
            return result
        clock = patch.object(_Connection, 'execute', sql_clock)
        clock.start(); self.addCleanup(clock.stop)
        network = patch('urllib.request.OpenerDirector.open', side_effect=AssertionError('External network forbidden'))
        network.start(); self.addCleanup(network.stop)

    def call(self, route, record=None, **body):
        if record:
            body.update(intentId=record['id'], version=record['version'])
        response = self.service.execute(route, body, client='192.0.2.41',
                                        session='fixture-session', csrf='fixture-csrf')
        validate_response(route, response)
        return response

    def start(self, kind):
        self.admin.execute('TRUNCATE domino_deposits.intents')
        self.admin.execute('UPDATE domino_deposits.capacity SET used=0,retained=0')
        self.now = NOW
        self.preparer, self.rpc, _ = pipeline(kind)
        self.service = DepositService(FixtureAuth(), self.store, self.preparer,
            lambda: ReceiptReconciler(self.rpc, token_guard=self.preparer.token_guard), clock=lambda: self.now)
        record = self.call('create', idempotencyKey=str(uuid.uuid4()), selection=self.rpc.selection)['operation']
        issued = self.call('prepare', record)
        self.assertEqual(issued['walletStep'], self.rpc.artifact)
        self.original = deepcopy(self.rpc.artifact)
        self.now += 60  # Receipt recovery outlives the wallet payload's expiry.
        return issued['operation']

    def test_real_preparation_and_receipt_release_owner_without_erasing_issued_history(self):
        for kind in KINDS[:3]:
            for cancel in (False, True):
                with self.subTest(kind=kind, cancel=cancel):
                    record = self.start(kind)
                    if cancel:
                        record = self.call('cancel', record)['operation']
                    response = self.call('report', record, transactionHash=HASH)
                    record = response['operation']
                    self.assertEqual(record['state'], 'cancelled' if cancel else 'draft')
                    self.assertFalse(record['outstanding'])
                    self.assertIsNone(response['walletStep'])
                    self.assertEqual(record['history'][0]['reconciliationState'], 'confirmed')
                    self.assertEqual(record['history'][0]['receipt']['outcome'], 'success')
                    # New store instance proves persisted release and retained
                    # exact artifact/nonce; no synthetic reconciliation result.
                    reopened = DepositStore(self.settings).get(OWNER, record['id'])
                    self.assertEqual(reopened['history'][0]['artifact'], self.original)
                    self.assertFalse(reopened['outstanding'])
                    self.assertEqual(reopened['issued'], self.original)
                    preparation_rpc = self.preparer.rpc_factory()
                    preparation_rpc.block.update(number='0xa0', hash=block_hash(160), timestamp=hex(self.now))
                    preparation_rpc.nonce = preparation_rpc.pending = preparation_rpc.final_nonce = 6
                    next_record = self.call('create', idempotencyKey=str(uuid.uuid4()), selection=self.rpc.selection)['operation']
                    self.assertEqual(self.call('prepare', next_record)['walletStep']['transaction']['nonceRaw'], '6')

    def test_changed_review_reserves_owner_then_same_history_recovers_when_proof_returns(self):
        record = self.start('erc20_approval')
        self.rpc.token_codes[(TOKEN1, block_hash(MINED-1))] = '0x6001'
        record = self.call('report', record, transactionHash=HASH)['operation']
        self.assertEqual((record['state'], record['outstanding']), ('attention', True))
        raw = self.store.get(OWNER, record['id'])
        self.assertEqual(raw['history'][0]['artifact'], self.original)
        self.assertEqual(raw['issued'], self.original)
        draft = self.store.create(OWNER, str(uuid.uuid4()), self.rpc.selection)
        with self.assertRaisesRegex(DepositStoreError, 'deposit_owner_busy'):
            self.store.issue(OWNER, draft['id'], draft['version'], self.original)
        self.rpc.token_codes.clear()
        record = self.call('reconcile', record)['operation']
        self.assertEqual((record['state'], record['outstanding']), ('draft', False))
        raw = self.store.get(OWNER, record['id'])
        self.assertEqual(len(raw['history']), 1)
        self.assertEqual(raw['history'][0]['artifact'], self.original)

    def test_old_unqualified_approval_recovers_with_own_manifest_without_reissuing(self):
        record = self.start('erc20_approval')
        # This is the actual pre-fix guard, not a manufactured store outcome.
        self.service.reconciler_factory = lambda: ReceiptReconciler(self.rpc,
            token_guard=TokenAdmission([]).receipt)
        record = self.call('report', record, transactionHash=HASH)['operation']
        self.assertEqual((record['state'], record['outstanding']), ('attention', True))
        old = self.store.get(OWNER, record['id'])
        self.assertEqual(old['history'][0]['receipt']['approval']['review']['status'], 'legacy_unqualified')
        self.service.reconciler_factory = lambda: ReceiptReconciler(self.rpc,
            token_guard=self.preparer.token_guard)
        record = self.call('reconcile', record)['operation']
        self.assertEqual((record['state'], record['outstanding']), ('draft', False))
        raw = self.store.get(OWNER, record['id'])
        self.assertEqual(len(raw['history']), 1)
        self.assertEqual(raw['history'][0]['artifact'], old['history'][0]['artifact'])
