"""read-v6's live chain reads (app spec F7 §6.2; 0xdecimal's items 1-3 of 5 Oct 2026): the pools of a token on a
chain, a wallet's balances on each chain, and token search on Base and Arbitrum One.

Unlike portfolio and activity, these read the chains when asked, so the app lists pools and balances without
moving the wallet to another network (it still does, to sign: §1.3).

- Robinhood reads Domino's own node through the reader's provider file; Base and Arbitrum read the V2 chain RPC
  file's hosted endpoints (F6, v2_rpc), billed per call. Each answer is one Multicall3 call per chain at the
  chain's head (v2_head), and answers are cached for a few seconds, so a busy page costs little more than a quiet one.
- chain-pools reads the pools the app reads today through the wallet: the token against the chain's base
  currencies (its charge currencies: the stable, the native currency and its wrapped token) or one paired token,
  in Uniswap's standard hookless v4 keys and the v3 fee tiers the profile and the factory enable (Base adds 200,
  300 and 400). A v3 pool's address is the factory's CREATE2 address, so its state is read in the same call. A
  pool is listed once it exists, is priced and holds liquidity, partners ETH and WETH first, then the stable,
  then by active liquidity.
- chain-balances reads native and ERC-20 balances, by default each chain's base currencies.
- chain-tokens searches the tokens Domino knows on Base and Arbitrum (the owner's decision of 5 Oct 2026): the
  chain profile's, the Uniswap Labs Default token list's (backend/data/token-lists, GPL-3.0, pinned), those the
  V2 index read, and those a chain-pools read found priced pools for, as Robinhood's catalogue learns from
  visitors. Like read-v3's search it covers known tokens only.

Symbols and names are untrusted text: they come back as read, printable and bounded, never as a claim of identity
(a token is its chain and address). No USD here: a pool's market metrics are null with their reason until a
qualified price source exists (§6.3).
"""
from collections import OrderedDict
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
import tempfile
import threading
import time

from eth_abi import decode

from discovery import ZERO, DataError, address
from v2_abi import function
from v2_chains import DEX_V3, DEX_V4, default_registry
from v2_quotes import ERC20_BALANCE_OF, GET_ETH_BALANCE, V4_STANDARD_KEYS, Abi, multicall
from v2_read_contract import CONTRACT_VERSION, LIVE_LIMITATIONS, MAX_CHAIN_POOLS
from v2_uniswap import PIPS, PoolRef, v3_pool_address
from v4_math import MAX_SQRT, MIN_SQRT

POOL_CHAINS = (4663, 8453, 42161)
SEARCH_CHAINS = (8453, 42161)
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
    tiers = {int(fee): spacing for fee, spacing in chain.uniswap.v3.tickSpacingByFee.items()}
    return {**tiers, **EXTRA_V3_TIERS.get(chain.chainId, {})}


def pool_candidates(chain, token, paired=None):
    """The pools to read for `token`, as the app reads them through the wallet: v4's standard hookless keys with
    each partner, native ETH as itself; then v3's tiers, ETH becoming WETH, none for native ETH itself. A pair of
    the same token, or of ETH and WETH, is no pool."""
    wrapped = chain.wrappedNative.address
    partners = [paired] if paired is not None else [entry[0] for entry in base_currencies(chain)]
    partners = [p for p in partners if p != token and {p, token} != {ZERO, wrapped}]
    refs = []
    for partner in partners:
        low, high = sorted((token, partner))
        refs.extend(PoolRef(DEX_V4, low, high, fee, spacing) for fee, spacing in V4_STANDARD_KEYS)
    if token != ZERO:
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


# ------------------------------------------------------------------ reads
@dataclass
class ChainSource:
    """One chain's profile, its endpoints and its head follower."""
    chain: object
    endpoints: object
    follower: object

    def at_head(self):
        head = self.follower.head()
        return head.block, self.endpoints.read_rpc(anchor=head.block, max_requests=8)


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
        source = self.source(chain_id)
        chain = source.chain
        refs = pool_candidates(chain, token, paired)
        state, factory = chain.uniswap.v4.stateView, chain.uniswap.v3.factory
        calls, slots = [], []

        def add(target, abi, *args):
            calls.append((target, abi.calldata(*args)))
            return len(calls) - 1
        for ref in refs:
            if ref.dex == DEX_V4:
                pool_id = bytes.fromhex(ref.pool_id[2:])
                slots.append((ref, None, add(state, function(V4_STATE, 'getSlot0'), pool_id),
                              add(state, function(V4_STATE, 'getLiquidity'), pool_id)))
            else:
                pool = v3_pool_address(chain, ref.currency0, ref.currency1, ref.fee)
                slots.append((ref, pool, add(pool, function(V3_POOL, 'slot0')), add(pool, function(V3_POOL, 'liquidity'))))
        spacing_of = {fee: add(factory, function(V3_FACTORY, 'feeAmountTickSpacing'), fee)
                      for fee in sorted({ref.fee for ref in refs if ref.dex == DEX_V3})}
        known = {entry[0]: entry for entry in base_currencies(chain)}
        metadata = {}
        asked = {token} | ({paired} if paired is not None else set())
        for currency in sorted(asked - set(known)):
            metadata[currency] = (add(currency, DECIMALS), add(currency, SYMBOL), add(currency, NAME))
        block, rpc = source.at_head()
        rows = multicall(rpc, chain, block, calls) if calls else []

        spacings = {fee: (word(*rows[index], ('int24',)) or (None,))[0] for fee, index in spacing_of.items()}
        pools = []
        for ref, pool, first, second in slots:
            if ref.dex == DEX_V4:
                slot0, liquidity = word(*rows[first], ('uint160', 'int24', 'uint24', 'uint24')), word(*rows[second], ('uint128',))
                if slot0 is None or liquidity is None:
                    continue
                sqrt_price, tick, protocol, lp_fee = slot0
                if protocol & 0xfff > 1000 or protocol >> 12 > 1000 or lp_fee != ref.fee:
                    continue  # out of shape; a hookless key's LP fee is its own
            else:
                slot0 = word(*rows[first], ('uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool'))
                liquidity = word(*rows[second], ('uint128',))
                if slot0 is None or liquidity is None or spacings.get(ref.fee) != ref.tick_spacing:
                    continue  # no pool, a tier the factory does not enable, or another spacing
                sqrt_price, tick, protocol, lp_fee = slot0[0], slot0[1], slot0[5], ref.fee
            liquidity, = liquidity
            if not MIN_SQRT <= sqrt_price < MAX_SQRT or not MIN_TICK <= tick <= MAX_TICK or liquidity == 0:
                continue  # not initialized, out of shape, or empty
            zero_for_one, one_for_zero = swap_fees(ref.dex, lp_fee, protocol)
            pools.append((partner_rank(chain, ref, token), -liquidity, ref.dex == DEX_V3, ref.fee, {
                'pool': {'dex': ref.dex, 'currency0': ref.currency0, 'currency1': ref.currency1, 'fee': ref.fee,
                         'tickSpacing': ref.tick_spacing, 'hooks': ref.hooks},
                'id': ref.pool_id if ref.dex == DEX_V4 else None, 'address': pool,
                'sqrtPriceX96': str(sqrt_price), 'tick': tick, 'liquidity': str(liquidity), 'lpFeePips': lp_fee,
                'protocolFee': protocol, 'swapFeePips': {'zeroForOne': zero_for_one, 'oneForZero': one_for_zero},
                'market': {'status': 'unavailable', 'reason': 'no_qualified_price_source'}}))
        pools.sort(key=lambda item: item[:4])

        tokens = []
        for currency in sorted(asked | {c for ref in refs for c in (ref.currency0, ref.currency1)}):
            if currency in known:
                tokens.append({'address': currency, 'symbol': known[currency][1], 'decimals': known[currency][2],
                               'status': 'available'})
                continue
            decimals_at, symbol_at, name_at = metadata[currency]
            decimals = (word(*rows[decimals_at], ('uint8',)) or (None,))[0]
            symbol = raw_text(*rows[symbol_at], MAX_SYMBOL)
            status = ('available' if decimals is not None and symbol is not None else
                      'unavailable' if decimals is None and symbol is None else 'partial')
            tokens.append({'address': currency, 'symbol': symbol, 'decimals': decimals, 'status': status})
            if currency == token and status == 'available' and pools:
                self.learned.learn(chain_id, token, symbol, raw_text(*rows[name_at], MAX_NAME), decimals)
        snapshot = {'number': block.number, 'hash': block.hash, 'timestamp': block.timestamp}
        return {'schemaVersion': 1, 'contractVersion': CONTRACT_VERSION, 'mode': 'live_chain_pools',
                'chainId': chain_id, 'token': token,
                'pairedToken': paired, 'snapshot': snapshot, 'tokens': tokens,
                'pools': [item[4] for item in pools[:MAX_CHAIN_POOLS]], 'truncated': len(pools) > MAX_CHAIN_POOLS,
                'coverage': 'standard_hookless_pools', 'limitations': list(LIVE_LIMITATIONS),
                'executionAvailable': False}

    # ------------------------------------------------------- chain-balances
    def balances(self, wallet, tokens=None):
        """{chain id: [token]} asked, or every chain's base currencies; one Multicall3 call per chain."""
        asked = {}
        for chain_id, token in (tokens if tokens is not None else
                                [(chain_id, entry[0]) for chain_id in POOL_CHAINS
                                 for entry in base_currencies(self.registry.chain(chain_id))]):
            asked.setdefault(chain_id, [])
            if token not in asked[chain_id]:
                asked[chain_id].append(token)
        chains = []
        for chain_id in sorted(asked):
            key = (wallet, chain_id, tuple(asked[chain_id]))
            entry = self.balance_cache.get(key)
            if entry is None:
                entry = self._balances(chain_id, wallet, asked[chain_id])
                if entry['status'] == 'current':
                    self.balance_cache.put(key, entry)
            chains.append(entry)
        now = int(self.clock())
        return {'schemaVersion': 1, 'contractVersion': CONTRACT_VERSION, 'mode': 'live_chain_balances',
                'wallet': wallet, 'servedAt': now,
                'coverage': 'complete' if all(c['status'] == 'current' for c in chains) else 'partial',
                'chains': chains, 'limitations': list(LIVE_LIMITATIONS), 'executionAvailable': False}

    def _balances(self, chain_id, wallet, tokens):
        unread = {'chainId': chain_id, 'status': 'unavailable', 'snapshot': None,
                  'balances': [{'address': token, 'symbol': None, 'decimals': None, 'balanceRaw': None,
                                'status': 'unavailable'} for token in tokens]}
        source = self.sources.get(chain_id)
        if source is None:
            return {**unread, 'reason': 'chain_not_configured'}
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
            return {**unread, 'reason': 'chain_read_failed'}
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
        return {'chainId': chain_id, 'status': 'current', 'reason': None,
                'snapshot': {'number': block.number, 'hash': block.hash, 'timestamp': block.timestamp},
                'balances': balances}

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


def build_chain_reads(*, provider_config, chain_rpc_file, learned_path, index_tokens=None, registry=None):
    """The reader's chain reads: Robinhood through its provider file, Base and Arbitrum through the V2 chain RPC file
    (both optional: a chain without endpoints answers chain-pools with upstream_unavailable and chain-balances with
    `chain_not_configured`)."""
    from v2_head import HeadFollower
    from v2_rpc import configured_endpoints, load_chain_rpc_config
    registry = registry or default_registry()
    config = load_chain_rpc_config(chain_rpc_file, registry) if chain_rpc_file else None
    sources = {}
    for chain_id in POOL_CHAINS:
        chain = registry.chain(chain_id)
        if chain_id == 4663:
            if provider_config is None:
                continue
            endpoints = configured_endpoints(chain, provider_config=provider_config)
        else:
            if config is None or chain.key not in config.chains:
                continue
            endpoints = configured_endpoints(chain, chain_rpc_config=config)
        follower = HeadFollower(endpoints, max_age_seconds=HEAD_MAX_AGE_SECONDS,
                                max_block_age_seconds=HEAD_MAX_BLOCK_AGE_SECONDS)
        sources[chain_id] = ChainSource(chain, endpoints, follower)
    return ChainReads(sources, learned=LearnedTokens(learned_path), index_tokens=index_tokens, registry=registry)


def endpoint_urls(reads):
    """Every endpoint URL the reads use: values a response or a log line must never carry."""
    return tuple(endpoint.url for source in reads.sources.values() for endpoint in source.endpoints.endpoints)
