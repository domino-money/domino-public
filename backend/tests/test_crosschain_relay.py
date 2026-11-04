"""Relay quotes, status and fee records against recorded answers, and every tampering the checks must refuse."""
from copy import deepcopy
import unittest

from crosschain_support import (FEE, OTHER, OWNER, RELAY_REQUEST, USDC_ARBITRUM, USDC_BASE, USDG, ZERO, FakeHttp,
                                fixture, output_call, provider_request, relay_record)
from discovery import DataError
from crosschain_common import encode_call, load_pins
from crosschain_http import ProviderError, ProviderHttp
from crosschain_relay import (DEPOSIT_ERC20, DEPOSIT_NATIVE, RELAY_API, RelayProvider, expected_for_minimum, parse_chains,
                              parse_quote, parse_request_record, parse_status)
from test_crosschain_http import Clock, Opener

PINS = load_pins()
DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
USDC_REQUEST = dict(origin=8453, origin_token=USDC_BASE, destination=42161, destination_token=USDC_ARBITRUM, amount='25000000')
USDG_REQUEST = dict(origin=42161, origin_token=USDC_ARBITRUM, destination=4663, destination_token=USDG)
ETH_REQUEST = dict(origin=8453, origin_token=ZERO, destination=4663, destination_token=ZERO,
                   amount='100000000000000000', slippage=200)
# The answers by output of 6 Oct 2026 (EXPECTED_OUTPUT, 50 bps), with the need each was asked for.
OUTPUT_USDG = 'relay-quote-expected-output-usdc-base-usdg.json'           # 100 USDG, asked 100.502513 (grossed up)
OUTPUT_ETH = 'relay-quote-expected-output-eth-base-robinhood.json'        # 0.05 ETH, asked 0.050251256281407036
OUTPUT_ARB_BASE = 'relay-quote-expected-output-usdc-arbitrum-base.json'   # 99.5 USDC, asked 100
OUTPUT_TOPUP = 'relay-quote-expected-output-topup.json'                   # 99.5 USDG with gas, asked 100
USDG_FROM_BASE = dict(origin=8453, origin_token=USDC_BASE, destination=4663, destination_token=USDG)
ETH_FROM_BASE = dict(origin=8453, origin_token=ZERO, destination=4663, destination_token=ZERO)
USDC_ARB_TO_BASE = dict(origin=42161, origin_token=USDC_ARBITRUM, destination=8453, destination_token=USDC_BASE)


def step(payload, kind):
    return next(s for s in payload['steps'] if s['id'] == kind)['items'][0]['data']


class RelayQuoteTests(unittest.TestCase):
    def parse(self, payload, **request):
        return parse_quote(payload, provider_request(**request), PINS)

    def refuse(self, payload, code, **request):
        with self.assertRaises(DataError) as caught:
            self.parse(payload, **request)
        self.assertEqual(str(caught.exception), code)

    def test_an_erc20_bridge_deposits_into_the_pinned_depository_with_an_exact_approval(self):
        payload = fixture('relay-quote-usdc-base-arbitrum.json')
        quote = self.parse(payload, **USDC_REQUEST)
        self.assertEqual((quote['outputRaw'], quote['minimumOutputRaw']), ('24886740', '24762307'))
        # 35 bps of the 25 USDC input, in the input token on the origin.
        self.assertEqual(quote['appFee'], {'amountRaw': '87500', 'chainId': 8453, 'token': USDC_BASE, 'charged': 'origin_input'})
        self.assertEqual(quote['approval'], {'token': USDC_BASE, 'spender': DEPOSITORY, 'amountRaw': '25000000'})
        self.assertEqual(quote['deposit']['to'], DEPOSITORY)
        self.assertEqual(quote['deposit']['valueRaw'], '0')
        self.assertEqual(quote['refund'], {'chainId': 8453, 'recipient': OWNER})
        self.assertEqual(quote['tracking'], {'requestId': payload['requestId'].lower()})
        self.assertEqual(quote['etaSeconds'], 1)
        self.assertEqual(quote['originGas']['feeRaw'], '1268669253129')
        self.assertIsNone(quote['destinationGas'])

    def test_native_eth_uses_deposit_native_with_the_amount_as_value_and_no_approval(self):
        quote = self.parse(fixture('relay-quote-eth-base-robinhood.json'), **ETH_REQUEST)
        self.assertIsNone(quote['approval'])
        self.assertEqual(quote['deposit']['valueRaw'], '100000000000000000')
        self.assertEqual(quote['appFee']['amountRaw'], '350000000000000')
        self.assertEqual(quote['outputRaw'], '99622352599893293')

    def test_gas_top_up_is_reported_only_when_asked(self):
        payload = fixture('relay-quote-usdc-arbitrum-usdg-topup.json')
        self.assertEqual(self.parse(payload, **USDG_REQUEST, gas=True)['destinationGas'], {'deliveredRaw': '740778127264099'})
        self.assertIsNone(self.parse(payload, **USDG_REQUEST)['destinationGas'])
        # Asked for, but absent from the answer: the candidate carries no gas (the service marks it).
        plain = fixture('relay-quote-usdc-arbitrum-usdg.json')
        self.assertIsNone(self.parse(plain, **USDG_REQUEST, gas=True)['destinationGas'])

    def test_recorded_answers_the_service_must_refuse(self):
        # An implicit transfer to the Depository (explicitDeposit false), a quote without the app fee,
        # and an EXACT_OUTPUT quote whose input is not the request's.
        self.refuse(fixture('relay-quote-implicit-transfer.json'), 'relay_quote_deposit_target',
                    origin=42161, origin_token=USDC_ARBITRUM, destination=8453, destination_token=USDC_BASE, slippage=200)
        self.refuse(fixture('relay-quote-no-app-fee.json'), 'relay_quote_app_fee_not_applied', **USDG_REQUEST, slippage=200)
        self.refuse(fixture('relay-quote-exact-output.json'), 'relay_quote_payment_mismatch',
                    origin=42161, origin_token=USDC_ARBITRUM, destination=8453, destination_token=USDC_BASE, slippage=200)

    def tampered(self, change, code, payload_name='relay-quote-usdc-base-arbitrum.json', request=USDC_REQUEST):
        payload = fixture(payload_name)
        change(payload)
        self.refuse(payload, code, **request)

    def test_a_deposit_to_any_other_contract_is_refused(self):
        def elsewhere(p):
            step(p, 'deposit')['to'] = OTHER
            p['protocol']['v2']['paymentDetails']['depository'] = OTHER
        self.tampered(elsewhere, 'relay_quote_payment_mismatch')
        self.tampered(lambda p: step(p, 'deposit').update(to=OTHER), 'relay_quote_deposit_target')

    def test_calldata_must_name_the_user_the_amount_and_the_signed_order(self):
        def call(**changes):
            def change(p):
                order = bytes.fromhex(p['protocol']['v2']['orderId'][2:])
                values = {'depositor': OWNER, 'token': USDC_BASE, 'amount': 25000000, 'id': order, **changes}
                step(p, 'deposit')['data'] = encode_call(DEPOSIT_ERC20[0], DEPOSIT_ERC20[1],
                                                         [values['depositor'], values['token'], values['amount'], values['id']])
            return change
        self.tampered(call(depositor=OTHER), 'relay_quote_depositor')
        self.tampered(call(amount=25000001), 'relay_quote_deposit_amount')
        self.tampered(call(token=USDC_ARBITRUM), 'relay_quote_deposit_token')
        self.tampered(call(id=b'\x01' * 32), 'relay_quote_deposit_order')
        # The native deposit of someone else, or a different value, is refused too.
        def native(p):
            data = step(p, 'deposit')
            data['data'] = encode_call(DEPOSIT_NATIVE[0], DEPOSIT_NATIVE[1], [OTHER, bytes.fromhex(p['protocol']['v2']['orderId'][2:])])
        self.tampered(native, 'relay_quote_depositor', 'relay-quote-eth-base-robinhood.json', ETH_REQUEST)
        self.tampered(lambda p: step(p, 'deposit').update(value='1'), 'relay_quote_deposit_value',
                      'relay-quote-eth-base-robinhood.json', ETH_REQUEST)

    def test_non_canonical_calldata_is_refused(self):
        self.tampered(lambda p: step(p, 'deposit').update(data=step(p, 'deposit')['data'] + '00' * 32), 'relay_quote_deposit_call')
        self.tampered(lambda p: step(p, 'deposit').update(data='0x12345678' + step(p, 'deposit')['data'][10:]), 'relay_quote_deposit_call')

    def test_the_signed_order_pays_and_refunds_only_the_user_with_no_destination_calls(self):
        output = lambda p: p['protocol']['v2']['orderData']['output']
        self.tampered(lambda p: output(p)['payments'][0].update(recipient=OTHER), 'relay_quote_order_recipient')
        self.tampered(lambda p: output(p).update(calls=[{'to': OTHER, 'data': '0x'}]), 'relay_quote_order_output_mismatch')
        self.tampered(lambda p: output(p).update(chainId='ethereum'), 'relay_quote_order_output_mismatch')
        self.tampered(lambda p: output(p)['payments'][0].update(currency=OTHER), 'relay_quote_order_currency')
        self.tampered(lambda p: output(p)['payments'][0].update(expectedAmount='24886739'), 'relay_quote_output_mismatch')
        self.tampered(lambda p: p['protocol']['v2']['orderData']['inputs'][0]['refunds'][0].update(recipient=OTHER),
                      'relay_quote_refund_recipient')
        self.tampered(lambda p: p['protocol'].pop('v2'), 'relay_quote_protocol_unsupported')

    def test_the_summary_must_match_the_order(self):
        self.tampered(lambda p: p['details'].update(recipient=OTHER), 'relay_quote_details_recipient')
        self.tampered(lambda p: p['details']['currencyOut']['currency'].update(chainId=1), 'relay_quote_output_mismatch')
        self.tampered(lambda p: p['details']['currencyIn'].update(amount='1'), 'relay_quote_input_mismatch')

    def test_approvals_are_exact_and_only_to_the_depository(self):
        approve = lambda spender, amount: lambda p: step(p, 'approve').update(
            data=encode_call('approve(address,uint256)', ('address', 'uint256'), (spender, amount)))
        self.tampered(approve(OTHER, 25000000), 'relay_quote_approval_spender')
        self.tampered(approve(DEPOSITORY, 2**256 - 1), 'relay_quote_approval_amount')
        self.tampered(lambda p: step(p, 'approve').update(to=OTHER), 'relay_quote_approval_target')

    def test_unexpected_steps_and_chains_are_refused(self):
        self.tampered(lambda p: p['steps'].append(deepcopy(p['steps'][1])), 'relay_quote_shape')
        self.tampered(lambda p: p['steps'][0].update(id='swap'), 'relay_quote_step_unexpected')
        self.tampered(lambda p: step(p, 'deposit').update(chainId=1), 'relay_quote_step_chain')
        self.tampered(lambda p: step(p, 'deposit').update({'from': OTHER}), 'relay_quote_step_sender')

    def test_the_app_fee_must_be_35_bps_of_the_input(self):
        self.tampered(lambda p: p['fees']['app'].update(amount='90000'), 'relay_quote_app_fee_not_applied')
        self.tampered(lambda p: p['fees']['app'].update(amount='0'), 'relay_quote_app_fee_not_applied')
        self.tampered(lambda p: p['fees']['app']['currency'].update(address=USDC_ARBITRUM), 'relay_quote_app_fee_currency')

    def test_the_signed_minimum_respects_the_chosen_slippage(self):
        payload = fixture('relay-quote-eth-base-robinhood.json')
        # Relay's automatic 2% minimum is refused for a 0.5% request.
        self.refuse(payload, 'relay_quote_minimum_below_slippage', **{**ETH_REQUEST, 'slippage': 50})

    def test_only_pinned_chains_are_quoted(self):
        self.refuse(fixture('relay-quote-usdc-base-arbitrum.json'), 'relay_chain_not_pinned', **{**USDC_REQUEST, 'origin': 999999})


def order_out(payload):
    return payload['protocol']['v2']['orderData']['output']['payments'][0]


class RelayOutputQuoteTests(unittest.TestCase):
    """By output (EXPECTED_OUTPUT): the solver computes the input, which must then be the same everywhere; the order
    prices the amount asked and its signed minimum covers the need; Relay's fee is 35 bps of the net amount."""

    def parse(self, payload, need, **request):
        return parse_quote(payload, output_call(need, **request), PINS)

    def refuse(self, payload, code, need=100000000, **request):
        with self.assertRaises(DataError) as caught:
            self.parse(payload, need, **(request or USDG_FROM_BASE))
        self.assertEqual(str(caught.exception), code)

    def tampered(self, change, code, name=OUTPUT_USDG, need=100000000, request=USDG_FROM_BASE):
        payload = fixture(name)
        change(payload)
        self.refuse(payload, code, need, **request)

    def test_every_recorded_answer_by_output(self):
        cases = (  # name, need, route, (input, expected, minimum, app fee, relayer fee)
            (OUTPUT_USDG, 100000000, USDG_FROM_BASE, ('100916974', '100502513', '100000000', 351817, 46007)),
            (OUTPUT_ETH, 50000000000000000, ETH_FROM_BASE,
             ('50445218582624564', '50251256281407036', '50000000000000000', 175879396984924, 18082904232604)),
            (OUTPUT_ARB_BASE, 99500000, USDC_ARB_TO_BASE, ('100381125', '100000000', '99500000', 350000, 31125)),
            (OUTPUT_TOPUP, 99500000, {**USDG_FROM_BASE, 'gas': True}, ('102431289', '100000000', '99500000', 350062, 2063465)),
        )
        for name, need, request, (sent, expected, minimum, fee, relayer) in cases:
            with self.subTest(name=name):
                quote = self.parse(fixture(name), need, **request)
                self.assertEqual((quote['inputRaw'], quote['outputRaw'], quote['minimumOutputRaw']), (sent, expected, minimum))
                # What was asked is the need grossed up by the slippage, and the signed minimum is the need, exactly.
                self.assertEqual(int(expected), expected_for_minimum(need, 50))
                self.assertEqual(int(minimum), need)
                # 35 bps of the net amount, in the input token on the origin: not 35 bps of what is sent.
                self.assertEqual(int(quote['appFee']['amountRaw']), fee)
                self.assertEqual(fee, (int(sent) - relayer) * 35 // 10035)
                self.assertEqual(quote['appFee'], {'amountRaw': str(fee), 'chainId': request['origin'],
                                                   'token': request['origin_token'], 'charged': 'origin_input'})
                # The steps take the input: the exact approval, or the native deposit's value.
                if request['origin_token'] == ZERO:
                    self.assertIsNone(quote['approval'])
                    self.assertEqual(quote['deposit']['valueRaw'], sent)
                else:
                    self.assertEqual(quote['approval'], {'token': request['origin_token'], 'spender': DEPOSITORY, 'amountRaw': sent})
                    self.assertEqual(quote['deposit']['valueRaw'], '0')
        # A gas top-up is added to the input, outside the fee's base; the output stays whole.
        topup = self.parse(fixture(OUTPUT_TOPUP), 99500000, **USDG_FROM_BASE, gas=True)
        self.assertEqual(topup['destinationGas'], {'deliveredRaw': '739967225046082'})
        self.assertNotEqual(int(topup['appFee']['amountRaw']), 102431289 * 35 // 10000)

    def test_the_input_is_the_signed_payment_and_the_same_everywhere(self):
        payment = lambda p: p['protocol']['v2']['paymentDetails']
        plus_one = lambda value: str(int(value) + 1)
        self.tampered(lambda p: payment(p).update(amount='0'), 'relay_quote_payment_mismatch')
        self.tampered(lambda p: payment(p).update(amount=plus_one(payment(p)['amount'])), 'relay_quote_order_input_mismatch')
        order_in = lambda p: p['protocol']['v2']['orderData']['inputs'][0]['payment']
        self.tampered(lambda p: order_in(p).update(amount=plus_one(order_in(p)['amount'])), 'relay_quote_order_input_mismatch')
        self.tampered(lambda p: p['details']['currencyIn'].update(amount=plus_one(p['details']['currencyIn']['amount'])),
                      'relay_quote_input_mismatch')

        def deposited(amount):
            def change(p):
                order = bytes.fromhex(p['protocol']['v2']['orderId'][2:])
                step(p, 'deposit')['data'] = encode_call(DEPOSIT_ERC20[0], DEPOSIT_ERC20[1], [OWNER, USDC_BASE, amount, order])
            return change
        self.tampered(deposited(100916975), 'relay_quote_deposit_amount')
        approve = lambda amount: lambda p: step(p, 'approve').update(
            data=encode_call('approve(address,uint256)', ('address', 'uint256'), (DEPOSITORY, amount)))
        self.tampered(approve(100916975), 'relay_quote_approval_amount')
        self.tampered(approve(100000000), 'relay_quote_approval_amount')
        # The native deposit's value is the input.
        self.tampered(lambda p: step(p, 'deposit').update(value=plus_one(step(p, 'deposit')['value'])),
                      'relay_quote_deposit_value', OUTPUT_ETH, 50000000000000000, ETH_FROM_BASE)

    def test_the_order_prices_the_amount_asked_and_its_minimum_covers_the_need(self):
        def short(p):
            for row, key in ((order_out(p), 'expectedAmount'), (p['details']['currencyOut'], 'amount')):
                row[key] = str(int(row[key]) - 1)
        self.tampered(short, 'relay_quote_output_not_requested')
        # The same amount asked, but a need one above the minimum Relay signed: refused; at the minimum itself, served.
        call = output_call(100000000, **USDG_FROM_BASE)
        with self.assertRaisesRegex(DataError, '^relay_quote_minimum_below_request$'):
            parse_quote(fixture(OUTPUT_USDG), {**call, 'need': 100000001}, PINS)
        self.assertEqual(parse_quote(fixture(OUTPUT_USDG), call, PINS)['minimumOutputRaw'], '100000000')
        # An answer for the bare need (100 USDC asked, a minimum of 99.5 signed) is not what a need of 100 asks for.
        self.refuse(fixture(OUTPUT_ARB_BASE), 'relay_quote_output_not_requested', 100000000, **USDC_ARB_TO_BASE)

    def test_the_fee_base_is_relays_own_fee_in_the_input_token(self):
        relayer = lambda p: p['fees']['relayer']
        self.tampered(lambda p: p['fees'].pop('relayer'), 'relay_quote_fee_base')
        self.tampered(lambda p: relayer(p)['currency'].update(chainId=42161), 'relay_quote_fee_base')
        self.tampered(lambda p: relayer(p)['currency'].update(address=USDG), 'relay_quote_fee_base')
        self.tampered(lambda p: relayer(p).update(amount='100916975'), 'relay_quote_fee_base')
        # A fee of the whole input leaves no base, so no fee could be 35 bps of it, not even a fee of nothing.
        self.tampered(lambda p: relayer(p).update(amount='100916974'), 'relay_quote_app_fee_not_applied')
        self.tampered(lambda p: (relayer(p).update(amount='100916974'), p['fees']['app'].update(amount='0')),
                      'relay_quote_app_fee_not_applied')

    def test_the_app_fee_is_35_bps_of_the_net_amount_within_one_unit(self):
        expected = (100916974 - 46007) * 35 // 10035
        self.assertEqual(expected, 351817)
        for charged in (expected - 1, expected + 1):
            with self.subTest(charged=charged):
                payload = fixture(OUTPUT_USDG)
                payload['fees']['app']['amount'] = str(charged)
                self.assertEqual(self.parse(payload, 100000000, **USDG_FROM_BASE)['appFee']['amountRaw'], str(charged))
        for charged in (expected - 2, expected + 2, 0, 100916974 * 35 // 10000):
            with self.subTest(charged=charged):
                self.tampered(lambda p: p['fees']['app'].update(amount=str(charged)), 'relay_quote_app_fee_not_applied')

    def test_exact_input_keeps_its_rule(self):
        # The same answer read as an exact input of what it takes is refused: there the fee is 35 bps of the input.
        with self.assertRaises(DataError) as caught:
            parse_quote(fixture(OUTPUT_USDG), provider_request(**USDG_FROM_BASE, amount='100916974'), PINS)
        self.assertEqual(str(caught.exception), 'relay_quote_app_fee_not_applied')
        # And an exact input is the request's amount, whatever the payment says.
        self.assertEqual(parse_quote(fixture('relay-quote-usdc-base-arbitrum.json'), provider_request(**USDC_REQUEST),
                                     PINS)['inputRaw'], '25000000')

    def test_the_gross_up_is_the_least_amount_whose_signed_minimum_covers_the_need(self):
        self.assertEqual(expected_for_minimum(100000000, 50), 100502513)
        self.assertEqual(expected_for_minimum(50000000000000000, 50), 50251256281407036)
        self.assertEqual(expected_for_minimum(99500000, 50), 100000000)
        for need in (1, 7, 9950, 12345, 99500000, 100000000, 10**18 + 1):
            for slippage in (10, 50, 199, 200, 500):
                asked = expected_for_minimum(need, slippage)
                with self.subTest(need=need, slippage=slippage):
                    self.assertGreaterEqual(asked * (10000 - slippage) // 10000, need)
                    self.assertLess((asked - 1) * (10000 - slippage) // 10000, need)


class RelayRequestTests(unittest.TestCase):
    def test_the_quote_request_carries_the_fee_refund_and_user(self):
        http = FakeHttp('relay', {('POST', '/quote/v2'): fixture('relay-quote-usdc-arbitrum-usdg-topup.json')})
        provider = RelayProvider(http, PINS, fee_recipient=FEE)
        provider.quote(provider_request(**USDG_REQUEST, gas=True))
        body = http.calls[0]['body']
        self.assertEqual(body['appFees'], [{'recipient': FEE, 'fee': '35'}])
        self.assertEqual((body['user'], body['recipient'], body['refundTo']), (OWNER, OWNER, OWNER))
        self.assertEqual((body['tradeType'], body['explicitDeposit'], body['topupGas'], body['slippageTolerance']),
                         ('EXACT_INPUT', True, True, '50'))
        self.assertNotIn('referrer', body)
        http.calls.clear()
        http.routes[('POST', '/quote/v2')] = fixture('relay-quote-usdc-arbitrum-usdg.json')
        provider.quote(provider_request(**USDG_REQUEST))
        self.assertNotIn('topupGas', http.calls[0]['body'])
        self.assertEqual((http.calls[0]['body']['tradeType'], http.calls[0]['body']['amount']), ('EXACT_INPUT', '100000000'))

    def test_by_output_relay_is_asked_the_need_grossed_up_by_the_slippage_never_exact_output(self):
        http = FakeHttp('relay', {('POST', '/quote/v2'): fixture(OUTPUT_USDG)})
        provider = RelayProvider(http, PINS, fee_recipient=FEE)
        self.assertEqual(provider.quote(output_call(100000000, **USDG_FROM_BASE))['inputRaw'], '100916974')
        # The need grossed up, rounded up (an odd need), exactly (no rounding), and at a wider slippage.
        for need, slippage, asked in ((100000000, 50, '100502513'), (12345, 50, '12408'), (99500000, 50, '100000000'),
                                      (100000000, 200, '102040817')):
            with self.subTest(need=need, slippage=slippage):
                http.calls.clear()
                try:
                    provider.quote(output_call(need, **USDG_FROM_BASE, slippage=slippage))
                except DataError:
                    pass  # the recorded answer was for another request; only what was asked matters here
                body = http.calls[0]['body']
                self.assertEqual((body['tradeType'], body['amount'], body['slippageTolerance']),
                                 ('EXPECTED_OUTPUT', asked, str(slippage)))
                self.assertEqual(body['appFees'], [{'recipient': FEE, 'fee': '35'}])
                self.assertEqual((body['user'], body['recipient'], body['refundTo'], body['explicitDeposit']),
                                 (OWNER, OWNER, OWNER, True))

    def test_status_maps_every_relay_status(self):
        cases = {'waiting': 'awaiting_deposit', 'depositing': 'pending', 'pending': 'pending', 'submitted': 'pending',
                 'delayed': 'pending', 'success': 'filled', 'refund': 'refunded', 'failure': 'failed', 'fallback': 'pending'}
        for status, state in cases.items():
            with self.subTest(status=status):
                self.assertEqual(parse_status({'status': status})['state'], state)
        self.assertEqual(parse_status({'status': 'failure', 'refundFailReason': 'MANUAL_REFUND_REQUIRED'})['state'], 'refund_failed')
        self.assertEqual(parse_status({'status': 'failure', 'refundFailReason': 'N/A'})['state'], 'failed')
        recorded = parse_status(fixture('relay-status-success.json'))
        self.assertEqual((recorded['state'], len(recorded['inTxHashes'])), ('filled', 1))
        self.assertEqual(parse_status(fixture('relay-status-waiting.json'))['state'], 'awaiting_deposit')
        for bad in ({'status': 'SUCCESS!'}, {'status': 1}, {}, {'status': 'success', 'txHashes': ['0x1']}, []):
            with self.subTest(bad=bad), self.assertRaises(DataError):
                parse_status(bad)

    def test_the_fee_record_counts_only_domino_recipient(self):
        record = parse_request_record(relay_record(), RELAY_REQUEST, FEE)
        self.assertEqual((record['actualRaw'], record['quotedRaw'], record['user']), (350000, 350000, OWNER))
        self.assertEqual(record['currency'], {'chainId': 42161, 'token': USDC_ARBITRUM})
        self.assertIsNone(parse_request_record(relay_record(recipient=OTHER), RELAY_REQUEST, FEE)['actualRaw'])
        self.assertIsNone(parse_request_record(relay_record(actual=None), RELAY_REQUEST, FEE)['actualRaw'])
        self.assertIsNone(parse_request_record(relay_record(request_id='0x' + 'ab' * 32), RELAY_REQUEST, FEE))

    def test_the_fee_record_needs_the_key_and_is_asked_once_when_settled(self):
        http = FakeHttp('relay', {('GET', '/requests/v3'): relay_record()})
        self.assertIsNone(RelayProvider(http, PINS, fee_recipient=FEE).record(RELAY_REQUEST))
        self.assertEqual(http.calls, [])
        provider = RelayProvider(http, PINS, fee_recipient=FEE, has_key=True)
        self.assertEqual(provider.record(RELAY_REQUEST)['actualRaw'], 350000)
        self.assertEqual(provider.record(RELAY_REQUEST)['actualRaw'], 350000)
        self.assertEqual(len(http.calls), 1)

    def test_tracking_draws_on_the_status_share_and_never_starves_quotes(self):
        # The status reads (its status and, once filled, its fee record) have their own share of the provider's
        # calls (3 Nov 2026): polling uses it up, and every quote still has its slot.
        status, quote = fixture('relay-status-waiting.json'), fixture('relay-quote-usdc-arbitrum-usdg.json')
        opener = Opener(*([status] * 4 + [relay_record()] + [quote] * 10))
        http = ProviderHttp('relay', RELAY_API, per_minute=15, status_per_minute=5, opener=opener, clock=Clock(),
                            sleep=lambda seconds: None)
        provider = RelayProvider(http, PINS, fee_recipient=FEE, has_key=True)
        for _ in range(4):
            provider.observe(RELAY_REQUEST)
        provider.record(RELAY_REQUEST)
        with self.assertRaisesRegex(ProviderError, 'relay_rate_limited'):
            provider.observe(RELAY_REQUEST)
        for _ in range(10):
            provider.quote(provider_request(**USDG_REQUEST))
        self.assertEqual(len(opener.requests), 15)

    def test_chains_keep_only_pinned_evm_chains_whose_live_depository_matches(self):
        listing = fixture('relay-chains.json')
        rows = parse_chains(listing, PINS)
        self.assertEqual(sorted(rows), [1, 10, 25, 4663, 8453, 42161, 59144])
        self.assertIn(ZERO, [token['address'] for token in rows[4663]])
        for chain in listing['chains']:
            if chain['id'] == 8453:
                chain['protocol']['v2']['depository'] = OTHER
        self.assertNotIn(8453, parse_chains(listing, PINS))


if __name__ == '__main__':
    unittest.main()
