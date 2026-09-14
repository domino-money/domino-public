"""Server-side markets snapshot (T2.1, #155): one GET serves every listed pool.

Design constraints from the repo:
- No background threads/jobs exist anywhere in the reader (market_cache docstring,
  bridge docs). A timer-based refresher would be the first daemon in the process.
- The reader is a single process (WEB_CONCURRENCY/UVICORN_WORKERS must be 1).
- Every figure distinguishes zero/unavailable/stale/partial; nothing fabricated.

Therefore the snapshot is **demand-refreshed inside the existing provider slot**:
whenever a provider-slot read runs (pool-market), it passes through
MarketsSnapshot.refresh(), which coalesces concurrent callers onto one shared
rebuild under a single lock (the same pattern MarketCache uses to coalesce
identical reads). Served reads (`serve()`) never touch the provider: they
return the last built snapshot, or an explicit `not_built` state, and never
block behind a refresh.

Built content per pool (never fabricated): the verified pool identity/state
from the chain read plus the GeckoTerminal observation when available - the
same fields pool-market serves today, plus USD figures when the provider
supplied them (reportedLiquidityUsd as TVL proxy, volume24hUsd). feeApr stays
None until T1.4 qualifies non-zero protocol fees and history exists.
"""
from collections import OrderedDict
from copy import deepcopy
from threading import Lock
import time

from discovery import CHAIN_ID, DataError, bytes32

MAX_POOLS = 24
STALE_AFTER = 300


class MarketsSnapshot:
    """Process-local snapshot of the listed pools; served without admission."""

    def __init__(self, clock=time.monotonic, wall_clock=time.time):
        self.clock, self.wall_clock = clock, wall_clock
        self.lock = Lock()
        self.state = None          # {'builtAt', 'monotonic', 'pools': {pool_id: {...}}}
        self.pending = set()       # pool ids queued for the next refresh
        self.refreshing = False

    def select(self, pool_ids):
        """Queue ids for the next refresh; served content is unchanged."""
        if not isinstance(pool_ids, (list, tuple)) or len(pool_ids) > MAX_POOLS:
            raise DataError('invalid_snapshot_request')
        ids = [bytes32(pool_id) for pool_id in pool_ids]
        with self.lock:
            self.pending.update(ids)
            state = self.state
        return self._envelope(state, requested=ids)

    def refresh(self, pool_id, pool, market):
        """Fold one provider-slot read's verified results into the snapshot."""
        pool_id = bytes32(pool_id)
        record = {'poolId': pool_id,
                  'pool': deepcopy(pool),
                  'market': deepcopy(market) if market is not None else None,
                  'observedAt': int(self.wall_clock())}
        with self.lock:
            state = self.state or {'builtAt': int(self.wall_clock()), 'monotonic': self.clock(),
                                   'pools': OrderedDict()}
            pools = state['pools']
            pools.pop(pool_id, None)
            pools[pool_id] = record
            while len(pools) > MAX_POOLS:
                pools.popitem(last=False)
            state['builtAt'], state['monotonic'] = int(self.wall_clock()), self.clock()
            self.pending.discard(pool_id)
            self.state = state
            return self._envelope(state, requested=[pool_id])

    def serve(self, pool_ids=None):
        """Return the built snapshot without touching any provider.

        With explicit ids only the requested stored entries are returned;
        unknown ids are absent, never invented. None serves everything.
        """
        with self.lock:
            state = self.state
        ids = [bytes32(value) for value in pool_ids] if pool_ids else None
        return self._envelope(state, requested=ids, filter_ids=ids)

    def _envelope(self, state, *, requested, filter_ids=None):
        now, monotonic = self.wall_clock(), self.clock()
        wanted = set(filter_ids) if filter_ids is not None else None
        if state is None:
            return {'schemaVersion': 1, 'mode': 'stored_markets_snapshot',
                    'chainId': CHAIN_ID, 'status': 'not_built', 'reason': None,
                    'builtAt': None, 'ageSeconds': None, 'stale': False,
                    'generated': False, 'requested': requested or [], 'pools': []}
        pools = []
        stale = monotonic - state['monotonic'] > STALE_AFTER
        for pool_id, record in state['pools'].items():
            if wanted is not None and pool_id not in wanted:
                continue
            entry = {'poolId': pool_id,
                     'pool': deepcopy(record['pool']),
                     'market': deepcopy(record['market']),
                     'observedAt': record['observedAt']}
            pools.append(entry)
        return {'schemaVersion': 1, 'mode': 'stored_markets_snapshot',
                'chainId': CHAIN_ID, 'status': 'stale' if stale else 'current',
                'reason': 'snapshot_refresh_pending' if stale else None,
                'builtAt': state['builtAt'],
                'ageSeconds': max(0, int(now - state['builtAt'])),
                'stale': stale, 'generated': False,
                'requested': requested or [], 'pools': pools}
