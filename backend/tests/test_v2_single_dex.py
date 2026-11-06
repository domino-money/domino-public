"""A chain with one Uniswap version (Elysium's mainnet shows v4 alone, 6 Nov 2026): its profile names the other `null`,
every V2 service reads only the version it has, and a request that names the other is refused (`v2_dex_not_on_chain`)
before any read. The live chains have both, and keep every read they had (their own suites pin those)."""
import copy
from fractions import Fraction
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from discovery import Block, DataError, parse_block  # noqa: E402
import v2_hype_chain as hype  # noqa: E402
from v2_chains import DEX_V3, DEX_V4, ZERO, load_registry  # noqa: E402
from v2_fixtures import HEAD, FakeChain, documents, with_synthetic_code, write_registry  # noqa: E402
from v2_manifest import COMPONENTS, DEPENDENCIES, Deployment  # noqa: E402

BLOCK = Block(1_000, '0x' + '11' * 32, 1_790_000_000)
V3_COMPONENTS = ('vault.v3', 'vaultFactory.v3', 'zap.v3', 'vaultExecutor.v3')
V4_COMPONENTS = ('vault.v4', 'vaultFactory.v4', 'zap.v4.steps', 'zap.v4', 'vaultExecutor.v4')
V3_DEPENDENCIES = ('v3Factory', 'v3PositionManager', 'v3Quoter', 'v3SwapRouter')
V4_DEPENDENCIES = ('v4PoolManager', 'v4PositionManager', 'v4StateView', 'v4Quoter')


def registry(**options):
    directory = tempfile.mkdtemp(prefix='domino-single-dex-')
    try:
        return hype.registry(directory, **options)
    finally:
        shutil.rmtree(directory)


V4_REGISTRY = registry(dexes=(4,))
V4_ONLY = V4_REGISTRY.chain(hype.CHAIN_ID)
V3_ONLY = registry(dexes=(3,)).chain(hype.CHAIN_ID)
BOTH = registry().chain(hype.CHAIN_ID)


def single_dex_deployment(chain, receipts_from=1000):
    """A deployment on `chain` as the spec of 6 Nov 2026 has it: the common components and those of the chain's own
    Uniswap versions, and their dependencies alone. Bound directly (the manifest's validation is v2_manifest's)."""
    dexes = chain.dexes
    absent = (*(V3_COMPONENTS if DEX_V3 not in dexes else ()), *(V4_COMPONENTS if DEX_V4 not in dexes else ()))
    absent_dependencies = (*(V3_DEPENDENCIES if DEX_V3 not in dexes else ()),
                           *(V4_DEPENDENCIES if DEX_V4 not in dexes else ()))
    contracts = {name: '0x' + format(index + 0xa0, '02x') * 20 for index, name in enumerate(COMPONENTS)
                 if name not in absent}
    u = chain.uniswap
    dependencies = {'v3Factory': u.v3 and u.v3.factory, 'v3PositionManager': u.v3 and u.v3.positionManager,
                    'v3Quoter': u.v3 and u.v3.quoterV2, 'v3SwapRouter': u.v3 and u.v3.swapRouter02,
                    'v4PoolManager': u.v4 and u.v4.poolManager, 'v4PositionManager': u.v4 and u.v4.positionManager,
                    'v4StateView': u.v4 and u.v4.stateView, 'v4Quoter': u.v4 and u.v4.quoter,
                    'universalRouter': u.universalRouter.address, 'permit2': chain.permit2,
                    'wrappedNative': chain.wrappedNative.address}
    dependencies = {name: value for name, value in dependencies.items() if name not in absent_dependencies}
    deployed = [name for name in contracts if not name.startswith('vaultExecutor.')]
    manifest = {'environment': 'local-test', 'contracts': contracts, 'dependencies': dependencies,
                'runtimeCodeHashes': {name: '0x' + '22' * 32 for name in (*contracts, *dependencies)},
                'deploymentReceipts': {name: {'blockNumber': receipts_from + index, 'blockHash': '0x' + '33' * 32,
                                              'transactionHash': '0x' + '44' * 32}
                                       for index, name in enumerate(deployed)},
                'verification': {'blockNumber': receipts_from + 20, 'blockHash': '0x' + '55' * 32}}
    return Deployment(chain, manifest)


class Untouched:
    """An RPC client no read may reach, bound to the synthetic chain's id as v2_rpc's clients are."""
    code_cache = None
    chain_id = hype.CHAIN_ID

    def request(self, method, params):
        raise AssertionError(f'unexpected read: {method}')


# ------------------------------------------------------------------ profiles
class ProfileTests(unittest.TestCase):
    def load(self, change, **options):
        directory = tempfile.mkdtemp(prefix='domino-single-dex-')
        self.addCleanup(shutil.rmtree, directory)
        return write_registry(directory, hype.docs(change=change, **options))

    def refused(self, change, rule, **options):
        with self.assertRaisesRegex(DataError, '^v2_chain_profile_invalid$') as caught:
            self.load(change, **options)
        self.assertIn(rule, str(caught.exception.__cause__))

    def test_the_live_chains_have_both_versions(self):
        self.assertEqual([chain.dexes for chain in load_registry().chains], [(3, 4)] * 3)
        self.assertEqual(BOTH.dexes, (3, 4))

    def test_a_chain_names_the_version_it_lacks_null_and_needs_none_of_its_contracts(self):
        self.assertEqual((V4_ONLY.dexes, V4_ONLY.uniswap.v3), ((4,), None))
        self.assertEqual((V3_ONLY.dexes, V3_ONLY.uniswap.v4), ((3,), None))
        # The fixture records none of the other version's contracts, and each loads beside the live chains.
        names = {record.name for record in V4_ONLY.verification.contracts}
        self.assertFalse(any('V3' in name or 'Quoter V2' in name or 'SwapRouter02' in name for name in names), names)
        self.assertEqual(V4_ONLY.native_pool.dex, DEX_V4)
        self.assertEqual(V3_ONLY.native_pool.dex, DEX_V3)

    def test_each_version_s_contracts_are_required_while_the_chain_has_it(self):
        v4 = hype.document(dexes=(4,))['uniswap']['v4']['stateView']

        def unverified(document):
            document['verification']['contracts'] = [r for r in document['verification']['contracts']
                                                     if r['address'] != v4]
        self.refused(unverified, 'consumed_contract_not_verified', dexes=(4,))

    def test_neither_version_or_a_missing_key_is_refused(self):
        self.refused(lambda d: d['uniswap'].update(v3=None), 'uniswap_deployment_missing', dexes=(3,))
        self.refused(lambda d: d['uniswap'].pop('v3'), 'v3', dexes=(4,))

    def test_the_native_pool_is_of_a_version_the_chain_has(self):
        v3_source = hype.document()['gasPrice']
        self.refused(lambda d: d.update(gasPrice=copy.deepcopy(v3_source)), 'native_usd_pool_dex_not_on_chain',
                     dexes=(4,))
        v4_source = hype.document(v4=True)['gasPrice']
        self.refused(lambda d: d.update(gasPrice=copy.deepcopy(v4_source)), 'native_usd_pool_dex_not_on_chain',
                     dexes=(3,))

    def test_a_version_the_chain_lacks_is_refused_by_name(self):
        for chain, missing, present in ((V4_ONLY, 3, 4), (V3_ONLY, 4, 3)):
            with self.subTest(chain=chain.dexes):
                with self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
                    chain.require_dex(missing)
                with self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
                    chain.position_manager(missing)
                self.assertIs(chain.require_dex(present), getattr(chain.uniswap, f'v{present}'))
                self.assertEqual(chain.position_manager(present), getattr(chain.uniswap, f'v{present}').positionManager)
        for dex in (5, '4', True, None):
            with self.subTest(dex=dex), self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
                BOTH.require_dex(dex)
        self.assertEqual((BOTH.position_manager(3), BOTH.position_manager(4)),
                         (BOTH.uniswap.v3.positionManager, BOTH.uniswap.v4.positionManager))
        with self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
            V4_ONLY.v3_tick_spacing(500)
        self.assertEqual(V3_ONLY.v3_tick_spacing(500), 10)

    def test_a_balance_chain_reads_both_versions(self):
        from v2_chains import default_balance_registry
        self.assertEqual([chain.dexes for chain in default_balance_registry().chains], [(3, 4), (3, 4)])


# ------------------------------------------------------------------- readers
class ReaderTests(unittest.TestCase):
    def test_the_reader_refuses_a_version_the_chain_lacks_before_any_read(self):
        from v2_uniswap import PoolRef, PositionRef, UniswapReader, v3_pool_address
        usdc, whype = hype.USDC.lower(), hype.WHYPE.lower()
        low, high = sorted((usdc, whype))
        reader = UniswapReader(V4_ONLY, Untouched())
        for read in (lambda: reader.pool(PoolRef(3, low, high, 500, 10), BLOCK),
                     lambda: reader.position(PositionRef(3, '0x' + '99' * 20, 1), BLOCK),
                     lambda: reader.position_liquidity(PositionRef(3, '0x' + '99' * 20, 1), BLOCK),
                     lambda: v3_pool_address(V4_ONLY, low, high, 500)):
            with self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
                read()
        reader = UniswapReader(V3_ONLY, Untouched())
        with self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
            reader.pool(PoolRef(4, ZERO, usdc, 500, 10), BLOCK)
        # The version it has is read through that version's contracts alone.
        self.assertEqual(v3_pool_address(V3_ONLY, low, high, 500), v3_pool_address(BOTH, low, high, 500))

    def test_the_reader_proves_only_the_chain_s_own_contracts(self):
        from v2_uniswap import UniswapReader

        class Anchored(Untouched):
            anchors = {BLOCK.tag: BLOCK}  # the block is the client's own: no canonical check to read
        cases = ((V4_ONLY, 4, ('positionManager', 'stateView')), (V3_ONLY, 3, ('factory', 'positionManager')))
        for chain, dex, contracts in cases:
            with self.subTest(chain=chain.dexes):
                proven = []
                reader = UniswapReader(chain, Anchored())
                reader.code = mock.Mock(proven=lambda contract, expected, number: proven.append(contract) or True)
                reader._prepare(BLOCK, dex)
                deployment = getattr(chain.uniswap, f'v{dex}')
                self.assertEqual(proven, [getattr(deployment, name) for name in contracts])

    def test_position_managers_are_the_profile_s_by_version(self):
        from v2_autoexit import PoolRef, position_ref
        import v2_read_service
        import v2_snapshots
        usdc = hype.USDC.lower()
        self.assertEqual(position_ref(V4_ONLY, PoolRef(4, ZERO, usdc, 500, 10), 5).position_manager,
                         V4_ONLY.uniswap.v4.positionManager)
        with self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
            position_ref(V4_ONLY, PoolRef(3, *sorted((usdc, hype.WHYPE.lower())), 500, 10), 5)
        with mock.patch.object(v2_read_service, 'default_registry', lambda: mock.Mock(chain=lambda _: V4_ONLY)):
            self.assertEqual(v2_read_service._manager(hype.CHAIN_ID, 4), V4_ONLY.uniswap.v4.positionManager)
            with self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
                v2_read_service._manager(hype.CHAIN_ID, 3)
        for call in (lambda: v2_snapshots.read_position(Untouched(), V4_ONLY, BLOCK, 3, 1, None),
                     lambda: v2_snapshots._burn_proven(Untouched(), V4_ONLY, 3, 1, 0, BLOCK)):
            with self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
                call()


    def test_read_v6_refuses_a_fee_read_of_a_version_the_chain_lacks_as_an_invalid_request(self):
        import v2_read_service

        class Store:
            def reader(self):
                raise AssertionError('the index was read')
        service = object.__new__(v2_read_service.V2ReadService)
        service.store = Store()
        with mock.patch.object(v2_read_service, 'default_registry', lambda: mock.Mock(chain=lambda _: V4_ONLY)):
            with self.assertRaisesRegex(DataError, '^invalid_request$'):
                service.position_fees(hype.CHAIN_ID, [(4, 1), (3, 2)])
            with self.assertRaisesRegex(AssertionError, 'the index was read'):
                service.position_fees(hype.CHAIN_ID, [(4, 1)])


# ---------------------------------------------------------------- chain reads
class ChainReadTests(unittest.TestCase):
    def test_pool_candidates_and_tiers_are_the_chain_s_own_versions(self):
        from v2_chain_reads import pool_candidates, v3_tiers
        token = '0x' + '77' * 20
        for chain, dexes in ((V4_ONLY, {4}), (V3_ONLY, {3}), (BOTH, {3, 4})):
            with self.subTest(chain=chain.dexes):
                self.assertEqual({ref.dex for ref in pool_candidates(chain, token)}, dexes)
        self.assertEqual(v3_tiers(V4_ONLY), {})
        self.assertEqual(v3_tiers(V3_ONLY), v3_tiers(BOTH))
        self.assertTrue(v3_tiers(BOTH))
        # Native HYPE has no v3 pool anywhere; on a v4-only chain its pools are v4's.
        self.assertEqual({ref.dex for ref in pool_candidates(V4_ONLY, ZERO)}, {4})
        self.assertEqual(pool_candidates(V3_ONLY, ZERO), [])

    def test_a_balance_chain_keeps_both_versions_candidates(self):
        from v2_chain_reads import pool_candidates
        from v2_chains import default_balance_registry
        ethereum = default_balance_registry().chains[0]
        self.assertEqual({ref.dex for ref in pool_candidates(ethereum, '0x' + '77' * 20)}, {3, 4})

    def test_a_survey_reads_no_contract_of_a_version_the_chain_lacks(self):
        import v2_chain_reads
        from v2_chain_reads import survey
        for chain in (V4_ONLY, V3_ONLY):
            with self.subTest(chain=chain.dexes), \
                    mock.patch.object(v2_chain_reads, 'aggregate', side_effect=AssertionError('the round was read')):
                # Its native pool's round is built from the version the chain has, and nothing else.
                with self.assertRaisesRegex(AssertionError, 'the round was read'):
                    survey(chain, Untouched(), BLOCK, [], {})

    def test_a_survey_refuses_a_pool_of_a_version_the_chain_lacks_before_any_read(self):
        from v2_chain_reads import survey
        from v2_uniswap import PoolRef
        low, high = sorted((hype.USDC.lower(), hype.WHYPE.lower()))
        for chain, ref in ((V4_ONLY, PoolRef(3, low, high, 500, 10)), (V3_ONLY, PoolRef(4, ZERO, hype.USDC.lower(),
                                                                                           500, 10))):
            with self.subTest(chain=chain.dexes), self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
                survey(chain, Untouched(), BLOCK, [ref], {ref: low})


# ---------------------------------------------------------------------- quotes
class QuoteTests(unittest.TestCase):
    def test_candidate_paths_are_the_chain_s_own_versions(self):
        from v2_quotes import candidate_paths
        a, b = '0x' + '71' * 20, '0x' + '72' * 20
        self.assertEqual({path.dex for path in candidate_paths(V4_ONLY, a, b)}, {4})
        self.assertEqual({path.dex for path in candidate_paths(V3_ONLY, a, b)}, {3})
        self.assertEqual({path.dex for path in candidate_paths(BOTH, a, b)}, {3, 4})
        # Asking for v3 on a chain without it finds nothing, never a pool of another chain's tiers.
        self.assertEqual(candidate_paths(V4_ONLY, a, b, v4=False), [])

    def test_a_quote_of_a_version_the_chain_lacks_is_refused(self):
        from v2_quotes import Path as QuotePath, V4Ticks, quote_call
        from v2_uniswap import PoolRef
        a, b = sorted(('0x' + '71' * 20, '0x' + '72' * 20))
        with self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
            quote_call(V4_ONLY, QuotePath(3, a, (PoolRef(3, a, b, 500, 10),)), 10)
        with self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
            quote_call(V3_ONLY, QuotePath(4, a, (PoolRef(4, a, b, 500, 10),)), 10)
        self.assertEqual(quote_call(V4_ONLY, QuotePath(4, a, (PoolRef(4, a, b, 500, 10),)), 10)[0],
                         V4_ONLY.uniswap.v4.quoter)
        with self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
            V4Ticks(V3_ONLY, Untouched(), BLOCK, PoolRef(4, a, b, 500, 10))
        self.assertEqual(V4Ticks(V4_ONLY, Untouched(), BLOCK, PoolRef(4, a, b, 500, 10)).manager,
                         V4_ONLY.uniswap.v4.poolManager)


# ------------------------------------------------------------------- plans
class PlanTests(unittest.TestCase):
    def planner(self, chain):
        from v2_position_plan import PositionPlanner

        class Follower:
            def head(self):
                raise AssertionError('the head was read')
        return PositionPlanner(chain, None, Follower(), single_dex_deployment(chain), clock=lambda: 1_790_000_000)

    def test_a_plan_of_a_version_the_chain_lacks_is_refused_before_any_read(self):
        create = {'action': 'create', 'pool': {'dex': 3}}
        exit_ = {'action': 'exit', 'position': {'dex': 3, 'tokenId': '1'}}
        for request in (create, exit_):
            with self.subTest(action=request['action']), self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
                self.planner(V4_ONLY).plan(request, '0x' + '12' * 20)
        with self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
            self.planner(V3_ONLY).plan({'action': 'increase', 'position': {'dex': 4, 'tokenId': '1'}}, '0x' + '12' * 20)
        # A version the chain has goes on to read the head.
        with self.assertRaisesRegex(AssertionError, 'the head was read'):
            self.planner(V4_ONLY).plan({'action': 'create', 'pool': {'dex': 4}}, '0x' + '12' * 20)

    def test_a_position_is_read_at_its_own_version_s_manager(self):
        from v2_position_plan import PlanError, _Context
        asked = []

        class Reader:
            def position(self, ref, block):
                asked.append(ref.position_manager)
                raise DataError('v2_position_not_found')
        context = object.__new__(_Context)
        context.request, context.chain, context.block, context.reader = (
            {'position': {'dex': 4, 'tokenId': '5'}}, V4_ONLY, BLOCK, Reader())
        with self.assertRaises(PlanError) as caught:
            context._load_position()
        self.assertEqual((caught.exception.code, asked), ('position_plan_position_not_found',
                                                          [V4_ONLY.uniswap.v4.positionManager]))

    def test_the_service_answers_it_as_an_invalid_request(self):
        from v2_position_plan_service import plan_failure
        self.assertEqual(plan_failure(DataError('v2_dex_not_on_chain')).code, 'invalid_request')
        self.assertEqual(plan_failure(DataError('v2_pool_not_found')).code, 'upstream_invalid_response')


# ---------------------------------------------------------------- deployments
class DeploymentTests(unittest.TestCase):
    def test_discovery_scans_the_chain_s_own_factory_alone(self):
        from v2_vaults import VaultDiscovery
        deployment = single_dex_deployment(V4_ONLY)
        reads = []

        class Index:
            def request(self, method, params):
                reads.append(params[0]['address'])
                return []
        head = parse_block({'number': hex(1100), 'hash': '0x' + '11' * 32, 'timestamp': '0x10'})
        discovery = VaultDiscovery(deployment)
        self.assertEqual(sorted(discovery.next_block), [4])
        self.assertEqual(discovery.scan(Index(), head), [])
        self.assertEqual(set(reads), {deployment.factory(4)})

        class State:
            def __init__(self):
                self.put_calls, self.saved = [], False

            def get(self, name):
                return None

            def put(self, name, next_block, end, items):
                self.put_calls.append(name)

            def save(self):
                self.saved = True
        state = State()
        VaultDiscovery(deployment, state=state).scan(Index(), head)
        self.assertEqual((state.put_calls, state.saved), (['vaultFactory.v4'], True))

    def test_a_vault_of_a_version_the_chain_lacks_is_refused_before_any_read(self):
        from v2_vaults import VaultReader, fee_growth_inside
        from v2_uniswap import PoolRef
        reader = VaultReader(V4_ONLY, single_dex_deployment(V4_ONLY), Untouched(), None)
        with self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
            reader.prove('0x' + '81' * 20, 3, BLOCK)
        with self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
            fee_growth_inside(V3_ONLY, Untouched(), PoolRef(4, ZERO, hype.USDC.lower(), 500, 10), -10, 10, BLOCK)

    def test_the_scan_identity_names_the_chain_s_own_factories(self):
        from v2_scan_state import identity
        deployment = single_dex_deployment(V4_ONLY)
        self.assertEqual(list(identity(deployment)), ['chainId', 'vaultFactory.v4', 'autoExit'])
        both = single_dex_deployment(BOTH)
        self.assertEqual(list(identity(both)), ['chainId', 'vaultFactory.v3', 'vaultFactory.v4', 'autoExit'])

    def test_the_executor_admits_vaults_of_the_chain_s_own_factories(self):
        from v2_executor import ChainExecutor
        executor = object.__new__(ChainExecutor)
        executor.policy = mock.Mock(enabled=True)
        executor.deployment = single_dex_deployment(V4_ONLY)
        asked = []
        executor._view = lambda target, *args: asked.append(target) or False
        with self.assertRaisesRegex(DataError, '^v2_target_not_admitted$'):
            executor.submit(kind='compound', target='0x' + '82' * 20, subject='s', data='0x12', deadline=1,
                            head=BLOCK, base_fee=1, gas=1)
        self.assertEqual(asked, [executor.deployment.factory(4)])

    def test_the_indexer_registers_the_deployed_components_alone(self):
        from v2_indexer import contract_rows, deployed_components
        deployment = single_dex_deployment(V4_ONLY)
        self.assertEqual(deployed_components(deployment),
                         ['registry', 'priceAnchor', 'autoExit', 'vaultSwap', 'vault.v4', 'vaultFactory.v4',
                          'zap.v4.steps', 'zap.v4', 'vaultExecutor.v4'])
        rows = contract_rows(deployment)
        self.assertEqual([row[1] for row in rows], deployed_components(deployment))
        self.assertEqual([row[3] for row in rows if row[3] is not None], [4, 4])
        self.assertEqual(deployed_components(single_dex_deployment(BOTH)), list(COMPONENTS))
        self.assertEqual(set(DEPENDENCIES) - set(deployment.manifest['dependencies']), set(V3_DEPENDENCIES))

    def test_a_registration_proves_the_deployed_components_and_the_dependencies_the_manifest_names(self):
        from v2_indexer import deployed_components, proven_contracts
        deployment = single_dex_deployment(V4_ONLY)
        self.assertEqual(list(proven_contracts(deployment)), deployed_components(deployment))  # a local test
        deployment.manifest['environment'] = 'public-chain-preparation'
        proven = proven_contracts(deployment)
        self.assertEqual(set(proven), {*deployed_components(deployment), *V4_DEPENDENCIES, 'universalRouter',
                                       'permit2', 'wrappedNative'})
        self.assertEqual(proven['v4StateView'], V4_ONLY.uniswap.v4.stateView)


# ----------------------------------------------------------------------- fees
class FeeTests(unittest.TestCase):
    """The fee follower on a chain with one version: its logs, its reader's contracts, and its refusals."""

    def setUp(self):
        from v2_fee_fixtures import FeeChain
        from v2_fees import FeePosition
        # The synthetic chain with both versions makes the logs; the one-version chains share its contracts.
        self.fake = FeeChain(BOTH, head=10)
        self.v4 = self.fake.mint(4, 41, 1, owner='0x' + '0c' * 20, liquidity=10)
        self.v3 = self.fake.mint(3, 31, 2, owner='0x' + '0c' * 20, liquidity=10)
        self.followed = {(4, 41): FeePosition(4, 41, {}, self.v4['pool_key'], -600, 600, 'following', None, None),
                         (3, 31): FeePosition(3, 31, {}, self.v3['pool_key'], -600, 600, 'following', None, None)}

    def raw(self, index):
        number, _, raw = self.fake.logs[index]
        return dict(raw, blockHash=self.fake.hash(number))

    def test_each_chain_decodes_its_own_version_s_logs_and_refuses_the_other_s(self):
        from v2_fees import decode_fee_log
        # Logs 0-1: the v4 position's Transfer and ModifyLiquidity; 2-3: the v3 position's Transfer and increase.
        both = [(log.key, log.kind) for log in (decode_fee_log(BOTH, self.raw(i), self.followed) for i in range(4))]
        self.assertEqual(both, [((4, 41), 'transfer'), ((4, 41), 'modify'), ((3, 31), 'transfer'),
                                ((3, 31), 'increase')])
        self.assertEqual([(log.key, log.kind) for log in (decode_fee_log(V4_ONLY, self.raw(i), self.followed)
                                                          for i in range(2))], both[:2])
        self.assertEqual([(log.key, log.kind) for log in (decode_fee_log(V3_ONLY, self.raw(i), self.followed)
                                                          for i in range(2, 4))], both[2:])
        for chain, indexes in ((V4_ONLY, (2, 3)), (V3_ONLY, (0, 1))):
            for index in indexes:
                with self.subTest(chain=chain.dexes, log=index), \
                        self.assertRaisesRegex(DataError, '^v2_fee_log_unexpected$'):
                    decode_fee_log(chain, self.raw(index), self.followed)

    def test_the_reader_proves_the_chain_s_own_contracts_and_refuses_the_other_version(self):
        from v2_fees import StateReader
        u = BOTH.uniswap
        self.assertEqual(StateReader(BOTH, Untouched()).contracts,
                         (BOTH.multicall3, u.v3.positionManager, u.v3.factory, u.v4.positionManager, u.v4.stateView))
        self.assertEqual(StateReader(V4_ONLY, Untouched()).contracts,
                         (V4_ONLY.multicall3, u.v4.positionManager, u.v4.stateView))
        self.assertEqual(StateReader(V3_ONLY, Untouched()).contracts,
                         (V3_ONLY.multicall3, u.v3.positionManager, u.v3.factory))
        reader = StateReader(V4_ONLY, Untouched())
        with self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
            reader.identify(BLOCK, [(4, 41), (3, 31)])
        with self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
            reader.states(BLOCK, [self.followed[(4, 41)], self.followed[(3, 31)]], 'now')

    def test_the_follower_asks_only_the_chain_s_own_contracts_for_logs(self):
        from v2_fees import V2FeeFollower
        follower = object.__new__(V2FeeFollower)
        follower.chain = V4_ONLY
        queries = []

        class Index:
            def request(self, method, params):
                queries.append(params[0]['address'])
                return []
        self.assertEqual(follower._logs(Index(), {(4, 41): self.followed[(4, 41)]}, 1, 10), [])
        self.assertEqual(queries, [[V4_ONLY.uniswap.v4.positionManager], V4_ONLY.uniswap.v4.poolManager])
        with self.assertRaisesRegex(DataError, '^v2_dex_not_on_chain$'):
            follower._logs(Index(), self.followed, 1, 10)


# ------------------------------------------------------------------ featured
class FeaturedEvidenceTests(unittest.TestCase):
    def test_a_pool_of_a_version_the_chain_lacks_is_unresolved_and_never_read(self):
        import featured_chain_evidence as evidence
        import test_featured_chains as featured
        from v2_rpc import ChainReadRpc, checked_chain_rpc_config, configured_endpoints
        chain = V4_ONLY
        with mock.patch.object(featured, 'feed'):
            fake = featured.Chain(chain)
        usdc = hype.USDC.lower()
        # HYPE (native, currency0) at US$ 40 in the profile's native HYPE/USDC v4 pool, deep enough to qualify.
        price = featured.sqrt_of(Fraction(40 * 10**6, 10**18))
        native = featured.v4_pool(fake, (ZERO, usdc, 500, 10, ZERO), sqrt=price, liquidity=10**18)
        entry = lambda name, url: {'name': name, 'host': f'{name}.example.invalid', 'url': url, 'archive': True,
                                   'maxBatchItems': 100, 'maxLogBlocks': 10000, 'requestsPerSecond': None}
        document = {'schemaVersion': 1, 'kind': 'domino-v2-chain-rpc',
                    'chains': {chain.key: {'endpoints': [entry('chainstack', featured.CHAINSTACK),
                                                         entry('alchemy', featured.ALCHEMY)]}}}
        endpoints = configured_endpoints(chain, chain_rpc_config=checked_chain_rpc_config(document, V4_REGISTRY,
                                                                                         environ={}), send=fake)
        rpc = ChainReadRpc(endpoints, batch_reads=True, max_requests=64)
        v3_pool = '0x' + '5a' * 20
        found = evidence.pools(chain, rpc, [v3_pool, native], now=featured.NOW)
        self.assertEqual(found.pools[v3_pool], {'error': 'identity_unresolved'})
        self.assertIn('pool', found.pools[native])
        self.assertNotIn(v3_pool, {target for target, _, _ in fake.subcalls})
        usd, _, _ = found.eth
        self.assertTrue(Fraction(39) < usd < Fraction(41), usd)


# ------------------------------------------------------------------ the rest
class RpcProbeTests(unittest.TestCase):
    def test_an_archive_endpoint_of_a_chain_without_v4_is_probed_at_its_v3_factory(self):
        from test_v2_rpc import chain_rpc_document
        from v2_rpc import check_endpoint, checked_chain_rpc_config, configured_endpoints
        directory = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(shutil.rmtree, directory)
        docs = documents()
        base = docs['base-8453.json'] = with_synthetic_code(docs['base-8453.json'])
        v4 = set(base['uniswap']['v4'].values())
        base['uniswap']['v4'] = None
        base['verification']['contracts'] = [r for r in base['verification']['contracts'] if r['address'] not in v4]
        (directory / 'chains').mkdir()
        registry = write_registry(directory / 'chains', docs)
        chain = registry.chain('base-8453')
        fake = FakeChain(8453)
        fake.serve_code(base)
        old = chain.verification.block
        fake.blocks[hex(old)] = {'number': hex(old), 'hash': '0x' + 'ee' * 32, 'timestamp': '0x1'}
        config = checked_chain_rpc_config(chain_rpc_document(), registry=registry, environ={})
        endpoints = configured_endpoints(chain, chain_rpc_config=config, send=fake)
        endpoint = next(e for e in endpoints.endpoints if e.name == 'stack')
        report = check_endpoint(endpoints, endpoint, clock=lambda: int(HEAD['timestamp'], 16) + 5)
        self.assertEqual(report['archiveProbe'], 'match')
        probed = [params[0] for url, method, params in fake.calls('eth_getCode') if params[1] == hex(old)]
        self.assertEqual(probed, [chain.uniswap.v3.factory])
        self.assertTrue(report['ok'])


class ForkQualificationTests(unittest.TestCase):
    def test_journeys_of_a_version_the_chain_lacks_are_skipped(self):
        import qualify_position_plan_fork as fork
        for chain, journey, other in ((V4_ONLY, 'journeys_v3', 'v3'), (V3_ONLY, 'journeys_v4', 'v4')):
            with self.subTest(chain=chain.dexes):
                run = object.__new__(fork.Qualification)
                run.profile, run.journeys = chain, []
                getattr(run, journey)()
                self.assertEqual(run.journeys, [{'name': f'{other} journeys', 'ok': True,
                                                 'skipped': f'the chain has no Uniswap {other}'}])


if __name__ == '__main__':
    unittest.main()
