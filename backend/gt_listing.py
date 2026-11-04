"""GeckoTerminal pool listings for the daily featured-pools selection.

A listing item is the same JSON:API pool object `/pools/{id}` returns, so each
one becomes exactly the observation `GeckoMarketData.pool` builds, with the
same identity checks, plus the listing-only fields the selection rules read.
Nothing here is published: every figure a visitor sees still comes from the
collector. `market_data.py` is hashed by the read contracts, so its helpers are
imported rather than moved.

Per chain (launch round P3, 4 Nov 2026): a GeckoNetwork names the provider's
network, the chain id its observations carry and the DEX label each Uniswap
version is listed under. Robinhood's is the default and reads as it always has:
v4 pool ids only, its currencies through the collector's own helper. On Base and
Arbitrum One a v3 pool is listed by its address (20 bytes) and a v4 pool by its
id (32 bytes). Their network and DEX ids are configuration
(featured_policies/), to be confirmed against the provider before a chain's
shadow starts: a wrong one answers 404, and the listing stops on it.
"""
from dataclasses import dataclass
from datetime import datetime, timezone
import math
import re
import time

from discovery import CHAIN_ID, DataError, address, bytes32, json_http
from market_data import (PREFIX, SOURCE, _currencies, _currency_relationship,
                         _label, _number, _object)
from read_deadline import check_read_deadline, read_timeout

DEX = 'uniswap-v4-robinhood'
NETWORKS_ROOT = 'https://api.geckoterminal.com/api/v2/networks/'
DEX_V3, DEX_V4 = 3, 4
# GeckoTerminal serves twenty pools a page and at most ten pages of a listing.
PAGE_SIZE = 20
MAX_PAGES = 10
# Addresses one /pools/multi call accepts.
MAX_MULTI = 30
MAX_COUNT = 2**53 - 1
TIMESTAMP = re.compile(r'(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?Z')


@dataclass(frozen=True)
class GeckoNetwork:
    """One provider network: the chain its observations carry and {DEX label: Uniswap version} listed there."""
    chain_id: int
    network: str
    dexes: tuple  # ((label, version), ...)

    @property
    def root(self):
        return NETWORKS_ROOT + self.network

    @property
    def prefix(self):
        return self.network + '_'

    @property
    def labels(self):
        return dict(self.dexes)

    def pool_id(self, value):
        """A v4 pool id (32 bytes) or, where v3 is listed, a v3 pool's address (20 bytes), lower case."""
        if DEX_V3 in self.labels.values() and isinstance(value, str) and len(value) == 42:
            return address(value)
        return bytes32(value)

    def currency(self, value):
        """A token relationship's address; Robinhood's through the collector's own helper."""
        if self.prefix == PREFIX:
            return _currency_relationship(value)
        item = _object(_object(value).get('data'))
        identifier = item.get('id')
        if item.get('type') != 'token' or not isinstance(identifier, str) or not identifier.startswith(self.prefix):
            raise DataError('market_currency_identity_mismatch')
        try:
            return address(identifier[len(self.prefix):])
        except DataError:
            raise DataError('market_currency_identity_mismatch') from None


ROBINHOOD = GeckoNetwork(CHAIN_ID, 'robinhood', ((DEX, DEX_V4),))


def pool_version(pool_id):
    """The Uniswap version a listed pool id names: an address is a v3 pool, a 32-byte id a v4 pool."""
    return DEX_V3 if len(pool_id) == 42 else DEX_V4


def listing_url(page, *, network=ROBINHOOD, dex=DEX):
    if type(page) is not int or not 1 <= page <= MAX_PAGES:
        raise DataError('invalid_listing_page')
    if dex not in network.labels:
        raise DataError('invalid_listing_dex')
    return f'{network.root}/dexes/{dex}/pools?sort=h24_volume_usd_desc&page={page}'


def multi_url(pool_ids, *, network=ROBINHOOD):
    ids = sorted({network.pool_id(pool_id) for pool_id in pool_ids})
    if not 1 <= len(ids) <= MAX_MULTI:
        raise DataError('invalid_listing_request')
    return f'{network.root}/pools/multi/{",".join(ids)}'


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


def pool_item(item, *, retrieved, network=ROBINHOOD):
    """One listing item as {poolId, market, listing}; a fixed DataError code otherwise.

    `market` is field for field what `GeckoMarketData.pool` returns for the
    same object, its `sourceUrl` included: the pool's own provider resource.
    A multi call's URL names up to 30 pools, beyond the contract's 512 bytes.
    On another network it is the same observation of that network's pool.
    """
    data = _object(item)
    attributes = _object(data.get('attributes'))
    try:
        identifier = data.get('id')
        if data.get('type') != 'pool' or not isinstance(identifier, str) or not identifier.startswith(network.prefix):
            raise DataError('market_pool_identity_mismatch')
        pool_id = network.pool_id(identifier[len(network.prefix):])
        if network.pool_id(attributes.get('address')) != pool_id:
            raise DataError('market_pool_identity_mismatch')
    except DataError:
        raise DataError('market_pool_identity_mismatch') from None
    relationships = _object(data.get('relationships'))
    currencies = _currencies(network.currency(relationships.get('base_token')),
                             network.currency(relationships.get('quote_token')))
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
    market = {'source': SOURCE, 'chainId': network.chain_id, 'retrievedAt': retrieved, 'asOfTimestamp': None,
              'asOfBlock': None, 'poolId': pool_id, 'sourceUrl': network.root + '/pools/' + pool_id,
              'providerReported': True,
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
    GeckoTerminal's limit is per address, whatever the network, so every
    network's listing spends the same allowance.
    """
    def __init__(self, transport=json_http, clock=time.time, reserve=None, network=ROBINHOOD):
        self.transport, self.clock, self.reserve, self.network = transport, clock, reserve, network
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
                items.append(pool_item(row, retrieved=retrieved, network=self.network))
            except DataError as error:
                rejected.append({'index': index, 'reason': str(error)})
        return {'url': url, 'retrievedAt': retrieved, 'items': items, 'rejected': rejected,
                'returned': len(rows)}

    def page(self, number, dex=DEX):
        return self._fetch(listing_url(number, network=self.network, dex=dex), PAGE_SIZE)

    def multi(self, pool_ids):
        return self._fetch(multi_url(pool_ids, network=self.network), MAX_MULTI)
