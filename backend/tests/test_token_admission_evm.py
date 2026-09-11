"""Actual local upgrades and restrictions; no real token or network admission.

All writes target a fresh loopback Anvil. The deliberately unrestricted token
control setters make synthetic state transitions easy to test; these contracts
are neither deployable product contracts nor a proxy security implementation.
"""
from copy import deepcopy
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import time
import unittest
import urllib.request

from eth_abi import decode, encode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deposit_models import DepositError
from discovery import ZERO, POOL_MANAGER, POSITION_MANAGER
from token_admission import POLICY, PERMIT2, TokenAdmission, check_profile, validate_profile
from test_token_admission import code_hash, seal, word

ROOT = Path(__file__).resolve().parents[2]
SOURCE = '''// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
contract ReviewedProxy {
 bytes32 constant IMPL = bytes32(uint256(keccak256("eip1967.proxy.implementation"))-1);
 bytes32 constant ADMIN = bytes32(uint256(keccak256("eip1967.proxy.admin"))-1);
 bytes32 constant BEACON = bytes32(uint256(keccak256("eip1967.proxy.beacon"))-1);
 constructor(address implementation,address admin) {
   bytes32 i=IMPL; bytes32 a=ADMIN; assembly { sstore(i,implementation) sstore(a,admin) }
 }
 modifier onlyAdmin() { bytes32 s=ADMIN; address a; assembly { a := sload(s) } require(msg.sender==a,"admin"); _; }
 function upgradeTo(address next) external onlyAdmin { bytes32 s=IMPL; assembly { sstore(s,next) } }
 function changeAdmin(address next) external onlyAdmin { bytes32 s=ADMIN; assembly { sstore(s,next) } }
 function setBeacon(address next) external onlyAdmin { bytes32 s=BEACON; assembly { sstore(s,next) } }
 fallback() external payable {
   bytes32 s=IMPL; assembly {
     let implementation := sload(s)
     calldatacopy(0,0,calldatasize())
     let ok := delegatecall(gas(),implementation,0,calldatasize(),0,0)
     returndatacopy(0,0,returndatasize())
     switch ok case 0 { revert(0,returndatasize()) } default { return(0,returndatasize()) }
   }
 }
}
contract ReviewedAdmin {
 address public owner;
 constructor(address initialOwner) { owner=initialOwner; }
 modifier onlyOwner() { require(msg.sender==owner,"owner"); _; }
 function setOwner(address next) external onlyOwner { owner=next; }
 function upgrade(address proxy,address next) external onlyOwner { ReviewedProxy(payable(proxy)).upgradeTo(next); }
 function changeAdmin(address proxy,address next) external onlyOwner { ReviewedProxy(payable(proxy)).changeAdmin(next); }
 function setBeacon(address proxy,address next) external onlyOwner { ReviewedProxy(payable(proxy)).setBeacon(next); }
}
contract ReviewedToken {
 uint256 public flags;
 mapping(address=>uint256) public restrictions;
 mapping(address=>uint256) public balanceOf;
 mapping(address=>mapping(address=>uint256)) public allowance;
 event Transfer(address indexed from,address indexed to,uint256 amount);
 function decimals() external pure returns(uint8) { return 18; }
 function setFlags(uint256 next) external { flags=next; }
 function setRestriction(address account,uint256 next) external { restrictions[account]=next; }
 function mint(address account,uint256 amount) external { balanceOf[account]+=amount; }
 function approve(address spender,uint256 amount) external returns(bool) { allowance[msg.sender][spender]=amount; return true; }
 function check(address from,address to) internal view {
   require(flags & 256 == 0,"paused");
   require(restrictions[from] & 8 == 0 && restrictions[to] & 8 == 0 && restrictions[msg.sender] & 8 == 0,"frozen");
 }
 function transfer(address to,uint256 amount) external virtual returns(bool) {
   check(msg.sender,to); balanceOf[msg.sender]-=amount; balanceOf[to]+=amount;
   emit Transfer(msg.sender,to,amount); return true;
 }
 function transferFrom(address from,address to,uint256 amount) external returns(bool) {
   check(from,to); allowance[from][msg.sender]-=amount; balanceOf[from]-=amount; balanceOf[to]+=amount;
   emit Transfer(from,to,amount); return true;
 }
}
contract UnreviewedTaxToken is ReviewedToken {
 function transfer(address to,uint256 amount) external override returns(bool) {
   check(msg.sender,to); balanceOf[msg.sender]-=amount; balanceOf[to]+=amount-1;
   emit Transfer(msg.sender,to,amount-1); return true;
 }
}
'''


def calldata(signature, types=(), values=()):
    return '0x' + (keccak(signature.encode())[:4] + encode(types, values)).hex()


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1', 'requires isolated local Anvil')
class TokenAdmissionEvmTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        payload={'language':'Solidity','sources':{'TokenReview.sol':{'content':SOURCE}},
            'settings':{'optimizer':{'enabled':True,'runs':200},'evmVersion':'cancun',
                'outputSelection':{'*':{'*':['evm.bytecode.object']}}}}
        result=subprocess.run(['node',str(ROOT/'scripts/solc-compile.cjs')],input=json.dumps(payload),
            text=True,capture_output=True,timeout=60,check=True)
        compiled=json.loads(result.stdout)
        errors=[row['formattedMessage'] for row in compiled.get('errors',[]) if row['severity']=='error']
        if errors:raise AssertionError('\n'.join(errors))
        cls.contracts=compiled['contracts']['TokenReview.sol']
        with socket.socket() as sock:
            sock.bind(('127.0.0.1',0));port=sock.getsockname()[1]
        cls.url=f'http://127.0.0.1:{port}'
        cls.process=subprocess.Popen([str(ROOT/'node_modules/.bin/anvil'),'--host','127.0.0.1',
            '--port',str(port),'--chain-id','4663','--silent'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        cls.addClassCleanup(cls.stop)
        for _ in range(100):
            try:
                if cls.rpc('eth_chainId',[])!='0x1237':raise AssertionError('isolated test chain required')
                cls.owner,cls.other=cls.rpc('eth_accounts',[])[:2]
                break
            except OSError:time.sleep(.03)
        else:raise AssertionError('local EVM unavailable')

    @classmethod
    def stop(cls):
        cls.process.terminate();cls.process.wait(timeout=10)

    @classmethod
    def rpc(cls,method,params):
        request=urllib.request.Request(cls.url,json.dumps({'jsonrpc':'2.0','id':1,'method':method,'params':params}).encode(),
            {'Content-Type':'application/json'})
        with urllib.request.urlopen(request,timeout=5) as response:body=json.load(response)
        if 'error' in body:raise AssertionError('isolated EVM RPC failure: '+str(body['error']['code']))
        return body['result']

    def setUp(self):
        self.snapshot=self.rpc('evm_snapshot',[])
        self.addCleanup(lambda:self.rpc('evm_revert',[self.snapshot]))
        self.implementation=self.deploy('ReviewedToken')
        self.changed=self.deploy('UnreviewedTaxToken')
        self.admin=self.deploy('ReviewedAdmin',['address'],[self.owner])
        self.token=self.deploy('ReviewedProxy',['address','address'],[self.implementation,self.admin])
        self.send(self.token,calldata('mint(address,uint256)',['address','uint256'],[self.owner,1000]))
        self.review=validate_profile(self.build_profile())
        self.registry=TokenAdmission([self.review])
        self.admission={'policyVersion':POLICY,'tokenReviews':[{'address':self.token,'reviewId':self.review['reviewId']}]}
        self.reads=[]

    def send(self,to,data,*,status='0x1'):
        transaction={'from':self.owner,'data':data,'gas':hex(1500000)}
        if to is not None:transaction['to']=to
        tx_hash=self.rpc('eth_sendTransaction',[transaction])
        for _ in range(100):
            receipt=self.rpc('eth_getTransactionReceipt',[tx_hash])
            if receipt is not None:break
            time.sleep(.01)
        else:raise AssertionError('local receipt unavailable')
        self.assertEqual(receipt['status'],status)
        return receipt

    def deploy(self,name,types=(),values=()):
        data='0x'+self.contracts[name]['evm']['bytecode']['object']+encode(types,values).hex()
        return self.send(None,data)['contractAddress'].lower()

    def block(self):
        raw=self.rpc('eth_getBlockByNumber',['latest',False])
        return {'number':int(raw['number'],16),'hash':raw['hash'],'timestamp':int(raw['timestamp'],16)}

    def build_profile(self):
        def identity(target):return {'address':target,'codeHash':code_hash(self.rpc('eth_getCode',[target,'latest']))}
        return seal({**identity(self.token),'reviewId':'','reviewReference':'Offline test-only Solidity source above',
            'standardTransfer':True,'nonRebasing':True,'approvalReturn':'bool','kind':'erc1967_transparent',
            'implementation':identity(self.implementation),'admin':self.admin,'dependencies':[identity(self.admin)],
            'identityStorage':[{'address':self.admin,'slot':word(0),'value':word(self.owner)}],
            'identityCalls':[{'address':self.token,'data':calldata('decimals()'),'result':word(18)},
                {'address':self.admin,'data':calldata('owner()'),'result':word(self.owner)}],
            'stateStorage':[{'slot':word(0),'mask':word(256),'value':word(0)}],
            'accountStorage':[{'slot':word(1),'mask':word(8),'value':word(0),
                'accounts':['owner','permit2','pool_manager','position_manager']}]})

    def read(self,method,params):
        self.assertIn(method,('eth_getCode','eth_getStorageAt','eth_call'))
        self.assertEqual(set(params[-1]),{'blockHash','requireCanonical'})
        self.assertIs(params[-1]['requireCanonical'],True)
        self.reads.append((method,deepcopy(params)))
        return self.rpc(method,params)

    def guard(self,block=None):
        check_profile(self.read,self.review,owner=self.owner,block=block or self.block())

    def balance(self,account):
        raw=self.rpc('eth_call',[{'to':self.token,'data':calldata('balanceOf(address)',['address'],[account])},'latest'])
        return decode(['uint256'],bytes.fromhex(raw[2:]))[0]

    def denied_transfer(self,code):
        nonce=self.rpc('eth_getTransactionCount',[self.owner,'latest'])
        with self.assertRaises(DepositError) as caught:
            self.guard()
            self.send(self.token,calldata('transfer(address,uint256)',['address','uint256'],[self.other,100]))
        self.assertEqual(caught.exception.code,code)
        self.assertEqual(self.rpc('eth_getTransactionCount',[self.owner,'latest']),nonce)

    def test_reviewed_proxy_transfers_exactly_and_matches_both_receipt_blocks(self):
        before=self.block();self.guard(before)
        self.send(self.token,calldata('transfer(address,uint256)',['address','uint256'],[self.other,100]))
        after=self.block()
        self.assertEqual((self.balance(self.owner),self.balance(self.other)),(900,100))
        result=self.registry.receipt(request=self.read,currency=self.token,admission=self.admission,before=before,block=after)
        self.assertEqual(result,{'status':'matched','reviewId':self.review['reviewId'],'upgradeable':True})
        self.assertEqual({p[-1]['blockHash'] for _,p in self.reads},{before['hash'],after['hash']})

    def test_actual_upgrade_changes_transfer_semantics_and_guard_prevents_use(self):
        before=self.block();self.guard(before)
        self.send(self.admin,calldata('upgrade(address,address)',['address','address'],[self.token,self.changed]))
        after=self.block();self.denied_transfer('deposit_token_changed')
        result=self.registry.receipt(request=self.read,currency=self.token,admission=self.admission,before=before,block=after)
        self.assertEqual(result['status'],'changed')
        # Deliberately bypass the guard only in this isolated negative oracle:
        # the unreviewed implementation really taxes a transfer by one unit.
        self.send(self.token,calldata('transfer(address,uint256)',['address','uint256'],[self.other,100]))
        self.assertEqual((self.balance(self.owner),self.balance(self.other)),(900,99))
        missing=TokenAdmission([]).receipt(request=self.read,currency=self.token,admission=self.admission,before=before,block=after)
        self.assertEqual(missing['status'],'unavailable')

    def test_different_implementation_address_is_denied_even_for_identical_runtime(self):
        identical=self.deploy('ReviewedToken')
        self.assertEqual(code_hash(self.rpc('eth_getCode',[identical,'latest'])),self.review['implementation']['codeHash'])
        self.send(self.admin,calldata('upgrade(address,address)',['address','address'],[self.token,identical]))
        self.denied_transfer('deposit_token_changed')

    def test_pause_mask_and_owner_freeze_guard_match_real_reverts(self):
        self.send(self.token,calldata('setFlags(uint256)',['uint256'],[1<<200]));self.guard()
        self.send(self.token,calldata('setFlags(uint256)',['uint256'],[(1<<200)|256]))
        self.denied_transfer('deposit_token_restricted')
        self.send(self.token,calldata('transfer(address,uint256)',['address','uint256'],[self.other,1]),status='0x0')
        self.send(self.token,calldata('setFlags(uint256)',['uint256'],[0]))
        self.send(self.token,calldata('setRestriction(address,uint256)',['address','uint256'],[self.owner,(1<<180)|8]))
        self.denied_transfer('deposit_token_restricted')
        self.send(self.token,calldata('transfer(address,uint256)',['address','uint256'],[self.other,1]),status='0x0')
        self.send(self.token,calldata('setRestriction(address,uint256)',['address','uint256'],[self.owner,1<<180]))
        self.guard();self.send(self.token,calldata('transfer(address,uint256)',['address','uint256'],[self.other,1]))
        self.assertEqual(self.balance(self.other),1)

    def test_freeze_of_every_deposit_context_blocks_preparation_but_not_historical_identity(self):
        before=self.block()
        for account in (self.owner,PERMIT2,POOL_MANAGER,POSITION_MANAGER):
            with self.subTest(account=account):
                self.send(self.token,calldata('setRestriction(address,uint256)',['address','uint256'],[account,8]))
                self.denied_transfer('deposit_token_restricted')
                result=self.registry.receipt(request=self.read,currency=self.token,admission=self.admission,before=before,block=self.block())
                self.assertEqual(result['status'],'matched')
                self.send(self.token,calldata('setRestriction(address,uint256)',['address','uint256'],[account,0]))
        self.guard()

    def test_proxy_admin_and_beacon_changes_and_dependency_owner_change_are_denied(self):
        for signature,arguments in (('changeAdmin(address,address)',[self.token,self.other]),
                                   ('setBeacon(address,address)',[self.token,self.changed]),
                                   ('setOwner(address)',[self.other])):
            with self.subTest(signature=signature):
                snapshot=self.rpc('evm_snapshot',[])
                try:
                    types=['address']*len(arguments)
                    self.send(self.admin,calldata(signature,types,arguments))
                    self.denied_transfer('deposit_token_changed')
                finally:self.assertTrue(self.rpc('evm_revert',[snapshot]))
        self.guard()


if __name__ == '__main__':
    unittest.main()
