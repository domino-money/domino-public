"""E3 pure, non-signing strategy candidates. No provider, persistence or authority.

All prices are exact quote-asset atoms per raw currency unit. No USD assumption,
APR extrapolation, balanceOf input, caller calldata, or executable plan is exposed.
Inputs labelled qualified are adapter assertions, never live admission by this
module. E2/E4/E5/E7 and independent financial review remain separate gates.
"""
from fractions import Fraction
from hashlib import sha256
import json
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt, model_validator

import execution_models as e1
from v4_math import Q96, amount_delta, sqrt_at_tick

UInt = Annotated[StrictInt, Field(ge=0, lt=2**256)]
Positive = Annotated[StrictInt, Field(gt=0, lt=2**256)]
Bps = Annotated[StrictInt, Field(ge=0, le=10000)]
Action = Literal['wait', 'compound_self', 'redirect_fees', 'create_domino']


class Frozen(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, frozen=True)


def fingerprint(record):
    """Private candidate fingerprint, not an E1 ABI hash or signable intent ID."""
    return '0x' + sha256(json.dumps(record.model_dump(mode='json'), sort_keys=True,
                                  separators=(',', ':')).encode()).hexdigest()


class Ratio(Frozen):
    numerator: Positive
    denominator: Positive

    def fraction(self):
        return Fraction(self.numerator, self.denominator)


class PriceBand(Frozen):
    lower: Ratio
    upper: Ratio

    @model_validator(mode='after')
    def checked(self):
        if self.lower.fraction() > self.upper.fraction():
            raise ValueError('inverted_price_band')
        return self


class FeeSample(Frozen):
    """Canonical cumulative LP earned units and integrated active liquidity-time.

    The adapter must exclude principal, donations, protocol fees and conversions;
    counters share one pool/measurement epoch. This is not a portfolio-value delta.
    """
    sequence: e1.Identity
    epoch: e1.Identity
    blockNumber: UInt
    blockHash: e1.Identity
    timestamp: UInt
    cumulativeFee0: UInt
    cumulativeFee1: UInt
    cumulativeLiquiditySeconds: UInt
    coverageComplete: bool
    qualified: bool
    evidenceId: e1.Identity


class MeasurementHistory(Frozen):
    sequence: e1.Identity
    waitingSince: UInt
    samples: Annotated[tuple[FeeSample, ...], Field(max_length=512)]
    lastAttemptAt: UInt
    lastReadFailed: bool

    @model_validator(mode='after')
    def checked(self):
        if self.waitingSince > self.lastAttemptAt:
            raise ValueError('future_wait_start')
        for i, sample in enumerate(self.samples):
            if sample.sequence != self.sequence or sample.timestamp > self.lastAttemptAt:
                raise ValueError('foreign_or_future_sample')
            if i:
                prior = self.samples[i-1]
                if (sample.epoch != prior.epoch or sample.timestamp <= prior.timestamp
                        or sample.blockNumber <= prior.blockNumber
                        or sample.cumulativeFee0 < prior.cumulativeFee0
                        or sample.cumulativeFee1 < prior.cumulativeFee1
                        or sample.cumulativeLiquiditySeconds <= prior.cumulativeLiquiditySeconds):
                    raise ValueError('incoherent_fee_history')
        return self


def observe(history: MeasurementHistory, sample: FeeSample | None, *, now: int):
    """An isolated failure retains samples and elapsed wait; an epoch change
    explicitly starts a new measurement series, never a new waiting interval.
    """
    history = MeasurementHistory.model_validate(history.model_dump())
    if type(now) is not int or now < history.lastAttemptAt:
        raise ValueError('nonmonotonic_observation_time')
    samples = history.samples
    failed = sample is None
    if sample is not None:
        sample = FeeSample.model_validate(sample.model_dump())
        if sample.sequence != history.sequence or sample.timestamp > now:
            raise ValueError('foreign_or_future_sample')
        failed = not sample.qualified or not sample.coverageComplete
        if not failed:
            if samples and sample == samples[-1]:
                pass  # duplicate RPC answers do not increase sample count
            elif samples and sample.epoch != samples[-1].epoch:
                samples = (sample,)
            else:
                samples = (*samples[-511:], sample)
    return MeasurementHistory(sequence=history.sequence, waitingSince=history.waitingSince,
                              samples=samples, lastAttemptAt=now, lastReadFailed=failed)


class PlannerSettings(Frozen):
    """Every operational number is explicit; examples select no live defaults."""
    version: e1.Identity
    minimumSamples: Annotated[StrictInt, Field(ge=3, le=512)]
    minimumSampleSeconds: Positive
    maximumMeasurementSeconds: Annotated[StrictInt, Field(gt=0, le=604800)]
    maximumSampleAgeSeconds: Positive
    maximumForecastSeconds: Annotated[StrictInt, Field(gt=0, le=604800)]
    forecastHaircutBps: Bps
    minimumOwnerBenefitQuote: UInt
    operatorCostBufferBps: Bps
    serviceRealizationBps: Bps
    overlapChoicesBps: Annotated[tuple[Bps, ...], Field(min_length=1, max_length=8)]
    liquidityFractionChoicesBps: Annotated[tuple[Bps, ...], Field(min_length=2, max_length=16)]

    @model_validator(mode='after')
    def checked(self):
        if tuple(sorted(set(self.overlapChoicesBps))) != self.overlapChoicesBps:
            raise ValueError('overlap_choices_not_unique_sorted')
        fractions = self.liquidityFractionChoicesBps
        if tuple(sorted(set(fractions))) != fractions or fractions[0] == 0 or fractions[-1] != 10000:
            raise ValueError('liquidity_fractions_require_unique_partial_and_full_choices')
        if self.maximumMeasurementSeconds < self.minimumSampleSeconds:
            raise ValueError('inverted_measurement_window')
        return self


class DestinationEvidence(Frozen):
    """Qualified conservative earning/exposure/depth assumptions for this range.

    activeFractionBps is a lower bound within the finite forecast horizon, not
    an assertion that today's in-range state persists. maxLiquidityIncrease is
    a depth/admission cap. totalActiveLiquidity and ownerActiveLiquidity describe
    coherent current exposure; minimumCompetingLiquidity and maximumTotalLiquidity
    are qualified bounds on competing / total existing liquidity over the horizon.
    These are not inferred from a current snapshot. All amounts use the sequence's
    fixed quote asset. directGas* covers the COMPLETE chosen non-swap path.
    """
    destination: e1.Destination
    evidenceId: e1.Identity
    qualified: bool
    totalActiveLiquidity: Positive
    ownerActiveLiquidity: UInt
    minimumCompetingLiquidity: UInt
    maximumTotalLiquidity: Positive
    activeFractionBps: Bps
    maxLiquidityIncrease: Annotated[StrictInt, Field(gt=0, lt=2**127)]
    exposureLossQuote: UInt
    ownerPaidCostQuote: UInt
    directGasWei: Positive
    directGasQuote: Positive

    @model_validator(mode='after')
    def checked(self):
        if (self.ownerActiveLiquidity > self.totalActiveLiquidity
                or self.minimumCompetingLiquidity > self.totalActiveLiquidity-self.ownerActiveLiquidity
                or self.maximumTotalLiquidity < self.totalActiveLiquidity):
            raise ValueError('incoherent_liquidity_share_bounds')
        return self


class SwapQuote(Frozen):
    """Admitted exact-input quote. gasWei/gasQuote cover the COMPLETE chosen
    compound/Domino + swap path, not only the incremental swap leg. The output
    floor already includes execution price impact / DEX fees / slippage.
    """
    destination: e1.Destination
    bounds: e1.SwapBounds
    evidenceId: e1.Identity
    qualified: bool
    expiresAt: UInt
    expectedAmountOutRaw: Positive
    priceImpactBps: Bps
    slippageBps: Bps
    gasWei: Positive
    gasQuote: Positive

    @model_validator(mode='after')
    def checked(self):
        if not self.bounds.enabled or int(self.bounds.minAmountOutRaw) > self.expectedAmountOutRaw:
            raise ValueError('invalid_exact_input_quote')
        if int(self.bounds.minAmountOutRaw) * 10000 < self.expectedAmountOutRaw * (10000-self.slippageBps):
            raise ValueError('quote_output_below_slippage_bound')
        return self


class Evidence(Frozen):
    """One observation-bound adapter bundle; values may be synthetic for tests."""
    observationHash: e1.Identity
    evidenceId: e1.Identity
    qualified: bool
    expiresAt: UInt
    prices: tuple[PriceBand, PriceBand]
    operationAdmissionId: e1.Identity
    destinations: Annotated[tuple[DestinationEvidence, ...], Field(max_length=1024)]
    swaps: Annotated[tuple[SwapQuote, ...], Field(max_length=32)]

    @model_validator(mode='after')
    def checked(self):
        keys = [d.destination.digest() for d in self.destinations]
        if len(keys) != len(set(keys)):
            raise ValueError('duplicate_destination_evidence')
        quote_keys = [fingerprint(q) for q in self.swaps]
        if len(set(quote_keys)) != len(quote_keys):
            raise ValueError('duplicate_swap_quote')
        return self


class Routing(Frozen):
    sourcePosition: e1.Identity
    action: Action
    destinations: tuple[e1.Destination, ...]
    reason: str


class Economics(Frozen):
    productiveQuote: UInt
    incrementalEarningsQuote: UInt
    serviceCostQuote: UInt
    swapLossQuote: UInt
    ownerNetBenefitQuote: int
    operatorRevenueQuote: UInt
    operatorBufferedCostQuote: UInt
    ownerPass: bool
    operatorPass: bool


class Candidate(Frozen):
    action: Action
    destination: e1.Destination | None
    sources: tuple[e1.Identity, ...]
    allocations: tuple[e1.Allocation, ...]
    collections: tuple[e1.CollectionBudget, ...]
    swap: e1.SwapBounds | None
    liquidityIncrease: UInt
    grossConsumed: tuple[UInt, UInt]
    chargedConsumed: tuple[UInt, UInt]
    serviceCut: tuple[UInt, UInt]
    netAdded: tuple[UInt, UInt]
    convertedResidual: tuple[UInt, UInt]
    economics: Economics
    reasons: tuple[str, ...]


class WaitingBalance(Frozen):
    source: e1.Identity
    currency: e1.Address
    origin: Literal['reserve', 'reserved', 'accrual_estimate']
    reference: e1.Identity
    amountRaw: UInt
    reason: str


class Decision(Frozen):
    inputFingerprint: e1.Identity
    observationHash: e1.Identity
    action: Action
    selected: int  # 0 is always the explicit waiting alternative
    candidates: tuple[Candidate, ...]
    routing: tuple[Routing, ...]
    waiting: tuple[WaitingBalance, ...]
    reasons: tuple[str, ...]
    elapsedWaitSeconds: UInt
    forecastHorizonSeconds: UInt
    # Candidate choice confers no execution permission and exposes no E1 plan.
    executionAvailable: Literal[False] = False


def quote_price(sqrt_price, base_is_zero):
    raw = Fraction(sqrt_price*sqrt_price, Q96*Q96)
    return raw if base_is_zero else 1/raw


def price_range(position, base_is_zero):
    prices = (quote_price(sqrt_at_tick(position.tickLower), base_is_zero),
              quote_price(sqrt_at_tick(position.tickUpper), base_is_zero))
    return min(prices), max(prices)


def successor_range(observation, parent, overlap_bps):
    """Round the human floor inward/up and ceiling inward/down on the exact
    v4 grid. No overlap/upside bound is exceeded in either token orientation.
    """
    policy, seq = observation.policy, observation.sequence
    if type(overlap_bps) is not int or not 0 <= overlap_bps <= policy.maxOverlapBps:
        raise ValueError('overlap_exceeds_policy')
    base0 = seq.baseCurrency == seq.poolKey.currency0
    ceiling = price_range(parent, base0)[1]
    floor_target = ceiling * Fraction(10000-overlap_bps, 10000)
    ceiling_target = ceiling * Fraction(10000+policy.limits.upsideBps, 10000)
    spacing = seq.poolKey.tick_spacing
    bound = 887272 // spacing
    # Index increases in quote/base price even when raw ticks decrease.
    def tick(index):
        return index*spacing if base0 else -index*spacing
    def price(index):
        return quote_price(sqrt_at_tick(tick(index)), base0)
    def first_at_least(value):
        lo, hi = -bound, bound+1
        while lo < hi:
            mid = (lo+hi)//2
            if mid <= bound and price(mid) < value:
                lo = mid+1
            else:
                hi = mid
        return lo
    low = first_at_least(floor_target)
    high = first_at_least(ceiling_target)
    if high > bound or price(high) > ceiling_target:
        high -= 1
    if low >= high or low > bound or high < -bound or price(high) <= ceiling:
        raise ValueError('infeasible_successor_grid')
    lower, upper = sorted((tick(low), tick(high)))
    return e1.Destination(createChild=True, tokenId=parent.tokenId, tickLower=lower, tickUpper=upper)


def route_sources(observation, settings, pending_parents=frozenset()):
    """Original sources are routed once. An incoming balance retains its source
    and never follows the destination's independently computed route again.
    Existing in-range destinations rank by generation then numeric token ID.
    """
    seq, policy = observation.sequence, observation.policy
    base0 = seq.baseCurrency == seq.poolKey.currency0
    spot = quote_price(int(observation.sqrtPriceX96), base0)
    members = {p.position.digest(): p for p in observation.positions}
    source_ids = sorted({x.source.position for x in (*observation.balances, *observation.accruals)})
    live = [p.position for p in observation.positions if p.active]
    def in_range(p):
        return sqrt_at_tick(p.tickLower) <= int(observation.sqrtPriceX96) < sqrt_at_tick(p.tickUpper)
    def destination(p):
        return e1.Destination(createChild=False, tokenId=p.tokenId, tickLower=p.tickLower, tickUpper=p.tickUpper)
    def rank(p):
        return int(p.generation), int(p.tokenId)
    routes = []
    for source_id in source_ids:
        member = members[source_id]
        p = member.position
        floor, ceiling = price_range(p, base0)
        near = spot >= ceiling * Fraction(10000-policy.triggerDistanceBps, 10000)
        available = [q for q in live if q.tokenId != p.tokenId and in_range(q)]
        # An inactive historical source may spend retained fees, never collect;
        # it cannot become a new parent or receive additional liquidity.
        if member.active and in_range(p) and not near:
            chosen, action, reason = (destination(p),), 'compound_self', 'ordinary_source'
        elif not member.active or (not in_range(p) and spot <= floor):
            chosen = (destination(max(available, key=rank)),) if available else ()
            action, reason = ('redirect_fees', 'out_of_range_redirect') if chosen else ('wait', 'no_in_range_destination')
        else:
            child = [q for q in available if q.parentTokenId == p.tokenId and not q.isRoot
                     and price_range(q, base0)[1] > ceiling]
            higher = [q for q in available if price_range(q, base0)[1] > ceiling]
            if child or higher:
                chosen = (destination(max(child or higher, key=rank)),)
                action, reason = 'redirect_fees', 'eligible_successor'
            elif p.tokenId in pending_parents:
                chosen, action, reason = (), 'wait', 'pending_successor'
            elif any(q.parentTokenId == p.tokenId and not q.isRoot for q in live):
                chosen, action, reason = (), 'wait', 'existing_successor_not_eligible'
            elif len(live) >= policy.maxPositions:
                chosen = (destination(max(available, key=rank)),) if not in_range(p) and available else ()
                action, reason = ('redirect_fees', 'cap_existing_destination') if chosen else ('wait', 'position_cap')
            else:
                proposed = []
                for overlap in settings.overlapChoicesBps:
                    if overlap <= policy.maxOverlapBps:
                        try:
                            d = successor_range(observation, p, overlap)
                        except ValueError:
                            continue
                        if d not in proposed:
                            proposed.append(d)
                chosen, action, reason = tuple(proposed), 'create_domino', 'successor_geometry'
                if not chosen:
                    action, reason = 'wait', 'infeasible_successor_grid'
        routes.append(Routing(sourcePosition=source_id, action=action, destinations=chosen, reason=reason))
    return tuple(routes)


def _value(amounts, bands, *, upper=False):
    return sum(Fraction(n) * (band.upper if upper else band.lower).fraction() for n, band in zip(amounts, bands))


def _ceil(value):
    return -(-value.numerator // value.denominator)


def _groups(obs, sources):
    """Group original fees per original source for floor-rounded service cuts.
    Charged residuals are spent first without another cut; original lot IDs and
    collection source IDs survive the proposed allocation.
    """
    groups = {}
    active = {p.position.digest() for p in obs.positions if p.active}
    for b in obs.balances:
        if b.source.position in sources:
            key = (not b.convertedCharged, b.source.digest(), b.currency)
            groups.setdefault(key, []).append(('lot', b.lotId, int(b.amountRaw)-int(b.reservedRaw)))
    for a in obs.accruals:
        if a.source.position in sources and a.source.position in active:
            groups.setdefault((True, a.source.digest(), a.source.currency), []).append(('collection', a.source.digest(), int(a.amountRaw)))
    return [(key, sorted(rows)) for key, rows in sorted(groups.items())]


def _fund(groups, required, pair, fee_bps):
    remaining = list(required)
    allocations, collections = [], []
    gross, charged, cuts = [0, 0], [0, 0], [0, 0]
    for (original, _source, currency), rows in groups:
        i = pair.index(currency)
        available = sum(n for _, _, n in rows)
        rate = fee_bps if original else 0
        maximum_net = available-available*rate//10000
        wanted = min(remaining[i], maximum_net)
        lo, hi = 0, available
        while lo < hi:
            mid = (lo+hi)//2
            if mid-mid*rate//10000 < wanted:
                lo = mid+1
            else:
                hi = mid
        used = lo
        remaining[i] -= used-used*rate//10000
        (gross if original else charged)[i] += used
        cuts[i] += used*rate//10000
        for kind, identity, amount in rows:
            taken = min(amount, used)
            used -= taken
            if taken:
                if kind == 'lot':
                    allocations.append(e1.Allocation(lotId=identity, amountRaw=str(taken)))
                else:
                    collections.append(e1.CollectionBudget(sourceId=identity, maxGrossRaw=str(taken)))
    if any(remaining):
        return None
    return (tuple(sorted(allocations, key=lambda a:a.lotId)), tuple(sorted(collections, key=lambda a:a.sourceId)),
            tuple(gross), tuple(charged), tuple(cuts))


def _liquidity_amounts(obs, dest, liquidity):
    lower, upper = sqrt_at_tick(dest.tickLower), sqrt_at_tick(dest.tickUpper)
    spot = max(lower, min(upper, int(obs.sqrtPriceX96)))
    return (amount_delta(spot, upper, liquidity, 0, True),
            amount_delta(lower, spot, liquidity, 1, True))


def _earnings_rate(samples, prices):
    """Conservative *total pool fee flow*, never an unlimited rate per added L.
    Liquidity-time remains measured provenance; destination evidence independently
    bounds total and competing liquidity through the finite forecast horizon.
    """
    rates = []
    for a, b in zip(samples, samples[1:]):
        earned = (b.cumulativeFee0-a.cumulativeFee0, b.cumulativeFee1-a.cumulativeFee1)
        rates.append(_value(earned, prices) / (b.timestamp-a.timestamp))
    return min(rates) if rates else Fraction(0)


def _candidate(obs, settings, evidence, samples, sources, dest, depth, quote, now, liquidity_cap=None):
    pair = (obs.sequence.poolKey.currency0, obs.sequence.poolKey.currency1)
    groups = _groups(obs, set(sources))
    problems = []
    if depth is None or not depth.qualified:
        return None  # callers retain explicit missing-evidence reasons
    bounds = quote.bounds if quote else None
    incoming = [0, 0]
    outgoing = [0, 0]
    if quote:
        if {bounds.currencyIn, bounds.currencyOut} != set(pair):
            return None
        incoming[pair.index(bounds.currencyIn)] = int(bounds.amountInRaw)
        outgoing[pair.index(bounds.currencyOut)] = int(bounds.minAmountOutRaw)
        if (not quote.qualified or now > quote.expiresAt or quote.expiresAt > evidence.expiresAt
                or quote.priceImpactBps > obs.policy.limits.maxPriceImpactBps
                or quote.slippageBps > obs.policy.limits.maxSlippageBps):
            problems.append('swap_evidence_or_bounds')
    def required(liquidity):
        added = _liquidity_amounts(obs, dest, liquidity)
        return tuple(max(0, added[i]+incoming[i]-outgoing[i]) for i in range(2))
    # A swap must be fee funded even if its output would cover all liquidity.
    if _fund(groups, incoming, pair, obs.policy.serviceFeeBps) is None:
        return None
    lo, hi = 0, depth.maxLiquidityIncrease if liquidity_cap is None else liquidity_cap
    while lo < hi:
        mid = (lo+hi+1)//2
        if _fund(groups, required(mid), pair, obs.policy.serviceFeeBps) is None:
            hi = mid-1
        else:
            lo = mid
    added = _liquidity_amounts(obs, dest, lo)
    funded = _fund(groups, required(lo), pair, obs.policy.serviceFeeBps)
    allocations, collections, gross, charged, cuts = funded
    residual = tuple(max(0, outgoing[i]-added[i]) for i in range(2))
    if any(n >= 2**128 for n in (*gross, *charged, *added, *residual)) or any(gross[i]+charged[i] >= 2**128 for i in range(2)):
        problems.append('aggregate_currency_budget_overflow')
    swap_loss = max(Fraction(0), _value(incoming, evidence.prices, upper=True)-_value(outgoing, evidence.prices))
    # The added position also dilutes incumbent owner liquidity. For fixed
    # total T, owner O and new L n, the owner's share gain is
    # (O+n)/(T+n)-O/T = n*(T-O)/(T*(T+n)). Use conservative horizon bounds
    # Cmin <= T-O and Tmax >= T. A sole LP gains no share of fixed fee flow.
    share_gain = Fraction(lo*depth.minimumCompetingLiquidity,
                          depth.maximumTotalLiquidity*(depth.maximumTotalLiquidity+lo))
    earned = (_earnings_rate(samples, evidence.prices) * share_gain * obs.policy.limits.forecastHorizonSeconds
              * Fraction(depth.activeFractionBps, 10000) * Fraction(10000-settings.forecastHaircutBps, 10000))
    service_cost = _ceil(_value(cuts, evidence.prices, upper=True))
    owner_net = int(earned) - service_cost - _ceil(swap_loss) - depth.exposureLossQuote - depth.ownerPaidCostQuote
    revenue = int(_value(cuts, evidence.prices) * Fraction(settings.serviceRealizationBps, 10000))
    gas_wei, gas_quote = (quote.gasWei, quote.gasQuote) if quote else (depth.directGasWei, depth.directGasQuote)
    buffered = _ceil(Fraction(gas_quote*(10000+settings.operatorCostBufferBps), 10000))
    if gas_wei > int(obs.policy.limits.maxGasCostWei):
        problems.append('gas_cap')
    owner_pass = lo > 0 and owner_net > settings.minimumOwnerBenefitQuote
    operator_pass = revenue >= buffered
    if not owner_pass:
        problems.append('owner_benefit')
    if not operator_pass:
        problems.append('operator_cost')
    lot_sources = {b.lotId:b.source.position for b in obs.balances}
    collection_sources = {a.source.digest():a.source.position for a in obs.accruals}
    consumed_sources = tuple(sorted({lot_sources[a.lotId] for a in allocations}
                                   | {collection_sources[a.sourceId] for a in collections}))
    action = 'create_domino' if dest.createChild else ('compound_self' if len(consumed_sources) == 1 and
        next(p.position.tokenId for p in obs.positions if p.position.digest() == consumed_sources[0]) == dest.tokenId else 'redirect_fees')
    return Candidate(action=action, destination=dest, sources=consumed_sources, allocations=allocations,
        collections=collections, swap=bounds, liquidityIncrease=lo, grossConsumed=gross,
        chargedConsumed=charged, serviceCut=cuts, netAdded=added, convertedResidual=residual,
        economics=Economics(productiveQuote=int(_value(added, evidence.prices)), incrementalEarningsQuote=int(earned),
            serviceCostQuote=service_cost, swapLossQuote=_ceil(swap_loss), ownerNetBenefitQuote=owner_net,
            operatorRevenueQuote=revenue, operatorBufferedCostQuote=buffered,
            ownerPass=owner_pass, operatorPass=operator_pass), reasons=tuple(problems))


def plan(observation: e1.Observation, history: MeasurementHistory, settings: PlannerSettings,
         evidence: Evidence | None, *, now: int, pending_intent=False, pending_parents=frozenset()):
    """Recompute from all current inputs, compare with wait (zero incremental
    outcome), and return one reviewable candidate. Never constructs ExecutionPlan.
    """
    obs = e1.Observation.model_validate(observation.model_dump())
    history = MeasurementHistory.model_validate(history.model_dump())
    settings = PlannerSettings.model_validate(settings.model_dump())
    evidence = Evidence.model_validate(evidence.model_dump()) if evidence else None
    if type(now) is not int or now < history.lastAttemptAt or history.sequence != obs.sequence.digest():
        raise ValueError('invalid_planner_clock_or_sequence')
    if type(pending_intent) is not bool or type(pending_parents) is not frozenset or any(
            type(token) is not str or token not in {p.position.tokenId for p in obs.positions} for token in pending_parents):
        raise ValueError('invalid_pending_state')
    zero = (0, 0)
    waiting = Candidate(action='wait', destination=None, sources=(), allocations=(), collections=(), swap=None,
        liquidityIncrease=0, grossConsumed=zero, chargedConsumed=zero, serviceCut=zero, netAdded=zero,
        convertedResidual=zero, economics=Economics(productiveQuote=0, incrementalEarningsQuote=0,
        serviceCostQuote=0, swapLossQuote=0, ownerNetBenefitQuote=0, operatorRevenueQuote=0,
        operatorBufferedCostQuote=0, ownerPass=False, operatorPass=False), reasons=('waiting_baseline',))
    reasons = []
    if obs.policy.paused:
        reasons.append('paused')
    if pending_intent:
        reasons.append('pending_intent')
    if int(obs.stateNonce) == e1.U64_MAX or int(obs.authorityGeneration) == e1.U64_MAX:
        reasons.append('nonce_exhausted')
    if history.lastReadFailed:
        reasons.append('read_unavailable_history_retained')
    age = now-int(obs.blockTimestamp)
    if not obs.canonical or not obs.coverageComplete or not 0 <= age <= obs.policy.limits.maxObservationAgeSeconds:
        reasons.append('observation_stale_or_unqualified')
    if (not evidence or not evidence.qualified or evidence.observationHash != obs.digest()
            or now > evidence.expiresAt or evidence.expiresAt > int(obs.blockTimestamp)+obs.policy.limits.maxObservationAgeSeconds):
        reasons.append('evidence_missing_stale_or_unqualified')
    if evidence:
        quote_index = (obs.sequence.poolKey.currency0, obs.sequence.poolKey.currency1).index(obs.sequence.quoteCurrency)
        band = evidence.prices[quote_index]
        raw_price = quote_price(int(obs.sqrtPriceX96), True)
        if (band.lower.fraction() != 1 or band.upper.fraction() != 1
                or raw_price < evidence.prices[0].lower.fraction()/evidence.prices[1].upper.fraction()
                or raw_price > evidence.prices[0].upper.fraction()/evidence.prices[1].lower.fraction()):
            reasons.append('price_reference_mismatch')
    root = next(p for p in obs.positions if p.position.isRoot)
    if (not root.active or root.holder != obs.sequence.owner or root.individualApproval != obs.sequence.vault
            or not obs.operatorEnabled or any(p.active and not p.position.isRoot and p.holder != obs.sequence.vault for p in obs.positions)):
        reasons.append('custody_or_operator_unavailable')
    elapsed = now-history.waitingSince
    if elapsed < obs.policy.minimumIntervalSeconds:
        reasons.append('not_due')
    samples = tuple(s for s in history.samples if s.timestamp >= now-settings.maximumMeasurementSeconds)
    if (len(samples) < settings.minimumSamples or samples[-1].timestamp-samples[0].timestamp < settings.minimumSampleSeconds
            or now-samples[-1].timestamp > settings.maximumSampleAgeSeconds
            or any(not s.qualified or not s.coverageComplete or s.blockNumber > int(obs.blockNumber)
                   or s.timestamp > int(obs.blockTimestamp)
                   or (s.blockNumber == int(obs.blockNumber) and s.blockHash != obs.blockHash) for s in samples)):
        reasons.append('insufficient_qualified_fee_history')
    if obs.policy.limits.forecastHorizonSeconds > settings.maximumForecastSeconds:
        reasons.append('forecast_horizon_not_admitted')
    routes = route_sources(obs, settings, pending_parents)
    candidates = [waiting]
    if not reasons:
        groups = {}
        for route in routes:
            for destination in route.destinations:
                key = destination.digest()
                groups.setdefault(key, [destination, []])[1].append(route.sourcePosition)
        depths = {d.destination.digest(): d for d in evidence.destinations}
        for key, (dest, source_ids) in sorted(groups.items()):
            sources = tuple(sorted(source_ids))
            depth = depths.get(key)
            if depth is None or not depth.qualified:
                continue
            quotes = [None, *sorted((q for q in evidence.swaps if q.destination == dest), key=fingerprint)]
            for quote in quotes:
                candidate = _candidate(obs, settings, evidence, samples, sources, dest, depth, quote, now)
                if candidate is not None:
                    candidates.append(candidate)
                    # Fee-flow share is concave; consuming the largest possible
                    # amount can lose money while a smaller action is profitable.
                    # Compare explicit bounded quantity alternatives for every
                    # admitted direct/swap path. This is not a global optimizer.
                    quantities = {candidate.liquidityIncrease}
                    for fraction in reversed(settings.liquidityFractionChoicesBps[:-1]):
                        quantity = candidate.liquidityIncrease*fraction//10000
                        if quantity > 0 and quantity not in quantities:
                            quantities.add(quantity)
                            smaller = _candidate(obs, settings, evidence, samples, sources, dest, depth, quote, now, quantity)
                            if smaller is not None:
                                candidates.append(smaller)
    eligible = [i for i, c in enumerate(candidates) if i and not c.reasons]
    # First maximize conservative owner advantage; then deploy more productive
    # fees; prefer direct for an exact tie. No protocol-revenue tie breaker.
    selected = max(eligible, key=lambda i:(candidates[i].economics.ownerNetBenefitQuote,
                   candidates[i].economics.productiveQuote, candidates[i].swap is None, -i)) if eligible else 0
    if selected == 0 and not reasons:
        reasons.append('no_economically_qualified_candidate')
    chosen = candidates[selected]
    allocated = {a.lotId: int(a.amountRaw) for a in chosen.allocations}
    collected = {a.sourceId: int(a.maxGrossRaw) for a in chosen.collections}
    waiting_balances = []
    route_reasons = {r.sourcePosition:r.reason for r in routes if r.action == 'wait'}
    def waiting_reason(source):
        return reasons[0] if reasons else route_reasons.get(source.position, 'ratio_dust_or_alternative_not_selected')
    for b in obs.balances:
        available = int(b.amountRaw)-int(b.reservedRaw)-allocated.get(b.lotId, 0)
        if available:
            waiting_balances.append(WaitingBalance(source=b.source.digest(), currency=b.currency, origin='reserve',
                reference=b.lotId, amountRaw=available, reason=waiting_reason(b.source)))
        if int(b.reservedRaw):
            waiting_balances.append(WaitingBalance(source=b.source.digest(), currency=b.currency, origin='reserved',
                reference=b.lotId, amountRaw=int(b.reservedRaw), reason='reserved_pending_intent'))
    for a in obs.accruals:
        remaining = int(a.amountRaw)-collected.get(a.source.digest(), 0)
        if remaining:
            waiting_balances.append(WaitingBalance(source=a.source.digest(), currency=a.source.currency, origin='accrual_estimate',
                reference=a.checkpointId, amountRaw=remaining, reason=waiting_reason(a.source)))
    payload = {'observation': obs.model_dump(mode='json'), 'history': history.model_dump(mode='json'),
               'settings': settings.model_dump(mode='json'), 'evidence': evidence.model_dump(mode='json') if evidence else None,
               'now': now, 'pendingIntent': pending_intent, 'pendingParents': sorted(pending_parents)}
    input_hash = '0x'+sha256(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return Decision(inputFingerprint=input_hash, observationHash=obs.digest(), action=candidates[selected].action,
        selected=selected, candidates=tuple(candidates), routing=routes, waiting=tuple(waiting_balances), reasons=tuple(reasons),
        elapsedWaitSeconds=elapsed, forecastHorizonSeconds=obs.policy.limits.forecastHorizonSeconds)
