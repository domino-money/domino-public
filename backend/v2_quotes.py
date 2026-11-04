"""On-chain quoting and route building for V2 swap legs: v3 and v4 pool paths, read at one pinned block.

Reusable by any V2 planner (the S1 zap planner here; the automation planner
may reuse it for its own legs). Every amount is what the chain's own quoter
or the pool's own math returns at the block, never a price feed.

API
- Path(dex, token_in, hops): a pool path one SwapLeg can carry. dex 3 is a v3
  path (LEG_V3_POOL, ERC-20s only, packed `token, fee, token`), dex 4 a v4
  path (LEG_V4_POOL, abi.encode(PoolRef[]), native ETH as address(0)). At
  most MAX_HOPS hops, one dex per path (a v3 hop and a v4 hop are two legs).
- candidate_paths(chain, token_in, token_out, ...): the direct pools of a pair
  on both versions (the profile's v3 fee tiers, v4's standard hookless keys)
  plus any pools named (e.g. a position's own pool).
- PoolQuoter(chain, rpc, block).quote(paths, amount_in): every path quoted in
  ONE eth_call through Multicall3.aggregate3 (one billed call on hosted RPC):
  QuoterV2.quoteExactInput for v3 (with each pool's price after the swap),
  V4Quoter.quoteExactInputSingle / quoteExactInput for v4. A path whose pool
  does not exist, or that the pool cannot fill, comes back as None.
- best_two_hop(...): the best path through a hub currency, hop by hop.
- pool_snapshot(chain, rpc, block, state): a PoolSnapshot (v2_liquidity) of a
  pool read by v2_uniswap.UniswapReader, with lazy, batched tick reads (v4
  through PoolManager.extsload, v3 through the pool's tickBitmap and ticks),
  to swap it exactly in Python (v2_liquidity.simulate_exact_in), including
  after a position's own liquidity is withdrawn.
- multicall(rpc, chain, block, calls): Multicall3.aggregate3 at a pinned block.

Quoters and Multicall3 are not part of the F0 exports; their functions are
declared below with the selectors Uniswap and mds1 publish, and
tests/test_v2_quotes.py pins each selector against the runtime bytecode
deployed on Base (fixtures/v2-base-plan-runtimes.json). Robinhood's V4Quoter is a
different v4-periphery build (F0 profile note): quoteExactInputSingle is the
call V1 already makes there in production; quoteExactInput is used for
multi-hop v4 paths only.
"""
from dataclasses import dataclass, field
from functools import lru_cache

from eth_abi import decode, encode
from eth_hash.auto import keccak

from discovery import ZERO, DataError, address
from v2_abi import function
from v2_chains import DEX_V3, DEX_V4
from v2_liquidity import PoolSnapshot, TickSource
from v2_uniswap import PoolRef

MAX_HOPS = 4
# What one aggregate3 eth_call may spend: quotes cost 0.1-0.5 M gas each. Hosted
# providers cap eth_call gas (commonly 50 M); keep well inside it.
MULTICALL_GAS = 30_000_000
MAX_CALLS_PER_MULTICALL = 64
# v4's common hookless PoolKeys (fee in pips, tick spacing), as Uniswap's
# interface creates them; any other key is quoted only when named.
V4_STANDARD_KEYS = ((100, 1), (500, 10), (3000, 60), (10000, 200))
TICK_PREFETCH_WORDS = 2
TICK_PREFETCH_TICKS = 32
# v4-core StateLibrary: the pools mapping and the offsets inside Pool.State.
V4_POOLS_SLOT = 6
V4_TICKS_OFFSET = 4
V4_TICK_BITMAP_OFFSET = 5


@dataclass(frozen=True)
class Abi:
    signature: str
    inputs: tuple
    outputs: tuple

    @property
    def selector(self):
        return '0x' + keccak(self.signature.encode())[:4].hex()

    def calldata(self, *values):
        return self.selector + encode(list(self.inputs), list(values)).hex()

    def decode(self, raw):
        return decode(list(self.outputs), raw)


V4_KEY = '(address,address,uint24,int24,address)'
AGGREGATE3 = Abi('aggregate3((address,bool,bytes)[])', ('(address,bool,bytes)[]',), ('(bool,bytes)[]',))
GET_ETH_BALANCE = Abi('getEthBalance(address)', ('address',), ('uint256',))
QUOTER_V2_EXACT_INPUT = Abi('quoteExactInput(bytes,uint256)', ('bytes', 'uint256'),
                            ('uint256', 'uint160[]', 'uint32[]', 'uint256'))
V4_QUOTER_EXACT_INPUT_SINGLE = Abi('quoteExactInputSingle((' + V4_KEY + ',bool,uint128,bytes))',
                                   ('(' + V4_KEY + ',bool,uint128,bytes)',), ('uint256', 'uint256'))
V4_QUOTER_EXACT_INPUT = Abi('quoteExactInput((address,(address,uint24,int24,address,bytes)[],uint128))',
                            ('(address,(address,uint24,int24,address,bytes)[],uint128)',), ('uint256', 'uint256'))
V3_TICK_BITMAP = Abi('tickBitmap(int16)', ('int16',), ('uint256',))
ERC20_BALANCE_OF = Abi('balanceOf(address)', ('address',), ('uint256',))
ERC20_ALLOWANCE = Abi('allowance(address,address)', ('address', 'address'), ('uint256',))
ERC20_DECIMALS = Abi('decimals()', (), ('uint8',))


class QuoteError(DataError):
    """A fixed code (DataError, so the read path's handling applies)."""


# ------------------------------------------------------------------ paths

@dataclass(frozen=True)
class Path:
    dex: int
    token_in: str
    hops: tuple  # PoolRef, in swap order

    def __post_init__(self):
        object.__setattr__(self, 'token_in', address(self.token_in))
        if self.dex not in (DEX_V3, DEX_V4) or not 1 <= len(self.hops) <= MAX_HOPS:
            raise QuoteError('quote_path_invalid')
        current = self.token_in
        for pool in self.hops:
            if not isinstance(pool, PoolRef) or pool.dex != self.dex or current not in (pool.currency0, pool.currency1):
                raise QuoteError('quote_path_invalid')
            current = pool.currency1 if current == pool.currency0 else pool.currency0
        if self.dex == DEX_V3 and ZERO in self.tokens:
            raise QuoteError('quote_path_native_on_v3')

    @property
    def tokens(self):
        tokens, current = [self.token_in], self.token_in
        for pool in self.hops:
            current = pool.currency1 if current == pool.currency0 else pool.currency0
            tokens.append(current)
        return tuple(tokens)

    @property
    def token_out(self):
        return self.tokens[-1]

    @property
    def leg_kind(self):
        return 2 if self.dex == DEX_V3 else 3  # DominoV2Types.LEG_V3_POOL / LEG_V4_POOL

    def leg_data(self):
        """SwapLeg.data: the v3 packed path, or abi.encode(PoolRef[])."""
        if self.dex == DEX_V3:
            tokens = self.tokens
            packed = bytes.fromhex(tokens[0][2:])
            for pool, token in zip(self.hops, tokens[1:]):
                packed += pool.fee.to_bytes(3, 'big') + bytes.fromhex(token[2:])
            return '0x' + packed.hex()
        refs = [(p.dex, p.currency0, p.currency1, p.fee, p.tick_spacing, p.hooks) for p in self.hops]
        return '0x' + encode(['(uint8,address,address,uint24,int24,address)[]'], [refs]).hex()

    def touches(self, pool):
        return pool in self.hops

    def describe(self, chain):
        """The pools for a receipt or a review: dex, fee, spacing, hooks and identity."""
        from v2_uniswap import v3_pool_address
        rows = []
        for pool in self.hops:
            row = {'dex': pool.dex, 'currency0': pool.currency0, 'currency1': pool.currency1, 'fee': pool.fee,
                   'tickSpacing': pool.tick_spacing, 'hooks': pool.hooks}
            row['id'] = (v3_pool_address(chain, pool.currency0, pool.currency1, pool.fee) if pool.dex == DEX_V3
                         else pool.pool_id)
            rows.append(row)
        return rows


def _pool(dex, a, b, fee, spacing, hooks=ZERO):
    c0, c1 = (a, b) if a < b else (b, a)
    return PoolRef(dex, c0, c1, fee, spacing, hooks)


def candidate_paths(chain, token_in, token_out, *, named=(), exclude=(), v3=True, v4=True):
    """Single-hop paths between two tokens: the profile's v3 tiers (ERC-20s
    only), v4's standard hookless keys, and every named pool of that pair."""
    token_in, token_out = address(token_in), address(token_out)
    if token_in == token_out:
        raise QuoteError('quote_path_invalid')
    pools = []
    if v3 and ZERO not in (token_in, token_out):
        for fee, spacing in sorted((int(f), s) for f, s in chain.uniswap.v3.tickSpacingByFee.items()):
            pools.append(_pool(DEX_V3, token_in, token_out, fee, spacing))
    if v4:
        for fee, spacing in V4_STANDARD_KEYS:
            pools.append(_pool(DEX_V4, token_in, token_out, fee, spacing))
    for pool in named:
        if {pool.currency0, pool.currency1} == {token_in, token_out} and pool not in pools:
            if (pool.dex == DEX_V3 and v3) or (pool.dex == DEX_V4 and v4):
                pools.append(pool)
    return [Path(pool.dex, token_in, (pool,)) for pool in pools if pool not in exclude]


# --------------------------------------------------------------- multicall

def multicall(rpc, chain, block, calls, *, gas=MULTICALL_GAS):
    """Multicall3.aggregate3 at `block`: [(success, return bytes)] in order.
    `calls` are (target, calldata hex) pairs; every call may fail alone."""
    results = []
    for start in range(0, len(calls), MAX_CALLS_PER_MULTICALL):
        chunk = calls[start:start + MAX_CALLS_PER_MULTICALL]
        data = AGGREGATE3.calldata([(address(target), True, bytes.fromhex(payload[2:])) for target, payload in chunk])
        raw = rpc.request('eth_call', [{'to': chain.multicall3, 'data': data, 'gas': hex(gas)}, block.tag])
        if not isinstance(raw, str) or not raw.startswith('0x'):
            raise QuoteError('quote_multicall_invalid')
        try:
            rows, = AGGREGATE3.decode(bytes.fromhex(raw[2:]))
        except Exception:
            raise QuoteError('quote_multicall_invalid') from None
        if len(rows) != len(chunk):
            raise QuoteError('quote_multicall_invalid')
        results.extend((bool(ok), bytes(payload)) for ok, payload in rows)
    return results


def decoded(abi, row):
    """One aggregate3 result decoded, or None when the call failed. A call to an
    address without code succeeds with no data: that is a failure too (a chain
    without v3 has no QuoterV2)."""
    ok, payload = row
    if not ok or not payload:
        return None
    try:
        return decode(list(abi.outputs), payload)
    except Exception:
        raise QuoteError('quote_answer_invalid') from None


# ----------------------------------------------------------------- quotes

@dataclass(frozen=True)
class Quote:
    path: Path
    amount_in: int
    amount_out: int
    # v3: each pool's sqrt price after its hop (QuoterV2); v4: None.
    sqrt_prices_after: tuple | None
    gas_estimate: int
    source: str  # 'quoter_v2' | 'v4_quoter' | 'local_simulation'


def quote_call(chain, path, amount_in):
    """(target, calldata) of the quoter call for one path."""
    if path.dex == DEX_V3:
        return chain.uniswap.v3.quoterV2, QUOTER_V2_EXACT_INPUT.calldata(bytes.fromhex(path.leg_data()[2:]), amount_in)
    if amount_in >= 1 << 128:
        raise QuoteError('quote_amount_invalid')
    if len(path.hops) == 1:
        pool = path.hops[0]
        key = (pool.currency0, pool.currency1, pool.fee, pool.tick_spacing, pool.hooks)
        return chain.uniswap.v4.quoter, V4_QUOTER_EXACT_INPUT_SINGLE.calldata(
            (key, path.token_in == pool.currency0, amount_in, b''))
    keys = [(token, pool.fee, pool.tick_spacing, pool.hooks, b'') for pool, token in zip(path.hops, path.tokens[1:])]
    return chain.uniswap.v4.quoter, V4_QUOTER_EXACT_INPUT.calldata((path.token_in, keys, amount_in))


class PoolQuoter:
    """Quotes at one pinned block, every call of a round in one Multicall3 eth_call. A round asked again is answered
    from the first, since the block is pinned (3 Nov 2026: a token split between two pool tokens through the same
    hubs asked for its first hops twice)."""

    def __init__(self, chain, rpc, block):
        self.chain, self.rpc, self.block = chain, rpc, block
        self.rounds = 0
        self._answered = {}

    def quote(self, paths, amount_in):
        """One Quote (or None) per path for the same exact input."""
        return self.quote_each([(path, amount_in) for path in paths])

    def quote_each(self, requests):
        """One Quote (or None) per (path, amount_in)."""
        requests = [(path, int(amount)) for path, amount in requests if int(amount) > 0]
        if not requests:
            return []
        calls = tuple(quote_call(self.chain, p, a) for p, a in requests)
        rows = self._answered.get(calls)
        if rows is None:
            rows = self._answered[calls] = multicall(self.rpc, self.chain, self.block, list(calls))
            self.rounds += 1
        out = []
        for (path, amount), row in zip(requests, rows):
            if path.dex == DEX_V3:
                values = decoded(QUOTER_V2_EXACT_INPUT, row)
                if values is None or values[0] == 0 or len(values[1]) != len(path.hops):
                    out.append(None)
                    continue
                out.append(Quote(path, amount, values[0], tuple(values[1]), values[3], 'quoter_v2'))
            else:
                abi = V4_QUOTER_EXACT_INPUT_SINGLE if len(path.hops) == 1 else V4_QUOTER_EXACT_INPUT
                values = decoded(abi, row)
                if values is None or values[0] == 0:
                    out.append(None)
                    continue
                out.append(Quote(path, amount, values[0], None, values[1], 'v4_quoter'))
        return out


def best(quotes):
    """The quote that delivers the most; ties go to fewer hops, then the order given."""
    ranked = [(q.amount_out, -len(q.path.hops), -index, q) for index, q in enumerate(quotes) if q is not None]
    return max(ranked)[3] if ranked else None


def best_two_hop(quoter, token_in, token_out, hubs, amount_in, *, exclude=()):
    """The best two-hop path through a hub, chosen hop by hop on the same dex
    (two rounds): the best first hop to each hub, then the best second hop
    for what it delivers. Returns the full path's Quote, or None."""
    chain = quoter.chain
    firsts = []
    for hub in hubs:
        if hub in (token_in, token_out):
            continue
        firsts.extend(candidate_paths(chain, token_in, hub, exclude=exclude))
    first_quotes = quoter.quote(firsts, amount_in)
    chosen = {}
    for quote in first_quotes:
        if quote is None:
            continue
        key = (quote.path.dex, quote.path.token_out)
        if key not in chosen or quote.amount_out > chosen[key].amount_out:
            chosen[key] = quote
    seconds = []
    for (dex, hub), first in chosen.items():
        for path in candidate_paths(chain, hub, token_out, exclude=exclude, v3=dex == DEX_V3, v4=dex == DEX_V4):
            seconds.append((Path(dex, token_in, (*first.path.hops, *path.hops)), amount_in))
    return best(quoter.quote_each(seconds)) if seconds else None


# ------------------------------------------------------------------ ticks

def _word_slot(state_slot, position):
    return keccak(encode(['int256', 'uint256'], [position, state_slot + V4_TICK_BITMAP_OFFSET]))


def _tick_slot(state_slot, tick):
    return keccak(encode(['int256', 'uint256'], [tick, state_slot + V4_TICKS_OFFSET]))


def _signed128(word):
    value = word >> 128
    return value - (1 << 128) if value >> 127 else value


class _ChainTicks(TickSource):
    """Bitmap words and liquidityNet read on demand, in Multicall3 batches."""

    def __init__(self, chain, rpc, block, spacing):
        super().__init__()
        self.chain, self.rpc, self.block, self.spacing = chain, rpc, block, spacing
        self.reads = 0

    def _word_calls(self, positions):
        raise NotImplementedError

    def _tick_calls(self, ticks):
        raise NotImplementedError

    def load_words(self, positions):
        wanted = sorted({p + d for p in positions for d in range(-TICK_PREFETCH_WORDS, TICK_PREFETCH_WORDS + 1)
                         if -(1 << 15) <= p + d < 1 << 15} - set(self.words))
        rows = multicall(self.rpc, self.chain, self.block, self._word_calls(wanted))
        self.reads += 1
        for position, row in zip(wanted, rows):
            self.words[position] = self._word_value(row)

    def load_ticks(self, ticks):
        known = sorted({(p * 256 + bit) * self.spacing for p, word in self.words.items()
                        for bit in range(256) if word >> bit & 1} - set(self.nets))
        center = ticks[0]
        nearest = sorted(known, key=lambda t: abs(t - center))[:TICK_PREFETCH_TICKS]
        wanted = sorted(set(ticks) | set(nearest))
        rows = multicall(self.rpc, self.chain, self.block, self._tick_calls(wanted))
        self.reads += 1
        for tick, row in zip(wanted, rows):
            self.nets[tick] = self._tick_value(row)


class V4Ticks(_ChainTicks):
    def __init__(self, chain, rpc, block, pool):
        super().__init__(chain, rpc, block, pool.tick_spacing)
        self.state_slot = int.from_bytes(keccak(encode(['bytes32', 'uint256'],
                                                       [bytes.fromhex(pool.pool_id[2:]), V4_POOLS_SLOT])), 'big')
        self.manager = chain.uniswap.v4.poolManager
        self.extsload = function('IV4PoolManagerMinimal', 'extsload')

    def _word_calls(self, positions):
        return [(self.manager, self.extsload.calldata(_word_slot(self.state_slot, p))) for p in positions]

    def _tick_calls(self, ticks):
        return [(self.manager, self.extsload.calldata(_tick_slot(self.state_slot, t))) for t in ticks]

    def _word_value(self, row):
        value = decoded(self.extsload, row)
        if value is None:
            raise QuoteError('quote_tick_read_failed')
        return int.from_bytes(value[0], 'big')

    def _tick_value(self, row):
        return _signed128(self._word_value(row))


class V3Ticks(_ChainTicks):
    def __init__(self, chain, rpc, block, pool_address, spacing):
        super().__init__(chain, rpc, block, spacing)
        self.pool = pool_address
        self.ticks_fn = function('IUniswapV3PoolMinimal', 'ticks')

    def _word_calls(self, positions):
        return [(self.pool, V3_TICK_BITMAP.calldata(p)) for p in positions]

    def _tick_calls(self, ticks):
        return [(self.pool, self.ticks_fn.calldata(t)) for t in ticks]

    def _word_value(self, row):
        value = decoded(V3_TICK_BITMAP, row)
        if value is None:
            raise QuoteError('quote_tick_read_failed')
        return value[0]

    def _tick_value(self, row):
        ok, payload = row
        if not ok:
            raise QuoteError('quote_tick_read_failed')
        try:
            return decode(list(self.ticks_fn.outputs), payload)[1]
        except Exception:
            raise QuoteError('quote_answer_invalid') from None


def pool_snapshot(chain, rpc, block, state):
    """A PoolSnapshot of a v2_uniswap PoolState, its ticks read on demand."""
    pool = state.pool
    if pool.dex == DEX_V4:
        if pool.hooks != ZERO:
            raise QuoteError('quote_hooked_pool_not_simulated')
        ticks = V4Ticks(chain, rpc, block, pool)
    else:
        ticks = V3Ticks(chain, rpc, block, state.address, pool.tick_spacing)
    # v4's protocol fee per direction (slot0.protocolFee: zeroForOne in the low
    # 12 bits) lets the simulator split each step's fee as Pool.swap does.
    protocol = (state.protocol_fee & 0xfff, state.protocol_fee >> 12) if pool.dex == DEX_V4 else None
    return PoolSnapshot(state.sqrt_price_x96, state.tick, state.liquidity, pool.tick_spacing,
                        (state.swap_fee_pips(True), state.swap_fee_pips(False)), ticks, protocol)


@lru_cache(maxsize=None)
def published_selectors():
    """The selectors this module calls outside the F0 exports, by contract."""
    return {'Multicall3': {AGGREGATE3.signature: AGGREGATE3.selector, GET_ETH_BALANCE.signature: GET_ETH_BALANCE.selector},
            'QuoterV2': {QUOTER_V2_EXACT_INPUT.signature: QUOTER_V2_EXACT_INPUT.selector},
            'V4Quoter': {V4_QUOTER_EXACT_INPUT_SINGLE.signature: V4_QUOTER_EXACT_INPUT_SINGLE.selector,
                         V4_QUOTER_EXACT_INPUT.signature: V4_QUOTER_EXACT_INPUT.selector},
            'UniswapV3Pool': {V3_TICK_BITMAP.signature: V3_TICK_BITMAP.selector},
            'ERC20': {ERC20_BALANCE_OF.signature: ERC20_BALANCE_OF.selector,
                      ERC20_ALLOWANCE.signature: ERC20_ALLOWANCE.selector,
                      ERC20_DECIMALS.signature: ERC20_DECIMALS.selector}}


@dataclass
class ReadPlan:
    """Independent reads gathered for one Multicall3 round."""
    calls: list = field(default_factory=list)
    decoders: list = field(default_factory=list)

    def add(self, target, abi_or_fn, *args):
        self.calls.append((target, abi_or_fn.calldata(*args)))
        self.decoders.append(abi_or_fn)
        return len(self.calls) - 1

    def run(self, rpc, chain, block):
        rows = multicall(rpc, chain, block, self.calls) if self.calls else []
        out = []
        for decoder, (ok, payload) in zip(self.decoders, rows):
            if not ok:
                out.append(None)
                continue
            try:
                values = decode(list(decoder.outputs), payload)
            except Exception:
                out.append(None)
                continue
            out.append(values)
        return out
