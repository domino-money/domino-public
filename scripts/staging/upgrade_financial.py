#!/usr/bin/env python3
"""Scoped financial source/schema installation; never starts a service.

The active public/development read lanes are outside this installer's write set.
SQL 015–022 commits once, together. Operational rollback retains committed
financial data and disables/removes only this installer's service/peer bindings.
"""
import argparse
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import pwd
import re
import stat
import tarfile
import time

import prepare_disabled as base

require = base.require
OLD = '4c3ee322308900303c679088bc4712ef16500763'
ROOT = Path('/opt/domino/financial')
PRIVATE = Path('/etc/domino/financial')
RUNTIME = Path('/var/lib/domino-financial')
RECEIPTS = Path('/var/backups/domino-financial')
MIGRATIONS = tuple('backend/migrations/' + name + '.sql' for name in (
    '015_unsigned_execution', '016_managed_performance',
    '017_performance_financial_history', '018_performance_enrollment', '019_execution_journal',
    # Post-foundation migrations travel with this upgrade; the demand queue adds
    # no role and no service, only a table and one reader-callable function, and
    # the reference price sources only widen an existing check.
    '020_pool_requests', '021_reference_price_sources',
    '022_event_timestamp_source'))
# Owned by other deployments: the public collector for 023-026, and the
# foundation's own session schema for 027. They can accompany this release as
# source, but must never enter financial SQL or its applied receipt.
PACKAGED_ONLY_MIGRATIONS = (
    'backend/migrations/023_pool_request_scheduling.sql',
    'backend/migrations/024_public_observations.sql',
    'backend/migrations/025_public_history.sql',
    'backend/migrations/026_public_demand.sql',
    'backend/migrations/027_remove_wallet_access_gate.sql',
    # Automation cycle state and the publisher role: applied with the
    # automation activation, never by this upgrade.
    'backend/migrations/028_automation_cycle.sql',
    'backend/migrations/029_ledger_index.sql',
    'backend/migrations/030_swap_exposure.sql',
    'backend/migrations/031_publication_resend.sql',
    'backend/migrations/032_shared_gas_budget.sql',
    'backend/migrations/033_gas_budget_claim_read.sql',
    'backend/migrations/034_gas_settlement_sweep.sql',
    'backend/migrations/035_cancel_unsigned_gas_claims.sql',
    'backend/migrations/036_gas_settlement_journal_read.sql',
    'backend/migrations/037_gas_settlement_receipt_evidence.sql',
    'backend/migrations/038_gas_settlement_quote_witness.sql',
    'backend/migrations/039_automation_readiness.sql',
    'backend/migrations/040_gas_finalized_quote_lag.sql',
    'backend/migrations/041_session_delegated_accounts.sql',
    'backend/migrations/042_provider_priority.sql',
    'backend/migrations/043_featured_pools.sql',
    'backend/migrations/044_demand_horizon.sql',
    'backend/migrations/045_featured_live.sql',
    'backend/migrations/046_gas_answer_heartbeat.sql',
    'backend/migrations/047_provider_ceiling.sql',
    # The V2 index (read-v6): applied with the V2 indexer's installation, never by this upgrade.
    'backend/migrations/052_v2_index.sql',
)
NEW_ROLES = ('domino_performance_collector', 'domino_performance_reader',
             'domino_execution_worker', 'domino_execution_ledger',
             'domino_execution_signer', 'domino_execution_reader')
OLD_COMPONENTS = ('auth', 'onboarding', 'deposit')
NEW_COMPONENTS = ('performance', 'performance-collector', 'execution-status', 'execution-signer')
COMPONENTS = OLD_COMPONENTS + NEW_COMPONENTS
OS_USERS = {component: 'domino-' + component for component in COMPONENTS}
PEERS = {
    'performance': ('domino_session_auth', 'domino_catalogue_reader',
                    'domino_performance_collector', 'domino_performance_reader'),
    'performance-collector': ('domino_performance_collector', 'domino_performance_reader'),
    'execution-status': ('domino_session_auth', 'domino_execution_reader'),
    'execution-signer': ('domino_execution_worker', 'domino_execution_ledger', 'domino_execution_signer'),
}
PROTECTED = ('domino-read.service', 'domino-gateway.service', 'domino-tunnel.service',
             'domino-dev-read.service', 'domino-dev-gateway.service', 'domino-dev-tunnel.service',
             'domino-continuous-egress.service', 'domino-dev-egress.service',
             'domino-continuous-reads.target', 'domino-dev-off.target')
DB_LOCK = 466301519


def sha(raw):
    return hashlib.sha256(raw).hexdigest()


def read_file(path, maximum=64*1024*1024):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        info = os.fstat(stream.fileno())
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1 and info.st_size <= maximum,
                'regular_bounded_file_required')
        raw = stream.read(maximum + 1)
        require(len(raw) <= maximum, 'file_too_large')
        return raw


def archive_files(path, digest, commit):
    require(re.fullmatch('[0-9a-f]{64}', digest) and re.fullmatch('[0-9a-f]{40}', commit), 'invalid_release_pin')
    raw = read_file(path)
    require(sha(raw) == digest, 'archive_hash_mismatch')
    files, kinds, total = {}, {}, 0
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as archive:
        require(archive.pax_headers.get('comment') == commit, 'archive_commit_mismatch')
        for item in archive:
            name = item.name.rstrip('/')
            parts = name.split('/')
            require(name and not name.startswith('/') and '\\' not in name
                    and not any(p in ('', '.', '..') for p in parts)
                    and not any(ord(c) < 32 or ord(c) == 127 for c in name), 'unsafe_archive_path')
            require(name not in kinds and len(kinds) < 20000, 'duplicate_or_excessive_archive')
            require((item.isfile() or item.isdir()) and not item.sparse, 'archive_special_file')
            require(not set(parts) & {'.git', '.venv', 'runtime', 'node_modules', '__pycache__'}, 'archive_private_directory')
            total += item.size
            require(0 <= item.size <= 32*1024*1024 and total <= 128*1024*1024, 'archive_expansion_limit')
            kinds[name] = item.isdir()
            if item.isfile(): files[name] = (archive.extractfile(item).read(), bool(item.mode & 0o111))
    for name in kinds:
        require(all(kinds.get(str(p), True) for p in PurePosixPath(name).parents if str(p) != '.'), 'archive_parent_is_file')
    required = (*base.MIGRATIONS, *MIGRATIONS, 'backend/schema.sql', 'backend/requirements-api.lock',
                'backend/session_api.py', 'backend/onboarding_api.py', 'backend/deposit_api.py',
                'backend/performance_v2_api.py', 'backend/execution_status.py', 'backend/execution_cli.py')
    require(all(name in files for name in required), 'required_release_file_missing')
    require({name for name in files if name.startswith('backend/migrations/')}
            <= set(base.MIGRATIONS + MIGRATIONS + PACKAGED_ONLY_MIGRATIONS),
            'unexpected_migration')
    return files


def release_root(commit, component):
    return ROOT / 'releases' / commit / component


def unit_text(component, commit):
    root = release_root(commit, component)
    config = '/run/domino-financial-' + component + '-config'
    runtime = (base.BASE / 'releases' / OLD / component / 'backend/runtime'
               if component in OLD_COMPONENTS else RUNTIME / component)
    if component in OLD_COMPONENTS:
        script, args = base.SERVICES[component]
    elif component == 'performance':
        script, args = 'performance_v2_api.py', 'serve --port 8900'
    elif component == 'execution-status':
        script, args = 'execution_status.py', 'serve --port 8901'
    elif component == 'performance-collector':
        script, args = 'performance_v2_api.py', f'collect --enable --profile {config}/profile.json'
    else:
        script = 'execution_cli.py'
        args = (f'--config {config}/profile.json step --owner ${{DOMINO_EXECUTION_OWNER}} '
                '--intent ${DOMINO_EXECUTION_INTENT} --worker ${DOMINO_EXECUTION_WORKER}')
    condition = ''
    if component in ('performance-collector', 'execution-signer'):
        condition = f'ConditionPathExists={PRIVATE}/{component}/profile.json\n'
    if component == 'execution-signer':
        condition += f'ConditionPathExists={PRIVATE}/{component}/request.env\n'
    env = f'EnvironmentFile=-{PRIVATE}/{component}/environment\n'
    if component == 'execution-signer': env += f'EnvironmentFile={PRIVATE}/{component}/request.env\n'
    return f'''[Unit]
Description=Domino financial {component} ({commit})
After=postgresql@16-domino.service
{condition}StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type={'oneshot' if component == 'execution-signer' else 'exec'}
User={OS_USERS[component]}
Group={OS_USERS[component]}
SupplementaryGroups=domino-db
WorkingDirectory={root}
ExecStart={base.PYTHON} -B backend/{script} {args}
Environment=PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 WEB_CONCURRENCY=1 UVICORN_WORKERS=1
{env}UnsetEnvironment=PYTHONPATH PYTHONHOME DOMINO_DISCOVERY_RPC_URL DOMINO_INVENTORY_RPC_URL
UMask=0077
ProtectSystem=strict
BindPaths={runtime}:{root}/backend/runtime
BindReadOnlyPaths={PRIVATE}/{component}:{config}
ReadWritePaths={runtime}
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
MemoryMax={'768M' if component == 'performance-collector' else '256M'}
TasksMax=32
Restart={'no' if component == 'execution-signer' else 'on-failure'}
RestartSec=5
TimeoutStartSec=30
TimeoutStopSec=30
KillMode=control-group
'''


def plan(files, commit, digest):
    return {'version': 1, 'kind': 'domino-financial-upgrade', 'commit': commit, 'archiveSha256': digest,
            'foundationCommit': OLD, 'migrations': [{'path': p, 'sha256': sha(files[p][0])} for p in MIGRATIONS],
            'packagedOnlyMigrations': [{'path': p, 'sha256': sha(files[p][0])}
                                       for p in PACKAGED_ONLY_MIGRATIONS if p in files],
            'foundation': {p: sha(files[p][0]) for p in (*base.MIGRATIONS, 'backend/schema.sql', 'backend/requirements-api.lock')},
            'units': {f'domino-{c}.service': unit_text(c, commit) for c in COMPONENTS},
            'sourceDirectory': str(ROOT / 'releases' / commit),
            'servicesStarted': False, 'foundationMigrationsReapplied': False,
            'readLanesModified': False, 'providerOrAccessConfigurationCreated': False,
            'rollback': 'restore financial units/peer files; retain committed financial schemas and private data'}


def migration_sql(files, planned):
    """One explicit transaction, including role provisioning and the receipt."""
    receipt = json.dumps({'commit': planned['commit'], 'migrations': planned['migrations']}, sort_keys=True, separators=(',', ':'))
    roles = '\n'.join(f'CREATE ROLE {r} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;'
                      for r in ('domino_performance_collector', 'domino_performance_reader'))
    login = '\n'.join(f'ALTER ROLE {r} LOGIN; GRANT CONNECT ON DATABASE {base.DB} TO {r};' for r in NEW_ROLES)
    return f'''BEGIN;
SET LOCAL lock_timeout='3000ms';
SET LOCAL statement_timeout='30000ms';
SELECT pg_advisory_xact_lock({DB_LOCK});
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'{base.DB}' THEN RAISE EXCEPTION 'wrong_financial_ddl_identity'; END IF;
 IF EXISTS(SELECT FROM pg_namespace WHERE nspname IN ('domino_execution','domino_performance','domino_financial_install')) THEN
  RAISE EXCEPTION 'financial_schema_already_exists'; END IF;
 IF to_regclass('domino_wallet_access.grants') IS NULL OR to_regclass('domino_deposits.intents') IS NULL
  OR to_regclass('domino_catalogue.state') IS NULL OR to_regclass('domino_activity.capital_chunks') IS NULL THEN
  RAISE EXCEPTION 'foundation_schema_missing'; END IF;
END $$;
{roles}
''' + '\n'.join(files[p][0].decode('utf-8') for p in MIGRATIONS) + f'''
{login}
CREATE SCHEMA domino_financial_install AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA domino_financial_install FROM PUBLIC;
CREATE TABLE domino_financial_install.receipt(singleton boolean PRIMARY KEY CHECK(singleton), value jsonb NOT NULL);
REVOKE ALL ON domino_financial_install.receipt FROM PUBLIC;
INSERT INTO domino_financial_install.receipt VALUES(true,'{receipt}'::jsonb);
COMMIT;
'''


def sql(query):
    return base.sql(query, os_user='postgres', role='postgres')


def verify_peers():
    # pg_reload_conf only queues SIGHUP. A new connection proves the postmaster
    # has admitted the replacement files; tolerate that bounded signal delay.
    for component, roles in PEERS.items():
        for role in roles:
            for attempt in range(20):
                try:
                    require(base.sql('SELECT current_user', os_user=OS_USERS[component], role=role) == role,
                            'peer_identity_mismatch')
                    break
                except ValueError:
                    if attempt == 19: raise
                    time.sleep(0.1)


def unit_state(name):
    raw = base.run(['/usr/bin/systemctl', 'show', name,
                    '--property=LoadState,ActiveState,SubState,MainPID,NRestarts,WorkingDirectory,FragmentPath,DropInPaths']).decode()
    result = dict(line.split('=', 1) for line in raw.splitlines() if '=' in line)
    paths = [result.get('FragmentPath', ''), *result.get('DropInPaths', '').split()]
    result['fileHashes'] = {p: sha(read_file(p, 65536)) for p in paths if p}
    return result


def json_bytes(value):
    return (json.dumps(value, sort_keys=True, indent=2) + '\n').encode()


def baseline(files, planned):
    require(os.geteuid() == 0, 'root_required')
    for directory in (base.BASE, base.UNIT_DIR): base.trusted_parents(directory)
    base.pg_parents(base.CONFIG)
    base.dependency_preflight(files)
    original = base.BASE / 'releases' / OLD / 'auth'
    for name, digest in planned['foundation'].items():
        require(base.succeeds(name, sha(read_file(original / name)), digest),
                'foundation_or_dependency_change')
    state = {name: unit_state(name) for name in PROTECTED}
    for component in OLD_COMPONENTS:
        value = unit_state(f'domino-{component}.service')
        require(value['ActiveState'] == 'inactive' and value['MainPID'] == '0' and not value['DropInPaths'],
                'financial_service_not_inactive_foundation')
        require(read_file(base.UNIT_DIR / f'domino-{component}.service') == base.unit_text(component, OLD).encode(),
                'financial_unit_drift')
    for component in NEW_COMPONENTS:
        require(not os.path.lexists(base.UNIT_DIR / f'domino-{component}.service'), 'new_unit_already_exists')
        require(OS_USERS[component] not in {p.pw_name for p in pwd.getpwall()}, 'new_os_identity_already_exists')
    ports = base.run(['/usr/bin/ss', '-H', '-ltn']).decode()
    require(not re.search(r':(?:8879|8880|8881|8900|8901)\s', ports), 'financial_port_in_use')
    require(sql("SELECT count(*) FROM pg_namespace WHERE nspname IN ('domino_execution','domino_performance','domino_financial_install')") == '0',
            'financial_schema_already_exists')
    require(sql("SELECT count(*) FROM pg_roles WHERE rolname IN (" + ','.join("'" + r + "'" for r in (*NEW_ROLES, 'domino_execution_owner')) + ')') == '0',
            'financial_sql_identity_already_exists')
    return {'planSha256': sha(json_bytes(planned)), 'protected': state,
            'units': {c: sha(read_file(base.UNIT_DIR / f'domino-{c}.service')) for c in OLD_COMPONENTS},
            'peers': {name: sha(read_file(base.CONFIG / name)) for name in ('pg_hba.conf', 'pg_ident.conf')},
            'walletGrantCount': int(sql('SELECT count(*) FROM domino_wallet_access.grants'))}


def peers(original_hba, original_ident):
    hba = original_hba.decode().splitlines(keepends=True)
    indexes = [i for i, line in enumerate(hba) if tuple(line.split('#', 1)[0].split()) == ('local', 'all', 'all', 'reject')]
    require(len(indexes) == 1, 'missing_unique_local_reject')
    require('map=domino_financial' not in original_hba.decode() and 'domino_financial ' not in original_ident.decode(), 'financial_peers_exist')
    # A distinct map prevents broadening any existing service identity.
    rows = sorted((OS_USERS[c], role) for c, roles in PEERS.items() for role in roles)
    # Existing role HBA entries use map=domino. Add precise mappings there for
    # session/catalogue; new role entries use the independent map exclusively.
    ident = original_ident + b'\n' + ''.join(
        f'{"domino_financial" if role in NEW_ROLES else "domino"} {user} {role}\n' for user, role in rows).encode()
    hba.insert(indexes[0], ''.join(f'local {base.DB} {role} peer map=domino_financial\n' for role in NEW_ROLES))
    return ''.join(hba).encode(), ident


def save(path, raw):
    base.exclusive_file(path, raw)


def journal(directory, value):
    path = directory / 'journal.json'
    temporary = directory / 'journal.next'
    save(temporary, json_bytes(value))
    os.replace(temporary, path)
    base.fsync_directory(directory)


def install_source(files, commit):
    target = ROOT / 'releases' / commit
    target.mkdir(mode=0o755)
    for component in COMPONENTS:
        root = target / component
        root.mkdir(mode=0o755)
        for name, (raw, executable) in files.items():
            if not name.startswith('backend/') or name.startswith('backend/tests/'): continue
            path = root / name
            path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            base.exclusive_file(path, raw, 0o555 if executable else 0o444)
        (root / 'backend/runtime').mkdir(mode=0o700)
        for path, _, _ in os.walk(root, topdown=False): os.chmod(path, 0o555)
    os.chmod(target, 0o555)


def apply(files, planned, expected):
    actual = baseline(files, planned)
    require(actual == expected, 'baseline_changed')
    commit = planned['commit']
    for parent, mode in ((ROOT, 0o755), (ROOT / 'releases', 0o755), (PRIVATE, 0o700),
                         (RUNTIME, 0o711), (RECEIPTS, 0o700)):
        if parent.exists(): base.trusted_parents(parent)
        else:
            base.trusted_parents(parent.parent)
            parent.mkdir(mode=mode)
    directory = RECEIPTS / commit
    directory.mkdir(mode=0o700)
    save(directory / 'plan.json', json_bytes(planned))
    save(directory / 'baseline.json', json_bytes(actual))
    for component in OLD_COMPONENTS:
        save(directory / f'{component}.service', read_file(base.UNIT_DIR / f'domino-{component}.service'))
    for name in ('pg_hba.conf', 'pg_ident.conf'): save(directory / name, read_file(base.CONFIG / name))
    new_hba, new_ident = peers(read_file(directory / 'pg_hba.conf'), read_file(directory / 'pg_ident.conf'))
    state = {'phase': 'preparing', 'sqlCommitted': False, 'unitsWritten': [], 'peerFilesWritten': [],
             'createdUsers': [], 'postPeerHashes': {'pg_hba.conf': sha(new_hba), 'pg_ident.conf': sha(new_ident)}}
    journal(directory, state)
    try:
        for component in NEW_COMPONENTS:
            base.run(['/usr/sbin/useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent',
                      '--shell', '/usr/sbin/nologin', '--groups', 'domino-db', OS_USERS[component]])
            state['createdUsers'].append(component); journal(directory, state)
        install_source(files, commit)
        for component in COMPONENTS:
            account = pwd.getpwnam(OS_USERS[component])
            config = PRIVATE / component
            config.mkdir(mode=0o700); os.chown(config, account.pw_uid, account.pw_gid)
            if component in NEW_COMPONENTS:
                runtime = RUNTIME / component
                runtime.mkdir(mode=0o700); os.chown(runtime, account.pw_uid, account.pw_gid)
                base.exclusive_file(config / 'database.json', json_bytes({'host': base.SOCKET, 'port': 8877, 'dbname': base.DB}),
                                    uid=account.pw_uid, gid=account.pw_gid)
        for component in COMPONENTS:
            path = base.UNIT_DIR / f'domino-{component}.service'
            # Journal intent before replacement, so recovery also covers a crash
            # between atomic rename and recording completion.
            state['unitsWritten'].append(component); journal(directory, state)
            temporary = path.with_name(path.name + '.financial-new')
            base.exclusive_file(temporary, planned['units'][path.name].encode(), mode=0o644)
            os.replace(temporary, path); base.fsync_directory(path.parent)
        base.run(['/usr/bin/systemd-analyze', 'verify', *(str(base.UNIT_DIR / name) for name in planned['units'])])
        state['phase'] = 'sql_pending'; journal(directory, state)
        sql(migration_sql(files, planned))
        state['sqlCommitted'] = True; state['phase'] = 'sql_committed'; journal(directory, state)
        for name, raw in [('pg_hba.conf', new_hba), ('pg_ident.conf', new_ident)]:
            state['peerFilesWritten'].append(name); journal(directory, state)
            base.replace_pg_config(base.CONFIG / name, raw)
        base.validate_pg_files()
        require(sql('SELECT pg_reload_conf()') == 't', 'postgres_reload_failed')
        verify_peers()
        base.run(['/usr/bin/systemctl', 'daemon-reload'])
        require({name: unit_state(name) for name in PROTECTED} == actual['protected'], 'protected_lane_changed')
        for component in COMPONENTS:
            require(unit_state(f'domino-{component}.service')['MainPID'] == '0', 'financial_service_started_unexpectedly')
        state['phase'] = 'installed_off'; journal(directory, state)
        return {'commit': commit, 'phase': state['phase'], 'sqlCommitted': True, 'servicesStarted': False,
                'protectedLanesUnchanged': True, 'walletGrantCount': int(sql('SELECT count(*) FROM domino_wallet_access.grants'))}
    except BaseException:
        # Never erase schema/ledger data to roll back source. The database receipt
        # disambiguates a completed COMMIT whose client connection was interrupted.
        try: rollback(planned)
        except BaseException: pass
        raise


def rollback(planned):
    directory = RECEIPTS / planned['commit']
    base.trusted_parents(directory)
    require(json.loads(read_file(directory / 'plan.json')) == planned, 'rollback_plan_mismatch')
    state = json.loads(read_file(directory / 'journal.json'))
    for component in state['unitsWritten']:
        path = base.UNIT_DIR / f'domino-{component}.service'
        current = read_file(path) if path.exists() else None
        old = read_file(directory / f'{component}.service') if component in OLD_COMPONENTS else None
        require(current in (planned['units'][path.name].encode(), old), 'rollback_unit_drift')
    for name in state['peerFilesWritten']:
        require(sha(read_file(base.CONFIG / name)) in (state['postPeerHashes'][name], sha(read_file(directory / name))), 'rollback_peer_drift')
    # Only our seven units can be stopped. Inactive old units are not restarted.
    for component in state['unitsWritten']:
        if (base.UNIT_DIR / f'domino-{component}.service').exists():
            base.run(['/usr/bin/systemctl', 'stop', f'domino-{component}.service'])
    for component in state['unitsWritten']:
        path = base.UNIT_DIR / f'domino-{component}.service'
        if component in OLD_COMPONENTS:
            temporary = path.with_name(path.name + '.financial-rollback')
            base.exclusive_file(temporary, read_file(directory / f'{component}.service'), mode=0o644)
            os.replace(temporary, path)
        elif path.exists(): path.unlink()
        base.fsync_directory(path.parent)
    for name in state['peerFilesWritten']: base.replace_pg_config(base.CONFIG / name, read_file(directory / name))
    if state['peerFilesWritten']:
        base.validate_pg_files(); sql('SELECT pg_reload_conf()')
    base.run(['/usr/bin/systemctl', 'daemon-reload'])
    state['phase'] = 'rolled_back_off'
    state['sqlCommitted'] = sql("SELECT to_regclass('domino_financial_install.receipt') IS NOT NULL") == 't'
    journal(directory, state)
    return {'phase': state['phase'], 'financialSchemasRetained': state['sqlCommitted'], 'servicesStarted': False}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--archive-sha256', required=True)
    parser.add_argument('--commit', required=True)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--inspect', action='store_true')
    group.add_argument('--apply', action='store_true')
    group.add_argument('--rollback', action='store_true')
    parser.add_argument('--baseline', type=Path)
    args = parser.parse_args(argv)
    files = archive_files(args.archive, args.archive_sha256, args.commit)
    planned = plan(files, args.commit, args.archive_sha256)
    if not any((args.inspect, args.apply, args.rollback)):
        print(json.dumps(planned, sort_keys=True, indent=2)); return 0
    require(os.geteuid() == 0, 'root_required')
    if args.inspect:
        print(json.dumps(baseline(files, planned), sort_keys=True, indent=2)); return 0
    base.trusted_parents(base.BASE)
    fd = os.open(base.BASE / '.financial-install.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'rb+'):
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0 and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1, 'unsafe_install_lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.rollback: result = rollback(planned)
        else:
            require(args.baseline is not None, 'baseline_required')
            base.trusted_parents(args.baseline.parent)
            require(base.trusted(args.baseline).st_mode & 0o077 == 0, 'private_baseline_required')
            result = apply(files, planned, json.loads(read_file(args.baseline)))
    print(json.dumps(result, sort_keys=True, indent=2)); return 0


if __name__ == '__main__':
    try: raise SystemExit(main())
    except (ValueError, OSError, tarfile.TarError):
        raise SystemExit('Financial installation failed; inspect the private scoped journal. No service is started by this tool.')
