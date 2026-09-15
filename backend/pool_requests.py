"""Durable demand queue for pools a consumer asked to see.

Two capabilities, never one wide one: the read role may only *ask*, through the
`request_pool` function, and the writer role that runs the indexers may claim
and update rows. Asking adds no table write to the read path and cannot change a
status; nothing here publishes activity or changes a checkpoint.
"""
from contextlib import contextmanager

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from discovery import DataError, bytes32

REQUESTER_ROLE = 'domino_catalogue_reader'
WRITER_ROLE = 'domino_catalogue_writer'
READER_ROLE = 'domino_catalogue_reader'
CLAIMABLE = ('queued', 'indexing', 'registering')
STALE_CLAIM_SECONDS = 300
STATUSES = ('queued', 'registering', 'indexing', 'following', 'blocked')
# Reasons a pool cannot be indexed at all; everything else is retried, because a
# provider outage must not turn into a permanently blocked pool.
PERMANENT = frozenset({'pool_not_in_catalogue', 'invalid_pool_key', 'invalid_initialize_log',
                       'initialize_anchor_not_found', 'initialize_anchor_mismatch',
                       'verified_initialization_block_required', 'activity_start_already_set',
                       'invalid_activity_bounds', 'catalogue_start_required'})


def _jsonable(row):
    """Timestamps leave the store as ISO strings, never as datetime objects."""
    value = dict(row)
    for key in ('requested_at', 'updated_at'):
        if key in value and value[key] is not None:
            value[key] = value[key].isoformat()
    return value


class PgRequests:
    def __init__(self, catalogue, *, role=REQUESTER_ROLE):
        """`role` is who may *ask*: the public read role, or the writer when an
        operator or the worker itself enqueues. Claiming and recording are
        always the writer's."""
        self.catalogue = catalogue
        self.role = role

    @contextmanager
    def _connection(self, role):
        try:
            with psycopg.connect(**self.catalogue.settings, user=role, connect_timeout=3,
                                 row_factory=dict_row) as conn:
                conn.execute("SET LOCAL statement_timeout='5000ms'")
                yield conn
        except psycopg.Error:
            raise DataError('pool_request_database_unavailable') from None

    def enqueue(self, pool_id, *, reason='read', detail=None):
        """Ask for a pool. Idempotent, and never a ledger write.

        No `RETURNING`: the requester holds INSERT and nothing else, and asking
        whether the row already existed is the worker's business, not the
        reader's.
        """
        pool_id = bytes32(pool_id)
        if reason not in ('read', 'operator', 'selected'):
            raise DataError('invalid_pool_request_reason')
        with self._connection(self.role) as conn:
            row = conn.execute('SELECT domino_activity.request_pool(%s,%s) AS accepted',
                               (pool_id, reason)).fetchone()
            return bool(row and row['accepted'])

    def claim(self, *, limit=1, stale_seconds=STALE_CLAIM_SECONDS):
        """Reserve up to `limit` requests for this worker without blocking peers.

        A worker that dies mid-pool leaves its row in `registering`; that claim
        is stale after `stale_seconds` and becomes claimable again, so a crash
        cannot strand a request forever.
        """
        if type(limit) is not int or not 1 <= limit <= 64:
            raise DataError('invalid_pool_request_claim')
        if type(stale_seconds) is not int or not 1 <= stale_seconds <= 86400:
            raise DataError('invalid_pool_request_claim')
        with self._connection(WRITER_ROLE) as conn:
            rows = conn.execute('''UPDATE domino_activity.pool_requests SET status='registering',
              attempts=attempts+1,updated_at=clock_timestamp()
              WHERE pool_id IN (SELECT pool_id FROM domino_activity.pool_requests
                WHERE status=ANY(%s) AND (status<>'registering' OR
                  updated_at<clock_timestamp()-(%s*interval '1 second'))
                ORDER BY requested_at FOR UPDATE SKIP LOCKED LIMIT %s)
              RETURNING pool_id,reason,status,attempts''',
              (list(CLAIMABLE), stale_seconds, limit)).fetchall()
            return [dict(row) for row in rows]

    def retry(self, pool_id=None):
        """Operator action: put blocked requests (one, or all) back in the queue."""
        pool_id = bytes32(pool_id) if pool_id is not None else None
        with self._connection(WRITER_ROLE) as conn:
            rows = conn.execute('''UPDATE domino_activity.pool_requests SET status='queued',
              last_error=NULL,updated_at=clock_timestamp()
              WHERE status='blocked' AND (%s::text IS NULL OR pool_id=%s) RETURNING pool_id''',
              (pool_id, pool_id)).fetchall()
            return [row['pool_id'] for row in rows]

    def record(self, pool_id, status, *, detail=None, error=None):
        """Persist the worker outcome; `blocked` is the only terminal status."""
        pool_id = bytes32(pool_id)
        if status not in STATUSES or status == 'queued':
            raise DataError('invalid_pool_request_status')
        with self._connection(WRITER_ROLE) as conn:
            row = conn.execute('''UPDATE domino_activity.pool_requests SET status=%s,detail=%s,
              last_error=%s,updated_at=clock_timestamp() WHERE pool_id=%s RETURNING pool_id''',
              (status, Jsonb(detail) if detail is not None else None, error, pool_id)).fetchone()
            if row is None:
                raise DataError('pool_request_not_found')
            return True

    def status(self, pool_id=None):
        pool_id = bytes32(pool_id) if pool_id is not None else None
        with self._connection(self.role) as conn:
            if pool_id is not None:
                row = conn.execute('SELECT * FROM domino_activity.pool_requests WHERE pool_id=%s',
                                   (pool_id,)).fetchone()
                return _jsonable(row) if row else None
            rows = conn.execute('''SELECT pool_id,reason,status,attempts,last_error,requested_at,
              updated_at FROM domino_activity.pool_requests
              ORDER BY CASE status WHEN 'queued' THEN 0 WHEN 'registering' THEN 1
              WHEN 'indexing' THEN 2 ELSE 3 END,requested_at''').fetchall()
            return [_jsonable(row) for row in rows]


def configured_pool_requests(catalogue):
    return PgRequests(catalogue) if catalogue is not None else None
