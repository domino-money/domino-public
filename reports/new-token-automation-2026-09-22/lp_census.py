#!/usr/bin/env python3
"""How many liquidity positions new pools get: every pool the PoolManager
initialized in the last hours, and every positive ModifyLiquidity on those pools
since, by hook status. A pool with more than one position has LPs besides its
creator. Read-only, project node through a loopback URL (an SSH tunnel).

Run: backend/.venv/bin/python reports/new-token-automation-2026-09-22/lp_census.py \
       --rpc http://127.0.0.1:18547 --hours 48 --output <new file>.json
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import urllib.request

from eth_abi import decode
from eth_hash.auto import keccak

POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7'
MODIFY = '0x' + keccak(b'ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)').hex()
INITIALIZE = '0x' + keccak(b'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)').hex()
SWAP = '0x' + keccak(b'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)').hex()


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


def bucket(n):
    return '0' if n == 0 else '1' if n == 1 else '2-4' if n <= 4 else '5+'


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--rpc', required=True)
    parser.add_argument('--hours', type=float, default=48.0)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    rpc = Node(args.rpc)
    if rpc('eth_chainId', []) != '0x1237':
        raise RuntimeError('wrong_chain')
    head = int(rpc('eth_blockNumber', []), 16)
    start = head - int(args.hours * 3600 * 9.92)
    pools = {}
    for log in logs(rpc, [INITIALIZE], start, head, 500_000):
        hooks = decode(['uint24', 'int24', 'address', 'uint160', 'int24'], bytes.fromhex(log['data'][2:]))[2]
        pools[log['topics'][1]] = {'hooked': int(hooks, 16) != 0, 'positions': set(), 'additions': 0, 'swaps': 0}
    print(json.dumps({'poolsCreated': len(pools)}), flush=True)
    for log in logs(rpc, [MODIFY], start, head, 100_000):
        pool = pools.get(log['topics'][1])
        if pool is None:
            continue
        lower, upper, delta, salt = decode(['int24', 'int24', 'int256', 'bytes32'], bytes.fromhex(log['data'][2:]))
        if delta > 0:
            pool['additions'] += 1
            pool['positions'].add((log['topics'][2], lower, upper, salt))
    # Swaps over the same window, counted per pool, to weigh by trading activity.
    for log in logs(rpc, [SWAP], start, head, 20_000):
        pool = pools.get(log['topics'][1])
        if pool is not None:
            pool['swaps'] += 1
    table = defaultdict(lambda: {'pools': Counter(), 'swaps': Counter()})
    for pool in pools.values():
        kind = 'hooked' if pool['hooked'] else 'hookless'
        active = 'traded' if pool['swaps'] else 'untraded'
        cell = table[f'{kind}, {active}']
        cell['pools'][bucket(len(pool['positions']))] += 1
        cell['swaps'][bucket(len(pool['positions']))] += pool['swaps']
    report = {'census': 'new-pool-liquidity-positions', 'chainId': 4663, 'source': 'project node on clawber through a loopback tunnel',
              'capturedAt': datetime.now(timezone.utc).isoformat(), 'headBlock': head, 'windowHours': args.hours,
              'poolsCreated': len(pools), 'positionsPerPool': {k: {'pools': dict(v['pools']), 'swaps': dict(v['swaps'])} for k, v in table.items()},
              'rpcCalls': rpc.calls}
    with open(args.output, 'x') as handle:
        json.dump(report, handle, indent=1)
        handle.write('\n')
    print(json.dumps(report['positionsPerPool']), flush=True)


if __name__ == '__main__':
    main()
