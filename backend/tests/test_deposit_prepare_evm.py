"""Local EVM checks of the emitted approval/mint sequence against synthetic code.

These contracts exercise ABI, allowance, expiration, simulation and nonce wiring;
they are NOT evidence qualifying a real token or a production v4 deployment.
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

from eth_abi import decode
from eth_hash.auto import keccak

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deposit_prepare import DirectDepositPreparer, DEPLOYMENTS, PERMIT2, calldata
from deposit_rpc import DepositRpc
from discovery import POSITION_MANAGER, POOL_MANAGER, STATE_VIEW
import local_anvil
from uniswap_position import UniswapPosition
from test_deposit_prepare import signed_manifest, selection, Provider, OWNER, TOKEN0, TOKEN1, KEY

ROOT = Path(__file__).resolve().parents[2]
SOURCE = '''// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
interface Token {
 function allowance(address,address) external view returns(uint256);
 function transferFrom(address,address,uint256) external returns(bool);
}
contract SyntheticToken {
 mapping(address=>uint256) public balanceOf;
 mapping(address=>mapping(address=>uint256)) public allowance;
 function mint(address owner,uint256 amount) external { balanceOf[owner] += amount; }
 function approve(address spender,uint256 amount) external returns(bool) {
   require(amount==0 || allowance[msg.sender][spender]==0,"reset required");
   allowance[msg.sender][spender]=amount; return true;
 }
 function transferFrom(address owner,address recipient,uint256 amount) external returns(bool) {
   require(allowance[owner][msg.sender]>=amount && balanceOf[owner]>=amount,"funding");
   allowance[owner][msg.sender]-=amount; balanceOf[owner]-=amount; balanceOf[recipient]+=amount; return true;
 }
}
contract SyntheticPermit2 {
 struct Packed { uint160 amount; uint48 expiration; uint48 nonce; }
 mapping(address=>mapping(address=>mapping(address=>Packed))) public allowance;
 function approve(address token,address spender,uint160 amount,uint48 expiration) external {
   allowance[msg.sender][token][spender]=Packed(amount,expiration,0);
 }
 function transferFrom(address owner,address recipient,uint160 amount,address token) external {
   Packed storage p=allowance[owner][token][msg.sender];
   require(p.expiration>=block.timestamp && p.amount>=amount,"permit funding");
   p.amount-=amount; require(Token(token).transferFrom(owner,recipient,amount));
 }
}
contract SyntheticManager {
 address public constant poolManager=address(0x8366a39CC670B4001A1121B8F6A443A643e40951);
 SyntheticPermit2 public constant permit2=SyntheticPermit2(0x000000000022D473030F116dDEE9F6B43aC78BA3);
 struct Key { address currency0; address currency1; uint24 fee; int24 spacing; address hooks; }
 function poolKeys(bytes25) external pure returns(address,address,uint24,int24,address) {
   return(address(0x1111111111111111111111111111111111111111),address(0x2222222222222222222222222222222222222222),3000,60,address(0));
 }
 function modifyLiquidities(bytes calldata data,uint256 deadline) external payable {
   require(block.timestamp<=deadline && msg.value==0,"deadline/value");
   (bytes memory actions,bytes[] memory params)=abi.decode(data,(bytes,bytes[]));
   require(keccak256(actions)==keccak256(hex"020d") && params.length==2,"plan");
   (Key memory key,int24 lo,int24 hi,uint256 liq,uint128 a,uint128 b,address recipient,bytes memory hook)=
     abi.decode(params[0],(Key,int24,int24,uint256,uint128,uint128,address,bytes));
   require(recipient==msg.sender && lo==-120 && hi==180 && liq==12345 && hook.length==0,"mint");
   require(a>=100 && b>=200,"caps");
   permit2.transferFrom(msg.sender,poolManager,100,key.currency0);
   permit2.transferFrom(msg.sender,poolManager,200,key.currency1);
 }
}
contract SyntheticStateView {
 address public constant poolManager=address(0x8366a39CC670B4001A1121B8F6A443A643e40951);
 function getSlot0(bytes32) external pure returns(uint160,int24,uint24,uint24) { return(uint160(1<<96),0,0,3000); }
}
contract SyntheticPoolManager { }
'''


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1', 'requires isolated local Anvil')
class DepositEvmTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        payload = {'language': 'Solidity', 'sources': {'Deposit.sol': {'content': SOURCE}},
            'settings': {'viaIR': True, 'optimizer': {'enabled': True, 'runs': 200}, 'evmVersion': 'cancun',
                'outputSelection': {'*': {'*': ['evm.deployedBytecode.object']}}}}
        result = subprocess.run(['node', str(ROOT/'scripts/solc-compile.cjs')], input=json.dumps(payload),
            text=True, capture_output=True, timeout=60, check=True)
        compiled = json.loads(result.stdout)
        errors = [row['formattedMessage'] for row in compiled.get('errors', []) if row['severity'] == 'error']
        if errors:
            raise AssertionError('\n'.join(errors))
        cls.contracts = compiled['contracts']['Deposit.sol']
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        cls.url = f'http://127.0.0.1:{port}'
        cls.process = local_anvil.start(['--host', '127.0.0.1',
            '--port', str(port), '--chain-id', '4663', '--silent'])
        cls.addClassCleanup(cls.stop)
        for _ in range(100):
            try:
                if cls.rpc('eth_chainId', []) != hex(4663):
                    raise AssertionError('isolated chain required')
                cls.account = cls.rpc('eth_accounts', [])[0]
                break
            except OSError:
                time.sleep(.05)
        else:
            raise AssertionError('local EVM failed to start')

    @classmethod
    def stop(cls):
        local_anvil.stop(cls.process)

    @classmethod
    def rpc(cls, method, params):
        request = urllib.request.Request(cls.url, json.dumps({'jsonrpc': '2.0', 'id': 1,
            'method': method, 'params': params}).encode(), {'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=10) as response:
            result = json.load(response)
        if 'error' in result:
            raise AssertionError(result['error'])
        return result['result']

    @classmethod
    def transport(cls, url, body, **options):
        if url != 'https://rpc.mainnet.chain.robinhood.com':
            raise AssertionError('synthetic transport identity')
        return {'jsonrpc': '2.0', 'id': body['id'], 'result': cls.rpc(body['method'], body['params'])}

    def setUp(self):
        # One chain per class: every test starts from the same state.
        self.addCleanup(self.rpc, 'evm_revert', [self.rpc('evm_snapshot', [])])

    def send(self, to, data, sender=None, **fields):
        digest = self.rpc('eth_sendTransaction', [{'from': sender or self.account, 'to': to,
            'data': data, 'gas': hex(1_000_000), **fields}])
        for _ in range(100):
            receipt = self.rpc('eth_getTransactionReceipt', [digest])
            if receipt is not None:
                break
            time.sleep(.01)
        self.assertIsNotNone(receipt)
        self.assertEqual(receipt['status'], '0x1')
        return receipt

    def deposit_sequence(self, owner_code):
        hashes = {}
        for target, name in ((TOKEN0, 'SyntheticToken'), (TOKEN1, 'SyntheticToken'),
                (PERMIT2, 'SyntheticPermit2'), (POSITION_MANAGER, 'SyntheticManager'),
                (STATE_VIEW, 'SyntheticStateView'), (POOL_MANAGER, 'SyntheticPoolManager')):
            code = self.contracts[name]['evm']['deployedBytecode']['object']
            self.rpc('anvil_setCode', [target, '0x' + code])
            hashes[target] = '0x' + keccak(bytes.fromhex(code)).hex()
        self.rpc('anvil_setBalance', [OWNER, hex(10**21)])
        self.rpc('anvil_impersonateAccount', [OWNER])
        self.rpc('anvil_setCode', [OWNER, owner_code])
        for token in (TOKEN0, TOKEN1):
            self.send(token, calldata('mint(address,uint256)', ['address', 'uint256'], [OWNER, 10000]))
        self.send(TOKEN0, calldata('approve(address,uint256)', ['address', 'uint256'], [PERMIT2, 1]), OWNER)
        now = int(time.time())
        m = signed_manifest(reviewedAt=now-30, expiresAt=now+300,
            deployments={key: hashes[value] for key, value in DEPLOYMENTS.items()})
        for token in m['tokens']:
            token['codeHash'] = hashes[token['address']]
        m = signed_manifest(**m)
        selected = selection()
        selected.update(maxFeePerGasRaw=str(10**11), maxPriorityFeePerGasRaw=str(10**9))
        provider = Provider()
        prepare = DirectDepositPreparer(UniswapPosition(KEY, transport=provider),
            lambda: DepositRpc('https://rpc.mainnet.chain.robinhood.com', transport=self.transport), admission=m)
        kinds, nonces = [], []
        for _ in range(6):
            artifact = prepare.prepare(OWNER, selected)
            tx = artifact['transaction']
            kinds.append(artifact['kind'])
            nonces.append(int(tx['nonceRaw']))
            self.send(tx['to'], tx['data'], tx['from'], value=hex(int(tx['valueRaw'])),
                nonce=hex(int(tx['nonceRaw'])), gas=hex(int(tx['gasLimitRaw'])),
                maxFeePerGas=hex(int(tx['maxFeePerGasRaw'])),
                maxPriorityFeePerGas=hex(int(tx['maxPriorityFeePerGasRaw'])))
        return kinds, nonces

    def test_reset_erc20_permit2_mint_sequence_simulates_and_executes_with_bound_nonces(self):
        self.assert_sequence(*self.deposit_sequence('0x'))

    def test_an_eip7702_owner_signs_the_same_steps_and_nonces(self):
        # The owner's own key signs each step; its designator names code that
        # nothing in this sequence calls (an empty synthetic contract).
        self.assert_sequence(*self.deposit_sequence('0xef0100' + POOL_MANAGER[2:]))
        self.assertEqual(self.rpc('eth_getCode', [OWNER, 'latest']), '0xef0100' + POOL_MANAGER[2:].lower())

    def assert_sequence(self, kinds, nonces):
        self.assertEqual(kinds, ['erc20_reset', 'erc20_approval', 'permit2_approval',
                                'erc20_approval', 'permit2_approval', 'mint'])
        self.assertEqual(nonces, [1, 2, 3, 4, 5, 6])
        for token, consumed in ((TOKEN0, 100), (TOKEN1, 200)):
            raw = self.rpc('eth_call', [{'to': token, 'data': calldata('balanceOf(address)',
                ['address'], [POOL_MANAGER])}, 'latest'])
            self.assertEqual(decode(['uint256'], bytes.fromhex(raw[2:]))[0], consumed)
