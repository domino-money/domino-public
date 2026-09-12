"""Small public GeckoTerminal reads; attributed market data, never LP accounting."""
from decimal import Decimal, InvalidOperation
import math
import re
import time

from discovery import CHAIN_ID, DataError, address, bytes32, json_http
from read_deadline import check_read_deadline, read_timeout

SOURCE = 'geckoterminal'
ROOT = 'https://api.geckoterminal.com/api/v2/networks/robinhood'
PREFIX = 'robinhood_'
MAX_CANDLES = 24
HOUR_SECONDS = 3600


class MarketCandleError(DataError):
    """Bounded local diagnostics; the public cache still emits its finite error.

    No provider values, URLs or exception text are copied into the diagnostic.
    Operators may attach a separately reviewed public sample to a report.
    """
    def __init__(self, reason, *, row_index=None, field=None, code='invalid_market_candles'):
        super().__init__(code)
        self.diagnostic = {'reason': reason, 'rowIndex': row_index, 'field': field}


def _object(value):
    if not isinstance(value, dict):
        raise DataError('invalid_market_response')
    return value


def _number(value, *, optional=False):
    """Exact provider decimals; reject binary floats and bound decimal expansion."""
    if value is None and optional:
        return None
    if type(value) not in (str, int, Decimal):
        raise DataError('invalid_market_number')
    if isinstance(value, str) and not re.fullmatch(r'[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?', value):
        raise DataError('invalid_market_number')
    if len(str(value)) > 128:
        raise DataError('invalid_market_number')
    try:
        number = Decimal(value)
        if (not number.is_finite() or number.is_signed() or number > Decimal('1e60') or
                not -96 <= number.as_tuple().exponent <= 60):
            raise DataError('invalid_market_number')
    except (InvalidOperation, ValueError):
        raise DataError('invalid_market_number') from None
    text = format(number, 'f')
    return text.rstrip('0').rstrip('.') if '.' in text else text


def _currency_relationship(value):
    item = _object(_object(value).get('data'))
    identifier = item.get('id')
    if item.get('type') != 'token' or not isinstance(identifier, str) or not identifier.startswith(PREFIX):
        raise DataError('market_currency_identity_mismatch')
    try:
        return address(identifier[len(PREFIX):])
    except DataError:
        raise DataError('market_currency_identity_mismatch') from None


def _currencies(base, quote):
    try:
        base, quote = address(base), address(quote)
    except DataError:
        raise DataError('market_currency_identity_mismatch') from None
    if base == quote:
        raise DataError('market_currency_identity_mismatch')
    return {'currencies': sorted((base, quote)), 'baseToken': base, 'quoteToken': quote}


def _label(value):
    if value is None:
        return None
    if (not isinstance(value, str) or not 1 <= len(value) <= 128 or
            any(ord(character) < 32 or ord(character) == 127 for character in value)):
        raise DataError('invalid_market_response')
    # This is untrusted display metadata. It does not establish DEX/version/fee.
    return value


class GeckoMarketData:
    def __init__(self, transport=json_http, clock=time.time):
        self.transport, self.clock = transport, clock

    def _now(self):
        value = self.clock()
        if type(value) not in (int, float) or not 0 <= value < 2**63 or not math.isfinite(value):
            raise DataError('invalid_market_clock')
        return int(value)

    def _fetch(self, url):
        check_read_deadline()
        self._now()  # Invalid clocks must not initiate provider work.
        result = self.transport(url, timeout=read_timeout(5))
        check_read_deadline()
        return _object(result), self._now()

    @staticmethod
    def _attribution(pool_id, url, retrieved):
        return {'source': SOURCE, 'chainId': CHAIN_ID, 'retrievedAt': retrieved,
                'asOfTimestamp': None, 'asOfBlock': None, 'poolId': pool_id,
                'sourceUrl': url, 'providerReported': True}

    def pool(self, pool_id):
        pool_id = bytes32(pool_id)
        url = ROOT+'/pools/'+pool_id
        result, retrieved = self._fetch(url)
        data = _object(result.get('data'))
        attributes = _object(data.get('attributes'))
        try:
            identifier = data.get('id')
            if (data.get('type') != 'pool' or not isinstance(identifier, str) or
                    not identifier.startswith(PREFIX) or bytes32(identifier[len(PREFIX):]) != pool_id or
                    bytes32(attributes.get('address')) != pool_id):
                raise DataError('market_pool_identity_mismatch')
        except DataError:
            raise DataError('market_pool_identity_mismatch') from None
        relationships = _object(data.get('relationships'))
        currencies = _currencies(_currency_relationship(relationships.get('base_token')),
                                 _currency_relationship(relationships.get('quote_token')))
        dex = relationships.get('dex')
        label = None
        if dex is not None:
            item = _object(_object(dex).get('data'))
            if item.get('type') != 'dex':
                raise DataError('invalid_market_response')
            label = _label(item.get('id'))
        volume = attributes.get('volume_usd')
        if volume is not None:
            volume = _object(volume).get('h24')
        return {**self._attribution(pool_id, url, retrieved), **currencies, 'dexLabel': label,
                'reportedLiquidityUsd': _number(attributes.get('reserve_in_usd'), optional=True),
                'volume24hUsd': _number(volume, optional=True)}

    def hourly_prices(self, pool_id, *, currency, token='base'):
        pool_id = bytes32(pool_id)
        if token not in ('base', 'quote'):
            raise DataError('invalid_market_price_token')
        currency = address(currency)
        # Resolve the role using the already qualified pool observation, before
        # making this call. Gecko's OHLCV metadata puts the selected token in
        # base, including when the pool endpoint calls that token quote.
        url = ROOT+'/pools/'+pool_id+'/ohlcv/hour?aggregate=1&limit=24&currency=usd&token='+currency
        result, retrieved = self._fetch(url)
        data = _object(result.get('data'))
        if data.get('type') != 'ohlcv_request_response':
            raise DataError('invalid_market_response')
        metadata = _object(result.get('meta'))
        currencies = _currencies(_object(metadata.get('base')).get('address'),
                                 _object(metadata.get('quote')).get('address'))
        if currencies['baseToken'] != currency:
            raise DataError('market_chart_currency_mismatch')
        # Preserve v1's pool-relative role names. Only metadata labels move;
        # no price, volume, timestamp or gap is inverted or synthesized.
        if token == 'quote':
            currencies = _currencies(currencies['quoteToken'], currency)
        raw = _object(data.get('attributes')).get('ohlcv_list')
        if not isinstance(raw, list):
            raise MarketCandleError('invalid_list')
        if len(raw) > MAX_CANDLES:
            raise MarketCandleError('too_many_candles')
        candles, seen = [], set()
        for row_index, entry in enumerate(raw):
            if not isinstance(entry, list) or len(entry) != 6:
                raise MarketCandleError('invalid_row', row_index=row_index)
            start = entry[0]
            if type(start) is not int or start < 0:
                raise MarketCandleError('invalid_timestamp', row_index=row_index, field='timestamp')
            if start > retrieved:
                raise MarketCandleError('future_timestamp', row_index=row_index, field='timestamp')
            if start % HOUR_SECONDS:
                raise MarketCandleError('unaligned_timestamp', row_index=row_index, field='timestamp')
            if start in seen:
                raise MarketCandleError('duplicate_timestamp', row_index=row_index, field='timestamp')
            seen.add(start)
            numbers = []
            for field, value in zip(('open', 'high', 'low', 'close', 'volume'), entry[1:]):
                try:
                    numbers.append(_number(value))
                except DataError:
                    raise MarketCandleError('invalid_number', row_index=row_index, field=field,
                                            code='invalid_market_number') from None
            opened, high, low, closed, volume = numbers
            if Decimal(low) > Decimal(high):
                raise MarketCandleError('low_above_high', row_index=row_index)
            if not Decimal(low) <= Decimal(opened) <= Decimal(high):
                raise MarketCandleError('open_outside_range', row_index=row_index, field='open')
            if not Decimal(low) <= Decimal(closed) <= Decimal(high):
                raise MarketCandleError('close_outside_range', row_index=row_index, field='close')
            candles.append({'startTimestamp': start, 'openUsd': opened, 'highUsd': high, 'lowUsd': low,
                            'closeUsd': closed, 'volumeUsd': volume, 'closed': start+HOUR_SECONDS <= retrieved})
        candles.sort(key=lambda item: item['startTimestamp'])
        gaps = any(b['startTimestamp']-a['startTimestamp'] != HOUR_SECONDS for a, b in zip(candles, candles[1:]))
        return {**self._attribution(pool_id, url, retrieved), **currencies, 'fetchedAt': retrieved,
                'selectedToken': token, 'currency': currencies[token+'Token'], 'quoteCurrency': 'usd',
                'intervalSeconds': HOUR_SECONDS, 'candles': candles,
                'coverage': {'status': 'provider_reported' if candles else 'missing',
                             'requestedLimit': MAX_CANDLES, 'returnedCandles': len(candles),
                             'closedCandles': sum(c['closed'] for c in candles), 'gapsDetected': gaps,
                             'firstTimestamp': candles[0]['startTimestamp'] if candles else None,
                             'lastTimestamp': candles[-1]['startTimestamp'] if candles else None,
                             'complete24h': False, 'completeness': 'not_established'}}
