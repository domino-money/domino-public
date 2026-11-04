"""Relay (api.relay.link) for the deposit from another chain: quote, status, fee record, chains.

Quote: POST /quote/v2 with appFees [{recipient, fee: "35"}] (charged by Relay on
top of its own fees and credited to an off-chain USDC app balance that Domino
claims), refundTo = the user, explicitDeposit (approve, then depositErc20: safe
for every wallet type) and, when asked, a destination gas top-up. The key is
optional for quotes and status. Two trade types:
- exact input: EXACT_INPUT for the amount the wallet sends;
- by output (crosschain-v1 1.1.0-rc.1): EXPECTED_OUTPUT for the need grossed up
  by the user's slippage (expected_for_minimum), so that the minimum the solver
  signs, the expected amount less the slippage, covers the need. Relay then
  computes the input. Never EXACT_OUTPUT: its minimum is the expected amount, so
  any shortfall fails the fill (live answers of 6 Oct 2026).

What is checked before any step reaches the wallet (parse_quote):
- only Relay's protocol v2 deposit into the Depository pinned for the origin
  chain: depositNative(user, orderId) or approve + depositErc20(user, token,
  amount, orderId); anything else (implicit transfer, router, multicall, a
  deposit address, another chain) is refused;
- the order the solver signed pays the user's own wallet, in the requested
  token, on the requested chain, with no destination calls, and refunds only
  the user;
- the input token and chain are the request's, and the input amount is the
  same everywhere it appears: the request's in exact input; by output, the
  signed payment's, which defines it;
- by output, the order prices the amount asked and its signed minimum covers
  the need;
- the app fee Relay reports is 35 bps, in the input token: of the input in
  exact input; by output, of the net amount, (input − relayer fee) × 35 / 10035,
  as Relay computes it there (every output answer of 6 Oct 2026, to the unit).

Measurement: GET /requests/v3?id= returns appFees.quoted and appFees.actual; it
needs the API key (/requests/v2 retires on 24 Nov 2026).
"""
import re

from discovery import DataError
from crosschain_common import (APP_FEE_BPS, ZERO, Memo, address, bps_of, bytes32, chain_id, decode_call,
                               hexdata, raw, usd)
from crosschain_http import ProviderError

RELAY_API = 'https://api.relay.link'
QUOTE_SECONDS = 10
STATUS_SECONDS = 8
LIST_SECONDS = 10
DEPOSIT_NATIVE = ('depositNative(address,bytes32)', ('address', 'bytes32'))
DEPOSIT_ERC20 = ('depositErc20(address,address,uint256,bytes32)', ('address', 'address', 'uint256', 'bytes32'))
APPROVE = ('approve(address,uint256)', ('address', 'uint256'))
MAX_ETA_SECONDS = 86400
# Relay's request statuses (GET /intents/status/v3) and the service's states.
STATES = {'waiting': 'awaiting_deposit', 'depositing': 'pending', 'pending': 'pending',
          'submitted': 'pending', 'delayed': 'pending', 'success': 'filled', 'refund': 'refunded',
          'failure': 'failed'}
STATUS_TOKEN = re.compile(r'[a-z][a-z_]{0,31}')


def _unsafe(code):
    return DataError('relay_' + code)


def _same(value, expected, code):
    if value != expected:
        raise _unsafe(code)


def _currency(value, chain, token, code):
    if not isinstance(value, dict) or not isinstance(value.get('currency'), dict):
        raise _unsafe(code)
    currency = value['currency']
    if chain_id(currency.get('chainId'), 'relay_' + code) != chain or address(currency.get('address'), 'relay_' + code) != token:
        raise _unsafe(code)
    return currency


def _single_item(step, origin, owner):
    if (not isinstance(step, dict) or step.get('kind') != 'transaction' or not isinstance(step.get('items'), list)
            or len(step['items']) != 1 or not isinstance(step['items'][0], dict)):
        raise _unsafe('quote_step_shape')
    data = step['items'][0].get('data')
    if not isinstance(data, dict) or chain_id(data.get('chainId'), 'relay_quote_step_chain') != origin:
        raise _unsafe('quote_step_chain')
    if 'from' in data and address(data['from'], 'relay_quote_step_sender') != owner:
        raise _unsafe('quote_step_sender')
    value = raw(data.get('value', '0'), 'relay_quote_step_value')
    return address(data.get('to'), 'relay_quote_step_target'), hexdata(data.get('data'), 'relay_quote_step_data'), value


def expected_for_minimum(need, slippage_bps):
    """What to ask Relay for by output (EXPECTED_OUTPUT) so that the minimum its solver signs, the expected amount
    less the slippage, floor(expected × (10000 − s) / 10000), is at least `need`: ceil(need × 10000 / (10000 − s)).
    Live, 6 Oct 2026: 100,502,513 USDG asked at 50 bps signed a minimum of exactly 100,000,000, and 0.050251256281407036
    ETH one of exactly 0.05."""
    return -(-need * 10000 // (10000 - slippage_bps))


def parse_quote(payload, request, pins, *, fee_bps=APP_FEE_BPS):
    """A Relay /quote/v2 answer, checked against the request; returns the normalized candidate.

    The request is the service's provider call (crosschain_service.provider_call): exact input names `amount`; by
    output it names `need`, what must arrive, and `asked`, what Relay was asked to deliver."""
    owner, origin, destination = request['owner'], request['originChainId'], request['destinationChainId']
    token_in, token_out, by_output = request['originToken'], request['destinationToken'], request['amountKind'] == 'output'
    origin_pin, destination_pin = pins['chains'].get(origin, {}).get('relay'), pins['chains'].get(destination, {}).get('relay')
    if origin_pin is None or destination_pin is None:
        raise _unsafe('chain_not_pinned')
    depository = origin_pin['depository']
    if not isinstance(payload, dict) or not isinstance(payload.get('steps'), list) or not 1 <= len(payload['steps']) <= 2:
        raise _unsafe('quote_shape')
    request_id = bytes32(payload.get('requestId'), 'relay_quote_request_id')
    # The solver-signed order (protocol v2) is what the deposit commits to.
    protocol = payload.get('protocol', {}).get('v2') if isinstance(payload.get('protocol'), dict) else None
    if not isinstance(protocol, dict):
        raise _unsafe('quote_protocol_unsupported')
    order_id = bytes32(protocol.get('orderId'), 'relay_quote_order_id')
    payment = protocol.get('paymentDetails')
    if (not isinstance(payment, dict) or payment.get('chainId') != origin_pin['slug']
            or address(payment.get('depository'), 'relay_quote_payment') != depository
            or address(payment.get('currency'), 'relay_quote_payment') != token_in):
        raise _unsafe('quote_payment_mismatch')
    signed = raw(payment.get('amount'), 'relay_quote_payment')
    # The input: the request's amount in exact input. By output the solver computed it, and its signed payment
    # defines it; every other place it appears below must then say the same.
    amount = signed if by_output else request['amount']
    if signed != amount or signed == 0:
        raise _unsafe('quote_payment_mismatch')
    order = protocol.get('orderData')
    if not isinstance(order, dict) or not isinstance(order.get('inputs'), list) or len(order['inputs']) != 1:
        raise _unsafe('quote_order_shape')
    order_input = order['inputs'][0]
    paid = order_input.get('payment') if isinstance(order_input, dict) else None
    if (not isinstance(paid, dict) or paid.get('chainId') != origin_pin['slug']
            or address(paid.get('currency'), 'relay_quote_order_input') != token_in
            or raw(paid.get('amount'), 'relay_quote_order_input') != amount):
        raise _unsafe('quote_order_input_mismatch')
    refunds = order_input.get('refunds')
    if not isinstance(refunds, list) or not 1 <= len(refunds) <= 4:
        raise _unsafe('quote_refund_shape')
    for refund in refunds:
        if (not isinstance(refund, dict) or refund.get('chainId') not in (origin_pin['slug'], destination_pin['slug'])
                or address(refund.get('recipient'), 'relay_quote_refund_recipient') != owner):
            raise _unsafe('quote_refund_recipient')
    output = order.get('output')
    if (not isinstance(output, dict) or output.get('chainId') != destination_pin['slug']
            or output.get('calls') != [] or not isinstance(output.get('payments'), list)
            or not 1 <= len(output['payments']) <= 2):
        raise _unsafe('quote_order_output_mismatch')
    for paid_out in output['payments']:
        if not isinstance(paid_out, dict) or address(paid_out.get('recipient'), 'relay_quote_order_recipient') != owner:
            raise _unsafe('quote_order_recipient')
    first = output['payments'][0]
    if address(first.get('currency'), 'relay_quote_order_currency') != token_out:
        raise _unsafe('quote_order_currency')
    expected_out = raw(first.get('expectedAmount'), 'relay_quote_order_amount', positive=True)
    minimum_out = raw(first.get('minimumAmount'), 'relay_quote_order_amount', positive=True)
    if minimum_out > expected_out:
        raise _unsafe('quote_order_amount')
    # The signed minimum honours the slippage the user chose.
    if minimum_out < expected_out * (10000 - request['slippageBps']) // 10000 - 1:
        raise _unsafe('quote_minimum_below_slippage')
    if by_output:
        # The solver priced the amount asked, and the minimum it signed, the guarantee, covers the need.
        if expected_out != request['asked']:
            raise _unsafe('quote_output_not_requested')
        if minimum_out < request['need']:
            raise _unsafe('quote_minimum_below_request')
    # The summary the user is shown must say the same.
    details = payload.get('details')
    if not isinstance(details, dict):
        raise _unsafe('quote_details')
    for name in ('sender', 'recipient'):
        if address(details.get(name), 'relay_quote_details_' + name) != owner:
            raise _unsafe('quote_details_' + name)
    _currency(details.get('currencyIn'), origin, token_in, 'quote_input_mismatch')
    if raw(details['currencyIn'].get('amount'), 'relay_quote_input_mismatch') != amount:
        raise _unsafe('quote_input_mismatch')
    _currency(details.get('currencyOut'), destination, token_out, 'quote_output_mismatch')
    if (raw(details['currencyOut'].get('amount'), 'relay_quote_output_mismatch') != expected_out
            or raw(details['currencyOut'].get('minimumAmount'), 'relay_quote_output_mismatch') != minimum_out):
        raise _unsafe('quote_output_mismatch')
    # Steps: one deposit, plus the token approval for an ERC-20 input.
    deposit = approval = None
    for step in payload['steps']:
        if not isinstance(step, dict) or step.get('requestId') != payload['requestId']:
            raise _unsafe('quote_step_request')
        kind = step.get('id')
        target, data, value = _single_item(step, origin, owner)
        if kind == 'deposit' and deposit is None:
            if target != depository:
                raise _unsafe('quote_deposit_target')
            if token_in == ZERO:
                depositor, deposit_id = decode_call(data, *DEPOSIT_NATIVE, 'relay_quote_deposit_call')
                _same(value, amount, 'quote_deposit_value')
            else:
                depositor, token, deposited, deposit_id = decode_call(data, *DEPOSIT_ERC20, 'relay_quote_deposit_call')
                _same(token.lower(), token_in, 'quote_deposit_token')
                _same(deposited, amount, 'quote_deposit_amount')
                _same(value, 0, 'quote_deposit_value')
            _same(depositor.lower(), owner, 'quote_depositor')
            _same('0x' + deposit_id.hex(), order_id, 'quote_deposit_order')
            deposit = {'to': depository, 'data': data, 'valueRaw': str(value)}
        elif kind == 'approve' and approval is None and token_in != ZERO:
            if target != token_in:
                raise _unsafe('quote_approval_target')
            spender, allowance = decode_call(data, *APPROVE, 'relay_quote_approval_call')
            _same(spender.lower(), depository, 'quote_approval_spender')
            _same(allowance, amount, 'quote_approval_amount')
            _same(value, 0, 'quote_approval_value')
            approval = {'token': token_in, 'spender': depository, 'amountRaw': str(amount)}
        else:
            raise _unsafe('quote_step_unexpected')
    if deposit is None:
        raise _unsafe('quote_deposit_missing')
    fees = payload.get('fees')
    if not isinstance(fees, dict):
        raise _unsafe('quote_fees')
    app = fees.get('app')
    _currency(app, origin, token_in, 'quote_app_fee_currency')
    charged = raw(app.get('amount'), 'relay_quote_app_fee')
    if by_output:
        # By output Relay charges the 35 bps on the net amount, what is left of the input after its own fee and this
        # one: (input − relayer fee) × 35 / 10035. Its relayer fee is then part of the rule, so it must be there, in
        # the input token on the origin, and no more than the input. A gas top-up is in that fee, outside the base.
        relayer = fees.get('relayer')
        _currency(relayer, origin, token_in, 'quote_fee_base')
        relayer_fee = raw(relayer.get('amount'), 'relay_quote_fee_base')
        if relayer_fee > amount:
            raise _unsafe('quote_fee_base')
        expected_fee = (amount - relayer_fee) * fee_bps // (10000 + fee_bps)
    else:
        expected_fee = bps_of(amount, fee_bps)
    if expected_fee == 0 or abs(charged - expected_fee) > 1:
        raise _unsafe('quote_app_fee_not_applied')
    gas_topup = None
    if request['destinationGas']:
        topup = details.get('currencyGasTopup')
        if isinstance(topup, dict):
            _currency(topup, destination, ZERO, 'quote_gas_topup')
            gas_topup = str(raw(topup.get('amount'), 'relay_quote_gas_topup', positive=True))
    provider_fee = None
    relayer = fees.get('relayer')
    if isinstance(relayer, dict) and isinstance(relayer.get('currency'), dict):
        try:
            provider_fee = {'amountRaw': str(raw(relayer.get('amount'), 'relay_quote_provider_fee')),
                            'chainId': chain_id(relayer['currency'].get('chainId')),
                            'token': address(relayer['currency'].get('address'))}
        except DataError:
            provider_fee = None
    origin_gas = {'feeRaw': None, 'usd': None}
    gas = fees.get('gas')
    if isinstance(gas, dict) and isinstance(gas.get('currency'), dict):
        try:
            _currency(gas, origin, ZERO, 'quote_gas')
            origin_gas = {'feeRaw': str(raw(gas.get('amount'))), 'usd': usd(gas.get('amountUsd'))}
        except DataError:
            pass
    eta = details.get('timeEstimate')
    eta = eta if type(eta) is int and 0 <= eta <= MAX_ETA_SECONDS else None
    return {'provider': 'relay', 'status': 'quoted', 'reason': None, 'inputRaw': str(amount),
            'outputRaw': str(expected_out), 'minimumOutputRaw': str(minimum_out),
            'appFee': {'amountRaw': str(charged), 'chainId': origin, 'token': token_in, 'charged': 'origin_input'},
            'providerFee': provider_fee, 'originGas': origin_gas,
            'destinationGas': None if gas_topup is None else {'deliveredRaw': gas_topup},
            'etaSeconds': eta, 'refund': {'chainId': origin, 'recipient': owner},
            'tracking': {'requestId': request_id},
            'approval': approval, 'deposit': deposit}


def parse_status(payload):
    """GET /intents/status/v3 → the service's state; transaction hashes as reported."""
    if not isinstance(payload, dict) or not isinstance(payload.get('status'), str) or not STATUS_TOKEN.fullmatch(payload['status']):
        raise DataError('relay_status_invalid')
    status = payload['status']
    state = STATES.get(status, 'pending')

    def hashes(name):
        values = payload.get(name, [])
        if not isinstance(values, list) or len(values) > 16:
            raise DataError('relay_status_invalid')
        return [bytes32(value, 'relay_status_invalid') for value in values]

    refund_fail = payload.get('refundFailReason')
    if state == 'failed' and isinstance(refund_fail, str) and refund_fail not in ('N/A', ''):
        state = 'refund_failed'
    return {'providerStatus': status, 'state': state, 'inTxHashes': hashes('inTxHashes'), 'txHashes': hashes('txHashes')}


def parse_request_record(payload, request_id, fee_recipient):
    """GET /requests/v3?id= → the user, and the app fee Relay actually collected for Domino's recipient."""
    if not isinstance(payload, dict) or not isinstance(payload.get('requests'), list):
        raise DataError('relay_record_invalid')
    matches = [row for row in payload['requests'] if isinstance(row, dict) and isinstance(row.get('id'), str)
               and row['id'].lower() == request_id]
    if not matches:
        return None
    if len(matches) != 1:
        raise DataError('relay_record_invalid')
    row = matches[0]
    data = row.get('data') if isinstance(row.get('data'), dict) else {}
    fees = data.get('appFees') if isinstance(data.get('appFees'), dict) else {}
    currency = fees.get('currency') if isinstance(fees.get('currency'), dict) else None

    def ours(name):
        total, seen = 0, False
        for entry in fees.get(name) or []:
            if not isinstance(entry, dict) or not isinstance(entry.get('recipient'), str):
                continue
            if entry['recipient'].lower() == fee_recipient and entry.get('amount') is not None:
                total += raw(entry['amount'], 'relay_record_invalid')
                seen = True
        return total if seen else None

    return {'user': address(row.get('user'), 'relay_record_invalid') if row.get('user') else None,
            'status': row.get('status') if isinstance(row.get('status'), str) else None,
            'quotedRaw': ours('quoted'), 'actualRaw': ours('actual'),
            'currency': None if currency is None else {'chainId': chain_id(currency.get('chainId'), 'relay_record_invalid'),
                                                      'token': address(currency.get('address'), 'relay_record_invalid')}}


def parse_chains(payload, pins):
    """GET /chains → per pinned origin chain, the solver currencies a plain deposit can start from.

    A chain whose live Depository differs from the pin is dropped: the pin is
    reviewed, the listing is not.
    """
    if not isinstance(payload, dict) or not isinstance(payload.get('chains'), list):
        raise DataError('relay_chains_invalid')
    result = {}
    for chain in payload['chains']:
        if not isinstance(chain, dict) or chain.get('vmType') != 'evm' or chain.get('disabled') is not False:
            continue
        if chain.get('depositEnabled') is not True:
            continue
        try:
            cid = chain_id(chain.get('id'))
        except DataError:
            continue
        pin = pins['chains'].get(cid, {}).get('relay')
        live = (chain.get('protocol') or {}).get('v2') if isinstance(chain.get('protocol'), dict) else None
        if pin is None or not isinstance(live, dict) or not isinstance(live.get('depository'), str):
            continue
        if live['depository'].lower() != pin['depository'] or live.get('chainId') != pin['slug']:
            continue
        tokens = []
        for currency in chain.get('solverCurrencies') or []:
            if not isinstance(currency, dict):
                continue
            try:
                token = address(currency.get('address'))
            except DataError:
                continue
            tokens.append({'address': token, 'symbol': currency.get('symbol'),
                           'decimals': currency.get('decimals') if type(currency.get('decimals')) is int else None})
        result[cid] = tokens
    return result


class RelayProvider:
    def __init__(self, http, pins, *, fee_recipient, fee_bps=APP_FEE_BPS, has_key=False, timeout=QUOTE_SECONDS):
        self.http, self.pins, self.fee_recipient, self.fee_bps, self.has_key = http, pins, fee_recipient, fee_bps, has_key
        self.quote_seconds, self.read_seconds = timeout, min(timeout, STATUS_SECONDS)
        self.records = Memo()

    def quote(self, request):
        # By output, the need grossed up by the slippage (expected_for_minimum); never EXACT_OUTPUT.
        output = request['amountKind'] == 'output'
        body = {'user': request['owner'], 'recipient': request['owner'], 'refundTo': request['owner'],
                'originChainId': request['originChainId'], 'destinationChainId': request['destinationChainId'],
                'originCurrency': request['originToken'], 'destinationCurrency': request['destinationToken'],
                'amount': str(request['asked'] if output else request['amount']),
                'tradeType': 'EXPECTED_OUTPUT' if output else 'EXACT_INPUT',
                'appFees': [{'recipient': self.fee_recipient, 'fee': str(self.fee_bps)}],
                'explicitDeposit': True, 'slippageTolerance': str(request['slippageBps'])}
        if request['destinationGas']:
            body['topupGas'] = True
        payload = self.http.post('/quote/v2', body, timeout=self.quote_seconds)
        return parse_quote(payload, request, self.pins, fee_bps=self.fee_bps)

    def observe(self, request_id):
        payload = self.http.get('/intents/status/v3', {'requestId': request_id}, timeout=self.read_seconds, retry=True,
                                status=True)
        return parse_status(payload)

    def record(self, request_id):
        """The request as Relay recorded it, with app fees; None without a key (the endpoint requires one)."""
        if not self.has_key:
            return None
        settled = self.records.get(request_id)
        if settled is not None:
            return settled
        try:
            payload = self.http.get('/requests/v3', {'id': request_id}, timeout=self.read_seconds, retry=True, status=True)
        except ProviderError as error:
            if str(error) == 'relay_not_found':
                return None
            raise
        row = parse_request_record(payload, request_id, self.fee_recipient)
        # A final status with the collected fee reported will not change: ask Relay once.
        if row is not None and row['status'] in ('success', 'refund', 'failure') and row['actualRaw'] is not None:
            self.records.put(request_id, row)
        return row

    def chains(self):
        return parse_chains(self.http.get('/chains', None, timeout=max(self.read_seconds, LIST_SECONDS), retry=True), self.pins)

    def app_fee_balances(self, wallet):
        payload = self.http.get(f'/app-fees/{address(wallet)}/balances', None, timeout=self.read_seconds, retry=True)
        if not isinstance(payload, dict) or not isinstance(payload.get('balances'), list):
            raise DataError('relay_balances_invalid')
        rows = []
        for entry in payload['balances']:
            currency = entry.get('currency') if isinstance(entry, dict) else None
            if not isinstance(currency, dict):
                raise DataError('relay_balances_invalid')
            rows.append({'chainId': chain_id(currency.get('chainId'), 'relay_balances_invalid'),
                         'token': address(currency.get('address'), 'relay_balances_invalid'),
                         'symbol': currency.get('symbol') if isinstance(currency.get('symbol'), str) else None,
                         'decimals': currency.get('decimals') if type(currency.get('decimals')) is int else None,
                         'amountRaw': str(raw(entry.get('amount'), 'relay_balances_invalid')),
                         'usd': usd(entry.get('amountUsd'))})
        return rows
