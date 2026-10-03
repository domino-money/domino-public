#!/usr/bin/env python3
"""Install one read-path release beside the running one. Starts no service.

The disabled installer validates the whole host as the only thing on it. This
host has grown past that: a financial upgrade, a development lane, a tunnel, a
continuous egress policy, an indexer and its timers, all legitimate and all
invisible to that model. This tool claims only the two read-path service roots
and refuses to assert anything about the rest.

It writes one thing: a release directory beside the existing one, carrying the
archive's files plus the two links the running release already uses — the
shared interpreter and the runtime directory holding that identity's private
configuration. Dependencies must be identical to the installed release, because
nothing here installs a package or reaches a network.

Activation is separate and stays with the operator: repoint the drop-in, reload
and restart through domino-continuous-reads.target, never its members.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import stat
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_filesystem as filesystem
import prepare_disabled as install

require = install.require
COMPONENTS = ('read', 'gateway')
RELEASES = install.BASE / 'releases'
LINKS = ('backend/.venv', 'backend/runtime')
# Only these may differ from the installed release. Everything else the running
# services read must be byte-identical, because this tool replays no migration,
# installs no dependency and rewrites no configuration.
FROZEN = ('backend/requirements-api.lock',)


def digest_of(payload):
    return hashlib.sha256(payload).hexdigest()


def read_installed(path, limit=4 * 1024 * 1024):
    """Read one bounded regular file from the installed release, never a link."""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_size <= limit, 'installed_file_unreadable')
        return stream.read(limit + 1)


def unit_release(component):
    """The release the running unit actually names, read from systemd itself."""
    value = install.run(['/usr/bin/systemctl', 'show', f'domino-{component}.service',
                         '-p', 'WorkingDirectory', '--value']).decode().strip()
    require(value.startswith(str(RELEASES) + '/'), 'unit_is_not_a_release_root')
    root = Path(value)
    require(root.name == component and root.parent.parent == RELEASES, 'unexpected_release_layout')
    return root.parent.name


def link_targets(commit):
    """Where the installed release points, so the new one points the same way.

    A release this tool installed links its runtime to the identity's private
    directory. The first release on a host, installed by prepare_disabled.py,
    holds that directory itself: owned by the service identity, mode 0700. The
    new release then links to it there (docs/FRESH_HOST_INSTALL.md).
    """
    targets = {}
    for component in COMPONENTS:
        root = RELEASES / commit / component
        for name in LINKS:
            path = root / name
            if name == 'backend/runtime' and not path.is_symlink() and path.is_dir():
                info = path.lstat()
                require(info.st_uid == pwd.getpwnam(f'domino-{component}').pw_uid
                        and stat.S_IMODE(info.st_mode) == 0o700, 'installed_runtime_not_private')
                targets[(component, name)] = path
                continue
            require(path.is_symlink(), 'installed_release_link_missing')
            target = Path(os.readlink(path))
            require(target.is_absolute() and target.exists(), 'installed_release_link_broken')
            targets[(component, name)] = target
    return targets


def plan(files, commit, digest):
    installed = {component: unit_release(component) for component in COMPONENTS}
    require(len(set(installed.values())) == 1, 'read_and_gateway_on_different_releases')
    previous = installed['read']
    require(previous != commit, 'release_already_installed')
    targets = link_targets(previous)
    for name in FROZEN:
        require(name in files, 'required_release_file_missing')
        installed_file = RELEASES / previous / 'read' / name
        require(digest_of(files[name][0]) == digest_of(read_installed(installed_file)),
                'dependency_change_needs_a_venv')
    return {'mode': 'read-release-install', 'commit': commit, 'archiveSha256': digest,
            'fromCommit': previous, 'components': list(COMPONENTS),
            'target': str(RELEASES / commit),
            'links': {f'{component}/{name}': str(target) for (component, name), target in targets.items()},
            'notPerformed': ['service start/enable or restart', 'drop-in or unit change',
                             'database writes', 'migration replay', 'dependency install',
                             'runtime configuration changes', 'Access/Tunnel/egress',
                             'release deletion']}


def verify(planned, *, owner=0):
    """Every file the archive carries is present, plus exactly the two links."""
    root = RELEASES / planned['commit']
    for component in COMPONENTS:
        for name in LINKS:
            path = root / component / name
            require(path.is_symlink(), 'installed_link_missing')
            require(str(Path(os.readlink(path))) == planned['links'][f'{component}/{name}'],
                    'installed_link_target_changed')
        info = (root / component).lstat()
        require(stat.S_ISDIR(info.st_mode) and info.st_uid == owner
                and not info.st_mode & 0o022, 'installed_tree_not_root_owned')
    return {'ok': True, **{k: planned[k] for k in ('mode', 'commit', 'fromCommit', 'target')},
            'activation': 'repoint the drop-in, then restart domino-continuous-reads.target'}


def apply(files, planned, *, owner=0):
    """Write the release. `owner` is the uid the finished tree must carry."""
    require(os.geteuid() == 0, 'root_required')
    filesystem.protected_parents(RELEASES)
    root = RELEASES / planned['commit']
    require(not root.exists(), 'release_directory_exists')
    root.mkdir(mode=0o755)
    for component in COMPONENTS:
        base = root / component
        base.mkdir(mode=0o755)
        for name, (payload, executable) in sorted(files.items()):
            path = base / name
            path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o755 if executable else 0o644)
            with os.fdopen(fd, 'wb') as stream:
                stream.write(payload)
        for name in LINKS:
            path = base / name
            path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            if path.exists() or path.is_symlink():
                path.unlink()
            path.symlink_to(planned['links'][f'{component}/{name}'])
        os.chmod(base, 0o555)
    return verify(planned, owner=owner)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--archive-sha256', required=True)
    parser.add_argument('--commit', required=True)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--inspect', action='store_true')
    mode.add_argument('--apply', action='store_true')
    args = parser.parse_args(argv)
    try:
        files = install.archive_files(args.archive, args.archive_sha256, args.commit)
        planned = plan(files, args.commit, args.archive_sha256)
        result = apply(files, planned) if args.apply else {**planned, 'ok': True, 'installed': False}
        print(json.dumps(result, indent=2))
        return 0
    except Exception as error:
        # Private paths, configuration and fingerprints stay in operator storage.
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(json.dumps({'ok': False, 'reason': reason,
                          'action': 'no release installed; nothing started or repointed'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
