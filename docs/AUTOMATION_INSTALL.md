# Automation cycle installation on the existing VM

`scripts/staging/install_automation.py` installs the automation cycle beside the
financial services: one immutable source release for the `automation` component, three
system users, the automation unit and four gas peer units without `[Install]` sections, migrations
`028_automation_cycle.sql`, `029_ledger_index.sql`, `030_swap_exposure.sql`,
`031_publication_resend.sql`, `032_shared_gas_budget.sql`,
`033_gas_budget_claim_read.sql`, `034_gas_settlement_sweep.sql` and
`035_cancel_unsigned_gas_claims.sql` and
`036_gas_settlement_journal_read.sql` and
`037_gas_settlement_receipt_evidence.sql` and
`038_gas_settlement_quote_witness.sql` in one receipted transaction. This is a first-installation
path; an already installed automation host needs a separate incremental migration
procedure. It also adds the peer mappings the service needs. It never starts,
enables or restarts anything, and
it creates no configuration, key or funding. The
[financial upgrade](FINANCIAL_BACKEND_UPGRADE.md) must already be installed: its
receipt, the execution schema and the three execution roles it made `LOGIN` are checked
before any DDL. The [runbook](AUTOMATION_CYCLE_RUNBOOK.md) is the reference for what the
service does once it runs; this document is only how it gets onto the host.

## What it changes and what it does not

| Changed | Not changed |
| --- | --- |
| `/opt/domino/financial/releases/<commit>/automation` (backend source, read-only, `backend/runtime` bound to `/var/lib/domino-financial/automation`) | Any other release directory; the interpreter (`/opt/domino/backend-venv`, whose dependency lock must match the archive) |
| System users `domino-automation`, `domino-gas-reservation` and `domino-gas-settlement` (nologin shells, in `domino-db`) | Any existing user, unit or lane |
| `/etc/systemd/system/domino-automation.service` (off; `ConditionPathExists` on the private configuration) | Public, development and continuous read lanes, gateways, tunnels, policy units (their `systemctl show` state is recorded before and required equal after) |
| `domino-gas-reservation.socket`/`.service` and `domino-gas-settlement.service`/`.timer`, all off | No listener, timer or gas peer starts during installation |
| Migrations 028–038, `domino_execution_publisher` made `LOGIN`, two `NOLOGIN` gas privilege roles inherited by separate unprivileged LOGIN bridge roles, receipt in `domino_automation_install.receipt` | Every other schema and role; no data is written to the execution ledger |
| `pg_ident.conf`: `domino-automation` maps to its four execution roles; each gas OS identity maps to only its own bridge. `pg_hba.conf` gains only the publisher and two bridge entries ahead of the local reject. | Every other peer line |
| `/etc/domino/financial/automation` (0700, empty) and `/var/lib/domino-financial/automation` (0700), both owned by the service user | Nothing is placed in them |
| Empty 0700 `/etc/domino/financial/gas-reservation` and `/etc/domino/financial/gas-settlement`, each owned by its own OS peer | No RPC credential or signer key is created |

## Native procedure

Run the helper from an operator-controlled copy with its sibling staging helpers. The
source archive must be a plain `git archive` of the released commit, pinned by both its
full commit ID and SHA256; the installer accepts no arbitrary installation, database or
service path.

```sh
python3 scripts/staging/install_automation.py \
  --archive /root/automation/source.tar --archive-sha256 "$ARCHIVE_SHA256" \
  --commit "$RELEASE_SHA" > /root/automation/plan.json

umask 077
sudo -n python3 scripts/staging/install_automation.py \
  --archive /root/automation/source.tar --archive-sha256 "$ARCHIVE_SHA256" \
  --commit "$RELEASE_SHA" --inspect > /root/automation/baseline.json

sudo -n python3 scripts/staging/install_automation.py \
  --archive /root/automation/source.tar --archive-sha256 "$ARCHIVE_SHA256" \
  --commit "$RELEASE_SHA" --baseline /root/automation/baseline.json --apply
```

The default plan performs no host command and needs no Git. Inspection is read-only
and refuses when the unit, the user, the release directory, the private directories, the
publisher/gas roles or the automation schema already exist, or when the financial receipt is
missing. Apply rechecks the complete baseline under a root-only install lock, journals
every step under `/var/backups/domino-financial/automation/<commit>/`, verifies the unit
with `systemd-analyze`, commits the SQL, replaces the peer files, reloads PostgreSQL,
proves the four execution and two gas peer connections, checks cross-role denial, reloads systemd, and
requires the recorded lane state unchanged and the new unit not running.

## Private configuration and activation boundary

Nothing here activates the service. After the installer:

1. The runtime boundary is wired in source: automation and the standalone signer
   request reservation through `/run/domino-gas-reservation.sock`. The socket peer
   checks the caller's OS UID. It lets the automation/signer peers reserve or
   confirm claims, while the settlement peer may only request a fresh ETH/USD
   attestation by exact claim ID. The reservation peer independently reads the
   reviewed Chainlink feed at the RPC `finalized` head and appends the quote
   under its own database role. A stale or reorganized finalized head leaves
   the original reservation in place.
   The keyless settlement command runs under `domino-gas-settlement` and reads
   exact journal witnesses through six scoped database functions. Neither peer
   connects as the other's LOGIN role, and the automation process has no direct
   gas-role connection. The installer leaves the socket, service and timer **off**.
   Do not activate them until the private profiles and a host-level end-to-end
   rehearsal are complete. Migration 035 provides narrowly proved cancellation
   of terminal claims that were never signed. Migration 037 computes settlement
   from the publisher journal plus its independent finalized-block witness,
   a canonical operator effect, or an immutable reverted operator receipt;
   a caller-supplied smaller gas amount is refused. Migration 038 also refuses
   a caller-supplied ETH/USD price that differs from the independently attested,
   recent quote; settlement charges at least the highest witnessed answer and
   the reservation answer. The settlement unit requires the local reservation
   socket, but installation leaves both off. The publisher identity
   refreshes missing finality witnesses in bounded rotating passes, including
   after a cycle has left the live-publication queue.
2. Place `config.json` (the runbook's configuration, `schemaVersion: 1`,
   `kind: "domino-automation-cycle"`) and the two key files in
   `/etc/domino/financial/automation`, mode `0600`, owned by `domino-automation`. The
   unit binds that directory read-only at `/run/domino-financial-automation-config`, so
   the configuration's `operator.keyFile` and `publisher.keyFile` are
   `/run/domino-financial-automation-config/<name>`, and `database` is the financial
   socket: `{"host": "/run/postgresql-domino", "port": 8877, "dbname": "domino_catalogue"}`.
3. `rpcEndpoint` must be reachable inside `IPAddressAllow=localhost`: the own node
   through a loopback tunnel port. A tunnel on another address needs a root-written
   drop-in with a narrower `IPAddressAllow=` for that address alone; the installer writes
   none.
4. Each gas peer needs its own 0600 `config.json`, owned by its corresponding
   OS user, under `/etc/domino/financial/gas-reservation` or
   `/etc/domino/financial/gas-settlement`. Both profiles have exactly
   `schemaVersion: 1`, `kind` (`domino-gas-reservation` or
   `domino-gas-settlement`), `database` (the same local socket triplet) and
   `rpcEndpoint` (the own node's loopback endpoint). The gas peers never read
   the automation key files. The socket serves reservation; the settlement
   timer triggers finite keyless passes. Starting either is a separate
   operational action after qualification.
5. Follow the runbook's activation order: `status` and `evaluate` without keys, a
   `run-once` by hand on one sequence, then `systemctl start domino-automation.service`.
   `executionAvailable` in the public profiles remains a separate change.

## Scoped recovery

```sh
sudo -n python3 scripts/staging/install_automation.py \
  --archive /root/automation/source.tar --archive-sha256 "$ARCHIVE_SHA256" \
  --commit "$RELEASE_SHA" --rollback
```

Rollback stops and removes the automation and gas peer units and restores both peer files from the receipt
directory, after checking that neither drifted since the install. It retains the source
release, the system user, the private and runtime directories and, above all, the
committed automation schema: a schema that already holds cycles, publications or
withdrawals is never dropped by tooling. A failed apply rolls itself back the same way and
reports whether the SQL had committed.

## Verification

`scripts/staging/tests/test_install_automation.py` (run by the repository-hygiene job)
proves from a real `git archive` and without a host: the plan needs no Git and refuses an
archive missing any automation module; all units are off and hardened; the SQL contains exactly the listed automation migrations, in order,
behind the financial-receipt and already-installed guards, plus the publisher's login and
the receipt; the peer files gain exactly the publisher and two gas bridge entries, plus six ident rows, and
are refused when the financial rows are missing or the automation rows already exist.
The opt-in disposable PostgreSQL test proves both LOGIN bridges connect, both
privilege roles stay `NOLOGIN`, and reserve/settle permissions do not cross.
The host procedure itself has not been run on the production VM as part of this delivery.
The optional [synthetic Ubuntu rehearsal](AUTOMATION_OFF_CI_REHEARSAL.md)
checks the archive plan, OFF units and local socket peer credentials on a disposable
CI runner; it does not run the native `--inspect`/`--apply` or qualify a settlement.
