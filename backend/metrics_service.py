"""Snapshot-bound capital, price quality and conditional historical valuation."""
from activity_store import PgActivity
from capital_store import load_capital_window, raw_capital_metrics
from discovery import DataError
from price_history import load_price_series
from valuation import value_window


def stored_metrics(catalogue, pool_id):
    store = PgActivity(catalogue)
    with catalogue.connection() as conn:
        row = store.pool(conn, pool_id);tail = store.tail(conn, pool_id)
        if not tail:
            raise DataError('activity_not_indexed')
        window = load_capital_window(conn, row, tail)
        capital = raw_capital_metrics(window)
        currencies = [row['pool_key'][f'currency{i}'] for i in (0, 1)]
        series, evidence = load_price_series(conn, pool_id, currencies, window['start'], window['end'])
        try:
            valuation = value_window(window, series, pool_id)
        except DataError as error:
            valuation = {'methodologyVersion': 1, 'status': 'unavailable', 'reason': str(error),
                         'tvlUsd': None, 'timeWeightedAverageTvlUsd': None,
                         'tradingLpFeesUsd': None, 'grossInputVolumeUsd': None, 'feeAprPercent': None}
        return {'schemaVersion': 1, 'mode': 'historical_pool_metrics_read_only', 'chainId': 4663,
                'poolId': pool_id, 'poolKey': row['pool_key'], 'snapshot': tail['state_snapshot'],
                'revision': row['revision'], 'capital': capital, 'prices': evidence, 'valuation': valuation,
                'suggested': False, 'executionAvailable': False,
                'coverage': {'canonicality': 'requires_rpc_recheck', 'rpcCompleteness': 'single_provider_assumption'}}
