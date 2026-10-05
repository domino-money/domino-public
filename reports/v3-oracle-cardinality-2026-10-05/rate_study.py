"""Observation writes per 300 s / 600 s window, per pool, over a period, from logs.

    python rate_study.py <chainId> <hours> <out.json> <pool> [<pool> ...]
"""
import json
import sys
import time

from chainlib import NAMES, Rpc, observe_reason, pool_facts
from writes import fetch_logs, reconstruct, summary

BLOCK_TIME = {4663: 0.1, 8453: 2.0, 42161: 0.25}
STEP = {4663: 50_000, 8453: 1_000, 42161: 10_000}


def study(chain, hours, pools):
    rpc = Rpc(chain, timeout=90)
    head = rpc.head()
    tag = hex(head['number'])
    period = int(hours * 3600)
    blocks = int(period / BLOCK_TIME[chain])
    lead = int(1200 / BLOCK_TIME[chain])  # 20 minutes earlier, for the tick before the period
    results = []
    for pool in pools:
        t0 = time.time()
        facts = pool_facts(rpc, pool, tag)
        logs = fetch_logs(rpc, pool, head['number'] - blocks - lead, head['number'], STEP[chain])
        writes, swap_blocks, counts = reconstruct(logs)
        start, end = head['timestamp'] - period, head['timestamp']
        writes = [t for t in writes if t >= start]
        swap_times = sorted(ts for n, ts in swap_blocks.items() if ts >= start)
        entry = {'pool': pool.lower(), 'fee': facts['fee'], 'token0': facts['token0'], 'token1': facts['token1'],
                 'cardinality': facts['cardinality'], 'cardinalityNext': facts['cardinalityNext'],
                 'liquidity': str(facts['liquidity']), 'periodSeconds': period, 'writes': len(writes),
                 'blocksWithSwaps': len(swap_times), 'counts': counts,
                 'writes300': summary(writes, 300, start, end), 'writes600': summary(writes, 600, start, end),
                 'swapBlocks300': summary(swap_times, 300, start, end),
                 'observe300': observe_reason(rpc, pool, 300, tag), 'observe600': observe_reason(rpc, pool, 600, tag),
                 'seconds': round(time.time() - t0, 1)}
        results.append(entry)
        print(json.dumps({k: entry[k] for k in ('pool', 'fee', 'cardinalityNext', 'writes', 'blocksWithSwaps',
                                                 'writes300', 'writes600', 'swapBlocks300', 'observe300', 'seconds')}),
              flush=True)
    return {'chainId': chain, 'chain': NAMES[chain], 'head': head, 'hours': hours, 'pools': results,
            'calls': rpc.calls}


if __name__ == '__main__':
    chain, hours, out = int(sys.argv[1]), float(sys.argv[2]), sys.argv[3]
    report = study(chain, hours, sys.argv[4:])
    json.dump(report, open(out, 'w'), indent=1, default=str)
    print('done', report['calls'], 'calls')
