# Domino — functional alpha and market compatibility

9 September 2026. Product scope update requested after UI approval: the first invited-user functional alpha includes an opt-in Domino strategy. The invited read-only alpha is the first release milestone: verified live public reads where enabled, explicit unavailable states elsewhere, and wallet sign-in only after its separate acceptance. It does not complete the functional execution scope below. Auto-compound, Domino, deposits and swaps remain disabled until their own implementation and release gates pass. This changes scope and sequencing; it does not claim that public execution is implemented, reviewed or deployed.

## What the alpha delivers

The English creation/import journey offers **Auto-compound** and **Domino** on admitted Robinhood Chain markets. Auto-compound reinvests eligible earned fees into the same position. Domino retains the agreed source-routing rules and creates or funds successor positions from fees. Simple Auto-compound uses 2% and Domino uses 4% on consumed earned fees, per mode for every recipe. Both support bounded fee-funded swaps where the reviewed route and owner economics justify them.

Entry starts with tokens in the user's Robinhood wallet, including address search outside any starter catalogue. Users compare existing pools by pair, LP fee, rolling 24h volume, TVL and historical fee APR, then choose their amount and range. Explain the second asset and offer an explicit owner-signed balancing swap. The user also approved advanced creation of a new compatible pool when the selected pair/fee combination is absent, with explicit initial-price review. [ONBOARDING_AND_POOL_DISCOVERY.md](ONBOARDING_AND_POOL_DISCOVERY.md) defines this expanded alpha scope, data qualification and the proposed suggestion policy.

The user subsequently requested monetization modeled on Revert. [PRICING_POLICY.md](PRICING_POLICY.md) adds separately quoted owner-requested assisted-swap fees to alpha scope; the exact rate schedule remains pending. The 2%/4% automation service does not acquire a second swap fee or per-successor mint charge. Direct setup without swaps has no separate Domino percentage in this baseline; ordinary chain costs remain disclosed.

A Domino step creates another LP position in the same underlying Uniswap pool. It does not initialize a new pool, change its hook or move the original principal. The UI groups the root and successors as a sequence of cards and explains source, destination, amounts, costs and why an action is waiting.

The functional alpha is incomplete if Domino remains only a preview, a planned badge or a simulated successor. Its contracts, signing/reconciliation path, price-integrity design, owner exits and separate Domino acceptance cases must pass the release gates before real activation. The generic public contracts and swap path are still unimplemented.

## Compatibility is assessed per pool and operation

Do not advertise support for every Uniswap v4 position. Record the chain, verified PoolManager and PositionManager, full PoolKey (currencies, fee, tick spacing and hook), position identity, token behavior and admission version. A token symbol or pair name is not a pool identity. Two pools with the same tokens can require different integrations.

Initial admission proposal:

| Property | Initial alpha treatment |
|---|---|
| Network | Robinhood Chain mainnet, chain ID 4663 |
| Integration | Verified canonical v4 managers and standard PositionManager NFTs; actual ownership and individual permissions checked |
| Pair | Wallet-first discovery and address search; user chooses the paired asset, including USDG or ETH candidates. Apply versioned technical checks per currency/pool/operation rather than restricting entry to a small token list |
| Hooks | Hookless pools initially; nonzero hooks need a separately reviewed adapter and accounting model before admission |
| Fees and ticks | Fixed LP fee and supported, validated tick spacing; no assumptions based on v3 fee-tier defaults |
| Tokens | Standard transfer/accounting behavior; exclude transfer-tax and rebasing tokens initially; evaluate privileged token controls explicitly |
| Native currency / wrappers | Include tested native-ETH funding, refund, gas-budget and automation paths in alpha scope; distinguish WETH with its own validated address/path. Third-party vault/staking wrappers still need a separate integration |
| Pricing | Reviewed source and manipulation/freshness assumptions for this market; missing USD valuation remains unavailable |
| Swaps | Exact admitted routes, adequate executable depth and tested output/accounting behavior; no unrestricted router calls |
| Ownership | Owner can grant and revoke the required authority; an NFT already controlled by another protocol needs an explicit supported integration |

This is an initial admission policy, not a claim that every hookless pool is acceptable or that a listed token is safe. Apply verified integration rules, actual contract/token reads and path simulations to discovered candidates; fork-test supported behavior classes and review exceptions. Unknown behavior remains unavailable for execution until qualified. Changes in token controls or supported-contract state can suspend automation. Do not infer swap or Domino eligibility from the ability to display an NFT. Creating a hookless pool cannot repair an unsupported token or missing price-integrity evidence.

Expose operation-specific capabilities with reasons for viewing, initial swap, new position, pool initialization, Auto-compound and Domino. Capabilities depend on deployed/reviewed integration evidence. Separately show transient execution state such as paused, stale data, high gas, missing fee balances, out of range or a pending transaction. Suggestion eligibility is separate: a manually selected compatible market can lack enough activity for a recommendation. An admitted market does not imply that execution is economically justified now.

## Domino behavior retained from the agreed strategy

1. Fees normally return to their source position.
2. Within the configured distance below its upper price, source fees can fund an existing successor or a new successor. Trigger distance and maximum overlap are independent owner-configurable settings. For example, a 5% trigger means price at 95% of the old ceiling.
3. An out-of-range source can route fees to a suitable in-range position in the same sequence. If there is no eligible destination or affordable valid successor, wait with an explicit reason. Do not create a downward ladder or move principal automatically.
4. Track fee sources across the entire sequence. Cross-position funding respects those routing rules, owner identity and proven fee balances; ordinary in-range source fees do not become unrestricted pooled capital.
5. Preserve the agreed successor geometry: its proposed ceiling is 50% above the previous ceiling; its floor can overlap downward by up to the configured percentage of that previous ceiling. With a ceiling of $1 and maximum overlap of 20%, the new floor cannot be below $0.80 and its target ceiling is $1.50. With 5% maximum overlap, the floor cannot be below $0.95. Convert quote prices to valid ticks without violating the bounds; report tick rounding and reject an infeasible range.
6. Use the maximum economically justified earned-fee amount after the service cut, subject to token ratios and execution limits. Earned fees in both registered currencies can fund the action; for token/stable sequences this includes only stablecoin fees already inside the sequence, with no external stablecoin or wallet pull. Apply the same fee-only boundary to an ETH or other admitted quote asset. Bounded swaps can correct the mix when the owner-benefit check passes. No standing fee reserve.
7. A trigger is eligibility to evaluate, not an order to force a mint. Fees, market depth, price bounds, transaction costs, current state and owner policy must also qualify. A new upper position may begin inactive; the preview and planner must reflect that.
8. Enforce a small owner-visible sequence cap and an explicit behavior at the cap. Proposed alpha default: three total positions including the root, subject to gas and exposure testing. This is a proposal, not a previously approved personal-bot setting. At the cap, fund an eligible existing position or wait; do not keep adding positions.

For a non-stable pair, define the ceiling, trigger and successor geometry in the selected quote asset per base token, not a changing USD conversion. Keep that orientation fixed for the sequence. The quote asset can itself change in dollar value; the range preview must explain both exposures.

## Implementation changes required now

Treat a sequence as a first-class object from the initial database/API design. Record root and child relations, source-attributed fee balances, policy versions, intended successors and operation-specific market capabilities. A read-only watchlist remains distinct from an activated sequence.

The planner needs typed decisions for self-compound, funding an existing successor, creating a successor, and waiting. Swap candidates attach exact fee-token budgets, routes, output bounds and deadlines to the permitted action. The signer and vault must validate the same owner, sequence, pool, policy and action identity.

The current IDominoVaultDraft interface only describes the self-compound integration surface. Add explicit, bounded redirect/mint/swap plans during contract implementation; document initialization/recipient checks, price orientation and tick rounding. A general arbitrary-call executor is outside scope. Apply a service fee once to consumed earned-fee lots, including across conversions and source/destination changes.

Prevent duplicate successors when workers race or a broadcast response is lost. Persist a unique successor intent linked to the parent, policy/state nonce and chosen range; reconcile its NFT mint/receipt before retrying or planning another child. Track provisional versus canonical events across reorgs.

## Release sequence and acceptance

**Invited read-only alpha:** The invited read-only alpha is the first release milestone: verified live public reads where enabled, explicit unavailable states elsewhere, and wallet sign-in only after its separate acceptance. It does not complete the functional execution scope below. Auto-compound, Domino, deposits and swaps remain disabled until their own implementation and release gates pass.

**Internal integration:** wallet authentication/inventory, pool discovery and metric qualification, durable data and the approved cards; complete sequence-aware API/data contracts and exact deposit composition. Develop initial creation, compound, swaps and Domino on local/fork environments during this work.

**Execution qualification:** implement owner-funded swap/mint, advanced pool initialization with first liquidity, the generic vault/factory, both compound paths, successor creation/funding, bounded fee swaps, restricted signing and recovery. Validate actual Robinhood contracts and admitted token/pool behaviors. Complete independent review, remediation and direct-owner recovery exercises for the exact execution scope.

**Invited functional alpha:** offer both strategies on admitted markets with small agreed exposure, gas and sequence budgets. Reconcile every actual receipt and show accurate activity and waiting reasons. Do not label a read-only or compound-only build as the completed Domino alpha requested here.

Required Domino cases include independent trigger/overlap settings; valid tick rounding and reversed token order; create exactly one successor at the threshold; reuse an existing successor; below/above-range routing; insufficient or imbalanced fees; beneficial and rejected swaps; stale/manipulated quotes; maximum sequence length; policy changes invalidating old plans; transfers/revocation; duplicate jobs; ambiguous broadcasts; restarts/reorgs; fee conservation without double charging; owner withdrawal with the service offline; and isolation of multiple owners/sequences.

The earlier twelve-week schedule is a historical planning estimate. Re-estimate the functional-alpha critical path with wallet discovery, rolling metrics, guided funding, new-pool creation, Domino and swap review included; do not shorten security evidence to retain that date. The live personal deployment and its permissions remain outside this scope update.

## Primary protocol references

- [Uniswap v4 hooks](https://developers.uniswap.org/docs/protocols/v4/concepts/hooks): pool-specific optional behavior at liquidity and swap callbacks, including balance deltas and access restrictions. This is why automation eligibility requires more than a v4 label.
- [Dynamic fees](https://developers.uniswap.org/docs/protocols/v4/concepts/dynamic-fees): LP fees can be managed through hooks and are distinct from protocol/hook fees.
- [PoolKey source](https://github.com/Uniswap/v4-core/blob/main/src/types/PoolKey.sol): the currencies, fee, tick spacing and hook jointly identify a pool.
- [Deployments](https://developers.uniswap.org/docs/protocols/v4/deployments): verify managers per network instead of assuming cross-chain address equality.
- [PositionManager source](https://github.com/Uniswap/v4-periphery/blob/main/src/PositionManager.sol): integration reference; pin and verify the deployed version during implementation rather than relying on the moving main branch.
