"""Local-first historical reads never trade consistency or bounds for recovery."""
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from catalogue_indexer import IndexRpc
from discovery import CHAIN_ID, DataError, ZERO
from rpc_failover import HistoricalReadRpc, MAX_ANCHORS
from configure_rpc import prepare_local_config
from local_config import checked_config
from rpc_config import LOCAL_STATE_BLOCKS, configured_history_rpc_source, configured_history_rpc_urls

LOCAL = 'https://rpc.domino.money/TEST_LOCAL_TOKEN_0123456/'
FALLBACK = 'https://robinhood-mainnet.g.alchemy.com/v2/test-fallback'
SECOND = 'https://secondary.example.invalid/test-second'
BEYOND = 0x20 + LOCAL_STATE_BLOCKS + 1  # a head that puts block 0x20 outside the local window
MISSING = {'code': -32000, 'message': 'missing trie node ' + 'a'*64 + ' (path 00) state unavailable'}


def header(number):
    return {'number': hex(number), 'hash': '0x' + f'{number:064x}', 'timestamp': hex(1000+number)}


class Provider:
    def __init__(self):
        self.calls = []
        self.fail_state = False
        self.fail_transport = False
        self.wrong_chain = False
        self.wrong_header = False
        self.mixed_wrong_chain = False

    def one(self, url, call):
        method, params = call['method'], call['params']
        self.calls.append((url, method, params))
        if self.fail_transport and url == LOCAL:
            raise DataError('network_unavailable')
        if method == 'eth_chainId':
            result = '0x1' if self.wrong_chain and url == FALLBACK else hex(CHAIN_ID)
        elif method == 'eth_getBlockByNumber':
            result = header(2000 if params[0] == 'latest' else int(params[0], 16))
            if self.wrong_header and url == FALLBACK:
                result['hash'] = '0x' + 'ff'*32
        elif method == 'eth_getLogs':
            result = []
        else:
            if self.fail_state and url == LOCAL:
                return {'jsonrpc': '2.0', 'id': call['id'], 'error': MISSING}
            result = '0x01'
        return {'jsonrpc': '2.0', 'id': call['id'], 'result': result}

    def __call__(self, url, body):
        if not isinstance(body, list):
            return self.one(url, body)
        result = [self.one(url, call) for call in body]
        if self.mixed_wrong_chain and url == LOCAL:
            for call, value in zip(body, result):
                if call['method'] == 'eth_chainId':
                    value['result'] = '0x1'
        return list(reversed(result))  # JSON-RPC IDs, not delivery order.


class HistoryRoutingTests(unittest.TestCase):
    def test_v4_upgrade_preserves_fallback_and_routes_every_history_source_local_first(self):
        old = {'version': 1, 'rpcUrl': FALLBACK, 'inventoryUrl': FALLBACK}
        config = prepare_local_config(old, 'TEST_LOCAL_TOKEN_0123456')
        self.assertEqual(config['version'], 4)
        self.assertNotIn('historicalRpcUrl', config)
        self.assertEqual(configured_history_rpc_source(config), (LOCAL, FALLBACK))
        rotated = prepare_local_config(config, 'TEST_ROTATED_TOKEN_0123456')
        self.assertEqual(rotated['rpcFallbackUrls'], [FALLBACK])
        with self.assertRaisesRegex(DataError, 'local_first_rpc_required'):
            checked_config({**config, 'rpcUrl': FALLBACK, 'rpcFallbackUrls': []})
        legacy = {**config, 'version': 3, 'historicalRpcUrl': FALLBACK}
        self.assertEqual(configured_history_rpc_urls(legacy), (FALLBACK,))
        self.assertEqual(configured_history_rpc_source(legacy), FALLBACK)

    def test_thousands_of_headers_and_evicted_old_state_stay_local_with_bounded_proofs(self):
        provider = Provider()
        rpc = IndexRpc((LOCAL, FALLBACK), transport=provider, max_requests=3000)
        rpc.request('eth_getBlockByNumber', ['latest', False])
        for start in range(1, 1001, 100):
            rpc.batch([('eth_getBlockByNumber', [hex(n), False]) for n in range(start, start+100)])
            self.assertLessEqual(len(rpc.anchors), MAX_ANCHORS)
        self.assertIn(hex(2000), rpc.anchors)
        rpc.request('eth_getCode', [ZERO, '0x1'])
        self.assertLessEqual(len(rpc.anchors), MAX_ANCHORS)
        self.assertTrue(all(url == LOCAL for url, _, _ in provider.calls))
        self.assertEqual(rpc.count, len(provider.calls))
        self.assertEqual(provider.calls[-2:], [(LOCAL, 'eth_getBlockByNumber', ['0x1', False]),
                                              (LOCAL, 'eth_getCode', [ZERO, '0x1'])])

    def test_old_state_fallback_does_not_redirect_following_logs_or_headers(self):
        provider = Provider(); provider.fail_state = True
        rpc = IndexRpc((LOCAL, FALLBACK), transport=provider)
        rpc.request('eth_getBlockByNumber', ['0x20', False])
        with self.assertLogs('rpc_failover', level='WARNING') as logged:
            self.assertEqual(rpc.request('eth_getCode', [ZERO, '0x20']), '0x01')
        self.assertIn('reason=historical_state_unavailable', logged.output[0])
        self.assertNotIn('https', logged.output[0])
        self.assertEqual(provider.calls[-1][0], FALLBACK)
        rpc.request('eth_getLogs', [{'fromBlock': '0x1', 'toBlock': '0x20'}])
        self.assertEqual(provider.calls[-1][0], LOCAL)
        rpc.request('eth_getBlockByNumber', ['0x2', False])
        self.assertEqual(provider.calls[-1][0], LOCAL)
        self.assertEqual(rpc.count, len(provider.calls))

    def test_missing_state_cannot_hide_wrong_chain_or_continuity_hash(self):
        for attribute, code in [('wrong_chain', 'wrong_chain'), ('wrong_header', 'snapshot_reorganized')]:
            with self.subTest(attribute=attribute):
                provider = Provider(); provider.fail_state = True
                setattr(provider, attribute, True)
                rpc = HistoricalReadRpc((LOCAL, FALLBACK), transport=provider)
                rpc.request('eth_getBlockByNumber', ['0x20', False])
                with self.assertRaisesRegex(DataError, '^'+code+'$'):
                    rpc.request('eth_getCode', [ZERO, '0x20'])
                before = len(provider.calls)
                with self.assertRaisesRegex(DataError, '^'+code+'$'):
                    rpc.request('eth_getBlockByNumber', ['0x2', False])
                self.assertEqual(len(provider.calls), before)

    def test_mixed_batch_validates_all_proofs_before_missing_state_recovery(self):
        provider = Provider(); provider.fail_state = True; provider.mixed_wrong_chain = True
        rpc = HistoricalReadRpc((LOCAL, FALLBACK), transport=provider)
        with self.assertRaisesRegex(DataError, '^wrong_chain$'):
            rpc.batch([('eth_getCode', [ZERO, '0x20']), ('eth_chainId', [])])
        self.assertTrue(all(url == LOCAL for url, _, _ in provider.calls))

    def test_valid_mixed_batch_replays_whole_after_verified_explicit_state_refusal(self):
        provider = Provider(); provider.fail_state = True
        rpc = HistoricalReadRpc((LOCAL, FALLBACK), transport=provider)
        result = rpc.batch([('eth_getCode', [ZERO, '0x20']), ('eth_getBlockByNumber', ['0x40', False])])
        self.assertEqual(result, ['0x01', header(64)])
        fallback = [call for call in provider.calls if call[0] == FALLBACK]
        self.assertEqual(fallback[1], (FALLBACK, 'eth_getBlockByNumber', ['0x40', False]))
        self.assertEqual(rpc.count, len(provider.calls))

    def test_shared_budget_covers_chain_anchor_failed_state_and_fallback_proofs(self):
        provider = Provider(); provider.fail_state = True
        rpc = HistoricalReadRpc((LOCAL, FALLBACK), transport=provider, max_requests=4)
        with self.assertRaisesRegex(DataError, '^request_budget_exhausted$'):
            rpc.request('eth_getCode', [ZERO, '0x20'])
        self.assertEqual(len(provider.calls), 4)
        self.assertEqual(rpc.count, 4)
        self.assertFalse(any(url == FALLBACK and method == 'eth_getCode' for url, method, _ in provider.calls))

    def test_batch_ambiguous_network_failure_does_not_replay(self):
        provider = Provider()
        rpc = HistoricalReadRpc((LOCAL, FALLBACK), transport=provider)
        rpc.request('eth_getBlockByNumber', ['0x20', False])
        provider.fail_transport = True
        with self.assertRaisesRegex(DataError, '^network_unavailable$'):
            rpc.batch([('eth_getCode', [ZERO, '0x20'])])
        self.assertTrue(all(url == LOCAL for url, _, _ in provider.calls))

    def test_scalar_unavailable_local_recovers_but_next_operation_retries_local(self):
        provider = Provider(); provider.fail_transport = True
        rpc = HistoricalReadRpc((LOCAL, FALLBACK), transport=provider)
        self.assertEqual(rpc.request('eth_getBlockByNumber', ['0x20', False]), header(32))
        provider.fail_transport = False
        rpc.request('eth_getBlockByNumber', ['0x21', False])
        self.assertEqual(provider.calls[-1][0], LOCAL)


class LocalStateWindowTests(unittest.TestCase):
    """State the own node no longer keeps skips it; everything else stays local-first."""

    def anchored(self, head, urls=(LOCAL, FALLBACK)):
        provider = Provider(); provider.fail_state = True
        rpc = HistoricalReadRpc(urls, transport=provider)
        rpc.request('eth_getBlockByNumber', ['0x20', False])
        rpc.request('eth_getBlockByNumber', [hex(head), False])
        return provider, rpc

    def test_state_beyond_local_window_starts_at_fallback_without_a_refusal(self):
        provider, rpc = self.anchored(BEYOND)
        before = len(provider.calls)
        with self.assertNoLogs('rpc_failover', level='WARNING'):
            self.assertEqual(rpc.request('eth_getCode', [ZERO, '0x20']), '0x01')
        self.assertEqual(provider.calls[before:], [
            (FALLBACK, 'eth_chainId', []),
            (FALLBACK, 'eth_getBlockByNumber', [hex(BEYOND), False]),
            (FALLBACK, 'eth_getCode', [ZERO, '0x20'])])
        self.assertEqual(rpc.count, len(provider.calls))

    def test_state_at_the_window_edge_still_tries_local_first(self):
        provider, rpc = self.anchored(BEYOND - 1)
        with self.assertLogs('rpc_failover', level='WARNING'):
            self.assertEqual(rpc.request('eth_getCode', [ZERO, '0x20']), '0x01')
        self.assertEqual([url for url, method, _ in provider.calls if method == 'eth_getCode'],
                         [LOCAL, FALLBACK])

    def test_old_reads_keep_the_verified_fallback_and_other_operations_return_local(self):
        provider, rpc = self.anchored(BEYOND)
        rpc.request('eth_getCode', [ZERO, '0x20'])
        before = len(provider.calls)
        rpc.request('eth_getBalance', [ZERO, '0x20'])
        self.assertEqual(provider.calls[before:], [(FALLBACK, 'eth_getBalance', [ZERO, '0x20'])])
        rpc.request('eth_getBlockByNumber', ['0x21', False])
        self.assertEqual(provider.calls[-1], (LOCAL, 'eth_getBlockByNumber', ['0x21', False]))
        self.assertEqual(rpc.request('eth_chainId'), hex(CHAIN_ID))
        self.assertEqual(provider.calls[-1], (LOCAL, 'eth_chainId', []))
        provider.fail_state = False
        self.assertEqual(rpc.request('eth_getCode', [ZERO, hex(BEYOND)]), '0x01')
        self.assertEqual(provider.calls[-1], (LOCAL, 'eth_getCode', [ZERO, hex(BEYOND)]))
        self.assertEqual(rpc.count, len(provider.calls))

    def test_batch_with_old_state_starts_at_fallback(self):
        provider, rpc = self.anchored(BEYOND)
        before = len(provider.calls)
        result = rpc.batch([('eth_getBlockByNumber', ['0x40', False]), ('eth_getCode', [ZERO, '0x20'])])
        self.assertEqual(result, [header(64), '0x01'])
        self.assertEqual({url for url, _, _ in provider.calls[before:]}, {FALLBACK})

    def test_only_the_own_node_with_a_next_route_is_skipped(self):
        provider, rpc = self.anchored(BEYOND, urls=(FALLBACK, SECOND))
        rpc.request('eth_getCode', [ZERO, '0x20'])
        self.assertEqual(provider.calls[-1], (FALLBACK, 'eth_getCode', [ZERO, '0x20']))
        provider, rpc = self.anchored(BEYOND, urls=(LOCAL,))
        with self.assertRaisesRegex(DataError, '^rpc_error$'):
            rpc.request('eth_getCode', [ZERO, '0x20'])
        self.assertEqual(provider.calls[-1], (LOCAL, 'eth_getCode', [ZERO, '0x20']))


if __name__ == '__main__':
    unittest.main()
