# Reinvestment objective — public product

Updated 21 September 2026: simple Auto-compound is 2%, Domino-compound is 4%, per mode for every execution. Gas is initially funded manually by the company. The owner confirmed that internal swaps remain included in the mode fee; the additional 2% swap charge will not be implemented for this release. Supersedes the inherited 15% addition cap in the public-product scenario. This is a product requirement, not authority to change the personal deployment.

## Objective and implementation boundary

Reinvest the maximum economically viable amount of earned fees. Do not maintain a standing percentage of idle fees. Optimize the owner's expected net outcome, rather than gross APR, transaction frequency, protocol revenue, or the amount swapped.

The historical/simple practice app implements the balanced-assets case: consume all available fees when the proposed 2% service cut covers operator gas plus its 15% cost buffer. There is no percentage-of-position addition limit. This is only a preliminary operator-cost check; it does not establish owner advantage, predict returns, quote swaps, or authorize execution.

For a $1,000 position and $200 of balanced fees with $0.25 estimated gas:

| Policy | Fees used | Service cut | Reinvested | Waiting fees |
|---|---:|---:|---:|---:|
| Historical 15% addition cap | $153.061224 | $3.061224 | $150 | $46.938776 |
| Current practice policy | $200 | $4 | $196 | $0 |

Gas is paid by the operator from its service revenue in this pricing proposal, so do not subtract it from the owner's $196 again. The 15% gas buffer is a cost-estimation margin, not a share of user funds held in reserve. The selected mode’s service cut is separate from both. In Domino mode the same $200 fee basis produces an $8 cut and $192 reinvestment, before any actual pool trading costs.

Old practice receipts retain their original amounts and policy. Their remaining balances can be evaluated under the new policy with zero new fees. Nothing runs automatically in the practice app.

## Planner requirement: direct reinvestment, swap, or wait

Bounded fee-balancing swaps are implemented in the V4 execution path and remain absent from the historical balanced-fee practice simulation. Their inclusion never waives price, amount, custody or owner-benefit checks; code qualification does not activate a live service.

For each coherent observation, evaluate direct reinvestment, admitted fee-funded swap amounts followed by reinvestment, and waiting. Also evaluate routing to another eligible position when the owner's Domino policy permits it. Prefer the greatest net productive reinvestment among economically justified candidates; a smaller swap can outperform swapping all excess tokens. Skip the router when direct reinvestment already uses the fees efficiently.

Two independent gates apply:

1. **Owner benefit.** Compare each candidate's expected net outcome with direct reinvestment and waiting over a disclosed, bounded evaluation window. Include the incremental earning opportunity, changes in asset exposure, service charge, DEX fees, price impact, worst permitted output, rounding, and any owner-paid costs. Use conservative, sufficiently sampled fee-rate estimates and range/depth conditions. No perpetual extrapolation of a high APR. Require a positive margin that covers estimation uncertainty; missing evidence cannot justify a swap.
2. **Execution sustainability.** The realizable service cut must cover the full selected path's gas and buffer, including incremental swap gas, unless a separately capped project subsidy applies. Covering operator gas alone is not proof that the action benefits the owner. Account for failed/replaced transactions in operating budgets without charging the owner twice.

Slippage tolerance is an execution bound, not an extra fee to add again if already reflected in conservative minimum output. Measure price impact separately and bound it explicitly. Re-quote and re-evaluate when price, fees, gas, policy or destination changes; an old annualized rate must not force a currently unprofitable trade.

## Funds and execution limits

These limits govern ongoing automation. Initial position creation separately permits an explicit owner-signed balancing swap using only the selected wallet deposit budget, as defined in [ONBOARDING_AND_POOL_DISCOVERY.md](ONBOARDING_AND_POOL_DISCOVERY.md). Initial capital, swap proceeds and unused deposit dust are not earned fees and incur no 2% or 4% automation service cut. That setup consent cannot grant future wallet-pull authority to the operator.

Owner-requested initial/manual assisted swaps have an approved first-release tariff of 0.65% (65 bps), `tariffVersion: "1"`, on the consumed selected swap budget, as specified in [PRICING_POLICY.md](PRICING_POLICY.md). This pricing approval does not deploy or activate Setup. Do not apply that service charge to internal automated fee-balancing swaps: the mode’s 2% or 4% automation cut remains the sole Domino service fee for that action. Account for actual DEX trading costs and impact in its output without double counting them.

- Use proven earned fees and their tracked balances only. No principal withdrawal, external stablecoin, wallet pull, cross-owner funds, or reclassification of donations.
- Consume the needed fees in both registered currencies, including stablecoin or ETH fees within the sequence. Preserve only what cannot economically or safely be deployed; there is no fixed quote-asset allocation to hold back.
- Bind every execution to exact token budgets, admitted routes and currencies, minimum outputs, price-impact and slippage bounds, a deadline, owner policy and sequence state. The new public vault must enforce these boundaries on-chain and remain within its proven fee balances even without a 15% liquidity-growth cap.
- Reconcile input/output tokens and swap costs explicitly. Swapping a fee lot is not a second service-charge event. The V4 source ledger preserves charged lineage across swaps; its conservation and cumulative per-source rounding must remain enforced at both rates.
- A personal/legacy contract's enforced cap remains binding until an explicitly authorized upgrade or migration. Do not bypass it. If batching is needed, reconcile each receipt, refresh remaining balances and compare total costs before another action; never restart a measurement timer solely to delay already eligible leftovers.

## Waiting balances and release evidence

Use the UI label **Fees awaiting reinvestment**. Every retained balance needs an amount, source and reason: cost, dust, token-ratio mismatch, unavailable/uneconomic swap, range restriction, stale data, pending transaction, pause, or an actual contract limit. It remains available for re-evaluation or owner withdrawal, without a new collection or duplicate charge. Re-evaluate dynamically when relevant observations change; preserve useful history through isolated failures.

Release tests must cover full balanced reinvestment; a previously waiting balance becoming viable after gas drops; a beneficial bounded swap; a smaller swap beating a full swap; a swap losing to direct reinvestment or waiting; insufficient fee-funded stablecoin; stale quotes; impact/slippage violations; fee-lot conservation across conversions; reverting swaps; partial fills/dust if supported; and restart/reorg recovery. Report what is implemented separately from these future acceptance criteria.
