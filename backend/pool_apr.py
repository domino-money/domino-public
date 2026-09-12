"""Pure, provisional pool-listing APR estimate from an existing read-v1 response.

This is deliberately separate from reconciled ``feeApr24h``. It combines a
verified fixed LP fee with GeckoTerminal's reported 24-hour volume and current
TVL; it neither reconstructs LP earnings nor proves the provider's observation
window. The caller supplies the evaluation clock. No provider, database, wallet
or network operation is performed here.
"""
from collections.abc import Mapping
from fractions import Fraction
from typing import Annotated, Literal

from pydantic import Field, StringConstraints, ValidationError, model_validator

from discovery import DataError, PoolKey as IdentityPoolKey
from read_contract import (DecimalString, FalseFlag, Hash,
                           MarketReason, PoolMarketResponse, Snapshot, UInt,
                           WireModel, JS_MAX_SAFE_INTEGER)


VERSION = 'pool-apr-estimate-v0'
METHOD = 'fixed_lp_fee_x_volume24h_over_reported_tvl_annualized_365'
DECIMAL_PLACES = 18
MAX_INTEGER_DIGITS = 78
FRESH_FOR_SECONDS = 60
SNAPSHOT_FRESH_FOR_SECONDS = 120
MAX_STALE_SECONDS = 300
ZERO = '0x' + '0' * 40
LIMITATIONS = (
    'provider_reported_volume_and_tvl_unreconciled',
    'provider_update_time_unknown',
    'current_tvl_not_time_weighted',
    'assumes_current_fixed_lp_fee_for_24h_volume',
    'protocol_fee_effect_not_reconciled',
    'no_full_day_coverage_proof',
    'excludes_rewards_gas_service_fees_and_price_pnl',
    'pool_estimate_not_position_apr_or_apy',
    'not_a_return_forecast_or_recommendation',
)
UNAVAILABLE_REASONS = (
    'pool_identity_mismatch', 'snapshot_mismatch', 'pool_state_unavailable',
    'dynamic_fee_unsupported', 'hooked_pool_unsupported',
    'pool_integration_unsupported', 'fixed_fee_mismatch',
    'market_unavailable', 'market_rejected', 'market_identity_mismatch',
    'provider_dex_unconfirmed', 'missing_reported_tvl', 'zero_reported_tvl',
    'missing_volume24h', 'market_age_unknown', 'market_timestamp_future',
    'snapshot_timestamp_future', 'market_data_expired', 'snapshot_expired',
    'estimate_out_of_bounds', 'estimate_below_display_precision',
)
STALE_REASONS = (
    'provider_observation_stale', 'market_cache_stale', 'onchain_snapshot_stale',
)
Reason = Literal[UNAVAILABLE_REASONS + STALE_REASONS]
AprDecimal = Annotated[str, StringConstraints(
    strict=True, pattern=r'^(?:0|[1-9][0-9]{0,77})(?:\.[0-9]{1,18})?$',
    max_length=MAX_INTEGER_DIGITS + DECIMAL_PLACES + 1)]


class AprInputs(WireModel):
    currentLpFeePips: Annotated[UInt, Field(le=1_000_000)]
    volume24hUsd: DecimalString | None
    reportedLiquidityUsd: DecimalString | None


class AprProvenance(WireModel):
    evaluatedAt: UInt
    snapshot: Snapshot
    snapshotAgeSeconds: UInt | None
    sourceUrl: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=512)] | None
    retrievedAt: UInt | None
    asOfTimestamp: None
    asOfBlock: None
    providerUpdateTimeKnown: FalseFlag
    marketStatus: Literal['available', 'stale', 'unavailable', 'rejected']
    marketReason: MarketReason | None
    cacheStatus: Literal['hit', 'cooldown', 'rate_limited', 'stale_fallback', 'miss']
    cacheAgeSeconds: UInt | None
    effectiveMarketAgeSeconds: UInt | None
    freshForSeconds: Literal[60]
    snapshotFreshForSeconds: Literal[120]
    maxStaleSeconds: Literal[300]


class AprPrecision(WireModel):
    decimalPlaces: Literal[18]
    rounding: Literal['half_up']


class PoolAprEstimate(WireModel):
    """Internal candidate model; not an addition to any public read-v1 route."""
    version: Literal['pool-apr-estimate-v0']
    scope: Literal['pool']
    metric: Literal['feeAprEstimate24hPercent']
    source: Literal['geckoterminal']
    chainId: Literal[4663]
    poolId: Hash
    status: Literal['available', 'stale', 'unavailable']
    feeAprEstimate24hPercent: AprDecimal | None
    reasons: Annotated[list[Reason], Field(max_length=len(UNAVAILABLE_REASONS) + len(STALE_REASONS))]
    method: Literal['fixed_lp_fee_x_volume24h_over_reported_tvl_annualized_365']
    inputs: AprInputs
    provenance: AprProvenance
    precision: AprPrecision
    limitations: Annotated[list[Literal[LIMITATIONS]], Field(min_length=len(LIMITATIONS), max_length=len(LIMITATIONS))]
    providerMetricsReconciled: FalseFlag
    suggested: FalseFlag
    executionAvailable: FalseFlag

    @model_validator(mode='after')
    def coherent_result(self):
        if tuple(self.limitations) != LIMITATIONS or len(set(self.reasons)) != len(self.reasons):
            raise ValueError('invalid_estimate_metadata')
        has_value = self.feeAprEstimate24hPercent is not None
        if self.status == 'available':
            valid = has_value and not self.reasons
        elif self.status == 'stale':
            valid = has_value and bool(self.reasons) and set(self.reasons) <= set(STALE_REASONS)
        else:
            valid = not has_value and bool(self.reasons) and set(self.reasons) <= set(UNAVAILABLE_REASONS)
        if not valid:
            raise ValueError('invalid_estimate_state')
        return self


def _render(value):
    """Round once, exactly; never display a tiny positive estimate as zero."""
    scale = 10 ** DECIMAL_PLACES
    units, remainder = divmod(value.numerator * scale, value.denominator)
    units += int(remainder * 2 >= value.denominator)
    if units >= 10 ** (MAX_INTEGER_DIGITS + DECIMAL_PLACES):
        return None, 'estimate_out_of_bounds'
    if value > 0 and units == 0:
        return None, 'estimate_below_display_precision'
    whole, tail = divmod(units, scale)
    fraction = str(tail).zfill(DECIMAL_PLACES).rstrip('0')
    return str(whole) + ('.' + fraction if fraction else ''), None


def estimate_pool_apr(pool_market_response: Mapping, *, now: int) -> dict:
    """Return a JSON-compatible candidate without mutating the source response.

    Invalid wire shapes or a non-integer clock raise a sanitized ValueError.
    Missing, unsupported or inconsistent observations produce ``unavailable``.
    Retrieval/cache age >=60s or snapshot age >120s makes a retained estimate
    ``stale``; either age >300s removes the value. Cache ages are never reset by
    this calculation. Unknown provider update times remain unknown.
    """
    if type(now) is not int or not 0 <= now <= JS_MAX_SAFE_INTEGER:
        raise ValueError('invalid_estimate_clock')
    if not isinstance(pool_market_response, Mapping):
        raise ValueError('invalid_pool_market_response')
    try:
        response = PoolMarketResponse.model_validate(dict(pool_market_response)).model_dump(mode='python')
    except ValidationError:
        raise ValueError('invalid_pool_market_response') from None

    pool, snapshot, market = response['pool'], response['snapshot'], response['market']
    key, data, cache = pool['poolKey'], market['data'], market['cache']
    reasons = []
    if pool['poolId'] != response['poolId'] or pool['currencies'] != [key['currency0'], key['currency1']]:
        reasons.append('pool_identity_mismatch')
    try:
        IdentityPoolKey.checked([key[name] for name in
                                 ('currency0', 'currency1', 'fee_pips', 'tick_spacing', 'hooks')],
                                response['poolId'])
    except DataError:
        if 'pool_identity_mismatch' not in reasons:
            reasons.append('pool_identity_mismatch')
    if pool['snapshot'] != snapshot:
        reasons.append('snapshot_mismatch')
    if not 0 < int(pool['sqrtPriceX96']) < 2 ** 160:
        reasons.append('pool_state_unavailable')
    if key['feeMode'] == 'dynamic':
        reasons.append('dynamic_fee_unsupported')
    if key['hooks'] != ZERO:
        reasons.append('hooked_pool_unsupported')
    if pool['integrationClass'] != 'hookless_fixed_fee':
        reasons.append('pool_integration_unsupported')
    if key['feeMode'] == 'fixed' and key['fee_pips'] != pool['currentLpFeePips']:
        reasons.append('fixed_fee_mismatch')

    retrieved_at = data['retrievedAt'] if data else None
    snapshot_age = now - snapshot['timestamp'] if snapshot['timestamp'] <= now else None
    if snapshot_age is None:
        reasons.append('snapshot_timestamp_future')
    elif snapshot_age > MAX_STALE_SECONDS:
        reasons.append('snapshot_expired')

    age = None
    if cache['ageSeconds'] is not None:
        age = cache['ageSeconds']
    if retrieved_at is not None:
        if retrieved_at > now:
            reasons.append('market_timestamp_future')
        else:
            # Cache age uses a monotonic clock; retrievedAt uses wall time.
            # Keep both and take the older age, without claiming equivalence.
            age = max(age or 0, now - retrieved_at)
    if age is None or cache['ageSeconds'] is None:
        reasons.append('market_age_unknown')
    if age is not None and age > MAX_STALE_SECONDS:
        reasons.append('market_data_expired')

    if market['status'] in ('unavailable', 'rejected'):
        reasons.append('market_' + market['status'])
    if ('provider_dex_label_unconfirmed' in response['issues'] or
            market['reason'] == 'provider_dex_unconfirmed' or
            (data and data['dexLabel'] != 'uniswap-v4-robinhood')):
        reasons.append('provider_dex_unconfirmed')
    if data and (data['chainId'] != response['chainId'] or data['poolId'] != response['poolId'] or
                 data['currencies'] != pool['currencies'] or
                 sorted((data['baseToken'], data['quoteToken'])) != pool['currencies'] or
                 market['reason'] == 'provider_currency_or_pool_mismatch'):
        reasons.append('market_identity_mismatch')

    tvl = data['reportedLiquidityUsd'] if data else None
    volume = data['volume24hUsd'] if data else None
    if tvl is None:
        reasons.append('missing_reported_tvl')
    elif Fraction(tvl) == 0:
        reasons.append('zero_reported_tvl')
    if volume is None:
        reasons.append('missing_volume24h')

    value = None
    status = 'unavailable'
    if not reasons:
        estimate = Fraction(volume) * Fraction(pool['currentLpFeePips'], 1_000_000) * 365 * 100 / Fraction(tvl)
        value, render_reason = _render(estimate)
        if render_reason:
            reasons.append(render_reason)
        else:
            if market['status'] == 'stale':
                reasons.append('provider_observation_stale')
            if age >= FRESH_FOR_SECONDS:
                reasons.append('market_cache_stale')
            if snapshot_age > SNAPSHOT_FRESH_FOR_SECONDS:
                reasons.append('onchain_snapshot_stale')
            status = 'stale' if reasons else 'available'

    result = {
        'version': VERSION, 'scope': 'pool', 'metric': 'feeAprEstimate24hPercent',
        'source': 'geckoterminal', 'chainId': response['chainId'], 'poolId': response['poolId'],
        'status': status, 'feeAprEstimate24hPercent': value, 'reasons': reasons, 'method': METHOD,
        'inputs': {'currentLpFeePips': pool['currentLpFeePips'],
                   'volume24hUsd': volume, 'reportedLiquidityUsd': tvl},
        'provenance': {
            'evaluatedAt': now, 'snapshot': snapshot, 'snapshotAgeSeconds': snapshot_age,
            'sourceUrl': data['sourceUrl'] if data else None, 'retrievedAt': retrieved_at,
            'asOfTimestamp': None, 'asOfBlock': None, 'providerUpdateTimeKnown': False,
            'marketStatus': market['status'], 'marketReason': market['reason'],
            'cacheStatus': cache['status'], 'cacheAgeSeconds': cache['ageSeconds'],
            'effectiveMarketAgeSeconds': age, 'freshForSeconds': FRESH_FOR_SECONDS,
            'snapshotFreshForSeconds': SNAPSHOT_FRESH_FOR_SECONDS, 'maxStaleSeconds': MAX_STALE_SECONDS,
        },
        'precision': {'decimalPlaces': DECIMAL_PLACES, 'rounding': 'half_up'},
        'limitations': list(LIMITATIONS), 'providerMetricsReconciled': False,
        'suggested': False, 'executionAvailable': False,
    }
    return PoolAprEstimate.model_validate(result).model_dump(mode='json')
