#!/usr/bin/env python3
"""Census of Uniswap v4 pools on Robinhood Chain by hook status: every pool the
PoolManager ever initialized, and the last day's swaps and volume per pool.

Domino V1's Setup, vault read helper and app refuse any pool whose key names a
hook, so this measures how much of the new-token market V1 can reach at all.
Read-only, from the project node through a loopback URL (an SSH tunnel).

Run: backend/.venv/bin/python reports/new-token-automation-2026-09-22/census.py \
       --rpc http://127.0.0.1:18547 --hours 24 --output <new file>.json
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import urllib.request

from eth_abi import decode
from eth_hash.auto import keccak

POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
SWAP = '0x' + keccak(b'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)').hex()
INITIALIZE = '0x' + keccak(b'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)').hex()
ETH, WETH, USDG = '0x' + '00' * 20, '0x0bd7d308f8e1639fab988df18a8011f41eacad73', '0x5fc5360d0400a0fd4f2af552add042d716f1d168'
DEEP_WETH_USDG = '0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551'
FLAGS = ['afterRemoveLiquidityReturnsDelta', 'afterAddLiquidityReturnsDelta', 'afterSwapReturnsDelta', 'beforeSwapReturnsDelta',
         'afterDonate', 'beforeDonate', 'afterSwap', 'beforeSwap', 'afterRemoveLiquidity', 'beforeRemoveLiquidity',
         'afterAddLiquidity', 'beforeAddLiquidity', 'afterInitialize', 'beforeInitialize']
DYNAMIC_FEE = 0x800000


class Node:
    def __init__(self, url):
        self.url, self.calls = url, 0

    def __call__(self, method, params):
        self.calls += 1
        request = urllib.request.Request(self.url, json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': method, 'params': params}).encode(),
                                         {'content-type': 'application/json'})
        reply = json.load(urllib.request.urlopen(request, timeout=300))
        if 'error' in reply:
            raise RuntimeError(reply['error'])
        return reply['result']


def logs(rpc, topics, start, end, step):
    out, cursor = [], start
    while cursor <= end:
        stop = min(end, cursor + step - 1)
        try:
            out += rpc('eth_getLogs', [{'address': POOL_MANAGER, 'topics': topics, 'fromBlock': hex(cursor), 'toBlock': hex(stop)}])
        except RuntimeError:
            if step <= 200:
                raise
            step //= 4
            continue
        cursor = stop + 1
    return out


def flags(hooks):
    bits = int(hooks, 16) & 0x3FFF
    return [name for i, name in enumerate(FLAGS) if bits >> i & 1]


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--rpc', required=True)
    parser.add_argument('--hours', type=float, default=24.0)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    rpc = Node(args.rpc)
    if rpc('eth_chainId', []) != '0x1237':
        raise RuntimeError('wrong_chain')
    head_raw = rpc('eth_getBlockByNumber', ['latest', False])
    head, now = int(head_raw['number'], 16), int(head_raw['timestamp'], 16)

    pools = {}
    for log in logs(rpc, [INITIALIZE], 0, head, 2_000_000):
        fee, spacing, hooks, _, _ = decode(['uint24', 'int24', 'address', 'uint160', 'int24'], bytes.fromhex(log['data'][2:]))
        pools[log['topics'][1]] = {'currency0': '0x' + log['topics'][2][26:], 'currency1': '0x' + log['topics'][3][26:], 'fee': fee,
                                   'tickSpacing': spacing, 'hooks': hooks.lower(), 'createdAt': int(log['blockTimestamp'], 16),
                                   'swaps': 0, 'volumeUsd': 0.0, 'priced': False}
    print(json.dumps({'poolsInitialized': len(pools)}), flush=True)

    # The day's swaps. Volume is valued through the pool's ETH, WETH or USDG side
    # at the price the chain's deep WETH/USDG pool shows at the end of the window.
    start = head - int(args.hours * 3600 * 9.92)
    swaps = logs(rpc, [SWAP], start, head, 20_000)
    deep = [s for s in swaps if s['topics'][1] == DEEP_WETH_USDG]
    last = decode(['int128', 'int128', 'uint160', 'uint128', 'int24', 'uint24'], bytes.fromhex(deep[-1]['data'][2:]))
    eth_usd = (last[2] / 2**96) ** 2 * 10**12
    for s in swaps:
        pool = pools.get(s['topics'][1])
        if pool is None:
            continue
        a0, a1 = decode(['int128', 'int128', 'uint160', 'uint128', 'int24', 'uint24'], bytes.fromhex(s['data'][2:]))[:2]
        pool['swaps'] += 1
        for currency, amount in ((pool['currency0'], a0), (pool['currency1'], a1)):
            if currency in (ETH, WETH):
                pool['volumeUsd'] += abs(amount) / 1e18 * eth_usd; pool['priced'] = True; break
            if currency == USDG:
                pool['volumeUsd'] += abs(amount) / 1e6; pool['priced'] = True; break
    print(json.dumps({'swaps': len(swaps), 'ethUsd': eth_usd}), flush=True)

    def age_bucket(created):
        age = (now - created) / 86400
        return '<1 day' if age < 1 else '1-7 days' if age < 7 else '7-30 days' if age < 30 else '>30 days'

    def kind(pool):
        if int(pool['hooks'], 16) != 0:
            return 'hooked'
        return 'hookless, dynamic fee' if pool['fee'] & DYNAMIC_FEE else 'hookless'

    created = defaultdict(Counter)
    activity = defaultdict(lambda: defaultdict(lambda: {'pools': 0, 'swaps': 0, 'volumeUsd': 0.0}))
    for pool in pools.values():
        bucket, k = age_bucket(pool['createdAt']), kind(pool)
        created[bucket][k] += 1
        if pool['swaps']:
            cell = activity[bucket][k]
            cell['pools'] += 1; cell['swaps'] += pool['swaps']; cell['volumeUsd'] += pool['volumeUsd']

    # Hooks by the day's volume, grouped by runtime code so one launchpad's
    # per-token hooks count as one design.
    by_hook = defaultdict(lambda: {'pools': 0, 'swaps': 0, 'volumeUsd': 0.0})
    for pool in pools.values():
        if pool['swaps'] and int(pool['hooks'], 16) != 0:
            cell = by_hook[pool['hooks']]
            cell['pools'] += 1; cell['swaps'] += pool['swaps']; cell['volumeUsd'] += pool['volumeUsd']
    designs = defaultdict(lambda: {'hooks': 0, 'pools': 0, 'swaps': 0, 'volumeUsd': 0.0, 'flags': None, 'codeBytes': 0})
    for hook, cell in sorted(by_hook.items(), key=lambda kv: -kv[1]['volumeUsd'])[:400]:
        code = rpc('eth_getCode', [hook, 'latest'])
        digest = '0x' + keccak(bytes.fromhex(code[2:])).hex()
        design = designs[digest]
        design['hooks'] += 1; design['pools'] += cell['pools']; design['swaps'] += cell['swaps']; design['volumeUsd'] += cell['volumeUsd']
        design['flags'] = flags(hook); design['codeBytes'] = (len(code) - 2) // 2
    top_hookless = sorted(({'poolId': pid, **{k: p[k] for k in ('currency0', 'currency1', 'fee', 'swaps', 'volumeUsd', 'createdAt')},
                            'age': age_bucket(p['createdAt'])} for pid, p in pools.items() if kind(p) == 'hookless' and p['swaps']),
                          key=lambda row: -row['volumeUsd'])[:25]
    report = {'census': 'uniswap-v4-hooks', 'chainId': 4663, 'source': 'project node on clawber through a loopback tunnel',
              'capturedAt': datetime.now(timezone.utc).isoformat(), 'headBlock': head, 'headTimestamp': now, 'windowHours': args.hours,
              'ethUsd': eth_usd, 'poolsInitialized': len(pools), 'swapsInWindow': len(swaps),
              'createdByAge': {b: dict(c) for b, c in created.items()},
              'activityByAge': {b: {k: v for k, v in cells.items()} for b, cells in activity.items()},
              'hookDesigns': sorted(({'codeHash': h, **v} for h, v in designs.items()), key=lambda r: -r['volumeUsd'])[:15],
              'topHooklessPools': top_hookless, 'rpcCalls': rpc.calls}
    with open(args.output, 'x') as handle:
        json.dump(report, handle, indent=1)
        handle.write('\n')
    print(json.dumps({'done': args.output, 'rpcCalls': rpc.calls}), flush=True)


if __name__ == '__main__':
    main()
