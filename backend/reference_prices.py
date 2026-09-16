"""Explicitly mapped external market references, stored as unqualified evidence.

The strict production rule (`price_history.PRODUCTION_QUALIFICATIONS`) stays
empty: no source has qualified Robinhood token history, independent market
composition and bucket timestamp semantics. What this module adds is the other
half of the recorded decision — a *labelled* reference path, with the mapping
that makes the identity checkable, stored under its own source names.

A reference proves what the provider returned for one mapped asset. It never
claims a first publication time, an executable price, or that a stablecoin is
one dollar.
"""
from dataclasses import dataclass
import time

from discovery import CHAIN_ID, DataError, address, json_http
from price_history import MAX_PRICE_ROWS, MAX_PRICE_WINDOW_SECONDS, iso, timestamp, usd

ALCHEMY_SOURCE = 'alchemy_canonical_market_reference_v1'
COINGECKO_SOURCE = 'coingecko_market_chart_reference_v1'
REFERENCE_SOURCES = (ALCHEMY_SOURCE, COINGECKO_SOURCE)
STATUS = 'external_market_reference_unqualified'
MAPPING_VERSION = 1
INTERVAL_SECONDS = 300
MAX_REFERENCE_AGE_SECONDS = 300
MAX_REFERENCE_ROWS = MAX_PRICE_ROWS


@dataclass(frozen=True)
class CanonicalMapping:
    """One Robinhood currency and the reference that stands for it.

    `reference` is what the provider must echo back: an Ethereum mainnet
    address for Alchemy, a listed coin id for CoinGecko. `evidence` names the
    probe that established the mapping.
    """

    currency: str
    reference: dict
    evidence: str
    provider: str

    def __post_init__(self):
        address(self.currency)
        if self.provider not in ('alchemy', 'coingecko'):
            raise DataError('invalid_reference_provider')
        if not isinstance(self.evidence, str) or not 1 <= len(self.evidence) <= 300:
            raise DataError('invalid_reference_evidence')
        reference = self.reference
        if not isinstance(reference, dict):
            raise DataError('invalid_reference_identity')
        if self.provider == 'alchemy':
            if set(reference) != {'kind', 'network', 'address'} or \
                    reference['kind'] != 'canonical_ethereum_address' or \
                    reference['network'] != 'eth-mainnet':
                raise DataError('invalid_reference_identity')
            address(reference['address'])
        elif set(reference) != {'kind', 'coinId'} or reference['kind'] != 'coingecko_coin_id':
            raise DataError('invalid_reference_identity')
        elif not isinstance(reference['coinId'], str) or not reference['coinId']:
            raise DataError('invalid_reference_identity')


# The two mappings the 13 September probes verified, recorded with their evidence.
MAPPINGS = {
    '0x0bd7d308f8e1639fab988df18a8011f41eacad73': CanonicalMapping(
        currency='0x0bd7d308f8e1639fab988df18a8011f41eacad73',
        provider='alchemy',
        reference={'kind': 'canonical_ethereum_address', 'network': 'eth-mainnet',
                   'address': '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'},
        evidence='reports/price-source-candidates-2026-09-13.json canonical WETH probe'),
    '0x5fc5360d0400a0fd4f2af552add042d716f1d168': CanonicalMapping(
        currency='0x5fc5360d0400a0fd4f2af552add042d716f1d168',
        provider='alchemy',
        reference={'kind': 'canonical_ethereum_address', 'network': 'eth-mainnet',
                   'address': '0xe343167631d89b6ffc58b88d6b7fb0228795491d'},
        evidence='reports/price-source-candidates-2026-09-13.json canonical USDG probe'),
    '0xab35d04e1ee39c789c4a65d522417b3c7f2e4723': CanonicalMapping(
        currency='0xab35d04e1ee39c789c4a65d522417b3c7f2e4723',
        provider='coingecko',
        reference={'kind': 'coingecko_coin_id', 'coinId': 'jt-marlin'},
        evidence='reports/price-source-candidates-2026-09-13.json MARLIN address mapping'),
}


def mapping_for(currency, *, provider=None):
    currency = address(currency)
    mapping = MAPPINGS.get(currency)
    if mapping is None:
        raise DataError('reference_mapping_required')
    if provider is not None and mapping.provider != provider:
        raise DataError('reference_provider_not_mapped')
    return mapping


def provenance(mapping):
    return {'provider': mapping.provider, 'status': STATUS, 'mappingVersion': MAPPING_VERSION,
            'intervalSeconds': INTERVAL_SECONDS, 'robinhoodCurrency': mapping.currency,
            'reference': dict(mapping.reference), 'evidence': mapping.evidence,
            'pointTimestampSemanticsQualified': False, 'targetPoolIndependenceVerified': False}


class AlchemyCanonicalReference:
    """Prices API for an explicitly mapped Ethereum address.

    The response must echo the requested network and address; a symbol match is
    never accepted as identity.
    """

    def __init__(self, prices_api_url, *, transport=json_http, clock=time.time):
        if not isinstance(prices_api_url, str) or 'api.g.alchemy.com/prices/' not in prices_api_url:
            raise DataError('invalid_alchemy_prices_endpoint')
        self.url, self.transport, self.clock = prices_api_url, transport, clock

    def fetch(self, mapping, start, end):
        now = int(self.clock())
        if (type(start) is not int or type(end) is not int or not 0 <= start < end <= now
                or end - start > MAX_PRICE_WINDOW_SECONDS + MAX_REFERENCE_AGE_SECONDS):
            raise DataError('invalid_price_history_bounds')
        identity = {key: mapping.reference[key] for key in ('network', 'address')}
        result = self.transport(self.url, {**identity, 'startTime': iso(start), 'endTime': iso(end),
                                           'interval': '5m'})
        if not isinstance(result, dict) or result.get('currency') != 'usd':
            raise DataError('price_response_currency_mismatch')
        if any(result.get(key) != value for key, value in identity.items()):
            raise DataError('price_response_asset_mismatch')
        data = result.get('data')
        if not isinstance(data, list) or len(data) > MAX_REFERENCE_ROWS:
            raise DataError('price_observation_budget_exhausted')
        rows = {}
        for entry in data:
            if not isinstance(entry, dict):
                raise DataError('invalid_price_history_response')
            at = timestamp(entry.get('timestamp'))
            if not start <= at <= end:
                raise DataError('price_outside_requested_window')
            value = entry.get('value')
            usd(value)
            if at in rows and rows[at]['priceUsd'] != value:
                raise DataError('conflicting_price_observation')
            rows[at] = {'chainId': CHAIN_ID, 'currency': mapping.currency, 'source': ALCHEMY_SOURCE,
                        'timestamp': at, 'retrievedAt': now, 'priceUsd': value,
                        'provenance': provenance(mapping)}
        return [rows[key] for key in sorted(rows)]


def coingecko_observations(reference, mapping, *, retrieved_at):
    """Turn a CoinGecko chart reference into rows, preserving its own timestamps.

    The reference carries provider milliseconds; a point becomes an observation
    only when it maps to a whole second, so nothing is rounded into a value the
    provider did not publish.
    """
    if not isinstance(reference, dict) or reference.get('source') != COINGECKO_SOURCE:
        raise DataError('invalid_reference_payload')
    identity = reference.get('identity')
    if not isinstance(identity, dict) or address(identity.get('currency')) != mapping.currency:
        raise DataError('reference_currency_mismatch')
    if identity.get('coinId') != mapping.reference['coinId']:
        # The listed coin the provider matched must be the mapped one.
        raise DataError('reference_coin_mismatch')
    points = reference.get('points')
    if not isinstance(points, list) or not 1 <= len(points) <= MAX_REFERENCE_ROWS:
        raise DataError('price_observation_budget_exhausted')
    rows = {}
    for point in points:
        if not isinstance(point, dict) or set(point) != {'timestampMs', 'priceUsd'}:
            raise DataError('invalid_reference_payload')
        milliseconds = point['timestampMs']
        if type(milliseconds) is not int or milliseconds % 1000 or milliseconds < 0:
            raise DataError('invalid_reference_timestamp')
        at = milliseconds // 1000
        usd(point['priceUsd'])
        if at in rows and rows[at]['priceUsd'] != point['priceUsd']:
            raise DataError('conflicting_price_observation')
        rows[at] = {'chainId': CHAIN_ID, 'currency': mapping.currency, 'source': COINGECKO_SOURCE,
                    'timestamp': at, 'retrievedAt': retrieved_at, 'priceUsd': point['priceUsd'],
                    'provenance': provenance(mapping)}
    return [rows[key] for key in sorted(rows)]


def store_reference_observations(catalogue, rows, *, before_commit=None):
    """Insert validated reference rows; the caller owns the transaction guard."""
    if not isinstance(rows, list) or len(rows) > MAX_REFERENCE_ROWS:
        raise DataError('price_observation_budget_exhausted')
    # Validate everything before the database is touched: a rejected row must not
    # open a writer transaction.
    for row in rows:
        if (not isinstance(row, dict) or row.get('chainId') != CHAIN_ID
                or row.get('source') not in REFERENCE_SOURCES
                or type(row.get('timestamp')) is not int or type(row.get('retrievedAt')) is not int
                or not 0 <= row['timestamp'] <= row['retrievedAt'] < 2**63
                or not isinstance(row.get('provenance'), dict)
                or row['provenance'].get('status') != STATUS
                or row['provenance'].get('robinhoodCurrency') != row.get('currency')):
            raise DataError('invalid_reference_observation')
        address(row.get('currency'))
        usd(row.get('priceUsd'))
    from psycopg.types.json import Jsonb
    with catalogue.connection(writer=True, lock=True) as conn:
        for row in rows:
            conn.execute('''INSERT INTO domino_activity.price_observations
              VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(chain_id,currency,source,observed_at)
              DO UPDATE SET price_usd=EXCLUDED.price_usd,retrieved_at=EXCLUDED.retrieved_at,
              provenance=EXCLUDED.provenance WHERE domino_activity.price_observations.price_usd
              IS DISTINCT FROM EXCLUDED.price_usd''',
              (CHAIN_ID, row['currency'], row['source'], row['timestamp'], row['retrievedAt'],
               row['priceUsd'], Jsonb(row['provenance'])))
        if before_commit is not None:
            before_commit(conn)
        return len(rows)
