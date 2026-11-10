"""Reconcile each known core position and tick before exposing pool assets."""
from psycopg.types.json import Jsonb

from activity_indexer import ActivityIndexer
import historical_work
from catalogue import checked_key
from discovery import DataError, STATE_VIEW, bytes32
from fee_accounting import VERSION as FEE_VERSION, supported
from position_accounting import VERSION, inside_growth, position_summary, replay_positions
from historical_capacity import (MAX_BATCH_CHECKS, capacity_profile, check_work_size, clear_work,
                                 record_failure, replay_batch, save_work, unavailable_work)


def same_fee_ledger(model, fees):
    mapping={'growthX128':'growthX128','tradingLpFeesRaw':'lpFeesRaw',
             'protocolFeesRaw':'protocolFeesRaw','donationsRaw':'donationsRaw','swapCount':'swapCount'}
    return fees.get('version')==FEE_VERSION and all(model[a]==fees[b] for a,b in mapping.items())


class PositionIndexer:
    def __init__(self,store,rpc,*,capacity='standard',activity_capacity='standard'):
        self.store,self.rpc=store,rpc
        self.activity=ActivityIndexer(store,rpc,capacity=activity_capacity)
        self.activity_capacity=activity_capacity
        self.capacity=capacity_profile(capacity)
        self.check_offset=None

    def check_positions(self,pool_id,block,activity,model):
        pool=bytes.fromhex(pool_id[2:])
        # Stable order across JSONB serialization and fresh worker instances.
        positions=[p for _,p in sorted(model['positions'].items())]
        ranges=sorted({(p['tickLower'],p['tickUpper']) for p in positions})
        ticks=sorted(model['ticks'].items(),key=lambda pair:int(pair[0]))
        total=len(positions)+len(ranges)+len(ticks)
        start=self.check_offset or 0
        end=total if self.check_offset is None else min(start+MAX_BATCH_CHECKS,total)
        for index,p in enumerate(positions):
            if not start<=index<end:continue
            lo,hi=p['tickLower'],p['tickUpper']
            values=[pool,p['coreOwner'],lo,hi,bytes.fromhex(p['salt'][2:])]
            got=self.rpc.call(STATE_VIEW,'getPositionInfo(bytes32,address,int24,int24,bytes32)',
                              ['bytes32','address','int24','int24','bytes32'],values,
                              ['uint128','uint256','uint256'],block=block.tag)
            expected=(int(p['liquidityRaw']),*map(int,p['lastInsideX128']))
            if tuple(got)!=expected:
                raise DataError('core_position_state_reconciliation_failed')
        for index,(lo,hi) in enumerate(ranges,len(positions)):
            if not start<=index<end:continue
            expected=inside_growth(model,activity['tick'],lo,hi)
            got=self.rpc.call(STATE_VIEW,'getFeeGrowthInside(bytes32,int24,int24)',
                              ['bytes32','int24','int24'],[pool,lo,hi],['uint256','uint256'],block=block.tag)
            if list(got)!=expected:
                raise DataError('core_inside_growth_reconciliation_failed')
        for index,(tick,item) in enumerate(ticks,len(positions)+len(ranges)):
            if not start<=index<end:continue
            got=self.rpc.call(STATE_VIEW,'getTickInfo(bytes32,int24)',
                              ['bytes32','int24'],[pool,int(tick)],
                              ['uint128','int128','uint256','uint256'],block=block.tag)
            expected=(int(item['gross']),int(item['net']),*map(int,item['outsideX128']))
            if tuple(got)!=expected:
                raise DataError('core_tick_state_reconciliation_failed')
        self.completed_checks,self.required_checks=end,total
        return {'blockNumber':block.number,'blockHash':block.hash,'corePositions':len(model['positions']),
                'ticks':len(model['ticks']),'ranges':len(ranges),'sourceFeeMethodology':FEE_VERSION}

    def step(self,pool_id):
        pool_id=bytes32(pool_id)
        try:
            return self._step(pool_id)
        except DataError as error:
            record_failure(self.store,pool_id,'position',self.capacity,str(error))
            raise

    def restart(self, pool_id):
        return historical_work.restart(self, pool_id, 'position')

    def _step(self,pool_id):
        pool_id=bytes32(pool_id)
        self.activity.chain.check_chain()
        with self.store.catalogue.connection(writer=True,lock=True) as conn:
            row=self.store.pool(conn,pool_id);key=checked_key(row['pool_key'],pool_id)
            if not supported(key):raise DataError('position_accounting_adapter_required')
            tail=self.store.tail(conn,pool_id)
            if not tail:raise DataError('activity_not_indexed')
            if self.activity.chain.block(tail['end_block']).hash!=tail['end_hash']:
                raise DataError('position_activity_reorg_requires_replay')
            chunk=conn.execute('''SELECT c.* FROM domino_activity.chunks c
              LEFT JOIN domino_activity.position_chunks p ON p.pool_id=c.pool_id AND p.chunk_start=c.start_block
              WHERE c.pool_id=%s AND p.pool_id IS NULL ORDER BY c.start_block LIMIT 1''',(pool_id,)).fetchone()
            if not chunk:return {'status':'caught_up_to_activity','through':tail['end_block']}
            fee=conn.execute('SELECT * FROM domino_activity.fee_chunks WHERE pool_id=%s AND chunk_start=%s',
                             (pool_id,chunk['start_block'])).fetchone()
            if not fee:raise DataError('reconciled_fee_chunk_required')
            if fee['methodology_version']!=FEE_VERSION:raise DataError('fee_methodology_mismatch')
            # The chunk before this one through the primary key, as in fee_store: end_block has no index. Only the
            # nearest earlier chunk can end at start_block-1; any other is no predecessor.
            previous=conn.execute('''SELECT c.*,p.model AS position_model,p.methodology_version
              FROM domino_activity.chunks c LEFT JOIN domino_activity.position_chunks p
              ON p.pool_id=c.pool_id AND p.chunk_start=c.start_block WHERE c.pool_id=%s AND c.start_block<%s
              ORDER BY c.start_block DESC LIMIT 1''',(pool_id,chunk['start_block'])).fetchone()
            if previous and previous['end_block']!=chunk['start_block']-1:previous=None
            if previous and (previous['position_model'] is None or previous['methodology_version']!=VERSION):
                raise DataError('position_methodology_mismatch')
            if not previous and chunk['start_block']!=row['start_block']:
                raise DataError('position_anchor_required')
            block=self.activity.chain.block(chunk['end_block'])
            if block.hash!=chunk['end_hash'] or block.timestamp!=chunk['end_timestamp']:
                raise DataError('position_activity_reorg_requires_replay')
            events=conn.execute('''SELECT pool_id AS "poolId",block_number AS "blockNumber",block_hash AS "blockHash",
              block_timestamp AS timestamp,log_index AS "logIndex",kind,payload FROM domino_activity.events
              WHERE pool_id=%s AND chunk_start=%s ORDER BY block_number,log_index LIMIT 2001''',
              (pool_id,chunk['start_block'])).fetchall()
            if len(events)>2000:raise DataError('position_event_budget_exhausted')
            binding=historical_work.bind_source(pool_id,key,'position',chunk,previous,events,fee)
            progress=historical_work.load(conn,pool_id,'position',chunk['start_block'],binding,events)
            activity,model,settlements,offset=replay_batch(replay_positions,
                progress['activity'] if progress else previous['model'] if previous else None,
                progress['model'] if progress else previous['position_model'] if previous else None,
                events,progress['offset'] if progress else 0,pool_id,key,capacity=self.capacity,
                activity_capacity=self.activity_capacity)
            settlements=(progress['rows'] if progress else [])+settlements
            pending={'version':1,'activity':activity,'model':model,'rows':settlements,
                     'offset':offset,'totalEvents':len(events),'checks':progress.get('checks',0) if progress else 0}
            check_work_size(historical_work.seal(pending,binding),conn)
            if not model or model.get('version')!=VERSION:raise DataError('position_methodology_mismatch')
            # A resumed proof-only batch must also honor a smaller selected profile.
            if len(model['positions'])>self.capacity.positions:raise DataError('core_position_budget_exhausted')
            if len(model['ticks'])>self.capacity.ticks:raise DataError('core_tick_budget_exhausted')
            if offset<len(events):
                if (self.activity.chain.block(block.number)!=block or
                        self.activity.chain.block(tail['end_block']).hash!=tail['end_hash']):
                    raise DataError('position_activity_reorg_requires_replay')
                return save_work(conn,pool_id,'position',chunk,self.capacity,historical_work.seal(pending,binding))
            if activity!=chunk['model'] or not same_fee_ledger(model,fee['model']):
                raise DataError('position_source_ledger_mismatch')
            if model['growthX128']!=chunk['state_snapshot']['feeGrowthGlobalX128']:
                raise DataError('position_global_growth_mismatch')
            position_summary(model,activity) # Asset conservation gate; no publication yet.
            required=len(model['positions'])+len(model['ticks'])+len({(p['tickLower'],p['tickUpper']) for p in model['positions'].values()})
            if pending['checks']>required or (pending['checks'] and progress.get('requiredChecks')!=required):
                raise DataError('historical_work_checkpoint_mismatch')
            if self.activity.read_state(pool_id,block,key)!=chunk['state_snapshot']:
                raise DataError('position_pool_state_reconciliation_failed')
            self.check_offset=pending['checks']
            try:
                proof=self.check_positions(pool_id,block,activity,model)
            finally:
                self.check_offset=None
            if (self.activity.chain.block(block.number)!=block or
                    self.activity.chain.block(tail['end_block']).hash!=tail['end_hash']):
                raise DataError('position_activity_reorg_requires_replay')
            if self.completed_checks<self.required_checks:
                pending['checks']=self.completed_checks
                pending['requiredChecks']=self.required_checks
                return save_work(conn,pool_id,'position',chunk,self.capacity,historical_work.seal(pending,binding))
            conn.execute('INSERT INTO domino_activity.position_chunks VALUES(%s,%s,%s,%s,%s)',
                         (pool_id,chunk['start_block'],VERSION,Jsonb(model),Jsonb(proof)))
            for event in settlements:
                conn.execute('INSERT INTO domino_activity.position_settlements VALUES(%s,%s,%s,%s,%s)',
                    (pool_id,event['blockHash'],event['logIndex'],chunk['start_block'],Jsonb(event['settlement'])))
            clear_work(conn,pool_id,'position')
            return {'status':'position_chunk_reconciled','fromBlock':chunk['start_block'],
                    'through':block.number,'corePositions':proof['corePositions'],'knownTicks':proof['ticks'],
                    'modifications':len(settlements),'onchainPositionChecksPassed':True}


def read_positions(conn,row,tail,*,include_positions=False):
    key=checked_key(row['pool_key'],row['pool_id'])
    unavailable={'methodologyVersion':VERSION,'status':'unavailable','lpAssetsRaw':None,
                 'principalRaw':None,'unsettledFeesRaw':None,'reason':'position_ledger_not_caught_up'}
    if not supported(key):
        return {**unavailable,'reason':'position_accounting_adapter_required'}
    record=conn.execute('SELECT * FROM domino_activity.position_chunks WHERE pool_id=%s AND chunk_start=%s',
                        (row['pool_id'],tail['start_block'])).fetchone()
    if not record:return {**unavailable,**unavailable_work(conn,row['pool_id'],'position')}
    model=record['model'];proof=record['reconciliation']
    fee=conn.execute('SELECT * FROM domino_activity.fee_chunks WHERE pool_id=%s AND chunk_start=%s',
                     (row['pool_id'],tail['start_block'])).fetchone()
    if (record['methodology_version']!=VERSION or model.get('version')!=VERSION or
        not fee or fee['methodology_version']!=FEE_VERSION or not same_fee_ledger(model,fee['model']) or
        model['growthX128']!=tail['state_snapshot']['feeGrowthGlobalX128'] or
        proof['blockHash']!=tail['end_hash'] or proof['blockNumber']!=tail['end_block'] or
        proof['corePositions']!=len(model['positions']) or proof['ticks']!=len(model['ticks']) or
        proof['sourceFeeMethodology']!=FEE_VERSION or
        proof['ranges']!=len({(p['tickLower'],p['tickUpper']) for p in model['positions'].values()})):
        raise DataError('stored_position_ledger_mismatch')
    audit=conn.execute('''SELECT count(*) AS count,
      COALESCE(sum((settlement->'settledFeesRaw'->>0)::numeric),0) AS f0,
      COALESCE(sum((settlement->'settledFeesRaw'->>1)::numeric),0) AS f1
      FROM domino_activity.position_settlements WHERE pool_id=%s''',(row['pool_id'],)).fetchone()
    if audit['count']!=model['modifyCount'] or [int(audit['f0']),int(audit['f1'])]!=list(map(int,model['settledFeesRaw'])):
        raise DataError('stored_position_settlements_incomplete')
    summary=position_summary(model,tail['model'],include_positions=include_positions)
    return {**summary,'status':'reconciled_as_of','reason':None,'onchainReconciliation':proof}
