# Domino — revenue and fee boundaries

9 September 2026. The user has read and approved this pricing design and the onboarding proposal. Assisted-swap monetization, its 0.65% ceiling, the 2% automation rate and the separate non-stacking bases are approved for implementation. The exact tariff table still follows the calibration step below; approval does not select between its candidate rates. No new fee has been implemented or activated. [Revert fee review](REVERT_FEES_REVIEW.md) separates confirmed reference prices from Domino-specific choices.

## Alpha revenue lines

| Operation | Approved pricing boundary | Status |
|---|---|---|
| Discover tokens/pools, inspect analytics, connect a wallet | No service charge | Product baseline |
| Create/increase a position or initialize a compatible pool without an assisted swap | No setup percentage in this baseline; owner pays disclosed chain costs | No universal Revert creation fee was confirmed; a separate flat/percentage creation charge is not silently introduced |
| Owner-requested assisted swap during funding or supported manual management | A versioned quoted fee on the consumed swap budget; ceiling 0.65% (65 bps) | Approved boundary; exact rate table and collection implementation pending |
| Auto-compound or Domino fee reinvestment | 2% (200 bps) of consumed earned fees | Approved boundary; includes operator compensation/gas within the service cut; direct and swap-assisted paths use the same service rate |
| Pause/revoke/withdraw without a requested conversion | No Domino exit toll; owner-paid gas where applicable | Direct owner recovery remains available |

The 2% automation rate does not apply to initial principal. Conversely, the assisted-swap fee can be paid from the explicitly selected initial funding budget. This is a separate owner-authorized service, not an operator right to debit deposits or wallet balances later.

Do not add the assisted-swap service fee on top of the 2% for internal automated balancing, successor funding or successor creation. Real DEX fees and price impact still affect swap output and must be included in economics. An owner clicking a button that invokes the existing automation path does not silently turn it into a differently priced product.

## Rate selection

Use a disclosed rate schedule with a hard per-operation cap and a stored version. A lower tariff for technically reviewed stablecoin-to-stablecoin routes can follow the competitive reference of 0.01%; volatile-pair tariffs should be compared at 0.30% and 0.65% before launch. These are evaluation candidates, not approved live defaults and not a claim that Revert uses this exact mapping.

Do not automatically set the service fee equal to an arbitrarily high LP fee chosen by a user. Avoid pricing that changes with the user's wallet wealth or route splitting. Freeze the selected rate and exact token fee in the review quote; a changed rate requires renewed review. A token's stablecoin label alone cannot select a discounted/safe classification.

## Explicit basis and receipt

For Domino's proposed first version, use exact-input assisted swaps. The owner selects a gross input budget that includes the Domino fee. For a fully consumed budget, `fee = floor(gross swap budget × rate)` in input-token base units; the remaining input goes to the DEX. Quote the output on that remaining amount. No charge applies to tokens deposited directly, unrelated wallet assets, or returned unconsumed budget. Do not charge again for intermediate hops.

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

These are hypothetical Domino calculations, not Revert receipts or a profitability forecast. A $1,000 funding budget that uses $400 for a swap would generate $2.60 at 0.65%, or $1.20 at 0.30%. At the 0.65% example, $397.40 reaches the DEX before its own fees/impact; $600 is not subject to the swap service fee. A correctly balanced deposit needing no swap produces no assisted-swap revenue.

For 100 monthly funding operations averaging $1,000, assuming every operation swaps half of its budget, chargeable swap volume is $50,000:

| Evaluated swap tariff | Gross monthly assisted-swap revenue |
|---|---:|
| 0.01% | $5 |
| 0.30% | $150 |
| 0.65% | $325 |

If only half those operations require a swap, these revenues halve. The same $50,000 of **earned fees actually consumed by automation**, a different economic base, would generate $1,000 at 2% before execution and operating costs. Deposited TVL is not earned-fee volume and does not generate that recurring service revenue by itself.

Track revenue by token and at realizable value. Contribution equals assisted-swap revenue plus automation revenue, less project-funded gas including failed/replaced attempts, route/provider charges borne by Domino, conversion losses and operating costs. Setup revenue helps fund acquisition/support but cannot guarantee ongoing execution economics. Keep the owner's net-benefit check separate from the operator cost/margin check; do not manufacture swaps or extra transactions to earn more fees.

## Implementation and release work

Add typed fee schedules, owner-bound quotes, exact amount caps and receipt fields to the onboarding/API design. Extend contract review for assisted-swap collection separately from the existing earned-fee split library. Test fee-free direct deposit, charged exact-input swap, rate changes, rounding/dust, gas headroom, multiple hops, reverted swaps, swap-success/mint-cancel recovery, replacements/reorgs, recipient substitution and conservation. Verify that automated internal swaps never acquire an extra assisted-swap service charge.

Before activation, select the exact schedule from measured onboarding conversion and contribution scenarios, qualify the collection path and route costs on Robinhood, and show the rate and basis before every owner signature. Record applicable policy versions and preserve owner exits. No changes to the personal bot, existing approved wallets or live contracts are made by this proposal.
