"""Event-time assets derived from reconciled positions, with source reorg cascades."""
from psycopg.types.json import Jsonb

from activity_indexer import ActivityIndexer
import capital_work
from catalogue import checked_key
from discovery import DataError, bytes32
from historical_capacity import capacity_profile, clear_work, record_failure, replay_batch, save_work
from position_accounting import VERSION as POSITION_VERSION, position_summary, replay_positions
from position_store import PositionIndexer, read_positions

VERSION = 1
MAX_WINDOW_EVENTS = 50000


def capital_point(activity, model):
    summary = position_summary(model, activity)
    names = ('lpAssetsRaw', 'principalRaw', 'unsettledFeesRaw', 'roundingResidualRaw',
             'principalDepositedRaw', 'principalWithdrawnRaw', 'settledFeesRaw')
    return {**{name: list(summary[name]) for name in names},
            'sqrtPriceX96': activity['sqrtPriceX96'], 'tick': activity['tick']}


def replay_capital(activity, model, events, pool_id, key, **kwargs):
    points = []
    def observe(event, next_activity, next_model):
        points.append({'blockHash': event['blockHash'], 'logIndex': event['logIndex'],
                       'capital': capital_point(next_activity, next_model)})
    activity, model, _ = replay_positions(activity, model, events, pool_id, key, observe=observe, **kwargs)
    return activity, model, points


class CapitalIndexer:
    def __init__(self, store, rpc, *, capacity='standard'):
        self.store = store
        self.activity = ActivityIndexer(store, rpc)
        self.capacity = capacity_profile(capacity)
        self.positions = PositionIndexer(store, rpc, capacity=capacity)

    def step(self, pool_id):
        pool_id = bytes32(pool_id)
        try:
            return self._step(pool_id)
        except DataError as error:
            record_failure(self.store, pool_id, 'capital', self.capacity, str(error))
            raise

    def restart(self, pool_id):
        """Operator-only recovery: discard unpublished work after source review.

        Canonical evidence must be available. Activity rewind remains the only
        recovery for an orphaned source; this command never changes source or
        qualified capital rows. The CLI report records what was discarded.
        """
        pool_id = bytes32(pool_id)
        self.activity.chain.check_chain()
        with self.store.catalogue.connection(writer=True, lock=True) as conn:
            self.store.pool(conn, pool_id)
            work = conn.execute('''SELECT w.progress,w.diagnostic,c.* FROM domino_activity.historical_work w
              JOIN domino_activity.chunks c ON c.pool_id=w.pool_id AND c.start_block=w.chunk_start
              WHERE w.pool_id=%s AND w.ledger='capital' ''', (pool_id,)).fetchone()
            if not work:
                return {'status': 'no_capital_work', 'ledger': 'capital'}
            tail = self.store.tail(conn, pool_id)
            block = self.activity.chain.block(work['end_block'])
            if (block.hash != work['end_hash'] or block.timestamp != work['end_timestamp'] or
                    self.activity.chain.block(tail['end_block']).hash != tail['end_hash']):
                raise DataError('capital_activity_reorg_requires_replay')
            self._canonical(block, tail)
            clear_work(conn, pool_id, 'capital')
            return {'status': 'capital_work_restarted', 'ledger': 'capital',
                    'fromBlock': work['start_block'], 'throughBlock': work['end_block'],
                    'discardedCheckpointDigest': capital_work.digest(work['progress']),
                    'previousDiagnostic': work['diagnostic'], 'qualifiedCapitalRetained': True}

    def _step(self, pool_id):
        pool_id = bytes32(pool_id)
        self.activity.chain.check_chain()
        with self.store.catalogue.connection(writer=True, lock=True) as conn:
            row = self.store.pool(conn, pool_id)
            key = checked_key(row['pool_key'], pool_id)
            tail = self.store.tail(conn, pool_id)
            if not tail:
                raise DataError('activity_not_indexed')
            if self.activity.chain.block(tail['end_block']).hash != tail['end_hash']:
                raise DataError('capital_activity_reorg_requires_replay')
            chunk = conn.execute('''SELECT c.* FROM domino_activity.chunks c
              LEFT JOIN domino_activity.capital_chunks k ON k.pool_id=c.pool_id AND k.chunk_start=c.start_block
              WHERE c.pool_id=%s AND k.pool_id IS NULL ORDER BY c.start_block LIMIT 1''', (pool_id,)).fetchone()
            if not chunk:
                return {'status': 'caught_up_to_activity', 'through': tail['end_block']}
            # Existing position audit sums are cumulative at the tail, so validate that tail once.
            qualified = read_positions(conn, row, tail)
            if qualified['status'] != 'reconciled_as_of':
                raise DataError('reconciled_position_tail_required')
            source = conn.execute('SELECT * FROM domino_activity.position_chunks WHERE pool_id=%s AND chunk_start=%s',
                                  (pool_id, chunk['start_block'])).fetchone()
            if not source or source['methodology_version'] != POSITION_VERSION:
                raise DataError('reconciled_position_chunk_required')
            previous = conn.execute('''SELECT c.*,p.model AS position_model,
              p.methodology_version AS position_version,k.methodology_version AS capital_version
              FROM domino_activity.chunks c JOIN domino_activity.position_chunks p
              ON p.pool_id=c.pool_id AND p.chunk_start=c.start_block
              LEFT JOIN domino_activity.capital_chunks k ON k.pool_id=c.pool_id AND k.chunk_start=c.start_block
              WHERE c.pool_id=%s AND c.end_block=%s''', (pool_id, chunk['start_block']-1)).fetchone()
            if ((previous and (previous['capital_version'] != VERSION or previous['position_version'] != POSITION_VERSION)) or
                    (not previous and chunk['start_block'] != row['start_block'])):
                raise DataError('capital_history_anchor_required')
            events = conn.execute('''SELECT pool_id AS "poolId",block_number AS "blockNumber",
              block_hash AS "blockHash",block_timestamp AS timestamp,log_index AS "logIndex",kind,payload
              FROM domino_activity.events WHERE pool_id=%s AND chunk_start=%s
              ORDER BY block_number,log_index LIMIT 2001''', (pool_id, chunk['start_block'])).fetchall()
            if len(events) > 2000:
                raise DataError('capital_event_budget_exhausted')
            block = self.activity.chain.block(chunk['end_block'])
            if block.hash != chunk['end_hash'] or block.timestamp != chunk['end_timestamp']:
                raise DataError('capital_activity_reorg_requires_replay')
            binding = capital_work.bind_source(pool_id, key, chunk, source, previous, events)
            progress = capital_work.load(conn, pool_id, chunk['start_block'], binding, events)
            activity, model, points, offset = replay_batch(replay_capital,
                progress['activity'] if progress else previous['model'] if previous else None,
                progress['model'] if progress else previous['position_model'] if previous else None,
                events, progress['offset'] if progress else 0, pool_id, key, capacity=self.capacity)
            points = (progress['rows'] if progress else []) + points
            pending = {'version': 1, 'activity': activity, 'model': model, 'rows': points,
                       'offset': offset, 'totalEvents': len(events), 'checks': progress['checks'] if progress else 0}
            if not model or model.get('version') != POSITION_VERSION:
                raise DataError('capital_source_ledger_mismatch')
            # Honor selected limits even on empty later chunks or proof-only resumes.
            if len(model['positions']) > self.capacity.positions:
                raise DataError('core_position_budget_exhausted')
            if len(model['ticks']) > self.capacity.ticks:
                raise DataError('core_tick_budget_exhausted')
            if offset < len(events):
                self._canonical(block, tail)
                return save_work(conn, pool_id, 'capital', chunk, self.capacity, capital_work.seal(pending, binding))
            if activity != chunk['model'] or model != source['model']:
                raise DataError('capital_source_ledger_mismatch')
            if self.activity.read_state(pool_id, block, key) != chunk['state_snapshot']:
                raise DataError('capital_state_reconciliation_failed')
            required = len(model['positions']) + len(model['ticks']) + len({
                (p['tickLower'], p['tickUpper']) for p in model['positions'].values()})
            if pending['checks'] > required or (pending['checks'] and progress.get('requiredChecks') != required):
                raise DataError('capital_work_checkpoint_mismatch')
            self.positions.check_offset = pending['checks']
            try:
                proof = self.positions.check_positions(pool_id, block, activity, model)
            finally:
                self.positions.check_offset = None
            if proof != source['reconciliation']:
                raise DataError('capital_position_reconciliation_failed')
            self._canonical(block, tail)
            if self.positions.completed_checks < self.positions.required_checks:
                pending['checks'], pending['requiredChecks'] = self.positions.completed_checks, required
                return save_work(conn, pool_id, 'capital', chunk, self.capacity, capital_work.seal(pending, binding))
            # Byte limits apply only to saved unpublished work, not a final row
            # that is never written to historical_work. Publication is atomic.
            conn.execute('INSERT INTO domino_activity.capital_chunks VALUES(%s,%s,%s,%s,%s)',
                         (pool_id, chunk['start_block'], VERSION, len(points), Jsonb(capital_point(activity, model))))
            for point in points:
                conn.execute('INSERT INTO domino_activity.capital_events VALUES(%s,%s,%s,%s,%s)',
                    (pool_id, point['blockHash'], point['logIndex'], chunk['start_block'], Jsonb(point['capital'])))
            clear_work(conn, pool_id, 'capital')
            return {'status': 'capital_chunk_reconciled', 'fromBlock': chunk['start_block'],
                    'through': block.number, 'capitalEvents': len(points)}

    def _canonical(self, block, tail):
        if (self.activity.chain.block(block.number) != block or
                self.activity.chain.block(tail['end_block']).hash != tail['end_hash']):
            raise DataError('capital_activity_reorg_requires_replay')


def load_capital_window(conn, row, tail):
    """Boundary state plus every change: sparse chunk-end samples are never averaged."""
    pool_id = row['pool_id']
    positions = read_positions(conn, row, tail)
    if positions['status'] != 'reconciled_as_of':
        raise DataError('reconciled_position_tail_required')
    audit = conn.execute('''SELECT count(*) AS chunks, count(k.pool_id) AS qualified,
      COALESCE(sum(k.event_count),0) AS events, min(k.methodology_version) AS min_version,
      max(k.methodology_version) AS max_version FROM domino_activity.chunks c
      LEFT JOIN domino_activity.capital_chunks k ON k.pool_id=c.pool_id AND k.chunk_start=c.start_block
      WHERE c.pool_id=%s''', (pool_id,)).fetchone()
    if audit['chunks'] != audit['qualified']:
        raise DataError('capital_ledger_not_caught_up')
    continuity = conn.execute('''SELECT min(start_block) AS first_block,max(end_block) AS last_block,
      count(*) FILTER (WHERE previous_end IS NOT NULL AND previous_end<>start_block-1) AS gaps
      FROM (SELECT start_block,end_block,lag(end_block) OVER (ORDER BY start_block) AS previous_end
            FROM domino_activity.chunks WHERE pool_id=%s) stream''', (pool_id,)).fetchone()
    if (continuity['first_block'] != row['start_block'] or continuity['last_block'] != tail['end_block'] or
            continuity['gaps'] or row['next_block'] != tail['end_block']+1):
        raise DataError('capital_source_history_gap')
    count = conn.execute('''SELECT count(*) AS events,count(k.pool_id) AS capital FROM domino_activity.events e
      LEFT JOIN domino_activity.capital_events k ON k.pool_id=e.pool_id AND k.block_hash=e.block_hash
      AND k.log_index=e.log_index WHERE e.pool_id=%s''', (pool_id,)).fetchone()
    if (audit['min_version'] != VERSION or audit['max_version'] != VERSION or
            audit['events'] != count['events'] or count['events'] != count['capital'] or
            count['events'] != tail['model']['eventCount']):
        raise DataError('stored_capital_events_incomplete')
    end = conn.execute('SELECT end_capital FROM domino_activity.capital_chunks WHERE pool_id=%s AND chunk_start=%s',
                       (pool_id, tail['start_block'])).fetchone()['end_capital']
    for name in ('lpAssetsRaw', 'principalRaw', 'unsettledFeesRaw', 'roundingResidualRaw'):
        if end[name] != positions[name]:
            raise DataError('stored_capital_tail_mismatch')
    start = max(tail['model']['initializedAt'], tail['end_timestamp']-86400)
    # Last event at a same-second boundary wins; fees still use the exclusive lower bound.
    base = conn.execute('''SELECT e.block_number AS "blockNumber",e.block_timestamp AS timestamp,
      e.log_index AS "logIndex",k.capital FROM domino_activity.events e JOIN domino_activity.capital_events k
      ON k.pool_id=e.pool_id AND k.block_hash=e.block_hash AND k.log_index=e.log_index
      WHERE e.pool_id=%s AND e.block_timestamp<=%s ORDER BY e.block_number DESC,e.log_index DESC LIMIT 1''',
      (pool_id, start)).fetchone()
    if not base:
        raise DataError('capital_window_boundary_missing')
    events = conn.execute('''SELECT e.block_number AS "blockNumber",e.block_timestamp AS timestamp,
      e.log_index AS "logIndex",e.kind,e.payload,k.capital,f.fees FROM domino_activity.events e
      JOIN domino_activity.capital_events k ON k.pool_id=e.pool_id AND k.block_hash=e.block_hash AND k.log_index=e.log_index
      LEFT JOIN domino_activity.fee_events f ON f.pool_id=e.pool_id AND f.block_hash=e.block_hash AND f.log_index=e.log_index
      WHERE e.pool_id=%s AND e.block_timestamp>%s AND e.block_timestamp<=%s
      ORDER BY e.block_number,e.log_index LIMIT 50001''', (pool_id, start, tail['end_timestamp'])).fetchall()
    if len(events) > MAX_WINDOW_EVENTS:
        raise DataError('capital_window_budget_exhausted')
    # Include swaps at the initialization timestamp when the pool is younger than a day.
    swaps = conn.execute('''SELECT e.block_timestamp AS timestamp,e.block_number AS "blockNumber",
      e.log_index AS "logIndex",e.payload,f.fees FROM domino_activity.events e
      LEFT JOIN domino_activity.fee_events f ON f.pool_id=e.pool_id AND f.block_hash=e.block_hash AND f.log_index=e.log_index
      WHERE e.pool_id=%s AND e.kind='swap' AND e.block_timestamp>%s AND e.block_timestamp<=%s
      ORDER BY e.block_number,e.log_index LIMIT 50001''',
      (pool_id, tail['end_timestamp']-86400, tail['end_timestamp'])).fetchall()
    if len(swaps) > MAX_WINDOW_EVENTS or any(s['fees'] is None for s in swaps):
        raise DataError('capital_window_fees_incomplete')
    return {'start': start, 'end': tail['end_timestamp'], 'initializedAt': tail['model']['initializedAt'],
            'base': base, 'events': events, 'swaps': swaps, 'endCapital': end,
            'sourceEventCount': count['events'], 'sourceChunks': audit['chunks']}


def capital_intervals(window):
    current, previous = window['base']['capital'], window['start']
    for event in window['events']:
        timestamp = event['timestamp']
        if not previous <= timestamp <= window['end']:
            raise DataError('capital_timestamps_not_monotonic')
        if timestamp > previous:
            yield previous, timestamp, current
        previous, current = timestamp, event['capital']
    if previous < window['end']:
        yield previous, window['end'], current
    if current != window['endCapital']:
        raise DataError('capital_window_tail_mismatch')


def raw_capital_metrics(window):
    seconds = window['end']-window['start']
    integral = {name: [0, 0] for name in ('lpAssetsRaw', 'principalRaw', 'unsettledFeesRaw', 'roundingResidualRaw')}
    for start, end, point in capital_intervals(window):
        for name in integral:
            for i in (0, 1):
                integral[name][i] += int(point[name][i])*(end-start)
    return {'methodologyVersion': VERSION, 'status': 'reconciled_event_history',
            'fromTimestampInclusive': window['start'], 'throughTimestamp': window['end'],
            'observedSeconds': seconds, 'complete24h': seconds == 86400,
            'timeWeighting': 'post_event_step_function_last_event_wins_at_same_timestamp',
            'tvlBasis': 'lp_attributed_assets_including_unsettled_fees_and_rounding_residual_excluding_protocol',
            'current': window['endCapital'],
            'integralRawSeconds': {k: list(map(str, v)) for k, v in integral.items()},
            'averageDenominatorSeconds': seconds, 'sourceEventCount': window['sourceEventCount'],
            'sourceChunks': window['sourceChunks'], 'isInvestorPnl': False}
