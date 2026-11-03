"""Per-pool Initialize/Swap/ModifyLiquidity/Donate/protocol event replay and reconciliation."""
from dataclasses import asdict

from catalogue import checked_key, pool_lock_key
from catalogue_indexer import CatalogueIndexer, INITIALIZE_TOPIC
from discovery import POOL_MANAGER, STATE_VIEW, DataError, bytes32
from indexer_io import MAX_CHUNK_EVENTS, MAX_INDEXER_SPAN, read_headers
from pool_activity import (TOPICS, active_liquidity, activity_range_limit,
                           decode_activity, replay, valid_price, protocol_directions)


# The read's window is 24 h; on this chain a block is one second, so the window
# is that many blocks of a chunk. Only events inside it need a provider header.
RETENTION_BLOCKS = 86_400
# Events one activity chunk may hold: the most the fee, position and capital
# ledgers replay per chunk (`LIMIT 2001` there; docs/HISTORICAL_CAPACITY.md).
# MAX_CHUNK_EVENTS (20,000) bounds a log response, not a chunk: a chunk over
# 2,000 is refused here so the span shrinks, because a stored one blocks every
# ledger of its pool at it (USDG/ORBIO's 100,000-block chunk at 68,147,815).
MAX_SOURCE_CHUNK_EVENTS = 2_000


def derived_timestamp(before,end,number):
    """Interpolate between the two verified chunk boundaries.

    Monotone in the block number, exact when the block time is constant, and
    labelled in the row as derived. It is never used inside the retention
    window, where the real header is read.
    """
    span=end.number-before.number
    if span<=0:
        return end.timestamp
    return before.timestamp+(number-before.number)*(end.timestamp-before.timestamp)//span


class ActivityIndexer:
    def __init__(self,store,rpc,*,capacity='standard',parallel_walks=False,
                 header_cache=None,header_budget=None,publication_guard=None):
        self.range_limit=activity_range_limit(capacity)
        self.capacity=capacity
        # One writer per pool by default; `parallel_walks` narrows the global
        # catalogue lock to the pool being walked so different pools can be
        # indexed at the same time. The same pool is always serialized.
        self.parallel_walks=parallel_walks
        self.header_cache=header_cache if header_cache is not None else {}
        self.header_budget=header_budget
        self.publication_guard=publication_guard
        self.store,self.rpc=store,rpc
        self.chain=CatalogueIndexer(store.catalogue,rpc)

    def lock(self,pool_id):
        return pool_lock_key(pool_id) if self.parallel_walks else True

    def guard(self,conn):
        if self.publication_guard is not None:self.publication_guard(conn)

    def register(self,pool_id,initialization_block=None):
        pool_id=bytes32(pool_id)
        self.chain.check_chain()
        with self.store.catalogue.connection(writer=True,lock=self.lock(pool_id)) as conn:
            existing=conn.execute('SELECT * FROM domino_activity.pools WHERE pool_id=%s',(pool_id,)).fetchone()
            if existing:
                if initialization_block is not None and initialization_block!=existing['start_block']:
                    raise DataError('activity_start_already_set')
                return {'status':'already_registered','startBlock':existing['start_block'],
                        'anchorSource':'stored_registration'}
            candidate=conn.execute('''SELECT pool_key,block_number AS initialized FROM domino_catalogue.events
              WHERE pool_id=%s UNION ALL SELECT pool_key,NULL AS initialized FROM domino_catalogue.hints
              WHERE pool_id=%s LIMIT 1''',(pool_id,pool_id)).fetchone()
            if not candidate:
                raise DataError('pool_not_in_catalogue')
            key=checked_key(candidate['pool_key'],pool_id)
            start=initialization_block if initialization_block is not None else candidate['initialized']
            if type(start) is not int or start<1:
                raise DataError('verified_initialization_block_required')
            base,block=self.chain.block(start-1),self.chain.block(start)
            logs=self.rpc.request('eth_getLogs',[{'address':POOL_MANAGER,'topics':[INITIALIZE_TOPIC,pool_id],
                                                 'fromBlock':hex(start),'toBlock':hex(start)}])
            if not isinstance(logs,list) or len(logs)!=1:
                raise DataError('initialize_anchor_not_found')
            event=decode_activity(logs[0],pool_id)
            if event['blockNumber']!=start or event['blockHash']!=block.hash or checked_key(event['payload']['poolKey'],pool_id)!=key:
                raise DataError('initialize_anchor_mismatch')
            if self.chain.block(start)!=block or self.chain.block(start-1)!=base:
                raise DataError('activity_snapshot_reorganized')
            from psycopg.types.json import Jsonb
            self.guard(conn)
            conn.execute('''INSERT INTO domino_activity.pools(pool_id,pool_key,start_block,base_hash,next_block)
                            VALUES(%s,%s,%s,%s,%s)''',(pool_id,Jsonb(asdict(key)),start,base.hash,start))
            return {'status':'registered','startBlock':start,
                    'anchorSource':'supplied_block' if initialization_block is not None else 'catalogue_event'}

    def reconcile(self,conn,row):
        checks=conn.execute('''SELECT end_block,end_hash FROM domino_activity.chunks
          WHERE pool_id=%s ORDER BY start_block DESC LIMIT 64''',(row['pool_id'],)).fetchall()
        if checks and self.chain.block(checks[0]['end_block']).hash==checks[0]['end_hash']:
            return None
        if not checks and self.chain.block(row['start_block']-1).hash==row['base_hash']:
            return None
        for check in checks[1:]:
            if self.chain.block(check['end_block']).hash==check['end_hash']:
                self.guard(conn)
                self.store.rewind(conn,row,check['end_block'])
                return check['end_block']
        base=self.chain.block(row['start_block']-1)
        self.guard(conn)
        self.store.rewind(conn,row,base.number,base.hash)
        return base.number

    def read_state(self,pool_id,block,key):
        values=[bytes.fromhex(pool_id[2:])]
        def call(signature,outputs):
            return self.rpc.call(STATE_VIEW,signature,['bytes32'],values,outputs,block=block.tag)
        sqrt,tick,protocol,lp_fee=call('getSlot0(bytes32)',['uint160','int24','uint24','uint24'])
        liquidity,=call('getLiquidity(bytes32)',['uint128'])
        growth=call('getFeeGrowthGlobals(bytes32)',['uint256','uint256'])
        valid_price(sqrt,tick);protocol_directions(protocol)
        if not 0<=liquidity<2**128 or not 0<=lp_fee<=1000000 or any(not 0<=x<2**256 for x in growth):
            raise DataError('invalid_activity_state')
        if key.fee_pips!=0x800000 and lp_fee!=key.fee_pips:
            raise DataError('activity_lp_fee_mismatch')
        return {**asdict(block),'sqrtPriceX96':str(sqrt),'tick':tick,'protocolFeeRaw':protocol,
                'lpFeePips':lp_fee,'activeLiquidityRaw':str(liquidity),'feeGrowthGlobalX128':[str(x) for x in growth]}

    def step(self,pool_id,*,through,span=1000):
        pool_id=bytes32(pool_id)
        if type(through) is not int or through<1 or type(span) is not int or not 1<=span<=MAX_INDEXER_SPAN:
            raise DataError('invalid_activity_bounds')
        attempt={}
        try:
            return self._step(pool_id,through=through,span=span,attempt=attempt)
        except DataError as error:
            if str(error)=='activity_range_budget_exhausted' and attempt:
                # This runs after the indexing transaction rolled back. A stale
                # writer or a diagnostic outage must not alter/mask that result.
                try:
                    self.store.record_range_failure(pool_id,attempt)
                except DataError:
                    pass
            raise

    def _step(self,pool_id,*,through,span,attempt):
        self.chain.check_chain()
        with self.store.catalogue.connection(writer=True,lock=self.lock(pool_id)) as conn:
            row=self.store.pool(conn,pool_id)
            rewind=self.reconcile(conn,row)
            if rewind is not None:
                # The branch changed, so every cached header from it is stale.
                self.header_cache.clear()
                return {'status':'rewound','through':rewind}
            if row['next_block']>through:
                return {'status':'caught_up_to_target','through':row['next_block']-1}
            tail=self.store.tail(conn,pool_id)
            start=row['next_block'];end=min(start+span-1,through)
            before,block=self.chain.block(start-1),self.chain.block(end)
            if block.timestamp<before.timestamp:
                raise DataError('activity_timestamp_regression')
            if before.hash!=(tail['end_hash'] if tail else row['base_hash']):
                raise DataError('activity_snapshot_reorganized')
            logs=self.rpc.request('eth_getLogs',[{'address':POOL_MANAGER,'topics':[TOPICS,pool_id],
                                                 'fromBlock':hex(start),'toBlock':hex(end)}])
            if not isinstance(logs,list) or len(logs)>MAX_CHUNK_EVENTS:
                raise DataError('activity_log_budget_exhausted')
            events,seen=[],{}
            decoded=[]
            for raw in logs:
                event=decode_activity(raw,pool_id);number=event['blockNumber']
                if not start<=number<=end:
                    raise DataError('activity_event_outside_chunk')
                decoded.append(event)
            if len({(event['blockNumber'],event['logIndex']) for event in decoded})>MAX_SOURCE_CHUNK_EVENTS:
                raise DataError('activity_log_budget_exhausted')
            # Only events inside the retention window pay for a header; older
            # ones are interpolated between the chunk boundaries and labelled.
            # Exact headers are for the window the reads actually serve: the last
            # 24 h of the chain, not of each chunk. A deep backfill's chunks are
            # all older than that, so every event in them is derived and free;
            # only the tail pays, once.
            window_start=max(row['start_block'],through-RETENTION_BLOCKS)
            headers=read_headers(self.rpc,[event['blockNumber'] for event in decoded
                                           if event['blockNumber']>window_start],
                                 cache=self.header_cache,budget=self.header_budget)
            for event in decoded:
                number=event['blockNumber']
                header=headers.get(number)
                if header is not None and header.hash!=event['blockHash']:
                    # A cached header may come from the branch this event
                    # replaced; the live one decides, so refetch just this block.
                    self.header_cache.pop(number,None)
                    header=read_headers(self.rpc,[number],cache=self.header_cache)[number]
                if header is not None:
                    if header.hash!=event['blockHash'] or not before.timestamp<=header.timestamp<=block.timestamp:
                        raise DataError('activity_event_block_mismatch')
                    event['timestamp']=header.timestamp
                    event['timestampSource']='exact'
                else:
                    event['timestamp']=derived_timestamp(before,block,number)
                    event['timestampSource']='block_range_derived'
                identity=(number,event['logIndex'])
                if identity in seen:
                    if seen[identity]!=event:
                        raise DataError('conflicting_activity_log')
                    continue
                seen[identity]=event;events.append(event)
            events.sort(key=lambda e:(e['blockNumber'],e['logIndex']))
            if any(a['timestamp']>b['timestamp'] for a,b in zip(events,events[1:])):
                raise DataError('activity_timestamp_regression')
            attempt.update({'checkpointRevision':row['revision'],'fromBlock':start,
                'attemptedThroughBlock':end,'attemptedEndHash':block.hash,
                'predecessorHash':before.hash,'capacityProfile':self.capacity,'liveRangeLimit':self.range_limit,
                'observedLiveRangesAtLeast':max(self.range_limit+1,len(tail['model']['ranges']) if tail else 0),
                'lastCommittedLiveRanges':len(tail['model']['ranges']) if tail else 0})
            model=replay(tail['model'] if tail else None,events,pool_id,row['pool_key'],capacity=self.capacity)
            if model is None:
                raise DataError('initialize_anchor_not_found')
            state=self.read_state(pool_id,block,checked_key(row['pool_key'],pool_id))
            if (state['sqrtPriceX96']!=model['sqrtPriceX96'] or state['tick']!=model['tick']
                    or state['protocolFeeRaw']!=model['protocolFeeRaw']
                    or int(state['activeLiquidityRaw'])!=active_liquidity(model)):
                raise DataError('activity_state_reconciliation_failed')
            if self.chain.block(end)!=block or self.chain.block(start-1)!=before:
                raise DataError('activity_snapshot_reorganized')
            self.guard(conn)
            self.store.commit(conn,row,block,model,state,events)
            return {'status':'indexed','fromBlock':start,'through':end,'events':len(events),
                    'activeRanges':len(model['ranges']),'stateReconciled':True,
                    'capacityProfile':self.capacity,'liveRangeLimit':self.range_limit}
