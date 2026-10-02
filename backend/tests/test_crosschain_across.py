"""Across quotes, deposit records and fee proofs against recorded answers, and the tampering the checks refuse."""
import unittest

from eth_abi import decode, encode

from crosschain_support import (FEE, FILL_HASH, OTHER, OWNER, USDC_ARBITRUM, USDC_BASE, USDG, WETH_ROBINHOOD, ZERO,
                                FakeHttp, FakeRpc, across_deposit, across_record, fill_receipt, fixture,
                                provider_request, quote_time)
from discovery import DataError
from crosschain_across import (DEPOSIT, DEPOSIT_NATIVE, DRAIN, EMIT, INSTRUCTIONS, MAKE_CALL, TRANSFER, WITHDRAW,
                               AcrossProvider, ChainRpc, message_fee, parse_deposit, parse_quote, parse_routes)
from crosschain_common import encode_call, load_destinations, load_pins
from crosschain_http import ProviderError

PINS, DESTINATIONS = load_pins(), load_destinations()
SPOKE_ARBITRUM = '0xe35e9842fceaca96570b734083f4a58e8f7c5f2a'
SPOKE_ROBINHOOD = '0xd29c85f15df544ba632c9e25829fd29d767d7978'
PERIPHERY = '0x97ccdbea4632140639ad5ea9b944aa034eb15fd4'
HANDLER_ROBINHOOD = '0xa8ad2e87e2043711d8bec77e8bc3e2683c0ab6bd'
EMITTER = '0xbf75133b48b0a42ab9374027902e83c5e2949034'
WETH_ARBITRUM = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1'
USDG_QUOTE = 'across-quote-usdc-arbitrum-usdg-robinhood.json'
ETH_QUOTE = 'across-quote-eth-arbitrum-robinhood.json'
USDG_REQUEST = dict(origin=42161, origin_token=USDC_ARBITRUM, destination=4663, destination_token=USDG)
ETH_REQUEST = dict(origin=42161, origin_token=ZERO, destination=4663, destination_token=ZERO, amount='50000000000000000')
word = lambda value: bytes.fromhex(value[2:].rjust(64, '0'))


def rebuild(payload, **changes):
    """Re-encode the quote's deposit call with some arguments changed (message: a hex string)."""
    data = payload['swapTx']['data']
    native = data.startswith('0x609ea081')
    signature, types = DEPOSIT_NATIVE if native else DEPOSIT
    names = (['spokePool', 'depositor', 'recipient', 'inputToken', 'inputAmount', 'outputToken', 'outputAmount',
              'destinationChainId', 'exclusiveRelayer', 'quoteTimestamp', 'fillDeadline', 'exclusivity', 'message'] if native else
             ['depositor', 'recipient', 'inputToken', 'outputToken', 'inputAmount', 'outputAmount', 'destinationChainId',
              'exclusiveRelayer', 'quoteTimestamp', 'fillDeadline', 'exclusivity', 'message'])
    values = dict(zip(names, decode(list(types), bytes.fromhex(data[10:]))))
    for name, value in changes.items():
        if name == 'message':
            value = bytes.fromhex(value[2:])
        elif types[names.index(name)] == 'bytes32':
            value = word(value)
        values[name] = value
    payload['swapTx']['data'] = encode_call(signature, types, [values[name] for name in names])
    return payload


def calls_of(message):
    (calls, fallback), = decode([INSTRUCTIONS], bytes.fromhex(message[2:]))
    return [list(call) for call in calls], fallback


def message_with(calls, fallback=ZERO):
    return '0x' + encode([INSTRUCTIONS], [([tuple(call) for call in calls], fallback)]).hex()


def call(target, signature_types, values, value=0):
    signature, types = signature_types
    return [target, bytes.fromhex(encode_call(signature, types, values)[2:]), value]


class AcrossQuoteTests(unittest.TestCase):
    def parse(self, payload, name=USDG_QUOTE, **request):
        return parse_quote(payload, provider_request(**(request or USDG_REQUEST)), PINS, DESTINATIONS,
                           fee_recipient=FEE, now=quote_time(name))

    def refuse(self, payload, code, name=USDG_QUOTE, **request):
        with self.assertRaises(DataError) as caught:
            self.parse(payload, name, **request)
        self.assertEqual(str(caught.exception), code)

    def test_an_erc20_bridge_pays_a_pinned_handler_that_sends_35_bps_to_domino_and_the_rest_to_the_user(self):
        payload = fixture(USDG_QUOTE)
        deposit = across_deposit(payload)
        quote = self.parse(payload)
        fee = deposit['outputAmount'] * 35 // 10000
        self.assertEqual(deposit['recipient'], HANDLER_ROBINHOOD)
        self.assertEqual(quote['appFee'], {'amountRaw': str(fee), 'chainId': 4663, 'token': USDG, 'charged': 'destination_output'})
        self.assertEqual(int(quote['outputRaw']), deposit['outputAmount'] - fee)
        self.assertEqual(quote['deposit']['to'], SPOKE_ARBITRUM)
        # The API suggests an unlimited approval; the service builds its own exact one.
        self.assertEqual(payload['approvalTxns'][0]['data'][-64:], 'f' * 64)
        self.assertEqual(quote['approval'], {'token': USDC_ARBITRUM, 'spender': SPOKE_ARBITRUM, 'amountRaw': '100000000'})
        self.assertEqual((quote['tracking'], quote['destinationGas'], quote['etaSeconds']), ({'requestId': None}, None, 2))
        # simulationSuccess false: the provider's zero origin gas is unknown, not zero.
        self.assertEqual(quote['originGas'], {'feeRaw': None, 'usd': None})

    def test_other_recorded_erc20_routes(self):
        for name, request in (('across-quote-usdc-arbitrum-base.json', dict(origin=42161, origin_token=USDC_ARBITRUM,
                                                                             destination=8453, destination_token=USDC_BASE)),
                              ('across-quote-usdc-base-usdg-robinhood.json', dict(origin=8453, origin_token=USDC_BASE,
                                                                                  destination=4663, destination_token=USDG))):
            with self.subTest(name=name):
                quote = self.parse(fixture(name), name, **request)
                self.assertEqual(quote['appFee']['amountRaw'], {'across-quote-usdc-arbitrum-base.json': '349940'}.get(name, '349734'))

    def test_native_eth_goes_through_the_periphery_and_unwraps_before_paying_the_fee(self):
        payload = fixture(ETH_QUOTE)
        quote = self.parse(payload, ETH_QUOTE, **ETH_REQUEST)
        self.assertEqual(quote['deposit'], {'to': PERIPHERY, 'data': payload['swapTx']['data'].lower(), 'valueRaw': '50000000000000000'})
        self.assertIsNone(quote['approval'])
        self.assertEqual(quote['appFee'], {'amountRaw': '174929011197839', 'chainId': 4663, 'token': WETH_ROBINHOOD,
                                           'charged': 'destination_output'})

    def test_a_quote_without_the_app_fee_is_refused(self):
        self.refuse(fixture('across-quote-no-app-fee.json'), 'across_quote_recipient', 'across-quote-usdc-arbitrum-base.json',
                    origin=42161, origin_token=USDC_ARBITRUM, destination=8453, destination_token=USDC_BASE)

    def test_the_deposit_must_be_the_users_to_the_requested_chain_and_token(self):
        cases = {'depositor': (OTHER, 'across_quote_depositor'), 'inputAmount': (100000001, 'across_quote_deposit_amount'),
                 'destinationChainId': (8453, 'across_quote_deposit_destination'),
                 'outputToken': (OTHER, 'across_quote_deposit_output_token'),
                 'inputToken': (USDC_BASE, 'across_quote_deposit_input_token'),
                 'recipient': (OWNER, 'across_quote_recipient'),
                 'quoteTimestamp': (1, 'across_quote_timestamp'), 'fillDeadline': (2**32 - 1, 'across_quote_fill_deadline'),
                 'exclusivity': (10**6, 'across_quote_exclusivity')}
        for name, (value, code) in cases.items():
            with self.subTest(field=name):
                self.refuse(rebuild(fixture(USDG_QUOTE), **{name: value}), code)

    def test_the_transaction_must_target_the_pinned_contracts(self):
        payload = fixture(USDG_QUOTE)
        payload['swapTx']['to'] = OTHER
        self.refuse(payload, 'across_quote_deposit_target')
        payload = fixture(ETH_QUOTE)
        payload['swapTx']['to'] = SPOKE_ARBITRUM
        self.refuse(payload, 'across_quote_deposit_target', ETH_QUOTE, **ETH_REQUEST)
        self.refuse(rebuild(fixture(ETH_QUOTE), spokePool=OTHER), 'across_quote_deposit_spoke_pool', ETH_QUOTE, **ETH_REQUEST)
        self.refuse(rebuild(fixture(ETH_QUOTE), inputToken=OTHER), 'across_quote_deposit_input_token', ETH_QUOTE, **ETH_REQUEST)
        payload = fixture(ETH_QUOTE)
        payload['swapTx']['value'] = '1'
        self.refuse(payload, 'across_quote_deposit_value', ETH_QUOTE, **ETH_REQUEST)
        payload = fixture(USDG_QUOTE)
        payload['swapTx']['chainId'] = 8453
        self.refuse(payload, 'across_quote_transaction_chain')

    def test_only_plain_bridges_and_exact_input(self):
        for field, value, code in (('crossSwapType', 'anyToBridgeable', 'across_quote_route_unsupported'),
                                   ('amountType', 'minOutput', 'across_quote_trade_type'),
                                   ('inputAmount', '99', 'across_quote_input_mismatch')):
            with self.subTest(field=field):
                payload = fixture(USDG_QUOTE)
                payload[field] = value
                self.refuse(payload, code)

    def test_non_canonical_calldata_is_refused(self):
        payload = fixture(USDG_QUOTE)
        payload['swapTx']['data'] += '00' * 32
        self.refuse(payload, 'across_quote_deposit_call')
        # The short ignored suffix the API appends is accepted.
        payload = fixture(USDG_QUOTE)
        self.assertTrue(payload['swapTx']['data'].endswith('73c0de'))
        self.parse(payload)

    def tampered_message(self, edit, code, name=USDG_QUOTE, request=None, fallback=ZERO):
        payload = fixture(name)
        calls, _ = calls_of(across_deposit(payload)['message'])
        edit(calls)
        rebuild(payload, message=message_with(calls, fallback))
        self.refuse(payload, code, name, **(request or {}))

    def test_the_handler_message_admits_only_the_fee_the_drains_and_the_emitter(self):
        fee = across_deposit(fixture(USDG_QUOTE))['outputAmount'] * 35 // 10000
        self.tampered_message(lambda c: c.__setitem__(0, call(USDG, TRANSFER, [OTHER, fee])), 'across_message_fee_call')
        self.tampered_message(lambda c: c.__setitem__(1, call(HANDLER_ROBINHOOD, DRAIN, [USDG, OTHER])), 'across_message_drain_call')
        self.tampered_message(lambda c: c.insert(1, call(USDG, TRANSFER, [OTHER, 1])), 'across_message_fee_call')
        self.tampered_message(lambda c: c.insert(1, call(OTHER, EMIT, [b'x'])), 'across_message_unexpected_call')
        self.tampered_message(lambda c: c.insert(1, call(USDG, ('approve(address,uint256)', ('address', 'uint256')), [OTHER, 1])),
                              'across_message_unexpected_call')
        self.tampered_message(lambda c: c.__setitem__(1, call(HANDLER_ROBINHOOD, DRAIN, [OTHER, OWNER])), 'across_message_drain_call')
        self.tampered_message(lambda c: c[3].__setitem__(2, 1), 'across_message_emit_call')
        # Fee after the drains would revert every fill (nothing left to pay): refused.
        self.tampered_message(lambda c: c.append(c.pop(0)), 'across_message_order')
        self.tampered_message(lambda c: [c.pop(1), c.pop(1)], 'across_message_no_drain_to_user')
        self.tampered_message(lambda c: c.__setitem__(0, call(USDG, TRANSFER, [FEE, fee * 2])), 'across_quote_app_fee_not_applied')
        self.tampered_message(lambda c: c.pop(0), 'across_quote_app_fee_not_applied')
        # A fallback recipient would take the funds when a call fails.
        self.tampered_message(lambda c: None, 'across_message_fallback', fallback=OTHER)

    def test_the_native_message_must_unwrap_then_pay_then_drain(self):
        request = ETH_REQUEST
        self.tampered_message(lambda c: c.__setitem__(1, [OTHER, b'', c[1][2]]), 'across_message_unexpected_call', ETH_QUOTE, request)
        self.tampered_message(lambda c: c.pop(0), 'across_message_order', ETH_QUOTE, request)
        self.tampered_message(lambda c: c.__setitem__(0, call(HANDLER_ROBINHOOD, MAKE_CALL, [
            OTHER, bytes.fromhex(encode_call(*WITHDRAW, [0])[2:]), 0, [(WETH_ROBINHOOD, 4)]])), 'across_message_unwrap_call', ETH_QUOTE, request)
        self.tampered_message(lambda c: c.__setitem__(2, call(HANDLER_ROBINHOOD, DRAIN, [ZERO, OTHER])),
                              'across_message_drain_call', ETH_QUOTE, request)

    def test_the_reported_amounts_must_match_the_deposit(self):
        for field, value, code in (('expectedOutputAmount', '1', 'across_quote_output_amount'),
                                   ('minOutputAmount', '99000000', 'across_quote_minimum_below_slippage')):
            with self.subTest(field=field):
                payload = fixture(USDG_QUOTE)
                payload[field] = value
                self.refuse(payload, code)
        payload = fixture(USDG_QUOTE)
        payload['fees']['total']['details']['app']['amount'] = '1'
        self.refuse(payload, 'across_quote_app_fee_mismatch')
        payload = fixture(USDG_QUOTE)
        payload['approvalTxns'][0]['data'] = encode_call('approve(address,uint256)', ('address', 'uint256'), (OTHER, 1))
        self.refuse(payload, 'across_quote_approval_spender')

    def test_the_quote_request_carries_the_fee_integrator_and_user(self):
        http = FakeHttp('across', {('GET', '/swap/approval'): fixture(USDG_QUOTE)})
        provider = AcrossProvider(http, PINS, DESTINATIONS, fee_recipient=FEE, integrator_id='0xdead')
        provider.quote(provider_request(**USDG_REQUEST), now=quote_time())
        params = http.calls[0]['params']
        self.assertEqual((params['appFee'], params['appFeeRecipient'], params['integratorId']), ('0.0035', FEE, '0xdead'))
        self.assertEqual((params['depositor'], params['recipient'], params['refundAddress'], params['refundOnOrigin']),
                         (OWNER, OWNER, OWNER, 'true'))
        self.assertEqual((params['tradeType'], params['slippage']), ('exactInput', '0.0050'))


class AcrossTrackingTests(unittest.TestCase):
    def provider(self, rpc=None, record=None):
        http = FakeHttp('across', {('GET', '/deposit'): record} if record is not None else {})
        return AcrossProvider(http, PINS, DESTINATIONS, fee_recipient=FEE,
                              rpc_factory=(lambda chain: rpc) if rpc is not None else None), http

    def test_deposit_records_map_states(self):
        for status, state in (('pending', 'pending'), ('filled', 'filled'), ('expired', 'refund_pending'),
                              ('refunded', 'refunded'), ('slowFillRequested', 'pending'), ('somethingNew', 'pending')):
            with self.subTest(status=status):
                self.assertEqual(parse_deposit(across_record(USDG_QUOTE, origin=42161, status=status))['state'], state)
        ambiguous = across_record(USDG_QUOTE, origin=42161)
        ambiguous['pagination'] = {'currentIndex': 0, 'maxIndex': 1}
        with self.assertRaisesRegex(DataError, 'across_deposit_ambiguous'):
            parse_deposit(ambiguous)
        template = parse_deposit(fixture('across-deposit-template.json'))
        self.assertEqual((template['originChainId'], template['destinationChainId'], template['state']), (1, 4663, 'filled'))

    def test_an_unindexed_deposit_is_none(self):
        provider, _ = self.provider()
        provider.http.routes[('GET', '/deposit')] = ProviderError('across_not_found', 'DepositNotFoundException')
        self.assertIsNone(provider.observe('0x' + 'aa' * 32))

    def measure(self, record, rpc):
        provider, _ = self.provider(rpc)
        return provider.fee(parse_deposit(record), OWNER)

    def test_an_erc20_fee_is_proven_by_the_fill_and_the_transfer_on_the_destination(self):
        record = across_record(USDG_QUOTE, origin=42161)
        fee = int(record['deposit']['outputAmount']) * 35 // 10000
        rpc = FakeRpc(fill_receipt(record, spoke_pool=SPOKE_ROBINHOOD, fee=fee))
        self.assertEqual(self.measure(record, rpc), ('measured', fee, USDG, 'destination_receipt', None))
        self.assertEqual(rpc.calls, [FILL_HASH])

    def test_a_proof_costs_one_receipt_read_per_fill(self):
        record = across_record(USDG_QUOTE, origin=42161)
        fee = int(record['deposit']['outputAmount']) * 35 // 10000
        rpc = FakeRpc(fill_receipt(record, spoke_pool=SPOKE_ROBINHOOD, fee=fee))
        provider, _ = self.provider(rpc)
        for _ in range(3):
            self.assertEqual(provider.fee(parse_deposit(record), OWNER)[0], 'measured')
        self.assertEqual(len(rpc.calls), 1)

    def test_a_native_fee_is_proven_by_the_fill_of_this_message(self):
        record = across_record(ETH_QUOTE, origin=42161)
        rpc = FakeRpc(fill_receipt(record, spoke_pool=SPOKE_ROBINHOOD, fee=174929011197839, transfer=False))
        self.assertEqual(self.measure(record, rpc), ('measured', 174929011197839, WETH_ROBINHOOD, 'destination_receipt', None))

    def test_fills_that_do_not_prove_the_fee(self):
        record = across_record(USDG_QUOTE, origin=42161)
        fee = int(record['deposit']['outputAmount']) * 35 // 10000
        message_hash = bytes(32)
        handler = word(record['deposit']['recipient'])
        cases = {
            'across_fill_sped_up': fill_receipt(record, spoke_pool=SPOKE_ROBINHOOD, fee=fee,
                                                updated=(word(OWNER), message_hash, int(record['deposit']['outputAmount']) - 1, 0)),
            'across_fill_fee_missing': fill_receipt(record, spoke_pool=SPOKE_ROBINHOOD, fee=fee, transfer=False),
            'across_fill_mismatch': fill_receipt(record, spoke_pool=OTHER, fee=fee),
            'across_fill_receipt_invalid': fill_receipt(record, spoke_pool=SPOKE_ROBINHOOD, fee=fee, status='0x0'),
        }
        for code, receipt in cases.items():
            with self.subTest(code=code):
                self.assertEqual(self.measure(record, FakeRpc(receipt)), ('not_collected', 0, USDG, 'destination_receipt', code))
        self.assertTrue(handler)

    def test_without_a_destination_rpc_the_provider_record_is_the_evidence(self):
        record = across_record(USDG_QUOTE, origin=42161)
        fee = int(record['deposit']['outputAmount']) * 35 // 10000
        self.assertEqual(self.measure(record, None), ('measured', fee, USDG, 'provider_record', 'destination_rpc_not_configured'))
        unreachable = FakeRpc(DataError('across_rpc_unavailable'))
        self.assertEqual(self.measure(record, unreachable)[3:], ('provider_record', 'destination_rpc_unavailable'))
        lagging = FakeRpc(None)
        self.assertEqual(self.measure(record, lagging)[3:], ('provider_record', 'destination_rpc_unavailable'))

    def test_a_fill_not_yet_indexed_is_pending(self):
        record = across_record(USDG_QUOTE, origin=42161, fill=None)
        record['deposit']['status'] = 'filled'
        self.assertEqual(self.measure(record, FakeRpc(None)), ('pending', None, None, None, 'across_fill_not_indexed'))

    def test_a_deposit_without_domino_fee_collects_nothing(self):
        direct = across_record(USDG_QUOTE, origin=42161, recipient=OWNER, message='0x')
        self.assertEqual(self.measure(direct, None), ('not_collected', 0, USDG, 'provider_record', 'across_fee_absent'))
        other_fee = across_record(USDG_QUOTE, origin=42161)
        calls, _ = calls_of(other_fee['deposit']['message'])
        calls[0] = call(USDG, TRANSFER, [OTHER, 1])
        other_fee['deposit']['message'] = message_with(calls)
        self.assertEqual(self.measure(other_fee, None)[0], 'not_collected')

    def test_the_rpc_client_checks_the_chain_once_and_bounds_log_ranges(self):
        answers = []

        def transport(url, body, timeout):
            answers.append(body['method'])
            return {'jsonrpc': '2.0', 'id': 1, 'result': {'eth_chainId': '0x1237', 'eth_getTransactionReceipt': {'status': '0x1'},
                                                           'eth_getLogs': [], 'eth_blockNumber': '0x10'}[body['method']]}
        rpc = ChainRpc('https://rpc.invalid/', 4663, transport=transport)
        rpc.receipt(FILL_HASH)
        rpc.receipt(FILL_HASH)
        rpc.logs([], [], 0, 9999)
        self.assertEqual(answers, ['eth_chainId', 'eth_getTransactionReceipt', 'eth_getTransactionReceipt', 'eth_getLogs'])
        with self.assertRaisesRegex(DataError, 'across_log_range'):
            rpc.logs([], [], 0, 10000)
        with self.assertRaisesRegex(DataError, 'across_rpc_method'):
            rpc.request('eth_sendRawTransaction', ['0x'])
        wrong = ChainRpc('https://rpc.invalid/', 8453, transport=transport)
        with self.assertRaisesRegex(DataError, 'across_rpc_wrong_chain'):
            wrong.receipt(FILL_HASH)

    def test_routes_list_pinned_origins_for_the_destination_token(self):
        routes = fixture('across-routes.json')
        native = parse_routes(routes, PINS, DESTINATIONS, 4663, ZERO)
        self.assertEqual(native[42161], [{'address': ZERO, 'symbol': 'ETH', 'decimals': None}])
        usdg = parse_routes(routes, PINS, DESTINATIONS, 4663, USDG)
        self.assertIn(USDC_ARBITRUM, [row['address'] for row in usdg[42161]])
        weth = parse_routes(routes, PINS, DESTINATIONS, 4663, WETH_ROBINHOOD)
        self.assertIn(WETH_ARBITRUM, [row['address'] for row in weth[42161]])
        self.assertNotIn(4663, usdg)


class MessageFeeTests(unittest.TestCase):
    def test_canonical_encoding_is_required(self):
        message = across_deposit(fixture(USDG_QUOTE))['message']
        kwargs = dict(output_token=USDG, native_output=False, owner=OWNER, fee_recipient=FEE,
                      handler=HANDLER_ROBINHOOD, emitter=EMITTER, wrapped_native=WETH_ROBINHOOD)
        self.assertGreater(message_fee(message, **kwargs), 0)
        with self.assertRaisesRegex(DataError, 'across_message_invalid'):
            message_fee(message + '00' * 32, **kwargs)
        with self.assertRaisesRegex(DataError, 'across_message_invalid'):
            message_fee('0x', **kwargs)


if __name__ == '__main__':
    unittest.main()
