"""The session listener moves to a newer release through one drop-in, and back."""
import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import install_auth_release as installer

REPO = Path(__file__).resolve().parents[3]
BEFORE = 'a' * 40
OTHER = 'c' * 40
# The unit keys systemd treats as lists; every other key is overridden by a later value.
LISTS = {'BindPaths', 'BindReadOnlyPaths', 'ReadWritePaths'}


def settings(text, start=None):
    """The unit's settings after this file is read on top of `start`, as systemd reads them."""
    result = {section: {key: list(values) for key, values in keys.items()}
              for section, keys in (start or {}).items()}
    section = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith('#'):
            continue
        if line.startswith('['):
            section = result.setdefault(line, {})
            continue
        key, value = line.split('=', 1)
        if not value:
            section.pop(key, None)
        elif key in LISTS:
            section.setdefault(key, []).append(value)
        else:
            section[key] = [value]
    return result


class AuthReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='domino-auth-release-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.archive = Path(cls.temp.name) / 'source.tar'
        cls.commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
        subprocess.run(['git', 'archive', '--format=tar', '-o', str(cls.archive), cls.commit],
                       cwd=REPO, check=True)
        cls.digest = hashlib.sha256(cls.archive.read_bytes()).hexdigest()
        cls.files = installer.install.archive_files(cls.archive, cls.digest, cls.commit)
        models = cls.files['backend/session_models.py'][0].decode()
        cls.contract = re.search(r"^CONTRACT_VERSION = '([^']+)'$", models, re.M).group(1)

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(dir=self.temp.name))
        self.addCleanup(self.opened, self.root)
        self.releases = self.root / 'financial/releases'
        units = self.root / 'systemd'
        for item in (patch.object(installer.financial, 'ROOT', self.root / 'financial'),
                     patch.object(installer, 'RELEASES', self.releases),
                     patch.object(installer, 'UNIT_FILE', units / installer.UNIT),
                     patch.object(installer, 'DROPIN', units / f'{installer.UNIT}.d/50-release.conf'),
                     patch.object(installer, 'EGRESS_DROPIN', units / f'{installer.UNIT}.d/60-continuous-reads.conf'),
                     patch.object(installer, 'RECEIPTS', self.root / 'receipts'),
                     patch.object(installer.filesystem, 'protected_parents', lambda path: None),
                     patch.object(installer.os, 'geteuid', lambda: 0),
                     patch.object(installer.install, 'run', self.fake_run)):
            item.start()
            self.addCleanup(item.stop)
        installed = self.releases / BEFORE / 'auth/backend'
        installed.mkdir(parents=True)
        (installed / 'requirements-api.lock').write_bytes(self.files[installer.LOCKFILE][0])
        units.mkdir()
        installer.UNIT_FILE.write_text(installer.financial.unit_text('auth', BEFORE))
        self.members = ['domino-read.service', 'domino-gateway.service', 'domino-tunnel.service']
        self.gate = '0'
        self.state = {}
        self.reload()

    @staticmethod
    def opened(root):
        for directory, _, _ in os.walk(root):
            os.chmod(directory, 0o755)

    def reload(self, **changes):
        """What `systemctl daemon-reload` makes of the files, then any override."""
        dropins = [str(p) for p in (installer.DROPIN, installer.EGRESS_DROPIN) if p.exists()]
        effective = settings(installer.UNIT_FILE.read_text())
        if installer.DROPIN.exists():
            effective = settings(installer.DROPIN.read_text(), effective)
        self.state = {'LoadState': 'loaded', 'ActiveState': 'inactive', 'NeedDaemonReload': 'no',
                      'FragmentPath': str(installer.UNIT_FILE), 'DropInPaths': ' '.join(dropins),
                      'WorkingDirectory': effective['[Service]']['WorkingDirectory'][0], **changes}

    def fake_run(self, args, *, data=None, stdout=None):
        if args[:2] == ['/usr/bin/systemctl', 'show'] and args[2] == installer.UNIT:
            return ''.join(f'{k}={v}\n' for k, v in self.state.items()).encode()
        if args[:2] == ['/usr/bin/systemctl', 'show'] and args[2] == installer.TARGET:
            return (' '.join(self.members) + '\n').encode()
        if args[0] == '/usr/sbin/runuser':
            self.assertEqual(data, installer.GATE.encode())
            return (self.gate + '\n').encode()
        raise AssertionError(f'unexpected host command: {args}')

    def plan(self, commit=None, files=None):
        return installer.plan(files or self.files, commit or self.commit, self.digest)

    def apply(self, commit=None, files=None):
        return installer.apply(files or self.files, self.plan(commit, files))

    def test_the_plan_follows_the_loaded_unit_and_names_the_archive_contract(self):
        planned = self.plan()
        self.assertEqual((planned['fromCommit'], planned['unitCommit'], planned['commit']),
                         (BEFORE, BEFORE, self.commit))
        self.assertEqual(planned['sessionContract'], self.contract)
        self.assertEqual(planned['target'], str(self.releases / self.commit / 'auth'))
        self.assertIsNone(planned['previousDropin'])
        self.assertFalse(planned['continuousTargetMember'])
        self.assertFalse(planned['serviceActive'])
        for never in ('service start, stop, restart or daemon-reload', 'unit file change',
                      'database writes or migrations', 'private configuration or secret reads'):
            self.assertIn(never, planned['notPerformed'])
        self.members.append(installer.UNIT)
        self.reload(ActiveState='active')
        planned = self.plan()
        self.assertEqual((planned['continuousTargetMember'], planned['serviceActive']), (True, True))

    def test_the_dropin_over_the_installed_unit_is_the_unit_written_for_the_new_release(self):
        before = installer.financial.unit_text('auth', BEFORE)
        after = settings(installer.dropin_text(self.commit), settings(before))
        self.assertEqual(after, settings(installer.financial.unit_text('auth', self.commit)))
        # Only what names a release: the egress drop-in owns ExecStart.
        self.assertEqual(sorted(settings(installer.dropin_text(self.commit))['[Service]']),
                         ['BindPaths', 'WorkingDirectory'])

    def test_the_unit_must_be_loaded_where_and_as_the_financial_upgrade_wrote_it(self):
        for changes, reason in (({'LoadState': 'not-found'}, 'auth_unit_not_loaded'),
                                ({'FragmentPath': '/usr/lib/systemd/system/domino-auth.service'}, 'auth_unit_moved'),
                                ({'NeedDaemonReload': 'yes'}, 'daemon_reload_pending'),
                                ({'DropInPaths': str(installer.DROPIN.with_name('override.conf'))}, 'foreign_auth_dropin'),
                                ({'WorkingDirectory': str(self.releases / OTHER / 'auth')}, 'auth_release_mismatch'),
                                ({'WorkingDirectory': str(self.releases / BEFORE / 'automation')}, 'auth_release_mismatch'),
                                ({'WorkingDirectory': '/opt/domino/releases/' + BEFORE + '/auth'}, 'auth_release_mismatch')):
            with self.subTest(reason=reason, changes=changes):
                self.reload(**changes)
                with self.assertRaisesRegex(ValueError, reason):
                    self.plan()
        # The egress policy's activation drop-in is expected beside it.
        installer.EGRESS_DROPIN.parent.mkdir()
        installer.EGRESS_DROPIN.write_text('[Service]\n')
        self.reload()
        self.assertEqual(self.plan()['fromCommit'], BEFORE)

    def test_a_dropin_on_disk_that_systemd_has_not_loaded_or_lost_is_a_pending_reload(self):
        installer.DROPIN.parent.mkdir()
        installer.DROPIN.write_text(installer.dropin_text(OTHER))
        with self.assertRaisesRegex(ValueError, 'daemon_reload_pending'):
            self.plan()
        installer.DROPIN.unlink()
        installer.DROPIN.symlink_to(self.root / 'gone')
        with self.assertRaisesRegex(ValueError, 'daemon_reload_pending'):
            self.plan()
        installer.DROPIN.unlink()
        self.reload(DropInPaths=str(installer.DROPIN))
        with self.assertRaisesRegex(ValueError, 'daemon_reload_pending'):
            self.plan()

    def test_a_unit_file_edited_or_from_another_installer_is_refused(self):
        unit = installer.UNIT_FILE
        unit.write_text(installer.financial.unit_text('auth', BEFORE) + 'Environment=EXTRA=1\n')
        with self.assertRaisesRegex(ValueError, 'auth_unit_drift'):
            self.plan()
        unit.write_text(installer.install.unit_text('auth', BEFORE))
        with self.assertRaisesRegex(ValueError, 'auth_unit_not_financial'):
            self.plan()
        unit.write_text('[Service]\nExecStart=/bin/true\n')
        with self.assertRaisesRegex(ValueError, 'auth_unit_not_financial'):
            self.plan()
        # A release root is named by a full commit, never by an arbitrary directory.
        unit.write_text(installer.financial.unit_text('auth', 'release-1'))
        with self.assertRaisesRegex(ValueError, 'auth_unit_not_financial'):
            self.plan()

    def test_a_loaded_dropin_must_be_exactly_the_one_this_tool_writes(self):
        installer.DROPIN.parent.mkdir()
        installer.DROPIN.write_text(installer.dropin_text(OTHER) + 'Environment=EXTRA=1\n')
        self.reload()
        with self.assertRaisesRegex(ValueError, 'auth_dropin_drift'):
            self.plan()
        installer.DROPIN.write_text(installer.dropin_text(OTHER))
        self.reload(WorkingDirectory='/srv/elsewhere/auth')
        with self.assertRaisesRegex(ValueError, 'auth_release_mismatch'):
            self.plan()

    def test_what_the_release_needs_from_the_host_and_the_archive(self):
        # As if the financial upgrade had installed this very commit.
        running = self.releases / self.commit / 'auth/backend'
        running.mkdir(parents=True)
        (running / 'requirements-api.lock').write_bytes(self.files[installer.LOCKFILE][0])
        installer.UNIT_FILE.write_text(installer.financial.unit_text('auth', self.commit))
        self.reload()
        with self.assertRaisesRegex(ValueError, 'release_already_running'):
            self.plan()
        (self.releases / OTHER / 'auth').mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'release_directory_exists'):
            self.plan(OTHER)
        (self.releases / OTHER / 'auth').rmdir()
        (self.releases / OTHER / 'auth').symlink_to(self.root / 'gone')
        with self.assertRaisesRegex(ValueError, 'release_directory_exists'):
            self.plan(OTHER)
        (self.releases / OTHER / 'auth').unlink()
        lock = running / 'requirements-api.lock'
        lock.write_bytes(b'other==1.0\n')
        with self.assertRaisesRegex(ValueError, 'dependency_change_needs_a_venv'):
            self.plan(OTHER)
        lock.write_bytes(self.files[installer.LOCKFILE][0])
        without = {k: v for k, v in self.files.items() if k != 'backend/session_models.py'}
        with self.assertRaisesRegex(ValueError, 'session_contract_missing'):
            self.plan(OTHER, without)
        unversioned = {**self.files, 'backend/session_models.py': (b'VERSION = 1\n', False)}
        with self.assertRaisesRegex(ValueError, 'session_contract_missing'):
            self.plan(OTHER, unversioned)
        self.gate = '1'
        with self.assertRaisesRegex(ValueError, 'migration_027_not_applied'):
            self.plan(OTHER)
        self.gate = '0'
        self.assertEqual(self.plan(OTHER)['fromCommit'], self.commit)

    def test_apply_writes_the_release_and_one_dropin_whatever_the_umask(self):
        planned = self.plan()
        umask = os.umask(0o077)
        try:
            result = installer.apply(self.files, planned)
        finally:
            os.umask(umask)
        self.assertEqual((result['installed'], result['activated']), (True, False))
        self.assertIn('daemon-reload', result['activation'])
        self.assertNotIn(installer.TARGET, result['activation'])
        release = self.releases / self.commit
        root = release / 'auth'
        # Every parent the listener's user crosses is open to it, the commit directory included.
        for directory in (release, root, root / 'backend'):
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o555, directory)
        self.assertEqual([p.name for p in release.iterdir()], ['auth'])
        expected = {name: value for name, value in self.files.items()
                    if name.startswith('backend/') and not name.startswith('backend/tests/')}
        found = {str(p.relative_to(root)) for p in root.rglob('*') if p.is_file()}
        self.assertEqual(found, set(expected))
        for name, (payload, executable) in expected.items():
            self.assertEqual((root / name).read_bytes(), payload, name)
            self.assertEqual(stat.S_IMODE((root / name).stat().st_mode), 0o555 if executable else 0o444, name)
        self.assertTrue(all(stat.S_IMODE(p.stat().st_mode) == 0o555 for p in root.rglob('*') if p.is_dir()))
        self.assertTrue((root / 'backend/runtime').is_dir())
        self.assertEqual(installer.DROPIN.read_text(), installer.dropin_text(self.commit))
        self.assertEqual(stat.S_IMODE(installer.DROPIN.stat().st_mode), 0o644)
        self.assertEqual(stat.S_IMODE(installer.DROPIN.parent.stat().st_mode), 0o755)
        receipt = installer.RECEIPTS / f'{self.commit}.json'
        self.assertEqual(stat.S_IMODE(receipt.stat().st_mode), 0o600)
        self.assertEqual(json.loads(receipt.read_text()), planned)
        # The unit file and the running release are untouched.
        self.assertEqual(installer.UNIT_FILE.read_text(), installer.financial.unit_text('auth', BEFORE))
        self.assertEqual(sorted(p.name for p in (self.releases / BEFORE / 'auth/backend').iterdir()),
                         ['requirements-api.lock'])
        # Until systemd reloads, nothing else can be planned; after, this release runs.
        with self.assertRaisesRegex(ValueError, 'daemon_reload_pending'):
            self.plan()
        self.reload()
        self.assertEqual(self.plan(OTHER)['fromCommit'], self.commit)

    def test_activation_goes_through_the_target_once_the_listener_is_a_member(self):
        self.members.append(installer.UNIT)
        result = self.apply()
        self.assertIn(f'systemctl restart {installer.TARGET}', result['activation'])

    def test_a_release_directory_another_installer_made_is_shared_only_if_traversable(self):
        release = self.releases / self.commit
        (release / 'automation').mkdir(parents=True)
        (release / 'automation/marker').write_bytes(b'automation')
        os.chmod(release, 0o700)
        with self.assertRaisesRegex(ValueError, 'release_directory_not_traversable'):
            self.apply()
        self.assertFalse((release / 'auth').exists())
        self.assertFalse((installer.RECEIPTS / f'{self.commit}.json').exists())
        self.assertFalse(installer.DROPIN.exists())
        os.chmod(release, 0o755)
        self.apply()
        self.assertEqual(sorted(p.name for p in release.iterdir()), ['auth', 'automation'])
        self.assertEqual((release / 'automation/marker').read_bytes(), b'automation')
        self.assertEqual(stat.S_IMODE(release.stat().st_mode), 0o755)

    def test_the_release_root_itself_must_be_traversable(self):
        os.chmod(self.releases, 0o750)
        with self.assertRaisesRegex(ValueError, 'release_directory_not_traversable'):
            self.apply()
        self.assertFalse((self.releases / self.commit).exists())

    def test_a_failure_while_writing_the_release_leaves_nothing_behind(self):
        write = installer.write_new
        calls = []

        def failing(path, payload, mode):
            calls.append(path)
            if len(calls) == 5:
                raise OSError('disk full')
            write(path, payload, mode)
        planned = self.plan()
        with patch.object(installer, 'write_new', failing), self.assertRaisesRegex(OSError, 'disk full'):
            installer.apply(self.files, planned)
        self.assertFalse((self.releases / self.commit).exists())
        self.assertFalse((installer.RECEIPTS / f'{self.commit}.json').exists())
        self.assertFalse(installer.DROPIN.exists())
        # A clean host: the same commit applies from scratch.
        self.assertTrue(installer.apply(self.files, planned)['installed'])

    def test_a_failure_after_the_tree_is_complete_leaves_nothing_behind_either(self):
        planned = self.plan()
        with patch.object(installer.os, 'rename', side_effect=OSError('rename refused')), \
                self.assertRaisesRegex(OSError, 'rename refused'):
            installer.apply(self.files, planned)
        self.assertFalse((self.releases / self.commit).exists())
        self.assertFalse((installer.RECEIPTS / f'{self.commit}.json').exists())

    def test_a_commit_directory_another_installer_made_survives_a_failure(self):
        release = self.releases / self.commit
        release.mkdir(parents=True)
        planned = self.plan()
        write = installer.write_new
        calls = []

        def failing(path, payload, mode):
            # The receipt is written, then the first file of the tree fails.
            calls.append(path)
            if len(calls) == 2:
                raise OSError('disk full')
            write(path, payload, mode)
        with patch.object(installer, 'write_new', failing), self.assertRaisesRegex(OSError, 'disk full'):
            installer.apply(self.files, planned)
        self.assertEqual(list(release.iterdir()), [])

    def test_the_final_name_is_checked_again_just_before_the_rename(self):
        # Created by someone else after the plan: never renamed over, even when empty.
        (self.releases / self.commit / 'auth').mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'release_directory_exists'):
            installer.install_source(self.files, self.commit)
        self.assertEqual([p.name for p in (self.releases / self.commit).iterdir()], ['auth'])
        self.assertEqual(list((self.releases / self.commit / 'auth').iterdir()), [])

    def test_a_dropin_is_replaced_whole_or_not_at_all(self):
        installer.DROPIN.parent.mkdir()
        installer.DROPIN.write_text(installer.dropin_text(OTHER))
        with patch.object(installer.os, 'replace', side_effect=OSError('busy')), \
                self.assertRaisesRegex(OSError, 'busy'):
            installer.write_dropin(installer.dropin_text(self.commit))
        self.assertEqual([p.name for p in installer.DROPIN.parent.iterdir()], ['50-release.conf'])
        self.assertEqual(installer.DROPIN.read_text(), installer.dropin_text(OTHER))

    def test_receipts_are_private_and_written_once(self):
        installer.RECEIPTS.mkdir(mode=0o755)
        os.chmod(installer.RECEIPTS, 0o755)
        with self.assertRaisesRegex(ValueError, 'receipt_directory_not_private'):
            self.apply()
        os.chmod(installer.RECEIPTS, 0o700)
        receipt = installer.RECEIPTS / f'{self.commit}.json'
        receipt.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'receipt_exists'):
            self.apply()
        receipt.unlink()
        receipt.symlink_to(self.root / 'gone')
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
        self.reload()
        second = self.apply(OTHER)
        self.assertEqual(json.loads((installer.RECEIPTS / f'{OTHER}.json').read_text())['previousDropin'],
                         installer.dropin_text(self.commit))
        self.assertEqual(installer.DROPIN.read_text(), installer.dropin_text(OTHER))
        rolled = installer.rollback(OTHER)
        self.assertEqual((rolled['runs'], rolled['releaseRetained']), (self.commit, True))
        self.assertEqual(installer.DROPIN.read_text(), installer.dropin_text(self.commit))
        self.reload()
        self.assertEqual(self.plan(OTHER.replace('c', 'e'))['fromCommit'], self.commit)
        self.assertEqual(installer.rollback(self.commit)['runs'], BEFORE)
        self.assertFalse(installer.DROPIN.exists())
        self.reload()
        self.assertEqual(self.state['WorkingDirectory'], str(self.releases / BEFORE / 'auth'))
        self.assertTrue((self.releases / OTHER / 'auth').is_dir())
        self.assertTrue((self.releases / self.commit / 'auth').is_dir())
        self.assertIn('--rollback', second['rollback'])
        # Twice is harmless: nothing of this release is left to take back.
        self.assertEqual(installer.rollback(self.commit)['runs'], BEFORE)

    def test_rollback_refuses_a_dropin_it_did_not_write_or_a_receipt_it_cannot_trust(self):
        self.apply()
        receipt = installer.RECEIPTS / f'{self.commit}.json'
        saved = json.loads(receipt.read_text())
        installer.DROPIN.write_text(installer.dropin_text(OTHER))
        with self.assertRaisesRegex(ValueError, 'rollback_is_not_current'):
            installer.rollback(self.commit)
        installer.DROPIN.write_text(installer.dropin_text(self.commit))
        for broken in ({**saved, 'mode': 'public-data-install'}, {**saved, 'commit': OTHER},
                       {**saved, 'fromCommit': 'not-a-commit'}, {**saved, 'fromCommit': None},
                       {**saved, 'previousDropin': installer.dropin_text(OTHER)}):
            with self.subTest(broken=broken):
                receipt.write_text(json.dumps(broken))
                with self.assertRaisesRegex(ValueError, 'invalid_receipt'):
                    installer.rollback(self.commit)
        receipt.write_text(json.dumps(saved))
        os.rename(self.releases / BEFORE, self.releases / ('b' * 40))
        with self.assertRaisesRegex(ValueError, 'previous_release_missing'):
            installer.rollback(self.commit)
        with self.assertRaisesRegex(ValueError, 'invalid_commit'):
            installer.rollback('HEAD')
        self.assertEqual(installer.DROPIN.read_text(), installer.dropin_text(self.commit))
        # A link where the drop-in was is read, never followed or taken for absence.
        os.rename(self.releases / ('b' * 40), self.releases / BEFORE)
        installer.DROPIN.unlink()
        installer.DROPIN.symlink_to(self.root / 'gone')
        with self.assertRaises(OSError):
            installer.rollback(self.commit)
        self.assertTrue(installer.DROPIN.is_symlink())

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
            self.assertEqual((code, inspected['ok'], inspected['installed']), (0, True, False))
            self.assertEqual(inspected['sessionContract'], self.contract)
            self.assertEqual((taken, installer.DROPIN.exists(), installer.RECEIPTS.exists()), ([], False, False))
            code, applied = self.main('--apply', *archive)
            self.assertEqual((code, applied['installed'], taken), (0, True, [True]))
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

    def test_the_lock_is_a_private_root_file_held_exclusively(self):
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
