"""The collector's claim takes each demand class in its own statement, in an index's order, and keeps its turn in
one row per kind.

PgPublicData.claim takes a hot entity (one on screen in the last minute, or one the featured list keeps warm,
#278) ahead of the background backlog in three turns of four, and the backlog ahead of hot entities in the
fourth. It used to rank both classes with a CASE at the head of one ORDER BY. No index can follow that, so
every claim read the whole of domino_public.entities and sorted its due rows. In production on 8 Nov 2026
(22,975 pools and 14,894 tokens, of which 3,638 pools and 13,979 tokens were due) that was a sequential scan of
6,490 pages and 13 ms a claim. It now runs one statement per class:
- the background follows public_entities_due (kind, next_due, entity_id);
- hot entities come through public_entities_interest (last_requested_at), ORed with public_entities_keep_warm
  (061).

The CASE also lost the backlog on its own turn. keep_warm_until is NULL for an entity never kept warm, so its
hotness was NULL, and NULL ranked with the hot entities: the fourth turn took the oldest due row of either
class. It now takes the backlog first, as #278 meant.

The turn is the count of persisted scheduled claims. It was the sum of the kind's generations, which read every
row of the kind on each scheduled claim: 6,601 pages and 10-17 ms, about ten times a second, on 9 Nov 2026. A
scheduled claim now reads its kind's row of domino_public.claim_cadence (062), and advances it by the rows it
took, in the claim's own transaction.
"""
from contextlib import contextmanager
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest

import psycopg
from psycopg.rows import dict_row

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from dev_postgres import ADMIN, PORT, SOCKET
from discovery import CHAIN_ID
from public_observations import ADVANCE, CADENCE, CLAIM, PgPublicData
from test_entity_lookups import Recorder, connected, nodes

ON_SCREEN, KEPT_WARM, BACKLOG, NEWER, LATER = ('0x' + f'{n:064x}' for n in (1, 2, 3, 4, 5))
INSERT = '''INSERT INTO domino_public.entities
  (kind,entity_id,next_due,last_requested_at,keep_warm_until,lease_token,lease_until)
  VALUES(%(kind)s,%(id)s,clock_timestamp()+make_interval(secs=>%(due)s::float8),
         COALESCE(clock_timestamp()+make_interval(secs=>%(requested)s::float8),'epoch'::timestamptz),
         clock_timestamp()+make_interval(secs=>%(warm)s::float8),
         CASE WHEN %(lease)s::float8 IS NULL THEN NULL ELSE 'fixture' END,
         clock_timestamp()+make_interval(secs=>%(lease)s::float8))'''


def put(conn, entity_id, *, due=-3600, requested=None, warm=None, lease=None, kind='pool'):
    """One entity, its times in seconds from now. Never requested: last_requested_at 'epoch', as ensure leaves it.
    Never kept warm: keep_warm_until NULL."""
    conn.execute(INSERT, {'kind': kind, 'id': entity_id, 'due': due, 'requested': requested, 'warm': warm,
                          'lease': lease})


def set_count(conn, claims, kind='pool'):
    """The kind's count of scheduled claims. A pool claim takes the backlog first when it is 3 modulo 4."""
    conn.execute('''INSERT INTO domino_public.claim_cadence(chain_id,kind,claims) VALUES(%s,%s,%s)
      ON CONFLICT (chain_id,kind) DO UPDATE SET claims=EXCLUDED.claims''', (CHAIN_ID, kind, claims))


def counts(conn):
    return {row['kind']: row['claims'] for row in conn.execute('SELECT kind,claims FROM domino_public.claim_cadence')}


def recorded(turn, answers, **options):
    """Every statement a scheduled pool claim runs, without a database. `turn` sets the count that any SELECT
    answers, and each claim statement answers with the next of `answers`."""
    public = PgPublicData(SimpleNamespace(settings={}), writer=True)
    replies = iter(answers)

    def answer(text):
        if text.startswith('SELECT'):
            count = 3 if turn == 'background' else 0
            return [{'claims': count, 'n': count}]
        return next(replies, []) if text.startswith('UPDATE') else []

    recorder = Recorder(answer)
    with connected(public, recorder):
        claimed = public.claim('pool', demand='scheduled', **options)
    return claimed, recorder.calls


def statements(turn, answers):
    """The claim statements among `recorded`'s."""
    claimed, calls = recorded(turn, answers)
    return claimed, [(query, params) for query, params in calls if query.startswith('UPDATE')]


class ClaimShapeTests(unittest.TestCase):
    def test_a_turn_runs_its_class_first_and_the_other_only_for_what_is_left(self):
        row = {'entity_id': BACKLOG}
        for turn, first, second in (('hot', 'hot', 'background'), ('background', 'background', 'hot')):
            with self.subTest(turn):
                claimed, calls = statements(turn, ([], [row]))
                self.assertEqual(claimed, [row])
                self.assertEqual([query for query, _ in calls], [CLAIM[first], CLAIM[second]])
                self.assertEqual([params[-1] for _, params in calls], [1, 1])
                # The first class filled the claim: the other is never asked.
                claimed, calls = statements(turn, ([row],))
                self.assertEqual(([query for query, _ in calls], claimed), ([CLAIM[first]], [row]))

    def test_each_selection_compares_with_the_statement_time_in_next_due_order(self):
        for which, query in CLAIM.items():
            selection = ' '.join(query.split()).split(' IN ', 1)[1]
            with self.subTest(which):
                self.assertNotIn('clock_timestamp()', selection)
                self.assertIn('next_due<=statement_timestamp()', selection)
                self.assertTrue(selection.endswith('ORDER BY next_due,entity_id FOR UPDATE SKIP LOCKED LIMIT %s) RETURNING *'),
                                selection)

    def test_a_scheduled_claim_reads_its_count_and_advances_it_by_the_rows_it_took(self):
        one, two = {'entity_id': BACKLOG}, {'entity_id': NEWER}
        for turn, answers, options, took in (('hot', ([one],), {}, 1), ('background', ([], [one]), {}, 1),
                                             ('hot', ([one, two],), {'limit': 2}, 2), ('hot', ([], []), {}, 0)):
            with self.subTest(turn=turn, took=took):
                claimed, calls = recorded(turn, answers, **options)
                self.assertEqual(len(claimed), took)
                lock, count, *rest = calls
                self.assertTrue(lock[0].startswith('SELECT pg_advisory_xact_lock'), lock)
                self.assertEqual(count, (CADENCE, (CHAIN_ID, 'pool')))
                # Then the claim statements, and last the advance by the rows they took. A claim that took none
                # is no turn.
                claims = [call for call in rest if call[0] in CLAIM.values()]
                self.assertEqual(rest, claims + ([(ADVANCE, (CHAIN_ID, 'pool', took))] if took else []))
                # The claims are the only statements that read domino_public.entities: no sum of its rows.
                self.assertEqual([query for query, _ in calls if 'domino_public.entities' in query],
                                 [query for query, _ in claims])


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires disposable PostgreSQL databases')
class ClaimTurnTests(unittest.TestCase):
    """Each test runs in a transaction that is rolled back, on its own rows."""
    settings = {'host': str(SOCKET), 'port': PORT, 'dbname': 'domino_catalogue_tests'}

    def setUp(self):
        self.public = PgPublicData(SimpleNamespace(settings=self.settings), writer=True)

    @contextmanager
    def table(self):
        """An empty domino_public.entities, which the claims read, and no counts yet, in a transaction that is
        rolled back."""
        with psycopg.connect(**self.settings, user=ADMIN, row_factory=dict_row) as conn, \
                conn.transaction(force_rollback=True):
            conn.execute('TRUNCATE domino_public.entities,domino_public.claim_cadence')
            with connected(self.public, conn):
                yield conn

    def claim(self, **options):
        return [row['entity_id'] for row in self.public.claim('pool', demand='scheduled', **options)]

    def test_the_fourth_turn_takes_the_backlog_ahead_of_an_older_hot_pool(self):
        with self.table() as conn:
            put(conn, BACKLOG, due=-3600)
            put(conn, ON_SCREEN, due=-7200, requested=0)
            set_count(conn, 3)
            self.assertEqual(self.claim(), [BACKLOG])
            # That claim was the fourth turn's: the next one is hot again.
            self.assertEqual(self.claim(), [ON_SCREEN])

    def test_hot_turns_take_on_screen_and_kept_warm_pools_ahead_of_an_older_backlog(self):
        with self.table() as conn:
            put(conn, BACKLOG, due=-7200)
            put(conn, ON_SCREEN, due=-60, requested=-5)
            put(conn, KEPT_WARM, due=-30, warm=86400)
            # Kept warm once, but no longer: background again.
            put(conn, NEWER, due=-3600, warm=-600)
            self.assertEqual([self.claim(), self.claim(), self.claim()], [[ON_SCREEN], [KEPT_WARM], [BACKLOG]])
            self.assertEqual(self.claim(), [NEWER])

    def test_each_turn_falls_back_to_the_other_class(self):
        with self.table() as conn:
            put(conn, ON_SCREEN, due=-60, requested=0)
            set_count(conn, 3)
            self.assertEqual(self.claim(), [ON_SCREEN])
            put(conn, BACKLOG, due=-60)
            self.assertEqual(self.claim(), [BACKLOG])

    def test_a_claim_of_two_takes_the_hot_pool_and_then_one_from_the_backlog(self):
        with self.table() as conn:
            put(conn, ON_SCREEN, due=-60, requested=0)
            put(conn, BACKLOG, due=-7200)
            put(conn, NEWER, due=-3600)
            self.assertEqual(self.claim(limit=2), [ON_SCREEN, BACKLOG])

    def test_leased_excluded_and_later_pools_wait_in_either_class(self):
        for turn in (0, 3):
            with self.subTest(turn='background' if turn else 'hot'), self.table() as conn:
                set_count(conn, turn)
                ids = iter('0x' + f'{n:064x}' for n in range(10, 20))
                excluded = []
                # In each class, older than the two that may go: one leased, one excluded, one not due yet.
                for requested in (None, 0):
                    put(conn, next(ids), due=-600, requested=requested, lease=60)
                    excluded.append(next(ids))
                    put(conn, excluded[-1], due=-600, requested=requested)
                    put(conn, next(ids), due=600, requested=requested)
                put(conn, BACKLOG, due=-60)
                put(conn, ON_SCREEN, due=-60, requested=0)
                self.assertEqual(sorted(self.claim(limit=3, exclude=excluded)), sorted([BACKLOG, ON_SCREEN]))

    def test_the_count_is_the_rows_the_scheduled_claims_took(self):
        with self.table() as conn:
            put(conn, ON_SCREEN, due=-60, requested=0)
            put(conn, BACKLOG, due=-7200)
            put(conn, NEWER, due=-3600)
            self.assertEqual(self.claim(limit=2), [ON_SCREEN, BACKLOG])
            self.assertEqual(counts(conn), {'pool': 2})
            self.assertEqual(self.claim(), [NEWER])
            self.assertEqual(counts(conn), {'pool': 3})
            # Nothing is due: no turn.
            self.assertEqual(self.claim(), [])
            self.assertEqual(counts(conn), {'pool': 3})
            # Nor is a claim that is not scheduled.
            put(conn, LATER, due=-60)
            self.assertEqual([row['entity_id'] for row in self.public.claim('pool')], [LATER])
            self.assertEqual(counts(conn), {'pool': 3})

    def test_token_turns_alternate_on_their_own_count(self):
        with self.table() as conn:
            on_screen = ['0x' + f'{n:040x}' for n in (1, 2)]
            backlog = ['0x' + f'{n:040x}' for n in (3, 4)]
            for n, token in enumerate(on_screen):
                put(conn, token, due=-60 + n, requested=0, kind='token')
            for n, token in enumerate(backlog):
                put(conn, token, due=-7200 + n, kind='token')
            # The pools' count would make the first token turn background's.
            set_count(conn, 7)
            taken = [row['entity_id'] for _ in range(4) for row in self.public.claim('token', demand='scheduled')]
            self.assertEqual(taken, [on_screen[0], backlog[0], on_screen[1], backlog[1]])
            self.assertEqual(counts(conn), {'pool': 7, 'token': 4})


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires disposable PostgreSQL databases')
class CadenceTableTests(unittest.TestCase):
    settings = {'host': str(SOCKET), 'port': PORT, 'dbname': 'domino_catalogue_tests'}

    def test_one_count_per_chain_and_kind_with_every_public_table_s_grants(self):
        with psycopg.connect(**self.settings, user=ADMIN) as conn:
            columns = conn.execute('''SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns
              WHERE table_schema='domino_public' AND table_name='claim_cadence' ORDER BY ordinal_position''').fetchall()
            # Checks and the key only: PostgreSQL 18 lists NOT NULL here too (contype 'n'), 16 does not.
            constraints = conn.execute('''SELECT contype,pg_get_constraintdef(oid) FROM pg_constraint
              WHERE conrelid='domino_public.claim_cadence'::regclass AND contype IN ('c','p') ORDER BY 1,2''').fetchall()
            grants = conn.execute('''SELECT grantee,string_agg(privilege_type,',' ORDER BY privilege_type)
              FROM information_schema.role_table_grants WHERE table_schema='domino_public' AND table_name='claim_cadence'
              AND grantee IN ('domino_catalogue_writer','domino_catalogue_reader') GROUP BY grantee ORDER BY grantee''').fetchall()
        self.assertEqual(columns, [('chain_id', 'integer', 'NO', None), ('kind', 'text', 'NO', None),
                                   ('claims', 'bigint', 'NO', None)])
        self.assertEqual(constraints, [('c', 'CHECK ((chain_id = 4663))'),
                                       ('c', "CHECK ((kind = ANY (ARRAY['pool'::text, 'token'::text])))"),
                                       ('p', 'PRIMARY KEY (chain_id, kind)')])
        # Every domino_public table's (024). The lanes claim as the catalogue writer: without its grant, every
        # scheduled claim fails. 024's GRANT ON ALL TABLES reaches this table only when re-applied after 062, as
        # test_public_collector does each run, so this is the test that holds 062's own grants.
        self.assertEqual(grants, [('domino_catalogue_reader', 'SELECT'),
                                  ('domino_catalogue_writer', 'DELETE,INSERT,SELECT,UPDATE')])


# Production's shape on 8 Nov 2026, rounded: 22,975 pools of which 3,638 due, 27 ever kept warm (6 now) and one
# on screen; 14,894 tokens of which 13,979 due.
SEED = '''
INSERT INTO domino_public.entities(kind,entity_id,next_due)
SELECT 'pool','0x'||lpad(to_hex(n),64,'0'),
       clock_timestamp()+CASE WHEN n%7=0 THEN -interval '1 hour' ELSE interval '1 hour' END
FROM generate_series(100,23000) n;
UPDATE domino_public.entities SET keep_warm_until=clock_timestamp()+CASE WHEN n<106 THEN interval '1 day' ELSE -interval '1 day' END
FROM generate_series(100,126) n WHERE kind='pool' AND entity_id='0x'||lpad(to_hex(n),64,'0');
UPDATE domino_public.entities SET last_requested_at=clock_timestamp() WHERE kind='pool' AND entity_id='0x'||lpad(to_hex(200),64,'0');
INSERT INTO domino_public.entities(kind,entity_id,next_due)
SELECT 'token','0x'||lpad(to_hex(n),40,'0'),
       clock_timestamp()+CASE WHEN n%16=0 THEN interval '1 hour' ELSE -interval '1 hour' END
FROM generate_series(1,15000) n;
ANALYZE domino_public.entities;
'''


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires disposable PostgreSQL databases')
class ClaimPlanTests(unittest.TestCase):
    settings = {'host': str(SOCKET), 'port': PORT, 'dbname': 'domino_catalogue_tests'}

    def test_each_class_reads_an_index_in_its_order(self):
        # TRUNCATE in the rolled-back transaction: the seed never reaches the table other tests read.
        with psycopg.connect(**self.settings, user=ADMIN, row_factory=dict_row) as conn, \
                conn.transaction(force_rollback=True):
            conn.execute('TRUNCATE domino_public.entities')
            conn.execute(SEED)
            for kind in ('pool', 'token'):
                for which, query in CLAIM.items():
                    # EXPLAIN without ANALYZE: the UPDATE is planned, never run.
                    plan = conn.execute('EXPLAIN (FORMAT JSON) ' + query,
                                        ('0' * 32, 60, kind, [], 1)).fetchone()['QUERY PLAN'][0]['Plan']
                    every = list(nodes(plan))
                    reads = {node.get('Index Name') for node in every if node.get('Relation Name') == 'entities'
                             or node['Node Type'] == 'Bitmap Index Scan'} - {None}
                    with self.subTest(kind=kind, which=which):
                        self.assertNotIn('Seq Scan', {node['Node Type'] for node in every}, plan)
                        # The UPDATE finds its row by the primary key.
                        self.assertIn('entities_pkey', reads, plan)
                        if which == 'hot':
                            self.assertEqual(reads, {'entities_pkey', 'public_entities_interest',
                                                     'public_entities_keep_warm'}, plan)
                            self.assertIn('BitmapOr', {node['Node Type'] for node in every}, plan)
                        else:
                            due = [node for node in every if node.get('Index Name') == 'public_entities_due']
                            self.assertEqual(reads, {'entities_pkey', 'public_entities_due'}, plan)
                            self.assertEqual(len(due), 1, plan)
                            self.assertIn('next_due <= statement_timestamp()', due[0]['Index Cond'], plan)
                            # The index gives next_due order: nothing is sorted.
                            self.assertNotIn('Sort', {node['Node Type'] for node in every}, plan)


if __name__ == '__main__':
    unittest.main()
