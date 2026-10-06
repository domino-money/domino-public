"""Known unpublished work must fit the unchanged public contract, never qualify it."""
from copy import deepcopy
import json
from pathlib import Path
import subprocess
import sys
import unittest

from unittest.mock import patch

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import activity_store
from read_api import create_app, ReadGate
from read_contract import validate_response
from read_service import ReadService, public_response
from historical_read import require_incomplete_capital, require_incomplete_positions
from discovery import CHAIN_ID, POOL_MANAGER, DataError

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'api-contracts/read-v1/fixtures/producer'
# PgActivity.read for featured USDG/ORBIO on production, 6 Oct 2026 12:49 UTC,
# read-only as domino_catalogue_reader with the deployed reader's own code.
ORBIO = Path(__file__).resolve().parent / 'fixtures/pool-activity-usdg-orbio-2026-10-06.json'


def fixture(name):
    return json.loads((FIXTURES / name).read_text())


def diagnostic(reason=None, *, proof=False):
    action = 'resume_same_command'
    if reason in {'core_position_budget_exhausted', 'core_tick_budget_exhausted'}:
        action = 'select_extended_profile_and_resume'
    elif reason in {'fee_step_budget_exhausted', 'historical_work_byte_budget_exhausted'}:
        action = 'capacity_review_required'
    elif reason == 'historical_work_method_mismatch':
        action = 'repair_source_then_resume'
    elif reason is not None:
        action = 'repair_source_then_resume'
    return {'status': 'blocked' if reason else 'in_progress', 'reason': reason,
            'capacityProfile': 'standard', 'fromBlock': 10, 'throughBlock': 700,
            'processedEvents': 20 if proof else 2, 'totalEvents': 20,
            'phase': 'reconciliation' if proof else 'replay',
            'completedChecks': 2 if proof else 0, 'requiredChecks': 10 if proof else None,
            'limits': {'positions': 128, 'ticks': 256, 'eventsPerBatch': 32,
                       'checksPerBatch': 128, 'progressBytes': 8388608}, 'action': action}


def pending(ledger, reason=None):
    missing = fixture('pool-activity.unavailable.json')
    value = missing if ledger == 'fee' else fixture('pool-activity.success.json')
    if ledger == 'position':
        value['liquidity']['positionAccounting'] = deepcopy(missing['liquidity']['positionAccounting'])
    accounting = value['fees']['accounting'] if ledger == 'fee' else value['liquidity']['positionAccounting']
    accounting['historicalWork'] = diagnostic(reason, proof=ledger == 'position')
    if reason is not None:
        accounting['reason'] = reason
        if ledger == 'fee': value['window24h']['lpFeesReason'] = reason
    return value


class ReportReader:
    def __init__(self, report): self.report = report

    @public_response('pool-activity')
    def pool_activity(self, pool_id): return self.report

    @public_response('pool-positions')
    def pool_positions(self, pool_id):
        report = self.pool_activity(pool_id)
        return {'schemaVersion': 1, 'mode': 'core_pool_positions_read_only',
                **{k: report[k] for k in ('chainId', 'poolId', 'poolKey', 'snapshot', 'coverage', 'freshness')},
                'positionAccounting': report['liquidity']['positionAccounting'], 'executionAvailable': False}


class HistoricalReadProjectionTests(unittest.TestCase):
    def http(self, report, route='pool-activity'):
        reader = ReportReader(report)
        with TestClient(create_app(reader, gate=ReadGate(interval=0)), base_url='http://127.0.0.1:8876') as client:
            return client.post('/v1/read/' + route, json={'poolId': report['poolId']})

    def test_operational_states_preserve_raw_evidence_snapshot_revision_and_qualified_values(self):
        cases = [None, 'fee_step_budget_exhausted', 'historical_work_byte_budget_exhausted',
                 'historical_work_method_mismatch']
        for ledger in ('fee', 'position'):
            reasons = cases + (['core_position_budget_exhausted', 'core_tick_budget_exhausted']
                               if ledger == 'position' else [])
            if ledger == 'position': reasons.append('reconciled_fee_chunk_required')
            for reason in reasons:
                with self.subTest(ledger=ledger, reason=reason):
                    raw = pending(ledger, reason); before = deepcopy(raw)
                    response = self.http(raw)
                    self.assertEqual(response.status_code, 200, response.text)
                    result = response.json(); validate_response('pool-activity', result)
                    self.assertEqual(raw, before)
                    for field in ('snapshot', 'revision', 'coverage', 'freshness'):
                        self.assertEqual(result[field], raw[field])
                    accounting = result['fees']['accounting'] if ledger == 'fee' else result['liquidity']['positionAccounting']
                    self.assertEqual(accounting['reason'], ledger + '_ledger_not_caught_up')
                    self.assertNotIn('historicalWork', accounting)
                    if ledger == 'fee':
                        self.assertIsNone(result['window24h']['lpFeesRaw'])
                        self.assertEqual(result['window24h']['lpFeesReason'], 'fee_ledger_not_caught_up')
                    else:
                        self.assertEqual(result['fees'], raw['fees'])
                        self.assertEqual(result['window24h'], raw['window24h'])
                        self.assertIsNone(accounting['lpAssetsRaw'])

    def test_public_position_route_and_shared_consumer_accept_projected_null_state(self):
        raw = pending('position', 'reconciled_fee_chunk_required')
        result = self.http(raw, 'pool-positions')
        self.assertEqual(result.status_code, 200, result.text)
        validate_response('pool-positions', result.json())
        self.assertIsNone(result.json()['positionAccounting']['lpAssetsRaw'])
        script = "import {assertResponse} from './api-contracts/read-v1/runtime.mjs';" \
                 "let raw='';for await (const part of process.stdin) raw+=part;" \
                 "const p=JSON.parse(raw);assertResponse('pool-positions',p);" \
                 "if(p.positionAccounting.lpAssetsRaw!==null) process.exit(1);"
        run = subprocess.run(['node', '--input-type=module', '-e', script], cwd=ROOT,
                             input=result.text, text=True, capture_output=True)
        self.assertEqual(run.returncode, 0, run.stderr)

    def test_reviewed_restart_accepts_both_worker_generations_without_weakening_mismatch_checks(self):
        for ledger in ('fee', 'position'):
            for action in ('repair_source_then_resume', 'restart_unpublished_work_after_review'):
                with self.subTest(ledger=ledger, action=action):
                    raw = pending(ledger, 'historical_work_method_mismatch')
                    accounting = raw['fees']['accounting'] if ledger == 'fee' else raw['liquidity']['positionAccounting']
                    accounting['historicalWork']['action'] = action
                    before = deepcopy(raw)
                    self.assertEqual(self.http(raw).status_code, 200)
                    self.assertEqual(raw, before)
                    for reason in ('historical_work_source_mismatch', 'historical_work_checkpoint_mismatch'):
                        bad = pending(ledger, reason)
                        detail = bad['fees']['accounting'] if ledger == 'fee' else bad['liquidity']['positionAccounting']
                        detail['historicalWork']['action'] = action
                        self.assertEqual(self.http(bad).status_code, 502)

    def test_activity_capacity_block_is_null_with_only_the_explicit_review_action(self):
        reason = 'activity_range_budget_exhausted'
        action = 'review_activity_capacity_profile_then_resume'
        for ledger in ('fee', 'position'):
            raw = pending(ledger, reason)
            accounting = raw['fees']['accounting'] if ledger == 'fee' else raw['liquidity']['positionAccounting']
            accounting['historicalWork']['action'] = action
            before = deepcopy(raw)
            for route in ('pool-activity', 'pool-positions') if ledger == 'position' else ('pool-activity',):
                response = self.http(raw, route)
                self.assertEqual(response.status_code, 200, response.text)
                validate_response(route, response.json())
            self.assertEqual(raw, before)
            for wrong in ('repair_source_then_resume', 'resume_same_command', 'select_extended_profile_and_resume'):
                accounting['historicalWork']['action'] = wrong
                self.assertEqual(self.http(raw).status_code, 502)
        work = diagnostic(reason, proof=True)
        work['action'] = action
        before = deepcopy(work)
        self.assertEqual(require_incomplete_capital(work, {'number': 700}), reason)
        self.assertEqual(work, before)
        work['action'] = 'resume_same_command'
        with self.assertRaisesRegex(DataError, 'upstream_contract_mismatch'):
            require_incomplete_capital(work, {'number': 700})

    def test_failed_sources_remain_safe_errors_instead_of_ordinary_incomplete_history(self):
        cases = [('network_unavailable', 503, 'network_unavailable'),
                 ('rpc_error', 503, 'rpc_error'), ('block_unavailable', 503, 'block_unavailable'),
                 ('request_budget_exhausted', 503, 'request_budget_exhausted'),
                 ('catalogue_database_unavailable', 503, 'catalogue_database_unavailable'),
                 ('read_deadline_exceeded', 504, 'read_deadline_exceeded'),
                 ('http_429', 503, 'upstream_unavailable'), ('http_503', 503, 'upstream_unavailable')]
        for ledger in ('fee', 'position'):
            for reason, status, code in cases:
                with self.subTest(ledger=ledger, reason=reason):
                    raw = pending(ledger, reason); before = deepcopy(raw)
                    routes = ('pool-activity', 'pool-positions') if ledger == 'position' else ('pool-activity',)
                    for route in routes:
                        response = self.http(raw, route)
                        self.assertEqual((response.status_code, response.json()), (status, {'error': code}))
                    self.assertEqual(raw, before)
        self.assertEqual(self.http(pending('fee', 'reconciled_fee_chunk_required')).status_code, 502)

    def test_smaller_batch_budgets_and_extended_capacity_remain_bounded(self):
        raw = pending('position', 'core_position_budget_exhausted')
        work = raw['liquidity']['positionAccounting']['historicalWork']
        work['capacityProfile'] = 'extended'; work['action'] = 'capacity_review_required'
        work['limits'].update(positions=1024, ticks=2048, eventsPerBatch=2, checksPerBatch=1)
        self.assertEqual(self.http(raw).status_code, 200)
        for field, value in [('eventsPerBatch', 33), ('eventsPerBatch', 0), ('checksPerBatch', 129),
                             ('checksPerBatch', False), ('positions', 1025), ('progressBytes', 8388609)]:
            changed = deepcopy(raw)
            changed['liquidity']['positionAccounting']['historicalWork']['limits'][field] = value
            self.assertEqual(self.http(changed).status_code, 502)

    def test_completed_and_adapter_required_reports_are_unchanged(self):
        for raw in (fixture('pool-activity.success.json'), fixture('pool-activity.unavailable.json')):
            self.assertEqual(self.http(raw).json(), raw)
        raw = fixture('pool-activity.unavailable.json')
        raw['fees']['accounting']['reason'] = raw['window24h']['lpFeesReason'] = 'fee_accounting_adapter_required'
        raw['liquidity']['positionAccounting']['reason'] = 'position_accounting_adapter_required'
        self.assertEqual(self.http(raw).json(), raw)

    def test_corruption_reorg_and_unknown_reasons_are_errors(self):
        for ledger in ('fee', 'position'):
            for reason in ('historical_work_source_mismatch', 'historical_work_checkpoint_mismatch',
                           'historical_work_version_mismatch', 'core_tick_state_reconciliation_failed',
                           'position_activity_reorg_requires_replay', 'stored_fee_ledger_mismatch',
                           'arbitrary_provider_text'):
                with self.subTest(ledger=ledger, reason=reason):
                    response = self.http(pending(ledger, reason))
                    self.assertEqual((response.status_code, response.json()),
                                     (502, {'error': 'upstream_contract_mismatch'}))

    def test_malformed_or_completed_diagnostics_cannot_hide_invalid_state(self):
        changes = [{'status': 'complete'}, {'status': 'blocked'}, {'reason': []}, {'action': 'ignore'},
                   {'capacityProfile': 'unlimited'}, {'fromBlock': True}, {'throughBlock': 701},
                   {'processedEvents': True}, {'processedEvents': 21}, {'totalEvents': '20'},
                   {'completedChecks': 1}, {'requiredChecks': 0}, {'phase': 'unknown'},
                   {'unknown': True}, {'limits': {'positions': 128}}]
        for change in changes:
            with self.subTest(change=change):
                raw = pending('fee'); raw['fees']['accounting']['historicalWork'].update(change)
                self.assertEqual(self.http(raw).status_code, 502)
        raw = pending('position'); raw['liquidity']['positionAccounting']['historicalWork']['completedChecks'] = 10
        self.assertEqual(self.http(raw).status_code, 502)

    def test_nonnull_amounts_unknown_fields_or_inconsistent_window_are_not_repaired(self):
        self.assertEqual(self.http(pending('fee', 'core_position_budget_exhausted')).status_code, 502)
        for field, value in [('lpFeesRaw', ['0', '0']), ('donationsRaw', ['1', '2']),
                             ('unexpected', None), ('status', 'reconciled_as_of')]:
            raw = pending('fee'); raw['fees']['accounting'][field] = value
            self.assertEqual(self.http(raw).status_code, 502)
        for field, value in [('lpFeesRaw', ['0', '0']), ('protocolFeesRaw', ['0', '0']),
                             ('lpFeesReason', 'unknown')]:
            raw = pending('fee'); raw['window24h'][field] = value
            self.assertEqual(self.http(raw).status_code, 502)
        raw = pending('fee'); del raw['fees']['accounting']['historicalWork']
        raw['fees']['accounting']['reason'] = 'network_unavailable'
        self.assertEqual(self.http(raw).status_code, 502)


class StoredHeadRpc:
    """The node behind a stored read: the snapshot's own header and a head after it."""
    batch_reads = False

    def __init__(self, snapshot, *, behind=300, age=30):
        self.stored = {'number': hex(snapshot['number']), 'hash': snapshot['hash'],
                       'timestamp': hex(snapshot['timestamp'])}
        self.head = {'number': hex(snapshot['number'] + behind), 'hash': '0x' + 'cd' * 32,
                     'timestamp': hex(snapshot['timestamp'] + age)}

    def request(self, method, params=()):
        if method == 'eth_chainId': return hex(CHAIN_ID)
        if method == 'eth_getCode': return '0x6000'
        if method == 'eth_getBlockByNumber' and params[0] in ('latest', self.head['number']):
            return dict(self.head)
        if method == 'eth_getBlockByNumber' and params[0] == self.stored['number']:
            return dict(self.stored)
        raise AssertionError((method, params))

    def call(self, target, signature, inputs=(), values=(), outputs=(), *, block):
        if signature == 'poolManager()': return (POOL_MANAGER,)
        raise AssertionError(signature)


class OversizedSourceChunkTests(unittest.TestCase):
    """USDG/ORBIO's real stored read: its fee ledger refused a source chunk over 2,000 events.

    Every read of that featured pool answered 502 upstream_contract_mismatch:
    the projection knew no `fee_event_budget_exhausted`, so a documented
    capacity state was treated as corruption (6 Oct 2026). The stored window,
    snapshot and revision are exact and served; only the fee and position
    ledgers stay null, as for any ledger behind its activity.
    """
    def setUp(self):
        self.stored = json.loads(ORBIO.read_text())

    def service(self, stored):
        snapshot = stored['snapshot']
        service = ReadService(catalogue=object(), market_cache=object(), snapshot=object(),
                              rpc_factory=lambda: StoredHeadRpc(snapshot), transport_factory=lambda: None,
                              clock=lambda: snapshot['timestamp'] + 30)
        return service

    def http(self, stored, route='pool-activity'):
        def read(store, pool_id, *, include_positions=False):
            self.assertEqual(pool_id, stored['poolId'])
            return deepcopy(stored)
        app = create_app(self.service(stored), gate=ReadGate(interval=0), snapshot_refresh_seconds=0)
        with patch.object(activity_store.PgActivity, 'read', read), \
                TestClient(app, base_url='http://127.0.0.1:8876') as client:
            return client.post('/v1/read/' + route, json={'poolId': stored['poolId']})

    @staticmethod
    def work(report, ledger):
        accounting = (report['fees']['accounting'] if ledger == 'fee' else
                      report['liquidity']['positionAccounting'])
        return accounting, accounting['historicalWork']

    def test_the_real_stored_read_is_served_with_null_ledgers_and_its_exact_window(self):
        self.assertEqual(self.work(self.stored, 'fee')[1]['reason'], 'fee_event_budget_exhausted')
        before = deepcopy(self.stored)
        response = self.http(self.stored)
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        validate_response('pool-activity', result)
        self.assertEqual(self.stored, before)
        for field in ('poolId', 'snapshot', 'revision', 'storedEventCount'):
            self.assertEqual(result[field], self.stored[field])
        self.assertEqual(result['poolKey'], {**self.stored['poolKey'], 'feeMode': 'fixed'})
        fees = result['fees']['accounting']
        self.assertEqual((fees['status'], fees['reason']), ('unavailable', 'fee_ledger_not_caught_up'))
        self.assertNotIn('historicalWork', fees)
        positions = result['liquidity']['positionAccounting']
        self.assertEqual((positions['status'], positions['reason']), ('unavailable', 'position_ledger_not_caught_up'))
        self.assertNotIn('historicalWork', positions)
        window = result['window24h']
        self.assertEqual((window['lpFeesRaw'], window['lpFeesReason']), (None, 'fee_ledger_not_caught_up'))
        self.assertEqual((window['swapEventCount'], window['swapLegsRaw']),
                         (2951, self.stored['window24h']['swapLegsRaw']))
        self.assertEqual(result['coverage']['canonicality'], 'block_hash_rechecked')
        self.assertTrue(window['usableAsCurrent24h'])
        positions_route = self.http(self.stored, 'pool-positions')
        self.assertEqual(positions_route.status_code, 200, positions_route.text)
        validate_response('pool-positions', positions_route.json())
        self.assertEqual(positions_route.json()['positionAccounting']['reason'], 'position_ledger_not_caught_up')

    def test_each_ledger_projects_only_its_own_oversized_source_refusal(self):
        own = {'fee': 'fee_event_budget_exhausted', 'position': 'position_event_budget_exhausted'}
        for ledger, reason in own.items():
            for other in ('fee_event_budget_exhausted', 'position_event_budget_exhausted',
                          'capital_event_budget_exhausted'):
                with self.subTest(ledger=ledger, reason=other):
                    report = deepcopy(self.stored)
                    accounting, work = self.work(report, ledger)
                    accounting['reason'] = work['reason'] = other
                    if ledger == 'fee': report['window24h']['lpFeesReason'] = other
                    response = self.http(report)
                    self.assertEqual(response.status_code, 200 if other == reason else 502, response.text)
        work = dict(self.work(self.stored, 'fee')[1], reason='capital_event_budget_exhausted')
        self.assertEqual(require_incomplete_capital(work, self.stored['snapshot']), 'capital_event_budget_exhausted')
        for reason in ('fee_event_budget_exhausted', 'position_event_budget_exhausted'):
            with self.assertRaisesRegex(DataError, 'upstream_contract_mismatch'):
                require_incomplete_capital(dict(work, reason=reason), self.stored['snapshot'])
        positions = deepcopy(self.stored['liquidity']['positionAccounting'])
        positions['reason'] = positions['historicalWork']['reason'] = 'position_event_budget_exhausted'
        require_incomplete_positions(positions, self.stored['snapshot'])

    def test_the_refusal_keeps_its_recorded_action_and_shape(self):
        for change in ({'action': 'capacity_review_required'}, {'action': 'resume_same_command'},
                       {'status': 'in_progress'}, {'processedEvents': 2001}, {'phase': 'reconciliation'}):
            with self.subTest(change=change):
                report = deepcopy(self.stored)
                self.work(report, 'fee')[1].update(change)
                self.assertEqual(self.http(report).status_code, 502)


if __name__ == '__main__': unittest.main()
