"""Offline coverage of the already-installed automation readiness upgrade."""
import hashlib
import json
import os
from pathlib import Path
import stat
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

    def test_plan_is_exactly_three_migrations_and_three_off_units(self):
        result = subprocess.run([sys.executable, str(REPO / 'scripts/staging/upgrade_automation_readiness.py'),
                                 '--archive', str(self.archive), '--archive-sha256', self.digest,
                                 '--commit', self.commit], capture_output=True, text=True,
                                env={'PATH': '/nonexistent', 'PYTHONDONTWRITEBYTECODE': '1'}, check=True)
        self.assertEqual(json.loads(result.stdout), self.planned)
        self.assertEqual([row['path'] for row in self.planned['migrations']],
                         list(upgrade.MIGRATIONS))
        self.assertEqual(set(self.planned['units']), set(upgrade.UNITS))
        self.assertEqual(len(upgrade.MIGRATIONS), 3)
        # execution-status has its own release tool; this upgrade never names it.
        self.assertNotIn('domino-execution-status.service', self.planned['units'])
        self.assertEqual(self.planned['sourceDirectory'], f'/opt/domino/financial/releases/{self.commit}/automation')
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

    def baseline_on(self, root, state, *, closed=None, database='0'):
        """baseline() on a host whose unit files, releases and unit states live under root."""
        units = root / 'units'
        units.mkdir(exist_ok=True)
        (root / 'releases').mkdir(exist_ok=True)
        os.chmod(root / 'releases', 0o755)
        old_automation, old_financial = 'a' * 40, 'b' * 40
        with patch.object(upgrade.os, 'geteuid', return_value=0), \
             patch.object(upgrade.financial, 'ROOT', root), \
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
             patch.object(upgrade.financial, 'sql', side_effect=database if callable(database) else None,
                          return_value=database), \
             patch.object(upgrade.base, 'run', side_effect=AssertionError('host mutation')):
            for name, text in upgrade._old_units(old_automation).items():
                (units / name).write_text(text)
            if closed is not None:
                os.chmod(closed, 0o700)
            try:
                return upgrade.baseline(self.files, self.planned)
            finally:
                if closed is not None:
                    os.chmod(closed, 0o755)

    def test_baseline_refuses_each_unit_it_needs_off_before_any_write(self):
        # The units it repoints, their socket and timer, and the standalone signer,
        # whose gas gate 046 replaces; nothing else.
        needed_off = ('domino-automation.service', 'domino-gas-reservation.service', 'domino-gas-settlement.service',
                      'domino-gas-reservation.socket', 'domino-gas-settlement.timer', 'domino-execution-signer.service')
        self.assertEqual(sorted(upgrade.OFF_UNITS), sorted(needed_off))
        for running in needed_off:
            def state(name):
                return ({'ActiveState': 'active', 'MainPID': '9'} if name == running
                        else {'ActiveState': 'inactive', 'MainPID': '0'})
            with self.subTest(running), tempfile.TemporaryDirectory() as temp:
                with self.assertRaisesRegex(ValueError, 'financial_service_must_be_off'):
                    self.baseline_on(Path(temp), state)

    def test_the_live_session_listener_and_execution_status_are_left_as_they_run(self):
        # 26 Sep 2026: sign-in live since the 25th, execution-status since the 26th
        # under install_financial_release.py's drop-in. Neither blocks the upgrade,
        # and both are recorded so that apply can prove them unchanged.
        live = {'domino-auth.service': {'ActiveState': 'active', 'MainPID': '3271599'},
                'domino-execution-status.service': {'ActiveState': 'active', 'MainPID': '3953379'}}
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            dropin = root / 'units/domino-execution-status.service.d/50-release.conf'
            dropin.parent.mkdir(parents=True)
            dropin.write_text('[Service]\n')
            result = self.baseline_on(root, lambda name: live.get(name, {'ActiveState': 'inactive', 'MainPID': '0'}))
        self.assertFalse(result['migrationCommitted'])
        for name, state in live.items():
            self.assertEqual(result['protected'][name], state)
        self.assertTrue(set(upgrade.financial.PROTECTED) <= set(result['protected']))
        self.assertFalse(set(upgrade.OFF_UNITS) & set(result['protected']))

    def test_baseline_refuses_a_closed_release_before_the_database(self):
        off = lambda name: {'ActiveState': 'inactive', 'MainPID': '0'}
        def no_database(*args, **kwargs):
            raise AssertionError('database reached')
        for closed in ('commit', 'releases'):
            with self.subTest(closed), tempfile.TemporaryDirectory() as temp:
                root = Path(temp)
                release = root / 'releases' / self.commit
                release.mkdir(parents=True)
                with self.assertRaisesRegex(ValueError, 'release_directory_not_traversable'):
                    self.baseline_on(root, off, closed=release if closed == 'commit' else root / 'releases',
                                     database=no_database)
                # Open, the same host is a baseline.
                self.assertFalse(self.baseline_on(root, off)['migrationCommitted'])

    FILES = {'backend/automation_cycle.py': (b'cycle', False), 'backend/runtime_helpers/tool.py': (b'tool', True),
             'backend/tests/test_cycle.py': (b'test', False)}

    def stage(self, root, **patches):
        exclusive = upgrade.base.exclusive_file
        def fixture_file(path, raw, mode=0o600, **kwargs):
            return exclusive(path, raw, mode=mode, uid=os.getuid(), gid=os.getgid())
        with patch.object(upgrade.financial, 'ROOT', root), \
             patch.object(upgrade.base, 'trusted_parents'), \
             patch.object(upgrade.base, 'trusted', side_effect=lambda p: Path(p).stat()), \
             patch.object(upgrade.base, 'exclusive_file', side_effect=patches.get('exclusive_file', fixture_file)):
            upgrade._install_source(self.FILES, self.planned)
            return upgrade._source_present(self.FILES, self.planned)

    def test_source_stage_is_immutable_and_traversable_whatever_the_umask(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / 'releases').mkdir(); os.chmod(root / 'releases', 0o755)
            previous = os.umask(0o077)
            try:
                self.assertTrue(self.stage(root))
                self.assertTrue(self.stage(root))  # a retry finds it in place
            finally:
                os.umask(previous)
            release = root / 'releases' / self.commit
            self.assertEqual(sorted(p.name for p in release.iterdir()), ['automation'])
            self.assertEqual(stat.S_IMODE(release.stat().st_mode), 0o555)
            for directory in (release / 'automation', *(p for p in (release / 'automation').rglob('*') if p.is_dir())):
                self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o555, directory)
            self.assertEqual((release / 'automation/backend/automation_cycle.py').read_bytes(), b'cycle')
            self.assertEqual(stat.S_IMODE((release / 'automation/backend/runtime_helpers/tool.py').stat().st_mode), 0o555)
            self.assertFalse((release / 'automation/backend/tests').exists())

    def test_source_stage_sits_beside_another_installers_component_only_if_traversable(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            release = root / 'releases' / self.commit
            (release / 'execution-status').mkdir(parents=True)
            (release / 'execution-status/marker').write_bytes(b'status')
            os.chmod(root / 'releases', 0o755)
            os.chmod(release, 0o700)
            with self.assertRaisesRegex(ValueError, 'release_directory_not_traversable'):
                self.stage(root)
            self.assertEqual(sorted(p.name for p in release.iterdir()), ['execution-status'])
            os.chmod(release, 0o755)
            self.assertTrue(self.stage(root))
            self.assertEqual(sorted(p.name for p in release.iterdir()), ['automation', 'execution-status'])
            self.assertEqual((release / 'execution-status/marker').read_bytes(), b'status')
            # Not this installer's directory: its mode is left as it was.
            self.assertEqual(stat.S_IMODE(release.stat().st_mode), 0o755)

    def test_source_stage_refuses_a_closed_releases_root(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / 'releases').mkdir(); os.chmod(root / 'releases', 0o750)
            with self.assertRaisesRegex(ValueError, 'release_directory_not_traversable'):
                self.stage(root)
            self.assertEqual(list((root / 'releases').iterdir()), [])

    def test_a_failed_stage_leaves_neither_staging_nor_an_empty_release(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp); (root / 'releases').mkdir(); os.chmod(root / 'releases', 0o755)
            exclusive = upgrade.base.exclusive_file
            calls = []
            def failing(path, raw, mode=0o600, **kwargs):
                calls.append(path)
                if len(calls) == 2:
                    raise OSError('disk full')
                return exclusive(path, raw, mode=mode, uid=os.getuid(), gid=os.getgid())
            with self.assertRaisesRegex(OSError, 'disk full'):
                self.stage(root, exclusive_file=failing)
            self.assertEqual(list((root / 'releases').iterdir()), [])

    def test_apply_commits_once_and_retries_without_replaying_sql_or_starting_units(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            units = root / 'units'; units.mkdir()
            receipts = root / 'receipts'; receipts.mkdir()
            for name in upgrade.UNITS:
                (units / name).write_text('old:' + name)
            protected = {name: {'ActiveState': 'active', 'MainPID': '42'} for name in upgrade.WATCHED}
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

    def test_apply_rolls_back_units_when_a_live_listener_changed_underneath(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            units = root / 'units'; units.mkdir()
            receipts = root / 'receipts'; receipts.mkdir()
            for name in upgrade.UNITS:
                (units / name).write_text('old:' + name)
            before = {name: {'ActiveState': 'active', 'MainPID': '42'} for name in upgrade.WATCHED}
            expected = {'planSha256': upgrade.financial.sha(upgrade.financial.json_bytes(self.planned)),
                        'oldAutomationCommit': 'a' * 40, 'oldFinancialCommit': 'b' * 40,
                        'migrationCommitted': False, 'sourcePresent': False, 'unitHashes': {}, 'protected': before}
            def state(name):
                if name == 'domino-auth.service':
                    return {'ActiveState': 'active', 'MainPID': '43'}  # restarted meanwhile
                return before.get(name, {'ActiveState': 'inactive', 'MainPID': '0'})
            exclusive = upgrade.base.exclusive_file
            def fixture_file(path, raw, mode=0o600, **kwargs):
                return exclusive(path, raw, mode=mode, uid=os.getuid(), gid=os.getgid())
            with patch.object(upgrade.base, 'UNIT_DIR', units), \
                 patch.object(upgrade.automation, 'RECEIPTS', receipts), \
                 patch.object(upgrade, 'baseline', return_value=expected), \
                 patch.object(upgrade, '_install_source'), \
                 patch.object(upgrade, '_install_receipt', return_value={'commit': 'a' * 40, 'migrations': []}), \
                 patch.object(upgrade, '_upgrade_receipt', return_value=True), \
                 patch.object(upgrade.financial, 'unit_state', side_effect=state), \
                 patch.object(upgrade.financial, 'sql', return_value=''), \
                 patch.object(upgrade.base, 'trusted_parents'), \
                 patch.object(upgrade.base, 'exclusive_file', side_effect=fixture_file), \
                 patch.object(upgrade.base, 'run', return_value=b''):
                with self.assertRaisesRegex(ValueError, 'protected_lane_changed'):
                    upgrade.apply(self.files, self.planned, expected)
            for name in upgrade.UNITS:
                self.assertEqual((units / name).read_text(), 'old:' + name)

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
