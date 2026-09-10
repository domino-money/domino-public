"""Small process-local cache for public market observations, never execution state."""
from collections import OrderedDict, deque
from copy import deepcopy
from threading import Lock
import time

from discovery import DataError, bytes32


class MarketCache:
    """Coalesce reads, bound provider usage and retain explicitly stale observations.

    The local HTTP gate already allows one read at a time. This lock also prevents
    duplicate provider calls by other in-process callers. No threads or jobs run
    in the background; upstream timeouts are enforced by the provider adapter.
    """
    def __init__(self, provider, *, clock=time.monotonic):
        self.provider, self.clock = provider, clock
        self.entries = OrderedDict()
        self.requests = deque()
        self.lock = Lock()
        self.ttl, self.max_stale, self.retry_delay = 60, 300, 15
        self.capacity, self.requests_per_minute = 256, 25

    def get(self, kind, pool_id, *, token='base'):
        pool_id = bytes32(pool_id)
        if kind not in ('pool', 'hourly_prices') or token not in ('base', 'quote'):
            raise DataError('invalid_market_query')
        key = (kind, pool_id, token if kind == 'hourly_prices' else None)
        with self.lock:
            now = self.clock()
            entry = self.entries.get(key)
            if entry is not None and now < entry['attempted']:
                del self.entries[key]
                entry = None
            if entry is not None:
                self.entries.move_to_end(key)
                age = now - entry['stored'] if entry['data'] is not None else None
                if age is not None and age < self.ttl:
                    return self._result(entry, now, 'hit')
                if now < entry['retryAt']:
                    return self._result(entry, now, 'cooldown', entry['reason'])
            while self.requests and self.requests[0] <= now - 60:
                self.requests.popleft()
            if len(self.requests) >= self.requests_per_minute:
                return self._result(entry, now, 'rate_limited', 'provider_capacity_busy')
            self.requests.append(now)
            try:
                data = (self.provider.pool(pool_id) if kind == 'pool' else
                        self.provider.hourly_prices(pool_id, token=token))
                if not isinstance(data, dict):
                    raise DataError('invalid_market_response')
            except Exception as error:
                # No arbitrary provider body, URL or exception text can escape.
                reason = ('provider_rate_limited' if isinstance(error, DataError) and
                          str(error) == 'http_429' else 'provider_unavailable')
                finished = self.clock()
                entry = {**(entry or {'data': None, 'stored': None}),
                         'attempted': finished, 'retryAt': finished + self.retry_delay,
                         'reason': reason}
                self._store(key, entry)
                return self._result(entry, finished, 'stale_fallback', reason)
            finished = self.clock()
            entry = {'data': deepcopy(data), 'stored': finished, 'attempted': finished,
                     'retryAt': finished, 'reason': None}
            self._store(key, entry)
            return self._result(entry, finished, 'miss')

    def _store(self, key, entry):
        self.entries[key] = entry
        self.entries.move_to_end(key)
        while len(self.entries) > self.capacity:
            self.entries.popitem(last=False)

    def _result(self, entry, now, disposition, reason=None):
        age = None if entry is None or entry['data'] is None else max(0, now - entry['stored'])
        usable = age is not None and age <= self.max_stale
        return {'status': ('available' if age < self.ttl else 'stale') if usable else 'unavailable',
                'reason': reason,
                'data': deepcopy(entry['data']) if usable else None,
                'cache': {'status': disposition, 'ageSeconds': int(age) if age is not None else None,
                          'freshForSeconds': self.ttl, 'maxStaleSeconds': self.max_stale,
                          'scope': 'process_local', 'providerUpdateTimeKnown': False}}
