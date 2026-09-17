"""Bounded collection of one mapped external market reference.

Writes `external_market_reference_unqualified` observations, or nothing when
`--store` is absent. It never adds a production qualification and never treats a
provider response as an executable price or a stablecoin as one dollar.
"""
import argparse
import json
from pathlib import Path
import time
from urllib.parse import urlsplit

from catalogue import configured_catalogue
from discovery import DataError, address, json_http
from inventory import inventory_endpoint
from local_config import load_config
from read_service import bounded_transport
from reference_prices import (ALCHEMY_SOURCE, COINGECKO_SOURCE, MAPPINGS, AlchemyCanonicalReference,
                              coingecko_observations, mapping_for, store_reference_observations)

ALCHEMY_PRICES_PATH = 'https://api.g.alchemy.com/prices/v1/{key}/tokens/historical'
MAX_INVOCATION_SECONDS = 120


def alchemy_prices_url(configured_rpc_url):
    parsed = urlsplit(inventory_endpoint(configured_rpc_url))
    return ALCHEMY_PRICES_PATH.format(key=parsed.path.rsplit('/', 1)[1])


def collect(args, *, transport=None, clock=None, emit=True):
    clock = clock or time.time
    mapping = mapping_for(args.currency, provider=args.provider)
    if mapping.provider == 'alchemy':
        config = load_config(args.provider_config) if args.provider_config else load_config()
        url = config.get('rpcUrl')
        if not url:
            raise DataError('configured_rpc_required')
        fetch = AlchemyCanonicalReference(alchemy_prices_url(url),
                                          transport=transport or json_http, clock=clock)
        rows = fetch.fetch(mapping, args.start, args.end)
    else:
        from coingecko_market_reference import CoinGeckoMarketReference
        reference = CoinGeckoMarketReference(transport=transport or json_http,
                                             clock_ms=lambda: int(clock() * 1000))
        payload = reference.history(mapping.currency, currency_decimals=args.decimals)
        rows = coingecko_observations(payload, mapping, retrieved_at=int(clock()))
        rows = [row for row in rows if args.start <= row['timestamp'] <= args.end]
    report = {'schemaVersion': 1, 'mode': 'external_market_reference_collection',
              'chainId': 4663, 'currency': mapping.currency, 'provider': mapping.provider,
              'source': ALCHEMY_SOURCE if mapping.provider == 'alchemy' else COINGECKO_SOURCE,
              'reference': mapping.reference, 'evidence': mapping.evidence,
              'requestedStart': args.start, 'requestedEnd': args.end, 'observations': len(rows),
              'firstTimestamp': rows[0]['timestamp'] if rows else None,
              'lastTimestamp': rows[-1]['timestamp'] if rows else None,
              'maxGapSeconds': max((b['timestamp'] - a['timestamp']
                                    for a, b in zip(rows, rows[1:])), default=None),
              'stored': 0, 'productionQualification': False, 'executionAvailable': False}
    if args.store:
        catalogue = configured_catalogue()
        if catalogue is None:
            raise DataError('catalogue_not_configured')
        report['stored'] = store_reference_observations(catalogue, rows)
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        with args.output.open('x') as stream:
            json.dump(report, stream, indent=2)
            stream.write('\n')
    elif emit:
        print(json.dumps(report))
    return report


def run_every_mapping(args, *, transport=None, clock=None):
    """One bounded pass over every recorded mapping, one outcome per currency.

    A provider refusing one mapping — MARLIN's CoinGecko rate limit is the
    recorded case — is that mapping's own failure and nothing else's; the pass
    continues, the refusal is reported, and the next timer run asks again. The
    budget is the hard stop: mappings not started are reported as skipped, a
    decision point, never retried blindly inside the same run.
    """
    clock = clock or time.time
    opened = clock()
    end = int(opened)
    start = end - args.lookback
    # One mapping's bounded worst case: the provider fetch deadline, the
    # database connect, and one statement_timeout per grid row plus overhead.
    # Reserving it up front means a started mapping finishes inside the budget,
    # so the unit's TimeoutStartSec can never kill a pass mid-store.
    reserved = 12 + (3 + 5 * (args.lookback // 300 + 3) if args.store else 0)
    outcomes, failures = [], 0
    for currency in MAPPINGS:
        if clock() - opened > max(0, args.budget_seconds - reserved):
            outcomes.append({'currency': currency, 'status': 'reference_collection_skipped',
                             'stoppedBecause': 'budget'})
            failures += 1
            continue
        child = argparse.Namespace(currency=currency, provider=None, start=start, end=end,
                                   decimals=MAPPINGS[currency].decimals,
                                   provider_config=args.provider_config,
                                   store=args.store, output=None)
        try:
            report = collect(child, transport=transport, clock=clock, emit=False)
            if report['observations'] == 0:
                # The provider answered and covered nothing of the window; the
                # lane stops advancing, so a green pass must not claim it.
                outcomes.append({'currency': currency,
                                 'status': 'reference_collection_empty',
                                 'observations': 0, 'stored': 0})
                failures += 1
                continue
            outcomes.append({'currency': currency, 'status': 'collected',
                             'observations': report['observations'], 'stored': report['stored'],
                             'firstTimestamp': report['firstTimestamp'],
                             'lastTimestamp': report['lastTimestamp'],
                             'maxGapSeconds': report['maxGapSeconds']})
        except DataError as error:
            outcomes.append({'currency': currency, 'status': 'reference_collection_failed',
                             'reason': str(error)})
            failures += 1
    report = {'schemaVersion': 1, 'mode': 'external_market_reference_collection_run',
              'chainId': 4663, 'requestedStart': start, 'requestedEnd': end,
              'lookbackSeconds': args.lookback, 'budgetSeconds': args.budget_seconds,
              'mappings': outcomes, 'failures': failures,
              'productionQualification': False, 'executionAvailable': False}
    print(json.dumps(report))
    return report, failures


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--currency')
    parser.add_argument('--every-mapping', action='store_true',
                        help='one bounded pass over every recorded mapping (the timer entry point)')
    parser.add_argument('--provider', choices=('alchemy', 'coingecko'))
    parser.add_argument('--start', type=int)
    parser.add_argument('--end', type=int)
    parser.add_argument('--lookback', type=int,
                        help='collect the trailing window ending now, instead of --start/--end')
    parser.add_argument('--budget-seconds', type=int)
    parser.add_argument('--decimals', type=int, help='CoinGecko identity check for a listed token')
    parser.add_argument('--provider-config', type=Path)
    parser.add_argument('--store', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    if args.every_mapping == bool(args.currency):
        parser.error('exactly one of --currency and --every-mapping')
    if args.lookback is not None and (args.start is not None or args.end is not None):
        parser.error('--lookback replaces --start/--end')
    if args.budget_seconds is not None and not args.every_mapping:
        parser.error('--budget-seconds belongs to --every-mapping')
    if args.every_mapping:
        if args.lookback is None:
            parser.error('--every-mapping requires --lookback')
        if not 300 <= args.lookback <= 86_400:
            parser.error('--lookback must cover 300..86400 seconds')
        if args.budget_seconds is None:
            args.budget_seconds = MAX_INVOCATION_SECONDS
        if not 30 <= args.budget_seconds <= 600:
            parser.error('--budget-seconds must cover 30..600 seconds')
        if args.output is not None or args.provider is not None or args.decimals is not None:
            parser.error('--every-mapping takes only --lookback, --budget-seconds, --provider-config and --store')
        _, failures = run_every_mapping(args)
        return 1 if failures else 0
    if args.lookback is not None:
        args.end = int(time.time())
        args.start = args.end - args.lookback
    if args.start is None or args.end is None:
        parser.error('--start/--end (or --lookback) are required with --currency')
    try:
        collect(args)
        return 0
    except DataError as error:
        print(json.dumps({'status': 'reference_collection_failed', 'reason': str(error)}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
