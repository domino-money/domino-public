"""Offline checks of the V2 automation's installer: its instance template and target, its release tree, its plan's
refusals, its first install and its rollback. No root and no systemd: paths are a temporary tree."""
import contextlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import install_v2_automation as installer

LISTED_CHAINS = tuple(installer.v2_release_chains.CHAINS)

COMMIT, NEXT = 'a' * 40, 'b' * 40
MANIFESTS = [f'docs/deployments/v2-{chain}-2026-10-04/deployment.json'
             for chain in ('arbitrum-42161', 'base-8453', 'robinhood-4663')]


def archive():
    files = {'backend/v2_automation.py': (b'print()\n', False), 'backend/requirements-api.lock': (b'lock', False),
             'backend/v2_chains.py': (b'', False), 'backend/tests/test_x.py': (b'', False),
             'docs/v2/V2_AUTOMATION_BACKEND.md': (b'', False), 'app/src/main.ts': (b'', False)}
    for chain in LISTED_CHAINS:  # v2-chains.json as committed (Elysium joined on 9 Nov 2026), read before any patch
        files[f'api-contracts/v2/chains/{chain}.json'] = (b'{}', False)
    files.update({name: (b'{}', False) for name in MANIFESTS})
    return files


class UnitTests(unittest.TestCase):
    def test_one_instance_per_chain_with_its_sealed_passwords_and_the_pinned_names(self):
        text = installer.unit_text(COMMIT)
        root = f'/opt/domino/financial/releases/{COMMIT}/v2-automation'
        for line in ('User=domino-v2-automation', f'WorkingDirectory={root}',
                     'ExecStart=/opt/domino/backend-venv/bin/python3.14 -B backend/v2_automation.py '
                     '--config /run/domino-v2-automation-config/%i.json serve',
                     'LoadCredentialEncrypted=v2-operator-keystore-password:'
                     '/etc/credstore.encrypted/v2-operator-keystore-password',
                     'LoadCredentialEncrypted=v2-publisher-keystore-password:'
                     '/etc/credstore.encrypted/v2-publisher-keystore-password',
                     'ImportCredential=v2-rpc-*', 'DeviceAllow=char-tpm rw',
                     'StateDirectory=domino-v2-automation/%i', 'StateDirectoryMode=0700', 'ProtectSystem=strict',
                     'ReadWritePaths=/var/lib/domino-v2-automation-public',
                     'BindReadOnlyPaths=/etc/domino/v2/automation:/run/domino-v2-automation-config',
                     f'BindReadOnlyPaths={root}/docs/deployments:/run/domino-v2-deployments',
                     'BindReadOnlyPaths=/etc/domino/continuous-reads/v2-automation.hosts:/etc/hosts',
                     'BindsTo=domino-continuous-egress.service', 'PartOf=domino-v2-automation.target',
                     'Restart=on-failure', 'WantedBy=domino-v2-automation.target'):
            self.assertIn(line + '\n', text)
        # Nothing reaches the process from the environment but the interpreter's own settings.
        self.assertNotIn('EnvironmentFile', text)
        self.assertEqual(installer.release_of(text), COMMIT)
        self.assertIn('WantedBy=multi-user.target\n', installer.target_text())


class HostTests(unittest.TestCase):
    """A temporary host: releases, units, the private and public directories, the receipts."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(self.cleanup)
        for name in ('releases', 'units', 'etc-v2', 'receipts', 'credstore'):
            (self.root / name).mkdir()
        (self.root / 'etc-v2').chmod(0o700)
        self.patches = [patch.object(installer, 'RELEASES', self.root / 'releases'),
                        patch.object(installer, 'PRIVATE', self.root / 'etc-v2/automation'),
                        patch.object(installer, 'PUBLIC', self.root / 'public'),
                        patch.object(installer, 'RECEIPTS', self.root / 'receipts'),
                        patch.object(installer, 'CREDSTORE', self.root / 'credstore'),
                        patch.object(installer.install, 'UNIT_DIR', self.root / 'units'),
                        patch.object(installer.plan_listener, 'running_lock', return_value=b'lock'),
                        patch.object(installer, 'account', return_value=None)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def cleanup(self):
        for directory, _, _ in os.walk(self.root):
            os.chmod(directory, 0o755)
        import shutil
        shutil.rmtree(self.root)

    def test_a_first_install_plans_the_identity_its_directories_and_the_target(self):
        planned = installer.plan(archive(), COMMIT, 'f' * 64)
        self.assertEqual(planned['firstInstall'], {'identity': True, 'privateDirectory': True,
                                                   'publicDirectory': True, 'target': True})
        self.assertEqual((planned['previousUnit'], planned['manifests']), (None, MANIFESTS))
        self.assertEqual(planned['credentialsSealed'], {'v2-operator-keystore-password': False,
                                                        'v2-publisher-keystore-password': False})
        (self.root / 'credstore/v2-operator-keystore-password').write_bytes(b'sealed')
        self.assertTrue(installer.plan(archive(), COMMIT, 'f' * 64)['credentialsSealed']['v2-operator-keystore-password'])

    def test_a_plan_is_refused_for_what_would_not_run_or_would_overwrite(self):
        cases = {
            'manifest_missing': lambda files: [files.pop(name) for name in MANIFESTS],
            'chain_profiles_missing': lambda files: files.pop('api-contracts/v2/chains/base-8453.json'),
            'entry_script_missing': lambda files: files.pop('backend/v2_automation.py'),
            'dependency_lock_changed': lambda files: files.update({'backend/requirements-api.lock': (b'new', False)}),
        }
        for code, change in cases.items():
            files = archive()
            change(files)
            with self.subTest(code=code), self.assertRaisesRegex(ValueError, f'^{code}$'):
                installer.plan(files, COMMIT, 'f' * 64)
        with self.assertRaisesRegex(ValueError, '^invalid_commit$'):
            installer.plan(archive(), 'A' * 40, 'f' * 64)
        (self.root / 'releases' / COMMIT / 'v2-automation').mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, '^release_directory_exists$'):
            installer.plan(archive(), COMMIT, 'f' * 64)

    def test_the_release_carries_the_profile_of_every_chain_the_list_names(self):
        # v2-chains.json (v2_release_chains), held to the enabled profiles: a fourth chain needs its profile too.
        chains = {**installer.v2_release_chains.CHAINS, 'elysium-99801': ('rpc.elysium.example',)}
        with patch.object(installer.v2_release_chains, 'CHAINS', chains):
            with self.assertRaisesRegex(ValueError, '^chain_profiles_missing$'):
                installer.plan(archive(), COMMIT, 'f' * 64)
            files = archive()
            files['api-contracts/v2/chains/elysium-99801.json'] = (b'{}', False)
            self.assertIn('api-contracts/v2/chains/elysium-99801.json', installer.selected(files))
            installer.plan(files, COMMIT, 'f' * 64)

    def test_a_running_release_is_judged_by_its_receipt_and_a_hand_edit_is_refused(self):
        unit = self.root / 'units' / installer.UNIT
        unit.write_text(installer.unit_text(COMMIT))
        planned = installer.plan(archive(), NEXT, 'f' * 64)
        self.assertEqual((planned['previousRelease'], planned['previousUnit']), (COMMIT, unit.read_text()))
        with self.assertRaisesRegex(ValueError, '^release_already_running$'):
            installer.plan(archive(), COMMIT, 'f' * 64)
        older = installer.unit_text(COMMIT).replace('MemoryMax=768M\n', '')
        unit.write_text(older)
        with self.assertRaisesRegex(ValueError, '^unit_drift$'):
            installer.plan(archive(), NEXT, 'f' * 64)
        (self.root / 'receipts' / f'{COMMIT}.json').write_text(json.dumps({'commit': COMMIT, 'unit': older}))
        self.assertEqual(installer.plan(archive(), NEXT, 'f' * 64)['previousUnit'], older)
        unit.write_text(older + 'Environment=X=1\n')
        with self.assertRaisesRegex(ValueError, '^unit_drift$'):
            installer.plan(archive(), NEXT, 'f' * 64)
        unit.write_text('[Service]\nWorkingDirectory=/elsewhere\n')
        with self.assertRaisesRegex(ValueError, '^unit_drift$'):
            installer.plan(archive(), NEXT, 'f' * 64)

    def test_an_edited_target_is_refused(self):
        target = self.root / 'units' / installer.TARGET
        target.write_text(installer.target_text())
        self.assertFalse(installer.plan(archive(), COMMIT, 'f' * 64)['firstInstall']['target'])
        target.write_text(installer.target_text() + 'Wants=other.service\n')
        with self.assertRaisesRegex(ValueError, '^target_drift$'):
            installer.plan(archive(), COMMIT, 'f' * 64)

    def test_rollback_puts_back_the_template_before_or_its_absence_and_refuses_a_changed_one(self):
        unit = self.root / 'units' / installer.UNIT
        with patch.object(installer, 'locked', contextlib.nullcontext), \
                patch.object(installer.install, 'trusted_parents', lambda path: None), \
                patch.object(installer.os, 'geteuid', return_value=0), \
                patch.object(installer.install, 'exclusive_file',
                             lambda path, content, mode=0o600, uid=0, gid=0: Path(path).write_bytes(content)):
            first = installer.plan(archive(), COMMIT, 'f' * 64)
            (self.root / 'receipts' / f'{COMMIT}.json').write_text(json.dumps(first))
            unit.write_text(first['unit'])
            self.assertEqual(installer.rollback(COMMIT)['unit'], 'removed')
            self.assertFalse(unit.exists())
            unit.write_text(first['unit'])
            moved = installer.plan(archive(), NEXT, 'f' * 64)
            (self.root / 'receipts' / f'{NEXT}.json').write_text(json.dumps(moved))
            unit.write_text(moved['unit'])
            self.assertEqual(installer.rollback(NEXT)['unit'], COMMIT)
            self.assertEqual(unit.read_text(), first['unit'])
            unit.write_text(moved['unit'] + '# edited\n')
            with self.assertRaisesRegex(ValueError, '^unit_changed_since_apply$'):
                installer.rollback(NEXT)

    def test_the_release_s_modes_do_not_depend_on_the_installer_s_umask(self):
        # The first production install ran from a shell with umask 077 (5 Oct 2026): open()'s 0o444 became 0o400
        # and no instance could read its own entry script.
        files = {**archive(), 'backend/tool.sh': (b'#!/bin/sh\n', True)}
        previous = os.umask(0o077)
        try:
            installer.install_source(files, COMMIT)
        finally:
            os.umask(previous)
        release = self.root / 'releases' / COMMIT
        tree = release / 'v2-automation'
        self.assertEqual(stat.S_IMODE((tree / 'backend/v2_automation.py').stat().st_mode), 0o444)
        self.assertEqual(stat.S_IMODE((tree / 'backend/tool.sh').stat().st_mode), 0o555)
        self.assertEqual({stat.S_IMODE(p.stat().st_mode) for p in (release, *tree.rglob('*')) if p.is_dir()}, {0o555})

    def test_apply_creates_the_identity_its_directories_the_release_the_target_and_the_template(self):
        calls, owned = [], {}
        user = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        accounts = iter([None, None, None, user])  # plan, the re-plan, before and after useradd

        def run(args, **_):
            calls.append(args)
            return b''
        with patch.object(installer, 'account', side_effect=lambda: next(accounts)), \
                patch.object(installer.install, 'run', side_effect=run), \
                patch.object(installer.install, 'trusted_parents', lambda path: None), \
                patch.object(installer.install, 'exclusive_file',
                             lambda path, content, mode=0o600, uid=0, gid=0: Path(path).write_bytes(content)), \
                patch.object(installer, 'locked', contextlib.nullcontext), \
                patch.object(installer.os, 'geteuid', return_value=0), \
                patch.object(installer.os, 'chown', lambda path, uid, gid: owned.update({str(path): uid})):
            planned = installer.plan(archive(), COMMIT, 'f' * 64)
            result = installer.apply(archive(), planned)
        self.assertEqual(result['firstInstallDone'], ['identity', 'privateDirectory', 'publicDirectory', 'target'])
        self.assertEqual([args[0] for args in calls], ['/usr/sbin/useradd', '/usr/bin/systemd-analyze'])
        self.assertEqual(calls[0][-1], 'domino-v2-automation')
        self.assertNotIn('--groups', calls[0])  # no database role, no shared group
        self.assertEqual(calls[1][-1], str(self.root / 'units' / installer.UNIT))
        private, public = self.root / 'etc-v2/automation', self.root / 'public'
        self.assertEqual((stat.S_IMODE(private.stat().st_mode), stat.S_IMODE(public.stat().st_mode)), (0o700, 0o755))
        self.assertEqual(set(owned), {str(private), str(public)})
        tree = self.root / 'releases' / COMMIT / 'v2-automation'
        self.assertTrue(all((tree / name).is_file() for name in MANIFESTS))
        self.assertTrue((tree / 'backend/v2_automation.py').is_file())
        self.assertFalse((tree / 'backend/tests').exists() or (tree / 'app').exists())
        self.assertEqual((self.root / 'units' / installer.UNIT).read_text(), planned['unit'])
        self.assertEqual((self.root / 'units' / installer.TARGET).read_text(), installer.target_text())
        self.assertTrue((self.root / 'receipts' / f'{COMMIT}.json').is_file())


if __name__ == '__main__':
    unittest.main()
