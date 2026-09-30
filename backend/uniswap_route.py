"""Executable Uniswap route for Setup's assisted swap, for the owner's wallet.

One fixed exact-input quote through Universal Router 2.1.2, with Domino's
assisted-swap fee as the only integrator fee (the same 65 bps Setup charges)
and pools with hooks admitted for the swap leg only, then /swap for that
quote's router call. The answer is a pair of unsigned transactions the wallet
must review and sign: a Permit2 allowance of the exact input to the router,
then the router's execute. Nothing here signs, broadcasts or stores an
authorization, and a transaction is returned only when every field matches the
request and the pinned contracts.

The quote carries the router call only when Uniswap's own simulation passes,
and that simulation runs before the allowance this route adds: for an owner who
holds the input it fails (SIMULATION_ERROR, observed 29 Sep 2026). /swap builds
the call without simulating; the owner's whole sequence is simulated on the
chain's own node before the route can be chosen (swap_route.py).

The allowance is built here, never taken from the provider: asked for the
permit as a transaction, the API grants the router the maximum uint160 for 30
days, even when asked for the exact amount (observed 29 Sep 2026). Ours is the
exact input, and it lapses with the router call's own deadline.
"""
from decimal import Decimal
import re
import time

from discovery import (CHAIN_ID, ZERO, DataError, TRADING_QUOTE_ENDPOINT, TRADING_QUOTE_HEADERS,
                       TRADING_SWAP_ENDPOINT, address, decode, encode, json_http)
from read_deadline import read_deadline
from uniswap_liquidity import checked_api_key
from uniswap_quote import _clock_value, _decimal, _integer, _raw

ENDPOINT = TRADING_QUOTE_ENDPOINT
SWAP_ENDPOINT = TRADING_SWAP_ENDPOINT
SOURCE = 'uniswap_trading_route_v1'
# Universal Router 2.1.2 and Permit2 on Robinhood Chain, from Uniswap's v4
# deployments list. A swap transaction to any other address is refused: with
# x-permit2-disabled the API answers through a SwapProxy that list omits.
UNIVERSAL_ROUTER = '0x204faca1764b154221e35c0d20abb3c525710498'
PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
EXECUTE_SELECTOR = '0x3593564c'          # execute(bytes,bytes[],uint256)
PERMIT2_APPROVE_SELECTOR = '0x87517c45'  # approve(address,address,uint160,uint48)
# DominoSetup's own assisted-swap fee (docs/deployments/.../setup-release.json):
# the routed swap charges the same basis points to the same recipient.
FEE_RECIPIENT = '0x1488c84dafc03f7f4c4fb986f83ba99fd530c6f4'
FEE_BPS = 65
# Measured 29 Sep 2026 from the VM: mostly 0.4-1.6 s, now and then past 4 s.
TIMEOUT_SECONDS = 6
VALIDITY_SECONDS = 30
MAX_CALLDATA_BYTES = 16_384
# The router call's own deadline, which the allowance shares: at most an hour away.
MAX_DEADLINE_SECONDS = 3600
UINT160_MAX = (1 << 160) - 1


def _hex_data(value, *, selector):
    if (not isinstance(value, str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})+', value)
            or len(value) > 2 + 2 * MAX_CALLDATA_BYTES or value[:10].lower() != selector):
        raise DataError('uniswap_route_transaction_invalid')
    return value.lower()


def _quantity_value(value):
    if isinstance(value, str) and re.fullmatch(r'0x[0-9a-fA-F]{1,64}', value):
        return int(value, 16)
    if isinstance(value, str) and re.fullmatch(r'(?:0|[1-9][0-9]{0,77})', value):
        return int(value)
    raise DataError('uniswap_route_transaction_invalid')


def _transaction(raw, owner, *, to, selector, value):
    """No gas limit is passed on: /swap answers a fixed 650,000, and a large route needs more
    (715,000 observed). The wallet or the batch simulation estimates it."""
    if not isinstance(raw, dict):
        raise DataError('uniswap_route_transaction_invalid')
    if (address(raw.get('to')) != to or address(raw.get('from')) != owner
            or raw.get('chainId') != CHAIN_ID or _quantity_value(raw.get('value', '0x0')) != value):
        raise DataError('uniswap_route_transaction_invalid')
    return {'to': to, 'data': _hex_data(raw.get('data'), selector=selector), 'valueRaw': str(value)}


def _deadline(data, now):
    """The last argument of execute(bytes,bytes[],uint256): after it the router refuses the call."""
    try:
        _commands, _inputs, deadline = decode(['bytes', 'bytes[]', 'uint256'], bytes.fromhex(data[10:]))
    except Exception:
        raise DataError('uniswap_route_transaction_invalid') from None
    if not now < deadline <= now + MAX_DEADLINE_SECONDS:
        raise DataError('uniswap_route_transaction_invalid')
    return deadline


def exact_permit(token, amount, expiration):
    """Permit2.approve(token, router, amount, expiration): what the router may pull, and until when."""
    return {'to': PERMIT2, 'valueRaw': '0',
            'data': PERMIT2_APPROVE_SELECTOR + encode(['address', 'address', 'uint160', 'uint48'],
                                                      [token, UNIVERSAL_ROUTER, amount, expiration]).hex()}


def _plain(value):
    """The quote as JSON again: its numbers were parsed as Decimal, which json.dumps refuses."""
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, dict):
        return {key: _plain(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_plain(item) for item in value]
    return value


class UniswapRoute:
    """One fixed quote and its /swap. No retries, cache, signer or persisted authorization."""
    def __init__(self, api_key, *, transport=json_http, clock=time.time):
        self._api_key = checked_api_key(api_key)
        self._transport, self._clock = transport, clock

    def quote(self, *, owner, token_in, token_out, amount_raw, slippage_bps, timeout=TIMEOUT_SECONDS):
        owner, token_in, token_out = address(owner), address(token_in), address(token_out)
        if owner in (ZERO, FEE_RECIPIENT) or token_in == token_out:
            raise DataError('invalid_uniswap_route_identity')
        amount_raw = _raw(amount_raw, positive=True)
        if int(amount_raw) > UINT160_MAX:
            raise DataError('invalid_uniswap_route_identity')
        slippage_bps = _integer(slippage_bps, 0, 9999)
        body = {'type': 'EXACT_INPUT', 'amount': amount_raw,
            'tokenInChainId': CHAIN_ID, 'tokenOutChainId': CHAIN_ID,
            'tokenIn': token_in, 'tokenOut': token_out, 'swapper': owner, 'recipient': owner,
            'slippageTolerance': slippage_bps / 100, 'routingPreference': 'BEST_PRICE',
            'protocols': ['V2', 'V3', 'V4'], 'hooksOptions': 'V4_HOOKS_INCLUSIVE',
            # An allowance, not a signature: /swap then needs nothing signed.
            'generatePermitAsTransaction': True,
            'integratorFees': [{'recipient': FEE_RECIPIENT, 'bips': FEE_BPS}]}
        started = _clock_value(self._clock)
        with read_deadline(timeout):
            payload = self._ask(ENDPOINT, body, timeout)
            result = self._normalize(payload, owner, token_in, token_out, amount_raw, slippage_bps)
            built = self._ask(SWAP_ENDPOINT, {'quote': _plain(payload['quote']), 'simulateTransaction': False}, timeout)
            result.update(self._built(built, owner, token_in, amount_raw, int(started)))
        completed = _clock_value(self._clock)
        if completed < started or completed >= int(started) + VALIDITY_SECONDS:
            raise DataError('uniswap_route_unavailable')
        return result

    def _ask(self, url, body, timeout):
        try:
            return self._transport(url, body, timeout=timeout, headers={'x-api-key': self._api_key, **TRADING_QUOTE_HEADERS})
        except Exception as error:
            code = str(error)
            safe = {'http_400': 'uniswap_route_rejected', 'http_401': 'uniswap_route_rejected',
                'http_403': 'uniswap_route_rejected', 'http_404': 'uniswap_route_unavailable',
                'http_429': 'uniswap_route_unavailable', 'read_deadline_exceeded': 'uniswap_route_unavailable'}
            raise DataError(safe.get(code, 'uniswap_route_unavailable') if isinstance(error, DataError)
                            else 'uniswap_route_unavailable') from None

    @staticmethod
    def _normalize(payload, owner, token_in, token_out, amount_raw, slippage_bps):
        """The quote: identity, the owner's output and Domino's fee leg. No transaction yet."""
        try:
            if not isinstance(payload, dict) or payload.get('routing') != 'CLASSIC':
                raise DataError('uniswap_route_invalid')
            quote = payload.get('quote')
            if (not isinstance(quote, dict) or quote.get('chainId') != CHAIN_ID
                    or address(quote.get('swapper')) != owner or quote.get('tradeType') != 'EXACT_INPUT'):
                raise DataError('uniswap_route_invalid')
            given, taken = quote.get('input') or {}, quote.get('output') or {}
            if (address(given.get('token')) != token_in or _raw(given.get('amount'), positive=True) != amount_raw
                    or address(taken.get('token')) != token_out
                    or _decimal(quote.get('slippage'), maximum=100) != Decimal(slippage_bps) / 100):
                raise DataError('uniswap_route_invalid')
            # txFailureReasons and the quote's own swapTransaction are not read
            # (module docstring): /swap builds the call, the node simulates it.
            outputs = quote.get('aggregatedOutputs')
            if not isinstance(outputs, list) or len(outputs) != 2:
                raise DataError('uniswap_route_fee_invalid')
            legs = {}
            for leg in outputs:
                if not isinstance(leg, dict) or address(leg.get('token')) != token_out:
                    raise DataError('uniswap_route_fee_invalid')
                recipient = address(leg.get('recipient'))
                if recipient in legs:
                    raise DataError('uniswap_route_fee_invalid')
                legs[recipient] = (int(_raw(leg.get('amount'), positive=True)), int(_raw(leg.get('minAmount'), positive=True)),
                                   _decimal(leg.get('bps'), maximum=10000), leg.get('fee'))
            if set(legs) != {owner, FEE_RECIPIENT}:
                raise DataError('uniswap_route_fee_invalid')
            out, out_min, out_bps, out_kind = legs[owner]
            fee, fee_min, fee_bps, fee_kind = legs[FEE_RECIPIENT]
            gross = out + fee
            if (out_kind is not None or fee_kind != 'INTEGRATOR' or out_bps != 10000 - FEE_BPS or fee_bps != FEE_BPS
                    or not out_min <= out or not fee_min <= fee or abs(fee - gross * FEE_BPS // 10000) > 1
                    or int(_raw(taken.get('amount'), positive=True)) != gross):
                raise DataError('uniswap_route_fee_invalid')
            # A permit to sign would have to be embedded in the swap: only an allowance is admitted.
            if payload.get('permitData') is not None:
                raise DataError('uniswap_route_permit_invalid')
            approval = payload.get('isTokenApprovalApplicable')
            if approval is not None and type(approval) is not bool:
                raise DataError('uniswap_route_invalid')
            impact = quote.get('priceImpact')
            impact = None if impact is None else str(_decimal(impact, maximum=100, signed=True))
            quote_id = quote.get('quoteId')
            if not isinstance(quote_id, str) or not re.fullmatch(r'[A-Za-z0-9-]{1,64}', quote_id):
                raise DataError('uniswap_route_invalid')
        except DataError as error:
            raise error if str(error).startswith('uniswap_route_') else DataError('uniswap_route_invalid') from None
        except (KeyError, TypeError, ValueError):
            raise DataError('uniswap_route_invalid') from None
        return {'quoteId': quote_id, 'grossOutputRaw': str(gross), 'amountOutRaw': str(out),
                'minimumAmountOutRaw': str(out_min), 'feeRaw': str(fee), 'minimumFeeRaw': str(fee_min),
                'priceImpactPercent': impact, 'approvalApplicable': approval}

    @staticmethod
    def _built(answer, owner, token_in, amount_raw, now):
        """/swap's router call for the quote, and the exact allowance it needs, lapsing with its deadline."""
        try:
            if not isinstance(answer, dict):
                raise DataError('uniswap_route_transaction_invalid')
            native = token_in == ZERO
            swap = _transaction(answer.get('swap'), owner, to=UNIVERSAL_ROUTER,
                                selector=EXECUTE_SELECTOR, value=int(amount_raw) if native else 0)
            deadline = _deadline(swap['data'], now)
        except DataError as error:
            raise error if str(error).startswith('uniswap_route_') else DataError('uniswap_route_transaction_invalid') from None
        except (KeyError, TypeError, ValueError):
            raise DataError('uniswap_route_transaction_invalid') from None
        return {'permitTransaction': None if native else exact_permit(token_in, int(amount_raw), deadline),
                'swapTransaction': swap}
