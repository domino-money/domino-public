"""The publisher's key boundary, offline: one call, one guard, rebuilt before signing."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eth_abi import encode
from eth_account import Account
from eth_hash.auto import keccak

from automation_fixtures import address, identity, selector
from automation_plan import observation_id, publish_calldata
from execution_signer import ExecutionError, verify_signed
from publisher_signer import PublicationJournal, PublisherPolicy, PublisherSigner, point_record

KEY = bytes([77]) * 32  # published synthetic local test key; never funded remotely
GUARD = address(23)
POINT = (bytes.fromhex(identity(5)[2:]), 100, bytes.fromhex(identity(6)[2:]), 1700000000, 1700000600, 2**96)


class FakeRpc:
    def __init__(self, signer):
        self.publisher, self.head_number, self.balance, self.base = signer, 105, 10**18, 10**9
        self.calls = []
        self.code = {}

    def request(self, method, params):
        self.calls.append((method, params))
        if method == 'eth_chainId':
            return '0x1237'
        if method == 'eth_getBlockByNumber':
            number = self.head_number if params[0] == 'latest' else int(params[0], 16)
            return {'number': hex(number), 'hash': identity(number) if number != 100 else identity(6), 'timestamp': hex(1700000000 + number - 100),
                    'baseFeePerGas': hex(self.base)}
        if method == 'eth_getBalance':
            return hex(self.balance)
        if method == 'eth_getCode':
            self.assertion_block = params[1]
            return self.code.get(params[0], '0x')
        if method == 'eth_estimateGas':
            return hex(150000)
        if method == 'eth_getTransactionCount':
            return '0x5'
        if method == 'eth_call':
            data = bytes.fromhex(params[0]['data'][2:])
            if data[:4] == selector('publisher()'):
                return '0x' + encode(['address'], [self.publisher]).hex()
            if data[:4] == selector('observations(bytes32)'):
                return '0x' + encode(['bytes32', 'uint64', 'bytes32', 'uint64', 'uint64', 'uint160'], [b'\x00' * 32, 0, b'\x00' * 32, 0, 0, 0]).hex()
            if data[:4] == selector('revoked(bytes32)'):
                return '0x' + encode(['bool'], [False]).hex()
            if data[:4] == selector('publish((bytes32,uint64,bytes32,uint64,uint64,uint160))'):
                return '0x' + encode(['bytes32'], [bytes.fromhex(observation_id(GUARD, POINT)[2:])]).hex()
        raise AssertionError(method)


class LateMiningRpc(FakeRpc):
    """A node that answers the receipt read of the publication at nonce 5 with
    nothing and then mines it into block 106, as 100 ms blocks allow."""
    def __init__(self, signer, *, spent_by_105):
        super().__init__(signer)
        self.spent = {105: spent_by_105, 106: 6}

    def request(self, method, params):
        if method == 'eth_getTransactionReceipt':
            self.calls.append((method, params))
            self.head_number = 106
            return None
        if method == 'eth_getTransactionCount':
            self.calls.append((method, params))
            number = self.head_number if params[1] == 'latest' else next(
                n for n in self.spent if params[1] == {'blockHash': identity(n), 'requireCanonical': True})
            return hex(self.spent[number])
        return super().request(method, params)


class SyntheticReservation:
    def __init__(self):
        self.calls = []

    def require_reservation(self, *args):
        self.calls.append(args)


class PublisherSignerTests(unittest.TestCase):
    def setUp(self):
        self.policy = PublisherPolicy(400000, 10**10, 10**6, 10**16, 600, enabled=True)
        self.address = Account.from_key(KEY).address.lower()
        self.rpc = FakeRpc(self.address)
        self.budget = SyntheticReservation()
        self.signer = PublisherSigner(self.rpc, KEY, GUARD, self.policy,
                                      gas_budget=self.budget)

    def test_policy_and_point_shapes_are_checked(self):
        with self.assertRaises(ExecutionError):
            PublisherPolicy(400000, 10, 11, 10**16, 600)
        with self.assertRaises(ExecutionError):
            PublisherPolicy(400000, 10**10, 10**6, 10**16, 3601)
        record = point_record(POINT)
        self.assertEqual(record['blockNumber'], 100)
        for bad in ((b'\x00' * 32, *POINT[1:]), (*POINT[:4], POINT[3], POINT[5]), (*POINT[:5], 0)):
            with self.assertRaises(ExecutionError):
                point_record(bad)

    def test_qualify_binds_publisher_window_and_simulated_id(self):
        identifier, head = self.signer.qualify(POINT, max_source_age=200)
        self.assertEqual(identifier, observation_id(GUARD, POINT))
        self.assertEqual(head['number'], 105)
        self.rpc.publisher = address(99)
        with self.assertRaisesRegex(ExecutionError, 'publisher_not_current'):
            self.signer.qualify(POINT, max_source_age=200)
        self.rpc.publisher = self.address
        self.rpc.head_number = 400
        with self.assertRaisesRegex(ExecutionError, 'publisher_source_window'):
            self.signer.qualify(POINT, max_source_age=200)
        self.rpc.head_number = 100
        with self.assertRaisesRegex(ExecutionError, 'publisher_source_window'):
            self.signer.qualify(POINT, max_source_age=200)
        disabled = PublisherSigner(self.rpc, KEY, GUARD, PublisherPolicy(400000, 10**10, 10**6, 10**16, 600))
        with self.assertRaisesRegex(ExecutionError, 'publisher_disabled'):
            disabled.qualify(POINT, max_source_age=200)

    def test_a_publisher_account_carrying_code_publishes_nothing(self):
        # An EIP-7702 designator on the publisher's own account means its key
        # signed an authorization; the account itself is read at the head.
        self.rpc.code[self.address] = '0xef0100' + 'ab' * 20
        with self.assertRaisesRegex(ExecutionError, '^publisher_account_has_code$'):
            self.signer.qualify(POINT, max_source_age=200)
        self.assertEqual(self.rpc.assertion_block, {'blockHash': identity(105), 'requireCanonical': True})
        self.assertNotIn('eth_estimateGas', [method for method, _ in self.rpc.calls])
        self.rpc.code[self.address] = '0x'
        self.assertEqual(self.signer.qualify(POINT, max_source_age=200)[0], observation_id(GUARD, POINT))

    def test_envelope_is_the_registered_call_under_the_caps(self):
        envelope = self.signer.envelope(POINT, 5)
        self.assertEqual((envelope['to'], envelope['chainId'], envelope['type'], envelope['value'], envelope['gas']), (GUARD, 4663, 2, 0, 400000))
        self.assertEqual(envelope['data'], publish_calldata(POINT))
        self.assertEqual(envelope['maxFeePerGas'], 2 * 10**9 + 10**6)
        self.rpc.balance = 1
        with self.assertRaisesRegex(ExecutionError, 'execution_gas_balance'):
            self.signer.envelope(POINT, 5)
        self.rpc.balance = 10**18
        with self.assertRaisesRegex(ExecutionError, 'execution_gas_budget'):
            self.signer.envelope(POINT, 5, fee=10**11)
        tight = PublisherSigner(self.rpc, KEY, GUARD, PublisherPolicy(400000, 10**10, 10**6, 10**9, 600, enabled=True))
        with self.assertRaisesRegex(ExecutionError, 'execution_gas_budget'):
            tight.envelope(POINT, 5)

    def test_sign_rebuilds_from_the_point_and_refuses_a_handed_envelope(self):
        envelope = self.signer.envelope(POINT, 5)
        raw, digest = self.signer.sign(POINT, envelope)
        self.assertEqual(self.budget.calls[0],
                         (observation_id(GUARD, POINT), 'publisher', self.address,
                          envelope['gas'] * envelope['maxFeePerGas']))
        self.assertEqual(Account.recover_transaction(raw).lower(), self.address)
        self.assertEqual('0x' + keccak(raw).hex(), digest)
        verify_signed(raw, envelope, self.address, digest)
        for change in ({'to': address(24)}, {'value': 1}, {'data': envelope['data'][:10] + 'ff' + envelope['data'][12:]}, {'gas': 400001}):
            with self.subTest(change=change), self.assertRaisesRegex(ExecutionError, 'execution_envelope_changed'):
                self.signer.sign(POINT, {**envelope, **change})
        other = (*POINT[:5], 2**96 + 1)
        with self.assertRaisesRegex(ExecutionError, 'execution_envelope_changed'):
            self.signer.sign(other, envelope)
        # The nonce is the journal's claim, carried through the envelope, not a restricted field.
        raw, _ = self.signer.sign(POINT, self.signer.envelope(POINT, 6))
        self.assertEqual(Account.recover_transaction(raw).lower(), self.address)

    def test_missing_or_denied_shared_reservation_blocks_signature(self):
        envelope = self.signer.envelope(POINT, 5)
        without = PublisherSigner(self.rpc, KEY, GUARD, self.policy)
        with self.assertRaisesRegex(ExecutionError, 'publisher_gas_reservation_required'):
            without.sign(POINT, envelope)
        self.budget.require_reservation = lambda *args: (_ for _ in ()).throw(ValueError('denied'))
        with self.assertRaisesRegex(ExecutionError, 'publisher_gas_reservation_required'):
            self.signer.sign(POINT, envelope)

    def test_legacy_signed_publication_cannot_resend_without_counted_claim(self):
        envelope = self.signer.envelope(POINT, 5)
        raw, digest = self.signer.sign(POINT, envelope)
        identifier = observation_id(GUARD, POINT)
        row = {'state': 'signed', 'envelope': envelope, 'signer': self.address,
               'signed_bytes': raw, 'transaction_hash': digest}
        journal = object.__new__(PublicationJournal)
        journal._transaction = lambda operation: operation(None)
        journal._row = lambda conn, key, lock=False: row
        journal._status = lambda value: value
        journal.gas_budget = None
        with self.assertRaisesRegex(ExecutionError, 'publisher_gas_reservation_required'):
            journal.send(identifier, self.rpc)
        self.assertFalse(any(method == 'eth_sendRawTransaction' for method, _ in self.rpc.calls))

        class DeniedClaim:
            def require_existing_reservation(self, *_):
                raise ValueError('claim missing')

        journal.gas_budget = DeniedClaim()
        with self.assertRaisesRegex(ExecutionError, 'publisher_gas_reservation_required'):
            journal.send(identifier, self.rpc)
        self.assertFalse(any(method == 'eth_sendRawTransaction' for method, _ in self.rpc.calls))

    def checked(self, rpc):
        """Check a submitted publication at nonce 5, whose point expires far
        ahead, through a stand-in for its locked row. Returns (state, reason)."""
        row = {'state': 'submitted', 'reason': '', 'signer': self.address, 'nonce': 5,
               'transaction_hash': identity(9), 'expires_at': 1800000000}

        class LockedRow:
            def execute(self, query, args):
                assert query.startswith('UPDATE publications SET state=%s,reason=%s,')
                row.update(state=args[0], reason=args[1])
                return self

            def fetchone(self):
                return row
        journal = object.__new__(PublicationJournal)
        journal._transaction = lambda operation: operation(LockedRow())
        journal._row = lambda conn, key, lock=False: dict(row)
        journal._status = lambda value: (value['state'], value['reason'])
        return journal.check(observation_id(GUARD, POINT), rpc, confirmations=2)

    def test_a_publication_mined_after_its_receipt_read_keeps_its_nonce(self):
        rpc = LateMiningRpc(self.address, spent_by_105=5)
        # Nonce 5 is still unspent at the head read before the receipt; the
        # latest block, 106, already holds this very publication.
        self.assertEqual(self.checked(rpc), ('submitted', ''))
        self.assertEqual([params for method, params in rpc.calls if method == 'eth_getTransactionCount'],
                         [[self.address, {'blockHash': identity(105), 'requireCanonical': True}]])

    def test_a_nonce_spent_by_the_head_without_a_receipt_needs_attention(self):
        rpc = LateMiningRpc(self.address, spent_by_105=6)
        self.assertEqual(self.checked(rpc), ('attention', 'publication_nonce_consumed_without_receipt'))


if __name__ == '__main__':
    unittest.main()
