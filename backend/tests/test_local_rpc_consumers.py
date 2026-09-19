"""Mixed provider configuration: local current reads, archive state, Alchemy APIs.

Every URL below is synthetic; no RPC, database or private configuration is read.
The assertions exercise CLI/service composition rather than just config helpers.
"""
from argparse import Namespace
from contextlib import redirect_stdout
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import MagicMock, Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from discovery import Block, DataError, RPC_URL, ZERO
from price_history import iso
from rpc_config import DEFAULT_RPC_HOSTS

LOCAL_TOKEN = 'SYNTHETIC_LOCAL_CREDENTIAL_0123456789'
LOCAL = 'https://rpc.domino.money/' + LOCAL_TOKEN + '/'
ALCHEMY = 'https://robinhood-mainnet.g.alchemy.com/v2/fixture-inventory'
ARCHIVE = 'https://robinhood-mainnet.g.alchemy.com/v2/fixture-archive'
POOL = '0x' + 'ab' * 32
WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
HEAD = Block(1000, '0x' + 'cd' * 32, 2000)


def provider_config():
    return {'version': 3, 'rpcUrl': LOCAL, 'rpcFallbackUrls': [RPC_URL],
            'rpcAllowedHosts': list(dict.fromkeys([*DEFAULT_RPC_HOSTS, 'rpc.domino.money'])),
            'inventoryUrl': ALCHEMY, 'historicalRpcUrl': ARCHIVE}


class ConsumerRoutingTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.environment = patch.dict(os.environ, {}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def assert_private(self, value):
        rendered = value if isinstance(value, str) else json.dumps(value)
        for secret in (LOCAL_TOKEN, 'fixture-inventory', 'fixture-archive'):
            self.assertNotIn(secret, rendered)

    def test_discovery_uses_local_primary_and_ordered_fallback_without_disclosing_them(self):
        import qualify_discovery as module
        report = {'pools': [], 'unverifiedCandidates': [], 'metricsQualified': False,
                  'walletInventory': {'status': 'not_requested'}}
        output = self.root / 'discovery.json'
        with patch.object(module, 'load_config', return_value=provider_config()), \
             patch.object(module, 'discover', return_value=report) as discover, \
             patch.object(sys, 'argv', ['probe', '--token', ZERO, '--output', str(output)]), \
             redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(module.main(), 0)
        self.assertEqual(discover.call_args.kwargs['rpc'].urls, (LOCAL, RPC_URL))
        self.assert_private(output.read_text())
        self.assert_private(printed.getvalue())

    def test_current_override_is_validated_before_discovery_can_dispatch(self):
        import qualify_discovery as module
        with patch.object(module, 'load_config', return_value=provider_config()), \
             patch.object(module, 'discover') as discover, \
             patch.dict(os.environ, {'DOMINO_DISCOVERY_RPC_URL': 'https://unlisted.invalid/private'}), \
             patch.object(sys, 'argv', ['probe', '--token', ZERO, '--output', str(self.root / 'out')]), \
             redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(module.main(), 1)
        discover.assert_not_called()
        self.assertEqual(json.loads(printed.getvalue())['reason'], 'invalid_rpc_url')
        self.assertNotIn('unlisted.invalid', printed.getvalue())

    def test_alchemy_reference_collection_keeps_the_inventory_credential(self):
        import collect_reference_prices as module
        destinations = []
        def transport(url, body):
            destinations.append(url)
            return {'network': body['network'], 'address': body['address'], 'currency': 'usd',
                    'data': [{'timestamp': iso(600), 'value': '2500.5'}]}
        args = Namespace(currency=WETH, provider=None, start=300, end=900,
                         provider_config=None, store=False, output=None, decimals=None)
        with patch.object(module, 'load_config', return_value=provider_config()):
            result = module.collect(args, transport=transport, clock=lambda: 1000, emit=False)
        self.assertEqual(destinations, [
            'https://api.g.alchemy.com/prices/v1/fixture-inventory/tokens/historical'])
        self.assertEqual(result['observations'], 1)
        self.assertFalse(result['productionQualification'])
        self.assert_private(result)

    def test_missing_inventory_never_sends_the_local_secret_to_alchemy(self):
        import collect_reference_prices as module
        config = provider_config(); config['inventoryUrl'] = None
        args = Namespace(currency=WETH, provider=None, start=300, end=900,
                         provider_config=None, store=False, output=None, decimals=None)
        transport = Mock()
        with patch.object(module, 'load_config', return_value=config), \
             self.assertRaisesRegex(DataError, '^configured_inventory_required$'):
            module.collect(args, transport=transport, emit=False)
        transport.assert_not_called()

    def test_market_reference_qualification_selects_inventory_not_chain_rpc(self):
        import qualify_market_reference as module
        with patch.object(module, 'load_config', return_value=provider_config()), \
             patch.object(module, 'CanonicalMarketHistorical') as history:
            history.return_value.fetch.return_value = {'status': 'unqualified'}
            result = module.qualify(WETH, 300, 900, provider_config=self.root / 'unused')
        self.assertEqual(history.call_args.args[0], ALCHEMY)
        self.assertEqual(result, {'status': 'unqualified'})

    def test_metrics_separates_historical_state_and_external_prices(self):
        import manage_metrics as module
        catalogue = MagicMock()
        catalogue.connection.return_value.__enter__.return_value.execute.return_value.fetchone.return_value = None
        metrics = {'capital': {'fromTimestampInclusive': 600, 'throughTimestamp': 900},
                   'poolKey': {'currency0': WETH, 'currency1': USDG}}
        with patch.object(module, 'load_config', return_value=provider_config()), \
             patch.object(module, 'configured_writer_catalogue', return_value=catalogue), \
             patch.object(module, 'PgActivity'), patch.object(module, 'ReadRpc') as rpc, \
             patch.object(module, 'CapitalIndexer') as worker, \
             patch.object(module, 'stored_metrics', return_value=metrics), \
             patch.object(module, 'AlchemyHistorical') as prices, \
             patch.object(module, 'store_observations'), redirect_stdout(io.StringIO()) as printed:
            worker.return_value.step.return_value = {'status': 'caught_up_to_activity'}
            prices.return_value.fetch.return_value = []
            result = module.run(POOL, 1, True)
        self.assertEqual(rpc.call_args.args[0], ARCHIVE)
        self.assertEqual([call.args[0] for call in prices.call_args_list], [ALCHEMY, ALCHEMY])
        self.assert_private(result)
        self.assert_private(printed.getvalue())

    def test_fee_and_position_replay_use_archive_while_preserving_worker_budgets(self):
        import manage_fees, manage_positions
        for module, name, budget in ((manage_fees, 'FeeIndexer', 60),
                                      (manage_positions, 'PositionIndexer', 160)):
            with self.subTest(module=module.__name__):
                output = self.root / (name + '.json')
                with patch.object(module, 'load_config', return_value=provider_config()), \
                     patch.object(module, 'configured_writer_catalogue', return_value=MagicMock()), \
                     patch.object(module, 'DiscoveryReader'), patch.object(module, 'ReadRpc') as rpc, \
                     patch.object(module, 'PgActivity') as store, patch.object(module, name) as worker, \
                     patch.object(sys, 'argv', ['manage', '--pool-id', POOL, '--max-steps', '1',
                                               '--output', str(output)]), redirect_stdout(io.StringIO()):
                    worker.return_value.step.return_value = {'status': 'caught_up_to_activity'}
                    store.return_value.read.return_value = {'status': 'partial'}
                    self.assertEqual(module.main(), 0)
                self.assertEqual([call.args[0] for call in rpc.call_args_list], [ARCHIVE, ARCHIVE])
                self.assertEqual(rpc.call_args.kwargs['max_requests'], budget)
                self.assert_private(output.read_text())

    def test_catalogue_current_seed_and_historical_index_choose_distinct_sources(self):
        import manage_catalogue as module
        for action, expected in [('seed', LOCAL), ('index', ARCHIVE)]:
            with self.subTest(action=action):
                argv = (['manage', 'seed', '--pool-id', POOL] if action == 'seed' else
                        ['manage', 'index', '--max-steps', '1', '--output', str(self.root / 'index.json')])
                with patch.object(module, 'load_config', return_value=provider_config()), \
                     patch.object(module, 'configured_writer_catalogue', return_value=MagicMock()), \
                     patch.object(module, 'ReadRpc') as rpc, patch.object(module, 'DiscoveryReader') as reader, \
                     patch.object(module, 'IndexRpc') as index_rpc, patch.object(module, 'CatalogueIndexer') as worker, \
                     patch.dict(os.environ, {'DOMINO_DISCOVERY_RPC_URL': LOCAL}), \
                     patch.object(sys, 'argv', argv), redirect_stdout(io.StringIO()):
                    reader.return_value.snapshot.return_value = HEAD
                    reader.return_value.pool.return_value = {'poolId': POOL}
                    reader.return_value.assert_canonical = Mock()
                    worker.return_value.step.return_value = {'status': 'caught_up_to_target'}
                    self.assertEqual(module.main(), 0)
                self.assertEqual(rpc.call_args.args[0], expected)
                if action == 'index': self.assertEqual(index_rpc.call_args.args[0], ARCHIVE)

    def test_activity_registration_stays_local_but_replay_keeps_archive_even_with_override(self):
        import manage_activity as module
        for action, expected in [('register', LOCAL), ('replay', ARCHIVE)]:
            with self.subTest(action=action):
                argv = ['manage', '--pool-id', POOL]
                argv += (['--register'] if action == 'register' else
                         ['--max-steps', '1', '--output', str(self.root / 'activity.json')])
                with patch.object(module, 'load_config', return_value=provider_config()), \
                     patch.object(module, 'configured_writer_catalogue', return_value=MagicMock()), \
                     patch.object(module, 'PgActivity') as store, patch.object(module, 'ReadRpc'), \
                     patch.object(module, 'DiscoveryReader') as reader, patch.object(module, 'IndexRpc') as rpc, \
                     patch.object(module, 'ActivityIndexer') as worker, \
                     patch.dict(os.environ, {'DOMINO_DISCOVERY_RPC_URL': LOCAL}), \
                     patch.object(sys, 'argv', argv), redirect_stdout(io.StringIO()):
                    reader.return_value.snapshot.return_value = HEAD
                    worker.return_value.register.return_value = {'status': 'registered'}
                    worker.return_value.step.return_value = {'status': 'caught_up_to_target'}
                    store.return_value.read.return_value = {'status': 'partial'}
                    self.assertEqual(module.main(), 0)
                self.assertEqual(rpc.call_args.args[0], expected)

    def test_chainlink_uses_default_private_config_and_archive_without_implicit_public_probe(self):
        import qualify_chainlink as module
        with patch.object(module, 'load_config', return_value=provider_config()) as load, \
             patch.object(module, 'ReadRpc', side_effect=DataError('offline_stop')) as rpc, \
             self.assertRaisesRegex(DataError, '^offline_stop$'):
            module.qualify(POOL, 1)
        load.assert_called_once_with()
        self.assertEqual(rpc.call_args.args[0], ARCHIVE)

    def test_chainlink_checkpoint_factory_keeps_archive_for_resuming_old_state(self):
        import collect_chainlink as module
        args = Namespace(currency=ZERO, start=300, end=900, max_steps=1, slice_seconds=10,
                         checkpoint=self.root / 'checkpoint.json', block_number=None,
                         provider_config=None, store_observations=False)
        with patch.object(module, 'RUNTIME', self.root), \
             patch.object(module, 'load_config', return_value=provider_config()) as load, \
             patch.object(module, 'ReadRpc', side_effect=DataError('offline_stop')) as rpc, \
             self.assertRaisesRegex(DataError, '^offline_stop$'):
            module.collect(args)
        load.assert_called_once_with()
        self.assertEqual(rpc.call_args.args[0], ARCHIVE)


    def test_current_http_qualification_uses_local_rpc_with_fallback(self):
        import qualify_read_api as module
        with patch.object(module, 'load_config', return_value=provider_config()), \
             patch.object(module, 'request', return_value={'chainId': 4663, 'automation': False, 'feeCollection': False}), \
             patch.object(module, 'DiscoveryReader', side_effect=DataError('offline_stop')) as reader, \
             patch.object(sys, 'argv', ['probe', '--position-id', '1', '--output', str(self.root / 'read.json')]), \
             redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(module.main(), 1)
        self.assertEqual(reader.call_args.args[0].urls, (LOCAL, RPC_URL))
        self.assert_private(printed.getvalue())

    def test_fork_qualification_pins_source_on_archive_not_pruned_primary(self):
        import qualify_deposit_fork as module
        output = self.root / 'fork.json'
        with patch.object(module, 'load_config', return_value=provider_config()), \
             patch.object(module.uniswap_config, 'load_config', return_value={'apiKey': 'SYNTHETIC'}), \
             patch.object(module, 'ForkReadGateway', side_effect=DataError('offline_stop')) as gateway, \
             patch.object(module, 'DepositFork') as fork, redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(module.main(['--rpc-config', 'unused', '--uniswap-config', 'unused',
                                          '--output', str(output)]), 2)
        self.assertEqual(gateway.call_args.args[0], ARCHIVE)
        fork.assert_not_called()
        self.assert_private(printed.getvalue())
        self.assert_private(output.read_text())

    def test_configured_fee_benchmarks_use_archive_but_explicit_public_mode_stays_public(self):
        import benchmark_fee_steps as module
        for source, name, expected in [('configured-rpc', 'IndexRpc', ARCHIVE),
                                       ('configured-dense', 'BatchIndexRpc', ARCHIVE),
                                       ('public-rpc', 'IndexRpc', RPC_URL)]:
            with self.subTest(source=source):
                output = self.root / (source + '.json')
                with patch.object(module, 'load_config', return_value=provider_config()), \
                     patch.object(module, name, side_effect=DataError('offline_stop')) as rpc, \
                     redirect_stdout(io.StringIO()) as printed:
                    self.assertEqual(module.main(['--source', source, '--provider-config', 'unused',
                                                  '--output', str(output)]), 1)
                self.assertEqual(rpc.call_args.args[0], expected)
                self.assert_private(printed.getvalue())
                self.assert_private(output.read_text())


if __name__ == '__main__':
    unittest.main()
