from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_abi import encode
from eth_hash.auto import keccak
from fastapi.testclient import TestClient
from discovery import (ZERO, DataError, DiscoveryReader, ReadRpc, Block, KEY_TYPES, discover)
from read_service import ReadService
from read_api import create_app, ReadGate
from test_discovery import FakeRpc, TOKEN, OTHER, OWNER, BLOCK, POOL, candidate


class VariableTokensRpc(FakeRpc):
    def __init__(self):
        super().__init__()
        self.decimals = {}
        self.symbols = {}
        self.no_code = set()
        self.missing_precision = set()

    def request(self, method, params=()):
        if method == 'eth_getCode' and params[0] in self.no_code:
            return '0x'
        return super().request(method, params)

    def call(self, target, signature, *args, **kwargs):
        if signature == 'decimals()':
            if target in self.missing_precision:
                raise DataError('rpc_error')
            return (self.decimals.get(target, 18),)
        if signature == 'symbol()':
            return (self.symbols.get(target, 'SAME'),)
        return super().call(target, signature, *args, **kwargs)


class TokenGeneralityTests(unittest.TestCase):
    def service(self, rpc, provider=lambda url: []):
        return ReadService(rpc_factory=lambda: rpc, clock=lambda: 1010,
                           transport_factory=lambda: provider)

    def test_arbitrary_addresses_are_independent_even_when_symbols_match(self):
        rpc = VariableTokensRpc()
        tokens = ['0x' + format(i, '040x') for i in range(1000, 1010)]
        result = self.service(rpc).wallet_assets(OWNER, tokens, auto_discover=False)
        self.assertEqual({x['address'] for x in result['items']}, {ZERO, *tokens})
        self.assertEqual({x['symbol'] for x in result['items'][1:]}, {'SAME'})
        self.assertTrue(all(not x['executionAvailable'] for x in result['items']))

    def test_absent_decimals_keeps_raw_balance_without_assuming_18(self):
        rpc = VariableTokensRpc()
        rpc.missing_precision.add(TOKEN)
        item = self.service(rpc).wallet_assets(OWNER, [TOKEN])['items'][1]
        self.assertEqual(item['amountRaw'], str(2**255 + 123))
        self.assertIsNone(item['decimals'])
        self.assertFalse(item['displayUnitsAvailable'])
        self.assertEqual(item['readStatus'], 'partial')
        self.assertEqual(item['kind'], 'erc20_candidate')

    def test_decimals_zero_six_eight_eighteen_and_uint8_limit_preserved(self):
        for decimals in [0, 6, 8, 18, 255]:
            rpc = VariableTokensRpc()
            rpc.decimals[TOKEN] = decimals
            with self.subTest(decimals=decimals):
                item = self.service(rpc).token(TOKEN)['asset']
                self.assertEqual(item['decimals'], decimals)
                self.assertTrue(item['displayUnitsAvailable'])
        for decimals in [True, -1, 256, '18']:
            rpc = VariableTokensRpc()
            rpc.decimals[TOKEN] = decimals
            with self.subTest(invalid=decimals):
                self.assertIsNone(self.service(rpc).token(TOKEN)['asset']['decimals'])

    def test_optional_metadata_failure_does_not_erase_verified_pool_identity(self):
        rpc = VariableTokensRpc()
        rpc.missing_precision.add(TOKEN)
        result = discover(TOKEN, rpc=rpc, transport=lambda url: [candidate()], clock=lambda: 1010)
        self.assertEqual(len(result['pools']), 1)
        self.assertEqual(result['pools'][0]['identityStatus'], 'verified_at_block')
        self.assertEqual(result['pools'][0]['tokenMetadataStatus'], 'partial')
        self.assertIsNone(result['tokens'][0]['decimals'])

    def test_token_lookup_never_contacts_pool_provider(self):
        def unavailable(url):
            self.fail('standalone lookup contacted aggregator')
        result = self.service(VariableTokensRpc(), unavailable).token(OTHER)
        self.assertEqual(result['asset']['address'], OTHER)
        self.assertEqual(result['asset']['readStatus'], 'available')

    def test_provider_failure_preserves_token_and_is_not_reported_as_zero_pools(self):
        def unavailable(url):
            raise DataError('http_503')
        result = self.service(VariableTokensRpc(), unavailable).pools(TOKEN)
        self.assertEqual(result['selectedTokenReadStatus'], 'available')
        self.assertEqual(result['discovery']['status'], 'unavailable')
        self.assertIsNone(result['discovery']['returned'])
        self.assertIsNone(result['discovery']['v4Candidates'])

    def test_empty_provider_list_is_distinct_from_provider_failure(self):
        result = self.service(VariableTokensRpc()).pools(OTHER)
        self.assertEqual(result['discovery']['status'], 'received')
        self.assertEqual(result['discovery']['returned'], 0)
        self.assertEqual(result['discovery']['coverage'], 'provider_candidates_only')
        self.assertEqual(result['selectedTokenReadStatus'], 'available')

    def test_explicit_pool_lookup_works_without_provider_listing(self):
        def unavailable(url):
            raise DataError('http_503')
        result = self.service(VariableTokensRpc(), unavailable).pools(TOKEN, pool_ids=[POOL])
        self.assertEqual(len(result['pools']), 1)
        pool = result['pools'][0]
        self.assertEqual(pool['currencies'], [ZERO, TOKEN])
        self.assertTrue(pool['requestedById'])
        self.assertIsNone(pool['providerMetrics'])
        self.assertFalse(pool['executionAvailable'])

    def test_explicit_pool_for_different_token_rejected_and_duplicates_not_added(self):
        result = self.service(VariableTokensRpc()).pools(OTHER, pool_ids=[POOL])
        self.assertEqual(result['pools'], [])
        self.assertEqual(result['unverifiedCandidates'][0]['reason'], 'selected_token_mismatch')
        result = self.service(VariableTokensRpc(), lambda url: [candidate()]).pools(TOKEN, pool_ids=[POOL, POOL])
        self.assertEqual(len(result['pools']), 1)
        self.assertEqual(result['discovery']['notProbed'], 0)

    def test_arbitrary_pair_can_exclude_both_native_and_stablecoin(self):
        rpc = VariableTokensRpc()
        rpc.key = (TOKEN, OTHER, 12345, 7, ZERO)
        pool_id = '0x' + keccak(encode(KEY_TYPES, rpc.key)).hex()
        result = self.service(rpc).pools(OTHER, pool_ids=[pool_id])
        self.assertEqual(result['pools'][0]['currencies'], [TOKEN, OTHER])
        self.assertEqual(result['pools'][0]['poolKey']['fee_pips'], 12345)

    def test_no_contract_is_explicit_and_does_not_poison_other_wallet_items(self):
        rpc = VariableTokensRpc()
        rpc.no_code.add(OTHER)
        service = self.service(rpc)
        self.assertEqual(service.token(OTHER)['asset']['readStatus'], 'no_contract')
        result = service.wallet_assets(OWNER, [TOKEN, OTHER])
        self.assertEqual([x['address'] for x in result['items']], [ZERO, TOKEN])
        self.assertEqual(result['unavailableAssets'][0]['reason'], 'token_has_no_code')

    def test_native_eth_and_wrapped_contract_remain_different_assets(self):
        result = self.service(VariableTokensRpc()).wallet_assets(OWNER, [ZERO, TOKEN])
        self.assertEqual(result['items'][0]['kind'], 'native')
        self.assertEqual(result['items'][1]['kind'], 'erc20_candidate')
        self.assertNotEqual(result['items'][0]['address'], result['items'][1]['address'])

    def test_legacy_bytes32_symbol_and_standard_string_use_one_pinned_call(self):
        for output in [encode(['string'], ['LEGACY']), encode(['bytes32'], [b'LEGACY'.ljust(32, b'\0')])]:
            requests = []
            def transport(url, body):
                requests.append(body)
                return {'jsonrpc': '2.0', 'id': body['id'], 'result': '0x' + output.hex()}
            rpc = ReadRpc(transport=transport)
            self.assertEqual(rpc.symbol(TOKEN, block='0x2bc'), 'LEGACY')
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0]['params'][1], '0x2bc')

    def test_control_and_oversize_symbols_do_not_replace_contract_identity(self):
        for symbol in ['bad\x00name', '\u202eevil', 'x'*41, '']:
            rpc = VariableTokensRpc()
            rpc.symbols[TOKEN] = symbol
            item = self.service(rpc).token(TOKEN)['asset']
            self.assertIsNone(item['symbol'])
            self.assertEqual(item['address'], TOKEN)
            self.assertTrue(item['displayUnitsAvailable'])

    def test_http_token_endpoint_and_pool_id_input_validation(self):
        app = create_app(self.service(VariableTokensRpc()), gate=ReadGate(interval=0))
        with TestClient(app, base_url='http://127.0.0.1:8876') as client:
            result = client.post('/v1/read/token', json={'token': OTHER})
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.json()['asset']['address'], OTHER)
            for payload in [{'token': TOKEN, 'poolIds': [POOL], 'maxPools': 1},
                            {'token': TOKEN, 'poolIds': [POOL]}]:
                self.assertEqual(client.post('/v1/read/pools', json=payload).status_code, 200)
            for payload in [{'token': TOKEN, 'poolIds': ['invalid']},
                            {'token': TOKEN, 'poolIds': [POOL, POOL], 'maxPools': 1},
                            {'token': TOKEN, 'poolIds': [POOL]*11}]:
                self.assertEqual(client.post('/v1/read/pools', json=payload).status_code, 422)

    def test_lookup_reorg_never_returns_successful_token_snapshot(self):
        rpc = VariableTokensRpc()
        rpc.reorg = True
        with self.assertRaisesRegex(DataError, 'snapshot_reorganized'):
            self.service(rpc).token(OTHER)
