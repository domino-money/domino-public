"""GeckoTerminal pool listings for the daily featured-pools selection.

A listing item is the same JSON:API pool object `/pools/{id}` returns, so each
one becomes exactly the observation `GeckoMarketData.pool` builds, with the
same identity checks, plus the listing-only fields the selection rules read.
Nothing here is published: every figure a visitor sees still comes from the
collector. `market_data.py` is hashed by the read contracts, so its helpers are
imported rather than moved.
"""
from datetime import datetime, timezone
import math
import re
import time

from discovery import CHAIN_ID, DataError, bytes32, json_http
from market_data import (PREFIX, ROOT, SOURCE, _currencies, _currency_relationship,
                         _label, _number, _object)
from read_deadline import check_read_deadline, read_timeout

DEX = 'uniswap-v4-robinhood'
# GeckoTerminal serves twenty pools a page and at most ten pages of a listing.
PAGE_SIZE = 20
MAX_PAGES = 10
# Addresses one /pools/multi call accepts.
MAX_MULTI = 30
MAX_COUNT = 2**53 - 1
TIMESTAMP = re.compile(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z')


def listing_url(page):
    if type(page) is not int or not 1 <= page <= MAX_PAGES:
        raise DataError('invalid_listing_page')
    return f'{ROOT}/dexes/{DEX}/pools?sort=h24_volume_usd_desc&page={page}'


def multi_url(pool_ids):
    ids = sorted({bytes32(pool_id) for pool_id in pool_ids})
    if not 1 <= len(ids) <= MAX_MULTI:
        raise DataError('invalid_listing_request')
    return f'{ROOT}/pools/multi/{",".join(ids)}'


def _signed(value):
    """An exact provider decimal that may be negative (price changes are)."""
    if value is None:
        return None
    if isinstance(value, str) and value.startswith('-'):
        magnitude = _number(value[1:])
        return magnitude if magnitude == '0' else '-' + magnitude
    return _number(value)


def _count(value):
    if type(value) is not int or not 0 <= value <= MAX_COUNT:
        raise DataError('invalid_market_number')
    return value


def _transactions(value):
    if value is None:
        return None
    day = _object(value).get('h24')
    if day is None:
        return None
    day = _object(day)
    return {name: _count(day.get(name)) for name in ('buys', 'sells', 'buyers', 'sellers')}


def _timestamp(value):
    if value is None:
        return None
    match = TIMESTAMP.fullmatch(value) if isinstance(value, str) else None
    if match is None:
        raise DataError('invalid_market_timestamp')
    try:
        moment = datetime(*map(int, match.groups()), tzinfo=timezone.utc)
    except ValueError:
        raise DataError('invalid_market_timestamp') from None
    return int(moment.timestamp())


def pool_item(item, *, url, retrieved):
    """One listing item as {poolId, market, listing}; a fixed DataError code otherwise.

    `market` is field for field what `GeckoMarketData.pool` returns for the
    same object, except `sourceUrl`, which names the call it came from.
    """
    data = _object(item)
    attributes = _object(data.get('attributes'))
    try:
        identifier = data.get('id')
        if data.get('type') != 'pool' or not isinstance(identifier, str) or not identifier.startswith(PREFIX):
            raise DataError('market_pool_identity_mismatch')
        pool_id = bytes32(identifier[len(PREFIX):])
        if bytes32(attributes.get('address')) != pool_id:
            raise DataError('market_pool_identity_mismatch')
    except DataError:
        raise DataError('market_pool_identity_mismatch') from None
    relationships = _object(data.get('relationships'))
    currencies = _currencies(_currency_relationship(relationships.get('base_token')),
                             _currency_relationship(relationships.get('quote_token')))
    dex = relationships.get('dex')
    label = None
    if dex is not None:
        entry = _object(_object(dex).get('data'))
        if entry.get('type') != 'dex':
            raise DataError('invalid_market_response')
        label = _label(entry.get('id'))
    volume = attributes.get('volume_usd')
    volume = _object(volume) if volume is not None else {}
    changes = attributes.get('price_change_percentage')
    changes = _object(changes) if changes is not None else {}
    market = {'source': SOURCE, 'chainId': CHAIN_ID, 'retrievedAt': retrieved, 'asOfTimestamp': None,
              'asOfBlock': None, 'poolId': pool_id, 'sourceUrl': url, 'providerReported': True,
              **currencies, 'dexLabel': label,
              'reportedLiquidityUsd': _number(attributes.get('reserve_in_usd'), optional=True),
              'volume24hUsd': _number(volume.get('h24'), optional=True)}
    listing = {'name': _label(attributes.get('name')),
               'volume6hUsd': _number(volume.get('h6'), optional=True),
               'transactions24h': _transactions(attributes.get('transactions')),
               'createdAt': _timestamp(attributes.get('pool_created_at')),
               'priceChange24hPercent': _signed(changes.get('h24')),
               'baseTokenPriceQuoteToken': _number(attributes.get('base_token_price_quote_token'), optional=True)}
    return {'poolId': pool_id, 'market': market, 'listing': listing}


class GeckoListing:
    """Listing pages and multi-pool reads; every call first asks `reserve`.

    `reserve` is the shared provider allowance at the selection's priority
    (`reserve_provider_if_headroom`); a refusal raises before any request.
    """
    def __init__(self, transport=json_http, clock=time.time, reserve=None):
        self.transport, self.clock, self.reserve = transport, clock, reserve
        self.calls = 0

    def _now(self):
        value = self.clock()
        if type(value) not in (int, float) or not 0 <= value < 2**63 or not math.isfinite(value):
            raise DataError('invalid_market_clock')
        return int(value)

    def _fetch(self, url, limit):
        check_read_deadline()
        self._now()
        if self.reserve is not None and not self.reserve():
            raise DataError('provider_capacity_busy')
        self.calls += 1
        result = _object(self.transport(url, timeout=read_timeout(10)))
        check_read_deadline()
        retrieved = self._now()
        rows = result.get('data')
        if not isinstance(rows, list) or len(rows) > limit:
            raise DataError('invalid_market_response')
        items, rejected = [], []
        for index, row in enumerate(rows):
            try:
                items.append(pool_item(row, url=url, retrieved=retrieved))
            except DataError as error:
                rejected.append({'index': index, 'reason': str(error)})
        return {'url': url, 'retrievedAt': retrieved, 'items': items, 'rejected': rejected,
                'returned': len(rows)}

    def page(self, number):
        return self._fetch(listing_url(number), PAGE_SIZE)

    def multi(self, pool_ids):
        return self._fetch(multi_url(pool_ids), MAX_MULTI)
