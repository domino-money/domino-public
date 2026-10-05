"""One hour of v3-signature Swap logs on a chain: the canonical Uniswap v3 pools that traded, with slot0."""
import json, sys, time
from chainlib import *
chain, out = int(sys.argv[1]), sys.argv[2]
rpc = Rpc(chain, timeout=90)
h = rpc.head()
blocks = {8453: 1800, 42161: 14400}[chain]
step = {8453: 150, 42161: 1200}[chain]
counts = {}
total = 0
for a in range(h['number'] - blocks + 1, h['number'] + 1, step):
    b = min(h['number'], a + step - 1)
    logs = rpc.request('eth_getLogs', [{'fromBlock': hex(a), 'toBlock': hex(b), 'topics': [SWAP]}])
    total += len(logs)
    for l in logs:
        counts[l['address'].lower()] = counts.get(l['address'].lower(), 0) + 1
pools = sorted(counts, key=lambda p: -counts[p])
fac = rpc.batch([('eth_call', [{'to': p, 'data': selector('factory()')}, hex(h['number'])]) for p in pools], size=40)
uni = []
for p, r in zip(pools, fac):
    if isinstance(r, Exception) or r in (None, '0x') or len(r) < 66: continue
    if decode(['address'], bytes.fromhex(r[2:]))[0].lower() == V3_FACTORY[chain].lower(): uni.append(p)
facts = []
for p in uni:
    f = pool_facts(rpc, p, hex(h['number']))
    if f is None or v3_address(chain, f['token0'], f['token1'], f['fee']) != p: continue
    f['swaps1h'] = counts[p]
    facts.append(f)
json.dump({'head': h, 'swapLogs': total, 'pools': len(pools), 'uniswap': facts}, open(out, 'w'), default=str)
print(NAMES[chain], 'swap logs 1h', total, 'pools', len(pools), 'uniswap v3', len(facts), 'calls', rpc.calls)
