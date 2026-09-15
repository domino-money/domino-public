"""Bounded capital qualification and external-price ingestion; no signing or daemon."""
import argparse
import json
from pathlib import Path

from activity_store import PgActivity
from capital_store import CapitalIndexer
from catalogue import configured_writer_catalogue
from discovery import DataError, ReadRpc, bytes32
from historical_capacity import PROFILES, unavailable_work
from local_config import load_config
from pool_activity import ACTIVITY_CAPACITY_PROFILES
from metrics_service import stored_metrics
from price_history import AlchemyHistorical, store_observations
from read_service import bounded_transport


def run(pool_id, max_steps, fetch_prices, *, capacity='standard', activity_capacity='standard', restart_capital_work=False):
    if type(max_steps) is not int or not 1 <= max_steps <= 50:
        raise DataError('invalid_metrics_bounds_or_output_exists')
    catalogue = configured_writer_catalogue()
    if catalogue is None:
        raise DataError('catalogue_not_configured')
    url = load_config().get('rpcUrl')
    if not url:
        raise DataError('configured_rpc_required')
    store = PgActivity(catalogue);steps = []
    def worker():
        return CapitalIndexer(store, ReadRpc(url, transport=bounded_transport(90), max_requests=160), capacity=capacity,
                              activity_capacity=activity_capacity)
    recovery = worker().restart(pool_id) if restart_capital_work else None
    if recovery:
        print(json.dumps(recovery), flush=True)
    for _ in range(max_steps):
        result = worker().step(pool_id)
        steps.append(result);print(json.dumps(result), flush=True)
        if result['status'] == 'caught_up_to_activity':
            break
    with catalogue.connection() as conn:
        pending = conn.execute('''SELECT 1 FROM domino_activity.chunks c
          LEFT JOIN domino_activity.capital_chunks k ON k.pool_id=c.pool_id AND k.chunk_start=c.start_block
          WHERE c.pool_id=%s AND k.pool_id IS NULL LIMIT 1''', (pool_id,)).fetchone()
        capital = ({'status': 'in_progress', 'reason': 'capital_ledger_not_caught_up',
                    **unavailable_work(conn, pool_id, 'capital')} if pending else {'status': 'caught_up_to_activity'})
    # A finite successful batch is useful progress, not an RPC/error response.
    # Never invoke valuation or fetch prices against an incomplete capital ledger.
    metrics = None if pending else stored_metrics(catalogue, pool_id)
    prices = []
    if fetch_prices and metrics is not None:
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
            'capacityProfile': capacity, 'activityCapacityProfile': activity_capacity, 'recovery': recovery, 'capitalLedger': capital,
            'steps': steps, 'priceIngestion': prices, 'result': metrics, 'liveExecution': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--pool-id', required=True)
    parser.add_argument('--max-steps', type=int, default=6)
    parser.add_argument('--capacity-profile', choices=PROFILES, default='standard')
    parser.add_argument('--activity-capacity-profile', choices=ACTIVITY_CAPACITY_PROFILES, default='standard')
    parser.add_argument('--restart-capital-work', action='store_true',
                        help='Discard only unpublished capital progress after operator review; retain all source/qualified rows')
    parser.add_argument('--fetch-prices', action='store_true')
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    try:
        if not 1 <= args.max_steps <= 50 or args.output.exists():
            raise DataError('invalid_metrics_bounds_or_output_exists')
        result = run(bytes32(args.pool_id), args.max_steps, args.fetch_prices,
                     capacity=args.capacity_profile, activity_capacity=args.activity_capacity_profile, restart_capital_work=args.restart_capital_work)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('x') as stream:
            json.dump(result, stream, indent=2);stream.write('\n')
        return 0
    except DataError as error:
        print(json.dumps({'status': 'metrics_qualification_failed', 'reason': str(error),
                          'activityCapacityProfile': args.activity_capacity_profile, 'previousCommittedProgressRetained': True}));return 1
    except (OSError, ValueError, TypeError, KeyError):
        print(json.dumps({'status': 'metrics_qualification_failed', 'reason': 'local_operation_unavailable',
                          'activityCapacityProfile': args.activity_capacity_profile, 'previousCommittedProgressRetained': True}));return 1


if __name__ == '__main__':
    raise SystemExit(main())
