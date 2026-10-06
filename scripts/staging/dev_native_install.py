#!/usr/bin/env python3
"""Install only the reviewed development OFF lane; never activate providers/Tunnel.

The operator supplies an externally reviewed SHA256 of candidate.json. Check is
read-only on the host (nft loads use a disposable network namespace). Apply owns
only previously absent dev paths/identities plus the two exact peer additions
and guarded dev SQL role. Rollback retains inert files, identities and deny rules.
Native cgroup/mount/provider/Windows qualification is deliberately separate.
"""
import argparse
from contextlib import contextmanager
import fcntl
import grp
import hashlib
import http.client
import json
import os
from pathlib import Path
import pwd
import re
import stat
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace

import check_roles as roles
import dev_catalogue_profile as sql_profile
import dev_infrastructure as infra
import prepare_disabled as archive

RELEASE = '6f21abf32f1786e10c8eba7b0d113aaa981b688f'
PRODUCTION_MANIFEST = Path('/root/domino-continuous-activation-20260912/current-manifest.json')
PRODUCTION_SHA = 'd11a98ff236d6b7088d3a2ade1fdec932286180a9130ee94fc3f319a0a36e659'
HELPERS = ('dev_infrastructure.py', 'dev_catalogue_profile.py', 'catalogue_inventory.py',
           'check_roles.py', 'prepare_disabled.py')
PGDIR = Path('/etc/postgresql/16/domino')
PEERS = tuple(PGDIR / name for name in ('pg_ident.conf', 'pg_hba.conf'))
SOURCE = Path(infra.CODE) / RELEASE
UNITS = ('dominodev.slice', 'domino-dev-egress.service', 'domino-dev-read.service',
         'domino-dev-gateway.service', 'domino-dev-tunnel.service', 'domino-dev-off.target')
STOP = ('domino-dev-off.target', 'domino-dev-tunnel.service', 'domino-dev-gateway.service',
        'domino-dev-read.service', 'domino-dev-egress.service')
PRODUCTION_UNITS = ('domino-read.service', 'domino-gateway.service', 'domino-tunnel.service',
                    'postgresql@16-domino.service')
NEW_ROOTS = (Path('/opt/domino/dev'), Path(infra.ROOT), Path(infra.STATE))
HEX = re.compile('[a-f0-9]{64}')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C', 'LANG': 'C.UTF-8',
       'PYTHONDONTWRITEBYTECODE': '1'}


class Refused(ValueError):
    """Only fixed, non-secret error codes reach CLI output."""


def need(ok, code):
    if not ok:
        raise Refused(code)


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def encode(value):
    return (json.dumps(value, sort_keys=True, indent=2, allow_nan=False) + '\n').encode()


def parse(raw, limit=1024 * 1024):
    need(len(raw) <= limit, 'document_too_large')
    def pairs(items):
        out = {}
        for key, value in items:
            need(key not in out, 'duplicate_json_key')
            out[key] = value
        return out
    return json.loads(raw, object_pairs_hook=pairs,
                      parse_constant=lambda _: (_ for _ in ()).throw(Refused('nonfinite_json')))


def checked_document(path, expected, *, maximum=1024 * 1024):
    raw = read(path, mode=0o600, maximum=maximum)
    need(sha(raw) == expected, 'candidate_document_mismatch')
    return parse(raw, maximum)


def check_sql_plan(document, baseline):
    # The pure SQL generator uses tuple peer additions; JSON has only arrays.
    # Compare their canonical wire forms, preserving exact SQL/snapshot content.
    need(encode(document) == encode(sql_profile.build_sql(baseline)), 'sql_plan_mismatch')


def exact_tree(root, directories, files):
    """Verify the complete existing tree; never repair or follow a link."""
    root = Path(root)
    seen_dirs, seen_files = set(), set()
    for folder, names, leaves in os.walk(root, followlinks=False):
        path = Path(folder)
        need(path in directories, 'unexpected_staged_directory')
        info = path.lstat()
        uid, gid, mode = directories[path]
        need(stat.S_ISDIR(info.st_mode) and (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode))
             == (uid, gid, mode), 'staged_directory_metadata_drift')
        seen_dirs.add(path)
        for name in names:
            child = path / name
            need(child in directories and not child.is_symlink(), 'unexpected_staged_directory')
        for name in leaves:
            child = path / name
            need(child in files and not child.is_symlink(), 'unexpected_staged_file')
            item = files[child]
            need(read(child, mode=item['mode'], uid=item['uid'], gid=item['gid'],
                 parent_owners=(0, item['uid']), maximum=max(1024*1024, len(item['bytes']))) == item['bytes'],
                 'staged_file_content_drift')
            seen_files.add(child)
    need(seen_dirs == set(directories) and seen_files == set(files), 'staged_tree_inventory_drift')


def parents(path, owners=(0,)):
    for parent in reversed(Path(path).parents):
        s = parent.lstat()
        need(stat.S_ISDIR(s.st_mode) and s.st_uid in owners and not s.st_mode & 0o022,
             'unsafe_parent')


def read(path, *, mode=None, uid=0, gid=None, maximum=1024 * 1024, parent_owners=(0,)):
    path = Path(path)
    parents(path, parent_owners)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        first = os.fstat(stream.fileno())
        need(stat.S_ISREG(first.st_mode) and first.st_nlink == 1 and first.st_uid == uid
             and (gid is None or first.st_gid == gid) and not first.st_mode & 0o022
             and (mode is None or stat.S_IMODE(first.st_mode) == mode)
             and first.st_size <= maximum, 'unsafe_file')
        raw = stream.read(maximum + 1)
        last = os.fstat(stream.fileno())
    fields = ('st_dev', 'st_ino', 'st_size', 'st_mode', 'st_uid', 'st_gid', 'st_nlink',
              'st_mtime_ns', 'st_ctime_ns')
    need(len(raw) <= maximum and all(getattr(first, k) == getattr(last, k) for k in fields)
         and path.lstat().st_ino == first.st_ino, 'file_changed_during_read')
    return raw


def write_new(path, raw, mode=0o600, uid=0, gid=0):
    parents(path)
    archive.exclusive_file(Path(path), raw, mode, uid, gid)
    archive.fsync_directory(Path(path).parent)


def replace(path, raw, *, uid=0, gid=0, mode=0o600, parent_owners=(0,)):
    path = Path(path)
    parents(path, parent_owners)
    fd, name = tempfile.mkstemp(prefix='.domino-dev-off-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as stream:
            os.fchown(stream.fileno(), uid, gid)
            os.fchmod(stream.fileno(), mode)
            stream.write(raw)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
        archive.fsync_directory(path.parent)
    finally:
        if os.path.lexists(name):
            os.unlink(name)


def clean_kernel(value, *, remove_dev=False):
    """Keep rule order/handles/semantics; only volatile counters/metainfo vanish."""
    def clean(item):
        if isinstance(item, list):
            return [clean(v) for v in item]
        if isinstance(item, dict):
            return {k: clean(v) for k, v in item.items() if k not in ('packets', 'bytes')}
        return item
    need(isinstance(value, dict) and set(value) == {'nftables'}, 'invalid_kernel_snapshot')
    out = []
    for entry in value['nftables']:
        if 'metainfo' in entry:
            continue
        obj = next(iter(entry.values()))
        is_dev = isinstance(obj, dict) and (obj.get('table') == infra.POLICY or
                  ('table' in entry and obj.get('name') == infra.POLICY))
        if remove_dev and is_dev:
            continue
        out.append(clean(entry))
    return {'nftables': out}


def peer_bytes(baseline):
    """Preserve original bytes, including comments; insert before exact reject."""
    old = {p: baseline['peers'][str(p)]['text'].encode() for p in PEERS}
    for p, raw in old.items():
        item = baseline['peers'][str(p)]
        need(sha(raw) == item['sha256'] and item['mode'] == 0o600 and item['links'] == 1
             and not item['symlink'] and (item['uid'], item['gid']) == (109, 113), 'peer_baseline_invalid')
    ident, hba = PEERS
    need(all(sql_profile.ROLE.encode() not in raw for raw in old.values()), 'peer_already_present')
    lines = old[hba].splitlines(keepends=True)
    indexes = [i for i, line in enumerate(lines)
               if line.split(b'#', 1)[0].split() == [b'local', b'all', b'all', b'reject']]
    need(len(indexes) == 1, 'peer_reject_not_unique')
    addition = ' '.join(sql_profile.PEER_ADDITIONS['hba']).encode() + b'\n'
    lines.insert(indexes[0], addition)
    new = {hba: b''.join(lines), ident: old[ident] + (b'' if old[ident].endswith(b'\n') else b'\n')
           + ' '.join(sql_profile.PEER_ADDITIONS['ident']).encode() + b'\n'}
    return old, new


def check_absent_unit(name, actual):
    empty = all(actual.get(k, '') in ('', '0') for k in
                ('FragmentPath', 'DropInPaths', 'MainPID', 'WantedBy', 'RequiredBy'))
    missing = actual.get('LoadState') == 'not-found'
    # systemd synthesizes slice units even before any unit file is installed.
    # Only this empty, inactive implicit slice is equivalent to absence.
    implicit_slice = (name == 'dominodev.slice' and actual.get('LoadState') == 'loaded'
        and actual.get('ActiveState') == 'inactive' and actual.get('SubState') == 'dead'
        and actual.get('ControlGroup') == '' and actual.get('TasksCurrent') == '[not set]'
        and actual.get('Transient') == 'no')
    need(empty and (missing or implicit_slice), 'development_unit_collision')


def same_production_properties(actual, expected):
    """systemd may reorder IPAddressAllow on reload; no other drift is ignored."""
    return set(actual) == set(expected) and all(
        set(actual[key].split()) == set(value.split()) if key == 'IPAddressAllow'
        else actual[key] == value for key, value in expected.items())


def candidate(path, digest):
    path = Path(path)
    need(HEX.fullmatch(digest) is not None, 'invalid_candidate_hash')
    parents(path / 'candidate.json')
    info = path.lstat()
    need(stat.S_ISDIR(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o700,
         'candidate_directory_not_private')
    raw = read(path / 'candidate.json', mode=0o600)
    need(sha(raw) == digest, 'candidate_hash_mismatch')
    plan = parse(raw)
    keys = {'version', 'kind', 'releaseCommit', 'archiveSha256', 'preflightSha256', 'specSha256',
            'manifestSha256', 'sqlPlanSha256', 'installerSha256', 'helperSha256'}
    need(type(plan) is dict and set(plan) == keys and type(plan['version']) is int
         and plan['version'] == 1 and plan['kind'] == 'domino-dev-native-off-v1'
         and plan['releaseCommit'] == RELEASE, 'candidate_scope_mismatch')
    need(all(type(plan[k]) is str and HEX.fullmatch(plan[k]) for k in keys if k.endswith('Sha256')
             and k != 'helperSha256'), 'invalid_document_hash')
    need(type(plan['helperSha256']) is dict and set(plan['helperSha256']) == set(HELPERS), 'helper_inventory_mismatch')
    here = Path(__file__).resolve().parent
    for name, expected in {**plan['helperSha256'], 'dev_native_install.py': plan['installerSha256']}.items():
        need(type(expected) is str and HEX.fullmatch(expected) and sha(read(here / name)) == expected,
             'installer_source_mismatch')
    documents = {}
    for name, key in [('preflight', 'preflightSha256'), ('spec', 'specSha256'),
                      ('manifest', 'manifestSha256'), ('sql-plan', 'sqlPlanSha256')]:
        # Snapshot-pinned SQL repeats the full ACL snapshot in multiple guards.
        maximum = 8*1024*1024 if name == 'sql-plan' else 1024*1024
        documents[name] = checked_document(path / (name + '.json'), plan[key], maximum=maximum)
    baseline, spec = documents['preflight'], documents['spec']
    need(spec['releaseCommit'] == RELEASE, 'release_scope_mismatch')
    files, manifest = infra.generate(spec)
    need(documents['manifest'] == manifest and baseline['manifestSha256'] == PRODUCTION_SHA
         and set(baseline['productionUnits']) == set(PRODUCTION_UNITS)
         and set(baseline['peers']) == set(map(str, PEERS)), 'baseline_scope_mismatch')
    check_sql_plan(documents['sql-plan'], baseline['postgresSnapshot'])
    need(all(not v['exists'] for v in baseline['devPaths'].values()), 'baseline_dev_not_absent')
    peer_bytes(baseline)
    rootfs = path / 'rootfs'
    actual = set()
    for folder, dirs, names in os.walk(rootfs, followlinks=False):
        for name in dirs:
            need(not (Path(folder) / name).is_symlink(), 'rootfs_link')
        for name in names:
            child = Path(folder) / name
            target = '/' + child.relative_to(rootfs).as_posix()
            need(target in files and read(child, mode=0o600) == files[target]['bytes'], 'rootfs_content_mismatch')
            actual.add(target)
    need(actual == set(files), 'rootfs_inventory_mismatch')
    # The fixed parser reads the entire tar once before it returns any members.
    read(path / 'release.tar', mode=0o600, maximum=archive.MAX_ARCHIVE_BYTES)
    source = archive.archive_files(path / 'release.tar', plan['archiveSha256'], RELEASE)
    need(all('backend/' + name in source for name in ('dev_read_service.py', 'dev_read_gateway.py',
         'dev_read_identity.py', 'dev_read_budget.py')), 'development_entrypoint_missing')
    need(sha(source['api-contracts/read-v1/manifest.json'][0]) == spec['contractManifestSha256'],
         'read_contract_hash_mismatch')
    return {'path': path, 'digest': digest, 'plan': plan, 'baseline': baseline,
            'files': files, 'manifest': manifest, 'source': source, 'sql': documents['sql-plan']}


class Native:
    def run(self, args, data=None, timeout=55):
        try:
            p = subprocess.run(args, input=data, capture_output=True, check=True, timeout=timeout, env=ENV)
            need(len(p.stdout) <= 8*1024*1024 and len(p.stderr) <= 262144, 'native_output_limit')
            return p.stdout.decode().strip()
        except (subprocess.SubprocessError, OSError, UnicodeError):
            raise Refused('native_command_failed') from None

    def sql(self, statement):
        return self.run(['/usr/sbin/runuser', '-u', 'postgres', '--', '/usr/bin/env', '-i',
            'PATH=/usr/bin:/bin', 'LC_ALL=C', 'PGPASSFILE=/dev/null', 'PGCONNECT_TIMEOUT=3',
            'PGOPTIONS=-c search_path=pg_catalog -c statement_timeout=5000 -c lock_timeout=1000',
            '/usr/bin/psql', '-X', '--no-password', '-A', '-t', '-v', 'ON_ERROR_STOP=1',
            '-q', '-h', '/run/postgresql-domino', '-p', '8877', '-U', 'postgres',
            '-d', 'domino_catalogue'], statement.encode())

    def snapshot_sql(self):
        return parse(self.sql('BEGIN READ ONLY;\n' + sql_profile.snapshot_sql() + '\nROLLBACK;').encode())

    def properties(self, unit, keys):
        raw = self.run(['/usr/bin/systemctl', 'show', unit, '-p', ','.join(keys)])
        return dict(line.split('=', 1) for line in raw.splitlines())

    def kernel(self):
        return parse(self.run(['/usr/sbin/nft', '-j', 'list', 'ruleset']).encode(), 8*1024*1024)

    def production(self, c, *, dev=False, extra=None):
        b = c['baseline']
        need(sha(read(PRODUCTION_MANIFEST, mode=0o600)) == PRODUCTION_SHA, 'production_manifest_drift')
        need(set(b['productionFiles']) == {v['target'] for v in b['manifest']['files']}, 'production_file_inventory')
        for path, item in b['productionFiles'].items():
            need(path.startswith(('/etc/domino/continuous-reads/', '/etc/systemd/system/domino-')),
                 'production_file_scope')
            need(sha(read(path, mode=item['mode'], uid=0, gid=0)) == item['sha256'], 'production_file_drift')
        captured = {}
        for unit, expected in b['productionUnits'].items():
            actual = self.properties(unit, expected)
            need(same_production_properties(actual, expected), 'production_unit_drift')
            pid = int(actual['MainPID'])
            need(pid > 1 and actual['ActiveState'] == 'active', 'production_not_active')
            tick = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()[19]
            paths = [actual['FragmentPath'], *actual['DropInPaths'].split()]
            hashes = {}
            for name in paths:
                need(name.startswith(('/etc/systemd/system/', '/usr/lib/systemd/system/')),
                     'production_unit_file_scope')
                hashes[name] = sha(read(name))
            captured[unit] = {'startTicks': tick, 'files': hashes}
        need(extra is None or extra == captured, 'production_process_or_unit_bytes_drift')
        need(clean_kernel(self.kernel(), remove_dev=dev) == clean_kernel(b['kernel']), 'production_kernel_drift')
        return captured

    def absent(self, c):
        for root in NEW_ROOTS:
            need(not os.path.lexists(root), 'development_path_present')
            parents(root)
        for name in UNITS:
            need(not os.path.lexists('/etc/systemd/system/' + name), 'development_unit_present')
            actual = self.properties(name, ('LoadState', 'FragmentPath', 'DropInPaths', 'MainPID',
                                           'WantedBy', 'RequiredBy', 'ActiveState', 'SubState',
                                           'ControlGroup', 'TasksCurrent', 'Transient'))
            check_absent_unit(name, actual)
        for p in ('/run/domino-dev-off.ready', '/run/domino-dev-connector.reviewed'):
            need(not os.path.lexists(p), 'development_marker_present')
        users, groups = pwd.getpwall(), grp.getgrall()
        need(not any(p.pw_uid in (974, 975, 976) or p.pw_name in infra.USERS.values() for p in users), 'uid_collision')
        need(not any(g.gr_gid in (974, 975, 976) or g.gr_name in infra.USERS.values() for g in groups), 'gid_collision')
        need(grp.getgrnam('domino-db').gr_gid == 988, 'database_group_drift')
        self.no_dev_processes()
        self.listener_free()
        need(clean_kernel(self.kernel()) == clean_kernel(self.kernel(), remove_dev=True), 'development_table_present')

    def listener_free(self):
        ports = {int(line.split()[3].rsplit(':', 1)[1]) for line in self.run(['/usr/bin/ss', '-H', '-ltn']).splitlines()}
        need(not ports & {8890, 8891, 20242}, 'development_port_busy')

    def no_dev_processes(self):
        raw = self.run(['/usr/bin/ps', '-e', '-o', 'uid='])
        need(not {974, 975, 976} & {int(x) for x in raw.split()}, 'development_process_present')

    def binaries(self, c):
        need(set(c['baseline']['binaries']) == {infra.PYTHON, infra.CLOUDFLARED}, 'binary_inventory')
        for name, expected in c['baseline']['binaries'].items():
            target = Path(name).resolve(strict=True)
            need(str(target) == expected['resolvedPath'] and sha(read(target, mode=expected['mode'],
                 maximum=64*1024*1024)) == expected['sha256'], 'binary_drift')
        archive.dependency_preflight(c['source'])

    def check_peers(self, c, *, states=('old',)):
        old, new = peer_bytes(c['baseline'])
        for p in PEERS:
            raw = read(p, mode=0o600, uid=109, gid=113, parent_owners=(0, 109))
            need(raw in [v[p] for k, v in [('old', old), ('new', new)] if k in states], 'peer_file_drift')

    def check(self, c):
        extra = self.production(c)
        self.absent(c)
        self.binaries(c)
        self.check_peers(c)
        need(self.snapshot_sql() == c['baseline']['postgresSnapshot'], 'sql_baseline_drift')
        self.run(['/usr/sbin/nft', '--check', '-f', str(c['path'] / 'rootfs/etc/domino/dev/off-policy.nft')])
        self.run(['/usr/bin/unshare', '--net', '--', '/usr/bin/python3', '-I', '-B', '-c',
                  'import subprocess,sys\nfor _ in range(2): subprocess.run(["/usr/sbin/nft","-f",sys.argv[1]],check=True,capture_output=True)',
                  str(c['path'] / 'rootfs/etc/domino/dev/off-policy.nft')])
        self.production(c, extra=extra)
        return extra

    def identities(self):
        for role, (uid, _) in infra.ROLES.items():
            user = infra.USERS[role]
            self.run(['/usr/sbin/groupadd', '--system', '--gid', str(uid), user])
            args = ['/usr/sbin/useradd', '--system', '--uid', str(uid), '--gid', user,
                    '--no-create-home', '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin',
                    '--password', '!']
            if role == 'reader':
                args += ['--groups', 'domino-db']
            self.run([*args, user])
            p = pwd.getpwnam(user)
            need((p.pw_uid, p.pw_gid, p.pw_dir, p.pw_shell) == (uid, uid, '/nonexistent', '/usr/sbin/nologin'), 'created_identity_mismatch')
            need(set(os.getgrouplist(user, uid)) == ({uid, 988} if role == 'reader' else {uid}), 'created_groups_mismatch')

    def staged_identities(self):
        users, groups = pwd.getpwall(), grp.getgrall()
        for role, (uid, _) in infra.ROLES.items():
            name = infra.USERS[role]
            matching = [u for u in users if u.pw_uid == uid or u.pw_name == name]
            need(len(matching) == 1, 'staged_identity_collision')
            user = matching[0]
            need((user.pw_name, user.pw_uid, user.pw_gid, user.pw_dir, user.pw_shell) ==
                 (name, uid, uid, '/nonexistent', '/usr/sbin/nologin'), 'staged_identity_drift')
            matching_groups = [g for g in groups if g.gr_gid == uid or g.gr_name == name]
            need(len(matching_groups) == 1 and (matching_groups[0].gr_name, matching_groups[0].gr_gid,
                 matching_groups[0].gr_mem) == (name, uid, []), 'staged_group_drift')
            need(not any(u.pw_gid == uid and u.pw_name != name for u in users), 'staged_group_foreign_primary')
            need(set(os.getgrouplist(name, uid)) == ({uid, 988} if role == 'reader' else {uid}),
                 'staged_supplementary_group_drift')
            # passwd --status contains lock state/dates, never the password hash.
            status = self.run(['/usr/bin/passwd', '--status', name]).split()
            need(len(status) >= 2 and status[:2] == [name, 'L'], 'staged_account_not_locked')
        need(grp.getgrnam('domino-db').gr_gid == 988, 'database_group_drift')

    def staged(self, c, state):
        need(state.get('phase') == 'rolled_back' and state.get('unitsInstalled') is True,
             'resume_requires_completed_staged_rollback')
        self.production(c, extra=state['productionExtra'])
        self.no_dev_processes()
        self.listener_free()
        for p in ('/run/domino-dev-off.ready', '/run/domino-dev-connector.reviewed'):
            need(not os.path.lexists(p), 'development_marker_present')
        for p in ('/sys/fs/cgroup/dominodev.slice', '/sys/fs/cgroup/system.slice/domino-dev-egress.service'):
            need(not os.path.lexists(p), 'staged_cgroup_still_present')
        self.staged_identities()
        installed_known(c, self)
        # Every generated file must still exist; rollback's prefix check alone
        # deliberately permits an interrupted partial staging and is insufficient.
        for name, item in c['files'].items():
            need(read(name, mode=item['mode'], uid=item['uid'], gid=item['gid'],
                 parent_owners=(0, item['uid'])) == item['bytes'], 'staged_file_content_drift')
        for name in UNITS:
            a = self.properties(name, ('FragmentPath', 'DropInPaths', 'ActiveState', 'MainPID', 'ControlGroup'))
            need(a.get('FragmentPath') == '/etc/systemd/system/' + name and a.get('DropInPaths') == ''
                 and a.get('ActiveState') == 'inactive' and a.get('MainPID', '0') == '0'
                 and a.get('ControlGroup', '') == '', 'staged_unit_not_inert')
        dirs = {SOURCE: (0, 0, 0o555)}
        files = {}
        for name, (raw, executable) in c['source'].items():
            p = SOURCE / name
            files[p] = {'bytes': raw, 'mode': 0o555 if executable else 0o444, 'uid': 0, 'gid': 0}
            for parent in p.parents:
                if parent == SOURCE:
                    break
                dirs[parent] = (0, 0, 0o555)
        # Include both root ancestors so an unknown sibling release is refused.
        dirs[Path('/opt/domino/dev')] = (0, 0, 0o755)
        dirs[Path(infra.CODE)] = (0, 0, 0o755)
        exact_tree('/opt/domino/dev', dirs, files)
        for root in (Path(infra.ROOT), Path(infra.STATE)):
            directories = {Path(v['path']): (v['uid'], v['gid'], v['mode'])
                           for v in c['manifest']['directories'] if Path(v['path']).is_relative_to(root)}
            leaves = {Path(name): v for name, v in c['files'].items() if Path(name).is_relative_to(root)}
            # No runtime leaves are emitted, so any lock/cache/config there fails.
            exact_tree(root, directories, leaves)
        self.binaries(c)
        self.check_peers(c)
        need(self.snapshot_sql() == c['baseline']['postgresSnapshot'], 'sql_baseline_drift')
        self.production(c, extra=state['productionExtra'])

    def stage(self, c):
        Path('/opt/domino/dev').mkdir(mode=0o755)
        os.chmod('/opt/domino/dev', 0o755)
        Path(infra.CODE).mkdir(mode=0o755)
        os.chmod(infra.CODE, 0o755)
        SOURCE.mkdir(mode=0o755)
        for name, (raw, executable) in c['source'].items():
            p = SOURCE / name
            p.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            write_new(p, raw, 0o555 if executable else 0o444)
        for folder, _, _ in os.walk(SOURCE, topdown=False):
            os.chmod(folder, 0o555)
        for item in c['manifest']['directories']:
            p = Path(item['path'])
            p.mkdir(mode=0o700)
            os.chown(p, item['uid'], item['gid'])
            os.chmod(p, item['mode'])
        for name, item in c['files'].items():
            # Parent role directories are intentionally service-owned, but still
            # inert: no dev process/entrypoint has been started.
            p = Path(name)
            parents(p, (0, item['uid']))
            archive.exclusive_file(p, item['bytes'], item['mode'], item['uid'], item['gid'])
            archive.fsync_directory(p.parent)

    def unit_check(self, c):
        self.run(['/usr/bin/systemd-analyze', 'verify', *['/etc/systemd/system/' + n for n in UNITS]])
        self.run(['/usr/bin/systemctl', 'daemon-reload'])
        for n in UNITS:
            a = self.properties(n, ('FragmentPath', 'DropInPaths', 'UnitFileState'))
            need(a == {'FragmentPath': '/etc/systemd/system/' + n, 'DropInPaths': '', 'UnitFileState': 'static'},
                 'development_merged_unit_mismatch')
        need(not os.path.lexists('/run/domino-dev-connector.reviewed'), 'connector_marker_present')

    def reload_peers(self):
        need(self.sql("SELECT (SELECT count(*) FROM pg_hba_file_rules WHERE error IS NOT NULL) + "
                      "(SELECT count(*) FROM pg_ident_file_mappings WHERE error IS NOT NULL);") == '0', 'peer_parse_error')
        need(self.sql('SELECT pg_reload_conf();') == 't', 'peer_reload_failed')

    def install_peers(self, c):
        self.check_peers(c)
        _, new = peer_bytes(c['baseline'])
        for p in PEERS:
            replace(p, new[p], uid=109, gid=113, parent_owners=(0, 109))
        self.reload_peers()
        self.check_peers(c, states=('new',))

    def peer_probes(self):
        """Actual credential/socket/peer checks; no application rows are fetched."""
        args = SimpleNamespace(socket='/run/postgresql-domino', port=8877)
        deadline = time.monotonic() + 90
        # Do not reuse production.socket_access: its role set intentionally
        # excludes dev. Collect the same effective-credential evidence here.
        users = {}
        code = ('import json,os;print(json.dumps(dict(uid=os.geteuid(),gid=os.getegid(),'
                'groups=sorted(set([os.getegid(),*os.getgroups()])),canTraverse='
                'os.access("/run/postgresql-domino",os.X_OK,effective_ids=True))))')
        for user, permitted in sql_profile.PEERS.items():
            proof = roles.json_result(roles.command(['/usr/sbin/runuser', '-u', user, '--',
                                      '/usr/bin/python3', '-I', '-B', '-c', code], deadline))
            need(proof is not None, 'peer_identity_unavailable')
            users[user] = proof
        pairs, selects = [], []
        for user, permitted in sql_profile.PEERS.items():
            for role in (*roles.ROLES, sql_profile.ROLE):
                result = roles.query(args, user, role, roles.IDENTITY_SQL, deadline, socket_denial=not permitted)
                allowed = role in permitted
                if allowed:
                    need(roles.json_result(result) == {'sessionUser': role, 'currentUser': role,
                         'database': 'domino_catalogue', 'readonly': True}, 'peer_identity_mismatch')
                pairs.append({'osUser': user, 'sqlRole': role, 'result': 'allowed' if allowed else result['status']})
            for role in permitted:
                for schema, tables in roles.TABLES.items():
                    result = roles.query(args, user, role,
                         f'SELECT count(*) FROM (SELECT 1 FROM {schema}.{tables[0]} LIMIT 0) AS no_rows;', deadline)
                    status = 'allowed' if result == {'status': 'ok', 'output': '0'} else result['status']
                    selects.append({'osUser': user, 'sqlRole': role, 'schema': schema, 'result': status})
        proof = {'users': users, 'peerMatrix': pairs, 'selectChecks': selects,
                 'ident': list(sql_profile.PEER_ADDITIONS['ident']), 'hba': list(sql_profile.PEER_ADDITIONS['hba'])}
        need(sql_profile.check_peer_evidence(proof), 'peer_boundary_failed')

    def off_health(self):
        targets = [(8890, '/health', 503), (8891, '/internal/dev/v1/status', 403)]
        # Public fixed errors only. These requests carry no credentials and the
        # exact OFF handlers do not call providers or the gateway JWKS transport.
        deadline = time.monotonic() + 20
        while True:
            try:
                for port, path, status in targets:
                    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=2)
                    try:
                        connection.request('GET', path)
                        response = connection.getresponse()
                        body = response.read(4097)
                        need(response.status == status and parse(body, 4096) == {'error': 'upstream_unavailable'},
                             'off_response_mismatch')
                    finally:
                        connection.close()
                return
            except (ConnectionError, TimeoutError, OSError):
                need(time.monotonic() < deadline, 'off_start_timeout')
                time.sleep(0.2)

    def drain(self):
        self.run(['/usr/bin/systemctl', 'stop', *STOP])
        for unit in STOP:
            a = self.properties(unit, ('MainPID', 'ActiveState', 'ControlGroup'))
            need(a.get('MainPID', '0') == '0' and a['ActiveState'] in ('inactive', 'failed'), 'dev_not_stopped')
            group = a.get('ControlGroup', '')
            if group:
                root = Path('/sys/fs/cgroup') / group.lstrip('/')
                need(group.startswith('/dominodev.slice/'), 'unexpected_dev_cgroup')
                if root.exists():
                    need(all(not p.read_text().strip() for p in root.rglob('cgroup.procs')), 'dev_cgroup_not_empty')
        self.no_dev_processes()


def journal(c, value=None, *, create=False):
    path = c['path'] / 'journal.json'
    if value is None:
        result = parse(read(path, mode=0o600))
        need(result['candidateSha256'] == c['digest'] and result['version'] == 1, 'journal_binding_mismatch')
        return result
    if create:
        write_new(path, encode(value))
    else:
        read(path, mode=0o600)
        replace(path, encode(value))


def installed_known(c, host):
    """Before any rollback action, reject altered unit/config bytes, even OFF."""
    for name, item in c['files'].items():
        if os.path.lexists(name):
            need(read(name, mode=item['mode'], uid=item['uid'], gid=item['gid'],
                 parent_owners=(0, item['uid'])) == item['bytes'], 'unknown_installed_file')
    for name in UNITS:
        for prefix in ('/etc/systemd/system', '/run/systemd/system'):
            need(not os.path.lexists(Path(prefix) / (name + '.d')), 'unexpected_dev_dropin')
        loaded = host.properties(name, ('FragmentPath', 'DropInPaths'))
        need(loaded.get('DropInPaths') == '' and loaded.get('FragmentPath') in (
             '', '/etc/systemd/system/' + name), 'unknown_loaded_development_unit')


def rollback(c, host, state):
    installed_known(c, host)
    state['phase'] = 'rollback'; journal(c, state)
    # Admission is already exactly false. Never overwrite an unreviewed enabled
    # admission. Drain known dev units only if their files were installed.
    if state.get('unitsInstalled'):
        host.drain()
    else:
        host.no_dev_processes()
    host.check_peers(c, states=('old', 'new'))
    old, _ = peer_bytes(c['baseline'])
    for p in PEERS:
        if read(p, mode=0o600, uid=109, gid=113, parent_owners=(0, 109)) != old[p]:
            replace(p, old[p], uid=109, gid=113, parent_owners=(0, 109))
    host.reload_peers()
    # Observed state resolves a timeout/connection loss around COMMIT. Unknown
    # grants/sessions cannot trigger a destructive guessed rollback.
    now = host.snapshot_sql()
    if now == c['sql']['expectedAfter']:
        host.sql(c['sql']['rollbackSql'])
    else:
        need(now == c['baseline']['postgresSnapshot'], 'unknown_sql_state_retained')
    need(host.snapshot_sql() == c['baseline']['postgresSnapshot'], 'sql_rollback_mismatch')
    host.check_peers(c)
    host.production(c, dev=True, extra=state['productionExtra'])
    state.update(phase='rolled_back', retainedInertFiles=True, retainedDevIdentities=True)
    journal(c, state)


def finish_off(c, host, state):
    """Shared forward path for fresh installation and the one staged recovery."""
    extra = state['productionExtra']
    state['phase'] = 'sql'; journal(c, state)
    host.sql(c['sql']['applySql'])
    state['phase'] = 'peers'; journal(c, state)
    host.install_peers(c)
    host.peer_probes()
    need(host.snapshot_sql() == c['sql']['expectedAfter'], 'sql_post_state_mismatch')
    host.production(c, extra=extra)
    state['phase'] = 'start_off'; journal(c, state)
    host.run(['/usr/bin/systemctl', 'start', 'domino-dev-off.target'])
    host.off_health()
    tunnel = host.properties('domino-dev-tunnel.service', ('MainPID', 'ActiveState'))
    need(tunnel == {'MainPID': '0', 'ActiveState': 'inactive'}, 'connector_not_inactive')
    host.production(c, dev=True, extra=extra)
    state.update(phase='installed_off', nativeBoundaryQualified=False)
    journal(c, state)


def recover_failure(c, host, state):
    try:
        rollback(c, host, state)
    except BaseException:
        raise Refused('apply_failed_cleanup_incomplete_inspect_private_journal') from None
    raise Refused('apply_failed_rolled_back_inert_artifacts_retained') from None


def resume_staged(c, host):
    state = journal(c)
    # All checks happen before journal changes or SQL; drift does not authorize
    # cleanup/repair of artifacts that may belong to another operator action.
    host.staged(c, state)
    try:
        host.unit_check(c)
        host.production(c, extra=state['productionExtra'])
        finish_off(c, host, state)
    except BaseException:
        recover_failure(c, host, state)


def apply(c, host):
    need(not os.path.lexists(c['path'] / 'journal.json'), 'journal_already_exists')
    extra = host.check(c)
    state = {'version': 1, 'candidateSha256': c['digest'], 'phase': 'prepared',
             'productionExtra': extra, 'unitsInstalled': False}
    journal(c, state, create=True)
    try:
        state['phase'] = 'identities'; journal(c, state)
        host.identities()
        state['phase'] = 'files'; journal(c, state)
        host.stage(c)
        state['unitsInstalled'] = True; journal(c, state)
        host.unit_check(c)
        host.production(c, extra=extra)
        finish_off(c, host, state)
    except BaseException:
        # SIGKILL/power loss is recovered by explicit rollback using the same
        # journal. Catchable failures attempt only the fixed known-state teardown.
        recover_failure(c, host, state)


@contextmanager
def locked():
    path = Path('/opt/domino/.disabled-install.lock')
    read(path, mode=0o600)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as stream:
        need(os.fstat(stream.fileno()).st_ino == path.lstat().st_ino, 'lock_changed')
        fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('mode', choices=('check', 'apply', 'rollback', 'resume-staged'))
    p.add_argument('--candidate', type=Path, required=True)
    p.add_argument('--sha256', required=True)
    args = p.parse_args()
    try:
        need(os.geteuid() == 0 and not sys.flags.optimize, 'root_without_optimization_required')
        os.umask(0o077)
        c = candidate(args.candidate, args.sha256)
        host = Native()
        with locked():
            if args.mode == 'check':
                host.check(c)
            elif args.mode == 'apply':
                apply(c, host)
            elif args.mode == 'resume-staged':
                resume_staged(c, host)
            else:
                state = journal(c)
                need(state['phase'] != 'rolled_back', 'already_rolled_back')
                rollback(c, host, state)
        print(json.dumps({'ok': True, 'mode': args.mode, 'candidateSha256': c['digest'],
                          'liveEnabled': False, 'nativeBoundaryQualified': False}))
    except (OSError, ValueError, KeyError, TypeError):
        # Never include SQL/output/config/path contents in external diagnostics.
        p.exit(1, 'Development OFF operation refused; inspect the private candidate/journal.\n')


if __name__ == '__main__':
    main()
