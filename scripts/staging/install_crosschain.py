#!/usr/bin/env python3
"""Install the S2 crosschain listener (crosschain-v1) and move it to newer releases. Starts, stops and reloads nothing.

The listener (backend/crosschain_api.py, docs/v2/F5_BRIDGE.md) answers the app's deposits from another chain on
127.0.0.1:8910, behind the tunnel route `^/internal/crosschain/v1/(origins|quote|status)$` of
vm-crosschain.domino.money and its Access application. It quotes and tracks through the Relay and Across APIs and
never signs. Like the plan listener (install_position_plan.py), nothing installed it so far; this tool does both
the first install and the moves.

First install, once per host:
- the identity domino-crosschain (system user, nologin, group domino-db);
- its peer row `domino domino-crosschain domino_session_auth`, beside the plan listener's: the listener checks the
  app's sessions (session_store). The row is proven by a connection as that user before anything else is written;
- its private directory /etc/domino/financial/crosschain (0700, the operator's rpc.json and environment: the fee
  recipient, the Access application, the session origin and abuse secret) and its runtime
  /var/lib/domino-financial/crosschain (0700) with catalogue-db.json and the process lock.

Every release:
- /opt/domino/financial/releases/<commit>/crosschain holds backend (without its tests; the reviewed provider pins
  are backend/crosschain_pins.json) and api-contracts/v2 (the destination chains' profiles), 0555;
- domino-crosschain.service names that release. The listener starts without --enable, which only the continuous
  egress policy's drop-in adds. The providers' keys, once the owner seals them on the host, come as credentials
  only (ImportCredential=relay-api-key and across-api-key; the environment's variables for them are unset): Relay
  quotes without a key, and Across' limits without one are strict. Both are sealed with the host's TPM, which
  systemd 255 leaves out of the device policy for ImportCredential= (it adds it only for LoadCredentialEncrypted=),
  so the unit opens it itself (the plan listener's outage of 4 Oct).

Rollback puts back the unit that was there before, or its absence. The identity, its peer row, the directories,
the releases and the receipts stay.
"""
import argparse
import json
import os
from pathlib import Path
import pwd
import re
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent))
import check_filesystem as filesystem
import install_position_plan as plan_listener
import prepare_disabled as install
import upgrade_financial as financial
from install_read_release import read_installed

require = install.require
COMPONENT = 'crosschain'
OS_USER = 'domino-crosschain'
SQL_ROLE = plan_listener.SQL_ROLE
PEER_MAP = plan_listener.PEER_MAP
PORT = 8910
UNIT = f'domino-{COMPONENT}.service'
PRIVATE = financial.PRIVATE / COMPONENT
RUNTIME = financial.RUNTIME / COMPONENT
RELEASES = financial.ROOT / 'releases'
RECEIPTS = Path('/var/backups/domino-crosschain-release')
CONFIG = f'/run/domino-financial-{COMPONENT}-config'
ENTRY = 'backend/crosschain_api.py'
PINS = 'backend/crosschain_pins.json'
PROFILE = 'api-contracts/v2/chains/robinhood-4663.json'
LOCKFILE = plan_listener.LOCKFILE
CATALOGUE = plan_listener.CATALOGUE
HBA_ROW = plan_listener.HBA_ROW
PEER_ROW = (PEER_MAP, OS_USER, SQL_ROLE)
# The providers' keys: credentials only, never the environment (crosschain_config.py reads either).
CREDENTIALS = ('relay-api-key', 'across-api-key')
KEY_VARIABLES = ('DOMINO_RELAY_API_KEY', 'DOMINO_ACROSS_API_KEY', 'DOMINO_CROSSCHAIN_RPC_URL_4663',
                 'DOMINO_CROSSCHAIN_RPC_URL_8453', 'DOMINO_CROSSCHAIN_RPC_URL_42161')
sha = plan_listener.sha
ident_rows = plan_listener.ident_rows
running_lock = plan_listener.running_lock
owned_directory = plan_listener.owned_directory
locked = plan_listener.locked


def unit_text(commit):
    """The listener's unit for one release; no [Install]: the egress target wants it once it is a family."""
    root = RELEASES / commit / COMPONENT
    credentials = ''.join(f'ImportCredential={name}\n' for name in CREDENTIALS)
    return f'''[Unit]
Description=Domino S2 crosschain listener ({commit})
After=postgresql@16-domino.service
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=exec
User={OS_USER}
Group={OS_USER}
SupplementaryGroups=domino-db
WorkingDirectory={root}
ExecStart={install.PYTHON} -B backend/crosschain_api.py --port {PORT}
Environment=PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 WEB_CONCURRENCY=1 UVICORN_WORKERS=1
EnvironmentFile=-{PRIVATE}/environment
{credentials}DeviceAllow=char-tpm rw
UnsetEnvironment=PYTHONPATH PYTHONHOME DOMINO_DISCOVERY_RPC_URL DOMINO_INVENTORY_RPC_URL {' '.join(KEY_VARIABLES)}
UMask=0077
ProtectSystem=strict
BindPaths={RUNTIME}:{root}/backend/runtime
BindReadOnlyPaths={PRIVATE}:{CONFIG}
ReadWritePaths={RUNTIME}
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
NoNewPrivileges=true
CapabilityBoundingSet=
RestrictSUIDSGID=true
LimitCORE=0
IPAddressDeny=any
IPAddressAllow=localhost
RestrictAddressFamilies=AF_UNIX AF_INET
MemoryMax=512M
TasksMax=48
Restart=on-failure
RestartSec=5
TimeoutStartSec=30
TimeoutStopSec=30
KillMode=control-group
'''


def release_of(text):
    """The release a unit this tool wrote names, or None."""
    found = re.search(r'^WorkingDirectory=' + re.escape(str(RELEASES)) + r'/([0-9a-f]{40})/' + COMPONENT + '$',
                      text, re.M)
    return found.group(1) if found else None


def with_peer_row(original_ident):
    """pg_ident.conf with the listener's row appended, once."""
    require(PEER_ROW not in ident_rows(original_ident), 'peer_row_exists')
    return original_ident + (b'' if original_ident.endswith(b'\n') or not original_ident else b'\n') + \
        (' '.join(PEER_ROW) + '\n').encode()


def selected(files):
    """What a release carries: backend without its tests, and api-contracts/v2 for the destination profiles."""
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
    require(PINS in files, 'provider_pins_missing')
    require(PROFILE in files, 'chain_profiles_missing')
    require(sha(files[LOCKFILE][0]) == sha(running_lock()), 'dependency_lock_changed')
    root = RELEASES / commit / COMPONENT
    require(not root.exists() and not root.is_symlink(), 'release_directory_exists')
    unit = install.UNIT_DIR / UNIT
    previous = None
    if unit.exists() or unit.is_symlink():
        previous = read_installed(unit).decode()
        installed = release_of(previous)
        require(installed is not None, 'unit_drift')
        # The unit as this tool wrote it is the one its receipt keeps (#339): the template may move on.
        receipt = RECEIPTS / f'{installed}.json'
        written = (json.loads(read_installed(receipt))['unit'] if receipt.exists() or receipt.is_symlink()
                   else unit_text(installed))
        require(previous == written, 'unit_drift')
        require(installed != commit, 'release_already_running')
    hba = ident_rows(read_installed(install.CONFIG / 'pg_hba.conf'))
    require(HBA_ROW in hba, 'session_peer_rule_missing')
    first = {'identity': account() is None,
             'peerRow': PEER_ROW not in ident_rows(read_installed(install.CONFIG / 'pg_ident.conf')),
             'privateDirectory': not PRIVATE.exists(), 'runtimeDirectory': not RUNTIME.exists()}
    return {'mode': 'crosschain-install', 'commit': commit, 'archiveSha256': digest,
            'target': str(root), 'unit': unit_text(commit), 'previousUnit': previous,
            'previousRelease': None if previous is None else release_of(previous),
            'firstInstall': first, 'files': len(selected(files)),
            'notPerformed': ['daemon-reload', 'service start or restart', 'private rpc.json and environment',
                             'continuous egress policy', 'tunnel route and Access application',
                             'provider keys (sealed by the owner)']}


def write_new(path, payload, mode):
    """One file that must not exist yet, with exactly this mode whatever the umask."""
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as stream:
        os.fchmod(stream.fileno(), mode)
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
    # The mount point the unit binds the listener's private runtime over.
    (staging / 'backend/runtime').mkdir(mode=0o700)
    for path, _, _ in os.walk(staging, topdown=False):
        os.chmod(path, 0o555)
    require(not (release / COMPONENT).exists(), 'release_directory_exists')
    os.rename(staging, release / COMPONENT)
    if created:
        os.chmod(release, 0o555)


def first_install(planned):
    """The identity, its proven peer row and its directories, each only when missing."""
    done = []
    if account() is None:
        install.run(['/usr/sbin/useradd', '--system', '--user-group', '--no-create-home', '--home-dir',
                     '/nonexistent', '--shell', '/usr/sbin/nologin', '--groups', 'domino-db', OS_USER])
        done.append('identity')
    user = account()
    require(user is not None, 'identity_missing')
    ident = install.CONFIG / 'pg_ident.conf'
    original = read_installed(ident)
    if PEER_ROW not in ident_rows(original):
        install.replace_pg_config(ident, with_peer_row(original))
        install.validate_pg_files()
        require(install.sql('SELECT pg_catalog.pg_reload_conf()') == 't', 'postgres_reload_failed')
        done.append('peerRow')
    for attempt in range(20):
        try:
            require(install.sql('SELECT current_user', os_user=OS_USER, role=SQL_ROLE) == SQL_ROLE,
                    'peer_identity_mismatch')
            break
        except ValueError:
            if attempt == 19:
                raise
            time.sleep(0.1)
    for parent in (financial.PRIVATE, financial.RUNTIME):
        require(parent.is_dir() and not parent.is_symlink(), 'financial_base_missing')
    if not PRIVATE.exists():
        owned_directory(PRIVATE, user)
        done.append('privateDirectory')
    if not RUNTIME.exists():
        owned_directory(RUNTIME, user)
        done.append('runtimeDirectory')
    catalogue = RUNTIME / 'catalogue-db.json'
    if not catalogue.exists():
        install.exclusive_file(catalogue, (json.dumps(CATALOGUE, sort_keys=True) + '\n').encode(), 0o600,
                               user.pw_uid, user.pw_gid)
        done.append('catalogueSettings')
    # crosschain_api.py takes its process lock in backend/runtime/crosschain.
    state = RUNTIME / COMPONENT
    if not state.exists():
        owned_directory(state, user)
    return done


def write_unit(text):
    path = install.UNIT_DIR / UNIT
    temporary = path.with_name(path.name + '.crosschain-new')
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
        done = first_install(planned)
        install_source(files, planned['commit'])
        install.exclusive_file(receipt, (json.dumps({**planned, 'firstInstallDone': done}, sort_keys=True, indent=2)
                                         + '\n').encode())
        write_unit(planned['unit'])
        install.run(['/usr/bin/systemd-analyze', 'verify', '--man=no', str(install.UNIT_DIR / UNIT)])
        return {'ok': True, 'mode': planned['mode'], 'commit': planned['commit'], 'target': planned['target'],
                'firstInstallDone': done, 'receipt': str(receipt),
                'next': 'write rpc.json and environment, render the egress policy with crosschain, '
                        'daemon-reload, then start the unit',
                'rollback': f"install_crosschain.py --rollback {planned['commit']}"}


def rollback(commit):
    require(os.geteuid() == 0, 'root_required')
    require(re.fullmatch('[0-9a-f]{40}', commit) is not None, 'invalid_commit')
    with locked():
        receipt = RECEIPTS / f'{commit}.json'
        install.trusted_parents(receipt)
        saved = json.loads(read_installed(receipt))
        require(saved.get('commit') == commit and saved.get('mode') == 'crosschain-install', 'invalid_receipt')
        unit = install.UNIT_DIR / UNIT
        require(unit.exists() and read_installed(unit).decode() == saved['unit'], 'unit_changed_since_apply')
        if saved['previousUnit'] is None:
            unit.unlink()
            install.fsync_directory(unit.parent)
        else:
            write_unit(saved['previousUnit'])
        return {'ok': True, 'mode': 'crosschain-rollback', 'commit': commit,
                'unit': 'removed' if saved['previousUnit'] is None else saved['previousRelease'],
                'kept': ['identity', 'peer row', 'directories', 'releases', 'receipts'],
                'next': 'daemon-reload, then restart or stop the listener'}


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
