"""Create position's batch (EIP-5792) through actual contracts: one transaction per batch.

The owner is delegated (EIP-7702) to Simple7702Account's real runtime code, as
read on Robinhood Chain (app/tests/support/eip7702-delegates.code.json), and the
test wallet executes each batch the way such an account does: one transaction
from the owner to itself calling executeBatch. The app's setup client prepares,
simulates (eth_simulateV1), offers and reads back every batch.
docs/plans/2026-09-25-eip5792-batches-design.md is the design.
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from eth_hash.auto import keccak
from evm_harness import EvmHarness as Harness, calldata
ROOT = Path(__file__).resolve().parents[2]
SIMPLE = '0xe6cae83bde06e4c305530e199d7217f42808555b'


@unittest.skipUnless(os.environ.get('DOMINO_TEST_EVM') == '1', 'requires isolated local Anvil')
class SetupBatchEvmTests(unittest.TestCase):
    HARDFORK = 'prague'
    setUpClass = classmethod(Harness.setUpClass.__func__)
    stop = classmethod(Harness.stop.__func__)
    send = Harness.send
    deploy = Harness.deploy
    call = Harness.call

    def test_one_transaction_creates_the_position_and_a_stale_batch_reverts_whole(self):
        code = json.loads((ROOT/'app/tests/support/eip7702-delegates.code.json').read_text())['code'][SIMPLE]
        with tempfile.TemporaryDirectory(prefix='domino-setup-batch-') as directory:
            out = Path(directory)
            subprocess.run(['node', str(ROOT/'app/node_modules/typescript/bin/tsc'), str(ROOT/'app/src/finance/setup.ts'),
                '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--strict', '--skipLibCheck',
                '--outDir', str(out), '--rootDir', str(ROOT/'app/src/finance')], check=True, capture_output=True, text=True)
            (out/'package.json').write_text('{"type":"module"}')
            (out/'node_modules').symlink_to(ROOT/'app/node_modules', target_is_directory=True)
            # The owner's account runs Simple7702Account: the code where it is deployed, and the owner's designator.
            self.rpc.request('anvil_setCode', [SIMPLE, code])
            self.rpc.request('anvil_setCode', [self.owner, '0xef0100' + SIMPLE[2:]])
            for native in (False, True):
                with self.subTest(native=native):
                    manager = self.deploy('PoolManager.sol', 'PoolManager', ['address'], [self.owner])
                    positions = self.deploy('PositionManager.sol', 'PositionManager', ['address', 'address', 'uint256', 'address', 'address'],
                        [manager, '0x'+'11'*20, 100000, '0x'+'22'*20, '0x'+'33'*20])
                    state = self.deploy('StateView.sol', 'StateView', ['address'], [manager])
                    setup = self.deploy('DominoSetup.sol', 'DominoSetup', ['address']*4+['uint16', 'uint64'], [manager, positions, state, self.recipient, 65, 1])
                    tokens = sorted(self.deploy('DominoSetup.t.sol', 'SetupToken') for _ in range(2))
                    pair = ['0x'+'00'*20, tokens[0]] if native else tokens
                    for token in pair:
                        if int(token, 16):
                            self.send(token, calldata('mint(address,uint256)', ['address', 'uint256'], [self.owner, 10**22]))
                    codehash = lambda address: '0x'+keccak(bytes.fromhex(self.rpc.request('eth_getCode', [address, 'latest'])[2:])).hex()
                    now = int(self.rpc.request('eth_getBlockByNumber', ['latest', False])['timestamp'], 16)
                    deployment = {'setup': setup, 'setupCodeHash': codehash(setup), 'poolManager': manager, 'poolManagerCodeHash': codehash(manager),
                        'positionManager': positions, 'positionManagerCodeHash': codehash(positions), 'stateView': state, 'stateViewCodeHash': codehash(state),
                        'feeRecipient': self.recipient, 'feeBps': 65, 'tariffVersion': '1', 'expiresAt': now+3600}
                    fixture = {'url': self.rpc.url, 'owner': self.owner, 'now': now,
                        'release': {'available': True, 'chainId': 4663, 'contractVersion': '1.0.0-rc.1', 'deployment': deployment},
                        'key': {'currency0': pair[0], 'currency1': pair[1], 'fee': 3000, 'tickSpacing': 60, 'hooks': '0x'+'00'*20}}
                    result = subprocess.run(['node', str(ROOT/'app/scripts/test-setup-batch.evm.mjs')], input=json.dumps(fixture),
                        capture_output=True, text=True, timeout=120, env={**os.environ, 'DOMINO_SETUP_SDK_MODULE': str(out/'setup.js')})
                    self.assertEqual(result.returncode, 0, result.stdout+result.stderr)
                    report = json.loads(result.stdout)
                    self.assertTrue(report['passed'])
                    self.assertGreaterEqual(report['checks'], 12)
                    print(f'Setup batch: {report["checks"]} checks, native={native}, batches={report["batches"]}', flush=True)
                    # Both positions are the owner's, and the setup contract keeps nothing: every leftover came back.
                    for token_id in report['tokens']:
                        self.assertEqual(self.call(positions, 'ownerOf(uint256)', ['address'], ['uint256'], [int(token_id)])[0], self.owner)
                    for token in pair:
                        held = int(self.rpc.request('eth_getBalance', [setup, 'latest']), 16) if int(token, 16) == 0 \
                            else self.call(token, 'balanceOf(address)', ['uint256'], ['address'], [setup])[0]
                        self.assertEqual(held, 0)
                        if int(token, 16):
                            self.assertEqual(self.call(token, 'allowance(address,address)', ['uint256'], ['address', 'address'], [self.owner, setup])[0], 0,
                                'exact approvals, spent to the last unit; the reverted batch left none behind')
