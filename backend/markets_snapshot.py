"""Server-side markets snapshot (T2.1, #155): one read serves every listed pool.

Design constraints from the repo:
- The reader is a single process (WEB_CONCURRENCY/UVICORN_WORKERS must be 1).
- Every figure distinguishes zero/unavailable/stale/partial; nothing fabricated.

The snapshot is fed by provider-slot reads (pool-market) through refresh(), and
served by serve() without touching any provider. Two things make it hold
between visitors rather than only during them (#177 §3.8):

- It is persisted to the reader's private runtime directory on every refresh
  and loaded at startup, so a restart serves the last verified state with its
  real age instead of `not_built`. The consumer treats an old entry as stale
  and re-reads it on demand; it never had to show dashes for it.
- A refresher re-reads one stored pool per period through the same admission
  gate a visitor's read takes, under the same read deadline, so that every
  entry is observed again inside the consumer's 300 s window without any
  visitor paying for it. It yields whenever the gate refuses it, and it is the
  one background job in the process: bounded, observable (one hop record per
  tick, `mode: refresh`), and never able to fail a served read.

Built content per pool (never fabricated): the verified pool identity/state
from the chain read plus the provider observation when available - the same
fields pool-market serves.
"""
from collections import OrderedDict
from copy import deepcopy
import json
import os
from pathlib import Path
import stat
import threading
import time

from discovery import CHAIN_ID, DataError, bytes32
import hop_log
from read_deadline import read_deadline

MAX_POOLS = 24
STALE_AFTER = 300
STORE_LIMIT = 1_048_576
STORE_VERSION = 1
# One stored pool re-read per period; every pool inside the consumer's 300 s
# window at 24 pools needs a period of 12.5 s, so the interval divides by the
# pool count and is floored at MIN_PERIOD so an empty or tiny store never spins.
DEFAULT_REFRESH_SECONDS = 240
MIN_PERIOD, MIN_REFRESH_SECONDS, MAX_REFRESH_SECONDS = 10, 30, 3600


class MarketsSnapshot:
    """Process-local snapshot of the listed pools; served without admission."""

    def __init__(self, clock=time.monotonic, wall_clock=time.time, path=None):
        self.clock, self.wall_clock = clock, wall_clock
        self.lock = threading.Lock()
        self.state = None          # {'builtAt', 'monotonic', 'pools': {pool_id: {...}}}
        self.pending = set()       # pool ids queued for the next refresh
        self.refreshing = False
        self.path = Path(path) if path is not None else None
        self.store_failures = 0
        self.loaded = False
        if self.path is not None:
            self.load()

    # -- persistence: private file, atomic replace, never a reason to fail a read

    def load(self):
        """Adopt a stored snapshot if it is ours, well-formed and readable.

        Anything else leaves the store not built: a foreign, permissive,
        oversized, linked or malformed file is not evidence of anything.
        """
        try:
            fd = os.open(self.path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        except OSError:
            return False
        try:
            with os.fdopen(fd, 'rb') as stream:
                info = os.fstat(stream.fileno())
                if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid()
                        or info.st_mode & 0o077 or info.st_size > STORE_LIMIT):
                    return False
                raw = stream.read(STORE_LIMIT + 1)
            document = json.loads(raw.decode('utf-8'))
            pools = self._checked_pools(document)
        except (OSError, ValueError, TypeError, KeyError, DataError):
            return False
        built = document['builtAt']
        now = self.wall_clock()
        # The stored age is the wall-clock age; the monotonic mark is placed so
        # staleness reads the same whichever clock asks.
        age = max(0, now - built)
        with self.lock:
            self.state = {'builtAt': int(built), 'monotonic': self.clock() - age, 'pools': pools}
            self.loaded = True
        return True

    @staticmethod
    def _checked_pools(document):
        if (type(document) is not dict or document.get('version') != STORE_VERSION
                or type(document.get('builtAt')) is not int or document['builtAt'] < 0
                or type(document.get('pools')) is not list or len(document['pools']) > MAX_POOLS):
            raise DataError('invalid_snapshot_store')
        pools = OrderedDict()
        for record in document['pools']:
            if (type(record) is not dict or set(record) != {'poolId', 'pool', 'market', 'observedAt'}
                    or type(record['pool']) is not dict
                    or not (record['market'] is None or type(record['market']) is dict)
                    or type(record['observedAt']) is not int or record['observedAt'] < 0):
                raise DataError('invalid_snapshot_store')
            pool_id = bytes32(record['poolId'])
            if pool_id in pools:
                raise DataError('invalid_snapshot_store')
            pools[pool_id] = {'poolId': pool_id, 'pool': record['pool'],
                              'market': record['market'], 'observedAt': record['observedAt']}
        return pools

    def store(self, state):
        """Write the state atomically beside the file; a failure is counted, not raised."""
        if self.path is None:
            return
        document = {'version': STORE_VERSION, 'builtAt': state['builtAt'],
                    'pools': [{'poolId': pool_id, 'pool': record['pool'], 'market': record['market'],
                               'observedAt': record['observedAt']}
                              for pool_id, record in state['pools'].items()]}
        temporary = self.path.with_name('.' + self.path.name + '.tmp')
        try:
            raw = json.dumps(document, separators=(',', ':'), allow_nan=False).encode()
            if len(raw) > STORE_LIMIT:
                raise ValueError('snapshot_store_limit')
            try:
                os.unlink(temporary)
            except FileNotFoundError:
                pass
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            try:
                with os.fdopen(fd, 'wb') as stream:
                    stream.write(raw)
                    stream.flush()
                    os.fsync(stream.fileno())
                os.replace(temporary, self.path)
            except BaseException:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass
                raise
        except (OSError, ValueError, TypeError):
            self.store_failures += 1

    # -- what the refresher works from

    def refresh_candidates(self):
        """Pool ids in the order they deserve a re-read: queued first, then oldest."""
        with self.lock:
            pending = sorted(self.pending)
            stored = self.state['pools'] if self.state else {}
            oldest = sorted((record['observedAt'], pool_id) for pool_id, record in stored.items()
                            if pool_id not in self.pending)
        return pending + [pool_id for _, pool_id in oldest]

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
            envelope = self._envelope(state, requested=[pool_id])
            self.store(state)
            return envelope

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


class SnapshotRefresher:
    """Re-read one stored pool per period through the reader's own admission.

    `read(pool_id)` is the service's pool-market read, which folds its verified
    result into the snapshot. The gate is the same one a visitor's read takes:
    a refusal is a skipped tick, never a wait or a retry, so the refresher can
    only ever use capacity nobody else wanted at that moment. A tick cannot
    raise: every outcome becomes one hop record with `mode: refresh`.
    """

    def __init__(self, snapshot, read, gate, *, interval=DEFAULT_REFRESH_SECONDS,
                 budget_seconds=15, clock=time.monotonic, sleep=None, service='read'):
        if type(interval) is not int or not MIN_REFRESH_SECONDS <= interval <= MAX_REFRESH_SECONDS:
            raise ValueError('invalid_snapshot_refresh_interval')
        if type(budget_seconds) not in (int, float) or not 0 < budget_seconds <= 60:
            raise ValueError('invalid_read_budget')
        self.snapshot, self.read, self.gate = snapshot, read, gate
        self.interval, self.budget_seconds = interval, budget_seconds
        self.stopped = threading.Event()
        # Waiting on the stop event, not sleeping, is what lets a shutdown end
        # the loop now rather than at the end of the current period.
        self.clock, self.sleep, self.service = clock, sleep or self.stopped.wait, service
        self.thread = None
        self.counts = {'ticks': 0, 'refreshed': 0, 'refused': 0, 'failed': 0, 'idle': 0}
        self.last_refreshed_at = None

    def period(self):
        candidates = len(self.snapshot.refresh_candidates())
        return max(MIN_PERIOD, self.interval // max(1, candidates))

    def tick(self):
        """One unit of work; returns the outcome name and never raises."""
        self.counts['ticks'] += 1
        candidates = self.snapshot.refresh_candidates()
        if not candidates:
            self.counts['idle'] += 1
            return 'idle'
        pool_id = candidates[0]
        token = hop_log.open_notes()
        opened = self.clock()
        kind = self.gate.PROVIDER
        outcome, status, reason = 'refreshed', 200, None
        try:
            if not self.gate.enter(kind):
                self.counts['refused'] += 1
                hop_log.note(gate=kind, admitted=False, reason='read_capacity_busy')
                return 'refused'
            hop_log.note(gate=kind, admitted=True)
            try:
                with read_deadline(self.budget_seconds):
                    self.read(pool_id)
                self.counts['refreshed'] += 1
                self.last_refreshed_at = self.clock()
            except DataError as error:
                outcome, status, reason = 'failed', None, str(error)
                self.counts['failed'] += 1
            except Exception:
                # The refresher is not allowed to bring anything down, or to leak
                # a provider or transport diagnostic into the journal.
                outcome, status, reason = 'failed', None, 'refresh_failed'
                self.counts['failed'] += 1
            finally:
                self.gate.leave(kind)
            hop_log.note(status=status, reason=reason)
            return outcome
        finally:
            hop_log.emit(service=self.service, route='markets-snapshot', mode='refresh',
                         durationMs=int((self.clock() - opened) * 1000),
                         **hop_log.close_notes(token))

    def run(self):
        while not self.stopped.is_set():
            self.sleep(self.period())
            if self.stopped.is_set():
                break
            try:
                self.tick()
            except BaseException:
                # tick() contains its own failures; this is the last line.
                self.counts['failed'] += 1

    def start(self):
        if self.thread is None:
            self.thread = threading.Thread(target=self.run, name='markets-snapshot-refresh', daemon=True)
            self.thread.start()
        return self.thread

    def stop(self):
        self.stopped.set()

    def describe(self):
        return {'intervalSeconds': self.interval, 'periodSeconds': self.period(),
                'running': self.thread is not None and self.thread.is_alive(),
                'lastRefreshedAgoSeconds': (None if self.last_refreshed_at is None
                                            else int(self.clock() - self.last_refreshed_at)),
                **self.counts}
