"""The revenue ledger (points, season 1) over a real PostgreSQL and the V2 index's own rows.

The index's rows the ledger reads (the deployment and its manifest's operator, checkpoints, FeeCharged and
OperatorSet logs, transactions, token decimals) are written as the indexer writes them; the store is the real
migrations 052 and 058 with the real writer and reader roles; prices come from a fake with read-v6's answers
(a value and its source, or no value and the reason, or a failed read). Each test states the fees and checks
what the ledger recorded: the value of each kind at its checkpoint, gas shared by value, net never below
zero, an unpriced token, a failed read never recorded, a late fee valued at the newest checkpoint, a fee
waiting for its transaction, the registry's operators, a reorganization, the limits of one pass, and totals.
"""
from decimal import Decimal
from fractions import Fraction
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

import psycopg
from psycopg import sql

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from discovery import ZERO, Block, DataError  # noqa: E402
from dev_postgres import ADMIN, PORT, SOCKET  # noqa: E402
import points_ledger  # noqa: E402
from points_ledger import (LATE_SECONDS, LedgerStore, Priced, RevenueLedger, SurveyPricer, decode_fee,  # noqa: E402
                           status, totals, usd_text, value_fees, Fee)
from v2_fixtures import documents, write_registry  # noqa: E402

DB = 'domino_points_ledger_tests'
MIGRATIONS = [Path(__file__).resolve().parents[1] / f'migrations/{name}.sql'
              for name in ('052_v2_index', '058_points_ledger')]
CHAIN_ID, FLOOR, T0 = 8453, 1000, 1_762_000_000
OPERATOR, SECOND_OPERATOR = '0x' + '0e' * 20, '0x' + '0f' * 20
USER, OTHER = '0x' + 'b1' * 20, '0x' + 'b2' * 20
STABLE, ALT = '0x' + '5a' * 20, '0x' + 'a1' * 20
ZONE = '0x' + '7a' * 20
REF = '0x' + 'cd' * 32


def block_hash(number, fork=''):
    return '0x' + (f'{fork}{number:x}').rjust(64, '0')


def timestamp(number):
    return T0 + 2 * number


def tx(n):
    return '0x' + f'{n:064x}'


def admin():
    return psycopg.connect(host=str(SOCKET), port=PORT, dbname=DB, user=ADMIN, autocommit=True)


def usd(text):
    return Decimal(text).quantize(Decimal(1).scaleb(-18))


class FakePricer:
    """read-v6's answers per token, optionally per block: a Priced, a reason, or a failed read (DataError)."""

    def __init__(self, prices, *, at=None, failing=()):
        self.prices_by_token, self.at, self.failing, self.calls = dict(prices), dict(at or {}), set(failing), []

    def prices(self, block, tokens):
        self.calls.append((block.number, dict(tokens)))
        if block.number in self.failing:
            raise DataError('v2_rpc_failed')
        out = {}
        for token, decimals in tokens.items():
            answer = self.at.get((block.number, token), self.prices_by_token.get(token, 'no_pool'))
            if isinstance(answer, str):
                out[token] = Priced(None, None, answer, decimals)
            else:
                usd_value, source = answer
                out[token] = Priced(Fraction(usd_value), source, None, decimals)
        return out


PRICES = {STABLE: ('1', 'chain_stable'), ALT: ('0.5', 'pool'), ZERO: ('3000', 'chainlink_eth_usd')}


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'isolated PostgreSQL required')
class RevenueLedgerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with psycopg.connect(host=str(SOCKET), port=PORT, dbname='postgres', user=ADMIN, autocommit=True) as conn:
            if not conn.execute('SELECT 1 FROM pg_database WHERE datname=%s', (DB,)).fetchone():
                conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(DB)))
        with admin() as conn:
            conn.execute('DROP SCHEMA IF EXISTS domino_points CASCADE')
            conn.execute('DROP SCHEMA IF EXISTS domino_v2 CASCADE')
            for migration in MIGRATIONS:
                conn.execute(migration.read_text())
            # Applying 058 again changes nothing (the installers re-run migrations).
            conn.execute(MIGRATIONS[1].read_text())

    def setUp(self):
        with admin() as conn:
            # Token metadata is not the deployment's (no foreign key): it goes on its own.
            conn.execute('TRUNCATE domino_v2.deployments, domino_v2.tokens CASCADE')
            conn.execute('''INSERT INTO domino_v2.deployments(chain_id,manifest_sha256,manifest,start_block,base_hash,
              next_block) VALUES(%s,%s,%s,%s,%s,%s)''',
                         (CHAIN_ID, 'a' * 64, json.dumps({'roles': {'operator': OPERATOR.upper().replace('0X', '0x')}}),
                          FLOOR, block_hash(FLOOR - 1), FLOOR))
        self.store = LedgerStore({'host': str(SOCKET), 'port': PORT, 'dbname': DB})
        self.clock = [timestamp(1100)]
        self.pricer = FakePricer(PRICES)

    def ledger(self, pricer=None, **options):
        return RevenueLedger(self.store, CHAIN_ID, pricer or self.pricer, clock=lambda: self.clock[0], **options)

    # -- the index's rows, as the indexer writes them
    def checkpoint(self, *numbers, fork=''):
        with admin() as conn:
            for number in numbers:
                conn.execute('''INSERT INTO domino_v2.checkpoints(chain_id,start_block,end_block,end_hash,end_timestamp,
                  events) VALUES(%s,%s,%s,%s,%s,0)''', (CHAIN_ID, number, number, block_hash(number, fork),
                                                        timestamp(number)))

    def fee(self, block, log_index, tx_number, kind, token, amount, payer=USER, fork=''):
        args = {'kind': str(kind), 'token': token, 'payer': payer, 'amount': str(amount), 'ref': REF}
        emitter = {1: 'zap', 2: 'vault', 3: 'auto_exit'}[kind]
        with admin() as conn:
            conn.execute('''INSERT INTO domino_v2.logs(chain_id,block_number,log_index,block_hash,block_timestamp,
              tx_hash,tx_index,address,emitter,event,args,owner,ref) VALUES(%s,%s,%s,%s,%s,%s,0,%s,%s,'FeeCharged',
              %s,%s,%s)''', (CHAIN_ID, block, log_index, block_hash(block, fork), timestamp(block), tx(tx_number),
                             ZONE, emitter, json.dumps(args), payer, REF))

    def operator_set(self, block, operator, allowed=True):
        with admin() as conn:
            conn.execute('''INSERT INTO domino_v2.logs(chain_id,block_number,log_index,block_hash,block_timestamp,
              tx_hash,tx_index,address,emitter,event,args) VALUES(%s,%s,0,%s,%s,%s,0,%s,'registry','OperatorSet',%s)''',
                         (CHAIN_ID, block, block_hash(block), timestamp(block), tx(10_000 + block), ZONE,
                          json.dumps({'operator': operator, 'allowed': allowed})))

    def transaction(self, tx_number, block, sender, gas_used=100_000, price=10 ** 9, l1_fee=None):
        with admin() as conn:
            conn.execute('''INSERT INTO domino_v2.transactions(chain_id,tx_hash,block_number,block_hash,sender,status,
              gas_used,effective_gas_price,l1_fee) VALUES(%s,%s,%s,%s,%s,1,%s,%s,%s)''',
                         (CHAIN_ID, tx(tx_number), block, block_hash(block), sender, gas_used, price, l1_fee))

    def token(self, address, decimals):
        with admin() as conn:
            conn.execute('''INSERT INTO domino_v2.tokens(chain_id,address,decimals,symbol,status,block_number)
              VALUES(%s,%s,%s,'T','available',%s)''', (CHAIN_ID, address, decimals, FLOOR))

    def rows(self):
        with admin() as conn:
            conn.row_factory = psycopg.rows.dict_row
            return conn.execute('''SELECT * FROM domino_points.revenue WHERE chain_id=%s
              ORDER BY block_number,log_index''', (CHAIN_ID,)).fetchall()

    def cursor(self):
        with admin() as conn:
            conn.row_factory = psycopg.rows.dict_row
            return conn.execute('SELECT * FROM domino_points.ledger_cursor WHERE chain_id=%s', (CHAIN_ID,)).fetchone()

    def run_ledger(self, ledger=None, rounds=10):
        ledger = ledger or self.ledger()
        results = []
        for _ in range(rounds):
            result = ledger.step()
            results.append(result)
            if result['status'] == 'caught_up_to_target':
                break
        return results

    def three_kinds(self):
        """An assisted swap the user sent; an automation in two tokens and an Auto-exit the operator sent."""
        self.token(STABLE, 6)
        self.token(ALT, 18)
        self.fee(1010, 3, 1, 1, STABLE, 650_000)
        self.transaction(1, 1010, USER)
        self.fee(1020, 1, 2, 2, STABLE, 2_000_000)
        self.fee(1020, 2, 2, 2, ALT, 10 ** 18)
        self.transaction(2, 1020, OPERATOR)  # 100,000 gas at 1 gwei: 0.0001 ETH, US$0.30
        self.fee(1030, 0, 3, 3, ALT, 10 ** 17)
        self.transaction(3, 1030, OPERATOR)
        self.checkpoint(1015, 1025, 1035)

    # -- the tests
    def test_each_kind_valued_at_its_checkpoint_less_the_operators_gas(self):
        self.three_kinds()
        self.pricer = FakePricer(PRICES, at={(1035, ALT): 'pool_depth_below_floor'})
        results = self.run_ledger()
        self.assertEqual(results[0]['status'], 'indexed')
        self.assertEqual((results[0]['through'], results[0]['fees'], results[0]['late']), (1035, 4, 0))
        rows = self.rows()
        swap, auto_stable, auto_alt, exit_ = rows
        # The user sent the swap: Domino paid no gas.
        self.assertEqual((swap['kind'], swap['payer'], swap['price_block'], swap['price_late']), (1, USER, 1015, False))
        self.assertEqual((swap['gross_usd'], swap['gas_usd'], swap['net_usd'], swap['tx_gas_wei']),
                         (usd('0.65'), usd('0'), usd('0.65'), None))
        self.assertEqual((swap['token_usd'], swap['price_source'], swap['price_reason'], swap['decimals']),
                         (usd('1'), 'chain_stable', None, 6))
        # US$0.30 of gas shared by value: 2.00 and 0.50 of fees take 0.24 and 0.06.
        self.assertEqual((auto_stable['gross_usd'], auto_stable['gas_usd'], auto_stable['net_usd']),
                         (usd('2'), usd('0.24'), usd('1.76')))
        self.assertEqual((auto_alt['gross_usd'], auto_alt['gas_usd'], auto_alt['net_usd'], auto_alt['price_source']),
                         (usd('0.5'), usd('0.06'), usd('0.44'), 'pool'))
        self.assertEqual(auto_stable['tx_gas_wei'], 10 ** 14)
        # A token with no qualified pool has no value, and says why; its gas never takes the net below zero.
        self.assertEqual((exit_['token_usd'], exit_['price_source'], exit_['price_reason']),
                         (None, None, 'pool_depth_below_floor'))
        self.assertEqual((exit_['gross_usd'], exit_['gas_usd'], exit_['net_usd']), (usd('0'), usd('0.3'), usd('0')))
        # One survey per checkpoint holding fees; the native currency only where the operator paid gas.
        self.assertEqual(self.pricer.calls, [(1015, {STABLE: 6}), (1025, {STABLE: 6, ALT: 18, ZERO: 18}),
                                             (1035, {ALT: 18, ZERO: 18})])
        cursor = self.cursor()
        self.assertEqual((cursor['block_number'], cursor['caught_up'], cursor['last_error']), (1035, True, None))
        self.assertEqual(self.run_ledger()[0]['status'], 'caught_up_to_target')

    def test_a_failed_fresh_read_is_never_recorded(self):
        self.three_kinds()
        for pricer in (FakePricer(PRICES, failing={1025}), FakePricer(PRICES, at={(1025, ALT): 'price_read_failed'})):
            with self.subTest(pricer=pricer.failing or pricer.at):
                with self.assertRaises(DataError) as raised:
                    self.ledger(pricer).step()
                self.assertEqual(str(raised.exception), 'points_price_read_failed')
                self.assertEqual(self.rows(), [])
                cursor = self.cursor()
                self.assertEqual((cursor['block_number'], cursor['last_error']), (FLOOR - 1, 'points_price_read_failed'))
        self.ledger().step()
        self.assertEqual(len(self.rows()), 4)
        self.assertIsNone(self.cursor()['last_error'])

    def test_a_late_fee_is_valued_at_the_newest_checkpoint_without_a_historical_read(self):
        self.three_kinds()
        self.checkpoint(1200)
        self.clock = [timestamp(1025) + LATE_SECONDS + 1]  # 1015 and 1025 are late, 1035 is not
        pricer = FakePricer(PRICES, at={(1200, ALT): ('0.4', 'pool')})
        result = self.ledger(pricer, span=1_000).step()
        self.assertEqual(result['late'], 3)
        rows = self.rows()
        self.assertEqual([(r['price_block'], r['price_late']) for r in rows],
                         [(1200, True), (1200, True), (1200, True), (1035, False)])
        self.assertEqual(rows[2]['token_usd'], usd('0.4'))
        # No read at a late checkpoint's block: the archive provider is never asked for it.
        self.assertEqual(sorted(block for block, _ in pricer.calls), [1035, 1200])
        # A fresh checkpoint that fails is not valued at the newest: the pass stops instead.
        with admin() as conn:
            conn.execute('TRUNCATE domino_points.revenue, domino_points.ledger_cursor')
        self.clock = [timestamp(1035) + 60]
        with self.assertRaises(DataError):
            self.ledger(FakePricer(PRICES, failing={1035})).step()
        self.assertEqual(self.rows(), [])

    def test_gas_without_a_native_price_leaves_no_net(self):
        self.three_kinds()
        self.pricer = FakePricer(PRICES, at={(1025, ZERO): 'sequencer_down'})
        self.run_ledger()
        rows = self.rows()
        self.assertEqual([(r['gas_reason'], r['net_usd']) for r in rows[1:3]],
                         [('sequencer_down', usd('0')), ('sequencer_down', usd('0'))])
        self.assertEqual(rows[0]['net_usd'], usd('0.65'))

    def test_registry_operators_count_and_other_senders_do_not(self):
        self.token(STABLE, 6)
        self.operator_set(1005, SECOND_OPERATOR)
        self.operator_set(1006, OTHER, allowed=False)
        for n, sender in ((1, SECOND_OPERATOR), (2, OTHER), (3, OPERATOR)):
            self.fee(1010 + n, 0, n, 2, STABLE, 1_000_000)
            self.transaction(n, 1010 + n, sender)
        self.checkpoint(1020)
        self.run_ledger()
        self.assertEqual([r['gas_usd'] for r in self.rows()], [usd('0.3'), usd('0'), usd('0.3')])
        self.assertEqual([r['tx_gas_wei'] for r in self.rows()], [10 ** 14, None, 10 ** 14])

    def test_a_deployment_without_an_operator_is_refused(self):
        with admin() as conn:
            conn.execute("UPDATE domino_v2.deployments SET manifest='{\"roles\": {}}' WHERE chain_id=%s", (CHAIN_ID,))
        self.three_kinds()
        with self.assertRaises(DataError) as raised:
            self.ledger().step()
        self.assertEqual(str(raised.exception), 'points_operator_unknown')
        self.assertEqual(self.rows(), [])

    def test_l1_fee_counts_in_the_operators_gas(self):
        self.token(STABLE, 6)
        self.fee(1010, 0, 1, 2, STABLE, 1_000_000)
        self.transaction(1, 1010, OPERATOR, l1_fee=10 ** 14)
        self.checkpoint(1020)
        self.run_ledger()
        row = self.rows()[0]
        self.assertEqual((row['tx_gas_wei'], row['gas_usd'], row['net_usd']), (2 * 10 ** 14, usd('0.6'), usd('0.4')))

    def test_a_fee_waits_for_its_transaction(self):
        self.token(STABLE, 6)
        self.fee(1010, 0, 1, 1, STABLE, 650_000)
        self.transaction(1, 1010, USER)
        self.fee(1030, 0, 2, 1, STABLE, 650_000)
        self.checkpoint(1015, 1035)
        results = self.run_ledger()
        self.assertEqual([r['status'] for r in results], ['indexed', 'caught_up_to_target'])
        self.assertEqual(results[0]['through'], 1015)
        self.assertEqual((results[1]['through'], results[1]['waitingFor']), (1015, tx(2)))
        self.assertEqual(len(self.rows()), 1)
        self.transaction(2, 1030, USER)
        self.run_ledger()
        self.assertEqual(len(self.rows()), 2)
        self.assertEqual(self.cursor()['block_number'], 1035)

    def test_a_reorganization_removes_what_it_voided(self):
        self.three_kinds()
        self.run_ledger()
        self.assertEqual(len(self.rows()), 4)
        # The index rewinds past 1025 and indexes another branch from 1016.
        with admin() as conn:
            conn.execute('DELETE FROM domino_v2.checkpoints WHERE chain_id=%s AND end_block>1015', (CHAIN_ID,))
            conn.execute('DELETE FROM domino_v2.logs WHERE chain_id=%s AND block_number>1015', (CHAIN_ID,))
            conn.execute('DELETE FROM domino_v2.transactions WHERE chain_id=%s AND block_number>1015', (CHAIN_ID,))
        results = self.run_ledger()
        self.assertEqual(results[0], {'status': 'rewound', 'through': 1015})
        self.assertEqual([r['block_number'] for r in self.rows()], [1010])
        self.fee(1022, 0, 7, 1, STABLE, 1_300_000, fork='f')
        self.transaction(7, 1022, USER)
        self.checkpoint(1030, fork='f')
        self.run_ledger()
        self.assertEqual([(r['block_number'], r['net_usd']) for r in self.rows()], [(1010, usd('0.65')),
                                                                                    (1022, usd('1.3'))])
        # A rewind past every checkpoint goes back to the deployment's base.
        with admin() as conn:
            conn.execute('DELETE FROM domino_v2.checkpoints WHERE chain_id=%s', (CHAIN_ID,))
        self.assertEqual(self.ledger().step(), {'status': 'rewound', 'through': FLOOR - 1})
        self.assertEqual(self.rows(), [])

    def test_a_commit_refuses_a_checkpoint_rewound_during_the_pass(self):
        self.three_kinds()
        outer = self

        class Rewinding(FakePricer):
            def prices(self, block, tokens):
                with admin() as conn:  # the index rewinds while the pass values its fees
                    conn.execute('DELETE FROM domino_v2.checkpoints WHERE chain_id=%s AND end_block=1035', (CHAIN_ID,))
                return super().prices(block, tokens)
        with self.assertRaises(DataError) as raised:
            self.ledger(Rewinding(PRICES)).step()
        self.assertEqual(str(raised.exception), 'points_ledger_checkpoint_rewound')
        self.assertEqual(outer.rows(), [])

    def test_one_pass_stops_short_at_its_limits(self):
        self.three_kinds()
        with mock.patch.object(points_ledger, 'MAX_SURVEYS', 2):
            result = self.ledger().step()
        self.assertEqual((result['through'], result['fees'], result['caughtUp']), (1025, 3, False))
        with admin() as conn:
            conn.execute('TRUNCATE domino_points.revenue, domino_points.ledger_cursor')
        with mock.patch.object(points_ledger, 'MAX_FEES', 1):
            result = self.ledger().step()
        self.assertEqual((result['through'], result['fees']), (1015, 1))
        # The span bounds a pass's blocks, never below the first checkpoint above the cursor.
        with admin() as conn:
            conn.execute('TRUNCATE domino_points.revenue, domino_points.ledger_cursor')
        result = self.ledger(span=1_000).step(through=1020)
        self.assertEqual(result['through'], 1015)

    def test_the_follow_loop_takes_every_answer_of_a_pass(self):
        # The units run `follow`: it accepts only indexed, caught_up_to_target and rewound, and counts anything
        # else as a failed pass (7 Nov 2026: 'recorded' made every pass a failure in production).
        from followers import follow
        self.three_kinds()
        self.fee(1040, 0, 9, 1, STABLE, 650_000)  # its transaction is not stored yet: the pass waits
        self.checkpoint(1045)
        ledger = self.ledger()
        report = follow(lambda through: ledger.step(through=through), ledger.index_head, lag=0, max_passes=4,
                        poll_seconds=0, sleep=lambda seconds: None)
        self.assertEqual(report['failures'], [])
        self.assertEqual(report['lastResult']['waitingFor'], tx(9))
        self.assertEqual(len(self.rows()), 4)
        self.transaction(9, 1040, USER)
        report = follow(lambda through: ledger.step(through=through), ledger.index_head, lag=0, max_passes=4,
                        poll_seconds=0, sleep=lambda seconds: None)
        self.assertEqual(report['failures'], [])
        self.assertEqual((self.cursor()['block_number'], len(self.rows())), (1045, 5))
        with admin() as conn:  # the index rewinds past 1040 and moves on
            conn.execute('DELETE FROM domino_v2.checkpoints WHERE chain_id=%s AND end_block=1045', (CHAIN_ID,))
            conn.execute('DELETE FROM domino_v2.logs WHERE chain_id=%s AND block_number=1040', (CHAIN_ID,))
        self.checkpoint(1050)
        report = follow(lambda through: ledger.step(through=through), ledger.index_head, lag=0, max_passes=4,
                        poll_seconds=0, sleep=lambda seconds: None)
        self.assertEqual(report['failures'], [])
        self.assertEqual(len(report['rewinds']), 1)
        self.assertEqual((self.cursor()['block_number'], len(self.rows())), (1050, 4))

    def test_status_and_totals(self):
        self.three_kinds()
        self.pricer = FakePricer(PRICES, at={(1035, ALT): 'pool_depth_below_floor'})
        self.assertEqual(status(self.store, CHAIN_ID), {'chainId': CHAIN_ID, 'status': 'not_started'})
        self.run_ledger()
        report = status(self.store, CHAIN_ID)
        self.assertEqual({k: report[k] for k in ('through', 'caughtUp', 'indexThrough', 'fees', 'unpriced', 'late')},
                         {'through': 1035, 'caughtUp': True, 'indexThrough': 1035, 'fees': 4, 'unpriced': 1, 'late': 0})
        report = totals(self.store, timestamp(1000), timestamp(1031))
        by_kind = {row['kind']: row for row in report['rows']}
        self.assertEqual(by_kind['assisted_swap']['netUsd'], str(usd('0.65')))
        self.assertEqual((by_kind['automation']['fees'], by_kind['automation']['netUsd']), (2, str(usd('2.2'))))
        self.assertEqual((by_kind['auto_exit']['unpriced'], by_kind['auto_exit']['netUsd']), (1, str(usd('0'))))
        self.assertEqual(totals(self.store, timestamp(1000), timestamp(1015))['rows'][0]['fees'], 1)
        with self.assertRaises(DataError):
            totals(self.store, 10, 10)


class PureTests(unittest.TestCase):
    def test_usd_text_floors_exactly(self):
        self.assertEqual(usd_text(Fraction(2, 3)), Decimal('0.666666666666666666'))
        self.assertEqual(usd_text(Fraction(10 ** 40) + Fraction(1, 10 ** 19)), Decimal(10 ** 40))
        with self.assertRaises(DataError):
            usd_text(Fraction(-1, 10))

    def test_decode_fee_checks_every_argument(self):
        row = {'block_number': 5, 'log_index': 1, 'block_hash': block_hash(5), 'block_timestamp': 9, 'tx_hash': tx(1),
               'args': {'kind': '2', 'token': ALT.upper().replace('0X', '0x'), 'payer': USER, 'amount': '7',
                        'ref': REF}}
        fee = decode_fee(row)
        self.assertEqual((fee.kind, fee.token, fee.amount), (2, ALT, 7))
        for change in ({'kind': '4'}, {'kind': '0'}, {'amount': '-1'}, {'token': '0x12'}, {'payer': None},
                       {'ref': '0x' + 'cd' * 31}, {'amount': 'x'}):
            with self.subTest(change=change):
                with self.assertRaises(DataError):
                    decode_fee({**row, 'args': {**row['args'], **change}})

    def test_gas_is_shared_equally_when_no_fee_has_a_value(self):
        fees = [Fee(1, i, block_hash(1), 2, tx(1), 2, ALT, USER, 10, REF) for i in range(2)]
        priced = {f: Priced(None, None, 'no_pool', 18) for f in fees}
        priced.update({(f, ZERO): Priced(Fraction(2000), 'chainlink_eth_usd', None, 18) for f in fees})
        rows = value_fees(fees, priced, {tx(1): {'sender': OPERATOR, 'gas_used': 1, 'effective_gas_price': 10 ** 18,
                                               'l1_fee': None}}, {OPERATOR})
        self.assertEqual([(r['gas'], r['net']) for r in rows], [(Fraction(1000), 0), (Fraction(1000), 0)])


class SurveyPricerTests(unittest.TestCase):
    """The production pricer over read-v6's survey: base currencies need no pool, decimals come from the survey
    when the index has none, a price without decimals is no price, and a survey values at most SURVEY_TOKENS."""

    @classmethod
    def setUpClass(cls):
        cls.chain = write_registry(tempfile.mkdtemp(prefix='points-ledger-registry-'), documents()).chain('base-8453')

    def test_survey_reads(self):
        from v2_chain_reads import base_currencies, stable_of
        chain, stable = self.chain, stable_of(self.chain)[0]
        wrapped = chain.wrappedNative.address
        others = ['0x' + f'{n:02x}' * 20 for n in range(1, 15)]  # 14 tokens: two surveys
        surveys = []

        class Found:
            def __init__(self, subjects, metadata):
                self.metadata = {token: (8,) for token in metadata if token != others[0]}

            def price(self, token, decimals):
                if token == stable:
                    return {'usd': '1', 'source': 'chain_stable'}, None
                if token in (ZERO, wrapped):
                    return {'usd': '3000.5', 'source': 'chainlink_eth_usd'}, None
                if decimals is None:
                    return None, 'decimals_unknown'
                return {'usd': '0.25', 'source': 'pool'}, None

        def survey(chain_, rpc, block, refs, subjects, metadata=()):
            surveys.append((block.number, sorted(set(subjects.values())), sorted(metadata), rpc))
            return Found(subjects, metadata)

        class Endpoints:
            def read_rpc(self, *, anchor=None, max_requests=None):
                return ('rpc', anchor.number, max_requests)
        asked = {stable: None, wrapped: 18, ZERO: None, **{token: None for token in others}}
        with mock.patch('v2_chain_reads.survey', survey):
            out = SurveyPricer(chain, Endpoints()).prices(Block(77, block_hash(77), 9), asked)
        base = {entry[0] for entry in base_currencies(chain)}
        self.assertIn(stable, base)
        self.assertEqual(len(surveys), 2)
        # Pools only for tokens that are not base currencies; every survey anchored at the checkpoint.
        priced_by_pool = sorted(t for s in surveys for t in s[1])
        self.assertEqual(priced_by_pool, sorted(others))
        self.assertTrue(all(s[0] == 77 and s[3] == ('rpc', 77, points_ledger.PRICE_REQUESTS) for s in surveys))
        # Decimals asked of the survey for every token the index had none for, never for the native currency.
        self.assertEqual(sorted(t for s in surveys for t in s[2]), sorted([stable, *others]))
        self.assertEqual(out[stable], Priced(Fraction(1), 'chain_stable', None, 8))
        self.assertEqual(out[ZERO], Priced(Fraction('3000.5'), 'chainlink_eth_usd', None, 18))
        self.assertEqual(out[wrapped].decimals, 18)
        self.assertEqual(out[others[1]], Priced(Fraction(1, 4), 'pool', None, 8))
        # The survey could not read the first token's decimals: no value, whatever its pool says.
        self.assertEqual(out[others[0]], Priced(None, None, 'decimals_unknown', None))

    def test_a_stable_without_decimals_has_no_value(self):
        from v2_chain_reads import stable_of
        stable = stable_of(self.chain)[0]

        class Found:
            metadata = {}

            def price(self, token, decimals):
                return {'usd': '1', 'source': 'chain_stable'}, None

        class Endpoints:
            def read_rpc(self, **kwargs):
                return None
        with mock.patch('v2_chain_reads.survey', lambda *a, **k: Found()):
            out = SurveyPricer(self.chain, Endpoints()).prices(Block(1, block_hash(1), 1), {stable: None})
        self.assertEqual(out[stable], Priced(None, None, 'decimals_unknown', None))


if __name__ == '__main__':
    unittest.main()
