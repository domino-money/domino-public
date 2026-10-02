"""The V2 operator's executor: presimulation, caps, the nonce journal and reconciliation, on a scripted chain."""
import contextlib
import json
import os
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eth_abi import encode
from eth_account import Account
from eth_account.typed_transactions import TypedTransaction
from eth_hash.auto import keccak
from hexbytes import HexBytes

from discovery import Block, DataError
from v2_chains import chain as profile
from v2_manifest import checked_deployment
from v2_executor import (CONTRACT_ERRORS, ERROR_NAMES, CallReverted, ChainExecutor, GasPolicy, Journal, OperatorKey,
                         OperatorRpc, revert_code)
from v2_rpc import ChainEndpoints, Endpoint
from test_v2_manifest import manifest_document

ROOT = Path(__file__).resolve().parents[2]
BASE = profile('base-8453')
KEY = keccak(b'domino.v2.test.executor')
OPERATOR = Account.from_key(KEY).address.lower()
VAULT = '0x' + 'aa' * 20
DATA = '0x' + keccak(b'execute')[:4].hex() + '00' * 64


def selector(signature):
    return '0x' + keccak(signature.encode())[:4].hex()


class FakeChain:
    """A scripted chain: blocks, nonces, a pool, receipts, views and reverts."""

    def __init__(self, deployment):
        self.number, self.timestamp, self.base_fee = 100, 1_790_000_000, 10**8
        self.nonce = 0  # the operator's spent nonce count
        self.pool = {}  # hash -> (raw, decoded)
        self.receipts = {}
        self.balance = 10**18
        self.code = '0x'
        self.call_revert = None
        self.pinned_revert = None  # a revert at the pinned block only (eth_call), not at estimateGas
        self.estimate = 400_000
        self.receipt_from = None
        self.send_fails = False
        self.calls = []
        self.views = {
            (deployment.factory(4), selector('isVault(address)')): lambda data: data[-40:] == VAULT[2:],
            (deployment.factory(3), selector('isVault(address)')): lambda data: False,
            (deployment.registry, selector('isOperator(address)')): lambda data: data[-40:] == OPERATOR[2:],
            (deployment.registry, selector('isPublisher(address)')): lambda data: False,
        }

    def block(self, number=None):
        number = self.number if number is None else number
        return {'number': hex(number), 'hash': '0x' + keccak(b'block%d' % number).hex(),
                'timestamp': hex(self.timestamp - (self.number - number)), 'baseFeePerGas': hex(self.base_fee)}

    def advance(self, blocks=1, seconds=2):
        self.number += blocks
        self.timestamp += seconds * blocks

    def mine(self, *, status=1):
        """Include the pooled transaction with the next nonce."""
        self.advance()
        for digest, (raw, tx) in sorted(self.pool.items(), key=lambda item: item[1][1]['nonce']):
            if tx['nonce'] == self.nonce:
                self.receipts[digest] = {
                    'transactionHash': digest, 'blockNumber': hex(self.number),
                    'blockHash': self.block()['hash'], 'from': self.receipt_from or OPERATOR,
                    'to': '0x' + bytes(tx['to']).hex(),
                    'status': hex(status), 'gasUsed': hex(300_000), 'effectiveGasPrice': hex(self.base_fee + 10**6),
                    'logs': [], 'transactionIndex': '0x0'}
                self.mined_tx = {'hash': digest, 'nonce': hex(tx['nonce']), 'input': '0x' + bytes(tx['data']).hex()}
                self.nonce += 1
                del self.pool[digest]
                return digest
        return None

    def __call__(self, url, body):
        method, params = body['method'], body['params']
        self.calls.append(method)

        def reply(result):
            return {'jsonrpc': '2.0', 'id': body['id'], 'result': result}

        def error(code, message, data=None):
            item = {'code': code, 'message': message}
            if data is not None:
                item['data'] = data
            return {'jsonrpc': '2.0', 'id': body['id'], 'error': item}
        if method == 'eth_getBlockByNumber':
            tag = params[0]
            return reply(self.block(None if tag == 'latest' else int(tag, 16)))
        if method == 'eth_getTransactionCount':
            pending = self.nonce + len([1 for _, tx in self.pool.values() if tx['nonce'] >= self.nonce])
            return reply(hex(pending if params[1] == 'pending' else self.nonce))
        if method == 'eth_getBalance':
            return reply(hex(self.balance))
        if method == 'eth_getCode':
            return reply(self.code)
        if method == 'eth_call':
            call = params[0]
            view = self.views.get((call['to'], call['data'][:10]))
            if view is not None:
                return reply('0x' + encode(['bool'], [view(call['data'])]).hex())
            if self.call_revert is not None:
                return error(3, 'execution reverted', self.call_revert)
            if self.pinned_revert is not None:
                return error(3, 'execution reverted', self.pinned_revert)
            return reply('0x')
        if method == 'eth_estimateGas':
            if self.call_revert is not None:
                return error(3, 'execution reverted', self.call_revert)
            return reply(hex(self.estimate))
        if method == 'eth_sendRawTransaction':
            raw = bytes.fromhex(params[0][2:])
            digest = '0x' + keccak(raw).hex()
            if self.send_fails:
                raise DataError('network_unavailable')
            tx = TypedTransaction.from_bytes(HexBytes(raw)).as_dict()
            if tx['nonce'] < self.nonce:
                return error(-32000, 'nonce too low')
            if any(t['nonce'] == tx['nonce'] for d, (_, t) in self.pool.items() if d != digest):
                # A replacement takes the place of the pooled one.
                self.pool = {d: v for d, v in self.pool.items() if v[1]['nonce'] != tx['nonce']}
            self.pool[digest] = (raw, tx)
            return reply(digest)
        if method == 'eth_getTransactionReceipt':
            return reply(self.receipts.get(params[0]))
        if method == 'eth_getTransactionByHash':
            digest = params[0]
            if digest in self.pool:
                return reply({'hash': digest})
            if digest in self.receipts:
                return reply(self.mined_tx if self.mined_tx['hash'] == digest else None)
            return reply(None)
        raise AssertionError(method)


class ExecutorTestCase(unittest.TestCase):
    def setUp(self):
        document = manifest_document()
        document['roles']['operator'] = OPERATOR
        self.deployment = checked_deployment(document, BASE)
        self.fake = FakeChain(self.deployment)
        endpoint = Endpoint('fake', 'fake.invalid', 'https://fake.invalid/', None, 100, None, None)
        self.monotonic = 1000.0
        self.endpoints = ChainEndpoints(BASE, (endpoint,), 'test', send=self.fake, clock=lambda: self.monotonic)
        self.directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.directory)
        os.chmod(self.directory, 0o700)
        self.policy = GasPolicy(max_gas=1_000_000, max_fee_per_gas=10**10, priority_fee_per_gas=10**6,
                                max_cost_wei=10**16, daily_cap_wei=3 * 10**16, min_balance_wei=10**15, confirmations=2,
                                replace_after_seconds=30, enabled=True)
        self.executor = self.make()

    def make(self, policy=None):
        journal = Journal(self.directory / 'journal.sqlite', 8453, OPERATOR, clock=lambda: self.fake.timestamp)
        self.addCleanup(journal.close)
        return ChainExecutor(BASE, self.deployment, OperatorRpc(self.endpoints), OperatorKey(KEY), journal,
                             policy or self.policy, clock=lambda: self.fake.timestamp)

    def head(self):
        raw = self.fake.block()
        return Block(int(raw['number'], 16), raw['hash'], int(raw['timestamp'], 16))

    def submit(self, *, kind='compound', target=VAULT, data=DATA, deadline=None):
        head = self.head()
        gas, _ = self.executor.presimulate(target, data, head)
        return self.executor.submit(kind=kind, target=target, subject='0x' + '12' * 32, data=data,
                                    deadline=deadline or head.timestamp + 120, head=head, base_fee=self.fake.base_fee,
                                    gas=gas)


class SubmissionTests(ExecutorTestCase):
    def test_a_submission_is_claimed_signed_persisted_then_sent(self):
        outcome = self.submit()
        self.assertEqual(outcome.state, 'submitted')
        intent = self.executor.journal.intent(outcome.intent)
        self.assertEqual((intent['nonce'], intent['gas'], intent['target']), (0, 480_000, VAULT))
        attempt, = intent['attempts']
        raw = bytes(attempt['raw'])
        self.assertEqual(Account.recover_transaction(raw).lower(), OPERATOR)
        decoded = TypedTransaction.from_bytes(HexBytes(raw)).as_dict()
        self.assertEqual((decoded['chainId'], decoded['nonce'], decoded['gas'], decoded['value']), (8453, 0, 480_000, 0))
        self.assertEqual((decoded['maxFeePerGas'], decoded['maxPriorityFeePerGas']), (2 * 10**8 + 10**6, 10**6))
        self.assertEqual('0x' + bytes(decoded['data']).hex(), DATA)
        self.assertIn(attempt['tx_hash'], self.fake.pool)
        # The signed bytes were in the journal before the node saw them.
        calls = self.fake.calls
        self.assertLess(calls.index('eth_estimateGas'), calls.index('eth_sendRawTransaction'))

    def test_one_intent_at_a_time_and_never_a_new_nonce_behind_it(self):
        self.submit()
        with self.assertRaisesRegex(DataError, '^v2_intent_in_flight$'):
            self.submit(data=DATA + 'ff')
        self.fake.mine()
        self.fake.advance(2)
        self.assertEqual(self.executor.reconcile_all()[0].state, 'confirmed')
        second = self.submit(data=DATA + 'ff')
        self.assertEqual(self.executor.journal.intent(second.intent)['nonce'], 1)

    def test_a_presimulated_revert_is_refused_with_the_contracts_error_name(self):
        self.fake.call_revert = selector('StaleNonce()')
        with self.assertRaises(CallReverted) as caught:
            self.submit()
        self.assertEqual(str(caught.exception), 'reverted_stale_nonce')
        self.fake.call_revert = selector('SpotOutsideBand()')
        with self.assertRaisesRegex(DataError, '^reverted_spot_outside_band$'):
            self.submit()
        self.assertEqual(self.executor.journal.unresolved(), [])

    def test_the_call_is_presimulated_at_the_pinned_block_itself(self):
        self.fake.pinned_revert = selector('TooSoon()')  # estimateGas alone would not see it
        with self.assertRaisesRegex(DataError, '^reverted_too_soon$'):
            self.submit()

    def test_a_new_journal_starts_at_the_chains_nonce(self):
        self.fake.nonce = 5
        outcome = self.submit()
        self.assertEqual(self.executor.journal.intent(outcome.intent)['nonce'], 5)

    def test_the_cost_per_transaction_is_capped_even_under_the_gas_and_fee_caps(self):
        policy = GasPolicy(**{**self.policy.__dict__, 'max_cost_wei': 9 * 10**13})
        self.executor = self.make(policy)
        # 480k gas at 2.01e8 is 9.65e13: under maxGas and maxFeePerGas, above maxCostWei.
        with self.assertRaisesRegex(DataError, '^v2_gas_above_cap$'):
            self.submit()

    def test_only_the_deployments_targets_are_sent(self):
        with self.assertRaisesRegex(DataError, '^v2_target_not_admitted$'):
            self.submit(target='0x' + 'ab' * 20)
        with self.assertRaisesRegex(DataError, '^v2_target_not_admitted$'):
            self.submit(kind='exit', target=VAULT)
        self.assertEqual(self.submit(kind='exit', target=self.deployment.auto_exit).state, 'submitted')

    def test_the_caps_hold_before_anything_is_signed(self):
        self.fake.estimate = 900_000  # 1.08M with the margin, above the 1M cap
        with self.assertRaisesRegex(DataError, '^v2_gas_above_cap$'):
            self.submit()
        self.fake.estimate = 400_000
        self.fake.base_fee = 6 * 10**9  # 2x base + tip above the 10 gwei ceiling, but includable
        outcome = self.submit()
        envelope = self.executor.journal.intent(outcome.intent)['envelope']
        self.assertEqual(envelope['maxFeePerGas'], 10**10)
        self.fake.mine()
        self.fake.advance(2)
        self.executor.reconcile_all()
        self.fake.base_fee = 10**10  # not includable under the ceiling: wait
        with self.assertRaisesRegex(DataError, '^v2_gas_price_above_cap$'):
            self.submit(data=DATA + '01')
        self.fake.base_fee = 10**8
        self.fake.balance = 10**14
        with self.assertRaisesRegex(DataError, '^v2_operator_balance_low$'):
            self.submit(data=DATA + '02')

    def test_the_daily_cap_counts_what_was_paid_and_what_is_reserved(self):
        policy = GasPolicy(max_gas=1_000_000, max_fee_per_gas=10**10, priority_fee_per_gas=10**6,
                           max_cost_wei=10**14, daily_cap_wei=2 * 10**14, min_balance_wei=0, confirmations=0,
                           enabled=True)
        self.executor = self.make(policy)
        self.submit()  # reserves 480k × 2.01e8 ≈ 9.6e13
        self.fake.mine()
        self.executor.reconcile_all()  # paid 300k × 1.01e8 ≈ 3.0e13
        self.submit(data=DATA + '01')
        self.fake.mine()
        self.executor.reconcile_all()
        with self.assertRaisesRegex(DataError, '^v2_daily_gas_cap$'):
            for index in range(2, 10):
                self.submit(data=DATA + f'{index:02x}')
                self.fake.mine()
                self.executor.reconcile_all()
        # A day later the window has moved on.
        self.fake.advance(1, 86400)
        self.assertEqual(self.submit(data=DATA + 'ee').state, 'submitted')

    def test_a_disabled_executor_or_a_signer_that_is_not_plain_sends_nothing(self):
        disabled = GasPolicy(**{**self.policy.__dict__, 'enabled': False})
        self.executor = self.make(disabled)
        with self.assertRaisesRegex(DataError, '^v2_executor_disabled$'):
            self.submit()
        head = self.head()
        self.assertEqual(self.executor.check_signer(head), 10**18)
        self.fake.code = '0xef0100' + '11' * 20  # an EIP-7702 delegation on the operator key
        with self.assertRaisesRegex(DataError, '^v2_operator_has_code$'):
            self.executor.check_signer(head)
        self.fake.code = '0x'
        self.fake.views[(self.deployment.registry, selector('isPublisher(address)'))] = lambda data: True
        with self.assertRaisesRegex(DataError, '^v2_operator_not_admitted$'):
            self.executor.check_signer(head)

    def test_the_key_never_prints(self):
        self.assertNotIn(KEY.hex(), repr(OperatorKey(KEY)) + repr(self.executor.key))


class ReconciliationTests(ExecutorTestCase):
    def test_a_receipt_becomes_final_after_the_confirmations(self):
        outcome = self.submit()
        self.fake.mine()
        self.assertEqual(self.executor.reconcile(outcome.intent).state, 'included')
        self.fake.advance(1)
        result = self.executor.reconcile(outcome.intent)
        self.assertEqual(result.state, 'confirmed')
        intent = self.executor.journal.intent(outcome.intent)
        self.assertEqual(int(intent['spent_wei']), 300_000 * (10**8 + 10**6))
        self.assertEqual(json.loads(intent['effect'])['gasUsed'], 300_000)

    def test_a_reverted_receipt_spends_the_nonce_and_releases_the_signer(self):
        outcome = self.submit()
        self.fake.mine(status=0)
        self.fake.advance(2)
        self.assertEqual(self.executor.reconcile(outcome.intent).state, 'reverted')
        self.assertEqual(self.submit(data=DATA + 'aa').state, 'submitted')

    def test_a_lost_transaction_is_resent_as_the_same_bytes_once_the_call_holds(self):
        outcome = self.submit()
        digest = self.executor.journal.intent(outcome.intent)['attempts'][0]['tx_hash']
        self.fake.pool.clear()  # the node dropped it
        self.fake.call_revert = selector('SpotOutsideBand()')
        result = self.executor.reconcile(outcome.intent)
        self.assertTrue(result.reason.startswith('revalidation_pending'))
        self.assertNotIn(digest, self.fake.pool)
        self.fake.call_revert = None
        self.assertEqual(self.executor.reconcile(outcome.intent).reason, 'resent')
        self.assertIn(digest, self.fake.pool)  # the same bytes, the same hash
        self.assertEqual(len(self.executor.journal.intent(outcome.intent)['attempts']), 1)

    def test_past_its_deadline_a_lost_transaction_is_resent_to_spend_its_nonce(self):
        outcome = self.submit(deadline=self.head().timestamp + 10)
        digest = self.executor.journal.intent(outcome.intent)['attempts'][0]['tx_hash']
        self.fake.pool.clear()
        self.fake.call_revert = selector('PlanExpired()')
        self.fake.advance(10, 2)
        self.assertEqual(self.executor.reconcile(outcome.intent).reason, 'resent')
        self.assertIn(digest, self.fake.pool)
        self.fake.mine(status=0)
        self.fake.advance(2)
        self.assertEqual(self.executor.reconcile(outcome.intent).state, 'reverted')

    def test_a_nonce_spent_without_one_of_our_receipts_stops_the_signer_until_acknowledged(self):
        outcome = self.submit()
        self.fake.pool.clear()
        self.fake.nonce = 1  # something else spent nonce 0 with this key
        self.assertEqual(self.executor.reconcile(outcome.intent).state, 'attention')
        with self.assertRaisesRegex(DataError, '^v2_signer_needs_attention$'):
            self.submit(data=DATA + 'bb')
        self.executor.journal.acknowledge(outcome.intent)
        with self.assertRaisesRegex(DataError, '^v2_intent_not_in_attention$'):
            self.executor.journal.acknowledge(outcome.intent)
        second = self.submit(data=DATA + 'bb')
        self.assertEqual(self.executor.journal.intent(second.intent)['nonce'], 1)

    def test_a_stuck_transaction_is_replaced_with_the_same_nonce_and_calldata_at_a_higher_fee(self):
        outcome = self.submit()
        first = self.executor.journal.intent(outcome.intent)['attempts'][0]
        self.assertEqual(self.executor.reconcile(outcome.intent).reason, 'pending')
        self.fake.advance(1, 31)
        self.assertEqual(self.executor.reconcile(outcome.intent).reason, 'replaced')
        intent = self.executor.journal.intent(outcome.intent)
        second = intent['attempts'][1]
        old, new = first['envelope'], second['envelope']
        self.assertEqual({k: v for k, v in old.items() if 'Fee' not in k}, {k: v for k, v in new.items() if 'Fee' not in k})
        self.assertGreaterEqual(new['maxFeePerGas'] * 10_000, old['maxFeePerGas'] * 11_250)
        self.assertGreaterEqual(new['maxPriorityFeePerGas'] * 10_000, old['maxPriorityFeePerGas'] * 11_250)
        self.assertGreaterEqual(int(intent['reserved_wei']), new['gas'] * new['maxFeePerGas'])
        # Whichever attempt the chain includes is the one reconciled.
        self.fake.mine()
        self.fake.advance(2)
        self.assertEqual(self.executor.reconcile(outcome.intent).state, 'confirmed')
        effect = json.loads(self.executor.journal.intent(outcome.intent)['effect'])
        self.assertEqual(effect['transactionHash'], second['tx_hash'])

    def test_replacements_stop_at_the_limit_and_the_ceiling(self):
        outcome = self.submit()
        for _ in range(4):
            self.fake.advance(1, 31)
            self.executor.reconcile(outcome.intent)
        self.assertEqual(len(self.executor.journal.intent(outcome.intent)['attempts']), 3)
        # A bump the fee ceiling would not admit is not sent.
        capped = GasPolicy(**{**self.policy.__dict__, 'max_fee_per_gas': 2 * 10**8 + 10**6})
        self.executor = self.make(capped)
        self.fake.mine()
        self.fake.advance(2)
        self.executor.reconcile_all()
        outcome = self.submit(data=DATA + 'cc')
        self.fake.advance(1, 31)
        self.assertEqual(self.executor.reconcile(outcome.intent).reason, 'pending')
        self.assertEqual(len(self.executor.journal.intent(outcome.intent)['attempts']), 1)

    def test_a_replacement_stays_inside_the_daily_cap(self):
        # A first execution paid 3.03e13. The second reserves 9.65e13 (1.27e14 in all, inside a 1.3e14 cap);
        # its bump would reserve 1.09e14 (1.39e14 in all): over the cap, though under the cost per transaction.
        policy = GasPolicy(**{**self.policy.__dict__, 'max_cost_wei': 13 * 10**13, 'daily_cap_wei': 13 * 10**13,
                              'confirmations': 0})
        self.executor = self.make(policy)
        self.submit()
        self.fake.mine()
        self.assertEqual(self.executor.reconcile_all()[0].state, 'confirmed')
        outcome = self.submit(data=DATA + 'dd')
        self.fake.advance(1, 31)
        self.assertEqual(self.executor.reconcile(outcome.intent).reason, 'pending')
        self.assertEqual(len(self.executor.journal.intent(outcome.intent)['attempts']), 1)

    def test_a_receipt_that_is_not_ours_stops_the_signer(self):
        outcome = self.submit()
        self.fake.receipt_from = '0x' + 'ee' * 20
        self.fake.mine()
        self.fake.advance(2)
        self.assertEqual(self.executor.reconcile(outcome.intent).state, 'attention')
        self.assertEqual(self.executor.journal.intent(outcome.intent)['reason'], 'receipt_identity_mismatch')

    def test_an_ambiguous_broadcast_is_reconciled_from_the_chain(self):
        self.fake.send_fails = True
        outcome = self.submit()
        self.assertEqual((outcome.state, outcome.reason), ('broadcast_unknown', 'broadcast_ambiguous'))
        self.fake.send_fails = False
        self.monotonic += 2  # the endpoint's cooldown after the network failure
        # Not in the pool and not mined: sent again, the same bytes.
        self.assertEqual(self.executor.reconcile(outcome.intent).reason, 'resent')
        self.fake.mine()
        self.fake.advance(2)
        self.assertEqual(self.executor.reconcile(outcome.intent).state, 'confirmed')

    def test_a_claim_that_crashed_before_signing_signs_the_same_envelope_again(self):
        head = self.head()
        journal = self.executor.journal
        identifier = journal.claim(kind='compound', target=VAULT, subject='0x' + '12' * 32, data=DATA,
                                   deadline=head.timestamp + 120, gas=480_000, max_fee=2 * 10**8, priority=10**6,
                                   chain_counts=[0, 0], daily_cap=10**18)
        self.assertEqual(journal.intent(identifier)['state'], 'signing')
        expected = '0x' + keccak(OperatorKey(KEY).sign(journal.intent(identifier)['envelope'])[0]).hex()
        restarted = self.make()
        restarted.reconcile(identifier)
        attempt, = restarted.journal.intent(identifier)['attempts']
        self.assertEqual(attempt['tx_hash'], expected)
        self.assertIn(expected, self.fake.pool)

    def test_the_journal_is_private_and_durable(self):
        journal_path = self.directory / 'journal.sqlite'
        self.submit()
        self.assertEqual(oct(os.stat(journal_path).st_mode & 0o777), '0o600')
        with contextlib.closing(sqlite3.connect(journal_path)) as db:  # sqlite3's own `with` never closes
            self.assertEqual(db.execute('PRAGMA journal_mode').fetchone()[0], 'wal')
            self.assertEqual(db.execute('SELECT count(*) FROM attempts').fetchone()[0], 1)
        open_directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, open_directory)
        os.chmod(open_directory, 0o755)
        with self.assertRaisesRegex(DataError, '^v2_journal_directory_not_private$'):
            Journal(open_directory / 'journal.sqlite', 8453, OPERATOR)


class BindingTests(ExecutorTestCase):
    def test_the_key_must_be_the_manifests_operator(self):
        deployment = checked_deployment(manifest_document(), BASE)  # another operator
        journal = Journal(self.directory / 'other.sqlite', 8453, OPERATOR)
        self.addCleanup(journal.close)
        with self.assertRaisesRegex(DataError, '^v2_operator_not_in_deployment$'):
            ChainExecutor(BASE, deployment, OperatorRpc(self.endpoints), OperatorKey(KEY), journal, self.policy)


class WaitingTests(ExecutorTestCase):
    def test_the_last_presimulation_revert_stays_until_one_passes(self):
        journal = self.executor.journal
        vault, mandate = '0x' + 'a1' * 20, '0x' + '5a' * 32
        journal.record_waiting([('vault', vault, 'gas_not_covered', None),
                                ('mandate', mandate, 'reverted_automation_unavailable', 'reverted')], at=100, block=10)
        journal.record_waiting([('vault', vault, 'reverted_spot_outside_band', 'reverted'),
                                ('mandate', mandate, 'trigger_not_reached', None)], at=200, block=20)
        waiting = journal.waiting()
        self.assertEqual(waiting['vaults'][vault], {'reason': 'reverted_spot_outside_band', 'at': 200, 'block': 20,
                                                    'lastRevert': {'code': 'reverted_spot_outside_band', 'at': 200,
                                                                   'block': 20}})
        # The mandate's revert is still the last one, with its own time.
        self.assertEqual(waiting['mandates'][mandate], {'reason': 'trigger_not_reached', 'at': 200, 'block': 20,
                                                        'lastRevert': {'code': 'reverted_automation_unavailable',
                                                                       'at': 100, 'block': 10}})
        journal.record_waiting([('vault', vault, 'eligible', 'passed')], at=300, block=30)
        self.assertIsNone(journal.waiting()['vaults'][vault]['lastRevert'])
        journal.record_waiting([('vault', vault, 'Some provider text!', None)], at=400, block=40)
        self.assertEqual(journal.waiting()['vaults'][vault]['reason'], 'unrecognized_reason')
        with self.assertRaisesRegex(DataError, '^v2_waiting_invalid$'):
            journal.record_waiting([('pool', vault, 'eligible', None)], at=1, block=1)


class PolicyTests(unittest.TestCase):
    def test_a_policy_out_of_bounds_is_refused(self):
        base = dict(max_gas=1_000_000, max_fee_per_gas=10**10, priority_fee_per_gas=10**6, max_cost_wei=10**16,
                    daily_cap_wei=10**17, min_balance_wei=0)
        GasPolicy(**base)
        for change in ({'priority_fee_per_gas': 10**11}, {'max_cost_wei': 10**18}, {'max_gas': 0},
                       {'confirmations': -1}, {'bump_bps': 999}, {'enabled': 1}, {'max_replacements': 6}):
            with self.subTest(change), self.assertRaisesRegex(DataError, '^v2_invalid_gas_policy$'):
                GasPolicy(**{**base, **change})


class RevertCodeTests(unittest.TestCase):
    def test_every_known_error_is_declared_in_the_v2_sources(self):
        declared = set()
        for path in (ROOT / 'contracts/src/v2').rglob('*.sol'):
            for name, args in re.findall(r'error (\w+)\(([^)]*)\)', path.read_text()):
                types = ','.join(part.strip().split(' ')[0] for part in args.split(',') if part.strip())
                declared.add(f'{name}({types})')
        self.assertEqual(sorted(set(CONTRACT_ERRORS) - declared), [])
        self.assertEqual(len(set(CONTRACT_ERRORS)), len(CONTRACT_ERRORS))

    def test_codes_are_recordable_and_never_echo_the_node(self):
        for code in [*ERROR_NAMES.values()]:
            self.assertRegex('reverted_' + code, r'^[a-z0-9_]{1,100}$')
        self.assertEqual(revert_code(selector('TooSoon()')), 'reverted_too_soon')
        self.assertEqual(revert_code(selector('InsufficientLiquidity(uint128,uint128)') + '00' * 64),
                         'reverted_insufficient_liquidity')
        self.assertEqual(revert_code('0x08c379a0' + '00' * 96), 'reverted_error_string')
        self.assertEqual(revert_code('0x'), 'reverted_without_data')
        self.assertEqual(revert_code('0x12345678'), 'reverted_unknown_12345678')
        self.assertEqual(revert_code('not hex'), 'reverted_unknown')


if __name__ == '__main__':
    unittest.main()
