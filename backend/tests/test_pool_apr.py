"""Independent arithmetic, trust-boundary and age cases for the pure candidate."""
from copy import deepcopy
from decimal import Decimal, localcontext
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

from eth_abi import encode
from eth_hash.auto import keccak
from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from pool_apr import LIMITATIONS, PoolAprEstimate, estimate_pool_apr
from read_contract import PoolMarketResponse


FIXTURES = Path(__file__).resolve().parents[2] / 'api-contracts/read-v1/fixtures/producer'
ZERO = '0x' + '0' * 40


def fixture(name='success'):
    return json.loads((FIXTURES / ('pool-market.' + name + '.json')).read_text())


def example():
    result = fixture()
    result['market']['data'].update(reportedLiquidityUsd='10000', volume24hUsd='1000')
    return result


def rekey(response, **changes):
    """Make a different, coherent pool identity without relying on adapter code."""
    key = response['pool']['poolKey']
    key.update(changes)
    pool_id = '0x' + keccak(encode(
        ['address', 'address', 'uint24', 'int24', 'address'],
        [key[field] for field in ('currency0', 'currency1', 'fee_pips', 'tick_spacing', 'hooks')],
    )).hex()
    currencies = [key['currency0'], key['currency1']]
    response['poolId'] = response['pool']['poolId'] = pool_id
    response['pool']['currencies'] = currencies
    for observation in ('market', 'priceHistory'):
        data = response[observation]['data']
        if data:
            data.update(poolId=pool_id, currencies=currencies[:], baseToken=currencies[1],
                        quoteToken=currencies[0])
    return response


def set_snapshot_time(response, timestamp):
    response['snapshot']['timestamp'] = response['pool']['snapshot']['timestamp'] = timestamp


class PoolAprTests(unittest.TestCase):
    def assert_unavailable(self, response, reason, *, now=1010):
        # These cases must pass the current schema: cross-field evidence is the
        # additional responsibility of this adapter, not a coercion side effect.
        PoolMarketResponse.model_validate(response)
        result = estimate_pool_apr(response, now=now)
        self.assertEqual(result['status'], 'unavailable')
        self.assertIsNone(result['feeAprEstimate24hPercent'])
        self.assertIn(reason, result['reasons'])
        return result

    def test_full_current_fixture_and_input_are_preserved(self):
        response = example()
        original = deepcopy(response)
        result = estimate_pool_apr(response, now=1010)
        self.assertEqual(result['status'], 'available')
        self.assertEqual(result['feeAprEstimate24hPercent'], '10.95')
        self.assertEqual(result['reasons'], [])
        self.assertEqual(response, original)
        self.assertIsNone(response['feeApr24h'])
        self.assertIsNone(response['pool']['feeApr24h'])
        self.assertNotIn('feeApr24h', result)
        self.assertEqual(result['source'], 'geckoterminal')
        self.assertEqual(result['scope'], 'pool')
        self.assertFalse(result['providerMetricsReconciled'])
        self.assertFalse(result['suggested'])
        self.assertFalse(result['executionAvailable'])
        self.assertEqual(result['limitations'], list(LIMITATIONS))
        self.assertEqual(json.loads(json.dumps(result)), result)
        PoolAprEstimate.model_validate(result)

    def test_reported_zero_volume_is_real_zero(self):
        result = estimate_pool_apr(fixture(), now=1010)
        self.assertEqual(result['status'], 'available')
        self.assertEqual(result['feeAprEstimate24hPercent'], '0')

    def test_zero_lp_fee_does_not_use_protocol_fee(self):
        response = rekey(example(), fee_pips=0)
        response['pool'].update(currentLpFeePips=0, protocolFeeRaw=0)
        result = estimate_pool_apr(response, now=1010)
        self.assertEqual(result['feeAprEstimate24hPercent'], '0')
        self.assertEqual(result['status'], 'available')

    def test_protocol_fee_directions_cannot_be_estimated_from_aggregate_volume(self):
        for raw in (1, 1000, 1 << 12, 1000 << 12, (1000 << 12) | 1000, (200 << 12) | 500):
            for volume in ('1000', '0'):
                with self.subTest(raw=raw, volume=volume):
                    response = example()
                    response['pool']['protocolFeeRaw'] = raw
                    response['market']['data']['volume24hUsd'] = volume
                    result = self.assert_unavailable(response, 'protocol_fee_unsupported')
                    self.assertEqual(result['inputs']['protocolFeeRaw'], raw)

    def test_invalid_packed_protocol_fees_are_rejected_in_either_direction(self):
        for raw in (1001, 1001 << 12, 0xffffff):
            with self.subTest(raw=raw):
                response = example()
                response['pool']['protocolFeeRaw'] = raw
                self.assert_unavailable(response, 'invalid_protocol_fee')

    def test_rejected_currency_observation_keeps_identity_reason_without_missing_values(self):
        result = self.assert_unavailable(fixture('rejected-currencies'), 'market_identity_mismatch')
        self.assertNotIn('missing_reported_tvl', result['reasons'])
        self.assertNotIn('missing_volume24h', result['reasons'])

    def test_decimal_arithmetic_exceeds_binary_float_precision(self):
        response = example()
        response['market']['data']['volume24hUsd'] = '9007199254740993.125'
        with localcontext() as context:
            context.prec = 100
            expected = str(Decimal('9007199254740993.125') * Decimal('0.01095'))
        result = estimate_pool_apr(response, now=1010)
        self.assertEqual(result['feeAprEstimate24hPercent'], expected)

    def test_recurring_decimal_is_rounded_once_half_up(self):
        response = rekey(example(), fee_pips=1_000_000)
        response['pool']['currentLpFeePips'] = 1_000_000
        response['market']['data'].update(volume24hUsd='1', reportedLiquidityUsd='3')
        result = estimate_pool_apr(response, now=1010)
        self.assertEqual(result['feeAprEstimate24hPercent'], '12166.666666666666666667')
        self.assertEqual(result['precision'], {'decimalPlaces': 18, 'rounding': 'half_up'})

    def test_half_last_digit_and_smaller_nonzero_value(self):
        response = rekey(example(), fee_pips=1)
        response['pool']['currentLpFeePips'] = 1
        response['market']['data'].update(volume24hUsd='1', reportedLiquidityUsd='73000000000000000')
        self.assertEqual(estimate_pool_apr(response, now=1010)['feeAprEstimate24hPercent'],
                         '0.000000000000000001')
        response['market']['data']['volume24hUsd'] = '0.999999999999999999'
        self.assert_unavailable(response, 'estimate_below_display_precision')

    def test_extreme_ratio_is_unavailable_instead_of_capped(self):
        response = example()
        response['market']['data']['reportedLiquidityUsd'] = '0.' + '0' * 95 + '1'
        result = self.assert_unavailable(response, 'estimate_out_of_bounds')
        self.assertEqual(result['inputs']['reportedLiquidityUsd'], '0.' + '0' * 95 + '1')

    def test_missing_or_zero_inputs_are_not_fabricated(self):
        for field, value, reason in (
                ('volume24hUsd', None, 'missing_volume24h'),
                ('reportedLiquidityUsd', None, 'missing_reported_tvl'),
                ('reportedLiquidityUsd', '0', 'zero_reported_tvl'),
                ('reportedLiquidityUsd', '0.000', 'zero_reported_tvl')):
            with self.subTest(field=field, value=value):
                response = example()
                response['market']['data'][field] = value
                self.assert_unavailable(response, reason)

    def test_monetary_values_require_exact_bounded_decimal_strings(self):
        for field in ('volume24hUsd', 'reportedLiquidityUsd'):
            for value in (1, 1.25, True, Decimal('1'), '-1', '+1', '1e3', 'NaN', 'Infinity',
                          ' 1', '1 ', '1\n', '1_000', '1' * 225):
                with self.subTest(field=field, value=value):
                    response = example()
                    response['market']['data'][field] = value
                    with self.assertRaisesRegex(ValueError, '^invalid_pool_market_response$'):
                        estimate_pool_apr(response, now=1010)

    def test_generic_currencies_do_not_depend_on_a_named_token(self):
        response = rekey(example(), currency0='0x' + '2' * 40, currency1='0x' + '9' * 40)
        result = estimate_pool_apr(response, now=1010)
        self.assertEqual(result['status'], 'available')
        self.assertEqual(result['chainId'], 4663)
        self.assertEqual(result['poolId'], response['poolId'])
        self.assertEqual(result['feeAprEstimate24hPercent'], '10.95')

    def test_dynamic_hooked_and_separate_adapter_pools_are_not_estimated(self):
        dynamic = rekey(example(), feeMode='dynamic', fee_pips=8388608)
        dynamic['pool']['integrationClass'] = 'requires_separate_adapter'
        self.assert_unavailable(dynamic, 'dynamic_fee_unsupported')
        hooked = rekey(example(), hooks='0x' + '3' * 40)
        hooked['pool']['integrationClass'] = 'requires_separate_adapter'
        self.assert_unavailable(hooked, 'hooked_pool_unsupported')
        other = example()
        other['pool']['integrationClass'] = 'requires_separate_adapter'
        self.assert_unavailable(other, 'pool_integration_unsupported')

    def test_current_lp_fee_must_match_verified_fixed_pool_key(self):
        response = example()
        response['pool']['currentLpFeePips'] = 10000
        self.assert_unavailable(response, 'fixed_fee_mismatch')

    def test_verified_label_does_not_replace_coherent_pool_identity(self):
        for field in ('pool_id', 'currencies', 'key_hash', 'currency_order'):
            with self.subTest(field=field):
                response = example()
                if field == 'pool_id':
                    response['pool']['poolId'] = '0x' + 'a' * 64
                elif field == 'currencies':
                    response['pool']['currencies'][1] = '0x' + '2' * 40
                elif field == 'key_hash':
                    response['pool']['poolKey']['tick_spacing'] = 10
                else:
                    key = response['pool']['poolKey']
                    rekey(response, currency0=key['currency1'], currency1=key['currency0'])
                self.assert_unavailable(response, 'pool_identity_mismatch')

    def test_provider_pool_and_both_currency_orientations_are_checked(self):
        for field, value in (
                ('poolId', '0x' + 'a' * 64),
                ('currencies', [ZERO, '0x' + '2' * 40]),
                ('baseToken', ZERO), ('quoteToken', '0x' + '2' * 40)):
            with self.subTest(field=field):
                response = example()
                response['market']['data'][field] = value
                self.assert_unavailable(response, 'market_identity_mismatch')

    def test_dex_label_and_existing_rejection_are_respected(self):
        for label in (None, 'uniswap-v3-robinhood', 'other-dex'):
            response = example()
            response['market']['data']['dexLabel'] = label
            self.assert_unavailable(response, 'provider_dex_unconfirmed')
        response = example()
        response['issues'] = ['provider_dex_label_unconfirmed']
        self.assert_unavailable(response, 'provider_dex_unconfirmed')
        response = example()
        response['market']['reason'] = 'provider_currency_or_pool_mismatch'
        self.assert_unavailable(response, 'market_identity_mismatch')

    def test_incoherent_block_number_hash_or_timestamp_is_unavailable(self):
        for field, value in (('number', 701), ('hash', '0x' + 'c' * 64), ('timestamp', 1001)):
            response = example()
            response['pool']['snapshot'][field] = value
            self.assert_unavailable(response, 'snapshot_mismatch')

    def test_uninitialized_or_oversized_sqrt_price_is_unavailable(self):
        for value in ('0', str(2 ** 160)):
            response = example()
            response['pool']['sqrtPriceX96'] = value
            self.assert_unavailable(response, 'pool_state_unavailable')

    def test_cache_age_boundaries_and_original_metadata(self):
        for age, status in ((59, 'available'), (60, 'stale'), (300, 'stale'), (301, 'unavailable')):
            with self.subTest(age=age):
                response = example()
                response['market']['cache']['ageSeconds'] = age
                result = estimate_pool_apr(response, now=1010)
                self.assertEqual(result['status'], status)
                self.assertEqual(result['provenance']['cacheAgeSeconds'], age)
                self.assertEqual(result['provenance']['effectiveMarketAgeSeconds'], age)
                self.assertEqual(result['provenance']['retrievedAt'], 1010)
                self.assertIsNone(result['provenance']['asOfTimestamp'])
                self.assertIsNone(result['provenance']['asOfBlock'])
                self.assertFalse(result['provenance']['providerUpdateTimeKnown'])
                if status == 'unavailable':
                    self.assertIsNone(result['feeAprEstimate24hPercent'])
                    self.assertIn('market_data_expired', result['reasons'])

    def test_wall_clock_age_cannot_be_reset_by_zero_cache_age(self):
        response = example()
        result = estimate_pool_apr(response, now=1070)
        self.assertEqual(result['status'], 'stale')
        self.assertEqual(result['provenance']['cacheAgeSeconds'], 0)
        self.assertEqual(result['provenance']['effectiveMarketAgeSeconds'], 60)
        self.assertEqual(result['provenance']['evaluatedAt'], 1070)

    def test_provider_stale_flag_cannot_be_promoted_to_available(self):
        response = example()
        response['market'].update(status='stale', reason='provider_unavailable')
        result = estimate_pool_apr(response, now=1010)
        self.assertEqual(result['status'], 'stale')
        self.assertEqual(result['reasons'], ['provider_observation_stale'])
        self.assertEqual(result['provenance']['marketReason'], 'provider_unavailable')

    def test_snapshot_age_boundaries_are_separate_from_provider_age(self):
        for age, status in ((120, 'available'), (121, 'stale'), (300, 'stale'), (301, 'unavailable')):
            with self.subTest(age=age):
                response = example()
                set_snapshot_time(response, 1010 - age)
                result = estimate_pool_apr(response, now=1010)
                self.assertEqual(result['status'], status)
                self.assertEqual(result['provenance']['snapshotAgeSeconds'], age)
                self.assertEqual(result['provenance']['effectiveMarketAgeSeconds'], 0)

    def test_future_observations_and_unknown_cache_age_are_unavailable(self):
        response = example()
        response['market']['data']['retrievedAt'] = 1011
        self.assert_unavailable(response, 'market_timestamp_future')
        response = example()
        set_snapshot_time(response, 1011)
        self.assert_unavailable(response, 'snapshot_timestamp_future')
        response = example()
        response['market']['cache']['ageSeconds'] = None
        self.assert_unavailable(response, 'market_age_unknown')

    def test_actual_expired_missing_rejected_and_stale_fixtures(self):
        for name in ('expired', 'missing', 'rejected', 'provider-timeout', 'provider-rate-limited'):
            with self.subTest(name=name):
                result = estimate_pool_apr(fixture(name), now=1010)
                self.assertEqual(result['status'], 'unavailable')
                self.assertIsNone(result['feeAprEstimate24hPercent'])
        stale = estimate_pool_apr(fixture('stale'), now=1010)
        self.assertEqual(stale['status'], 'stale')
        self.assertEqual(stale['feeAprEstimate24hPercent'], '0')

    def test_price_history_is_not_used_to_invent_full_day_coverage(self):
        response = example()
        response['priceHistory'] = {'status': 'not_requested', 'reason': None, 'data': None, 'cache': None}
        result = estimate_pool_apr(response, now=1010)
        self.assertEqual(result['feeAprEstimate24hPercent'], '10.95')
        self.assertIn('no_full_day_coverage_proof', result['limitations'])

    def test_invalid_clock_and_wire_contract_are_rejected_without_echoing_input(self):
        for now in (True, -1, 1010.0, '1010', 2 ** 53, None):
            with self.subTest(now=now):
                with self.assertRaisesRegex(ValueError, '^invalid_estimate_clock$'):
                    estimate_pool_apr(example(), now=now)
        for changed in ('chainId', 'source', 'new_field', 'true_flag'):
            response = example()
            if changed == 'chainId':
                response['chainId'] = 1
            elif changed == 'source':
                response['market']['data']['source'] = 'uniswap'
            elif changed == 'new_field':
                response['unreviewedField'] = 'untrusted-text'
            else:
                response['providerMetricsReconciled'] = 0
            with self.assertRaisesRegex(ValueError, '^invalid_pool_market_response$'):
                estimate_pool_apr(response, now=1010)

    def test_candidate_model_rejects_float_coercion_flags_extra_keys_and_bad_states(self):
        valid = estimate_pool_apr(example(), now=1010)
        for field, value in (('feeAprEstimate24hPercent', 10.95), ('suggested', 0),
                             ('executionAvailable', True), ('unreviewedField', 1),
                             ('status', 'unavailable'), ('limitations', [])):
            with self.subTest(field=field):
                result = deepcopy(valid)
                result[field] = value
                with self.assertRaises(ValidationError):
                    PoolAprEstimate.model_validate(result)

    def test_evaluation_has_no_network_process_or_file_access(self):
        response = example()
        with patch('socket.socket', side_effect=AssertionError('network forbidden')), \
                patch('subprocess.Popen', side_effect=AssertionError('process forbidden')), \
                patch('builtins.open', side_effect=AssertionError('file access forbidden')):
            self.assertEqual(estimate_pool_apr(response, now=1010)['status'], 'available')


if __name__ == '__main__':
    unittest.main()
