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
| CLI invocation | 1–4 slices; 6,402 RPC calls including initial identity reads; 480 seconds total |
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
conflicting revisions require review. Storage remains `observed_unqualified` and
does not assert current canonicality. A retained acquisition checkpoint may be
historical or later orphaned; it must be revalidated before reference valuation.

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
