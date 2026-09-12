#!/usr/bin/env python3
"""Default-OFF dev SQL profile: sanitized inspection and matched SQL generation only.

No database client, credentials, installer, role mutation or host access runs here.
The generated SQL requires a separately approved cluster-superuser transport.
Production verifiers are intentionally unchanged: deprovision this exact profile
before using their old upgrade paths. No private data is selected by inspection.
"""
import argparse
from copy import deepcopy
import hashlib
import json
from pathlib import Path

import catalogue_inventory as inventory
import check_roles as production


ROLE = 'domino_dev_catalogue_reader'
DATABASE = 'domino_catalogue'
OWNER = inventory.ADMIN
PUBLIC_SCHEMAS = ('domino_catalogue', 'domino_activity')
TABLES = tuple(f'{schema}.{table}' for schema in PUBLIC_SCHEMAS for table in production.TABLES[schema])
DEV_USERS = {'domino-dev-read': (974, 974), 'domino-dev-gateway': (975, 975),
             'domino-dev-tunnel': (976, 976)}
PEERS = {**production.PEERS, **{name: (ROLE,) if name == 'domino-dev-read' else () for name in DEV_USERS}}
PEER_ADDITIONS = {'ident': ('domino', 'domino-dev-read', ROLE),
                  'hba': ('local', DATABASE, ROLE, 'peer', 'map=domino')}
MAX_SNAPSHOT_BYTES = 262144


def literal(value):
    return "'" + value.replace("'", "''") + "'"


def scalar(sql):
    return '(' + sql.strip().removesuffix(';') + ')'


def json_literal(value):
    return literal(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)) + '::jsonb'


def expected_dev_state():
    return {'role': {'name': ROLE, 'login': True, 'restricted': True, 'connectionLimit': 1,
                     'passwordUnset': True, 'validUntil': None}, 'memberships': 0,
            'dependencies': sorted([['database', DATABASE, 'a']]
                + [['schema', name, 'a'] for name in PUBLIC_SCHEMAS]
                + [['relation', name, 'a'] for name in TABLES]),
            'grants': sorted([[kind, name, privilege, OWNER, False]
                for kind, names, privilege in (('database', (DATABASE,), 'CONNECT'),
                    ('schema', PUBLIC_SCHEMAS, 'USAGE'), ('relation', TABLES, 'SELECT')) for name in names])}


def dev_acl_sql():
    """Effective rights as well as raw ACLs: inherited/PUBLIC rights must not help."""
    rows = []
    def add(name, expression, expected=False):
        rows.append(f'({literal(name)},({expression}) IS NOT DISTINCT FROM {str(expected).lower()})')
    for schema, tables in production.TABLES.items():
        for privilege in ('USAGE', 'CREATE'):
            add(f'schema:{schema}:{privilege}', f"has_schema_privilege('{ROLE}','{schema}','{privilege}')",
                schema in PUBLIC_SCHEMAS and privilege == 'USAGE')
            add(f'schemaGrant:{schema}:{privilege}',
                f"has_schema_privilege('{ROLE}','{schema}','{privilege} WITH GRANT OPTION')")
        for table in tables:
            for privilege in production.PRIVILEGES:
                name = schema + '.' + table
                add(f'table:{name}:{privilege}', f"has_table_privilege('{ROLE}','{name}','{privilege}')",
                    schema in PUBLIC_SCHEMAS and privilege == 'SELECT')
                add(f'tableGrant:{name}:{privilege}',
                    f"has_table_privilege('{ROLE}','{name}','{privilege} WITH GRANT OPTION')")
    for function in production.FUNCTIONS:
        add('function:' + function, f"has_function_privilege('{ROLE}','{function}','EXECUTE')")
    for privilege in ('USAGE', 'SELECT', 'UPDATE'):
        add('sequence:' + privilege, f"has_sequence_privilege('{ROLE}','domino_wallet_access.audit_id_seq','{privilege}')")
    for privilege in ('CONNECT', 'CREATE', 'TEMPORARY'):
        add('database:' + privilege, f"has_database_privilege('{ROLE}','{DATABASE}','{privilege}')", privilege == 'CONNECT')
    add('publicSchema:CREATE', f"has_schema_privilege('{ROLE}','public','CREATE')")
    return ("SELECT jsonb_build_object('checks',count(*),'failures',COALESCE("
            "jsonb_agg(name ORDER BY name) FILTER (WHERE NOT ok),'[]'::jsonb)) FROM (VALUES "
            + ','.join(rows) + ') AS checks(name,ok)')


def dev_state_sql():
    # pg_shdepend is cluster-wide and detects extra ownership, grants, columns,
    # memberships/default ACL dependencies and rights in other databases too.
    return f"""SELECT jsonb_build_object(
 'role',(SELECT jsonb_build_object('name',rolname,'login',rolcanlogin,
   'restricted',NOT(rolsuper OR rolinherit OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls),
   'connectionLimit',rolconnlimit,'passwordUnset',rolpassword IS NULL,'validUntil',rolvaliduntil)
   FROM pg_authid WHERE rolname='{ROLE}'),
 'memberships',(SELECT count(*) FROM pg_auth_members WHERE roleid=to_regrole('{ROLE}')
   OR member=to_regrole('{ROLE}') OR grantor=to_regrole('{ROLE}')),
 'grants',COALESCE((SELECT jsonb_agg(value ORDER BY value) FROM (
   SELECT jsonb_build_array(kind,name,privilege_type,pg_get_userbyid(grantor),is_grantable) AS value
   FROM ({raw_acl_sql()}) a WHERE grantee=to_regrole('{ROLE}') OR grantor=to_regrole('{ROLE}')
 ) g),'[]'::jsonb),
 'dependencies',COALESCE((SELECT jsonb_agg(value ORDER BY value) FROM (
   SELECT CASE
     WHEN d.dbid=0 AND d.classid='pg_database'::regclass AND d.objsubid=0
       THEN jsonb_build_array('database',(SELECT datname FROM pg_database WHERE oid=d.objid),d.deptype)
     WHEN d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND d.objsubid=0
       AND d.classid='pg_namespace'::regclass
       THEN jsonb_build_array('schema',(SELECT nspname FROM pg_namespace WHERE oid=d.objid),d.deptype)
     WHEN d.dbid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND d.objsubid=0
       AND d.classid='pg_class'::regclass
       THEN jsonb_build_array('relation',(SELECT n.nspname||'.'||c.relname FROM pg_class c
         JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=d.objid),d.deptype)
     ELSE jsonb_build_array('unexpected',d.dbid,d.classid,d.objid,d.objsubid,d.deptype) END AS value
   FROM pg_shdepend d WHERE d.refclassid='pg_authid'::regclass AND d.refobjid=to_regrole('{ROLE}')
 ) deps),'[]'::jsonb))"""


def raw_acl_sql():
    return """SELECT 'database' AS kind,d.datname::text AS name,a.*
 FROM pg_database d CROSS JOIN LATERAL aclexplode(d.datacl) a
 UNION ALL SELECT 'schema',n.nspname::text,a.* FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
 UNION ALL SELECT 'relation',n.nspname||'.'||c.relname,a.* FROM pg_class c
 JOIN pg_namespace n ON n.oid=c.relnamespace CROSS JOIN LATERAL aclexplode(c.relacl) a
 UNION ALL SELECT 'column',n.nspname||'.'||c.relname||'.'||att.attname,a.* FROM pg_attribute att
 JOIN pg_class c ON c.oid=att.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 CROSS JOIN LATERAL aclexplode(att.attacl) a
 UNION ALL SELECT 'function',n.nspname||'.'||p.proname||'('||oidvectortypes(p.proargtypes)||')',a.*
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace CROSS JOIN LATERAL aclexplode(p.proacl) a"""


def snapshot_sql():
    """Cluster-admin metadata only; output contains no passwords, config values or tenant rows.

    The three exact new database/schema rows and fifteen table rows are removed
    only from the baseline comparison. Their full identities/rights/grantors are
    checked independently in devState; no unknown dev grants are subtracted.
    """
    schema_additions = [list((s, ROLE, 'USAGE', OWNER, False)) for s in PUBLIC_SCHEMAS]
    db_addition = [ROLE, 'CONNECT', OWNER, False]
    inv = f"""SELECT doc || jsonb_build_object(
 'schemaAcl',(SELECT jsonb_agg(v ORDER BY v) FROM jsonb_array_elements(doc->'schemaAcl') v
   WHERE v NOT IN ({','.join(json_literal(x) for x in schema_additions)})),
 'databaseAcl',(SELECT jsonb_agg(v ORDER BY v) FROM jsonb_array_elements(doc->'databaseAcl') v
   WHERE v<>{json_literal(db_addition)})) FROM (SELECT {scalar(inventory.inventory_sql())}::jsonb AS doc) i"""
    # Capture original object ACLs too: effective checks alone cannot see an
    # unrelated grantor or an additional grantee that already had equivalent rights.
    app_schemas = ','.join(literal(s) for s in production.TABLES)
    additions = [['relation', name, ROLE, 'SELECT', OWNER, False] for name in TABLES]
    object_acl = f"""SELECT COALESCE(jsonb_agg(value ORDER BY value),'[]'::jsonb) FROM (
 SELECT jsonb_build_array(kind,name,CASE WHEN grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(grantee) END,
   privilege_type,pg_get_userbyid(grantor),is_grantable) AS value
 FROM ({raw_acl_sql()}) a WHERE kind IN ('relation','column','function')
   AND split_part(name,'.',1) IN ({app_schemas})
 ) a WHERE value NOT IN ({','.join(json_literal(x) for x in additions)})"""
    acls = ','.join(literal(r) + ',' + scalar(production.acl_sql(r)) for r in production.ROLES)
    return f"""SELECT jsonb_build_object('version',1,'database',current_database(),
 'inventory',{scalar(inv)},'metadata',{scalar(production.metadata_sql())},
 'productionAcl',jsonb_build_object({acls}),'objectAcl',{scalar(object_acl)},
 'devState',{scalar(dev_state_sql())},
 'devAcl',CASE WHEN to_regrole('{ROLE}') IS NULL THEN NULL ELSE {scalar(dev_acl_sql())} END);"""


def check_snapshot(data, *, dev_present=False):
    if type(dev_present) is not bool or not isinstance(data, dict) or set(data) != {
            'version','database','inventory','metadata','productionAcl','objectAcl','devState','devAcl'}:
        raise ValueError('invalid_dev_catalogue_snapshot')
    try:
        valid = (data['version'] == 1 and type(data['version']) is int and data['database'] == DATABASE
                 and all(inventory.check_inventory(data['inventory'], installed=True).values())
                 and all(production.check_metadata(data['metadata']).values())
                 and set(data['productionAcl']) == set(production.ROLES)
                 and all(type(x['checks']) is int and x['checks'] == production.acl_sql(role).count('IS NOT DISTINCT FROM')
                         and x['failures'] == [] for role,x in data['productionAcl'].items())
                 and isinstance(data['objectAcl'], list) and len(data['objectAcl']) <= 1024)
        expected = expected_dev_state() if dev_present else {
            'role': None, 'memberships': 0, 'dependencies': [], 'grants': []}
        state = deepcopy(data['devState'])
        for field in ('grants', 'dependencies'):
            state[field] = sorted(state[field])
        valid = valid and state == expected
        acl = data['devAcl']
        valid = valid and (isinstance(acl, dict) and type(acl['checks']) is int
                           and acl['checks'] == dev_acl_sql().count('IS NOT DISTINCT FROM')
                           and acl['failures'] == [] if dev_present else acl is None)
    except (KeyError, TypeError, ValueError, AttributeError):
        valid = False
    if not valid:
        raise ValueError('dev_catalogue_snapshot_mismatch')
    if len(json.dumps(data, allow_nan=False).encode()) > MAX_SNAPSHOT_BYTES:
        raise ValueError('dev_catalogue_snapshot_too_large')
    return True


def _guard(expected):
    body = f"""BEGIN
 IF (SELECT rolsuper FROM pg_roles WHERE rolname=session_user) IS NOT TRUE OR current_user<>session_user
 THEN RAISE EXCEPTION 'cluster_admin_required'; END IF;
 IF EXISTS(SELECT FROM pg_stat_activity WHERE usename='{ROLE}')
 THEN RAISE EXCEPTION 'dev_catalogue_sessions_active'; END IF;
 IF {scalar(snapshot_sql())} IS DISTINCT FROM {json_literal(expected)}
 THEN RAISE EXCEPTION 'dev_catalogue_state_drift'; END IF;
END"""
    marker = '$domino_' + hashlib.sha256(body.encode()).hexdigest() + '$'
    return f'DO {marker}{body}{marker};\n'


def build_sql(baseline):
    """Pure generation. Does not execute SQL; no repair/force mode exists."""
    check_snapshot(baseline)
    after = deepcopy(baseline)
    after['devState'] = expected_dev_state()
    # PostgreSQL jsonb arrays sort by element count then contents. Serialize the
    # exact same ordering here by sorting our fixed equal-length row shapes.
    after['devState']['grants'] = sorted(after['devState']['grants'])
    after['devState']['dependencies'] = sorted(after['devState']['dependencies'])
    # Count generated assertions, not a caller-supplied qualification flag.
    after['devAcl'] = {'checks': dev_acl_sql().count('IS NOT DISTINCT FROM'), 'failures': []}
    check_snapshot(after, dev_present=True)
    start = ("BEGIN;\nSET LOCAL search_path=pg_catalog;\nSET LOCAL standard_conforming_strings=on;\n"
             "SET LOCAL lock_timeout='1000ms';\nSET LOCAL statement_timeout='5000ms';\n")
    grants = f"SET LOCAL ROLE {OWNER};\nGRANT CONNECT ON DATABASE {DATABASE} TO {ROLE};\n"
    grants += f"GRANT USAGE ON SCHEMA {','.join(PUBLIC_SCHEMAS)} TO {ROLE};\n"
    grants += f"GRANT SELECT ON TABLE {','.join(TABLES)} TO {ROLE};\nRESET ROLE;\n"
    revoke = f"SET LOCAL ROLE {OWNER};\nREVOKE SELECT ON TABLE {','.join(TABLES)} FROM {ROLE};\n"
    revoke += f"REVOKE USAGE ON SCHEMA {','.join(PUBLIC_SCHEMAS)} FROM {ROLE};\n"
    revoke += f"REVOKE CONNECT ON DATABASE {DATABASE} FROM {ROLE};\nRESET ROLE;\nDROP ROLE {ROLE};\n"
    create = (f'CREATE ROLE {ROLE} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE '
              'NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 1 PASSWORD NULL;\n')
    return {'version': 1, 'profile': 'dev_catalogue_off_v1', 'role': ROLE,
            'baselineSha256': hashlib.sha256(json.dumps(baseline, sort_keys=True).encode()).hexdigest(),
            'applySql': start + _guard(baseline) + create + grants + _guard(after) + 'COMMIT;\n',
            'rollbackSql': start + _guard(after) + revoke + _guard(baseline) + 'COMMIT;\n',
            'expectedAfter': after, 'peerAdditions': PEER_ADDITIONS}


def check_peer_evidence(proof):
    """Validate complete read-only host evidence; this function never collects it.

    The collector must prove effective UID/GID/groups and actual peer decisions,
    using the established check_roles command/socket semantics. A generated plan
    or mocked pass is not host evidence. Gateway/tunnel have no socket traversal.
    """
    try:
        if not isinstance(proof, dict) or set(proof) != {'users','peerMatrix','selectChecks','ident','hba'}:
            return False
        if proof['ident'] != list(PEER_ADDITIONS['ident']) or proof['hba'] != list(PEER_ADDITIONS['hba']):
            return False
        users = proof['users']
        if not isinstance(users, dict) or set(users) != set(PEERS):
            return False
        uids = [v['uid'] for v in users.values()]
        if len(set(uids)) != len(uids) or any(type(v) is not int or v <= 0 for v in uids):
            return False
        for name, row in users.items():
            allowed = bool(PEERS[name])
            if (row['canTraverse'] is not allowed or type(row['gid']) is not int or row['gid'] <= 0
                    or (988 in row['groups']) != allowed):
                return False
            if name in DEV_USERS and (row['uid'], row['gid']) != DEV_USERS[name]:
                return False
            if name in DEV_USERS and sorted(row['groups']) != sorted([row['gid']] + ([988] if allowed else [])):
                return False
        roles = (*production.ROLES, ROLE)
        expected = {(user, role): ('allowed' if role in permitted else 'peer_denied' if permitted else 'socket_denied')
                    for user, permitted in PEERS.items() for role in roles}
        rows = proof['peerMatrix']
        if (len(rows) != len(expected) or len({(r['osUser'],r['sqlRole']) for r in rows}) != len(expected)
                or any(r['result'] != expected.get((r['osUser'],r['sqlRole'])) for r in rows)):
            return False
        expected_select = {(user, role, schema): ('allowed' if
            (schema in PUBLIC_SCHEMAS if role == ROLE else production.allowed_table(role, schema + '.' + tables[0], 'SELECT'))
            else 'privilege_denied') for user, permitted in PEERS.items() for role in permitted
            for schema,tables in production.TABLES.items()}
        rows = proof['selectChecks']
        return (len(rows) == len(expected_select)
                and len({(r['osUser'],r['sqlRole'],r['schema']) for r in rows}) == len(expected_select)
                and all(r['result'] == expected_select.get((r['osUser'],r['sqlRole'],r['schema'])) for r in rows))
    except (KeyError, TypeError, ValueError):
        return False


def load_baseline(raw):
    if not isinstance(raw, bytes) or len(raw) > MAX_SNAPSHOT_BYTES:
        raise ValueError('dev_catalogue_snapshot_too_large')
    def pairs(items):
        result = {}
        for key, value in items:
            if key in result:
                raise ValueError('duplicate_snapshot_key')
            result[key] = value
        return result
    def constant(_):
        raise ValueError('nonfinite_snapshot_value')
    return json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, allow_abbrev=False)
    modes = parser.add_mutually_exclusive_group(required=True)
    modes.add_argument('--snapshot-sql', action='store_true')
    modes.add_argument('--baseline', type=Path, help='sanitized inspected JSON; generates SQL only')
    args = parser.parse_args(argv)
    if args.snapshot_sql:
        print("BEGIN READ ONLY; SET LOCAL search_path=pg_catalog; SET LOCAL statement_timeout='5000ms';")
        print(snapshot_sql())
        print('ROLLBACK;')
    else:
        with args.baseline.open('rb') as file:
            raw = file.read(MAX_SNAPSHOT_BYTES + 1)
        print(json.dumps(build_sql(load_baseline(raw)), sort_keys=True, indent=2))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
