"""Durable public activity, separate from the catalogue's discovery checkpoint."""
from psycopg.types.json import Jsonb

from catalogue import checked_key
from discovery import CHAIN_ID, DataError, bytes32
from pool_activity import active_liquidity, protocol_directions, window_metrics


class PgActivity:
    def __init__(self,catalogue):
        self.catalogue=catalogue

    @staticmethod
    def pool(conn,pool_id):
        row=conn.execute('SELECT * FROM domino_activity.pools WHERE pool_id=%s',(bytes32(pool_id),)).fetchone()
        if not row:
            raise DataError('activity_pool_not_registered')
        if row['methodology_version']!=1:
            raise DataError('activity_methodology_mismatch')
        checked_key(row['pool_key'],row['pool_id'])
        return row

    @staticmethod
    def tail(conn,pool_id):
        return conn.execute('SELECT * FROM domino_activity.chunks WHERE pool_id=%s ORDER BY end_block DESC LIMIT 1',
                            (pool_id,)).fetchone()

    def commit(self,conn,row,end,model,snapshot,events):
        current=self.pool(conn,row['pool_id'])
        if current['next_block']!=row['next_block'] or current['revision']!=row['revision']:
            raise DataError('activity_checkpoint_changed')
        start=row['next_block'];pool_id=row['pool_id']
        conn.execute('INSERT INTO domino_activity.chunks VALUES(%s,%s,%s,%s,%s,%s,%s)',
                     (pool_id,start,end.number,end.hash,end.timestamp,Jsonb(model),Jsonb(snapshot)))
        for e in events:
            conn.execute('INSERT INTO domino_activity.events VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',
                         (pool_id,start,e['blockNumber'],e['blockHash'],e['timestamp'],e['transactionHash'],
                          e['logIndex'],e['kind'],Jsonb(e['payload']),e['rawFingerprint']))
        conn.execute('UPDATE domino_activity.pools SET next_block=%s,revision=revision+1 WHERE pool_id=%s',
                     (end.number+1,pool_id))

    @staticmethod
    def rewind(conn,row,through,base_hash=None):
        conn.execute('DELETE FROM domino_activity.chunks WHERE pool_id=%s AND end_block>%s',(row['pool_id'],through))
        conn.execute('''UPDATE domino_activity.pools SET next_block=%s,base_hash=COALESCE(%s,base_hash),
                        revision=revision+1 WHERE pool_id=%s''',
                     (max(row['start_block'],through+1),base_hash,row['pool_id']))

    def read(self,pool_id,*,include_positions=False):
        pool_id=bytes32(pool_id)
        with self.catalogue.connection() as conn:
            row=self.pool(conn,pool_id)
            tail=self.tail(conn,pool_id)
            if not tail:
                raise DataError('activity_not_indexed')
            events=conn.execute('''SELECT block_timestamp AS timestamp,kind,payload FROM domino_activity.events
              WHERE pool_id=%s AND block_timestamp>%s AND block_timestamp<=%s
              AND kind IN ('swap','donate') ORDER BY block_number,log_index LIMIT 50001''',
              (pool_id,tail['end_timestamp']-86400,tail['end_timestamp'])).fetchall()
            if len(events)>50000:
                raise DataError('activity_window_budget_exhausted')
            model=tail['model'];snapshot=tail['state_snapshot'];key=row['pool_key']
            active=active_liquidity(model)
            if str(active)!=snapshot['activeLiquidityRaw']:
                raise DataError('stored_activity_state_mismatch')
            from fee_store import read_fees
            window=window_metrics(events,initialized_at=model['initializedAt'],as_of=tail['end_timestamp'])
            accounting=read_fees(conn,row,tail,window)
            from position_store import read_positions
            positions=read_positions(conn,row,tail,include_positions=include_positions)
            return {'schemaVersion':1,'methodologyVersion':1,'mode':'core_pool_activity_read_only',
                    'chainId':CHAIN_ID,'poolId':pool_id,'poolKey':key,'revision':row['revision'],
                    'accountingScope':'core_pool_events_only',
                    'snapshot':snapshot,'coverage':{'startBlock':row['start_block'],
                        'indexedThrough':tail['end_block'],'initializedBlock':model['initializedBlock'],
                        'initializedAt':model['initializedAt'],'scope':'since_verified_initialize',
                        'canonicality':'requires_rpc_recheck','rpcCompleteness':'single_provider_assumption'},
                    'window24h':window,
                    'liquidity':{'status':'core_active_liquidity_reconciled','activeLiquidityRaw':str(active),
                        'rangeCount':len(model['ranges']),'isTvl':False,'tvlUsd':None,
                        'tvlReason':('timestamp_aligned_valuation_unavailable' if positions['status']=='reconciled_as_of'
                                     else 'pool_assets_and_uncollected_fees_not_reconciled'),
                        'positionAccounting':positions},
                    'fees':{'protocolDirectionalPips':protocol_directions(model['protocolFeeRaw']),
                        'lpFeePipsAtSnapshot':snapshot['lpFeePips'],
                        'feeGrowthGlobalX128':snapshot['feeGrowthGlobalX128'],
                        'growthIsTokenAmount':False,'growthIncludesDonations':True,'accounting':accounting},
                    'storedEventCount':model['eventCount'],'suggested':False,'executionAvailable':False}
