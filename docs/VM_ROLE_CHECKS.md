# Read-only staging role verification

`scripts/staging/check_roles.py` checks the PostgreSQL foundation after the
reviewed application migrations 001–014 have been applied. It does not provision
roles, run migrations, grant a wallet, change configuration, or start services.
Run it as root **on the target VM**, against its existing private Unix socket:

```sh
sudo python3.14 -B scripts/staging/check_roles.py
```

Defaults are `/run/postgresql-domino`, port `8877`, database
`domino_catalogue`. Only the socket and port can be selected explicitly:

```sh
sudo python3.14 -B scripts/staging/check_roles.py --socket /run/postgresql-domino --port 8877
```

The script requires `/usr/sbin/runuser`, `/usr/bin/env`, `/usr/bin/id`,
`/usr/bin/python3` and `/usr/bin/psql`, and the nine distinct, non-root OS identities below. Missing
identities or dependencies fail the check; they are never created automatically.

| OS identity | Permitted PostgreSQL identity |
| --- | --- |
| `domino-admin` | `domino_catalogue_admin` |
| `domino-read` | `domino_catalogue_reader` |
| `domino-write` | `domino_catalogue_writer` |
| `domino-auth` | `domino_session_auth` |
| `domino-onboarding` | `domino_session_auth` |
| `domino-deposit` | `domino_session_auth` and `domino_deposit_service` |
| `domino-operator` | `domino_wallet_access_operator` |
| `domino-gateway` | No socket directory access; none of the six application roles |
| `domino-tunnel` | No socket directory access; none of the six application roles |

It verifies the effective UID via `runuser`, then tests all **54** pairs in
this matrix. A positive connection must report the exact session/current SQL
user, database and read-only transaction mode. For users with socket access, a
denied pair passes only on an explicit peer/HBA rejection. Gateway/tunnel use
the earlier filesystem boundary: the canonical socket directory must be owned
by postgres:domino-db with mode0750 and the actual socket with mode0770. A child
under each effective UID checks its effective/supplementary socket-group
membership and the kernel's directory-traversal decision, including ACLs. Both
must deny gateway/tunnel and permit the other service identities.

Only after those checks can gateway/tunnel pass on libpq's exact `Permission
denied` error naming the selected socket file. This result is separately named
`socket_denied`; it does not claim HBA was reached. The 12 filesystem-denied
pairs remain in the 54-pair matrix. Generic permission errors, another socket
path, missing socket, missing database/role, timeout,
password authentication, missing OS user and arbitrary command failures cannot
masquerade as successful isolation. Environment credentials and `psqlrc` are
excluded; `PGPASSFILE=/dev/null` also disables per-user password files (libpq may
emit a harmless non-regular-password-file warning that is not printed), and
`psql -X --no-password` cannot prompt for a password.

The six SQL roles must be LOGIN, NOINHERIT, NOSUPERUSER, NOCREATEDB,
NOCREATEROLE, NOREPLICATION and NOBYPASSRLS, with no memberships in either
direction. The expected database, five schemas, 24 tables, admission audit
sequence and six functions must have the trusted DDL owner
`domino_catalogue_admin`. Unexpected/missing objects fail the inventory check.
Function security-definer flags and fixed search paths are checked. Only
`domino_deposits.intents` uses FORCE RLS in the deposit schema; its owner and
maintenance policies must match migrations 009/010/014, including maintenance
UPDATE visibility with `WITH CHECK (false)`.

The additional catalogue inventory covers **all nine schemas**: `pg_catalog`,
`pg_toast`, `information_schema`, `public` and the five Domino schemas. The first
three retain owner `postgres`; `public` retains `pg_database_owner`. Their complete
ACLs, and the database ACL, must match the known foundation, including PUBLIC,
grantor and grant option. For an installed database, exactly two complete schema
ACL profiles are accepted:

- `pg16_stock`: all 29 expected entries, including PUBLIC USAGE on `public`.
- `installed_public_usage_revoked`: the same entries except
  `(public, PUBLIC, USAGE, pg_database_owner, false)`, for 28 entries. The schema
  owner keeps its own CREATE/USAGE grants; every system/application schema grant,
  grantor and grant option remains identical to the stock profile.

The installed a5 database has the second, stricter profile. It was identified
during the disabled-upgrade inspection; the helper previously rejected it before
running the effective privilege/SELECT checks. This recognition does not grant
PUBLIC access or repair database state. The empty-foundation installer preflight
still accepts only `pg16_stock`. Neither entry point accepts arbitrary subsets,
duplicate entries or a changed grantor/owner/grant option. This helper change
requires its own review before another operational upgrade attempt; source
tests do not establish that the remaining VM checks have passed.

No unlisted role may receive a schema/database grant.
The DDL owner retains database CREATE/CONNECT/TEMPORARY; the five runtime roles
have CONNECT only. Additional schemas (including temporary schemas), schema
ownership changes, other missing privileges and extra grants all fail closed. Inspect
an unexpected entry before deciding whether the reviewed inventory should change;
the verifier does not repair it.

`pg_default_acl` must contain no rows in this database. The schema-local REVOKEs
in migrations 008/009/011 leave that catalogue empty; they do not require an
exception. `pg_db_role_setting` must contain no rows in the dedicated cluster,
including role-only, database-only, role-in-database, global and other-database
settings. This detects persistent trigger-bypass/search-path settings without
reading or printing their values. Per-connection `PGOPTIONS` used by the verifier
do not create persistent entries. Missing or malformed inventory also fails.
`pg_parameter_acl` must also be empty across the cluster. For example, granting
SET on `session_replication_role` can authorize trigger bypass without a persistent
setting. Any parameter ACL row fails; there is no runtime-role exception.
The shared inventory schema-qualifies catalogue relations and built-in functions;
the connection's fixed `pg_catalog` search path also applies. Owner-created
shadow views in `public` cannot replace the inspected catalogues.

Effective schema/table/function/sequence privileges and runtime grant options
are checked against the source's role matrix. In particular, the public reader
and writer cannot access sessions, admission or deposits; auth cannot grant
wallet access or access deposit storage; the operator can read admission and
execute its dedicated function but cannot read session secrets or write tables
directly. Deposit SELECT/INSERT/UPDATE and expiry EXECUTE remain separate from
direct DELETE or maintenance ownership. The verifier **never invokes**
`set_access`, `expire_unissued`, or any other application function.

Each permitted OS/SQL pair also attempts `SELECT count(*) FROM (SELECT 1 FROM
<fixed-table> LIMIT 0)` against a representative table in every schema. These
queries prove actual SELECT/schema permissions without retrieving or scanning
private rows. Metadata queries use only PostgreSQL catalogues and built-in
privilege helpers. Every connection has default read-only transactions,
2-second statement, 500-ms lock and 3-second idle/connect limits. A child has a
6-second wall-clock limit; the entire verification has a 120-second deadline.
Timeout cleanup kills the subprocess group. No SQL writes or fixtures are used,
including on failure.

Output is JSON with names, UIDs, booleans, counts and fixed failure categories.
It excludes raw database errors and private rows. Exit status `0` means every
check passed; status `1` means a failure or incomplete verification. Treat the
JSON as local operator evidence, not a health endpoint. PostgreSQL may record
the deliberately denied connection attempts in its own administrative log.

This is a point-in-time check of the listed OS users and six SQL application
roles, not every role/OS identity on the machine. It does not inspect HBA files,
firewall/TCP exposure, backups, providers, Cloudflare, session semantics, token
admission, or migration function bodies. Read-only ACL checks cannot establish
that an actual write, trigger or financial recovery succeeds. Keep listeners
and ingress disabled until the other staging gates pass; use the full isolated
PG/EVM suite for behavioral validation rather than staging fixtures.
Run this file together with its reviewed `catalogue_inventory.py` helper.
Keep `-B` in root commands so imports do not write bytecode into that helper copy.
[Hardening tests and remaining host checks](STAGING_VERIFIER_HARDENING.md)
describe how the added inventory is tested without accessing staging.
