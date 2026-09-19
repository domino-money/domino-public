"""Independent E1 -> admitted V4 reconstruction; no browser calldata authority.

The source checkpoint and price observation are read at canonical pinned blocks
by the signer. A deterministic one-pool, one-source exact-input route is the
only registered swap. Unrepresentable E1 candidates fail closed.
"""
from collections import defaultdict
import re

from eth_abi import decode
from eth_abi.exceptions import DecodingError

import execution_models as m
import execution_v4 as v4
import general_compound_receipts as g
from execution_store import _model


def selected_positions(plan,observation):
    plan=_model(m.ExecutionPlan,plan);observation=_model(m.Observation,observation)
    accruals={a.source.digest():a for a in observation.accruals}
    members={p.position.digest():p.position for p in observation.positions}
    lots={b.lotId:b for b in observation.balances}
    selected={plan.destination.tokenId}
    for budget in plan.collections:selected.add(members[accruals[budget.sourceId].source.position].tokenId)
    for allocation in plan.allocations:selected.add(members[lots[allocation.lotId].source.position].tokenId)
    return tuple(sorted(selected,key=int))


def rebuild_v4(plan,observation,checkpoints,*,price_observation_id=m.ZERO_HASH):
    # Every action carries a published observation, swap or not: the anchor
    # binds the whole execution on chain, so a plan without one is refused
    # there and must be refused here, before anything is signed.
    if (type(price_observation_id) is not str or not re.fullmatch(r'0x[0-9a-f]{64}',price_observation_id)
            or price_observation_id==m.ZERO_HASH):
        raise ValueError('execution_price_observation_required')
    plan=_model(m.ExecutionPlan,plan);observation=_model(m.Observation,observation)
    m.validate_candidate(plan,observation,now=int(observation.blockTimestamp),actor=observation.operator)
    if plan.sequence.implementationVersion!='4':raise ValueError('execution_action_not_registered')
    members={p.position.tokenId:p.position for p in observation.positions}
    by_identity={p.digest():p for p in members.values()}
    accruals={a.source.digest():a for a in observation.accruals}
    lots={b.lotId:b for b in observation.balances}
    if type(checkpoints) is not dict or set(checkpoints)!=set(selected_positions(plan,observation)):
        raise ValueError('execution_checkpoint_mismatch')
    if any(type(point) is not str or not re.fullmatch(r'0x[0-9a-f]{64}',point) or point==m.ZERO_HASH for point in checkpoints.values()):
        raise ValueError('execution_checkpoint_mismatch')
    amounts=defaultdict(lambda:[0,0])
    floors=defaultdict(lambda:[0,0])
    collect={}
    for allocation in plan.allocations:
        lot=lots[allocation.lotId]
        amounts[(lot.source.digest(),lot.currency)][int(lot.convertedCharged)]+=int(allocation.amountRaw)
        floors[(lot.source.digest(),lot.currency)][int(lot.convertedCharged)]+=int(allocation.amountRaw)
    for budget in plan.collections:
        accrual=accruals[budget.sourceId];member=by_identity[accrual.source.position]
        if accrual.checkpointId!=checkpoints[member.tokenId]:raise ValueError('execution_checkpoint_mismatch')
        collect[member.tokenId]=v4.PositionRef(tokenId=member.tokenId,positionIdentity=member.digest(),checkpointId=accrual.checkpointId)
        amounts[(budget.sourceId,accrual.source.currency)][0]+=int(budget.maxGrossRaw)
    # The authority token is the existing destination, or the admitted parent
    # of a new successor. New child identity is measured from its receipt.
    member=members[plan.destination.tokenId]
    authority=g.CompoundPlan(intentId=plan.intent_id(),tokenId=member.tokenId,positionIdentity=member.digest(),
        checkpointId=checkpoints[member.tokenId],policyVersion=plan.expectedPolicyVersion,
        limitsVersion=observation.policy.limits.version,stateNonce=plan.expectedStateNonce,
        authorityGeneration=plan.expectedAuthorityGeneration,observedAtBlock=plan.sourceBlockNumber,
        observedBlockHash=plan.sourceBlockHash,observedAtTimestamp=observation.blockTimestamp,deadline=plan.deadline,
        liquidityIncrease=plan.liquidityIncrease,maxOriginal0='0',maxOriginal1='0',maxCharged0='0',maxCharged1='0',
        minAdded0=plan.minNetAdded0,minAdded1=plan.minNetAdded1,
        minSqrtPriceX96=plan.minSqrtPriceX96,maxSqrtPriceX96=plan.maxSqrtPriceX96)
    budgets=tuple(v4.FeeBudget(sourceId=source,currency=currency,maxOriginal=str(raw[0]),maxCharged=str(raw[1]),
            minOriginal=str(floors[(source,currency)][0]),minCharged=str(floors[(source,currency)][1]))
        for (source,currency),raw in sorted(amounts.items()))
    swap=v4.SwapPlan(sourceId=m.ZERO_HASH,currencyIn=m.ZERO,amountIn='0',maxOriginal='0',maxCharged='0',
        minAmountOut='0',sqrtPriceLimitX96='0',priceObservationId=price_observation_id)
    if plan.swap.enabled:
        if (plan.swap.adapterId!=v4.ADAPTER_ID or plan.swap.adapterVersion!=v4.ADAPTER_VERSION
                ):raise ValueError('execution_swap_not_registered')
        fee=observation.policy.serviceFeeBps;incoming=int(plan.swap.amountInRaw)
        # Stable sorted source selection; never split an input among identities
        # which the fixed V4 route cannot represent. Every candidate was already
        # explicitly selected by the immutable E1 allocations/collection caps.
        candidates=[b for b in budgets if b.currency==plan.swap.currencyIn and
            int(b.maxOriginal)-int(b.maxOriginal)*fee//10000+int(b.maxCharged)>=incoming]
        if not candidates:raise ValueError('execution_swap_source_unrepresentable')
        budget=candidates[0]
        zero_for_one=plan.swap.currencyIn==plan.sequence.poolKey.currency0
        limit=max(m.MIN_SQRT_RATIO+1,int(plan.minSqrtPriceX96)) if zero_for_one else min(m.MAX_SQRT_RATIO-1,int(plan.maxSqrtPriceX96))
        if (zero_for_one and limit>=int(observation.sqrtPriceX96)) or (not zero_for_one and limit<=int(observation.sqrtPriceX96)):
            raise ValueError('execution_swap_price_limit')
        swap=v4.SwapPlan(sourceId=budget.sourceId,currencyIn=budget.currency,amountIn=plan.swap.amountInRaw,
            maxOriginal=budget.maxOriginal,maxCharged=budget.maxCharged,minAmountOut=plan.swap.minAmountOutRaw,
            sqrtPriceLimitX96=str(limit),priceObservationId=price_observation_id)
        if v4.route_commitment(swap,plan.sequence.poolId)!=plan.swap.routeCommitment:
            raise ValueError('execution_swap_route_mismatch')
        if not any(b.sourceId==swap.sourceId and b.currency==plan.swap.currencyOut for b in budgets):
            budgets=tuple(sorted((*budgets,v4.FeeBudget(sourceId=swap.sourceId,currency=plan.swap.currencyOut,
                maxOriginal='0',maxCharged='0',minOriginal='0',minCharged='0')),key=lambda b:(b.sourceId,b.currency)))
    return v4.Plan(authority=authority,action=(plan.path if plan.action==1 else plan.action),
        destinationTokenId='0' if plan.action==3 else plan.destination.tokenId,
        tickLower=plan.destination.tickLower if plan.action==3 else 0,
        tickUpper=plan.destination.tickUpper if plan.action==3 else 0,
        # Carried from the signed plan, never chosen here.
        maxAdded0=plan.maxNetAdded0,maxAdded1=plan.maxNetAdded1,
        collect=tuple(collect[k] for k in sorted(collect,key=int)),budgets=budgets,swap=swap)


def decode_plan(calldata):
    """Decode only the registered selector and require canonical byte equality."""
    try:
        raw=g._hex(calldata)
        authority,action,destination,lower,upper,ceiling0,ceiling1,collect,budgets,swap=decode([v4.PLAN_TYPE],raw[4:])[0]
        record={name:'0x'+value.hex() if typ=='bytes32' else str(value)
            for (name,typ),value in zip(g.CompoundPlan.ABI,authority)}
        value=v4.Plan(authority=g.CompoundPlan.model_validate(record),action=action,destinationTokenId=str(destination),
            tickLower=lower,tickUpper=upper,maxAdded0=str(ceiling0),maxAdded1=str(ceiling1),
            collect=tuple(v4.PositionRef(tokenId=str(i),positionIdentity='0x'+p.hex(),checkpointId='0x'+c.hex()) for i,p,c in collect),
            budgets=tuple(v4.FeeBudget(sourceId='0x'+s.hex(),currency=c,maxOriginal=str(o),maxCharged=str(x),
                minOriginal=str(mo),minCharged=str(mx)) for s,c,o,x,mo,mx in budgets),
            swap=v4.SwapPlan(sourceId='0x'+swap[0].hex(),currencyIn=swap[1],amountIn=str(swap[2]),maxOriginal=str(swap[3]),
                maxCharged=str(swap[4]),minAmountOut=str(swap[5]),sqrtPriceLimitX96=str(swap[6]),priceObservationId='0x'+swap[7].hex()))
        if value.calldata()!=calldata:raise ValueError()
        return value
    except (ValueError,TypeError,IndexError,DecodingError):raise ValueError('execution_envelope_changed') from None


def qualify_price(verifier,admission,plan,observation,head,price_observation_id):
    """Bind independent publisher record, source block, expiry and reference.

    This is an admitted publisher trust boundary, not a proof of a manipulation-
    resistant external oracle. Deployment qualification must attest that source.
    """
    point=verifier._call(admission.priceGuard,'observations(bytes32)',
        ['bytes32','uint64','bytes32','uint64','uint64','uint160'],head,['bytes32'],[bytes.fromhex(price_observation_id[2:])])
    revoked=verifier._call(admission.priceGuard,'revoked(bytes32)',['bool'],head,['bytes32'],[bytes.fromhex(price_observation_id[2:])])[0]
    expected=(bytes.fromhex(plan.sequence.poolId[2:]),int(plan.sourceBlockNumber),bytes.fromhex(plan.sourceBlockHash[2:]),int(observation.blockTimestamp))
    if (point[:4]!=expected or revoked or not head['timestamp']<=point[4]<=int(observation.blockTimestamp)+3600
            or point[5]!=int(observation.sqrtPriceX96) or head['timestamp']-point[3]>observation.policy.limits.maxObservationAgeSeconds):
        raise ValueError('execution_price_observation_unqualified')
    reference=verifier._call(admission.priceGuard,'referencePrice(bytes32,bytes32,uint64,bytes32,uint32)',
        ['uint160'],head,['bytes32','bytes32','uint64','bytes32','uint32'],
        [bytes.fromhex(price_observation_id[2:]),expected[0],expected[1],expected[2],observation.policy.limits.maxObservationAgeSeconds])[0]
    if reference!=point[5]:raise ValueError('execution_price_observation_unqualified')
