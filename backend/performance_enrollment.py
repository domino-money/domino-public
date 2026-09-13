"""Owner-RLS enrollment and durable leases. No provider access in HTTP requests."""
import hashlib
import secrets
from datetime import timedelta

from psycopg.types.json import Jsonb

from performance_models import MAX_EPOCHS
from performance_store import PerformanceStore, PerformanceStoreError, _identifier, _model
from performance_v2_models import EnrollRequest
from performance_v2_models import Error


class EnrollmentStore(PerformanceStore):
    @staticmethod
    def public(row):
        return {'enrollmentId': row['enrollment_id'], 'vault': row['vault'],
                'tokenIds': row['token_ids'], 'epochId': row['epoch_id'],
                'status': row['status'], 'reason': row['reason'], 'updatedAt': int(row['updated_at'].timestamp())}

    def enroll(self, owner, body, code_hash):
        self._write()
        request = EnrollRequest.model_validate(body)
        ids = sorted(request.tokenIds, key=int)
        code_hash = _identifier(code_hash)
        def operation(conn, now, owner):
            identifier = '0x'+hashlib.sha256(('domino-performance-enrollment-v2:'+owner+request.vault).encode()).hexdigest()
            self._lock(conn, owner, identifier)
            prior = conn.execute('SELECT * FROM enrollments WHERE owner=%s AND enrollment_id=%s FOR UPDATE', (owner, identifier)).fetchone()
            if prior:
                if prior['token_ids'] != ids or prior['vault_code_hash'] != code_hash:
                    raise PerformanceStoreError('performance_invalid_request')
                # Repeated consent cannot change the captured baseline or reset the measurement timer.
                row = conn.execute('UPDATE enrollments SET visible_until=%s,revision=revision+1,updated_at=%s '
                    'WHERE owner=%s AND enrollment_id=%s RETURNING *', (now+timedelta(seconds=90),now,owner,identifier)).fetchone()
            else:
                # The owner lock serializes the bounded enrollment count, including different vaults.
                self._lock(conn, owner, '0x'+'1'*64)
                if conn.execute('SELECT count(*) AS n FROM enrollments WHERE owner=%s', (owner,)).fetchone()['n'] >= MAX_EPOCHS:
                    raise Error('performance_enrollment_limit')
                row = conn.execute("INSERT INTO enrollments(owner,enrollment_id,vault,token_ids,vault_code_hash,epoch_id,revision,status,reason,"
                    "visible_until,due_at,created_at,updated_at) VALUES(%s,%s,%s,%s,%s,NULL,1,'queued','awaiting_baseline',%s,%s,%s,%s) RETURNING *",
                    (owner,identifier,request.vault,Jsonb(ids),code_hash,now+timedelta(seconds=90),now,now,now)).fetchone()
            return self.public(row)
        return self._transaction(owner, operation)

    def visible(self, owner, *, after=None, epoch_ids=None):
        self._write()
        after = _identifier(after) if after is not None else None
        identifiers = [_identifier(i) for i in epoch_ids] if epoch_ids is not None else None
        if identifiers is not None and not 1 <= len(identifiers) <= MAX_EPOCHS:
            raise PerformanceStoreError('performance_invalid_request')
        def operation(conn, now, owner):
            where, args = 'owner=%s', [owner]
            if after is not None:
                where += ' AND enrollment_id>%s'; args.append(after)
            if identifiers is not None:
                where += ' AND epoch_id=ANY(%s)'; args.append(identifiers)
            rows = conn.execute('SELECT * FROM enrollments WHERE '+where+' ORDER BY enrollment_id LIMIT 9', args).fetchall()
            selected = rows[:MAX_EPOCHS]
            if selected:
                conn.execute('UPDATE enrollments SET visible_until=%s,revision=revision+1,updated_at=%s WHERE owner=%s AND enrollment_id=ANY(%s)',
                    (now+timedelta(seconds=90),now,owner,[row['enrollment_id'] for row in selected]))
            return {'enrollments': [self.public(row) for row in selected],
                    'nextAfter': selected[-1]['enrollment_id'] if len(rows)>MAX_EPOCHS else None}
        return self._transaction(owner, operation)

    def claim(self, owner):
        self._write()
        def operation(conn, now, owner):
            row = conn.execute("SELECT * FROM enrollments WHERE owner=%s AND status<>'blocked' AND visible_until>%s AND due_at<=%s "
                'AND (lease_until IS NULL OR lease_until<=%s) ORDER BY due_at,enrollment_id LIMIT 1 FOR UPDATE SKIP LOCKED', (owner,now,now,now)).fetchone()
            if row is None: return None
            return conn.execute('UPDATE enrollments SET lease_id=%s,lease_until=%s,revision=revision+1,updated_at=%s '
                'WHERE owner=%s AND enrollment_id=%s RETURNING *',
                (secrets.token_hex(32),now+timedelta(seconds=45),now,owner,row['enrollment_id'])).fetchone()
        return self._transaction(owner, operation)

    @staticmethod
    def _leased(conn, now, owner, job):
        row = conn.execute('SELECT * FROM enrollments WHERE owner=%s AND enrollment_id=%s FOR UPDATE',
                           (owner,job['enrollment_id'])).fetchone()
        if row is None or row['lease_id'] != job['lease_id'] or row['lease_until'] <= now:
            raise PerformanceStoreError('performance_version_conflict')
        return row

    def bind_baseline(self, owner, job, baseline):
        """Atomic opening + enrollment binding: crash/retry cannot restart the epoch."""
        self._write()
        model, payload, digest = _model('Baseline', baseline, 262144)
        def operation(conn, now, owner):
            row = self._leased(conn, now, owner, job)
            if (model.owner != owner or model.vault != row['vault'] or model.vaultCodeHash != row['vault_code_hash']
                    or model.tokenIds != row['token_ids']):
                raise PerformanceStoreError('performance_invalid_request')
            if row['epoch_id'] is not None:
                if row['epoch_id'] != model.epochId: raise PerformanceStoreError('performance_idempotency_conflict')
                return self._record(self._row(conn, owner, row['epoch_id']))
            self._lock(conn,owner,model.epochId)
            prior = conn.execute('SELECT * FROM epochs WHERE owner=%s AND epoch_id=%s', (owner,model.epochId)).fetchone()
            if prior:
                if prior['baseline_hash'] != digest: raise PerformanceStoreError('performance_idempotency_conflict')
            else:
                prior = conn.execute("INSERT INTO epochs(owner,epoch_id,baseline,baseline_hash,cursor,revision,replay_generation,status,"
                    "page_count,receipt_count,event_count,created_at,updated_at) VALUES(%s,%s,%s,%s,%s,1,1,'active',0,0,0,%s,%s) RETURNING *",
                    (owner,model.epochId,Jsonb(payload),digest,Jsonb(payload['baseline']),now,now)).fetchone()
                self._transition(conn,owner,model.epochId,1,'capture',{'baselineHash':digest},now)
            conn.execute("UPDATE enrollments SET epoch_id=%s,status='tracking',reason='forward_collection',revision=revision+1,updated_at=%s "
                'WHERE owner=%s AND enrollment_id=%s', (model.epochId,now,owner,row['enrollment_id']))
            return self._record(prior)
        return self._transaction(owner,operation)

    def finish(self, owner, job, outcome):
        self._write()
        states = {'success': ('tracking','forward_collection',30), 'failed': ('stale','collection_failed',60),
                  'blocked': ('blocked','baseline_reorged',60)}
        if outcome not in states: raise PerformanceStoreError('performance_invalid_request')
        def operation(conn, now, owner):
            self._leased(conn,now,owner,job)
            status,reason,delay = states[outcome]
            conn.execute('UPDATE enrollments SET status=%s,reason=%s,due_at=%s,lease_id=NULL,lease_until=NULL,revision=revision+1,updated_at=%s '
                'WHERE owner=%s AND enrollment_id=%s', (status,reason,now+timedelta(seconds=delay),now,owner,job['enrollment_id']))
        return self._transaction(owner,operation)
