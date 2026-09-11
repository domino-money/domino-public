"""Atomic fee sidecar, canonically attached to existing activity chunks."""
from psycopg.types.json import Jsonb

from activity_indexer import ActivityIndexer
import historical_work
from catalogue import checked_key
from discovery import DataError, bytes32
from fee_accounting import VERSION, replay_fees, supported
from historical_capacity import (capacity_profile, check_work_size, clear_work, record_failure,
                                 replay_batch, save_work, unavailable_work)


class FeeIndexer:
    def __init__(self, store, rpc, *, capacity='standard', activity_capacity='standard'):
        self.store = store
        self.activity = ActivityIndexer(store, rpc, capacity=activity_capacity)
        self.activity_capacity = activity_capacity
        self.capacity = capacity_profile(capacity)

    def step(self, pool_id):
        pool_id = bytes32(pool_id)
        try:
            return self._step(pool_id)
        except DataError as error:
            record_failure(self.store, pool_id, 'fee', self.capacity, str(error))
            raise

    def restart(self, pool_id):
        return historical_work.restart(self, pool_id, 'fee')

    def _step(self, pool_id):
        pool_id = bytes32(pool_id)
        self.activity.chain.check_chain()
        with self.store.catalogue.connection(writer=True, lock=True) as conn:
            row = self.store.pool(conn, pool_id)
            key = checked_key(row['pool_key'], pool_id)
            if not supported(key):
                raise DataError('fee_accounting_adapter_required')
            # Activity owns reorg recovery. No fee write is allowed on an orphan.
            tail = self.store.tail(conn, pool_id)
            if not tail:
                raise DataError('activity_not_indexed')
            if self.activity.chain.block(tail['end_block']).hash != tail['end_hash']:
                raise DataError('fee_activity_reorg_requires_replay')
            chunk = conn.execute('''SELECT c.* FROM domino_activity.chunks c
              LEFT JOIN domino_activity.fee_chunks f ON f.pool_id=c.pool_id AND f.chunk_start=c.start_block
              WHERE c.pool_id=%s AND f.pool_id IS NULL ORDER BY c.start_block LIMIT 1''',(pool_id,)).fetchone()
            if not chunk:
                return {'status':'caught_up_to_activity','through':tail['end_block']}
            previous = conn.execute('''SELECT c.*,f.model AS fee_model,f.methodology_version FROM domino_activity.chunks c
              LEFT JOIN domino_activity.fee_chunks f ON f.pool_id=c.pool_id AND f.chunk_start=c.start_block
              WHERE c.pool_id=%s AND c.end_block=%s''',(pool_id,chunk['start_block']-1)).fetchone()
            if previous and (previous['fee_model'] is None or previous['methodology_version'] != VERSION):
                raise DataError('fee_methodology_mismatch')
            if previous is None and chunk['start_block'] != row['start_block']:
                raise DataError('fee_replay_anchor_required')
            block = self.activity.chain.block(chunk['end_block'])
            if block.hash != chunk['end_hash'] or block.timestamp != chunk['end_timestamp']:
                raise DataError('fee_activity_reorg_requires_replay')
            events = conn.execute('''SELECT pool_id AS "poolId",block_number AS "blockNumber",
              block_hash AS "blockHash",block_timestamp AS timestamp,log_index AS "logIndex",kind,payload
              FROM domino_activity.events WHERE pool_id=%s AND chunk_start=%s
              ORDER BY block_number,log_index LIMIT 2001''',(pool_id,chunk['start_block'])).fetchall()
            if len(events)>2000:
                raise DataError('fee_event_budget_exhausted')
            binding = historical_work.bind_source(pool_id, key, 'fee', chunk, previous, events)
            progress = historical_work.load(conn, pool_id, 'fee', chunk['start_block'], binding, events)
            activity, ledger, fees, offset = replay_batch(replay_fees,
                progress['activity'] if progress else previous['model'] if previous else None,
                progress['model'] if progress else previous['fee_model'] if previous else None,
                events, progress['offset'] if progress else 0, pool_id, key,activity_capacity=self.activity_capacity)
            fees = (progress['rows'] if progress else []) + fees
            pending={'version':1,'activity':activity,'model':ledger,'rows':fees,
                     'offset':offset,'totalEvents':len(events)}
            pending = historical_work.seal(pending, binding)
            check_work_size(pending, conn)
            if not ledger or ledger.get('version')!=VERSION:
                raise DataError('fee_methodology_mismatch')
            if offset < len(events):
                if (self.activity.chain.block(block.number) != block or
                        self.activity.chain.block(tail['end_block']).hash != tail['end_hash']):
                    raise DataError('fee_activity_reorg_requires_replay')
                return save_work(conn, pool_id, 'fee', chunk, self.capacity,pending)
            if activity != chunk['model']:
                raise DataError('fee_activity_model_mismatch')
            if ledger['growthX128'] != chunk['state_snapshot']['feeGrowthGlobalX128']:
                raise DataError('fee_growth_reconciliation_failed')
            # Re-read state; a stored diagnostic alone does not qualify the ledger.
            actual = self.activity.read_state(pool_id, block, key)
            if actual != chunk['state_snapshot']:
                raise DataError('fee_state_reconciliation_failed')
            if (self.activity.chain.block(block.number) != block or
                    self.activity.chain.block(tail['end_block']).hash != tail['end_hash']):
                raise DataError('fee_activity_reorg_requires_replay')
            conn.execute('INSERT INTO domino_activity.fee_chunks VALUES(%s,%s,%s,%s)',
                         (pool_id,chunk['start_block'],VERSION,Jsonb(ledger)))
            for event in fees:
                conn.execute('INSERT INTO domino_activity.fee_events VALUES(%s,%s,%s,%s,%s)',
                             (pool_id,event['blockHash'],event['logIndex'],chunk['start_block'],Jsonb(event['fees'])))
            clear_work(conn, pool_id, 'fee')
            return {'status':'fee_chunk_reconciled','fromBlock':chunk['start_block'],
                    'through':block.number,'swapEvents':len(fees),'feeGrowthReconciled':True}


def read_fees(conn, row, tail, window):
    """Only the ledger at the exact activity tail can populate fee quantities."""
    pool_id = row['pool_id']
    result = {'methodologyVersion':VERSION,'status':'unavailable','reason':'fee_ledger_not_caught_up',
              'lpFeesRaw':None,'protocolFeesRaw':None,'donationsRaw':None,
              'basis':'core_trading_fee_before_Q128_distribution_rounding',
              'isCollectedAmount':False,'isDominoServiceFee':False}
    if not supported(checked_key(row['pool_key'], pool_id)):
        result['reason'] = 'fee_accounting_adapter_required'
        window['lpFeesReason'] = result['reason']
        return result
    record = conn.execute('SELECT * FROM domino_activity.fee_chunks WHERE pool_id=%s AND chunk_start=%s',
                          (pool_id,tail['start_block'])).fetchone()
    if not record:
        result.update(unavailable_work(conn, pool_id, 'fee'))
        window['lpFeesReason'] = result['reason']
        return result
    model = record['model']
    if (record['methodology_version'] != VERSION or model.get('version') != VERSION or
            model['growthX128'] != tail['state_snapshot']['feeGrowthGlobalX128']):
        raise DataError('stored_fee_ledger_mismatch')
    rows = conn.execute('''SELECT f.fees FROM domino_activity.events e
      LEFT JOIN domino_activity.fee_events f ON f.pool_id=e.pool_id AND f.block_hash=e.block_hash AND f.log_index=e.log_index
      WHERE e.pool_id=%s AND e.kind='swap' AND e.block_timestamp>%s AND e.block_timestamp<=%s
      ORDER BY e.block_number,e.log_index LIMIT 50001''',
      (pool_id,window['fromTimestampExclusive'],window['throughTimestamp'])).fetchall()
    if len(rows) != window['swapEventCount'] or any(r['fees'] is None for r in rows):
        raise DataError('stored_fee_events_incomplete')
    def total(name):
        return [str(sum(int(r['fees'][name][i]) for r in rows)) for i in (0,1)]
    window.update(lpFeesRaw=total('lpFeesRaw'),lpFeesReason=None,
                  protocolFeesRaw=total('protocolFeesRaw'),lpFeesBasis=result['basis'],
                  feeAprReason='time_weighted_tvl_and_usd_valuation_not_reconciled')
    result.update(status='reconciled_as_of',reason=None,scope='since_verified_initialize',
                  feeGrowthReconciled=True,lpFeesRaw=model['lpFeesRaw'],
                  protocolFeesRaw=model['protocolFeesRaw'],donationsRaw=model['donationsRaw'])
    return result
