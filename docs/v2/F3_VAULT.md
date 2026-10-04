# Domino V2 — F3: auto-compound vault and factory

Workstream F3 of domino-money/domino#283 ("Contratos: auto-compound V2"); the technical base and the V1 audit are in #282. This front builds the vault and its factory on the F0 freeze ([F0_INTERFACES.md](F0_INTERFACES.md)) for Uniswap v3 and v4, with the custody the owner approved on 1 Oct 2026.

It is built on the two F1 foundations, both on main:
- **F1c** (#291, [F1_POSITIONS.md](F1_POSITIONS.md)): every position action is `DominoV3Positions` / `DominoV4Positions`, and the Uniswap math is F1c's vendored copy.
- **F1b** (#292, [F1_FEES_ROUTE.md](F1_FEES_ROUTE.md)): swaps run in F1b's swap-leg executor, the tariff is charged through F1b's `DominoFeeLedger`, the floor is F1b's `DominoSwapFloor`, and every entry point takes F1b's one transient lock.

The vault keeps no copy of either: what it owns is custody, the plan, the fee ledger per position, the Domino routing and geometry, and the owner surface.

## Contracts

| Contract | Source | Deployed as |
| --- | --- | --- |
| `DominoV2VaultV3`, `DominoV2VaultV4` | `contracts/src/v2/vault/DominoV2VaultV{3,4}.sol` | Components `vault.v3` / `vault.v4`: the implementations behind every clone |
| `DominoV2VaultExecutorV3`, `DominoV2VaultExecutorV4` | same files | Created by their implementation's constructor; reached only by DELEGATECALL |
| `DominoV2VaultSwapModule` | `contracts/src/v2/vault/DominoV2VaultSwapModule.sol` | Component `vaultSwap`, one per chain, shared by both implementations; reached only by DELEGATECALL |
| `DominoV2VaultFactory` | `contracts/src/v2/vault/DominoV2VaultFactory.sol` | Components `vaultFactory.v3` / `vaultFactory.v4` |
| `DominoV2VaultStorage`, `DominoV2VaultBase`, `DominoV2VaultExecutor` | abstract | The shared layout, the owner surface, the execution path |
| `DominoV2VaultPlan` | library | The plan encoding (below) |
| `DominoV2VaultMath` | library | The tariff's gross/net split and the exact price ratios of the geometry |
| `IDominoVaultSwapSteps` | `contracts/src/v2/vault/IDominoVaultSteps.sol` | The swap port the module fills |
| `IDominoVaultLedger` | `contracts/src/v2/interfaces/IDominoVaultLedger.sol` | Additive F0 interface: the per-position ledger for F6 and F7, the v3 operator rearm (`RootCheckpoint`, `RootCheckpointed`, `operatorRearm`) and the return of a closed vault's reserves (`returnReserves`, `RootOpen`, `SuccessorActive`) |

The vault implements `IDominoVault`, `IDominoVaultExecution`, `IDominoFeeSettlement` (F1b's ledger) and `IDominoVaultLedger`. The factory implements `IDominoVaultFactory`.

## Deployment design

**EIP-1167 clones of one implementation per DEX, an executor per implementation, and one swap module per chain, the last two reached by DELEGATECALL.**

- A clone is 45 bytes. Deploying full bytecode per vault would cost about 5M gas. A shared singleton was rejected by the V1 audit (B6): it mixes custody and breaks backing checks by `balanceOf`.
- The address is `CREATE2(factory, keccak256(abi.encode(owner, nonce)), cloneCode)`. It depends only on the owner and the owner's nonce, so the owner can approve the root to `predictVault(owner, nextNonce(owner))` before `createVault`. No vault can be created for someone else, and the implementation and the executor can never be initialized.
- The implementation holds the owner surface, custody and fee settlement. The operator's `execute`, the exit module's `executeExit` and the vault's own v4 position steps run in the executor. Both inherit `DominoV2VaultStorage`, the only contract of theirs that declares state; F1b's owed fees live in ERC-7201 storage (`erc7201:domino.v2.fees`), clear of that layout.
  - The implementation's constructor creates the executor with the same wiring, so the executor is not a separate deployment component.
  - Called directly, the executor refuses everything.
- The swap module is F1b's executor, which does not fit in either contract: about 7 KB of runtime. Its immutables are the chain's route profile (registry, Permit2, v3 factory and pool init code hash, v4 PoolManager), the same for both implementations. Called directly, outside a vault's lock, it refuses to run.

**Sizes** (solc 0.8.26, via-IR, optimizer 200, Cancun; `DominoV2VaultSize.t.sol` enforces both limits for every deployable contract). Measured 2 Oct 2026 with `returnReserves`, from the compiled artifacts; the initcode is the creation bytecode without constructor arguments (the vaults and executors add 192 B, the module 160, the factory 32):

| Contract | Runtime | Headroom | Initcode |
| --- | ---: | ---: | ---: |
| `DominoV2VaultV3` | 15,713 | 8,863 | 37,055 (includes the executor's) |
| `DominoV2VaultV4` | 15,731 | 8,845 | 40,876 (includes the executor's) |
| `DominoV2VaultExecutorV3` | 19,633 | 4,943 | 20,380 |
| `DominoV2VaultExecutorV4` | 23,387 | 1,189 | 24,148 |
| `DominoV2VaultSwapModule` | 7,182 | 17,394 | 7,705 |
| `DominoV2VaultFactory` | 1,470 | 23,106 | 2,141 |

`returnReserves` added 862 B to the v3 implementation (14,851 before) and 729 B to the v4 one (15,002 before), measured against a clean build of main; the executors, the swap module and the factory are byte-identical. (The table this replaces predated F3's last changes.)

- A single contract would not fit: before F1 the vault with execution inside measured 24,121 B (v4) and 26,090 B (v3).
- F1c's v4 library (the four actions with their settlement) is about 6 KB of the v4 executor, which leaves it 1.2 KB of headroom. The next v4 change that needs room should move `executeExit` or the Domino geometry into the implementation, which has 10 KB.
- The swap module is deployed once per chain, not by each implementation's constructor like the executor: it is the same code with the same route profile for both implementations, and inside the v4 implementation's initcode it would leave under 2 KB of EIP-3860's 49,152 bytes.

**Gas** on the PoolManager and PositionManager bytecode deployed on Base (F1c's fixtures), with real fees. The anchor and the registry are test doubles, so a signed observation adds its verification cost. V1 figures are from the V1 audit (#282).

| Operation | V2 | V1 (audit) |
| --- | ---: | ---: |
| `createVault` (clone, initialize, subscribe) | 355,535 | ~1,090,000 |
| `execute`: compound of the root (collect, then increase: two unlocks) | 501,099 | NET 1.01M, GENERAL 1.07–1.18M |
| `execute`: the same with one v4-pool swap leg through the module | 593,638 | — |
| `execute`: mint of a successor | 689,918 | MINT 1.65–1.90M |
| `executeExit`: root / successor | 342,422 / 349,524 | — |
| `notifyUnsubscribe`, cold (the manager gives 300,000) | 15,772 | — |
| `notifyModifyLiquidity`, an owner's change, cold | 16,103 | — |
| `returnReserves`, cold, both tokens / one / nothing to pay | 89,179 / 63,913 / 35,590 | — (no such path: the owner's `withdrawReserves` only) |

Every account the call touches was cooled first (`vm.cool`), so these are first-touch figures, measured with a probe test that is not committed. `returnReserves` pays an owner who already holds both tokens (the close sent them the principal); on the v3 NonfungiblePositionManager deployed on Base, with an owner holding neither token (two new balance slots), it measured 128,227 / 85,861 / 40,438. As a transaction on the Base Anvil of the automation's EVM tests (WETH and the fixture token, both paid), it used 77,583 gas, the intrinsic 21,000 included (`eth_estimateGas` 88,148). A disarm also records its reason (one more storage write, about 5k gas cold). On v3, each checkpoint is also emitted for the operator rearm (about 2k gas per execution that touches the root).

A clone costs about 2,700 gas per call over a direct contract (the DELEGATECALL to the implementation). Executions pay one more DELEGATECALL into the executor, and a swap a third into the module.

## Storage

- **Slot 0:** owner, stateNonce, paused, rootArmed, quote-in-currency0, initialized.
- **Slot 1:** policy, limits, lastExecutionAt and the last disarm reason.
- **Slots 2–4:** the pool.
- **Slot 5:** the root token id (96 bits) and the exit module.
- **Slot 6:** the v3 root checkpoint (a hash; unused on v4).
- **Then:** the member list, the members, the lots and the idle reserves.
- **Elsewhere:** owed fees in F1b's ERC-7201 slot; the lock and the step flags in transient storage.

A simple compound reads 7 cold slots. There is no per-execution intent record (C5) and no copy of a registration checkpoint (C1). There is one counter (B8): every state change advances `stateNonce`, and plans bind it.

## Custody

The root NFT stays in the owner's wallet, with an individual approval (`getApproved`) to the vault; `setApprovalForAll` does not count. Successors minted by Domino-compound are held by the vault: F1c mints them to it, and only the vault can change them.

**v4: the vault is the root's subscriber.**
- At creation (and at `rearm`), the vault checks that the owner holds the root and that the vault has its approval, then subscribes. It keeps a subscription it already has and refuses a foreign one (`ForeignSubscriber`).
- `notifySubscribe` is accepted only during the vault's own subscription, so no one can subscribe the vault to another position, or to the root by hand.
- `notifyModifyLiquidity`, `notifyBurn` and `notifyUnsubscribe` never revert for the PositionManager: a revert would block the owner's own change. Any change other than the vault's own steps disarms the root.
  - The vault marks its own steps on the root in transient storage.
  - A notification from anyone but the manager is refused.
  - A notification about another token is ignored.
- A transfer clears the approval and unsubscribes within the manager's `unsubscribeGasLimit` (300,000 on the deployed chains). The vault needs 15,772 gas, cold.
- If that notification were lost, the next execution still sees it: it checks the subscriber and the approval live and disarms with reason 4. So does the `rootArmed()` view.
- **The vault's own steps** (collect, increase, mint, withdraw) are F1c's `DominoV4Positions`, run inside a PoolManager unlock the vault itself holds: the vault flags the unlock in transient storage, and its `unlockCallback` sends the call to the executor only while that flag is set, where it is accepted only from the PoolManager. Every other `unlockCallback` goes to the swap module, which accepts only the PoolManager with the leg it is waiting for.
- **Hooked pools: refused by default.** Decided (2 and 3 Oct 2026): a root in a pool with hooks is refused, and creation reverts `HookedPool(hooks)`; accepting them is one constant, `ACCEPT_HOOKED_POOLS` in `DominoV2VaultV4.sol`. Successors share the root's pool. If accepted, note that a dynamic-fee hook can charge more than the `lpFee` slot0 shows, which the swap floor reads.

**v3: the vault re-verifies the root on every execution that needs it.**
- After each of its own steps on the root, the vault records `keccak256(liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1)` from the NonfungiblePositionManager.
- An execution that collects from the root first checks that the owner holds it, that the vault is approved, and that the checkpoint matches.
  - On any difference, it disarms the root (reasons 4 and 5) and returns `bytes32(0)` without spending anything.
  - This catches an owner's decrease (principal waiting in tokensOwed), collect, increase, transfer, burn, or approval to another app.
- At arming, whatever the manager already owes the root may be principal from an owner's decrease. When anything is owed, F1c's collect (which always takes everything) sends it to the owner with the fees accrued so far, and only fee growth from the checkpoint on becomes automation fees. When nothing is owed, the accrued fees stay with the root under the owner's consent, as on v4.
- **A third party's addition and the limited operator rearm** (owner decision, 2 Oct). `increaseLiquidity` is open to anyone on v3, so anyone can add dust to the root and change its checkpoint. A registry operator (not under the global halt) may then rearm the vault with `operatorRearm(previous)`, where `previous` is the last `RootCheckpointed` the vault emitted (it emits one at arming and after each of its own steps; storage keeps only its hash). The vault accepts only when:
  - the root is armed, or was disarmed by a checkpoint mismatch (reason 5); after any other reason (custody, exit, `exitAll`, a recovered root) only the owner rearms;
  - `previous` hashes to the stored checkpoint;
  - the owner still holds the root and the vault still has its individual approval;
  - the liquidity grew;
  - in each token, what the root is owed grew by at least `g × previous liquidity` and at most `g × current liquidity`, with `g` the fee growth since `previous` (rounded down, Q128). An addition pokes the fees accrued at the liquidity of the moment, so a collect makes it fall short and a decrease's principal makes it exceed. What is owed never shrinks.

  Then the new checkpoint is recorded and the root is armed (`RootRearmed`). Anything else stays disarmed until the owner rearms. Two additions separated by fee growth can fall a unit short of the lower bound; the vault then also waits for the owner. A decrease smaller than what fee growth on the added liquidity can explain would pass the upper bound: at worst the vault charges its tariff on that dust of principal. `DominoV2VaultCustody.t.sol` pins both sides, including a dust add followed by an owner's decrease.

**`RootDisarmed` reasons:**

| Reason | Meaning |
| ---: | --- |
| 1 | Unsubscribed or transferred (v4) |
| 2 | Changed by someone other than the vault (v4) |
| 3 | Burned (v4) |
| 4 | Custody gone: owner, approval or subscription |
| 5 | v3 checkpoint mismatch |
| 6 | Exited by the auto-exit module |
| 7 | `exitAll` |

`returnReserves` records no reason and changes no arming: a closed root was disarmed by its own notification (v4) or is seen as changed by the next execution (v3).

**What a disarmed root affects.** Only executions that collect from the root, or increase it, are refused. Successors keep compounding, and the root's leftover fees can still fund them under the routing rules (A14: the root is no longer the anchor of all authority). `rearm(true)` takes custody again, with the owner's explicit consent that uncollected fees become automation fees; on v3, after a checkpoint mismatch that is only someone's addition, an operator's `operatorRearm` does it instead. That consent is the same as `consentToUncollectedFees` at creation; `false` reverts.

## Policy and limits

- **Policy:**
  - `mode`: `MODE_SIMPLE` (2%) or `MODE_DOMINO` (4%), through F1b's `DominoFeeRules.automationFeeBps`.
  - `triggerDistanceBps` and `maxOverlapBps`: at most 2,000 each.
  - `minimumIntervalSeconds`: more than 0.
  - `maxPositions`: at least the current number of members. Simple mode requires exactly 1, so downgrading needs the children withdrawn first.
- **Limits:**
  - `maxSlippageBps` and `maxPriceImpactBps`: below 10,000. `maxSlippageBps` excludes the pool fee (see the floor).
  - `maxObservationAgeSeconds`: more than 0.
  - `upsideBps`: 1 to 1,000,000.
- `paused` is not part of the policy (A9), so a pause never makes the owner's `setPolicy` fail. `pause` (owner or registry operator) and `resume` (owner) are idempotent.
- `maxPriceImpactBps` is the band the anchor enforces between the anchor and the spot. `maxObservationAgeSeconds` bounds the observation.

## Fee ledger and the tariff

Each member has, per pool token, a lot of `uncharged` earned fees and `charged` units (`IDominoVaultLedger`).

- **What is charged.** The tariff (200 bps simple, 400 bps Domino) is charged only on uncharged fees that are consumed, whether added to a position or spent as swap input. It is charged once, proportionally in each pool token, and never on principal: the vault never decreases liquidity except in `executeExit`, which charges nothing.
- **Swap output.** The output becomes `charged` units of the same source and is never charged again (`testSwapOutputIsNeverChargedAgain`). Automation swaps carry no assisted-swap fee (F1b's `_executeLegs`, not `_assistedSwap`).
- **Spending order.** Charged units are spent first, then uncharged gross.
- **Rounding.** For a net amount `n`, the gross taken is the least `G` with `G - feeOf(G, bps) = n`, where `feeOf` is F1b's `DominoFeeRules.feeOf` (rounded down, for the owner). It is computed against the source's cumulative gross in the execution, so splitting consumption between the swap and the add pays exactly the same cut as one piece (fuzzed in `DominoV2VaultMath.t.sol`).
- **What is never charged.** Fees not consumed wait uncharged. Owner withdrawals are never charged. `withdrawReserves` spends idle reserves first, then uncharged before charged.
- **Idle reserves.** A withdrawn or exited child's leftover lots become idle reserves: the owner's, never spent by automation.
- `reserves(token)` = idle + every member's lots. `recoverToken` releases only what the vault holds beyond reserves, out of F1b's `_unowedBalance` (owed fees are never the owner's).

**Fee settlement** is F1b's `DominoFeeLedger`:
- The tariff is pushed to `registry.feeRecipient()` in the same transaction, with `FeeCharged(FEE_KIND_AUTOMATION, token, owner, amount, planHash)`, with at most 100,000 gas.
- Whatever the recipient does not receive (a revert, `false`, no recipient, a broken registry) becomes owed (`FeeDeferred`). The execution never reverts for it (A1).
- Anyone can `flushOwedFees(token)` to the recipient in force; it shares the vault's lock, so nothing inside an execution can flush.

## The execution plan (version 1)

`execute(bytes plan)` takes `plan = 0x01 ‖ abi.encode(PlanV1)`: one version byte, then the ABI encoding of the one-element parameter list. A vault rejects any other version byte, an empty plan, or a body that does not decode. Type, as eth_abi writes it:

```
(uint8,uint64,uint64,uint256,int24,int24,uint128,uint128,uint128,uint256[],(uint256,uint128,uint128)[],(uint256,bool,uint128,uint128,(uint8,address,address,address,uint128,uint128,bytes)[]),bytes)
```

| Field | Meaning and rule |
| --- | --- |
| `action` | 1 `COMPOUND`: increase the member `target`. 2 `MINT`: mint a successor of the member `target`. Anything else: `InvalidPlan`. |
| `stateNonce` | Must equal `stateNonce()` (`StaleNonce`). |
| `deadline` | `block.timestamp <= deadline` (`PlanExpired`). |
| `target` | `COMPOUND`: an active member, which must be in `collect` (a v4 increase would otherwise credit its fees into the add, unaccounted). `MINT`: the parent. |
| `tickLower`, `tickUpper` | `MINT` only: the successor's range. Zero for `COMPOUND`. |
| `amount0Max`, `amount1Max` | Ceilings on what the add takes, net of the tariff. |
| `minLiquidity` | Floor on the liquidity added (F1c's `InsufficientLiquidity`). More than 0. |
| `collect` | Members whose fees are collected first into their own lots. Strictly ascending, active. Collecting the root needs the root armed and verified. |
| `budgets` | `(tokenId, max0, max1)`. The sources that fund this execution, with the most each may be debited per token, tariff included. Non-empty, strictly ascending, active, and routable to the destination. The add takes from them in this order. |
| `swap` | `(source, zeroForOne, amountIn, minAmountOut, legs)`. No swap is the all-zero value with no legs. A swap spends exactly `amountIn` of the source's input token and needs the source in `budgets`. `legs` are F1b's `SwapLeg`s (Universal Router, v3 path or v4 path), accepted by F1b leg by leg. |
| `anchorEvidence` | Passed to `IDominoPriceAnchor.anchor` (F1a's format: 32 bytes are a v3 TWAP window, anything else a signed observation). |

**Order of checks and steps:**
1. The lock (F1b's `DominoActionLock`), then: the caller is a registry operator (`Unauthorized`).
2. Not paused and not halted (`AutomationUnavailable`).
3. The plan decodes.
4. The nonce, the deadline, and `minimumIntervalSeconds` since `lastExecutionAt` (`TooSoon`).
5. If the root is in `collect`: it must be armed. If its live custody fails, it is disarmed and the call returns `0` without doing anything else.
6. `anchor()` gives the anchor price, after its band check against the spot.
7. Everything in the table above (`InvalidPlan`, `InvalidRoute`).
8. Collect (F1c's `collect`, into the vault).
9. The swap, if any:
   - the floor;
   - debit of the source;
   - the swap module (F1b's `_executeLegs`, with the pool currencies tracked);
   - for the whole route: exactly `amountIn` left and at least `minAmountOut` arrived (`InvalidAmount`), on top of F1b's per-leg checks;
   - the output credited as charged units (beyond 128 bits: `InvalidAmount`);
   - `anchor()` again, since the swap may have moved the pool;
   - on v4, a second collect of a `COMPOUND` destination, whose fees a swap through its own pool has grown.
10. The add, with maxima from the budgets' capacities, through F1c's `increase` or `mint` (to the vault). What left the vault is allocated to the budgets; a successor id must fit 96 bits.
11. The swap's output must fund the add: afterwards its source may keep at most 1/100 of it (A5).
12. The root must still be armed. On v3 the checkpoint is recorded.
13. The tariff is charged in both pool tokens (F1b's `_chargeFee`).
14. `stateNonce` advances, and `SuccessorCreated` (mint), `Compounded` and `Executed` are emitted.

`planHash = keccak256(abi.encodePacked(uint256 chainId, address vault, bytes plan))`. It is returned, emitted in `Executed`, and used as the `ref` of `FeeCharged`.

**Golden vector** (`DominoV2VaultPlan.t.sol`, computed independently with eth_abi 5.2.0): the plan below encodes to 1,313 bytes with keccak256 `0x890394e7f13c2a4a3f22faf01049af9cfb5c3ecfe20f8b72ba6df3d5aabdaff6`.
- `action` 2, `stateNonce` 7, `deadline` 1790871000, `target` 1234, ticks 5400 / 10080.
- `amount0Max` 2¹²⁸−1, `amount1Max` 5000, `minLiquidity` 1.
- `collect` [1234]; `budgets` [(1234, 1000, 2000), (5678, 3, 4)].
- `swap` (1234, true, 970, 957, [(1, 0x…00AA, 0x1111…1111, 0x2222…2222, 970, 957, 0xdeadbeef)]).
- `anchorEvidence` 0xa0b1.

**Swap floor** (F1b's `DominoSwapFloor.minimumOutput`, at the anchor):
- `minAmountOut >= quote(amountIn at the anchor) × (1 − pool fee) × (1 − maxSlippageBps)`, rounded down once.
- The pool fee is the whole fee of the vault's own pool in that direction:
  - v3: `fee` (the protocol share is part of it);
  - v4: `DominoSwapFloor.v4SpotAndFee`, the direction's protocol fee plus the LP fee as v4-core charges them, from the PoolManager's slot0.
- The pool's fee is not slippage: this is the fix for V1's #3409682, where a 1% pool and 1% slippage could never swap (`testPoolFeeIsNotSlippage`).
- The quote uses the anchor, never the spot (A6/A7).

**Domino rules:**
- **Orientation.** Prices are read as quote per base. The quote is fixed at creation: the pool's best-ranked charge currency in the registry (the chain's stable, then ETH), else currency1.
- **The ceiling** is the upper tick, or the lower tick when the quote is currency0.
- **Routing**, checked against the anchor (A6):
  1. fees return to their own position;
  2. a position the price is in funds nothing else, except its successor once the price is within `triggerDistanceBps` of its ceiling;
  3. a position the price has left funds any position the price is in.
  Simple mode has the root alone, so only rule 1 applies.
- **Successor (`MINT`):**
  - the parent is active, has no active successor, and the sequence is below `maxPositions`;
  - the price is within the trigger distance of the parent's ceiling, or past it;
  - its floor is at or below the basis, by at most `maxOverlapBps`;
  - its ceiling is the first aligned tick at least `upsideBps` above the basis;
  - the range itself (order, bounds, spacing) is F1c's check at the mint (`InvalidRange`, `InvalidTick`).
  The basis is the parent's ceiling or, if the price is already past it, the anchor (A3).
- **Freeing the slot.** Withdrawing or exiting a successor frees its parent's slot (A3).

## Owner surface

- **Anyone: `returnReserves()`** (additive, `IDominoVaultLedger`), after the V1 incident of 2 Oct 2026: an owner closed an automated position on Uniswap itself (liquidity 0, the NFT kept), the vault, its subscriber, only disarmed, and the fees the automation had collected and not reinvested stayed in its ledger, withdrawable only by the owner through a function no screen calls. V2 has the same custody, and a close outside the vault (Uniswap's own app, or S1's zap exit) disarms the root (reasons 1 to 5) and leaves the root's lots and the idle reserves where they are. `returnReserves` is the way out that needs only a caller:
  - **When:** the root is closed, read live from its position manager and never from a stored flag (v4: `getPositionLiquidity(root) == 0`, which a burn also gives, since the PositionManager clears a burned token's info; v3: `positions(root).liquidity == 0`, or the NonfungiblePositionManager refusing the token by name, `Error("Invalid token ID")`, as it does once a token is burned; any other failure of that read leaves the root open), and no successor is active (`positions()` holds the root alone). Otherwise `RootOpen()` or `SuccessorActive()`. While a successor is active, the sequence's reserves can still fund it (A14), so they stay; once the owner withdraws it (or it exits), its leftovers are idle and the closed vault returns everything.
  - **Who can call:** anyone, and it takes F1b's one transient lock, as every entry point does. No one but the owner can make it apply: closing the root needs its owner or an approval the owner gave (an app it approved on v4, say), and the vault's own approval removes the root's liquidity only for the owner's exit mandate (`executeExit`). A third party can only add to a v3 root, never remove from it.
  - **What it pays:** all of `reserves(token)` for both pool tokens (idle and the root's lots, the only member left), to `owner()` and to no one else, without any charge (owner withdrawals are never charged). The root's lots become idle first, then the whole idle reserve is paid, exactly as `exitAll` pays reserves (A8): a token the owner cannot receive, native currency included, stays idle, and the call never reverts for it; a later call, or the owner's `withdrawReserves`, pays it. The ledger is settled before each transfer.
  - **Events and state:** one `ReservesWithdrawn(token, amount, nonce)` per token paid (the event `withdrawReserves` and `exitAll` emit, so the backend's event catalog, read-v6 and the exports need no new event), and the state nonce advances once when anything was paid or moved; with nothing to pay it changes nothing and emits nothing. It returns `(amount0, amount1)`, what it paid. No policy, pause, arming or custody changes, and it never reads the registry: like the owner's exits, neither a pause nor the global halt holds the owner's money back.
  - **The automation** sends it for every vault that qualifies, once per pass at most and before any compound ([V2_AUTOMATION_BACKEND.md](V2_AUTOMATION_BACKEND.md), "Returning a closed vault's reserves").
- **Owner only:**
  - `setPolicy`, `setLimits`, `resume`, `rearm(consent)`;
  - `withdrawReserves(token, amount, recipient)`, `withdrawChild(tokenId)`;
  - `recoverToken(token, amount)`: anything unaccounted, including other tokens, native currency and a swap route's leftover hop token;
  - `recoverPosition(tokenId)` (additive): an NFT of the vault's manager the vault holds without managing it. This includes the root sent to it by mistake, which is then disarmed.
- **`exitAll()`:**
  - every child goes to the owner;
  - every reserve the owner can receive is paid out, and one it cannot receive stays idle (A8);
  - the root is disarmed and automation paused.
  The root's v4 subscription stays until the owner calls `unsubscribe` on the PositionManager or rearms.
- **Exits never depend on the operator, the publisher, the anchor, the registry, the executor or the swap module.** Only `pause` reads the registry, and only for a caller that is not the owner.
- `setExitModule(module)` accepts only `address(0)` or the auto-exit address the implementation was deployed with (component `autoExit`). A phishing page cannot enable another module.
- Every entry point, owner's or not, takes F1b's one transient lock, which `flushOwedFees` and the swap-leg executor share.

## Auto-exit (F4)

The vault side of F4's module (#293, [F4_AUTO_EXIT.md](F4_AUTO_EXIT.md), "The vault's side"), point by point:

```
executeExit(uint256 tokenId, bytes instruction) returns (uint256 amount0, uint256 amount1)
instruction = abi.encode(uint8 version = 1, bytes32 mandateHash, address recipient, uint128 amount0Min, uint128 amount1Min)
            // IDominoAutoExitExtension.ExitInstruction (F4)
```

1. **Caller:** the vault's enabled exit module only (`setExitModule`), never when that is zero: anyone else gets `Unauthorized`. The module can only be `address(0)` or the auto-exit address the implementation was deployed with.
2. **Instruction:** any version but 1, or a `recipient` other than the caller, is refused with `InvalidInstruction`; a body that does not decode reverts. `mandateHash` is the module's; the vault does not read it.
3. **Position:** the root or an active successor (`InvalidPosition` otherwise). A root exit needs only the owner's ownership and the vault's approval (`AutomationUnavailable` otherwise): it works even if the owner touched the root, since the checkpoint and the subscription protect automation fees and an exit charges none.
4. **Removal:** all the position's liquidity, through F1c's `withdraw` to the vault (no burn), with `amount0Min`/`amount1Min` as the minimums on the principal. On v4 the PositionManager credits the position's accrued fees in the same step; on v3 the collect takes everything the position is owed.
5. **Delivery:** everything withdrawn, principal and the position's accrued fees, goes to `recipient` in the same call, measured by the vault's balances: the pool's two currencies only, native currency by call. Nothing else calls into the module.
6. **Reserves:** the position's own lots (fees collected earlier and not consumed) go to the owner without any charge; what the owner cannot receive stays as idle reserves, withdrawable later. Other members' lots are untouched.
7. **Automation stops:** the root is disarmed (`RootDisarmed(6)`), or a successor is retired, its parent's slot freed and its empty NFT returned to the owner (`ChildWithdrawn`). Then `ExitExecuted(module, tokenId, amount0, amount1, nonce)`; the call returns the amounts sent to the module.
8. **No fee:** the vault charges nothing on an exit; the module charges its 0.2%. The position's accrued fees are never reinvested, so they never bear the 2%/4% tariff.
9. **Pause and halt:** `executeExit` ignores `paused`, as F4 recommends (an owner's stop-loss still works when compounding is paused; the mandate is its own consent, revocable at any time, as is the module). The registry's global halt stops it.

The suites pin each point with F4's encoding (`DominoV2VaultExit.t.sol`, `DominoV2VaultUniswapV4.t.sol`, `DominoV2VaultDomino.t.sol`), including a module whose code refuses every call. An integration test with F4's own module is left for when #293 and this front share a base: stacking a third branch here would push CI further past the compiler input ceiling (below).

## The swap port

Positions have no port: the vault calls F1c's libraries directly. Swaps go through one, because F1b's executor does not fit in the vault:

```solidity
interface IDominoVaultSwapSteps {
    function swap(DominoV2Types.SwapLeg[] calldata legs, address tokenIn, address tokenOut) external;
}
```

- **The module** is `DominoV2VaultSwapModule`: `_executeLegs(legs, [tokenIn, tokenOut])` from F1b's `DominoSwapExecutor`, with no assisted-swap fee. The vault reaches it by DELEGATECALL inside its locked execution, so the legs spend the vault's balance, Permit2 approvals are the vault's, and `_executeLegs` sees the lock it requires.
- **Callbacks.** The PoolManager's `unlockCallback` (when the vault does not hold the unlock itself) and a v3 pool's `uniswapV3SwapCallback` reach the module through the vault; F1b authenticates them (the PoolManager with the pending leg; the pool being swapped on, for the hop's exact input). Without a module (`swapModule = 0`), swaps and callbacks revert `StepUnavailable`; compounding without a swap needs no module.
- **What the vault checks on top of F1b.** F1b accepts each leg by its effect. The vault accepts the route: exactly the plan's `amountIn` of the pool's input token left, at least its `minAmountOut` of the other arrived, and the floor at the anchor. A hop token a route leaves behind is unaccounted, so the owner can recover it.
- **Netting (B3) is not used yet.** F1b's `_v4SwapPath` would let a v4 vault swap inside its own position unlock and settle once; the vault runs the swap and the add in separate unlocks today.

## V1 audit findings (#282) in this front

| Finding | Here |
| --- | --- |
| A1 fee push to an immutable recipient | F1b's ledger: recipient from the registry; a failed transfer becomes owed, never a revert; anyone flushes. |
| A2 zero-width allocation floors | The add is guided by amounts: budgets give caps, the plan gives maxima and a liquidity floor, F1c sizes the liquidity at the price; no exact debit floors. |
| A3 fragile successor ladder | The slot frees when a successor is withdrawn or exited; geometry measured from max(ceiling, anchor); no successor below the price. |
| A4 per-vault operator | Operators come from the registry (global revocation by the guardian); `pause` by any registry operator. |
| A5 unnecessary swaps | One direction per plan; the output must fund the add (≤ 1% may remain). |
| A6 decisions on the spot | Routing, trigger, geometry and the floor use the anchor. |
| A7 floor nuance | F1b's floor: anchor quote × (1 − pool fee incl. protocol) × (1 − slippage). |
| A8 fragmented exits | `exitAll`; `withdrawReserves` to a recipient the owner names (3 Oct); `recoverToken` for any token; inexact owner exits keep what cannot be paid as idle instead of reverting; once the root is closed, anyone's `returnReserves` pays the owner every reserve, with the same rule: what the owner cannot receive stays idle. |
| A9 pause cancels setPolicy | `paused` is not in the policy. |
| A14 root as authority anchor | Successors keep working while the root is disarmed; a root sent to the vault is recoverable. |
| A15 limits stored, not enforced | Only enforced limits remain (F0's `Limits`). |
| A16 event gaps | Creation emits policy and limits; `FeesCollected`, `Swapped` (and F1b's `SwapLegExecuted` per leg), `Compounded` with amounts and tariff; `ReservesWithdrawn` with what was paid, by the owner's withdrawals, `exitAll` and `returnReserves` alike. |
| A17 mutation coverage | `contracts/mutations/v2-vault-2026-10-02.json`: every guard the vault owns, one mutant each. |
| B1 signed observations | Consumed through `IDominoPriceAnchor` (F1a). |
| B3/B4 netting, multi-leg swaps | Multi-leg swaps through F1b. v4 netting is left for later (above). |
| B6 one context read | One DELEGATECALL into the executor; no callbacks into the vault for reads. |
| B7 bytecode limit | 24,576 B, enforced per contract. |
| B8 one counter | `stateNonce` only. |
| C1, C3, C5 storage | Packed hot slots; a checkpoint is one hash (v3 only); no intent record. |
| C6 fee push | Push per F0; accumulate-only would save ~20–30k gas per token per execution (owner decision below). |
| D1 bytes that never decide | No codehash pins, no exhaustion handling; checks F1b and F1c already make are not repeated. |
| D2/D3 duplicated code | No copy of the position actions, the Uniswap math, the floor, the fee ledger, the lock or the token calls: F1b and F1c own them. |

## Tests and checks

`contracts/test/v2/vault/`, 12 suites, 249 tests. The executor is the same code on both DEXes: its exact-number cases run on the v3 unit model (`HarnessV3`, a faithful NonfungiblePositionManager mock, with F1c's library on top) and a swap-port double with a fixed rate. Everything v4-specific runs on the PoolManager and PositionManager bytecode deployed on Base (`HarnessV4`, F1c's fixtures), and the production swap module on the same PoolManager.

| Suite | Covers |
| --- | --- |
| `DominoV2VaultExecution.t.sol` | Plan rules; the tariff (2%/4%, once, only consumed); swap floor and its fix; the route's effect checks; A5; F1b fee settlement and owed fees; callbacks reaching the swap module. |
| `DominoV2VaultOwner.t.sol` | Creation, policy and limits, pause/resume/rearm, withdrawals, recovery, `exitAll`, the exit-module switch, the shared lock; v3 arming. |
| `DominoV2VaultCustody.t.sol` | The limited operator rearm (v3: each condition on both sides, a dust add then an owner's decrease or collect, every disarm reason; never on v4). v4 on the deployed PositionManager: subscription, each owner action disarming without being blocked, the transfer's unsubscription, spoofed and foreign notifications, a silently lost notification, cold `notifyUnsubscribe`; v3 re-verification (each mismatch, the dust grief). |
| `DominoV2VaultUniswapV4.t.sol` | v4 paths on the deployed managers: compound inside the vault's own unlock, fees a swap accrues collected first, the protocol fee in the floor per direction, native currency (tariff paid, rejected, gas-hungry), successor mint and exits, exit minimums, the hooked-pool policy, the unlock callback guards. |
| `DominoV2VaultSwapModule.t.sol` | The production swap module (F1b) on the deployed PoolManager: v4-pool legs, native, a swap through the vault's own pool, the route checks on top of each leg's, a refused leg, the lock, forwarded callbacks. |
| `DominoV2VaultExit.t.sol` | `executeExit` per F4: consent, caller, instruction version and recipient, halt, pause, minimums, the position to the module and its reserves to the owner, no callback into the module. |
| `DominoV2VaultDomino.t.sol` | Successor geometry, trigger, cap, routing, slot freeing, inverse orientation, child exit, 96-bit ids. |
| `DominoV2VaultFactory.t.sol` | Prediction, nonces, EIP-1167 code, one-time binding, wiring checks; the implementation and the executor are never vaults (both DEXes). |
| `DominoV2VaultMath.t.sol` | Least-gross and split-rounding properties (fuzzed); exact ratios. |
| `DominoV2VaultPlan.t.sol` | The golden vector and the round trip. |
| `DominoV2VaultSize.t.sol` | Runtime and initcode limits for every deployable contract. |
| `DominoV2VaultReturn.t.sol` | `returnReserves`, one suite on three worlds: the v3 unit model, the factory, NonfungiblePositionManager and pool deployed on Base (`HarnessV3Base`, `VaultHarnessV3Base.sol`: real fees from real swaps) and the v4 managers deployed on Base. Every reserve to the owner after a close or a burn, and only to the owner, whoever calls; refused while the root has liquidity (a partial decrease included) or while a successor is active (and everything returned once the owner withdraws it); A8 (a token, or native currency, the owner cannot receive stays idle and a later call pays it; neither receivable still makes the root's lots idle, once); the nonce only on a change, each token alone; a second call changes nothing; the lock against a token's and a wallet's callback; the ledger against `reserves()` and `recoverToken` with an owed tariff and a donation; neither pause nor halt holds it; nothing else changes; what `exitAll` or an auto-exit could not pay comes back. v3: only the manager's own refusal of a token is a burn, matched byte for byte on the deployed bytecode; a closed root with principal still owed is closed. v4: a failed liquidity read is never a closure. |

Run a suite with `node scripts/test-contracts.mjs --match-path test/v2/vault/<Suite>.t.sol`. Run the mutants with `node scripts/mutate-contracts.mjs contracts/mutations/v2-vault-2026-10-02.json` (see the next section for a cold sandbox).

**`returnReserves` batch** (`contracts/mutations/v2-return-reserves-2026-10-02.json`, run with `--with-artifacts`): 24 mutants, every guard and effect of the new path deleted or weakened alone (the lock, both refusals, the payee, A8's idle, the ledger moves, the nonce in each token, the event, the amounts returned, and each DEX's closure read, the v3 refusal's exact bytes included): **24 caught**, none expected to survive. The DEX mutants are caught too, so the tool's sandbox rebuilds the implementations a suite deploys from their artifacts.

**Mutation batch** (`contracts/mutations/v2-vault-2026-10-02.json`, run in the tool's sandbox seeded with a warm cache): 192 mutants, one per guard the vault owns: **190 caught**; 2 intended survivors, each with its reason in the batch (an owner change inside an execution, which nothing an execution calls can make; the allocation backstop, unreachable since F1c spends at most the maxima). The 24 mutants of the operator rearm and of the code it touched ran on the final tree; the other 168 ran before it, on code it did not change. Guards the first run left uncaught were either pinned by a new test (the root's owner, the v3 individual approval, a retired successor as parent, the trigger whatever funds a mint, an in-range source near its ceiling) or removed as redundant (`notifySubscribe`'s caller and token checks, implied by the vault's own subscription flag; a compound target's `active`, implied by `collect`).

## Compiler input ceiling (infrastructure, affects every V2 front)

`forge test --match-path` first compiles the whole project with ABI-only output, in one standard-JSON input, sending every source that is not cached (all of them on a cold cache). The pinned solc-js passes that input through emscripten's `ccall`, which copies a string argument onto the WASM stack with `stackAlloc(4 × length + 1)`. soljson's stack is 5 MiB, so an input above about 1,311,100 characters crashes it with `RuntimeError: memory access out of bounds`.

| What is compiled in the first pass | Characters (sources, JSON-escaped) | Result |
| --- | ---: | --- |
| main (f51bd12), cold | 1,082,543 (measured) | passes |
| F1c's changes and their imports, on main's cache | ~813,000 | passes |
| F1b's changes and their imports, on main's cache | ~604,000 | passes |
| this front's changes and their imports, once F1b and F1c are on main | ~669,000 | passes |
| F1b + F1c + this front together, on a cache without F1 (the earlier stacked branch) | ~1,458,000 | crashes |

The estimates count the changed sources and their transitive imports, as Forge sends them. CI restores main's cache, so a branch is safe while its own changes fit, which this front does now that F1b and F1c are on main. The ceiling also breaks:
- a cold run (a compiler input changes, or the cache is evicted);
- a fresh clone;
- `scripts/mutate-contracts.mjs`, whose sandbox starts cold. This front's batch ran in that tool's sandbox seeded with a warm cache; F1b reports the same (#145).

Locally, a cold tree warms in pieces: `node scripts/test-contracts.mjs build <dir>` for a few directories at a time, then the suites.

**The fix** is in a pinned build input, `scripts/solc-compile.cjs`: pass the input through the heap instead of the stack.
- Allocate it with `_malloc`, copy it with `stringToUTF8`, then call `solidity_compile` with the pointer.
- The release manifest records that file, so this is a reviewed build change.

## What remains

1. **Fork tests on Robinhood, Base and Arbitrum.** The v4 suites run the bytecode deployed on Base (identical on the three chains but for immutables); v3 runs on a faithful mock of the NonfungiblePositionManager under F1c's library, which F1c tests on the deployed v3 bytecode. CI has no network.
2. **v4 netting** with F1b's `_v4SwapPath` (B3): collect, swap and increase in one unlock, about −60–100k gas per swap. Deferred by the owner (3 Oct 2026) to a later implementation.
3. **Manual actions on positions under automation.** `IDominoPositionActions` on the vault (S1 for automated positions, including a range change that migrates the root) is not part of this front. Out of V2.0 (owner decision of 3 Oct 2026).
4. **Deployment** (F8): CreateX salts and constructor arguments. Done by #302 (`scripts/v2/deploy.mjs`).
   - `DominoV2VaultSwapModule(RouteConfig{registry, permit2, v3Factory, v3PoolInitCodeHash, v4PoolManager})`, once per chain.
   - `DominoV2VaultV3(Deployment)` and `DominoV2VaultV4(Deployment)`, with `Deployment = (factory, registry, priceAnchor, positionManager, swapModule, autoExit)`. The v4 vault takes its PoolManager from the PositionManager, and the v3 vault its factory from the NonfungiblePositionManager.
   - `DominoV2VaultFactory(implementation)`. The implementation needs its factory's address, which CREATE3 makes known in advance.

## Owner decisions (2 Oct)

1. **Hooked v4 pools:** refused by default (`ACCEPT_HOOKED_POOLS = false`), kept. Accepting them is that one constant; the floor then reads slot0's LP fee, which a dynamic-fee hook may exceed.
2. **Domino orientation:** kept. The quote is the pool's best-ranked charge currency at creation, else currency1.
3. **v3 dust grief:** decided 2 Oct, the limited operator rearm (Custody, above).
4. **Fee push vs accumulate:** decided, push per execution with the owed fallback, as F0 says.
5. **Swap leftover tolerance:** decided, up to 1% of a swap's output may stay as reserve (A5).
6. **The compiler input ceiling** above: a dedicated PR changes `scripts/solc-compile.cjs`.

## Owner decisions (3 Oct 2026)

1. **The owner's limits have on-chain ceilings:** `maxSlippageBps` ≤ 1,000 (10%), `maxPriceImpactBps` (the anchor band) ≤ 500 (5%), `maxObservationAgeSeconds` ≤ 300, `minimumIntervalSeconds` ≥ 600. `setLimits`, `setPolicy` and creation refuse anything looser (`InvalidLimits`, `InvalidPolicy`), so neither an app nor an operator works under looser limits.
2. **A8:** `withdrawReserves(token, amount, recipient)` pays the recipient the owner names (never zero, `InvalidRecipient`), so an owner that cannot receive (a 7702 account without `receive`, for native reserves) still gets them out. `exitAll` and `returnReserves` keep paying the owner and keep what cannot be paid idle.
3. **Accepted as they are:** A3 (no minimum successor size: any `minLiquidity` above zero), A4 (global operators, with no per-vault opt-in; item 1 bounds what they may do), A10 (the zap pushes refunds, and an action reverts when one cannot be paid), A14 (no two-step owner transfer), B4 (one source member per vault swap), and no wrap or unwrap leg.
4. **`returnReserves` while a successor is active** stays refused (`SuccessorActive`).
5. **S1 on automated positions** is out of V2.0; **v4 netting** and a **registry list of approved hooks** come later, with new implementations.
