"""The automation and its two gas peers move to a newer release through one drop-in each, and back."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import install_automation_release as installer
import upgrade_automation_readiness as readiness
# One model of how systemd folds a drop-in over a unit, shared with the other release
# installers; test_financial_release_systemd.py holds it to systemd itself.
from test_install_auth_release import settings

REPO = Path(__file__).resolve().parents[3]
BEFORE = 'a' * 40
OTHER = 'c' * 40
# The commit the automation was first installed at, 028-038 with it.
FIRST = 'f' * 40
NEVER = ('service, socket or timer start, stop, restart or daemon-reload', 'unit file change',
         'database writes or migrations', 'private configuration, keystore or credential reads')
SERVICES = tuple(installer.service(name) for name in installer.UNITS)
# What backend/configure_automation.py writes beside the automation's unit.
KEYSTORE = ('[Service]\n'
            'LoadCredentialEncrypted=operator-keystore-password:'
            '/etc/domino/financial/automation/operator-keystore-password.cred\n'
            'LoadCredentialEncrypted=publisher-keystore-password:'
            '/etc/domino/financial/automation/publisher-keystore-password.cred\n')


class AutomationReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='domino-automation-release-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.archive = Path(cls.temp.name) / 'source.tar'
        cls.commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
        subprocess.run(['git', 'archive', '--format=tar', '-o', str(cls.archive), cls.commit],
                       cwd=REPO, check=True)
        cls.digest = hashlib.sha256(cls.archive.read_bytes()).hexdigest()
        cls.files = installer.install.archive_files(cls.archive, cls.digest, cls.commit)

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(dir=self.temp.name))
        self.addCleanup(self.opened, self.root)
        self.releases = self.root / 'financial/releases'
        self.units = self.root / 'systemd'
        tool = installer.release_tool
        for item in (patch.object(tool.financial, 'ROOT', self.root / 'financial'),
                     patch.object(tool, 'RELEASES', self.releases),
                     patch.object(tool, 'UNIT_DIR', self.units),
                     patch.object(installer, 'BACKUPS', self.root / 'backups'),
                     patch.object(installer.filesystem, 'protected_parents', lambda path: None),
                     patch.object(installer.os, 'geteuid', lambda: 0),
                     patch.object(installer.install, 'run', self.fake_run)):
            item.start()
            self.addCleanup(item.stop)
        self.units.mkdir()
        (self.root / 'backups').mkdir()
        running = self.releases / BEFORE / 'automation/backend'
        running.mkdir(parents=True)
        (running / 'requirements-api.lock').write_bytes(self.files[tool.LOCKFILE][0])
        for name in installer.UNITS:
            self.unit(name).write_text(installer.unit_text(name, BEFORE))
        migrations = [{'path': path, 'sha256': installer.sha(self.files[path][0])}
                      for path in installer.automation.MIGRATIONS]
        # The first install receipted 028-038 and the readiness upgrade 039, 040 and 046.
        self.install_receipt = {'commit': FIRST, 'migrations': migrations[:-3]}
        self.readiness_receipt = migrations[-3:]
        self.tables = {installer.INSTALL_RECEIPT: True, installer.READINESS_RECEIPT: True}
        self.queries = []
        self.states = {}
        for name in installer.UNITS:
            self.reload(name)

    @staticmethod
    def opened(root):
        for directory, _, _ in os.walk(root):
            os.chmod(directory, 0o755)

    def unit(self, name):
        return self.units / installer.service(name)

    def keystore_dropin(self, name='automation'):
        return installer.dropin(name).with_name(installer.KEYSTORE_DROPIN)

    def reload(self, name='automation', **changes):
        """What `systemctl daemon-reload` makes of the files, then any override."""
        present = [path for path in (self.keystore_dropin(name), installer.dropin(name)) if path.exists()]
        effective = settings(self.unit(name).read_text())
        for path in present:
            effective = settings(path.read_text(), effective)
        self.states[installer.service(name)] = {
            'LoadState': 'loaded', 'ActiveState': 'inactive', 'NeedDaemonReload': 'no',
            'FragmentPath': str(self.unit(name)), 'DropInPaths': ' '.join(str(p) for p in present),
            'WorkingDirectory': effective['[Service]']['WorkingDirectory'][0], **changes}

    def reload_all(self):
        for name in installer.UNITS:
            self.reload(name)

    def fake_run(self, args, *, data=None, stdout=None):
        if args[:2] == ['/usr/bin/systemctl', 'show'] and args[2] in self.states:
            return ''.join(f'{k}={v}\n' for k, v in self.states[args[2]].items()).encode()
        if args[0] == '/usr/sbin/runuser':
            query = data.decode()
            self.queries.append(query)
            return (self.answer(query) + '\n').encode()
        raise AssertionError(f'unexpected host command: {args}')

    def answer(self, query):
        for table, present in self.tables.items():
            if query == f"SELECT to_regclass('{table}') IS NOT NULL;":
                return 't' if present else 'f'
        if query.startswith(f'SELECT value::text FROM {installer.INSTALL_RECEIPT} '):
            return '' if self.install_receipt is None else json.dumps(self.install_receipt)
        if query.endswith(f'FROM {installer.READINESS_RECEIPT};'):
            return json.dumps(self.readiness_receipt)
        raise AssertionError(f'unexpected query: {query}')

    def plan(self, commit=None, files=None):
        return installer.plan(files or self.files, commit or self.commit, self.digest)

    def apply(self, commit=None, files=None):
        return installer.apply(files or self.files, self.plan(commit, files))

    def receipt(self, commit=None):
        return self.root / 'backups/domino-automation-release' / f'{commit or self.commit}.json'

    def test_the_plan_moves_the_three_units_from_the_release_they_share(self):
        planned = self.plan()
        self.assertEqual((planned['mode'], planned['fromCommit'], planned['commit']),
                         ('automation-release-install', BEFORE, self.commit))
        self.assertEqual(planned['target'], str(self.releases / self.commit / 'automation'))
        self.assertEqual(planned['migrationsApplied'], len(installer.automation.MIGRATIONS))
        self.assertEqual(sorted(planned['units']), sorted(SERVICES))
        for name in installer.UNITS:
            with self.subTest(unit=name):
                self.assertEqual(planned['units'][installer.service(name)], {
                    'unitCommit': BEFORE, 'dropin': str(self.units / f'domino-{name}.service.d/50-release.conf'),
                    'dropinSha256': hashlib.sha256(installer.dropin_text(name, self.commit).encode()).hexdigest(),
                    'previousDropin': None, 'active': False})
        for never in NEVER:
            self.assertIn(never, planned['notPerformed'])
        # The database is only read: whether the two receipts exist, and what they hold.
        self.assertTrue(self.queries and all(query.startswith('SELECT ') for query in self.queries))
        self.reload('gas-reservation', ActiveState='active')
        self.assertIs(self.plan()['units']['domino-gas-reservation.service']['active'], True)

    def test_each_dropin_over_its_installed_unit_is_the_unit_written_for_the_new_release(self):
        for name in installer.UNITS:
            with self.subTest(unit=name):
                before = settings(installer.unit_text(name, BEFORE))
                wanted = settings(installer.unit_text(name, self.commit))
                self.assertNotEqual(before, wanted)
                self.assertEqual(settings(installer.dropin_text(name, self.commit), before), wanted)
        # Only what names a release: the automation's runtime bind does, the peers bind only their configuration.
        self.assertEqual(sorted(settings(installer.dropin_text('automation', self.commit))['[Service]']),
                         ['Binds', 'WorkingDirectory'])
        for name in ('gas-reservation', 'gas-settlement'):
            self.assertEqual(sorted(settings(installer.dropin_text(name, self.commit))['[Service]']),
                             ['WorkingDirectory'])
        wanted = settings(installer.unit_text('automation', self.commit))
        self.assertEqual([key for key, _ in wanted['[Service]']['Binds']], ['BindPaths', 'BindReadOnlyPaths'])
        # The private runtime lives outside every release, so its state carries over.
        self.assertEqual(wanted['[Service]']['Binds'][0][1].split(':')[0], '/var/lib/domino-financial/automation')
        # The keystore drop-in sorts before this one and names no release: the unit keeps its credentials.
        keyed = settings(KEYSTORE, settings(installer.unit_text('automation', BEFORE)))
        self.assertEqual(settings(installer.dropin_text('automation', self.commit), keyed), settings(KEYSTORE, wanted))

    def test_each_unit_must_be_loaded_where_and_as_the_installer_wrote_it(self):
        for name in installer.UNITS:
            ours = installer.dropin(name)
            for changes, reason in (({'LoadState': 'not-found'}, 'unit_not_loaded'),
                                    ({'FragmentPath': f'/usr/lib/systemd/system/domino-{name}.service'}, 'unit_moved'),
                                    ({'NeedDaemonReload': 'yes'}, 'daemon_reload_pending'),
                                    ({'DropInPaths': str(ours.with_name('override.conf'))}, 'foreign_dropin'),
                                    ({'WorkingDirectory': str(self.releases / OTHER / 'automation')},
                                     'release_mismatch'),
                                    ({'WorkingDirectory': str(self.releases / BEFORE / 'execution-status')},
                                     'release_mismatch'),
                                    ({'WorkingDirectory': '/opt/domino/releases/' + BEFORE + '/automation'},
                                     'release_mismatch')):
                with self.subTest(unit=name, reason=reason, changes=changes):
                    self.reload(name, **changes)
                    # Each unit on its own, before the three are compared.
                    with self.assertRaisesRegex(ValueError, reason):
                        installer.current(name)
            self.reload(name)
        self.assertEqual(self.plan()['fromCommit'], BEFORE)

    def test_the_keystore_dropin_is_expected_beside_the_automation_and_nowhere_else(self):
        keystore = self.keystore_dropin()
        keystore.parent.mkdir()
        keystore.write_text(KEYSTORE)
        self.reload()
        self.assertEqual(self.plan()['fromCommit'], BEFORE)
        for name in ('gas-reservation', 'gas-settlement'):
            with self.subTest(unit=name):
                peer = self.keystore_dropin(name)
                peer.parent.mkdir()
                peer.write_text(KEYSTORE)
                self.reload(name)
                with self.assertRaisesRegex(ValueError, 'foreign_dropin'):
                    self.plan()
                peer.unlink()
                self.reload(name)

    def test_the_three_units_must_run_one_release(self):
        # The reservation peer alone runs another release, through a drop-in of this tool's.
        ours = installer.dropin('gas-reservation')
        ours.parent.mkdir()
        ours.write_text(installer.dropin_text('gas-reservation', OTHER))
        self.reload('gas-reservation')
        self.assertEqual(installer.current('gas-reservation')[2], OTHER)
        with self.assertRaisesRegex(ValueError, 'release_mismatch'):
            self.plan()

    def test_a_dropin_on_disk_that_systemd_has_not_loaded_or_lost_is_a_pending_reload(self):
        ours = installer.dropin('gas-settlement')
        ours.parent.mkdir()
        ours.write_text(installer.dropin_text('gas-settlement', OTHER))
        with self.assertRaisesRegex(ValueError, 'daemon_reload_pending'):
            self.plan()
        ours.unlink()
        ours.symlink_to(self.root / 'gone')
        with self.assertRaisesRegex(ValueError, 'daemon_reload_pending'):
            self.plan()
        ours.unlink()
        self.reload('gas-settlement', DropInPaths=str(ours))
        with self.assertRaisesRegex(ValueError, 'daemon_reload_pending'):
            self.plan()

    def test_a_unit_file_edited_or_from_another_installer_is_refused(self):
        unit = self.unit('automation')
        unit.write_text(installer.unit_text('automation', BEFORE) + 'Environment=EXTRA=1\n')
        with self.assertRaisesRegex(ValueError, 'unit_drift'):
            self.plan()
        # A peer's unit names the same release, but it is not this unit.
        unit.write_text(installer.unit_text('gas-reservation', BEFORE))
        with self.assertRaisesRegex(ValueError, 'unit_drift'):
            self.plan()
        # Another component's unit names another component's root.
        unit.write_text(installer.release_tool.financial.unit_text('execution-status', BEFORE))
        with self.assertRaisesRegex(ValueError, 'unit_not_automation'):
            self.plan()
        unit.write_text('[Service]\nExecStart=/bin/true\n')
        with self.assertRaisesRegex(ValueError, 'unit_not_automation'):
            self.plan()
        # A release root is named by a full commit, never by an arbitrary directory.
        unit.write_text(installer.unit_text('automation', 'release-1'))
        with self.assertRaisesRegex(ValueError, 'unit_not_automation'):
            self.plan()

    def test_a_loaded_dropin_must_be_exactly_the_one_this_tool_writes(self):
        ours = installer.dropin('automation')
        ours.parent.mkdir()
        ours.write_text(installer.dropin_text('automation', OTHER) + 'Environment=EXTRA=1\n')
        self.reload()
        with self.assertRaisesRegex(ValueError, 'dropin_drift'):
            self.plan()
        # The same settings under the financial release installer's header are not this tool's.
        ours.write_text(installer.dropin_text('automation', OTHER).replace(installer.HEADER,
                                                                           installer.release_tool.HEADER))
        with self.assertRaisesRegex(ValueError, 'dropin_drift'):
            self.plan()
        ours.write_text(installer.dropin_text('automation', OTHER))
        self.reload(WorkingDirectory='/srv/elsewhere/automation')
        with self.assertRaisesRegex(ValueError, 'release_mismatch'):
            self.plan()

    def test_what_the_release_needs_from_the_host_and_the_archive(self):
        # As if the three already ran this very commit.
        running = self.releases / self.commit / 'automation/backend'
        running.mkdir(parents=True)
        (running / 'requirements-api.lock').write_bytes(self.files[installer.release_tool.LOCKFILE][0])
        for name in installer.UNITS:
            self.unit(name).write_text(installer.unit_text(name, self.commit))
        self.reload_all()
        with self.assertRaisesRegex(ValueError, 'release_already_running'):
            self.plan()
        (self.releases / OTHER / 'automation').mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'release_directory_exists'):
            self.plan(commit=OTHER)
        (self.releases / OTHER / 'automation').rmdir()
        (self.releases / OTHER / 'automation').symlink_to(self.root / 'gone')
        with self.assertRaisesRegex(ValueError, 'release_directory_exists'):
            self.plan(commit=OTHER)
        (self.releases / OTHER / 'automation').unlink()
        lock = running / 'requirements-api.lock'
        lock.write_bytes(b'other==1.0\n')
        with self.assertRaisesRegex(ValueError, 'dependency_change_needs_a_venv'):
            self.plan(commit=OTHER)
        lock.write_bytes(self.files[installer.release_tool.LOCKFILE][0])
        for script in ('backend/automation_cli.py', 'backend/gas_budget_bridge.py', 'backend/gas_settlement_cli.py'):
            with self.subTest(script=script), self.assertRaisesRegex(ValueError, 'entry_script_missing'):
                self.plan(commit=OTHER, files={k: v for k, v in self.files.items() if k != script})
        self.assertEqual(self.plan(commit=OTHER)['fromCommit'], self.commit)

    def test_the_release_must_carry_the_installer_this_tool_reads_its_units_from(self):
        installer_path = installer.INSTALLER
        for files in ({k: v for k, v in self.files.items() if k != installer_path},
                      {**self.files, installer_path: (self.files[installer_path][0] + b'\n', False)}):
            with self.subTest(), self.assertRaisesRegex(ValueError, 'installer_differs_from_release'):
                self.plan(files=files)
        self.assertEqual(self.files[installer_path][0], Path(installer.automation.__file__).read_bytes())

    def test_every_automation_migration_must_be_applied_here_with_the_same_bytes(self):
        # Before the readiness upgrade, 039, 040 and 046 are not.
        self.tables[installer.READINESS_RECEIPT] = False
        with self.assertRaisesRegex(ValueError, 'automation_migration_not_applied'):
            self.plan()
        self.tables[installer.READINESS_RECEIPT] = True
        # A migration the release carries with other bytes than the ones applied, from either receipt.
        for path in ('backend/migrations/028_automation_cycle.sql', 'backend/migrations/046_gas_answer_heartbeat.sql'):
            with self.subTest(path=path), self.assertRaisesRegex(ValueError, 'automation_migration_changed'):
                self.plan(files={**self.files, path: (b'SELECT 1;\n', False)})
        without = {k: v for k, v in self.files.items() if k != 'backend/migrations/039_automation_readiness.sql'}
        with self.assertRaisesRegex(ValueError, 'automation_migration_missing'):
            self.plan(files=without)
        # One the receipts never recorded.
        readiness = self.readiness_receipt
        self.readiness_receipt = readiness[:-1]
        with self.assertRaisesRegex(ValueError, 'automation_migration_not_applied'):
            self.plan()
        self.readiness_receipt = readiness
        self.assertEqual(self.plan()['migrationsApplied'], len(installer.automation.MIGRATIONS))

    def test_the_receipts_must_exist_and_agree(self):
        self.tables[installer.INSTALL_RECEIPT] = False
        with self.assertRaisesRegex(ValueError, 'automation_install_receipt_missing'):
            self.plan()
        self.tables[installer.INSTALL_RECEIPT] = True
        original = self.install_receipt
        self.install_receipt = None
        with self.assertRaisesRegex(ValueError, 'automation_install_receipt_missing'):
            self.plan()
        first = original['migrations'][0]
        for broken in ([], {'commit': FIRST}, {'commit': FIRST, 'migrations': {}},
                       {'commit': FIRST, 'migrations': [[first['path'], first['sha256']]]},
                       {'commit': FIRST, 'migrations': [{**first, 'path': 1}, *original['migrations']]},
                       {'commit': FIRST, 'migrations': [{**first, 'sha256': None}, *original['migrations'][1:]]}):
            self.install_receipt = broken
            with self.subTest(broken=broken), self.assertRaisesRegex(ValueError, 'automation_receipt_invalid'):
                self.plan()
        self.install_receipt = original
        # One path recorded twice with two digests is no record at all; twice the same is one.
        readiness = self.readiness_receipt
        self.readiness_receipt = [*readiness, {**first, 'sha256': '0' * 64}]
        with self.assertRaisesRegex(ValueError, 'automation_receipt_invalid'):
            self.plan()
        self.readiness_receipt = [*readiness, first]
        self.assertEqual(self.plan()['fromCommit'], BEFORE)

    def test_apply_writes_one_release_and_three_dropins_whatever_the_umask(self):
        keystore = self.keystore_dropin()
        keystore.parent.mkdir()
        keystore.write_text(KEYSTORE)
        self.reload()
        planned = self.plan()
        umask = os.umask(0o077)
        try:
            result = installer.apply(self.files, planned)
        finally:
            os.umask(umask)
        self.assertEqual((result['installed'], result['activated'], result['fromCommit']), (True, False, BEFORE))
        self.assertEqual(result['activation'],
                         'systemctl daemon-reload; the three units run this release from their next start')
        self.assertIn(f'--rollback {self.commit}', result['rollback'])
        release = self.releases / self.commit
        root = release / 'automation'
        # Every parent the units' users cross is open to them, the commit directory included.
        for directory in (release, root, root / 'backend'):
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o555, directory)
        self.assertEqual([p.name for p in release.iterdir()], ['automation'])
        expected = {name: value for name, value in self.files.items()
                    if name.startswith('backend/') and not name.startswith('backend/tests/')}
        self.assertEqual({str(p.relative_to(root)) for p in root.rglob('*') if p.is_file()}, set(expected))
        for name, (payload, executable) in expected.items():
            self.assertEqual((root / name).read_bytes(), payload, name)
            self.assertEqual(stat.S_IMODE((root / name).stat().st_mode), 0o555 if executable else 0o444, name)
        self.assertTrue((root / 'backend/runtime').is_dir())
        self.assertEqual(result['dropins'], [str(installer.dropin(name)) for name in installer.UNITS])
        for name in installer.UNITS:
            ours = installer.dropin(name)
            self.assertEqual(ours.read_text(), installer.dropin_text(name, self.commit))
            self.assertEqual(stat.S_IMODE(ours.stat().st_mode), 0o644)
            self.assertEqual(stat.S_IMODE(ours.parent.stat().st_mode), 0o755)
            # The unit file stays as the installer wrote it.
            self.assertEqual(self.unit(name).read_text(), installer.unit_text(name, BEFORE))
        self.assertEqual(keystore.read_text(), KEYSTORE)
        receipt = self.receipt()
        self.assertEqual(result['receipt'], str(receipt))
        self.assertEqual(stat.S_IMODE(receipt.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(receipt.parent.stat().st_mode), 0o700)
        self.assertEqual(json.loads(receipt.read_text()), planned)
        self.assertEqual(sorted(p.name for p in (self.releases / BEFORE / 'automation/backend').iterdir()),
                         ['requirements-api.lock'])
        # Until systemd reloads, nothing else can be planned; after, this release runs.
        with self.assertRaisesRegex(ValueError, 'daemon_reload_pending'):
            self.plan()
        self.reload_all()
        for name in installer.UNITS:
            self.assertEqual(self.states[installer.service(name)]['WorkingDirectory'], str(root))
        self.assertEqual(self.plan(commit=OTHER)['fromCommit'], self.commit)

    def test_activation_names_the_units_that_run(self):
        planned = {'units': {unit: {'active': False} for unit in SERVICES}}
        self.assertEqual(installer.activation(planned),
                         'systemctl daemon-reload; the three units run this release from their next start')
        planned['units']['domino-automation.service']['active'] = True
        planned['units']['domino-gas-reservation.service']['active'] = True
        self.assertEqual(installer.activation(planned),
                         'systemctl daemon-reload; then systemctl restart domino-automation.service '
                         'domino-gas-reservation.service: a running unit keeps the old release until it restarts, '
                         'the others take this one at their next start')
        self.reload('automation', ActiveState='active')
        self.assertIn('systemctl restart domino-automation.service:', self.apply()['activation'])

    def test_the_release_shares_its_commit_directory_with_another_component(self):
        release = self.releases / self.commit
        (release / 'execution-status/backend').mkdir(parents=True)
        (release / 'execution-status/backend/marker').write_bytes(b'status')
        self.apply()
        self.assertEqual(sorted(p.name for p in release.iterdir()), ['automation', 'execution-status'])
        self.assertEqual((release / 'execution-status/backend/marker').read_bytes(), b'status')
        self.assertEqual(stat.S_IMODE(release.stat().st_mode), 0o755)

    def test_a_failure_while_writing_the_release_leaves_nothing_behind(self):
        write = installer.auth.write_new
        calls = []

        def failing(path, payload, mode):
            calls.append(path)
            if len(calls) == 5:
                raise OSError('disk full')
            write(path, payload, mode)
        planned = self.plan()
        with patch.object(installer.auth, 'write_new', failing), self.assertRaisesRegex(OSError, 'disk full'):
            installer.apply(self.files, planned)
        self.assertFalse((self.releases / self.commit).exists())
        self.assertFalse(self.receipt().exists())
        for name in installer.UNITS:
            self.assertFalse(installer.dropin(name).exists(), name)
        # A clean host: the same commit applies from scratch.
        self.assertTrue(installer.apply(self.files, planned)['installed'])

    def test_a_dropin_that_fails_to_be_written_leaves_a_receipt_rollback_follows(self):
        planned = self.plan()
        write = installer.release_tool.write_dropin

        def failing(name, text):
            if name == 'gas-settlement':
                raise OSError('busy')
            write(name, text)
        with patch.object(installer.release_tool, 'write_dropin', failing), self.assertRaisesRegex(OSError, 'busy'):
            installer.apply(self.files, planned)
        self.assertTrue(self.receipt().exists())
        self.assertEqual(installer.dropin('automation').read_text(), installer.dropin_text('automation', self.commit))
        self.assertFalse(installer.dropin('gas-settlement').exists())
        self.assertEqual(installer.rollback(self.commit)['runs'], BEFORE)
        for name in installer.UNITS:
            self.assertFalse(installer.dropin(name).exists(), name)

    def test_receipts_are_private_and_written_once(self):
        directory = self.receipt().parent
        directory.mkdir(mode=0o755)
        os.chmod(directory, 0o755)
        with self.assertRaisesRegex(ValueError, 'receipt_directory_not_private'):
            self.apply()
        os.chmod(directory, 0o700)
        self.receipt().write_text('{}')
        with self.assertRaisesRegex(ValueError, 'receipt_exists'):
            self.apply()
        self.receipt().unlink()
        self.receipt().symlink_to(self.root / 'gone')
        with self.assertRaisesRegex(ValueError, 'receipt_exists'):
            self.apply()
        self.assertFalse((self.releases / self.commit).exists())

    def test_apply_and_rollback_need_root(self):
        planned = self.plan()
        with patch.object(installer.os, 'geteuid', lambda: 1000):
            with self.assertRaisesRegex(ValueError, 'root_required'):
                installer.apply(self.files, planned)
            with self.assertRaisesRegex(ValueError, 'root_required'):
                installer.rollback(self.commit)
        self.assertFalse((self.releases / self.commit).exists())

    def test_rollback_walks_back_one_release_at_a_time_and_keeps_the_releases(self):
        self.apply()
        self.reload_all()
        second = self.apply(commit=OTHER)
        saved = json.loads(self.receipt(OTHER).read_text())
        for name in installer.UNITS:
            self.assertEqual(saved['units'][installer.service(name)]['previousDropin'],
                             installer.dropin_text(name, self.commit))
            self.assertEqual(installer.dropin(name).read_text(), installer.dropin_text(name, OTHER))
        rolled = installer.rollback(OTHER)
        self.assertEqual((rolled['runs'], rolled['releaseRetained'], rolled['activated']), (self.commit, True, False))
        for name in installer.UNITS:
            self.assertEqual(installer.dropin(name).read_text(), installer.dropin_text(name, self.commit))
        self.reload_all()
        self.assertEqual(self.plan(commit='e' * 40)['fromCommit'], self.commit)
        self.assertEqual(installer.rollback(self.commit)['runs'], BEFORE)
        self.reload_all()
        for name in installer.UNITS:
            self.assertFalse(installer.dropin(name).exists(), name)
            self.assertEqual(self.states[installer.service(name)]['WorkingDirectory'],
                             str(self.releases / BEFORE / 'automation'))
        self.assertTrue((self.releases / OTHER / 'automation').is_dir())
        self.assertTrue((self.releases / self.commit / 'automation').is_dir())
        self.assertIn('--rollback', second['rollback'])
        # Twice is harmless: nothing of this release is left to take back.
        self.assertEqual(installer.rollback(self.commit)['runs'], BEFORE)

    def test_rollback_checks_every_dropin_before_it_changes_any(self):
        self.apply()
        installer.dropin('gas-settlement').write_text(installer.dropin_text('gas-settlement', OTHER))
        with self.assertRaisesRegex(ValueError, 'rollback_is_not_current'):
            installer.rollback(self.commit)
        for name in ('automation', 'gas-reservation'):
            self.assertEqual(installer.dropin(name).read_text(), installer.dropin_text(name, self.commit), name)

    def test_rollback_refuses_a_receipt_it_cannot_trust(self):
        self.apply()
        receipt = self.receipt()
        saved = json.loads(receipt.read_text())
        units = saved['units']
        automation_unit = units['domino-automation.service']
        for broken in ({**saved, 'mode': 'financial-release-install'}, {**saved, 'commit': OTHER},
                       {**saved, 'fromCommit': 'not-a-commit'}, {**saved, 'fromCommit': None},
                       {**saved, 'units': list(SERVICES)},
                       {**saved, 'units': {k: v for k, v in units.items() if k != 'domino-gas-settlement.service'}},
                       {**saved, 'units': {**units, 'domino-gas-settlement.service': None}},
                       {**saved, 'units': {**units, 'domino-automation.service': {
                           **automation_unit, 'previousDropin': installer.dropin_text('automation', OTHER)}}}):
            with self.subTest(broken=broken):
                receipt.write_text(json.dumps(broken))
                with self.assertRaisesRegex(ValueError, 'invalid_receipt'):
                    installer.rollback(self.commit)
        receipt.write_text(json.dumps(saved))
        os.rename(self.releases / BEFORE / 'automation', self.releases / BEFORE / 'moved')
        with self.assertRaisesRegex(ValueError, 'previous_release_missing'):
            installer.rollback(self.commit)
        with self.assertRaisesRegex(ValueError, 'invalid_commit'):
            installer.rollback('HEAD')
        for name in installer.UNITS:
            self.assertEqual(installer.dropin(name).read_text(), installer.dropin_text(name, self.commit), name)
        # A link where a drop-in was is read, never followed or taken for absence.
        os.rename(self.releases / BEFORE / 'moved', self.releases / BEFORE / 'automation')
        reservation = installer.dropin('gas-reservation')
        reservation.unlink()
        reservation.symlink_to(self.root / 'gone')
        with self.assertRaises(OSError):
            installer.rollback(self.commit)
        self.assertTrue(reservation.is_symlink())
        self.assertEqual(installer.dropin('automation').read_text(), installer.dropin_text('automation', self.commit))

    def main(self, *argv):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = installer.main(list(argv))
        return code, json.loads(output.getvalue())

    def test_the_command_line_inspects_applies_and_rolls_back_under_the_lock(self):
        archive = ('--archive', str(self.archive), '--archive-sha256', self.digest, '--commit', self.commit)
        taken = []

        @contextlib.contextmanager
        def exclusive():
            taken.append(True)
            yield
        with patch.object(installer, 'exclusive', exclusive):
            code, inspected = self.main('--inspect', *archive)
            self.assertEqual((code, inspected['ok'], inspected['installed'], inspected['fromCommit']),
                             (0, True, False, BEFORE))
            self.assertEqual((taken, installer.dropin('automation').exists(), self.receipt().exists()),
                             ([], False, False))
            code, applied = self.main('--apply', *archive)
            self.assertEqual((code, applied['installed'], taken), (0, True, [True]))
            for name in installer.UNITS:
                self.assertEqual(installer.dropin(name).read_text(), installer.dropin_text(name, self.commit))
            code, rolled = self.main('--rollback', self.commit)
            self.assertEqual((code, rolled['runs'], taken), (0, BEFORE, [True, True]))
            code, refused = self.main('--apply', '--commit', self.commit)
            self.assertEqual((code, refused['reason']), (1, 'archive_arguments_required'))
            with patch.object(installer.os, 'geteuid', lambda: 1000):
                code, refused = self.main('--inspect', *archive)
            self.assertEqual((code, refused['reason']), (1, 'root_required'))
            code, refused = self.main('--inspect', '--archive', str(self.archive), '--archive-sha256', '0' * 64,
                                      '--commit', self.commit)
            self.assertEqual((code, refused['reason']), (1, 'archive SHA256 mismatch'))
            with contextlib.redirect_stderr(io.StringIO()), self.assertRaises(SystemExit):
                installer.main(['--inspect', '--apply', *archive])
            self.assertEqual(taken, [True, True])

    def test_the_lock_is_the_automation_installers_private_root_file_held_exclusively(self):
        # The same file install_automation.py and upgrade_automation_readiness.py lock.
        self.assertEqual(installer.LOCK, readiness.LOCK)
        self.assertIn("base.BASE / '.automation-install.lock'", Path(installer.automation.__file__).read_text())
        lock = self.root / 'install.lock'
        real = os.fstat

        def owned(fd, **changes):
            info = real(fd)
            values = {'st_mode': stat.S_IFREG | 0o600, 'st_uid': 0, 'st_nlink': 1, **changes}
            return SimpleNamespace(**{name: values.get(name, getattr(info, name))
                                      for name in ('st_mode', 'st_uid', 'st_nlink')})
        with patch.object(installer, 'LOCK', lock):
            with patch.object(installer.os, 'fstat', owned), installer.exclusive():
                other = os.open(lock, os.O_RDWR)
                try:
                    with self.assertRaises(BlockingIOError):
                        installer.fcntl.flock(other, installer.fcntl.LOCK_EX | installer.fcntl.LOCK_NB)
                finally:
                    os.close(other)
            for changes in ({'st_uid': 1000}, {'st_mode': stat.S_IFREG | 0o644},
                            {'st_nlink': 2}, {'st_mode': stat.S_IFDIR | 0o600}):
                with self.subTest(changes=changes), \
                        patch.object(installer.os, 'fstat', lambda fd: owned(fd, **changes)), \
                        self.assertRaisesRegex(ValueError, 'unsafe_install_lock'):
                    with installer.exclusive():
                        pass


if __name__ == '__main__':
    unittest.main()
