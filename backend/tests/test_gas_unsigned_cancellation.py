"""Only terminal, never-signed claims may return budget headroom."""
from concurrent.futures import ThreadPoolExecutor
import os
from pathlib import Path
import sys
from threading import Event
import time
from types import SimpleNamespace
import unittest
from uuid import uuid4

sys.path[:0] = [str(Path(__file__).resolve().parents[1]),
                str(Path(__file__).resolve().parent)]
import psycopg
from psycopg.types.json import Jsonb

from execution_pg import ExecutionPostgres
from execution_runner import ExecutionJournal
from execution_store import ExecutionStoreError, UnsignedExecutionStore
from gas_usd_budget import EthUsdReader, GasBudgetError, GasUsdBudget
from test_gas_usd_budget import FeedRpc


OWNER = '0x' + 'ab' * 20
SIGNER = '0x' + 'cd' * 20
SEQUENCE = '0x' + '12' * 32
INTENT = '0x' + '34' * 32
ANCHOR = '0x' + '56' * 32
OTHER = '0x' + '78' * 32


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1',
                     'disposable PostgreSQL required')
class UnsignedCancellationPostgresTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pg = ExecutionPostgres().start()
        cls.addClassCleanup(cls.pg.close)
        migrations = Path(__file__).resolve().parents[1] / 'migrations'
        with cls.pg.admin() as conn:
            for name in ('019_execution_journal', '028_automation_cycle',
                         '032_shared_gas_budget', '033_gas_budget_claim_read',
                         '034_gas_settlement_sweep', '035_cancel_unsigned_gas_claims'):
                conn.execute((migrations / f'{name}.sql').read_text())
            conn.execute('ALTER ROLE domino_gas_budget_worker LOGIN')
            conn.execute('ALTER ROLE domino_gas_settlement_worker LOGIN')
            conn.execute('ALTER ROLE domino_execution_signer LOGIN')

    def setUp(self):
        with self.pg.admin() as conn:
            conn.execute('TRUNCATE domino_execution.intents,domino_execution.cycles,'
                         'domino_execution.publications,domino_gas_budget.claims,'
                         'domino_gas_budget.cancelled_claims,domino_gas_budget.days CASCADE')
            conn.execute('UPDATE domino_gas_budget.sweep_cursor SET '
                         'last_created_at=NULL,last_cycle_id=NULL,last_leg=NULL')
        self.reader = EthUsdReader(FeedRpc(int(time.time())))
        self.quote = self.reader.quote()

    def budget(self):
        conn = psycopg.connect(**self.pg.settings, user='domino_gas_budget_worker')
        self.addCleanup(conn.close)
        return GasUsdBudget(conn, reader=EthUsdReader(FeedRpc(int(time.time()))))

    def cancel(self, identifier, leg):
        with psycopg.connect(**self.pg.settings,
                             user='domino_gas_settlement_worker') as conn:
            return conn.execute('SELECT cancelled,released_usd_micros::text,reason '
                'FROM domino_gas_budget.cancel_unsigned(%s,%s)',
                (identifier, leg)).fetchone()

    def intent(self, identifier=INTENT):
        seq = {'owner': OWNER, 'chainId': '4663'}
        plan = {'sequence': seq, 'allocations': [], 'collections': [],
                'action': '1', 'deadline': str(int(time.time()) + 600)}
        with self.pg.admin() as conn:
            conn.execute('INSERT INTO domino_execution.intents '
                '(intent_id,owner,sequence_hash,chain_id,model_version,plan,observation,commitments) '
                'VALUES(%s,%s,%s,4663,%s,%s,%s,%s)',
                (identifier, OWNER, SEQUENCE, 'test',
                 Jsonb(plan), Jsonb({'sequence': seq}), Jsonb({})))

    def terminal_intent(self, identifier=INTENT):
        store = UnsignedExecutionStore(self.pg.settings)
        worker = str(uuid4())
        lease = store.acquire(OWNER, identifier, worker)
        store.cancel(OWNER, identifier, worker, lease['fence'])

    def reserved_intent(self, identifier=INTENT):
        self.intent(identifier)
        store = UnsignedExecutionStore(self.pg.settings)
        worker = str(uuid4())
        lease = store.acquire(OWNER, identifier, worker)
        store._transaction(OWNER, lambda conn, _: conn.execute(
            "UPDATE domino_execution.intents SET state='reserved' WHERE intent_id=%s",
            (identifier,)), worker=worker, fence=lease['fence'])
        return store, worker, lease['fence']

    def cycle(self, state='abandoned', identifier=INTENT, anchor=ANCHOR):
        with self.pg.admin() as conn:
            conn.execute('INSERT INTO domino_execution.cycles '
                '(cycle_id,owner,sequence_hash,state,config_version,input_fingerprint,'
                'observation_hash,source_block_number,source_block_hash,decision,intent_id,observation_id) '
                'VALUES(%s,%s,%s,%s,%s,%s,%s,1,%s,%s,%s,%s)',
                (uuid4(), OWNER, SEQUENCE, state, 'test', OTHER, OTHER, OTHER,
                 Jsonb({}), identifier, anchor))

    def publication(self, state='signed', anchor=ANCHOR):
        with self.pg.admin() as conn:
            conn.execute('INSERT INTO domino_execution.publications '
                '(observation_id,guard,pool_id,block_number,block_hash,block_timestamp,'
                'expires_at,sqrt_price,signer,nonce,envelope,signed_bytes,transaction_hash,state) '
                "VALUES(%s,%s,%s,1,%s,1,2,1,%s,1,%s,%s,%s,'signed')",
                (anchor, OWNER, OTHER, OTHER, SIGNER, Jsonb({}), b'\x01', OTHER))
            if state != 'signed':
                conn.execute('UPDATE domino_execution.publications SET state=%s '
                             'WHERE observation_id=%s', (state, anchor))

    def test_operator_cancelled_intent_releases_once_and_blocks_reuse(self):
        self.intent()
        budget = self.budget()
        claim = budget.reserve(INTENT, 'operator', SIGNER, 5 * 10**15, self.quote)
        self.assertEqual(claim['reservedUsdMicros'], 12_000_000)
        self.assertEqual(self.cancel(INTENT, 'operator'),
                         (False, '0', 'intent_not_terminal'))
        self.terminal_intent()
        self.assertEqual(self.cancel(INTENT, 'operator'),
                         (True, '12000000', 'unsigned_cancelled_intent'))
        self.assertEqual(budget.status(claim['day'])['usedUsdMicros'], 0)
        self.assertFalse(budget.authorized(INTENT, 'operator', SIGNER, 5 * 10**15))
        with self.assertRaisesRegex(GasBudgetError, 'gas_reservation_conflict'):
            budget.reserve(INTENT, 'operator', SIGNER, 5 * 10**15, self.quote)
        budget.reserve(OTHER, 'operator', SIGNER, 5 * 10**15, self.quote)
        self.assertEqual(self.cancel(INTENT, 'operator'),
                         (False, '0', 'claim_not_reserved'))
        with self.pg.admin() as conn:
            self.assertEqual(conn.execute('SELECT reason FROM domino_gas_budget.cancelled_claims '
                                          'WHERE cycle_id=%s', (INTENT,)).fetchone()[0],
                             'unsigned_cancelled_intent')
            with self.assertRaisesRegex(psycopg.errors.CheckViolation,
                                        'gas_cancellation_immutable'):
                conn.execute('DELETE FROM domino_gas_budget.cancelled_claims '
                             'WHERE cycle_id=%s', (INTENT,))

    def test_publisher_requires_all_cycles_terminal(self):
        self.intent()
        budget = self.budget()
        claim = budget.reserve(ANCHOR, 'publisher', SIGNER, 5 * 10**15, self.quote)
        self.cycle(state='publishing')
        self.assertEqual(self.cancel(ANCHOR, 'publisher'),
                         (False, '0', 'cycle_not_terminal'))
        self.assertEqual(budget.status(claim['day'])['usedUsdMicros'],
                         12_000_000)

    def test_publisher_releases_abandoned_unsigned_cycle(self):
        self.intent()
        budget = self.budget()
        claim = budget.reserve(ANCHOR, 'publisher', SIGNER, 5 * 10**15, self.quote)
        self.terminal_intent()
        self.cycle(state='abandoned')
        self.assertEqual(self.cancel(ANCHOR, 'publisher'),
                         (True, '12000000', 'unsigned_abandoned_cycles'))
        self.assertEqual(budget.status(claim['day'])['usedUsdMicros'], 0)

    def test_expired_signed_publication_keeps_full_reservation(self):
        self.intent()
        self.terminal_intent()
        self.cycle()
        budget = self.budget()
        claim = budget.reserve(ANCHOR, 'publisher', SIGNER, 5 * 10**15,
                               self.quote)
        self.publication('expired')
        self.assertEqual(self.cancel(ANCHOR, 'publisher'),
                         (False, '0', 'signing_or_signed'))
        self.assertEqual(budget.status(claim['day'])['usedUsdMicros'],
                         12_000_000)

    def test_publisher_advisory_lock_excludes_in_flight_sign_and_persist(self):
        self.intent()
        self.terminal_intent()
        self.cycle()
        budget = self.budget()
        claim = budget.reserve(ANCHOR, 'publisher', SIGNER, 5 * 10**15,
                               self.quote)
        blocker = self.pg.admin()
        try:
            blocker.execute('SELECT pg_advisory_xact_lock(hashtextextended(%s,0))',
                            (ANCHOR,))
            with ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(self.cancel, ANCHOR, 'publisher')
                self.assertFalse(future.done())
                blocker.execute('INSERT INTO domino_execution.publications '
                    '(observation_id,guard,pool_id,block_number,block_hash,block_timestamp,'
                    'expires_at,sqrt_price,signer,nonce,envelope,signed_bytes,transaction_hash,state) '
                    "VALUES(%s,%s,%s,1,%s,1,2,1,%s,1,%s,%s,%s,'signed')",
                    (ANCHOR, OWNER, OTHER, OTHER, SIGNER, Jsonb({}), b'\x01', OTHER))
                blocker.commit()
                self.assertEqual(future.result(timeout=5),
                                 (False, '0', 'signing_or_signed'))
        finally:
            blocker.close()
        self.assertEqual(budget.status(claim['day'])['usedUsdMicros'],
                         12_000_000)

    def test_operator_prepare_row_lock_excludes_cancellation(self):
        store, worker, fence = self.reserved_intent()
        budget = self.budget()
        claim = budget.reserve(INTENT, 'operator', SIGNER, 5 * 10**15,
                               self.quote)
        entered, release, cancel_entered = Event(), Event(), Event()
        cancel_pid = []

        class SigningBoundary:
            address = SIGNER
            action = 'typed_fee_execution_v4'
            admission = SimpleNamespace(model_dump=lambda **_: {})
            rpc = SimpleNamespace(request=lambda method, params: '0x0')

            def envelope(self, record, nonce):
                entered.set()
                if not release.wait(4):
                    raise AssertionError('prepare was not released')
                return {'nonce': nonce}

        def attempt_cancel():
            with psycopg.connect(**self.pg.settings,
                                 user='domino_gas_settlement_worker') as conn:
                cancel_pid.append(conn.execute('SELECT pg_backend_pid()').fetchone()[0])
                cancel_entered.set()
                return conn.execute('SELECT cancelled,released_usd_micros::text,reason '
                    'FROM domino_gas_budget.cancel_unsigned(%s,%s)',
                    (INTENT, 'operator')).fetchone()

        with ThreadPoolExecutor(max_workers=2) as pool:
            prepare = pool.submit(ExecutionJournal(self.pg.settings).prepare,
                OWNER, INTENT, worker, fence, SigningBoundary(),
                restore_only=False)
            self.assertTrue(entered.wait(3))
            cancelled = pool.submit(attempt_cancel)
            self.assertTrue(cancel_entered.wait(3))
            try:
                deadline = time.monotonic() + 1
                blocked = False
                while time.monotonic() < deadline:
                    with self.pg.admin() as conn:
                        blocked = conn.execute('SELECT wait_event_type=%s '
                            'FROM pg_stat_activity WHERE pid=%s',
                            ('Lock', cancel_pid[0])).fetchone()[0]
                    if blocked:
                        break
                    time.sleep(0.01)
                self.assertTrue(blocked, 'cancellation must wait for the signer intent lock')
            finally:
                release.set()
            self.assertEqual(prepare.result(timeout=5)['journal']['state'],
                             'signing')
            self.assertEqual(cancelled.result(timeout=5),
                             (False, '0', 'intent_not_terminal'))
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_state_conflict'):
            store.cancel(OWNER, INTENT, worker, fence)
        self.assertEqual(budget.status(claim['day'])['usedUsdMicros'],
                         12_000_000)

    def test_settlement_role_cannot_mutate_claims_or_tombstones(self):
        self.intent()
        self.terminal_intent()
        budget = self.budget()
        budget.reserve(INTENT, 'operator', SIGNER, 10**15, self.quote)
        with psycopg.connect(**self.pg.settings,
                             user='domino_gas_settlement_worker') as conn:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute('DELETE FROM domino_gas_budget.claims WHERE cycle_id=%s',
                             (INTENT,))
        self.assertTrue(self.cancel(INTENT, 'operator')[0])
        with psycopg.connect(**self.pg.settings,
                             user='domino_gas_settlement_worker') as conn:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute('DELETE FROM domino_gas_budget.cancelled_claims '
                             'WHERE cycle_id=%s', (INTENT,))


if __name__ == '__main__':
    unittest.main()
