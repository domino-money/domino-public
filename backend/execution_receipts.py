"""E1 plan/effect consistency boundary; not an RPC receipt verifier or executor.

E4/E5 must independently produce the canonical measured source ledger/effects.
This module compares those supplied effects with the arithmetic projection and
the immutable plan. It cannot establish that any supplied fact happened on-chain.
"""
from collections import defaultdict
from typing import Annotated

from pydantic import BaseModel, ConfigDict, Field

import execution_models as m
from execution_accounting import reconcile_consumption, SwapReceipt


class EffectRecord(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True, frozen=True)


class SourceEffect(EffectRecord):
    sourceId: m.Identity
    currency: m.Address
    originalBeforeRaw: m.Raw128
    chargedBeforeRaw: m.Raw128
    grossOriginalRaw: m.Raw128
    chargedInputRaw: m.Raw128
    serviceFeeRaw: m.Raw128
    liquidityFromInputRaw: m.Raw128
    liquidityFromSwapRaw: m.Raw128
    swapInRaw: m.Raw128
    swapOutRaw: m.Raw128
    originalAfterRaw: m.Raw128
    chargedAfterRaw: m.Raw128


class PlanEffects(EffectRecord):
    intentId: m.Identity
    transactionHash: m.Identity
    blockNumber: m.Raw64
    blockHash: m.Identity
    blockTimestamp: m.Raw64
    canonical: bool
    serviceFeeRecipient: m.Account
    destinationTokenId: m.Raw256
    tickLower: m.Tick
    tickUpper: m.Tick
    liquidityIncrease: m.Raw128
    collections: Annotated[tuple[m.FeeCredit, ...], Field(max_length=4096)]
    balances: Annotated[tuple[SourceEffect, ...], Field(min_length=1, max_length=4096)]
    swaps: Annotated[tuple[SwapReceipt, ...], Field(max_length=1)]


def validate_balance_lineage(observation, credits, converted):
    """Bind a snapshot's remaining rows to distinct original/conversion origins.

    These are supplied historical records, not fetching or database uniqueness.
    Converted lineage links identities only: it contains no actual output amount
    or proof of atomic input debit and cannot certify a converted spend balance.
    E5 must keep such origins nonreservable until E4/E7 effect verification, and
    persist the same keys atomically with spent/withdrawn tombstones retained.
    """
    observation = m.revalidate_record(m.Observation, observation)
    if any(type(values) not in (tuple, list) or len(values) > 4096 for values in (credits, converted)):
        raise ValueError('invalid_lineage_vector')
    credits = [m.revalidate_record(m.FeeCredit, c) for c in credits]
    converted = [m.revalidate_record(m.ConvertedLotLineage, c) for c in converted]
    by_credit = {c.credit_id(): c for c in credits}
    by_conversion = {c.allocation_id(): c for c in converted}
    if len(by_credit) != len(credits) or len(by_conversion) != len(converted):
        raise ValueError('duplicate_lineage_origin')
    for balance in observation.balances:
        if balance.convertedCharged:
            origin = by_conversion.get(balance.reconciliationId)
            if origin is None or origin.source != balance.source.digest() or origin.currency != balance.currency:
                raise ValueError('converted_lineage_mismatch')
        else:
            origin = by_credit.get(balance.reconciliationId)
            if (origin is None or origin.source != balance.source.digest() or not origin.canonical
                    or int(balance.amountRaw) > int(origin.amountRaw)):
                raise ValueError('original_credit_lineage_mismatch')


def reconcile_plan_effects(plan, observation, effects, *, actor):
    """Reject shortfalls, extra spending, swap-only outcomes and altered balances.

    A valid estimate can fund a candidate. An actual realization below its exact
    input/minimum addition must fail here and MUST revert atomically in E4; there
    is no principal, donation, other source or external-wallet top-up parameter.
    The caller must not apply an ambiguous/reverted receipt or a supplied object
    without independent chain verification. No state is mutated by this check.
    """
    plan = m.revalidate_record(m.ExecutionPlan, plan)
    observation = m.revalidate_record(m.Observation, observation)
    effects = m.revalidate_record(PlanEffects, effects)
    m.validate_candidate(plan, observation, now=int(effects.blockTimestamp), actor=actor)
    if (effects.intentId != plan.intent_id() or not effects.canonical
            or int(effects.blockNumber) < int(plan.sourceBlockNumber)
            or effects.serviceFeeRecipient != plan.sequence.serviceFeeRecipient):
        raise ValueError('receipt_identity_mismatch')
    if (effects.tickLower, effects.tickUpper, effects.liquidityIncrease) != (
            plan.destination.tickLower, plan.destination.tickUpper, plan.liquidityIncrease):
        raise ValueError('receipt_liquidity_commitment_mismatch')
    if effects.destinationTokenId == '0':
        raise ValueError('receipt_destination_mismatch')
    if plan.destination.createChild:
        if effects.destinationTokenId in {p.position.tokenId for p in observation.positions}:
            raise ValueError('receipt_destination_mismatch')
    elif effects.destinationTokenId != plan.destination.tokenId:
        raise ValueError('receipt_destination_mismatch')

    rows = {(b.sourceId, b.currency): b for b in effects.balances}
    if len(rows) != len(effects.balances):
        raise ValueError('duplicate_source_effect')
    lots = [{'lotId': b.lotId, 'sourceId': b.source.digest(), 'currency': b.currency,
             'chargeStatus': 'converted_charged' if b.convertedCharged else 'original_uncharged',
             'amountRaw': b.amountRaw, 'reservedRaw': b.reservedRaw} for b in observation.balances]
    allocations = [a.model_dump() for a in plan.allocations]
    by_lot = {b.lotId: b for b in observation.balances}
    original_allocated = defaultdict(int)
    for a in plan.allocations:
        b = by_lot[a.lotId]
        if not b.convertedCharged:
            original_allocated[(b.source.digest(), b.currency)] += int(a.amountRaw)
    accruals = {a.source.digest(): a for a in observation.accruals}
    caps = {c.sourceId: int(c.maxGrossRaw) for c in plan.collections}
    credits_by_source, realized = defaultdict(list), defaultdict(int)
    credit_ids = set()
    existing_origins = {b.reconciliationId for b in observation.balances}
    for c in effects.collections:
        if (c.source not in caps or not c.canonical or c.transactionHash != effects.transactionHash
                or c.blockNumber != effects.blockNumber or c.blockHash != effects.blockHash):
            raise ValueError('realized_collection_identity_mismatch')
        credit_id = c.credit_id()
        if credit_id in credit_ids or credit_id in by_lot or credit_id in existing_origins:
            raise ValueError('duplicate_realized_credit')
        credit_ids.add(credit_id)
        credits_by_source[c.source].append(c)
        currency = accruals[c.source].source.currency
        realized[(c.source, currency)] += int(c.amountRaw)
        lots.append({'lotId': credit_id, 'sourceId': c.source, 'currency': currency,
                     'chargeStatus': 'original_uncharged', 'amountRaw': c.amountRaw, 'reservedRaw': '0'})
    for source, cap in caps.items():
        currency = accruals[source].source.currency
        key = (source, currency)
        row = rows.get(key)
        used = int(row.grossOriginalRaw) - original_allocated[key] if row else 0
        if used < 0 or used > cap or used > realized[key]:
            raise ValueError('realized_collection_shortfall_or_cap')
        # Canonical, receipt-local oldest credit first. Excess stays original and
        # uncharged; it cannot silently enlarge the plan's consumption budget.
        for c in sorted(credits_by_source[source], key=lambda c: c.eventIndex):
            amount = min(used, int(c.amountRaw))
            if amount:
                allocations.append({'lotId': c.credit_id(), 'amountRaw': str(amount)})
                used -= amount

    if bool(effects.swaps) != plan.swap.enabled:
        raise ValueError('receipt_swap_presence_mismatch')
    if effects.swaps:
        swap = effects.swaps[0]
        if ((swap.currencyIn, swap.currencyOut) != (plan.swap.currencyIn, plan.swap.currencyOut)
                or sum(int(i.amountInRaw) for i in swap.inputs) != int(plan.swap.amountInRaw)
                or int(swap.amountOutRaw) < int(plan.swap.minAmountOutRaw)):
            raise ValueError('receipt_swap_bounds_mismatch')
    dispositions = [{'sourceId': r.sourceId, 'currency': r.currency,
                     'liquidityFromInputRaw': r.liquidityFromInputRaw,
                     'liquidityFromSwapRaw': r.liquidityFromSwapRaw} for r in effects.balances
                    if int(r.grossOriginalRaw) or int(r.chargedInputRaw) or int(r.swapInRaw) or int(r.swapOutRaw)]
    projected = reconcile_consumption(lots, allocations, dispositions,
        service_fee_bps=observation.policy.serviceFeeBps, swaps=[s.model_dump() for s in effects.swaps])
    if set(rows) != {(b['sourceId'], b['currency']) for b in projected['balances']}:
        raise ValueError('receipt_source_set_mismatch')
    additions = defaultdict(int)
    for p in projected['balances']:
        key = (p['sourceId'], p['currency'])
        r = rows[key]
        for field in ('originalBeforeRaw', 'chargedBeforeRaw', 'grossOriginalRaw', 'chargedInputRaw',
                      'serviceFeeRaw', 'swapInRaw', 'swapOutRaw', 'originalAfterRaw', 'chargedAfterRaw'):
            expected = int(p[field])
            if field == 'originalBeforeRaw':
                expected -= realized[key]  # supplied starting ledger precedes this receipt's collection
            if int(getattr(r, field)) != expected:
                raise ValueError('receipt_measured_effect_mismatch')
        additions[r.currency] += int(p['liquidityAddedRaw'])
    pair = (plan.sequence.poolKey.currency0, plan.sequence.poolKey.currency1)
    if (additions[pair[0]] < int(plan.minNetAdded0) or additions[pair[1]] < int(plan.minNetAdded1)
            or not any(additions.values())):
        raise ValueError('receipt_minimum_addition_shortfall')
    return projected
