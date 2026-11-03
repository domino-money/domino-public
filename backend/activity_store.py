"""Durable public activity, separate from the catalogue's discovery checkpoint."""
from psycopg.types.json import Jsonb

from catalogue import checked_key
from discovery import CHAIN_ID, DataError, bytes32
from pool_activity import (MAX_RANGES, ACTIVITY_CAPACITY_PROFILES, active_liquidity,
                           activity_range_limit, protocol_directions, window_metrics)


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
        # Chunks are contiguous (each starts at the pool's next_block) and never overlap, so the last by start_block is
        # the last by end_block; (pool_id,start_block) is the primary key, while end_block has no index and sorting
        # by it read every chunk of a pool (PONS/USDG: 76,954) past the 5 s statement timeout (2 Nov 2026).
        return conn.execute('SELECT * FROM domino_activity.chunks WHERE pool_id=%s ORDER BY start_block DESC LIMIT 1',
                            (pool_id,)).fetchone()

    def anchor(self,pool_id):
        """Verified creation of a registered pool, or None when it is not registered.

        The block is the one registration proved with the Initialize log; the
        timestamp belongs to the chain, so the caller reads that header rather
        than the store guessing it.
        """
        with self.catalogue.connection() as conn:
            row=conn.execute('''SELECT start_block FROM domino_activity.pools WHERE pool_id=%s''',
                             (bytes32(pool_id),)).fetchone()
            return None if row is None else {'startBlock':row['start_block']}

    def commit(self,conn,row,end,model,snapshot,events):
        current=self.pool(conn,row['pool_id'])
        if current['next_block']!=row['next_block'] or current['revision']!=row['revision']:
            raise DataError('activity_checkpoint_changed')
        start=row['next_block'];pool_id=row['pool_id']
        conn.execute('INSERT INTO domino_activity.chunks VALUES(%s,%s,%s,%s,%s,%s,%s)',
                     (pool_id,start,end.number,end.hash,end.timestamp,Jsonb(model),Jsonb(snapshot)))
        for e in events:
            conn.execute('''INSERT INTO domino_activity.events
                         (pool_id,chunk_start,block_number,block_hash,block_timestamp,tx_hash,
                          log_index,kind,payload,raw_fingerprint,timestamp_source)
                         VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                         (pool_id,start,e['blockNumber'],e['blockHash'],e['timestamp'],e['transactionHash'],
                          e['logIndex'],e['kind'],Jsonb(e['payload']),e['rawFingerprint'],
                          e.get('timestampSource','exact')))
        conn.execute('''UPDATE domino_activity.pools SET next_block=%s,revision=revision+1,
                     activity_diagnostic=NULL WHERE pool_id=%s''',
                     (end.number+1,pool_id))

    @staticmethod
    def rewind(conn,row,through,base_hash=None):
        conn.execute('DELETE FROM domino_activity.chunks WHERE pool_id=%s AND end_block>%s',(row['pool_id'],through))
        conn.execute('''UPDATE domino_activity.pools SET next_block=%s,base_hash=COALESCE(%s,base_hash),
                        revision=revision+1,activity_diagnostic=NULL WHERE pool_id=%s''',
                     (max(row['start_block'],through+1),base_hash,row['pool_id']))

    def record_range_failure(self,pool_id,attempt):
        """Persist the last failed resource-bound attempt, never a partial model.

        Diagnostics are operator metadata and do not advance the source revision.
        The optimistic checkpoint check prevents a late failure recorder from
        restoring an obsolete block after another worker commits or rewinds.
        """
        with self.catalogue.connection(writer=True,lock=True) as conn:
            row=self.pool(conn,pool_id)
            if (row['next_block']!=attempt['fromBlock'] or
                    row['revision']!=attempt['checkpointRevision']):
                return False
            profile=attempt.get('capacityProfile','standard')
            limit=activity_range_limit(profile)
            if attempt['liveRangeLimit']!=limit:
                raise DataError('invalid_activity_capacity_profile')
            resumable=(profile=='standard' and
                       attempt['observedLiveRangesAtLeast']<=ACTIVITY_CAPACITY_PROFILES['extended'])
            detail={**attempt,'capacityProfile':profile,'status':'blocked','reason':'activity_range_budget_exhausted',
                'action':'select_extended_activity_profile_and_resume' if resumable else 'capacity_review_required',
                'resumeAboveLimitSupported':resumable,
                'smallerSpanBypassesLimit':False,'canonicality':'not_rechecked_after_failure'}
            conn.execute('''UPDATE domino_activity.pools SET activity_diagnostic=%s ||
              jsonb_build_object('recordedAt',floor(extract(epoch FROM clock_timestamp()))::bigint)
              WHERE pool_id=%s''',(Jsonb(detail),pool_id))
            return True

    def operator_status(self,pool_id):
        """Stored operator status only: no RPC freshness or financial assertion.

        `blocked` describes the last recorded selected-profile range failure.
        Smaller spans do not bypass it; a larger profile requires explicit selection.
        A successful canonical commit or source rewind clears the diagnostic.
        No diagnostic is a claim that this pool is caught up or current.
        """
        pool_id=bytes32(pool_id)
        with self.catalogue.connection() as conn:
            row=self.pool(conn,pool_id)
            tail=self.tail(conn,pool_id)
            detail=row['activity_diagnostic']
            return {'schemaVersion':1,'mode':'activity_operator_status','chainId':CHAIN_ID,
                'poolId':pool_id,'status':'blocked' if detail else 'stored_history' if tail else 'not_indexed',
                'nextBlock':row['next_block'],'revision':row['revision'],
                'lastCommittedSnapshot':({'number':tail['end_block'],'hash':tail['end_hash'],
                    'timestamp':tail['end_timestamp'],'liveRanges':len(tail['model']['ranges'])} if tail else None),
                'diagnostic':detail,'limits':{'liveRanges':detail['liveRangeLimit'] if detail else MAX_RANGES},
                'capacityProfiles':dict(ACTIVITY_CAPACITY_PROFILES),
                'resumeAboveLimitSupported':detail['resumeAboveLimitSupported'] if detail else True,
                'canonicality':'not_checked','usableAsCurrent24h':False,'executionAvailable':False}

    def read(self,pool_id,*,include_positions=False):
        pool_id=bytes32(pool_id)
        with self.catalogue.connection() as conn:
            row=self.pool(conn,pool_id)
            tail=self.tail(conn,pool_id)
            if not tail:
                raise DataError('activity_not_indexed')
            # A window is a claim about time, so it only counts rows whose
            # timestamp was read from their own block; an interpolated one can
            # never enter a window.
            events=conn.execute('''SELECT block_timestamp AS timestamp,kind,payload FROM domino_activity.events
              WHERE pool_id=%s AND block_timestamp>%s AND block_timestamp<=%s
              AND timestamp_source='exact'
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
