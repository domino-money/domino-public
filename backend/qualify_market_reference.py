"""Collect one bounded canonical reference history report without storing prices."""
import argparse
import json
from pathlib import Path

from discovery import DataError
from local_config import load_config
from market_reference_history import CanonicalMarketHistorical, _SAFE_TRANSPORT_REASONS
from read_service import bounded_transport

_SAFE_REASONS = _SAFE_TRANSPORT_REASONS | frozenset({
    'invalid_address', 'canonical_market_currency_unsupported',
    'invalid_price_history_bounds', 'invalid_price_history_response',
    'price_response_currency_mismatch', 'price_response_asset_mismatch',
    'price_observation_budget_exhausted', 'price_outside_requested_window',
    'conflicting_price_observation', 'invalid_price_timestamp', 'invalid_usd_price',
    'market_reference_provider_unavailable', 'market_reference_provider_error',
    'configured_rpc_required', 'invalid_inventory_endpoint',
    'local_provider_config_unreadable', 'local_provider_config_permissions',
    'invalid_local_provider_config', 'output_exists',
})


def qualify(currency, start, end, *, provider_config):
    config = load_config(provider_config)
    if not config:
        raise DataError('configured_rpc_required')
    return CanonicalMarketHistorical(config['rpcUrl'], transport=bounded_transport(30)).fetch(
        currency, start, end)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--currency', required=True, help='Exact Robinhood canonical currency address.')
    parser.add_argument('--start', required=True, type=int, help='Inclusive UTC Unix timestamp.')
    parser.add_argument('--end', required=True, type=int, help='Inclusive UTC Unix timestamp.')
    parser.add_argument('--provider-config', required=True, type=Path,
                        help='Existing private product provider configuration; never copied to output.')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.output.exists() or args.output.is_symlink():
            raise DataError('output_exists')
        result = qualify(args.currency, args.start, args.end, provider_config=args.provider_config)
        rendered = json.dumps(result, indent=2, allow_nan=False) + '\n'
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('x') as stream:
            stream.write(rendered)
        print(json.dumps({'status': result['status'], 'coverage': result['coverage']['status'],
                          'sourceQualified': False, 'executionAvailable': False}))
        # Success means the bounded report was obtained, never source approval.
        return 0 if result['coverage']['status'] == 'observed_grid_complete' else 1
    except Exception as error:
        reason = str(error) if isinstance(error, DataError) else None
        print(json.dumps({'status': 'market_reference_probe_failed',
                          'reason': reason if reason in _SAFE_REASONS else 'local_operation_unavailable',
                          'sourceQualified': False, 'executionAvailable': False}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
