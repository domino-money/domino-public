"""Current producer failures retain their meaning across the disabled read boundary."""
from copy import deepcopy
import json
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]
from fastapi.testclient import TestClient
from read_api import create_app, ReadGate
from read_contract import validate_response
from read_service import public_response
from read_history_fixtures import history_service, Rows
from historical_capacity import diagnostic, PROFILES
from catalogue_indexer import IndexRpc
from discovery import DataError, STATE_VIEW
from test_discovery import POOL
from test_historical_read_projection import pending

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / 'api-contracts/read-v1/fixtures'


class ReadReconciliationTests(unittest.TestCase):
    def test_classified_indexer_rpc_failures_keep_503_through_real_historical_readers(self):
        # The actual indexer transport classifier supplies the persisted reason.
        # Only RPC envelopes and database rows are synthetic: ledger readers,
        # metrics dependencies, public projection and the HTTP boundary are real.
        failures = [('out of gas', -32000, 'rpc_call_gas_limit'),
                    ('execution reverted', 3, 'rpc_call_reverted')]
        paths = [('fee', 'pool-activity'), ('position', 'pool-activity'),
                 ('position', 'pool-positions'), ('position', 'pool-metrics'),
                 ('capital', 'pool-metrics')]
        for message, code, expected in failures:
            def transport(url, body):
                return {'jsonrpc': '2.0', 'id': body['id'],
                        'error': {'code': code, 'message': message}}
            rpc = IndexRpc(transport=transport)
            with self.assertRaises(DataError) as failure:
                rpc.call(STATE_VIEW, 'getLiquidity(bytes32)', ['bytes32'],
                         [bytes.fromhex(POOL[2:])], ['uint128'], block=hex(700))
            self.assertEqual(str(failure.exception), expected)
            self.assertEqual(rpc.count, 1)
            for ledger, route in paths:
                with self.subTest(reason=expected, ledger=ledger, route=route), \
                        history_service() as (reader, database):
                    work = diagnostic(database.tail, PROFILES['standard'],
                                      {'offset': 2, 'totalEvents': 20}, str(failure.exception))
                    before = deepcopy(work); execute = database.execute; observed = []
                    def failed_work(query, params=()):
                        q = ' '.join(query.split())
                        if q.startswith('SELECT diagnostic FROM domino_activity.historical_work'):
                            observed.append(params)
                            return Rows([{'diagnostic': deepcopy(work)}] if params == (POOL, ledger) else [])
                        if ledger in ('fee', 'position') and q.startswith(
                                'SELECT * FROM domino_activity.' + ledger + '_chunks'):
                            return Rows([])
                        if ledger == 'fee' and q.startswith('SELECT * FROM domino_activity.position_chunks'):
                            # A position ledger cannot be qualified without its fee dependency.
                            return Rows([])
                        if ledger == 'capital' and q.startswith('SELECT count(*) AS chunks'):
                            return Rows([{'chunks': 1, 'qualified': 0}])
                        return execute(query, params)
                    with patch.object(database, 'execute', side_effect=failed_work), \
                            TestClient(create_app(reader, gate=ReadGate(interval=0)),
                                       base_url='http://127.0.0.1:8876') as client:
                        response = client.post('/v1/read/' + route, json={'poolId': POOL})
                    self.assertIn((POOL, ledger), observed)
                    self.assertEqual((response.status_code, response.json()),
                                     (503, {'error': expected}))
                    self.assertEqual(work, before)

    def test_unknown_producer_reasons_fail_closed_and_known_transport_failures_stay_available(self):
        for route, filename, path in [
                ('token', 'token.unavailable.json', ('asset', 'reason')),
                ('pools', 'pools.provider-unavailable.json', ('discovery', 'reason')),
                ('wallet-assets', 'wallet-assets.provider-unavailable.json', ('inventory', 'reason'))]:
            raw = json.loads((FIXTURES / 'producer' / filename).read_text())
            body = json.loads((FIXTURES / 'requests' / (route + '.json')).read_text())
            for reason, expected in [('new_producer_code', None), ('private provider text', None),
                                     ([], None), ({}, None), ('http_999', None),
                                     ('network_unavailable', 'network_unavailable'),
                                     ('http_429', 'provider_rate_limited'),
                                     ('http_503', 'upstream_unavailable')]:
                with self.subTest(route=route, reason=reason):
                    value = deepcopy(raw); value[path[0]][path[1]] = reason
                    before = deepcopy(value)
                    reader = SimpleNamespace(**{route.replace('-', '_'): public_response(route)(lambda *a, **k: value)})
                    with TestClient(create_app(reader, gate=ReadGate(interval=0)), base_url='http://127.0.0.1:8876') as client:
                        response = client.post('/v1/read/' + route, json=body)
                    if expected is None:
                        self.assertEqual((response.status_code, response.json()), (502, {'error': 'upstream_contract_mismatch'}))
                    else:
                        self.assertEqual(response.status_code, 200, response.text)
                        validate_response(route, response.json())
                        self.assertEqual(response.json()[path[0]][path[1]], expected)
                    self.assertEqual(value, before)

    def test_capital_read_does_not_hide_failed_position_work_as_missing_history(self):
        cases = [(None, 200, None), ('reconciled_fee_chunk_required', 200, None),
                 ('core_position_budget_exhausted', 200, None),
                 ('network_unavailable', 503, 'network_unavailable'),
                 ('rpc_error', 503, 'rpc_error'),
                 ('catalogue_database_unavailable', 503, 'catalogue_database_unavailable'),
                 ('read_deadline_exceeded', 504, 'read_deadline_exceeded'),
                 ('historical_work_checkpoint_mismatch', 502, 'upstream_contract_mismatch'),
                 ('position_activity_reorg_requires_replay', 502, 'upstream_contract_mismatch')]
        for reason, status, code in cases:
            with self.subTest(reason=reason), history_service() as (reader, _):
                raw = pending('position', reason)['liquidity']['positionAccounting']; before = deepcopy(raw)
                with patch('capital_store.read_positions', return_value=raw), \
                        TestClient(create_app(reader, gate=ReadGate(interval=0)), base_url='http://127.0.0.1:8876') as client:
                    response = client.post('/v1/read/pool-metrics', json={'poolId': POOL})
                self.assertEqual(response.status_code, status, response.text)
                self.assertEqual(raw, before)
                if code:
                    self.assertEqual(response.json(), {'error': code})
                else:
                    payload = response.json(); validate_response('pool-metrics', payload)
                    self.assertEqual(payload['capital']['reason'], 'reconciled_position_tail_required')
                    self.assertIsNone(payload['capital']['current'])
                    self.assertIsNone(payload['valuation']['feeAprPercent'])
                    self.assertFalse(payload['usableAsCurrent24h'])
                    self.assertEqual(payload['coverage']['canonicality'], 'block_hash_rechecked')

    def test_saved_capital_work_is_checked_before_reporting_ordinary_lag(self):
        cases = [(None, 200, None), ('core_position_budget_exhausted', 200, None),
                 ('core_tick_budget_exhausted', 200, None),
                 ('reconciled_position_tail_required', 200, None),
                 ('network_unavailable', 503, 'network_unavailable'),
                 ('read_deadline_exceeded', 504, 'read_deadline_exceeded'),
                 ('catalogue_database_unavailable', 503, 'catalogue_database_unavailable'),
                 ('capital_work_source_mismatch', 502, 'upstream_contract_mismatch'),
                 ('capital_work_checkpoint_mismatch', 502, 'upstream_contract_mismatch'),
                 ('capital_activity_reorg_requires_replay', 502, 'upstream_contract_mismatch')]
        cases += [('reconciled_position_chunk_required', 200, None)]
        for reason, status, code in cases:
            for version in ([None, 1, 2] if reason == 'reconciled_position_chunk_required' else [None]):
                with self.subTest(reason=reason, version=version), history_service() as (reader, database):
                    work = diagnostic(database.tail, PROFILES['standard'], {'offset': 2, 'totalEvents': 20}, reason)
                    before = deepcopy(work); execute = database.execute; queries = []
                    def pending_capital(query, params=()):
                        q = ' '.join(query.split()); queries.append((q, params))
                        if q.startswith('SELECT count(*) AS chunks'):
                            return Rows([{'chunks': 1, 'qualified': 0}])
                        if q.startswith('SELECT diagnostic FROM domino_activity.historical_work'):
                            self.assertEqual(params, (POOL, 'capital'))
                            return Rows([{'diagnostic': deepcopy(work)}])
                        if q.startswith('SELECT methodology_version FROM domino_activity.position_chunks'):
                            self.assertEqual(params, (POOL, work['fromBlock']))
                            return Rows([] if version is None else [{'methodology_version': version}])
                        return execute(query, params)
                    with patch.object(database, 'execute', side_effect=pending_capital), \
                            TestClient(create_app(reader, gate=ReadGate(interval=0)), base_url='http://127.0.0.1:8876') as client:
                        response = client.post('/v1/read/pool-metrics', json={'poolId': POOL})
                    expected_status = 502 if version == 2 else status
                    self.assertEqual(response.status_code, expected_status, response.text)
                    if expected_status == 200:
                        payload = response.json(); validate_response('pool-metrics', payload)
                        self.assertEqual(payload['capital']['reason'], 'capital_ledger_not_caught_up')
                        self.assertIsNone(payload['valuation']['tvlUsd'])
                        self.assertFalse(payload['usableAsCurrent24h'])
                    else:
                        self.assertEqual(response.json(), {'error': 'upstream_contract_mismatch' if version == 2 else code})
                    self.assertTrue(any('SELECT diagnostic' in q for q, _ in queries))
                    self.assertEqual(work, before)

    def test_all_read_routes_are_registered_once(self):
        routes = [route.path for route in create_app(SimpleNamespace()).routes if '/v1/read/' in route.path]
        self.assertEqual(len(routes), 9)
        self.assertEqual(len(set(routes)), 9)


if __name__ == '__main__':
    unittest.main()
