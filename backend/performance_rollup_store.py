"""Owner-RLS minute projection queue and source/revision-fenced publication."""
from copy import deepcopy
import json

from psycopg.types.json import Jsonb

from performance_history_store import FinancialHistoryStore
from performance_rollup import (Summary,bucket_at,MINUTE,MAX_BUCKETS,MAX_BUCKET_BYTES,MAX_BUCKET_PAGES,summarize)
from performance_store import PerformanceStoreError,_identifier,_json
from read_deadline import check_read_deadline


class ProjectionStore(FinancialHistoryStore):
    @staticmethod
    def _projection_head(conn,owner,epoch,generation,lock=False):
        return conn.execute('SELECT * FROM projection_heads WHERE owner=%s AND epoch_id=%s AND replay_generation=%s'+
            (' FOR UPDATE' if lock else ''),(owner,epoch,generation)).fetchone()

    @staticmethod
    def _bucket_deltas(conn,owner,epoch,generation,start,end):
        params=(owner,epoch,generation,start,end)
        count=conn.execute("SELECT count(*) AS n,COALESCE(sum(octet_length((payload->'delta')::text)),0) AS bytes "
            'FROM financial_pages WHERE owner=%s AND epoch_id=%s AND replay_generation=%s AND through_timestamp BETWEEN %s AND %s',params).fetchone()
        if count['n']>MAX_BUCKET_PAGES or count['bytes']>MAX_BUCKET_BYTES:
            raise PerformanceStoreError('performance_store_unavailable')
        rows=conn.execute("SELECT payload->'delta' AS delta FROM financial_pages WHERE owner=%s AND epoch_id=%s AND replay_generation=%s "
            'AND through_timestamp BETWEEN %s AND %s ORDER BY from_block LIMIT %s',(*params,MAX_BUCKET_PAGES+1)).fetchall()
        following=conn.execute("SELECT payload->'delta' AS delta FROM financial_pages WHERE owner=%s AND epoch_id=%s AND replay_generation=%s "
            'AND through_timestamp>%s ORDER BY through_timestamp,from_block LIMIT 1',(owner,epoch,generation,end)).fetchone()
        if following is not None and following['delta']['fromCursor']['timestamp']<=end:
            rows.append(following)
        deltas=[];size=0
        for row in rows:
            payload,_=_json(row['delta'],MAX_BUCKET_BYTES)
            size+=len(json.dumps(payload,separators=(',',':')).encode())
            if size>MAX_BUCKET_BYTES: raise PerformanceStoreError('performance_store_unavailable')
            deltas.append(payload)
        return deltas

    def next_projection_job(self,owner,epoch_id):
        self._write();epoch_id=_identifier(epoch_id)
        def operation(conn,now,owner):
            epoch=self._row(conn,owner,epoch_id,lock=True)
            generation=epoch['replay_generation']
            financial=self._head(conn,owner,epoch_id,generation)
            if financial is None or epoch['status'] in ('baseline_reorged','replaying'): return None
            head=self._projection_head(conn,owner,epoch_id,generation,True)
            earliest=max(bucket_at(epoch['baseline']['baseline']['timestamp']),bucket_at(financial['cursor']['timestamp']-86400))
            if head is None:
                head=conn.execute('INSERT INTO projection_heads(owner,epoch_id,replay_generation,revision,next_bucket,created_at,updated_at) '
                    'VALUES(%s,%s,%s,1,%s,%s,%s) RETURNING *',(owner,epoch_id,generation,earliest,now,now)).fetchone()
            elif head['next_bucket']<earliest:
                head=conn.execute('UPDATE projection_heads SET next_bucket=%s,revision=revision+1,updated_at=%s '
                    'WHERE owner=%s AND epoch_id=%s AND replay_generation=%s RETURNING *',
                    (earliest,now,owner,epoch_id,generation)).fetchone()
            selected=head['next_bucket']
            existing=None
            if selected+MINUTE>=financial['cursor']['timestamp']:
                existing=conn.execute('SELECT * FROM projection_buckets WHERE owner=%s AND epoch_id=%s AND replay_generation=%s '
                    'AND bucket>=%s AND bucket+60<%s AND dirty ORDER BY bucket LIMIT 1',
                    (owner,epoch_id,generation,earliest,financial['cursor']['timestamp'])).fetchone()
                if existing is None: return None
                selected=existing['bucket']
            else:
                existing=conn.execute('SELECT * FROM projection_buckets WHERE owner=%s AND epoch_id=%s AND replay_generation=%s AND bucket=%s',
                    (owner,epoch_id,generation,selected)).fetchone()
            start=max(epoch['baseline']['baseline']['timestamp'],selected);end=selected+MINUTE
            return {'epoch':self._record(epoch),'financial':self._head_record(financial),'bucket':selected,
                'expectedProjectionRevision':head['revision'],'expectedBucketRevision':existing['revision'] if existing else None,
                'valuationBounds':{'start':start,'end':end},
                'deltas':self._bucket_deltas(conn,owner,epoch_id,generation,start,end)}
        return self._transaction(owner,operation)

    def publish_projection(self,owner,epoch_id,job,summary):
        self._write();epoch_id=_identifier(epoch_id)
        summary=Summary.model_validate(summary.model_dump() if isinstance(summary,Summary) else summary)
        payload,digest=_json(summary.model_dump(),32768)
        source,financial=job['epoch'],job['financial']
        if ((summary.owner,summary.epochId,summary.replayGeneration,summary.bucket)!=(owner,epoch_id,source['replayGeneration'],job['bucket'])
                or (summary.startsAt,summary.endsAt)!=(max(source['baseline']['baseline']['timestamp'],summary.bucket),summary.bucket+MINUTE)
                or job['valuationBounds']!={'start':summary.startsAt,'end':summary.endsAt}):
            raise PerformanceStoreError('performance_invalid_request')
        def operation(conn,now,owner):
            epoch=self._row(conn,owner,epoch_id,lock=True)
            generation=epoch['replay_generation']
            self._raw_fence(epoch,source['revision'],source['replayGeneration'])
            current=self._head(conn,owner,epoch_id,generation,lock=True)
            head=self._projection_head(conn,owner,epoch_id,generation,True)
            existing=conn.execute('SELECT * FROM projection_buckets WHERE owner=%s AND epoch_id=%s AND replay_generation=%s AND bucket=%s FOR UPDATE',
                (owner,epoch_id,generation,summary.bucket)).fetchone()
            if (current is None or current['revision']!=financial['revision'] or current['cursor']!=financial['cursor']
                    or head is None or head['revision']!=job['expectedProjectionRevision']
                    or (existing['revision'] if existing else None)!=job['expectedBucketRevision']
                    or summary.endsAt>=current['cursor']['timestamp']):
                raise PerformanceStoreError('performance_version_conflict')
            if existing:
                conn.execute('UPDATE projection_buckets SET revision=revision+1,source_raw_revision=%s,source_financial_revision=%s,'
                    'summary=%s,summary_hash=%s,dirty=false,updated_at=%s WHERE owner=%s AND epoch_id=%s AND replay_generation=%s AND bucket=%s',
                    (source['revision'],financial['revision'],Jsonb(payload),digest,now,owner,epoch_id,generation,summary.bucket))
            else:
                conn.execute('INSERT INTO projection_buckets(owner,epoch_id,replay_generation,bucket,revision,source_raw_revision,'
                    'source_financial_revision,summary,summary_hash,dirty,created_at,updated_at) VALUES(%s,%s,%s,%s,1,%s,%s,%s,%s,false,%s,%s)',
                    (owner,epoch_id,generation,summary.bucket,source['revision'],financial['revision'],Jsonb(payload),digest,now,now))
            if summary.bucket==head['next_bucket']:
                conn.execute('UPDATE projection_heads SET next_bucket=next_bucket+60,revision=revision+1,updated_at=%s '
                    'WHERE owner=%s AND epoch_id=%s AND replay_generation=%s',(now,owner,epoch_id,generation))
            return payload
        return self._transaction(owner,operation)

    def request_projection_refresh(self,owner,epoch_id,generation,buckets):
        self._write();epoch_id=_identifier(epoch_id)
        if (type(generation) is not int or generation<1 or type(buckets) is not list or len(buckets)>MAX_BUCKETS
                or len(set(buckets))!=len(buckets) or any(type(b) is not int or b<0 or b%MINUTE for b in buckets)):
            raise PerformanceStoreError('performance_invalid_request')
        if not buckets:return
        def operation(conn,now,owner):
            epoch=self._row(conn,owner,epoch_id)
            if epoch['replay_generation']!=generation: return
            conn.execute('UPDATE projection_buckets SET dirty=true,revision=revision+1,updated_at=%s '
                'WHERE owner=%s AND epoch_id=%s AND replay_generation=%s AND bucket=ANY(%s) AND NOT dirty',
                (now,owner,epoch_id,generation,buckets))
        self._transaction(owner,operation)

    def read_projection_window(self,owner,epoch_id):
        epoch_id=_identifier(epoch_id)
        def operation(conn,now,owner):
            epoch=self._row(conn,owner,epoch_id)
            generation=epoch['replay_generation'];head=self._head(conn,owner,epoch_id,generation)
            result={'epoch':self._record(epoch),'financial':self._head_record(head),'summaries':[],'edges':[],'missingBuckets':[]}
            if head is None or epoch['status']=='baseline_reorged':return result
            end=head['cursor']['timestamp'];start=max(epoch['baseline']['baseline']['timestamp'],end-86400)
            first,last=bucket_at(start),bucket_at(end)
            if (last-first)//MINUTE+1>MAX_BUCKETS:raise PerformanceStoreError('performance_store_unavailable')
            rows=conn.execute('SELECT * FROM projection_buckets WHERE owner=%s AND epoch_id=%s AND replay_generation=%s '
                'AND bucket BETWEEN %s AND %s ORDER BY bucket LIMIT %s',(owner,epoch_id,generation,first,last,MAX_BUCKETS+1)).fetchall()
            stored={row['bucket']:row for row in rows}
            for bucket in range(first,last+1,MINUTE):
                a,b=max(start,bucket),min(end,bucket+MINUTE)
                if b<a or b==a and start!=epoch['baseline']['baseline']['timestamp']:continue
                if bucket==first or bucket==last:
                    result['edges'].append({'bucket':bucket,'deltas':self._bucket_deltas(conn,owner,epoch_id,generation,a,b)})
                elif bucket not in stored:
                    result['missingBuckets'].append(bucket)
                else:
                    row=stored[bucket];payload,digest=_json(row['summary'],32768)
                    if digest!=row['summary_hash']:raise PerformanceStoreError('performance_idempotency_conflict')
                    result['summaries'].append({'bucket':bucket,'summary':payload,'dirty':row['dirty']})
            result['valuationBounds']={'start':start,'end':end}
            return result
        return self._transaction(owner,operation)


class ProjectionWorker:
    def __init__(self,store,valuation):self.store,self.valuation=store,valuation

    def advance(self,owner,epoch):
        job=self.store.next_projection_job(owner,epoch)
        if job is None:return 'caught_up'
        value=self.valuation(job)
        summary=summarize(job['epoch']['baseline'],job['financial'],job['deltas'],value,job['bucket'])
        check_read_deadline()
        self.store.publish_projection(owner,epoch,job,summary)
        return 'advanced'
