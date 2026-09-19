#!/usr/bin/env python3
"""Hermetic admission diagnostic; no network, PostgreSQL, or production writes.

Run with the backend API dependencies installed. Each probe reports the actual
HTTP status beside the status a correctly isolated stored lane would return.
Exit zero means the diagnostic completed, not that every desired behavior exists.
The API/identity fixtures create only in-process test services and ephemeral keys.
"""
from copy import deepcopy
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / 'backend'), str(ROOT / 'backend/tests')]
from fastapi.testclient import TestClient
from bridge_state import ClientBudgets
from read_api import ReadGate, create_app
from read_gateway import Gateway, LocalReaderHTTP, create_gateway
from read_service import ReadService
from test_bridge_identity import IdentityFixtures
from test_discovery import FakeRpc, TOKEN


def main():
    IdentityFixtures.setUpClass()
    identity = IdentityFixtures()
    catalogue = json.loads((ROOT / 'api-contracts/read-v1/fixtures/producer/catalogue.success.json').read_text())
    rpc = FakeRpc()
    service = ReadService(rpc_factory=lambda: rpc, clock=lambda: 1010)
    service.catalogue_page = lambda *args, **kwargs: deepcopy(catalogue)
    reader_gate, gateway_gate = ReadGate(interval=0), ReadGate(interval=0)
    reader = TestClient(create_app(service, gate=reader_gate, read_budget_seconds=15,
                                   snapshot_refresh_seconds=0), base_url='http://127.0.0.1:8876')
    gateway = Gateway(enabled=True, enabled_reads=('catalogue', 'markets-snapshot', 'token'),
                      verifier=identity.verifier(), upstream=LocalReaderHTTP(client=reader),
                      gate=gateway_gate, budgets=ClientBudgets(burst=500))
    client = TestClient(create_gateway(gateway), base_url='http://127.0.0.1:8878',
                        client=('127.0.0.1', 40000))
    headers = {'Cf-Access-Jwt-Assertion': identity.token(), 'X-Domino-Client-Id': '192.0.2.1'}
    probes = [
        ('catalogue_while_reader_provider_busy', reader_gate, 'provider', 'catalogue', {'token': TOKEN}, 200),
        ('snapshot_while_reader_provider_busy', reader_gate, 'provider', 'markets-snapshot', {}, 200),
        ('snapshot_while_gateway_provider_busy', gateway_gate, 'provider', 'markets-snapshot', {}, 200),
        ('snapshot_while_gateway_stored_busy', gateway_gate, 'stored', 'markets-snapshot', {}, 429),
    ]
    rows = []
    for name, gate, kind, route, body, expected in probes:
        if not gate.enter(kind):
            raise RuntimeError('diagnostic could not hold its test slot')
        started = time.monotonic()
        try:
            response = client.post('/internal/read/v1/' + route, json=body, headers=headers)
            rows.append({'probe': name, 'actualStatus': response.status_code,
                         'desiredStatus': expected, 'matchesDesiredBehavior': response.status_code == expected,
                         'retryAfterSeconds': response.headers.get('Retry-After'),
                         'durationMs': round((time.monotonic() - started) * 1000, 2)})
        finally:
            gate.leave(kind)
    print(json.dumps({'completed': True, 'productionTouched': False,
                      'rpcBlocksRead': rpc.blocks_read, 'probes': rows}, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
