from pathlib import Path
import sys
from threading import Event, Thread
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from discovery import DataError
from read_api import create_app, ReadGate
from read_service import ReadService
from test_discovery import FakeRpc, OWNER, TOKEN, candidate


class ApiTests(unittest.TestCase):
    def setUp(self):
        self.rpc = FakeRpc()
        self.service = ReadService(rpc_factory=lambda: self.rpc, clock=lambda: 1010,
                                  transport_factory=lambda: (lambda url: [candidate()]))
        self.app = create_app(self.service, gate=ReadGate(interval=0))
        self.client = TestClient(self.app, base_url='http://127.0.0.1:8876')

    def test_http_wallet_read_has_exact_units_and_explicit_capabilities(self):
        response = self.client.post('/v1/read/wallet-assets', json={'wallet': OWNER, 'tokens': [TOKEN]})
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertEqual(data['items'][1]['amountRaw'], str(2**255+123))
        self.assertFalse(data['walletControlVerified'])
        self.assertEqual(response.headers['cache-control'], 'no-store')
        caps = self.client.get('/v1/capabilities').json()
        self.assertFalse(caps['feeCollection'])
        self.assertFalse(caps['privateAccounts'])

    def test_http_pool_reads_do_not_invent_apr_or_enable_execution(self):
        response = self.client.post('/v1/read/pools', json={'token': TOKEN})
        self.assertEqual(response.status_code, 200)
        pool = response.json()['pools'][0]
        self.assertIsNone(pool['feeApr24h'])
        self.assertFalse(pool['executionAvailable'])

    def test_strict_request_types_and_no_rpc_url_or_tenant_override(self):
        for data in [
            {'wallet': OWNER, 'tokens': [TOKEN]*11}, {'wallet': OWNER, 'autoDiscover': 'true'},
            {'wallet': OWNER, 'tenant': 'other'}, {'wallet': OWNER, 'rpcUrl': 'https://secret.invalid/key'},
            {'wallet': 'invalid-private-input'}, {'wallet': OWNER, 'chainId': 1},
        ]:
            with self.subTest(data=data):
                response = self.client.post('/v1/read/wallet-assets', json=data)
                self.assertEqual(response.status_code, 422)
                self.assertEqual(response.json(), {'error': 'invalid_request'})
        for value in [True, '2', 0, 21]:
            self.assertEqual(self.client.post('/v1/read/pools', json={'token': TOKEN, 'maxPools': value}).status_code, 422)
        self.assertEqual(self.rpc.blocks_read, 0)

    def test_cross_site_and_rebinding_hosts_rejected_before_reads(self):
        for headers in [{'Origin': 'https://domino.example'}, {'Origin': 'null'},
                        {'Sec-Fetch-Site': 'cross-site'}, {'Host': 'evil.example'},
                        {'Host': '127.0.0.1.evil.example'}, {'Host': 'user@localhost'}]:
            with self.subTest(headers=headers):
                response = self.client.post('/v1/read/wallet-assets', json={'wallet': OWNER}, headers=headers)
                self.assertEqual(response.status_code, 403)
        self.assertEqual(self.rpc.blocks_read, 0)

    def test_json_only_and_streamed_body_limit(self):
        self.assertEqual(self.client.post('/v1/read/wallet-assets', data={'wallet': OWNER}).status_code, 415)
        response = self.client.post('/v1/read/wallet-assets', content=iter([b' '*4096]*3),
                                    headers={'Content-Type': 'application/json'})
        self.assertEqual(response.status_code, 413)
        self.assertEqual(self.rpc.blocks_read, 0)

    def test_expired_or_foreign_cursor_does_not_trigger_rpc(self):
        response = self.client.post('/v1/read/wallet-assets', json={'wallet': OWNER, 'cursor': 'forged'})
        self.assertEqual(response.status_code, 400)
        self.assertEqual(self.rpc.blocks_read, 0)

    def test_read_failure_is_503_and_gate_is_released_for_retry(self):
        self.rpc.reorg = True
        response = self.client.post('/v1/read/wallet-assets', json={'wallet': OWNER})
        self.assertEqual(response.status_code, 503)
        self.assertEqual(response.json(), {'error': 'snapshot_reorganized'})
        self.rpc.reorg = False
        response = self.client.post('/v1/read/wallet-assets', json={'wallet': OWNER})
        self.assertEqual(response.status_code, 200)

    def test_no_auth_mutations_signing_or_submission_routes(self):
        for path in ['/auth/verify', '/v1/swap', '/v1/execute', '/v1/withdraw']:
            self.assertEqual(self.client.post(path, json={}).status_code, 404)
        self.assertEqual(self.client.get('/v1/read/wallet-assets').status_code, 405)
        schema = self.client.get('/openapi.json').json()
        self.assertNotIn('rpcUrl', str(schema))

    def test_gate_limits_concurrency_and_start_rate(self):
        now = [10.0]
        gate = ReadGate(interval=1, clock=lambda: now[0])
        self.assertTrue(gate.enter())
        now[0] += 2
        self.assertFalse(gate.enter())
        gate.slot.release()
        self.assertTrue(gate.enter())
        gate.slot.release()
        self.assertFalse(gate.enter())
        now[0] += 1
        self.assertTrue(gate.enter())
        gate.slot.release()
        # Stored-data reads share the interval but run on their own slot (#157).
        now[0] += 1
        self.assertTrue(gate.enter(gate.STORED))
        now[0] += 2
        self.assertFalse(gate.enter(gate.STORED))
        gate.stored_slot.release()
        self.assertTrue(gate.enter(gate.PROVIDER))
        gate.slot.release()
        self.assertTrue(gate.enter(gate.STORED))
        gate.stored_slot.release()

    def test_second_http_read_gets_429_while_first_in_progress(self):
        entered, release = Event(), Event()
        service = self.service
        original = service.wallet_assets
        def blocking(*args, **kwargs):
            entered.set()
            if not release.wait(3):
                raise AssertionError('test coordination timed out')
            return original(*args, **kwargs)
        service.wallet_assets = blocking
        result = []
        worker = Thread(target=lambda: result.append(self.client.post('/v1/read/wallet-assets', json={'wallet': OWNER})))
        worker.start()
        try:
            self.assertTrue(entered.wait(2))
            response = self.client.post('/v1/read/pools', json={'token': TOKEN})
            self.assertEqual(response.status_code, 429)
            # The delay reports the read still holding the slot, not a constant:
            # a second against a read that owns the slot for several sends the
            # caller back again and again, which is what the old '1' did.
            delay = int(response.headers['Retry-After'])
            self.assertGreater(delay, 1)
            self.assertLessEqual(delay, ReadGate.MAX_RETRY_AFTER)
        finally:
            release.set()
            worker.join(4)
        self.assertEqual(result[0].status_code, 200)
