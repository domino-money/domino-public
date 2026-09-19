"""Probe a verified pool's bounded Chainlink history; no daemon or execution."""
import argparse
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
import json
from pathlib import Path
import time

from catalogue import configured_catalogue
from chainlink_history import ChainlinkHistorical, FEEDS
from chainlink_reference import reference_series
from discovery import DataError, DiscoveryReader, ReadRpc, bytes32, parse_block
from local_config import load_config
from rpc_config import configured_history_rpc_url
from price_history import store_observations
from read_service import bounded_transport


def qualify(pool_id, hours=24, *, persist=False, provider_config=None):
    pool_id = bytes32(pool_id)
    if type(hours) is not int or not 1 <= hours <= 24:
        raise DataError('invalid_chainlink_probe_bounds')
    config = load_config(provider_config) if provider_config is not None else load_config()
    if provider_config is not None and not config:
        raise DataError('configured_rpc_required')
    url = configured_history_rpc_url(config)
    rpc = ReadRpc(url, transport=bounded_transport(30), max_requests=30)
    reader = DiscoveryReader(rpc)
    snapshot = reader.snapshot()
    pool = reader.pool({'poolId': pool_id}, snapshot)
    reader.assert_canonical(snapshot)
    if any(currency not in FEEDS for currency in pool['currencies']):
        raise DataError('chainlink_pool_currency_unsupported')
    catalogue = configured_catalogue() if persist else None
    if persist and catalogue is None:
        raise DataError('catalogue_not_configured')
    start, end = max(0, snapshot.timestamp-hours*3600), snapshot.timestamp

    def probe(currency):
        # Independent RPC/client budgets avoid shared request-counter races.
        started = time.monotonic()
        price_rpc = ReadRpc(url, transport=bounded_transport(480), max_requests=1600)
        result = {'currency': currency, 'status': 'unavailable'}
        guards = []
        bundle = None
        try:
            bundle = ChainlinkHistorical(price_rpc, deadline_seconds=360).fetch(
                currency, start, end, block_number=snapshot.number)
            result['history'] = bundle
            if (not isinstance(bundle, dict) or bundle.get('snapshot') != asdict(snapshot)
                    or not isinstance(bundle.get('coverage'), dict)
                    or bundle['coverage'].get('startTimestamp') != start
                    or bundle['coverage'].get('endTimestamp') != end
                    or not isinstance(bundle.get('feed'), dict)
                    or bundle['feed'].get('currency') != currency):
                raise DataError('chainlink_probe_context_mismatch')
            _, evidence = reference_series(bundle, pool_id, price_rpc,
                pool_key=pool['poolKey'], on_verified=guards.append if persist else None)
            result.update(status='reference_analytics_only', reference=evidence)
        except DataError as error:
            result['reason'] = str(error)
        result.update(rpcRequests=price_rpc.count, durationSeconds=round(time.monotonic()-started, 3))
        print(json.dumps({k: result[k] for k in ('currency', 'status', 'rpcRequests', 'durationSeconds')}
                         | ({'reason': result['reason']} if 'reason' in result else {})), flush=True)
        # Guards contain private RPC clients and never enter the JSON report.
        return result, guards, price_rpc, started, bundle

    with ThreadPoolExecutor(max_workers=2) as workers:
        probes = list(workers.map(probe, pool['currencies']))
    cases = [item[0] for item in probes]
    storage = {'requested': persist, 'status': 'not_requested', 'reason': None}
    for case in cases:
        case['observationsSaved'] = False
    complete = all(case['status'] == 'reference_analytics_only' for case in cases)
    if not complete and persist:
        storage.update(status='blocked', reason='reference_validation_failed')
    if complete:
        try:
            # Keep the original probe error when validation already failed.
            # Otherwise recheck discovery's pinned snapshot before any storage.
            final_rpc = ReadRpc(url, transport=bounded_transport(15), max_requests=3)
            if parse_block(final_rpc.request('eth_getBlockByNumber', [snapshot.tag, False])) != snapshot:
                raise DataError('snapshot_reorganized')
            if catalogue is not None:
                if any(len(guards) != 1 for _, guards, _, _, _ in probes):
                    raise DataError('chainlink_storage_validation_missing')

                def before_commit():
                    for case, guards, _, _, _ in probes:
                        try:
                            guards[0]()
                        except DataError as error:
                            case.update(status='unavailable', reason=str(error))
                            raise

                # Both currencies share one transaction, including idempotent
                # retries. A failed second guard rolls back every new row.
                rows = [row for _, _, _, _, bundle in probes for row in bundle['observations']]
                store_observations(catalogue, rows, before_commit=before_commit)
                for case in cases:
                    case['observationsSaved'] = True
                storage.update(status='saved')
        except DataError as error:
            storage.update(status='failed' if persist else 'not_requested', reason=str(error))
            if catalogue is None or str(error) == 'snapshot_reorganized':
                for case in cases:
                    case.update(status='unavailable', reason=str(error))
    for case, _, price_rpc, started, _ in probes:
        case.update(rpcRequests=price_rpc.count, durationSeconds=round(time.monotonic()-started, 3))
    return {'schemaVersion': 1, 'mode': 'bounded_chainlink_reference_qualification',
        'poolId': pool_id, 'poolKey': pool['poolKey'], 'poolIdentityStatus': pool['identityStatus'],
        'snapshot': asdict(snapshot), 'startTimestamp': start, 'endTimestamp': end,
        'cases': cases, 'storage': storage,
        'referenceCoverageComplete': all(c['status'] == 'reference_analytics_only' for c in cases),
        'capitalHistoryAssessed': False, 'tvlUsd': None, 'feeApr24h': None,
        'productionQualified': False, 'executionAvailable': False,
        'transport': 'configured_historical_rpc' if config else 'public_robinhood_rpc',
        'walletAccessed': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pool-id', required=True)
    parser.add_argument('--hours', type=int, default=24)
    parser.add_argument('--store-observations', action='store_true')
    parser.add_argument('--provider-config', type=Path,
                        help='Existing private local provider configuration; never copied into the report.')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        if args.output.exists():
            raise DataError('output_exists')
        result = qualify(args.pool_id, args.hours, persist=args.store_observations,
                         provider_config=args.provider_config)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('x') as stream:
            json.dump(result, stream, indent=2);stream.write('\n')
        return 0 if (result['referenceCoverageComplete'] and
                     (not args.store_observations or result['storage']['status'] == 'saved')) else 1
    except DataError as error:
        print(json.dumps({'status': 'chainlink_qualification_failed', 'reason': str(error)}));return 1
    except (OSError, KeyError, TypeError, ValueError):
        print(json.dumps({'status': 'chainlink_qualification_failed', 'reason': 'local_operation_unavailable'}));return 1


if __name__ == '__main__':
    raise SystemExit(main())
