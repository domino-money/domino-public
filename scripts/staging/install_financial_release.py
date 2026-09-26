#!/usr/bin/env python3
"""Run performance, its collector or execution-status from a newer release.
Starts, stops and reloads nothing.

The financial upgrade installed these three once, on 13 September, and nothing
has moved them since: that upgrade is one-shot, and the automation readiness
upgrade repoints execution-status only while every other financial unit is off,
the live session listener included. This tool does for each of them what
install_auth_release.py does for the session listener. It writes one release
beside the running one, laid out as the financial upgrade laid out its own, and
one drop-in that names it: the working directory and the binds, taken from the
unit the financial upgrade would write for that release. The unit file stays
exactly as that upgrade wrote it, and the private runtime under
/var/lib/domino-financial/<component> carries over from release to release.

The two listeners authenticate sessions, and the session store they run from
#212 on reads each session's EIP-7702 delegate, so the database must already
have 041. Whether it does, and whether 039 lets execution-status read the
automation readiness its /availability route reports, are the only things read
from the database.

Activation stays with the operator: daemon-reload, then start the unit, or
restart it if it runs. A family the continuous egress policy names is only
wanted by domino-continuous-reads.target, so its restarts stay its own; a unit
the target requires is restarted through the target, never alone. Rollback
puts back the drop-in that was there before, or its absence; releases and
receipts stay. A commit is applied once per component: after a failed or
rolled-back apply, install a new commit, or remove that component's release
directory by hand first.
"""
import argparse
import contextlib
import json
import os
from pathlib import Path
import re
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_filesystem as filesystem
import install_auth_release as auth
import prepare_disabled as install
import upgrade_financial as financial
from install_read_release import read_installed

require = install.require
sha = auth.sha
# The session listener has its own installer and checks; the signer is not a listener.
COMPONENTS = ('performance', 'performance-collector', 'execution-status')
# Where each component's contract version lives in the archive.
CONTRACTS = {'performance': 'backend/performance_v2_models.py',
             'performance-collector': 'backend/performance_v2_models.py',
             'execution-status': 'backend/execution_status.py'}
# The components that authenticate a browser session.
SESSIONS = ('performance', 'execution-status')
UNIT_DIR = install.UNIT_DIR
RELEASES = financial.ROOT / 'releases'
BACKUPS = Path('/var/backups')
TARGET = auth.TARGET
LOCKFILE = auth.LOCKFILE
CONTRACT = re.compile(r"^CONTRACT_VERSION\s*=\s*'([^'\n]+)'$", re.M)
# Migration 041's column: the session store from #212 on selects it for every session.
DELEGATE = ("SELECT count(*) FROM pg_catalog.pg_attribute WHERE attrelid='domino_sessions.sessions'::regclass "
            "AND attname='delegate' AND NOT attisdropped;")
# Migration 039's policy: without it the status reader may not read readiness at all.
READINESS = ("SELECT count(*) FROM pg_catalog.pg_policies WHERE schemaname='domino_execution' "
             "AND tablename='controls' AND policyname='execution_reader_automation_ready';")
HEADER = ('# Written by scripts/staging/install_financial_release.py: the release this unit\n'
          '# runs. The unit file keeps the release it was installed with.\n')
exclusive = auth.exclusive


def service(component):
    return f'domino-{component}.service'


def dropins(component):
    """This tool's drop-in, and the continuous egress policy's that may sit beside it."""
    directory = UNIT_DIR / f'{service(component)}.d'
    return directory / '50-release.conf', directory / '60-continuous-reads.conf'


def receipts(component):
    return BACKUPS / f'domino-{component}-release'


def dropin_text(component, commit):
    """What names a release in the unit the financial upgrade would write for it."""
    lines = financial.unit_text(component, commit).splitlines()

    def line(key):
        return next(value for value in lines if value.startswith(key + '='))
    # BindPaths and BindReadOnlyPaths share one list in systemd, so the empty
    # assignment that drops the unit's own runtime bind drops its read-only
    # configuration bind too; both come back from the unit for this release.
    return HEADER + '\n'.join(('[Unit]', line('Description'), '', '[Service]',
                               line('WorkingDirectory'), 'BindPaths=', line('BindPaths'),
                               line('BindReadOnlyPaths'))) + '\n'


def release_of(component, path):
    """The commit a component root names, or None for any other directory."""
    root = Path(path)
    if root.name != component or root.parent.parent != RELEASES:
        return None
    return root.parent.name if re.fullmatch('[0-9a-f]{40}', root.parent.name) else None


def loaded(component):
    """The unit as systemd has it loaded, which is what the next start runs."""
    raw = install.run(['/usr/bin/systemctl', 'show', service(component), '--property=LoadState,ActiveState,'
                       'NeedDaemonReload,FragmentPath,DropInPaths,WorkingDirectory']).decode()
    return dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)


def membership(component):
    """How the continuous target holds the unit: 'requires', 'wants' or None."""
    raw = install.run(['/usr/bin/systemctl', 'show', TARGET, '--property=Requires,Wants']).decode()
    members = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
    for kind in ('Requires', 'Wants'):
        if service(component) in members.get(kind, '').split():
            return kind.lower()
    return None


def current(component):
    """The release the unit runs now, and the files that make it so."""
    unit = UNIT_DIR / service(component)
    dropin, egress = dropins(component)
    state = loaded(component)
    require(state.get('LoadState') == 'loaded', 'unit_not_loaded')
    require(state.get('FragmentPath') == str(unit), 'unit_moved')
    # A file changed since the last reload: what is loaded and what is on disk differ.
    require(state.get('NeedDaemonReload') == 'no', 'daemon_reload_pending')
    paths = state.get('DropInPaths', '').split()
    require(set(paths) <= {str(dropin), str(egress)}, 'foreign_dropin')
    require((str(dropin) in paths) == (dropin.exists() or dropin.is_symlink()), 'daemon_reload_pending')
    text = read_installed(unit, 65536).decode()
    match = re.search(r'^WorkingDirectory=(.*)$', text, re.M)
    installed = release_of(component, match.group(1)) if match else None
    require(installed is not None, 'unit_not_financial')
    require(text == financial.unit_text(component, installed), 'unit_drift')
    running = release_of(component, state.get('WorkingDirectory', ''))
    require(running is not None, 'release_mismatch')
    previous = read_installed(dropin, 65536).decode() if str(dropin) in paths else None
    if previous is None:
        require(running == installed, 'release_mismatch')
    else:
        require(previous == dropin_text(component, running), 'dropin_drift')
    return state, installed, running, previous


def plan(component, files, commit, digest):
    require(component in COMPONENTS, 'unknown_component')
    state, installed, running, previous = current(component)
    require(commit != running, 'release_already_running')
    root = RELEASES / commit / component
    require(not root.exists() and not root.is_symlink(), 'release_directory_exists')
    # The shared interpreter satisfies the running release's lock and nothing newer.
    require(sha(files[LOCKFILE][0]) == sha(read_installed(RELEASES / running / component / LOCKFILE)),
            'dependency_change_needs_a_venv')
    script = re.search(r' -B (backend/\S+) ', financial.unit_text(component, commit)).group(1)
    require(script in files, 'entry_script_missing')
    source = files.get(CONTRACTS[component])
    contract = CONTRACT.search(source[0].decode()) if source else None
    require(contract is not None, 'contract_missing')
    if component in SESSIONS:
        require(install.sql(DELEGATE) == '1', 'migration_041_not_applied')
    readiness = {}
    if component == 'execution-status':
        readiness['automationReadinessReadable'] = install.sql(READINESS) == '1'
    dropin = dropins(component)[0]
    return {'schemaVersion': 1, 'mode': 'financial-release-install', 'component': component,
            'commit': commit, 'archiveSha256': digest, 'contract': contract.group(1),
            'fromCommit': running, 'unitCommit': installed, 'target': str(root),
            'dropin': str(dropin), 'dropinSha256': sha(dropin_text(component, commit).encode()),
            'previousDropin': previous, 'serviceActive': state.get('ActiveState') == 'active',
            'continuousTarget': membership(component), **readiness,
            'notPerformed': ['service start, stop, restart or daemon-reload', 'unit file change',
                             'database writes or migrations', 'dependency install',
                             'private configuration or secret reads', 'egress, Access or Tunnel change',
                             'release deletion']}


def install_source(component, files, commit):
    """The backend tree, staged under a private name and renamed into place at once."""
    require(RELEASES.stat().st_mode & 0o001, 'release_directory_not_traversable')
    release = RELEASES / commit
    created = not release.exists()
    if created:
        release.mkdir(mode=0o755)
    else:
        # The unit's user must traverse it; another installer may have left it closed.
        filesystem.protected_parents(release)
        require(release.stat().st_mode & 0o001, 'release_directory_not_traversable')
    staging = release / f'.{component}-{uuid.uuid4().hex}'
    try:
        staging.mkdir(mode=0o700)
        for name, (payload, executable) in sorted(files.items()):
            if not name.startswith('backend/') or name.startswith('backend/tests/'):
                continue
            path = staging / name
            path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            auth.write_new(path, payload, 0o555 if executable else 0o444)
        # The mount point the unit binds its private runtime over.
        (staging / 'backend/runtime').mkdir(mode=0o700)
        for path, _, _ in os.walk(staging, topdown=False):
            os.chmod(path, 0o555)
        require(not (release / component).exists(), 'release_directory_exists')
        os.rename(staging, release / component)
        if created:
            # Explicit, whatever the umask: 0700 here would stop the unit's user.
            os.chmod(release, 0o555)
    except BaseException:
        auth.discard(staging)
        if created:
            # Only while empty: a failure after the rename leaves the release in place.
            with contextlib.suppress(OSError):
                release.rmdir()
        raise


def write_dropin(component, text):
    dropin = dropins(component)[0]
    directory = dropin.parent
    if not directory.exists():
        filesystem.protected_parents(directory.parent)
        directory.mkdir(mode=0o755)
        os.chmod(directory, 0o755)
    filesystem.protected_parents(directory)
    auth.replace(dropin, text.encode(), 0o644)


def activation(planned):
    unit = service(planned['component'])
    if planned['continuousTarget'] == 'requires':
        return (f'systemctl daemon-reload; then systemctl restart {TARGET}, never {unit} alone: '
                'a required member stopped or restarted takes the tunnel with it')
    if planned['serviceActive']:
        return f'systemctl daemon-reload; then systemctl restart {unit}, which runs the old release until then'
    return f'systemctl daemon-reload; {unit} runs this release from its next start'


def apply(files, planned):
    require(os.geteuid() == 0, 'root_required')
    component, commit = planned['component'], planned['commit']
    filesystem.protected_parents(RELEASES)
    filesystem.protected_parents(UNIT_DIR)
    auth.private_directory(receipts(component))
    receipt = receipts(component) / f'{commit}.json'
    require(not receipt.exists() and not receipt.is_symlink(), 'receipt_exists')
    # Written first, so the drop-in it records can always be put back.
    auth.write_new(receipt, (json.dumps(planned, indent=2, sort_keys=True) + '\n').encode(), 0o600)
    try:
        install_source(component, files, commit)
    except BaseException:
        receipt.unlink()
        raise
    write_dropin(component, dropin_text(component, commit))
    return {'ok': True, 'mode': planned['mode'], 'component': component, 'commit': commit,
            'fromCommit': planned['fromCommit'], 'contract': planned['contract'],
            'target': planned['target'], 'dropin': planned['dropin'], 'receipt': str(receipt),
            'installed': True, 'activated': False, 'activation': activation(planned),
            'rollback': (f'install_financial_release.py --component {component} --rollback {commit} '
                         '(files only; reload and restart separately)')}


def rollback(component, commit):
    require(os.geteuid() == 0, 'root_required')
    require(component in COMPONENTS, 'unknown_component')
    require(re.fullmatch('[0-9a-f]{40}', commit) is not None, 'invalid_commit')
    receipt = receipts(component) / f'{commit}.json'
    filesystem.protected_parents(receipt)
    saved = json.loads(read_installed(receipt, 1024 * 1024))
    require(saved.get('mode') == 'financial-release-install' and saved.get('component') == component
            and saved.get('commit') == commit, 'invalid_receipt')
    back, previous = saved.get('fromCommit'), saved.get('previousDropin')
    require(isinstance(back, str) and re.fullmatch('[0-9a-f]{40}', back) is not None
            and (previous is None or previous == dropin_text(component, back)), 'invalid_receipt')
    require((RELEASES / back / component).is_dir(), 'previous_release_missing')
    dropin = dropins(component)[0]
    present = dropin.exists() or dropin.is_symlink()
    now = read_installed(dropin, 65536).decode() if present else None
    require(now in (dropin_text(component, commit), previous), 'rollback_is_not_current')
    if previous is not None:
        write_dropin(component, previous)
    elif present:
        filesystem.protected_parents(dropin.parent)
        dropin.unlink()
        install.fsync_directory(dropin.parent)
    return {'ok': True, 'mode': 'financial-release-rollback', 'component': component, 'commit': commit,
            'runs': back, 'activated': False, 'releaseRetained': True,
            'action': 'daemon-reload, then restart the unit the way it was started'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--component', required=True, choices=COMPONENTS)
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--archive-sha256')
    parser.add_argument('--commit')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--inspect', action='store_true')
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--rollback', metavar='COMMIT')
    args = parser.parse_args(argv)
    try:
        # Inspection reads the database's catalog, so it needs root as well.
        require(os.geteuid() == 0, 'root_required')
        if args.rollback:
            with exclusive():
                result = rollback(args.component, args.rollback)
        else:
            require(args.archive and args.archive_sha256 and args.commit, 'archive_arguments_required')
            files = install.archive_files(args.archive, args.archive_sha256, args.commit)
            if args.inspect:
                result = {**plan(args.component, files, args.commit, args.archive_sha256),
                          'ok': True, 'installed': False}
            else:
                with exclusive():
                    result = apply(files, plan(args.component, files, args.commit, args.archive_sha256))
        print(json.dumps(result, indent=2, sort_keys=True))
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(json.dumps({'ok': False, 'reason': reason,
                          'action': 'nothing started, stopped or reloaded; a receipt records any apply that began'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
