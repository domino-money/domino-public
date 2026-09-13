"""Save one bounded, unqualified CoinGecko chart reference for a Robinhood token."""
import argparse
import json
import os
from pathlib import Path

from coingecko_market_reference import CoinGeckoMarketReference
from discovery import DataError


def write_report(path, report):
    """Exclusive creation: never replace an existing report or follow a symlink."""
    serialized = json.dumps(report, sort_keys=True, indent=2, allow_nan=False) + '\n'
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0)
    descriptor = os.open(path, flags, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        stream.write(serialized)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--currency', required=True, help='Robinhood token contract address')
    parser.add_argument('--decimals', required=True, type=int, help='Explicit expected ERC-20 decimals')
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args(argv)
    try:
        if args.output.exists() or args.output.is_symlink():
            raise DataError('coingecko_output_exists')
        result = CoinGeckoMarketReference().history(args.currency, currency_decimals=args.decimals)
        write_report(args.output, result)
        print(json.dumps({'status': 'reference_saved', 'sourceQualification': 'unqualified',
                          'pointCount': result['diagnostics']['pointCount'], 'executionAvailable': False}))
        return 0
    except DataError as error:
        # Only adapter-generated fixed codes reach this boundary.
        print(json.dumps({'status': 'reference_failed', 'reason': str(error), 'executionAvailable': False}))
        return 1
    except (OSError, ValueError, TypeError):
        print(json.dumps({'status': 'reference_failed', 'reason': 'coingecko_report_unavailable',
                          'executionAvailable': False}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
