"""Offline coverage of the already-installed automation readiness upgrade."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import upgrade_automation_readiness as upgrade

REPO = Path(__file__).resolve().parents[3]


class ReadinessUpgradeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='domino-readiness-upgrade-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.archive = Path(cls.temp.name) / 'source.tar'
        cls.commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
        subprocess.run(['git', 'archive', '--format=tar', '-o', str(cls.archive), cls.commit], cwd=REPO, check=True)
        cls.digest = hashlib.sha256(cls.archive.read_bytes()).hexdigest()
        cls.files = upgrade.financial.archive_files(cls.archive, cls.digest, cls.commit)
        cls.planned = upgrade.plan(cls.files, cls.commit, cls.digest)

    def test_plan_is_exactly_two_migrations_and_four_off_units(self):
        result = subprocess.run([sys.executable, str(REPO / 'scripts/staging/upgrade_automation_readiness.py'),
                                 '--archive', str(self.archive), '--archive-sha256', self.digest,
                                 '--commit', self.commit], capture_output=True, text=True,
                                env={'PATH': '/nonexistent', 'PYTHONDONTWRITEBYTECODE': '1'}, check=True)
        self.assertEqual(json.loads(result.stdout), self.planned)
        self.assertEqual([row['path'] for row in self.planned['migrations']],
                         list(upgrade.MIGRATIONS))
        self.assertEqual(set(self.planned['units']), set(upgrade.UNITS))
        self.assertFalse(self.planned['servicesStarted'])
        self.assertFalse(self.planned['privateConfigurationChanged'])
        self.assertNotIn('domino-gas-reservation.socket', self.planned['units'])

    def test_sql_requires_exact_prior_receipt_and_never_replays_028_to_038(self):
        prior = {'commit': 'a' * 40,
                 'migrations': [{'path': p, 'sha256': upgrade.financial.sha(self.files[p][0])}
                                for p in upgrade.PRIOR_MIGRATIONS]}
        files = dict(self.files)
        for path in upgrade.PRIOR_MIGRATIONS:
            files[path] = (b'REPLAY_PREVIOUS_MIGRATION;', False)
        sql = upgrade.migration_sql(files, self.planned, prior)
        self.assertTrue(sql.startswith('BEGIN;'))
        self.assertTrue(sql.endswith('COMMIT;\n'))
        self.assertNotIn('REPLAY_PREVIOUS_MIGRATION', sql)
        for path in upgrade.MIGRATIONS:
            self.assertIn(self.files[path][0].decode(), sql)
        self.assertIn('IS DISTINCT FROM', sql)
        self.assertIn('readiness_prior_state_mismatch', sql)
        self.assertIn('SELECT pg_advisory_xact_lock', sql)
        self.assertIn('readiness_upgrade_receipt', sql)
        self.assertLess(sql.index(self.files[upgrade.MIGRATIONS[-1]][0].decode()),
                        sql.index('CREATE TABLE domino_automation_install.readiness_upgrade_receipt'))
        with self.assertRaisesRegex(ValueError, 'prior_install_receipt_invalid'):
            upgrade.migration_sql(self.files, self.planned, {'unexpected': "'"})

    def test_existing_receipt_is_idempotent_only_for_exact_commit_and_digest(self):
        correct = [{'commit': self.commit, **migration}
                   for migration in self.planned['migrations']]
        with patch.object(upgrade.financial, 'sql', side_effect=['f']):
            self.assertFalse(upgrade._upgrade_receipt(self.planned))
        with patch.object(upgrade.financial, 'sql', side_effect=['t', json.dumps(correct)]):
            self.assertTrue(upgrade._upgrade_receipt(self.planned))
        for changed in ([{**correct[0], 'commit': 'b' * 40}, correct[1]],
                        [correct[0], {**correct[1], 'sha256': 'b' * 64}],
                        correct[:1]):
            with self.subTest(changed=changed), patch.object(upgrade.financial, 'sql', side_effect=['t', json.dumps(changed)]):
                with self.assertRaisesRegex(ValueError, 'readiness_upgrade_receipt_mismatch'):
                    upgrade._upgrade_receipt(self.planned)

    def test_baseline_refuses_an_active_financial_unit_before_any_write(self):
        with tempfile.TemporaryDirectory() as temp:
            units = Path(temp)
            old_automation, old_financial = 'a' * 40, 'b' * 40
            old = upgrade._old_units(old_automation, old_financial)
            for name in upgrade.UNITS:
                (units / name).write_text(old[name])
            def state(name):
                return {'ActiveState': 'active' if name == 'domino-automation.service' else 'inactive',
                        'MainPID': '9' if name == 'domino-automation.service' else '0'}
            with patch.object(upgrade.os, 'geteuid', return_value=0), \
                 patch.object(upgrade.base, 'UNIT_DIR', units), \
                 patch.object(upgrade.base, 'trusted_parents'), \
                 patch.object(upgrade.base, 'pg_parents'), \
                 patch.object(upgrade.base, 'dependency_preflight'), \
                 patch.object(upgrade.base, 'trusted', side_effect=lambda p: Path(p).stat()), \
                 patch.object(upgrade, '_prior_receipts', return_value=(old_automation, old_financial)), \
                 patch.object(upgrade, '_upgrade_receipt', return_value=False), \
                 patch.object(upgrade, '_source_present', return_value=False), \
                 patch.object(upgrade, '_journal_dir', return_value=units / 'absent-journal'), \
                 patch.object(upgrade.financial, 'unit_state', side_effect=state), \
                 patch.object(upgrade.financial, 'sql', return_value='0'), \
                 patch.object(upgrade.base, 'run', side_effect=AssertionError('host mutation')):
                with self.assertRaisesRegex(ValueError, 'financial_service_must_be_off'):
                    upgrade.baseline(self.files, self.planned)

    def test_baseline_refuses_execution_status_under_a_release_dropin(self):
        with tempfile.TemporaryDirectory() as temp:
            units = Path(temp)
            old_automation, old_financial = 'a' * 40, 'b' * 40
            old = upgrade._old_units(old_automation, old_financial)
            for name in upgrade.UNITS:
                (units / name).write_text(old[name])
            dropin = units / 'domino-execution-status.service.d/50-release.conf'
            dropin.parent.mkdir()
            dropin.write_text('[Service]\n')
            inactive = {'ActiveState': 'inactive', 'MainPID': '0'}
            with patch.object(upgrade.os, 'geteuid', return_value=0), \
                 patch.object(upgrade.base, 'UNIT_DIR', units), \
                 patch.object(upgrade.base, 'trusted_parents'), \
                 patch.object(upgrade.base, 'pg_parents'), \
                 patch.object(upgrade.base, 'dependency_preflight'), \
                 patch.object(upgrade.base, 'trusted', side_effect=lambda p: Path(p).stat()), \
                 patch.object(upgrade, '_prior_receipts', return_value=(old_automation, old_financial)), \
                 patch.object(upgrade, '_upgrade_receipt', return_value=False), \
                 patch.object(upgrade, '_source_present', return_value=False), \
                 patch.object(upgrade, '_journal_dir', return_value=units / 'absent-journal'), \
                 patch.object(upgrade.financial, 'unit_state', return_value=inactive), \
                 patch.object(upgrade.financial, 'sql', return_value='0'), \
                 patch.object(upgrade.base, 'run', side_effect=AssertionError('host mutation')):
                with self.assertRaisesRegex(ValueError, 'execution_status_release_dropin'):
                    upgrade.baseline(self.files, self.planned)
                # Without it, the same off host is a baseline.
                dropin.unlink()
                self.assertFalse(upgrade.baseline(self.files, self.planned)['migrationCommitted'])

    def test_source_stage_is_immutable_and_contains_both_backend_components(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / 'releases').mkdir()
            files = {'backend/automation_cycle.py': (b'cycle', False),
                     'backend/execution_status.py': (b'status', False)}
            exclusive = upgrade.base.exclusive_file
            def fixture_file(path, raw, mode=0o600, **kwargs):
                return exclusive(path, raw, mode=mode, uid=os.getuid(), gid=os.getgid())
            with patch.object(upgrade.financial, 'ROOT', root), \
                 patch.object(upgrade.base, 'trusted_parents'), \
                 patch.object(upgrade.base, 'trusted', side_effect=lambda p: Path(p).stat()), \
                 patch.object(upgrade.base, 'exclusive_file', side_effect=fixture_file):
                upgrade._install_source(files, self.planned)
                self.assertTrue(upgrade._source_present(files, self.planned))
                upgrade._install_source(files, self.planned)
            for component in ('automation', 'execution-status'):
                for path, (raw, _) in files.items():
                    target = root / 'releases' / self.commit / component / path
                    self.assertEqual(target.read_bytes(), raw)
                    self.assertEqual(target.stat().st_mode & 0o777, 0o444)
            self.assertEqual(len(list((root / 'releases').iterdir())), 1)

    def test_apply_commits_once_and_retries_without_replaying_sql_or_starting_units(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            units = root / 'units'; units.mkdir()
            receipts = root / 'receipts'; receipts.mkdir()
            for name in upgrade.UNITS:
                (units / name).write_text('old:' + name)
            protected = {name: {'ActiveState': 'active', 'MainPID': '42'} for name in upgrade.financial.PROTECTED}
            initial = {'planSha256': upgrade.financial.sha(upgrade.financial.json_bytes(self.planned)),
                       'oldAutomationCommit': 'a' * 40, 'oldFinancialCommit': 'b' * 40,
                       'migrationCommitted': False, 'sourcePresent': False,
                       'unitHashes': {}, 'protected': protected}
            resumed = {**initial, 'migrationCommitted': True, 'sourcePresent': True}
            commands = []
            exclusive = upgrade.base.exclusive_file
            def fixture_file(path, raw, mode=0o600, **kwargs):
                return exclusive(path, raw, mode=mode, uid=os.getuid(), gid=os.getgid())
            def state(name):
                return protected.get(name, {'ActiveState': 'inactive', 'MainPID': '0'})
            with patch.object(upgrade.base, 'UNIT_DIR', units), \
                 patch.object(upgrade.automation, 'RECEIPTS', receipts), \
                 patch.object(upgrade, 'baseline', side_effect=[initial, resumed]), \
                 patch.object(upgrade, '_install_source'), \
                 patch.object(upgrade, '_install_receipt', return_value={'commit': 'a' * 40, 'migrations': []}), \
                 patch.object(upgrade, '_upgrade_receipt', return_value=True), \
                 patch.object(upgrade, '_old_units', return_value={name: 'old:' + name for name in upgrade.UNITS}), \
                 patch.object(upgrade.financial, 'unit_state', side_effect=state), \
                 patch.object(upgrade.financial, 'sql', return_value=''), \
                 patch.object(upgrade.base, 'exclusive_file', side_effect=fixture_file), \
                 patch.object(upgrade.base, 'run', side_effect=lambda args: commands.append(args) or b''):
                first = upgrade.apply(self.files, self.planned, initial)
                second = upgrade.apply(self.files, self.planned, resumed)
            self.assertEqual(first['phase'], 'installed_off')
            self.assertEqual(second['phase'], 'installed_off')
            self.assertEqual(sum('systemd-analyze' in str(command) for command in commands), 2)
            self.assertFalse(any('start' in str(arg) for command in commands for arg in command))
            self.assertEqual((receipts / ('readiness-' + self.commit) / 'journal.json').exists(), True)
            for name in upgrade.UNITS:
                self.assertEqual((units / name).read_text(), self.planned['units'][name])

    def test_rollback_refuses_unrelated_unit_drift_before_replacement(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            units = root / 'units'; units.mkdir()
            receipts = root / 'receipts'; receipts.mkdir()
            journal = receipts / ('readiness-' + self.commit); journal.mkdir()
            (journal / 'plan.json').write_bytes(upgrade.financial.json_bytes(self.planned))
            for name in upgrade.UNITS:
                (journal / (name + '.old')).write_text('old:' + name)
                (units / name).write_text(self.planned['units'][name])
            (units / upgrade.UNITS[0]).write_text('foreign unit change')
            with patch.object(upgrade.base, 'UNIT_DIR', units), \
                 patch.object(upgrade.automation, 'RECEIPTS', receipts), \
                 patch.object(upgrade.base, 'trusted_parents'), \
                 patch.object(upgrade.base, 'run', side_effect=AssertionError('unit replacement')):
                with self.assertRaisesRegex(ValueError, 'readiness_rollback_unit_drift'):
                    upgrade.rollback(self.planned)


if __name__ == '__main__':
    unittest.main()
