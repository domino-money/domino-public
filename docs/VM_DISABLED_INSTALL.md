# One-time disabled VM installation

`scripts/staging/prepare_disabled.py` is a reviewable installer for the existing
Ubuntu 24.04 / PostgreSQL 16 staging foundation. It is a separate step from the
[home VM runbook](HOME_VM_RUNBOOK.md). It does not access the VM itself. The
default command validates the trusted archive and prints a JSON plan without
writing files, inspecting the host or contacting PostgreSQL. `--apply` is an
explicit root-only operation on the already provisioned VM.

The selected archive is producer candidate
`a5a855cec1fc5d120d9c1c187a84ff24bc1b02d6`, based on PR #46
`4d008a8a6fa520d31a915f796374ea1b152764b5`, with the legacy v1 receipt fix and
a test-only upload-deadline correction. Its contract packages are read
1.1.0-rc.3, session 3.0.0-rc.2, onboarding 1.0.0 and deposit 1.1.0-rc.4.
The [handoff](STAGING_BACKEND_HANDOFF.md) records the exact manifest digests.
Installing disabled services does not approve that candidate, satisfy consumer
ACKs or authorize financial execution.

## Review and input

Generate a **plain tar** from the exact reviewed Git commit, without a prefix:

```sh
git archive --format=tar --output=source.tar a5a855cec1fc5d120d9c1c187a84ff24bc1b02d6
sha256sum source.tar
python3 scripts/staging/prepare_disabled.py \
  --archive source.tar \
  --archive-sha256 cddc956efc28a0954eb52388c7e26541f5de0d2191998adcd61bbb5db5e5a562 \
  --commit a5a855cec1fc5d120d9c1c187a84ff24bc1b02d6
```

That hash identifies the prepared 11,018,240-byte archive. Verify its provenance
independently; the Git tar commit header is a consistency check, not a signature.
Review the installer from its own pinned commit as well. Keep the archive and
the complete `scripts/staging/` helper set from that commit in operator-controlled
storage; the installer imports `catalogue_inventory.py` from that directory.
For a later reviewed release, provide
its actual commit/hash and reassess the plan rather than reusing these values.
The installer accepts only regular files and directories, with bounded size and
member counts; it rejects traversal, duplicate paths, links, special files,
sparse files and embedded runtime/dependency/Git directories. Only the explicit
001–014 migration list is eligible; `backend/schema.sql` is never applied.

After independent review, run the same command locally on the VM as root with
`--apply`. Do not add `--enable`, start services or supply credentials to this
installer. It has no SSH, install-package, start-service or upgrade option.

## Required foundation and preflight

The fixed target is cluster 16/domino, database `domino_catalogue`, owner
`domino_catalogue_admin`, Unix socket `/run/postgresql-domino:8877`, no TCP,
socket directory0750 and socket0770 owned by postgres:domino-db. PG data is
`/var/lib/postgresql/16/domino`; configuration is`/etc/postgresql/16/domino`.
HBA and ident must match the exact known peer/reject rules, be postgres-owned
regular0600 files and parse without errors. No arbitrary mapping, trust fallback
or extra SQL membership is accepted. PUBLIC has no database privileges; existing
runtime roles have CONNECT only. Existing five Domino roles must be LOGIN,
NOINHERIT and lack administrative privileges. The DB must have no user objects,
non-default extensions, large objects or other connected clients.
Preflight compares the complete database and schema ACL inventory, including
PUBLIC, grantors and grant options. Only the three PostgreSQL system schemas and
`public` may exist before installation. No `pg_default_acl` entries in this DB
or `pg_db_role_setting` entries anywhere in the dedicated cluster are accepted.
The empty-database guard repeats the override checks in the migration transaction.
An unexpected entry stops installation; it is never reset or revoked automatically.
Both database and server encoding must be `UTF8`. `SQL_ASCII` is rejected before
backup or application changes: psycopg otherwise returns text as bytes, breaking catalogue
checkpoint/hash comparisons and JSON responses. Do not relabel an existing
database's encoding; use a separately backed-up, verified migration if needed.

The existing OS identities are domino-admin/read/write/auth/operator/gateway/
tunnel and postgres; only admin/read/write/auth/operator/postgres belong to
domino-db. Each account must have its own same-named primary group. No app unit,
release, current symlink, target listener or partial installation may exist.
The installer uses an exclusive root-owned lock to serialize attempts.

`/opt/domino/backend-venv/bin/python3.14` and its code/dependencies must be
root-owned and unwritable by service users. Installed distribution versions must
exactly match`backend/requirements-api.lock`; pip/setuptools/wheel are separate
packaging tools, not application dependencies. `pip check` must succeed. Nothing
is installed or upgraded. Directory symlinks leaving this venv are refused;
root-controlled interpreter links are allowed.

## Applied changes

Before application changes, the installer creates
`/var/backups/domino-disabled/<commit>` as a private root0700 directory. It saves
the PG config files and`postgresql.auto.conf`, original uid/gid/mode metadata,
settings, plan and a custom-format dump of the empty database. Backup files are
root0600; existing backups are never overwritten. Backup contents stay on the
VM and must not be attached to a public issue. Directory entries for the backup
root and commit are fsynced before application changes, alongside the saved
files and subdirectories. HBA/ident replacement also fsyncs their parent
directory before validation and reload.

Only domino-onboarding and domino-deposit OS users are added: system accounts,
no home/login shell and membership in domino-db. The new SQL role
`domino_deposit_service` is LOGIN NOINHERIT, non-superuser and receives CONNECT
only before the reviewed migrations. Existing role attributes/memberships are
not changed. Three exact peer mappings add onboarding→session_auth and
deposit→session_auth/deposit_service; the HBA adds only the fixed deposit role
before the final reject. Original config ownership/modes are retained. The
installer validates`pg_hba_file_rules` and`pg_ident_file_mappings`, requests a
reload and verifies fresh peer connections as both new OS users. These views
describe files on disk, so parsing alone does not prove a reload succeeded.
[PostgreSQL mapping view](https://www.postgresql.org/docs/16/view-pg-ident-file-mappings.html).

Seven separate copies of the same archive live under
`/opt/domino/releases/<commit>/{read,gateway,auth,onboarding,deposit,operator,write}`.
Code is root-owned0444 (executables0555), directories0555. Each backend/runtime
is owned by its service UID and0700; its regular0600 catalogue-db.json contains
only socket, port and database. The sole generated symlink is backend/.venv to
the root-owned dependency environment. Runtime/configuration is never shared or
symlinked. Gateway has no database peer authority despite its descriptor.

Migrations001–014 run as OS domino-admin / SQL domino_catalogue_admin using one
`psql --single-transaction` invocation with`ON_ERROR_STOP=1`, an in-transaction
empty-DB check and bounded SQL timeouts. Any migration error aborts that
transaction. No wallet grants, providers, admission manifest or financial data
are seeded. [psql transaction behavior](https://www.postgresql.org/docs/16/app-psql.html).

Five static units use the existing launchers: read8876 with a15-second budget,
gateway8878, auth8879, onboarding8880 and deposit8881. None supplies`--enable`;
none has an Install/WantedBy section. Units use fixed service UIDs, one process,
UMask0077, no bytecode/core dumps, ProtectSystem=strict, ProtectHome, PrivateTmp,
NoNewPrivileges, and writable access to their own runtime only. Restart-on-failure
is limited to three attempts per60seconds, with a30-second stop timeout.
`IPAddressDeny=any` plus`IPAddressAllow=localhost` is the disabled-stage egress
policy. BPF enforcement must be demonstrated on the actual VM before smoke
startup; `systemd-analyze verify` alone does not prove packets are blocked.
The installer verifies units and runs daemon-reload, then stops. The read API
still serves local liveness; it has no general disabled flag and is isolated
from external providers by the unit policy. Liveness is not provider readiness.

## Failure and remaining work

This is deliberately not retryable over a partial install. A nonempty database,
created user/role, release, unit or backup blocks a new attempt. Migration failure
rolls back SQL in that transaction; prior OS users, files, peer changes and the
new role may remain. Later failure can leave committed migrations but no running
services. Preserve the private backup and inspect the failed stage. The installer
does not delete a release/schema, restore over an existing DB, erase nonces or
attempt destructive rollback. There is no cleanup scheduler.

## Local verification and catalogue checkpoint

After installation, run `check_roles.py` as root before starting the application.
It verifies actual peer identities, encoding and ACLs using read-only queries.
The filesystem check now requires the independently trusted archive as well as
the installed commit. Run the reviewed helper set separately from installed code:

```sh
sudo python3.14 scripts/staging/check_filesystem.py \
  --commit a5a855cec1fc5d120d9c1c187a84ff24bc1b02d6 \
  --archive source.tar \
  --archive-sha256 cddc956efc28a0954eb52388c7e26541f5de0d2191998adcd61bbb5db5e5a562
```

It checks all seven code inventories, file bytes and executable modes against
that tar, in addition to root ownership and the 49 cross-service descriptor
access pairs. Only each service's `backend/runtime` and the validated `.venv`
link are excluded from the code comparison. Missing files, extra files/empty
directories, changed bytes, links, hardlinks and mode changes fail the check.
Runtime contents are not read. See [verifier scope and tests](STAGING_VERIFIER_HARDENING.md)
for the trust boundary and checks still requiring the actual host.

The fresh catalogue seed has no start block. Before testing its HTTP contract,
provision the writer's private RPC configuration and initialize a reviewed start
block with the existing bounded CLI. The 2026-09-11 installation used the start
already documented in `backend/README.md`, with the target one block earlier:

```sh
# As domino-write, from its own installed release; private descriptor/config present.
backend/.venv/bin/python backend/manage_catalogue.py index \
  --start-block 58736592 --through 58736591 --span 1000 --max-steps 1 \
  --output backend/runtime/bootstrap-catalogue.json
```

This fetches public head/checkpoint metadata without scanning events. Inspect
the result and stored checkpoint; a zero exit code alone is insufficient. For
an already initialized checkpoint, omit `--start-block` and require
`caught_up_to_target`. Never replace the values with fabricated chain data.

Start the five static units and wait, with a bounded readiness deadline, for all
five sockets before running `check_disabled_http.py`. `systemctl start` on these
`Type=exec` units can return after execve but before Python binds the sockets. The checker itself
makes exactly 46 bounded requests and does not retry or contact an external
provider. Run it again after a controlled application/PostgreSQL restart.

The coordinator separately proves Linux behavior, role negatives, filesystem
isolation, BPF egress, disabled HTTP responses, restart and restore behavior.
Initial wallet grants, DNS/Tunnel/Cloudflare, consumer
ACKs and HTTPS activation remain separate gates. No changes to host firewall,
cron, Cloudflare or the personal bot are part of this installer. Never point
`backend/dev_postgres.py` at this staging database.
Private provider/secrets delivery is also outside the installer; the dated
installation record distinguishes what was provisioned from what was activated.
