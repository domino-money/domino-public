from copy import deepcopy
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from market_cache import MarketCache
from qualify_pool_market import (CASES, Counters, loopback_reader, run_probe,
                                 summarize_response, write_report)
from read_contract import CONTRACT_VERSION
from read_service import ReadService
from test_discovery import FakeRpc, POOL
from test_pool_market import Provider


class PoolMarketQualificationTests(unittest.TestCase):
    def setUp(self):
        self.service = ReadService(rpc_factory=FakeRpc, clock=lambda: 1010,
                                  market_cache=MarketCache(Provider(), clock=lambda: 1010))
        self.payload = self.service.pool_market(POOL, include_price_history=True)
        self.headers = {'X-Domino-Read-Contract': CONTRACT_VERSION, 'Cache-Control': 'no-store'}

    def summary(self, payload=None, **kwargs):
        return summarize_response(POOL, 200, self.headers,
            self.payload if payload is None else payload, observed_at=1010, **kwargs)

    def test_projects_exact_zero_unavailable_provenance_and_no_urls(self):
        self.payload['market']['data']['sourceUrl'] = 'https://provider.invalid/private-api-key'
        result = self.summary()
        self.assertTrue(result['contractValid'])
        self.assertEqual(result['market']['data']['volume24hUsd'], '0')
        self.assertEqual(result['market']['data']['reportedLiquidityUsd'], '50000.25')
        self.assertIsNone(result['market']['data']['asOfTimestamp'])
        self.assertIsNone(result['feeApr24h'])
        self.assertFalse(result['providerMetricsReconciled'])
        self.assertFalse(result['executionAvailable'])
        self.assertNotIn('private-api-key', json.dumps(result))
        self.assertNotIn('sourceUrl', json.dumps(result))
        self.assertEqual(result['snapshotAgeSecondsAtReceipt'], 10)

    def test_provider_missing_metric_is_not_fabricated_zero(self):
        self.payload['market']['data']['reportedLiquidityUsd'] = None
        self.assertIsNone(self.summary()['market']['data']['reportedLiquidityUsd'])

    def test_rejects_mismatched_identity_fabricated_apr_and_future_snapshot(self):
        for change in ('identity', 'apr', 'future'):
            with self.subTest(change=change):
                payload = deepcopy(self.payload)
                if change == 'identity':
                    payload['poolId'] = '0x' + 'ab' * 32
                elif change == 'apr':
                    payload['feeApr24h'] = '123.4'
                else:
                    payload['snapshot']['timestamp'] = 1011
                    payload['pool']['snapshot']['timestamp'] = 1011
                result = self.summary(payload)
                self.assertFalse(result['contractValid'])
                self.assertEqual(result['error'], 'probe_response_contract_mismatch')

    def test_error_output_only_accepts_declared_code_and_matching_http_status(self):
        for status, payload, code in (
            (503, {'error': 'https://provider.invalid/key-secret'}, 'probe_request_failed'),
            (503, {'error': 'read_capacity_busy'}, 'probe_request_failed'),
            (429, {'error': 'read_capacity_busy'}, 'read_capacity_busy'),
            (503, 'key-secret', 'probe_request_failed'),
        ):
            with self.subTest(status=status, payload=payload):
                result = summarize_response(POOL, status, self.headers, payload, observed_at=1010)
                self.assertEqual(result['error'], code)
                self.assertNotIn('key-secret', json.dumps(result))

    def test_headers_are_a_separate_acceptance_condition(self):
        result = summarize_response(POOL, 200, {}, self.payload, observed_at=1010)
        self.assertTrue(result['contractValid'])
        self.assertFalse(result['headersValid'])

    def test_probe_is_serial_finite_and_retains_failed_case(self):
        bodies, sleeps = [], []
        counters = Counters()

        def request(port, body):
            self.assertEqual(port, 12345)
            bodies.append(body)
            counters.market_requests += 1
            if len(bodies) == 2:
                return 504, self.headers, {'error': 'read_deadline_exceeded'}
            return 200, self.headers, self.payload

        result = run_probe(12345, [POOL], counters, request=request,
                           wall_clock=lambda: 1010, sleep=sleeps.append)
        self.assertEqual(len(bodies), 3)
        self.assertEqual([row['case'] for row in result], [case for case, _ in CASES])
        self.assertEqual([body['includePriceHistory'] for body in bodies], [False, True, True])
        self.assertEqual(sleeps, [1.05, 1.05])
        self.assertEqual(result[1]['observation']['error'], 'read_deadline_exceeded')
        self.assertTrue(result[2]['observation']['contractValid'])
        self.assertEqual([row['requests']['marketRequests'] for row in result], [1, 1, 1])

    def test_selection_bound_rejects_before_network(self):
        for selected in ([], [POOL, POOL], [POOL, '0x' + 'ab' * 32, '0x' + 'cd' * 32]):
            with self.subTest(selected=selected), self.assertRaises(ValueError):
                run_probe(1, selected, Counters(), request=lambda *_: self.fail('network request'))

    def test_real_loopback_boundary_with_synthetic_upstreams(self):
        # Only local HTTP is opened; FakeRpc/Provider never use external transport.
        with loopback_reader(self.service) as port:
            rows = run_probe(port, [POOL], Counters(), wall_clock=lambda: 1010)
        self.assertEqual(len(rows), 3)
        self.assertTrue(all(row['observation']['contractValid'] and
                            row['observation']['headersValid'] for row in rows))
        self.assertEqual(rows[-1]['observation']['market']['cache']['status'], 'hit')
        self.assertEqual(rows[-1]['observation']['priceHistory']['cache']['status'], 'hit')

    def test_report_cannot_overwrite_an_earlier_attempt(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'evidence.json'
            write_report(path, {'result': 'first'})
            with self.assertRaises(FileExistsError):
                write_report(path, {'result': 'second'})
            self.assertEqual(json.loads(path.read_text()), {'result': 'first'})


if __name__ == '__main__':
    unittest.main()
