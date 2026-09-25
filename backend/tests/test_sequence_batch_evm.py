"""A sequence's creation as one batch (EIP-5792) through the actual official V4 contracts.

The owner is delegated (EIP-7702) to Simple7702Account's real runtime code, as
read on Robinhood Chain (app/tests/support/eip7702-delegates.code.json), and the
test wallet executes the batch as such an account does: one transaction from
the owner to itself calling executeBatch. The app's sequence client prepares,
simulates (eth_simulateV1), offers and reads back the batch: the root NFT's
approval and the paused creation. docs/plans/2026-09-25-eip5792-batches-design.md
is the design.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from eth_hash.auto import keccak
import test_execution_v4_receipts_evm as evm
from evm_harness import calldata

ROOT = Path(__file__).resolve().parents[2]
SIMPLE = '0xe6cae83bde06e4c305530e199d7217f42808555b'


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1', 'requires isolated local Anvil')
class SequenceBatchEvmTests(unittest.TestCase):
    HARDFORK = 'prague'
    setUpClass = classmethod(evm.ExecutionV4ReceiptEvmTests.setUpClass.__func__)
    stop = classmethod(evm.ExecutionV4ReceiptEvmTests.stop.__func__)
    send, deploy, call = evm.ExecutionV4ReceiptEvmTests.send, evm.ExecutionV4ReceiptEvmTests.deploy, evm.ExecutionV4ReceiptEvmTests.call
    setup_vault, swaps = evm.ExecutionV4ReceiptEvmTests.setup_vault, evm.ExecutionV4ReceiptEvmTests.swaps
    plan, execute = evm.ExecutionV4ReceiptEvmTests.plan, evm.ExecutionV4ReceiptEvmTests.execute
    observe = evm.ExecutionV4ReceiptEvmTests.observe

    def test_the_approval_and_the_creation_in_one_transaction(self):
        code = json.loads((ROOT/'app/tests/support/eip7702-delegates.code.json').read_text())['code'][SIMPLE]
        with tempfile.TemporaryDirectory(prefix='domino-sequence-batch-') as directory:
            out = Path(directory)
            subprocess.run(['node', str(ROOT/'app/node_modules/typescript/bin/tsc'), str(ROOT/'app/src/finance/sequence.ts'),
                '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--strict', '--skipLibCheck',
                '--outDir', str(out), '--rootDir', str(ROOT/'app/src/finance')], check=True, capture_output=True, text=True)
            (out/'package.json').write_text('{"type":"module"}')
            (out/'node_modules').symlink_to(ROOT/'app/node_modules', target_is_directory=True)
            for native in (False, True):
                with self.subTest(native=native):
                    self.setup_vault(native=native)
                    # The root leaves the first sequence, so the owner may create a fresh one for it.
                    self.send(self.positions, calldata('unsubscribe(uint256)', ['uint256'], [self.token]))
                    # From here the owner's account runs Simple7702Account: the code where it is deployed, and the designator.
                    self.rpc.request('anvil_setCode', [SIMPLE, code])
                    self.rpc.request('anvil_setCode', [self.owner, '0xef0100' + SIMPLE[2:]])
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
                        serviceFeeBps=200, dominoServiceFeeBps=400, expiresAt=now+3600, codeHashes=hashes)
                    fixture = dict(url=self.rpc.url, owner=self.owner, now=now, native=native, root=str(self.token),
                        release=dict(contractVersion='1.0.0-rc.1', chainId=4663, available=True, deployment=deployment))
                    run = subprocess.run(['node', str(ROOT/'app/tests/sequence-batch.evm.mjs')], input=json.dumps(fixture),
                        text=True, capture_output=True, timeout=120, env={**os.environ, 'DOMINO_SEQUENCE_SDK_MODULE': str(out/'sequence.js')})
                    self.assertEqual(run.returncode, 0, run.stdout+run.stderr)
                    report = json.loads(run.stdout)
                    self.assertTrue(report['passed'])
                    self.assertGreaterEqual(report['checks'], 45)
                    print(f'Sequence batch: {report["checks"]} checks, native={native}, batches={report["batches"]}', flush=True)
                    # The new sequence is registered for the root, and the root stays in the owner's wallet, approved to it.
                    self.assertEqual(self.call(self.positions, 'ownerOf(uint256)', ['address'], ['uint256'], [self.token])[0], self.owner)
                    self.assertEqual(self.call(self.positions, 'getApproved(uint256)', ['address'], ['uint256'], [self.token])[0], report['vault'])
                    # Back to a plain owner for the next variant, which the harness sets up as it always does.
                    self.rpc.request('anvil_setCode', [self.owner, '0x'])
