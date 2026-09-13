"""Private durable managed-performance collection journal, without chain authority.

Only trusted internal collector code may write acquired Baseline/Page evidence.
Model validation and SQL isolation do not turn a caller claim into canonicality
proof. The authenticated read service uses the separate SELECT-only role. Reorgs
retain orphan evidence; a changed baseline never moves history to a new owner.
"""
from copy import deepcopy
import hashlib
import json
import math
import re

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from discovery import DataError
from read_deadline import check_read_deadline, read_timeout

COLLECTOR_ROLE = 'domino_performance_collector'
READER_ROLE = 'domino_performance_reader'
MAX_REVISION = 2**53-1
MAX_LIST = 8
MAX_BASELINE_BYTES = 262144
MAX_PAGE_BYTES = 4194304
MAX_RECEIPT_BYTES = 262144
MAX_EVENT_BYTES = 8192
ERROR_CODES = frozenset(('performance_invalid_request','performance_not_found','performance_version_conflict',
    'performance_idempotency_conflict','performance_cursor_conflict','performance_epoch_blocked',
    'performance_read_only','performance_store_unavailable','request_timeout'))
HASH = re.compile(r'0x[0-9a-f]{64}\Z')
OWNER = re.compile(r'0x[0-9a-f]{40}\Z')
FAILURE = re.compile(r'[a-z][a-z0-9_]{0,95}\Z')


class PerformanceStoreError(Exception):
    def __init__(self, code):
        self.code = code if code in ERROR_CODES else 'performance_store_unavailable'
        super().__init__(self.code)


def _owner(value):
    if type(value) is not str or not OWNER.fullmatch(value) or value == '0x'+'0'*40:
        raise PerformanceStoreError('performance_invalid_request')
    return value


def _identifier(value):
    if type(value) is not str or not HASH.fullmatch(value):
        raise PerformanceStoreError('performance_invalid_request')
    return value


def _revision(value):
    if type(value) is not int or not 1 <= value < MAX_REVISION:
        raise PerformanceStoreError('performance_invalid_request')
    return value


def _json(value, maximum):
    def walk(item, depth=0):
        if depth > 24:
            raise ValueError()
        if item is None or type(item) in (str, int, bool):
            return
        if type(item) is list:
            for part in item: walk(part, depth+1)
        elif type(item) is dict and all(type(key) is str for key in item):
            for part in item.values(): walk(part, depth+1)
        else:
            raise ValueError()
    try:
        if type(value) is not dict: raise ValueError()
        walk(value)
        # Include jsonb's whitespace expansion in the database size bound.
        if len(json.dumps(value,ensure_ascii=False,sort_keys=True,allow_nan=False).encode()) > maximum:
            raise ValueError()
        text = json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False)
        return json.loads(text), hashlib.sha256(text.encode()).hexdigest()
    except (ValueError,TypeError,OverflowError,RecursionError,UnicodeError):
        raise PerformanceStoreError('performance_invalid_request') from None


def _model(name, value, maximum):
    # Lazy import keeps the store's validation helpers independently testable;
    # no alternate permissive schema is accepted if the collector is missing.
    from performance_collection import Baseline, Cursor, Page
    kind = {'Baseline':Baseline,'Cursor':Cursor,'Page':Page}[name]
    try:
        data = value.model_dump(mode='python') if isinstance(value,kind) else value
        record = kind.model_validate(data)
        encoded, digest = _json(record.model_dump(mode='json'),maximum)
        return record, encoded, digest
    except (ValueError,TypeError,AttributeError):
        raise PerformanceStoreError('performance_invalid_request') from None


class _Connection:
    def __init__(self, connection):
        self.connection = connection

    def execute(self, statement, params=None):
        check_read_deadline()
        millis = max(1,min(2000,int(read_timeout(2)*1000)))
        self.connection.execute(f'SET LOCAL statement_timeout={millis}')
        result = self.connection.execute(statement,params)
        check_read_deadline()
        return result


class PerformanceStore:
    def __init__(self, settings, *, role=READER_ROLE, connect=psycopg.connect):
        if type(settings) is not dict or set(settings) != {'host','port','dbname'}:
            raise ValueError('invalid_performance_database_settings')
        if role not in (COLLECTOR_ROLE,READER_ROLE):
            raise ValueError('invalid_performance_database_role')
        self.settings, self.role, self.connect = dict(settings), role, connect

    def _write(self):
        if self.role != COLLECTOR_ROLE:
            raise PerformanceStoreError('performance_read_only')

    def _transaction(self, owner, operation):
        owner = _owner(owner)
        try:
            check_read_deadline()
            with self.connect(**self.settings,user=self.role,row_factory=dict_row,
                    connect_timeout=max(1,math.ceil(read_timeout(2))),
                    options='-c statement_timeout=2000 -c lock_timeout=1000 '
                            '-c idle_in_transaction_session_timeout=5000 -c search_path=domino_performance -c TimeZone=UTC') as raw:
                conn = _Connection(raw)
                conn.execute("SELECT set_config('domino.performance_owner',%s,true)",(owner,))
                now = conn.execute('SELECT clock_timestamp() AS now').fetchone()['now']
                result = operation(conn,now,owner)
                check_read_deadline()
            return result
        except psycopg.errors.UniqueViolation:
            raise PerformanceStoreError('performance_idempotency_conflict') from None
        except psycopg.errors.LockNotAvailable:
            raise PerformanceStoreError('performance_version_conflict') from None
        except psycopg.Error:
            raise PerformanceStoreError('performance_store_unavailable') from None
        except DataError:
            raise PerformanceStoreError('request_timeout') from None

    @staticmethod
    def _lock(conn, owner, epoch_id):
        identity = int.from_bytes(hashlib.sha256((owner+epoch_id).encode()).digest()[:8],'big',signed=True)
        conn.execute('SELECT pg_advisory_xact_lock(%s)',(identity,))

    @staticmethod
    def _row(conn, owner, epoch_id, *, lock=False):
        row = conn.execute('SELECT * FROM epochs WHERE owner=%s AND epoch_id=%s'+(' FOR UPDATE' if lock else ''),
                           (owner,epoch_id)).fetchone()
        if row is None: raise PerformanceStoreError('performance_not_found')
        return row

    @staticmethod
    def _record(row):
        return {'owner':row['owner'],'epochId':row['epoch_id'],'baseline':deepcopy(row['baseline']),
                'cursor':deepcopy(row['cursor']),'revision':row['revision'],'replayGeneration':row['replay_generation'],
                'status':row['status'],'lastError':row['last_error'],'pageCount':row['page_count'],
                'receiptCount':row['receipt_count'],'eventCount':row['event_count'],
                'createdAt':int(row['created_at'].timestamp()),'updatedAt':int(row['updated_at'].timestamp())}

    @staticmethod
    def _fence(row, expected_revision):
        if row['status'] == 'baseline_reorged': raise PerformanceStoreError('performance_epoch_blocked')
        if row['revision'] != expected_revision: raise PerformanceStoreError('performance_version_conflict')
        if row['revision'] >= MAX_REVISION: raise PerformanceStoreError('performance_epoch_blocked')

    @staticmethod
    def _transition(conn, owner, epoch_id, revision, kind, payload, now):
        payload, _ = _json(payload,2048)
        conn.execute('INSERT INTO transitions(owner,epoch_id,revision,kind,payload,recorded_at) VALUES(%s,%s,%s,%s,%s,%s)',
                     (owner,epoch_id,revision,kind,Jsonb(payload),now))

    def create_epoch(self, baseline):
        self._write()
        record, payload, digest = _model('Baseline',baseline,MAX_BASELINE_BYTES)
        owner, epoch_id = _owner(record.owner), _identifier(record.epochId)
        cursor = payload['baseline']
        _json(cursor,1024)
        def operation(conn,now,owner):
            self._lock(conn,owner,epoch_id)
            prior = conn.execute('SELECT * FROM epochs WHERE owner=%s AND epoch_id=%s',(owner,epoch_id)).fetchone()
            if prior:
                if prior['baseline_hash'] != digest or prior['baseline'] != payload:
                    raise PerformanceStoreError('performance_idempotency_conflict')
                return self._record(prior)
            row = conn.execute("INSERT INTO epochs(owner,epoch_id,baseline,baseline_hash,cursor,revision,replay_generation,status,page_count,receipt_count,event_count,created_at,updated_at) "
                "VALUES(%s,%s,%s,%s,%s,1,1,'active',0,0,0,%s,%s) RETURNING *",
                (owner,epoch_id,Jsonb(payload),digest,Jsonb(cursor),now,now)).fetchone()
            self._transition(conn,owner,epoch_id,1,'capture',{'baselineHash':digest},now)
            return self._record(row)
        return self._transaction(owner,operation)

    def read_epoch(self, owner, epoch_id):
        epoch_id = _identifier(epoch_id)
        return self._transaction(owner,lambda conn,now,owner:self._record(self._row(conn,owner,epoch_id)))

    def list_epochs(self, owner, epoch_ids):
        if type(epoch_ids) is not list or not 1 <= len(epoch_ids) <= MAX_LIST:
            raise PerformanceStoreError('performance_invalid_request')
        identifiers = [_identifier(value) for value in epoch_ids]
        if len(set(identifiers)) != len(identifiers): raise PerformanceStoreError('performance_invalid_request')
        def operation(conn,now,owner):
            rows = conn.execute('SELECT * FROM epochs WHERE owner=%s AND epoch_id=ANY(%s)',(owner,identifiers)).fetchall()
            by_id = {row['epoch_id']:self._record(row) for row in rows}
            return [by_id[epoch_id] for epoch_id in identifiers if epoch_id in by_id]
        return self._transaction(owner,operation)

    @staticmethod
    def _include(conn, table, owner, epoch_id, generation, revision, record):
        # All interpolated identifiers are selected here, never supplied by a caller.
        receipt = table == 'receipts'
        columns = ('transaction_hash','block_hash') if receipt else ('event_id','block_hash')
        values = (record['transactionHash'],record['blockHash']) if receipt else (record['eventId'],record['blockHash'])
        predicate = ' AND '.join(f'{column}=%s' for column in columns)
        prior = conn.execute(f'SELECT * FROM {table} WHERE owner=%s AND epoch_id=%s AND {predicate} FOR UPDATE',
                             (owner,epoch_id,*values)).fetchone()
        if prior:
            if prior['payload'] != record or prior['canonical']:
                raise PerformanceStoreError('performance_idempotency_conflict')
            conn.execute(f'UPDATE {table} SET canonical=true,replay_generation=%s WHERE owner=%s AND epoch_id=%s AND {predicate}',
                         (generation,owner,epoch_id,*values))
            return
        if receipt:
            conn.execute('INSERT INTO receipts(owner,epoch_id,transaction_hash,block_hash,block_number,payload,first_seen_revision,replay_generation,canonical) '
                         'VALUES(%s,%s,%s,%s,%s,%s,%s,%s,true)',
                         (owner,epoch_id,record['transactionHash'],record['blockHash'],record['blockNumber'],Jsonb(record),revision,generation))
        else:
            conn.execute('INSERT INTO events(owner,epoch_id,event_id,transaction_hash,receipt_log_index,block_hash,block_number,payload,first_seen_revision,replay_generation,canonical) '
                         'VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,true)',
                         (owner,epoch_id,record['eventId'],record['transactionHash'],record['receiptLogIndex'],record['blockHash'],
                          record['blockNumber'],Jsonb(record),revision,generation))

    def append_page(self, owner, epoch_id, expected_revision, page):
        self._write()
        epoch_id, expected_revision = _identifier(epoch_id), _revision(expected_revision)
        record, payload, digest = _model('Page',page,MAX_PAGE_BYTES)
        if record.owner != _owner(owner) or record.epochId != epoch_id:
            raise PerformanceStoreError('performance_invalid_request')
        for receipt in payload['receipts']: _json(receipt,MAX_RECEIPT_BYTES)
        for event in payload['events']: _json(event,MAX_EVENT_BYTES)
        def operation(conn,now,owner):
            row = self._row(conn,owner,epoch_id,lock=True)
            if row['status'] == 'baseline_reorged': raise PerformanceStoreError('performance_epoch_blocked')
            prior = conn.execute('SELECT * FROM pages WHERE owner=%s AND epoch_id=%s AND replay_generation=%s AND from_block=%s',
                (owner,epoch_id,row['replay_generation'],record.fromCursor.blockNumber)).fetchone()
            if prior:
                if prior['page_hash'] == digest and prior['payload'] == payload and prior['previous_revision'] == expected_revision and prior['canonical']:
                    return self._record(row)  # Read-only acknowledgement, no stale mutation.
                raise PerformanceStoreError('performance_idempotency_conflict')
            self._fence(row,expected_revision)
            if payload['fromCursor'] != row['cursor'] or record.vault != row['baseline']['vault']:
                raise PerformanceStoreError('performance_cursor_conflict')
            revision, generation = row['revision']+1, row['replay_generation']
            conn.execute('INSERT INTO pages(owner,epoch_id,replay_generation,page_hash,from_block,through_block,previous_revision,applied_revision,payload,canonical) '
                'VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,true)',(owner,epoch_id,generation,digest,record.fromCursor.blockNumber,
                record.throughCursor.blockNumber,expected_revision,revision,Jsonb(payload)))
            for receipt in payload['receipts']: self._include(conn,'receipts',owner,epoch_id,generation,revision,receipt)
            for event in payload['events']: self._include(conn,'events',owner,epoch_id,generation,revision,event)
            result = conn.execute("UPDATE epochs SET cursor=%s,revision=revision+1,status='active',last_error=NULL,"
                'page_count=page_count+1,receipt_count=receipt_count+%s,event_count=event_count+%s,updated_at=%s '
                'WHERE owner=%s AND epoch_id=%s RETURNING *',
                (Jsonb(payload['throughCursor']),len(payload['receipts']),len(payload['events']),now,owner,epoch_id)).fetchone()
            self._transition(conn,owner,epoch_id,revision,'page',{'pageHash':digest},now)
            return self._record(result)
        return self._transaction(owner,operation)

    def record_failure(self, owner, epoch_id, expected_revision, code):
        self._write()
        epoch_id, expected_revision = _identifier(epoch_id), _revision(expected_revision)
        if type(code) is not str or not FAILURE.fullmatch(code): raise PerformanceStoreError('performance_invalid_request')
        def operation(conn,now,owner):
            row = self._row(conn,owner,epoch_id,lock=True)
            self._fence(row,expected_revision)
            result = conn.execute("UPDATE epochs SET revision=revision+1,status='read_failed',last_error=%s,updated_at=%s "
                'WHERE owner=%s AND epoch_id=%s RETURNING *',(code,now,owner,epoch_id)).fetchone()
            self._transition(conn,owner,epoch_id,row['revision']+1,'read_failure',{'code':code},now)
            return self._record(result)
        return self._transaction(owner,operation)

    def invalidate_reorg(self, owner, epoch_id, expected_revision, observed_baseline):
        self._write()
        epoch_id, expected_revision = _identifier(epoch_id), _revision(expected_revision)
        cursor, payload, _ = _model('Cursor',observed_baseline,1024)
        def operation(conn,now,owner):
            row = self._row(conn,owner,epoch_id,lock=True)
            self._fence(row,expected_revision)
            baseline = row['baseline']['baseline']
            if cursor.blockNumber != baseline['blockNumber']:
                raise PerformanceStoreError('performance_invalid_request')
            replayable = payload == baseline
            if row['replay_generation'] >= MAX_REVISION: raise PerformanceStoreError('performance_epoch_blocked')
            for table in ('pages','events','receipts'):
                conn.execute(f'UPDATE {table} SET canonical=false WHERE owner=%s AND epoch_id=%s AND canonical', (owner,epoch_id))
            status = 'replaying' if replayable else 'baseline_reorged'
            code = 'chain_reorg' if replayable else 'baseline_reorged'
            result = conn.execute('UPDATE epochs SET cursor=%s,revision=revision+1,replay_generation=replay_generation+1,status=%s,last_error=%s,'
                'page_count=0,receipt_count=0,event_count=0,updated_at=%s WHERE owner=%s AND epoch_id=%s RETURNING *',
                (Jsonb(baseline),status,code,now,owner,epoch_id)).fetchone()
            self._transition(conn,owner,epoch_id,row['revision']+1,'reorg' if replayable else 'baseline_reorg',
                             {'observedBaseline':payload},now)
            return self._record(result)
        return self._transaction(owner,operation)
