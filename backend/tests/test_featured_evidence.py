"""Chain evidence for the featured-pools rules, from a scripted read-only node."""
from fractions import Fraction
from pathlib import Path
import sys
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from eth_hash.auto import keccak

from discovery import Block, DataError, STATE_VIEW
from featured_evidence import (active_liquidity, delegates, depth, eth_price, strip_metadata,
                               token_evidence)
from featured_pools import eth_usd, load_policy, reference_depth
from test_featured_pools import bitmaps
from v4_math import Q96, sqrt_at_tick, tick_at_sqrt

POLICY=load_policy()
BLOCK=Block(1234,'0x'+'ab'*32,1790380000)
TOKEN='0x39dbed3a2bd333467115de45665cc57f813c4571'
IMPLEMENTATION='0x'+'77'*20
POOL_ID='0x'+'4b'*32
PLAIN=bytes.fromhex('6080604052348015600f57600080fd5b50')
CLONE=bytes.fromhex('363d3d373d3d3d363d73'+IMPLEMENTATION[2:]+'5af43d82803e903d91602b57fd5bf3')


class Node:
    """StateView, token and code reads at one block; anything else is refused."""
    def __init__(self,*,codes=None,decimals=18,symbol='PONS',ticks=None,liquidity=10**18,
                 spacing=60,slot0=None):
        self.codes=codes or {}
        self.decimals,self.symbol_value=decimals,symbol
        self.ticks,self.liquidity,self.spacing,self.slot0=ticks or {},liquidity,spacing,slot0
        self.reads=[]

    def request(self,method,params):
        self.reads.append(method)
        assert params[-1]==BLOCK.tag,params
        if method=='eth_getCode':
            value=self.codes.get(params[0],b'')
            return value if isinstance(value,str) else '0x'+value.hex()
        raise AssertionError(method)

    def call(self,target,signature,inputs=(),values=(),outputs=(),*,block):
        assert block==BLOCK.tag
        self.reads.append(signature)
        if signature=='decimals()':
            if isinstance(self.decimals,Exception):raise self.decimals
            return (self.decimals,)
        assert target==STATE_VIEW,target
        if signature=='getLiquidity(bytes32)':return (self.liquidity,)
        if signature=='getSlot0(bytes32)':return self.slot0
        if signature=='getTickBitmap(bytes32,int16)':return (bitmaps(self.ticks,self.spacing)(values[1]),)
        if signature=='getTickLiquidity(bytes32,int24)':return (abs(self.ticks[values[1]]),self.ticks[values[1]])
        raise AssertionError(signature)

    def symbol(self,target,*,block):
        self.reads.append('symbol()')
        if isinstance(self.symbol_value,Exception):raise self.symbol_value
        return self.symbol_value


class DelegateScanTests(unittest.TestCase):
    def test_only_an_executable_delegatecall_counts(self):
        self.assertFalse(delegates(PLAIN))
        self.assertTrue(delegates(bytes.fromhex('5bf4')))
        self.assertFalse(delegates(bytes.fromhex('60f400')))              # PUSH1 0xf4
        self.assertFalse(delegates(bytes.fromhex('7f'+'f4'*32+'00')))     # PUSH32 of 0xf4
        self.assertTrue(delegates(bytes.fromhex('7f'+'00'*32+'f4')))
        self.assertTrue(delegates(bytes.fromhex('5ff4')))                 # PUSH0 carries no data

    def test_the_compiler_s_metadata_is_not_code(self):
        metadata=bytes.fromhex('a2')+bytes.fromhex('f4'*10)
        tagged=PLAIN+metadata+len(metadata).to_bytes(2,'big')
        self.assertEqual(strip_metadata(tagged),PLAIN)
        self.assertFalse(delegates(tagged))
        untagged=PLAIN+bytes.fromhex('00')+bytes.fromhex('f4'*10)+(11).to_bytes(2,'big')
        self.assertEqual(strip_metadata(untagged),untagged)
        self.assertTrue(delegates(untagged))
        self.assertEqual(strip_metadata(b'\x00\x05'),b'\x00\x05')


class TokenEvidenceTests(unittest.TestCase):
    def test_a_plain_token(self):
        node=Node(codes={TOKEN:PLAIN})
        evidence=token_evidence(node,TOKEN,BLOCK)
        self.assertEqual(evidence,{'address':TOKEN,'code':True,'codeHash':'0x'+keccak(PLAIN).hex(),
                                   'proxy':None,'implementation':None,'decimals':18,'symbol':'PONS'})

    def test_code_that_delegates_is_upgradeable_until_reviewed(self):
        evidence=token_evidence(Node(codes={TOKEN:PLAIN+bytes.fromhex('f4')}),TOKEN,BLOCK)
        self.assertEqual(evidence['proxy'],'delegatecall')

    def test_a_clone_is_judged_by_the_code_it_runs(self):
        for target,proxy in ((PLAIN,None),(PLAIN+bytes.fromhex('f4'),'delegatecall'),(b'','delegatecall')):
            node=Node(codes={TOKEN:CLONE,IMPLEMENTATION:target})
            evidence=token_evidence(node,TOKEN,BLOCK)
            with self.subTest(proxy=proxy):
                self.assertEqual((evidence['proxy'],evidence['implementation']),(proxy,IMPLEMENTATION))
                self.assertEqual(evidence['codeHash'],'0x'+keccak(CLONE).hex())

    def test_no_code_and_unreadable_metadata(self):
        self.assertEqual(token_evidence(Node(),TOKEN,BLOCK),{'address':TOKEN,'code':False})
        node=Node(codes={TOKEN:PLAIN},decimals=DataError('rpc_call_reverted'),symbol=DataError('invalid_symbol_text'))
        evidence=token_evidence(node,TOKEN,BLOCK)
        self.assertEqual((evidence['decimals'],evidence['symbol']),(None,None))

    def test_a_malformed_code_answer_is_the_node_s_failure(self):
        for answer in ('0x0','nope',None):
            node=Node(codes={TOKEN:answer if answer is not None else PLAIN})
            if answer is None:node.request=lambda method,params:None
            with self.subTest(answer=answer),self.assertRaisesRegex(DataError,'token_code_unavailable'):
                token_evidence(node,TOKEN,BLOCK)


class PoolEvidenceTests(unittest.TestCase):
    def pool(self,price):
        return {'poolId':POOL_ID,'poolKey':{'tick_spacing':60},'sqrtPriceX96':str(price),'tick':tick_at_sqrt(price)}

    def test_the_depth_walk_reads_the_pool_at_the_verified_block(self):
        price=sqrt_at_tick(0)+17
        ticks={-600:-(10**18),600:10**18}
        node=Node(ticks=ticks,liquidity=10**18)
        amount,reads=depth(node,self.pool(price),BLOCK,POLICY,liquidity=10**18,reference_is_currency1=True)
        expected=reference_depth(bitmaps(ticks,60),lambda t:ticks[t],sqrt_price=price,tick=tick_at_sqrt(price),
                                 liquidity=10**18,tick_spacing=60,reference_is_currency1=True,
                                 band=Fraction(1,10),max_steps=300)
        self.assertEqual(amount,expected)
        self.assertEqual(reads,len([r for r in node.reads if r.startswith('getTick')]))
        self.assertIn('getTickLiquidity(bytes32,int24)',node.reads)

    def test_active_liquidity_and_the_eth_price(self):
        node=Node(liquidity=5,slot0=(Q96*50,0,0,100))
        self.assertEqual(active_liquidity(node,POOL_ID,BLOCK),5)
        self.assertEqual(eth_price(node,POLICY,BLOCK),eth_usd(Q96*50))
        self.assertIsNone(eth_price(Node(liquidity=0,slot0=(Q96*50,0,0,100)),POLICY,BLOCK))
        self.assertIsNone(eth_price(Node(liquidity=5,slot0=(0,0,0,100)),POLICY,BLOCK))


if __name__=='__main__':unittest.main()
