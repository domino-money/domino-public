#!/usr/bin/env python3
"""Install the pinned interpreter and the two service virtual environments. Starts nothing.

Step 2 of docs/FRESH_HOST_INSTALL.md. On the first VM these were built by hand
on 10 and 15 Sep 2026 (`pyvenv.cfg` names uv 0.12.13). This reproduces them:

- uv 0.12.13 from the operator-downloaded release tarball, checked against the
  pinned digest, at /usr/local/bin/uv;
- CPython 3.14.7 installed by that uv under /opt/domino/python (uv verifies the
  interpreter download against its own pinned checksums);
- /opt/domino/backend-venv: every release's shared interpreter, with exactly the
  locked distributions plus pip 26.2.1, which prepare_disabled.py runs `pip check`
  with;
- /opt/domino/queue-worker/venv: the writer's interpreter, the same lock, no pip.

The lock is read from a verified release archive, the same one prepare_disabled.py
installs next, so both see one file. Every path is root-owned and not writable by
group or others, which prepare_disabled.py's dependency preflight requires.

This is the only step that reaches a network: GitHub for the interpreter, PyPI
for the exact pins (installed without dependency resolution, `--no-deps`; the lock
is the full closure and `pip check` proves it).
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tarfile
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prepare_disabled as install

require = install.require
UV_VERSION = '0.12.13'
UV_ASSET = 'uv-x86_64-unknown-linux-gnu.tar.gz'
UV_URL = f'https://github.com/astral-sh/uv/releases/download/{UV_VERSION}/{UV_ASSET}'
UV_SHA256 = '745765a3b6e360ad76743599ae5c42e9278c7edf8bbff9fc76d05bf2623a04dd'
UV = Path('/usr/local/bin/uv')
PYTHON_VERSION = '3.14.7'
PYTHONS = install.BASE / 'python'
INTERPRETER = PYTHONS / f'cpython-{PYTHON_VERSION}-linux-x86_64-gnu/bin/python3.14'
PIP = 'pip==26.2.1'
LOCK = 'backend/requirements-api.lock'
# venv -> extra distributions beyond the lock.
VENVS = {install.VENV: (PIP,), install.BASE / 'queue-worker/venv': ()}
# pip installs itself, as on the first VM: CPython 3.14.7 bundles pip 26.2.1, and
# --default-pip writes the pip, pip3 and pip3.14 scripts the first VM has.
PIP_ENV = {'PIP_CONFIG_FILE': '/dev/null', 'PIP_NO_INPUT': '1', 'PIP_DISABLE_PIP_VERSION_CHECK': '1'}


def locked(payload):
    """The lock's exact pins, normalized like prepare_disabled.py compares them."""
    pins = {}
    for line in payload.decode().splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        require(re.fullmatch(r'[A-Za-z0-9_.-]+==[A-Za-z0-9_.+-]+', line), 'lock_must_contain_exact_pins')
        name, version = line.split('==')
        pins[re.sub('[-_.]+', '-', name).lower()] = version
    require(pins, 'lock_empty')
    return pins


def uv_binary(path):
    """The single `uv` executable from the verified release tarball."""
    payload = Path(path).read_bytes()
    require(hashlib.sha256(payload).hexdigest() == UV_SHA256, 'uv_archive_sha256_mismatch')
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as archive:
        member = archive.getmember('uv-x86_64-unknown-linux-gnu/uv')
        require(member.isfile() and 0 < member.size <= 128 * 1024 * 1024, 'uv_member_invalid')
        return archive.extractfile(member).read()


def plan(files, commit, digest, uv_archive):
    pins = locked(files[LOCK][0])
    uv_binary(uv_archive)
    for path in (UV, PYTHONS, *VENVS):
        require(not os.path.lexists(path), 'runtime_path_exists')
    return {'mode': 'runtimes', 'lockFrom': {'commit': commit, 'archiveSha256': digest},
            'lockSha256': hashlib.sha256(files[LOCK][0]).hexdigest(), 'distributions': len(pins),
            'uv': {'version': UV_VERSION, 'sha256': UV_SHA256, 'path': str(UV)},
            'python': {'version': PYTHON_VERSION, 'interpreter': str(INTERPRETER)},
            'venvs': {str(venv): ['lock', *extra] for venv, extra in VENVS.items()},
            'notPerformed': ['Domino release, unit, database or service change', 'Node.js']}


def environment(cache):
    """uv sees no user or system configuration, and keeps its cache outside the trees.

    The install directory is named only for `uv python install`. Given it, `uv venv`
    treats the interpreter as managed and records the minor-version link instead
    of the 3.14.7 directory the first VM's environments name.
    """
    return {**install.ENV, 'HOME': '/root', 'UV_NO_CONFIG': '1', 'UV_CACHE_DIR': str(cache),
            'UV_PYTHON_DOWNLOADS': 'manual'}


def run(args, env, timeout=900):
    """Like prepare_disabled.run, with this step's environment and time for downloads."""
    process = subprocess.run(args, env=env, capture_output=True, timeout=timeout)
    require(process.returncode == 0, f'command failed: {Path(args[0]).name} {args[1]}')
    return process.stdout


def uv(args, env):
    return run([str(UV), *args], env)


def check_venv(venv, pins, extra):
    """Exactly the locked distributions (plus `extra`), on the pinned interpreter."""
    code = ("import importlib.metadata as m,json,re,sys; assert sys.version_info[:3]==(3,14,7);"
            "print(json.dumps({re.sub('[-_.]+','-',d.metadata['Name']).lower():d.version for d in m.distributions()}))")
    installed = json.loads(install.run([str(venv / 'bin/python3.14'), '-I', '-B', '-c', code]))
    expected = {**pins, **dict(item.split('==') for item in extra)}
    require(installed == expected, 'venv_distributions_differ_from_lock')
    if extra:
        install.run([str(venv / 'bin/python3.14'), '-I', '-B', '-m', 'pip', 'check'])
    return len(installed)


def trusted_tree(root):
    """Root-owned, nothing group- or world-writable: what dependency_preflight walks."""
    for directory, dirs, names in os.walk(root, followlinks=False):
        for name in (directory, *[os.path.join(directory, n) for n in dirs + names]):
            info = os.lstat(name)
            require(info.st_uid == 0 and (stat.S_ISLNK(info.st_mode) or not info.st_mode & 0o022),
                    'runtime_tree_not_root_owned')


def apply(files, planned, uv_archive):
    require(os.geteuid() == 0, 'root_required')
    os.umask(0o022)
    pins = locked(files[LOCK][0])
    binary = uv_binary(uv_archive)
    install.exclusive_file(UV, binary, 0o755)
    with tempfile.TemporaryDirectory(prefix='domino-runtimes-', dir='/root') as scratch:
        env = environment(Path(scratch) / 'cache')
        lock = Path(scratch) / 'requirements-api.lock'
        lock.write_bytes(files[LOCK][0])
        require(uv(['--version'], env).decode().split()[1] == UV_VERSION, 'uv_version_mismatch')
        uv(['python', 'install', '--no-bin', PYTHON_VERSION], {**env, 'UV_PYTHON_INSTALL_DIR': str(PYTHONS)})
        require(INTERPRETER.is_file(), 'interpreter_missing_after_install')
        counts = {}
        for venv, extra in VENVS.items():
            venv.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            uv(['venv', '--python', str(INTERPRETER), str(venv)], env)
            # `bin/python` gives entry-point scripts the first VM's `#!.../bin/python` line.
            uv(['pip', 'install', '--python', str(venv / 'bin/python'), '--no-deps', '-r', str(lock)], env)
            if extra:
                python = str(venv / 'bin/python3.14')
                pip_env = {**env, **PIP_ENV}
                run([python, '-I', '-m', 'ensurepip', '--default-pip'], pip_env)
                run([python, '-I', '-m', 'pip', 'install', '--no-deps', *extra], pip_env)
            counts[str(venv)] = check_venv(venv, pins, extra)
    # uv leaves its interpreter lock file world-writable; nothing else may be.
    for root in (PYTHONS, *VENVS):
        lockfile = root / '.lock'
        if lockfile.exists():
            os.chmod(lockfile, 0o644)
        trusted_tree(root)
    return {**planned, 'ok': True, 'installed': counts}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True,
                        help='the release archive prepare_disabled.py installs next')
    parser.add_argument('--archive-sha256', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--uv-archive', type=Path, required=True, help=f'{UV_URL}, downloaded')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--inspect', action='store_true')
    mode.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    try:
        files = install.archive_files(args.archive, args.archive_sha256, args.commit)
        planned = plan(files, args.commit, args.archive_sha256, args.uv_archive)
        result = apply(files, planned, args.uv_archive) if args.apply else {**planned, 'ok': True, 'installed': False}
        print(json.dumps(result, indent=2))
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(json.dumps({'ok': False, 'reason': reason,
                          'action': 'stop; remove the partial runtime paths before any retry'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
