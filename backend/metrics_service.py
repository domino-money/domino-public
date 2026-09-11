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
        series, evidence, overflow = [], [], None
        for currency in currencies:
            try:
                loaded, diagnostic = load_price_series(conn, pool_id, [currency], window['start'], window['end'])
            except DataError as error:
                if str(error) != 'price_observation_budget_exhausted': raise
                # Capacity in one asset must not erase the other asset's evidence.
                overflow = str(error)
                series.append(None)
                evidence.extend(unavailable_prices([currency], window['start'], window['end'], overflow))
            else:
                series.extend(loaded)
                evidence.extend(diagnostic)
        if overflow is not None:
            valuation = unavailable_valuation(overflow)
        else:
            try:
                valuation = value_window(window, series, pool_id)
            except DataError as error:
                valuation = unavailable_valuation(str(error))
        return {'schemaVersion': 1, 'mode': 'historical_pool_metrics_read_only', 'chainId': 4663,
                'poolId': pool_id, 'poolKey': row['pool_key'], 'snapshot': tail['state_snapshot'],
                'revision': row['revision'], 'capital': capital, 'prices': evidence, 'valuation': valuation,
                'suggested': False, 'executionAvailable': False,
                'coverage': {'canonicality': 'requires_rpc_recheck', 'rpcCompleteness': 'single_provider_assumption'}}


def unavailable_valuation(reason):
    return {'methodologyVersion': 1, 'status': 'unavailable', 'reason': reason,
            'tvlUsd': None, 'timeWeightedAverageTvlUsd': None, 'tradingLpFeesUsd': None,
            'grossInputVolumeUsd': None, 'feeAprPercent': None}


def unavailable_prices(currencies, start, end, reason):
    return [{'currency': currency, 'observations': None, 'observedSources': None,
             'firstTimestamp': None, 'lastTimestamp': None, 'status': 'unavailable', 'reason': reason,
             'sourceQualification': 'not_assessed',
             'coverage': {'status': 'not_assessed', 'startTimestamp': start,
                          'endTimestamp': end, 'maxAgeSeconds': None}} for currency in currencies]
