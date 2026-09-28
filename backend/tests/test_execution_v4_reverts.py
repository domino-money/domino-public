"""A V4 call the chain reverted is reported by the contract's own error."""
from pathlib import Path
import re
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_hash.auto import keccak

from automation_store import _reason
from execution_runner import receipt_read_failed
from execution_signer import ExecutionError
from execution_v4 import CONTRACT_ERRORS, ReceiptReconciler, revert_code

SOURCES = Path(__file__).resolve().parents[2] / 'contracts' / 'src'


def declared_errors():
    found = set()
    for source in sorted(SOURCES.glob('*.sol')):
        for name, params in re.findall(r'\berror\s+(\w+)\s*\(([^)]*)\)\s*;', source.read_text()):
            types = [param.split()[0] for param in params.split(',') if param.strip()]
            found.add('%s(%s)' % (name, ','.join(types)))
    return found


class Answering:
    def __init__(self, error):
        self.error = error

    def request(self, method, params):
        raise self.error


def reverted(selector):
    error = ExecutionError('execution_call_reverted')
    error.revert = selector
    return error


class RevertNamingTests(unittest.TestCase):
    def test_the_error_list_is_every_error_the_contracts_declare(self):
        self.assertEqual(set(CONTRACT_ERRORS), declared_errors())
        self.assertEqual(len(CONTRACT_ERRORS), len(set(CONTRACT_ERRORS)))

    def test_a_revert_is_named_by_its_contract_error(self):
        self.assertEqual('0x' + keccak(b'InvalidAmount()')[:4].hex(), '0x2c5211c6')
        self.assertEqual(revert_code('0x2c5211c6'), 'v4_call_reverted_invalid_amount')
        self.assertEqual(revert_code('0x' + keccak(b'UnexpectedOwnerNonce(uint256,uint256)')[:4].hex()),
                         'v4_call_reverted_unexpected_owner_nonce')
        self.assertEqual(revert_code('0x' + keccak(b'InvalidL2BlockContext()')[:4].hex()),
                         'v4_call_reverted_invalid_l2_block_context')
        self.assertEqual(revert_code('0x12345678'), 'v4_call_reverted_0x12345678')
        self.assertEqual(revert_code('0x'), 'v4_call_reverted_empty')

    def test_every_revert_code_is_a_reason_a_cycle_can_record(self):
        # The cycle store keeps reasons in [a-z0-9_] of at most 100 characters.
        # Codes carrying the contracts' CamelCase names were refused: a reverted
        # qualification could not be recorded, and its cycle stayed open.
        selectors = ['0x' + keccak(error.encode())[:4].hex() for error in CONTRACT_ERRORS]
        for revert in (*selectors, '0x12345678', '0x'):
            code = revert_code(revert)
            for prefix in ('qualify_', 'step_'):
                with self.subTest(code=code, prefix=prefix):
                    self.assertEqual(_reason((prefix + code)[:100]), prefix + code)

    def test_the_verifier_tells_a_revert_from_an_unreachable_node(self):
        # 27 September 2026: eight qualifications reverted InvalidAmount and were
        # recorded as qualify_v4_rpc_unavailable.
        for error, code in ((reverted('0x2c5211c6'), 'v4_call_reverted_invalid_amount'),
                            (ExecutionError('execution_rpc_unavailable'), 'v4_rpc_unavailable'),
                            (ExecutionError('execution_call_reverted'), 'v4_rpc_unavailable'),
                            (OSError('reset'), 'v4_rpc_unavailable')):
            with self.subTest(code=code), self.assertRaisesRegex(ValueError, '^%s$' % code):
                ReceiptReconciler(Answering(error))._request('eth_call', [{}, 'latest'])

    def test_a_reverted_read_while_reconciling_a_receipt_is_still_retried(self):
        # Named or not, a read the chain reverted leaves the receipt pending, as
        # it did while every revert was reported as an unavailable node.
        pending = ('included', 'execution_receipt_pending')
        self.assertEqual(receipt_read_failed('v4_rpc_unavailable'), pending)
        self.assertEqual(receipt_read_failed('v4_call_reverted_invalid_amount'), pending)
        self.assertEqual(receipt_read_failed('v4_call_reverted_0x12345678'), pending)
        self.assertEqual(receipt_read_failed('v4_receipt_mismatch'), ('attention', 'execution_receipt_unqualified'))


if __name__ == '__main__':
    unittest.main()
