"""When a v3 pool's own TWAP can anchor a V2 vault, and when the publisher signs the price instead.

The price anchor takes either a v3 TWAP (twapSqrtPrice, Uniswap's observe([W, 0])) or a publisher's signed
observation, for any pool (DominoPriceAnchor.anchor; the auto-exit module passes either through). A v3 compound
or MINT reads the vault's window (min(twapSeconds, the vault's maxObservationAgeSeconds), 300 s in production), an
exit at least the module's minTwapSeconds (600 s).

What the pool keeps (UniswapV3Pool, Oracle):
- a ring of `observationCardinality` observations, written only by a swap that moved the tick or by a mint or burn
  of liquidity in range, and at most one per block timestamp (Oracle.write returns early when the newest
  observation already has this block's timestamp);
- observe([W, 0]) reverts with OLD unless the oldest stored observation is at or before now - W; in a full ring of
  N slots that is the N-th newest write.

Uniswap creates every pool with one slot. With one slot, any write in the last W seconds (a pool that trades) makes
the window unreadable, and a vault anchored on it could never act. Paying for more slots (increaseObservation-
CardinalityNext, about 22,400 gas a slot) would have cost each new pool US$0.11 to US$0.75 on 5 Oct 2026; the
owner decided that day that the cost would grow with Domino's users and chose the signed price instead
(reports/V3_ORACLE_CARDINALITY_2026-10-05.md).

So the TWAP anchors only when the pool's ring guarantees the window until the plan is included, and the publisher
signs the spot otherwise, as on v4 (v2_observation: held within its band over the look-back, valid at most the
consumer's maximum age). The window is guaranteed once it is covered and the ring holds at least one more slot
than the writes W seconds can hold: then no number of writes can push the observation at or before now - W out
of the ring. On a Nitro chain (Robinhood, Arbitrum One) every block of a second shares its timestamp, so at most
one write a second: W + 1 slots. On Base one block, so one write, every 2 s: W / 2 + 1. Real pools reach both
bounds (5 Oct 2026: 300 writes in 300 s on Robinhood, 150 on Base). A covered window in a smaller ring is not
used: the next write can push it out before inclusion, and the execution would revert.
"""
from eth_hash.auto import keccak

from discovery import DataError
from v2_abi import Function, function
from v2_uniswap import v3_pool_address
from v2_vaults import calls

V3_POOL = 'IUniswapV3PoolMinimal'
MAX_CARDINALITY = 65535
# UniswapV3Pool.observations(uint256), which the frozen minimal interface (F0) does not export.
OBSERVATIONS = Function('UniswapV3Pool', 'observations', 'observations(uint256)',
                        '0x' + keccak(b'observations(uint256)')[:4].hex(), ('uint256',),
                        ('uint32', 'int56', 'uint160', 'bool'), True)


def timestamp_spacing(chain):
    """The least time between two block timestamps: one second on Nitro whatever its block time (several blocks
    share each second), the block time on the OP Stack (2 s on Base)."""
    if chain.stack == 'arbitrum-nitro':
        return 1
    return max(1, int(chain.block_time))


def cardinality_for(chain, window):
    """The ring that always holds a `window`-second history: a slot for every write the window can hold, and one for
    the observation at or before its start."""
    if type(window) is not int or window <= 0:
        raise DataError('v2_twap_window_unavailable')
    return min(MAX_CARDINALITY, -(-window // timestamp_spacing(chain)) + 1)


def twap_guaranteed(rpc, chain, pool, window, block):
    """observe([window, 0]) on a v3 pool (a PoolRef) holds at `block` and at any later block: the active ring has
    cardinality_for(window) slots and already reaches back over the window. slot0 is read first; the oldest
    observation (where observe looks for it: the slot after the newest, or slot 0 while the ring fills) only for a
    ring that size."""
    target = v3_pool_address(chain, pool.currency0, pool.currency1, pool.fee)
    slot0, = calls(rpc, block, [(target, function(V3_POOL, 'slot0'), ())])
    index, cardinality = slot0[2], slot0[3]
    if index >= cardinality:  # an index inside the ring: one slot at least
        raise DataError('v2_oracle_state_invalid')
    if cardinality < cardinality_for(chain, window):
        return False
    after, first = calls(rpc, block, [(target, OBSERVATIONS, ((index + 1) % cardinality,)),
                                      (target, OBSERVATIONS, (0,))])
    oldest = after if after[3] else first
    if not oldest[3] or oldest[0] > block.timestamp:
        raise DataError('v2_oracle_state_invalid')
    return block.timestamp - window >= oldest[0]
