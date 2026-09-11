#!/usr/bin/env python3
"""Read-only root check of immutable code, protected dependencies and UID isolation.

Open each descriptor read-only under all seven service UIDs, without reading its
contents. Runtime directories are writable only by their respective service;
code is immutable and the root-managed venv is unwritable by service users.
"""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import subprocess
import time


RELEASES = Path('/opt/domino/releases')
VENV = Path('/opt/domino/backend-venv')
COMPONENTS = ('read', 'gateway', 'auth', 'onboarding', 'deposit', 'operator', 'write')
MAX_ENTRIES = 200000
TOTAL_SECONDS = 120
PROBE = """
import json, os, stat, sys
paths = json.loads(sys.argv[1])
component = sys.argv[2]
descriptors = {}
for name, path in paths.items():
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except PermissionError:
        descriptors[name] = False
    else:
        try:
            if not stat.S_ISREG(os.fstat(fd).st_mode):
                raise ValueError('descriptor_not_regular')
            descriptors[name] = True
        finally:
            os.close(fd)
print(json.dumps({
    'uid': os.geteuid(), 'descriptors': descriptors,
    'runtimeWritable': os.access(os.path.dirname(paths[component]), os.W_OK | os.X_OK, effective_ids=True),
    'codeWritable': os.access(sys.argv[3], os.W_OK, effective_ids=True),
    'venvWritable': os.access(sys.argv[4], os.W_OK, effective_ids=True),
}))
"""


def require(condition, reason):
    if not condition:
        raise ValueError(reason)


def remaining(deadline):
    seconds = deadline - time.monotonic()
    require(seconds > 0, 'filesystem_check_deadline')
    return seconds


def protected_parents(path):
    """No mutable or symlinked ancestor can redirect a trusted file target."""
    for entry in (path, *path.parents):
        info = entry.lstat()
        require(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode), 'untrusted_path_type')
        require(info.st_uid == 0 and not info.st_mode & 0o022, 'untrusted_path_permissions')


def walk_entries(root, deadline):
    """Surface walk errors and bound visits; callers handle links explicitly."""
    count = 0
    def walk_error(error):
        raise error
    for directory, dirs, files in os.walk(root, followlinks=False, onerror=walk_error):
        remaining(deadline)
        count += 1 + len(dirs) + len(files)
        require(count <= MAX_ENTRIES, 'filesystem_entry_limit')
        yield Path(directory), dirs, files


def check_code(root, runtime_paths, deadline):
    protected_parents(root)
    venv_links = {root / component / 'backend/.venv' for component in COMPONENTS}
    seen_links = set()
    for directory, dirs, files in walk_entries(root, deadline):
        info = directory.lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == 0
                and not info.st_mode & 0o222, 'code_directory_not_immutable')
        for name in list(dirs) + files:
            path = directory / name
            info = path.lstat()
            if path in runtime_paths:
                require(stat.S_ISDIR(info.st_mode), 'runtime_not_directory')
                dirs.remove(name)
            elif path in venv_links:
                require(stat.S_ISLNK(info.st_mode) and info.st_uid == 0
                        and os.readlink(path) == str(VENV)
                        and path.resolve(strict=True) == VENV, 'unexpected_venv_link')
                seen_links.add(path)
                if name in dirs:
                    dirs.remove(name)
            else:
                require(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode), 'unexpected_code_link_or_type')
                require(info.st_uid == 0 and not info.st_mode & 0o222, 'code_not_immutable')
                if stat.S_ISREG(info.st_mode):
                    require(info.st_nlink == 1, 'code_hardlink_not_allowed')
    require(seen_links == venv_links, 'venv_links_missing')


def check_venv(deadline):
    """Match installer policy, including root-controlled interpreter file links."""
    protected_parents(VENV)
    require(VENV.is_dir(), 'venv_not_directory')
    for directory, dirs, files in walk_entries(VENV, deadline):
        for path in (directory, *(directory / name for name in dirs + files)):
            info = path.lstat()
            require(info.st_uid == 0, 'venv_not_root_owned')
            if stat.S_ISLNK(info.st_mode):
                target = path.resolve(strict=True)
                require(not target.is_dir() or target.is_relative_to(VENV), 'venv_directory_link_leaves_environment')
                protected_parents(target)
            else:
                require(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode), 'unexpected_venv_type')
                require(not info.st_mode & 0o022, 'venv_writable_by_other_users')


def check_descriptor(runtime, account):
    directory = runtime.lstat()
    require(stat.S_ISDIR(directory.st_mode) and directory.st_uid == account.pw_uid
            and directory.st_gid == account.pw_gid
            and stat.S_IMODE(directory.st_mode) == 0o700, 'runtime_permissions_mismatch')
    descriptor = (runtime / 'catalogue-db.json').lstat()
    require(stat.S_ISREG(descriptor.st_mode) and descriptor.st_uid == account.pw_uid
            and descriptor.st_gid == account.pw_gid and descriptor.st_nlink == 1
            and stat.S_IMODE(descriptor.st_mode) == 0o600, 'descriptor_permissions_mismatch')


def probe(component, paths, code_path, deadline):
    argv = ['/usr/sbin/runuser', '-u', 'domino-' + component, '--', '/usr/bin/python3', '-I', '-B', '-c',
            PROBE, json.dumps(paths), component, str(code_path), str(VENV)]
    timeout = min(5, remaining(deadline))
    process = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env={'PATH': '/usr/sbin:/usr/bin:/bin', 'LC_ALL': 'C'}, start_new_session=True)
    try:
        stdout, stderr = process.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise ValueError('uid_probe_timeout') from None
    require(process.returncode == 0, 'uid_probe_failed')
    require(len(stdout) <= 16384 and len(stderr) <= 16384, 'uid_probe_output_limit')
    return json.loads(stdout)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--commit', required=True)
    args = parser.parse_args(argv)
    report = {'ok': False, 'effectiveUserChecks': [], 'descriptorAccessPairs': 0,
              'rootOwnedImmutableCode': False, 'rootOwnedProtectedVenv': False}
    deadline = time.monotonic() + TOTAL_SECONDS
    try:
        require(os.geteuid() == 0, 'root_required')
        require(re.fullmatch('[0-9a-f]{40}', args.commit), 'invalid_commit')
        root = RELEASES / args.commit
        accounts = {component: pwd.getpwnam('domino-' + component) for component in COMPONENTS}
        uids = [account.pw_uid for account in accounts.values()]
        require(0 not in uids and len(set(uids)) == len(COMPONENTS), 'service_uids_must_be_distinct_nonroot')
        runtimes = {component: root / component / 'backend/runtime' for component in COMPONENTS}
        paths = {component: str(runtime / 'catalogue-db.json') for component, runtime in runtimes.items()}
        check_code(root, set(runtimes.values()), deadline)
        report['rootOwnedImmutableCode'] = True
        check_venv(deadline)
        report['rootOwnedProtectedVenv'] = True
        for component, runtime in runtimes.items():
            check_descriptor(runtime, accounts[component])
        for component in COMPONENTS:
            result = probe(component, paths, root / component / 'backend/read_api.py', deadline)
            expected = {'uid': accounts[component].pw_uid,
                'descriptors': {name: name == component for name in COMPONENTS},
                'runtimeWritable': True, 'codeWritable': False, 'venvWritable': False}
            report['effectiveUserChecks'].append({'service': component, 'ok': result == expected,
                                                  'isolatedDescriptors': len(COMPONENTS)})
            report['descriptorAccessPairs'] += len(COMPONENTS)
        report['ok'] = report['descriptorAccessPairs'] == 49 and all(row['ok'] for row in report['effectiveUserChecks'])
    except (ValueError, KeyError, OSError, RuntimeError, TypeError) as error:
        report['error'] = str(error) if isinstance(error, ValueError) and not isinstance(error, json.JSONDecodeError) else type(error).__name__
    print(json.dumps(report, indent=2))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
