#!/usr/bin/env python3
"""Install the automation cycle beside the financial services; never start it.

One immutable source release for the `automation` component, one system user,
one systemd unit without an [Install] section, the three automation migrations
(028, 029, 030) in one receipted transaction, and peer mappings from the service
user to the four execution roles it needs. No configuration, key, funding or
activation: the unit cannot start until the operator places the private
configuration, and nothing here reads, creates or returns it. The financial
upgrade must already be installed; its receipt is checked before any DDL.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import pwd
import stat
import sys
import time

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prepare_disabled as base
import upgrade_financial as financial

require = base.require
COMPONENT = 'automation'
OS_USER = 'domino-' + COMPONENT
UNIT = f'domino-{COMPONENT}.service'
ROLES = ('domino_execution_worker', 'domino_execution_signer', 'domino_execution_publisher', 'domino_execution_ledger')
# The roles the financial upgrade already made LOGIN roles with peer entries.
FINANCIAL_ROLES = ('domino_execution_worker', 'domino_execution_signer', 'domino_execution_ledger')
MIGRATIONS = ('backend/migrations/028_automation_cycle.sql', 'backend/migrations/029_ledger_index.sql',
              'backend/migrations/030_swap_exposure.sql')
SOURCES = ('backend/automation_cli.py', 'backend/automation_cycle.py', 'backend/automation_ledger.py',
           'backend/automation_config.py', 'backend/automation_observer.py', 'backend/automation_evidence.py',
           'backend/automation_plan.py', 'backend/automation_store.py', 'backend/publisher_signer.py')
PRIVATE = financial.PRIVATE / COMPONENT
RUNTIME = financial.RUNTIME / COMPONENT
RECEIPTS = financial.RECEIPTS / COMPONENT
CONFIG_MOUNT = '/run/domino-financial-' + COMPONENT + '-config'
DB_LOCK = 466301520
sha, read_file, json_bytes, save, journal, sql = (financial.sha, financial.read_file, financial.json_bytes,
                                                  financial.save, financial.journal, financial.sql)


def unit_text(commit):
    root = financial.release_root(commit, COMPONENT)
    return f'''[Unit]
Description=Domino financial {COMPONENT} ({commit})
After=postgresql@16-domino.service
ConditionPathExists={PRIVATE}/config.json
StartLimitIntervalSec=60
StartLimitBurst=3

[Service]
Type=exec
User={OS_USER}
Group={OS_USER}
SupplementaryGroups=domino-db
WorkingDirectory={root}
ExecStart={base.PYTHON} -B backend/automation_cli.py --config {CONFIG_MOUNT}/config.json serve
Environment=PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
EnvironmentFile=-{PRIVATE}/environment
UnsetEnvironment=PYTHONPATH PYTHONHOME DOMINO_DISCOVERY_RPC_URL DOMINO_INVENTORY_RPC_URL
UMask=0077
ProtectSystem=strict
BindPaths={RUNTIME}:{root}/backend/runtime
BindReadOnlyPaths={PRIVATE}:{CONFIG_MOUNT}
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
TasksMax=32
Restart=on-failure
RestartSec=5
TimeoutStartSec=30
TimeoutStopSec=90
KillMode=control-group
KillSignal=SIGTERM
'''


def plan(files, commit, digest):
    for name in (*MIGRATIONS, *SOURCES):
        require(name in files, 'automation_source_missing')
    return {'version': 1, 'kind': 'domino-automation-install', 'commit': commit, 'archiveSha256': digest,
            'migrations': [{'path': p, 'sha256': sha(files[p][0])} for p in MIGRATIONS],
            'unit': unit_text(commit), 'osUser': OS_USER, 'roles': list(ROLES),
            'sourceDirectory': str(financial.release_root(commit, COMPONENT)),
            'privateDirectory': str(PRIVATE), 'runtimeDirectory': str(RUNTIME),
            'servicesStarted': False, 'configurationCreated': False, 'keysCreated': False,
            'rollback': 'remove the unit and the peer rows; retain the committed automation schema, the source and the private directory'}


def migration_sql(files, planned):
    """One explicit transaction: the two automation migrations, the publisher's
    login, and the receipt. Refused unless the financial upgrade is installed
    and nothing of the automation schema exists yet."""
    receipt = json.dumps({'commit': planned['commit'], 'migrations': planned['migrations']}, sort_keys=True, separators=(',', ':'))
    financial_roles = ','.join("'" + r + "'" for r in FINANCIAL_ROLES)
    return f'''BEGIN;
SET LOCAL lock_timeout='3000ms';
SET LOCAL statement_timeout='30000ms';
SELECT pg_advisory_xact_lock({DB_LOCK});
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'{base.DB}' THEN RAISE EXCEPTION 'wrong_automation_ddl_identity'; END IF;
 IF to_regclass('domino_financial_install.receipt') IS NULL OR to_regclass('domino_execution.intents') IS NULL
  OR to_regclass('domino_execution.journal') IS NULL THEN RAISE EXCEPTION 'financial_schema_missing'; END IF;
 IF to_regclass('domino_execution.cycles') IS NOT NULL OR to_regclass('domino_execution.withdrawals') IS NOT NULL
  OR EXISTS(SELECT FROM pg_namespace WHERE nspname='domino_automation_install') THEN RAISE EXCEPTION 'automation_schema_already_exists'; END IF;
 IF EXISTS(SELECT FROM pg_roles WHERE rolname IN ({financial_roles}) AND NOT rolcanlogin)
  OR (SELECT count(*) FROM pg_roles WHERE rolname IN ({financial_roles}))<>3
  OR EXISTS(SELECT FROM pg_roles WHERE rolname='domino_execution_publisher') THEN RAISE EXCEPTION 'execution_roles_unexpected'; END IF;
END $$;
''' + '\n'.join(files[p][0].decode('utf-8') for p in MIGRATIONS) + f'''
ALTER ROLE domino_execution_publisher LOGIN; GRANT CONNECT ON DATABASE {base.DB} TO domino_execution_publisher;
CREATE SCHEMA domino_automation_install AUTHORIZATION postgres;
REVOKE ALL ON SCHEMA domino_automation_install FROM PUBLIC;
CREATE TABLE domino_automation_install.receipt(singleton boolean PRIMARY KEY CHECK(singleton), value jsonb NOT NULL);
REVOKE ALL ON domino_automation_install.receipt FROM PUBLIC;
INSERT INTO domino_automation_install.receipt VALUES(true,'{receipt}'::jsonb);
COMMIT;
'''


def peers(original_hba, original_ident):
    """The service user maps to its four roles in the financial ident map; the
    publisher role, new with 028, gets the same local peer entry the financial
    upgrade gave the other three. Nothing else in either file changes."""
    hba = original_hba.decode().splitlines(keepends=True)
    rows = [tuple(line.split('#', 1)[0].split()) for line in hba]
    indexes = [i for i, row in enumerate(rows) if row == ('local', 'all', 'all', 'reject')]
    require(len(indexes) == 1, 'missing_unique_local_reject')
    for role in FINANCIAL_ROLES:
        require(('local', base.DB, role, 'peer', 'map=domino_financial') in rows, 'financial_peers_missing')
    require(('local', base.DB, 'domino_execution_publisher', 'peer', 'map=domino_financial') not in rows, 'automation_peers_exist')
    ident_rows = [tuple(line.split('#', 1)[0].split()) for line in original_ident.decode().splitlines()]
    require(any(row[:1] == ('domino_financial',) for row in ident_rows), 'financial_peers_missing')
    require(not any(row[:2] == ('domino_financial', OS_USER) for row in ident_rows), 'automation_peers_exist')
    hba.insert(indexes[0], f'local {base.DB} domino_execution_publisher peer map=domino_financial\n')
    ident = original_ident + (b'' if original_ident.endswith(b'\n') else b'\n') + ''.join(
        f'domino_financial {OS_USER} {role}\n' for role in ROLES).encode()
    return ''.join(hba).encode(), ident


def verify_peers():
    for role in ROLES:
        for attempt in range(20):
            try:
                require(base.sql('SELECT current_user', os_user=OS_USER, role=role) == role, 'peer_identity_mismatch')
                break
            except ValueError:
                if attempt == 19: raise
                time.sleep(0.1)


def baseline(files, planned):
    require(os.geteuid() == 0, 'root_required')
    for directory in (base.BASE, base.UNIT_DIR, financial.ROOT): base.trusted_parents(directory)
    base.pg_parents(base.CONFIG)
    base.dependency_preflight(files)
    require(not os.path.lexists(base.UNIT_DIR / UNIT), 'automation_unit_already_exists')
    require(OS_USER not in {p.pw_name for p in pwd.getpwall()}, 'automation_os_identity_already_exists')
    require(not os.path.lexists(financial.release_root(planned['commit'], COMPONENT)), 'automation_release_already_exists')
    require(not os.path.lexists(PRIVATE) and not os.path.lexists(RUNTIME), 'automation_directories_already_exist')
    require(sql("SELECT to_regclass('domino_financial_install.receipt') IS NOT NULL") == 't', 'financial_install_missing')
    require(sql("SELECT count(*) FROM pg_namespace WHERE nspname='domino_automation_install'") == '0'
            and sql("SELECT to_regclass('domino_execution.cycles') IS NULL") == 't', 'automation_schema_already_exists')
    require(sql("SELECT count(*) FROM pg_roles WHERE rolname='domino_execution_publisher'") == '0', 'automation_sql_identity_already_exists')
    watched = (*financial.PROTECTED, *(f'domino-{c}.service' for c in financial.COMPONENTS))
    return {'planSha256': sha(json_bytes(planned)), 'protected': {name: financial.unit_state(name) for name in watched},
            'peers': {name: sha(read_file(base.CONFIG / name)) for name in ('pg_hba.conf', 'pg_ident.conf')}}


def install_source(files, commit):
    release = financial.ROOT / 'releases' / commit
    if release.exists(): base.trusted_parents(release)
    else: release.mkdir(mode=0o755)
    root = release / COMPONENT
    root.mkdir(mode=0o755)
    for name, (raw, executable) in files.items():
        if not name.startswith('backend/') or name.startswith('backend/tests/'): continue
        path = root / name
        path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
        base.exclusive_file(path, raw, 0o555 if executable else 0o444)
    (root / 'backend/runtime').mkdir(mode=0o700)
    for path, _, _ in os.walk(root, topdown=False): os.chmod(path, 0o555)


def apply(files, planned, expected):
    actual = baseline(files, planned)
    require(actual == expected, 'baseline_changed')
    commit = planned['commit']
    for parent, mode in ((financial.ROOT, 0o755), (financial.ROOT / 'releases', 0o755), (financial.PRIVATE, 0o700),
                         (financial.RUNTIME, 0o711), (financial.RECEIPTS, 0o700), (RECEIPTS, 0o700)):
        if parent.exists(): base.trusted_parents(parent)
        else:
            base.trusted_parents(parent.parent)
            parent.mkdir(mode=mode)
    directory = RECEIPTS / commit
    directory.mkdir(mode=0o700)
    save(directory / 'plan.json', json_bytes(planned))
    save(directory / 'baseline.json', json_bytes(actual))
    for name in ('pg_hba.conf', 'pg_ident.conf'): save(directory / name, read_file(base.CONFIG / name))
    new_hba, new_ident = peers(read_file(directory / 'pg_hba.conf'), read_file(directory / 'pg_ident.conf'))
    state = {'phase': 'preparing', 'sqlCommitted': False, 'unitWritten': False, 'peerFilesWritten': [], 'userCreated': False,
             'postPeerHashes': {'pg_hba.conf': sha(new_hba), 'pg_ident.conf': sha(new_ident)}}
    journal(directory, state)
    try:
        base.run(['/usr/sbin/useradd', '--system', '--user-group', '--no-create-home', '--home-dir', '/nonexistent',
                  '--shell', '/usr/sbin/nologin', '--groups', 'domino-db', OS_USER])
        state['userCreated'] = True; journal(directory, state)
        install_source(files, commit)
        account = pwd.getpwnam(OS_USER)
        for path in (PRIVATE, RUNTIME):
            path.mkdir(mode=0o700); os.chown(path, account.pw_uid, account.pw_gid)
        path = base.UNIT_DIR / UNIT
        state['unitWritten'] = True; journal(directory, state)
        temporary = path.with_name(path.name + '.automation-new')
        base.exclusive_file(temporary, planned['unit'].encode(), mode=0o644)
        os.replace(temporary, path); base.fsync_directory(path.parent)
        base.run(['/usr/bin/systemd-analyze', 'verify', str(path)])
        state['phase'] = 'sql_pending'; journal(directory, state)
        sql(migration_sql(files, planned))
        state['sqlCommitted'] = True; state['phase'] = 'sql_committed'; journal(directory, state)
        for name, raw in (('pg_hba.conf', new_hba), ('pg_ident.conf', new_ident)):
            state['peerFilesWritten'].append(name); journal(directory, state)
            base.replace_pg_config(base.CONFIG / name, raw)
        base.validate_pg_files()
        require(sql('SELECT pg_reload_conf()') == 't', 'postgres_reload_failed')
        verify_peers()
        base.run(['/usr/bin/systemctl', 'daemon-reload'])
        require({name: financial.unit_state(name) for name in actual['protected']} == actual['protected'], 'protected_lane_changed')
        require(financial.unit_state(UNIT)['MainPID'] == '0', 'automation_service_started_unexpectedly')
        state['phase'] = 'installed_off'; journal(directory, state)
        return {'commit': commit, 'phase': state['phase'], 'sqlCommitted': True, 'servicesStarted': False,
                'configurationCreated': False, 'protectedLanesUnchanged': True,
                'next': f'place {PRIVATE}/config.json and the two key files (0600, owned by {OS_USER}); then the runbook activation steps'}
    except BaseException:
        # Never erase the schema to roll back source. The receipt table
        # disambiguates a completed COMMIT whose client connection was interrupted.
        try: rollback(planned)
        except BaseException: pass
        raise


def rollback(planned):
    directory = RECEIPTS / planned['commit']
    base.trusted_parents(directory)
    require(json.loads(read_file(directory / 'plan.json')) == planned, 'rollback_plan_mismatch')
    state = json.loads(read_file(directory / 'journal.json'))
    path = base.UNIT_DIR / UNIT
    if state['unitWritten'] and path.exists():
        require(read_file(path) == planned['unit'].encode(), 'rollback_unit_drift')
    for name in state['peerFilesWritten']:
        require(sha(read_file(base.CONFIG / name)) in (state['postPeerHashes'][name], sha(read_file(directory / name))), 'rollback_peer_drift')
    if state['unitWritten'] and path.exists():
        base.run(['/usr/bin/systemctl', 'stop', UNIT])
        path.unlink(); base.fsync_directory(path.parent)
    for name in state['peerFilesWritten']: base.replace_pg_config(base.CONFIG / name, read_file(directory / name))
    if state['peerFilesWritten']:
        base.validate_pg_files(); sql('SELECT pg_reload_conf()')
    base.run(['/usr/bin/systemctl', 'daemon-reload'])
    state['phase'] = 'rolled_back_off'
    state['sqlCommitted'] = sql("SELECT to_regclass('domino_automation_install.receipt') IS NOT NULL") == 't'
    journal(directory, state)
    return {'phase': state['phase'], 'automationSchemaRetained': state['sqlCommitted'], 'osUserRetained': state['userCreated'],
            'servicesStarted': False}


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
    files = base.archive_files(args.archive, args.archive_sha256, args.commit)
    planned = plan(files, args.commit, args.archive_sha256)
    if not any((args.inspect, args.apply, args.rollback)):
        print(json.dumps(planned, sort_keys=True, indent=2)); return 0
    require(os.geteuid() == 0, 'root_required')
    if args.inspect:
        print(json.dumps(baseline(files, planned), sort_keys=True, indent=2)); return 0
    base.trusted_parents(base.BASE)
    fd = os.open(base.BASE / '.automation-install.lock', os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
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
    sys.exit(main())
