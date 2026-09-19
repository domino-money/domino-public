"""Actual owner wallet sequence SDK against disposable official V4 contracts."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from eth_hash.auto import keccak
import test_execution_v4_receipts_evm as evm
from test_general_compound_receipts_evm import calldata

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1', 'requires isolated local Anvil')
class SequenceSdkEvmTests(unittest.TestCase):
    setUpClass = classmethod(evm.ExecutionV4ReceiptEvmTests.setUpClass.__func__)
    stop = classmethod(evm.ExecutionV4ReceiptEvmTests.stop.__func__)
    send, deploy, call = evm.ExecutionV4ReceiptEvmTests.send, evm.ExecutionV4ReceiptEvmTests.deploy, evm.ExecutionV4ReceiptEvmTests.call
    setup_vault, swaps = evm.ExecutionV4ReceiptEvmTests.setup_vault, evm.ExecutionV4ReceiptEvmTests.swaps
    # plan() publishes an observation for every action, so observe() comes with it.
    plan, execute = evm.ExecutionV4ReceiptEvmTests.plan, evm.ExecutionV4ReceiptEvmTests.execute
    observe = evm.ExecutionV4ReceiptEvmTests.observe

    def test_owner_creation_recovery_identity_nonce_and_canonical_receipts(self):
        with tempfile.TemporaryDirectory(prefix='domino-sequence-sdk-') as directory:
            out = Path(directory)
            subprocess.run(['node', str(ROOT/'app/node_modules/typescript/bin/tsc'), str(ROOT/'app/src/finance/sequence.ts'),
                '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--strict', '--skipLibCheck',
                '--outDir', str(out), '--rootDir', str(ROOT/'app/src/finance')], check=True, capture_output=True, text=True)
            (out/'package.json').write_text('{"type":"module"}')
            (out/'node_modules').symlink_to(ROOT/'app/node_modules', target_is_directory=True)
            for native in (False, True):
                with self.subTest(native=native):
                    self.setup_vault(native=native)
                    self.swaps()
                    _, result = self.execute(self.plan(3, 10**10))
                    child = result['destinationTokenId']
                    # Existing assets survive loss of the root subscription. The
                    # owner may create a fresh paused sequence for this root.
                    self.send(self.positions, calldata('unsubscribe(uint256)', ['uint256'], [self.token]))
                    operator = self.rpc.request('eth_accounts', [])[3]
                    self.send(self.vault, calldata('setOperator(address)', ['address'], [operator]))
                    a = self.admission
                    deployment = dict(factory=a.sequence.factory, implementation=a.sequence.implementation,
                        poolManager=self.manager, positionManager=self.positions, stateView=self.state,
                        readHelper=a.readHelper, engine=a.executionEngine, routing=a.routingHelper, priceGuard=a.priceGuard)
                    hashes = {name: '0x'+keccak(bytes.fromhex(self.rpc.request('eth_getCode', [address, 'latest'])[2:])).hex()
                        for name, address in deployment.items()}
                    hashes['vault'] = '0x'+keccak(bytes.fromhex(self.rpc.request('eth_getCode', [self.vault, 'latest'])[2:])).hex()
                    now = int(self.rpc.request('eth_getBlockByNumber', ['latest', False])['timestamp'], 16)
                    deployment.update(serviceFeeRecipient=self.recipient, operator=operator, pricePublisher=a.pricePublisher,
                        serviceFeeBps=200, expiresAt=now+3600, codeHashes=hashes)
                    fixture = dict(url=self.rpc.url, owner=self.owner, now=now, native=native, root=str(self.token),
                        oldVault=self.vault, child=child,
                        release=dict(contractVersion='1.0.0-rc.1', chainId=4663, available=True, deployment=deployment))
                    run = subprocess.run(['node', str(ROOT/'app/tests/sequence.evm.mjs')], input=json.dumps(fixture),
                        text=True, capture_output=True, timeout=90, env={**os.environ, 'DOMINO_SEQUENCE_SDK_MODULE': str(out/'sequence.js')})
                    self.assertEqual(run.returncode, 0, run.stdout+run.stderr)
                    report = json.loads(run.stdout)
                    self.assertTrue(report['passed'])
                    self.assertGreaterEqual(report['checks'], 20)
                    print(f'Sequence SDK: {report["checks"]} checks, native={native}, actual RPC calls={report["calls"]}', flush=True)
                    self.assertEqual(self.call(self.positions, 'ownerOf(uint256)', ['address'], ['uint256'], [self.token])[0], self.owner)
                    self.assertEqual(self.call(self.positions, 'ownerOf(uint256)', ['address'], ['uint256'], [int(child)])[0], self.owner)
