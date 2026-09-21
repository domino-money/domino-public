# Forked-pool execution evidence — corrected 21 September 2026

This revision supersedes the economic interpretation and tables published on
20 September. The [original JSON files](fork/) remain unchanged. Their
`lossVersusHonestQuote` used the non-swap control for swap scenarios, and the
published “swap shortfall” was inferred from the anchor rather than read from
the transaction. Those figures must not be used as measured swap proceeds.

The derived `*-corrected-2026-09-21.json` files retain original observations,
put retired metric fields under `supersededMetrics`, use each recipe's honest
control, and mark missing conversion receipts unavailable. Recalculation does
not recover absent outputs. Historical runs used ordinary Anvil and do not
qualify Nitro opcode semantics. Current local qualification explicitly installs
`MockNitroArbSys` at `0x64` and records this as emulation, never live-chain proof.

## Measurement definitions

- **Vault delta versus control:** recorded end-state balances and liquidity,
  valued with the range formulas at the pre-scenario price, minus the matching
  `honest` or `swap-honest` control. This is a computed mark-to-reference value,
  not a realized sale or USD price feed. The same planning recipe may select
  different amounts after an attack has generated additional pool fees.
- **Attacker pool cost:** negative driver token-balance PnL at the same reference
  price. Historical values exclude gas paid by the separate sender account.
  Updated runs record that native gas debit separately.
- **Actual swap shortfall:** reference-price quote for the receipt's exact input
  minus `FeesConverted.amountOut`. This includes pool fees and swap impact;
  it is not pure manipulation loss. When input amounts match, the updated tool
  also compares actual output with the `swap-honest` output.
- **Pre-swap spot quote difference:** an estimate before pool fees and swap impact.
  Corrected old records include it but never substitute it for actual proceeds.

The updated tool validates receipt event identity by engine, vault and intent.
Liquidity contributions come from `BudgetApplied`, not a formula evaluated
at pre-swap spot. Initial value is read before the scenario; the legacy
`vaultValueBeforeQuote` reused accrued fees read afterward and is historical
only. Neither old before-values nor old estimated add amounts justify a claim
about actual token receipts.

## Corrected historical tables

Amounts below are currency1 units (USDG, six decimals), not a USD peg assertion.
A refused compound changes no vault state itself, but attacker trades still
earn pool fees; its final value need not equal the honest-compound control.
Actual swap shortfall is unavailable for every executed swap in these old files.

### Narrow range: half-width 200 ticks, source block 68232373

[Corrected evidence](fork/weth-usdg-narrow-2026-09-20-corrected-2026-09-21.json) · [Original evidence](fork/weth-usdg-narrow-2026-09-20.json)

| Scenario | Move | Outcome | Vault delta vs matching control | Attacker pool cost | Actual swap shortfall |
| --- | ---: | --- | ---: | ---: | --- |
| honest | 0.0% | executed | +0.000000 | 0.000000 | not applicable |
| swap-honest | 0.0% | executed | +0.000000 | 0.000000 | unavailable |
| pre-observation | 0.5% | executed | +0.542562 | 2.586091 | not applicable |
| post-observation | 0.5% | refused (InvalidAmount()) | +0.672488 | 2.588070 | not applicable |
| ceiling | 0.5% | refused (InvalidAmount()) | +0.672488 | 2.588070 | not applicable |
| swap-pre-observation | 0.5% | executed | +0.507465 | 2.576702 | unavailable |
| swap-post-observation | 0.5% | executed | +0.507287 | 2.577259 | unavailable |
| pre-observation | 0.9% | executed | +0.971523 | 4.716884 | not applicable |
| post-observation | 0.9% | refused (InvalidAmount()) | +1.092589 | 4.722685 | not applicable |
| ceiling | 0.9% | refused (InvalidAmount()) | +1.092589 | 4.722685 | not applicable |
| swap-pre-observation | 0.9% | executed | +0.913906 | 4.700733 | unavailable |
| swap-post-observation | 0.9% | executed | +0.914110 | 4.702386 | unavailable |
| pre-observation | 1.1% | executed | +1.184824 | 5.958894 | not applicable |
| post-observation | 1.1% | refused (InvalidPrice()) | +1.303286 | 5.967190 | not applicable |
| swap-pre-observation | 1.1% | executed | +1.117289 | 5.939490 | unavailable |
| swap-post-observation | 1.1% | refused (InvalidPrice()) | +1.214433 | 5.967190 | not executed |
| pre-observation | 5.0% | executed | +2.125552 | 28.275984 | not applicable |
| post-observation | 5.0% | refused (InvalidPrice()) | +2.242590 | 28.299181 | not applicable |
| swap-pre-observation | 5.0% | executed | +1.943278 | 28.165296 | unavailable |
| swap-post-observation | 5.0% | refused (InvalidPrice()) | +2.153737 | 28.299181 | not executed |
| pre-observation | 20.0% | executed | +2.124017 | 92.416032 | not applicable |
| post-observation | 20.0% | refused (InvalidPrice()) | +2.241055 | 92.439161 | not applicable |
| swap-pre-observation | 20.0% | executed | +1.557386 | 91.920970 | unavailable |
| swap-post-observation | 20.0% | refused (InvalidPrice()) | +2.152202 | 92.439161 | not executed |

### Wide range: half-width 2002 ticks, source block 68234852

[Corrected evidence](fork/weth-usdg-wide-2026-09-20-corrected-2026-09-21.json) · [Original evidence](fork/weth-usdg-wide-2026-09-20.json)

| Scenario | Move | Outcome | Vault delta vs matching control | Attacker pool cost | Actual swap shortfall |
| --- | ---: | --- | ---: | ---: | --- |
| honest | 0.0% | executed | +0.000000 | 0.000000 | not applicable |
| swap-honest | 0.0% | executed | +0.000000 | 0.000000 | unavailable |
| pre-observation | 0.5% | executed | +0.053963 | 1.998402 | not applicable |
| post-observation | 0.5% | executed | +0.054386 | 1.998403 | not applicable |
| ceiling | 0.5% | refused (InvalidAmount()) | +0.070043 | 1.998428 | not applicable |
| swap-pre-observation | 0.5% | executed | +0.052889 | 1.997290 | unavailable |
| swap-post-observation | 0.5% | executed | +0.053337 | 1.997357 | unavailable |
| pre-observation | 0.9% | executed | +0.097274 | 3.638116 | not applicable |
| post-observation | 0.9% | executed | +0.098055 | 3.638118 | not applicable |
| ceiling | 0.9% | refused (InvalidAmount()) | +0.113769 | 3.638199 | not applicable |
| swap-pre-observation | 0.9% | executed | +0.095287 | 3.636045 | unavailable |
| swap-post-observation | 0.9% | executed | +0.096196 | 3.636263 | unavailable |
| pre-observation | 1.1% | executed | +0.118973 | 4.603024 | not applicable |
| post-observation | 1.1% | refused (InvalidPrice()) | +0.135695 | 4.603155 | not applicable |
| swap-pre-observation | 1.1% | executed | +0.116512 | 4.600456 | unavailable |
| swap-post-observation | 1.1% | refused (InvalidPrice()) | +0.128371 | 4.603155 | not executed |
| pre-observation | 5.0% | executed | +0.548699 | 26.276605 | not applicable |
| post-observation | 5.0% | refused (InvalidPrice()) | +0.572460 | 26.280035 | not applicable |
| swap-pre-observation | 5.0% | executed | +0.534378 | 26.261622 | unavailable |
| swap-post-observation | 5.0% | refused (InvalidPrice()) | +0.565136 | 26.280035 | not executed |
| pre-observation | 20.0% | executed | +2.094917 | 92.619123 | not applicable |
| post-observation | 20.0% | refused (InvalidPrice()) | +2.192834 | 92.688725 | not applicable |
| swap-pre-observation | 20.0% | executed | +1.990433 | 92.516740 | unavailable |
| swap-post-observation | 20.0% | refused (InvalidPrice()) | +2.185510 | 92.688725 | not executed |

The swap control exceeds the non-swap control by 0.088853 USDG in the narrow
run and 0.007324 USDG in the wide run. Original swap deltas included those
unrelated differences. An unchanged anchor also does not mean an unchanged
execution exchange rate: corrected records label the nonzero post-observation
spot quote differences as estimates, with actual proceeds unavailable.

## Conclusions and limits

Recorded local-pool executions refused post-observation moves of 1.1%, 5%,
and 20% with `InvalidPrice()`. Wide-range ceiling cases refused otherwise
executable adds. Concentrated positions could fail closed on smaller composition
changes with `InvalidAmount()`. These show local mechanics against real pool
state, not live Nitro compatibility, service admission, or finalized-state reads.

The sampled pre-observation cases had positive vault mark-to-reference deltas
and negative attacker pool PnL at these specific sizes. They do not prove attacks
always lose money. Outcomes depend on depth, reserves, position share, range,
transaction grouping, pool fees, and gas. Missing old receipts prevent a
separate conclusion about realized swap shortfall.

The former “about $500 per compound/per vault” safety interpretation is withdrawn.
A manipulation can expose multiple vaults and actions in one pool/window while
sharing its move-and-restore cost. Relevant exposure is aggregate executed
notional, with cumulative impact included. These point samples establish no
per-vault reserve threshold, universal break-even threshold, or on-chain
aggregate exposure cap. The tool no longer emits a linearly extrapolated
`breakevenCompoundedQuote`.

## Historical lifecycle and gas

The [original lifecycle record](fork/weth-usdg-lifecycle-2026-09-20.json)
remains local-fork evidence. No live vault was created.

| Step | Outcome | Child receipt gas used |
| --- | --- | ---: |
| mint successor (execute, MINT) | executed | 1742808 |
| withdrawChildPosition | executed | 71936 |
| withdrawFeeReserves currency0 | executed | 69634 |
| withdrawFeeReserves currency1 | executed | 77839 |
| recoverUntrackedCurrency currency0 | executed | 67458 |

The original gas point sample remains verbatim in raw JSON. Its L1 component and
base-fee fields came from one live NodeInterface call; the execution gas came
from a child receipt. A returned zero L1 component is not a permanent exemption.
Child receipt products do not qualify full live Nitro cost. See
[V4 execution](../contracts/V4_EXECUTION.md#who-pays-gas-and-how-the-operator-is-funded)
for actual payers and the absence of automatic operator top-up.

## Reproduce

Offline, without RPC access:

```sh
backend/.venv/bin/python backend/qualify_execution_fork.py \
  --recompute reports/fork/weth-usdg-narrow-2026-09-20.json \
  --output /tmp/narrow-corrected.json
backend/.venv/bin/python -m unittest \
  backend.tests.test_qualify_execution_fork backend.tests.test_qualify_execution_fork_metrics
```

New fork from the public endpoint, without loading private provider configuration:

```sh
backend/.venv/bin/python backend/qualify_execution_fork.py \
  --public-rpc --rounds 40 --moves 50,90,110,500,2000 \
  --output /tmp/narrow-current.json
```

Compile the corrected contracts and `MockNitroArbSys` first. For artifacts in
another reviewed checkout, set `DOMINO_COMPOUND_EVM_ROOT` to that checkout.
The fork installs the explicit child-only ArbSys stand-in before vault
initialization and records its runtime hash and limitations. A pruned source
may stop serving its selected state before the experiment finishes; that makes
the run unavailable, not passed. A current fork rerun is separate evidence.

Validation in this revision: 13 focused offline tests passed; all three old
JSON files were recomputed without changing their originals. That offline
result claims no new fork execution.
