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
        currencies = [row['pool_key'][f'currency{i}'] for i in (0, 1)]
        start = max(tail['model']['initializedAt'], tail['end_timestamp']-86400)
        window = None
        try:
            window = load_capital_window(conn, row, tail)
            capital = raw_capital_metrics(window)
        except DataError as error:
            # These are incomplete acquisition states, not corrupt-ledger or DB errors.
            if str(error) not in CAPITAL_INCOMPLETE: raise
            capital = {'methodologyVersion': 1, 'status': 'unavailable', 'reason': str(error),
                       'current': None, 'integralRawSeconds': None, 'complete24h': False}
        if window is None:
            evidence = unavailable_prices(currencies, start, tail['end_timestamp'], 'capital_history_unavailable')
            valuation = unavailable_valuation('capital_history_unavailable')
        else:
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


CAPITAL_INCOMPLETE = frozenset({'reconciled_position_tail_required', 'capital_ledger_not_caught_up',
                               'capital_window_budget_exhausted'})


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
