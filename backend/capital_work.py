"""Source- and implementation-bound unpublished capital checkpoints."""
import hashlib
import json
from pathlib import Path

from discovery import DataError
from historical_capacity import PROFILES


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


# Bind the code loaded by this worker, including arithmetic and proof ordering.
# A changed implementation requires an explicit restart of unpublished work;
# it does not invalidate already qualified v1 capital chunks.
METHOD_DIGEST = digest({name: hashlib.sha256((Path(__file__).parent / name).read_bytes()).hexdigest()
    for name in ('capital_work.py', 'capital_store.py', 'position_store.py', 'historical_work.py',
                 'activity_indexer.py',
                 'position_accounting.py', 'fee_accounting.py', 'v4_math.py',
                 'pool_activity.py', 'historical_capacity.py')})


def bind_source(pool_id, key, chunk, source, previous, events):
    return digest({'poolId': pool_id, 'key': key.__dict__, 'chunk': chunk,
                   'positionSource': source, 'previous': previous, 'events': events})


def seal(progress, source_digest):
    value = {**progress, 'methodDigest': METHOD_DIGEST, 'sourceDigest': source_digest}
    return {**value, 'checkpointDigest': digest(value)}


def load(conn, pool_id, chunk_start, source_digest, events):
    row = conn.execute('''SELECT progress FROM domino_activity.historical_work
      WHERE pool_id=%s AND ledger='capital' AND chunk_start=%s''', (pool_id, chunk_start)).fetchone()
    value = row['progress'] if row else None
    if value is None:
        return None
    if not isinstance(value, dict) or value.get('version') != 1:
        raise DataError('capital_work_checkpoint_mismatch')
    if value.get('methodDigest') != METHOD_DIGEST:
        raise DataError('capital_work_method_mismatch')
    if value.get('sourceDigest') != source_digest:
        raise DataError('capital_work_source_mismatch')
    if value.get('checkpointDigest') != digest({k: v for k, v in value.items() if k != 'checkpointDigest'}):
        raise DataError('capital_work_checkpoint_mismatch')
    offset, checks = value.get('offset'), value.get('checks')
    maximum = max(p.positions * 2 + p.ticks for p in PROFILES.values())
    if (type(offset) is not int or not 0 <= offset <= len(events) <= 2000 or
            value.get('totalEvents') != len(events) or type(checks) is not int or
            not 0 <= checks <= maximum or (checks and offset != len(events)) or
            not isinstance(value.get('rows'), list) or len(value['rows']) != offset or
            not isinstance(value.get('model'), dict) or not isinstance(value.get('activity'), dict)):
        raise DataError('capital_work_checkpoint_mismatch')
    # A complete-event prefix has exactly one capital point for every source event.
    for point, event in zip(value['rows'], events[:offset]):
        if (not isinstance(point, dict) or point.get('blockHash') != event['blockHash'] or
                point.get('logIndex') != event['logIndex'] or not isinstance(point.get('capital'), dict)):
            raise DataError('capital_work_checkpoint_mismatch')
    return value
