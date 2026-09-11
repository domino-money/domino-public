"""Opt-in PostgreSQL catalogue probes in a disposable cluster, never staging.

DOMINO_TEST_STAGING_POSTGRES=1, DOMINO_PG_BIN=<directory with PG16+ tools>.
No installer, dev_postgres, providers, TCP listeners or application processes.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import catalogue_inventory as inventory
import check_roles
import prepare_disabled


@unittest.skipUnless(os.environ.get('DOMINO_TEST_STAGING_POSTGRES') == '1',
                     'opt-in disposable PostgreSQL cluster')
class CataloguePostgresTests(unittest.TestCase):
    @classmethod
    def run_tool(cls, name, *args, data=None):
        result = subprocess.run([str(cls.bin / name), *args], input=data, text=True,
            capture_output=True, timeout=30, env={'PATH': '/usr/bin:/bin', 'LC_ALL': 'C',
                                                'PGOPTIONS': prepare_disabled.ENV['PGOPTIONS']})
        if result.returncode:
            raise AssertionError(f'{name} failed: {result.stderr}')
        return result.stdout.strip()

    @classmethod
    def query(cls, sql, *, database='domino_catalogue', role='postgres'):
        return cls.run_tool('psql', '-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1',
            '-h', str(cls.socket), '-p', '18777', '-U', role, '-d', database, '-f', '-', data=sql)

    @classmethod
    def stop_cluster(cls):
        # Register before startup so a partial pg_ctl failure cannot leave the
        # fixture behind. The unique, owned directory is the only target.
        if (cls.data / 'postmaster.pid').exists():
            cls.run_tool('pg_ctl', '-D', str(cls.data), '-m', 'immediate', '-w', 'stop')

    @classmethod
    def setUpClass(cls):
        cls.bin = Path(os.environ['DOMINO_PG_BIN'])
        cls.run_tool('initdb', '--version')
        cls.temp = tempfile.TemporaryDirectory(prefix='dm-stage-', dir='/tmp')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.base = Path(cls.temp.name)
        cls.socket = cls.base / 'socket'
        cls.socket.mkdir(mode=0o700)
        cls.data = cls.base / 'data'
        cls.run_tool('initdb', '-D', str(cls.data), '-U', 'postgres', '-A', 'trust',
                     '--encoding=UTF8', '--locale=C', '--no-instructions')
        cls.addClassCleanup(cls.stop_cluster)
        # The directory is unique; port selects only a private Unix socket.
        cls.run_tool('pg_ctl', '-D', str(cls.data), '-l', str(cls.base / 'postgres.log'),
                     '-o', f"-F -k {cls.socket} -p 18777 -c listen_addresses=''", '-w', 'start')
        cls.query(''.join(f'CREATE ROLE {role} LOGIN NOINHERIT;' for role in check_roles.ROLES)
                  + 'CREATE ROLE unrelated;', database='postgres')
        cls.query('CREATE DATABASE domino_catalogue OWNER domino_catalogue_admin;', database='postgres')
        cls.query('REVOKE ALL ON DATABASE domino_catalogue FROM PUBLIC;'
                  'GRANT CONNECT ON DATABASE domino_catalogue TO '
                  + ','.join(check_roles.ROLES[:-1]) + ';')
        cls.foundation = json.loads(cls.query(inventory.inventory_sql(), role=inventory.ADMIN))
        cls.empty_foundation = cls.query('SELECT ' + prepare_disabled.EMPTY + ';')
        cls.query('GRANT CONNECT ON DATABASE domino_catalogue TO domino_deposit_service;')
        repo = Path(__file__).resolve().parents[3]
        migrations = '\n'.join((repo / path).read_text() for path in prepare_disabled.MIGRATIONS)
        cls.query('BEGIN;\n' + migrations + '\nCOMMIT;', role=inventory.ADMIN)

    def test_foundation_and_exact_migrations_are_accepted(self):
        self.assertEqual(self.empty_foundation, 't')
        self.assertTrue(all(inventory.check_inventory(self.foundation, installed=False).values()), self.foundation)
        data = json.loads(self.query(inventory.inventory_sql(), role=inventory.ADMIN))
        self.assertTrue(all(inventory.check_inventory(data, installed=True).values()), data)
        self.assertEqual(data['defaultAclCount'], 0, 'schema-local REVOKEs must leave no overrides')
        metadata = json.loads(self.query(check_roles.metadata_sql(), role=inventory.ADMIN))
        self.assertTrue(all(check_roles.check_metadata(metadata).values()), metadata)
        for role in check_roles.ROLES:
            with self.subTest(role=role):
                acl = json.loads(self.query(check_roles.acl_sql(role), role=inventory.ADMIN))
                self.assertEqual(acl['failures'], [])

    def test_catalogue_mutations_are_rejected_and_rolled_back(self):
        cases = [
            ('databasePublicConnect', 'GRANT CONNECT ON DATABASE domino_catalogue TO PUBLIC', 'completeDatabaseAcl'),
            ('databaseUnknownRole', 'GRANT CONNECT ON DATABASE domino_catalogue TO unrelated', 'completeDatabaseAcl'),
            ('databaseCreate', 'GRANT CREATE ON DATABASE domino_catalogue TO domino_session_auth', 'completeDatabaseAcl'),
            ('databaseTemp', 'GRANT TEMPORARY ON DATABASE domino_catalogue TO domino_catalogue_reader', 'completeDatabaseAcl'),
            ('databaseGrantOption', 'GRANT CONNECT ON DATABASE domino_catalogue TO domino_deposit_service WITH GRANT OPTION', 'completeDatabaseAcl'),
            ('databaseMissingConnect', 'REVOKE CONNECT ON DATABASE domino_catalogue FROM domino_deposit_service', 'completeDatabaseAcl'),
            ('publicCreate', 'GRANT CREATE ON SCHEMA public TO PUBLIC', 'completeSchemaAcl'),
            ('systemSchema', 'GRANT CREATE ON SCHEMA pg_catalog TO unrelated', 'completeSchemaAcl'),
            ('privateSchema', 'GRANT USAGE ON SCHEMA domino_sessions TO unrelated', 'completeSchemaAcl'),
            ('schemaGrantOption', 'GRANT USAGE ON SCHEMA domino_catalogue TO domino_catalogue_reader WITH GRANT OPTION', 'completeSchemaAcl'),
            ('schemaMissingUsage', 'REVOKE USAGE ON SCHEMA domino_activity FROM domino_catalogue_reader', 'completeSchemaAcl'),
            ('schemaOwner', 'ALTER SCHEMA domino_deposits OWNER TO postgres', 'completeSchemaInventory'),
            ('extraEmptySchema', 'CREATE SCHEMA extra', 'completeSchemaInventory'),
            ('extraPgSchema', "SET allow_system_table_mods=on; CREATE SCHEMA pg_extra", 'completeSchemaInventory'),
            ('defaultTables', 'ALTER DEFAULT PRIVILEGES FOR ROLE domino_catalogue_admin IN SCHEMA domino_sessions GRANT SELECT ON TABLES TO unrelated', 'noDefaultAclOverrides'),
            ('defaultGlobalFunctions', 'ALTER DEFAULT PRIVILEGES FOR ROLE domino_catalogue_admin REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC', 'noDefaultAclOverrides'),
            ('defaultOtherRole', 'ALTER DEFAULT PRIVILEGES FOR ROLE unrelated GRANT SELECT ON TABLES TO PUBLIC', 'noDefaultAclOverrides'),
            ('roleTriggerBypass', "ALTER ROLE domino_session_auth SET session_replication_role='replica'", 'noPersistentRoleDatabaseSettings'),
            ('roleSearchPath', "ALTER ROLE domino_catalogue_admin SET search_path='public'", 'noPersistentRoleDatabaseSettings'),
            ('roleInDatabase', "ALTER ROLE domino_deposit_service IN DATABASE domino_catalogue SET search_path='public'", 'noPersistentRoleDatabaseSettings'),
            ('databaseSetting', "ALTER DATABASE domino_catalogue SET search_path='public'", 'noPersistentRoleDatabaseSettings'),
            ('otherDatabase', "ALTER ROLE unrelated IN DATABASE postgres SET search_path='public'", 'noPersistentRoleDatabaseSettings'),
            ('globalSetting', "ALTER ROLE ALL SET search_path='public'", 'noPersistentRoleDatabaseSettings'),
        ]
        for name, mutation, check in cases:
            with self.subTest(name=name):
                data = json.loads(self.query('BEGIN; ' + mutation + ';\n'
                                             + inventory.inventory_sql() + '\nROLLBACK;'))
                self.assertFalse(inventory.check_inventory(data, installed=True)[check])
                if name in ('extraEmptySchema', 'databasePublicConnect', 'roleTriggerBypass', 'defaultTables'):
                    # Actual prior metadata boundary misses these exact states;
                    # the added catalogue inventory provides the rejection.
                    legacy = json.loads(self.query('BEGIN; ' + mutation + ';\n'
                                                  + check_roles.metadata_sql() + '\nROLLBACK;'))
                    self.assertTrue(all(check_roles.check_metadata(legacy).values()))
                restored = json.loads(self.query(inventory.inventory_sql()))
                self.assertTrue(all(inventory.check_inventory(restored, installed=True).values()))

    def test_empty_database_guard_rejects_overrides_without_objects(self):
        # Another empty database proves preflight/transaction guards reject
        # dangerous persistent settings even before any application schema exists.
        self.query('CREATE DATABASE empty_guard OWNER domino_catalogue_admin;', database='postgres')
        self.addCleanup(self.query, 'DROP DATABASE empty_guard;', database='postgres')
        self.assertEqual(self.query('SELECT ' + prepare_disabled.EMPTY, database='empty_guard'), 't')
        for mutation in (
            'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO unrelated',
            "ALTER ROLE domino_session_auth SET session_replication_role='replica'",
            'GRANT SET ON PARAMETER session_replication_role TO domino_session_auth',
        ):
            with self.subTest(mutation=mutation):
                output = self.query('BEGIN; ' + mutation + '; SELECT ' + prepare_disabled.EMPTY + '; ROLLBACK;',
                                    database='empty_guard')
                self.assertEqual(output, 'f')

        shadow = """CREATE TABLE public.hidden_fixture(value integer);
          CREATE VIEW public.pg_class AS SELECT * FROM pg_catalog.pg_class WHERE false;
          CREATE VIEW public.pg_proc AS SELECT * FROM pg_catalog.pg_proc WHERE false;
          CREATE VIEW public.pg_type AS SELECT * FROM pg_catalog.pg_type WHERE false;
          SET LOCAL search_path=public,pg_catalog;"""
        self.assertEqual(self.query('BEGIN; ' + shadow + ' SELECT ' + prepare_disabled.EMPTY + '; ROLLBACK;',
                                    database='empty_guard', role=inventory.ADMIN), 'f')

    def test_catalogue_shadow_views_cannot_hide_owner_tampering(self):
        cases = [
            ('pg_default_acl', 'ALTER DEFAULT PRIVILEGES GRANT SELECT ON TABLES TO unrelated', 'defaultAclCount'),
            ('pg_db_role_setting', "ALTER DATABASE domino_catalogue SET application_name='fixture'", 'roleSettingCount'),
        ]
        for catalogue, mutation, key in cases:
            with self.subTest(catalogue=catalogue):
                sql = f'CREATE VIEW public.{catalogue} AS SELECT * FROM pg_catalog.{catalogue} WHERE false;'
                data = json.loads(self.query('BEGIN; ' + sql + mutation + '; SET LOCAL search_path=public,pg_catalog;'
                                             + inventory.inventory_sql() + 'ROLLBACK;', role=inventory.ADMIN))
                self.assertGreater(data[key], 0)
        data = json.loads(self.query("""BEGIN; CREATE SCHEMA hidden_schema;
          CREATE VIEW public.pg_namespace AS SELECT * FROM pg_catalog.pg_namespace WHERE nspname<>'hidden_schema';
          SET LOCAL search_path=public,pg_catalog;""" + inventory.inventory_sql() + 'ROLLBACK;', role=inventory.ADMIN))
        self.assertFalse(inventory.check_inventory(data, installed=True)['completeSchemaInventory'])
        self.assertIn('hidden_schema', {row['name'] for row in data['schemas']})

    def test_parameter_set_grant_is_detected_without_a_persistent_setting(self):
        denied = 'SET session_replication_role=replica;'
        with self.assertRaisesRegex(AssertionError, 'permission denied to set parameter'):
            self.query(denied, role=inventory.AUTH)
        self.query('GRANT SET ON PARAMETER session_replication_role TO domino_session_auth;')
        try:
            self.assertEqual(self.query(denied + 'SHOW session_replication_role;', role=inventory.AUTH), 'replica')
            data = json.loads(self.query(inventory.inventory_sql(), role=inventory.ADMIN))
            self.assertEqual(data['roleSettingCount'], 0)
            self.assertGreater(data['parameterAclCount'], 0)
            self.assertFalse(inventory.check_inventory(data, installed=True)['noParameterAclOverrides'])
        finally:
            self.query('REVOKE SET ON PARAMETER session_replication_role FROM domino_session_auth;')
        self.assertTrue(all(inventory.check_inventory(json.loads(self.query(inventory.inventory_sql())), installed=True).values()))

    def test_client_search_path_overrides_database_default(self):
        self.query('ALTER DATABASE domino_catalogue SET search_path=public,pg_catalog;')
        try:
            self.assertEqual(self.query('SHOW search_path;', role=inventory.ADMIN), 'pg_catalog')
            data = json.loads(self.query(inventory.inventory_sql(), role=inventory.ADMIN))
            self.assertFalse(inventory.check_inventory(data, installed=True)['noPersistentRoleDatabaseSettings'])
        finally:
            self.query('ALTER DATABASE domino_catalogue RESET search_path;')


if __name__ == '__main__':
    unittest.main()
