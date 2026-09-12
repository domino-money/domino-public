"""Offline fee-performance calculator for an explicit forward management epoch.

This module does not discover NFTs, authenticate owners, validate chain proofs or
collect receipts/prices. Its trusted collector must reconcile canonical, complete
fee-credit evidence and all capital (including idle/out-of-range assets), bind it
to the owner/epoch, and invalidate it on reorg. A current NFT balance or a provider
APR cannot supply that evidence. These are internal inputs, not a public API.

The window is (max(epoch start, snapshot time - 24 hours), snapshot time]. Fees
are token quantities valued at their recorded earning/attribution timestamp,
never USD balance differences. Opening fees, donations and internal movements do
not become income. Capital uses fully covered piecewise-constant valuations;
the collector must split at every balance/price/membership change. Actual charges
are recognized when paid, including charges on older fees. No future service fee
is accrued. Operator-funded costs are separate and never deducted from the owner.
Membership is half-open for capital, but a final fee/charge at its closing second
is allowed. The collector must use receipt/log order to bind such closing events
to this epoch before ownership changes; a timestamp alone cannot prove ownership.
"""
from fractions import Fraction
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StrictInt


DAY = 86_400
MAX_SNAPSHOT_AGE = 120
Address = Annotated[str, Field(pattern=r'^0x[0-9a-f]{40}$')]
Hash = Annotated[str, Field(pattern=r'^0x[0-9a-f]{64}$')]
Identifier = Annotated[str, Field(pattern=r'^[A-Za-z0-9:_-]{1,160}$')]
Timestamp = Annotated[StrictInt, Field(ge=0, le=2**53 - 1)]
UIntString = Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,77})$')]
UsdString = Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,77})(\.[0-9]{1,18})?$')]


class EvidenceModel(BaseModel):
    model_config = ConfigDict(extra='forbid', strict=True)


class Snapshot(EvidenceModel):
    blockNumber: Timestamp
    blockHash: Hash
    timestamp: Timestamp
    canonicality: Literal['verified', 'unverified', 'reorged']


class Membership(EvidenceModel):
    tokenId: UIntString
    startsAt: Timestamp
    endsAt: Timestamp | None = None


class Price(EvidenceModel):
    sourceId: Identifier
    status: Literal['qualified', 'unqualified', 'unavailable']
    timestamp: Timestamp
    validUntil: Timestamp
    usdPerToken: UsdString | None


class ValuedAmount(EvidenceModel):
    currency: Address
    decimals: Annotated[StrictInt, Field(ge=0, le=255)]
    raw: UIntString
    price: Price


class CapitalComponent(EvidenceModel):
    # null is the one epoch-owned residual bucket, separate from NFT assets.
    tokenId: UIntString | None
    valueUsd: UsdString | None


class CapitalSegment(EvidenceModel):
    startsAt: Timestamp
    endsAt: Timestamp
    valuationStatus: Literal['qualified', 'unqualified', 'unavailable']
    components: Annotated[list[CapitalComponent], Field(max_length=65)]


class FeeCredit(EvidenceModel):
    eventId: Identifier
    feeOriginId: Identifier
    epochId: Identifier
    tokenId: UIntString
    timestamp: Timestamp
    kind: Literal['new_trading_fee', 'opening_fee', 'internal_transfer', 'donation']
    amount: ValuedAmount


class CostDebit(EvidenceModel):
    eventId: Identifier
    epochId: Identifier
    tokenId: UIntString | None
    timestamp: Timestamp
    kind: Literal['service_fee', 'dex_fee', 'network_gas']
    payer: Literal['strategy', 'operator']
    amount: ValuedAmount


class PerformanceEvidence(EvidenceModel):
    chainId: Literal[4663]
    epochId: Identifier
    scope: Literal['nft', 'sequence']
    owner: Address
    positionManager: Address
    startedAt: Timestamp
    snapshot: Snapshot
    coverageStart: Timestamp
    incomeCoverage: Literal['complete', 'partial', 'unavailable']
    capitalScope: Literal['all_position_assets_and_epoch_residual_once']
    members: Annotated[list[Membership], Field(min_length=1, max_length=64)]
    capital: Annotated[list[CapitalSegment], Field(max_length=4096)]
    credits: Annotated[list[FeeCredit], Field(max_length=20000)]
    debits: Annotated[list[CostDebit], Field(max_length=20000)]


def _decimal(value):
    """Deterministic 18-place truncation, with signed amounts and no float path."""
    if value is None:
        return None
    value = Fraction(value)
    scaled = abs(value.numerator) * 10**18 // value.denominator
    whole, fractional = divmod(scaled, 10**18)
    sign = '-' if value < 0 and scaled else ''
    return f'{sign}{whole}.{fractional:018d}'


def _raw(value):
    result = int(value)
    if result >= 2**256:
        raise ValueError('uint256_out_of_bounds')
    return result


def _active(member, at):
    return member.startsAt <= at and (member.endsAt is None or at < member.endsAt)


def _value(amount, at):
    price = amount.price
    if (price.status != 'qualified' or price.usdPerToken is None or
            not price.timestamp <= at <= price.validUntil):
        return None
    return Fraction(_raw(amount.raw), 10**amount.decimals) * Fraction(price.usdPerToken)


def _validate(evidence, now):
    if type(now) is not int or now < evidence.snapshot.timestamp:
        raise ValueError('invalid_calculation_time')
    if type(evidence.chainId) is not int:
        raise ValueError('invalid_chain_id')
    end = evidence.snapshot.timestamp
    if not evidence.startedAt <= evidence.coverageStart <= end:
        raise ValueError('invalid_epoch_coverage')
    members = {m.tokenId: m for m in evidence.members}
    if len(members) != len(evidence.members) or (evidence.scope == 'nft' and len(members) != 1):
        raise ValueError('invalid_member_set')
    for member in members.values():
        _raw(member.tokenId)
        if not evidence.startedAt <= member.startsAt <= end or (
                member.endsAt is not None and not member.startsAt < member.endsAt <= end):
            raise ValueError('invalid_member_lifetime')
    if min(m.startsAt for m in members.values()) != evidence.startedAt:
        raise ValueError('missing_epoch_opening_member')
    events, origins, decimals = set(), set(), {}
    for record in [*evidence.credits, *evidence.debits]:
        if record.eventId in events:
            raise ValueError('duplicate_event')
        events.add(record.eventId)
        if record.epochId != evidence.epochId:
            raise ValueError('cross_epoch_event')
        if not evidence.startedAt <= record.timestamp <= end:
            raise ValueError('event_outside_epoch')
        if record.tokenId is not None and (
                record.tokenId not in members or
                record.timestamp < members[record.tokenId].startsAt or
                (members[record.tokenId].endsAt is not None and
                 record.timestamp > members[record.tokenId].endsAt)):
            raise ValueError('event_outside_member_lifetime')
        amount, price = record.amount, record.amount.price
        _raw(amount.raw)
        if amount.currency in decimals and decimals[amount.currency] != amount.decimals:
            raise ValueError('currency_decimals_mismatch')
        decimals[amount.currency] = amount.decimals
        if price.validUntil < price.timestamp or (
                price.usdPerToken is not None and Fraction(price.usdPerToken) <= 0):
            raise ValueError('invalid_price')
        if isinstance(record, FeeCredit):
            # A lot has one primary classification. Moving it may reference the
            # origin again, but cannot turn opening fees or donations into income.
            if record.kind != 'internal_transfer':
                key = (record.feeOriginId, amount.currency)
                if key in origins:
                    raise ValueError('duplicate_fee_origin')
                origins.add(key)
            if record.kind == 'opening_fee' and record.timestamp != evidence.startedAt:
                raise ValueError('opening_fee_outside_baseline')
        elif record.kind == 'service_fee' and record.payer != 'strategy':
            raise ValueError('invalid_service_fee_payer')
    last_end = evidence.startedAt
    for segment in evidence.capital:
        if not last_end <= segment.startsAt < segment.endsAt <= end:
            raise ValueError('overlapping_or_invalid_capital_segment')
        if segment.startsAt < evidence.startedAt:
            raise ValueError('capital_outside_epoch')
        last_end = segment.endsAt
        expected = {None} | {m.tokenId for m in members.values() if _active(m, segment.startsAt)}
        actual = [component.tokenId for component in segment.components]
        if set(actual) != expected or len(set(actual)) != len(actual):
            raise ValueError('capital_component_set_mismatch')
        if any(segment.startsAt < boundary < segment.endsAt
               for member in members.values() for boundary in (member.startsAt, member.endsAt)
               if boundary is not None):
            raise ValueError('capital_crosses_member_boundary')
    return members


def validate_performance_evidence(evidence, *, now):
    """Validate input shape and cross-record semantics, without proving evidence."""
    if isinstance(evidence, PerformanceEvidence):
        evidence = evidence.model_dump()
    e = PerformanceEvidence.model_validate(evidence)
    _validate(e, now)
    return e


def calculate_performance(evidence, *, now):
    """Return exact dated metrics; missing evidence never means zero revenue.

    ``evidence`` is a dict or PerformanceEvidence. This function revalidates model
    instances too. A production collector and authenticated owner binding are
    prerequisites to exposing these figures as actual managed position metrics.
    """
    e = validate_performance_evidence(evidence, now=now)
    end = e.snapshot.timestamp
    start = max(e.startedAt, end - DAY)
    seconds = end - start
    issues = []
    canonical = e.snapshot.canonicality == 'verified'
    if not canonical:
        issues.append('canonical_evidence_' + e.snapshot.canonicality)
    stale = now - end > MAX_SNAPSHOT_AGE
    if stale:
        issues.append('snapshot_stale')
    income_ok = e.incomeCoverage == 'complete' and e.coverageStart <= start
    if not income_ok:
        issues.append('income_coverage_incomplete')
    sums = {'newTradingFeesUsd': Fraction(), 'actualServiceFeesUsd': Fraction(),
            'otherStrategyCostsUsd': Fraction(), 'operatorCostsUsd': Fraction()}
    amounts_ok, operator_costs_ok = income_ok, income_ok
    for credit in e.credits:
        if start < credit.timestamp <= end and credit.kind == 'new_trading_fee':
            value = _value(credit.amount, credit.timestamp)
            if value is None:
                amounts_ok = False
            else:
                sums['newTradingFeesUsd'] += value
    for debit in e.debits:
        if start < debit.timestamp <= end:
            value = _value(debit.amount, debit.timestamp)
            if value is None:
                if debit.payer == 'operator':
                    operator_costs_ok = False
                else:
                    amounts_ok = False
            else:
                key = ('operatorCostsUsd' if debit.payer == 'operator' else
                       'actualServiceFeesUsd' if debit.kind == 'service_fee' else 'otherStrategyCostsUsd')
                sums[key] += value
    if income_ok and not amounts_ok:
        issues.append('fee_or_cost_price_unqualified')
    cursor, integral = start, Fraction()
    capital_ok = seconds > 0
    for segment in e.capital:
        a, b = max(start, segment.startsAt), min(end, segment.endsAt)
        if a >= b:
            continue
        if a != cursor or segment.valuationStatus != 'qualified' or any(
                component.valueUsd is None for component in segment.components):
            capital_ok = False
        else:
            integral += sum((Fraction(c.valueUsd) for c in segment.components), Fraction()) * (b - a)
        cursor = b
    if cursor != end or not capital_ok:
        capital_ok = False
        issues.append('capital_coverage_incomplete')
    average = integral / seconds if capital_ok and canonical else None
    if average == 0:
        issues.append('zero_time_weighted_capital')
    net = (sums['newTradingFeesUsd'] - sums['actualServiceFeesUsd'] - sums['otherStrategyCostsUsd']
           if amounts_ok and canonical else None)
    full_day = seconds == DAY
    if not full_day:
        issues.append('measuring_first_24h')
    apr_ready = not issues
    status = ('unavailable' if not canonical else 'stale' if stale else
              'partial' if not amounts_ok or not capital_ok else
              'unavailable' if average == 0 else 'measuring' if not full_day else 'available')
    return {
        'methodologyVersion': 1, 'mode': 'offline_managed_performance',
        'chainId': e.chainId, 'epochId': e.epochId, 'scope': e.scope,
        'owner': e.owner, 'positionManager': e.positionManager,
        'snapshot': e.snapshot.model_dump(), 'status': status, 'issues': issues,
        'windowStart': start, 'windowEnd': end, 'observedSeconds': seconds,
        'complete24h': full_day and capital_ok and amounts_ok and canonical,
        'incomeCoverage': 'complete' if income_ok else (
            'partial' if e.incomeCoverage == 'complete' else e.incomeCoverage),
        'capitalCoverage': 'complete' if capital_ok else 'partial' if e.capital else 'unavailable',
        **{key: _decimal(value) if amounts_ok and canonical else None
           for key, value in sums.items() if key != 'operatorCostsUsd'},
        'operatorCostsUsd': _decimal(sums['operatorCostsUsd']) if operator_costs_ok and canonical else None,
        'operatorCostsReason': None if operator_costs_ok and canonical else 'operator_cost_evidence_incomplete',
        'netFeeIncomeUsd': _decimal(net), 'timeWeightedCapitalUsd': _decimal(average),
        'grossFeeAprPercent': _decimal(36500 * sums['newTradingFeesUsd'] / average) if apr_ready else None,
        'netFeeAprPercent': _decimal(36500 * net / average) if apr_ready else None,
        'annualizationDays': 365, 'isApy': False, 'includesTokenPricePnl': False,
        'decimalPlaces': 18, 'roundingMode': 'towards_zero',
        'feeBasis': 'new_trading_credits_less_actual_strategy_costs_in_same_window',
        'capitalBasis': 'time_weighted_all_position_assets_and_epoch_residual_once',
        'priceConvention': 'qualified_causal_price_at_credit_or_debit_timestamp',
        'liveCollectorImplemented': False, 'executionAvailable': False,
    }
