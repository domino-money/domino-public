"""Small process-local cache for public market observations, never execution state."""
from collections import OrderedDict, deque
from copy import deepcopy
from threading import Lock
import time

from discovery import CHAIN_ID, DataError, address, bytes32


class MarketCache:
    """Coalesce reads, bound provider usage and retain explicitly stale observations.

    Provider calls go one at a time (`fetching`), so concurrent callers never
    duplicate one. No threads or jobs run in the background; upstream timeouts
    are enforced by the provider adapter.

    3 Nov 2026 (launch): the reader runs 16 provider reads at once, and they all
    took one lock for the whole of any provider call, so a cache hit for one pool
    waited out a five-second miss for another, holding its lane. Now `lock`
    guards only the entries and is never held across a call: hits, cooldowns and
    cache-only reads never wait for the provider. And a refresh, an entry still
    usable but past its 60 s, never queues behind a call in progress: it answers
    its stale value as provider_capacity_busy, as an exhausted budget does, so a
    pool's first reading, which has nothing to show without the provider, goes
    first.
    """
    def __init__(self, provider, *, clock=time.monotonic, reserve_provider=None):
        self.provider, self.clock = provider, clock
        self.entries = OrderedDict()
        self.requests = deque()
        self.lock, self.fetching = Lock(), Lock()
        self.ttl, self.max_stale, self.retry_delay = 60, 300, 15
        self.capacity, self.requests_per_minute = 256, 25
        self.reserve_provider = reserve_provider

    def restore_pool(self,pool_id,observation,*,elapsed_seconds):
        """Warm an empty process cache from a previously validated observation.

        Its original age and attribution survive process restarts. Current pool
        identity and canonicality are still checked by the caller's live read.
        """
        pool_id=bytes32(pool_id)
        if (type(elapsed_seconds) is not int or elapsed_seconds<0 or
                not isinstance(observation,dict) or observation.get('status') not in ('available','stale')):
            return False
        cache,data=observation.get('cache'),observation.get('data')
        if (not isinstance(cache,dict) or not isinstance(data,dict) or
                data.get('chainId')!=CHAIN_ID or data.get('poolId')!=pool_id or
                data.get('source')!='geckoterminal' or
                type(cache.get('ageSeconds')) is not int or cache['ageSeconds']<0 or
                cache.get('freshForSeconds')!=self.ttl or cache.get('maxStaleSeconds')!=self.max_stale):
            return False
        age=cache['ageSeconds']+elapsed_seconds
        if age>self.max_stale:return False
        with self.lock:
            key=('pool',pool_id,None,None)
            if key in self.entries:return False
            now=self.clock()
            self._store(key,{'data':deepcopy(data),'stored':now-age,'attempted':now-age,
                             'retryAt':now,'reason':observation.get('reason')})
        return True

    def get(self, kind, pool_id, *, token='base', currency=None,allow_provider=True):
        pool_id = bytes32(pool_id)
        if kind not in ('pool', 'hourly_prices') or token not in ('base', 'quote') or type(allow_provider) is not bool:
            raise DataError('invalid_market_query')
        if kind == 'hourly_prices':
            currency = address(currency)
        elif currency is not None:
            raise DataError('invalid_market_query')
        # A pool's provider base/quote orientation can change between reads.
        # Never reuse a chart (including stale fallback) for a different address.
        key = (kind, pool_id, token if kind == 'hourly_prices' else None, currency)
        with self.lock:
            answer, entry, now = self._cached(key, allow_provider)
        if answer is not None:
            return answer
        refresh = entry is not None and entry['data'] is not None and now - entry['stored'] <= self.max_stale
        if not self.fetching.acquire(blocking=not refresh):
            return self._result(entry, now, 'rate_limited', 'provider_capacity_busy')
        try:
            # The call just ahead may have answered this very key, or failed it.
            with self.lock:
                answer, entry, now = self._cached(key, allow_provider)
            if answer is not None:
                return answer
            while self.requests and self.requests[0] <= now - 60:
                self.requests.popleft()
            if len(self.requests) >= self.requests_per_minute:
                return self._result(entry, now, 'rate_limited', 'provider_capacity_busy')
            if self.reserve_provider is not None:
                try:
                    allowed = self.reserve_provider()
                except DataError:
                    allowed = False
                if not allowed:
                    return self._result(entry, now, 'rate_limited', 'provider_capacity_busy')
            self.requests.append(now)
            try:
                data = (self.provider.pool(pool_id) if kind == 'pool' else
                        self.provider.hourly_prices(pool_id, token=token, currency=currency))
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
                with self.lock:
                    self._store(key, entry)
                return self._result(entry, finished, 'stale_fallback', reason)
            finished = self.clock()
            entry = {'data': deepcopy(data), 'stored': finished, 'attempted': finished,
                     'retryAt': finished, 'reason': None}
            with self.lock:
                self._store(key, entry)
            return self._result(entry, finished, 'miss')
        finally:
            self.fetching.release()

    def _cached(self, key, allow_provider):
        """Under `lock`: the answer that needs no provider call, if there is one, with the entry and the time.

        An entry is never changed in place, only replaced, so it can be read
        after the lock is released.
        """
        now = self.clock()
        entry = self.entries.get(key)
        if entry is not None and now < entry['attempted']:
            del self.entries[key]
            entry = None
        if entry is not None:
            self.entries.move_to_end(key)
            age = now - entry['stored'] if entry['data'] is not None else None
            if age is not None and age < self.ttl:
                return self._result(entry, now, 'hit'), entry, now
            if now < entry['retryAt']:
                return self._result(entry, now, 'cooldown', entry['reason']), entry, now
        if not allow_provider:
            usable=entry is not None and entry['data'] is not None and now-entry['stored']<=self.max_stale
            return (self._result(entry,now,'hit' if usable else 'miss',
                                 entry['reason'] if usable else 'provider_unavailable'), entry, now)
        return None, entry, now

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
