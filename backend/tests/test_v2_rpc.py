"""Per-chain V2 endpoints: Robinhood keeps its provider file, Base and Arbitrum
read hosted providers from a private V2 file, every endpoint's limits hold, and
no client spends a billed call on the chain id."""
import contextlib
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from configure_rpc import prepare_local_config
from discovery import DataError, parse_block
from read_deadline import read_deadline
from rpc_config import LOCAL_STATE_BLOCKS
import v2_rpc
from v2_chains import load_balance_registry, load_registry
from v2_rpc import (RECENT_STATE_BLOCKS, ChainEndpoints, ChainIndexRpc, ChainReadRpc, CodeCache, Endpoint,
                    check_endpoint, checked_chain_rpc_config, configured_endpoints, credential_name, env_name,
                    load_chain_rpc_config, provider_file_endpoints)
from v2_fixtures import (HEAD, FakeChain, balance_documents, documents, synthetic_code, with_synthetic_code,
                         write_balance_registry, write_registry)

ALCHEMY = 'https://robinhood-mainnet.g.alchemy.com/v2/SYNTHETIC'
LOCAL = 'https://rpc.domino.money/SYNTHETIC_LOCAL_TOKEN_123/'
URLS = {name: f'https://{name}.example.invalid/SYNTHETIC_{name.upper()}' for name in ('stack', 'drpc', 'alchemy', 'public')}
REGISTRY = load_registry()
ROBINHOOD, BASE, ARBITRUM = REGISTRY.chains
BALANCES = load_balance_registry()
ETHEREUM, OPTIMISM = BALANCES.chains
ANCHOR = parse_block(HEAD)


def entry(name, *, url=True, **settings):
    item = {'name': name, 'host': f'{name}.example.invalid', 'archive': name != 'public', 'maxBatchItems': 50,
            'maxLogBlocks': 10000, 'requestsPerSecond': None, **settings}
    if url:
        item['url'] = URLS[name]
    return item


def chain_rpc_document(**chains):
    default = {'base-8453': {'endpoints': [entry('stack'), entry('drpc'), entry('alchemy', maxLogBlocks=None),
                                           entry('public', maxBatchItems=10, maxLogBlocks=2000)]},
               'arbitrum-42161': {'endpoints': [entry('stack')]}}
    default.update(chains)
    return {'schemaVersion': 1, 'kind': 'domino-v2-chain-rpc', 'chains': default}


def balance_rpc_document(**chains):
    """The balance chain RPC file (Ethereum, OP Mainnet; chain-balances only): the same schema, its own chains."""
    default = {'ethereum-1': {'endpoints': [entry('stack'), entry('alchemy', maxLogBlocks=None)]},
               'optimism-10': {'endpoints': [entry('stack'), entry('public', maxBatchItems=10, maxLogBlocks=2000)]}}
    default.update(chains)
    return {'schemaVersion': 1, 'kind': 'domino-v2-chain-rpc', 'chains': default}


def local_provider_file():
    return prepare_local_config({'version': 1, 'rpcUrl': ALCHEMY, 'inventoryUrl': ALCHEMY},
                                'SYNTHETIC_LOCAL_TOKEN_123')


def hosted(fake=None, *, chain=BASE, settings=None, clock=None, sleep=None):
    """Base's four hosted endpoints over a fake chain, with a controllable clock."""
    config = checked_chain_rpc_config(chain_rpc_document(**(settings or {})), environ={})
    options = {'send': fake or FakeChain(chain.chainId)}
    if clock is not None:
        options['clock'] = clock
    if sleep is not None:
        options['sleep'] = sleep
    return configured_endpoints(chain, chain_rpc_config=config, **options)


class Clock:
    def __init__(self):
        self.now, self.slept = 1000.0, []

    def __call__(self):
        return self.now

    def sleep(self, seconds):
        self.slept.append(round(seconds, 6))
        self.now += seconds


class ConfigTests(unittest.TestCase):
    def test_each_chain_lists_its_endpoints_in_order_and_nothing_prints_a_url(self):
        config = checked_chain_rpc_config(chain_rpc_document(), environ={})
        endpoints = configured_endpoints(BASE, chain_rpc_config=config)
        self.assertEqual([(e.name, e.host, e.archive, e.max_batch_items, e.max_log_blocks) for e in endpoints.endpoints],
                         [('stack', 'stack.example.invalid', True, 50, 10000),
                          ('drpc', 'drpc.example.invalid', True, 50, 10000),
                          ('alchemy', 'alchemy.example.invalid', True, 50, None),
                          ('public', 'public.example.invalid', False, 10, 2000)])
        self.assertEqual(endpoints.endpoints[3].state_blocks, RECENT_STATE_BLOCKS)
        self.assertEqual(configured_endpoints(ARBITRUM, chain_rpc_config=config).endpoints[0].url, URLS['stack'])
        for text in (repr(config), repr(endpoints), repr(endpoints.endpoints)):
            self.assertNotIn('SYNTHETIC', text)

    def test_a_url_comes_from_the_file_or_its_documented_variable_never_both(self):
        self.assertEqual(env_name(BASE, 'chainstack'), 'DOMINO_V2_RPC_BASE_8453_CHAINSTACK')
        self.assertEqual(env_name(ARBITRUM, 'alchemy-payg'), 'DOMINO_V2_RPC_ARBITRUM_42161_ALCHEMY_PAYG')
        document = chain_rpc_document(**{'base-8453': {'endpoints': [entry('stack', url=False), entry('public')]}})
        environ = {'DOMINO_V2_RPC_BASE_8453_STACK': URLS['stack']}
        endpoints = checked_chain_rpc_config(document, environ=environ).chains['base-8453']
        self.assertEqual([e.url for e in endpoints], [URLS['stack'], URLS['public']])
        with self.assertRaisesRegex(DataError, '^v2_rpc_url_missing$'):
            checked_chain_rpc_config(document, environ={})
        with self.assertRaisesRegex(DataError, '^v2_rpc_url_ambiguous$'):
            checked_chain_rpc_config(document, environ={**environ, 'DOMINO_V2_RPC_BASE_8453_PUBLIC': URLS['public']})
        # Another chain's variable is not this chain's.
        with self.assertRaisesRegex(DataError, '^v2_rpc_url_missing$'):
            checked_chain_rpc_config(document, environ={'DOMINO_V2_RPC_ARBITRUM_42161_STACK': URLS['stack']})
        with patch.dict(os.environ, environ, clear=False):
            self.assertEqual(checked_chain_rpc_config(document).chains['base-8453'][0].url, URLS['stack'])

    def test_a_url_can_be_a_sealed_systemd_credential_and_only_one_source_counts(self):
        """LoadCredentialEncrypted= decrypts v2-rpc-<chain>-<endpoint> under $CREDENTIALS_DIRECTORY."""
        self.assertEqual(credential_name(BASE, 'chainstack'), 'v2-rpc-base-8453-chainstack')
        self.assertEqual(credential_name(ARBITRUM, 'alchemy-payg'), 'v2-rpc-arbitrum-42161-alchemy-payg')
        directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, directory)
        (directory / 'v2-rpc-base-8453-stack').write_text(URLS['stack'] + '\n')
        document = chain_rpc_document(**{'base-8453': {'endpoints': [entry('stack', url=False), entry('public')]}})
        environ = {'CREDENTIALS_DIRECTORY': str(directory)}
        config = checked_chain_rpc_config(document, environ=environ)
        self.assertEqual([e.url for e in config.chains['base-8453']], [URLS['stack'], URLS['public']])
        self.assertNotIn('SYNTHETIC', repr(config) + repr(config.chains['base-8453']))
        # The credential and the variable, or the credential and the file: ambiguous.
        with self.assertRaisesRegex(DataError, '^v2_rpc_url_ambiguous$'):
            checked_chain_rpc_config(document, environ={**environ, 'DOMINO_V2_RPC_BASE_8453_STACK': URLS['stack']})
        (directory / 'v2-rpc-base-8453-public').write_text(URLS['public'])
        with self.assertRaisesRegex(DataError, '^v2_rpc_url_ambiguous$'):
            checked_chain_rpc_config(document, environ=environ)
        (directory / 'v2-rpc-base-8453-public').unlink()
        # Another chain's credential is not this chain's; no directory, no credential.
        (directory / 'v2-rpc-base-8453-stack').rename(directory / 'v2-rpc-arbitrum-42161-stack')
        with self.assertRaisesRegex(DataError, '^v2_rpc_url_missing$'):
            checked_chain_rpc_config(document, environ=environ)
        with self.assertRaisesRegex(DataError, '^v2_rpc_url_missing$'):
            checked_chain_rpc_config(document, environ={})

    def test_a_credential_that_is_not_a_plain_readable_file_is_refused_without_its_value(self):
        directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, directory)
        document = chain_rpc_document(**{'base-8453': {'endpoints': [entry('stack', url=False)]}})
        environ = {'CREDENTIALS_DIRECTORY': str(directory)}
        name = directory / 'v2-rpc-base-8453-stack'
        target = directory / 'elsewhere'
        target.write_text(URLS['stack'])
        cases = {
            'link': lambda: name.symlink_to(target),
            'directory': lambda: name.mkdir(),
            'oversized': lambda: name.write_text('https://stack.example.invalid/' + 'k' * 2048),
            'not ascii': lambda: name.write_bytes('https://stack.example.invalid/\u00e9'.encode()),
        }
        for label, make in cases.items():
            with self.subTest(label):
                make()
                with self.assertRaisesRegex(DataError, '^v2_rpc_credential_unreadable$'):
                    checked_chain_rpc_config(document, environ=environ)
                if name.is_dir() and not name.is_symlink():
                    name.rmdir()
                else:
                    name.unlink()
        with self.assertRaisesRegex(DataError, '^v2_rpc_credential_unreadable$'):
            checked_chain_rpc_config(document, environ={'CREDENTIALS_DIRECTORY': 'relative/credentials'})
        # A credential on another host than the entry's is refused like any URL.
        name.write_text('https://other.example.invalid/SYNTHETIC')
        with self.assertRaisesRegex(DataError, '^invalid_v2_rpc_url$') as caught:
            checked_chain_rpc_config(document, environ=environ)
        self.assertNotIn('SYNTHETIC', str(caught.exception))

    def test_a_chain_without_endpoints_has_no_fallback(self):
        config = checked_chain_rpc_config({'schemaVersion': 1, 'kind': 'domino-v2-chain-rpc', 'chains': {}})
        for value in (config, None, chain_rpc_document()):
            with self.subTest(config=type(value).__name__), \
                    self.assertRaisesRegex(DataError, '^v2_chain_rpc_not_configured$'):
                configured_endpoints(BASE, chain_rpc_config=value)
        with self.assertRaisesRegex(DataError, '^v2_chain_profile_required$'):
            configured_endpoints('base-8453', chain_rpc_config=config)

    def test_robinhood_cannot_be_routed_from_the_v2_file(self):
        document = chain_rpc_document(**{'robinhood-4663': {'endpoints': [entry('stack')]}})
        with self.assertRaisesRegex(DataError, '^v2_robinhood_routes_come_from_provider_file$'):
            checked_chain_rpc_config(document, environ={})

    def test_the_file_shape_is_exact(self):
        def endpoint(**changes):
            return lambda d: d['chains']['base-8453']['endpoints'][0].update(changes)

        cases = {
            'version': (lambda d: d.update(schemaVersion=2), 'invalid_v2_chain_rpc_config'),
            'boolean_version': (lambda d: d.update(schemaVersion=True), 'invalid_v2_chain_rpc_config'),
            'kind': (lambda d: d.update(kind='domino-automation-cycle'), 'invalid_v2_chain_rpc_config'),
            'extra_key': (lambda d: d.update(rpcUrl=URLS['stack']), 'invalid_v2_chain_rpc_config'),
            'chains_list': (lambda d: d.update(chains=[]), 'invalid_v2_chain_rpc_config'),
            'chain_extra_key': (lambda d: d['chains']['base-8453'].update(rpcUrls=[]), 'invalid_v2_chain_rpc_config'),
            'endpoints_not_list': (lambda d: d['chains']['base-8453'].update(endpoints={}),
                                   'invalid_v2_chain_rpc_config'),
            'no_endpoints': (lambda d: d['chains']['base-8453'].update(endpoints=[]), 'invalid_v2_chain_rpc_config'),
            'seven_endpoints': (lambda d: d['chains']['base-8453'].update(
                endpoints=[dict(entry('stack'), name=f'e{i}') for i in range(7)]), 'invalid_v2_chain_rpc_config'),
            'endpoint_extra_key': (endpoint(apiKey='x'), 'invalid_v2_chain_rpc_config'),
            'endpoint_missing_key': (lambda d: d['chains']['base-8453']['endpoints'][0].pop('archive'),
                                     'invalid_v2_chain_rpc_config'),
            'endpoint_not_object': (lambda d: d['chains']['base-8453']['endpoints'].append(URLS['stack']),
                                    'invalid_v2_chain_rpc_config'),
            'name_case': (endpoint(name='Chainstack'), 'invalid_v2_chain_rpc_config'),
            'name_type': (endpoint(name=7), 'invalid_v2_chain_rpc_config'),
            'archive_text': (endpoint(archive='yes'), 'invalid_v2_chain_rpc_config'),
            'batch_zero': (endpoint(maxBatchItems=0), 'invalid_v2_chain_rpc_config'),
            'batch_huge': (endpoint(maxBatchItems=1001), 'invalid_v2_chain_rpc_config'),
            'batch_null': (endpoint(maxBatchItems=None), 'invalid_v2_chain_rpc_config'),
            'batch_boolean': (endpoint(maxBatchItems=True), 'invalid_v2_chain_rpc_config'),
            'log_zero': (endpoint(maxLogBlocks=0), 'invalid_v2_chain_rpc_config'),
            'log_text': (endpoint(maxLogBlocks='10000'), 'invalid_v2_chain_rpc_config'),
            'rate_zero': (endpoint(requestsPerSecond=0), 'invalid_v2_chain_rpc_config'),
            'rate_fraction': (endpoint(requestsPerSecond=0.5), 'invalid_v2_chain_rpc_config'),
            'duplicate_name': (lambda d: d['chains']['base-8453']['endpoints'][1].update(name='stack'),
                               'duplicate_v2_rpc_endpoint'),
            'duplicate_url': (lambda d: d['chains']['base-8453']['endpoints'][1].update(
                url=URLS['stack'], host='stack.example.invalid'), 'duplicate_v2_rpc_endpoint'),
            'unknown_chain': (lambda d: d['chains'].update({'optimism-10': d['chains']['base-8453']}),
                              'v2_chain_unknown'),
            'chain_by_slug': (lambda d: d['chains'].update({'base': d['chains'].pop('base-8453')}), 'v2_chain_unknown'),
            'pending_chain': (lambda d: d['chains'].update({'elysium': d['chains']['base-8453']}),
                              'v2_chain_not_enabled'),
            'bad_host': (endpoint(host='*.example.invalid'), 'invalid_rpc_allowed_hosts'),
            'ip_host': (endpoint(host='127.0.0.1'), 'invalid_rpc_allowed_hosts'),
            'other_host': (endpoint(url=URLS['drpc']), 'invalid_v2_rpc_url'),
            'plain_http': (endpoint(url=URLS['stack'].replace('https', 'http')), 'invalid_v2_rpc_url'),
            'userinfo': (endpoint(url=URLS['stack'].replace('https://', 'https://name@')), 'invalid_v2_rpc_url'),
            'port': (endpoint(url=URLS['stack'].replace('.invalid/', '.invalid:8443/')), 'invalid_v2_rpc_url'),
            'fragment': (endpoint(url=URLS['stack'] + '#x'), 'invalid_v2_rpc_url'),
            'space': (endpoint(url=URLS['stack'] + ' x'), 'invalid_v2_rpc_url'),
            'not_text': (endpoint(url=7), 'invalid_v2_rpc_url'),
            'backslash': (endpoint(url=URLS['stack'] + '\\x'), 'invalid_v2_rpc_url'),
            'too_long': (endpoint(url=URLS['stack'] + 'x' * 2048), 'invalid_v2_rpc_url'),
            'host_case': (endpoint(url=URLS['stack'].replace('stack.', 'Stack.')), 'invalid_v2_rpc_url'),
        }
        for name, (mutate, code) in cases.items():
            document = chain_rpc_document()
            mutate(document)
            with self.subTest(case=name), self.assertRaisesRegex(DataError, f'^{code}$') as caught:
                checked_chain_rpc_config(document, environ={})
            self.assertNotIn('SYNTHETIC', str(caught.exception))

    def test_a_provider_key_in_the_query_is_admitted(self):
        url = 'https://drpc.example.invalid/ogrpc?network=base&dkey=SYNTHETIC'
        document = chain_rpc_document(**{'base-8453': {'endpoints': [entry('drpc', url=False)]}})
        endpoints = checked_chain_rpc_config(document, environ={'DOMINO_V2_RPC_BASE_8453_DRPC': url})
        self.assertEqual(endpoints.chains['base-8453'][0].url, url)


class PrivateFileTests(unittest.TestCase):
    def setUp(self):
        # Resolved: the private-file walk refuses links, such as macOS /var.
        self.directory = Path(tempfile.mkdtemp(prefix='domino-v2-chain-rpc-')).resolve()
        self.addCleanup(shutil.rmtree, self.directory)
        self.path = self.directory / 'chain-rpc.json'

    def write(self, text, mode=0o600):
        self.path.write_text(text)
        self.path.chmod(mode)

    def test_a_private_file_loads(self):
        self.write(json.dumps(chain_rpc_document()))
        config = load_chain_rpc_config(self.path, environ={})
        self.assertEqual(sorted(config.chains), ['arbitrum-42161', 'base-8453'])

    def test_readable_linked_missing_or_duplicated_files_are_refused(self):
        self.write(json.dumps(chain_rpc_document()), mode=0o644)
        with self.assertRaisesRegex(DataError, '^v2_chain_rpc_config_unreadable$'):
            load_chain_rpc_config(self.path, environ={})
        self.write(json.dumps(chain_rpc_document()))
        link = self.directory / 'link.json'
        os.symlink(self.path, link)
        with self.assertRaisesRegex(DataError, '^v2_chain_rpc_config_unreadable$'):
            load_chain_rpc_config(link, environ={})
        with self.assertRaisesRegex(DataError, '^v2_chain_rpc_config_unreadable$'):
            load_chain_rpc_config(self.directory / 'absent.json', environ={})
        self.write('{"schemaVersion": 1, "schemaVersion": 1, "kind": "domino-v2-chain-rpc", "chains": {}}')
        with self.assertRaisesRegex(DataError, '^invalid_v2_chain_rpc_config$'):
            load_chain_rpc_config(self.path, environ={})
        self.write('{')
        with self.assertRaisesRegex(DataError, '^invalid_v2_chain_rpc_config$'):
            load_chain_rpc_config(self.path, environ={})

    def test_a_file_inside_a_checkout_is_refused(self):
        checkout = self.directory / 'checkout'
        (checkout / 'backend').mkdir(parents=True)
        (checkout / 'AGENTS.md').write_text('')
        (checkout / 'backend/read_service.py').write_text('')
        target = checkout / 'backend/runtime'
        target.mkdir(mode=0o700)
        (target / 'chain-rpc.json').write_text(json.dumps(chain_rpc_document()))
        (target / 'chain-rpc.json').chmod(0o600)
        with self.assertRaisesRegex(DataError, '^v2_chain_rpc_config_unreadable$'):
            load_chain_rpc_config(target / 'chain-rpc.json', environ={})


class RobinhoodTests(unittest.TestCase):
    def test_robinhood_reads_the_local_first_provider_file(self):
        endpoints = configured_endpoints(ROBINHOOD, provider_config=local_provider_file())
        self.assertEqual([(e.name, e.url, e.state_blocks) for e in endpoints.endpoints],
                         [('local', LOCAL, LOCAL_STATE_BLOCKS), ('fallback-1', ALCHEMY, None)])
        self.assertEqual(endpoints.source, 'provider_file')
        self.assertNotIn('SYNTHETIC', repr(endpoints))
        with self.assertRaisesRegex(DataError, '^v2_local_first_provider_file_required$'):
            configured_endpoints(ROBINHOOD, chain_rpc_config=checked_chain_rpc_config(chain_rpc_document(), environ={}))

    def test_only_the_version_4_local_first_file_is_accepted(self):
        for config in ({}, None, {'version': 1, 'rpcUrl': ALCHEMY, 'inventoryUrl': ALCHEMY},
                       {'version': 2, 'rpcUrl': 'https://rpc.mainnet.chain.robinhood.com', 'rpcFallbackUrls': [],
                        'rpcAllowedHosts': ['rpc.mainnet.chain.robinhood.com'], 'inventoryUrl': None},
                       {**local_provider_file(), 'version': '4'}):
            with self.subTest(config=config), \
                    self.assertRaisesRegex(DataError, '^v2_local_first_provider_file_required$'):
                provider_file_endpoints(ROBINHOOD, config)
        # An admitted host first, with the own node only as a fallback: still refused.
        alchemy_first = {**local_provider_file(), 'rpcUrl': ALCHEMY, 'rpcFallbackUrls': [LOCAL]}
        with self.assertRaisesRegex(DataError, '^local_first_rpc_required$'):
            provider_file_endpoints(ROBINHOOD, alchemy_first)
        # Robinhood's public RPC is no host a provider file admits by default (#289).
        public_first = {**local_provider_file(), 'rpcUrl': 'https://rpc.mainnet.chain.robinhood.com'}
        with self.assertRaisesRegex(DataError, '^invalid_rpc_url$'):
            provider_file_endpoints(ROBINHOOD, public_first)

    def test_the_provider_file_serves_robinhood_only(self):
        with self.assertRaisesRegex(DataError, '^v2_provider_file_serves_robinhood_only$'):
            provider_file_endpoints(BASE, local_provider_file())


class TransportTests(unittest.TestCase):
    def call(self, method, params, id=1):
        return {'jsonrpc': '2.0', 'id': id, 'method': method, 'params': params}

    def test_a_single_call_goes_as_it_is_and_is_counted(self):
        fake = FakeChain(8453)
        endpoints = hosted(fake)
        reply = endpoints(URLS['stack'], self.call('eth_getBlockByNumber', ['latest', False], 7))
        self.assertEqual(reply['id'], 7)
        self.assertEqual(endpoints.calls(), {'stack': 1, 'drpc': 0, 'alchemy': 0, 'public': 0})
        with self.assertRaisesRegex(DataError, '^v2_rpc_endpoint_unknown$'):
            endpoints('https://other.example.invalid/', self.call('eth_getBlockByNumber', ['latest', False]))

    def test_a_batch_goes_out_in_envelopes_the_endpoint_admits(self):
        fake = FakeChain(8453)
        fake.batch_limits[URLS['public']] = 10
        endpoints = hosted(fake)
        body = [self.call('eth_getCode', ['0x' + f'{i:040x}', HEAD['number']], 100 + i) for i in range(23)]
        replies = endpoints(URLS['public'], body)
        self.assertEqual([reply['id'] for reply in replies], [100 + i for i in range(23)])
        self.assertEqual(fake.envelopes, 3)  # 10 + 10 + 3
        self.assertEqual(endpoints.calls()['public'], 23)

    def test_replies_out_of_order_are_put_back_and_bad_envelopes_refused(self):
        fake = FakeChain(8453)
        endpoints = hosted(fake)
        body = [self.call('eth_getCode', ['0x' + f'{i:040x}', HEAD['number']], 10 + i) for i in range(3)]

        def reversed_send(url, chunk):
            return list(reversed(fake(url, chunk)))
        endpoints._send = reversed_send
        self.assertEqual([reply['id'] for reply in endpoints(URLS['stack'], body)], [10, 11, 12])
        for broken in (lambda replies: None, lambda replies: replies[:-1], lambda replies: replies + [replies[0]],
                       lambda replies: [{**replies[0], 'id': 99}, *replies[1:]], lambda replies: replies[0],
                       lambda replies: [*replies[:-1], 'x']):
            endpoints._send = lambda url, chunk, broken=broken: broken(fake(url, chunk))
            with self.subTest(broken=broken), self.assertRaisesRegex(DataError, '^invalid_rpc_envelope$'):
                endpoints(URLS['stack'], body)

    def test_a_log_range_is_split_to_the_endpoint_limit_and_merged_in_order(self):
        fake = FakeChain(8453)
        fake.log_limits[URLS['public']] = 2000
        fake.logs = [{'blockNumber': hex(n), 'logIndex': '0x0'} for n in (5, 1999, 2000, 4500, 4999, 5001)]
        endpoints = hosted(fake)
        query = {'address': '0x' + '11' * 20, 'fromBlock': hex(1), 'toBlock': hex(5000)}
        reply = endpoints(URLS['public'], self.call('eth_getLogs', [query], 3))
        self.assertEqual(reply['id'], 3)
        self.assertEqual([log['blockNumber'] for log in reply['result']], [hex(n) for n in (5, 1999, 2000, 4500, 4999)])
        windows = [(int(p[0]['fromBlock'], 16), int(p[0]['toBlock'], 16)) for _, _, p in fake.calls('eth_getLogs')]
        self.assertEqual(windows, [(1, 2000), (2001, 4000), (4001, 5000)])
        self.assertEqual(query['fromBlock'], hex(1))  # the caller's query is not changed
        # Within the limit, by tag or by block hash: sent as it is.
        for unsplit in ({**query, 'toBlock': hex(2000)}, {**query, 'toBlock': 'latest'},
                        {'blockHash': '0x' + 'ab' * 32}):
            fake.log.clear()
            endpoints(URLS['stack'], self.call('eth_getLogs', [unsplit])) if 'blockHash' in unsplit else \
                endpoints(URLS['public'], self.call('eth_getLogs', [unsplit]))
            self.assertEqual(len(fake.calls('eth_getLogs')), 1)
        # Alchemy's paid plan: no limit.
        fake.log.clear()
        endpoints(URLS['alchemy'], self.call('eth_getLogs', [{**query, 'toBlock': hex(10**6)}]))
        self.assertEqual(len(fake.calls('eth_getLogs')), 1)

    def test_a_malformed_log_query_reaches_the_provider_unchanged(self):
        sent = []

        def provider(url, body):
            sent.append(body)
            return {'jsonrpc': '2.0', 'id': body['id'], 'error': {'code': -32602, 'message': 'invalid params'}}
        endpoints = hosted(FakeChain(8453))
        endpoints._send = provider
        for params in ([], ['latest'], [{'fromBlock': '0x1'}, {}], [{'fromBlock': '0x0', 'toBlock': '0x1'}]):
            reply = endpoints(URLS['public'], self.call('eth_getLogs', params, 9))
            self.assertEqual((sent[-1]['params'], reply['error']['code']), (params, -32602))

    def test_split_logs_in_a_batch_and_a_failed_window_fail_their_item(self):
        fake = FakeChain(8453)
        fake.logs = [{'blockNumber': hex(n)} for n in (10, 15000)]
        endpoints = hosted(fake)
        query = {'fromBlock': hex(1), 'toBlock': hex(20000)}
        replies = endpoints(URLS['stack'], [self.call('eth_getLogs', [query], 1),
                                             self.call('eth_getBlockByNumber', ['latest', False], 2)])
        self.assertEqual([log['blockNumber'] for log in replies[0]['result']], [hex(10), hex(15000)])
        self.assertEqual(replies[1]['result']['number'], HEAD['number'])
        fake.log_limits[URLS['stack']] = 5000  # the provider admits less than the file says
        reply = endpoints(URLS['stack'], self.call('eth_getLogs', [query], 4))
        self.assertEqual((reply['id'], reply['error']['code']), (4, -32005))
        with self.assertRaisesRegex(DataError, '^v2_log_range_too_wide$'):
            endpoints(URLS['public'], self.call('eth_getLogs', [{'fromBlock': '0x0', 'toBlock': hex(2000 * 1000)}]))
        del fake.log_limits[URLS['stack']]

        def not_a_list(url, chunk):
            return [{**reply, 'result': {'logs': reply['result']}} for reply in fake(url, chunk)]
        endpoints._send = not_a_list
        with self.assertRaisesRegex(DataError, '^invalid_rpc_envelope$'):
            endpoints(URLS['stack'], self.call('eth_getLogs', [query]))

    def test_calls_are_paced_and_a_long_wait_is_refused_unsent(self):
        clock = Clock()
        fake = FakeChain(8453)
        endpoints = hosted(fake, settings={'base-8453': {'endpoints': [entry('stack', requestsPerSecond=10)]}},
                           clock=clock, sleep=clock.sleep)
        head = self.call('eth_getBlockByNumber', ['latest', False])
        endpoints(URLS['stack'], head)
        endpoints(URLS['stack'], head)
        self.assertEqual(clock.slept, [0.1])
        batch = [self.call('eth_getCode', ['0x' + f'{i:040x}', HEAD['number']], i + 1) for i in range(25)]
        endpoints(URLS['stack'], batch)  # waits 0.1 s, then holds the next 2.5 s
        sent = len(fake.log)
        with self.assertRaisesRegex(DataError, '^http_429$'):
            endpoints(URLS['stack'], head)
        self.assertEqual(len(fake.log), sent)
        self.assertEqual(endpoints.calls()['stack'], 27)
        clock.now += 1
        endpoints(URLS['stack'], head)  # 1.6 s of pace left: within the 2 s wait
        with read_deadline(5, clock=clock):
            clock.now += 1.0
            endpoints(URLS['stack'], head)
        with read_deadline(0.05, clock=clock), self.assertRaisesRegex(DataError, '^http_429$'):
            endpoints(URLS['stack'], head)  # the read's own deadline is shorter than the wait

    def test_a_failing_endpoint_cools_down_and_is_skipped_unsent(self):
        clock = Clock()
        fake = FakeChain(8453)
        endpoints = hosted(fake, clock=clock, sleep=clock.sleep)
        head = self.call('eth_getBlockByNumber', ['latest', False])
        fake.fail[(URLS['stack'], 'eth_getBlockByNumber')] = 'http_429'
        for pause in (1, 2, 4):
            with self.assertRaisesRegex(DataError, '^http_429$'):
                endpoints(URLS['stack'], head)  # the provider refuses: cool down
            sent = len(fake.log)
            with self.assertRaisesRegex(DataError, '^http_429$'):
                endpoints(URLS['stack'], head)  # cooling: refused here, nothing sent
            self.assertEqual(len(fake.log), sent)
            self.assertEqual([e.name for e in endpoints.usable()], ['drpc', 'alchemy', 'public'])
            clock.now += pause - 0.01
            self.assertEqual(endpoints.usable()[0].name, 'drpc')
            clock.now += 0.01
            self.assertEqual(endpoints.usable()[0].name, 'stack')
        del fake.fail[(URLS['stack'], 'eth_getBlockByNumber')]
        endpoints(URLS['stack'], head)
        fake.fail[(URLS['stack'], 'eth_getBlockByNumber')] = 'http_503'
        with self.assertRaisesRegex(DataError, '^http_503$'):
            endpoints(URLS['stack'], head)
        clock.now += 1  # a success reset the backoff to one second
        self.assertEqual(endpoints.usable()[0].name, 'stack')
        for _ in range(12):
            clock.now += 61
            with self.assertRaises(DataError):
                endpoints(URLS['stack'], head)
        self.assertEqual(endpoints._states[URLS['stack']].cooling_until - clock.now, 60)
        fake.fail[(URLS['drpc'], 'eth_getBlockByNumber')] = 'invalid_json'  # not a provider limit
        with self.assertRaisesRegex(DataError, '^invalid_json$'):
            endpoints(URLS['drpc'], head)
        self.assertIn('drpc', [e.name for e in endpoints.usable()])

    def test_a_chain_needs_its_profile_and_distinct_endpoints(self):
        one = Endpoint('a', 'a.example.invalid', 'https://a.example.invalid/', None, 1, None, None)
        for args in (('base-8453', (one,)), (BASE, ()), (BASE, (one, one)), (BASE, ('https://a.example.invalid/',)),
                     (BASE, tuple(Endpoint(f'e{i}', 'a.example.invalid', f'https://a.example.invalid/{i}', None, 1,
                                           None, None) for i in range(7)))):
            with self.subTest(args=args), self.assertRaisesRegex(DataError, '^invalid_v2_chain_endpoints$'):
                ChainEndpoints(args[0], args[1], 'test')

    def test_clients_pass_over_the_endpoints_the_head_follower_set_aside(self):
        clock = Clock()
        fake = FakeChain(8453)
        endpoints = hosted(fake, clock=clock)
        stack, drpc, alchemy, public = endpoints.endpoints
        head = self.call('eth_getBlockByNumber', ['latest', False])

        def cool(endpoint):
            fake.fail[(endpoint.url, 'eth_getBlockByNumber')] = 'http_429'
            with self.assertRaisesRegex(DataError, '^http_429$'):
                endpoints(endpoint.url, head)
            del fake.fail[(endpoint.url, 'eth_getBlockByNumber')]

        def named(found):
            return [endpoint.name for endpoint in found]
        self.assertEqual((endpoints.aside(), endpoints.passes_over()), ((), False))
        self.assertEqual(endpoints.set_aside([stack]), (['stack'], []))
        self.assertEqual((endpoints.aside(), endpoints.passes_over()), ((stack,), True))
        self.assertEqual(named(endpoints.usable()), ['drpc', 'alchemy', 'public'])
        self.assertEqual((endpoints.read_rpc().names, endpoints.history_rpc().names), (('drpc', 'alchemy', 'public'),) * 2)
        self.assertEqual(endpoints.read_rpc(only='stack').names, ('stack',))  # named, it is still reached
        self.assertEqual(named(endpoints.head_candidates()), ['stack', 'drpc', 'alchemy', 'public'])
        cool(drpc)  # cooling hides an endpoint from the follower too
        self.assertEqual((named(endpoints.head_candidates()), named(endpoints.usable())),
                         (['stack', 'alchemy', 'public'], ['alchemy', 'public']))
        # Replaced as a whole: alchemy set aside, stack taken back, and stack leads the clients again.
        self.assertEqual(endpoints.set_aside([alchemy]), (['alchemy'], ['stack']))
        self.assertFalse(endpoints.passes_over())
        cool(stack)  # past a cooling endpoint, the first a client meets is set aside
        self.assertTrue(endpoints.passes_over())
        with self.assertRaisesRegex(DataError, '^v2_rpc_endpoint_unknown$'):
            endpoints.set_aside([Endpoint('x', 'x.example.invalid', 'https://x.example.invalid/', None, 1, None, None)])
        self.assertEqual(endpoints.aside(), (alchemy,))
        endpoints.set_aside([drpc, alchemy, public])  # with stack cooling, no client has an endpoint
        with self.assertRaisesRegex(DataError, '^v2_rpc_endpoints_cooling$'):
            endpoints.read_rpc()
        endpoints.set_aside([])
        cool(alchemy)
        cool(public)
        self.assertEqual((endpoints.head_candidates(), endpoints.passes_over()), ((), False))

    def test_every_endpoint_cooling_is_refused(self):
        clock = Clock()
        fake = FakeChain(8453)
        endpoints = hosted(fake, clock=clock)
        for url in URLS.values():
            fake.fail[(url, 'eth_getBlockByNumber')] = 'network_unavailable'
            with self.assertRaises(DataError):
                endpoints(url, self.call('eth_getBlockByNumber', ['latest', False]))
        with self.assertRaisesRegex(DataError, '^v2_rpc_endpoints_cooling$'):
            endpoints.usable()
        with self.assertRaisesRegex(DataError, '^v2_rpc_endpoints_cooling$'):
            endpoints.read_rpc()


class CodeCacheTests(unittest.TestCase):
    def test_code_is_proven_from_the_lowest_block_it_was_proven_at(self):
        cache = CodeCache()
        contract, codehash = '0x' + '11' * 20, '0x' + 'aa' * 32
        self.assertFalse(cache.proven(contract, codehash, 10**9))
        cache.record(contract, codehash, 100)
        cache.record(contract, codehash, 105)  # two readers recording out of order keep the lowest
        self.assertEqual([cache.proven(contract, codehash, n) for n in (99, 100, 101)], [False, True, True])
        self.assertFalse(cache.proven(contract, '0x' + 'bb' * 32, 101))  # another code hash is not proven


class ClientTests(unittest.TestCase):
    def test_no_client_requests_the_chain_id(self):
        fake = FakeChain(8453)
        endpoints = hosted(fake)
        for rpc in (endpoints.read_rpc(batch_reads=True), endpoints.history_rpc(batch_reads=True)):
            with self.subTest(client=type(rpc).__name__):
                block = parse_block(rpc.request('eth_getBlockByNumber', ['latest', False]))
                rpc.request('eth_getCode', ['0x' + '11' * 20, block.tag])
                rpc.batch([('eth_getCode', ['0x' + '11' * 20, block.tag])])
                with self.assertRaisesRegex(DataError, '^method_not_read_only$'):
                    rpc.request('eth_chainId')
                with self.assertRaisesRegex(DataError, '^method_not_read_only$'):
                    rpc.batch([('eth_chainId', []), ('eth_getBlockByNumber', ['latest', False])])
                self.assertEqual((rpc.chain_id, rpc.chain.key), (8453, 'base-8453'))
        self.assertEqual(fake.calls('eth_chainId'), [])

    def test_a_client_takes_the_first_three_usable_endpoints(self):
        clock = Clock()
        fake = FakeChain(8453)
        endpoints = hosted(fake, clock=clock)
        rpc = endpoints.read_rpc()
        self.assertEqual((rpc.names, rpc.urls), (('stack', 'drpc', 'alchemy'), tuple(URLS[n] for n in ('stack', 'drpc', 'alchemy'))))
        fake.fail[(URLS['drpc'], 'eth_getBlockByNumber')] = 'http_429'
        with self.assertRaises(DataError):
            endpoints(URLS['drpc'], {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_getBlockByNumber', 'params': ['latest', False]})
        self.assertEqual(endpoints.read_rpc().names, ('stack', 'alchemy', 'public'))  # public: the last resort
        self.assertEqual(endpoints.read_rpc(only='drpc').names, ('drpc',))
        with self.assertRaisesRegex(DataError, '^v2_rpc_endpoint_unknown$'):
            endpoints.read_rpc(only='quicknode')
        with self.assertRaisesRegex(DataError, '^v2_chain_endpoints_required$'):
            ChainReadRpc((URLS['stack'],))

    def test_a_failover_logs_the_endpoint_name_never_its_url(self):
        fake = FakeChain(8453)
        fake.fail[(URLS['stack'], 'eth_getBlockByNumber')] = 'http_503'
        rpc = hosted(fake).read_rpc()
        with self.assertLogs('v2_rpc', 'WARNING') as logs:
            rpc.request('eth_getBlockByNumber', ['latest', False])
        self.assertEqual(rpc.index, 1)
        self.assertEqual(logs.output, ['WARNING:v2_rpc:v2_rpc_failover chain=base-8453 endpoint=drpc reason=http_503'])

    def test_a_followed_head_costs_no_call_and_is_proven_again_on_a_switch(self):
        fake = FakeChain(8453)
        endpoints = hosted(fake)
        rpc = endpoints.read_rpc(anchor=ANCHOR)
        rpc.request('eth_getCode', ['0x' + '11' * 20, ANCHOR.tag])
        self.assertEqual([method for _, method, _ in fake.log], ['eth_getCode'])
        fake.fail[(URLS['stack'], 'eth_getBalance')] = 'http_502'
        rpc.request('eth_getBalance', ['0x' + '11' * 20, ANCHOR.tag])
        self.assertEqual([(url, method) for url, method, _ in fake.log[1:]],
                         [(URLS['stack'], 'eth_getBalance'), (URLS['drpc'], 'eth_getBlockByNumber'),
                          (URLS['drpc'], 'eth_getBalance')])
        fake.blocks[ANCHOR.tag] = {**HEAD, 'hash': '0x' + 'cd' * 32}  # the next endpoint saw another block
        fake.fail[(URLS['drpc'], 'eth_getBalance')] = 'http_502'
        with self.assertRaisesRegex(DataError, '^snapshot_reorganized$'):
            rpc.request('eth_getBalance', ['0x' + '11' * 20, ANCHOR.tag])
        with self.assertRaisesRegex(DataError, '^block_unavailable$'):
            endpoints.read_rpc(anchor=HEAD)

    def test_history_starts_where_the_state_is_kept(self):
        fake = FakeChain(8453, head={**HEAD, 'number': hex(10000)})
        settings = {'base-8453': {'endpoints': [entry('public'), entry('stack')]}}
        rpc = hosted(fake, settings=settings).history_rpc()
        head = parse_block(rpc.request('eth_getBlockByNumber', ['latest', False]))
        recent, old = head.number - RECENT_STATE_BLOCKS, head.number - RECENT_STATE_BLOCKS - 1
        for number in (recent, old):
            fake.blocks[hex(number)] = {**HEAD, 'number': hex(number), 'hash': '0x' + f'{number:064x}'}
        fake.log.clear()
        rpc.request('eth_getCode', ['0x' + '11' * 20, hex(recent)])
        rpc.request('eth_getCode', ['0x' + '11' * 20, hex(old)])
        rpc.request('eth_getCode', ['0x' + '11' * 20, hex(recent)])  # each operation starts where its state is
        self.assertEqual([url for url, method, _ in fake.log if method == 'eth_getCode'],
                         [URLS['public'], URLS['stack'], URLS['public']])
        self.assertEqual(fake.calls('eth_chainId'), [])
        # Moving to another endpoint proves the highest pinned block there first.
        fake.log.clear()
        rpc.request('eth_getCode', ['0x' + '11' * 20, hex(old)])
        self.assertEqual([(url, method, params[0]) for url, method, params in fake.log][0],
                         (URLS['stack'], 'eth_getBlockByNumber', head.tag))
        fake.blocks[head.tag] = {**HEAD, 'number': head.tag, 'hash': '0x' + 'cd' * 32}
        with self.assertRaisesRegex(DataError, '^snapshot_reorganized$'):
            rpc.request('eth_getCode', ['0x' + '11' * 20, hex(recent)])

    def test_robinhood_history_keeps_the_v1_own_node_window(self):
        fake = FakeChain(4663, head={**HEAD, 'number': hex(100000)})
        endpoints = configured_endpoints(ROBINHOOD, provider_config=local_provider_file(), send=fake)
        rpc = endpoints.history_rpc()
        head = parse_block(rpc.request('eth_getBlockByNumber', ['latest', False]))
        for number in (head.number - LOCAL_STATE_BLOCKS, head.number - LOCAL_STATE_BLOCKS - 1):
            fake.blocks[hex(number)] = {**HEAD, 'number': hex(number), 'hash': '0x' + f'{number:064x}'}
            rpc.request('eth_getCode', ['0x' + '11' * 20, hex(number)])
        self.assertEqual([url for url, method, _ in fake.log if method == 'eth_getCode'], [LOCAL, ALCHEMY])
        # A refusal for missing state inside the window still falls back, as in V1.
        fake.pruned_below[LOCAL] = head.number - 10
        number = head.number - 20
        fake.blocks[hex(number)] = {**HEAD, 'number': hex(number), 'hash': '0x' + f'{number:064x}'}
        fake.log.clear()
        rpc.request('eth_getCode', ['0x' + '11' * 20, hex(number)])
        self.assertEqual([url for url, method, _ in fake.log if method == 'eth_getCode'], [LOCAL, ALCHEMY])

    def test_an_index_client_reads_logs_split_per_endpoint_across_a_switch(self):
        fake = FakeChain(8453)
        fake.logs = [{'blockNumber': hex(n)} for n in (1, 3000, 9000)]
        fake.log_limits[URLS['stack']] = 10000
        fake.fail[(URLS['stack'], 'eth_getLogs')] = 'http_429'
        settings = {'base-8453': {'endpoints': [entry('stack'), entry('public', maxLogBlocks=2000)]}}
        rpc = ChainIndexRpc(hosted(fake, settings=settings))
        logs = rpc.request('eth_getLogs', [{'fromBlock': hex(1), 'toBlock': hex(9000)}])
        self.assertEqual([log['blockNumber'] for log in logs], [hex(1), hex(3000), hex(9000)])
        self.assertEqual([(url, int(p[0]['toBlock'], 16)) for url, _, p in fake.calls('eth_getLogs')],
                         [(URLS['stack'], 9000), *((URLS['public'], high) for high in (2000, 4000, 6000, 8000, 9000))])


class CheckTests(unittest.TestCase):
    def setUp(self):
        self.directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.directory)
        docs = documents()
        docs['base-8453.json'] = self.document = with_synthetic_code(docs['base-8453.json'])
        (self.directory / 'chains').mkdir()
        self.registry = write_registry(self.directory / 'chains', docs)
        self.chain = self.registry.chain('base-8453')
        self.fake = FakeChain(8453)
        self.fake.serve_code(self.document)
        old = self.chain.verification.block
        self.fake.blocks[hex(old)] = {'number': hex(old), 'hash': '0x' + 'ee' * 32, 'timestamp': '0x1'}
        self.now = int(HEAD['timestamp'], 16) + 5
        config = checked_chain_rpc_config(chain_rpc_document(), registry=self.registry, environ={})
        self.endpoints = configured_endpoints(self.chain, chain_rpc_config=config, send=self.fake)

    def check(self, name, now=None):
        endpoint = next(e for e in self.endpoints.endpoints if e.name == name)
        return check_endpoint(self.endpoints, endpoint, clock=lambda: now or self.now)

    def test_an_endpoint_on_the_profile_chain_passes_without_naming_a_url(self):
        report = self.check('stack')
        self.assertTrue(report['ok'])
        self.assertEqual((report['archiveProbe'], report['headAgeSeconds']), ('match', 5))
        self.assertEqual(set(report['contracts'].values()), {'match'})
        self.assertEqual(report['contracts']['ArbSys'], 'match')  # recorded absent on Base, and absent
        self.assertNotIn('SYNTHETIC', json.dumps(report))
        self.assertEqual(len(self.fake.calls('eth_chainId')), 1)  # the only chain id V2 ever asks
        self.assertLess(self.fake.envelopes, len(report['contracts']))  # code is read in batches
        public = self.check('public')
        self.assertTrue(public['ok'])
        self.assertNotIn('archiveProbe', public)

    def test_a_changed_contract_stale_head_or_missing_archive_fails(self):
        stateview = self.chain.uniswap.v4.stateView
        self.fake.codes[stateview] = '0x00'
        report = self.check('stack')
        self.assertEqual((report['ok'], report['contracts']['StateView']), (False, 'mismatch'))
        self.fake.codes[stateview] = synthetic_code(stateview)
        self.fake.codes['0x0000000000000000000000000000000000000064'] = '0xfe'  # ArbSys appearing on Base
        self.assertEqual(self.check('stack')['contracts']['ArbSys'], 'mismatch')
        del self.fake.codes['0x0000000000000000000000000000000000000064']
        self.assertTrue(self.check('stack')['ok'])
        self.assertFalse(self.check('stack', now=self.now + 181)['ok'])
        self.assertFalse(self.check('stack', now=self.now - 21)['ok'])
        self.fake.pruned_below[URLS['drpc']] = self.chain.verification.block + 1  # marked archive, is not
        with self.assertRaisesRegex(DataError, '^rpc_error$'):
            self.check('drpc')
        old = hex(self.chain.verification.block)
        self.fake.codes_at[(self.chain.uniswap.v4.poolManager, old)] = '0x00'  # other code back then
        report = self.check('alchemy')
        self.assertEqual((report['ok'], report['archiveProbe']), (False, 'mismatch'))
        self.assertEqual(set(report['contracts'].values()), {'match'})

    def test_a_head_reorganized_during_the_check_fails(self):
        def reorganizing(url, body):
            replies = self.fake(url, body)
            if isinstance(body, list) and any(item['method'] == 'eth_getCode' for item in body):
                self.fake.blocks[HEAD['number']] = {**HEAD, 'hash': '0x' + 'cd' * 32}
            return replies
        self.endpoints._send = reorganizing
        with self.assertRaisesRegex(DataError, '^snapshot_reorganized$'):
            self.check('public')

    def test_an_endpoint_on_another_chain_is_refused(self):
        self.fake.chain_ids[URLS['drpc']] = 42161
        with self.assertRaisesRegex(DataError, '^wrong_chain$'):
            self.check('drpc')

    def test_the_cli_validates_and_checks_with_fixed_error_codes(self):
        private = self.directory / 'private'
        private.mkdir(mode=0o700)
        path = private / 'chain-rpc.json'
        path.write_text(json.dumps(chain_rpc_document()))
        path.chmod(0o600)

        def run(*argv):
            out = io.StringIO()
            with patch.object(v2_rpc, 'default_registry', return_value=self.registry), \
                    patch.object(v2_rpc.time, 'time', return_value=self.now), contextlib.redirect_stdout(out):
                code = v2_rpc.main(list(argv), send=self.fake)
            text = out.getvalue()
            self.assertNotIn('SYNTHETIC', text)
            return code, json.loads(text)

        code, report = run('validate', '--chain', 'base-8453', '--chain-rpc-file', str(path))
        self.assertEqual((code, [e['name'] for e in report['endpoints']]), (0, ['stack', 'drpc', 'alchemy', 'public']))
        self.assertEqual(report['endpoints'][3], {'name': 'public', 'host': 'public.example.invalid', 'archive': False,
                                                  'maxBatchItems': 10, 'maxLogBlocks': 2000, 'requestsPerSecond': None})
        code, report = run('check', '--chain', 'base-8453', '--chain-rpc-file', str(path))
        self.assertEqual((code, report['ok'], [e['endpoint'] for e in report['endpoints']]),
                         (0, True, ['stack', 'drpc', 'alchemy', 'public']))
        self.assertEqual(set(report['calls']), {'stack', 'drpc', 'alchemy', 'public'})
        self.fake.chain_ids[URLS['alchemy']] = 1
        code, report = run('check', '--chain', 'base-8453', '--chain-rpc-file', str(path))
        self.assertEqual((code, report['endpoints'][2]), (1, {'endpoint': 'alchemy', 'error': 'wrong_chain', 'ok': False}))
        code, report = run('check', '--chain', 'base-8453', '--chain-rpc-file', str(path), '--endpoint', 'public')
        self.assertEqual((code, [e['endpoint'] for e in report['endpoints']]), (0, ['public']))
        self.assertEqual(run('check', '--chain', 'base-8453', '--chain-rpc-file', str(path), '--endpoint', 'x'),
                         (1, {'error': 'v2_rpc_endpoint_unknown'}))
        self.assertEqual(run('check', '--chain', 'base-8453'), (1, {'error': 'v2_chain_rpc_not_configured'}))
        self.assertEqual(run('check', '--chain', 'elysium'), (1, {'error': 'v2_chain_not_enabled'}))
        self.assertEqual(run('validate', '--chain', 'robinhood-4663', '--provider-file', str(private / 'absent.json')),
                         (1, {'error': 'v2_local_first_provider_file_required'}))


class BalanceChainTests(unittest.TestCase):
    """Ethereum and OP Mainnet (read-v6's chain-balances only): their own file, read against the balance registry,
    their URLs sealed as v2-rpc-<chain>-<name> like every other chain's."""

    def test_the_balance_file_names_the_balance_chains_with_their_own_credentials(self):
        config = checked_chain_rpc_config(balance_rpc_document(), registry=BALANCES, environ={})
        self.assertEqual(sorted(config.chains), ['ethereum-1', 'optimism-10'])
        endpoints = configured_endpoints(OPTIMISM, chain_rpc_config=config, send=FakeChain(10))
        self.assertEqual((endpoints.chain.chainId, [e.name for e in endpoints.endpoints], endpoints.source),
                         (10, ['stack', 'public'], 'v2_chain_rpc_file'))
        self.assertEqual(endpoints.endpoints[1].state_blocks, RECENT_STATE_BLOCKS)
        self.assertNotIn('SYNTHETIC', repr(config) + repr(endpoints))
        self.assertEqual((credential_name(ETHEREUM, 'chainstack'), credential_name(OPTIMISM, 'alchemy')),
                         ('v2-rpc-ethereum-1-chainstack', 'v2-rpc-optimism-10-alchemy'))
        self.assertEqual(env_name(OPTIMISM, 'chainstack'), 'DOMINO_V2_RPC_OPTIMISM_10_CHAINSTACK')
        directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, directory)
        (directory / 'v2-rpc-ethereum-1-stack').write_text(URLS['stack'] + '\n')
        document = balance_rpc_document(**{'ethereum-1': {'endpoints': [entry('stack', url=False)]}})
        sealed = checked_chain_rpc_config(document, registry=BALANCES, environ={'CREDENTIALS_DIRECTORY': str(directory)})
        self.assertEqual(sealed.chains['ethereum-1'][0].url, URLS['stack'])
        # Base's credential is not Ethereum's.
        (directory / 'v2-rpc-ethereum-1-stack').rename(directory / 'v2-rpc-base-8453-stack')
        with self.assertRaisesRegex(DataError, '^v2_rpc_url_missing$'):
            checked_chain_rpc_config(document, registry=BALANCES, environ={'CREDENTIALS_DIRECTORY': str(directory)})

    def test_each_file_names_its_own_registrys_chains_only(self):
        for document, registry in ((balance_rpc_document(**{'base-8453': {'endpoints': [entry('stack')]}}), BALANCES),
                                   (balance_rpc_document(**{'ethereum': {'endpoints': [entry('stack')]}}), BALANCES),
                                   (chain_rpc_document(**{'ethereum-1': {'endpoints': [entry('stack')]}}), REGISTRY),
                                   (balance_rpc_document(), REGISTRY)):
            with self.subTest(chains=sorted(document['chains'])), self.assertRaisesRegex(DataError, '^v2_chain_unknown$'):
                checked_chain_rpc_config(document, registry=registry, environ={})

    def test_a_balance_chains_endpoints_are_a_chains_like_any_other(self):
        one = Endpoint('a', 'a.example.invalid', 'https://a.example.invalid/', None, 1, None, None)
        self.assertEqual(ChainEndpoints(ETHEREUM, (one,), 'test').chain.key, 'ethereum-1')
        config = checked_chain_rpc_config(balance_rpc_document(), registry=BALANCES, environ={})
        self.assertEqual(configured_endpoints(ETHEREUM, chain_rpc_config=config).endpoints[0].host, 'stack.example.invalid')
        for chain in ('ethereum-1', BALANCES):
            with self.subTest(chain=type(chain).__name__), self.assertRaisesRegex(DataError, '^v2_chain_profile_required$'):
                configured_endpoints(chain, chain_rpc_config=config)


class BalanceCheckTests(unittest.TestCase):
    """`v2_rpc.py check --chain optimism-10 --chain-rpc-file <the balance chain file>`, as the owner runs it after
    provisioning: the chain id, a fresh head, the profile's code hashes and the archive probe."""

    def setUp(self):
        self.directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, self.directory)
        docs = balance_documents()
        docs['optimism-10.json'] = self.document = with_synthetic_code(docs['optimism-10.json'])
        (self.directory / 'balances').mkdir()
        self.balances = write_balance_registry(self.directory / 'balances', docs, domino=REGISTRY)
        self.chain = self.balances.chain('optimism-10')
        self.fake = FakeChain(10)
        self.fake.serve_code(self.document)
        old = self.chain.verification.block
        self.fake.blocks[hex(old)] = {'number': hex(old), 'hash': '0x' + 'ee' * 32, 'timestamp': '0x1'}
        self.now = int(HEAD['timestamp'], 16) + 5
        private = self.directory / 'private'
        private.mkdir(mode=0o700)
        self.files = {}
        for name, document in (('balance-chain-rpc.json', balance_rpc_document()), ('chain-rpc.json', chain_rpc_document())):
            path = private / name
            path.write_text(json.dumps(document))
            path.chmod(0o600)
            self.files[name] = str(path)

    def run_cli(self, *argv):
        out = io.StringIO()
        with patch.object(v2_rpc, 'default_registry', return_value=REGISTRY), \
                patch.object(v2_rpc, 'default_balance_registry', return_value=self.balances), \
                patch.object(v2_rpc.time, 'time', return_value=self.now), contextlib.redirect_stdout(out):
            code = v2_rpc.main(list(argv), send=self.fake)
        text = out.getvalue()
        self.assertNotIn('SYNTHETIC', text)
        return code, json.loads(text)

    def test_the_balance_file_validates_and_checks_on_its_chain(self):
        code, report = self.run_cli('validate', '--chain', 'ethereum-1', '--chain-rpc-file', self.files['balance-chain-rpc.json'])
        self.assertEqual((code, report['chain'], [e['name'] for e in report['endpoints']]), (0, 'ethereum-1', ['stack', 'alchemy']))
        code, report = self.run_cli('check', '--chain', 'optimism-10', '--chain-rpc-file', self.files['balance-chain-rpc.json'])
        self.assertEqual((code, report['ok'], [e['endpoint'] for e in report['endpoints']]), (0, True, ['stack', 'public']))
        stack = report['endpoints'][0]
        self.assertEqual((stack['archiveProbe'], stack['headAgeSeconds']), ('match', 5))
        self.assertEqual(set(stack['contracts']), {record.name for record in self.chain.verification.contracts})
        self.assertEqual(set(stack['contracts'].values()), {'match'})
        self.assertIn('Chainlink L2 Sequencer Uptime Status Feed', stack['contracts'])
        # Code that is not the profile's, or another chain behind the endpoint, fails the check.
        self.fake.codes[self.chain.uniswap.v4.stateView] = '0x00'
        code, report = self.run_cli('check', '--chain', 'optimism-10', '--chain-rpc-file', self.files['balance-chain-rpc.json'],
                                    '--endpoint', 'stack')
        self.assertEqual((code, report['endpoints'][0]['contracts']['StateView']), (1, 'mismatch'))
        self.fake.chain_ids[URLS['stack']] = 8453
        code, report = self.run_cli('check', '--chain', 'optimism-10', '--chain-rpc-file', self.files['balance-chain-rpc.json'],
                                    '--endpoint', 'stack')
        self.assertEqual((code, report['endpoints'][0]), (1, {'endpoint': 'stack', 'error': 'wrong_chain', 'ok': False}))

    def test_each_file_is_read_against_its_chains_registry(self):
        self.assertEqual(self.run_cli('check', '--chain', 'optimism-10', '--chain-rpc-file', self.files['chain-rpc.json']),
                         (1, {'error': 'v2_chain_unknown'}))
        self.assertEqual(self.run_cli('check', '--chain', 'base-8453', '--chain-rpc-file', self.files['balance-chain-rpc.json']),
                         (1, {'error': 'v2_chain_unknown'}))
        self.assertEqual(self.run_cli('check', '--chain', 'ethereum-1'), (1, {'error': 'v2_chain_rpc_not_configured'}))
        self.assertEqual(self.run_cli('check', '--chain', 'polygon-137'), (1, {'error': 'v2_chain_unknown'}))
        self.assertEqual(self.run_cli('check', '--chain', 'elysium'), (1, {'error': 'v2_chain_not_enabled'}))


if __name__ == '__main__':
    unittest.main()
