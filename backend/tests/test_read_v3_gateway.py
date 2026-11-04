"""Stored V3 travels the same authenticated boundary without altering V1/V2."""
from copy import deepcopy
from pathlib import Path
import sys
import time
from types import SimpleNamespace
import unittest

sys.path[:0] = [str(Path(__file__).resolve().parents[1]), str(Path(__file__).resolve().parent)]
from fastapi.testclient import TestClient
from pydantic import ValidationError
from bridge_http import LocalReaderHTTP
from bridge_state import ClientBudgets
from discovery import DataError, POOL_MANAGER
from public_data_contract import CONTRACT_VERSION, validate_request_response
from read_api import ReadGate, create_app
from read_gateway import Gateway, create_gateway
from read_service import ReadService
from test_bridge_identity import IdentityFixtures
from test_discovery import FakeRpc, POOL, TOKEN


class StoredPublic:
    def __init__(self):
        self.calls = []
        self.mutate = None
        self.repository = SimpleNamespace(request=lambda *args: True)

    def result(self, route, body, response):
        self.calls.append((route, deepcopy(body)))
        if self.mutate:
            self.mutate(response)
        return response

    def overview(self, **body):
        ids = body['poolIds']
        return self.result('overview', body, {
            'schemaVersion': 1, 'chainId': 4663, 'mode': 'stored_public_overview',
            'generatedAt': 200000, 'selectedToken': body['token'], 'requestedPoolIds': ids,
            'acquisitionAccepted': True, 'revision': body['revision'] or 0,
            'hasMore': False, 'nextAfterPoolId': None, 'discoveryCoverage': 'known_verified_pools_only',
            'completeHistory': False, 'tokens': [], 'pools': [
                {'poolId': pool_id, 'value': None, 'observedAt': None,
                 'acquisition': {'status': 'pending', 'refreshing': False, 'reason': None, 'nextAttemptAt': None}}
                for pool_id in ids[:body['limit']]], 'executionAvailable': False})

    def history(self, **body):
        window = {'startTimestamp': 200000 - body['windowSeconds'], 'endTimestamp': 200000}
        return self.result('history', body, {
            'schemaVersion': 1, 'chainId': 4663, 'poolManager': POOL_MANAGER,
            'poolId': body['poolId'], 'currency': body['currency'], 'quoteCurrency': None,
            'source': 'robinhood_pool_swap_logs', 'methodology': 'pool_ratio_v1', 'unit': 'quote_per_base',
            'status': 'not_built', 'reason': None, 'requestedWindow': window,
            'resolutionSeconds': body['resolutionSeconds'], 'snapshot': None, 'covered': [], 'gaps': [window],
            'candles': [], 'acquisitionAccepted': True, 'executionAvailable': False})

    def search(self, **body):
        return self.result('search', body, {
            'schemaVersion': 1, 'chainId': 4663, 'query': body['query'],
            'coverage': 'known_verified_tokens_only', 'tokens': [], 'executionAvailable': False})


class ReadV3GatewayTests(IdentityFixtures, unittest.TestCase):
    def setUp(self):
        self.public = StoredPublic()
        self.rpc = FakeRpc()
        self.service = ReadService(rpc_factory=lambda: self.rpc, clock=lambda: 1010, public_data=self.public)
        self.reader_gate, self.gateway_gate = ReadGate(interval=0), ReadGate(interval=0)
        self.reader_app = create_app(self.service, gate=self.reader_gate, read_budget_seconds=15)
        self.reader = TestClient(self.reader_app, base_url='http://127.0.0.1:8876')
        self.gateway = Gateway(enabled=True, enabled_reads=('token',),
                               enabled_v3=True, enabled_v3_reads=('overview', 'history', 'search'),
                               verifier=self.verifier(), upstream=LocalReaderHTTP(client=self.reader),
                               gate=self.gateway_gate, budgets=ClientBudgets(burst=500))
        self.client = TestClient(create_gateway(self.gateway), base_url='http://127.0.0.1:8878',
                                 client=('127.0.0.1', 40000))
        self.headers = {'Cf-Access-Jwt-Assertion': self.token(), 'X-Domino-Client-Id': '192.0.2.1'}
        self.bodies = {'overview': {'poolIds': [POOL]}, 'history': {'poolId': POOL, 'currency': TOKEN},
                       'search': {'query': 'WETH'}}
        self.addCleanup(self.reader.close)
        self.addCleanup(self.client.close)

    def post(self, route='overview', body=None, *, headers=None):
        return self.client.post('/internal/read/v3/' + route,
                                json=self.bodies.get(route, {}) if body is None else body,
                                headers=self.headers if headers is None else headers)

    def test_all_stored_routes_pass_through_with_separate_contract_and_no_provider_reads(self):
        self.assertIsNone(self.reader_app.state.snapshot_refresher)
        self.assertTrue(self.reader_gate.enter(ReadGate.PROVIDER))
        self.assertTrue(self.gateway_gate.enter(ReadGate.PROVIDER))
        try:
            for route, body in self.bodies.items():
                with self.subTest(route=route):
                    response = self.post(route)
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.headers['X-Domino-Read-Contract'], CONTRACT_VERSION)
                    self.assertEqual(response.headers['Cache-Control'], 'no-store, no-transform')
                    self.assertNotIn('set-cookie', response.headers)
                    validate_request_response(route, body, response.json())
        finally:
            self.gateway_gate.leave(ReadGate.PROVIDER)
            self.reader_gate.leave(ReadGate.PROVIDER)
        self.assertEqual(self.rpc.blocks_read, 0)
        self.assertEqual([route for route, _ in self.public.calls], list(self.bodies))

    def test_stored_capacity_remains_bounded_and_v1_provider_route_is_unchanged(self):
        self.assertTrue(self.gateway_gate.enter(ReadGate.STORED))
        try:
            self.assertEqual(self.post().status_code, 429)
            response = self.client.post('/internal/read/v1/token', json={'token': TOKEN}, headers=self.headers)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers['X-Domino-Read-Contract'], '1.1.0-rc.3')
        finally:
            self.gateway_gate.leave(ReadGate.STORED)
        self.assertEqual(self.post().status_code, 200)

    def test_v3_is_explicitly_enabled_and_cannot_choose_other_protocol_routes(self):
        self.gateway.enabled_v3 = False
        response = self.post()
        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.headers['X-Domino-Read-Contract'], CONTRACT_VERSION)
        self.gateway.enabled_v3 = True
        for route in ('token', 'pool-market', 'health', 'overview/extra', '%6fverview'):
            self.assertEqual(self.post(route).status_code, 404, route)
        self.assertEqual(self.public.calls, [])

    def test_new_routes_preserve_identity_body_origin_and_budget_checks(self):
        for headers, status in [({}, 403), ({**self.headers, 'Origin': 'https://domino.money'}, 403)]:
            self.assertEqual(self.post(headers=headers).status_code, status)
        for body in ({}, {'poolIds': [POOL] * 25}, {'poolIds': [POOL], 'rpcUrl': 'https://invalid.test'},
                     {'poolIds': [POOL], 'limit': True}, {'token': TOKEN, 'poolIds': [POOL]}):
            self.assertEqual(self.post(body=body).status_code, 422, body)
        self.assertEqual(self.public.calls, [])
        self.gateway.budgets = ClientBudgets(burst=1, per_minute=30)
        self.assertEqual(self.post().status_code, 200)
        self.assertEqual(self.post('search').status_code, 429)
        self.assertEqual(len(self.public.calls), 1)

    def test_reader_rejects_wrong_selection_without_exposing_response(self):
        self.public.mutate = lambda response: response.update(requestedPoolIds=[])
        response = self.post()
        self.assertEqual((response.status_code, response.json()), (502, {'error': 'upstream_contract_mismatch'}))
        self.public.mutate = None
        self.assertEqual(self.post().status_code, 200)

    def test_gateway_rejects_wrong_contract_and_valid_payload_for_another_request(self):
        original = self.gateway.upstream.request
        for change in ('contract', 'query'):
            def request(route, body=None, *, deadline, request_id=None, version='v1'):
                status, data, metadata = original(route, body, deadline=deadline, request_id=request_id, version=version)
                if route != 'health':
                    if change == 'contract': metadata['contract'] = '1.1.0-rc.3'
                    else: data['query'] = 'different'
                return status, data, metadata
            self.gateway.upstream.request = request
            self.assertEqual(self.post('search').status_code, 502, change)

    def test_disabled_storage_is_honest_and_does_not_fall_back_to_live_rpc(self):
        self.service.public_data = None
        response = self.post()
        self.assertEqual((response.status_code, response.json()), (503, {'error': 'upstream_unavailable'}))
        self.assertEqual(self.rpc.blocks_read, 0)

    def test_local_reader_transport_enforces_version_and_route_pairs_before_network(self):
        transport = self.gateway.upstream
        for route, version in [('overview', 'v1'), ('token', 'v3'), ('history', 'v2'), ('health', 'v3'), ('overview', '../v3')]:
            with self.subTest(route=route, version=version), self.assertRaisesRegex(DataError, '^route_not_available$'):
                transport.request(route, {}, deadline=time.monotonic() + 1, version=version)
        self.assertEqual(self.public.calls, [])

    def test_a_nul_in_the_search_query_is_a_bad_request_at_every_hop(self):
        # F-18 (21 Oct 2026 pentest): PostgreSQL refused the NUL, and it came back 503 catalogue_database_unavailable.
        for query in ('a\x00b', '\x00', 'WETH\x00'):
            with self.subTest(query=query):
                for response in (self.post('search', {'query': query}),
                                 self.reader.post('/v3/read/search', json={'query': query})):
                    self.assertEqual((response.status_code, response.json()), (422, {'error': 'invalid_request'}))
        self.assertEqual(self.public.calls, [])
        self.assertEqual(self.post('search', {'query': 'WETH'}).status_code, 200)


class TextInputTests(unittest.TestCase):
    """Every free-text field the read routes take, and what keeps a NUL in it from a database (F-18, 3 Nov 2026)."""

    @staticmethod
    def free_text(schema, defs, path):
        # A string with no pattern, enum or constant: anything a client types.
        if '$ref' in schema:
            yield from TextInputTests.free_text(defs[schema['$ref'].split('/')[-1]], defs, path)
            return
        for key in ('anyOf', 'oneOf', 'allOf'):
            for option in schema.get(key, []):
                yield from TextInputTests.free_text(option, defs, path)
        if schema.get('type') == 'string' and not {'pattern', 'enum', 'const'} & set(schema):
            yield path
        if schema.get('type') == 'array' and 'items' in schema:
            yield from TextInputTests.free_text(schema['items'], defs, path + '[]')
        for name, child in schema.get('properties', {}).items():
            yield from TextInputTests.free_text(child, defs, path + '.' + name)

    def test_each_free_text_input_refuses_a_nul_before_any_database(self):
        from featured_contract import FeaturedPoolsRequest
        from pool_apr_contract import REQUEST_MODELS as V2_MODELS
        from public_data_contract import REQUEST_MODELS as V3_MODELS
        from read_gateway import REQUEST_MODELS as V1_MODELS
        from sequence_snapshot import SequenceSnapshotRequest
        from v2_read_contract import REQUEST_MODELS as V6_MODELS
        found = set()
        for version, models in (('v1', V1_MODELS), ('v2', V2_MODELS), ('v3', V3_MODELS),
                                ('v4', {'sequence-snapshot': SequenceSnapshotRequest}),
                                ('v5', {'featured-pools': FeaturedPoolsRequest}), ('v6', V6_MODELS)):
            for route, model in models.items():
                schema = model.model_json_schema()
                found |= {(version, path) for path in self.free_text(schema, schema.get('$defs', {}), route)}
        # A new free-text field joins this list with its own reason a NUL never reaches PostgreSQL.
        self.assertEqual(found, {('v1', 'wallet-assets.cursor'), ('v3', 'search.query'), ('v6', 'chain-tokens.query')})
        with self.assertRaises(ValidationError):
            V3_MODELS['search'].model_validate({'query': 'a\x00b'})
        with self.assertRaises(ValidationError):
            V6_MODELS['chain-tokens'].model_validate({'chainId': 8453, 'query': 'a\x00b'})
        # The wallet cursor is opaque: it is decoded (inventory.CursorCodec, bridge_state.OpaqueCursors), never stored.
        reader = TestClient(create_app(ReadService(rpc_factory=FakeRpc, clock=lambda: 1010), gate=ReadGate(interval=0),
                                       read_budget_seconds=15), base_url='http://127.0.0.1:8876')
        self.addCleanup(reader.close)
        response = reader.post('/v1/read/wallet-assets', json={'wallet': TOKEN, 'cursor': 'a\x00b'})
        self.assertEqual((response.status_code, response.json()), (400, {'error': 'invalid_or_expired_cursor'}))


if __name__ == '__main__':
    unittest.main()
