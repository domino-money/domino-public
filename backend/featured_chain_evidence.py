"""Chain evidence for the featured pools of Base and Arbitrum One, read at one block through the chain's V2 endpoints.

The endpoints are v2_rpc's, in the owner's order (Chainstack first, Alchemy as fallback; never a public RPC), and
hosted RPC bills every call, each of a batch counted. So, unlike Robinhood's own node, where each pool is read at its
own block (featured_evidence), a selection reads every pool at one block, the chain's head when the reads start, in
a few Multicall3 calls (v2_chain_reads.aggregate, at most 512 reads each) and one eth_getCode per token: tens of
billed calls a selection.

1. Identity and state, one round. A v3 pool must sit at its factory's CREATE2 address for the token0, token1 and
   fee it reports (v2_uniswap.v3_pool_address): a contract anywhere else is no pool of the profile's factory, so
   its answers prove nothing. A v4 pool's key is the one the profile's PositionManager recorded for its id
   (poolKeys(bytes25)), hashed again to that id (discovery.PoolKey.checked): a pool nobody ever minted a position
   in through that PositionManager stays unresolved. Each pool's slot0 and active liquidity; and the profile's
   Chainlink ETH/USD with its sequencer's uptime feed (v2_chain_reads.eth_usd) or, on a chain Chainlink does not
   serve (gasPrice.poolNativeUsd), the native currency's USD from the pool its profile names, qualified as the chain
   reads qualify it (its own walk within the band, before this round).
2. The code of each non-reference token (eth_getCode), and of an EIP-1167 clone's target: what TA-1 to TA-5 read,
   judged as featured_evidence judges it on Robinhood.
3. Those tokens' decimals and symbols, and the bitmap words the reference depth walks, one round; then the
   initialized ticks between the price and the band's bound, one round. The walk is featured_pools.reference_depth,
   with the policy's band and steps.
A round that fails fails the whole read, which the selection then calls incomplete and tries again: no pool is
judged on a read that did not come.
"""
from dataclasses import dataclass, field
from fractions import Fraction
import re

from eth_hash.auto import keccak

from discovery import ZERO, Block, DataError, PoolKey, address, decode_symbol, parse_block, prefetched
from featured_evidence import MINIMAL_PROXY, delegates
import featured_pools as rules
from v2_abi import function
from v2_chain_reads import CHAINLINK_ROUND, V3_TICK, V3_TICK_BITMAP, V4_TICK_BITMAP, V4_TICK_LIQUIDITY, aggregate, \
    eth_usd, survey, word
from v2_quotes import Abi
from v2_rpc import batched_reads
from v2_uniswap import DYNAMIC_FEE, MAX_TICK, MIN_TICK, v3_pool_address
from v4_math import MAX_SQRT, MIN_SQRT, tick_at_sqrt

V3_POOL, V4_STATE = 'IUniswapV3PoolMinimal', 'IV4StateViewMinimal'
# v4-periphery PositionManager: `mapping(bytes25 poolId => PoolKey) public poolKeys`, the key of every pool a
# position was minted in through it; bytes25 is the id's first 25 bytes.
POOL_KEYS = Abi('poolKeys(bytes25)', ('bytes25',), ('address', 'address', 'uint24', 'int24', 'address'))
DECIMALS = Abi('decimals()', (), ('uint8',))
SYMBOL = Abi('symbol()', (), ('bytes',))
V3_SLOT0 = ('uint160', 'int24', 'uint16', 'uint16', 'uint16', 'uint8', 'bool')
V4_SLOT0 = ('uint160', 'int24', 'uint24', 'uint24')
# How far behind the chain the head may be: a node far behind would be read as the chain.
HEAD_MAX_AGE_SECONDS = 120
# The depth reads one selection may make: bitmap words, then initialized ticks within the band. A pool past either
# is unmeasured, never assumed (5 Oct 2026, v2_chain_reads: Base's deepest USDC pools hold hundreds of ticks).
DEPTH_WORDS, DEPTH_TICKS = 1024, 2048
HEX = re.compile(r'0x(?:[0-9a-fA-F]{2})*')


@dataclass
class ChainEvidence:
    """What one read found at `block`: each pool's identity and state (or why not), each token's evidence, each
    pool's raw reference depth (or why not), and the native currency's USD (usd, the feed's wire entry or None,
    reason): the profile's ETH/USD, or its native pool's."""
    block: Block
    eth: tuple
    pools: dict = field(default_factory=dict)  # pool id -> {'pool', 'liquidity'} or {'error'}
    tokens: dict = field(default_factory=dict)  # token -> evidence (featured_evidence.token_evidence's shape)
    depths: dict = field(default_factory=dict)  # pool id -> (raw amount, None) or (None, reason)


def snapshot(block):
    return {'number': block.number, 'hash': block.hash, 'timestamp': block.timestamp}


def head(rpc, *, now):
    """The chain's head through the client, which then reads state only there; a head far behind is refused."""
    block = parse_block(rpc.request('eth_getBlockByNumber', ['latest', False]))
    if now - block.timestamp > HEAD_MAX_AGE_SECONDS:
        raise DataError('chain_head_stale')
    return block


def _pool_bytes(pool_id):
    return bytes.fromhex(pool_id[2:])


def add(calls, target, data):
    """One read of a Multicall3 round: its index in the round's answers."""
    calls.append((target, data))
    return len(calls) - 1


def _identity_calls(chain, pool_id, calls):
    """The round-1 reads of one pool, as indexes into the round."""
    if len(pool_id) == 42:
        return {name: add(calls, pool_id, function(V3_POOL, name).calldata())
                for name in ('token0', 'token1', 'fee', 'tickSpacing', 'slot0', 'liquidity')}
    view, raw = chain.uniswap.v4.stateView, _pool_bytes(pool_id)
    return {'key': add(calls, chain.uniswap.v4.positionManager, POOL_KEYS.calldata(raw[:25])),
            'slot0': add(calls, view, function(V4_STATE, 'getSlot0').calldata(raw)),
            'liquidity': add(calls, view, function(V4_STATE, 'getLiquidity').calldata(raw))}


def _v3_pool(chain, pool_id, rows, at):
    values = {name: word(*rows[index], function(V3_POOL, name).outputs) for name, index in at.items()}
    if any(value is None for value in values.values()):
        return {'error': 'identity_unresolved'}
    token0, token1 = address(values['token0'][0]), address(values['token1'][0])
    fee, spacing = values['fee'][0], values['tickSpacing'][0]
    # Only the factory deploys at its CREATE2 address for these immutables, so only then do they name this pool.
    if not token0 < token1 or not 0 < spacing < 16384 or v3_pool_address(chain, token0, token1, fee) != pool_id:
        return {'error': 'identity_unresolved'}
    sqrt, tick, protocol = values['slot0'][0], values['slot0'][1], values['slot0'][5]
    if not MIN_SQRT <= sqrt < MAX_SQRT or not MIN_TICK <= tick <= MAX_TICK:
        return {'error': 'identity_unresolved'}
    key = {'currency0': token0, 'currency1': token1, 'fee_pips': fee, 'tick_spacing': spacing, 'hooks': ZERO,
           'feeMode': 'fixed'}
    return {'pool': {'poolId': pool_id, 'dex': rules.DEX_V3, 'address': pool_id, 'currencies': [token0, token1],
                     'poolKey': key, 'currentLpFeePips': fee, 'protocolFeeRaw': protocol,
                     'integrationClass': 'hookless_fixed_fee', 'sqrtPriceX96': str(sqrt), 'tick': tick},
            'liquidity': values['liquidity'][0]}


def _v4_pool(pool_id, rows, at):
    key = word(*rows[at['key']], POOL_KEYS.outputs)
    slot0, liquidity = word(*rows[at['slot0']], V4_SLOT0), word(*rows[at['liquidity']], ('uint128',))
    if key is None or slot0 is None or liquidity is None:
        return {'error': 'identity_unresolved'}
    try:
        checked = PoolKey.checked(list(key), pool_id)
    except DataError:
        return {'error': 'identity_unresolved'}  # never recorded (all zero), or another pool's key
    sqrt, tick, protocol, lp_fee = slot0
    if not MIN_SQRT <= sqrt < MAX_SQRT or not MIN_TICK <= tick <= MAX_TICK:
        return {'error': 'identity_unresolved'}
    dynamic = checked.fee_pips == DYNAMIC_FEE
    pool_key = {'currency0': checked.currency0, 'currency1': checked.currency1, 'fee_pips': checked.fee_pips,
                'tick_spacing': checked.tick_spacing, 'hooks': checked.hooks, 'feeMode': 'dynamic' if dynamic else 'fixed'}
    hookless = checked.hooks == ZERO and not dynamic
    return {'pool': {'poolId': pool_id, 'dex': rules.DEX_V4, 'address': None,
                     'currencies': [checked.currency0, checked.currency1], 'poolKey': pool_key,
                     'currentLpFeePips': lp_fee, 'protocolFeeRaw': protocol,
                     'integrationClass': 'hookless_fixed_fee' if hookless else 'requires_separate_adapter',
                     'sqrtPriceX96': str(sqrt), 'tick': tick},
            'liquidity': liquidity[0]}


def _codes(rpc, accounts, block):
    """{account: runtime code bytes} at `block`, in batches the client admits; any refusal fails the read."""
    accounts = sorted(accounts)
    raw = batched_reads(rpc, [('eth_getCode', [account, block.tag]) for account in accounts]) if accounts else []
    codes = {}
    for account, value in zip(accounts, raw):
        value = prefetched(value)
        if not isinstance(value, str) or not HEX.fullmatch(value):
            raise DataError('token_code_unavailable')
        codes[account] = bytes.fromhex(value[2:])
    return codes


def token_codes(rpc, tokens, block):
    """featured_evidence.token_evidence's code facts for each token: its code and hash, and whether it can
    DELEGATECALL (an EIP-1167 clone judged by the code it runs, read in a second batch)."""
    codes = _codes(rpc, tokens, block)
    clones = {token: '0x' + match.group(1) for token, code in codes.items()
              if (match := MINIMAL_PROXY.fullmatch(code.hex()))}
    targets = _codes(rpc, set(clones.values()), block)
    found = {}
    for token, code in codes.items():
        if not code:
            found[token] = {'address': token, 'code': False}
            continue
        evidence = {'address': token, 'code': True, 'codeHash': '0x' + keccak(code).hex(), 'proxy': None,
                    'implementation': None}
        if token in clones:
            evidence['implementation'] = clones[token]
            target = targets[clones[token]]
            if not target or delegates(target):
                evidence['proxy'] = 'delegatecall'
        elif delegates(code):
            evidence['proxy'] = 'delegatecall'
        found[token] = evidence
    return found


def _symbol(ok, payload):
    """symbol() as the node reader decodes it (discovery.decode_symbol): a string, or a legacy bytes32."""
    if not ok or not payload:
        return None
    try:
        return decode_symbol('0x' + payload.hex())
    except DataError:
        return None


def band_ticks(pool, zero_for_one, band):
    """The compressed ticks between the price and the band's bound, both included: all a walk can cross."""
    sqrt, spacing = int(pool['sqrtPriceX96']), pool['poolKey']['tick_spacing']
    bound = tick_at_sqrt(rules.band_bound(sqrt, band, zero_for_one=zero_for_one)) // spacing
    return tuple(sorted((pool['tick'] // spacing, bound)))


def pools(chain, rpc, pool_ids, *, now):
    """Round 1 alone, at the head: each pool's identity and state, and the profile's ETH/USD, in one Multicall3
    call per 512 reads (the health check's read). On a chain without Chainlink, the native currency's USD is its
    profile pool's, read first and measured as the chain reads measure it (v2_chain_reads.survey of no other pool: up
    to three more calls)."""
    block = head(rpc, now=now)
    first = []
    feed = chain.native_feed
    if feed is None:
        native = survey(chain, rpc, block, (), {})
        if native.native[1] == 'price_read_failed':
            raise DataError('chain_read_failed')  # a depth round that did not come judges nothing
        eth = native.eth
    else:
        feed_at = add(first, feed.proxy, CHAINLINK_ROUND.calldata())
        uptime_at = (None if feed.sequencerUptimeFeed is None
                     else add(first, feed.sequencerUptimeFeed, CHAINLINK_ROUND.calldata()))
    slots = {pool_id: _identity_calls(chain, pool_id, first) for pool_id in sorted(set(pool_ids))}
    rows = aggregate(rpc, chain, block, first)
    if feed is not None:
        eth = eth_usd(chain, rows[feed_at], None if uptime_at is None else rows[uptime_at], block)
    found = ChainEvidence(block, eth)
    for pool_id, at in slots.items():
        found.pools[pool_id] = (_v3_pool(chain, pool_id, rows, at) if len(pool_id) == 42
                                else _v4_pool(pool_id, rows, at))
    return found


def read(chain, rpc, policy, pool_ids, *, now):
    """Everything the rules read about `pool_ids` (v3 addresses, v4 ids), at the head, through `rpc` (a v2_rpc
    ChainReadRpc that batches): a ChainEvidence. Any failed call raises: nothing is judged on a partial read."""
    found = pools(chain, rpc, pool_ids, now=now)
    block = found.block

    # The depth's side and the token each pool is judged on.
    band = Fraction(policy['referenceDepth']['bandPercent']) / 100
    walks, tokens = [], set()
    for pool_id, entry in sorted(found.pools.items()):
        if 'pool' not in entry:
            continue
        pool = entry['pool']
        side, _ = rules.reference_side(pool['currencies'], policy)
        if side is None:
            continue
        reference, other, major = side
        if not major:
            tokens.add(other)
        walks.append((pool_id, pool, entry['liquidity'], reference == pool['currencies'][1]))
    found.tokens = token_codes(rpc, tokens, block)

    second, meta, words = [], {}, {}
    for token in sorted(token for token, evidence in found.tokens.items() if evidence['code']):
        meta[token] = (add(second, token, DECIMALS.calldata()), add(second, token, SYMBOL.calldata()))
    for pool_id, pool, liquidity, zero_for_one in walks:
        low, high = band_ticks(pool, zero_for_one, band)
        positions = range(low >> 8, (high >> 8) + 2)
        if len(words) + len(positions) > DEPTH_WORDS:
            found.depths[pool_id] = (None, 'depth_read_limit')
            continue
        raw = _pool_bytes(pool_id)
        for position in positions:
            words[(pool_id, position)] = add(second, *(
                (pool_id, V3_TICK_BITMAP.calldata(position)) if pool['dex'] == rules.DEX_V3
                else (chain.uniswap.v4.stateView, V4_TICK_BITMAP.calldata(raw, position))))
    rows = aggregate(rpc, chain, block, second) if second else []
    for token, (decimals, symbol) in meta.items():
        found.tokens[token]['decimals'] = (word(*rows[decimals], DECIMALS.outputs) or (None,))[0]
        found.tokens[token]['symbol'] = _symbol(*rows[symbol])

    max_steps = policy['referenceDepth']['maxSteps']
    third, nets, ready = [], {}, []
    for pool_id, pool, liquidity, zero_for_one in walks:
        if pool_id in found.depths:
            continue
        spacing = pool['poolKey']['tick_spacing']
        low, high = band_ticks(pool, zero_for_one, band)
        bitmap = {}
        for (owner, position), index in words.items():
            if owner == pool_id:
                value = word(*rows[index], ('uint256',))
                if value is None:
                    raise DataError('chain_read_failed')
                bitmap[position] = value[0]
        ticks = [(position * 256 + bit) * spacing for position, value in bitmap.items() for bit in range(256)
                 if value >> bit & 1 and low <= position * 256 + bit <= high]
        if len(ticks) > max_steps:
            found.depths[pool_id] = (None, 'walk_exceeds_max_steps')
            continue
        if len(nets) + len(ticks) > DEPTH_TICKS:
            found.depths[pool_id] = (None, 'depth_read_limit')
            continue
        raw = _pool_bytes(pool_id)
        for tick in ticks:
            nets[(pool_id, tick)] = add(third, *(
                (pool_id, V3_TICK.calldata(tick)) if pool['dex'] == rules.DEX_V3
                else (chain.uniswap.v4.stateView, V4_TICK_LIQUIDITY.calldata(raw, tick))))
        ready.append((pool_id, pool, liquidity, zero_for_one, bitmap))
    rows = aggregate(rpc, chain, block, third) if third else []
    for pool_id, pool, liquidity, zero_for_one, bitmap in ready:
        read_nets = {}
        for (owner, tick), index in nets.items():
            if owner == pool_id:
                value = word(*rows[index], V3_TICK.outputs if pool['dex'] == rules.DEX_V3 else V4_TICK_LIQUIDITY.outputs)
                if value is None:
                    raise DataError('chain_read_failed')
                read_nets[tick] = value[1]
        try:
            amount = rules.reference_depth(
                lambda position: bitmap[position], lambda tick: read_nets[tick], sqrt_price=int(pool['sqrtPriceX96']),
                tick=pool['tick'], liquidity=liquidity, tick_spacing=pool['poolKey']['tick_spacing'],
                reference_is_currency1=zero_for_one, band=band, max_steps=max_steps)
        except KeyError:
            found.depths[pool_id] = (None, 'walk_left_the_band_read')  # unmeasured, never assumed
            continue
        found.depths[pool_id] = (amount, None) if amount is not None else (None, 'walk_exceeds_max_steps')
    return found
