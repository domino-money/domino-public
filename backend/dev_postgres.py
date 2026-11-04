"""Task-local PostgreSQL cluster: private Unix socket, no TCP or system service."""
import argparse
import json
import os
import re
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import tempfile

import psycopg
from psycopg import sql

from catalogue import DB_CONFIG
from discovery import DataError

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT/'runtime'
DATA = RUNTIME/'postgres'
SOCKET = RUNTIME/'pgsocket'
PORT = 8877
ADMIN = 'domino_catalogue_admin'


def postgres_bin():
    """Discover a local installation without upgrading an existing data directory."""
    explicit = os.environ.get('DOMINO_PG_BIN')
    candidates = [Path(explicit)] if explicit else []
    if not explicit:
        candidates.extend(Path(p) for p in (
            '/opt/homebrew/opt/postgresql@18/bin', '/usr/local/opt/postgresql@18/bin'))
        config = shutil.which('pg_config')
        if config:
            result = subprocess.run([config, '--bindir'], capture_output=True, text=True, timeout=5)
            if result.returncode == 0:
                candidates.append(Path(result.stdout.strip()))
        initdb = shutil.which('initdb')
        if initdb:
            candidates.append(Path(initdb).parent)
        candidates.extend(sorted(Path('/usr/lib/postgresql').glob('*/bin'), reverse=True))
    required = (DATA/'PG_VERSION').read_text().strip() if (DATA/'PG_VERSION').is_file() else None
    for candidate in candidates:
        if not all((candidate/name).is_file() for name in ('initdb','pg_ctl','pg_dump','pg_restore')):
            continue
        result = subprocess.run([str(candidate/'initdb'), '--version'], capture_output=True, text=True, timeout=5)
        if result.returncode:
            continue
        match = re.search(r'\(PostgreSQL\)\s+(\d+)', result.stdout)
        major = match.group(1) if match else ''
        if major.isdigit() and int(major) >= 16 and (required is None or major == required):
            return candidate
    # Keep import possible for the non-PostgreSQL suite; start() reports missing tools.
    return RUNTIME/'postgresql-not-found'


BIN = postgres_bin()


def private_directory(path):
    path.mkdir(mode=0o700,parents=True,exist_ok=True)
    check_private_directory(path)


def check_private_directory(path):
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or info.st_mode & 0o077:
        raise DataError('private_postgres_directory_required')


# The clusters here are created with --locale=C, so every tool that touches one
# runs in it. PostgreSQL 18 refuses to start under a locale it cannot set
# ("postmaster became multithreaded during startup"), and inheriting the
# caller's is neither needed nor reproducible.
C_LOCALE = {'LC_ALL': 'C', 'LANG': 'C'}


def pg_command(args):
    result = subprocess.run(args,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=30,
                            env={**os.environ, **C_LOCALE})
    if result.returncode:
        raise DataError('local_postgres_command_failed')


def stop():
    """Stop only this task's cluster; cleanup before initialization is harmless."""
    for directory in (RUNTIME, DATA):
        try:
            check_private_directory(directory)
        except FileNotFoundError:
            return False
    version = DATA/'PG_VERSION'
    pid_file = DATA/'postmaster.pid'
    if not version.exists() and not version.is_symlink():
        if pid_file.exists() or pid_file.is_symlink():
            raise DataError('invalid_local_postgres_cluster')
        return False
    if version.is_symlink() or not version.is_file():
        raise DataError('invalid_local_postgres_cluster')

    def status():
        return subprocess.run([str(BIN/'pg_ctl'),'-D',str(DATA),'status'],
                              capture_output=True,timeout=5,
                              env={**os.environ, **C_LOCALE}).returncode

    state = status()
    if state == 3:  # pg_ctl's documented "server is not running" result.
        return False
    if state != 0:
        raise DataError('local_postgres_command_failed')
    # pg_ctl signals the PID from this file. Refuse a symlink or a PID file
    # belonging to a different data directory before invoking its stop action.
    info = pid_file.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_mode & 0o077:
        raise DataError('invalid_local_postgres_cluster')
    lines = pid_file.read_text().splitlines()
    if (len(lines) < 2 or not lines[0].isdigit() or int(lines[0]) <= 0
            or Path(lines[1]).resolve() != DATA.resolve()):
        raise DataError('invalid_local_postgres_cluster')
    try:
        pg_command([str(BIN/'pg_ctl'),'-D',str(DATA),'-m','fast','-w','-t','15','stop'])
    except DataError:
        # Another cleanup may have completed between status and stop.
        if status() == 3:
            return False
        raise
    return True


def start():
    if not (BIN/'initdb').is_file():
        raise DataError('compatible_postgresql_not_installed_set_DOMINO_PG_BIN')
    private_directory(RUNTIME)
    private_directory(SOCKET)
    if not (DATA/'PG_VERSION').exists():
        if DATA.exists():
            raise DataError('postgres_directory_already_exists')
        pg_command([str(BIN/'initdb'),'-D',str(DATA),'-U',ADMIN,'--auth-local=trust',
                    '--auth-host=reject','--encoding=UTF8','--locale=C'])
    private_directory(DATA)
    status = subprocess.run([str(BIN/'pg_ctl'),'-D',str(DATA),'status'],capture_output=True)
    if status.returncode:
        options = shlex.join(['-k',str(SOCKET),'-p',str(PORT),'-c','listen_addresses=',
                             '-c','unix_socket_permissions=0700'])
        pg_command([str(BIN/'pg_ctl'),'-D',str(DATA),'-l',str(RUNTIME/'postgres.log'),
                    '-o',options,'-w','-t','15','start'])
    settings={'host':str(SOCKET),'port':PORT,'dbname':'domino_catalogue'}
    with psycopg.connect(host=str(SOCKET),port=PORT,dbname='postgres',user=ADMIN,autocommit=True) as conn:
        for role in ['domino_catalogue_reader','domino_catalogue_writer','domino_session_auth','domino_wallet_access_operator','domino_deposit_service',
                     'domino_performance_collector','domino_performance_reader']:
            if not conn.execute('SELECT 1 FROM pg_roles WHERE rolname=%s',(role,)).fetchone():
                conn.execute(sql.SQL('CREATE ROLE {} LOGIN').format(sql.Identifier(role)))
        conn.execute('ALTER ROLE domino_session_auth NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
        conn.execute('ALTER ROLE domino_deposit_service NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
        conn.execute('ALTER ROLE domino_wallet_access_operator NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
        conn.execute('ALTER ROLE domino_performance_collector NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
        conn.execute('ALTER ROLE domino_performance_reader NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
    create_database(settings['dbname'])
    fd,name=tempfile.mkstemp(prefix='.catalogue-db-',dir=RUNTIME)
    try:
        with os.fdopen(fd,'w') as stream:
            json.dump(settings,stream);stream.write('\n');stream.flush();os.fsync(stream.fileno())
        if DB_CONFIG.is_symlink():
            raise DataError('invalid_database_configuration_path')
        os.replace(name,DB_CONFIG)
    finally:
        if os.path.exists(name):os.unlink(name)
    print('Local PostgreSQL ready: private Unix socket, isolated catalogue and session roles.')


def create_database(name):
    if name not in {'domino_catalogue','domino_catalogue_tests','domino_catalogue_restore_tests'}:
        raise DataError('invalid_local_database_name')
    with psycopg.connect(host=str(SOCKET),port=PORT,dbname='postgres',user=ADMIN,autocommit=True) as conn:
        if not conn.execute('SELECT 1 FROM pg_database WHERE datname=%s',(name,)).fetchone():
            conn.execute(sql.SQL('CREATE DATABASE {}').format(sql.Identifier(name)))
    with psycopg.connect(host=str(SOCKET),port=PORT,dbname=name,user=ADMIN) as conn:
        conn.execute((ROOT/'migrations/001_catalogue.sql').read_text())
        conn.execute((ROOT/'migrations/002_activity.sql').read_text())
        conn.execute((ROOT/'migrations/003_fee_ledger.sql').read_text())
        conn.execute((ROOT/'migrations/004_positions.sql').read_text())
        conn.execute((ROOT/'migrations/005_capital_prices.sql').read_text())
        conn.execute((ROOT/'migrations/006_chainlink_prices.sql').read_text())
        conn.execute((ROOT/'migrations/007_historical_work.sql').read_text())
        conn.execute((ROOT/'migrations/008_wallet_sessions.sql').read_text())
        conn.execute((ROOT/'migrations/009_direct_deposits.sql').read_text())
        conn.execute((ROOT/'migrations/010_deposit_recovery.sql').read_text())
        conn.execute((ROOT/'migrations/011_wallet_access.sql').read_text())
        conn.execute((ROOT/'migrations/012_capital_work.sql').read_text())
        conn.execute((ROOT/'migrations/013_activity_diagnostics.sql').read_text())
        conn.execute((ROOT/'migrations/014_deposit_draft_recovery.sql').read_text())
        # Execution migrations intentionally reject reapplication. Catalogue
        # restore tests may revisit this initializer without dropping finance.
        if conn.execute("SELECT to_regnamespace('domino_execution') IS NULL").fetchone()[0]:
            conn.execute((ROOT/'migrations/015_unsigned_execution.sql').read_text())
        conn.execute((ROOT/'migrations/016_managed_performance.sql').read_text())
        conn.execute((ROOT/'migrations/017_performance_financial_history.sql').read_text())
        conn.execute((ROOT/'migrations/018_performance_enrollment.sql').read_text())
        if conn.execute("SELECT to_regclass('domino_execution.journal') IS NULL").fetchone()[0]:
            conn.execute((ROOT/'migrations/019_execution_journal.sql').read_text())
        conn.execute((ROOT/'migrations/020_pool_requests.sql').read_text())
        conn.execute((ROOT/'migrations/021_reference_price_sources.sql').read_text())
        conn.execute((ROOT/'migrations/022_event_timestamp_source.sql').read_text())
        conn.execute((ROOT/'migrations/023_pool_request_scheduling.sql').read_text())
        conn.execute((ROOT/'migrations/024_public_observations.sql').read_text())
        conn.execute((ROOT/'migrations/025_public_history.sql').read_text())
        conn.execute((ROOT/'migrations/026_public_demand.sql').read_text())
        # 011 installs the wallet-admission gate on domino_sessions.sessions;
        # 027 detaches it, so a development database matches a migrated one.
        conn.execute((ROOT/'migrations/027_remove_wallet_access_gate.sql').read_text())
        if conn.execute("SELECT to_regclass('domino_execution.cycles') IS NULL").fetchone()[0]:
            conn.execute((ROOT/'migrations/028_automation_cycle.sql').read_text())
        if conn.execute("SELECT to_regclass('domino_execution.withdrawals') IS NULL").fetchone()[0]:
            conn.execute((ROOT/'migrations/029_ledger_index.sql').read_text())
        if conn.execute("SELECT to_regclass('domino_execution.swap_exposure') IS NULL").fetchone()[0]:
            conn.execute((ROOT/'migrations/030_swap_exposure.sql').read_text())
        # 031 only replaces 028's publication guard, so it applies again safely.
        conn.execute((ROOT/'migrations/031_publication_resend.sql').read_text())
        if conn.execute("SELECT to_regnamespace('domino_gas_budget') IS NULL").fetchone()[0]:
            conn.execute((ROOT/'migrations/032_shared_gas_budget.sql').read_text())
        if conn.execute("SELECT to_regprocedure('domino_gas_budget.claim_for_settlement(text,text)') IS NULL").fetchone()[0]:
            conn.execute((ROOT/'migrations/033_gas_budget_claim_read.sql').read_text())
        if conn.execute("SELECT to_regprocedure('domino_gas_budget.next_pending(integer)') IS NULL").fetchone()[0]:
            conn.execute((ROOT/'migrations/034_gas_settlement_sweep.sql').read_text())
        if conn.execute("SELECT to_regprocedure('domino_gas_budget.cancel_unsigned(text,text)') IS NULL").fetchone()[0]:
            conn.execute((ROOT/'migrations/035_cancel_unsigned_gas_claims.sql').read_text())
        if conn.execute("SELECT to_regprocedure('domino_execution.gas_publication_witness(text)') IS NULL").fetchone()[0]:
            conn.execute((ROOT/'migrations/036_gas_settlement_journal_read.sql').read_text())
        if conn.execute("SELECT to_regclass('domino_execution.reverted_receipts') IS NULL").fetchone()[0]:
            conn.execute((ROOT/'migrations/037_gas_settlement_receipt_evidence.sql').read_text())
        if conn.execute("SELECT to_regclass('domino_gas_budget.settlement_quote_witnesses') IS NULL").fetchone()[0]:
            conn.execute((ROOT/'migrations/038_gas_settlement_quote_witness.sql').read_text())
        # Replaces only the two finalized settlement quote functions from 038.
        conn.execute((ROOT/'migrations/040_gas_finalized_quote_lag.sql').read_text())
        # Replaces four gas functions, 040's two included, to take an ETH/USD
        # answer as old as the feed's heartbeat; it applies again safely.
        conn.execute((ROOT/'migrations/046_gas_answer_heartbeat.sql').read_text())
        # 041 only widens the session policy and adds a nullable column, so it
        # applies again safely.
        conn.execute((ROOT/'migrations/041_session_delegated_accounts.sql').read_text())
        # 042 only replaces 024's provider reservation, so it applies again safely.
        conn.execute((ROOT/'migrations/042_provider_priority.sql').read_text())
        # 043 creates the featured-pools tables if absent and re-grants, so it applies again safely.
        conn.execute((ROOT/'migrations/043_featured_pools.sql').read_text())
        # 044 only adds a nullable column if absent, so it applies again safely.
        conn.execute((ROOT/'migrations/044_demand_horizon.sql').read_text())
        # 045 creates its table if absent and replaces two checks, so it applies again safely.
        conn.execute((ROOT/'migrations/045_featured_live.sql').read_text())
        # 047 only replaces 042's reservation with a lower ceiling, so it applies again safely.
        conn.execute((ROOT/'migrations/047_provider_ceiling.sql').read_text())
        # 052 creates the V2 index's schema and tables if absent and re-grants, so it applies again safely.
        conn.execute((ROOT/'migrations/052_v2_index.sql').read_text())
        # 053 only adds the ledgers' per-chunk index if absent, so it applies again safely.
        conn.execute((ROOT/'migrations/053_activity_chunk_index.sql').read_text())
        # 054 creates the V2 fee follower's tables if absent and re-grants, so it applies again safely.
        conn.execute((ROOT/'migrations/054_v2_fees.sql').read_text())
        # 055 adds the featured tables' chain if absent and rebuilds their keys under 043's and
        # 045's names, which those then leave be, so it applies again safely.
        conn.execute((ROOT/'migrations/055_featured_chains.sql').read_text())
        # 056 creates the mint scan's checkpoint tables if absent and re-grants, so it applies again safely.
        conn.execute((ROOT/'migrations/056_position_mint_scan.sql').read_text())
        # 057 only adds the sessions' nullable origin and its check if absent, so it applies again safely.
        conn.execute((ROOT/'migrations/057_session_origin.sql').read_text())
        # Development mirrors the production split: callable NOLOGIN privilege
        # roles, each inherited by exactly one unprivileged LOGIN bridge.
        for login, privilege in (
                ('domino_gas_reservation_login', 'domino_gas_budget_worker'),
                ('domino_gas_settlement_login', 'domino_gas_settlement_worker')):
            if not conn.execute('SELECT 1 FROM pg_roles WHERE rolname=%s', (login,)).fetchone():
                conn.execute(sql.SQL('CREATE ROLE {} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS')
                             .format(sql.Identifier(login)))
            attrs = conn.execute('SELECT rolcanlogin,rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls '
                                 'FROM pg_roles WHERE rolname=%s', (login,)).fetchone()
            if attrs != (True, False, False, False, False, False):
                raise DataError('unsafe_gas_access_role')
            if conn.execute('SELECT rolcanlogin FROM pg_roles WHERE rolname=%s', (privilege,)).fetchone() != (False,):
                raise DataError('gas_privilege_role_login_enabled')
            conn.execute(sql.SQL('GRANT CONNECT ON DATABASE {} TO {}').format(
                sql.Identifier(name), sql.Identifier(login)))
            conn.execute(sql.SQL('GRANT {} TO {} WITH INHERIT TRUE, SET FALSE').format(
                sql.Identifier(privilege), sql.Identifier(login)))



def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action',choices=['start','stop','prepare-tests'])
    args=parser.parse_args()
    try:
        if args.action=='stop':
            stopped = stop()
            print('Task-local PostgreSQL stopped; stored catalogue retained.' if stopped
                  else 'Task-local PostgreSQL is not running; nothing to stop.')
        else:
            start()
            if args.action=='prepare-tests':
                create_database('domino_catalogue_tests')
                create_database('domino_catalogue_restore_tests')
                print('Separate catalogue test databases prepared.')
    except (DataError,psycopg.Error,OSError,subprocess.SubprocessError):
        print('Local PostgreSQL setup failed; inspect the task-local postgres.log when present.')
        return 1
    return 0


if __name__=='__main__':
    raise SystemExit(main())
