"""Synthetic feed and disposable PostgreSQL tests for the shared gas ceiling."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date, timedelta
import os
from pathlib import Path
import sys
import time
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from eth_abi import encode
from eth_account import Account
from eth_hash.auto import keccak
import psycopg
from psycopg.types.json import Jsonb

from chainlink_history import ETH_FEED
from gas_usd_budget import EthUsdReader, GasBudgetError, GasUsdBudget, GasBudgetService, QuotePolicy
from execution_pg import ExecutionPostgres
from publisher_signer import PublicationJournal


PHASE_ROUND = (1 << 64) + 17
ADDRESS = '0x' + 'ab' * 20
CYCLE_1 = '0x' + '11' * 32
CYCLE_2 = '0x' + '22' * 32


class FeedRpc:
    def __init__(self, now):
        self.now = now
        self.answer = 2000 * 10**8
        self.updated_at = now - 20
        self.aggregator = ETH_FEED.aggregator
        self.reorg = False
        self.pinned_reads = 0
        self.pinned_number = 998
        self.finalized_number = 998
        self.finalized_age = 5
        self.answers_by_block = {}

    @staticmethod
    def _hash(number):
        return '0x' + (number + 1).to_bytes(32, 'big').hex()

    def request(self, method, params):
        if method == 'eth_chainId':
            return hex(4663)
        if method == 'eth_getBlockByNumber':
            number = (1000 if params[0] == 'latest' else self.finalized_number
                      if params[0] == 'finalized' else int(params[0], 16))
            if number == self.pinned_number:
                self.pinned_reads += 1
            block_hash = ('0x' + 'ff' * 32 if self.reorg and number == self.pinned_number and
                          self.pinned_reads > 1 else self._hash(number))
            return {'number': hex(number), 'hash': block_hash,
                    'timestamp': hex(self.now - (0 if number == 1000 else
                                               self.finalized_age if number == self.finalized_number
                                               else 5))}
        if method == 'eth_getCode':
            self._pin(params[1])
            return '0x6001'
        if method == 'eth_call':
            call, block = params
            self._pin(block)
            self.assert_contract(call['to'])
            selector = bytes.fromhex(call['data'][2:10])
            for sig, types, values in (
                ('aggregator()', ('address',), (self.aggregator,)),
                ('phaseId()', ('uint16',), (1,)),
                ('phaseAggregators(uint16)', ('address',), (self.aggregator,)),
                ('decimals()', ('uint8',), (8,)),
                ('description()', ('string',), ('ETH / USD',)),
                ('latestRoundData()', ('uint80','int256','uint256','uint256','uint80'),
                 (PHASE_ROUND,self.answers_by_block.get(self.pinned_number, self.answer),
                  self.updated_at-1,self.updated_at,PHASE_ROUND)),
            ):
                if selector == keccak(sig.encode())[:4]:
                    return '0x' + encode(types, values).hex()
            raise AssertionError('unexpected feed function')
        raise AssertionError('unexpected RPC method')

    def _pin(self, block):
        assert block == {'blockHash': self._hash(self.pinned_number), 'requireCanonical': True}

    def assert_contract(self, address):
        assert address == ETH_FEED.proxy


class EthUsdReaderTests(unittest.TestCase):
    def setUp(self):
        self.now = int(time.time())
        self.rpc = FeedRpc(self.now)
        self.reader = EthUsdReader(self.rpc, clock=lambda: self.now)

    def test_qualified_quote_and_exact_integer_rounding(self):
        quote = self.reader.quote()
        self.assertEqual(quote.answer_raw, 2000 * 10**8)
        self.assertEqual(quote.block_number, 998)
        self.assertEqual(quote.usd_micros_for_wei(5 * 10**15, reserve_bps=12000), 12_000_000)
        self.assertEqual(quote.usd_micros_for_wei(1), 1)

    def test_stale_wrong_feed_and_reorg_fail_closed(self):
        # The feed's round stands until the price moves past its threshold or
        # its 24h heartbeat comes: a calm answer 7201 s old is current.
        for age in (5100, 7201, 90000):
            self.rpc.updated_at = self.now - age
            self.assertEqual(self.reader.quote().answer_updated_at, self.now - age)
        self.rpc.updated_at = self.now - 90001
        with self.assertRaisesRegex(GasBudgetError, 'gas_quote_answer_stale'):
            self.reader.quote()
        self.rpc.updated_at = self.now - 20
        self.rpc.aggregator = ADDRESS
        with self.assertRaisesRegex(GasBudgetError, 'gas_quote_feed_identity_changed'):
            self.reader.quote()
        self.rpc.aggregator = ETH_FEED.aggregator
        self.rpc.pinned_reads = 0
        self.rpc.reorg = True
        with self.assertRaisesRegex(GasBudgetError, 'gas_quote_reorganized'):
            self.reader.quote()

    def test_policy_cannot_outlast_the_database_ceiling(self):
        # 046 holds 90000 s in the database; a longer policy would only be refused there.
        self.assertEqual(QuotePolicy().max_answer_age_seconds, 90000)
        self.assertEqual(QuotePolicy(max_answer_age_seconds=7200).max_answer_age_seconds, 7200)
        with self.assertRaisesRegex(GasBudgetError, 'gas_quote_policy_invalid'):
            QuotePolicy(max_answer_age_seconds=90001)

    def test_round_without_positive_answer_is_unusable(self):
        self.rpc.answer = 0
        with self.assertRaisesRegex(GasBudgetError, 'gas_quote_round_invalid'):
            self.reader.quote()

    def test_finalized_mode_refuses_reorg_or_lagging_finality(self):
        self.rpc.finalized_number = 997
        self.rpc.pinned_number = 997
        self.rpc.answers_by_block = {997: 4000 * 10**8, 998: 1000 * 10**8}
        self.assertEqual(EthUsdReader(self.rpc, clock=lambda: self.now,
                                      finalized=True).quote().answer_raw, 4000 * 10**8)
        self.rpc.pinned_reads = 0
        self.rpc.reorg = True
        with self.assertRaisesRegex(GasBudgetError, 'gas_quote_reorganized'):
            EthUsdReader(self.rpc, clock=lambda: self.now, finalized=True).quote()
        self.rpc.reorg = False
        self.rpc.pinned_reads = 0
        self.rpc.updated_at = self.now - 1800
        self.rpc.finalized_age = 1800
        self.assertEqual(EthUsdReader(self.rpc, clock=lambda: self.now,
                                      finalized=True).quote().block_timestamp, self.now - 1800)
        self.rpc.finalized_age = 1801
        with self.assertRaisesRegex(GasBudgetError, 'gas_quote_block_stale'):
            EthUsdReader(self.rpc, clock=lambda: self.now, finalized=True).quote()


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'disposable PostgreSQL required')
class GasBudgetPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pg = ExecutionPostgres().start()
        cls.addClassCleanup(cls.pg.close)
        with cls.pg.admin() as conn:
            for name in ('019_execution_journal', '028_automation_cycle',
                         '032_shared_gas_budget', '033_gas_budget_claim_read',
                         '034_gas_settlement_sweep', '035_cancel_unsigned_gas_claims',
                         '036_gas_settlement_journal_read',
                         '037_gas_settlement_receipt_evidence',
                         '038_gas_settlement_quote_witness',
                         '040_gas_finalized_quote_lag',
                         '046_gas_answer_heartbeat'):
                conn.execute((Path(__file__).resolve().parents[1] / 'migrations' /
                              f'{name}.sql').read_text())
            conn.execute('ALTER ROLE domino_gas_budget_worker LOGIN')
            conn.execute('CREATE ROLE domino_gas_reservation_login LOGIN INHERIT')
            conn.execute('GRANT domino_gas_budget_worker TO domino_gas_reservation_login WITH INHERIT TRUE, SET FALSE')
            conn.execute('ALTER ROLE domino_gas_settlement_worker LOGIN')
            conn.execute('CREATE ROLE domino_gas_settlement_login LOGIN INHERIT')
            conn.execute('GRANT domino_gas_settlement_worker TO domino_gas_settlement_login WITH INHERIT TRUE, SET FALSE')
            conn.execute('ALTER ROLE domino_execution_signer LOGIN')
            conn.execute('ALTER ROLE domino_execution_publisher LOGIN')

    def setUp(self):
        with self.pg.admin() as conn:
            conn.execute('TRUNCATE domino_execution.intents,domino_execution.publications,'
                         'domino_execution.publication_finality_cursor,'
                         'domino_gas_budget.claims,'
                         'domino_gas_budget.days CASCADE')
        self.quote = EthUsdReader(FeedRpc(int(time.time()))).quote()

    def budget(self):
        return GasUsdBudget(psycopg.connect(**self.pg.settings, user='domino_gas_budget_worker'),
                            reader=EthUsdReader(FeedRpc(int(time.time()))))

    def settler(self):
        return GasUsdBudget(psycopg.connect(**self.pg.settings, user='domino_gas_settlement_worker'),
                            reader=EthUsdReader(FeedRpc(int(time.time()))))

    def attest(self, identifier, leg, *, answer=2000):
        rpc = FeedRpc(int(time.time()))
        rpc.answer = answer * 10**8
        return GasBudgetService(self.pg.settings, rpc).attest_settlement_quote(identifier, leg)

    def publication_witness(self, identifier, spent_wei, *, signer=ADDRESS,
                            max_wei=5*10**15, state='confirmed', finalized=True):
        gas = 25000
        self.assertEqual(spent_wei % gas, 0)
        self.assertEqual(max_wei % gas, 0)
        with self.pg.admin() as conn:
            conn.execute('INSERT INTO domino_execution.publications '
                '(observation_id,guard,pool_id,block_number,block_hash,block_timestamp,'
                'expires_at,sqrt_price,signer,nonce,envelope,signed_bytes,transaction_hash,state) '
                "VALUES(%s,%s,%s,1,%s,1,2,1,%s,%s,%s,%s,%s,'signed')",
                (identifier, signer, identifier, identifier, signer,
                 int(identifier[2:4], 16),
                 Jsonb({'gas': gas, 'maxFeePerGas': max_wei//gas}), b'journal-bytes', identifier))
            conn.execute("UPDATE domino_execution.publications SET state='submitted' WHERE observation_id=%s",
                         (identifier,))
            conn.execute('UPDATE domino_execution.publications SET state=%s,'
                'included_block_number=2,included_block_hash=%s,gas_used=%s,effective_gas_price=%s '
                'WHERE observation_id=%s', (state, identifier, gas, spent_wei//gas, identifier))
        if finalized:
            self.mark_publication_finality(identifier, spent_wei, signer=signer, state=state)

    def mark_publication_finality(self, identifier, spent_wei, *, signer=ADDRESS,
                                  state='confirmed'):
        with self.pg.admin() as conn:
            conn.execute('INSERT INTO domino_execution.publication_finality '
                '(observation_id,signer,transaction_hash,included_block_number,'
                'included_block_hash,finalized_head_number,finalized_head_hash,'
                'receipt_status,gas_used,effective_gas_price) '
                'VALUES(%s,%s,%s,2,%s,3,%s,%s,25000,%s)',
                (identifier, signer, identifier, identifier, CYCLE_2,
                 1 if state == 'confirmed' else 0, spent_wei//25000))

    def signed_publication(self, *, status):
        from test_gas_receipt_settlement import FinalizedRpc, GUARD, POINT
        from automation_plan import PRICE_OBSERVED, observation_id, publish_calldata
        account = Account.from_key(bytes.fromhex('34' * 32))
        signer = account.address.lower()
        identifier = observation_id(GUARD, POINT)
        envelope = {'chainId': 4663, 'nonce': 0, 'type': 2, 'to': GUARD,
            'value': 0, 'data': publish_calldata(POINT), 'gas': 100000,
            'maxFeePerGas': 1_000_000_000, 'maxPriorityFeePerGas': 1_000_000,
            'accessList': []}
        rpc = FinalizedRpc()
        raw, digest = rpc.add(account, envelope, status=status)
        if status:
            rpc.receipts[digest]['logs'] = [{'address': GUARD,
                'topics': [PRICE_OBSERVED, identifier, '0x' + '00' * 32]}]
        original = rpc.request
        def request(method, params):
            if method == 'eth_getBlockByNumber' and params[0] == 'latest':
                return {'number': '0x66', 'hash': '0x' + 'a3' * 32,
                        'timestamp': '0x72'}
            return original(method, params)
        rpc.request = request
        rpc.final['number'] = '0x63'
        with self.pg.admin() as conn:
            conn.execute('INSERT INTO domino_execution.publications '
                '(observation_id,guard,pool_id,block_number,block_hash,block_timestamp,'
                'expires_at,sqrt_price,signer,nonce,envelope,signed_bytes,transaction_hash,state) '
                "VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,0,%s,%s,%s,'signed')",
                (identifier, GUARD, '0x' + POINT[0].hex(), POINT[1],
                 '0x' + POINT[2].hex(), POINT[3], POINT[4], POINT[5], signer,
                 Jsonb(envelope), raw, digest))
            conn.execute("UPDATE domino_execution.publications SET state='submitted' "
                         'WHERE observation_id=%s', (identifier,))
        return identifier, signer, rpc, PublicationJournal(self.pg.settings)

    def operator_witness(self, identifier, spent_wei, *, reverted=False):
        gas = 25000
        tx_hash = '0x' + ('77' if reverted else '66') * 32
        block_hash = '0x' + '55' * 32
        owner = ADDRESS
        envelope = {'gas': gas, 'maxFeePerGas': 5*10**15//gas}
        with self.pg.admin() as conn:
            # Trusted fixture seeds the durable signer rows; the test then
            # attacks settlement strictly through its unprivileged LOGIN.
            conn.execute('SET LOCAL session_replication_role=replica')
            conn.execute('INSERT INTO domino_execution.intents '
                '(intent_id,owner,sequence_hash,chain_id,model_version,plan,observation,commitments) '
                'VALUES(%s,%s,%s,4663,%s,%s,%s,%s)',
                (identifier, owner, CYCLE_2, 'test', Jsonb({}), Jsonb({}), Jsonb({})))
            conn.execute('INSERT INTO domino_execution.journal '
                '(owner,intent_id,state,signer,nonce,action,admission,envelope) '
                'VALUES(%s,%s,%s,%s,0,%s,%s,%s)',
                (owner, identifier, 'reverted' if reverted else 'reconciled', owner,
                 'typed_fee_execution_v4', Jsonb({}), Jsonb(envelope)))
            conn.execute('INSERT INTO domino_execution.attempts '
                '(owner,intent_id,ordinal,envelope,transaction_hash,signed_bytes,fence) '
                'VALUES(%s,%s,0,%s,%s,%s,1)',
                (owner, identifier, Jsonb(envelope), tx_hash, b'signed-bytes',))
            if reverted:
                conn.execute('INSERT INTO domino_execution.reverted_receipts '
                    '(owner,intent_id,transaction_hash,block_number,block_hash,gas_used,effective_gas_price) '
                    'VALUES(%s,%s,%s,2,%s,%s,%s)',
                    (owner, identifier, tx_hash, block_hash, gas, spent_wei//gas))
            else:
                result = {'intentId': identifier, 'transactionHash': tx_hash,
                    'finalized': True, 'canonical': True,
                    'block': {'number': 2, 'hash': block_hash},
                    'gas': {'gasUsedRaw': str(gas),
                            'effectiveGasPriceRaw': str(spent_wei//gas),
                            'receiptGasProductWei': str(spent_wei), 'payer': owner}}
                conn.execute('INSERT INTO domino_execution.effects '
                    '(owner,intent_id,transaction_hash,block_number,block_hash,canonical,receipt) '
                    'VALUES(%s,%s,%s,2,%s,true,%s)',
                    (owner, identifier, tx_hash, block_hash, Jsonb(result)))

    def test_caller_quote_cannot_understate_eth_usd(self):
        budget = self.budget()
        self.addCleanup(budget.connection.close)
        forged = self.quote.__class__(**{**self.quote.__dict__, 'answer_raw': 1})
        claim = budget.reserve(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15, forged)
        self.assertEqual(claim['reservedUsdMicros'], 12_000_000)
        self.publication_witness(CYCLE_1, 2 * 10**15)
        settler = self.settler()
        self.addCleanup(settler.connection.close)
        settler.settle(CYCLE_1, 'publisher', 2 * 10**15, forged,
                       witnessed_quote=self.attest(CYCLE_1, 'publisher'))
        self.assertEqual(budget.status(claim['day'])['usedUsdMicros'], 4_000_000)

    def _assert_settlement_login_cannot_forge_quote(self, leg, *, reverted=False):
        identifier = CYCLE_1
        budget = self.budget()
        self.addCleanup(budget.connection.close)
        budget.reader.rpc.answer = 1000 * 10**8
        claim = budget.reserve(identifier, leg, ADDRESS, 5 * 10**15, self.quote)
        self.assertEqual(claim['reservedUsdMicros'], 6_000_000)
        if leg == 'publisher':
            self.publication_witness(identifier, 5 * 10**15)
        else:
            self.operator_witness(identifier, 5 * 10**15, reverted=reverted)
        witness = self.attest(identifier, leg, answer=4000)
        true_args = (identifier, leg, 5 * 10**15, witness['answerRaw'],
                     witness['roundId'], witness['answerUpdatedAt'],
                     witness['blockTimestamp'])
        forged_args = (*true_args[:3], 1000 * 10**8, *true_args[4:])
        with psycopg.connect(**self.pg.settings, user='domino_gas_settlement_login') as conn:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute('SELECT * FROM domino_gas_budget.settlement_quote_witnesses')
            conn.rollback()
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute('SELECT * FROM domino_gas_budget.attest_settlement_quote('
                             '%s,%s,%s,%s,%s,%s,%s,%s)',
                             (identifier, leg, 1000 * 10**8, witness['roundId'],
                              witness['answerUpdatedAt'], witness['blockNumber'],
                              witness['blockHash'], witness['blockTimestamp']))
            conn.rollback()
            with self.assertRaisesRegex(psycopg.errors.CheckViolation,
                                        'gas_settlement_quote_missing'):
                conn.execute('SELECT * FROM domino_gas_budget.settle(%s,%s,%s,%s,%s,%s,%s)',
                             forged_args)
            conn.rollback()
            self.assertEqual(conn.execute('SELECT spent_usd_micros FROM '
                'domino_gas_budget.settle(%s,%s,%s,%s,%s,%s,%s)', true_args).fetchone(),
                (20_000_000,))
            self.assertEqual(conn.execute('SELECT spent_usd_micros FROM '
                'domino_gas_budget.settle(%s,%s,%s,%s,%s,%s,%s)', true_args).fetchone(),
                (20_000_000,))
        self.assertEqual(budget.status(claim['day'])['usedUsdMicros'], 20_000_000)
        with self.assertRaisesRegex(GasBudgetError, 'gas_daily_cap_exceeded'):
            budget.reserve(CYCLE_2, 'operator', '0x' + 'cd' * 20, 10**15, self.quote)

    def test_settlement_login_cannot_forge_publisher_eth_usd_price(self):
        self._assert_settlement_login_cannot_forge_quote('publisher')

    def test_settlement_login_cannot_forge_operator_revert_eth_usd_price(self):
        self._assert_settlement_login_cannot_forge_quote('operator', reverted=True)

    def test_settlement_attests_finalized_price_not_unfinalized_low_fork(self):
        budget = self.budget()
        self.addCleanup(budget.connection.close)
        budget.reader.rpc.answer = 1000 * 10**8
        claim = budget.reserve(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15, self.quote)
        self.publication_witness(CYCLE_1, 5 * 10**15)
        rpc = FeedRpc(int(time.time()))
        rpc.finalized_number = 997
        rpc.answers_by_block = {998: 1000 * 10**8, 997: 4000 * 10**8}
        self.assertEqual(EthUsdReader(rpc).quote().answer_raw, 1000 * 10**8)
        rpc.pinned_number = 997
        rpc.pinned_reads = 0
        service = GasBudgetService(self.pg.settings, rpc)
        rpc.reorg = True
        with self.assertRaisesRegex(GasBudgetError, 'gas_quote_reorganized'):
            service.attest_settlement_quote(CYCLE_1, 'publisher')
        with self.pg.admin() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM '
                'domino_gas_budget.settlement_quote_witnesses').fetchone(), (0,))
        rpc.reorg = False
        rpc.pinned_reads = 0
        witness = service.attest_settlement_quote(CYCLE_1, 'publisher')
        self.assertEqual((witness['blockNumber'], witness['answerRaw']),
                         (997, 4000 * 10**8))
        args = (CYCLE_1, 'publisher', 5 * 10**15, witness['answerRaw'],
                witness['roundId'], witness['answerUpdatedAt'], witness['blockTimestamp'])
        with psycopg.connect(**self.pg.settings, user='domino_gas_settlement_login') as conn:
            with self.assertRaisesRegex(psycopg.errors.CheckViolation,
                                        'gas_settlement_quote_missing'):
                conn.execute('SELECT * FROM domino_gas_budget.settle(%s,%s,%s,%s,%s,%s,%s)',
                             (*args[:3], 1000 * 10**8, *args[4:]))
            conn.rollback()
            self.assertEqual(conn.execute('SELECT spent_usd_micros FROM '
                'domino_gas_budget.settle(%s,%s,%s,%s,%s,%s,%s)', args).fetchone(),
                (20_000_000,))
        self.assertEqual(budget.status(claim['day'])['usedUsdMicros'], 20_000_000)

    def test_delayed_finalized_quote_settles_but_stale_quote_fails_closed(self):
        budget = self.budget()
        self.addCleanup(budget.connection.close)
        claim = budget.reserve(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15, self.quote)
        self.publication_witness(CYCLE_1, 2 * 10**15)
        now = int(time.time())
        rpc = FeedRpc(now)
        rpc.finalized_age = 900
        rpc.updated_at = now - 910
        witness = GasBudgetService(self.pg.settings, rpc).attest_settlement_quote(
            CYCLE_1, 'publisher')
        self.assertEqual(witness['blockTimestamp'], now - 900)
        settler = self.settler()
        self.addCleanup(settler.connection.close)
        result = settler.settle(CYCLE_1, 'publisher', 2 * 10**15, self.quote,
                                witnessed_quote=witness)
        self.assertEqual(result['state'], 'settled')
        self.assertEqual(budget.status(claim['day'])['usedUsdMicros'], 4_000_000)

        stale = int(time.time()) - 1801
        with psycopg.connect(**self.pg.settings, user='domino_gas_budget_worker') as conn:
            with self.assertRaisesRegex(psycopg.errors.CheckViolation,
                                        'gas_settlement_quote_invalid'):
                conn.execute('SELECT * FROM domino_gas_budget.attest_settlement_quote('
                             '%s,%s,%s,%s,%s,%s,%s,%s)',
                             (CYCLE_2, 'publisher', 2000 * 10**8, PHASE_ROUND,
                              stale - 1, 998, FeedRpc._hash(998), stale))

    def test_each_database_gate_takes_a_calm_answer_up_to_the_heartbeat(self):
        # 046: reserve, authorized, attest_settlement_quote and settle each hold
        # the answer's age ceiling. A calm round 7201 s old, refused before,
        # passes every one of them; a round past the heartbeat fails each closed.
        def quote_args(age, block_age):
            now = int(time.time())
            return (2000 * 10**8, PHASE_ROUND, now - age, 998, FeedRpc._hash(998), now - block_age)
        reserve = 'SELECT state FROM domino_gas_budget.reserve(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)'
        attest = 'SELECT round FROM domino_gas_budget.attest_settlement_quote(%s,%s,%s,%s,%s,%s,%s,%s)'
        with psycopg.connect(**self.pg.settings, user='domino_gas_budget_worker') as conn:
            self.assertEqual(conn.execute(reserve, (CYCLE_1, 'publisher', ADDRESS, 5 * 10**15,
                                                    *quote_args(7201, 5), 12000)).fetchone(), ('reserved',))
            with self.assertRaisesRegex(psycopg.errors.CheckViolation, 'gas_reservation_invalid'):
                with conn.transaction():
                    conn.execute(reserve, (CYCLE_2, 'publisher', ADDRESS, 5 * 10**15,
                                           *quote_args(90100, 5), 12000))
            self.assertEqual(conn.execute(attest, (CYCLE_1, 'publisher', *quote_args(7201, 900))).fetchone(),
                             (PHASE_ROUND,))
            with self.assertRaisesRegex(psycopg.errors.CheckViolation, 'gas_settlement_quote_invalid'):
                with conn.transaction():
                    conn.execute(attest, (CYCLE_1, 'publisher', *quote_args(90100, 900)))
            conn.commit()
        with psycopg.connect(**self.pg.settings, user='domino_execution_publisher') as conn:
            gate = 'SELECT domino_gas_budget.authorized(%s,%s,%s,%s)'
            self.assertEqual(conn.execute(gate, (CYCLE_1, 'publisher', ADDRESS, 5 * 10**15)).fetchone(), (True,))
            for age, expected in ((89900, True), (90100, False)):
                with self.pg.admin() as admin:
                    admin.execute('UPDATE domino_gas_budget.claims SET reserve_updated_at=%s WHERE cycle_id=%s',
                                  (int(time.time()) - age, CYCLE_1))
                self.assertEqual(conn.execute(gate, (CYCLE_1, 'publisher', ADDRESS, 5 * 10**15)).fetchone(),
                                 (expected,), age)
        settle = 'SELECT * FROM domino_gas_budget.settle(%s,%s,%s,%s,%s,%s,%s)'
        with psycopg.connect(**self.pg.settings, user='domino_gas_settlement_worker') as conn:
            for age, error in ((7201, 'gas_reservation_missing'), (90100, 'gas_settlement_invalid')):
                answer, round_, updated, _, _, block_timestamp = quote_args(age, 900)
                with self.assertRaisesRegex(psycopg.errors.CheckViolation, error):
                    with conn.transaction():
                        conn.execute(settle, (CYCLE_2, 'publisher', 10**15, answer, round_, updated, block_timestamp))

    def test_old_quote_witness_cannot_be_replayed_to_release_cap(self):
        budget = self.budget()
        self.addCleanup(budget.connection.close)
        claim = budget.reserve(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15, self.quote)
        self.publication_witness(CYCLE_1, 2 * 10**15)
        witness = self.attest(CYCLE_1, 'publisher')
        args = (CYCLE_1, 'publisher', 2 * 10**15, witness['answerRaw'],
                witness['roundId'], witness['answerUpdatedAt'], witness['blockTimestamp'])
        with self.pg.admin() as conn:
            conn.execute("UPDATE domino_gas_budget.settlement_quote_witnesses "
                         "SET attested_at=clock_timestamp()-interval '31 seconds'")
        with psycopg.connect(**self.pg.settings, user='domino_gas_settlement_login') as conn:
            with self.assertRaisesRegex(psycopg.errors.CheckViolation,
                                        'gas_settlement_quote_missing'):
                conn.execute('SELECT * FROM domino_gas_budget.settle(%s,%s,%s,%s,%s,%s,%s)', args)
            conn.rollback()
        self.assertEqual(budget.status(claim['day'])['usedUsdMicros'], 12_000_000)
        fresh_witness = self.attest(CYCLE_1, 'publisher', answer=3000)
        self.assertNotEqual(fresh_witness['answerRaw'], witness['answerRaw'])
        fresh_args = (CYCLE_1, 'publisher', 2 * 10**15, fresh_witness['answerRaw'],
                      fresh_witness['roundId'], fresh_witness['answerUpdatedAt'],
                      fresh_witness['blockTimestamp'])
        with psycopg.connect(**self.pg.settings, user='domino_gas_settlement_login') as conn:
            with self.assertRaisesRegex(psycopg.errors.CheckViolation,
                                        'gas_settlement_quote_missing'):
                conn.execute('SELECT * FROM domino_gas_budget.settle(%s,%s,%s,%s,%s,%s,%s)', args)
            conn.rollback()
            self.assertEqual(conn.execute('SELECT spent_usd_micros FROM '
                'domino_gas_budget.settle(%s,%s,%s,%s,%s,%s,%s)', fresh_args).fetchone(),
                (6_000_000,))

    def test_settlement_login_cannot_release_cap_with_tiny_direct_sql_operand(self):
        budget = self.budget()
        self.addCleanup(budget.connection.close)
        claim = budget.reserve(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15, self.quote)
        args = (CYCLE_1, 'publisher', 1, self.quote.answer_raw,
                self.quote.round_id, self.quote.answer_updated_at, self.quote.block_timestamp)
        with psycopg.connect(**self.pg.settings, user='domino_gas_settlement_login') as conn:
            with self.assertRaises(psycopg.errors.CheckViolation):
                conn.execute('SELECT * FROM domino_gas_budget.settle(%s,%s,%s,%s,%s,%s,%s)', args)
            conn.rollback()
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute('UPDATE domino_execution.publications SET gas_used=1')
            conn.rollback()
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute('INSERT INTO domino_execution.publication_finality DEFAULT VALUES')
            conn.rollback()
        self.assertEqual(budget.status(claim['day'])['usedUsdMicros'], 12_000_000)
        self.publication_witness(CYCLE_1, 2 * 10**15, finalized=False)
        correct = (*args[:2], 2 * 10**15, *args[3:])
        with psycopg.connect(**self.pg.settings, user='domino_gas_settlement_login') as conn:
            for candidate in (args, correct):
                with self.assertRaises(psycopg.errors.CheckViolation):
                    conn.execute('SELECT * FROM domino_gas_budget.settle(%s,%s,%s,%s,%s,%s,%s)', candidate)
                conn.rollback()
        self.mark_publication_finality(CYCLE_1, 2 * 10**15)
        witness = self.attest(CYCLE_1, 'publisher')
        correct = (CYCLE_1, 'publisher', 2 * 10**15, witness['answerRaw'],
                   witness['roundId'], witness['answerUpdatedAt'],
                   witness['blockTimestamp'])
        with psycopg.connect(**self.pg.settings, user='domino_gas_settlement_login') as conn:
            result = conn.execute('SELECT spent_usd_micros FROM domino_gas_budget.settle('
                                  '%s,%s,%s,%s,%s,%s,%s)', correct).fetchone()
            self.assertEqual(result, (4_000_000,))

    def test_reverted_publisher_requires_finality_witness_even_with_exact_cost(self):
        budget = self.budget()
        self.addCleanup(budget.connection.close)
        budget.reserve(CYCLE_1, 'publisher', ADDRESS, 5*10**15, self.quote)
        self.publication_witness(CYCLE_1, 2*10**15, state='reverted', finalized=False)
        args = (CYCLE_1, 'publisher', 2*10**15, self.quote.answer_raw,
                self.quote.round_id, self.quote.answer_updated_at, self.quote.block_timestamp)
        with psycopg.connect(**self.pg.settings, user='domino_gas_settlement_login') as conn:
            with self.assertRaises(psycopg.errors.CheckViolation):
                conn.execute('SELECT * FROM domino_gas_budget.settle(%s,%s,%s,%s,%s,%s,%s)', args)
            conn.rollback()
        self.mark_publication_finality(CYCLE_1, 2*10**15, state='reverted')
        witness = self.attest(CYCLE_1, 'publisher')
        args = (CYCLE_1, 'publisher', 2*10**15, witness['answerRaw'],
                witness['roundId'], witness['answerUpdatedAt'],
                witness['blockTimestamp'])
        with psycopg.connect(**self.pg.settings, user='domino_gas_settlement_login') as conn:
            self.assertEqual(conn.execute('SELECT spent_usd_micros FROM domino_gas_budget.settle('
                                          '%s,%s,%s,%s,%s,%s,%s)', args).fetchone(),
                             (4_000_000,))

    def test_publisher_role_appends_finality_only_after_finalized_head(self):
        identifier, signer, rpc, journal = self.signed_publication(status=1)
        budget = self.budget()
        self.addCleanup(budget.connection.close)
        budget.reserve(identifier, 'publisher', signer, 10**14, self.quote)
        self.assertEqual(journal.check(identifier, rpc, confirmations=2)['state'], 'confirmed')
        # The quote held before finality may be older than the later attestation.
        args = (identifier, 'publisher', 12_500_000_000_000, self.quote.answer_raw,
                self.quote.round_id, self.quote.answer_updated_at,
                self.quote.block_timestamp - 1)
        self.assertEqual(journal.finalize_pending(signer, rpc, confirmations=2)[0]['state'], 'pending')
        with psycopg.connect(**self.pg.settings, user='domino_gas_settlement_login') as conn:
            with self.assertRaises(psycopg.errors.CheckViolation):
                conn.execute('SELECT * FROM domino_gas_budget.settle(%s,%s,%s,%s,%s,%s,%s)', args)
            conn.rollback()
        rpc.final['number'] = '0x66'
        self.assertEqual(journal.finalize_pending(signer, rpc, confirmations=2)[0]['state'], 'finalized')
        witness = self.attest(identifier, 'publisher')
        self.assertNotEqual(args[6], witness['blockTimestamp'])
        args = (identifier, 'publisher', 12_500_000_000_000, witness['answerRaw'],
                witness['roundId'], witness['answerUpdatedAt'],
                witness['blockTimestamp'])
        with psycopg.connect(**self.pg.settings, user='domino_gas_settlement_login') as conn:
            self.assertEqual(conn.execute('SELECT state FROM domino_gas_budget.settle('
                                          '%s,%s,%s,%s,%s,%s,%s)', args).fetchone(),
                             ('settled',))
        with self.pg.admin() as conn:
            self.assertEqual(conn.execute('SELECT spent_wei FROM domino_gas_budget.claims '
                'WHERE cycle_id=%s AND leg=%s', (identifier, 'publisher')).fetchone(),
                (12_500_000_000_000,))

    def test_pre_finality_reverted_publication_reorgs_then_requalifies(self):
        identifier, signer, rpc, journal = self.signed_publication(status=0)
        budget = self.budget()
        self.addCleanup(budget.connection.close)
        budget.reserve(identifier, 'publisher', signer, 10**14, self.quote)
        self.assertEqual(journal.check(identifier, rpc, confirmations=2)['state'], 'reverted')
        self.assertEqual(journal.finalize_pending(signer, rpc, confirmations=2)[0]['state'], 'pending')
        rpc.reorg = True
        self.assertEqual(journal.finalize_pending(signer, rpc, confirmations=2)[0]['state'], 'pending')
        self.assertEqual(journal.status(identifier)['state'], 'reorged')
        with self.pg.admin() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_execution.publication_finality').fetchone(), (0,))
        rpc.reorg = False
        self.assertEqual(journal.check(identifier, rpc, confirmations=2)['state'], 'reverted')
        rpc.final['number'] = '0x66'
        self.assertEqual(journal.finalize_pending(signer, rpc, confirmations=2)[0]['state'], 'finalized')

    def test_publisher_finality_cursor_rotates_past_unavailable_old_receipt(self):
        third = '0x' + '33' * 32
        for identifier in (CYCLE_1, CYCLE_2, third):
            self.publication_witness(identifier, 2*10**15, finalized=False)
        journal = PublicationJournal(self.pg.settings)
        self.assertEqual(journal.pending_finality(ADDRESS, limit=1), [CYCLE_1])
        self.assertEqual(journal.pending_finality(ADDRESS, limit=1), [CYCLE_2])
        self.assertEqual(journal.pending_finality(ADDRESS, limit=1), [third])
        self.assertEqual(journal.pending_finality(ADDRESS, limit=1), [CYCLE_1])

    def test_operator_effect_and_revert_witnesses_bind_exact_cost_and_prior_day(self):
        budget = self.budget()
        self.addCleanup(budget.connection.close)
        for identifier, reverted in ((CYCLE_1, False), (CYCLE_2, True)):
            with self.subTest(reverted=reverted):
                claim = budget.reserve(identifier, 'operator', ADDRESS, 5*10**15, self.quote)
                if reverted:
                    yesterday = (date.fromisoformat(claim['day']) - timedelta(days=1)).isoformat()
                    with self.pg.admin() as conn:
                        conn.execute('INSERT INTO domino_gas_budget.days(day) VALUES(%s)', (yesterday,))
                        conn.execute('UPDATE domino_gas_budget.claims SET day=%s '
                                     'WHERE cycle_id=%s AND leg=%s', (yesterday, identifier, 'operator'))
                args = (identifier, 'operator', 1, self.quote.answer_raw,
                        self.quote.round_id, self.quote.answer_updated_at,
                        self.quote.block_timestamp)
                with psycopg.connect(**self.pg.settings, user='domino_gas_settlement_login') as conn:
                    with self.assertRaises(psycopg.errors.CheckViolation):
                        conn.execute('SELECT * FROM domino_gas_budget.settle(%s,%s,%s,%s,%s,%s,%s)', args)
                    conn.rollback()
                self.operator_witness(identifier, 2*10**15, reverted=reverted)
                witness = self.attest(identifier, 'operator')
                with psycopg.connect(**self.pg.settings, user='domino_gas_settlement_login') as conn:
                    with self.assertRaises(psycopg.errors.CheckViolation):
                        conn.execute('SELECT * FROM domino_gas_budget.settle(%s,%s,%s,%s,%s,%s,%s)', args)
                    conn.rollback()
                    exact = (identifier, 'operator', 2*10**15, witness['answerRaw'],
                             witness['roundId'], witness['answerUpdatedAt'],
                             witness['blockTimestamp'])
                    self.assertEqual(conn.execute('SELECT spent_usd_micros FROM domino_gas_budget.settle('
                                                  '%s,%s,%s,%s,%s,%s,%s)', exact).fetchone(),
                                     (4_000_000,))
                    conn.commit()
                    with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                        conn.execute('UPDATE domino_execution.reverted_receipts SET gas_used=1')
                    conn.rollback()

    def test_retry_refreshes_expired_gate_without_releasing_reservation(self):
        budget = self.budget()
        self.addCleanup(budget.connection.close)
        first = budget.reserve(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15, self.quote)
        with self.pg.admin() as conn:
            conn.execute("UPDATE domino_gas_budget.claims SET refreshed_at=clock_timestamp()-interval '121 seconds' "
                         'WHERE cycle_id=%s', (CYCLE_1,))
        self.assertFalse(budget.authorized(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15))
        budget.require_existing_reservation(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15)
        with self.assertRaisesRegex(GasBudgetError, 'gas_reservation_not_authorized'):
            budget.require_existing_reservation(CYCLE_1, 'operator', ADDRESS, 5 * 10**15)
        budget.reader.rpc.answer = 2200 * 10**8
        again = budget.reserve(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15, self.quote)
        self.assertEqual(first['day'], again['day'])
        self.assertEqual(again['reservedUsdMicros'], 13_200_000)
        self.assertTrue(budget.authorized(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15))
        budget.reader.rpc.answer = 1000 * 10**8
        self.assertEqual(budget.reserve(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15,
                                        self.quote)['reservedUsdMicros'], 13_200_000)

    def test_price_drop_does_not_release_historical_gas_cost(self):
        budget = self.budget()
        self.addCleanup(budget.connection.close)
        claim = budget.reserve(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15, self.quote)
        budget.reader.rpc.answer = 1000 * 10**8
        self.publication_witness(CYCLE_1, 2 * 10**15)
        settler = self.settler()
        self.addCleanup(settler.connection.close)
        settled = settler.settle(CYCLE_1, 'publisher', 2 * 10**15, self.quote,
                                 witnessed_quote=self.attest(CYCLE_1, 'publisher', answer=1000))
        self.assertEqual((claim['reservedUsdMicros'], settled['spentUsdMicros']),
                         (12_000_000, 4_000_000))

    def test_price_jump_records_actual_over_cap_and_blocks_new_claims(self):
        budget = self.budget()
        self.addCleanup(budget.connection.close)
        claim = budget.reserve(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15, self.quote)
        self.assertEqual(claim['reservedUsdMicros'], 12_000_000)
        settler = self.settler()
        self.addCleanup(settler.connection.close)
        settler.reader.rpc.answer = 5000 * 10**8
        self.publication_witness(CYCLE_1, 5 * 10**15)
        settled = settler.settle(CYCLE_1, 'publisher', 5 * 10**15, self.quote,
                                 witnessed_quote=self.attest(CYCLE_1, 'publisher', answer=5000))
        self.assertEqual(settled['spentUsdMicros'], 25_000_000)
        self.assertEqual(budget.status(claim['day'])['usedUsdMicros'], 25_000_000)
        with self.assertRaisesRegex(GasBudgetError, 'gas_daily_cap_exceeded'):
            budget.reserve(CYCLE_2, 'operator', '0x' + 'cd' * 20, 10**15, self.quote)
        with self.pg.admin() as conn:
            self.assertEqual(conn.execute(
                'SELECT state,spent_usd_micros FROM domino_gas_budget.claims '
                'WHERE cycle_id=%s AND leg=%s', (CYCLE_1, 'publisher')).fetchone(),
                ('settled', 25_000_000))

    def test_reservation_without_private_feed_reader_fails_closed(self):
        with psycopg.connect(**self.pg.settings, user='domino_gas_budget_worker') as conn:
            budget = GasUsdBudget(conn)
            with self.assertRaisesRegex(GasBudgetError, 'gas_quote_reader_required'):
                budget.reserve(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15, self.quote)

    def test_two_wallets_share_cap_and_settlement_releases_only_proven_difference(self):
        first = self.budget()
        self.addCleanup(first.connection.close)
        claim = first.reserve(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15, self.quote)
        self.assertEqual(claim['reservedUsdMicros'], 12_000_000)
        self.assertTrue(first.authorized(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15))
        self.assertFalse(first.authorized(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15 + 1))
        first.require_reservation(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15)
        with self.assertRaisesRegex(GasBudgetError, 'gas_reservation_not_authorized'):
            first.require_reservation(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15 + 1)
        self.assertEqual(first.reserve(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15,
                                       self.quote), claim)
        with self.assertRaisesRegex(Exception, 'gas_daily_cap_exceeded'):
            first.reserve(CYCLE_2, 'operator', '0x'+'cd'*20, 5 * 10**15, self.quote)
        day = claim['day']
        self.assertEqual(first.status(day)['usedUsdMicros'], 12_000_000)
        settler = self.settler()
        self.addCleanup(settler.connection.close)
        self.publication_witness(CYCLE_1, 2 * 10**15)
        settled = settler.settle(CYCLE_1, 'publisher', 2 * 10**15, self.quote,
                                 witnessed_quote=self.attest(CYCLE_1, 'publisher'))
        self.assertEqual(settled['spentUsdMicros'], 4_000_000)
        self.assertFalse(first.authorized(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15))
        second = first.reserve(CYCLE_2, 'operator', '0x'+'cd'*20, 5 * 10**15, self.quote)
        self.assertEqual(second['reservedUsdMicros'], 12_000_000)
        self.assertEqual(first.status(day)['remainingUsdMicros'], 4_000_000)
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            with first.connection.transaction():
                first.connection.execute('DELETE FROM domino_gas_budget.claims')
        with self.assertRaisesRegex(GasBudgetError, 'gas_budget_unavailable'):
            first.settle(CYCLE_2, 'operator', 2 * 10**15, self.quote)

    def test_concurrent_reservations_have_one_winner(self):
        def reserve(cycle, signer):
            budget = self.budget()
            try:
                return budget.reserve(cycle, 'operator', signer, 5 * 10**15, self.quote)
            except Exception as error:
                return type(error).__name__
            finally:
                budget.connection.close()
        with ThreadPoolExecutor(max_workers=2) as pool:
            rows = list(pool.map(lambda args: reserve(*args),
                                 ((CYCLE_1, ADDRESS), (CYCLE_2, '0x'+'cd'*20))))
        self.assertEqual(sum(isinstance(row, dict) for row in rows), 1)
        budget = self.budget()
        try:
            day = next(row['day'] for row in rows if isinstance(row, dict))
            self.assertEqual(budget.status(day)['usedUsdMicros'],
                             12_000_000)
        finally:
            budget.connection.close()

    def test_pair_is_atomic_and_replay_is_idempotent(self):
        service = GasBudgetService(self.pg.settings, FeedRpc(int(time.time())))
        first = service.reserve_pair(CYCLE_1, ADDRESS, 2 * 10**15,
                                     CYCLE_2, '0x' + 'cd' * 20, 2 * 10**15)
        self.assertEqual(first['publisher']['day'], first['operator']['day'])
        self.assertEqual(first, service.reserve_pair(
            CYCLE_1, ADDRESS, 2 * 10**15, CYCLE_2, '0x' + 'cd' * 20, 2 * 10**15))
        service.require_reservation(CYCLE_1, 'publisher', ADDRESS, 2 * 10**15)
        service.require_reservation(CYCLE_2, 'operator', '0x' + 'cd' * 20, 2 * 10**15)
        with self.pg.admin() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_gas_budget.claims').fetchone(), (2,))
            conn.execute('TRUNCATE domino_gas_budget.claims,domino_gas_budget.days CASCADE')
        with self.assertRaisesRegex(GasBudgetError, 'gas_daily_cap_exceeded'):
            service.reserve_pair(CYCLE_1, ADDRESS, 5 * 10**15,
                                 CYCLE_2, '0x' + 'cd' * 20, 5 * 10**15)
        with self.pg.admin() as conn:
            self.assertEqual(conn.execute('SELECT count(*) FROM domino_gas_budget.claims').fetchone(), (0,))

    def test_unresolved_prior_day_reservation_counts_against_today(self):
        budget = self.budget()
        self.addCleanup(budget.connection.close)
        today = budget.reserve(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15, self.quote)['day']
        yesterday = (date.fromisoformat(today) - timedelta(days=1)).isoformat()
        with self.pg.admin() as conn:
            conn.execute('INSERT INTO domino_gas_budget.days(day) VALUES(%s)', (yesterday,))
            conn.execute('UPDATE domino_gas_budget.claims SET day=%s WHERE cycle_id=%s',
                         (yesterday, CYCLE_1))
        self.assertEqual(budget.status(today)['usedUsdMicros'], 12_000_000)
        with self.assertRaisesRegex(GasBudgetError, 'gas_daily_cap_exceeded'):
            budget.reserve(CYCLE_2, 'operator', '0x'+'cd'*20, 5 * 10**15, self.quote)
        settler = self.settler()
        self.addCleanup(settler.connection.close)
        self.publication_witness(CYCLE_1, 2 * 10**15)
        settler.settle(CYCLE_1, 'publisher', 2 * 10**15, self.quote,
                       witnessed_quote=self.attest(CYCLE_1, 'publisher'))
        self.assertEqual(budget.status(today)['usedUsdMicros'], 4_000_000)
        with self.assertRaisesRegex(GasBudgetError, 'gas_daily_cap_exceeded'):
            budget.reserve(CYCLE_2, 'operator', '0x'+'cd'*20, 8 * 10**15, self.quote)

    def test_signer_roles_can_only_check_reserved_claim(self):
        budget = self.budget()
        self.addCleanup(budget.connection.close)
        budget.reserve(CYCLE_1, 'publisher', ADDRESS, 5 * 10**15, self.quote)
        for role, leg in (('domino_execution_signer','operator'),
                          ('domino_execution_publisher','publisher')):
            with psycopg.connect(**self.pg.settings, user=role) as conn:
                self.assertEqual(conn.execute('SELECT domino_gas_budget.authorized(%s,%s,%s,%s)',
                                              (CYCLE_1,leg,ADDRESS,5*10**15)).fetchone(),
                                 (leg=='publisher',))
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    with conn.transaction():
                        conn.execute('SELECT * FROM domino_gas_budget.claims')

    def test_settlement_scan_rotates_durably_and_resolves_intent_owner(self):
        from gas_receipt_settlement import GasSettlementQueue
        intent = CYCLE_2
        sequence = {'owner': ADDRESS, 'chainId': '4663'}
        with self.pg.admin() as conn:
            conn.execute('INSERT INTO domino_execution.intents(intent_id,owner,sequence_hash,chain_id,model_version,plan,observation,commitments) '
                         'VALUES(%s,%s,%s,4663,%s,%s,%s,%s)',
                         (intent, ADDRESS, CYCLE_1, '4',
                          psycopg.types.json.Jsonb({'sequence': sequence}),
                          psycopg.types.json.Jsonb({'sequence': sequence}),
                          psycopg.types.json.Jsonb({})))
        budget = self.budget()
        self.addCleanup(budget.connection.close)
        budget.reserve(CYCLE_1, 'publisher', ADDRESS, 2 * 10**15, self.quote)
        budget.reserve(CYCLE_2, 'operator', ADDRESS, 2 * 10**15, self.quote)
        queue = GasSettlementQueue(self.pg.settings)
        first = queue.next_pending(1)
        second = queue.next_pending(1)
        self.assertEqual({(first[0]['cycleId'], first[0]['leg']),
                          (second[0]['cycleId'], second[0]['leg'])},
                         {(CYCLE_1, 'publisher'), (CYCLE_2, 'operator')})
        self.assertEqual(next(row['owner'] for row in first + second
                              if row['leg'] == 'operator'), ADDRESS)
        # A fresh process sees the persisted cursor and wraps to unresolved work.
        self.assertEqual(GasSettlementQueue(self.pg.settings).next_pending(1), first)
        settler = self.settler()
        self.addCleanup(settler.connection.close)
        self.publication_witness(CYCLE_1, 10**15, max_wei=2*10**15)
        settler.settle(CYCLE_1, 'publisher', 10**15, self.quote,
                       witnessed_quote=self.attest(CYCLE_1, 'publisher'))
        self.assertEqual(GasSettlementQueue(self.pg.settings).next_pending(1),
                         [next(row for row in first + second if row['leg'] == 'operator')])
        with psycopg.connect(**self.pg.settings, user='domino_gas_settlement_worker') as conn:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                with conn.transaction():
                    conn.execute('SELECT * FROM domino_gas_budget.claims')
