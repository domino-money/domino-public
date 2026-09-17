# Reference collection timer

Reviewed candidates for running `backend/collect_reference_prices.py
--every-mapping` on the five-minute grid. The reference lane only answers while
its stored series covers the read window within `REFERENCE_MAX_AGE_SECONDS`
(600 s), so a manual collection stops covering it minutes after the activity
tail advances; this timer is what makes #162's lane continuous. Nothing here
adds a production qualification: every stored row stays
`external_market_reference_unqualified` and `PRODUCTION_QUALIFICATIONS` stays
empty.

One pass collects the trailing hour for every recorded mapping, one outcome
per currency. A provider refusing one mapping (MARLIN's CoinGecko rate limit is
the recorded case) is that mapping's own failure, reported and asked again on
the next run, never retried blindly inside the same pass. A provider that
answers with nothing inside the window is reported as
`reference_collection_empty` and fails the pass — a green pass means the lane
actually advanced. `--budget-seconds` is the hard stop, and the pass reserves
one mapping's bounded worst case before starting it, so a started mapping
always finishes inside the budget and `TimeoutStartSec` never kills a store
mid-flight; a run reporting `stoppedBecause: budget` is a decision point. The
store is an idempotent upsert under the catalogue's global writer key, so
overlapping windows re-assert rather than duplicate; a pass that meets a long
indexer chunk reports `catalogue_writer_busy` honestly and the next grid run
re-covers the window;
`Persistent=true` back-fills a missed grid after downtime within the one-hour
lookback — an outage longer than that needs one manual `--currency` pass per
mapping with an explicit window.

## Activation (operator steps, in order)

1. Install this service identity's own copy of the pinned release at
   `/opt/domino/reference-collector/release` (deployment-owned, read-only)
   with its own locked venv at `/opt/domino/reference-collector/venv`
   (CPython 3.14, `requirements-api.lock`). Runtime and configuration are
   never shared with another service identity's root.
2. Create the `domino-reference` user. Its database access follows the
   peer-auth model of `docs/HOME_VM_RUNBOOK.md` §4: add the user to the
   PostgreSQL socket-directory group, map OS user `domino-reference` to the
   writer role in `pg_ident.conf` (with the matching `pg_hba.conf` peer line),
   and reload PostgreSQL.
3. Give the release's `backend/runtime/` (0700, owned by `domino-reference`)
   its own 0600 `catalogue-db.json`. The two Alchemy mappings also need
   `/etc/domino/reference-collector/providers.json`, 0600 and owned by
   `domino-reference`; absent, each Alchemy mapping honestly reports
   `configured_rpc_required` per pass, and a copy readable but wrongly owned
   reports `local_provider_config_permissions`.
4. The shipped service denies every non-loopback address. Approve a separate
   egress drop-in pinning the two provider destinations
   (`api.g.alchemy.com:443`, `api.coingecko.com:443`) and the matching hosts
   bind, exactly as the tunnel's drop-in does. Extending
   `scripts/staging/egress_policy.py` with this role is deliberately left to
   the egress tooling work (#171's family), not done here.
5. `systemd-analyze verify` both units, install, then enable **the timer**:
   `systemctl enable --now domino-reference-collector.timer`. The service has
   no install section on purpose.
6. Verify with `journalctl -u domino-reference-collector.service -n 3`: one
   JSON line per pass, `mappings` naming every currency's outcome, and
   `failures: 0` once all three providers answer with in-window data. An
   occasional `catalogue_writer_busy` from a concurrent price-observation
   writer is that pass's honest outcome; the next grid run re-covers it.

Stop and restore through the timer; the service is a manual, bounded pass.
