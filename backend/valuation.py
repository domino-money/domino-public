"""Exact historical USD integration; pool fee APR is conditional on full coverage."""
from fractions import Fraction

from capital_store import capital_intervals
from discovery import DataError
from price_history import decimal_string

VERSION = 1


def value_pair(raw, at, series):
    # Even a zero token balance does not qualify a missing currency feed.
    return sum((series[i].value(raw[i], at) for i in (0, 1)), Fraction())


def value_window(window, series, pool_id):
    if len(series) != 2 or any(s is None for s in series):
        raise DataError('qualified_usd_prices_required')
    if any(s.qualification.target_pool != pool_id for s in series):
        raise DataError('price_pool_independence_not_qualified')
    reference_only = any(getattr(s.qualification, 'reference_only', False) for s in series)
    if reference_only:
        currencies = tuple(window.get('currencies', ()))
        if (currencies != tuple(s.qualification.currency for s in series) or
                any(getattr(s.qualification, 'currencies', None) != currencies for s in series)):
            raise DataError('reference_price_pool_currencies_mismatch')
    seconds = window['end']-window['start']
    if seconds <= 0:
        raise DataError('zero_observed_duration')
    integral = Fraction()
    for start, end, capital in capital_intervals(window):
        bounds = sorted({start, end} | series[0].boundaries(start, end) | series[1].boundaries(start, end))
        for a, b in zip(bounds, bounds[1:]):
            # Validate the complete interval, including fractional-time stale gaps.
            mid = Fraction(a+b, 2)
            for s in series:
                s.at(mid)
            integral += value_pair(capital['lpAssetsRaw'], a, series)*(b-a)
    tvl = value_pair(window['endCapital']['lpAssetsRaw'], window['end'], series)
    fees = Fraction();volume = Fraction()
    for swap in window['swaps']:
        if not window['end']-86400 < swap['timestamp'] <= window['end']:
            raise DataError('swap_outside_valuation_window')
        allocation = swap.get('fees')
        if not allocation:
            raise DataError('reconciled_swap_fees_required')
        fees += value_pair(allocation['lpFeesRaw'], swap['timestamp'], series)
        # Value only the input leg once. Donations, liquidity flows and protocol fees
        # are never treated as LP trading revenue.
        inputs = [max(0, -int(swap['payload'][f'amount{i}'])) for i in (0, 1)]
        if sum(x > 0 for x in inputs) > 1:
            raise DataError('ambiguous_swap_input')
        volume += value_pair(inputs, swap['timestamp'], series)
    average = integral/seconds
    complete = seconds == 86400
    reason = 'pool_younger_than_window' if not complete else ('zero_time_weighted_tvl' if average == 0 else None)
    apr = 100*365*fees/average if reason is None else None
    return {'methodologyVersion': VERSION,
            'status': 'reference_analytics_only' if reference_only else 'qualified_historical_calculation',
            'tvlUsd': decimal_string(tvl), 'timeWeightedAverageTvlUsd': decimal_string(average),
            'tradingLpFeesUsd': decimal_string(fees), 'grossInputVolumeUsd': decimal_string(volume),
            'feeAprPercent': decimal_string(apr) if apr is not None else None, 'feeAprReason': reason,
            'complete24h': complete, 'observedSeconds': seconds,
            'priceConvention': ('publication_plus_one_second_and_answer_age_reference_policy' if reference_only
                                else 'causal_last_observation_with_qualified_max_age'),
            'feeAprBasis': '365_times_full_day_trading_lp_fees_over_time_weighted_lp_assets',
            'annualizationDays': 365, 'isPositionApr': False, 'isApy': False,
            'includesDominoServiceFee': False, 'includesTokenPricePnl': False,
            'decimalPlaces': 18, 'executionAvailable': False}
