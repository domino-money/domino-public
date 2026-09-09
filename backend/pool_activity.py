"""Exact core-event quantities and range liquidity; no inferred USD or LP fee totals."""
import copy

from eth_hash.auto import keccak

from catalogue import checked_key
from catalogue_indexer import INITIALIZE_TOPIC, decode_initialize
from discovery import DataError, POOL_MANAGER, ZERO, address, bytes32, decode_result, quantity


def topic(signature):
    return '0x'+keccak(signature.encode()).hex()


SWAP = topic('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)')
MODIFY = topic('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)')
DONATE = topic('Donate(bytes32,address,uint256,uint256)')
PROTOCOL = topic('ProtocolFeeUpdated(bytes32,uint24)')
TOPICS = [INITIALIZE_TOPIC, SWAP, MODIFY, DONATE, PROTOCOL]
MAX_RANGES = 5000
MAX_SQRT = 1461446703485210103287273052203988822378723970342
MIN_SQRT = 4295128739


def valid_price(sqrt, tick):
    if not MIN_SQRT <= sqrt < MAX_SQRT or not -887272 <= tick <= 887272:
        raise DataError('invalid_activity_price')


def protocol_directions(packed):
    fees = [packed & 0xfff, packed >> 12]
    if not 0 <= packed < 2**24 or any(fee>1000 for fee in fees):
        raise DataError('invalid_protocol_fee')
    return fees


def decode_activity(raw, expected_pool):
    if not isinstance(raw,dict) or address(raw.get('address'))!=POOL_MANAGER or raw.get('removed') is not False:
        raise DataError('invalid_activity_log')
    topics=raw.get('topics')
    if not isinstance(topics,list) or len(topics)<2 or bytes32(topics[1])!=bytes32(expected_pool):
        raise DataError('activity_pool_mismatch')
    kind=bytes32(topics[0])
    if kind==INITIALIZE_TOPIC:
        decoded=decode_initialize(raw)
        _,_,_,sqrt,tick=decode_result(['uint24','int24','address','uint160','int24'],raw['data'])
        valid_price(sqrt,tick)
        payload={'poolKey':decoded['poolKey'],'sqrtPriceX96':str(sqrt),'tick':tick}
        name='initialize'
    else:
        specs={SWAP:('swap',3,['int128','int128','uint160','uint128','int24','uint24']),
               MODIFY:('modify_liquidity',3,['int24','int24','int256','bytes32']),
               DONATE:('donate',3,['uint256','uint256']),
               PROTOCOL:('protocol_fee',2,['uint24'])}
        if kind not in specs:
            raise DataError('unknown_activity_topic')
        name,count,types=specs[kind]
        if len(topics)!=count:
            raise DataError('invalid_activity_topics')
        if count==3:
            sender=bytes32(topics[2])
            if sender[2:26]!='0'*24:
                raise DataError('invalid_activity_sender')
        data=raw.get('data')
        if not isinstance(data,str) or len(data)!=2+64*len(types):
            raise DataError('invalid_activity_data')
        values=decode_result(types,data)
        if name=='swap':
            a0,a1,sqrt,liquidity,tick,fee=values
            valid_price(sqrt,tick)
            if a0*a1>0 or not 0<=fee<=1000000:
                raise DataError('invalid_swap_event')
            payload={'amount0':str(a0),'amount1':str(a1),'sqrtPriceX96':str(sqrt),
                     'liquidity':str(liquidity),'tick':tick,'swapFeePips':fee}
        elif name=='modify_liquidity':
            lower,upper,delta,salt=values
            if not -887272<=lower<upper<=887272 or not -(2**127)<=delta<2**127:
                raise DataError('invalid_liquidity_event')
            # Range aggregation is not position ownership or a fee-collection ledger.
            payload={'tickLower':lower,'tickUpper':upper,'liquidityDelta':str(delta),'salt':'0x'+salt.hex()}
        elif name=='donate':
            if any(value>=2**127 for value in values):
                raise DataError('invalid_donation_event')
            payload={'amount0':str(values[0]),'amount1':str(values[1])}
        else:
            protocol_directions(values[0])
            payload={'protocolFeeRaw':values[0]}
        if count==3:
            payload['sender']=address('0x'+sender[26:])
    return {'poolId':bytes32(expected_pool),'kind':name,'payload':payload,
            'blockNumber':quantity(raw.get('blockNumber')),'blockHash':bytes32(raw.get('blockHash')),
            'transactionHash':bytes32(raw.get('transactionHash')),'logIndex':quantity(raw.get('logIndex')),
            # Detect differing ABI payloads even when omitted sender/salt fields differ.
            'rawFingerprint':'0x'+keccak((''.join(topics)+raw['data']).lower().encode()).hex()}


def active_liquidity(model, tick=None):
    tick=model['tick'] if tick is None else tick
    return sum(int(value) for key,value in model['ranges'].items()
               if (bounds:=key.split(':')) and int(bounds[0])<=tick<int(bounds[1]))


def replay(model, events, pool_id, key):
    """Replay ordered, canonical event candidates. Reject incomplete liquidity history."""
    key=checked_key(key,pool_id)
    state=copy.deepcopy(model)
    for event in events:
        if event['poolId']!=pool_id:
            raise DataError('activity_pool_mismatch')
        kind,p=event['kind'],event['payload']
        if kind=='initialize':
            if state is not None or checked_key(p['poolKey'],pool_id)!=key:
                raise DataError('invalid_initialize_anchor')
            state={'ranges':{},'sqrtPriceX96':p['sqrtPriceX96'],'tick':p['tick'],
                   'protocolFeeRaw':0,'initializedAt':event['timestamp'],
                   'initializedBlock':event['blockNumber'],'eventCount':0}
        elif state is None:
            raise DataError('initialize_anchor_required')
        elif kind=='modify_liquidity':
            if p['tickLower']%key.tick_spacing or p['tickUpper']%key.tick_spacing:
                raise DataError('unaligned_liquidity_range')
            slot=f"{p['tickLower']}:{p['tickUpper']}"
            value=int(state['ranges'].get(slot,'0'))+int(p['liquidityDelta'])
            if not 0<=value<2**128:
                raise DataError('liquidity_history_mismatch')
            if value:
                state['ranges'][slot]=str(value)
            else:
                state['ranges'].pop(slot,None)
            if len(state['ranges'])>MAX_RANGES:
                raise DataError('activity_range_budget_exhausted')
        elif kind=='swap':
            if active_liquidity(state,p['tick'])!=int(p['liquidity']):
                raise DataError('swap_liquidity_mismatch')
            a0,a1=int(p['amount0']),int(p['amount1'])
            if key.hooks==ZERO and key.fee_pips!=0x800000 and (a0<0 or a1<0):
                protocol=protocol_directions(state['protocolFeeRaw'])[0 if a0<0 else 1]
                total=protocol+key.fee_pips-protocol*key.fee_pips//1000000
                if p['swapFeePips']!=total:
                    raise DataError('swap_fee_schedule_mismatch')
            state.update(sqrtPriceX96=p['sqrtPriceX96'],tick=p['tick'])
        elif kind=='protocol_fee':
            state['protocolFeeRaw']=p['protocolFeeRaw']
        elif kind=='donate':
            if active_liquidity(state)==0:
                raise DataError('donation_without_active_liquidity')
        else:
            raise DataError('unknown_activity_kind')
        state['eventCount']+=1
        if not 0<=active_liquidity(state)<2**128:
            raise DataError('invalid_active_liquidity')
    return state


def window_metrics(events, *, initialized_at, as_of, window_seconds=86400):
    """Raw swap legs in (as_of-window, as_of], never the sum of both legs in USD."""
    if type(window_seconds) is not int or not 1<=window_seconds<=86400 or initialized_at>as_of:
        raise DataError('invalid_activity_window')
    lower=as_of-window_seconds
    swap_count=trade_count=donation_count=0
    gross_in=[0,0];gross_out=[0,0];donated=[0,0];fees=set()
    for event in events:
        if not lower<event['timestamp']<=as_of:
            continue
        p=event['payload']
        if event['kind']=='swap':
            swap_count+=1
            amounts=[int(p['amount0']),int(p['amount1'])]
            trade_count+=int(any(amounts))
            fees.add(p['swapFeePips'])
            for i,amount in enumerate(amounts):
                gross_in[i]+=max(0,-amount)
                gross_out[i]+=max(0,amount)
        elif event['kind']=='donate':
            donation_count+=1
            for i in [0,1]: donated[i]+=int(p[f'amount{i}'])
    complete=initialized_at<=lower
    return {'requestedSeconds':window_seconds,'fromTimestampExclusive':lower,'throughTimestamp':as_of,
            'observedSinceTimestamp':max(initialized_at,lower),'observedSeconds':min(window_seconds,as_of-initialized_at),
            'completeWindow':complete,'status':'covered_as_of' if complete else 'pool_younger_than_window',
            'swapEventCount':swap_count,'nonzeroSwapCount':trade_count,
            'swapLegsRaw':[{'currencyIndex':i,'grossInput':str(gross_in[i]),'output':str(gross_out[i]),
                            'absoluteTurnover':str(gross_in[i]+gross_out[i])} for i in [0,1]],
            'donations':{'count':donation_count,'amountsRaw':[str(x) for x in donated]},
            'observedTotalSwapFeePips':sorted(fees),
            'volumeUsd':None,'volumeUsdReason':'timestamp_aligned_valuation_unavailable',
            'lpFeesRaw':None,'lpFeesReason':'per_step_fee_accounting_not_reconciled',
            'feeApr':None,'feeAprReason':'lp_fee_and_time_weighted_tvl_not_reconciled'}
