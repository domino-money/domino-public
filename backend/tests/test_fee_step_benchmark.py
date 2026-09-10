"""Offline instrument/resume checks, including the projected real public window."""
from contextlib import contextmanager
from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from benchmark_fee_steps import (BenchmarkLimit, MAX_CHUNKS, MAX_EVENTS, MAX_INPUT_BYTES, MeasuredBudget,
    WorkLimit, catalogue_input, digest, main, measure, projected, rpc_input, scope)
from catalogue import checked_key
from discovery import DataError
from fee_accounting import MAX_CHUNK_STEPS, replay_fees
from test_discovery import POOL
from test_pool_activity import ActivityRpc, decoded
from test_historical_capacity import churn_logs
from test_position_accounting import reference

ROOT = Path(__file__).resolve().parents[2]
PUBLIC = ROOT/'reports/fee-step-events-2026-09-10.json'
REPORT = ROOT/'reports/fee-step-benchmark-2026-09-10.json'


class FeeStepBenchmarkTests(unittest.TestCase):
    def synthetic(self):
        fixture = reference()
        return {'poolId': POOL, 'poolKey': fixture['poolKey'], 'chunks': [
            {'fromBlock': 10, 'throughBlock': 29, 'events': [e['event'] for e in fixture['sequence']]}]}

    def test_actual_budget_decrements_match_instrumented_steps_without_changing_models(self):
        dataset = self.synthetic();original = deepcopy(dataset)
        budget = [MAX_CHUNK_STEPS]
        expected = replay_fees(None, None, dataset['chunks'][0]['events'], POOL,
                               checked_key(dataset['poolKey'], POOL), budget=budget)
        measured = measure(dataset)
        self.assertEqual(measured['chunks'][0]['candidateStepsAdmitted'], MAX_CHUNK_STEPS-budget[0])
        self.assertEqual((measured['finalActivity'], measured['finalLedger']), expected[:2])
        self.assertTrue(measured['chunks'][0]['resumedEqualsSinglePass'])
        self.assertEqual(dataset, original)

    def test_real_projected_public_window_reproduces_30_steps_and_four_empty_chunks(self):
        dataset, report = json.loads(PUBLIC.read_text()), json.loads(REPORT.read_text())
        result = measure(dataset)
        self.assertEqual(digest(dataset), report['inputSha256'])
        self.assertEqual([c['candidateStepsAdmitted'] for c in result['chunks']], [30, 0, 0, 0, 0])
        self.assertEqual([c['events'] for c in result['chunks']], [10, 0, 0, 0, 0])
        self.assertEqual(result['busiestExaminedChunk']['fromBlock'], 58738261)
        self.assertEqual(result['busiestScope'], 'only_the_examined_historical_chunks')
        self.assertTrue(all(c['resumedEqualsSinglePass'] for c in result['chunks']))
        for chunk in dataset['chunks']:
            for event in chunk['events']:
                self.assertNotIn('transactionHash', event)
                self.assertNotIn('sender', event['payload'])
                self.assertNotIn('salt', event['payload'])

    def test_more_than_32_events_resumes_complete_prefixes_with_identical_result(self):
        dataset = self.synthetic()
        dataset['chunks'][0] = {'fromBlock': 10, 'throughBlock': 11,
                                 'events': [decoded(raw) for raw in churn_logs(40)]}
        result = measure(dataset)['chunks'][0]
        self.assertEqual([b['nextEventOffset'] for b in result['resumeBatches']], [32, 64, 81])
        self.assertTrue(result['resumedEqualsSinglePass'])
        self.assertEqual(result['candidateStepsAdmitted'], 0)

    def test_shared_budget_exhaustion_counts_rejected_attempt_and_resumes_same_event(self):
        dataset = json.loads(PUBLIC.read_text())
        with patch('fee_accounting.MAX_CHUNK_STEPS', 18), patch('benchmark_fee_steps.MAX_CHUNK_STEPS', 18):
            result = measure(dataset)
        first = result['chunks'][0]
        self.assertEqual(first['status'], 'over_budget')
        self.assertEqual(first['exhaustedBound'], 'shared_steps')
        self.assertEqual((first['candidateStepsAdmitted'], first['candidateStepAttempts']), (18, 19))
        self.assertEqual(first['resumeStatus'], 'complete')
        self.assertIsNone(first['resumedEqualsSinglePass'])
        self.assertGreater(len(first['resumeBatches']), 1)
        self.assertEqual(first['outputSha256'], json.loads(REPORT.read_text())['chunks'][0]['outputSha256'])
        for a, b in zip(first['resumeBatches'], first['resumeBatches'][1:]):
            self.assertEqual(a['nextEventOffset'], b['fromEventOffset'])

    def test_single_candidate_limit_is_explicitly_distinct_from_shared_budget(self):
        with patch('fee_accounting.MAX_STEPS', 0):
            result = measure(self.synthetic())
        first = result['chunks'][0]
        self.assertEqual(first['exhaustedBound'], 'candidate_steps')
        self.assertEqual(first['resumeStatus'], 'single_event_over_budget')
        self.assertEqual(first['resumeBatches'][-1]['status'], 'over_budget')
        self.assertEqual(result['status'], 'incomplete')

    def test_global_work_deadline_and_step_stop_escape_candidate_rejection_handler(self):
        with self.assertRaisesRegex(BenchmarkLimit, 'aggregate_step_budget'):
            measure(self.synthetic(), work=WorkLimit(max_steps=1))
        with self.assertRaisesRegex(BenchmarkLimit, 'replay_deadline'):
            measure(self.synthetic(), work=WorkLimit(clock=Mock(side_effect=[0, 31])))
        counter = MeasuredBudget([0], WorkLimit())
        counter[0] -= 1
        self.assertEqual((counter.admitted, counter.attempts), (0, 1))
        with self.assertRaisesRegex(BenchmarkLimit, 'counter_contract_changed'):
            counter[0] -= 2

    def test_event_chunk_order_and_count_budgets_fail_closed(self):
        for mode in ('chunks', 'events', 'ordering'):
            data = self.synthetic()
            if mode == 'chunks':data['chunks'] *= MAX_CHUNKS+1
            if mode == 'events':data['chunks'][0]['events'] *= MAX_EVENTS
            if mode == 'ordering':data['chunks'][0]['events'].reverse()
            with self.subTest(mode=mode), self.assertRaises(DataError):measure(data)

    def test_public_rpc_projection_and_header_recheck_use_only_requested_pool(self):
        rpc = ActivityRpc()
        spec = {'poolId': POOL, 'poolKey': self.synthetic()['poolKey'],
                'chunks': [{'fromBlock': 10, 'throughBlock': 20}]}
        result = rpc_input(rpc, spec)
        self.assertEqual(result['canonicality'], 'boundary_and_event_hashes_rechecked_single_provider')
        self.assertTrue(all('sender' not in e['payload'] for e in result['chunks'][0]['events']))
        rpc = ActivityRpc();rpc.fail_logs = True
        with self.assertRaisesRegex(DataError, 'network_unavailable'):rpc_input(rpc, spec)

    def test_catalogue_reader_never_requests_writer_or_lock_and_requires_recorded_chunk(self):
        seen = []
        conn = Mock();conn.execute.return_value.fetchone.return_value = None
        class Catalogue:
            @contextmanager
            def connection(self, **kwargs):
                seen.append(kwargs)
                yield conn
        with self.assertRaisesRegex(DataError, 'recorded_chunk_missing'):
            catalogue_input(Catalogue(), scope())
        self.assertEqual(seen, [{}])

    def test_cli_fixture_reproduces_report_and_never_claims_fresh_rpc_recheck(self):
        with tempfile.TemporaryDirectory() as folder:
            output = Path(folder)/'report.json'
            self.assertEqual(main(['--source', 'fixture', '--fixture', str(PUBLIC), '--output', str(output)]), 0)
            report = json.loads(output.read_text())
            self.assertEqual(report['busiestExaminedChunk']['candidateStepsAdmitted'], 30)
            self.assertTrue(report['recordedResultMatched'])
            self.assertFalse(report['currentCanonicalityAssessed'])
            self.assertFalse(report['ledgerWritten'])

    def test_unavailable_input_is_null_not_zero_and_provider_path_is_explicit(self):
        for source, expected in (('configured-rpc', 'configured_rpc_required'), ('fixture', 'fee_benchmark_fixture_required')):
            with tempfile.TemporaryDirectory() as folder:
                output = Path(folder)/'report.json'
                self.assertEqual(main(['--source', source, '--output', str(output)]), 1)
                report = json.loads(output.read_text())
                self.assertEqual(report['reason'], expected)
                self.assertIsNone(report['busiestExaminedChunk'])
                self.assertIsNone(report['totalCandidateStepsAdmittedIncludingResume'])
                self.assertIsNone(report['totalStepAttemptsIncludingResume'])
        with tempfile.TemporaryDirectory() as folder:
            output, missing = Path(folder)/'report.json', Path(folder)/'missing.json'
            self.assertEqual(main(['--source', 'fixture', '--fixture', str(missing), '--output', str(output)]), 1)
            report = json.loads(output.read_text())
            self.assertIsNone(report['totalStepAttemptsIncludingResume'])


if __name__ == '__main__':
    unittest.main()
