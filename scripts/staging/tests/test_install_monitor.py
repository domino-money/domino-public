"""Offline checks of the monitor's installer: its unit, its release tree, its plan's refusals, its first install and
its rollback. No root and no systemd: paths are a temporary tree."""
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
import install_monitor as installer

COMMIT, NEXT = 'a' * 40, 'b' * 40


def archive():
    files = {'backend/ops_monitor.py': (b'print()\n', False), 'backend/requirements-api.lock': (b'lock', False),
             'backend/v2_events.py': (b'', False), 'backend/tests/test_x.py': (b'', False),
             'api-contracts/v2/abi/IDominoRegistry.json': (b'{}', False),
             'docs/deployments/v2-base-8453-2026-10-04/deployment.json': (b'{}', False),
             'docs/OPS_MONITOR.md': (b'', False), 'app/src/main.ts': (b'', False)}
    for chain in ('robinhood-4663', 'base-8453', 'arbitrum-42161'):
        files[f'api-contracts/v2/chains/{chain}.json'] = (b'{}', False)
    return files


class UnitTests(unittest.TestCase):
    def test_the_unit_reads_the_journal_takes_its_token_as_a_credential_and_is_wanted_at_boot_by_itself(self):
        text = installer.unit_text(COMMIT)
        root = f'/opt/domino/financial/releases/{COMMIT}/monitor'
        for line in ('User=domino-monitor', 'SupplementaryGroups=systemd-journal', f'WorkingDirectory={root}',
                     'ExecStart=/opt/domino/backend-venv/bin/python3.14 -B backend/ops_monitor.py '
                     '--config /run/domino-monitor-config/config.json serve',
                     'ImportCredential=telegram-bot-token', 'ImportCredential=v2-rpc-*', 'DeviceAllow=char-tpm rw',
                     'StateDirectory=domino-monitor', 'StateDirectoryMode=0700', 'ProtectSystem=strict',
                     'ReadWritePaths=/var/lib/domino-monitor-public',
                     'BindReadOnlyPaths=/etc/domino/monitor:/run/domino-monitor-config',
                     'BindReadOnlyPaths=/etc/domino/continuous-reads/monitor.hosts:/etc/hosts',
                     'PrivateDevices=true', 'NoNewPrivileges=true', 'Restart=always', 'WantedBy=multi-user.target'):
            self.assertIn(line + '\n', text)
        # Not a member of the read path's target, whose stop would take it along; no token in the environment.
        self.assertNotIn('PartOf=', text)
        self.assertNotIn('BindsTo=', text)
        self.assertNotIn('EnvironmentFile', text)
        self.assertEqual(installer.release_of(text), COMMIT)
        self.assertIsNone(installer.release_of(text.replace(COMMIT, 'c' * 39)))


class TreeTests(unittest.TestCase):
    def test_a_release_carries_the_backend_and_the_v2_exports_only(self):
        self.assertEqual(sorted(installer.selected(archive())),
                         ['api-contracts/v2/abi/IDominoRegistry.json', 'api-contracts/v2/chains/arbitrum-42161.json',
                          'api-contracts/v2/chains/base-8453.json', 'api-contracts/v2/chains/robinhood-4663.json',
                          'backend/ops_monitor.py', 'backend/requirements-api.lock', 'backend/v2_events.py'])


class HostTests(unittest.TestCase):
    """A temporary host: releases, units, the private and public directories, the receipts."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(self.cleanup)
        for name in ('releases', 'units', 'etc-domino', 'receipts'):
            (self.root / name).mkdir()
        (self.root / 'etc-domino').chmod(0o700)
        self.patches = [patch.object(installer, 'RELEASES', self.root / 'releases'),
                        patch.object(installer, 'PRIVATE', self.root / 'etc-domino/monitor'),
                        patch.object(installer, 'PUBLIC', self.root / 'public'),
                        patch.object(installer, 'RECEIPTS', self.root / 'receipts'),
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

    def test_a_first_install_plans_the_identity_and_its_directories(self):
        planned = installer.plan(archive(), COMMIT, 'f' * 64)
        self.assertEqual(planned['firstInstall'], {'identity': True, 'privateDirectory': True,
                                                   'publicDirectory': True})
        self.assertIsNone(planned['previousUnit'])
        self.assertEqual(planned['unit'], installer.unit_text(COMMIT).replace(
            '/opt/domino/financial/releases', str(self.root / 'releases')))

    def test_the_release_carries_the_profile_of_every_chain_the_list_names(self):
        # v2-chains.json (v2_release_chains), held to the enabled profiles: a fourth chain needs its profile too.
        chains = {**installer.v2_release_chains.CHAINS, 'elysium-99801': ('rpc.elysium.example',)}
        with patch.object(installer.v2_release_chains, 'CHAINS', chains):
            with self.assertRaisesRegex(ValueError, '^v2_exports_missing$'):
                installer.plan(archive(), COMMIT, 'f' * 64)
            files = archive()
            files['api-contracts/v2/chains/elysium-99801.json'] = (b'{}', False)
            installer.plan(files, COMMIT, 'f' * 64)

    def test_a_plan_is_refused_for_what_would_not_run_or_would_overwrite(self):
        cases = {
            'v2_exports_missing': lambda files: files.pop('api-contracts/v2/abi/IDominoRegistry.json'),
            'entry_script_missing': lambda files: files.pop('backend/ops_monitor.py'),
            'dependency_lock_changed': lambda files: files.update({'backend/requirements-api.lock': (b'new', False)}),
        }
        for chain in ('robinhood-4663', 'base-8453', 'arbitrum-42161'):
            cases[f'v2_exports_missing:{chain}'] = lambda files, chain=chain: files.pop(
                f'api-contracts/v2/chains/{chain}.json')
        for code, change in cases.items():
            files = archive()
            change(files)
            with self.subTest(code=code), self.assertRaisesRegex(ValueError, f'^{code.split(":")[0]}$'):
                installer.plan(files, COMMIT, 'f' * 64)
        with self.assertRaisesRegex(ValueError, '^invalid_commit$'):
            installer.plan(archive(), 'A' * 40, 'f' * 64)
        (self.root / 'releases' / COMMIT / 'monitor').mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, '^release_directory_exists$'):
            installer.plan(archive(), COMMIT, 'f' * 64)

    def test_a_running_release_is_judged_by_its_receipt_and_a_hand_edit_is_refused(self):
        unit = self.root / 'units' / installer.UNIT
        unit.write_text(installer.unit_text(COMMIT))
        planned = installer.plan(archive(), NEXT, 'f' * 64)
        self.assertEqual((planned['previousRelease'], planned['previousUnit']), (COMMIT, unit.read_text()))
        with self.assertRaisesRegex(ValueError, '^release_already_running$'):
            installer.plan(archive(), COMMIT, 'f' * 64)
        older = installer.unit_text(COMMIT).replace('MemoryMax=384M\n', '')
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

    def test_rollback_puts_back_the_unit_before_or_its_absence_and_refuses_a_changed_one(self):
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
            (self.root / 'receipts' / f'{NEXT}.json').write_text(json.dumps({**moved, 'mode': 'crosschain-install'}))
            with self.assertRaisesRegex(ValueError, '^invalid_receipt$'):
                installer.rollback(NEXT)

    def test_the_release_s_modes_do_not_depend_on_the_installer_s_umask(self):
        files = {**archive(), 'backend/tool.sh': (b'#!/bin/sh\n', True)}
        previous = os.umask(0o077)
        try:
            installer.install_source(files, COMMIT)
        finally:
            os.umask(previous)
        release = self.root / 'releases' / COMMIT
        tree = release / 'monitor'
        self.assertEqual(stat.S_IMODE((tree / 'backend/ops_monitor.py').stat().st_mode), 0o444)
        self.assertEqual(stat.S_IMODE((tree / 'backend/tool.sh').stat().st_mode), 0o555)
        self.assertEqual({stat.S_IMODE(p.stat().st_mode) for p in (release, *tree.rglob('*')) if p.is_dir()}, {0o555})

    def test_apply_creates_the_identity_in_the_journal_group_its_directories_the_release_and_the_unit(self):
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
                patch.object(installer.automation.os, 'chown', lambda path, uid, gid: owned.update({str(path): uid})):
            planned = installer.plan(archive(), COMMIT, 'f' * 64)
            result = installer.apply(archive(), planned)
        self.assertEqual(result['firstInstallDone'], ['identity', 'privateDirectory', 'publicDirectory'])
        self.assertEqual([args[0] for args in calls], ['/usr/sbin/useradd', '/usr/bin/systemd-analyze'])
        self.assertEqual(calls[0][-3:], ['--groups', 'systemd-journal', 'domino-monitor'])
        self.assertEqual(calls[1][-1], str(self.root / 'units' / installer.UNIT))
        private, public = self.root / 'etc-domino/monitor', self.root / 'public'
        self.assertEqual((stat.S_IMODE(private.stat().st_mode), stat.S_IMODE(public.stat().st_mode)), (0o700, 0o755))
        self.assertEqual(set(owned), {str(private), str(public)})
        tree = self.root / 'releases' / COMMIT / 'monitor'
        self.assertTrue((tree / 'backend/ops_monitor.py').is_file()
                        and (tree / 'api-contracts/v2/abi/IDominoRegistry.json').is_file())
        self.assertFalse((tree / 'backend/tests').exists() or (tree / 'app').exists() or (tree / 'docs').exists())
        self.assertEqual((self.root / 'units' / installer.UNIT).read_text(), planned['unit'])
        self.assertTrue((self.root / 'receipts' / f'{COMMIT}.json').is_file())


if __name__ == '__main__':
    unittest.main()
