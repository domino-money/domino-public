import copy
from pathlib import Path
import sys
import unittest

from pydantic import ValidationError

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from managed_performance import DAY, PerformanceEvidence, calculate_performance, validate_performance_evidence


TOKEN = '0x' + '11' * 20
STABLE = '0x' + '22' * 20


def amount(raw='10', *, currency=TOKEN, decimals=0, price='1', at=0, until=DAY):
    return {'currency': currency, 'decimals': decimals, 'raw': raw,
            'price': {'sourceId': 'synthetic-qualified-price', 'status': 'qualified',
                      'timestamp': at, 'validUntil': until, 'usdPerToken': price}}


def segment(start=0, end=DAY, values=None):
    return {'startsAt': start, 'endsAt': end, 'valuationStatus': 'qualified',
            'components': [{'tokenId': key, 'valueUsd': value}
                           for key, value in (values or {'1': '1000', None: '0'}).items()]}


def credit(event='fee-1', *, token='1', at=DAY, kind='new_trading_fee', origin=None, raw='10'):
    return {'eventId': event, 'feeOriginId': origin or event, 'epochId': 'synthetic-epoch',
            'tokenId': token, 'timestamp': at, 'kind': kind, 'amount': amount(raw)}


def debit(event='charge-1', *, raw='0.2', at=DAY, kind='service_fee', payer='strategy'):
    # Keep test amounts in genuine integer token base units.
    from decimal import Decimal
    return {'eventId': event, 'epochId': 'synthetic-epoch', 'tokenId': '1', 'timestamp': at,
            'kind': kind, 'payer': payer,
            'amount': amount(str(int(Decimal(raw) * 100)), decimals=2, currency=STABLE)}


def evidence(*, end=DAY):
    value = {'chainId': 4663, 'epochId': 'synthetic-epoch', 'scope': 'nft',
             'owner': '0x' + '33' * 20, 'positionManager': '0x' + '44' * 20,
             'startedAt': 0,
             'snapshot': {'blockNumber': 90000, 'blockHash': '0x' + '55' * 32,
                          'timestamp': end, 'canonicality': 'verified'},
             'coverageStart': 0, 'incomeCoverage': 'complete',
             'capitalScope': 'all_position_assets_and_epoch_residual_once',
             'members': [{'tokenId': '1', 'startsAt': 0, 'endsAt': None}],
             'capital': [segment(end=end)], 'credits': [credit(at=end)],
             'debits': [debit(at=end)]}
    return value


def calc(value):
    return calculate_performance(value, now=value['snapshot']['timestamp'])


class ManagedPerformanceTests(unittest.TestCase):
    def test_private_high_precision_inputs_do_not_round_before_apr(self):
        from fractions import Fraction
        from performance_valuation import exact_decimal
        value = evidence()
        price = Fraction(1, 10**36)
        tiny = price / 10**255
        value['capital'] = [segment(values={'1': exact_decimal(tiny), None: '0'})]
        value['credits'] = [credit(raw='1')]
        value['credits'][0]['amount'] = amount('1', decimals=255, price=exact_decimal(price))
        value['debits'] = []
        result = calc(value)
        self.assertEqual(result['status'], 'available')
        self.assertEqual(result['grossFeeAprPercent'], '36500.000000000000000000')
        self.assertEqual(result['newTradingFeesUsd'], '0.000000000000000000')
        # The zero above is display truncation only; the exact integral is nonzero.
        self.assertEqual(result['decimalPlaces'], 18)

    def test_private_precision_input_budget_still_rejects_oversized_numbers(self):
        for number in ('0.'+'1'*401, '1'*513):
            value = evidence()
            value['capital'][0]['components'][0]['valueUsd'] = number
            with self.assertRaises(ValidationError):
                calc(value)

    def test_post_opening_block_fees_in_same_second_are_included(self):
        value = evidence()
        value['openingBlockNumber'] = 100
        value['credits'] = [credit(at=0)]
        value['debits'] = [debit(at=0)]
        for row in value['credits']+value['debits']:
            row['blockNumber'] = 101
        result = calc(value)
        self.assertEqual(result['newTradingFeesUsd'], '10.000000000000000000')
        self.assertEqual(result['actualServiceFeesUsd'], '0.200000000000000000')
        for block in (None,100,90001):
            invalid = copy.deepcopy(value)
            invalid['credits'][0]['blockNumber'] = block
            with self.assertRaisesRegex(ValueError,'event_outside_epoch_blocks'):
                calc(invalid)

    def test_block_anchor_does_not_include_rolling_window_cutoff(self):
        value = evidence(end=DAY+10)
        value['openingBlockNumber'] = 100
        value['credits'] = [credit(at=10)]
        value['debits'] = [debit(at=10)]
        for row in value['credits']+value['debits']:
            row['blockNumber'] = 101
        self.assertEqual(calc(value)['newTradingFeesUsd'], '0.000000000000000000')
        self.assertEqual(calc(value)['actualServiceFeesUsd'], '0.000000000000000000')

    def test_missing_decimals_is_unknown_not_an_assumed_denomination(self):
        value = evidence()
        item = value['credits'][0]['amount']
        item['decimals'] = None
        with self.assertRaisesRegex(ValueError,'qualified_price_requires_decimals'):
            calc(value)
        item['price'].update(status='unavailable',usdPerToken=None)
        self.assertIsNone(calc(value)['newTradingFeesUsd'])
        self.assertIsNone(calc(value)['grossFeeAprPercent'])

    def test_full_day_hand_calculated_gross_and_net_apr(self):
        result = calc(evidence())
        self.assertEqual(result['status'], 'available')
        self.assertEqual(result['newTradingFeesUsd'], '10.000000000000000000')
        self.assertEqual(result['netFeeIncomeUsd'], '9.800000000000000000')
        self.assertEqual(result['timeWeightedCapitalUsd'], '1000.000000000000000000')
        self.assertEqual(result['grossFeeAprPercent'], '365.000000000000000000')
        self.assertEqual(result['netFeeAprPercent'], '357.700000000000000000')
        self.assertTrue(result['complete24h'])
        self.assertFalse(result['isApy'])
        self.assertFalse(result['includesTokenPricePnl'])
        self.assertFalse(result['liveCollectorImplemented'])
        self.assertFalse(result['executionAvailable'])
        self.assertEqual(result['decimalPlaces'], 18)
        self.assertEqual(result['roundingMode'], 'towards_zero')

    def test_midday_deposit_or_compound_changes_time_weighted_capital(self):
        value = evidence()
        value['capital'] = [segment(end=DAY // 2),
                            segment(DAY // 2, values={'1': '3000', None: '0'})]
        result = calc(value)
        self.assertEqual(result['timeWeightedCapitalUsd'], '2000.000000000000000000')
        self.assertEqual(result['netFeeAprPercent'], '178.850000000000000000')
        self.assertEqual(result['newTradingFeesUsd'], '10.000000000000000000')

    def test_price_only_appreciation_is_not_fee_income(self):
        value = evidence()
        value['credits'] = []
        value['debits'] = []
        value['capital'] = [segment(end=DAY // 2),
                            segment(DAY // 2, values={'1': '3000', None: '0'})]
        result = calc(value)
        self.assertEqual(result['newTradingFeesUsd'], '0.000000000000000000')
        self.assertEqual(result['grossFeeAprPercent'], '0.000000000000000000')

    def test_old_fees_donation_and_compound_are_excluded(self):
        value = evidence()
        value['credits'].extend([
            credit('opening', at=0, kind='opening_fee', raw='100'),
            credit('donate', kind='donation', raw='200'),
            credit('reinvest', kind='internal_transfer', origin='fee-1', raw='10')])
        result = calc(value)
        self.assertEqual(result['newTradingFeesUsd'], '10.000000000000000000')

    def test_child_receives_parent_fees_once_and_can_earn_new_fees(self):
        value = evidence()
        value['scope'] = 'sequence'
        value['members'].append({'tokenId': '2', 'startsAt': DAY // 2, 'endsAt': None})
        value['capital'] = [segment(end=DAY // 2), segment(DAY // 2, values={
            '1': '900', '2': '80', None: '20'})]
        value['credits'] = [credit(at=DAY // 2),
                            credit('redirect', token='2', kind='internal_transfer', origin='fee-1'),
                            credit('child-income', token='2', raw='5')]
        result = calc(value)
        self.assertEqual(result['newTradingFeesUsd'], '15.000000000000000000')
        self.assertEqual(result['timeWeightedCapitalUsd'], '1000.000000000000000000')

    def test_duplicated_origin_in_child_rejected_even_with_a_different_event_id(self):
        value = evidence()
        value['credits'].append(credit('different-event', origin='fee-1'))
        with self.assertRaisesRegex(ValueError, 'duplicate_fee_origin'):
            calc(value)

    def test_primary_origin_cannot_be_duplicated_or_reclassified_in_either_order(self):
        kinds = ('opening_fee', 'donation', 'new_trading_fee')
        for first_kind in kinds:
            for second_kind in kinds:
                value = evidence()
                value['debits'] = []
                value['credits'] = [
                    credit('original', at=0 if first_kind == 'opening_fee' else DAY,
                           kind=first_kind, origin='existing-credit', raw='100'),
                    credit('relabelled', at=0 if second_kind == 'opening_fee' else DAY,
                           kind=second_kind, origin='existing-credit', raw='100')]
                with self.subTest(first=first_kind, second=second_kind), self.assertRaisesRegex(
                        ValueError, 'duplicate_fee_origin'):
                    calc(value)

    def test_distinct_currency_lot_and_internal_transfer_preserve_primary_classification(self):
        value = evidence()
        value['debits'] = []
        opening = credit('opening', at=0, kind='opening_fee', origin='shared-origin', raw='100')
        moved = credit('moved', kind='internal_transfer', origin='shared-origin', raw='100')
        income = credit('income', origin='shared-origin', raw='10')
        income['amount']['currency'] = STABLE
        value['credits'] = [moved, income, opening]
        self.assertEqual(calc(value)['newTradingFeesUsd'], '10.000000000000000000')

    def test_same_fee_origin_can_contain_both_currencies(self):
        value = evidence()
        value['debits'] = []
        other = credit('other-token', origin='fee-1')
        other['amount']['currency'] = STABLE
        value['credits'].append(other)
        self.assertEqual(calc(value)['newTradingFeesUsd'], '20.000000000000000000')

    def test_missing_or_duplicate_residual_or_member_component_rejected(self):
        for modification in ('missing_residual', 'missing_member', 'duplicate', 'unknown_member'):
            value = evidence()
            components = value['capital'][0]['components']
            if modification == 'missing_residual':
                components.pop()
            elif modification == 'missing_member':
                components.pop(0)
            elif modification == 'duplicate':
                components.append(copy.deepcopy(components[0]))
            else:
                components[0]['tokenId'] = '99'
            with self.subTest(modification=modification), self.assertRaisesRegex(
                    ValueError, 'capital_component_set_mismatch'):
                calc(value)

    def test_actual_charge_only_and_operator_gas_not_deducted_again(self):
        value = evidence()
        value['debits'] = [debit(raw='0.1'), debit('gas', raw='0.09', kind='network_gas', payer='operator')]
        result = calc(value)
        self.assertEqual(result['actualServiceFeesUsd'], '0.100000000000000000')
        self.assertEqual(result['operatorCostsUsd'], '0.090000000000000000')
        self.assertEqual(result['netFeeIncomeUsd'], '9.900000000000000000')
        value['debits'] = []
        self.assertEqual(calc(value)['netFeeIncomeUsd'], '10.000000000000000000')

    def test_missing_operator_gas_price_does_not_hide_owner_performance(self):
        value = evidence()
        gas = debit('gas', raw='0.09', kind='network_gas', payer='operator')
        gas['amount']['price']['status'] = 'unavailable'
        gas['amount']['price']['usdPerToken'] = None
        value['debits'].append(gas)
        result = calc(value)
        self.assertEqual(result['status'], 'available')
        self.assertEqual(result['netFeeIncomeUsd'], '9.800000000000000000')
        self.assertIsNone(result['operatorCostsUsd'])

    def test_net_fees_can_be_negative_when_actual_charges_use_older_fees(self):
        value = evidence()
        value['debits'] = [debit(raw='11')]
        result = calc(value)
        self.assertEqual(result['netFeeIncomeUsd'], '-1.000000000000000000')
        self.assertEqual(result['netFeeAprPercent'], '-36.500000000000000000')

    def test_strategy_dex_cost_once_is_deducted(self):
        value = evidence()
        value['debits'].append(debit('swap', raw='0.3', kind='dex_fee'))
        result = calc(value)
        self.assertEqual(result['otherStrategyCostsUsd'], '0.300000000000000000')
        self.assertEqual(result['netFeeIncomeUsd'], '9.500000000000000000')

    def test_twenty_three_hours_retains_actual_income_without_annualizing(self):
        result = calc(evidence(end=23 * 3600))
        self.assertEqual(result['status'], 'measuring')
        self.assertEqual(result['netFeeIncomeUsd'], '9.800000000000000000')
        self.assertEqual(result['observedSeconds'], 23 * 3600)
        self.assertFalse(result['complete24h'])
        self.assertIsNone(result['grossFeeAprPercent'])
        self.assertIsNone(result['netFeeAprPercent'])

    def test_window_rolls_forward_and_does_not_recount_prior_day_fees(self):
        value = evidence(end=2 * DAY)
        value['credits'] = [credit(at=DAY), credit('new-day', at=2 * DAY, raw='2')]
        value['credits'][1]['amount']['price']['validUntil'] = 2 * DAY
        value['debits'] = []
        result = calc(value)
        self.assertEqual(result['windowStart'], DAY)
        self.assertEqual(result['newTradingFeesUsd'], '2.000000000000000000')

    def test_missing_capital_interval_keeps_known_fees_but_no_apr(self):
        value = evidence()
        value['capital'][0]['startsAt'] = 1
        result = calc(value)
        self.assertEqual(result['status'], 'partial')
        self.assertEqual(result['newTradingFeesUsd'], '10.000000000000000000')
        self.assertIsNone(result['timeWeightedCapitalUsd'])
        self.assertIsNone(result['netFeeAprPercent'])

    def test_missing_income_is_not_assumed_zero(self):
        for state in ('partial', 'unavailable'):
            value = evidence()
            value['credits'] = []
            value['incomeCoverage'] = state
            result = calc(value)
            self.assertEqual(result['status'], 'partial')
            self.assertIsNone(result['newTradingFeesUsd'])
            self.assertIsNone(result['netFeeIncomeUsd'])
            self.assertIsNone(result['grossFeeAprPercent'])

    def test_coverage_start_after_window_start_prevents_full_day_apr(self):
        value = evidence()
        value['coverageStart'] = 1
        result = calc(value)
        self.assertFalse(result['complete24h'])
        self.assertIsNone(result['newTradingFeesUsd'])

    def test_stale_preserves_dated_amounts_with_no_current_apr(self):
        value = evidence()
        result = calculate_performance(value, now=DAY + 121)
        self.assertEqual(result['status'], 'stale')
        self.assertIn('snapshot_stale', result['issues'])
        self.assertEqual(result['newTradingFeesUsd'], '10.000000000000000000')
        self.assertIsNone(result['grossFeeAprPercent'])
        self.assertEqual(calculate_performance(value, now=DAY + 120)['status'], 'available')

    def test_reorg_or_unverified_canonicality_blocks_all_usd_metrics(self):
        for canonicality in ('reorged', 'unverified'):
            value = evidence()
            value['snapshot']['canonicality'] = canonicality
            result = calc(value)
            self.assertEqual(result['status'], 'unavailable')
            for key in ('newTradingFeesUsd', 'actualServiceFeesUsd', 'netFeeIncomeUsd',
                        'timeWeightedCapitalUsd', 'netFeeAprPercent', 'operatorCostsUsd'):
                self.assertIsNone(result[key])

    def test_unqualified_noncausal_expired_or_missing_fee_price_blocks_apr(self):
        for change in ({'status': 'unqualified'}, {'timestamp': DAY + 1, 'validUntil': DAY + 2},
                       {'validUntil': DAY - 1}, {'usdPerToken': None}):
            value = evidence()
            value['credits'][0]['amount']['price'].update(change)
            result = calc(value)
            self.assertEqual(result['status'], 'partial')
            self.assertIsNone(result['newTradingFeesUsd'])
            self.assertIsNone(result['grossFeeAprPercent'])

    def test_zero_denominator_unavailable_and_zero_income_known(self):
        value = evidence()
        value['capital'] = [segment(values={'1': '0', None: '0'})]
        value['credits'] = []
        value['debits'] = []
        result = calc(value)
        self.assertEqual(result['status'], 'unavailable')
        self.assertEqual(result['newTradingFeesUsd'], '0.000000000000000000')
        self.assertIsNone(result['grossFeeAprPercent'])

    def test_raw_quantity_and_event_price_preserve_precision(self):
        value = evidence()
        value['debits'] = []
        value['credits'][0]['amount'] = amount('123456789012345678901', decimals=18, price='2')
        self.assertEqual(calc(value)['newTradingFeesUsd'], '246.913578024691357802')

    def test_decimal_metadata_conflict_and_cross_epoch_events_rejected(self):
        value = evidence()
        value['credits'].append(credit('second'))
        value['credits'][1]['amount']['decimals'] = 1
        with self.assertRaisesRegex(ValueError, 'currency_decimals_mismatch'):
            calc(value)
        value = evidence()
        value['credits'][0]['epochId'] = 'other-epoch'
        with self.assertRaisesRegex(ValueError, 'cross_epoch_event'):
            calc(value)

    def test_invalid_event_and_capital_member_boundaries_rejected(self):
        value = evidence()
        value['credits'][0]['tokenId'] = '99'
        with self.assertRaisesRegex(ValueError, 'event_outside_member_lifetime'):
            calc(value)
        value = evidence()
        value['members'][0]['endsAt'] = DAY // 2
        with self.assertRaisesRegex(ValueError, 'event_outside_member_lifetime'):
            calc(value)
        value['credits'] = []
        value['debits'] = []
        with self.assertRaisesRegex(ValueError, 'capital_crosses_member_boundary'):
            calc(value)

    def test_final_fee_and_cost_at_exit_second_count_but_later_owner_does_not(self):
        value = evidence()
        value['members'][0]['endsAt'] = DAY // 2
        value['credits'][0]['timestamp'] = DAY // 2
        value['debits'][0]['timestamp'] = DAY // 2
        value['capital'] = [segment(end=DAY // 2), segment(DAY // 2, values={None: '1000'})]
        result = calc(value)
        self.assertEqual(result['newTradingFeesUsd'], '10.000000000000000000')
        self.assertEqual(result['netFeeIncomeUsd'], '9.800000000000000000')
        self.assertEqual(result['timeWeightedCapitalUsd'], '1000.000000000000000000')
        value['credits'].append(credit('next-owner', at=DAY // 2 + 1))
        with self.assertRaisesRegex(ValueError, 'event_outside_member_lifetime'):
            calc(value)

    def test_duplicate_events_and_overlapping_capital_rejected(self):
        value = evidence()
        value['debits'][0]['eventId'] = 'fee-1'
        with self.assertRaisesRegex(ValueError, 'duplicate_event'):
            calc(value)
        value = evidence()
        value['capital'].append(copy.deepcopy(value['capital'][0]))
        with self.assertRaisesRegex(ValueError, 'overlapping_or_invalid_capital_segment'):
            calc(value)

    def test_input_shape_and_numeric_bounds_are_strict(self):
        for field, invalid in (('raw', '-1'), ('raw', '1.2'), ('raw', str(2**256)),
                               ('raw', '01'), ('raw', 10), ('raw', True), ('decimals', True),
                               ('decimals', 256)):
            value = evidence()
            value['credits'][0]['amount'][field] = invalid
            with self.subTest(field=field, invalid=invalid), self.assertRaises(ValueError):
                calc(value)
        for price in ('NaN', 'Infinity', '-1', '0', 1.0):
            value = evidence()
            value['credits'][0]['amount']['price']['usdPerToken'] = price
            with self.subTest(price=price), self.assertRaises(ValueError):
                calc(value)
        value = evidence()
        value['unknown'] = True
        with self.assertRaises(ValidationError):
            calc(value)
        with self.assertRaisesRegex(ValueError, 'invalid_calculation_time'):
            calculate_performance(evidence(), now=True)

    def test_model_input_is_revalidated_and_caller_input_not_mutated(self):
        value = evidence()
        before = copy.deepcopy(value)
        expected = calc(value)
        self.assertEqual(value, before)
        self.assertEqual(validate_performance_evidence(value, now=DAY).model_dump(exclude_unset=True), value)
        model = PerformanceEvidence.model_validate(value)
        self.assertEqual(calculate_performance(model, now=DAY), expected)
        model.credits[0].amount.raw = '-1'
        with self.assertRaises(ValidationError):
            calculate_performance(model, now=DAY)


if __name__ == '__main__':
    unittest.main()
