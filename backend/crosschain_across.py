"""Across (app.across.to/api) for the deposit from another chain: quote, deposit record, routes, fee proof.

Quote: GET /swap/approval, exactInput, depositor = recipient = refundAddress =
the user, refundOnOrigin, appFee 0.0035 with Domino's appFeeRecipient and, when
configured, the 2-byte integratorId and the Bearer key (production requires
both; neither may reach the browser).

With an app fee the Swap API does not raise the input. It sends the deposit to
Across' MulticallHandler on the destination with a message that transfers a
fixed 0.35% of the deposit's output to the fee recipient and drains the rest to
the user (verified 1 Oct 2026). So "the recipient is the user" means, for
Across: the deposit's recipient is a MulticallHandler pinned for that chain, and
every call in its message is one of
- the fee transfer to Domino's recipient (ERC-20 transfer, or a plain value
  transfer after unwrapping WETH for a native output),
- drainLeftoverTokens(output token, user),
- the WETH unwrap for a native output,
- AcrossEventEmitter.emitData (integrator metadata),
with fallbackRecipient zero, so a failing call reverts the whole fill rather than
sending funds elsewhere. Any other call, target or recipient refuses the quote.

Only plain bridges (crossSwapType bridgeableToBridgeable) are accepted: an
origin swap goes through periphery calls into arbitrary routers, which this
service does not admit. Across delivers no destination gas.

Fee proof: on the destination, the fill's FilledRelay event (SpokePool pinned
for that chain) must carry the deposit's message hash with no speed-up, and an
ERC-20 fee must appear as a Transfer from the handler to the fee recipient.
"""
import re

from eth_abi import decode, encode
from eth_hash.auto import keccak

from discovery import DataError, json_http, quantity
from crosschain_common import (APP_FEE_BPS, ZERO, Memo, address, bps_of, bytes32, chain_id, decode_call,
                               hexdata, raw, selector, usd, word_address)
from crosschain_http import ProviderError

ACROSS_API = 'https://app.across.to/api'
QUOTE_SECONDS = 10
STATUS_SECONDS = 8
LIST_SECONDS = 10
RPC_SECONDS = 6
MAX_ETA_SECONDS = 86400
# SpokePool limits read on 1 Oct 2026 on Arbitrum, Base and Robinhood.
QUOTE_TIME_BUFFER = 3600
FILL_DEADLINE_BUFFER = 21600
MAX_EXCLUSIVITY_SECONDS = 3600
DEPOSIT = ('deposit(bytes32,bytes32,bytes32,bytes32,uint256,uint256,uint256,bytes32,uint32,uint32,uint32,bytes)',
           ('bytes32', 'bytes32', 'bytes32', 'bytes32', 'uint256', 'uint256', 'uint256', 'bytes32',
            'uint32', 'uint32', 'uint32', 'bytes'))
DEPOSIT_NATIVE = ('depositNative(address,address,bytes32,address,uint256,bytes32,uint256,uint256,bytes32,uint32,uint32,uint32,bytes)',
                  ('address', 'address', 'bytes32', 'address', 'uint256', 'bytes32', 'uint256', 'uint256', 'bytes32',
                   'uint32', 'uint32', 'uint32', 'bytes'))
APPROVE = ('approve(address,uint256)', ('address', 'uint256'))
TRANSFER = ('transfer(address,uint256)', ('address', 'uint256'))
DRAIN = ('drainLeftoverTokens(address,address)', ('address', 'address'))
MAKE_CALL = ('makeCallWithBalance(address,bytes,uint256,(address,uint256)[])',
             ('address', 'bytes', 'uint256', '(address,uint256)[]'))
WITHDRAW = ('withdraw(uint256)', ('uint256',))
EMIT = ('emitData(bytes)', ('bytes',))
INSTRUCTIONS = '((address,bytes,uint256)[],address)'
MAX_MESSAGE_CALLS = 8
# eth_getLogs range per call; hosted RPC providers bill per call and cap the range.
MAX_LOG_BLOCKS = 10_000
MAX_EMIT_BYTES = 4096
FILLED_RELAY = keccak(b'FilledRelay(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint32,uint32,bytes32,'
                      b'bytes32,bytes32,bytes32,bytes32,(bytes32,bytes32,uint256,uint8))')
FILLED_RELAY_DATA = ['bytes32', 'bytes32', 'uint256', 'uint256', 'uint256', 'uint32', 'uint32', 'bytes32', 'bytes32',
                     'bytes32', 'bytes32', '(bytes32,bytes32,uint256,uint8)']
ERC20_TRANSFER = keccak(b'Transfer(address,address,uint256)')
STATES = {'pending': 'pending', 'filled': 'filled', 'expired': 'refund_pending', 'refunded': 'refunded',
          'slowFillRequested': 'pending'}
STATUS_TOKEN = re.compile(r'[A-Za-z][A-Za-z_]{0,31}')


def _unsafe(code):
    return DataError('across_' + code)


def _same(value, expected, code):
    if value != expected:
        raise _unsafe(code)


def _token(value, chain, token, code):
    if (not isinstance(value, dict) or chain_id(value.get('chainId'), 'across_' + code) != chain
            or address(value.get('address'), 'across_' + code) != token):
        raise _unsafe(code)


def message_fee(message, *, output_token, native_output, owner, fee_recipient, handler, emitter, wrapped_native):
    """The fee a MulticallHandler message pays Domino, after admitting only the expected calls; 0 for no fee call."""
    body = bytes.fromhex(hexdata(message, 'across_message_invalid')[2:])
    try:
        (calls, fallback), = decode([INSTRUCTIONS], body)
        canonical = encode([INSTRUCTIONS], [(calls, fallback)])
    except Exception:
        raise _unsafe('message_invalid') from None
    if canonical != body or not 1 <= len(calls) <= MAX_MESSAGE_CALLS:
        raise _unsafe('message_invalid')
    if fallback.lower() != ZERO:
        raise _unsafe('message_fallback')
    fee = fee_index = unwrap_index = None
    drains = []
    drainable = {ZERO, wrapped_native} if native_output else {output_token}
    for index, (target, data, value) in enumerate(calls):
        target, data = target.lower(), '0x' + data.hex()
        if not native_output and target == output_token and data.startswith(selector(TRANSFER[0])):
            to, amount = decode_call(data, *TRANSFER, 'across_message_fee_call')
            if fee is not None or to.lower() != fee_recipient or value != 0:
                raise _unsafe('message_fee_call')
            fee, fee_index = amount, index
        elif native_output and target == fee_recipient and data == '0x' and value > 0:
            if fee is not None:
                raise _unsafe('message_fee_call')
            fee, fee_index = value, index
        elif target == handler and data.startswith(selector(DRAIN[0])):
            token, destination = decode_call(data, *DRAIN, 'across_message_drain_call')
            if token.lower() not in drainable or destination.lower() != owner or value != 0:
                raise _unsafe('message_drain_call')
            drains.append((index, token.lower()))
        elif native_output and target == handler and data.startswith(selector(MAKE_CALL[0])):
            inner_target, inner, inner_value, replacements = decode_call(data, *MAKE_CALL, 'across_message_unwrap_call')
            if (unwrap_index is not None or inner_target.lower() != wrapped_native or inner_value != 0 or value != 0
                    or [(token.lower(), offset) for token, offset in replacements] != [(wrapped_native, 4)]):
                raise _unsafe('message_unwrap_call')
            decode_call('0x' + inner.hex(), *WITHDRAW, 'across_message_unwrap_call')
            unwrap_index = index
        elif target == emitter and data.startswith(selector(EMIT[0])):
            payload, = decode_call(data, *EMIT, 'across_message_emit_call')
            if value != 0 or len(payload) > MAX_EMIT_BYTES:
                raise _unsafe('message_emit_call')
        else:
            raise _unsafe('message_unexpected_call')
    delivered = ZERO if native_output else output_token
    if not any(token == delivered for _, token in drains):
        raise _unsafe('message_no_drain_to_user')
    if fee is None:
        return 0
    # The fee leaves before the drains empty the handler; the unwrap comes first.
    if any(index < fee_index for index, _ in drains) or (native_output and (unwrap_index is None or unwrap_index > fee_index)):
        raise _unsafe('message_order')
    return fee


def classify_message(message, *, output_token, owner, fee_recipient, handler, emitter, wrapped_native):
    """(fee, native_output) for a recorded deposit message: an ERC-20 delivery, or a native one through WETH."""
    try:
        return message_fee(message, output_token=output_token, native_output=False, owner=owner,
                           fee_recipient=fee_recipient, handler=handler, emitter=emitter,
                           wrapped_native=wrapped_native), False
    except DataError:
        if output_token != wrapped_native:
            raise
    return message_fee(message, output_token=output_token, native_output=True, owner=owner,
                       fee_recipient=fee_recipient, handler=handler, emitter=emitter,
                       wrapped_native=wrapped_native), True


def _deposit_args(swap, request, origin_pin, wrapped_out):
    owner, origin, token_in, amount = request['owner'], request['originChainId'], request['originToken'], request['amount']
    if not isinstance(swap, dict) or swap.get('ecosystem', 'evm') != 'evm':
        raise _unsafe('quote_transaction_shape')
    if chain_id(swap.get('chainId'), 'across_quote_transaction_chain') != origin:
        raise _unsafe('quote_transaction_chain')
    target, data = address(swap.get('to'), 'across_quote_transaction_target'), hexdata(swap.get('data'), 'across_quote_transaction_data')
    value = raw(swap.get('value', '0'), 'across_quote_transaction_value')
    if token_in == ZERO:
        periphery, wrapped_in = origin_pin.get('spokePoolPeriphery'), origin_pin.get('wrappedNative')
        if periphery is None or wrapped_in is None or target != periphery:
            raise _unsafe('quote_deposit_target')
        (spoke, depositor, recipient, input_token, input_amount, output_token, output_amount, destination,
         _relayer, quoted_at, deadline, exclusivity, message) = decode_call(data, *DEPOSIT_NATIVE, 'across_quote_deposit_call')
        _same(spoke.lower(), origin_pin['spokePool'], 'quote_deposit_spoke_pool')
        _same(input_token.lower(), wrapped_in, 'quote_deposit_input_token')
        _same(value, amount, 'quote_deposit_value')
        depositor = depositor.lower()
    else:
        if target != origin_pin['spokePool']:
            raise _unsafe('quote_deposit_target')
        (depositor, recipient, input_token, output_token, input_amount, output_amount, destination,
         _relayer, quoted_at, deadline, exclusivity, message) = decode_call(data, *DEPOSIT, 'across_quote_deposit_call')
        depositor = word_address(depositor, 'across_quote_depositor')
        _same(word_address(input_token, 'across_quote_deposit_input_token'), token_in, 'quote_deposit_input_token')
        _same(value, 0, 'quote_deposit_value')
    _same(depositor, owner, 'quote_depositor')
    _same(input_amount, amount, 'quote_deposit_amount')
    _same(destination, request['destinationChainId'], 'quote_deposit_destination')
    _same(word_address(output_token, 'across_quote_deposit_output_token'), wrapped_out, 'quote_deposit_output_token')
    if output_amount <= 0:
        raise _unsafe('quote_deposit_output')
    return {'to': target, 'data': data, 'value': value, 'recipient': word_address(recipient, 'across_quote_recipient'),
            'outputAmount': output_amount, 'quotedAt': quoted_at, 'fillDeadline': deadline,
            'exclusivity': exclusivity, 'message': '0x' + message.hex()}


def parse_quote(payload, request, pins, destinations, *, fee_recipient, now, fee_bps=APP_FEE_BPS):
    """An Across /swap/approval answer, checked against the request; returns the normalized candidate."""
    owner, origin, destination = request['owner'], request['originChainId'], request['destinationChainId']
    token_in, token_out, amount = request['originToken'], request['destinationToken'], request['amount']
    origin_pin = pins['chains'].get(origin, {}).get('across')
    destination_pin = pins['destinations'].get(destination, {}).get('across')
    if origin_pin is None or destination_pin is None or destination not in destinations:
        raise _unsafe('chain_not_pinned')
    native_output = token_out == ZERO
    wrapped_out = destinations[destination]['wrappedNative'] if native_output else token_out
    if not isinstance(payload, dict):
        raise _unsafe('quote_shape')
    if payload.get('crossSwapType') != 'bridgeableToBridgeable':
        raise _unsafe('quote_route_unsupported')
    if payload.get('amountType') != 'exactInput':
        raise _unsafe('quote_trade_type')
    _token(payload.get('inputToken'), origin, token_in, 'quote_input_mismatch')
    _token(payload.get('outputToken'), destination, token_out, 'quote_output_mismatch')
    if raw(payload.get('inputAmount'), 'across_quote_input_mismatch') != amount or (
            payload.get('maxInputAmount') is not None and raw(payload['maxInputAmount'], 'across_quote_input_mismatch') != amount):
        raise _unsafe('quote_input_mismatch')
    deposit = _deposit_args(payload.get('swapTx'), request, origin_pin, wrapped_out)
    if not now - QUOTE_TIME_BUFFER <= deposit['quotedAt'] <= now + 300:
        raise _unsafe('quote_timestamp')
    if not now < deposit['fillDeadline'] <= now + FILL_DEADLINE_BUFFER:
        raise _unsafe('quote_fill_deadline')
    # An exclusivity parameter is an offset from the deposit (as quoted) or an absolute time.
    if deposit['exclusivity'] > MAX_EXCLUSIVITY_SECONDS and not now <= deposit['exclusivity'] <= now + MAX_EXCLUSIVITY_SECONDS:
        raise _unsafe('quote_exclusivity')
    expiry = payload.get('quoteExpiryTimestamp')
    if expiry is not None and raw(expiry, 'across_quote_expiry') <= now:
        raise _unsafe('quote_expired')
    # The deposit pays a pinned MulticallHandler whose message sends the rest to the user.
    handler = deposit['recipient']
    if handler not in destination_pin['multicallHandlers']:
        raise _unsafe('quote_recipient')
    fee = message_fee(deposit['message'], output_token=wrapped_out, native_output=native_output, owner=owner,
                      fee_recipient=fee_recipient, handler=handler, emitter=destination_pin['eventEmitter'],
                      wrapped_native=destinations[destination]['wrappedNative'])
    expected_fee = bps_of(deposit['outputAmount'], fee_bps)
    if fee == 0 or expected_fee == 0 or abs(fee - expected_fee) > 1:
        raise _unsafe('quote_app_fee_not_applied')
    delivered = deposit['outputAmount'] - fee
    expected_out = raw(payload.get('expectedOutputAmount'), 'across_quote_output_amount', positive=True)
    minimum_out = raw(payload.get('minOutputAmount'), 'across_quote_output_amount', positive=True)
    if expected_out != delivered or minimum_out > expected_out:
        raise _unsafe('quote_output_amount')
    if minimum_out < expected_out * (10000 - request['slippageBps']) // 10000 - 1:
        raise _unsafe('quote_minimum_below_slippage')
    fees = payload.get('fees') if isinstance(payload.get('fees'), dict) else {}
    details = ((fees.get('total') or {}).get('details') or {}) if isinstance(fees.get('total'), dict) else {}
    app = details.get('app')
    if not isinstance(app, dict):
        raise _unsafe('quote_app_fee_not_applied')
    _token(app.get('token'), destination, wrapped_out, 'quote_app_fee_currency')
    if raw(app.get('amount'), 'across_quote_app_fee') != fee:
        raise _unsafe('quote_app_fee_mismatch')
    # Approvals the API suggests may only name the pinned SpokePool; the service builds its own exact one.
    approvals = payload.get('approvalTxns') or []
    if not isinstance(approvals, list) or (token_in == ZERO and approvals) or len(approvals) > 2:
        raise _unsafe('quote_approval_shape')
    for suggestion in approvals:
        if (not isinstance(suggestion, dict) or chain_id(suggestion.get('chainId'), 'across_quote_approval') != origin
                or address(suggestion.get('to'), 'across_quote_approval') != token_in):
            raise _unsafe('quote_approval_target')
        spender, _allowance = decode_call(suggestion.get('data'), *APPROVE, 'across_quote_approval_call')
        if spender.lower() != origin_pin['spokePool']:
            raise _unsafe('quote_approval_spender')
    provider_fee = None
    bridge = details.get('bridge')
    if isinstance(bridge, dict) and isinstance(bridge.get('token'), dict):
        try:
            provider_fee = {'amountRaw': str(raw(bridge.get('amount'))), 'chainId': chain_id(bridge['token'].get('chainId')),
                            'token': address(bridge['token'].get('address'))}
        except DataError:
            provider_fee = None
    origin_gas = {'feeRaw': None, 'usd': None}
    gas = fees.get('originGas')
    if isinstance(gas, dict) and payload['swapTx'].get('simulationSuccess') is True:
        try:
            _token(gas.get('token'), origin, ZERO, 'quote_gas')
            fee_raw = raw(gas.get('amount'))
            if fee_raw > 0:
                origin_gas = {'feeRaw': str(fee_raw), 'usd': usd(gas.get('amountUsd'))}
        except DataError:
            pass
    eta = payload.get('expectedFillTime')
    eta = eta if type(eta) is int and 0 <= eta <= MAX_ETA_SECONDS else None
    approval = None if token_in == ZERO else {'token': token_in, 'spender': origin_pin['spokePool'], 'amountRaw': str(amount)}
    return {'provider': 'across', 'status': 'quoted', 'reason': None,
            'outputRaw': str(expected_out), 'minimumOutputRaw': str(minimum_out),
            'appFee': {'amountRaw': str(fee), 'chainId': destination, 'token': wrapped_out, 'charged': 'destination_output'},
            'providerFee': provider_fee, 'originGas': origin_gas, 'destinationGas': None,
            'etaSeconds': eta, 'refund': {'chainId': origin, 'recipient': owner},
            'tracking': {'requestId': None},
            'approval': approval, 'deposit': {'to': deposit['to'], 'data': deposit['data'], 'valueRaw': str(deposit['value'])}}


def _optional_hash(record, *names):
    for name in names:
        value = record.get(name)
        if value is not None:
            return bytes32(value, 'across_deposit_invalid')
    return None


def parse_deposit(payload):
    """GET /deposit?depositTxnRef= → the deposit as Across indexed it."""
    if not isinstance(payload, dict) or not isinstance(payload.get('deposit'), dict):
        raise DataError('across_deposit_invalid')
    pagination = payload.get('pagination')
    if isinstance(pagination, dict) and pagination.get('maxIndex') not in (None, 0):
        raise DataError('across_deposit_ambiguous')
    record = payload['deposit']
    status = record.get('status')
    if not isinstance(status, str) or not STATUS_TOKEN.fullmatch(status):
        raise DataError('across_deposit_invalid')
    message = record.get('message') or '0x'
    return {'providerStatus': status, 'state': STATES.get(status, 'pending'),
            'depositId': raw(record.get('depositId'), 'across_deposit_invalid'),
            'originChainId': chain_id(record.get('originChainId'), 'across_deposit_invalid'),
            'destinationChainId': chain_id(record.get('destinationChainId'), 'across_deposit_invalid'),
            'depositor': address(record.get('depositor'), 'across_deposit_invalid'),
            'recipient': address(record.get('recipient'), 'across_deposit_invalid'),
            'outputToken': address(record.get('outputToken'), 'across_deposit_invalid'),
            'outputAmount': raw(record.get('outputAmount'), 'across_deposit_invalid'),
            'message': hexdata(message, 'across_deposit_invalid'),
            'depositTxHash': _optional_hash(record, 'depositTxnRef', 'depositTxHash'),
            'fillTxHash': _optional_hash(record, 'fillTxnRef', 'fillTx'),
            'refundTxHash': _optional_hash(record, 'depositRefundTxnRef', 'depositRefundTxHash')}


def parse_routes(payload, pins, destinations, destination, destination_token):
    """GET /available-routes → per pinned origin chain, the origin tokens Across bridges to this destination token."""
    if not isinstance(payload, list):
        raise DataError('across_routes_invalid')
    wrapped = destinations[destination]['wrappedNative']
    native = destination_token == ZERO
    target = wrapped if native else destination_token
    result = {}
    for route in payload:
        if not isinstance(route, dict):
            continue
        try:
            if chain_id(route.get('destinationChainId')) != destination or address(route.get('destinationToken')) != target:
                continue
            origin = chain_id(route.get('originChainId'))
            token = address(route.get('originToken'))
        except DataError:
            continue
        if bool(route.get('isNative')) != native or pins['chains'].get(origin, {}).get('across') is None:
            continue
        symbol = route.get('originTokenSymbol')
        if native:
            if pins['chains'][origin]['across'].get('wrappedNative') != token:
                continue
            token, symbol = ZERO, pins['chains'][origin]['nativeSymbol']
        result.setdefault(origin, []).append({'address': token, 'symbol': symbol, 'decimals': None})
    return result


class ChainRpc:
    """Read-only JSON-RPC to one destination chain for fee proofs: chain id, receipts, block number and bounded logs."""
    METHODS = frozenset({'eth_chainId', 'eth_getTransactionReceipt', 'eth_blockNumber', 'eth_getLogs'})

    def __init__(self, url, expected_chain, *, transport=json_http):
        self.url, self.expected_chain, self.transport, self.checked = url, expected_chain, transport, False

    def request(self, method, params):
        if method not in self.METHODS:
            raise DataError('across_rpc_method')
        try:
            reply = self.transport(self.url, {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params},
                                   timeout=RPC_SECONDS)
        except DataError:
            raise DataError('across_rpc_unavailable') from None
        if not isinstance(reply, dict) or 'error' in reply or 'result' not in reply:
            raise DataError('across_rpc_unavailable')
        return reply['result']

    def _check_chain(self):
        if not self.checked:
            if quantity(self.request('eth_chainId', [])) != self.expected_chain:
                raise DataError('across_rpc_wrong_chain')
            self.checked = True

    def receipt(self, transaction_hash):
        self._check_chain()
        return self.request('eth_getTransactionReceipt', [transaction_hash])

    def block_number(self):
        self._check_chain()
        return quantity(self.request('eth_blockNumber', []))

    def logs(self, address_list, topics, from_block, to_block):
        """One eth_getLogs over at most MAX_LOG_BLOCKS blocks (hosted providers cap the range)."""
        if not 0 <= from_block <= to_block or to_block - from_block + 1 > MAX_LOG_BLOCKS:
            raise DataError('across_log_range')
        self._check_chain()
        query = {'topics': topics, 'fromBlock': hex(from_block), 'toBlock': hex(to_block)}
        if address_list:
            query['address'] = list(address_list)
        result = self.request('eth_getLogs', [query])
        if not isinstance(result, list):
            raise DataError('across_rpc_unavailable')
        return result



class EndpointsChainRpc(ChainRpc):
    """ChainRpc through a chain's V2 RPC registry (v2_rpc.ChainEndpoints, F6): its hosted endpoints in order, with
    their batch, log-range and pace limits. An endpoint that fails is cooled down by the registry and the next one
    answers. Like every F6 client it never asks eth_chainId: each endpoint proved its chain when it was provisioned
    (`v2_rpc check`), so only the registry's own chain is checked here."""

    def __init__(self, endpoints, expected_chain):
        if endpoints.chain.chainId != expected_chain:
            raise DataError('across_rpc_wrong_chain')
        super().__init__(None, expected_chain)
        self.endpoints, self.checked = endpoints, True

    def request(self, method, params):
        if method not in self.METHODS:
            raise DataError('across_rpc_method')
        try:
            candidates = self.endpoints.usable()
        except DataError:
            raise DataError('across_rpc_unavailable') from None
        for endpoint in candidates:
            try:
                reply = self.endpoints(endpoint.url, {'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params})
            except DataError:
                continue
            if isinstance(reply, dict) and 'error' not in reply and 'result' in reply:
                return reply['result']
        raise DataError('across_rpc_unavailable')


# The destinations with hosted RPC in the V2 chain RPC file. Robinhood is the listener's own node (--rpc-config),
# which that file can never name (v2_rpc).
HOSTED_DESTINATIONS = (8453, 42161)


def destination_endpoints(chain_rpc_file, registry=None):
    """{chain id: ChainEndpoints} for the hosted destinations the V2 chain RPC file names; none without the file.
    The file and every credential it names are checked whole (v2_rpc), so a broken one stops the caller."""
    if chain_rpc_file is None:
        return {}
    from v2_chains import default_registry
    from v2_rpc import configured_endpoints, load_chain_rpc_config
    registry = registry or default_registry()
    config = load_chain_rpc_config(chain_rpc_file, registry)
    result = {}
    for destination in HOSTED_DESTINATIONS:
        chain = registry.chain(destination)
        if chain.key in config.chains:
            result[destination] = configured_endpoints(chain, chain_rpc_config=config)
    return result

def receipt_fee(receipt, deposit, *, spoke_pool, fee_recipient, fee, native_output):
    """Prove the fill on the destination: FilledRelay with this message, no speed-up, and the ERC-20 fee transfer."""
    if receipt is None:
        # Not yet visible to this endpoint (a lagging node); asking again later is cheap.
        raise DataError('across_fill_receipt_missing')
    if not isinstance(receipt, dict) or receipt.get('status') != '0x1' or not isinstance(receipt.get('logs'), list):
        raise DataError('across_fill_receipt_invalid')
    message_hash = keccak(bytes.fromhex(deposit['message'][2:]))
    filled = transferred = False
    for log in receipt['logs']:
        if not isinstance(log, dict) or not isinstance(log.get('topics'), list) or not log['topics']:
            continue
        topics = [bytes32(topic, 'across_fill_receipt_invalid') for topic in log['topics']]
        source = address(log.get('address'), 'across_fill_receipt_invalid')
        data = bytes.fromhex(hexdata(log.get('data', '0x'), 'across_fill_receipt_invalid', maximum=65536)[2:])
        if source == spoke_pool and topics[0] == '0x' + FILLED_RELAY.hex() and len(topics) == 4:
            if int(topics[1], 16) != deposit['originChainId'] or int(topics[2], 16) != deposit['depositId']:
                continue
            try:
                (_in, output_token, _in_amount, output_amount, _repayment, _deadline, _exclusive_until, _exclusive,
                 depositor, recipient, hashed, (updated_recipient, updated_hash, updated_amount, _kind)) = decode(FILLED_RELAY_DATA, data)
            except Exception:
                raise DataError('across_fill_receipt_invalid') from None
            if (word_address(depositor, 'across_fill_receipt_invalid') != deposit['depositor']
                    or word_address(recipient, 'across_fill_receipt_invalid') != deposit['recipient']
                    or word_address(output_token, 'across_fill_receipt_invalid') != deposit['outputToken']
                    or output_amount != deposit['outputAmount'] or hashed != message_hash):
                raise DataError('across_fill_mismatch')
            if updated_hash != hashed or updated_recipient != recipient or updated_amount != output_amount:
                raise DataError('across_fill_sped_up')
            filled = True
        elif (not native_output and source == deposit['outputToken'] and topics[0] == '0x' + ERC20_TRANSFER.hex()
                and len(topics) == 3 and int(topics[1], 16) == int(deposit['recipient'], 16)
                and int(topics[2], 16) == int(fee_recipient, 16) and len(data) == 32
                and int.from_bytes(data, 'big') == fee):
            transferred = True
    if not filled:
        raise DataError('across_fill_mismatch')
    if not native_output and not transferred:
        raise DataError('across_fill_fee_missing')
    return fee


class AcrossProvider:
    def __init__(self, http, pins, destinations, *, fee_recipient, fee_bps=APP_FEE_BPS, integrator_id=None,
                 rpc_factory=None, timeout=QUOTE_SECONDS):
        self.http, self.pins, self.destinations = http, pins, destinations
        self.quote_seconds, self.read_seconds = timeout, min(timeout, STATUS_SECONDS)
        self.fee_recipient, self.fee_bps, self.integrator_id = fee_recipient, fee_bps, integrator_id
        # rpc_factory(chainId) -> ChainRpc or None. Each fill is proven with one receipt read,
        # once: destination RPC calls are billed, and a settled fill cannot change.
        self.rpc_factory, self.proofs = rpc_factory, Memo()

    def quote(self, request, *, now):
        params = {'tradeType': 'exactInput', 'amount': str(request['amount']),
                  'inputToken': request['originToken'], 'outputToken': request['destinationToken'],
                  'originChainId': str(request['originChainId']), 'destinationChainId': str(request['destinationChainId']),
                  'depositor': request['owner'], 'recipient': request['owner'], 'refundAddress': request['owner'],
                  'refundOnOrigin': 'true', 'slippage': format(request['slippageBps'] / 10000, '.4f'),
                  'appFee': format(self.fee_bps / 10000, '.4f'), 'appFeeRecipient': self.fee_recipient}
        if self.integrator_id:
            params['integratorId'] = self.integrator_id
        payload = self.http.get('/swap/approval', params, timeout=self.quote_seconds)
        return parse_quote(payload, request, self.pins, self.destinations, fee_recipient=self.fee_recipient,
                           now=now, fee_bps=self.fee_bps)

    def observe(self, deposit_tx_hash):
        """The deposit, or None while Across has not indexed it (it polls every ~10 s)."""
        try:
            payload = self.http.get('/deposit', {'depositTxnRef': deposit_tx_hash}, timeout=self.read_seconds, retry=True)
        except ProviderError as error:
            if str(error) == 'across_not_found':
                return None
            raise
        return parse_deposit(payload)

    def routes(self, destination, destination_token):
        payload = self.http.get('/available-routes', {'destinationChainId': str(destination)}, timeout=max(self.read_seconds, LIST_SECONDS), retry=True)
        return parse_routes(payload, self.pins, self.destinations, destination, destination_token)

    def fee(self, record, owner):
        """What a filled deposit paid Domino: (status, amount, token, evidence, reason); amount None while pending."""
        destination = record['destinationChainId']
        pin = self.pins['destinations'].get(destination, {}).get('across')
        token = record['outputToken']
        if pin is None or destination not in self.destinations or record['recipient'] not in pin['multicallHandlers']:
            # Delivered straight to the user (no fee message) or through an unknown recipient.
            return 'not_collected', 0, token, 'provider_record', 'across_fee_absent'
        try:
            fee, native_output = classify_message(record['message'], output_token=token, owner=owner,
                                                  fee_recipient=self.fee_recipient, handler=record['recipient'],
                                                  emitter=pin['eventEmitter'],
                                                  wrapped_native=self.destinations[destination]['wrappedNative'])
        except DataError:
            return 'not_collected', 0, token, 'provider_record', 'across_message_unrecognized'
        if fee == 0:
            return 'not_collected', 0, token, 'provider_record', 'across_fee_absent'
        if record['fillTxHash'] is None:
            # Filled, but the fill transaction is not indexed yet: ask again on the next poll.
            return 'pending', None, None, None, 'across_fill_not_indexed'
        key = (destination, record['fillTxHash'], record['depositId'], record['message'])
        proven = self.proofs.get(key)
        if proven is not None:
            return proven
        rpc = self.rpc_factory(destination) if self.rpc_factory else None
        if rpc is None:
            return 'measured', fee, token, 'provider_record', 'destination_rpc_not_configured'
        try:
            receipt_fee(rpc.receipt(record['fillTxHash']), record, spoke_pool=pin['spokePool'],
                        fee_recipient=self.fee_recipient, fee=fee, native_output=native_output)
            result = 'measured', fee, token, 'destination_receipt', None
        except DataError as error:
            if str(error) in ('across_rpc_unavailable', 'across_rpc_wrong_chain', 'across_fill_receipt_missing'):
                return 'measured', fee, token, 'provider_record', 'destination_rpc_unavailable'
            result = 'not_collected', 0, token, 'destination_receipt', str(error)
        self.proofs.put(key, result)
        return result
