"""Optional Alchemy candidate inventory; balances must be reread on-chain."""
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


class AlchemyInventory:
    """An endpoint name is not evidence that its Robinhood data coverage works."""
    def __init__(self, url, *, transport=json_http, clock=time.time):
        self.url = inventory_endpoint(url)
        self.transport, self.clock = transport, clock
        self.context = hashlib.sha256(self.url.encode()).hexdigest()

    def page(self, wallet, cursor=None):
        wallet, cursor = address(wallet), page_key(cursor)
        rpc = InventoryRpc(self.url, transport=self.transport, max_requests=2)
        if quantity(rpc.request('eth_chainId')) != CHAIN_ID:
            raise DataError('inventory_wrong_chain')
        options = {'maxCount': PAGE_SIZE}
        if cursor:
            options['pageKey'] = cursor
        data = rpc.request('alchemy_getTokenBalances', [wallet, 'erc20', options])
        if not isinstance(data, dict) or address(data.get('address')) != wallet:
            raise DataError('inventory_wallet_mismatch')
        rows = data.get('tokenBalances')
        if not isinstance(rows, list) or len(rows) > PAGE_SIZE:
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
                'provider': provider, 'key': page_key(next_key), 'expires': int(self.clock()) + self.ttl}
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
            key = page_key(data['key'])
            if key is None:
                raise ValueError()
            return key
        except (ValueError, KeyError, TypeError, UnicodeError, RecursionError):
            raise DataError('invalid_or_expired_cursor') from None
