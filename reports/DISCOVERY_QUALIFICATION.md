# Robinhood discovery — first implementation and measured coverage

9 September 2026. The onboarding and pricing proposals are approved for implementation. This report records the first read-only integration slice; the functional alpha still requires wallet-funded creation, Auto-compound and Domino.

## Outcome

The implemented Python reader found and verified all **17 Uniswap v4 candidates returned for MARLIN** in this sample. This is provider-candidate coverage, not proof that every matching pool on the chain was discovered. Native ETH and ERC-20 balances were also read successfully for three explicit currency addresses. Full wallet enumeration and reconciled market analytics remain unqualified.

| Check | Measured result | Product implication |
|---|---|---|
| Network and deployments | Chain 4663; code present at the configured managers; PositionManager and StateView linked to the expected PoolManager | Establishes the read target; this is not a bytecode audit or independent-provider consensus |
| Candidate catalogue | 18 provider entries, 17 accepted v4 candidates, one other/rejected market, all 17 probed | Token-address discovery works for this sample; catalogue completeness is unknown |
| Pool identity | Full PoolKey hashes, currencies, LP fee, tick spacing, hook and current state verified at one block | Provider labels alone do not establish pool identity |
| Integration classification | 16 fixed-fee hookless pools; one pool requiring a separate adapter | Hookless identity alone is not automation admission or a safety rating |
| Currency metadata | Native ETH, MARLIN and USDG metadata read | Symbols are display text; contract addresses determine identity |
| Address-list balance fallback | Three currency balances read at a pinned block | Exact integer quantities are preserved internally; this is not complete wallet inventory |
| Wallet enumeration | Blockscout ERC-20 inventory request returned HTTP 403 | Qualify another endpoint/provider and pagination before claiming wallet-wide discovery |
| Volume and liquidity | External values retained with retrieval time and unknown provider block coverage | They remain unreconciled provider observations, not verified pool TVL or ranking inputs |
| APR and suggestions | Unavailable; no pool promoted to a suggestion | Requires rolling fee/TVL reconciliation and calibrated policy |
| Verification | 22 backend tests passed | Covers domain accounting plus read identity, failure handling and transport restrictions; no public transaction path was tested |

## Evidence and reproducibility

The [complete candidate report](discovery-qualification-2026-09-09-marlin-full-candidates.json) uses block **58,677,944**, timestamp **2026-09-09 16:09:05 UTC**. The [balance and inventory probe](discovery-qualification-2026-09-09-marlin.json) uses block **58,676,513**, timestamp **2026-09-09 16:06:40 UTC**, and probes the first 12 candidates. These are separate snapshots. The complete candidate run did not repeat the wallet checks; the inventory result comes from the earlier balance probe.

Both artifacts record their block hash. The reader rechecks that block and its freshness before returning the report. This catches a block change during the probe; it does not provide finality or replace continuous reorg reconciliation. External provider metrics are fetched separately and are not claimed to share the on-chain snapshot.

The earlier user-supplied position ID was used only to resolve its public owner for balance-read qualification. Reports omit the wallet address and quantities. Reading `ownerOf` is not authentication or proof that the caller controls that owner.

Implementation: [discovery.py](../backend/discovery.py), [CLI](../backend/qualify_discovery.py), [tests](../backend/tests/test_discovery.py). Run instructions and dependency pins are in the [backend README](../backend/README.md). The CLI uses only read methods, bounded requests and a fresh output file. It does not load personal-bot configuration or signing material.

## What the sample changes

The ETH/MARLIN pool with the largest provider-reported volume in this sample has a nonzero hook address. Its core LP fee field is zero; that does **not** establish a zero total trading cost, because hook behavior has not been reviewed. It is visible in discovery but requires a separate adapter assessment.

Ten other pools have core LP fee settings between **77% and 89.99%**, while the provider reports just **$0.54–$55.27** in trailing-day volume for those pools. These are trading-fee settings, not APR or Domino service fees. Their identities were verified, but their activity and economic suitability were not. A nominal fee multiplied by small-volume/thin-liquidity provider data would be a poor basis for a beginner-facing recommendation.

One pool has provider volume but missing reported liquidity. Missing liquidity remains unavailable rather than becoming zero or an infinite APR. The sample supports the approved decision to qualify activity, depth, price integrity and data coverage before ranking; it does not establish numerical acceptance thresholds.

## Remaining implementation work

1. Qualify paginated Robinhood wallet inventory through a usable provider, reconcile returned balances on-chain, and retain contract-address fallback. A failed Blockscout request is not evidence that enumeration is impossible.
2. Build a persistent catalogue from PoolManager Initialize events with checkpoint/reorg handling. PositionManager's `bytes25` cache and DEX Screener's candidate list are useful seeds but cannot establish full chain coverage; verify the complete PoolId for every recovered key.
3. Reconcile rolling swaps, LP-attributable fees and pool-attributed liquidity/valuation. Exclude protocol/hook deductions appropriately; do not use the singleton manager's entire token balance as each pool's TVL. Compare supported reserve-reading tools against the indexed accounting model.
4. Calibrate activity/depth/fee/valuation policies using more tokens and deposit sizes, then expose source, age and exclusion reasons through the API. This one-token probe cannot validate chain-wide reliability or production quotas.
5. Add durable accounts, wallet authentication and the read-only UI/API integration in the technical baseline, followed by the approved financial paths. Commercial RPC capability, costs and failover still need qualification.

Pricing approval is recorded separately in [PRICING_POLICY.md](../PRICING_POLICY.md): up to 0.65% for eligible owner-requested assisted swaps and 2% of earned fees consumed by automation under the non-stacking rules. The exact assisted-swap tariff still needs calibration. This read-only slice implements no new collection or live financial permissions.

## Primary references checked

- [Robinhood connectivity](https://docs.robinhood.com/chain/connecting/): network and public/commercial endpoint context. The public RPC was used for these bounded development probes.
- [Uniswap v4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments): Robinhood manager and StateView addresses, cross-checked against live manager links.
- [Uniswap PositionManager](https://github.com/Uniswap/v4-periphery/blob/main/src/PositionManager.sol): cached PoolKeys and position ownership reads. This moving source reference does not pin or attest deployed bytecode.
- [DEX Screener API](https://docs.dexscreener.com/api/reference): token-pair discovery endpoint; actual Robinhood response coverage is recorded in the artifacts above.
- [Blockscout paginated token balances](https://docs.blockscout.com/api-reference/token-balances-with-filtering-and-pagination): the inventory API shape tested; the observed Robinhood request returned 403.
