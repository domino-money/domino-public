"""Integer v4 swap-step math. Adapted MIT math; see THIRD_PARTY_NOTICES.md.

No floats, token metadata, RPC, signing or USD assumptions. Inputs are bounded
by decoded v4 state/events. Python integers retain intermediate precision.
"""
from functools import lru_cache

from discovery import DataError

Q96 = 1 << 96
Q128 = 1 << 128
U256 = (1 << 256) - 1
PIPS = 1_000_000
MIN_SQRT = 4295128739
MAX_SQRT = 1461446703485210103287273052203988822378723970342
FACTORS = (
    0xfffcb933bd6fad37aa2d162d1a594001, 0xfff97272373d413259a46990580e213a,
    0xfff2e50f5f656932ef12357cf3c7fdcc, 0xffe5caca7e10e4e61c3624eaa0941cd0,
    0xffcb9843d60f6159c9db58835c926644, 0xff973b41fa98c081472e6896dfb254c0,
    0xff2ea16466c96a3843ec78b326b52861, 0xfe5dee046a99a2a811c461f1969c3053,
    0xfcbe86c7900a88aedcffc83b479aa3a4, 0xf987a7253ac413176f2b074cf7815e54,
    0xf3392b0822b70005940c7a398e4b70f3, 0xe7159475a2c29b7443b29c7fa6e889d9,
    0xd097f3bdfd2022b8845ad8f792aa5825, 0xa9f746462d870fdf8a65dc1f90e061e5,
    0x70d869a156d2a1b890bb3df62baf32f7, 0x31be135f97d08fd981231505542fcfa6,
    0x9aa508b5b7a84e1c677de54f3e99bc9, 0x5d6af8dedb81196699c329225ee604,
    0x2216e584f5fa1ea926041bedfe98, 0x48a170391f7dc42444e8fa2,
)


def ceil_div(n, d):
    if n < 0 or d <= 0:
        raise DataError('invalid_fee_math_division')
    return (n + d - 1) // d


@lru_cache(maxsize=16384)
def sqrt_at_tick(tick):
    if not -887272 <= tick <= 887272:
        raise DataError('invalid_fee_math_tick')
    ratio = Q128
    for bit, factor in enumerate(FACTORS):
        if abs(tick) & (1 << bit):
            ratio = ratio * factor >> 128
    if tick > 0:
        ratio = U256 // ratio
    return ceil_div(ratio, 1 << 32)


def tick_at_sqrt(price):
    if not MIN_SQRT <= price < MAX_SQRT:
        raise DataError('invalid_fee_math_price')
    low, high = -887272, 887272
    while low < high:
        mid = (low + high + 1) // 2
        if sqrt_at_tick(mid) <= price:
            low = mid
        else:
            high = mid - 1
    return low


def amount_delta(a, b, liquidity, currency, up):
    a, b = min(a, b), max(a, b)
    if a <= 0 or liquidity < 0:
        raise DataError('invalid_fee_math_delta')
    n, d = ((liquidity << 96) * (b-a), a*b) if currency == 0 else (liquidity * (b-a), Q96)
    return ceil_div(n, d) if up else n // d


def next_price(price, liquidity, amount, zero_for_one, exact_in):
    if price <= 0 or liquidity <= 0 or amount < 0:
        raise DataError('invalid_fee_math_next_price')
    if zero_for_one == exact_in:
        # currency0; retain the EVM overflow fallback, whose rounding differs.
        if amount == 0:
            return price
        numerator = liquidity << 96
        product = amount * price
        if exact_in:
            result = (ceil_div(numerator * price, numerator + product)
                      if numerator + product <= U256
                      else ceil_div(numerator, numerator // price + amount))
        else:
            if product > U256 or product >= numerator:
                raise DataError('fee_math_price_overflow')
            result = ceil_div(numerator * price, numerator - product)
    else:
        result = (price + amount * Q96 // liquidity if exact_in
                  else price - ceil_div(amount * Q96, liquidity))
    if not 0 < result < 1 << 160:
        raise DataError('fee_math_price_overflow')
    return result


def swap_step(price, target, liquidity, remaining, fee):
    """v4 convention: negative remaining is exact input; positive is output."""
    if not 0 <= fee <= PIPS or not 0 <= liquidity < 1 << 128:
        raise DataError('invalid_fee_math_step')
    zero = price >= target
    input_currency = 0 if zero else 1
    if remaining < 0:
        net = -remaining * (PIPS-fee) // PIPS
        amount_in = amount_delta(price, target, liquidity, input_currency, True)
        if net >= amount_in:
            end = target
            charge = amount_in if fee == PIPS else ceil_div(amount_in * fee, PIPS-fee)
        else:
            amount_in = net
            end = next_price(price, liquidity, net, zero, True)
            charge = -remaining - net
        amount_out = amount_delta(price, end, liquidity, 1-input_currency, False)
    else:
        if fee == PIPS:
            raise DataError('exact_output_with_full_fee')
        amount_out = amount_delta(price, target, liquidity, 1-input_currency, False)
        if remaining >= amount_out:
            end = target
        else:
            amount_out = remaining
            end = next_price(price, liquidity, amount_out, zero, False)
        amount_in = amount_delta(price, end, liquidity, input_currency, True)
        charge = ceil_div(amount_in * fee, PIPS-fee)
    return end, amount_in, amount_out, charge
