"""A private current source must not replace archive or Alchemy capabilities."""
from copy import deepcopy
from contextlib import redirect_stdout
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from configure_rpc import prepare_config, prepare_local_config
from discovery import DataError, ReadRpc, RpcStateUnavailable, rpc_failure
from local_config import checked_config, load_config, save_config
from rpc_config import (DEFAULT_RPC_HOSTS, configured_history_rpc_url, configured_history_rpc_urls,
                        configured_inventory_url, configured_rpc_urls, rpc_endpoint)
from rpc_failover import FailoverReadRpc
from read_service import ReadService
from test_rpc_providers import ALCHEMY, BLOCK, Provider, RPC_URL, SECOND, TOKEN

LOCAL = 'https://rpc.domino.money/SYNTHETIC_LOCAL_TOKEN_123/'
MISSING = {'code': -32000, 'message': 'missing trie node ' + 'a' * 64 +
           ' (path 0001) state ' + 'b' * 64 + ' is not available'}


class LocalConfigTests(unittest.TestCase):
    def config(self):
        return prepare_local_config({'version': 1, 'rpcUrl': ALCHEMY,
                                     'inventoryUrl': ALCHEMY}, 'SYNTHETIC_LOCAL_TOKEN_123')

    def test_upgrade_roundtrip_prefers_local_for_current_and_history_preserves_inventory(self):
        data = self.config()
        self.assertEqual(configured_rpc_urls(data), (LOCAL, ALCHEMY))
        self.assertEqual(configured_history_rpc_urls(data), (LOCAL, ALCHEMY))
        self.assertEqual(configured_inventory_url(data), ALCHEMY)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'providers.json'
            save_config(data, path)
            self.assertEqual(load_config(path), data)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_snapshot_loopback_opt_in_is_v4_only_and_boolean(self):
        current = self.config()
        self.assertEqual(current['version'], 4)
        self.assertEqual(checked_config({**current, 'sequenceSnapshotLoopback': True})
                         ['sequenceSnapshotLoopback'], True)
        self.assertEqual(checked_config({**current, 'sequenceSnapshotLoopback': False})
                         ['sequenceSnapshotLoopback'], False)
        for bad in (None, 1, 'true', 'http://127.0.0.1:18547/'):
            with self.subTest(bad=bad), self.assertRaisesRegex(
                    DataError, '^invalid_local_provider_config$'):
                checked_config({**current, 'sequenceSnapshotLoopback': bad})
        with self.assertRaisesRegex(DataError, '^invalid_local_provider_config$'):
            checked_config({**current, 'version': 2, 'sequenceSnapshotLoopback': True})

    def test_rotation_preserves_sources_and_never_falls_back_to_old_token(self):
        old = self.config()
        data = prepare_local_config(old, 'SYNTHETIC_ROTATED_TOKEN')
        self.assertNotEqual(data['rpcUrl'], old['rpcUrl'])
        self.assertEqual(data['rpcFallbackUrls'], [ALCHEMY])
        self.assertNotIn('historicalRpcUrl', data)
        self.assertEqual(data['inventoryUrl'], ALCHEMY)
        changed = prepare_config(data, [data['rpcUrl'], SECOND])
        self.assertEqual(changed['version'], 4)
        self.assertEqual(configured_history_rpc_urls(changed), (data['rpcUrl'], SECOND))

    def test_history_and_token_must_be_explicit_valid_and_private(self):
        for token in ('', 'short', '../' * 20, 'a' * 257, 'a' * 20 + '\n'):
            with self.subTest(token_length=len(token)), self.assertRaises(DataError) as error:
                prepare_local_config({'rpcUrl': ALCHEMY}, token)
            self.assertEqual(str(error.exception), 'invalid_local_rpc_token')
        with self.assertRaisesRegex(DataError, '^historical_rpc_required$'):
            prepare_local_config({}, 'SYNTHETIC_LOCAL_TOKEN_123')
        data = self.config()
        for bad in (None, LOCAL, 'http://127.0.0.1:8547'):
            data['historicalRpcUrl'] = bad
            with self.assertRaises(DataError):
                checked_config(data)
        for bad in (LOCAL.rstrip('/'), LOCAL + '?key=x', LOCAL + 'extra',
                    LOCAL.replace('rpc.domino.money', 'ws.domino.money'),
                    LOCAL.replace('https:', 'http:'), LOCAL.replace('/SYNTHETIC', ':443/SYNTHETIC')):
            with self.assertRaises(DataError):
                rpc_endpoint(bad)

    def test_override_does_not_replace_history_or_inventory(self):
        data = self.config()
        self.assertEqual(configured_rpc_urls(data, RPC_URL), (RPC_URL,))
        self.assertEqual(configured_history_rpc_urls(data), (LOCAL, ALCHEMY))
        self.assertEqual(configured_inventory_url(data), ALCHEMY)
        for missing in ({}, {'rpcUrl': ALCHEMY}, {'rpcUrl': LOCAL, 'inventoryUrl': None}):
            with self.assertRaisesRegex(DataError, '^configured_inventory_required$'):
                configured_inventory_url(missing)

    def test_inventory_rotation_preserves_v4_routes(self):
        import configure_inventory as module
        data = self.config()
        with patch.object(module, 'load_config', return_value=data), \
             patch.object(module, 'save_config') as save, \
             patch.object(module, 'DiscoveryReader', autospec=True), \
             patch.object(module, 'AlchemyInventory') as inventory, \
             patch.object(module.getpass, 'getpass', return_value='fixture-rotated'), \
             patch.object(sys.stdin, 'isatty', return_value=True), \
             patch.object(sys, 'argv', ['configure_inventory.py']), redirect_stdout(io.StringIO()) as printed:
            inventory.return_value.page.return_value = {'currencies': []}
            self.assertEqual(module.main(), 0)
        saved = save.call_args.args[0]
        self.assertEqual(saved, {**data, 'inventoryUrl':
            'https://robinhood-mainnet.g.alchemy.com/v2/fixture-rotated'})
        self.assertNotIn('fixture-rotated', printed.getvalue())
        self.assertNotIn(data['rpcUrl'], printed.getvalue())

    def test_api_injects_both_sources_without_network(self):
        from read_api import create_app
        with patch('read_api.load_config', return_value=self.config()), \
             patch('read_api.configured_catalogue', return_value=None), \
             patch('read_api.ReadService') as service, patch.dict('os.environ', {}, clear=True):
            create_app()
        self.assertEqual(service.call_args.kwargs['rpc_urls'], (LOCAL, ALCHEMY))
        self.assertIs(service.call_args.kwargs['snapshot_loopback'], False)
        self.assertEqual(service.call_args.kwargs['historical_rpc_urls'], (LOCAL, ALCHEMY))
        self.assertEqual(service.call_args.kwargs['inventory_url'], ALCHEMY)

    def test_api_uses_private_v4_snapshot_loopback_opt_in(self):
        from read_api import create_app
        config = {**self.config(), 'sequenceSnapshotLoopback': True}
        with patch('read_api.load_config', return_value=config), \
             patch('read_api.configured_catalogue', return_value=None), \
             patch('read_api.ReadService') as service, patch.dict('os.environ', {}, clear=True):
            create_app()
        self.assertIs(service.call_args.kwargs['snapshot_loopback'], True)
        self.assertEqual(service.call_args.kwargs['rpc_urls'], (LOCAL, ALCHEMY))

    def test_nft_explicit_block_uses_archive_current_uses_local(self):
        # Exercise the public method's factory selection, not only its helper.
        from test_nft_ownership import NftRpc
        selected = []
        def factory(urls, **kwargs):
            selected.append(tuple(urls))
            return NftRpc()
        service = ReadService(rpc_urls=(LOCAL, ALCHEMY), historical_rpc_url=ALCHEMY,
                              clock=lambda: 1010)
        with patch('read_service.FailoverReadRpc', side_effect=factory), \
             patch('read_service.HistoricalReadRpc', side_effect=factory):
            current = service.nft_positions(['1'])
            historic = service.nft_positions(['1'], 699)
        self.assertEqual(selected, [(LOCAL, ALCHEMY), (ALCHEMY,)])
        self.assertNotEqual(current['items'][0]['owner'], historic['items'][0]['owner'])

    def test_pool_positions_resolves_stored_snapshot_on_separate_archive(self):
        from discovery import Block
        from nft_ownership import read_identity
        from test_nft_ownership import NftRpc

        archive = NftRpc()
        block = Block(699, '0x' + (699).to_bytes(32, 'big').hex(), 999)
        identity = read_identity(archive, '1', block)
        core = {field: identity[field] for field in
                ('corePositionId', 'coreOwner', 'tickLower', 'tickUpper', 'salt', 'liquidityRaw')}
        report = {'mode': 'core_pool_activity_read_only', 'chainId': 4663,
                  'poolId': identity['poolId'], 'poolKey': identity['poolKey'],
                  'snapshot': {'number': block.number, 'hash': block.hash, 'timestamp': block.timestamp},
                  'coverage': {}, 'freshness': {},
                  'liquidity': {'positionAccounting': {'status': 'reconciled_as_of', 'items': [core]}}}
        archive.recorded.clear()
        selected = []

        def factory(urls, **kwargs):
            selected.append(tuple(urls))
            # Archive is deliberately absent from the current-read fallbacks.
            self.assertEqual(tuple(urls), (ALCHEMY,))
            return archive

        service = ReadService(rpc_urls=(LOCAL,), historical_rpc_url=ALCHEMY, clock=lambda: 1010)
        with patch.object(service, 'pool_activity', return_value=report) as activity, \
             patch('read_service.FailoverReadRpc', side_effect=factory), \
             patch('read_service.HistoricalReadRpc', side_effect=factory):
            result = service.pool_positions(identity['poolId'])

        activity.assert_called_once_with(identity['poolId'], include_positions=True)
        self.assertEqual(selected, [(ALCHEMY,)])
        self.assertEqual(result['snapshot']['number'], 699)
        self.assertEqual(result['positionAccounting']['items'][0]['nft']['owner'], archive.historical_owners[699])
        self.assertNotEqual(result['positionAccounting']['items'][0]['nft']['owner'], archive.owner)
        self.assertEqual([tag for method, tag in archive.recorded if method == 'ownerOf(uint256)'], [hex(699)])
        self.assertTrue(result['positionAccounting']['nftOwnershipResolved'])
        self.assertEqual(archive.max_requests, 600)


class RecoveringProvider(Provider):
    def __init__(self, *, state_error=MISSING):
        super().__init__()
        self.state_error = state_error

    def __call__(self, url, body):
        if isinstance(body, list):
            return [self(url, item) for item in reversed(body)]
        if url == LOCAL and body['method'] in ('eth_call', 'eth_getCode', 'eth_getBalance'):
            self.calls.append((url, body['method'], deepcopy(body['params'])))
            return {'jsonrpc': '2.0', 'id': body['id'], 'error': self.state_error}
        return super().__call__(url, body)


class LocalFailureTests(unittest.TestCase):
    def test_tunnel_530_recovers_with_chain_and_hash_proofs(self):
        provider = Provider()
        rpc = FailoverReadRpc((LOCAL, ALCHEMY), transport=provider)
        rpc.request('eth_getBlockByNumber', ['latest', False])
        provider.fail[(LOCAL, 'eth_getBalance')] = 'http_530'
        self.assertEqual(rpc.request('eth_getBalance', [TOKEN, '0xa']), '0x5')
        self.assertEqual([m for u, m, _ in provider.calls if u == ALCHEMY],
                         ['eth_chainId', 'eth_getBlockByNumber', 'eth_getBalance'])
        self.assertEqual(rpc.count, len(provider.calls))

    def test_pruned_state_scalar_and_batch_preserve_same_block_and_budget(self):
        for batch in (False, True):
            provider = RecoveringProvider()
            rpc = FailoverReadRpc((LOCAL, ALCHEMY), transport=provider)
            rpc.request('eth_getBlockByNumber', ['latest', False])
            result = (rpc.batch([('eth_getBalance', [TOKEN, '0xa'])], item_errors=True)[0]
                      if batch else rpc.request('eth_getBalance', [TOKEN, '0xa']))
            self.assertEqual(result, '0x5')
            self.assertEqual(rpc.count, len(provider.calls))
            self.assertEqual(rpc.index, 1)
            self.assertTrue(all(params[-1] == '0xa' for _, method, params in provider.calls
                                if method == 'eth_getBalance'))

    def test_pruned_fallback_refuses_changed_chain_block_and_budget(self):
        for failure in ('wrong_chain', 'snapshot_reorganized', 'request_budget_exhausted'):
            provider = RecoveringProvider()
            rpc = FailoverReadRpc((LOCAL, ALCHEMY), transport=provider,
                                  max_requests=4 if failure == 'request_budget_exhausted' else 160)
            rpc.request('eth_getBlockByNumber', ['latest', False])
            if failure == 'wrong_chain':
                provider.chains[ALCHEMY] = 1
            if failure == 'snapshot_reorganized':
                provider.blocks[ALCHEMY] = {**BLOCK, 'hash': '0x' + 'b' * 64}
            with self.assertRaisesRegex(DataError, '^' + failure + '$'):
                rpc.request('eth_getBalance', [TOKEN, '0xa'])
            with self.assertRaisesRegex(DataError, '^' + failure + '$'):
                rpc.request('eth_chainId')
            self.assertFalse(any(url == ALCHEMY and method == 'eth_getBalance'
                                 for url, method, _ in provider.calls))

    def test_reverts_unknown_errors_and_structured_data_do_not_retry(self):
        for error in ({'code': 3, 'message': MISSING['message']},
                      {'code': -32000, 'message': 'execution reverted: ' + MISSING['message']},
                      {**MISSING, 'data': '0x1234'}, {**MISSING, 'data': {'error': 'x'}},
                      {'code': -32000, 'message': 'historical request failed'}):
            provider = RecoveringProvider(state_error=error)
            rpc = FailoverReadRpc((LOCAL, ALCHEMY), transport=provider)
            rpc.request('eth_getBlockByNumber', ['latest', False])
            with self.assertRaises(DataError):
                rpc.request('eth_call', [{}, '0xa'])
            self.assertEqual(rpc.index, 0)

    def test_pruned_failure_is_sanitized_and_poisons_exhausted_read(self):
        rpc = FailoverReadRpc((LOCAL,), transport=RecoveringProvider())
        rpc.request('eth_getBlockByNumber', ['latest', False])
        with self.assertRaisesRegex(RpcStateUnavailable, '^rpc_error$'):
            rpc.request('eth_getCode', [TOKEN, '0xa'])
        with self.assertRaisesRegex(DataError, '^rpc_error$'):
            rpc.request('eth_chainId')
        self.assertEqual(str(rpc_failure('eth_call', MISSING)), 'rpc_error')

    def test_scalar_wrong_requested_block_is_fatal(self):
        rpc = FailoverReadRpc((LOCAL, ALCHEMY), transport=Provider())
        with self.assertRaisesRegex(DataError, '^snapshot_reorganized$'):
            rpc.request('eth_getBlockByNumber', ['0xb', False])
        self.assertEqual(rpc.index, 0)

    def test_pruned_batch_cannot_mask_invalid_chain_or_header(self):
        for item_errors in (False, True):
            for assertion in ('chain', 'header'):
                provider = RecoveringProvider()
                rpc = FailoverReadRpc((LOCAL, ALCHEMY), transport=provider)
                rpc.request('eth_getBlockByNumber', ['latest', False])
                calls = [('eth_getBalance', [TOKEN, '0xa'])]
                if assertion == 'chain':
                    provider.chains[LOCAL] = 1
                    calls.append(('eth_chainId', []))
                    expected = 'wrong_chain'
                else:
                    provider.blocks[LOCAL] = {**BLOCK, 'hash': '0x' + 'b' * 64}
                    calls.append(('eth_getBlockByNumber', ['0xa', False]))
                    expected = 'snapshot_reorganized'
                with self.assertRaisesRegex(DataError, '^' + expected + '$'):
                    rpc.batch(calls, item_errors=item_errors)
                self.assertEqual(rpc.index, 0)
                self.assertFalse(any(url == ALCHEMY for url, _, _ in provider.calls))


if __name__ == '__main__':
    unittest.main()
