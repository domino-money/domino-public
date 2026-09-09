"""Reconcile each known core position and tick before exposing pool assets."""
from psycopg.types.json import Jsonb

from activity_indexer import ActivityIndexer
from catalogue import checked_key
from discovery import DataError, STATE_VIEW, bytes32
from fee_accounting import VERSION as FEE_VERSION, supported
from position_accounting import VERSION, inside_growth, position_summary, replay_positions


def same_fee_ledger(model, fees):
    mapping={'growthX128':'growthX128','tradingLpFeesRaw':'lpFeesRaw',
             'protocolFeesRaw':'protocolFeesRaw','donationsRaw':'donationsRaw','swapCount':'swapCount'}
    return fees.get('version')==FEE_VERSION and all(model[a]==fees[b] for a,b in mapping.items())


class PositionIndexer:
    def __init__(self,store,rpc):
        self.store,self.rpc=store,rpc
        self.activity=ActivityIndexer(store,rpc)

    def check_positions(self,pool_id,block,activity,model):
        pool=bytes.fromhex(pool_id[2:]);ranges={}
        for p in model['positions'].values():
            lo,hi=p['tickLower'],p['tickUpper']
            values=[pool,p['coreOwner'],lo,hi,bytes.fromhex(p['salt'][2:])]
            got=self.rpc.call(STATE_VIEW,'getPositionInfo(bytes32,address,int24,int24,bytes32)',
                              ['bytes32','address','int24','int24','bytes32'],values,
                              ['uint128','uint256','uint256'],block=block.tag)
            expected=(int(p['liquidityRaw']),*map(int,p['lastInsideX128']))
            if tuple(got)!=expected:
                raise DataError('core_position_state_reconciliation_failed')
            ranges[(lo,hi)]=inside_growth(model,activity['tick'],lo,hi)
        for (lo,hi),expected in ranges.items():
            got=self.rpc.call(STATE_VIEW,'getFeeGrowthInside(bytes32,int24,int24)',
                              ['bytes32','int24','int24'],[pool,lo,hi],['uint256','uint256'],block=block.tag)
            if list(got)!=expected:
                raise DataError('core_inside_growth_reconciliation_failed')
        for tick,item in model['ticks'].items():
            got=self.rpc.call(STATE_VIEW,'getTickInfo(bytes32,int24)',
                              ['bytes32','int24'],[pool,int(tick)],
                              ['uint128','int128','uint256','uint256'],block=block.tag)
            expected=(int(item['gross']),int(item['net']),*map(int,item['outsideX128']))
            if tuple(got)!=expected:
                raise DataError('core_tick_state_reconciliation_failed')
        return {'blockNumber':block.number,'blockHash':block.hash,'corePositions':len(model['positions']),
                'ticks':len(model['ticks']),'ranges':len(ranges),'sourceFeeMethodology':FEE_VERSION}

    def step(self,pool_id):
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
            previous=conn.execute('''SELECT c.*,p.model AS position_model,p.methodology_version
              FROM domino_activity.chunks c LEFT JOIN domino_activity.position_chunks p
              ON p.pool_id=c.pool_id AND p.chunk_start=c.start_block WHERE c.pool_id=%s AND c.end_block=%s''',
              (pool_id,chunk['start_block']-1)).fetchone()
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
            activity,model,settlements=replay_positions(previous['model'] if previous else None,
                previous['position_model'] if previous else None,events,pool_id,key)
            if activity!=chunk['model'] or not same_fee_ledger(model,fee['model']):
                raise DataError('position_source_ledger_mismatch')
            if model['growthX128']!=chunk['state_snapshot']['feeGrowthGlobalX128']:
                raise DataError('position_global_growth_mismatch')
            position_summary(model,activity) # Asset conservation gate; no publication yet.
            if self.activity.read_state(pool_id,block,key)!=chunk['state_snapshot']:
                raise DataError('position_pool_state_reconciliation_failed')
            proof=self.check_positions(pool_id,block,activity,model)
            if (self.activity.chain.block(block.number)!=block or
                    self.activity.chain.block(tail['end_block']).hash!=tail['end_hash']):
                raise DataError('position_activity_reorg_requires_replay')
            conn.execute('INSERT INTO domino_activity.position_chunks VALUES(%s,%s,%s,%s,%s)',
                         (pool_id,chunk['start_block'],VERSION,Jsonb(model),Jsonb(proof)))
            for event in settlements:
                conn.execute('INSERT INTO domino_activity.position_settlements VALUES(%s,%s,%s,%s,%s)',
                    (pool_id,event['blockHash'],event['logIndex'],chunk['start_block'],Jsonb(event['settlement'])))
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
    if not record:return unavailable
    model=record['model'];proof=record['reconciliation']
    fee=conn.execute('SELECT * FROM domino_activity.fee_chunks WHERE pool_id=%s AND chunk_start=%s',
                     (row['pool_id'],tail['start_block'])).fetchone()
    if (record['methodology_version']!=VERSION or model.get('version')!=VERSION or
        not fee or fee['methodology_version']!=FEE_VERSION or not same_fee_ledger(model,fee['model']) or
        model['growthX128']!=tail['state_snapshot']['feeGrowthGlobalX128'] or
        proof['blockHash']!=tail['end_hash'] or proof['blockNumber']!=tail['end_block'] or
        proof['corePositions']!=len(model['positions']) or proof['ticks']!=len(model['ticks']) or
        proof['sourceFeeMethodology']!=FEE_VERSION):
        raise DataError('stored_position_ledger_mismatch')
    audit=conn.execute('''SELECT count(*) AS count,
      COALESCE(sum((settlement->'settledFeesRaw'->>0)::numeric),0) AS f0,
      COALESCE(sum((settlement->'settledFeesRaw'->>1)::numeric),0) AS f1
      FROM domino_activity.position_settlements WHERE pool_id=%s''',(row['pool_id'],)).fetchone()
    if audit['count']!=model['modifyCount'] or [int(audit['f0']),int(audit['f1'])]!=list(map(int,model['settledFeesRaw'])):
        raise DataError('stored_position_settlements_incomplete')
    summary=position_summary(model,tail['model'],include_positions=include_positions)
    return {**summary,'status':'reconciled_as_of','reason':None,'onchainReconciliation':proof}
