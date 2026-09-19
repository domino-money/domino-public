"""Typed V4 execution evidence for the private forward performance journal.

Calldata and receipt events retain source NFT identity. Conversion output is a
charged reserve, never a new trading earning or a second reinvestment event.
This adapter consumes the independent reconciler's result and binds each effect
again to the immutable canonical page before the financial reducer uses it.
"""
from eth_abi import decode, encode
from eth_hash.auto import keccak

import execution_models as m
import execution_v4 as v4
import general_compound_receipts as g
from performance_collection import CollectionError

COMPLETED = '0x'+keccak(b'ExecutionCompleted(bytes32,bytes32,uint8,uint256,uint256,uint64)').hex()
APPLIED = '0x'+keccak(('BudgetApplied(address,bytes32,bytes32,address,uint256,'+g.AMOUNTS_TYPE+')').encode()).hex()
CONVERTED = '0x'+keccak(('FeesConverted(address,bytes32,bytes32,address,address,uint128,uint128,'+g.AMOUNTS_TYPE+',uint128,uint128)').encode()).hex()
SUCCESSOR = '0x'+keccak(b'SuccessorCreated(bytes32,uint256,uint256)').hex()
AMOUNT_NAMES = ('originalBefore','chargedBefore','realized','grossOriginalConsumed',
                'chargedConsumed','serviceFee','liquidityAdded','originalAfter','chargedAfter')


def decode_plan(calldata):
    """Only canonical V4 execute ABI; no V3 interpretation or arbitrary calldata."""
    try:
        raw = g._hex(calldata, maximum=16384)
        if raw[:4] != keccak(v4.EXECUTE_SIGNATURE.encode())[:4]: raise ValueError()
        values, = decode([v4.PLAN_TYPE],raw[4:],strict=True)
        if encode([v4.PLAN_TYPE],[values]) != raw[4:]: raise ValueError()
        authority,action,destination,lower,upper,ceiling0,ceiling1,collect,budgets,swap = values
        plan = v4.Plan(authority=g.CompoundPlan(**{
            name:'0x'+value.hex() if kind=='bytes32' else str(value)
            for (name,kind),value in zip(g.CompoundPlan.ABI,authority)}),
            action=action,destinationTokenId=str(destination),tickLower=lower,tickUpper=upper,
            maxAdded0=str(ceiling0),maxAdded1=str(ceiling1),
            collect=tuple(v4.PositionRef(tokenId=str(token),positionIdentity='0x'+identity.hex(),
                checkpointId='0x'+checkpoint.hex()) for token,identity,checkpoint in collect),
            budgets=tuple(v4.FeeBudget(sourceId='0x'+source.hex(),currency=currency,
                maxOriginal=str(original),maxCharged=str(charged),minOriginal=str(floor_original),minCharged=str(floor_charged))
                for source,currency,original,charged,floor_original,floor_charged in budgets),
            swap=v4.SwapPlan(sourceId='0x'+swap[0].hex(),currencyIn=swap[1],amountIn=str(swap[2]),
                maxOriginal=str(swap[3]),maxCharged=str(swap[4]),minAmountOut=str(swap[5]),
                sqrtPriceLimitX96=str(swap[6]),priceObservationId='0x'+swap[7].hex()))
        if plan.calldata()!=calldata.lower(): raise ValueError()
        return plan
    except Exception:
        raise CollectionError('financial_v4_calldata_invalid') from None


def admission(baseline, collector):
    """Immutable opening identity and its exact 10 deployment pins."""
    try:
        opening,block = baseline.opening,baseline.baseline
        if opening.implementationVersion!=4 or len(opening.codePins)!=10: raise ValueError()
        get = lambda target,signature,output: collector._get(target,signature,output,block)
        key = get(baseline.vault,'poolKey()','(address,address,uint24,int24,address)')
        sequence = m.SequenceIdentity(chainId=4663,owner=baseline.owner,
            sequenceId='0x'+get(baseline.vault,'sequenceId()','bytes32').hex(),vault=baseline.vault,
            factory=opening.factory,implementation=opening.implementation,implementationVersion='4',
            poolManager=opening.poolManager,positionManager=baseline.positionManager,
            poolKey=m.PoolKey(currency0=key[0],currency1=key[1],fee_pips=key[2],tick_spacing=key[3],hooks=key[4]),
            poolId=opening.poolId,baseCurrency=get(baseline.vault,'baseCurrency()','address'),
            quoteCurrency=get(baseline.vault,'quoteCurrency()','address'),
            serviceFeeRecipient=get(baseline.vault,'serviceFeeRecipient()','address'))
        if sequence.digest()!=opening.sequenceIdentity or list(key[:2])!=opening.currencies: raise ValueError()
        engine = get(baseline.vault,'executionEngine()','address')
        guard = get(engine,'priceGuard()','address')
        result = v4.Admission(sequence=sequence,stateView=opening.stateView,
            readHelper=get(baseline.vault,'readHelper()','address'),executionEngine=engine,
            routingHelper=get(engine,'routingHelper()','address'),priceGuard=guard,
            pricePublisher=get(guard,'publisher()','address'),
            runtimePins=tuple(g.RuntimePin(address=p.address,codeHash=p.codeHash) for p in opening.codePins))
        if [result.readHelper,result.executionEngine,result.routingHelper,result.priceGuard] != [p.address for p in opening.codePins[6:]]:
            raise ValueError()
        return result
    except CollectionError: raise
    except Exception:
        raise CollectionError('financial_v4_admission_invalid') from None


def bind_reports(baseline, page, reports):
    if type(reports) is not list or len(reports)>len(page.receipts): raise ValueError('history_invalid_compound_reports')
    if not reports: return {}
    pins = baseline.opening.codePins
    expected = [baseline.vault,baseline.opening.implementation,baseline.opening.factory,
                baseline.positionManager,baseline.opening.poolManager,baseline.opening.stateView]
    if baseline.opening.implementationVersion!=4 or len(pins)!=10 or [p.address for p in pins[:6]]!=expected:
        raise ValueError('history_v4_admission_required')
    receipts = {r.transactionHash:r for r in page.receipts}
    points = {p.block.blockNumber:p for p in page.points}
    bound = {}
    for result in reports:
        tx = result.get('transactionHash'); receipt = receipts.get(tx)
        if (tx in bound or receipt is None or receipt.status!=1 or receipt.toAddress!=baseline.vault
                or result.get('canonical') is not True or result.get('finalized') is not True
                or result.get('block',{}).get('hash')!=receipt.blockHash
                or result.get('block',{}).get('number')!=receipt.blockNumber
                or result.get('block',{}).get('timestamp')!=points[receipt.blockNumber].block.timestamp):
            raise ValueError('history_v4_inclusion_mismatch')
        plan = decode_plan(receipt.rawTransaction.get('input'))
        plan_hash = '0x'+keccak(encode(['bytes32','uint256','address','bytes32',v4.PLAN_TYPE],
            [keccak(b'DominoExecutionV4'),4663,baseline.vault,bytes.fromhex(baseline.opening.sequenceIdentity[2:]),plan.values()])).hex()
        completions = [log for log in receipt.logs if log.address==baseline.vault and log.topics and log.topics[0]==COMPLETED]
        if len(completions)!=1: raise ValueError('history_v4_completion_missing')
        final = completions[0]
        action,parent,destination,nonce = g._abi(['uint8','uint256','uint256','uint64'],final.data)
        if (len(final.topics)!=3 or final.topics[1]!=plan.authority.intentId or final.topics[2]!=plan_hash
                or (action,parent,nonce)!=(plan.action,int(plan.authority.tokenId),int(plan.authority.stateNonce)+1)
                or (result.get('intentId'),result.get('planHash'),result.get('action'),result.get('parentTokenId'),
                    result.get('destinationTokenId'),result.get('liquidityIncreaseRaw')) !=
                    (plan.authority.intentId,plan_hash,action,str(parent),str(destination),plan.authority.liquidityIncrease)
                or destination==0 or action!=3 and destination!=int(plan.destinationTokenId)):
            raise ValueError('history_v4_completion_mismatch')
        inventory = {source.sourceId:source.tokenId for source in points[receipt.blockNumber].sources}
        applications,realizations,conversions,created = [],[],[],[]
        for log in receipt.logs:
            if not log.topics: continue
            signature = log.topics[0]
            if signature in (g.REALIZED,APPLIED,CONVERTED) and log.address==pins[7].address:
                if len(log.topics)!=4 or g._abi(['address'],log.topics[1])[0]!=baseline.vault or log.topics[2]!=plan.authority.intentId:
                    raise ValueError('history_v4_event_identity')
                common = {'receiptLogIndex':log.receiptLogIndex}
                if signature==g.REALIZED:
                    before,after,a,b = g._abi(['bytes32','bytes32','uint128','uint128'],log.data)
                    realizations.append({**common,'tokenId':str(int(log.topics[3],16)),
                        'checkpointBefore':'0x'+before.hex(),'checkpointAfter':'0x'+after.hex(),
                        'amount0Raw':str(a),'amount1Raw':str(b)})
                else:
                    sid = log.topics[3]
                    if sid not in inventory: raise ValueError('history_v4_source_unknown')
                    common.update(sourceId=sid,sourceTokenId=inventory[sid])
                    if signature==APPLIED:
                        currency,target,amounts = g._abi(['address','uint256',g.AMOUNTS_TYPE],log.data)
                        if target!=destination: raise ValueError('history_v4_destination_mismatch')
                        applications.append({**common,'currency':currency,'destinationTokenId':str(target),
                            **{name+'Raw':str(value) for name,value in zip(AMOUNT_NAMES,amounts)}})
                    else:
                        a,b,spent,received,amounts,before,after = g._abi(
                            ['address','address','uint128','uint128',g.AMOUNTS_TYPE,'uint128','uint128'],log.data)
                        conversions.append({**common,'currencyIn':a,'currencyOut':b,'amountInRaw':str(spent),
                            'amountOutRaw':str(received),'chargedOutputBeforeRaw':str(before),'chargedOutputAfterRaw':str(after),
                            'inputAmounts':{name+'Raw':str(value) for name,value in zip(AMOUNT_NAMES,amounts)}})
            elif signature==SUCCESSOR and log.address==baseline.vault:
                if (len(log.topics)!=4 or log.topics[1]!=plan.authority.intentId or int(log.topics[2],16)!=parent
                        or int(log.topics[3],16)!=destination or log.data!='0x'):
                    raise ValueError('history_v4_successor_mismatch')
                created.append(str(destination))
        if len(created)!=(1 if action==3 else 0): raise ValueError('history_v4_successor_mismatch')
        # Preserve event granularity; aggregated source rows must not be counted
        # as additional collections or as conversion output earning again.
        for name,expected_rows in (('realizations',realizations),('applications',applications),('conversions',conversions)):
            rows = result.get(name)
            if not isinstance(rows,(list,tuple)) or len(rows)!=len(expected_rows) or any(
                    any(row.get(key)!=value for key,value in expected.items()) for row,expected in zip(rows,expected_rows)):
                raise ValueError('history_v4_effect_mismatch')
        bound[tx] = {**result,'version':4,'realizations':realizations,'applications':applications,
                     'conversions':conversions,'createdTokenIds':created}
    return bound
