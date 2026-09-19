# Frontend data latency audit — 19 September 2026

Scope: the deployed product is `app/`, exposed through Cloudflare Pages at
`domino.money`; `web/` is not the production frontend. Code inspected at
`bc336b54c896861253fc14a2321fd44998687269`. No product code or deployment was
changed by this audit.

## First production benchmark

[`frontend-data-baseline-2026-09-19.jsonl`](frontend-data-baseline-2026-09-19.jsonl)
records one cold six-pool Markets load using the actual compiled app loader,
scheduler, bridge pipeline and contract validators against the production API.
It excludes bundle download, React/DOM paint, chart requests and quiet recovery.
The beta password entered through stdin; the cookie remained in process memory.

| Observation | First run |
| --- | ---: |
| First row delivered to the consumer | 1.549 s |
| First row's token metadata reads settled | 4.277 s |
| All six rows delivered | 19.361 s |
| All token metadata reads settled / load completed | 21.242 / 21.243 s |
| Explicit pacing and retry waits | 14.509 s |
| Sum of HTTP request durations | 6.639 s |
| Responses | 15 × 200; 2 × 429 |

Metadata settled does not prove decimals, a valid price or a browser paint.
The first-run metadata timings above were derived from `tokensPending` in its
recorded progress events. Later harness versions emit those timings directly as
`firstPricedRowMs` and `allPricedRowsMs`, with an explicit interpretation label.

The public V1 capabilities response lists `token`, `pool-market`, `pools`,
`catalogue`, `nft-positions`, `wallet-assets`, and `pool-activity`.
**It does not list `markets-snapshot` or `pool-metrics`.** V2 lists `pool-market`.
The actual successful data workload is consequently six V2 pool-market requests
and seven V1 token requests, plus two capabilities GETs. Two token requests were
retried after HTTP 429 with `Retry-After: 1`. This explains why the existing
snapshot optimization is absent from the production waterfall; it is not a
failure to render a returned snapshot.

## Evidenced causes

1. **Many round trips, deliberately serialized.** The market loader reads each
   market and then its missing token metadata before advancing to the next pool
   ([`marketsProvider.ts:407`](../app/src/lib/read/marketsProvider.ts#L407),
   [`:355`](../app/src/lib/read/marketsProvider.ts#L355)). One shared scheduler
   waits for each operation to finish, enforces 1.1 s minimum start spacing,
   and preserves a five-read burst followed by 30/minute
   ([`scheduler.ts:52`](../app/src/lib/read/scheduler.ts#L52),
   [`:115`](../app/src/lib/read/scheduler.ts#L115),
   [`appSourceBridge.ts:19`](../app/src/lib/read/screens/appSourceBridge.ts#L19)).
   For thirteen successful POSTs, the last start cannot precede 16.5 s after the
   first, even with zero upstream duration; retries and transit increase that.
   In the measured run, explicit waits account for approximately 68% of the load.

2. **The bulk snapshot route is disabled at the public capability boundary.**
   The loader checks capabilities and requests the snapshot only when listed
   ([`marketsProvider.ts:372`](../app/src/lib/read/marketsProvider.ts#L372)).
   A usable snapshot would emit all stored rows together, but still require
   metadata and selected follow-up reads. Enabling it must first confirm current
   stored observations and capacity across the gateway/reader; the frontend must
   preserve unavailable/stale states and estimates, which V1 snapshots do not hold.

3. **Visible charts wait for unrelated rows.** `MarketCarousel` considers data
   ready only after the entire market load settles
   ([`MarketCarousel.ts:124`](../app/src/components/markets/MarketCarousel.tsx#L124));
   its candle requests cannot begin before that
   ([`:196`](../app/src/components/markets/MarketCarousel.tsx#L196)). In the first
   pipeline run that readiness boundary is already 21.243 s, before chart network
   time. The harness does not measure chart completion.

4. **Successful observations are not refreshed automatically.** `ensure()`
   starts once per provider/document
   ([`marketsProvider.ts:763`](../app/src/lib/read/marketsProvider.ts#L763));
   automatic planning only recovers specified failures/busy providers
   ([`:647`](../app/src/lib/read/marketsProvider.ts#L647),
   [`:672`](../app/src/lib/read/marketsProvider.ts#L672)). The one-second clock
   explicitly never schedules network refreshes
   ([`useNow.ts:4`](../app/src/lib/read/useNow.ts#L4)). The manual Refresh control
   is diagnostic-only ([`MarketsTable.ts:350`](../app/src/components/MarketsTable.tsx#L350)).
   Thus data can remain old indefinitely in an open successful page, while its
   age label advances; a fast synchronized RPC cannot correct this UI lifecycle.

5. **Additional latent waterfalls exist outside this production workload.**
   The scheduler still shares one queue although the backend has separate stored
   and provider slots ([`read_api.py:112`](../backend/read_api.py#L112)). Current
   public capabilities omit pool-metrics, so six extra metrics reads are *not*
   included in the first-run causal count. The pool detail page additionally
   verifies the pool, reads stored/live market figures, and gates ancillary reads
   on a market answer ([`PoolWorkspace.ts:156`](../app/src/components/read/screens/PoolWorkspace.tsx#L156),
   [`:176`](../app/src/components/read/screens/PoolWorkspace.tsx#L176)).

## Focused next changes and regression checks

- Restore the snapshot path end-to-end when its stored data is operational; test
  one initial bulk read, stale/missing fallback, preserved provenance and APR.
- Reduce per-row metadata work through validated shared/bulk data, or introduce
  an appropriate stored-read lane while retaining the shared per-client budget.
  Do not blindly parallelize provider reads into the existing single slot.
- Schedule a visible card's chart from that row's readiness; verify other pools
  cannot delay it and that navigation cancels only unneeded work.
- Add bounded, visibility-aware refresh for successful data, keeping previous
  observations on screen with their original timestamps; test elapsed freshness,
  page hide/show, cancellation, busy backoff and unchanged read budgets.
- Re-run the same bounded pipeline and a browser paint trace after any change.
  The harness now emits an absolute UTC start and a fixed benign user agent for
  correlation. No additional production benchmark was run for this audit update.
