"""The V4 operator's key boundary refuses an unreserved envelope."""
from pathlib import Path
import sys
import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_signer import ExecutionError, RestrictedSigner, SignerPolicy


class Rpc:
    def request(self, method, params):
        if method == 'eth_getBlockByNumber':
            return {'baseFeePerGas': '0x1'}
        if method == 'eth_getBalance':
            return hex(10**18)
        raise AssertionError(method)


class OperatorGasGateTests(unittest.TestCase):
    def signer(self, budget):
        signer = object.__new__(RestrictedSigner)
        signer.rpc = Rpc()
        signer.address = '0x' + '11' * 20
        signer.action = 'typed_fee_execution_v4'
        signer.policy = SignerPolicy(100000, 10**9, 1, 10**14, enabled=True)
        signer.gas_budget = budget
        signer.qualify = Mock(return_value=(SimpleNamespace(calldata=lambda: '0x1234'), {}))
        return signer

    def test_exact_envelope_cost_and_intent_are_authorized(self):
        intent = '0x' + '22' * 32
        plan = SimpleNamespace(intent_id=lambda: intent, maxGasCostWei='100000000000000',
            sequence=SimpleNamespace(vault='0x' + '33' * 20))
        budget = Mock()
        with patch('execution_signer._model', return_value=plan):
            signer = self.signer(None)
            with self.assertRaisesRegex(ExecutionError, 'execution_gas_reservation_required'):
                signer.envelope({'plan': {}, 'observation': {}}, 7)
            signer = self.signer(budget)
            envelope = signer.envelope({'plan': {}, 'observation': {}}, 7)
            budget.reserve_one.assert_called_once_with(
                intent, 'operator', signer.address,
                envelope['gas'] * envelope['maxFeePerGas'])
            budget.require_reservation.assert_called_once_with(
                intent, 'operator', signer.address,
                envelope['gas'] * envelope['maxFeePerGas'])
            budget.require_existing_reservation.reset_mock()
            signer.envelope({'plan': {}, 'observation': {}}, 7, existing_signed=True)
            budget.require_existing_reservation.assert_called_once_with(
                intent, 'operator', signer.address,
                envelope['gas'] * envelope['maxFeePerGas'])
            budget.reserve_one.assert_called_once()
            budget.require_reservation.side_effect = ValueError('denied')
            with self.assertRaisesRegex(ExecutionError, 'execution_gas_reservation_required'):
                signer.envelope({'plan': {}, 'observation': {}}, 7)


if __name__ == '__main__':
    unittest.main()
