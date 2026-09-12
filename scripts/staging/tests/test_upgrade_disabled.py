"""Unprivileged upgrade regressions: temporary files and mocked host boundaries."""
import contextlib
import copy
import fcntl
import io
import json
import os
import resource
import signal
import subprocess
from pathlib import Path
import stat
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from test_staging_helpers import FOUNDATION_MIGRATIONS, PACKAGED_MIGRATIONS, packaged_records

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import prepare_disabled as install
import upgrade_disabled as upgrade

EXPECTED_DUMP_ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8',
                     'PGCONNECT_TIMEOUT': '5', 'PGOPTIONS': '-c search_path=pg_catalog',
                     'PYTHONDONTWRITEBYTECODE': '1'}

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


class LocalRootOwnership:
    """Model root/service UID ownership on real unprivileged temporary inodes.

    Bytes, paths, modes, links, descriptor opens and filesystem operations remain
    real. UID/GID changes are recorded instead of requiring local root access.
    Every create checks that all runtime ancestors are still private root dirs.
    """
    def __init__(self, case, roots):
        self.case, self.roots = case, tuple(roots)
        self.owners, self.opened, self.events = {}, {}, []
        self.real_lstat, self.real_fstat = Path.lstat, os.fstat
        self.real_open, self.real_mkdir = os.open, Path.mkdir
        self.real_chown, self.real_fchown = os.chown, os.fchown
        self.stack = contextlib.ExitStack()

    def is_modeled(self, path):
        path = Path(path)
        return any(path == root or root in path.parents for root in self.roots)

    def key(self, info):
        return info.st_dev, info.st_ino

    def metadata(self, info, owner):
        if owner is None:
            return info
        fields = list(info)
        fields[4:6] = owner
        return os.stat_result(fields, {name: getattr(info, name)
                                      for name in ('st_atime_ns', 'st_mtime_ns', 'st_ctime_ns')})

    def lstat(self, path):
        info = self.real_lstat(path)
        owner = self.owners.setdefault(self.key(info), (0, 0)) if self.is_modeled(path) else None
        return self.metadata(info, owner)

    def fstat(self, fd):
        info = self.real_fstat(fd)
        return self.metadata(info, self.owners.get(self.key(info)))

    def private_ancestors(self, path):
        for root in self.roots:
            if path != root and root in path.parents:
                for ancestor in path.parents:
                    info = self.lstat(ancestor)
                    self.case.assertEqual((info.st_uid, info.st_gid), (0, 0),
                                          'A runtime ancestor became service-owned before copy ended.')
                    self.case.assertEqual(stat.S_IMODE(info.st_mode), 0o700)
                    if ancestor == root:
                        break

    def open(self, path, flags, *args, **kwargs):
        path = Path(path)
        if self.is_modeled(path) and flags & os.O_CREAT:
            self.private_ancestors(path)
            self.events.append(('create', path))
        fd = self.real_open(path, flags, *args, **kwargs)
        if self.is_modeled(path):
            self.opened[fd] = path
            self.owners.setdefault(self.key(self.real_fstat(fd)), (0, 0))
        return fd

    def mkdir(self, path, *args, **kwargs):
        if self.is_modeled(path):
            self.private_ancestors(path)
            self.events.append(('mkdir', path))
        result = self.real_mkdir(path, *args, **kwargs)
        if self.is_modeled(path):
            self.owners[self.key(self.real_lstat(path))] = (0, 0)
        return result

    def chown(self, path, uid, gid, *args, **kwargs):
        if not self.is_modeled(path):
            return self.real_chown(path, uid, gid, *args, **kwargs)
        self.case.assertFalse(kwargs.get('follow_symlinks', True))
        self.owners[self.key(self.real_lstat(path))] = (uid, gid)
        self.events.append(('chown', Path(path), uid, gid))

    def fchown(self, fd, uid, gid):
        key = self.key(self.real_fstat(fd))
        if key not in self.owners:
            return self.real_fchown(fd, uid, gid)
        self.owners[key] = (uid, gid)
        self.events.append(('fchown', self.opened[fd], uid, gid))

    def __enter__(self):
        self.stack.enter_context(patch.object(Path, 'lstat', lambda path: self.lstat(path)))
        # Path methods require descriptor binding; wrapping through a closure
        # keeps the real Path instance as the first argument.
        self.stack.enter_context(patch.object(Path, 'mkdir', lambda path, *a, **k: self.mkdir(path, *a, **k)))
        self.stack.enter_context(patch.object(os, 'fstat', side_effect=self.fstat))
        self.stack.enter_context(patch.object(os, 'open', side_effect=self.open))
        self.stack.enter_context(patch.object(os, 'chown', side_effect=self.chown))
        self.stack.enter_context(patch.object(os, 'fchown', side_effect=self.fchown))
        return self

    def __exit__(self, *args):
        return self.stack.__exit__(*args)


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

    def test_optional_sql_additions_changes_and_removal_are_only_package_changes(self):
        self.assertEqual(install.MIGRATIONS, FOUNDATION_MIGRATIONS)
        subsets = ((), PACKAGED_MIGRATIONS[:1], PACKAGED_MIGRATIONS[1:], PACKAGED_MIGRATIONS)
        for before in subsets:
            for after in subsets:
                with self.subTest(before=before, after=after), \
                        patch.object(install, 'run', side_effect=AssertionError('host command')), \
                        patch.object(install, 'sql', side_effect=AssertionError('SQL')):
                    old, new = archives()
                    old.update({path: (b'old packaged SQL\n', False) for path in before})
                    new.update({path: (b'new packaged SQL\n', False) for path in after})
                    planned = make_plan(old, new)
                    self.assertEqual(planned['unchangedMigrations'], list(FOUNDATION_MIGRATIONS))
                    self.assertEqual(planned['changedFiles'], sorted({'backend/read_api.py', *before, *after}))
                    if before or after:
                        self.assertEqual(planned['fromPackagedOnlyMigrations'], packaged_records(old))
                        self.assertEqual(planned['packagedOnlyMigrations'], packaged_records(new))
                    else:
                        self.assertNotIn('fromPackagedOnlyMigrations', planned)
                        self.assertNotIn('packagedOnlyMigrations', planned)

    def test_receipt_still_requires_exact_foundation_even_when_extra_sql_is_packaged(self):
        planned = make_plan()
        receipt = {'commit': BEFORE, 'migrationsCommitted': list(FOUNDATION_MIGRATIONS)}
        with patch.object(upgrade, 'private_json', return_value=receipt):
            self.assertEqual(upgrade.receipt(planned), receipt)
        for committed in (list(FOUNDATION_MIGRATIONS[:-1]),
                          [*FOUNDATION_MIGRATIONS, PACKAGED_MIGRATIONS[0]],
                          [*FOUNDATION_MIGRATIONS, *PACKAGED_MIGRATIONS]):
            with self.subTest(committed=committed), \
                    patch.object(upgrade, 'private_json', return_value={**receipt, 'migrationsCommitted': committed}):
                with self.assertRaisesRegex(ValueError, '^installed_migration_receipt_mismatch$'):
                    upgrade.receipt(planned)

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
        self.enterContext(patch.object(upgrade.filesystem, 'protected_parents'))
        target = Path(self.temp.name) / 'target'
        self.ownership = self.enterContext(LocalRootOwnership(self,
            (target / component / 'backend/runtime' for component in install.ROOTS)))

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
        for root in self.ownership.roots:
            events = [event for event in self.ownership.events
                      if event[1] == root or root in event[1].parents]
            self.assertEqual(events[-1], ('fchown', root, self.account.pw_uid, self.account.pw_gid))
            handoff = next(i for i, event in enumerate(events)
                           if event[0] == 'fchown' and event[2:] == (self.account.pw_uid, self.account.pw_gid))
            self.assertTrue(all(event[0] not in ('create', 'mkdir') for event in events[handoff:]))


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

    def test_service_owned_target_runtime_is_rejected_before_copy(self):
        target = Path(self.temp.name) / 'target'
        runtime = target / install.ROOTS[0] / 'backend/runtime'
        runtime.mkdir(mode=0o700, parents=True)
        make_file(runtime / 'catalogue-db.json', b'{}')
        self.ownership.chown(runtime, self.account.pw_uid, self.account.pw_gid, follow_symlinks=False)
        with self.assertRaisesRegex(ValueError, 'new_runtime_must_be_root_private'):
            upgrade.copy_runtime(upgrade.runtime_snapshot(self.root), target)
        self.assertEqual((runtime / 'catalogue-db.json').read_bytes(), b'{}')

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
                 ('provider.json', 0o4644), ('provider.json', 0o2644), ('provider.json', 0o1644),
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
            translate = options.get('owner') == 0 and not (hasattr(self, 'ownership')
                    and self.ownership.is_modeled(path))
            if translate:
                options['owner'] = os.getuid()
            result = original_read(path, **options)
            if translate and options.get('return_stat'):
                payload, info = result
                fields = list(info)
                fields[4:6] = (0, 0)
                info = os.stat_result(fields, {name: getattr(info, name)
                    for name in ('st_atime_ns', 'st_mtime_ns', 'st_ctime_ns')})
                return payload, info
            return result

        self.enterContext(patch.object(upgrade, 'read_regular', side_effect=local_read))
        self.old, self.new = archives()
        self.planned = make_plan(self.old, self.new)
        self.ownership = self.enterContext(LocalRootOwnership(self,
            (Path(self.planned['target']) / c / 'backend/runtime' for c in install.ROOTS)))
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
        self.actual_preflight = upgrade.host_preflight
        self.enterContext(patch.object(upgrade, 'host_preflight', return_value=(
            self.units, {'commit': BEFORE, 'migrationsCommitted': list(install.MIGRATIONS)}, self.snapshot)))
        self.source_check = self.enterContext(patch.object(upgrade, 'verify_source'))
        self.role_check = self.enterContext(patch.object(upgrade, 'verify_roles'))
        self.space = self.enterContext(patch.object(upgrade, 'space_preflight'))
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
        transitions = [row['phase'] for index, row in enumerate(self.phases)
                       if index == 0 or row['phase'] != self.phases[index - 1]['phase']]
        self.assertEqual(transitions, ['backed_up', 'staged', 'switching', 'complete'])
        self.assertEqual(self.state()['lastStep'], 'complete')
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

    def test_upgrade_packages_optional_sql_without_applying_or_recording_it_as_committed(self):
        sentinel = b"DO $$ BEGIN RAISE EXCEPTION 'PACKAGED_SQL_MUST_NOT_RUN'; END $$;\n"
        self.new.update({path: (sentinel, False) for path in PACKAGED_MIGRATIONS})
        self.planned = make_plan(self.old, self.new)
        result = upgrade.apply(self.old, self.new, self.planned)
        self.assertTrue(result['ok'])
        receipt = json.loads((Path(self.planned['backup']) / 'installed.json').read_text())
        self.assertEqual(receipt['migrationsCommitted'], list(FOUNDATION_MIGRATIONS))
        self.assertIs(receipt['migrationsReapplied'], False)
        self.assertEqual(receipt['packagedOnlyMigrations'], packaged_records(self.new))
        self.assertTrue(receipt['databasePreserved'])
        self.assertTrue(receipt['runtimePreserved'])
        for component in install.ROOTS:
            for name in PACKAGED_MIGRATIONS:
                path = Path(self.planned['target']) / component / name
                self.assertEqual(path.read_bytes(), sentinel)
                self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o444)
        self.assertTrue(all('PACKAGED_SQL_MUST_NOT_RUN' not in call.args[0] for call in self.sql.call_args_list))
        self.assertTrue(upgrade.rollback(self.old, self.new, self.planned)['ok'])
        self.assertEqual(self.unit_versions(), list(self.units.values()))
        self.assert_no_start_or_database_write()

    def test_legacy_saved_plan_without_package_metadata_still_rolls_back(self):
        # This is the plan shape saved by the prior helper. Empty new metadata
        # would break rollback's exact saved_plan == planned comparison.
        legacy = {key: value for key, value in self.planned.items()
                  if key not in ('fromPackagedOnlyMigrations', 'packagedOnlyMigrations')}
        self.assertEqual(self.planned, legacy)
        upgrade.apply(self.old, self.new, self.planned)
        directory = Path(self.planned['backup'])
        make_file(directory / 'plan.json', json.dumps(legacy).encode())
        receipt = json.loads((directory / 'installed.json').read_text())
        self.assertNotIn('packagedOnlyMigrations', receipt)
        recomputed = make_plan(self.old, self.new)
        self.assertEqual(json.dumps(recomputed, sort_keys=True), json.dumps(legacy, sort_keys=True))
        self.assertTrue(upgrade.rollback(self.old, self.new, recomputed)['ok'])
        self.assertEqual(self.unit_versions(), list(self.units.values()))
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


    def test_rolled_back_is_terminal_and_rerun_does_not_touch_units_or_dump(self):
        upgrade.apply(self.old, self.new, self.planned)
        upgrade.rollback(self.old, self.new, self.planned)
        self.assertEqual(self.state()['phase'], 'rolled_back')
        before = self.unit_versions()
        with patch.object(upgrade, 'replace_unit') as replace, \
                patch.object(upgrade, 'dump_database') as dump:
            with self.assertRaisesRegex(ValueError, 'rollback_state_not_supported'):
                upgrade.rollback(self.old, self.new, self.planned)
        replace.assert_not_called()
        dump.assert_not_called()
        self.assertEqual(self.unit_versions(), before)
        with patch.object(upgrade, 'host_preflight', self.actual_preflight), \
                patch.object(upgrade, 'replace_unit') as replace, \
                patch.object(upgrade, 'dump_database') as dump:
            with self.assertRaisesRegex(ValueError, 'destination_release_exists'):
                upgrade.apply(self.old, self.new, self.planned)
        replace.assert_not_called()
        dump.assert_not_called()
        self.assertEqual(self.state()['phase'], 'rolled_back')

    def test_crash_after_installed_receipt_before_complete_can_roll_back(self):
        persist = self.journal.side_effect

        def fail_before_complete(directory, state):
            if state['phase'] == 'complete':
                raise OSError('synthetic receipt-to-complete crash')
            return persist(directory, state)

        with patch.object(upgrade, 'journal', side_effect=fail_before_complete):
            with self.assertRaises(OSError):
                upgrade.apply(self.old, self.new, self.planned)
        receipt = Path(self.planned['backup']) / 'installed.json'
        self.assertEqual(json.loads(receipt.read_text())['commit'], AFTER)
        self.assertEqual(self.state()['phase'], 'switching')
        self.assertTrue(all(AFTER.encode() in row for row in self.unit_versions()))
        upgrade.rollback(self.old, self.new, self.planned)
        self.assertEqual(self.unit_versions(), list(self.units.values()))
        self.assertEqual(self.state()['phase'], 'rolled_back')
        self.assertTrue(receipt.exists(), 'Historical receipt is evidence; journal is authoritative.')

    def test_stale_partial_journal_temp_is_replaced_without_losing_durable_state(self):
        upgrade.apply(self.old, self.new, self.planned)
        directory = Path(self.planned['backup'])
        temporary = directory / 'upgrade-state.next'
        make_file(temporary, b'{"phase":"rolling_')
        state = self.state()
        upgrade.journal(directory, state)
        self.assertFalse(temporary.exists())
        self.assertEqual(self.state(), state)
        upgrade.rollback(self.old, self.new, self.planned)
        self.assertEqual(self.state()['phase'], 'rolled_back')

    def test_old_empty_and_partial_unit_temps_allow_exact_replacement(self):
        path = install.UNIT_DIR / next(iter(self.units))
        old = path.read_bytes()
        new = install.unit_text(next(iter(install.SERVICES)), AFTER).encode()
        temporary = path.with_name(path.name + '.disabled-upgrade-next')
        for mode in (0o600, 0o644):
            for content in (b'', old, new, old[:20], new[:-1]):
                with self.subTest(mode=oct(mode), bytes=len(content)):
                    make_file(temporary, content, mode)
                    upgrade.replace_unit(path, old, known_versions=(new,))
                    self.assertFalse(temporary.exists())
                    self.assertEqual(path.read_bytes(), old)
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o644)
        make_file(temporary, new[:20] + b'CORRUPTION', 0o600)
        with self.assertRaises(ValueError):
            upgrade.replace_unit(path, old, known_versions=(new,))
        self.assertTrue(temporary.exists())
        self.assertEqual(path.read_bytes(), old)

    def test_old_runtime_drift_before_switch_refuses_without_unit_replacement(self):
        persist = self.journal.side_effect
        provider = Path(self.planned['fromRelease']) / install.ROOTS[0] / 'backend/runtime/provider.json'

        def mutate_after_stage(directory, state):
            persist(directory, state)
            if state['phase'] == 'staged':
                make_file(provider, b'synthetic concurrent old-runtime write')

        with patch.object(upgrade, 'journal', side_effect=mutate_after_stage), \
                patch.object(upgrade, 'replace_unit') as replace:
            with self.assertRaisesRegex(ValueError, 'old_runtime_changed_before_switch'):
                upgrade.apply(self.old, self.new, self.planned)
        replace.assert_not_called()
        self.assertEqual(self.unit_versions(), list(self.units.values()))
        self.assertFalse((Path(self.planned['backup']) / 'installed.json').exists())

    def test_old_runtime_drift_after_switch_cannot_claim_runtime_preserved(self):
        provider = Path(self.planned['fromRelease']) / install.ROOTS[0] / 'backend/runtime/provider.json'

        def mutate_on_postswitch_roles():
            if all(AFTER.encode() in row for row in self.unit_versions()):
                make_file(provider, b'synthetic late old-runtime write')

        with patch.object(upgrade, 'verify_roles', side_effect=mutate_on_postswitch_roles):
            with self.assertRaisesRegex(ValueError, 'old_runtime_changed_after_switch'):
                upgrade.apply(self.old, self.new, self.planned)
        self.assertFalse((Path(self.planned['backup']) / 'installed.json').exists())
        self.assertEqual(self.state()['phase'], 'switching')

    def test_target_runtime_drift_after_switch_cannot_claim_runtime_preserved(self):
        provider = Path(self.planned['target']) / install.ROOTS[0] / 'backend/runtime/provider.json'

        def mutate_on_postswitch_roles():
            if all(AFTER.encode() in row for row in self.unit_versions()):
                make_file(provider, b'synthetic late target-runtime write')

        with patch.object(upgrade, 'verify_roles', side_effect=mutate_on_postswitch_roles):
            with self.assertRaisesRegex(ValueError, 'target_runtime_changed'):
                upgrade.apply(self.old, self.new, self.planned)
        self.assertFalse((Path(self.planned['backup']) / 'installed.json').exists())
        self.assertEqual(self.state()['phase'], 'switching')

    def test_preswitch_role_failure_prevents_first_unit_replacement(self):
        with patch.object(upgrade, 'verify_roles', side_effect=ValueError('synthetic role drift')), \
                patch.object(upgrade, 'replace_unit') as replace:
            with self.assertRaises(ValueError):
                upgrade.apply(self.old, self.new, self.planned)
        replace.assert_not_called()
        self.assertEqual(self.unit_versions(), list(self.units.values()))
        self.assertFalse((Path(self.planned['backup']) / 'installed.json').exists())


    def test_rollback_space_failure_precedes_dump_and_unit_restore(self):
        upgrade.apply(self.old, self.new, self.planned)
        before = self.unit_versions()
        with patch.object(upgrade, 'space_preflight',
                          side_effect=upgrade.UpgradeError('insufficient_rollback_space')) as space, \
                patch.object(upgrade, 'dump_database') as dump, \
                patch.object(upgrade, 'replace_unit') as replace:
            with self.assertRaisesRegex(ValueError, 'insufficient_rollback_space'):
                upgrade.rollback(self.old, self.new, self.planned)
        space.assert_called_once_with(self.old, {}, rollback=True)
        dump.assert_not_called()
        replace.assert_not_called()
        self.assertEqual(self.unit_versions(), before)

    def test_preswitch_roles_are_rechecked_after_the_full_database_dump(self):
        dump = self.dump_database
        preswitch_dump_finished = False

        def finish_dump(path):
            nonlocal preswitch_dump_finished
            result = dump(path)
            if path.name == 'database-preswitch.sql':
                preswitch_dump_finished = True
            return result

        def roles():
            if preswitch_dump_finished:
                raise upgrade.UpgradeError('synthetic_roles_changed_during_dump')

        with patch.object(upgrade, 'dump_database', side_effect=finish_dump), \
                patch.object(upgrade, 'verify_roles', side_effect=roles), \
                patch.object(upgrade, 'replace_unit') as replace:
            with self.assertRaisesRegex(ValueError, 'synthetic_roles_changed_during_dump'):
                upgrade.apply(self.old, self.new, self.planned)
        self.assertTrue(preswitch_dump_finished)
        replace.assert_not_called()
        self.assertEqual(self.unit_versions(), list(self.units.values()))
        self.assertEqual(self.state()['phase'], 'staged')

    def test_helper_failure_records_last_step_without_private_diagnostic(self):
        original = self.host_command

        def fail_reload(argv, **options):
            if argv == ['/usr/bin/systemctl', 'daemon-reload']:
                raise ValueError(PRIVATE)
            return original(argv, **options)

        with patch.object(install, 'run', side_effect=fail_reload):
            with self.assertRaisesRegex(upgrade.UpgradeError, '^unit_definition_reload_failed$') as failure:
                upgrade.apply(self.old, self.new, self.planned)
        self.assertNotIn(PRIVATE, str(failure.exception))
        self.assertEqual(self.state()['phase'], 'switching')
        self.assertEqual(self.state()['lastStep'], 'reload_unit_definitions')
        self.assertFalse((Path(self.planned['backup']) / 'installed.json').exists())


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
                    patch.object(upgrade, 'runtime_snapshot', return_value={'runtime': 'private'}) as runtime, \
                    patch.object(upgrade, 'space_preflight') as space:
                result = upgrade.host_preflight(old, new, planned)
            context.assert_called_once_with(new)
            units.assert_called_once_with([BEFORE])
            receipt.assert_called_once_with(planned)
            source.assert_called_once_with(Path(planned['fromRelease']), old)
            roles.assert_called_once_with()
            runtime.assert_called_once_with(Path(planned['fromRelease']))
            space.assert_called_once_with(new, {'runtime': 'private'})
            self.assertEqual(result, ({'unit': b'old'}, {'commit': BEFORE}, {'runtime': 'private'}))


class PublicDiagnosticTests(unittest.TestCase):
    def test_unexpected_errors_never_expose_private_diagnostics(self):
        for error in (ValueError(PRIVATE), OSError(PRIVATE), RuntimeError(PRIVATE),
                      KeyError(PRIVATE), TypeError(PRIVATE), AttributeError(PRIVATE), Exception(PRIVATE)):
            with self.subTest(kind=type(error).__name__):
                output = io.StringIO()
                with patch.object(install, 'archive_files', side_effect=error), contextlib.redirect_stdout(output):
                    self.assertEqual(upgrade.main(cli_args()), 1)
                result = json.loads(output.getvalue())
                self.assertFalse(result['ok'])
                self.assertNotIn(PRIVATE, output.getvalue())
                self.assertIn('keep_services_stopped', result['action'])

    def test_nonobject_private_json_returns_redacted_failure(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'private-state.json'
            actual_read = upgrade.read_regular

            def local_read(candidate, **options):
                self.assertEqual(candidate, path)
                self.assertEqual(options['owner'], 0)
                return actual_read(candidate, **{**options, 'owner': os.getuid()})

            for value in ([PRIVATE], PRIVATE, None, 45, True):
                with self.subTest(kind=type(value).__name__):
                    make_file(path, json.dumps(value).encode())
                    output = io.StringIO()
                    with patch.object(install, 'archive_files', return_value=archives()[0]), \
                            patch.object(upgrade.filesystem, 'protected_parents'), \
                            patch.object(upgrade, 'read_regular', side_effect=local_read), \
                            patch.object(upgrade, 'plan', side_effect=lambda *a: upgrade.private_json(path)), \
                            contextlib.redirect_stdout(output):
                        self.assertEqual(upgrade.main(cli_args()), 1)
                    result = json.loads(output.getvalue())
                    self.assertFalse(result['ok'])
                    self.assertEqual(result['reason'], 'private_json_object_required')
                    self.assertIn('keep_services_stopped', result['action'])
                    self.assertNotIn(PRIVATE, output.getvalue())
                    self.assertNotIn(str(path), output.getvalue())

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


class SpacePreflightTests(unittest.TestCase):
    GIB = 1024 ** 3

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        base = Path(self.temp.name)
        self.backups, self.releases, self.data = base / 'backups', base / 'opt/releases', base / 'data'
        for path in (self.backups, self.releases, self.data):
            path.mkdir(parents=True)
        self.enterContext(patch.object(install, 'BACKUPS', self.backups))
        self.enterContext(patch.object(install, 'BASE', self.releases.parent))
        self.enterContext(patch.object(install, 'DATA', self.data))
        self.devices = {self.backups: 1, self.releases: 2, self.data: 3}
        self.available = {path: 2 * self.GIB for path in self.devices}
        self.capacity = {path: 16 * self.GIB for path in self.devices}
        self.available_inodes = {path: 100000 for path in self.devices}
        actual_stat = Path.stat

        def space_stat(path, **options):
            if path in self.devices:
                return SimpleNamespace(st_dev=self.devices[path])
            return actual_stat(path, **options)

        def statvfs(path):
            self.assertIn(path, self.devices, 'No real host storage may be consulted.')
            return SimpleNamespace(f_bsize=4096, f_frsize=4096,
                f_blocks=self.capacity[path] // 4096, f_bavail=self.available[path] // 4096,
                f_files=1000000, f_favail=self.available_inodes[path])

        self.enterContext(patch.object(Path, 'stat', space_stat))
        self.space = self.enterContext(patch.object(os, 'statvfs', side_effect=statvfs))
        self.files = {'backend/read_api.py': (b'x' * 8193, False)}
        self.snapshot = {'read': {'.': (0o700, 1, 1, None),
                                 'config': (0o600, 1, 1, b'x' * 8193)}}

    def test_separate_devices_have_independent_capacity_and_shared_devices_add_requirements(self):
        # Each device has enough separately; 2 GiB shared cannot fit four dumps,
        # metadata/source/runtime copies and the 1 GiB PG safety margin together.
        upgrade.space_preflight(self.files, self.snapshot)
        self.assertEqual({call.args[0] for call in self.space.call_args_list}, set(self.devices))
        self.devices = {path: 1 for path in self.devices}
        with self.assertRaisesRegex(ValueError, '^insufficient_upgrade_space$'):
            upgrade.space_preflight(self.files, self.snapshot)
        self.available = {path: 3 * self.GIB for path in self.devices}
        upgrade.space_preflight(self.files, self.snapshot)

    def test_backup_reserves_apply_dumps_and_one_additional_rollback_dump(self):
        self.available[self.backups] = 1024 ** 3
        with self.assertRaisesRegex(ValueError, '^insufficient_upgrade_space$'):
            upgrade.space_preflight(self.files, self.snapshot)
        # Rollback needs one new dump plus metadata, not another seven sources.
        self.available[self.backups] = 400 * 1024 ** 2
        upgrade.space_preflight(self.files, {}, rollback=True)
        self.available[self.backups] = 300 * 1024 ** 2
        with self.assertRaisesRegex(ValueError, '^insufficient_rollback_space$'):
            upgrade.space_preflight(self.files, {}, rollback=True)

    def test_source_budget_counts_seven_copies_and_both_runtime_destinations(self):
        self.files['backend/large.py'] = (b'x' * (16 * 1024 ** 2), False)
        self.available[self.releases] = 80 * 1024 ** 2
        with self.assertRaisesRegex(ValueError, '^insufficient_upgrade_space$'):
            upgrade.space_preflight(self.files, self.snapshot)
        del self.files['backend/large.py']
        self.snapshot['read']['large'] = (0o600, 1, 1, b'x' * (16 * 1024 ** 2))
        self.available[self.releases] = 8 * 1024 ** 2
        with self.assertRaisesRegex(ValueError, '^insufficient_upgrade_space$'):
            upgrade.space_preflight(self.files, self.snapshot)
        self.available[self.releases] = 2 * self.GIB
        self.available[self.backups] = 1140 * 1024 ** 2
        with self.assertRaisesRegex(ValueError, '^insufficient_upgrade_space$'):
            upgrade.space_preflight(self.files, self.snapshot)

    def test_pg_margin_scales_with_capacity_and_invalid_reports_refuse(self):
        self.capacity[self.data] = 100 * self.GIB
        with self.assertRaisesRegex(ValueError, '^insufficient_upgrade_space$'):
            upgrade.space_preflight(self.files, self.snapshot)
        self.available[self.data] = 6 * self.GIB
        upgrade.space_preflight(self.files, self.snapshot)
        with patch.object(os, 'statvfs', return_value=SimpleNamespace(
                f_bsize=4096, f_frsize=0, f_blocks=1, f_bavail=1, f_files=1, f_favail=1)):
            with self.assertRaisesRegex(ValueError, '^invalid_filesystem_space_report$'):
                upgrade.space_preflight(self.files, self.snapshot)


    def test_releases_device_reserves_metadata_even_for_a_tiny_archive(self):
        self.available[self.releases] = 32 * 1024 ** 2
        with self.assertRaisesRegex(ValueError, '^insufficient_upgrade_space$'):
            upgrade.space_preflight(self.files, self.snapshot)
        self.available[self.releases] = 80 * 1024 ** 2
        upgrade.space_preflight(self.files, self.snapshot)

    def test_inode_budgets_aggregate_when_source_backups_and_pg_share_a_device(self):
        self.available = {path: 3 * self.GIB for path in self.devices}
        self.available_inodes = {path: 3000 for path in self.devices}
        upgrade.space_preflight(self.files, self.snapshot)
        self.devices = {path: 1 for path in self.devices}
        with self.assertRaisesRegex(ValueError, '^insufficient_upgrade_inodes$'):
            upgrade.space_preflight(self.files, self.snapshot)
        self.available_inodes = {path: 5000 for path in self.devices}
        upgrade.space_preflight(self.files, self.snapshot)

    def test_independent_inode_exhaustion_blocks_backups_releases_and_pg(self):
        for path, free in ((self.backups, 2000), (self.releases, 1000), (self.data, 1023)):
            with self.subTest(device=path.name):
                self.available_inodes[path] = free
                try:
                    with self.assertRaisesRegex(ValueError, '^insufficient_upgrade_inodes$'):
                        upgrade.space_preflight(self.files, self.snapshot)
                finally:
                    self.available_inodes[path] = 100000
        self.available_inodes[self.backups] = 1000
        with self.assertRaisesRegex(ValueError, '^insufficient_rollback_inodes$'):
            upgrade.space_preflight(self.files, {}, rollback=True)
        self.available_inodes[self.backups] = 1500
        upgrade.space_preflight(self.files, {}, rollback=True)

    def test_inode_budget_counts_seven_archive_copies_and_each_runtime_copy(self):
        self.files = {f'backend/file-{index}': (b'', False) for index in range(1000)}
        self.available_inodes[self.releases] = 7000
        with self.assertRaisesRegex(ValueError, '^insufficient_upgrade_inodes$'):
            upgrade.space_preflight(self.files, self.snapshot)
        self.files = {'backend/read_api.py': (b'', False)}
        self.snapshot['read'].update({f'empty-{index}': (0o600, 1, 1, b'') for index in range(3000)})
        self.available_inodes[self.releases] = 3500
        with self.assertRaisesRegex(ValueError, '^insufficient_upgrade_inodes$'):
            upgrade.space_preflight(self.files, self.snapshot)
        self.available_inodes[self.releases] = 100000
        self.available_inodes[self.backups] = 4500
        with self.assertRaisesRegex(ValueError, '^insufficient_upgrade_inodes$'):
            upgrade.space_preflight(self.files, self.snapshot)

    def test_invalid_inode_statistics_fail_closed(self):
        for files, available in ((0, 1), (1000, -1), (1000, 1001)):
            with self.subTest(files=files, available=available), \
                    patch.object(os, 'statvfs', return_value=SimpleNamespace(
                        f_bsize=4096, f_frsize=4096, f_blocks=10000000, f_bavail=10000000,
                        f_files=files, f_favail=available)):
                with self.assertRaisesRegex(ValueError, '^invalid_filesystem_inode_report$'):
                    upgrade.space_preflight(self.files, self.snapshot)


class MainLockTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.lock = self.root / '.disabled-install.lock'
        self.enterContext(patch.object(install, 'BASE', self.root))
        self.enterContext(patch.object(install, 'archive_files', side_effect=lambda *a: archives()[0]))
        self.enterContext(patch.object(upgrade.os, 'geteuid', return_value=0))
        self.enterContext(patch.object(upgrade, 'trusted_toolchain'))
        self.enterContext(patch.object(upgrade.filesystem, 'protected_parents'))
        self.preflight = self.enterContext(patch.object(upgrade, 'host_preflight'))
        self.apply = self.enterContext(patch.object(upgrade, 'apply'))
        self.rollback = self.enterContext(patch.object(upgrade, 'rollback'))
        previous_umask = os.umask(0o077)
        self.addCleanup(os.umask, previous_umask)
        real_fstat = os.fstat

        def root_owned(fd):
            info = real_fstat(fd)
            fields = list(info)
            fields[4] = 0
            return os.stat_result(fields, {name: getattr(info, name)
                                      for name in ('st_atime_ns', 'st_mtime_ns', 'st_ctime_ns')})

        # Only effective root identity changes. Lock inode, type, modes, nlink,
        # separate open file descriptions and kernel flock remain real.
        self.enterContext(patch.object(os, 'fstat', side_effect=root_owned))

    def invoke(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            code = upgrade.main([*cli_args(), '--inspect'])
        return code, json.loads(output.getvalue())

    def assert_refused_before_host(self):
        code, result = self.invoke()
        self.assertEqual(code, 1)
        self.assertFalse(result['ok'])
        self.assertIn('keep_services_stopped', result['action'])
        for action in (self.preflight, self.apply, self.rollback):
            action.assert_not_called()
        return result

    def test_missing_lock_is_not_created(self):
        self.assert_refused_before_host()
        self.assertFalse(self.lock.exists())

    def test_invalid_lock_mode_and_multiple_links_refuse(self):
        make_file(self.lock, b'', 0o644)
        self.assertEqual(self.assert_refused_before_host()['reason'], 'invalid_upgrade_lock')
        self.lock.chmod(0o600)
        other = self.root / 'hardlink'
        os.link(self.lock, other)
        self.assertEqual(self.assert_refused_before_host()['reason'], 'invalid_upgrade_lock')
        self.assertEqual(self.lock.stat().st_nlink, 2)

    def test_kernel_lock_contention_refuses_and_release_allows_inspect(self):
        make_file(self.lock, b'')
        with self.lock.open('rb+') as held:
            fcntl.flock(held, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.assert_refused_before_host()
            fcntl.flock(held, fcntl.LOCK_UN)
        code, result = self.invoke()
        self.assertEqual(code, 0)
        self.assertTrue(result['hostValidated'])
        self.preflight.assert_called_once()
        self.apply.assert_not_called()
        self.rollback.assert_not_called()


class StableFilesystemTests(unittest.TestCase):
    def test_read_regular_returns_the_verified_inode_stat_with_payload(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'fixture'
            make_file(path, b'stable bytes')
            before = path.stat()
            payload, opened = upgrade.read_regular(path, limit=1024, owner=os.getuid(), return_stat=True)
            self.assertEqual(payload, b'stable bytes')
            for name in ('st_ino', 'st_dev', 'st_uid', 'st_gid', 'st_mode', 'st_nlink',
                         'st_mtime_ns', 'st_ctime_ns'):
                self.assertEqual(getattr(opened, name), getattr(before, name))
            self.assertEqual(upgrade.read_regular(path, limit=1024), payload)
            with self.assertRaisesRegex(ValueError, '^unexpected_file_owner$'):
                upgrade.read_regular(path, limit=1024, owner=os.getuid() + 1, return_stat=True)

    def test_unit_temp_requests_root_owner_and_uses_verified_gid_and_mode(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'domino-read.service'
            temporary = path.with_name(path.name + '.disabled-upgrade-next')
            content = b'[Service]\nExecStart=/fixed/release\n'
            make_file(path, b'previous', 0o644)
            actual_lstat = Path.lstat

            def no_second_lstat(candidate):
                if candidate == temporary:
                    raise AssertionError('Temporary metadata must come from the stable opened inode.')
                return actual_lstat(candidate)

            for uid, gid, mode in ((0, 42, 0o600), (0, 0, 0o666), (0, 0, 0o600)):
                with self.subTest(uid=uid, gid=gid, mode=oct(mode)):
                    make_file(path, b'previous', 0o644)
                    make_file(temporary, content[:10])
                    raw = temporary.stat()
                    fields = list(raw)
                    fields[0], fields[4], fields[5] = stat.S_IFREG | mode, uid, gid
                    verified = os.stat_result(fields, {name: getattr(raw, name)
                        for name in ('st_atime_ns', 'st_mtime_ns', 'st_ctime_ns')})
                    with patch.object(upgrade, 'read_regular', return_value=(content[:10], verified)) as read, \
                            patch.object(Path, 'lstat', no_second_lstat), patch.object(os, 'fchown'):
                        if (uid, gid, mode) == (0, 0, 0o600):
                            upgrade.replace_unit(path, content)
                        else:
                            with self.assertRaisesRegex(ValueError, '^unexpected_unit_temporary$'):
                                upgrade.replace_unit(path, content)
                    read.assert_called_once_with(temporary, limit=65536, owner=0, return_stat=True)
                    if (uid, gid, mode) != (0, 0, 0o600):
                        self.assertEqual(temporary.read_bytes(), content[:10])
                        self.assertEqual(path.read_bytes(), b'previous')
                    else:
                        self.assertFalse(temporary.exists())
                        self.assertEqual(path.read_bytes(), content)

    def test_fsync_directory_never_follows_a_swapped_directory_symlink(self):
        with tempfile.TemporaryDirectory() as folder:
            real = Path(folder) / 'directory'
            real.mkdir()
            swapped = Path(folder) / 'swapped'
            swapped.symlink_to(real, target_is_directory=True)
            actual_open = os.open
            with patch.object(os, 'open', wraps=actual_open) as opened:
                install.fsync_directory(real)
            self.assertTrue(opened.call_args.args[1] & os.O_NOFOLLOW)
            with self.assertRaises(OSError):
                install.fsync_directory(swapped)


class DumpBoundaryTests(unittest.TestCase):
    def test_offline_dump_argv_pins_wrapper_cap_environment_and_pg_destination(self):
        self.assertEqual(install.ENV, EXPECTED_DUMP_ENV)
        with tempfile.TemporaryDirectory() as folder:
            original_read = upgrade.read_regular

            def local_read(path, **options):
                self.assertEqual(options['owner'], 0)
                return original_read(path, **{**options, 'owner': os.getuid()})

            for index, (limits, cap) in enumerate((((resource.RLIM_INFINITY, resource.RLIM_INFINITY),
                                                   upgrade.MAX_DUMP_BYTES),
                                                  ((64, 128), 64),
                                                  ((2048, resource.RLIM_INFINITY), 2048))):
                with self.subTest(limits=limits):
                    path = Path(folder) / f'dump-{index}.sql'
                    child = Mock(returncode=0)
                    child.communicate.return_value = (None, b'')

                    def child_boundary(argv, **options):
                        self.assertEqual(argv[:8], ['/usr/sbin/runuser', '-u', 'postgres', '--',
                                                  '/usr/bin/python3', '-I', '-B', '-c'])
                        self.assertEqual(argv[8], upgrade.DUMP_EXEC)
                        self.assertEqual(argv[9], str(cap))
                        self.assertEqual(json.loads(argv[10]), EXPECTED_DUMP_ENV)
                        self.assertEqual(argv[11:], ['/usr/lib/postgresql/16/bin/pg_dump', '-w', '-h',
                            '/run/postgresql-domino', '-p', '8877', '-U', 'postgres', '-d',
                            'domino_catalogue', '--format=plain', '--lock-wait-timeout=5s'])
                        self.assertEqual(set(options), {'stdout', 'stderr', 'env', 'start_new_session'})
                        self.assertEqual(options['env'], EXPECTED_DUMP_ENV)
                        self.assertIs(options['stderr'], subprocess.PIPE)
                        self.assertTrue(options['start_new_session'])
                        options['stdout'].write(b'-- fixture dump\n')
                        return child

                    with patch.object(upgrade.resource, 'getrlimit', return_value=limits), \
                            patch.object(upgrade.subprocess, 'Popen', side_effect=child_boundary) as popen, \
                            patch.object(upgrade, 'read_regular', side_effect=local_read):
                        fingerprint = upgrade.dump_database(path)
                    popen.assert_called_once()
                    child.communicate.assert_called_once_with(timeout=install.COMMAND_TIMEOUT)
                    self.assertRegex(fingerprint, r'^[a-f0-9]{64}$')
                    self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_actual_exec_target_observes_only_literal_environment(self):
        inherited = {'PATH': '/nonexistent', 'LANG': 'C', 'PGOPTIONS': 'invalid inherited options',
                     'PYTHONPATH': '/nonexistent/injected', 'DOMINO_SYNTHETIC_PRIVATE_VALUE': PRIVATE}
        result = subprocess.run([sys.executable, '-I', '-B', '-c', upgrade.DUMP_EXEC,
                                 str(upgrade.MAX_DUMP_BYTES), json.dumps(EXPECTED_DUMP_ENV), '/usr/bin/env'],
                                env=inherited, capture_output=True, text=True, timeout=10,
                                restore_signals=False)
        self.assertEqual(result.returncode, 0)
        observed = dict(line.split('=', 1) for line in result.stdout.splitlines())
        self.assertEqual(observed, EXPECTED_DUMP_ENV)
        self.assertNotIn(PRIVATE, result.stdout + result.stderr)

    def test_actual_wrapper_resets_sigpipe_and_sigxfsz_before_exec(self):
        # Python starts with these signals ignored. The shell preserves inherited
        # SIG_IGN, so self-signalling terminates only if the wrapper resets it.
        for name, number in (('PIPE', signal.SIGPIPE), ('XFSZ', signal.SIGXFSZ)):
            with self.subTest(signal=name):
                result = subprocess.run([sys.executable, '-I', '-B', '-c', upgrade.DUMP_EXEC,
                    str(upgrade.MAX_DUMP_BYTES), json.dumps(EXPECTED_DUMP_ENV), '/bin/sh', '-c',
                    f'ulimit -c 0; kill -s {name} $$; printf SIGNAL_WAS_IGNORED'], env=EXPECTED_DUMP_ENV,
                    capture_output=True, timeout=10, restore_signals=False)
                self.assertEqual(result.returncode, -number)
                self.assertNotIn(b'SIGNAL_WAS_IGNORED', result.stdout)


if __name__ == '__main__':
    unittest.main()
