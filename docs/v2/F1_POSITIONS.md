# Domino V2 — F1c position adapters (Uniswap v3 and v4)

F1c is part of F1 ("Contratos: fundação") in domino-money/domino#283; the technical base is #282. It gives the zap (F2, manual management) and the vault (F3, automation) one way to mint, increase, decrease, collect and burn positions on the deployed Uniswap v3 NonfungiblePositionManager and v4 PositionManager. It also covers the liquidity arithmetic and the position reads both need.

The adapters are internal libraries: their code is compiled into the consumer, which keeps its own 24,576-byte budget. They hold no state and emit no events; the consumer emits the F0 events (`PositionActionExecuted`, `Compounded`…).

## Layout

| Path | What |
| --- | --- |
| `contracts/src/v2/positions/DominoV4Positions.sol` | v4 adapter: actions (inside the caller's PoolManager unlock), pool set-up, reads. |
| `contracts/src/v2/positions/DominoV3Positions.sol` | v3 adapter with the same shape: actions, pool set-up, reads. |
| `contracts/src/v2/positions/DominoPositionMath.sol` | Range checks, amounts ↔ liquidity with stated rounding, fee growth. |
| `contracts/src/v2/positions/uniswap/` | Uniswap math vendored from v4-core and v4-periphery (below), the only copy in `src/v2`. |
| `contracts/test/v2/positions/` | Suites, harnesses (consumers wired as F2/F3 would wire them), test kit. |
| `contracts/test/v2/positions/fixtures/` | Deployed Uniswap bytecode from Base, with provenance (below). |
| `scripts/v2/position-fixtures.mjs` | Captures the fixtures; `check` verifies them and the vendored math offline. |
| `contracts/mutations/v2-positions-2026-10-01.json` | Mutation batch: every guard the adapters own. |

No F0 surface changed: nothing under `src/v2/interfaces` or `src/v2/external` was edited, and `api-contracts/v2` is unchanged. The two Uniswap functions F0's minimal declarations omit are declared next to the adapter that uses them, and the tests run them against the deployed bytecode:
- `PoolManager.initialize`, in `IV4PoolInitializerMinimal`;
- `createAndInitializePoolIfNecessary`, in `IV3PoolInitializerMinimal`.

## The shape both adapters share

```solidity
// v4: (IV4PoolManagerMinimal poolManager, IV4PositionManagerMinimal positionManager)
// v3: (IUniswapV3PositionManagerMinimal positionManager, IUniswapV3FactoryMinimal factory)
struct Managers { ... }

struct Result {
    uint256 tokenId;
    uint128 liquidity;  // added or removed by this action
    int256 delta0;      // per pool currency: < 0 paid from this contract, > 0 delivered to the recipient
    int256 delta1;
}
```

| Function | v3 | v4 | What it does |
| --- | --- | --- | --- |
| `mint(m, pool, tickLower, tickUpper, amount0Desired, amount1Desired, minLiquidity, owner)` | ✓ | ✓ (unlocked) | Mints to `owner` the most liquidity the amounts fund at the current price. |
| `increase(m, tokenId, pool, amount0Desired, amount1Desired, minLiquidity)` | ✓ | ✓ (unlocked) | Adds the most liquidity the amounts fund. |
| `withdraw(m, tokenId, pool, liquidity, amount0Min, amount1Min, recipient, burnPosition)` | ✓ | ✓ (unlocked) | Removes liquidity and delivers it with every fee owed; optionally burns. |
| `collect(m, tokenId, pool, recipient)` | ✓ | ✓ (unlocked) | Delivers the fees (v3: everything owed) without touching liquidity. |
| `mintLiquidity(...)`, `increaseLiquidity(...)` | — | ✓ (unlocked) | Exact liquidity, bounded by `amount0Max`/`amount1Max`. |
| `initialize(m or manager, pool, sqrtPriceX96)` | ✓ | ✓ | Initializes the pool unless it has a price; returns the price in force. |
| `checkManagers(m)` | ✓ | ✓ | Constructor check: the position manager belongs to this factory / PoolManager. |
| `position(m, tokenId)` | ✓ | ✓ | Owner, pool, range, liquidity, fee checkpoints; v3 adds approval and tokensOwed, v4 the subscriber. |
| `collectable(m, tokenId)` | ✓ | ✓ | What `collect` would deliver now. |
| `feeGrowthInside(...)` | ✓ | ✓ | Fee growth inside a range now, as the pool computes it. |
| `isAuthorized(m, tokenId, account)` | ✓ | ✓ | Owner, token approval or operator. |
| `poolAddress(m, pool)` | ✓ | — | Validates a v3 PoolRef against the factory and returns the pool. |
| `slot0(manager, pool)`, `poolId(pool)` | — | ✓ | Price, tick, protocol fee and LP fee; the v4 pool id. |

`pool` is always the F0 `DominoV2Types.PoolRef`, so a zap or vault written once for both versions only switches the library. Every action on an existing position checks that `tokenId` belongs to `pool`; a mismatch reverts with `PositionPoolMismatch`, so a plan can never act on a position of another pool. Amounts are `uint128`, as in F0.

## v4: how an action settles

Every v4 action must run inside a PoolManager unlock **held by the calling contract**. The consumer's `unlockCallback` (accepting only the PoolManager) calls the library. Inside that callback, one action does three things:

1. **Action.** It calls `PositionManager.modifyLiquiditiesWithoutUnlock` with one action:
   - `MINT_POSITION`, `INCREASE_LIQUIDITY`, `DECREASE_LIQUIDITY` or `BURN_POSITION`;
   - `TAKE` is the only other action used;
   - all five exist in the deployed build (the vendored copy adds actions the adapters never use).
2. **Credits.** It reads the PositionManager's resulting deltas with `exttload`. Each positive delta goes to the recipient with a `TAKE` for that exact amount, in one more `modifyLiquiditiesWithoutUnlock`.
3. **Debts.** It pays each negative delta from this contract's balance: `sync`, a transfer to the PoolManager, then `settleFor(PositionManager)`. Native currency is `settleFor{value: amount}`. `paid` must equal the debt (`SettlementMismatch` otherwise).

Before the action, both of the pool's currencies must have a zero PositionManager delta (`OpenDelta` otherwise). After it, both are zero again.

Why this path:
- **No Permit2 and no allowance.** `SETTLE_PAIR`/`CLOSE_CURRENCY` pay through Permit2 from the locker, which would need an ERC20 approval to Permit2, a Permit2 allowance to the PositionManager, and resetting both. Here nothing is approved, so no allowance can survive.
- **No pre-funded PositionManager.** The other Permit2-free path (transfer to the PositionManager, then `SETTLE` from its balance and `SWEEP`) leaves tokens sitting in the PositionManager. A hostile token of the pair can sweep them during its own transfer.
- **Credits first, at exact amounts.** Credits are taken while the PositionManager is locked. While a pair token's code runs during a payment, only this action's debts are open, so a hostile token finds nothing to take (`testAHostileTokenBeingPaidFindsNoCreditToTake`). `TAKE` amounts are explicit, so even a reordered flow would revert (`CurrencyNotSettled`) rather than lose a credit.
- **Composable.** The same unlock can hold swaps (F1b's route) or several actions, for example change range = `withdraw(old, burn)` then `mint(new)` (`testChangeRangeInOneUnlock`). Each action closes its own deltas, so a sequence is the sum of its steps.
- **Proven in production.** V1's `DominoSetup` mints the same way against the PositionManager deployed on Robinhood.

The consumer must:
- hold the funds it pays with: ERC20 balances, and ETH for native pools;
- accept ETH (`receive`) when it is a native recipient;
- guard its own reentrancy: a `TAKE` of native currency calls the recipient, and pair tokens run code on transfer.

### Sketch: a v4 consumer

```solidity
contract ZapV4 {
    DominoV4Positions.Managers internal m; // from the chain profile, checked by checkManagers in the constructor

    function create(/* plan */) external payable {
        // pull inputs, run swap legs (F1b), then:
        bytes memory out = m.poolManager.unlock(abi.encode(OP_MINT, plan));
        DominoV4Positions.Result memory r = abi.decode(out, (DominoV4Positions.Result));
        // refund what is left of the inputs to intent.recipient, charge the fee (F1b)
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(m.poolManager)) revert Unauthorized();
        // decode, then for a create:
        return abi.encode(DominoV4Positions.mint(
            m, plan.intent.pool, plan.intent.tickLower, plan.intent.tickUpper,
            amount0, amount1, plan.intent.minLiquidity, plan.intent.recipient));
    }
}
```

`contracts/test/v2/positions/V4PositionsHarness.sol` is a working version of this wiring, including a multi-step unlock.

## v3: how an action settles

v3 actions are plain calls to the NonfungiblePositionManager; no unlock is involved.
- **Mint and increase.** The library approves the manager for exactly the desired amounts, calls it (the manager pulls what the pool needs), and resets both allowances to zero in the same call (`ApprovalFailed` if a token refuses). Tokens that return no data (USDT style) work.
- **Withdraw.** It calls `decreaseLiquidity`, which only moves principal into `tokensOwed`. It always follows with `collect(type(uint128).max)` to the recipient, and with `burn` when asked. Nothing it removes stays owed.
- **Native currency.** v3 pools hold the wrapped token (WETH9); a `PoolRef` with `address(0)` is refused. A zap holding ETH wraps it first.

## Liquidity math and rounding (`DominoPositionMath`)

| Function | Rounding | Matches |
| --- | --- | --- |
| `liquidityForAmounts(sqrtPriceX96, tickLower, tickUpper, amount0, amount1)` | down | v3 NonfungiblePositionManager's own sizing (LiquidityAmounts) |
| `amountsForLiquidity(..., roundUp = true)` | up | what a pool charges to add the liquidity |
| `amountsForLiquidity(..., roundUp = false)` | down | the principal a pool pays to remove it (fees on top) |
| `feeGrowthInside(tick, lower, upper, global, lowerOutside, upperOutside)` | wrapping | v3 `Tick.getFeeGrowthInside`, v4 `Pool.getFeeGrowthInside` |
| `feesEarned(inside, insideLast, liquidity)` | down | what a pool credits |
| `checkRange(tickLower, tickUpper, tickSpacing)` | — | ordered, inside ±887272, multiples of a positive spacing (`InvalidRange`) |

Properties under test:
- **Never overcharges.** The charge for `liquidityForAmounts(a0, a1)` never exceeds `(a0, a1)` (fuzzed over the full tick and price range).
- **Rounding.** Rounding up adds at most one unit per token.
- **Exactness against the pools.** Every amount a mint, increase or withdraw moved equals the prediction exactly: on the deployed v4 PoolManager, the vendored one, and the deployed v3 pools, fuzzed over prices below, inside and above the range. On v3 the manager's liquidity equals `liquidityForAmounts`.
- **Uninitialized pool.** A zero price (pool not initialized) reverts `PoolNotInitialized` instead of returning one-sided amounts.

The v4 adapter sizes `mint`/`increase` itself, from the price it reads inside the unlock (after any swap the consumer made in the same unlock). It passes the desired amounts as the PositionManager's maxima. This is the amount-driven addition of #282 (A2/B3): no zero-width window, with `minLiquidity` as the only bound to choose. On both versions the adapters revert with `InsufficientLiquidity(liquidity, minimum)` below it, and v4 also at zero.

## Fees, per token

- **v4 increase credits the owner's fees to the caller.** `increase` nets the position's accrued fees against the principal and delivers the surplus to this contract: `delta = fees − principal` per token (`testIncreaseTakesTheFeeSurplusAndPaysTheShortfall`).
  - A zap must forward that to the owner.
  - A vault compounding a position is funded by the fees first and pays only the shortfall from its reserves.
- **The exact fees of a v4 action.**
  - `collectable` before the action gives them. It reads PoolManager storage the way StateView does, and the tests compare it with the deployed StateView.
  - A subscriber also receives them in `notifyModifyLiquidity(tokenId, liquidityChange, feesAccrued)`. For F3's vault, the position's subscriber, that is free (`testSubscriberNotificationsBlockChangesAndCarryTheFees`).
  - On a hookless pool, `fees = delta + amountsForLiquidity(price, …, roundUp)` also holds for an increase.
- **v3 keeps fees in `tokensOwed`.** An increase or decrease only pokes them there. `collectable` is tokensOwed plus the fees accrued since the manager's checkpoint, which is exactly what `collect` pays (tested in, below and above range).
  - tokensOwed can also hold principal that someone decreased and never collected.
  - `withdraw` never leaves any.
- **Protocol fees.** They are taken from the swap before the LP fee and never reach `collectable`. The tests switch them on (v4 `setProtocolFee`, v3 `setFeeProtocol`) and check that `collectable` still equals what `collect` pays.
  - `slot0(pool).protocolFee` gives the v4 value: 12 bits per direction, in pips.
  - v3's `slot0.feeProtocol` is declared in F0.

## F0 constraints, as the adapters meet them

| Constraint (docs/v2/F0_INTERFACES.md) | How | Test |
| --- | --- | --- |
| v3 mint and increase are open; the payer is the caller | exact approvals, reset to zero | `testIncreaseIsOpenToAnyoneAndLeavesTheFeesOwed`, `testApprovalsThatFailAreRefusedAndNoAllowanceSurvives` |
| v3 decrease, collect, burn need owner or approval | the manager's `Not approved` surfaces | `testWithdrawAndCollectNeedTheOwnersApproval` |
| v4 increase, decrease, burn need approval; mint is open | the PositionManager's `NotApproved` surfaces | `testIncreaseAndWithdrawNeedTheCallersApproval` |
| v4 modify credits accrued fees to the caller | netted and reported in `delta` | `testIncreaseDeliversTheOwnersAccruedFeesToTheCaller` |
| v4 transfer clears approval and subscription | `isAuthorized`/`position` show it | `testTransferClearsTheApprovalAndTheSubscription` |
| `notifyModifyLiquidity`/`notifyBurn` block the owner's change | reverts surface as `WrappedError` | `testSubscriberNotificationsBlockChangesAndCarryTheFees` |
| `notifyUnsubscribe` gets 300,000 gas, best effort | read and checked on the deployed build | `testUnsubscribeIsBestEffort`, `testStackIsWiredAsDeployed` |
| Protocol fees come before the LP fee | `collectable` excludes them | `testProtocolFeeComesOutBeforeTheLpFees` (v3 and v4) |
| Native `address(0)` on v4, WETH on v3 | `settleFor{value}` and native `TAKE`; v3 refuses `address(0)` | `testNativeCurrencyRoundTrip`, `testWrappedNativeIsAPlainToken` |
| The vendored v4 differs from the deployed one (`ModifyPosition`) | every v4 test runs on both builds | `testModifyPositionEventMatchesTheBuild` |

## Failure modes

| Error | When |
| --- | --- |
| `InvalidPool()` | Wrong `dex`. On v3 also: hooks set, `address(0)`, unsorted or equal tokens, or a tick spacing that is zero or not the factory's for the fee. |
| `InvalidRange(lower, upper, spacing)` | Ticks unordered, out of bounds or off the spacing. |
| `PoolNotInitialized()` | Amount-driven sizing on a pool with no price. |
| `PositionPoolMismatch(tokenId)` | The token belongs to another pool (also a burned or unknown v4 token). |
| `InsufficientLiquidity(liquidity, minimum)` | Below `minLiquidity` (v4 also at zero). |
| `InvalidRecipient(recipient)` | v3: the zero address. v4: 0, 1 or 2, which the PositionManager maps to the zero address, the locker and itself. |
| `PartialBurn(tokenId, liquidity, positionLiquidity)` | `burnPosition` without removing all the liquidity: a stale plan never burns more than it states. |
| `OpenDelta(delta0, delta1)` | v4: the PositionManager already had an open delta in the pool's currencies. |
| `TransferFailed(token)`, `SettlementMismatch(currency, expected, paid)` | v4 payment: the transfer failed, or the PoolManager received less (fee-on-transfer). |
| `ApprovalFailed(token)` | v3: approve reverted or returned false. |
| `ManagerMismatch()` | `checkManagers` with a mismatched pair. |
| Uniswap's own | `NotApproved`, `MaximumAmountExceeded`, `MinimumAmountInsufficient`, `WrappedError` (v4); `Not approved`, `Price slippage check` (v3). |

Fee-on-transfer tokens cannot be added to either version: the v4 settlement and the v3 pool's balance check both fail closed.

## Examples for F2 and F3

**F2 create (v4).**
1. Pull the inputs and run the legs.
2. In one unlock: `initialize(manager, pool, initSqrtPriceX96)` when the plan asks for it, then bound the returned price; then `mint(m, pool, lower, upper, min(balance0, amount0Max), min(balance1, amount1Max), intent.minLiquidity, intent.recipient)`.
3. Refund the rest.

v3 is the same without the unlock: `initialize`, then `mint`.

**F2 increase.**
- v4 needs the owner's approval of the zap (or an ERC721 `permit`). The fees the increase credits arrive at the zap and must go to the recipient with the refund.
- The approval stays after the action, and the approved zap cannot clear it. So the zap's entry points must authorize the owner themselves.
- v3 needs no approval.

**F2 change range.** In one v4 unlock: `withdraw(old, liquidity, mins, address(this), burnOld)`, the swap legs, then `mint(new range)`. On v3 the same calls run in sequence.

**F2 exit.** `withdraw(tokenId, pool, liquidity, mins, recipientOrZap, burn)`, then any conversion legs.

**F3 compound.**
- **v4.** Read `collectable` or take the subscriber notification. Then `increase(tokenId, pool, reserve0 + fees0, reserve1 + fees1, minLiquidity)`: the fees fund the addition in place and only the shortfall leaves the vault.
- **v3.** `collect(tokenId, pool, vault)`, then `increase(...)` from the vault's balance.
- Successors: `mint(..., owner = vault)`.

**F3 v3 re-verification.** Before each execution, compare `position(m, tokenId)` with what the vault stored after its last action:
- owner and approval;
- liquidity, both `feeGrowthInside*LastX128` and both `tokensOwed`.

Any owner action changes at least one of them.

Note that anyone may increase a v3 position. That changes its liquidity, so it can disarm a v3 root at the attacker's own cost. F3 must decide how to treat it.

## Fixtures: testing against the deployed bytecode offline

Uniswap v3 cannot be compiled here (solc 0.7.6), and the vendored v4 copy is newer than the deployed one. So the suites etch the **runtime bytecode deployed on Base (8453)**, read with `eth_getCode` at block 52,058,051. `scripts/v2/position-fixtures.mjs capture` wrote the fixtures from the public Base RPC, read-only. Each fixture's keccak256 equals the code hash in `api-contracts/v2/chains/base-8453.json`.

| Contract | Address | Bytes |
| --- | --- | --- |
| UniswapV3Factory | `0x33128a8f…F6FDfD` | 24,535 |
| NonfungiblePositionManager | `0x03a520b3…Ed34f1` | 24,384 |
| WETH9 | `0x4200…0006` | 2,041 |
| v4 PoolManager | `0x498581fF…652b2b` | 24,009 |
| v4 PositionManager | `0x7C5f5A4b…429bDc` | 23,877 |
| v4 StateView | `0xA3c0c9b6…867A71` | 3,531 |

How the fixtures are built and used:
- **Holders.** `fixtures/UniswapBase8453.sol` has one holder contract per runtime; its constructor returns the deployed code. The tests deploy it from its artifact (`vm.getCode`), so no test embeds 24 KB of code. The fixture is compiled once, and editing a test does not recompile it.
- **Etching.** The tests etch each runtime at its own address, because immutables in the bytecode point at the other contracts (the factory at itself, the position managers at the factory, PoolManager and WETH).
- **Storage.** The tests then write the storage the constructors set (`constructorStorage()`):
  - v3 fee-tier spacings;
  - the position managers' names and their next token id and pool id (1);
  - WETH's metadata.
  `fixtures/base-8453.json` records each slot, located on the live contract (`liveValue`), and what the tests write.
- **Pools.** v3 pools come from the etched factory's `createPool`, that is from its embedded pool creation code. They land at the CREATE2 address of the canonical init code hash `0xe34f…8b54` that the manager computes (`testFixturesAreTheProfileBytecodeAndPoolsLandWhereTheManagerLooks`).
- **Other chains.** Base's and Arbitrum's builds of all four Uniswap contracts were compared byte for byte on 1 Oct. They differ only in immutables: the contracts' own and each other's addresses, WETH, the descriptor, and the PositionManager's cached chain id and domain separator. The Robinhood tunnel was down, so Robinhood relies on the F0 survey, which found the same builds.

`node scripts/v2/position-fixtures.mjs check` runs offline. It re-hashes every embedded runtime against the profile, checks that the Solidity file is exactly what the manifest renders, and checks the vendored math (below).

Each v4 test runs twice:
- `V4PositionsDeployed.t.sol` uses the deployed bytecode;
- `V4PositionsVendored.t.sol` uses the vendored PoolManager, PositionManager and StateView, deployed from their artifacts.

The vendored copy emits `ModifyPosition` and the deployed one does not. Everything else the adapters rely on behaves identically.

## Vendored math

`contracts/src/v2/positions/uniswap/` holds byte-for-byte copies of the reference files in `contracts/test/reference/official-v4`, all MIT:
- from v4-core `59d3ecf`: `TickMath`, `BitMath`, `CustomRevert`, `FullMath`, `SqrtPriceMath`, `SafeCast`, `UnsafeMath`, `FixedPoint96`, `FixedPoint128`;
- from v4-periphery `dce236d`: `LiquidityAmounts`.

Two kinds of edit were made:
- the pragma is pinned to `0.8.26` (the hygiene rule);
- `LiquidityAmounts` imports its three dependencies by relative path, because `export-abi.mjs` compiles `src/v2` without remappings.

`position-fixtures.mjs check` fails on any other difference. This moves the Uniswap math out of the test tree for V2 (#282 D5).

It is the only copy of that math in `src/v2`. Besides the adapters (and F2's zaps through them), these sources import it directly:
- F1a: `AnchorMath` (`TickMath`);
- F1b: `DominoSwapFloor` (`FullMath`), which F3's executor and F4's auto-exit use;
- F3: the vault (`TickMath`, `FullMath`).

F1b's own `mulDiv` copy, `route/DominoFullMath.sol`, was removed when the copies were consolidated (#283, item 5).

## Running the checks

```sh
node scripts/test-contracts.mjs --match-path test/v2/positions/DominoPositionMath.t.sol
node scripts/test-contracts.mjs --match-path test/v2/positions/V3Positions.t.sol
node scripts/test-contracts.mjs --match-path test/v2/positions/V4PositionsDeployed.t.sol
node scripts/test-contracts.mjs --match-path test/v2/positions/V4PositionsVendored.t.sol
node scripts/v2/position-fixtures.mjs check
```

### Mutation check

`contracts/mutations/v2-positions-2026-10-01.json` removes or weakens each guard and decoding step the adapters own. Two edge-branch mutants are expected to survive because they are equivalent, and say why. It uses `scripts/mutate-contracts.mjs`'s own verdict logic.

The v2 suites do not compile the V1 contracts whose sizes `test-contracts.mjs` checks after every run. So the batch must run in a sandbox that also holds `contracts/cache` and `contracts/out`, which a fresh `mutate-contracts.mjs` sandbox lacks: copy them in, then call `runBatch` from that module. In this sandbox every mutant compiles incrementally.

## Open points

- **Hooked pools.** The adapters handle any v4 pool mechanically.
  - Hook deltas on add or remove are settled by their actual amount, and the PositionManager's maxima and minima bound them.
  - Decided (2 and 3 Oct 2026): F2 and F3 refuse positions in hooked pools; a registry list of approved hooks may come later, with new implementations. F0 accepts every pool; #282 says "hook só no trecho de swap".
- **Gas.** On top of the Uniswap calls, the adapters add:
  - v4: up to two extra PositionManager calls, four `exttload` and one position-info read;
  - v3: one `positions` read and four approvals.

  An indicative probe ran each action through the test harness on the Base bytecode, every touched account cooled first. The numbers include the harness's call and, on v4, its unlock round trip:

  | Action | v4 | v3 |
  | --- | ---: | ---: |
  | mint (range already initialized) | 222k | 363k |
  | increase (v4: fees netted in) | 197k | 332k |
  | collect | 170k | 179k |
  | withdraw half | 149k | 205k |
  | withdraw all + burn | 170k | 238k |
  | `collectable` (view) | 48k | — |

  F3's planner should measure its own sequences on Robinhood before setting gas targets.
