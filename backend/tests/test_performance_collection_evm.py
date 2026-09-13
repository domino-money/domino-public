"""Real local EVM transport/receipts/reorgs with synthetic getter/event fixtures.

This qualifies the collector's ABI and JSON-RPC wiring, not deployed E2 contracts,
provider finality/completeness, fee origins, financial accounting or any price.
All fixture mutation methods go directly to the isolated loopback Anvil. The
collector receives only the real read-only PerformanceRpc transport.
"""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import unittest
import urllib.request

from eth_abi import encode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from discovery import POSITION_MANAGER, POOL_MANAGER, STATE_VIEW, ZERO
from performance_collection import CanonicalCollector, PerformanceRpc, ReorgDetected, event_id

ROOT = Path(__file__).resolve().parents[2]
OWNER = '0x'+'22'*20
VAULT = '0x'+'44'*20
IMPLEMENTATION = '0x'+'45'*20
FACTORY = '0x'+'46'*20
TOKEN = '0x'+'77'*20
OUTSIDER = '0x'+'88'*20
RPC_LABEL = 'https://rpc.mainnet.chain.robinhood.com'
# Addresses interpolated as bytes20 literals to avoid checksum-literal ambiguity.
SOURCE = '''// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
interface Move { function emitMove(address,address,uint256) external; }
interface Payment { function emitPayment(address,address,uint256) external; }
interface Pulse { function pulse(uint256) external; }
contract SyntheticEvidence {
 struct Key { address currency0; address currency1; uint24 fee; int24 spacing; address hooks; }
 struct Position { bool exists; bool active; bool isRoot; uint256 parentTokenId; uint64 generation;
   int24 tickLower; int24 tickUpper; bytes32 baselineId; bytes32 identity; bytes32 source0; bytes32 source1; }
 struct Checkpoint { uint128 liquidity; uint256 last0; uint256 last1; uint256 inside0; uint256 inside1;
   uint64 blockNumber; bytes32 checkpointHash; }
 address public constant owner=address(bytes20(hex"OWNER"));
 address public constant positionManager=address(bytes20(hex"PM"));
 address public constant poolManager=address(bytes20(hex"POOL"));
 address public constant stateView=address(bytes20(hex"STATE"));
 address public constant implementation=address(bytes20(hex"IMPL"));
 address public constant factory=address(bytes20(hex"FACTORY"));
 address public constant token=address(bytes20(hex"TOKEN"));
 address public constant vault=address(bytes20(hex"VAULT"));
 address public constant outsider=address(bytes20(hex"OUTSIDER"));
 uint256 public constant rootTokenId=1;
 uint256 public constant activePositions=1;
 uint64 public constant implementationVersion=1;
 bytes32 public constant sequenceIdentityHash=bytes32(uint256(90));
 address private holder;
 event Changed(uint256 value);
 event Transfer(address indexed from,address indexed to,uint256 indexed tokenId);
 function poolKey() public pure returns(Key memory) { return Key(address(0),token,3000,60,address(0)); }
 function poolId() public pure returns(bytes32) { return keccak256(abi.encode(poolKey())); }
 function position(uint256 id) external pure returns(Position memory) {
   require(id==1); return Position(true,true,true,0,1,-60,60,bytes32(uint256(91)),
     bytes32(uint256(92)),bytes32(uint256(93)),bytes32(uint256(94)));
 }
 function checkpoint(uint256) public pure returns(Checkpoint memory) {
   return Checkpoint(1000,0,0,1<<127,0,1,bytes32(uint256(91)));
 }
 function registrationCheckpoint(uint256 id) external pure returns(Checkpoint memory) { return checkpoint(id); }
 function accountedCurrency(address) external pure returns(uint256) { return 100; }
 function getPoolAndPositionInfo(uint256 id) external pure returns(Key memory,uint256) {
   require(id==1);
   uint256 info=(uint256(poolId()) & ~((uint256(1)<<56)-1)) | (uint256(uint24(16777156))<<8) | (uint256(60)<<32) | 1;
   return (poolKey(),info);
 }
 function ownerOf(uint256 id) external view returns(address) { require(id==1); return holder==address(0) ? owner : holder; }
 function getPositionLiquidity(uint256 id) external pure returns(uint128) { require(id==1); return 1000; }
 function getPositionInfo(bytes32,address,int24,int24,bytes32) external pure returns(uint128,uint256,uint256) { return(1000,0,0); }
 function getSlot0(bytes32) external pure returns(uint160,int24,uint24,uint24) { return(uint160(1<<96),0,0,3000); }
 function getFeeGrowthInside(bytes32,int24,int24) external pure returns(uint256,uint256) { return(1<<127,0); }
 function pulse(uint256 value) external { emit Changed(value); }
 function emitMove(address from,address to,uint256 id) external { holder=to; emit Transfer(from,to,id); }
 function exercise() external {
   emit Changed(1);
   Move(positionManager).emitMove(owner,outsider,1);
   Payment(token).emitPayment(owner,vault,33);
   Pulse(outsider).pulse(777);
   emit Changed(2);
 }
}
contract SyntheticToken {
 event Transfer(address indexed from,address indexed to,uint256 value);
 function balanceOf(address) external pure returns(uint256) { return 900; }
 function emitPayment(address from,address to,uint256 value) external { emit Transfer(from,to,value); }
}
'''
for placeholder, value in {'OWNER':OWNER,'PM':POSITION_MANAGER,'POOL':POOL_MANAGER,'STATE':STATE_VIEW,
        'IMPL':IMPLEMENTATION,'FACTORY':FACTORY,'TOKEN':TOKEN,'VAULT':VAULT,'OUTSIDER':OUTSIDER}.items():
    SOURCE = SOURCE.replace('hex"'+placeholder+'"', 'hex"'+value[2:]+'"')


def calldata(signature, types=(), values=()):
    return '0x'+(keccak(signature.encode())[:4]+encode(types,values)).hex()


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1', 'requires isolated local Anvil')
class PerformanceCollectionEvmTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        payload={'language':'Solidity','sources':{'Evidence.sol':{'content':SOURCE}},
            'settings':{'viaIR':True,'optimizer':{'enabled':True,'runs':200},'evmVersion':'cancun',
                'outputSelection':{'*':{'*':['evm.deployedBytecode.object']}}}}
        process=subprocess.run(['node',str(ROOT/'scripts/solc-compile.cjs')], input=json.dumps(payload),
            capture_output=True,text=True,check=True,timeout=60)
        compiled=json.loads(process.stdout)
        errors=[e['formattedMessage'] for e in compiled.get('errors',[]) if e['severity']=='error']
        if errors: raise AssertionError('\n'.join(errors))
        cls.contracts=compiled['contracts']['Evidence.sol']
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0)); port=sock.getsockname()[1]
        cls.url=f'http://127.0.0.1:{port}'
        cls.process=subprocess.Popen([str(ROOT/'node_modules/.bin/anvil'),'--host','127.0.0.1',
            '--port',str(port),'--chain-id','4663','--accounts','0','--silent'],
            stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        cls.addClassCleanup(cls.stop)
        for _ in range(100):
            try:
                if cls.rpc('eth_chainId',[]) != hex(4663): raise AssertionError('wrong isolated chain')
                break
            except OSError: time.sleep(.05)
        else: raise AssertionError('local Anvil failed to start')
        code=cls.contracts['SyntheticEvidence']['evm']['deployedBytecode']['object']
        cls.vault_hash='0x'+keccak(bytes.fromhex(code)).hex()
        for target in (VAULT,IMPLEMENTATION,FACTORY,POSITION_MANAGER,POOL_MANAGER,STATE_VIEW,OUTSIDER):
            cls.rpc('anvil_setCode',[target,'0x'+code])
        cls.rpc('anvil_setCode',[TOKEN,'0x'+cls.contracts['SyntheticToken']['evm']['deployedBytecode']['object']])
        cls.rpc('anvil_setBalance',[OWNER,hex(10**21)])
        cls.rpc('anvil_setBalance',[VAULT,hex(200)])
        cls.rpc('anvil_impersonateAccount',[OWNER])
        cls.rpc('evm_mine',[])
        cls.initial_snapshot=cls.rpc('evm_snapshot',[])

    @classmethod
    def stop(cls):
        cls.process.terminate()
        try: cls.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            cls.process.kill(); cls.process.wait(timeout=5)

    @classmethod
    def rpc(cls,method,params):
        request=urllib.request.Request(cls.url,json.dumps({'jsonrpc':'2.0','id':1,
            'method':method,'params':params}).encode(),{'Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=5) as response: result=json.load(response)
        if 'error' in result: raise AssertionError(result['error'])
        return result['result']

    def setUp(self):
        self.assertTrue(self.rpc('evm_revert',[self.initial_snapshot]))
        type(self).initial_snapshot=self.rpc('evm_snapshot',[])
        self.read_requests=[]
        def transport(url,body,**options):
            self.assertEqual(url,RPC_LABEL)
            self.read_requests.append((body['method'],body['params']))
            return {'jsonrpc':'2.0','id':body['id'],'result':self.rpc(body['method'],body['params'])}
        self.transport=transport
        self.collector=CanonicalCollector(PerformanceRpc(RPC_LABEL,transport=transport,max_requests=2048))
        self.baseline=self.collector.capture(OWNER,VAULT,['1'],self.vault_hash)

    def send(self,target,signature,types=(),values=()):
        tx_hash=self.rpc('eth_sendTransaction',[{'from':OWNER,'to':target,'data':calldata(signature,types,values),
            'gas':hex(1_000_000)}])
        # Submission can return before Anvil's autominer publishes the receipt,
        # especially on CI. Wait for the actual mined result within a fixed
        # deadline; never substitute a fabricated receipt or resend the action.
        deadline=time.monotonic()+5
        receipt=self.rpc('eth_getTransactionReceipt',[tx_hash])
        while receipt is None and time.monotonic()<deadline:
            time.sleep(.01)
            receipt=self.rpc('eth_getTransactionReceipt',[tx_hash])
        self.assertIsNotNone(receipt); self.assertEqual(receipt['status'],'0x1')
        return receipt

    def finalized(self):
        # Anvil's finalized tag deliberately trails latest. Mine enough local
        # empty blocks to include fixture transactions without fabricating tags.
        self.rpc('anvil_mine',['0x40'])

    def test_capture_reads_pinned_getters_current_principal_and_opening_fees(self):
        self.assertEqual(self.baseline.owner,OWNER)
        self.assertEqual(self.baseline.rootTokenId,'1')
        self.assertEqual(self.baseline.opening.members[0].unsettledFeesRaw,['500','0'])
        self.assertEqual(self.baseline.opening.heldRaw,['200','900'])
        self.assertEqual(len(self.baseline.opening.codePins),6)
        for method,params in self.read_requests:
            self.assertIn(method,PerformanceRpc.METHODS)
            if method in ('eth_call','eth_getBalance','eth_getCode'):
                self.assertEqual(params[-1],{'blockHash':self.baseline.baseline.blockHash,'requireCanonical':True})
        self.assertIsNone(self.collector.collect(self.baseline,self.baseline.baseline))

    def test_full_receipt_local_order_actual_gas_and_no_unrelated_receipt_reads(self):
        unrelated=self.send(OUTSIDER,'pulse(uint256)',['uint256'],[888])
        affected=self.send(VAULT,'exercise()')
        self.finalized()
        self.read_requests.clear()
        page=self.collector.collect(self.baseline,self.baseline.baseline)
        self.assertEqual(len(page.receipts),1)
        receipt=page.receipts[0]
        self.assertEqual(receipt.transactionHash,affected['transactionHash'])
        self.assertEqual(len(receipt.logs),5)
        self.assertEqual([e.receiptLogIndex for e in page.events],[0,1,2,4])
        self.assertEqual([e.kind for e in page.events],['vault','position_transfer','currency_transfer','vault'])
        self.assertEqual(page.events[-1].eventId,event_id(affected['transactionHash'],4))
        self.assertEqual(receipt.rawReceipt,affected)
        self.assertEqual(receipt.gasUsed,str(int(affected['gasUsed'],16)))
        self.assertEqual(receipt.effectiveGasPrice,str(int(affected['effectiveGasPrice'],16)))
        self.assertEqual(page.owner,OWNER)
        self.assertEqual(receipt.logs[1].topics[2][-40:],OUTSIDER[2:])
        self.assertFalse(any(m=='eth_getBlockReceipts' or (m in ('eth_getTransactionByHash','eth_getTransactionReceipt')
            and p==[unrelated['transactionHash']]) for m,p in self.read_requests))
        self.assertEqual(self.collector.collect(self.baseline,self.baseline.baseline),page)

    def test_real_cursor_reorg_reports_current_canonical_opening_for_replay(self):
        snapshot=self.rpc('evm_snapshot',[])
        self.send(VAULT,'pulse(uint256)',['uint256'],[1])
        self.finalized()
        page=self.collector.collect(self.baseline,self.baseline.baseline)
        self.assertTrue(self.rpc('evm_revert',[snapshot]))
        self.send(VAULT,'pulse(uint256)',['uint256'],[2])
        self.finalized()
        with self.assertRaises(ReorgDetected) as caught:
            self.collector.collect(self.baseline,page.throughCursor)
        self.assertEqual(caught.exception.observed_baseline,self.baseline.baseline)

    def test_real_baseline_reorg_requires_a_new_opening(self):
        snapshot=self.rpc('evm_snapshot',[])
        self.send(VAULT,'pulse(uint256)',['uint256'],[1])
        self.finalized()
        old=self.collector.capture(OWNER,VAULT,['1'],self.vault_hash)
        self.assertTrue(self.rpc('evm_revert',[snapshot]))
        self.send(VAULT,'pulse(uint256)',['uint256'],[2])
        self.finalized()
        with self.assertRaises(ReorgDetected) as caught:
            self.collector.collect(old,old.baseline)
        self.assertEqual(caught.exception.observed_baseline.blockNumber,old.baseline.blockNumber)
        self.assertNotEqual(caught.exception.observed_baseline.blockHash,old.baseline.blockHash)


if __name__=='__main__': unittest.main()
