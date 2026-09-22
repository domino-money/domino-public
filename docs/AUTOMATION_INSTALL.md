# Automation cycle installation on the existing VM

`scripts/staging/install_automation.py` installs the automation cycle beside the
financial services: one immutable source release for the `automation` component, one
system user, one systemd unit without an `[Install]` section, migrations
`028_automation_cycle.sql`, `029_ledger_index.sql`, `030_swap_exposure.sql` and
`031_publication_resend.sql` in one receipted transaction (it is a first installation:
a host installed before 030 or 031 existed would need them applied on their own; none
had been installed when 030 was added), and
the peer mappings the service needs. It never starts, enables or restarts anything, and
it creates no configuration, key or funding. The
[financial upgrade](FINANCIAL_BACKEND_UPGRADE.md) must already be installed: its
receipt, the execution schema and the three execution roles it made `LOGIN` are checked
before any DDL. The [runbook](AUTOMATION_CYCLE_RUNBOOK.md) is the reference for what the
service does once it runs; this document is only how it gets onto the host.

## What it changes and what it does not

| Changed | Not changed |
| --- | --- |
| `/opt/domino/financial/releases/<commit>/automation` (backend source, read-only, `backend/runtime` bound to `/var/lib/domino-financial/automation`) | Any other release directory; the interpreter (`/opt/domino/backend-venv`, whose dependency lock must match the archive) |
| System user `domino-automation` (nologin, in `domino-db`) | Any existing user, unit or lane |
| `/etc/systemd/system/domino-automation.service` (off; `ConditionPathExists` on the private configuration) | Public, development and continuous read lanes, gateways, tunnels, policy units (their `systemctl show` state is recorded before and required equal after) |
| Migrations 028 to 031, `domino_execution_publisher` made `LOGIN`, receipt in `domino_automation_install.receipt` | Every other schema and role; no data is written to the execution ledger |
| `pg_ident.conf`: `domino_financial domino-automation <role>` for `domino_execution_worker`, `_signer`, `_publisher`, `_ledger`; `pg_hba.conf`: the publisher's `local ... peer map=domino_financial` entry | Every other peer line |
| `/etc/domino/financial/automation` (0700, empty) and `/var/lib/domino-financial/automation` (0700), both owned by the service user | Nothing is placed in them |

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
publisher role or the automation schema already exist, or when the financial receipt is
missing. Apply rechecks the complete baseline under a root-only install lock, journals
every step under `/var/backups/domino-financial/automation/<commit>/`, verifies the unit
with `systemd-analyze`, commits the SQL, replaces the peer files, reloads PostgreSQL,
proves each of the four peer identities with a real connection, reloads systemd, and
requires the recorded lane state unchanged and the new unit not running.

## Private configuration and activation

Nothing here activates the service. After the installer:

1. Place `config.json` (the runbook's configuration, `schemaVersion: 1`,
   `kind: "domino-automation-cycle"`) and the two key files in
   `/etc/domino/financial/automation`, mode `0600`, owned by `domino-automation`. The
   unit binds that directory read-only at `/run/domino-financial-automation-config`, so
   the configuration's `operator.keyFile` and `publisher.keyFile` are
   `/run/domino-financial-automation-config/<name>`, and `database` is the financial
   socket: `{"host": "/run/postgresql-domino", "port": 8877, "dbname": "domino_catalogue"}`.
2. `rpcEndpoint` must be reachable inside `IPAddressAllow=localhost`: the own node
   through a loopback tunnel port. A tunnel on another address needs a root-written
   drop-in with a narrower `IPAddressAllow=` for that address alone; the installer writes
   none.
3. Follow the runbook's activation order: `status` and `evaluate` without keys, a
   `run-once` by hand on one sequence, then `systemctl start domino-automation.service`.
   `executionAvailable` in the public profiles remains a separate change.

## Scoped recovery

```sh
sudo -n python3 scripts/staging/install_automation.py \
  --archive /root/automation/source.tar --archive-sha256 "$ARCHIVE_SHA256" \
  --commit "$RELEASE_SHA" --rollback
```

Rollback stops and removes the unit and restores both peer files from the receipt
directory, after checking that neither drifted since the install. It retains the source
release, the system user, the private and runtime directories and, above all, the
committed automation schema: a schema that already holds cycles, publications or
withdrawals is never dropped by tooling. A failed apply rolls itself back the same way and
reports whether the SQL had committed.

## Verification

`scripts/staging/tests/test_install_automation.py` (run by the repository-hygiene job)
proves from a real `git archive` and without a host: the plan needs no Git and refuses an
archive missing any automation module; the unit is off, hardened and reads only its
private directory; the SQL contains exactly the two automation migrations, in order,
behind the financial-receipt and already-installed guards, plus the publisher's login and
the receipt; the peer files gain exactly the publisher's entry and the four ident rows and
are refused when the financial rows are missing or the automation rows already exist.
The host procedure itself has not been run on the production VM as part of this delivery.
