# Price window capacity — issue #23

This change removes the former 600-row mismatch for a bounded 24-hour price
series. It adds resumable Chainlink acquisition; it does not qualify a production
price source, publish live USD TVL/APR, or authorize a transaction. All new
verification described here uses synthetic prices, a fake archive RPC and local
disposable PostgreSQL/Anvil. No historical backfill was run.

## Supported envelope

| Boundary | Limit and behavior |
| --- | --- |
| Generic price window | 86,400 seconds, plus at most 300 seconds of causal lookback |
| Observations in a series/write batch | `floor((86400+300)/60)+1 = 1446` |
| SQL load | One exact source per query, then limit 1,447 to detect overflow within that source |
| Production price age | At most 300 seconds; no interpolation or future fill |
| Atomic Chainlink fetch | 64 rounds, including the strict predecessor |
| Default collection slice | `(64-2)*60 = 3720` seconds; explicit range 1–3,720 |
| Collection | One asset, one immutable snapshot, at most 24 hours, 1,446 slices |
| Collection observations | At most 1,446 unique rows and 4,338 rows including slice overlaps |
| CLI invocation | 1–4 slices; 6,402 acquisition RPC calls; optional storage adds at most 8,680 verification calls; shared 480-second cooperative budget |
| Atomic collection step | At most 1,600 RPC calls and 180 seconds |
| Sliced reference validation | At most 15,000 RPC calls and 480 seconds, with a bounded caller transport |
| Checkpoint | At most 8 MiB; private regular file mode 0600 inside ignored `backend/runtime/` |

Sixty seconds is a **supported capacity envelope**, not a feed SLA or a resampling
promise. The engine retains every faster update within capacity, even a
one-second spike between capital events. A complete day of 30-second updates is
explicitly over budget. A 301-second cadence fits the row budget but fails the
300-second production freshness rule. Capacity and qualification are independent.

The original concern about 64 rounds was correct for one frequent-update fetch,
but that limit is per fetch, not a database lifetime limit. Existing incremental
storage already allows multiple batches. The original single-bundle reference
factory still permits at most 64 observations and can cover slow feeds under its
explicit 86,520-second reference policy. The new sliced factory handles a bounded
full day of more frequent updates without pretending a capped bundle is complete.

## Explicit acquisition and resume

`collect_chainlink.py` accepts one reviewed currency address and explicit Unix
second bounds. The following is a command template, not a record of executed
network work. Replace the variables with reviewed public asset/window inputs:

```sh
backend/.venv/bin/python backend/collect_chainlink.py \
  --currency "$CURRENCY" --start "$START_TIMESTAMP" --end "$END_TIMESTAMP" \
  --checkpoint backend/runtime/chainlink/window.json --max-steps 4
```

The first run pins a snapshot; every resume uses its original number, hash and
timestamp. Optional `--block-number` must match that saved number. Changing the
currency or window requires a new checkpoint. An optional `--provider-config`
reads the existing private local configuration; provider URLs and credentials are
never copied into the checkpoint or progress output.

Each completed slice is saved atomically. Exit 0 means acquisition completed,
exit 2 means the requested bounded steps completed with more history remaining,
and exit 1 means an error. A failed slice does not change the previous checkpoint.
An oversized burst returns `chainlink_slice_too_dense`; explicitly rerun the same
command with a smaller `--slice-seconds`, down to 1 second. No automatic retry,
background loop, skipped round, or partially successful slice is installed.
Mixed cadence is supported by retaining completed larger slices and continuing
with smaller slices. More than the collection's finite row/slice/byte bounds,
ambiguous same-second publications, phase transitions or unprovable history
remain explicit errors requiring a reviewed adapter/capacity decision.

`--store-observations` writes the deduplicated completed collection in one existing
price-store transaction. Repeating the same completed command is idempotent;
conflicting revisions require review. Even with zero acquisition steps remaining,
storage checks chain identity, the original snapshot, every slice boundary and
all distinct publication/predecessor headers before any write and again before
commit. A reorg, missing RPC evidence, deadline or verification-budget failure
leaves the transaction uncommitted. Header conflicts inside a checkpoint fail
before RPC. Storage remains `observed_unqualified`: canonical headers do not
establish round truth, independent market integrity or production qualification.
Reference valuation still performs its full round/configuration proof checks.

Storage performs two sequential verification passes. One pass runs before
opening the price transaction; the second runs under the catalogue-wide writer
advisory lock and can require up to 4,340 RPC calls, including chain identity.
Activity, fee, position and capital writers sharing that lock then fail fast
with `catalogue_writer_busy`. Acquisition and both passes consume the same
480-second invocation budget; a zero-acquisition resume of a completed checkpoint
still needs both full passes. The maximum storage-only 8,680 calls would leave
less than 56 ms per call before local work, so the request ceiling is not a
provider throughput guarantee. Slow providers or dense evidence can repeatedly
fail storage without committing any rows. Resume the completed checkpoint in a
later, separate invocation to avoid sharing time with acquisition; if full
verification still cannot finish, stop and review the workflow's capacity.

The budget is checked before and after each RPC, with socket timeouts clamped
to the remaining time. The inherited urllib transport does not hard-cancel an
in-flight response stream, so 480 seconds is not a guaranteed wall-clock ceiling
on the writer lock. The lock remains held until verification finishes or raises
and the transaction exits. These limitations do not permit skipping the second
pass, raising source capacity or committing partially verified evidence.

Checkpoints contain strict public observation/proof fields, an immutable identity
hash and an SHA-256 envelope. Hashes detect accidental changes, not a malicious
same-user writer. A mode-0600 lock prevents concurrent CLI writers. Symlinks,
insecure modes, oversized files and duplicate JSON keys are rejected. Every
saved slice must agree on the snapshot, feed identity/configuration and contiguous
requested bounds. Exact overlapping proofs deduplicate; different prices or
proofs at the same timestamp are errors. Retrieval timestamps do not replace
publication time or make an old snapshot current.

## Reference valuation

Offline callers may pass a completed collection to
`chainlink_reference.reference_series_from_slices(collection, pool_id, rpc, pool_key=...)`.
Use a read-only RPC with a bounded transport. The factory checks every original
slice boundary hash and every unique publication/predecessor proof, round answer,
history linkage, endpoint and pinned snapshot before returning a series. Missing
intermediate/tail rounds or a reorganized original block fail closed. It returns
`reference_analytics_only`, `productionQualified: false`, the original historical
snapshot, and the digest of the full collection. There is no HTTP route or
production registry insertion for this factory.

The named reference policy remains 86,400 seconds plus a 120-second publication
grace. Availability starts one second after the proven publication timestamp;
expiry uses `answerUpdatedAt`. This is not a Chainlink SLA and does not relax the
generic production qualification's 300-second ceiling. Full-day price evidence
alone does not establish event-time capital coverage or a usable current APR.

## Synthetic acceptance evidence

- A full day plus lookback at 60 seconds produces exactly 1,446 rows and complete
  generic coverage. Cadences 120, 144, 145, 150 and 300 seconds also pass; 30-second
  full-day data overflows explicitly; 301-second data produces an internal gap.
- The actual Chainlink adapter acquires a 24-hour 60-second feed in 24 atomic
  slices, preserving 1,442 unique publication rows including the predecessor.
  The sliced reference factory verifies the complete day; the legacy factory
  rejects a bundle larger than 64. A synthetic slow feed can cover a day under
  the reference policy while failing generic production coverage.
- A synthetic burst with one-second publications first fails the larger slice,
  preserves prior work, and completes through an explicitly smaller slice size.
- Tests cover exact prices above `2**53`, duplicate/conflicting updates, source
  filtering, persistence at capacity, sentinel overflow, bounded RPC/deadlines,
  snapshot changes, intermediate boundary reorgs, incomplete collections,
  checkpoint damage/modes/symlinks/size/locks, and CLI identity-bound resume.

Reproduce the focused synthetic tests without RPC credentials:

```sh
backend/.venv/bin/python -m unittest discover -s backend/tests -p 'test_price_capacity.py' -v
backend/.venv/bin/python -m unittest discover -s backend/tests -p 'test_chainlink*.py' -v
```

PostgreSQL/EVM verification follows the full-suite command in the root README.
On 2026-09-10 the final suite passed **275 tests with no skips**, including the
disposable PostgreSQL tests and original-v4 native EVM references. The seven
focused price-capacity tests and 54 Chainlink tests also passed. Staged repository
hygiene checked 270 files with zero findings. The long macOS worktree exceeded
the Unix-socket path limit; the ignored local test runner used a unique private
temporary socket for this checkout's cluster, then stopped the cluster and
removed that socket. No database helper or migration was changed.

## Pre-merge correction — issue #45

Without a production qualification, Alchemy and Chainlink candidates now receive
separate 1,446-row budgets. Two full sources can contribute 2,892 diagnostic rows
for one currency; their prices are never combined into a valuation series.
Observation counts, source names and earliest/latest timestamps remain exact.
An actual overflow within either source still raises
`price_observation_budget_exhausted`; unused capacity from another source does
not widen its budget. Qualified reads continue selecting only their approved
source, including when an unrelated candidate overflows.

The new unit and PostgreSQL regressions reproduced the original failure before
the fix. With 1,446 rows from each candidate and an empty qualification registry,
`stored_metrics` now preserves capital, snapshot and all price diagnostics while
valuation remains unavailable with `qualified_usd_prices_required`.
The focused capacity, valuation and PostgreSQL capital suites passed 9, 25 and
19 tests respectively. The complete PostgreSQL/EVM suite passed **278 tests with
no skips** on 2026-09-10, using only this checkout's private disposable cluster.
No production qualification, pricing policy, migration or API schema changed.


## Moving-window and orphan recovery — issue #51

Two individually valid stored collections may exceed one later moving window.
The SQL reader retains its per-source 1,447-row sentinel and does not truncate.
`stored_metrics` catches only `price_observation_budget_exhausted` from that
reader and preserves reconciled capital, identity, snapshot and revision. All
USD/APR fields become null with that reason. The overflowing currency's price
counts, sources and timestamp extrema are null; its `sourceQualification` and
coverage are `not_assessed`, never an apparently complete truncated count.
The other currency retains its independently assessed diagnostics and coverage.
These are exactly the states already
specified by read-v1 candidate #26 (`8c49c3c`, version `1.1.0-rc.1`), not a new
contract variant. Database, RPC and corrupt-ledger errors remain errors.

The regression acquires collection A with 1,446 unique rows and the adjacent B
with three, using the real sliced adapter against a synthetic archive. Their
shared predecessor deduplicates in PostgreSQL. A later trailing day contains
1,447 Chainlink rows and returns HTTP 200 with capital retained/USD null; advancing
one second excludes a boundary row and restores exactly 1,446 Chainlink rows plus
1,446 independently budgeted Alchemy observations. Both candidates remain
unqualified. The older mixed-source and qualified-source-isolation tests remain.

Previously stored orphan proofs require an explicit operator action. The public
API and collection retries never delete/overwrite them. Review the original
private checkpoint and record its collection digest, provision a private 0700
archive directory durably (including syncing its parent), then invoke:

```sh
backend/.venv/bin/python backend/price_quarantine.py \
  --checkpoint backend/runtime/chainlink/window.json \
  --reviewed-sha256 "$REVIEWED_COLLECTION_SHA256" \
  --archive-directory "$PRIVATE_ARCHIVE_DIRECTORY" \
  --provider-config backend/runtime/provider.json
```

This template is not a record of a live operation. The directory must already
exist; this command never creates it. Selection is bounded to the reviewed
collection's at most 1,446 identities, under the catalogue writer lock and row
locks. Exact stored price/provenance must still match the reviewed collection.
Only rows whose publication or predecessor block hash now differs can be removed;
a changed snapshot alone is not proof that earlier price observations are orphaned.
A missing/error response cannot authorize deletion. All headers are read twice
against one canonical anchor, and that anchor is rechecked after archiving.
The limit is 8,683 verification requests and 480 seconds with bounded transport.

Before deletion, a 0600 archive retains the full checkpoint, original stored
retrieval times/provenance, changed canonical headers and anchor. The archive is
at most 16 MiB, named by its SHA-256, read back exactly, and both file and directory
are synced. An existing-file retry also verifies and syncs the file. Archive,
RPC or database failure preserves rows; a durable archive from a rolled-back
attempt remains evidence. No automatic replacement follows quarantine: a
separately reviewed canonical collection can later insert the vacated identities.
Back up these archives with the database. Repeating a completed quarantine returns
`price_quarantine_no_orphans` and makes no additional deletion.

The focused tests cover pre-write reorg/unavailability, transaction rollback on
the final canonical check, idempotent zero-step CLI storage, exact quarantine
provenance, file/directory sync failures, failed archive readback, a changed
anchor after archival and a separate canonical replacement. No production
qualification or migration changes, deployment, wallet use or live RPC are part
of this work.


Verification for this follow-up on 2026-09-10: the full isolated PostgreSQL/native
EVM backend suite passed **290 tests with zero skips**; the 12 new recovery tests
are included in that count. Direct pinned Forge from `contracts/` passed four
tests, including 512 fuzz runs. The inherited root Forge wrapper/path issue is
already fixed separately by #28 and must be preserved on integration. The actual
moving-window HTTP reports also passed the pinned #26 strict Pydantic contract
and JavaScript consumer runtime after applying #26's unchanged public-response
decorator; a fabricated truncated observation count was rejected. This combined
contract evidence is an integration check, not frontend acknowledgement or a
change to the #26 candidate. No UI, contract arithmetic or migration changed.

### Reconciliation with main `420a591`

The merge retains the resumable capital worker from #54 and the #52 canonical
storage/quarantine checks. Price overflow is now handled separately for each
currency: missing, observed-unqualified and qualified diagnostics for the other
currency survive unchanged. The real HTTP regression covers overflow in either
currency, complete qualified coverage in the other, exact unavailable
status/reason, unchanged capital/snapshot/revision and null valuation. Database,
RPC and integrity failures still propagate even after an earlier currency
overflow. The moving-window regression retains the 1,446/1,447 boundary and
recovery, with missing history reported as `0`/`[]` rather than null.

The merged tree passed **398 PostgreSQL/native-EVM tests with zero skips**,
including **13 storage-recovery tests**, plus **29 Solidity tests** and **3 native
launcher tests**. All seven Solidity fuzz tests ran 512 cases each. Repository
hygiene and dependency checks passed. Tests used this worktree's disposable Unix
socket PostgreSQL cluster and synthetic RPC/EVM fixtures; the cluster was stopped
after verification. No production source qualification or migration changed.

The legacy `qualify_chainlink.py --store-observations` integrity finding remains
separate in issue #60. This reconciliation neither fixes nor endorses that
storage path, and the sliced-checkpoint quarantine procedure does not establish
recovery coverage for its legacy rows. The #26 contract integration and frontend
acknowledgement remain separate from these producer tests.
