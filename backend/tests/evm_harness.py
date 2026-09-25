"""The isolated Anvil harness the EVM tests share.

Boots one local chain per test class, deploys built artifacts and sends
transactions from the first funded account. Run after the contract build with
DOMINO_TEST_EVM=1. Exact-transfer tokens, fixture funding, the local chain's
finalized tag and an explicitly installed ArbSys emulator are synthetic.
DOMINO_COMPOUND_EVM_ROOT may select a
separate local checkout's built artifacts.

This used to be the V3 compound receipt test module; the harness stayed when
V3 was retired, because every other EVM test subclasses it.
"""
import json
import os
from pathlib import Path
import socket
import sys
import time
import unittest
import urllib.request

from eth_abi import decode, encode
from eth_hash.auto import keccak

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'backend'))
import local_anvil

KEY_TYPE = '(address,address,uint24,int24,address)'
POLICY_TYPE = '(uint16,uint16,uint16,uint32,uint8,uint64,bool)'
LIMITS_TYPE = '(uint64,uint32,uint16,uint16,uint128,uint32,uint32)'
INIT_TYPE = '(uint256,bytes32,address,address,address,bool,' + POLICY_TYPE + ',' + LIMITS_TYPE + ')'


def calldata(signature, types=(), values=()):
    return '0x' + (keccak(signature.encode())[:4] + encode(types, values)).hex()


class LocalRpc:
    def __init__(self, url):
        self.url = url

    def request(self, method, params):
        request = urllib.request.Request(self.url, json.dumps({'jsonrpc': '2.0', 'id': 1,
            'method': method, 'params': params}).encode(), {'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=10) as response:
            result = json.load(response)
        if 'error' in result:
            raise AssertionError(result['error'])
        return result['result']


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1', 'requires isolated local Anvil')
class EvmHarness(unittest.TestCase):
    # A class that needs EIP-7702 designators to execute (a delegated owner) asks for prague. Classes that borrow
    # setUpClass without subclassing keep cancun.
    HARDFORK = 'cancun'

    @classmethod
    def setUpClass(cls):
        cls.artifact_root = Path(os.environ.get('DOMINO_COMPOUND_EVM_ROOT', ROOT)).resolve()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        cls.rpc = LocalRpc(f'http://127.0.0.1:{port}')
        cls.process = local_anvil.start(['--host', '127.0.0.1', '--port', str(port), '--chain-id', '4663',
            '--hardfork', getattr(cls, 'HARDFORK', 'cancun'), '--silent'], root=cls.artifact_root)
        cls.addClassCleanup(cls.stop)
        for _ in range(100):
            try:
                if cls.rpc.request('eth_chainId', []) != hex(4663):
                    raise AssertionError('isolated chain required')
                cls.owner, cls.recipient = cls.rpc.request('eth_accounts', [])[:2]
                break
            except OSError:
                time.sleep(.05)
        else:
            raise AssertionError('local EVM failed to start')
        # Anvil does not implement Nitro's ArbSys. This explicit local fixture
        # preserves child-chain observation semantics; it is not Nitro proof.
        artifact = json.loads((cls.artifact_root/'contracts/out/NitroTestSetup.sol/MockNitroArbSys.json').read_text())
        cls.rpc.request('anvil_setCode', ['0x' + '00'*19 + '64', artifact['deployedBytecode']['object']])

    @classmethod
    def stop(cls):
        local_anvil.stop(cls.process)

    def send(self, target, data='0x', value=0):
        tx = {'from': self.owner, 'data': data, 'gas': hex(30_000_000), 'value': hex(value)}
        if target is not None:
            tx['to'] = target
        digest = self.rpc.request('eth_sendTransaction', [tx])
        for _ in range(100):
            receipt = self.rpc.request('eth_getTransactionReceipt', [digest])
            if receipt is not None:
                break
            time.sleep(.01)
        self.assertIsNotNone(receipt)
        self.assertEqual(receipt['status'], '0x1', f'local transaction reverted: {digest}')
        return receipt

    def deploy(self, source, name, types=(), values=()):
        path = self.artifact_root/'contracts/out'/source/(name+'.json')
        artifact = json.loads(path.read_text())
        initcode = artifact['bytecode']['object'] + encode(types, values).hex()
        self.assertLessEqual(len(bytes.fromhex(initcode[2:])), 49152)
        receipt = self.send(None, initcode)
        address = receipt['contractAddress'].lower()
        self.assertLessEqual(len(bytes.fromhex(self.rpc.request('eth_getCode', [address, 'latest'])[2:])), 24576)
        return address

    def call(self, target, signature, outputs, types=(), values=()):
        raw = self.rpc.request('eth_call', [{'to': target, 'data': calldata(signature, types, values)}, 'latest'])
        return decode(outputs, bytes.fromhex(raw[2:]))

    def swaps(self):
        for direction in (True, False):
            self.send(self.trader, calldata('swap('+KEY_TYPE+',bool,uint256)',
                [KEY_TYPE, 'bool', 'uint256'], [self.key, direction, 10**15]))
