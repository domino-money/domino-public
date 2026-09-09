# Core position and asset qualification

9 September 2026. Local API 0.6.0; core-position methodology 1. This is a backend accounting milestone, not a public alpha rollout or external audit.

## Delivered behavior

The backend reconstructs each core position's liquidity, principal, fee-growth debt and settled fees, using the PoolManager caller, range and opaque salt as identity. Different salts or callers sharing a range remain separate. It follows tick initialization, crossings, clearing, fee pokes, additions, partial removals, closure and reopening with integer rounding and uint256 growth wrapping.

Pool-attributed token flow is split into principal, unsettled fees and rounding residual. Protocol fees are excluded; donations contribute to LP-owned accounting and position fee liabilities. The reader publishes values only after the corresponding fee checkpoint and all known position/tick state match StateView at one historical block. Newer activity cannot reuse an older position balance. Errors, reorgs, unsupported adapters and capacity limits return unavailable rather than partial or estimated position totals.

`POST /v1/read/pool-positions` exposes the individual core records. `liquidity.positionAccounting` adds aggregates to the existing activity response. Amounts are integer strings ordered currency0/currency1. The API retains explicit historical freshness, `nftOwnershipResolved: false`, `isWalletBalance: false`, `isWithdrawalQuote: false` and disabled execution.

## Verification

- **161 tests passed**, including **49 PostgreSQL tests** and **three native EVM test methods**. Existing discovery, catalogue, RPC boundary, activity and trading-fee checks remain in the suite.
- The pinned original Uniswap Pool/Position implementation supplied a new **20-event reference sequence** with three distinct core positions, four swaps and 12 liquidity modifications. Each state compares position liquidity, last/inside fee growth, unsettled fees, principal, tick state and pool-attributed flows. Cases cover shared ranges with different salts, different owners, fee pokes, partial withdrawal, full closure, zero-liquidity price movement and reopening.
- Native modification return values independently verify principal flow and fee settlement. Temporary native full-removal calls check the corresponding principal/fee arithmetic without altering the reference state. These are isolated library tests with no token settlement or wallet authorization.
- Existing native tests still compare **1,024 swap steps**, **128 tick roundtrips** and four trading-fee Pool sequences. The new position path rejects differing crossing-growth interpretations even when final trading-fee totals agree.
- PostgreSQL tests verify qualification prerequisites, exact position/inside/tick comparisons, bounded failure, checkpoint resume, lagging-data gates, failed reads, source reorg cascades, reorgs during reconciliation, writer serialization, incomplete settlement audits, reconciliation-metadata checks, actual backup/restore and reader grants. HTTP tests verify request validation, unavailable/orphaned snapshots, numeric precision and core-owner scope.

Reference source: [v4-core revision 46c6834](https://github.com/Uniswap/v4-core/tree/46c6834698c48bc4a463a86d8420f4eb1d7f3b75). Original sources and licenses remain isolated under `backend/tests/reference`; the executable reference uses a temporary local chain with no fork. This is differential testing and on-chain reconciliation, not an independent security audit.

## Real Robinhood evidence

All **seven historical chunks** across the existing two pools passed full pool, core-position, range-inside and tick-state rechecks. Each pool has one known core position and two known tick boundaries. Global activity coverage remains 34,082 and 10,000 blocks respectively.

| Sample / base-unit pair | Principal | Unsettled fees | Rounding residual |
|---|---|---|---|
| `0xc613…30ef`, currency0 (native ETH) | `31624503724354` | `30019990359999` | `2` |
| `0xc613…30ef`, currency1 | `749984672529190633374461694` | `14368267552723199215614` | `4` |
| `0xb267…230a`, currency0 (WETH) | `0` | `0` | `0` |
| `0xb267…230a`, currency1 | `999999999999999999999791` | `0` | `1` |

In each currency, those three columns sum exactly to the reconstructed `lpAssetsRaw`. The control pool has zero active liquidity at its snapshot but retains nonzero principal outside its range. No dollar value or assumed token decimals were used. Trading-fee allocation and unsettled position fees differ by smallest-unit distribution rounding; neither represents a new Domino service charge.

Evidence: [trading-pool position reconciliation](position-ledger-live-2026-09-09.json), [control position reconciliation](position-ledger-zero-2026-09-09.json), and [actual HTTP qualification](position-ledger-http-2026-09-09.json). Both HTTP cases passed with canonical hash rechecks and exact aggregate/per-position sums. Individual core owner/salt records were omitted from the saved HTTP artifact. The historical snapshots are stale and represent 3,438 and 1,008 seconds of pool age; they do not establish a full-day metric.

An actual [database restart](position-ledger-storage-2026-09-09.json) preserved the full detailed responses, all seven position checkpoints and both real modification records. OpenAPI matches API 0.6.0, the provider-URL exclusion scan passed, and `pip check` found no broken requirements. Temporary API, reference EVM and task-local PostgreSQL processes were stopped after qualification; public observations remain stored.

## Limits and next gate

Core owner is often PositionManager; it does not identify the NFT holder. Salt is not interpreted as an NFT token ID. Settled fees are amounts credited by core accounting at a modification, which may offset newly added principal; they do not prove an external wallet withdrawal or deposit. Aggregate token flow is not the shared manager's cash balance. Rounding residual is recorded separately from position liabilities.

The current worker supports hookless fixed-fee pools with up to 128 lifetime core identities and 256 known boundaries, including closed/cleared entries. RPC, event and swap-work limits are enforced. Larger pools need a reviewed reconciliation workflow that batches this work; values are not truncated to fit. Qualified arbitrary-token reads remain independent of accounting admission.

One configured provider supplies event/state evidence. Matching state strengthens consistency but does not prove complete provider delivery, permission to withdraw, token-transfer compatibility, owner attribution or full 24h coverage. Public UI integration, wallet authentication, owner/NFT mapping and execution remain unfinished. Next analytics work is event-time asset history, qualified historical prices and time-weighted TVL/APR. Personal-bot operations and financial contract implementations were not changed.
