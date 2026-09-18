#!/usr/bin/env python3
"""Plan, inspect, upgrade or roll back an existing disabled Domino installation.

The two archives and this toolchain need independent source review. The default
only compares archives. Host operations never start/enable services, migrate a
database, change dependencies, configure egress or restore a database backup.
"""
import argparse
import fcntl
import grp
import hashlib
import json
import os
from pathlib import Path
import pwd
import re
import resource
import signal
import stat
import subprocess
import sys
import tarfile
import time

import check_filesystem as filesystem
import prepare_disabled as install

MAX_RUNTIME_BYTES = 64 * 1024 * 1024
MAX_DUMP_BYTES = 256 * 1024 * 1024
SPACE_METADATA_BYTES = 64 * 1024 * 1024
SPACE_METADATA_INODES = 1024
PG_MIN_FREE_BYTES = 1024 * 1024 * 1024
TOOL_DIR = Path(__file__).resolve().parent
# runuser (including its PAM session) can reset resource limits and environment.
# Apply the cap afterwards, never increasing an inherited soft or hard limit,
# and replace the post-PAM environment before exec of the pinned pg_dump binary.
DUMP_EXEC = ('import json,os,resource,signal,sys; '
             'limits=resource.getrlimit(resource.RLIMIT_FSIZE); '
             'cap=min([int(sys.argv[1])]+[v for v in limits if v!=resource.RLIM_INFINITY]); '
             'resource.setrlimit(resource.RLIMIT_FSIZE,(cap,cap)); '
             'assert resource.getrlimit(resource.RLIMIT_FSIZE)==(cap,cap); '
             'signal.signal(signal.SIGXFSZ,signal.SIG_DFL); '
             'signal.signal(signal.SIGPIPE,signal.SIG_DFL); '
             'os.execve(sys.argv[3],sys.argv[3:],json.loads(sys.argv[2]))')


class UpgradeError(ValueError):
    """A fixed public reason, never text supplied by a file or child process."""


def require(condition, reason):
    if not condition:
        raise UpgradeError(reason)


def checked_step(reason, operation, *args, **kwargs):
    """Preserve our fixed diagnoses; redact unstructured helper failures."""
    try:
        return operation(*args, **kwargs)
    except UpgradeError:
        raise
    except Exception:
        raise UpgradeError(reason) from None


def sha(payload):
    return hashlib.sha256(payload).hexdigest()


def plan(old, new, old_sha, new_sha, before, after):
    require(before != after, 'source_and_destination_must_differ')
    frozen = (*install.MIGRATIONS, 'backend/schema.sql', 'backend/requirements-api.lock')
    require(all(name in old and install.succeeds(name, old.get(name), new.get(name)) for name in frozen),
            'schema_migration_or_dependency_change_requires_another_upgrade')
    planned = {'mode': 'disabled-upgrade-plan', 'hostValidated': False,
            'fromCommit': before, 'commit': after,
            'fromArchiveSha256': old_sha, 'archiveSha256': new_sha,
            'fromRelease': str(install.BASE / 'releases' / before),
            'target': str(install.BASE / 'releases' / after),
            'backup': str(install.BACKUPS / after),
            'changedFiles': sorted(name for name in old.keys() | new.keys()
                                   if old.get(name) != new.get(name)),
            'unchangedMigrations': list(install.MIGRATIONS),
            'units': {f'domino-{c}.service': install.unit_text(c, after) for c in install.SERVICES},
            'notPerformed': ['service start/enable', 'database writes or restore',
                             'migration replay', 'dependency change', 'runtime configuration changes',
                             'Access/Tunnel/egress', 'wallet grants', 'release deletion']}
    previous_packaged = install.packaged_only_migrations(old)
    packaged = install.packaged_only_migrations(new)
    if previous_packaged or packaged:
        planned['fromPackagedOnlyMigrations'] = previous_packaged
        planned['packagedOnlyMigrations'] = packaged
    # rollback compares the full saved plan; foundation-only journals created
    # by the previous toolchain must retain their exact plan shape and values.
    return planned


def read_regular(path, *, limit, owner=None, mode=None, return_stat=False):
    """Read a bounded stable single-link regular file, never follow a link."""
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'regular_single_link_file_required')
    require(owner is None or info.st_uid == owner, 'unexpected_file_owner')
    require(mode is None or stat.S_IMODE(info.st_mode) == mode, 'unexpected_file_mode')
    require(info.st_size <= limit, 'file_size_limit')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        opened = os.fstat(stream.fileno())
        require(opened == info, 'file_changed_before_read')
        payload = stream.read(limit + 1)
        stable = lambda s: (s.st_dev, s.st_ino, s.st_mode, s.st_uid, s.st_gid,
                            s.st_nlink, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
        require(stable(opened) == stable(os.fstat(stream.fileno())) == stable(path.lstat()),
                'file_changed_during_read')
    require(len(payload) <= limit, 'file_size_limit')
    return (payload, opened) if return_stat else payload


def private_json(path):
    filesystem.protected_parents(path.parent)
    value = json.loads(read_regular(path, limit=8 * 1024 * 1024, owner=0, mode=0o600))
    require(type(value) is dict, 'private_json_object_required')
    return value


def write_json(path, value):
    install.exclusive_file(path, (json.dumps(value, sort_keys=True, indent=2) + '\n').encode())


def journal(directory, state):
    # A crash before rename retains the previous durable phase; rollback accepts
    # each unit only when it is exactly one of the two independently known versions.
    target = directory / 'upgrade-state.json'
    temporary = directory / 'upgrade-state.next'
    if os.path.lexists(temporary):
        read_regular(temporary, limit=8 * 1024 * 1024, owner=0, mode=0o600)
        temporary.unlink()
    write_json(temporary, state)
    os.replace(temporary, target)
    install.fsync_directory(directory)


def runtime_snapshot(root):
    """Private in-memory bytes + metadata for all seven complete runtime trees.

    Do not print or place the returned inventory/hashes in public evidence. Nested
    lock directories and 0644 writer reports inside private0700 roots are retained.
    """
    snapshot, total = {}, 0
    for component in install.ROOTS:
        account = pwd.getpwnam('domino-' + component)
        runtime = root / component / 'backend/runtime'
        entries = {}
        for directory, dirs, files in filesystem.walk_entries(runtime, time.monotonic() + 120):
            for path in (directory, *(directory / name for name in files)):
                info = path.lstat()
                mode = stat.S_IMODE(info.st_mode)
                require(not os.listxattr(path, follow_symlinks=False), 'runtime_extended_attributes_not_supported')
                require(info.st_uid == account.pw_uid and info.st_gid == account.pw_gid,
                        'runtime_owner_mismatch')
                relative = path.relative_to(runtime).as_posix()
                require(len(Path(relative).parts) <= 32, 'runtime_depth_limit')
                if stat.S_ISDIR(info.st_mode):
                    require(mode == 0o700, 'runtime_directory_must_be_private')
                    content = None
                else:
                    require(mode & ~0o644 == 0, 'runtime_file_must_not_be_executable_or_writable_by_others')
                    content = read_regular(path, limit=MAX_RUNTIME_BYTES - total, owner=account.pw_uid)
                    total += len(content)
                entries[relative] = (mode, info.st_uid, info.st_gid, content)
            for name in dirs:
                require(not (directory / name).is_symlink(), 'runtime_directory_link_forbidden')
        require('catalogue-db.json' in entries, 'runtime_descriptor_missing')
        require(entries['catalogue-db.json'][0] == 0o600, 'runtime_descriptor_must_be_private')
        descriptor = json.loads(entries['catalogue-db.json'][3])
        require(descriptor == {'host': install.SOCKET, 'port': 8877, 'dbname': install.DB},
                'runtime_descriptor_target_mismatch')
        snapshot[component] = entries
    return snapshot


def inventory(snapshot):
    return {component: {name: {'mode': row[0], 'uid': row[1], 'gid': row[2],
                             'sha256': None if row[3] is None else sha(row[3])}
                        for name, row in entries.items()}
            for component, entries in snapshot.items()}


def copy_runtime(snapshot, target, *, backup=False):
    for component, entries in snapshot.items():
        root = target / component if backup else target / component / 'backend/runtime'
        filesystem.protected_parents(root.parent)
        if backup:
            root.mkdir(mode=0o700)
        else:
            info = root.lstat()
            require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and info.st_gid == 0
                    and stat.S_IMODE(info.st_mode) == 0o700, 'new_runtime_must_be_root_private')
            # install_roots created only this exact empty descriptor. Never remove
            # anything from the old runtime or merge into an existing target release.
            require(sorted(p.name for p in root.iterdir()) == ['catalogue-db.json'],
                    'new_runtime_not_empty')
            read_regular(root / 'catalogue-db.json', limit=65536, owner=0, mode=0o600)
            (root / 'catalogue-db.json').unlink()
        for name, (mode, uid, gid, content) in sorted(entries.items(), key=lambda item: (item[0].count('/'), item[0])):
            path = root if name == '.' else root / name
            if content is None:
                if name != '.':
                    path.mkdir(mode=0o700)
            else:
                # Every ancestor remains root-owned 0700 while files are created.
                install.exclusive_file(path, content)
        if not backup:
            # Restore child metadata using stable non-following descriptors. The
            # runtime root changes owner last, after all privileged copy work.
            for name, (mode, uid, gid, content) in sorted(entries.items(),
                    key=lambda item: (len(Path(item[0]).parts), item[0]), reverse=True):
                path = root if name == '.' else root / name
                flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
                fd = os.open(path, flags | (os.O_DIRECTORY if content is None else 0))
                try:
                    info = os.fstat(fd)
                    require(info.st_uid == 0 and info.st_gid == 0
                            and (stat.S_ISDIR(info.st_mode) if content is None else
                                 stat.S_ISREG(info.st_mode) and info.st_nlink == 1),
                            'new_runtime_metadata_changed')
                    os.fchown(fd, uid, gid)
                    os.fchmod(fd, mode)
                    os.fsync(fd)
                finally:
                    os.close(fd)
        for directory, _, _ in os.walk(root, topdown=False):
            install.fsync_directory(Path(directory))


def stopped_units(commits, *, reload_pending=False):
    expected = {name: [install.unit_text(c, commit).encode() for commit in commits]
                for c in install.SERVICES for name in [f'domino-{c}.service']}
    result = {}
    for command in ('list-unit-files', 'list-units'):
        listing = install.run(['/usr/bin/systemctl', command, '--all', '--no-legend', '--no-pager']).decode()
        found = set(re.findall(r'^\s*(?:●\s*)?(domino\S*\.(?:service|socket|timer|path|target))\s',
                               listing, re.MULTILINE))
        require(found <= expected.keys(), 'unexpected_domino_unit_or_trigger')
    jobs = install.run(['/usr/bin/systemctl', 'list-jobs', '--no-legend', '--no-pager']).decode()
    require(not re.search(r'\bdomino\S*\.(?:service|socket|timer|path|target)\b', jobs),
            'pending_domino_job')
    for name, versions in expected.items():
        path = install.UNIT_DIR / name
        filesystem.protected_parents(path.parent)
        content = read_regular(path, limit=65536, owner=0, mode=0o644)
        require(content in versions, 'unit_not_an_exact_disabled_template')
        keys = ('ActiveState', 'SubState', 'MainPID', 'ControlPID', 'UnitFileState',
                'FragmentPath', 'DropInPaths', 'NeedDaemonReload', 'TriggeredBy', 'Triggers',
                'WantedBy', 'RequiredBy', 'UpheldBy', 'BoundBy', 'OnSuccessOf', 'OnFailureOf')
        output = install.run(['/usr/bin/systemctl', 'show', name,
                              *('--property=' + key for key in keys)]).decode()
        props = dict(line.split('=', 1) for line in output.splitlines() if '=' in line)
        require(all(props.get(k) == v for k, v in {
            'ActiveState': 'inactive', 'SubState': 'dead', 'MainPID': '0', 'ControlPID': '0',
            'UnitFileState': 'static', 'FragmentPath': str(path), 'DropInPaths': '',
            'TriggeredBy': '', 'Triggers': '', 'WantedBy': '', 'RequiredBy': '', 'UpheldBy': '',
            'BoundBy': '', 'OnSuccessOf': '', 'OnFailureOf': ''}.items()),
            'service_must_be_stopped_static_without_overrides')
        require(props.get('NeedDaemonReload') == 'no' or reload_pending, 'pending_unit_reload')
        result[name] = content
    service_uids = {pwd.getpwnam('domino-' + c).pw_uid for c in (*install.ROOTS, 'admin', 'tunnel')}
    processes = install.run(['/usr/bin/ps', '-e', '-o', 'uid=']).decode().split()
    require(all(int(uid) not in service_uids for uid in processes), 'service_uid_process_present')
    # A stopped systemd unit alone does not rule out a process launched manually.
    listeners = install.run(['/usr/bin/ss', '-H', '-ltn']).decode()
    require(not re.search(r':(?:8876|8878|8879|8880|8881)\s', listeners), 'application_listener_present')
    require(install.sql("SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity "
                        "WHERE datname=pg_catalog.current_database() AND pid<>pg_catalog.pg_backend_pid() "
                        "AND backend_type='client backend'") == '0', 'other_database_clients_present')
    return result


def verify_source(root, files):
    deadline = time.monotonic() + 120
    runtimes = {root / c / 'backend/runtime' for c in install.ROOTS}
    filesystem.check_code(root, runtimes, deadline)
    filesystem.check_code_identity(root, files, deadline)
    for c in install.ROOTS:
        filesystem.check_descriptor(root / c / 'backend/runtime', pwd.getpwnam('domino-' + c))


def verify_roles():
    # Isolated Python excludes the script directory; add only our separately
    # trusted helper directory, without inheriting PYTHONPATH or the current cwd.
    code = ('import runpy,sys; sys.path.insert(0, sys.argv[1]); '
            'sys.argv=[sys.argv[2]]; runpy.run_path(sys.argv[0],run_name="__main__")')
    report = json.loads(checked_step('installed_role_or_catalogue_verification_failed', install.run,
                        ['/usr/bin/python3', '-I', '-B', '-c', code,
                         str(TOOL_DIR), str(TOOL_DIR / 'check_roles.py')]))
    require(type(report) is dict and report.get('ok') is True,
            'installed_role_or_catalogue_verification_failed')


def trusted_toolchain():
    filesystem.protected_parents(TOOL_DIR)
    for name in ('upgrade_disabled.py', 'prepare_disabled.py', 'check_filesystem.py',
                 'check_roles.py', 'catalogue_inventory.py'):
        path = TOOL_DIR / name
        filesystem.protected_parents(path)
        read_regular(path, limit=1024 * 1024, owner=0)


def receipt(planned):
    value = private_json(install.BACKUPS / planned['fromCommit'] / 'installed.json')
    require(value.get('commit') == planned['fromCommit'], 'installed_receipt_commit_mismatch')
    require(value.get('migrationsCommitted') == list(install.MIGRATIONS), 'installed_migration_receipt_mismatch')
    return value


def foundation_preflight():
    """Check the installed fixed foundation without the installer's empty-DB guards."""
    install.pg_parents(install.CONFIG)
    install.pg_parents(install.DATA)
    expected_auth = {
        'pg_hba.conf': (*install.HBA[:6], ('local', install.DB, install.DEPOSIT, 'peer', 'map=domino'),
                        *install.HBA[6:]),
        'pg_ident.conf': (*install.MAPPINGS, *install.NEW_MAPPINGS),
    }
    postgres = pwd.getpwnam('postgres')
    for name, expected in expected_auth.items():
        payload = read_regular(install.CONFIG / name, limit=65536, owner=postgres.pw_uid, mode=0o600)
        rows = tuple(tuple(line.split('#', 1)[0].split()) for line in payload.decode().splitlines()
                     if line.split('#', 1)[0].strip())
        require(rows == expected, 'postgres_auth_foundation_changed')
    settings = json.loads(install.sql("SELECT pg_catalog.json_object_agg(name,setting) "
        "FROM pg_catalog.pg_settings WHERE name IN ('server_version_num','server_encoding',"
        "'data_directory','config_file','hba_file','ident_file','port','listen_addresses',"
        "'unix_socket_directories','unix_socket_permissions','unix_socket_group')"))
    require(type(settings) is dict, 'postgres_settings_object_required')
    expected = {'server_encoding': 'UTF8', 'data_directory': str(install.DATA),
                'config_file': str(install.CONFIG / 'postgresql.conf'),
                'hba_file': str(install.CONFIG / 'pg_hba.conf'),
                'ident_file': str(install.CONFIG / 'pg_ident.conf'),
                'port': '8877', 'listen_addresses': '', 'unix_socket_directories': install.SOCKET,
                'unix_socket_permissions': '0770', 'unix_socket_group': 'domino-db'}
    require(all(settings.get(k) == v for k, v in expected.items())
            and 160000 <= int(settings.get('server_version_num', '0')) < 170000,
            'postgres_foundation_changed')
    require(install.sql("SELECT pg_catalog.pg_encoding_to_char(encoding)='UTF8' "
                        "FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()") == 't',
            'database_must_be_UTF8')
    require(install.sql('SELECT pg_catalog.count(*) FROM pg_catalog.pg_settings WHERE pending_restart') == '0',
            'postgres_pending_restart')
    install.validate_pg_files()
    socket_group = grp.getgrnam('domino-db').gr_gid
    for path, mode, kind in ((Path(install.SOCKET), 0o750, stat.S_ISDIR),
                             (Path(install.SOCKET) / '.s.PGSQL.8877', 0o770, stat.S_ISSOCK)):
        info = path.lstat()
        require(kind(info.st_mode) and info.st_uid == postgres.pw_uid and info.st_gid == socket_group
                and stat.S_IMODE(info.st_mode) == mode, 'postgres_socket_changed')


def host_context(files):
    require(os.geteuid() == 0, 'root_required')
    trusted_toolchain()
    filesystem.protected_parents(install.BASE)
    filesystem.protected_parents(install.BACKUPS)
    require(stat.S_IMODE(install.BACKUPS.stat().st_mode) == 0o700, 'backups_must_be_private')
    os_release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    require(os_release.get('ID', '').strip('"') == 'ubuntu'
            and os_release.get('VERSION_ID', '').strip('"') == '24.04', 'requires_Ubuntu24_04')
    require(not os.path.lexists(install.BASE / 'current'), 'unexpected_current_link')
    checked_step('installed_dependencies_verification_failed', install.dependency_preflight, files)
    checked_step('postgres_foundation_verification_failed', foundation_preflight)


def space_preflight(files, snapshot, *, rollback=False):
    """Require conservative available bytes/inodes per device, without reservation.

    Apply budgets seven block-rounded source copies, two complete runtime copies,
    three maximum dumps plus one rollback dump, and separate 64 MiB metadata
    allowances for apply and rollback, plus one on the releases device. Every
    allowance also includes 1024 metadata inodes. Rollback rechecks a new dump
    and its metadata allowance. Keep max(1 GiB, 5% capacity) free on the PG device;
    requirements add when backups, source and PG share a filesystem, with 1024
    free PG inodes. Pooled filesystems need an operator's combined budget because
    different st_dev values can share the same underlying storage.
    """
    devices = {}

    def device(path):
        info, space = path.stat(), os.statvfs(path)
        require(space.f_frsize > 0 and space.f_bsize > 0 and space.f_blocks > 0,
                'invalid_filesystem_space_report')
        require(space.f_files > 0 and 0 <= space.f_favail <= space.f_files,
                'invalid_filesystem_inode_report')
        available = space.f_bavail * space.f_frsize
        value = devices.setdefault(info.st_dev, {'needed': 0, 'available': available,
                                                'neededInodes': 0, 'availableInodes': space.f_favail})
        value['available'] = min(value['available'], available)
        value['availableInodes'] = min(value['availableInodes'], space.f_favail)
        return value, max(4096, space.f_frsize, space.f_bsize), space.f_blocks * space.f_frsize

    def allocated(size, block):
        return ((size + block - 1) // block) * block

    def runtime_bytes(block):
        return sum(block if row[3] is None else allocated(len(row[3]), block)
                   for entries in snapshot.values() for row in entries.values())

    backups, block, _ = device(install.BACKUPS)
    runtime_inodes = sum(len(entries) for entries in snapshot.values())
    if rollback:
        backups['needed'] += allocated(MAX_DUMP_BYTES, block) + SPACE_METADATA_BYTES
        backups['neededInodes'] += 1 + SPACE_METADATA_INODES
    else:
        backups['needed'] += (4 * allocated(MAX_DUMP_BYTES, block)
                              + runtime_bytes(block) + 2 * SPACE_METADATA_BYTES)
        backups['neededInodes'] += runtime_inodes + 4 + 2 * SPACE_METADATA_INODES
        releases, block, _ = device(install.BASE / 'releases')
        directories = {parent for name in files for parent in Path(name).parents}
        source = (sum(allocated(len(payload), block) for payload, _ in files.values())
                  + (len(directories) + 2) * block)
        releases['needed'] += (len(install.ROOTS) * source + runtime_bytes(block)
                               + SPACE_METADATA_BYTES)
        releases['neededInodes'] += (len(install.ROOTS) * (len(files) + len(directories) + 2)
                                     + runtime_inodes + SPACE_METADATA_INODES)
    postgres, _, capacity = device(install.DATA)
    postgres['needed'] += max(PG_MIN_FREE_BYTES, (capacity + 19) // 20)
    postgres['neededInodes'] += SPACE_METADATA_INODES
    require(all(value['available'] >= value['needed'] for value in devices.values()),
            'insufficient_rollback_space' if rollback else 'insufficient_upgrade_space')
    require(all(value['availableInodes'] >= value['neededInodes'] for value in devices.values()),
            'insufficient_rollback_inodes' if rollback else 'insufficient_upgrade_inodes')


def host_preflight(old, new, planned):
    host_context(new)
    require(not os.path.lexists(Path(planned['target'])), 'destination_release_exists')
    require(not os.path.lexists(Path(planned['backup'])), 'destination_backup_exists')
    units = stopped_units([planned['fromCommit']])
    old_receipt = receipt(planned)
    verify_source(Path(planned['fromRelease']), old)
    verify_roles()
    snapshot = runtime_snapshot(Path(planned['fromRelease']))
    space_preflight(new, snapshot)
    return units, old_receipt, snapshot


def dump_database(path):
    """Private complete plain dump, with a child file-size bound and no DB writes."""
    inherited = resource.getrlimit(resource.RLIMIT_FSIZE)
    cap = min([MAX_DUMP_BYTES] + [value for value in inherited if value != resource.RLIM_INFINITY])
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'wb') as output:
        argv = ['/usr/sbin/runuser', '-u', 'postgres', '--',
                '/usr/bin/python3', '-I', '-B', '-c', DUMP_EXEC,
                str(cap), json.dumps(install.ENV), str(install.PG / 'pg_dump'),
                '-w', '-h', install.SOCKET, '-p', '8877', '-U', 'postgres', '-d', install.DB,
                '--format=plain', '--lock-wait-timeout=5s']
        proc = subprocess.Popen(argv, stdout=output, stderr=subprocess.PIPE,
                                env=install.ENV, start_new_session=True)
        try:
            proc.communicate(timeout=install.COMMAND_TIMEOUT)
        except subprocess.TimeoutExpired:
            os.killpg(proc.pid, signal.SIGKILL)
            proc.communicate()
            raise UpgradeError('database_dump_timeout') from None
        require(proc.returncode == 0, 'database_dump_failed')
        output.flush()
        os.fsync(output.fileno())
    payload = read_regular(path, limit=MAX_DUMP_BYTES, owner=0, mode=0o600)
    # Random psql guard keys also ship in PG16.10+ (CVE-2025-8714 backport),
    # including the production target. Strip only these complete command lines.
    normalized = re.sub(rb'(?m)^\\(?:un)?restrict [A-Za-z0-9]+\r?\n', b'', payload)
    return sha(normalized)


def replace_unit(path, content, *, known_versions=()):
    temporary = path.with_name(path.name + '.disabled-upgrade-next')
    if os.path.lexists(temporary):
        partial, info = read_regular(temporary, limit=65536, owner=0, return_stat=True)
        require(info.st_gid == 0 and stat.S_IMODE(info.st_mode) in (0o600, 0o644)
                and any(version.startswith(partial) for version in (content, *known_versions)),
                'unexpected_unit_temporary')
        temporary.unlink()
    install.exclusive_file(temporary, content, 0o644)
    os.replace(temporary, path)
    install.fsync_directory(path.parent)


def sync_tree(root):
    for directory, _, _ in os.walk(root, topdown=False, followlinks=False):
        install.fsync_directory(Path(directory))
    install.fsync_directory(root.parent)


def apply(old, new, planned):
    units, old_receipt, snapshot = host_preflight(old, new, planned)
    destination = Path(planned['backup'])
    destination.mkdir(mode=0o700)
    install.fsync_directory(destination.parent)
    write_json(destination / 'plan.json', planned)
    write_json(destination / 'previous-installed.json', old_receipt)
    write_json(destination / 'runtime-inventory.json', inventory(snapshot))
    (destination / 'units').mkdir(mode=0o700)
    for name, content in units.items():
        install.exclusive_file(destination / 'units' / name, content)
    (destination / 'runtime').mkdir(mode=0o700)
    copy_runtime(snapshot, destination / 'runtime', backup=True)
    digest = dump_database(destination / 'database-before.sql')
    sync_tree(destination)
    state = {'phase': 'backed_up', 'commit': planned['commit'], 'fromCommit': planned['fromCommit'],
             'databaseFingerprint': digest, 'unitsWritten': [], 'targetStaged': False,
             'lastStep': 'stage_source'}
    journal(destination, state)
    # No mutation of the installed release/runtime, PG configs, SQL data or venv.
    install.install_roots(new, planned['commit'], private_runtime=True)
    target = Path(planned['target'])
    copy_runtime(snapshot, target)
    sync_tree(target)
    verify_source(target, new)
    require(inventory(runtime_snapshot(target)) == inventory(snapshot), 'runtime_copy_mismatch')
    candidates = destination / 'candidates'
    candidates.mkdir(mode=0o700)
    for name, text in planned['units'].items():
        install.exclusive_file(candidates / name, text.encode())
    sync_tree(candidates)
    checked_step('candidate_unit_verification_failed', install.run,
                 ['/usr/bin/systemd-analyze', 'verify', *(str(candidates / n) for n in units)])
    state['phase'] = 'staged'
    state['targetStaged'] = True
    state['lastStep'] = 'preswitch_checks'
    journal(destination, state)
    stopped_units([planned['fromCommit']])
    require(inventory(runtime_snapshot(Path(planned['fromRelease']))) == inventory(snapshot),
            'old_runtime_changed_before_switch')
    require(dump_database(destination / 'database-preswitch.sql') == digest, 'database_changed_before_switch')
    verify_roles()
    state['phase'] = 'switching'
    state['lastStep'] = 'replace_units'
    journal(destination, state)
    for name, text in planned['units'].items():
        replace_unit(install.UNIT_DIR / name, text.encode())
        state['unitsWritten'].append(name)
        journal(destination, state)
    state['lastStep'] = 'verify_installed_units'
    journal(destination, state)
    checked_step('installed_unit_verification_failed', install.run,
                 ['/usr/bin/systemd-analyze', 'verify', *(str(install.UNIT_DIR / n) for n in units)])
    state['lastStep'] = 'reload_unit_definitions'
    journal(destination, state)
    checked_step('unit_definition_reload_failed', install.run, ['/usr/bin/systemctl', 'daemon-reload'])
    state['lastStep'] = 'verify_after_switch'
    journal(destination, state)
    stopped_units([planned['commit']])
    host_context(new)
    verify_source(target, new)
    verify_roles()
    require(dump_database(destination / 'database-after.sql') == digest, 'database_changed_after_switch')
    require(inventory(runtime_snapshot(target)) == inventory(snapshot), 'target_runtime_changed')
    require(inventory(runtime_snapshot(Path(planned['fromRelease']))) == inventory(snapshot),
            'old_runtime_changed_after_switch')
    state['lastStep'] = 'write_installed_receipt'
    journal(destination, state)
    installed = {
        'commit': planned['commit'], 'fromCommit': planned['fromCommit'],
        'archiveSha256': planned['archiveSha256'], 'servicesStarted': False, 'servicesEnabled': False,
        'migrationsCommitted': list(install.MIGRATIONS), 'migrationsReapplied': False,
        'databasePreserved': True, 'runtimePreserved': True}
    packaged = install.packaged_only_migrations(new)
    if packaged:
        installed['packagedOnlyMigrations'] = packaged
    write_json(destination / 'installed.json', installed)
    state['phase'] = 'complete'
    state['lastStep'] = 'complete'
    journal(destination, state)
    return {'mode': 'disabled-upgrade', 'ok': True, 'commit': planned['commit'],
            'servicesStarted': False, 'servicesEnabled': False, 'databasePreserved': True,
            'runtimePreserved': True, 'receipt': str(destination / 'installed.json')}


def rollback(old, new, planned):
    """Restore only known source-unit references; preserve DB and target evidence."""
    destination = Path(planned['backup'])
    host_context(old)
    saved_plan = private_json(destination / 'plan.json')
    require(saved_plan == planned, 'rollback_plan_mismatch')
    state = private_json(destination / 'upgrade-state.json')
    require(state.get('commit') == planned['commit'] and state.get('fromCommit') == planned['fromCommit']
            and state.get('phase') in ('backed_up', 'staged', 'switching', 'complete', 'rolling_back'),
            'rollback_state_not_supported')
    stopped_units([planned['fromCommit'], planned['commit']], reload_pending=True)
    verify_source(Path(planned['fromRelease']), old)
    expected = private_json(destination / 'runtime-inventory.json')
    require(inventory(runtime_snapshot(Path(planned['fromRelease']))) == expected,
            'rollback_old_runtime_changed')
    target = Path(planned['target'])
    # A partial stage never ran; a complete stage must still have its exact runtime.
    require(type(state.get('targetStaged')) is bool, 'rollback_stage_flag_missing')
    if state['targetStaged']:
        verify_source(target, new)
        require(inventory(runtime_snapshot(target)) == expected, 'rollback_target_runtime_changed')
    space_preflight(old, {}, rollback=True)
    proof = destination / f'database-rollback-{time.time_ns()}.sql'
    require(dump_database(proof) == state['databaseFingerprint'], 'rollback_database_changed')
    state['phase'] = 'rolling_back'
    state['lastStep'] = 'restore_units'
    journal(destination, state)
    for component in install.SERVICES:
        name = f'domino-{component}.service'
        content = read_regular(destination / 'units' / name, limit=65536, owner=0, mode=0o600)
        require(content == install.unit_text(component, planned['fromCommit']).encode(), 'backup_unit_mismatch')
        replace_unit(install.UNIT_DIR / name, content,
                     known_versions=(install.unit_text(component, planned['commit']).encode(),))
    state['lastStep'] = 'reload_previous_units'
    journal(destination, state)
    checked_step('unit_definition_reload_failed', install.run, ['/usr/bin/systemctl', 'daemon-reload'])
    state['lastStep'] = 'verify_rollback'
    journal(destination, state)
    stopped_units([planned['fromCommit']])
    verify_roles()
    state['phase'] = 'rolled_back'
    state['lastStep'] = 'rolled_back'
    journal(destination, state)
    return {'mode': 'disabled-upgrade-rollback', 'ok': True, 'commit': planned['fromCommit'],
            'servicesStarted': False, 'databaseRestored': False, 'targetEvidencePreserved': True}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    for prefix in ('from-', ''):
        parser.add_argument('--' + prefix + 'archive', required=True, type=Path)
        parser.add_argument('--' + prefix + 'archive-sha256', required=True)
        parser.add_argument('--' + prefix + 'commit', required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--inspect', action='store_true')
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--rollback', action='store_true')
    args = parser.parse_args(argv)
    try:
        old = install.archive_files(args.from_archive, args.from_archive_sha256, args.from_commit)
        new = install.archive_files(args.archive, args.archive_sha256, args.commit)
        planned = plan(old, new, args.from_archive_sha256, args.archive_sha256, args.from_commit, args.commit)
        if not (args.inspect or args.apply or args.rollback):
            result = planned
        else:
            require(os.geteuid() == 0, 'root_required')
            os.umask(0o077)
            trusted_toolchain()
            filesystem.protected_parents(install.BASE)
            fd = os.open(install.BASE / '.disabled-install.lock', os.O_RDWR | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb+'):
                info = os.fstat(fd)
                require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
                        and info.st_nlink == 1 and stat.S_IMODE(info.st_mode) == 0o600, 'invalid_upgrade_lock')
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                if args.inspect:
                    host_preflight(old, new, planned)
                    result = {'mode': 'disabled-upgrade-inspection', 'ok': True, 'hostValidated': True,
                              'fromCommit': args.from_commit, 'commit': args.commit, 'filesChanged': False}
                else:
                    result = rollback(old, new, planned) if args.rollback else apply(old, new, planned)
        print(json.dumps(result, indent=2))
        return 0
    except Exception as error:
        # Runtime paths/bytes, configuration, database rows and private fingerprints
        # stay in operator-controlled storage, including on refusal.
        reason = str(error) if isinstance(error, UpgradeError) else type(error).__name__
        print(json.dumps({'ok': False, 'reason': reason,
                          'action': 'keep_services_stopped; inspect_private_journal_before_rollback'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
