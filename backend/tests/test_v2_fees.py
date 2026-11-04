"""The V2 fee follower over a chain that settles as Uniswap does, and a real PostgreSQL.

The fake chain (v2_fee_fixtures.FeeChain) keeps Uniswap's own accounting for v3 and v4 positions and serves
their events and state; the V2 index's rows the follower reads (the deployment, its checkpoints, the
positions it knows, a vault's Compounded) are written as the indexer writes them; the store is the real
migrations 052 and 054 with the real writer and reader roles. Each test states what Uniswap paid and checks
what the follower recorded: fees per settlement, Fees earned at the points and now, a position minted
before Domino's first block, one the index learned about late, a reorganization, and the calls it spends.
"""
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest

import psycopg
from psycopg import sql

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from discovery import DataError  # noqa: E402
from dev_postgres import ADMIN, PORT, SOCKET  # noqa: E402
from v2_fee_fixtures import ZERO, FeeChain, tx_hash  # noqa: E402
from v2_fees import (DAY, HOUR, FeeStore, V2FeeFollower, decode_fee_log, growth_fees, settle,  # noqa: E402
                     Running, FeeLog, COLLECT, DECREASE, INCREASE, MODIFY_LIQUIDITY, TRANSFER)
from v2_fixtures import documents, with_synthetic_code, write_registry  # noqa: E402
from v2_rpc import ChainEndpoints, Endpoint  # noqa: E402

DB = 'domino_v2_fees_tests'
MIGRATIONS = [Path(__file__).resolve().parents[1] / f'migrations/{name}.sql' for name in ('052_v2_index', '054_v2_fees')]
FLOOR = 1000
OWNER, VAULT, OTHER = '0x' + 'b1' * 20, '0x' + 'a2' * 20, '0x' + 'b2' * 20
G = 1 << 128  # one unit of fees per unit of liquidity


def admin():
    return psycopg.connect(host=str(SOCKET), port=PORT, dbname=DB, user=ADMIN, autocommit=True)


def profile():
    """Base's profile with synthetic code at every verified contract, so the fake can prove it."""
    directory = tempfile.mkdtemp(prefix='v2-fees-registry-')
    docs = documents()
    docs['base-8453.json'] = with_synthetic_code(docs['base-8453.json'])
    return write_registry(directory, docs).chain('base-8453')


CHAIN = profile()


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'isolated PostgreSQL required')
class FeeFollowerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with psycopg.connect(host=str(SOCKET), port=PORT, dbname='postgres', user=ADMIN, autocommit=True) as conn:
            if not conn.execute('SELECT 1 FROM pg_database WHERE datname=%s', (DB,)).fetchone():
                conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(DB)))
        with admin() as conn:
            conn.execute('DROP SCHEMA IF EXISTS domino_v2 CASCADE')
            for migration in MIGRATIONS:
                conn.execute(migration.read_text())
            # Applying 054 again changes nothing (the installers re-run migrations).
            conn.execute(MIGRATIONS[1].read_text())

    def setUp(self):
        with admin() as conn:
            conn.execute('TRUNCATE domino_v2.deployments CASCADE')
        self.__dict__.pop('_follower', None)  # a new chain, a new process's follower
        self.chain = FeeChain(CHAIN, head=FLOOR + 400)
        self.clock = [self.chain.timestamp(FLOOR + 400)]
        self.store = FeeStore({'host': str(SOCKET), 'port': PORT, 'dbname': DB})
        with admin() as conn:
            conn.execute('''INSERT INTO domino_v2.deployments(chain_id,manifest_sha256,manifest,start_block,base_hash,
              next_block) VALUES(8453,%s,'{}',%s,%s,%s)''', ('a' * 64, FLOOR, self.chain.hash(FLOOR - 1), FLOOR))

    def follower(self, **options):
        """One process's follower: its endpoints, and their code cache, last as long as it does."""
        if options or not hasattr(self, '_follower'):
            endpoint = Endpoint('chainstack', 'chain.invalid', 'https://chain.invalid/', None, 100,
                                self.chain.max_log_blocks, None)
            endpoints = ChainEndpoints(CHAIN, (endpoint,), 'test', send=self.chain)
            made = V2FeeFollower(self.store, CHAIN, endpoints, clock=lambda: self.clock[0], **options)
            if options:
                return made
            self._follower = made
        return self._follower

    # -- the index's rows, as the indexer writes them
    def checkpoint(self, *numbers):
        with admin() as conn:
            for number in numbers:
                conn.execute('''INSERT INTO domino_v2.checkpoints(chain_id,start_block,end_block,end_hash,end_timestamp,
                  events) VALUES(8453,%s,%s,%s,%s,0) ON CONFLICT DO NOTHING''',
                             (number, number, self.chain.hash(number), self.chain.timestamp(number)))

    def known(self, dex, token, first, source='s1', vault=None):
        with admin() as conn:
            conn.execute('''INSERT INTO domino_v2.positions(chain_id,dex,token_id,source,vault,wallet,first_block,
              last_event_block) VALUES(8453,%s,%s,%s,%s,%s,%s,%s)''', (dex, token, source, vault, OWNER, first, first))

    def rows(self, query, *args):
        with admin() as conn:
            conn.row_factory = psycopg.rows.dict_row
            return conn.execute(query, args).fetchall()

    def events(self, dex, token):
        return self.rows('''SELECT * FROM domino_v2.fee_events WHERE chain_id=8453 AND dex=%s AND token_id=%s
          ORDER BY block_number,log_index''', dex, token)

    def follow(self, follower=None, rounds=20):
        follower = follower or self.follower()
        results = []
        for _ in range(rounds):
            result = follower.step()
            results.append(result)
            if result['status'] == 'caught_up_to_target' and not result.get('readBack'):
                break
        return results

    # ------------------------------------------------------------ scenarios
    def journey(self):
        """A v4 position S1 minted after the floor, compounded by its vault and collected by hand; a v3 position
        minted and settled three ways."""
        c = self.chain
        c.mint(4, 41, FLOOR + 10, owner=OWNER, liquidity=10)
        c.accrue(FLOOR + 50, (4, 41), 30 * G, 7 * G)
        c.settle((4, 41), FLOOR + 60, 0, tx='collect41')  # a collect: 300 and 70
        c.accrue(FLOOR + 100, (4, 41), 5 * G, 0)
        c.settle((4, 41), FLOOR + 120, 4, tx='increase41')  # an increase settles 50 first
        c.accrue(FLOOR + 200, (4, 41), 2 * G, G)
        c.mint(3, 31, FLOOR + 20, owner=OWNER, liquidity=8)
        c.accrue(FLOOR + 40, (3, 31), 10 * G, 3 * G)
        c.settle((3, 31), FLOOR + 70, -3, amounts=(500, 600), tx='decrease31')  # credits 80, 24 with the principal
        c.settle((3, 31), FLOOR + 90, 0, tx='collect31')  # takes everything owed
        c.accrue(FLOOR + 150, (3, 31), G, G)
        c.settle((3, 31), FLOOR + 160, 2, amounts=(10, 10), tx='increase31')  # credits 5, 5
        self.known(4, 41, FLOOR + 10)
        self.known(3, 31, FLOOR + 20)
        self.checkpoint(FLOOR + 100, FLOOR + 250, FLOOR + 400)

    def test_every_settlement_pays_what_uniswap_paid_and_earned_is_settled_plus_accrued(self):
        self.journey()
        results = self.follow()
        self.assertEqual(results[-1]['through'], FLOOR + 400)
        v4 = self.events(4, 41)
        settlements = [(e['block_number'], e['kind'], int(e['fees0']), int(e['fees1'])) for e in v4
                       if e['kind'] != 'transfer']
        self.assertEqual(settlements, [(FLOOR + 10, 'increase', 0, 0), (FLOOR + 60, 'collect', 300, 70),
                                       (FLOOR + 120, 'increase', 50, 0)])
        self.assertEqual([(e['from_address'], e['to_address']) for e in v4 if e['kind'] == 'transfer'],
                         [(ZERO, OWNER)])
        self.assertEqual((int(v4[-1]['settled0']), int(v4[-1]['settled1'])), (350, 70))
        v3 = [(e['block_number'], e['kind'], int(e['fees0']), int(e['fees1'])) for e in self.events(3, 31)
              if e['kind'] != 'transfer']
        self.assertEqual(v3, [(FLOOR + 20, 'increase', 0, 0), (FLOOR + 70, 'decrease', 80, 24),
                              (FLOOR + 90, 'collect', 0, 0), (FLOOR + 160, 'increase', 5, 5)])
        # Now: settled plus what accrued since, as the chain's own model says.
        now = {(int(r['dex']), int(r['token_id'])): r for r in self.rows('SELECT * FROM domino_v2.fee_now')}
        for key in ((4, 41), (3, 31)):
            self.assertEqual(now[key]['block_number'], FLOOR + 400)
            self.assertEqual(tuple(int(v) for v in now[key]['state']['earned']), self.chain.earned(key, FLOOR + 400))
        self.assertEqual(now[(4, 41)]['state']['unsettled'], [str(14 * 2), str(14)])
        # v3's collectable is tokensOwed with what accrued: the 10 of principal the increase did not take back.
        self.assertEqual(now[(3, 31)]['state']['tokensOwed'], ['5', '5'])
        # Points: one an hour (60 blocks), each Fees earned there.
        points = self.rows('''SELECT * FROM domino_v2.fee_points WHERE dex=4 AND token_id=41 ORDER BY block_number''')
        self.assertTrue(points)
        for point in points:
            self.assertEqual(point['hour'] % HOUR, 0)
            self.assertGreaterEqual(point['block_timestamp'], point['hour'])
            self.assertEqual((int(point['earned0']), int(point['earned1'])),
                             self.chain.earned((4, 41), point['block_number']))

    def test_a_caught_up_pass_reads_the_logs_the_cursor_and_one_multicall(self):
        self.journey()
        self.follow()
        self.chain.head += 3
        self.checkpoint(FLOOR + 403)
        self.chain.log.clear()
        self.follower().step()
        methods = [method for method, _ in self.chain.log]
        # Three filters (v3's events, both managers' transfers, v4's ModifyLiquidity), the checkpoint's header,
        # one aggregate3: nothing else, no head and no chain id.
        self.assertEqual(sorted(methods), ['eth_call', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_getLogs',
                                           'eth_getLogs'])
        # A pass that crosses an hour measures the hour's point from that same read.
        hour = (self.chain.timestamp(FLOOR + 403) // HOUR + 1) * HOUR
        crossing = FLOOR + 403 + -(-(hour - self.chain.timestamp(FLOOR + 403)) // self.chain.block_time)
        self.chain.head = crossing
        self.checkpoint(crossing)
        self.chain.log.clear()
        self.follower().step()
        self.assertEqual(sorted(method for method, _ in self.chain.log),
                         ['eth_call', 'eth_getBlockByNumber', 'eth_getLogs', 'eth_getLogs', 'eth_getLogs'])
        point, = self.rows('SELECT * FROM domino_v2.fee_points WHERE dex=4 AND token_id=41 AND block_number=%s',
                           crossing)
        self.assertEqual((point['hour'], (int(point['earned0']), int(point['earned1']))),
                         (hour, self.chain.earned((4, 41), crossing)))

    def test_a_position_minted_before_the_floor_starts_there_without_what_it_owed(self):
        c = self.chain
        c.mint(4, 40, FLOOR - 50, owner=OWNER, liquidity=10)
        c.accrue(FLOOR - 20, (4, 40), 9 * G, 0)  # owed before Domino: never counted
        c.accrue(FLOOR + 30, (4, 40), 2 * G, G)
        c.settle((4, 40), FLOOR + 80, 0, tx='collect40')
        self.known(4, 40, FLOOR + 80, source='vault_root', vault=VAULT)
        self.checkpoint(FLOOR + 400)
        self.follow()
        row, = self.rows('SELECT * FROM domino_v2.fee_positions WHERE token_id=40')
        self.assertEqual((row['since_kind'], row['since_block'], row['status']), ('floor', FLOOR, 'following'))
        settlement, = [e for e in self.events(4, 40) if e['kind'] != 'transfer']
        # Uniswap paid 110 and 10 at the collect: 90 of it was owed before the floor.
        self.assertEqual((int(settlement['fees0']), int(settlement['fees1'])), (20, 10))

    def test_a_position_the_index_learned_late_is_read_back_from_the_floor_then_follows(self):
        self.journey()
        self.follow()
        c = self.chain
        # A root minted after the floor, outside Domino, made a vault's root at FLOOR + 500.
        c.head = FLOOR + 600
        c.mint(3, 77, FLOOR + 30, owner=OWNER, liquidity=4)
        c.accrue(FLOOR + 35, (3, 77), 3 * G, 0)
        c.settle((3, 77), FLOOR + 300, 0, tx='collect77')
        c.transfer((3, 77), FLOOR + 500, VAULT)
        self.known(3, 77, FLOOR + 500, source='vault_root', vault=VAULT)
        self.checkpoint(FLOOR + 600)
        results = self.follow()
        self.assertTrue(any(r.get('readBack') for r in results))
        row, = self.rows('SELECT * FROM domino_v2.fee_positions WHERE token_id=77')
        self.assertEqual((row['since_kind'], row['since_block'], row['status'], row['through_block']),
                         ('mint', FLOOR + 30, 'following', FLOOR + 600))
        settled = [(e['block_number'], int(e['fees0']), int(e['fees1'])) for e in self.events(3, 77)
                   if e['kind'] == 'collect']
        # 77 shares 31's pool and range, so their growth inside is one: 4 x (3 + 10 + 1) and 4 x (3 + 1).
        self.assertEqual(settled, [(FLOOR + 300, 56, 16)])
        self.assertEqual(settled[0][1:], self.chain.positions[(3, 77)]['paid'][-1][1])
        self.assertEqual([e['to_address'] for e in self.events(3, 77) if e['kind'] == 'transfer'], [OWNER, VAULT])

    def test_a_rewind_of_the_index_deletes_what_was_above_the_fork(self):
        self.journey()
        c = self.chain
        c.settle((3, 31), FLOOR + 300, -10, amounts=(5, 5), tx='exit31')
        c.settle((3, 31), FLOOR + 300, 0, tx='exit31')
        c.transfer((3, 31), FLOOR + 300, ZERO, tx='exit31')
        self.checkpoint(FLOOR + 50)
        self.follow()
        self.assertEqual(self.rows('SELECT status FROM domino_v2.fee_positions WHERE dex=3')[0]['status'], 'burned')
        with admin() as conn:
            conn.execute('DELETE FROM domino_v2.checkpoints WHERE end_block>%s', (FLOOR + 250,))
        c.reorg(FLOOR + 251)
        result = self.follower().step()
        # The newest checkpoint still standing, not the oldest.
        self.assertEqual(result, {'status': 'rewound', 'through': FLOOR + 250})
        self.assertFalse(self.rows('SELECT 1 FROM domino_v2.fee_events WHERE block_number>%s', FLOOR + 250))
        self.assertFalse(self.rows('SELECT 1 FROM domino_v2.fee_now'))
        cursor, = self.rows('SELECT * FROM domino_v2.fee_cursor')
        self.assertEqual((cursor['block_number'], cursor['block_hash']), (FLOOR + 250, self.chain.hash(FLOOR + 250)))
        # The burn was above the fork: the position follows again; every position is read through the fork.
        rows = self.rows('SELECT status,burned_block,through_block FROM domino_v2.fee_positions ORDER BY dex')
        self.assertEqual([(r['status'], r['burned_block'], r['through_block']) for r in rows],
                         [('following', None, FLOOR + 250), ('following', None, FLOOR + 250)])

    def test_one_follower_per_chain(self):
        with self.store.writer(8453):
            with self.assertRaisesRegex(DataError, 'v2_fees_busy'):
                self.follower().step()

    def test_the_reader_role_cannot_write(self):
        with psycopg.connect(host=str(SOCKET), port=PORT, dbname=DB, user='domino_catalogue_reader') as conn:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute("UPDATE domino_v2.fee_cursor SET caught_up=true")

    def test_two_settlements_in_a_block_after_a_liquidity_change_are_not_known_on_v4(self):
        c = self.chain
        c.mint(4, 41, FLOOR + 10, owner=OWNER, liquidity=10)
        c.accrue(FLOOR + 30, (4, 41), 2 * G, 0)
        c.settle((4, 41), FLOOR + 40, 5, tx='a')  # an increase, then a collect in the same block: the liquidity
        c.settle((4, 41), FLOOR + 40, 0, tx='b')  # between them is not the one before either
        c.accrue(FLOOR + 50, (4, 41), G, 0)
        c.settle((4, 41), FLOOR + 70, 0, tx='c')
        self.known(4, 41, FLOOR + 10)
        self.checkpoint(FLOOR + 400)
        self.follow()
        rows = [(e['block_number'], e['why'], e['fees0'], e['settled0']) for e in self.events(4, 41)
                if e['kind'] != 'transfer']
        # The later settlement's own fees are known (15 for 15 liquidity), the sum since the mint no longer is.
        self.assertEqual(rows, [(FLOOR + 10, None, 0, 0), (FLOOR + 40, 'same_block', None, None),
                                (FLOOR + 70, None, 15, None)])
        now, = self.rows('SELECT state FROM domino_v2.fee_now')
        self.assertIsNone(now['state']['earned'])
        self.assertFalse(self.rows('SELECT 1 FROM domino_v2.fee_points WHERE block_number>%s AND earned0 IS NOT NULL',
                                   FLOOR + 40))

    def test_a_collect_then_a_compound_in_one_block_is_known_as_one_settlement(self):
        c = self.chain
        c.mint(4, 41, FLOOR + 10, owner=OWNER, liquidity=10, tx='plain')
        c.mint(4, 42, FLOOR + 10, owner=OWNER, liquidity=10)
        c.accrue(FLOOR + 30, (4, 42), 2 * G, 0)
        c.settle((4, 42), FLOOR + 40, 0, tx='compound')  # the vault collects,
        c.settle((4, 42), FLOOR + 40, 3, tx='compound')  # then adds back: no liquidity moved before the last log
        c.settle((4, 41), FLOOR + 40, 0, tx='compound')  # another position in the same transaction, not compounded
        self.known(4, 41, FLOOR + 10)
        self.known(4, 42, FLOOR + 10, source='vault_root', vault=VAULT)
        with admin() as conn:
            conn.execute('''INSERT INTO domino_v2.logs(chain_id,block_number,log_index,block_hash,block_timestamp,
              tx_hash,tx_index,address,emitter,event,args,owner,vault,dex,token_id) VALUES(8453,%s,99,%s,%s,%s,0,%s,
              'vault','Compounded',%s,%s,%s,4,42)''',
                         (FLOOR + 40, c.hash(FLOOR + 40), c.timestamp(FLOOR + 40), tx_hash(f'compound:{FLOOR + 40}'),
                          VAULT, json.dumps({'tokenId': '42', 'liquidityAdded': '3', 'fees0': '20', 'fees1': '0',
                                             'serviceFee0': '1', 'serviceFee1': '0', 'stateNonce': '2'}), OWNER, VAULT))
        self.checkpoint(FLOOR + 400)
        self.follow()
        row, = [e for e in self.events(4, 42) if e['block_number'] == FLOOR + 40]
        self.assertEqual((row['kind'], row['log_indexes'], int(row['liquidity_delta']), int(row['fees0'])),
                         ('increase', [0, 1], 3, 20))
        self.assertEqual((row['auto'], int(row['service_fee0']), int(row['service_fee1'])), (True, 1, 0))
        other, = [e for e in self.events(4, 41) if e['block_number'] == FLOOR + 40]
        self.assertEqual((other['auto'], other['service_fee0']), (False, None))

    def test_an_event_the_provider_did_not_return_makes_the_history_inexact(self):
        c = self.chain
        c.mint(4, 41, FLOOR + 10, owner=OWNER, liquidity=10)
        c.settle((4, 41), FLOOR + 40, 5, tx='seen')
        index = c.settle.__self__.logs[-1][2]['logIndex']
        c.drop.add((FLOOR + 40, int(index, 16)))  # the increase never reaches the follower
        c.settle((4, 41), FLOOR + 90, 0, tx='later')
        self.known(4, 41, FLOOR + 10)
        self.checkpoint(FLOOR + 400)
        self.follow()
        rows = [(e['block_number'], e['why']) for e in self.events(4, 41) if e['kind'] != 'transfer']
        self.assertEqual(rows, [(FLOOR + 10, None), (FLOOR + 90, 'liquidity')])
        # A point between the unseen event and the next one (an hour is 60 blocks here) reads liquidity the history
        # cannot account for.
        between = self.rows('SELECT earned0 FROM domino_v2.fee_points WHERE block_number>=%s AND block_number<%s',
                            FLOOR + 40, FLOOR + 90)
        self.assertTrue(between)
        self.assertEqual({p['earned0'] for p in between}, {None})

    def test_a_v3_collect_the_provider_did_not_return_fails_the_growth_check(self):
        c = self.chain
        c.mint(3, 31, FLOOR + 10, owner=OWNER, liquidity=10)
        c.accrue(FLOOR + 20, (3, 31), 2 * G, G)
        c.settle((3, 31), FLOOR + 30, 0, tx='hidden')
        c.drop.add((FLOOR + 30, 0))
        c.accrue(FLOOR + 40, (3, 31), G, 0)
        c.settle((3, 31), FLOOR + 50, 0, tx='seen')
        self.known(3, 31, FLOOR + 10)
        self.checkpoint(FLOOR + 400)
        self.follow()
        last = [e for e in self.events(3, 31) if e['kind'] != 'transfer'][-1]
        # tokensOwed says 0 was owed and 30 was paid; the growth since the last settlement seen says 30 + 10.
        self.assertEqual((last['block_number'], last['why'], last['fees0']), (FLOOR + 50, 'liquidity', None))

    def test_a_v3_position_closed_and_burned_in_one_block_settles_from_its_tokens_owed(self):
        c = self.chain
        c.mint(3, 31, FLOOR + 10, owner=OWNER, liquidity=10)
        c.accrue(FLOOR + 20, (3, 31), 2 * G, G)
        c.settle((3, 31), FLOOR + 30, -10, amounts=(700, 800), tx='exit')
        c.settle((3, 31), FLOOR + 30, 0, tx='exit')
        c.transfer((3, 31), FLOOR + 30, ZERO, tx='exit')
        self.known(3, 31, FLOOR + 10)
        self.checkpoint(FLOOR + 400)
        self.follow()
        row, = self.rows('SELECT * FROM domino_v2.fee_positions')
        self.assertEqual((row['status'], row['burned_block']), ('burned', FLOOR + 30))
        exit_, = [e for e in self.events(3, 31) if e['block_number'] == FLOOR + 30 and e['kind'] != 'transfer']
        self.assertEqual((exit_['kind'], int(exit_['fees0']), int(exit_['fees1']), int(exit_['liquidity'])),
                         ('decrease', 20, 10, 0))
        self.assertFalse(self.rows('SELECT 1 FROM domino_v2.fee_now'))
        self.assertFalse(self.rows('SELECT 1 FROM domino_v2.fee_points WHERE block_number>=%s', FLOOR + 30))

    def test_every_log_range_fits_the_endpoint_and_a_crowded_one_is_halved(self):
        from unittest import mock
        self.journey()
        # The index's live checkpoints are seconds apart: a main step can end at any of them.
        self.checkpoint(*range(FLOOR + 10, FLOOR + 400, 10))
        with mock.patch('v2_fees.MAX_CHUNK_EVENTS', 4), mock.patch('v2_fees.MIN_SPAN', 50):
            follower = self.follower(span=400)
            results = self.follow(follower)
        self.assertEqual(results[-1]['through'], FLOOR + 400)
        for method, params in self.chain.log:
            if method == 'eth_getLogs':
                self.assertLessEqual(int(params[0]['toBlock'], 16) - int(params[0]['fromBlock'], 16) + 1,
                                     self.chain.max_log_blocks)
        settled = [e['block_number'] for e in self.events(4, 41) if e['kind'] != 'transfer']
        self.assertEqual(settled, [FLOOR + 10, FLOOR + 60, FLOOR + 120])
        with mock.patch('v2_fees.MAX_CHUNK_EVENTS', 0), mock.patch('v2_fees.MIN_SPAN', 50):
            self.chain.head += 5
            self.checkpoint(FLOOR + 405)
            self.chain.settle((4, 41), FLOOR + 405, 0)
            with self.assertRaisesRegex(DataError, 'v2_fee_log_budget_exhausted'):
                self.follower(span=400).step()

    def test_one_multicall_reads_at_most_its_reads_and_many_positions_take_more(self):
        c = self.chain
        for token in range(100, 230):
            c.mint(3, token, FLOOR + 10, owner=OWNER, liquidity=1)
            self.known(3, token, FLOOR + 10)
        self.checkpoint(FLOOR + 400)
        self.follow()
        self.assertTrue(c.calls_per_aggregate)
        self.assertLessEqual(max(c.calls_per_aggregate), 512)
        # The state now: 130 positions of 4 reads (the manager's position, the two ticks, the owner) and the
        # pool's 3 once (slot0, both global growths): two calls.
        self.assertEqual(c.calls_per_aggregate[-2:], [512, 4 * 130 + 3 - 512])

    def test_the_follower_stays_on_the_index_s_checkpoints(self):
        self.journey()
        self.chain.head = FLOOR + 900  # the chain is far ahead; the index is not
        results = self.follow()
        self.assertEqual(results[-1]['through'], FLOOR + 400)
        self.assertEqual(self.follower().step(through=FLOOR + 250)['status'], 'caught_up_to_target')
        self.assertFalse(any(method == 'eth_chainId' for method, _ in self.chain.log))

    def test_a_target_the_chain_no_longer_has_commits_nothing(self):
        self.journey()
        self.chain.reorg(FLOOR + 300)  # the index has not seen it yet
        with self.assertRaisesRegex(DataError, 'v2_fee_snapshot_reorganized'):
            self.follow()
        self.assertFalse(self.rows('SELECT 1 FROM domino_v2.fee_now'))
        cursor, = self.rows('SELECT * FROM domino_v2.fee_cursor')
        self.assertEqual((cursor['block_number'] < FLOOR + 400, cursor['last_error']),
                         (True, 'v2_fee_snapshot_reorganized'))

    def test_a_checkpoint_rewound_during_the_pass_commits_nothing(self):
        self.journey()
        follower = self.follower()
        original = self.chain.aggregate

        def rewinding(call, number):
            if number == FLOOR + 400:
                with admin() as conn:
                    conn.execute('DELETE FROM domino_v2.checkpoints WHERE end_block=%s', (FLOOR + 400,))
            return original(call, number)
        self.chain.aggregate = rewinding
        with self.assertRaisesRegex(DataError, 'v2_fee_checkpoint_rewound'):
            self.follow(follower)
        self.assertFalse(self.rows('SELECT 1 FROM domino_v2.fee_now'))

    def test_points_are_hourly_for_eight_days_then_daily_and_older_hours_are_thinned(self):
        self.chain = FeeChain(CHAIN, head=FLOOR + 1500, block_time=1200)  # 3 blocks an hour, 72 a day: 20 days
        c = self.chain
        with admin() as conn:
            conn.execute('UPDATE domino_v2.deployments SET base_hash=%s', (c.hash(FLOOR - 1),))
        c.mint(4, 41, FLOOR + 1, owner=OWNER, liquidity=10)
        for number in range(FLOOR + 2, FLOOR + 1600, 5):
            c.accrue(number, (4, 41), G, 0)
        self.known(4, 41, FLOOR + 1)
        self.checkpoint(*range(FLOOR + 100, FLOOR + 1501, 100))
        self.clock = [c.timestamp(FLOOR + 1500)]
        self.follow()
        points = self.rows('SELECT hour,kind,block_timestamp FROM domino_v2.fee_points ORDER BY hour')
        cutoff = (self.clock[0] - 8 * DAY) // HOUR * HOUR
        self.assertTrue(any(p['hour'] < cutoff for p in points) and any(p['hour'] >= cutoff for p in points))
        for point in points:
            self.assertEqual(point['kind'] == 'day', point['hour'] % DAY == 0)
            self.assertTrue(point['kind'] == 'day' or point['hour'] >= cutoff, point)
        hours = [p['hour'] for p in points if p['hour'] >= cutoff]
        self.assertEqual(hours, list(range(hours[0], hours[0] + HOUR * len(hours), HOUR)))
        # A position learned late is read back a day of chain time (72 blocks here) at a time.
        c.mint(4, 42, FLOOR + 3, owner=OWNER, liquidity=1)
        self.known(4, 42, FLOOR + 1500)
        steps = [r['readBack'] for r in self.follow(rounds=40) if r.get('readBack')]
        self.assertGreater(len(steps), 10)
        self.assertTrue(all(step['through'] - step['fromBlock'] + 1 <= 73 for step in steps), steps)
        # A day later the oldest hourly points are thinned to their day's first.
        c.head += 72
        self.checkpoint(FLOOR + 1572)
        self.clock = [c.timestamp(FLOOR + 1572)]
        self.follower().step()
        cutoff = (self.clock[0] - 8 * DAY) // HOUR * HOUR
        self.assertFalse(self.rows("SELECT 1 FROM domino_v2.fee_points WHERE kind='hour' AND hour<%s", cutoff))

    def test_code_other_than_the_profile_s_is_refused(self):
        self.journey()
        original = self.chain.answer

        def wrong(body):
            reply = original(body)
            if body['method'] == 'eth_getCode':
                reply['result'] = '0x00'
            return reply
        self.chain.answer = wrong
        with self.assertRaisesRegex(DataError, 'v2_deployment_code_mismatch'):
            self.follow()

    def test_the_start_is_the_deployment_s_base_and_a_moved_base_stops_the_follower(self):
        self.journey()
        with admin() as conn:
            conn.execute("UPDATE domino_v2.deployments SET base_hash=%s", ('0x' + '11' * 32,))
        with self.assertRaisesRegex(DataError, 'v2_deployment_reorganized'):
            self.follower().step()
        self.assertFalse(self.rows('SELECT 1 FROM domino_v2.fee_cursor'))

    def test_a_token_that_cannot_be_identified_waits_and_a_later_pass_joins_it(self):
        self.journey()
        self.known(4, 999, FLOOR + 150)  # no such token on the chain (yet)
        self.follow()
        self.assertFalse(self.rows('SELECT 1 FROM domino_v2.fee_positions WHERE token_id=999'))
        self.assertEqual(len(self.rows('SELECT 1 FROM domino_v2.fee_positions')), 2)

    def test_a_v3_fee_tier_the_profile_does_not_list_is_asked_of_the_factory(self):
        from v2_uniswap import PoolRef
        c = self.chain
        c.mint(3, 31, FLOOR + 10, owner=OWNER, liquidity=10,
               pool=PoolRef(3, '0x' + '0a' * 20, '0x' + '0b' * 20, 2500, 50), lower=-500, upper=500)
        self.known(3, 31, FLOOR + 10)
        self.checkpoint(FLOOR + 400)
        self.follow()
        row, = self.rows('SELECT pool FROM domino_v2.fee_positions')
        self.assertEqual((row['pool']['fee'], row['pool']['tickSpacing']), (2500, 50))

    def test_a_burned_v4_position_stops_and_loses_its_now(self):
        self.journey()
        self.follow()
        c = self.chain
        c.head = FLOOR + 500
        c.settle((4, 41), FLOOR + 450, -14, tx='exit41')
        c.transfer((4, 41), FLOOR + 450, ZERO, tx='exit41')
        self.checkpoint(FLOOR + 500)
        self.follow()
        row, = self.rows('SELECT * FROM domino_v2.fee_positions WHERE token_id=41')
        self.assertEqual((row['status'], row['burned_block']), ('burned', FLOOR + 450))
        self.assertEqual([int(r['token_id']) for r in self.rows('SELECT token_id FROM domino_v2.fee_now')], [31])

    def test_a_failed_pass_records_its_error_and_the_next_clears_it(self):
        self.journey()
        self.follow()
        self.chain.head += 2
        self.checkpoint(FLOOR + 402)
        original = self.chain.answer

        def refusing(body):
            if body['method'] == 'eth_getLogs':
                return {'jsonrpc': '2.0', 'id': body['id'], 'error': {'code': -32602, 'message': 'invalid'}}
            return original(body)
        self.chain.answer = refusing
        with self.assertRaises(DataError) as failed:
            self.follower().step()
        cursor, = self.rows('SELECT * FROM domino_v2.fee_cursor')
        self.assertEqual((cursor['block_number'], cursor['last_error']), (FLOOR + 400, str(failed.exception)))
        self.chain.answer = original
        self.follower().step()
        cursor, = self.rows('SELECT * FROM domino_v2.fee_cursor')
        self.assertEqual((cursor['block_number'], cursor['last_error']), (FLOOR + 402, None))

    def test_a_rewind_then_reading_again_gives_the_same_history(self):
        self.journey()
        self.follow()
        before = self.rows('''SELECT dex,token_id,block_number,log_index,fees0,fees1,settled0,settled1
          FROM domino_v2.fee_events ORDER BY 1,2,3,4''')
        points = self.rows('SELECT dex,token_id,block_number,earned0,earned1 FROM domino_v2.fee_points ORDER BY 1,2,3')
        with admin() as conn:
            conn.execute('DELETE FROM domino_v2.checkpoints WHERE end_block>%s', (FLOOR + 100,))
        self.follower().step()
        self.checkpoint(FLOOR + 250, FLOOR + 400)
        self.follow()
        self.assertEqual(self.rows('''SELECT dex,token_id,block_number,log_index,fees0,fees1,settled0,settled1
          FROM domino_v2.fee_events ORDER BY 1,2,3,4'''), before)
        self.assertEqual(self.rows('SELECT dex,token_id,block_number,earned0,earned1 FROM domino_v2.fee_points '
                                   'ORDER BY 1,2,3'), points)


    def test_a_v3_position_minted_before_the_floor_counts_neither_what_it_owed_nor_what_had_accrued(self):
        c = self.chain
        c.mint(3, 30, FLOOR - 50, owner=OWNER, liquidity=10)
        c.accrue(FLOOR - 40, (3, 30), 4 * G, 0)
        c.settle((3, 30), FLOOR - 30, 0, tx='early')  # credited 40 before Domino, collected then
        c.accrue(FLOOR - 20, (3, 30), 5 * G, 2 * G)  # accrued before Domino, settled after it
        c.accrue(FLOOR + 30, (3, 30), 2 * G, G)
        c.settle((3, 30), FLOOR + 80, -4, amounts=(900, 900), tx='decrease30')
        self.known(3, 30, FLOOR + 80, source='vault_root', vault=VAULT)
        self.checkpoint(FLOOR + 400)
        self.follow()
        row, = [e for e in self.events(3, 30) if e['kind'] != 'transfer']
        # Uniswap credited 10 x (5 + 2) and 10 x (2 + 1) at the decrease: 50 and 20 of it accrued before the floor.
        self.assertEqual((row['why'], int(row['fees0']), int(row['fees1'])), (None, 20, 10))
        self.assertEqual(c.positions[(3, 30)]['paid'][-1][1], (70, 30))
        now, = self.rows('SELECT state FROM domino_v2.fee_now')
        # What a collect pays now: the 900 of principal, the 70 and 30 credited, nothing accrued since.
        self.assertEqual((now['state']['collectable'], now['state']['earned']), (['970', '930'], ['20', '10']))

    def test_the_state_now_is_written_only_at_the_index_s_newest_checkpoint(self):
        self.journey()
        follower = self.follower()
        first = follower.step(through=FLOOR + 100)
        self.assertEqual((first['through'], first['caughtUp']), (FLOOR + 100, False))
        self.assertFalse(self.rows('SELECT 1 FROM domino_v2.fee_now'))
        cursor, = self.rows('SELECT caught_up FROM domino_v2.fee_cursor')
        self.assertFalse(cursor['caught_up'])
        again = follower.step(through=FLOOR + 100)
        self.assertEqual((again['status'], again['through']), ('caught_up_to_target', FLOOR + 100))
        self.follow(follower)
        self.assertEqual({r['block_number'] for r in self.rows('SELECT block_number FROM domino_v2.fee_now')},
                         {FLOOR + 400})

    def test_a_v3_position_gone_without_its_burn_stops_the_pass(self):
        c = self.chain
        c.mint(3, 31, FLOOR + 10, owner=OWNER, liquidity=10)
        c.settle((3, 31), FLOOR + 30, -10, amounts=(1, 1), tx='close')
        c.positions[(3, 31)]['burned'] = FLOOR + 30  # the manager forgets it, with no Transfer to zero seen
        self.known(3, 31, FLOOR + 10)
        self.checkpoint(FLOOR + 100, FLOOR + 400)
        with self.assertRaisesRegex(DataError, 'v2_fee_position_unreadable'):
            self.follower().step(through=FLOOR + 100)  # a range that reads no state "now"

    def test_a_live_position_without_an_owner_is_not_stored_as_now(self):
        self.journey()
        original = self.chain.read

        def ownerless(target, data, number):
            if target == self.chain.posm and '0x' + data[:4].hex() == '0x6352211e':  # ownerOf
                from v2_fee_fixtures import Revert
                raise Revert()
            return original(target, data, number)
        self.chain.read = ownerless
        with self.assertRaisesRegex(DataError, 'v2_fee_position_unreadable'):
            self.follow()
        self.assertFalse(self.rows('SELECT 1 FROM domino_v2.fee_now'))

    def test_another_manager_s_token_with_a_followed_id_is_not_followed(self):
        self.journey()
        self.chain.mint(3, 41, FLOOR + 15, owner=OTHER, liquidity=5)  # v3 #41, someone's, beside Domino's v4 #41
        self.follow()
        self.assertEqual(len([e for e in self.events(4, 41) if e['kind'] == 'transfer']), 1)
        self.assertFalse(self.rows('SELECT 1 FROM domino_v2.fee_positions WHERE dex=3 AND token_id=41'))

    def test_a_log_whose_block_moved_under_the_read_commits_nothing(self):
        self.journey()
        original = self.chain.get_logs

        def stale(query):
            found = original(query)
            for log in found[:1]:
                log['blockHash'] = '0x' + 'ee' * 32
            return found
        self.chain.get_logs = stale
        with self.assertRaisesRegex(DataError, 'v2_fee_snapshot_reorganized'):
            self.follow()
        self.assertFalse(self.rows('SELECT 1 FROM domino_v2.fee_events'))

    def test_a_log_outside_the_range_asked_is_refused(self):
        self.journey()
        self.follow()
        self.chain.head += 5
        self.checkpoint(FLOOR + 405)
        original = self.chain.get_logs
        self.chain.get_logs = lambda query: original(query) + original({**query, 'fromBlock': hex(FLOOR + 10),
                                                                        'toBlock': hex(FLOOR + 10)})
        with self.assertRaisesRegex(DataError, 'v2_event_outside_range'):
            self.follower().step()

    def test_a_log_returned_twice_counts_once_and_a_conflicting_copy_is_refused(self):
        self.journey()
        original = self.chain.get_logs
        self.chain.get_logs = lambda query: [dict(log) for log in original(query) for _ in (0, 1)]
        self.follow()
        settlements = [(e['block_number'], e['why'], int(e['fees0'])) for e in self.events(4, 41)
                       if e['kind'] != 'transfer']
        self.assertEqual(settlements, [(FLOOR + 10, None, 0), (FLOOR + 60, None, 300), (FLOOR + 120, None, 50)])
        with admin() as conn:
            conn.execute('TRUNCATE domino_v2.fee_cursor, domino_v2.fee_positions CASCADE')

        def conflicting(query):
            from eth_abi import decode, encode
            found = original(query)
            types = ['int24', 'int24', 'int256', 'bytes32']
            changed = []
            for log in found:
                if log['topics'][0] == MODIFY_LIQUIDITY:
                    lower, upper, delta, salt = decode(types, bytes.fromhex(log['data'][2:]))
                    changed.append(dict(log, data='0x' + encode(types, [lower, upper, delta + 1, salt]).hex()))
            return found + changed
        self.chain.get_logs = conflicting
        with self.assertRaisesRegex(DataError, 'v2_conflicting_duplicate_log'):
            self.follower().step()

    def test_malformed_or_missing_state_is_refused(self):
        from v2_fee_fixtures import Revert
        from v2_abi import function
        for name, selector, target, after, code in (
                ('the v4 position', function('IV4StateViewMinimal', 'getPositionInfo').selector, 'state_view',
                 FLOOR + 50, 'v2_fee_state_unreadable'),
                ('the v3 range', function('IUniswapV3PositionManagerMinimal', 'positions').selector, 'npm',
                 FLOOR + 50, 'v2_fee_event_mismatch'),
                ('the v3 pool', function('IUniswapV3PoolMinimal', 'slot0').selector, None, FLOOR + 50,
                 'v2_fee_state_unreadable')):
            with self.subTest(name):
                self.setUp()
                self.journey()
                original = self.chain.read

                def broken(read_target, data, number, selector=selector, target=target, after=after):
                    hit = '0x' + data[:4].hex() == selector and number >= after and (
                        target is None or read_target == getattr(self.chain, target))
                    if hit and selector == function('IUniswapV3PositionManagerMinimal', 'positions').selector:
                        from eth_abi import encode
                        model = self.chain.positions[(3, int.from_bytes(data[4:], 'big'))]
                        _, liquidity, last, owed = self.chain.state_at(model, number)
                        p = model['pool']
                        return encode(list(function('IUniswapV3PositionManagerMinimal', 'positions').outputs),
                                      [0, ZERO, p.currency0, p.currency1, p.fee, -1200, 1200, liquidity, *last, *owed])
                    if hit:
                        raise Revert()
                    return original(read_target, data, number)
                self.chain.read = broken
                with self.assertRaisesRegex(DataError, code):
                    self.follow()

    def test_a_v4_position_of_another_pool_and_a_v3_tier_the_factory_lacks_are_refused(self):
        from v2_abi import function
        from v2_uniswap import PoolRef
        self.journey()
        original = self.chain.read
        info = function('IV4PositionManagerMinimal', 'getPoolAndPositionInfo')

        def elsewhere(target, data, number):
            answer = original(target, data, number)
            if '0x' + data[:4].hex() == info.selector:
                key, packed = info.decode('0x' + answer.hex())
                from eth_abi import encode
                return encode(list(info.outputs), [key, packed & ((1 << 56) - 1)]) if packed else answer
            return answer
        self.chain.read = elsewhere
        with self.assertRaisesRegex(DataError, 'v4_position_pool_mismatch'):
            self.follow()
        self.setUp()
        self.chain.mint(3, 31, FLOOR + 10, owner=OWNER, liquidity=10,
                        pool=PoolRef(3, '0x' + '0a' * 20, '0x' + '0b' * 20, 2500, 50), lower=-500, upper=500)
        self.known(3, 31, FLOOR + 10)
        self.checkpoint(FLOOR + 400)
        tier = function('IUniswapV3FactoryMinimal', 'feeAmountTickSpacing')
        original = self.chain.read
        self.chain.read = lambda target, data, number: ((0).to_bytes(32, 'big') if '0x' + data[:4].hex() ==
                                                        tier.selector else original(target, data, number))
        with self.assertRaisesRegex(DataError, 'v3_fee_tier_unknown'):
            self.follow()

    def test_a_cursor_another_writer_moved_during_the_pass_commits_nothing(self):
        self.journey()
        self.follow()
        self.chain.head += 3
        self.checkpoint(FLOOR + 403)
        original = self.chain.aggregate

        def moving(call, number):
            if number == FLOOR + 403:
                with admin() as conn:
                    conn.execute('UPDATE domino_v2.fee_cursor SET block_hash=%s', ('0x' + '0f' * 32,))
            return original(call, number)
        self.chain.aggregate = moving
        with self.assertRaisesRegex(DataError, 'v2_fee_cursor_changed'):
            self.follower().step()

    def test_the_index_rewinding_while_the_pass_commits_never_deadlocks(self):
        import threading
        self.journey()
        self.follow()
        self.chain.head += 3
        self.checkpoint(FLOOR + 403)
        original, finished = self.chain.aggregate, []

        def racing(call, number):
            if number == FLOOR + 403 and not finished:
                # The index rewinds: positions first (cascading into the fee rows), then the checkpoints.
                conn = psycopg.connect(host=str(SOCKET), port=PORT, dbname=DB, user=ADMIN)
                conn.execute('DELETE FROM domino_v2.positions WHERE token_id=41')

                def then():
                    import time as clock
                    clock.sleep(0.5)
                    try:
                        conn.execute('DELETE FROM domino_v2.checkpoints WHERE end_block=%s', (FLOOR + 403,))
                        conn.commit()
                        finished.append('committed')
                    except psycopg.Error as error:
                        finished.append(type(error).__name__)
                    finally:
                        conn.close()
                threading.Thread(target=then).start()
            return original(call, number)
        self.chain.aggregate = racing
        with self.assertRaisesRegex(DataError, 'v2_fee_checkpoint_rewound'):
            self.follower().step()
        for _ in range(100):
            if finished:
                break
            import time as clock
            clock.sleep(0.05)
        self.assertEqual(finished, ['committed'])

    def test_a_crowded_pass_halves_on_a_fresh_client(self):
        from unittest import mock
        self.journey()
        with mock.patch('v2_fees.MIN_SPAN', 50):
            follower = self.follower(span=400, max_requests=32)
            results = self.follow(follower)
        self.assertEqual(results[-1]['through'], FLOOR + 400)
        self.assertEqual([e['block_number'] for e in self.events(4, 41) if e['kind'] != 'transfer'],
                         [FLOOR + 10, FLOOR + 60, FLOOR + 120])

    def test_positions_read_back_from_different_blocks_each_read_their_own_history(self):
        from unittest import mock
        self.journey()
        self.follow()
        c = self.chain
        c.head = FLOOR + 800
        self.checkpoint(FLOOR + 800)
        c.mint(3, 77, FLOOR + 30, owner=OWNER, liquidity=4)
        c.transfer((3, 77), FLOOR + 500, VAULT)
        c.mint(3, 78, FLOOR + 40, owner=OWNER, liquidity=6)
        c.accrue(FLOOR + 45, (3, 78), G, 0)
        c.settle((3, 78), FLOOR + 90, 0, tx='collect78')
        c.transfer((3, 78), FLOOR + 600, VAULT)
        with mock.patch('v2_fees.MIN_SPAN', 50):
            follower = self.follower(span=150)
            self.known(3, 77, FLOOR + 500, source='vault_root', vault=VAULT)
            follower.step()  # 77 joins and reads back its first range
            self.known(3, 78, FLOOR + 600, source='vault_root', vault=VAULT)
            self.follow(follower, rounds=30)
        rows = {int(r['token_id']): r for r in self.rows('SELECT * FROM domino_v2.fee_positions WHERE dex=3')}
        self.assertEqual([(rows[t]['since_kind'], rows[t]['since_block'], rows[t]['status']) for t in (77, 78)],
                         [('mint', FLOOR + 30, 'following'), ('mint', FLOOR + 40, 'following')])
        collect, = [e for e in self.events(3, 78) if e['kind'] == 'collect']
        self.assertEqual((collect['block_number'], collect['why']), (FLOOR + 90, None))

    def test_the_index_s_newest_checkpoint_is_the_follow_loop_s_target(self):
        follower = self.follower()
        with self.assertRaisesRegex(DataError, 'v2_fees_index_not_started'):
            follower.index_head()
        self.checkpoint(FLOOR + 250, FLOOR + 100)
        self.assertEqual(follower.index_head(), {'number': FLOOR + 250})

    def test_the_read_api_answers_what_the_follower_stored(self):
        from v2_index_store import V2Store
        from v2_read_service import V2ReadService
        self.journey()
        service = V2ReadService(V2Store({'host': str(SOCKET), 'port': PORT, 'dbname': DB}),
                                clock=lambda: self.clock[0] + 30)
        # Before the follower ran: the chain is not followed.
        before = service.position_fees(8453, [(4, 41)])
        self.assertEqual((before['follower']['reason'], before['positions'][0]['status']),
                         ('fees_not_followed', 'not_followed'))
        self.follow()
        self.known(4, 55, FLOOR + 400)  # the index knows it; the follower joins it next pass
        body = service.position_fees(8453, [(4, 41), (3, 31), (4, 55), (4, 999)])
        self.assertEqual(body['follower']['status'], 'current')
        v4, v3, joining, unknown = body['positions']
        self.assertEqual([p['status'] for p in body['positions']], ['following', 'following', 'reading', 'not_followed'])
        self.assertEqual((v4['exact'], v4['why'], v4['since']['kind'], v4['since']['block']['number']),
                         (True, None, 'mint', FLOOR + 10))
        self.assertEqual(tuple(int(v) for v in v4['now']['earned']), self.chain.earned((4, 41), FLOOR + 400))
        self.assertEqual(tuple(int(v) for v in v3['now']['earned']), self.chain.earned((3, 31), FLOOR + 400))
        self.assertEqual([(e['block']['number'], e['fees']) for e in v4['events']],
                         [(FLOOR + 10, ['0', '0']), (FLOOR + 60, ['300', '70']), (FLOOR + 120, ['50', '0'])])
        self.assertEqual([t['toAddress'] for t in v4['transfers']], [OWNER])
        self.assertTrue(v4['points'] and all(int(p['earned'][0]) >= int(p['settled'][0]) for p in v4['points']))
        self.assertEqual((v4['freshness']['status'], v4['through']['number']), ('fresh', FLOOR + 400))
        self.assertEqual((joining['through'], joining['why']), (None, 'reading'))
        self.assertEqual(unknown['events'], [])

    def test_the_read_api_says_how_far_the_follower_is(self):
        from unittest import mock
        from v2_index_store import V2Store
        from v2_read_service import V2ReadService
        self.journey()
        self.follow()
        service = V2ReadService(V2Store({'host': str(SOCKET), 'port': PORT, 'dbname': DB}),
                                clock=lambda: self.clock[0] + 30)
        c = self.chain
        c.head = FLOOR + 600
        self.checkpoint(FLOOR + 450, FLOOR + 600)
        # Moved past its last "now" without reaching the index: reading back, every position reading.
        self.follower().step(through=FLOOR + 450)
        body = service.position_fees(8453, [(4, 41), (3, 31)])
        self.assertEqual((body['follower']['status'], body['follower']['reason']), ('stale', 'reading_back'))
        self.assertEqual([p['status'] for p in body['positions']], ['reading', 'reading'])
        # Caught up, then the index moves on more than 120 s of chain time while the follower does not.
        self.follow()
        c.head = FLOOR + 610
        self.checkpoint(FLOOR + 610)
        body = service.position_fees(8453, [(4, 41)])
        self.assertEqual((body['follower']['reason'], body['follower']['lagSeconds']), ('behind_index', 600))
        # Its last error, with when.
        with admin() as conn:
            conn.execute("UPDATE domino_v2.fee_cursor SET last_error='rpc_error',last_error_at=%s", (self.clock[0],))
        self.assertEqual(service.position_fees(8453, [(4, 41)])['follower']['lastError'],
                         {'code': 'rpc_error', 'at': self.clock[0]})
        # An answer keeps each position's newest events, and says it cut the older ones.
        with mock.patch('v2_read_service.MAX_FEE_EVENTS', 2):
            v4, = service.position_fees(8453, [(4, 41)])['positions']
        self.assertEqual(([e['block']['number'] for e in v4['events']], v4['truncated']),
                         ([FLOOR + 60, FLOOR + 120], True))

    def test_the_read_api_says_why_a_history_is_not_exact(self):
        from v2_index_store import V2Store
        from v2_read_service import V2ReadService
        c = self.chain
        c.mint(4, 41, FLOOR + 10, owner=OWNER, liquidity=10)
        c.settle((4, 41), FLOOR + 40, 5, tx='a')
        c.settle((4, 41), FLOOR + 40, 0, tx='b')
        self.known(4, 41, FLOOR + 10)
        self.checkpoint(FLOOR + 400)
        self.follow()
        service = V2ReadService(V2Store({'host': str(SOCKET), 'port': PORT, 'dbname': DB}),
                                clock=lambda: self.clock[0])
        v4, = service.position_fees(8453, [(4, 41)])['positions']
        self.assertEqual((v4['status'], v4['exact'], v4['why'], v4['now']['earned']),
                         ('following', False, 'same_block', None))


class LogTests(unittest.TestCase):
    """Strict decoding of the positions' own events, and the arithmetic, without a database."""

    def setUp(self):
        self.chain = FeeChain(CHAIN, head=10)
        c = self.chain
        self.v4 = c.mint(4, 41, 1, owner=OWNER, liquidity=10)
        self.v3 = c.mint(3, 31, 2, owner=OWNER, liquidity=10)
        from v2_fees import FeePosition
        self.followed = {(4, 41): FeePosition(4, 41, {}, self.v4['pool_key'], -600, 600, 'following', None, None),
                         (3, 31): FeePosition(3, 31, {}, self.v3['pool_key'], -600, 600, 'following', None, None)}

    def raw(self, index):
        number, _, raw = self.chain.logs[index]
        return dict(raw, blockHash=self.chain.hash(number))

    def test_the_topics_are_uniswap_s(self):
        self.assertEqual(INCREASE, '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f')
        self.assertEqual(DECREASE, '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4')
        self.assertEqual(COLLECT, '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01')
        self.assertEqual(TRANSFER, '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef')
        self.assertEqual(MODIFY_LIQUIDITY, '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec')

    def test_each_event_decodes_to_its_position(self):
        decoded = [decode_fee_log(CHAIN, self.raw(i), self.followed) for i in range(len(self.chain.logs))]
        self.assertEqual([(log.key, log.kind, log.delta) for log in decoded],
                         [((4, 41), 'transfer', 0), ((4, 41), 'modify', 10), ((3, 31), 'transfer', 0),
                          ((3, 31), 'increase', 10)])
        self.assertEqual((decoded[0].sender, decoded[0].recipient), (ZERO, OWNER))
        self.assertEqual(decoded[3].amounts, (1000, 2000))

    def test_another_position_s_event_is_skipped_and_a_malformed_one_refused(self):
        self.assertIsNone(decode_fee_log(CHAIN, self.raw(1), {(3, 31): self.followed[(3, 31)]}))
        self.assertIsNone(decode_fee_log(CHAIN, self.raw(3), {(4, 41): self.followed[(4, 41)]}))
        for change, code in (
                (lambda r: r.update(removed=True), 'v2_fee_log_invalid'),
                (lambda r: r.update(data=r['data'] + '00'), 'v2_fee_log_invalid'),
                (lambda r: r.update(topics=r['topics'][:-1]), 'v2_fee_log_invalid'),
                (lambda r: r.update(address='0x' + '99' * 20), 'v2_fee_log_unexpected'),
                (lambda r: r.update(blockHash='0x12'), 'v2_fee_log_invalid')):
            raw = self.raw(3)
            change(raw)
            with self.assertRaisesRegex(DataError, code):
                decode_fee_log(CHAIN, raw, self.followed)
        moved = self.raw(1)
        moved['topics'] = [moved['topics'][0], '0x' + '77' * 32, moved['topics'][2]]
        with self.assertRaisesRegex(DataError, 'v2_fee_event_mismatch'):
            decode_fee_log(CHAIN, moved, self.followed)
        for change in (lambda r: r.update(data='0xzz'), lambda r: r['topics'].__setitem__(1, '0x1234')):
            raw = self.raw(3)
            change(raw)
            with self.assertRaisesRegex(DataError, 'v2_fee_log_invalid'):
                decode_fee_log(CHAIN, raw, self.followed)
        loaded = self.raw(0)
        loaded['data'] = '0x' + '00' * 32
        with self.assertRaisesRegex(DataError, 'v2_fee_log_invalid'):
            decode_fee_log(CHAIN, loaded, self.followed)
        sender = self.raw(1)
        sender['topics'] = sender['topics'][:2] + ['0x' + '00' * 12 + '55' * 20]
        with self.assertRaisesRegex(DataError, 'v2_fee_log_invalid'):
            decode_fee_log(CHAIN, sender, self.followed)
        dirty = self.raw(0)
        dirty['topics'] = [dirty['topics'][0], '0x' + '01' * 12 + dirty['topics'][1][26:], *dirty['topics'][2:]]
        with self.assertRaisesRegex(DataError, 'v2_fee_log_invalid'):
            decode_fee_log(CHAIN, dirty, self.followed)

    def test_v3_fees_are_cut_to_128_bits_and_v4_s_are_not(self):
        before, after = (2**256 - G, 0), (G, 0)  # the growth wrapped
        self.assertEqual(growth_fees(4, 3, before, after), (6, 0))
        self.assertEqual(growth_fees(3, 2**130, (0, 0), (G, 0)), ((2**130) & (2**128 - 1), 0))
        self.assertEqual(growth_fees(4, 2**130, (0, 0), (G, 0)), (2**130, 0))

    def test_settle_needs_the_liquidity_to_add_up_and_on_v4_no_change_before_the_last_log(self):
        log = lambda delta, kind='modify', amounts=(0, 0): FeeLog((4, 1), kind, 1, '0x', 0, '0x', delta, amounts)  # noqa: E731
        before = Running(10, (0, 0), None, (5, 5))
        self.assertEqual(settle(4, before, [log(0)], (10, (G, 0), None))[:2], ((10, 0), None))
        self.assertEqual(settle(4, before, [log(0), log(3)], (13, (G, 0), None))[:2], ((10, 0), None))
        self.assertEqual(settle(4, before, [log(3), log(0)], (13, (G, 0), None))[:2], (None, 'same_block'))
        self.assertEqual(settle(4, before, [log(3)], (12, (G, 0), None))[:2], (None, 'liquidity'))
        self.assertEqual(settle(4, before, [log(0)], (10, (G, 0), None))[2].settled, (15, 5))
        with self.assertRaisesRegex(DataError, 'v2_fee_position_unreadable'):
            settle(4, before, [log(0)], None)
        v3 = Running(10, (0, 0), (7, 0), (0, 0))
        decrease = log(-10, 'decrease', (100, 0))
        collect = log(0, 'collect', (127, 0))
        # Burned in the block: tokensOwed 0 then, 7 + 20 fees + 100 principal were collected.
        fees, why, state = settle(3, v3, [decrease, collect], None)
        self.assertEqual((fees, why, state.liquidity, state.owed), ((20, 0), None, 0, (0, 0)))
        # tokensOwed and the growth disagree: something settled unseen.
        self.assertEqual(settle(3, v3, [log(0, 'collect', (0, 0))], (10, (2 * G, 0), (17, 0)))[:2],
                         (None, 'liquidity'))
        self.assertEqual(settle(3, v3, [log(0, 'collect', (0, 0))], (10, (G, 0), (17, 0)))[:2], ((10, 0), None))
        inexact = Running(10, (0, 0), None, None)
        self.assertIsNone(settle(4, inexact, [log(0)], (10, (G, 0), None))[2].settled)
        # Collected, then all of it removed for nothing and burned, in one block: tokensOwed accounts, the growth
        # product cannot (the checkpoint is gone with the token).
        collected = Running(10, (0, 0), (0, 0), (0, 0))
        fees, why, _ = settle(3, collected, [log(0, 'collect', (30, 0)), log(-10, 'decrease', (0, 0))], None)
        self.assertEqual((fees, why), ((30, 0), None))

    def test_hours_and_their_blocks(self):
        from v2_fees import hours_between, point_block
        from discovery import Block
        self.assertEqual(hours_between(DAY - 1, DAY + 2 * HOUR, DAY + HOUR),
                         [(DAY, 'day'), (DAY + HOUR, 'hour'), (DAY + 2 * HOUR, 'hour')])
        self.assertEqual(hours_between(0, DAY - 1, DAY), [])
        before, end = Block(100, '0x', 0), Block(200, '0x', 10_000)
        self.assertEqual(point_block(before, end, 3600), 136)
        self.assertEqual(point_block(before, Block(101, '0x', 600), 300), 101)
        self.assertEqual(point_block(before, end, 1), 101)
        # A short range (a caught-up pass) measures at its end; a point never leaves its range.
        self.assertEqual(point_block(Block(100, '0x', 0), Block(110, '0x', 500), 60), 110)
        self.assertEqual(point_block(before, end, 20_000), 200)
        self.assertEqual(point_block(before, end, 0), 101)

    def test_the_follower_s_settings_and_its_lock_are_bounded(self):
        from v2_fees import lock_key, LOCK_NAMESPACE
        endpoint = Endpoint('chainstack', 'chain.invalid', 'https://chain.invalid/', None, 100, 500, None)
        endpoints = ChainEndpoints(CHAIN, (endpoint,), 'test', send=self.chain)
        for options in ({'span': 999}, {'span': 500_001}, {'max_requests': 31}, {'span': '50000'}):
            with self.subTest(options=options), self.assertRaisesRegex(DataError, 'invalid_v2_fees_config'):
                V2FeeFollower(None, CHAIN, endpoints, **options)
        from v2_chains import default_registry
        with self.assertRaisesRegex(DataError, 'v2_rpc_chain_mismatch'):
            V2FeeFollower(None, default_registry().chain('arbitrum-42161'), endpoints)
        with self.assertRaisesRegex(DataError, 'invalid_v2_fees_bounds'):
            V2FeeFollower(None, CHAIN, endpoints).step(through='1')
        self.assertEqual(lock_key(8453), LOCK_NAMESPACE | 8453)
        for bad in (0, 1 << 40, '8453'):
            with self.subTest(chain=bad), self.assertRaisesRegex(DataError, 'invalid_v2_chain_id'):
                lock_key(bad)

    def test_a_multicall_answer_is_read_whole_or_refused(self):
        from eth_abi import encode
        from v2_abi import function
        from v2_fees import StateReader
        from v2_rpc import CodeCache
        from discovery import Block
        code = CodeCache()
        for contract in (CHAIN.multicall3, CHAIN.uniswap.v3.positionManager, CHAIN.uniswap.v3.factory,
                         CHAIN.uniswap.v4.positionManager, CHAIN.uniswap.v4.stateView):
            code.record(contract, CHAIN.verified_codehash(contract), 0)

        class Rpc:
            code_cache = code

            def __init__(self, answer):
                self.answer = answer

            def request(self, method, params):
                return self.answer
        owner = function('IV4PositionManagerMinimal', 'ownerOf')
        calls = [(CHAIN.uniswap.v4.positionManager, owner, (1,)), (CHAIN.uniswap.v4.positionManager, owner, (2,))]
        block = Block(5, '0x' + '11' * 32, 1)
        rows = [(True, encode(['address'], [OWNER])), (True, b'')]
        reader = StateReader(CHAIN, Rpc('0x' + encode(['(bool,bytes)[]'], [rows]).hex()))
        self.assertEqual(reader.aggregate(block, calls), [(OWNER,), None])  # no code there: no answer
        whole = encode(['(bool,bytes)[]'], [rows]).hex()
        for answer in ('0xzz', '0x' + encode(['(bool,bytes)[]'], [rows[:1]]).hex(), 'ff' + whole, None):
            with self.subTest(answer=str(answer)[:12]), self.assertRaisesRegex(DataError, 'v2_fee_multicall_invalid'):
                StateReader(CHAIN, Rpc(answer)).aggregate(block, calls)
