#!/usr/bin/env python3
"""Root-only, read-only verification of Domino staging peer identities and ACLs."""
import argparse
import grp
import json
import os
from pathlib import Path
import pwd
import re
import signal
import stat
import subprocess
import time


ADMIN = 'domino_catalogue_admin'
READER = 'domino_catalogue_reader'
WRITER = 'domino_catalogue_writer'
AUTH = 'domino_session_auth'
OPERATOR = 'domino_wallet_access_operator'
DEPOSIT = 'domino_deposit_service'
ROLES = (ADMIN, READER, WRITER, AUTH, OPERATOR, DEPOSIT)
PEERS = {
    'domino-admin': (ADMIN,), 'domino-read': (READER,), 'domino-write': (WRITER,),
    'domino-auth': (AUTH,), 'domino-operator': (OPERATOR,),
    'domino-onboarding': (AUTH,), 'domino-deposit': (AUTH, DEPOSIT),
    'domino-gateway': (), 'domino-tunnel': (),
}
TABLES = {
    'domino_catalogue': ('state', 'chunks', 'events', 'hints'),
    'domino_activity': ('pools', 'chunks', 'events', 'fee_chunks', 'fee_events',
                        'position_chunks', 'position_settlements', 'capital_chunks',
                        'capital_events', 'price_observations', 'historical_work'),
    'domino_sessions': ('contexts', 'challenges', 'sessions', 'rate_limits', 'private_limits'),
    'domino_wallet_access': ('grants', 'audit'),
    'domino_deposits': ('intents', 'capacity'),
}
FUNCTIONS = {
    'domino_wallet_access.set_access(text, boolean)': True,
    'domino_wallet_access.guard_session_insert()': True,
    'domino_deposits.preserve_selection()': False,
    'domino_deposits.reserve_capacity()': True,
    'domino_deposits.release_capacity()': True,
    'domino_deposits.expire_unissued()': True,
}
PRIVILEGES = ('SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER')
SCHEMAS_SQL = ','.join("'" + s + "'" for s in TABLES)
ROLES_SQL = ','.join("'" + r + "'" for r in ROLES)
IDENTITY_SQL = """SELECT json_build_object('sessionUser',session_user,
 'currentUser',current_user,'database',current_database(),
 'readonly',current_setting('transaction_read_only')='on');"""
DENIED_PEER = re.compile(
    r'FATAL:\s+(?:Peer authentication failed for user |'
    r'no pg_hba.conf entry for |pg_hba.conf rejects connection for )')


def command(argv, deadline, *, denied_socket=None):
    """No shell, inherited credentials, prompts, retries, or unbounded child lifetime."""
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return {'status': 'overall_timeout'}
    proc = subprocess.Popen(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            start_new_session=True, env={'PATH': '/usr/sbin:/usr/bin:/bin', 'LC_ALL': 'C'})
    try:
        stdout, stderr = proc.communicate(timeout=min(6, remaining))
    except subprocess.TimeoutExpired:
        os.killpg(proc.pid, signal.SIGKILL)
        proc.communicate()
        return {'status': 'timeout'}
    if len(stdout) > 262144 or len(stderr) > 16384:
        return {'status': 'output_limit'}
    # Raw diagnostics never enter the report, including on unexpected errors.
    output = stdout.decode('utf-8', errors='replace').strip()
    error = stderr.decode('utf-8', errors='replace')
    if proc.returncode == 0:
        return {'status': 'ok', 'output': output}
    if proc.returncode == 2 and DENIED_PEER.search(error):
        return {'status': 'peer_denied'}
    if proc.returncode == 2 and denied_socket is not None and re.search(
            r'(?m)^psql: error: connection to server on socket "' + re.escape(denied_socket) +
            r'" failed: Permission denied$', error):
        return {'status': 'socket_denied'}
    if proc.returncode == 1 and re.search(r'ERROR:\s+42501\b', error):
        return {'status': 'privilege_denied'}
    return {'status': 'command_failed', 'exitCode': proc.returncode}


def query(args, os_user, sql_role, sql, deadline, *, socket_denial=False):
    argv = ['/usr/sbin/runuser', '-u', os_user, '--', '/usr/bin/env', '-i',
        'PATH=/usr/bin:/bin', 'LC_ALL=C', 'PGCONNECT_TIMEOUT=3', 'PGPASSFILE=/dev/null',
        'PGAPPNAME=domino-staging-role-check',
        'PGOPTIONS=-c default_transaction_read_only=on -c statement_timeout=2000 '
        '-c lock_timeout=500 -c idle_in_transaction_session_timeout=3000 -c search_path=pg_catalog',
        '/usr/bin/psql', '-X', '--no-password', '--no-align', '--tuples-only',
        '--set=ON_ERROR_STOP=1', '--set=VERBOSITY=sqlstate',
        '--host=' + args.socket, '--port=' + str(args.port),
        '--dbname=domino_catalogue', '--username=' + sql_role, '--command=' + sql]
    if socket_denial:
        return command(argv, deadline, denied_socket=str(Path(args.socket) / f'.s.PGSQL.{args.port}'))
    return command(argv, deadline)


def json_result(result):
    if result['status'] != 'ok':
        return None
    try:
        return json.loads(result['output'])
    except (KeyError, ValueError):
        return None


def socket_access(args, users, deadline):
    """Prove the foundation's kernel-level denials before interpreting EACCES."""
    directory = Path(args.socket)
    if str(directory.resolve(strict=True)) != args.socket:
        raise ValueError('socket_directory_must_be_canonical')
    pg_uid = pwd.getpwnam('postgres').pw_uid
    socket_gid = grp.getgrnam('domino-db').gr_gid
    for path, mode, kind in ((directory, 0o750, stat.S_ISDIR),
                             (directory / f'.s.PGSQL.{args.port}', 0o770, stat.S_ISSOCK)):
        info = path.lstat()
        if (not kind(info.st_mode) or info.st_uid != pg_uid or info.st_gid != socket_gid
                or stat.S_IMODE(info.st_mode) != mode):
            raise ValueError('socket_foundation_mismatch')
    # The child reports effective credentials and the kernel's access decision,
    # so an ACL/PAM supplementary-group exception cannot be mistaken for denial.
    code = ("import json,os,sys; print(json.dumps({'uid':os.geteuid(),"
            "'inSocketGroup':int(sys.argv[2]) in [os.getegid(),*os.getgroups()],"
            "'canTraverse':os.access(sys.argv[1],os.X_OK,effective_ids=True)}))")
    checks = []
    for name, uid in users.items():
        result = command(['/usr/sbin/runuser', '-u', name, '--', '/usr/bin/python3',
                          '-I', '-B', '-c', code, args.socket, str(socket_gid)], deadline)
        proof = json_result(result)
        allowed = bool(PEERS[name])
        checks.append({'osUser': name, 'expected': 'accessible' if allowed else 'denied',
            'ok': proof == {'uid': uid, 'inSocketGroup': allowed, 'canTraverse': allowed}})
    return checks


def metadata_sql():
    return f"""SELECT json_build_object(
 'databaseOwner',(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()),
 'databaseEncoding',(SELECT pg_encoding_to_char(encoding) FROM pg_database WHERE datname=current_database()),
 'serverEncoding',current_setting('server_encoding'),
 'roles',(SELECT json_agg(row_to_json(r)) FROM (SELECT rolname AS name,rolcanlogin AS login,
   NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit) AS restricted
   FROM pg_roles WHERE rolname IN ({ROLES_SQL}) ORDER BY rolname) r),
 'memberships',(SELECT count(*) FROM pg_auth_members m WHERE m.roleid IN
   (SELECT oid FROM pg_roles WHERE rolname IN ({ROLES_SQL})) OR m.member IN
   (SELECT oid FROM pg_roles WHERE rolname IN ({ROLES_SQL}))),
 'schemas',(SELECT json_agg(row_to_json(s)) FROM (SELECT nspname AS name,pg_get_userbyid(nspowner) AS owner
   FROM pg_namespace WHERE nspname IN ({SCHEMAS_SQL}) ORDER BY nspname) s),
 'relations',(SELECT json_agg(row_to_json(t)) FROM (SELECT n.nspname||'.'||c.relname AS name,
   c.relkind AS kind,pg_get_userbyid(c.relowner) AS owner,c.relrowsecurity AS rls,c.relforcerowsecurity AS force
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE n.nspname IN ({SCHEMAS_SQL}) AND c.relkind IN ('r','p','v','m','S','f')
   ORDER BY 1 LIMIT 129) t),
 'functions',(SELECT json_agg(row_to_json(f)) FROM (SELECT n.nspname||'.'||p.proname||'('||
   oidvectortypes(p.proargtypes)||')' AS name,pg_get_userbyid(p.proowner) AS owner,
   p.prosecdef AS definer,p.proconfig AS config FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname IN ({SCHEMAS_SQL}) ORDER BY 1 LIMIT 33) f),
 'policies',(SELECT json_agg(row_to_json(p)) FROM (SELECT polname AS name,polcmd AS command,
   polpermissive AS permissive,ARRAY(SELECT pg_get_userbyid(r) FROM unnest(polroles) r ORDER BY r) AS roles,
   pg_get_expr(polqual,polrelid) AS "using",pg_get_expr(polwithcheck,polrelid) AS "check"
   FROM pg_policy WHERE polrelid='domino_deposits.intents'::regclass ORDER BY polname LIMIT 9) p));"""


def allowed_schema(role, schema):
    return role == ADMIN or (role in (READER, WRITER) and schema in ('domino_catalogue', 'domino_activity')) or (
        role == AUTH and schema in ('domino_sessions', 'domino_wallet_access')) or (
        role == OPERATOR and schema == 'domino_wallet_access') or (role == DEPOSIT and schema == 'domino_deposits')


def allowed_table(role, name, privilege):
    schema, table = name.split('.')
    if role == ADMIN:
        return True
    if schema in ('domino_catalogue', 'domino_activity'):
        return role == READER and privilege == 'SELECT' or role == WRITER and privilege in PRIVILEGES[:4]
    if schema == 'domino_sessions':
        return role == AUTH and privilege in PRIVILEGES[:4]
    if schema == 'domino_wallet_access':
        return privilege == 'SELECT' and (role == OPERATOR or role == AUTH and table == 'grants')
    return role == DEPOSIT and (privilege == 'SELECT' or table == 'intents' and privilege in ('INSERT', 'UPDATE'))


def acl_sql(role):
    # Names come exclusively from the fixed reviewed release, never CLI/DB rows.
    expressions = []
    for schema, tables in TABLES.items():
        for privilege in ('USAGE', 'CREATE'):
            expected = allowed_schema(role, schema) if privilege == 'USAGE' else role == ADMIN
            expressions.append((f'schema:{schema}:{privilege}',
                f"has_schema_privilege('{role}','{schema}','{privilege}')", expected))
            if role != ADMIN:
                expressions.append((f'grantOption:{schema}:{privilege}',
                    f"has_schema_privilege('{role}','{schema}','{privilege} WITH GRANT OPTION')", False))
        for table in tables:
            name = schema + '.' + table
            for privilege in PRIVILEGES:
                expressions.append((f'table:{name}:{privilege}',
                    f"has_table_privilege('{role}','{name}','{privilege}')", allowed_table(role, name, privilege)))
                if role != ADMIN:
                    expressions.append((f'grantOption:{name}:{privilege}',
                        f"has_table_privilege('{role}','{name}','{privilege} WITH GRANT OPTION')", False))
    for function in FUNCTIONS:
        expected = role == ADMIN or (role == OPERATOR and function.endswith('.set_access(text, boolean)')) or (
            role == DEPOSIT and function.endswith('.expire_unissued()'))
        expressions.append((f'function:{function}:EXECUTE',
            f"has_function_privilege('{role}','{function}','EXECUTE')", expected))
        if role != ADMIN:
            expressions.append((f'grantOption:{function}:EXECUTE',
                f"has_function_privilege('{role}','{function}','EXECUTE WITH GRANT OPTION')", False))
    for privilege in ('USAGE', 'SELECT', 'UPDATE'):
        expressions.append((f'sequence:audit_id_seq:{privilege}',
            f"has_sequence_privilege('{role}','domino_wallet_access.audit_id_seq','{privilege}')", role == ADMIN))
    expressions.append(('publicSchema:CREATE', f"has_schema_privilege('{role}','public','CREATE')", role == ADMIN))
    rows = ','.join(f"('{name}',({sql}) IS NOT DISTINCT FROM {str(expected).lower()})"
                    for name, sql, expected in expressions)
    return "SELECT json_build_object('checks',count(*),'failures',COALESCE(json_agg(name) FILTER (WHERE NOT ok),'[]')) FROM (VALUES " + rows + ') AS checks(name,ok);'


def compact(expression):
    return None if expression is None else re.sub(r'[\s()]', '', expression)


def check_metadata(data):
    checks = {}
    checks['databaseOwner'] = data.get('databaseOwner') == ADMIN
    checks['databaseEncodingUtf8'] = data.get('databaseEncoding') == 'UTF8'
    checks['serverEncodingUtf8'] = data.get('serverEncoding') == 'UTF8'
    roles = data.get('roles') or []
    checks['roles'] = {r['name'] for r in roles} == set(ROLES) and all(r['login'] and r['restricted'] for r in roles)
    checks['memberships'] = data.get('memberships') == 0
    schemas = data.get('schemas') or []
    checks['schemaOwners'] = {s['name'] for s in schemas} == set(TABLES) and all(s['owner'] == ADMIN for s in schemas)
    expected = {schema + '.' + table for schema, tables in TABLES.items() for table in tables}
    expected.add('domino_wallet_access.audit_id_seq')
    relations = data.get('relations') or []
    checks['tableAndSequenceOwners'] = ({t['name'] for t in relations} == expected and all(
        t['owner'] == ADMIN and t['kind'] == ('S' if t['name'].endswith('.audit_id_seq') else 'r') for t in relations))
    checks['depositRls'] = all(t['rls'] == t['force'] == (t['name'] == 'domino_deposits.intents')
                              for t in relations if t['name'].startswith('domino_deposits.'))
    functions = data.get('functions') or []
    checks['functionOwnersAndSecurity'] = {f['name'] for f in functions} == set(FUNCTIONS) and all(
        f['owner'] == ADMIN and f['definer'] == FUNCTIONS[f['name']] and
        f['config'] is not None and len(f['config']) == 1 and
        f['config'][0].replace(' ', '') == 'search_path=pg_catalog,' + f['name'].split('.')[0] for f in functions)
    owner = "owner=current_setting'domino.deposit_owner'::text,true"
    expected_policies = {
        'deposit_owner': ('*', [DEPOSIT], owner, owner),
        'deposit_maintenance_read': ('r', [ADMIN], 'true', None),
        'deposit_maintenance_delete': ('d', [ADMIN], 'true', None),
        'deposit_maintenance_lock': ('w', [ADMIN], 'true', 'false'),
    }
    policies = data.get('policies') or []
    checks['depositPolicies'] = {p['name'] for p in policies} == set(expected_policies) and all(
        p['permissive'] and (p['command'], p['roles'], compact(p['using']), compact(p['check'])) ==
        expected_policies[p['name']] for p in policies)
    return checks


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    parser.add_argument('--socket', default='/run/postgresql-domino')
    parser.add_argument('--port', type=int, default=8877)
    args = parser.parse_args(argv)
    report = {'version': 1, 'mode': 'read_only', 'ok': False, 'uidChecks': [], 'socketChecks': [], 'peerMatrix': [],
              'metadata': {}, 'privileges': [], 'selectChecks': []}
    deadline = time.monotonic() + 120
    try:
        if os.geteuid() != 0:
            raise ValueError('root_required')
        if not Path(args.socket).is_absolute() or not 1024 <= args.port <= 65535:
            raise ValueError('invalid_socket_or_port')
        for executable in ('/usr/sbin/runuser', '/usr/bin/env', '/usr/bin/psql', '/usr/bin/id', '/usr/bin/python3'):
            if not os.access(executable, os.X_OK):
                raise ValueError('required_executable_missing')
        users = {name: pwd.getpwnam(name).pw_uid for name in PEERS}
        if 0 in users.values() or len(set(users.values())) != len(users):
            raise ValueError('service_uids_must_be_distinct_nonroot')
        for name, uid in users.items():
            result = command(['/usr/sbin/runuser', '-u', name, '--', '/usr/bin/id', '-u'], deadline)
            report['uidChecks'].append({'osUser': name, 'uid': uid,
                'ok': result['status'] == 'ok' and result['output'] == str(uid)})
        if not all(row['ok'] for row in report['uidChecks']):
            raise ValueError('effective_uid_check_failed')
        report['socketChecks'] = socket_access(args, users, deadline)
        if not all(row['ok'] for row in report['socketChecks']):
            raise ValueError('effective_socket_access_mismatch')
        for os_user, permitted in PEERS.items():
            for role in ROLES:
                # Only these proved-inaccessible UIDs can pass on socket EACCES.
                denied_at_socket = not permitted
                result = query(args, os_user, role, IDENTITY_SQL, deadline, socket_denial=denied_at_socket)
                identity = json_result(result)
                allowed = role in permitted
                valid = identity == {'sessionUser': role, 'currentUser': role,
                    'database': 'domino_catalogue', 'readonly': True}
                report['peerMatrix'].append({'osUser': os_user, 'sqlRole': role,
                    'expected': 'allowed' if allowed else 'denied', 'result': result['status'],
                    'ok': valid if allowed else result['status'] == (
                        'socket_denied' if denied_at_socket else 'peer_denied')})
        result = query(args, 'domino-admin', ADMIN, metadata_sql(), deadline)
        data = json_result(result)
        if not isinstance(data, dict):
            raise ValueError('metadata_unavailable')
        report['metadata'] = check_metadata(data)
        if not all(report['metadata'].values()):
            raise ValueError('metadata_mismatch')
        for role in ROLES:
            result = query(args, 'domino-admin', ADMIN, acl_sql(role), deadline)
            data = json_result(result)
            valid = isinstance(data, dict) and type(data.get('checks')) is int and data['checks'] > 0 and data.get('failures') == []
            report['privileges'].append({'sqlRole': role, 'ok': valid,
                'checks': data.get('checks', 0) if isinstance(data, dict) else 0,
                'failures': data.get('failures', ['query_failed']) if isinstance(data, dict) else ['query_failed']})
        # LIMIT 0 checks actual SELECT authorization without reading tenant rows.
        for os_user, permitted in PEERS.items():
            for role in permitted:
                for schema, tables in TABLES.items():
                    name = schema + '.' + ('sessions' if schema == 'domino_sessions' else tables[0])
                    expected = allowed_table(role, name, 'SELECT')
                    result = query(args, os_user, role,
                        f'SELECT count(*) FROM (SELECT 1 FROM {name} LIMIT 0) AS no_rows;', deadline)
                    valid = result['status'] == 'ok' and result['output'] == '0'
                    report['selectChecks'].append({'osUser': os_user, 'sqlRole': role, 'table': name,
                        'expected': 'allowed' if expected else 'denied', 'result': result['status'],
                        'ok': valid if expected else result['status'] == 'privilege_denied'})
        report['ok'] = (all(report['metadata'].values()) and all(row['ok'] for group in
            ('uidChecks', 'socketChecks', 'peerMatrix', 'privileges', 'selectChecks') for row in report[group]))
    except KeyError:
        report['error'] = 'required_os_user_or_metadata_missing'
    except ValueError as error:
        report['error'] = str(error)
    except (OSError, TypeError):
        report['error'] = 'verification_failed'
    report['counts'] = {'uids': len(report['uidChecks']), 'peerPairs': len(report['peerMatrix']),
                        'socketAccessChecks': len(report['socketChecks']),
                        'privilegeAssertions': sum(row['checks'] for row in report['privileges']),
                        'selectProbes': len(report['selectChecks'])}
    print(json.dumps(report, sort_keys=True, indent=2))
    return 0 if report['ok'] else 1


if __name__ == '__main__':
    raise SystemExit(main())
