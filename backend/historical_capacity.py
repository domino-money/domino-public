"""Trusted worker resource profiles and unpublished, resumable sidecar work.

These limits bound local work; they are not v4 arithmetic or admission rules.
No profile drops closed identities or clears their reconciliation obligations.
"""
import json
from dataclasses import dataclass

from psycopg.types.json import Jsonb

from discovery import DataError


@dataclass(frozen=True)
class Capacity:
    name: str
    positions: int
    ticks: int


PROFILES = {'standard': Capacity('standard', 128, 256),
            'extended': Capacity('extended', 1024, 2048)}
MAX_BATCH_EVENTS = 32
MAX_BATCH_CHECKS = 128
MAX_PROGRESS_BYTES = 8 * 1024 * 1024


def capacity_profile(name):
    if not isinstance(name,str) or name not in PROFILES:
        raise DataError('invalid_historical_capacity_profile')
    return PROFILES[name]


def load_work(conn, pool_id, ledger, chunk_start):
    row = conn.execute('''SELECT progress FROM domino_activity.historical_work
      WHERE pool_id=%s AND ledger=%s AND chunk_start=%s''',
      (pool_id, ledger, chunk_start)).fetchone()
    value = row['progress'] if row else None
    if value is not None:
        if not isinstance(value,dict) or value.get('version') != 1:
            raise DataError('historical_work_version_mismatch')
        offset,total,checks=value.get('offset'),value.get('totalEvents'),value.get('checks',0)
        if (type(offset) is not int or type(total) is not int or not 0<=offset<=total<=2000 or
                type(checks) is not int or not 0<=checks<=4096 or
                (checks and offset!=total) or not isinstance(value.get('rows'),list) or
                len(value['rows'])>offset or not isinstance(value.get('model'),dict) or
                value['model'].get('version')!=1 or not isinstance(value.get('activity'),dict)):
            raise DataError('historical_work_checkpoint_mismatch')
    return value


def diagnostic(chunk, profile, progress, reason=None):
    view=progress if isinstance(progress,dict) else {}
    def count(name,default=None):
        value=view.get(name,default)
        return value if type(value) is int and 0<=value<=4096 else default
    return {'status': 'blocked' if reason else 'in_progress', 'reason': reason,
            'capacityProfile': profile.name, 'fromBlock': chunk['start_block'],
            'throughBlock': chunk['end_block'],
            'processedEvents': count('offset',0),
            'totalEvents': count('totalEvents'),
            'phase': ('reconciliation' if count('totalEvents') is not None and count('offset')==count('totalEvents') else 'replay'),
            'completedChecks': count('checks',0),
            'requiredChecks': count('requiredChecks'),
            'limits': {'positions':profile.positions,'ticks':profile.ticks,
                       'eventsPerBatch':MAX_BATCH_EVENTS,'checksPerBatch':MAX_BATCH_CHECKS,
                       'progressBytes':MAX_PROGRESS_BYTES},
            'action': ('select_extended_profile_and_resume' if reason in
                {'core_position_budget_exhausted', 'core_tick_budget_exhausted'} and profile.name == 'standard'
                else 'capacity_review_required' if reason in
                {'core_position_budget_exhausted', 'core_tick_budget_exhausted',
                 'fee_step_budget_exhausted', 'historical_work_byte_budget_exhausted'}
                else 'restart_capital_work_after_review' if reason in
                {'capital_work_method_mismatch', 'capital_work_source_mismatch',
                 'capital_work_checkpoint_mismatch'}
                else 'repair_source_then_resume' if reason else 'resume_same_command')}


def check_work_size(progress):
    if len(json.dumps(progress).encode()) > MAX_PROGRESS_BYTES:
        raise DataError('historical_work_byte_budget_exhausted')


def save_work(conn, pool_id, ledger, chunk, profile, progress):
    check_work_size(progress)
    detail = diagnostic(chunk, profile, progress)
    conn.execute('''INSERT INTO domino_activity.historical_work VALUES(%s,%s,%s,%s,%s)
      ON CONFLICT(pool_id,ledger) DO UPDATE SET chunk_start=EXCLUDED.chunk_start,
      progress=EXCLUDED.progress,diagnostic=EXCLUDED.diagnostic''',
      (pool_id, ledger, chunk['start_block'], Jsonb(progress), Jsonb(detail)))
    return {'status': ledger + '_chunk_in_progress', **{k:v for k,v in detail.items() if k != 'status'}}


def clear_work(conn, pool_id, ledger):
    conn.execute('DELETE FROM domino_activity.historical_work WHERE pool_id=%s AND ledger=%s', (pool_id, ledger))


def record_failure(store, pool_id, ledger, profile, reason):
    """Best-effort diagnostic after rollback; preserve the original worker error."""
    if reason == 'catalogue_writer_busy':
        return
    try:
        with store.catalogue.connection(writer=True, lock=True) as conn:
            # Fixed internal ledger names only, never request-derived SQL identifiers.
            table = {'fee':'fee_chunks', 'position':'position_chunks', 'capital':'capital_chunks'}[ledger]
            chunk = conn.execute('SELECT c.* FROM domino_activity.chunks c LEFT JOIN domino_activity.' + table + ''' q
              ON q.pool_id=c.pool_id AND q.chunk_start=c.start_block
              WHERE c.pool_id=%s AND q.pool_id IS NULL ORDER BY c.start_block LIMIT 1''', (pool_id,)).fetchone()
            if not chunk:
                return
            stored=conn.execute('''SELECT progress FROM domino_activity.historical_work
              WHERE pool_id=%s AND ledger=%s AND chunk_start=%s''',(pool_id,ledger,chunk['start_block'])).fetchone()
            progress=stored['progress'] if stored else None
            conn.execute('''INSERT INTO domino_activity.historical_work VALUES(%s,%s,%s,%s,%s)
              ON CONFLICT(pool_id,ledger) DO UPDATE SET chunk_start=EXCLUDED.chunk_start,
              progress=EXCLUDED.progress,diagnostic=EXCLUDED.diagnostic''',
              (pool_id, ledger, chunk['start_block'], Jsonb(progress), Jsonb(diagnostic(chunk, profile, progress, reason))))
    except DataError:
        # A lock race or database outage must not mask the rolled-back ledger failure.
        return


def unavailable_work(conn, pool_id, ledger):
    row = conn.execute('SELECT diagnostic FROM domino_activity.historical_work WHERE pool_id=%s AND ledger=%s',
                       (pool_id, ledger)).fetchone()
    if not row:
        return {}
    detail = row['diagnostic']
    return {'historicalWork': detail, **({'reason': detail['reason']} if detail['reason'] else {})}


def replay_batch(replay, activity, model, events, offset, pool_id, key, *, capacity=None):
    """Commit complete events only; share one simulation budget across this batch.

    A failed event consumes this invocation's budget, but cannot mutate the last
    complete prefix. Retrying that event next invocation starts from that prefix.
    A single event that exceeds the fixed limit remains explicitly unsupported.
    """
    from fee_accounting import MAX_CHUNK_STEPS
    budget = [MAX_CHUNK_STEPS]
    rows = []
    end = min(len(events), offset + MAX_BATCH_EVENTS)
    for index in range(offset, end):
        try:
            args = {'budget': budget, **({'capacity': capacity} if capacity is not None else {})}
            next_activity, next_model, changes = replay(activity, model, [events[index]], pool_id, key, **args)
        except DataError as error:
            if str(error) == 'fee_step_budget_exhausted' and index > offset:
                return activity, model, rows, index
            raise
        activity, model = next_activity, next_model
        rows.extend(changes)
    return activity, model, rows, end
