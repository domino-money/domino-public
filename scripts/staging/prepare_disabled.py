#!/usr/bin/env python3
"""Plan (default) or install one disabled release on the fixed Ubuntu VM foundation.

No SSH, dependency installation, provider configuration, service start or upgrade.
Run from a separately reviewed copy; the archive must be a trusted plain Git tar.
"""
import argparse
import fcntl
import grp
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import signal
import stat
import subprocess
import tarfile
import time

from catalogue_inventory import NO_PERSISTENT_OVERRIDES, check_inventory, inventory_sql

BASE = Path('/opt/domino')
VENV = BASE / 'backend-venv'
PYTHON = VENV / 'bin/python3.14'
PG = Path('/usr/lib/postgresql/16/bin')
CONFIG = Path('/etc/postgresql/16/domino')
DATA = Path('/var/lib/postgresql/16/domino')
SOCKET = '/run/postgresql-domino'
DB = 'domino_catalogue'
ADMIN = 'domino_catalogue_admin'
DEPOSIT = 'domino_deposit_service'
BACKUPS = Path('/var/backups/domino-disabled')
UNIT_DIR = Path('/etc/systemd/system')
ENV = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LANG': 'C.UTF-8',
       'PGCONNECT_TIMEOUT': '5', 'PGOPTIONS': '-c search_path=pg_catalog',
       'PYTHONDONTWRITEBYTECODE': '1'}
COMMAND_TIMEOUT = 180
SERVICES = {
    'read': ('read_api.py', '--port 8876 --read-budget 15'),
    'gateway': ('read_gateway.py', '--port 8878 --reader-port 8876'),
    'auth': ('session_api.py', '--port 8879'),
    'onboarding': ('onboarding_api.py', '--port 8880'),
    'deposit': ('deposit_api.py', '--port 8881'),
}
ROOTS = (*SERVICES, 'operator', 'write')
# A foundation file must match between the installed release and the one being
# installed, because these installers compare those files and neither replays a
# migration during an upgrade. Exact transitions are pinned by both digests so
# anything else still fails closed. Migration 006 adds NOT VALID to the source
# check; schema.sql is candidate source only, and its tariff check changes from
# 0..200 to the released 200/400 mode policy without being executed by upgrade.
FOUNDATION_SUCCESSORS = {
    'backend/migrations/006_chainlink_prices.sql': {
        '52e16a5775278a297cfbfdc560d7b8183da33946c0f13b60a9d21c137fc0b1f3':
            '256c574f256c4481655cda4c0f794854ef5e5c23a6cf3a71363d8bf024db4574'},
    'backend/schema.sql': {
        '2653b9faccd9bfd8af1d6f140ebb0b9fcec6f4c3f95649f70c91a646e7bac0c5':
            '5f49ac20748a024c5cb44a5a9d7fdd8963782c38a9ad3551065e806a7cebbf76'},
}


# pg_hba matches the first row that fits, so an owned row must keep its position
# and no other row may claim its (connection, database, user). The ident map has
# no order, but a foreign row must not rebind a (map, system user) pair this
# installer owns. Rows beyond those belong to whoever added them: the financial
# upgrade and the development lane each add their own roles, ahead of the
# catch-all reject, which is the only place such a row can work.
AUTH_KEY = {'pg_hba.conf': 3, 'pg_ident.conf': 2}
# An ident row is exactly (map, system user, database user); an hba row carries
# at least a connection, a database, a user and a method. A row of any other
# shape belongs to no installer and is refused whatever it claims.
AUTH_SHAPE = {'pg_hba.conf': lambda row: 4 <= len(row) <= 6,
              'pg_ident.conf': lambda row: len(row) == 3}


def owns_auth(name, rows, expected):
    """True when every owned row is present, in order, and nothing shadows one."""
    if not all(AUTH_SHAPE[name](row) for row in rows):
        return False
    owned = {row[:AUTH_KEY[name]] for row in expected}
    if any(row[:AUTH_KEY[name]] in owned for row in rows if row not in expected):
        return False
    remaining = list(rows)
    for row in expected:
        if row not in remaining:
            return False
        remaining = remaining[remaining.index(row) + 1:]
    return True


def succeeds(name, installed, wanted):
    """True when a frozen file is unchanged, or changed exactly as one pin allows.

    Callers hold either the digests themselves or the archive's
    (contents, executable) pairs; a missing file reaches here as None and is
    never a succession. An executable bit change is a change like any other.
    """
    if installed == wanted:
        return True
    allowed = FOUNDATION_SUCCESSORS.get(name, {})
    if isinstance(installed, str) and isinstance(wanted, str):
        return allowed.get(installed) == wanted
    if (isinstance(installed, tuple) and isinstance(wanted, tuple)
            and len(installed) == len(wanted) == 2 and installed[1] == wanted[1]):
        return allowed.get(hashlib.sha256(installed[0]).hexdigest()) == \
            hashlib.sha256(wanted[0]).hexdigest()
    return False


# The fixed foundation applied by this installer, not every SQL file in a release.
MIGRATIONS = tuple('backend/migrations/' + name + '.sql' for name in (
    '001_catalogue', '002_activity', '003_fee_ledger', '004_positions',
    '005_capital_prices', '006_chainlink_prices', '007_historical_work',
    '008_wallet_sessions', '009_direct_deposits', '010_deposit_recovery',
    '011_wallet_access', '012_capital_work', '013_activity_diagnostics',
    '014_deposit_draft_recovery'))
# Optional source files for separately deployed subsystems. Packaging these does
# not admit their schemas/roles or claim they were applied in the receipts.
PACKAGED_ONLY_MIGRATIONS = (
    'backend/migrations/015_unsigned_execution.sql',
    'backend/migrations/016_managed_performance.sql',
    'backend/migrations/017_performance_financial_history.sql',
    'backend/migrations/018_performance_enrollment.sql',
    'backend/migrations/019_execution_journal.sql',
    # The demand queue for on-demand pool indexing; applied by the
    # post-foundation upgrade, not by the disabled foundation.
    'backend/migrations/020_pool_requests.sql',
    # Explicitly mapped external market references; same vehicle.
    'backend/migrations/021_reference_price_sources.sql',
    # The event timestamp source; same vehicle.
    'backend/migrations/022_event_timestamp_source.sql',
    # Public collector activation applies these separately from financial services.
    'backend/migrations/023_pool_request_scheduling.sql',
    'backend/migrations/024_public_observations.sql',
    'backend/migrations/025_public_history.sql',
    'backend/migrations/026_public_demand.sql',
    # Detaches migration 011's session-insert gate from an already installed
    # foundation (issue #182). The foundation above still applies 011, so a new
    # installation applies this one separately, as the runbook records.
    'backend/migrations/027_remove_wallet_access_gate.sql',
    # The automation cycle's own state and publisher role; applied with the
    # automation activation, never by the disabled foundation.
    'backend/migrations/028_automation_cycle.sql',
    # The ledger's reader of vault fee events; same vehicle as 028.
    'backend/migrations/029_ledger_index.sql',
    # The pools' shared swap cap and the failure count; same vehicle as 028.
    'backend/migrations/030_swap_exposure.sql',
    # The publisher sends an expired publication's bytes again; same vehicle as 028.
    'backend/migrations/031_publication_resend.sql',
    # Shared pilot gas accounting belongs to the automation installer.
    'backend/migrations/032_shared_gas_budget.sql',
    'backend/migrations/033_gas_budget_claim_read.sql',
    'backend/migrations/034_gas_settlement_sweep.sql',
    'backend/migrations/035_cancel_unsigned_gas_claims.sql',
    'backend/migrations/036_gas_settlement_journal_read.sql',
    'backend/migrations/037_gas_settlement_receipt_evidence.sql',
    'backend/migrations/038_gas_settlement_quote_witness.sql',
    'backend/migrations/039_automation_readiness.sql',
    'backend/migrations/040_gas_finalized_quote_lag.sql',
    # Session policy eoa_or_7702_v1 (EIP-7702 accounts may sign in). Like 027,
    # applied separately to an installed foundation, as the runbook records.
    'backend/migrations/041_session_delegated_accounts.sql',
    # Provider calls by priority for the public collector; same vehicle as 024.
    'backend/migrations/042_provider_priority.sql',
    # The featured-pools selection's tables; same vehicle as 024.
    'backend/migrations/043_featured_pools.sql',
    # The public collector's demand horizon; same vehicle as 024.
    'backend/migrations/044_demand_horizon.sql',
    # The featured-pools live list: health tracking and the owner's phase; same vehicle as 024.
    'backend/migrations/045_featured_live.sql',
    # The gas cap accepts an ETH/USD answer as old as the feed's heartbeat; same
    # vehicle as 032 (the automation installer and its readiness upgrade).
    'backend/migrations/046_gas_answer_heartbeat.sql',
    # The provider allowance at the provider's real limit; same vehicle as 042.
    'backend/migrations/047_provider_ceiling.sql',
    # The V2 index (read-v6): apply_migrations.py applies it as postgres before the V2 indexer
    # is registered, never this tool.
    'backend/migrations/052_v2_index.sql',
    # The ledgers' per-chunk index on domino_activity.events: apply_migrations.py applies it
    # as the catalogue owner, never this tool.
    'backend/migrations/053_activity_chunk_index.sql',
    # The V2 fee follower's tables (read-v6 position-fees): apply_migrations.py applies it as
    # postgres, as 052, never this tool.
    'backend/migrations/054_v2_fees.sql',
    # The featured-pools tables per chain (Base and Arbitrum in shadow): apply_migrations.py
    # applies it as postgres, with domino-featured stopped, never this tool.
    'backend/migrations/055_featured_chains.sql',
    # The activity follower's mint-scan checkpoint: apply_migrations.py applies it as the
    # catalogue owner, never this tool.
    'backend/migrations/056_position_mint_scan.sql',
    # The session's origin (launch round P3, review M1). Like 041, applied separately to an
    # installed foundation, by apply_migrations.py as postgres.
    'backend/migrations/057_session_origin.sql',
)
MAPPINGS = (
    ('domino', 'domino-admin', ADMIN),
    ('domino', 'domino-read', 'domino_catalogue_reader'),
    ('domino', 'domino-write', 'domino_catalogue_writer'),
    ('domino', 'domino-auth', 'domino_session_auth'),
    ('domino', 'domino-operator', 'domino_wallet_access_operator'),
)
NEW_MAPPINGS = (('domino', 'domino-onboarding', 'domino_session_auth'),
                ('domino', 'domino-deposit', 'domino_session_auth'),
                ('domino', 'domino-deposit', DEPOSIT))
HBA = (('local', 'all', 'postgres', 'peer'),
       *(('local', DB, role, 'peer', 'map=domino') for _, _, role in MAPPINGS),
       ('local', 'all', 'all', 'reject'),
       ('host', 'all', 'all', '0.0.0.0/0', 'reject'),
       ('host', 'all', 'all', '::0/0', 'reject'))
EMPTY = """NOT EXISTS (SELECT FROM pg_catalog.pg_namespace
 WHERE nspname NOT IN ('public','information_schema') AND nspname !~ '^pg_')
 AND NOT EXISTS (SELECT FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public')
 AND NOT EXISTS (SELECT FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
 WHERE n.nspname='public')
 AND NOT EXISTS (SELECT FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace
 WHERE n.nspname='public')
 AND NOT EXISTS (SELECT FROM pg_catalog.pg_extension WHERE extname<>'plpgsql')
 AND NOT EXISTS (SELECT FROM pg_catalog.pg_largeobject_metadata)
 AND """ + NO_PERSISTENT_OVERRIDES


def require(condition, message):
    if not condition:
        raise ValueError(message)


# A release archive is `git archive` of one commit, the whole repository, and it is read whole with every member
# kept in memory, so each of these bounds it (inclusive). The archive was at most 64 MiB, and the expansion 128 MiB,
# until 6 Oct 2026: main's archive had reached 62.7 MB, after growing about 2 MB in a day. Each installer reads the
# archive once, so 256 MiB plus its members stays far below the VM's memory (7.7 GB).
MAX_ARCHIVE_BYTES = 256 * 1024 * 1024
MAX_EXPANDED_BYTES = 256 * 1024 * 1024
MAX_MEMBER_BYTES = 32 * 1024 * 1024
MAX_MEMBERS = 20000


def archive_files(path, digest, commit):
    """Read once; hash and validate every member before any extraction or mutation."""
    require(re.fullmatch('[0-9a-f]{64}', digest), 'archive SHA256 must be lowercase hex')
    require(re.fullmatch('[0-9a-f]{40}', commit), 'commit must be a full lowercase Git SHA')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_size <= MAX_ARCHIVE_BYTES,
                f'archive must be a regular plain tar of at most {MAX_ARCHIVE_BYTES >> 20} MiB')
        payload = stream.read(MAX_ARCHIVE_BYTES + 1)
    require(hashlib.sha256(payload).hexdigest() == digest, 'archive SHA256 mismatch')
    files, kinds, total = {}, {}, 0
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:') as archive:
        require(archive.pax_headers.get('comment') == commit, 'Git tar commit header mismatch')
        for member in archive:
            name = member.name.rstrip('/')
            parts = name.split('/')
            require(name and not name.startswith('/') and '\\' not in name
                    and not any(part in ('', '.', '..') for part in parts)
                    and not any(ord(c) < 32 or ord(c) == 127 for c in name), 'unsafe tar path')
            require(name not in kinds and len(kinds) < MAX_MEMBERS, 'duplicate or excessive tar members')
            require(member.isfile() or member.isdir(), 'tar links and special files are forbidden')
            require(not member.sparse, 'sparse tar files are forbidden')
            require(not set(parts) & {'.git', '.venv', 'runtime', 'node_modules', '__pycache__'},
                    'archive includes a runtime, dependency or Git work directory')
            total += member.size
            require(0 <= member.size <= MAX_MEMBER_BYTES and total <= MAX_EXPANDED_BYTES,
                    'expanded tar size limit exceeded')
            kinds[name] = member.isdir()
            if member.isfile():
                files[name] = (archive.extractfile(member).read(), bool(member.mode & 0o111))
    for name in kinds:
        require(all(kinds.get(str(parent), True) for parent in PurePosixPath(name).parents
                    if str(parent) != '.'), 'tar file used as a directory')
    needed = (*MIGRATIONS, 'backend/requirements-api.lock',
              *('backend/' + script for script, _ in SERVICES.values()))
    require(all(name in files for name in needed), 'required release file missing')
    require({name for name in files if name.startswith('backend/migrations/')}
            <= set(MIGRATIONS) | set(PACKAGED_ONLY_MIGRATIONS),
            'release includes an unsupported migration file')
    return files


def packaged_only_migrations(files):
    """Record inert SQL source independently from the applied foundation."""
    return [{'path': name, 'sha256': hashlib.sha256(files[name][0]).hexdigest()}
            for name in PACKAGED_ONLY_MIGRATIONS if name in files]


def unit_text(component, commit):
    root = BASE / 'releases' / commit / component
    script, args = SERVICES[component]
    return f'''[Unit]
Description=Domino disabled staging {component} ({commit})
After=postgresql@16-domino.service
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=exec
User=domino-{component}
Group=domino-{component}
WorkingDirectory={root}
ExecStart={root}/backend/.venv/bin/python3.14 -B backend/{script} {args}
Environment=PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 WEB_CONCURRENCY=1 UVICORN_WORKERS=1
UnsetEnvironment=PYTHONPATH PYTHONHOME DOMINO_DISCOVERY_RPC_URL DOMINO_INVENTORY_RPC_URL
UMask=0077
ProtectSystem=strict
ReadWritePaths={root}/backend/runtime
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
NoNewPrivileges=true
CapabilityBoundingSet=
RestrictSUIDSGID=true
LimitCORE=0
IPAddressDeny=any
IPAddressAllow=localhost
Restart=on-failure
RestartSec=5
TimeoutStartSec=30
TimeoutStopSec=30
KillMode=control-group
'''


def plan(files, digest, commit):
    planned = {'mode': 'disabled-install-plan', 'hostValidated': False,
            'commit': commit, 'archiveSha256': digest,
            'target': str(BASE / 'releases' / commit),
            'backup': str(BACKUPS / commit),
            'migrations': [{'path': p, 'sha256': hashlib.sha256(files[p][0]).hexdigest()}
                           for p in MIGRATIONS],
            'dependencyLockSha256': hashlib.sha256(files['backend/requirements-api.lock'][0]).hexdigest(),
            'newPeerMappings': NEW_MAPPINGS,
            'units': {f'domino-{c}.service': unit_text(c, commit) for c in SERVICES},
            'steps': ['Require root, Ubuntu24.04, fixed PG16 foundation and exact locked venv.',
                      'Refuse nonempty DB, clients, existing release, units, users or deposit role.',
                      'Back up PG configs, ownership/modes and empty database privately.',
                      'Create only onboarding/deposit OS users and fixed deposit SQL role.',
                      'Install seven separate immutable code roots and private runtime descriptors.',
                      'Add exact peer mappings; validate files, reload PG and prove peer identities.',
                      'Apply001–014 as domino-admin in one PostgreSQL transaction.',
                      'Write five static units, systemd-analyze verify and daemon-reload only.'],
            'notPerformed': ['service start/enable', 'network or provider configuration',
                             'wallet grants', 'Cloudflare/Tunnel', 'cron', 'firewall changes',
                             'dependency installation', 'upgrade or destructive rollback']}
    # Keep legacy plans unchanged when the release contains only the foundation.
    packaged = packaged_only_migrations(files)
    if packaged:
        planned['packagedOnlyMigrations'] = packaged
    return planned


def run(args, *, data=None, stdout=None):
    process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=stdout or subprocess.PIPE,
                               stderr=subprocess.PIPE, env=ENV, start_new_session=True)
    try:
        output, _ = process.communicate(data, timeout=COMMAND_TIMEOUT)
    except subprocess.TimeoutExpired:
        # Terminate runuser AND its psql/pg_dump child. An orphaned psql must
        # not commit a migration after the installer has reported failure.
        os.killpg(process.pid, signal.SIGKILL)
        process.communicate()
        raise ValueError(f'command timed out: {Path(args[0]).name}') from None
    require(process.returncode == 0, f'command failed: {Path(args[0]).name}; stop and inspect locally')
    return output


def sql(query, *, os_user='postgres', role='postgres', transaction=False):
    args = ['/usr/sbin/runuser', '-u', os_user, '--', str(PG / 'psql'),
            '-X', '-w', '-qAt', '-v', 'ON_ERROR_STOP=1', '-h', SOCKET,
            '-p', '8877', '-U', role, '-d', DB]
    if transaction:
        args.append('--single-transaction')
    return run([*args, '-f', '-'], data=query.encode()).decode().strip()


def trusted(path, owner=0):
    info = path.lstat()
    require(not stat.S_ISLNK(info.st_mode) and info.st_uid == owner
            and not info.st_mode & 0o022, f'untrusted ownership/mode: {path}')
    return info


def trusted_parents(path):
    for parent in (path, *path.parents):
        trusted(parent)


def pg_parents(path):
    pg_uid = pwd.getpwnam('postgres').pw_uid
    for parent in (path, *path.parents):
        info = parent.lstat()
        require(not stat.S_ISLNK(info.st_mode) and info.st_uid in (0, pg_uid)
                and not info.st_mode & 0o022, f'untrusted PostgreSQL path: {parent}')


def normalized_config(path):
    return tuple(tuple(line.split('#', 1)[0].split()) for line in path.read_text().splitlines()
                 if line.split('#', 1)[0].strip())


def dependency_preflight(files):
    trusted_parents(VENV)
    for directory, dirs, names in os.walk(VENV, followlinks=False):
        for name in dirs + names:
            path = Path(directory) / name
            if path.is_symlink():
                target = path.resolve(strict=True)
                require(not target.is_dir() or target.is_relative_to(VENV),
                        'venv directory symlink leaves the reviewed environment')
                trusted_parents(target)
            else:
                trusted(path)
    expected = {}
    for line in files['backend/requirements-api.lock'][0].decode().splitlines():
        if not line.strip() or line.startswith('#'):
            continue
        require(re.fullmatch(r'[A-Za-z0-9_.-]+==[A-Za-z0-9_.+-]+', line), 'lock must contain exact pins')
        name, version = line.split('==')
        expected[re.sub('[-_.]+', '-', name).lower()] = version
    code = "import importlib.metadata as m,json,re,sys; assert sys.version_info[:2]==(3,14); print(json.dumps({re.sub('[-_.]+','-',d.metadata['Name']).lower():d.version for d in m.distributions()}))"
    installed = json.loads(run([str(PYTHON), '-I', '-B', '-c', code]))
    require({k: v for k, v in installed.items() if k not in {'pip', 'setuptools', 'wheel'}} == expected,
            'venv distributions do not exactly match release lock (excluding packaging tools)')
    run([str(PYTHON), '-I', '-B', '-m', 'pip', 'check'])


def preflight(files, commit):
    release = BASE / 'releases'
    require(os.geteuid() == 0, '--apply requires root')
    os_release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    require(os_release.get('ID', '').strip('"') == 'ubuntu'
            and os_release.get('VERSION_ID', '').strip('"') == '24.04', 'requires Ubuntu24.04')
    dependency_preflight(files)
    for directory in (BASE, UNIT_DIR):
        trusted_parents(directory)
    pg_parents(CONFIG)
    pg_parents(DATA)
    require(not release.is_symlink(), 'releases directory cannot be a symlink')
    if release.exists():
        trusted(release)
        require(not any(release.iterdir()), 'releases directory is not empty')
    require(not os.path.lexists(BASE / 'current'), 'existing current release link')
    require(not os.path.lexists(BACKUPS / commit), 'backup already exists; inspect previous attempt')
    for command in ('list-unit-files', 'list-units'):
        units = run(['/usr/bin/systemctl', command, '--all', '--no-legend', '--no-pager']).decode()
        require(not any(re.match(r'^\s*(?:●\s*)?domino[^\s]*\.(service|socket|timer)\s', line)
                        for line in units.splitlines()),
                'conflicting Domino systemd unit')
    for component in SERVICES:
        require(not os.path.lexists(UNIT_DIR / f'domino-{component}.service'), 'unit already exists')
    listeners = run(['/usr/bin/ss', '-H', '-ltn']).decode()
    require(not re.search(r':(?:8876|8878|8879|8880|8881)\s', listeners), 'application port already listening')
    members = set(grp.getgrnam('domino-db').gr_mem)
    expected_members = {row[1] for row in MAPPINGS} | {'postgres'}
    require(members == expected_members, 'unexpected domino-db members')
    for user in (*expected_members, 'domino-gateway', 'domino-tunnel'):
        account = pwd.getpwnam(user)
        require(account.pw_uid != 0, 'service account cannot be root')
        require(grp.getgrnam(user).gr_gid == account.pw_gid, 'unexpected service primary group')
        require((grp.getgrnam('domino-db').gr_gid in os.getgrouplist(user, account.pw_gid))
                == (user in expected_members), 'unexpected socket group access')
    for user in ('domino-onboarding', 'domino-deposit'):
        require(user not in {p.pw_name for p in pwd.getpwall()}
                and user not in {g.gr_name for g in grp.getgrall()}, 'new OS identity already exists')
    pg_uid = pwd.getpwnam('postgres').pw_uid
    socket_directory = Path(SOCKET).lstat()
    require(stat.S_ISDIR(socket_directory.st_mode) and socket_directory.st_uid == pg_uid
            and socket_directory.st_gid == grp.getgrnam('domino-db').gr_gid
            and stat.S_IMODE(socket_directory.st_mode) == 0o750, 'unexpected socket directory')
    socket = (Path(SOCKET)/'.s.PGSQL.8877').lstat()
    require(stat.S_ISSOCK(socket.st_mode) and socket.st_uid == pg_uid
            and socket.st_gid == grp.getgrnam('domino-db').gr_gid
            and stat.S_IMODE(socket.st_mode) == 0o770, 'unexpected PostgreSQL socket')
    for name, expected in [('pg_hba.conf', HBA), ('pg_ident.conf', MAPPINGS)]:
        path = CONFIG / name
        info = trusted(path, pg_uid)
        require(stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600,
                'unexpected PG auth config mode/type')
        require(info.st_gid == pwd.getpwnam('postgres').pw_gid, 'unexpected PG auth config group')
        require(normalized_config(path) == expected, 'PG auth foundation differs from reviewed snapshot')
    settings = json.loads(sql("SELECT pg_catalog.json_object_agg(name,setting) FROM pg_catalog.pg_settings WHERE name IN "
        "('server_version_num','server_encoding','data_directory','config_file','hba_file','ident_file','port',"
        "'listen_addresses','unix_socket_directories','unix_socket_permissions','unix_socket_group')"))
    require(settings.get('server_encoding') == 'UTF8' and sql(
        "SELECT pg_catalog.pg_encoding_to_char(encoding) FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()") == 'UTF8',
        'PostgreSQL database and server_encoding must be UTF8')
    expected = {'data_directory': str(DATA), 'config_file': str(CONFIG/'postgresql.conf'),
                'hba_file': str(CONFIG/'pg_hba.conf'), 'ident_file': str(CONFIG/'pg_ident.conf'),
                'port': '8877', 'listen_addresses': '', 'unix_socket_directories': SOCKET,
                'unix_socket_permissions': '0770', 'unix_socket_group': 'domino-db'}
    require(all(settings[k] == v for k, v in expected.items())
            and 160000 <= int(settings['server_version_num']) < 170000, 'unexpected PostgreSQL foundation')
    inventory = check_inventory(json.loads(sql(inventory_sql())), installed=False)
    override_categories = {
        'noDefaultAclOverrides': 'default privilege overrides (pg_default_acl)',
        'noPersistentRoleDatabaseSettings': 'persistent role/database overrides (pg_db_role_setting)',
        'noParameterAclOverrides': 'parameter privilege overrides (pg_parameter_acl)',
    }
    unexpected = [category for key, category in override_categories.items() if not inventory[key]]
    require(not unexpected, 'unexpected PostgreSQL overrides: ' + ', '.join(unexpected))
    require(all(inventory.values()), 'unexpected foundation catalogue inventory: ' +
            ','.join(name for name, passed in inventory.items() if not passed))
    require(sql(f'SELECT {EMPTY}') == 't', 'database is not empty')
    require(sql("SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()") == ADMIN,
            'wrong database owner')
    require(sql("SELECT pg_catalog.count(*) FROM pg_catalog.pg_stat_activity WHERE datname=pg_catalog.current_database() "
                "AND pid<>pg_catalog.pg_backend_pid() AND backend_type='client backend'") == '0', 'other DB clients connected')
    roles = json.loads(sql("SELECT pg_catalog.json_agg(rolname ORDER BY rolname) FROM pg_catalog.pg_roles WHERE rolname ~ '^domino_'"))
    require(roles == sorted(row[2] for row in MAPPINGS), 'unexpected Domino SQL roles')
    require(sql("SELECT pg_catalog.count(*) FROM pg_catalog.pg_roles WHERE rolname ~ '^domino_' "
        "AND (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit OR NOT rolcanlogin)") == '0',
        'unexpected Domino SQL role privileges')
    require(sql("SELECT pg_catalog.count(*) FROM pg_catalog.pg_auth_members m JOIN pg_catalog.pg_roles r ON r.oid=m.member "
        "JOIN pg_catalog.pg_roles g ON g.oid=m.roleid WHERE r.rolname ~ '^domino_' "
        "OR g.rolname ~ '^domino_'") == '0', 'unexpected SQL role memberships')
    validate_pg_files()
    return settings


def validate_pg_files():
    for view in ('pg_hba_file_rules', 'pg_ident_file_mappings'):
        require(sql(f'SELECT pg_catalog.count(*) FROM pg_catalog.{view} WHERE error IS NOT NULL') == '0', f'invalid {view}')


def verify_new_peers():
    # pg_catalog.pg_reload_conf() signals the server; positive new connections prove that
    # the new mappings are actually loaded, not merely parseable on disk.
    for _, user, role in NEW_MAPPINGS:
        for attempt in range(20):
            try:
                require(sql('SELECT current_user', os_user=user, role=role) == role, 'wrong peer identity')
                break
            except ValueError:
                if attempt == 19:
                    raise
                time.sleep(0.1)


def exclusive_file(path, content, mode=0o600, uid=0, gid=0):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as stream:
        os.fchown(stream.fileno(), uid, gid)
        os.fchmod(stream.fileno(), mode)
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())


def fsync_directory(path):
    folder = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(folder)
    finally:
        os.close(folder)


def backup(settings, planned):
    if BACKUPS.exists():
        trusted_parents(BACKUPS)
        require(stat.S_IMODE(BACKUPS.stat().st_mode) == 0o700, 'backup directory must be0700')
    else:
        trusted_parents(BACKUPS.parent)
        BACKUPS.mkdir(mode=0o700)
        fsync_directory(BACKUPS.parent)
    destination = BACKUPS / planned['commit']
    destination.mkdir(mode=0o700)
    fsync_directory(BACKUPS)
    metadata = []
    for path in (*sorted(CONFIG.rglob('*')), DATA / 'postgresql.auto.conf'):
        info = path.lstat()
        require(stat.S_ISREG(info.st_mode) or stat.S_ISDIR(info.st_mode), 'special PG config file')
        metadata.append({'path': str(path), 'uid': info.st_uid, 'gid': info.st_gid,
                         'mode': stat.S_IMODE(info.st_mode)})
        if stat.S_ISREG(info.st_mode):
            target = destination / 'configs' / str(path).lstrip('/')
            target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
            exclusive_file(target, path.read_bytes())
    exclusive_file(destination/'metadata.json', json.dumps({'files': metadata, 'settings': settings}, indent=2).encode())
    exclusive_file(destination/'plan.json', json.dumps(planned, indent=2).encode())
    fd = os.open(destination/'empty-database.dump', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, 'wb') as stream:
        run(['/usr/sbin/runuser', '-u', 'postgres', '--', str(PG/'pg_dump'),
             '-w', '-h', SOCKET, '-p', '8877', '-U', 'postgres', '-d', DB, '-Fc'], stdout=stream)
        stream.flush()
        os.fsync(stream.fileno())
    for directory, _, _ in os.walk(destination, topdown=False):
        fsync_directory(directory)
    return destination


def install_roots(files, commit, *, private_runtime=False):
    """Stage immutable source; upgrades keep runtime roots private until copied."""
    require(type(private_runtime) is bool, 'private_runtime must be a boolean')
    releases = BASE/'releases'
    releases.mkdir(mode=0o755, exist_ok=True)
    os.chmod(releases, 0o755)
    release = releases/commit
    release.mkdir(mode=0o755)
    for component in ROOTS:
        root = release/component
        root.mkdir(mode=0o755)
        for name, (content, executable) in files.items():
            path = root/name
            path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            exclusive_file(path, content, 0o555 if executable else 0o444)
        runtime = root/'backend/runtime'
        runtime.mkdir(mode=0o700)
        account = pwd.getpwnam('domino-'+component)
        uid, gid = (0, 0) if private_runtime else (account.pw_uid, account.pw_gid)
        os.chown(runtime, uid, gid, follow_symlinks=False)
        descriptor = json.dumps({'host': SOCKET, 'port': 8877, 'dbname': DB}).encode() + b'\n'
        exclusive_file(runtime/'catalogue-db.json', descriptor, uid=uid, gid=gid)
        (root/'backend/.venv').symlink_to(VENV, target_is_directory=True)
        for directory, _, _ in os.walk(root, topdown=False):
            if Path(directory) != runtime:
                os.chmod(directory, 0o555)
    os.chmod(release, 0o555)


def replace_pg_config(path, content):
    original = path.stat()
    temporary = path.with_name(path.name + '.domino-disabled-new')
    exclusive_file(temporary, content, stat.S_IMODE(original.st_mode), original.st_uid, original.st_gid)
    os.replace(temporary, path)
    fsync_directory(path.parent)


def apply(files, planned):
    require(os.geteuid() == 0, '--apply requires root')
    trusted_parents(BASE)
    fd = os.open(BASE/'.disabled-install.lock', os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'rb+'):
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        require(os.fstat(fd).st_uid == 0 and stat.S_ISREG(os.fstat(fd).st_mode)
                and stat.S_IMODE(os.fstat(fd).st_mode) == 0o600, 'invalid install lock')
        settings = preflight(files, planned['commit'])
        destination = backup(settings, planned)
        print('Preflight passed; private backup complete. Applying disabled installation.', flush=True)
        for user in ('domino-onboarding', 'domino-deposit'):
            run(['/usr/sbin/useradd', '--system', '--user-group', '--no-create-home',
                 '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', '--groups', 'domino-db', user])
        sql(f'CREATE ROLE {DEPOSIT} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;'
            f' GRANT CONNECT ON DATABASE {DB} TO {DEPOSIT};')
        install_roots(files, planned['commit'])
        ident = (CONFIG/'pg_ident.conf').read_bytes() + b'\n' + ('\n'.join(' '.join(row) for row in NEW_MAPPINGS)+'\n').encode()
        lines = (CONFIG/'pg_hba.conf').read_text().splitlines(keepends=True)
        insertion = next(i for i, line in enumerate(lines)
                         if tuple(line.split('#', 1)[0].split()) == ('local', 'all', 'all', 'reject'))
        lines.insert(insertion, f'local {DB} {DEPOSIT} peer map=domino\n')
        hba = ''.join(lines)
        replace_pg_config(CONFIG/'pg_ident.conf', ident)
        replace_pg_config(CONFIG/'pg_hba.conf', hba.encode())
        require(normalized_config(CONFIG/'pg_ident.conf') == (*MAPPINGS, *NEW_MAPPINGS)
                and normalized_config(CONFIG/'pg_hba.conf') ==
                    (*HBA[:6], ('local', DB, DEPOSIT, 'peer', 'map=domino'), *HBA[6:]),
                'written peer configuration differs from plan')
        validate_pg_files()
        require(sql('SELECT pg_catalog.pg_reload_conf()') == 't', 'PostgreSQL reload request failed')
        verify_new_peers()
        migrations = '\n'.join(files[p][0].decode() for p in MIGRATIONS)
        guard = f"SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='120s'; DO $$ BEGIN IF NOT ({EMPTY}) THEN RAISE EXCEPTION 'database_not_empty'; END IF; END $$;\n"
        sql(guard + migrations, os_user='domino-admin', role=ADMIN, transaction=True)
        for component in SERVICES:
            exclusive_file(UNIT_DIR/f'domino-{component}.service', unit_text(component, planned['commit']).encode(), 0o644)
        run(['/usr/bin/systemd-analyze', 'verify', *(str(UNIT_DIR/f'domino-{c}.service') for c in SERVICES)])
        run(['/usr/bin/systemctl', 'daemon-reload'])
        validate_pg_files()
        receipt = {'commit': planned['commit'], 'servicesStarted': False,
                   'servicesEnabled': False, 'migrationsCommitted': list(MIGRATIONS)}
        packaged = packaged_only_migrations(files)
        if packaged:
            receipt['packagedOnlyMigrations'] = packaged
        exclusive_file(destination/'installed.json', json.dumps(receipt).encode())
        print('Installed; no service started or enabled. Review BPF enforcement and smoke tests separately.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', required=True, type=Path)
    parser.add_argument('--archive-sha256', required=True)
    parser.add_argument('--commit', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    try:
        files = archive_files(args.archive, args.archive_sha256, args.commit)
        planned = plan(files, args.archive_sha256, args.commit)
        if args.apply:
            os.umask(0o077)
            apply(files, planned)
        else:
            print(json.dumps(planned, indent=2))
        return 0
    except (OSError, ValueError, KeyError, tarfile.TarError, subprocess.SubprocessError) as error:
        print(f'Installation refused/stopped: {error}. No automatic rollback; inspect any private backup.', file=__import__('sys').stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
