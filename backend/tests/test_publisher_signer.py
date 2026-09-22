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
from publisher_signer import PublisherPolicy, PublisherSigner, point_record

KEY = bytes([77]) * 32  # published synthetic local test key; never funded remotely
GUARD = address(23)
POINT = (bytes.fromhex(identity(5)[2:]), 100, bytes.fromhex(identity(6)[2:]), 1700000000, 1700000600, 2**96)


class FakeRpc:
    def __init__(self, signer):
        self.publisher, self.head_number, self.balance, self.base = signer, 105, 10**18, 10**9
        self.calls = []

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


class PublisherSignerTests(unittest.TestCase):
    def setUp(self):
        self.policy = PublisherPolicy(400000, 10**10, 10**6, 10**16, 600, enabled=True)
        self.address = Account.from_key(KEY).address.lower()
        self.rpc = FakeRpc(self.address)
        self.signer = PublisherSigner(self.rpc, KEY, GUARD, self.policy)

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


if __name__ == '__main__':
    unittest.main()
