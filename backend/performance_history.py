"""Forward raw capital and collectible trading accrual from acquired evidence.

This reducer consumes internal canonical observations and independently verified
compound effects. It does not trust balance changes as USD income, equate fee
collection with earning time, or qualify an external price. Donation/manual-change
blocks retain their facts but explicitly interrupt financial coverage. No lifetime
pool reconstruction or browser-supplied evidence enters this boundary.
"""
from collections import defaultdict
from fractions import Fraction
from typing import Annotated, Literal

from eth_abi import decode, encode
from eth_hash.auto import keccak
from pydantic import Field

from discovery import ZERO
from performance_collection import Baseline, Cursor, Record, Raw, Hash, Address, Number, TokenId, TRANSFER
from performance_financial_collection import FinancialPoint, FinancialPage
from general_compound_receipts import COMPLETED, APPLIED, REALIZED, AMOUNTS_TYPE
import performance_v4_history
from pool_activity import SWAP, DONATE, MODIFY

VERSION = 1
MAX_WINDOW_PAGES = 4096
MAX_WINDOW_BYTES = 16_777_216
MAX_RECORDS = 20_000


def topic(signature):
    return '0x'+keccak(signature.encode()).hex()


WITHDRAW_FEES = topic('FeeReservesWithdrawn(bytes32,address,address,uint128,uint128,uint64)')
RECOVER = topic('UntrackedCurrencyRecovered(address,address,uint256,uint64)')
REGISTER = topic('PositionRegistered(uint256,bytes32,bytes32,bytes32,uint64)')
CHILD_EXIT = topic('ChildPositionWithdrawn(uint256,address,uint64)')
ROOT_INVALIDATED = topic('RootInvalidated(uint8,uint64,uint64)')


class Lifetime(Record):
    tokenId: TokenId
    startsAt: Number
    endsAt: Number | None


class HistoryState(Record):
    methodologyVersion: Literal[1]
    owner: Address
    epochId: Hash
    vault: Address
    startedAt: Number
    cursor: Cursor
    lastPoint: FinancialPoint
    members: Annotated[list[Lifetime], Field(min_length=1, max_length=64)]
    membershipAmbiguous: bool
    knownTokenIds: Annotated[list[TokenId], Field(min_length=1, max_length=64)]
    cumulativeKnown: dict[str, dict[str, Raw]]
    incompleteBlocks: Number


def _revalidate(kind, value):
    return kind.model_validate(value.model_dump() if isinstance(value, kind) else value)


def _abi(types, data):
    if type(data) is not str or not data.startswith('0x'):
        raise ValueError('history_invalid_event_abi')
    raw = bytes.fromhex(data[2:])
    values = decode(types, raw, strict=True)
    if encode(types, values) != raw:
        raise ValueError('history_invalid_event_abi')
    return values


def _address_topic(value):
    return _abi(['address'], value)[0]


def _id(*parts):
    # Internal financial event identity; original receipt inclusions remain in
    # the immutable page. Never substitute this for an executor spendable lot.
    return '0x'+keccak(encode(['string[]'], [[str(p) for p in parts]])).hex()


def _owned(member, baseline):
    return member.active is True and member.holder == (baseline.owner if member.isRoot else baseline.vault)


def _observation_issues(point):
    # A canonically inactive registered member contributes no NFT capital. Its
    # immutable fee sources/reserves still need independent complete observation.
    # holder/principal unavailable after its withdrawal does not poison all later
    # blocks; an active or unknown member remains a coverage gap.
    reasons = set(point.reasons)
    if all(m.status == 'complete' or (m.known is True and m.active is False)
           for m in point.members):
        reasons.discard('member_observation_partial')
    return reasons


def capital_components(baseline, point):
    """NFT principal+pending plus actual vault holdings ONCE, in raw units.

    Source reserves are constituents of heldRaw, not another asset to add. The
    native balance in an ERC20/ERC20 vault is a separate third residual currency.
    Wrong-token gifts outside the admitted pair are outside this strategy scope.
    """
    baseline = _revalidate(Baseline, baseline)
    point = _revalidate(FinancialPoint, point)
    components = []
    complete = not _observation_issues(point)
    for member in point.members:
        if not _owned(member, baseline):
            if member.active is None or (member.active is True and member.holder is None):
                complete = False
            continue
        amounts = None
        if member.principalRaw is not None and member.unsettledFeesRaw is not None:
            amounts = {currency: str(int(member.principalRaw[i])+int(member.unsettledFeesRaw[i]))
                       for i, currency in enumerate(point.currencies)}
        else:
            complete = False
        components.append({'tokenId': member.tokenId, 'amountsRaw': amounts})
    residual = dict(zip(point.currencies, point.heldRaw))
    if ZERO not in residual:
        residual[ZERO] = point.nativeHeldRaw
    if any(value is None for value in residual.values()):
        complete = False
        residual = None
    components.append({'tokenId': None, 'amountsRaw': residual})
    return {'complete': complete, 'components': components}


def open_history(baseline, point):
    baseline = _revalidate(Baseline, baseline)
    point = _revalidate(FinancialPoint, point)
    if ((point.epochId, point.owner, point.vault, point.block) !=
            (baseline.epochId, baseline.owner, baseline.vault, baseline.baseline)):
        raise ValueError('history_opening_mismatch')
    if point.status != 'complete' or point.currencies != baseline.opening.currencies:
        raise ValueError('history_opening_incomplete')
    for field in ('heldRaw', 'accountedRaw', 'nativeHeldRaw'):
        if getattr(point,field) != getattr(baseline.opening,field):
            raise ValueError('history_opening_balance_mismatch')
    for observed, original in zip(point.members,baseline.opening.members):
        if any(getattr(observed,field) != value for field,value in original.model_dump().items()):
            raise ValueError('history_opening_member_mismatch')
    ids = [m.tokenId for m in point.members]
    if ids != baseline.tokenIds:
        raise ValueError('history_opening_inventory_mismatch')
    return HistoryState(methodologyVersion=VERSION, owner=baseline.owner, epochId=baseline.epochId,
        vault=baseline.vault, startedAt=point.block.timestamp, cursor=point.block, lastPoint=point,
        members=[Lifetime(tokenId=m.tokenId, startsAt=point.block.timestamp, endsAt=None)
                 for m in point.members if _owned(m, baseline)], membershipAmbiguous=False,
        knownTokenIds=ids, cumulativeKnown={}, incompleteBlocks=0)


def validate_history(baseline, state):
    baseline = _revalidate(Baseline, baseline)
    state = _revalidate(HistoryState, state)
    if ((state.owner, state.epochId, state.vault, state.startedAt) !=
            (baseline.owner, baseline.epochId, baseline.vault, baseline.baseline.timestamp)
            or type(state.methodologyVersion) is not int or state.methodologyVersion != VERSION or state.cursor != state.lastPoint.block
            or (state.lastPoint.owner, state.lastPoint.epochId, state.lastPoint.vault) !=
               (state.owner, state.epochId, state.vault)
            or state.knownTokenIds != sorted(set(state.knownTokenIds), key=int)
            or not set(baseline.tokenIds) <= set(state.knownTokenIds)
            or len({m.tokenId for m in state.members}) != len(state.members)
            or not set(m.tokenId for m in state.members) <= set(state.knownTokenIds)
            or state.cursor.blockNumber < baseline.baseline.blockNumber
            or state.cursor.timestamp < state.startedAt
            or [m.tokenId for m in state.lastPoint.members] != state.knownTokenIds
            or any(not state.startedAt <= m.startsAt <= state.cursor.timestamp or
                   (m.endsAt is not None and not m.startsAt <= m.endsAt <= state.cursor.timestamp)
                   for m in state.members)):
        raise ValueError('history_state_identity_mismatch')
    return state


def _compound_reports(baseline, page, reports):
    """Bind already reconciled results back to this page's actual receipt facts."""
    if baseline.opening.implementationVersion == 4:
        return performance_v4_history.bind_reports(baseline,page,reports)
    if type(reports) is not list or len(reports) > len(page.receipts):
        raise ValueError('history_invalid_compound_reports')
    by_tx = {}
    receipts = {r.transactionHash: r for r in page.receipts}
    if reports:
        expected = [baseline.vault, baseline.opening.implementation, baseline.opening.factory,
                    baseline.positionManager, baseline.opening.poolManager, baseline.opening.stateView]
        pins = baseline.opening.codePins
        if baseline.opening.implementationVersion != 3 or len(pins)!=8 or [p.address for p in pins[:6]]!=expected:
            raise ValueError('history_v3_admission_required')
        engine = pins[7].address
    for result in reports:
        tx = result.get('transactionHash')
        receipt = receipts.get(tx)
        if (tx in by_tx or receipt is None or receipt.status != 1
                or receipt.toAddress != baseline.vault or result.get('canonical') is not True
                or result.get('finalized') is not True
                or result.get('block', {}).get('hash') != receipt.blockHash
                or result.get('block', {}).get('number') != receipt.blockNumber
                or result.get('block', {}).get('timestamp') != next(p.block.timestamp for p in page.points if p.block.blockNumber==receipt.blockNumber)):
            raise ValueError('history_compound_inclusion_mismatch')
        completions = [log for log in receipt.logs if log.address == baseline.vault and log.topics and log.topics[0] == COMPLETED]
        if len(completions) != 1:
            raise ValueError('history_compound_completion_missing')
        completion = completions[0]
        values = _abi(['bytes32','uint128','uint128','uint64','uint64','uint64'], completion.data)
        if (len(completion.topics) != 3 or completion.topics[1] != result.get('intentId')
                or str(int(completion.topics[2],16)) != result.get('destinationTokenId')
                or '0x'+values[0].hex() != result.get('planHash')
                or str(values[1]) != result.get('liquidityBeforeRaw')
                or str(values[2]) != result.get('liquidityAfterRaw')
                or str(values[2]-values[1]) != result.get('liquidityIncreaseRaw')):
            raise ValueError('history_compound_completion_mismatch')
        rows = result.get('sources')
        if type(rows) is not list or len(rows) != 2:
            raise ValueError('history_compound_sources_missing')
        names = ('originalBefore','chargedBefore','realized','grossOriginalConsumed','chargedConsumed',
                 'serviceFee','liquidityAdded','originalAfter','chargedAfter')
        for i, row in enumerate(rows):
            ordinal = row.get('receiptLogIndex')
            if type(ordinal) is not int or not 0 <= ordinal < len(receipt.logs):
                raise ValueError('history_compound_source_ordinal')
            log = receipt.logs[ordinal]
            currency, amounts = _abi(['address',AMOUNTS_TYPE], log.data)
            if (len(log.topics) != 4 or log.topics[0] != APPLIED
                    or _address_topic(log.topics[1]) != baseline.vault
                    or log.topics[2] != result['intentId'] or log.topics[3] != row.get('sourceId')
                    or currency != row.get('currency') or currency != baseline.opening.currencies[i]
                    or any(row.get(name+'Raw') != str(value) for name, value in zip(names,amounts))
                    or log.address != engine):
                raise ValueError('history_compound_source_mismatch')
        by_tx[tx] = result
    return by_tx


def _add(totals, category, currency, raw):
    value = int(raw)
    prior = int(totals.setdefault(category, {}).get(currency, '0'))
    if not 0 <= value < 2**256 or prior+value >= 2**256:
        raise ValueError('history_raw_amount_overflow')
    totals[category][currency] = str(prior+value)


def reduce_history(baseline, state, financial_page, reports):
    """One contiguous page; unavailable spans remain auditable and can expire.

    Trading accrual uses collectible pending changes plus verified settlements,
    in a donation-free block with no unparsed managed liquidity change. Thus old
    pending fees are an opening asset, and their later collection is never a new
    earning credit. This scope is narrower than arbitrary manual LP management.
    """
    baseline = _revalidate(Baseline, baseline)
    state = validate_history(baseline, state)
    page = _revalidate(FinancialPage, financial_page)
    if ((page.epochId,page.owner,page.vault,page.fromCursor) !=
            (state.epochId,state.owner,state.vault,state.cursor)
            or not set(state.knownTokenIds) <= set(page.knownTokenIds)):
        raise ValueError('history_page_identity_mismatch')
    reports_by_tx = _compound_reports(baseline, page, reports)
    receipts_by_block = defaultdict(list)
    events_by_block = defaultdict(list)
    for receipt in page.receipts:
        receipts_by_block[receipt.blockNumber].append(receipt)
    for event in page.poolEvents:
        if event.address != baseline.opening.poolManager or event.topics[1] != baseline.opening.poolId:
            raise ValueError('history_pool_identity_mismatch')
        events_by_block[event.blockNumber].append(event)
    next_state = state.model_dump()
    totals = next_state['cumulativeKnown']
    prior = state.lastPoint
    lifetimes = {m.tokenId:m.model_dump() for m in state.members}
    slices = []
    for point in page.points:
        if point.currencies != baseline.opening.currencies:
            raise ValueError('history_currency_identity_mismatch')
        issues = _observation_issues(prior) | _observation_issues(point)
        before = {m.tokenId:m for m in prior.members}
        after = {m.tokenId:m for m in point.members}
        owned_before = {i for i,m in before.items() if _owned(m,baseline)}
        owned_after = {i for i,m in after.items() if _owned(m,baseline)}
        block_receipts = receipts_by_block[point.block.blockNumber]
        block_reports = [reports_by_tx[r.transactionHash] for r in block_receipts if r.transactionHash in reports_by_tx]
        created = {token for report in block_reports for token in report.get('createdTokenIds',[])}
        for token in created:
            report = next(r for r in block_reports if token in r.get('createdTokenIds',[]))
            member = after.get(token)
            if (token in before or token not in owned_after or member is None or member.isRoot
                    or member.parentTokenId!=report['parentTokenId'] or member.status!='complete'
                    or member.liquidityRaw!=report['liquidityIncreaseRaw']):
                raise ValueError('history_v4_created_member_mismatch')
        changes = []
        for token in sorted(owned_after-owned_before, key=int):
            changes.append({'kind':'position_entered','tokenId':token,'timestamp':point.block.timestamp,'blockNumber':point.block.blockNumber,'amountsRaw':None})
            if token in lifetimes:
                next_state['membershipAmbiguous'] = True
            else:
                lifetimes[token] = {'tokenId':token,'startsAt':point.block.timestamp,'endsAt':None}
        for token in sorted(owned_before-owned_after, key=int):
            changes.append({'kind':'position_left','tokenId':token,'timestamp':point.block.timestamp,'blockNumber':point.block.blockNumber,'amountsRaw':None})
            if token in lifetimes:
                lifetimes[token]['endsAt'] = point.block.timestamp
        if any(change['kind']!='position_entered' or change['tokenId'] not in created for change in changes):
            issues.add('membership_transition_requires_attribution')
        if next_state['membershipAmbiguous']:
            issues.add('reentered_token_lifetime_unsupported')
        settlements = defaultdict(lambda:[0,0])
        settled_tokens = set()
        added_liquidity = defaultdict(int)
        costs, reinvestments, realizations, flows = [], [], [], []
        native_expected = 0
        held_expected = defaultdict(int)
        accounted_expected = defaultdict(int)
        for report in block_reports:
            token = report['destinationTokenId']
            if (token not in owned_before and token not in created) or token not in owned_after:
                issues.add('compound_member_not_continuously_owned')
            added_liquidity[token] += int(report['liquidityIncreaseRaw'])
            if report.get('version') == 4:
                # Actual collection belongs to its original NFT, even when the
                # reserves later fund another member or a newly minted child.
                for row in report['realizations']:
                    source_token = row['tokenId']
                    settled_tokens.add(source_token)
                    if source_token not in owned_before & owned_after:
                        issues.add('compound_member_not_continuously_owned')
                    member = before.get(source_token)
                    if member is None: raise ValueError('history_v4_collection_member_missing')
                    for i,currency in enumerate(point.currencies):
                        raw = row[f'amount{i}Raw']
                        settlements[source_token][i] += int(raw)
                        realizations.append({'kind':'realized_accrual','tokenId':source_token,'currency':currency,
                            'timestamp':point.block.timestamp,'blockNumber':point.block.blockNumber,
                            'transactionHash':report['transactionHash'],'sourceId':getattr(member,f'source{i}'),'raw':raw,
                            'receiptLogIndex':row['receiptLogIndex']})
                        _add(totals,'realized',currency,raw)
                        held_expected[currency] += int(raw); accounted_expected[currency] += int(raw)
                        if currency == ZERO: native_expected += int(raw)
                consumptions = [(row,row['currency'],False) for row in report['applications']]
                consumptions += [({**row['inputAmounts'],**{k:row[k] for k in ('sourceId','sourceTokenId','receiptLogIndex')}},
                                   row['currencyIn'],True) for row in report['conversions']]
                for row,currency,converted in consumptions:
                    common = {'tokenId':row['sourceTokenId'],'currency':currency,'timestamp':point.block.timestamp,
                        'blockNumber':point.block.blockNumber,'transactionHash':report['transactionHash'],'sourceId':row['sourceId']}
                    costs.append({**common,'kind':'service_fee','payer':'strategy','raw':row['serviceFeeRaw'],
                        'eventId':_id(state.epochId,report['transactionHash'],row['receiptLogIndex'],'service')})
                    _add(totals,'serviceFees',currency,row['serviceFeeRaw'])
                    if not converted:
                        reinvestments.append({**common,'kind':'reinvestment','raw':row['liquidityAddedRaw'],
                                              'receiptLogIndex':row['receiptLogIndex']})
                        _add(totals,'reinvested',currency,row['liquidityAddedRaw'])
                    used = int(row['grossOriginalConsumedRaw'])+int(row['chargedConsumedRaw'])
                    held_expected[currency] -= used; accounted_expected[currency] -= used
                    if currency == ZERO: native_expected -= used
                for row in report['conversions']:
                    currency = row['currencyOut']; amount = int(row['amountOutRaw'])
                    held_expected[currency] += amount; accounted_expected[currency] += amount
                    if currency == ZERO: native_expected += amount
                    changes.append({'kind':'fee_reserves_converted','tokenId':row['sourceTokenId'],
                        'sourceId':row['sourceId'],'currencyIn':row['currencyIn'],'currencyOut':currency,
                        'amountInRaw':row['amountInRaw'],'amountOutRaw':row['amountOutRaw'],
                        'timestamp':point.block.timestamp,'blockNumber':point.block.blockNumber,
                        'transactionHash':report['transactionHash']})
                continue
            for i,row in enumerate(report['sources']):
                currency = row['currency']
                settlements[token][i] += int(row['realizedRaw'])
                common = {'tokenId':token,'currency':currency,'timestamp':point.block.timestamp,'blockNumber':point.block.blockNumber,
                          'transactionHash':report['transactionHash'],'sourceId':row['sourceId']}
                realizations.append({**common,'kind':'realized_accrual','raw':row['realizedRaw']})
                costs.append({**common,'kind':'service_fee','payer':'strategy','raw':row['serviceFeeRaw'],
                              'eventId':_id(state.epochId,report['transactionHash'],row['receiptLogIndex'],'service')})
                reinvestments.append({**common,'kind':'reinvestment','raw':row['liquidityAddedRaw']})
                _add(totals,'realized',currency,row['realizedRaw'])
                _add(totals,'serviceFees',currency,row['serviceFeeRaw'])
                _add(totals,'reinvested',currency,row['liquidityAddedRaw'])
                used = int(row['grossOriginalConsumedRaw'])+int(row['chargedConsumedRaw'])
                held_expected[currency] += int(row['realizedRaw'])-used
                accounted_expected[currency] += int(row['realizedRaw'])-used
                if currency == ZERO:
                    native_expected += int(row['realizedRaw'])-int(row['grossOriginalConsumedRaw'])-int(row['chargedConsumedRaw'])
        for receipt in block_receipts:
            compound = receipt.transactionHash in reports_by_tx
            vault_logs = [log for log in receipt.logs if log.address == baseline.vault and log.topics]
            if any(log.topics[0] in (COMPLETED,performance_v4_history.COMPLETED) for log in vault_logs) and not compound:
                issues.add('compound_receipt_not_reconciled')
            for log in receipt.logs:
                if log.address == baseline.positionManager and log.topics and log.topics[0] == TRANSFER:
                    if len(log.topics) != 4:
                        raise ValueError('history_invalid_nft_transfer')
                    token = str(int(log.topics[3],16))
                    if token in set(before)|set(after):
                        source,target = map(_address_topic,log.topics[1:3])
                        expected = baseline.owner if token == baseline.rootTokenId else baseline.vault
                        verified_mint = (compound and token in reports_by_tx[receipt.transactionHash].get('createdTokenIds',[])
                                         and source==ZERO and target==baseline.vault)
                        if source != target and expected in (source,target) and not verified_mint:
                            issues.add('ownership_transition_requires_attribution')
                            if token in owned_before & owned_after:
                                next_state['membershipAmbiguous'] = True
            if any(log.topics[0] == ROOT_INVALIDATED for log in vault_logs):
                issues.add('root_invalidated_requires_attribution')
            # ERC20 transfers in a verified compound are internal settlement.
            # Every other actual vault transfer is an external cash movement;
            # withdrawals/recoveries use the same transfer once, never a toll.
            if not compound:
                for log in receipt.logs:
                    if log.address in point.currencies and log.address != ZERO and log.topics and log.topics[0] == TRANSFER:
                        if len(log.topics) != 3:
                            raise ValueError('history_invalid_currency_transfer')
                        source, target = map(_address_topic, log.topics[1:3])
                        amount = _abi(['uint256'],log.data)[0]
                        if (source == baseline.vault) == (target == baseline.vault):
                            continue
                        kind = 'external_deposit' if target == baseline.vault else 'external_withdrawal'
                        held_expected[log.address] += amount if target == baseline.vault else -amount
                        flows.append({'eventId':_id(state.epochId,receipt.transactionHash,log.receiptLogIndex,'flow'),
                            'kind':kind,'currency':log.address,'raw':str(amount),'tokenId':None,
                            'timestamp':point.block.timestamp,'blockNumber':point.block.blockNumber,'transactionHash':receipt.transactionHash})
                for log in vault_logs:
                    if log.topics[0] == WITHDRAW_FEES:
                        if len(log.topics)!=4 or _address_topic(log.topics[3])!=baseline.owner:
                            raise ValueError('history_fee_withdrawal_identity')
                        original, charged, _ = _abi(['uint128','uint128','uint64'],log.data)
                        currency = _address_topic(log.topics[2])
                        accounted_expected[currency] -= original+charged
                        changes.append({'kind':'fee_reserves_withdrawn','sourceId':log.topics[1],
                            'currency':currency,'originalRaw':str(original),'chargedRaw':str(charged),
                            'timestamp':point.block.timestamp,'blockNumber':point.block.blockNumber,'transactionHash':receipt.transactionHash})
                        if currency == ZERO:
                            amount = original+charged
                            native_expected -= amount
                            flows.append({'eventId':_id(state.epochId,receipt.transactionHash,log.receiptLogIndex,'flow'),
                                'kind':'external_withdrawal','currency':currency,'raw':str(amount),'tokenId':None,
                                'timestamp':point.block.timestamp,'blockNumber':point.block.blockNumber,'transactionHash':receipt.transactionHash})
                    elif log.topics[0] == RECOVER:
                        if len(log.topics)!=3 or _address_topic(log.topics[2])!=baseline.owner:
                            raise ValueError('history_recovery_identity')
                        amount, _ = _abi(['uint256','uint64'],log.data)
                        currency = _address_topic(log.topics[1])
                        if currency == ZERO:
                            native_expected -= amount
                            flows.append({'eventId':_id(state.epochId,receipt.transactionHash,log.receiptLogIndex,'flow'),
                                'kind':'external_withdrawal','currency':currency,'raw':str(amount),'tokenId':None,
                                'timestamp':point.block.timestamp,'blockNumber':point.block.blockNumber,'transactionHash':receipt.transactionHash})
            # Gas remains separate unqualified receipt evidence, even if owner
            # clicked compound. No second debit from the managed strategy.
        pool_events = events_by_block[point.block.blockNumber]
        swaps = [e for e in pool_events if e.topics[0] == SWAP]
        for event in pool_events:
            if event.topics[0] == DONATE:
                if any(_abi(['uint256','uint256'],event.data)):
                    issues.add('pool_donation_attribution_required')
            elif event.topics[0] == MODIFY and _address_topic(event.topics[2]) == baseline.positionManager:
                lo,hi,delta,salt = _abi(['int24','int24','int256','bytes32'],event.data)
                token = str(int.from_bytes(salt,'big'))
                if token in set(before)|set(after):
                    if event.transactionHash not in reports_by_tx:
                        issues.add('external_liquidity_change_unreconciled')
                        changes.append({'kind':'external_liquidity_change','tokenId':token,
                            'liquidityDeltaRaw':str(delta),'timestamp':point.block.timestamp,'blockNumber':point.block.blockNumber,
                            'transactionHash':event.transactionHash,'amountsRaw':None})
                    elif token != reports_by_tx[event.transactionHash]['destinationTokenId'] and not (
                            reports_by_tx[event.transactionHash].get('version')==4 and delta==0 and token in
                            {r['tokenId'] for r in reports_by_tx[event.transactionHash]['realizations']}):
                        raise ValueError('history_compound_modify_token_mismatch')
        if prior.nativeHeldRaw is None or point.nativeHeldRaw is None:
            issues.add('native_capital_observation_missing')
        elif int(point.nativeHeldRaw)-int(prior.nativeHeldRaw) != native_expected:
            # Internal native transfers have no ERC20 event. Net balance change
            # cannot reveal gross deposits/withdrawals or their intrablock order.
            issues.add('native_external_flow_unattributed')
            changes.append({'kind':'native_balance_change_unattributed','tokenId':None,
                'deltaRaw':str(int(point.nativeHeldRaw)-int(prior.nativeHeldRaw)-native_expected),
                'timestamp':point.block.timestamp})
        for i,currency in enumerate(point.currencies):
            if currency != ZERO and (prior.heldRaw[i] is None or point.heldRaw[i] is None or
                    int(point.heldRaw[i])-int(prior.heldRaw[i]) != held_expected[currency]):
                issues.add('token_external_flow_unattributed')
            if prior.accountedRaw[i] is None or point.accountedRaw[i] is None or (
                    int(point.accountedRaw[i])-int(prior.accountedRaw[i]) != accounted_expected[currency]):
                issues.add('fee_reserve_change_unreconciled')
        if not block_reports and not any(c['kind']=='fee_reserves_withdrawn' for c in changes) and prior.sources != point.sources:
            issues.add('fee_source_change_unreconciled')
        candidates = []
        for token in sorted((owned_before & owned_after)|created, key=int):
            a,b = before.get(token),after[token]
            if a is not None and (a.status!='complete' or b.status!='complete' or a.identity!=b.identity
                    or a.registrationBaselineId!=b.registrationBaselineId
                    or int(b.liquidityRaw)!=int(a.liquidityRaw)+added_liquidity[token]):
                issues.add('position_continuity_unproven')
                continue
            if a is not None and not added_liquidity[token] and token not in settled_tokens and (a.lastGrowthX128!=b.lastGrowthX128 or a.checkpoint!=b.checkpoint):
                issues.add('fee_settlement_unreconciled')
            for i,currency in enumerate(point.currencies):
                amount = int(b.unsettledFeesRaw[i])+settlements[token][i]-(int(a.unsettledFeesRaw[i]) if a is not None else 0)
                if amount < 0 or amount >= 2**256:
                    issues.add('collectible_accrual_not_conserved')
                    continue
                if amount and not swaps:
                    issues.add('fee_growth_without_observed_swap')
                if amount:
                    origin = _id('DominoManagedAccrualV1',state.epochId,point.block.blockHash,token,currency)
                    candidates.append({'eventId':origin,'feeOriginId':origin,'tokenId':token,
                        'currency':currency,'timestamp':point.block.timestamp,'blockNumber':point.block.blockNumber,'raw':str(amount),'kind':'new_trading_fee'})
        credits = candidates if not issues else []
        for credit in credits:
            _add(totals,'tradingAccrual',credit['currency'],credit['raw'])
        for flow in flows:
            _add(totals,flow['kind'],flow['currency'],flow['raw'])
        capital = capital_components(baseline,prior)
        slices.append({'from':prior.block.model_dump(),'through':point.block.model_dump(),
            'incomeComplete':not issues,'issues':sorted(issues),'capitalComplete':capital['complete'],
            'capital':capital['components'],'credits':credits,'serviceDebits':costs,
            'unclassifiedAccrual':[{**credit,'kind':'collectible_accrual_unqualified'} for credit in candidates] if issues else [],
            'realizations':realizations,'reinvestments':reinvestments,'externalFlows':flows,'changes':changes,
            'externalFlowsComplete':False,'externalFlowsReason':'native_gross_flows_unavailable',
            'gasEvidence':[{'transactionHash':r.transactionHash,'payer':r.fromAddress,
                'gasUsedRaw':r.gasUsed,'effectiveGasPriceRaw':r.effectiveGasPrice,
                'receiptGasProductWei':str(int(r.gasUsed)*int(r.effectiveGasPrice)),
                'fullL2CostWei':None,'strategyDebitApplied':False} for r in block_receipts]})
        if issues:
            next_state['incompleteBlocks'] += 1
        prior = point
    next_state.update(cursor=page.throughCursor.model_dump(),lastPoint=prior.model_dump(),
        knownTokenIds=page.knownTokenIds,members=list(lifetimes.values()))
    next_state = validate_history(baseline,next_state)
    delta = {'methodologyVersion':VERSION,'owner':state.owner,'epochId':state.epochId,'vault':state.vault,
        'fromCursor':page.fromCursor.model_dump(),'throughCursor':page.throughCursor.model_dump(),'slices':slices}
    return next_state, delta
