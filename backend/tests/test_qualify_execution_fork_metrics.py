"""Receipt-derived swap evidence and same-recipe historical corrections."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

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


class FiniteEvidenceTests(unittest.TestCase):
    def test_completed_rows_survive_an_upstream_failure_without_overwriting_history(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'evidence.json'
            report = {'scenarios': []}
            with self.assertRaisesRegex(q.DataError, 'source unavailable'):
                with q.ReportCheckpoint(path, report) as evidence:
                    report['scenarios'].append({'scenario': 'honest', 'outcome': 'executed'})
                    evidence.save()
                    saved = json.loads(path.read_text())
                    self.assertEqual(saved['runStatus'], 'running')
                    self.assertEqual(saved['scenarios'], report['scenarios'])
                    raise q.DataError('source unavailable')
            saved = json.loads(path.read_text())
            self.assertEqual(saved['runStatus'], 'harness-error')
            self.assertEqual(saved['runErrorType'], 'DataError')
            self.assertEqual(saved['scenarios'], report['scenarios'])
            with self.assertRaises(FileExistsError):
                with q.ReportCheckpoint(path, {'scenarios': []}):
                    pass
            self.assertEqual(json.loads(path.read_text()), saved)
            self.assertEqual(list(Path(directory).iterdir()), [path])

    def test_partial_evidence_is_explicit_and_interrupt_keeps_prior_rows(self):
        with tempfile.TemporaryDirectory() as directory:
            for failure, status in ((None, 'partial'), (KeyboardInterrupt(), 'interrupted')):
                path = Path(directory) / (status + '.json')
                report = {'scenarios': [{'outcome': 'harness-error'}]}
                try:
                    with q.ReportCheckpoint(path, report):
                        if failure:
                            raise failure
                except KeyboardInterrupt:
                    pass
                saved = json.loads(path.read_text())
                self.assertEqual(saved['runStatus'], status)
                self.assertEqual(saved['scenarios'], report['scenarios'])
                self.assertIn('finishedAt', saved)

    def test_deadline_and_request_budget_refuse_before_calling_the_fork(self):
        fork = Mock(url='http://127.0.0.1:1')
        with patch.object(q.time, 'monotonic', return_value=100):
            budget = q.ScenarioBudget(fork, 5, max_requests=1)
            budget.request('eth_chainId')
            with self.assertRaisesRegex(q.DataError, '^fork_scenario_request_budget$'):
                budget.request('eth_chainId')
        self.assertEqual(fork.request.call_count, 1)
        with patch.object(q.time, 'monotonic', return_value=105):
            with self.assertRaisesRegex(q.DataError, '^fork_scenario_time_budget$'):
                budget.request('eth_chainId')
        self.assertEqual(fork.request.call_count, 1)

    def test_anchor_mining_uses_the_scenario_rpc_budget(self):
        fork = Mock(url='http://127.0.0.1:1')
        budget = q.ScenarioBudget(fork, 180, max_requests=1)
        budget.mine()
        fork.request.assert_called_once_with('anvil_mine', ['0x1', '0x0'])
        with self.assertRaisesRegex(q.DataError, '^fork_scenario_request_budget$'):
            budget.mine()

    def test_failed_sizing_is_cached_and_other_families_do_not_touch_the_fork(self):
        fork = Mock(url='http://127.0.0.1:1')
        experiment = q.Experiment(fork, 'weth-usdg', 100)
        experiment.spot = Mock(return_value=(q.Q96, 0))
        experiment.price_after = Mock(side_effect=q.DataError('fork_upstream_unavailable'))
        with self.assertRaisesRegex(q.DataError, '^fork_upstream_unavailable$'):
            experiment.amount_for_move(2000)
        with self.assertRaisesRegex(q.DataError, '^fork_move_unavailable_cached:'):
            experiment.run_scenario('post-observation', 2000, False, False, q.Q96, (0, 0))
        self.assertEqual(experiment.price_after.call_count, 1)
        fork.request.assert_not_called()

    def test_expired_budget_does_not_block_rollback_and_original_fork_is_restored(self):
        fork = Mock(url='http://127.0.0.1:1')
        fork.request.return_value = True
        experiment = q.Experiment(fork, 'weth-usdg', 100)
        def fail_scenario(*args):
            experiment.fork.deadline = 0
            experiment.restore('checkpoint')
            experiment.fork.request('eth_chainId')
        experiment._run_scenario = fail_scenario
        with self.assertRaisesRegex(q.DataError, '^fork_scenario_time_budget$'):
            experiment.run_scenario('honest', 0, False, False, q.Q96, (0, 0))
        fork.request.assert_called_once_with('evm_revert', ['checkpoint'])
        self.assertIs(experiment.fork, fork)

    def test_source_failure_still_writes_an_error_report_without_loading_private_config(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'failure.json'
            with patch.object(q, 'ForkReadGateway') as gateway, patch.object(q, 'load_config') as config:
                gateway.return_value.__enter__.return_value.request.side_effect = q.DataError('unavailable')
                with self.assertRaises(q.DataError):
                    q.main(['--public-rpc', '--output', str(path)])
                config.assert_not_called()
            report = json.loads(path.read_text())
            self.assertEqual(report['runStatus'], 'harness-error')
            self.assertEqual(report['scenarios'], [])
            self.assertEqual(report['scenarioBudgetSeconds'], 180)


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
