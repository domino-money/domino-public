import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import CHAIN_ID, ZERO, DataError
from inventory import AlchemyInventory, CursorCodec, InventoryRpc
from local_config import load_config, save_config
from read_service import ReadService
from test_discovery import FakeRpc, OWNER, TOKEN, OTHER

URL = 'https://robinhood-mainnet.g.alchemy.com/v2/test-placeholder'


class ProviderTransport:
    def __init__(self, pages):
        self.pages, self.calls, self.chain = pages, [], CHAIN_ID

    def __call__(self, url, body):
        self.calls.append(body)
        if body['method'] == 'eth_chainId':
            value = hex(self.chain)
        else:
            self.assert_read(body)
            value = self.pages.pop(0)
        return {'jsonrpc': '2.0', 'id': body['id'], 'result': value}

    @staticmethod
    def assert_read(body):
        assert body['method'] == 'alchemy_getTokenBalances'
        assert body['params'][0:2] == [OWNER, 'erc20']
        assert body['params'][2]['maxCount'] == 20


def page(tokens, next_key=None, owner=OWNER):
    data = {'address': owner, 'tokenBalances': [
        {'contractAddress': token, 'tokenBalance': '0x' + '0' * 64, 'symbol': '<script>bad</script>'}
        for token in tokens]}
    if next_key is not None:
        data['pageKey'] = next_key
    return data


class InventoryTests(unittest.TestCase):
    def test_pages_deduplicate_addresses_and_never_trust_indexed_zero_or_symbols(self):
        transport = ProviderTransport([page([TOKEN, TOKEN], 'next-page'), page([OTHER])])
        provider = AlchemyInventory(URL, transport=transport, clock=lambda: 1010)
        first = provider.page(OWNER)
        second = provider.page(OWNER, first['nextKey'])
        self.assertEqual(first['currencies'], [TOKEN])
        self.assertEqual(second['currencies'], [OTHER])
        self.assertIsNone(second['nextKey'])
        self.assertEqual(transport.calls[-1]['params'][2]['pageKey'], 'next-page')
        self.assertNotIn('symbol', json.dumps(first))

    def test_wrong_chain_does_not_send_wallet_to_inventory_method(self):
        transport = ProviderTransport([page([TOKEN])])
        transport.chain = 1
        with self.assertRaisesRegex(DataError, 'inventory_wrong_chain'):
            AlchemyInventory(URL, transport=transport).page(OWNER)
        self.assertEqual(len(transport.calls), 1)

    def test_mismatched_wallet_oversize_and_repeated_page_are_errors(self):
        for data, key in [(page([TOKEN], owner=OTHER), None), (page([TOKEN]*21), None),
                          (page([TOKEN], 'same'), 'same'), (page([TOKEN], ''), None)]:
            with self.subTest(key=key), self.assertRaises(DataError):
                AlchemyInventory(URL, transport=ProviderTransport([data])).page(OWNER, key)

    def test_malformed_rows_are_explicit_and_do_not_turn_into_native_assets(self):
        data = page([TOKEN, ZERO])
        data['tokenBalances'] += [{}, None]
        result = AlchemyInventory(URL, transport=ProviderTransport([data])).page(OWNER)
        self.assertEqual(result['currencies'], [TOKEN])
        self.assertEqual(result['excludedRows'], 3)

    def test_inventory_endpoint_cannot_relay_to_other_networks_or_hosts(self):
        for url in ['http://robinhood-mainnet.g.alchemy.com/v2/key',
                    'https://eth-mainnet.g.alchemy.com/v2/key',
                    URL + '?secret=hidden', URL + '#fragment',
                    'https://robinhood-mainnet.g.alchemy.com.evil.test/v2/key',
                    'https://user:password@robinhood-mainnet.g.alchemy.com/v2/key']:
            with self.subTest(url=url), self.assertRaises(DataError):
                AlchemyInventory(url)

    def test_no_write_method_available(self):
        rpc = InventoryRpc(URL, transport=lambda *args: self.fail('write reached network'))
        with self.assertRaisesRegex(DataError, 'method_not_read_only'):
            rpc.request('eth_sendRawTransaction', ['secret'])

    def test_cursor_binds_wallet_tokens_provider_and_expiry_and_rejects_tampering(self):
        now = [1010]
        codec = CursorCodec(secret=b'x'*32, clock=lambda: now[0], ttl=300)
        value = codec.issue(OWNER, [TOKEN], 'provider-1', 'page-2')
        self.assertEqual(codec.read(value, OWNER, [TOKEN], 'provider-1'), 'page-2')
        for cursor, wallet, tokens, provider in [
            (value, OTHER, [TOKEN], 'provider-1'), (value, OWNER, [OTHER], 'provider-1'),
            (value, OWNER, [TOKEN], 'provider-2'), ('!', OWNER, [TOKEN], 'provider-1'),
            (value[:-5] + 'AAAAA', OWNER, [TOKEN], 'provider-1')]:
            with self.subTest(wallet=wallet), self.assertRaisesRegex(DataError, 'invalid_or_expired_cursor'):
                codec.read(cursor, wallet, tokens, provider)
        now[0] = 1310
        with self.assertRaises(DataError):
            codec.read(value, OWNER, [TOKEN], 'provider-1')
        with self.assertRaises(DataError):
            CursorCodec(clock=lambda: 1010).read(value, OWNER, [TOKEN], 'provider-1')


class AssetServiceTests(unittest.TestCase):
    def service(self, rpc=None, provider=None):
        return ReadService(rpc_factory=lambda: rpc or FakeRpc(), inventory=provider, clock=lambda: 1010)

    def test_fallback_works_without_provider_and_native_zero_is_a_real_zero(self):
        result = self.service().wallet_assets(OWNER, [TOKEN, TOKEN])
        self.assertEqual([x['address'] for x in result['items']], [ZERO, TOKEN])
        self.assertEqual(result['items'][0]['amountRaw'], '0')
        self.assertEqual(result['items'][1]['amountRaw'], str(2**255 + 123))
        self.assertEqual(result['inventory']['status'], 'not_configured')
        self.assertFalse(result['walletControlVerified'])

    def test_pagination_is_owner_bound_and_each_page_has_fresh_rpc_balances(self):
        provider = AlchemyInventory(URL, transport=ProviderTransport([page([TOKEN], 'next'), page([OTHER])]), clock=lambda: 1010)
        service = self.service(provider=provider)
        first = service.wallet_assets(OWNER)
        self.assertTrue(first['inventory']['hasMore'])
        self.assertEqual(first['items'][1]['amountRaw'], str(2**255 + 123))
        cursor = first['inventory']['nextCursor']
        with self.assertRaises(DataError):
            service.wallet_assets(OTHER, cursor=cursor)
        second = service.wallet_assets(OWNER, cursor=cursor)
        self.assertFalse(second['inventory']['hasMore'])
        self.assertEqual(second['inventory']['coverage'], 'provider_page_only')
        self.assertEqual(second['items'][1]['address'], OTHER)

    def test_provider_failure_keeps_explicit_address_balances_available(self):
        def failed(*args):
            raise DataError('http_403')
        provider = AlchemyInventory(URL, transport=failed)
        result = self.service(provider=provider).wallet_assets(OWNER, [TOKEN])
        self.assertEqual(result['inventory']['status'], 'unavailable')
        self.assertIsNone(result['inventory']['hasMore'])
        self.assertEqual(len(result['items']), 2)

    def test_reverting_token_does_not_erase_other_assets_or_become_zero(self):
        class Broken(FakeRpc):
            def call(self, target, signature, *args, **kwargs):
                if target == OTHER:
                    raise DataError('rpc_error')
                return super().call(target, signature, *args, **kwargs)
        result = self.service(rpc=Broken()).wallet_assets(OWNER, [TOKEN, OTHER])
        self.assertEqual(len(result['items']), 2)
        self.assertEqual(result['unavailableAssets'], [{'currency': OTHER, 'reason': 'rpc_error'}])

    def test_reorg_discards_balances_even_if_inventory_succeeded(self):
        rpc = FakeRpc()
        rpc.reorg = True
        with self.assertRaisesRegex(DataError, 'snapshot_reorganized'):
            self.service(rpc=rpc).wallet_assets(OWNER, [TOKEN])

    def test_disabled_discovery_does_not_call_provider(self):
        def fail(*args):
            self.fail('provider contacted')
        result = self.service(provider=AlchemyInventory(URL, transport=fail)).wallet_assets(OWNER, [TOKEN], auto_discover=False)
        self.assertEqual(result['inventory']['status'], 'not_requested')


class LocalConfigurationTests(unittest.TestCase):
    def test_private_atomic_roundtrip_rejects_permissions_symlinks_and_invalid_config(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory)/'providers.json'
            config = {'version': 1, 'rpcUrl': URL, 'inventoryUrl': URL}
            self.assertEqual(load_config(path), {})
            save_config(config, path)
            self.assertEqual(load_config(path), config)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            path.chmod(0o644)
            with self.assertRaises(DataError):
                load_config(path)
            with self.assertRaises(DataError):
                save_config(config, path)
            link = Path(directory)/'link.json'
            link.symlink_to(path)
            with self.assertRaises(DataError):
                save_config(config, link)
            with self.assertRaises(DataError):
                load_config(link)
            with self.assertRaises(DataError):
                save_config({**config, 'privateKey': 'never-accepted'}, path)
