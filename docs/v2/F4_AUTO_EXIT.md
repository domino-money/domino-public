# Domino V2 — F4 auto-exit (S3)

The auto-exit module of domino-money/domino#283 (service S3, workstream F4), built on the F0 freeze ([F0_INTERFACES.md](F0_INTERFACES.md)). An owner signs a one-shot `ExitMandate`; once the anchor price crosses its trigger, an admitted operator executes it through the owner's vault, which removes the whole position and hands it to the module. The module charges the 20 bps exit fee, converts if asked, checks a floor against the anchor and delivers to the owner.

It is the first Domino contract with power over principal. Its audit scope is this document, `contracts/src/v2/autoexit/` and `IDominoAutoExitExtension`.

## Files

| Path | What |
| --- | --- |
| `contracts/src/v2/autoexit/DominoAutoExit.sol` | The module. Implements `IDominoAutoExit` (frozen), `IDominoAutoExitExtension` and ERC-165, on F1b's foundation ([F1_FEES_ROUTE.md](F1_FEES_ROUTE.md)): `DominoFeeLedger` (`IDominoFeeSettlement`), `DominoSwapExecutor`, `DominoSwapFloor`, `DominoActionLock` and `DominoTokenOps`. Runtime 19,470 bytes of 24,576. |
| `contracts/src/v2/interfaces/IDominoAutoExitExtension.sol` | The additive surface: records, nonce cancellation, claims, parameters, errors, the vault instruction type. Exported to `api-contracts/v2/abi/` and pinned like the F0 interfaces. |
| `contracts/test/v2/autoexit/` | Three suites, the fixture and the test doubles (registry, anchor, vault, router, tokens, wallets). |
| `contracts/mutations/auto-exit-2026-10-01.json` | The mutation batch that backs "every guard is tested". |

## Consent and lifecycle

**Two explicit acts.** The owner enables the module on the vault (`setExitModule`). Separately, the owner signs the `ExitMandate` (EIP-712, domain `Domino`/`2`, this chain, this module). The wallet shows each field: the vault and position, each trigger, whether to receive both tokens or one, the slippage and the validity.

**Signers.** ECDSA is tried first: an EOA, or an EIP-7702 account whose delegate has no `isValidSignature`, signs with its own key. Only low-s signatures count. Then EIP-1271 on the owner's code: the call must succeed and return the magic value in a full word.

**Statuses** (`mandateStatus`, `mandateOf`):

| Status | Reached by |
| --- | --- |
| 0 unknown | — |
| 1 active | `registerMandate` |
| 2 revoked | `revokeMandate` |
| 3 executed | `execute` |

- Expiry is not a status: an active mandate past `validUntil` still reads 1 and never executes.
- A mandate's id is its EIP-712 struct hash (`DominoV2Types.hashExitMandate`). An id registers once; a revoked or executed id never comes back.

**Registration** (anyone submits, gas is theirs) refuses:

| Case | Error |
| --- | --- |
| The id is already known | `MandateAlreadyRegistered` |
| Zero owner or vault | `InvalidMandate` |
| `validUntil` already past | `InvalidMandate` |
| No trigger set | `InvalidMandate` |
| `triggerBelow >= triggerAbove` with both set | `InvalidMandate` |
| `maxSlippageBps` zero or above `MAX_SLIPPAGE_BPS` (1,000) | `InvalidMandate` |
| `RECEIVE_BOTH` with a `convertTo` | `InvalidMandate` |
| `RECEIVE_CONVERTED` into a token other than the pool's two | `InvalidMandate` |
| Any other `receiveMode` | `InvalidMandate` |
| The owner's nonce already used | `NonceAlreadyUsed` |
| A signature that is not the owner's | `InvalidSignature` |
| An owner who does not own the vault | `Unauthorized` |

**Nonces** are unordered and per owner. Registration consumes the mandate's nonce. `cancelNonce(nonce)` voids a mandate that was signed but never registered: whoever holds that signature can no longer register it.

**Revocation** is the owner's alone, at any time: with automation halted, with the module disabled, after expiry. It depends on no operator, publisher or registry state.

**Owners should know:**
- Disabling the module on the vault (`setExitModule(0)`) pauses that vault's mandates; it does not revoke them. Enabling the module again brings them back. The app should offer to revoke them at that moment, or show them as paused.
- Executing one mandate does not end other active mandates on the same position.

## Execution

`execute(mandateHash, execution)` refuses, in this order:

| Case | Error |
| --- | --- |
| The caller is not a registry operator | `Unauthorized` |
| The registry halted automation | `AutomationHalted` |
| The mandate is not active, or the time is past `validUntil` (it still executes at `validUntil`) | `MandateNotActive` |
| The vault's `exitModule()` is not this module | `ExitModuleNotEnabled` |
| The vault's `owner()` is no longer the mandate's owner | `VaultOwnerChanged` |
| The vault's pool has no two ordered tokens, or the conversion target is not one of them | `InvalidMandate` |
| A TWAP window shorter than `minTwapSeconds` | `TwapWindowTooShort` |
| The anchor refuses the evidence | the anchor's error, e.g. `ObservationExpired`, `SpotOutsideBand` |
| The anchor returns zero | `InvalidAnchor` |
| No trigger reached | `TriggerNotReached` |

**The halt applies to exits.** `IDominoRegistry.automationHalted` stops "operator executions on every vault", and an exit is the most powerful one. A guardian halts when an operator key, a publisher key or the anchor is in doubt. During a halt, owners still revoke and still exit by hand through the vault.

**The anchor.**
- The module calls `anchor(vault.pool(), evidence, maxAge, band)`.
- `band` is the mandate's `maxSlippageBps`: the spot may stand at most that far from the anchor.
- A signed observation's `maxAge` is the module's `maxObservationAgeSeconds`.
- A v3 TWAP's evidence is 32 bytes. Its window must be at least `minTwapSeconds`. The module then passes the window itself as `maxAge`: an anchor that bounds a TWAP window by `maxAge` accepts exactly what the module approved, and an anchor that ignores `maxAge` for a TWAP is unaffected.

**Triggers.** Prices are the pool's sqrt price, token1 per token0, Q64.96.
- `triggerBelowSqrtPriceX96` fires when the anchor is at or below it.
- `triggerAboveSqrtPriceX96` fires when the anchor is at or above it.
- Zero disables a trigger. Both set make a bracket.
- Whether "below" is the stop-loss depends on the pool's token order; the app translates.

**One shot.** The mandate is marked executed before the vault is called. A revert anywhere undoes the whole execution, the removal included.

## The vault's side (F3)

The module calls `IDominoVault.executeExit(tokenId, instruction)`. `instruction` is version 1 of `IDominoAutoExitExtension.ExitInstruction`, abi-encoded:

```
abi.encode(uint8 version = 1, bytes32 mandateHash, address recipient = the module, uint128 amount0Min, uint128 amount1Min)
```

What the module assumes the vault does (the test double `MockVault` follows points 1 to 6 and emits `ExitExecuted`):
1. Accept the call only from its enabled `exitModule()`, and never when that is zero.
2. Refuse any other instruction version, and a `recipient` other than the caller.
3. Accept only a `tokenId` the vault manages: the root or a successor.
4. Collect the position's fees and remove all of its liquidity, with `amount0Min`/`amount1Min` as the removal minimums.
5. Send everything withdrawn, principal and the position's fees, to `recipient` in the same call. Only the pool's two currencies; native currency by call.
6. Return the vault's unconsumed reserves to the owner without fee (as a credit when the owner cannot receive).
7. Stop automating that position, emit `ExitExecuted`, and return the amounts it sent.
8. Never call back into the module; the module would refuse it.

The module never trusts the returned numbers. It measures what arrived (balance before and after) and holds it to the operator's minimums: `BelowMinimum` catches a vault that reports a full removal but hands over less.

Recommendations for F3:
- Allow `executeExit` while the owner has paused compounding. A pause stops automation; the mandate is a separate consent with its own revocation.
- `setExitModule` may check `supportsInterface(type(IDominoAutoExit).interfaceId)` on the module.

## Conversion

`RECEIVE_CONVERTED` delivers one token, `convertTo`, which must be one of the vault's pool tokens.

A third token is not supported. The anchor prices only the vault's pool, so the module could not bound the output against it. An owner who wants a third token converts afterwards with S1.

**Legs run through F1b's executor** (`DominoSwapExecutor._executeLegs`), with its rules and errors:
- `LEG_UNIVERSAL_ROUTER`: an admitted router, paid through Permit2 with exact, same-block allowances.
- `LEG_V3_POOL`: a v3 path, exact input on the CREATE2 pools.
- `LEG_V4_POOL`: a v4 path through the PoolManager, hooks allowed on the swap.
- Each leg is accepted by its effect: exactly `amountIn` left, at least `minAmountOut` arrived, no other tracked balance moved (both pool tokens and native currency are tracked), no allowance survived.

**What the module adds:**
- Every leg sells the other pool token (`tokenIn`) for `convertTo` (`tokenOut`), or `InvalidExecution`.
- A leg's `amountIn` is exact. On a pool leg, zero means "everything that remains", filled in at execution, because the withdrawal is only known then. A router leg's calldata fixes the amount it pulls, so a router leg with zero is `InvalidExecution`.
- Everything withdrawn must be converted, or `InvalidExecution`.
- The executor requires each leg's `minAmountOut` to be positive; the module's own floor applies on top.

## The floor

```
converted >= DominoSwapFloor.minimumOutput(source withdrawn, anchor, direction, poolFee, maxSlippageBps)
          =  quote(source at the anchor) × (1 − poolFee / 1e6) × (1 − maxSlippageBps / 1e4)
```

- "Source withdrawn" means after any fee taken before the conversion (see the fee rules). What was already in the target token is delivered as withdrawn.
- **The pool fee** is the vault pool's, read as `DominoSwapFloor` reads it: on v4 the protocol plus LP fee for the direction, from the PoolManager's slot0; on v3 the fee tier (`PoolRef.fee`), which already contains the protocol share.
- **Slippage excludes the pool fee** (owner decision, 2 Oct), as `Limits.maxSlippageBps` does (#282, the #3409682 fix): a 1% mandate on a 2% pool floors the conversion at 97.02% of the anchor value (0.98 × 0.99; the #3409682 swap filled at about 97.8% of spot). It covers price impact and the anchor-spot gap.
- **Ceilings.** `maxSlippageBps` is at most 10% (`MAX_SLIPPAGE_BPS`). The pool fee counts at most 10% (`MAX_POOL_FEE_PIPS`), so a hook that raises a dynamic fee cannot drag the floor down. Worst case: 0.9 × 0.9 = 81% of the anchor value of what is converted.
- **No price math of its own.** Every conversion at the anchor (this floor, and the fee's valuation) is `DominoSwapFloor.quote`, whose `mulDiv` is the one vendored `FullMath` in `src/v2` (`contracts/src/v2/positions/uniswap`, F1c; see [F1_POSITIONS.md](F1_POSITIONS.md#vendored-math)).

**Why the withdrawn amounts.** The floor values what the vault actually removed, not the position's amounts at the anchor price. A removal at a spot moved inside the band never loses anchor value: an AMM's holdings at a price are its cheapest holdings valued at that price. So this floor is at least as strict as a position-based one and needs no tick math. It also makes the position's accrued fees count, so they cannot hide slippage.

**Receiving both tokens.** Nothing is converted; the owner gets the tokens as removed. The band (spot within the slippage of the anchor) and the removal minimums bound the removal.

## The fee

20 bps (`FEE_AUTO_EXIT_BPS`) of the position at exit. It is the only charge, even with a conversion. It is rounded down for the owner. The position's uncollected fees are part of the position at exit; they are not reinvested, so they never bear the 2%/4% automation fee. The vault's reserves are never charged. Which token it is taken in follows the charge-currency rule of F0, with ranks from `IDominoRegistry.chargeCurrencyRank`:

| The owner receives | The fee |
| --- | --- |
| One token, a charge currency | 20 bps of the converted output, in that token. |
| One token, not a charge currency | 20 bps of each token withdrawn, in that token, taken before the conversion; the output is not charged. |
| Both tokens, at least one a charge currency with a nonzero amount | 20 bps of both valued at the anchor, in the better-ranked of those currencies (token0 on a tie). If that amount does not cover it, the rest comes from the other token at the anchor price. |
| Both tokens, neither a charge currency (or the listed one came out empty) | 20 bps of each token withdrawn. |

Examples on Robinhood (USDG rank 1, ETH/WETH rank 2):
- ETH/USDG received as both: the fee is in USDG.
- ETH/MANY converted to ETH: 20 bps of the ETH output.
- ETH/MANY converted to MANY: 20 bps of the ETH and of the MANY withdrawn.
- MANY/TSLA received as both: 20 bps of each.
- An ETH/MANY position wholly in MANY, received as both: 20 bps of the MANY.

**Settlement** is F1b's `DominoFeeLedger`:
- Each fee emits `FeeCharged(3, token, owner, amount, mandateHash)` and is pushed to `registry.feeRecipient()` at once, with at most 100,000 gas, and measured on the module's balance.
- With no recipient, or when the push falls short, the shortfall becomes owed (`FeeDeferred`).
- Anyone may later `flushOwedFees(token)` to the recipient then in force (audit A1). It fails with `FeeRecipientUnavailable` or `FeeTransferMismatch`.

## Delivery

- Everything goes to the mandate's owner, pushed in the same transaction. A native push gets 100,000 gas; an ERC-20 push gets what remains.
- **Measured.** A delivery is judged by the module's balance, not by what the token says. A token that moves the amount and returns false has delivered. One that returns true and moves nothing has not.
- **Not blocking.** A push the owner cannot receive does not block the exit. Examples: an EIP-7702 account without `receive()`, a frozen USDG account, a token that returns false. The shortfall becomes `unclaimed[owner][token]` (`DeliveryDeferred`). The owner may later `claim(token, recipient)` to any address they choose; a claim must move exactly the credit, or `DeliveryMismatch`.
- **No over-debit.** A token that takes more than the amount would spend what the module holds for others. Such an exit or claim reverts with `DeliveryMismatch`.
- `MandateExecuted` reports the amounts delivered or credited, net of the fee. The reserves the vault returned directly are not included.
- Nothing else stays in the module after an execution.

## Safety notes

**Manipulation.**
- Manipulating the pool fires nothing: the trigger reads the anchor, never the spot.
- At execution, manipulation worsens nothing beyond the mandate's slippage, because of the band and the floor.

**A compromised operator** chooses only the following, and each is bounded:

| Choice | Bound |
| --- | --- |
| When to execute | After a trigger |
| The evidence | Fresh, from an admitted publisher, or a long enough TWAP |
| The legs | Admitted routers or v3/v4 pools, each checked by its effect |
| The minimums | The module's floor applies regardless |

- Its worst case is the slippage tolerance of the exit it executes.
- The guardian removes it (`removeOperator`) or halts automation for the whole fleet.

**A compromised publisher** can move a v4 anchor only within the band around the real spot. The floor is computed against that anchor.

**Reentrancy.** `DominoActionLock`'s transient lock covers every entry point, the ledger's `flushOwedFees` included (`ReentrantCall`); the executor only runs inside it. The module accepts native currency only while an `execute` runs.

**A vault the owner signs for need not come from the factory.** Such a vault can only exit its own tokens:
- the module accounts by balance deltas;
- it requires two ordered, distinct pool tokens and a conversion target among them;
- so it never pays out another owner's credit or an owed fee.

The planner (F6) should still service factory vaults only, to avoid wasting gas.

**No admin.** The module has no admin, no upgrade path and no sweep. Tokens sent to it outside an execution stay there.

## What users must be told

- **The trigger price is not guaranteed.** On a gap or a rug, liquidity can vanish before the exit. The exit runs only when the anchor has crossed and the spot is within the slippage of it. On a v3 TWAP the anchor lags its window: after a fast move the exit waits until the TWAP catches up, and it may never happen if the pool empties first.
- When converting, the slippage comes on top of the pool's own fee.
- Disabling the module pauses mandates; it does not revoke them.
- Other mandates on the same position stay active after one fires.

## Deployment

- **Constructor:** `(RouteConfig route, priceAnchor, maxObservationAgeSeconds, minTwapSeconds)`. `route` is F1b's `{registry, permit2, v3Factory, v3PoolInitCodeHash, v4PoolManager}` from the chain profile; a zero factory or PoolManager disables that leg kind. None of the other three may be zero.
- **Address:** deployed through CreateX `deployCreate3` with the `autoExit` salt of F0, so the address is the same on every chain while the arguments are per chain.
- **Values** (owner decision, 2 Oct): `maxObservationAgeSeconds` 300, `minTwapSeconds` 600 (v3 TWAPs only).

## The anchor (F1a)

Checked against F1a's implementation (PR #290, `docs/v2/F1_REGISTRY_ANCHOR.md`); the test double follows it.

- **Evidence.** 32 bytes is a v3 TWAP's `secondsAgo`; anything else is a signed observation.
- **TWAP window.** The anchor accepts a window within `[its own minTwapSeconds, maxAgeSeconds]` (`TwapUnavailable` otherwise). The module first requires its own `minTwapSeconds`, then passes the window as `maxAgeSeconds`, so the ceiling holds by construction. The effective floor is the larger of the two minimums.
- **Band.** Symmetric on the price: `max(a, s)^2 * 10000 <= min(a, s)^2 * (10000 + d)`, with `d` the mandate's slippage.
- **Reverts that reach the operator:**
  - `PoolUnavailable` (spot unreadable);
  - `InvalidObservation` (out-of-range price, future date, bad or unadmitted signer, another pool);
  - `ObservationExpired`;
  - `ObservationRevoked` (revoked, or older than the registry epoch);
  - `TwapUnavailable`;
  - `SpotOutsideBand`.
- **Zero.** F1a never returns a zero price; the module refuses one anyway (`InvalidAnchor`).

## For the planner (F6) and the app (F7)

**Reading mandates.** `MandateRegistered` gives the id, owner, vault and token id. `mandateOf(id)` gives the triggers, mode, target, slippage and validity, and `mandateStatus(id)` the status. Watch the vaults' `ExitModuleSet`.

**Building an `Execution`:**
- `anchorEvidence`: a fresh publisher observation, or `abi.encode(uint32 window)` with `window >= minTwapSeconds` on v3.
- `legs`: as F1b's guide for the planner says. Router calldata is paid through Permit2 (`payerIsUser = true`, `SETTLE_ALL`), swaps exactly `amountIn` and pays `MSG_SENDER`. Put the remainder on a v3/v4 pool leg with `amountIn = 0`, which the module fills in. Every `minAmountOut` must be positive. Leave legs empty when receiving both.
- `amount0MinRemoved`/`amount1MinRemoved`: optional removal minimums.

**Reverts** to decode: the four errors of `IDominoAutoExit`, those of `IDominoAutoExitExtension`, the anchor's errors, and F1b's (`InvalidPlan`, `SwapEffectMismatch`, `ReentrantCall`, the ledger's).

**The app:**
- the signature screen;
- a default slippage, on top of the pool's fee;
- the disclosure above;
- a claim screen for `unclaimed`.

## Tests

| Suite | Tests | Covers |
| --- | ---: | --- |
| `DominoAutoExitMandate.t.sol` | 35 | Every registration term, signatures, replay, revocation, nonces, the F0 goldens, ERC-165, the constructor and the size limit. |
| `DominoAutoExitExecute.t.sol` | 47 | Operator, halt, status, expiry and consent. The anchor: stale, unadmitted, revoked, epoch-voided, unreadable pool, down, zero, band, TWAP window and arguments. Triggers and brackets, one shot, removal minimums, a withholding vault, reentry into each entry point. Measured delivery (reverting, false-returning, lying and over-debiting tokens), credits and claims, owed fees and flush, gas-burning owners and recipients. |
| `DominoAutoExitConversion.t.sol` | 32 | Conversion both ways, through a router and through the vendored PoolManager's v4 pools, native in and out. The remainder on a pool leg, split routes, every leg rule. The floor to the unit, the #3409682 case, the 10% fee ceiling, a v4 protocol fee, a v3 tier. F1b's executor refusals as wired. Every fee rule, and fuzzed conservation with the fee bound. |

They run on Robinhood's Permit2 runtime, the vendored v4 PoolManager and F1b's scripted router. The doubles implement the frozen interfaces with the semantics their NatSpec states, and the anchor follows F1a's implementation. Each can turn adversarial where a test needs it:
- a vault that withholds or calls back in;
- an anchor that is stale, down, zero or out of band;
- a router that refunds, slips ETH in, fails or calls back in;
- tokens that revert, return false, lie, over-debit or return nothing;
- receivers that refuse native currency, burn gas or bounce it back.

v3 pool legs run through the same `_executeLegs` call; F1b's suites exercise them against Robinhood's deployed pool runtime.

## Mutation evidence

`contracts/mutations/auto-exit-2026-10-01.json` deletes or weakens each guard of the module, one at a time, and runs its suite:

```
node scripts/mutate-contracts.mjs contracts/mutations/auto-exit-2026-10-01.json --with-artifacts
```

`--with-artifacts` (added with F4) seeds the sandbox with this checkout's `contracts/cache` and `contracts/out`. It needs a checkout where the contract suites have already run. After a passing suite, `test-contracts.mjs` checks the sizes of the V1 artifacts, and no V2 suite builds them; without the flag every verdict, the baseline included, reads NO BUILD.

The batch has 107 mutations and declares one survivor with its reason: `_deliver`'s early return on zero is gas only, since a measured zero push moves and credits nothing either way.

**Results.**
- **The 53 guards added or changed by the rebuild on F1b:** 52 caught, plus that survivor. One gap the run exposed, "a leg that sells the wrong token", is now pinned by a test that gets the input token wrong and the output token right.
- **The other 54:** their code is unchanged, and all were caught in the full run on the previous revision.

Guards that moved into F1b's modules are pinned by F1b's batch (`v2-fees-route-2026-10-01.json`): the lock itself, the fee push and flush, token calls, leg kinds and effects.

## Follow-ups

- **Fork tests**, against the deployed Universal Router, once F3's vault exists.

## Owner decisions (2 Oct 2026)

1. **Both tokens received, one a charge currency:** the whole 20 bps in that currency (kept). `IDominoAutoExit`'s NatSpec now says so; the ABI and its id did not change.
2. **Conversion into a token that is no charge currency:** 20 bps of each token withdrawn, before the conversion (kept).
3. **Slippage excludes the pool fee:** the floor is `DominoSwapFloor.minimumOutput` (changed from the first draft, where slippage included it). The 10% cap is kept.
4. **The registry halt stops exits** (kept).
5. **No conversion into a third token** (kept).
6. **Undeliverable amounts become claimable credits** (kept).
7. **Windows:** `maxObservationAgeSeconds` 300; `minTwapSeconds` 600, for v3 TWAPs only.
8. **Direct v3/v4 legs** through F1b's executor: enabled (the size allows it).

Decided 3 Oct 2026: the 10% ceiling on the pool fee counted in the floor (`MAX_POOL_FEE_PIPS`), this front's own bound on dynamic fees, is kept; it touches only pools above 10%.
