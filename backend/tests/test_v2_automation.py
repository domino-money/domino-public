"""The V2 automation service's configuration and command line, its return of a closed vault's reserves, and what a
paused vault costs a pass."""
import contextlib
import copy
from dataclasses import replace
import io
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from eth_abi import encode
from eth_hash.auto import keccak

from discovery import DataError, parse_block
from v2_abi import function
import v2_automation as automation
from v2_automation import ChainAutomation, build, checked_config, load_automation_config, main
from v2_chains import chain as profile
from v2_executor import CallReverted
from v2_manifest import checked_deployment
from v2_observation import PublisherPolicy
from v2_plan import return_reserves_calldata, return_subject
from v2_planner import PlannerConfig
from v2_rpc import ChainEndpoints, Endpoint
from v2_uniswap import PoolRef, UniswapReader, v3_pool_address
from v2_vaults import VaultRecord
from v2_fixtures import HEAD, FakeChain, Revert
from test_v2_manifest import manifest_document
from test_v2_planner import RICH, member, vault_state
from test_v2_planner_domino import domino_vault
from v2_domino import full_range

OPERATOR, PUBLISHER = '0x' + '04' * 20, '0x' + '05' * 20


def document(**changes):
    config = {
        'schemaVersion': 1, 'kind': 'domino-v2-automation', 'chain': 'base-8453',
        'deploymentFile': '/etc/domino/v2/base-8453/deployment.json',
        'rpc': {'chainRpcFile': '/etc/domino/v2/chain-rpc.json'},
        'headFile': '/run/domino-v2/base-8453.head.json',
        'journalFile': '/var/lib/domino-v2-automation/base-8453/journal.sqlite',
        'operator': {'address': OPERATOR, 'keystoreFile': '/etc/domino/v2/automation/operator.keystore.json',
                     'credential': 'v2-operator-keystore-password'},
        'publisher': {'address': PUBLISHER, 'keystoreFile': '/etc/domino/v2/automation/publisher.keystore.json',
                      'credential': 'v2-publisher-keystore-password'},
        'gas': {'maxGas': 3_000_000, 'maxFeePerGas': 2 * 10**9, 'priorityFeePerGas': 10**6,
                'maxCostWei': 3 * 10**15, 'dailyCapWei': 5 * 10**16, 'minBalanceWei': 10**16, 'confirmations': 3,
                'enabled': False},
        'planner': {'deadlineSeconds': 120, 'ownerHorizonSeconds': 604800, 'forecastHaircutBps': 2000},
        'observations': {'validitySeconds': 120, 'lookbackSeconds': [12, 60], 'maxDeviationBps': 50},
        'priceReferences': [{'token': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                             'pool': {'dex': 3, 'currency0': '0x4200000000000000000000000000000000000006',
                                      'currency1': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', 'fee': 500,
                                      'tickSpacing': 10, 'hooks': '0x' + '00' * 20}}],
        'earningsWindowSeconds': 3600, 'twapSeconds': 600, 'exitTwapSeconds': 600, 'deadlineSeconds': 120,
        'passSeconds': 10, 'headMaxAgeSeconds': 2, 'autoExit': True,
        # The owner's decisions of 2 Oct 2026.
        'vaultDefaults': {'mode': None,
                          'policy': {'triggerDistanceBps': 500, 'maxOverlapBps': 2000, 'minimumIntervalSeconds': 600,
                                     'maxPositions': 3},
                          'limits': {'maxSlippageBps': 100, 'maxPriceImpactBps': 100, 'maxObservationAgeSeconds': 300,
                                     'upsideBps': 5000},
                          'startPaused': False,
                          'ownerMaxima': {'maxSlippageBps': 500, 'maxPriceImpactBps': 500},
                          'exitMaxSlippageBps': 100},
        'vaultGasCeilingWei': None,
        'vaultGasCeilingsWei': {'0x' + 'cA' * 20: 10**15},
        'waitingFile': '/run/domino-v2/base-8453.waiting.json',
    }
    config.update(changes)
    return config


class ConfigTests(unittest.TestCase):
    def test_a_complete_configuration_loads(self):
        config = checked_config(document())
        self.assertEqual(config.chain.key, 'base-8453')
        self.assertEqual((config.operator.address, config.publisher.credential),
                         (OPERATOR, 'v2-publisher-keystore-password'))
        self.assertEqual((config.gas.max_gas, config.gas.enabled, config.gas.replace_after_seconds), (3_000_000, False, 60))
        self.assertEqual((config.planner.owner_horizon_seconds, config.planner.gas_buffer_bps), (604800, 1500))
        self.assertEqual(config.observations.lookback_seconds, (12, 60))
        self.assertEqual(config.price_references[0].token, '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
        defaults = config.vault_defaults
        self.assertEqual((defaults.mode, defaults.start_paused, defaults.policy['minimumIntervalSeconds']),
                         (None, False, 600))
        self.assertEqual((defaults.limits['maxSlippageBps'], defaults.owner_maxima['maxSlippageBps'],
                          defaults.exit_max_slippage_bps), (100, 500, 100))
        self.assertEqual(config.vault_gas_ceiling_wei, None)
        self.assertEqual(config.vault_gas_ceilings_wei, {'0x' + 'ca' * 20: 10**15})
        self.assertEqual(config.waiting_file, '/run/domino-v2/base-8453.waiting.json')
        self.assertEqual(checked_config(document(vaultGasCeilingWei=2 * 10**15)).vault_gas_ceiling_wei, 2 * 10**15)
        self.assertEqual(checked_config(document(waitingFile=None)).waiting_file, None)

    def test_each_rule_refuses_the_whole_configuration(self):
        def variant(change):
            config = copy.deepcopy(document())
            change(config)
            return config
        cases = {
            'an extra key': lambda c: c.update(extra=1),
            'another kind': lambda c: c.update(kind='domino-automation'),
            'an unknown chain': lambda c: c.update(chain='optimism-10'),
            'robinhood from the v2 file': lambda c: c.update(chain='robinhood-4663'),
            'base from the provider file': lambda c: c.update(rpc={'providerFile': '/etc/domino/providers.json'}),
            'one key for both roles': lambda c: c['publisher'].update(address=OPERATOR),
            'one credential for both keys': lambda c: c['publisher'].update(credential='v2-operator-keystore-password'),
            'a relative path': lambda c: c.update(journalFile='journal.sqlite'),
            'a path that climbs': lambda c: c.update(headFile='/run/../etc/head.json'),
            'an unknown planner field': lambda c: c['planner'].update(horizon=1),
            'a gas policy above its cap': lambda c: c['gas'].update(maxCostWei=10**17),
            'a gas policy without a cap': lambda c: c['gas'].pop('dailyCapWei'),
            'a simple default with successors': lambda c: c['vaultDefaults'].update(mode=1),
            'a mode that is no mode': lambda c: c['vaultDefaults'].update(mode=3),
            'a trigger above the contract bound': lambda c: c['vaultDefaults']['policy'].update(triggerDistanceBps=2001),
            'no interval at all': lambda c: c['vaultDefaults']['policy'].update(minimumIntervalSeconds=0),
            'an interval below the vault floor': lambda c: c['vaultDefaults']['policy'].update(minimumIntervalSeconds=599),
            'a slippage maximum above the vault ceiling': lambda c: c['vaultDefaults']['ownerMaxima'].update(maxSlippageBps=1001),
            'a band maximum above the vault ceiling': lambda c: c['vaultDefaults']['ownerMaxima'].update(maxPriceImpactBps=501),
            'an observation age above the vault ceiling':
                lambda c: c['vaultDefaults']['limits'].update(maxObservationAgeSeconds=301),
            'a default above its maximum': lambda c: c['vaultDefaults']['limits'].update(maxSlippageBps=600),
            'a maximum of 100%': lambda c: c['vaultDefaults']['ownerMaxima'].update(maxPriceImpactBps=10_000),
            'no observation age': lambda c: c['vaultDefaults']['limits'].update(maxObservationAgeSeconds=0),
            'an exit slippage above the module': lambda c: c['vaultDefaults'].update(exitMaxSlippageBps=1001),
            'an exit TWAP above the module\'s hour': lambda c: c.update(exitTwapSeconds=3601),
            'a zero gas ceiling': lambda c: c.update(vaultGasCeilingWei=0),
            'a relative waiting file': lambda c: c.update(waitingFile='waiting.json'),
            'a ceiling for no address': lambda c: c.update(vaultGasCeilingsWei={'vault': 1}),
            'a string interval': lambda c: c.update(passSeconds='10'),
            'a reference that is no pool': lambda c: c['priceReferences'][0].update(pool={}),
        }
        for label, change in cases.items():
            with self.subTest(label), self.assertRaises(DataError):
                checked_config(variant(change))

    def test_robinhood_reads_the_read_paths_provider_file(self):
        config = checked_config(document(chain='robinhood-4663', rpc={'providerFile': '/etc/domino/providers.json'},
                                         priceReferences=[]))
        self.assertEqual(config.rpc, {'providerFile': '/etc/domino/providers.json'})

    def test_the_file_must_be_private(self):
        directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, directory)
        os.chmod(directory, 0o700)
        path = directory / 'automation.json'
        path.write_text(json.dumps(document()))
        os.chmod(path, 0o600)
        self.assertEqual(load_automation_config(str(path)).chain.chainId, 8453)
        os.chmod(path, 0o644)
        with self.assertRaises(Exception):
            load_automation_config(str(path))

    def test_the_keys_must_be_the_manifests_operator_and_publisher(self):
        directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, directory)
        os.chmod(directory, 0o700)
        manifest = manifest_document()
        manifest['roles'].update(operator=OPERATOR, publisher=PUBLISHER)
        (directory / 'deployment.json').write_text(json.dumps(manifest))
        other = '0x' + '06' * 20

        def config(role=None):
            changes = {'deploymentFile': str(directory / 'deployment.json'),
                       'rpc': {'chainRpcFile': str(directory / 'absent.json')}}
            if role:
                changes[role] = {**document()[role], 'address': other}
            return checked_config(document(**changes))
        for role in ('operator', 'publisher'):
            with self.subTest(role), self.assertRaisesRegex(DataError, '^v2_signer_not_in_deployment$'):
                build(config(role))
        # The manifest's own keys pass, and so does any key when none is loaded (status, plan): the
        # next step is the chain's RPC file.
        for service, keys in ((config(), True), (config('operator'), False)):
            with self.assertRaisesRegex(DataError, '^v2_chain_rpc_config_unreadable$'):
                build(service, keys=keys)

    def test_where_the_scans_stopped_is_kept_beside_the_journal(self):
        # Every operation builds the service with it, status and plan included, so no fresh process starts the log
        # scans over from the deployment block (each pass's budget stops reading long before the head).
        directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, directory)
        os.chmod(directory, 0o700)
        (directory / 'deployment.json').write_text(json.dumps(manifest_document()))
        config = checked_config(document(**{'deploymentFile': str(directory / 'deployment.json'),
                                            'rpc': {'chainRpcFile': str(directory / 'rpc.json')},
                                            'journalFile': str(directory / 'journal.sqlite')}))
        with patch.object(automation, 'load_chain_rpc_config', return_value={}), \
                patch.object(automation, 'configured_endpoints', return_value=None), \
                patch.object(automation, 'HeadFollower', return_value=None):
            service = build(config, keys=False)
        self.assertIs(service.discovery.state, service.mandates.state)
        self.assertEqual(service.discovery.state.path, directory / 'v2-scans-base-8453.json')

    def test_the_command_line_prints_a_fixed_code_and_never_a_value(self):
        directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, directory)
        os.chmod(directory, 0o700)
        path = directory / 'automation.json'
        broken = document()
        broken['gas']['maxCostWei'] = 'SYNTHETIC_SECRET'
        path.write_text(json.dumps(broken))
        os.chmod(path, 0o600)
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            status = main(['--config', str(path), 'plan'])
        self.assertEqual(status, 1)
        self.assertEqual(json.loads(out.getvalue()), {'error': 'v2_invalid_gas_policy'})
        self.assertNotIn('SYNTHETIC', out.getvalue())


class ReturnTests(unittest.TestCase):
    """The pass's return of a closed vault's reserves (ChainAutomation._return):
    what it reads, what it presimulates and what it hands the executor."""

    BLOCK = parse_block({'number': '0x64', 'hash': '0x' + 'ab' * 32, 'timestamp': '0x6500'})
    PAID = '0x' + encode(['uint256', 'uint256'], [1000, 3]).hex()

    class Executor:
        def __init__(self, result):
            self.result, self.calls = result, []
            self.policy = type('Policy', (), {'priority_fee_per_gas': 10**6})()

        def presimulate(self, target, data, head, *, output=False):
            self.calls.append((target, data, head, output))
            if isinstance(self.result, CallReverted):
                raise self.result
            return 480_000, 400_000, self.result

    class Reader:
        def __init__(self, reserves):
            self.amounts, self.reads = reserves, 0

        def reserves(self, vault, block):
            self.reads += 1
            return self.amounts

    class Rpc:
        call_gas_limit = 10**7

        def request(self, method, params):  # the OP Stack L1 fee bound, 1 gwei
            return '0x' + encode(['uint256'], [10**9]).hex()

    def service(self, executor, **changes):
        base = profile('base-8453')
        options = dict(chain=base, deployment=checked_deployment(manifest_document(), base), endpoints=None,
                       follower=None, planner=PlannerConfig(), observations=PublisherPolicy(), price_references=(),
                       earnings_window_seconds=600, twap_seconds=600, exit_twap_seconds=600, deadline_seconds=120,
                       executor=executor)
        options.update(changes)
        return ChainAutomation(**options)

    def returned(self, executor, reserves=(1000, 3), **changes):
        head = type('Head', (), {'block': self.BLOCK, 'base_fee_per_gas': 10**8})()
        vault = vault_state(member(liquidity=0), root_armed=False)
        return self.service(executor, **changes)._return(vault, self.Reader(reserves), self.Rpc(), head), vault

    def test_a_closed_vault_with_reserves_gets_one_presimulated_call(self):
        executor = self.Executor(self.PAID)
        entry, vault = self.returned(executor)
        self.assertEqual({k: entry[k] for k in ('act', 'reason', 'action', 'simulation', 'reserves', 'paid')},
                         {'act': True, 'reason': 'reserves_returnable', 'action': 'return_reserves',
                          'simulation': 'passed', 'reserves': ['1000', '3'], 'paid': ['1000', '3']})
        self.assertEqual(entry['plan'], {'calldata': return_reserves_calldata(),
                                         'deadline': self.BLOCK.timestamp + 120, 'gas': 480_000})
        self.assertEqual(entry['subject'], return_subject(8453, vault.vault, vault.state_nonce, self.BLOCK.number))
        self.assertEqual(executor.calls, [(vault.vault, return_reserves_calldata(), self.BLOCK, True)])

    def test_nothing_to_return_leaves_the_vault_to_the_planner(self):
        executor = self.Executor(self.PAID)
        entry, _ = self.returned(executor, reserves=(0, 0))
        self.assertIsNone(entry)
        self.assertEqual(executor.calls, [])

    def test_an_empty_closed_vault_is_read_again_only_once_its_state_moves(self):
        # Every change to a vault's reserves advances its state nonce.
        service = self.service(self.Executor(self.PAID))
        head = type('Head', (), {'block': self.BLOCK, 'base_fee_per_gas': 10**8})()
        vault, reader = vault_state(member(liquidity=0), root_armed=False), self.Reader((0, 0))
        self.assertIsNone(service._return(vault, reader, self.Rpc(), head))
        self.assertIsNone(service._return(vault, reader, self.Rpc(), head))
        self.assertEqual(reader.reads, 1)
        reader.amounts = (1000, 3)
        self.assertIsNone(service._return(vault, reader, self.Rpc(), head))
        moved = service._return(replace(vault, state_nonce=vault.state_nonce + 1), reader, self.Rpc(), head)
        self.assertEqual((reader.reads, moved['reason']), (2, 'reserves_returnable'))

    def test_the_registrys_halt_holds_it_and_a_pause_does_not(self):
        executor = self.Executor(self.PAID)
        head = type('Head', (), {'block': self.BLOCK, 'base_fee_per_gas': 10**8})()
        closed = vault_state(member(liquidity=0), root_armed=False)
        service = self.service(executor)
        self.assertIsNone(service._return(replace(closed, halted=True), self.Reader((1000, 3)), self.Rpc(), head))
        self.assertEqual(executor.calls, [])
        entry = service._return(replace(closed, paused=True), self.Reader((1000, 3)), self.Rpc(), head)
        self.assertEqual((entry['act'], entry['reason']), (True, 'reserves_returnable'))

    def test_a_return_that_would_pay_nothing_is_not_sent(self):
        # Every reserve is in a token the owner cannot receive (A8): it would stay idle.
        entry, _ = self.returned(self.Executor('0x' + encode(['uint256', 'uint256'], [0, 0]).hex()))
        self.assertEqual((entry['act'], entry['reason'], entry['simulation']), (False, 'reserves_unpayable', 'passed'))
        self.assertNotIn('plan', entry)

    def test_the_contracts_refusal_reaches_the_pass(self):
        refusal = CallReverted('0x' + keccak(b'RootOpen()')[:4].hex())
        with self.assertRaisesRegex(CallReverted, '^reverted_root_open$'):
            self.returned(self.Executor(refusal))

    def test_without_keys_it_is_reported_and_never_simulated(self):
        entry, _ = self.returned(None)
        self.assertEqual((entry['act'], entry['reason'], entry['action']),
                         (True, 'eligible_keyless', 'return_reserves'))
        self.assertNotIn('plan', entry)

    def test_the_vaults_gas_ceiling_holds(self):
        # 400,000 gas at 1.01e8 plus the 1 gwei L1 bound: 4.04e13 + 1e9 wei.
        entry, _ = self.returned(self.Executor(self.PAID), vault_gas_ceiling_wei=4 * 10**13)
        self.assertEqual((entry['act'], entry['reason']), (False, 'vault_gas_ceiling'))
        entry, _ = self.returned(self.Executor(self.PAID), vault_gas_ceiling_wei=4 * 10**13,
                                 vault_gas_ceilings_wei={'0x' + 'aa' * 20: 5 * 10**13})
        self.assertEqual((entry['act'], entry['reason']), (True, 'reserves_returnable'))


class MintPassTests(unittest.TestCase):
    """The pass's MINT of a Domino vault's successor (ChainAutomation._compound): the owner gate's evidence is the
    pool's fee growth over the whole price range, read once, and the report names the action and the range."""

    def test_a_domino_vault_near_its_ceiling_asks_the_whole_range_and_reports_its_mint(self):
        vault = domino_vault()  # root [-6000, 6000), the anchor at tick 5800 (spacing 60)
        base = profile('base-8453')
        service = ChainAutomation(chain=base, deployment=checked_deployment(manifest_document(), base),
                                  endpoints=None, follower=None, planner=PlannerConfig(),
                                  observations=PublisherPolicy(), price_references=(), earnings_window_seconds=600,
                                  twap_seconds=600, exit_twap_seconds=600, deadline_seconds=120, executor=None)
        service._pass = {'references': None, 'growth': {}, 'min_twap': None}
        asked = []

        def range_growth(state, rpc, history, block, lower, upper):
            asked.append((lower, upper))
            return RICH

        class Reader:
            def __init__(self, *args, **kwargs):
                pass

            def read(self, record, block):
                return vault
        block = parse_block({'number': '0x64', 'hash': '0x' + 'ab' * 32, 'timestamp': hex(vault.block_timestamp)})
        head = type('Head', (), {'block': block, 'base_fee_per_gas': 1})()
        record = type('Record', (), {'vault': vault.vault, 'dex': 4})()
        with patch.object(automation, 'VaultReader', Reader), \
                patch.object(service, '_range_growth', side_effect=range_growth):
            result = service._compound(record, head, None, None, None, None)
        self.assertEqual(asked, [full_range(60)])
        self.assertEqual((result['act'], result['reason'], result['action'], result['successor']),
                         (True, 'eligible_keyless', 'mint', [5760, 10080]))
        self.assertEqual(result['considered'][f'{vault.root_token_id}:all'], 'awaiting_successor')


# --------------------------------------------------------------------------- a pass's reads, counted
BASE = profile('base-8453')
TOKEN_A, TOKEN_B, ZERO = '0x' + '1a' * 20, '0x' + '2b' * 20, '0x' + '00' * 20


def selector(name):
    return '0x' + keccak(name.encode())[:4].hex()


class PassChain:
    """Vaults, their members' positions and their pool on a fake Base, with everything a pass reads about them
    through the frozen ABIs: the full read's views, the pause check, the reserves, the registry's halt, and the
    positions on the vaults' Uniswap version (v3 or v4). A pass's cost is the endpoints' own meter of billed calls
    (each call of a batch counted, as providers bill them), and past a pass's budget the fake fails the test instead
    of answering."""

    OWNER = '0x' + 'b0' * 20

    def __init__(self, dex):
        self.dex = dex
        self.head = type('Head', (), {'block': parse_block(HEAD), 'base_fee_per_gas': 10**8})()
        self.fake = FakeChain(8453)
        endpoint = Endpoint('stack', 'stack.example.invalid', 'https://stack.example.invalid/', None, 100, None, None)
        self.endpoints = ChainEndpoints(BASE, (endpoint,), 'v2_chain_rpc_file', send=self.fake)
        uniswap = BASE.uniswap
        for contract in (uniswap.v3.factory, uniswap.v3.positionManager, uniswap.v4.positionManager,
                         uniswap.v4.stateView):
            # Proven by the process's first pass: what a later pass costs is what is counted.
            self.endpoints.code.record(contract, BASE.verified_codehash(contract), 0)
        self.deployment = checked_deployment(manifest_document(), BASE)
        self.pool = PoolRef(dex, TOKEN_A, TOKEN_B, 3000, 60)
        self.manager = uniswap.v4.positionManager if dex == 4 else uniswap.v3.positionManager
        self.ranges, self.liquidity = {}, {}  # by token id; a burned token has no liquidity entry
        self.halted = False
        self.fake.on(self.deployment.registry, function('IDominoRegistry', 'automationHalted'), lambda: (self.halted,))
        (self._v4 if dex == 4 else self._v3)()

    def _v4(self):
        on, pool = self.fake.on, self.pool
        manager, view = BASE.uniswap.v4.positionManager, BASE.uniswap.v4.stateView
        key = (pool.currency0, pool.currency1, pool.fee, pool.tick_spacing, pool.hooks)

        def info(token_id):
            if token_id not in self.liquidity:
                return ((ZERO, ZERO, 0, 0, ZERO), 0)  # Uniswap clears a burned token's info
            lower, upper = self.ranges[token_id]
            return key, (int(pool.pool_id, 16) >> 56) << 56 | (upper & 0xffffff) << 32 | (lower & 0xffffff) << 8
        on(manager, function('IV4PositionManagerMinimal', 'getPoolAndPositionInfo'), info)
        on(manager, function('IV4PositionManagerMinimal', 'ownerOf'), lambda token_id: (self.OWNER,))
        on(manager, function('IV4PositionManagerMinimal', 'getApproved'), lambda token_id: (ZERO,))
        on(manager, function('IV4PositionManagerMinimal', 'subscriber'), lambda token_id: (ZERO,))
        on(manager, function('IV4PositionManagerMinimal', 'getPositionLiquidity'),
           lambda token_id: (self.liquidity.get(token_id, 0),))
        on(view, function('IV4StateViewMinimal', 'getSlot0'), lambda pool_id: (2**96, 0, 0, 3000))
        on(view, function('IV4StateViewMinimal', 'getLiquidity'), lambda pool_id: (4 * 10**18,))
        on(view, function('IV4StateViewMinimal', 'getPositionInfo'),
           lambda pool_id, owner, lower, upper, salt: (self.liquidity.get(int.from_bytes(salt, 'big'), 0), 0, 0))
        on(view, function('IV4StateViewMinimal', 'getFeeGrowthInside'), lambda pool_id, lower, upper: (0, 0))

    def _v3(self):
        on, pool = self.fake.on, self.pool
        manager, factory = BASE.uniswap.v3.positionManager, BASE.uniswap.v3.factory
        address = v3_pool_address(BASE, pool.currency0, pool.currency1, pool.fee)

        def positions(token_id):
            if token_id not in self.liquidity:
                raise Revert()  # the manager's 'Invalid token ID'
            lower, upper = self.ranges[token_id]
            return (0, ZERO, pool.currency0, pool.currency1, pool.fee, lower, upper, self.liquidity[token_id],
                    0, 0, 0, 0)
        on(manager, function('IUniswapV3PositionManagerMinimal', 'positions'), positions)
        on(manager, function('IUniswapV3PositionManagerMinimal', 'ownerOf'), lambda token_id: (self.OWNER,))
        on(factory, function('IUniswapV3FactoryMinimal', 'getPool'), lambda a, b, fee: (address,))
        on(factory, function('IUniswapV3FactoryMinimal', 'feeAmountTickSpacing'), lambda fee: (60,))
        on(address, function('IUniswapV3PoolMinimal', 'slot0'), lambda: (2**96, 0, 0, 1, 1, 0, True))
        on(address, function('IUniswapV3PoolMinimal', 'liquidity'), lambda: (3 * 10**18,))
        on(address, function('IUniswapV3PoolMinimal', 'feeGrowthGlobal0X128'), lambda: (0,))
        on(address, function('IUniswapV3PoolMinimal', 'feeGrowthGlobal1X128'), lambda: (0,))
        on(address, function('IUniswapV3PoolMinimal', 'ticks'), lambda tick: (1, 0, 0, 0, 0, 0, 0, True))

    def vault(self, address, root):
        return FakeVault(self, address, root)

    def service(self, *vaults, executor=None):
        service = ChainAutomation(chain=BASE, deployment=self.deployment, endpoints=self.endpoints, follower=None,
                                  planner=PlannerConfig(), observations=PublisherPolicy(), price_references=(),
                                  earnings_window_seconds=600, twap_seconds=600, exit_twap_seconds=600,
                                  deadline_seconds=120, executor=executor)
        service.proven.update((vault.address, self.dex) for vault in vaults)  # once a process, on its first pass
        return service

    def run(self, service, vaults, budget):
        """One pass over `vaults`, in discovery order: their entries and the billed calls the pass cost. A call past
        `budget` fails the test."""
        service._pass = {'references': None, 'growth': {}, 'min_twap': None, 'oracles': {}, 'halted': None}
        rpc = self.endpoints.read_rpc(anchor=self.head.block, batch_reads=True, max_requests=600)
        uniswap = UniswapReader(BASE, rpc)
        before = sum(self.endpoints.calls().values())
        self.fake.budget = len(self.fake.log) + budget
        try:
            entries = [service._compound(vault.record, self.head, rpc, uniswap, None, None) for vault in vaults]
        finally:
            self.fake.budget = None
        return entries, sum(self.endpoints.calls().values()) - before

    def asked(self, count):
        """The selectors of the last `count` calls."""
        return [params[0]['data'][:10] for _, _, params in self.fake.log[-count:]]


class FakeVault:
    """One vault as the chain holds it: created paused, its root alone, no reserves; tests change it between
    passes (and move its state nonce whenever the contract would)."""

    def __init__(self, chain, address, root):
        self.chain, self.address, self.root = chain, address, root
        self.paused, self.nonce, self.last, self.reserves, self.members = True, 9, 0, (0, 0), [root]
        chain.ranges[root], chain.liquidity[root] = (-600, 600), 10**18
        pool, on = chain.pool, chain.fake.on
        raw = (pool.dex, pool.currency0, pool.currency1, pool.fee, pool.tick_spacing, pool.hooks)
        views = {'owner': lambda: (PassChain.OWNER,), 'pool': lambda: (raw,),
                 'root': lambda: ((chain.dex, chain.manager, root),), 'positions': lambda: (list(self.members),),
                 'policy': lambda: ((2, 500, 2000, 600, 3),), 'limits': lambda: ((100, 100, 300, 5000),),
                 'paused': lambda: (self.paused,), 'rootArmed': lambda: (True,), 'stateNonce': lambda: (self.nonce,)}
        for name, view in views.items():
            on(address, function('IDominoVault', name), view)
        on(address, function('IDominoVault', 'reserves'),
           lambda token: (self.reserves[(pool.currency0, pool.currency1).index(token)],))
        on(address, function('IDominoVaultLedger', 'lastExecutionAt'), lambda: (self.last,))
        on(address, function('IDominoVaultLedger', 'quoteCurrency'), lambda: (pool.currency1,))
        on(address, function('IDominoVaultLedger', 'member'), self.member)
        on(address, function('IDominoVaultLedger', 'lot'), lambda token_id, token: ((0, 0),))
        self.record = VaultRecord(address, PassChain.OWNER, root, chain.dex, 1)

    def member(self, token_id):
        lower, upper = self.chain.ranges[token_id]
        successor = next((m for m in self.members if m != self.root), 0) if token_id == self.root else 0
        return ((token_id in self.members, 0 if token_id == self.root else self.root, successor, lower, upper),)

    def mint_successor(self, token_id):
        self.chain.ranges[token_id], self.chain.liquidity[token_id] = (600, 1200), 10**18
        self.members.append(token_id)


class PausedVaultTests(unittest.TestCase):
    """A paused vault can do nothing but give its reserves back (returnReserves: its root closed, no successor
    active, reserves left). Once a full read found it paused, while it stays paused at that state nonce a pass reads
    only what decides that (ChainAutomation._held): its pause and nonce, the registry's halt once a pass, its reserves
    once a nonce, and its root's liquidity only while it is alone and holds reserves. Its entry is the full read's."""

    # One vault's full read with its root alone: 12 views, the member's 3 ledger rows, and its position (9 calls on
    # v4, 8 on v3). What every pass cost a paused vault before.
    FULL = {4: 24, 3: 23}
    PAUSE_CHECK = [selector('paused()'), selector('stateNonce()'), selector('automationHalted()')]

    def test_a_paused_vault_with_nothing_to_return_costs_its_pause_check_alone(self):
        for dex in (4, 3):
            with self.subTest(dex=dex):
                chain = PassChain(dex)
                vault = chain.vault('0x' + 'a4' * 20, 7)  # created paused for Auto-exit alone
                service = chain.service(vault)
                (first,), cost = chain.run(service, [vault], self.FULL[dex])
                self.assertEqual((first, cost), ({'act': False, 'reason': 'vault_paused', 'stateNonce': 9},
                                                 self.FULL[dex]))
                # Then its pause check, with its reserves once at this nonce: none, so its root is never read.
                (entry,), cost = chain.run(service, [vault], 3 + 2)
                self.assertEqual((entry, cost), (first, 5))
                for _ in range(3):
                    (entry,), cost = chain.run(service, [vault], 3)
                    # The same entry as the full read's: the waiting file, and the read API, see the same reason.
                    self.assertEqual((entry, cost), (first, 3))
                    self.assertEqual(chain.asked(3), self.PAUSE_CHECK)

    def test_the_registrys_halt_is_read_once_a_pass_and_holds_every_paused_vault(self):
        chain = PassChain(4)
        first, second = chain.vault('0x' + 'a4' * 20, 7), chain.vault('0x' + 'a5' * 20, 8)
        second.reserves = (1000, 3)  # what its compounds left before its owner paused it
        executor = ReturnTests.Executor(ReturnTests.PAID)
        service = chain.service(first, second, executor=executor)
        chain.run(service, [first, second], 2 * self.FULL[4])
        # The second vault holds reserves: its root is read on every pass, to return them once it closes.
        entries, cost = chain.run(service, [first, second], 3 + 2 + 2 + 2 + 1)
        self.assertEqual(([e['reason'] for e in entries], cost), (['vault_paused'] * 2, 10))
        entries, cost = chain.run(service, [first, second], 3 + 2 + 1)
        self.assertEqual(([e['reason'] for e in entries], cost), (['vault_paused'] * 2, 6))
        # Halted, both wait for the halt, and nothing more is read, not even the root a return would need.
        chain.halted, chain.liquidity[8] = True, 0
        entries, cost = chain.run(service, [first, second], 3 + 2)
        self.assertEqual(([e['reason'] for e in entries], cost), (['automation_halted'] * 2, 5))
        self.assertEqual(executor.calls, [])
        # Lifted, the closed root's reserves go back to its owner.
        chain.halted = False
        entries, cost = chain.run(service, [first, second], 3 + 2 + 1)
        self.assertEqual(([e['reason'] for e in entries], cost), (['vault_paused', 'reserves_returnable'], 6))

    def test_a_paused_vault_whose_owner_closes_the_root_still_returns_its_reserves(self):
        for dex, burned in ((4, False), (4, True), (3, False), (3, True)):
            with self.subTest(dex=dex, burned=burned):
                chain = PassChain(dex)
                vault = chain.vault('0x' + 'a4' * 20, 7)
                vault.reserves = (1000, 3)  # what its compounds left before its owner paused it
                executor = ReturnTests.Executor(ReturnTests.PAID)
                service = chain.service(vault, executor=executor)
                chain.run(service, [vault], self.FULL[dex])
                (entry,), cost = chain.run(service, [vault], 3 + 2 + 1)  # its reserves once, then its root
                self.assertEqual((entry['reason'], cost), ('vault_paused', 6))
                (entry,), cost = chain.run(service, [vault], 3 + 1)
                self.assertEqual((entry['reason'], cost), ('vault_paused', 4))
                self.assertEqual(executor.calls, [])  # an open root: no return is even simulated
                # The owner closes the root on Uniswap, and the vault's state nonce does not move: nothing tells a
                # v3 vault, nor a v4 vault whose root was already disarmed (exitAll, say).
                if burned:
                    del chain.liquidity[7]
                else:
                    chain.liquidity[7] = 0
                (entry,), cost = chain.run(service, [vault], 3 + 1)
                self.assertEqual({k: entry[k] for k in ('act', 'reason', 'action', 'simulation', 'reserves', 'paid',
                                                        'stateNonce')},
                                 {'act': True, 'reason': 'reserves_returnable', 'action': 'return_reserves',
                                  'simulation': 'passed', 'reserves': ['1000', '3'], 'paid': ['1000', '3'],
                                  'stateNonce': 9})
                self.assertEqual(entry['subject'], return_subject(8453, vault.address, 9, chain.head.block.number))
                self.assertEqual(entry['plan']['calldata'], return_reserves_calldata())
                self.assertEqual(executor.calls, [(vault.address, return_reserves_calldata(), chain.head.block, True)])
                self.assertEqual(cost, 4)

    def test_an_unpaused_vault_is_read_in_full_as_before(self):
        for dex in (4, 3):
            with self.subTest(dex=dex):
                chain = PassChain(dex)
                vault = chain.vault('0x' + 'a4' * 20, 7)
                vault.paused, vault.last = False, chain.head.block.timestamp - 10  # inside its interval
                service = chain.service(vault)
                for _ in range(3):
                    (entry,), cost = chain.run(service, [vault], self.FULL[dex])
                    self.assertEqual((entry, cost), ({'act': False, 'reason': 'too_soon', 'stateNonce': 9},
                                                     self.FULL[dex]))
                # Its owner pauses it: one more full read, then its pause check.
                vault.paused, vault.nonce = True, 10
                (entry,), cost = chain.run(service, [vault], self.FULL[dex])
                self.assertEqual((entry['reason'], cost), ('vault_paused', self.FULL[dex]))
                (entry,), cost = chain.run(service, [vault], 3 + 2)
                self.assertEqual((entry['reason'], cost), ('vault_paused', 5))
                # It resumes it: the pause check that finds out, a full read, and only full reads after.
                vault.paused, vault.nonce = False, 11
                (entry,), cost = chain.run(service, [vault], 3 + self.FULL[dex])
                self.assertEqual((entry['reason'], cost), ('too_soon', 3 + self.FULL[dex]))
                (entry,), cost = chain.run(service, [vault], self.FULL[dex])
                self.assertEqual((entry['reason'], cost), ('too_soon', self.FULL[dex]))

    def test_a_paused_vault_whose_state_moved_is_read_in_full(self):
        chain = PassChain(4)
        vault = chain.vault('0x' + 'a4' * 20, 7)
        vault.mint_successor(9)
        vault.reserves = (1000, 3)
        executor = ReturnTests.Executor(ReturnTests.PAID)
        service = chain.service(vault, executor=executor)
        chain.run(service, [vault], 12 + 2 * (3 + 9))  # two members
        chain.liquidity[7] = 0  # the owner closes the root
        # A successor is active: no return is possible, and nothing more is read.
        (entry,), cost = chain.run(service, [vault], 3)
        self.assertEqual((entry['reason'], cost), ('vault_paused', 3))
        # The owner takes the successor out, which moves the nonce: read in full, its reserves go back.
        vault.members.remove(9)
        vault.nonce = 10
        (entry,), cost = chain.run(service, [vault], 3 + self.FULL[4] + 2)
        self.assertEqual((entry['act'], entry['reason'], entry['stateNonce'], cost),
                         (True, 'reserves_returnable', 10, 3 + self.FULL[4] + 2))

    def test_the_pause_is_read_not_inferred_from_the_nonce(self):
        # Every change advances the nonce, a resume included (F3's B8); the pause is still read, so a vault found
        # unpaused is planned at once even at the nonce it was paused at.
        chain = PassChain(3)
        vault = chain.vault('0x' + 'a4' * 20, 7)
        service = chain.service(vault)
        chain.run(service, [vault], self.FULL[3])
        vault.paused, vault.last = False, chain.head.block.timestamp - 10
        (entry,), cost = chain.run(service, [vault], 3 + self.FULL[3])
        self.assertEqual((entry['reason'], cost), ('too_soon', 3 + self.FULL[3]))


if __name__ == '__main__':
    unittest.main()
