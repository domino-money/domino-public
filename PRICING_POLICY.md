# Domino — revenue and fee boundaries

Updated **21 September 2026**, following the owner's explicit mode decision:
**Auto-compound: 2%; Domino-compound: 4%**, both on newly charged consumed earned
fees, once. The rate follows the selected automation mode for every recipe,
including same-position reinvestment inside Domino mode. It is not selected by
whether one execution happens to create a successor. Manual company ETH funding
is the launch path; bounded automatic conversion/refill of company revenue is the
next operational feature.

The owner selected **0.65% (65 bps), tariffVersion 1**, for owner-requested
assisted swaps during funding or supported manual management in the first Setup
release, on the consumed owner-selected swap budget. This uses the existing
65-bps ceiling. The tariff is approved for release preparation; this decision
does not deploy a contract or activate collection. The owner confirmed that
**internal automation swaps remain included in the mode fee, with no additional 2% swap charge**.
The surcharge study is closed for this release. The separate assisted-swap
boundary does not apply to internal automated balancing or reinvestment.
The [contract-level Revert review](reports/REVERT_FEE_DEEP_DIVE_2026-09-21.md)
separates source behavior, published prices and unverified live settings.

The V4 mode implementation and deployment artifacts must agree before release.
A policy document or successful test does not activate a real deployment or
replace an owner's reviewed signature. Earlier receipts retain their original
rates and policy versions.

## Alpha revenue lines

| Operation | Approved pricing boundary | Status |
|---|---|---|
| Discover tokens/pools, inspect analytics, connect a wallet | No service charge | Product baseline |
| Create/increase a position or initialize a compatible pool without an assisted swap | No setup percentage in this baseline; owner pays disclosed chain costs | No universal Revert creation fee was confirmed; a separate flat/percentage creation charge is not silently introduced |
| Owner-requested assisted swap during funding or supported manual management | 0.65% (65 bps) on the consumed swap budget, tariffVersion 1; unchanged 65-bps ceiling | Approved first-release tariff; Setup implements exact-input collection; deployment and activation remain separate |
| Auto-compound in the same root position | 2% (200 bps) of consumed earned fees | Every recipe in simple mode; one root position, no successor funding/creation |
| Domino-compound | 4% (400 bps) of consumed earned fees | Every recipe in Domino mode: direct, swap-assisted, successor funding and successor creation; includes operator compensation/gas |
| Pause/revoke/withdraw without a requested conversion | No Domino exit toll; owner-paid gas where applicable | Direct owner recovery remains available |

Neither automation rate applies to initial principal. Conversely, the assisted-swap fee can be paid from the explicitly selected initial funding budget. This is a separate owner-authorized service, not an operator right to debit deposits or wallet balances later.

Do not add the assisted-swap service fee on top of the mode’s 2% or 4% for internal automated balancing, successor funding or successor creation. Real DEX fees and price impact still affect swap output and must be included in economics. An owner clicking a button that invokes the existing automation path does not silently turn it into a differently priced product.

## Selected first-release rate

Use `setupFeeBps: 65` and `tariffVersion: "1"` in the first release's public preparation inputs. The approved 0.65% rate applies to admitted owner-requested assisted swaps; no pair-specific discount schedule is selected for this release. Verify the deployed Setup tariff and version against these inputs before publishing a profile.

Earlier comparisons of 0.01% stablecoin routes and 0.30% volatile-pair tariffs are historical evaluation alternatives, not the selected first-release schedule or a claim that Revert uses that exact mapping. Any future rate change requires a separately approved, versioned release and renewed owner review.

Do not automatically set the service fee equal to an arbitrarily high LP fee chosen by a user. Avoid pricing that changes with the user's wallet wealth or route splitting. Freeze the selected rate and exact token fee in the review quote; a changed rate requires renewed review. A token's stablecoin label alone cannot select a discounted/safe classification.

## Explicit basis and receipt

For Domino's approved first-release tariff, use exact-input assisted swaps. The owner selects a gross input budget that includes the Domino fee. For a fully consumed budget, `fee = floor(gross swap budget × rate)` in input-token base units; the remaining input goes to the DEX. Quote the output on that remaining amount. No charge applies to tokens deposited directly, unrelated wallet assets, or returned unconsumed budget. Do not charge again for intermediate hops.

The implementation must enforce the quoted fee, cap, recipient, expiry, input/output currencies, gross budget and output floor on-chain. Bind them to the owner, chain, route and operation identity. Do not sign arbitrary frontend-provided calldata or permit a router fee recipient to change after review. Partial-fill support requires explicit consumed-budget accounting and is not assumed in this initial exact-input design.

For each input currency, reconcile authorized consumed gross input into DEX input plus Domino service fee, with unconsumed authorized input remaining with or returning to the owner. Reconcile outputs, deposits and leftovers separately. Fees are collected only with a successful service transaction. If a separate swap succeeds but a later mint is canceled, the completed swap and its disclosed charge remain real; resume without swapping or charging again. A reverted swap charges no Domino service fee, although network gas may still be spent.

Review and receipts distinguish:

- **Domino swap fee**: rate, exact input-token basis and amount, estimated USD value only if supported.
- **Pool/route trading costs**: reflected in the quote, with available decomposition; do not double-subtract costs already inside output.
- **Network gas**: who pays and whether estimated or realized.
- **Domino automation fee**: only for the separate earned-fee automation action.
- Net swap proceeds, liquidity actually added, and assets left with the owner.

Create/continue buttons must refer to the actual reviewed action, not hide an initial token sale or describe paid setup as free. Existing practice receipts retain their original rate/policy and must not be repriced.

## Revenue sensitivity

These are hypothetical volume calculations, not Revert receipts or a profitability forecast. The 0.65% case uses the approved first-release tariff; 0.01% and 0.30% remain historical comparison alternatives. A $1,000 funding budget that uses $400 for a swap would generate $2.60 at 0.65%, or $1.20 at 0.30%. At the 0.65% example, $397.40 reaches the DEX before its own fees/impact; $600 is not subject to the swap service fee. A correctly balanced deposit needing no swap produces no assisted-swap revenue.

For 100 monthly funding operations averaging $1,000, assuming every operation swaps half of its budget, chargeable swap volume is $50,000:

| Swap tariff scenario | Gross monthly assisted-swap revenue |
|---|---:|
| 0.01% — historical alternative | $5 |
| 0.30% — historical alternative | $150 |
| 0.65% — approved first release | $325 |

If only half those operations require a swap, these revenues halve. The same $50,000 of **earned fees actually consumed by automation**, a different economic base, would generate $1,000 in simple mode at 2%, or $2,000 in Domino mode at 4%, before execution and operating costs. Deposited TVL is not earned-fee volume and does not generate that recurring service revenue by itself.

Track revenue by token and at realizable value. Contribution equals assisted-swap revenue plus automation revenue, less project-funded gas including failed/replaced attempts, route/provider charges borne by Domino, conversion losses and operating costs. Setup revenue helps fund acquisition/support but cannot guarantee ongoing execution economics. Keep the owner's net-benefit check separate from the operator cost/margin check; do not manufacture swaps or extra transactions to earn more fees.

## Implementation and release work

Maintain owner-bound quotes, exact amount caps and receipt fields for Setup collection. The 65-bps Setup ceiling is unchanged; a 200-bps swap tariff would require a separately selected policy, changed contract ceiling and new qualification. Test fee-free direct deposit, charged exact-input swap, rate changes, rounding/dust, gas headroom, multiple hops, reverted swaps, swap-success/mint-cancel recovery, replacements/reorgs, recipient substitution and conservation. Verify that automated internal swaps never acquire an extra assisted-swap service charge.

Before activation, prepare and verify the selected `setupFeeBps: 65` / `tariffVersion: "1"` inputs, qualify the collection path and route costs on Robinhood, and show the rate and basis before every owner signature. Record applicable policy versions and preserve owner exits. The pricing decision does not modify deployment artifacts, the personal bot, existing approved wallets or live contracts.


## Automation mode, consent and accounting

For this predeployment V4 release, the existing policy tuple retains its ABI.
Its exact `serviceFeeBps` is also the canonical mode discriminator: 200 is simple
and 400 is Domino. Other new owner-policy rates are refused. Pure arithmetic
and historical receipt readers can cover a wider range without admitting those
rates as new policies. This encoding must be explicit in the planner, SDK and
release profile; raising a generic cap alone would not enforce the mode.

Simple mode admits only root-position reinvestment, with one active position and
`maxPositions=1`; it cannot create/fund successors or consume another position's
fees. Domino mode can use the existing admitted source-routing rules at 400 bps.
Owner-signed mode changes advance policy/state versions and invalidate plans.
Downgrading requires all active children to be withdrawn first. Old child reserves
remain owner-withdrawable and cannot become a simple-mode funding source.

A lot charged at 2% is not charged the missing 2% after switching to Domino.
Converted, already charged balances remain exempt; only original uncharged fees
newly consumed use the current reviewed mode rate. A swap does not reset that
lineage. For $100 of newly consumed earned fees, the service cut is $2 in simple
mode or $4 in Domino mode, whether balancing is needed or not. Actual pool fees
and impact reduce execution output separately.
