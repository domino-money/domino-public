"""read-v6's live chain reads (app spec F7 §6.2; 0xdecimal's items 1-3 of 5 Oct 2026): the pools of a token on a
chain, a wallet's balances on each chain, and token search on Base and Arbitrum One.

Unlike portfolio and activity, these read the chains when asked, so the app lists pools and balances without
moving the wallet to another network (it still does, to sign: §1.3).

- Robinhood reads Domino's own node through the reader's provider file; Base and Arbitrum read the V2 chain RPC
  file's hosted endpoints (F6, v2_rpc), billed per call. Each answer is one Multicall3 call per chain at the
  chain's head (v2_head), chain-pools' a few more for the depths (CHAIN_READ_REQUESTS bounds them all), and answers
  are cached for a few seconds, so a busy page costs little more than a quiet one. Calls go over kept HTTPS
  connections (kept_rpc), and the chains of one answer are read at once (each_chain).
- chain-pools reads the pools the app reads today through the wallet: the token against the chain's base
  currencies (its charge currencies: the stable, the native currency and its wrapped token) or one paired token,
  in Uniswap's standard hookless v4 keys and the v3 fee tiers the profile and the factory enable (Base adds 200,
  300 and 400). A v3 pool's address is the factory's CREATE2 address, so its state is read in the same call. A
  pool is listed once it exists, is priced and holds liquidity, partners ETH and WETH first, then the stable,
  then by active liquidity.
- chain-balances reads native and ERC-20 balances, by default each Domino chain's base currencies. Asked by `tokens`, it
  also reads the balance chains (BALANCE_CHAINS: Ethereum and OP Mainnet, the owner's decision of 6 Oct 2026; their
  profiles are v2_chains.BalanceChainProfile) through the reader's balance chain RPC file, priced by the same rules on
  their own stable, feed and pools. Without that file, or with a fault in it, those two answer `chain_not_configured`
  and every other chain reads as before.
- chain-tokens searches the tokens Domino knows on Base and Arbitrum (the owner's decision of 5 Oct 2026): the
  chain profile's, the Uniswap Labs Default token list's (backend/data/token-lists, GPL-3.0, pinned), those the
  V2 index read, and those a chain-pools read found priced pools for, as Robinhood's catalogue learns from
  visitors. Like read-v3's search it covers known tokens only.

Symbols and names are untrusted text: they come back as read, printable and bounded, never as a claim of identity
(a token is its chain and address). USD comes only from qualified sources (read-v6 1.1.0-rc.1, below).
"""
from collections import OrderedDict
import contextvars
from dataclasses import dataclass, field
from fractions import Fraction
import json
from math import isqrt
import os
from pathlib import Path
import re
import tempfile
import threading
import time

from eth_abi import decode

from discovery import CHAIN_ID, KEEPALIVE_OPENER, ZERO, DataError, address, rpc_http
import hop_log
from v2_abi import function
from v2_chains import DEX_V3, DEX_V4, default_balance_registry, default_registry
from v2_quotes import (AGGREGATE3, ERC20_BALANCE_OF, GET_ETH_BALANCE, MULTICALL_GAS, V4_STANDARD_KEYS, Abi, QuoteError,
                       multicall)
from read_deadline import read_deadline, read_timeout
from v2_read_contract import (BALANCE_CHAIN_IDS, CHAIN_IDS, CONTRACT_VERSION, LIVE_LIMITATIONS, MAX_CHAIN_POOLS,
                              SEARCH_CHAIN_IDS)
from v2_uniswap import PIPS, PoolRef, v3_pool_address
from v4_math import MAX_SQRT, MIN_SQRT, amount_delta, sqrt_at_tick, tick_at_sqrt

# The chains read-v6 serves, its contract's lists (v2_read_contract): Domino's, and the search chains; a chain whose
# profile is enabled reads here once the contract names it.
POOL_CHAINS = CHAIN_IDS
SEARCH_CHAINS = SEARCH_CHAIN_IDS
# chain-balances' other chains, read only when asked (v2_read_contract.BALANCE_CHAIN_IDS has both kinds).
BALANCE_CHAINS = tuple(chain_id for chain_id in BALANCE_CHAIN_IDS if chain_id not in CHAIN_IDS)
# The v3 fee tiers Uniswap governance enabled on Base beyond the profile's standard four (the app's
# BASE_EXTRA_V3_TIERS); each is listed only while the factory still returns this tick spacing for it.
EXTRA_V3_TIERS = {8453: {200: 4, 300: 6, 400: 8}}
MIN_TICK, MAX_TICK = -887272, 887272
HEAD_MAX_AGE_SECONDS, HEAD_MAX_BLOCK_AGE_SECONDS = 4, 120
POOLS_CACHE_SECONDS, BALANCES_CACHE_SECONDS, INDEX_TOKENS_CACHE_SECONDS = 15, 10, 60
FRESH_SECONDS = 60
MAX_CACHED, MAX_INDEX_TOKENS, MAX_LEARNED_PER_CHAIN = 512, 2000, 5000
MAX_SYMBOL, MAX_NAME = 40, 64
# A source of a known token, and the order its matches rank in (the curated ones first).
SOURCES = ('profile', 'uniswap_default_list', 'v2_activity', 'looked_up')
TOKEN_LIST = Path(__file__).resolve().parent / 'data' / 'token-lists' / 'uniswap-default.json'
DECIMALS = Abi('decimals()', (), ('uint8',))
RAW_TEXT = ('bytes',)  # symbol() and name(): decoded by hand, string or bytes32
SYMBOL = Abi('symbol()', (), RAW_TEXT)
NAME = Abi('name()', (), RAW_TEXT)
V4_STATE, V3_FACTORY, V3_POOL = 'IV4StateViewMinimal', 'IUniswapV3FactoryMinimal', 'IUniswapV3PoolMinimal'


def text(value, limit):
    """Untrusted metadata the read API serves as it is: non-empty, bounded, unpadded and printable."""
    return isinstance(value, str) and 0 < len(value) <= limit and value == value.strip() and value.isprintable()


def raw_text(ok, payload, limit):
    """symbol() or name() as returned: an ABI string, or a legacy bytes32; None when unreadable or unsafe."""
    if not ok or not payload:
        return None
    try:
        if len(payload) == 32:
            value = payload.rstrip(b'\x00').decode('utf-8')
        else:
            value, = decode(['string'], payload)
    except Exception:
        return None
    return value if text(value, limit) else None


def word(ok, payload, types):
    if not ok or not payload:
        return None
    try:
        return decode(list(types), payload)
    except Exception:
        return None


# ------------------------------------------------------------------ chains
def base_currencies(chain):
    """The chain's charge currencies, the pairs the app offers: (address, symbol, decimals), by rank then address."""
    return [(c.address, c.symbol, c.decimals) for c in sorted(chain.chargeCurrencies, key=lambda c: (c.rank, c.address))]


def v3_tiers(chain):
    """The v3 fee tiers a pool may have on `chain`: none on a chain without v3."""
    if DEX_V3 not in chain.dexes:
        return {}
    tiers = {int(fee): spacing for fee, spacing in chain.uniswap.v3.tickSpacingByFee.items()}
    return {**tiers, **EXTRA_V3_TIERS.get(chain.chainId, {})}


def pool_candidates(chain, token, paired=None):
    """The pools to read for `token`, as the app reads them through the wallet: v4's standard hookless keys with
    each partner, native ETH as itself; then v3's tiers, ETH becoming WETH, none for native ETH itself. A pair of
    the same token, or of ETH and WETH, is no pool. Only the Uniswap versions the chain has."""
    wrapped = chain.wrappedNative.address
    partners = [paired] if paired is not None else [entry[0] for entry in base_currencies(chain)]
    partners = [p for p in partners if p != token and {p, token} != {ZERO, wrapped}]
    refs = []
    for partner in partners if DEX_V4 in chain.dexes else ():
        low, high = sorted((token, partner))
        refs.extend(PoolRef(DEX_V4, low, high, fee, spacing) for fee, spacing in V4_STANDARD_KEYS)
    if token != ZERO:  # v3_tiers: none on a chain without v3
        seen = []
        for partner in partners:
            partner = wrapped if partner == ZERO else partner
            if partner != token and partner not in seen:
                seen.append(partner)
        for partner in seen:
            low, high = sorted((token, partner))
            refs.extend(PoolRef(DEX_V3, low, high, fee, spacing) for fee, spacing in sorted(v3_tiers(chain).items()))
    return refs


def swap_fees(dex, lp_fee, protocol_fee):
    """What a swap pays in each direction, in pips of its input (v2_uniswap.PoolState.swap_fee_pips)."""
    if dex == DEX_V3:
        return lp_fee, lp_fee  # v3's protocol fee is a share of the LP fee, not on top of it
    fees = []
    for protocol in (protocol_fee & 0xfff, protocol_fee >> 12):
        fees.append(lp_fee if protocol == 0 else protocol + lp_fee - protocol * lp_fee // PIPS)
    return tuple(fees)


def partner_rank(chain, ref, token):
    """The app's order: the native currency and its wrapped token first, then the other partners (the stables, or
    the one paired token)."""
    partner = ref.currency1 if ref.currency0 == token else ref.currency0
    return 0 if partner in (ZERO, chain.wrappedNative.address) else 1


# ------------------------------------------------------------- token list
def load_token_list(path=TOKEN_LIST):
    """The pinned Uniswap Labs Default subset: (provenance, {chain id: [(address, symbol, name, decimals)]})."""
    document = json.loads(Path(path).read_text(encoding='utf-8'))
    source = document.get('source') or {}
    if (document.get('schemaVersion') != 1 or document.get('kind') != 'domino-token-list-subset'
            or source.get('license') != 'GPL-3.0' or not re.fullmatch(r'[0-9a-f]{64}', source.get('sha256') or '')
            or not re.fullmatch(r'[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}', source.get('version') or '')
            or document.get('chains') != list(SEARCH_CHAINS)):
        raise DataError('token_list_invalid')
    tokens, seen = {chain: [] for chain in SEARCH_CHAINS}, set()
    for entry in document.get('tokens') or []:
        chain, token = entry.get('chainId'), entry.get('address')
        if (chain not in tokens or not isinstance(token, str) or not re.fullmatch(r'0x[0-9a-f]{40}', token)
                or (chain, token) in seen or type(entry.get('decimals')) is not int or not 0 <= entry['decimals'] <= 255
                or not text(entry.get('symbol'), MAX_SYMBOL) or not text(entry.get('name'), MAX_NAME)):
            raise DataError('token_list_invalid')
        seen.add((chain, token))
        tokens[chain].append((token, entry['symbol'], entry['name'], entry['decimals']))
    return {'name': source['name'], 'version': source['version'], 'sha256': source['sha256']}, tokens


class LearnedTokens:
    """Tokens a chain-pools read found priced pools for, per search chain, kept across restarts in the reader's
    runtime directory: the least recently seen go first past MAX_LEARNED_PER_CHAIN."""

    def __init__(self, path=None, *, clock=time.time, limit=MAX_LEARNED_PER_CHAIN):
        self.path, self.clock, self.limit = (Path(path) if path is not None else None), clock, limit
        self.lock = threading.Lock()
        self.entries = {chain: OrderedDict() for chain in SEARCH_CHAINS}
        if self.path is not None and self.path.exists():
            try:
                stored = json.loads(self.path.read_text(encoding='utf-8'))
            except (OSError, ValueError):
                stored = {}
            for chain in SEARCH_CHAINS:
                for item in (stored.get(str(chain)) or [])[-limit:]:
                    if (isinstance(item, list) and len(item) == 4 and isinstance(item[0], str)
                            and re.fullmatch(r'0x[0-9a-f]{40}', item[0]) and text(item[1], MAX_SYMBOL)
                            and (item[2] is None or text(item[2], MAX_NAME))
                            and type(item[3]) is int and 0 <= item[3] <= 255):
                        self.entries[chain][item[0]] = tuple(item[1:])

    def learn(self, chain, token, symbol, name, decimals):
        if chain not in self.entries:
            return
        with self.lock:
            known = self.entries[chain]
            changed = known.get(token) != (symbol, name, decimals)
            known[token] = (symbol, name, decimals)
            known.move_to_end(token)
            while len(known) > self.limit:
                known.popitem(last=False)
                changed = True
            if changed:
                self._save()

    def tokens(self, chain):
        with self.lock:
            return [(token, *values) for token, values in self.entries.get(chain, {}).items()]

    def _save(self):
        if self.path is None:
            return
        document = {str(chain): [[token, *values] for token, values in known.items()]
                    for chain, known in self.entries.items()}
        try:
            fd, temporary = tempfile.mkstemp(prefix='.learned-', dir=self.path.parent)
            with os.fdopen(fd, 'w', encoding='utf-8') as stream:
                json.dump(document, stream, ensure_ascii=False)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        except OSError:
            pass  # a lost write only forgets what the next reads learn again


class TimedCache:
    def __init__(self, seconds, *, clock=time.monotonic, limit=MAX_CACHED):
        self.seconds, self.clock, self.limit = seconds, clock, limit
        self.items, self.lock = OrderedDict(), threading.Lock()

    def get(self, key):
        with self.lock:
            item = self.items.get(key)
            if item is None or self.clock() - item[0] > self.seconds:
                return None
            return item[1]

    def put(self, key, value):
        with self.lock:
            self.items[key] = (self.clock(), value)
            self.items.move_to_end(key)
            while len(self.items) > self.limit:
                self.items.popitem(last=False)


# ------------------------------------------------------------ qualified USD
# read-v6's USD (0xdecimal's item 4): the owner's decision #22 of 2 Oct 2026 (F7 §6.3) and the owner's answers
# of 5 Oct 2026. A token has a USD price from one of three sources and from nothing else:
# - the chain's stable, its rank-1 charge currency (USDG on Robinhood Chain, USDC on Base and Arbitrum One, and on the
#   balance chains Ethereum and OP Mainnet): US$ 1, fixed;
# - ETH and its wrapped token: the profile's Chainlink ETH/USD (gasPrice.chainlinkEthUsd) while its round is no
#   older than the feed's heartbeat at the block read and, where the profile names a sequencer uptime feed (Base,
#   Arbitrum, OP Mainnet), the sequencer has been up for longer than SEQUENCER_GRACE_SECONDS;
# - on a chain Chainlink does not serve (gasPrice.poolNativeUsd: Elysium's HYPE), the native currency and its wrapped
#   token instead: the spot of the pool the profile names, against the stable, once that pool qualifies as any pool
#   price does (below), its walk the native currency sold for the stable. Such a price is source `pool`, that pool,
#   no `ethUsd`; and no price on that chain carries a feed's round;
# - any other token: its deepest pool against one of those, among the app's candidates (pool_candidates), once that
#   pool releases at least FLOOR_USD of the partner as the token is sold into it until its price falls by BAND:
#   the featured pools' reference depth (featured_pools.reference_depth with featured_policy.json's floor, band
#   and steps), its liquidity walked tick by tick and read in the same block as its price.
# Anything else has no USD, with its reason. While a chain's sequencer is down, only its stable keeps a price. Where
# the native pool does not qualify, the native currency says why as a pool would (no_pool, pool_depth_below_floor,
# pool_depth_unmeasurable, price_read_failed), and what only it could value has no qualified source
# (no_qualified_price_source; a pool's market: no_qualified_reference), unless its read failed.
CHAINLINK_ROUND = Abi('latestRoundData()', (), ('uint80', 'int256', 'uint256', 'uint256', 'uint80'))
V4_TICK_BITMAP = Abi('getTickBitmap(bytes32,int16)', ('bytes32', 'int16'), ('uint256',))
V4_TICK_LIQUIDITY = Abi('getTickLiquidity(bytes32,int24)', ('bytes32', 'int24'), ('uint128', 'int128'))
V3_TICK_BITMAP = Abi('tickBitmap(int16)', ('int16',), ('uint256',))
V3_TICK = Abi('ticks(int24)', ('int24',), ('uint128', 'int128', 'uint256', 'uint256', 'int56', 'uint160', 'uint32',
                                          'bool'))
FLOOR_USD, BAND, MAX_STEPS = Fraction(10_000), Fraction(1, 10), 300
SEQUENCER_GRACE_SECONDS = 3600  # Chainlink's own L2 example: an hour after the sequencer is back up
PRICES_CACHE_SECONDS, MAX_PRICED = 30, 32  # a pass prices at most MAX_PRICED tokens a chain
# A pass has this long on its chain, so a slow endpoint costs the answer its prices, never the answer.
PRICING_BUDGET_SECONDS = 3
PRICE_SCALE, USD_SCALE = 10 ** 18, 10 ** 6
U256_MASK = (1 << 256) - 1
# What one read at a chain's head may send (5 Oct 2026: 13 pools of USDC on Base needed 11 calls of 64 reads, and the
# read was refused at its 9th). A survey sends at most 4 Multicall3 calls of SURVEY_CALLS reads: its pools, then
# DEPTH_WORDS of their bitmap words, then DEPTH_TICKS of their initialized ticks in two. v3's ticks() is the heaviest
# read, about 10k gas, so a call stays far below MULTICALL_GAS and its answer (~200 KB) below the transport's 2 MB.
# The other requests are for an endpoint failover: its proof of the head and the call again.
CHAIN_READ_REQUESTS, SURVEY_CALLS, DEPTH_WORDS, DEPTH_TICKS = 8, 512, 512, 1024


def decimal_text(value, scale):
    """A non-negative amount as a decimal with as many places as `scale` has zeros, rounded down."""
    scaled = value.numerator * scale // value.denominator
    return f'{scaled // scale}.{scaled % scale:0{len(str(scale)) - 1}d}'


def stable_of(chain):
    """The chain's stable: its rank-1 charge currency."""
    return base_currencies(chain)[0]


def snapshot_of(block):
    return {'number': block.number, 'hash': block.hash, 'timestamp': block.timestamp}


def native_pool_of(chain):
    """(PoolRef, its v3 address or None, the native currency in it) of the pool that prices the chain's native currency
    (gasPrice.poolNativeUsd), or None where Chainlink does (`native_feed`; every balance chain)."""
    source = getattr(chain, 'native_pool', None)
    if source is None:
        return None
    low, high = sorted((source.currency, source.stable))
    if source.dex == DEX_V3:
        return PoolRef(DEX_V3, low, high, source.fee, chain.v3_tick_spacing(source.fee)), source.pool, source.currency
    return PoolRef(DEX_V4, low, high, source.fee, source.tickSpacing), None, source.currency


def price_profile(chain):
    """read-v6's PRICE_PROFILES entry of a chain (a Domino chain's or a balance chain's profile): its stable and wrapped
    token, and the feed and heartbeat that price ETH or, on a chain without Chainlink, the pool that prices its native
    currency (`nativePool`, a wire PoolRef). v2_read_contract keeps them as constants, held to this by its tests."""
    entry = {'stable': stable_of(chain)[0], 'wrapped': chain.wrappedNative.address}
    native = native_pool_of(chain)
    if native is None:
        feed = chain.gasPrice.chainlinkEthUsd
        return {**entry, 'feed': feed.proxy, 'heartbeatSeconds': feed.heartbeatSeconds}
    return {**entry, 'feed': None, 'heartbeatSeconds': None, 'nativePool': pool_wire(native[0])}


def native_reasons(reason):
    """What a currency only the native one could value says when the native pool did not qualify: its price's reason,
    and a pool market's (MARKET_REASONS). A failed read is said as one, so a later pass tries again."""
    if reason == 'price_read_failed':
        return reason, reason
    return 'no_qualified_price_source', 'no_qualified_reference'


def eth_usd(chain, feed_row, uptime_row, block):
    """The profile's Chainlink ETH/USD at `block`: (usd, its wire entry, None), or (None, None, reason)."""
    feed = chain.gasPrice.chainlinkEthUsd
    if feed.sequencerUptimeFeed is not None:
        status = word(*uptime_row, CHAINLINK_ROUND.outputs)
        if status is None:
            return None, None, 'price_read_failed'
        # 0 is up; startedAt is when the status last changed (0 on a feed not yet initialized).
        if status[1] != 0 or status[2] == 0 or block.timestamp - status[2] <= SEQUENCER_GRACE_SECONDS:
            return None, None, 'sequencer_down'
    answer = word(*feed_row, CHAINLINK_ROUND.outputs)
    if answer is None:
        return None, None, 'price_read_failed'
    round_id, value, _, updated_at, _ = answer
    if value <= 0 or updated_at > block.timestamp or block.timestamp - updated_at > feed.heartbeatSeconds:
        return None, None, 'eth_usd_stale'
    usd = Fraction(value, 10 ** feed.decimals)
    return usd, {'feed': address(feed.proxy), 'usd': decimal_text(usd, PRICE_SCALE), 'roundId': str(round_id),
                 'updatedAt': updated_at}, None


def _next_initialized(bitmap, tick, spacing, zero_for_one):
    """TickBitmap.nextInitializedTickWithinOneWord, on integers (automation_evidence's)."""
    compressed = tick // spacing
    if zero_for_one:
        word_pos, bit_pos = compressed >> 8, compressed & 255
        masked = bitmap(word_pos) & ((1 << (bit_pos + 1)) - 1)
        if masked:
            return (compressed - (bit_pos - (masked.bit_length() - 1))) * spacing, True
        return (compressed - bit_pos) * spacing, False
    compressed += 1
    word_pos, bit_pos = compressed >> 8, compressed & 255
    masked = bitmap(word_pos) & (~((1 << bit_pos) - 1) & U256_MASK)
    if masked:
        return (compressed + ((masked & -masked).bit_length() - 1 - bit_pos)) * spacing, True
    return (compressed + (255 - bit_pos)) * spacing, False


def band_bound(sqrt_price, zero_for_one):
    """The square-root price at which the token sold into the pool is BAND cheaper (featured_pools.band_bound)."""
    keep = 1 - BAND
    square = sqrt_price * sqrt_price
    bound = (isqrt(square * keep.numerator // keep.denominator) if zero_for_one
             else isqrt(square * keep.denominator // keep.numerator))
    return min(max(bound, MIN_SQRT), MAX_SQRT - 1)


def reference_depth(bitmap, tick_net, *, sqrt_price, tick, liquidity, spacing, zero_for_one):
    """The partner, raw, the pool releases as the other currency is sold into it until the band is crossed
    (featured_pools.reference_depth): None when the walk needs more than MAX_STEPS steps."""
    bound = band_bound(sqrt_price, zero_for_one)
    currency = 1 if zero_for_one else 0
    price, amount, steps = sqrt_price, 0, 0
    while price != bound:
        steps += 1
        if steps > MAX_STEPS:
            return None
        next_tick, initialized = _next_initialized(bitmap, tick, spacing, zero_for_one)
        next_tick = max(MIN_TICK, min(MAX_TICK, next_tick))
        next_price = sqrt_at_tick(next_tick)
        target = max(next_price, bound) if zero_for_one else min(next_price, bound)
        if target != price:
            amount += amount_delta(price, target, max(0, liquidity), currency, False)
            price = target
        if price == bound:
            break
        if initialized:
            net = tick_net(next_tick)
            liquidity += -net if zero_for_one else net
        tick = next_tick - 1 if zero_for_one else next_tick
    return amount


def band_ticks(sqrt_price, tick, spacing, zero_for_one):
    """The compressed ticks between `tick` and the band's bound, both included: the only ones a walk can cross, as it
    stops at the bound and never turns back. Their liquidity is all a depth reads, however many more are initialized
    around them (5 Oct 2026: a word of margin each side had Base's deepest USDC pools past MAX_STEPS)."""
    bound = tick_at_sqrt(band_bound(sqrt_price, zero_for_one)) // spacing
    return tuple(sorted((tick // spacing, bound)))


def band_words(low, high):
    """The bitmap words a walk over the compressed ticks `low`..`high` may read: theirs, and the next one up, which a
    rising walk reads when its last word ends below the bound."""
    return range(low >> 8, (high >> 8) + 2)


@dataclass
class PoolRead:
    ref: object
    address: object  # a v3 pool's; None for v4
    sqrt: int
    tick: int
    liquidity: int
    lp_fee: int
    protocol: int


@dataclass
class Survey:
    """One chain's pools at one block, with the native currency's USD and each listed pool's depth in USD."""
    chain: object
    block: object
    pools: list  # PoolRead, listed: existing, priced, holding liquidity, in shape
    subjects: dict  # PoolRef -> the token the pool is read for
    metadata: dict  # token -> (decimals, symbol, name) as read
    # The native currency's USD as the other prices see it: eth_usd's (usd, the feed's wire entry, reason); on a chain
    # its pool prices, (usd, None, the reason a price that needs it has none).
    eth: tuple
    depths: dict  # PoolRef -> (USD, None) or (None, reason), for each listed pool
    unread: set = field(default_factory=set)  # PoolRefs whose depth reads failed
    skipped: set = field(default_factory=set)  # PoolRefs left unmeasured: past the survey's depth reads
    # A chain its pool prices: that pool as read (None if out of shape), then the native currency's own price,
    # (wire entry, None) or (None, reason), once measured. Both None on a chain Chainlink prices.
    native_pool: object = None
    native: tuple = None

    def partner(self, pool):
        subject = self.subjects[pool.ref]
        return pool.ref.currency1 if pool.ref.currency0 == subject else pool.ref.currency0

    def reference_prices(self):
        """{base currency: (USD, decimals)} this survey can value a pool's partner in."""
        out = {}
        for token, _, decimals in base_currencies(self.chain):
            if token == stable_of(self.chain)[0]:
                out[token] = (Fraction(1), decimals)
            elif self.eth[0] is not None:
                out[token] = (self.eth[0], decimals)
        return out

    def reference_reason(self):
        """Why a pool against the native currency or its wrapped token is not measured (MARKET_REASONS): the feed's
        reason, or what the native pool's own says to a pool's market."""
        return self.eth[2] if self.native is None else native_reasons(self.native[1])[1]

    def price(self, token, decimals):
        """(price wire entry, None) or (None, reason) for `token`, from this survey alone."""
        chain, wrapped = self.chain, self.chain.wrappedNative.address
        if token == stable_of(chain)[0]:
            return {'usd': decimal_text(Fraction(1), PRICE_SCALE), 'source': 'chain_stable', 'snapshot': None,
                    'ethUsd': None, 'pool': None, 'depthUsd': None}, None
        usd, entry, reason = self.eth
        if token in (ZERO, wrapped):
            if self.native is not None:
                return self.native  # the profile's pool, never a feed
            if usd is None:
                return None, reason
            return {'usd': entry['usd'], 'source': 'chainlink_eth_usd', 'snapshot': snapshot_of(self.block),
                    'ethUsd': entry, 'pool': None, 'depthUsd': None}, None
        if reason == 'sequencer_down':
            return None, reason
        if decimals is None:
            return None, 'decimals_unknown'
        own = [pool for pool in self.pools if self.subjects[pool.ref] == token]
        measured = [(self.depths[pool.ref][0], pool) for pool in own if self.depths[pool.ref][0] is not None]
        qualified = [(depth, pool) for depth, pool in measured if depth >= FLOOR_USD]
        if not qualified:
            # A pool not read or not measured here may be the one that qualifies: say so, and let a later pass try.
            if any(pool.ref in self.unread for pool in own):
                return None, 'price_read_failed'
            if any(pool.ref in self.skipped for pool in own):
                return None, 'pricing_limit_reached'
            reasons = {self.depths[pool.ref][1] for pool in own}
            return None, ('pool_depth_below_floor' if measured else 'pool_depth_unmeasurable'
                          if 'pool_depth_unmeasurable' in reasons else reason
                          if reason is not None and any(self.partner(pool) != stable_of(chain)[0] for pool in own)
                          else 'no_pool')
        depth, pool = min(qualified, key=lambda item: (-item[0], partner_rank(chain, item[1].ref, token),
                                                       item[1].ref.dex == DEX_V3, item[1].ref.fee))
        partner = self.partner(pool)
        partner_usd, partner_decimals = self.reference_prices()[partner]
        ratio = Fraction(pool.sqrt * pool.sqrt, 1 << 192)  # currency1 per currency0, raw
        spot = (ratio if pool.ref.currency0 == token else 1 / ratio) * Fraction(10 ** decimals, 10 ** partner_decimals)
        usd_text = decimal_text(spot * partner_usd, PRICE_SCALE)
        if usd_text == decimal_text(Fraction(0), PRICE_SCALE):
            return None, 'price_below_precision'
        return {'usd': usd_text, 'source': 'pool', 'snapshot': snapshot_of(self.block),
                'ethUsd': entry if partner in (ZERO, wrapped) else None, 'pool': pool_wire(pool.ref),
                'depthUsd': decimal_text(depth, USD_SCALE)}, None


def pool_wire(ref):
    return {'dex': ref.dex, 'currency0': ref.currency0, 'currency1': ref.currency1, 'fee': ref.fee,
            'tickSpacing': ref.tick_spacing, 'hooks': ref.hooks}


def aggregate(rpc, chain, block, calls):
    """v2_quotes.multicall in calls of SURVEY_CALLS: one request a round, not one per 64 reads."""
    results = []
    for start in range(0, len(calls), SURVEY_CALLS):
        chunk = calls[start:start + SURVEY_CALLS]
        data = AGGREGATE3.calldata([(address(target), True, bytes.fromhex(payload[2:])) for target, payload in chunk])
        raw = rpc.request('eth_call', [{'to': chain.multicall3, 'data': data, 'gas': hex(MULTICALL_GAS)}, block.tag])
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


def pool_read(ref, pool, slot0_row, liquidity_row, spacing):
    """A pool's state from its slot0 and liquidity rows, or None: no pool, out of shape, or empty. `spacing`: the
    factory's tick spacing for a v3 pool's fee as read (None unread); unused on v4."""
    if ref.dex == DEX_V4:
        slot0, liquidity = word(*slot0_row, ('uint160', 'int24', 'uint24', 'uint24')), word(*liquidity_row, ('uint128',))
        if slot0 is None or liquidity is None:
            return None
        sqrt_price, tick, protocol, lp_fee = slot0
        if protocol & 0xfff > 1000 or protocol >> 12 > 1000 or lp_fee != ref.fee:
            return None  # out of shape; a hookless key's LP fee is its own
    else:
        slot0 = word(*slot0_row, ('uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool'))
        liquidity = word(*liquidity_row, ('uint128',))
        if slot0 is None or liquidity is None or spacing != ref.tick_spacing:
            return None  # no pool, a tier the factory does not enable, or another spacing
        sqrt_price, tick, protocol, lp_fee = slot0[0], slot0[1], slot0[5], ref.fee
    liquidity, = liquidity
    if not MIN_SQRT <= sqrt_price < MAX_SQRT or not MIN_TICK <= tick <= MAX_TICK or liquidity == 0:
        return None  # not initialized, out of shape, or empty
    return PoolRead(ref, pool, sqrt_price, tick, liquidity, lp_fee, protocol)


def survey(chain, rpc, block, refs, subjects, metadata=()):
    """The pools `refs` at `block` with what qualified USD needs, in three Multicall3 rounds: each pool's state, the
    Chainlink feed (and its sequencer's) or, on a chain without Chainlink, the state of the pool that prices its
    native currency, and the tokens' metadata; the bitmap words within the band of that pool (first) and of the listed
    pools; the initialized ticks there. `subjects`: PoolRef -> the token it is read for (its partner is the
    reference). Only the first round can fail the survey: the depth rounds' failure leaves the depths unread."""
    calls = []

    def add(target, abi, *args):
        calls.append((target, abi.calldata(*args)))
        return len(calls) - 1
    # A pool of a Uniswap version the chain lacks is no pool of the chain: refused, never read at a missing contract.
    if any(ref.dex not in chain.dexes for ref in refs):
        raise DataError('v2_dex_not_on_chain')

    def slot(ref, pool):
        if ref.dex == DEX_V4:
            pool_id, state = bytes.fromhex(ref.pool_id[2:]), chain.uniswap.v4.stateView
            return (ref, None, add(state, function(V4_STATE, 'getSlot0'), pool_id),
                    add(state, function(V4_STATE, 'getLiquidity'), pool_id))
        return ref, pool, add(pool, function(V3_POOL, 'slot0')), add(pool, function(V3_POOL, 'liquidity'))
    native = native_pool_of(chain)
    if native is None:
        feed = chain.gasPrice.chainlinkEthUsd
        feed_at = add(feed.proxy, CHAINLINK_ROUND)
        uptime_at = None if feed.sequencerUptimeFeed is None else add(feed.sequencerUptimeFeed, CHAINLINK_ROUND)
    else:
        # The profile checked the pool's address or id, and its v3 tier against its own tiers.
        native_slot = slot(*native[:2])
    slots = [slot(ref, None if ref.dex == DEX_V4 else v3_pool_address(chain, ref.currency0, ref.currency1, ref.fee))
             for ref in refs]
    spacing_of = {fee: add(chain.uniswap.v3.factory, function(V3_FACTORY, 'feeAmountTickSpacing'), fee)
                  for fee in sorted({ref.fee for ref in refs if ref.dex == DEX_V3})}
    meta_at = {token: (add(token, DECIMALS), add(token, SYMBOL), add(token, NAME)) for token in metadata}
    rows = aggregate(rpc, chain, block, calls)

    spacings = {fee: (word(*rows[index], ('int24',)) or (None,))[0] for fee, index in spacing_of.items()}
    pools = []
    for ref, pool, first, second in slots:
        read = pool_read(ref, pool, rows[first], rows[second], spacings.get(ref.fee))
        if read is not None:
            pools.append(read)
    metadata_read = {token: ((word(*rows[d], ('uint8',)) or (None,))[0], raw_text(*rows[s], MAX_SYMBOL),
                             raw_text(*rows[n], MAX_NAME)) for token, (d, s, n) in meta_at.items()}
    if native is None:
        found = Survey(chain, block, pools, dict(subjects), metadata_read,
                       eth_usd(chain, rows[feed_at], None if uptime_at is None else rows[uptime_at], block), {})
    else:
        ref, pool, first, second = native_slot
        found = Survey(chain, block, pools, dict(subjects), metadata_read, (None, None, None), {},
                       native_pool=pool_read(ref, pool, rows[first], rows[second], ref.tick_spacing))
        if found.native_pool is None:
            settle_native(found, None, 'no_pool')
    found.depths = measure_depths(found, rpc)
    return found


def settle_native(found, depth, reason):
    """The native currency's price from its pool, once that pool's depth (raw stable, or None with `reason`) is known:
    the pool's spot against the stable, if it qualifies as any pool price does."""
    if depth is not None:
        usd_depth, usd = Fraction(depth, 10 ** stable_of(found.chain)[2]), native_spot(found)
        if usd_depth < FLOOR_USD:
            reason = 'pool_depth_below_floor'
        elif decimal_text(usd, PRICE_SCALE) == decimal_text(Fraction(0), PRICE_SCALE):
            reason = 'price_below_precision'
        else:
            found.native = ({'usd': decimal_text(usd, PRICE_SCALE), 'source': 'pool',
                             'snapshot': snapshot_of(found.block), 'ethUsd': None,
                             'pool': pool_wire(found.native_pool.ref),
                             'depthUsd': decimal_text(usd_depth, USD_SCALE)}, None)
            found.eth = (usd, None, None)
            return
    found.native = (None, reason)
    found.eth = (None, None, native_reasons(reason)[0])


NATIVE = 'native'  # the key of the native pool's own walk, apart from any listed pool's


def native_spot(found):
    """The native currency's USD at its pool's spot: what orders the pools against it before that pool qualifies."""
    pool, native = found.native_pool, native_pool_of(found.chain)[2]
    ratio = Fraction(pool.sqrt * pool.sqrt, 1 << 192)  # currency1 per currency0, raw
    return (ratio if pool.ref.currency0 == native else 1 / ratio) * Fraction(10 ** 18, 10 ** stable_of(found.chain)[2])


def measure_depths(found, rpc):
    """Each listed pool's depth within the band, in USD, or why not, in at most three more calls: DEPTH_WORDS of the
    pools' bitmap words, then DEPTH_TICKS of their initialized ticks. The pools are taken deepest first by their
    active liquidity across the band, an estimate that only orders them: one past either bound is left unmeasured
    (`found.skipped`), as is every pool of a round whose call fails (`found.unread`). On a chain its pool prices, that
    pool's own walk (the native currency sold for the stable) goes first and settles the native price
    (settle_native); a pool against the native currency is read with the others, ordered at that pool's spot, and
    valued only once it qualifies."""
    chain, block = found.chain, found.block
    base, references = {entry[0] for entry in base_currencies(chain)}, found.reference_prices()
    native = found.native_pool if found.native is None and found.native_pool is not None else None
    estimates = dict(references)
    if native is not None:
        spot = native_spot(found)
        estimates.update({token: (spot, decimals) for token, _, decimals in base_currencies(chain)
                          if token not in references})
    depths, ordered = {}, []
    for index, pool in enumerate(found.pools):
        partner = found.partner(pool)
        if partner not in base:
            depths[pool.ref] = (None, 'no_qualified_reference')
        elif found.eth[2] == 'sequencer_down':
            depths[pool.ref] = (None, 'sequencer_down')
        elif partner not in estimates:
            depths[pool.ref] = (None, found.reference_reason())
        else:
            zero_for_one = partner == pool.ref.currency1  # the token, currency0, sold into the pool
            usd, decimals = estimates[partner]
            active = amount_delta(pool.sqrt, band_bound(pool.sqrt, zero_for_one), pool.liquidity,
                                  1 if zero_for_one else 0, False)
            ordered.append((-Fraction(active, 10 ** decimals) * usd, index, pool, partner, zero_for_one))
    ordered.sort(key=lambda item: item[:2])
    plan = [(pool.ref, pool, partner, zero_for_one) for _, _, pool, partner, zero_for_one in ordered]
    if native is not None:
        stable = stable_of(chain)[0]
        plan.insert(0, (NATIVE, native, stable, stable == native.ref.currency1))
    out = {}  # key -> (raw partner amount, None) or (None, reason)

    def leave(key, noted, reason):
        if key != NATIVE:
            noted.add(key)
        out[key] = (None, reason)

    def read(calls, keys):
        """The round's rows, or None: its pools unread."""
        try:
            return aggregate(rpc, chain, block, calls) if calls else []
        except DataError:
            for key in keys:
                leave(key, found.unread, 'price_read_failed')
            return None

    calls, walks = [], []
    for key, pool, partner, zero_for_one in plan:
        low, high = band_ticks(pool.sqrt, pool.tick, pool.ref.tick_spacing, zero_for_one)
        positions = band_words(low, high)
        if len(calls) + len(positions) > DEPTH_WORDS:
            leave(key, found.skipped, 'pool_depth_unmeasurable')
            continue
        words = {}
        for position in positions:
            words[position] = len(calls)
            calls.append((chain.uniswap.v4.stateView,
                          V4_TICK_BITMAP.calldata(bytes.fromhex(pool.ref.pool_id[2:]), position))
                         if pool.ref.dex == DEX_V4 else (pool.address, V3_TICK_BITMAP.calldata(position)))
        walks.append((key, pool, zero_for_one, low, high, words))

    def finish():
        """The native price settled from its own walk, then every listed pool's depth valued in USD."""
        if native is not None:
            settle_native(found, *out.pop(NATIVE))
        prices, partners = found.reference_prices(), {key: partner for key, _, partner, _ in plan}
        for key, (raw, reason) in out.items():
            if raw is None:
                depths[key] = (None, reason)
            elif partners[key] in prices:
                usd, decimals = prices[partners[key]]
                depths[key] = (Fraction(raw, 10 ** decimals) * usd, None)
            else:
                depths[key] = (None, found.reference_reason())  # against the native currency, whose pool did not qualify
        return depths

    rows = read(calls, [walk[0] for walk in walks])
    if rows is None:
        return finish()
    calls, scheduled = [], []
    for key, pool, zero_for_one, low, high, words in walks:
        bitmap = {position: word(*rows[index], ('uint256',)) for position, index in words.items()}
        if any(value is None for value in bitmap.values()):
            out[key] = (None, 'pool_depth_unmeasurable')
            continue
        spacing = pool.ref.tick_spacing
        ticks = [(position * 256 + bit) * spacing for position, value in bitmap.items() for bit in range(256)
                 if value[0] >> bit & 1 and low <= position * 256 + bit <= high]
        if len(ticks) > MAX_STEPS:
            out[key] = (None, 'pool_depth_unmeasurable')
            continue
        if len(calls) + len(ticks) > DEPTH_TICKS:
            leave(key, found.skipped, 'pool_depth_unmeasurable')
            continue
        nets = {}
        for tick in ticks:
            nets[tick] = len(calls)
            calls.append((chain.uniswap.v4.stateView,
                          V4_TICK_LIQUIDITY.calldata(bytes.fromhex(pool.ref.pool_id[2:]), tick))
                         if pool.ref.dex == DEX_V4 else (pool.address, V3_TICK.calldata(tick)))
        scheduled.append((key, pool, zero_for_one, {position: value[0] for position, value in bitmap.items()}, nets))
    rows = read(calls, [item[0] for item in scheduled if item[4]])
    for key, pool, zero_for_one, bitmap, nets in scheduled:
        if rows is None and nets:
            continue  # unread; a pool with no tick to cross needs none of them
        read_nets = {tick: word(*rows[index], V4_TICK_LIQUIDITY.outputs if pool.ref.dex == DEX_V4 else V3_TICK.outputs)
                     for tick, index in nets.items()}
        try:
            if any(value is None for value in read_nets.values()):
                raise KeyError(pool.ref)
            raw = reference_depth(lambda position: bitmap[position], lambda tick: read_nets[tick][1],
                                  sqrt_price=pool.sqrt, tick=pool.tick, liquidity=pool.liquidity,
                                  spacing=pool.ref.tick_spacing, zero_for_one=zero_for_one)
        except KeyError:
            raw = None  # the walk left the words read
        out[key] = (None, 'pool_depth_unmeasurable') if raw is None else (raw, None)
    return finish()


def usd_sum(values):
    """Wire USD amounts summed, as one."""
    return decimal_text(sum((Fraction(value) for value in values), Fraction(0)), USD_SCALE)


def balance_value(entry):
    """A balance's USD at its price, rounded down to a micro-dollar; None without a balance, decimals or price."""
    if entry['balanceRaw'] is None or entry['decimals'] is None or entry['price'] is None:
        return None
    return decimal_text(Fraction(int(entry['balanceRaw'])) * Fraction(entry['price']['usd']) / 10 ** entry['decimals'],
                        USD_SCALE)


class Pricer:
    """Qualified USD per (chain, token), kept PRICES_CACHE_SECONDS: what a chain is missing is priced in one survey
    at its head. A failed read is never kept."""

    def __init__(self, sources, *, monotonic=time.monotonic):
        self.sources = sources
        self.cache = TimedCache(PRICES_CACHE_SECONDS, clock=monotonic, limit=MAX_CACHED)

    def prices(self, tokens):
        """{(chain id, token): (price, None) or (None, reason)} for [(chain id, token, decimals or None)]: decimals
        as already read, None to read them here (a base currency needs none)."""
        out, missing = {}, {}
        for chain_id, token, decimals in tokens:
            hit = self.cache.get((chain_id, token))
            if hit is not None:
                out[(chain_id, token)] = hit
            else:
                missing.setdefault(chain_id, {})[token] = decimals
        chains = sorted(missing)
        for chain_id, priced in zip(chains, each_chain(lambda chain_id: self._chain(chain_id, missing[chain_id]), chains)):
            for token, result in priced.items():
                out[(chain_id, token)] = result
                self.offer(chain_id, token, result)
        return out

    def offer(self, chain_id, token, result):
        """Keeps a price another read made (chain-pools' own survey), unless its read failed."""
        if result[1] not in ('price_read_failed', 'pricing_limit_reached'):
            self.cache.put((chain_id, token), result)

    def _chain(self, chain_id, asked):
        source = self.sources.get(chain_id)
        if source is None:
            return {token: (None, 'no_qualified_price_source') for token in asked}
        chain = source.chain
        base = {entry[0] for entry in base_currencies(chain)}
        # A pass reads its pools in one call: the feed and its sequencer's (or the native pool's two reads) and the v3
        # tiers' spacings, then each token's pools (two reads each) and, decimals unknown, its metadata (three), while
        # they fit.
        priced, refs, subjects, unknown, size = [], [], {}, [], 2 + len(v3_tiers(chain))
        for token in sorted(asked)[:MAX_PRICED]:
            own = [] if token in base else pool_candidates(chain, token)
            described = token in base or asked[token] is not None
            cost = 2 * len(own) + (0 if described else 3)
            if size + cost > SURVEY_CALLS:
                break
            size += cost
            priced.append(token)
            for ref in own:
                refs.append(ref)
                subjects[ref] = token
            if not described:
                unknown.append(token)
        try:
            with read_deadline(PRICING_BUDGET_SECONDS):
                block, rpc = source.at_head()
                found = survey(chain, rpc, block, refs, subjects, unknown)
        except DataError:
            return {token: (None, 'price_read_failed') for token in asked}
        out = {token: (None, 'pricing_limit_reached') for token in asked}
        for token in priced:
            decimals = asked[token] if asked[token] is not None else found.metadata.get(token, (None,))[0]
            out[token] = found.price(token, decimals)
        return out


# ------------------------------------------------------------------ reads
# A call's own ceiling within the read's budget: rpc_http's.
RPC_TIMEOUT_SECONDS = 12


def kept_rpc(url, body):
    """rpc_http over kept HTTPS connections (discovery.KEEPALIVE_OPENER, the V1 reader's since 3 Oct 2026): a new TLS
    handshake each call tripled Chainstack's round trip from the VM (5 Oct 2026: 360 ms against 118 ms). Chain reads
    run under a read deadline, which the pool requires; the own node's loopback hop keeps its own (rpc_http)."""
    return rpc_http(url, body, timeout=read_timeout(RPC_TIMEOUT_SECONDS), opener=KEEPALIVE_OPENER)


def each_chain(work, chain_ids):
    """[work(chain id)] for every chain at once, in `chain_ids`' order: the slowest chain sets the time, not their sum.
    Each runs in its own thread with a copy of the caller's context, so the read's deadline bounds it too; a failure is
    raised once all are done, the first chain's first, as reading them in turn would have."""
    chain_ids = list(chain_ids)
    if len(chain_ids) < 2:
        return [work(chain_id) for chain_id in chain_ids]
    results, failures = [None] * len(chain_ids), [None] * len(chain_ids)

    def run(index, context, chain_id):
        try:
            results[index] = context.run(work, chain_id)
        except BaseException as error:  # noqa: B036 - raised again in the caller's thread
            failures[index] = error
    threads = [threading.Thread(target=run, args=(index, contextvars.copy_context(), chain_id),
                                name=f'chain-read-{chain_id}', daemon=True)
               for index, chain_id in enumerate(chain_ids)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    for failure in failures:
        if failure is not None:
            raise failure
    return results


@dataclass
class ChainSource:
    """One chain's profile, its endpoints and its head follower."""
    chain: object
    endpoints: object
    follower: object

    def at_head(self):
        head = self.follower.head()
        return head.block, self.endpoints.read_rpc(anchor=head.block, max_requests=CHAIN_READ_REQUESTS)


class ChainReads:
    def __init__(self, sources, *, token_list=None, learned=None, index_tokens=None, registry=None, clock=time.time,
                 monotonic=time.monotonic):
        self.sources, self.registry = dict(sources), registry or default_registry()
        self.list_source, self.listed = token_list if token_list is not None else load_token_list()
        self.learned = learned if learned is not None else LearnedTokens()
        self.index_tokens, self.clock = index_tokens, clock
        self.pool_cache = TimedCache(POOLS_CACHE_SECONDS, clock=monotonic)
        self.balance_cache = TimedCache(BALANCES_CACHE_SECONDS, clock=monotonic)
        self.index_cache = TimedCache(INDEX_TOKENS_CACHE_SECONDS, clock=monotonic, limit=len(SEARCH_CHAINS))
        self.pricer = Pricer(self.sources, monotonic=monotonic)

    def source(self, chain_id):
        source = self.sources.get(chain_id)
        if source is None:
            raise DataError('upstream_unavailable')  # a chain this reader has no endpoints for
        return source

    def stamped(self, body, snapshot):
        now = int(self.clock())
        age = max(0, now - snapshot['timestamp'])
        return {**body, 'servedAt': now, 'freshness': {'ageSeconds': age, 'status': 'fresh' if age <= FRESH_SECONDS
                                                       else 'stale'}}

    # ---------------------------------------------------------- chain-pools
    def pools(self, chain_id, token, paired=None):
        key = (chain_id, token, paired)
        cached = self.pool_cache.get(key)
        if cached is None:
            cached = self._pools(chain_id, token, paired)
            self.pool_cache.put(key, cached)
        return self.stamped(cached, cached['snapshot'])

    def _pools(self, chain_id, token, paired):
        if chain_id not in POOL_CHAINS:
            raise DataError('upstream_unavailable')  # a balance chain's pools are read to price, never listed
        source = self.source(chain_id)
        chain = source.chain
        refs = pool_candidates(chain, token, paired)
        known = {entry[0]: entry for entry in base_currencies(chain)}
        asked = {token} | ({paired} if paired is not None else set())
        block, rpc = source.at_head()
        found = survey(chain, rpc, block, refs, {ref: token for ref in refs}, sorted(asked - set(known)))
        pools = []
        for pool in found.pools:
            ref = pool.ref
            zero_for_one, one_for_zero = swap_fees(ref.dex, pool.lp_fee, pool.protocol)
            depth, reason = found.depths[ref]
            market = ({'status': 'measured', 'reference': found.partner(pool), 'depthUsd': decimal_text(depth, USD_SCALE),
                       'reason': None} if depth is not None else
                      {'status': 'unavailable', 'reference': None, 'depthUsd': None, 'reason': reason})
            pools.append((partner_rank(chain, ref, token), -pool.liquidity, ref.dex == DEX_V3, ref.fee, {
                'pool': pool_wire(ref), 'id': ref.pool_id if ref.dex == DEX_V4 else None, 'address': pool.address,
                'sqrtPriceX96': str(pool.sqrt), 'tick': pool.tick, 'liquidity': str(pool.liquidity),
                'lpFeePips': pool.lp_fee, 'protocolFee': pool.protocol,
                'swapFeePips': {'zeroForOne': zero_for_one, 'oneForZero': one_for_zero}, 'market': market}))
        pools.sort(key=lambda item: item[:4])

        tokens = []
        for currency in sorted(asked | {c for ref in refs for c in (ref.currency0, ref.currency1)}):
            if currency in known:
                tokens.append({'address': currency, 'symbol': known[currency][1], 'decimals': known[currency][2],
                               'status': 'available'})
                continue
            decimals, symbol, name = found.metadata[currency]
            status = ('available' if decimals is not None and symbol is not None else
                      'unavailable' if decimals is None and symbol is None else 'partial')
            tokens.append({'address': currency, 'symbol': symbol, 'decimals': decimals, 'status': status})
            if currency == token and status == 'available' and pools:
                self.learned.learn(chain_id, token, symbol, name, decimals)
        # This survey prices the base currencies, and the token when it read all its pools against them (no paired
        # token); the pricer prices the rest from their own pools, as every other route does.
        others = []
        for entry in tokens:
            if entry['address'] in known or (paired is None and entry['address'] == token):
                price, reason = found.price(entry['address'], entry['decimals'])
                entry.update(price=price, priceReason=reason)
                if entry['address'] == token:
                    self.pricer.offer(chain_id, token, (price, reason))
            else:
                others.append(entry)
        priced = self.pricer.prices([(chain_id, entry['address'], entry['decimals']) for entry in others])
        for entry in others:
            entry['price'], entry['priceReason'] = priced[(chain_id, entry['address'])]
        return {'schemaVersion': 1, 'contractVersion': CONTRACT_VERSION, 'mode': 'live_chain_pools',
                'chainId': chain_id, 'token': token,
                'pairedToken': paired, 'snapshot': snapshot_of(block), 'tokens': tokens,
                'pools': [item[4] for item in pools[:MAX_CHAIN_POOLS]], 'truncated': len(pools) > MAX_CHAIN_POOLS,
                'coverage': 'standard_hookless_pools', 'limitations': list(LIVE_LIMITATIONS),
                'executionAvailable': False}

    # ------------------------------------------------------- chain-balances
    def balances(self, wallet, tokens=None):
        """[(chain id, token)] asked, on any chain chain-balances reads, or every Domino chain's base currencies (never
        a balance chain's); one Multicall3 call per chain, the chains at once."""
        asked = {}
        for chain_id, token in (tokens if tokens is not None else
                                [(chain_id, entry[0]) for chain_id in POOL_CHAINS
                                 for entry in base_currencies(self.registry.chain(chain_id))]):
            asked.setdefault(chain_id, [])
            if token not in asked[chain_id]:
                asked[chain_id].append(token)
        keys = {chain_id: (wallet, chain_id, tuple(asked[chain_id])) for chain_id in sorted(asked)}
        entries = {chain_id: self.balance_cache.get(key) for chain_id, key in keys.items()}
        unread = [chain_id for chain_id, entry in entries.items() if entry is None]
        for chain_id, entry in zip(unread, each_chain(lambda chain_id: self._balances(chain_id, wallet, asked[chain_id]),
                                                      unread)):
            if entry['status'] == 'current':
                self.balance_cache.put(keys[chain_id], entry)
            entries[chain_id] = entry
        chains = list(entries.values())
        now = int(self.clock())
        totals = [c['totalUsd'] for c in chains]
        return {'schemaVersion': 1, 'contractVersion': CONTRACT_VERSION, 'mode': 'live_chain_balances',
                'wallet': wallet, 'servedAt': now,
                'coverage': 'complete' if all(c['status'] == 'current' for c in chains) else 'partial',
                'chains': chains,
                # Chains are summed only when every one is (the owner, 2 Oct: §6.3's multi-chain rules).
                'totalUsd': None if None in totals else usd_sum(totals),
                'limitations': list(LIVE_LIMITATIONS), 'executionAvailable': False}

    def _balances(self, chain_id, wallet, tokens):
        def unread(reason, price_reason):
            return {'chainId': chain_id, 'status': 'unavailable', 'reason': reason, 'snapshot': None, 'totalUsd': None,
                    'balances': [{'address': token, 'symbol': None, 'decimals': None, 'balanceRaw': None,
                                  'status': 'unavailable', 'price': None, 'priceReason': price_reason,
                                  'valueUsd': None} for token in tokens]}
        source = self.sources.get(chain_id)
        if source is None:
            return unread('chain_not_configured', 'no_qualified_price_source')
        chain = source.chain
        known = {entry[0]: entry for entry in base_currencies(chain)}
        calls, slots = [], []
        for token in tokens:
            if token == ZERO:
                calls.append((chain.multicall3, GET_ETH_BALANCE.calldata(wallet)))
            else:
                calls.append((token, ERC20_BALANCE_OF.calldata(wallet)))
            meta = None
            if token not in known:
                meta = (len(calls), len(calls) + 1)
                calls.extend([(token, DECIMALS.calldata()), (token, SYMBOL.calldata())])
            slots.append((token, len(calls) - (1 if meta is None else 3), meta))
        try:
            block, rpc = source.at_head()
            rows = multicall(rpc, chain, block, calls)
        except DataError:
            return unread('chain_read_failed', 'price_read_failed')
        balances = []
        for token, at, meta in slots:
            balance = word(*rows[at], ('uint256',))
            if token in known:
                symbol, decimals = known[token][1], known[token][2]
            else:
                decimals = (word(*rows[meta[0]], ('uint8',)) or (None,))[0]
                symbol = raw_text(*rows[meta[1]], MAX_SYMBOL)
            balances.append({'address': token, 'symbol': symbol, 'decimals': decimals,
                             'balanceRaw': None if balance is None else str(balance[0]),
                             'status': 'unavailable' if balance is None else 'read'})
        priced = self.pricer.prices([(chain_id, entry['address'], entry['decimals']) for entry in balances])
        for entry in balances:
            entry['price'], entry['priceReason'] = priced[(chain_id, entry['address'])]
            entry['valueUsd'] = balance_value(entry)
        # A chain's total counts every balance: a read that failed, or a balance above zero without a value, leaves
        # it unknown; a zero balance needs no price.
        values = [entry['valueUsd'] for entry in balances if entry['balanceRaw'] != '0']
        return {'chainId': chain_id, 'status': 'current', 'reason': None, 'snapshot': snapshot_of(block),
                'totalUsd': None if None in values else usd_sum(values), 'balances': balances}

    # --------------------------------------------------------- chain-tokens
    def known_tokens(self, chain_id):
        """{address: [symbol, name, decimals, sources]} of every token Domino knows on a search chain."""
        known = {}

        def put(token, symbol, name, decimals, origin):
            entry = known.setdefault(token, [symbol, name, decimals, []])
            if entry[1] is None and name is not None:
                entry[1] = name
            entry[3].append(origin)
        source = self.sources.get(chain_id)
        if source is not None:
            native = source.chain.nativeSymbol
            for token, symbol, decimals in base_currencies(source.chain):
                put(token, symbol, None if token != ZERO else native, decimals, 'profile')
        for token, symbol, name, decimals in self.listed.get(chain_id, []):
            put(token, symbol, name, decimals, 'uniswap_default_list')
        for token, decimals, symbol in self._index_tokens(chain_id):
            put(token, symbol, None, decimals, 'v2_activity')
        for token, symbol, name, decimals in self.learned.tokens(chain_id):
            put(token, symbol, name, decimals, 'looked_up')
        return known

    def _index_tokens(self, chain_id):
        if self.index_tokens is None:
            return []
        cached = self.index_cache.get(chain_id)
        if cached is None:
            try:
                rows = self.index_tokens(chain_id, MAX_INDEX_TOKENS)
            except DataError:
                return []  # search still answers from the list and what was looked up
            cached = [(token, decimals, symbol) for token, decimals, symbol in rows
                      if isinstance(token, str) and re.fullmatch(r'0x[0-9a-f]{40}', token)
                      and type(decimals) is int and 0 <= decimals <= 255 and text(symbol, MAX_SYMBOL)]
            self.index_cache.put(chain_id, cached)
        return cached

    def tokens(self, chain_id, query, limit):
        """Known tokens matching `query`: an address exactly, else the symbol exactly, then by prefix, then the
        name by a word's prefix, then either anywhere; curated sources first within a rank."""
        needle = query.strip().casefold()
        matches = []
        for token, (symbol, name, decimals, origins) in self.known_tokens(chain_id).items():
            symbol_text, name_text = symbol.casefold(), (name or '').casefold()
            if re.fullmatch(r'0x[0-9a-f]{40}', needle):
                rank = 0 if token == needle else None
            elif symbol_text == needle:
                rank = 0
            elif symbol_text.startswith(needle):
                rank = 1
            elif any(part.startswith(needle) for part in re.split(r'[\s\-_./()]+', name_text) if part) \
                    or name_text.startswith(needle):
                rank = 2
            elif needle in symbol_text or needle in name_text:
                rank = 3
            else:
                rank = None
            if rank is None:
                continue
            ordered = sorted(set(origins), key=SOURCES.index)
            matches.append((rank, SOURCES.index(ordered[0]), symbol_text, token,
                            {'address': token, 'symbol': symbol, 'name': name, 'decimals': decimals,
                             'sources': ordered}))
        matches.sort(key=lambda item: item[:4])
        return {'schemaVersion': 1, 'contractVersion': CONTRACT_VERSION, 'mode': 'known_chain_tokens',
                'chainId': chain_id, 'query': query, 'servedAt': int(self.clock()), 'coverage': 'known_tokens_only',
                'tokenList': dict(self.list_source), 'tokens': [item[4] for item in matches[:limit]],
                'truncated': len(matches) > limit, 'limitations': list(LIVE_LIMITATIONS),
                'executionAvailable': False}


def build_chain_reads(*, provider_config, chain_rpc_file, learned_path, index_tokens=None, registry=None,
                      balance_chain_rpc_file=None, balance_registry=None):
    """The reader's chain reads: Robinhood through its provider file, Base and Arbitrum through the V2 chain RPC file,
    Ethereum and OP Mainnet (chain-balances only) through the balance chain RPC file. Each is optional: a chain
    without endpoints answers chain-pools with upstream_unavailable and chain-balances with `chain_not_configured`.
    A fault in the balance chain file (unreadable, malformed, a sealed URL missing) costs only those two chains: it is
    logged by its fixed code, never a path or a URL, and every other chain reads as before."""
    from v2_head import HeadFollower
    from v2_rpc import configured_endpoints, load_chain_rpc_config
    registry = registry or default_registry()
    config = load_chain_rpc_config(chain_rpc_file, registry) if chain_rpc_file else None
    sources = {}

    def source(chain, endpoints):
        follower = HeadFollower(endpoints, max_age_seconds=HEAD_MAX_AGE_SECONDS,
                                max_block_age_seconds=HEAD_MAX_BLOCK_AGE_SECONDS)
        return ChainSource(chain, endpoints, follower)
    for chain_id in POOL_CHAINS:
        chain = registry.chain(chain_id)
        if chain_id == CHAIN_ID:  # the own node's chain: its routes are the reader's provider file (v2_rpc)
            if provider_config is None:
                continue
            endpoints = configured_endpoints(chain, provider_config=provider_config, send=kept_rpc)
        else:
            if config is None or chain.key not in config.chains:
                continue
            endpoints = configured_endpoints(chain, chain_rpc_config=config, send=kept_rpc)
        sources[chain_id] = source(chain, endpoints)
    if balance_chain_rpc_file:
        try:
            balances = balance_registry or default_balance_registry()
            balance_config = load_chain_rpc_config(balance_chain_rpc_file, balances)
            built = {}
            for chain_id in BALANCE_CHAINS:
                chain = balances.chain(chain_id)
                if chain.key in balance_config.chains:
                    built[chain_id] = source(chain, configured_endpoints(chain, chain_rpc_config=balance_config,
                                                                         send=kept_rpc))
        except (OSError, ValueError) as error:
            code = str(error) if isinstance(error, DataError) else 'balance_chains_unconfigured'  # never a path
            hop_log.emit(service='read-api', mode='balance_chains_unavailable', reason=code[:96])
        else:
            sources.update(built)
    return ChainReads(sources, learned=LearnedTokens(learned_path), index_tokens=index_tokens, registry=registry)


def endpoint_urls(reads):
    """Every endpoint URL the reads use: values a response or a log line must never carry."""
    return tuple(endpoint.url for source in reads.sources.values() for endpoint in source.endpoints.endpoints)
