# Financial backend upgrade on the existing VM

`scripts/staging/upgrade_financial.py` installs one immutable backend archive for
auth, onboarding, deposit, performance, the performance collector, execution
status and the private execution signer. It never starts/enables services and
does not change public/development readers, gateways, tunnels, policy units,
provider pins or Cloudflare configuration. The current foundation is
`4c3ee322308900303c679088bc4712ef16500763`; active read lanes can run a newer
release independently.

The installer compares all fourteen foundation migration files, `schema.sql`
and the exact Python dependency lock against that installed foundation. It uses
the existing `/opt/domino/backend-venv/bin/python3.14`; there is no package
installation or dependency upgrade. Only backend source is extracted, into
`/opt/domino/financial/releases/<commit>/<service>`. Original auth/onboarding/
deposit runtime directories are bound into their new source directories, so
provider/session/configuration files are preserved in place.

## Schema and peer boundaries

Only migrations 015–022 execute, together in a single PostgreSQL transaction.
Migrations 023–038 may travel in the source archive but are not applied by this
helper. The transaction provisions isolated performance and execution roles,
applies the eight exact SQL files, enables peer login for the six non-owner
runtime roles, and writes a postgres-only `domino_financial_install.receipt`
containing release/migration
hashes. Existing financial schemas or roles cause preflight rejection;
reapplication is never inferred from an absent filesystem receipt. A failed SQL
statement rolls back role/schema/receipt creation. Foundation SQL is never
replayed and existing wallet admissions are not modified.

New OS identities have no login shell and use only these explicit peer mappings:

| OS identity | SQL identities |
| --- | --- |
| domino-performance | session_auth, catalogue_reader, performance_collector, performance_reader |
| domino-performance-collector | performance_collector, performance_reader |
| domino-execution-status | session_auth, execution_reader |
| domino-execution-signer | execution_worker, execution_ledger, execution_signer |

SQL names in the table have the `domino_` prefix. No SQL role memberships or
schema-owner memberships are granted. Existing `pg_ident.conf` entries remain
byte-for-byte; new role HBA entries use a separate `domino_financial` peer map
before the existing local reject rule. Mappings to existing session/catalogue
roles use the existing `domino` map. PostgreSQL reload, never restart, admits
these rows. Positive peer identity checks run before completion.

## Native procedure

Run the helper from an operator-controlled copy with its sibling staging
helpers. The source archive must be a plain `git archive` of the final combined
commit, pinned by both its full commit ID and SHA256. The installer accepts no
arbitrary installation, database or service path.

```sh
python3 scripts/staging/upgrade_financial.py \
  --archive /root/financial/source.tar --archive-sha256 "$ARCHIVE_SHA256" \
  --commit "$RELEASE_SHA" > /root/financial/plan.json

umask 077
sudo -n python3 scripts/staging/upgrade_financial.py \
  --archive /root/financial/source.tar --archive-sha256 "$ARCHIVE_SHA256" \
  --commit "$RELEASE_SHA" --inspect > /root/financial/baseline.json

sudo -n python3 scripts/staging/upgrade_financial.py \
  --archive /root/financial/source.tar --archive-sha256 "$ARCHIVE_SHA256" \
  --commit "$RELEASE_SHA" --baseline /root/financial/baseline.json --apply
```

The default plan performs no host commands and does not require Git. Inspection
is read-only; apply rechecks that complete baseline while holding a root-only
install lock. Baseline records contain hashes/service metadata and the wallet
grant count, not credential contents or wallet addresses. The private journal
and original units/peer files are under
`/var/backups/domino-financial/<commit>/`.

The helper installs units without `[Install]` targets, does not call `start` or
`enable`, and verifies the protected read-lane state after daemon reload. The
five HTTP services remain in their existing disabled/default admission mode;
collector/signer additionally require absent private configuration files before
systemd can launch them. The signer is a one-shot explicit intent step, with no
timer, listener or automatic loop. Its missing `request.env` must eventually
contain only `DOMINO_EXECUTION_OWNER`, `DOMINO_EXECUTION_INTENT` and
`DOMINO_EXECUTION_WORKER`; the key stays in its separate private file.

## Real configuration and later activation

Each service receives a separate self-owned `0700` directory under
`/etc/domino/financial/<service>`, mounted read-only at
`/run/domino-financial-<service>-config`. This alias avoids granting traversal of
the root-only `/etc/domino` directory. Files must be self-owned `0600`, regular
and non-symlink. New mutable runtimes are independent `0700` directories under
`/var/lib/domino-financial`. The installer creates only non-secret database
descriptors. It does not generate an Access issuer, audience, service ID,
session secret, admitted vault, price observation, RPC credential or signing key.

Use the exact profiles documented in `MANAGED_PERFORMANCE_RUNTIME.md` and
`DURABLE_EXECUTOR.md`; write their absolute paths using the service's alias.
The performance listener and collector have different OS owners and separate
profiles/runtimes. Session origin/abuse identity must match the session service.
Performance subjects must name actual deployed vaults and code hashes. Signer
policy, chain/finality/gas limits, current V4 runtime pins and funding must be
real before enabling new execution; three admitted user wallets alone do not
provide a signer or a deployed financial contract.

Existing listeners keep 8879/8880/8881; performance and status use 8900/8901.
The generated service network policy permits loopback only. Later activation
must provision the required exact provider/JWKS egress for these UIDs and
authenticated tunnel paths, then replace only that service's `ExecStart` with
its documented `--enable` invocation. The source/schema installation is useful
before those credentials exist and does not claim provider availability or
financial readiness. No change to the current read/development access expiry
or quotas is part of this operation.

## Scoped recovery

`--rollback` with the same archive/commit restores the original three financial
units, removes only this release's four new units and restores original peer
files. It first checks current bytes against the saved/installed versions, so
unrelated edits are not overwritten. It stops/drains only units in its write
journal and never restarts the old financial services. Partial journaled writes
and a repeated completed rollback are supported.

Committed SQL, private configuration, immutable source and new OS identities
are retained. Dropping financial schemas or restoring a shared database would
destroy durable intent/receipt information, so neither is a source rollback.
The SQL receipt resolves a lost client response around COMMIT. A failed or
rolled-back attempt is left for scoped repair; it is not silently reapplied or
treated as an empty database.

## Verification

Local tests exercise a real Git archive, CLI planning without Git or host
commands, archive traversal/link/private-directory rejection, exact service and
peer scope, migration sentinels, partial/idempotent recovery and foreign drift.
The opt-in PostgreSQL fixture starts from populated 001–014, proves that a
failing 022 rolls back the whole operation, applies the real eight migrations
once, preserves wallet/catalogue counts and checks protected SQL surfaces.

```sh
DOMINO_TEST_STAGING_POSTGRES=1 DOMINO_PG_BIN=/path/to/postgresql/bin \
  python -B -m unittest discover -s scripts/staging/tests \
  -p test_upgrade_financial.py -v
```

The local run used PostgreSQL 18; CI should run the same fixture with PostgreSQL
16. Neither fixture performs a VM operation or makes a provider request.
