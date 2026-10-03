"""The reader and the writer lead with the node's proxy on the services host (#315).

From 3 October the writer's calls through rpc.domino.money hung for whole DNS
TTLs: the name answered with a Cloudflare pair outside the writer's egress set.
A version 4 provider file may now lead with http://127.0.0.1:18547/, the proxy
that reaches the node over the tailnet, with the node's public route next and
the archive after it. Every URL is synthetic; nothing here opens a socket.
"""
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, Mock, patch
from urllib.error import HTTPError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import (CHAIN_ID, MAX_RESPONSE_BYTES, SNAPSHOT_LOOPBACK_RPC, ZERO, DataError, ReadRpc,
                       RpcStateUnavailable, rpc_http)
from indexer_io import indexer_transport
from local_config import checked_config, load_config, save_config
from read_service import ReadService, bounded_transport
from rpc_config import LOCAL_STATE_BLOCKS, configured_history_rpc_urls, configured_rpc_urls, own_node
from rpc_failover import FailoverReadRpc, HistoricalReadRpc

LOOPBACK = SNAPSHOT_LOOPBACK_RPC
LOCAL = 'https://rpc.domino.money/SYNTHETIC_LOCAL_TOKEN_0123/'
ARCHIVE = 'https://robinhood-mainnet.g.alchemy.com/v2/SYNTHETIC_ARCHIVE'
SECOND = 'https://secondary.example.invalid/SYNTHETIC_SECOND'
ROUTES = (LOOPBACK, LOCAL, ARCHIVE)
OWNER = '0x706627e3e75b0603c4b6f9a1ebbfc635da712747'
POOL = '0x' + 'ab' * 32
TOKEN = '0x' + '1' * 40
CHAIN = json.dumps({'jsonrpc': '2.0', 'id': 1, 'result': hex(CHAIN_ID)}).encode()
MISSING = {'code': -32000, 'message': 'missing trie node ' + 'a' * 64 + ' (path 00) state unavailable'}
BEYOND = 0x20 + LOCAL_STATE_BLOCKS + 1  # a head that puts block 0x20 outside the node's window


def provider_file(**change):
    return {'version': 4, 'rpcUrl': LOOPBACK, 'rpcFallbackUrls': [LOCAL, ARCHIVE],
            'rpcAllowedHosts': ['robinhood-mainnet.g.alchemy.com', 'rpc.domino.money'],
            'inventoryUrl': None, **change}


def header(number):
    return {'number': hex(number), 'hash': '0x' + f'{number:064x}', 'timestamp': hex(1000 + number)}


class Node:
    """The node over its two paths, then an archive; `refusing` routes keep recent state only."""
    def __init__(self, *, refusing=(LOOPBACK, LOCAL), down=()):
        self.calls, self.refusing, self.down = [], set(refusing), set(down)

    def one(self, url, call):
        method, params = call['method'], call['params']
        self.calls.append((url, method, params))
        if url in self.down:
            raise DataError('network_unavailable')
        if method == 'eth_chainId':
            result = hex(CHAIN_ID)
        elif method == 'eth_getBlockByNumber':
            result = header(2000 if params[0] == 'latest' else int(params[0], 16))
        elif url in self.refusing:
            return {'jsonrpc': '2.0', 'id': call['id'], 'error': MISSING}
        else:
            result = '0x01'
        return {'jsonrpc': '2.0', 'id': call['id'], 'result': result}

    def __call__(self, url, body):
        return [self.one(url, call) for call in body] if isinstance(body, list) else self.one(url, body)


def state_calls(node, method):
    return [url for url, called, _ in node.calls if called == method]


class ProviderFileTests(unittest.TestCase):
    def test_a_version_4_file_may_lead_with_the_proxy_ahead_of_the_public_route(self):
        data = checked_config(provider_file())
        self.assertEqual(configured_rpc_urls(data), ROUTES)
        self.assertEqual(configured_history_rpc_urls(data), ROUTES)
        self.assertEqual(checked_config({**data, 'sequenceSnapshotLoopback': True})['rpcUrl'], LOOPBACK)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'providers.json'
            save_config(data, path)
            self.assertEqual(load_config(path), data)

    def test_the_proxy_leads_only_a_version_4_file_whose_next_route_is_the_node(self):
        for change, code in (({'rpcFallbackUrls': []}, 'loopback_requires_local_fallback'),
                             ({'rpcFallbackUrls': [ARCHIVE]}, 'loopback_requires_local_fallback'),
                             ({'rpcFallbackUrls': [ARCHIVE, LOCAL]}, 'loopback_requires_local_fallback'),
                             ({'rpcFallbackUrls': [5, LOCAL]}, 'loopback_requires_local_fallback'),
                             ({'rpcFallbackUrls': [LOCAL, LOOPBACK]}, 'invalid_rpc_fallback_url'),
                             ({'rpcUrl': LOCAL, 'rpcFallbackUrls': [LOOPBACK]}, 'invalid_rpc_fallback_url'),
                             ({'version': 2}, 'invalid_rpc_url'),
                             ({'version': 3, 'historicalRpcUrl': ARCHIVE}, 'invalid_rpc_url')):
            with self.subTest(change=change), self.assertRaisesRegex(DataError, '^' + code + '$'):
                checked_config(provider_file(**change))
        with self.assertRaisesRegex(DataError, '^invalid_rpc_url$'):
            checked_config({'version': 1, 'rpcUrl': LOOPBACK, 'inventoryUrl': ARCHIVE})
        # Only the exact URL is the proxy.
        for url in ('http://127.0.0.1:18547', 'http://localhost:18547/', 'http://127.0.0.2:18547/',
                    'http://127.0.0.1:8547/', 'https://127.0.0.1:18547/', LOOPBACK + 'x', LOOPBACK + '?x=1'):
            with self.subTest(url=url), self.assertRaisesRegex(DataError, '^invalid_rpc_url$'):
                checked_config(provider_file(rpcUrl=url))

    def test_routes_read_from_an_unchecked_file_keep_the_same_rules(self):
        self.assertEqual(configured_rpc_urls(provider_file()), ROUTES)
        missing = provider_file()
        del missing['rpcFallbackUrls']
        for config in (provider_file(rpcFallbackUrls=[ARCHIVE]), provider_file(rpcFallbackUrls=[]),
                       provider_file(rpcFallbackUrls=None), provider_file(rpcFallbackUrls=[5, LOCAL]), missing):
            with self.subTest(config=config), self.assertRaisesRegex(DataError, '^loopback_requires_local_fallback$'):
                configured_rpc_urls(config)
        for version in (None, 2, 3):
            with self.subTest(version=version), self.assertRaisesRegex(DataError, '^invalid_rpc_url$'):
                configured_rpc_urls(provider_file(version=version))
        # An environment override names one HTTPS endpoint, never the proxy.
        with self.assertRaisesRegex(DataError, '^invalid_rpc_url$'):
            configured_rpc_urls(checked_config(provider_file()), LOOPBACK)

    def test_the_own_node_is_its_proxy_and_its_public_route_only(self):
        self.assertTrue(own_node(LOOPBACK))
        self.assertTrue(own_node(LOCAL))
        for url in (ARCHIVE, SECOND, 'http://127.0.0.1:8547/', 'https://ws.domino.money/SYNTHETIC/',
                    'https://rpc.domino.money.evil.example/SYNTHETIC/'):
            with self.subTest(url=url):
                self.assertFalse(own_node(url))


class TransportTests(unittest.TestCase):
    def test_a_configured_route_reaches_the_proxy_only_over_the_fixed_loopback_hop(self):
        https = Mock(side_effect=AssertionError('an HTTPS opener'))
        with patch('discovery._LOOPBACK_JSON_OPENER', return_value=io.BytesIO(CHAIN)) as loopback:
            self.assertEqual(rpc_http(LOOPBACK, {'jsonrpc': '2.0'}, opener=https)['result'], hex(CHAIN_ID))
            self.assertEqual(loopback.call_args.args[0].full_url, LOOPBACK)
            for url in ('http://127.0.0.1:18547', 'http://localhost:18547/', 'http://127.0.0.1:8547/',
                        LOOPBACK + 'x'):
                with self.subTest(url=url), self.assertRaisesRegex(DataError, '^https_endpoint_required$'):
                    rpc_http(url, {'jsonrpc': '2.0'}, opener=https)
        self.assertEqual(loopback.call_count, 1)
        https.assert_not_called()
        opened = Mock(return_value=io.BytesIO(CHAIN))
        self.assertEqual(rpc_http(LOCAL, {'jsonrpc': '2.0'}, opener=opened)['result'], hex(CHAIN_ID))
        self.assertEqual(opened.call_args.args[0].full_url, LOCAL)

    def test_a_read_client_reaches_a_configured_proxy_by_default(self):
        with patch('discovery._LOOPBACK_JSON_OPENER', return_value=io.BytesIO(CHAIN)) as loopback:
            self.assertEqual(ReadRpc(LOOPBACK).request('eth_chainId'), hex(CHAIN_ID))
        loopback.assert_called_once()

    def test_the_reader_never_hands_the_proxy_to_its_kept_https_connections(self):
        with patch('discovery._LOOPBACK_JSON_OPENER', return_value=io.BytesIO(CHAIN)) as loopback, \
             patch('read_service.KEEPALIVE_OPENER', side_effect=AssertionError('kept HTTPS opener')) as kept:
            self.assertEqual(bounded_transport()(LOOPBACK, {'jsonrpc': '2.0'})['result'], hex(CHAIN_ID))
        kept.assert_not_called()
        self.assertLessEqual(loopback.call_args.kwargs['timeout'], 8)

    def test_the_indexer_keeps_its_byte_budget_and_log_range_check_on_the_proxy(self):
        request = {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_getLogs', 'params': []}
        https = Mock(side_effect=AssertionError('an HTTPS opener'))
        logs = json.dumps({'jsonrpc': '2.0', 'id': 1, 'result': ['0x' + 'ab' * 32] * 40_000}).encode()
        self.assertGreater(len(logs), MAX_RESPONSE_BYTES)
        with patch('discovery._LOOPBACK_JSON_OPENER', return_value=io.BytesIO(logs)):
            self.assertEqual(len(indexer_transport(opener=https)(LOOPBACK, request)['result']), 40_000)
        https.assert_not_called()
        opened = Mock(return_value=io.BytesIO(logs))
        self.assertEqual(len(indexer_transport(opener=opened)(ARCHIVE, request)['result']), 40_000)
        self.assertEqual(opened.call_args.args[0].full_url, ARCHIVE)
        stream = io.BytesIO(json.dumps({'error': {'code': -32602, 'message': 'Log response size exceeded.'}}).encode())

        def refused(*args, **kwargs):
            raise HTTPError(LOOPBACK, 400, 'node text', {}, stream)
        with patch('discovery._LOOPBACK_JSON_OPENER', side_effect=refused), \
             self.assertRaisesRegex(DataError, '^rpc_log_range_too_large$'):
            indexer_transport()(LOOPBACK, request)
        self.assertTrue(stream.closed)


class FailoverTests(unittest.TestCase):
    def test_a_proxy_failure_moves_to_the_node_public_route(self):
        node = Node(down=(LOOPBACK,))
        rpc = FailoverReadRpc(ROUTES, transport=node)
        with self.assertLogs('rpc_failover', level='WARNING') as logged:
            self.assertEqual(rpc.request('eth_getBlockByNumber', ['latest', False]), header(2000))
        self.assertIn('provider_index=1 reason=network_unavailable', logged.output[0])
        self.assertEqual(rpc.url, LOCAL)

    def test_state_the_node_refused_on_one_path_is_not_asked_of_its_other(self):
        node = Node()
        rpc = FailoverReadRpc(ROUTES, transport=node)
        rpc.request('eth_getBlockByNumber', ['latest', False])
        with self.assertLogs('rpc_failover', level='WARNING') as logged:
            self.assertEqual(rpc.request('eth_getBalance', [TOKEN, hex(2000)]), '0x01')
        self.assertEqual(state_calls(node, 'eth_getBalance'), [LOOPBACK, ARCHIVE])
        self.assertIn('provider_index=2 reason=historical_state_unavailable', logged.output[0])
        self.assertNotIn('127.0.0.1', '\n'.join(logged.output))
        self.assertEqual(rpc.count, len(node.calls))
        # The first route past the node answers, not the last one.
        node = Node(refusing=(LOCAL,))
        rpc = FailoverReadRpc((LOCAL, ARCHIVE, SECOND), transport=node)
        rpc.request('eth_getBlockByNumber', ['latest', False])
        with self.assertLogs('rpc_failover', level='WARNING'):
            self.assertEqual(rpc.request('eth_getBalance', [TOKEN, hex(2000)]), '0x01')
        self.assertEqual(state_calls(node, 'eth_getBalance'), [LOCAL, ARCHIVE])
        # Another provider's refusal moves one route on, even onto the node.
        node = Node(refusing=(SECOND,))
        rpc = FailoverReadRpc((SECOND, LOCAL, ARCHIVE), transport=node)
        rpc.request('eth_getBlockByNumber', ['latest', False])
        with self.assertLogs('rpc_failover', level='WARNING'):
            self.assertEqual(rpc.request('eth_getBalance', [TOKEN, hex(2000)]), '0x01')
        self.assertEqual(state_calls(node, 'eth_getBalance'), [SECOND, LOCAL])
        # With no route past the node, the last one answers, never one past the end.
        node = Node()
        rpc = FailoverReadRpc((LOOPBACK, LOCAL), transport=node)
        rpc.request('eth_getBlockByNumber', ['latest', False])
        with self.assertLogs('rpc_failover', level='WARNING'), \
             self.assertRaisesRegex(RpcStateUnavailable, '^rpc_error$'):
            rpc.request('eth_getBalance', [TOKEN, hex(2000)])
        self.assertEqual(state_calls(node, 'eth_getBalance'), [LOOPBACK, LOCAL])

    def anchored(self, head, routes=ROUTES):
        node = Node()
        rpc = HistoricalReadRpc(routes, transport=node)
        rpc.request('eth_getBlockByNumber', ['0x20', False])
        rpc.request('eth_getBlockByNumber', [hex(head), False])
        return node, rpc

    def test_state_older_than_the_node_keeps_starts_past_both_of_its_paths(self):
        node, rpc = self.anchored(BEYOND)
        before = len(node.calls)
        with self.assertNoLogs('rpc_failover', level='WARNING'):
            self.assertEqual(rpc.request('eth_getCode', [ZERO, '0x20']), '0x01')
        self.assertEqual(node.calls[before:], [(ARCHIVE, 'eth_chainId', []),
                                               (ARCHIVE, 'eth_getBlockByNumber', [hex(BEYOND), False]),
                                               (ARCHIVE, 'eth_getCode', [ZERO, '0x20'])])
        # The next operation leads with the proxy again.
        rpc.request('eth_getBlockByNumber', ['0x21', False])
        self.assertEqual(node.calls[-1], (LOOPBACK, 'eth_getBlockByNumber', ['0x21', False]))
        self.assertEqual(rpc.count, len(node.calls))

    def test_state_the_proxy_refuses_inside_the_window_skips_the_public_route(self):
        node, rpc = self.anchored(BEYOND - 1)
        with self.assertLogs('rpc_failover', level='WARNING') as logged:
            self.assertEqual(rpc.request('eth_getCode', [ZERO, '0x20']), '0x01')
        self.assertEqual(state_calls(node, 'eth_getCode'), [LOOPBACK, ARCHIVE])
        self.assertIn('provider_index=2 reason=historical_state_unavailable', logged.output[0])

    def test_without_an_archive_old_state_is_still_asked_of_the_node(self):
        node, rpc = self.anchored(BEYOND, routes=(LOOPBACK, LOCAL))
        with self.assertLogs('rpc_failover', level='WARNING'), self.assertRaisesRegex(DataError, '^rpc_error$'):
            rpc.request('eth_getCode', [ZERO, '0x20'])
        self.assertEqual(state_calls(node, 'eth_getCode'), [LOOPBACK, LOCAL])

    def test_a_proxy_that_is_down_hands_each_operation_to_the_public_route(self):
        node = Node(down=(LOOPBACK,))
        rpc = HistoricalReadRpc(ROUTES, transport=node)
        for number in (0x20, 0x21):
            with self.assertLogs('rpc_failover', level='WARNING') as logged:
                self.assertEqual(rpc.request('eth_getBlockByNumber', [hex(number), False]), header(number))
            self.assertIn('provider_index=1 reason=network_unavailable', logged.output[0])
            self.assertEqual(node.calls[-1], (LOCAL, 'eth_getBlockByNumber', [hex(number), False]))


class SnapshotTests(unittest.TestCase):
    def test_a_proxy_primary_reads_the_snapshot_from_the_node_and_never_falls_back(self):
        for opt_in in (False, True):
            service = ReadService(rpc_urls=ROUTES, snapshot_rpc_version=4, snapshot_loopback=opt_in)
            with patch('read_service.sequence_snapshot', side_effect=lambda rpc, *_: rpc):
                rpc = service.sequence_snapshot(OWNER)
            self.assertEqual(rpc.url, LOOPBACK)
            self.assertNotIsInstance(rpc, FailoverReadRpc)
            with patch('discovery._LOOPBACK_JSON_OPENER', return_value=io.BytesIO(CHAIN)) as loopback:
                self.assertEqual(rpc.request('eth_chainId'), hex(CHAIN_ID))
            loopback.assert_called_once()
        for primary in ('http://127.0.0.1:8547/', 'http://localhost:18547/', ARCHIVE):
            service = ReadService(rpc_urls=(primary, LOCAL), snapshot_rpc_version=4)
            with self.subTest(primary=primary), patch('read_service.sequence_snapshot') as read, \
                 self.assertRaisesRegex(DataError, '^upstream_unavailable$'):
                service.sequence_snapshot(OWNER)
            read.assert_not_called()


class ConsumerTests(unittest.TestCase):
    def test_the_reader_leads_with_the_proxy_for_current_and_old_reads(self):
        from read_api import create_app
        with patch('read_api.load_config', return_value=checked_config(provider_file())), \
             patch('read_api.configured_catalogue', return_value=None), \
             patch('read_api.ReadService') as service, patch.dict(os.environ, {}, clear=True):
            create_app()
        self.assertEqual(service.call_args.kwargs['rpc_urls'], ROUTES)
        self.assertEqual(service.call_args.kwargs['historical_rpc_urls'], ROUTES)

    def test_the_queue_worker_and_the_catalogue_follower_lead_with_the_proxy(self):
        import manage_activity, manage_catalogue
        config = checked_config(provider_file())
        with tempfile.TemporaryDirectory() as directory:
            for module, arguments in ((manage_catalogue, ['index']), (manage_activity, ['--pool-id', POOL])):
                with self.subTest(module=module.__name__), \
                     patch.object(module, 'load_config', return_value=config), \
                     patch.object(module, 'configured_writer_catalogue', return_value=MagicMock()), \
                     patch.object(module, 'ReadRpc', side_effect=DataError('offline_stop')) as rpc, \
                     patch.dict(os.environ, {}, clear=True), \
                     patch.object(sys, 'argv', ['manage', *arguments, '--max-steps', '1',
                                                '--output', str(Path(directory) / module.__name__)]), \
                     redirect_stdout(io.StringIO()) as printed:
                    self.assertEqual(module.main(), 1)
                    self.assertEqual(rpc.call_args.args[0], ROUTES)
                    self.assertNotIn('SYNTHETIC', printed.getvalue())

    def test_v2_counts_both_paths_to_the_node_as_pruned_and_sends_the_proxy_its_hop(self):
        from v2_chains import load_registry
        from v2_rpc import configured_endpoints
        robinhood = load_registry().chains[0]
        self.assertEqual(robinhood.chainId, CHAIN_ID)
        endpoints = configured_endpoints(robinhood, provider_config=checked_config(provider_file()))
        self.assertEqual([(e.name, e.host, e.url, e.state_blocks) for e in endpoints.endpoints], [
            ('local', '127.0.0.1', LOOPBACK, LOCAL_STATE_BLOCKS),
            ('fallback-1', 'rpc.domino.money', LOCAL, LOCAL_STATE_BLOCKS),
            ('fallback-2', 'robinhood-mainnet.g.alchemy.com', ARCHIVE, None)])
        with patch('discovery._LOOPBACK_JSON_OPENER', return_value=io.BytesIO(CHAIN)) as loopback:
            answer = endpoints(LOOPBACK, {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_chainId', 'params': []})
        self.assertEqual(answer['result'], hex(CHAIN_ID))
        loopback.assert_called_once()


class OperatorSwitchTests(unittest.TestCase):
    def setUp(self):
        import configure_rpc
        self.module = configure_rpc
        self.public_first = checked_config(provider_file(rpcUrl=LOCAL, rpcFallbackUrls=[ARCHIVE]))

    def test_the_switch_moves_only_the_lead(self):
        on = self.module.prepare_node_loopback(self.public_first, True)
        self.assertEqual(on, checked_config(provider_file()))
        self.assertEqual(self.module.prepare_node_loopback(on, False), self.public_first)
        for data, enabled in ((self.public_first, False), (on, True)):
            with self.subTest(enabled=enabled), self.assertRaisesRegex(DataError, '^node_loopback_unchanged$'):
                self.module.prepare_node_loopback(data, enabled)
        legacy = {'version': 2, 'rpcUrl': LOCAL, 'rpcFallbackUrls': [ARCHIVE],
                  'rpcAllowedHosts': ['robinhood-mainnet.g.alchemy.com', 'rpc.domino.money'], 'inventoryUrl': None}
        for existing in ({}, legacy):
            with self.assertRaisesRegex(DataError, '^local_first_rpc_required$'):
                self.module.prepare_node_loopback(existing, True)
        # Three routes are the most a file holds; the switch drops none to make room.
        full = checked_config({**self.public_first, 'rpcFallbackUrls': [ARCHIVE, SECOND],
                               'rpcAllowedHosts': [*self.public_first['rpcAllowedHosts'], 'secondary.example.invalid']})
        with self.assertRaisesRegex(DataError, '^invalid_rpc_fallback_urls$'):
            self.module.prepare_node_loopback(full, True)

    def test_rotating_the_node_token_keeps_the_proxy_in_the_lead(self):
        on = checked_config(provider_file())
        rotated = self.module.prepare_local_config(on, 'SYNTHETIC_ROTATED_TOKEN_0456')
        self.assertEqual((rotated['rpcUrl'], rotated['rpcFallbackUrls']),
                         (LOOPBACK, ['https://rpc.domino.money/SYNTHETIC_ROTATED_TOKEN_0456/', ARCHIVE]))
        self.assertNotIn('127.0.0.1', rotated['rpcAllowedHosts'])
        self.assertEqual(self.module.prepare_local_config(self.public_first, 'SYNTHETIC_ROTATED_TOKEN_0456'),
                         self.module.prepare_node_loopback(rotated, False))

    def run_switch(self, path, *arguments, probe=None, tty=False):
        with patch.object(self.module, 'probe_endpoints', probe or Mock()) as probed, \
             patch.object(sys.stdin, 'isatty', return_value=tty), \
             patch.object(sys, 'argv', ['configure_rpc.py', '--config-file', str(path), *arguments]), \
             redirect_stdout(io.StringIO()) as printed:
            code = self.module.main()
        self.assertNotIn('SYNTHETIC', printed.getvalue())
        self.assertNotIn('127.0.0.1', printed.getvalue())
        return code, probed, printed.getvalue()

    def test_the_command_probes_only_a_new_lead_needs_no_terminal_and_prints_no_route(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'providers.json'
            save_config(self.public_first, path)
            code, probed, _ = self.run_switch(path, '--node-loopback', 'on')
            self.assertEqual(code, 0)
            probed.assert_called_once_with([LOOPBACK])
            self.assertEqual(load_config(path), checked_config(provider_file()))
            # Giving the lead back probes nothing: the public route was the lead before.
            code, _, printed = self.run_switch(path, '--node-loopback', 'off',
                                               probe=Mock(side_effect=AssertionError('probed')))
            self.assertEqual(code, 0)
            self.assertEqual(load_config(path), self.public_first)
            # A failed probe saves nothing.
            code, _, printed = self.run_switch(path, '--node-loopback', 'on',
                                               probe=Mock(side_effect=DataError('network_unavailable')))
            self.assertEqual((code, printed.strip()), (1, 'Configuration not saved. Code: network_unavailable'))
            self.assertEqual(load_config(path), self.public_first)
            # Hidden input still needs a terminal.
            code, probed, printed = self.run_switch(path)
            self.assertEqual(code, 1)
            self.assertIn('interactive terminal', printed)
            probed.assert_not_called()


if __name__ == '__main__':
    unittest.main()
