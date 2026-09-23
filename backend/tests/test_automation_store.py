"""Actual role, lease and immutability semantics of the automation cycle store."""
import os
from pathlib import Path
import sys
import unittest
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import psycopg
from automation_fixtures import address, identity
from automation_store import CycleStore
from execution_status import ExecutionStatusReader
from execution_pg import ExecutionPostgres
from execution_store import ExecutionStoreError

OWNER, SEQUENCE, POOL = address(1), identity(11), identity(12)


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'set DOMINO_TEST_POSTGRES=1 for actual private PostgreSQL roles')
class CycleStoreTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.pg = ExecutionPostgres().start()
        cls.addClassCleanup(cls.pg.close)
        with cls.pg.admin() as conn:
            conn.execute((Path(__file__).resolve().parents[1] / 'migrations/019_execution_journal.sql').read_text())
            conn.execute((Path(__file__).resolve().parents[1] / 'migrations/028_automation_cycle.sql').read_text())
            conn.execute((Path(__file__).resolve().parents[1] / 'migrations/029_ledger_index.sql').read_text())
            conn.execute((Path(__file__).resolve().parents[1] / 'migrations/030_swap_exposure.sql').read_text())
            conn.execute((Path(__file__).resolve().parents[1] / 'migrations/031_publication_resend.sql').read_text())
            conn.execute((Path(__file__).resolve().parents[1] / 'migrations/039_automation_readiness.sql').read_text())
            conn.execute('ALTER ROLE domino_execution_publisher LOGIN')
            conn.execute('ALTER ROLE domino_execution_reader LOGIN')

    def setUp(self):
        with self.pg.admin() as conn:
            conn.execute('TRUNCATE domino_execution.cycles,domino_execution.sequence_state,domino_execution.pool_samples,domino_execution.controls,domino_execution.publications,'
                         'domino_execution.publisher_heads,domino_execution.withdrawals,domino_execution.withdrawal_debits,domino_execution.ledger_exceptions,domino_execution.ledger_cursors,'
                         'domino_execution.swap_exposure CASCADE')
        self.store = CycleStore(self.pg.settings)
        self.worker = str(uuid.uuid4())

    def cycle_fields(self, **changes):
        return {'state': 'evaluated', 'reason': 'wait', 'config_version': 'test-1', 'fingerprint': identity(21), 'observation_hash': identity(22),
                'source_block_number': 5, 'source_block_hash': identity(23), 'decision': {'action': 'wait'}, **changes}

    def test_due_state_preserves_structural_read_failure_for_readiness(self):
        self.store.ensure_sequence(OWNER, SEQUENCE, address(3), POOL, now=1000)
        lease = self.store.acquire_sequence(OWNER, SEQUENCE, self.worker, lease_seconds=60)
        self.store.update_sequence(OWNER, SEQUENCE, self.worker, lease['fence'], release=True,
                                   last_read_failed=True, next_due_seconds=3600)
        state = self.store.due_state(OWNER, address(3))
        self.assertEqual(len(state), 1)
        self.assertIs(state[0]['readinessQualified'], False)
        lease = self.store.acquire_sequence(OWNER, SEQUENCE, self.worker, lease_seconds=60)
        self.store.update_sequence(OWNER, SEQUENCE, self.worker, lease['fence'], release=True,
                                   last_read_failed=False, next_due_seconds=3600)
        self.assertIs(self.store.due_state(OWNER, address(3))[0]['readinessQualified'], True)

    def test_lease_is_exclusive_and_every_write_needs_the_live_fence(self):
        self.store.ensure_sequence(OWNER, SEQUENCE, address(3), POOL, now=1000)
        lease = self.store.acquire_sequence(OWNER, SEQUENCE, self.worker, lease_seconds=60)
        self.assertEqual(lease['fence'], 1)
        other = str(uuid.uuid4())
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_lease_busy'):
            self.store.acquire_sequence(OWNER, SEQUENCE, other, lease_seconds=60)
        # The same worker re-acquires its own live lease without a new fence.
        self.assertEqual(self.store.acquire_sequence(OWNER, SEQUENCE, self.worker, lease_seconds=60)['fence'], 1)
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_stale_fence'):
            self.store.update_sequence(OWNER, SEQUENCE, other, 1, last_attempt_at=5)
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_stale_fence'):
            self.store.update_sequence(OWNER, SEQUENCE, self.worker, 2, last_attempt_at=5)
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_stale_fence'):
            self.store.record_cycle(OWNER, SEQUENCE, other, 1, **self.cycle_fields())
        cycle_id = self.store.record_cycle(OWNER, SEQUENCE, self.worker, 1, **self.cycle_fields())
        released = self.store.update_sequence(OWNER, SEQUENCE, self.worker, 1, release=True, waiting_since=1001, last_attempt_at=1002, next_due_seconds=30)
        self.assertIsNone(released['workerId'])
        self.assertEqual((released['waitingSince'], released['lastAttemptAt']), (1001, 1002))
        # Released: the other worker acquires with the next fence; the old fence is dead.
        self.assertEqual(self.store.acquire_sequence(OWNER, SEQUENCE, other, lease_seconds=60)['fence'], 2)
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_stale_fence'):
            self.store.update_cycle(OWNER, cycle_id, self.worker, 1, state='abandoned', reason='late')
        self.assertEqual(self.store.update_cycle(OWNER, cycle_id, other, 2, state='abandoned', reason='late')['state'], 'abandoned')

    def test_tenant_isolation_and_cycle_immutability(self):
        self.store.ensure_sequence(OWNER, SEQUENCE, address(3), POOL, now=1000)
        lease = self.store.acquire_sequence(OWNER, SEQUENCE, self.worker, lease_seconds=60)
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_not_found'):
            self.store.sequence(address(2), SEQUENCE)
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_reservation_conflict'):
            self.store.ensure_sequence(address(2), SEQUENCE, address(3), POOL, now=1000)
        cycle_id = self.store.record_cycle(OWNER, SEQUENCE, self.worker, lease['fence'], **self.cycle_fields(state='evaluated'))
        self.assertIsNone(self.store.open_cycle(OWNER, SEQUENCE))
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_store_unavailable'):
            # An open state needs an intent the store can reference.
            self.store.update_cycle(OWNER, cycle_id, self.worker, lease['fence'], state='reserved')
        self.store.update_cycle(OWNER, cycle_id, self.worker, lease['fence'], state='abandoned', reason='no_intent', cost={'publication': {'wei': '1'}})
        row = self.store.cycle(OWNER, cycle_id)
        self.assertEqual((row['state'], row['cost']), ('abandoned', {'publication': {'wei': '1'}}))
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_intent_immutable'):
            self.store.update_cycle(OWNER, cycle_id, self.worker, lease['fence'], state='completed')
        self.assertEqual(len(self.store.recent_cycles(OWNER, SEQUENCE, limit=5)), 1)
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_not_found'):
            self.store.cycle(address(2), cycle_id)

    def test_pool_samples_and_controls_are_shared_and_publications_are_read_only_here(self):
        row = {'pool_id': POOL, 'block_number': 10, 'block_hash': identity(30), 'block_timestamp': 1000, 'epoch': identity(31), 'fee_growth0': 5,
               'fee_growth1': 6, 'liquidity': 7, 'tick': 0, 'sqrt_price': 2**96, 'cumulative_fee0': 0, 'cumulative_fee1': 0,
               'cumulative_liquidity_seconds': 0, 'coverage_complete': True, 'qualified': True, 'evidence_id': identity(32), 'sampler_version': 'v1'}
        self.store.insert_sample(OWNER, row)
        self.store.insert_sample(address(2), row)  # idempotent across tenants
        self.assertEqual(int(self.store.latest_sample(address(2), POOL)['block_number']), 10)
        self.assertEqual(len(self.store.samples(OWNER, POOL, since_timestamp=0)), 1)
        self.assertIsNone(self.store.control(OWNER, 'paused'))
        self.store.set_control(OWNER, 'paused', True)
        self.assertIs(self.store.control(address(2), 'paused'), True)
        with self.assertRaises(ExecutionStoreError):
            self.store.set_control(OWNER, 'Paused', True)
        self.assertIsNone(self.store.publication(OWNER, identity(40)))
        with psycopg.connect(**self.pg.settings, user='domino_execution_worker', options='-c search_path=domino_execution') as conn:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute("INSERT INTO publications(observation_id,guard,pool_id,block_number,block_hash,block_timestamp,expires_at,sqrt_price,signer,nonce,envelope,signed_bytes,transaction_hash,state) VALUES(%s,%s,%s,1,%s,10,20,5,%s,0,'{}'::jsonb,%s,%s,'signed')",
                             (identity(40), address(23), POOL, identity(41), address(10), b'\x01', identity(42)))

    def test_readiness_is_fresh_owner_scoped_and_reader_cannot_write_controls(self):
        vault = address(3)
        reader = ExecutionStatusReader(self.pg.settings)
        self.assertFalse(reader.availability(OWNER, vault)['operational'])
        self.store.record_readiness(OWNER, vault, True)
        response = reader.availability(OWNER, vault)
        self.assertTrue(response['operational'])
        self.assertEqual(response['expiresAtEpoch'] - response['checkedAtEpoch'], 10)
        self.assertFalse(reader.availability(address(2), vault)['operational'])
        self.assertFalse(reader.availability(OWNER, address(4))['operational'])
        with self.pg.admin() as conn:
            conn.execute("UPDATE domino_execution.controls SET updated_at=clock_timestamp()-interval '46 seconds' WHERE key=%s", ('automation_ready_' + vault[2:],))
        self.assertFalse(reader.availability(OWNER, vault)['operational'])
        self.store.record_readiness(OWNER, vault, False)
        self.assertFalse(reader.availability(OWNER, vault)['operational'])
        with psycopg.connect(**self.pg.settings, user='domino_execution_reader', options='-c search_path=domino_execution') as conn:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute('UPDATE controls SET value=%s WHERE key=%s', ('{}', 'automation_ready_' + vault[2:]))

    def test_an_expired_publication_leaves_expired_only_when_its_bytes_are_sent_again(self):
        with self.pg.admin() as conn:
            conn.execute("INSERT INTO domino_execution.publications(observation_id,guard,pool_id,block_number,block_hash,block_timestamp,expires_at,sqrt_price,signer,nonce,envelope,signed_bytes,transaction_hash,state) VALUES(%s,%s,%s,1,%s,10,20,5,%s,0,'{}'::jsonb,%s,%s,'signed')",
                         (identity(40), address(23), POOL, identity(41), address(10), b'\x01', identity(42)))
        def move(state):
            with self.pg.admin() as conn:
                conn.execute('UPDATE domino_execution.publications SET state=%s WHERE observation_id=%s', (state, identity(40)))
        move('submitted')
        move('expired')
        # Retired without a receipt: no outcome is written over it directly.
        for state in ('included', 'confirmed', 'reverted', 'attention', 'reorged', 'revoked', 'signed'):
            with self.subTest(state=state), self.assertRaisesRegex(psycopg.errors.CheckViolation, 'execution_state_conflict'):
                move(state)
        # Its bytes sent again, the row is live until its receipt, and can expire again.
        move('broadcast_unknown')
        move('expired')
        move('submitted')
        move('reverted')
        with self.assertRaisesRegex(psycopg.errors.CheckViolation, 'execution_state_conflict'):
            move('submitted')

    def reserve(self, owner, sequence, worker, fence, intent, block, usage, **changes):
        fields = dict(intent_id=intent, pool_id=POOL, block_number=block, zero_for_one=True, amount_in=10**15, cap_raw=3 * 10**15,
                      usage_ppm=usage, window_blocks=256)
        return self.store.reserve_swap(owner, sequence, worker, fence, **{**fields, **changes})

    def test_swap_exposure_is_one_budget_per_pool_shared_by_every_vault_over_the_window(self):
        other_owner, other_sequence = address(2), identity(13)
        self.store.ensure_sequence(OWNER, SEQUENCE, address(3), POOL, now=1000)
        self.store.ensure_sequence(other_owner, other_sequence, address(4), POOL, now=1000)
        mine = self.store.acquire_sequence(OWNER, SEQUENCE, self.worker, lease_seconds=60)['fence']
        theirs_worker = str(uuid.uuid4())
        theirs = self.store.acquire_sequence(other_owner, other_sequence, theirs_worker, lease_seconds=60)['fence']
        self.assertEqual(self.reserve(OWNER, SEQUENCE, self.worker, mine, identity(51), 1000, 600000), {'usedPpm': 600000, 'usagePpm': 600000})
        # Another owner's vault on the same pool shares the budget: 60% + 50% is refused inside the window.
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_swap_cap_exhausted'):
            self.reserve(other_owner, other_sequence, theirs_worker, theirs, identity(52), 1010, 500000)
        self.assertEqual(self.reserve(other_owner, other_sequence, theirs_worker, theirs, identity(52), 1010, 400000)['usedPpm'], 10**6)
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_swap_cap_exhausted'):
            self.reserve(OWNER, SEQUENCE, self.worker, mine, identity(53), 1200, 1)
        # A reservation 256 blocks later no longer sees the first one.
        self.assertEqual(self.reserve(OWNER, SEQUENCE, self.worker, mine, identity(53), 1256, 500000)['usedPpm'], 900000)
        self.assertEqual(self.store.swap_exposure(other_owner, POOL, block_number=1256, window_blocks=256), 900000)
        self.assertEqual(self.store.swap_exposure(OWNER, identity(99), block_number=1256, window_blocks=256), 0)
        # Released only by its own tenant, under the live fence, and only once.
        self.assertFalse(self.store.release_swap(other_owner, other_sequence, theirs_worker, theirs, identity(53)))
        hidden = self.store._transaction(other_owner, lambda conn, owner: conn.execute(
            'UPDATE swap_exposure SET released=true WHERE intent_id=%s RETURNING intent_id', (identity(53),)).fetchone(), worker=theirs_worker, fence=theirs)
        self.assertIsNone(hidden)
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_store_unavailable'):
            self.store._transaction(other_owner, lambda conn, owner: conn.execute(
                'INSERT INTO swap_exposure(reservation_id,intent_id,owner,sequence_hash,pool_id,block_number,zero_for_one,amount_in,cap_raw,usage_ppm) '
                'VALUES(%s,%s,%s,%s,%s,1300,true,1,1,1)', (str(uuid.uuid4()), identity(56), OWNER, other_sequence, POOL)), worker=theirs_worker, fence=theirs)
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_stale_fence'):
            self.store.release_swap(OWNER, SEQUENCE, self.worker, mine + 1, identity(53))
        self.assertTrue(self.store.release_swap(OWNER, SEQUENCE, self.worker, mine, identity(53)))
        self.assertFalse(self.store.release_swap(OWNER, SEQUENCE, self.worker, mine, identity(53)))
        self.assertEqual(self.store.swap_exposure(OWNER, POOL, block_number=1256, window_blocks=256), 400000)
        # A released row cannot come back or be released again (the guard);
        # the worker may change nothing else and delete nothing (its grants).
        for released in ('false', 'true'):
            with self.subTest(released=released), self.assertRaisesRegex(ExecutionStoreError, 'execution_intent_immutable'):
                self.store._transaction(OWNER, lambda conn, owner: conn.execute(
                    f'UPDATE swap_exposure SET released={released} WHERE intent_id=%s AND released', (identity(53),)), worker=self.worker, fence=mine)
        for statement in ('UPDATE swap_exposure SET usage_ppm=1 WHERE intent_id=%s', 'DELETE FROM swap_exposure WHERE intent_id=%s'):
            with self.subTest(statement=statement), self.assertRaisesRegex(ExecutionStoreError, 'execution_store_unavailable'):
                self.store._transaction(OWNER, lambda conn, owner: conn.execute(statement, (identity(51),)), worker=self.worker, fence=mine)
        with psycopg.connect(**self.pg.settings, user='domino_execution_worker', options='-c search_path=domino_execution') as conn:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute('UPDATE swap_exposure SET block_number=0 WHERE intent_id=%s', (identity(51),))
        # One live reservation per intent; a released one does not block the
        # same plan, rebuilt at the same block, from reserving again.
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_reservation_conflict'):
            self.reserve(OWNER, SEQUENCE, self.worker, mine, identity(51), 1300, 1)
        self.assertEqual(self.reserve(OWNER, SEQUENCE, self.worker, mine, identity(53), 1256, 500000)['usedPpm'], 900000)
        self.assertTrue(self.store.release_swap(OWNER, SEQUENCE, self.worker, mine, identity(53)))
        # A stale lease reserves nothing; malformed shares are refused before the database.
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_stale_fence'):
            self.reserve(OWNER, SEQUENCE, self.worker, mine + 1, identity(54), 1300, 1)
        for bad in ({'usage_ppm': 0}, {'usage_ppm': 10**6 + 1}, {'window_blocks': 257}, {'amount_in': 0}, {'cap_raw': 0}, {'zero_for_one': 1}):
            with self.subTest(bad=bad), self.assertRaisesRegex(ExecutionStoreError, 'execution_invalid_record'):
                self.reserve(OWNER, SEQUENCE, self.worker, mine, identity(55), 1300, 1, **bad)

    def test_the_window_holds_exactly_its_blocks(self):
        self.store.ensure_sequence(OWNER, SEQUENCE, address(3), POOL, now=1000)
        fence = self.store.acquire_sequence(OWNER, SEQUENCE, self.worker, lease_seconds=60)['fence']
        self.reserve(OWNER, SEQUENCE, self.worker, fence, identity(61), 2000, 600000)
        # A stale lease learns nothing of the budget: its fence is checked first.
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_stale_fence'):
            self.reserve(OWNER, SEQUENCE, self.worker, fence + 1, identity(62), 2001, 500000)
        # 256 blocks from 2000 to 2255: the first share still counts at its last block ...
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_swap_cap_exhausted'):
            self.reserve(OWNER, SEQUENCE, self.worker, fence, identity(62), 2255, 500000)
        self.assertEqual(self.store.swap_exposure(OWNER, POOL, block_number=2255, window_blocks=256), 600000)
        # ... and no longer one block later.
        self.assertEqual(self.reserve(OWNER, SEQUENCE, self.worker, fence, identity(62), 2256, 500000)['usedPpm'], 500000)
        # The window runs both ways: a swap observed 255 blocks later can land
        # in the same block as one observed now; 256 blocks later it cannot.
        self.assertEqual(self.store.swap_exposure(OWNER, POOL, block_number=2001, window_blocks=256), 1100000)
        self.assertEqual(self.store.swap_exposure(OWNER, POOL, block_number=1745, window_blocks=256), 600000)
        self.assertEqual(self.store.swap_exposure(OWNER, POOL, block_number=1744, window_blocks=256), 0)
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_swap_cap_exhausted'):
            self.reserve(OWNER, SEQUENCE, self.worker, fence, identity(63), 2001, 1)
        # A share names its own sequence's pool, nothing else.
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_state_conflict'):
            self.reserve(OWNER, SEQUENCE, self.worker, fence, identity(64), 5000, 1, pool_id=identity(98))
        for bad in ({'block_number': -1}, {'window_blocks': 0}):
            with self.subTest(bad=bad), self.assertRaisesRegex(ExecutionStoreError, 'execution_invalid_record'):
                self.store.swap_exposure(OWNER, POOL, **{'block_number': 10, 'window_blocks': 256, **bad})

    def test_reservations_on_one_pool_wait_for_each_other(self):
        # Another vault's reservation holds the pool's lock: this one waits for
        # it, and gives up at the store's lock timeout instead of reading a sum
        # the other is about to change.
        self.store.ensure_sequence(OWNER, SEQUENCE, address(3), POOL, now=1000)
        fence = self.store.acquire_sequence(OWNER, SEQUENCE, self.worker, lease_seconds=60)['fence']
        with self.pg.admin() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('swap_exposure:'||%s,0))", (POOL,))
            with self.assertRaisesRegex(ExecutionStoreError, 'execution_store_unavailable'):
                self.reserve(OWNER, SEQUENCE, self.worker, fence, identity(71), 3000, 1)
        # Another pool's lock is not this one's.
        with self.pg.admin() as conn:
            conn.execute("SELECT pg_advisory_xact_lock(hashtextextended('swap_exposure:'||%s,0))", (identity(99),))
            self.assertEqual(self.reserve(OWNER, SEQUENCE, self.worker, fence, identity(71), 3000, 1)['usedPpm'], 1)

    def test_attempts_count_only_cycles_that_paid_for_a_publication(self):
        self.store.ensure_sequence(OWNER, SEQUENCE, address(3), POOL, now=1000)
        fence = self.store.acquire_sequence(OWNER, SEQUENCE, self.worker, lease_seconds=60)['fence']
        self.assertEqual(self.store.attempt_history(OWNER, SEQUENCE), (0, 0))
        paid = {'gasUsedRaw': '157278', 'effectiveGasPriceRaw': '10000000', 'wei': '1572780000000'}
        for reason, cost in (('replan_wait', {}), ('publication_reverted', {'publication': {'state': 'reverted', **paid}}),
                             ('price_outside_plan_band', {'publication': {'state': 'included', **paid}}), ('publish_failed', {'latency': {}}),
                             ('publication_expired', {'publication': {'state': 'expired'}})):  # sent, never included: nothing paid
            cycle = self.store.record_cycle(OWNER, SEQUENCE, self.worker, fence, **self.cycle_fields())
            self.store.update_cycle(OWNER, cycle, self.worker, fence, state='abandoned', reason=reason, cost=cost)
        self.store.record_cycle(OWNER, SEQUENCE, self.worker, fence, **self.cycle_fields())  # still evaluated
        self.assertEqual(self.store.attempt_history(OWNER, SEQUENCE), (2, 0))
        self.assertEqual(self.store.attempt_history(OWNER, SEQUENCE, limit=1), (1, 0))
        self.assertEqual(self.store.attempt_history(address(2), SEQUENCE), (0, 0))
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_invalid_record'):
            self.store.attempt_history(OWNER, SEQUENCE, limit=0)
        # The failure count is a scheduling field under the live lease.
        state = self.store.update_sequence(OWNER, SEQUENCE, self.worker, fence, consecutive_failures=3, next_due_seconds=40)
        self.assertEqual(state['consecutiveFailures'], 3)
        self.assertGreater(state['nextDueEpoch'], 0)
        with self.assertRaisesRegex(ExecutionStoreError, 'execution_store_unavailable'):
            self.store.update_sequence(OWNER, SEQUENCE, self.worker, fence, consecutive_failures=-1)


if __name__ == '__main__':
    unittest.main()
