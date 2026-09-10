"""Address-bound external observations. Provider data is not automatically an oracle."""
from bisect import bisect_right
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, localcontext
from fractions import Fraction
import re
import time
from urllib.parse import urlsplit

from psycopg.types.json import Jsonb

from discovery import CHAIN_ID, ZERO, DataError, address, bytes32, decimal_metric, json_http
from inventory import inventory_endpoint

SOURCE = 'alchemy_historical'
CHAINLINK_SOURCE = 'chainlink_robinhood_standard_v1'
OBSERVATION_SOURCES = (SOURCE, CHAINLINK_SOURCE)
INTERVAL_SECONDS = 300
MAX_PRICE_ROWS = 600


def usd(value):
    # Decimal strings only: never convert a provider float into financial arithmetic.
    if not isinstance(value, str) or len(value) > 128 or not re.fullmatch(r'[0-9]+(?:\.[0-9]+)?', value):
        raise DataError('invalid_usd_price')
    result = decimal_metric(value)
    if result is None or Decimal(result) <= 0:
        raise DataError('invalid_usd_price')
    return Fraction(result)


def decimal_string(value, places=18):
    value = Fraction(value)
    with localcontext() as context:
        context.prec = 400
        result = Decimal(value.numerator)/Decimal(value.denominator)
        result = result.quantize(Decimal(1).scaleb(-places))
        return format(result, 'f')


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace('+00:00', 'Z')


def timestamp(value):
    if not isinstance(value, str) or len(value) > 40:
        raise DataError('invalid_price_timestamp')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.utcoffset() is None or parsed.microsecond:
            raise ValueError()
        result = int(parsed.timestamp())
        if not 0 <= result <= 2**63-1:
            raise ValueError()
        return result
    except (ValueError, OverflowError, OSError):
        raise DataError('invalid_price_timestamp') from None


class AlchemyHistorical:
    def __init__(self, configured_rpc_url, *, transport=json_http, clock=time.time):
        parsed = urlsplit(inventory_endpoint(configured_rpc_url))
        self.url = 'https://api.g.alchemy.com/prices/v1/'+parsed.path.rsplit('/', 1)[1]+'/tokens/historical'
        self.transport, self.clock = transport, clock

    def fetch(self, currency, start, end):
        currency = address(currency)
        now = int(self.clock())
        if (type(start) is not int or type(end) is not int or
                not 0 <= start < end <= now or end-start > 86400+600):
            raise DataError('invalid_price_history_bounds')
        identity = ({'symbol': 'ETH'} if currency == ZERO else
                    {'network': 'robinhood-mainnet', 'address': currency})
        result = self.transport(self.url, {**identity, 'startTime': iso(start), 'endTime': iso(end), 'interval': '5m'})
        if not isinstance(result, dict) or result.get('currency') != 'usd':
            raise DataError('price_response_currency_mismatch')
        if any(result.get(k) != v for k, v in identity.items()):
            raise DataError('price_response_asset_mismatch')
        data = result.get('data')
        if not isinstance(data, list) or len(data) > MAX_PRICE_ROWS:
            raise DataError('invalid_price_history_response')
        rows = {}
        for entry in data:
            if not isinstance(entry, dict):
                raise DataError('invalid_price_history_response')
            at = timestamp(entry.get('timestamp'))
            if not start <= at <= end:
                raise DataError('price_outside_requested_window')
            value = entry.get('value');usd(value)
            if at in rows and rows[at]['priceUsd'] != value:
                raise DataError('conflicting_price_observation')
            rows[at] = {'chainId': CHAIN_ID, 'currency': currency, 'source': SOURCE,
                'timestamp': at, 'retrievedAt': now, 'priceUsd': value,
                'provenance': {'provider': 'alchemy', 'requestIdentity': identity, 'intervalSeconds': INTERVAL_SECONDS,
                    'status': 'external_observation_unqualified', 'targetPoolIndependenceVerified': False,
                    'nativeEthMapping': currency == ZERO, 'pointTimestampSemanticsQualified': False}}
        return list(rows[k] for k in sorted(rows))


def store_observations(catalogue, rows):
    if not isinstance(rows, list) or len(rows) > MAX_PRICE_ROWS:
        raise DataError('price_observation_budget_exhausted')
    with catalogue.connection(writer=True, lock=True) as conn:
        for row in rows:
            if (not isinstance(row, dict) or type(row.get('chainId')) is not int or
                    row['chainId'] != CHAIN_ID or row.get('source') not in OBSERVATION_SOURCES or
                    type(row.get('timestamp')) is not int or type(row.get('retrievedAt')) is not int or
                    not 0 <= row['timestamp'] <= row['retrievedAt'] < 2**63 or
                    not isinstance(row.get('provenance'), dict) or
                    row['provenance'].get('status') != 'external_observation_unqualified'):
                raise DataError('invalid_price_observation')
            currency = address(row.get('currency'));usd(row.get('priceUsd'))
            source = row['source']
            if source == CHAINLINK_SOURCE:
                # Source evidence is validated independently of an observation's
                # flags. Storing it does not create a production qualification.
                from chainlink_reference import validate_observation
                validate_observation(row)
            previous = conn.execute('''SELECT price_usd,provenance FROM domino_activity.price_observations
              WHERE chain_id=%s AND currency=%s AND source=%s AND observed_at=%s''',
              (CHAIN_ID, currency, source, row['timestamp'])).fetchone()
            if previous:
                if usd(previous['price_usd']) != usd(row['priceUsd']) or previous['provenance'] != row['provenance']:
                    raise DataError('stored_price_revision_requires_review')
                continue
            conn.execute('INSERT INTO domino_activity.price_observations VALUES(%s,%s,%s,%s,%s,%s,%s)',
                (CHAIN_ID, currency, source, row['timestamp'], row['retrievedAt'], row['priceUsd'], Jsonb(row['provenance'])))


@dataclass(frozen=True)
class PriceQualification:
    """Code/operator-owned evidence; never accepted from HTTP or an observation JSON flag.

    An adapter must establish point-in-time semantics, address identity/decimals and
    independence from the target pool before adding a production qualification.
    """
    currency: str
    decimals: int
    source: str
    target_pool: str
    evidence: str
    max_age: int = 300

    def __post_init__(self):
        address(self.currency);bytes32(self.target_pool)
        if (type(self.decimals) is not int or not 0 <= self.decimals <= 255 or
                not self.evidence or not self.source or type(self.max_age) is not int or not 1 <= self.max_age <= 300):
            raise DataError('invalid_price_qualification')


# No external source has yet qualified Robinhood token history, independent market
# composition and bucket timestamp semantics. Observations cannot add entries here.
PRODUCTION_QUALIFICATIONS = {}


class PriceSeries:
    def __init__(self, qualification, observations):
        self.qualification = qualification
        self.rows = []
        if len(observations) > MAX_PRICE_ROWS:
            raise DataError('price_observation_budget_exhausted')
        seen = {}
        for row in observations:
            if (row.get('chainId') != CHAIN_ID or address(row.get('currency')) != qualification.currency or
                    row.get('source') != qualification.source or type(row.get('timestamp')) is not int or
                    row['timestamp'] < 0 or type(row.get('retrievedAt')) is not int or
                    row['timestamp'] > row['retrievedAt']):
                raise DataError('qualified_price_identity_mismatch')
            value = usd(row['priceUsd']);at = row['timestamp']
            if at in seen and seen[at] != value:
                raise DataError('conflicting_price_observation')
            seen[at] = value
        self.times = sorted(seen)
        self.values = [seen[t] for t in self.times]

    def at(self, at):
        index = bisect_right(self.times, at)-1
        if index < 0 or at-self.times[index] > self.qualification.max_age:
            raise DataError('qualified_price_coverage_gap')
        return self.values[index]

    def value(self, raw, at):
        return Fraction(int(raw), 10**self.qualification.decimals)*self.at(at)

    def boundaries(self, start, end):
        # A stale gap ends at max_age. No backwards interpolation or future-price fill.
        return {t for at in self.times for t in (at, at+self.qualification.max_age) if start < t < end}

    def require_coverage(self, start, end):
        """Check both endpoints and every interval between updates/expiry boundaries."""
        if type(start) is not int or type(end) is not int or not 0 <= start <= end:
            raise DataError('invalid_price_history_bounds')
        self.at(start);self.at(end)
        bounds = sorted({start, end} | self.boundaries(start, end))
        for a, b in zip(bounds, bounds[1:]):
            self.at(Fraction(a+b, 2))


def load_price_series(conn, pool_id, currencies, start, end):
    series, evidence = [], []
    for currency in currencies:
        qualification = PRODUCTION_QUALIFICATIONS.get((pool_id, currency))
        sources = [qualification.source] if qualification else list(OBSERVATION_SOURCES)
        lookback = qualification.max_age if qualification else 300
        rows = conn.execute('''SELECT chain_id AS "chainId",currency,source,observed_at AS timestamp,
          retrieved_at AS "retrievedAt",price_usd AS "priceUsd",provenance FROM domino_activity.price_observations
          WHERE chain_id=%s AND currency=%s AND source=ANY(%s)
          AND observed_at>=%s AND observed_at<=%s ORDER BY observed_at,source LIMIT 601''',
          (CHAIN_ID, currency, sources, max(0, start-lookback), end)).fetchall()
        if len(rows) > MAX_PRICE_ROWS:
            raise DataError('price_observation_budget_exhausted')
        # Multiple candidates may be counted for diagnostics. Their values are
        # never combined: constructing a series requires one code-owned source.
        price_series = PriceSeries(qualification, rows) if qualification else None
        status = 'observed_unqualified' if rows else 'unavailable'
        reason = 'price_source_quality_not_qualified' if rows else 'price_history_missing'
        coverage = 'not_assessed' if rows else 'missing'
        if price_series is not None:
            try:
                price_series.require_coverage(start, end)
            except DataError as error:
                if str(error) != 'qualified_price_coverage_gap':
                    raise
                status = 'unavailable'
                reason = 'qualified_price_coverage_gap' if rows else 'price_history_missing'
                coverage = 'incomplete' if rows else 'missing'
            else:
                status, reason, coverage = 'qualified', None, 'complete'
        evidence.append({'currency': currency, 'observations': len(rows),
            'observedSources': sorted({row['source'] for row in rows}),
            'firstTimestamp': rows[0]['timestamp'] if rows else None,
            'lastTimestamp': rows[-1]['timestamp'] if rows else None,
            'status': status, 'reason': reason,
            'sourceQualification': 'qualified' if qualification else 'unqualified',
            'coverage': {'status': coverage, 'startTimestamp': start, 'endTimestamp': end,
                         'maxAgeSeconds': qualification.max_age if qualification else None}})
        series.append(price_series)
    return series, evidence
