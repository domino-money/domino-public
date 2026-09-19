# Frontend data latency — production, 19 September 2026

The reported lag is reproducible. The dominant measured delay is the application's
serialized read pipeline and admission limits. Separate defects explain why some
values never update and why historical activity is days behind. The local RPC was
fast and synchronized during this investigation.

## What was measured

Production `https://domino.money`, authenticated beta, from the operator's Mac;
reader/gateway on `domino-alpha`; Nitro/edge/tunnel on `clawber`. Reader release:
`b2dcc8cf1da3bb4126e3dbc0285189889551841a`. Audited application source:
`bc336b5`. Observed public asset: `/assets/index-D30hKfvI.js`.

Three independent cold **frontend data-pipeline** runs use the actual app loader,
scheduler, transports and contract validators. They are not browser paint or
interaction timings. The real browser independently reproduced the sequential
requests and displayed the resulting data. Runs 2 and 3 started after 65-second
pauses between benchmark runs; normal service traffic continued. Login and local
TypeScript compilation are outside the measured load. Each run made 17 HTTP
calls: 2 capabilities GETs, 13 successful
POSTs (6 markets + 7 token metadata reads), and 2 retried 429s. All six rows
completed without unresolved problems. No wallet or transaction was involved.

| Measurement | Run 1 | Run 2 | Run 3 |
| --- | ---: | ---: | ---: |
| First row emitted, metadata may still be pending | 1.55 s | 0.59 s | 0.84 s |
| All six rows emitted, metadata may still be pending | 19.36 s | 19.03 s | 15.12 s |
| Entire selected-pool load settled | **21.24 s** | **21.18 s** | **19.46 s** |
| Scheduler/retry waiting | **14.51 s** | **15.53 s** | **13.53 s** |
| Aggregate HTTP fetch/body time | 6.64 s | 5.63 s | 5.91 s |
| Median successful data POST | 374 ms | 348 ms | 380 ms |

Waiting accounts for **68–73%** of the end-to-end data load. With only three page
runs, these are observations, not a statistically qualified page-load p95.

Bounded local API checks made three requests per case, with starts at least
1.2 seconds apart. No load saturation test was run.

| Reader operation, loopback on VM | Median | Maximum | Successful samples |
| --- | ---: | ---: | ---: |
| Stored snapshot of six pools | **2.82 ms** | 13.04 ms | 3/3 |
| Token metadata | 275 ms | 325 ms | 3/3 |
| Pool market, no chart | 239 ms | 272 ms | 3/3 |
| Pool market with chart | 227 ms | 683 ms | 3/3 |
| Pool metrics | 227 ms | 228 ms | 3/3 |
| Explicit pool lookup | 595 ms | 635 ms | 2/3; one 429 |

These API timings include normal cache effects. A 3 ms stored response is not a
promise of a 3 ms frontend: network, validation, missing metadata and freshness
requirements remain.

The RPC comparison used 20 samples per method/route at a maximum aggregate rate
of 2 requests/second, on `eth_chainId`, `eth_blockNumber` and the latest header.
Nitro p95 was **0.95–1.06 ms**, and the authenticated HTTPS tunnel p95 was
**56.25–60.56 ms**, with no errors. A fixed block hash matched the official
reference at block 67,452,103. Median latest-block age was 0.777 seconds. Host CPU
busy was 1.69%, iowait 0.16%; the edge had zero 429s in the observed 15-minute
window. These are lightweight RPC calls, not archive/log capacity qualification.

## Causes and their evidence

### 1. The existing fast path is not enabled in production

The live Worker capabilities and gateway process environment both list:

```text
token,pool-market,pools,catalogue,nft-positions,wallet-assets,pool-activity
```

`markets-snapshot` and `pool-metrics` are absent. Consequently the frontend skips
the available stored snapshot and performs six individual market reads plus
seven token reads. This is not a guess from a checked-in example configuration:
both actual runtime surfaces were read.

The source implements this choice in `app/src/lib/read/marketsProvider.ts`, and
`app/src/lib/read/scheduler.ts` serializes the whole load, spaces starts by at
least 1.1 seconds and observes burst 5 / 30 reads per minute. Those protections
are necessary for the current backend design; simply deleting waits or firing
all requests concurrently would increase refusals.

The snapshot alone does not contain the v2 APR estimate. Enabling it without
checking consumer behavior could remove currently visible estimates. Its six
observations were also of different ages (roughly 25–160 seconds in the first
sample), so their timestamps must remain visible and accurate.

### 2. Admission refusals amplify the waterfall

All three public pipeline runs received two `read_capacity_busy` responses. The
read/gateway journals locate them above the RPC: reader admission sometimes
refuses a request admitted by the gateway; other refusals happen at the gateway's
per-client budget before `/health` is called. The RPC edge had no rate refusals.

The initial real-browser load also met a gateway 429 while the snapshot refresher
held the reader's provider slot. The next successful market call came about ten
seconds later. The frontend honors Retry-After while its serialized queue waits.

A hermetic diagnostic using the real ASGI applications proves an additional
admission defect: the gateway applies reader `health.busy` to catalogue and
snapshot requests, although those response paths need no RPC. Both return 429
with a 10-second hint under a held provider slot. The gateway also classifies
`markets-snapshot` as provider work even though the reader serves it outside that
slot. Fixing just the public route list would leave this defect in place.

Route classification must reflect actual work: `pool-metrics`, despite a stale
comment describing stored-only work, performs RPC canonicality checks. The
separate development gateway must also release exactly the slot it acquired.

### 3. Successful values do not refresh automatically

`createReadMarketsProvider.ensure()` starts once; quiet recovery retries specific
failures rather than refreshing successful observations. The displayed clock
only increases age labels. Navigation within the same app reuses that state.
Thus a fully successful page can remain stale until a reload even while Nitro
and the VM continue advancing. Chart loads also wait for the overall market
loader to reach its ready state (`MarketCarousel.ts`), adding another waterfall.

### 4. Provider analytics remain a separate dependency

Current pool state uses the local RPC; provider TVL, volume and hourly candles
still use GeckoTerminal. Two markets in run 1 returned `provider_rate_limited`
with retained observations 108 and 133 seconds old. Run 2 had no stale markets;
run 3 had two aged 87 and 90 seconds. Stale provider observations were already
present in the first VM snapshot before the repeated pipeline benchmarks.

Improving Nitro cannot remove this provider rate limit or make a retained
analytics observation current. Shared refresh, deduplication and source-aware
refresh cadence are needed; retrying every visible row more frequently would
increase pressure on that dependency.

### 5. Historical activity stops, independently of the current RPC

The activity queue contained **15 pools marked `following`**, but its claim list
contains only `queued`, `indexing` and `registering`. Reaching the initial target
therefore removes a pool from subsequent processing. No separate activity
follower is installed. The catalogue follower is active, but it indexes a
different dataset and does not advance pool activity.

For WETH/USDG, activity stopped at block **64,744,074**, approximately **3.16 days**
old; `following` was recorded on 16 September, before the local RPC activation.
The two remaining `indexing` pools repeatedly request 100,000-block log ranges
that Alchemy rejects with HTTP 400 / -32602 for response size. The same starting
points and filters succeed with 1,000-block ranges in about 700 ms. They had
4,329 and 3,866 attempts. This is not bad authentication or an unsynchronized
local node.

The queue worker still runs its older deployment and Alchemy source. There are
also zero fee, position and capital chunks: advancing activity alone will not
produce qualified financial history. Full VM/DB evidence and the four controlled
log calls are recorded in [backend freshness](backend-freshness-2026-09-19.md).

The live WETH/USDG page independently confirmed this distinction: current pool
price was verified at block **67,454,826**, provider TVL/volume said retrieved
81 seconds ago, and its On-chain activity panel explicitly reported **3 days**
behind at block **64,744,074**, withholding the 24-hour figures.

## Correction order supported by this investigation

1. Correct route-aware gateway admission, then expose a verified snapshot path
   through Worker and gateway. Preserve APR estimates and per-source ages; include
   or cache validated token metadata so every new tab does not need seven RPC-backed
   metadata requests. Compare with this baseline before changing rate ceilings.
2. Refresh successful visible data at a bounded cadence, pause when hidden, retain
   original observation times, and prioritize the selected pool/chart instead of
   waiting for unrelated rows. Keep shared per-client budgets and cancellation.
3. Restore continuous activity scheduling for caught-up pools and split log ranges
   on the demonstrated provider overflow. Verify a single retained checkpoint
   first. Merely adding 17 pools to a two-pool/minute queue implies at least 8.5
   minutes between visits, so that alone cannot satisfy 120-second freshness.
4. Treat accounting history and external analytics as separate freshness tracks.
   Do not substitute missing history with current values or relabel stale values.

No production code, route list, service, database status, security policy or
indexing cadence was changed by this investigation. Normal read-cache updates
occurred. There is no persistent monitor or AI watcher. The development access
window expired at 22:47:32 UTC; all public measurements here used production,
which does not share that expiry.

## Reproducible artifacts

- [Three frontend runs and aggregate summary](frontend-data-benchmark-summary-2026-09-19.json).
- [Reader samples](local-read-latency-2026-09-19.json).
- [RPC samples and host/edge observations](rpc-latency-2026-09-19.json).
- [Initial browser load, sanitized hop records](browser-initial-read-hops-2026-09-19.json).
- [Frontend pipeline harness](../scripts/benchmark-frontend-data.mjs): password through
  private stdin, cookie in memory, fixed production origin, bounded request count.
- [Local API harness](../scripts/benchmark-local-read-latency.py): run on the VM.
- [Admission diagnostic](../scripts/benchmark-read-admission.py): run with the backend
  Python environment; no network or production state, no failing tests added.
- [Frontend source audit](FRONTEND_DATA_LATENCY_AUDIT_2026-09-19.md): code locations,
  metadata readiness and scheduler calculations.
