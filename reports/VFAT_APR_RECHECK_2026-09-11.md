# VFAT APR and position analytics: current bounded check

11 September 2026, 17:54–17:57 UTC. Rechecked the public [MCP](https://vfat.io/mcp), its read-only discovery/history operations and one documented REST operation. Curated requests, responses and schema excerpts are in `vfat-apr-evidence-20260911.json`. No wallet, credential, quote, transaction, installation or backfill was used.

**VFAT can supply a useful attributed pool APR immediately when it indexes the pool. It cannot be the sole source for arbitrary Robinhood tokens, or substitute its APR directly for Domino's rolling 24-hour pool or managed-position fee APR.**

## Concrete current coverage

The live server remains `vfat-mcp-server` 0.2.0 and now lists 37 tools. Robinhood chain 4663 is present with the expected WETH address. Exact PoolId discovery succeeded for WETH/USDG and returned no records for the tested MARLIN/USDG PoolId.

| MCP observation | WETH/USDG | MARLIN/USDG |
| --- | --- | --- |
| Response time UTC | 17:55:06.048 | 17:55:05.972 |
| Exact PoolId | `0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6` | `0xdb922f0619e11b0c1e6c3a142798f0243060b8a4331ea4f4e7de80e898cc02e7` |
| Provider APR | 99.11991209591886% | unavailable |
| Total liquidity USD | 460,335.5130700758 | unavailable |
| Active liquidity USD | 383,997.4070168759 | unavailable |
| APR basis | 7 days; active pool liquidity; assumes full time in range | no matching opportunity |

The WETH response specifies `UNISWAP_V4`, fee 200 pips, tick spacing 4 and the expected WETH/USDG addresses. These are provider identity claims, cross-checkable against Domino's existing independently verified pool identity; this probe itself did not execute new RPC verification. A shared v4 manager address does not uniquely identify a pool.

## Practical integration

The [public OpenAPI](https://api.vfat.io/openapi.json) exposes `GET /v4/yield-opportunities`. Use chainId, an exact PoolId search, bounded pagination and `aprMode=default`; then validate the returned chain, full PoolId, currencies, type and fee. The MCP supplies equivalent discovery through `search_yield_opportunities`.

A direct no-key request to the documented REST path succeeded with HTTP 200 at 17:56:41 UTC. It returned one exact WETH record, APR 99.18059462330905%, with the same seven-day basis. This was a later observation than the MCP result above. The response advertised shared-cache freshness of 60 seconds plus 60 seconds of stale-while-revalidate. Its rate headers reported limit 5, remaining 4, reset 1; these observed headers are not an SLA or a verified contractual quota.

Preserve `aprBasis`, source and retrieval time alongside the estimate. The MCP `asOf` and HTTP Date do not establish when all underlying fee and liquidity observations were published. Keep this as a separately labeled **VFAT fee APR estimate (7d)**. Do not write it into an existing field meaning `feeApr24h`, take `maxApr` as a normal outcome, or treat a discovery miss as zero return. Generic token support still needs another provider or an unavailable state when VFAT misses the pool.

## How VFAT calculates and prepares the data

Its [APR documentation](https://vfat.io/docs/aprs) separates swap-fee APR from token rewards. Fee estimates generally use seven days and eligible liquidity; younger pools use their available age with at least a one-day observation window. Concentrated-liquidity estimates depend on range. APR/APY selection changes the presentation, not realized earnings. The live `aprBasis` is more precise than a generic APR label and must travel with the number.

`get_pool_history` / `GET /v4/pool-history` serves prepared closed buckets: 30 UTC days, or 24 closed hours for pools younger than seven days. Missing history does not trigger live backfilling. This is an architectural pattern worth adopting: prepare asynchronously and respond promptly with explicit coverage.

The WETH request for 9–10 September returned exactly two daily points, untruncated, with preparation ready and provider `feeGrowthStatus.quality=exact`. For 10 September it reported volume $4,504,174.848697801, LP fees $900.8349595380614, snapshot TVL $415,945.6923074202 and snapshot time 23:00 UTC. However, `activityCompleteness` remains `unverified`. Daily `aprPercent` is a separate saved APR estimate, not proved to equal that day's fees divided by that day's TVL. Snapshot TVL is not a time-weighted capital integral.

These closed daily buckets do not supply the current rolling 24 hours. The tested WETH pool predates the seven-day hourly eligibility window. Price ratios/OHLC and provider USD valuations are useful attributed history, but their availability and provenance do not by themselves qualify causal historical USD prices for Domino accounting. The prior price-source assessment remains unresolved.

## Managed-position lessons

The live schema provides `get_position_performance` for VFAT Sickle positions and `get_position_performance_history` keyed by chain, Sickle and stable root token ID. It explicitly carries lineage, capital exposure in USD-days, external cash flows, ROI/APR, status, quarantined/unpriced legs and source freshness. This supports Domino's planned lineage-aware accounting and separation of missing data from real zero.

It measures **net position performance**, not a dedicated trading-fee APR. Its current-position P&L includes principal plus external cash flow and pending rewards; estimated swap fees substitute when rewards are zero or absent. Historical P&L excludes pending rewards and estimated swap fees. The exposed schema does not document enough detail to reproduce its exact APR denominator/annualization formula. No arbitrary Domino NFT coverage or live performance response was claimed or tested.

For Domino, reuse the design pattern rather than assuming interchangeability: keep pool discovery APR separate from actual strategy fee income; preserve fee-credit lineage across reinvestment/children; track complete capital exposure and costs; update the card from a cached read model. Existing VFAT Sickle accounting is not a producer of Domino executor receipts.

## Decision

An optional bounded, cached VFAT adapter is appropriate for external pool comparisons. It simplifies discovery where coverage exists. It does not remove the need for Domino's own managed-sequence ledger, or justify blocking entry while rebuilding pool history. Commercial redistribution conditions, support commitments and source publication semantics remain unverified before relying on the hosted API as a public-app dependency.
