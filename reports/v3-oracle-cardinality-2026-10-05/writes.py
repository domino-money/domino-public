"""Uniswap v3 oracle writes reconstructed from a pool's logs.

UniswapV3Pool writes an observation:
- in swap(), only when the tick moved (state.tick != slot0Start.tick); the Swap
  event carries the tick after the swap, so a write is a Swap whose tick differs
  from the tick before it;
- in _modifyPosition(), when liquidityDelta != 0 and the current tick is inside
  [tickLower, tickUpper): a Mint (amount > 0 always), or a Burn with amount > 0;
- Oracle.write returns early when the newest observation has this block's
  timestamp: at most one write per distinct block.timestamp (one per second on
  Nitro chains, where several blocks share a timestamp; one per 2 s block on Base).

observe([W, 0]) succeeds iff the oldest stored observation is at or before
now - W. With a full ring of N slots the oldest is the N-th newest write, so a
window W is always available iff N >= 1 + (writes in (t - W, t]) for every t.
"""
from bisect import bisect_right

from eth_abi import decode

from chainlib import BURN, MINT, SWAP


def _int24(topic_hex):
    value = int(topic_hex, 16) & ((1 << 24) - 1)
    return value - (1 << 24) if value >= 1 << 23 else value


def fetch_logs(rpc, pool, start, end, step):
    out = []
    for a in range(start, end + 1, step):
        b = min(end, a + step - 1)
        out.extend(rpc.request('eth_getLogs', [{'address': pool, 'fromBlock': hex(a), 'toBlock': hex(b),
                                                'topics': [[SWAP, MINT, BURN]]}]))
    out.sort(key=lambda l: (int(l['blockNumber'], 16), int(l['logIndex'], 16)))
    return out


def reconstruct(logs, tick_before=None):
    """(write timestamps (distinct, sorted), swap block numbers with their timestamps, counts)."""
    tick = tick_before
    writes, swap_blocks = set(), {}
    counts = {'swaps': 0, 'tickMoves': 0, 'mintsInRange': 0, 'burnsInRange': 0, 'mints': 0, 'burns': 0}
    for log in logs:
        ts = int(log['blockTimestamp'], 16)
        number = int(log['blockNumber'], 16)
        kind = log['topics'][0]
        if kind == SWAP:
            counts['swaps'] += 1
            swap_blocks[number] = ts
            new_tick = decode(['int256', 'int256', 'uint160', 'uint128', 'int24'], bytes.fromhex(log['data'][2:]))[4]
            if tick is None or new_tick != tick:  # unknown first tick: counted as a write (conservative)
                counts['tickMoves'] += 1
                writes.add(ts)
            tick = new_tick
        elif kind == MINT:
            counts['mints'] += 1
            lower, upper = _int24(log['topics'][2]), _int24(log['topics'][3])
            if tick is None or lower <= tick < upper:
                counts['mintsInRange'] += 1
                writes.add(ts)
        elif kind == BURN:
            counts['burns'] += 1
            lower, upper = _int24(log['topics'][2]), _int24(log['topics'][3])
            amount = decode(['uint128', 'uint256', 'uint256'], bytes.fromhex(log['data'][2:]))[0]
            if amount > 0 and (tick is None or lower <= tick < upper):
                counts['burnsInRange'] += 1
                writes.add(ts)
    return sorted(writes), swap_blocks, counts


def window_counts(times, window, start, end):
    """For every second t in [start, end]: how many of `times` lie in (t - window, t]."""
    out = []
    for t in range(start, end + 1):
        out.append(bisect_right(times, t) - bisect_right(times, t - window))
    return out


def percentile(sorted_values, q):
    if not sorted_values:
        return 0
    k = min(len(sorted_values) - 1, max(0, int(round(q * (len(sorted_values) - 1)))))
    return sorted_values[k]


def summary(times, window, start, end):
    counts = window_counts(times, window, start, end)
    s = sorted(counts)
    return {'max': s[-1] if s else 0, 'p99': percentile(s, 0.99), 'p95': percentile(s, 0.95),
            'p50': percentile(s, 0.50), 'zeroShare': round(sum(1 for c in counts if c == 0) / max(1, len(counts)), 4)}


def needed(max_writes):
    return max_writes + 1
