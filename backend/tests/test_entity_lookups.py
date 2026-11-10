"""Entity lookups name their chain, so each reads the primary key of domino_public.entities.

The table's primary key is (chain_id, kind, entity_id). PostgreSQL 16 cannot skip its leading column, so a
lookup that names only kind and entity_id walks every entry of its kind in public_entities_due (kind, next_due,
entity_id) instead. In production on 8 Nov 2026 (22,973 pools, 14,892 tokens) that was 566 buffers for one
pool, 162 for a token, 324 for a pool's two tokens and 6,792 for the 12 pools of a keep-warm UPDATE; naming
chain_id made them 4, 4, 8 and 48. #464 did this for the history claim's two probes (test_history_claim.py);
these are the rest: PgPublicData.ensure, PublicHistory.identity's token metadata, the accounting lane's
selection and its two UPDATEs, and the featured list's keep-warm UPDATE.

Every row is chain 4663 today (entities_chain_id_check), so no answer changes. The PostgreSQL tests also put
another chain's rows in the table, as a second chain (Elysium, 99901) may one day, with that CHECK dropped in
a transaction that is rolled back, and check that no lookup answers with them.
"""
from contextlib import contextmanager
import os
from pathlib import Path
import re
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dev_postgres import ADMIN, PORT, SOCKET
from discovery import CHAIN_ID, DataError
from featured_live import Live, WARM_SECONDS
from manage_public_data import accounting_tick
from public_history import PublicHistory
from public_observations import PgPublicData
from test_catalogue import block_hash
from test_discovery import KEY, POOL

ELYSIUM = 99901                 # Any chain but CHAIN_ID would do.
ACCOUNTED = '0x' + 'ac' * 32    # A pool id no other test uses.
POOL_KEY = dict(zip(('currency0', 'currency1', 'fee_pips', 'tick_spacing', 'hooks'), KEY))
NOW = 1_800_000_000
SERVICE = SimpleNamespace(transport_factory=lambda: None, _rpc=lambda transport, historical=False: SimpleNamespace())


@contextmanager
def connected(public, conn):
    """Run `public`'s statements on `conn`: a recorder, or the test's own transaction."""
    @contextmanager
    def connection(*, write=False):
        yield conn
    with patch.object(public, 'connection', connection):
        yield


@contextmanager
def ledgers(error=None):
    """The accounting lane's first ledger, the fee indexer, answering at once: no RPC, no ledger tables."""
    with patch('activity_store.PgActivity'), patch('fee_store.FeeIndexer') as indexer:
        step = indexer.return_value.step
        step.return_value, step.side_effect = {'status': 'current'}, error
        yield step


class Recorder:
    """A connection without a database: it records each statement and answers it with `answer(sql)`."""
    def __init__(self, answer):
        self.answer, self.calls = answer, []

    def execute(self, query, params=None):
        self.calls.append((query, params))
        rows = self.answer(' '.join(query.split()))
        return SimpleNamespace(fetchone=lambda: rows[0] if rows else None, fetchall=lambda: rows, rowcount=len(rows))


def captured():
    """Each lookup's domino_public.entities statement and its parameters, by name, without a database."""
    public = PgPublicData(SimpleNamespace(settings={}), writer=True)
    found = {}

    def record(names, answer, action):
        recorder = Recorder(answer)
        with connected(public, recorder):
            action(recorder)
        calls = [call for call in recorder.calls if 'domino_public.entities' in call[0]]
        if len(calls) != len(names):
            raise AssertionError(f'{names} ran {len(calls)} statements on domino_public.entities')
        found.update(zip(names, calls))

    record(('ensure',), lambda sql: [{'found': 1}], lambda conn: public.ensure('pool', POOL))
    record(('identity',), lambda sql: [{'pool_key': POOL_KEY}] if 'domino_catalogue' in sql else
           [{'entity_id': currency, 'payload': {'asset': {'decimals': 18}}} for currency in KEY[:2]],
           lambda conn: PublicHistory.identity(conn, POOL))
    with ledgers():
        record(('accounting selection', 'accounting stage', 'accounting error'),
               lambda sql: [{'entity_id': ACCOUNTED, 'ledger_stage': 0}] if sql.startswith('SELECT') else [],
               lambda conn: accounting_tick(public, SERVICE))
    live = Live(store=None, public=public, history=None, catalogue=None, policy=None, selector=None,
                rpc_factory=None, embedded=[POOL])
    record(('keep warm', 'keep warm candidates'), lambda sql: [],
           lambda conn: live._keep_warm(None, None, {'manualPools': []}, NOW))
    return found


def chain_parameters(query, params):
    """The values bound to each chain_id=%s of `query`, in order."""
    text = ' '.join(query.split()).replace('%%', '\0\0')
    holes = [match.start() for match in re.finditer('%s', text)]
    return [params[holes.index(match.end() - 2)] for match in re.finditer(r'\b(?:[a-z]+\.)?chain_id=%s', text)]


class EntityLookupShapeTests(unittest.TestCase):
    def test_every_lookup_names_its_chain_bound_to_chain_id(self):
        statements = captured()
        self.assertEqual(len(statements), 7)
        for name, (query, params) in statements.items():
            with self.subTest(name):
                self.assertEqual(chain_parameters(query, params), [CHAIN_ID], ' '.join(query.split()))


# Production's proportions on 8 Nov 2026 (22,973 pools, 14,892 tokens), rounded.
SEED = '''
INSERT INTO domino_public.entities(kind,entity_id)
SELECT 'pool','0x'||lpad(to_hex(n),64,'0') FROM generate_series(1,20000) n;
INSERT INTO domino_public.entities(kind,entity_id)
SELECT 'token','0x'||lpad(to_hex(n),40,'0') FROM generate_series(1,15000) n;
ANALYZE domino_public.entities;
'''
# The accounting selection takes the next due pool, a scan of the pools that the primary key cannot shorten.
LOOKUPS = ('ensure', 'identity', 'accounting stage', 'accounting error', 'keep warm')


def nodes(plan):
    yield plan
    for child in plan.get('Plans', ()):
        yield from nodes(child)


def probe(node):
    """The index a scan of entities reads, and its condition; a sequential scan reads none."""
    if node['Node Type'] == 'Bitmap Heap Scan':
        node = node['Plans'][0]
    return node.get('Index Name'), node.get('Index Cond', '')


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires disposable PostgreSQL databases')
class EntityLookupPlanTests(unittest.TestCase):
    settings = {'host': str(SOCKET), 'port': PORT, 'dbname': 'domino_catalogue_tests'}

    def test_each_lookup_reads_the_primary_key(self):
        statements = captured()
        # TRUNCATE in the rolled-back transaction: the seed never reaches the table other tests read.
        with psycopg.connect(**self.settings, user=ADMIN, row_factory=dict_row) as conn, \
                conn.transaction(force_rollback=True):
            conn.execute('TRUNCATE domino_public.entities')
            conn.execute(SEED)
            for name in LOOKUPS:
                query, params = statements[name]
                # Bound as the code binds it: psycopg sends CHAIN_ID as a smallint, which the key still takes.
                plan = conn.execute('EXPLAIN (FORMAT JSON) ' + query, params).fetchone()['QUERY PLAN'][0]['Plan']
                scans = [probe(node) for node in nodes(plan)
                         if node.get('Relation Name') == 'entities' and node['Node Type'] != 'ModifyTable']
                with self.subTest(name):
                    self.assertEqual(len(scans), 1, plan)
                    index, condition = scans[0]
                    self.assertEqual(index, 'entities_pkey', plan)
                    self.assertIn('chain_id', condition, plan)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires disposable PostgreSQL databases')
class SecondChainTests(unittest.TestCase):
    """Another chain's row with the same kind and entity_id never answers this chain's lookup."""
    settings = {'host': str(SOCKET), 'port': PORT, 'dbname': 'domino_catalogue_tests'}

    def setUp(self):
        self.public = PgPublicData(SimpleNamespace(settings=self.settings), writer=True)

    @contextmanager
    def second_chain(self):
        """domino_public.entities able to hold another chain, in a transaction that is rolled back."""
        with psycopg.connect(**self.settings, user=ADMIN, row_factory=dict_row) as conn, \
                conn.transaction(force_rollback=True):
            conn.execute('TRUNCATE domino_public.entities')
            conn.execute('ALTER TABLE domino_public.entities DROP CONSTRAINT entities_chain_id_check')
            with connected(self.public, conn):
                yield conn

    @staticmethod
    def by_chain(conn, entity_id, columns):
        return {row.pop('chain_id'): row for row in conn.execute(
            f'SELECT chain_id,{columns} FROM domino_public.entities WHERE entity_id=%s', (entity_id,))}

    def test_ensure_persists_this_chains_row_beside_another_chains(self):
        with self.second_chain() as conn:
            conn.execute("INSERT INTO domino_public.entities(chain_id,kind,entity_id) VALUES(%s,'pool',%s)",
                         (ELYSIUM, POOL))
            self.assertTrue(self.public.ensure('pool', POOL))
            self.assertEqual(set(self.by_chain(conn, POOL, 'kind')), {CHAIN_ID, ELYSIUM})

    def test_history_reads_token_decimals_on_this_chain_only(self):
        with self.second_chain() as conn:
            conn.execute('INSERT INTO domino_catalogue.hints VALUES(%s,%s,%s,%s,%s,%s) ON CONFLICT DO NOTHING',
                         (POOL, KEY[0], KEY[1], Jsonb(POOL_KEY), 9, block_hash(9)))
            insert = '''INSERT INTO domino_public.entities(chain_id,kind,entity_id,payload,observed_at)
              VALUES(%s,'token',%s,%s,1)'''
            for currency in KEY[:2]:
                conn.execute(insert, (ELYSIUM, currency, Jsonb({'asset': {'decimals': 18}})))
            with self.assertRaisesRegex(DataError, 'history_token_metadata_unavailable'):
                PublicHistory.identity(conn, POOL)
            for currency, decimals in zip(KEY[:2], (6, 8)):
                conn.execute(insert, (CHAIN_ID, currency, Jsonb({'asset': {'decimals': decimals}})))
            self.assertEqual(PublicHistory.identity(conn, POOL), ((KEY[0], KEY[1]), [6, 8]))

    def ledger_due(self, conn, *chains):
        """ACCOUNTED has an activity chunk and, on each of `chains`, a published pool row due for its ledgers."""
        zero = '0x' + '0' * 64
        conn.execute("INSERT INTO domino_activity.pools(pool_id,pool_key,start_block,base_hash,next_block) VALUES(%s,'{}',1,%s,2)",
                     (ACCOUNTED, zero))
        conn.execute('''INSERT INTO domino_activity.chunks(pool_id,start_block,end_block,end_hash,end_timestamp,model,state_snapshot)
          VALUES(%s,1,1,%s,0,'{}','{}')''', (ACCOUNTED, zero))
        for chain in chains:
            conn.execute('''INSERT INTO domino_public.entities(chain_id,kind,entity_id,payload,observed_at,ledger_due)
              VALUES(%s,'pool',%s,'{}',1,clock_timestamp()-interval '1 minute')''', (chain, ACCOUNTED))

    def test_the_accounting_lane_takes_only_this_chains_pools(self):
        with self.second_chain() as conn, ledgers() as step:
            self.ledger_due(conn, ELYSIUM)
            self.assertEqual(accounting_tick(self.public, SERVICE), {'status': 'idle'})
            step.assert_not_called()

    def test_the_accounting_lane_advances_and_records_only_this_chains_row(self):
        with self.second_chain() as conn, ledgers(DataError('fixture_ledger_failure')):
            self.ledger_due(conn, CHAIN_ID, ELYSIUM)
            self.assertEqual(accounting_tick(self.public, SERVICE),
                             {'poolId': ACCOUNTED, 'stage': 'fee', 'status': 'pending', 'reason': 'fixture_ledger_failure'})
            self.assertEqual(self.by_chain(conn, ACCOUNTED, 'ledger_stage,ledger_due>clock_timestamp() AS later,ledger_error'),
                             {CHAIN_ID: {'ledger_stage': 1, 'later': True, 'ledger_error': 'fixture_ledger_failure'},
                              ELYSIUM: {'ledger_stage': 0, 'later': False, 'ledger_error': None}})

    def test_the_featured_list_keeps_only_this_chains_pools_warm(self):
        live = Live(store=None, public=self.public, history=None, catalogue=None, policy=None, selector=None,
                    rpc_factory=None, embedded=[POOL])
        with self.second_chain() as conn:
            for chain in (CHAIN_ID, ELYSIUM):
                conn.execute("INSERT INTO domino_public.entities(chain_id,kind,entity_id) VALUES(%s,'pool',%s)",
                             (chain, POOL))
            self.assertEqual(live._keep_warm(None, None, {'manualPools': []}, NOW), 1)
            self.assertEqual(self.by_chain(conn, POOL, 'extract(epoch FROM keep_warm_until)::bigint AS until'),
                             {CHAIN_ID: {'until': NOW + WARM_SECONDS}, ELYSIUM: {'until': None}})


if __name__ == '__main__':
    unittest.main()
