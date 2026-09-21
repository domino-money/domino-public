# Remediated fork economic results — 21 September 2026

The corrected runs measured worse swap execution at small post-observation
moves, while the sampled attackers still lost token value before gas. Positive
vault value deltas in these samples do not eliminate the swap loss or establish
a safe amount to execute. These individual-action samples establish neither an
aggregate exposure limit nor live deployment readiness.

## Evidence and scope

Both runs used the public Robinhood RPC, synthetic funded/impersonated accounts,
40 fee-earning round trips, a 2% service rate, a 100-bps execution impact limit,
and explicit `MockNitroArbSys` at `0x64`. The guard's configured sqrt-price band
was 2000 bps. The Anvil stand-in uses local NUMBER/BLOCKHASH and does not qualify
Nitro opcode behavior. No real assets were sold or mainnet transactions sent.

| Run | Source block | Actual root ticks | Recorded outcomes | Coverage |
| --- | ---: | --- | --- | --- |
| [narrow](../fork/weth-usdg-narrow-remediated-2026-09-21.json) | 68901221 | -197384 to -196980 | 12 executed, 8 refused, 4 harness-error | 0.5%, 0.9%, 1.1%, 5% measured; 20% and lifecycle unavailable |
| [wide](../fork/weth-usdg-wide-remediated-2026-09-21.json) | 68913022 | -199176 to -195172 | 14 executed, 6 refused, 0 harness-error | All requested 0.5%, 0.9%, 1.1%, 5% measured; 20% and lifecycle not requested |

Narrow's first 20% case failed to retrieve pool storage; its remaining 20% cases
and attempted lifecycle timed out waiting for receipts. The lifecycle records
no completed steps. These are harness/source failures, not contract refusals,
zero loss or lifecycle success. The failure does not establish its precise
pruning cause. Narrow took 1,176 seconds. Wide completed under the newer finite
budget/checkpoint harness; `complete` applies only to the requested scope.

Narrow launched with simulator changes at `c442055`, before embedded artifact
provenance existed. The controlling audit validated sources/artifacts immediately
before launch; the [separate artifact record](artifact-verification.json) is
source/build evidence, not retroactively collected deployed-code evidence from
that child. Narrow JSON contains stack addresses and the mock hash, but no full
per-artifact source/deployed-runtime manifest.

Wide records all seven production artifacts, the swap driver and the ArbSys
stand-in: nine manifests covering 105 distinct sources, creation/runtime-template
hashes, deployment initcode hashes and child deployed-runtime hashes. The mock
was installed directly and has an installed-runtime hash. The review independently
checked all source SHA-256 values against the reviewed checkout and recomputed
all nine source-manifest hashes. These bind the local run; they are not mainnet
deployment records or fresh code reads from a closed child.

The runs start at different heads, with different position geometry and fee
accrual. Compare each scenario with its own run's recipe control; a cross-run
difference is not an isolated causal measurement of width.

## Execution behavior

`executed` means the local transaction succeeded; refusal names are recorded
custom errors. `—` means the ceiling family was not requested at or above the
100-bps execution limit.

| Run | Move | Pre-observation add | Post-observation add | Ceiling add | Pre-observation swap | Post-observation swap |
| --- | ---: | --- | --- | --- | --- | --- |
| narrow | 0.5% | executed | InvalidAmount() | InvalidAmount() | executed | executed |
| narrow | 0.9% | executed | InvalidAmount() | InvalidAmount() | executed | executed |
| narrow | 1.1% | executed | InvalidPrice() | — | executed | InvalidPrice() |
| narrow | 5.0% | executed | InvalidPrice() | — | executed | InvalidPrice() |
| wide | 0.5% | executed | executed | InvalidAmount() | executed | executed |
| wide | 0.9% | executed | executed | InvalidAmount() | executed | executed |
| wide | 1.1% | executed | InvalidPrice() | — | executed | InvalidPrice() |
| wide | 5.0% | executed | InvalidPrice() | — | executed | InvalidPrice() |

Wide's 0.5%/0.9% ceiling cases refuse adds that otherwise execute, demonstrating
the amount cap in those samples. Narrow non-swap adds already refuse at those
moves because composition changed; their ceiling variants alone do not isolate
a separate cap effect. Post-observation 1.1%/5% cases refuse on price in both runs.
Pre-observation cases deliberately publish the already-moved pool price and
execute against it, illustrating the dependence on observation quality.

## Receipt outputs and economic interpretation

Quote amounts below are **USDG token units (six decimals)**, not USD peg or
external market-price assertions. Reference quote is exact input multiplied by
the pre-scenario squared sqrt price, with integer rounding. Shortfall is that
quote minus extracted `FeesConverted.amountOut`; it includes pool fees and swap
impact, not purely manipulation loss. Even an honest swap has a small shortfall.
`BudgetApplied` events supply actual liquidity contribution amounts.

Post-observation cases below have the same input as `swap-honest`, so output
delta directly compares recorded proceeds. Vault delta is the whole end-state
portfolio valued at the reference price minus the matching recipe's control;
it includes accrued fees, reserves and liquidity. Attacker cost is negative
driver token PnL at that reference price, excluding separately paid native gas.

| Run | Swap case | Actual output | Shortfall vs reference | Output delta vs control | Vault delta vs control | Attacker pool cost |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| narrow | honest | 2.101629 | 0.000532 | +0.000000 | +0.000000 | 0.000000 |
| narrow | post 0.5% | 2.091121 | 0.011040 | -0.010508 | +0.520873 | 2.140364 |
| narrow | post 0.9% | 2.082714 | 0.019447 | -0.018915 | +0.938621 | 3.859541 |
| wide | honest | 0.221359 | 0.000056 | +0.000000 | +0.000000 | 0.000000 |
| wide | post 0.5% | 0.220252 | 0.001163 | -0.001107 | +0.055423 | 1.546450 |
| wide | post 0.9% | 0.219367 | 0.002048 | -0.001992 | +0.099953 | 2.789084 |

Worse swap output can coexist with a positive whole-vault delta: attacker trades
also generate fees for the position, and execution or refusal changes amounts
reinvested, charged and retained. A refused compound still follows attacker
trades; its portfolio need not equal the honest-compound control. Neither a
positive delta nor an unchanged anchor justifies reporting zero swap loss.

Pre-observation planning runs after additional attack-generated fees accrue and
chooses different inputs. Its output is measured, but an output difference from
`swap-honest` would compare different trade sizes and is withheld.

| Run | Pre-observation move | Actual output | Shortfall vs reference | Vault delta vs matching recipe | Attacker pool cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| narrow | 0.5% | 2.222112 | 0.011733 | +0.521056 | 2.139791 |
| narrow | 0.9% | 2.318257 | 0.021647 | +0.938379 | 3.857840 |
| narrow | 1.1% | 2.366253 | 0.026925 | +1.147228 | 4.719069 |
| narrow | 5.0% | 2.503710 | 0.132443 | +2.013893 | 20.066759 |
| wide | 0.5% | 0.234049 | 0.001236 | +0.054957 | 1.546380 |
| wide | 0.9% | 0.244176 | 0.002280 | +0.099006 | 2.788858 |
| wide | 1.1% | 0.249231 | 0.002836 | +0.121064 | 3.412016 |
| wide | 5.0% | 0.346661 | 0.018337 | +0.555226 | 18.035673 |

All 36 measured attack rows, including refused compounds, have negative attacker
token PnL before gas and positive vault deltas versus their matching controls.
They are point samples, not a profit bound. A manipulation can share its costs
across actions and vaults in one pool/window. Depth, active liquidity, price path,
fee collection, position share, sequencing and cumulative swap impact all change
the economics. These runs justify neither a per-vault $500 threshold nor linear
break-even extrapolation, and implement no aggregate notional cap.

## Gas and funding

| Run | Compound recipe | Child gas used | Child receipt gas product, ETH |
| --- | --- | ---: | ---: |
| narrow | honest | 1,175,064 | 0.001175064011750640 |
| narrow | swap-honest | 1,457,938 | 0.001457938010205566 |
| wide | honest | 1,175,124 | 0.001175124011751240 |
| wide | swap-honest | 1,497,579 | 0.001497579010483053 |

These products use the child's effective gas price, approximately 1 gwei; they
are not qualified total live Nitro bills. Publishing, deployment, attack trades
and owner actions have separate senders/transactions. Narrow's separate live
NodeInterface point sample returned 28,921 gas for the L1 component and
50,412,000 wei L2 base fee. Wide returned zero L1 component/base-fee estimate and
50,422,000 wei L2 base fee. These are live `latest` observations, not child receipts
or a pinned full live execution. A zero sample establishes no permanent L1
exemption, and the components are not presented as an actual bill.

The operator pays automated execution gas in native ETH already held by its
account; reverted transactions still consume gas. Here accounts were funded
with `anvil_setBalance`. No gas top-up or automatic sale of vault assets exists.
Service revenue goes to its configured recipient in the consumed currency;
converting revenue and funding the operator remain separate treasury operations.
See [gas funding](../../contracts/V4_EXECUTION.md#who-pays-gas-and-how-the-operator-is-funded).
Native gas is excluded from both vault quote deltas and attacker token PnL.

## Independent checks and preservation

The review recomputed control deltas, attacker-cost signs and gas products for
all 40 measured rows, plus reference-price shortfalls for all 14 extracted
conversion measurements; no arithmetic mismatch was found. Same-input output
comparisons were checked separately. These validate stored measurement
consistency, not independent canonical receipt acquisition after the child
closed. The JSON retains extracted event fields but does not archive complete
transaction receipts for every scenario.

Original 20 September records remain unchanged and are superseded only in
economic interpretation by the [corrected historical report](../EXECUTION_FORK_SANDWICH_2026-09-20.md).
Absent historical outputs and failed 21 September scenarios are never filled
with zeros or replaced with inferred outcomes.

Raw SHA-256 digests at this review:

- `weth-usdg-narrow-remediated-2026-09-21.json`: `9b50b3418de1d85f2fd4efce8e43091dbbfe9aee67db666b51c1d1e9bf44b91b`
- `weth-usdg-wide-remediated-2026-09-21.json`: `0bd58cf3a885d16beb62ac4efd20c7313e0b9317c97c649001d7a305786d57c7`
