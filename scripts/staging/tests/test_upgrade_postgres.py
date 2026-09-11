"""Real disabled-upgrade dump/restore probes in an opt-in disposable cluster.

DOMINO_TEST_STAGING_POSTGRES=1 and DOMINO_PG_BIN=<PG16+ tools> are required.
The subprocess boundary redirects the fixed production pg_dump command only to
this fixture's unique Unix socket/database. No real service, VM, runtime file,
TCP listener, provider, installer or upgrade apply/rollback is used.
"""
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import catalogue_inventory as inventory
import check_roles
import prepare_disabled as install
import upgrade_disabled as upgrade


@unittest.skipUnless(os.environ.get('DOMINO_TEST_STAGING_POSTGRES') == '1',
                     'opt-in disposable PostgreSQL cluster')
class UpgradePostgresTests(unittest.TestCase):
    """Use actual PostgreSQL, migration SQL, pg_dump and psql restore."""

    @classmethod
    def run_tool(cls, name, *args, data=None):
        result = subprocess.run([str(cls.bin / name), *args], input=data, text=True,
            capture_output=True, timeout=30, env=install.ENV)
        if result.returncode:
            raise AssertionError(f'{name} fixture command failed: {result.stderr}')
        return result.stdout.strip()

    @classmethod
    def query(cls, sql, *, database='upgrade_fixture', role='postgres'):
        return cls.run_tool('psql', '-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1',
            '-h', str(cls.socket), '-p', '18778', '-U', role, '-d', database, '-f', '-', data=sql)

    @classmethod
    def stop_cluster(cls):
        # This path belongs to our TemporaryDirectory, never the local dev DB.
        if (cls.data / 'postmaster.pid').exists():
            cls.run_tool('pg_ctl', '-D', str(cls.data), '-m', 'immediate', '-w', 'stop')

    @classmethod
    def database_acl(cls, database):
        # A plain pg_dump does not create the database or cluster roles. Restore
        # requires the separately verified foundation, reproduced explicitly here.
        cls.query(f'REVOKE ALL ON DATABASE {database} FROM PUBLIC;'
                  f'GRANT CONNECT ON DATABASE {database} TO '
                  + ','.join(check_roles.ROLES) + ';', database=database)

    @classmethod
    def setUpClass(cls):
        cls.bin = Path(os.environ['DOMINO_PG_BIN']).resolve(strict=True)
        version = cls.run_tool('initdb', '--version')
        if int(re.search(r'(\d+)\.', version).group(1)) < 16:
            raise unittest.SkipTest('PostgreSQL 16 or newer required')
        cls.temp = tempfile.TemporaryDirectory(prefix='dm-upgrade-pg-', dir='/tmp')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.base = Path(cls.temp.name)
        cls.socket = cls.base / 'socket'
        cls.socket.mkdir(mode=0o700)
        cls.data = cls.base / 'data'
        cls.run_tool('initdb', '-D', str(cls.data), '-U', 'postgres', '-A', 'trust',
                     '--encoding=UTF8', '--locale=C', '--no-instructions')
        cls.addClassCleanup(cls.stop_cluster)
        cls.run_tool('pg_ctl', '-D', str(cls.data), '-l', str(cls.base / 'postgres.log'),
                     '-o', f"-F -k {cls.socket} -p 18778 -c listen_addresses=''", '-w', 'start')
        if cls.query('SHOW listen_addresses;', database='postgres') != '':
            raise AssertionError('fixture must not listen on TCP')
        cls.query(''.join(f'CREATE ROLE {role} LOGIN NOINHERIT;' for role in check_roles.ROLES),
                  database='postgres')
        cls.query('CREATE DATABASE upgrade_fixture OWNER domino_catalogue_admin;', database='postgres')
        cls.database_acl('upgrade_fixture')
        repo = Path(__file__).resolve().parents[3]
        migrations = '\n'.join((repo / path).read_text() for path in install.MIGRATIONS)
        cls.query('BEGIN;\n' + migrations + '\nCOMMIT;', role=inventory.ADMIN)
        # Synthetic populated public catalogue plus a synthetic private admission
        # record exercise rows, JSONB, foreign keys and the real identity sequence.
        cls.query("""UPDATE domino_catalogue.state SET start_block=100,next_block=101,
          base_hash='0x'||repeat('a',64),revision=2;
          INSERT INTO domino_catalogue.chunks VALUES (100,100,'0x'||repeat('a',64));
          INSERT INTO domino_catalogue.events VALUES ('0x'||repeat('b',64),
            '0x'||repeat('1',40),'0x'||repeat('2',40),'{"fixture":"upgrade"}',
            100,'0x'||repeat('a',64),'0x'||repeat('c',64),0,100);
          INSERT INTO domino_activity.pools(pool_id,pool_key,start_block,base_hash,next_block)
            VALUES ('0x'||repeat('b',64),'{"fixture":"upgrade"}',100,'0x'||repeat('a',64),101);
          """, role=inventory.ADMIN)
        cls.query("SELECT * FROM domino_wallet_access.set_access('0x'||repeat('1',40),true);",
                  role=inventory.OPERATOR)
        cls.serial = 0

    def setUp(self):
        type(self).serial += 1
        self.database = f'upgrade_case_{self.serial}'
        self.query(f'CREATE DATABASE {self.database} TEMPLATE upgrade_fixture '
                   'OWNER domino_catalogue_admin;', database='postgres')
        self.addCleanup(self.query, f'DROP DATABASE {self.database};', database='postgres')
        self.database_acl(self.database)
        self.dump_number = 0

    def dump(self, *, database=None):
        """Run the production function with only the host identity redirected.

        Keep real Popen, stdout, stderr, process groups, child RLIMIT_FSIZE, timeout,
        O_EXCL/NOFOLLOW, fsync and normalization. Only a root-owned output check is
        mapped to the non-root fixture owner; every other file check stays real.
        """
        self.dump_number += 1
        path = self.base / f'{self.database}-{self.dump_number}.sql'
        actual_popen = subprocess.Popen
        actual_read = upgrade.read_regular
        expected = ['/usr/sbin/runuser', '-u', 'postgres', '--', str(install.PG / 'pg_dump'),
                    '-w', '-h', install.SOCKET, '-p', '8877', '-U', 'postgres', '-d', install.DB,
                    '--format=plain', '--lock-wait-timeout=5s']

        def fixture_popen(argv, **kwargs):
            self.assertEqual(argv, expected, 'production dump boundary changed; review the adapter')
            redirected = [str(self.bin / 'pg_dump'), '-w', '-h', str(self.socket), '-p', '18778',
                          '-U', 'postgres', '-d', database or self.database,
                          '--format=plain', '--lock-wait-timeout=5s']
            return actual_popen(redirected, **kwargs)

        def fixture_read(candidate, **kwargs):
            self.assertEqual(candidate, path)
            self.assertEqual(kwargs['owner'], 0)
            return actual_read(candidate, **{**kwargs, 'owner': os.geteuid()})

        with patch.object(upgrade.subprocess, 'Popen', side_effect=fixture_popen), \
                patch.object(upgrade, 'read_regular', side_effect=fixture_read):
            digest = upgrade.dump_database(path)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        return digest, path

    def test_unchanged_populated_database_has_stable_fingerprint(self):
        first, first_path = self.dump()
        second, second_path = self.dump()
        self.assertEqual(first, second)
        self.assertGreater(first_path.stat().st_size, 10000)
        # pg_dump 17+ guards contain random keys: raw inequality makes this an
        # actual normalization regression test, not a mock with constant bytes.
        if b'\\restrict ' in first_path.read_bytes():
            self.assertNotEqual(first_path.read_bytes(), second_path.read_bytes())

    def test_committed_row_change_changes_fingerprint(self):
        before, _ = self.dump()
        self.query('UPDATE domino_catalogue.state SET revision=revision+1;', database=self.database)
        after, _ = self.dump()
        self.assertNotEqual(before, after)

    def test_sequence_advance_without_row_change_changes_fingerprint(self):
        before, _ = self.dump()
        rows = self.query('SELECT count(*) FROM domino_wallet_access.audit;', database=self.database)
        self.query("SELECT nextval('domino_wallet_access.audit_id_seq');", database=self.database)
        self.assertEqual(self.query('SELECT count(*) FROM domino_wallet_access.audit;',
                                    database=self.database), rows)
        after, _ = self.dump()
        self.assertNotEqual(before, after)

    def test_schema_change_without_row_change_changes_fingerprint(self):
        before, _ = self.dump()
        self.query('ALTER TABLE domino_catalogue.state ADD COLUMN upgrade_fixture text;',
                   database=self.database)
        after, _ = self.dump()
        self.assertNotEqual(before, after)

    def test_table_acl_change_changes_fingerprint(self):
        before, _ = self.dump()
        self.query('REVOKE SELECT ON domino_catalogue.state FROM domino_catalogue_reader;',
                   database=self.database)
        after, _ = self.dump()
        self.assertNotEqual(before, after)

    def snapshot(self, database):
        result = {
            'inventory': json.loads(self.query(inventory.inventory_sql(), database=database)),
            'metadata': json.loads(self.query(check_roles.metadata_sql(), database=database)),
            'acl': {role: json.loads(self.query(check_roles.acl_sql(role), database=database))
                    for role in check_roles.ROLES},
            'tables': {},
        }
        for schema, tables in check_roles.TABLES.items():
            for table in tables:
                name = f'{schema}.{table}'
                result['tables'][name] = json.loads(self.query(
                    f"SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') FROM {name} t;",
                    database=database))
        result['sequence'] = self.query(
            'SELECT last_value,is_called FROM domino_wallet_access.audit_id_seq;', database=database)
        return result

    def test_restore_preserves_populated_state_owners_schema_and_acls(self):
        before = self.snapshot(self.database)
        self.assertTrue(all(inventory.check_inventory(before['inventory'], installed=True).values()))
        self.assertTrue(all(check_roles.check_metadata(before['metadata']).values()))
        self.assertTrue(all(value['failures'] == [] for value in before['acl'].values()))
        self.assertEqual(len(before['tables']), 24)
        self.assertEqual(len(before['tables']['domino_catalogue.events']), 1)
        self.assertEqual(len(before['tables']['domino_wallet_access.audit']), 1)
        fingerprint, path = self.dump()
        restored = self.database + '_restored'
        self.query(f'CREATE DATABASE {restored} OWNER domino_catalogue_admin;', database='postgres')
        self.addCleanup(self.query, f'DROP DATABASE {restored};', database='postgres')
        self.database_acl(restored)
        self.run_tool('psql', '-X', '-w', '-q', '-v', 'ON_ERROR_STOP=1', '--single-transaction',
                      '-h', str(self.socket), '-p', '18778', '-U', 'postgres', '-d', restored,
                      '-f', str(path))
        self.assertEqual(self.snapshot(restored), before)
        restored_fingerprint, _ = self.dump(database=restored)
        self.assertEqual(restored_fingerprint, fingerprint)
        # Restore's writes went only to the separate disposable DB.
        self.assertEqual(self.snapshot(self.database), before)

    def test_real_pg_dump_obeys_child_file_size_bound(self):
        with patch.object(upgrade, 'MAX_DUMP_BYTES', 128):
            with self.assertRaisesRegex(upgrade.UpgradeError, '^database_dump_failed$'):
                self.dump()
        path = self.base / f'{self.database}-{self.dump_number}.sql'
        self.assertLessEqual(path.stat().st_size, 128)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(self.query('SELECT count(*) FROM domino_catalogue.events;',
                                    database=self.database), '1')


if __name__ == '__main__':
    unittest.main()
