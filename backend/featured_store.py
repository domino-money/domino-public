"""Featured-pools persistence (043_featured_pools.sql): runs, lists, overrides, token baselines.

One writer: the selector, as the catalogue writer role. A run records the
whole evaluation, so every rejection can be audited; a list is immutable once
written, and one selection per date and phase exists at most.
"""
from contextlib import contextmanager
from datetime import date, datetime, timezone

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from discovery import DataError, address, bytes32

WRITER_ROLE = 'domino_catalogue_writer'
# Session lock held for a whole selection; the public-data locks use 46630240-51.
SELECTOR_LOCK = 46630260
DONE = ('bootstrap', 'selected', 'carried_over')
RUN_RETENTION_DAYS = 90


def utc_date(seconds):
    return datetime.fromtimestamp(seconds, timezone.utc).date()


class FeaturedStore:
    def __init__(self, catalogue):
        self.catalogue = catalogue

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
            with psycopg.connect(**self.catalogue.settings, user=WRITER_ROLE, connect_timeout=3,
                                 autocommit=True) as conn:
                held = conn.execute('SELECT pg_try_advisory_lock(%s)', (SELECTOR_LOCK,)).fetchone()[0]
                if not held:
                    raise DataError('featured_selector_busy')
                try:
                    yield
                finally:
                    conn.execute('SELECT pg_advisory_unlock(%s)', (SELECTOR_LOCK,))
        except psycopg.Error:
            raise DataError('featured_database_unavailable') from None

    def selection_done(self, phase, day):
        with self.connection() as conn:
            return conn.execute('''SELECT 1 FROM domino_public.featured_runs WHERE phase=%s
              AND selection_date=%s AND outcome=ANY(%s) LIMIT 1''', (phase, day, list(DONE))).fetchone() is not None

    def previous_evaluation(self, phase, now, hours):
        """The most recent completed run within `hours`: {poolId: its evaluation}, or None."""
        with self.connection() as conn:
            row = conn.execute('''SELECT id,evaluation FROM domino_public.featured_runs WHERE phase=%s
              AND outcome=ANY(%s) AND started_at>=to_timestamp(%s) ORDER BY started_at DESC,id DESC LIMIT 1''',
              (phase, list(DONE), now - hours * 3600)).fetchone()
        if row is None:
            return None
        return {'runId': row['id'], 'pools': {item['poolId']: item for item in row['evaluation']['evaluations']}}

    def previous_list(self, phase):
        with self.connection() as conn:
            row = conn.execute('''SELECT revision,list_id,payload FROM domino_public.featured_lists
              WHERE phase=%s ORDER BY revision DESC LIMIT 1''', (phase,)).fetchone()
        return None if row is None else {'revision': row['revision'], 'listId': row['list_id'],
                                         'pools': row['payload']['pools']}

    def overrides(self, now):
        """Owner overrides in force at `now`, as the rules consume them."""
        with self.connection() as conn:
            rows = conn.execute('''SELECT id,kind,subject,value FROM domino_public.featured_overrides
              WHERE revoked_at IS NULL AND (until IS NULL OR until>to_timestamp(%s)) ORDER BY id''',
              (now,)).fetchall()
        pins = [{'poolId': row['subject'], 'slot': row['value']['slot']} for row in rows if row['kind'] == 'pin']
        return {'pins': pins,
                'excludedPools': sorted(row['subject'] for row in rows if row['kind'] == 'exclude_pool'),
                'excludedTokens': sorted(row['subject'] for row in rows if row['kind'] == 'exclude_token'),
                'ids': [row['id'] for row in rows]}

    def add_override(self, kind, subject, *, reason, value=None, until=None):
        if kind not in ('pin', 'exclude_pool', 'exclude_token'):
            raise DataError('invalid_featured_override')
        subject = address(subject) if kind == 'exclude_token' else bytes32(subject)
        if not isinstance(reason, str) or not 1 <= len(reason.strip()) <= 500:
            raise DataError('invalid_featured_override')
        if kind == 'pin' and (not isinstance(value, dict) or set(value) != {'slot'} or type(value['slot']) is not int):
            raise DataError('invalid_featured_override')
        with self.connection() as conn:
            if kind == 'pin':
                # One pin per pool: a new slot replaces the old pin.
                conn.execute('''UPDATE domino_public.featured_overrides SET revoked_at=clock_timestamp()
                  WHERE kind='pin' AND subject=%s AND revoked_at IS NULL''', (subject,))
            return conn.execute('''INSERT INTO domino_public.featured_overrides(kind,subject,value,reason,until)
              VALUES(%s,%s,%s,%s,to_timestamp(%s)) RETURNING id''',
              (kind, subject, Jsonb(value or {}), reason.strip(), until)).fetchone()['id']

    def revoke_override(self, kind, subject):
        subject = address(subject) if kind == 'exclude_token' else bytes32(subject)
        with self.connection() as conn:
            return [row['id'] for row in conn.execute('''UPDATE domino_public.featured_overrides
              SET revoked_at=clock_timestamp() WHERE kind=%s AND subject=%s AND revoked_at IS NULL
              RETURNING id''', (kind, subject)).fetchall()]

    def token_baselines(self):
        """{address: row} for every token a list has shown: TA-3 readings and TA-5 hashes."""
        with self.connection() as conn:
            rows = conn.execute('''SELECT address,symbol_reading,listed_code_hash FROM
              domino_public.featured_token_checks WHERE first_listed_at IS NOT NULL''').fetchall()
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
            run = conn.execute('''INSERT INTO domino_public.featured_runs(phase,selection_date,outcome,
              policy_version,started_at,finished_at,evaluation)
              VALUES(%s,%s,%s,%s,to_timestamp(%s),to_timestamp(%s),%s) RETURNING id''',
              (phase, day, outcome, policy_version, started_at, finished_at, Jsonb(evaluation))).fetchone()['id']
            revision = None
            if listing is not None:
                try:
                    revision = conn.execute('''INSERT INTO domino_public.featured_lists(phase,status,list_id,
                      selection_date,run_id,generated_at,payload) VALUES(%s,%s,%s,%s,%s,%s,%s) RETURNING revision''',
                      (phase, 'shadow' if phase == 'shadow' else 'draft', listing['listId'], day, run,
                       listing['generatedAt'], Jsonb(listing))).fetchone()['revision']
                except psycopg.errors.UniqueViolation:
                    raise DataError('featured_selection_exists') from None
            for evidence in tokens:
                if not evidence.get('code'):
                    continue
                listed = evidence['address'] in listed_tokens
                conn.execute('''INSERT INTO domino_public.featured_token_checks(address,code_hash,symbol_reading,
                  first_listed_at,listed_code_hash,evidence,reasons)
                  VALUES(%s,%s,%s,CASE WHEN %s THEN clock_timestamp() END,CASE WHEN %s THEN %s END,%s,%s)
                  ON CONFLICT(address) DO UPDATE SET code_hash=EXCLUDED.code_hash,
                    symbol_reading=EXCLUDED.symbol_reading,evidence=EXCLUDED.evidence,reasons=EXCLUDED.reasons,
                    checked_at=clock_timestamp(),
                    first_listed_at=COALESCE(domino_public.featured_token_checks.first_listed_at,EXCLUDED.first_listed_at),
                    listed_code_hash=COALESCE(domino_public.featured_token_checks.listed_code_hash,EXCLUDED.listed_code_hash)''',
                  (evidence['address'], evidence['codeHash'], evidence.get('symbolReading'), listed, listed,
                   evidence['codeHash'], Jsonb(evidence), evidence.get('reasons', [])))
            conn.execute('''DELETE FROM domino_public.featured_runs WHERE phase=%s AND
              finished_at<to_timestamp(%s)-(%s*interval '1 day')''', (phase, finished_at, RUN_RETENTION_DAYS))
        return {'runId': run, 'revision': revision}

    def status(self, phase):
        with self.connection() as conn:
            runs = conn.execute('''SELECT id,selection_date,outcome,policy_version,started_at,finished_at,
              evaluation->'summary' AS summary FROM domino_public.featured_runs WHERE phase=%s
              ORDER BY id DESC LIMIT 7''', (phase,)).fetchall()
            latest = conn.execute('''SELECT revision,status,list_id,selection_date,generated_at,payload
              FROM domino_public.featured_lists WHERE phase=%s ORDER BY revision DESC LIMIT 1''',
              (phase,)).fetchone()
        return {'runs': [{**row, 'selection_date': row['selection_date'].isoformat(),
                          'started_at': row['started_at'].isoformat(), 'finished_at': row['finished_at'].isoformat()}
                         for row in runs],
                'list': None if latest is None else {**latest, 'selection_date': latest['selection_date'].isoformat()
                                                     if latest['selection_date'] else None}}
