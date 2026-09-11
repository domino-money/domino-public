"""Implementation- and source-bound unpublished fee/position checkpoints."""
import hashlib
import json
from pathlib import Path

from discovery import DataError, bytes32
from historical_capacity import clear_work, load_work


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


# Includes replay arithmetic, checkpoint semantics and the ordering of proof calls.
# Profile selection is deliberately not part of the binding: a reviewed upgrade
# must be able to resume the same prefix under the next trusted resource profile.
METHOD_DIGEST = digest({name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest()
    for name in ('historical_work.py', 'historical_capacity.py', 'fee_store.py',
                 'position_store.py', 'fee_accounting.py', 'position_accounting.py',
                 'v4_math.py', 'pool_activity.py', 'activity_indexer.py')})


def bind_source(pool_id, key, ledger, chunk, previous, events, fee=None):
    return digest({'poolId': pool_id, 'key': key.__dict__, 'ledger': ledger,
                   'chunk': chunk, 'previous': previous, 'events': events, 'feeSource': fee})


def seal(progress, source_digest):
    value = {**progress, 'methodDigest': METHOD_DIGEST, 'sourceDigest': source_digest}
    return {**value, 'checkpointDigest': digest(value)}


def load(conn, pool_id, ledger, chunk_start, source_digest, events):
    value = load_work(conn, pool_id, ledger, chunk_start)
    if value is None:
        return None
    if value.get('methodDigest') != METHOD_DIGEST:
        raise DataError('historical_work_method_mismatch')
    if value.get('sourceDigest') != source_digest:
        raise DataError('historical_work_source_mismatch')
    if value.get('checkpointDigest') != digest({k: v for k, v in value.items() if k != 'checkpointDigest'}):
        raise DataError('historical_work_checkpoint_mismatch')
    if value['totalEvents'] != len(events):
        raise DataError('historical_work_checkpoint_mismatch')
    kind = {'fee': 'swap', 'position': 'modify_liquidity'}[ledger]
    expected = [event for event in events[:value['offset']] if event['kind'] == kind]
    if len(value['rows']) != len(expected):
        raise DataError('historical_work_checkpoint_mismatch')
    for row, event in zip(value['rows'], expected):
        if (not isinstance(row, dict) or row.get('blockHash') != event['blockHash'] or
                row.get('logIndex') != event['logIndex']):
            raise DataError('historical_work_checkpoint_mismatch')
    return value


def restart(worker, pool_id, ledger):
    """Explicit operator recovery; published ledgers and source history survive."""
    table = {'fee': 'fee_chunks', 'position': 'position_chunks'}[ledger]
    pool_id = bytes32(pool_id)
    worker.activity.chain.check_chain()
    with worker.store.catalogue.connection(writer=True, lock=True) as conn:
        worker.store.pool(conn, pool_id)
        work = conn.execute('''SELECT w.progress,w.diagnostic,c.* FROM domino_activity.historical_work w
          JOIN domino_activity.chunks c ON c.pool_id=w.pool_id AND c.start_block=w.chunk_start
          WHERE w.pool_id=%s AND w.ledger=%s''', (pool_id, ledger)).fetchone()
        if not work:
            return {'status': 'no_' + ledger + '_work', 'ledger': ledger}
        if conn.execute('SELECT 1 FROM domino_activity.' + table +
                        ' WHERE pool_id=%s AND chunk_start=%s', (pool_id, work['start_block'])).fetchone():
            raise DataError('historical_work_already_qualified')
        tail = worker.store.tail(conn, pool_id)
        block = worker.activity.chain.block(work['end_block'])
        if (block.hash != work['end_hash'] or block.timestamp != work['end_timestamp'] or
                worker.activity.chain.block(tail['end_block']).hash != tail['end_hash'] or
                worker.activity.chain.block(block.number) != block or
                worker.activity.chain.block(tail['end_block']).hash != tail['end_hash']):
            raise DataError(ledger + '_activity_reorg_requires_replay')
        clear_work(conn, pool_id, ledger)
        return {'status': ledger + '_work_restarted', 'ledger': ledger,
                'fromBlock': work['start_block'], 'throughBlock': work['end_block'],
                'discardedCheckpointDigest': digest(work['progress']),
                'previousDiagnostic': work['diagnostic'], 'qualifiedHistoryRetained': True}
