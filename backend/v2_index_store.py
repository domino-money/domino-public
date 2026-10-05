"""PostgreSQL storage of the Domino V2 index (migrations/052_v2_index.sql).

The indexer writes through the catalogue writer, one chain per session, under
that chain's advisory lock: a second indexer of the same chain is refused
(v2_indexer_busy), never interleaved. A range commits atomically with its
checkpoint, as V1's indexers commit: the events, the vaults created in it, the
activity items, the positions named, the checkpoint and the next block move
together or not at all, and only if the stored next block is still the one the
range started from. A rewind removes every row derived from a block above the
fork point, in one transaction.

The read API reads through the catalogue reader, in one repeatable-read,
read-only transaction per request, so a response never mixes two commits.
"""
from contextlib import contextmanager
import json

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

from discovery import DataError
from v2_events import event_keys, json_args

# Advisory key namespace for V2 chain writers: disjoint from the catalogue's
# LOCK_ID (46630001) and its per-pool keys (bit 62 set).
LOCK_NAMESPACE = 0x4632 << 40
WRITER_STATEMENT_TIMEOUT = '15000ms'
READER_STATEMENT_TIMEOUT = '5000ms'


def lock_key(chain_id):
    if type(chain_id) is not int or not 0 < chain_id < 1 << 40:
        raise DataError('invalid_v2_chain_id')
    return LOCK_NAMESPACE | chain_id


class V2Store:
    def __init__(self, settings):
        self.settings = dict(settings)

    def _connect(self, role, **options):
        try:
            return psycopg.connect(**self.settings, user=role, connect_timeout=3, row_factory=dict_row, **options)
        except psycopg.Error:
            raise DataError('catalogue_database_unavailable') from None

    @contextmanager
    def writer(self, chain_id):
        conn = self._connect('domino_catalogue_writer', autocommit=True)
        try:
            conn.execute(f"SET statement_timeout='{WRITER_STATEMENT_TIMEOUT}'")
            if not conn.execute('SELECT pg_try_advisory_lock(%s) AS held', (lock_key(chain_id),)).fetchone()['held']:
                raise DataError('v2_indexer_busy')
            try:
                yield V2Writer(conn, chain_id)
            finally:
                conn.execute('SELECT pg_advisory_unlock(%s)', (lock_key(chain_id),))
        except psycopg.Error:
            raise DataError('catalogue_database_unavailable') from None
        finally:
            conn.close()

    @contextmanager
    def reader(self):
        try:
            with self._connect('domino_catalogue_reader') as conn:
                conn.execute(f"SET LOCAL statement_timeout='{READER_STATEMENT_TIMEOUT}'")
                conn.execute('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
                yield V2Reader(conn)
        except psycopg.Error:
            raise DataError('catalogue_database_unavailable') from None


def _number(value):
    """numeric(78,0) and bigint columns as Python ints."""
    return None if value is None else int(value)


class V2Writer:
    def __init__(self, conn, chain_id):
        self.conn, self.chain_id = conn, chain_id

    # ------------------------------------------------------------- state
    def state(self):
        return self.conn.execute('SELECT * FROM domino_v2.deployments WHERE chain_id=%s',
                                 (self.chain_id,)).fetchone()

    def register(self, manifest_sha256, manifest, start_block, base_hash, contracts):
        """The deployment the indexer follows on this chain; refuse another one.
        contracts: (address, component, emitter kind or None, dex or None)."""
        with self.conn.transaction():
            row = self.state()
            if row is not None:
                if row['manifest_sha256'] != manifest_sha256:
                    raise DataError('v2_deployment_already_registered')
                return False
            self.conn.execute('''INSERT INTO domino_v2.deployments(chain_id,manifest_sha256,manifest,start_block,
              base_hash,next_block) VALUES(%s,%s,%s,%s,%s,%s)''',
                              (self.chain_id, manifest_sha256, Jsonb(manifest), start_block, base_hash, start_block))
            for address, component, emitter, dex in contracts:
                self.conn.execute('''INSERT INTO domino_v2.contracts(chain_id,address,component,emitter,dex)
                  VALUES(%s,%s,%s,%s,%s)''', (self.chain_id, address, component, emitter, dex))
            return True

    def observe_head(self, block, observed_at):
        with self.conn.transaction():
            self.conn.execute('''UPDATE domino_v2.deployments SET head_number=%s,head_hash=%s,head_timestamp=%s,
              head_observed_at=%s WHERE chain_id=%s''', (block.number, block.hash, block.timestamp,
                                                         int(observed_at), self.chain_id))

    def finalized_observed_at(self):
        row = self.conn.execute('SELECT finalized_observed_at FROM domino_v2.deployments WHERE chain_id=%s',
                                (self.chain_id,)).fetchone()
        return None if row is None else row['finalized_observed_at']

    def observe_finalized(self, block, observed_at):
        with self.conn.transaction():
            self.conn.execute('''UPDATE domino_v2.deployments SET finalized_number=%s,finalized_hash=%s,
              finalized_timestamp=%s,finalized_observed_at=%s WHERE chain_id=%s''',
                              (block.number, block.hash, block.timestamp, int(observed_at), self.chain_id))

    def record_error(self, code, at):
        code = code if isinstance(code, str) and code.replace('_', 'a').isalnum() and len(code) <= 80 else 'v2_error'
        with self.conn.transaction():
            self.conn.execute('UPDATE domino_v2.deployments SET last_error=%s,last_error_at=%s WHERE chain_id=%s',
                              (code.lower(), int(at), self.chain_id))

    def checkpoints(self, limit=64):
        return self.conn.execute('''SELECT * FROM domino_v2.checkpoints WHERE chain_id=%s
          ORDER BY end_block DESC LIMIT %s''', (self.chain_id, limit)).fetchall()

    def contracts(self):
        return self.conn.execute('SELECT * FROM domino_v2.contracts WHERE chain_id=%s',
                                 (self.chain_id,)).fetchall()

    def vaults(self, addresses=None):
        """address -> (owner, dex, root token id), for every vault or the ones named."""
        if addresses is None:
            rows = self.conn.execute('SELECT vault,owner,dex,root_token_id FROM domino_v2.vaults WHERE chain_id=%s',
                                     (self.chain_id,)).fetchall()
        else:
            rows = self.conn.execute('''SELECT vault,owner,dex,root_token_id FROM domino_v2.vaults
              WHERE chain_id=%s AND vault=ANY(%s)''', (self.chain_id, list(addresses))).fetchall()
        return {row['vault']: (row['owner'], row['dex'], _number(row['root_token_id'])) for row in rows}

    def mandates(self, hashes):
        """mandate hash -> (owner, vault), from the MandateRegistered events indexed so far."""
        if not hashes:
            return {}
        rows = self.conn.execute('''SELECT ref,owner,vault FROM domino_v2.logs WHERE chain_id=%s
          AND event='MandateRegistered' AND ref=ANY(%s)''', (self.chain_id, list(hashes))).fetchall()
        return {row['ref']: (row['owner'], row['vault']) for row in rows}

    # ------------------------------------------------------------ commit
    def commit(self, state, start, end, logs, timestamps, new_vaults, items, seen, touched, dex_of):
        """One range [start, end.number], atomically, if nothing moved meanwhile.

        logs: DecodedLog in order; timestamps: block number -> timestamp;
        new_vaults: (DecodedLog of VaultCreated, factory dex); items: v2_activity
        items; seen/touched: v2_activity.positions_seen; dex_of(log): the
        position's dex for the log, or None.
        """
        with self.conn.transaction():
            current = self.conn.execute('''SELECT next_block,revision FROM domino_v2.deployments
              WHERE chain_id=%s FOR UPDATE''', (self.chain_id,)).fetchone()
            if current is None or current['next_block'] != start or current['revision'] != state['revision']:
                raise DataError('v2_checkpoint_changed')
            for log in logs:
                owner, vault, token_id, ref = event_keys(log)
                self.conn.execute('''INSERT INTO domino_v2.logs(chain_id,block_number,log_index,block_hash,
                  block_timestamp,tx_hash,tx_index,address,emitter,event,args,owner,vault,dex,token_id,ref)
                  VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                                  (self.chain_id, log.block_number, log.log_index, log.block_hash,
                                   timestamps[log.block_number], log.tx_hash, log.tx_index, log.address,
                                   log.emitter, log.event, Jsonb(json_args(log.args)), owner, vault,
                                   dex_of(log) if token_id is not None else None, token_id, ref))
            for log, _ in new_vaults:
                a = log.args
                self.conn.execute('''INSERT INTO domino_v2.vaults(chain_id,vault,factory,dex,owner,root_token_id,
                  owner_nonce,block_number,log_index,tx_hash) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                                  (self.chain_id, a['vault'], log.address, a['dex'], a['owner'], a['rootTokenId'],
                                   a['ownerNonce'], log.block_number, log.log_index, log.tx_hash))
            for position in seen:
                # A position first seen through S1 and later made a vault's root takes the vault link.
                self.conn.execute('''INSERT INTO domino_v2.positions AS p(chain_id,dex,token_id,source,vault,wallet,
                  first_block,last_event_block) VALUES(%s,%s,%s,%s,%s,%s,%s,%s)
                  ON CONFLICT(chain_id,dex,token_id) DO UPDATE SET source=EXCLUDED.source,vault=EXCLUDED.vault,
                  wallet=EXCLUDED.wallet WHERE p.vault IS NULL AND EXCLUDED.vault IS NOT NULL''',
                                  (self.chain_id, position.dex, position.token_id, position.source,
                                   position.vault, position.wallet, position.block_number, position.block_number))
            for dex, token_id, block in sorted(touched):
                self.conn.execute('''UPDATE domino_v2.positions SET last_event_block=GREATEST(last_event_block,%s)
                  WHERE chain_id=%s AND dex=%s AND token_id=%s''', (block, self.chain_id, dex, token_id))
            for item in items:
                anchor = item.anchor
                for wallet in item.wallets:
                    self.conn.execute('''INSERT INTO domino_v2.activity(chain_id,block_number,log_index,wallet,kind,
                      block_timestamp,tx_hash,address,vault,ref,log_indexes)
                      VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                                      (self.chain_id, anchor.block_number, anchor.log_index, wallet, item.kind,
                                       timestamps[anchor.block_number], anchor.tx_hash, item.address, item.vault,
                                       item.ref, [log.log_index for log in item.logs]))
            self.conn.execute('''INSERT INTO domino_v2.checkpoints(chain_id,start_block,end_block,end_hash,
              end_timestamp,events) VALUES(%s,%s,%s,%s,%s,%s)''',
                              (self.chain_id, start, end.number, end.hash, end.timestamp, len(logs)))
            self.conn.execute('''UPDATE domino_v2.deployments SET next_block=%s,revision=revision+1,last_error=NULL,
              last_error_at=NULL WHERE chain_id=%s''', (end.number + 1, self.chain_id))

    def rewind(self, fork, base_hash=None):
        """Forget everything above block `fork`; index again from fork + 1."""
        chain = self.chain_id
        with self.conn.transaction():
            for table, column in (('activity', 'block_number'), ('logs', 'block_number'),
                                  ('mandates', 'block_number'), ('transactions', 'block_number'),
                                  ('position_snapshots', 'block_number'), ('vault_snapshots', 'block_number'),
                                  ('positions', 'first_block'), ('vaults', 'block_number'),
                                  ('checkpoints', 'end_block')):
                self.conn.execute(f'DELETE FROM domino_v2.{table} WHERE chain_id=%s AND {column}>%s', (chain, fork))
            # A vault link whose vault was rewound away goes back to the S1 sighting it came from.
            self.conn.execute('''UPDATE domino_v2.positions p SET source='s1',vault=NULL WHERE p.chain_id=%s
              AND p.vault IS NOT NULL AND NOT EXISTS(SELECT 1 FROM domino_v2.vaults v WHERE v.chain_id=p.chain_id
              AND v.vault=p.vault)''', (chain,))
            self.conn.execute('''UPDATE domino_v2.positions p SET last_event_block=GREATEST(p.first_block,COALESCE(
              (SELECT max(l.block_number) FROM domino_v2.logs l WHERE l.chain_id=p.chain_id AND l.dex=p.dex
               AND l.token_id=p.token_id),p.first_block)) WHERE p.chain_id=%s AND p.last_event_block>%s''',
                              (chain, fork))
            row = self.conn.execute('''UPDATE domino_v2.deployments SET next_block=GREATEST(start_block,%s),
              base_hash=COALESCE(%s,base_hash),revision=revision+1 WHERE chain_id=%s RETURNING next_block''',
                                    (fork + 1, base_hash, chain)).fetchone()
            return row['next_block']

    # -------------------------------------------------------- enrichment
    def tail(self):
        return self.conn.execute('''SELECT * FROM domino_v2.checkpoints WHERE chain_id=%s
          ORDER BY end_block DESC LIMIT 1''', (self.chain_id,)).fetchone()

    def checkpoint_holds(self, block):
        """True while `block` (number, hash) is still a committed checkpoint."""
        return self.conn.execute('''SELECT 1 FROM domino_v2.checkpoints WHERE chain_id=%s AND end_block=%s
          AND end_hash=%s''', (self.chain_id, block.number, block.hash)).fetchone() is not None

    def pending_transactions(self, limit):
        return self.conn.execute('''SELECT DISTINCT ON (a.tx_hash) a.tx_hash,a.block_number,l.block_hash
          FROM domino_v2.activity a JOIN domino_v2.logs l ON l.chain_id=a.chain_id
           AND l.block_number=a.block_number AND l.log_index=a.log_index
          WHERE a.chain_id=%s AND NOT EXISTS(SELECT 1 FROM domino_v2.transactions t
           WHERE t.chain_id=a.chain_id AND t.tx_hash=a.tx_hash)
          ORDER BY a.tx_hash LIMIT %s''', (self.chain_id, limit)).fetchall()

    def save_transaction(self, pinned, row):
        with self.conn.transaction():
            if not self.checkpoint_holds(pinned):
                return False
            self.conn.execute('''INSERT INTO domino_v2.transactions(chain_id,tx_hash,block_number,block_hash,sender,
              status,gas_used,effective_gas_price,l1_fee) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)
              ON CONFLICT DO NOTHING''', (self.chain_id, row['txHash'], row['blockNumber'], row['blockHash'],
                                          row['from'], row['status'], row['gasUsed'], row['effectiveGasPrice'],
                                          row['l1Fee']))
            return True

    def pending_mandates(self, limit):
        return self.conn.execute('''SELECT l.ref AS mandate_hash,l.block_number,l.args FROM domino_v2.logs l
          WHERE l.chain_id=%s AND l.event='MandateRegistered' AND NOT EXISTS(SELECT 1 FROM domino_v2.mandates m
           WHERE m.chain_id=l.chain_id AND m.mandate_hash=l.ref)
          ORDER BY l.block_number,l.log_index LIMIT %s''', (self.chain_id, limit)).fetchall()

    def save_mandate(self, pinned, mandate_hash, block_number, terms):
        with self.conn.transaction():
            if not self.checkpoint_holds(pinned):
                return False
            self.conn.execute('''INSERT INTO domino_v2.mandates(chain_id,mandate_hash,block_number,terms)
              VALUES(%s,%s,%s,%s) ON CONFLICT DO NOTHING''', (self.chain_id, mandate_hash, block_number, Jsonb(terms)))
            return True

    def due_vaults(self, limit, *, now, refresh_seconds):
        """Vaults never read, read before their latest event, or read too long ago."""
        return self.conn.execute('''SELECT v.vault,v.dex,v.factory,v.owner,v.root_token_id FROM domino_v2.vaults v
          LEFT JOIN domino_v2.vault_snapshots s ON s.chain_id=v.chain_id AND s.vault=v.vault
          LEFT JOIN LATERAL (SELECT max(l.block_number) AS last FROM domino_v2.logs l
            WHERE l.chain_id=v.chain_id AND l.address=v.vault) e ON true
          WHERE v.chain_id=%s AND (s.vault IS NULL OR e.last>s.block_number OR s.read_at<=%s)
          ORDER BY (s.vault IS NOT NULL), (e.last>COALESCE(s.block_number,-1)) DESC, s.read_at NULLS FIRST, v.vault
          LIMIT %s''', (self.chain_id, now - refresh_seconds, limit)).fetchall()

    def save_vault_snapshot(self, pinned, vault, status, state, reason, read_at):
        with self.conn.transaction():
            if not self.checkpoint_holds(pinned):
                return False
            self.conn.execute('''INSERT INTO domino_v2.vault_snapshots(chain_id,vault,block_number,block_hash,
              block_timestamp,status,state,reason,read_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s)
              ON CONFLICT(chain_id,vault) DO UPDATE SET block_number=EXCLUDED.block_number,
              block_hash=EXCLUDED.block_hash,block_timestamp=EXCLUDED.block_timestamp,status=EXCLUDED.status,
              state=EXCLUDED.state,reason=EXCLUDED.reason,read_at=EXCLUDED.read_at''',
                              (self.chain_id, vault, pinned.number, pinned.hash, pinned.timestamp, status,
                               None if state is None else Jsonb(state), reason, int(read_at)))
            return True

    def due_positions(self, limit, *, now, refresh_seconds):
        """Positions never read, read before an event touched them, or read too
        long ago; a burned position is never read again."""
        return self.conn.execute('''SELECT p.dex,p.token_id,p.first_block,p.last_event_block,s.status
          FROM domino_v2.positions p
          LEFT JOIN domino_v2.position_snapshots s ON s.chain_id=p.chain_id AND s.dex=p.dex AND s.token_id=p.token_id
          WHERE p.chain_id=%s AND (s.status IS NULL OR (s.status<>'burned' AND (p.last_event_block>s.block_number
            OR s.read_at<=%s)))
          ORDER BY (s.status IS NOT NULL), (p.last_event_block>COALESCE(s.block_number,-1)) DESC,
            s.read_at NULLS FIRST, p.dex, p.token_id
          LIMIT %s''', (self.chain_id, now - refresh_seconds, limit)).fetchall()

    def save_position_snapshot(self, pinned, dex, token_id, status, owner, state, reason, read_at):
        with self.conn.transaction():
            if not self.checkpoint_holds(pinned):
                return False
            self.conn.execute('''INSERT INTO domino_v2.position_snapshots(chain_id,dex,token_id,block_number,block_hash,
              block_timestamp,status,owner,state,reason,read_at) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
              ON CONFLICT(chain_id,dex,token_id) DO UPDATE SET block_number=EXCLUDED.block_number,
              block_hash=EXCLUDED.block_hash,block_timestamp=EXCLUDED.block_timestamp,status=EXCLUDED.status,
              owner=EXCLUDED.owner,state=EXCLUDED.state,reason=EXCLUDED.reason,read_at=EXCLUDED.read_at''',
                              (self.chain_id, dex, token_id, pinned.number, pinned.hash, pinned.timestamp, status,
                               owner, None if state is None else Jsonb(state), reason, int(read_at)))
            return True

    def unknown_tokens(self, limit):
        """Tokens the index names whose metadata was never read, in a stable order."""
        rows = self.conn.execute('''WITH named AS (
            SELECT jsonb_array_elements_text(jsonb_build_array(s.state->'pool'->>'currency0',
              s.state->'pool'->>'currency1')) AS address FROM domino_v2.vault_snapshots s
              WHERE s.chain_id=%(c)s AND s.status='read'
            UNION SELECT jsonb_array_elements_text(jsonb_build_array(s.state->'pool'->>'currency0',
              s.state->'pool'->>'currency1')) FROM domino_v2.position_snapshots s
              WHERE s.chain_id=%(c)s AND s.status='live'
            UNION SELECT l.args->>'token' FROM domino_v2.logs l WHERE l.chain_id=%(c)s AND l.args ? 'token'
            UNION SELECT l.args->>'tokenIn' FROM domino_v2.logs l WHERE l.chain_id=%(c)s AND l.event='SwapLegExecuted'
            UNION SELECT l.args->>'tokenOut' FROM domino_v2.logs l WHERE l.chain_id=%(c)s AND l.event='SwapLegExecuted'
            UNION SELECT l.args->'pool'->>'currency0' FROM domino_v2.logs l
              WHERE l.chain_id=%(c)s AND l.event='PositionLiquidityChanged'
            UNION SELECT l.args->'pool'->>'currency1' FROM domino_v2.logs l
              WHERE l.chain_id=%(c)s AND l.event='PositionLiquidityChanged')
          SELECT n.address FROM named n WHERE n.address IS NOT NULL AND NOT EXISTS(SELECT 1 FROM domino_v2.tokens t
            WHERE t.chain_id=%(c)s AND t.address=n.address) ORDER BY n.address LIMIT %(n)s''',
                                 {'c': self.chain_id, 'n': limit}).fetchall()
        return [row['address'] for row in rows]

    def save_token(self, block_number, address, decimals, symbol, status, issues):
        with self.conn.transaction():
            self.conn.execute('''INSERT INTO domino_v2.tokens(chain_id,address,decimals,symbol,status,issues,
              block_number) VALUES(%s,%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING''',
                              (self.chain_id, address, decimals, symbol, status, Jsonb(issues), block_number))

    # ----------------------------------------------- the automation's waiting
    def waiting_pass(self):
        """The pass of the last automation file read ({block, timestamp}), or
        None when the last read failed or none happened."""
        report = self.conn.execute('''SELECT status,block,block_timestamp FROM domino_v2.waiting_reports
          WHERE chain_id=%s''', (self.chain_id,)).fetchone()
        if report is None or report['status'] != 'read':
            return None
        return {'block': int(report['block']), 'timestamp': int(report['block_timestamp'])}

    def save_waiting(self, block, timestamp, rows, read_at):
        """A file read: its pass and every subject's row, replacing the last."""
        with self.conn.transaction():
            self.conn.execute('DELETE FROM domino_v2.waiting WHERE chain_id=%s', (self.chain_id,))
            with self.conn.cursor() as cursor:
                cursor.executemany('''INSERT INTO domino_v2.waiting(chain_id,kind,subject,reason,since,since_block,at,
                  block,revert,revert_at,revert_block) VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                                   [(self.chain_id, kind, subject, r['reason'], r['since'], r['since_block'], r['at'],
                                     r['block'], r['revert'], r['revert_at'], r['revert_block'])
                                    for (kind, subject), r in sorted(rows.items())])
            self._report('read', block, timestamp, None, read_at)

    def save_waiting_unavailable(self, reason, read_at):
        """A file that could not be read: none of its last content is served."""
        with self.conn.transaction():
            self.conn.execute('DELETE FROM domino_v2.waiting WHERE chain_id=%s', (self.chain_id,))
            self._report('unavailable', None, None, reason, read_at)

    def touch_waiting(self, read_at):
        """The same file read again."""
        self.conn.execute('UPDATE domino_v2.waiting_reports SET read_at=%s WHERE chain_id=%s', (read_at, self.chain_id))

    def _report(self, status, block, timestamp, reason, read_at):
        self.conn.execute('''INSERT INTO domino_v2.waiting_reports(chain_id,status,block,block_timestamp,reason,read_at)
          VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT(chain_id) DO UPDATE SET status=EXCLUDED.status,block=EXCLUDED.block,
          block_timestamp=EXCLUDED.block_timestamp,reason=EXCLUDED.reason,read_at=EXCLUDED.read_at''',
                          (self.chain_id, status, block, timestamp, reason, read_at))


class V2Reader:
    """Every read the V2 API makes, inside one read-only snapshot."""
    def __init__(self, conn):
        self.conn = conn

    def deployments(self):
        return self.conn.execute('''SELECT d.chain_id,d.manifest_sha256,d.start_block,d.next_block,d.head_number,
          d.head_hash,d.head_timestamp,d.head_observed_at,d.last_error,d.last_error_at,d.finalized_number,
          d.finalized_hash,d.finalized_timestamp,c.end_block,c.end_hash,c.end_timestamp,
          (SELECT count(*) FROM (SELECT DISTINCT ON (o.args->>'operator') (o.args->>'allowed')::boolean AS allowed
            FROM domino_v2.logs o WHERE o.chain_id=d.chain_id AND o.event='OperatorSet'
            ORDER BY o.args->>'operator',o.block_number DESC,o.log_index DESC) x WHERE x.allowed) AS operators,
          (SELECT a.address FROM domino_v2.contracts a WHERE a.chain_id=d.chain_id AND a.component='autoExit')
            AS auto_exit,
          (SELECT (l.args->>'halted')::boolean FROM domino_v2.logs l WHERE l.chain_id=d.chain_id
            AND l.event='AutomationHaltSet' ORDER BY l.block_number DESC,l.log_index DESC LIMIT 1) AS halted
          FROM domino_v2.deployments d LEFT JOIN LATERAL (SELECT end_block,end_hash,end_timestamp
            FROM domino_v2.checkpoints k WHERE k.chain_id=d.chain_id ORDER BY end_block DESC LIMIT 1) c ON true
          ORDER BY d.chain_id''').fetchall()

    def vaults(self, wallet, limit):
        return self.conn.execute('''SELECT v.*,s.block_number AS s_block,s.block_hash AS s_hash,
          s.block_timestamp AS s_timestamp,s.status AS s_status,s.state AS s_state,s.reason AS s_reason,
          s.read_at AS s_read_at,c.block_hash AS created_hash,c.block_timestamp AS created_timestamp,
          (SELECT max(l.block_number) FROM domino_v2.logs l WHERE l.chain_id=v.chain_id AND l.address=v.vault)
            AS last_event_block,
          (SELECT count(*) FROM domino_v2.logs l WHERE l.chain_id=v.chain_id AND l.address=v.vault
            AND l.event='Executed') AS executions,
          (SELECT jsonb_build_object('block',l.block_number,'hash',l.block_hash,'timestamp',l.block_timestamp,
            'tx',l.tx_hash,'planHash',l.args->>'planHash','action',l.args->>'action')
            FROM domino_v2.logs l WHERE l.chain_id=v.chain_id AND l.address=v.vault AND l.event='Executed'
            ORDER BY l.block_number DESC,l.log_index DESC LIMIT 1) AS last_execution,
          (SELECT jsonb_build_object('fees0',COALESCE(sum((l.args->>'fees0')::numeric),0)::text,
            'fees1',COALESCE(sum((l.args->>'fees1')::numeric),0)::text,
            'serviceFee0',COALESCE(sum((l.args->>'serviceFee0')::numeric),0)::text,
            'serviceFee1',COALESCE(sum((l.args->>'serviceFee1')::numeric),0)::text,
            'compounds',count(*))
            FROM domino_v2.logs l WHERE l.chain_id=v.chain_id AND l.address=v.vault AND l.event='Compounded')
            AS compounded,
          (SELECT jsonb_agg(jsonb_build_object('event',l.event,'args',l.args,'block',l.block_number,
            'hash',l.block_hash,'timestamp',l.block_timestamp,'tx',l.tx_hash) ORDER BY l.block_number,l.log_index)
            FROM domino_v2.logs l WHERE l.chain_id=v.chain_id AND l.address=v.vault AND l.event IN
            ('Initialized','SuccessorCreated','ChildWithdrawn','ExitExecuted','RootDisarmed','RootRearmed',
             'AutomationPaused','AutomationResumed','ExitModuleSet','PositionRecovered')) AS lifecycle
          FROM domino_v2.vaults v LEFT JOIN domino_v2.vault_snapshots s ON s.chain_id=v.chain_id AND s.vault=v.vault
          JOIN domino_v2.logs c ON c.chain_id=v.chain_id AND c.block_number=v.block_number AND c.log_index=v.log_index
          WHERE v.owner=%s ORDER BY v.chain_id,v.block_number,v.log_index LIMIT %s''', (wallet, limit)).fetchall()

    def positions(self, wallet, limit):
        """Positions the wallet holds now (as last read), or that its vaults
        manage, or that its S1 actions named and are not read yet."""
        return self.conn.execute('''SELECT p.*,s.block_number AS s_block,s.block_hash AS s_hash,
          s.block_timestamp AS s_timestamp,s.status AS s_status,s.owner AS s_owner,s.state AS s_state,
          s.reason AS s_reason,s.read_at AS s_read_at
          FROM domino_v2.positions p LEFT JOIN domino_v2.position_snapshots s
            ON s.chain_id=p.chain_id AND s.dex=p.dex AND s.token_id=p.token_id
          WHERE (s.status IS DISTINCT FROM 'burned') AND (
            (s.status='live' AND s.owner=%(w)s)
            OR (p.vault IS NOT NULL AND EXISTS(SELECT 1 FROM domino_v2.vaults v WHERE v.chain_id=p.chain_id
                AND v.vault=p.vault AND v.owner=%(w)s) AND (s.status IS DISTINCT FROM 'live' OR s.owner IN (%(w)s,p.vault)))
            OR (p.wallet=%(w)s AND (s.status IS NULL OR s.status='unavailable')))
          ORDER BY p.chain_id,p.first_block,p.dex,p.token_id LIMIT %(n)s''', {'w': wallet, 'n': limit}).fetchall()

    def mandates(self, wallet, limit):
        return self.conn.execute('''SELECT l.chain_id,l.address,l.ref AS mandate_hash,l.args,l.block_number,
          l.block_hash,l.block_timestamp,l.tx_hash,m.terms,
          (SELECT jsonb_build_object('event',x.event,'args',x.args,'block',x.block_number,'hash',x.block_hash,
             'timestamp',x.block_timestamp,'tx',x.tx_hash) FROM domino_v2.logs x WHERE x.chain_id=l.chain_id
             AND x.ref=l.ref AND x.event IN ('MandateRevoked','MandateExecuted')
             ORDER BY x.block_number,x.log_index LIMIT 1) AS ended,
          (SELECT e.args->>'module' FROM domino_v2.logs e WHERE e.chain_id=l.chain_id AND e.address=l.vault
             AND e.event='ExitModuleSet' ORDER BY e.block_number DESC,e.log_index DESC LIMIT 1) AS exit_module,
          EXISTS(SELECT 1 FROM domino_v2.vaults v WHERE v.chain_id=l.chain_id AND v.vault=l.vault) AS vault_known
          FROM domino_v2.logs l LEFT JOIN domino_v2.mandates m ON m.chain_id=l.chain_id AND m.mandate_hash=l.ref
          WHERE l.event='MandateRegistered' AND l.owner=%s
          ORDER BY l.chain_id,l.block_number,l.log_index LIMIT %s''', (wallet, limit)).fetchall()

    def credits(self, wallet):
        return self.conn.execute('''SELECT chain_id,address AS module,args->>'token' AS token,
          sum(CASE WHEN event='DeliveryDeferred' THEN (args->>'amount')::numeric
                   ELSE -(args->>'amount')::numeric END)::text AS unclaimed
          FROM domino_v2.logs WHERE owner=%s AND emitter='auto_exit' AND event IN ('DeliveryDeferred','Claimed')
          GROUP BY chain_id,address,args->>'token' ORDER BY chain_id,address,args->>'token' ''',
                                 (wallet,)).fetchall()

    def waiting_reports(self):
        """chain id -> the automation's last file read on that chain, as the indexer recorded it."""
        return {row['chain_id']: row for row in self.conn.execute(
            'SELECT chain_id,status,block,block_timestamp,reason,read_at FROM domino_v2.waiting_reports').fetchall()}

    def waiting(self, keys):
        """(chain id, kind, subject) -> its row, for the subjects asked."""
        keys = sorted(set(keys))
        if not keys:
            return {}
        rows = self.conn.execute('''SELECT w.chain_id,w.kind,w.subject,w.reason,w.since,w.since_block,w.at,w.block,
          w.revert,w.revert_at,w.revert_block FROM domino_v2.waiting w
          JOIN unnest(%s::bigint[],%s::text[],%s::text[]) AS k(chain_id,kind,subject)
            ON k.chain_id=w.chain_id AND k.kind=w.kind AND k.subject=w.subject''',
                                 ([k[0] for k in keys], [k[1] for k in keys], [k[2] for k in keys])).fetchall()
        return {(row['chain_id'], row['kind'], row['subject']): row for row in rows}

    def available_tokens(self, chain_id, limit):
        """The chain's tokens the index read in full, (address, decimals, symbol): read-v6 chain-tokens' v2_activity."""
        rows = self.conn.execute('''SELECT address, decimals, symbol FROM domino_v2.tokens
          WHERE chain_id=%s AND status='available' ORDER BY address LIMIT %s''', (chain_id, limit)).fetchall()
        return [(row['address'], row['decimals'], row['symbol']) for row in rows]

    def tokens(self, keys):
        """(chain id, address) -> token row, for the keys named."""
        if not keys:
            return {}
        chains, addresses = zip(*sorted(keys))
        rows = self.conn.execute('''SELECT t.* FROM domino_v2.tokens t
          JOIN unnest(%s::bigint[],%s::text[]) AS k(chain_id,address) USING (chain_id,address)''',
                                 (list(chains), list(addresses))).fetchall()
        return {(row['chain_id'], row['address']): row for row in rows}

    def activity(self, wallet, limit, before=None):
        """Items newest first, strictly before the cursor key when one is given."""
        if before is None:
            return self.conn.execute('''SELECT * FROM domino_v2.activity WHERE wallet=%s
              ORDER BY block_timestamp DESC,chain_id DESC,block_number DESC,log_index DESC LIMIT %s''',
                                     (wallet, limit)).fetchall()
        return self.conn.execute('''SELECT * FROM domino_v2.activity WHERE wallet=%s
          AND (block_timestamp,chain_id,block_number,log_index)<(%s,%s,%s,%s)
          ORDER BY block_timestamp DESC,chain_id DESC,block_number DESC,log_index DESC LIMIT %s''',
                                 (wallet, *before, limit)).fetchall()

    def item_logs(self, rows):
        """(chain id, block, log index) -> log, for every log the items name."""
        keys = [(row['chain_id'], row['block_number'], index) for row in rows for index in row['log_indexes']]
        if not keys:
            return {}
        chains, blocks, indexes = zip(*keys)
        found = self.conn.execute('''SELECT l.* FROM domino_v2.logs l JOIN unnest(%s::bigint[],%s::bigint[],
          %s::integer[]) AS k(chain_id,block_number,log_index) USING (chain_id,block_number,log_index)''',
                                  (list(chains), list(blocks), list(indexes))).fetchall()
        return {(row['chain_id'], row['block_number'], row['log_index']): row for row in found}

    def transactions(self, keys):
        if not keys:
            return {}
        chains, hashes = zip(*sorted(keys))
        rows = self.conn.execute('''SELECT t.* FROM domino_v2.transactions t
          JOIN unnest(%s::bigint[],%s::text[]) AS k(chain_id,tx_hash) USING (chain_id,tx_hash)''',
                                 (list(chains), list(hashes))).fetchall()
        return {(row['chain_id'], row['tx_hash']): row for row in rows}

    def execution_modes(self, rows):
        """(chain, vault, block, log index) -> the vault's mode at that execution:
        its last PolicyChanged before the execution's Executed."""
        out = {}
        for row in rows:
            found = self.conn.execute('''SELECT args->'policy'->>'mode' AS mode FROM domino_v2.logs
              WHERE chain_id=%s AND address=%s AND event='PolicyChanged' AND (block_number,log_index)<(%s,%s)
              ORDER BY block_number DESC,log_index DESC LIMIT 1''',
                                      (row['chain_id'], row['vault'], row['block_number'], row['log_index'])).fetchone()
            if found is not None:
                out[(int(row['chain_id']), row['vault'], int(row['block_number']), int(row['log_index']))] = \
                    {'1': 'simple', '2': 'domino'}.get(found['mode'])
        return out

    def vault_owners(self, keys):
        if not keys:
            return {}
        chains, vaults = zip(*sorted(keys))
        rows = self.conn.execute('''SELECT v.chain_id,v.vault,v.owner,v.dex FROM domino_v2.vaults v
          JOIN unnest(%s::bigint[],%s::text[]) AS k(chain_id,vault) USING (chain_id,vault)''',
                                 (list(chains), list(vaults))).fetchall()
        return {(row['chain_id'], row['vault']): row for row in rows}


def dumps(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'))
