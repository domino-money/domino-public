"""Deposit maintenance under FORCE RLS with a non-bypass migration owner."""
from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import sys
import tempfile
import unittest
import uuid

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from deposit_store import DepositStore, ROLE
from deposit_archive import archive_terminal
from dev_postgres import ADMIN, PORT, ROOT, SOCKET
import test_deposit_store as store_tests
from test_deposit_store import OWNER, OTHER


@unittest.skipUnless(os.environ.get('DOMINO_TEST_POSTGRES') == '1', 'requires task-local PostgreSQL')
class DepositMigrationOwnerTests(unittest.TestCase):
    create = store_tests.DepositStoreTests.create
    issue = store_tests.DepositStoreTests.issue
    reconcile = store_tests.DepositStoreTests.reconcile
    error = store_tests.DepositStoreTests.error

    def setUp(self):
        suffix = uuid.uuid4().hex[:12]
        self.migration_owner = 'domino_deposit_owner_' + suffix
        database = 'domino_deposit_migration_' + suffix
        control = psycopg.connect(host=str(SOCKET), port=PORT, dbname='postgres', user=ADMIN, autocommit=True)
        def cleanup():
            try:
                control.execute(sql.SQL('DROP DATABASE IF EXISTS {} WITH (FORCE)').format(sql.Identifier(database)))
                control.execute(sql.SQL('DROP ROLE IF EXISTS {}').format(sql.Identifier(self.migration_owner)))
            finally:
                control.close()
        self.addCleanup(cleanup)
        control.execute(sql.SQL('CREATE ROLE {} LOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT NOCREATEDB NOCREATEROLE').format(
            sql.Identifier(self.migration_owner)))
        control.execute(sql.SQL('CREATE DATABASE {} OWNER {}').format(sql.Identifier(database), sql.Identifier(self.migration_owner)))
        self.settings = {'host': str(SOCKET), 'port': PORT, 'dbname': database}
        self.admin = psycopg.connect(**self.settings, user=ADMIN, autocommit=True, row_factory=dict_row)
        self.addCleanup(self.admin.close)
        self.migrator = psycopg.connect(**self.settings, user=self.migration_owner, autocommit=True, row_factory=dict_row)
        self.addCleanup(self.migrator.close)
        self.migrate()
        self.store = DepositStore(self.settings)

    def migrate(self):
        for name in ('009_direct_deposits.sql', '010_deposit_recovery.sql'):
            self.migrator.execute((ROOT / 'migrations' / name).read_text())

    def age(self, record, days=8):
        # Test-admin fixture replacement bypasses the immutable creation clock.
        row = self.admin.execute('SELECT * FROM domino_deposits.intents WHERE id=%s', (record['id'],)).fetchone()
        self.admin.execute('DELETE FROM domino_deposits.intents WHERE id=%s', (record['id'],))
        row.update(created_at=datetime.now(timezone.utc)-timedelta(days=days),
                   updated_at=datetime.now(timezone.utc)-timedelta(days=days))
        columns = list(row)
        self.admin.execute('INSERT INTO domino_deposits.intents ('+','.join(columns)+') VALUES ('+
            ','.join(['%s']*len(columns))+')', tuple(Jsonb(row[k]) if k in ('selection','history') else row[k] for k in columns))

    def test_limited_owner_enforces_quotas_and_replay_counts_all_owners(self):
        role = self.admin.execute('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=%s',
                                  (self.migration_owner,)).fetchone()
        self.assertEqual(role, {'rolsuper': False, 'rolbypassrls': False})
        first = [self.create() for _ in range(16)]
        self.error('deposit_owner_capacity_busy', self.create)
        self.create(OTHER)
        self.create(OTHER)
        self.migrate()
        self.assertEqual(self.migrator.execute('SELECT count(*) AS n FROM domino_deposits.intents').fetchone()['n'], 18)
        self.assertEqual(self.admin.execute('SELECT used,retained FROM domino_deposits.capacity').fetchone(),
                         {'used': 18, 'retained': 18})
        for record in first:
            self.store.cancel(OWNER, record['id'], record['version'])
        for _ in range(128-16):
            record = self.create()
            self.store.cancel(OWNER, record['id'], record['version'])
        self.error('deposit_owner_history_full', self.create)
        self.migrate()
        self.assertEqual(self.admin.execute('SELECT used,retained FROM domino_deposits.capacity').fetchone(),
                         {'used': 2, 'retained': 130})
        self.create(OTHER)

    def test_limited_owner_expiry_is_scoped_and_application_privileges_stay_private(self):
        expired = self.create()
        foreign = self.create(OTHER)
        issued = self.reconcile(self.issue(self.create()))
        for record in (expired, foreign, issued):
            self.age(record)
        recent = self.create()
        self.error('deposit_not_found', lambda: self.store.get(OWNER, expired['id']))
        self.assertEqual(self.store.get(OTHER, foreign['id'])['id'], foreign['id'])
        self.assertEqual(self.store.get(OWNER, issued['id'])['history'], issued['history'])
        self.assertEqual(self.store.get(OWNER, recent['id'])['id'], recent['id'])
        with psycopg.connect(**self.settings, user=ROLE, autocommit=True, row_factory=dict_row) as conn:
            conn.execute("SELECT set_config('domino.deposit_owner',%s,false)", (OWNER,))
            self.assertEqual(conn.execute('SELECT id FROM domino_deposits.intents WHERE id=%s', (foreign['id'],)).fetchall(), [])
            self.assertEqual(conn.execute('UPDATE domino_deposits.intents SET state=%s WHERE id=%s',
                                          ('cancelled', foreign['id'])).rowcount, 0)
            for query in (sql.SQL('SET ROLE {}').format(sql.Identifier(self.migration_owner)),
                          sql.SQL('DELETE FROM domino_deposits.intents')):
                with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                    conn.execute(query)
        self.migrate()
        self.assertEqual(self.admin.execute('SELECT used,retained FROM domino_deposits.capacity').fetchone(),
                         {'used': 2, 'retained': 3})

    def test_migration_rejects_application_membership_in_maintenance_owner(self):
        self.admin.execute(sql.SQL('GRANT {} TO {}').format(sql.Identifier(self.migration_owner), sql.Identifier(ROLE)))
        try:
            with self.assertRaisesRegex(psycopg.errors.RaiseException, 'deposit_maintenance_owner_required'):
                self.migrator.execute((ROOT / 'migrations/010_deposit_recovery.sql').read_text())
        finally:
            self.admin.execute(sql.SQL('REVOKE {} FROM {}').format(sql.Identifier(self.migration_owner), sql.Identifier(ROLE)))

    def test_limited_owner_can_lock_and_archive_but_policy_rejects_update_images(self):
        old = self.reconcile(self.issue(self.create()))
        self.age(old, days=100)
        with self.assertRaises(psycopg.errors.InsufficientPrivilege):
            self.migrator.execute('UPDATE domino_deposits.intents SET version=version+1 WHERE id=%s', (old['id'],))
        with tempfile.TemporaryDirectory() as directory:
            result = archive_terminal(self.settings, directory, operator_role=self.migration_owner)
        self.assertEqual(result['archived'], 1)
        self.error('deposit_not_found', lambda: self.store.get(OWNER, old['id']))
        self.assertEqual(self.admin.execute('SELECT used,retained FROM domino_deposits.capacity').fetchone(),
                         {'used': 0, 'retained': 0})
