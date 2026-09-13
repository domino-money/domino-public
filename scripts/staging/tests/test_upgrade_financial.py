"""Scoped source/SQL/rollback regressions. No real host installer is invoked."""
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import upgrade_financial as financial

REPO = Path(__file__).resolve().parents[3]


class FinancialTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='domino-financial-tests-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.path = Path(cls.temp.name) / 'source.tar'
        cls.commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
        subprocess.run(['git', 'archive', '--format=tar', '-o', str(cls.path), cls.commit], cwd=REPO, check=True)
        cls.digest = hashlib.sha256(cls.path.read_bytes()).hexdigest()
        cls.files = financial.archive_files(cls.path, cls.digest, cls.commit)
        cls.planned = financial.plan(cls.files, cls.commit, cls.digest)

    def test_real_git_archive_and_no_git_cli_plan(self):
        result = subprocess.run([sys.executable, str(REPO / 'scripts/staging/upgrade_financial.py'),
                                 '--archive', str(self.path), '--archive-sha256', self.digest,
                                 '--commit', self.commit], capture_output=True, text=True,
                                env={'PATH': '/nonexistent', 'PYTHONDONTWRITEBYTECODE': '1'}, check=True)
        self.assertEqual(json.loads(result.stdout), self.planned)
        self.assertFalse(self.planned['servicesStarted'])
        self.assertEqual(len(self.planned['migrations']), 5)
        self.assertEqual(set(self.planned['units']), {'domino-' + c + '.service' for c in financial.COMPONENTS})

    def test_units_scope_off_and_private_namespaces(self):
        for component in financial.COMPONENTS:
            text = financial.unit_text(component, self.commit)
            self.assertIn('IPAddressDeny=any\nIPAddressAllow=localhost\n', text)
            self.assertIn('BindReadOnlyPaths=/etc/domino/financial/' + component, text)
            self.assertNotIn('[Install]', text)
            self.assertNotIn('WantedBy=', text)
            self.assertNotIn('domino-dev', text)
            if component not in ('performance-collector', 'execution-signer'):
                self.assertNotIn('--enable', text)
            else:
                self.assertIn('ConditionPathExists=/etc/domino/financial/' + component + '/profile.json', text)
        for component in financial.OLD_COMPONENTS:
            self.assertIn('/releases/' + financial.OLD + '/' + component + '/backend/runtime:',
                          financial.unit_text(component, self.commit))
        signer = financial.unit_text('execution-signer', self.commit)
        self.assertIn('Type=oneshot', signer)
        self.assertNotIn('--key', signer)
        self.assertIn('Restart=no', signer)

    def test_only_five_migrations_are_executed(self):
        # Foundation files carry sentinels: even their contents must never be
        # included in the upgrade DDL, including an already populated baseline.
        files = dict(self.files)
        for index, name in enumerate(financial.base.MIGRATIONS):
            files[name] = (f'RAISE_FOUNDATION_REPLAY_{index};'.encode(), False)
        query = financial.migration_sql(files, self.planned)
        self.assertNotIn('RAISE_FOUNDATION_REPLAY', query)
        self.assertTrue(query.startswith('BEGIN;'))
        self.assertTrue(query.endswith('COMMIT;\n'))
        for name in financial.MIGRATIONS:
            self.assertIn(self.files[name][0].decode(), query)
        self.assertIn('financial_schema_already_exists', query)
        self.assertIn('domino_financial_install.receipt', query)

    def test_peers_preserve_existing_rows_and_reject_boundary(self):
        hba = b'local all postgres peer\nlocal domino_catalogue domino_session_auth peer map=domino\nlocal all all reject\nhost all all 0.0.0.0/0 reject\n'
        ident = b'domino domino-auth domino_session_auth\ndomino_dev domino-dev-read domino_dev_catalogue_reader\n'
        new_hba, new_ident = financial.peers(hba, ident)
        self.assertTrue(new_ident.startswith(ident))
        self.assertEqual(new_hba.count(b'local all all reject'), 1)
        for role in financial.NEW_ROLES:
            self.assertIn(f'local domino_catalogue {role} peer map=domino_financial\n'.encode(), new_hba)
        self.assertNotIn(b'domino-dev-read domino_performance', new_ident)
        self.assertNotIn(b'domino-read domino_execution', new_ident)
        self.assertIn(b'domino domino-execution-status domino_session_auth', new_ident)
        with self.assertRaises(ValueError): financial.peers(new_hba, new_ident)

    def test_peer_reload_waits_only_for_bounded_new_connections(self):
        calls = []
        def query(text, *, os_user, role):
            calls.append((os_user, role))
            if len(calls) == 1: raise ValueError('reload_pending')
            return role
        with patch.object(financial.base, 'sql', side_effect=query), patch.object(financial.time, 'sleep') as pause:
            financial.verify_peers()
        self.assertEqual(len(calls), 1 + sum(len(roles) for roles in financial.PEERS.values()))
        pause.assert_called_once_with(0.1)

    def test_bad_archives_fail_before_host_commands(self):
        with patch.object(financial.base, 'run', side_effect=AssertionError('host_command')):
            with self.assertRaises(ValueError): financial.archive_files(self.path, '0' * 64, self.commit)
            for member_name, kind in (('../escape', tarfile.REGTYPE), ('backend/link', tarfile.SYMTYPE),
                                      ('backend/runtime/key', tarfile.REGTYPE)):
                with self.subTest(member_name=member_name):
                    output = io.BytesIO()
                    with tarfile.open(fileobj=output, mode='w', format=tarfile.PAX_FORMAT,
                                      pax_headers={'comment': self.commit}) as archive:
                        member = tarfile.TarInfo(member_name); member.type = kind
                        if kind == tarfile.SYMTYPE: member.linkname = '/etc/shadow'
                        archive.addfile(member)
                    bad = Path(self.temp.name) / 'bad.tar'; bad.write_bytes(output.getvalue())
                    with self.assertRaises(ValueError): financial.archive_files(bad, hashlib.sha256(bad.read_bytes()).hexdigest(), self.commit)

    def test_partial_rollback_is_scoped_repeatable_and_retains_schema(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); units = root / 'units'; units.mkdir()
            receipts = root / 'receipts'; receipts.mkdir()
            directory = receipts / self.commit; directory.mkdir()
            original = b'[Service]\nExecStart=/old/auth\n'
            (directory / 'auth.service').write_bytes(original)
            (directory / 'plan.json').write_bytes(financial.json_bytes(self.planned))
            (units / 'domino-auth.service').write_text(self.planned['units']['domino-auth.service'])
            # Intent journaled, but new performance unit never renamed yet.
            state = {'unitsWritten': ['auth', 'performance'], 'peerFilesWritten': [], 'sqlCommitted': False}
            (directory / 'journal.json').write_bytes(financial.json_bytes(state))
            protected = units / 'domino-read.service'; protected.write_bytes(b'unchanged')
            calls = []
            exclusive = financial.base.exclusive_file
            def fixture_file(path, raw, mode=0o600, **kwargs):
                return exclusive(path, raw, mode=mode, uid=os.getuid(), gid=os.getgid())
            with patch.object(financial, 'RECEIPTS', receipts), patch.object(financial.base, 'UNIT_DIR', units), \
                    patch.object(financial.base, 'trusted_parents'), \
                    patch.object(financial.base, 'exclusive_file', side_effect=fixture_file), \
                    patch.object(financial.base, 'run', side_effect=lambda args: calls.append(args) or b''), \
                    patch.object(financial, 'sql', return_value='t'):
                self.assertTrue(financial.rollback(self.planned)['financialSchemasRetained'])
                self.assertTrue(financial.rollback(self.planned)['financialSchemasRetained'])
            self.assertEqual((units / 'domino-auth.service').read_bytes(), original)
            self.assertEqual(protected.read_bytes(), b'unchanged')
            self.assertFalse((units / 'domino-performance.service').exists())
            self.assertTrue(all('domino-read.service' not in command for command in calls))
            self.assertFalse(any('start' in command for command in calls))

    def test_rollback_rejects_unrelated_unit_change_before_stop(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); units = root / 'units'; units.mkdir()
            receipts = root / 'receipts'; receipts.mkdir(); directory = receipts / self.commit; directory.mkdir()
            (directory / 'plan.json').write_bytes(financial.json_bytes(self.planned))
            (directory / 'auth.service').write_bytes(b'original')
            (directory / 'journal.json').write_bytes(financial.json_bytes({'unitsWritten': ['auth'], 'peerFilesWritten': []}))
            (units / 'domino-auth.service').write_bytes(b'foreign update')
            with patch.object(financial, 'RECEIPTS', receipts), patch.object(financial.base, 'UNIT_DIR', units), \
                    patch.object(financial.base, 'trusted_parents'), patch.object(financial.base, 'run') as run:
                with self.assertRaisesRegex(ValueError, 'rollback_unit_drift'): financial.rollback(self.planned)
                run.assert_not_called()


@unittest.skipUnless(os.environ.get('DOMINO_TEST_STAGING_POSTGRES') == '1', 'opt-in disposable PostgreSQL')
class FinancialPostgresTests(unittest.TestCase):
    def test_actual_foundation_upgrade_atomic_failure_and_single_commit(self):
        # Reuse the established local PG16+ fixture and populated foundation,
        # not a VM/host schema. No installer, service or provider is invoked.
        import test_upgrade_postgres as fixture
        cluster = fixture.UpgradePostgresTests
        cluster.setUpClass()
        self.addCleanup(cluster.doClassCleanups)
        files = {p: ((REPO / p).read_bytes(), False) for p in financial.MIGRATIONS}
        planned = {'commit': 'a' * 40, 'migrations': [{'path': p, 'sha256': financial.sha(raw)} for p, (raw, _) in files.items()]}
        before = cluster.query("SELECT json_build_object('wallets',(SELECT count(*) FROM domino_wallet_access.grants),'catalogue',(SELECT count(*) FROM domino_catalogue.events))")
        with patch.object(financial.base, 'DB', 'upgrade_fixture'):
            invalid = dict(files)
            invalid[financial.MIGRATIONS[-1]] = (b'SELECT nonexistent_financial_function();', False)
            with self.assertRaises(AssertionError): cluster.query(financial.migration_sql(invalid, planned))
            self.assertEqual(cluster.query("SELECT count(*) FROM pg_namespace WHERE nspname IN ('domino_execution','domino_performance','domino_financial_install')"), '0')
            self.assertEqual(cluster.query("SELECT count(*) FROM pg_roles WHERE rolname='domino_execution_signer'"), '0')
            cluster.query(financial.migration_sql(files, planned))
            stored = json.loads(cluster.query('SELECT value FROM domino_financial_install.receipt'))
            self.assertEqual(stored, planned)
            self.assertEqual(cluster.query("SELECT count(*) FROM pg_roles WHERE rolname LIKE 'domino_execution_%' AND (rolsuper OR rolinherit OR rolbypassrls)"), '0')
            self.assertEqual(cluster.query("SELECT count(*) FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname LIKE 'domino_execution_%' OR r.rolname LIKE 'domino_performance_%'"), '0')
            with self.assertRaises(AssertionError): cluster.query(financial.migration_sql(files, planned))
        self.assertEqual(before, cluster.query("SELECT json_build_object('wallets',(SELECT count(*) FROM domino_wallet_access.grants),'catalogue',(SELECT count(*) FROM domino_catalogue.events))"))
        with self.assertRaises(AssertionError): cluster.query('SELECT * FROM domino_execution.attempts', role='domino_execution_reader')
        with self.assertRaises(AssertionError): cluster.query('SELECT * FROM domino_sessions.sessions', role='domino_performance_collector')
        with self.assertRaises(AssertionError): cluster.query('SELECT * FROM domino_financial_install.receipt', role='domino_execution_signer')


if __name__ == '__main__': unittest.main()
