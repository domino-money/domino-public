"""Pure Uniswap v3/v4 arithmetic for planning: liquidity sizing, prices and an exact exact-input swap.

Integer ports of what the pools and DominoPositionMath (F1c) compute, with the
same rounding, so a plan predicts an action exactly:
- liquidity_for_amounts: LiquidityAmounts.getLiquidityForAmounts (rounds down),
  how both the v4 adapter and the v3 NonfungiblePositionManager size a mint;
- amounts_for_liquidity: SqrtPriceMath deltas, rounded up to add and down to
  remove (DominoPositionMath.amountsForLiquidity);
- simulate_exact_in: Pool.swap / UniswapV3Pool.swap for an exact input with no
  price limit, step by step over initialized ticks (SwapMath.computeSwapStep,
  TickBitmap.nextInitializedTickWithinOneWord), for v4 with the protocol fee
  folded in as ProtocolFeeLibrary.calculateSwapFee does, for v3 with the pool
  fee alone (its protocol fee is a share of it). The ticks come from a
  TickSource, so a planner can remove a position's own liquidity first (a
  change of range or an exit swaps in a pool its withdrawal just thinned).
  On v4 it also reports the LP fee growth the swap adds inside a range, what a
  position there earns from it (a v4 increase refunds those fees).
No RPC, no floats: amounts are Python integers.
"""
from dataclasses import dataclass, field
from fractions import Fraction
from math import isqrt

from v4_math import MAX_SQRT, MIN_SQRT, PIPS, Q96, amount_delta, sqrt_at_tick, swap_step, tick_at_sqrt

U128 = (1 << 128) - 1
MIN_TICK, MAX_TICK = -887272, 887272
Q192 = 1 << 192


class LiquidityError(ValueError):
    """A fixed code; inputs outside what the pools accept."""


def check_range(tick_lower, tick_upper, spacing):
    """DominoPositionMath.checkRange: ordered, inside the bounds, multiples of the spacing."""
    if (type(spacing) is not int or spacing <= 0 or type(tick_lower) is not int or type(tick_upper) is not int
            or tick_lower >= tick_upper or tick_lower < MIN_TICK or tick_upper > MAX_TICK
            or tick_lower % spacing or tick_upper % spacing):
        raise LiquidityError('invalid_range')


def _sorted(a, b):
    return (a, b) if a <= b else (b, a)


def liquidity_for_amount0(sqrt_a, sqrt_b, amount0):
    sqrt_a, sqrt_b = _sorted(sqrt_a, sqrt_b)
    intermediate = sqrt_a * sqrt_b // Q96
    return _uint128(amount0 * intermediate // (sqrt_b - sqrt_a))


def liquidity_for_amount1(sqrt_a, sqrt_b, amount1):
    sqrt_a, sqrt_b = _sorted(sqrt_a, sqrt_b)
    return _uint128(amount1 * Q96 // (sqrt_b - sqrt_a))


def _uint128(value):
    if value > U128:
        raise LiquidityError('liquidity_overflow')
    return value


def liquidity_for_amounts(sqrt_price, sqrt_a, sqrt_b, amount0, amount1):
    """LiquidityAmounts.getLiquidityForAmounts: the most liquidity both amounts fund."""
    if sqrt_price <= 0:
        raise LiquidityError('pool_not_initialized')
    sqrt_a, sqrt_b = _sorted(sqrt_a, sqrt_b)
    if sqrt_price <= sqrt_a:
        return liquidity_for_amount0(sqrt_a, sqrt_b, amount0)
    if sqrt_price < sqrt_b:
        return min(liquidity_for_amount0(sqrt_price, sqrt_b, amount0), liquidity_for_amount1(sqrt_a, sqrt_price, amount1))
    return liquidity_for_amount1(sqrt_a, sqrt_b, amount1)


def amounts_for_liquidity(sqrt_price, sqrt_a, sqrt_b, liquidity, round_up):
    """DominoPositionMath.amountsForLiquidity: what adding (up) costs or removing (down) pays."""
    if sqrt_price <= 0:
        raise LiquidityError('pool_not_initialized')
    sqrt_a, sqrt_b = _sorted(sqrt_a, sqrt_b)
    if liquidity == 0:
        return 0, 0
    if sqrt_price <= sqrt_a:
        return amount_delta(sqrt_a, sqrt_b, liquidity, 0, round_up), 0
    if sqrt_price < sqrt_b:
        return (amount_delta(sqrt_price, sqrt_b, liquidity, 0, round_up),
                amount_delta(sqrt_a, sqrt_price, liquidity, 1, round_up))
    return 0, amount_delta(sqrt_a, sqrt_b, liquidity, 1, round_up)


def range_prices(tick_lower, tick_upper):
    return sqrt_at_tick(tick_lower), sqrt_at_tick(tick_upper)


# The points of the slippage band a plan's minimums are checked at: the price
# times 1 + step × s / 2 (the edges ±s, their midpoints and the price itself).
BAND_STEPS = (-2, -1, 0, 1, 2)


def band_sqrt_price(sqrt_price, slippage_bps, step):
    """The sqrt price of `sqrt_price`'s price times (1 + step × s / 2), s in basis
    points, floored: at step ±2 exactly the Uniswap SDK's ratiosAfterSlippage
    (encodeSqrtRatioX96 of token0Price × (1 ± s)), clamped inside TickMath's
    bounds as the SDK clamps it."""
    if sqrt_price <= 0 or not 0 <= slippage_bps < 10_000 or step not in BAND_STEPS:
        raise LiquidityError('band_invalid')
    value = isqrt(sqrt_price * sqrt_price * (20_000 + step * slippage_bps) // 20_000)
    return min(max(value, MIN_SQRT + 1), MAX_SQRT - 1)


# ------------------------------------------------------------------ prices

def price1_per0(sqrt_price):
    """The raw price of currency0 in currency1, exactly."""
    return Fraction(sqrt_price * sqrt_price, Q192)


def sqrt_price_for_ratio(ratio):
    """floor(sqrt(ratio) * 2^96) for a raw currency1-per-currency0 price (a Fraction)."""
    ratio = Fraction(ratio)
    if ratio <= 0:
        raise LiquidityError('price_invalid')
    value = isqrt(ratio.numerator * Q192 // ratio.denominator)
    if not MIN_SQRT <= value < MAX_SQRT:
        raise LiquidityError('price_out_of_bounds')
    return value


def decimal_text(value, digits=18):
    """A positive Fraction as a plain decimal string with at most `digits`
    significant digits, rounded down (display only, never arithmetic)."""
    value = Fraction(value)
    if value <= 0:
        raise LiquidityError('price_invalid')
    exponent = 0
    while value * Fraction(10) ** exponent < Fraction(10) ** (digits - 1):
        exponent += 1
    while value * Fraction(10) ** exponent >= Fraction(10) ** digits:
        exponent -= 1
    scaled = value.numerator * 10 ** max(exponent, 0) // (value.denominator * 10 ** max(-exponent, 0))
    if exponent <= 0:
        return str(scaled * 10 ** -exponent)
    text = str(scaled).rjust(exponent + 1, '0')
    whole, fraction = text[:-exponent], text[-exponent:].rstrip('0')
    return whole + ('.' + fraction if fraction else '')


def human_price(sqrt_price, decimals0, decimals1):
    """Both orientations in whole-token units: currency0 in currency1 and the inverse."""
    raw = price1_per0(sqrt_price)
    one_in_one = raw * Fraction(10) ** decimals0 / Fraction(10) ** decimals1
    return decimal_text(one_in_one), decimal_text(1 / one_in_one)


def initial_sqrt_price(price, base_is_currency0, decimals0, decimals1):
    """The pool's initial sqrtPriceX96 and tick from a human price: one whole
    base token is worth `price` whole tokens of the other currency."""
    price = Fraction(price)
    if price <= 0:
        raise LiquidityError('price_invalid')
    per0 = price if base_is_currency0 else 1 / price
    ratio = per0 * Fraction(10) ** decimals1 / Fraction(10) ** decimals0
    sqrt_price = sqrt_price_for_ratio(ratio)
    return sqrt_price, tick_at_sqrt(sqrt_price)


# --------------------------------------------------------------- swapping

def compress(tick, spacing):
    """TickBitmap.compress: the tick divided by the spacing, rounded toward negative infinity."""
    return tick // spacing


def _msb(x):
    return x.bit_length() - 1


def _lsb(x):
    return (x & -x).bit_length() - 1


class TickSource:
    """Initialized ticks and their liquidityNet. `words` maps a bitmap word
    position to its 256-bit word; `nets` maps a tick to liquidityNet. A
    subclass loads missing words or ticks on demand (v2_quotes)."""

    def __init__(self, words=None, nets=None):
        self.words, self.nets = dict(words or {}), dict(nets or {})

    def word(self, position):
        if position not in self.words:
            self.load_words([position])
        return self.words[position]

    def net(self, tick):
        if tick not in self.nets:
            self.load_ticks([tick])
        return self.nets[tick]

    def load_words(self, positions):
        raise LiquidityError('tick_data_missing')

    def load_ticks(self, ticks):
        raise LiquidityError('tick_data_missing')

    def next_initialized(self, tick, spacing, lte):
        """TickBitmap.nextInitializedTickWithinOneWord."""
        compressed = compress(tick, spacing)
        if lte:
            position, bit = compressed >> 8, compressed & 0xff
            masked = self.word(position) & ((1 << (bit + 1)) - 1)
            if masked:
                return (compressed - (bit - _msb(masked))) * spacing, True
            return (compressed - bit) * spacing, False
        compressed += 1
        position, bit = compressed >> 8, compressed & 0xff
        masked = self.word(position) & ~((1 << bit) - 1) & ((1 << 256) - 1)
        if masked:
            return (compressed + (_lsb(masked) - bit)) * spacing, True
        return (compressed + (255 - bit)) * spacing, False


@dataclass
class PoolSnapshot:
    """A pool's swap state at one block, enough to swap it locally."""
    sqrt_price: int
    tick: int
    liquidity: int
    tick_spacing: int
    fee_pips: tuple  # (zeroForOne, oneForZero) total swap fee, protocol fee included
    ticks: TickSource = field(default_factory=TickSource)
    # v4 slot0.protocolFee per direction, in pips (None for v3): the part of
    # each step's fee the LPs do not get, for the fee growth a swap adds.
    protocol_pips: tuple | None = None

    def without_position(self, tick_lower, tick_upper, liquidity):
        """The same pool after `liquidity` left [tick_lower, tick_upper): what
        a swap after a withdrawal in the same transaction meets."""
        snapshot = PoolSnapshot(self.sqrt_price, self.tick, self.liquidity, self.tick_spacing, self.fee_pips,
                                self.ticks, self.protocol_pips)
        if liquidity:
            snapshot.ticks = _AdjustedTicks(self.ticks, {tick_lower: -liquidity, tick_upper: liquidity})
            if tick_lower <= self.tick < tick_upper:
                if snapshot.liquidity < liquidity:
                    raise LiquidityError('pool_liquidity_inconsistent')
                snapshot.liquidity -= liquidity
        return snapshot


class _AdjustedTicks(TickSource):
    """Another source's ticks with a position's liquidity taken out. A tick the
    removal empties stays a boundary here (its net becomes 0); the pool would
    clear it, which can move a step's rounding by a unit, never the liquidity."""

    def __init__(self, source, adjust):
        super().__init__()
        self.source, self.adjust_by = source, adjust

    def word(self, position):
        return self.source.word(position)

    def net(self, tick):
        return self.source.net(tick) + self.adjust_by.get(tick, 0)


@dataclass(frozen=True)
class SwapOutcome:
    amount_out: int
    sqrt_price: int
    tick: int
    liquidity: int
    ticks_crossed: int
    zero_for_one: bool = True
    # LP fee growth (X128, in the input token) the swap added while the pool's
    # tick was inside `track`'s range: what a position there earns from it.
    fee_growth_in_range: int = 0


MAX_SWAP_STEPS = 4096
Q128 = 1 << 128
U256 = (1 << 256) - 1


def simulate_exact_in(pool, zero_for_one, amount_in, *, track=None):
    """Pool.swap with amountSpecified = -amount_in and no price limit beyond
    the protocol's: the output, and the pool's price and tick after. With
    `track` = (tick_lower, tick_upper) on a v4 snapshot, also the LP fee growth
    the swap adds inside that range (v4-core Pool.swap: the protocol's part of
    each step's fee first, then feeGrowthGlobal += lpFee * 2**128 / liquidity)."""
    if amount_in <= 0:
        raise LiquidityError('swap_amount_invalid')
    fee = pool.fee_pips[0 if zero_for_one else 1]
    if not 0 <= fee < PIPS:
        raise LiquidityError('swap_fee_invalid')
    if track is not None and pool.protocol_pips is None:
        raise LiquidityError('fee_growth_unsupported')
    protocol = pool.protocol_pips[0 if zero_for_one else 1] if track is not None else 0
    limit = MIN_SQRT + 1 if zero_for_one else MAX_SQRT - 1
    price, tick, liquidity = pool.sqrt_price, pool.tick, pool.liquidity
    remaining, out, crossed, growth = -amount_in, 0, 0, 0
    for _ in range(MAX_SWAP_STEPS):
        if remaining == 0 or price == limit:
            break
        start, start_tick = price, tick
        nxt, initialized = pool.ticks.next_initialized(tick, pool.tick_spacing, zero_for_one)
        nxt = max(MIN_TICK, min(MAX_TICK, nxt))
        next_price = sqrt_at_tick(nxt)
        target = max(next_price, limit) if zero_for_one else min(next_price, limit)
        price, step_in, step_out, step_fee = swap_step(price, target, liquidity, remaining, fee)
        remaining += step_in + step_fee
        out += step_out
        if track is not None and track[0] <= start_tick < track[1] and liquidity > 0:
            # A position's boundaries are initialized ticks, so a step is wholly
            # inside its range or wholly outside.
            lp_fee = step_fee
            if protocol > 0:
                lp_fee -= step_fee if fee == protocol else (step_in + step_fee) * protocol // PIPS
            growth = (growth + lp_fee * Q128 // liquidity) & U256
        if price == next_price:
            if initialized:
                net = pool.ticks.net(nxt)
                liquidity += -net if zero_for_one else net
                if not 0 <= liquidity <= U128:
                    raise LiquidityError('pool_liquidity_inconsistent')
                crossed += 1
            tick = nxt - 1 if zero_for_one else nxt
        elif price != start:
            tick = tick_at_sqrt(price)
    else:
        raise LiquidityError('swap_too_many_steps')
    if remaining != 0:
        # The price limit was reached with input left: the pool cannot take it all.
        raise LiquidityError('swap_exceeds_pool')
    return SwapOutcome(out, price, tick, liquidity, crossed, zero_for_one, growth)
