"""One release beside the running one; no host beyond the two read roots."""
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
import install_read_release as installer

REPO = Path(__file__).resolve().parents[3]
BEFORE = 'a' * 40


class ReadReleaseTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory(prefix='domino-read-release-')
        cls.addClassCleanup(cls.temp.cleanup)
        cls.archive = Path(cls.temp.name) / 'source.tar'
        cls.commit = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=REPO, text=True).strip()
        subprocess.run(['git', 'archive', '--format=tar', '-o', str(cls.archive), cls.commit],
                       cwd=REPO, check=True)
        cls.digest = hashlib.sha256(cls.archive.read_bytes()).hexdigest()
        cls.files = installer.install.archive_files(cls.archive, cls.digest, cls.commit)

    def setUp(self):
        self.root = Path(tempfile.mkdtemp(dir=self.temp.name))
        self.releases = self.root / 'releases'
        self.venv = self.root / 'backend-venv'
        self.venv.mkdir(parents=True)
        for component in installer.COMPONENTS:
            base = self.releases / BEFORE / component
            (base / 'backend').mkdir(parents=True)
            runtime = self.root / 'runtime' / component
            runtime.mkdir(parents=True)
            (base / 'backend/.venv').symlink_to(self.venv)
            (base / 'backend/runtime').symlink_to(runtime)
            lock = base / 'backend/requirements-api.lock'
            lock.write_bytes(self.files['backend/requirements-api.lock'][0])
        self.enter = patch.object(installer, 'RELEASES', self.releases)
        self.enter.start()
        self.addCleanup(self.enter.stop)
        self.units = {c: BEFORE for c in installer.COMPONENTS}
        run = patch.object(installer.install, 'run', self.fake_run)
        run.start()
        self.addCleanup(run.stop)

    def fake_run(self, args, **kwargs):
        component = args[2].removeprefix('domino-').removesuffix('.service')
        return f'{self.releases / self.units[component] / component}\n'.encode()

    def plan(self):
        return installer.plan(self.files, self.commit, self.digest)

    def test_the_plan_follows_the_running_unit_and_keeps_its_links(self):
        planned = self.plan()
        self.assertEqual((planned['fromCommit'], planned['commit']), (BEFORE, self.commit))
        self.assertEqual(planned['links'], {
            f'{c}/backend/.venv': str(self.venv) for c in installer.COMPONENTS} | {
            f'{c}/backend/runtime': str(self.root / 'runtime' / c) for c in installer.COMPONENTS})
        for never in ('service start/enable or restart', 'drop-in or unit change',
                      'database writes', 'migration replay', 'dependency install'):
            self.assertIn(never, planned['notPerformed'])

    def test_it_refuses_a_host_it_cannot_speak_for(self):
        self.units['gateway'] = 'b' * 40
        with self.assertRaisesRegex(ValueError, 'read_and_gateway_on_different_releases'):
            self.plan()
        self.units['gateway'] = BEFORE
        self.units['read'] = self.commit
        self.units['gateway'] = self.commit
        with self.assertRaisesRegex(ValueError, 'release_already_installed'):
            self.plan()

    def test_a_dependency_change_is_refused_because_nothing_here_installs_one(self):
        (self.releases / BEFORE / 'read/backend/requirements-api.lock').write_bytes(b'other==1.0\n')
        with self.assertRaisesRegex(ValueError, 'dependency_change_needs_a_venv'):
            self.plan()

    def test_a_broken_or_missing_installed_link_is_refused(self):
        link = self.releases / BEFORE / 'read/backend/runtime'
        link.unlink()
        with self.assertRaisesRegex(ValueError, 'installed_release_link_missing'):
            self.plan()
        link.symlink_to(self.root / 'gone')
        with self.assertRaisesRegex(ValueError, 'installed_release_link_broken'):
            self.plan()

    def test_apply_writes_both_trees_with_the_two_links_and_nothing_else(self):
        planned = self.plan()
        with patch.object(installer.os, 'geteuid', lambda: 0), \
             patch.object(installer.filesystem, 'protected_parents', lambda path: None):
            result = installer.apply(self.files, planned, owner=os.getuid())
        self.assertTrue(result['ok'])
        root = self.releases / self.commit
        for component in installer.COMPONENTS:
            base = root / component
            self.assertEqual(sorted(str(p.relative_to(base)) for p in base.rglob('*') if p.is_symlink()),
                             ['backend/.venv', 'backend/runtime'])
            self.assertEqual(os.readlink(base / 'backend/.venv'), str(self.venv))
            self.assertEqual((base / 'backend/read_api.py').read_bytes(),
                             self.files['backend/read_api.py'][0])
            self.assertEqual((base / 'scripts/test-contracts.mjs').exists(), True)
        # The running release is untouched, and no unit file was written.
        self.assertEqual((self.releases / BEFORE / 'read/backend/requirements-api.lock').read_bytes(),
                         self.files['backend/requirements-api.lock'][0])
        with self.assertRaisesRegex(ValueError, 'release_directory_exists'):
            with patch.object(installer.os, 'geteuid', lambda: 0), \
                 patch.object(installer.filesystem, 'protected_parents', lambda path: None):
                installer.apply(self.files, planned, owner=os.getuid())

    def test_apply_requires_root(self):
        planned = self.plan()
        with patch.object(installer.os, 'geteuid', lambda: 1000), \
             self.assertRaisesRegex(ValueError, 'root_required'):
            installer.apply(self.files, planned)
        self.assertFalse((self.releases / self.commit).exists())


if __name__ == '__main__':
    unittest.main()
