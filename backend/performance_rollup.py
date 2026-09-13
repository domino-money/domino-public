"""Exact, bounded minute projections over immutable financial journal evidence.

Minutes store additive values and capital integrals, never sampled balances or
rounded averages. Prices remain causal and are fingerprinted again on delivery.
The rolling window's edge minutes are recomputed from raw deltas so moving its
start by one second never prorates a changing balance or an earning event.
"""
from bisect import bisect_right
from fractions import Fraction
import hashlib
import json
from typing import Annotated, Literal

from pydantic import Field, model_validator

from discovery import DataError, ZERO
from managed_performance import DAY, _decimal
from performance_collection import Baseline, Record, Number, Hash, Address
from performance_history import validate_history
from performance_history_projection import _Delta, _active, _included
from performance_valuation import ManagedValuation
from read_deadline import check_read_deadline

MINUTE = 60
MAX_BUCKETS = 1442
MAX_BUCKET_PAGES = 256
MAX_BUCKET_BYTES = 8_388_608
MAX_BUCKET_RECORDS = 20_000
Rational = Annotated[str,Field(pattern=r'^(0|[1-9][0-9]{0,511})/[1-9][0-9]{0,511}$')]
Reason = Annotated[str,Field(pattern=r'^[a-z][a-z0-9_]{0,95}$')]
SUMS = ('newTradingFeesUsd','actualServiceFeesUsd','reinvestedUsd','externalDepositsUsd','externalWithdrawalsUsd')


def fraction_text(value):
    value = Fraction(value)
    if value < 0 or max(value.numerator.bit_length(),value.denominator.bit_length())>1690:
        raise ValueError('projection_fraction_capacity')
    return f'{value.numerator}/{value.denominator}'


def bucket_at(timestamp):
    return max(0,(timestamp-1)//MINUTE*MINUTE)


class Summary(Record):
    version: Literal[1]
    owner: Address
    epochId: Hash
    replayGeneration: Annotated[Number,Field(ge=1)]
    bucket: Number
    startsAt: Number
    endsAt: Number
    priceFingerprint: Annotated[str,Field(pattern=r'^[0-9a-f]{64}$')]
    incomeComplete: bool
    capitalComplete: bool
    flowsComplete: bool
    reinvestmentComplete: bool
    hasGas: bool
    capitalIntegral: Rational
    sums: dict[str,Rational]
    issues: Annotated[list[Reason],Field(max_length=128)]

    @model_validator(mode='after')
    def coherent(self):
        if (self.bucket%MINUTE or not self.bucket<=self.startsAt<=self.endsAt<=self.bucket+MINUTE
                or set(self.sums)!=set(SUMS) or self.issues!=sorted(set(self.issues))
                or any(fraction_text(Fraction(value))!=value for value in [self.capitalIntegral,*self.sums.values()])):
            raise ValueError('projection_invalid_minute')
        return self


def price_fingerprint(valuation, start, end):
    """Causal inputs only: later observations outside this interval do not churn it."""
    if type(valuation) is not ManagedValuation: raise ValueError('projection_valuation_required')
    valuation._bounds(start,end)
    sources=[]
    for currency in sorted(valuation.currencies):
        check_read_deadline()
        try:
            asset=valuation._asset(currency)
            q=asset.qualification
            left=max(0,bisect_right(asset.times,start)-1)
            right=bisect_right(asset.times,end)
            points=[[at,fraction_text(value)] for at,value in zip(asset.times[left:right],asset.values[left:right])]
            sources.append([currency,q.decimals,q.source,q.evidence,q.max_age,points])
        except DataError as error:
            # Codes originate in the internal valuation adapter, never provider
            # messages. No qualification is inferred from a saved dollar value.
            sources.append([currency,'unavailable',str(error)])
    payload=[valuation.pool_id,start,end,sources]
    return hashlib.sha256(json.dumps(payload,separators=(',',':'),sort_keys=True).encode()).hexdigest()


def summarize(base, head, deltas, valuation, bucket, *, start=None, end=None):
    """One minute, at most256 pages; event-time values and integrals stay exact."""
    base=Baseline.model_validate(base.model_dump() if isinstance(base,Baseline) else base)
    state=validate_history(base,head['state'])
    start=max(base.baseline.timestamp,bucket) if start is None else start
    end=min(head['cursor']['timestamp'],bucket+MINUTE) if end is None else end
    if (type(bucket) is not int or bucket%MINUTE or not bucket<=start<=end<=bucket+MINUTE
            or not base.baseline.timestamp<=start<=end<=head['cursor']['timestamp']
            or type(deltas) is not list or len(deltas)>MAX_BUCKET_PAGES+1
            or valuation.pool_id!=base.opening.poolId
            or set(valuation.currencies)!=set(base.opening.currencies+[ZERO])):
        raise ValueError('projection_invalid_bucket_request')
    fingerprint=price_fingerprint(valuation,start,end)
    values={name:Fraction() for name in SUMS}; integral=Fraction()
    income=capital=flows=reinvested=True; gas=False; issues=set()
    if state.membershipAmbiguous or any(m.endsAt==m.startsAt for m in state.members):
        income=capital=False; issues.add('financial_membership_unprojectable')
    cursor=start; previous=None; seen=set(); records=0; covered=False
    for raw in deltas:
        check_read_deadline()
        delta=_Delta.model_validate(raw)
        if ((delta.owner,delta.epochId,delta.vault,delta.replayGeneration)!=(base.owner,base.epochId,base.vault,head['replayGeneration'])
                or previous is not None and delta.fromCursor!=previous):
            raise ValueError('projection_delta_identity_or_order_mismatch')
        part_cursor=delta.fromCursor
        for part in delta.slices:
            if part.from_!=part_cursor: raise ValueError('projection_noncontiguous_slices')
            part_cursor=part.through
            a,b=max(start,part.from_.timestamp),min(end,part.through.timestamp)
            if a<b:
                covered=True
                expected={None}|{m.tokenId for m in state.members if _active(m,part.from_.timestamp)}
                components={c.tokenId:c.amountsRaw for c in part.capital}
                qualified=part.capitalComplete and a==cursor and set(components)==expected
                for token,amounts in components.items():
                    currencies=set(base.opening.currencies)|({ZERO} if token is None else set())
                    if amounts is None or set(amounts)!=currencies:
                        qualified=False; continue
                    valued=valuation.value_capital_interval(amounts,a,b)
                    if valued.status!='qualified':
                        qualified=False; issues.add(valued.reason or 'capital_coverage_incomplete')
                    elif qualified:
                        integral+=valued.integral_usd_seconds
                capital &= qualified
                cursor=b
            if not _included(part.through.timestamp,part.through.blockNumber,start,base.baseline) or part.through.timestamp>end:
                continue
            # An opening exactly on a minute boundary has a zero-duration first
            # bucket. Later blocks in that opening second belong there once,
            # rather than also to the next minute whose start is the baseline.
            if (part.through.timestamp==start==base.baseline.timestamp
                    and bucket!=bucket_at(base.baseline.timestamp)):
                continue
            income &= part.incomeComplete; flows &= part.externalFlowsComplete
            issues.update(part.issues); gas |= bool(part.gasEvidence)
            for category,rows in (('newTradingFeesUsd',part.credits),('actualServiceFeesUsd',part.serviceDebits),
                    ('reinvestedUsd',part.reinvestments),('flows',part.externalFlows)):
                records+=len(rows)
                if records>MAX_BUCKET_RECORDS: raise ValueError('projection_record_budget')
                for row in rows:
                    if row.currency not in set(base.opening.currencies+[ZERO]): raise ValueError('projection_foreign_currency')
                    if row.tokenId is not None:
                        member=next((m for m in state.members if m.tokenId==row.tokenId),None)
                        if (member is None or row.timestamp<member.startsAt
                                or member.endsAt is not None and row.timestamp>member.endsAt):
                            raise ValueError('projection_fact_outside_member_lifetime')
                    identity=(getattr(row,'eventId',None) or (row.kind,row.transactionHash,row.sourceId,row.currency,row.receiptLogIndex))
                    if identity in seen: raise ValueError('projection_duplicate_event')
                    seen.add(identity)
                    selected=('externalDepositsUsd' if row.kind=='external_deposit' else 'externalWithdrawalsUsd') if category=='flows' else category
                    valued=valuation.value_amount(row.currency,row.raw,row.timestamp)
                    if valued.value_usd is None:
                        issues.add(valued.reason or 'fee_or_cost_price_unqualified')
                        if category in ('newTradingFeesUsd','actualServiceFeesUsd'): income=False
                        elif category=='flows': flows=False
                        else: reinvested=False
                    else: values[selected]+=valued.value_usd
        if part_cursor!=delta.throughCursor: raise ValueError('projection_delta_cursor_mismatch')
        previous=part_cursor
    if cursor!=end or end>start and not covered:
        capital=income=False; issues.add('financial_projection_pending')
    if not capital: issues.add('capital_coverage_incomplete')
    return Summary(version=1,owner=base.owner,epochId=base.epochId,replayGeneration=head['replayGeneration'],
        bucket=bucket,startsAt=start,endsAt=end,priceFingerprint=fingerprint,incomeComplete=income,
        capitalComplete=capital,flowsComplete=flows,reinvestmentComplete=reinvested,hasGas=gas,
        capitalIntegral=fraction_text(integral),sums={key:fraction_text(value) for key,value in values.items()},issues=sorted(issues))


def project(bundle, valuation, now):
    """Deliver saved minute facts plus exact edge minutes, bounded by1442 rows."""
    epoch,head=bundle['epoch'],bundle['financial']; base=Baseline.model_validate(epoch['baseline'])
    end=head['cursor']['timestamp'] if head else base.baseline.timestamp
    start=max(base.baseline.timestamp,end-DAY); seconds=end-start
    values={name:Fraction() for name in SUMS}; integral=Fraction()
    income=capital=flows=reinvested=head is not None; gas=False; issues=set(); dirty=[]
    canonical=head is not None and epoch['status'] not in ('replaying','baseline_reorged') and head['lastError'] not in ('financial_reorg_detected','financial_receipt_changed')
    if not canonical: issues.add('canonical_financial_evidence_invalidated')
    rows=bundle['summaries']; edges=bundle['edges']; cursor=start
    if len(rows)+len(edges)>MAX_BUCKETS: raise ValueError('projection_bucket_budget')
    for item in sorted([*rows,*edges],key=lambda row:row['bucket']):
        a,b=max(start,item['bucket']),min(end,item['bucket']+MINUTE)
        if b<a: continue
        if 'deltas' in item:
            summary=summarize(base,head,item['deltas'],valuation,item['bucket'],start=a,end=b)
        else:
            summary=Summary.model_validate(item['summary'])
            if ((summary.owner,summary.epochId,summary.replayGeneration,summary.startsAt,summary.endsAt)!=
                    (base.owner,base.epochId,epoch['replayGeneration'],a,b)):
                raise ValueError('projection_summary_identity_mismatch')
            if item['dirty'] or summary.priceFingerprint!=price_fingerprint(valuation,a,b):
                dirty.append(item['bucket']); income=capital=flows=reinvested=False
                issues.add('performance_price_qualification_changed')
                continue
        if summary.startsAt!=cursor:
            income=capital=False; issues.add('financial_projection_pending')
        cursor=summary.endsAt
        income &= summary.incomeComplete; capital &= summary.capitalComplete
        flows &= summary.flowsComplete; reinvested &= summary.reinvestmentComplete
        gas |= summary.hasGas; issues.update(summary.issues)
        integral+=Fraction(summary.capitalIntegral)
        for key in SUMS: values[key]+=Fraction(summary.sums[key])
    if cursor!=end or bundle.get('missingBuckets'):
        income=capital=False; issues.add('financial_projection_pending')
    average=integral/seconds if seconds and capital and canonical else None
    net=values['newTradingFeesUsd']-values['actualServiceFeesUsd'] if income and canonical else None
    failed=epoch['status']=='read_failed' or bool(head and head['lastError'])
    behind=bool(head and head['cursor']!=epoch['cursor'])
    stale=now-end>120 or failed
    if stale: issues.add('financial_latest_read_failed' if failed else 'snapshot_stale')
    if behind: issues.add('financial_collection_behind_raw')
    if seconds<DAY: issues.add('measuring_first_24h')
    if average==0: issues.add('zero_time_weighted_capital')
    complete=seconds==DAY and income and capital and canonical and average is not None and average>0 and not (stale or behind or dirty)
    status=('unavailable' if not canonical else 'stale' if stale else 'partial' if not income or not capital or behind
            else 'unavailable' if average==0 else 'available' if complete else 'measuring')
    performance={'status':status,'issues':sorted(issues),'complete24h':complete,
        'newTradingFeesUsd':_decimal(values['newTradingFeesUsd']) if income and canonical else None,
        'actualServiceFeesUsd':_decimal(values['actualServiceFeesUsd']) if income and canonical else None,
        'otherStrategyCostsUsd':_decimal(0) if income and canonical else None,'netFeeIncomeUsd':_decimal(net),
        'timeWeightedCapitalUsd':_decimal(average),
        'grossFeeAprPercent':_decimal(36500*values['newTradingFeesUsd']/average) if complete else None,
        'netFeeAprPercent':_decimal(36500*net/average) if complete else None,
        'operatorCostsUsd':None,'operatorCostsReason':'full_l2_cost_unqualified' if gas else 'operator_cost_evidence_incomplete'}
    return {'owner':base.owner,'epochId':base.epochId,'rawRevision':epoch['revision'],'replayGeneration':epoch['replayGeneration'],
        'financialRevision':head['revision'] if head else None,'financialCursor':head['cursor'] if head else base.baseline.model_dump(),
        'windowStart':start,'windowEnd':end,'performance':performance,'projectionIssues':sorted(issues),
        'externalDepositsUsd':_decimal(values['externalDepositsUsd']) if flows and canonical else None,
        'externalWithdrawalsUsd':_decimal(values['externalWithdrawalsUsd']) if flows and canonical else None,
        'reinvestedUsd':_decimal(values['reinvestedUsd']) if reinvested and income and canonical else None,
        'externalFlowCoverage':{'complete':flows and canonical},'dirtyBuckets':dirty,'executionAvailable':False}
