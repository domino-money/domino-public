"""Chain evidence for the featured-pools selection, read at the verified block.

Only calls the read allowlist already admits (`ReadRpc.METHODS`): eth_call to
the StateView and to the token, eth_getCode and block headers. Upgradeability
therefore comes from the token's own code - a DELEGATECALL outside PUSH data
and the compiler's metadata - not from proxy storage slots, which
eth_getStorageAt would read and the allowlist does not admit. That also covers
beacon and custom proxies, which slot checks miss.
"""
from fractions import Fraction
import re

from eth_hash.auto import keccak

from discovery import STATE_VIEW, DataError, address, bytes32, parse_block
import featured_pools as rules
from v4_math import MAX_SQRT, MIN_SQRT

# EIP-1167: a clone delegates every call to one fixed implementation.
MINIMAL_PROXY = re.compile(r'363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3')
DELEGATECALL = 0xf4
HEX = re.compile(r'0x(?:[0-9a-fA-F]{2})*')


def _pool_bytes(pool_id):
    return bytes.fromhex(bytes32(pool_id)[2:])


def pin_block(rpc, block):
    """Read `block`'s header through `rpc`, and require the one the market read verified.

    The production RPC (rpc_failover.FailoverReadRpc) reads state only at a block
    that same instance has observed: the evidence of a pool is read at the block
    of its verified market read, so that header comes first, from this RPC.
    """
    observed = parse_block(rpc.request('eth_getBlockByNumber', [block.tag, False]))
    if (observed.number, observed.hash) != (block.number, block.hash):
        raise DataError('snapshot_reorganized')
    return observed


def active_liquidity(rpc, pool_id, block):
    return rpc.call(STATE_VIEW, 'getLiquidity(bytes32)', ['bytes32'], [_pool_bytes(pool_id)], ['uint128'],
                    block=block.tag)[0]


def depth(rpc, pool, block, policy, *, liquidity, reference_is_currency1):
    """(raw reference amount or None, reads spent) for the pool at `block`."""
    pool_id, key = pool['poolId'], pool['poolKey']
    target, words, nets = _pool_bytes(pool_id), {}, {}

    def bitmap(word):
        if word not in words:
            if not -2**15 <= word < 2**15:
                raise DataError('invalid_tick_word')
            words[word] = rpc.call(STATE_VIEW, 'getTickBitmap(bytes32,int16)', ['bytes32', 'int16'],
                                   [target, word], ['uint256'], block=block.tag)[0]
        return words[word]

    def tick_net(tick):
        if tick not in nets:
            nets[tick] = rpc.call(STATE_VIEW, 'getTickLiquidity(bytes32,int24)', ['bytes32', 'int24'],
                                  [target, tick], ['uint128', 'int128'], block=block.tag)[1]
        return nets[tick]

    amount = rules.reference_depth(
        bitmap, tick_net, sqrt_price=int(pool['sqrtPriceX96']), tick=pool['tick'], liquidity=liquidity,
        tick_spacing=key['tick_spacing'], reference_is_currency1=reference_is_currency1,
        band=Fraction(policy['referenceDepth']['bandPercent']) / 100,
        max_steps=policy['referenceDepth']['maxSteps'])
    return amount, len(words) + len(nets)


def eth_price(rpc, policy, block):
    """USDG per ETH from the policy's ETH/USDG pool at `block`; None when it cannot say."""
    pool_id = policy['ethUsdPricePool']
    sqrt = rpc.call(STATE_VIEW, 'getSlot0(bytes32)', ['bytes32'], [_pool_bytes(pool_id)],
                    ['uint160', 'int24', 'uint24', 'uint24'], block=block.tag)[0]
    if not MIN_SQRT <= sqrt < MAX_SQRT or active_liquidity(rpc, pool_id, block) <= 0:
        return None
    return rules.eth_usd(sqrt)


def strip_metadata(code):
    """Runtime code without the compiler's trailing CBOR metadata, when present."""
    if len(code) >= 2:
        size = int.from_bytes(code[-2:], 'big')
        if 0 < size <= len(code) - 2 and 0xa1 <= code[-2 - size] <= 0xa5:
            return code[:-2 - size]
    return code


def delegates(code):
    """True when the code can DELEGATECALL: the opcode outside PUSH data and metadata."""
    code, index = strip_metadata(code), 0
    while index < len(code):
        op = code[index]
        if op == DELEGATECALL:
            return True
        index += 1 + (op - 0x5f if 0x60 <= op <= 0x7f else 0)
    return False


def _code(rpc, account, block):
    raw = rpc.request('eth_getCode', [account, block.tag])
    if not isinstance(raw, str) or not HEX.fullmatch(raw):
        raise DataError('token_code_unavailable')
    return bytes.fromhex(raw[2:])


def code_hash(rpc, account, block):
    """keccak of the account's code at `block`, or None when it has none."""
    code = _code(rpc, address(account), block)
    return '0x' + keccak(code).hex() if code else None


def token_evidence(rpc, token, block):
    """What TA-1..TA-5 read: code, its hash, whether it delegates, decimals and symbol.

    Unreadable metadata stays None (the rules refuse it); a missing or
    malformed code answer raises, since the node, not the token, failed.
    """
    token = address(token)
    code = _code(rpc, token, block)
    if not code:
        return {'address': token, 'code': False}
    evidence = {'address': token, 'code': True, 'codeHash': '0x' + keccak(code).hex(),
                'proxy': None, 'implementation': None}
    clone = MINIMAL_PROXY.fullmatch(code.hex())
    if clone:
        implementation = '0x' + clone.group(1)
        target = _code(rpc, implementation, block)
        evidence['implementation'] = implementation
        # A clone cannot change its target; the target itself may delegate.
        if not target or delegates(target):
            evidence['proxy'] = 'delegatecall'
    elif delegates(code):
        evidence['proxy'] = 'delegatecall'
    try:
        evidence['decimals'] = rpc.call(token, 'decimals()', outputs=['uint8'], block=block.tag)[0]
    except DataError:
        evidence['decimals'] = None
    try:
        evidence['symbol'] = rpc.symbol(token, block=block.tag)
    except DataError:
        evidence['symbol'] = None
    return evidence


def block_timestamp(rpc, number):
    return parse_block(rpc.request('eth_getBlockByNumber', [hex(number), False])).timestamp
