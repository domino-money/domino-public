from decimal import Decimal
import json
import io
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import PUBLIC_RPC_URL
from discovery import (CHAIN_ID, ZERO, POOL_MANAGER, POSITION_MANAGER, STATE_VIEW,
                       Block, DataError, DiscoveryReader, PoolKey, ReadRpc, KEY_TYPES,
                       decimal_metric, discover, json_http, provider_candidates)
from eth_abi import encode
from eth_hash.auto import keccak

TOKEN = '0x' + '11' * 20
OTHER = '0x' + '22' * 20
OWNER = '0x' + '33' * 20
KEY = (ZERO, TOKEN, 3000, 60, ZERO)
POOL = '0x' + keccak(encode(KEY_TYPES, KEY)).hex()
BLOCK = {'number': '0x2bc', 'hash': '0x' + 'ab' * 32, 'timestamp': '0x3e8'}


def candidate():
    return {'chainId': 'robinhood', 'dexId': 'uniswap', 'labels': ['v4'],
            'pairAddress': POOL, 'baseToken': {'address': TOKEN},
            'quoteToken': {'address': ZERO}, 'volume': {'h24': Decimal('1234.56')},
            'liquidity': {'usd': '10.00'}}


class FakeRpc:
    def __init__(self):
        self.chain = CHAIN_ID
        self.blocks_read = 0
        self.reorg = False
        self.key = KEY
        self.linked_manager = POOL_MANAGER
        self.missing_code = False
        self.missing_symbol = False
        self.calls = []

    def request(self, method, params=()):
        if method == 'eth_chainId':
            return hex(self.chain)
        if method == 'eth_getBlockByNumber':
            self.blocks_read += 1
            raw = dict(BLOCK)
            if self.reorg and self.blocks_read > 1:
                raw['hash'] = '0x' + 'cd' * 32
            return raw
        if method == 'eth_getCode':
            assert params[1] == BLOCK['number']
            return '0x' if self.missing_code else '0x6000'
        if method == 'eth_getBalance':
            assert params == [OWNER, BLOCK['number']]
            return '0x0'
        raise AssertionError(method)

    def symbol(self, target, *, block):
        return self.call(target, 'symbol()', outputs=['string'], block=block)[0]

    def call(self, target, signature, inputs=(), values=(), outputs=(), *, block):
        assert block == BLOCK['number']
        self.calls.append((target, signature, inputs, values, outputs, block))
        if signature == 'poolManager()':
            return (self.linked_manager,)
        if signature == 'poolKeys(bytes25)':
            expected = keccak(encode(KEY_TYPES, self.key))
            assert values == [expected[:25]]
            return self.key
        if signature == 'getSlot0(bytes32)':
            return (2**96, 0, 0, self.key[2])
        if signature == 'decimals()':
            return (6,)
        if signature == 'symbol()':
            if self.missing_symbol:
                raise DataError('rpc_error')
            return ('TOKEN',)
        if signature == 'ownerOf(uint256)':
            return (OWNER,)
        if signature == 'balanceOf(address)':
            return (2**255 + 123,)
        raise AssertionError(signature)


class DiscoveryTests(unittest.TestCase):
    def test_live_shape_verified_at_one_block_does_not_authorize_execution(self):
        rpc = FakeRpc()
        report = discover(TOKEN, rpc=rpc, transport=lambda url: [candidate()], clock=lambda: 1010)
        pool = report['pools'][0]
        self.assertEqual(pool['poolKey']['fee_pips'], 3000)
        self.assertEqual(pool['poolKey']['currency0'], ZERO)
        self.assertEqual(pool['providerMetrics']['volume24hUsd'], '1234.56')
        self.assertIsNone(pool['providerMetrics']['asOfBlock'])
        self.assertIsNone(pool['feeApr24h'])
        self.assertFalse(pool['suggested'])
        self.assertFalse(pool['executionAvailable'])
        self.assertEqual(rpc.blocks_read, 2)

    def test_no_provider_pools_is_incomplete_coverage_not_no_pool_exists(self):
        report = discover(TOKEN, rpc=FakeRpc(), transport=lambda url: [], clock=lambda: 1010)
        self.assertEqual(report['pools'], [])
        self.assertEqual(report['discovery']['coverage'], 'provider_candidates_only')
        self.assertEqual(report['tokens'][0]['address'], TOKEN)

    def test_hook_pool_is_visible_but_never_promoted_to_automation(self):
        rpc = FakeRpc()
        rpc.key = (ZERO, TOKEN, 0, 200, OTHER)
        raw = candidate()
        raw['pairAddress'] = '0x' + keccak(encode(KEY_TYPES, rpc.key)).hex()
        report = discover(TOKEN, rpc=rpc, transport=lambda url: [raw], clock=lambda: 1010)
        pool = report['pools'][0]
        self.assertEqual(pool['integrationClass'], 'requires_separate_adapter')
        self.assertFalse(pool['suggested'])
        self.assertFalse(pool['executionAvailable'])

    def test_wrong_chain_missing_contract_or_wrong_link_aborts(self):
        for setting, value in [('chain', 1), ('missing_code', True), ('linked_manager', OTHER)]:
            rpc = FakeRpc()
            setattr(rpc, setting, value)
            with self.subTest(setting=setting), self.assertRaises(DataError):
                DiscoveryReader(rpc, clock=lambda: 1010).snapshot()

    def test_changed_canonical_hash_discards_entire_report(self):
        rpc = FakeRpc()
        rpc.reorg = True
        with self.assertRaisesRegex(DataError, 'snapshot_reorganized'):
            discover(TOKEN, rpc=rpc, transport=lambda url: [candidate()], clock=lambda: 1010)

    def test_stale_and_future_block_rejected(self):
        for now in [1201, 980]:
            with self.subTest(now=now), self.assertRaisesRegex(DataError, 'stale_or_future_block'):
                DiscoveryReader(FakeRpc(), clock=lambda: now).snapshot()

    def test_full_pool_hash_checked_beyond_truncated_cache_key(self):
        altered = POOL[:-2] + ('00' if POOL[-2:] != '00' else '01')
        self.assertEqual(altered[:52], POOL[:52])
        with self.assertRaisesRegex(DataError, 'pool_id_mismatch'):
            PoolKey.checked(KEY, altered)

    def test_wrong_tokens_even_with_matching_symbol_do_not_enter_catalogue(self):
        bad = candidate()
        bad['baseToken'] = {'address': OTHER, 'symbol': 'TOKEN'}
        good, rejected = provider_candidates([bad], TOKEN, 1010)
        self.assertEqual(good, [])
        self.assertEqual(rejected, 1)

    def test_provider_currencies_must_match_onchain_key(self):
        item = candidate()
        item['quoteToken']['address'] = OTHER
        report = discover(TOKEN, rpc=FakeRpc(), transport=lambda url: [item], clock=lambda: 1010)
        self.assertEqual(report['pools'], [])
        self.assertEqual(report['unverifiedCandidates'][0]['reason'], 'provider_currency_mismatch')

    def test_other_chains_versions_and_ambiguous_duplicate_ids_filtered(self):
        items = []
        for key, value in [('chainId', 'ethereum'), ('labels', ['v3']), ('dexId', 'other')]:
            item = candidate()
            item[key] = value
            items.append(item)
        conflict = candidate()
        conflict['quoteToken']['address'] = OTHER
        selected, rejected = provider_candidates(items + [candidate(), conflict], TOKEN, 1010)
        self.assertEqual(selected, [])
        self.assertEqual(rejected, 4)

    def test_missing_zero_and_invalid_metrics_are_distinct(self):
        self.assertEqual(decimal_metric(0), '0')
        self.assertEqual(decimal_metric('123.456789'), '123.456789')
        for value in [None, True, -1, 'NaN', 'Infinity', '1e100', '0e-1000000', {}]:
            with self.subTest(value=value):
                self.assertIsNone(decimal_metric(value))

    def test_native_balance_and_large_token_balance_stay_exact(self):
        result = DiscoveryReader(FakeRpc()).balances(OWNER, [TOKEN], Block(700, BLOCK['hash'], 1000))
        self.assertEqual(result['items'][0]['amountRaw'], '0')
        self.assertEqual(result['items'][1]['amountRaw'], str(2**255 + 123))
        self.assertEqual(result['coverage'], 'requested_addresses_only')

    def test_wallet_report_redacts_identity_and_quantities_on_inventory_failure(self):
        def transport(url):
            if 'blockscout' in url:
                raise DataError('http_403')
            return [candidate()]
        report = discover(TOKEN, rpc=FakeRpc(), transport=transport, clock=lambda: 1010,
                          position_id=123, probe_inventory=True)
        serialized = json.dumps(report)
        self.assertNotIn(OWNER, serialized)
        self.assertNotIn(str(2**255 + 123), serialized)
        self.assertEqual(report['walletInventory']['status'], 'unavailable')
        self.assertEqual(report['walletBalanceProbe']['coverage'], 'requested_addresses_only')

    def test_missing_symbol_preserves_contract_identity(self):
        rpc = FakeRpc()
        rpc.missing_symbol = True
        token = DiscoveryReader(rpc).token(TOKEN, Block(700, BLOCK['hash'], 1000))
        self.assertEqual(token['address'], TOKEN)
        self.assertIsNone(token['symbol'])

    def test_transport_never_sends_signing_or_broadcast_methods(self):
        transport = Mock()
        rpc = ReadRpc(PUBLIC_RPC_URL, transport=transport)
        for method in ['eth_sendRawTransaction', 'eth_sendTransaction', 'eth_sign', 'personal_sign']:
            with self.assertRaisesRegex(DataError, 'method_not_read_only'):
                rpc.request(method)
        transport.assert_not_called()

    def test_rpc_envelope_budget_and_error_redaction(self):
        bad = ReadRpc(PUBLIC_RPC_URL, transport=lambda *args: {'jsonrpc': '2.0', 'id': 9, 'result': '0x1'})
        with self.assertRaisesRegex(DataError, 'invalid_rpc_envelope'):
            bad.request('eth_chainId')
        rpc = ReadRpc(PUBLIC_RPC_URL, max_requests=1, transport=lambda *args: {'jsonrpc': '2.0', 'id': 1, 'result': '0x1237'})
        self.assertEqual(rpc.request('eth_chainId'), '0x1237')
        with self.assertRaisesRegex(DataError, 'request_budget_exhausted'):
            rpc.request('eth_chainId')
        broken = ReadRpc(PUBLIC_RPC_URL, transport=lambda *args: {'jsonrpc': '2.0', 'id': 1,
                                                'error': {'message': 'private URL secret'}})
        with self.assertRaises(DataError) as caught:
            broken.request('eth_chainId')
        self.assertEqual(str(caught.exception), 'rpc_error')

    def test_network_errors_never_expose_provider_credentials(self):
        def opener(*args, **kwargs):
            raise urllib.error.URLError('https://private.example/api/secret-value')
        with self.assertRaises(DataError) as caught:
            json_http('https://private.example/api/secret-value', opener=opener)
        self.assertEqual(str(caught.exception), 'network_unavailable')

    def test_http_error_response_is_closed_without_exposing_its_reason(self):
        response = io.BytesIO(b'private upstream response')
        error = urllib.error.HTTPError('https://example.invalid/private-canary', 503,
                                       'private-reason-canary', {}, response)
        def opener(*args, **kwargs):
            raise error
        with self.assertRaises(DataError) as caught:
            json_http('https://example.invalid', opener=opener)
        self.assertEqual(str(caught.exception), 'http_503')
        self.assertTrue(response.closed)

    def test_invalid_json_integer_and_endpoint_fail_with_safe_codes(self):
        with self.assertRaisesRegex(DataError, 'invalid_json'):
            json_http('https://example.test', opener=lambda *a, **k: io.BytesIO(b'9' * 5000))
        with self.assertRaisesRegex(DataError, 'https_endpoint_required'):
            json_http('https://example.test:invalid/private-credential')

    def test_redirect_cannot_forward_credentials_or_wallet_query(self):
        from discovery import NoRedirect
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, 'redirect', {}, 'https://unrelated.test'))

    def test_response_size_error_is_preserved(self):
        with self.assertRaisesRegex(DataError, 'response_too_large'):
            json_http('https://example.test', opener=lambda *a, **k: io.BytesIO(b' ' * 2_000_001))


if __name__ == '__main__':
    unittest.main()
