#!/usr/bin/env python3
"""Run the session listener from a newer release. Starts, stops and reloads nothing.

The financial upgrade installed domino-auth once, from the foundation, and it
refuses a host that already carries the financial schemas, so nothing has moved
the listener since. This tool writes one release beside the running one, laid
out as the financial upgrade laid out its own, and one drop-in that names it:
the working directory and the bind of the listener's private runtime, taken
from the unit the financial upgrade would write for that release. The unit file
stays exactly as that upgrade wrote it.

A producer from issue #182 on writes no admission generation, and migration
011's trigger refuses such a session on its own, so the database must already
have 027. Whether it does is the one thing read from the database.

Activation stays with the operator: daemon-reload, then start the listener, or,
once the continuous egress policy makes it a member of
domino-continuous-reads.target, restart that target and never the member.
Rollback puts back the drop-in that was there before, or its absence; releases
and receipts stay. A commit is applied once: after a failed or rolled-back
apply, install a new commit, or remove that release directory by hand first.
"""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_filesystem as filesystem
import prepare_disabled as install
import upgrade_financial as financial
from install_read_release import read_installed

require = install.require
COMPONENT = 'auth'
UNIT = f'domino-{COMPONENT}.service'
UNIT_FILE = install.UNIT_DIR / UNIT
DROPIN = install.UNIT_DIR / f'{UNIT}.d' / '50-release.conf'
# The continuous egress policy's activation drop-in may sit beside this one.
EGRESS_DROPIN = install.UNIT_DIR / f'{UNIT}.d' / '60-continuous-reads.conf'
RELEASES = financial.ROOT / 'releases'
RECEIPTS = Path('/var/backups/domino-auth-release')
# The financial installer's lock: both write under the same release root.
LOCK = install.BASE / '.financial-install.lock'
TARGET = 'domino-continuous-reads.target'
LOCKFILE = 'backend/requirements-api.lock'
CONTRACT = re.compile(r"^CONTRACT_VERSION = '([^'\n]+)'$", re.M)
# Migration 011's session gate, which 027 drops.
GATE = ("SELECT count(*) FROM pg_catalog.pg_trigger "
        "WHERE tgname='wallet_access_session_insert' AND NOT tgisinternal;")
HEADER = ('# Written by scripts/staging/install_auth_release.py: the release this listener\n'
          '# runs. The unit file keeps the release it was installed with.\n')


def sha(payload):
    return hashlib.sha256(payload).hexdigest()


def dropin_text(commit):
    """What names a release in the unit the financial upgrade would write for it."""
    lines = financial.unit_text(COMPONENT, commit).splitlines()

    def line(key):
        return next(value for value in lines if value.startswith(key + '='))
    # BindPaths is a list: the empty assignment drops the unit's own bind first.
    return HEADER + '\n'.join(('[Unit]', line('Description'), '', '[Service]',
                               line('WorkingDirectory'), 'BindPaths=', line('BindPaths'))) + '\n'


def release_of(path):
    """The commit a listener root names, or None for any other directory."""
    root = Path(path)
    if root.name != COMPONENT or root.parent.parent != RELEASES:
        return None
    return root.parent.name if re.fullmatch('[0-9a-f]{40}', root.parent.name) else None


def loaded():
    """The unit as systemd has it loaded, which is what the next start runs."""
    raw = install.run(['/usr/bin/systemctl', 'show', UNIT, '--property=LoadState,ActiveState,'
                       'NeedDaemonReload,FragmentPath,DropInPaths,WorkingDirectory']).decode()
    return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)


def target_members():
    raw = install.run(['/usr/bin/systemctl', 'show', TARGET, '--property=Requires', '--value'])
    return raw.decode().split()


def gate_present():
    return install.sql(GATE) != '0'


def current():
    """The release the listener runs now, and the files that make it so."""
    state = loaded()
    require(state.get('LoadState') == 'loaded', 'auth_unit_not_loaded')
    require(state.get('FragmentPath') == str(UNIT_FILE), 'auth_unit_moved')
    # A file changed since the last reload: what is loaded and what is on disk differ.
    require(state.get('NeedDaemonReload') == 'no', 'daemon_reload_pending')
    dropins = state.get('DropInPaths', '').split()
    require(set(dropins) <= {str(DROPIN), str(EGRESS_DROPIN)}, 'foreign_auth_dropin')
    require((str(DROPIN) in dropins) == (DROPIN.exists() or DROPIN.is_symlink()), 'daemon_reload_pending')
    unit = read_installed(UNIT_FILE, 65536).decode()
    match = re.search(r'^WorkingDirectory=(.*)$', unit, re.M)
    installed = release_of(match.group(1)) if match else None
    require(installed is not None, 'auth_unit_not_financial')
    require(unit == financial.unit_text(COMPONENT, installed), 'auth_unit_drift')
    running = release_of(state.get('WorkingDirectory', ''))
    require(running is not None, 'auth_release_mismatch')
    previous = read_installed(DROPIN, 65536).decode() if str(DROPIN) in dropins else None
    if previous is None:
        require(running == installed, 'auth_release_mismatch')
    else:
        require(previous == dropin_text(running), 'auth_dropin_drift')
    return state, installed, running, previous


def plan(files, commit, digest):
    state, installed, running, previous = current()
    require(commit != running, 'release_already_running')
    root = RELEASES / commit / COMPONENT
    require(not root.exists() and not root.is_symlink(), 'release_directory_exists')
    # The shared interpreter satisfies the running release's lock and nothing newer.
    require(sha(files[LOCKFILE][0]) == sha(read_installed(RELEASES / running / COMPONENT / LOCKFILE)),
            'dependency_change_needs_a_venv')
    models = files.get('backend/session_models.py')
    contract = CONTRACT.search(models[0].decode()) if models else None
    require(contract is not None, 'session_contract_missing')
    require(not gate_present(), 'migration_027_not_applied')
    return {'schemaVersion': 1, 'mode': 'auth-release-install', 'commit': commit, 'archiveSha256': digest,
            'sessionContract': contract.group(1), 'fromCommit': running, 'unitCommit': installed,
            'target': str(root), 'dropin': str(DROPIN), 'dropinSha256': sha(dropin_text(commit).encode()),
            'previousDropin': previous, 'serviceActive': state.get('ActiveState') == 'active',
            'continuousTargetMember': UNIT in target_members(),
            'notPerformed': ['service start, stop, restart or daemon-reload', 'unit file change',
                             'database writes or migrations', 'dependency install',
                             'private configuration or secret reads', 'egress, Access or Tunnel change',
                             'release deletion']}


def write_new(path, payload, mode):
    """One file that must not exist yet, with exactly this mode whatever the umask."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as stream:
        os.fchmod(stream.fileno(), mode)
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())


def replace(path, payload, mode):
    """Readers see the old file or the new one, never a part of either."""
    temporary = path.with_name(f'.{path.name}.{uuid.uuid4().hex}')
    write_new(temporary, payload, mode)
    try:
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()
    install.fsync_directory(path.parent)


def discard(path):
    if not path.exists():
        return
    for directory, _, _ in os.walk(path):
        os.chmod(directory, 0o700)
    shutil.rmtree(path)


def install_source(files, commit):
    """The backend tree, staged under a private name and renamed into place at once."""
    require(RELEASES.stat().st_mode & 0o001, 'release_directory_not_traversable')
    release = RELEASES / commit
    created = not release.exists()
    if created:
        release.mkdir(mode=0o755)
    else:
        # The listener's user must traverse it; another installer may have left it closed.
        filesystem.protected_parents(release)
        require(release.stat().st_mode & 0o001, 'release_directory_not_traversable')
    staging = release / f'.{COMPONENT}-{uuid.uuid4().hex}'
    try:
        staging.mkdir(mode=0o700)
        for name, (payload, executable) in sorted(files.items()):
            if not name.startswith('backend/') or name.startswith('backend/tests/'):
                continue
            path = staging / name
            path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            write_new(path, payload, 0o555 if executable else 0o444)
        # The mount point the unit binds the listener's private runtime over.
        (staging / 'backend/runtime').mkdir(mode=0o700)
        for path, _, _ in os.walk(staging, topdown=False):
            os.chmod(path, 0o555)
        require(not (release / COMPONENT).exists(), 'release_directory_exists')
        os.rename(staging, release / COMPONENT)
        if created:
            # Explicit, whatever the umask: 0700 here would stop the listener's user.
            os.chmod(release, 0o555)
    except BaseException:
        discard(staging)
        if created:
            # Only while empty: a failure after the rename leaves the release in place.
            with contextlib.suppress(OSError):
                release.rmdir()
        raise


def write_dropin(text):
    directory = DROPIN.parent
    if not directory.exists():
        filesystem.protected_parents(directory.parent)
        directory.mkdir(mode=0o755)
        os.chmod(directory, 0o755)
    filesystem.protected_parents(directory)
    replace(DROPIN, text.encode(), 0o644)


def private_directory(path):
    if not path.exists():
        filesystem.protected_parents(path.parent)
        path.mkdir(mode=0o700)
    filesystem.protected_parents(path)
    require(stat.S_IMODE(path.lstat().st_mode) == 0o700, 'receipt_directory_not_private')


def activation(planned):
    if planned['continuousTargetMember']:
        return (f'systemctl daemon-reload; then systemctl restart {TARGET}, never the listener '
                'alone: a member stopped or restarted takes the tunnel with it')
    return 'systemctl daemon-reload; the listener runs this release from its next start'


def apply(files, planned):
    require(os.geteuid() == 0, 'root_required')
    filesystem.protected_parents(RELEASES)
    filesystem.protected_parents(install.UNIT_DIR)
    private_directory(RECEIPTS)
    commit = planned['commit']
    receipt = RECEIPTS / f'{commit}.json'
    require(not receipt.exists() and not receipt.is_symlink(), 'receipt_exists')
    # Written first, so the drop-in it records can always be put back.
    write_new(receipt, (json.dumps(planned, indent=2, sort_keys=True) + '\n').encode(), 0o600)
    try:
        install_source(files, commit)
    except BaseException:
        receipt.unlink()
        raise
    write_dropin(dropin_text(commit))
    return {'ok': True, 'mode': planned['mode'], 'commit': commit, 'fromCommit': planned['fromCommit'],
            'sessionContract': planned['sessionContract'], 'target': planned['target'],
            'dropin': planned['dropin'], 'receipt': str(receipt), 'installed': True, 'activated': False,
            'activation': activation(planned),
            'rollback': f'install_auth_release.py --rollback {commit} (files only; reload and restart separately)'}


def rollback(commit):
    require(os.geteuid() == 0, 'root_required')
    require(re.fullmatch('[0-9a-f]{40}', commit) is not None, 'invalid_commit')
    receipt = RECEIPTS / f'{commit}.json'
    filesystem.protected_parents(receipt)
    saved = json.loads(read_installed(receipt, 1024 * 1024))
    require(saved.get('mode') == 'auth-release-install' and saved.get('commit') == commit, 'invalid_receipt')
    back, previous = saved.get('fromCommit'), saved.get('previousDropin')
    require(isinstance(back, str) and re.fullmatch('[0-9a-f]{40}', back) is not None
            and (previous is None or previous == dropin_text(back)), 'invalid_receipt')
    require((RELEASES / back / COMPONENT).is_dir(), 'previous_release_missing')
    present = DROPIN.exists() or DROPIN.is_symlink()
    now = read_installed(DROPIN, 65536).decode() if present else None
    require(now in (dropin_text(commit), previous), 'rollback_is_not_current')
    if previous is not None:
        write_dropin(previous)
    elif present:
        filesystem.protected_parents(DROPIN.parent)
        DROPIN.unlink()
        install.fsync_directory(DROPIN.parent)
    return {'ok': True, 'mode': 'auth-release-rollback', 'commit': commit, 'runs': back,
            'activated': False, 'releaseRetained': True,
            'action': 'daemon-reload, then restart the listener the way it was started'}


@contextlib.contextmanager
def exclusive():
    filesystem.protected_parents(install.BASE)
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'rb+'):
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600
                and info.st_nlink == 1, 'unsafe_install_lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--archive-sha256')
    parser.add_argument('--commit')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--inspect', action='store_true')
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--rollback', metavar='COMMIT')
    args = parser.parse_args(argv)
    try:
        # Inspection reads the database's triggers, so it needs root as well.
        require(os.geteuid() == 0, 'root_required')
        if args.rollback:
            with exclusive():
                result = rollback(args.rollback)
        else:
            require(args.archive and args.archive_sha256 and args.commit, 'archive_arguments_required')
            files = install.archive_files(args.archive, args.archive_sha256, args.commit)
            if args.inspect:
                result = {**plan(files, args.commit, args.archive_sha256), 'ok': True, 'installed': False}
            else:
                with exclusive():
                    result = apply(files, plan(files, args.commit, args.archive_sha256))
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(json.dumps({'ok': False, 'reason': reason,
                          'action': 'nothing started, stopped or reloaded; a receipt records any apply that began'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
