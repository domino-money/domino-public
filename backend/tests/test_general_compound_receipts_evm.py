"""Actual canonical Anvil receipts through pinned v4 and V3 factory contracts.

Run after the contract build with DOMINO_TEST_EVM=1. Only exact-transfer tokens,
fixture funding, and the local chain's finalized tag are synthetic. No deployed
token/provider admission, live execution, full L2 cost or income coverage follows.
DOMINO_COMPOUND_EVM_ROOT may select a separate local checkout's built artifacts.
"""
import copy
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
import execution_models as m
import general_compound_receipts as g

ROOT = Path(__file__).resolve().parents[2]
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
class CompoundReceiptEvmTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.artifact_root = Path(os.environ.get('DOMINO_COMPOUND_EVM_ROOT', ROOT)).resolve()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        cls.rpc = LocalRpc(f'http://127.0.0.1:{port}')
        cls.process = subprocess.Popen([str(cls.artifact_root/'node_modules/.bin/anvil'),
            '--host', '127.0.0.1', '--port', str(port), '--chain-id', '4663',
            '--hardfork', 'cancun', '--silent'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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

    @classmethod
    def stop(cls):
        cls.process.terminate()
        cls.process.wait(timeout=10)

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

    def setup_vault(self, *, native=False):
        self.manager = self.deploy('PoolManager.sol', 'PoolManager', ['address'], [self.owner])
        self.positions = self.deploy('PositionManager.sol', 'PositionManager',
            ['address', 'address', 'uint256', 'address', 'address'],
            [self.manager, '0x'+'11'*20, 100000, '0x'+'22'*20, '0x'+'33'*20])
        self.state = self.deploy('StateView.sol', 'StateView', ['address'], [self.manager])
        controller = self.deploy('OfficialV4Fixture.sol', 'OfficialV4Controller',
            ['address', 'address'], [self.manager, self.positions])
        self.trader = self.deploy('OfficialV4Fixture.sol', 'OfficialV4SwapDriver', ['address'], [self.manager])
        tokens = [self.deploy('OfficialV4Fixture.sol', 'OfficialFixtureToken') for _ in range(2)]
        currencies = [m.ZERO, tokens[0]] if native else sorted(tokens)
        self.key = (*currencies, 3000, 60, m.ZERO)
        for currency in currencies:
            for target in (controller, self.trader):
                if currency == m.ZERO:
                    self.send(target, value=10**20)
                else:
                    self.send(currency, calldata('mint(address,uint256)', ['address', 'uint256'], [target, 10**20]))
        self.send(self.manager, calldata('initialize('+KEY_TYPE+',uint160)', [KEY_TYPE, 'uint160'], [self.key, 2**96]))
        self.send(controller, calldata('seed('+KEY_TYPE+',uint128)', [KEY_TYPE, 'uint128'], [self.key, 10**18]))
        self.send(controller, calldata('refundSetup()'))
        self.token = self.call(controller, 'tokenId()', ['uint256'])[0]
        factory = self.deploy('DominoVaultFactory.sol', 'DominoVaultFactory', ['address']*4,
            [self.manager, self.positions, self.state, self.recipient])
        self.vault = self.call(factory, 'predictVault(address,uint256)', ['address'],
            ['address', 'uint256'], [self.owner, 0])[0]
        self.send(self.positions, calldata('approve(address,uint256)', ['address', 'uint256'], [self.vault, self.token]))
        pool = m.PoolKey(currency0=currencies[0], currency1=currencies[1], fee_pips=3000, tick_spacing=60, hooks=m.ZERO)
        params = (self.token, bytes.fromhex(pool.pool_id()[2:]), *currencies, m.ZERO, True,
                  (200, 500, 1000, 1, 4, 1, False), (1, 5000, 100, 100, 10**12, 120, 3600))
        self.send(factory, calldata('createVault('+INIT_TYPE+',uint256)', [INIT_TYPE, 'uint256'], [params, 0]))
        implementation = self.call(self.vault, 'implementation()', ['address'])[0]
        helper = self.call(self.vault, 'readHelper()', ['address'])[0]
        engine = self.call(self.vault, 'compoundEngine()', ['address'])[0]
        sequence_id = self.call(factory, 'sequenceIdFor(address,uint256)', ['bytes32'],
            ['address', 'uint256'], [self.owner, 0])[0]
        seq = m.SequenceIdentity(chainId=4663, owner=self.owner, sequenceId='0x'+sequence_id.hex(),
            vault=self.vault, factory=factory, implementation=implementation, implementationVersion='3',
            poolManager=self.manager, positionManager=self.positions, poolKey=pool, poolId=pool.pool_id(),
            baseCurrency=currencies[0], quoteCurrency=currencies[1], serviceFeeRecipient=self.recipient)
        pins = tuple(g.RuntimePin(address=a, codeHash='0x'+keccak(bytes.fromhex(
            self.rpc.request('eth_getCode', [a, 'latest'])[2:])).hex())
            for a in (self.vault, factory, implementation, self.manager, self.positions, self.state, helper, engine))
        self.admission = g.CompoundAdmission(sequence=seq, stateView=self.state, readHelper=helper,
            compoundEngine=engine, runtimePins=pins)

    def swaps(self):
        for direction in (True, False):
            self.send(self.trader, calldata('swap('+KEY_TYPE+',bool,uint256)',
                [KEY_TYPE, 'bool', 'uint256'], [self.key, direction, 10**15]))

    def compound(self, increase):
        # Include the observed block strictly before the compound transaction.
        self.rpc.request('evm_increaseTime', [2])
        self.rpc.request('evm_mine', [])
        source = self.rpc.request('eth_getBlockByNumber', ['latest', False])
        member = self.call(self.vault, 'position(uint256)', [g.POSITION_TYPE], ['uint256'], [self.token])[0]
        checkpoint = self.call(self.vault, 'checkpoint(uint256)', [g.CHECKPOINT_TYPE], ['uint256'], [self.token])[0]
        timestamp = int(source['timestamp'], 16)
        plan = g.CompoundPlan(intentId='0x'+keccak(encode(['address','uint256'],
            [self.vault, int(source['number'], 16)])).hex(), tokenId=str(self.token), positionIdentity='0x'+member[8].hex(),
            checkpointId='0x'+checkpoint[6].hex(), policyVersion='1', limitsVersion='1',
            stateNonce=str(self.call(self.vault, 'stateNonce()', ['uint64'])[0]),
            authorityGeneration=str(self.call(self.vault, 'authorityGeneration()', ['uint64'])[0]),
            observedAtBlock=str(int(source['number'], 16)), observedBlockHash=source['hash'],
            observedAtTimestamp=str(timestamp), deadline=str(timestamp+60), liquidityIncrease=str(increase),
            maxOriginal0=str(2**128-1), maxOriginal1=str(2**128-1),
            maxCharged0=str(2**128-1), maxCharged1=str(2**128-1),
            minAdded0='1', minAdded1='1', minSqrtPriceX96=str(2**95), maxSqrtPriceX96=str(2**97))
        receipt = self.send(self.vault, plan.calldata())
        # Advance Anvil's local finalized tag; this is not upstream finality evidence.
        self.rpc.request('anvil_mine', ['0x40'])
        result = g.CompoundReceiptReconciler(self.rpc).reconcile(plan, self.admission, receipt['transactionHash'])
        realized = next(i for i, log in enumerate(receipt['logs']) if log['topics'][0] == g.REALIZED)
        self.assertGreater(realized, 0)  # Real core/token events precede financial events.
        self.assertEqual({c.eventIndex for c in result['collections']}, {realized} if result['collections'] else set())
        self.assertEqual(result['planHash'], plan.contract_plan_hash(self.admission.sequence))
        self.assertEqual(int(result['gas']['receiptGasProductWei']),
            int(receipt['gasUsed'], 16)*int(receipt['effectiveGasPrice'], 16))
        self.assertIsNone(result['gas']['fullL2CostWei'])
        self.assertIsNone(result['usdValuation'])
        self.assertFalse(result['complete24h'])
        return plan, receipt, result

    def test_actual_erc20_receipts_new_fees_then_waiting_reserve(self):
        self.setup_vault()
        self.swaps()
        _, _, first = self.compound(5*10**13)
        self.assertEqual(len(first['collections']), 2)
        self.swaps()
        _, _, second = self.compound(10**14+40)
        self.assertEqual(len(second['collections']), 2)
        for prior, row in zip(first['sources'], second['sources']):
            self.assertEqual(row['originalBeforeRaw'], prior['originalAfterRaw'])
            self.assertGreater(int(row['grossOriginalConsumedRaw']), int(row['originalBeforeRaw']))
        plan, receipt, third = self.compound(10**12)
        self.assertEqual(third['collections'], ())
        self.assertTrue(all(row['realizedRaw'] == '0' for row in third['sources']))
        self.assertTrue(any(int(row['serviceFeeRaw']) > 0 for row in third['sources']))
        # Corrupt one acquisition of a real successful receipt; no synthetic replacement state.
        original = self.rpc
        class AlteredReceipt:
            def request(self, method, params):
                value = original.request(method, params)
                if method == 'eth_getTransactionReceipt':
                    value = copy.deepcopy(value)
                    log = next(log for log in value['logs'] if log['topics'][0] == g.APPLIED)
                    log['topics'][1] = '0x' + '00'*12 + original.request('eth_accounts', [])[2][2:]
                return value
        with self.assertRaisesRegex(ValueError, 'compound_log_query_mismatch'):
            g.CompoundReceiptReconciler(AlteredReceipt()).reconcile(plan, self.admission, receipt['transactionHash'])

    def test_actual_native_receipt_and_original_residual(self):
        self.setup_vault(native=True)
        self.swaps()
        _, _, result = self.compound(5*10**13)
        self.assertEqual(result['sources'][0]['currency'], m.ZERO)
        self.assertEqual(len(result['collections']), 2)
        self.assertGreater(int(result['sources'][0]['originalAfterRaw']), 0)
