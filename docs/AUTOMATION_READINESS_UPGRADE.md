# Readiness gate upgrade for an already-installed automation host

`install_automation.py` is a first-install tool. A host with the receipted
028–038 automation schema must use `scripts/staging/upgrade_automation_readiness.py`
to add migrations 039, 040 and 046. Re-running the installer will correctly refuse the
existing users, units, private directories and schema.

The upgrade accepts a plain Git archive pinned by the full source commit and
archive SHA256. It verifies the old automation and financial SQL receipts,
checks that 028–038 match both the old immutable source and the new archive,
requires the automation and gas units, the gas socket and timer, and the
standalone execution signer (whose gas gate 046 replaces) to be inactive, and
records the existing three unit files. It then stages a new immutable
`automation` source, applies only `039_automation_readiness.sql`,
`040_gas_finalized_quote_lag.sql` and `046_gas_answer_heartbeat.sql` in one
transaction with its own database receipt, and repoints three inactive services:
`domino-automation`, `domino-gas-reservation` and `domino-gas-settlement`. It
neither changes private configuration/key files nor starts or enables a unit.
The socket and settlement timer remain OFF.

The session listener and `domino-execution-status` may be live, as they are on
the VM since 25 and 26 September 2026. The upgrade neither requires them off nor
touches them: execution-status moves with its own tool,
[`install_financial_release.py`](FINANCIAL_BACKEND_UPGRADE.md), and 039 only
adds the policy that lets its reader see the automation's readiness. Every other
financial listener, with the public reader, gateway, tunnel and development
lanes, is captured before the operation and required unchanged afterward: a
restart or a changed drop-in in between fails the apply, which then restores
the three unit files.

The source goes to `/opt/domino/financial/releases/<commit>/automation`, staged
under a private name and renamed into place, beside any component another
installer put at the same commit. A commit directory it creates is `0555`
whatever the umask; a releases root, or an existing commit directory, that the
service users could not traverse is refused (`release_directory_not_traversable`),
at inspection before the database and again at apply.

From a trusted local copy of the exact released script and sibling staging
helpers, first produce a plan and root-only baseline, then apply that baseline:

```sh
python3 scripts/staging/upgrade_automation_readiness.py \
  --archive /root/readiness/source.tar --archive-sha256 "$ARCHIVE_SHA256" \
  --commit "$RELEASE_SHA" > /root/readiness/plan.json
umask 077
sudo -n python3 scripts/staging/upgrade_automation_readiness.py \
  --archive /root/readiness/source.tar --archive-sha256 "$ARCHIVE_SHA256" \
  --commit "$RELEASE_SHA" --inspect > /root/readiness/baseline.json
sudo -n python3 scripts/staging/upgrade_automation_readiness.py \
  --archive /root/readiness/source.tar --archive-sha256 "$ARCHIVE_SHA256" \
  --commit "$RELEASE_SHA" --baseline /root/readiness/baseline.json --apply
```

The exact 039/040/046 receipts make a retry idempotent: if a client loses the SQL
response or a later file update fails, inspect again and apply using the new
baseline. A receipt for a different commit or migration digest refuses the
retry. The journal and three original unit files are retained at
`/var/backups/domino-financial/automation/readiness-<commit>/`. A scoped
rollback restores only those OFF unit files and keeps the committed 039/040/046
schema. Migration 039 adds a SELECT-only readiness policy. Migration 040
extends only the canonical finalized gas-quote age to 30 minutes; current
reservation quotes still require a block no older than 180 seconds, and the
shared daily cap remains $20. Migration 046 lets the gas cap take an ETH/USD
answer as old as the feed's 24-hour heartbeat plus an hour (90000 seconds)
instead of 2 hours: the feed writes a round only past its deviation threshold,
and on 21–25 September 2026 its answer was older than 2 hours for 19% of the
time, when every reservation would have been refused. It replaces four gas
functions with their bodies unchanged but for that ceiling:

```sh
sudo -n python3 scripts/staging/upgrade_automation_readiness.py \
  --archive /root/readiness/source.tar --archive-sha256 "$ARCHIVE_SHA256" \
  --commit "$RELEASE_SHA" --rollback
```

Rollback refuses a running financial unit or unit drift. The upgrade does not
activate automation by itself. The private profiles, own-node RPC, gas peers,
vault admission and bounded operational rehearsal remain separate activation
steps under the automation runbook.
