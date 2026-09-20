"""Durable public token/current-market observations; no wallet identities.

HTTP readers can request bounded work and read projections. Only the background
writer may publish, under the same lease/generation it claimed. Existing activity
requests retain sole ownership of deep ledger indexing.
"""
from contextlib import contextmanager
from copy import deepcopy
import math
import secrets
import time

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from discovery import CHAIN_ID, DataError, address, bytes32
from read_deadline import check_read_deadline, current_read_deadline, read_timeout


class DeadlineConnection:
    """Recompute a query's SQL timeout as the shared request budget is spent."""
    def __init__(self,connection):self.connection=connection
    def __getattr__(self,name):return getattr(self.connection,name)
    def execute(self,query,params=None,**kwargs):
        check_read_deadline()
        shortened=False
        if current_read_deadline() is not None:
            remaining=read_timeout(5);shortened=remaining<5
            milliseconds=max(1,int(remaining*1000))
            self.connection.execute("SET LOCAL statement_timeout='"+str(milliseconds)+"ms'")
        try:result=self.connection.execute(query,params,**kwargs)
        except psycopg.errors.QueryCanceled:
            # PostgreSQL may cancel a fraction of a millisecond before the
            # rounded monotonic deadline. It still spent this request's budget.
            if shortened:raise DataError('read_deadline_exceeded') from None
            raise
        check_read_deadline()
        return result


class PgPublicData:
    def __init__(self, catalogue, *, writer=False, clock=time.time):
        self.catalogue, self.writer, self.clock = catalogue, writer, clock

    @contextmanager
    def connection(self, *, write=False):
        if write and not self.writer:
            raise DataError('public_data_writer_required')
        role = 'domino_catalogue_writer' if self.writer else 'domino_catalogue_reader'
        try:
            check_read_deadline()
            with psycopg.connect(**self.catalogue.settings, user=role, connect_timeout=max(1,math.ceil(read_timeout(3))),
                                 row_factory=dict_row) as conn:
                check_read_deadline()
                # SET is safe before callers select REPEATABLE READ. A SELECT
                # set_config here would prematurely establish their transaction.
                conn.execute("SET LOCAL statement_timeout='"+str(max(1,int(read_timeout(5)*1000)))+"ms'")
                yield DeadlineConnection(conn)
                check_read_deadline()
        except psycopg.Error:
            check_read_deadline()
            raise DataError('catalogue_database_unavailable') from None

    @staticmethod
    def identity(kind, entity_id):
        if kind not in ('token', 'pool'):
            raise DataError('invalid_request')
        return address(entity_id) if kind == 'token' else bytes32(entity_id)

    def request(self, kind, entity_id):
        entity_id = self.identity(kind, entity_id)
        with self.connection() as conn:
            return bool(conn.execute('SELECT domino_public.request_entity(%s,%s) AS accepted',
                                     (kind, entity_id)).fetchone()['accepted'])

    def request_many(self,kind,entity_ids):
        """One bounded transaction through the existing narrow demand function."""
        if kind not in ('token','pool') or not isinstance(entity_ids,(list,tuple)) or len(entity_ids)>24:
            raise DataError('invalid_request')
        # Validate every identity before acquiring a connection or admitting any
        # item; do not partially admit a malformed batch.
        checked=[self.identity(kind,value) for value in entity_ids]
        if not checked:return True
        with self.connection() as conn:
            rows=conn.execute('''SELECT domino_public.request_entity(%s,item) AS accepted
              FROM unnest(%s::text[]) AS requested(item)''',(kind,checked)).fetchall()
            return all(row['accepted'] for row in rows)

    def get(self, kind, entity_id):
        entity_id = self.identity(kind, entity_id)
        with self.connection() as conn:
            return conn.execute('SELECT * FROM domino_public.entities WHERE chain_id=%s AND kind=%s AND entity_id=%s',
                                (CHAIN_ID, kind, entity_id)).fetchone()

    def reserve_provider(self):
        with self.connection() as conn:
            return conn.execute('SELECT domino_public.reserve_provider() AS allowed').fetchone()['allowed']

    def ensure(self, kind, entity_id):
        """Persist a background prerequisite without requesting its discovery."""
        entity_id=self.identity(kind,entity_id)
        with self.connection(write=True) as conn:
            if conn.execute('SELECT 1 FROM domino_public.entities WHERE kind=%s AND entity_id=%s',
                            (kind,entity_id)).fetchone():return True
            conn.execute('SELECT pg_advisory_xact_lock(46630240)')
            count=conn.execute("""SELECT count(*) AS n FROM domino_public.entities
              WHERE payload IS NULL AND status='pending' AND last_requested_at='epoch'::timestamptz""").fetchone()['n']
            if count>=1000:return False
            conn.execute("""INSERT INTO domino_public.entities(kind,entity_id,last_requested_at)
              VALUES(%s,%s,'epoch'::timestamptz) ON CONFLICT DO NOTHING""",(kind,entity_id))
            return True

    def snapshot_pool_ids(self):
        with self.connection() as conn:
            return [row['entity_id'] for row in conn.execute("""SELECT entity_id
                FROM domino_public.entities WHERE kind='pool' AND payload IS NOT NULL
                ORDER BY last_requested_at DESC,entity_id LIMIT 24""").fetchall()]

    def overview(self, *, token=None, pool_ids=(), after=None, limit=24, revision=None):
        """One consistent stored page. No RPC, provider or history replay."""
        token = address(token) if token is not None else None
        ids = [bytes32(value) for value in pool_ids]
        after = bytes32(after) if after is not None else None
        if not 1 <= limit <= 24 or len(ids) > 24:
            raise DataError('invalid_request')
        with self.connection() as conn:
            conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            rev = conn.execute('SELECT revision FROM domino_public.state WHERE singleton').fetchone()['revision']
            if revision is not None and rev != revision:
                raise DataError('catalogue_revision_changed')
            if token is not None:
                matches = conn.execute('SELECT pool_id FROM domino_public.token_pools WHERE chain_id=%s AND token=%s AND (%s::text IS NULL OR pool_id>%s) ORDER BY pool_id LIMIT %s',
                                       (CHAIN_ID, token, after, after, limit + 1)).fetchall()
                ids = [row['pool_id'] for row in matches[:limit]]
                has_more = len(matches) > limit
            else:
                has_more = False
            pools = conn.execute("SELECT * FROM domino_public.entities WHERE chain_id=%s AND kind='pool' AND entity_id=ANY(%s) ORDER BY entity_id",
                                 (CHAIN_ID, ids)).fetchall()
            currencies = {token} if token is not None else set()
            for row in pools:
                if row['payload']:
                    currencies.update(row['payload']['pool']['currencies'])
            tokens = conn.execute("SELECT * FROM domino_public.entities WHERE chain_id=%s AND kind='token' AND entity_id=ANY(%s) ORDER BY entity_id",
                                  (CHAIN_ID, sorted(currencies))).fetchall()
        return {'revision': rev, 'poolIds': ids, 'pools': pools, 'tokens': tokens,
                'hasMore': has_more, 'nextAfter': ids[-1] if has_more else None}

    def search(self, query, *, limit=20):
        """Search only already verified identities; symbols never select a contract."""
        if type(query) is not str or not 1 <= len(query.strip()) <= 96 or not 1 <= limit <= 24:
            raise DataError('invalid_request')
        term = query.strip().replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
        with self.connection() as conn:
            rows = conn.execute("""SELECT * FROM domino_public.entities
              WHERE kind='token' AND status='ready' AND payload->'asset'->>'readStatus' IN ('available','partial')
              AND (entity_id ILIKE %s OR payload->'asset'->>'symbol' ILIKE %s)
              ORDER BY entity_id LIMIT %s""", (term+'%', term+'%', limit)).fetchall()
        return rows

    def claim(self, kind, *, limit=1, lease_seconds=60, demand=None, exclude=()):
        self.identity(kind, '0x' + '0' * (40 if kind == 'token' else 64))
        if type(limit) is not int or not 1 <= limit <= 24 or not 15 <= lease_seconds <= 300:
            raise DataError('invalid_request')
        if demand not in (None,'hot','background','scheduled') or not isinstance(exclude,(list,tuple)) or len(exclude)>32:
            raise DataError('invalid_request')
        exclude=[self.identity(kind,value) for value in exclude]
        lease = secrets.token_hex(16)
        with self.connection(write=True) as conn:
            preferred=None
            if demand=='scheduled':
                # Count persisted claims rather than invocations: a deadline,
                # spent RPC budget or restart must not erase background's turn.
                conn.execute('SELECT pg_advisory_xact_lock(%s)',(46630242 if kind=='pool' else 46630243,))
                count=conn.execute('SELECT COALESCE(sum(generation),0) AS n FROM domino_public.entities WHERE kind=%s',(kind,)).fetchone()['n']
                cycle=4 if kind=='pool' else 2
                preferred='background' if int(count)%cycle==cycle-1 else 'hot'
                demand=None
            return conn.execute("""UPDATE domino_public.entities e SET
              lease_token=%s,lease_until=clock_timestamp()+(%s*interval '1 second'),
              generation=e.generation+1,attempts=e.attempts+1
              WHERE (e.chain_id,e.kind,e.entity_id) IN
                (SELECT chain_id,kind,entity_id FROM domino_public.entities
                 WHERE kind=%s AND next_due<=clock_timestamp()
                   AND (lease_until IS NULL OR lease_until<clock_timestamp())
                   AND NOT(entity_id=ANY(%s))
                   AND (%s::text IS NULL OR
                     (last_requested_at>=clock_timestamp()-interval '60 seconds')=(%s='hot'))
                 ORDER BY CASE WHEN %s::text IS NULL OR
                   (last_requested_at>=clock_timestamp()-interval '60 seconds')=(%s='hot') THEN 0 ELSE 1 END,
                   next_due,entity_id FOR UPDATE SKIP LOCKED LIMIT %s)
              RETURNING *""", (lease, lease_seconds, kind,exclude,demand,demand,preferred,preferred,limit)).fetchall()

    @staticmethod
    def guard(conn, claim):
        row = conn.execute("""SELECT entity_id FROM domino_public.entities WHERE
          chain_id=%s AND kind=%s AND entity_id=%s AND lease_token=%s AND generation=%s
          AND lease_until>clock_timestamp() FOR UPDATE""",
          (CHAIN_ID, claim['kind'], claim['entity_id'], claim['lease_token'], claim['generation'])).fetchone()
        if row is None:
            raise DataError('public_data_lease_lost')

    def publish(self, claim, payload, *, observed_at=None, discovered_pools=(), delay=15,
                discovery_after=None, discovery_revision=None, keep_lease=False):
        """Validate before transaction; lock/fence publication and next due atomically."""
        from read_contract import validate_response
        kind, entity_id = claim['kind'], claim['entity_id']
        route = 'token' if kind == 'token' else 'pool-market'
        validate_response(route, payload)
        if ((kind == 'token' and payload['asset']['address'] != entity_id) or
                (kind == 'pool' and payload['poolId'] != entity_id)):
            raise DataError('upstream_contract_mismatch')
        observed_at = int(self.clock()) if observed_at is None else observed_at
        if type(observed_at) is not int or not 0 <= observed_at <= int(self.clock()) + 5:
            raise DataError('invalid_request')
        if type(delay) is not int or not 1 <= delay <= 86400:
            raise DataError('invalid_request')
        if type(keep_lease) is not bool or (keep_lease and (kind!='token' or discovered_pools)):
            raise DataError('invalid_request')
        metadata_only=(kind=='token' and not claim.get('discovery_requested',False)
                       and payload['asset']['readStatus']!='no_contract')
        links = []
        if kind == 'pool':
            links = [(currency, entity_id) for currency in payload['pool']['currencies']]
        else:
            links = [(entity_id, bytes32(pool_id)) for pool_id in discovered_pools]
        with self.connection(write=True) as conn:
            self.guard(conn, claim)
            conn.execute("""UPDATE domino_public.entities SET payload=%s,observed_at=%s,
              status='ready',last_error=NULL,attempts=CASE WHEN %s THEN attempts ELSE 0 END,
              lease_token=CASE WHEN %s THEN lease_token ELSE NULL END,
              lease_until=CASE WHEN %s THEN lease_until ELSE NULL END,
              discovery_after=CASE WHEN %s THEN discovery_after ELSE %s END,
              discovery_revision=CASE WHEN %s THEN discovery_revision ELSE %s END,
              next_due=CASE WHEN %s THEN next_due
                WHEN %s AND discovery_requested THEN clock_timestamp()+interval '5 seconds'
                ELSE clock_timestamp()+(%s*interval '1 second') END
              WHERE chain_id=%s AND kind=%s AND entity_id=%s""",
              (Jsonb(payload),observed_at,keep_lease,keep_lease,keep_lease,keep_lease,discovery_after,
               keep_lease,discovery_revision,keep_lease,metadata_only,delay,CHAIN_ID,kind,entity_id))
            inserted = 0
            for token, pool_id in links:
                result = conn.execute('INSERT INTO domino_public.token_pools(token,pool_id) VALUES(%s,%s) ON CONFLICT DO NOTHING', (token,pool_id))
                inserted += result.rowcount
            if inserted:
                conn.execute('UPDATE domino_public.state SET revision=revision+1 WHERE singleton')
        # Admit linked refreshes after the fenced publication to avoid locking
        # token->pool and pool->token rows in opposite orders. Links persist and
        # are revisited next refresh if admission is temporarily unavailable.
        for token, pool_id in links:
            self.ensure('pool',pool_id)
            self.ensure('token',token)

    def fail(self, claim, reason, *, delay=30, rejected=False):
        # Error messages are fixed internal codes, never provider bodies/URLs.
        if not isinstance(reason, str) or not reason.replace('_','').isalnum() or len(reason)>96:
            reason = 'upstream_unavailable'
        with self.connection(write=True) as conn:
            self.guard(conn, claim)
            conn.execute("""UPDATE domino_public.entities SET last_error=%s,
              status=CASE WHEN payload IS NOT NULL THEN 'ready' WHEN %s THEN 'rejected' ELSE 'pending' END,
              lease_token=NULL,lease_until=NULL,next_due=clock_timestamp()+(%s*interval '1 second')
              WHERE chain_id=%s AND kind=%s AND entity_id=%s""",
              (reason, rejected, max(1,min(86400,int(delay))), CHAIN_ID,claim['kind'],claim['entity_id']))

    def import_market(self, payload, observed_at):
        """Idempotent operator migration of the legacy snapshot, never a fresh read."""
        from read_contract import validate_response
        validate_response('pool-market',payload)
        if type(observed_at) is not int or not 0 <= observed_at <= int(self.clock()):
            raise DataError('invalid_request')
        pool_id = payload['poolId']
        with self.connection(write=True) as conn:
            changed = conn.execute("""INSERT INTO domino_public.entities(kind,entity_id,payload,observed_at,status)
              VALUES('pool',%s,%s,%s,'ready') ON CONFLICT(chain_id,kind,entity_id) DO UPDATE
              SET payload=EXCLUDED.payload,observed_at=EXCLUDED.observed_at,status='ready'
              WHERE domino_public.entities.lease_token IS NULL AND
                (domino_public.entities.observed_at IS NULL OR domino_public.entities.observed_at<EXCLUDED.observed_at)""",
              (pool_id,Jsonb(payload),observed_at)).rowcount
            if changed:
                inserted = 0
                for token in payload['pool']['currencies']:
                    inserted += conn.execute('INSERT INTO domino_public.token_pools(token,pool_id) VALUES(%s,%s) ON CONFLICT DO NOTHING',
                                             (token,pool_id)).rowcount
                if inserted:
                    conn.execute('UPDATE domino_public.state SET revision=revision+1 WHERE singleton')
        for token in payload['pool']['currencies']:
            self.ensure('token',token)
        return bool(changed)


def aged_market(payload, observed_at, now):
    """Recalculate served age without making a cached observation newly current."""
    result = deepcopy(payload)
    elapsed = max(0, int(now) - observed_at)
    market = result['market']
    cache = market.get('cache')
    if cache is not None and cache.get('ageSeconds') is not None:
        cache['ageSeconds'] += elapsed
        if market['status'] in ('available','stale'):
            if cache['ageSeconds'] > cache['maxStaleSeconds']:
                market.update(status='unavailable', data=None,
                              reason=market.get('reason') or 'provider_unavailable')
            elif cache['ageSeconds'] >= cache['freshForSeconds']:
                market['status'] = 'stale'
    return result
