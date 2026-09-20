"""Local candidate inventory with an explicit bounded Alchemy coverage fallback.

Neither source proves the complete contents of a wallet. Candidate addresses
are always reread on-chain; no indexed balance or symbol is trusted.
"""
import base64
import hashlib
import hmac
import json
import re
import secrets
import time
from urllib.parse import urlsplit

from discovery import CHAIN_ID, ZERO, DataError, ReadRpc, address, json_http, quantity

PAGE_SIZE = 20


class InventoryRpc(ReadRpc):
    METHODS = frozenset({'eth_chainId', 'alchemy_getTokenBalances'})


def inventory_endpoint(url):
    try:
        parsed = urlsplit(url)
        valid = (parsed.scheme == 'https'
                 and parsed.netloc == 'robinhood-mainnet.g.alchemy.com'
                 and re.fullmatch(r'/v2/[A-Za-z0-9_-]{1,128}', parsed.path)
                 and not parsed.query and not parsed.fragment)
    except ValueError:
        valid = False
    if not valid:
        raise DataError('invalid_inventory_endpoint')
    return url


def page_key(value):
    if value is None:
        return None
    if not isinstance(value, str) or not 1 <= len(value) <= 1024 or not value.isascii() or not value.isprintable():
        raise DataError('invalid_inventory_cursor')
    return value


def continuation_key(value):
    if value is None:
        return None
    if not isinstance(value,str) or not 1<=len(value)<=2048 or not value.isascii() or not value.isprintable():
        raise DataError('invalid_inventory_cursor')
    return value


class AlchemyInventory:
    """An endpoint name is not evidence that its Robinhood data coverage works."""
    def __init__(self, url, *, transport=json_http, clock=time.time):
        self.url = inventory_endpoint(url)
        self.transport, self.clock = transport, clock
        self.context = hashlib.sha256(self.url.encode()).hexdigest()

    def page(self, wallet, cursor=None, *, limit=PAGE_SIZE):
        wallet, cursor = address(wallet), page_key(cursor)
        if type(limit) is not int or not 1<=limit<=PAGE_SIZE:
            raise DataError('request_budget_exhausted')
        rpc = InventoryRpc(self.url, transport=self.transport, max_requests=2)
        if quantity(rpc.request('eth_chainId')) != CHAIN_ID:
            raise DataError('inventory_wrong_chain')
        options = {'maxCount': limit}
        if cursor:
            options['pageKey'] = cursor
        data = rpc.request('alchemy_getTokenBalances', [wallet, 'erc20', options])
        if not isinstance(data, dict) or address(data.get('address')) != wallet:
            raise DataError('inventory_wallet_mismatch')
        rows = data.get('tokenBalances')
        if not isinstance(rows, list) or len(rows) > limit:
            raise DataError('invalid_inventory_page')
        candidates, excluded, seen = [], 0, set()
        for row in rows:
            try:
                if not isinstance(row, dict):
                    raise DataError('invalid_inventory_row')
                currency = address(row.get('contractAddress'))
                if currency == ZERO:
                    raise DataError('native_in_erc20_inventory')
                # Do not trust indexed balances, symbols, decimals or supplied URLs.
                # Even a per-token provider error can still yield an address to check.
                if currency not in seen:
                    candidates.append(currency)
                    seen.add(currency)
            except DataError:
                excluded += 1
        next_key = page_key(data.get('pageKey'))
        if next_key is not None and next_key == cursor:
            raise DataError('inventory_cursor_repeated')
        return {'currencies': candidates, 'nextKey': next_key, 'excludedRows': excluded,
                'rowsReceived': len(rows), 'retrievedAt': int(self.clock())}


class LocalCatalogueInventory:
    """Page public pool/search identities, never wallet holdings or private data.

The fingerprint covers the candidate *set*, not observation refreshes. A set
change invalidates continuation rather than silently skipping a new address
which sorts before the last page. SQL returns at most 21 addresses and runs
under the catalogue's bounded, read-only transaction.
    """
    def __init__(self, catalogue, *, clock=time.time):
        self.catalogue, self.clock = catalogue, clock
        self.context = hashlib.sha256(json.dumps(
            getattr(catalogue, 'settings', {}), sort_keys=True).encode()).hexdigest()

    def page(self, wallet, cursor=None, *, limit=PAGE_SIZE):
        address(wallet)
        if type(limit) is not int or not 1 <= limit <= PAGE_SIZE:
            raise DataError('request_budget_exhausted')
        after, fingerprint = ZERO, None
        if cursor is not None:
            try:
                value = json.loads(page_key(cursor))
                if set(value) != {'after', 'set'} or not re.fullmatch('[0-9a-f]{32}', value['set']):
                    raise ValueError()
                after, fingerprint = address(value['after']), value['set']
            except (ValueError, TypeError, KeyError, DataError):
                raise DataError('invalid_or_expired_cursor') from None
        with self.catalogue.connection() as conn:
            public_tokens = ("UNION SELECT entity_id FROM domino_public.entities WHERE chain_id=%s AND kind='token'"
                             if getattr(self.catalogue,'inventory_public_tokens',True) else '')
            parameters = ((CHAIN_ID,) if public_tokens else ()) + (ZERO,after,limit+1)
            rows = conn.execute('''WITH candidates AS MATERIALIZED (
              SELECT currency0 AS currency FROM domino_catalogue.events
              UNION SELECT currency1 FROM domino_catalogue.events
              UNION SELECT currency0 FROM domino_catalogue.hints
              UNION SELECT currency1 FROM domino_catalogue.hints
              ''' + public_tokens + '''
            ), identity AS (
              SELECT md5(COALESCE(string_agg(currency,',' ORDER BY currency),'')) AS fingerprint
              FROM candidates WHERE currency<>%s
            ), page AS (
              SELECT currency FROM candidates WHERE currency>%s ORDER BY currency LIMIT %s
            ) SELECT identity.fingerprint,page.currency FROM identity LEFT JOIN page ON true
              ORDER BY page.currency''', parameters).fetchall()
        observed = rows[0]['fingerprint'] if rows else None
        if not isinstance(observed, str) or not re.fullmatch('[0-9a-f]{32}', observed):
            raise DataError('catalogue_schema_mismatch')
        if fingerprint is not None and fingerprint != observed:
            raise DataError('invalid_or_expired_cursor')
        candidates = [address(row['currency']) for row in rows if row['currency'] is not None]
        currencies = candidates[:limit]
        key = json.dumps({'after': currencies[-1], 'set': observed}, separators=(',', ':')) if len(candidates)>limit else None
        return {'currencies': currencies, 'nextKey': key, 'excludedRows': 0,
                'rowsReceived': len(currencies), 'retrievedAt': int(self.clock())}


class LocalFirstInventory:
    """Exhaust known local addresses before offering external coverage.

The transition is a normal authenticated continuation cursor: Alchemy is not
contacted just to construct the last local page. If local inventory is absent
or unavailable, the first page may fall back immediately, with its reason.
    """
    def __init__(self, local, fallback=None):
        self.local, self.fallback = local, fallback
        self.source = 'local_catalogue' if local else 'alchemy'
        self.fallback_reason = None
        self.context = hashlib.sha256(json.dumps([
            'local-first-v1', getattr(local, 'context', None),
            getattr(fallback, 'context', None)]).encode()).hexdigest()

    @staticmethod
    def _key(phase, key=None, reason=None):
        # The outer CursorCodec signs this provider-owned state and binds the
        # wallet, explicit addresses, sources and expiration.
        encoded = base64.urlsafe_b64encode(key.encode()).decode() if key is not None else None
        return json.dumps({'phase':phase,'key':encoded,'reason':reason}, separators=(',', ':'))

    def page(self, wallet, cursor=None, *, limit=PAGE_SIZE):
        phase, key, reason = 'local', None, None
        if cursor:
            try:
                value = json.loads(continuation_key(cursor))
                if set(value) != {'phase','key','reason'} or value['phase'] not in ('local','alchemy'):
                    raise ValueError()
                phase, key, reason = value['phase'], value['key'], value['reason']
                key = base64.b64decode(key,altchars=b'-_',validate=True).decode() if key is not None else None
                page_key(key)
                if reason not in (None,'local_inventory_unavailable','local_inventory_empty','local_inventory_coverage_partial'):
                    raise ValueError()
            except (ValueError, TypeError, KeyError, UnicodeError, DataError):
                raise DataError('invalid_or_expired_cursor') from None
        if phase == 'local':
            try:
                if self.local is None:
                    raise DataError('local_inventory_unavailable')
                result = self.local.page(wallet, key, limit=limit)
                if not result['currencies'] and key is None and self.fallback is not None:
                    raise DataError('local_inventory_empty')
                next_key = result['nextKey']
                continuation = (self._key('local', next_key) if next_key else
                    self._key('alchemy', reason='local_inventory_coverage_partial') if self.fallback else None)
                return {**result, 'nextKey':continuation, 'source':'local_catalogue',
                        'coverage':'local_catalogue_only', 'fallbackReason':None}
            except DataError as error:
                if str(error) not in ('local_inventory_unavailable','local_inventory_empty',
                                      'catalogue_database_unavailable','catalogue_schema_mismatch'):
                    raise
                reason = ('local_inventory_empty' if str(error)=='local_inventory_empty'
                          else 'local_inventory_unavailable')
                if self.fallback is None:
                    raise DataError('catalogue_database_unavailable') from None
        if self.fallback is None:
            raise DataError('invalid_or_expired_cursor')
        self.source, self.fallback_reason = 'alchemy', reason
        external_key = key if phase=='alchemy' else None
        result = (self.fallback.page(wallet,external_key,limit=limit) if isinstance(self.fallback,AlchemyInventory)
                  else self.fallback.page(wallet,external_key))
        continuation = self._key('alchemy', result['nextKey'], reason) if result['nextKey'] else None
        return {**result, 'nextKey':continuation, 'source':'alchemy',
                'coverage':'provider_page_only', 'fallbackReason':reason}


class CursorCodec:
    """Short-lived local pagination, bound to wallet, fallback list and provider.

    A cursor is not authentication or financial permission. Restart invalidates it.
    """
    def __init__(self, *, secret=None, clock=time.time, ttl=300):
        self.secret, self.clock, self.ttl = secret or secrets.token_bytes(32), clock, ttl

    @staticmethod
    def _encode(raw):
        return base64.urlsafe_b64encode(raw).rstrip(b'=').decode()

    @staticmethod
    def _decode(value):
        return base64.b64decode(value + '=' * (-len(value) % 4), altchars=b'-_', validate=True)

    def issue(self, wallet, tokens, provider, next_key):
        data = {'v': 1, 'chain': CHAIN_ID, 'wallet': address(wallet), 'tokens': tokens,
                'provider': provider, 'key': continuation_key(next_key), 'expires': int(self.clock()) + self.ttl}
        raw = json.dumps(data, sort_keys=True, separators=(',', ':')).encode()
        return self._encode(raw) + '.' + self._encode(hmac.digest(self.secret, raw, 'sha256'))

    def read(self, value, wallet, tokens, provider):
        try:
            if not isinstance(value, str) or len(value) > 4096:
                raise ValueError()
            payload, signature = value.split('.')
            raw, sig = self._decode(payload), self._decode(signature)
            if not hmac.compare_digest(sig, hmac.digest(self.secret, raw, 'sha256')):
                raise ValueError()
            data = json.loads(raw)
            if (data['v'] != 1 or data['chain'] != CHAIN_ID or data['wallet'] != address(wallet)
                    or data['tokens'] != tokens or data['provider'] != provider
                    or type(data['expires']) is not int or self.clock() >= data['expires']):
                raise ValueError()
            key = continuation_key(data['key'])
            if key is None:
                raise ValueError()
            return key
        except (ValueError, KeyError, TypeError, UnicodeError, RecursionError):
            raise DataError('invalid_or_expired_cursor') from None
