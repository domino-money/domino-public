"""Bind Uniswap previews and Setup swap routes to a SIWE session. Never a signer."""
from dataclasses import asdict
import json
import math
import time

from pydantic import ValidationError

from discovery import CHAIN_ID, DataError, PoolKey, address, bytes32
from onboarding_models import (CONTRACT_VERSION, MAX_RESPONSE, OnboardingError,
                               validate_request, validate_response)
from read_deadline import check_read_deadline


class OnboardingService:
    def __init__(self, auth, quote, position, *, route=None, clock=time.time, private_values=()):
        self.auth, self.quote, self.position, self.route, self.clock = auth, quote, position, route, clock
        self.private_values = tuple(private_values)

    def _now(self):
        value = self.clock()
        if type(value) not in (int, float) or not math.isfinite(value) or not 0 <= value < 2**53:
            raise OnboardingError('upstream_unavailable')
        return value

    def _fresh(self, preview, started):
        now = self._now()
        if now < started:
            raise OnboardingError('preview_expired')
        if preview['expiresAt'] <= now:
            raise OnboardingError('preview_expired')
        if (not int(started) <= preview['requestedAt'] <= preview['retrievedAt'] <= now + 5
                or preview['expiresAt'] != preview['requestedAt'] + 30):
            raise OnboardingError('upstream_invalid_response')
        if 'preparedDeadline' in preview and preview['preparedDeadline'] != preview['requestedAt'] + 1200:
            raise OnboardingError('upstream_invalid_response')

    def execute(self, route, body, *, client, session, csrf):
        try:
            request = validate_request(route, body).model_dump()
        except (DataError, ValidationError, ValueError, TypeError):
            raise OnboardingError('invalid_request') from None
        started = self._now()
        check_read_deadline()
        context = self.auth.begin(client, session, csrf)
        owner = context['owner']
        # The browser never supplies an owner, spender, recipient or tenant.
        identity = {'owner': owner, 'chainId': CHAIN_ID}
        if route == 'swap-preview':
            identity.update(tokenIn=address(request['tokenIn']), tokenOut=address(request['tokenOut']),
                amountRaw=request['amountRaw'], slippageBps=request['slippageBps'],
                maxPriceImpactBps=request['maxPriceImpactBps'])
            adapter, kwargs = self.quote, {'token_in': identity['tokenIn'], 'token_out': identity['tokenOut'],
                'amount_raw': request['amountRaw'], 'slippage_bps': request['slippageBps'],
                'max_price_impact_bps': request['maxPriceImpactBps']}
        elif route == 'swap-route':
            if self.route is None:
                raise OnboardingError('route_not_available')
            raw_key = request['poolKey']
            key = PoolKey.checked((raw_key['currency0'], raw_key['currency1'], raw_key['fee_pips'],
                raw_key['tick_spacing'], raw_key['hooks']), request['poolId'])
            identity.update(poolId=bytes32(request['poolId']), poolKey=asdict(key),
                tokenIn=address(request['tokenIn']), amountRaw=request['amountRaw'], slippageBps=request['slippageBps'])
            adapter, kwargs = self.route, {'pool_id': identity['poolId'], 'key': key, 'token_in': identity['tokenIn'],
                'amount_raw': request['amountRaw'], 'slippage_bps': request['slippageBps']}
        else:
            raw_key = request['poolKey']
            key = PoolKey.checked((raw_key['currency0'], raw_key['currency1'], raw_key['fee_pips'],
                raw_key['tick_spacing'], raw_key['hooks']), request['poolId'])
            identity.update(poolId=bytes32(request['poolId']), poolKey=asdict(key),
                independentToken=address(request['independentToken']), amountRaw=request['amountRaw'],
                tickLower=request['tickLower'], tickUpper=request['tickUpper'],
                slippageBps=request['slippageBps'], budget0Raw=request['budget0Raw'],
                budget1Raw=request['budget1Raw'], nativeBalanceRaw=request['nativeBalanceRaw'],
                nativeGasReserveRaw=request['nativeGasReserveRaw'])
            adapter, kwargs = self.position, {'pool_id': identity['poolId'], 'pool_key': key,
                'independent_token': identity['independentToken'], 'amount_raw': request['amountRaw'],
                'tick_lower': request['tickLower'], 'tick_upper': request['tickUpper'],
                'slippage_bps': request['slippageBps'], 'budget0_raw': request['budget0Raw'],
                'budget1_raw': request['budget1Raw'], 'native_balance_raw': request['nativeBalanceRaw'],
                'native_gas_reserve_raw': request['nativeGasReserveRaw']}
        check_read_deadline()
        try:
            if route == 'swap-route':
                preview = adapter.plan(owner=owner, **kwargs)
            else:
                preview = adapter.preview(owner=owner, chain_id=CHAIN_ID, **kwargs)
        except DataError as error:
            code = str(error)
            if code == 'read_deadline_exceeded' or code.endswith('_deadline_exceeded'):
                reason = 'request_timeout'
            elif route == 'swap-route':
                # The pool quote or the chain read failed; a provider failure alone never gets here.
                reason = 'preview_expired' if code == 'swap_route_expired' else 'upstream_unavailable'
            elif code in ('uniswap_quote_expired', 'uniswap_position_expired'):
                reason = 'preview_expired'
            elif code in ('uniswap_quote_rate_limited', 'uniswap_position_rate_limited'):
                reason = 'provider_rate_limited'
            elif code in ('uniswap_quote_request_rejected', 'uniswap_position_request_rejected',
                          'uniswap_quote_no_route', 'uniswap_position_pool_unavailable'):
                reason = 'provider_request_rejected'
            elif code in ('uniswap_quote_unavailable', 'uniswap_position_unavailable',
                          'uniswap_quote_credentials_rejected', 'uniswap_position_credentials_rejected',
                          'uniswap_quote_access_denied', 'uniswap_position_access_denied'):
                reason = 'provider_unavailable'
            else:
                reason = 'upstream_invalid_response'
            raise OnboardingError(reason) from None
        try:
            result = validate_response(route, {'contractVersion': CONTRACT_VERSION, 'preview': preview})
            preview = result['preview']
            if preview['request'] != identity:
                raise ValueError()
            if route == 'position-preview':
                position = preview['position']
                if position['recipient'] != owner or any(position[name] != identity[name]
                        for name in ('poolId', 'poolKey', 'tickLower', 'tickUpper')):
                    raise ValueError()
            # Field association is not signing permission, including while all
            # selected caps pass. The closed schema enforces false execution.
            self._fresh(preview, started)
            encoded = json.dumps(result, allow_nan=False, separators=(',', ':'))
            if len(encoded.encode()) > MAX_RESPONSE or any(value and value in encoded
                    for value in (*self.private_values, session, csrf)):
                raise ValueError()
        except (ValidationError, ValueError, TypeError, KeyError):
            raise OnboardingError('upstream_invalid_response') from None
        # Expiry, logout and a CSRF rotation during the provider call invalidate
        # delivery. This does not rotate CSRF or persist a funding authorization.
        self.auth.finish(context)
        check_read_deadline()
        self._fresh(preview, started)
        return result
