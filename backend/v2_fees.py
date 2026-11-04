"""The V2 fee follower: Fees earned and Your APR for Domino V2 positions (read-v6 position-fees).

Item 3.1, path B (the owner delegated it; decided 3 Nov 2026,
docs/v2/V2_FEES.md). Per chain, one follower keeps, for every position the V2
index knows (domino_v2.positions: S1's, vault roots and successors), its own
Uniswap events, what each settlement paid in fees, points of its fees earned
over time and its state now, so read-v6 answers Fees earned 24H/7D/30D/All and
Your APR from storage, with no provider call per visit. Uniswap v3 and v4.

The fees are the position's own state, as Uniswap computes them. A settlement
(an increase, a decrease or a collect) pays what accrued since the previous
one: the liquidity before it times the change of the position's fee growth
inside (its feeGrowthInsideLast), 2^128 apart, per token (v4 Position.update,
v3 NonfungiblePositionManager), read at the end of the settlement's block. On
v3 the manager's tokensOwed is also read: the fees are what it gained beyond
the principal a decrease left and what a collect took, which stays exact when
several of the position's events share a block; the growth product checks it
when it can be computed. Fees earned at a block are the fees settled since the
history's start plus what accrued since the last settlement. Nothing comes from
token transfers, so a manual add or withdrawal, native ETH and a shared
transaction are exact (the app's Robinhood ledger cannot tell those apart).

What it reads, through the V2 chain RPC file's endpoints only (Chainstack
first, Alchemy fallback; never a public RPC by default, never reordered):
- its range's events, in at most three eth_getLogs filters per endpoint
  window (v2_rpc splits a range by the endpoint's maxLogBlocks): v3's manager
  IncreaseLiquidity, DecreaseLiquidity and Collect by token id; the two
  managers' Transfer by token id; v4's PoolManager ModifyLiquidity by pool id
  with the PositionManager as sender, the token id being its salt;
- each block holding a settlement, a point or the cursor: its header, and one
  Multicall3 eth_call with every position's state there (MULTICALL_READS reads
  a call).
The head is never read: a pass targets one of the V2 index's checkpoints (the
indexer already follows the head and proves its hashes), so the follower never
runs ahead of the index and a rewind of the index is seen without a call. A
caught-up pass costs the logs of about a minute, the cursor's header and one
Multicall3 call: about 5 calls a minute and a chain, about 7,200 a day.

Points: one an hour for the last HOURLY_DAYS days, then the first of each UTC
day; older hourly points are thinned to it. While the cursor is the index's
newest checkpoint, the state read there ("now") is stored with the same pass's
events in one transaction, so an answer never adds a newer "now" to an older
history. A position the index learns about after the follower passed its
history (a vault's root minted before the vault) is read back from Domino's
first block in its own ranges ("reading") until it reaches the cursor. A
position minted before Domino's first block starts there: what it owed then is
not counted (`since` kind `floor`).

Reorganizations: the cursor is always one of the index's checkpoints. When the
index rewinds past it, the follower deletes every row above the newest
checkpoint still standing, as the index does, and reads on from there. Each
event's block hash must be its header's, and the target's header must be the
checkpoint's; a commit holds the checkpoint against the index's deletion until
it is written.

CLI: `follow` (the unit domino-v2-fees@<chain>), `step`, `status`.
"""
import argparse
from contextlib import contextmanager
from dataclasses import dataclass, field, replace
import json
import re
import sys
import time

from eth_abi import decode, encode
from eth_hash.auto import keccak
import psycopg

from discovery import ZERO, Block, DataError, address, parse_block, quantity
from indexer_io import MAX_CHUNK_EVENTS, read_headers
from v2_abi import function
from v2_chains import DEX_V3, DEX_V4
from v2_quotes import AGGREGATE3, MULTICALL_GAS
from v2_rpc import ChainIndexRpc, _codehash
from v2_uniswap import PoolRef, U128, v3_fee_growth_inside, v3_pool_address
from v4_math import Q128, U256, amount_delta, sqrt_at_tick

# Blocks one step reads: 5 windows of Chainstack's 10,000 per filter, about 28 hours of Base and 3.5 of Arbitrum.
DEFAULT_SPAN, MAX_SPAN = 50_000, 500_000
DEFAULT_MAX_REQUESTS = 400
# Reads one Multicall3 eth_call carries: a v3 position's state is at most 8, so one call reads 64 positions.
MULTICALL_READS = 512
# Token ids or pool ids per filter's topic list.
MAX_FILTER_IDS = 100
# Headers read before the state reads at their blocks: the history client keeps 16 anchors, the highest included.
HEADER_CHUNK = 15
HOURLY_DAYS = 8
HOUR, DAY = 3600, 86400
# A range shorter than this measures its hour's point at its end, as the caught-up pass reads it anyway.
POINT_AT_END_SECONDS = 600
# A step reads at most a day of chain time, so at most 25 points (each a header and a Multicall3 call).
STEP_SECONDS = DAY
# A step that finds more events than MAX_CHUNK_EVENTS, or spends its requests, halves its span down to this.
MIN_SPAN = 1_000
HALVING = ('v2_fee_log_budget_exhausted', 'request_budget_exhausted')
# Advisory key namespace of the fee followers: disjoint from the V2 indexers' (0x4632 << 40).
LOCK_NAMESPACE = 0x4633 << 40
WRITER_STATEMENT_TIMEOUT = '15000ms'

V3_MANAGER = 'IUniswapV3PositionManagerMinimal'
V3_POOL = 'IUniswapV3PoolMinimal'
V3_FACTORY = 'IUniswapV3FactoryMinimal'
V4_MANAGER = 'IV4PositionManagerMinimal'
V4_STATE = 'IV4StateViewMinimal'


def topic(signature):
    return '0x' + keccak(signature.encode()).hex()


# The events, as Uniswap's v3-periphery, ERC-721 and v4-core declare them (tests pin the topics to Uniswap's).
INCREASE = topic('IncreaseLiquidity(uint256,uint128,uint256,uint256)')
DECREASE = topic('DecreaseLiquidity(uint256,uint128,uint256,uint256)')
COLLECT = topic('Collect(uint256,address,uint256,uint256)')
TRANSFER = topic('Transfer(address,address,uint256)')
MODIFY_LIQUIDITY = topic('ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)')
V3_EVENTS = {INCREASE: 'increase', DECREASE: 'decrease', COLLECT: 'collect'}


def word(value):
    """A 32-byte topic of an unsigned integer or an address."""
    if isinstance(value, str):
        return '0x' + '00' * 12 + address(value)[2:]
    return '0x' + value.to_bytes(32, 'big').hex()


# ---------------------------------------------------------------- the logs
@dataclass(frozen=True)
class FeeLog:
    """One of a followed position's own events, decoded strictly."""
    key: tuple  # (dex, token id)
    kind: str  # increase, decrease, collect, modify, transfer
    block_number: int
    block_hash: str
    log_index: int
    tx_hash: str
    delta: int = 0  # the liquidity it added (negative: removed)
    amounts: tuple = (0, 0)  # v3: the principal a decrease left owed, or what a collect took
    sender: str | None = None  # a transfer's from
    recipient: str | None = None  # a transfer's to


def _envelope(raw):
    """The fields every log carries, checked: a removed log, or one without its block, is refused."""
    if (not isinstance(raw, dict) or raw.get('removed') not in (False, None) or not isinstance(raw.get('topics'), list)
            or not isinstance(raw.get('data'), str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*', raw['data'])):
        raise DataError('v2_fee_log_invalid')
    try:
        block, index = quantity(raw.get('blockNumber')), quantity(raw.get('logIndex'))
        block_hash, tx = raw['blockHash'].lower(), raw['transactionHash'].lower()
        topics = [t.lower() for t in raw['topics']]
    except (DataError, KeyError, AttributeError, TypeError):
        raise DataError('v2_fee_log_invalid') from None
    if (not re.fullmatch(r'0x[0-9a-f]{64}', block_hash) or not re.fullmatch(r'0x[0-9a-f]{64}', tx)
            or any(not re.fullmatch(r'0x[0-9a-f]{64}', t) for t in topics)):
        raise DataError('v2_fee_log_invalid')
    return block, index, block_hash, tx, topics, bytes.fromhex(raw['data'][2:])


def _strict(types, data):
    """ABI data decoded, and only if it is exactly the canonical encoding of what it decodes to."""
    try:
        values = decode(list(types), data)
        if encode(list(types), list(values)) != data:
            raise ValueError('not canonical')
    except Exception:
        raise DataError('v2_fee_log_invalid') from None
    return values


def _indexed_uint(value):
    return int(value, 16)


def _indexed_address(value):
    if int(value[2:26], 16):
        raise DataError('v2_fee_log_invalid')
    return '0x' + value[26:]


def decode_fee_log(chain, raw, followed):
    """The log as one of `followed`'s events ({(dex, token id): FeePosition}), or None when it is another
    position's: a token id this manager does not follow, or a v4 position whose salt is not followed."""
    block, index, block_hash, tx, topics, data = _envelope(raw)
    emitter = str(raw.get('address', '')).lower()
    v3, v4 = chain.uniswap.v3, chain.uniswap.v4
    managers = {v3.positionManager: DEX_V3, v4.positionManager: DEX_V4}
    common = {'block_number': block, 'block_hash': block_hash, 'log_index': index, 'tx_hash': tx}
    if topics and topics[0] == TRANSFER and emitter in managers:
        if len(topics) != 4 or data:
            raise DataError('v2_fee_log_invalid')
        key = (managers[emitter], _indexed_uint(topics[3]))
        if key not in followed:
            return None
        return FeeLog(key, 'transfer', sender=_indexed_address(topics[1]), recipient=_indexed_address(topics[2]),
                      **common)
    if topics and topics[0] in V3_EVENTS and emitter == v3.positionManager:
        if len(topics) != 2:
            raise DataError('v2_fee_log_invalid')
        key = (DEX_V3, _indexed_uint(topics[1]))
        kind = V3_EVENTS[topics[0]]
        if kind == 'collect':
            _recipient, amount0, amount1 = _strict(('address', 'uint256', 'uint256'), data)
            delta = 0
        else:
            liquidity, amount0, amount1 = _strict(('uint128', 'uint256', 'uint256'), data)
            delta = liquidity if kind == 'increase' else -liquidity
        if key not in followed:
            return None
        return FeeLog(key, kind, delta=delta, amounts=(amount0, amount1), **common)
    if topics and topics[0] == MODIFY_LIQUIDITY and emitter == v4.poolManager:
        if len(topics) != 3 or _indexed_address(topics[2]) != v4.positionManager:
            raise DataError('v2_fee_log_invalid')
        lower, upper, delta, salt = _strict(('int24', 'int24', 'int256', 'bytes32'), data)
        key = (DEX_V4, int.from_bytes(salt, 'big'))
        position = followed.get(key)
        if position is None:
            return None
        if (topics[1], lower, upper) != (position.pool_key, position.tick_lower, position.tick_upper):
            raise DataError('v2_fee_event_mismatch')
        return FeeLog(key, 'modify', delta=delta, **common)
    raise DataError('v2_fee_log_unexpected')


# ------------------------------------------------------------- fee arithmetic
def growth_fees(dex, liquidity, before, after):
    """Fees a settlement paid: liquidity times the change of the fee growth inside, 2^128 apart, per token, as
    v4's Position.update computes it (in 256 bits) and v3's manager credits it (cut to 128 bits, wrapping)."""
    fees = tuple(((a - b) & U256) * liquidity // Q128 for a, b in zip(after, before))
    return tuple(value & U128 for value in fees) if dex == DEX_V3 else fees


@dataclass(frozen=True)
class Running:
    """A position's state after its last settlement: liquidity, fee growth inside then (the virtual one at
    Domino's first block for a position older than it), v3's tokensOwed, and the fees settled since `since`
    (None from the first settlement whose fees could not be known)."""
    liquidity: int
    last: tuple
    owed: tuple | None
    settled: tuple | None


def settle(dex, before, logs, after):
    """One block's settlements of one position: (fees or None, why or None, the running state after it).

    `logs` are its settlement logs in the block, in order; `after` its state read at the end of the block,
    (liquidity, (last0, last1), owed or None), or None for a v3 position its manager deleted in the block (a
    burn needs liquidity and tokensOwed at zero). The liquidity must add up (`liquidity`: an event was not
    seen). On v4 the fees are known when every log but the last changed no liquidity (the liquidity before
    each is the same, so the growth product spans them); on v3 the manager's tokensOwed accounts for every log,
    and the growth product, where it can be computed, must agree."""
    net = sum(log.delta for log in logs)
    readable = after is not None
    if not readable:
        if dex != DEX_V3:
            raise DataError('v2_fee_position_unreadable')
        after = (0, before.last, (0, 0))
    liquidity, last, owed = after
    state = Running(liquidity, last, owed, before.settled)
    if before.liquidity + net != liquidity:
        return None, 'liquidity', replace(state, settled=None)
    spans = all(log.delta == 0 for log in logs[:-1])
    if dex == DEX_V4:
        if not spans:
            return None, 'same_block', replace(state, settled=None)
        fees = growth_fees(dex, before.liquidity, before.last, last)
    else:
        moved = [sum(log.amounts[i] for log in logs if log.kind == 'collect') -
                 sum(log.amounts[i] for log in logs if log.kind == 'decrease') for i in (0, 1)]
        fees = tuple((owed[i] - before.owed[i] + moved[i]) & U128 for i in (0, 1))
        # A burned token's checkpoint is gone with it; its tokensOwed (zero, as a burn needs) still accounts.
        if spans and readable and growth_fees(dex, before.liquidity, before.last, last) != fees:
            return None, 'liquidity', replace(state, settled=None)
    settled = None if before.settled is None else tuple(a + b for a, b in zip(before.settled, fees))
    return fees, None, replace(state, settled=settled)


def unsettled(dex, liquidity, last, inside):
    """What accrued since the last settlement, at the growth inside now."""
    return growth_fees(dex, liquidity, last, inside)


def principal(sqrt_price, lower, upper, liquidity):
    """The raw amounts removing all liquidity at the spot would deliver, before fees (v2_uniswap's)."""
    low, high = sqrt_at_tick(lower), sqrt_at_tick(upper)
    price = min(high, max(low, sqrt_price))
    return amount_delta(price, high, liquidity, 0, False), amount_delta(low, price, liquidity, 1, False)


# ----------------------------------------------------------------- positions
@dataclass
class FeePosition:
    """A followed position: its identity, how far it is read, and its running state."""
    dex: int
    token_id: int
    pool: dict  # PoolRef as read-v6 writes it
    pool_key: str  # v4 pool id, v3 pool address
    tick_lower: int
    tick_upper: int
    status: str
    through: Block
    running: Running
    since: tuple | None = None  # (kind, Block)
    burned_block: int | None = None
    base: Running | None = None
    joined_at: int = 0
    events: list = field(default_factory=list)  # rows to write
    points: list = field(default_factory=list)
    now: dict | None = None

    @property
    def key(self):
        return (self.dex, self.token_id)

    def exists_at(self, number):
        """Minted (its history started) at or before `number`, and not burned by then."""
        return (self.since is not None and self.since[1].number <= number
                and (self.burned_block is None or self.burned_block > number))


@dataclass(frozen=True)
class Identity:
    pool: dict
    pool_key: str
    tick_lower: int
    tick_upper: int


def _pool_wire(ref):
    return {'dex': ref.dex, 'currency0': ref.currency0, 'currency1': ref.currency1, 'fee': ref.fee,
            'tickSpacing': ref.tick_spacing, 'hooks': ref.hooks}


# -------------------------------------------------------------------- reads
class StateReader:
    """Positions' state at a block, every read of a round in one Multicall3 eth_call (MULTICALL_READS a call),
    through a history client pinned to that block's header. The code of the contracts it calls is proven
    against the profile once per process (the chain's code cache)."""

    def __init__(self, chain, rpc):
        self.chain, self.rpc = chain, rpc
        self.code = rpc.code_cache
        uniswap = chain.uniswap
        self.contracts = (chain.multicall3, uniswap.v3.positionManager, uniswap.v3.factory,
                          uniswap.v4.positionManager, uniswap.v4.stateView)

    def _prove(self, block):
        unproven = [c for c in self.contracts if not self.code.proven(c, self.chain.verified_codehash(c), block.number)]
        for contract in unproven:
            raw = self.rpc.request('eth_getCode', [contract, block.tag])
            if _codehash(raw) != self.chain.verified_codehash(contract):
                raise DataError('v2_deployment_code_mismatch')
            self.code.record(contract, self.chain.verified_codehash(contract), block.number)

    def aggregate(self, block, calls):
        """[(target, Function, args)] at `block`: each decoded result, or None for a call that reverted."""
        self._prove(block)
        out = []
        for low in range(0, len(calls), MULTICALL_READS):
            chunk = calls[low:low + MULTICALL_READS]
            data = AGGREGATE3.calldata([(address(target), True, bytes.fromhex(fn.calldata(*args)[2:]))
                                        for target, fn, args in chunk])
            raw = self.rpc.request('eth_call', [{'to': self.chain.multicall3, 'data': data,
                                                 'gas': hex(MULTICALL_GAS)}, block.tag])
            if not isinstance(raw, str) or not raw.startswith('0x'):
                raise DataError('v2_fee_multicall_invalid')
            try:
                rows, = AGGREGATE3.decode(bytes.fromhex(raw[2:]))
            except Exception:
                raise DataError('v2_fee_multicall_invalid') from None
            if len(rows) != len(chunk):
                raise DataError('v2_fee_multicall_invalid')
            for (_, fn, _), (ok, payload) in zip(chunk, rows):
                # A call to an address without code succeeds with no data: no answer either.
                out.append(fn.decode('0x' + bytes(payload).hex()) if ok and payload else None)
        return out

    # -- who a token is
    def identify(self, block, keys):
        """{(dex, token id): Identity, or None when the token does not exist at `block`}."""
        uniswap = self.chain.uniswap
        calls = [(uniswap.v3.positionManager, function(V3_MANAGER, 'positions'), (token,)) if dex == DEX_V3 else
                 (uniswap.v4.positionManager, function(V4_MANAGER, 'getPoolAndPositionInfo'), (token,))
                 for dex, token in keys]
        results = self.aggregate(block, calls)
        found, unlisted = {}, {}
        for (dex, token), result in zip(keys, results):
            if result is None:
                found[(dex, token)] = None
            elif dex == DEX_V3:
                (_, _, token0, token1, fee, lower, upper, *_rest) = result
                spacing = self.chain.v3_tick_spacing(fee)
                if spacing is None:
                    unlisted.setdefault(fee, []).append((dex, token))
                found[(dex, token)] = (address(token0), address(token1), fee, spacing, lower, upper)
            else:
                key, info = result
                if info == 0:
                    found[(dex, token)] = None  # cleared on burn, never set before the mint
                    continue
                ref = PoolRef(DEX_V4, *key)
                lower, upper = _signed24(info >> 8), _signed24(info >> 32)
                if info >> 56 != int(ref.pool_id, 16) >> 56:
                    raise DataError('v4_position_pool_mismatch')
                found[(dex, token)] = Identity(_pool_wire(ref), ref.pool_id, lower, upper)
        if unlisted:
            fees = sorted(unlisted)
            spacings = self.aggregate(block, [(uniswap.v3.factory, function(V3_FACTORY, 'feeAmountTickSpacing'),
                                               (fee,)) for fee in fees])
            for fee, result in zip(fees, spacings):
                if result is None or result[0] == 0:
                    raise DataError('v3_fee_tier_unknown')
                for key in unlisted[fee]:
                    found[key] = found[key][:3] + (result[0],) + found[key][4:]
        for key, value in found.items():
            if isinstance(value, tuple):
                token0, token1, fee, spacing, lower, upper = value
                ref = PoolRef(DEX_V3, token0, token1, fee, spacing)
                found[key] = Identity(_pool_wire(ref), v3_pool_address(self.chain, token0, token1, fee), lower, upper)
        return found

    # -- state
    def states(self, block, positions, level):
        """{key: state or None (not readable at `block`)} for `positions` (FeePosition) at `block`. `level`:
        'settle' (liquidity, last, v3 owed), 'growth' (and the growth inside now), 'now' (and the owner, the
        price and the pool's fees)."""
        uniswap = self.chain.uniswap
        calls, plan, pools = [], [], {}

        def add(target, fn, *args):
            calls.append((target, fn, args))
            return len(calls) - 1

        def pool_reads(p):
            if p.pool_key in pools:
                return pools[p.pool_key]
            if p.dex == DEX_V4:
                pid = bytes.fromhex(p.pool_key[2:])
                reads = {'slot0': add(uniswap.v4.stateView, function(V4_STATE, 'getSlot0'), pid)} if level == 'now' \
                    else {}
            else:
                reads = {'slot0': add(p.pool_key, function(V3_POOL, 'slot0')),
                         'global0': add(p.pool_key, function(V3_POOL, 'feeGrowthGlobal0X128')),
                         'global1': add(p.pool_key, function(V3_POOL, 'feeGrowthGlobal1X128'))}
            pools[p.pool_key] = reads
            return reads

        for p in positions:
            reads = {}
            if p.dex == DEX_V4:
                pid = bytes.fromhex(p.pool_key[2:])
                reads['info'] = add(uniswap.v4.stateView, function(V4_STATE, 'getPositionInfo'), pid,
                                    uniswap.v4.positionManager, p.tick_lower, p.tick_upper, p.token_id.to_bytes(32, 'big'))
                if level != 'settle':
                    reads['inside'] = add(uniswap.v4.stateView, function(V4_STATE, 'getFeeGrowthInside'), pid,
                                          p.tick_lower, p.tick_upper)
                if level == 'now':
                    reads['owner'] = add(uniswap.v4.positionManager, function(V4_MANAGER, 'ownerOf'), p.token_id)
            else:
                reads['position'] = add(uniswap.v3.positionManager, function(V3_MANAGER, 'positions'), p.token_id)
                if level != 'settle':
                    reads['lower'] = add(p.pool_key, function(V3_POOL, 'ticks'), p.tick_lower)
                    reads['upper'] = add(p.pool_key, function(V3_POOL, 'ticks'), p.tick_upper)
                if level == 'now':
                    reads['owner'] = add(uniswap.v3.positionManager, function(V3_MANAGER, 'ownerOf'), p.token_id)
            if level != 'settle':
                reads['pool'] = pool_reads(p)
            plan.append((p, reads))
        results = self.aggregate(block, calls) if calls else []
        return {p.key: self._state(p, reads, results, level) for p, reads in plan}

    def _state(self, p, reads, results, level):
        got = {name: results[index] for name, index in reads.items() if name != 'pool'}
        pool = {name: results[index] for name, index in reads.get('pool', {}).items()}
        if p.dex == DEX_V4:
            if got['info'] is None:
                raise DataError('v2_fee_state_unreadable')
            liquidity, last0, last1 = got['info']
            state = {'liquidity': liquidity, 'last': (last0, last1), 'owed': None}
            if level == 'settle':
                return state
            if got['inside'] is None:
                raise DataError('v2_fee_state_unreadable')
            state['inside'] = tuple(got['inside'])
        else:
            if got['position'] is None:
                return None  # the manager deleted it: burned
            (_, _, _, _, _, lower, upper, liquidity, last0, last1, owed0, owed1) = got['position']
            if (lower, upper) != (p.tick_lower, p.tick_upper):
                raise DataError('v2_fee_event_mismatch')
            state = {'liquidity': liquidity, 'last': (last0, last1), 'owed': (owed0, owed1)}
            if level == 'settle':
                return state
            if None in (got['lower'], got['upper'], pool['slot0'], pool['global0'], pool['global1']):
                raise DataError('v2_fee_state_unreadable')
            tick = pool['slot0'][1]
            state['inside'] = tuple(v3_fee_growth_inside(tick, p.tick_lower, p.tick_upper, pool[f'global{i}'][0],
                                                         got['lower'][2 + i], got['upper'][2 + i]) for i in (0, 1))
        if level == 'now':
            slot0 = pool.get('slot0')
            if slot0 is None:
                raise DataError('v2_fee_state_unreadable')
            state['owner'] = None if got['owner'] is None else address(got['owner'][0])
            state['sqrtPriceX96'], state['tick'] = slot0[0], slot0[1]
            # v4 slot0: (sqrtPriceX96, tick, protocolFee, lpFee); v3: (..., feeProtocol at 5, ...).
            state['protocolFee'] = slot0[2] if p.dex == DEX_V4 else slot0[5]
        return state


def _signed24(word_):
    word_ &= 0xffffff
    return word_ - (1 << 24) if word_ & (1 << 23) else word_


class FeeRpc(ChainIndexRpc):
    """The follower's client: pinned history reads and eth_getLogs, nothing else."""


# ------------------------------------------------------------------ storage
def lock_key(chain_id):
    if type(chain_id) is not int or not 0 < chain_id < 1 << 40:
        raise DataError('invalid_v2_chain_id')
    return LOCK_NAMESPACE | chain_id


def _number(value):
    return None if value is None else int(value)


def _pair(row, a, b):
    return None if row[a] is None else (int(row[a]), int(row[b]))


class FeeStore:
    """migrations/054_v2_fees.sql through the catalogue writer: one follower per chain (its own advisory lock,
    never the indexer's), reading the V2 index's checkpoints and the positions it follows."""

    def __init__(self, settings):
        from v2_index_store import V2Store
        self.index = V2Store(settings)

    @contextmanager
    def writer(self, chain_id):
        conn = self.index._connect('domino_catalogue_writer', autocommit=True)
        try:
            conn.execute(f"SET statement_timeout='{WRITER_STATEMENT_TIMEOUT}'")
            if not conn.execute('SELECT pg_try_advisory_lock(%s) AS held', (lock_key(chain_id),)).fetchone()['held']:
                raise DataError('v2_fees_busy')
            try:
                yield FeeWriter(conn, chain_id)
            finally:
                conn.execute('SELECT pg_advisory_unlock(%s)', (lock_key(chain_id),))
        except psycopg.Error:
            raise DataError('catalogue_database_unavailable') from None
        finally:
            conn.close()

    def latest_checkpoint(self, chain_id):
        """The index's newest checkpoint on the chain, without the follower's lock (the follow loop's target)."""
        try:
            with self.index._connect('domino_catalogue_writer', autocommit=True) as conn:
                return FeeWriter(conn, chain_id).latest_checkpoint()
        except psycopg.Error:
            raise DataError('catalogue_database_unavailable') from None


class FeeWriter:
    def __init__(self, conn, chain_id):
        self.conn, self.chain_id = conn, chain_id

    # -- the index
    def deployment(self):
        return self.conn.execute('SELECT start_block,base_hash FROM domino_v2.deployments WHERE chain_id=%s',
                                 (self.chain_id,)).fetchone()

    def latest_checkpoint(self):
        row = self.conn.execute('''SELECT end_block,end_hash,end_timestamp FROM domino_v2.checkpoints
          WHERE chain_id=%s ORDER BY end_block DESC LIMIT 1''', (self.chain_id,)).fetchone()
        return None if row is None else Block(int(row['end_block']), row['end_hash'], int(row['end_timestamp']))

    def standing(self, block):
        """The index still has this checkpoint."""
        return self.conn.execute('''SELECT 1 FROM domino_v2.checkpoints WHERE chain_id=%s AND end_block=%s
          AND end_hash=%s''', (self.chain_id, block.number, block.hash)).fetchone() is not None

    def checkpoint_below(self, number):
        """The index's newest checkpoint at or below `number`, or None."""
        row = self.conn.execute('''SELECT end_block,end_hash,end_timestamp FROM domino_v2.checkpoints
          WHERE chain_id=%s AND end_block<=%s ORDER BY end_block DESC LIMIT 1''', (self.chain_id, number)).fetchone()
        return None if row is None else Block(int(row['end_block']), row['end_hash'], int(row['end_timestamp']))

    def target(self, after, limit, until):
        """The checkpoint a step reads to: the newest in (after, limit] no later than `until`, else the first
        above `after`."""
        row = self.conn.execute('''SELECT end_block,end_hash,end_timestamp FROM domino_v2.checkpoints
          WHERE chain_id=%s AND end_block>%s AND end_block<=%s AND end_timestamp<=%s ORDER BY end_block DESC LIMIT 1''',
                                (self.chain_id, after, limit, until)).fetchone()
        if row is None:
            row = self.conn.execute('''SELECT end_block,end_hash,end_timestamp FROM domino_v2.checkpoints
              WHERE chain_id=%s AND end_block>%s ORDER BY end_block LIMIT 1''', (self.chain_id, after)).fetchone()
        return None if row is None else Block(int(row['end_block']), row['end_hash'], int(row['end_timestamp']))

    def newcomers(self):
        """Positions the index knows that the follower does not, oldest first."""
        return self.conn.execute('''SELECT p.dex,p.token_id,p.first_block FROM domino_v2.positions p
          WHERE p.chain_id=%s AND NOT EXISTS(SELECT 1 FROM domino_v2.fee_positions f WHERE f.chain_id=p.chain_id
           AND f.dex=p.dex AND f.token_id=p.token_id) ORDER BY p.first_block,p.dex,p.token_id''',
                                 (self.chain_id,)).fetchall()

    def compounds(self, blocks):
        """{(block, tx, dex, token id): (serviceFee0, serviceFee1)}: the vaults' Compounded the index holds in
        those blocks (an automatic compound and its service fee)."""
        if not blocks:
            return {}
        rows = self.conn.execute('''SELECT block_number,tx_hash,dex,token_id,args FROM domino_v2.logs
          WHERE chain_id=%s AND block_number=ANY(%s) AND event='Compounded' AND token_id IS NOT NULL''',
                                 (self.chain_id, sorted(blocks))).fetchall()
        out = {}
        for row in rows:
            key = (int(row['block_number']), row['tx_hash'], int(row['dex']), int(row['token_id']))
            fee = (int(row['args']['serviceFee0']), int(row['args']['serviceFee1']))
            out[key] = tuple(a + b for a, b in zip(out.get(key, (0, 0)), fee))
        return out

    # -- the follower
    def cursor(self):
        row = self.conn.execute('SELECT * FROM domino_v2.fee_cursor WHERE chain_id=%s', (self.chain_id,)).fetchone()
        return None if row is None else {**row, 'block': Block(int(row['block_number']), row['block_hash'],
                                                               int(row['block_timestamp']))}

    def start(self, floor, base, now):
        self.conn.execute('''INSERT INTO domino_v2.fee_cursor(chain_id,floor_block,block_number,block_hash,
          block_timestamp,updated_at) VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING''',
                          (self.chain_id, floor, base.number, base.hash, base.timestamp, int(now)))

    def record_error(self, code, at):
        code = code if isinstance(code, str) and re.fullmatch(r'[a-z0-9_]{1,80}', code) else 'v2_fees_error'
        self.conn.execute('UPDATE domino_v2.fee_cursor SET last_error=%s,last_error_at=%s WHERE chain_id=%s',
                          (code, int(at), self.chain_id))

    def positions(self):
        """Every followed position with its running state: the newest settlement's, else its base's."""
        rows = self.conn.execute('''SELECT f.*,e.liquidity AS e_liquidity,e.last0 AS e_last0,e.last1 AS e_last1,
          e.owed0 AS e_owed0,e.owed1 AS e_owed1,e.settled0 AS e_settled0,e.settled1 AS e_settled1,
          e.block_number AS e_block
          FROM domino_v2.fee_positions f
          LEFT JOIN LATERAL (SELECT * FROM domino_v2.fee_events e WHERE e.chain_id=f.chain_id AND e.dex=f.dex
            AND e.token_id=f.token_id AND e.kind<>'transfer' ORDER BY e.block_number DESC,e.log_index DESC LIMIT 1) e
            ON true
          WHERE f.chain_id=%s ORDER BY f.dex,f.token_id''', (self.chain_id,)).fetchall()
        out = []
        for row in rows:
            base = Running(int(row['base_liquidity']), (int(row['base_last0']), int(row['base_last1'])),
                           _pair(row, 'base_owed0', 'base_owed1'), (0, 0))
            if row['e_block'] is None:
                running = base
            else:
                running = Running(int(row['e_liquidity']), (int(row['e_last0']), int(row['e_last1'])),
                                  _pair(row, 'e_owed0', 'e_owed1'), _pair(row, 'e_settled0', 'e_settled1'))
            since = None if row['since_kind'] is None else (row['since_kind'], Block(
                int(row['since_block']), row['since_hash'], int(row['since_timestamp'])))
            out.append(FeePosition(int(row['dex']), int(row['token_id']), row['pool'], row['pool_key'],
                                   int(row['tick_lower']), int(row['tick_upper']), row['status'],
                                   Block(int(row['through_block']), row['through_hash'],
                                         int(row['through_timestamp'])),
                                   running, since, _number(row['burned_block']), base, int(row['joined_at'])))
        return out

    def join(self, positions, at):
        """New positions, each with its identity, base state, status and how far it is read."""
        with self.conn.transaction():
            for p in positions:
                since = p.since or (None, None)
                block = since[1]
                self.conn.execute('''INSERT INTO domino_v2.fee_positions(chain_id,dex,token_id,since_kind,since_block,
                  since_hash,since_timestamp,status,through_block,through_hash,through_timestamp,pool,pool_key,
                  tick_lower,tick_upper,base_liquidity,base_last0,base_last1,base_owed0,base_owed1,joined_at)
                  VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                                  (self.chain_id, p.dex, p.token_id, since[0], None if block is None else block.number,
                                   None if block is None else block.hash, None if block is None else block.timestamp,
                                   p.status, p.through.number, p.through.hash, p.through.timestamp,
                                   json.dumps(p.pool), p.pool_key, p.tick_lower, p.tick_upper, p.base.liquidity,
                                   p.base.last[0], p.base.last[1], None if p.base.owed is None else p.base.owed[0],
                                   None if p.base.owed is None else p.base.owed[1], at))

    def commit(self, cursor, positions, *, end, checkpoint, caught_up, now, thin_before=None):
        """One step, atomically: its positions' events, points and state now, each position read through `end`,
        and the cursor moved to `checkpoint` (a main step) or kept (a step reading positions back). Refused when
        the cursor moved or the index no longer has the checkpoint, which stays held until this commits."""
        with self.conn.transaction():
            row = self.conn.execute('''SELECT block_number,block_hash FROM domino_v2.fee_cursor WHERE chain_id=%s
              FOR UPDATE''', (self.chain_id,)).fetchone()
            if row is None or (int(row['block_number']), row['block_hash']) != (cursor.number, cursor.hash):
                raise DataError('v2_fee_cursor_changed')
            # Its positions' rows before the checkpoint's: the index's rewind deletes positions (which cascades
            # here) before checkpoints, so taking them in that order never deadlocks with it.
            if positions:
                self.conn.execute('''SELECT 1 FROM domino_v2.fee_positions f JOIN unnest(%s::smallint[],
                  %s::numeric[]) AS k(dex,token_id) USING (dex,token_id) WHERE f.chain_id=%s FOR UPDATE OF f''',
                                  ([p.dex for p in positions], [p.token_id for p in positions], self.chain_id))
            held = checkpoint or cursor
            if held.number >= 0 and not self.conn.execute('''SELECT 1 FROM domino_v2.checkpoints WHERE chain_id=%s
              AND end_block=%s AND end_hash=%s FOR KEY SHARE''', (self.chain_id, held.number, held.hash)).fetchone():
                if checkpoint is not None or not self._base(cursor):
                    raise DataError('v2_fee_checkpoint_rewound')
            for p in positions:
                for event in p.events:
                    self.conn.execute('''INSERT INTO domino_v2.fee_events(chain_id,dex,token_id,block_number,log_index,
                      block_hash,block_timestamp,tx_hash,kind,log_indexes,liquidity_delta,liquidity,last0,last1,owed0,
                      owed1,fees0,fees1,settled0,settled1,why,auto,service_fee0,service_fee1,from_address,to_address)
                      VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                                      (self.chain_id, p.dex, p.token_id, *event))
                for point in p.points:
                    self.conn.execute('''INSERT INTO domino_v2.fee_points(chain_id,dex,token_id,block_number,
                      block_timestamp,hour,kind,earned0,earned1,settled0,settled1) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                      ON CONFLICT(chain_id,dex,token_id,block_number) DO NOTHING''', (self.chain_id, p.dex, p.token_id,
                                                                                    *point))
                if p.now is not None:
                    self.conn.execute('''INSERT INTO domino_v2.fee_now(chain_id,dex,token_id,block_number,block_hash,
                      block_timestamp,state,read_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)
                      ON CONFLICT(chain_id,dex,token_id) DO UPDATE SET block_number=EXCLUDED.block_number,
                      block_hash=EXCLUDED.block_hash,block_timestamp=EXCLUDED.block_timestamp,state=EXCLUDED.state,
                      read_at=EXCLUDED.read_at''', (self.chain_id, p.dex, p.token_id, end.number, end.hash,
                                                    end.timestamp, json.dumps(p.now), int(now)))
                elif p.status == 'burned':
                    self.conn.execute('DELETE FROM domino_v2.fee_now WHERE chain_id=%s AND dex=%s AND token_id=%s',
                                      (self.chain_id, p.dex, p.token_id))
                since = p.since or (None, None)
                self.conn.execute('''UPDATE domino_v2.fee_positions SET status=%s,through_block=%s,through_hash=%s,
                  through_timestamp=%s,burned_block=%s,since_kind=%s,since_block=%s,since_hash=%s,since_timestamp=%s
                  WHERE chain_id=%s AND dex=%s AND token_id=%s''',
                                  (p.status, end.number, end.hash, end.timestamp, p.burned_block, since[0],
                                   None if since[1] is None else since[1].number,
                                   None if since[1] is None else since[1].hash,
                                   None if since[1] is None else since[1].timestamp,
                                   self.chain_id, p.dex, p.token_id))
            if checkpoint is not None:
                self.conn.execute('''UPDATE domino_v2.fee_cursor SET block_number=%s,block_hash=%s,block_timestamp=%s,
                  caught_up=%s,last_error=NULL,last_error_at=NULL,updated_at=%s WHERE chain_id=%s''',
                                  (checkpoint.number, checkpoint.hash, checkpoint.timestamp, caught_up, int(now),
                                   self.chain_id))
            if thin_before is not None:
                self.conn.execute('''DELETE FROM domino_v2.fee_points WHERE chain_id=%s AND kind='hour' AND hour<%s''',
                                  (self.chain_id, thin_before))

    def _base(self, block):
        """`block` is the deployment's base (the block before Domino's first)."""
        row = self.deployment()
        return row is not None and (int(row['start_block']) - 1, row['base_hash']) == (block.number, block.hash)

    def rewind(self, fork):
        """Forget everything above `fork` (a checkpoint the index still has, or its base); read on from it."""
        chain = self.chain_id
        with self.conn.transaction():
            for table in ('fee_events', 'fee_points', 'fee_now'):
                self.conn.execute(f'DELETE FROM domino_v2.{table} WHERE chain_id=%s AND block_number>%s',
                                  (chain, fork.number))
            # No history starts above the fork here: the index's own rewind removed every position it first saw
            # above it (fee rows cascade), and a history starts at or before that sighting (its mint, or the floor).
            self.conn.execute('''UPDATE domino_v2.fee_positions SET status=CASE WHEN status='burned' THEN 'following'
              ELSE status END,burned_block=NULL WHERE chain_id=%s AND burned_block>%s''', (chain, fork.number))
            # A position read back past the fork, or following the cursor, reads on from the fork with the cursor.
            self.conn.execute('''UPDATE domino_v2.fee_positions SET status=CASE WHEN status='reading' THEN 'following'
              ELSE status END,through_block=%s,through_hash=%s,through_timestamp=%s
              WHERE chain_id=%s AND through_block>=%s AND status<>'burned' ''',
                              (fork.number, fork.hash, fork.timestamp, chain, fork.number))
            self.conn.execute('''UPDATE domino_v2.fee_cursor SET block_number=%s,block_hash=%s,block_timestamp=%s,
              caught_up=false WHERE chain_id=%s''', (fork.number, fork.hash, fork.timestamp, chain))


# ----------------------------------------------------------------- follower
def hours_between(low, high, cutoff):
    """The hour boundaries in (low, high], in seconds, as (hour, kind): every hour from `cutoff` on, before it
    only each UTC day's first."""
    out = []
    hour = (low // HOUR + 1) * HOUR
    while hour <= high:
        if hour % DAY == 0:
            out.append((hour, 'day'))
        elif hour >= cutoff:
            out.append((hour, 'hour'))
        hour += HOUR
    return out


def point_block(before, end, hour):
    """The block that stands for `hour` in (before, end]: interpolated by the range's own timestamps (Base's
    blocks are exactly 2 s apart; Arbitrum's are not, so a point carries the timestamp its block has)."""
    if end.timestamp - before.timestamp <= POINT_AT_END_SECONDS:
        return end.number
    span = end.number - before.number
    offset = -(-(hour - before.timestamp) * span // (end.timestamp - before.timestamp))
    return min(end.number, max(before.number + 1, before.number + offset))


class V2FeeFollower:
    def __init__(self, store, chain, endpoints, *, span=DEFAULT_SPAN, max_requests=DEFAULT_MAX_REQUESTS,
                 clock=time.time):
        if endpoints.chain.chainId != chain.chainId:
            raise DataError('v2_rpc_chain_mismatch')
        if (type(span) is not int or not MIN_SPAN <= span <= MAX_SPAN or type(max_requests) is not int
                or max_requests < 32):
            raise DataError('invalid_v2_fees_config')
        self.store, self.chain, self.endpoints = store, chain, endpoints
        self.chain_id, self.span, self.max_requests, self.clock = chain.chainId, span, max_requests, clock

    def rpc(self):
        return FeeRpc(self.endpoints, max_requests=self.max_requests, batch_reads=True)

    def index_head(self):
        """{'number': the index's newest checkpoint}, the target followers.follow gives each step: the follower
        never reads the chain's head."""
        latest = self.store.latest_checkpoint(self.chain_id)
        if latest is None:
            raise DataError('v2_fees_index_not_started')
        return {'number': latest.number}

    def step(self, *, through=None):
        """One pass: the cursor checked against the index, new positions joined, one range read and committed,
        and one range of the positions read back. `through` bounds the range (the follow loop's target)."""
        if through is not None and type(through) is not int:
            raise DataError('invalid_v2_fees_bounds')
        rpc = self.rpc()
        with self.store.writer(self.chain_id) as writer:
            try:
                return self._step(writer, rpc, through)
            except DataError as error:
                if writer.cursor() is not None:
                    writer.record_error(str(error), self.clock())
                raise

    def _step(self, writer, rpc, through):
        deployment = writer.deployment()
        if deployment is None:
            raise DataError('v2_deployment_not_registered')
        floor = int(deployment['start_block'])
        cursor = writer.cursor()
        if cursor is None:
            writer.start(floor, self._base(rpc, floor, deployment), self.clock())
            cursor = writer.cursor()
        cursor = cursor['block']
        # The cursor is the deployment's base or a checkpoint the index still has; otherwise the index rewound.
        if cursor.number >= floor and not writer.standing(cursor):
            fork = writer.checkpoint_below(cursor.number) or self._base(rpc, floor, deployment)
            writer.rewind(fork)
            return {'status': 'rewound', 'through': fork.number}
        joined = self._join(writer, rpc, floor, cursor)
        result = {'status': 'caught_up_to_target', 'through': cursor.number, 'joined': joined}
        latest = writer.latest_checkpoint()
        if latest is not None and latest.number > cursor.number and (through is None or through > cursor.number):
            def advance(span, rpc):
                limit = cursor.number + span if through is None else min(through, cursor.number + span)
                target = writer.target(cursor.number, limit, cursor.timestamp + STEP_SECONDS)
                following = [p for p in writer.positions() if p.status == 'following']
                events = self._advance(writer, rpc, following, cursor, target, main=True, caught_up=target == latest)
                return target, events
            target, events = self._halving(advance, rpc)
            result = {'status': 'indexed', 'fromBlock': cursor.number + 1, 'through': target.number,
                      'caughtUp': target == latest, 'events': events, 'joined': joined}
            cursor = target
        result['readBack'] = self._read_back(writer, rpc, cursor)
        return result

    def _halving(self, read, rpc):
        """read(span, client), its span halved, on a fresh client, while a range holds more events than one step
        reads (MAX_CHUNK_EVENTS) or more blocks to read than its requests (a main step's range ends at the
        index's checkpoints, so it shrinks only as far as their spacing)."""
        span = self.span
        while True:
            try:
                return read(span, rpc)
            except DataError as error:
                if str(error) not in HALVING or span // 2 < MIN_SPAN:
                    raise
                span, rpc = span // 2, self.rpc()

    def _base(self, rpc, floor, deployment):
        """The deployment's base: the block before Domino's first, whose hash the index registered."""
        block = self._pin(rpc, floor - 1)
        if block.hash != deployment['base_hash']:
            raise DataError('v2_deployment_reorganized')
        return block

    def _pin(self, rpc, block):
        """A block's header, read (the client keeps it as an anchor for state reads there), by number; as a Block,
        it must still be that block."""
        number = block.number if isinstance(block, Block) else block
        header = parse_block(rpc.request('eth_getBlockByNumber', [hex(number), False]))
        if header.number != number or (isinstance(block, Block) and header != block):
            raise DataError('v2_fee_snapshot_reorganized')
        return header

    # -- joining
    def _join(self, writer, rpc, floor, cursor):
        """The index's new positions. One that does not exist at the cursor is minted after it: it follows the
        cursor, its history starting at its mint. One that does is read back from Domino's first block, its base
        the state it had just before it, if it existed then (before_floor). At the very start the cursor is that
        block's parent, so every position simply follows."""
        rows = writer.newcomers()
        if not rows:
            return 0
        keys = [(int(row['dex']), int(row['token_id'])) for row in rows]
        first = {key: int(row['first_block']) for key, row in zip(keys, rows)}
        reader = StateReader(self.chain, rpc)
        at_cursor = reader.identify(self._pin(rpc, cursor), keys)
        identities = dict(at_cursor)
        # Absent at the cursor: identified where the index first saw it, else just before (burned in that block).
        for shift in (0, 1):
            missing = [key for key in keys if identities[key] is None]
            for number in sorted({first[key] - shift for key in missing if first[key] - shift > cursor.number}):
                at = [key for key in missing if first[key] - shift == number]
                identities.update(reader.identify(self._pin(rpc, number), at))
        older = [key for key in keys if at_cursor[key] is not None]
        bases, since = {}, None
        if older:
            base_block = cursor if cursor.number == floor - 1 else self._pin(rpc, floor - 1)
            existed = reader.identify(base_block, older) if base_block is not cursor else at_cursor
            stubs = [FeePosition(dex, token, identities[(dex, token)].pool, identities[(dex, token)].pool_key,
                                 identities[(dex, token)].tick_lower, identities[(dex, token)].tick_upper, 'reading',
                                 base_block, None) for dex, token in older if existed[(dex, token)] is not None]
            states = reader.states(base_block, stubs, 'growth') if stubs else {}
            for stub in stubs:
                state = states[stub.key]
                owed = None
                if stub.dex == DEX_V3:
                    # What the manager owed, with what had accrued since its own checkpoint: none of it is earned
                    # in Domino's era.
                    accrued = growth_fees(DEX_V3, state['liquidity'], state['last'], state['inside'])
                    owed = tuple((a + b) & U128 for a, b in zip(state['owed'], accrued))
                # Fees accrue from Domino's first block on: its virtual checkpoint is the growth inside then.
                bases[stub.key] = Running(state['liquidity'], state['inside'], owed, (0, 0))
            if stubs:
                since = ('floor', self._pin(rpc, floor))
        new = []
        for key in keys:
            identity = identities[key]
            if identity is None:
                continue  # not identified yet: asked again next pass
            dex, token = key
            empty = Running(0, (0, 0), (0, 0) if dex == DEX_V3 else None, (0, 0))
            base = bases.get(key, empty)
            if key not in older:
                status, through, start = 'following', cursor, None
            elif cursor.number == floor - 1:
                status, through, start = 'following', cursor, since if key in bases else None
            else:
                status, through, start = 'reading', self._pin(rpc, floor - 1), since if key in bases else None
            new.append(FeePosition(dex, token, identity.pool, identity.pool_key, identity.tick_lower,
                                   identity.tick_upper, status, through, base, start, base=base))
        writer.join(new, int(self.clock()))
        return len(new)

    # -- reading back
    def _read_back(self, writer, rpc, cursor):
        """One range of the positions read back that are furthest behind the cursor; at the cursor they follow it."""
        reading = [p for p in writer.positions() if p.status == 'reading' and p.through.number < cursor.number]
        if not reading:
            return None
        low = min(p.through.number for p in reading)
        group = [p for p in reading if p.through.number == low]
        before = group[0].through
        # A day of chain time at most, estimated by the range's own timestamps.
        day = before.number + max(1, (cursor.number - before.number) * STEP_SECONDS
                                  // max(1, cursor.timestamp - before.timestamp))

        def advance(span, rpc):
            number = min(low + span, cursor.number, day)
            end = cursor if number == cursor.number else self._pin(rpc, number)
            return end, self._advance(writer, rpc, group, cursor, end, main=False, caught_up=False, before=before)
        end, events = self._halving(advance, rpc)
        return {'positions': len(group), 'fromBlock': low + 1, 'through': end.number, 'events': events,
                'following': end.number == cursor.number}

    # -- a range
    def _advance(self, writer, rpc, positions, cursor, end, *, main, caught_up, before=None):
        """Read [before + 1, end] for `positions` (all read through `before`: the cursor for the main step) and
        commit it. The main step moves the cursor to `end`, a checkpoint, and reads the positions' state there
        when it is the index's newest; a step reading back moves only its positions, to the cursor at most."""
        before = cursor if before is None else before
        followed = {p.key: p for p in positions if p.status != 'burned'}
        logs = self._logs(rpc, followed, before.number + 1, end.number)
        reader = StateReader(self.chain, rpc)
        now_ts = int(self.clock())
        cutoff = (max(end.timestamp, now_ts) - HOURLY_DAYS * DAY) // HOUR * HOUR
        point_blocks = {}
        for hour, kind in hours_between(before.timestamp, end.timestamp, cutoff):
            point_blocks.setdefault(point_block(before, end, hour), []).append((hour, kind))
        by_block = {}
        for log in logs:
            by_block.setdefault(log.block_number, []).append(log)
        reading_now = main and caught_up
        numbers = sorted(set(by_block) | set(point_blocks))
        # The end first: the history client never drops its highest anchor, and it must still be the checkpoint.
        end_header = self._pin(rpc, end)
        compounds = writer.compounds(set(by_block))
        for low in range(0, len(numbers), HEADER_CHUNK):
            chunk = numbers[low:low + HEADER_CHUNK]
            headers = read_headers(rpc, [n for n in chunk if n != end.number])
            headers[end.number] = end_header
            for number in chunk:
                header = headers[number]
                if any(log.block_hash != header.hash for log in by_block.get(number, ())):
                    raise DataError('v2_fee_snapshot_reorganized')
                self._block(reader, header, by_block.get(number, []), followed, compounds)
                # A point at the end of a caught-up range comes from the state read there anyway ("now").
                if number in point_blocks and not (reading_now and number == end.number):
                    self._points(reader, header, point_blocks[number], followed)
        if reading_now:
            states = self._now(reader, end_header, followed)
            if end.number in point_blocks:
                self._points(reader, end_header, point_blocks[end.number], followed, states)
        if not main and end.number == cursor.number:
            for p in positions:
                if p.status == 'reading':
                    p.status = 'following'
        writer.commit(cursor, positions, end=end, checkpoint=end if main else None, caught_up=caught_up,
                      now=now_ts, thin_before=cutoff if main else None)
        return len(logs)

    def _logs(self, rpc, followed, start, end):
        """The positions' own events in [start, end], in order, in at most three filters (each split per endpoint
        window by v2_rpc), every one decoded strictly and kept only when it is a followed position's."""
        uniswap = self.chain.uniswap
        v3 = sorted(token for dex, token in followed if dex == DEX_V3)
        v4_pools = sorted({p.pool_key for p in followed.values() if p.dex == DEX_V4})
        managers = sorted({uniswap.v3.positionManager if dex == DEX_V3 else uniswap.v4.positionManager
                           for dex, _ in followed})
        tokens = sorted({token for _, token in followed})
        filters = []
        for low in range(0, len(v3), MAX_FILTER_IDS):
            filters.append({'address': uniswap.v3.positionManager,
                            'topics': [[INCREASE, DECREASE, COLLECT], [word(t) for t in v3[low:low + MAX_FILTER_IDS]]]})
        for low in range(0, len(tokens), MAX_FILTER_IDS):
            filters.append({'address': managers, 'topics': [TRANSFER, None, None,
                                                            [word(t) for t in tokens[low:low + MAX_FILTER_IDS]]]})
        for low in range(0, len(v4_pools), MAX_FILTER_IDS):
            filters.append({'address': uniswap.v4.poolManager,
                            'topics': [MODIFY_LIQUIDITY, v4_pools[low:low + MAX_FILTER_IDS],
                                       word(uniswap.v4.positionManager)]})
        raw = []
        for query in filters:
            found = rpc.request('eth_getLogs', [{**query, 'fromBlock': hex(start), 'toBlock': hex(end)}])
            if not isinstance(found, list) or len(raw) + len(found) > MAX_CHUNK_EVENTS:
                raise DataError('v2_fee_log_budget_exhausted')
            raw.extend(found)
        logs, seen = [], {}
        for entry in raw:
            log = decode_fee_log(self.chain, entry, followed)
            if log is None:
                continue
            if not start <= log.block_number <= end:
                raise DataError('v2_event_outside_range')
            mark = (log.block_number, log.log_index)
            if mark in seen:
                if seen[mark] != log:
                    raise DataError('v2_conflicting_duplicate_log')
                continue
            seen[mark] = log
            logs.append(log)
        return sorted(logs, key=lambda log: (log.block_number, log.log_index))

    def _block(self, reader, header, logs, followed, compounds):
        """One block's events: transfers (a mint starts a history, a burn ends it), then each position's
        settlements against its state read at the end of the block."""
        settling = {}
        for log in logs:
            p = followed[log.key]
            if log.kind == 'transfer':
                p.events.append((header.number, log.log_index, header.hash, header.timestamp, log.tx_hash, 'transfer',
                                 None, None, None, None, None, None, None, None, None, None, None, None, False, None,
                                 None, log.sender, log.recipient))
                if log.sender == ZERO and p.since is None:
                    p.since = ('mint', header)
                if log.recipient == ZERO:
                    p.status, p.burned_block = 'burned', header.number
            else:
                settling.setdefault(log.key, []).append(log)
        if not settling:
            return
        states = reader.states(header, [followed[key] for key in settling], 'settle')
        for key, own in settling.items():
            p = followed[key]
            state = states[key]
            after = None if state is None else (state['liquidity'], state['last'], state['owed'])
            if after is None and p.status != 'burned':
                raise DataError('v2_fee_position_unreadable')
            fees, why, running = settle(p.dex, p.running, own, after)
            service = None
            for tx in sorted({log.tx_hash for log in own}):
                found = compounds.get((header.number, tx, p.dex, p.token_id))
                if found is not None:
                    service = tuple(a + b for a, b in zip(service or (0, 0), found))
            net = sum(log.delta for log in own)
            kind = 'increase' if net > 0 else 'decrease' if net < 0 else 'collect'
            last = own[-1]
            p.events.append((header.number, last.log_index, header.hash, header.timestamp, last.tx_hash, kind,
                             [log.log_index for log in own], net, running.liquidity, *running.last,
                             *(running.owed or (None, None)), *(fees or (None, None)),
                             *(running.settled or (None, None)), why, service is not None,
                             *(service or (None, None)), None, None))
            p.running = running

    def _measure(self, p, state):
        """(earned, unsettled) at a state read with its growth inside; earned None once a settlement was not
        known. The liquidity read must be the running one: otherwise an event was not seen."""
        if state is None or state['liquidity'] != p.running.liquidity:
            p.running = replace(p.running, settled=None)
            return None, None
        accrued = unsettled(p.dex, p.running.liquidity, p.running.last, state['inside'])
        earned = None if p.running.settled is None else tuple(a + b for a, b in zip(p.running.settled, accrued))
        return earned, accrued

    def _points(self, reader, header, hours, followed, states=None):
        live = [p for p in followed.values() if p.exists_at(header.number)]
        if not live:
            return
        states = states if states is not None else reader.states(header, live, 'growth')
        for p in live:
            earned, _ = self._measure(p, states[p.key])
            for hour, kind in hours:
                settled = p.running.settled if earned is not None else None
                p.points.append((header.number, header.timestamp, hour, kind, *(earned or (None, None)),
                                 *(settled or (None, None))))

    def _now(self, reader, header, followed):
        """Each live position's state at the end of a caught-up range; returns the states read."""
        live = [p for p in followed.values() if p.status != 'burned' and p.since is not None
                and p.since[1].number <= header.number]
        if not live:
            return {}
        states = reader.states(header, live, 'now')
        for p in live:
            state = states[p.key]
            # A live position has its state and its owner: one without either is not stored as "now".
            if state is None or state['owner'] is None:
                raise DataError('v2_fee_position_unreadable')
            earned, accrued = self._measure(p, state)
            # What a collect pays now: the manager's own checkpoint (v3 adds its tokensOwed).
            collectable = growth_fees(p.dex, state['liquidity'], state['last'], state['inside'])
            if p.dex == DEX_V3:
                collectable = tuple((a + b) & U128 for a, b in zip(state['owed'], collectable))
            p.now = {'owner': state['owner'], 'liquidity': str(state['liquidity']),
                     'sqrtPriceX96': str(state['sqrtPriceX96']), 'tick': state['tick'],
                     'protocolFee': state['protocolFee'],
                     'feeGrowthInsideX128': [str(v) for v in state['inside']],
                     'feeGrowthInsideLastX128': [str(v) for v in state['last']],
                     'tokensOwed': None if state['owed'] is None else [str(v) for v in state['owed']],
                     'collectable': [str(v) for v in collectable],
                     'unsettled': None if accrued is None else [str(v) for v in accrued],
                     'earned': None if earned is None else [str(v) for v in earned],
                     'settled': None if earned is None else [str(v) for v in p.running.settled],
                     'principalAtSpot': [str(v) for v in principal(state['sqrtPriceX96'], p.tick_lower,
                                                                   p.tick_upper, state['liquidity'])]}
        return states


# ---------------------------------------------------------------------- CLI
def main(argv=None):
    from catalogue import database_settings
    from v2_chains import default_registry
    from v2_rpc import configured_endpoints, load_chain_rpc_config
    parser = argparse.ArgumentParser(description='Follow one chain\'s Domino V2 positions\' fees (read-v6 position-fees).')
    parser.add_argument('command', choices=('step', 'follow', 'status'))
    parser.add_argument('--chain', required=True, help='profile name, e.g. base-8453')
    parser.add_argument('--chain-rpc-file', help='the private V2 chain RPC file (chains other than Robinhood)')
    parser.add_argument('--provider-file', help='the read path provider file (Robinhood)')
    parser.add_argument('--span', type=int, default=DEFAULT_SPAN, help='blocks one step reads at most')
    parser.add_argument('--poll', type=float, default=60, help='follow: seconds between passes when caught up')
    parser.add_argument('--max-passes', type=int, default=0, help='follow: 0 runs until stopped')
    args = parser.parse_args(argv)
    try:
        chain = default_registry().chain(args.chain)
        settings = database_settings()
        if settings is None:
            raise DataError('catalogue_not_configured')
        store = FeeStore(settings)
        if args.command == 'status':
            with store.writer(chain.chainId) as writer:
                cursor = writer.cursor()
                rows = writer.conn.execute('''SELECT status,count(*) AS n,min(through_block) AS through
                  FROM domino_v2.fee_positions WHERE chain_id=%s GROUP BY status''', (chain.chainId,)).fetchall()
                latest = writer.latest_checkpoint()
            report = {'chainId': chain.chainId, 'status': 'not_started'} if cursor is None else {
                'chainId': chain.chainId, 'floorBlock': cursor['floor_block'], 'through': cursor['block_number'],
                'caughtUp': cursor['caught_up'], 'indexThrough': None if latest is None else latest.number,
                'lastError': cursor['last_error'], 'lastErrorAt': cursor['last_error_at'],
                'positions': {row['status']: {'count': row['n'], 'lowestThrough': row['through']} for row in rows}}
            print(json.dumps(report, default=str, indent=2, sort_keys=True))
            return 0
        if chain.chainId == 4663:
            from local_config import CONFIG_PATH, load_config
            endpoints = configured_endpoints(chain, provider_config=load_config(args.provider_file or str(CONFIG_PATH)))
        else:
            if not args.chain_rpc_file:
                raise DataError('v2_chain_rpc_not_configured')
            endpoints = configured_endpoints(chain, chain_rpc_config=load_chain_rpc_config(args.chain_rpc_file))
        follower = V2FeeFollower(store, chain, endpoints, span=args.span)
        if args.command == 'step':
            report = follower.step()
        else:
            from followers import follow
            report = follow(lambda through: follower.step(through=through), follower.index_head, lag=0,
                            max_passes=args.max_passes, poll_seconds=args.poll,
                            on_pass=lambda entry: print(json.dumps(entry, default=str, sort_keys=True), flush=True))
    except DataError as error:
        print(json.dumps({'error': str(error)}))
        return 1
    print(json.dumps(report, default=str, indent=2, sort_keys=True))
    return 0


if __name__ == '__main__':
    sys.exit(main())
