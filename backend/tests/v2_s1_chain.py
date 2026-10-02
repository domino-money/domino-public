"""TEST FIXTURE: a disposable Anvil with real Uniswap v3/v4 code, Permit2 and the V2 zap, for the S1 plan tests.

Replace `deploy_domino` with `node scripts/v2/deploy-local.mjs --rpc <url> --out
<manifest>` (#301, PR #302) once its local mode can run real Uniswap: its
offline mode installs synthetic dependency code, which answers constructor
reads only and cannot swap or hold positions, so the S1 journeys need this
fixture. The manifest written here has #301's shape (scripts/v2/
deploy-manifest.schema.json) with `environment: local-test`, and only the keys
the S1 planner reads are meaningful.

Two flavors of Uniswap, both at Base's (8453) addresses unless noted:
- `deployed`: the runtimes deployed on Base that F1c captured (v3 factory,
  NonfungiblePositionManager, WETH9, v4 PoolManager, PositionManager,
  StateView; contracts/test/v2/positions/fixtures) with the storage their
  constructors wrote, and Base's QuoterV2 and V4Quoter
  (backend/tests/fixtures/v2-base-plan-runtimes.json, with Multicall3). Each
  runtime's keccak256 is the Base profile's code hash, so the planner reads the
  real Base profile.
- `vendored`: the v4 PoolManager, PositionManager and StateView compiled from
  the vendored official sources (contracts/out), at fresh addresses, with
  Base's V4Quoter runtime pointed at that PoolManager (its four immutable
  references rewritten; nothing else differs). v3 is the deployed one.
- `router`: Robinhood (4663) with the v4 PoolManager and Universal Router
  2.1.2 runtimes deployed there (F1b's fixtures, at their own addresses), the
  vendored PositionManager and StateView on that PoolManager, and no v3: the
  chain where a router leg runs through the real router 2.1.2.
Permit2 is F1b's Robinhood runtime at the canonical address (it recomputes its
domain separator for chain 8453). Tokens are SetupToken (contracts/out), a
plain exact-transfer ERC-20 without decimals().

The Domino contracts are the real compiled V2 stack from contracts/out. On the
Base chains every F0 component lands at its CREATE3 address through the
automation suite's `v2_local_chain.deploy_v2` (#306), whose manifest
v2_manifest admits as a local test: the planner loads it exactly as it loads a
real deployment. The router chain has no v3 code for deploy_v2's v3
components, so there the registry, zap.v4 and zap.v4.steps are deployed with
plain CREATE and the planner gets a v2_manifest.Deployment of them directly.

L1 data fees: the Base chains carry Base's own GasPriceOracle and L1Block
(proxies, implementations and the state they read, captured read-only at a
finalized block: backend/tests/fixtures/v2-base-l1-fee.json), so getL1Fee is
Base's computation; the router chain (Nitro) answers NodeInterface's
gasEstimateL1Component from a stand-in at 0xc8: 16 L2 gas per byte of the
data at a 0.01 gwei L2 base fee, never a measurement.
"""
import json
import os
from pathlib import Path
import re
import shutil
import socket
import sys
import tempfile
import time
import urllib.request

from eth_abi import decode, encode
from eth_account import Account
from eth_hash.auto import keccak
from eth_utils import to_checksum_address

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
sys.path.insert(0, str(ROOT / 'backend/tests'))
import local_anvil  # noqa: E402
from v2_fixtures import documents, write_registry  # noqa: E402

ZERO = '0x' + '00' * 20
UNISWAP_FIXTURES = ROOT / 'contracts/test/v2/positions/fixtures'
PERMIT2_FIXTURE = ROOT / 'contracts/test/v2/route/fixtures/RobinhoodPermit2.sol'
ROBINHOOD_POOL_MANAGER = ROOT / 'contracts/test/v2/route/fixtures/RobinhoodPoolManager.sol'
ROBINHOOD_ROUTER = ROOT / 'contracts/test/v2/route/fixtures/RobinhoodUniversalRouter212.sol'
QUOTERS = ROOT / 'backend/tests/fixtures/v2-base-plan-runtimes.json'
L1_FEE = ROOT / 'backend/tests/fixtures/v2-base-l1-fee.json'
NODE_INTERFACE = '0x00000000000000000000000000000000000000c8'
# gasEstimateL1Component(address,bool,bytes) stand-in: returns (len(data) * 16, 1e7, 3e10).
NODE_INTERFACE_RUNTIME = ('606435' '601002' '600052' '6300989680' '602052' '6406fc23ac00' '604052' '6060' '6000' 'f3')
NODE_INTERFACE_BASE_FEE = 10**7
PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
BASE_POOL_MANAGER = '0x498581ff718922c3f8e6a244956af099b2652b2b'
HOLDERS = {'V3_FACTORY': 'UniswapBase8453V3Factory', 'V3_POSITION_MANAGER': 'UniswapBase8453V3PositionManager',
           'WETH9': 'UniswapBase8453Weth9', 'V4_POOL_MANAGER': 'UniswapBase8453V4PoolManager',
           'V4_POSITION_MANAGER': 'UniswapBase8453V4PositionManager', 'V4_STATE_VIEW': 'UniswapBase8453V4StateView'}
ROUTE_TYPE = '(address,address,address,bytes32,address)'
REGISTRY_CONFIG = '(address,address,uint32,address,address[],address[],address[],(address,uint8)[])'


def calldata(signature, types=(), values=()):
    return '0x' + (keccak(signature.encode())[:4] + encode(list(types), list(values))).hex()


def robinhood_codehash(contract, document):
    return next(record['codehash'] for record in document['verification']['contracts']
                if record['address'].lower() == contract)


def runtime_of(source, holder):
    text = source.read_text()
    match = re.search(r'contract ' + holder + r' \{.*?hex"([0-9a-f]+)"', text, re.S) if holder else \
        re.search(r'RUNTIME =\s*hex"([0-9a-f]+)"', text)
    return match.group(1)


class LocalChain:
    """An isolated Anvil with an explicit chain id."""

    def __init__(self, chain_id=8453):
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        self.url = f'http://127.0.0.1:{port}'
        self.chain_id = chain_id
        self.root = Path(os.environ.get('DOMINO_COMPOUND_EVM_ROOT', ROOT)).resolve()
        self.process = local_anvil.start(['--host', '127.0.0.1', '--port', str(port), '--chain-id', str(chain_id),
                                          '--hardfork', 'cancun', '--gas-limit', '60000000', '--silent'],
                                         root=self.root)
        for _ in range(200):
            try:
                if self.request('eth_chainId', []) != hex(chain_id):
                    raise AssertionError('isolated chain required')
                break
            except OSError:
                time.sleep(.05)
        else:
            raise AssertionError('local EVM failed to start')
        self.deployer = self.request('eth_accounts', [])[0].lower()
        self.calls, self.sent = 0, []  # the planner's billed calls, and what they were

    def stop(self):
        local_anvil.stop(self.process)

    def transport(self, body):
        request = urllib.request.Request(self.url, json.dumps(body).encode(), {'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.load(response)

    def request(self, method, params):
        reply = self.transport({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params})
        if 'error' in reply:
            raise AssertionError(f'{method}: {reply["error"]}')
        return reply['result']

    def account(self, label):
        """A fresh funded account whose key the test holds (it signs typed data)."""
        account = Account.from_key(keccak(('domino s1 plan test ' + label).encode()))
        self.fund(account.address.lower())
        return account

    def fund(self, who, wei=10**24):
        self.request('anvil_setBalance', [who, hex(wei)])

    def send(self, sender, target, data='0x', value=0, *, expect=True, gas=30_000_000, impersonate=True):
        self.request('anvil_impersonateAccount', [sender])
        tx = {'from': sender, 'data': data, 'gas': hex(gas), 'value': hex(value)}
        if target is not None:
            tx['to'] = target
        digest = self.request('eth_sendTransaction', [tx])
        self.request('anvil_stopImpersonatingAccount', [sender])
        receipt = self.wait(digest)
        if expect and receipt['status'] != '0x1':
            raise AssertionError(f'local transaction reverted: {digest} {self.revert_reason(tx)}')
        return receipt

    def revert_reason(self, tx):
        reply = self.transport({'jsonrpc': '2.0', 'id': 1, 'method': 'eth_call',
                                'params': [{k: v for k, v in tx.items() if k != 'gas'}, 'latest']})
        return (reply.get('error') or {}).get('data')

    def wait(self, digest):
        for _ in range(1000):
            receipt = self.request('eth_getTransactionReceipt', [digest])
            if receipt is not None:
                return receipt
            time.sleep(.01)
        raise AssertionError('transaction not mined')

    def call(self, target, signature, outputs, types=(), values=(), *, sender=None):
        tx = {'to': target, 'data': calldata(signature, types, values)}
        if sender:
            tx['from'] = sender
        raw = self.request('eth_call', [tx, 'latest'])
        return decode(list(outputs), bytes.fromhex(raw[2:]))

    def artifact(self, source, name):
        return json.loads((self.root / 'contracts/out' / source / f'{name}.json').read_text())

    def deploy(self, source, name, types=(), values=()):
        initcode = self.artifact(source, name)['bytecode']['object'] + encode(list(types), list(values)).hex()
        receipt = self.send(self.deployer, None, initcode)
        return receipt['contractAddress'].lower()

    def codehash(self, contract):
        code = self.request('eth_getCode', [contract, 'latest'])
        return '0x' + keccak(bytes.fromhex(code[2:])).hex()

    def set_code(self, contract, runtime):
        self.request('anvil_setCode', [contract, '0x' + runtime.removeprefix('0x')])

    def mine(self, seconds=1):
        self.request('evm_increaseTime', [seconds])
        self.request('evm_mine', [])

    def head(self):
        return self.request('eth_getBlockByNumber', ['latest', False])


class S1Fixture:
    """Uniswap, Permit2, tokens and the V2 zap on one local chain, plus the
    chain profile and #301-shaped manifest the planner reads."""

    def __init__(self, flavor='vendored'):
        if flavor not in ('vendored', 'deployed', 'router'):
            raise ValueError(flavor)
        self.flavor = flavor
        self.chain = LocalChain(4663 if flavor == 'router' else 8453)
        self.directory = Path(tempfile.mkdtemp(prefix='domino-s1-')).resolve()
        try:
            self._install()
        except BaseException:
            self.close()
            raise

    def close(self):
        self.chain.stop()
        shutil.rmtree(self.directory, ignore_errors=True)

    # ------------------------------------------------------------- uniswap
    def _install(self):
        if self.flavor == 'router':
            return self._install_router()
        local = self.chain
        fixtures = json.loads((UNISWAP_FIXTURES / 'base-8453.json').read_text())
        source = UNISWAP_FIXTURES / 'UniswapBase8453.sol'
        installed = {}
        for entry in fixtures['contracts']:
            if self.flavor == 'vendored' and entry['key'].startswith('V4_'):
                continue
            runtime = runtime_of(source, HOLDERS[entry['key']])
            if '0x' + keccak(bytes.fromhex(runtime)).hex() != entry['codehash']:
                raise AssertionError('fixture is not the profile runtime')
            address = entry['address'].lower()
            local.set_code(address, runtime)
            for slot in entry['storage']:
                if 'fixtureValue' in slot:
                    local.request('anvil_setStorageAt', [address, '0x' + int(slot['slot'], 16).to_bytes(32, 'big').hex(),
                                                         slot['fixtureValue']])
            installed[entry['key']] = address
        quoters = {c['name']: c for c in json.loads(QUOTERS.read_text())['contracts']}
        local.set_code(quoters['QuoterV2']['address'].lower(), quoters['QuoterV2']['runtime'])
        local.set_code(quoters['Multicall3']['address'].lower(), quoters['Multicall3']['runtime'])
        local.set_code(PERMIT2, runtime_of(PERMIT2_FIXTURE, None))
        self._install_l1_fee()
        docs = documents()
        base = docs['base-8453.json']
        self.v4 = {name: base['uniswap']['v4'][name].lower() for name in ('poolManager', 'positionManager',
                                                                          'stateView', 'quoter')}
        quoter = quoters['V4Quoter']['runtime']
        if self.flavor == 'vendored':
            manager = local.deploy('PoolManager.sol', 'PoolManager', ['address'], [local.deployer])
            positions = local.deploy('PositionManager.sol', 'PositionManager',
                                     ['address', 'address', 'uint256', 'address', 'address'],
                                     [manager, PERMIT2, 300000, '0x' + '22' * 20, '0x4200000000000000000000000000000000000006'])
            state = local.deploy('StateView.sol', 'StateView', ['address'], [manager])
            if quoter.count(BASE_POOL_MANAGER[2:]) != 4:
                raise AssertionError('V4Quoter immutables moved')
            quoter = quoter.replace(BASE_POOL_MANAGER[2:], manager[2:])
            quoter_address = '0x' + keccak(b'domino s1 vendored v4 quoter')[12:].hex()
            replaced = {'poolManager': manager, 'positionManager': positions, 'stateView': state, 'quoter': quoter_address}
            text = json.dumps(base)
            for name, new in replaced.items():
                text = text.replace(base['uniswap']['v4'][name], to_checksum_address(new))
            base = json.loads(text)
            local.set_code(quoter_address, quoter)
            for record in base['verification']['contracts']:
                if record['address'].lower() in replaced.values():
                    record['codehash'] = local.codehash(record['address'].lower())
            docs['base-8453.json'] = base
            self.v4 = replaced
        else:
            local.set_code(self.v4['quoter'], quoter)
        profiles = self.directory / 'chains'
        profiles.mkdir()
        self.profile = write_registry(profiles, docs).chain('base-8453')
        self.v3 = {'factory': self.profile.uniswap.v3.factory, 'positionManager': self.profile.uniswap.v3.positionManager,
                   'quoter': self.profile.uniswap.v3.quoterV2}
        self.weth = self.profile.wrappedNative.address

    def _install_l1_fee(self):
        """Base's GasPriceOracle and L1Block, code and state, as captured."""
        for contract in json.loads(L1_FEE.read_text())['contracts']:
            self.chain.set_code(contract['address'], contract['runtime'])
            for slot, value in contract['storage'].items():
                self.chain.request('anvil_setStorageAt', [contract['address'], slot, value])

    def _install_router(self):
        local = self.chain
        local.set_code(NODE_INTERFACE, NODE_INTERFACE_RUNTIME)
        quoters = {c['name']: c for c in json.loads(QUOTERS.read_text())['contracts']}
        local.set_code(quoters['Multicall3']['address'].lower(), quoters['Multicall3']['runtime'])
        local.set_code(PERMIT2, runtime_of(PERMIT2_FIXTURE, None))
        docs = documents()
        robinhood = docs['robinhood-4663.json']
        manager = robinhood['uniswap']['v4']['poolManager'].lower()
        runtime = runtime_of(ROBINHOOD_POOL_MANAGER, None)
        if '0x' + keccak(bytes.fromhex(runtime)).hex() != robinhood_codehash(manager, robinhood):
            raise AssertionError('PoolManager fixture is not the Robinhood profile code')
        local.set_code(manager, runtime)
        self.router = robinhood['uniswap']['universalRouter']['address'].lower()
        runtime = runtime_of(ROBINHOOD_ROUTER, None)
        if '0x' + keccak(bytes.fromhex(runtime)).hex() != robinhood_codehash(self.router, robinhood):
            raise AssertionError('Universal Router fixture is not the Robinhood profile code')
        local.set_code(self.router, runtime)
        weth = robinhood['wrappedNative']['address'].lower()
        positions = local.deploy('PositionManager.sol', 'PositionManager',
                                 ['address', 'address', 'uint256', 'address', 'address'],
                                 [manager, PERMIT2, 300000, '0x' + '22' * 20, weth])
        state = local.deploy('StateView.sol', 'StateView', ['address'], [manager])
        quoter = quoters['V4Quoter']['runtime'].replace(BASE_POOL_MANAGER[2:], manager[2:])
        quoter_address = '0x' + keccak(b'domino s1 router v4 quoter')[12:].hex()
        local.set_code(quoter_address, quoter)
        replaced = {'positionManager': positions, 'stateView': state, 'quoter': quoter_address}
        text = json.dumps(robinhood)
        for name, new in replaced.items():
            text = text.replace(robinhood['uniswap']['v4'][name], to_checksum_address(new))
        robinhood = json.loads(text)
        for record in robinhood['verification']['contracts']:
            if record['address'].lower() in replaced.values():
                record['codehash'] = local.codehash(record['address'].lower())
        docs['robinhood-4663.json'] = robinhood
        profiles = self.directory / 'chains'
        profiles.mkdir()
        self.profile = write_registry(profiles, docs).chain('robinhood-4663')
        self.v4 = {'poolManager': manager, **replaced}
        self.v3 = None
        self.weth = weth

    # ------------------------------------------------------------- tokens
    def token(self):
        return self.chain.deploy('DominoSetup.t.sol', 'SetupToken')

    def tokens(self, count):
        return sorted(self.token() for _ in range(count))

    def mint(self, token, to, amount):
        if token == self.weth:
            self.chain.fund(to, 10**25)
            self.chain.send(to, token, calldata('deposit()'), amount)
        else:
            self.chain.send(self.chain.deployer, token, calldata('mint(address,uint256)', ['address', 'uint256'],
                                                                 [to, amount]))

    def balance(self, token, holder):
        if token == ZERO:
            return int(self.chain.request('eth_getBalance', [holder, 'latest']), 16)
        return self.chain.call(token, 'balanceOf(address)', ['uint256'], ['address'], [holder])[0]

    def approve(self, owner, token, spender, amount):
        self.chain.send(owner, token, calldata('approve(address,uint256)', ['address', 'uint256'], [spender, amount]))

    # -------------------------------------------------------------- domino
    def deploy_domino(self, charge_currencies, *, fee_recipient=None, routers=()):
        """The V2 stack and its v2_manifest Deployment (`self.deployment`), with the
        registry ranking `charge_currencies` [(token, rank)].

        Base chains: every F0 component at its CREATE3 address (#306's deploy_v2),
        its manifest written and loaded by v2_manifest as a local test; the test
        ranks are written into the registry's storage, as governance's
        timelocked call would leave them. The router chain: the registry
        (admitting `routers`), zap.v4.steps and zap.v4 by CREATE."""
        self.fee_recipient = (fee_recipient or '0x' + 'fe' * 20).lower()
        roles = {name: Account.from_key(keccak(f'domino s1 plan {name}'.encode())).address.lower()
                 for name in ('governance', 'guardian', 'operator', 'publisher')}
        if self.flavor == 'router':
            return self._deploy_on_router_chain(charge_currencies, roles, routers)
        if routers:
            raise ValueError('only the router chain admits routers here')
        from v2_local_chain import deploy_v2
        from v2_manifest import load_deployment
        manifest = deploy_v2(self.chain, self.profile, deployer=self.chain.deployer, governance=roles['governance'],
                             guardian=roles['guardian'], fee_recipient=self.fee_recipient, operator=roles['operator'],
                             publisher=roles['publisher'])
        path = self.directory / 'deployment.json'
        path.write_text(json.dumps(manifest, indent=2))
        self.manifest, self.manifest_path = manifest, path
        self.deployment = load_deployment(path, self.profile, admission='local-test')
        self.registry = self.deployment.registry
        self.zap_v3, self.zap_v4 = self.deployment.address('zap.v3'), self.deployment.address('zap.v4')
        self.set_ranks(dict(charge_currencies))
        return manifest

    def _deploy_on_router_chain(self, charge_currencies, roles, routers):
        from v2_manifest import Deployment
        local = self.chain
        config = (roles['governance'], roles['guardian'], 86400, self.fee_recipient, [roles['operator']],
                  [roles['publisher']], list(routers), [(token, rank) for token, rank in charge_currencies])
        registry = local.deploy('DominoRegistry.sol', 'DominoRegistry', [REGISTRY_CONFIG], [config])
        # No v3 on this chain: a zero factory disables v3 legs (F1b) and there is no zap.v3.
        route = (registry, PERMIT2, ZERO, bytes(32), self.v4['poolManager'])
        steps = local.deploy('DominoZapV4Steps.sol', 'DominoZapV4Steps')
        zap_v4 = local.deploy('DominoZapV4.sol', 'DominoZapV4', [ROUTE_TYPE, 'address', 'address'],
                              [route, self.v4['positionManager'], steps])
        contracts = {'registry': registry, 'zap.v4.steps': steps, 'zap.v4': zap_v4}
        head = local.head()
        # The fields a v2_manifest.Deployment reads; not a #302 manifest (no CREATE3, no v3 components).
        self.manifest = {'contracts': contracts,
                         'runtimeCodeHashes': {name: local.codehash(address) for name, address in contracts.items()},
                         'verification': {'blockNumber': int(head['number'], 16), 'blockHash': head['hash'].lower()}}
        self.manifest_path = None
        self.deployment = Deployment(self.profile, self.manifest)
        self.registry, self.zap_v3, self.zap_v4 = registry, None, zap_v4
        return self.manifest

    def set_ranks(self, ranks):
        """chargeCurrencyRank of each token, written into the registry's storage
        (the mapping at slot 8, read back through the registry)."""
        for token, rank in ranks.items():
            slot = '0x' + keccak(encode(['address', 'uint256'], [token, 8])).hex()
            self.chain.request('anvil_setStorageAt', [self.registry, slot, '0x' + rank.to_bytes(32, 'big').hex()])
            read, = self.chain.call(self.registry, 'chargeCurrencyRank(address)', ['uint8'], ['address'], [token])
            if read != rank:
                raise AssertionError('registry rank slot moved')

    # ------------------------------------------------------------- reading
    def endpoints(self):
        """The planner's chain client: v2_rpc's transport to this Anvil."""
        from v2_rpc import ChainEndpoints, Endpoint
        local = self.chain

        def send(_url, body):
            local.calls += len(body) if isinstance(body, list) else 1
            local.sent.extend(body if isinstance(body, list) else [body])
            return local.transport(body)
        endpoint = Endpoint('local', 'anvil.invalid', 'https://anvil.invalid/', None, 100, None, None)
        return ChainEndpoints(self.profile, (endpoint,), 'test', send=send)
