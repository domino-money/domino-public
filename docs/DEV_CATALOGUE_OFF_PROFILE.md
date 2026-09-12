# Default-OFF development catalogue role

Issue #132's SQL candidate is a generator and verifier, not an installer. It
does not contact PostgreSQL, alter the VM, install peer mappings or start dev
services. Public read contracts and all production scripts remain unchanged.

`scripts/staging/dev_catalogue_profile.py` defines exactly
`domino_dev_catalogue_reader`: LOGIN, NOINHERIT, connection limit 1, no password,
no expiry or persistent role settings, and no elevated role attributes. Its
only explicit grants are database CONNECT, USAGE on `domino_catalogue` and
`domino_activity`, and SELECT on their fifteen existing tables. It receives no
default grants, sequences, functions, ownership, memberships or private-schema
rights. The original object owner remains the grantor.

The matching OS identity is `domino-dev-read`, UID/GID 974, with only its own
group and `domino-db` GID 988. `domino-dev-gateway` 975 and `domino-dev-tunnel`
976 have only their own groups and cannot traverse the database socket
directory. The only proposed peer additions, inserted before existing reject
rules and preserving every original rule, are:

```text
# pg_ident.conf
domino domino-dev-read domino_dev_catalogue_reader
# pg_hba.conf
local domino_catalogue domino_dev_catalogue_reader peer map=domino
```

These are plans, not proof of effective authentication. The infrastructure
candidate must preserve the complete existing file inventory and supply actual
UID/GID/group/socket checks plus every old-and-new user/role peer result.
`check_peer_evidence()` verifies the complete matrix, including old private
denials, cross-role impersonation refusal and dev gateway/tunnel socket denial.
Its input schema is exercised by `peer_evidence()` in the focused test file;
fixtures are never live-host evidence. PostgreSQL's own system-catalogue/PUBLIC
defaults are not a private-tenant grant; the exact database-specific HBA mapping
still denies connections to other databases. No browser or Windows process
receives a DSN or direct database access.

## Pure preparation

From a trusted checkout, the following only prints read-only inspection SQL:

```sh
python3 -B scripts/staging/dev_catalogue_profile.py --snapshot-sql
```

A future, separately approved operator step must execute that SQL through an
authenticated **cluster-superuser** connection to `domino_catalogue`, returning
only sanitized catalogue/ACL metadata. That transport is deliberately not
packaged here. `domino_catalogue_admin` lacks CREATEROLE and must not be assumed
able to create this role. No password, configuration value or tenant row is
selected; `pg_authid` supplies only whether the dev password is absent.

After saving and reviewing that bounded JSON snapshot locally:

```sh
python3 -B scripts/staging/dev_catalogue_profile.py --baseline baseline.json
```

The command prints a plan containing `applySql`, `rollbackSql`, the baseline
digest and `expectedAfter`. It never executes them. The snapshot must pass the
existing production inventory, metadata and all effective ACL checks. The SQL
then compares the actual complete captured state inside a transaction before
any mutation. Raw object ACLs preserve original grantees and grantors beyond
the effective-rights checks. The expected post-state allows only this role's
exact grants; cluster-wide shared dependencies reject additional ownership or
privileges in other databases. Only the known dev additions are subtracted
from baseline comparisons, and their full rights/grantors are checked separately.

Creation runs as cluster admin; `SET LOCAL ROLE domino_catalogue_admin` issues
the grants as the existing object owner. Both directions perform a final exact
state comparison before COMMIT. Failure rolls back the whole SQL transaction.
There is no CASCADE, table/data deletion, password setup, ALTER DEFAULT
PRIVILEGES, automatic repair or role/database setting override.

## Rollback and the old-upgrade boundary

Keep dev ingress and all dev services OFF throughout preparation. A future
cutover must separately qualify authentication, resource budgets and peer
configuration; creating a LOGIN role alone does not authorize activation.

Before rollback, stop/drain the dev lane and remove only its exact known peer
additions using the infrastructure candidate's guarded file restoration, so no
new dev connection can race deprovisioning. The SQL refuses any active dev
session or unknown state and revokes only the eighteen known grants before
dropping the role. It does not terminate sessions or revoke unrelated grants.
If drift exists, inspect it; do not regenerate a permissive snapshot to force
removal. The preserved matched rollback returns the initial SQL state.

The old production `catalogue_inventory.py` and `check_roles.py` deliberately
reject the additional dev grants. Existing upgrade wrappers therefore require
this matched deprovision, removal of the dev peer additions, and their normal
production verification before use. A future explicitly integrated dev-aware
upgrade path can replace this temporary boundary; this candidate does not
silently widen any old guard. The per-statement/aggregate deadline adapter and
dev ingress units are separate #132 work and are not implemented by SQL role
settings here.

## Validation

```sh
python3 -B -m unittest discover -s scripts/staging/tests -p test_dev_catalogue_profile.py -v
DOMINO_TEST_STAGING_POSTGRES=1 DOMINO_PG_BIN=/path/to/pg16/bin \
  python3 -B -m unittest discover -s scripts/staging/tests -p test_dev_catalogue_profile.py -v
```

The opt-in suite reuses only the established fixture lifecycle: a unique
temporary cluster, private Unix socket, TCP disabled, exact migrations 001–014,
and cleanup that stops/removes only that cluster. Actual SQL cases prove grantor
identity, private SELECT denials, connection-limit enforcement, active-session
rollback refusal, exact successful rollback and no-write refusal of baseline,
role, membership, setting, extra-privilege and foreign-grantor drift. Local PG18
results do not substitute for PG16 CI or Linux peer/socket acceptance. The PG16
CI job includes this opt-in test pattern alongside the existing isolated
PostgreSQL step. The default test invocation intentionally skips those six
database cases.
