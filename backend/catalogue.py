"""PostgreSQL public pool identities. No wallet, user, balance or fee ledger."""
from contextlib import contextmanager
from dataclasses import asdict
import json
import os
from pathlib import Path
import stat

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from discovery import CHAIN_ID, POOL_MANAGER, DataError, PoolKey, address, bytes32

DB_CONFIG = Path(__file__).resolve().parent / 'runtime' / 'catalogue-db.json'
LOCK_ID = 46630001
# Advisory key namespace for per-pool writers. The high bit keeps it disjoint
# from LOCK_ID and from any other single-key guard added later.
POOL_LOCK_BIT = 1 << 62


def pool_lock_key(pool_id):
    """Deterministic advisory key for one pool's own writer path."""
    value = bytes32(pool_id)
    # PostgreSQL advisory keys are signed 64-bit; stay below 2**63.
    return POOL_LOCK_BIT | (int(value[2:], 16) % (1 << 61))


def checked_key(value, pool_id):
    if not isinstance(value, dict) or set(value) != {'currency0', 'currency1', 'fee_pips', 'tick_spacing', 'hooks'}:
        raise DataError('invalid_catalogue_key')
    return PoolKey.checked(tuple(value[k] for k in ('currency0', 'currency1', 'fee_pips', 'tick_spacing', 'hooks')), pool_id)


def database_settings(path=DB_CONFIG):
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError:
        raise DataError('catalogue_configuration_unavailable') from None
    try:
        with os.fdopen(fd) as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise ValueError()
            raw = stream.read(4097)
        if len(raw) > 4096:
            raise ValueError()
        data = json.loads(raw)
        if (set(data) != {'host', 'port', 'dbname'} or not isinstance(data['host'], str)
                or not data['host'].startswith('/') or type(data['port']) is not int
                or not 1024 <= data['port'] <= 65535 or data['dbname'] != 'domino_catalogue'):
            raise ValueError()
        return data
    except (OSError, ValueError, TypeError):
        raise DataError('catalogue_configuration_unavailable') from None


class PgCatalogue:
    def __init__(self, settings):
        self.settings = dict(settings)

    @contextmanager
    def connection(self, *, writer=False, lock=False):
        role = 'domino_catalogue_writer' if writer else 'domino_catalogue_reader'
        if lock is not False and lock is not True and type(lock) is not int:
            raise DataError('invalid_lock_key')
        try:
            with psycopg.connect(**self.settings, user=role, connect_timeout=3, row_factory=dict_row) as conn:
                conn.execute("SET LOCAL statement_timeout='5000ms'")
                if not writer:
                    conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                key = LOCK_ID if lock is True else lock
                if lock and not conn.execute('SELECT pg_try_advisory_xact_lock(%s) AS held', (key,)).fetchone()['held']:
                    raise DataError('catalogue_writer_busy')
                yield conn
        except psycopg.Error:
            raise DataError('catalogue_database_unavailable') from None

    @staticmethod
    def state(conn):
        row = conn.execute('SELECT * FROM domino_catalogue.state WHERE singleton').fetchone()
        if not row or row['schema_version'] != 1:
            raise DataError('catalogue_schema_mismatch')
        return row

    @staticmethod
    def coverage(state):
        return {'chainId': CHAIN_ID, 'poolManager': POOL_MANAGER, 'revision': state['revision'],
                'startBlock': state['start_block'],
                'indexedThrough': state['next_block'] - 1 if state['next_block'] and state['next_block']>state['start_block'] else None,
                'coverage': 'configured_interval_only', 'completeHistory': False,
                'liveExecution': False}

    def lookup(self, token, *, limit=20, after=None, revision=None, paired_token=None):
        token = address(token)
        paired_token = address(paired_token) if paired_token is not None else None
        if paired_token==token:
            raise DataError('invalid_pair')
        after = bytes32(after) if after is not None else None
        if type(limit) is not int or not 1 <= limit <= 100 or (after is not None and revision is None):
            raise DataError('invalid_catalogue_page')
        with self.connection() as conn:
            state = self.state(conn)
            if revision is not None and revision != state['revision']:
                raise DataError('catalogue_revision_changed')
            # Events take precedence over independently observed seed hints.
            query = '''WITH candidates AS (
              SELECT pool_id,currency0,currency1,pool_key,block_number AS observed_block,
                block_hash AS observed_hash,'initialize_event' AS source FROM domino_catalogue.events
              UNION ALL
              SELECT h.pool_id,h.currency0,h.currency1,h.pool_key,h.observed_block,h.observed_hash,
                'verified_observation' AS source FROM domino_catalogue.hints h
                WHERE NOT EXISTS(SELECT 1 FROM domino_catalogue.events e WHERE e.pool_id=h.pool_id)
            ) SELECT * FROM candidates WHERE (currency0=%s OR currency1=%s)
              AND (%s::text IS NULL OR pool_id>%s)
              AND (%s::text IS NULL OR (currency0=%s OR currency1=%s))
              ORDER BY pool_id LIMIT %s'''
            rows = conn.execute(query, (token, token, after, after, paired_token, paired_token, paired_token, limit+1)).fetchall()
            items = []
            for row in rows[:limit]:
                key = checked_key(row['pool_key'], row['pool_id'])
                if row['currency0'] != key.currency0 or row['currency1'] != key.currency1:
                    raise DataError('catalogue_currency_mismatch')
                items.append({'poolId': row['pool_id'], 'poolKey': asdict(key),
                              'currencies': [key.currency0, key.currency1], 'providerMetrics': None,
                              'catalogueSource': row['source'], 'catalogueObservation': {
                                  'number': row['observed_block'], 'hash': row['observed_hash']},
                              'identityStatus': 'catalogue_candidate', 'executionAvailable': False})
            return {**self.coverage(state), 'items': items,
                    'hasMore': len(rows)>limit, 'nextAfterPoolId': items[-1]['poolId'] if len(rows)>limit else None}

    def seed(self, pools, block):
        checked = []
        for pool in pools:
            pool_id = bytes32(pool['poolId'])
            key = checked_key(pool['poolKey'], pool_id)
            checked.append((pool_id, key.currency0, key.currency1, Jsonb(asdict(key)), block.number, block.hash))
        with self.connection(writer=True, lock=True) as conn:
            self.state(conn)
            for values in checked:
                conn.execute('''INSERT INTO domino_catalogue.hints VALUES(%s,%s,%s,%s,%s,%s)
                  ON CONFLICT(pool_id) DO UPDATE SET observed_block=EXCLUDED.observed_block,
                  observed_hash=EXCLUDED.observed_hash
                  WHERE domino_catalogue.hints.observed_block<EXCLUDED.observed_block''', values)
            conn.execute('UPDATE domino_catalogue.state SET revision=revision+1 WHERE singleton')

    @staticmethod
    def commit_chunk(conn, start, end, end_hash, events):
        state = PgCatalogue.state(conn)
        if state['next_block'] != start:
            raise DataError('catalogue_noncontiguous_chunk')
        conn.execute('INSERT INTO domino_catalogue.chunks VALUES(%s,%s,%s)', (start,end,end_hash))
        for event in events:
            key = event['poolKey']
            conn.execute('''INSERT INTO domino_catalogue.events VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                         (event['poolId'],key['currency0'],key['currency1'],Jsonb(key),event['blockNumber'],
                          event['blockHash'],event['transactionHash'],event['logIndex'],start))
        # A revision is a content version, not a block cursor. Advancing the
        # checkpoint over a chunk with no Initialize event changes no candidate
        # and must not invalidate a paging client's `revision`, which would turn
        # every pass of a follower over empty chunks into catalogue_revision_changed.
        conn.execute('''UPDATE domino_catalogue.state SET next_block=%s,
                      revision=revision+%s WHERE singleton''', (end+1, 1 if events else 0))

    @staticmethod
    def rewind(conn, through, base_hash=None):
        state = PgCatalogue.state(conn)
        conn.execute('DELETE FROM domino_catalogue.chunks WHERE end_block>%s', (through,))
        conn.execute('DELETE FROM domino_catalogue.hints WHERE observed_block>%s', (through,))
        conn.execute('''UPDATE domino_catalogue.state SET next_block=%s,
                      base_hash=COALESCE(%s,base_hash),revision=revision+1 WHERE singleton''',
                     (max(state['start_block'],through+1),base_hash))

    @staticmethod
    def reset(conn, start_block, base_hash):
        """Abandon stored catalogue history and restart at an explicit block.

        The caller must already have verified `start_block-1` on chain for the
        configured PoolManager. Chunks, events and seed hints are removed in the
        same transaction, so a re-index from the PoolManager origin cannot leave
        an older event or hint reachable. The revision advances: every stored
        candidate set the readers held is now different.
        """
        state = PgCatalogue.state(conn)
        conn.execute('DELETE FROM domino_catalogue.chunks')
        conn.execute('DELETE FROM domino_catalogue.events')
        conn.execute('DELETE FROM domino_catalogue.hints')
        conn.execute('''UPDATE domino_catalogue.state SET start_block=%s,next_block=%s,
                      base_hash=%s,revision=revision+1 WHERE singleton''',
                     (start_block,start_block,base_hash))
        return {'status':'reset','startBlock':start_block,'previousStartBlock':state['start_block'],
                'previousNextBlock':state['next_block']}


def configured_catalogue():
    settings = database_settings()
    return PgCatalogue(settings) if settings else None
