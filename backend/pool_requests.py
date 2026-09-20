"""Durable demand queue for pools a consumer asked to see.

Two capabilities, never one wide one: the read role may only *ask*, through the
`request_pool` function, and the writer role that runs the indexers may claim
and update rows. Asking adds no table write to the read path and cannot change a
status; nothing here publishes activity or changes a checkpoint.
"""
from contextlib import contextmanager
import secrets

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from discovery import DataError, bytes32

REQUESTER_ROLE = 'domino_catalogue_reader'
WRITER_ROLE = 'domino_catalogue_writer'
READER_ROLE = 'domino_catalogue_reader'
CLAIMABLE = ('queued', 'indexing', 'registering', 'following')
STALE_CLAIM_SECONDS = 300
RECENT_REQUEST_SECONDS = 60
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
    for key in ('requested_at', 'updated_at', 'last_requested_at', 'due_at', 'lease_until'):
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

    def claim(self, *, limit=1, stale_seconds=STALE_CLAIM_SECONDS, exclude=(), priority='auto'):
        """Reserve up to `limit` requests without waiting on busy pool rows.

        Recent user interest takes precedence over the old background backlog.
        Auto reserves every fourth claim for background requests, using persisted
        generations so a short run or restart cannot reset the quota. Either
        priority falls back to the other when its due lane is empty. Within a
        lane, due time and least-recent service preserve rotation. A worker
        that dies mid-pool leaves its row in `registering`; that claim is stale
        after `stale_seconds` and becomes claimable again.
        """
        if type(limit) is not int or not 1 <= limit <= 64:
            raise DataError('invalid_pool_request_claim')
        if type(stale_seconds) is not int or not 1 <= stale_seconds <= 86400:
            raise DataError('invalid_pool_request_claim')
        if not isinstance(exclude,(list,tuple)) or len(exclude)>64:
            raise DataError('invalid_pool_request_claim')
        if priority not in ('auto','recent','background'):
            raise DataError('invalid_pool_request_claim')
        excluded=[bytes32(value) for value in exclude]
        with self._connection(WRITER_ROLE) as conn:
            # Only claim selection is serialized, never the RPC/indexing work.
            # Every claim increments a generation, including explicit priorities.
            conn.execute('SELECT pg_advisory_xact_lock(46630201)')
            phase=conn.execute('''SELECT COALESCE(SUM(claim_generation),0)::bigint % 4 AS phase
              FROM domino_activity.pool_requests''').fetchone()['phase'] if priority=='auto' else 0
            def pick(lane,count):
                return conn.execute("""WITH picked AS (
              SELECT pool_id,updated_at AS previous_updated_at,
                CASE WHEN (last_requested_at>=statement_timestamp()-(%s*interval '1 second'))=%s
                  THEN 0 ELSE 1 END AS priority_rank
              FROM domino_activity.pool_requests
              WHERE status=ANY(%s) AND due_at<=clock_timestamp()
                AND NOT(pool_id=ANY(%s))
                AND (lease_until IS NULL OR lease_until<=clock_timestamp())
                AND (status<>'registering' OR lease_until IS NOT NULL OR
                  updated_at<clock_timestamp()-(%s*interval '1 second'))
              ORDER BY priority_rank,due_at,updated_at,pool_id FOR UPDATE SKIP LOCKED LIMIT %s)
              UPDATE domino_activity.pool_requests q SET status='registering',
                attempts=attempts+1,updated_at=clock_timestamp(),claim_token=%s,
                claim_generation=claim_generation+1,
                lease_until=clock_timestamp()+(%s*interval '1 second')
              FROM picked WHERE q.pool_id=picked.pool_id
              RETURNING q.*,picked.priority_rank,picked.previous_updated_at""",
                  (RECENT_REQUEST_SECONDS,lane=='recent',list(CLAIMABLE),excluded,
                   stale_seconds,count,secrets.token_hex(32),stale_seconds)).fetchall()
            if priority=='auto':
                rows=[]
                for index in range(limit):
                    picked=pick('background' if (phase+index)%4==3 else 'recent',1)
                    if not picked:break
                    rows.extend(picked)
            else:
                rows=pick(priority,limit)
                rows.sort(key=lambda row:(row['priority_rank'],row['due_at'],row['previous_updated_at'],row['pool_id']))
            for row in rows:
                row.pop('priority_rank');row.pop('previous_updated_at')
            return [dict(row) for row in rows]

    @staticmethod
    def guard(claim, conn):
        """Fence publication in the ledger's own transaction, not a preflight."""
        if not isinstance(claim,dict) or not isinstance(claim.get('claim_token'),str):
            raise DataError('pool_request_lease_lost')
        row=conn.execute('''SELECT pool_id FROM domino_activity.pool_requests
          WHERE pool_id=%s AND status='registering' AND claim_token=%s
            AND claim_generation=%s AND lease_until>clock_timestamp() FOR UPDATE''',
          (bytes32(claim['pool_id']),claim['claim_token'],claim['claim_generation'])).fetchone()
        if row is None:raise DataError('pool_request_lease_lost')

    def renew(self,claim,*,lease_seconds=STALE_CLAIM_SECONDS):
        if type(lease_seconds) is not int or not 1<=lease_seconds<=86400:
            raise DataError('invalid_pool_request_claim')
        with self._connection(WRITER_ROLE) as conn:
            self.guard(claim,conn)
            conn.execute("UPDATE domino_activity.pool_requests SET lease_until=clock_timestamp()+(%s*interval '1 second') WHERE pool_id=%s",
                         (lease_seconds,claim['pool_id']))

    def retry(self, pool_id=None):
        """Operator action: put blocked requests (one, or all) back in the queue."""
        pool_id = bytes32(pool_id) if pool_id is not None else None
        with self._connection(WRITER_ROLE) as conn:
            rows = conn.execute('''UPDATE domino_activity.pool_requests SET status='queued',
              last_error=NULL,error_class=NULL,consecutive_failures=0,due_at=clock_timestamp(),
              claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp()
              WHERE status='blocked' AND (%s::text IS NULL OR pool_id=%s) RETURNING pool_id''',
              (pool_id, pool_id)).fetchall()
            return [row['pool_id'] for row in rows]

    def record(self, pool_id, status, *, claim=None, detail=None, error=None, span=None):
        """Persist the worker outcome; `blocked` is the only terminal status."""
        pool_id = bytes32(pool_id)
        if status not in STATUSES or status in ('queued','registering'):
            raise DataError('invalid_pool_request_status')
        if claim is None or claim.get('pool_id')!=pool_id:
            raise DataError('pool_request_lease_lost')
        if span is not None and (type(span) is not int or not 1<=span<=100000):
            raise DataError('invalid_span_bounds')
        failure_count=claim.get('consecutive_failures',0)+1 if error else 0
        classification=error_class(error) if error else None
        delay=(min(900,5*(2**min(failure_count-1,8))) if error else 30 if status=='following' else 1)
        if error:delay+=secrets.randbelow(max(1,delay//5))
        with self._connection(WRITER_ROLE) as conn:
            self.guard(claim,conn)
            row = conn.execute('''UPDATE domino_activity.pool_requests SET status=%s,detail=%s,
              last_error=%s,error_class=%s,consecutive_failures=%s,span_blocks=COALESCE(%s,span_blocks),
              due_at=clock_timestamp()+(%s*interval '1 second'),claim_token=NULL,lease_until=NULL,
              updated_at=clock_timestamp() WHERE pool_id=%s RETURNING pool_id''',
              (status,Jsonb(detail) if detail is not None else None,error,classification,failure_count,span,delay,pool_id)).fetchone()
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
              updated_at,last_requested_at,due_at,lease_until,claim_generation,
              consecutive_failures,error_class,span_blocks FROM domino_activity.pool_requests
              ORDER BY due_at,updated_at,pool_id''').fetchall()
            return [_jsonable(row) for row in rows]


def configured_pool_requests(catalogue):
    return PgRequests(catalogue) if catalogue is not None else None


def error_class(reason):
    if reason in ('rpc_log_range_too_large','response_too_large','activity_log_budget_exhausted'):
        return 'range_capacity'
    if reason in ('http_401','http_403'):return 'authorization'
    if reason=='http_429':return 'provider_rate_limit'
    if reason in ('header_budget_exhausted','indexer_rpc_budget_exhausted','read_deadline_exceeded'):
        return 'run_budget'
    if reason in ('pool_not_in_catalogue','initialize_anchor_not_found'):return 'discovery_incomplete'
    if reason in PERMANENT:return 'identity'
    if 'reorg' in reason or 'reconciliation' in reason:return 'canonicality'
    return 'source_unavailable'
