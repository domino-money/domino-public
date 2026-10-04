"""Offline checks of the S1 plan listener's installer: its unit, its peer row, its release tree, its plan's
refusals and its rollback. No root, no PostgreSQL, no systemd: paths are a temporary tree."""
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import install_position_plan as installer

COMMIT, NEXT = 'a' * 40, 'b' * 40
MANIFEST = 'docs/deployments/v2-robinhood-4663-2026-10-04/deployment.json'
HBA = (b'local all postgres peer\n'
       b'local domino_catalogue domino_session_auth peer map=domino\n'
       b'local all all reject\n')
IDENT = b'domino domino-auth domino_session_auth\n'


def archive():
    return {'backend/v2_position_plan_api.py': (b'print()\n', False), 'backend/requirements-api.lock': (b'lock', False),
            'backend/v2_chains.py': (b'', False), 'backend/tests/test_x.py': (b'', False),
            'api-contracts/v2/chains/robinhood-4663.json': (b'{}', False), MANIFEST: (b'{}', False),
            'docs/deployments/v2-rehearsal-2026-10-02/base-8453-deployment.json': (b'{}', False),
            'docs/v2/V2_S1_PLAN_API.md': (b'', False), 'app/src/main.ts': (b'', False)}


class UnitTests(unittest.TestCase):
    def test_the_unit_starts_disabled_with_its_private_files_and_the_sealed_key_only(self):
        text = installer.unit_text(COMMIT)
        root = f'/opt/domino/financial/releases/{COMMIT}/position-plan'
        for line in ('User=domino-position-plan', 'SupplementaryGroups=domino-db', f'WorkingDirectory={root}',
                     'ExecStart=/opt/domino/backend-venv/bin/python3.14 -B backend/v2_position_plan_api.py --port 8911',
                     'EnvironmentFile=-/etc/domino/financial/position-plan/environment',
                     'ImportCredential=uniswap-api-key',
                     f'BindPaths=/var/lib/domino-financial/position-plan:{root}/backend/runtime',
                     'BindReadOnlyPaths=/etc/domino/financial/position-plan:/run/domino-financial-position-plan-config',
                     f'BindReadOnlyPaths={root}/docs/deployments:/run/domino-v2-deployments',
                     'ReadWritePaths=/var/lib/domino-financial/position-plan', 'ProtectSystem=strict',
                     'IPAddressDeny=any', 'IPAddressAllow=localhost'):
            self.assertIn(line + '\n', text)
        # Only the egress policy's drop-in enables it; the key never comes from the environment.
        self.assertNotIn('--enable', text)
        self.assertIn('DOMINO_UNISWAP_API_KEY', next(l for l in text.splitlines() if l.startswith('UnsetEnvironment=')))
        self.assertNotIn('[Install]', text)
        self.assertEqual(installer.release_of(text), COMMIT)
        self.assertIsNone(installer.release_of(text.replace(COMMIT, 'c' * 39)))
        self.assertIsNone(installer.release_of('[Service]\nWorkingDirectory=/opt/elsewhere\n'))


class PeerRowTests(unittest.TestCase):
    def test_the_row_is_appended_once(self):
        added = installer.with_peer_row(IDENT)
        self.assertEqual(added, IDENT + b'domino domino-position-plan domino_session_auth\n')
        self.assertEqual(installer.with_peer_row(IDENT.rstrip(b'\n')),
                         IDENT + b'domino domino-position-plan domino_session_auth\n')
        with self.assertRaisesRegex(ValueError, '^peer_row_exists$'):
            installer.with_peer_row(added)


class TreeTests(unittest.TestCase):
    def test_a_release_carries_the_backend_the_v2_exports_and_the_manifests_only(self):
        self.assertEqual(sorted(installer.selected(archive())),
                         ['api-contracts/v2/chains/robinhood-4663.json', 'backend/requirements-api.lock',
                          'backend/v2_chains.py', 'backend/v2_position_plan_api.py', MANIFEST])


class RunningLockTests(unittest.TestCase):
    """Unmocked: the read release's own layout, where the 4 Oct deploy found the first version looking in
    read/backend/backend/ and stopping on FileNotFoundError."""

    def test_the_running_lock_is_the_read_release_s_own_lockfile(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            read = base / 'releases' / ('c' * 40) / 'read'
            (read / 'backend').mkdir(parents=True)
            (read / 'backend/requirements-api.lock').write_bytes(b'the pinned lock\n')
            with patch.object(installer.install, 'BASE', base), \
                 patch.object(installer.install, 'run', return_value=(str(read) + '\n').encode()) as run:
                self.assertEqual(installer.running_lock(), b'the pinned lock\n')
            self.assertEqual(run.call_args.args[0], ['/usr/bin/systemctl', 'show', 'domino-read.service', '-p',
                                                     'WorkingDirectory', '--value'])

    def test_a_reader_outside_the_releases_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            base = Path(directory)
            for elsewhere in (base / 'other' / ('c' * 40) / 'read', Path('relative/read')):
                with self.subTest(elsewhere=str(elsewhere)), patch.object(installer.install, 'BASE', base), \
                        patch.object(installer.install, 'run', return_value=str(elsewhere).encode()):
                    with self.assertRaisesRegex(ValueError, 'read_release_unknown'):
                        installer.running_lock()


class HostTests(unittest.TestCase):
    """A temporary host: releases, units, PostgreSQL configuration and the financial base."""

    def setUp(self):
        self.root = Path(tempfile.mkdtemp())
        self.addCleanup(self.cleanup)
        for name in ('releases', 'units', 'pg', 'private', 'runtime', 'receipts'):
            (self.root / name).mkdir()
        (self.root / 'pg/pg_hba.conf').write_bytes(HBA)
        (self.root / 'pg/pg_ident.conf').write_bytes(IDENT)
        self.patches = [patch.object(installer, 'RELEASES', self.root / 'releases'),
                        patch.object(installer, 'PRIVATE', self.root / 'private/position-plan'),
                        patch.object(installer, 'RUNTIME', self.root / 'runtime/position-plan'),
                        patch.object(installer, 'RECEIPTS', self.root / 'receipts'),
                        patch.object(installer.install, 'UNIT_DIR', self.root / 'units'),
                        patch.object(installer.install, 'CONFIG', self.root / 'pg'),
                        patch.object(installer, 'running_lock', return_value=b'lock'),
                        patch.object(installer, 'account', return_value=None)]
        for item in self.patches:
            item.start()
            self.addCleanup(item.stop)

    def cleanup(self):
        for directory, _, _ in os.walk(self.root):
            os.chmod(directory, 0o755)
        import shutil
        shutil.rmtree(self.root)

    def test_a_first_install_plans_the_identity_its_row_and_its_directories(self):
        planned = installer.plan(archive(), COMMIT, 'f' * 64)
        self.assertEqual(planned['firstInstall'], {'identity': True, 'peerRow': True, 'privateDirectory': True,
                                                   'runtimeDirectory': True})
        self.assertEqual((planned['previousUnit'], planned['manifests']), (None, [MANIFEST]))
        self.assertEqual(planned['unit'], installer.unit_text(COMMIT).replace(
            '/opt/domino/financial/releases', str(self.root / 'releases')))

    def test_a_plan_is_refused_for_what_would_not_run_or_would_overwrite(self):
        cases = {
            'manifest_missing': lambda files: files.pop(MANIFEST),
            'chain_profiles_missing': lambda files: files.pop('api-contracts/v2/chains/robinhood-4663.json'),
            'entry_script_missing': lambda files: files.pop('backend/v2_position_plan_api.py'),
            'dependency_lock_changed': lambda files: files.update({'backend/requirements-api.lock': (b'new', False)}),
        }
        for code, change in cases.items():
            files = archive()
            change(files)
            with self.subTest(code=code), self.assertRaisesRegex(ValueError, f'^{code}$'):
                installer.plan(files, COMMIT, 'f' * 64)
        with self.assertRaisesRegex(ValueError, '^invalid_commit$'):
            installer.plan(archive(), 'A' * 40, 'f' * 64)
        (self.root / 'pg/pg_hba.conf').write_bytes(b'local all all reject\n')
        with self.assertRaisesRegex(ValueError, '^session_peer_rule_missing$'):
            installer.plan(archive(), COMMIT, 'f' * 64)

    def test_a_running_release_is_moved_and_a_hand_edited_unit_is_refused(self):
        unit = self.root / 'units' / installer.UNIT
        unit.write_text(installer.unit_text(COMMIT))
        planned = installer.plan(archive(), NEXT, 'f' * 64)
        self.assertEqual((planned['previousRelease'], planned['previousUnit']), (COMMIT, unit.read_text()))
        with self.assertRaisesRegex(ValueError, '^release_already_running$'):
            installer.plan(archive(), COMMIT, 'f' * 64)
        unit.write_text(installer.unit_text(COMMIT) + 'Environment=DOMINO_UNISWAP_API_KEY=x\n')
        with self.assertRaisesRegex(ValueError, '^unit_drift$'):
            installer.plan(archive(), NEXT, 'f' * 64)
        (self.root / 'releases' / NEXT / 'position-plan').mkdir(parents=True)
        unit.write_text(installer.unit_text(COMMIT))
        with self.assertRaisesRegex(ValueError, '^release_directory_exists$'):
            installer.plan(archive(), NEXT, 'f' * 64)

    def test_rollback_puts_back_the_unit_before_or_its_absence_and_refuses_a_changed_one(self):
        unit = self.root / 'units' / installer.UNIT
        locked = patch.object(installer, 'locked', lambda: __import__('contextlib').nullcontext())
        trusted = patch.object(installer.install, 'trusted_parents', lambda path: None)
        root = patch.object(installer.os, 'geteuid', return_value=0)
        files = patch.object(installer.install, 'exclusive_file',
                             lambda path, content, mode=0o600, uid=0, gid=0: Path(path).write_bytes(content))
        with locked, trusted, root, files:
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

    def test_apply_proves_the_peer_row_before_writing_the_release_receipt_and_unit(self):
        calls, sql = [], []
        user = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        accounts = iter([None, None, None, user])

        def run(args, **_):
            calls.append(args[0])
            return b''

        def query(text, **options):
            sql.append((text, options.get('os_user')))
            return 't' if 'reload' in text else 'domino_session_auth'
        (self.root / 'private').chmod(0o700)
        with patch.object(installer, 'account', side_effect=lambda: next(accounts)), \
                patch.object(installer.install, 'run', side_effect=run), \
                patch.object(installer.install, 'sql', side_effect=query), \
                patch.object(installer.install, 'validate_pg_files', lambda: None), \
                patch.object(installer.install, 'trusted_parents', lambda path: None), \
                patch.object(installer.install, 'exclusive_file',
                             lambda path, content, mode=0o600, uid=0, gid=0: Path(path).write_bytes(content)), \
                patch.object(installer.install, 'replace_pg_config', lambda path, raw: Path(path).write_bytes(raw)), \
                patch.object(installer.financial, 'PRIVATE', self.root / 'private'), \
                patch.object(installer.financial, 'RUNTIME', self.root / 'runtime'), \
                patch.object(installer, 'locked', lambda: __import__('contextlib').nullcontext()), \
                patch.object(installer.os, 'geteuid', return_value=0), \
                patch.object(installer.os, 'chown', lambda *args: None):
            planned = installer.plan(archive(), COMMIT, 'f' * 64)
            result = installer.apply(archive(), planned)
        self.assertEqual(result['firstInstallDone'], ['identity', 'peerRow', 'privateDirectory', 'runtimeDirectory',
                                                      'catalogueSettings'])
        self.assertEqual(calls, ['/usr/sbin/useradd', '/usr/bin/systemd-analyze'])
        self.assertEqual([who for _, who in sql], [None, 'domino-position-plan'])
        self.assertIn(b'domino domino-position-plan domino_session_auth\n', (self.root / 'pg/pg_ident.conf').read_bytes())
        self.assertEqual(json.loads((self.root / 'runtime/position-plan/catalogue-db.json').read_text()),
                         {'host': '/run/postgresql-domino', 'port': 8877, 'dbname': 'domino_catalogue'})
        tree = self.root / 'releases' / COMMIT / 'position-plan'
        self.assertTrue((tree / MANIFEST).is_file() and (tree / 'backend/runtime').is_dir())
        self.assertFalse((tree / 'backend/tests').exists() or (tree / 'app').exists())
        self.assertEqual((self.root / 'units' / installer.UNIT).read_text(), planned['unit'])
        self.assertTrue((self.root / 'receipts' / f'{COMMIT}.json').is_file())


if __name__ == '__main__':
    unittest.main()
