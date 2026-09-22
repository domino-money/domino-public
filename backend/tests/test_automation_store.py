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
            conn.execute('ALTER ROLE domino_execution_publisher LOGIN')

    def setUp(self):
        with self.pg.admin() as conn:
            conn.execute('TRUNCATE domino_execution.cycles,domino_execution.sequence_state,domino_execution.pool_samples,domino_execution.controls,domino_execution.publications,'
                         'domino_execution.publisher_heads,domino_execution.withdrawals,domino_execution.withdrawal_debits,domino_execution.ledger_exceptions,domino_execution.ledger_cursors CASCADE')
        self.store = CycleStore(self.pg.settings)
        self.worker = str(uuid.uuid4())

    def cycle_fields(self, **changes):
        return {'state': 'evaluated', 'reason': 'wait', 'config_version': 'test-1', 'fingerprint': identity(21), 'observation_hash': identity(22),
                'source_block_number': 5, 'source_block_hash': identity(23), 'decision': {'action': 'wait'}, **changes}

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


if __name__ == '__main__':
    unittest.main()
