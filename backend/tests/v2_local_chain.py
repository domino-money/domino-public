"""TEST FIXTURE: a disposable Base (8453) Anvil with Uniswap's deployed bytecode and the V2 stack.

Why not `scripts/v2/deploy-local.mjs` (#301, PR #302): its offline mode runs the
real V2 contracts on synthetic constructor dependencies, and DEPLOYMENT.md says
it "does not test Uniswap, Permit2, swaps, positions or user journeys"; its
--chain-profile mode needs a fork of the real chain. The automation's EVM tests
compound and exit through real Uniswap pools, so this fixture keeps deploying
the stack itself, on Uniswap's own runtimes, and writes the manifest in #302's
format (`local-test`), which v2_manifest validates exactly as it validates the
tool's. Nothing here is a deployment tool (issue #300 owns the Forge suites).

- Uniswap: the runtimes deployed on Base that F1c captured
  (contracts/test/v2/positions/fixtures, keccak256 equal to the profile's code
  hashes) are set at their Base addresses with the storage their constructors
  wrote; Permit2 is F1b's Robinhood runtime at the canonical address. So the
  automation reads the real Base chain profile, unmodified.
- V2: each of the eleven F0 components is created at the address CreateX's
  deployCreate3 gives its F0 salt for the deployer: this fixture impersonates
  the CREATE3 proxy (the address CREATE2 would give it) with nonce 1, so the
  contract's first CREATE lands exactly there, without CreateX's own bytecode.
  The constructor arguments are deploy.mjs's: the predicted addresses, the
  fixed policies, the deployer's one operator and one publisher. Two
  differences, both forced by the fixture chain having no code there: no
  Universal Router is admitted, and of the profile's charge currencies only
  those with code (and native) are listed.
"""
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import socket
import sys
import time
import urllib.request

from eth_abi import decode, encode
from eth_hash.auto import keccak

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
import local_anvil  # noqa: E402
from v2_chains import PROFILE_DIRECTORY, ZERO  # noqa: E402
from v2_manifest import (BUILD, CONTRACT_NAMES, CREATE_X, CREATE_X_CODE_HASH, DEPLOY_ORDER, POLICIES,  # noqa: E402
                         canonical, create3_proxy, create_address, predict, profile_dependencies)

UNISWAP_FIXTURES = ROOT / 'contracts/test/v2/positions/fixtures'
PERMIT2_FIXTURE = ROOT / 'contracts/test/v2/route/fixtures/RobinhoodPermit2.sol'
HOLDERS = {'V3_FACTORY': 'UniswapBase8453V3Factory', 'V3_POSITION_MANAGER': 'UniswapBase8453V3PositionManager',
           'WETH9': 'UniswapBase8453Weth9', 'V4_POOL_MANAGER': 'UniswapBase8453V4PoolManager',
           'V4_POSITION_MANAGER': 'UniswapBase8453V4PositionManager', 'V4_STATE_VIEW': 'UniswapBase8453V4StateView'}


def selector(signature):
    return keccak(signature.encode())[:4]


def calldata(signature, types=(), values=()):
    return '0x' + (selector(signature) + encode(list(types), list(values))).hex()


class LocalChain:
    """An isolated Anvil with an explicit chain id, and the calls tests make."""

    def __init__(self, chain_id, *, root=ROOT):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        self.url = f'http://127.0.0.1:{port}'
        self.chain_id, self.root = chain_id, Path(os.environ.get('DOMINO_COMPOUND_EVM_ROOT', root)).resolve()
        self.process = local_anvil.start(['--host', '127.0.0.1', '--port', str(port), '--chain-id', str(chain_id),
                                          '--hardfork', 'cancun', '--silent'], root=self.root)
        for _ in range(200):
            try:
                if self.request('eth_chainId', []) != hex(chain_id):
                    raise AssertionError('isolated chain required')
                break
            except OSError:
                time.sleep(.05)
        else:
            raise AssertionError('local EVM failed to start')
        self.accounts = [a.lower() for a in self.request('eth_accounts', [])]

    def stop(self):
        local_anvil.stop(self.process)

    def raw(self, body):
        request = urllib.request.Request(self.url, json.dumps(body).encode(), {'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)

    def request(self, method, params):
        reply = self.raw({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params})
        if 'error' in reply:
            raise AssertionError(f'{method}: {reply["error"]}')
        return reply['result']

    # ------------------------------------------------------------ writing
    def send(self, sender, target, data='0x', value=0, *, impersonate=False, expect_success=True):
        if impersonate:
            self.request('anvil_impersonateAccount', [sender])
        tx = {'from': sender, 'data': data, 'gas': hex(30_000_000), 'value': hex(value)}
        if target is not None:
            tx['to'] = target
        digest = self.request('eth_sendTransaction', [tx])
        if impersonate:
            self.request('anvil_stopImpersonatingAccount', [sender])
        receipt = self.wait(digest)
        if expect_success and receipt['status'] != '0x1':
            raise AssertionError(f'local transaction reverted: {digest}')
        return receipt

    def wait(self, digest):
        for _ in range(500):
            receipt = self.request('eth_getTransactionReceipt', [digest])
            if receipt is not None:
                return receipt
            time.sleep(.01)
        raise AssertionError('transaction not mined')

    def fund(self, account, wei=10**22):
        self.request('anvil_setBalance', [account, hex(wei)])

    def call(self, target, signature, outputs, types=(), values=(), *, block='latest', sender=None):
        tx = {'to': target, 'data': calldata(signature, types, values)}
        if sender:
            tx['from'] = sender
        raw = self.request('eth_call', [tx, block])
        return decode(list(outputs), bytes.fromhex(raw[2:]))

    def mine(self, blocks=1, seconds=1):
        for _ in range(blocks):
            self.request('evm_increaseTime', [seconds])
            self.request('evm_mine', [])

    def head(self):
        return self.request('eth_getBlockByNumber', ['latest', False])

    def artifact(self, source, name):
        return json.loads((self.root / 'contracts/out' / source / f'{name}.json').read_text())

    def deploy(self, sender, source, name, types=(), values=(), *, impersonate=False):
        artifact = self.artifact(source, name)
        initcode = artifact['bytecode']['object'] + encode(list(types), list(values)).hex()
        receipt = self.send(sender, None, initcode, impersonate=impersonate)
        return receipt['contractAddress'].lower()

    # ------------------------------------------------------------ Uniswap
    def etch_base_uniswap(self, chain):
        """Base's deployed Uniswap v3/v4, WETH9 and Permit2, at their Base addresses."""
        source = (UNISWAP_FIXTURES / 'UniswapBase8453.sol').read_text()
        fixtures = json.loads((UNISWAP_FIXTURES / 'base-8453.json').read_text())
        for entry in fixtures['contracts']:
            holder = HOLDERS[entry['key']]
            match = re.search(r'contract ' + holder + r' \{.*?hex"([0-9a-f]+)"', source, re.S)
            runtime = match.group(1)
            if '0x' + keccak(bytes.fromhex(runtime)).hex() != chain.verified_codehash(entry['address']):
                raise AssertionError(f'fixture {holder} is not the profile code')
            target = entry['address'].lower()
            self.request('anvil_setCode', [target, '0x' + runtime])
            for slot in entry['storage']:
                if 'fixtureValue' in slot:
                    self.request('anvil_setStorageAt', [target, '0x' + int(slot['slot'], 16).to_bytes(32, 'big').hex(),
                                                        slot['fixtureValue']])
        # Permit2's runtime differs per chain only in its cached chain id and
        # domain separator (immutables); pool legs never use it, and the swap
        # module only needs code there. F1b's fixture is Robinhood's.
        permit2 = re.search(r'RUNTIME =\s*hex"([0-9a-f]+)"', PERMIT2_FIXTURE.read_text()).group(1)
        if '0x' + keccak(bytes.fromhex(permit2)).hex() != robinhood_codehash(chain.permit2):
            raise AssertionError('Permit2 fixture is not the Robinhood profile code')
        self.request('anvil_setCode', [chain.permit2, '0x' + permit2])


def robinhood_codehash(contract):
    from v2_chains import chain
    return chain('robinhood-4663').verified_codehash(contract)


ROUTE_TYPE = '(address,address,address,bytes32,address)'
DEPLOYMENT_TYPE = '(address,address,address,address,address,address)'
CONFIG_TYPE = '(address,address,uint32,address,address[],address[],address[],(address,uint8)[])'


def source_hashes(root=ROOT):
    """deploy.mjs `compileV2`'s source identity: SHA-256 of every V2 source, by path under contracts/."""
    sources = sorted((root / 'contracts/src/v2').rglob('*.sol'))
    return {str(path.relative_to(root / 'contracts')): hashlib.sha256(path.read_bytes()).hexdigest() for path in sources}


def deploy_v2(local, chain, *, deployer, governance, guardian, fee_recipient, operator, publisher):
    """Every F0 component at its CREATE3 address; returns the verified local-test manifest (#302's format)."""
    if chain.deployer.address != CREATE_X:
        raise AssertionError('the profile deploys through another CreateX')
    contracts, salts, guarded = predict(deployer)
    v3, v4 = chain.uniswap.v3, chain.uniswap.v4
    charge = [(c.address, c.rank) for c in chain.chargeCurrencies
              if c.address == ZERO or local.request('eth_getCode', [c.address, 'latest']) != '0x']
    route = (contracts['registry'], chain.permit2, v3.factory, bytes.fromhex(v3.poolInitCodeHash[2:]), v4.poolManager)
    plan = [
        ('registry', 'DominoRegistry.sol', 'DominoRegistry', [CONFIG_TYPE],
         [(governance, guardian, POLICIES['timelockSeconds'], fee_recipient, [operator], [publisher], [], charge)]),
        ('priceAnchor', 'DominoPriceAnchor.sol', 'DominoPriceAnchor',
         ['address', 'address', 'bytes32', 'address', 'uint32'],
         [contracts['registry'], v3.factory, bytes.fromhex(v3.poolInitCodeHash[2:]), v4.stateView,
          POLICIES['minTwapSeconds']]),
        ('autoExit', 'DominoAutoExit.sol', 'DominoAutoExit', [ROUTE_TYPE, 'address', 'uint32', 'uint32'],
         [route, contracts['priceAnchor'], POLICIES['autoExitMaxObservationAgeSeconds'],
          POLICIES['autoExitMinTwapSeconds']]),
        ('vaultSwap', 'DominoV2VaultSwapModule.sol', 'DominoV2VaultSwapModule', [ROUTE_TYPE], [route]),
        ('vault.v3', 'DominoV2VaultV3.sol', 'DominoV2VaultV3', [DEPLOYMENT_TYPE],
         [(contracts['vaultFactory.v3'], contracts['registry'], contracts['priceAnchor'], v3.positionManager,
           contracts['vaultSwap'], contracts['autoExit'])]),
        ('vault.v4', 'DominoV2VaultV4.sol', 'DominoV2VaultV4', [DEPLOYMENT_TYPE],
         [(contracts['vaultFactory.v4'], contracts['registry'], contracts['priceAnchor'], v4.positionManager,
           contracts['vaultSwap'], contracts['autoExit'])]),
        ('vaultFactory.v3', 'DominoV2VaultFactory.sol', 'DominoV2VaultFactory', ['address'], [contracts['vault.v3']]),
        ('vaultFactory.v4', 'DominoV2VaultFactory.sol', 'DominoV2VaultFactory', ['address'], [contracts['vault.v4']]),
        ('zap.v4.steps', 'DominoZapV4Steps.sol', 'DominoZapV4Steps', [], []),
        ('zap.v3', 'DominoZapV3.sol', 'DominoZapV3', [ROUTE_TYPE, 'address'], [route, v3.positionManager]),
        ('zap.v4', 'DominoZapV4.sol', 'DominoZapV4', [ROUTE_TYPE, 'address', 'address'],
         [route, v4.positionManager, contracts['zap.v4.steps']]),
    ]
    if [step[0] for step in plan] != list(DEPLOY_ORDER):
        raise AssertionError('the fixture deploys in another order than deploy.mjs')
    receipts = {}
    for name, source, contract, types, values in plan:
        proxy = create3_proxy(CREATE_X, guarded[name])
        local.fund(proxy, 10**21)
        local.request('anvil_setNonce', [proxy, hex(1)])
        receipt = local.send(proxy, None, local.artifact(source, contract)['bytecode']['object']
                             + encode(types, values).hex(), impersonate=True)
        if receipt['contractAddress'].lower() != contracts[name]:
            raise AssertionError(f'{name} did not land at its CREATE3 address')
        receipts[name] = {'transactionHash': receipt['transactionHash'].lower(),
                          'blockNumber': int(receipt['blockNumber'], 16), 'blockHash': receipt['blockHash'].lower(),
                          'gasUsed': str(int(receipt['gasUsed'], 16)),
                          'effectiveGasPrice': str(int(receipt['effectiveGasPrice'], 16))}
    for dex in ('v3', 'v4'):
        if contracts[f'vaultExecutor.{dex}'] != create_address(contracts[f'vault.{dex}'], 1):
            raise AssertionError('executor prediction')
    dependencies = profile_dependencies(chain)
    head = local.head()
    hashes = {}
    for name, address in {**contracts, **dependencies}.items():
        code = local.request('eth_getCode', [address, head['number']])
        if name in contracts and code == '0x':
            raise AssertionError(f'{name} has no code')
        # A dependency this chain does not carry (quoters, routers) records the empty code's hash.
        hashes[name] = '0x' + keccak(bytes.fromhex(code[2:])).hex()
    sources = source_hashes(local.root)
    profile = json.loads((PROFILE_DIRECTORY / f'{chain.key}.json').read_text())
    return {
        'schemaVersion': 1, 'kind': 'domino-v2-deployment', 'status': 'verified', 'environment': 'local-test',
        'chain': {'name': chain.name, 'chainId': chain.chainId, 'nativeCurrency': chain.nativeSymbol},
        'sourceCommit': '0' * 40, 'releaseTag': 'local-fixture',
        'contractNames': dict(CONTRACT_NAMES), 'contracts': contracts, 'dependencies': dependencies,
        'roles': {'deployer': deployer, 'governance': governance, 'guardian': guardian,
                  'feeRecipient': fee_recipient, 'operator': operator, 'publisher': publisher},
        'policies': dict(POLICIES), 'chargeCurrencies': [{'token': token, 'rank': rank} for token, rank in charge],
        'runtimeCodeHashes': hashes,
        'createx': {'address': CREATE_X, 'runtimeCodeHash': CREATE_X_CODE_HASH, 'salts': salts,
                    'guardedSalts': guarded},
        # The fixture builds whatever is checked out: never a qualified source.
        'build': {**BUILD, 'sourceTreeSha256': hashlib.sha256(canonical(sources).encode()).hexdigest(),
                  'workingTreeSourceChanges': True, 'sourceHashes': sources,
                  'chainProfileSha256': hashlib.sha256(canonical(profile).encode()).hexdigest()},
        'deploymentReceipts': receipts,
        'verification': {'blockNumber': int(head['number'], 16), 'blockHash': head['hash'].lower(),
                         'blockTag': 'latest', 'codeHashes': 'exact_precomputed_immutable_runtime',
                         'wiring': 'checked',
                         'checkedAt': datetime.now(timezone.utc).isoformat(timespec='milliseconds')},
    }
