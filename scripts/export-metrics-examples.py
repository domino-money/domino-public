#!/usr/bin/env python3
"""Export internal APR review examples; no browser API, network or private state."""
import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from managed_performance import PerformanceEvidence, calculate_performance
from pool_apr import PoolAprEstimate, estimate_pool_apr
from read_contract import PoolMarketResponse

DEST = ROOT / 'docs/metrics-examples'
NOW = 1789135200


def text(value):
    return json.dumps(value, indent=2, sort_keys=True, allow_nan=False) + '\n'


def examples():
    pool = json.loads((ROOT / 'api-contracts/read-v1/fixtures/producer/pool-market.success.json').read_text())
    pool['snapshot']['timestamp'] = NOW
    pool['pool']['snapshot']['timestamp'] = NOW
    pool['market']['data'].update(retrievedAt=NOW, reportedLiquidityUsd='1000000', volume24hUsd='100000')
    pool['priceHistory'] = {'status': 'not_requested', 'reason': None, 'data': None, 'cache': None}
    start, middle = NOW - 86400, NOW - 43200

    def amount(raw):
        return {'currency': '0x' + '4' * 40, 'decimals': 6, 'raw': str(raw),
                'price': {'sourceId': 'synthetic_review_price', 'status': 'qualified',
                          'timestamp': start, 'validUntil': NOW, 'usdPerToken': '1'}}

    def credit(event, origin, token, timestamp, kind, raw):
        return {'eventId': event, 'feeOriginId': origin, 'epochId': 'synthetic-epoch-1',
                'tokenId': token, 'timestamp': timestamp, 'kind': kind, 'amount': amount(raw)}

    def capital(a, b, values):
        return {'startsAt': a, 'endsAt': b, 'valuationStatus': 'qualified',
                'components': [{'tokenId': token, 'valueUsd': value} for token, value in values]}

    managed = {
        'chainId': 4663, 'epochId': 'synthetic-epoch-1', 'scope': 'sequence',
        'owner': '0x' + '1' * 40, 'positionManager': '0x' + '2' * 40,
        'startedAt': start,
        'snapshot': {'blockNumber': 1000, 'blockHash': '0x' + 'a' * 64,
                     'timestamp': NOW, 'canonicality': 'verified'},
        'coverageStart': start, 'incomeCoverage': 'complete',
        'capitalScope': 'all_position_assets_and_epoch_residual_once',
        'members': [{'tokenId': '1', 'startsAt': start, 'endsAt': None},
                    {'tokenId': '2', 'startsAt': middle, 'endsAt': None}],
        'capital': [capital(start, middle, [('1', '1000'), (None, '0')]),
                    capital(middle, NOW, [('1', '1000'), ('2', '98'), (None, '0')])],
        'credits': [credit('earning-1', 'origin-1', '1', middle, 'new_trading_fee', 100000000),
                    credit('redirect-1', 'origin-1', '2', middle, 'internal_transfer', 98000000),
                    credit('earning-2', 'origin-2', '2', NOW, 'new_trading_fee', 10000000)],
        'debits': [
            {'eventId': 'charge-1', 'epochId': 'synthetic-epoch-1', 'tokenId': '1',
             'timestamp': middle, 'kind': 'service_fee', 'payer': 'strategy', 'amount': amount(2000000)},
            {'eventId': 'gas-1', 'epochId': 'synthetic-epoch-1', 'tokenId': None,
             'timestamp': middle, 'kind': 'network_gas', 'payer': 'operator', 'amount': amount(250000)},
        ],
    }
    warming = deepcopy(managed)
    warming.update(scope='nft', startedAt=middle, coverageStart=middle,
                   members=[{'tokenId': '1', 'startsAt': middle, 'endsAt': None}],
                   capital=[capital(middle, NOW, [('1', '1000'), (None, '0')])],
                   credits=[credit('earning-3', 'origin-3', '1', NOW, 'new_trading_fee', 10000000)], debits=[])
    unpriced = deepcopy(managed)
    unpriced['credits'][0]['amount']['price'].update(status='unavailable', usdPerToken=None)
    reorged = deepcopy(managed)
    reorged['snapshot']['canonicality'] = 'reorged'
    missing_pool = deepcopy(pool)
    missing_pool['market']['data']['volume24hUsd'] = None
    return {
        'pool': ('pool', pool, NOW), 'pool-stale': ('pool', pool, NOW + 61),
        'pool-missing': ('pool', missing_pool, NOW),
        'managed': ('managed', managed, NOW), 'managed-measuring': ('managed', warming, NOW),
        'managed-unpriced': ('managed', unpriced, NOW), 'managed-reorged': ('managed', reorged, NOW),
        'managed-stale': ('managed', managed, NOW + 121),
    }


def build():
    files = {}
    for name, (kind, data, now) in examples().items():
        calculate = estimate_pool_apr if kind == 'pool' else calculate_performance
        files[name + '.input.json'] = text(data)
        files[name + '.output.json'] = text(calculate(data, now=now))
    models = {'pool.input': PoolMarketResponse, 'pool.output': PoolAprEstimate,
              'managed.input': PerformanceEvidence}
    for name, model in models.items():
        schema = model.model_json_schema()
        schema['$schema'] = 'https://json-schema.org/draft/2020-12/schema'
        schema['$comment'] = ('Internal shape only. Cross-field, accounting, freshness and identity checks '
                              'require the Python calculator; this is not a browser API contract.')
        files[name + '.schema.json'] = text(schema)
    sources = ['backend/pool_apr.py', 'backend/managed_performance.py', 'backend/preview_metrics.py',
               'scripts/export-metrics-examples.py', 'docs/APR_METRICS.md',
               'api-contracts/read-v1/fixtures/producer/pool-market.success.json']
    manifest = {
        'status': 'internal_review_examples_no_http_route', 'exampleVersion': 1,
        'synthetic': True, 'defaultEvaluationTimestamp': NOW,
        'evaluationTimestamps': {name: now for name, (_, _, now) in examples().items()},
        'sources': {path: hashlib.sha256((ROOT / path).read_bytes()).hexdigest() for path in sources},
        'files': {name: hashlib.sha256(value.encode()).hexdigest() for name, value in files.items()},
    }
    files['manifest.json'] = text(manifest)
    return files


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    drift = []
    for name, value in build().items():
        path = DEST / name
        if args.check:
            if not path.is_file() or path.read_text() != value:
                drift.append(name)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(value)
    if drift:
        print('Metrics example drift: ' + ', '.join(drift))
        return 1
    print('Metrics examples checked.' if args.check else 'Metrics examples exported.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
