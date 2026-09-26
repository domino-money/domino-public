"""Performance, its collector and execution-status move to a newer release through one drop-in, and back."""
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
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
sys.path.insert(0, str(Path(__file__).resolve().parent))
import install_financial_release as installer
# One model of how systemd folds a drop-in over a unit, shared with the session
# listener's installer; test_financial_release_systemd.py holds it to systemd itself.
from test_install_auth_release import settings

REPO = Path(__file__).resolve().parents[3]
BEFORE = 'a' * 40
OTHER = 'c' * 40
NEVER = ('service start, stop, restart or daemon-reload', 'unit file change',
         'database writes or migrations', 'private configuration or secret reads',
         'egress, Access or Tunnel change')


class FinancialReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='domino-financial-release-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.archive = Path(cls.temp.name) / 'source.tar'
        cls.commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
        subprocess.run(['git', 'archive', '--format=tar', '-o', str(cls.archive), cls.commit],
                       cwd=REPO, check=True)
        cls.digest = hashlib.sha256(cls.archive.read_bytes()).hexdigest()
        cls.files = installer.install.archive_files(cls.archive, cls.digest, cls.commit)

        def version(path):
            return re.search(r"^CONTRACT_VERSION ?= ?'([^']+)'$", cls.files[path][0].decode(), re.M).group(1)
        cls.contracts = {'performance': version('backend/performance_v2_models.py'),
                         'performance-collector': version('backend/performance_v2_models.py'),
                         'execution-status': version('backend/execution_status.py')}

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(dir=self.temp.name))
        self.addCleanup(self.opened, self.root)
        self.releases = self.root / 'financial/releases'
        self.units = self.root / 'systemd'
        for item in (patch.object(installer.financial, 'ROOT', self.root / 'financial'),
                     patch.object(installer, 'RELEASES', self.releases),
                     patch.object(installer, 'UNIT_DIR', self.units),
                     patch.object(installer, 'BACKUPS', self.root / 'backups'),
                     patch.object(installer.filesystem, 'protected_parents', lambda path: None),
                     patch.object(installer.os, 'geteuid', lambda: 0),
                     patch.object(installer.install, 'run', self.fake_run)):
            item.start()
            self.addCleanup(item.stop)
        self.units.mkdir()
        (self.root / 'backups').mkdir()
        for component in installer.COMPONENTS:
            installed = self.releases / BEFORE / component / 'backend'
            installed.mkdir(parents=True)
            (installed / 'requirements-api.lock').write_bytes(self.files[installer.LOCKFILE][0])
            self.unit(component).write_text(installer.financial.unit_text(component, BEFORE))
        self.requires = ['domino-continuous-egress.service', 'domino-read.service',
                         'domino-gateway.service', 'domino-tunnel.service']
        self.wants = ['domino-auth.service']
        self.answers = {installer.DELEGATE: '1', installer.READINESS: '0'}
        self.queries = []
        self.states = {}
        for component in installer.COMPONENTS:
            self.reload(component)

    @staticmethod
    def opened(root):
        for directory, _, _ in os.walk(root):
            os.chmod(directory, 0o755)

    def unit(self, component):
        return self.units / installer.service(component)

    def reload(self, component='performance', **changes):
        """What `systemctl daemon-reload` makes of the files, then any override."""
        dropin, egress = installer.dropins(component)
        effective = settings(self.unit(component).read_text())
        if dropin.exists():
            effective = settings(dropin.read_text(), effective)
        self.states[installer.service(component)] = {
            'LoadState': 'loaded', 'ActiveState': 'inactive', 'NeedDaemonReload': 'no',
            'FragmentPath': str(self.unit(component)),
            'DropInPaths': ' '.join(str(p) for p in (dropin, egress) if p.exists()),
            'WorkingDirectory': effective['[Service]']['WorkingDirectory'][0], **changes}

    def fake_run(self, args, *, data=None, stdout=None):
        if args[:2] == ['/usr/bin/systemctl', 'show'] and args[2] in self.states:
            return ''.join(f'{k}={v}\n' for k, v in self.states[args[2]].items()).encode()
        if args[:3] == ['/usr/bin/systemctl', 'show', installer.TARGET]:
            self.assertEqual(args[3:], ['--property=Requires,Wants'])
            return f'Requires={" ".join(self.requires)}\nWants={" ".join(self.wants)}\n'.encode()
        if args[0] == '/usr/sbin/runuser':
            self.queries.append(data.decode())
            return (self.answers[data.decode()] + '\n').encode()
        raise AssertionError(f'unexpected host command: {args}')

    def plan(self, component='performance', commit=None, files=None):
        return installer.plan(component, files or self.files, commit or self.commit, self.digest)

    def apply(self, component='performance', commit=None, files=None):
        return installer.apply(files or self.files, self.plan(component, commit, files))

    def receipt(self, component='performance', commit=None):
        return self.root / 'backups' / f'domino-{component}-release' / f'{commit or self.commit}.json'

    def test_the_plan_follows_the_loaded_unit_and_names_the_archive_contract(self):
        for component in installer.COMPONENTS:
            with self.subTest(component=component):
                planned = self.plan(component)
                self.assertEqual((planned['component'], planned['fromCommit'], planned['unitCommit'],
                                  planned['commit'], planned['mode']),
                                 (component, BEFORE, BEFORE, self.commit, 'financial-release-install'))
                self.assertEqual(planned['contract'], self.contracts[component])
                self.assertEqual(planned['target'], str(self.releases / self.commit / component))
                self.assertEqual(planned['dropin'],
                                 str(self.units / f'domino-{component}.service.d/50-release.conf'))
                self.assertEqual(planned['dropinSha256'], hashlib.sha256(
                    installer.dropin_text(component, self.commit).encode()).hexdigest())
                self.assertIsNone(planned['previousDropin'])
                self.assertEqual((planned['continuousTarget'], planned['serviceActive']), (None, False))
                for never in NEVER:
                    self.assertIn(never, planned['notPerformed'])
        # The egress policy's target wants a family and requires only the read path.
        self.wants.append('domino-performance.service')
        self.reload(ActiveState='active')
        planned = self.plan()
        self.assertEqual((planned['continuousTarget'], planned['serviceActive']), ('wants', True))
        self.assertIsNone(self.plan('performance-collector')['continuousTarget'])
        self.requires.append('domino-performance.service')
        self.assertEqual(self.plan()['continuousTarget'], 'requires')

    def test_the_dropin_over_the_installed_unit_is_the_unit_written_for_the_new_release(self):
        for component in installer.COMPONENTS:
            with self.subTest(component=component):
                before = settings(installer.financial.unit_text(component, BEFORE))
                after = settings(installer.dropin_text(component, self.commit), before)
                wanted = settings(installer.financial.unit_text(component, self.commit))
                self.assertEqual(after, wanted)
                # Only what names a release: the egress drop-in owns ExecStart.
                self.assertEqual(sorted(settings(installer.dropin_text(component, self.commit))['[Service]']),
                                 ['Binds', 'WorkingDirectory'])
                self.assertEqual([key for key, _ in wanted['[Service]']['Binds']], ['BindPaths', 'BindReadOnlyPaths'])
                # The private runtime lives outside every release, so its state carries over.
                runtime = f'/var/lib/domino-financial/{component}'
                self.assertEqual(wanted['[Service]']['Binds'][0][1].split(':')[0], runtime)
                self.assertEqual(before['[Service]']['ReadWritePaths'], [runtime])
                # The egress drop-in sorts after this one and appends its hosts bind to the
                # same list, so the unit keeps the runtime and configuration binds too.
                hosts = f'/etc/domino/continuous-reads/{component}.hosts:/etc/hosts'
                egress = f'[Service]\nIPAddressAllow=\nBindReadOnlyPaths={hosts}\n'
                self.assertEqual(settings(egress, after)['[Service]']['Binds'],
                                 [*wanted['[Service]']['Binds'], ('BindReadOnlyPaths', hosts)])

    def test_the_unit_must_be_loaded_where_and_as_the_financial_upgrade_wrote_it(self):
        dropin, egress = installer.dropins('performance')
        for changes, reason in (({'LoadState': 'not-found'}, 'unit_not_loaded'),
                                ({'FragmentPath': '/usr/lib/systemd/system/domino-performance.service'}, 'unit_moved'),
                                ({'NeedDaemonReload': 'yes'}, 'daemon_reload_pending'),
                                ({'DropInPaths': str(dropin.with_name('override.conf'))}, 'foreign_dropin'),
                                ({'WorkingDirectory': str(self.releases / OTHER / 'performance')}, 'release_mismatch'),
                                ({'WorkingDirectory': str(self.releases / BEFORE / 'performance-collector')},
                                 'release_mismatch'),
                                ({'WorkingDirectory': '/opt/domino/releases/' + BEFORE + '/performance'},
                                 'release_mismatch')):
            with self.subTest(reason=reason, changes=changes):
                self.reload(**changes)
                with self.assertRaisesRegex(ValueError, reason):
                    self.plan()
        # The egress policy's activation drop-in is expected beside it.
        egress.parent.mkdir()
        egress.write_text('[Service]\n')
        self.reload()
        self.assertEqual(self.plan()['fromCommit'], BEFORE)

    def test_a_dropin_on_disk_that_systemd_has_not_loaded_or_lost_is_a_pending_reload(self):
        dropin = installer.dropins('performance')[0]
        dropin.parent.mkdir()
        dropin.write_text(installer.dropin_text('performance', OTHER))
        with self.assertRaisesRegex(ValueError, 'daemon_reload_pending'):
            self.plan()
        dropin.unlink()
        dropin.symlink_to(self.root / 'gone')
        with self.assertRaisesRegex(ValueError, 'daemon_reload_pending'):
            self.plan()
        dropin.unlink()
        self.reload(DropInPaths=str(dropin))
        with self.assertRaisesRegex(ValueError, 'daemon_reload_pending'):
            self.plan()

    def test_a_unit_file_edited_or_from_another_installer_is_refused(self):
        unit = self.unit('performance')
        unit.write_text(installer.financial.unit_text('performance', BEFORE) + 'Environment=EXTRA=1\n')
        with self.assertRaisesRegex(ValueError, 'unit_drift'):
            self.plan()
        # Another component's unit names another component's root.
        unit.write_text(installer.financial.unit_text('execution-status', BEFORE))
        with self.assertRaisesRegex(ValueError, 'unit_not_financial'):
            self.plan()
        unit.write_text('[Service]\nExecStart=/bin/true\n')
        with self.assertRaisesRegex(ValueError, 'unit_not_financial'):
            self.plan()
        # A release root is named by a full commit, never by an arbitrary directory.
        unit.write_text(installer.financial.unit_text('performance', 'release-1'))
        with self.assertRaisesRegex(ValueError, 'unit_not_financial'):
            self.plan()

    def test_a_loaded_dropin_must_be_exactly_the_one_this_tool_writes(self):
        dropin = installer.dropins('performance')[0]
        dropin.parent.mkdir()
        dropin.write_text(installer.dropin_text('performance', OTHER) + 'Environment=EXTRA=1\n')
        self.reload()
        with self.assertRaisesRegex(ValueError, 'dropin_drift'):
            self.plan()
        # The same settings under the session listener's installer's header are not this tool's.
        dropin.write_text(installer.dropin_text('performance', OTHER).replace(installer.HEADER, installer.auth.HEADER))
        with self.assertRaisesRegex(ValueError, 'dropin_drift'):
            self.plan()
        dropin.write_text(installer.dropin_text('performance', OTHER))
        self.reload(WorkingDirectory='/srv/elsewhere/performance')
        with self.assertRaisesRegex(ValueError, 'release_mismatch'):
            self.plan()

    def test_what_the_release_needs_from_the_host_and_the_archive(self):
        # As if the financial upgrade had installed this very commit.
        running = self.releases / self.commit / 'performance/backend'
        running.mkdir(parents=True)
        (running / 'requirements-api.lock').write_bytes(self.files[installer.LOCKFILE][0])
        self.unit('performance').write_text(installer.financial.unit_text('performance', self.commit))
        self.reload()
        with self.assertRaisesRegex(ValueError, 'release_already_running'):
            self.plan()
        (self.releases / OTHER / 'performance').mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'release_directory_exists'):
            self.plan(commit=OTHER)
        (self.releases / OTHER / 'performance').rmdir()
        (self.releases / OTHER / 'performance').symlink_to(self.root / 'gone')
        with self.assertRaisesRegex(ValueError, 'release_directory_exists'):
            self.plan(commit=OTHER)
        (self.releases / OTHER / 'performance').unlink()
        lock = running / 'requirements-api.lock'
        lock.write_bytes(b'other==1.0\n')
        with self.assertRaisesRegex(ValueError, 'dependency_change_needs_a_venv'):
            self.plan(commit=OTHER)
        lock.write_bytes(self.files[installer.LOCKFILE][0])
        without = {k: v for k, v in self.files.items() if k != 'backend/performance_v2_api.py'}
        with self.assertRaisesRegex(ValueError, 'entry_script_missing'):
            self.plan(commit=OTHER, files=without)
        without = {k: v for k, v in self.files.items() if k != 'backend/performance_v2_models.py'}
        with self.assertRaisesRegex(ValueError, 'contract_missing'):
            self.plan(commit=OTHER, files=without)
        unversioned = {**self.files, 'backend/performance_v2_models.py': (b'VERSION = 1\n', False)}
        with self.assertRaisesRegex(ValueError, 'contract_missing'):
            self.plan(commit=OTHER, files=unversioned)
        unversioned = {**self.files, 'backend/execution_status.py': (b'PREFIX = 1\n', False)}
        with self.assertRaisesRegex(ValueError, 'contract_missing'):
            self.plan('execution-status', files=unversioned)
        self.answers[installer.DELEGATE] = '0'
        for component in ('performance', 'execution-status'):
            with self.subTest(component=component), \
                    self.assertRaisesRegex(ValueError, 'migration_041_not_applied'):
                self.plan(component, commit=OTHER)
        # The collector authenticates nobody and reads nothing from the database.
        self.queries.clear()
        self.assertEqual(self.plan('performance-collector')['fromCommit'], BEFORE)
        self.assertEqual(self.queries, [])
        self.answers[installer.DELEGATE] = '1'
        self.assertEqual(self.plan(commit=OTHER)['fromCommit'], self.commit)

    def test_execution_status_reports_whether_it_may_read_automation_readiness(self):
        self.assertIs(self.plan('execution-status')['automationReadinessReadable'], False)
        self.answers[installer.READINESS] = '1'
        self.assertIs(self.plan('execution-status')['automationReadinessReadable'], True)
        for component in ('performance', 'performance-collector'):
            self.assertNotIn('automationReadinessReadable', self.plan(component))
        self.assertEqual(self.queries.count(installer.READINESS), 2)

    def test_only_the_three_components_are_installed_here(self):
        for component in ('auth', 'execution-signer', 'onboarding'):
            with self.subTest(component=component):
                with self.assertRaisesRegex(ValueError, 'unknown_component'):
                    self.plan(component)
                with self.assertRaisesRegex(ValueError, 'unknown_component'):
                    installer.rollback(component, self.commit)

    def test_apply_writes_the_release_and_one_dropin_whatever_the_umask(self):
        planned = self.plan()
        umask = os.umask(0o077)
        try:
            result = installer.apply(self.files, planned)
        finally:
            os.umask(umask)
        self.assertEqual((result['installed'], result['activated'], result['component']), (True, False, 'performance'))
        self.assertEqual(result['activation'],
                         'systemctl daemon-reload; domino-performance.service runs this release from its next start')
        self.assertIn(f'--component performance --rollback {self.commit}', result['rollback'])
        release = self.releases / self.commit
        root = release / 'performance'
        # Every parent the unit's user crosses is open to it, the commit directory included.
        for directory in (release, root, root / 'backend'):
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o555, directory)
        self.assertEqual([p.name for p in release.iterdir()], ['performance'])
        expected = {name: value for name, value in self.files.items()
                    if name.startswith('backend/') and not name.startswith('backend/tests/')}
        found = {str(p.relative_to(root)) for p in root.rglob('*') if p.is_file()}
        self.assertEqual(found, set(expected))
        for name, (payload, executable) in expected.items():
            self.assertEqual((root / name).read_bytes(), payload, name)
            self.assertEqual(stat.S_IMODE((root / name).stat().st_mode), 0o555 if executable else 0o444, name)
        self.assertTrue(all(stat.S_IMODE(p.stat().st_mode) == 0o555 for p in root.rglob('*') if p.is_dir()))
        self.assertTrue((root / 'backend/runtime').is_dir())
        dropin = installer.dropins('performance')[0]
        self.assertEqual(dropin.read_text(), installer.dropin_text('performance', self.commit))
        self.assertEqual(stat.S_IMODE(dropin.stat().st_mode), 0o644)
        self.assertEqual(stat.S_IMODE(dropin.parent.stat().st_mode), 0o755)
        receipt = self.receipt()
        self.assertEqual(result['receipt'], str(receipt))
        self.assertEqual(stat.S_IMODE(receipt.stat().st_mode), 0o600)
        self.assertEqual(stat.S_IMODE(receipt.parent.stat().st_mode), 0o700)
        self.assertEqual(json.loads(receipt.read_text()), planned)
        # The unit file, the running release and the other components are untouched.
        self.assertEqual(self.unit('performance').read_text(), installer.financial.unit_text('performance', BEFORE))
        self.assertEqual(sorted(p.name for p in (self.releases / BEFORE / 'performance/backend').iterdir()),
                         ['requirements-api.lock'])
        for other in ('performance-collector', 'execution-status'):
            self.assertFalse(installer.dropins(other)[0].parent.exists(), other)
            self.assertFalse(self.receipt(other).parent.exists(), other)
        # Until systemd reloads, nothing else can be planned; after, this release runs.
        with self.assertRaisesRegex(ValueError, 'daemon_reload_pending'):
            self.plan()
        self.reload()
        self.assertEqual(self.plan(commit=OTHER)['fromCommit'], self.commit)

    def test_activation_follows_how_the_target_holds_the_unit_and_whether_it_runs(self):
        planned = {'component': 'execution-status', 'continuousTarget': None, 'serviceActive': False}
        start = 'systemctl daemon-reload; domino-execution-status.service runs this release from its next start'
        restart = ('systemctl daemon-reload; then systemctl restart domino-execution-status.service, '
                   'which runs the old release until then')
        self.assertEqual(installer.activation(planned), start)
        self.assertEqual(installer.activation({**planned, 'continuousTarget': 'wants'}), start)
        self.assertEqual(installer.activation({**planned, 'continuousTarget': 'wants', 'serviceActive': True}),
                         restart)
        self.assertEqual(installer.activation({**planned, 'serviceActive': True}), restart)
        for active in (False, True):
            self.assertEqual(installer.activation({**planned, 'continuousTarget': 'requires',
                                                   'serviceActive': active}),
                             f'systemctl daemon-reload; then systemctl restart {installer.TARGET}, never '
                             'domino-execution-status.service alone: a required member stopped or restarted '
                             'takes the tunnel with it')
        self.requires.append('domino-performance.service')
        self.assertIn(f'systemctl restart {installer.TARGET}', self.apply()['activation'])

    def test_the_components_share_a_release_each_with_its_own_dropin_and_receipt(self):
        release = self.releases / self.commit
        # The session listener's installer got there first.
        (release / 'auth/backend').mkdir(parents=True)
        (release / 'auth/backend/marker').write_bytes(b'auth')
        for component in installer.COMPONENTS:
            self.apply(component)
            self.reload(component)
            # Root writes into the read-only commit directory; this test's user cannot.
            os.chmod(release, 0o755)
        self.assertEqual(sorted(p.name for p in release.iterdir()),
                         ['auth', 'execution-status', 'performance', 'performance-collector'])
        self.assertEqual((release / 'auth/backend/marker').read_bytes(), b'auth')
        for component in installer.COMPONENTS:
            self.assertEqual(installer.dropins(component)[0].read_text(),
                             installer.dropin_text(component, self.commit))
            self.assertEqual(json.loads(self.receipt(component).read_text())['component'], component)
            self.assertEqual(self.states[installer.service(component)]['WorkingDirectory'], str(release / component))
        # Taking one back leaves the others where they are.
        self.assertEqual(installer.rollback('execution-status', self.commit)['runs'], BEFORE)
        self.assertFalse(installer.dropins('execution-status')[0].exists())
        for component in ('performance', 'performance-collector'):
            self.assertEqual(installer.dropins(component)[0].read_text(),
                             installer.dropin_text(component, self.commit))

    def test_a_release_directory_another_installer_made_is_shared_only_if_traversable(self):
        release = self.releases / self.commit
        (release / 'auth').mkdir(parents=True)
        (release / 'auth/marker').write_bytes(b'auth')
        os.chmod(release, 0o700)
        with self.assertRaisesRegex(ValueError, 'release_directory_not_traversable'):
            self.apply()
        self.assertFalse((release / 'performance').exists())
        self.assertFalse(self.receipt().exists())
        self.assertFalse(installer.dropins('performance')[0].exists())
        os.chmod(release, 0o755)
        self.apply()
        self.assertEqual(sorted(p.name for p in release.iterdir()), ['auth', 'performance'])
        self.assertEqual((release / 'auth/marker').read_bytes(), b'auth')
        self.assertEqual(stat.S_IMODE(release.stat().st_mode), 0o755)

    def test_the_release_root_itself_must_be_traversable(self):
        os.chmod(self.releases, 0o750)
        with self.assertRaisesRegex(ValueError, 'release_directory_not_traversable'):
            self.apply()
        self.assertFalse((self.releases / self.commit).exists())

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
        self.assertFalse(installer.dropins('performance')[0].exists())
        # A clean host: the same commit applies from scratch.
        self.assertTrue(installer.apply(self.files, planned)['installed'])

    def test_a_failure_after_the_tree_is_complete_leaves_nothing_behind_either(self):
        planned = self.plan()
        with patch.object(installer.os, 'rename', side_effect=OSError('rename refused')), \
                self.assertRaisesRegex(OSError, 'rename refused'):
            installer.apply(self.files, planned)
        self.assertFalse((self.releases / self.commit).exists())
        self.assertFalse(self.receipt().exists())

    def test_a_commit_directory_another_installer_made_survives_a_failure(self):
        release = self.releases / self.commit
        release.mkdir(parents=True)
        planned = self.plan()
        write = installer.auth.write_new
        calls = []

        def failing(path, payload, mode):
            # The receipt is written, then the first file of the tree fails.
            calls.append(path)
            if len(calls) == 2:
                raise OSError('disk full')
            write(path, payload, mode)
        with patch.object(installer.auth, 'write_new', failing), self.assertRaisesRegex(OSError, 'disk full'):
            installer.apply(self.files, planned)
        self.assertEqual(list(release.iterdir()), [])
        self.assertFalse(self.receipt().exists())

    def test_the_final_name_is_checked_again_just_before_the_rename(self):
        # Created by someone else after the plan: never renamed over, even when empty.
        (self.releases / self.commit / 'performance').mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, 'release_directory_exists'):
            installer.install_source('performance', self.files, self.commit)
        self.assertEqual([p.name for p in (self.releases / self.commit).iterdir()], ['performance'])
        self.assertEqual(list((self.releases / self.commit / 'performance').iterdir()), [])

    def test_a_dropin_is_replaced_whole_or_not_at_all(self):
        dropin = installer.dropins('performance')[0]
        dropin.parent.mkdir()
        dropin.write_text(installer.dropin_text('performance', OTHER))
        with patch.object(installer.os, 'replace', side_effect=OSError('busy')), \
                self.assertRaisesRegex(OSError, 'busy'):
            installer.write_dropin('performance', installer.dropin_text('performance', self.commit))
        self.assertEqual([p.name for p in dropin.parent.iterdir()], ['50-release.conf'])
        self.assertEqual(dropin.read_text(), installer.dropin_text('performance', OTHER))

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
                installer.rollback('performance', self.commit)
        self.assertFalse((self.releases / self.commit).exists())

    def test_rollback_walks_back_one_release_at_a_time_and_keeps_the_releases(self):
        self.apply()
        self.reload()
        second = self.apply(commit=OTHER)
        dropin = installer.dropins('performance')[0]
        self.assertEqual(json.loads(self.receipt(commit=OTHER).read_text())['previousDropin'],
                         installer.dropin_text('performance', self.commit))
        self.assertEqual(dropin.read_text(), installer.dropin_text('performance', OTHER))
        rolled = installer.rollback('performance', OTHER)
        self.assertEqual((rolled['runs'], rolled['releaseRetained'], rolled['component']),
                         (self.commit, True, 'performance'))
        self.assertEqual(dropin.read_text(), installer.dropin_text('performance', self.commit))
        self.reload()
        self.assertEqual(self.plan(commit=OTHER.replace('c', 'e'))['fromCommit'], self.commit)
        self.assertEqual(installer.rollback('performance', self.commit)['runs'], BEFORE)
        self.assertFalse(dropin.exists())
        self.reload()
        self.assertEqual(self.states['domino-performance.service']['WorkingDirectory'],
                         str(self.releases / BEFORE / 'performance'))
        self.assertTrue((self.releases / OTHER / 'performance').is_dir())
        self.assertTrue((self.releases / self.commit / 'performance').is_dir())
        self.assertIn('--rollback', second['rollback'])
        # Twice is harmless: nothing of this release is left to take back.
        self.assertEqual(installer.rollback('performance', self.commit)['runs'], BEFORE)

    def test_rollback_refuses_a_dropin_it_did_not_write_or_a_receipt_it_cannot_trust(self):
        self.apply()
        dropin = installer.dropins('performance')[0]
        receipt = self.receipt()
        saved = json.loads(receipt.read_text())
        dropin.write_text(installer.dropin_text('performance', OTHER))
        with self.assertRaisesRegex(ValueError, 'rollback_is_not_current'):
            installer.rollback('performance', self.commit)
        dropin.write_text(installer.dropin_text('performance', self.commit))
        for broken in ({**saved, 'mode': 'auth-release-install'}, {**saved, 'component': 'execution-status'},
                       {**saved, 'commit': OTHER}, {**saved, 'fromCommit': 'not-a-commit'},
                       {**saved, 'fromCommit': None},
                       {**saved, 'previousDropin': installer.dropin_text('performance', OTHER)}):
            with self.subTest(broken=broken):
                receipt.write_text(json.dumps(broken))
                with self.assertRaisesRegex(ValueError, 'invalid_receipt'):
                    installer.rollback('performance', self.commit)
        receipt.write_text(json.dumps(saved))
        os.rename(self.releases / BEFORE / 'performance', self.releases / BEFORE / 'moved')
        with self.assertRaisesRegex(ValueError, 'previous_release_missing'):
            installer.rollback('performance', self.commit)
        with self.assertRaisesRegex(ValueError, 'invalid_commit'):
            installer.rollback('performance', 'HEAD')
        self.assertEqual(dropin.read_text(), installer.dropin_text('performance', self.commit))
        # A link where the drop-in was is read, never followed or taken for absence.
        os.rename(self.releases / BEFORE / 'moved', self.releases / BEFORE / 'performance')
        dropin.unlink()
        dropin.symlink_to(self.root / 'gone')
        with self.assertRaises(OSError):
            installer.rollback('performance', self.commit)
        self.assertTrue(dropin.is_symlink())

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
            code, inspected = self.main('--component', 'execution-status', '--inspect', *archive)
            self.assertEqual((code, inspected['ok'], inspected['installed'], inspected['component']),
                             (0, True, False, 'execution-status'))
            self.assertEqual(inspected['contract'], self.contracts['execution-status'])
            self.assertEqual((taken, installer.dropins('execution-status')[0].exists(),
                              self.receipt('execution-status').exists()), ([], False, False))
            code, applied = self.main('--component', 'execution-status', '--apply', *archive)
            self.assertEqual((code, applied['installed'], taken), (0, True, [True]))
            self.assertEqual(installer.dropins('execution-status')[0].read_text(),
                             installer.dropin_text('execution-status', self.commit))
            code, rolled = self.main('--component', 'execution-status', '--rollback', self.commit)
            self.assertEqual((code, rolled['runs'], taken), (0, BEFORE, [True, True]))
            code, refused = self.main('--component', 'performance', '--apply', '--commit', self.commit)
            self.assertEqual((code, refused['reason']), (1, 'archive_arguments_required'))
            with patch.object(installer.os, 'geteuid', lambda: 1000):
                code, refused = self.main('--component', 'performance', '--inspect', *archive)
            self.assertEqual((code, refused['reason']), (1, 'root_required'))
            code, refused = self.main('--component', 'performance', '--inspect', '--archive', str(self.archive),
                                      '--archive-sha256', '0' * 64, '--commit', self.commit)
            self.assertEqual((code, refused['reason']), (1, 'archive SHA256 mismatch'))
            # The component is named every time, and only one of these three.
            for argv in (('--inspect', *archive), ('--component', 'auth', '--inspect', *archive)):
                with self.subTest(argv=argv), contextlib.redirect_stderr(io.StringIO()), \
                        self.assertRaises(SystemExit):
                    installer.main(list(argv))
            self.assertEqual(taken, [True, True])


if __name__ == '__main__':
    unittest.main()
