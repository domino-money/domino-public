"""Provider composition + independent caps/identity validation, no liquidity math."""
from copy import deepcopy
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import DataError, PoolKey, ZERO
from read_deadline import read_deadline
from uniswap_position import ENDPOINT, TIMEOUT_SECONDS, UniswapPosition
from test_lp_mint_inspection import (OWNER, OTHER, TOKEN0, TOKEN1, fixture, plan, set_plan)

KEY = 'offline-private-key-canary'


def response(*, native=False, cap0=101, cap1=202, nominal0='100', nominal1='200'):
    tx, context = fixture(native=native, cap0=cap0, cap1=cap1)
    actions, params, _ = plan(tx)
    set_plan(tx, actions, params, deadline=2200)
    return {'token0': {'tokenAddress': context['pool_key'].currency0, 'amount': nominal0},
        'token1': {'tokenAddress': TOKEN1, 'amount': nominal1},
        'tickLower': -120, 'tickUpper': 180, 'adjustedMinPrice': '0.9880723056656161819557585',
        'adjustedMaxPrice': '1.01816206010461250825511659', 'create': tx,
        'requestId': KEY, 'unexpectedProviderText': KEY}, context


class Transport:
    def __init__(self, data=None, error=None):
        self.data = response()[0] if data is None else data
        self.error, self.calls = error, []

    def __call__(self, url, body, **options):
        self.calls.append((url, deepcopy(body), options))
        if self.error:
            raise self.error
        return deepcopy(self.data)


class PositionPreviewTests(unittest.TestCase):
    def preview(self, data=None, transport=None, clock=lambda: 1000.5, native=False, **overrides):
        _, context = response(native=native)
        args = {key: value for key, value in context.items() if key != 'deadline'}
        args.update(independent_token=context['pool_key'].currency0, amount_raw='100', slippage_bps=50,
                    budget0_raw='110', budget1_raw='220', native_balance_raw='1000',
                    native_gas_reserve_raw='300')
        args.update(overrides)
        transport = transport or Transport(data if data is not None else response(native=native)[0])
        return UniswapPosition(KEY, transport=transport, clock=clock).preview(**args)

    def test_exact_request_and_safe_projection(self):
        transport = Transport()
        result = self.preview(transport=transport)
        self.assertEqual(len(transport.calls), 1)
        url, body, options = transport.calls[0]
        self.assertEqual(url, ENDPOINT)
        self.assertEqual(options, {'timeout': TIMEOUT_SECONDS, 'headers': {'x-api-key': KEY}})
        self.assertEqual(body, {'walletAddress': OWNER, 'chainId': 4663, 'protocol': 'V4',
            'existingPool': {'token0Address': TOKEN0, 'token1Address': TOKEN1,
                             'poolReference': result['position']['poolId']},
            'independentToken': {'tokenAddress': TOKEN0, 'amount': '100'},
            'dependentToken': {'tokenAddress': TOKEN1, 'amount': '220'},
            'tickBounds': {'tickLower': -120, 'tickUpper': 180}, 'slippageTolerance': .5,
            'deadline': 2200, 'simulateTransaction': False, 'nativeTokenBalance': '1000'})
        self.assertEqual(result['previewChecks'], {'status': 'within_selected_limits', 'reasons': []})
        self.assertEqual((result['requestedAt'], result['retrievedAt'], result['expiresAt']), (1000, 1000, 1030))
        self.assertFalse(result['executionAvailable'])
        self.assertEqual(result['dominoFee']['bps'], 0)
        self.assertFalse(result['dominoFee']['automationFeeApplies'])
        self.assertEqual(result['simulation']['status'], 'not_requested')
        self.assertIsNone(result['gas']['feeWei'])
        self.assertIsNone(result['provenance']['blockNumber'])
        self.assertFalse(result['provenance']['onchainSnapshotVerified'])
        self.assertFalse(result['provenance']['slippageModelIndependentlyVerified'])
        rendered = json.dumps(result)
        for text in (KEY, 'dd46508f', 'unexpectedProviderText', 'requestId', 'calldata', 'permit'):
            self.assertNotIn(text, rendered)

    def test_nominal_and_maximum_and_unspent_are_distinct(self):
        a, b = self.preview()['position']['tokens']
        self.assertEqual(a, {'address': TOKEN0, 'expectedDepositRaw': '100', 'maximumDebitRaw': '101',
            'selectedBudgetRaw': '110', 'budgetStatus': 'within_limit',
            'estimatedUnspentBudgetRaw': '10', 'unspentAtMaximumRaw': '9'})
        self.assertEqual(b['estimatedUnspentBudgetRaw'], '20')
        self.assertEqual(b['unspentAtMaximumRaw'], '18')

    def test_opposite_independent_side_and_generic_pair(self):
        transport = Transport()
        result = self.preview(transport=transport, independent_token=TOKEN1, amount_raw='200')
        body = transport.calls[0][1]
        self.assertEqual(body['independentToken'], {'tokenAddress': TOKEN1, 'amount': '200'})
        self.assertEqual(body['dependentToken'], {'tokenAddress': TOKEN0, 'amount': '110'})
        self.assertEqual(result['position']['tokens'][1]['expectedDepositRaw'], '200')

    def test_unknown_budgets_native_balance_and_gas_remain_unknown(self):
        transport = Transport()
        result = self.preview(transport=transport, budget0_raw=None, budget1_raw=None,
                              native_balance_raw=None, native_gas_reserve_raw=None)
        self.assertNotIn('dependentToken', transport.calls[0][1])
        self.assertNotIn('nativeTokenBalance', transport.calls[0][1])
        self.assertEqual(result['previewChecks']['status'], 'incomplete')
        self.assertEqual(len(result['previewChecks']['reasons']), 4)
        for token in result['position']['tokens']:
            self.assertEqual(token['budgetStatus'], 'unknown')
            self.assertIsNone(token['estimatedUnspentBudgetRaw'])
            self.assertIsNone(token['unspentAtMaximumRaw'])
        self.assertIsNone(result['nativeFunding']['reportedBalanceRaw'])

    def test_provider_dependent_budget_not_trusted(self):
        result = self.preview(budget1_raw='1')
        self.assertEqual(result['previewChecks']['status'], 'blocked')
        self.assertIn('token1_maximum_exceeds_budget', result['previewChecks']['reasons'])
        token = result['position']['tokens'][1]
        self.assertIsNone(token['estimatedUnspentBudgetRaw'])
        self.assertIsNone(token['unspentAtMaximumRaw'])

    def test_slippage_max_can_exceed_budget_even_when_nominal_fits(self):
        result = self.preview(budget0_raw='100', budget1_raw='200')
        self.assertEqual(result['previewChecks']['reasons'],
                         ['token0_maximum_exceeds_budget', 'token1_maximum_exceeds_budget'])
        self.assertEqual(result['position']['tokens'][0]['estimatedUnspentBudgetRaw'], '0')
        self.assertIsNone(result['position']['tokens'][0]['unspentAtMaximumRaw'])

    def test_native_deposit_and_selected_gas_reserve_share_balance(self):
        result = self.preview(native=True, native_balance_raw='400')
        self.assertEqual(result['nativeFunding']['depositMaximumRaw'], '101')
        self.assertEqual(result['previewChecks']['reasons'], ['native_gas_reserve_exceeded'])
        self.assertFalse(result['nativeFunding']['reserveCoversActualGasVerified'])
        result = self.preview(native=True, native_balance_raw='100', native_gas_reserve_raw='0')
        self.assertIn('native_deposit_exceeds_balance', result['previewChecks']['reasons'])
        self.assertEqual(self.preview(native=True, native_balance_raw='401')['previewChecks']['status'],
                         'within_selected_limits')

    def test_erc20_still_needs_selected_native_gas_headroom(self):
        result = self.preview(native_balance_raw='10', native_gas_reserve_raw='11')
        self.assertEqual(result['previewChecks']['reasons'], ['native_gas_reserve_exceeded'])
        result = self.preview(native_balance_raw='0', native_gas_reserve_raw='0')
        self.assertEqual(result['previewChecks']['status'], 'within_selected_limits')
        self.assertFalse(result['nativeFunding']['reserveCoversActualGasVerified'])

    def test_single_sided_zero_is_supported_and_not_missing(self):
        data, _ = response(nominal1='0', cap1=0)
        result = self.preview(data, budget1_raw='0')
        self.assertEqual(result['position']['tokens'][1]['expectedDepositRaw'], '0')
        self.assertEqual(result['position']['tokens'][1]['maximumDebitRaw'], '0')
        self.assertEqual(result['position']['tokens'][1]['unspentAtMaximumRaw'], '0')

    def test_independent_amount_may_be_reduced_without_inventing_consumption(self):
        data, _ = response(nominal0='90')
        result = self.preview(data)
        self.assertEqual(result['position']['tokens'][0]['expectedDepositRaw'], '90')
        self.assertEqual(result['position']['tokens'][0]['estimatedUnspentBudgetRaw'], '20')

    def test_invalid_inputs_fail_before_network(self):
        _, context = response()
        key = context['pool_key']
        invalid = [dict(owner=ZERO), dict(owner='0x'+'0'*39+'1'), dict(owner=123),
            dict(chain_id=True), dict(chain_id='4663'), dict(chain_id=1), dict(pool_key=None),
            dict(pool_id='0x'+'0'*64), dict(independent_token=OTHER),
            dict(tick_lower=True), dict(tick_upper='180'), dict(tick_lower=-121),
            dict(tick_upper=-120), dict(tick_upper=887273), dict(slippage_bps=True),
            dict(slippage_bps=10000), dict(slippage_bps=-1), dict(slippage_bps=0.5),
            dict(native_balance_raw=None), dict(native_gas_reserve_raw='-1'),
            dict(budget0_raw='99'), dict(pool_key=PoolKey(key.currency1,key.currency0,3000,60,ZERO))]
        for value in ('0', '01', '1e18', '-1', 1, True, str(2**256), '9'*10000):
            invalid.append(dict(amount_raw=value))
        for value in ('-1', True, 1, str(2**256), '1e3'):
            invalid.append(dict(budget1_raw=value))
        for args in invalid:
            with self.subTest(args=str(args)[:160]):
                transport = Transport()
                with self.assertRaises(DataError):
                    self.preview(transport=transport, **args)
                self.assertEqual(transport.calls, [])

    def test_hooked_dynamic_fee_and_wrong_pool_hash_fail_before_network(self):
        from eth_abi import encode
        from eth_hash.auto import keccak
        from discovery import KEY_TYPES
        for values in ((TOKEN0,TOKEN1,0x800000,60,ZERO), (TOKEN0,TOKEN1,3000,60,OTHER)):
            transport = Transport()
            with self.assertRaisesRegex(DataError, '^uniswap_position_pool_unsupported$'):
                self.preview(transport=transport, pool_key=PoolKey(*values),
                             pool_id='0x'+keccak(encode(KEY_TYPES, values)).hex())
            self.assertEqual(transport.calls, [])

    def test_bad_amount_response_and_excess_independent_are_rejected(self):
        for side, value in ((0, '101'), (0, None), (1, True), (1, '01'), (1, '-1'), (1, str(2**256))):
            data, _ = response()
            data['token'+str(side)]['amount'] = value
            with self.subTest(side=side,value=value), self.assertRaises(DataError):
                self.preview(data)
        data, _ = response(nominal0='0', nominal1='0')
        with self.assertRaisesRegex(DataError, 'uniswap_position_input_mismatch'):
            self.preview(data)

    def test_nominal_amount_must_fit_actual_encoded_mint_caps(self):
        data, _ = response(cap1=199)
        with self.assertRaisesRegex(DataError, '^uniswap_position_amount_mismatch$'):
            self.preview(data)

    def test_response_tokens_cannot_swap_currency_order_or_native_alias(self):
        for index, currency in ((0, TOKEN1), (1,TOKEN0), (0,ZERO), (0,OTHER)):
            data, _ = response()
            data['token'+str(index)]['tokenAddress'] = currency
            with self.subTest(index=index,currency=currency), self.assertRaises(DataError):
                self.preview(data)

    def test_requested_ticks_must_match_response_and_encoded_mint(self):
        for name, value in (('tickLower', -60), ('tickUpper',240), ('tickLower',True), ('tickUpper','180')):
            data, _ = response()
            data[name] = value
            with self.subTest(name=name,value=value), self.assertRaises(DataError):
                self.preview(data)
        data, _ = response()
        data['tickLower'] = -60
        with self.assertRaisesRegex(DataError, 'lp_mint_request_mismatch'):
            self.preview(data, tick_lower=-60)

    def test_mint_inspection_is_not_bypassed_by_valid_summary(self):
        for field, value in (('from',OTHER), ('to',OTHER), ('chainId',1), ('data','0x12345678'), ('value','1')):
            data, _ = response()
            data['create'][field] = value
            with self.subTest(field=field), self.assertRaises(DataError):
                self.preview(data)

    def test_price_units_are_explicit_raw_provider_data_with_no_guessed_decimals(self):
        prices = self.preview()['position']['adjustedPrices']
        self.assertEqual(prices['unit'], 'raw_token1_per_raw_token0')
        self.assertIsNone(prices['humanPrices'])
        self.assertEqual(prices['status'], 'provider_reported')

    def test_invalid_prices_rejected(self):
        for value in (None, 1, True, 'NaN', 'Infinity', '-1', '0', '1e9999', '1e-9999', '9'*1000):
            data, _ = response()
            data['adjustedMinPrice'] = value
            with self.subTest(value=str(value)[:50]), self.assertRaises(DataError):
                self.preview(data)
        data, _ = response()
        data['adjustedMaxPrice'] = data['adjustedMinPrice']
        with self.assertRaises(DataError):
            self.preview(data)

    def test_missing_response_fields_and_error_payloads_rejected(self):
        original, _ = response()
        for field in ('create','token0','token1','tickLower','tickUpper','adjustedMinPrice','adjustedMaxPrice'):
            data = deepcopy(original); del data[field]
            with self.subTest(field=field), self.assertRaises(DataError):
                self.preview(data)
        for data in ([],{},dict(original,error=KEY),dict(original,code=KEY)):
            with self.assertRaises(DataError):
                self.preview(data)

    def test_gas_missing_zero_and_reported_remain_distinct(self):
        data, _ = response()
        self.assertIsNone(self.preview(data)['gas']['feeWei'])
        for value in ('0','12345678901234567890'):
            data['gasFee'] = value
            self.assertEqual(self.preview(data)['gas']['feeWei'], value)
        data['gasFee'] = -1
        with self.assertRaises(DataError):
            self.preview(data)

    def test_transport_errors_are_redacted_and_not_retried(self):
        for error, expected in ((DataError('http_400'),'uniswap_position_request_rejected'),
            (DataError('http_401'),'uniswap_position_credentials_rejected'),
            (DataError('http_429'),'uniswap_position_rate_limited'),
            (DataError('response_too_large'),'uniswap_position_response_too_large'),
            (DataError('read_deadline_exceeded'),'uniswap_position_deadline_exceeded'),
            (DataError(KEY),'uniswap_position_unavailable'), (RuntimeError(KEY),'uniswap_position_unavailable')):
            transport = Transport(error=error)
            with self.subTest(error=type(error).__name__), self.assertRaisesRegex(DataError, '^'+expected+'$'):
                self.preview(transport=transport)
            self.assertEqual(len(transport.calls), 1)

    def test_clock_validation_and_expiry_from_request_start(self):
        for now in (True, float('nan'), float('inf'), -1, '1000'):
            transport = Transport()
            with self.assertRaisesRegex(DataError, 'invalid_uniswap_position_clock'):
                self.preview(transport=transport, clock=lambda:now)
            self.assertEqual(transport.calls, [])
        for completed in (999, 1030, 2200):
            clock = iter((1000, completed))
            with self.assertRaisesRegex(DataError, '^uniswap_position_expired$'):
                self.preview(clock=lambda:next(clock))
        clock = iter((1000.9,1029.9))
        self.assertEqual(self.preview(clock=lambda:next(clock))['expiresAt'], 1030)

    def test_expired_parent_budget_stops_provider_and_total_deadline_is_enforced(self):
        now = [0]
        transport = Transport()
        with self.assertRaisesRegex(DataError, 'read_deadline_exceeded'):
            with read_deadline(1, clock=lambda:now[0]):
                now[0] = 2
                self.preview(transport=transport)
        self.assertEqual(transport.calls, [])
        def late(url, body, **options):
            now[0] = 20
            return response()[0]
        now[0] = 0
        with self.assertRaisesRegex(DataError, 'read_deadline_exceeded'):
            with read_deadline(15, clock=lambda:now[0]):
                self.preview(transport=late)

    def test_fingerprint_binds_budget_gas_slippage_and_input(self):
        original = self.preview()['requestFingerprint']
        for changes in (dict(budget0_raw='120'), dict(budget1_raw='230'),
            dict(native_balance_raw='2000'), dict(native_gas_reserve_raw='400'), dict(slippage_bps=100),
            dict(amount_raw='101'), dict(independent_token=TOKEN1,amount_raw='200')):
            with self.subTest(changes=changes):
                self.assertNotEqual(self.preview(**changes)['requestFingerprint'], original)

if __name__ == '__main__':
    unittest.main()
