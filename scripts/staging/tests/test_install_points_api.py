"""Offline checks of season 1's points listener installer: its unit, its peer row, its release tree, its plan's
refusals and its rollback. No root, no PostgreSQL, no systemd: paths are a temporary tree."""
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
import install_crosschain as crosschain
import install_points_api as installer
import install_position_plan as plan_listener

COMMIT, NEXT = 'a' * 40, 'b' * 40
HBA = (b'local all postgres peer\n'
       b'local domino_catalogue domino_session_auth peer map=domino\n'
       b'local all all reject\n')
IDENT = (b'domino domino-auth domino_session_auth\ndomino domino-position-plan domino_session_auth\n'
         b'domino domino-crosschain domino_session_auth\n')


def archive():
    return {'backend/points_api.py': (b'print()\n', False), 'backend/requirements-api.lock': (b'lock', False),
            'backend/points_season_1.json': (b'{}', False), 'backend/tests/test_x.py': (b'', False),
            'api-contracts/v2/chains/robinhood-4663.json': (b'{}', False),
            'api-contracts/v2/public-test-accounts.json': (b'{}', False),
            'api-contracts/points-v1/manifest.json': (b'{}', False),
            'docs/deployments/v2-robinhood-4663-2026-10-04/deployment.json': (b'{}', False),
            'docs/points/POINTS.md': (b'', False), 'app/src/main.ts': (b'', False)}


class UnitTests(unittest.TestCase):
    def test_the_unit_starts_disabled_with_its_private_files_and_no_credential(self):
        text = installer.unit_text(COMMIT)
        root = f'/opt/domino/financial/releases/{COMMIT}/points'
        for line in ('User=domino-points', 'Group=domino-points', 'SupplementaryGroups=domino-db',
                     f'WorkingDirectory={root}',
                     'ExecStart=/opt/domino/backend-venv/bin/python3.14 -B backend/points_api.py --port 8912',
                     'EnvironmentFile=-/etc/domino/financial/points/environment',
                     f'BindPaths=/var/lib/domino-financial/points:{root}/backend/runtime',
                     'BindReadOnlyPaths=/etc/domino/financial/points:/run/domino-financial-points-config',
                     'ReadWritePaths=/var/lib/domino-financial/points', 'ProtectSystem=strict',
                     'PrivateDevices=true', 'NoNewPrivileges=true', 'CapabilityBoundingSet=',
                     'IPAddressDeny=any', 'IPAddressAllow=localhost'):
            self.assertIn(line + '\n', text)
        # Only the egress policy's drop-in enables it. It holds no key: no credential, so no TPM in its devices.
        self.assertNotIn('--enable', text)
        self.assertNotIn('ImportCredential', text)
        self.assertNotIn('LoadCredential', text)
        self.assertNotIn('DeviceAllow', text)
        # It reads no manifest (the roles come from the database) and is wanted by the egress target alone.
        self.assertNotIn('deployments', text)
        self.assertNotIn('[Install]', text)
        self.assertEqual(installer.release_of(text), COMMIT)
        self.assertIsNone(installer.release_of(text.replace(COMMIT, 'c' * 39)))
        self.assertIsNone(installer.release_of(plan_listener.unit_text(COMMIT)))
        self.assertIsNone(installer.release_of(crosschain.unit_text(COMMIT)))

    def test_it_shares_the_plan_listener_s_session_role_lock_and_interpreter_on_a_port_of_its_own(self):
        self.assertEqual((installer.SQL_ROLE, installer.PEER_MAP, installer.HBA_ROW, installer.CATALOGUE),
                         (plan_listener.SQL_ROLE, plan_listener.PEER_MAP, plan_listener.HBA_ROW, plan_listener.CATALOGUE))
        self.assertIs(installer.locked, plan_listener.locked)
        self.assertIs(installer.running_lock, plan_listener.running_lock)
        self.assertNotIn(installer.PORT, (plan_listener.PORT, crosschain.PORT))
        # The listener's own default, and a port its reserved list does not hold.
        backend = Path(__file__).resolve().parents[3] / 'backend'
        source = (backend / 'points_api.py').read_text()
        self.assertIn(f'DEFAULT_PORT = {installer.PORT}\n', source)
        self.assertNotIn(str(installer.PORT), source.split('RESERVED_PORTS = ', 1)[1].split('\n', 1)[0])
        for port in (plan_listener.PORT, crosschain.PORT):
            self.assertIn(str(port), source.split('RESERVED_PORTS = ', 1)[1].split('\n', 1)[0])


class PeerRowTests(unittest.TestCase):
    def test_the_row_is_appended_once(self):
        added = installer.with_peer_row(IDENT)
        self.assertEqual(added, IDENT + b'domino domino-points domino_session_auth\n')
        self.assertEqual(installer.with_peer_row(IDENT.rstrip(b'\n')),
                         IDENT + b'domino domino-points domino_session_auth\n')
        with self.assertRaisesRegex(ValueError, '^peer_row_exists$'):
            installer.with_peer_row(added)


class TreeTests(unittest.TestCase):
    def test_a_release_carries_the_backend_and_the_v2_profiles_only(self):
        self.assertEqual(sorted(installer.selected(archive())),
                         ['api-contracts/v2/chains/robinhood-4663.json', 'api-contracts/v2/public-test-accounts.json',
                          'backend/points_api.py', 'backend/points_season_1.json', 'backend/requirements-api.lock'])


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
                        patch.object(installer, 'PRIVATE', self.root / 'private/points'),
                        patch.object(installer, 'RUNTIME', self.root / 'runtime/points'),
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
        self.assertIsNone(planned['previousUnit'])
        self.assertEqual(planned['mode'], 'points-install')
        self.assertIn('migration 059', planned['notPerformed'])
        self.assertEqual(planned['unit'], installer.unit_text(COMMIT).replace(
            '/opt/domino/financial/releases', str(self.root / 'releases')))
        (self.root / 'pg/pg_ident.conf').write_bytes(IDENT + b'domino domino-points domino_session_auth\n')
        self.assertFalse(installer.plan(archive(), COMMIT, 'f' * 64)['firstInstall']['peerRow'])

    def test_a_plan_is_refused_for_what_would_not_run_or_would_overwrite(self):
        cases = {
            'season_configuration_missing': lambda files: files.pop('backend/points_season_1.json'),
            'chain_profiles_missing': lambda files: files.pop('api-contracts/v2/chains/robinhood-4663.json'),
            'entry_script_missing': lambda files: files.pop('backend/points_api.py'),
            'dependency_lock_changed': lambda files: files.update({'backend/requirements-api.lock': (b'new', False)}),
        }
        for code, change in cases.items():
            files = archive()
            change(files)
            with self.subTest(code=code), self.assertRaisesRegex(ValueError, f'^{code}$'):
                installer.plan(files, COMMIT, 'f' * 64)
        files = archive()
        files.pop('api-contracts/v2/public-test-accounts.json')
        with self.assertRaisesRegex(ValueError, '^chain_profiles_missing$'):
            installer.plan(files, COMMIT, 'f' * 64)
        with self.assertRaisesRegex(ValueError, '^invalid_commit$'):
            installer.plan(archive(), 'A' * 40, 'f' * 64)
        (self.root / 'releases' / COMMIT / 'points').mkdir(parents=True)
        with self.assertRaisesRegex(ValueError, '^release_directory_exists$'):
            installer.plan(archive(), COMMIT, 'f' * 64)
        (self.root / 'pg/pg_hba.conf').write_bytes(b'local all all reject\n')
        with self.assertRaisesRegex(ValueError, '^session_peer_rule_missing$'):
            installer.plan(archive(), NEXT, 'f' * 64)

    def test_a_running_release_is_judged_by_its_receipt_and_a_hand_edited_unit_is_refused(self):
        unit = self.root / 'units' / installer.UNIT
        unit.write_text(installer.unit_text(COMMIT))
        planned = installer.plan(archive(), NEXT, 'f' * 64)
        self.assertEqual((planned['previousRelease'], planned['previousUnit']), (COMMIT, unit.read_text()))
        with self.assertRaisesRegex(ValueError, '^release_already_running$'):
            installer.plan(archive(), COMMIT, 'f' * 64)
        older = installer.unit_text(COMMIT).replace('TasksMax=32\n', '')
        unit.write_text(older)
        with self.assertRaisesRegex(ValueError, '^unit_drift$'):
            installer.plan(archive(), NEXT, 'f' * 64)  # no receipt: judged by today's template
        (self.root / 'receipts' / f'{COMMIT}.json').write_text(json.dumps({'commit': COMMIT, 'unit': older}))
        self.assertEqual(installer.plan(archive(), NEXT, 'f' * 64)['previousUnit'], older)
        unit.write_text(older + 'Environment=DOMINO_SESSION_ABUSE_SECRET=x\n')
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
        # A deploy shell with umask 077 turned open()'s 0o444 into 0o400 (the V2 automation, 5 Oct 2026).
        files = {**archive(), 'backend/tool.sh': (b'#!/bin/sh\n', True)}
        previous = os.umask(0o077)
        try:
            installer.install_source(files, COMMIT)
        finally:
            os.umask(previous)
        release = self.root / 'releases' / COMMIT
        tree = release / 'points'
        self.assertEqual(stat.S_IMODE((tree / 'backend/points_api.py').stat().st_mode), 0o444)
        self.assertEqual(stat.S_IMODE((tree / 'backend/tool.sh').stat().st_mode), 0o555)
        self.assertEqual({stat.S_IMODE(p.stat().st_mode) for p in (release, *tree.rglob('*')) if p.is_dir()}, {0o555})

    def test_apply_proves_the_peer_row_before_writing_the_release_receipt_and_unit(self):
        calls, sql = [], []
        user = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        accounts = iter([None, None, None, user])  # plan, the re-plan, before and after useradd

        def run(args, **_):
            calls.append(args)
            return b''

        def query(text, **options):
            sql.append((text, options.get('os_user')))
            return 't' if 'reload' in text else 'domino_session_auth'
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
                patch.object(installer, 'locked', contextlib.nullcontext), \
                patch.object(installer.os, 'geteuid', return_value=0), \
                patch.object(installer.os, 'chown', lambda *args: None):
            planned = installer.plan(archive(), COMMIT, 'f' * 64)
            result = installer.apply(archive(), planned)
        self.assertEqual(result['firstInstallDone'], ['identity', 'peerRow', 'privateDirectory', 'runtimeDirectory',
                                                      'catalogueSettings'])
        self.assertEqual([args[0] for args in calls], ['/usr/sbin/useradd', '/usr/bin/systemd-analyze'])
        self.assertEqual(calls[0][-3:], ['--groups', 'domino-db', 'domino-points'])
        self.assertEqual(calls[1][-1], str(self.root / 'units' / installer.UNIT))
        self.assertEqual([who for _, who in sql], [None, 'domino-points'])
        self.assertEqual((self.root / 'pg/pg_ident.conf').read_bytes(),
                         IDENT + b'domino domino-points domino_session_auth\n')
        runtime = self.root / 'runtime/points'
        self.assertEqual(json.loads((runtime / 'catalogue-db.json').read_text()),
                         {'host': '/run/postgresql-domino', 'port': 8877, 'dbname': 'domino_catalogue'})
        # points_api.py takes its process lock in backend/runtime/points, the runtime bound there.
        self.assertTrue((runtime / 'points').is_dir())
        self.assertEqual(stat.S_IMODE((self.root / 'private/points').stat().st_mode), 0o700)
        tree = self.root / 'releases' / COMMIT / 'points'
        self.assertTrue((tree / 'backend/points_season_1.json').is_file() and (tree / 'backend/runtime').is_dir())
        self.assertTrue((tree / 'api-contracts/v2/public-test-accounts.json').is_file())
        self.assertFalse((tree / 'backend/tests').exists() or (tree / 'app').exists() or (tree / 'docs').exists())
        self.assertFalse((tree / 'api-contracts/points-v1').exists())
        self.assertEqual((self.root / 'units' / installer.UNIT).read_text(), planned['unit'])
        receipt = json.loads((self.root / 'receipts' / f'{COMMIT}.json').read_text())
        self.assertEqual((receipt['unit'], receipt['firstInstallDone']), (planned['unit'], result['firstInstallDone']))
        self.assertEqual(result['rollback'], f'install_points_api.py --rollback {COMMIT}')


if __name__ == '__main__':
    unittest.main()
