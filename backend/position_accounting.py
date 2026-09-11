"""Core-position liabilities and pool-attributed token flows, in integer units.

Identity is PoolManager caller + range + salt, not an NFT owner or wallet claim.
Independent event model; original Pool/Position sources are test references only.
"""
import copy

from eth_hash.auto import keccak

from discovery import DataError, address, bytes32
from fee_accounting import MAX_CHUNK_STEPS, reconstruct_swap, supported
from pool_activity import active_liquidity, check_activity_capacity, replay
from v4_math import Q128, U256, amount_delta, sqrt_at_tick, tick_at_sqrt

VERSION = 1
MAX_POSITIONS = 128
MAX_TICKS = 256


def core_position_id(owner, lower, upper, salt):
    owner, salt = address(owner), bytes32(salt)
    if not -887272 <= lower < upper <= 887272:
        raise DataError('invalid_core_position_range')
    packed = (bytes.fromhex(owner[2:]) + lower.to_bytes(3,'big',signed=True)
              + upper.to_bytes(3,'big',signed=True) + bytes.fromhex(salt[2:]))
    return '0x'+keccak(packed).hex()


def empty_tick():
    return {'gross':'0','net':'0','outsideX128':['0','0']}


def inside_growth(model, current_tick, lower, upper):
    a = model['ticks'].get(str(lower),empty_tick())['outsideX128']
    b = model['ticks'].get(str(upper),empty_tick())['outsideX128']
    growth = model['growthX128']
    if current_tick < lower:
        return [(int(a[i])-int(b[i])) & U256 for i in (0,1)]
    if current_tick >= upper:
        return [(int(b[i])-int(a[i])) & U256 for i in (0,1)]
    return [(int(growth[i])-int(a[i])-int(b[i])) & U256 for i in (0,1)]


def principal_amounts(activity, lower, upper, liquidity, *, round_up=False):
    """Floor per-position principal, or exact rounded modify-liquidity amounts."""
    price = int(activity['sqrtPriceX96'])
    lo, hi = sqrt_at_tick(lower), sqrt_at_tick(upper)
    clamped = min(hi,max(lo,price))
    return [amount_delta(clamped,hi,liquidity,0,round_up),
            amount_delta(lo,clamped,liquidity,1,round_up)]


def pending_fees(model, activity, position):
    inside = inside_growth(model,activity['tick'],position['tickLower'],position['tickUpper'])
    liquidity = int(position['liquidityRaw'])
    return [((inside[i]-int(position['lastInsideX128'][i])) & U256)*liquidity//Q128 for i in (0,1)]


def add_pair(model, name, amounts):
    model[name] = [str(int(model[name][i])+amounts[i]) for i in (0,1)]


def modify_position(model, activity, payload, spacing, *, capacity=None):
    owner = address(payload.get('sender'))
    salt = bytes32(payload.get('salt'))
    lower,upper,delta = payload['tickLower'],payload['tickUpper'],int(payload['liquidityDelta'])
    identity = core_position_id(owner,lower,upper,salt)
    if lower%spacing or upper%spacing:
        raise DataError('unaligned_core_position_range')
    old = model['positions'].get(identity)
    liquidity = int(old['liquidityRaw']) if old else 0
    if not 0 <= liquidity+delta < Q128 or (not delta and not liquidity):
        raise DataError('core_position_liquidity_mismatch')
    if old is None:
        if len(model['positions']) >= (capacity.positions if capacity else MAX_POSITIONS):
            raise DataError('core_position_budget_exhausted')
        old = {'coreOwner':owner,'tickLower':lower,'tickUpper':upper,'salt':salt,
               'liquidityRaw':'0','lastInsideX128':['0','0'],'settledFeesRaw':['0','0']}
        model['positions'][identity] = old
    if delta:
        maximum = (Q128-1)//(887272//spacing - (-887272//spacing) + 1)
        for tick, sign in ((lower,1),(upper,-1)):
            slot = str(tick)
            if slot not in model['ticks'] and len(model['ticks']) >= (capacity.ticks if capacity else MAX_TICKS):
                raise DataError('core_tick_budget_exhausted')
            item = model['ticks'].setdefault(slot,empty_tick())
            gross, net = int(item['gross'])+delta,int(item['net'])+sign*delta
            if not 0 <= gross < Q128 or not -(1<<127) <= net < 1<<127 or (delta>0 and gross>maximum):
                raise DataError('core_tick_liquidity_mismatch')
            if int(item['gross'])==0:
                item['outsideX128'] = list(model['growthX128']) if tick<=activity['tick'] else ['0','0']
            item.update(gross=str(gross),net=str(net))
    # Fees use liquidity BEFORE this update, after tick initialization and before clearing.
    fees = pending_fees(model,activity,old)
    if any(value >= 1<<127 for value in fees):
        raise DataError('core_fee_settlement_overflow')
    inside = inside_growth(model,activity['tick'],lower,upper)
    old.update(liquidityRaw=str(liquidity+delta),lastInsideX128=list(map(str,inside)))
    old['settledFeesRaw'] = [str(int(old['settledFeesRaw'][i])+fees[i]) for i in (0,1)]
    if delta<0:
        for tick in (lower,upper):
            if model['ticks'][str(tick)]['gross']=='0':
                model['ticks'][str(tick)] = empty_tick() # Retain a tombstone for on-chain reconciliation.
    principal = principal_amounts(activity,lower,upper,abs(delta),round_up=delta>0)
    # Core BalanceDelta amounts must fit int128; this is an observed modification.
    if any(value >= 1<<127 for value in principal):
        raise DataError('core_principal_delta_overflow')
    flow = [x if delta>0 else -x for x in principal]
    add_pair(model,'lpAssetsRaw',[flow[i]-fees[i] for i in (0,1)])
    add_pair(model,'settledFeesRaw',fees)
    add_pair(model,'principalDepositedRaw' if delta>0 else 'principalWithdrawnRaw',principal)
    return {'corePositionId':identity,'principalFlowRaw':list(map(str,flow)),'settledFeesRaw':list(map(str,fees))}


def assert_position_liquidity(model, activity):
    ranges = {}
    for p in model['positions'].values():
        if int(p['liquidityRaw']):
            slot=f"{p['tickLower']}:{p['tickUpper']}"
            ranges[slot]=str(int(ranges.get(slot,'0'))+int(p['liquidityRaw']))
    if ranges != activity['ranges']:
        raise DataError('core_position_range_mismatch')


def replay_positions(activity_model, position_model, events, pool_id, key, *, observe=None, capacity=None, budget=None, activity_capacity='standard'):
    check_activity_capacity(activity_model,activity_capacity)
    if not supported(key):
        raise DataError('position_accounting_adapter_required')
    activity, model = copy.deepcopy(activity_model),copy.deepcopy(position_model)
    if (activity is None)!=(model is None):
        raise DataError('position_anchor_required')
    if model is not None and model.get('version')!=VERSION:
        raise DataError('position_methodology_mismatch')
    if model is not None:
        if len(model['positions']) > (capacity.positions if capacity else MAX_POSITIONS):
            raise DataError('core_position_budget_exhausted')
        if len(model['ticks']) > (capacity.ticks if capacity else MAX_TICKS):
            raise DataError('core_tick_budget_exhausted')
    settlements=[];budget=[MAX_CHUNK_STEPS] if budget is None else budget
    for event in events:
        kind,p = event['kind'],event['payload']
        if kind=='initialize':
            if model is not None or tick_at_sqrt(int(p['sqrtPriceX96']))!=p['tick']:
                raise DataError('invalid_position_initialize_anchor')
            model={'version':VERSION,'positions':{},'ticks':{},'growthX128':['0','0'],'swapCount':0,'modifyCount':0,
                   **{name:['0','0'] for name in ('lpAssetsRaw','settledFeesRaw','principalDepositedRaw',
                        'principalWithdrawnRaw','tradingLpFeesRaw','protocolFeesRaw','donationsRaw')}}
        if model is None:
            raise DataError('position_anchor_required')
        if kind=='modify_liquidity':
            change=modify_position(model,activity,p,key.tick_spacing,capacity=capacity)
            settlements.append({**event,'settlement':change})
            model['modifyCount']+=1
        elif kind=='swap':
            fees=reconstruct_swap(activity,key,p,budget=budget,with_trace=True)
            direction=fees['inputCurrencyIndex']
            start=list(map(int,model['growthX128']))
            for crossing in fees['crossingGrowth']:
                global_at_cross=list(start)
                global_at_cross[direction]=(start[direction]+int(crossing['growthSinceSwapStartX128'])) & U256
                tick=model['ticks'].get(str(crossing['tick']))
                if not tick or tick['gross']=='0':
                    raise DataError('core_crossing_missing_tick')
                tick['outsideX128']=[str((global_at_cross[i]-int(tick['outsideX128'][i])) & U256) for i in (0,1)]
            model['growthX128']=[str((start[i]+int(fees['growthX128'][i])) & U256) for i in (0,1)]
            add_pair(model,'lpAssetsRaw',[-int(p[f'amount{i}'])-int(fees['protocolFeesRaw'][i]) for i in (0,1)])
            add_pair(model,'tradingLpFeesRaw',list(map(int,fees['lpFeesRaw'])))
            add_pair(model,'protocolFeesRaw',list(map(int,fees['protocolFeesRaw'])))
            model['swapCount']+=1
        elif kind=='donate':
            liquidity=active_liquidity(activity)
            if not liquidity:
                raise DataError('donation_without_active_liquidity')
            amounts=[int(p[f'amount{i}']) for i in (0,1)]
            model['growthX128']=[str((int(model['growthX128'][i])+amounts[i]*Q128//liquidity) & U256) for i in (0,1)]
            add_pair(model,'lpAssetsRaw',amounts);add_pair(model,'donationsRaw',amounts)
        activity=replay(activity,[event],pool_id,key.__dict__,capacity=activity_capacity)
        assert_position_liquidity(model,activity)
        if any(int(x)<0 for x in model['lpAssetsRaw']):
            raise DataError('negative_core_pool_assets')
        if observe is not None:
            observe(event, activity, model)
    return activity,model,settlements


def position_summary(model, activity, *, include_positions=False):
    principal=[0,0];pending=[0,0];items=[];live=0
    for identity,p in sorted(model['positions'].items()):
        amount=principal_amounts(activity,p['tickLower'],p['tickUpper'],int(p['liquidityRaw']))
        fees=pending_fees(model,activity,p)
        for i in (0,1):principal[i]+=amount[i];pending[i]+=fees[i]
        live+=int(int(p['liquidityRaw'])>0)
        if include_positions:
            items.append({'corePositionId':identity,**p,'principalRaw':list(map(str,amount)),
                          'unsettledFeesRaw':list(map(str,fees))})
    residual=[int(model['lpAssetsRaw'][i])-principal[i]-pending[i] for i in (0,1)]
    if any(x<0 for x in residual):
        raise DataError('core_pool_assets_below_liabilities')
    result={'methodologyVersion':VERSION,'status':'reconstructed_unverified','reason':'onchain_position_check_required',
            'scope':'core_positions_not_nft_ownership','basis':'event_token_flows_excluding_protocol',
            'lpAssetsRaw':model['lpAssetsRaw'],'principalRaw':list(map(str,principal)),
            'unsettledFeesRaw':list(map(str,pending)),'roundingResidualRaw':list(map(str,residual)),
            'settledFeesRaw':model['settledFeesRaw'],'principalDepositedRaw':model['principalDepositedRaw'],
            'principalWithdrawnRaw':model['principalWithdrawnRaw'],'corePositionCount':len(model['positions']),
            'nonzeroLiquidityPositionCount':live,'knownTickCount':len(model['ticks']),
            'donationsIncluded':True,'protocolFeesExcluded':True,'isWalletBalance':False,
            'isWithdrawalQuote':False,'nftOwnershipResolved':False,'tvlUsd':None,
            'tvlReason':'timestamp_aligned_valuation_unavailable'}
    if include_positions:result['items']=items
    return result
