# Persistent public data implementation

Implementation record, 19 September 2026. This document describes code and local
verification; it does **not** attest to a VM deployment, public activation or a
measured production latency target. Deployment and benchmark evidence must be
recorded separately. The design baseline is
[GENERIC_TOKEN_DATA_PLAN.md](GENERIC_TOKEN_DATA_PLAN.md).

## Delivered behavior

`read-v3` (`3.0.0-rc.1`) adds three stored routes without changing the strict
read-v1/read-v2 response envelopes:

| Public route | Stored work and bounds |
| --- | --- |
| `/api/read/v3/overview` | One token's known pools, with revision/cursor pagination, or an explicit selection of at most 24 pool IDs. Includes durable token metadata, pool observations, existing estimate provenance and acquisition states. |
| `/api/read/v3/history` | One pool and selected currency; 24h, 7d or 30d requested window, supported minute/hour/day resolution and at most 600 candles. Returns its actual snapshot, covered intervals and gaps. |
| `/api/read/v3/search` | Address/symbol prefix search over already verified stored token identities, at most 24 results. A symbol never chooses an unknown contract. |

Requests pass through the existing beta gate, same-origin Pages forwarder,
authenticated Worker and Access gateway. The internal prefixes are
`/internal/read/v3/` at the gateway and `/v3/read/` at the loopback reader. Each
boundary validates the contract and request/response identity. The Worker does
not rewrite a V3 payload. V1/V2 routes and their Access credentials remain intact;
the development tunnel does not acquire V3 routes.

Overview and history can register bounded aggregate interest through narrow
database functions, then read stored data. They do not fetch RPC/provider data or
replay history inside HTTP requests. Unknown valid addresses remain pending until
verified. The initial global admission ceiling is 1,000 pending entities and
1,000 unfinished history jobs; these are not a 1,000-row retention ceiling.

The frontend prefers bundled stored reads when their capability is enabled,
retains successful observations with their original ages, and refreshes visible
data. The history chart uses **quote-token units per base token**, from local-chain
Swap events. USD provider candles remain a separate choice. It never relabels
ratios as USD, invents prices for empty buckets, joins missing acquisition gaps,
or claims complete history from a partial window. A complete empty window can
truthfully contain no swaps and no candles.

## Admission and persistence

Provider reads retain one slot and their existing pacing. `pool-metrics` remains
in that lane because it performs RPC canonicality checks. Catalogue, snapshot,
validated `pool-market` requests with `fromSnapshot: true`, and V3 reads use
stored capacity. Provider `health.busy` no longer vetoes those reads; their own
stored admission is checked instead. Explicit production V3/public-data enablement
selects four stored slots with no stored start interval. Legacy defaults and the
single-worker development gate retain their previous capacity. Slots are released
by the actual synchronous worker, including errors; a disconnected caller is not
evidence that the worker finished. The existing client budget still applies.

Apply migrations in order through the existing privileged deployment path:

| Migration | Purpose |
| --- | --- |
| `023_pool_request_scheduling.sql` | Recurring due times, backoff, leases/generations and adaptive span state on the existing activity request queue. It preserves acquired checkpoints. |
| `024_public_observations.sql` | Public entity observations, token/pool links, revisioned lookup, narrow interest admission and a shared 25/minute external-provider allowance. |
| `025_public_history.sql` | Recent-history jobs, canonical coverage, Swap observations and ratio candles. |

The HTTP database role cannot publish observations or modify projections. Current
and history workers publish with lease/generation checks; history publication also
checks canonical boundaries and exact event headers. Reorganizations or changed
token denomination invalidate the affected projection rather than silently
relabeling its prices. Current observations preserve provider ages on cache hits
and import; stored reads do not make old data fresh.

There is no initial age-based deletion of acquired Swap events or candles.
The 30-day API window bounds a request, not retention. Explicit canonicality or
denomination invalidation can remove invalidated projections so they can be
reconstructed. Database growth, backups and restore time must be measured before
introducing archival/compaction.

## Activation and rollback

1. Prepare the exact tested release and apply migrations 023–025. Preserve the
   prior release/drop-ins and private runtime configuration. The existing
   `scripts/staging/install_read_release.py` installs reader/gateway code only;
   it does not apply migrations, install collectors or activate services.
2. Install the units in `ops/systemd/`, resolving `@PUBLIC_ROOT@` and
   `@QUEUE_ROOT@` to the existing approved runtime roots. The
   `domino-public-data.target` owns three separate collector lanes:
   `domino-public-current.service`, `domino-public-history.service` and
   `domino-public-accounting.service`. Their CLI equivalents are
   `manage_public_data.py --lane current|history|accounting`. Keep the existing
   queue worker and catalogue follower, with the new drop-ins and bounded passes.
   The accounting lane reuses the activity/fee/position/capital reducers; it
   does not sign transactions or enable financial execution.
3. Point collectors and reader/gateway at the intended release. Import a useful
   legacy snapshot with `--import-snapshot` only from the operator's private path;
   its original observation times are retained. Current RPC and historical RPC
   routing use the existing private configuration. No key-bearing URL belongs in
   this document or release logs.
4. Enable `DOMINO_PUBLIC_DATA=1` in the reader and `--enable-v3` plus
   `DOMINO_BRIDGE_V3_READS=overview,history,search` in the gateway. The old
   `SnapshotRefresher` is disabled only when the durable public service is active,
   preventing a duplicate collector. Reload systemd and restart reader/gateway
   through `domino-continuous-reads.target`, respecting its existing egress
   dependencies. Activate `domino-public-data.target` separately.
5. Verify loopback capabilities, stored responses, process health and database
   progress before dispatching **Publish read path** from `main` with the exact
   `source_sha`, appropriate operation and `enable_public_data=true`. That input
   becomes `DOMINO_RELEASE_PUBLIC_DATA=true` in the publication helper. It adds
   only the production V3 tunnel routes and enables the three Worker routes.
   The app operation uses the existing recorded build/preview/production path.
6. Verify authenticated public requests and a real browser separately. Measure
   warm/cold reads, observation age, pending acquisition and refused admissions;
   a successful pending response is not completed data acquisition.

For rollback, first disable the Worker V3 capability and empty its enabled V3
route list while preserving all V1/V2 settings and secrets. **Dispatching with
`enable_public_data=false` does not disable an already enabled V3 release**: the
helper deliberately preserves existing flags. Stop the public-data target and
its scheduled workers before reverting their code/configuration, then restore
the prior reader/gateway release and flags through the continuous-read target.
Restore prior queue/follower drop-ins if reverting those components. Keep the
additive schemas and acquired observations; rollback requires no table drop,
checkpoint reset or destructive down-migration. The frontend falls back only
when the V3 capability is absent/disabled, not after a failed data POST.

## Verification and practical limits

Local evidence for routing/admission: the four-case original reproduction passes
with zero RPC calls; the affected Python regression run passed 142 tests before
the subsequent four-slot capacity extension. Worker/publication regressions
passed 229 tests; the final V3/runtime/publication subset passed 35. Pages
forwarder tests passed 49, workspace tests 33, and the dedicated ratio-history
tests 8. Frontend type checking and focused history lint passed. These counts are
overlapping suites, not an aggregate test total. The new capacity extension,
full integration, PostgreSQL deployment and live benchmarks have their own
verification records.

The 19 `test_public_history` tests also passed against the task-local disposable
PostgreSQL database, including publication more than 31 days later without
deleting prior swaps/candles, bounded reads after restart, reorg/lease fencing,
exact denomination, timestamp coverage and empty covered ranges.

A bounded [local ASGI/PostgreSQL qualification](../reports/public-stored-local-qualification-2026-09-20.json)
used 32 synthetic pools, two token metadata records and stored hourly ratio
candles. Pagination returned 24 + 8 unique pools. Before batched admission,
overview-six p50/p95 was 134/204 ms, overview-24 was 481/537 ms, and stored
history was 49/82 ms. Ten concurrent clients finished within 2.39 s with eight
bounded 429 refusals and no other errors. No RPC calls occurred.

The [single repetition after batching](../reports/public-stored-local-qualification-2026-09-20-batched.json)
confirmed **two connections per overview**, down from seven for six pools and
25 for 24 pools. That run coincided with strong Mac contention (observed load
averages 39.82/21.68/19.68): its overview-six p50/p95 was 924/1767 ms, overview-24
1635/3499 ms, and history 386/1121 ms. All ten concurrent clients completed in
16.59 s, with eleven 429 refusals and no other errors. These timings are not a
controlled before/after latency comparison. The evidence establishes reduced
connection count and bounded completion, not improved public latency. The
[reproduction script](../scripts/benchmark-public-stored.py) touches only
`domino_public_benchmark_tests`; it excludes TCP, TLS, Cloudflare, Access,
gateway and browser costs. VM and authenticated public measurements remain the
acceptance reference. No further local repetition was performed.

New-token discovery is limited to indexed/verified known pools and available
provider candidates; an empty result does not prove universal absence. Deep
history still depends on the configured historical source, exact metadata and
canonical coverage. Current state, provider analytics, ratio history and
accounting have independent readiness; a ready chart does not qualify APR,
liquidity accounting or execution. The 24h/7d/30d UI describes requested windows;
only actually acquired intervals count as covered. The three collector lanes
have finite budgets and share the host/RPC with existing services. No production
capacity envelope, latency SLA or backfill completion ETA is established by
the local tests above.
