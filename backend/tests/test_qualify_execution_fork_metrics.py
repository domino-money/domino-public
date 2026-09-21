"""Receipt-derived swap evidence and same-recipe historical corrections."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

from eth_abi import encode

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import qualify_execution_fork as q


ENGINE, VAULT = '0x' + 'ee' * 20, '0x' + 'dd' * 20
C0, C1 = '0x' + 'a0' * 20, '0x' + 'b0' * 20
INTENT, SOURCE = '0x' + '22' * 32, '0x' + '11' * 32


def event(signature, types, values, index=4):
    return {'address': ENGINE, 'topics': [signature, '0x' + encode(['address'], [VAULT]).hex(), INTENT, SOURCE],
        'data': '0x' + encode(types, values).hex(), 'logIndex': hex(index)}


def conversion(amount_out=90):
    return event(q.v.CONVERTED, ['address', 'address', 'uint128', 'uint128', q.g.AMOUNTS_TYPE, 'uint128', 'uint128'],
        [C0, C1, 100, amount_out, (1000, 0, 0, 102, 0, 2, 100, 898, 0), 0, amount_out])


def scenario(name='swap-post-observation', after='1050', output=None):
    value = {'scenario': name, 'swap': name.startswith('swap-'), 'outcome': 'executed',
        'vaultValueAfterQuote': after, 'attackerPnlQuote': '-5', 'swapIn0': '100',
        'sqrtPriceAtCompound': str(q.Q96), 'anchorSqrtPrice': str(q.Q96)}
    if output is not None:
        value['swapExecution'] = {'status': 'measured', 'amountInRaw': '100', 'amountOutRaw': str(output)}
    return value


class ReceiptMetricsTests(unittest.TestCase):
    def test_output_comes_from_conversion_and_liquidity_from_applied_events(self):
        applied = event(q.v.APPLIED, ['address', 'uint256', q.g.AMOUNTS_TYPE],
            [C0, 1, (898, 0, 0, 51, 0, 1, 50, 847, 0)], index=5)
        amounts, conversions = q.receipt_metrics({'logs': [conversion(87), applied]}, ENGINE, VAULT, INTENT, (C0, C1))
        self.assertEqual(amounts, (50, 0))
        self.assertEqual(conversions[0]['amountOutRaw'], '87')
        self.assertEqual(conversions[0]['serviceFeeInputRaw'], '2')
        self.assertEqual(conversions[0]['receiptLogIndex'], 4)

    def test_identity_duplicates_and_noncanonical_trailing_data_are_rejected(self):
        bad_intent = conversion(); bad_intent['topics'][2] = SOURCE
        bad_encoding = conversion(); bad_encoding['data'] += '00' * 32
        for logs in ([bad_intent], [conversion(), conversion()], [bad_encoding]):
            with self.assertRaises(q.DataError):
                q.receipt_metrics({'logs': logs}, ENGINE, VAULT, INTENT, (C0, C1))

    def test_unrelated_emitter_is_not_a_swap_receipt(self):
        unrelated = conversion(); unrelated['address'] = VAULT
        amounts, conversions = q.receipt_metrics({'logs': [unrelated]}, ENGINE, VAULT, INTENT, (C0, C1))
        self.assertEqual(amounts, (0, 0))
        self.assertEqual(conversions, [])


class EconomicMetricsTests(unittest.TestCase):
    def controls(self):
        return {'honest': scenario('honest', '1000'), 'swap-honest': scenario('swap-honest', '1100', 90)}

    def test_swap_uses_its_own_control_and_actual_output_at_unchanged_anchor(self):
        metrics = q.scenario_metrics(scenario(output=70), self.controls(), q.Q96)
        self.assertEqual(metrics['controlScenario'], 'swap-honest')
        self.assertEqual(metrics['vaultValueDeltaVersusControlQuote'], '-50')
        self.assertEqual(metrics['swapShortfallQuote'], '30')
        self.assertEqual(metrics['swapOutputDeltaVersusControlQuote'], '-20')
        self.assertEqual(metrics['preSwapSpotQuoteDifference'], '0')
        self.assertEqual(metrics['attackerPoolCostQuote'], '5')

    def test_missing_outputs_are_unavailable_and_missing_control_never_falls_back(self):
        metrics = q.scenario_metrics(scenario(), {'honest': self.controls()['honest']}, q.Q96)
        self.assertEqual(metrics['comparisonStatus'], 'unavailable')
        self.assertEqual(metrics['swapShortfallStatus'], 'unavailable_missing_conversion_receipt')
        self.assertNotIn('swapShortfallQuote', metrics)
        self.assertNotIn('vaultValueDeltaVersusControlQuote', metrics)

    def test_different_swap_amounts_do_not_claim_an_output_control_comparison(self):
        controls = self.controls()
        controls['swap-honest']['swapExecution']['amountInRaw'] = '99'
        metrics = q.scenario_metrics(scenario(output=70), controls, q.Q96)
        self.assertEqual(metrics['swapOutputComparisonStatus'], 'unavailable_or_different_input_amount')
        self.assertNotIn('swapOutputDeltaVersusControlQuote', metrics)

    def test_historical_recompute_preserves_input_and_marks_missing_receipts(self):
        row = scenario(); row['lossVersusHonestQuote'] = '-50'; row['breakevenCompoundedQuote'] = '500000000'
        report = {'referenceSqrtPrice': str(q.Q96), 'scenarios': [*self.controls().values(), row]}
        original = deepcopy(report)
        corrected = q.correct_historical_report(report)
        self.assertEqual(report, original)
        result = corrected['scenarios'][-1]
        self.assertEqual(result['vaultValueDeltaVersusControlQuote'], '-50')
        self.assertEqual(result['supersededMetrics']['lossVersusHonestQuote'], '-50')
        self.assertEqual(result['swapExecution']['status'], 'unavailable')
        self.assertNotIn('breakevenCompoundedQuote', result)
        self.assertNotIn('swapShortfallQuote', result)


class ArtifactProvenanceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = 'DominoExecutionEngineV4.sol'
        self.name = 'DominoExecutionEngineV4'
        self.target = 'src/' + self.source
        self.source_path = self.root / 'contracts' / self.target
        self.source_path.parent.mkdir(parents=True)
        self.source_bytes = b'// synthetic artifact provenance fixture\npragma solidity 0.8.26;\n'
        self.source_path.write_bytes(self.source_bytes)
        self.artifact = {'metadata': {'compiler': {'version': '0.8.26+commit.8a97fa7a'},
            'settings': {'compilationTarget': {self.target: self.name}, 'optimizer': {'enabled': True, 'runs': 200},
                'viaIR': True, 'evmVersion': 'cancun', 'metadata': {'bytecodeHash': 'none'}},
            'sources': {self.target: {'keccak256': '0x' + q.keccak(self.source_bytes).hex()}}},
            'bytecode': {'object': '0x60006000', 'linkReferences': {}},
            'deployedBytecode': {'object': '0x6000', 'linkReferences': {}}}
        self.artifact_path = self.root / 'contracts/out' / self.source / (self.name + '.json')
        self.artifact_path.parent.mkdir(parents=True)
        self.write_artifact()

    def write_artifact(self):
        self.artifact_path.write_text(json.dumps(self.artifact))

    def test_provenance_binds_exact_source_artifact_and_both_bytecodes(self):
        artifact, provenance, sources = q.load_fork_artifact(self.root, self.source, self.name)
        self.assertEqual(artifact, self.artifact)
        self.assertEqual(provenance['artifactSha256'], hashlib.sha256(self.artifact_path.read_bytes()).hexdigest())
        self.assertEqual(sources[self.target]['sha256'], hashlib.sha256(self.source_bytes).hexdigest())
        self.assertEqual(provenance['creationCodeHash'], '0x' + q.keccak(bytes.fromhex('60006000')).hex())
        self.assertEqual(provenance['runtimeTemplateHash'], '0x' + q.keccak(bytes.fromhex('6000')).hex())

    def test_stale_artifact_rejected_when_source_bytes_change(self):
        self.source_path.write_bytes(self.source_bytes + b'// source changed after compilation\n')
        with self.assertRaisesRegex(q.DataError, '^fork_artifact_source_changed$'):
            q.load_fork_artifact(self.root, self.source, self.name)

    def test_wrong_profile_and_unsafe_source_fail_closed(self):
        self.artifact['metadata']['settings']['viaIR'] = False
        self.write_artifact()
        with self.assertRaisesRegex(q.DataError, '^fork_artifact_profile_mismatch$'):
            q.load_fork_artifact(self.root, self.source, self.name)
        self.artifact['metadata']['settings']['viaIR'] = True
        self.artifact['metadata']['sources']['src/../outside.sol'] = {'keccak256': '0x' + '00' * 32}
        self.write_artifact()
        with self.assertRaisesRegex(q.DataError, '^fork_artifact_unsafe_source$'):
            q.load_fork_artifact(self.root, self.source, self.name)


if __name__ == '__main__':
    unittest.main()
