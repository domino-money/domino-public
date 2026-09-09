# Core trading-fee qualification

9 September 2026. Local API 0.5.0; activity methodology 1 plus independent trading-fee methodology 1. No production rollout or external audit is claimed.

## Delivered

The backend reconstructs core swap fees at step precision, separates LP/protocol allocations, keeps donations separate, and reconciles both global fee-growth counters before persisting a fee chunk. Supported accounting currently covers hookless fixed-fee pools; it depends on full activity from a verified Initialize. Currency identity is address based, with no MARLIN or stablecoin whitelist. Hook/dynamic-fee candidates retain ordinary read support.

The independent fee migration preserves activity v1 records. Per-swap fee rows and cumulative counters commit atomically. A lagging fee ledger cannot populate a newer activity snapshot. Source-chunk reorg deletion cascades through fee checkpoints and event rows. Ambiguous swap reconstruction, mismatched counters, missing rows and exceeded work budgets fail closed. Errors do not trigger nominal-fee estimates.

## Independent reference and automated checks

- **139 tests passed**, including **37 using PostgreSQL** and two using a temporary local Anvil chain. Existing discovery, inventory, catalogue, HTTP boundary and activity checks remain in the suite.
- **1,024 swap-step comparisons** and **128 tick roundtrips** against compiled original Uniswap math. Coverage includes both directions, exact input/output, extreme prices, large liquidity, tiny amounts, rounding, zero fee and 100% fee.
- **Four original Pool sequences**, 27 recorded events and 11 swaps: changing and overlapping liquidity, a shared initialized boundary with zero liquidity net, bitmap-word crossings, empty liquidity tails, price-limited swaps, donations, fee pokes, protocol changes, protocol-only fees and zero-amount swaps. Global growth and protocol allocations match the native reference after each event.
- Persistent tests cover old-model qualification, resume, lagging ledgers, failed RPC/state/growth reconciliation, omitted swap rejection, reorg invalidation/cascade, writer serialization, incomplete event detection, actual dump/restore and read-role restrictions.
- Additional domain checks cover uint256 growth wrapping, immutable input replay, token-independent arithmetic, unsupported adapters, tick extremes and ambiguity/budget rejection.

Reference: [v4-core commit 46c6834](https://github.com/Uniswap/v4-core/tree/46c6834698c48bc4a463a86d8420f4eb1d7f3b75). Original files and licenses are preserved with SHA-256 provenance under `backend/tests/reference`; the original Pool implementation is used only in the non-production test harness. No public contract was deployed. This is a differential qualification, not an independent security audit.

## Real Robinhood reconciliation

The worker re-read canonical block hashes and StateView at all **seven** stored chunk ends. Both global growth counters and other stored pool state matched exactly. Activity coverage was preserved; this step did not expand the global pool catalogue or pretend to have 24 hours of new observations.

| Sample | Indexed interval | Swaps | Trading LP fees, currency0 / currency1 base units | Protocol fees |
|---|---|---:|---|---|
| Native ETH / `0x9b21…abd6`, PoolId `0xc613…30ef` | 58,738,261–58,772,342 | 4 | `30019990360000` / `14368267552723199215615` | `0` / `0` |
| WETH / `0xfb65…a12`, PoolId `0xb267…230a` | 58,738,242–58,748,241 | 0 | `0` / `0` | `0` / `0` |

In the trading sample, protocol rates were enabled after all four recorded swaps. The current protocol rate therefore does not retroactively charge those swaps. Native ETH LP allocation is `0.00003001999036 ETH`; no USD conversion or unverified token decimals are applied.

Evidence: [trading sample](fee-ledger-live-2026-09-09.json), [zero-swap control](fee-ledger-zero-2026-09-09.json), and [actual HTTP responses](fee-ledger-http-2026-09-09.json). Both HTTP cases passed with reconciled fee quantities, canonical hash rechecks and explicit stale status. Their snapshots cover 3,438 and 1,008 seconds of pool age respectively, so `completeWindow` and `usableAsCurrent24h` remain false.

An actual [database restart check](fee-ledger-storage-2026-09-09.json) preserved both responses exactly, including seven fee chunks and four per-swap fee rows. The temporary API, Anvil and task-local PostgreSQL processes were stopped after qualification. Public observations and provider configuration remain stored locally. OpenAPI matches API 0.5.0; the credential-URL exclusion scan and `pip check` passed.

## Meaning and limits

`lpFeesRaw` measures the core fee portion assigned to LPs before Q128 distribution rounding. It is not a position's collectible balance, a wallet balance or Domino's 2% service charge. Donation growth is reconciled but excluded from trading fees. Position fee claims, settlement, distribution dust, pool-attributed assets and time-weighted TVL still need separate accounting.

This stage uses one configured RPC provider and historical state reads. Counter agreement strengthens evidence but does not prove completeness of all event delivery. It does not qualify hook accounting, token transfer behavior, USD valuation, a full-day APR, rankings or execution permissions. A reconstruction the current algorithm cannot uniquely identify returns unavailable.

Next: reconstruct position fee liabilities and pool-attributed balances, reconcile tick/position state, then qualify timestamp-aligned prices and complete-day metrics. Authentication, wallet-connected onboarding, public vault execution and cloud hosting remain separate delivery work. The public preview and personal operating bot were not changed.
