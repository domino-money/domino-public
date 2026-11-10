"""v3 and v4 pool and position reads, through the frozen ABIs, on any profiled chain.

The chain is a fake that answers only calls whose selector and argument types
are the exported ones, at the profile's addresses. The fee math is checked
against independent implementations: the V1 position accounting (the same
inside-growth and principal formulas) and the CREATE2 addresses the profiles
recorded for real pools.
"""
from pathlib import Path
import random
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from discovery import ZERO, Block, DataError, PoolKey, parse_block
from position_accounting import inside_growth, principal_amounts
from v2_abi import function
from v2_chains import DEX_V3, DEX_V4, load_registry
from v2_rpc import ChainEndpoints, Endpoint
from v2_uniswap import (DYNAMIC_FEE, PoolRef, PositionRef, UniswapReader, v3_fee_growth_inside, v3_fees_owed,
                        v3_pool_address, v4_fees_owed)
from v2_fixtures import HEAD, FakeChain, Revert, documents, with_synthetic_code, write_registry
from v4_math import Q128, U256, sqrt_at_tick

U128 = (1 << 128) - 1
OWNER, OTHER = '0x' + '0a' * 20, '0x' + '0b' * 20
TOKEN_A, TOKEN_B = '0x' + '1a' * 20, '0x' + '2b' * 20  # TOKEN_A < TOKEN_B
URL = 'https://stack.example.invalid/SYNTHETIC'


def endpoint(name='stack', url=URL):
    return Endpoint(name, 'stack.example.invalid', url, None, 50, 10000, None)


class Chain:
    """A synthetic-code copy of the Base profile, its fake chain and endpoints."""
    def __init__(self, test):
        directory = Path(tempfile.mkdtemp()).resolve()
        test.addCleanup(shutil.rmtree, directory)
        docs = documents()
        self.document = docs['base-8453.json'] = with_synthetic_code(docs['base-8453.json'])
        self.profile = write_registry(directory, docs).chain('base-8453')
        self.fake = FakeChain(8453)
        self.fake.serve_code(self.document)
        self.endpoints = ChainEndpoints(self.profile, (endpoint(),), 'v2_chain_rpc_file', send=self.fake)
        self.on = self.fake.on

    def reader(self, **kwargs):
        rpc = self.endpoints.read_rpc(batch_reads=True, **kwargs)
        return UniswapReader(self.profile, rpc)


class V4Position:
    """A v4 position manager and StateView holding one position, as deployed."""
    def __init__(self, chain, token_id=7, *, key=(TOKEN_A, TOKEN_B, 3000, 60, ZERO), lower=-600, upper=600,
                 liquidity=10**18, last=(0, 0), inside=(5 * Q128, 9 * Q128), slot0=(2**96, 0, 0, 3000)):
        self.chain, self.token_id = chain, token_id
        self.key, self.lower, self.upper, self.liquidity = key, lower, upper, liquidity
        self.last, self.inside, self.slot0, self.active = last, inside, slot0, 4 * 10**18
        self.owner, self.approved, self.subscriber, self.core_liquidity = OWNER, ZERO, ZERO, liquidity
        self.pool_id = PoolRef(DEX_V4, *key).pool_id
        manager, view = chain.profile.uniswap.v4.positionManager, chain.profile.uniswap.v4.stateView
        positions = 'IV4PositionManagerMinimal'
        chain.on(manager, function(positions, 'getPoolAndPositionInfo'), self.info)
        chain.on(manager, function(positions, 'ownerOf'), lambda token: (self.owner,))
        chain.on(manager, function(positions, 'getApproved'), lambda token: (self.approved,))
        chain.on(manager, function(positions, 'subscriber'), lambda token: (self.subscriber,))
        chain.on(manager, function(positions, 'getPositionLiquidity'), lambda token: (self.liquidity,))
        state = 'IV4StateViewMinimal'
        chain.on(view, function(state, 'getSlot0'), lambda pool: self.slot0 if self.ours(pool) else (0, 0, 0, 0))
        chain.on(view, function(state, 'getLiquidity'), lambda pool: (self.active,))
        chain.on(view, function(state, 'getPositionInfo'), self.position_info)
        chain.on(view, function(state, 'getFeeGrowthInside'), lambda pool, lower, upper: self.inside)
        self.info_word = None

    def ours(self, pool):
        return '0x' + pool.hex() == self.pool_id

    def info(self, token):
        if token != self.token_id:
            return ((ZERO, ZERO, 0, 0, ZERO), 0)
        if self.info_word is not None:
            return (self.key, self.info_word)
        word = ((int(self.pool_id, 16) >> 56) << 56 | (self.upper & 0xffffff) << 32 | (self.lower & 0xffffff) << 8
                | (1 if self.subscriber != ZERO else 0))
        return (self.key, word)

    def position_info(self, pool, owner, lower, upper, salt):
        assert self.ours(pool) and owner == self.chain.profile.uniswap.v4.positionManager
        assert (lower, upper, int.from_bytes(salt, 'big')) == (self.lower, self.upper, self.token_id)
        return (self.core_liquidity, *self.last)


class V3Position:
    """A v3 factory, position manager and pool holding one position."""
    def __init__(self, chain, token_id=11, *, fee=3000, spacing=None, lower=-600, upper=600, liquidity=10**18,
                 last=(0, 0), owed=(0, 0), tick=0, growth=(0, 0), below=(0, 0), above=(0, 0)):
        self.chain, self.token_id, self.fee = chain, token_id, fee
        self.lower, self.upper, self.liquidity, self.last, self.owed = lower, upper, liquidity, last, owed
        self.tick, self.growth, self.outside = tick, growth, {lower: below, upper: above}
        self.sqrt = sqrt_at_tick(tick)
        self.operator, self.owner, self.fee_protocol = ZERO, OWNER, 0
        self.pool = v3_pool_address(chain.profile, TOKEN_A, TOKEN_B, fee)
        self.spacing = spacing or chain.profile.v3_tick_spacing(fee)
        self.initialized = {lower: True, upper: True}
        v3 = chain.profile.uniswap.v3
        manager, factory, pool = 'IUniswapV3PositionManagerMinimal', 'IUniswapV3FactoryMinimal', 'IUniswapV3PoolMinimal'
        chain.on(v3.positionManager, function(manager, 'positions'), self.positions)
        chain.on(v3.positionManager, function(manager, 'ownerOf'), lambda token: (self.owner,))
        self.spacings = {fee: self.spacing}
        chain.on(v3.factory, function(factory, 'feeAmountTickSpacing'), lambda fee: (self.spacings.get(fee, 0),))
        chain.on(v3.factory, function(factory, 'getPool'),
                 lambda a, b, fee: (self.pool if (a, b, fee) == (TOKEN_A, TOKEN_B, self.fee) else ZERO,))
        chain.on(self.pool, function(pool, 'slot0'), lambda: (self.sqrt, self.tick, 0, 1, 1, self.fee_protocol, True))
        chain.on(self.pool, function(pool, 'liquidity'), lambda: (3 * 10**18,))
        chain.on(self.pool, function(pool, 'feeGrowthGlobal0X128'), lambda: (self.growth[0],))
        chain.on(self.pool, function(pool, 'feeGrowthGlobal1X128'), lambda: (self.growth[1],))
        chain.on(self.pool, function(pool, 'ticks'), self.ticks)

    def positions(self, token):
        if token != self.token_id:
            raise Revert()  # 'Invalid token ID'
        return (0, self.operator, TOKEN_A, TOKEN_B, self.fee, self.lower, self.upper, self.liquidity,
                *self.last, *self.owed)

    def ticks(self, tick):
        outside = self.outside.get(tick, (0, 0))
        return (1, 0, *outside, 0, 0, 0, self.initialized.get(tick, False))


class RefTests(unittest.TestCase):
    def test_pool_refs_follow_dominov2types(self):
        v4 = PoolRef(DEX_V4, ZERO, TOKEN_A.upper().replace('0X', '0x'), DYNAMIC_FEE, 60, '0x' + '33' * 20)
        self.assertEqual((v4.currency1, v4.dynamic_fee), (TOKEN_A, True))
        PoolKey.checked((v4.currency0, v4.currency1, v4.fee, v4.tick_spacing, v4.hooks), v4.pool_id)  # V1's hashing
        v3 = PoolRef(DEX_V3, TOKEN_A, TOKEN_B, 500, 10)
        self.assertFalse(v3.dynamic_fee)
        with self.assertRaisesRegex(DataError, '^v2_pool_id_is_v4_only$'):
            v3.pool_id
        for args in ((DEX_V3, ZERO, TOKEN_A, 500, 10), (DEX_V3, TOKEN_A, TOKEN_B, 500, 10, '0x' + '33' * 20),
                     (DEX_V3, TOKEN_A, TOKEN_B, 1_000_000, 10), (DEX_V3, TOKEN_A, TOKEN_B, 500, 16384),
                     (DEX_V3, TOKEN_A, TOKEN_B, 500, 0), (DEX_V4, TOKEN_B, TOKEN_A, 500, 10),
                     (DEX_V4, TOKEN_A, TOKEN_A, 500, 10), (DEX_V4, TOKEN_A, TOKEN_B, 1_000_001, 10),
                     (DEX_V4, TOKEN_A, TOKEN_B, 500, 32768), (DEX_V4, TOKEN_A, TOKEN_B, True, 10),
                     (2, TOKEN_A, TOKEN_B, 500, 10), (True, TOKEN_A, TOKEN_B, 500, 10),
                     (3.0, TOKEN_A, TOKEN_B, 500, 10)):
            with self.subTest(args=args), self.assertRaisesRegex(DataError, '^v2_invalid_pool_ref$'):
                PoolRef(*args)
        with self.assertRaisesRegex(DataError, '^invalid_address$'):
            PoolRef(DEX_V4, 'not-an-address', TOKEN_B, 500, 10)
        self.assertEqual(PoolRef(DEX_V4, TOKEN_A, TOKEN_B, 1_000_000, 32767).fee, 1_000_000)

    def test_position_refs_are_checked(self):
        ref = PositionRef(DEX_V4, OWNER.upper().replace('0X', '0x'), 2**256 - 1)
        self.assertEqual(ref.position_manager, OWNER)
        for args in ((5, OWNER, 1), (DEX_V4, OWNER, -1), (DEX_V4, OWNER, 2**256), (DEX_V4, OWNER, True),
                     (DEX_V4, OWNER, '7')):
            with self.subTest(args=args), self.assertRaisesRegex(DataError, '^v2_invalid_position_ref$'):
                PositionRef(*args)

    def test_v3_pools_are_the_create2_addresses_the_profiles_recorded(self):
        registry = load_registry()
        for chain in registry.chains:
            pools = [r for r in chain.verification.contracts if r.name.startswith('v3 pool ')]
            self.assertTrue(pools or chain.chainId == 42161 or chain.uniswap.v3 is None)  # Elysium: no v3
            for record in pools:
                fee = int(record.name.split('fee ')[1].split(' ')[0])
                weth, stable = chain.wrappedNative.address, chain.chargeCurrencies[0].address
                with self.subTest(chain=chain.key, fee=fee):
                    self.assertEqual(v3_pool_address(chain, *sorted((weth, stable)), fee), record.address)


class FeeMathTests(unittest.TestCase):
    def test_v3_inside_growth_matches_the_v1_formula_in_every_tick_case(self):
        rng = random.Random(4663)
        for _ in range(500):
            lower, upper = sorted(rng.sample(range(-1000, 1000), 2))
            tick = rng.choice((lower - 1, lower, (lower + upper) // 2, upper - 1, upper, upper + 1))
            growth = [rng.randrange(2**256) for _ in range(2)]
            below, above = [rng.randrange(2**256) for _ in range(2)], [rng.randrange(2**256) for _ in range(2)]
            model = {'growthX128': [str(g) for g in growth],
                     'ticks': {str(lower): {'outsideX128': [str(v) for v in below]},
                               str(upper): {'outsideX128': [str(v) for v in above]}}}
            expected = inside_growth(model, tick, lower, upper)
            self.assertEqual([v3_fee_growth_inside(tick, lower, upper, growth[i], below[i], above[i]) for i in (0, 1)],
                             expected)

    def test_the_tick_cases_and_wrapping(self):
        g = 100 * Q128
        self.assertEqual(v3_fee_growth_inside(0, -10, 10, g, 30 * Q128, 20 * Q128), 50 * Q128)  # inside
        self.assertEqual(v3_fee_growth_inside(-20, -10, 10, g, 30 * Q128, 20 * Q128), 10 * Q128)  # below
        self.assertEqual(v3_fee_growth_inside(10, -10, 10, g, 30 * Q128, 20 * Q128), (-10 * Q128) & U256)  # above
        self.assertEqual(v3_fee_growth_inside(-10, -10, 10, g, 30 * Q128, 20 * Q128), 50 * Q128)  # at lower: inside

    def test_v3_owed_truncates_and_wraps_in_128_bits_as_the_manager_does(self):
        self.assertEqual(v3_fees_owed(7, 5 * Q128, 2 * Q128, 10**18), 7 + 3 * 10**18)
        self.assertEqual(v3_fees_owed(0, 1 * Q128, 3 * Q128, 1), ((-2 * Q128) & U256) // Q128 & U128)
        accrued_over = (2**128 + 5) * Q128  # liquidity 1: accrued 2**128 + 5, cut to 5
        self.assertEqual(v3_fees_owed(1, accrued_over, 0, 1), 6)
        self.assertEqual(v3_fees_owed(U128, 5 * Q128, 0, 1), 4)  # the sum wraps
        self.assertEqual(v3_fees_owed(9, 5 * Q128, 2 * Q128, 0), 9)

    def test_principal_below_inside_and_above_the_range(self):
        from v2_uniswap import PoolState, PositionState
        ref = PoolRef(DEX_V4, TOKEN_A, TOKEN_B, 3000, 60)
        for tick in (-1200, -600, 0, 599, 600, 1200):
            price = sqrt_at_tick(tick)
            pool = PoolState(ref, parse_block(HEAD), None, ref.pool_id, price, tick, 1, 3000, 0)
            state = PositionState(PositionRef(DEX_V4, OWNER, 1), OWNER, ZERO, ZERO, pool, -600, 600, 10**18, (0, 0))
            with self.subTest(tick=tick):
                self.assertEqual(list(state.principal()),
                                 principal_amounts({'sqrtPriceX96': str(price)}, -600, 600, 10**18))
                self.assertEqual(state.in_range, -600 <= tick < 600)

    def test_v4_owed_wraps_the_growth_but_not_the_amount(self):
        self.assertEqual(v4_fees_owed(5 * Q128, 2 * Q128, 10**18), 3 * 10**18)
        self.assertEqual(v4_fees_owed(1 * Q128, (2**256 - Q128), 10), 20)
        self.assertEqual(v4_fees_owed(2**127 * Q128, 0, 4), 2**129)  # not cut to 128 bits, unlike v3


class V4ReaderTests(unittest.TestCase):
    def setUp(self):
        self.chain = Chain(self)
        self.position = V4Position(self.chain)
        self.ref = PositionRef(DEX_V4, self.chain.profile.uniswap.v4.positionManager, 7)

    def test_a_position_reads_owner_custody_range_liquidity_and_fees(self):
        self.position.last = ((2**256 - Q128), 4 * Q128)  # the first counter wrapped since the checkpoint
        reader = self.chain.reader()
        block = reader.head()
        state = reader.position(self.ref, block)
        self.assertEqual((state.owner, state.approved, state.subscriber), (OWNER, ZERO, ZERO))
        self.assertEqual(state.pool.pool, PoolRef(DEX_V4, TOKEN_A, TOKEN_B, 3000, 60))
        self.assertEqual((state.tick_lower, state.tick_upper, state.liquidity), (-600, 600, 10**18))
        self.assertEqual(state.fees_owed, (6 * 10**18, 5 * 10**18))
        self.assertEqual((state.pool.sqrt_price_x96, state.pool.tick, state.pool.liquidity), (2**96, 0, 4 * 10**18))
        self.assertEqual((state.pool.pool_id, state.pool.address, state.block), (self.position.pool_id, None, block))
        self.assertTrue(state.in_range)
        self.assertEqual(list(state.principal()), principal_amounts({'sqrtPriceX96': str(2**96)}, -600, 600, 10**18))
        self.assertEqual(self.chain.fake.calls('eth_chainId'), [])

    def test_custody_facts_and_their_consistency(self):
        self.position.approved, self.position.subscriber = OTHER, OTHER
        reader = self.chain.reader()
        state = reader.position(self.ref, reader.head())
        self.assertEqual((state.approved, state.subscriber), (OTHER, OTHER))
        self.position.info_word = self.position.info(7)[1] & ~0xff  # the flag says no subscriber
        with self.assertRaisesRegex(DataError, '^v4_position_subscriber_mismatch$'):
            reader.position(self.ref, reader.head())

    def test_inconsistent_or_missing_positions_are_refused(self):
        cases = (
            ('v2_position_not_found', lambda p: setattr(p, 'token_id', 8)),
            ('v4_position_liquidity_mismatch', lambda p: setattr(p, 'core_liquidity', 1)),
            ('v4_position_pool_mismatch', lambda p: setattr(p, 'info_word', p.info(7)[1] ^ (1 << 100))),
            ('v2_invalid_position_range', lambda p: setattr(p, 'lower', -590)),  # off the spacing
            ('v2_invalid_position_range', lambda p: setattr(p, 'lower', -887280)),  # aligned, beyond MIN_TICK
            ('v2_position_has_no_owner', lambda p: setattr(p, 'owner', ZERO)),
            ('v2_invalid_pool_state', lambda p: setattr(p, 'slot0', (2**96, 0, 1001, 3000))),
        )
        for code, mutate in cases:
            position = V4Position(Chain(self))
            mutate(position)
            reader = position.chain.reader()
            ref = PositionRef(DEX_V4, position.chain.profile.uniswap.v4.positionManager, 7)
            with self.subTest(code=code), self.assertRaisesRegex(DataError, f'^{code}$'):
                reader.position(ref, reader.head())

    def test_a_pool_read_reports_the_swap_fee_with_the_protocol_fee(self):
        self.position.slot0 = (2**96 * 2, 13863, (500 << 12) | 1000, 3000)
        reader = self.chain.reader()
        state = reader.pool(PoolRef(DEX_V4, *self.position.key), reader.head())
        self.assertEqual((state.sqrt_price_x96, state.tick, state.fee_pips, state.liquidity), (2**97, 13863, 3000, 4 * 10**18))
        # ProtocolFeeLibrary.calculateSwapFee: protocol + lp - protocol * lp / 1e6, rounded down.
        self.assertEqual((state.swap_fee_pips(True), state.swap_fee_pips(False)), (3997, 3499))
        self.position.slot0 = (2**96, 0, 0, 500)
        state = reader.pool(PoolRef(DEX_V4, *self.position.key), reader.head())
        self.assertEqual((state.swap_fee_pips(True), state.swap_fee_pips(False)), (500, 500))
        with self.assertRaisesRegex(DataError, '^v2_pool_not_found$'):
            reader.pool(PoolRef(DEX_V4, TOKEN_A, TOKEN_B, 500, 10), reader.head())

    def test_code_is_proven_once_per_process_from_the_block_it_was_proven_at(self):
        reader = self.chain.reader()
        block = reader.head()
        reader.position(self.ref, block)
        self.assertEqual(len(self.chain.fake.calls('eth_getCode')), 2)  # the position manager and StateView
        self.chain.reader().position(self.ref, block)  # a new reader in the same process
        self.assertEqual(len(self.chain.fake.calls('eth_getCode')), 2)
        older = Block(block.number - 1, '0x' + 'cc' * 32, block.timestamp - 2)
        self.chain.fake.blocks[older.tag] = {'number': older.tag, 'hash': older.hash, 'timestamp': hex(older.timestamp)}
        reader.position(self.ref, older)  # before what was proven: proven again
        self.assertEqual(len(self.chain.fake.calls('eth_getCode')), 4)
        self.chain.fake.codes[self.chain.profile.uniswap.v4.stateView] = '0x00'
        fresh = Chain(self)
        fresh.fake.codes[fresh.profile.uniswap.v4.stateView] = '0x00'
        V4Position(fresh)
        reader = fresh.reader()
        with self.assertRaisesRegex(DataError, '^v2_deployment_code_mismatch$'):
            reader.position(PositionRef(DEX_V4, fresh.profile.uniswap.v4.positionManager, 7), reader.head())

    def test_a_followed_head_reads_with_no_head_or_chain_call(self):
        anchor = parse_block(HEAD)
        reader = self.chain.reader(anchor=anchor)
        reader.position(self.ref, anchor)
        self.assertEqual({method for _, method, _ in self.chain.fake.log}, {'eth_getCode', 'eth_call'})
        self.assertEqual(self.chain.endpoints.calls(), {'stack': 2 + 1 + 8})
        self.chain.fake.log.clear()
        reader.position(self.ref, anchor)
        self.assertEqual(self.chain.endpoints.calls(), {'stack': 11 + 9})  # no code, no head: 1 + 8 calls
        reader.assert_canonical(anchor)
        self.chain.fake.blocks[anchor.tag] = {**HEAD, 'hash': '0x' + 'cd' * 32}
        with self.assertRaisesRegex(DataError, '^snapshot_reorganized$'):
            reader.assert_canonical(anchor)

    def test_a_positions_liquidity_alone_costs_one_call(self):
        anchor = parse_block(HEAD)
        reader = self.chain.reader(anchor=anchor)
        self.assertEqual(reader.position_liquidity(self.ref, anchor), 10**18)
        self.assertEqual(self.chain.endpoints.calls(), {'stack': 2 + 1})  # the code once a process
        self.position.liquidity = 0  # decreased to nothing, or burned: Uniswap reads a cleared token's as zero
        self.assertEqual(reader.position_liquidity(self.ref, anchor), 0)
        self.assertEqual(self.chain.endpoints.calls(), {'stack': 2 + 1 + 1})
        self.assertEqual(self.chain.fake.log[-1][2][0]['data'][:10],
                         function('IV4PositionManagerMinimal', 'getPositionLiquidity').selector)
        with self.assertRaisesRegex(DataError, '^v2_position_manager_unknown$'):
            reader.position_liquidity(PositionRef(DEX_V3, self.ref.position_manager, 7), anchor)
        with self.assertRaisesRegex(DataError, '^v2_invalid_position_ref$'):
            reader.position_liquidity((DEX_V4, self.ref.position_manager, 7), anchor)

    def test_an_unpinned_block_is_pinned_and_proven_first(self):
        reader = self.chain.reader()
        block = parse_block(HEAD)
        reader.position(self.ref, block)
        self.assertEqual(self.chain.fake.log[0][1:], ('eth_getBlockByNumber', [block.tag, False]))
        moved = Block(block.number, '0x' + '99' * 32, block.timestamp)
        with self.assertRaisesRegex(DataError, '^snapshot_reorganized$'):
            self.chain.reader().position(self.ref, moved)
        with self.assertRaisesRegex(DataError, '^block_unavailable$'):
            reader.position(self.ref, HEAD)

    def test_the_reader_only_uses_a_client_of_its_chain_and_its_managers(self):
        robinhood = load_registry().chain('robinhood-4663')
        with self.assertRaisesRegex(DataError, '^v2_rpc_chain_mismatch$'):
            UniswapReader(robinhood, self.chain.endpoints.read_rpc())
        with self.assertRaisesRegex(DataError, '^v2_chain_profile_required$'):
            UniswapReader('base-8453', self.chain.endpoints.read_rpc())
        reader = self.chain.reader()
        block = reader.head()
        for ref in (PositionRef(DEX_V4, robinhood.uniswap.v4.positionManager, 7),
                    PositionRef(DEX_V3, self.chain.profile.uniswap.v4.positionManager, 7)):
            with self.subTest(ref=ref), self.assertRaisesRegex(DataError, '^v2_position_manager_unknown$'):
                reader.position(ref, block)
        with self.assertRaisesRegex(DataError, '^v2_invalid_position_ref$'):
            reader.position((DEX_V4, self.ref.position_manager, 7), block)
        with self.assertRaisesRegex(DataError, '^v2_invalid_pool_ref$'):
            reader.pool((DEX_V4, TOKEN_A, TOKEN_B, 500, 10, ZERO), block)


class V3ReaderTests(unittest.TestCase):
    def setUp(self):
        self.chain = Chain(self)
        self.ref = PositionRef(DEX_V3, self.chain.profile.uniswap.v3.positionManager, 11)

    def read(self, position):
        reader = position.chain.reader()
        ref = PositionRef(DEX_V3, position.chain.profile.uniswap.v3.positionManager, position.token_id)
        return reader.position(ref, reader.head())

    def test_fees_owed_add_the_growth_since_the_managers_checkpoint(self):
        cases = (  # tick, expected inside growth per currency
            (0, (100 - 30 - 20, 50 - 5 - 6)),  # inside the range
            (-700, (30 - 20, 5 - 4)),  # below the range
            (700, (20 - 30 + 2**128, 6 - 5 + 2**128)),  # above the range (wraps)
        )
        for tick, inside in cases:
            position = V3Position(Chain(self), tick=tick, growth=(100 * Q128, 50 * Q128), below=(30 * Q128, 5 * Q128),
                                  above=(20 * Q128, 6 * Q128), last=(1 * Q128, 2 * Q128), owed=(7, 9))
            if tick == -700:
                position.outside[600] = (20 * Q128, 4 * Q128)
            with self.subTest(tick=tick):
                state = self.read(position)
                expected = tuple(v3_fees_owed(owed, (growth * Q128) & U256, last, 10**18)
                                 for owed, growth, last in zip((7, 9), inside, (Q128, 2 * Q128)))
                self.assertEqual(state.fees_owed, expected)
                self.assertEqual(state.in_range, tick == 0)

    def test_a_position_reads_owner_approval_pool_and_principal(self):
        position = V3Position(self.chain, tick=60, growth=(10 * Q128, 0), owed=(3, 4))
        position.operator = OTHER
        position.fee_protocol = 4 | (5 << 4)
        state = self.read(position)
        self.assertEqual((state.owner, state.approved, state.subscriber), (OWNER, OTHER, None))
        self.assertEqual(state.pool.pool, PoolRef(DEX_V3, TOKEN_A, TOKEN_B, 3000, 60))
        self.assertEqual((state.pool.address, state.pool.pool_id, state.pool.liquidity), (position.pool, None, 3 * 10**18))
        self.assertEqual(state.fees_owed, (3 + 10 * 10**18, 4))
        self.assertEqual(state.pool.swap_fee_pips(True), 3000)  # v3's protocol fee is a share of the fee
        self.assertEqual(list(state.principal()),
                         principal_amounts({'sqrtPriceX96': str(sqrt_at_tick(60))}, -600, 600, 10**18))
        self.assertEqual(self.chain.fake.calls('eth_chainId'), [])

    def test_a_positions_liquidity_alone_costs_one_call(self):
        V3Position(self.chain, liquidity=5 * 10**17)
        anchor = parse_block(HEAD)
        reader = self.chain.reader(anchor=anchor)
        self.assertEqual(reader.position_liquidity(self.ref, anchor), 5 * 10**17)
        self.assertEqual(self.chain.endpoints.calls(), {'stack': 2 + 1})  # the code once a process
        self.assertEqual(self.chain.fake.log[-1][2][0]['data'][:10],
                         function('IUniswapV3PositionManagerMinimal', 'positions').selector)
        # A token the manager does not know (burned) reverts, as position() does.
        with self.assertRaisesRegex(DataError, '^rpc_call_reverted$'):
            reader.position_liquidity(PositionRef(DEX_V3, self.ref.position_manager, 12), anchor)

    def test_a_fee_tier_the_profile_does_not_list_is_asked_of_the_factory(self):
        position = V3Position(self.chain, fee=300, spacing=6, lower=-600, upper=600)
        state = self.read(position)
        self.assertEqual(state.pool.pool, PoolRef(DEX_V3, TOKEN_A, TOKEN_B, 300, 6))
        factory = self.chain.profile.uniswap.v3.factory
        self.assertIn(factory, [params[0]['to'] for _, method, params in self.chain.fake.log if method == 'eth_call'])

    def test_unknown_inconsistent_or_misaligned_positions_are_refused(self):
        cases = {
            'rpc_call_reverted': lambda p: setattr(p, 'token_id', 12),  # the manager does not know it
            'v3_position_state_inconsistent': lambda p: p.initialized.update({600: False}),
            'v2_invalid_position_range': lambda p: setattr(p, 'upper', 590),
            'v2_position_has_no_owner': lambda p: setattr(p, 'owner', ZERO),
            'v2_invalid_pool_state': lambda p: setattr(p, 'fee_protocol', 3),
        }
        for code, mutate in cases.items():
            chain = Chain(self)
            position = V3Position(chain)
            mutate(position)
            reader = chain.reader()
            with self.subTest(code=code), self.assertRaisesRegex(DataError, f'^{code}$'):
                reader.position(PositionRef(DEX_V3, chain.profile.uniswap.v3.positionManager, 11), reader.head())
        # Liquidity zero: the ticks need not be initialized, fees owed are tokensOwed.
        chain = Chain(self)
        position = V3Position(chain, liquidity=0, owed=(5, 6))
        position.initialized = {}
        self.assertEqual(self.read(position).fees_owed, (5, 6))

    def test_pool_reads_prove_the_factory_address_and_spacing(self):
        position = V3Position(self.chain)
        reader = self.chain.reader()
        block = reader.head()
        state = reader.pool(PoolRef(DEX_V3, TOKEN_A, TOKEN_B, 3000, 60), block)
        self.assertEqual((state.address, state.sqrt_price_x96, state.fee_pips), (position.pool, sqrt_at_tick(0), 3000))
        with self.assertRaisesRegex(DataError, '^v3_tick_spacing_mismatch$'):
            reader.pool(PoolRef(DEX_V3, TOKEN_A, TOKEN_B, 3000, 10), block)
        position.spacings[500] = 10  # 500 is enabled, but nobody created this pair's pool
        for fee in (500, 100):
            with self.subTest(fee=fee), self.assertRaisesRegex(DataError, '^v2_pool_not_found$'):
                reader.pool(PoolRef(DEX_V3, TOKEN_A, TOKEN_B, fee, 10), block)
        position.pool = '0x' + '99' * 20  # the factory knows another address
        with self.assertRaisesRegex(DataError, '^v3_pool_address_mismatch$'):
            reader.pool(PoolRef(DEX_V3, TOKEN_A, TOKEN_B, 3000, 60), block)
        position.pool = v3_pool_address(self.chain.profile, TOKEN_A, TOKEN_B, 3000)
        position.sqrt = 0
        with self.assertRaisesRegex(DataError, '^v2_pool_not_initialized$'):
            reader.pool(PoolRef(DEX_V3, TOKEN_A, TOKEN_B, 3000, 60), block)


class RealPositionReplayTests(unittest.TestCase):
    """Three real Base v3 positions: what the reader computes from state equals
    what the deployed position manager's own collect delivered at that block."""
    FIXTURE = Path(__file__).resolve().parent / 'fixtures/v2-base-v3-positions.json'

    def replay(self, position):
        chain = load_registry().chain('base-8453')
        v3 = chain.uniswap.v3
        block = position['block']
        number, recorded = int(block['number'], 16), position['responses']
        token_id = position['tokenId']
        positions = function('IUniswapV3PositionManagerMinimal', 'positions').decode(recorded['positions'])
        lower, upper = positions[5], positions[6]
        answers = {(v3.positionManager, function('IUniswapV3PositionManagerMinimal', 'positions').calldata(token_id)):
                   recorded['positions'],
                   (v3.positionManager, function('IUniswapV3PositionManagerMinimal', 'ownerOf').calldata(token_id)):
                   recorded['ownerOf']}
        pool = position['pool']
        for name, args, key in (('slot0', (), 'slot0'), ('liquidity', (), 'liquidity'),
                                ('feeGrowthGlobal0X128', (), 'feeGrowthGlobal0X128'),
                                ('feeGrowthGlobal1X128', (), 'feeGrowthGlobal1X128'),
                                ('ticks', (lower,), 'ticksLower'), ('ticks', (upper,), 'ticksUpper')):
            answers[(pool, function('IUniswapV3PoolMinimal', name).calldata(*args))] = recorded[key]

        def send(url, body):
            replies = []
            for item in body if isinstance(body, list) else [body]:
                method, params = item['method'], item['params']
                if method == 'eth_getBlockByNumber':
                    self.assertEqual(params[0], block['number'])
                    result = block
                else:
                    self.assertEqual((method, params[1]), ('eth_call', block['number']))
                    result = answers[(params[0]['to'], params[0]['data'])]
                replies.append({'jsonrpc': '2.0', 'id': item['id'], 'result': result})
            return replies if isinstance(body, list) else replies[0]
        endpoints = ChainEndpoints(chain, (endpoint(),), 'replay', send=send)
        for contract in (v3.factory, v3.positionManager):  # proven on chain by the profile itself
            endpoints.code.record(contract, chain.verified_codehash(contract), 0)
        reader = UniswapReader(chain, endpoints.read_rpc(batch_reads=True))
        pinned = Block(number, block['hash'], int(block['timestamp'], 16))
        return reader.position(PositionRef(DEX_V3, v3.positionManager, token_id), pinned)

    def test_fees_owed_equal_the_position_managers_collect(self):
        import json
        fixture = json.loads(self.FIXTURE.read_text())
        cases = {'in range': 0, 'above the range': 0}
        for position in fixture['positions']:
            with self.subTest(token=position['tokenId']):
                state = self.replay(position)
                self.assertEqual(state.fees_owed, tuple(int(amount) for amount in position['collect']))
                self.assertEqual((state.owner, state.pool.address, state.pool.tick),
                                 (position['owner'], position['pool'], position['tick']))
                self.assertGreater(state.liquidity, 0)
                cases['in range' if state.in_range else 'above the range'] += 1
                if state.in_range:
                    self.assertTrue(all(fee > 0 for fee in state.fees_owed))
                else:
                    self.assertEqual(state.pool.tick, state.tick_upper)  # the boundary belongs above
        self.assertEqual(cases, {'in range': 2, 'above the range': 1})


if __name__ == '__main__':
    unittest.main()
