#!/usr/bin/env python3
"""Run the automation and its two gas peers from a newer release.
Starts, stops and reloads nothing.

The automation installer and its readiness upgrade are one-shot, and nothing
else moves the three units that run from the automation release:
domino-automation, domino-gas-reservation and domino-gas-settlement. This tool
does for them what install_financial_release.py does for execution-status. It
writes one release beside the running one, the backend tree under
/opt/domino/financial/releases/<commit>/automation, and one drop-in per unit
that names it: the description and the working directory, and for the
automation its runtime bind, taken from the unit the automation installer would
write for that release. The unit files stay as the installer or the readiness
upgrade wrote them, the keystore drop-in the configuration generator writes
stays beside the automation's, and the private runtime under
/var/lib/domino-financial/automation carries over.

The three move together: they share one release tree and one schema. A release
is admitted only when it carries the automation installer this tool takes the
units and the migrations from, and when every automation migration it lists is
applied here with the same bytes, as the install and readiness receipts record.
A new migration needs its own step first; new code never meets an old schema.

Activation stays with the operator: daemon-reload, then start or restart the
units. Rollback puts back the drop-ins that were there before, or their absence;
releases and receipts stay. A commit is applied once: after a failed or
rolled-back apply, install a new commit, or remove its release directory by hand
first.
"""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_filesystem as filesystem
import install_automation as automation
import install_financial_release as release_tool
import prepare_disabled as install
from install_read_release import read_installed

require = install.require
auth = release_tool.auth
sha = release_tool.sha
COMPONENT = automation.COMPONENT
# Each unit by the name its drop-in directory goes under: domino-<name>.service.d.
UNITS = ('automation', 'gas-reservation', 'gas-settlement')
# backend/configure_automation.py writes it: the unit's keystore passwords, as encrypted credentials.
KEYSTORE_DROPIN = '40-keystore-credentials.conf'
# Where the release carries the installer this tool reads the units and the migrations from.
INSTALLER = 'scripts/staging/install_automation.py'
BACKUPS = Path('/var/backups')
LOCK = install.BASE / '.automation-install.lock'
INSTALL_RECEIPT = 'domino_automation_install.receipt'
READINESS_RECEIPT = 'domino_automation_install.readiness_upgrade_receipt'
HEADER = ('# Written by scripts/staging/install_automation_release.py: the release this unit\n'
          '# runs. The unit file keeps the release it was installed with.\n')


def service(name):
    return f'domino-{name}.service'


def unit_text(name, commit):
    """The unit the automation installer writes for this commit."""
    if name == 'automation':
        return automation.unit_text(commit)
    return automation.peer_unit_texts(commit)[service(name)]


def dropin(name):
    """This tool's drop-in, named as install_financial_release names its own."""
    return release_tool.dropins(name)[0]


def receipts():
    return BACKUPS / 'domino-automation-release'


def dropin_text(name, commit):
    """What names a release in the unit the automation installer would write for it."""
    lines = unit_text(name, commit).splitlines()

    def line(key):
        return next(value for value in lines if value.startswith(key + '='))
    body = ['[Unit]', line('Description'), '', '[Service]', line('WorkingDirectory')]
    if name == 'automation':
        # BindPaths and BindReadOnlyPaths share one list in systemd, so the empty
        # assignment that drops the old runtime bind drops the read-only
        # configuration bind too: both come back from the unit for this release.
        body += ['BindPaths=', line('BindPaths'), line('BindReadOnlyPaths')]
    return HEADER + '\n'.join(body) + '\n'


def current(name):
    """The release the unit runs now, the commit its unit file names, and this tool's loaded drop-in."""
    unit = release_tool.UNIT_DIR / service(name)
    ours = dropin(name)
    state = release_tool.loaded(name)
    require(state.get('LoadState') == 'loaded', 'unit_not_loaded')
    require(state.get('FragmentPath') == str(unit), 'unit_moved')
    # A file changed since the last reload: what is loaded and what is on disk differ.
    require(state.get('NeedDaemonReload') == 'no', 'daemon_reload_pending')
    paths = state.get('DropInPaths', '').split()
    allowed = {str(ours), *([str(ours.with_name(KEYSTORE_DROPIN))] if name == 'automation' else [])}
    require(set(paths) <= allowed, 'foreign_dropin')
    require((str(ours) in paths) == (ours.exists() or ours.is_symlink()), 'daemon_reload_pending')
    text = read_installed(unit, 65536).decode()
    match = re.search(r'^WorkingDirectory=(.*)$', text, re.M)
    installed = release_tool.release_of(COMPONENT, match.group(1)) if match else None
    require(installed is not None, 'unit_not_automation')
    require(text == unit_text(name, installed), 'unit_drift')
    running = release_tool.release_of(COMPONENT, state.get('WorkingDirectory', ''))
    require(running is not None, 'release_mismatch')
    previous = read_installed(ours, 65536).decode() if str(ours) in paths else None
    if previous is None:
        require(running == installed, 'release_mismatch')
    else:
        require(previous == dropin_text(name, running), 'dropin_drift')
    return state, installed, running, previous


def exists(table):
    return install.sql(f"SELECT to_regclass('{table}') IS NOT NULL;") == 't'


def applied_migrations():
    """Every automation migration applied here, by path, with the digest its receipt records."""
    require(exists(INSTALL_RECEIPT), 'automation_install_receipt_missing')
    raw = install.sql(f'SELECT value::text FROM {INSTALL_RECEIPT} WHERE singleton=true;')
    require(raw != '', 'automation_install_receipt_missing')
    first = json.loads(raw)
    require(isinstance(first, dict) and isinstance(first.get('migrations'), list), 'automation_receipt_invalid')
    rows = list(first['migrations'])
    if exists(READINESS_RECEIPT):
        rows += json.loads(install.sql(
            "SELECT coalesce(json_agg(json_build_object('path',migration_path,'sha256',sha256)),'[]'::json)::text "
            f'FROM {READINESS_RECEIPT};'))
    recorded = {}
    for row in rows:
        require(isinstance(row, dict) and isinstance(row.get('path'), str) and isinstance(row.get('sha256'), str)
                and recorded.setdefault(row['path'], row['sha256']) == row['sha256'], 'automation_receipt_invalid')
    return recorded


def plan(files, commit, digest):
    # The units and the migrations below are this tool's installer's: they must be the release's own.
    require(files.get(INSTALLER, (None,))[0] == Path(automation.__file__).read_bytes(),
            'installer_differs_from_release')
    units = {name: current(name) for name in UNITS}
    running = {unit[2] for unit in units.values()}
    # One release for all three: they share its tree and its schema.
    require(len(running) == 1, 'release_mismatch')
    running = running.pop()
    require(commit != running, 'release_already_running')
    root = release_tool.RELEASES / commit / COMPONENT
    require(not root.exists() and not root.is_symlink(), 'release_directory_exists')
    # The shared interpreter satisfies the running release's lock and nothing newer.
    lockfile = release_tool.LOCKFILE
    require(sha(files[lockfile][0]) == sha(read_installed(release_tool.RELEASES / running / COMPONENT / lockfile)),
            'dependency_change_needs_a_venv')
    for name in UNITS:
        script = re.search(r' -B (backend/\S+) ', unit_text(name, commit)).group(1)
        require(script in files, 'entry_script_missing')
    recorded = applied_migrations()
    for path in automation.MIGRATIONS:
        require(path in files, 'automation_migration_missing')
        require(path in recorded, 'automation_migration_not_applied')
        require(recorded[path] == sha(files[path][0]), 'automation_migration_changed')
    return {'schemaVersion': 1, 'mode': 'automation-release-install', 'commit': commit, 'archiveSha256': digest,
            'fromCommit': running, 'target': str(root), 'migrationsApplied': len(automation.MIGRATIONS),
            'units': {service(name): {'unitCommit': installed, 'dropin': str(dropin(name)),
                                      'dropinSha256': sha(dropin_text(name, commit).encode()),
                                      'previousDropin': previous, 'active': state.get('ActiveState') == 'active'}
                      for name, (state, installed, _, previous) in units.items()},
            'notPerformed': ['service, socket or timer start, stop, restart or daemon-reload', 'unit file change',
                             'database writes or migrations', 'dependency install',
                             'private configuration, keystore or credential reads', 'release deletion']}


def activation(planned):
    running = [unit for unit, state in planned['units'].items() if state['active']]
    if running:
        return (f'systemctl daemon-reload; then systemctl restart {" ".join(running)}: a running unit keeps '
                'the old release until it restarts, the others take this one at their next start')
    return 'systemctl daemon-reload; the three units run this release from their next start'


def apply(files, planned):
    require(os.geteuid() == 0, 'root_required')
    commit = planned['commit']
    filesystem.protected_parents(release_tool.RELEASES)
    filesystem.protected_parents(release_tool.UNIT_DIR)
    auth.private_directory(receipts())
    receipt = receipts() / f'{commit}.json'
    require(not receipt.exists() and not receipt.is_symlink(), 'receipt_exists')
    # Written first, so the drop-ins it records can always be put back.
    auth.write_new(receipt, (json.dumps(planned, indent=2, sort_keys=True) + '\n').encode(), 0o600)
    try:
        release_tool.install_source(COMPONENT, files, commit)
    except BaseException:
        receipt.unlink()
        raise
    for name in UNITS:
        release_tool.write_dropin(name, dropin_text(name, commit))
    return {'ok': True, 'mode': planned['mode'], 'commit': commit, 'fromCommit': planned['fromCommit'],
            'target': planned['target'], 'dropins': [unit['dropin'] for unit in planned['units'].values()],
            'receipt': str(receipt), 'installed': True, 'activated': False, 'activation': activation(planned),
            'rollback': f'install_automation_release.py --rollback {commit} (files only; reload and restart separately)'}


def rollback(commit):
    require(os.geteuid() == 0, 'root_required')
    require(re.fullmatch('[0-9a-f]{40}', commit) is not None, 'invalid_commit')
    receipt = receipts() / f'{commit}.json'
    filesystem.protected_parents(receipt)
    saved = json.loads(read_installed(receipt, 1024 * 1024))
    units, back = saved.get('units'), saved.get('fromCommit')
    require(saved.get('mode') == 'automation-release-install' and saved.get('commit') == commit
            and isinstance(units, dict) and set(units) == {service(name) for name in UNITS}
            and all(isinstance(unit, dict) for unit in units.values())
            and isinstance(back, str) and re.fullmatch('[0-9a-f]{40}', back) is not None
            and all(units[service(name)].get('previousDropin') in (None, dropin_text(name, back)) for name in UNITS),
            'invalid_receipt')
    require((release_tool.RELEASES / back / COMPONENT).is_dir(), 'previous_release_missing')
    # Every drop-in is checked before any is changed: this commit's, or already the one before it.
    for name in UNITS:
        path = dropin(name)
        now = read_installed(path, 65536).decode() if path.exists() or path.is_symlink() else None
        require(now in (dropin_text(name, commit), units[service(name)]['previousDropin']), 'rollback_is_not_current')
    for name in UNITS:
        previous, path = units[service(name)]['previousDropin'], dropin(name)
        if previous is not None:
            release_tool.write_dropin(name, previous)
        elif path.exists() or path.is_symlink():
            filesystem.protected_parents(path.parent)
            path.unlink()
            install.fsync_directory(path.parent)
    return {'ok': True, 'mode': 'automation-release-rollback', 'commit': commit, 'runs': back,
            'activated': False, 'releaseRetained': True,
            'action': 'daemon-reload, then restart the units the way they were started'}


@contextlib.contextmanager
def exclusive():
    """The lock the automation installer and its readiness upgrade take."""
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
        # Inspection reads the database's receipts, so it needs root as well.
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
