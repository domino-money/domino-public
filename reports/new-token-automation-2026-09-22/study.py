#!/usr/bin/env python3
"""New-token automation study: short-horizon price moves, manipulation economics
and balancing-swap needs of real Uniswap v4 pools on Robinhood Chain.

Everything comes from the PoolManager's own events and the StateView, read from
the project node on clawber through a loopback URL (an SSH tunnel to the node's
RPC port); no token or provider credential is used. Read-only: no transaction.

Run: backend/.venv/bin/python reports/new-token-automation-2026-09-22/study.py \
       --rpc http://127.0.0.1:18547 --hours 24 --output <new file>.json
"""
import argparse
import bisect
from datetime import datetime, timezone
import json
import math
import urllib.request

from eth_abi import decode, encode
from eth_hash.auto import keccak

POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
STATE_VIEW = '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b'
SWAP = '0x' + keccak(b'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)').hex()
INITIALIZE = '0x' + keccak(b'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)').hex()
ETH, WETH, USDG = '0x' + '00' * 20, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
DYNAMIC_FEE_FLAG = 0x800000
# Pool ids and creation times as GeckoTerminal listed them on 22 Sep 2026; the
# key, fee and hooks are then read from the pool's own Initialize event.
POOLS = [
    ('PKRT/WETH', '0xf8a1468fca4504e3f1f62c324afd9cf41345e7d3e7a1a7cd11a3e86236f7cea8', '2026-09-22T07:14:58Z'),
    ('PGREM/WETH', '0xa0412d8ef17f67323b9fc1c85838d5172925ab328ceb84c9e62f4293af41d28e', '2026-09-22T09:25:56Z'),
    ('STPASS/WETH', '0x64aa367edfb0e7e91f869c616c06d39cf9643f8180a260834add64b629130f96', '2026-09-22T01:43:58Z'),
    ('EARLY/WETH', '0x11567d4c061846382f6149aec46c246113f7cad3a32bb8510f0f24c570474b33', '2026-09-21T21:09:00Z'),
    ('AD/ETH', '0x2a4e49b6f4026be2d9c4cc273f389d986256e27b18950a8967d1daa095b27978', '2026-09-17T17:07:49Z'),
    ('HOODCATS/ETH', '0xc19d1d77bfdaeb66c285a17286d325062c1cd0c7ce88c1fe60ef70797ee8f215', '2026-09-19T03:23:52Z'),
    ('AI/USDG', '0x7aebd80541bfaaf23dbb6e99ce13d4d31c1a84c91414f971eadbff7db5f85995', '2026-09-03T14:04:34Z'),
    ('META/USDG', '0x5875d407a42965b0e768c8925cea290e06fa50603ef34fc99eb92a1050e6ae36', '2026-07-11T12:18:48Z'),
    ('WETH/USDG', '0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551', '2026-08-20T07:58:27Z'),
]
QUOTES = {WETH: 18, ETH: 18, USDG: 6}
# Horizons from the observed block to the block a transaction lands in, in blocks
# (the chain runs about ten blocks a second), and the bands they are judged against.
HORIZONS = {'0.5 s': 5, '1 s': 10, '2 s': 20, '5 s': 50, '10 s': 100, '30 s': 300}
IMPACT_BANDS = (0.01, 0.02, 0.05, 0.10)
GUARD_LOW, GUARD_HIGH = 0.995 ** 2, 1.005 ** 2   # 50 bps on the square root, as a price ratio
SLIPPAGE = 0.01                                   # agreed with the owner on 22 Sep 2026
OWN_IMPACT = 0.0005                               # a fee-sized swap's own average impact, conservative
POSITION_SHARE = 0.01                             # a position holding 1 % of the active liquidity
INTERVALS = {'5 min': 300, '30 min': 1800, '60 min': 3600}


class Node:
    def __init__(self, url):
        self.url, self.calls = url, 0

    def __call__(self, method, params):
        self.calls += 1
        request = urllib.request.Request(self.url, json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode(),
                                         {'content-type': 'application/json'})
        reply = json.load(urllib.request.urlopen(request, timeout=120))
        if 'error' in reply:
            raise RuntimeError(reply['error'])
        return reply['result']


def header(rpc, number):
    raw = rpc('eth_getBlockByNumber', [hex(number), False])
    return {'number': int(raw['number'], 16), 'hash': raw['hash'], 'timestamp': int(raw['timestamp'], 16)}


def block_at(rpc, ts, low, high):
    while low < high:
        mid = (low + high) // 2
        if header(rpc, mid)['timestamp'] < ts:
            low = mid + 1
        else:
            high = mid
    return low


def logs(rpc, topics, start, end, step=50_000):
    out, cursor = [], start
    while cursor <= end:
        stop = min(end, cursor + step - 1)
        try:
            out += rpc('eth_getLogs', [{'address': POOL_MANAGER, 'topics': topics, 'fromBlock': hex(cursor), 'toBlock': hex(stop)}])
        except RuntimeError:
            if step <= 500:
                raise
            step //= 4
            continue
        cursor = stop + 1
    return out


def pool_key(rpc, pool_id, created, head):
    ts = int(datetime.fromisoformat(created.replace('Z', '+00:00')).timestamp())
    for margin in (7200, 43200, 172800):
        low = block_at(rpc, ts - margin, 0, head['number'])
        high = block_at(rpc, ts + margin, low, head['number'])
        found = logs(rpc, [INITIALIZE, pool_id], low, high)
        if len(found) == 1:
            break
    else:
        raise RuntimeError(f'initialize_not_found {pool_id}')
    log = found[0]
    fee, spacing, hooks, sqrt_price, tick = decode(['uint24', 'int24', 'address', 'uint160', 'int24'], bytes.fromhex(log['data'][2:]))
    currency0, currency1 = '0x' + log['topics'][2][26:], '0x' + log['topics'][3][26:]
    key_id = '0x' + keccak(encode(['address', 'address', 'uint24', 'int24', 'address'], [currency0, currency1, fee, spacing, hooks])).hex()
    if key_id != pool_id:
        raise RuntimeError(f'pool_key_mismatch {pool_id}')
    return {'currency0': currency0, 'currency1': currency1, 'fee': fee, 'tickSpacing': spacing, 'hooks': hooks.lower(),
            'initializedAtBlock': int(log['blockNumber'], 16)}


def slot0(rpc, pool_id, block):
    data = '0x' + (keccak(b'getSlot0(bytes32)')[:4] + encode(['bytes32'], [bytes.fromhex(pool_id[2:])])).hex()
    price, tick, protocol_fee, lp_fee = decode(['uint160', 'int24', 'uint24', 'uint24'], bytes.fromhex(rpc('eth_call', [{'to': STATE_VIEW, 'data': data}, hex(block)])[2:]))
    return {'protocolFee': protocol_fee, 'lpFee': lp_fee}


def swaps(rpc, pool_id, start, end):
    out = []
    for log in logs(rpc, [SWAP, pool_id], start, end):
        a0, a1, sqrt_price, liquidity, tick, fee = decode(['int128', 'int128', 'uint160', 'uint128', 'int24', 'uint24'], bytes.fromhex(log['data'][2:]))
        out.append({'block': int(log['blockNumber'], 16), 'index': int(log['logIndex'], 16), 'ts': int(log['blockTimestamp'], 16),
                    'a0': a0, 'a1': a1, 'sqrtPrice': sqrt_price, 'liquidity': liquidity, 'tick': tick, 'fee': fee})
    return sorted(out, key=lambda s: (s['block'], s['index']))


def share(values, predicate):
    return sum(1 for v in values if predicate(v)) / len(values) if values else None


def quantiles(values, qs=(0.1, 0.5, 0.9)):
    ordered = sorted(values)
    return {f'p{int(q * 100)}': ordered[min(len(ordered) - 1, int(q * len(ordered)))] for q in qs} if ordered else None


def analyse(label, key, fees, events, eth_usd):
    quote = WETH if WETH in (key['currency0'], key['currency1']) else ETH if ETH in (key['currency0'], key['currency1']) else USDG
    if label == 'WETH/USDG':
        quote = USDG
    quote_is_1 = key['currency1'] == quote
    quote_usd = eth_usd / 10**18 if quote in (WETH, ETH) else 1 / 10**6
    total_fee = events[-1]['fee'] / 1e6
    lp_fee = fees['lpFee'] / 1e6

    # End-of-block price as a step function of the block number: the state the
    # guard and the engine read. Sampled every ten blocks across the active span.
    blocks = []
    ticks = []
    for e in events:
        if blocks and blocks[-1] == e['block']:
            ticks[-1] = e['tick']
        else:
            blocks.append(e['block']); ticks.append(e['tick'])
    by_block = {e['block']: e for e in events}

    def tick_at(block):
        i = bisect.bisect_right(blocks, block) - 1
        return ticks[i] if i >= 0 else None

    first, last = blocks[0], blocks[-1]
    samples = range(first, last + 1, 10)
    moves = {name: [] for name in HORIZONS}
    for b in samples:
        t0 = tick_at(b)
        for name, h in HORIZONS.items():
            moves[name].append(1.0001 ** (tick_at(b + h) - t0) - 1)
    guard_ok = share(moves['0.5 s'], lambda r: GUARD_LOW <= 1 + r <= GUARD_HIGH)
    tolerance = SLIPPAGE - total_fee - OWN_IMPACT
    liveness = {}
    for name in HORIZONS:
        rs = moves[name]
        liveness[name] = {
            'direct': {f'{int(b * 100)}%': share(rs, lambda r, b=b: abs(r) <= b) for b in IMPACT_BANDS},
            'swap': {f'{int(b * 100)}%': (share(rs, lambda r, b=b: -tolerance <= r <= b) + share(rs, lambda r, b=b: -b <= r <= tolerance)) / 2
                     for b in IMPACT_BANDS},
            'absMove': quantiles([abs(r) for r in rs], (0.5, 0.9, 0.99)),
        }

    # Manipulation economics. Depth is L x sqrt(P) in quote units: moving the
    # square-root price by a fraction x takes about depth x x of the quote, so a
    # push and restore of the price by x costs about fee x depth x x in fees,
    # while it takes at most x of the automation's swap. The break-even swap,
    # fee x depth, does not depend on x.
    def depth_usd(e):
        sqrt_p = e['sqrtPrice'] / 2**96
        raw = e['liquidity'] * sqrt_p if quote_is_1 else e['liquidity'] / sqrt_p
        return raw * quote_usd

    depths = []
    for b in samples:
        i = bisect.bisect_right(blocks, b) - 1
        depths.append(depth_usd(by_block[blocks[i]]))
    depth_q = quantiles(depths)
    breakeven = {k: v * total_fee for k, v in depth_q.items()}
    median_depth = depth_q['p50']
    attack = {
        'breakEvenSwapUsd': breakeven,
        'pushRestoreCostUsd': {'1%': total_fee * median_depth * 0.01, '10%': total_fee * median_depth * 0.10},
        # Post-observation, the engine's floor bounds the take to the slippage
        # window left after the pool fee: at most tolerance x the swap.
        'maxPostObservationGainUsdForSwap': {str(s): max(0.0, tolerance * (s - breakeven['p50'])) for s in (100, 1000, 10000)},
    }

    # Balancing needs: a position with POSITION_SHARE of the active liquidity
    # earns that share of the LP fee on each swap's input token. Over each
    # interval, the swap that would rebalance its fees to equal value is about
    # half their value difference at the interval's closing price.
    balancing = {}
    for name, seconds in INTERVALS.items():
        needs, earned = [], []
        start_ts, end_ts = events[0]['ts'], events[-1]['ts']
        window_start, i = start_ts, 0
        while window_start + seconds <= end_ts:
            window_end = window_start + seconds
            fee0 = fee1 = 0
            last_event = None
            while i < len(events) and events[i]['ts'] < window_end:
                e = events[i]
                if e['a0'] < 0:
                    fee0 += -e['a0'] * lp_fee * POSITION_SHARE
                if e['a1'] < 0:
                    fee1 += -e['a1'] * lp_fee * POSITION_SHARE
                last_event = e
                i += 1
            if last_event is not None:
                price = (last_event['sqrtPrice'] / 2**96) ** 2          # currency1 per currency0, raw
                v0, v1 = (fee0 * price, fee1) if quote_is_1 else (fee0, fee1 / price)
                v0, v1 = v0 * quote_usd, v1 * quote_usd
                needs.append(abs(v0 - v1) / 2)
                earned.append(v0 + v1)
            window_start = window_end
        be = breakeven['p50']
        balancing[name] = {'intervals': len(needs), 'feesEarnedUsd': quantiles(earned, (0.5, 0.9)),
                           'balancingSwapUsd': quantiles(needs, (0.5, 0.9)),
                           'withinBreakEven': share(needs, lambda n: n <= be), 'withinThreeTimes': share(needs, lambda n: n <= 3 * be)}
    hours = (events[-1]['ts'] - events[0]['ts']) / 3600
    return {'pool': label, 'poolKey': key, 'slot0Fees': fees, 'swapFee': total_fee, 'quote': quote, 'swaps': len(events),
            'activeHours': hours, 'swapsPerHour': len(events) / max(hours, 1e-9), 'depthUsd': depth_q,
            'guardPublicationOk': guard_ok, 'liveness': liveness, 'attack': attack, 'balancing': balancing}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--rpc', required=True, help='loopback URL of the project node, e.g. an SSH tunnel')
    parser.add_argument('--hours', type=float, default=24.0)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    rpc = Node(args.rpc)
    if rpc('eth_chainId', []) != '0x1237':
        raise RuntimeError('wrong_chain')
    head = header(rpc, int(rpc('eth_blockNumber', []), 16))
    start = block_at(rpc, head['timestamp'] - int(args.hours * 3600), head['number'] - int(args.hours * 3600 * 14), head['number'])
    start_header = header(rpc, start)
    report = {'study': 'new-token-automation', 'chainId': 4663, 'source': 'project node on clawber through a loopback tunnel',
              'capturedAt': datetime.now(timezone.utc).isoformat(), 'head': head, 'windowStart': start_header,
              'blocksPerSecond': (head['number'] - start) / max(1, head['timestamp'] - start_header['timestamp']),
              'assumptions': {'slippage': SLIPPAGE, 'ownImpact': OWN_IMPACT, 'positionShare': POSITION_SHARE,
                              'horizonBlocks': HORIZONS, 'guardBandPriceRatio': [GUARD_LOW, GUARD_HIGH]},
              'pools': []}
    raw = {}
    for label, pool_id, created in POOLS:
        key = pool_key(rpc, pool_id, created, head)
        fees = slot0(rpc, pool_id, head['number'])
        raw[label] = (key, fees, swaps(rpc, pool_id, start, head['number']))
        print(json.dumps({'pool': label, 'swaps': len(raw[label][2]), 'hooks': key['hooks'], 'fee': key['fee'], **fees}), flush=True)
    deep = raw['WETH/USDG'][2][-1]
    eth_usd = (deep['sqrtPrice'] / 2**96) ** 2 * 10**12
    report['ethUsdFromPool'] = eth_usd
    for label, _, _ in POOLS:
        key, fees, events = raw[label]
        if len(events) < 10:
            report['pools'].append({'pool': label, 'poolKey': key, 'swaps': len(events), 'note': 'too_few_swaps'})
            continue
        report['pools'].append(analyse(label, key, fees, events, eth_usd))
    report['rpcCalls'] = rpc.calls
    with open(args.output, 'x') as handle:
        json.dump(report, handle, indent=1)
        handle.write('\n')
    print(json.dumps({'done': args.output, 'rpcCalls': rpc.calls}), flush=True)


if __name__ == '__main__':
    main()
