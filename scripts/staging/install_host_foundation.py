#!/usr/bin/env python3
"""Lay the identity and PostgreSQL foundation on a fresh services host. Starts no Domino service.

The first services VM was built on 10 Sep 2026 by a private script that never
reached the repository. This is that script, reviewed. It creates the same
identities, socket directory, cluster settings, peer maps, roles and database,
with three corrections:

- the cluster is initialised UTF8 with the C locale (the original produced
  SQL_ASCII, which prepare_disabled.py refuses);
- the public schema keeps PostgreSQL 16's initial ACL, USAGE for PUBLIC. The
  original revoked it, but only in the SQL_ASCII database that was set aside on
  11 Sep; the UTF8 database prepare_disabled.py first ran against had the
  initial ACL, and its catalogue inventory checks for exactly that;
- nothing depends on the host's name.

It also creates /etc/domino (root, 0700), the private configuration root that
upgrade_financial.py's directories hang from and that the first VM had from its
first install day. That installer refuses a host without it.

It is step 1 of docs/FRESH_HOST_INSTALL.md. It proceeds only on a host with no
Domino identity, no cluster and no socket directory entry, and it leaves
exactly the state that prepare_disabled.py's preflight checks.

`--post-install` reproduces the two hand steps that followed the first release
install on the first VM. Run it right after prepare_disabled.py, the only
installer that checks the original group membership and schema ACL:

- the administrator's peer rows and socket group;
- the public schema's USAGE grant to PUBLIC, revoked (the hardened profile
  catalogue_inventory.py accepts once installed, #106).
"""
import argparse
import grp
import json
import os
from pathlib import Path
import pwd
import re
import stat
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prepare_disabled as install

require = install.require
DB_GROUP = 'domino-db'
# Identities that reach the database socket, and those that never do.
DB_IDENTITIES = ('domino-admin', 'domino-read', 'domino-write', 'domino-auth', 'domino-operator')
PLAIN_IDENTITIES = ('domino-gateway', 'domino-tunnel')
OPERATOR = 'domino'
CLUSTER = ('16', 'domino')
CONFIG = install.CONFIG
DATA = install.DATA
SOCKET = install.SOCKET
PRIVATE_ROOT = Path('/etc/domino')
TMPFILES = Path('/etc/tmpfiles.d/domino-postgresql.conf')
TMPFILES_TEXT = f'd {SOCKET} 0750 postgres {DB_GROUP} -\n'
ROLES = tuple(role for _, _, role in install.MAPPINGS)
CONF_TEXT = f"""listen_addresses = ''
unix_socket_directories = '{SOCKET}'
unix_socket_group = '{DB_GROUP}'
unix_socket_permissions = 0770
max_connections = 40
shared_buffers = '1GB'
effective_cache_size = '4GB'
work_mem = '8MB'
maintenance_work_mem = '128MB'
max_wal_size = '2GB'
min_wal_size = '256MB'
password_encryption = 'scram-sha-256'
fsync = on
full_page_writes = on
synchronous_commit = on
log_connections = off
log_disconnections = off
log_statement = 'none'
"""
HBA_TEXT = ''.join(' '.join(row) + '\n' for row in install.HBA)
IDENT_TEXT = ''.join(' '.join(row) + '\n' for row in install.MAPPINGS)
# The administrator reads, writes and runs DDL through the same peer map as
# the services, as on the first VM; it never becomes a service identity.
OPERATOR_ROWS = tuple(('domino', OPERATOR, role) for role in
                      (install.ADMIN, 'domino_catalogue_writer', 'domino_catalogue_reader'))
CREATE_SQL = ''.join(
    f'CREATE ROLE {role} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;\n'
    for role in ROLES) + (
    f"CREATE DATABASE {install.DB} OWNER {install.ADMIN} ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C' TEMPLATE template0;\n"
    f'REVOKE ALL ON DATABASE {install.DB} FROM PUBLIC;\n'
    f"GRANT CONNECT ON DATABASE {install.DB} TO {','.join(ROLES)};\n")
# PostgreSQL 16's initial ACL on the public schema, which prepare_disabled.py's inventory expects.
PUBLIC_SCHEMA_ACL = '{pg_database_owner=UC/pg_database_owner,=U/pg_database_owner}'
HARDENED_SCHEMA_ACL = '{pg_database_owner=UC/pg_database_owner}'
CREATECLUSTER = (['/usr/bin/pg_createcluster', '--port=8877', f'--socketdir={SOCKET}',
                  '--start-conf=manual', '--encoding=UTF8', '--locale=C', *CLUSTER,
                  '--', '--auth-local=peer', '--auth-host=reject', '--data-checksums'])


def exists(name, kind):
    try:
        (pwd.getpwnam if kind == 'user' else grp.getgrnam)(name)
        return True
    except KeyError:
        return False


def clusters():
    """Every PostgreSQL cluster on the host, as `version/name`."""
    output = install.run(['/usr/bin/pg_lsclusters', '--no-header']).decode()
    return sorted('/'.join(line.split()[:2]) for line in output.splitlines() if line.strip())


def preflight():
    """A fresh host: PostgreSQL 16 installed, and nothing of Domino's on it yet."""
    release = dict(line.split('=', 1) for line in Path('/etc/os-release').read_text().splitlines() if '=' in line)
    require(release.get('ID', '').strip('"') == 'ubuntu' and release.get('VERSION_ID', '').strip('"') == '24.04',
            'ubuntu_24_04_required')
    require((install.PG / 'initdb').is_file() and (install.PG / 'psql').is_file(), 'postgresql_16_missing')
    require(clusters() == [], 'postgresql_cluster_exists')
    require(not exists(DB_GROUP, 'group'), 'database_group_exists')
    for user in (*DB_IDENTITIES, *PLAIN_IDENTITIES):
        require(not exists(user, 'user') and not exists(user, 'group'), 'domino_identity_exists')
    require(exists(OPERATOR, 'user'), 'operator_account_missing')
    for path in (TMPFILES, CONFIG, DATA, Path(SOCKET)):
        require(not os.path.lexists(path), 'foundation_path_exists')
    return {'mode': 'host-foundation', 'cluster': '/'.join(CLUSTER), 'port': 8877, 'socket': SOCKET,
            'encoding': 'UTF8', 'locale': 'C', 'database': install.DB, 'roles': list(ROLES),
            'identities': {'database': list(DB_IDENTITIES), 'other': list(PLAIN_IDENTITIES)},
            'notPerformed': ['package installation', 'Domino release, unit or migration',
                             'service start other than postgresql@16-domino',
                             'operator peer access and schema hardening (--post-install)']}


def private_root(path=PRIVATE_ROOT, *, owner=0):
    """/etc/domino: root's alone, created if absent, as the later installers expect."""
    if not os.path.lexists(path):
        os.mkdir(path, 0o700)
    info = os.lstat(path)
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == owner, 'private_root_not_a_root_directory')
    os.chmod(path, 0o700)


def write_config(path, text, mode):
    """Replace one cluster file in place, owned by postgres like the rest."""
    account = pwd.getpwnam('postgres')
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as stream:
        os.fchown(stream.fileno(), account.pw_uid, account.pw_gid)
        os.fchmod(stream.fileno(), mode)
        stream.write(text.encode())
        stream.flush()
        os.fsync(stream.fileno())


def verify():
    """What prepare_disabled.py will check, read back from the running cluster."""
    socket = Path(SOCKET).lstat()
    require(stat.S_ISDIR(socket.st_mode) and stat.S_IMODE(socket.st_mode) == 0o750
            and socket.st_uid == pwd.getpwnam('postgres').pw_uid
            and socket.st_gid == grp.getgrnam(DB_GROUP).gr_gid, 'socket_directory_unexpected')
    members = sorted(grp.getgrnam(DB_GROUP).gr_mem)
    require(members == sorted((*DB_IDENTITIES, 'postgres')), 'database_group_members_unexpected')
    encoding = install.sql("SELECT pg_catalog.pg_encoding_to_char(encoding)||'/'||datcollate||'/'||datctype "
                           "FROM pg_catalog.pg_database WHERE datname=pg_catalog.current_database()")
    require(encoding == 'UTF8/C/C', 'database_encoding_unexpected')
    owner = install.sql('SELECT pg_catalog.pg_get_userbyid(datdba) FROM pg_catalog.pg_database '
                        'WHERE datname=pg_catalog.current_database()')
    require(owner == install.ADMIN, 'database_owner_unexpected')
    roles = json.loads(install.sql("SELECT pg_catalog.json_agg(rolname ORDER BY rolname) FROM pg_catalog.pg_roles "
                                   "WHERE rolname ~ '^domino_'"))
    require(roles == sorted(ROLES), 'database_roles_unexpected')
    require(install.sql('SHOW data_checksums') == 'on', 'data_checksums_off')
    acl = install.sql("SELECT nspacl FROM pg_catalog.pg_namespace WHERE nspname='public'")
    require(acl == PUBLIC_SCHEMA_ACL, 'public_schema_acl_unexpected')
    return {'ok': True, 'cluster': '/'.join(CLUSTER), 'databaseGroup': members, 'encoding': encoding,
            'next': 'prepare_disabled.py from the foundation release archive (docs/FRESH_HOST_INSTALL.md)'}


def apply(planned):
    require(os.geteuid() == 0, 'root_required')
    private_root()
    install.run(['/usr/sbin/groupadd', '--system', DB_GROUP])
    for user in (*DB_IDENTITIES, *PLAIN_IDENTITIES):
        groups = ['--groups', DB_GROUP] if user in DB_IDENTITIES else []
        install.run(['/usr/sbin/useradd', '--system', '--home-dir', f'/var/lib/{user}', '--create-home',
                     '--shell', '/usr/sbin/nologin', *groups, user])
        os.chmod(f'/var/lib/{user}', 0o700)
    install.exclusive_file(TMPFILES, TMPFILES_TEXT.encode(), 0o644)
    install.run(['/usr/sbin/usermod', '-a', '-G', DB_GROUP, 'postgres'])
    install.run(['/usr/bin/systemd-tmpfiles', '--create', str(TMPFILES)])
    install.run(CREATECLUSTER)
    write_config(CONFIG / 'conf.d/domino.conf', CONF_TEXT, 0o600)
    write_config(CONFIG / 'pg_hba.conf', HBA_TEXT, 0o600)
    write_config(CONFIG / 'pg_ident.conf', IDENT_TEXT, 0o600)
    install.run(['/usr/bin/systemctl', 'enable', '--now', 'postgresql@16-domino.service'])
    install.run(['/usr/sbin/runuser', '-u', 'postgres', '--', str(install.PG / 'psql'), '-X', '-w', '-q',
                 '-v', 'ON_ERROR_STOP=1', '-h', SOCKET, '-p', '8877', '-d', 'postgres', '-f', '-'],
                data=CREATE_SQL.encode())
    return {**planned, **verify()}


def post_install():
    """The administrator's peer access, then the public schema hardening."""
    require(os.geteuid() == 0, 'root_required')
    require(exists(OPERATOR, 'user'), 'operator_account_missing')
    schemas = install.sql("SELECT pg_catalog.count(*) FROM pg_catalog.pg_namespace "
                          "WHERE nspname IN ('domino_catalogue','domino_sessions')")
    require(schemas == '2', 'foundation_release_not_installed')
    acl = install.sql("SELECT nspacl FROM pg_catalog.pg_namespace WHERE nspname='public'")
    require(acl == PUBLIC_SCHEMA_ACL, 'public_schema_acl_unexpected')
    rows = install.normalized_config(CONFIG / 'pg_ident.conf')
    require(rows[:len(install.MAPPINGS)] == install.MAPPINGS, 'foundation_peer_map_changed')
    require(not any(row[:2] == ('domino', OPERATOR) for row in rows), 'operator_peer_rows_exist')
    require(OPERATOR not in grp.getgrnam(DB_GROUP).gr_mem, 'operator_already_in_database_group')
    original = (CONFIG / 'pg_ident.conf').read_bytes()
    text = original.decode() + ('' if original.endswith(b'\n') else '\n')
    write_config(CONFIG / 'pg_ident.conf', text + ''.join(' '.join(row) + '\n' for row in OPERATOR_ROWS), 0o600)
    require(install.sql('SELECT pg_catalog.pg_reload_conf()') == 't', 'postgresql_reload_failed')
    install.run(['/usr/sbin/usermod', '-a', '-G', DB_GROUP, OPERATOR])
    errors = install.sql('SELECT pg_catalog.count(*) FROM pg_catalog.pg_ident_file_mappings WHERE error IS NOT NULL')
    require(errors == '0', 'peer_map_invalid')
    # As superuser, performed as the schema's owner, so it removes exactly the owner's grant.
    install.sql('REVOKE USAGE ON SCHEMA public FROM PUBLIC;')
    acl = install.sql("SELECT nspacl FROM pg_catalog.pg_namespace WHERE nspname='public'")
    require(acl == HARDENED_SCHEMA_ACL, 'public_schema_not_hardened')
    return {'ok': True, 'mode': 'post-install', 'operator': OPERATOR,
            'roles': [row[2] for row in OPERATOR_ROWS], 'socketGroup': DB_GROUP,
            'publicSchemaAcl': acl}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument('--inspect', action='store_true')
    mode.add_argument('--apply', action='store_true')
    mode.add_argument('--post-install', action='store_true')
    args = parser.parse_args(argv)
    try:
        if args.post_install:
            result = post_install()
        else:
            planned = preflight()
            result = apply(planned) if args.apply else {**planned, 'ok': True, 'applied': False}
        print(json.dumps(result, indent=2))
        return 0
    except Exception as error:
        reason = str(error) if isinstance(error, ValueError) else type(error).__name__
        print(json.dumps({'ok': False, 'reason': reason,
                          'action': 'stop; inspect the host before any retry (a partial foundation is not resumed)'}))
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
