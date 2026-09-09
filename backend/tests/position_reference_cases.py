"""Drive the original Pool library; capture independent position/flow evidence."""
import json
import os
from pathlib import Path

from catalogue import checked_key
from position_accounting import (core_position_id, inside_growth, pending_fees, principal_amounts,
                                 replay_positions, position_summary)
from test_catalogue import stored_candidate
from test_discovery import POOL
from v4_math import Q96, sqrt_at_tick

FIXTURE=Path(__file__).parent/'fixtures/position-reference.json'
OWNER_A='0x'+'11'*20
OWNER_B='0x'+'22'*20


def run_native_position_reference(test):
    modify_sig='modifyOwned(address,int24,int24,int128,bytes32)'
    modify_types=['address','int24','int24','int128','bytes32']
    test.send('initialize(uint160,uint24,int24)',['uint160','uint24','int24'],[Q96,3000,60])
    key=checked_key(stored_candidate()['poolKey'],POOL)
    operations=[
        ('modify',[OWNER_A,-60000,60000,10**12,1]),
        ('modify',[OWNER_A,-60000,60000,4*10**11,2]),
        ('modify',[OWNER_B,-60,60,2*10**12,1]),
        ('protocol',[1000+(200<<12)]),('swap',[False,-10**11,sqrt_at_tick(40000)]),
        ('donate',[10000003,200000007]),('modify',[OWNER_A,-60000,60000,0,1]),
        ('modify',[OWNER_A,-60000,60000,-2*10**11,2]),
        ('modify',[OWNER_A,-60000,60000,3*10**11,1]),
        ('modify',[OWNER_B,-60,60,-2*10**12,1]),
        ('swap',[True,-10**14,sqrt_at_tick(-70000)]),
        ('modify',[OWNER_A,-60000,60000,-2*10**11,2]),
        ('modify',[OWNER_A,-60000,60000,-13*10**11,1]),
        ('swap',[False,-1,sqrt_at_tick(70000)]),
        ('modify',[OWNER_B,-60,60,5*10**11,1]),
        ('modify',[OWNER_A,-60000,60000,10**12,1]),
        ('swap',[True,10**10,sqrt_at_tick(-100000)]),
        ('donate',[987654321,123456789]),('modify',[OWNER_B,-60,60,0,1]),
    ]
    initial={'poolId':POOL,'kind':'initialize','payload':{'poolKey':key.__dict__,'sqrtPriceX96':str(Q96),'tick':0},
             'timestamp':1010,'blockNumber':10,'blockHash':'0x'+'11'*32,'logIndex':0}
    state,model,_=replay_positions(None,None,[initial],POOL,key)
    sequence=[{'event':initial,'expectedGrowthX128':['0','0'],'expectedAssetsRaw':['0','0'],
               'expectedPositions':{},'expectedTicks':{}}]
    balances=[0,0]
    for index,(kind,values) in enumerate(operations):
        settled=None
        if kind=='modify':
            owner,lo,hi,delta,salt=values;salt=salt.to_bytes(32,'big')
            args=[owner,lo,hi,delta,salt]
            d0,d1,f0,f1=test.call(modify_sig,modify_types,args,['int128']*4)
            test.send(modify_sig,modify_types,args)
            balances=[balances[0]-d0-f0,balances[1]-d1-f1]
            payload={'sender':owner,'tickLower':lo,'tickUpper':hi,'liquidityDelta':str(delta),'salt':'0x'+salt.hex()}
            settled={'corePositionId':core_position_id(owner,lo,hi,payload['salt']),
                     'principalFlowRaw':[str(-d0),str(-d1)],'settledFeesRaw':[str(f0),str(f1)]}
            native_id,=test.call('positionId(address,int24,int24,bytes32)',
                                ['address','int24','int24','bytes32'],[owner,lo,hi,salt],['bytes32'])
            test.assertEqual('0x'+native_id.hex(),settled['corePositionId'])
        elif kind=='protocol':
            test.send('protocol(uint24)',['uint24'],values);payload={'protocolFeeRaw':values[0]}
        elif kind=='donate':
            test.send('donate(uint256,uint256)',['uint256','uint256'],values)
            balances=[balances[i]+values[i] for i in (0,1)]
            payload={'amount0':str(values[0]),'amount1':str(values[1])}
        else:
            signature='runSwap(bool,int256,uint160)';types=['bool','int256','uint160']
            a0,a1,sqrt,l,tick,fee,protocol,g0,g1=test.call(signature,types,values,
                ['int128','int128','uint160','uint128','int24','uint24','uint256','uint256','uint256'])
            test.send(signature,types,values)
            payload={'amount0':str(a0),'amount1':str(a1),'sqrtPriceX96':str(sqrt),
                     'liquidity':str(l),'tick':tick,'swapFeePips':fee}
            balances=[balances[0]-a0-(protocol if values[0] else 0),
                      balances[1]-a1-(protocol if not values[0] else 0)]
        event={**initial,'kind':{'modify':'modify_liquidity','protocol':'protocol_fee'}.get(kind,kind),
               'payload':payload,'timestamp':1011+index,'blockNumber':11+index,'logIndex':index+1}
        state,model,changes=replay_positions(state,model,[event],POOL,key)
        if settled is not None:test.assertEqual(changes[0]['settlement'],settled)
        growth=list(map(str,test.call('growth()',[],[],['uint256','uint256'])))
        test.assertEqual(model['growthX128'],growth)
        test.assertEqual(model['lpAssetsRaw'],list(map(str,balances)))
        expected_positions={};expected_ticks={}
        for identity,p in model['positions'].items():
            owner,lo,hi,salt=p['coreOwner'],p['tickLower'],p['tickUpper'],bytes.fromhex(p['salt'][2:])
            liquidity,last0,last1=test.call('positionInfo(address,int24,int24,bytes32)',
                ['address','int24','int24','bytes32'],[owner,lo,hi,salt],['uint128','uint256','uint256'])
            inside=list(map(str,test.call('inside(int24,int24)',['int24','int24'],[lo,hi],['uint256','uint256'])))
            principal=[0,0];fees=[0,0]
            if liquidity:
                d0,d1,f0,f1=test.call(modify_sig,modify_types,[owner,lo,hi,-liquidity,salt],['int128']*4)
                principal=[d0,d1];fees=[f0,f1]
            expected={'liquidityRaw':str(liquidity),'lastInsideX128':[str(last0),str(last1)],
                      'insideX128':inside,'principalRaw':list(map(str,principal)),
                      'unsettledFeesRaw':list(map(str,fees))}
            test.assertEqual(p['liquidityRaw'],expected['liquidityRaw'])
            test.assertEqual(p['lastInsideX128'],expected['lastInsideX128'])
            test.assertEqual(list(map(str,inside_growth(model,state['tick'],lo,hi))),inside)
            test.assertEqual(principal_amounts(state,lo,hi,liquidity),principal)
            test.assertEqual(pending_fees(model,state,p),fees)
            expected_positions[identity]=expected
        for tick,item in model['ticks'].items():
            gross,net,g0,g1=test.call('tickInfo(int24)',['int24'],[int(tick)],['uint128','int128','uint256','uint256'])
            expected={'gross':str(gross),'net':str(net),'outsideX128':[str(g0),str(g1)]}
            test.assertEqual(item,expected);expected_ticks[tick]=expected
        position_summary(model,state) # Enforce nonnegative residuals after every event.
        sequence.append({'event':event,'expectedGrowthX128':growth,'expectedAssetsRaw':list(map(str,balances)),
                         'expectedPositions':expected_positions,'expectedTicks':expected_ticks,
                         **({'expectedSettlement':settled} if settled is not None else {})})
    if os.environ.get('DOMINO_WRITE_POSITION_FIXTURE')=='1':
        FIXTURE.write_text(json.dumps({'referenceRevision':'46c6834698c48bc4a463a86d8420f4eb1d7f3b75',
                                       'poolId':POOL,'poolKey':key.__dict__,'sequence':sequence},indent=2)+'\n')
