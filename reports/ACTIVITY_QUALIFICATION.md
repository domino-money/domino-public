# Core pool activity — API 0.4.0

9 September 2026. Local implementation and read-only Robinhood mainnet qualification. This slice adds persistent per-pool activity and rolling raw-unit summaries. **It does not yet provide qualified USD volume, TVL, earned LP fees or APR.**

## Delivered

- Applied `002_activity.sql` to the separate public activity schema, retaining the earlier pool catalogue.
- Added a bounded worker that registers a verified initialization, stores core events and reconstructs range liquidity.
- Added atomic event/model/checkpoint persistence and confirmed-reorg rollback/replay.
- Added rolling 24h boundary handling, observed-age reporting, donation separation and exact per-currency swap legs.
- Added `POST /v1/read/pool-activity`, with strict PoolId input, canonical block recheck and explicit historical freshness.
- Exported API 0.4.0's OpenAPI request contract and retained the tested dependency set.

The implementation uses any catalogued pool identity supplied to the worker. The two examples below are qualification samples, not a runtime token or pool admission list. Older observation-only candidates need their Initialize block verified before full-history activity replay; broad archive/backfill capacity is not yet qualified.

## Live evidence

| Pool | Indexed interval | Core events | Swaps | Observed history |
|---|---|---:|---:|---:|
| `0xc613…a30ef` — native ETH / `0x9b21…4abd6` | 58,738,261–58,772,342 | 10 | 4 | 3,438 seconds |
| `0xb267…4230a` — WETH / `0xfb65…fea12` | 58,738,242–58,748,241 | 6 | 0 | 1,008 seconds |

The first pool was initially indexed across 10,000 blocks, then a new worker process resumed for another 5,000 without reimporting the previous events. A final bounded catch-up extended it to 34,082 blocks, reaching the observed head minus 200. The second was indexed across 10,000 blocks. Each completed chunk reconciled its ending price, tick, protocol rate and active liquidity with StateView.

Evidence: [first pool indexing](activity-index-2026-09-09.json), [second pool indexing](activity-zero-index-2026-09-09.json), [process resume](activity-resume-2026-09-09.json), [historical HTTP results](activity-http-2026-09-09.json), [bounded catch-up](activity-catchup-2026-09-09.json) and [fresh HTTP check](activity-fresh-http-2026-09-09.json).

The first stream contains one initialization, one liquidity change, four swaps and four protocol-fee update events. Its native-ETH swap legs total **3,001,999,036,000,000 wei input** and **2,940,354,541,915,645 wei output**. These are separate traded legs, not USD volume, earnings or transaction gas. The other currency's exact quantities remain in the JSON artifact.

All four swaps reported 10,000 pips (1%) before the protocol fee was enabled in this pool. Its later snapshot has a 10,000-pip LP fee and 1,000 protocol pips per direction. This sampled ordering demonstrates why applying the final protocol configuration retrospectively would misclassify historical fees.

The zero-swap pool still has a recorded liquidity range, while its active liquidity at the checked tick is zero. The API reports zero observed swaps and zero active liquidity, but **does not infer zero TVL**. Its liquidity may be outside the active range.

Both pools were younger than 24 hours at the indexed snapshots, so `completeWindow` remained false. The first HTTP checks ran against historical snapshots and correctly labeled them stale. After catch-up, the first pool's snapshot was 93 seconds old and correctly labeled fresh. Its `usableAsCurrent24h` still remained false because its observed age was less than one hour. No full 24-hour financial metric was claimed from these short observations. No donations occurred in the live sample; their separation is covered by deterministic tests.

## Verification

**120 backend tests passed**, including **29 tests against PostgreSQL**. The new activity slice adds 28 tests to the previous 92. The tests cover exact large integers, ABI/pool identity rejection, range adds/removes, zero-delta pokes, tick-boundary inclusion, directional protocol-fee composition, rolling timestamp boundaries, donation isolation and absent-versus-zero history.

PostgreSQL checks cover restart through new connections/processes, state mismatch rollback, in-transaction network failure, missing liquidity events, identical/conflicting duplicates, writer serialization, timestamp regression, reorg invalidation of totals, full-window rewind and a real `pg_dump`/`pg_restore` roundtrip. Restore uses a separate disposable database and checks reader grants. These are public-data tests; private-account RLS remains unimplemented. The live personal bot and its permissions were not modified.

Dependency validation passed. The existing Starlette TestClient deprecation warning remains non-failing; no unrelated dependency migration was performed. Final local qualification services are stopped after checks, with database contents retained.

## Scope and operating limits

The catalogue's global Initialize coverage and each pool's activity coverage are independent. The previous catalogue remains at 217 pool identities; activity indexing does not imply all of them have metrics. No continuous worker, production scheduler, cloud deployment or public UI connection is enabled.

The activity worker handles one pool per command, up to 50 chunks per run and 10,000 blocks per filtered query. It uses a 2 MB response bound, 2,000 decoded events per chunk, 300 RPC requests per worker instance and a 5,000-range model bound. The HTTP aggregate reads at most 50,000 swap/donation events from its rolling window. Oversized or incomplete local processing fails without advancing that chunk; reduce the span when needed. These are development budgets, not throughput guarantees. Silent provider log omission still requires independent reconciliation.

Targets are at least 200 blocks behind the observed head. This is a development lag, not settlement finality. The configured Alchemy account accepted the sampled 5,000-block and 10,000-block filtered requests; its larger historical capacity and production economics are not inferred from that result.

StateView validation covers core price, tick, protocol rate and active liquidity. It does not reconcile position-level fee collections, all token liabilities or hook-side balances. USD valuation also needs qualified price history. The remaining accounting and valuation work is specified in [metrics methodology](../METRICS_METHODOLOGY.md); startup, indexing and test commands are in the [backend runbook](../backend/README.md#core-pool-activity--api-040).
