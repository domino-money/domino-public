#!/usr/bin/env python3
"""Gas units of the V2 automation path on a Robinhood fork, beside V1's of 22 September 2026.

V1's record (reports/GAS_UNITS_V1_2026-09-22.md) measured the deployed V1 contracts on an
Anvil child forked at the head block. This repeats its conditions for V2:
- the same child (DepositFork), forked at the head from a loopback source (the own node
  through an SSH tunnel), cancun rules, Anvil receipts;
- the same pool, WETH/USDG 0.02% (0x84bd...ad0b6), with its 52-pip protocol fee;
- the same root, 2 WETH and 8,000 USDG, 200 ticks either side of the spot;
- the same fee generation: forty round trips of the study's driver, each leg the sale
  that moves the price 20 bps (qualify_execution_fork.Experiment.amount_for_move).

V2 is not deployed on Robinhood. The child gets every F0 component at its CREATE3 address
(backend/tests/v2_local_chain.deploy_v2), from DOMINO_COMPOUND_EVM_ROOT's artifacts, each
bound to its source bytes and compiler profile. Roles are synthetic keys; the observation
each plan carries is signed by the synthetic publisher at the child's spot.

Plans are built as the integration suites build them (contracts/test/v2/integration):
collect the root, fund from its fees, amounts left to the vault; a swap spends 40% of the
root's WETH fees through the pool itself, with the floor the vault computes. The planner
is not used: it does not mint successors yet. Nothing leaves the child; reads of the
source are bounded by DepositFork, plus two L1 data quotes per measured transaction.

Run with the repository's backend/.venv Python and DOMINO_COMPOUND_EVM_ROOT pointing at
a checkout whose contracts/out holds this tree's V2 and fixture artifacts.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
sys.path.insert(0, str(ROOT / 'backend' / 'tests'))
from eth_abi import decode, encode
from eth_account import Account
from eth_hash.auto import keccak

import qualify_execution_fork as q
from deposit_fork import DepositFork
from discovery import CHAIN_ID, POSITION_MANAGER, STATE_VIEW, ZERO, DataError
from qualify_deposit_fork import USDG, WETH
from v2_chains import chain as profile
from v2_local_chain import deploy_v2
from v2_observation import ObservationSigner, PriceObservation
from v2_plan import ACTION_COMPOUND, ACTION_MINT, U128, Budget, PlanV1, Swap, execute_calldata, pool_leg
from v2_planner import liquidity_for_amounts, minimum_output
from v2_uniswap import PoolRef
from v4_math import sqrt_at_tick

PERMIT2 = '0x000000000022d473030f116ddee9f6b43ac78ba3'
NODE_INTERFACE = '0x00000000000000000000000000000000000000c8'
OPERATOR_KEY = keccak(b'domino.v2.gas-units.operator')
PUBLISHER_KEY = keccak(b'domino.v2.gas-units.publisher')
OPERATOR = Account.from_key(OPERATOR_KEY).address.lower()
PUBLISHER = Account.from_key(PUBLISHER_KEY).address.lower()
OWNER, DRIVER_OWNER = q.OWNER, q.ATTACKER
DEPLOYER = '0x00000000000000000000000000000000000d0d0d'
GOVERNANCE = '0x000000000000000000000000000000000000a11c'
GUARDIAN = '0x000000000000000000000000000000000000b10c'
FEE_RECIPIENT = '0x' + 'fe' * 20
KEY_TYPE = q.KEY_TYPE
INIT_TYPE = '((uint8,address,uint256),(uint8,uint16,uint16,uint32,uint8),(uint16,uint16,uint32,uint32),bool,bool)'
MODE_SIMPLE, MODE_DOMINO = 1, 2
# IntegrationWorld's vault terms: overlap and interval policy, then slippage 1%, band 2%, observation age 300 s.
POLICY = (500, 2000, 600)
LIMITS = (100, 200, 300, 5000)
SLIPPAGE_BPS, LP_FEE_PIPS = 100, 200
MINT_POSITION, SETTLE_PAIR = 0x02, 0x0D


class V2Fork(DepositFork):
    """DepositFork with one more local control: deploy_v2 sets each CREATE3 proxy's nonce to 1, as
    CreateX's proxy has when it creates. Like every other control it never reaches the source."""

    def request(self, method, params=()):
        if method == 'anvil_setNonce' and self._verified:
            return self._request(method, list(params))
        return super().request(method, params)


def successor_range(parent_upper, spacing, anchor, upside_bps, below=120):
    """DominoV2VaultExecutor._checkSuccessor's range, not inverse: the floor at most the basis (the
    parent's ceiling, or the anchor once past it); the top the first tick on spacing whose price is
    the upside above the basis, and not one spacing lower."""
    ceiling = sqrt_at_tick(parent_upper)
    basis = anchor if anchor >= ceiling else ceiling
    top = parent_upper
    while sqrt_at_tick(top) ** 2 * 10_000 < (10_000 + upside_bps) * basis ** 2:
        top += spacing
    return parent_upper - below, top


def calldata_gas(data):
    raw = bytes.fromhex(data[2:])
    return sum(4 if byte == 0 else 16 for byte in raw)


def v2_artifact(root, source, name):
    """load_fork_artifact's checks for a V2 artifact: the pinned compiler profile and
    every source's bytes as compiled."""
    contracts = (Path(root) / 'contracts').resolve()
    raw = (contracts / 'out' / source / (name + '.json')).read_bytes()
    artifact = json.loads(raw)
    metadata = artifact['metadata']
    settings = metadata['settings']
    targets = settings.get('compilationTarget') or {}
    if len(targets) != 1:
        raise DataError('fork_artifact_target_mismatch')
    target, = targets
    if (Path(target).name != source or targets[target] != name
            or metadata['compiler']['version'] != '0.8.26+commit.8a97fa7a'
            or settings.get('optimizer') != {'enabled': True, 'runs': 200}
            or settings.get('viaIR') is not True or settings.get('evmVersion') != 'cancun'
            or settings.get('metadata', {}).get('bytecodeHash') != 'none'):
        raise DataError('fork_artifact_profile_mismatch:' + name)
    sources = {}
    for path, entry in metadata['sources'].items():
        if (not path.startswith(('src/', 'test/', 'lib/')) or '\\' in path
                or any(part in ('', '.', '..') for part in path.split('/'))):
            raise DataError('fork_artifact_unsafe_source')
        data = (contracts / path).read_bytes()
        if '0x' + keccak(data).hex() != entry['keccak256']:
            raise DataError('fork_artifact_source_changed:' + path)
        sources[path] = hashlib.sha256(data).hexdigest()
    provenance = {'artifactSha256': hashlib.sha256(raw).hexdigest(), 'compilationTarget': target,
                  'creationCodeHash': '0x' + keccak(bytes.fromhex(artifact['bytecode']['object'][2:])).hex(),
                  'sourceManifestSha256': hashlib.sha256(json.dumps(sources, sort_keys=True).encode()).hexdigest()}
    return artifact, provenance


class Child:
    """deploy_v2's view of the child: LocalChain's calls on the DepositFork."""

    def __init__(self, experiment, root):
        self.x, self.root = experiment, Path(root)

    def request(self, method, params):
        return self.x.fork.request(method, params)

    def fund(self, account, wei=10**22):
        self.x.fund_native(account, wei)

    def artifact(self, source, name):
        return self.x.artifact(source, name)

    def head(self):
        return self.request('eth_getBlockByNumber', ['latest', False])

    def send(self, sender, target, data='0x', value=0, *, impersonate=False, expect_success=True):
        if impersonate:
            self.request('anvil_impersonateAccount', [sender])
        try:
            receipt = self.x.send(sender, target, data, value, gas=30_000_000)
        finally:
            if impersonate:
                self.request('anvil_stopImpersonatingAccount', [sender])
        if expect_success and receipt['status'] != '0x1':
            raise DataError('fork_step_failed:v2_deploy')
        return receipt


class V2Experiment(q.Experiment):
    def __init__(self, fork, source, root):
        super().__init__(fork, 'weth-usdg', 0, 600)
        self.source, self.root = source, Path(root)
        self.transactions, self.nonce = [], 0
        self.pool = PoolRef(4, self.key.currency0, self.key.currency1, self.key.fee_pips, self.key.tick_spacing,
                            self.key.hooks)
        self.v2_provenance = {}

    def artifact(self, source, name):
        if name in q.FORK_ARTIFACTS:
            return super().artifact(source, name)
        artifact, provenance = v2_artifact(self.root, source, name)
        self.v2_provenance[name] = provenance
        return artifact

    # ------------------------------------------------------------ helpers
    def head(self):
        return self.fork.request('eth_getBlockByNumber', ['latest', False])

    def now(self):
        return int(self.head()['timestamp'], 16)

    def advance(self, seconds):
        self.fork.request('evm_setNextBlockTimestamp', [self.now() + seconds])
        self.fork.request('evm_mine', [])

    def data_quotes(self, sender, target, data, value):
        """NodeInterface's L1 data component for this calldata, from the source, as V1 recorded it."""
        quotes = []
        for tag in ('latest', 'safe'):
            try:
                block = self.source.request('eth_getBlockByNumber', [tag, False])
                raw = self.source.request('eth_call', [{'from': sender, 'to': NODE_INTERFACE,
                    'data': q.calldata('gasEstimateL1Component(address,bool,bytes)', ['address', 'bool', 'bytes'],
                                       [target, False, bytes.fromhex(data[2:])]), 'value': hex(value)},
                    {'blockHash': block['hash'], 'requireCanonical': True}])
                gas, base, l1base = decode(['uint64', 'uint256', 'uint256'], bytes.fromhex(raw[2:]))
                quotes.append({'tag': tag, 'number': int(block['number'], 16), 'l1DataGasInL2Units': gas,
                               'baseFeeWei': str(base), 'l1BaseFeeEstimateWei': str(l1base)})
            except Exception as error:  # noqa: BLE001 - a quote is evidence, never a run failure
                quotes.append({'tag': tag, 'unavailable': type(error).__name__})
        return quotes

    def measured(self, kind, sender, target, data, value=0, **extra):
        receipt = self.must(sender, target, data, value, what=kind)
        entry = {'kind': kind, 'gasUsed': int(receipt['gasUsed'], 16), 'calldataBytes': (len(data) - 2) // 2,
                 'calldataGas': calldata_gas(data), 'blockNumber': int(receipt['blockNumber'], 16),
                 'transactionHash': receipt['transactionHash'], **extra,
                 'l1DataQuotes': self.data_quotes(sender, target, data, value)}
        self.transactions.append(entry)
        print(json.dumps({'measured': kind, 'gasUsed': entry['gasUsed'], 'calldataBytes': entry['calldataBytes']}),
              flush=True)
        return receipt

    # ---------------------------------------------------------------- stack
    def deploy_v2(self):
        for account in (DEPLOYER, GOVERNANCE, GUARDIAN, OWNER, OPERATOR, PUBLISHER, DRIVER_OWNER):
            self.fund_native(account, 10**22)
            self.fork.request('anvil_impersonateAccount', [account])
        manifest = deploy_v2(Child(self, self.root), profile('robinhood-4663'), deployer=DEPLOYER,
                             governance=GOVERNANCE, guardian=GUARDIAN, fee_recipient=FEE_RECIPIENT,
                             operator=OPERATOR, publisher=PUBLISHER)
        self.contracts = manifest['contracts']
        self.signer = ObservationSigner(PUBLISHER_KEY, chain_id=CHAIN_ID, anchor=self.contracts['priceAnchor'])
        self.driver = self.deploy(DRIVER_OWNER, 'OfficialV4Fixture.sol', 'OfficialV4SwapDriver', ['address'],
                                  [q.POOL_MANAGER])
        return {'contracts': self.contracts, 'deploymentGas': {k: int(v['gasUsed']) for k, v in
                manifest['deploymentReceipts'].items()}, 'sourceTreeSha256': manifest['build']['sourceTreeSha256'],
                'driver': self.driver}

    def mint_root(self, lower, upper, amount0, amount1):
        """A v4 position minted by the owner itself (MINT_POSITION, SETTLE_PAIR through Permit2), as the
        Uniswap app mints one: V2's root stays in the owner's wallet."""
        for currency, amount in zip(self.currencies, (amount0, amount1)):
            self.fund(currency, OWNER, amount)
            self.must(OWNER, currency, q.calldata('approve(address,uint256)', ['address', 'uint256'],
                                                  [PERMIT2, 2**256 - 1]), what='approve Permit2')
            self.must(OWNER, PERMIT2, q.calldata('approve(address,address,uint160,uint48)',
                      ['address', 'address', 'uint160', 'uint48'], [currency, POSITION_MANAGER, 2**160 - 1, 2**48 - 1]),
                      what='Permit2 allowance')
        price = self.spot()[0]
        liquidity = liquidity_for_amounts(price, lower, upper, amount0 * 98 // 100, amount1 * 98 // 100)
        token = self.call(POSITION_MANAGER, 'nextTokenId()', ['uint256'])[0]
        mint = encode([KEY_TYPE, 'int24', 'int24', 'uint256', 'uint128', 'uint128', 'address', 'bytes'],
                      [self.key_tuple(), lower, upper, liquidity, amount0, amount1, OWNER, b''])
        settle = encode(['address', 'address'], list(self.currencies))
        unlock = encode(['bytes', 'bytes[]'], [bytes([MINT_POSITION, SETTLE_PAIR]), [mint, settle]])
        self.must(OWNER, POSITION_MANAGER, q.calldata('modifyLiquidities(bytes,uint256)', ['bytes', 'uint256'],
                  [unlock, self.now() + 600]), what='mint root')
        if self.liquidity(token) != liquidity:
            raise DataError('fork_root_liquidity_mismatch')
        return {'tokenId': token, 'tickLower': lower, 'tickUpper': upper, 'liquidity': str(liquidity)}

    def liquidity(self, token):
        return self.call(POSITION_MANAGER, 'getPositionLiquidity(uint256)', ['uint128'], ['uint256'], [token])[0]

    def create_vault(self, token, mode, max_positions, kind):
        factory = self.contracts['vaultFactory.v4']
        nonce = self.call(factory, 'nextNonce(address)', ['uint256'], ['address'], [OWNER])[0]
        predicted = self.call(factory, 'predictVault(address,uint256)', ['address'], ['address', 'uint256'],
                              [OWNER, nonce])[0].lower()
        self.must(OWNER, POSITION_MANAGER, q.calldata('approve(address,uint256)', ['address', 'uint256'],
                                                      [predicted, token]), what='approve the vault')
        init = ((4, POSITION_MANAGER, token), (mode, *POLICY, max_positions), LIMITS, False, True)
        self.measured(kind, OWNER, factory, q.calldata('createVault(' + INIT_TYPE + ',uint256)',
                                                       [INIT_TYPE, 'uint256'], [init, nonce]))
        if not self.call(predicted, 'rootArmed()', ['bool'])[0]:
            raise DataError('fork_vault_not_armed')
        return predicted

    def owed(self, root):
        """What the root is owed, from the pool's fee growth (StateView), as the vault will collect it."""
        pool_id = bytes.fromhex(self.pool_id[2:])
        salt = root['tokenId'].to_bytes(32, 'big')
        _, last0, last1 = self.call(STATE_VIEW, 'getPositionInfo(bytes32,address,int24,int24,bytes32)',
                                    ['uint128', 'uint256', 'uint256'], ['bytes32', 'address', 'int24', 'int24', 'bytes32'],
                                    [pool_id, POSITION_MANAGER, root['tickLower'], root['tickUpper'], salt])
        now0, now1 = self.call(STATE_VIEW, 'getFeeGrowthInside(bytes32,int24,int24)', ['uint256', 'uint256'],
                               ['bytes32', 'int24', 'int24'], [pool_id, root['tickLower'], root['tickUpper']])
        held = self.liquidity(root['tokenId'])
        return ((now0 - last0) % 2**256) * held >> 128, ((now1 - last1) % 2**256) * held >> 128

    # ---------------------------------------------------------------- plans
    def evidence(self):
        """The publisher's observation of the child's spot, signed now, as F1a's anchor reads it."""
        self.nonce += 1
        observed = self.now()
        return self.signer.sign(PriceObservation(self.pool, self.spot()[0], observed, observed + 120,
                                                 self.nonce)).evidence()

    def plan(self, vault, target, *, action=ACTION_COMPOUND, swap=Swap(), ticks=(0, 0)):
        nonce = self.call(vault, 'stateNonce()', ['uint64'])[0]
        return PlanV1(action=action, state_nonce=nonce, deadline=self.now() + 600, target=target,
                      amount0_max=U128, amount1_max=U128, min_liquidity=1, collect=(target,),
                      budgets=(Budget(target, U128, U128),), anchor_evidence=self.evidence(), swap=swap,
                      tick_lower=ticks[0], tick_upper=ticks[1])

    def execute(self, kind, vault, plan, **extra):
        nonce = plan.state_nonce
        self.measured(kind, OPERATOR, vault, execute_calldata(plan.encode()), **extra)
        if self.call(vault, 'stateNonce()', ['uint64'])[0] <= nonce:
            raise DataError('fork_execution_without_effect:' + kind)


def run(args):
    started = time.time()
    report = {'tool': 'measure_v2_costs', 'chainId': CHAIN_ID, 'pool': 'weth-usdg',
              'poolId': q.POOLS['weth-usdg'][0], 'rounds': args.rounds, 'rootWidthTicks': args.width,
              'roots': {'currency0': args.root0, 'currency1': args.root1},
              'basis': 'Anvil receipts on a DepositFork child of Robinhood (cancun), as GAS_UNITS_V1_2026-09-22',
              'startedAt': datetime.now(timezone.utc).isoformat(timespec='seconds')}
    source = q.Loopback(args.source_url)
    if source.request('eth_chainId') != hex(CHAIN_ID):
        raise DataError('fork_source_chain_mismatch')
    block = source.request('eth_getBlockByNumber', ['latest', False])
    report['source'] = {'upstream': 'loopback source (the own node)', **{k: block[k] for k in ('number', 'hash',
                                                                                              'timestamp')}}
    try:
        measure(args, source, block, report, started)
    except Exception as error:
        report['error'] = f'{type(error).__name__}: {error}'
        raise
    finally:
        with open(args.output, 'x') as handle:
            json.dump(report, handle, indent=1)
    return report


def measure(args, source, block, report, started):
    with V2Fork(source, block=block, total_seconds=1800, max_requests=60_000) as fork:
        report['anvilVersion'] = fork.version
        x = V2Experiment(fork, source, args.root)
        report['transactions'] = x.transactions
        report['stack'] = x.deploy_v2()
        report['artifacts'] = {'v2': x.v2_provenance, 'fixtures': x.artifact_provenance['artifacts']}
        x.fund_driver(10**24, 0)
        price, tick = x.spot()
        spacing = x.key.tick_spacing
        down = lambda value: value // spacing * spacing  # noqa: E731
        up = lambda value: -((-value) // spacing) * spacing  # noqa: E731
        report['spotAtOpen'] = {'tick': tick, 'sqrtPriceX96': str(price)}
        # The compounding root, as V1's study opened its own; the Domino root as IntegrationWorld's
        # successor journey places it (its ceiling 120 ticks above the spot).
        simple = x.mint_root(down(tick - args.width), up(tick + args.width), int(args.root0), int(args.root1))
        domino = x.mint_root(down(tick - 600), up(tick + 120), int(args.root0), int(args.root1))
        report['roots'].update({'simple': simple, 'domino': domino})
        vault = x.create_vault(simple['tokenId'], MODE_SIMPLE, 1, 'create_vault')
        domino_vault = x.create_vault(domino['tokenId'], MODE_DOMINO, 3, 'create_vault_domino')
        report['vaults'] = {'simple': vault, 'domino': domino_vault}
        leg = x.amount_for_move(20)
        x.earn_fees(args.rounds, leg)
        x.advance(2)
        report['fees'] = {'legCurrency0': str(leg), 'owedAfterFirstRounds': [str(v) for v in x.owed(simple)]}

        # 1. A compound with no swap: the root's own fees back into it.
        before = x.liquidity(simple['tokenId'])
        x.execute('compound', vault, x.plan(vault, simple['tokenId']))
        added = x.liquidity(simple['tokenId']) - before
        if added <= 0:
            raise DataError('fork_compound_added_nothing')
        x.transactions[-1]['liquidityAdded'] = str(added)

        # 2. A compound with a swap: forty more round trips, the interval, then 40% of the root's WETH
        # fees sold through the pool itself, at least the floor the vault computes from the anchor.
        x.earn_fees(args.rounds, leg)
        x.advance(601)
        owed0, owed1 = x.owed(simple)
        amount_in = owed0 * 40 // 100
        spot = x.spot()[0]
        floor = minimum_output(amount_in, spot, True, LP_FEE_PIPS, SLIPPAGE_BPS)
        swap = Swap(simple['tokenId'], True, amount_in, floor, (pool_leg(x.pool, True, amount_in, 1),))
        before = x.liquidity(simple['tokenId'])
        x.execute('compound_swap', vault, x.plan(vault, simple['tokenId'], swap=swap),
                  owed=[str(owed0), str(owed1)], swapIn=str(amount_in), swapFloor=str(floor))
        added = x.liquidity(simple['tokenId']) - before
        if added <= 0:
            raise DataError('fork_swap_compound_added_nothing')
        x.transactions[-1]['liquidityAdded'] = str(added)

        # 3. A Domino successor, minted from the Domino root's fees above its ceiling.
        successor = successor_range(domino['tickUpper'], spacing, x.spot()[0], LIMITS[3])
        child = x.call(POSITION_MANAGER, 'nextTokenId()', ['uint256'])[0]
        x.execute('successor_mint', domino_vault, x.plan(domino_vault, domino['tokenId'], action=ACTION_MINT,
                                                          ticks=successor), successorTicks=list(successor))
        holder = x.call(POSITION_MANAGER, 'ownerOf(uint256)', ['address'], ['uint256'], [child])[0].lower()
        if holder != domino_vault or x.liquidity(child) == 0:
            raise DataError('fork_successor_not_minted')
        report['successor'] = {'tokenId': child, 'ticks': list(successor), 'liquidity': str(x.liquidity(child))}

        # 4. The owner leaves: exitAll returns the successor and every reserve.
        x.measured('owner_exit_all', OWNER, domino_vault, q.calldata('exitAll()'))

        report['durationSeconds'] = round(time.time() - started)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--source-url', required=True, help='loopback JSON-RPC of the own node, e.g. an SSH tunnel')
    parser.add_argument('--root', default=os.environ.get('DOMINO_COMPOUND_EVM_ROOT', str(ROOT)),
                        help='checkout whose contracts/out holds the artifacts')
    parser.add_argument('--rounds', type=int, default=40)
    parser.add_argument('--root0', default='2000000000000000000', help='root deposit of currency0 (WETH), raw')
    parser.add_argument('--root1', default='8000000000', help='root deposit of currency1 (USDG), raw')
    parser.add_argument('--width', type=int, default=200, help='compounding root half-width, ticks')
    parser.add_argument('--output', required=True, type=Path)
    report = run(parser.parse_args(argv))
    for entry in report['transactions']:
        print(f"{entry['kind']:22} {entry['gasUsed']:>10,} gas  {entry['calldataBytes']:>6,} B calldata")
    return 0


if __name__ == '__main__':
    sys.exit(main())
