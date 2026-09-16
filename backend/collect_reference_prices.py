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
from reference_prices import (ALCHEMY_SOURCE, COINGECKO_SOURCE, AlchemyCanonicalReference,
                              coingecko_observations, mapping_for, store_reference_observations)

ALCHEMY_PRICES_PATH = 'https://api.g.alchemy.com/prices/v1/{key}/tokens/historical'
MAX_INVOCATION_SECONDS = 120


def alchemy_prices_url(configured_rpc_url):
    parsed = urlsplit(inventory_endpoint(configured_rpc_url))
    return ALCHEMY_PRICES_PATH.format(key=parsed.path.rsplit('/', 1)[1])


def collect(args, *, transport=None, clock=None):
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
    else:
        print(json.dumps(report))
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--currency', required=True)
    parser.add_argument('--provider', choices=('alchemy', 'coingecko'))
    parser.add_argument('--start', required=True, type=int)
    parser.add_argument('--end', required=True, type=int)
    parser.add_argument('--decimals', type=int, help='CoinGecko identity check for a listed token')
    parser.add_argument('--provider-config', type=Path)
    parser.add_argument('--store', action='store_true')
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    try:
        collect(args)
        return 0
    except DataError as error:
        print(json.dumps({'status': 'reference_collection_failed', 'reason': str(error)}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
