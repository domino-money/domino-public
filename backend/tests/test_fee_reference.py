"""Independent, pinned v4-core EVM oracle. No fork or external chain writes."""
from dataclasses import asdict
import hashlib
import json
import os
from pathlib import Path
import random
import socket
import subprocess
import sys
import time
import unittest
import urllib.request

from eth_abi import encode, decode
from eth_hash.auto import keccak

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from catalogue import checked_key
from discovery import DataError
from fee_accounting import reconstruct_swap, replay_fees, simulate
from v4_math import MAX_SQRT, MIN_SQRT, Q96, sqrt_at_tick, swap_step, tick_at_sqrt
from test_catalogue import stored_candidate
from test_discovery import POOL

ROOT=Path(__file__).resolve().parents[2]
REFERENCE=Path(__file__).parent/'reference'
FIXTURE=Path(__file__).parent/'fixtures'/'fee-reference.json'


class ReferenceIntegrityTests(unittest.TestCase):
    def test_pinned_reference_hashes(self):
        manifest=json.loads((REFERENCE/'v4/provenance.json').read_text())
        for name,digest in manifest['sha256'].items():
            with self.subTest(file=name):
                self.assertEqual(hashlib.sha256((REFERENCE/'v4'/name).read_bytes()).hexdigest(),digest)

    def test_recorded_native_pool_vectors(self):
        fixture=json.loads(FIXTURE.read_text())
        for case in fixture['cases']:
            with self.subTest(case=case['name']):
                key=checked_key(case['poolKey'],case['poolId'])
                state=ledger=None
                for entry in case['sequence']:
                    state,ledger,rows=replay_fees(state,ledger,[entry['event']],case['poolId'],key)
                    self.assertEqual(ledger['growthX128'],entry['expectedGrowthX128'])
                    if rows:
                        self.assertEqual(sum(map(int,rows[0]['fees']['protocolFeesRaw'])),entry['expectedProtocolRaw'])


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM')=='1','requires isolated local Anvil differential oracle')
class NativeReferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        sources={str(p.relative_to(REFERENCE)):{'content':p.read_text()} for p in REFERENCE.rglob('*.sol')}
        payload={'language':'Solidity','sources':sources,'settings':{'viaIR':True,
                 'optimizer':{'enabled':True,'runs':200},'evmVersion':'cancun',
                 'outputSelection':{'PoolReference.sol':{'PoolReference':['evm.bytecode.object']}}}}
        run=subprocess.run(['node',str(ROOT/'scripts/solc-compile.cjs')],input=json.dumps(payload),
                           capture_output=True,text=True,timeout=60,check=True)
        compiled=json.loads(run.stdout)
        errors=[e['formattedMessage'] for e in compiled.get('errors',[]) if e['severity']=='error']
        if errors:raise AssertionError('\n'.join(errors))
        cls.bytecode=compiled['contracts']['PoolReference.sol']['PoolReference']['evm']['bytecode']['object']
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        cls.url=f'http://127.0.0.1:{port}'
        cls.process=subprocess.Popen([str(ROOT/'node_modules/.bin/anvil'),
                                     '--host','127.0.0.1','--port',str(port),'--chain-id','31337','--silent'],
                                     stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        cls.addClassCleanup(cls.stop)
        for _ in range(100):
            try:
                if cls.rpc('eth_chainId',[])!='0x7a69':raise AssertionError('local test chain required')
                cls.account=cls.rpc('eth_accounts',[])[0]
                break
            except OSError:time.sleep(.05)
        else:raise AssertionError('local EVM failed to start')

    @classmethod
    def stop(cls):
        cls.process.terminate();cls.process.wait(timeout=10)

    @classmethod
    def rpc(cls,method,params):
        request=urllib.request.Request(cls.url,json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode(),
                                       {'Content-Type':'application/json'})
        # Only the ephemeral 127.0.0.1 Anvil endpoint is ever a write target.
        with urllib.request.urlopen(request,timeout=10) as response:result=json.load(response)
        if 'error' in result:raise AssertionError(result['error'])
        return result['result']

    def tx(self,data,to=None):
        tx={'from':self.account,'data':data,'gas':'0x1c9c380'}
        if to:tx['to']=to
        digest=self.rpc('eth_sendTransaction',[tx])
        for _ in range(100):
            receipt=self.rpc('eth_getTransactionReceipt',[digest])
            if receipt is not None:break
            time.sleep(.01)
        self.assertIsNotNone(receipt,'local EVM receipt deadline')
        self.assertEqual(receipt['status'],'0x1')
        return receipt

    def setUp(self):
        self.contract=self.tx('0x'+self.bytecode)['contractAddress']

    def data(self,signature,types,values):
        return '0x'+(keccak(signature.encode())[:4]+encode(types,values)).hex()

    def call(self,signature,types,values,outputs):
        raw=self.rpc('eth_call',[{'to':self.contract,'data':self.data(signature,types,values),'gas':'0x1c9c380'},'latest'])
        return decode(outputs,bytes.fromhex(raw[2:]))

    def send(self,signature,types,values):
        self.tx(self.data(signature,types,values),self.contract)

    def test_1024_swap_steps_and_128_tick_roundtrips(self):
        rng=random.Random(4663)
        for i in range(128):
            tick=rng.randint(-887271,887271)
            price,=self.call('sqrtAt(int24)',['int24'],[tick],['uint160'])
            self.assertEqual(sqrt_at_tick(tick),price)
            expected,=self.call('tickAt(uint160)',['uint160'],[price+1],['int24'])
            self.assertEqual(tick_at_sqrt(price+1),expected)
        for i in range(1024):
            t=rng.randint(-700000,700000);n=t+rng.choice([-1,1])*rng.randint(1,30000)
            price,target=sqrt_at_tick(t),sqrt_at_tick(n)
            liquidity=rng.choice([1,100,10**12,2**110+127])
            fee=rng.choice([0,1,100,3000,3997,10000,999999,1000000])
            amount=rng.choice([1,2,1000,10**16,2**100+9])
            if fee==1000000 or rng.randrange(2):amount=-amount
            values=[price,target,liquidity,amount,fee]
            expected=self.call('step(uint160,uint160,uint128,int256,uint24)',
                ['uint160','uint160','uint128','int256','uint24'],values,['uint160','uint256','uint256','uint256'])
            with self.subTest(step=i):self.assertEqual(swap_step(*values),expected)

    def test_native_position_states_settlements_and_principal(self):
        from position_reference_cases import run_native_position_reference
        run_native_position_reference(self)

    def test_v4_negative_tick_floor_cap_matches_python_admission(self):
        from position_accounting import modify_position, replay_positions
        from test_position_accounting import reference
        fixture=reference();key=checked_key(fixture['poolKey'],POOL)
        state,model,_=replay_positions(None,None,[fixture['sequence'][0]['event']],POOL,key)
        for spacing in (1,3,10,60,200,887,16384,32767):
            cap,=self.call('tickCap(int24)',['int24'],[spacing],['uint128'])
            self.assertEqual(cap,((1<<128)-1)//(887272//spacing-(-887272//spacing)+1))
            # Exercise the actual admission formula, not just a duplicate helper.
            import copy
            payload={**fixture['sequence'][1]['event']['payload'], 'tickLower':-spacing,
                     'tickUpper':spacing,'liquidityDelta':str(cap)}
            modify_position(copy.deepcopy(model),state,payload,spacing)
            payload['liquidityDelta']=str(cap+1)
            with self.assertRaisesRegex(DataError,'core_tick_liquidity_mismatch'):
                modify_position(copy.deepcopy(model),state,payload,spacing)

    def test_native_pool_sequences_crossings_gaps_protocol_and_liquidity_changes(self):
        cases=[]
        operations=[('modify',[-60000,60000,10**12]),('modify',[-120,0,5*10**12]),
                    ('modify',[0,120,5*10**12]),('protocol',[1000+(200<<12)]),
                    ('swap',[True,-10**11,sqrt_at_tick(-40000)]),
                    ('swap',[False,10**10,sqrt_at_tick(40000)]),
                    ('donate',[10**9+3,10**7+1]),('modify',[-60000,60000,-10**11]),
                    ('modify',[-60000,60000,0]),('modify',[-60,180,3*10**12]),
                    ('swap',[False,-10**16,sqrt_at_tick(80000)]),
                    ('swap',[True,10**16,sqrt_at_tick(-80000)]),
                    ('swap',[False,-10**15,sqrt_at_tick(0)]),
                    ('protocol',[0]),('swap',[True,-1,MIN_SQRT+1]),
                    ('swap',[False,0,MAX_SQRT-1])]
        for name,fee,spacing,ops in [
            ('crossings_and_empty_tails',3000,60,operations),
            ('zero_liquidity_price_move',3000,60,[('swap',[True,-1,sqrt_at_tick(-40000)])]),
            ('full_fee',1000000,60,[('modify',[-60000,60000,10**12]),('swap',[True,-98765,MIN_SQRT+1])]),
            ('protocol_only',0,60,[('modify',[-60000,60000,10**12]),('protocol',[1000+(200<<12)]),
                                 ('swap',[True,-10**11,MIN_SQRT+1]),('swap',[False,10**9,MAX_SQRT-1])])]:
            self.setUp()
            self.send('initialize(uint160,uint24,int24)',['uint160','uint24','int24'],[Q96,fee,spacing])
            rawkey=stored_candidate()['poolKey'];rawkey['fee_pips']=fee;rawkey['tick_spacing']=spacing
            raw=tuple(rawkey[k] for k in ('currency0','currency1','fee_pips','tick_spacing','hooks'))
            pool_id='0x'+keccak(encode(['address','address','uint24','int24','address'],raw)).hex()
            key=checked_key(rawkey,pool_id)
            initial={'poolId':pool_id,'kind':'initialize','payload':{'poolKey':rawkey,'sqrtPriceX96':str(Q96),'tick':0},
                     'timestamp':1000,'blockNumber':10,'blockHash':'0x'+'11'*32,'logIndex':0}
            state,ledger,_=replay_fees(None,None,[initial],pool_id,key)
            case={'name':name,'poolId':pool_id,'poolKey':rawkey,
                  'sequence':[{'event':initial,'expectedGrowthX128':['0','0']}]}
            for i,(kind,values) in enumerate(ops):
                payload={};protocol_amount=None
                if kind=='modify':
                    self.send('modify(int24,int24,int128)',['int24','int24','int128'],values)
                    payload=dict(tickLower=values[0],tickUpper=values[1],liquidityDelta=str(values[2]),salt='0x'+'00'*32)
                elif kind=='protocol':
                    self.send('protocol(uint24)',['uint24'],values);payload={'protocolFeeRaw':values[0]}
                elif kind=='donate':
                    self.send('donate(uint256,uint256)',['uint256','uint256'],values)
                    payload={'amount0':str(values[0]),'amount1':str(values[1])}
                else:
                    signature='runSwap(bool,int256,uint160)';types=['bool','int256','uint160']
                    result=self.call(signature,types,values,['int128','int128','uint160','uint128','int24','uint24','uint256','uint256','uint256'])
                    a0,a1,sqrt,liquidity,tick,rate,protocol_amount,g0,g1=result
                    payload={'amount0':str(a0),'amount1':str(a1),'sqrtPriceX96':str(sqrt),
                             'liquidity':str(liquidity),'tick':tick,'swapFeePips':rate}
                    self.send(signature,types,values)
                event={**initial,'kind':{'modify':'modify_liquidity','protocol':'protocol_fee'}.get(kind,kind),
                       'payload':payload,'timestamp':1001+i,'blockNumber':11+i,'logIndex':i+1}
                state,ledger,rows=replay_fees(state,ledger,[event],pool_id,key)
                growth=[str(x) for x in self.call('growth()',[],[],['uint256','uint256'])]
                self.assertEqual(ledger['growthX128'],growth,(name,i))
                if rows:self.assertEqual(sum(map(int,rows[0]['fees']['protocolFeesRaw'])),protocol_amount)
                case['sequence'].append({'event':event,'expectedGrowthX128':growth,
                                         **({'expectedProtocolRaw':protocol_amount} if protocol_amount is not None else {})})
            cases.append(case)
        if os.environ.get('DOMINO_WRITE_REFERENCE_FIXTURE')=='1':
            FIXTURE.parent.mkdir(exist_ok=True)
            FIXTURE.write_text(json.dumps({'referenceRevision':'46c6834698c48bc4a463a86d8420f4eb1d7f3b75',
                                         'cases':cases},indent=2)+'\n')
