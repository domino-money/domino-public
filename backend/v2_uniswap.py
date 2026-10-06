"""Uniswap v3 and v4 pool and position reads for Domino V2, on any profiled chain.

What the planner, the indexer and the read path need from a pool or a position,
read at one pinned block through a chain-verified client (v2_rpc), with the
frozen minimal ABIs (v2_abi), at the profile's addresses (v2_chains):

- a pool: its PoolRef (DominoV2Types: dex, currencies, fee, tick spacing,
  hooks), the spot sqrt price and tick, the active liquidity, and the fee a
  swap pays in each direction, the protocol fee included (F0: it counts in the
  swap floor);
- a position: its PositionRef (dex, position manager, token id), the owner,
  the token's individual approval and, on v4, its subscriber (the V2 custody
  facts), the pool, the range, the liquidity and the fees owed now.

Fees owed are what a collect would deliver at that block. On v4 they are the
StateView fee growth inside the range since the position's checkpoint, times its
liquidity (Position.update). On v3 they are the position manager's tokensOwed
plus the growth since the manager's own checkpoint, recomputed from the pool's
ticks as Tick.getFeeGrowthInside and NonfungiblePositionManager.collect do,
with the same 128-bit truncation. Several v3 NFTs with one range share one pool
position, so the manager's per-token checkpoint is the one that counts.

Every address comes from the profile: a v3 pool is the CREATE2 address of its
factory and init code hash (the position manager derives the same one), a v4
pool is its PoolKey hash. A reader proves the code hashes the profile recorded
for the contracts it calls, once per process through the chain's code cache
(v2_rpc); the v4 position manager and StateView embed their PoolManager, so that
also proves the links, and a wrong chain fails here. Reads use block numbers the
client has pinned, such as the chain follower's head (v2_head); a caller about
to act on a read calls assert_canonical after its last one. Nothing here signs,
simulates or writes.
"""
from dataclasses import dataclass
import re

from eth_abi import encode
from eth_hash.auto import keccak

from discovery import ZERO, Block, DataError, address, parse_block, prefetched
from v2_abi import function
from v2_chains import DEX_V3, DEX_V4, ChainProfile
from v2_rpc import CodeCache, batched_reads
from v4_math import MAX_SQRT, MIN_SQRT, Q128, U256, amount_delta, sqrt_at_tick

U128 = (1 << 128) - 1
PIPS = 1_000_000
MIN_TICK, MAX_TICK = -887272, 887272
# LPFeeLibrary.DYNAMIC_FEE_FLAG: the pool's hook sets the LP fee.
DYNAMIC_FEE = 0x800000
POOL_KEY_TYPES = ('address', 'address', 'uint24', 'int24', 'address')

V3_FACTORY = 'IUniswapV3FactoryMinimal'
V3_POOL = 'IUniswapV3PoolMinimal'
V3_MANAGER = 'IUniswapV3PositionManagerMinimal'
V4_MANAGER = 'IV4PositionManagerMinimal'
V4_STATE = 'IV4StateViewMinimal'


def _int(value, low, high):
    return type(value) is int and low <= value <= high


@dataclass(frozen=True)
class PoolRef:
    """DominoV2Types.PoolRef. On v3 the fee selects the pool, the tick spacing
    is the factory's for that fee and hooks is zero; native currency is
    address(0) on v4 only, v3 uses the wrapped token."""
    dex: int
    currency0: str
    currency1: str
    fee: int
    tick_spacing: int
    hooks: str = ZERO

    def __post_init__(self):
        for name in ('currency0', 'currency1', 'hooks'):
            object.__setattr__(self, name, address(getattr(self, name)))
        if self.dex == DEX_V3:
            valid = (self.currency0 != ZERO and self.hooks == ZERO and _int(self.fee, 0, PIPS - 1)
                     and _int(self.tick_spacing, 1, 16383))
        elif self.dex == DEX_V4:
            valid = ((_int(self.fee, 0, PIPS) or self.fee == DYNAMIC_FEE) and type(self.fee) is int
                     and _int(self.tick_spacing, 1, 32767))
        else:
            valid = False
        if not valid or type(self.dex) is not int or self.currency0 >= self.currency1:
            raise DataError('v2_invalid_pool_ref')

    @property
    def dynamic_fee(self):
        return self.dex == DEX_V4 and self.fee == DYNAMIC_FEE

    @property
    def pool_id(self):
        """The v4 PoolId: keccak256 of the abi-encoded PoolKey."""
        if self.dex != DEX_V4:
            raise DataError('v2_pool_id_is_v4_only')
        return '0x' + keccak(encode(POOL_KEY_TYPES, (self.currency0, self.currency1, self.fee,
                                                     self.tick_spacing, self.hooks))).hex()


@dataclass(frozen=True)
class PositionRef:
    """DominoV2Types.PositionRef: a position NFT, its manager and token id."""
    dex: int
    position_manager: str
    token_id: int

    def __post_init__(self):
        object.__setattr__(self, 'position_manager', address(self.position_manager))
        if type(self.dex) is not int or self.dex not in (DEX_V3, DEX_V4) or not _int(self.token_id, 0, U256):
            raise DataError('v2_invalid_position_ref')


@dataclass(frozen=True)
class PoolState:
    pool: PoolRef
    block: Block
    address: str | None  # the v3 pool contract
    pool_id: str | None  # the v4 pool id
    sqrt_price_x96: int
    tick: int
    liquidity: int  # active liquidity at the spot
    # v3: the pool's fee tier. v4: slot0's LP fee, the current one on a
    # dynamic-fee pool, whose hook may still override it per swap.
    fee_pips: int
    # Raw, as the pool reports it. v3 slot0.feeProtocol: 1/N of the swap fee
    # per input token, token0 in the low 4 bits. v4 slot0.protocolFee: pips
    # per direction, zeroForOne in the low 12 bits, taken before the LP fee.
    protocol_fee: int

    def swap_fee_pips(self, zero_for_one):
        """What a swap in that direction pays, in pips of its input."""
        if self.pool.dex == DEX_V3:
            return self.fee_pips  # v3's protocol fee is a share of this fee, not on top of it
        protocol = self.protocol_fee & 0xfff if zero_for_one else self.protocol_fee >> 12
        # ProtocolFeeLibrary.calculateSwapFee, rounding as the contract does.
        return self.fee_pips if protocol == 0 else protocol + self.fee_pips - protocol * self.fee_pips // PIPS


@dataclass(frozen=True)
class PositionState:
    position: PositionRef
    owner: str
    approved: str  # the token's individual approval; ZERO when none
    subscriber: str | None  # v4: the position's subscriber, ZERO when none; v3 has none
    pool: PoolState
    tick_lower: int
    tick_upper: int
    liquidity: int
    fees_owed: tuple  # raw (amount0, amount1) a collect would deliver at this block
    # v4: the range's fee growth inside now and at the position's checkpoint
    # (X128 per token), from which fees_owed is computed; None on v3.
    fee_growth_inside: tuple | None = None
    fee_growth_inside_last: tuple | None = None

    @property
    def block(self):
        return self.pool.block

    @property
    def in_range(self):
        return self.tick_lower <= self.pool.tick < self.tick_upper

    def principal(self):
        """The raw amounts removing all liquidity at the spot would deliver, before fees."""
        lower, upper = sqrt_at_tick(self.tick_lower), sqrt_at_tick(self.tick_upper)
        price = min(upper, max(lower, self.pool.sqrt_price_x96))
        return (amount_delta(price, upper, self.liquidity, 0, False),
                amount_delta(lower, price, self.liquidity, 1, False))


def v3_pool_address(chain, token0, token1, fee):
    """The pool the v3 factory deployed for this pair and fee (CREATE2)."""
    v3 = chain.uniswap.v3
    salt = keccak(encode(['address', 'address', 'uint24'], [token0, token1, fee]))
    digest = keccak(b'\xff' + bytes.fromhex(v3.factory[2:]) + salt + bytes.fromhex(v3.poolInitCodeHash[2:]))
    return '0x' + digest[12:].hex()


def v3_fee_growth_inside(tick, lower, upper, growth_global, outside_lower, outside_upper):
    """Tick.getFeeGrowthInside (v3-core), modulo 2**256 as its 0.7.6 source wraps."""
    below = outside_lower if tick >= lower else (growth_global - outside_lower) & U256
    above = outside_upper if tick < upper else (growth_global - outside_upper) & U256
    return (growth_global - below - above) & U256


def v3_fees_owed(tokens_owed, inside, inside_last, liquidity):
    """NonfungiblePositionManager.collect: tokensOwed plus the growth since the
    manager's checkpoint times liquidity. The 0.7.6 source wraps the growth
    difference in 256 bits, cuts the product to uint128 and adds in 128 bits;
    taken modulo 2**128 at the end, that is exactly this integer arithmetic,
    since a 2**256 wrap of the difference adds a multiple of 2**128 here."""
    return (tokens_owed + (inside - inside_last) * liquidity // Q128) & U128


def v4_fees_owed(inside, inside_last, liquidity):
    """Position.update (v4-core): the growth since the checkpoint times liquidity."""
    return ((inside - inside_last) & U256) * liquidity // Q128


def _signed24(word):
    word &= 0xffffff
    return word - (1 << 24) if word & (1 << 23) else word


def _range(lower, upper, spacing):
    if (not _int(lower, MIN_TICK, MAX_TICK) or not _int(upper, MIN_TICK, MAX_TICK) or lower >= upper
            or lower % spacing or upper % spacing):
        raise DataError('v2_invalid_position_range')


class UniswapReader:
    """Pool and position reads on one chain, at blocks the client has pinned."""

    def __init__(self, chain, rpc):
        if not isinstance(chain, ChainProfile):
            raise DataError('v2_chain_profile_required')
        # The client must be bound to this chain: v2_rpc's clients carry the
        # profile's id, and the code proofs below fail on any other chain.
        if getattr(rpc, 'chain_id', None) != chain.chainId:
            raise DataError('v2_rpc_chain_mismatch')
        self.chain, self.rpc = chain, rpc
        # The chain's process-wide cache when the client has one (v2_rpc).
        self.code = getattr(rpc, 'code_cache', None) or CodeCache()

    def head(self):
        return parse_block(self.rpc.request('eth_getBlockByNumber', ['latest', False]))

    def assert_canonical(self, block):
        """Refuse unless `block` is still the canonical block at its height."""
        if parse_block(self.rpc.request('eth_getBlockByNumber', [block.tag, False])) != block:
            raise DataError('snapshot_reorganized')

    def _prepare(self, block, dex):
        """Pin the block, then prove the code of the version's contracts unless
        the chain's cache already proved it at this block or an earlier one."""
        if not isinstance(block, Block):
            raise DataError('block_unavailable')
        anchors = getattr(self.rpc, 'anchors', None)
        if not isinstance(anchors, dict) or anchors.get(block.tag) != block:
            self.assert_canonical(block)
        uniswap = self.chain.uniswap
        contracts = ((uniswap.v3.factory, uniswap.v3.positionManager) if dex == DEX_V3 else
                     (uniswap.v4.positionManager, uniswap.v4.stateView))
        expected = {contract: self.chain.verified_codehash(contract) for contract in contracts}
        unproven = [c for c in contracts if not self.code.proven(c, expected[c], block.number)]
        if not unproven:
            return
        codes = batched_reads(self.rpc, [('eth_getCode', [contract, block.tag]) for contract in unproven])
        for contract, raw in zip(unproven, codes):
            code = prefetched(raw)
            if (type(code) is not str or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})+', code)
                    or '0x' + keccak(bytes.fromhex(code[2:])).hex() != expected[contract]):
                raise DataError('v2_deployment_code_mismatch')
            self.code.record(contract, expected[contract], block.number)

    def _raw(self, block, calls):
        gas = hex(self.rpc.call_gas_limit)
        specs = [('eth_call', [{'to': target, 'data': fn.calldata(*args), 'gas': gas}, block.tag])
                 for target, fn, args in calls]
        return batched_reads(self.rpc, specs)

    def _calls(self, block, calls):
        return [fn.decode(prefetched(raw)) for (_, fn, _), raw in zip(calls, self._raw(block, calls))]

    # ------------------------------------------------------------------ pools
    def _v3_state(self, ref, block, pool, slot0, liquidity):
        sqrt_price, tick, _, _, _, protocol, _ = slot0
        if sqrt_price == 0:
            raise DataError('v2_pool_not_initialized')
        if (not MIN_SQRT <= sqrt_price < MAX_SQRT or not _int(tick, MIN_TICK, MAX_TICK)
                or any(side not in (0, *range(4, 11)) for side in (protocol & 0xf, protocol >> 4))):
            raise DataError('v2_invalid_pool_state')
        return PoolState(ref, block, pool, None, sqrt_price, tick, liquidity, ref.fee, protocol)

    def _v4_state(self, ref, block, slot0, liquidity):
        sqrt_price, tick, protocol, lp_fee = slot0
        if sqrt_price == 0:
            raise DataError('v2_pool_not_found')
        if (not MIN_SQRT <= sqrt_price < MAX_SQRT or not _int(tick, MIN_TICK, MAX_TICK)
                or protocol & 0xfff > 1000 or protocol >> 12 > 1000 or lp_fee > PIPS):
            raise DataError('v2_invalid_pool_state')
        return PoolState(ref, block, None, ref.pool_id, sqrt_price, tick, liquidity, lp_fee, protocol)

    def pool(self, ref, block):
        if not isinstance(ref, PoolRef):
            raise DataError('v2_invalid_pool_ref')
        self._prepare(block, ref.dex)
        if ref.dex == DEX_V4:
            pool_id = bytes.fromhex(ref.pool_id[2:])
            state = self.chain.uniswap.v4.stateView
            slot0, (liquidity,) = self._calls(block, [(state, function(V4_STATE, 'getSlot0'), (pool_id,)),
                                                      (state, function(V4_STATE, 'getLiquidity'), (pool_id,))])
            return self._v4_state(ref, block, slot0, liquidity)
        factory = self.chain.uniswap.v3.factory
        pool = v3_pool_address(self.chain, ref.currency0, ref.currency1, ref.fee)
        calls = [(factory, function(V3_FACTORY, 'getPool'), (ref.currency0, ref.currency1, ref.fee)),
                 (factory, function(V3_FACTORY, 'feeAmountTickSpacing'), (ref.fee,)),
                 (pool, function(V3_POOL, 'slot0'), ()), (pool, function(V3_POOL, 'liquidity'), ())]
        raw = self._raw(block, calls)
        deployed, = calls[0][1].decode(prefetched(raw[0]))
        spacing, = calls[1][1].decode(prefetched(raw[1]))
        if address(deployed) == ZERO:
            raise DataError('v2_pool_not_found')  # a fee tier not enabled has no pool either
        if address(deployed) != pool:
            raise DataError('v3_pool_address_mismatch')
        if spacing != ref.tick_spacing:
            raise DataError('v3_tick_spacing_mismatch')
        slot0, (liquidity,) = (fn.decode(prefetched(item)) for (_, fn, _), item in zip(calls[2:], raw[2:]))
        return self._v3_state(ref, block, pool, slot0, liquidity)

    # -------------------------------------------------------------- positions
    def _position_ref(self, ref, block):
        if not isinstance(ref, PositionRef):
            raise DataError('v2_invalid_position_ref')
        managers = {DEX_V3: self.chain.uniswap.v3.positionManager, DEX_V4: self.chain.uniswap.v4.positionManager}
        if ref.position_manager != managers[ref.dex]:
            raise DataError('v2_position_manager_unknown')
        self._prepare(block, ref.dex)

    def position(self, ref, block):
        self._position_ref(ref, block)
        return self._v3_position(ref, block) if ref.dex == DEX_V3 else self._v4_position(ref, block)

    def position_liquidity(self, ref, block):
        """A position's liquidity alone, in one call: v3's positions(tokenId), v4's getPositionLiquidity(tokenId).
        A v3 token the manager does not know reverts, as in position(); on v4 Uniswap clears a burned token's info
        and reads its liquidity as zero."""
        self._position_ref(ref, block)
        if ref.dex == DEX_V3:
            position, = self._calls(block, [(ref.position_manager, function(V3_MANAGER, 'positions'), (ref.token_id,))])
            return position[7]
        (liquidity,), = self._calls(block, [(ref.position_manager, function(V4_MANAGER, 'getPositionLiquidity'),
                                             (ref.token_id,))])
        return liquidity

    def _v3_position(self, ref, block):
        manager, factory = self.chain.uniswap.v3.positionManager, self.chain.uniswap.v3.factory
        # A token the manager does not know reverts: reported as that revert,
        # never read as burned (the same rule as the V1 NFT reader).
        (_, operator, token0, token1, fee, lower, upper, liquidity, last0, last1, owed0, owed1), = self._calls(
            block, [(manager, function(V3_MANAGER, 'positions'), (ref.token_id,))])
        spacing = self.chain.v3_tick_spacing(fee)
        pool = v3_pool_address(self.chain, token0, token1, fee)
        calls = [(manager, function(V3_MANAGER, 'ownerOf'), (ref.token_id,)),
                 (pool, function(V3_POOL, 'slot0'), ()), (pool, function(V3_POOL, 'liquidity'), ()),
                 (pool, function(V3_POOL, 'feeGrowthGlobal0X128'), ()),
                 (pool, function(V3_POOL, 'feeGrowthGlobal1X128'), ()),
                 (pool, function(V3_POOL, 'ticks'), (lower,)), (pool, function(V3_POOL, 'ticks'), (upper,))]
        if spacing is None:
            calls.append((factory, function(V3_FACTORY, 'feeAmountTickSpacing'), (fee,)))
        results = self._calls(block, calls)
        (owner,), slot0, (active,), (global0,), (global1,), below, above = results[:7]
        if spacing is None:
            spacing, = results[7]
        pool_ref = PoolRef(DEX_V3, token0, token1, fee, spacing)
        _range(lower, upper, spacing)
        state = self._v3_state(pool_ref, block, pool, slot0, active)
        # A live range has both ticks initialized; otherwise the pool is not this position's.
        if liquidity and not (below[7] and above[7]):
            raise DataError('v3_position_state_inconsistent')
        inside = [v3_fee_growth_inside(state.tick, lower, upper, growth, below[2 + i], above[2 + i])
                  for i, growth in enumerate((global0, global1))]
        fees = (v3_fees_owed(owed0, inside[0], last0, liquidity), v3_fees_owed(owed1, inside[1], last1, liquidity))
        owner = address(owner)
        if owner == ZERO:
            raise DataError('v2_position_has_no_owner')
        return PositionState(ref, owner, address(operator), None, state, lower, upper, liquidity, fees)

    def _v4_position(self, ref, block):
        manager, view = self.chain.uniswap.v4.positionManager, self.chain.uniswap.v4.stateView
        (key, info), = self._calls(block, [(manager, function(V4_MANAGER, 'getPoolAndPositionInfo'), (ref.token_id,))])
        # Uniswap clears the info on burn; a token never minted has none either.
        if info == 0:
            raise DataError('v2_position_not_found')
        pool_ref = PoolRef(DEX_V4, *key)
        lower, upper = _signed24(info >> 8), _signed24(info >> 32)
        if info >> 56 != int(pool_ref.pool_id, 16) >> 56:
            raise DataError('v4_position_pool_mismatch')
        _range(lower, upper, pool_ref.tick_spacing)
        pool_id, salt = bytes.fromhex(pool_ref.pool_id[2:]), ref.token_id.to_bytes(32, 'big')
        (owner,), (approved,), (subscriber,), (liquidity,), slot0, (active,), core, inside = self._calls(block, [
            (manager, function(V4_MANAGER, 'ownerOf'), (ref.token_id,)),
            (manager, function(V4_MANAGER, 'getApproved'), (ref.token_id,)),
            (manager, function(V4_MANAGER, 'subscriber'), (ref.token_id,)),
            (manager, function(V4_MANAGER, 'getPositionLiquidity'), (ref.token_id,)),
            (view, function(V4_STATE, 'getSlot0'), (pool_id,)),
            (view, function(V4_STATE, 'getLiquidity'), (pool_id,)),
            (view, function(V4_STATE, 'getPositionInfo'), (pool_id, manager, lower, upper, salt)),
            (view, function(V4_STATE, 'getFeeGrowthInside'), (pool_id, lower, upper))])
        core_liquidity, last0, last1 = core
        if core_liquidity != liquidity:
            raise DataError('v4_position_liquidity_mismatch')
        subscriber = address(subscriber)
        if bool(info & 0xff) != (subscriber != ZERO):
            raise DataError('v4_position_subscriber_mismatch')
        owner = address(owner)
        if owner == ZERO:
            raise DataError('v2_position_has_no_owner')
        state = self._v4_state(pool_ref, block, slot0, active)
        fees = (v4_fees_owed(inside[0], last0, liquidity), v4_fees_owed(inside[1], last1, liquidity))
        return PositionState(ref, owner, address(approved), subscriber, state, lower, upper, liquidity, fees,
                             tuple(inside), (last0, last1))
