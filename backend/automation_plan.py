"""From the planner's chosen candidate to the persistable ExecutionPlan.

The planner returns a reviewable candidate; the intent store and the signer
consume an E1 plan. This is the missing link, and it proves its own output
before anyone persists it: the plan must pass the offline candidate check and
the V4 wire must rebuild from it, so what is reserved is what can be signed.
The observation the publisher will attest is derived here too, with the exact
id the guard will assign, so the intent binds its anchor before publication.
"""
from eth_abi import encode
from eth_hash.auto import keccak

import execution_models as m
from automation_config import price_bounds
from execution_v4_adapter import rebuild_v4, selected_positions
from v4_math import MIN_SQRT, MAX_SQRT, amount_delta, sqrt_at_tick

ACTIONS = {'compound_self': 1, 'redirect_fees': 2, 'create_domino': 3}
OBSERVATION_TYPE = '(bytes32,uint64,bytes32,uint64,uint64,uint160)'
PUBLISH_SIGNATURE = 'publish(' + OBSERVATION_TYPE + ')'
PRICE_OBSERVED = '0x' + keccak(b'PriceObserved(bytes32,bytes32,uint64,uint64)').hex()
# Nonzero, and never published: it only proves the wire rebuilds from the plan.
PLACEHOLDER_OBSERVATION = '0x' + 'ff' * 32
DISABLED_SWAP = m.SwapBounds(enabled=False, adapterId=m.ZERO_HASH, adapterVersion='0', routeCommitment=m.ZERO_HASH,
                             currencyIn=m.ZERO, currencyOut=m.ZERO, amountInRaw='0', minAmountOutRaw='0')


class PlanError(ValueError):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def checkpoints_for(ctx, plan):
    try:
        return {token: ctx.checkpoints[token] for token in selected_positions(plan, ctx.observation)}
    except KeyError:
        raise PlanError('automation_checkpoint_missing') from None


def _tolerance(amount, bps, *, up):
    return amount * (10000 + bps) // 10000 if up else amount * (10000 - bps) // 10000


def addition_amounts(destination, sqrt_price, liquidity):
    """What one add of `liquidity` costs per currency at `sqrt_price`, rounded
    up as the manager settles it."""
    lower, upper = sqrt_at_tick(destination.tickLower), sqrt_at_tick(destination.tickUpper)
    spot = max(lower, min(upper, sqrt_price))
    return amount_delta(spot, upper, liquidity, 0, True), amount_delta(lower, spot, liquidity, 1, True)


def size_addition(ctx, candidate, plan_policy, *, reader=None, state_view=None, max_steps=64):
    """The liquidity the plan commits to and the amounts it will cost.

    The planner sizes its candidate to spend the selected funds exactly at the
    observed price. The execution adds liquidity after its own swap moved the
    price, and settles with round-up: an exact plan is short by a few units
    and the engine refuses it. So the plan re-simulates the swap, sizes the
    addition at the price it leaves, keeps the configured slack, and checks the
    M-2 bound - the whole actual output must fit inside the addition - before
    committing. A swap whose output cannot be consumed is not representable.
    """
    obs = ctx.observation
    dest = candidate.destination
    liquidity = candidate.liquidityIncrease
    spot = int(obs.sqrtPriceX96)
    slack = plan_policy.liquiditySlackBps
    if candidate.swap is None:
        sized = max(1, liquidity * (10000 - slack) // 10000)
        return sized, addition_amounts(dest, spot, sized)
    pair = (obs.sequence.poolKey.currency0, obs.sequence.poolKey.currency1)
    swap = candidate.swap
    into, out = pair.index(swap.currencyIn), pair.index(swap.currencyOut)
    amount_in, minimum_out = int(swap.amountInRaw), int(swap.minAmountOutRaw)
    after, actual_out = spot, minimum_out
    if reader is not None:
        from automation_evidence import simulate_exact_input
        limits = obs.policy.limits
        lower, upper = price_bounds(spot, plan_policy.priceBandSqrtBps, limits.maxPriceImpactBps)
        zero_for_one = into == 0
        limit = max(MIN_SQRT + 1, lower) if zero_for_one else min(MAX_SQRT - 1, upper)
        result = simulate_exact_input(reader, state_view, obs.sequence.poolKey, obs.sequence.poolId, ctx.pool, ctx.block,
                                      zero_for_one=zero_for_one, amount_in=amount_in, price_limit=limit, max_steps=max_steps)
        if result is None or result['amountOut'] < minimum_out:
            raise PlanError('automation_swap_unfillable')
        after, actual_out = result['afterPrice'], result['amountOut']
    # Funds the execution will hold for the addition: the planner's requirement
    # per currency, with the swap input gone and the actual output arrived.
    available = list(candidate.netAdded)
    available[out] = available[out] - minimum_out + actual_out
    fee = obs.policy.serviceFeeBps
    lots = {b.lotId: b for b in obs.balances}
    output_floor = actual_out
    for allocation in candidate.allocations:
        lot = lots[allocation.lotId]
        if lot.currency == swap.currencyOut:
            n = int(allocation.amountRaw)
            output_floor += n if lot.convertedCharged else n - n * fee // 10000
    def fits(size):
        needs = addition_amounts(dest, after, size)
        return needs[into] <= available[into] and needs[out] <= available[out]
    low, high = 0, liquidity
    while low < high:
        mid = (low + high + 1) // 2
        if fits(mid):
            low = mid
        else:
            high = mid - 1
    for sized in (max(1, low * (10000 - slack) // 10000), low):
        needs = addition_amounts(dest, after, sized)
        if sized > 0 and fits(sized) and needs[out] >= output_floor:
            return sized, needs
    raise PlanError('automation_swap_output_not_consumable')


def build_execution_plan(ctx, candidate, *, plan_policy, gas_cap_wei, reader=None, state_view=None, max_steps=64):
    """The E1 plan for one non-waiting candidate, verified offline and against
    the V4 wire. Floors and ceilings on the addition follow the owner's own
    slippage limit around the amounts the execution will actually settle."""
    obs = ctx.observation
    if candidate.action not in ACTIONS or candidate.destination is None:
        raise PlanError('automation_candidate_not_executable')
    limits = obs.policy.limits
    lower, upper = price_bounds(int(obs.sqrtPriceX96), plan_policy.priceBandSqrtBps, limits.maxPriceImpactBps)
    deadline = int(obs.blockTimestamp) + min(plan_policy.deadlineSeconds, limits.maxObservationAgeSeconds)
    slippage = limits.maxSlippageBps
    liquidity, needs = size_addition(ctx, candidate, plan_policy, reader=reader, state_view=state_view, max_steps=max_steps)
    fields = dict(sequence=obs.sequence, policyHash=obs.policy.digest(), observationHash=obs.digest(),
        action=ACTIONS[candidate.action], path=0, expectedPolicyVersion=obs.policy.version, expectedStateNonce=obs.stateNonce,
        expectedAuthorityGeneration=obs.authorityGeneration, sourceBlockNumber=obs.blockNumber, sourceBlockHash=obs.blockHash,
        deadline=str(deadline), allocations=candidate.allocations, collections=candidate.collections,
        destination=candidate.destination, liquidityIncrease=str(liquidity),
        maxGrossFee0=str(candidate.grossConsumed[0]), maxGrossFee1=str(candidate.grossConsumed[1]),
        maxChargedInput0=str(candidate.chargedConsumed[0]), maxChargedInput1=str(candidate.chargedConsumed[1]),
        minNetAdded0=str(_tolerance(needs[0], slippage, up=False)), minNetAdded1=str(_tolerance(needs[1], slippage, up=False)),
        maxNetAdded0=str(_tolerance(needs[0], slippage, up=True)), maxNetAdded1=str(_tolerance(needs[1], slippage, up=True)),
        minSqrtPriceX96=str(lower), maxSqrtPriceX96=str(upper),
        maxGasCostWei=str(min(int(limits.maxGasCostWei), int(gas_cap_wei))), swap=candidate.swap or DISABLED_SWAP)
    # A one-sided floor of zero on the empty side is legitimate; both zero is
    # refused by the model and would be by the wire. Keep at least one unit
    # where the simulation put value, so a moved price cannot zero the plan.
    if fields['minNetAdded0'] == fields['minNetAdded1'] == '0':
        side = 0 if needs[0] >= needs[1] else 1
        fields['minNetAdded' + str(side)] = '1'
    plans = []
    if plan_policy.preferNetPath and fields['action'] == 1 and not fields['swap'].enabled and not candidate.allocations:
        plans.append({**fields, 'path': 1})
    plans.append(fields)
    failure = None
    for attempt in plans:
        try:
            plan = m.ExecutionPlan(**attempt)
            m.validate_candidate(plan, obs, now=int(obs.blockTimestamp), actor=obs.operator)
            rebuild_v4(plan, obs, checkpoints_for(ctx, plan), price_observation_id=PLACEHOLDER_OBSERVATION)
            return plan
        except (ValueError, PlanError) as error:
            failure = error
    raise PlanError('automation_plan_unrepresentable') from failure


def observation_point(ctx, plan):
    """The guard's Observation for this plan: its source block, the price the
    plan was made at, and the plan's deadline as the anchor's expiry."""
    obs = ctx.observation
    if plan.sourceBlockHash != obs.blockHash or plan.observationHash != obs.digest():
        raise PlanError('automation_plan_observation_mismatch')
    return (bytes.fromhex(obs.sequence.poolId[2:]), int(plan.sourceBlockNumber), bytes.fromhex(plan.sourceBlockHash[2:]),
            int(obs.blockTimestamp), int(plan.deadline), int(obs.sqrtPriceX96))


def observation_id(guard, point):
    """keccak256(abi.encode("DominoPriceObservationV1", chainid, guard, point)), as the guard computes it."""
    return '0x' + keccak(encode(['string', 'uint256', 'address', OBSERVATION_TYPE], ['DominoPriceObservationV1', 4663, guard, tuple(point)])).hex()


def publish_calldata(point):
    return '0x' + (keccak(PUBLISH_SIGNATURE.encode())[:4] + encode([OBSERVATION_TYPE], [tuple(point)])).hex()
