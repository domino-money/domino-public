"""How fast a chain's V2 RPC endpoints answer read-v6's chain reads, measured where the reader runs.

For each endpoint of one chain, `--samples` times, first on a new connection each call (discovery.rpc_http: urllib
sends `Connection: close`, so every call pays TCP and TLS), then on kept connections (v2_chain_reads.kept_rpc, the
reader's):
- `eth_chainId`: the round trip itself;
- the chain-pools survey of the chain's stable (v2_chain_reads.survey, as chain-pools reads it: its pools, their
  bitmap words, their ticks), at the endpoint's own head, read just before and not timed.
The report gives, per endpoint and mode, the milliseconds of each (median, 90th percentile, slowest), how many calls
each survey took with the ETH/USD feed's state at its head (without an ETH price the depths are not read: one call,
not three), and the failures by code. It names hosts, never a URL. Read-only and billed like any read: a few hundred
calls for ten samples.

On the VM, with the reader's credentials and hosts file, from a checkout of the backend (the release's Python):

    sudo systemd-run --pipe --wait --collect -p ImportCredential='v2-rpc-*' \\
        -p BindReadOnlyPaths=/etc/domino/continuous-reads/read.hosts:/etc/hosts -p WorkingDirectory=<checkout> \\
        <release>/read/backend/.venv/bin/python3.14 -B backend/v2_rpc_latency.py --chain base-8453 \\
        --chain-rpc-file /etc/domino/read/chain-rpc.json
"""
import argparse
from collections import Counter
import json
from math import ceil
import statistics
import sys
import time

from discovery import CHAIN_ID, DataError, parse_block, quantity, rpc_http
from local_config import CONFIG_PATH, load_config
from read_deadline import read_deadline
from v2_chain_reads import CHAIN_READ_REQUESTS, kept_rpc, pool_candidates, stable_of, survey
from v2_chains import default_registry
from v2_rpc import ChainReadRpc, configured_endpoints, load_chain_rpc_config

MODES = (('new_connection', rpc_http), ('kept', kept_rpc))
SAMPLE_SECONDS = 60
MAX_SAMPLES = 50


def summary(values):
    """Median, 90th percentile (nearest rank) and slowest of milliseconds; None without one."""
    if not values:
        return None
    ordered = sorted(values)
    return {'samples': len(ordered), 'p50': round(statistics.median(ordered)),
            'p90': round(ordered[ceil(0.9 * len(ordered)) - 1]), 'max': round(ordered[-1])}


def measure(endpoints, endpoint, samples, *, clock=time.perf_counter):
    """One endpoint, in one mode: `samples` round trips and chain-pools surveys."""
    chain = endpoints.chain
    stable = stable_of(chain)[0]
    refs = pool_candidates(chain, stable)
    trips, surveys, calls, feed, failures = [], [], Counter(), Counter(), Counter()
    for _ in range(samples):
        try:
            with read_deadline(SAMPLE_SECONDS):
                start = clock()
                reply = endpoints(endpoint.url, {'jsonrpc': '2.0', 'id': 1, 'method': 'eth_chainId', 'params': []})
                took = (clock() - start) * 1000
                if not isinstance(reply, dict) or 'result' not in reply:
                    raise DataError('invalid_rpc_envelope')
                if quantity(reply['result']) != chain.chainId:
                    raise DataError('wrong_chain')
                trips.append(took)
        except DataError as error:
            failures[str(error)] += 1
        try:
            with read_deadline(SAMPLE_SECONDS):
                rpc = ChainReadRpc(endpoints, only=endpoint.name, max_requests=CHAIN_READ_REQUESTS + 1)
                head = parse_block(rpc.request('eth_getBlockByNumber', ['latest', False]))
                sent, start = rpc.count, clock()
                found = survey(chain, rpc, head, refs, {ref: stable for ref in refs})
                surveys.append((clock() - start) * 1000)
                calls[str(rpc.count - sent)] += 1
                feed[found.eth[2] or 'priced'] += 1
        except DataError as error:
            failures[str(error)] += 1
    return {'chainIdMs': summary(trips), 'surveyMs': summary(surveys), 'surveyCalls': dict(sorted(calls.items())),
            'ethUsd': dict(sorted(feed.items())), 'failures': dict(sorted(failures.items()))}


def main(argv=None, *, clock=time.perf_counter):
    parser = argparse.ArgumentParser(description="Measure a chain's V2 RPC endpoints as read-v6's chain reads use them.")
    parser.add_argument('--chain', required=True, help='profile name, e.g. base-8453')
    parser.add_argument('--chain-rpc-file', help='the private V2 chain RPC file (chains other than Robinhood)')
    parser.add_argument('--provider-file', default=str(CONFIG_PATH), help='the read path provider file (Robinhood)')
    parser.add_argument('--endpoint', help='measure only this endpoint')
    parser.add_argument('--samples', type=int, default=10, help=f'per endpoint and mode, 1 to {MAX_SAMPLES}')
    args = parser.parse_args(argv)
    try:
        if not 1 <= args.samples <= MAX_SAMPLES:
            raise DataError('invalid_samples')
        chain = default_registry().chain(args.chain)
        if chain.chainId == CHAIN_ID:
            options = {'provider_config': load_config(args.provider_file)}
        elif args.chain_rpc_file:
            options = {'chain_rpc_config': load_chain_rpc_config(args.chain_rpc_file)}
        else:
            raise DataError('v2_chain_rpc_not_configured')
        modes = [(mode, configured_endpoints(chain, send=send, **options)) for mode, send in MODES]
        selected = [e for e in modes[0][1].endpoints if args.endpoint in (None, e.name)]
        if not selected:
            raise DataError('v2_rpc_endpoint_unknown')
        results = []
        for endpoint in selected:
            result = {'endpoint': endpoint.name, 'host': endpoint.host, 'requestsPerSecond': endpoint.requests_per_second}
            for mode, endpoints in modes:
                result[mode] = measure(endpoints, endpoint, args.samples, clock=clock)
            results.append(result)
        report = {'chain': chain.key, 'source': modes[0][1].source, 'samples': args.samples,
                  'survey': {'token': stable_of(chain)[0], 'candidates': len(pool_candidates(chain, stable_of(chain)[0]))},
                  'endpoints': results, 'calls': {mode: endpoints.calls() for mode, endpoints in modes}}
    except DataError as error:
        print(json.dumps({'error': str(error)}))
        return 1
    print(json.dumps(report, indent=2, sort_keys=True))
    measured = all(result[mode]['chainIdMs'] and result[mode]['surveyMs'] for result in results for mode, _ in MODES)
    return 0 if measured else 1


if __name__ == '__main__':
    sys.exit(main())
