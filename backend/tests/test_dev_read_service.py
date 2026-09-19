from copy import deepcopy
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from fastapi.testclient import TestClient
from discovery import DataError, CHAIN_ID
from dev_read_service import (DevelopmentReadService, DevelopmentCatalogue,
                              create_dev_app, checked_profile, load_profile, reader_lock, READS,
                              _DevelopmentConnection)
from read_deadline import read_deadline
from read_contract import CONTRACT_VERSION, validate_response
from test_discovery import TOKEN, OWNER, POOL, candidate
from test_nft_ownership import NftRpc
from test_read_contract import CatalogueFixture, MarketTransport
from test_read_rpc_batching import Provider


class DevelopmentReaderTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name).resolve()
        self.directory.chmod(0o700)
        runtime = self.directory / 'development-runtime'
        runtime.mkdir(mode=0o700)
        self.profile = {
            'version': 1, 'kind': 'domino-development-reader', 'enabled': True,
            'runtimeDirectory': str(runtime),
            'rpcUrls': ['https://rpc.mainnet.chain.robinhood.com'],
            'inventoryUrl': None, 'catalogue': None,
            'quotaQualification': {'approved': True, 'expiresAt': 2000, 'receiptSha256': 'a' * 64},
        }
        self.now, self.wall = [0.0], [1010]

    def write(self, data=None):
        path = self.directory / 'development-reader.json'
        path.write_text(json.dumps(self.profile if data is None else data))
        path.chmod(0o600)
        return path

    def service(self, transport=None):
        service = DevelopmentReadService(self.profile, transport=transport or MagicMock(),
                                        clock=lambda: self.wall[0], monotonic=lambda: self.now[0])
        self.now[0] += 60
        return service

    def test_private_profile_missing_invalid_permissions_duplicates_and_symlinks_fail_closed(self):
        path = self.write()
        self.assertEqual(load_profile(path), self.profile)
        path.chmod(0o644)
        with self.assertRaisesRegex(DataError, '^development_profile_unavailable$'): load_profile(path)
        path.chmod(0o600)
        link = self.directory / 'linked.json'
        link.symlink_to(path)
        with self.assertRaises(DataError): load_profile(link)
        with self.assertRaises(DataError): load_profile(self.directory / 'missing.json')
        linked_parent = self.directory / 'linked-parent'
        linked_parent.symlink_to(self.directory, target_is_directory=True)
        with self.assertRaises(DataError): load_profile(linked_parent / path.name)
        path.write_text('{"version":1,"version":1}')
        with self.assertRaises(DataError): load_profile(path)
        path.write_text(' ' * 8193)
        with self.assertRaises(DataError): load_profile(path)

    def test_no_profile_or_runtime_within_any_product_checkout(self):
        checkout = self.directory / 'another-checkout'
        (checkout / 'backend/runtime').mkdir(parents=True, mode=0o700)
        (checkout / 'AGENTS.md').write_text('test checkout')
        (checkout / 'backend/read_service.py').write_text('')
        profile = deepcopy(self.profile)
        profile['runtimeDirectory'] = str(checkout / 'backend/runtime')
        with self.assertRaises(DataError): checked_profile(profile)
        path = checkout / 'backend/runtime/providers.json'
        path.write_text(json.dumps(self.profile)); path.chmod(0o600)
        with self.assertRaises(DataError): load_profile(path)

    def test_provider_urls_schema_and_database_destination_are_explicit(self):
        cases = [
            ('rpcUrls', []), ('rpcUrls', ['http://localhost']),
            ('rpcUrls', ['https://other.invalid/private-key']),
            ('rpcUrls', ['https://rpc.mainnet.chain.robinhood.com?target=other']),
            ('inventoryUrl', 'https://rpc.mainnet.chain.robinhood.com'),
            ('inventoryUrl', 123),
            ('catalogue', {'host': 'remote.invalid', 'port': 5432, 'dbname': 'domino_catalogue'}),
            ('catalogue', {'host': '/run/postgresql', 'port': 5432, 'dbname': 'private_sessions'}),
        ]
        for key, value in cases:
            profile = deepcopy(self.profile); profile[key] = value
            with self.subTest(key=key), self.assertRaisesRegex(DataError, '^development_profile_unavailable$'):
                checked_profile(profile)
        profile = deepcopy(self.profile); profile['rpcUrl'] = 'private-canary'
        with self.assertRaises(DataError): checked_profile(profile)

    def test_domino_rpc_uses_shared_endpoint_validation_and_preserves_inventory(self):
        profile = deepcopy(self.profile)
        profile['rpcUrls'] = ['https://rpc.domino.money/SYNTHETIC_ONLY_0123456789/',
                              'https://rpc.mainnet.chain.robinhood.com',
                              'https://robinhood-mainnet.g.alchemy.com/v2/offline-fixture']
        profile['inventoryUrl'] = 'https://robinhood-mainnet.g.alchemy.com/v2/offline-inventory'
        self.assertEqual(checked_profile(profile), profile)
        for endpoint in ('https://rpc.domino.money/', 'https://rpc.domino.money/short/',
                         'https://rpc.domino.money/SYNTHETIC_ONLY_0123456789',
                         'wss://rpc.domino.money/SYNTHETIC_ONLY_0123456789/',
                         'https://rpc.domino.money.evil.example/SYNTHETIC_ONLY_0123456789/'):
            rejected = deepcopy(profile)
            rejected['rpcUrls'][0] = endpoint
            with self.subTest(endpoint=endpoint), self.assertRaisesRegex(DataError, '^development_profile_unavailable$'):
                checked_profile(rejected)
        profile['inventoryUrl'] = profile['rpcUrls'][0]
        with self.assertRaisesRegex(DataError, '^development_profile_unavailable$'):
            checked_profile(profile)

    def test_default_off_never_loads_provider_config_or_constructs_read_service(self):
        with (patch('read_api.load_config', side_effect=AssertionError('production config read')),
              patch('dev_read_service.DevelopmentReadService', side_effect=AssertionError('service created'))):
            client = TestClient(create_dev_app(), base_url='http://127.0.0.1:8890')
            for path in ('/health', '/v1/capabilities', '/v1/read/token'):
                response = client.get(path) if path != '/v1/read/token' else client.post(path, json={'token': TOKEN})
                self.assertEqual(response.status_code, 503)
            self.assertEqual(client.post('/v1/read/pool-positions', json={'poolId': POOL}).status_code, 404)

    def test_enable_requires_unexpired_operator_qualification(self):
        for enabled, approved, expires in ((False, True, 2000), (True, False, 2000), (True, True, 1010)):
            profile = deepcopy(self.profile); profile['enabled'] = enabled
            profile['quotaQualification'].update(approved=approved, expiresAt=expires)
            with self.assertRaisesRegex(DataError, 'qualification_required'):
                create_dev_app(profile, enable=True, clock=lambda: self.wall[0])
        with self.assertRaises(DataError): create_dev_app(enable=True)

    def test_real_bootstrap_uses_injected_transport_health_generation_and_old_browser_boundary(self):
        provider = Provider()
        def transport(url, body=None, **kwargs): return provider(url, body)
        client = TestClient(create_dev_app(self.profile, enable=True, transport=transport,
            clock=lambda: self.wall[0], monotonic=lambda: self.now[0]), base_url='http://127.0.0.1:8890')
        warming = client.get('/health')
        self.assertEqual(warming.status_code, 503)
        self.assertEqual(warming.json()['devAdmission'], {'state': 'cooldown', 'retryAfterSeconds': 60,
                          'startsPerMinute': 6, 'minimumStartIntervalSeconds': 2})
        self.now[0] = 60
        health = client.get('/health')
        self.assertEqual(health.json()['mode'], 'local_read_only')
        self.assertEqual(health.json()['readBudgetSeconds'], 15)
        self.assertEqual(health.headers['X-Domino-Read-Contract'], CONTRACT_VERSION)
        self.assertEqual(health.json()['generation'], health.headers['X-Domino-Reader-Generation'])
        self.assertEqual(health.json()['devAdmission']['state'], 'ready')
        for headers in ({'Origin': 'https://domino.money'}, {'Origin': 'null'},
                        {'Host': 'evil.invalid'}, {'Sec-Fetch-Site': 'cross-site'}):
            self.assertEqual(client.post('/v1/read/token', json={'token': TOKEN}, headers=headers).status_code, 403)
        self.assertEqual(provider.envelopes, [])
        for route in ('pool-positions', 'pool-metrics'):
            self.assertEqual(client.post('/v1/read/' + route, json={'poolId': POOL}).status_code, 404)
        self.assertEqual(client.get('/openapi.json').status_code, 404)
        self.assertEqual(client.post('/v1/read/token?rpcUrl=canary', json={'token': TOKEN}).status_code, 404)
        # Native-token lookup exercises actual RPC batching/failover injection.
        response = client.post('/v1/read/token', json={'token': '0x' + '00' * 20})
        self.assertEqual(response.status_code, 200, response.text)
        validate_response('token', response.json())
        self.assertGreater(provider.logical_count(), 0)
        self.wall[0] = 2000
        self.assertEqual(client.get('/health').json()['devAdmission']['state'], 'qualification_expired')
        for path in ('/health', '/v1/capabilities'):
            self.assertEqual(client.get(path).status_code, 503)
        self.assertEqual(client.post('/v1/read/catalogue', json={'token': TOKEN}).status_code, 503)

    def test_all_seven_service_families_keep_real_adapters_and_honest_unindexed_activity(self):
        market = MarketTransport()
        calls = []
        def transport(url, body=None, **kwargs):
            calls.append(url)
            return market(url, **kwargs) if 'geckoterminal' in url else [candidate()]
        service = self.service(transport)
        service.rpc_factory = lambda: NftRpc()  # Offline EVM fixture, no network.
        service.catalogue = CatalogueFixture()
        reads = {
            'token': lambda: service.token(TOKEN),
            'pools': lambda: service.pools(TOKEN),
            'pool-market': lambda: service.pool_market(POOL),
            'wallet-assets': lambda: service.wallet_assets(OWNER, [TOKEN], auto_discover=False),
            'nft-positions': lambda: service.nft_positions(['2235738']),
            'catalogue': lambda: service.catalogue_page(TOKEN),
        }
        for route, operation in reads.items():
            with self.subTest(route=route): validate_response(route, operation())
        with patch('activity_store.PgActivity.read', side_effect=DataError('activity_pool_not_registered')) as read:
            with self.assertRaisesRegex(DataError, 'activity_pool_not_registered'): service.pool_activity(POOL)
            read.assert_called_once()
        self.assertEqual(set(reads) | {'pool-activity'}, set(READS))
        self.assertEqual(len(service.development_budgets.events['gecko']), 1)
        self.assertEqual(len(service.development_budgets.events['dex']), 1)
        self.wall[0] = 2000
        with patch.object(service.catalogue, 'lookup') as lookup:
            with self.assertRaises(DataError): service.catalogue_page(TOKEN)
            lookup.assert_not_called()

    def test_catalogue_connections_use_only_dev_role_and_transaction_local_limits(self):
        settings = {'host': '/run/postgresql', 'port': 5432, 'dbname': 'domino_catalogue'}
        with patch('dev_read_service.psycopg.connect') as connect:
            connection = connect.return_value.__enter__.return_value
            with DevelopmentCatalogue(settings).connection() as actual:
                self.assertIs(actual.connection, connection)
            self.assertEqual(connect.call_args.kwargs['user'], 'domino_dev_catalogue_reader')
            self.assertEqual(connect.call_args.kwargs['connect_timeout'], 2)
            queries = [call.args[0] for call in connection.execute.call_args_list]
            self.assertIn('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY', queries)
            self.assertIn("SET LOCAL statement_timeout='1000ms'", queries)
            self.assertIn("SET LOCAL lock_timeout='100ms'", queries)
            self.assertIn("SET LOCAL work_mem='1MB'", queries)
            self.assertFalse(any('ALTER ROLE' in query for query in queries))
            connect.reset_mock()
            for options in ({'writer': True}, {'lock': True}):
                with self.assertRaises(DataError):
                    with DevelopmentCatalogue(settings).connection(**options): pass
            connect.assert_not_called()

    def test_sql_statements_and_result_fetches_share_remaining_read_deadline(self):
        connection = MagicMock()
        now = [0.0]
        def execute(query, params=None):
            if query.startswith('SELECT'):
                now[0] += 0.75
            return MagicMock()
        connection.execute.side_effect = execute
        bounded = _DevelopmentConnection(connection)
        with read_deadline(1, clock=lambda: now[0]):
            cursor = bounded.execute('SELECT first')
            cursor.fetchone()
            with self.assertRaisesRegex(DataError, 'read_deadline_exceeded'):
                bounded.execute('SELECT second')
            calls = len(connection.execute.call_args_list)
            with self.assertRaises(DataError): bounded.execute('SELECT forbidden_after_expiry')
            with self.assertRaises(DataError): cursor.fetchall()
            self.assertEqual(len(connection.execute.call_args_list), calls)
            # Prevent the outer deadline context from raising again on exit.
            now[0] = 0
        queries = [call.args[0] for call in connection.execute.call_args_list]
        self.assertIn("SET LOCAL statement_timeout='250ms'", queries)

    def test_dedicated_instance_lock_rejects_second_process_and_symlink(self):
        runtime = self.profile['runtimeDirectory']
        with reader_lock(runtime):
            with self.assertRaisesRegex(DataError, 'reader_lock_unavailable'):
                with reader_lock(runtime): pass
        lock = Path(runtime) / 'dev-reader.lock'
        lock.unlink(); lock.symlink_to(self.write())
        with self.assertRaises(DataError):
            with reader_lock(runtime): pass

    def test_mutable_nonsticky_ancestor_cannot_supply_private_profile(self):
        shared = self.directory / 'shared'
        shared.mkdir(mode=0o777); shared.chmod(0o777)
        private = shared / 'private'
        private.mkdir(mode=0o700)
        path = private / 'reader.json'
        path.write_text(json.dumps(self.profile)); path.chmod(0o600)
        with self.assertRaisesRegex(DataError, '^development_profile_unavailable$'): load_profile(path)


if __name__ == '__main__':
    unittest.main()
