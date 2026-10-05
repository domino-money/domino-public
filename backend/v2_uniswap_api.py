"""Universal Router 2.1.2 swap legs for the V2 zap, built from the Uniswap Trading API.

A router leg (SwapLeg kind 1) is the router call the zap itself makes: the zap
is the swapper, the payer (it grants Permit2 and the router exactly amountIn
for the block, F1b) and the recipient. So the API is asked for an exact-input
CLASSIC quote with swapper = recipient = the zap, no integrator fee (Domino's
65 bps is charged on-chain by the zap, never by the router), Uniswap v3 and v4
pools only (the V2 scope), hooks admitted (F1b judges a leg by its effect),
and an allowance instead of a permit, so the calldata holds no PERMIT2_PERMIT
the zap could never sign (generatePermitAsTransaction; the API's own permit
transaction is ignored, as in V1's uniswap_route). /v1/swap then builds the
call without simulating it: the zap holds nothing at quote time, and the
API's simulation would fail (observed for holders on 29 Sep 2026).

The answer is accepted only when every field matches the request: chain,
swapper, input and amount, output, slippage, one output to the zap and no fee
output, the profile's Universal Router 2.1.2 as `to` (2.0 and 2.1.1 are
sunset on 21 Oct 2026), the execute selector, a native value only for a
native input, a router deadline no earlier than the plan's, and commands from
a short allowlist (swaps, wrap, unwrap, sweep): no permit, transfer, portion
payment or sub-plan. The route's pools are kept "as quoted" for the review.
Nothing here signs, simulates or stores anything; the planner simulates the
whole plan on the chain afterwards.

The API key is server-side only (v2_position_plan_config: credential
`uniswap-api-key`, environment DOMINO_UNISWAP_API_KEY); it never reaches a
response, a log line or an error.
"""
from decimal import Decimal
import re
import time

from discovery import (ZERO, DataError, TRADING_QUOTE_ENDPOINT, TRADING_QUOTE_HEADERS, TRADING_SWAP_ENDPOINT,
                       address, bytes32, decode, json_http)
from read_deadline import read_deadline
from uniswap_liquidity import checked_api_key
from uniswap_quote import _decimal, _integer, _raw
from uniswap_route import _plain

SOURCE = 'uniswap_trading_api'
EXECUTE_SELECTOR = '0x3593564c'  # execute(bytes,bytes[],uint256)
TIMEOUT_SECONDS = 6
MAX_CALLDATA_BYTES = 16_384
MAX_PATHS, MAX_HOPS = 8, 4
MAX_DEADLINE_SECONDS = 3600
MSG_SENDER, ADDRESS_THIS = '0x' + '00' * 19 + '01', '0x' + '00' * 19 + '02'
# Universal Router commands (Commands.sol, 2.x) a zap leg may carry.
V3_SWAP_EXACT_IN, SWEEP, WRAP_ETH, UNWRAP_WETH, BALANCE_CHECK_ERC20, V4_SWAP = 0x00, 0x04, 0x0b, 0x0c, 0x0e, 0x10
ALLOWED_COMMANDS = frozenset({V3_SWAP_EXACT_IN, SWEEP, WRAP_ETH, UNWRAP_WETH, BALANCE_CHECK_ERC20, V4_SWAP})
PROTOCOLS = ('V3', 'V4')
# Uniswap v4's LPFeeLibrary.DYNAMIC_FEE_FLAG: the pool's hook sets the fee of each swap. A router leg may cross
# such a pool (hooks admitted, F1b); its fee is shown as the flag, never as a rate. The API's best WETH -> USDG
# route on Robinhood crossed one on 4 Oct, and these routes were refused as quote_invalid until then.
DYNAMIC_FEE_FLAG = 0x800000


class RouterLegError(DataError):
    """uniswap_api_<reason>; never provider text, a URL or the key."""


def _fail(code):
    raise RouterLegError('uniswap_api_' + code)


def _token(raw, chain_id):
    if not isinstance(raw, dict) or raw.get('chainId') != chain_id:
        _fail('chain_mismatch')
    for name in ('buyFeeBps', 'sellFeeBps'):
        if raw.get(name) is not None and _decimal(raw[name], maximum=10000) != 0:
            _fail('transfer_tax_unsupported')
    return address(raw.get('address'))


def route_pools(raw, chain_id, token_in, token_out, amount_in, amount_out, wrapped=None):
    """The quoted route: [{paths}] with each pool's identity, fee and the
    amounts the API states (first input and last output of each path).

    Native ETH and the chain's wrapped native (`wrapped`) are one currency for
    the route's connections: the router wraps or unwraps between them
    (WRAP_ETH, UNWRAP_WETH), and the zap judges the leg by what it holds after.
    The API's USDG -> ETH route on Robinhood ended in WETH on 4 Oct and was
    refused as disconnected until then."""
    def joined(a, b):
        return a == b or (wrapped is not None and {a, b} == {ZERO, wrapped})
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_PATHS:
        _fail('route_invalid')
    paths, seen, total_in, total_out = [], set(), 0, 0
    for path in raw:
        if not isinstance(path, list) or not 1 <= len(path) <= MAX_HOPS:
            _fail('route_invalid')
        hops, current = [], token_in
        for index, hop in enumerate(path):
            if not isinstance(hop, dict) or hop.get('type') not in ('v3-pool', 'v4-pool'):
                _fail('route_unsupported')
            a, b = _token(hop.get('tokenIn'), chain_id), _token(hop.get('tokenOut'), chain_id)
            if not joined(a, current):
                _fail('route_disconnected')
            current = b
            if hop['type'] == 'v4-pool' and hop.get('fee') in (DYNAMIC_FEE_FLAG, str(DYNAMIC_FEE_FLAG)):
                fee = DYNAMIC_FEE_FLAG
            else:
                fee = _integer(hop.get('fee'), 0, 1_000_000, string=True)
            if hop['type'] == 'v3-pool':
                pool = {'dex': 3, 'id': address(hop.get('address')), 'fee': fee, 'tickSpacing': None, 'hooks': None}
            else:
                pool = {'dex': 4, 'id': bytes32(hop.get('address')), 'fee': fee,
                        'tickSpacing': _integer(hop.get('tickSpacing'), 1, 32767, string=True),
                        'hooks': address(hop.get('hooks'))}
            if pool['id'] in seen:
                _fail('route_pool_reused')
            seen.add(pool['id'])
            pool.update(tokenIn=a, tokenOut=b)
            hops.append(pool)
        if not joined(current, token_out):
            _fail('route_disconnected')
        first_in = _raw(path[0].get('amountIn'), positive=True)
        last_out = _raw(path[-1].get('amountOut'), positive=True)
        total_in += int(first_in)
        total_out += int(last_out)
        paths.append({'amountInRaw': first_in, 'amountOutRaw': last_out, 'pools': hops})
    if total_in != amount_in or total_out != amount_out:
        _fail('route_amount_mismatch')
    return paths


def _commands(data, zap, native_in):
    """execute(bytes,bytes[],uint256): the allowlisted commands and the router deadline."""
    try:
        commands, inputs, deadline = decode(['bytes', 'bytes[]', 'uint256'], bytes.fromhex(data[10:]))
    except Exception:
        _fail('calldata_invalid')
    if not commands or len(commands) != len(inputs):
        _fail('calldata_invalid')
    for command, payload in zip(commands, inputs):
        # The high bit lets a command fail without reverting: never for a zap leg.
        if command & 0x80 or command not in ALLOWED_COMMANDS:
            _fail('command_unsupported')
        try:
            if command == V3_SWAP_EXACT_IN:
                recipient = decode(['address', 'uint256', 'uint256', 'bytes', 'bool'], payload)[0]
            elif command in (SWEEP, UNWRAP_WETH, WRAP_ETH):
                recipient = decode(['address', 'address', 'uint256'] if command == SWEEP else ['address', 'uint256'],
                                   payload)[1 if command == SWEEP else 0]
            else:
                recipient = None
        except Exception:
            _fail('calldata_invalid')
        if recipient is not None and recipient.lower() not in (MSG_SENDER, ADDRESS_THIS, zap):
            _fail('recipient_invalid')
        if command == WRAP_ETH and not native_in:
            _fail('command_unsupported')
    return deadline


class TradingApiLegs:
    """One quote and its /swap per leg. No retries, cache, signer or stored authorization."""

    def __init__(self, api_key, *, transport=json_http, clock=time.time, timeout=TIMEOUT_SECONDS):
        self._api_key = checked_api_key(api_key)
        self._transport, self._clock, self.timeout = transport, clock, timeout

    def _ask(self, url, body):
        try:
            return self._transport(url, body, timeout=self.timeout,
                                   headers={'x-api-key': self._api_key, **TRADING_QUOTE_HEADERS})
        except Exception as error:
            code = str(error)
            if isinstance(error, DataError) and code in ('http_400', 'http_404', 'http_422'):
                _fail('no_route')
            if isinstance(error, DataError) and code == 'http_429':
                _fail('rate_limited')
            if isinstance(error, DataError) and code in ('http_401', 'http_403'):
                _fail('credentials_rejected')
            _fail('unavailable')

    def leg(self, *, chain, zap, token_in, token_out, amount_in, slippage_bps, deadline):
        """A router SwapLeg for exactly amount_in, and what the API expects it to deliver."""
        zap, token_in, token_out = address(zap), address(token_in), address(token_out)
        router = chain.uniswap.universalRouter.address
        if chain.uniswap.universalRouter.version != '2.1.2' or token_in == token_out or not 0 < amount_in < 1 << 128:
            _fail('request_invalid')
        body = {'type': 'EXACT_INPUT', 'amount': str(amount_in), 'tokenInChainId': chain.chainId,
                'tokenOutChainId': chain.chainId, 'tokenIn': token_in, 'tokenOut': token_out,
                'swapper': zap, 'recipient': zap, 'slippageTolerance': slippage_bps / 100,
                'routingPreference': 'BEST_PRICE', 'protocols': list(PROTOCOLS),
                'hooksOptions': 'V4_HOOKS_INCLUSIVE', 'generatePermitAsTransaction': True}
        now = int(self._clock())
        with read_deadline(2 * self.timeout + 1):
            payload = self._ask(TRADING_QUOTE_ENDPOINT, body)
            quote = self._quote(payload, chain, zap, token_in, token_out, amount_in, slippage_bps)
            built = self._ask(TRADING_SWAP_ENDPOINT, {'quote': _plain(payload['quote']), 'simulateTransaction': False})
        call = self._call(built, chain, zap, router, token_in, amount_in, now, deadline)
        return {'kind': 1, 'router': router, 'tokenIn': token_in, 'tokenOut': token_out, 'amountIn': amount_in,
                'expectedOut': quote['amountOut'], 'minAmountOut': quote['minimumOut'], 'data': call['data'],
                'routerDeadline': call['deadline'], 'paths': quote['paths'], 'quoteId': quote['quoteId'],
                'priceImpactPercent': quote['priceImpact']}

    @staticmethod
    def _quote(payload, chain, zap, token_in, token_out, amount_in, slippage_bps):
        try:
            if not isinstance(payload, dict) or payload.get('routing') != 'CLASSIC' or payload.get('permitData') is not None:
                _fail('route_unsupported')
            quote = payload.get('quote')
            if (not isinstance(quote, dict) or quote.get('chainId') != chain.chainId
                    or address(quote.get('swapper')) != zap or quote.get('tradeType') != 'EXACT_INPUT'):
                _fail('quote_mismatch')
            given, taken = quote.get('input') or {}, quote.get('output') or {}
            if (address(given.get('token')) != token_in or int(_raw(given.get('amount'), positive=True)) != amount_in
                    or address(taken.get('token')) != token_out or address(taken.get('recipient')) != zap
                    or _decimal(quote.get('slippage'), maximum=100) != Decimal(slippage_bps) / 100):
                _fail('quote_mismatch')
            out = int(_raw(taken.get('amount'), positive=True))
            minimum = int(_raw(taken.get('minimumAmount'), positive=True))
            if not out * (10000 - slippage_bps) // 10000 <= minimum <= out:
                _fail('minimum_mismatch')
            outputs = quote.get('aggregatedOutputs')
            if outputs is not None:
                # Exactly one output, all of it to the zap: no integrator or provider fee.
                if (not isinstance(outputs, list) or len(outputs) != 1 or address(outputs[0].get('token')) != token_out
                        or address(outputs[0].get('recipient')) != zap or outputs[0].get('fee') is not None
                        or int(_raw(outputs[0].get('amount'), positive=True)) != out
                        or (outputs[0].get('bps') is not None and _decimal(outputs[0]['bps'], maximum=10000) != 10000)):
                    _fail('fee_output_unsupported')
            for name in ('portionBips', 'portionAmount'):
                if quote.get(name) not in (None, 0, '0'):
                    _fail('fee_output_unsupported')
            paths = route_pools(quote.get('route'), chain.chainId, token_in, token_out, amount_in, out,
                                address(chain.wrappedNative.address))
            impact = quote.get('priceImpact')
            impact = None if impact is None else format(_decimal(impact, maximum=100, signed=True), 'f')
            quote_id = quote.get('quoteId')
            if not isinstance(quote_id, str) or not re.fullmatch(r'[A-Za-z0-9-]{1,64}', quote_id):
                _fail('quote_mismatch')
        except RouterLegError:
            raise
        except (DataError, KeyError, TypeError, ValueError, AttributeError):
            _fail('quote_invalid')
        return {'amountOut': out, 'minimumOut': minimum, 'paths': paths, 'priceImpact': impact, 'quoteId': quote_id}

    @staticmethod
    def _call(answer, chain, zap, router, token_in, amount_in, now, deadline):
        try:
            swap = answer.get('swap') if isinstance(answer, dict) else None
            if not isinstance(swap, dict) or address(swap.get('to')) != router or address(swap.get('from')) != zap:
                _fail('router_mismatch')
            if swap.get('chainId') != chain.chainId:
                _fail('chain_mismatch')
            data = swap.get('data')
            if (not isinstance(data, str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})+', data)
                    or len(data) > 2 + 2 * MAX_CALLDATA_BYTES or data[:10].lower() != EXECUTE_SELECTOR):
                _fail('calldata_invalid')
            value = swap.get('value', '0x0')
            value = int(value, 16) if isinstance(value, str) and value.startswith('0x') else int(value)
            native = token_in == ZERO
            if value != (amount_in if native else 0):
                _fail('value_mismatch')
            data = data.lower()
            router_deadline = _commands(data, zap, native)
            if not deadline <= router_deadline <= now + MAX_DEADLINE_SECONDS:
                _fail('deadline_unsuitable')
        except RouterLegError:
            raise
        except (DataError, KeyError, TypeError, ValueError, AttributeError):
            _fail('calldata_invalid')
        return {'data': data, 'deadline': router_deadline}
