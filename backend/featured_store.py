"""Featured-pools persistence (043_featured_pools.sql): runs, lists, overrides, token baselines.

One writer: the selector, as the catalogue writer role. A run records the
whole evaluation, so every rejection can be audited; a list is immutable once
written, and one selection per date and phase exists at most.

A store serves one chain (055_featured_chains.sql, launch round P3, 4 Nov 2026):
every row it reads or writes is its chain's, so Base's and Arbitrum One's shadow
selections share these tables without reaching Robinhood's, nor each other's.
Only Robinhood is served (featured_current, read-v5): another chain's store keeps
its lists in shadow and refuses the live phase and every serving step.
"""
from contextlib import contextmanager
from datetime import date, datetime, timezone
import re

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from discovery import CHAIN_ID, DataError, address, bytes32

WRITER_ROLE = 'domino_catalogue_writer'
# Session lock held for a whole selection; the public-data locks use 46630240-51.
SELECTOR_LOCK = 46630260
# Another chain's selection holds its own (v2_index_store's namespace is 0x4632 << 40).
CHAIN_SELECTOR_LOCKS = 0x4646 << 40
DONE = ('bootstrap', 'selected', 'carried_over')
RUN_RETENTION_DAYS = 90
# What only a served list has: another chain's list stays in shadow until read-v5 takes a chain.
SERVING_KINDS = ('mode', 'manual', 'veto', 'phase')


def utc_date(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).date()


class FeaturedStore:
    def __init__(self, catalogue, chain_id=CHAIN_ID):
        if type(chain_id) is not int or not 0 < chain_id < 1 << 40:
            raise DataError('invalid_featured_chain')
        self.catalogue, self.chain_id = catalogue, chain_id

    def _served(self):
        """Serving is Robinhood's alone: featured_current holds one list, the one read-v5 answers."""
        if self.chain_id != CHAIN_ID:
            raise DataError('featured_chain_shadow_only')

    def pool_subject(self, pool_id):
        """A pool as overrides name it: a v4 id, or on another chain also a v3 pool's address."""
        if self.chain_id != CHAIN_ID and isinstance(pool_id, str) and len(pool_id) == 42:
            return address(pool_id)
        return bytes32(pool_id)

    @contextmanager
    def connection(self):
        try:
            with psycopg.connect(**self.catalogue.settings, user=WRITER_ROLE, connect_timeout=3,
                                 row_factory=dict_row) as conn:
                conn.execute("SET LOCAL statement_timeout='10000ms'")
                yield conn
        except psycopg.Error:
            raise DataError('featured_database_unavailable') from None

    @contextmanager
    def selector_lock(self):
        """Hold the selector's session lock, or refuse: two selections never overlap."""
        try:
            lock = SELECTOR_LOCK if self.chain_id == CHAIN_ID else CHAIN_SELECTOR_LOCKS | self.chain_id
            with psycopg.connect(**self.catalogue.settings, user=WRITER_ROLE, connect_timeout=3,
                                 autocommit=True) as conn:
                held = conn.execute('SELECT pg_try_advisory_lock(%s)', (lock,)).fetchone()[0]
                if not held:
                    raise DataError('featured_selector_busy')
                try:
                    yield
                finally:
                    conn.execute('SELECT pg_advisory_unlock(%s)', (lock,))
        except psycopg.Error:
            raise DataError('featured_database_unavailable') from None

    def selection_done(self, phase, day):
        with self.connection() as conn:
            return conn.execute('''SELECT 1 FROM domino_public.featured_runs WHERE chain_id=%s AND phase=%s
              AND selection_date=%s AND outcome=ANY(%s) LIMIT 1''',
              (self.chain_id, phase, day, list(DONE))).fetchone() is not None

    def previous_evaluation(self, phase, now, hours):
        """The most recent completed run within `hours`, of either phase: {poolId: its evaluation}.

        A shadow run is the same evaluation a live one makes, so going live
        does not cost a day without an evaluation to persist against.
        """
        with self.connection() as conn:
            row = conn.execute('''SELECT id,evaluation FROM domino_public.featured_runs WHERE chain_id=%s
              AND outcome=ANY(%s) AND started_at>=to_timestamp(%s) ORDER BY started_at DESC,id DESC LIMIT 1''',
              (self.chain_id, list(DONE), now - hours * 3600)).fetchone()
        if row is None:
            return None
        return {'runId': row['id'], 'pools': {item['poolId']: item for item in row['evaluation']['evaluations']}}

    def previous_list(self, phase):
        """The list the next selection starts from: the served one when live."""
        if phase == 'live':
            served = self.current()
            return None if served is None else {'revision': served['revision'], 'listId': served['list_id'],
                                                 'pools': served['payload']['pools']}
        with self.connection() as conn:
            row = conn.execute('''SELECT revision,list_id,payload FROM domino_public.featured_lists
              WHERE chain_id=%s AND phase=%s ORDER BY revision DESC LIMIT 1''', (self.chain_id, phase)).fetchone()
        return None if row is None else {'revision': row['revision'], 'listId': row['list_id'],
                                         'pools': row['payload']['pools']}

    def overrides(self, now):
        """Owner overrides in force at `now`, as the rules consume them."""
        with self.connection() as conn:
            rows = conn.execute('''SELECT id,kind,subject,value FROM domino_public.featured_overrides
              WHERE chain_id=%s AND revoked_at IS NULL AND (until IS NULL OR until>to_timestamp(%s)) ORDER BY id''',
              (self.chain_id, now)).fetchall()
        pins = [{'poolId': row['subject'], 'slot': row['value']['slot']} for row in rows if row['kind'] == 'pin']
        latest = {row['kind']: row for row in rows}   # rows are in id order: the last one of a kind wins
        return {'pins': pins,
                'excludedPools': sorted(row['subject'] for row in rows if row['kind'] == 'exclude_pool'),
                'excludedTokens': sorted(row['subject'] for row in rows if row['kind'] == 'exclude_token'),
                'mode': latest['mode']['subject'] if 'mode' in latest else 'auto',
                'manualPools': latest['manual']['value']['pools'] if 'manual' in latest else [],
                'vetoes': sorted(row['subject'] for row in rows if row['kind'] == 'veto'),
                'phase': latest['phase']['subject'] if 'phase' in latest else 'shadow',
                'ids': [row['id'] for row in rows]}

    def add_override(self, kind, subject, *, reason, value=None, until=None):
        subjects = {'mode': ('auto', 'manual', 'off'), 'phase': ('shadow', 'live'), 'manual': ('manual',)}
        if kind in SERVING_KINDS:
            self._served()
        if kind in subjects:
            if subject not in subjects[kind]:
                raise DataError('invalid_featured_override')
        elif kind == 'veto':
            if not isinstance(subject, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', subject):
                raise DataError('invalid_featured_override')
            try:
                date.fromisoformat(subject)
            except ValueError:
                raise DataError('invalid_featured_override') from None
        elif kind in ('pin', 'exclude_pool', 'exclude_token'):
            subject = address(subject) if kind == 'exclude_token' else self.pool_subject(subject)
        else:
            raise DataError('invalid_featured_override')
        if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 500:
            raise DataError('invalid_featured_override')
        if kind == 'pin' and (not isinstance(value, dict) or set(value) != {'slot'} or type(value['slot']) is not int):
            raise DataError('invalid_featured_override')
        if kind == 'manual':
            pools = value.get('pools') if isinstance(value, dict) and set(value) == {'pools'} else None
            if not isinstance(pools, list) or not 1 <= len(pools) <= 12:
                raise DataError('invalid_featured_override')
            value = {'pools': [self.pool_subject(pool_id) for pool_id in pools]}
            if len(set(value['pools'])) != len(value['pools']):
                raise DataError('invalid_featured_override')
        with self.connection() as conn:
            # One pin per pool, one mode, one manual list, one phase: the new one replaces the old.
            if kind == 'pin':
                conn.execute('''UPDATE domino_public.featured_overrides SET revoked_at=clock_timestamp()
                  WHERE chain_id=%s AND kind='pin' AND subject=%s AND revoked_at IS NULL''', (self.chain_id, subject))
            elif kind in ('mode', 'manual', 'phase'):
                conn.execute('''UPDATE domino_public.featured_overrides SET revoked_at=clock_timestamp()
                  WHERE chain_id=%s AND kind=%s AND revoked_at IS NULL''', (self.chain_id, kind))
            return conn.execute('''INSERT INTO domino_public.featured_overrides(chain_id,kind,subject,value,reason,until)
              VALUES(%s,%s,%s,%s,%s,to_timestamp(%s)) RETURNING id''',
              (self.chain_id, kind, subject, Jsonb(value or {}), reason.strip(), until)).fetchone()['id']

    def revoke_override(self, kind, subject):
        if kind in ('pin', 'exclude_pool'):
            subject = self.pool_subject(subject)
        elif kind == 'exclude_token':
            subject = address(subject)
        with self.connection() as conn:
            return [row['id'] for row in conn.execute('''UPDATE domino_public.featured_overrides
              SET revoked_at=clock_timestamp() WHERE chain_id=%s AND kind=%s AND subject=%s AND revoked_at IS NULL
              RETURNING id''', (self.chain_id, kind, subject)).fetchall()]

    def token_baselines(self):
        """{address: row} for every token a list has shown: TA-3 readings and TA-5 hashes."""
        with self.connection() as conn:
            rows = conn.execute('''SELECT address,symbol_reading,listed_code_hash FROM
              domino_public.featured_token_checks WHERE chain_id=%s AND first_listed_at IS NOT NULL''',
              (self.chain_id,)).fetchall()
        return {row['address']: row for row in rows}

    def record(self, *, phase, day, outcome, policy_version, started_at, finished_at, evaluation, listing=None,
               tokens=(), listed_tokens=()):
        """One transaction: the run, its list (if any) and the token evidence it read.

        Both times come from the selector's clock, which also dates the
        persistence lookback; the database clock never mixes in.
        """
        if phase not in ('shadow', 'live') or outcome not in DONE + ('incomplete', 'failed'):
            raise DataError('invalid_featured_run')
        if not isinstance(day, date) or (listing is not None) != (outcome == 'selected'):
            raise DataError('invalid_featured_run')
        with self.connection() as conn:
            run = conn.execute('''INSERT INTO domino_public.featured_runs(chain_id,phase,selection_date,outcome,
              policy_version,started_at,finished_at,evaluation)
              VALUES(%s,%s,%s,%s,%s,to_timestamp(%s),to_timestamp(%s),%s) RETURNING id''',
              (self.chain_id, phase, day, outcome, policy_version, started_at, finished_at,
               Jsonb(evaluation))).fetchone()['id']
            revision = None
            if listing is not None:
                try:
                    revision = conn.execute('''INSERT INTO domino_public.featured_lists(chain_id,phase,status,list_id,
                      selection_date,run_id,generated_at,payload) VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING revision''',
                      (self.chain_id, phase, 'shadow' if phase == 'shadow' else 'draft', listing['listId'], day, run,
                       listing['generatedAt'], Jsonb(listing))).fetchone()['revision']
                except psycopg.errors.UniqueViolation:
                    raise DataError('featured_selection_exists') from None
            for evidence in tokens:
                if not evidence.get('code'):
                    continue
                listed = evidence['address'] in listed_tokens
                conn.execute('''INSERT INTO domino_public.featured_token_checks(chain_id,address,code_hash,
                  symbol_reading,first_listed_at,listed_code_hash,evidence,reasons)
                  VALUES(%s,%s,%s,%s,CASE WHEN %s THEN clock_timestamp() END,CASE WHEN %s THEN %s END,%s,%s)
                  ON CONFLICT(chain_id,address) DO UPDATE SET code_hash=EXCLUDED.code_hash,
                    symbol_reading=EXCLUDED.symbol_reading,evidence=EXCLUDED.evidence,reasons=EXCLUDED.reasons,
                    checked_at=clock_timestamp(),
                    first_listed_at=COALESCE(domino_public.featured_token_checks.first_listed_at,EXCLUDED.first_listed_at),
                    listed_code_hash=COALESCE(domino_public.featured_token_checks.listed_code_hash,EXCLUDED.listed_code_hash)''',
                  (self.chain_id, evidence['address'], evidence['codeHash'], evidence.get('symbolReading'), listed,
                   listed, evidence['codeHash'], Jsonb(evidence), evidence.get('reasons', [])))
            conn.execute('''DELETE FROM domino_public.featured_runs WHERE chain_id=%s AND phase=%s AND
              finished_at<to_timestamp(%s)-(%s*interval '1 day')''',
              (self.chain_id, phase, finished_at, RUN_RETENTION_DAYS))
        return {'runId': run, 'revision': revision}

    def current(self):
        """The revision served now (featured_current), or None."""
        self._served()
        with self.connection() as conn:
            return conn.execute('''SELECT l.* FROM domino_public.featured_current c
              JOIN domino_public.featured_lists l ON l.revision=c.revision WHERE c.singleton''').fetchone()

    def draft(self, day):
        """The day's live selection, not yet served."""
        self._served()
        with self.connection() as conn:
            return conn.execute('''SELECT * FROM domino_public.featured_lists WHERE phase='live'
              AND status='draft' AND selection_date=%s ORDER BY revision DESC LIMIT 1''', (day,)).fetchone()

    def run(self, run_id):
        with self.connection() as conn:
            return conn.execute('SELECT * FROM domino_public.featured_runs WHERE chain_id=%s AND id=%s',
                                (self.chain_id, run_id)).fetchone()

    def latest_run(self, *, within_hours, now):
        """The most recent completed run of either phase, with its evaluation."""
        with self.connection() as conn:
            return conn.execute('''SELECT * FROM domino_public.featured_runs WHERE chain_id=%s AND outcome=ANY(%s)
              AND started_at>=to_timestamp(%s) ORDER BY started_at DESC,id DESC LIMIT 1''',
              (self.chain_id, list(DONE), now - within_hours * 3600)).fetchone()

    def serve(self, *, status, payload, day, run_id, generated_at, effective_at, valid_until):
        """A new live revision, served at once: the list row and the pointer in one transaction."""
        self._served()
        if status not in ('current', 'repaired', 'carried_over', 'manual', 'none'):
            raise DataError('invalid_featured_run')
        with self.connection() as conn:
            try:
                revision = conn.execute('''INSERT INTO domino_public.featured_lists(phase,status,list_id,
                  selection_date,run_id,generated_at,effective_at,valid_until,payload)
                  VALUES('live',%s,%s,%s,%s,%s,%s,%s,%s) RETURNING revision''',
                  (status, payload['listId'], day, run_id, generated_at, effective_at, valid_until,
                   Jsonb(payload))).fetchone()['revision']
            except psycopg.errors.UniqueViolation:
                raise DataError('featured_selection_exists') from None
            conn.execute('''INSERT INTO domino_public.featured_current(singleton,revision) VALUES(true,%s)
              ON CONFLICT(singleton) DO UPDATE SET revision=EXCLUDED.revision''', (revision,))
        return revision

    def observe_health(self, seen, now, unknown=None):
        """Record the conditions seen now per pool; clear the ones that went away.

        `seen` maps each served pool to the set of conditions it shows now;
        `unknown`, to those its data could not judge now (#278): their rows stay
        as they are, neither seen again nor gone.
        Returns {(poolId, condition): (first_seen_at, checks)} after the update.
        """
        unknown = unknown or {}
        with self.connection() as conn:
            for pool_id, conditions in seen.items():
                kept = set(conditions) | set(unknown.get(pool_id, ()))
                conn.execute('''DELETE FROM domino_public.featured_health WHERE chain_id=%s AND pool_id=%s
                  AND NOT (condition=ANY(%s))''', (self.chain_id, pool_id, sorted(kept)))
                for condition in sorted(conditions):
                    conn.execute('''INSERT INTO domino_public.featured_health(chain_id,pool_id,condition,first_seen_at,
                      last_seen_at) VALUES(%s,%s,%s,%s,%s) ON CONFLICT(chain_id,pool_id,condition) DO UPDATE
                      SET last_seen_at=EXCLUDED.last_seen_at,checks=domino_public.featured_health.checks+1''',
                      (self.chain_id, pool_id, condition, now, now))
            conn.execute('''DELETE FROM domino_public.featured_health WHERE chain_id=%s
              AND NOT (pool_id=ANY(%s))''', (self.chain_id, sorted(seen)))
            rows = conn.execute('SELECT * FROM domino_public.featured_health WHERE chain_id=%s',
                                (self.chain_id,)).fetchall()
        return {(row['pool_id'], row['condition']): (row['first_seen_at'], row['checks']) for row in rows}

    def status(self, phase):
        with self.connection() as conn:
            runs = conn.execute('''SELECT id,selection_date,outcome,policy_version,started_at,finished_at,
              evaluation->'summary' AS summary FROM domino_public.featured_runs WHERE chain_id=%s AND phase=%s
              ORDER BY id DESC LIMIT 7''', (self.chain_id, phase)).fetchall()
            latest = conn.execute('''SELECT revision,status,list_id,selection_date,generated_at,payload
              FROM domino_public.featured_lists WHERE chain_id=%s AND phase=%s ORDER BY revision DESC LIMIT 1''',
              (self.chain_id, phase)).fetchone()
        return {'runs': [{**row, 'selection_date': row['selection_date'].isoformat(),
                          'started_at': row['started_at'].isoformat(), 'finished_at': row['finished_at'].isoformat()}
                         for row in runs],
                'list': None if latest is None else {**latest, 'selection_date': latest['selection_date'].isoformat()
                                                     if latest['selection_date'] else None}}
