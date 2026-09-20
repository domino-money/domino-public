"""Bounded recent Swap history, independent of Initialize-to-head accounting.

Readers only query stored projections. Each worker tick fills one missing block
range, verifies exact event headers and canonical boundaries, and atomically
publishes coverage and ratio candles under a renewable-generation fence.
"""
from dataclasses import asdict
from decimal import Decimal, localcontext
import secrets
import time

from psycopg.types.json import Jsonb

from catalogue import checked_key, pool_lock_key
from catalogue_indexer import CatalogueIndexer, IndexRpc
from discovery import CHAIN_ID, POOL_MANAGER, Block, DataError, address, bytes32, parse_block, quantity
from indexer_io import AdaptiveSpan, HeaderBudget, RequestBudget, indexer_transport, read_headers
from pool_activity import SWAP, decode_activity
from public_data_contract import HistoryRequest, validate_response
from public_observations import PgPublicData
from read_deadline import read_deadline

WINDOWS = (86400,604800,2592000)
RESOLUTIONS = (60,3600,86400)


def price_text(value):
    result = format(value,'f').rstrip('0').rstrip('.') if '.' in format(value,'f') else format(value,'f')
    if not result or len(result)>224 or value<=0:
        raise DataError('history_price_out_of_bounds')
    return result


def ratios(sqrt, decimals0, decimals1):
    # Both directions are computed from the exact integer ratio, not the rounded
    # reciprocal of a displayed price. Never binary float or an assumed decimal.
    with localcontext() as ctx:
        ctx.prec=160
        raw=Decimal(sqrt)**2 / Decimal(2**192)
        ratio=raw * Decimal(10)**(decimals0-decimals1)
        return Decimal(price_text(ratio)),Decimal(price_text(1/ratio))


def aggregate(events,currencies,decimals):
    grouped={}
    for event in events:
        values=ratios(int(event['payload']['sqrtPriceX96']),*decimals)
        position=(event['blockNumber'],event['logIndex'])
        for index,currency in enumerate(currencies):
            for resolution in RESOLUTIONS:
                start=event['timestamp']//resolution*resolution
                key=(currency,resolution,start)
                value=values[index]
                if key not in grouped:
                    grouped[key]={'currency':currency,'quote':currencies[1-index],
                        'resolution':resolution,'start':start,'open':value,'high':value,
                        'low':value,'close':value,'count':1,'first':position,'last':position}
                else:
                    row=grouped[key]
                    row.update(high=max(row['high'],value),low=min(row['low'],value),
                               close=value,count=row['count']+1,last=position)
    return list(grouped.values())


def intervals(rows,start,end):
    """Union exact covered timestamp intervals and return their complement."""
    covered=[]
    for row in sorted(rows,key=lambda item:item['before_timestamp']):
        lo=max(start,row['before_timestamp']);hi=min(end,row['end_timestamp'])
        if lo>=hi:continue
        if covered and lo<=covered[-1]['endTimestamp']:
            covered[-1]['endTimestamp']=max(covered[-1]['endTimestamp'],hi)
        else:covered.append({'startTimestamp':lo,'endTimestamp':hi})
    gaps=[];cursor=start
    for row in covered:
        if cursor<row['startTimestamp']:gaps.append({'startTimestamp':cursor,'endTimestamp':row['startTimestamp']})
        cursor=row['endTimestamp']
    if cursor<end:gaps.append({'startTimestamp':cursor,'endTimestamp':end})
    return covered,gaps


def verify_boundary(chain,timestamp,head,lower):
    """Prove a cached boundary against this exact target and requested window."""
    if type(lower) is not int or not 1<=lower<=head.number+1:
        raise DataError('history_timestamp_boundary_mismatch')
    # Prove the located adjacent boundary; timestamp monotonicity is a chain
    # invariant, and checking both sides refuses provider/binary-search drift.
    numbers=[lower-1]+([lower] if lower<=head.number else [])
    blocks=read_headers(chain.rpc,numbers)
    before=blocks[lower-1]
    if (lower>1 and before.timestamp>timestamp) or (lower<=head.number and blocks[lower].timestamp<=timestamp):
        raise DataError('history_timestamp_boundary_mismatch')
    return lower


def first_after(chain, timestamp, head):
    """Exact monotonic search with bounded parallel pivots; no block-time guess.

    Eight headers share one envelope. This trades a bounded number of RPC items
    for fewer serial round trips, leaving the worker budget for logs and commit.
    Every item still spends the transport's RequestBudget.
    """
    low,high=1,head.number+1
    width=8 if callable(getattr(chain.rpc,'batch',None)) else 1
    while low<high:
        count=min(width,high-low)
        numbers=sorted({low+(high-low)*i//(count+1) for i in range(1,count+1)})
        blocks=read_headers(chain.rpc,[number for number in numbers if number!=head.number])
        if head.number in numbers:blocks[head.number]=head
        ordered=[blocks[number] for number in numbers]
        if any(a.timestamp>b.timestamp for a,b in zip(ordered,ordered[1:])):
            raise DataError('history_timestamp_boundary_mismatch')
        for block in ordered:
            if block.timestamp<=timestamp:low=block.number+1
            else:
                high=block.number
                break
    verify_boundary(chain,timestamp,head,low)
    return low


def missing_range(rows,lower,upper,span):
    """Newest unacquired block interval; old coverage cannot hide an interior gap."""
    cursor=upper
    for row in sorted(rows,key=lambda item:item['start_block'],reverse=True):
        if row['start_block']>cursor:continue
        if row['end_block']>=cursor:
            cursor=row['start_block']-1
        else:
            return (max(lower,row['end_block']+1,cursor-span+1),cursor) if cursor>=lower else None
    return (max(lower,cursor-span+1),cursor) if cursor>=lower else None


class PublicHistory:
    def __init__(self,catalogue,*,writer=False,clock=time.time):
        self.catalogue,self.clock=catalogue,clock
        self.store=PgPublicData(catalogue,writer=writer,clock=clock)

    def request(self,pool_id,window_seconds):
        pool_id=bytes32(pool_id)
        if type(window_seconds) is not int or window_seconds not in WINDOWS:raise DataError('invalid_request')
        with self.store.connection() as conn:
            return conn.execute('SELECT domino_public.request_history(%s,%s) AS accepted',
                                (pool_id,window_seconds)).fetchone()['accepted']

    @staticmethod
    def identity(conn,pool_id):
        row=conn.execute('''SELECT pool_key FROM domino_catalogue.events WHERE pool_id=%s
          UNION ALL SELECT pool_key FROM domino_catalogue.hints WHERE pool_id=%s LIMIT 1''',
          (pool_id,pool_id)).fetchone()
        if row is None:raise DataError('pool_not_in_catalogue')
        key=checked_key(row['pool_key'],pool_id)
        currencies=(key.currency0,key.currency1)
        tokens=conn.execute("SELECT entity_id,payload FROM domino_public.entities WHERE kind='token' AND entity_id=ANY(%s)",
                            (list(currencies),)).fetchall()
        metadata={row['entity_id']:row['payload'] for row in tokens}
        decimals=[]
        for currency in currencies:
            payload=metadata.get(currency)
            value=payload.get('asset',{}).get('decimals') if payload else None
            if type(value) is not int or not 0<=value<=255:raise DataError('history_token_metadata_unavailable')
            decimals.append(value)
        return currencies,decimals

    def read(self,pool_id,currency,window_seconds,resolution_seconds):
        HistoryRequest.model_validate(dict(poolId=pool_id,currency=currency,windowSeconds=window_seconds,
                                           resolutionSeconds=resolution_seconds),strict=True)
        pool_id,currency=bytes32(pool_id),address(currency)
        now=int(self.clock());reason=None;quote=None
        with self.store.connection() as conn:
            conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            try:
                currencies,decimals=self.identity(conn,pool_id)
                if currency not in currencies:raise DataError('selected_currency_not_in_pool')
                quote=currencies[1-currencies.index(currency)]
            except DataError as error:reason=str(error)
            rows=conn.execute('SELECT * FROM domino_public.history_coverage WHERE pool_id=%s ORDER BY start_block',
                              (pool_id,)).fetchall()
            if quote and any(row['denomination']!={'currencies':list(currencies),'decimals':decimals} for row in rows):
                rows=[];reason='history_token_metadata_changed';quote=None
            job=conn.execute('SELECT last_error FROM domino_public.history_jobs WHERE pool_id=%s AND window_seconds=%s',
                             (pool_id,window_seconds)).fetchone()
            snapshot=max(rows,key=lambda row:row['end_block']) if rows else None
            end=snapshot['end_timestamp'] if snapshot else now
            start=max(0,end-window_seconds)
            covered,gaps=intervals(rows,start,end)
            candles=conn.execute('''SELECT * FROM domino_public.history_candles WHERE pool_id=%s AND currency=%s
              AND resolution_seconds=%s AND start_timestamp+resolution_seconds>%s AND start_timestamp<%s
              ORDER BY start_timestamp LIMIT 601''',(pool_id,currency,resolution_seconds,start,end)).fetchall() if quote else []
        if len(covered)>128 or len(candles)>600:raise DataError('history_projection_budget_exhausted')
        status='unavailable' if reason else 'not_built' if snapshot is None else 'partial' if gaps else 'available'
        if reason is None and snapshot and now-snapshot['end_timestamp']>120:status='stale'
        if reason is None:
            reason=('history_refresh_pending' if status=='stale' else 'history_acquisition_pending' if status in ('not_built','partial') else None)
            if job and job['last_error'] and status!='available':reason=job['last_error']
        result={'schemaVersion':1,'chainId':CHAIN_ID,'poolManager':POOL_MANAGER,'poolId':pool_id,
            'currency':currency,'quoteCurrency':quote,'source':'robinhood_pool_swap_logs',
            'methodology':'pool_ratio_v1','unit':'quote_per_base','status':status,'reason':reason,
            'requestedWindow':{'startTimestamp':start,'endTimestamp':end},'resolutionSeconds':resolution_seconds,
            'snapshot':{'number':snapshot['end_block'],'hash':snapshot['end_hash'],'timestamp':end} if snapshot else None,
            'covered':covered,'gaps':gaps,'candles':[], 'acquisitionAccepted':False,'executionAvailable':False}
        for row in candles:
            begin=row['start_timestamp'];finish=begin+resolution_seconds
            result['candles'].append({'startTimestamp':begin,**{key:price_text(row[key]) for key in ('open','high','low','close')},
                'swapCount':row['swap_count'],'complete':begin>=start and finish<=end and any(
                    x['before_timestamp']<begin and x['end_timestamp']>=finish for x in rows)})
        return validate_response('history',result)

    def claim(self,*,lease_seconds=90):
        with self.store.connection(write=True) as conn:
            # Three claims favor recently requested pools; the fourth favors
            # background work. Persist the cadence in existing generations so
            # restarts cannot repeatedly reset and starve the background lane.
            # This lock covers only selection/update, never acquisition I/O.
            conn.execute('SELECT pg_advisory_xact_lock(46630251)')
            background=conn.execute('''SELECT mod(COALESCE(sum(generation),0),4)=3 AS turn
              FROM domino_public.history_jobs''').fetchone()['turn']
            return conn.execute('''UPDATE domino_public.history_jobs j SET lease_token=%s,
              lease_until=clock_timestamp()+(%s*interval '1 second'),generation=j.generation+1,attempts=j.attempts+1
              WHERE (j.pool_id,j.window_seconds)=(SELECT pool_id,window_seconds FROM domino_public.history_jobs q
                WHERE next_due<=clock_timestamp() AND (lease_until IS NULL OR lease_until<clock_timestamp())
                AND (window_seconds=86400 OR EXISTS(SELECT 1 FROM domino_public.history_jobs recent
                  WHERE recent.pool_id=q.pool_id AND recent.window_seconds=86400 AND recent.completed_at IS NOT NULL))
                ORDER BY CASE WHEN EXISTS(SELECT 1 FROM domino_public.entities e
                  WHERE e.kind='pool' AND e.entity_id=q.pool_id
                    AND e.last_requested_at>=clock_timestamp()-interval '60 seconds')=%s THEN 1 ELSE 0 END,
                  window_seconds,next_due,pool_id FOR UPDATE SKIP LOCKED LIMIT 1)
              RETURNING *''',(secrets.token_hex(16),lease_seconds,background)).fetchone()

    @staticmethod
    def guard(conn,claim):
        row=conn.execute('''SELECT pool_id FROM domino_public.history_jobs WHERE pool_id=%s AND window_seconds=%s
          AND generation=%s AND lease_token=%s AND lease_until>clock_timestamp() FOR UPDATE''',
          (claim['pool_id'],claim['window_seconds'],claim['generation'],claim['lease_token'])).fetchone()
        if row is None:raise DataError('history_lease_lost')

    @staticmethod
    def finish(conn,claim,*,complete=False,reason=None,span=None,span_successes=None):
        delay=min(900,5*2**min(8,claim['attempts']-1)) if reason else (30 if complete else 1)
        conn.execute('''UPDATE domino_public.history_jobs SET lease_token=NULL,lease_until=NULL,
          next_due=clock_timestamp()+(%s*interval '1 second'),last_error=%s,
          attempts=CASE WHEN %s::text IS NULL THEN 0 ELSE attempts END,
          span_blocks=COALESCE(%s,span_blocks),
          span_successes=CASE WHEN %s::text IS NOT NULL THEN 0 ELSE COALESCE(%s,span_successes) END,
          completed_at=CASE WHEN %s THEN clock_timestamp() ELSE completed_at END,
          target=CASE WHEN %s THEN NULL ELSE target END
          WHERE pool_id=%s AND window_seconds=%s''',
          (delay,reason,reason,span,reason,span_successes,complete,complete,claim['pool_id'],claim['window_seconds']))

    def invalidate(self,claim,reason='history_snapshot_reorganized'):
        with self.store.connection(write=True) as conn:
            conn.execute('SELECT pg_advisory_xact_lock(%s)',(pool_lock_key(claim['pool_id']),))
            self.guard(conn,claim)
            for table in ('history_coverage','history_swaps','history_candles'):
                conn.execute(f'DELETE FROM domino_public.{table} WHERE pool_id=%s',(claim['pool_id'],))
            # Invalidate other window leases too: no old-branch worker may publish.
            conn.execute('''UPDATE domino_public.history_jobs SET completed_at=NULL,target=NULL,span_successes=0,generation=generation+1,
              lease_token=NULL,lease_until=NULL,last_error=%s,next_due=clock_timestamp()
              WHERE pool_id=%s''',(reason,claim['pool_id']))

    def publish(self,claim,before,end,events,candles,*,span,complete=False,denomination=None,span_successes=None):
        with self.store.connection(write=True) as conn:
            conn.execute('SELECT pg_advisory_xact_lock(%s)',(pool_lock_key(claim['pool_id']),))
            self.guard(conn,claim)
            currencies,decimals=self.identity(conn,claim['pool_id'])
            current={'currencies':list(currencies),'decimals':decimals}
            if denomination is not None and current!=denomination:raise DataError('history_token_metadata_changed')
            overlaps=conn.execute('''SELECT 1 FROM domino_public.history_coverage WHERE pool_id=%s
              AND start_block<=%s AND end_block>%s LIMIT 1''',(claim['pool_id'],end.number,before.number)).fetchone()
            if overlaps:raise DataError('history_range_changed')
            for event in events:
                conn.execute('''INSERT INTO domino_public.history_swaps(pool_id,block_number,log_index,block_hash,
                  transaction_hash,timestamp,sqrt_price_x96) VALUES(%s,%s,%s,%s,%s,%s,%s)''',
                  (claim['pool_id'],event['blockNumber'],event['logIndex'],event['blockHash'],event['transactionHash'],
                   event['timestamp'],event['payload']['sqrtPriceX96']))
            for row in candles:
                conn.execute('''INSERT INTO domino_public.history_candles AS c
                  (pool_id,currency,quote_currency,resolution_seconds,start_timestamp,open,high,low,close,swap_count,
                   first_block,first_log,last_block,last_log) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                  ON CONFLICT(pool_id,currency,resolution_seconds,start_timestamp) DO UPDATE SET
                  open=CASE WHEN (EXCLUDED.first_block,EXCLUDED.first_log)<(c.first_block,c.first_log) THEN EXCLUDED.open ELSE c.open END,
                  close=CASE WHEN (EXCLUDED.last_block,EXCLUDED.last_log)>(c.last_block,c.last_log) THEN EXCLUDED.close ELSE c.close END,
                  high=GREATEST(c.high,EXCLUDED.high),low=LEAST(c.low,EXCLUDED.low),swap_count=c.swap_count+EXCLUDED.swap_count,
                  first_block=CASE WHEN (EXCLUDED.first_block,EXCLUDED.first_log)<(c.first_block,c.first_log) THEN EXCLUDED.first_block ELSE c.first_block END,
                  first_log=CASE WHEN (EXCLUDED.first_block,EXCLUDED.first_log)<(c.first_block,c.first_log) THEN EXCLUDED.first_log ELSE c.first_log END,
                  last_block=CASE WHEN (EXCLUDED.last_block,EXCLUDED.last_log)>(c.last_block,c.last_log) THEN EXCLUDED.last_block ELSE c.last_block END,
                  last_log=CASE WHEN (EXCLUDED.last_block,EXCLUDED.last_log)>(c.last_block,c.last_log) THEN EXCLUDED.last_log ELSE c.last_log END''',
                  (claim['pool_id'],row['currency'],row['quote'],row['resolution'],row['start'],row['open'],row['high'],
                   row['low'],row['close'],row['count'],*row['first'],*row['last']))
            conn.execute('''INSERT INTO domino_public.history_coverage
              (pool_id,start_block,end_block,before_timestamp,end_timestamp,end_hash,checked_at,denomination) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)''',
              (claim['pool_id'],before.number+1,end.number,before.timestamp,end.timestamp,end.hash,int(self.clock()),Jsonb(current)))
            self.merge_coverage(conn,claim['pool_id'])
            # Request windows bound the response, never retention. Preserve
            # acquired events/candles until a separately reviewed archival
            # policy exists; reorg/denomination invalidation remains explicit.
            self.finish(conn,claim,complete=complete,span=span,span_successes=span_successes)

    @staticmethod
    def merge_coverage(conn,pool_id):
        rows=conn.execute('SELECT * FROM domino_public.history_coverage WHERE pool_id=%s ORDER BY start_block',(pool_id,)).fetchall()
        previous=None
        for row in rows:
            if previous and previous['end_block']+1==row['start_block']:
                if previous['end_timestamp']!=row['before_timestamp']:raise DataError('history_timestamp_boundary_mismatch')
                if previous['denomination']!=row['denomination']:raise DataError('history_token_metadata_changed')
                conn.execute('''UPDATE domino_public.history_coverage SET end_block=%s,end_timestamp=%s,end_hash=%s,checked_at=%s
                  WHERE pool_id=%s AND start_block=%s''',(row['end_block'],row['end_timestamp'],row['end_hash'],row['checked_at'],pool_id,previous['start_block']))
                conn.execute('DELETE FROM domino_public.history_coverage WHERE pool_id=%s AND start_block=%s',(pool_id,row['start_block']))
                previous.update(end_block=row['end_block'],end_timestamp=row['end_timestamp'])
            else:previous=row

    def tick(self,service,*,budget_seconds=30,max_rpc_calls=2048):
        if not 1<=budget_seconds<=90 or not 32<=max_rpc_calls<=20000:raise DataError('invalid_history_budget')
        claim=self.claim(lease_seconds=int(budget_seconds)+30)
        if claim is None:return {'status':'idle','rpcCalls':0}
        budget=RequestBudget(max_rpc_calls)
        span=AdaptiveSpan(claim['span_blocks'],floor=1)
        span.successes=claim['span_successes']
        try:
            with read_deadline(budget_seconds):
                transport=indexer_transport(budget_seconds,request_timeout=min(10,budget_seconds),budget=budget)
                current=service._rpc(transport)
                if quantity(current.request('eth_chainId'))!=CHAIN_ID:raise DataError('wrong_chain')
                head=parse_block(current.request('eth_getBlockByNumber',['latest',False]))
                if not -15<=self.clock()-head.timestamp<=120:raise DataError('stale_or_future_block')
                url=service.historical_rpc_url or (service.rpc_urls[0] if service.rpc_urls else service.rpc_url)
                history=IndexRpc(url,transport=transport,max_requests=max_rpc_calls,batch_reads=True)
                chain=CatalogueIndexer(self.catalogue,history);chain.check_chain()
                stored_target=claim['target']
                if stored_target:
                    if (not isinstance(stored_target,dict) or
                        any(type(stored_target.get(key)) is not int for key in ('number','timestamp')) or
                        stored_target['number']<1 or stored_target['timestamp']<0):
                        raise DataError('invalid_history_target')
                    target=Block(stored_target['number'],bytes32(stored_target.get('hash')),stored_target['timestamp'])
                else:target=chain.block(max(1,head.number-100))
                # Pin one acquisition cycle. Otherwise every tick would spend
                # itself on the new tail and never advance the recent backfill.
                if not claim['target']:
                    with self.store.connection(write=True) as conn:
                        self.guard(conn,claim)
                        conn.execute('UPDATE domino_public.history_jobs SET target=%s WHERE pool_id=%s AND window_seconds=%s',
                                     (Jsonb(asdict(target)),claim['pool_id'],claim['window_seconds']))
                if chain.block(target.number)!=target:
                    self.invalidate(claim)
                    return {'status':'rewound','rpcCalls':budget.calls}
                with self.store.connection() as conn:
                    currencies,decimals=self.identity(conn,claim['pool_id'])
                    rows=conn.execute('SELECT * FROM domino_public.history_coverage WHERE pool_id=%s ORDER BY start_block',(claim['pool_id'],)).fetchall()
                if rows:
                    if any(row['denomination']!={'currencies':list(currencies),'decimals':decimals} for row in rows):
                        self.invalidate(claim,'history_token_metadata_changed')
                        return {'status':'rewound','reason':'history_token_metadata_changed','rpcCalls':budget.calls}
                    latest=max(rows,key=lambda row:row['end_block'])
                    if chain.block(latest['end_block']).hash!=latest['end_hash']:
                        self.invalidate(claim)
                        return {'status':'rewound','rpcCalls':budget.calls}
                boundary_timestamp=max(0,target.timestamp-claim['window_seconds'])
                if stored_target and 'lowerBlock' in stored_target:
                    lower=verify_boundary(chain,boundary_timestamp,target,stored_target['lowerBlock'])
                else:
                    lower=first_after(chain,boundary_timestamp,target)
                    # Persist independently of the log chunk. A later timeout
                    # resumes the same target without another timestamp search.
                    # Old three-field targets remain valid and acquire this
                    # field lazily; completion/reorg clears both together.
                    with self.store.connection(write=True) as conn:
                        self.guard(conn,claim)
                        conn.execute('UPDATE domino_public.history_jobs SET target=%s WHERE pool_id=%s AND window_seconds=%s',
                                     (Jsonb({**asdict(target),'lowerBlock':lower}),claim['pool_id'],claim['window_seconds']))
                def acquire(size):
                    bounds=missing_range(rows,lower,target.number,size)
                    if bounds is None:return None
                    start,finish=bounds
                    before,end=chain.block(start-1),chain.block(finish)
                    if end.timestamp<before.timestamp:raise DataError('history_timestamp_boundary_mismatch')
                    logs=history.request('eth_getLogs',[{'address':POOL_MANAGER,'topics':[SWAP,claim['pool_id']],
                         'fromBlock':hex(start),'toBlock':hex(finish)}])
                    if not isinstance(logs,list):raise DataError('invalid_logs_response')
                    if len(logs)>20000:raise DataError('activity_log_budget_exhausted')
                    events=[decode_activity(raw,claim['pool_id']) for raw in logs]
                    if any(e['kind']!='swap' or not start<=e['blockNumber']<=finish for e in events):raise DataError('invalid_activity_log')
                    positions=[(e['blockNumber'],e['logIndex']) for e in events]
                    if len(set(positions))!=len(positions):raise DataError('duplicate_activity_log')
                    numbers={e['blockNumber'] for e in events}
                    if len(numbers)>min(1000,max_rpc_calls//2):raise DataError('activity_log_budget_exhausted')
                    headers=read_headers(history,sorted(numbers),budget=HeaderBudget(1000))
                    for event in events:
                        block=headers[event['blockNumber']]
                        if block.hash!=event['blockHash'] or not before.timestamp<=block.timestamp<=end.timestamp:
                            raise DataError('history_snapshot_reorganized')
                        event['timestamp']=block.timestamp
                    events.sort(key=lambda e:(e['blockNumber'],e['logIndex']))
                    if any(a['timestamp']>b['timestamp'] for a,b in zip(events,events[1:])):raise DataError('history_timestamp_boundary_mismatch')
                    if chain.block(before.number)!=before or chain.block(end.number)!=end or chain.block(target.number)!=target:
                        raise DataError('history_snapshot_reorganized')
                    return before,end,events,aggregate(events,currencies,decimals)
                acquired=span.run(acquire)
                # AdaptiveSpan doubles after eight wins. Persist only bounded
                # useful state; at the ceiling, no growth streak is needed.
                successes=span.successes if span.span<span.ceiling else 0
                if acquired is None:
                    with self.store.connection(write=True) as conn:
                        self.guard(conn,claim);self.finish(conn,claim,complete=True,span=span.span,span_successes=successes)
                    status='current'
                else:
                    before,end,events,candles=acquired
                    covered=rows+[{'start_block':before.number+1,'end_block':end.number}]
                    complete=missing_range(covered,lower,target.number,span.span) is None
                    self.publish(claim,before,end,events,candles,span=span.span,complete=complete,
                                 denomination={'currencies':list(currencies),'decimals':decimals},span_successes=successes)
                    status='current' if complete else 'indexed'
                return {'status':status,'poolId':claim['pool_id'],'windowSeconds':claim['window_seconds'],'rpcCalls':budget.calls,'spanBlocks':span.span}
        except DataError as error:
            reason=str(error)
            if not reason.replace('_','').isalnum() or len(reason)>96:reason='upstream_unavailable'
            # A rejected publication did not earn a growth step. Preserve a
            # measured shrink, but never enlarge based on uncommitted work.
            failed_span=min(span.span,claim['span_blocks'])
            try:
                with self.store.connection(write=True) as conn:
                    self.guard(conn,claim);self.finish(conn,claim,reason=reason,span=failed_span)
            except DataError as failure:
                if str(failure)!='history_lease_lost':raise
            return {'status':'deferred','reason':reason,'rpcCalls':budget.calls,'spanBlocks':failed_span}
