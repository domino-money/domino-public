"""Scoped plan, unit, SQL and peer regressions for the automation installer.
No real host, database or systemd is touched."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import install_automation as automation
import prepare_disabled as base
import upgrade_financial as financial

REPO = Path(__file__).resolve().parents[3]
OTHER_PACKAGED = tuple(p for p in financial.PACKAGED_ONLY_MIGRATIONS if p not in automation.MIGRATIONS)


def hba_text(*, publisher=False):
    lines = ['local all postgres peer\n']
    lines += [f'local {base.DB} {role} peer map=domino_financial\n' for role in financial.NEW_ROLES]
    if publisher:
        lines.append(f'local {base.DB} domino_execution_publisher peer map=domino_financial\n')
    lines.append('local all all reject\n')
    return ''.join(lines).encode()


def ident_text(*, automation_rows=False):
    lines = ['domino domino-read domino_catalogue_reader\n',
             'domino_financial domino-execution-signer domino_execution_worker\n',
             'domino_financial domino-execution-signer domino_execution_ledger\n',
             'domino_financial domino-execution-signer domino_execution_signer\n']
    if automation_rows:
        lines.append('domino_financial domino-automation domino_execution_worker\n')
    return ''.join(lines).encode()


class AutomationInstallTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='domino-automation-install-tests-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.path = Path(cls.temp.name) / 'source.tar'
        cls.commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
        subprocess.run(['git', 'archive', '--format=tar', '-o', str(cls.path), cls.commit], cwd=REPO, check=True)
        cls.digest = hashlib.sha256(cls.path.read_bytes()).hexdigest()
        cls.files = base.archive_files(cls.path, cls.digest, cls.commit)
        cls.planned = automation.plan(cls.files, cls.commit, cls.digest)

    def test_plan_from_a_real_git_archive_without_git_or_host_access(self):
        result = subprocess.run([sys.executable, str(REPO / 'scripts/staging/install_automation.py'),
                                 '--archive', str(self.path), '--archive-sha256', self.digest, '--commit', self.commit],
                                capture_output=True, text=True, env={'PATH': '/nonexistent', 'PYTHONDONTWRITEBYTECODE': '1'}, check=True)
        self.assertEqual(json.loads(result.stdout), self.planned)
        self.assertEqual([row['path'] for row in self.planned['migrations']], list(automation.MIGRATIONS))
        self.assertEqual(self.planned['migrations'][1]['sha256'], hashlib.sha256(self.files[automation.MIGRATIONS[1]][0]).hexdigest())
        self.assertEqual((self.planned['servicesStarted'], self.planned['configurationCreated'], self.planned['keysCreated']), (False, False, False))
        self.assertEqual(self.planned['roles'], list(automation.ROLES))
        self.assertEqual(self.planned['sourceDirectory'], f'/opt/domino/financial/releases/{self.commit}/automation')
        self.assertEqual(self.planned['privateDirectory'], '/etc/domino/financial/automation')
        # Every automation module the unit needs travels in the archive, or the plan refuses.
        for name in automation.SOURCES:
            with self.assertRaisesRegex(ValueError, 'automation_source_missing'):
                automation.plan({k: v for k, v in self.files.items() if k != name}, self.commit, self.digest)

    def test_unit_is_off_hardened_and_reads_only_its_private_configuration(self):
        text = self.planned['unit']
        self.assertIn('ConditionPathExists=/etc/domino/financial/automation/config.json\n', text)
        self.assertIn('ExecStart=/opt/domino/backend-venv/bin/python3.14 -B backend/automation_cli.py --config /run/domino-financial-automation-config/config.json serve\n', text)
        self.assertIn('BindReadOnlyPaths=/etc/domino/financial/automation:/run/domino-financial-automation-config\n', text)
        self.assertIn(f'WorkingDirectory=/opt/domino/financial/releases/{self.commit}/automation\n', text)
        self.assertIn('IPAddressDeny=any\nIPAddressAllow=localhost\n', text)
        self.assertIn('User=domino-automation\nGroup=domino-automation\nSupplementaryGroups=domino-db\n', text)
        for line in ('Type=exec', 'ProtectSystem=strict', 'NoNewPrivileges=true', 'CapabilityBoundingSet=', 'UMask=0077',
                     'Restart=on-failure', 'KillSignal=SIGTERM', 'PrivateTmp=true', 'ProtectHome=true'):
            self.assertIn(line + '\n', text)
        for forbidden in ('[Install]', 'WantedBy=', '--key', 'run-once', 'domino-dev', 'EnvironmentFile=/'):
            self.assertNotIn(forbidden, text)

    def test_only_the_automation_migrations_run_in_one_guarded_transaction(self):
        files = dict(self.files)
        for index, name in enumerate((*base.MIGRATIONS, *financial.MIGRATIONS, *OTHER_PACKAGED)):
            files[name] = (f'RAISE_OTHER_MIGRATION_{index};'.encode(), False)
        query = automation.migration_sql(files, self.planned)
        self.assertNotIn('RAISE_OTHER_MIGRATION', query)
        for name in (*base.MIGRATIONS, *financial.MIGRATIONS, *OTHER_PACKAGED):
            self.assertNotIn(name, query)
        self.assertTrue(query.startswith('BEGIN;'))
        self.assertTrue(query.endswith('COMMIT;\n'))
        first, second, third, fourth = (self.files[name][0].decode() for name in automation.MIGRATIONS)
        self.assertLess(query.index(first), query.index(second))
        self.assertLess(query.index(second), query.index(third))
        self.assertLess(query.index(third), query.index(fourth))
        self.assertLess(query.index('financial_schema_missing'), query.index(first))
        for guard in ('wrong_automation_ddl_identity', 'automation_schema_already_exists', 'execution_roles_unexpected',
                      "to_regclass('domino_financial_install.receipt') IS NULL", "to_regclass('domino_execution.cycles') IS NOT NULL"):
            self.assertIn(guard, query)
        self.assertIn('ALTER ROLE domino_execution_publisher LOGIN; GRANT CONNECT ON DATABASE domino_catalogue TO domino_execution_publisher;', query)
        self.assertIn('domino_automation_install.receipt', query)
        self.assertEqual(query.count('CREATE ROLE domino_execution_publisher'), 1)
        self.assertNotIn('LOGIN;', query.split(second)[0].split(first)[0])

    def test_peer_files_gain_exactly_the_automation_rows(self):
        hba, ident = automation.peers(hba_text(), ident_text())
        original_hba, original_ident = hba_text().decode().splitlines(), ident_text().decode().splitlines()
        new_hba, new_ident = hba.decode().splitlines(), ident.decode().splitlines()
        self.assertEqual([line for line in new_hba if line not in original_hba],
                         ['local domino_catalogue domino_execution_publisher peer map=domino_financial'])
        self.assertEqual(new_hba[-1], 'local all all reject')
        self.assertLess(new_hba.index('local domino_catalogue domino_execution_publisher peer map=domino_financial'), len(new_hba) - 1)
        self.assertEqual(new_ident[:len(original_ident)], original_ident)
        self.assertEqual(new_ident[len(original_ident):], [f'domino_financial domino-automation {role}' for role in automation.ROLES])
        for bad_hba, bad_ident, reason in (
                (hba_text(publisher=True), ident_text(), 'automation_peers_exist'),
                (hba_text(), ident_text(automation_rows=True), 'automation_peers_exist'),
                (b'local all postgres peer\nlocal all all reject\n', ident_text(), 'financial_peers_missing'),
                (hba_text(), b'domino domino-read domino_catalogue_reader\n', 'financial_peers_missing'),
                (hba_text().replace(b'local all all reject\n', b''), ident_text(), 'missing_unique_local_reject')):
            with self.assertRaisesRegex(ValueError, reason):
                automation.peers(bad_hba, bad_ident)

    def test_apply_and_rollback_refuse_before_touching_a_host(self):
        # Neither path reaches the host from an unprivileged test: root is
        # required first, and a rollback needs a receipt directory it will not create.
        with self.assertRaisesRegex(ValueError, 'root_required'):
            automation.baseline(self.files, self.planned)
        if os.geteuid() != 0:
            with self.assertRaisesRegex(ValueError, 'root_required'):
                automation.apply(self.files, self.planned, {})
        self.assertEqual(automation.RECEIPTS, Path('/var/backups/domino-financial/automation'))
        self.assertEqual(automation.UNIT, 'domino-automation.service')


if __name__ == '__main__':
    unittest.main()
