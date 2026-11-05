#!/usr/bin/env python3
"""Install the production monitor (backend/ops_monitor.py) and move it to newer releases. Starts, enables and
reloads nothing.

The monitor (docs/OPS_MONITOR.md) checks the services, the chains and the operators' balances every minute, alerts on
Telegram and writes a public status snapshot for the operator's dashboard. It reads only.

First install, once per host:
- the identity domino-monitor (system user, nologin), a member of systemd-journal so it can read the services' own
  lines, and of nothing else: no database role, no service's files;
- its private directory /etc/domino/monitor (0700): the configuration and copies of the services' endpoint files,
  written by the operator and bound read-only at /run/domino-monitor-config;
- its public directory /var/lib/domino-monitor-public (0755): status.json, which the dashboard reads.

Every release:
- /opt/domino/financial/releases/<commit>/monitor holds backend (without its tests) and api-contracts/v2 (the chain
  profiles and the ABI the registry's events are decoded with), 0555, every mode explicit;
- domino-monitor.service names that release, wanted at boot on its own: it must keep running when the read path's
  target stops, which is when it matters most. Its state lives in its StateDirectory (/var/lib/domino-monitor,
  0700). The Telegram bot token and the hosted chains' RPC URLs come as credentials only (ImportCredential=), with
  the TPM in the device policy (systemd 255 adds it for LoadCredentialEncrypted= only). It reaches only the names
  its egress pinned (/etc/domino/continuous-reads/monitor.hosts over /etc/hosts; continuous_egress_policy.py, role
  monitor).

Rollback puts back the unit that was there before, or its absence. The identity, the directories, the releases and
the receipts stay.
"""
import argparse
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
import install_v2_automation as automation
import prepare_disabled as install
import upgrade_financial as financial
from install_read_release import read_installed
import v2_release_chains

require = install.require
COMPONENT = 'monitor'
OS_USER = 'domino-monitor'
UNIT = f'domino-{COMPONENT}.service'
PRIVATE = Path('/etc/domino/monitor')
PUBLIC = Path('/var/lib/domino-monitor-public')
RELEASES = financial.ROOT / 'releases'
RECEIPTS = Path('/var/backups/domino-monitor-release')
CONFIG = f'/run/domino-{COMPONENT}-config'
HOSTS = '/etc/domino/continuous-reads/monitor.hosts'
ENTRY = 'backend/ops_monitor.py'
LOCKFILE = plan_listener.LOCKFILE
REGISTRY_ABI = 'api-contracts/v2/abi/IDominoRegistry.json'
CREDENTIALS = ('telegram-bot-token', 'v2-rpc-*')
write_new = automation.write_new
owned_directory = automation.owned_directory
locked = automation.locked


def unit_text(commit):
    """The monitor's unit for one release, wanted at boot by itself."""
    root = RELEASES / commit / COMPONENT
    credentials = ''.join(f'ImportCredential={name}\n' for name in CREDENTIALS)
    return f'''[Unit]
Description=Domino production monitor ({commit})
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=exec
User={OS_USER}
Group={OS_USER}
SupplementaryGroups=systemd-journal
WorkingDirectory={root}
ExecStart={install.PYTHON} -B backend/ops_monitor.py --config {CONFIG}/config.json serve
Environment=PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
{credentials}DeviceAllow=char-tpm rw
UnsetEnvironment=PYTHONPATH PYTHONHOME HTTP_PROXY HTTPS_PROXY ALL_PROXY NO_PROXY http_proxy https_proxy all_proxy no_proxy
UMask=0077
StateDirectory=domino-{COMPONENT}
StateDirectoryMode=0700
ProtectSystem=strict
ReadWritePaths={PUBLIC}
BindReadOnlyPaths={PRIVATE}:{CONFIG}
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
MemoryMax=384M
TasksMax=32
Restart=always
RestartSec=30
TimeoutStopSec=30
KillMode=control-group

[Install]
WantedBy=multi-user.target
'''


def release_of(text):
    """The release a unit this tool wrote names, or None."""
    found = re.search(r'^WorkingDirectory=' + re.escape(str(RELEASES)) + r'/([0-9a-f]{40})/' + COMPONENT + '$',
                      text, re.M)
    return found.group(1) if found else None


def selected(files):
    """What a release carries: backend without its tests, and api-contracts/v2 (chain profiles and ABI)."""
    return {name: value for name, value in files.items()
            if (name.startswith('backend/') and not name.startswith('backend/tests/'))
            or name.startswith('api-contracts/v2/')}


def account():
    try:
        return pwd.getpwnam(OS_USER)
    except KeyError:
        return None


def plan(files, commit, digest):
    require(re.fullmatch('[0-9a-f]{40}', commit) is not None, 'invalid_commit')
    require(ENTRY in files and LOCKFILE in files, 'entry_script_missing')
    require(REGISTRY_ABI in files and all(f'api-contracts/v2/chains/{chain}.json' in files
                                          for chain in v2_release_chains.CHAINS), 'v2_exports_missing')
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
        # The unit as this tool wrote it is the one its receipt keeps (#339).
        receipt = RECEIPTS / f'{installed}.json'
        written = (json.loads(read_installed(receipt))['unit'] if receipt.exists() or receipt.is_symlink()
                   else unit_text(installed))
        require(previous == written, 'unit_drift')
        require(installed != commit, 'release_already_running')
    first = {'identity': account() is None, 'privateDirectory': not PRIVATE.exists(),
             'publicDirectory': not PUBLIC.exists()}
    return {'mode': 'monitor-install', 'commit': commit, 'archiveSha256': digest,
            'target': str(root), 'unit': unit_text(commit), 'previousUnit': previous,
            'previousRelease': None if previous is None else release_of(previous),
            'firstInstall': first, 'files': len(selected(files)),
            'notPerformed': ['daemon-reload', 'enable, start or restart', 'configuration and endpoint files',
                             'continuous egress policy', 'Telegram bot token (sealed by the owner)']}


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


def first_install():
    """The identity and its directories, each only when missing."""
    done = []
    if account() is None:
        install.run(['/usr/sbin/useradd', '--system', '--user-group', '--no-create-home', '--home-dir',
                     '/nonexistent', '--shell', '/usr/sbin/nologin', '--groups', 'systemd-journal', OS_USER])
        done.append('identity')
    user = account()
    require(user is not None, 'identity_missing')
    require(PRIVATE.parent.is_dir() and not PRIVATE.parent.is_symlink(), 'private_parent_invalid')
    if not PRIVATE.exists():
        owned_directory(PRIVATE, user, 0o700)
        done.append('privateDirectory')
    if not PUBLIC.exists():
        owned_directory(PUBLIC, user, 0o755)
        done.append('publicDirectory')
    return done


def write_unit(text):
    path = install.UNIT_DIR / UNIT
    temporary = path.with_name(path.name + '.monitor-new')
    install.exclusive_file(temporary, text.encode(), 0o644)
    os.replace(temporary, path)
    install.fsync_directory(path.parent)


def apply(files, planned):
    require(os.geteuid() == 0, 'root_required')
    install.trusted_parents(install.BASE)
    with locked():
        if not RECEIPTS.exists():
            install.trusted_parents(RECEIPTS.parent)
            RECEIPTS.mkdir(mode=0o700)
            os.chmod(RECEIPTS, 0o700)
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
                'next': 'write config.json and the endpoint files, render the egress policy with monitor, '
                        'daemon-reload, then enable and start the unit',
                'rollback': f"install_monitor.py --rollback {planned['commit']}"}


def rollback(commit):
    require(os.geteuid() == 0, 'root_required')
    require(re.fullmatch('[0-9a-f]{40}', commit) is not None, 'invalid_commit')
    with locked():
        receipt = RECEIPTS / f'{commit}.json'
        install.trusted_parents(receipt)
        saved = json.loads(read_installed(receipt))
        require(saved.get('commit') == commit and saved.get('mode') == 'monitor-install', 'invalid_receipt')
        unit = install.UNIT_DIR / UNIT
        require(unit.exists() and read_installed(unit).decode() == saved['unit'], 'unit_changed_since_apply')
        if saved['previousUnit'] is None:
            unit.unlink()
            install.fsync_directory(unit.parent)
        else:
            write_unit(saved['previousUnit'])
        return {'ok': True, 'mode': 'monitor-rollback', 'commit': commit,
                'unit': 'removed' if saved['previousUnit'] is None else saved['previousRelease'],
                'kept': ['identity', 'directories', 'releases', 'receipts'],
                'next': 'daemon-reload, then restart or stop the monitor'}


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
