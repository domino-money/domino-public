import copy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import CHAIN_ID, DataError, KEY_TYPES, ZERO
from eth_abi import encode
from eth_hash.auto import keccak
from uniswap_liquidity import (ENDPOINT, MAX_POOLS, PROBE_POOL_ID, PROBE_USDG,
                               PROBE_WETH, SOURCE, UniswapLiquidity, probe)
from v4_math import Q96, sqrt_at_tick

TOKEN_A = '0x' + '11' * 20
TOKEN_B = '0x' + '22' * 20
SECRET = 'offline-test-key-never-print'


def row(a=TOKEN_A, b=TOKEN_B, fee=3000, spacing=60, hooks=ZERO):
    a, b = sorted((a, b))
    return {'poolReferenceIdentifier': '0x' + keccak(encode(KEY_TYPES, (a, b, fee, spacing, hooks))).hex(),
            'poolProtocol': 'V4', 'chainId': CHAIN_ID, 'tokenAddressA': a, 'tokenAddressB': b,
            'fee': str(fee), 'tickSpacing': spacing, 'hookAddress': hooks,
            'poolLiquidity': str((1 << 127) + 17), 'sqrtRatioX96': str(Q96), 'currentTick': 0,
            'tokenDecimalsA': 6, 'tokenDecimalsB': 18,
            'token0Reserves': str((1 << 255) + 123), 'token1Reserves': '0'}


class Transport:
    def __init__(self, pools=None, error=None):
        self.payload = {'pools': [row()] if pools is None else pools,
                        'pageSize': MAX_POOLS, 'currentPage': 1}
        self.error = error
        self.calls = []

    def __call__(self, url, body, **kwargs):
        self.calls.append((url, copy.deepcopy(body), kwargs))
        if self.error:
            raise self.error
        return copy.deepcopy(self.payload)


class UniswapLiquidityTests(unittest.TestCase):
    def read(self, transport=None, **kwargs):
        transport = transport or Transport()
        client = UniswapLiquidity(SECRET, transport=transport, clock=lambda: 1234567890.75)
        return client.by_pair(TOKEN_B, TOKEN_A, fee=3000, tick_spacing=60, **kwargs)

    def test_exact_read_endpoint_body_headers_and_precision(self):
        transport = Transport()
        report = self.read(transport, hooks=ZERO)
        self.assertEqual(len(transport.calls), 1)
        url, body, opts = transport.calls[0]
        self.assertEqual(url, ENDPOINT)
        self.assertEqual(body, {'protocol': 'V4', 'chainId': 4663, 'pageSize': 20,
                               'poolParameters': {'tokenAddressA': TOKEN_A, 'tokenAddressB': TOKEN_B,
                                                  'fee': 3000, 'tickSpacing': 60, 'hookAddress': ZERO}})
        self.assertEqual(opts, {'timeout': 12, 'headers': {'x-api-key': SECRET}})
        pool = report['pools'][0]
        self.assertEqual(pool['liquidityRaw'], str((1 << 127) + 17))
        self.assertEqual(pool['reserves']['amount0Raw'], str((1 << 255) + 123))
        self.assertEqual(pool['reserves']['amount1Raw'], '0')
        self.assertEqual(report['source'], SOURCE)
        self.assertEqual(report['retrievedAt'], 1234567890)
        self.assertIsNone(report['asOfBlock'])
        self.assertIsNone(report['asOfTimestamp'])
        self.assertFalse(report['coverage']['complete'])
        self.assertFalse(report['provenance']['onchainSnapshotVerified'])
        self.assertNotIn(SECRET, json.dumps(report))
        self.assertNotIn('feeApr24h', pool)

    def test_optional_reserves_and_decimals_never_default_to_zero(self):
        r = row()
        for key in ('token0Reserves', 'token1Reserves', 'tokenDecimalsA'):
            r.pop(key)
        pool = self.read(Transport([r]))['pools'][0]
        self.assertEqual(pool['reserves']['status'], 'unavailable')
        self.assertIsNone(pool['reserves']['amount0Raw'])
        self.assertIsNone(pool['tokens'][0]['decimals'])
        r['token0Reserves'] = '0'
        self.assertEqual(self.read(Transport([r]))['pools'][0]['reserves']['status'], 'partial')

    def test_live_pool_info_decimal_strings_are_normalized(self):
        # The public Robinhood endpoint returned these strings on 2026-09-09,
        # although its OpenAPI schema describes tokenDecimalsA/B as numbers.
        r = row(PROBE_WETH, PROBE_USDG, fee=200, spacing=4)
        r.update(tokenDecimalsA='18', tokenDecimalsB='6',
                 poolLiquidity='115950763535802074',
                 sqrtRatioX96='3931860081503275949785300', currentTick=-198230,
                 token0Reserves='76532754161666713386', token1Reserves='219850197379')
        pool = probe(SECRET, transport=Transport([r]), clock=lambda: 123)['pools'][0]
        self.assertEqual([token['decimals'] for token in pool['tokens']], [18, 6])
        self.assertTrue(all(type(token['decimals']) is int for token in pool['tokens']))
        self.assertEqual(pool['reserves']['amount1Raw'], '219850197379')
        self.assertEqual(pool['sqrtPriceX96'], r['sqrtRatioX96'])

    def test_decimal_string_normalization_preserves_bounds_and_absence(self):
        for value, expected in (('0', 0), ('255', 255), (None, None), (18, 18)):
            r = row(); r['tokenDecimalsA'] = value
            self.assertEqual(self.read(Transport([r]))['pools'][0]['tokens'][0]['decimals'], expected)
        for value in ('256', '-1', '18.0', '1e1', ' 18', '18 ', '', '018', True, 18.0):
            with self.subTest(value=value):
                r = row(); r['tokenDecimalsA'] = value
                with self.assertRaises(DataError):
                    self.read(Transport([r]))

    def test_generic_addresses_native_currency_and_hook_are_supported(self):
        hook = '0x' + '99' * 20
        r = row(ZERO, TOKEN_B, fee=0x800000, spacing=17, hooks=hook)
        client = UniswapLiquidity(SECRET, transport=Transport([r]), clock=lambda: 1)
        report = client.by_pair(TOKEN_B, ZERO, fee=0x800000, tick_spacing=17, hooks=hook)
        self.assertEqual(report['pools'][0]['currencies'], [ZERO, TOKEN_B])

    def test_reversed_provider_token_metadata_stays_bound_to_address(self):
        r = row()
        r['tokenAddressA'], r['tokenAddressB'] = r['tokenAddressB'], r['tokenAddressA']
        pool = self.read(Transport([r]))['pools'][0]
        self.assertEqual(pool['tokens'][0]['decimals'], 18)
        self.assertEqual(pool['tokens'][1]['decimals'], 6)
        self.assertEqual(pool['reserves']['amount0Raw'], row()['token0Reserves'])

    def test_mismatched_chain_protocol_currency_and_hash_fail_closed(self):
        cases = [('chainId', 1), ('chainId', '4663'), ('poolProtocol', 'V3'),
                 ('tokenAddressA', ZERO), ('poolReferenceIdentifier', '0x' + 'ab' * 32),
                 ('tokenAddressB', TOKEN_A), ('hookAddress', None),
                 ('fee', '500'), ('tickSpacing', 10)]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                r = row(); r[field] = value
                with self.assertRaises(DataError):
                    self.read(Transport([r]))

    def test_wrong_explicit_hook_cannot_be_associated_with_request(self):
        r = row(hooks='0x' + '99' * 20)
        with self.assertRaisesRegex(DataError, 'uniswap_pool_parameters_mismatch'):
            self.read(Transport([r]), hooks=ZERO)

    def test_malformed_numbers_fail_without_float_conversion(self):
        cases = [('poolLiquidity', 1), ('poolLiquidity', str(1 << 128)),
                 ('sqrtRatioX96', '0'), ('sqrtRatioX96', str(1 << 160)),
                 ('token0Reserves', '1.5'), ('token1Reserves', '-1'),
                 ('token0Reserves', '1e9'), ('token0Reserves', '9' * 1000),
                 ('tokenDecimalsA', True), ('tokenDecimalsB', 256),
                 ('currentTick', 1.0), ('tickSpacing', True), ('fee', 'NaN')]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                r = row(); r[field] = value
                with self.assertRaises(DataError):
                    self.read(Transport([r]))

    def test_price_tick_coherence_allows_exact_left_crossing_only(self):
        r = row(); r['currentTick'] = -1
        self.assertEqual(self.read(Transport([r]))['pools'][0]['tick'], -1)
        r['sqrtRatioX96'] = str(Q96 + 1)
        with self.assertRaisesRegex(DataError, 'inconsistent_uniswap_price_tick'):
            self.read(Transport([r]))
        r['currentTick'] = 23; r['sqrtRatioX96'] = str(sqrt_at_tick(23))
        self.assertEqual(self.read(Transport([r]))['pools'][0]['tick'], 23)

    def test_response_bounds_duplicates_errors_and_empty_coverage(self):
        for pools in ([row()] * 21, [row(), row()], [row(), None]):
            with self.assertRaises(DataError):
                self.read(Transport(pools))
        for payload in ({'code': 'failed_precondition', 'message': SECRET},
                        {'pools': [row()], 'error': SECRET}, {'pools': {}}, None):
            t = Transport(); t.payload = payload
            with self.assertRaises(DataError) as cm:
                self.read(t)
            self.assertNotIn(SECRET, str(cm.exception))
        report = self.read(Transport([]))
        self.assertEqual(report['pools'], [])
        self.assertFalse(report['coverage']['complete'])

    def test_invalid_input_never_sends_a_request(self):
        t = Transport()
        for bad_key in ('', 'key\r\nx-injected: yes', ' padded ', 'x' * 513, None):
            with self.assertRaisesRegex(DataError, 'invalid_uniswap_api_key'):
                UniswapLiquidity(bad_key, transport=t)
        client = UniswapLiquidity(SECRET, transport=t)
        for kwargs in ({'token_a': TOKEN_A, 'token_b': TOKEN_A, 'fee': 3000, 'tick_spacing': 60},
                       {'token_a': TOKEN_A, 'token_b': TOKEN_B, 'fee': True, 'tick_spacing': 60},
                       {'token_a': TOKEN_A, 'token_b': TOKEN_B, 'fee': 3000, 'tick_spacing': 0},
                       {'token_a': SECRET, 'token_b': TOKEN_B, 'fee': 3000, 'tick_spacing': 60}):
            with self.assertRaises(DataError):
                client.by_pair(**kwargs)
        self.assertEqual(t.calls, [])

    def test_transport_errors_and_repr_do_not_expose_secret(self):
        for error, expected in ((RuntimeError(SECRET), 'uniswap_transport_unavailable'),
                                (DataError('http_401'), 'http_401'),
                                (DataError('network_unavailable'), 'network_unavailable'),
                                (DataError('http_401 ' + SECRET), 'uniswap_transport_unavailable')):
            t = Transport(error=error)
            with self.assertRaises(DataError) as cm:
                self.read(t)
            self.assertEqual(str(cm.exception), expected)
            self.assertNotIn(SECRET, str(cm.exception))
            self.assertTrue(cm.exception.__suppress_context__)
            self.assertEqual(len(t.calls), 1)
        self.assertNotIn(SECRET, repr(UniswapLiquidity(SECRET)))

    def test_configuration_probe_binds_the_known_pool(self):
        r = row(PROBE_WETH, PROBE_USDG, fee=200, spacing=4)
        self.assertEqual(r['poolReferenceIdentifier'], PROBE_POOL_ID)
        report = probe(SECRET, transport=Transport([r]), clock=lambda: 123)
        self.assertEqual(report['probeStatus'], 'known_pool_readable')
        with self.assertRaisesRegex(DataError, 'uniswap_probe_pool_missing'):
            probe(SECRET, transport=Transport([]))


if __name__ == '__main__':
    unittest.main()
