"""Real PostgreSQL regressions for bounded all-owner draft reclamation (#41)."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path
import sys
import unittest
import uuid

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deposit_store import ROLE
from dev_postgres import ADMIN, ROOT
import test_deposit_migration_owner as owner_tests
import test_deposit_store as store_tests
from test_deposit_store import OWNER, OTHER, SELECTION


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires task-local PostgreSQL')
class DepositGlobalCapacityTests(unittest.TestCase):
    # Each test owns a disposable database and a NOSUPERUSER/NOBYPASSRLS DDL
    # owner. Production service calls still use the limited application role.
    setUp = owner_tests.DepositMigrationOwnerTests.setUp
    create = store_tests.DepositStoreTests.create
    issue = store_tests.DepositStoreTests.issue
    reconcile = store_tests.DepositStoreTests.reconcile
    error = store_tests.DepositStoreTests.error
    age = owner_tests.DepositMigrationOwnerTests.age

    def migrate(self):
        for name in ('009_direct_deposits.sql', '010_deposit_recovery.sql',
                     '014_deposit_draft_recovery.sql'):
            self.migrator.execute((ROOT / 'migrations' / name).read_text())

    def seed(self, count, *, state='draft', days=8, per_owner=16, offset=1,
             owner=None, history=None):
        """Synthetic absent owners; real INSERT triggers enforce every quota."""
        owner_expression = '%s' if owner else "'0x'||lpad(to_hex(%s+(n-1)/%s),40,'0')"
        owners = [owner] if owner else [offset, per_owner]
        fingerprint = hashlib.sha256(json.dumps(SELECTION, sort_keys=True,
            separators=(',', ':')).encode()).hexdigest()
        self.admin.execute('''INSERT INTO domino_deposits.intents
          (id,owner,idempotency_key,selection,selection_hash,state,version,history,created_at,updated_at)
          SELECT gen_random_uuid(),''' + owner_expression + ''',gen_random_uuid(),%s,%s,%s,1,%s,
            clock_timestamp()-(%s*interval '1 day'),clock_timestamp()-(%s*interval '1 day')
          FROM generate_series(1,%s) AS n''', owners + [Jsonb(SELECTION), fingerprint, state,
            Jsonb(history or []), days, days, count])

    def counts(self):
        result = self.admin.execute('SELECT used,retained FROM domino_deposits.capacity').fetchone()
        actual = self.admin.execute('''SELECT count(*) AS retained,count(*) FILTER(WHERE outstanding
          OR state IN ('draft','awaiting_wallet','pending','cancel_requested','attention')) AS used
          FROM domino_deposits.intents''').fetchone()
        self.assertEqual(result, actual)
        return result

    def service(self, *, owner=OWNER):
        conn = psycopg.connect(**self.settings, user=ROLE, autocommit=True, row_factory=dict_row)
        self.addCleanup(conn.close)
        if owner is not None:
            conn.execute("SELECT set_config('domino.deposit_owner',%s,false)", (owner,))
        return conn

    def sweep(self, *, owner=OWNER):
        return self.service(owner=owner).execute('SELECT domino_deposits.expire_unissued() AS n').fetchone()['n']

    def test_625_absent_owners_release_global_active_capacity_for_new_owner(self):
        self.seed(10000)
        self.assertEqual(self.counts(), {'used': 10000, 'retained': 10000})
        self.assertEqual(self.admin.execute('SELECT count(DISTINCT owner) AS n FROM domino_deposits.intents')
                         .fetchone()['n'], 625)
        created = self.create(OTHER)
        self.assertEqual(created['owner'], OTHER)
        self.assertEqual(self.counts(), {'used': 9969, 'retained': 9969})

    def test_cancelled_backlog_cannot_starve_global_active_slot_recovery(self):
        self.seed(10000)
        self.seed(64, state='cancelled', days=9, per_owner=128, offset=1000)
        self.create(OTHER)
        self.assertEqual(self.counts(), {'used': 10000, 'retained': 10033})
        self.assertEqual(self.admin.execute("SELECT count(*) AS n FROM domino_deposits.intents WHERE state='cancelled'")
                         .fetchone()['n'], 33)

    def test_50000_retained_cancelled_rows_recover_after_seven_days_without_archive(self):
        self.seed(50000, state='cancelled', per_owner=128)
        self.assertEqual(self.counts(), {'used': 0, 'retained': 50000})
        self.create(OTHER)
        self.assertEqual(self.counts(), {'used': 1, 'retained': 49969})

    def test_caller_quota_recovers_and_oldest_absent_history_progresses(self):
        self.seed(96, state='cancelled', days=9, per_owner=128)
        self.seed(112, state='cancelled', owner=OWNER, per_owner=128)
        self.seed(16, owner=OWNER)
        self.assertEqual(self.counts(), {'used': 16, 'retained': 224})
        for _ in range(3):
            self.create()
        # Two priority slots cannot starve older cancelled rows: the remaining
        # 30 slots per successful call advance that absent owner's backlog.
        self.assertEqual(self.admin.execute('SELECT count(*) AS n FROM domino_deposits.intents WHERE owner<>%s',
                         (OWNER,)).fetchone()['n'], 6)
        self.assertEqual(self.counts(), {'used': 13, 'retained': 131})

    def test_issued_artifacts_chain_evidence_and_recent_rows_are_never_reaped(self):
        issued = self.issue(self.create())
        finalized = self.reconcile(issued)
        self.age(finalized, days=100)
        recent = self.create(OTHER)
        # Even malformed/nonstandard retained evidence is fail-closed: history
        # must be exactly empty, not merely lack a recognised artifact field.
        for state in ('draft', 'cancelled', 'confirmed', 'reverted', 'superseded', 'attention'):
            self.seed(1, owner=OTHER, state=state, days=100, history=[{'receipt': {'opaque': 'keep'}}])
        self.seed(1, owner=OTHER, state='attention', days=100)
        protected = self.admin.execute('SELECT * FROM domino_deposits.intents ORDER BY id').fetchall()
        self.seed(40, state='cancelled', days=8, per_owner=128)
        self.assertEqual(self.sweep(), 32)
        self.assertEqual(self.sweep(), 8)
        self.assertEqual(self.sweep(), 0)
        self.assertEqual(self.admin.execute('SELECT * FROM domino_deposits.intents ORDER BY id').fetchall(), protected)
        self.assertEqual(self.store.get(OWNER, finalized['id'])['history'], finalized['history'])
        self.assertEqual(self.store.get(OTHER, recent['id'])['id'], recent['id'])
        self.counts()

    def test_unexpired_rows_and_issued_history_still_enforce_finite_retention(self):
        # 128 issued rows younger than the 90-day archive threshold remain a
        # real admission limit. An artifact timeout does not erase evidence.
        self.seed(128, owner=OWNER, state='confirmed', days=8, per_owner=128,
                  history=[{'artifact': {'opaque': 'issued'}}])
        self.assertEqual(self.sweep(), 0)
        self.error('deposit_owner_history_full', self.create)
        self.seed(16, owner=OTHER, days=1)
        self.error('deposit_owner_capacity_busy', lambda: self.create(OTHER))
        self.assertEqual(self.counts(), {'used': 16, 'retained': 144})

    def test_idempotent_retry_does_not_consume_capacity_and_conflict_rolls_back_cleanup(self):
        key = str(uuid.uuid4())
        original = self.create(key=key)
        self.seed(32)
        self.assertEqual(self.create(key=key), original)
        self.assertEqual(self.counts(), {'used': 1, 'retained': 1})
        self.seed(32, offset=100)
        before = self.admin.execute('SELECT * FROM domino_deposits.intents ORDER BY id').fetchall()
        changed = deepcopy(SELECTION)
        changed['amountRaw'] = '99'
        self.error('deposit_idempotency_conflict', lambda: self.create(key=key, selection=changed))
        self.assertEqual(self.admin.execute('SELECT * FROM domino_deposits.intents ORDER BY id').fetchall(), before)
        self.assertEqual(self.counts(), {'used': 33, 'retained': 33})

    def test_concurrent_retries_reclaim_bounded_batches_and_insert_once(self):
        self.seed(128)
        key = str(uuid.uuid4())
        with ThreadPoolExecutor(max_workers=4) as workers:
            values = list(workers.map(lambda _: self.create(key=key), range(4)))
        self.assertEqual(len({v['id'] for v in values}), 1)
        self.assertEqual(self.counts(), {'used': 1, 'retained': 1})

    def test_owner_quota_failure_rolls_back_foreign_cleanup_and_new_owner_can_recover(self):
        self.seed(16, owner=OWNER, days=1)
        self.seed(40)
        before = self.admin.execute('SELECT * FROM domino_deposits.intents ORDER BY id').fetchall()
        self.error('deposit_owner_capacity_busy', self.create)
        self.assertEqual(self.admin.execute('SELECT * FROM domino_deposits.intents ORDER BY id').fetchall(), before)
        self.assertEqual(self.counts(), {'used': 56, 'retained': 56})
        self.create(OTHER)
        self.assertEqual(self.counts(), {'used': 25, 'retained': 25})

    def test_expired_never_issued_key_can_be_reused_but_issued_key_stays_bound(self):
        original = self.create()
        self.age(original)
        self.create(OTHER)
        repeated = self.create(key=original['idempotencyKey'])
        self.assertNotEqual(repeated['id'], original['id'])
        self.assertEqual(self.create(key=repeated['idempotencyKey']), repeated)
        issued = self.reconcile(self.issue(repeated))
        self.age(issued, days=100)
        self.assertEqual(self.sweep(), 0)
        self.assertEqual(self.create(key=issued['idempotencyKey'])['history'], issued['history'])
        self.error('deposit_idempotency_conflict', lambda: self.create(key=issued['idempotencyKey'],
                   selection={**SELECTION, 'amountRaw': '99'}))
        self.counts()

    def test_sweep_uses_admission_lock_and_rollback_restores_rows_and_counters(self):
        self.seed(40)
        conn = self.service()
        conn.execute('BEGIN')
        self.assertEqual(conn.execute('SELECT domino_deposits.expire_unissued() AS n').fetchone()['n'], 32)
        # A second service transaction cannot insert through the maintenance
        # critical section; MVCC readers still see the pre-transaction evidence.
        self.assertEqual(self.counts(), {'used': 40, 'retained': 40})
        self.error('deposit_capacity_busy', lambda: self.create(OTHER))
        conn.execute('ROLLBACK')
        self.assertEqual(self.counts(), {'used': 40, 'retained': 40})
        self.create(OTHER)
        self.assertEqual(self.counts(), {'used': 9, 'retained': 9})

    def test_context_and_execute_privileges_do_not_grant_arbitrary_deletion_or_tenant_access(self):
        self.seed(1, owner=OTHER)
        row = self.admin.execute('SELECT id FROM domino_deposits.intents').fetchone()['id']
        for owner in (None, '', 'malformed', '0x'+'AA'*20):
            with self.assertRaisesRegex(psycopg.errors.InsufficientPrivilege, 'deposit_owner_context_required'):
                self.sweep(owner=owner)
        conn = self.service()
        self.assertEqual(conn.execute('SELECT id FROM domino_deposits.intents WHERE id=%s', (row,)).fetchall(), [])
        self.assertEqual(conn.execute("UPDATE domino_deposits.intents SET state='cancelled' WHERE id=%s", (row,)).rowcount, 0)
        for query in ('DELETE FROM domino_deposits.intents', 'TRUNCATE domino_deposits.intents',
                      'UPDATE domino_deposits.capacity SET used=0',
                      sql.SQL('SET ROLE {}').format(sql.Identifier(self.migration_owner))):
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                conn.execute(query)
        for role in ('domino_session_auth', 'domino_catalogue_reader', 'domino_catalogue_writer'):
            with psycopg.connect(**self.settings, user=role, autocommit=True) as unrelated:
                unrelated.execute("SELECT set_config('domino.deposit_owner',%s,false)", (OWNER,))
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    unrelated.execute('SELECT domino_deposits.expire_unissued()')
        self.assertEqual(self.sweep(), 1)
        self.assertEqual(self.counts(), {'used': 0, 'retained': 0})

    def test_upgrade_is_idempotent_preserves_force_rls_and_rejects_application_membership(self):
        self.seed(3)
        before = self.admin.execute('SELECT * FROM domino_deposits.intents ORDER BY id').fetchall()
        migration = (ROOT / 'migrations/014_deposit_draft_recovery.sql').read_text()
        self.migrator.execute(migration)
        self.migrator.execute(migration)
        self.assertEqual(self.admin.execute('SELECT * FROM domino_deposits.intents ORDER BY id').fetchall(), before)
        self.assertEqual(self.counts(), {'used': 3, 'retained': 3})
        self.assertEqual(self.admin.execute('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=%s',
                         (self.migration_owner,)).fetchone(), {'rolsuper': False, 'rolbypassrls': False})
        self.assertEqual(self.admin.execute("SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='domino_deposits.intents'::regclass")
                         .fetchone(), {'relrowsecurity': True, 'relforcerowsecurity': True})
        self.admin.execute(sql.SQL('GRANT {} TO {}').format(sql.Identifier(self.migration_owner), sql.Identifier(ROLE)))
        try:
            with self.assertRaisesRegex(psycopg.errors.RaiseException, 'deposit_maintenance_owner_required'):
                self.migrator.execute(migration)
        finally:
            self.admin.execute(sql.SQL('REVOKE {} FROM {}').format(sql.Identifier(self.migration_owner), sql.Identifier(ROLE)))
        self.assertEqual(self.sweep(), 3)

    def test_upgrade_rejects_a_different_capacity_function_owner(self):
        self.admin.execute(sql.SQL('ALTER FUNCTION domino_deposits.release_capacity() OWNER TO {}').format(
            sql.Identifier(ADMIN)))
        try:
            with self.assertRaisesRegex(psycopg.errors.RaiseException, 'deposit_maintenance_owner_required'):
                self.migrator.execute((ROOT / 'migrations/014_deposit_draft_recovery.sql').read_text())
        finally:
            self.admin.execute(sql.SQL('ALTER FUNCTION domino_deposits.release_capacity() OWNER TO {}').format(
                sql.Identifier(self.migration_owner)))


if __name__ == '__main__':
    unittest.main()
