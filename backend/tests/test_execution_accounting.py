import copy
from fractions import Fraction
from pathlib import Path
import random
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from execution_accounting import (
    Allocation, FeeLot, UINT128_MAX, consume_allocations, reconcile_consumption, split_swap_output,
)


ZERO = '0x' + '00' * 20
TOKEN = '0x' + '22' * 20
OTHER = '0x' + '33' * 20


def ident(number):
    return '0x' + f'{number:064x}'


def lot(number=1, amount=1000, *, source=1, currency=ZERO, charged=False, reserved=0):
    return {'lotId': ident(number), 'sourceId': ident(source), 'currency': currency,
            'chargeStatus': 'converted_charged' if charged else 'original_uncharged',
            'amountRaw': str(amount), 'reservedRaw': str(reserved)}


def allocation(number=1, amount=1000):
    return {'lotId': ident(number), 'amountRaw': str(amount)}


def disposition(source=1, *, currency=ZERO, direct=0, swapped=0):
    return {'sourceId': ident(source), 'currency': currency,
            'liquidityFromInputRaw': str(direct), 'liquidityFromSwapRaw': str(swapped)}


def swap(number=1, *, inputs=None, amount_out=580, currency_in=ZERO, currency_out=TOKEN):
    return {'swapId': ident(number), 'currencyIn': currency_in, 'currencyOut': currency_out,
            'amountOutRaw': str(amount_out), 'inputs': inputs or [swap_input(1, 292)]}


def swap_input(source, amount):
    return {'sourceId': ident(source), 'amountInRaw': str(amount)}


def row_for(result, source=1, currency=ZERO):
    return next(row for row in result['balances']
                if row['sourceId'] == ident(source) and row['currency'] == currency)


class ExecutionAccountingTests(unittest.TestCase):
    def assert_conservation(self, original_lots, result):
        # Independent balance-matrix oracle: derive before balances from fixture
        # lots, then compare actual-effect debit/credit columns in raw units.
        before = {}
        for item in original_lots:
            key = (item['sourceId'], item['currency'])
            before[key] = before.get(key, 0) + int(item['amountRaw'])
        balance_keys = [(row['sourceId'], row['currency']) for row in result['balances']]
        self.assertEqual(len(balance_keys), len(set(balance_keys)))
        self.assertTrue(set(before).issubset(balance_keys))
        by_currency = {}
        for row in result['balances']:
            key = (row['sourceId'], row['currency'])
            inflow = before.get(key, 0) + int(row['swapOutRaw'])
            outflow = sum(int(row[field]) for field in (
                'serviceFeeRaw', 'liquidityAddedRaw', 'swapInRaw', 'originalAfterRaw', 'chargedAfterRaw'))
            self.assertEqual(inflow, outflow, key)
            currency = row['currency']
            left, right = by_currency.get(currency, (0, 0))
            by_currency[currency] = (left + inflow, right + outflow)
        self.assertTrue(all(left == right for left, right in by_currency.values()))

    def test_direct_consumed_fees_and_later_remaining_lot(self):
        lots = [lot(amount=1000), lot(2, 300)]
        result = reconcile_consumption(lots, [allocation()], [disposition(direct=980)], service_fee_bps=200)
        row = row_for(result)
        self.assertEqual((row['originalBeforeRaw'], row['serviceFeeRaw'], row['liquidityAddedRaw'],
                          row['originalAfterRaw']), ('1300', '20', '980', '300'))
        self.assert_conservation(lots, result)
        next_result = reconcile_consumption(result['remainingLots'], [allocation(2, 300)],
            [disposition(direct=294)], service_fee_bps=200)
        next_row = row_for(next_result)
        self.assertEqual((next_row['serviceFeeRaw'], next_row['liquidityAddedRaw'],
                          next_row['originalAfterRaw']), ('6', '294', '0'))
        self.assert_conservation(result['remainingLots'], next_result)

    def test_same_source_credit_parts_aggregate_before_floor(self):
        result = consume_allocations([lot(1, 49), lot(2, 49)],
            [allocation(1, 49), allocation(2, 49)], service_fee_bps=200)
        self.assertEqual(len(result['groups']), 1)
        self.assertEqual(result['groups'][0]['grossOriginalRaw'], '98')
        self.assertEqual(result['groups'][0]['serviceFeeRaw'], '1')
        self.assertEqual(result['groups'][0]['netAvailableRaw'], '97')

    def test_distinct_sources_and_distinct_actions_preserve_floor_policy(self):
        result = consume_allocations([lot(1, 49), lot(2, 49, source=2)],
            [allocation(1, 49), allocation(2, 49)], service_fee_bps=200)
        self.assertEqual([item['serviceFeeRaw'] for item in result['groups']], ['0', '0'])
        first = consume_allocations([lot(1, 98)], [allocation(1, 49)], service_fee_bps=200)
        second = consume_allocations(first['remainingLots'], [allocation(1, 49)], service_fee_bps=200)
        self.assertEqual((first['groups'][0]['serviceFeeRaw'], second['groups'][0]['serviceFeeRaw']), ('0', '0'))

    def test_forty_nine_fifty_zero_rate_and_uint128_max(self):
        for used, bps, fee, net in ((49, 200, 0, 49), (50, 200, 1, 49),
                                    (UINT128_MAX, 0, 0, UINT128_MAX)):
            result = consume_allocations([lot(amount=UINT128_MAX)], [allocation(amount=used)], service_fee_bps=bps)
            row = result['groups'][0]
            self.assertEqual((row['serviceFeeRaw'], row['netAvailableRaw']), (str(fee), str(net)))

    def test_mixed_charged_and_original_same_currency(self):
        lots = [lot(1, 100), lot(2, 40, charged=True)]
        result = reconcile_consumption(lots, [allocation(1, 100), allocation(2, 40)],
            [disposition(direct=138)], service_fee_bps=200)
        row = row_for(result)
        self.assertEqual((row['grossOriginalRaw'], row['chargedInputRaw'], row['serviceFeeRaw'],
                          row['liquidityAddedRaw']), ('100', '40', '2', '138'))
        self.assert_conservation(lots, result)

    def test_swap_and_direct_keep_uncharged_original_and_charged_output_residual(self):
        lots = [lot(amount=1000)]
        result = reconcile_consumption(lots, [allocation(amount=400)],
            [disposition(direct=100), disposition(currency=TOKEN, swapped=500)],
            service_fee_bps=200, swaps=[swap()])
        original, output = row_for(result), row_for(result, currency=TOKEN)
        self.assertEqual((original['serviceFeeRaw'], original['liquidityAddedRaw'],
                          original['swapInRaw'], original['originalAfterRaw']), ('8', '100', '292', '600'))
        self.assertEqual((output['swapOutRaw'], output['liquidityAddedRaw'], output['chargedAfterRaw']),
                         ('580', '500', '80'))
        self.assertEqual(result['convertedResiduals'], [{'sourceId': ident(1), 'currency': TOKEN,
            'amountRaw': '80', 'chargeStatus': 'converted_charged'}])
        self.assert_conservation(lots, result)
        next_lots = result['remainingLots'] + [lot(3, 80, currency=TOKEN, charged=True)]
        later = reconcile_consumption(next_lots, [allocation(amount=50), allocation(3, 80)],
            [disposition(direct=49), disposition(currency=TOKEN, direct=80)], service_fee_bps=200)
        self.assertEqual(row_for(later)['serviceFeeRaw'], '1')
        self.assertEqual(row_for(later)['originalAfterRaw'], '550')
        self.assertEqual(row_for(later, currency=TOKEN)['serviceFeeRaw'], '0')
        self.assertEqual(row_for(later, currency=TOKEN)['liquidityAddedRaw'], '80')
        self.assert_conservation(next_lots, later)

    def test_mixed_source_conversion_golden_output_and_canonical_order(self):
        lots = [lot(1, 101), lot(2, 203, source=2)]
        inputs = [swap_input(2, 199), swap_input(1, 99)]
        allocations = [allocation(2, 203), allocation(1, 101)]
        dispositions = [disposition(2), disposition(1), disposition(2, currency=TOKEN, swapped=600),
                        disposition(1, currency=TOKEN, swapped=300)]
        receipt = swap(inputs=inputs, amount_out=997)
        result = reconcile_consumption(lots, allocations, dispositions, service_fee_bps=200, swaps=[receipt])
        self.assertEqual([(row['amountOutRaw'], row['chargeStatus']) for row in result['swaps'][0]['outputs']],
                         [('331', 'converted_charged'), ('666', 'converted_charged')])
        self.assertEqual(row_for(result)['serviceFeeRaw'], '2')
        self.assertEqual(row_for(result, 2)['serviceFeeRaw'], '4')
        self.assertEqual(row_for(result, currency=TOKEN)['chargedAfterRaw'], '31')
        self.assertEqual(row_for(result, 2, TOKEN)['chargedAfterRaw'], '66')
        self.assert_conservation(lots, result)
        receipt['inputs'].reverse()
        reordered = reconcile_consumption(lots[::-1], allocations[::-1], dispositions[::-1],
            service_fee_bps=200, swaps=[receipt])
        self.assertEqual(result, reordered)

    def test_output_remainder_goes_to_canonical_prefix_difference(self):
        inputs = [swap_input(2, 1), swap_input(1, 1)]
        self.assertEqual([row['amountOutRaw'] for row in split_swap_output(inputs, '3')], ['1', '2'])
        self.assertEqual([row['amountOutRaw'] for row in split_swap_output(inputs, '1')], ['0', '1'])

    def test_zero_rounded_charge_output_retains_evaluated_status(self):
        result = reconcile_consumption([lot(1, 49)], [allocation(1, 49)],
            [disposition(), disposition(currency=TOKEN)], service_fee_bps=200,
            swaps=[swap(inputs=[swap_input(1, 49)], amount_out=1000)])
        self.assertEqual(row_for(result)['serviceFeeRaw'], '0')
        self.assertEqual(result['convertedResiduals'][0]['chargeStatus'], 'converted_charged')
        later = consume_allocations([lot(2, 1000, currency=TOKEN, charged=True)],
            [allocation(2, 1000)], service_fee_bps=200)
        self.assertEqual(later['groups'][0]['serviceFeeRaw'], '0')

    def test_reservations_stay_untouched_and_wait_is_empty_consumption(self):
        lots = [lot(amount=100, reserved=40)]
        result = consume_allocations(lots, [allocation(amount=60)], service_fee_bps=200)
        self.assertEqual((result['remainingLots'][0]['amountRaw'], result['remainingLots'][0]['reservedRaw']), ('40', '40'))
        waiting = consume_allocations(lots, [], service_fee_bps=200)
        self.assertEqual(waiting['groups'], [])
        self.assertEqual(waiting['remainingLots'], lots)
        with self.assertRaisesRegex(ValueError, 'allocation_exceeds_available'):
            consume_allocations(lots, [allocation(amount=61)], service_fee_bps=200)

    def test_unselected_sources_currencies_and_wait_remain_in_complete_receipt(self):
        lots = [lot(amount=100), lot(2, 300, currency=TOKEN), lot(3, 77, source=2, charged=True)]
        waiting = reconcile_consumption(lots, [], [], service_fee_bps=200)
        self.assertEqual(len(waiting['balances']), 3)
        self.assertEqual(waiting['groups'], [])
        self.assertEqual(waiting['remainingLots'], lots)
        self.assert_conservation(lots, waiting)
        result = reconcile_consumption(lots, [allocation(amount=100)],
            [disposition(direct=98)], service_fee_bps=200)
        self.assertEqual(row_for(result, currency=TOKEN)['originalAfterRaw'], '300')
        self.assertEqual(row_for(result, 2)['chargedAfterRaw'], '77')
        self.assert_conservation(lots, result)

    def test_unknown_duplicate_lots_and_duplicate_allocations_rejected(self):
        bad = [([lot(), lot()], [allocation()], 'duplicate_lot'),
               ([lot()], [allocation(1, 100), allocation(1, 100)], 'duplicate_allocation'),
               ([lot()], [allocation(2, 1)], 'unknown_lot')]
        for lots, allocations, reason in bad:
            with self.subTest(reason=reason), self.assertRaisesRegex(ValueError, reason):
                consume_allocations(lots, allocations, service_fee_bps=200)

    def test_aggregate_same_source_currency_overflow_rejected_even_unselected(self):
        with self.assertRaisesRegex(ValueError, 'aggregate_uint128_overflow'):
            consume_allocations([lot(1, UINT128_MAX), lot(2, 1, charged=True)], [], service_fee_bps=200)
        # Neither different currencies nor unrelated sources are summed as one reserve.
        consume_allocations([lot(1, UINT128_MAX), lot(2, 1, currency=TOKEN)], [], service_fee_bps=200)
        consume_allocations([lot(1, UINT128_MAX), lot(2, 1, source=2)], [], service_fee_bps=200)

    def test_final_charged_reserve_and_liquidity_addition_overflow_rejected(self):
        with self.assertRaisesRegex(ValueError, 'aggregate_uint128_overflow'):
            reconcile_consumption([lot(1, 50), lot(2, 1, currency=TOKEN, charged=True)],
                [allocation(1, 50)], [disposition(), disposition(currency=TOKEN)],
                service_fee_bps=200, swaps=[swap(inputs=[swap_input(1, 49)], amount_out=UINT128_MAX)])
        with self.assertRaisesRegex(ValueError, 'aggregate_uint128_overflow'):
            reconcile_consumption([lot(1, 50), lot(2, UINT128_MAX, currency=TOKEN, charged=True)],
                [allocation(1, 50), allocation(2, UINT128_MAX)],
                [disposition(), disposition(currency=TOKEN, direct=UINT128_MAX, swapped=1)],
                service_fee_bps=200, swaps=[swap(inputs=[swap_input(1, 49)], amount_out=1)])

    def test_duplicate_swap_source_receipt_and_equal_currencies_rejected(self):
        with self.assertRaisesRegex(ValueError, 'duplicate_swap_source'):
            split_swap_output([swap_input(1, 1), swap_input(1, 2)], '4')
        for receipts, reason in (([swap(), swap()], 'duplicate_swap_receipt'),
                                 ([swap(currency_out=ZERO)], 'swap_currencies_equal')):
            with self.subTest(reason=reason), self.assertRaisesRegex(ValueError, reason):
                reconcile_consumption([lot()], [allocation(amount=400)],
                    [disposition(direct=100), disposition(currency=TOKEN, swapped=500)],
                    service_fee_bps=200, swaps=receipts)

    def test_receipt_cannot_charge_unused_original_or_fabricate_output(self):
        for direct, reason in ((979, 'net_input_disposition_mismatch'), (981, 'net_input_disposition_mismatch')):
            with self.subTest(direct=direct), self.assertRaisesRegex(ValueError, reason):
                reconcile_consumption([lot()], [allocation()], [disposition(direct=direct)], service_fee_bps=200)
        with self.assertRaisesRegex(ValueError, 'swap_output_overspent'):
            reconcile_consumption([lot()], [allocation()], [disposition(direct=980, swapped=1)], service_fee_bps=200)

    def test_wrong_source_or_currency_in_receipt_cannot_spend_selected_lots(self):
        for destination in (disposition(2, direct=980), disposition(currency=OTHER, direct=980)):
            with self.assertRaisesRegex(ValueError, 'disposition_identity_set_mismatch'):
                reconcile_consumption([lot()], [allocation()], [destination], service_fee_bps=200)
        with self.assertRaisesRegex(ValueError, 'net_input_disposition_mismatch'):
            reconcile_consumption([lot()], [allocation()],
                [disposition(direct=980), disposition(2), disposition(2, currency=TOKEN)],
                service_fee_bps=200, swaps=[swap(inputs=[swap_input(2, 100)])])

    def test_duplicate_dispositions_and_minted_extra_balance_rejected(self):
        with self.assertRaisesRegex(ValueError, 'duplicate_disposition'):
            reconcile_consumption([lot()], [allocation()], [disposition(direct=980), disposition()], service_fee_bps=200)
        with self.assertRaisesRegex(ValueError, 'swap_output_overspent'):
            reconcile_consumption([lot()], [allocation(amount=400)],
                [disposition(direct=100), disposition(currency=TOKEN, swapped=581)],
                service_fee_bps=200, swaps=[swap()])

    def test_converted_output_cannot_be_recycled_into_same_action_swap(self):
        with self.assertRaisesRegex(ValueError, 'net_input_disposition_mismatch'):
            reconcile_consumption([lot()], [allocation(amount=400)],
                [disposition(direct=100), disposition(currency=TOKEN), disposition(currency=OTHER)],
                service_fee_bps=200, swaps=[swap(), swap(2, inputs=[swap_input(1, 580)],
                    currency_in=TOKEN, currency_out=OTHER, amount_out=100)])

    def test_invalid_scalar_types_ranges_and_unknown_fields_rejected(self):
        for field in ('amountRaw', 'reservedRaw'):
            for value in ('01', '-1', '1.0', str(UINT128_MAX + 1), 1, True, None):
                item = lot()
                item[field] = value
                with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                    consume_allocations([item], [], service_fee_bps=200)
        for bps in (-1, 401, True, 200.0, '200'):
            with self.subTest(bps=bps), self.assertRaisesRegex(ValueError, 'invalid_service_fee_bps'):
                consume_allocations([lot()], [], service_fee_bps=bps)
        for update in ({'chargeStatus': 'principal'}, {'sourceId': '0x1'}, {'currency': 'ETH'},
                       {'unknown': 'x'}, {'reservedRaw': '1001'}):
            item = {**lot(), **update}
            with self.subTest(update=update), self.assertRaises(ValueError):
                consume_allocations([item], [], service_fee_bps=200)
        with self.assertRaises(ValueError):
            consume_allocations([lot()], [allocation(amount=0)], service_fee_bps=200)

    def test_invalid_swap_amounts_and_aggregate_overflow_rejected(self):
        for value in ('0', '-1', '01', str(UINT128_MAX + 1), 1, True):
            with self.subTest(value=value), self.assertRaises(ValueError):
                split_swap_output([swap_input(1, 1)], value)
        for inputs in ([], [swap_input(1, 0)], [swap_input(1, UINT128_MAX), swap_input(2, 1)]):
            with self.subTest(inputs=inputs), self.assertRaises(ValueError):
                split_swap_output(inputs, '1')

    def test_revalidation_and_no_mutation_on_success_or_failure(self):
        lots, allocations = [lot()], [allocation()]
        before = copy.deepcopy((lots, allocations))
        first = consume_allocations(lots, allocations, service_fee_bps=200)
        self.assertEqual((lots, allocations), before)
        self.assertEqual(first, consume_allocations(lots, allocations, service_fee_bps=200))
        model = FeeLot.model_validate(lots[0])
        self.assertEqual(first, consume_allocations([model], [Allocation.model_validate(allocations[0])], service_fee_bps=200))
        model.amountRaw = '-1'
        with self.assertRaises(ValueError):
            consume_allocations([model], allocations, service_fee_bps=200)
        with self.assertRaises(ValueError):
            consume_allocations(lots, [allocation(amount=1001)], service_fee_bps=200)
        self.assertEqual((lots, allocations), before)

    def test_independent_fraction_bounds_and_integer_conservation_samples(self):
        rng = random.Random(85)
        for _ in range(200):
            a, b, charged, bps = rng.randrange(1, 10000), rng.randrange(1, 10000), rng.randrange(10000), rng.randrange(401)
            lots = [lot(1, a), lot(2, b), lot(3, charged, charged=True)]
            allocations = [allocation(1, a), allocation(2, b)]
            if charged:
                allocations.append(allocation(3, charged))
            result = consume_allocations(lots, allocations, service_fee_bps=bps)
            group = result['groups'][0]
            fee, net = int(group['serviceFeeRaw']), int(group['netAvailableRaw'])
            exact_cut = Fraction((a + b) * bps, 10000)
            self.assertLessEqual(fee, exact_cut)
            self.assertLess(exact_cut, fee + 1)
            self.assertEqual(fee + net, a + b + charged)
            receipt = reconcile_consumption(lots, allocations, [disposition(direct=net)], service_fee_bps=bps)
            self.assert_conservation(lots, receipt)


if __name__ == '__main__':
    unittest.main()
