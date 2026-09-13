"""Private revision-fenced financial history derived from the canonical journal.

Financial acquisition runs outside SQL. Each commit rechecks the raw epoch and
page generation, then saves observations, effects and their reduced state in one
transaction. Old generations remain audit evidence but cannot be read as current.
"""
from copy import deepcopy
import json

import psycopg
from psycopg import IsolationLevel
from psycopg.types.json import Jsonb

from performance_collection import Baseline, Page
from performance_financial_collection import FinancialPoint, FinancialPage
from performance_history import (open_history, reduce_history, validate_history,
    MAX_WINDOW_PAGES, MAX_WINDOW_BYTES)
from performance_store import (PerformanceStore, PerformanceStoreError, MAX_REVISION,
    _owner, _identifier, _revision, _json, _model, FAILURE)


def _financial_model(kind, value, limit):
    try:
        model = kind.model_validate(value.model_dump() if isinstance(value,kind) else value)
        payload,digest = _json(model.model_dump(mode='json'),limit)
        return model,payload,digest
    except (ValueError,TypeError,AttributeError):
        raise PerformanceStoreError('performance_invalid_request') from None


class FinancialHistoryStore(PerformanceStore):
    def __init__(self, settings, *, role=None, connect=psycopg.connect):
        # One MVCC snapshot binds raw epoch/generation, financial head and pages.
        # The read role needs no UPDATE privilege or row locks for this fence.
        from performance_store import READER_ROLE
        def snapshot_connection(**kwargs):
            connection = connect(**kwargs)
            connection.isolation_level = IsolationLevel.REPEATABLE_READ
            return connection
        super().__init__(settings, role=READER_ROLE if role is None else role,
                         connect=snapshot_connection)

    @staticmethod
    def _head(conn, owner, epoch_id, generation, *, lock=False):
        return conn.execute('SELECT * FROM financial_heads WHERE owner=%s AND epoch_id=%s AND replay_generation=%s'+
            (' FOR UPDATE' if lock else ''),(owner,epoch_id,generation)).fetchone()

    @staticmethod
    def _head_record(row):
        if row is None:
            return None
        return {'owner':row['owner'],'epochId':row['epoch_id'],'replayGeneration':row['replay_generation'],
            'revision':row['revision'],'rawRevision':row['raw_revision'],'cursor':deepcopy(row['cursor']),
            'opening':deepcopy(row['opening']),'state':deepcopy(row['state']),
            'lastError':row['last_error'],'updatedAt':int(row['updated_at'].timestamp())}

    @staticmethod
    def _raw_fence(row, expected_raw_revision, generation):
        PerformanceStore._fence(row,expected_raw_revision)
        if row['replay_generation']!=generation:
            raise PerformanceStoreError('performance_version_conflict')

    def next_financial_page(self, owner, epoch_id):
        """One exact persisted raw page, never a scan over arbitrary owners."""
        epoch_id = _identifier(epoch_id)
        def operation(conn,now,owner):
            epoch = self._row(conn,owner,epoch_id)
            if epoch['status']=='baseline_reorged':
                raise PerformanceStoreError('performance_epoch_blocked')
            head = self._head(conn,owner,epoch_id,epoch['replay_generation'])
            result = {'epoch':self._record(epoch),'financial':self._head_record(head),'page':None,'pageHash':None}
            if head is None:
                return result
            if head['cursor']==epoch['cursor']:
                return result
            row = conn.execute('SELECT * FROM pages WHERE owner=%s AND epoch_id=%s AND replay_generation=%s AND from_block=%s AND canonical',
                (owner,epoch_id,epoch['replay_generation'],head['cursor']['blockNumber'])).fetchone()
            if row is None:
                raise PerformanceStoreError('performance_cursor_conflict')
            page,payload,digest = _model('Page',row['payload'],4194304)
            if digest!=row['page_hash'] or payload['fromCursor']!=head['cursor']:
                raise PerformanceStoreError('performance_idempotency_conflict')
            result.update(page=payload,pageHash=digest)
            return result
        return self._transaction(owner,operation)

    def create_financial_history(self, owner, epoch_id, expected_raw_revision, generation, point):
        self._write()
        epoch_id,expected_raw_revision = _identifier(epoch_id),_revision(expected_raw_revision)
        generation = _revision(generation)
        point,payload,digest = _financial_model(FinancialPoint,point,524288)
        if (point.owner,point.epochId)!=(_owner(owner),epoch_id) or point.status!='complete':
            raise PerformanceStoreError('performance_invalid_request')
        def operation(conn,now,owner):
            epoch = self._row(conn,owner,epoch_id,lock=True)
            self._raw_fence(epoch,expected_raw_revision,generation)
            baseline = Baseline.model_validate(epoch['baseline'])
            state = open_history(baseline,point)
            prior = self._head(conn,owner,epoch_id,generation,lock=True)
            if prior:
                if prior['opening_hash']!=digest or prior['opening']!=payload:
                    raise PerformanceStoreError('performance_idempotency_conflict')
                return self._head_record(prior)
            row = conn.execute('INSERT INTO financial_heads(owner,epoch_id,replay_generation,revision,raw_revision,cursor,opening,opening_hash,state,created_at,updated_at) '
                'VALUES(%s,%s,%s,1,%s,%s,%s,%s,%s,%s,%s) RETURNING *',
                (owner,epoch_id,generation,expected_raw_revision,Jsonb(point.block.model_dump()),Jsonb(payload),digest,
                 Jsonb(state.model_dump(mode='json')),now,now)).fetchone()
            return self._head_record(row)
        return self._transaction(owner,operation)

    def append_financial_page(self, owner, epoch_id, expected_raw_revision, generation,
                              expected_revision, raw_page, financial_page, reports):
        self._write()
        epoch_id,expected_raw_revision = _identifier(epoch_id),_revision(expected_raw_revision)
        generation,expected_revision = _revision(generation),_revision(expected_revision)
        raw,raw_payload,raw_digest = _model('Page',raw_page,4194304)
        financial,financial_payload,_ = _financial_model(FinancialPage,financial_page,4194304)
        if ((raw.owner,raw.epochId,raw.vault,raw.fromCursor,raw.throughCursor) !=
                (financial.owner,financial.epochId,financial.vault,financial.fromCursor,financial.throughCursor)
                or (raw.owner,raw.epochId)!=(_owner(owner),epoch_id)
                or [p.block for p in financial.points]!=raw.headers):
            raise PerformanceStoreError('performance_invalid_request')
        # The producer has already performed independent RPC verification. Store
        # a JSON-only snapshot; never accept executable/model objects as proof.
        evidence,_ = _json({'owner':owner,'epochId':epoch_id,'financialPage':financial_payload,'compoundReports':reports},8388608)
        _,evidence_digest = _json(evidence,8388608)
        def operation(conn,now,owner):
            epoch = self._row(conn,owner,epoch_id,lock=True)
            if epoch['status']=='baseline_reorged' or epoch['replay_generation']!=generation:
                raise PerformanceStoreError('performance_epoch_blocked')
            head = self._head(conn,owner,epoch_id,generation,lock=True)
            if head is None:
                raise PerformanceStoreError('performance_cursor_conflict')
            prior = conn.execute('SELECT * FROM financial_pages WHERE owner=%s AND epoch_id=%s AND replay_generation=%s AND from_block=%s',
                (owner,epoch_id,generation,raw.fromCursor.blockNumber)).fetchone()
            if prior:
                if (prior['page_hash']!=evidence_digest or prior['previous_revision']!=expected_revision
                        or prior['payload']['evidence']!=evidence or prior['raw_page_hash']!=raw_digest):
                    raise PerformanceStoreError('performance_idempotency_conflict')
                return self._head_record(head)
            self._raw_fence(epoch,expected_raw_revision,generation)
            if head['revision']!=expected_revision or head['revision']>=MAX_REVISION or head['cursor']!=raw_payload['fromCursor']:
                raise PerformanceStoreError('performance_version_conflict')
            stored = conn.execute('SELECT * FROM pages WHERE owner=%s AND epoch_id=%s AND replay_generation=%s AND from_block=%s AND canonical',
                (owner,epoch_id,generation,raw.fromCursor.blockNumber)).fetchone()
            if (stored is None or stored['page_hash']!=raw_digest or stored['payload']!=raw_payload
                    or raw_payload['throughCursor']['blockNumber']>epoch['cursor']['blockNumber']):
                raise PerformanceStoreError('performance_cursor_conflict')
            # A financial page must retain every raw receipt byte-for-byte, even
            # if its acquisition discovered additional managed pool transactions.
            complete_receipts = {r.transactionHash:r for r in financial.receipts}
            if any(complete_receipts.get(r.transactionHash)!=r for r in raw.receipts):
                raise PerformanceStoreError('performance_invalid_request')
            baseline = Baseline.model_validate(epoch['baseline'])
            state,delta = reduce_history(baseline,head['state'],financial,reports)
            delta['replayGeneration'] = generation
            payload,_ = _json({'owner':owner,'epochId':epoch_id,'evidence':evidence,'delta':delta},8388608)
            state_payload,_ = _json(state.model_dump(mode='json'),4194304)
            conn.execute('INSERT INTO financial_pages(owner,epoch_id,replay_generation,from_block,through_block,through_timestamp,previous_revision,applied_revision,raw_revision,raw_page_hash,page_hash,payload,recorded_at) '
                'VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                (owner,epoch_id,generation,raw.fromCursor.blockNumber,raw.throughCursor.blockNumber,raw.throughCursor.timestamp,
                 expected_revision,expected_revision+1,expected_raw_revision,raw_digest,evidence_digest,Jsonb(payload),now))
            row = conn.execute('UPDATE financial_heads SET revision=revision+1,raw_revision=%s,cursor=%s,state=%s,last_error=NULL,updated_at=%s '
                'WHERE owner=%s AND epoch_id=%s AND replay_generation=%s RETURNING *',
                (expected_raw_revision,Jsonb(raw_payload['throughCursor']),Jsonb(state_payload),now,owner,epoch_id,generation)).fetchone()
            return self._head_record(row)
        return self._transaction(owner,operation)

    def record_financial_failure(self, owner, epoch_id, expected_raw_revision, generation, expected_revision, code):
        self._write()
        epoch_id = _identifier(epoch_id)
        expected_raw_revision,generation,expected_revision = map(_revision,(expected_raw_revision,generation,expected_revision))
        if type(code) is not str or not FAILURE.fullmatch(code):
            raise PerformanceStoreError('performance_invalid_request')
        def operation(conn,now,owner):
            epoch = self._row(conn,owner,epoch_id,lock=True)
            self._raw_fence(epoch,expected_raw_revision,generation)
            head = self._head(conn,owner,epoch_id,generation,lock=True)
            if head is None or head['revision']!=expected_revision or head['revision']>=MAX_REVISION:
                raise PerformanceStoreError('performance_version_conflict')
            row = conn.execute('UPDATE financial_heads SET revision=revision+1,raw_revision=%s,last_error=%s,updated_at=%s '
                'WHERE owner=%s AND epoch_id=%s AND replay_generation=%s RETURNING *',
                (expected_raw_revision,code,now,owner,epoch_id,generation)).fetchone()
            return self._head_record(row)
        return self._transaction(owner,operation)

    def read_financial_window(self, owner, epoch_id):
        """Bounded private producer input, not a browser evidence endpoint."""
        epoch_id = _identifier(epoch_id)
        def operation(conn,now,owner):
            epoch = self._row(conn,owner,epoch_id)
            head = self._head(conn,owner,epoch_id,epoch['replay_generation'])
            result = {'epoch':self._record(epoch),'financial':self._head_record(head),'deltas':[]}
            if head is None or epoch['status']=='baseline_reorged':
                return result
            validate_history(epoch['baseline'],head['state'])
            start = max(epoch['baseline']['baseline']['timestamp'],head['cursor']['timestamp']-86400)
            comparison = '>=' if start == epoch['baseline']['baseline']['timestamp'] else '>'
            count = conn.execute("SELECT count(*) AS n,COALESCE(sum(octet_length((payload->'delta')::text)),0) AS bytes FROM financial_pages WHERE owner=%s AND epoch_id=%s AND replay_generation=%s AND through_timestamp"+comparison+"%s",
                (owner,epoch_id,epoch['replay_generation'],start)).fetchone()
            if count['n']>MAX_WINDOW_PAGES or count['bytes']>MAX_WINDOW_BYTES:
                raise PerformanceStoreError('performance_store_unavailable')
            rows = conn.execute("SELECT payload->'delta' AS delta FROM financial_pages WHERE owner=%s AND epoch_id=%s AND replay_generation=%s AND through_timestamp"+comparison+"%s ORDER BY from_block LIMIT %s",
                (owner,epoch_id,epoch['replay_generation'],start,MAX_WINDOW_PAGES+1)).fetchall()
            if len(rows)>MAX_WINDOW_PAGES:
                raise PerformanceStoreError('performance_store_unavailable')
            size = 0
            for row in rows:
                payload,_ = _json(row['delta'],8388608)
                size += len(json.dumps(payload,separators=(',',':')).encode())
                if size>MAX_WINDOW_BYTES:
                    raise PerformanceStoreError('performance_store_unavailable')
                result['deltas'].append(payload)
            return result
        return self._transaction(owner,operation)
