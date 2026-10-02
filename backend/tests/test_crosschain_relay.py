"""Relay quotes, status and fee records against recorded answers, and every tampering the checks must refuse."""
from copy import deepcopy
import unittest

from crosschain_support import (FEE, OTHER, OWNER, RELAY_REQUEST, USDC_ARBITRUM, USDC_BASE, USDG, ZERO, FakeHttp,
                                fixture, provider_request, relay_record)
from discovery import DataError
from crosschain_common import encode_call, load_pins
from crosschain_relay import (DEPOSIT_ERC20, DEPOSIT_NATIVE, RelayProvider, parse_chains, parse_quote,
                              parse_request_record, parse_status)

PINS = load_pins()
DEPOSITORY = '0x4cd00e387622c35bddb9b4c962c136462338bc31'
USDC_REQUEST = dict(origin=8453, origin_token=USDC_BASE, destination=42161, destination_token=USDC_ARBITRUM, amount='25000000')
USDG_REQUEST = dict(origin=42161, origin_token=USDC_ARBITRUM, destination=4663, destination_token=USDG)
ETH_REQUEST = dict(origin=8453, origin_token=ZERO, destination=4663, destination_token=ZERO,
                   amount='100000000000000000', slippage=200)


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
