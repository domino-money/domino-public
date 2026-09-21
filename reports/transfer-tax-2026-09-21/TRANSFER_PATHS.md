# Static transfer paths and the NET qualification invariant

Read-only source review on 21 September 2026 at repository commit `993a042def1fd89788936f2a64776fbae718ac8e`. No compilation, execution, network call, production edit or transfer was performed for this note. References below describe the code at that revision, before any subsequent correction. The conditional NET finding is derived statically; local reproduction and remediation are separate work.

**The 3% examples below are a hypothetical ERC20 transfer mechanism, not a finding that QUOTRON (`0x5a86828efd322bfb16d93cfed16ee9bc14940d7f`) charges 3% per transfer.** Its transfer authorization, royalty and hook behavior are being qualified separately. A pool trading fee, hook charge, NFT royalty and ERC20 transfer deduction are different mechanisms.

## Addresses, custody and internal accounting

Use **PM** for the singleton PoolManager and **PosM** for the ERC721 PositionManager. All source/child positions in the same pool are internal positions in PM. A source ID or converted-fee lot is accounting in the Domino vault, not another token-holding address.

- `PoolManager.modifyLiquidity` produces `callerDelta = principalDelta + feesAccrued` and records it against its caller, PosM. It does **not** transfer ERC20 tokens: `contracts/test/reference/official-v4/v4-core/src/PoolManager.sol:145–183`.
- `PoolManager.swap` produces and records deltas against its caller, the Domino engine. The swap call itself does **not** transfer the input or output token: the same file, `187–226`.
- PosM `TAKE_PAIR` asks PM to transfer each positive credit directly to the selected recipient, which Domino supplies as the vault. No intermediate PosM ERC20 wallet transfer exists: `contracts/src/DominoVaultV4.sol:308–321`; official `v4-periphery/src/PositionManager.sol:463–465`; `base/DeltaResolver.sol:27–29`.
- PM `take(currency,to,amount)` subtracts the **nominal** amount from the caller's delta, then calls `currency.transfer(to,amount)`. PM's transfer helper checks call/return success, not the recipient's actual balance increase: official `v4-core/src/PoolManager.sol:291–295`; `types/Currency.sol:39–85`.
- Domino settles debt with `PM.sync`, an actual **vault → PM** transfer and `PM.settleFor(debtor)`. The debtor is PosM for adds or the engine for swaps. There is **no vault → PosM or vault → engine ERC20 hop**: `DominoVaultV4.sol:339–369`.
- PM settlement credits the actual increase of its token balance since `sync`: official `v4-core/src/PoolManager.sol:349–364`. Zero transient deltas at unlock completion prove nominal debts were closed, not that PM's outgoing transfer credited its recipient exactly: `104–113,291–295`.
- Hook callbacks are excluded by the current Domino route validation (`DominoRoutingHelperV4.sol:153–154`). A token that requires a specific hook/router is a separate compatibility problem; changing a fee assumption cannot admit that pool.

## Every ERC20 edge in automation

Here, a conventional recipient-deducted 3% tax means a call for amount `x` debits the sender by `x`, credits the recipient by `x−T(x)`, and burns or redirects `T(x)` (for example `floor(3*x/100)`). Exemptions and rounding are token-specific. The tax applies only to the amount of that actual transfer, not automatically to every accounting delta or the entire position value.

| Route stage | Real ERC20 transfer | Where a recipient-deducted tax appears | Existing detection |
| --- | --- | --- | --- |
| GENERAL/FUND/MINT source collection | PM → vault, per nonzero fee currency, nominal accrued fees | Vault receives less than independently checkpointed accrued amount | Engine `_collect` requires each vault balance increase to equal accrued fees and PosM deltas to return to zero; reverts on short receipt (`DominoExecutionEngineV4.sol:160–178`). |
| GENERAL/FUND existing destination collection | PM → vault, when destination was not collected already, or after a swap | Same as source collection | Same `_collect` exact-credit check (`181–195`). This can run even when the plan did not explicitly list the destination among sources. |
| GENERAL/FUND liquidity add | Vault → PM, potentially multiple source/budget transfers per currency | PM receives less than add debt | Vault `_payExact` checks **both** exact sender debit and exact recipient credit during execution; `settleFor` must additionally return the exact amount (`DominoVaultV4.sol:364–369,714–731`). |
| MINT successor liquidity | Vault → PM, same settlement as an add | Same as GENERAL/FUND | Same exact transfer/settlement checks. The ERC721 mint is not an extra ERC20 transfer (`executionMint:375–391`; engine `_fund:181–204`). |
| Service fee in any recipe | Vault → immutable service-fee recipient, per nonzero service-fee application | Treasury receives less than assessed service fee | `_payExact` requires exact debit and credit during the financial path (`DominoVaultV4.sol:371,714–731`). A taxed treasury transfer normally reverts the **whole** execution. |
| NET reinvestment itself | **No ERC20 transfer for the reinvested portion** | None on the internal offset of earned-fee credit against add debt | PosM increase and PM accounting offset the two deltas. Actual residual and its transfer are separate below. |
| NET remaining fee return | PM → vault, nominal `realized − actual add cost` per positive currency | Vault receives a reduced residual | **Static gap:** engine calculates `added = realized − received`, so a short return can inflate reported added amount instead of reverting (`DominoExecutionEngineV4.sol:250–279`). |
| Internal swap input | Vault → PM; PM credits settlement to engine | PM receives less than the exact input debt | `_payExact` debit/credit and `settleFor` checks as above. No intermediate engine token custody (`engine:297–314`; vault:364–369). |
| Internal swap output | PM → vault, nominal positive swap delta | Vault receives less than nominal output | Engine requires exact vault output balance increase equal to the PM output delta (`engine:302–314`). A nominal `minAmountOut` check alone is insufficient, but the exact-credit postcheck catches this case. |
| Converted output subsequently reinvested | Vault → PM, using the same allocation settlement | A further tax on this actual transfer, if not exempt | Same `_payExact` and settlement checks. Merely recording the output as a charged lot or selecting another destination is not a transfer (`engine:315–327,214–247`). |

GENERAL is same-position; FUND targets an existing eligible position; MINT creates a successor. There is **no physical parent-wallet → child-wallet hop** in FUND or MINT. The differences are position identity and transient debt, not extra wallets. An optional swap can accompany the general funding flow; NET excludes swaps. Ordinary pool LP fees already included in swap deltas are not another ERC20 transfer tax.

Zero-amount PM takes are skipped by `DeltaResolver._take`. Service fees are sent only when nonzero. Several budgets can cause several separate transfers, each with the token's own rounding/exemption behavior; counting one flat 3% per recipe is not valid.

**Qualification boundary:** the foregoing rejection claims concern a deduction from the recipient's credit. If a token instead debits **extra from PM** while still crediting the vault the full nominal amount, PM's outgoing `take` and Domino's vault-credit checks do not detect that extra singleton debit. On vault-originated financial transfers, `_payExact` detects both sender-extra and recipient-short models. Token compatibility cannot be inferred from a successful recipient-credit check alone.

## NET can disguise taxed residual as extra reinvestment

For one currency define:

- `F`: independently accrued original LP fees, before increase;
- `A`: actual token principal consumed by the requested liquidity increase;
- `R = F−A`: nominal positive PosM delta taken from PM;
- `T`: transfer deduction on PM → vault;
- `V = R−T`: measured increase in vault token balance before the Domino service fee.

The current engine derives `A_reported = F−V = A+T` (`250–263`). It then inverses the service-fee formula using this inflated amount (`264–275`). `_after` verifies the NFT's liquidity increase and fee-growth checkpoints, but never independently relates that increase to token cost `A` (`152–157,277`). The root callback verifies the planned liquidity delta and nominal accrued fees, not receipt of the residual (`DominoVaultV4.sol:528–535`).

A simple integer counterexample, with zero previous reserves:

| Quantity | Amount |
| --- | ---: |
| Accrued fees `F` | 10,000 |
| True add cost `A` | 1,000 |
| PM nominal return `R` | 9,000 |
| 3% return deduction `T` | 270 |
| Actual vault receipt `V` | 8,730 |
| Current reported liquidity spend `F−V` | **1,270** |
| Minimal gross at Domino 4% | 1,322 |
| Service fee `floor(1322*400/10000)` | 52 |
| Booked remaining original fees | 8,678 |
| Actual vault remainder, if treasury transfer is exempt | `8730−52 = 8,678` |

Thus source conservation, `gross <= realized`, exact treasury transfer, reserve backing and zero PM deltas can all pass. `gross−serviceFee` also equals the **incorrect** reported spend. With the correct add cost, minimal gross would be 1,041 and fee 41. The current calculation overstates reinvestment by 270 and service fee by 11 in this example. The analogous simple/2% figures are inflated gross/fee 1,295/25 instead of 1,020/20.

This requires a positive taxed residual, enough fee/budget capacity, a plan ceiling admitting the inflated amount, and no blocking tax on the treasury transfer (for example, a treasury exemption). A tight ceiling at true cost can reject the transaction; a treasury tax usually also rejects it. These conditional refusals are not an invariant proving NET exact transfer. No principal decrease or owner-wallet drain is implied by this counterexample: the loss is misclassified spent earned fees and excess service charge.

The receipt parser mirrors event/accounting identities (`backend/execution_v4.py:426–447,507–527`) and therefore is not an independent token-cost oracle merely because conservation holds. E1 amount/plan bounds add constraints but do not make `F−received` an independent measurement of liquidity cost.

## Independent invariant for qualification and a fail-closed correction

Compute `A0,A1` **independently of token receipts** from actual requested/verified `ΔL`, the exact sqrt price during modification, and the position's exact ticks. For the hookless current recipe, positive liquidity uses official round-up principal math:

- Let `p = sqrtPriceX96`, `l = sqrtAtTick(lower)`, `u = sqrtAtTick(upper)`, `Q=2^96`.
- If `p < u`, `A0 = ceil(ΔL*Q*(u−max(p,l))/(u*max(p,l)))`; otherwise `A0=0`.
- If `p > l`, `A1 = ceil(ΔL*(min(p,u)−l)/Q)`; otherwise `A1=0`.

Use the pinned official `SqrtPriceMath.getAmount0Delta/getAmount1Delta(..., true)` rounding sequence, not approximate prices, float math, emitted ERC20 `Transfer` values or a token's assumed exemption. Official evidence: `v4-core/src/libraries/Pool.sol:206–237` and `SqrtPriceMath.sol:180–209,227–269,278–286`. The price must be the actual modification price, not just the earlier observation; current NET has no swap or admitted hooks, but the invariant should pin/check that execution condition.

For **each** NET currency require:

1. The observed position liquidity change equals the authorized `ΔL`.
2. `F >= A`, with no negative residual side.
3. `vaultBalanceAfterTake − vaultBalanceBeforeTake == F−A`.
4. Report `liquidityAdded = A`, then apply service-fee conservation and plan bounds to `A`.
5. Settle no additional NET principal transfer; require PM deltas closed and final backing, as today.

Equation 3 rejects any recipient-short return without guessing whether the token is exempt or what its rate is. The tax-loss diagnostic is `T_detected = F−A−actualReceipt`; it must be **zero** for exact-transfer admission. Separately measuring PM's sender debit is necessary if qualifying sender-extra tax semantics too. A repeated token transfer simulation in an unrelated address pair is not enough to prove these route-specific properties.

An alternative is to capture the authentic PosM credit **after** `modifyLiquidity` and **before** `TAKE_PAIR`, then verify the full nominal credit against the actual receipt. Current `executionModify` combines the two actions into one external call, so the engine currently sees only the final zero delta; adding a new check after the existing call cannot recover the overwritten nominal credit. Either method must preserve independent principal cost and verify returns before treating a taxed loss as reinvestment.

This is a proposal for exact-transfer qualification/rejection, **not** authorization to implement broad fee-on-transfer support or charge a token's tax to the user's reinvestment amount. Setup-assisted swaps, direct user trading, token-specific floor/hook authorization and owner recovery have separate transfers and policies; they are outside these automation recipes.
