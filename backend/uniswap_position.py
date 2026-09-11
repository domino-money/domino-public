"""Internal existing-pool LP previews calculated by Uniswap, never executable.

The official frontend/SDK converts human prices into canonical, spaced ticks.
This adapter delegates dependent amounts to /lp/create and inspects its mint
limits; it is not another liquidity or swap-ratio engine. No wallet balances,
allowances, token safety, pool state or successful execution are inferred.
"""
from dataclasses import asdict
from decimal import Decimal, InvalidOperation
import hashlib
import json
import math
import re
import time

from discovery import CHAIN_ID, ZERO, DataError, PoolKey, address, bytes32, json_http
from lp_mint_inspection import inspect_mint, MSG_SENDER, ADDRESS_THIS
from read_deadline import read_deadline
from uniswap_liquidity import checked_api_key, SCHEMA_COMMIT

ENDPOINT = 'https://liquidity.api.uniswap.org/lp/create'
SOURCE = 'uniswap_liquidity_create_v1'
TIMEOUT_SECONDS = 12
VALIDITY_SECONDS = 30
TRANSACTION_LIFETIME_SECONDS = 1200
UINT256_MAX = (1 << 256) - 1


def _integer(value, low, high):
    if type(value) is not int or not low <= value <= high:
        raise DataError('invalid_uniswap_position_number')
    return value


def _raw(value, *, positive=False, optional=False):
    if value is None and optional:
        return None
    if (not isinstance(value, str)
            or not re.fullmatch(r'(?:0|[1-9][0-9]{0,77})', value)
            or not int(positive) <= int(value) <= UINT256_MAX):
        raise DataError('invalid_uniswap_position_amount')
    return value


def _price(value):
    # Raw token1/token0, NOT human units. Preserve the provider's precision.
    if not isinstance(value, str) or len(value) > 128:
        raise DataError('invalid_uniswap_position_price')
    try:
        result = Decimal(value)
        if (not result.is_finite() or not Decimal('1e-78') <= result <= Decimal('1e78')
                or not -128 <= result.as_tuple().exponent <= 78):
            raise ValueError
        return format(result, 'f')
    except (InvalidOperation, ValueError):
        raise DataError('invalid_uniswap_position_price') from None


def _clock_value(clock):
    result = clock()
    if type(result) not in (int, float) or not math.isfinite(result) or not 0 <= result < 2**53:
        raise DataError('invalid_uniswap_position_clock')
    return result


class UniswapPosition:
    """One bounded request; no retries, cache, permits, signing or public route."""
    def __init__(self, api_key, *, transport=json_http, clock=time.time):
        self._api_key = checked_api_key(api_key)
        self._transport, self._clock = transport, clock

    def preview(self, *, owner, pool_id, pool_key: PoolKey, independent_token,
                amount_raw, tick_lower, tick_upper, slippage_bps, budget0_raw=None,
                budget1_raw=None, native_balance_raw=None, native_gas_reserve_raw=None,
                chain_id=CHAIN_ID):
        if type(chain_id) is not int or chain_id != CHAIN_ID:
            raise DataError('uniswap_position_chain_mismatch')
        owner, independent_token, pool_id = address(owner), address(independent_token), bytes32(pool_id)
        if owner in (ZERO, MSG_SENDER, ADDRESS_THIS) or not isinstance(pool_key, PoolKey):
            raise DataError('invalid_uniswap_position_identity')
        key = PoolKey.checked(tuple(asdict(pool_key).values()), pool_id)
        if key.hooks != ZERO or key.fee_pips > 1_000_000:
            raise DataError('uniswap_position_pool_unsupported')
        currencies = (key.currency0, key.currency1)
        if independent_token not in currencies:
            raise DataError('uniswap_position_currency_mismatch')
        tick_lower = _integer(tick_lower, -887272, 887272)
        tick_upper = _integer(tick_upper, -887272, 887272)
        if tick_lower >= tick_upper or tick_lower % key.tick_spacing or tick_upper % key.tick_spacing:
            raise DataError('invalid_uniswap_position_range')
        amount_raw = _raw(amount_raw, positive=True)
        slippage_bps = _integer(slippage_bps, 0, 9999)
        budgets = [_raw(value, optional=True) for value in (budget0_raw, budget1_raw)]
        native_balance_raw = _raw(native_balance_raw, optional=True)
        native_gas_reserve_raw = _raw(native_gas_reserve_raw, optional=True)
        independent_index = currencies.index(independent_token)
        if budgets[independent_index] is not None and int(amount_raw) > int(budgets[independent_index]):
            raise DataError('uniswap_position_input_exceeds_budget')
        if native_gas_reserve_raw is not None and native_balance_raw is None:
            raise DataError('invalid_uniswap_position_gas_reserve')
        started = _clock_value(self._clock)
        deadline = int(started) + TRANSACTION_LIFETIME_SECONDS
        body = {'walletAddress': owner, 'chainId': CHAIN_ID, 'protocol': 'V4',
            'existingPool': {'token0Address': key.currency0, 'token1Address': key.currency1,
                             'poolReference': pool_id},
            'independentToken': {'tokenAddress': independent_token, 'amount': amount_raw},
            'tickBounds': {'tickLower': tick_lower, 'tickUpper': tick_upper},
            'slippageTolerance': slippage_bps / 100, 'deadline': deadline,
            'simulateTransaction': False}
        dependent_index = 1 - independent_index
        if budgets[dependent_index] is not None:
            body['dependentToken'] = {'tokenAddress': currencies[dependent_index],
                                      'amount': budgets[dependent_index]}
        if native_balance_raw is not None:
            body['nativeTokenBalance'] = native_balance_raw
        with read_deadline(TIMEOUT_SECONDS):
            try:
                payload = self._transport(ENDPOINT, body, timeout=TIMEOUT_SECONDS,
                                          headers={'x-api-key': self._api_key})
            except Exception as error:
                safe = {'http_400': 'uniswap_position_request_rejected',
                    'http_401': 'uniswap_position_credentials_rejected',
                    'http_403': 'uniswap_position_access_denied',
                    'http_404': 'uniswap_position_pool_unavailable',
                    'http_429': 'uniswap_position_rate_limited',
                    'response_too_large': 'uniswap_position_response_too_large',
                    'read_deadline_exceeded': 'uniswap_position_deadline_exceeded'}
                raise DataError(safe.get(str(error), 'uniswap_position_unavailable')
                    if isinstance(error, DataError) else 'uniswap_position_unavailable') from None
            result = self._normalize(payload, owner, key, pool_id, tick_lower, tick_upper,
                deadline, independent_index, amount_raw, budgets, native_balance_raw,
                native_gas_reserve_raw)
            completed = _clock_value(self._clock)
            if completed < started or completed >= int(started) + VALIDITY_SECONDS:
                raise DataError('uniswap_position_expired')
            identity = {'owner': owner, 'chainId': CHAIN_ID, 'poolId': pool_id,
                'poolKey': asdict(key), 'independentToken': independent_token,
                'amountRaw': amount_raw, 'tickLower': tick_lower, 'tickUpper': tick_upper,
                'slippageBps': slippage_bps, 'budget0Raw': budgets[0], 'budget1Raw': budgets[1],
                'nativeBalanceRaw': native_balance_raw, 'nativeGasReserveRaw': native_gas_reserve_raw}
            result.update(request=identity, requestedAt=int(started), retrievedAt=int(completed),
                expiresAt=int(started) + VALIDITY_SECONDS, preparedDeadline=deadline,
                requestFingerprint=hashlib.sha256(json.dumps(identity, sort_keys=True,
                    separators=(',', ':')).encode()).hexdigest())
            return result

    @staticmethod
    def _normalize(payload, owner, key, pool_id, lower, upper, deadline,
                   independent_index, amount, budgets, native_balance, gas_reserve):
        if not isinstance(payload, dict) or 'error' in payload or 'code' in payload:
            raise DataError('invalid_uniswap_position_response')
        if (_integer(payload.get('tickLower'), -887272, 887272) != lower
                or _integer(payload.get('tickUpper'), -887272, 887272) != upper):
            raise DataError('uniswap_position_range_mismatch')
        min_price, max_price = _price(payload.get('adjustedMinPrice')), _price(payload.get('adjustedMaxPrice'))
        if Decimal(min_price) >= Decimal(max_price):
            raise DataError('invalid_uniswap_position_price')
        amounts = []
        for index, currency in enumerate((key.currency0, key.currency1)):
            token = payload.get('token' + str(index))
            if not isinstance(token, dict) or address(token.get('tokenAddress')) != currency:
                raise DataError('uniswap_position_currency_mismatch')
            amounts.append(_raw(token.get('amount')))
        if int(amounts[independent_index]) > int(amount) or not any(map(int, amounts)):
            raise DataError('uniswap_position_input_mismatch')
        mint = inspect_mint(payload.get('create'), owner=owner, pool_key=key, pool_id=pool_id,
                            tick_lower=lower, tick_upper=upper, deadline=deadline)
        tokens, blocked, incomplete = [], [], []
        for index, currency in enumerate((key.currency0, key.currency1)):
            maximum, nominal, budget = mint[f'amount{index}MaxRaw'], amounts[index], budgets[index]
            if int(nominal) > int(maximum):
                raise DataError('uniswap_position_amount_mismatch')
            exceeded = budget is not None and int(maximum) > int(budget)
            if exceeded:
                blocked.append(f'token{index}_maximum_exceeds_budget')
            if budget is None:
                incomplete.append(f'token{index}_budget_unknown')
            tokens.append({'address': currency, 'expectedDepositRaw': nominal,
                'maximumDebitRaw': maximum, 'selectedBudgetRaw': budget,
                'budgetStatus': 'unknown' if budget is None else 'exceeded' if exceeded else 'within_limit',
                'estimatedUnspentBudgetRaw': None if budget is None or int(nominal) > int(budget)
                                           else str(int(budget) - int(nominal)),
                'unspentAtMaximumRaw': None if budget is None or exceeded else str(int(budget) - int(maximum))})
        native_value = int(mint['nativeValueRaw'])
        if native_balance is None:
            incomplete.append('native_balance_unknown')
        elif native_value > int(native_balance):
            blocked.append('native_deposit_exceeds_balance')
        if gas_reserve is None:
            incomplete.append('native_gas_reserve_unspecified')
        elif native_value + int(gas_reserve) > int(native_balance):
            blocked.append('native_gas_reserve_exceeded')
        # No gas simulation requested; unknown is never a zero-cost promise.
        gas_fee = _raw(payload.get('gasFee'), optional=True)
        return {'schemaVersion': 1, 'source': SOURCE, 'chainId': CHAIN_ID,
            'status': 'preview_only', 'executionAvailable': False,
            'position': {'poolId': pool_id, 'poolKey': asdict(key), 'recipient': owner,
                'tickLower': lower, 'tickUpper': upper, 'tokens': tokens,
                'mintLiquidityRaw': mint['mintLiquidityRaw'],
                'adjustedPrices': {'min': min_price, 'max': max_price,
                    'unit': 'raw_token1_per_raw_token0', 'status': 'provider_reported',
                    'humanPrices': None}},
            'previewChecks': {'status': 'blocked' if blocked else 'incomplete' if incomplete
                              else 'within_selected_limits', 'reasons': blocked + incomplete},
            'nativeFunding': {'depositMaximumRaw': mint['nativeValueRaw'],
                'reportedBalanceRaw': native_balance, 'selectedGasReserveRaw': gas_reserve,
                'balanceIndependentlyVerified': False, 'reserveCoversActualGasVerified': False},
            'gas': {'feeWei': gas_fee, 'source': 'provider_estimate' if gas_fee is not None else None,
                    'fullNetworkCostVerified': False},
            'dominoFee': {'status': 'not_applicable_direct_deposit', 'bps': 0,
                'automationFeeApplies': False, 'assistedSwapPerformed': False},
            'simulation': {'status': 'not_requested', 'independentSuccessProven': False},
            'provenance': {'schemaCommit': SCHEMA_COMMIT,
                'calculation': 'uniswap_lp_create', 'mintIdentityAndLimitsInspected': True,
                'onchainSnapshotVerified': False, 'blockNumber': None,
                'balancesAndAllowancesVerified': False, 'tokenSafetyVerified': False,
                'slippageModelIndependentlyVerified': False}}
