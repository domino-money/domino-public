"""Bounded capital qualification and external-price ingestion; no signing or daemon."""
import argparse
import json
from pathlib import Path

from activity_store import PgActivity
from capital_store import CapitalIndexer
from catalogue import configured_catalogue
from discovery import DataError, ReadRpc, bytes32
from local_config import load_config
from metrics_service import stored_metrics
from price_history import AlchemyHistorical, store_observations
from read_service import bounded_transport


def run(pool_id, max_steps, fetch_prices):
    catalogue = configured_catalogue()
    if catalogue is None:
        raise DataError('catalogue_not_configured')
    url = load_config().get('rpcUrl')
    if not url:
        raise DataError('configured_rpc_required')
    store = PgActivity(catalogue);steps = []
    for _ in range(max_steps):
        result = CapitalIndexer(store, ReadRpc(url, transport=bounded_transport(90), max_requests=600)).step(pool_id)
        steps.append(result);print(json.dumps(result), flush=True)
        if result['status'] == 'caught_up_to_activity':
            break
    metrics = stored_metrics(catalogue, pool_id)
    prices = []
    if fetch_prices:
        start = max(0, metrics['capital']['fromTimestampInclusive']-300)
        end = metrics['capital']['throughTimestamp']
        if start < end:
            for currency in (metrics['poolKey']['currency0'], metrics['poolKey']['currency1']):
                try:
                    rows = AlchemyHistorical(url, transport=bounded_transport(30)).fetch(currency, start, end)
                    store_observations(catalogue, rows)
                    result = {'currency': currency, 'status': 'observations_saved', 'observations': len(rows),
                              'qualifiedForUsdValuation': False}
                except DataError as error:
                    result = {'currency': currency, 'status': 'unavailable', 'reason': str(error)}
                prices.append(result);print(json.dumps(result), flush=True)
        metrics = stored_metrics(catalogue, pool_id)
    return {'schemaVersion': 1, 'mode': 'bounded_capital_and_prices_qualification', 'poolId': pool_id,
            'steps': steps, 'priceIngestion': prices, 'result': metrics, 'liveExecution': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pool-id', required=True)
    parser.add_argument('--max-steps', type=int, default=6)
    parser.add_argument('--fetch-prices', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        if not 1 <= args.max_steps <= 50 or args.output.exists():
            raise DataError('invalid_metrics_bounds_or_output_exists')
        result = run(bytes32(args.pool_id), args.max_steps, args.fetch_prices)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('x') as stream:
            json.dump(result, stream, indent=2);stream.write('\n')
        return 0
    except DataError as error:
        print(json.dumps({'status': 'metrics_qualification_failed', 'reason': str(error),
                          'previousCommittedProgressRetained': True}));return 1
    except (OSError, ValueError, TypeError, KeyError):
        print(json.dumps({'status': 'metrics_qualification_failed', 'reason': 'local_operation_unavailable',
                          'previousCommittedProgressRetained': True}));return 1


if __name__ == '__main__':
    raise SystemExit(main())
