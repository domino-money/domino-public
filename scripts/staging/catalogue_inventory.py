"""Read-only catalogue inventory for the fixed PostgreSQL staging foundation.

The expected ACL is explicit, including PUBLIC, grantor and grant options. This
does not grant, revoke, reset settings, or inspect setting values/private rows.
"""

ADMIN = 'domino_catalogue_admin'
READER = 'domino_catalogue_reader'
WRITER = 'domino_catalogue_writer'
AUTH = 'domino_session_auth'
OPERATOR = 'domino_wallet_access_operator'
DEPOSIT = 'domino_deposit_service'
SCHEMA_USERS = {
    'domino_catalogue': (READER, WRITER),
    'domino_activity': (READER, WRITER),
    'domino_sessions': (AUTH,),
    'domino_wallet_access': (AUTH, OPERATOR),
    'domino_deposits': (DEPOSIT,),
}

# pg_db_role_setting is cluster-wide. This dedicated cluster has no persistent
# role/database overrides, including global, another database, or another role.
# The schema-local default REVOKEs in 008/009/011 leave no pg_default_acl rows.
NO_PERSISTENT_OVERRIDES = """NOT EXISTS (SELECT FROM pg_default_acl)
 AND NOT EXISTS (SELECT FROM pg_db_role_setting)"""


def inventory_sql():
    """Counts are untruncated; bounded lists fail closed on excess inventory."""
    return """SELECT json_build_object(
 'defaultAclCount',(SELECT count(*) FROM pg_default_acl),
 'roleSettingCount',(SELECT count(*) FROM pg_db_role_setting),
 'schemas',(SELECT json_agg(row_to_json(s)) FROM
   (SELECT nspname AS name,pg_get_userbyid(nspowner) AS owner
    FROM pg_namespace ORDER BY nspname LIMIT 65) s),
 'databaseAcl',(SELECT json_agg(json_build_array(
    CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
    a.privilege_type,pg_get_userbyid(a.grantor),a.is_grantable))
   FROM (SELECT a.* FROM pg_database d,
    aclexplode(COALESCE(d.datacl,acldefault('d',d.datdba))) a
    WHERE d.datname=current_database() ORDER BY a.grantee,a.privilege_type,a.grantor LIMIT 129) a),
 'schemaAcl',(SELECT json_agg(json_build_array(s.name,
    CASE WHEN s.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(s.grantee) END,
    s.privilege_type,pg_get_userbyid(s.grantor),s.is_grantable))
   FROM (SELECT n.nspname AS name,a.* FROM pg_namespace n,
    aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) a
    ORDER BY n.nspname,a.grantee,a.privilege_type,a.grantor LIMIT 257) s));"""


def exact_rows(actual, expected):
    # Compare a multiset, not just a set: duplicates and malformed/missing
    # metadata must not hide an incomplete catalogue response.
    return (isinstance(actual, list) and len(actual) == len(expected)
            and all(isinstance(row, list) and len(row) > 0 and type(row[-1]) is bool
                    and all(isinstance(value, str) for value in row[:-1])
                    and tuple(row) in expected for row in actual)
            and len({tuple(row) for row in actual}) == len(expected))


def check_inventory(data, *, installed):
    """Known Ubuntu PG16 foundation, before or after migrations 001–014."""
    if not isinstance(data, dict):
        data = {}
    owners = {'pg_catalog': 'postgres', 'pg_toast': 'postgres',
              'information_schema': 'postgres', 'public': 'pg_database_owner'}
    if installed:
        owners.update({name: ADMIN for name in SCHEMA_USERS})
    schema_acl = set()
    for name, owner in owners.items():
        schema_acl.update((name, owner, privilege, owner, False) for privilege in ('USAGE', 'CREATE'))
        if name in ('pg_catalog', 'information_schema', 'public'):
            schema_acl.add((name, 'PUBLIC', 'USAGE', owner, False))
        if name in SCHEMA_USERS:
            schema_acl.update((name, role, 'USAGE', owner, False) for role in SCHEMA_USERS[name])
    roles = (ADMIN, READER, WRITER, AUTH, OPERATOR) + ((DEPOSIT,) if installed else ())
    database_acl = {(role, 'CONNECT', ADMIN, False) for role in roles}
    database_acl.update((ADMIN, privilege, ADMIN, False) for privilege in ('CREATE', 'TEMPORARY'))
    schemas = data.get('schemas')
    return {
        'noDefaultAclOverrides': type(data.get('defaultAclCount')) is int and data['defaultAclCount'] == 0,
        'noPersistentRoleDatabaseSettings': type(data.get('roleSettingCount')) is int and data['roleSettingCount'] == 0,
        'completeSchemaInventory': isinstance(schemas, list) and len(schemas) == len(owners)
            and all(isinstance(s, dict) and set(s) == {'name', 'owner'}
                    and s['name'] in owners and s['owner'] == owners[s['name']] for s in schemas)
            and {s['name'] for s in schemas} == set(owners),
        'completeSchemaAcl': exact_rows(data.get('schemaAcl'), schema_acl),
        'completeDatabaseAcl': exact_rows(data.get('databaseAcl'), database_acl),
    }
