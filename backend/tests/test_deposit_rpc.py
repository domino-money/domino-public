"""The execution-support reader cannot sign, broadcast, retry or reset a budget."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deposit_rpc import DepositRpc
from discovery import DataError, ReadRpc
from read_deadline import read_deadline

URL = 'https://rpc.mainnet.chain.robinhood.com'


class DepositRpcTests(unittest.TestCase):
    def test_separate_method_allowlist_never_expands_public_reader(self):
        calls = []
        rpc = DepositRpc(URL, transport=lambda *a, **k: calls.append(a))
        for method in ('eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign',
                       'eth_signTypedData_v4', 'debug_traceCall', 'wallet_sendCalls'):
            with self.subTest(method=method), self.assertRaisesRegex(DataError, 'method_not_read_only'):
                rpc.request(method)
        self.assertFalse(calls)
        self.assertNotIn('eth_estimateGas', ReadRpc.METHODS)
        self.assertNotIn('eth_getTransactionReceipt', ReadRpc.METHODS)

    def test_whitelisted_requests_and_hash_pinning_and_count(self):
        calls = []
        def transport(url, body, **options):
            calls.append((body, options))
            return {'jsonrpc': '2.0', 'id': body['id'], 'result': '0x0'}
        rpc = DepositRpc(URL, transport=transport, max_requests=2)
        pinned = {'blockHash': '0x' + '12' * 32, 'requireCanonical': True}
        self.assertEqual(rpc.request('eth_call', [{'to': '0x' + '11'*20, 'data': '0x'}, pinned]), '0x0')
        self.assertEqual(rpc.call('eth_getTransactionCount', ['0x' + '11'*20, 'pending']), '0x0')
        with self.assertRaisesRegex(DataError, 'request_budget_exhausted'):
            rpc.request('eth_chainId')
        self.assertEqual(calls[0][0]['params'][1], pinned)
        self.assertEqual(len(calls), 2)

    def test_strict_envelope_and_redacted_errors_no_retry(self):
        for payload in ({'jsonrpc': '2.0', 'id': True, 'result': 1},
                {'jsonrpc': '2.0', 'id': 1, 'result': 1, 'error': {}},
                {'jsonrpc': '2.0', 'id': 1, 'result': 1, 'unknown': 'secret'},
                {'jsonrpc': '2.0', 'id': 1, 'error': {'message': 'provider-key-secret'}},
                {'jsonrpc': '2.0', 'id': 2, 'result': 1}):
            calls = []
            def transport(*args, **kwargs):
                calls.append(True)
                return payload
            with self.assertRaises(DataError) as raised:
                DepositRpc(URL, transport=transport).request('eth_chainId')
            self.assertNotIn('secret', str(raised.exception))
            self.assertEqual(len(calls), 1)

    def test_transport_error_is_sanitized(self):
        def transport(*args, **kwargs):
            raise RuntimeError('private-provider-url')
        with self.assertRaisesRegex(DataError, '^deposit_rpc_unavailable$'):
            DepositRpc(URL, transport=transport).request('eth_chainId')

    def test_urls_are_trusted_https_only(self):
        # Synthetic userinfo tests URL rejection; no credential is configured.
        with_userinfo = URL.replace('https://', 'https://' + 'name:secret@')
        for url in ('http://localhost', 'https://127.0.0.1', URL + '?apikey=secret',
                    'https://attacker.invalid', with_userinfo):
            with self.subTest(url=url), self.assertRaises(DataError):
                DepositRpc(url)

    def test_deadline_is_shared_across_instances_and_actual_transport_timeout_clamped(self):
        now, options = [0], []
        def transport(url, body, **kwargs):
            options.append(kwargs)
            now[0] += 3
            return {'jsonrpc': '2.0', 'id': body['id'], 'result': '0x0'}
        with self.assertRaisesRegex(DataError, 'read_deadline_exceeded'):
            with read_deadline(5, clock=lambda: now[0]):
                DepositRpc(URL, transport=transport).request('eth_chainId')
                DepositRpc(URL, transport=transport).request('eth_chainId')
        self.assertEqual([row['timeout'] for row in options], [5, 2])


if __name__ == '__main__':
    unittest.main()
