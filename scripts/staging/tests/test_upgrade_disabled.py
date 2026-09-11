"""Unprivileged upgrade regressions: temporary files and mocked host boundaries."""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import prepare_disabled as install
import upgrade_disabled as upgrade

BEFORE, AFTER = 'a' * 40, 'b' * 40
PRIVATE = 'SYNTHETIC_PRIVATE_DIAGNOSTIC'


def archives():
    old = {name: (b'unchanged\n', False) for name in (
        *install.MIGRATIONS, 'backend/schema.sql', 'backend/requirements-api.lock')}
    old['backend/read_api.py'] = (b'old code\n', False)
    new = dict(old, **{'backend/read_api.py': (b'new code\n', False)})
    return old, new


def make_plan(old=None, new=None):
    if old is None:
        old, new = archives()
    return upgrade.plan(old, new, 'c' * 64, 'd' * 64, BEFORE, AFTER)


def make_file(path, payload, mode=0o600):
    path.write_bytes(payload)
    path.chmod(mode)


def populate_runtime(root):
    for component in install.ROOTS:
        runtime = root / component / 'backend/runtime'
        runtime.mkdir(mode=0o700, parents=True, exist_ok=True)
        runtime.chmod(0o700)
        make_file(runtime / 'catalogue-db.json', json.dumps({
            'host': install.SOCKET, 'port': 8877, 'dbname': install.DB}).encode())
        make_file(runtime / 'provider.json', (PRIVATE + component).encode())
        (runtime / 'locks').mkdir(mode=0o700)
        (runtime / 'locks' / 'nested').mkdir(mode=0o700)
        make_file(runtime / 'locks' / 'nested' / 'lease', b'lease\x00bytes')
        (runtime / 'reports').mkdir(mode=0o700)
        make_file(runtime / 'reports' / 'checkpoint.json', b'{"revision":2}\n', 0o644)
        (runtime / 'empty').mkdir(mode=0o700)


class PlanTests(unittest.TestCase):
    def test_plan_is_host_free_and_compares_full_archive_file_content(self):
        old, new = archives()
        new['docs/upgrade-note.md'] = (b'new note', False)
        with patch.object(upgrade, 'host_preflight', side_effect=AssertionError('host call')), \
                patch.object(install, 'run', side_effect=AssertionError('host command')), \
                patch.object(install, 'sql', side_effect=AssertionError('SQL')):
            result = make_plan(old, new)
        self.assertFalse(result['hostValidated'])
        self.assertEqual(result['fromCommit'], BEFORE)
        self.assertEqual(result['commit'], AFTER)
        self.assertEqual(result['changedFiles'], ['backend/read_api.py', 'docs/upgrade-note.md'])
        self.assertEqual(result['unchangedMigrations'], list(install.MIGRATIONS))
        self.assertEqual(set(result['units']), {f'domino-{c}.service' for c in install.SERVICES})
        self.assertTrue(all(AFTER in text and BEFORE not in text for text in result['units'].values()))

    def test_schema_migrations_and_lock_cannot_change_content_mode_or_disappear(self):
        for name in (*install.MIGRATIONS, 'backend/schema.sql', 'backend/requirements-api.lock'):
            for change in ('content', 'mode', 'missing_old', 'missing_new'):
                with self.subTest(name=name, change=change):
                    old, new = archives()
                    if change == 'content':
                        new[name] = (b'changed', False)
                    elif change == 'mode':
                        new[name] = (old[name][0], True)
                    elif change == 'missing_old':
                        del old[name]
                    else:
                        del new[name]
                    with self.assertRaisesRegex(ValueError, 'schema_migration_or_dependency_change'):
                        make_plan(old, new)

    def test_same_commit_is_not_an_upgrade(self):
        old, new = archives()
        with self.assertRaisesRegex(ValueError, 'source_and_destination_must_differ'):
            upgrade.plan(old, new, 'c' * 64, 'd' * 64, BEFORE, BEFORE)

    def test_default_cli_never_enters_host_operations(self):
        old, new = archives()
        output = io.StringIO()
        with patch.object(install, 'archive_files', side_effect=[old, new]), \
                patch.object(upgrade, 'host_preflight') as preflight, \
                patch.object(upgrade, 'apply') as apply, \
                patch.object(upgrade, 'rollback') as rollback, contextlib.redirect_stdout(output):
            self.assertEqual(upgrade.main(cli_args()), 0)
        for host_call in (preflight, apply, rollback):
            host_call.assert_not_called()
        self.assertEqual(json.loads(output.getvalue())['mode'], 'disabled-upgrade-plan')


def cli_args():
    return ['--from-archive', '/synthetic/before.tar', '--from-archive-sha256', 'c' * 64,
            '--from-commit', BEFORE, '--archive', '/synthetic/after.tar',
            '--archive-sha256', 'd' * 64, '--commit', AFTER]


class RuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / 'old'
        self.account = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        self.enterContext(patch.object(upgrade.pwd, 'getpwnam', return_value=self.account))
        if not hasattr(os, 'listxattr'):
            # Python exposes this Linux syscall only on the host target.
            self.enterContext(patch.object(os, 'listxattr', return_value=[], create=True))
        populate_runtime(self.root)

    def test_all_seven_complete_trees_round_trip_including_nested_locks_and_reports(self):
        original = upgrade.runtime_snapshot(self.root)
        target = Path(self.temp.name) / 'target'
        for component in install.ROOTS:
            runtime = target / component / 'backend/runtime'
            runtime.mkdir(mode=0o700, parents=True)
            make_file(runtime / 'catalogue-db.json', b'{}')
        upgrade.copy_runtime(original, target)
        self.assertEqual(upgrade.runtime_snapshot(target), original)
        self.assertEqual(set(original), set(install.ROOTS))
        for entries in original.values():
            self.assertEqual(set(entries), {'.', 'catalogue-db.json', 'provider.json', 'locks',
                'locks/nested', 'locks/nested/lease', 'reports', 'reports/checkpoint.json', 'empty'})
            self.assertEqual(entries['reports/checkpoint.json'][0], 0o644)
            self.assertEqual(entries['reports/checkpoint.json'][3], b'{"revision":2}\n')
            self.assertEqual(entries['locks/nested/lease'][3], b'lease\x00bytes')
        self.assertEqual(upgrade.runtime_snapshot(self.root), original, 'Copy must preserve its source.')

    def test_private_backup_preserves_every_byte_and_restricts_report_modes(self):
        original = upgrade.runtime_snapshot(self.root)
        backup = Path(self.temp.name) / 'backup'
        backup.mkdir(mode=0o700)
        # Root ownership is a host boundary; file creation, modes and bytes are real.
        with patch.object(install.os, 'fchown') as ownership:
            upgrade.copy_runtime(original, backup, backup=True)
        for component, entries in original.items():
            for name, (_, _, _, payload) in entries.items():
                path = backup / component if name == '.' else backup / component / name
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o700 if payload is None else 0o600)
                if payload is not None:
                    self.assertEqual(path.read_bytes(), payload)
        self.assertTrue(ownership.called)
        self.assertTrue(all(call.args[1:] == (0, 0) for call in ownership.call_args_list))

    def test_target_runtime_with_extra_state_is_never_merged_or_deleted(self):
        target = Path(self.temp.name) / 'target'
        runtime = target / install.ROOTS[0] / 'backend/runtime'
        runtime.mkdir(mode=0o700, parents=True)
        make_file(runtime / 'catalogue-db.json', b'{}')
        make_file(runtime / 'unexpected', PRIVATE.encode())
        with self.assertRaisesRegex(ValueError, 'new_runtime_not_empty'):
            upgrade.copy_runtime(upgrade.runtime_snapshot(self.root), target)
        self.assertEqual((runtime / 'unexpected').read_bytes(), PRIVATE.encode())

    def test_snapshot_rejects_file_links_hardlinks_and_directory_links(self):
        runtime = self.root / install.ROOTS[0] / 'backend/runtime'
        for kind in ('symlink', 'hardlink', 'directory_link'):
            path = runtime / 'untrusted'
            with self.subTest(kind=kind):
                if kind == 'hardlink':
                    os.link(runtime / 'provider.json', path)
                else:
                    path.symlink_to(runtime / ('locks' if kind == 'directory_link' else 'provider.json'))
                try:
                    with self.assertRaises(ValueError):
                        upgrade.runtime_snapshot(self.root)
                finally:
                    path.unlink()

    def test_snapshot_rejects_executable_shared_write_and_nonprivate_directory_modes(self):
        runtime = self.root / install.ROOTS[0] / 'backend/runtime'
        cases = [('provider.json', 0o700), ('provider.json', 0o620), ('provider.json', 0o602),
                 ('locks', 0o755), ('locks/nested', 0o770), ('catalogue-db.json', 0o644)]
        for name, mode in cases:
            path = runtime / name
            previous = stat.S_IMODE(path.stat().st_mode)
            with self.subTest(name=name, mode=oct(mode)):
                path.chmod(mode)
                try:
                    with self.assertRaises(ValueError):
                        upgrade.runtime_snapshot(self.root)
                finally:
                    path.chmod(previous)

    def test_snapshot_rejects_wrong_owner_descriptor_or_aggregate_size(self):
        runtime = self.root / install.ROOTS[0] / 'backend/runtime'
        with patch.object(upgrade.pwd, 'getpwnam', return_value=SimpleNamespace(
                pw_uid=os.getuid() + 1, pw_gid=os.getgid())):
            with self.assertRaisesRegex(ValueError, 'runtime_owner_mismatch'):
                upgrade.runtime_snapshot(self.root)
        descriptor = runtime / 'catalogue-db.json'
        original = descriptor.read_bytes()
        make_file(descriptor, b'{"host":"/another/socket","port":8877,"dbname":"domino_catalogue"}')
        with self.assertRaisesRegex(ValueError, 'runtime_descriptor_target_mismatch'):
            upgrade.runtime_snapshot(self.root)
        make_file(descriptor, original)
        with patch.object(upgrade, 'MAX_RUNTIME_BYTES', 1):
            with self.assertRaisesRegex(ValueError, 'file_size_limit'):
                upgrade.runtime_snapshot(self.root)

    def test_snapshot_refuses_extended_attributes_and_excessive_nested_depth(self):
        with patch.object(os, 'listxattr', return_value=['user.synthetic'], create=True):
            with self.assertRaisesRegex(ValueError, 'runtime_extended_attributes_not_supported'):
                upgrade.runtime_snapshot(self.root)
        path = self.root / install.ROOTS[0] / 'backend/runtime'
        for _ in range(33):
            path = path / 'd'
            path.mkdir(mode=0o700)
        with self.assertRaisesRegex(ValueError, 'runtime_depth_limit'):
            upgrade.runtime_snapshot(self.root)

    def test_read_regular_rejects_special_files_without_blocking(self):
        fifo = Path(self.temp.name) / 'fifo'
        os.mkfifo(fifo, 0o600)
        with self.assertRaisesRegex(ValueError, 'regular_single_link_file_required'):
            upgrade.read_regular(fifo, limit=1024)


class UpgradeFlowTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.cleanup_tree)
        self.root = Path(self.temp.name)
        for attr, child in (('BASE', 'opt'), ('BACKUPS', 'backups'), ('UNIT_DIR', 'units')):
            path = self.root / child
            path.mkdir(mode=0o700)
            self.enterContext(patch.object(install, attr, path))
        account = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        self.enterContext(patch.object(upgrade.pwd, 'getpwnam', return_value=account))
        self.enterContext(patch.object(install.os, 'fchown'))
        if not hasattr(os, 'listxattr'):
            self.enterContext(patch.object(os, 'listxattr', return_value=[], create=True))
        self.enterContext(patch.object(upgrade.subprocess, 'Popen', side_effect=AssertionError('unmocked child process')))
        self.enterContext(patch.object(upgrade, 'host_context'))
        self.enterContext(patch.object(upgrade.filesystem, 'protected_parents'))
        original_read = upgrade.read_regular

        def local_read(path, **options):
            # Only translate root ownership to the invoking unprivileged UID.
            # Real type/link/mode/stability/size checks remain in force.
            if options.get('owner') == 0:
                options['owner'] = os.getuid()
            return original_read(path, **options)

        self.enterContext(patch.object(upgrade, 'read_regular', side_effect=local_read))
        self.old, self.new = archives()
        self.planned = make_plan(self.old, self.new)
        install.install_roots(self.old, BEFORE)
        old_root = Path(self.planned['fromRelease'])
        # install_roots already created descriptors; add complete mutable state.
        for component in install.ROOTS:
            runtime = old_root / component / 'backend/runtime'
            make_file(runtime / 'provider.json', (PRIVATE + component).encode())
            (runtime / 'reports').mkdir(mode=0o700)
            make_file(runtime / 'reports' / 'checkpoint.json', b'{"revision":2}\n', 0o644)
        self.snapshot = upgrade.runtime_snapshot(old_root)
        self.units = {f'domino-{c}.service': install.unit_text(c, BEFORE).encode() for c in install.SERVICES}
        for name, content in self.units.items():
            make_file(install.UNIT_DIR / name, content, 0o644)
        self.enterContext(patch.object(upgrade, 'host_preflight', return_value=(
            self.units, {'commit': BEFORE, 'migrationsCommitted': list(install.MIGRATIONS)}, self.snapshot)))
        self.source_check = self.enterContext(patch.object(upgrade, 'verify_source'))
        self.role_check = self.enterContext(patch.object(upgrade, 'verify_roles'))
        self.host_run = self.enterContext(patch.object(install, 'run', side_effect=self.host_command))
        self.sql = self.enterContext(patch.object(install, 'sql', side_effect=self.readonly_sql))
        self.dump_digests = {}
        self.dump = self.enterContext(patch.object(upgrade, 'dump_database', side_effect=self.dump_database))
        self.phases = []
        original_journal = upgrade.journal

        def recording_journal(directory, state):
            original_journal(directory, state)
            self.phases.append(copy.deepcopy(state))

        self.journal = self.enterContext(patch.object(upgrade, 'journal', side_effect=recording_journal))

    def cleanup_tree(self):
        # The real release installer makes source directories immutable to users.
        for directory, _, _ in os.walk(self.temp.name):
            Path(directory).chmod(0o700)
        self.temp.cleanup()

    def host_command(self, argv, **options):
        if argv[:2] == ['/usr/bin/systemctl', 'show']:
            name = argv[2]
            return ('ActiveState=inactive\nSubState=dead\nMainPID=0\nControlPID=0\n'
                    f'UnitFileState=static\nFragmentPath={install.UNIT_DIR / name}\n'
                    'DropInPaths=\nNeedDaemonReload=no\nTriggeredBy=\nTriggers=\n'
                    'WantedBy=\nRequiredBy=\nUpheldBy=\nBoundBy=\nOnSuccessOf=\nOnFailureOf=\n').encode()
        if argv in (['/usr/bin/systemctl', mode, '--all', '--no-legend', '--no-pager']
                    for mode in ('list-units', 'list-unit-files')):
            return b''
        if argv == ['/usr/bin/systemctl', 'list-jobs', '--no-legend', '--no-pager']:
            return b''
        if argv == ['/usr/bin/ps', '-e', '-o', 'uid=']:
            return b''
        if argv == ['/usr/bin/ss', '-H', '-ltn']:
            return b''
        if argv == ['/usr/bin/systemctl', 'daemon-reload']:
            return b''
        if argv[:2] == ['/usr/bin/systemd-analyze', 'verify']:
            self.assertIn(set(argv[2:]), (
                {str(install.UNIT_DIR / name) for name in self.units},
                {str(Path(self.planned['backup']) / 'candidates' / name) for name in self.units}))
            return b''
        raise AssertionError('Forbidden host operation: ' + str(argv))

    def readonly_sql(self, query, **options):
        self.assertTrue(query.startswith('SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity '))
        self.assertEqual(options, {})
        return '0'

    def dump_database(self, path):
        digest = self.dump_digests.get(path.name, 'same-database')
        install.exclusive_file(path, ('synthetic dump ' + digest).encode())
        return digest

    def state(self):
        return json.loads((Path(self.planned['backup']) / 'upgrade-state.json').read_text())

    def unit_versions(self):
        return [(install.UNIT_DIR / name).read_bytes() for name in self.units]

    def assert_no_start_or_database_write(self):
        self.assertTrue(self.sql.called)
        for call in self.host_run.call_args_list:
            argv = call.args[0]
            if argv[0] == '/usr/bin/systemctl':
                self.assertIn(argv[1], ('show', 'daemon-reload', 'list-units', 'list-unit-files', 'list-jobs'))
        self.assertEqual(upgrade.runtime_snapshot(Path(self.planned['fromRelease'])), self.snapshot)

    def test_apply_and_rollback_preserve_database_runtime_and_disabled_state(self):
        result = upgrade.apply(self.old, self.new, self.planned)
        self.assertTrue(result['ok'])
        self.assertFalse(result['servicesStarted'])
        self.assertFalse(result['servicesEnabled'])
        self.assertEqual(self.state()['phase'], 'complete')
        self.assertEqual([row['phase'] for row in self.phases],
                         ['backed_up', 'staged', *(['switching'] * (len(self.units) + 1)), 'complete'])
        self.assertTrue(all(AFTER.encode() in content for content in self.unit_versions()))
        target = Path(self.planned['target'])
        self.assertEqual(upgrade.runtime_snapshot(target), self.snapshot)
        result = upgrade.rollback(self.old, self.new, self.planned)
        self.assertTrue(result['ok'])
        self.assertFalse(result['servicesStarted'])
        self.assertFalse(result['databaseRestored'])
        self.assertEqual(self.unit_versions(), list(self.units.values()))
        self.assertEqual(self.state()['phase'], 'rolled_back')
        self.assertTrue(target.exists(), 'Rollback preserves target evidence.')
        self.assertEqual(upgrade.runtime_snapshot(target), self.snapshot)
        self.assert_no_start_or_database_write()

    def test_database_change_before_switch_keeps_old_units_and_blocks_rollback(self):
        self.dump_digests['database-preswitch.sql'] = 'changed-database'
        with self.assertRaisesRegex(ValueError, 'database_changed_before_switch'):
            upgrade.apply(self.old, self.new, self.planned)
        self.assertEqual(self.state()['phase'], 'staged')
        self.assertEqual(self.unit_versions(), list(self.units.values()))
        with patch.object(upgrade, 'dump_database', return_value='changed-database'):
            with self.assertRaisesRegex(ValueError, 'rollback_database_changed'):
                upgrade.rollback(self.old, self.new, self.planned)
        self.assertEqual(self.unit_versions(), list(self.units.values()))
        self.assert_no_start_or_database_write()

    def test_database_change_after_switch_never_writes_success_receipt(self):
        self.dump_digests['database-after.sql'] = 'changed-database'
        with self.assertRaisesRegex(ValueError, 'database_changed_after_switch'):
            upgrade.apply(self.old, self.new, self.planned)
        self.assertEqual(self.state()['phase'], 'switching')
        self.assertFalse((Path(self.planned['backup']) / 'installed.json').exists())
        self.assertTrue(all(AFTER.encode() in content for content in self.unit_versions()))
        self.assert_no_start_or_database_write()

    def test_partial_switch_can_roll_back_exact_old_and_new_units(self):
        replace = upgrade.replace_unit
        count = 0

        def interrupted(path, content):
            nonlocal count
            count += 1
            if count == 3:
                raise OSError('synthetic switch interruption')
            replace(path, content)

        with patch.object(upgrade, 'replace_unit', side_effect=interrupted):
            with self.assertRaises(OSError):
                upgrade.apply(self.old, self.new, self.planned)
        self.assertEqual(self.state()['phase'], 'switching')
        self.assertEqual(len(self.state()['unitsWritten']), 2)
        self.assertEqual(sum(AFTER.encode() in body for body in self.unit_versions()), 2)
        upgrade.rollback(self.old, self.new, self.planned)
        self.assertEqual(self.unit_versions(), list(self.units.values()))
        self.assertEqual(self.state()['phase'], 'rolled_back')
        self.assert_no_start_or_database_write()

    def test_fault_before_staging_is_rollbackable_without_a_target_release(self):
        with patch.object(install, 'install_roots', side_effect=OSError('synthetic extraction failure')):
            with self.assertRaises(OSError):
                upgrade.apply(self.old, self.new, self.planned)
        self.assertEqual(self.state()['phase'], 'backed_up')
        self.assertFalse(Path(self.planned['target']).exists())
        upgrade.rollback(self.old, self.new, self.planned)
        self.assertEqual(self.state()['phase'], 'rolled_back')
        self.assertEqual(self.unit_versions(), list(self.units.values()))
        self.assert_no_start_or_database_write()

    def test_interrupted_rollback_of_unstaged_release_can_resume(self):
        with patch.object(install, 'install_roots', side_effect=OSError('synthetic extraction failure')):
            with self.assertRaises(OSError):
                upgrade.apply(self.old, self.new, self.planned)
        with patch.object(upgrade, 'replace_unit', side_effect=OSError('synthetic rollback interruption')):
            with self.assertRaises(OSError):
                upgrade.rollback(self.old, self.new, self.planned)
        self.assertEqual(self.state()['phase'], 'rolling_back')
        self.assertFalse(Path(self.planned['target']).exists())
        upgrade.rollback(self.old, self.new, self.planned)
        self.assertEqual(self.state()['phase'], 'rolled_back')
        self.assertEqual(self.unit_versions(), list(self.units.values()))
        self.assert_no_start_or_database_write()

    def test_crash_after_unit_temporary_write_is_rollbackable(self):
        original_replace = os.replace
        first = install.UNIT_DIR / next(iter(self.units))

        def crash_at_unit_rename(source, target):
            if target == first:
                raise OSError('synthetic interruption before unit rename')
            return original_replace(source, target)

        with patch.object(os, 'replace', side_effect=crash_at_unit_rename):
            with self.assertRaises(OSError):
                upgrade.apply(self.old, self.new, self.planned)
        temporary = first.with_name(first.name + '.disabled-upgrade-next')
        self.assertTrue(temporary.exists())
        self.assertIn(AFTER.encode(), temporary.read_bytes())
        self.assertEqual(self.unit_versions(), list(self.units.values()))
        self.assertEqual(self.state()['phase'], 'switching')
        upgrade.rollback(self.old, self.new, self.planned)
        self.assertFalse(temporary.exists())
        self.assertEqual(self.unit_versions(), list(self.units.values()))
        self.assertEqual(self.state()['phase'], 'rolled_back')
        self.assert_no_start_or_database_write()

    def test_crash_after_unit_rename_before_journal_update_uses_actual_unit_bytes(self):
        persist = self.journal.side_effect

        def crash_before_record(directory, state):
            if state['phase'] == 'switching' and len(state['unitsWritten']) == 2:
                raise OSError('synthetic interruption after second rename')
            return persist(directory, state)

        with patch.object(upgrade, 'journal', side_effect=crash_before_record):
            with self.assertRaises(OSError):
                upgrade.apply(self.old, self.new, self.planned)
        self.assertEqual(len(self.state()['unitsWritten']), 1)
        self.assertEqual(sum(AFTER.encode() in body for body in self.unit_versions()), 2)
        upgrade.rollback(self.old, self.new, self.planned)
        self.assertEqual(self.unit_versions(), list(self.units.values()))
        self.assertEqual(self.state()['phase'], 'rolled_back')
        self.assert_no_start_or_database_write()

    def test_source_fsync_failure_stops_before_switch_and_preserves_rollback(self):
        synchronize = upgrade.sync_tree
        target = Path(self.planned['target'])

        def fail_source_fsync(path):
            if path == target:
                raise OSError('synthetic source fsync failure')
            return synchronize(path)

        with patch.object(upgrade, 'sync_tree', side_effect=fail_source_fsync):
            with self.assertRaises(OSError):
                upgrade.apply(self.old, self.new, self.planned)
        self.assertEqual(self.state()['phase'], 'backed_up')
        self.assertFalse(self.state()['targetStaged'])
        self.assertTrue(target.exists())
        self.assertEqual(self.unit_versions(), list(self.units.values()))
        upgrade.rollback(self.old, self.new, self.planned)
        self.assertEqual(self.state()['phase'], 'rolled_back')
        self.assert_no_start_or_database_write()

    def test_stopped_unit_guard_refuses_running_enabled_override_and_trigger_states(self):
        baseline = self.host_command
        changes = {'ActiveState': 'active', 'SubState': 'running', 'MainPID': '42',
                   'ControlPID': '43', 'UnitFileState': 'enabled', 'FragmentPath': '/unreviewed',
                   'DropInPaths': '/unreviewed.conf', 'NeedDaemonReload': 'yes',
                   'TriggeredBy': 'domino.timer', 'Triggers': 'domino.socket',
                   'WantedBy': 'multi-user.target', 'RequiredBy': 'another.service',
                   'UpheldBy': 'another.service', 'BoundBy': 'another.service',
                   'OnSuccessOf': 'another.service', 'OnFailureOf': 'another.service'}
        for key, value in changes.items():
            with self.subTest(property=key):
                def changed(argv, **options):
                    payload = baseline(argv, **options)
                    if argv[:2] == ['/usr/bin/systemctl', 'show']:
                        props = dict(row.split('=', 1) for row in payload.decode().splitlines())
                        props[key] = value
                        return ''.join(k + '=' + v + '\n' for k, v in props.items()).encode()
                    return payload
                with patch.object(install, 'run', side_effect=changed):
                    with self.assertRaises(ValueError):
                        upgrade.stopped_units([BEFORE])

    def test_stopped_unit_guard_refuses_unknown_units_manual_processes_and_listeners(self):
        baseline = self.host_command
        cases = [(['/usr/bin/systemctl', 'list-jobs', '--no-legend', '--no-pager'],
                  b'42 domino-read.service start waiting\n', 'pending_domino_job'),
                 (['/usr/bin/systemctl', 'list-unit-files', '--all', '--no-legend', '--no-pager'],
                  b'domino-extra.timer enabled enabled\n', 'unexpected_domino_unit_or_trigger'),
                 (['/usr/bin/systemctl', 'list-units', '--all', '--no-legend', '--no-pager'],
                  b'domino-extra.socket loaded active listening Extra\n', 'unexpected_domino_unit_or_trigger'),
                 (['/usr/bin/ps', '-e', '-o', 'uid='], str(os.getuid()).encode(), 'service_uid_process_present')]
        cases += [(['/usr/bin/ss', '-H', '-ltn'],
                   f'LISTEN 0 128 127.0.0.1:{port} 0.0.0.0:*\n'.encode(), 'application_listener_present')
                  for port in (8876, 8878, 8879, 8880, 8881)]
        for command, payload, reason in cases:
            with self.subTest(command=command, payload=payload):
                def changed(argv, **options):
                    return payload if argv == command else baseline(argv, **options)
                with patch.object(install, 'run', side_effect=changed):
                    with self.assertRaisesRegex(ValueError, reason):
                        upgrade.stopped_units([BEFORE])
        with patch.object(install, 'sql', return_value='1'):
            with self.assertRaisesRegex(ValueError, 'other_database_clients_present'):
                upgrade.stopped_units([BEFORE])

    def test_runtime_change_or_unknown_unit_blocks_rollback_without_replacement(self):
        upgrade.apply(self.old, self.new, self.planned)
        original = self.unit_versions()
        target_provider = Path(self.planned['target']) / install.ROOTS[0] / 'backend/runtime/provider.json'
        provider_bytes = target_provider.read_bytes()
        make_file(target_provider, b'changed-runtime')
        with self.assertRaisesRegex(ValueError, 'rollback_target_runtime_changed'):
            upgrade.rollback(self.old, self.new, self.planned)
        self.assertEqual(self.unit_versions(), original)
        make_file(target_provider, provider_bytes)
        first_unit = install.UNIT_DIR / next(iter(self.units))
        make_file(first_unit, b'[Service]\nExecStart=/unreviewed\n', 0o644)
        with patch.object(upgrade, 'replace_unit') as replace:
            with self.assertRaisesRegex(ValueError, 'unit_not_an_exact_disabled_template'):
                upgrade.rollback(self.old, self.new, self.planned)
        replace.assert_not_called()
        self.assert_no_start_or_database_write()

    def test_rollback_rejects_tampered_saved_plan_and_unsupported_journal(self):
        upgrade.apply(self.old, self.new, self.planned)
        directory = Path(self.planned['backup'])
        path = directory / 'plan.json'
        saved = path.read_bytes()
        value = json.loads(saved)
        value['fromCommit'] = 'e' * 40
        make_file(path, json.dumps(value).encode())
        with self.assertRaisesRegex(ValueError, 'rollback_plan_mismatch'):
            upgrade.rollback(self.old, self.new, self.planned)
        make_file(path, saved)
        state = self.state()
        state['phase'] = 'unrecognized'
        make_file(directory / 'upgrade-state.json', json.dumps(state).encode())
        with self.assertRaisesRegex(ValueError, 'rollback_state_not_supported'):
            upgrade.rollback(self.old, self.new, self.planned)
        self.assertTrue(all(AFTER.encode() in content for content in self.unit_versions()))
        self.assert_no_start_or_database_write()


class FoundationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.config = self.root / 'config'
        self.data = self.root / 'data'
        self.socket = self.root / 'socket'
        for path in (self.config, self.data, self.socket):
            path.mkdir(mode=0o700)
        self.enterContext(patch.object(install, 'CONFIG', self.config))
        self.enterContext(patch.object(install, 'DATA', self.data))
        self.enterContext(patch.object(install, 'SOCKET', str(self.socket)))
        self.parents = self.enterContext(patch.object(install, 'pg_parents'))
        account = SimpleNamespace(pw_uid=os.getuid(), pw_gid=os.getgid())
        self.enterContext(patch.object(upgrade.pwd, 'getpwnam', return_value=account))
        self.enterContext(patch.object(upgrade.grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=os.getgid())))
        self.enterContext(patch.object(install, 'run', side_effect=AssertionError('host command')))
        self.enterContext(patch.object(upgrade.subprocess, 'Popen', side_effect=AssertionError('host process')))
        self.auth_rows = {
            'pg_hba.conf': (*install.HBA[:6], ('local', install.DB, install.DEPOSIT, 'peer', 'map=domino'),
                            *install.HBA[6:]),
            'pg_ident.conf': (*install.MAPPINGS, *install.NEW_MAPPINGS),
        }
        for name, rows in self.auth_rows.items():
            make_file(self.config / name, ''.join(' '.join(row) + '\n' for row in rows).encode())
        self.settings = {'server_version_num': '160013', 'server_encoding': 'UTF8',
            'data_directory': str(self.data), 'config_file': str(self.config / 'postgresql.conf'),
            'hba_file': str(self.config / 'pg_hba.conf'), 'ident_file': str(self.config / 'pg_ident.conf'),
            'port': '8877', 'listen_addresses': '', 'unix_socket_directories': str(self.socket),
            'unix_socket_permissions': '0770', 'unix_socket_group': 'domino-db'}
        self.database_utf8, self.pending_restart, self.auth_errors = 't', '0', '0'
        self.sql = self.enterContext(patch.object(install, 'sql', side_effect=self.readonly_sql))
        self.socket_metadata = {
            self.socket: SimpleNamespace(st_mode=stat.S_IFDIR | 0o750, st_uid=os.getuid(), st_gid=os.getgid()),
            self.socket / '.s.PGSQL.8877': SimpleNamespace(
                st_mode=stat.S_IFSOCK | 0o770, st_uid=os.getuid(), st_gid=os.getgid()),
        }
        original_lstat = Path.lstat

        def local_lstat(path):
            if path in self.socket_metadata:
                return self.socket_metadata[path]
            return original_lstat(path)

        # Socket ownership/type are OS-boundary reports. Auth files are real and
        # retain read_regular's type, single-link, mode and stable-read checks.
        self.enterContext(patch.object(Path, 'lstat', local_lstat))

    def readonly_sql(self, query, **options):
        self.assertEqual(options, {})
        if query.startswith('SELECT pg_catalog.json_object_agg(name,setting) FROM pg_catalog.pg_settings '):
            return json.dumps(self.settings)
        if query.startswith("SELECT pg_catalog.pg_encoding_to_char(encoding)='UTF8' "):
            return self.database_utf8
        if query == 'SELECT pg_catalog.count(*) FROM pg_catalog.pg_settings WHERE pending_restart':
            return self.pending_restart
        if query in ('SELECT pg_catalog.count(*) FROM pg_catalog.pg_hba_file_rules WHERE error IS NOT NULL',
                     'SELECT pg_catalog.count(*) FROM pg_catalog.pg_ident_file_mappings WHERE error IS NOT NULL'):
            return self.auth_errors
        raise AssertionError('Unexpected SQL: ' + query)

    def test_actual_foundation_guard_accepts_only_the_expected_private_pg16_shape(self):
        upgrade.foundation_preflight()
        self.assertEqual([call.args for call in self.parents.call_args_list], [(self.config,), (self.data,)])
        self.assertEqual(self.sql.call_count, 5)
        self.assertTrue(all(call.args[0].startswith('SELECT ') for call in self.sql.call_args_list))

    def test_foundation_refuses_listening_path_encoding_port_version_or_socket_setting_drift(self):
        changes = {'server_version_num': '170001', 'server_encoding': 'SQL_ASCII',
            'data_directory': '/unreviewed/data', 'config_file': '/unreviewed/postgresql.conf',
            'hba_file': '/unreviewed/pg_hba.conf', 'ident_file': '/unreviewed/pg_ident.conf',
            'port': '5432', 'listen_addresses': '*', 'unix_socket_directories': '/tmp',
            'unix_socket_permissions': '0777', 'unix_socket_group': 'another-group'}
        for key, value in changes.items():
            previous = self.settings[key]
            with self.subTest(setting=key):
                self.settings[key] = value
                try:
                    with self.assertRaisesRegex(ValueError, 'postgres_foundation_changed'):
                        upgrade.foundation_preflight()
                finally:
                    self.settings[key] = previous

    def test_foundation_refuses_non_utf8_database_pending_restart_and_invalid_auth_views(self):
        for attribute, value, reason in (
                ('database_utf8', 'f', 'database_must_be_UTF8'),
                ('pending_restart', '1', 'postgres_pending_restart'),
                ('auth_errors', '1', 'invalid pg_hba_file_rules')):
            previous = getattr(self, attribute)
            with self.subTest(attribute=attribute):
                setattr(self, attribute, value)
                try:
                    with self.assertRaisesRegex(ValueError, reason):
                        upgrade.foundation_preflight()
                finally:
                    setattr(self, attribute, previous)

    def test_foundation_refuses_changed_peer_mappings_and_nonprivate_auth_file(self):
        for name in self.auth_rows:
            path = self.config / name
            original = path.read_bytes()
            with self.subTest(name=name):
                make_file(path, original + b'host all all 0.0.0.0/0 trust\n')
                with self.assertRaisesRegex(ValueError, 'postgres_auth_foundation_changed'):
                    upgrade.foundation_preflight()
                make_file(path, original, 0o644)
                with self.assertRaisesRegex(ValueError, 'unexpected_file_mode'):
                    upgrade.foundation_preflight()
                make_file(path, original)

    def test_foundation_refuses_socket_directory_or_inode_type_owner_group_mode_drift(self):
        for path, original in list(self.socket_metadata.items()):
            for attribute, value in (('st_mode', stat.S_IFREG | 0o770), ('st_mode', original.st_mode ^ 0o002),
                                     ('st_uid', os.getuid() + 1), ('st_gid', os.getgid() + 1)):
                with self.subTest(path=path.name, attribute=attribute, value=value):
                    changed = copy.copy(original)
                    setattr(changed, attribute, value)
                    self.socket_metadata[path] = changed
                    try:
                        with self.assertRaisesRegex(ValueError, 'postgres_socket_changed'):
                            upgrade.foundation_preflight()
                    finally:
                        self.socket_metadata[path] = original


class HostPreflightTests(unittest.TestCase):
    def test_existing_target_or_backup_refuses_before_unit_source_role_or_runtime_access(self):
        with tempfile.TemporaryDirectory() as folder:
            old, new = archives()
            for existing in ('target', 'backup'):
                with self.subTest(existing=existing):
                    planned = make_plan(old, new)
                    planned['target'] = str(Path(folder) / (existing + '-target'))
                    planned['backup'] = str(Path(folder) / (existing + '-backup'))
                    Path(planned[existing]).mkdir()
                    with patch.object(upgrade, 'host_context') as context, \
                            patch.object(upgrade, 'stopped_units') as units, \
                            patch.object(upgrade, 'receipt') as receipt, \
                            patch.object(upgrade, 'verify_source') as source, \
                            patch.object(upgrade, 'verify_roles') as roles, \
                            patch.object(upgrade, 'runtime_snapshot') as runtime:
                        with self.assertRaisesRegex(ValueError, 'destination_' + ('release' if existing == 'target' else 'backup') + '_exists'):
                            upgrade.host_preflight(old, new, planned)
                    context.assert_called_once_with(new)
                    for call in (units, receipt, source, roles, runtime):
                        call.assert_not_called()

    def test_host_preflight_checks_old_receipt_source_roles_and_runtime_before_returning(self):
        with tempfile.TemporaryDirectory() as folder:
            old, new = archives()
            planned = make_plan(old, new)
            planned['target'], planned['backup'] = str(Path(folder) / 'target'), str(Path(folder) / 'backup')
            with patch.object(upgrade, 'host_context') as context, \
                    patch.object(upgrade, 'stopped_units', return_value={'unit': b'old'}) as units, \
                    patch.object(upgrade, 'receipt', return_value={'commit': BEFORE}) as receipt, \
                    patch.object(upgrade, 'verify_source') as source, \
                    patch.object(upgrade, 'verify_roles') as roles, \
                    patch.object(upgrade, 'runtime_snapshot', return_value={'runtime': 'private'}) as runtime:
                result = upgrade.host_preflight(old, new, planned)
            context.assert_called_once_with(new)
            units.assert_called_once_with([BEFORE])
            receipt.assert_called_once_with(planned)
            source.assert_called_once_with(Path(planned['fromRelease']), old)
            roles.assert_called_once_with()
            runtime.assert_called_once_with(Path(planned['fromRelease']))
            self.assertEqual(result, ({'unit': b'old'}, {'commit': BEFORE}, {'runtime': 'private'}))


class PublicDiagnosticTests(unittest.TestCase):
    def test_unexpected_errors_never_expose_private_diagnostics(self):
        for error in (ValueError(PRIVATE), OSError(PRIVATE), RuntimeError(PRIVATE),
                      KeyError(PRIVATE), TypeError(PRIVATE)):
            with self.subTest(kind=type(error).__name__):
                output = io.StringIO()
                with patch.object(install, 'archive_files', side_effect=error), contextlib.redirect_stdout(output):
                    self.assertEqual(upgrade.main(cli_args()), 1)
                result = json.loads(output.getvalue())
                self.assertFalse(result['ok'])
                self.assertNotIn(PRIVATE, output.getvalue())
                self.assertIn('keep_services_stopped', result['action'])

    def test_nonroot_host_modes_refuse_before_preflight_apply_or_rollback(self):
        for mode in ('--inspect', '--apply', '--rollback'):
            with self.subTest(mode=mode):
                output = io.StringIO()
                old, new = archives()
                with patch.object(install, 'archive_files', side_effect=[old, new]), \
                        patch.object(upgrade.os, 'geteuid', return_value=501), \
                        patch.object(upgrade, 'host_preflight') as preflight, \
                        patch.object(upgrade, 'apply') as apply, \
                        patch.object(upgrade, 'rollback') as rollback, contextlib.redirect_stdout(output):
                    self.assertEqual(upgrade.main([*cli_args(), mode]), 1)
                for host_call in (preflight, apply, rollback):
                    host_call.assert_not_called()
                self.assertNotIn(PRIVATE, output.getvalue())


if __name__ == '__main__':
    unittest.main()
