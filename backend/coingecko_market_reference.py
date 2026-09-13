"""Bounded CoinGecko chart references, separate from the valuation engine.

Currency identity is a provider chain/address mapping, checked against explicit
token decimals. Chart timestamps and target-pool independence are unqualified;
sampling diagnostics never establish causal coverage for fees or capital.
"""
from decimal import Decimal, InvalidOperation
import re
import time

from discovery import CHAIN_ID, ZERO, DataError, address, json_http
from read_deadline import read_deadline


ROOT = 'https://api.coingecko.com/api/v3'
PLATFORM = 'robinhood'
SOURCE = 'coingecko_market_chart_reference_v1'
DAY_MS = 86_400_000
MAX_POINTS = 1_000
SAMPLE_CADENCE_MS = 300_000
MAX_FETCH_MS = 12_000
MAX_TIMESTAMP_MS = 253_402_300_799_999


def _milliseconds(value):
    if type(value) is not int or not DAY_MS <= value <= MAX_TIMESTAMP_MS:
        raise DataError('invalid_coingecko_timestamp')
    return value


def _currency(value, decimals):
    currency = address(value)
    if currency == ZERO or type(decimals) is not int or not 0 <= decimals <= 255:
        raise DataError('invalid_coingecko_currency')
    return currency


def _coin_id(value):
    if (not isinstance(value, str) or not 1 <= len(value) <= 128
            or re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', value) is None):
        raise DataError('invalid_coingecko_coin_id')
    return value


def _price(value):
    # json_http uses parse_float=Decimal. A float supplied by another loader has
    # already lost the provider's decimal representation and cannot be repaired.
    if type(value) not in (Decimal, int, str):
        raise DataError('invalid_coingecko_price')
    if isinstance(value, str) and (len(value) > 128 or re.fullmatch(
            r'(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?', value) is None):
        raise DataError('invalid_coingecko_price')
    try:
        number = Decimal(value)
        if (not number.is_finite() or number <= 0
                or len(number.as_tuple().digits) > 78
                or not -78 <= number.as_tuple().exponent <= 78
                or not Decimal('1e-78') <= number <= Decimal('1e78')):
            raise DataError('invalid_coingecko_price')
    except (InvalidOperation, ValueError, OverflowError):
        raise DataError('invalid_coingecko_price') from None
    text = format(number, 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text


def validate_identity(payload, *, currency, currency_decimals):
    """Verify the two provider address mappings; ignore symbols and other text."""
    currency = _currency(currency, currency_decimals)
    if not isinstance(payload, dict):
        raise DataError('coingecko_currency_identity_mismatch')
    coin_id = _coin_id(payload.get('id'))
    platforms = payload.get('platforms')
    details = payload.get('detail_platforms')
    if not isinstance(platforms, dict) or not isinstance(details, dict):
        raise DataError('coingecko_currency_identity_mismatch')
    detail = details.get(PLATFORM)
    if not isinstance(detail, dict):
        raise DataError('coingecko_currency_identity_mismatch')
    try:
        mapped = address(platforms.get(PLATFORM))
        detailed = address(detail.get('contract_address'))
    except DataError:
        raise DataError('coingecko_currency_identity_mismatch') from None
    decimals = detail.get('decimal_place')
    if (mapped != currency or detailed != currency or type(decimals) is not int
            or decimals != currency_decimals):
        raise DataError('coingecko_currency_identity_mismatch')
    return {'coinId': coin_id, 'chainId': CHAIN_ID, 'platform': PLATFORM,
            'currency': currency, 'currencyDecimals': currency_decimals,
            'status': 'provider_chain_address_mapping_only'}


def reference_from_payloads(metadata, chart, *, currency, currency_decimals,
                            requested_at_ms, retrieved_at_ms):
    """Parse an explicit one-day request context without granting qualification.

Retain exact millisecond labels. Do not round, interpolate, forward-fill, infer
a candle boundary, or convert these labels into event-publication timestamps.
"""
    identity = validate_identity(metadata, currency=currency, currency_decimals=currency_decimals)
    requested = _milliseconds(requested_at_ms)
    retrieved = _milliseconds(retrieved_at_ms)
    if not requested <= retrieved <= requested + MAX_FETCH_MS:
        raise DataError('invalid_coingecko_request_window')
    start = requested - DAY_MS
    if not isinstance(chart, dict):
        raise DataError('invalid_coingecko_chart')
    rows = chart.get('prices')
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_POINTS:
        raise DataError('invalid_coingecko_chart')
    by_timestamp = {}
    for row in rows:
        if not isinstance(row, list) or len(row) != 2:
            raise DataError('invalid_coingecko_chart')
        timestamp = _milliseconds(row[0])
        if not start <= timestamp <= retrieved:
            raise DataError('coingecko_point_outside_request_window')
        price = _price(row[1])
        if timestamp in by_timestamp and by_timestamp[timestamp] != price:
            raise DataError('coingecko_price_revision_conflict')
        by_timestamp[timestamp] = price
    times = sorted(by_timestamp)
    gaps = [b-a for a, b in zip(times, times[1:])]
    return {
        'schemaVersion': 1, 'source': SOURCE, 'provider': 'coingecko',
        'mode': 'provider_reference_only', 'status': 'unqualified',
        'identity': identity, 'requestedAtMs': requested, 'retrievedAtMs': retrieved,
        'request': {'days': 1, 'vsCurrency': 'usd', 'coinId': identity['coinId']},
        'points': [{'timestampMs': at, 'priceUsd': by_timestamp[at]} for at in times],
        'diagnostics': {
            'scope': 'provider_sample_labels_only', 'requestedStartMs': start,
            'requestedEndMs': requested, 'inputPointCount': len(rows),
            'pointCount': len(times), 'duplicatePointCount': len(rows)-len(times),
            'firstPointMs': times[0], 'lastPointMs': times[-1],
            'firstPointOffsetFromRequestedStartMs': times[0]-start,
            'lastPointOffsetFromRequestedEndMs': times[-1]-requested,
            'sampleSpanMs': times[-1]-times[0], 'cadenceThresholdMs': SAMPLE_CADENCE_MS,
            'maxGapMs': max(gaps) if gaps else None,
            'gapsAboveCadenceThreshold': sum(gap > SAMPLE_CADENCE_MS for gap in gaps),
            'canonicalEventTimeCoverage': 'unqualified',
        },
        'provenance': {
            'chartIdentity': 'bound_to_validated_coin_id_request',
            'timestampSemantics': 'provider_chart_timestamp_unqualified',
            'targetPoolIndependence': 'unqualified',
            'onchainCurrencyIdentityVerified': False,
            'providerPublicationTimeVerified': False,
            'interpolationApplied': False, 'stablecoinParityAssumed': False,
        },
        'executionAvailable': False,
    }


class CoinGeckoMarketReference:
    """Two fixed-host public requests; no keys, retries, cache or source switching."""

    def __init__(self, *, transport=json_http, clock_ms=None):
        self.transport = transport
        self.clock_ms = clock_ms or (lambda: time.time_ns() // 1_000_000)

    def _get(self, url):
        try:
            return self.transport(url, timeout=5)
        except Exception:
            # Injected transports must not escape with provider text either.
            raise DataError('coingecko_provider_unavailable') from None

    def history(self, currency, *, currency_decimals):
        currency = _currency(currency, currency_decimals)
        with read_deadline(MAX_FETCH_MS / 1000):
            metadata = self._get(f'{ROOT}/coins/{PLATFORM}/contract/{currency}')
            identity = validate_identity(metadata, currency=currency, currency_decimals=currency_decimals)
            requested = _milliseconds(self.clock_ms())
            chart = self._get(f'{ROOT}/coins/{identity["coinId"]}/market_chart?vs_currency=usd&days=1')
            retrieved = _milliseconds(self.clock_ms())
        return reference_from_payloads(metadata, chart, currency=currency,
            currency_decimals=currency_decimals, requested_at_ms=requested, retrieved_at_ms=retrieved)
