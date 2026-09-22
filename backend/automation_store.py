"""Worker-side persistence for the automation cycle: sequence leases, cycle
records, shared pool samples, operator controls and the ledger view offered to
the planner. Same fenced-transaction discipline as the unsigned store; the
publisher's journal is written elsewhere and only read here.
"""
from datetime import timedelta
import uuid

from psycopg.types.json import Jsonb

from execution_store import _Store, _hash, _owner, _worker, ExecutionStoreError, WORKER_ROLE, MAX_LEASE_SECONDS

TERMINAL = ('completed', 'abandoned')
PPM = 1_000_000


def _cycle_id(value):
    try:
        if type(value) is not str or str(uuid.UUID(value)) != value:
            raise ExecutionStoreError('execution_invalid_record')
    except (ValueError, AttributeError):
        raise ExecutionStoreError('execution_invalid_record') from None
    return value


def _reason(value):
    if type(value) is not str or len(value) > 100 or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789_' for c in value):
        raise ExecutionStoreError('execution_invalid_record')
    return value


class CycleStore(_Store):
    role = WORKER_ROLE

    # ------------------------------------------------------------ sequences
    def ensure_sequence(self, owner, sequence_hash, vault, pool_id, *, now):
        sequence_hash, pool_id = _hash(sequence_hash), _hash(pool_id)
        def operation(conn, owner):
            row = conn.execute('SELECT * FROM sequence_state WHERE owner=%s AND sequence_hash=%s', (owner, sequence_hash)).fetchone()
            if row is None:
                row = conn.execute('INSERT INTO sequence_state(owner,sequence_hash,vault,pool_id,waiting_since,last_attempt_at) '
                                   'VALUES(%s,%s,%s,%s,%s,%s) RETURNING *', (owner, sequence_hash, _owner(vault), pool_id, now, now)).fetchone()
            return self._sequence_row(row)
        return self._transaction(owner, operation)

    def sequence(self, owner, sequence_hash):
        sequence_hash = _hash(sequence_hash)
        def operation(conn, owner):
            row = conn.execute('SELECT * FROM sequence_state WHERE owner=%s AND sequence_hash=%s', (owner, sequence_hash)).fetchone()
            if row is None:
                raise ExecutionStoreError('execution_not_found')
            return self._sequence_row(row)
        return self._transaction(owner, operation)

    @staticmethod
    def _sequence_row(row):
        return {'sequenceHash': row['sequence_hash'], 'owner': row['owner'], 'vault': row['vault'], 'poolId': row['pool_id'],
                'waitingSince': int(row['waiting_since']), 'lastAttemptAt': int(row['last_attempt_at']),
                'lastReadFailed': row['last_read_failed'], 'suspended': row['suspended'], 'suspensionReason': row['suspension_reason'],
                'nextDueAt': row['next_due_at'].isoformat(), 'nextDueEpoch': row['next_due_at'].timestamp(),
                'backoffSeconds': row['backoff_seconds'], 'consecutiveFailures': row['consecutive_failures'],
                'publicationsInWindow': row['publications_in_window'],
                'publicationWindowStart': row['publication_window_start'].isoformat() if row['publication_window_start'] else None,
                'publicationWindowStartEpoch': row['publication_window_start'].timestamp() if row['publication_window_start'] else None,
                'fence': row['fence'], 'workerId': str(row['worker_id']) if row['worker_id'] else None,
                'leaseUntil': row['lease_until'].isoformat() if row['lease_until'] else None}

    def acquire_sequence(self, owner, sequence_hash, worker_id, *, lease_seconds):
        sequence_hash, worker = _hash(sequence_hash), _worker(worker_id)
        if type(lease_seconds) is not int or not 1 <= lease_seconds <= MAX_LEASE_SECONDS:
            raise ExecutionStoreError('execution_invalid_record')
        def operation(conn, owner):
            row = conn.execute('SELECT * FROM sequence_state WHERE owner=%s AND sequence_hash=%s FOR UPDATE', (owner, sequence_hash)).fetchone()
            if row is None:
                raise ExecutionStoreError('execution_not_found')
            now = conn.execute('SELECT clock_timestamp() AS now').fetchone()['now']
            if row['lease_until'] and row['lease_until'] > now:
                if str(row['worker_id']) == worker:
                    return self._sequence_row(row)
                raise ExecutionStoreError('execution_lease_busy')
            conn.execute("SELECT set_config('domino.execution_acquirer',%s,true)", (worker,))
            row = conn.execute('UPDATE sequence_state SET fence=fence+1,worker_id=%s,lease_until=%s,updated_at=clock_timestamp() '
                               'WHERE sequence_hash=%s RETURNING *', (worker, now + timedelta(seconds=lease_seconds), sequence_hash)).fetchone()
            return self._sequence_row(row)
        return self._transaction(owner, operation)

    def update_sequence(self, owner, sequence_hash, worker_id, fence, *, release=False, **fields):
        """Update scheduling fields under the live lease; optionally release it."""
        sequence_hash = _hash(sequence_hash)
        allowed = {'waiting_since', 'last_attempt_at', 'last_read_failed', 'suspended', 'suspension_reason', 'next_due_seconds',
                   'backoff_seconds', 'consecutive_failures', 'publications_in_window', 'publication_window_start_now'}
        if set(fields) - allowed:
            raise ExecutionStoreError('execution_invalid_record')
        if 'suspension_reason' in fields:
            _reason(fields['suspension_reason'])
        def operation(conn, owner):
            self._sequence_fence(conn, sequence_hash)
            sets, values = [], []
            for key, value in fields.items():
                if key == 'next_due_seconds':
                    sets.append('next_due_at=clock_timestamp()+make_interval(secs=>%s)'); values.append(int(value))
                elif key == 'publication_window_start_now':
                    sets.append('publication_window_start=CASE WHEN %s THEN clock_timestamp() ELSE publication_window_start END'); values.append(bool(value))
                else:
                    sets.append(f'{key}=%s'); values.append(value)
            if release:
                sets.append('worker_id=NULL'); sets.append('lease_until=NULL')
            sets.append('updated_at=clock_timestamp()')
            row = conn.execute(f'UPDATE sequence_state SET {",".join(sets)} WHERE sequence_hash=%s RETURNING *', (*values, sequence_hash)).fetchone()
            return self._sequence_row(row)
        return self._transaction(owner, operation, worker=worker_id, fence=fence)

    @staticmethod
    def _sequence_fence(conn, sequence_hash):
        conn.execute('SELECT domino_execution.sequence_fence(%s)', (sequence_hash,))

    # --------------------------------------------------------------- cycles
    def record_cycle(self, owner, sequence_hash, worker_id, fence, *, state, reason, config_version, fingerprint,
                     observation_hash, source_block_number, source_block_hash, decision, intent_id=None, observation_id=None):
        sequence_hash, cycle_id = _hash(sequence_hash), str(uuid.uuid4())
        _reason(reason)
        def operation(conn, owner):
            self._sequence_fence(conn, sequence_hash)
            conn.execute('INSERT INTO cycles(cycle_id,owner,sequence_hash,state,reason,config_version,input_fingerprint,observation_hash,'
                         'source_block_number,source_block_hash,decision,intent_id,observation_id) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                         (cycle_id, owner, sequence_hash, state, reason, config_version, _hash(fingerprint), _hash(observation_hash),
                          int(source_block_number), _hash(source_block_hash), Jsonb(decision),
                          _hash(intent_id) if intent_id else None, _hash(observation_id) if observation_id else None))
            return cycle_id
        return self._transaction(owner, operation, worker=worker_id, fence=fence)

    def update_cycle(self, owner, cycle_id, worker_id, fence, *, state, reason='', intent_id=None, observation_id=None, cost=None):
        cycle_id = _cycle_id(cycle_id)
        _reason(reason)
        def operation(conn, owner):
            row = conn.execute('SELECT * FROM cycles WHERE owner=%s AND cycle_id=%s FOR UPDATE', (owner, cycle_id)).fetchone()
            if row is None:
                raise ExecutionStoreError('execution_not_found')
            merged = {**row['cost'], **(cost or {})}
            conn.execute('UPDATE cycles SET state=%s,reason=%s,intent_id=coalesce(%s,intent_id),observation_id=coalesce(%s,observation_id),'
                         'cost=%s,updated_at=clock_timestamp() WHERE cycle_id=%s',
                         (state, reason, _hash(intent_id) if intent_id else None, _hash(observation_id) if observation_id else None,
                          Jsonb(merged), cycle_id))
            return self._cycle_row(conn.execute('SELECT * FROM cycles WHERE cycle_id=%s', (cycle_id,)).fetchone())
        return self._transaction(owner, operation, worker=worker_id, fence=fence)

    @staticmethod
    def _cycle_row(row):
        return {'cycleId': str(row['cycle_id']), 'owner': row['owner'], 'sequenceHash': row['sequence_hash'], 'state': row['state'],
                'reason': row['reason'], 'configVersion': row['config_version'], 'inputFingerprint': row['input_fingerprint'],
                'observationHash': row['observation_hash'], 'sourceBlockNumber': int(row['source_block_number']),
                'sourceBlockHash': row['source_block_hash'], 'decision': row['decision'], 'intentId': row['intent_id'],
                'observationId': row['observation_id'], 'cost': row['cost'], 'createdAt': row['created_at'].isoformat(),
                'updatedAt': row['updated_at'].isoformat()}

    def cycle(self, owner, cycle_id):
        cycle_id = _cycle_id(cycle_id)
        def operation(conn, owner):
            row = conn.execute('SELECT * FROM cycles WHERE owner=%s AND cycle_id=%s', (owner, cycle_id)).fetchone()
            if row is None:
                raise ExecutionStoreError('execution_not_found')
            return self._cycle_row(row)
        return self._transaction(owner, operation)

    def open_cycle(self, owner, sequence_hash):
        """The one cycle of this sequence that has bound an intent and not finished."""
        sequence_hash = _hash(sequence_hash)
        def operation(conn, owner):
            rows = conn.execute('SELECT * FROM cycles WHERE owner=%s AND sequence_hash=%s AND state NOT IN (%s,%s,%s) ORDER BY created_at DESC',
                                (owner, sequence_hash, 'evaluated', *TERMINAL)).fetchall()
            if len(rows) > 1:
                raise ExecutionStoreError('execution_state_conflict')
            return self._cycle_row(rows[0]) if rows else None
        return self._transaction(owner, operation)

    def recent_cycles(self, owner, sequence_hash, *, limit=10):
        sequence_hash = _hash(sequence_hash)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ExecutionStoreError('execution_invalid_record')
        def operation(conn, owner):
            rows = conn.execute('SELECT * FROM cycles WHERE owner=%s AND sequence_hash=%s ORDER BY created_at DESC LIMIT %s',
                                (owner, sequence_hash, limit)).fetchall()
            return [self._cycle_row(row) for row in rows]
        return self._transaction(owner, operation)

    def attempt_history(self, owner, sequence_hash, *, limit=20):
        """Of this sequence's latest cycles that paid for a publication, how
        many there were and how many completed. A sequence is evaluated only
        with no cycle open, so every one of them has finished."""
        sequence_hash = _hash(sequence_hash)
        if type(limit) is not int or not 1 <= limit <= 100:
            raise ExecutionStoreError('execution_invalid_record')
        def operation(conn, owner):
            row = conn.execute("SELECT count(*) AS attempted,count(*) FILTER(WHERE state='completed') AS completed FROM "
                               "(SELECT state FROM cycles WHERE owner=%s AND sequence_hash=%s AND cost ? 'publication' "
                               "ORDER BY created_at DESC LIMIT %s) s", (owner, sequence_hash, limit)).fetchone()
            return int(row['attempted']), int(row['completed'])
        return self._transaction(owner, operation)

    # ------------------------------------------------------- swap exposure
    @staticmethod
    def _exposure(conn, pool_id, since_block):
        row = conn.execute('SELECT coalesce(sum(usage_ppm),0) AS used FROM swap_exposure WHERE pool_id=%s AND NOT released '
                           'AND block_number>=%s', (pool_id, int(since_block))).fetchone()
        return int(row['used'])

    def swap_exposure(self, owner, pool_id, *, since_block):
        """The share of the pool's swap cap that live reservations of every
        tenant hold from `since_block` on, in millionths."""
        pool_id = _hash(pool_id)
        if type(since_block) is not int or since_block < 0:
            raise ExecutionStoreError('execution_invalid_record')
        return self._transaction(owner, lambda conn, owner: self._exposure(conn, pool_id, since_block))

    def reserve_swap(self, owner, sequence_hash, worker_id, fence, *, intent_id, pool_id, block_number, zero_for_one,
                     amount_in, cap_raw, usage_ppm, window_blocks):
        """Take this swap's share of the pool's cap, under a per-pool lock, or
        refuse with `execution_swap_cap_exhausted` when the window's live
        reservations of every vault would pass the whole cap."""
        sequence_hash, intent_id, pool_id = _hash(sequence_hash), _hash(intent_id), _hash(pool_id)
        if (type(block_number) is not int or block_number < 0 or type(zero_for_one) is not bool or type(amount_in) is not int
                or not 0 < amount_in < 2**128 or type(cap_raw) is not int or cap_raw <= 0 or type(usage_ppm) is not int
                or not 1 <= usage_ppm <= PPM or type(window_blocks) is not int or not 1 <= window_blocks <= 256):
            raise ExecutionStoreError('execution_invalid_record')
        def operation(conn, owner):
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('swap_exposure:'||%s,0))", (pool_id,))
            self._sequence_fence(conn, sequence_hash)
            used = self._exposure(conn, pool_id, max(0, block_number - window_blocks + 1))
            if used + usage_ppm > PPM:
                raise ExecutionStoreError('execution_swap_cap_exhausted')
            conn.execute('INSERT INTO swap_exposure(reservation_id,intent_id,owner,sequence_hash,pool_id,block_number,zero_for_one,amount_in,'
                         'cap_raw,usage_ppm) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)', (str(uuid.uuid4()), intent_id, owner, sequence_hash, pool_id,
                                                                                     block_number, zero_for_one, amount_in, cap_raw, usage_ppm))
            return {'usedPpm': used + usage_ppm, 'usagePpm': usage_ppm}
        return self._transaction(owner, operation, worker=worker_id, fence=fence)

    def release_swap(self, owner, sequence_hash, worker_id, fence, intent_id):
        """Give back the share of an intent that was cancelled before signing."""
        sequence_hash, intent_id = _hash(sequence_hash), _hash(intent_id)
        def operation(conn, owner):
            row = conn.execute('UPDATE swap_exposure SET released=true,updated_at=clock_timestamp() WHERE owner=%s AND intent_id=%s '
                               'AND sequence_hash=%s AND NOT released RETURNING intent_id', (owner, intent_id, sequence_hash)).fetchone()
            return row is not None
        return self._transaction(owner, operation, worker=worker_id, fence=fence)

    # --------------------------------------------------------------- ledger
    def available_lots(self, owner, sequence_hash):
        sequence_hash = _hash(sequence_hash)
        def operation(conn, owner):
            return conn.execute(
                'SELECT o.origin_id,o.lot_id,o.source_record,o.currency,o.kind,'
                'o.amount_raw-coalesce((SELECT sum(s.amount_raw) FROM spends s WHERE s.owner=o.owner AND s.lot_id=o.lot_id),0)'
                '-coalesce((SELECT sum(d.amount_raw) FROM withdrawal_debits d WHERE d.owner=o.owner AND d.lot_id=o.lot_id),0) AS remaining,'
                'coalesce((SELECT sum(c.amount_raw) FROM lot_claims c WHERE c.owner=o.owner AND c.lot_id=o.lot_id AND c.active),0) AS reserved '
                "FROM origins o WHERE o.owner=%s AND o.sequence_hash=%s AND o.state='available' ORDER BY o.lot_id", (owner, sequence_hash)).fetchall()
        return self._transaction(owner, operation)

    def pending_intents(self, owner, sequence_hash):
        """Intents still holding claims, and whether any left the sequence needing attention."""
        sequence_hash = _hash(sequence_hash)
        def operation(conn, owner):
            rows = conn.execute("SELECT i.intent_id,i.state AS intent_state,i.plan->>'action' AS action,"
                                "i.plan->'destination'->>'tokenId' AS destination,j.state AS journal_state "
                                'FROM intents i LEFT JOIN journal j USING(owner,intent_id) WHERE i.owner=%s AND i.sequence_hash=%s '
                                "AND i.state<>'cancelled' AND (j.state IS NULL OR j.state NOT IN ('reconciled','reverted'))", (owner, sequence_hash)).fetchall()
            attention = [r['intent_id'] for r in rows if r['journal_state'] in ('attention', 'reorged')]
            parents = {r['destination'] for r in rows if r['action'] == '3'}
            return {'pending': bool(rows), 'intents': [r['intent_id'] for r in rows], 'parents': frozenset(parents), 'attention': attention}
        return self._transaction(owner, operation)

    def recent_effects(self, owner, sequence_hash, *, limit=3):
        """Intents of this sequence whose canonical effect the ledger relies on, newest first."""
        sequence_hash = _hash(sequence_hash)
        def operation(conn, owner):
            # The worker may read only an effect's identity and canonicality.
            rows = conn.execute('SELECT e.intent_id FROM effects e JOIN intents i ON i.intent_id=e.intent_id WHERE i.owner=%s '
                                'AND i.sequence_hash=%s AND e.canonical ORDER BY i.created_at DESC LIMIT %s', (owner, sequence_hash, int(limit))).fetchall()
            return [row['intent_id'] for row in rows]
        return self._transaction(owner, operation)

    # --------------------------------------------------------------- ledger
    def unacknowledged_exceptions(self, owner, sequence_hash):
        """Fee events the ledger could not represent, until an operator acknowledges them."""
        sequence_hash = _hash(sequence_hash)
        def operation(conn, owner):
            rows = conn.execute('SELECT exception_id,kind,transaction_hash,block_number,intent_id FROM ledger_exceptions '
                                'WHERE owner=%s AND sequence_hash=%s AND NOT acknowledged ORDER BY block_number,transaction_hash', (owner, sequence_hash)).fetchall()
            return [{'exceptionId': r['exception_id'], 'kind': r['kind'], 'transactionHash': r['transaction_hash'],
                     'blockNumber': int(r['block_number']), 'intentId': r['intent_id']} for r in rows]
        return self._transaction(owner, operation)

    def ledger_summary(self, owner, sequence_hash, *, limit=5):
        """The worker's read of the reconciliation role's work: where the reader
        of vault events stands, the latest withdrawals, the latest exceptions."""
        sequence_hash = _hash(sequence_hash)
        def operation(conn, owner):
            cursor = conn.execute('SELECT block_number,block_hash,updated_at FROM ledger_cursors WHERE owner=%s AND sequence_hash=%s', (owner, sequence_hash)).fetchone()
            withdrawals = conn.execute('SELECT withdrawal_id,source_id,currency,transaction_hash,block_number,original_raw,charged_raw,'
                                       'unattributed_original_raw,unattributed_charged_raw FROM withdrawals WHERE owner=%s AND sequence_hash=%s '
                                       'ORDER BY block_number DESC,event_index DESC LIMIT %s', (owner, sequence_hash, int(limit))).fetchall()
            exceptions = conn.execute('SELECT exception_id,kind,transaction_hash,block_number,intent_id,acknowledged FROM ledger_exceptions '
                                      'WHERE owner=%s AND sequence_hash=%s ORDER BY block_number DESC,transaction_hash LIMIT %s', (owner, sequence_hash, int(limit))).fetchall()
            return {'cursor': None if cursor is None else {'blockNumber': int(cursor['block_number']), 'blockHash': cursor['block_hash'],
                                                            'updatedAt': cursor['updated_at'].isoformat()},
                    'withdrawals': [{'withdrawalId': w['withdrawal_id'], 'sourceId': w['source_id'], 'currency': w['currency'],
                                     'transactionHash': w['transaction_hash'], 'blockNumber': int(w['block_number']),
                                     'originalRaw': str(w['original_raw']), 'chargedRaw': str(w['charged_raw']),
                                     'unattributedOriginalRaw': str(w['unattributed_original_raw']),
                                     'unattributedChargedRaw': str(w['unattributed_charged_raw'])} for w in withdrawals],
                    'exceptions': [{'exceptionId': e['exception_id'], 'kind': e['kind'], 'transactionHash': e['transaction_hash'],
                                    'blockNumber': int(e['block_number']), 'intentId': e['intent_id'], 'acknowledged': e['acknowledged']} for e in exceptions]}
        return self._transaction(owner, operation)

    # --------------------------------------------------------------- shared
    def latest_sample(self, owner, pool_id):
        pool_id = _hash(pool_id)
        return self._transaction(owner, lambda conn, owner: conn.execute(
            'SELECT * FROM pool_samples WHERE pool_id=%s ORDER BY block_number DESC LIMIT 1', (pool_id,)).fetchone())

    def insert_sample(self, owner, row):
        def operation(conn, owner):
            conn.execute('INSERT INTO pool_samples(pool_id,block_number,block_hash,block_timestamp,epoch,fee_growth0,fee_growth1,liquidity,tick,'
                         'sqrt_price,cumulative_fee0,cumulative_fee1,cumulative_liquidity_seconds,coverage_complete,qualified,evidence_id,sampler_version) '
                         'VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) ON CONFLICT(pool_id,block_number) DO NOTHING',
                         tuple(row[key] for key in ('pool_id', 'block_number', 'block_hash', 'block_timestamp', 'epoch', 'fee_growth0', 'fee_growth1',
                                                    'liquidity', 'tick', 'sqrt_price', 'cumulative_fee0', 'cumulative_fee1', 'cumulative_liquidity_seconds',
                                                    'coverage_complete', 'qualified', 'evidence_id', 'sampler_version')))
        return self._transaction(owner, operation)

    def samples(self, owner, pool_id, *, since_timestamp, limit=512):
        pool_id = _hash(pool_id)
        return self._transaction(owner, lambda conn, owner: conn.execute(
            'SELECT * FROM (SELECT * FROM pool_samples WHERE pool_id=%s AND block_timestamp>=%s ORDER BY block_number DESC LIMIT %s) s ORDER BY block_number',
            (pool_id, int(since_timestamp), int(limit))).fetchall())

    def control(self, owner, key):
        row = self._transaction(owner, lambda conn, owner: conn.execute('SELECT value FROM controls WHERE key=%s', (key,)).fetchone())
        return None if row is None else row['value']

    def set_control(self, owner, key, value):
        if type(key) is not str or not key or len(key) > 64 or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789_' for c in key):
            raise ExecutionStoreError('execution_invalid_record')
        return self._transaction(owner, lambda conn, owner: conn.execute(
            'INSERT INTO controls(key,value) VALUES(%s,%s) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,updated_at=clock_timestamp()', (key, Jsonb(value))))

    def publication(self, owner, observation_id):
        observation_id = _hash(observation_id)
        return self._transaction(owner, lambda conn, owner: conn.execute(
            'SELECT observation_id,guard,pool_id,block_number,block_hash,block_timestamp,expires_at,sqrt_price,signer,transaction_hash,state,reason,'
            'included_block_number,included_block_hash,gas_used,effective_gas_price FROM publications WHERE observation_id=%s', (observation_id,)).fetchone())
