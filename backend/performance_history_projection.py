"""Pure private projection of persisted financial history and qualified prices.

The financial store/collector establishes canonical observations and reductions.
This boundary checks their identity, generation, order and complete-window shape;
it does not turn browser JSON, receipt gas products or collections into income.
All model inputs use exact finite decimals. Public performance-v1 stays unchanged.
"""
from fractions import Fraction
import json
from typing import Annotated, Literal

from pydantic import Field, model_validator

from discovery import DataError, ZERO
import managed_performance as calculator
from performance_collection import Address, Baseline, Cursor, Hash, Number, Raw, Record, TokenId
from performance_financial_collection import FinancialPoint
from performance_valuation import ManagedValuation, exact_decimal
from read_deadline import check_read_deadline

MAX_PAGES = 4096
MAX_BYTES = 16_777_216
MAX_RECORDS = 20_000
MAX_SEGMENTS = 4096
Positive = Annotated[Number, Field(ge=1)]
Reason = Annotated[str, Field(pattern=r'^[a-z][a-z0-9_]{0,95}$')]


class _Lifetime(Record):
    tokenId: TokenId
    startsAt: Number
    endsAt: Number | None


class _State(Record):
    methodologyVersion: Literal[1]
    owner: Address
    epochId: Hash
    vault: Address
    startedAt: Number
    cursor: Cursor
    lastPoint: FinancialPoint
    members: Annotated[list[_Lifetime], Field(min_length=1, max_length=64)]
    membershipAmbiguous: bool
    knownTokenIds: Annotated[list[TokenId], Field(min_length=1, max_length=64)]
    cumulativeKnown: dict[str, dict[str, Raw]]
    incompleteBlocks: Number


class _Epoch(Record):
    owner: Address
    epochId: Hash
    baseline: Baseline
    cursor: Cursor
    revision: Positive
    replayGeneration: Positive
    status: Literal['active', 'read_failed', 'replaying', 'baseline_reorged']
    lastError: Reason | None
    pageCount: Number
    receiptCount: Number
    eventCount: Number
    createdAt: Number
    updatedAt: Number


class _Head(Record):
    owner: Address
    epochId: Hash
    replayGeneration: Positive
    revision: Positive
    rawRevision: Positive
    cursor: Cursor
    opening: FinancialPoint
    state: _State
    lastError: Reason | None
    updatedAt: Number


class _Amount(Record):
    tokenId: TokenId | None
    currency: Address
    timestamp: Number
    blockNumber: Number | None = None
    raw: Raw


class _Credit(_Amount):
    eventId: Hash
    feeOriginId: Hash
    tokenId: TokenId
    kind: Literal['new_trading_fee']


class _SourceAmount(_Amount):
    tokenId: TokenId
    sourceId: Hash
    transactionHash: Hash
    receiptLogIndex: Number | None = None


class _Service(_SourceAmount):
    eventId: Hash
    kind: Literal['service_fee']
    payer: Literal['strategy']


class _Realization(_SourceAmount):
    kind: Literal['realized_accrual']


class _Reinvestment(_SourceAmount):
    kind: Literal['reinvestment']


class _Flow(_Amount):
    eventId: Hash
    transactionHash: Hash
    kind: Literal['external_deposit', 'external_withdrawal']


class _Capital(Record):
    tokenId: TokenId | None
    amountsRaw: dict[Address, Raw] | None


class _Gas(Record):
    transactionHash: Hash
    payer: Address
    gasUsedRaw: Raw
    effectiveGasPriceRaw: Raw
    receiptGasProductWei: Annotated[str, Field(pattern=r'^(0|[1-9][0-9]{0,154})$')]
    fullL2CostWei: Literal[None]
    strategyDebitApplied: Literal[False]


class _Slice(Record):
    from_: Cursor = Field(alias='from')
    through: Cursor
    incomeComplete: bool
    issues: Annotated[list[Reason], Field(max_length=128)]
    capitalComplete: bool
    capital: Annotated[list[_Capital], Field(max_length=65)]
    credits: Annotated[list[_Credit], Field(max_length=MAX_RECORDS)]
    serviceDebits: Annotated[list[_Service], Field(max_length=MAX_RECORDS)]
    unclassifiedAccrual: Annotated[list[dict], Field(max_length=MAX_RECORDS)] = []
    realizations: Annotated[list[_Realization], Field(max_length=MAX_RECORDS)]
    reinvestments: Annotated[list[_Reinvestment], Field(max_length=MAX_RECORDS)]
    externalFlows: Annotated[list[_Flow], Field(max_length=MAX_RECORDS)]
    # Current collector has no gross native-flow proof, even when net flow is
    # zero. Legacy rows therefore also default to explicitly incomplete flows.
    externalFlowsComplete: bool = False
    externalFlowsReason: Reason | None = 'native_gross_flows_unavailable'
    changes: Annotated[list[dict], Field(max_length=MAX_RECORDS)]
    gasEvidence: Annotated[list[_Gas], Field(max_length=MAX_RECORDS)]

    @model_validator(mode='after')
    def coherent(self):
        if (self.through.blockNumber != self.from_.blockNumber+1
                or self.through.parentHash != self.from_.blockHash
                or self.through.timestamp < self.from_.timestamp
                or self.incomeComplete != (not self.issues)
                or self.incomeComplete and self.unclassifiedAccrual
                or self.externalFlowsComplete != (self.externalFlowsReason is None)):
            raise ValueError('projection_invalid_slice')
        ids = [c.tokenId for c in self.capital]
        if (len(set(ids)) != len(ids) or ids.count(None) != 1
                or self.capitalComplete and any(c.amountsRaw is None for c in self.capital)):
            raise ValueError('projection_invalid_capital_set')
        for row in [*self.credits,*self.serviceDebits,*self.realizations,*self.reinvestments,*self.externalFlows]:
            if row.timestamp != self.through.timestamp or row.blockNumber not in (None,self.through.blockNumber):
                raise ValueError('projection_fact_location_mismatch')
        for gas in self.gasEvidence:
            if int(gas.receiptGasProductWei) != int(gas.gasUsedRaw)*int(gas.effectiveGasPriceRaw):
                raise ValueError('projection_invalid_gas_product')
        return self


class _Delta(Record):
    methodologyVersion: Literal[1]
    replayGeneration: Positive
    owner: Address
    epochId: Hash
    vault: Address
    fromCursor: Cursor
    throughCursor: Cursor
    slices: Annotated[list[_Slice], Field(min_length=1, max_length=16)]


class _Bundle(Record):
    epoch: _Epoch
    financial: _Head | None
    deltas: Annotated[list[_Delta], Field(max_length=MAX_PAGES)]


def _bounded(value):
    def walk(part, depth=0):
        check_read_deadline()
        if depth > 24:
            raise ValueError('projection_payload_budget')
        if type(part) is dict:
            if len(part) > 256 or any(type(k) is not str for k in part):
                raise ValueError('projection_payload_budget')
            for child in part.values(): walk(child,depth+1)
        elif type(part) is list:
            if len(part) > MAX_RECORDS:
                raise ValueError('projection_payload_budget')
            for child in part: walk(child,depth+1)
        elif part is not None and type(part) not in (str,int,bool):
            raise ValueError('projection_invalid_json')
    walk(value)
    if len(json.dumps(value,allow_nan=False,separators=(',',':')).encode()) > MAX_BYTES:
        raise ValueError('projection_payload_budget')


def _active(member, timestamp):
    return member.startsAt <= timestamp and (member.endsAt is None or timestamp < member.endsAt)


def _included(timestamp, block, start, opening):
    return timestamp > start or (start == opening.timestamp == timestamp and block > opening.blockNumber)


def _validate(bundle, now):
    if type(now) is not int or not 0 <= now <= 2**53-1:
        raise ValueError('invalid_calculation_time')
    epoch, head = bundle.epoch, bundle.financial
    base = epoch.baseline
    if ((epoch.owner,epoch.epochId) != (base.owner,base.epochId)
            or epoch.cursor.blockNumber < base.baseline.blockNumber
            or epoch.cursor.timestamp < base.baseline.timestamp
            or epoch.cursor.blockNumber == base.baseline.blockNumber and epoch.cursor != base.baseline
            or now < epoch.cursor.timestamp):
        raise ValueError('projection_epoch_identity_mismatch')
    if head is None:
        if bundle.deltas:
            raise ValueError('projection_missing_financial_head')
        return [],False
    state = head.state
    if ((head.owner,head.epochId,head.replayGeneration) != (base.owner,base.epochId,epoch.replayGeneration)
            or head.rawRevision > epoch.revision
            or (state.owner,state.epochId,state.vault,state.startedAt) != (base.owner,base.epochId,base.vault,base.baseline.timestamp)
            or head.cursor != state.cursor or head.cursor != state.lastPoint.block
            or (head.opening.owner,head.opening.epochId,head.opening.vault,head.opening.block) !=
               (base.owner,base.epochId,base.vault,base.baseline)
            or (state.lastPoint.owner,state.lastPoint.epochId,state.lastPoint.vault) != (base.owner,base.epochId,base.vault)
            or head.opening.currencies != base.opening.currencies or state.lastPoint.currencies != base.opening.currencies
            or not base.baseline.blockNumber <= head.cursor.blockNumber <= epoch.cursor.blockNumber
            or not base.baseline.timestamp <= head.cursor.timestamp <= epoch.cursor.timestamp
            or head.cursor.blockNumber == epoch.cursor.blockNumber and head.cursor != epoch.cursor
            or state.knownTokenIds != sorted(set(state.knownTokenIds),key=int)
            or not set(base.tokenIds) <= set(state.knownTokenIds)
            or [m.tokenId for m in head.opening.members] != base.tokenIds
            or [m.tokenId for m in state.lastPoint.members] != state.knownTokenIds
            or len({m.tokenId for m in state.members}) != len(state.members)):
        raise ValueError('projection_financial_identity_mismatch')
    if (head.opening.status != 'complete'
            or any(getattr(head.opening,field) != getattr(base.opening,field)
                   for field in ('heldRaw','accountedRaw','nativeHeldRaw'))
            or any(any(getattr(observed,field) != value for field,value in original.model_dump().items())
                   for observed,original in zip(head.opening.members,base.opening.members))):
        raise ValueError('projection_opening_observation_mismatch')
    start = max(base.baseline.timestamp,head.cursor.timestamp-calculator.DAY)
    members = state.members
    if (not {m.tokenId for m in members} <= set(state.knownTokenIds)
            or min(m.startsAt for m in members) != base.baseline.timestamp
            or any(not base.baseline.timestamp <= m.startsAt <= head.cursor.timestamp or
                   m.endsAt is not None and not m.startsAt <= m.endsAt <= head.cursor.timestamp for m in members)):
        raise ValueError('projection_member_lifetime_mismatch')
    membership_ok = not state.membershipAmbiguous and not any(m.endsAt == m.startsAt for m in members)
    slices, previous = [],None
    records = 0
    for delta in bundle.deltas:
        if ((delta.owner,delta.epochId,delta.vault,delta.replayGeneration) !=
                (base.owner,base.epochId,base.vault,epoch.replayGeneration)
                or previous is not None and delta.fromCursor != previous):
            raise ValueError('projection_delta_identity_or_order_mismatch')
        cursor = delta.fromCursor
        for part in delta.slices:
            if part.from_ != cursor:
                raise ValueError('projection_noncontiguous_slices')
            for component in part.capital:
                expected = set(base.opening.currencies) | ({ZERO} if component.tokenId is None else set())
                if (component.tokenId is not None and component.tokenId not in state.knownTokenIds
                        or component.amountsRaw is not None and set(component.amountsRaw) != expected):
                    raise ValueError('projection_capital_denomination_mismatch')
            cursor = part.through
            records += sum(len(getattr(part,name)) for name in ('credits','serviceDebits','realizations',
                'reinvestments','externalFlows','changes','gasEvidence','unclassifiedAccrual'))
            if records > MAX_RECORDS:
                raise ValueError('projection_record_budget')
            slices.append(part)
        if cursor != delta.throughCursor:
            raise ValueError('projection_delta_cursor_mismatch')
        previous = cursor
    if slices:
        first = slices[0].from_
        if (previous != head.cursor or first.blockNumber < base.baseline.blockNumber
                or first.timestamp > start or first.timestamp < base.baseline.timestamp
                or start == base.baseline.timestamp and first != base.baseline):
            raise ValueError('projection_incomplete_window')
    elif head.cursor != base.baseline:
        raise ValueError('projection_incomplete_window')
    return slices,membership_ok


def _amount(valuation, row, block):
    result = valuation.value_amount(row.currency,row.raw,row.timestamp)
    price = result.price
    model = {'currency':row.currency,'decimals':None,'raw':row.raw,
        'price':{'sourceId':'unavailable','status':'unavailable','timestamp':row.timestamp,
                 'validUntil':row.timestamp,'usdPerToken':None}}
    if price is not None:
        model['decimals'] = price.denomination.decimals
        model['price'] = {'sourceId':price.source,'status':'qualified','timestamp':price.observed_at,
            'validUntil':min(valuation.end,price.expires_at,
                price.next_observation_at-1 if price.next_observation_at is not None else valuation.end),
            'usdPerToken':exact_decimal(price.usd_per_token)}
    record = row.model_dump()
    record['blockNumber'] = block
    record['valuation'] = {'status':result.status,'reason':result.reason,
        'valueUsd':exact_decimal(result.value_usd) if result.value_usd is not None else None,
        'denomination':None if price is None else {'chainId':price.denomination.chain_id,
            'currency':price.denomination.currency,'decimals':price.denomination.decimals,'quote':'USD'}}
    return model,record,result.value_usd


def _capital(slices,members,valuation,start,end,issues):
    result = []
    for part in slices:
        a,b = max(start,part.from_.timestamp),min(end,part.through.timestamp)
        if a >= b:
            continue
        check_read_deadline()
        try:
            bounds = {a,b} | set(valuation.boundaries(a,b))
        except DataError as error:
            if str(error) != 'performance_price_boundary_budget_exhausted':
                raise
            issues.add(str(error))
            return []
        bounds.update(t for member in members for t in (member.startsAt,member.endsAt) if t is not None and a<t<b)
        amounts = {c.tokenId:c.amountsRaw for c in part.capital}
        ordered = sorted(bounds)
        for left,right in zip(ordered,ordered[1:]):
            expected = [None]+[m.tokenId for m in members if _active(m,left)]
            complete = part.capitalComplete and set(expected)==set(amounts)
            components = []
            for token in expected:
                value = None
                if complete and amounts[token] is not None:
                    valued = valuation.value_capital_interval(amounts[token],left,right)
                    if valued.status == 'qualified':
                        # Union boundaries make this a constant-valued interval.
                        value = valued.integral_usd_seconds/(right-left)
                    else:
                        complete = False
                        issues.add(valued.reason)
                components.append({'tokenId':token,'valueUsd':exact_decimal(value) if value is not None else None})
            segment = {'startsAt':left,'endsAt':right,'valuationStatus':'qualified' if complete else 'unavailable',
                       'components':components}
            # Coalescing identical adjacent values is exact, after checking every
            # original boundary; differing prices/assets are never sampled away.
            if result and result[-1]['endsAt']==left and result[-1]['valuationStatus']==segment['valuationStatus'] and result[-1]['components']==components:
                result[-1]['endsAt'] = right
            else:
                result.append(segment)
            if len(result)>MAX_SEGMENTS:
                issues.add('financial_projection_segment_budget')
                return []
    return result


def build_financial_projection(bundle, valuation, now):
    """Conditional sequence metrics; this result is never a performance-v1 card."""
    check_read_deadline()
    if isinstance(bundle,_Bundle):
        bundle = bundle.model_dump(by_alias=True)
    _bounded(bundle)
    data = _Bundle.model_validate(bundle)
    slices,membership_ok = _validate(data,now)
    epoch,head,base = data.epoch,data.financial,data.epoch.baseline
    cursor = head.cursor if head else base.baseline
    start,end = max(base.baseline.timestamp,cursor.timestamp-calculator.DAY),cursor.timestamp
    issues = set()
    financial_reorg = bool(head and head.lastError in ('financial_reorg_detected','financial_receipt_changed'))
    canonical = head is not None and epoch.status not in ('replaying','baseline_reorged') and not financial_reorg
    if financial_reorg: issues.add('canonical_financial_evidence_invalidated')
    if head and (type(valuation) is not ManagedValuation or valuation.pool_id != base.opening.poolId
            or not valuation.start <= start <= end <= valuation.end
            or not set(base.opening.currencies+[ZERO]) <= set(valuation.currencies)):
        raise ValueError('projection_valuation_identity_mismatch')
    members = head.state.members if head and membership_ok else [_Lifetime(tokenId=t,startsAt=base.baseline.timestamp,endsAt=None) for t in base.tokenIds]
    if head is None: issues.add('financial_history_unavailable')
    if head is not None and not membership_ok: issues.add('financial_membership_unprojectable')
    credits,debits = [],[]
    known = {name:[] for name in ('tradingAccrual','serviceFees','realized','reinvested','externalDeposits','externalWithdrawals')}
    raw_totals = {name:{} for name in known}
    values = {name:Fraction() for name in ('reinvested','externalDeposits','externalWithdrawals')}
    valued_complete = {name:True for name in values}
    origins,event_ids,source_records,gas_ids = set(),set(),set(),set()
    gas,changes,unclassified = [],[],[]
    income_complete = head is not None and membership_ok
    flows_complete = head is not None
    flow_reasons = set()
    for part in slices:
        check_read_deadline()
        included = _included(part.through.timestamp,part.through.blockNumber,start,base.baseline)
        if not included:
            continue
        income_complete = income_complete and part.incomeComplete
        flows_complete = flows_complete and part.externalFlowsComplete
        if part.externalFlowsReason: flow_reasons.add(part.externalFlowsReason)
        issues.update(part.issues)
        changes.extend(part.changes)
        unclassified.extend(part.unclassifiedAccrual)
        for category,rows in (('tradingAccrual',part.credits),('serviceFees',part.serviceDebits),
                ('realized',part.realizations),('reinvested',part.reinvestments),('flows',part.externalFlows)):
            for row in rows:
                if row.currency not in set(base.opening.currencies+[ZERO]):
                    raise ValueError('projection_foreign_currency')
                if row.tokenId is not None and row.tokenId not in head.state.knownTokenIds:
                    raise ValueError('projection_foreign_member')
                if membership_ok and row.tokenId is not None:
                    member = next((m for m in members if m.tokenId==row.tokenId),None)
                    if (member is None or row.timestamp < member.startsAt
                            or member.endsAt is not None and row.timestamp > member.endsAt):
                        raise ValueError('projection_fact_outside_member_lifetime')
                event_id = getattr(row,'eventId',None)
                if event_id is not None:
                    if event_id in event_ids: raise ValueError('projection_duplicate_event')
                    event_ids.add(event_id)
                else:
                    key = (row.kind,row.transactionHash,row.sourceId,row.currency,row.receiptLogIndex)
                    if key in source_records: raise ValueError('projection_duplicate_source_fact')
                    source_records.add(key)
                if category=='tradingAccrual':
                    key = (row.feeOriginId,row.currency)
                    if key in origins: raise ValueError('projection_duplicate_origin')
                    origins.add(key)
                category_ = ('externalDeposits' if row.kind=='external_deposit' else 'externalWithdrawals') if category=='flows' else category
                model,record,value = _amount(valuation,row,part.through.blockNumber)
                known[category_].append(record)
                prior = int(raw_totals[category_].get(row.currency,'0'))
                if prior+int(row.raw)>=2**256: raise ValueError('projection_raw_total_overflow')
                raw_totals[category_][row.currency] = str(prior+int(row.raw))
                if category_ in values:
                    valued_complete[category_] &= value is not None
                    if value is not None: values[category_] += value
                if membership_ok and category in ('tradingAccrual','serviceFees'):
                    common = {'eventId':row.eventId,'epochId':base.epochId,'tokenId':row.tokenId,
                        'timestamp':row.timestamp,'blockNumber':part.through.blockNumber,'kind':row.kind,'amount':model}
                    if category=='tradingAccrual': credits.append({**common,'feeOriginId':row.feeOriginId})
                    else: debits.append({**common,'payer':'strategy'})
        for row in part.gasEvidence:
            if row.transactionHash in gas_ids: raise ValueError('projection_duplicate_gas_receipt')
            gas_ids.add(row.transactionHash)
            gas.append({**row.model_dump(),'blockNumber':part.through.blockNumber,'timestamp':part.through.timestamp,
                        'basis':'receipt_gas_product_unqualified_total'})
    capital = _capital(slices,members,valuation,start,end,issues) if head and membership_ok else []
    evidence = {'chainId':4663,'epochId':base.epochId,'scope':'sequence','owner':base.owner,
        'positionManager':base.positionManager,'startedAt':base.baseline.timestamp,
        'openingBlockNumber':base.baseline.blockNumber,
        'snapshot':{'blockNumber':cursor.blockNumber,'blockHash':cursor.blockHash,'timestamp':end,
                    'canonicality':'verified' if canonical else 'reorged' if epoch.status=='baseline_reorged' else 'unverified'},
        'coverageStart':start,'incomeCoverage':'complete' if income_complete else 'partial' if slices else 'unavailable',
        'capitalScope':'all_position_assets_and_epoch_residual_once','members':[m.model_dump() for m in members],
        'capital':capital,'credits':credits,'debits':debits}
    performance = calculator.calculate_performance(evidence,now=now)
    if head and head.cursor != epoch.cursor: issues.add('financial_collection_behind_raw')
    failed = epoch.status=='read_failed' or bool(head and head.lastError)
    if failed: issues.add('financial_latest_read_failed')
    if issues & {'financial_collection_behind_raw','financial_latest_read_failed','financial_membership_unprojectable'}:
        performance.update(grossFeeAprPercent=None,netFeeAprPercent=None,complete24h=False)
        performance['status'] = 'stale' if failed else 'partial'
    if head is None or not membership_ok or not canonical:
        performance['status'] = 'unavailable'
    performance['operatorCostsUsd'] = None
    performance['operatorCostsReason'] = 'full_l2_cost_unqualified' if gas else 'operator_cost_evidence_incomplete'
    performance['issues'] = sorted(set(performance['issues'])|issues)
    performance['mode'] = 'internal_managed_financial_history'
    # Explicit known records are retained even if complete category totals cannot
    # be established. Price failure is never converted to a zero category value.
    # Income/capital, native gross-flow coverage and operator gas are independent
    # evidence dimensions. A flow gap must not erase qualified trading income.
    totals = {name+'Usd':exact_decimal(value) if canonical and valued_complete[name]
              and (income_complete if name=='reinvested' else flows_complete) else None
              for name,value in values.items()}
    known_values = {name+'Usd':exact_decimal(sum((Fraction(row['valuation']['valueUsd'])
                    for row in rows if row['valuation']['valueUsd'] is not None),Fraction()))
                    if canonical and any(row['valuation']['valueUsd'] is not None for row in rows) else None
                    for name,rows in known.items()}
    if not canonical:
        for records in known.values():
            for record in records:
                record['valuation'].update(status='unavailable',valueUsd=None,reason='canonical_financial_evidence_unavailable')
    return {'methodologyVersion':1,'epochId':base.epochId,'owner':base.owner,'vault':base.vault,
        'rawRevision':epoch.revision,'financialRevision':head.revision if head else None,
        'replayGeneration':epoch.replayGeneration,'rawCursor':epoch.cursor.model_dump(),
        'financialCursor':cursor.model_dump(),'windowStart':start,'windowEnd':end,
        'projectionIssues':sorted(issues),'performance':performance,**totals,
        'externalFlowCoverage':{'complete':flows_complete and canonical,
                                'reasons':sorted(flow_reasons) if head else ['financial_history_unavailable']},
        'knownFacts':{'scope':'known_records_in_valuation_window','canonical':canonical,'rawTotals':raw_totals,'records':known,
                      'knownValuedTotalsUsd':known_values,
                      'unclassifiedAccrual':unclassified,'changes':changes,'gasEvidence':gas},
        'executionAvailable':False}
