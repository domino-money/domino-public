#!/usr/bin/env python3
"""Install the V2 automation (backend/v2_automation.py) and move it to newer releases. Starts, enables and reloads
nothing.

One process per chain (docs/v2/V2_AUTOMATION_BACKEND.md, "Service units"), with one operator key and one publisher
key, each an encrypted V3 keystore whose password is a credential sealed on the host:
`domino-v2-automation@<chain>.service` runs `v2_automation.py --config <chain>.json serve`, and
`domino-v2-automation.target` wants the instances the operator enables.

First install, once per host:
- the identity domino-v2-automation (system user, nologin; no database role: the service keeps its journal in
  SQLite and reads the chain only);
- its private directory /etc/domino/v2/automation (0700): one configuration per chain, the two keystores and the
  chains' RPC files, all written by the operator and bound read-only at /run/domino-v2-automation-config;
- its public directory /var/lib/domino-v2-automation-public (0755): each chain's waitingFile, which the V2
  indexer (domino-write) reads for read-v6's "Waiting" reasons.

Every release:
- /opt/domino/financial/releases/<commit>/v2-automation holds backend (without its tests), api-contracts/v2 and
  the verified V2 manifests (bound at /run/domino-v2-deployments), 0555;
- domino-v2-automation@.service names that release. The journal, the scans' state and the head live in the
  instance's StateDirectory (/var/lib/domino-v2-automation/<chain>, 0700). The keystore passwords come from
  LoadCredentialEncrypted=, the hosted chains' RPC URLs from ImportCredential=v2-rpc-* (with the TPM in the
  device policy: systemd 255 adds it for the former only). The process reaches the chain through the names its
  egress pinned (/etc/domino/continuous-reads/v2-automation.hosts over /etc/hosts): the own node's proxy on
  Robinhood, the hosted providers on Base and Arbitrum (continuous_egress_policy.py, role v2-automation).

Rollback puts back the template that was there before, or its absence. The identity, the directories, the
releases, the target and the receipts stay.
"""
import argparse
import contextlib
import fcntl
import json
import os
from pathlib import Path
import pwd
import re
import sys
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_filesystem as filesystem
import install_position_plan as plan_listener
import prepare_disabled as install
import upgrade_financial as financial
from install_read_release import read_installed

require = install.require
COMPONENT = 'v2-automation'
OS_USER = 'domino-v2-automation'
UNIT = f'domino-{COMPONENT}@.service'
TARGET = f'domino-{COMPONENT}.target'
PRIVATE = Path('/etc/domino/v2/automation')
PUBLIC = Path('/var/lib/domino-v2-automation-public')
RELEASES = financial.ROOT / 'releases'
RECEIPTS = Path('/var/backups/domino-v2-automation-release')
LOCK = install.BASE / '.financial-install.lock'
CONFIG = f'/run/domino-{COMPONENT}-config'
DEPLOYMENTS = '/run/domino-v2-deployments'
HOSTS = '/etc/domino/continuous-reads/v2-automation.hosts'
ENTRY = 'backend/v2_automation.py'
LOCKFILE = plan_listener.LOCKFILE
MANIFEST = plan_listener.MANIFEST
CREDENTIALS = ('v2-operator-keystore-password', 'v2-publisher-keystore-password')
CREDSTORE = Path('/etc/credstore.encrypted')
EGRESS_UNIT = 'domino-continuous-egress.service'


def unit_text(commit):
    """The instance template for one release; the target wants the instances the operator enables."""
    root = RELEASES / commit / COMPONENT
    credentials = ''.join(f'LoadCredentialEncrypted={name}:{CREDSTORE / name}\n' for name in CREDENTIALS)
    return f'''[Unit]
Description=Domino V2 automation for %i ({commit})
After=network-online.target {EGRESS_UNIT}
Wants=network-online.target
BindsTo={EGRESS_UNIT}
PartOf={TARGET}
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=exec
User={OS_USER}
Group={OS_USER}
WorkingDirectory={root}
ExecStart={install.PYTHON} -B backend/v2_automation.py --config {CONFIG}/%i.json serve
Environment=PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
{credentials}ImportCredential=v2-rpc-*
DeviceAllow=char-tpm rw
UnsetEnvironment=PYTHONPATH PYTHONHOME HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy
UMask=0077
StateDirectory=domino-{COMPONENT}/%i
StateDirectoryMode=0700
ProtectSystem=strict
ReadWritePaths={PUBLIC}
BindReadOnlyPaths={PRIVATE}:{CONFIG}
BindReadOnlyPaths={root}/docs/deployments:{DEPLOYMENTS}
BindReadOnlyPaths={HOSTS}:/etc/hosts
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
NoNewPrivileges=true
CapabilityBoundingSet=
RestrictSUIDSGID=true
RestrictNamespaces=true
LockPersonality=true
LimitCORE=0
RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6
MemoryMax=768M
TasksMax=64
Restart=on-failure
RestartSec=30
TimeoutStopSec=60
KillMode=control-group

[Install]
WantedBy={TARGET}
'''


def target_text():
    return f'''[Unit]
Description=Domino V2 automation, one instance per chain
Wants=network-online.target
After=network-online.target {EGRESS_UNIT}

[Install]
WantedBy=multi-user.target
'''


def release_of(text):
    """The release a template this tool wrote names, or None."""
    found = re.search(r'^WorkingDirectory=' + re.escape(str(RELEASES)) + r'/([0-9a-f]{40})/' + COMPONENT + '$',
                      text, re.M)
    return found.group(1) if found else None


def selected(files):
    """What a release carries: backend without its tests, api-contracts/v2 and the V2 manifests."""
    return plan_listener.selected(files)


def account():
    try:
        return pwd.getpwnam(OS_USER)
    except KeyError:
        return None


def plan(files, commit, digest):
    require(re.fullmatch('[0-9a-f]{40}', commit) is not None, 'invalid_commit')
    require(ENTRY in files and LOCKFILE in files, 'entry_script_missing')
    manifests = sorted(name for name in files if MANIFEST.match(name))
    require(manifests, 'manifest_missing')
    require(all(f'api-contracts/v2/chains/{chain}.json' in files
                for chain in ('robinhood-4663', 'base-8453', 'arbitrum-42161')), 'chain_profiles_missing')
    require(plan_listener.sha(files[LOCKFILE][0]) == plan_listener.sha(plan_listener.running_lock()),
            'dependency_lock_changed')
    root = RELEASES / commit / COMPONENT
    require(not root.exists() and not root.is_symlink(), 'release_directory_exists')
    unit = install.UNIT_DIR / UNIT
    previous = None
    if unit.exists() or unit.is_symlink():
        previous = read_installed(unit).decode()
        installed = release_of(previous)
        require(installed is not None, 'unit_drift')
        # The template as this tool wrote it is the one its receipt keeps (install_position_plan.py, #339).
        receipt = RECEIPTS / f'{installed}.json'
        written = (json.loads(read_installed(receipt))['unit'] if receipt.exists() or receipt.is_symlink()
                   else unit_text(installed))
        require(previous == written, 'unit_drift')
        require(installed != commit, 'release_already_running')
    target = install.UNIT_DIR / TARGET
    if target.exists() or target.is_symlink():
        require(read_installed(target).decode() == target_text(), 'target_drift')
    first = {'identity': account() is None, 'privateDirectory': not PRIVATE.exists(),
             'publicDirectory': not PUBLIC.exists(), 'target': not target.exists()}
    return {'mode': 'v2-automation-install', 'commit': commit, 'archiveSha256': digest,
            'target': str(root), 'unit': unit_text(commit), 'previousUnit': previous,
            'previousRelease': None if previous is None else release_of(previous),
            'firstInstall': first, 'manifests': manifests, 'files': len(selected(files)),
            'credentialsSealed': {name: (CREDSTORE / name).is_file() for name in CREDENTIALS},
            'notPerformed': ['daemon-reload', 'enable, start or restart', 'configurations, keystores and RPC files',
                             'continuous egress policy', 'gas.enabled']}


def write_new(path, payload, mode):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as stream:
        stream.write(payload)
        stream.flush()
        os.fsync(stream.fileno())


def install_source(files, commit):
    """The release tree, staged under a private name and renamed into place at once."""
    if not RELEASES.exists():
        RELEASES.mkdir(mode=0o755)
        os.chmod(RELEASES, 0o755)
    require(RELEASES.stat().st_mode & 0o001, 'release_directory_not_traversable')
    release = RELEASES / commit
    created = not release.exists()
    if created:
        release.mkdir(mode=0o755)
    else:
        filesystem.protected_parents(release)
        require(release.stat().st_mode & 0o001, 'release_directory_not_traversable')
    staging = release / f'.{COMPONENT}-{uuid.uuid4().hex}'
    staging.mkdir(mode=0o700)
    for name, (payload, executable) in sorted(selected(files).items()):
        path = staging / name
        path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        write_new(path, payload, 0o555 if executable else 0o444)
    for path, _, _ in os.walk(staging, topdown=False):
        os.chmod(path, 0o555)
    require(not (release / COMPONENT).exists(), 'release_directory_exists')
    os.rename(staging, release / COMPONENT)
    if created:
        os.chmod(release, 0o555)


def owned_directory(path, user, mode):
    path.mkdir(mode=mode)
    os.chown(path, user.pw_uid, user.pw_gid)
    os.chmod(path, mode)


def first_install():
    """The identity and its directories, each only when missing."""
    done = []
    if account() is None:
        install.run(['/usr/sbin/useradd', '--system', '--user-group', '--no-create-home', '--home-dir',
                     '/nonexistent', '--shell', '/usr/sbin/nologin', OS_USER])
        done.append('identity')
    user = account()
    require(user is not None, 'identity_missing')
    if not PRIVATE.parent.exists():
        PRIVATE.parent.mkdir(mode=0o700)
        os.chmod(PRIVATE.parent, 0o700)
    require(PRIVATE.parent.is_dir() and not PRIVATE.parent.is_symlink(), 'private_parent_invalid')
    if not PRIVATE.exists():
        owned_directory(PRIVATE, user, 0o700)
        done.append('privateDirectory')
    if not PUBLIC.exists():
        owned_directory(PUBLIC, user, 0o755)
        done.append('publicDirectory')
    target = install.UNIT_DIR / TARGET
    if not target.exists():
        install.exclusive_file(target, target_text().encode(), 0o644)
        install.fsync_directory(target.parent)
        done.append('target')
    return done


def write_unit(text):
    path = install.UNIT_DIR / UNIT
    temporary = path.with_name(path.name + '.v2-automation-new')
    install.exclusive_file(temporary, text.encode(), 0o644)
    os.replace(temporary, path)
    install.fsync_directory(path.parent)


@contextlib.contextmanager
def locked():
    fd = os.open(LOCK, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'rb+') as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield


def apply(files, planned):
    require(os.geteuid() == 0, 'root_required')
    install.trusted_parents(install.BASE)
    with locked():
        if not RECEIPTS.exists():
            install.trusted_parents(RECEIPTS.parent)
            RECEIPTS.mkdir(mode=0o700)
        install.trusted_parents(RECEIPTS)
        receipt = RECEIPTS / f"{planned['commit']}.json"
        require(not receipt.exists() and not receipt.is_symlink(), 'receipt_exists')
        again = plan(files, planned['commit'], planned['archiveSha256'])
        require({k: again[k] for k in ('previousUnit', 'target')} == {k: planned[k] for k in ('previousUnit', 'target')},
                'host_changed_since_plan')
        done = first_install()
        install_source(files, planned['commit'])
        install.exclusive_file(receipt, (json.dumps({**planned, 'firstInstallDone': done}, sort_keys=True, indent=2)
                                         + '\n').encode())
        write_unit(planned['unit'])
        install.run(['/usr/bin/systemd-analyze', 'verify', '--man=no', str(install.UNIT_DIR / UNIT)])
        return {'ok': True, 'mode': planned['mode'], 'commit': planned['commit'], 'target': planned['target'],
                'firstInstallDone': done, 'receipt': str(receipt),
                'next': 'write each chain\'s configuration, the keystores and the RPC files, render the egress '
                        'policy with v2-automation, daemon-reload, then enable and start the instances',
                'rollback': f"install_v2_automation.py --rollback {planned['commit']}"}


def rollback(commit):
    require(os.geteuid() == 0, 'root_required')
    require(re.fullmatch('[0-9a-f]{40}', commit) is not None, 'invalid_commit')
    with locked():
        receipt = RECEIPTS / f'{commit}.json'
        install.trusted_parents(receipt)
        saved = json.loads(read_installed(receipt))
        require(saved.get('commit') == commit and saved.get('mode') == 'v2-automation-install', 'invalid_receipt')
        unit = install.UNIT_DIR / UNIT
        require(unit.exists() and read_installed(unit).decode() == saved['unit'], 'unit_changed_since_apply')
        if saved['previousUnit'] is None:
            unit.unlink()
            install.fsync_directory(unit.parent)
        else:
            write_unit(saved['previousUnit'])
        return {'ok': True, 'mode': 'v2-automation-rollback', 'commit': commit,
                'unit': 'removed' if saved['previousUnit'] is None else saved['previousRelease'],
                'kept': ['identity', 'directories', 'releases', 'target', 'receipts'],
                'next': 'daemon-reload, then restart or stop the instances'}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    parser.add_argument('--archive', type=Path)
    parser.add_argument('--archive-sha256')
    parser.add_argument('--commit')
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--inspect', action='store_true')
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--rollback', metavar='COMMIT')
    args = parser.parse_args(argv)
    try:
        if args.rollback:
            result = rollback(args.rollback)
        else:
            require(args.archive and args.archive_sha256 and args.commit, 'archive_arguments_required')
            files = install.archive_files(args.archive, args.archive_sha256, args.commit)
            planned = plan(files, args.commit, args.archive_sha256)
            result = apply(files, planned) if args.apply else {**planned, 'ok': True, 'installed': False}
        print(json.dumps(result, indent=2))
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(json.dumps({'ok': False, 'reason': reason, 'action': 'stop; nothing after the failing step was done'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
