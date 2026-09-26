#!/usr/bin/env python3
"""Upgrade an installed, OFF automation stack with the read-only readiness gate.

This is deliberately separate from the first-install path. It applies only
039_automation_readiness.sql, 040_gas_finalized_quote_lag.sql and
046_gas_answer_heartbeat.sql, stages an immutable automation source release, and
repoints the three inactive automation and gas units to it. It does not read
private configuration, touch keys, change peers, start sockets/timers/services,
or enable execution. The session listener and execution-status may be live: they
are neither required off nor touched, and apply proves them unchanged.
execution-status moves with its own tool, install_financial_release.py.
"""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import stat
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prepare_disabled as base
import upgrade_financial as financial
import install_automation as automation

require = base.require
MIGRATIONS = automation.MIGRATIONS[-3:]
assert MIGRATIONS == ('backend/migrations/039_automation_readiness.sql',
                      'backend/migrations/040_gas_finalized_quote_lag.sql',
                      'backend/migrations/046_gas_answer_heartbeat.sql')
PRIOR_MIGRATIONS = automation.MIGRATIONS[:-3]
UNITS = (automation.UNIT, 'domino-gas-reservation.service', 'domino-gas-settlement.service')
# Off: the units repointed here, their socket and timer, and the standalone
# signer, whose gas gate 046 replaces.
OFF_UNITS = (*UNITS, 'domino-gas-reservation.socket', 'domino-gas-settlement.timer',
             'domino-execution-signer.service')
# Every other financial listener may be live (the session listener has been
# since 25 Sep 2026, execution-status since 26 Sep); each must come out unchanged.
WATCHED = (*financial.PROTECTED, *(f'domino-{component}.service' for component in financial.COMPONENTS
                                   if f'domino-{component}.service' not in OFF_UNITS))
LOCK = base.BASE / '.automation-install.lock'
RECEIPT_QUERY = "SELECT value::text FROM domino_automation_install.receipt WHERE singleton=true"
UPGRADE_TABLE = 'domino_automation_install.readiness_upgrade_receipt'


def plan(files, commit, digest):
    require(re.fullmatch(r'[0-9a-f]{40}', commit) is not None
            and re.fullmatch(r'[0-9a-f]{64}', digest) is not None,
            'invalid_release_pin')
    require(all(path in files for path in MIGRATIONS), 'readiness_migration_missing')
    automation.plan(files, commit, digest)
    return {'version': 1, 'kind': 'domino-automation-readiness-upgrade',
            'commit': commit, 'archiveSha256': digest,
            'migrations': [{'path': path, 'sha256': financial.sha(files[path][0])}
                           for path in MIGRATIONS],
            'units': {automation.UNIT: automation.unit_text(commit),
                      'domino-gas-reservation.service': automation.peer_unit_texts(commit)['domino-gas-reservation.service'],
                      'domino-gas-settlement.service': automation.peer_unit_texts(commit)['domino-gas-settlement.service']},
            'sourceDirectory': str(financial.release_root(commit, automation.COMPONENT)),
            'servicesStarted': False, 'privateConfigurationChanged': False,
            'rollback': 'restore three OFF units; retain receipted 039/040/046 schema and immutable source'}


def _install_receipt(table):
    require(financial.sql(f"SELECT to_regclass('{table}') IS NOT NULL") == 't',
            'prior_install_receipt_missing')
    raw = financial.sql(f'SELECT value::text FROM {table} WHERE singleton=true')
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        raise ValueError('prior_install_receipt_invalid') from None
    require(type(value) is dict and type(value.get('commit')) is str
            and re.fullmatch(r'[0-9a-f]{40}', value['commit']) is not None
            and type(value.get('migrations')) is list,
            'prior_install_receipt_invalid')
    return value


def _upgrade_receipt(planned):
    if financial.sql(f"SELECT to_regclass('{UPGRADE_TABLE}') IS NOT NULL") == 'f':
        return False
    raw = financial.sql(
        "SELECT coalesce(json_agg(json_build_object('commit',release_commit,'path',migration_path,"
        f"'sha256',sha256) ORDER BY migration_path),'[]'::json)::text FROM {UPGRADE_TABLE}")
    try:
        value = json.loads(raw)
    except (TypeError, ValueError):
        raise ValueError('readiness_upgrade_receipt_invalid') from None
    require(value == [{'commit': planned['commit'], **migration}
                      for migration in planned['migrations']],
            'readiness_upgrade_receipt_mismatch')
    return True


def _prior_receipts(files):
    previous = _install_receipt('domino_automation_install.receipt')
    previous_financial = _install_receipt('domino_financial_install.receipt')
    actual = previous['migrations']
    require(len(actual) == len(PRIOR_MIGRATIONS), 'prior_automation_migration_receipt_mismatch')
    old_root = financial.release_root(previous['commit'], automation.COMPONENT)
    base.trusted_parents(old_root)
    for row, path in zip(actual, PRIOR_MIGRATIONS):
        require(row == {'path': path, 'sha256': financial.sha(files[path][0])}
                and financial.sha(financial.read_file(old_root / path)) == row['sha256'],
                'prior_automation_migration_receipt_mismatch')
    return previous['commit'], previous_financial['commit']


def _old_units(automation_commit):
    peer = automation.peer_unit_texts(automation_commit)
    return {automation.UNIT: automation.unit_text(automation_commit),
            'domino-gas-reservation.service': peer['domino-gas-reservation.service'],
            'domino-gas-settlement.service': peer['domino-gas-settlement.service']}


def _off(state):
    """Inactive with no main process. systemd shows MainPID for a service only:
    a socket or a timer has none, and its ActiveState alone says it is off."""
    return state['ActiveState'] == 'inactive' and state.get('MainPID', '0') == '0'


def _source_root(planned):
    return financial.ROOT / 'releases' / planned['commit']


def _source_present(files, planned):
    component_root = _source_root(planned) / automation.COMPONENT
    if not os.path.lexists(component_root):
        return False
    base.trusted_parents(component_root)
    for name, (raw, executable) in files.items():
        if not name.startswith('backend/') or name.startswith('backend/tests/'):
            continue
        path = component_root / name
        base.trusted_parents(path.parent)
        info = base.trusted(path)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1
                and stat.S_IMODE(info.st_mode) == (0o555 if executable else 0o444)
                and financial.sha(financial.read_file(path)) == financial.sha(raw),
                'readiness_source_drift')
    return True


def _journal_dir(planned):
    return automation.RECEIPTS / ('readiness-' + planned['commit'])


def baseline(files, planned):
    require(os.geteuid() == 0, 'root_required')
    for directory in (base.BASE, base.UNIT_DIR, financial.ROOT, automation.RECEIPTS):
        base.trusted_parents(directory)
    base.pg_parents(base.CONFIG)
    base.dependency_preflight(files)
    old_automation, old_financial = _prior_receipts(files)
    old_units = _old_units(old_automation)
    # The units run as unprivileged users that must pass through both directories.
    for directory in (financial.ROOT / 'releases', _source_root(planned)):
        if os.path.lexists(directory):
            automation.traversable(directory)
    has_receipt = _upgrade_receipt(planned)
    source_present = _source_present(files, planned)
    journal_present = os.path.lexists(_journal_dir(planned))
    if journal_present:
        base.trusted_parents(_journal_dir(planned))
        require(json.loads(financial.read_file(_journal_dir(planned) / 'plan.json')) == planned,
                'readiness_upgrade_journal_mismatch')
        for name, old in _old_units(old_automation).items():
            require(financial.read_file(_journal_dir(planned) / (name + '.old')) == old.encode(),
                    'readiness_upgrade_journal_mismatch')
    if has_receipt:
        require(source_present and journal_present,
                'readiness_upgrade_partial_without_journal')
    else:
        require(journal_present or not source_present,
                'readiness_upgrade_partial_without_receipt')
        require(financial.sql("SELECT count(*) FROM pg_policies WHERE schemaname='domino_execution' "
                              "AND tablename='controls' AND policyname='execution_reader_automation_ready'") == '0',
                'readiness_policy_already_exists')
    unit_bytes = {}
    for name in UNITS:
        path = base.UNIT_DIR / name
        info = base.trusted(path)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1, 'readiness_unit_drift')
        raw = financial.read_file(path, 65536)
        require(raw in (old_units[name].encode(), planned['units'][name].encode()),
                'readiness_unit_drift')
        if not has_receipt:
            require(raw == old_units[name].encode(), 'readiness_unit_prematurely_replaced')
        unit_bytes[name] = financial.sha(raw)
    for name in OFF_UNITS:
        state = financial.unit_state(name)
        require(_off(state),
                'financial_service_must_be_off')
    protected = {name: financial.unit_state(name) for name in WATCHED}
    return {'planSha256': financial.sha(financial.json_bytes(planned)),
            'oldAutomationCommit': old_automation, 'oldFinancialCommit': old_financial,
            'migrationCommitted': has_receipt, 'sourcePresent': source_present,
            'unitHashes': unit_bytes, 'protected': protected}


def migration_sql(files, planned, prior_receipt):
    """One atomic 039+040+046+receipt transaction; the 028–038 receipt stays immutable."""
    old = json.dumps(prior_receipt, sort_keys=True, separators=(',', ':'))
    require("'" not in old, 'prior_install_receipt_invalid')
    migration_statements = '\n'.join(files[path][0].decode('utf-8') for path in MIGRATIONS)
    allowed_paths = ','.join("'" + path + "'" for path in MIGRATIONS)
    receipt_rows = ',\n '.join(
        f"('{migration['path']}','{planned['commit']}','{migration['sha256']}')"
        for migration in planned['migrations'])
    return f'''BEGIN;
SET LOCAL lock_timeout='3000ms';
SET LOCAL statement_timeout='30000ms';
SELECT pg_advisory_xact_lock({automation.DB_LOCK});
DO $$ BEGIN
 IF current_user<>'postgres' OR current_database()<>'{base.DB}' THEN RAISE EXCEPTION 'wrong_readiness_ddl_identity'; END IF;
 IF to_regclass('domino_automation_install.receipt') IS NULL OR to_regclass('domino_execution.controls') IS NULL
  OR to_regclass('{UPGRADE_TABLE}') IS NOT NULL THEN RAISE EXCEPTION 'readiness_prior_state_mismatch'; END IF;
 IF (SELECT value FROM domino_automation_install.receipt WHERE singleton=true) IS DISTINCT FROM '{old}'::jsonb
  OR EXISTS(SELECT FROM pg_policies WHERE schemaname='domino_execution' AND tablename='controls'
   AND policyname='execution_reader_automation_ready') THEN RAISE EXCEPTION 'readiness_prior_state_mismatch'; END IF;
END $$;
{migration_statements}
CREATE TABLE {UPGRADE_TABLE} (
 migration_path text PRIMARY KEY CHECK(migration_path IN ({allowed_paths})),
 release_commit text NOT NULL CHECK(release_commit ~ '^[0-9a-f]{{40}}$'),
 sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{{64}}$'),
 applied_at timestamptz NOT NULL DEFAULT clock_timestamp());
REVOKE ALL ON {UPGRADE_TABLE} FROM PUBLIC;
INSERT INTO {UPGRADE_TABLE}(migration_path,release_commit,sha256)
 VALUES{receipt_rows};
COMMIT;
'''


def _install_source(files, planned):
    """The automation component, staged under a private name and renamed into
    place, beside whatever another installer put at the same commit."""
    if _source_present(files, planned):
        return
    release = _source_root(planned)
    base.trusted_parents(release.parent)
    automation.traversable(release.parent)
    created = not os.path.lexists(release)
    if created:
        release.mkdir(mode=0o755)
    else:
        base.trusted_parents(release)
        automation.traversable(release)
    staging = Path(tempfile.mkdtemp(prefix='.automation-readiness-', dir=release))
    try:
        for name, (raw, executable) in files.items():
            if not name.startswith('backend/') or name.startswith('backend/tests/'):
                continue
            path = staging / name
            path.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
            base.exclusive_file(path, raw, 0o555 if executable else 0o444)
        (staging / 'backend/runtime').mkdir(mode=0o700)
        for directory, _, _ in os.walk(staging, topdown=False):
            os.chmod(directory, 0o555)
        require(not os.path.lexists(release / automation.COMPONENT), 'readiness_source_exists')
        os.replace(staging, release / automation.COMPONENT)
        base.fsync_directory(release)
        if created:
            # Explicit, whatever the umask: 0700 here would stop every unit at CHDIR.
            os.chmod(release, 0o555)
    except BaseException:
        if os.path.lexists(staging):
            for directory, _, _ in os.walk(staging):
                os.chmod(directory, 0o700)
            shutil.rmtree(staging)
        if created:
            # Only while empty: once the component is in place the release stays.
            try: release.rmdir()
            except OSError: pass
        raise
    require(_source_present(files, planned), 'readiness_source_install_failed')


def _replace_unit(path, raw):
    temporary = path.with_name(path.name + '.readiness-new')
    require(not os.path.lexists(temporary), 'readiness_unit_temporary_exists')
    base.exclusive_file(temporary, raw, mode=0o644)
    os.replace(temporary, path)
    base.fsync_directory(path.parent)


def rollback(planned):
    """Restore only the three previously OFF units. The 039/040/046 receipts are retained."""
    directory = _journal_dir(planned)
    base.trusted_parents(directory)
    require(json.loads(financial.read_file(directory / 'plan.json')) == planned,
            'readiness_rollback_plan_mismatch')
    previous = {name: financial.read_file(directory / (name + '.old')) for name in UNITS}
    for name in UNITS:
        current = financial.read_file(base.UNIT_DIR / name, 65536)
        require(current in (previous[name], planned['units'][name].encode()),
                'readiness_rollback_unit_drift')
    for name in OFF_UNITS:
        state = financial.unit_state(name)
        require(_off(state),
                'financial_service_must_be_off')
    for name in UNITS:
        path = base.UNIT_DIR / name
        if financial.read_file(path, 65536) != previous[name]:
            _replace_unit(path, previous[name])
    base.run(['/usr/bin/systemctl', 'daemon-reload'])
    state = {'phase': 'rolled_back_off', 'migrationCommitted': _upgrade_receipt(planned),
             'servicesStarted': False}
    financial.journal(directory, state)
    return state


def apply(files, planned, expected):
    actual = baseline(files, planned)
    require(actual == expected, 'baseline_changed')
    directory = _journal_dir(planned)
    if not os.path.lexists(directory):
        staging = Path(tempfile.mkdtemp(prefix=directory.name + '.journal-', dir=directory.parent))
        try:
            financial.save(staging / 'plan.json', financial.json_bytes(planned))
            for name in UNITS:
                financial.save(staging / (name + '.old'), financial.read_file(base.UNIT_DIR / name, 65536))
            financial.save(staging / 'baseline.json', financial.json_bytes(actual))
            base.fsync_directory(staging)
            require(not os.path.lexists(directory), 'readiness_journal_exists')
            os.replace(staging, directory)
            base.fsync_directory(directory.parent)
        finally:
            if os.path.lexists(staging):
                shutil.rmtree(staging)
    else:
        require(json.loads(financial.read_file(directory / 'plan.json')) == planned,
                'readiness_upgrade_journal_mismatch')
        old = _old_units(actual['oldAutomationCommit'])
        for name in UNITS:
            require(financial.read_file(directory / (name + '.old')) == old[name].encode(),
                    'readiness_upgrade_journal_mismatch')
    financial.journal(directory, {'phase': 'preparing', 'migrationCommitted': actual['migrationCommitted'],
                                  'servicesStarted': False})
    try:
        _install_source(files, planned)
        if not actual['migrationCommitted']:
            prior = _install_receipt('domino_automation_install.receipt')
            financial.sql(migration_sql(files, planned, prior))
        require(_upgrade_receipt(planned), 'readiness_migration_receipt_missing')
        financial.journal(directory, {'phase': 'sql_committed', 'migrationCommitted': True,
                                      'servicesStarted': False})
        for name in UNITS:
            path = base.UNIT_DIR / name
            if financial.read_file(path, 65536) != planned['units'][name].encode():
                _replace_unit(path, planned['units'][name].encode())
        base.run(['/usr/bin/systemd-analyze', 'verify', *(str(base.UNIT_DIR / name) for name in UNITS)])
        base.run(['/usr/bin/systemctl', 'daemon-reload'])
        require({name: financial.unit_state(name) for name in WATCHED} == actual['protected'],
                'protected_lane_changed')
        for name in OFF_UNITS:
            state = financial.unit_state(name)
            require(_off(state),
                    'financial_service_started_unexpectedly')
        financial.journal(directory, {'phase': 'installed_off', 'migrationCommitted': True,
                                      'servicesStarted': False})
        return {'commit': planned['commit'], 'phase': 'installed_off',
                'migrationCommitted': True, 'servicesStarted': False,
                'privateConfigurationChanged': False, 'protectedLanesUnchanged': True}
    except BaseException:
        try:
            rollback(planned)
        except BaseException:
            pass
        raise


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
    files = financial.archive_files(args.archive, args.archive_sha256, args.commit)
    planned = plan(files, args.commit, args.archive_sha256)
    if not any((args.inspect, args.apply, args.rollback)):
        print(json.dumps(planned, sort_keys=True, indent=2)); return 0
    require(os.geteuid() == 0, 'root_required')
    base.trusted_parents(base.BASE)
    fd = os.open(LOCK, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, 'rb+'):
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_uid == 0
                and stat.S_IMODE(info.st_mode) == 0o600 and info.st_nlink == 1,
                'unsafe_install_lock')
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.rollback:
            result = rollback(planned)
        elif args.inspect:
            result = baseline(files, planned)
        else:
            require(args.baseline is not None, 'baseline_required')
            base.trusted_parents(args.baseline.parent)
            require(base.trusted(args.baseline).st_mode & 0o077 == 0, 'private_baseline_required')
            result = apply(files, planned, json.loads(financial.read_file(args.baseline)))
    print(json.dumps(result, sort_keys=True, indent=2)); return 0


if __name__ == '__main__':
    sys.exit(main())
