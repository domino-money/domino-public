"""Public-product planning primitives. No wallet, RPC, database or signer access.

USD values use integer microdollars; this is an economic scenario, not token
spending authority. Actual token budgets must use native integer base units.
"""
from decimal import Decimal, localcontext
import re

MICRO = 1_000_000
SERVICE_BPS = 200


def money_units(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{1,9}(\.\d{1,6})?', value):
        raise ValueError('Expected a non-negative decimal string, at most six places')
    whole, _, fraction = value.partition('.')
    return int(whole) * MICRO + int(fraction.ljust(6, '0'))


def money_string(value):
    if type(value) is not int or value < 0:
        raise ValueError('Expected non-negative integer units')
    return f'{value // MICRO}.{value % MICRO:06d}'


def compound_preview(data):
    if not isinstance(data, dict) or set(data) != {'availableFeesUsd', 'positionValueUsd', 'gasUsd'}:
        raise ValueError('Invalid input fields')
    available, capital, gas = [money_units(data[key]) for key in
                               ('availableFeesUsd', 'positionValueUsd', 'gasUsd')]
    if not 10 * MICRO <= capital <= 1_000_000 * MICRO or available > 1_000_000 * MICRO or gas > 1_000 * MICRO:
        raise ValueError('Scenario exceeds supported limits')
    planned_cut = available * SERVICE_BPS // 10_000
    required_cut = (gas * 115 + 99) // 100
    minimum = (required_cut * 10_000 + SERVICE_BPS - 1) // SERVICE_BPS
    ready = available > 0 and planned_cut >= required_cut
    consumed, cut = (available, planned_cut) if ready else (0, 0)
    result = dict(mode='simulation', policyVersion=2, decision='eligible' if ready else 'wait',
                  reserveReason='network_cost' if not ready and available > 0 else 'none',
                  reason='ready' if ready else 'no_fees' if available == 0 else 'gas_too_high')
    result.update({key: money_string(value) for key, value in dict(
        availableFeesUsd=available, consumedFeesUsd=consumed, serviceFeeUsd=cut,
        reinvestedUsd=consumed-cut, reserveUsd=available-consumed, gasUsd=gas,
        operatorMarginUsd=cut-gas if ready else 0, minimumFeesUsd=minimum).items()})
    return result


def position_preview(*, amount, lower, upper, starting_price, scenario_price):
    """High-precision reference for the explanatory UI; no fee prediction."""
    values = [Decimal(str(x)) for x in (amount, lower, upper, starting_price, scenario_price)]
    if any(not x.is_finite() for x in values):
        raise ValueError('Non-finite input')
    capital, low, high, start, scenario = values
    if not Decimal(10) <= capital <= Decimal(1_000_000) or not 0 < low < start < high or high / low > 1_000_000 or not 0 < scenario <= 1_000_000:
        raise ValueError('Invalid position or scenario')
    with localcontext() as context:
        context.prec = 60
        a, b, s = low.sqrt(), high.sqrt(), start.sqrt()
        x, y = 1 / s - 1 / b, s - a
        liquidity = capital / (x * start + y)
        p = min(max(scenario, low), high).sqrt()
        token, stable = liquidity * (1 / p - 1 / b), liquidity * (p - a)
        initial_token, initial_stable = liquidity*x, liquidity*y
        return dict(initialToken=str(initial_token), initialStable=str(initial_stable),
                    token=str(token), stable=str(stable), value=str(token*scenario+stable),
                    holdValue=str(initial_token*scenario+initial_stable),
                    status='above' if scenario >= high else 'below' if scenario < low else 'inside')
