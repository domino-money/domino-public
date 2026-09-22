"""Economic evidence for the planner, produced from canonical state.

Prices: the pool's own spot at the observed block is the anchor the guard
binds, valued with the configured margin; there is no external reference,
average or volatility gate (the owner's decision of 22 September 2026). Depth and activity: bounds measured over the sampled window,
never one snapshot. Swap quotes: an exact walk over the pool's initialized
ticks with the same step math the core uses, for the engine's one registered
route, each quote inside the pool's swap cap (fee x depth, shared by every
vault over a window of blocks). Gas: the complete path - publication plus
execution - at the head's base fee with the configured buffer, plus the data
component the node reports, converted to the sequence's quote asset through the
native asset or an admitted native/quote pool; the operator's account carries
the publications a success is expected to cost. Whatever is unavailable leaves
the evidence unqualified; nothing is zero-filled.
"""
from fractions import Fraction
import json
from hashlib import sha256

from eth_hash.auto import keccak
from eth_abi import encode

import execution_models as m
import execution_planner as p
import execution_v4 as v4
from automation_config import gas_price_estimate, impact_bounds
from automation_observer import ObservationError
from v4_math import MIN_SQRT, MAX_SQRT, Q96, amount_delta, sqrt_at_tick, swap_step, tick_at_sqrt

NODE_INTERFACE = '0x00000000000000000000000000000000000000c8'
PUBLISH_CALLDATA_BYTES = 4 + 6 * 32
U256_MASK = (1 << 256) - 1
MIN_TICK, MAX_TICK = -887272, 887272
PPM = 1_000_000
# The guard admits a source block for 255 blocks: executions observed within
# that distance can land in the same block, so their swaps share one budget.
SWAP_WINDOW_BLOCKS = 256
# Placeholders for the two SwapPlan fields the route commitment leaves out.
_PLACEHOLDER = '0x' + 'ee' * 32


def _ratio(value, *, up):
    """A planner Ratio inside 2**256, rounded in the stated direction."""
    n, d = value.numerator, value.denominator
    if n <= 0 or d <= 0:
        raise ObservationError('automation_invalid_ratio')
    while n >= 2**256 or d >= 2**256:
        n, d = (-(-n // 2), d // 2) if up else (n // 2, -(-d // 2))
    return p.Ratio(numerator=max(1, n), denominator=max(1, d))


def spot_price(sqrt_price):
    return Fraction(sqrt_price * sqrt_price, Q96 * Q96)


def price_evidence(ctx, admission, band_bps):
    """Prices in the planner's frame: quote atoms per raw unit of each pool
    currency, the quote itself exactly one. The anchor is the pool's spot at
    the observed block; the other currency is valued over the spot plus or
    minus the configured margin."""
    seq = admission.sequence
    if not MIN_SQRT <= ctx.pool.sqrt_price < MAX_SQRT:
        return None, ('price_unqualified',)
    band = Fraction(band_bps, 10000)
    spot = spot_price(ctx.pool.sqrt_price)  # currency1 atoms per currency0 atom
    low, high = spot * (1 - band), spot * (1 + band)
    if seq.quoteCurrency == seq.poolKey.currency1:
        values = ((low, high), (Fraction(1), Fraction(1)))
    else:
        values = ((Fraction(1), Fraction(1)), (1 / high, 1 / low))
    return tuple(p.PriceBand(lower=_ratio(lower, up=False), upper=_ratio(upper, up=True)) for lower, upper in values), ()


def quote_per_wei(reader, ctx, pricing, quote_currency, state_view):
    """Quote atoms one wei is worth, rounded against the operator: one for the
    native asset and its wrapper; otherwise the admitted native/quote pool's
    spot at the observed block, with the configured buffer."""
    if quote_currency in (m.ZERO, pricing.wrappedNative):
        return Fraction(1)
    key = pricing.gasPools.get(quote_currency)
    if key is None:
        raise ObservationError('automation_gas_price_source_missing')
    pool_id = bytes.fromhex(key.pool_id()[2:])
    sqrt_price = reader.call(state_view, 'getSlot0(bytes32)', ['uint160', 'int24', 'uint24', 'uint24'], ctx.block, ['bytes32'], [pool_id])[0]
    liquidity = reader.call(state_view, 'getLiquidity(bytes32)', ['uint128'], ctx.block, ['bytes32'], [pool_id])[0]
    if not MIN_SQRT <= sqrt_price < MAX_SQRT or liquidity <= 0:
        raise ObservationError('automation_gas_price_unavailable')
    price = spot_price(sqrt_price)  # currency1 atoms per currency0 atom
    per_native = price if key.currency0 in (m.ZERO, pricing.wrappedNative) else 1 / price
    return per_native * Fraction(10000 + pricing.gasPriceBufferBps, 10000)


def ceil_fraction(value):
    return -(-value.numerator // value.denominator)


# ------------------------------------------------------------------ swaps
def _msb(x):
    return x.bit_length() - 1


def _lsb(x):
    return (x & -x).bit_length() - 1


def _next_initialized(bitmap, tick, spacing, zero_for_one):
    """TickBitmap.nextInitializedTickWithinOneWord, on integers."""
    compressed = tick // spacing
    if zero_for_one:
        word_pos, bit_pos = compressed >> 8, compressed & 255
        masked = bitmap(word_pos) & ((1 << (bit_pos + 1)) - 1)
        if masked:
            return (compressed - (bit_pos - _msb(masked))) * spacing, True
        return (compressed - bit_pos) * spacing, False
    compressed += 1
    word_pos, bit_pos = compressed >> 8, compressed & 255
    masked = bitmap(word_pos) & (~((1 << bit_pos) - 1) & U256_MASK)
    if masked:
        return (compressed + (_lsb(masked) - bit_pos)) * spacing, True
    return (compressed + (255 - bit_pos)) * spacing, False


MAX_PROTOCOL_FEE_PIPS = 1000
MAX_SWAP_FEE_PIPS = 1_000_000


def swap_fee_pips(protocol_fee, lp_fee, zero_for_one):
    """The fee the core charges on a swap's input, in pips: the LP fee, or the
    direction's protocol fee composed with it (protocol + lp - protocol*lp/1e6),
    per Pool.swap and ProtocolFeeLibrary. The protocol's share never reaches
    the position, so fee growth stays the LP fee's; only the output changes."""
    if type(protocol_fee) is not int or type(lp_fee) is not int or not 0 <= protocol_fee < 1 << 24 or not 0 <= lp_fee < MAX_SWAP_FEE_PIPS:
        raise ObservationError('automation_pool_fee_unqualified')
    direction = protocol_fee & 0xfff if zero_for_one else protocol_fee >> 12
    if direction > MAX_PROTOCOL_FEE_PIPS or (protocol_fee >> 12) > MAX_PROTOCOL_FEE_PIPS:
        raise ObservationError('automation_pool_fee_unqualified')
    fee = lp_fee if direction == 0 else direction + lp_fee - direction * lp_fee // MAX_SWAP_FEE_PIPS
    if fee >= MAX_SWAP_FEE_PIPS:
        raise ObservationError('automation_pool_fee_unqualified')
    return fee


def simulate_exact_input(reader, state_view, key, pool_id, pool, block, *, zero_for_one, amount_in, price_limit, max_steps):
    """The core's swap loop over the pool's initialized ticks at this block.

    Returns the output, the ending price and the step count, or None when the
    input cannot be consumed before the price limit - the engine would refuse
    that swap. The step fee is the core's swap fee for the direction: the LP
    fee alone, or the protocol fee's share for that direction composed with
    it exactly as ProtocolFeeLibrary.calculateSwapFee does. A pool whose LP
    fee is not the key's static fee (a dynamic-fee pool) is refused.
    """
    if pool.lp_fee != key.fee_pips:
        raise ObservationError('automation_pool_fee_unqualified')
    swap_fee = swap_fee_pips(pool.protocol_fee, pool.lp_fee, zero_for_one)
    if type(amount_in) is not int or not 0 < amount_in < 2**127:
        raise ObservationError('automation_invalid_swap_amount')
    if zero_for_one and not MIN_SQRT < price_limit < pool.sqrt_price:
        return None
    if not zero_for_one and not pool.sqrt_price < price_limit < MAX_SQRT:
        return None
    pool_bytes = bytes.fromhex(pool_id[2:])
    words = {}
    def bitmap(word):
        if word not in words:
            words[word] = reader.call(state_view, 'getTickBitmap(bytes32,int16)', ['uint256'], block, ['bytes32', 'int16'], [pool_bytes, word])[0]
        return words[word]
    price, tick, liquidity = pool.sqrt_price, pool.tick, pool.liquidity
    remaining, output, steps = -amount_in, 0, 0
    while remaining != 0 and price != price_limit:
        steps += 1
        if steps > max_steps:
            return None
        next_tick, initialized = _next_initialized(bitmap, tick, key.tick_spacing, zero_for_one)
        next_tick = max(MIN_TICK, min(MAX_TICK, next_tick))
        next_price = sqrt_at_tick(next_tick)
        target = max(next_price, price_limit) if zero_for_one else min(next_price, price_limit)
        start = price
        price, step_in, step_out, charge = swap_step(price, target, liquidity, remaining, swap_fee)
        remaining += step_in + charge
        output += step_out
        if price == next_price:
            if initialized:
                net = reader.call(state_view, 'getTickLiquidity(bytes32,int24)', ['uint128', 'int128'], block, ['bytes32', 'int24'], [pool_bytes, next_tick])[1]
                liquidity += -net if zero_for_one else net
            tick = next_tick - 1 if zero_for_one else next_tick
        elif price != start:
            tick = tick_at_sqrt(price)
    if remaining != 0:
        return None
    return {'amountOut': output, 'afterPrice': price, 'steps': steps}


def swap_cap(reader, state_view, key, pool_id, pool, block, *, zero_for_one, bound, multiplier_bps, max_steps):
    """The pool's cap on compound swaps in this direction, in the input
    currency's atoms: fee x depth, times the configured multiplier.

    Pushing the price from the spot to a point and restoring it trades about
    2 x L x (distance in square root) at each liquidity L on the way, so its
    fees are fee x depth x fraction, depth being the average of L x sqrt P
    over the path; the gain on a swap of size S is S x fraction. The push is
    unprofitable up to every point of the owner's impact band exactly when S
    stays below fee times the least running average of the depth from the
    spot, which is what this walks, tick by tick: a liquidity gap right at the
    spot makes the cap zero, a far one lowers it in proportion. The fee is
    the lower of the two directions', since a push and its restore each pay
    one. None when the walk needs more steps than admitted: the cap is then
    unmeasured, not assumed.
    """
    if pool.lp_fee != key.fee_pips:
        raise ObservationError('automation_pool_fee_unqualified')
    fee = min(swap_fee_pips(pool.protocol_fee, pool.lp_fee, True), swap_fee_pips(pool.protocol_fee, pool.lp_fee, False))
    pool_bytes = bytes.fromhex(pool_id[2:])
    words = {}
    def bitmap(word):
        if word not in words:
            words[word] = reader.call(state_view, 'getTickBitmap(bytes32,int16)', ['uint256'], block, ['bytes32', 'int16'], [pool_bytes, word])[0]
        return words[word]
    price, tick, liquidity = pool.sqrt_price, pool.tick, pool.liquidity
    swept, least, steps = 0, None, 0  # sum of L x distance; least running average of L
    while price != bound:
        steps += 1
        if steps > max_steps:
            return None
        next_tick, initialized = _next_initialized(bitmap, tick, key.tick_spacing, zero_for_one)
        next_tick = max(MIN_TICK, min(MAX_TICK, next_tick))
        next_price = sqrt_at_tick(next_tick)
        target = max(next_price, bound) if zero_for_one else min(next_price, bound)
        if target != price:
            live = max(0, liquidity)
            # The running average moves monotonically toward each segment's
            # liquidity, so its least value is at the first segment or at a
            # segment's end: nowhere else needs checking.
            least = Fraction(live) if least is None else least
            swept += live * abs(price - target)
            least = min(least, Fraction(swept, abs(pool.sqrt_price - target)))
            price = target
        if price == bound:
            break
        if initialized:
            net = reader.call(state_view, 'getTickLiquidity(bytes32,int24)', ['uint128', 'int128'], block, ['bytes32', 'int24'], [pool_bytes, next_tick])[1]
            liquidity += -net if zero_for_one else net
        tick = next_tick - 1 if zero_for_one else next_tick
    if least is None:
        return 0
    numerator, denominator = (Q96, pool.sqrt_price) if zero_for_one else (pool.sqrt_price, Q96)
    depth = least * fee * numerator * multiplier_bps
    return depth.numerator // (depth.denominator * MAX_SWAP_FEE_PIPS * 10000 * denominator)


def exposure_ppm(amount, cap):
    """The share of the pool's cap one swap takes, in millionths, rounded up;
    None when there is no cap to take a share of."""
    if cap is None or cap <= 0:
        return None
    return -(-amount * PPM // cap)


def ratio_bps(value, anchor):
    return value * value * 10000 // (anchor * anchor)


def ratio_ceil_bps(value, anchor):
    return -(-value * value * 10000 // (anchor * anchor))


def price_impact_bps(after, anchor):
    """The impact the engine measures: the larger deviation of the squared
    ratio from one, in basis points, with the contract's own rounding."""
    return max(10000 - ratio_bps(after, anchor), ratio_ceil_bps(after, anchor) - 10000, 0)


def engine_minimum_output(amount_in, price, zero_for_one, slippage_bps):
    """DominoRoutingHelperV4.minimumOutput, exactly."""
    if price <= (1 << 128) - 1:
        ratio = price * price
        quote = ratio * amount_in >> 192 if zero_for_one else ((1 << 192) * amount_in) // ratio
    else:
        ratio = price * price >> 64
        quote = ratio * amount_in >> 128 if zero_for_one else ((1 << 128) * amount_in) // ratio
    return quote * (10000 - slippage_bps) // 10000


# ------------------------------------------------------------------- gas
def l1_component(reader, block, policy, to, data_size):
    if policy.l1DataComponent == 'attested_none':
        return 0
    estimate = reader.call(NODE_INTERFACE, 'gasEstimateL1Component(address,bool,bytes)', ['uint64', 'uint256', 'uint256'], block,
                           ['address', 'bool', 'bytes'], [to, False, b'\x00' * data_size])[0]
    return int(estimate)


def path_cost(ctx, gas, execute_units, l1, *, attempts=Fraction(1)):
    """Publication plus execution, priced at the head's base fee with the
    buffer. `l1` holds the data components of the two transactions. `attempts`
    is how many publications one completed cycle is expected to take: the
    operator pays for the failed ones, so its expected cost carries them, while
    the per-transaction gas the owner's cap limits does not."""
    price = gas_price_estimate(ctx.block['baseFeePerGas'], gas)
    publish, execute = gas.publishGasUnits + l1[0], execute_units + l1[1]
    return {'gasWei': (publish + execute) * price, 'expectedWei': ceil_fraction(publish * price * attempts) + execute * price,
            'units': publish + execute, 'l1Units': l1[0] + l1[1], 'pricePerGas': price}


# -------------------------------------------------------------- evidence
def _value(amounts, bands, *, upper):
    return sum(Fraction(n) * (b.upper if upper else b.lower).fraction() for n, b in zip(amounts, bands))


def window_bounds(samples, ctx, *, since):
    """Liquidity and in-range activity over the measured window, this block included."""
    rows = [s for s in samples if int(s['block_timestamp']) >= since and s['qualified']]
    liquidities = [int(s['liquidity']) for s in rows] + [ctx.pool.liquidity]
    ticks = [int(s['tick']) for s in rows] + [ctx.pool.tick]
    return min(liquidities), max(liquidities), ticks


def destination_evidence(ctx, dest, route_action, ticks, min_liquidity, max_liquidity, policy, gas_wei, gas_quote, exposure_quote, evidence_id):
    obs = ctx.observation
    total = ctx.pool.liquidity
    if total <= 0:
        return None
    owner = sum(ctx.member_liquidity.get(c.position.tokenId, 0) for c in obs.positions
                if c.active and c.position.tickLower <= ctx.pool.tick < c.position.tickUpper)
    owner = min(owner, total)
    competing = max(0, min(min_liquidity, total) - owner) * (10000 - policy.competingLiquidityHaircutBps) // 10000
    maximum_total = max(max_liquidity, total) * (10000 + policy.totalLiquidityMarginBps) // 10000
    if dest.createChild:
        active = policy.successorActiveFractionBps
    else:
        inside = sum(1 for t in ticks if dest.tickLower <= t < dest.tickUpper)
        active = inside * 10000 // len(ticks) * (10000 - policy.activeFractionHaircutBps) // 10000
    increase = min(policy.maxLiquidityIncreaseAbsolute, total * policy.maxLiquidityIncreaseBpsOfActive // 10000)
    if increase <= 0:
        return None
    return p.DestinationEvidence(destination=dest, evidenceId=evidence_id, qualified=True, totalActiveLiquidity=total,
        ownerActiveLiquidity=owner, minimumCompetingLiquidity=min(competing, total - owner), maximumTotalLiquidity=maximum_total,
        activeFractionBps=min(10000, active), maxLiquidityIncrease=increase, exposureLossQuote=exposure_quote,
        ownerPaidCostQuote=0, directGasWei=max(1, gas_wei), directGasQuote=max(1, gas_quote))


def net_available(obs):
    """Fee units the sequence could deploy per currency, after the mode's cut."""
    fee = obs.policy.serviceFeeBps
    pair = (obs.sequence.poolKey.currency0, obs.sequence.poolKey.currency1)
    available = [0, 0]
    for b in obs.balances:
        n = int(b.amountRaw) - int(b.reservedRaw)
        available[pair.index(b.currency)] += n if b.convertedCharged else n - n * fee // 10000
    for a in obs.accruals:
        n = int(a.amountRaw)
        available[pair.index(a.source.currency)] += n - n * fee // 10000
    return available


def swap_amounts(obs, dest, spot, fractions, minimum_bps):
    """Exact-input amounts of the surplus currency worth quoting for this
    range: fractions of what direct reinvestment would leave idle, once that
    idle part is at least the configured share of the currency's fees."""
    lower, upper = sqrt_at_tick(dest.tickLower), sqrt_at_tick(dest.tickUpper)
    clamped = max(lower, min(upper, spot))
    unit = 1 << 96
    need0, need1 = amount_delta(clamped, upper, unit, 0, True), amount_delta(lower, clamped, unit, 1, True)
    avail0, avail1 = net_available(obs)
    if need0 == 0 and need1 == 0:
        return None, ()
    if need0 == 0:
        surplus, leftover = 0, avail0
    elif need1 == 0:
        surplus, leftover = 1, avail1
    else:
        direct = min(avail0 * unit // need0, avail1 * unit // need1)
        left0, left1 = avail0 - direct * need0 // unit, avail1 - direct * need1 // unit
        raw = spot_price(spot)
        surplus = 0 if Fraction(left0) * raw >= Fraction(left1) else 1
        leftover = left0 if surplus == 0 else left1
    if leftover * 10000 < (avail0, avail1)[surplus] * minimum_bps:
        return None, ()
    amounts = sorted({leftover * f // 10000 for f in fractions} - {0})
    return surplus, tuple(a for a in amounts if a < 2**127)


def swap_quotes(reader, ctx, admission, dest, config, cost_swap, evidence_id, expires_at, caps, used_ppm):
    """Exact-input quotes for this range's surplus currency, inside the owner's
    impact band and the pool's remaining swap cap. `caps` holds the cap per
    direction, measured once per evidence."""
    obs, seq = ctx.observation, admission.sequence
    limits = obs.policy.limits
    key = seq.poolKey
    spot = ctx.pool.sqrt_price
    surplus, amounts = swap_amounts(obs, dest, spot, config.destinations.swapFractionsBps, config.destinations.minimumSwapFractionBps)
    if surplus is None:
        return ()
    zero_for_one = surplus == 0
    lower, upper = impact_bounds(spot, limits.maxPriceImpactBps)
    limit = max(MIN_SQRT + 1, lower) if zero_for_one else min(MAX_SQRT - 1, upper)
    if zero_for_one not in caps:
        caps[zero_for_one] = swap_cap(reader, admission.stateView, key, seq.poolId, ctx.pool, ctx.block, zero_for_one=zero_for_one,
                                      bound=lower if zero_for_one else upper, multiplier_bps=config.swapCap.depthMultiplierBps,
                                      max_steps=config.destinations.maxSimulationSteps)
    cap = caps[zero_for_one]
    currency_in, currency_out = (key.currency0, key.currency1) if zero_for_one else (key.currency1, key.currency0)
    quotes = []
    gas_quote = cost_swap['gasQuote']
    for amount in amounts:
        usage = exposure_ppm(amount, cap)
        if usage is None or usage > PPM - used_ppm:
            # Above what the pool's cap has left: the excess waits for a later
            # cycle, while the direct addition stays open.
            continue
        result = simulate_exact_input(reader, admission.stateView, key, seq.poolId, ctx.pool, ctx.block, zero_for_one=zero_for_one,
                                      amount_in=amount, price_limit=limit, max_steps=config.destinations.maxSimulationSteps)
        if result is None:
            continue
        expected = result['amountOut']
        floor = engine_minimum_output(amount, spot, zero_for_one, limits.maxSlippageBps)
        # The declared slippage is a floor the quote must honour exactly:
        # round the tolerance up so the minimum never sits below it.
        minimum = max(floor, -(-expected * (10000 - config.destinations.quoteSlippageBps) // 10000))
        impact = price_impact_bps(result['afterPrice'], spot)
        if expected <= 0 or minimum <= 0 or minimum > expected or impact > limits.maxPriceImpactBps:
            continue
        route = v4.SwapPlan(sourceId=_PLACEHOLDER, currencyIn=currency_in, amountIn=str(amount), maxOriginal='1', maxCharged='0',
                            minAmountOut=str(minimum), sqrtPriceLimitX96=str(limit), priceObservationId=_PLACEHOLDER)
        bounds = m.SwapBounds(enabled=True, adapterId=v4.ADAPTER_ID, adapterVersion=v4.ADAPTER_VERSION,
                              routeCommitment=v4.route_commitment(route, seq.poolId), currencyIn=currency_in, currencyOut=currency_out,
                              amountInRaw=str(amount), minAmountOutRaw=str(minimum))
        quotes.append(p.SwapQuote(destination=dest, bounds=bounds, evidenceId=evidence_id, qualified=True, expiresAt=expires_at,
            expectedAmountOutRaw=expected, priceImpactBps=impact, slippageBps=config.destinations.quoteSlippageBps,
            gasWei=max(1, cost_swap['gasWei']), gasQuote=max(1, gas_quote)))
    return tuple(quotes)


def build_evidence(reader, ctx, admission, samples, config, settings, *, used_ppm=0, attempts=Fraction(1), only=None,
                   notes=None, execute_calldata_bytes=2048):
    """The planner's Evidence for one observation, or None with the reasons.

    `used_ppm` is the share of the pool's swap cap other compound swaps hold
    in the current window; `attempts` the publications a completed cycle is
    expected to take; `only`, when given, the destination digests worth
    re-quoting (the act path's re-evaluation). `notes`, when a dict, receives
    the swap cap per direction for the cycle's record and its reservation.
    """
    obs, seq = ctx.observation, admission.sequence
    limits = obs.policy.limits
    if type(used_ppm) is not int or not 0 <= used_ppm <= PPM or not attempts >= 1:
        return None, ('swap_exposure_unavailable',)
    prices, reasons = price_evidence(ctx, admission, config.pricing.valuationBandBps)
    if prices is None:
        return None, reasons
    try:
        per_wei = quote_per_wei(reader, ctx, config.pricing, seq.quoteCurrency, admission.stateView)
        l1 = (l1_component(reader, ctx.block, config.gas, admission.priceGuard, PUBLISH_CALLDATA_BYTES),
              l1_component(reader, ctx.block, config.gas, admission.sequence.vault, execute_calldata_bytes))
        costs = {}
        for kind in ('direct', 'swap', 'mint', 'fund'):
            cost = path_cost(ctx, config.gas, getattr(config.gas.executeGasUnits, kind), l1, attempts=attempts)
            cost['gasQuote'] = ceil_fraction(Fraction(cost['expectedWei']) * per_wei)
            costs[kind] = cost
    except (ObservationError, ValueError) as error:
        return None, (getattr(error, 'code', 'gas_unavailable').removeprefix('automation_'),)
    expires_at = int(obs.blockTimestamp) + limits.maxObservationAgeSeconds
    since = ctx.block['timestamp'] - settings.maximumMeasurementSeconds
    min_liquidity, max_liquidity, ticks = window_bounds(samples, ctx, since=since)
    pair = (seq.poolKey.currency0, seq.poolKey.currency1)
    held = [0, 0]
    for b in obs.balances:
        held[pair.index(b.currency)] += int(b.amountRaw)
    for a in obs.accruals:
        held[pair.index(a.source.currency)] += int(a.amountRaw)
    exposure = ceil_fraction(_value(held, prices, upper=True) * Fraction(config.destinations.exposureLossBps, 10000))
    fingerprint = '0x' + sha256(json.dumps({'observation': obs.digest(), 'config': config.configVersion, 'block': ctx.block['hash'],
        'costs': {k: [v['gasWei'], v['gasQuote']] for k, v in costs.items()}, 'swapExposurePpm': used_ppm,
        'attempts': [attempts.numerator, attempts.denominator], 'only': sorted(only) if only is not None else None},
        sort_keys=True).encode()).hexdigest()
    admission_id = '0x' + keccak(encode(['string', 'bytes32', 'uint256'], ['DominoAutomationAdmissionV1', bytes.fromhex(seq.digest()[2:]),
                                                                          int(config.deployment.expiresAt)])).hex()
    kinds = {'compound_self': 'direct', 'redirect_fees': 'fund', 'create_domino': 'mint'}
    destinations, quotes, caps = {}, [], {}
    for route in p.route_sources(obs, settings):
        kind = kinds.get(route.action)
        for dest in route.destinations:
            if kind is None or dest.digest() in destinations or (only is not None and dest.digest() not in only):
                continue
            cost = costs[kind]
            depth = destination_evidence(ctx, dest, route.action, ticks, min_liquidity, max_liquidity, config.destinations,
                                         cost['gasWei'], cost['gasQuote'], exposure, fingerprint)
            if depth is None:
                continue
            destinations[dest.digest()] = depth
            if len(quotes) < 32 - len(config.destinations.swapFractionsBps):
                quotes.extend(swap_quotes(reader, ctx, admission, dest, config, costs['swap'], fingerprint, expires_at, caps, used_ppm))
    if notes is not None:
        notes['swapCap'] = {'windowBlocks': SWAP_WINDOW_BLOCKS, 'usedPpm': used_ppm,
                            'directions': {('zeroForOne' if direction else 'oneForZero'): (None if cap is None else str(cap))
                                           for direction, cap in sorted(caps.items())}}
        notes['caps'] = dict(caps)
    evidence = p.Evidence(observationHash=obs.digest(), evidenceId=fingerprint, qualified=obs.canonical and obs.coverageComplete,
                          expiresAt=expires_at, prices=prices, operationAdmissionId=admission_id,
                          destinations=tuple(destinations.values()), swaps=tuple(quotes[:32]))
    return evidence, ()
