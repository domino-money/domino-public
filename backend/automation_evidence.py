"""Economic evidence for the planner, produced from canonical state.

Prices: the pool's own spot is what the guard anchors; it is qualified only
when the admitted independent references agree with it inside the divergence
the configuration names. Depth and activity: bounds measured over the sampled
window, never one snapshot. Swap quotes: an exact walk over the pool's
initialized ticks with the same step math the core uses, for the engine's one
registered route. Gas: the complete path - publication plus execution - at the
head's base fee with the configured buffer, plus the data component the node
reports, converted to the sequence's quote asset through the same references.
Whatever is unavailable leaves the evidence unqualified; nothing is zero-filled.
"""
from dataclasses import dataclass
from fractions import Fraction
import json
from hashlib import sha256

from eth_hash.auto import keccak
from eth_abi import encode

import execution_models as m
import execution_planner as p
import execution_v4 as v4
from automation_config import gas_price_estimate, price_bounds
from automation_observer import ObservationError
from v4_math import MIN_SQRT, MAX_SQRT, Q96, amount_delta, sqrt_at_tick, swap_step, tick_at_sqrt

ROUND_TYPES = ('uint80', 'int256', 'uint256', 'uint256', 'uint80')
NODE_INTERFACE = '0x00000000000000000000000000000000000000c8'
PUBLISH_CALLDATA_BYTES = 4 + 6 * 32
U256_MASK = (1 << 256) - 1
MIN_TICK, MAX_TICK = -887272, 887272
# Placeholders for the two SwapPlan fields the route commitment leaves out.
_PLACEHOLDER = '0x' + 'ee' * 32


@dataclass(frozen=True)
class Reference:
    currency: str
    answer: int
    feed_decimals: int
    token_decimals: int
    updated_at: int
    round_id: int

    def usd_per_atom(self):
        return Fraction(self.answer, 10 ** (self.feed_decimals + self.token_decimals))


def read_reference(reader, currency, feed, token_decimals, block, *, max_age):
    """One feed's latest round at the observation block, checked against the
    identity the configuration pins and the freshness both it and the feed's
    own heartbeat allow."""
    if reader.call(feed.proxy, 'decimals()', ['uint8'], block)[0] != feed.feedDecimals:
        raise ObservationError('automation_reference_configuration')
    if reader.call(feed.proxy, 'description()', ['string'], block)[0] != feed.description:
        raise ObservationError('automation_reference_configuration')
    values = reader.call(feed.proxy, 'latestRoundData()', ROUND_TYPES, block)
    round_id, answer, started, updated, answered = values
    if (answer <= 0 or not 0 < started <= updated <= block['timestamp'] or answered != round_id
            or block['timestamp'] - updated > min(max_age, feed.heartbeatSeconds)):
        raise ObservationError('automation_reference_stale')
    return Reference(currency, answer, feed.feedDecimals, token_decimals, updated, round_id)


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


def price_evidence(reader, ctx, policy, admission):
    """Prices in the planner's frame: quote atoms per raw unit of each pool
    currency, the quote itself exactly one. Qualified when every needed
    reference is fresh and the pool spot sits within the divergence bound."""
    seq = admission.sequence
    references, reasons = {}, []
    needed = {seq.poolKey.currency0, seq.poolKey.currency1}
    if seq.quoteCurrency != m.ZERO:
        needed.add(m.ZERO)  # gas is paid in the native asset
    for currency in sorted(needed):
        feed = policy.feeds.get(currency)
        if feed is None or currency not in policy.tokenDecimals:
            reasons.append('reference_missing')
            continue
        try:
            references[currency] = read_reference(reader, currency, feed, policy.tokenDecimals[currency], ctx.block, max_age=policy.maxAgeSeconds)
        except ObservationError as error:
            reasons.append(error.code.removeprefix('automation_'))
    spot = spot_price(ctx.pool.sqrt_price)  # currency1 atoms per currency0 atom
    if reasons:
        return None, tuple(sorted(set(reasons))), references
    c0, c1 = references[seq.poolKey.currency0], references[seq.poolKey.currency1]
    reference = c0.usd_per_atom() / c1.usd_per_atom()
    if abs(spot - reference) * 10000 > reference * policy.maxDivergenceBps:
        return None, ('reference_divergence',), references
    band = Fraction(policy.bandBps, 10000)
    low, high = min(spot, reference) * (1 - band), max(spot, reference) * (1 + band)
    if seq.quoteCurrency == seq.poolKey.currency1:
        values = ((low, high), (Fraction(1), Fraction(1)))
    else:
        values = ((Fraction(1), Fraction(1)), (1 / high, 1 / low))
    prices = tuple(p.PriceBand(lower=_ratio(lower, up=False), upper=_ratio(upper, up=True)) for lower, upper in values)
    return prices, (), references


def quote_per_wei(references, quote_currency, band_bps):
    """Quote atoms one wei is worth, rounded against the operator."""
    if quote_currency == m.ZERO:
        return Fraction(1)
    native = references.get(m.ZERO)
    quote = references.get(quote_currency)
    if native is None or quote is None:
        raise ObservationError('automation_reference_missing')
    return Fraction(native.answer * 10 ** (quote.feed_decimals + quote.token_decimals),
                    quote.answer * 10 ** (native.feed_decimals + 18)) * Fraction(10000 + band_bps, 10000)


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


def simulate_exact_input(reader, state_view, key, pool_id, pool, block, *, zero_for_one, amount_in, price_limit, max_steps):
    """The core's swap loop over the pool's initialized ticks at this block.

    Returns the output, the ending price and the step count, or None when the
    input cannot be consumed before the price limit - the engine would refuse
    that swap. Protocol-fee pools are refused: the step fee here is the LP fee.
    """
    if pool.protocol_fee != 0 or pool.lp_fee != key.fee_pips:
        raise ObservationError('automation_pool_fee_unqualified')
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
        price, step_in, step_out, charge = swap_step(price, target, liquidity, remaining, pool.lp_fee)
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


def path_cost(reader, ctx, gas, admission, execute_units, execute_calldata_bytes):
    """Publication plus execution, priced at the head's base fee with the buffer."""
    price = gas_price_estimate(ctx.block['baseFeePerGas'], gas)
    l1 = (l1_component(reader, ctx.block, gas, admission.priceGuard, PUBLISH_CALLDATA_BYTES)
          + l1_component(reader, ctx.block, gas, admission.sequence.vault, execute_calldata_bytes))
    units = gas.publishGasUnits + execute_units + l1
    return {'gasWei': units * price, 'units': units, 'l1Units': l1, 'pricePerGas': price}


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


def swap_quotes(reader, ctx, admission, dest, prices, config, cost_swap, evidence_id, expires_at):
    obs, seq = ctx.observation, admission.sequence
    limits = obs.policy.limits
    key = seq.poolKey
    spot = ctx.pool.sqrt_price
    surplus, amounts = swap_amounts(obs, dest, spot, config.destinations.swapFractionsBps, config.destinations.minimumSwapFractionBps)
    if surplus is None:
        return ()
    zero_for_one = surplus == 0
    lower, upper = price_bounds(spot, config.plan.priceBandSqrtBps, limits.maxPriceImpactBps)
    limit = max(MIN_SQRT + 1, lower) if zero_for_one else min(MAX_SQRT - 1, upper)
    currency_in, currency_out = (key.currency0, key.currency1) if zero_for_one else (key.currency1, key.currency0)
    quotes = []
    gas_quote = cost_swap['gasQuote']
    for amount in amounts:
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


def build_evidence(reader, ctx, admission, samples, config, settings, *, execute_calldata_bytes=2048):
    """The planner's Evidence for one observation, or None with the reasons."""
    obs, seq = ctx.observation, admission.sequence
    limits = obs.policy.limits
    prices, reasons, references = price_evidence(reader, ctx, config.references, admission)
    if prices is None:
        return None, reasons
    try:
        per_wei = quote_per_wei(references, seq.quoteCurrency, config.references.bandBps)
        costs = {}
        for kind in ('direct', 'swap', 'mint', 'fund'):
            cost = path_cost(reader, ctx, config.gas, admission, getattr(config.gas.executeGasUnits, kind), execute_calldata_bytes)
            cost['gasQuote'] = ceil_fraction(Fraction(cost['gasWei']) * per_wei)
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
        'references': {c: [r.answer, r.round_id, r.updated_at] for c, r in sorted(references.items())},
        'costs': {k: v['gasWei'] for k, v in costs.items()}}, sort_keys=True).encode()).hexdigest()
    admission_id = '0x' + keccak(encode(['string', 'bytes32', 'uint256'], ['DominoAutomationAdmissionV1', bytes.fromhex(seq.digest()[2:]),
                                                                          int(config.deployment.expiresAt)])).hex()
    kinds = {'compound_self': 'direct', 'redirect_fees': 'fund', 'create_domino': 'mint'}
    destinations, quotes = {}, []
    for route in p.route_sources(obs, settings):
        kind = kinds.get(route.action)
        for dest in route.destinations:
            if kind is None or dest.digest() in destinations:
                continue
            cost = costs[kind]
            depth = destination_evidence(ctx, dest, route.action, ticks, min_liquidity, max_liquidity, config.destinations,
                                         cost['gasWei'], cost['gasQuote'], exposure, fingerprint)
            if depth is None:
                continue
            destinations[dest.digest()] = depth
            if len(quotes) < 32 - len(config.destinations.swapFractionsBps):
                quotes.extend(swap_quotes(reader, ctx, admission, dest, prices, config, costs['swap'], fingerprint, expires_at))
    evidence = p.Evidence(observationHash=obs.digest(), evidenceId=fingerprint, qualified=obs.canonical and obs.coverageComplete,
                          expiresAt=expires_at, prices=prices, operationAdmissionId=admission_id,
                          destinations=tuple(destinations.values()), swaps=tuple(quotes[:32]))
    return evidence, ()
