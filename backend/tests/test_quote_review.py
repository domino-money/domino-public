"""Independent adversarial review cases for non-executable quote observations."""
import copy
from decimal import Decimal
import json
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from discovery import CHAIN_ID, DataError, KEY_TYPES, ZERO
from eth_abi import encode
from eth_utils import keccak
from uniswap_quote import UniswapQuote


OWNER = '0x' + '11' * 20
TOKEN_A = '0x' + '22' * 20
TOKEN_B = '0x' + '33' * 20
TOKEN_C = '0x' + '44' * 20
FEE_RECIPIENT = '0x' + '55' * 20
SECRET = 'review-only-secret-must-not-escape'


def hop(a=TOKEN_A, b=TOKEN_B, *, incoming='100', outgoing='1000', fee=3000):
    pool_id = '0x' + keccak(encode(KEY_TYPES, (*sorted((a, b)), fee, 60, ZERO))).hex()
    result = {'type': 'v4-pool', 'address': pool_id, 'hooks': ZERO,
              'fee': str(fee), 'tickSpacing': '60',
              'tokenIn': {'address': a, 'chainId': CHAIN_ID, 'decimals': '18'},
              'tokenOut': {'address': b, 'chainId': CHAIN_ID, 'decimals': '18'}}
    if incoming is not None:
        result['amountIn'] = incoming
    if outgoing is not None:
        result['amountOut'] = outgoing
    return result


def response():
    return {'routing': 'CLASSIC', 'quote': {
        'chainId': CHAIN_ID, 'swapper': OWNER, 'tradeType': 'EXACT_INPUT',
        'slippage': Decimal('0.50'),
        'input': {'token': TOKEN_A, 'amount': '100'},
        'output': {'token': TOKEN_B, 'amount': '1000', 'minimumAmount': '995', 'recipient': OWNER},
        'route': [[hop()]], 'portionBips': 0, 'portionAmount': '0',
        'priceImpact': Decimal('0.1'), 'txFailureReasons': [],
        'gasFee': '100000', 'gasUseEstimate': '50000'}}


def output(recipient, amount, minimum, bps, *, fee=None):
    item = {'token': TOKEN_B, 'recipient': recipient, 'amount': amount,
            'minAmount': minimum, 'bps': bps}
    if fee is not None:
        item['fee'] = fee
    return item


class QuoteReviewTests(unittest.TestCase):
    def preview(self, payload=None, *, clock=None, transport=None, **overrides):
        payload = response() if payload is None else payload
        params = {'owner': OWNER, 'token_in': TOKEN_A, 'token_out': TOKEN_B,
                  'amount_raw': '100', 'slippage_bps': 50, 'max_price_impact_bps': 100}
        params.update(overrides)
        client = UniswapQuote(SECRET, transport=transport or (lambda *a, **k: copy.deepcopy(payload)),
                              clock=clock or (lambda: 1000))
        return client.preview(**params)

    def test_missing_fee_information_does_not_promote_gross_to_net(self):
        payload = response()
        for field in ('portionBips', 'portionAmount'):
            payload['quote'].pop(field)
        result = self.preview(payload)
        self.assertIsNone(result['quote']['outputAfterProviderFeeRaw'])
        self.assertIsNone(result['quote']['minimumAfterProviderFeeRaw'])
        self.assertEqual(result['providerOutputFee']['status'], 'unknown')
        self.assertIn('provider_output_fee_unknown', result['previewChecks']['reasons'])

    def test_fee_outputs_are_never_displayed_as_owner_net(self):
        payload = response()
        payload['quote'].update(portionBips=100, portionAmount='10', portionRecipient=FEE_RECIPIENT,
            aggregatedOutputs=[output(OWNER, '990', '985', 9900),
                               output(FEE_RECIPIENT, '10', '9', 100)])
        result = self.preview(payload)
        self.assertEqual(result['quote']['grossOutputAmountRaw'], '1000')
        self.assertIsNone(result['quote']['outputAfterProviderFeeRaw'])
        self.assertEqual(result['providerOutputFee']['status'], 'unsupported_nonzero')
        self.assertFalse(result['executionAvailable'])

    def test_legacy_zero_fee_conflicting_with_fee_output_is_rejected(self):
        payload = response()
        payload['quote']['aggregatedOutputs'] = [output(OWNER, '990', '985', 9900),
            output(FEE_RECIPIENT, '10', '9', 100)]
        with self.assertRaises(DataError):
            self.preview(payload)

    def test_legacy_fee_amount_conflicting_with_aggregated_fee_is_rejected(self):
        payload = response()
        payload['quote'].update(portionBips=200, portionAmount='20', portionRecipient=FEE_RECIPIENT,
            aggregatedOutputs=[output(OWNER, '990', '985', 9900),
                               output(FEE_RECIPIENT, '10', '9', 100)])
        with self.assertRaises(DataError):
            self.preview(payload)

    def test_legacy_fee_recipient_conflicting_with_aggregation_is_rejected(self):
        payload = response()
        payload['quote'].update(portionBips=100, portionAmount='10', portionRecipient=TOKEN_C,
            aggregatedOutputs=[output(OWNER, '990', '985', 9900),
                               output(FEE_RECIPIENT, '10', '9', 100)])
        with self.assertRaises(DataError):
            self.preview(payload)

    def test_aggregated_bps_cannot_claim_conflicting_allocation(self):
        payload = response()
        payload['quote']['aggregatedOutputs'] = [output(OWNER, '1000', '995', 1)]
        with self.assertRaises(DataError):
            self.preview(payload)

    def test_published_expiry_cannot_precede_quote_completion(self):
        times = iter((1000.9, 1030.1))
        with self.assertRaisesRegex(DataError, 'uniswap_quote_expired'):
            self.preview(clock=lambda: next(times))

    def test_clock_rollback_and_exact_expiry_fail(self):
        for end in (999, 1030):
            with self.subTest(end=end):
                times = iter((1000, end))
                with self.assertRaisesRegex(DataError, 'uniswap_quote_expired'):
                    self.preview(clock=lambda: next(times))

    def test_multihop_boundary_amounts_only_are_supported(self):
        payload = response()
        payload['quote']['route'] = [[hop(TOKEN_A, TOKEN_C, outgoing=None),
                                       hop(TOKEN_C, TOKEN_B, incoming=None)]]
        result = self.preview(payload)
        self.assertIsNone(result['quote']['routes'][0][0]['amountOutRaw'])
        self.assertIsNone(result['quote']['routes'][0][1]['amountInRaw'])
        self.assertEqual(result['quote']['outputAfterProviderFeeRaw'], '1000')

    def test_valid_split_and_inconsistent_split_sum(self):
        payload = response()
        payload['quote']['route'] = [[hop(incoming='30', outgoing='250', fee=500)],
                                       [hop(incoming='70', outgoing='750', fee=3000)]]
        self.assertEqual(self.preview(payload)['quote']['outputAfterProviderFeeRaw'], '1000')
        payload['quote']['route'][1][0]['amountIn'] = '69'
        with self.assertRaisesRegex(DataError, 'uniswap_quote_route_amount_mismatch'):
            self.preview(payload)

    def test_native_omitted_wrap_is_not_silently_equated_to_weth(self):
        payload = response()
        payload['quote']['input']['token'] = ZERO
        with self.assertRaisesRegex(DataError, 'uniswap_quote_native_route_unsupported'):
            self.preview(payload, token_in=ZERO)

    def test_native_direct_v4_route_preserves_zero_address(self):
        payload = response()
        payload['quote']['input']['token'] = ZERO
        payload['quote']['route'] = [[hop(ZERO, TOKEN_B)]]
        result = self.preview(payload, token_in=ZERO)
        self.assertEqual(result['quote']['routes'][0][0]['tokenIn']['address'], ZERO)

    def test_minimum_output_one_unit_below_limit_fails(self):
        payload = response()
        payload['quote']['output']['minimumAmount'] = '994'
        with self.assertRaisesRegex(DataError, 'uniswap_quote_minimum_output_mismatch'):
            self.preview(payload)

    def test_numeric_bool_chain_and_fractional_metadata_fail(self):
        mutations = [('chainId', True), ('chainId', Decimal('4663.1'))]
        for key, value in mutations:
            with self.subTest(value=value):
                payload = response()
                payload['quote'][key] = value
                with self.assertRaises(DataError):
                    self.preview(payload)
        payload = response()
        payload['quote']['route'][0][0]['tickSpacing'] = Decimal('60.1')
        with self.assertRaises(DataError):
            self.preview(payload)

    def test_limits_and_duplicate_pool_cannot_pass(self):
        for routes in ([[hop()]] * 9, [[hop(incoming='50', outgoing='500')]] * 2):
            with self.subTest(count=len(routes)):
                payload = response()
                payload['quote']['route'] = routes
                with self.assertRaises(DataError):
                    self.preview(payload)

    def test_provider_secrets_and_executable_payloads_are_dropped(self):
        payload = response()
        payload.update(permitData={'secret': SECRET}, permitTransaction={'data': SECRET})
        payload['quote'].update(swapSteps=[{'data': SECRET}], quoteId=SECRET,
                               routeString=SECRET, unknownField=SECRET)
        payload['quote']['route'][0][0]['tokenIn']['symbol'] = SECRET
        result = json.dumps(self.preview(payload))
        self.assertNotIn(SECRET, result)
        self.assertNotIn('permitData', result)
        self.assertNotIn('swapSteps', result)

    def test_untrusted_transport_exception_is_sanitized(self):
        for error in (RuntimeError(SECRET), DataError(SECRET), OSError(SECRET)):
            with self.subTest(kind=type(error).__name__):
                def fail(*args, **kwargs):
                    raise error
                with self.assertRaisesRegex(DataError, '^uniswap_quote_unavailable$') as raised:
                    self.preview(transport=fail)
                self.assertNotIn(SECRET, str(raised.exception))

    def test_simulation_missing_failed_and_empty_remain_distinct(self):
        for failure in (None, [], ['SIMULATION_UNAVAILABLE']):
            with self.subTest(failure=failure):
                payload = response()
                payload['quote']['txFailureReasons'] = failure
                result = self.preview(payload)
                self.assertFalse(result['simulation']['independentSuccessProven'])
                self.assertFalse(result['executionAvailable'])
                expected = ('unknown' if failure is None else 'provider_reported_failure'
                            if failure else 'no_provider_failure_reported')
                self.assertEqual(result['simulation']['status'], expected)


if __name__ == '__main__':
    unittest.main()
