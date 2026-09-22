#!/usr/bin/env python3
"""Who adds liquidity to a pool: every ModifyLiquidity event since the pool's
initialization, by caller and by position owner. For the launch pools with hooks,
this shows whether outside LPs take part at all. Read-only, project node.

Run: backend/.venv/bin/python reports/new-token-automation-2026-09-22/liquidity_providers.py \
       --rpc http://127.0.0.1:18547 --study study-24h.json --output <new file>.json
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import json
import urllib.request

from eth_abi import decode, encode
from eth_hash.auto import keccak

POOL_MANAGER = '0x8366a39cc670b4001a1121b8f6a443a643e40951'
POSITION_MANAGER = '0x58daec3116aae6d93017baaea7749052e8a04fa7'
MODIFY = '0x' + keccak(b'ModifyLiquidity(bytes32,address,int24,int24,int256,bytes32)').hex()
INITIALIZE = '0x' + keccak(b'Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)').hex()


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


def logs(rpc, topics, start, end, step=200_000):
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


def owner_of(rpc, token_id):
    data = '0x' + (keccak(b'ownerOf(uint256)')[:4] + encode(['uint256'], [token_id])).hex()
    try:
        return decode(['address'], bytes.fromhex(rpc('eth_call', [{'to': POSITION_MANAGER, 'data': data}, 'latest'])[2:]))[0].lower()
    except RuntimeError:
        return 'burned'


def main():
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--rpc', required=True)
    parser.add_argument('--study', required=True, help='the study JSON, whose pools carry their on-chain keys')
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    rpc = Node(args.rpc)
    head = int(rpc('eth_blockNumber', []), 16)
    study = json.load(open(args.study))
    # The study's pools, hooked and hookless, with the block their key was initialized in.
    targets = [{'label': p['pool'], 'poolId': None, 'hooked': int(p['poolKey']['hooks'], 16) != 0,
                'hooks': p['poolKey']['hooks'], 'initializedAtBlock': p['poolKey']['initializedAtBlock']} for p in study['pools']]
    ids = {'PKRT/WETH': '0xf8a1468fca4504e3f1f62c324afd9cf41345e7d3e7a1a7cd11a3e86236f7cea8',
           'PGREM/WETH': '0xa0412d8ef17f67323b9fc1c85838d5172925ab328ceb84c9e62f4293af41d28e',
           'STPASS/WETH': '0x64aa367edfb0e7e91f869c616c06d39cf9643f8180a260834add64b629130f96',
           'EARLY/WETH': '0x11567d4c061846382f6149aec46c246113f7cad3a32bb8510f0f24c570474b33',
           'AD/ETH': '0x2a4e49b6f4026be2d9c4cc273f389d986256e27b18950a8967d1daa095b27978',
           'HOODCATS/ETH': '0xc19d1d77bfdaeb66c285a17286d325062c1cd0c7ce88c1fe60ef70797ee8f215',
           'AI/USDG': '0x7aebd80541bfaaf23dbb6e99ce13d4d31c1a84c91414f971eadbff7db5f85995',
           'META/USDG': '0x5875d407a42965b0e768c8925cea290e06fa50603ef34fc99eb92a1050e6ae36',
           'WETH/USDG': '0xbac3aa3b91584a53a579b3c999a56756e954e59247e497bad1d25a4334bde551'}
    for target in targets:
        target['poolId'] = ids[target['label']]
    rows = []
    for target in targets:
        pool_id = target['poolId']
        init = logs(rpc, [INITIALIZE, pool_id], max(0, target['initializedAtBlock'] - 10), target['initializedAtBlock'] + 10)
        start = int(init[0]['blockNumber'], 16) if init else target['initializedAtBlock']
        events = logs(rpc, [MODIFY, pool_id], start, head)
        senders, adders, owners = Counter(), Counter(), Counter()
        for e in events:
            sender = '0x' + e['topics'][2][26:]
            lower, upper, delta, salt = decode(['int24', 'int24', 'int256', 'bytes32'], bytes.fromhex(e['data'][2:]))
            senders[sender] += 1
            if delta > 0:
                adders[sender] += 1
                if sender == POSITION_MANAGER:
                    owners[int.from_bytes(salt, 'big')] += 1
        distinct_owners = Counter()
        for token_id in list(owners)[:200]:
            distinct_owners[owner_of(rpc, token_id)] += 1
        rows.append({**target, 'modifyEvents': len(events), 'additions': sum(adders.values()),
                     'additionsViaPositionManager': adders.get(POSITION_MANAGER, 0),
                     'additionsByOtherCallers': sum(v for k, v in adders.items() if k != POSITION_MANAGER),
                     'otherCallers': len([k for k in adders if k != POSITION_MANAGER]),
                     'positionManagerPositions': len(owners), 'distinctPositionOwners': len([o for o in distinct_owners if o != 'burned']),
                     'ownersSampled': min(len(owners), 200)})
        print(json.dumps({k: rows[-1][k] for k in ('label', 'hooked', 'modifyEvents', 'additions', 'additionsViaPositionManager',
                                                   'additionsByOtherCallers', 'otherCallers', 'positionManagerPositions', 'distinctPositionOwners')}), flush=True)
    report = {'study': 'liquidity-providers', 'chainId': 4663, 'source': 'project node on clawber through a loopback tunnel',
              'capturedAt': datetime.now(timezone.utc).isoformat(), 'headBlock': head, 'pools': rows, 'rpcCalls': rpc.calls}
    with open(args.output, 'x') as handle:
        json.dump(report, handle, indent=1)
        handle.write('\n')


if __name__ == '__main__':
    main()
