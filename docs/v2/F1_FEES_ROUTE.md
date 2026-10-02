# Domino V2 — F1 fees and route

This is the fee module and the swap-leg executor of workstream F1 ("Contratos: fundação", domino-money/domino#283; technical base in #282). The zap (F2), the vault (F3) and the auto-exit module (F4) build on it. It implements the F0 surfaces `IDominoFeeEvents`/`IDominoFeeSettlement` and the swap-leg rules of `IDominoPositionActions`, and adds no frozen surface (see [F0 changes](#f0-changes)).

| Source | What it is | Used by |
| --- | --- | --- |
| `contracts/src/v2/fees/DominoFeeRules.sol` | Library: which token the assisted-swap fee is charged in, on what amount, the intent's fee terms, the automation tariff by mode. Pure rules, no transfers. | F2, F3, F4 |
| `contracts/src/v2/fees/DominoFeeLedger.sol` | Abstract contract: charges a fee to the registry's recipient, keeps what could not be paid as owed, and implements `owedFees`/`flushOwedFees`. | F2, F3, F4 |
| `contracts/src/v2/route/DominoSwapExecutor.sol` | Abstract contract: executes `SwapLeg[]` and accepts each leg by its effect. Holds the v3 swap callback and the v4 unlock callback. | F2, F3 |
| `contracts/src/v2/route/DominoAssistedSwap.sol` | Abstract contract: executor + ledger. The manual action's assisted swap: terms, legs, then the 65 bps fee. | F2, F3 (owner actions) |
| `contracts/src/v2/route/DominoSwapFloor.sol` | Library: the fee-aware swap floor and the pool-fee readers (the #3409682 fix). | F3, F4 |
| `contracts/src/v2/route/DominoActionLock.sol` | The one transient lock every entry point shares. | all hosts |
| `contracts/src/v2/route/DominoTokenOps.sol` | Token calls (native = `address(0)`) that copy at most one word of return data. | all hosts |
| `contracts/src/v2/route/DominoFullMath.sol` | `mulDiv` from Uniswap's FullMath, kept outside the test tree (V1 audit D5). | floor |

## The owner's decisions this implements (1 Oct 2026)

**Tariffs** are the F0 constants in `DominoV2Types`: `FEE_ASSISTED_SWAP_BPS` (65), `FEE_AUTOMATION_SIMPLE_BPS` (200), `FEE_AUTOMATION_DOMINO_BPS` (400), `FEE_AUTO_EXIT_BPS` (20). Fees round down, in the payer's favour.

**Where the assisted-swap fee is charged.** Each chain has ranked charge currencies, read from `IDominoRegistry.chargeCurrencyRank` (Robinhood: USDG 1, then ETH and WETH 2; Base and Arbitrum: USDC 1, then ETH and WETH 2). Every v3/v4 pool is accepted; the rule only selects the token.

`DominoFeeRules.assistedSwapFeeToken` reads the rule as follows:

1. Take every token the plan's legs touch and classify each appearance:
   - **input**: a leg spends it and no earlier leg delivered it;
   - **output**: a leg delivers it and no later leg spends it;
   - **hop**: a leg delivers it and a later leg spends it (a leg boundary).
2. Select the **best-ranked** charge currency among them. On equal ranks (ETH and WETH), the earlier place wins: inputs, then outputs, then hops; then the earlier leg.
3. If no charge currency appears, charge the **first leg's input**.

| Plan (Robinhood ranks) | Fee token | Found as |
| --- | --- | --- |
| USDG → MANY | USDG | input |
| MANY → USDG | USDG | output |
| TSLA → USDG, USDG → MANY (the owner's TSLA/MANY example) | USDG | hop |
| TSLA → MANY | TSLA | fallback |
| WETH → USDG | USDG | output: the better rank wins over the earlier place |
| ETH → MANY | ETH (`address(0)`) | input |
| ETH → WETH | ETH | input: equal ranks, the input wins |
| TSLA → WETH, WETH → MANY, NVDA → ETH | ETH | output beats a hop of equal rank |

Only leg boundaries are hops. A hop inside one Universal Router call or one pool path is invisible to the contract and does not count, so a planner that wants the fee in the hop's currency splits the route into two legs at that token (the TSLA/MANY example is two legs). See [owner decisions](#decisions-for-the-owner) for the one reading that could go the other way.

**On what amount.** `DominoFeeRules.swappedAmount(legs, amountsOut, token)` is the larger of what the legs spent in that token (the signed `amountIn`s) and what they delivered in it (the measured outputs). An input is charged on what entered the swaps, an output on what came out, and a hop on what it carried. The fee is `feeOf(amount, 65)` and comes on top of `amountIn` for an input fee, out of the output for an output fee, and out of the hop's remainder for a hop fee. A hop the plan barely spends (TSLA → 1000 USDG, then 1 USDG → MANY) is still charged on the 1000.

**No swap, no fee.** With no legs, the intent must carry `feeBps = 0` and `feeToken = address(0)`. With legs it must carry `feeBps = 65` and `feeToken` equal to the selection, where `address(0)` means native ETH. `requireAssistedSwapTerms` reverts `FeeMismatch` otherwise, before anything moves.

**Automation** stays proportional in both pool tokens: `automationFeeBps(mode)` gives 200 or 400, applied once to the consumed fees of each token. Automation swaps carry no assisted-swap fee (PRICING_POLICY.md), so the vault runs them through `_executeLegs`, not `_assistedSwap`.

**Recipient that cannot receive (V1 audit A1).** A fee is pushed to `registry.feeRecipient()` in the same transaction. If the recipient cannot receive, the fee is never lost and the action is never blocked: the shortfall is owed, stays in the host, and is never spendable by the owner. Anyone flushes it later to the recipient in force. That recipient is rotated by governance through the registry's timelock.

**Swap floor (#3409682).** V1 required `minAmountOut ≥ quote × (1 − maxSlippageBps)`, so the pool's own fee counted as slippage: in the 2% USDG/MANY pool a 1% owner limit let no swap through (97.8% of spot against a 99% floor). The V2 floor is `quote × (1 − poolFee) × (1 − maxSlippageBps)`, and `DominoSwapFloor.minimumOutput` computes it. `testThe3409682Case` builds a 2% pool on the vendored PoolManager and swaps 25 units into it: V1's floor refuses the swap and the V2 floor accepts it at about 98% of spot.

## Building a host

A host (the zap, a vault implementation) inherits `DominoAssistedSwap`, or `DominoSwapExecutor` and `DominoFeeLedger` separately, and passes its chain's profile:

```solidity
contract DominoZapV4 is DominoAssistedSwap, IDominoPositionActions {
    constructor(RouteConfig memory config) DominoAssistedSwap(config) {}
    // RouteConfig({
    //   registry: IDominoRegistry(<registry>),
    //   permit2: <profile.permit2>,
    //   v3Factory: <profile.uniswap.v3.factory>,            // address(0) disables v3 legs
    //   v3PoolInitCodeHash: <profile.uniswap.v3.poolInitCodeHash>,
    //   v4PoolManager: <profile.uniswap.v4.poolManager>     // address(0) disables v4 legs
    // })
}
```

The constructor requires code at the registry, at Permit2 and at any non-zero factory or PoolManager, and a non-zero init code hash with a v3 factory (`InvalidRouteConfig`, `InvalidFeeConfig`). Every value is an immutable, so a minimal-proxy clone of a vault implementation reads them from the implementation; owed fees live in ERC-7201 storage (`erc7201:domino.v2.fees`), clear of any host layout.

Rules for the host:

- **Lock every external entry point** with `nonReentrant` from `DominoActionLock`. The ledger's `flushOwedFees` uses the same lock, and `_executeLegs` refuses to run outside it. So nothing a router, hook or token calls during an action can flush fees or start another action.
- **Accept native ETH** in `receive()`. It comes from the PoolManager (`take`), admitted routers (unwrap or sweep) and WETH. A host that wants to refuse stray ETH can accept it only while `_swapInProgress()` is true, plus whatever its own flows need.
- **One unlock callback.** The executor implements `unlockCallback` for its own v4 legs. A host that also unlocks the PoolManager overrides it and sends the call to `_v4LegCallback(data)` while `_v4LegPending()` is true, and to its own logic otherwise. `_v4LegPending()` is true only between the executor's `unlock` and its callback.
- **No EIP-1271** on a host. An admitted router could otherwise get a Permit2 signature from it.
- **No standing allowances during legs.** The executor grants and requires exact ERC-20 and Permit2 allowances per leg and refuses a leg that leaves either. A v4 mint paid through Permit2 (F2) sets its own allowances after the legs and clears them.
- **Refunds exclude owed fees.** What the host may hand back is `_unowedBalance(token)`, never the raw balance.

## API

### `_assistedSwap` (DominoAssistedSwap)

```solidity
function _assistedSwap(
    DominoV2Types.SwapLeg[] memory legs,
    address[] memory extraTracked,
    uint16 feeBps,        // intent.feeBps
    address feeToken,     // intent.feeToken
    address payer,        // FeeCharged.payer: the owner
    bytes32 ref           // FeeCharged.ref: the intent hash
) internal returns (uint256[] memory amountsOut, uint256 fee);
```

It checks the intent's fee terms against the legs, executes the legs (below), computes `fee = feeOf(swappedAmount(legs, amountsOut, feeToken), feeBps)` and charges it as `FEE_KIND_ASSISTED_SWAP`. The fee token is always one of the legs' tokens, so it is tracked. The host must hold the fee: an input fee comes on top of the legs' `amountIn`, or `_chargeFee` reverts `FeeNotBacked`. The host binds the legs to the signed intent itself: `intent.routesHash == DominoV2Types.routesHash(plan.legs)`.

### `_executeLegs` (DominoSwapExecutor)

```solidity
function _executeLegs(DominoV2Types.SwapLeg[] memory legs, address[] memory extraTracked)
    internal returns (uint256[] memory amountsOut);
```

It runs the legs in order, at most `MAX_LEGS` (8), and returns what each one delivered, as measured. Every leg's `tokenIn` and `tokenOut` is tracked, plus `extraTracked`: the action's other tokens, such as the pool currencies, the inputs and native ETH. A leg is **accepted only if**:

- exactly `amountIn` of `tokenIn` left this contract;
- at least `minAmountOut` of `tokenOut` arrived. This is measured, so a transfer tax on the output counts against the floor;
- no other tracked balance moved;
- no allowance survived (router legs).

It emits `SwapLegExecuted(kind, tokenIn, tokenOut, venue, amountIn, amountOut)` per leg; `venue` is the router, the first v3 pool or the PoolManager. Every leg needs `tokenIn ≠ tokenOut`, `amountIn > 0` and `minAmountOut > 0` (a zero floor is refused). Pool legs need `router = address(0)`.

| Kind | `data` | How it runs |
| --- | --- | --- |
| `LEG_UNIVERSAL_ROUTER` | Calldata for `router` (e.g. `execute(commands, inputs, deadline)`) | `registry.routerVersion(router) ≠ 0` (Universal Router 2.1.2 on the target chains). For an ERC-20 input, the host approves Permit2 for exactly `amountIn`, then gives the router a Permit2 allowance of exactly `amountIn` that expires in this block. Both must be spent. A native input is sent as call value. A failed call reverts with the router's own reason. |
| `LEG_V3_POOL` | A Uniswap v3 path: `token, fee, token, …`, up to 4 hops | Each hop swaps exact input, with no price limit, on `CREATE2(factory, keccak256(token0, token1, fee), initCodeHash)`, which must have code. The callback pays only that pool, only during that swap, only once, and only the hop's exact input. ERC-20s only (v3 uses WETH). |
| `LEG_V4_POOL` | `abi.encode(PoolRef[])`, up to 4 hops | One `unlock` swaps every hop. Each hop must consume exactly its input, hook deltas included, and deliver a positive output. Then the input is settled (`paid` must equal `amountIn`, so a taxed input fails) and the output is taken. The path must end at `tokenOut`. Native currency is `address(0)`. Hooks are allowed: only the swap touches the hooked pool, and what arrives is judged against `minAmountOut`. |

**For the planner (F6), when building Universal Router calldata:**

- The host pays through Permit2: use `SETTLE_ALL` (v4) or `payerIsUser = true` (v3/v2 commands). Do not use a `PERMIT2_PERMIT` command, since the host cannot sign. The Trading API's unlimited permit is not used.
- Deliver the output to the caller: `TAKE_ALL`, or recipient `MSG_SENDER`.
- Swap exactly `amountIn`. A router that pulls more is refused by Permit2 (`InsufficientAllowance`); one that swaps less leaves an allowance and is refused.
- `testAV4SwapThroughTheDeployedRouter` shows the exact V4_SWAP encoding that 2.1.2 accepts (`ExactInputSingleParams` with `minHopPriceX36`).

**Floors.** In owner actions (F2) the owner signs each leg's `minAmountOut`. In automation (F3) the vault computes it with `DominoSwapFloor.minimumOutput` against the anchor, and refuses a plan whose `minAmountOut` is lower.

### `_v4SwapPath`, `_v4LegPending`, `_v4LegCallback` (DominoSwapExecutor)

```solidity
function _v4SwapPath(address tokenIn, uint256 amountIn, DominoV2Types.PoolRef[] memory pools)
    internal returns (address tokenOut, uint256 amountOut);
```

It swaps exact input along `pools` inside an unlock the host has already opened, and leaves the deltas for the host to settle. This is how a vault nets a swap against a liquidity change (#282 B3) without a separate take and settle. It applies the same per-hop checks as a v4 leg, but there is no balance check around it: the host bounds `amountOut` itself. `AssistedSwapHarness.nettedV4Swap` in the test kit is a worked example.

### Fees (DominoFeeLedger)

```solidity
function _chargeFee(uint8 kind, address token, address payer, uint256 amount, bytes32 ref)
    internal returns (uint256 deferred);
function _unowedBalance(address token) internal view returns (uint256);
function owedFees(address token) public view returns (uint256);
function flushOwedFees(address token) external returns (uint256 amount);   // anyone, nonReentrant
```

`_chargeFee` charges `amount` of `token` that the host holds:

- It requires `balance ≥ owed[token] + amount` (`FeeNotBacked`).
- It emits `FeeCharged(kind, token, payer, amount, ref)`.
- It attempts the transfer to `registry.feeRecipient()` with at most `FEE_TRANSFER_GAS` (100,000) gas and measures this contract's balance:
  - **paid** when exactly `amount` left; a recipient-side transfer tax is the recipient's;
  - **owed** for any shortfall: the recipient reverted, a blacklist, a `false` return, no recipient, a registry that reverts, a recipient equal to the host, or a balance that grew. This emits `FeeDeferred(token, deferred, totalOwed)`;
  - **reverts** `FeeTransferMismatch` when more than `amount` left, since that would spend balances owed to others.
- `amount = 0` does nothing.

`flushOwedFees(token)` pays everything owed in `token` to the current recipient, with all gas. It reverts and leaves the amount owed when there is no recipient (`FeeRecipientUnavailable`), or when the recipient still cannot take exactly that amount (`FeeTransferMismatch`). It returns 0 when nothing is owed, and emits `OwedFeesFlushed(token, recipient, amount)`.

Kinds, per host:

- **Zap:** `FEE_KIND_ASSISTED_SWAP`, through `_assistedSwap`.
- **Vault:** `FEE_KIND_AUTOMATION` on each token's consumed fees, `feeOf(consumed, automationFeeBps(mode))`. Owner-requested swaps through the vault use `_assistedSwap`. The vault counts `owedFees(token)` as backing, never as reserves, and `recoverToken` must exclude it.
- **Auto-exit:** `FEE_KIND_AUTO_EXIT`, `feeOf(amount, FEE_AUTO_EXIT_BPS)` on each token withdrawn, or on the converted output when the owner converts into a charge currency (`chargeCurrencyRank(convertTo) ≠ 0`; F0 `IDominoAutoExit`).

### Rules (DominoFeeRules)

| Function | Returns / reverts |
| --- | --- |
| `assistedSwapFeeToken(registry, legs)` | `(token, source)`; `source` is `FROM_INPUT`, `FROM_OUTPUT`, `FROM_HOP` or `FROM_FALLBACK`. Reverts `InvalidPlan` on no legs. |
| `swappedAmount(legs, amountsOut, token)` | `max(Σ amountIn where tokenIn = token, Σ amountsOut where tokenOut = token)`. Reverts `InvalidPlan` if the lengths differ. |
| `feeOf(amount, bps)` | `amount × bps / 10000`, rounded down. |
| `requireAssistedSwapTerms(registry, legs, feeBps, feeToken)` | Reverts `FeeMismatch` unless the terms are `(0, address(0))` with no legs, or `(65, selection)` with legs. |
| `automationFeeBps(mode)` | 200 for `MODE_SIMPLE`, 400 for `MODE_DOMINO`; reverts `InvalidFeeMode` otherwise. |

### Floor (DominoSwapFloor)

| Function | What |
| --- | --- |
| `quote(amountIn, sqrtPriceX96, zeroForOne)` | `amountIn` at the price, rounded down. Exact `sqrtP²` below 2^128, Q128 above. |
| `minimumOutput(amountIn, sqrtPriceX96, zeroForOne, poolFeePips, maxSlippageBps)` | `quote × (1e6 − poolFeePips) × (1e4 − maxSlippageBps) / 1e10`, with one rounding, down. Reverts `InvalidFloor` on a zero price, a fee of 100% or more, or a slippage of 100% or more. |
| `v4SwapFeePips(protocolFee, lpFee, zeroForOne)` | The direction's protocol fee (low 12 bits for zeroForOne, next 12 for oneForZero) plus the LP fee, as v4-core charges them: `p + lp − p × lp / 1e6`. |
| `v4PoolId(pool)`, `v4Slot0(poolManager, poolId)`, `v4SpotAndFee(poolManager, pool, zeroForOne)` | Slot0 read straight from the PoolManager (`extsload`, StateLibrary layout); the spot and the total fee for the direction. |
| `v3SpotAndFee(pool)` | `slot0().sqrtPriceX96` and `fee()`. On v3 the protocol fee is a share of the LP fee (`feeProtocol` = 1/N), so the swapper pays exactly `fee()`. |

Pass `minimumOutput` the **anchor** the action is bounded by (`IDominoPriceAnchor.anchor`), which has already been checked against the spot. A bare spot can be moved by a sandwich within the band. The floor ignores price impact, which the owner's `maxSlippageBps` must absorb (#282: "o impacto continua limitado à parte").

### Errors

| Error | Raised when |
| --- | --- |
| `IDominoPositionActions.InvalidPlan()` | Any of these: more than 8 legs; a leg with `tokenIn = tokenOut`, `amountIn = 0` or `minAmountOut = 0`; an unknown kind; a router on a pool leg; a router the registry does not admit; a malformed or over-long path (more than 4 hops); a path that does not start at `tokenIn` or end at `tokenOut`; no pool at the v3 CREATE2 address (or no v3 configured); no v4 PoolManager; a hop of the wrong dex or without the current token; a v4 input above int128; an empty route given to the fee rule; amounts per leg that do not match. |
| `IDominoPositionActions.SwapEffectMismatch()` | The leg's effect is wrong: not exactly `amountIn` left, less than `minAmountOut` arrived, another tracked balance moved, an allowance survived, a v3 pool asked for anything but the hop's exact input, a v4 hop did not consume its exact input or delivered nothing, or the PoolManager credited less than `amountIn`. |
| `IDominoPositionActions.Unauthorized()` | The executor ran outside a locked action or inside a running leg; a v3 callback came from anyone but the pool being swapped on; a v4 callback came from anyone but the PoolManager, or for data that is not the pending leg's. |
| `IDominoPositionActions.FeeMismatch()` | The intent's `feeBps`/`feeToken` disagree with the plan. |
| `DominoActionLock.ReentrantCall()` | An entry point was called while another runs. |
| `DominoFeeLedger.FeeNotBacked(token)`, `FeeTransferMismatch(token)`, `FeeRecipientUnavailable()`, `InvalidFeeConfig()` | As above. |
| `DominoTokenOps.TokenCallFailed(token)` | A balance or allowance read failed, or a transfer or approve returned `false`, reverted, or hit an address without code. |
| `DominoSwapFloor.InvalidFloor()`, `DominoFeeRules.InvalidFeeMode()`, `DominoSwapExecutor.InvalidRouteConfig()` | As above. |
| *(the router's own revert data)* | A Universal Router call failed: Permit2's `InsufficientAllowance` for an over-pull, `V4TooLittleReceived`, and so on. |

## Examples

**F2 — create a position from TSLA only** (Robinhood, TSLA/MANY pool). The owner signs `feeBps = 65` and `feeToken = USDG` (a hop), with the legs TSLA → USDG and USDG → MANY:

```solidity
function create(CreatePlan calldata plan) external payable nonReentrant returns (ActionResult memory r) {
    // ... deadline, nonce, signature, routesHash == DominoV2Types.routesHash(plan.legs), pull plan.inputs ...
    address[] memory watched = _actionTokens(plan); // pool currencies, inputs, native
    (uint256[] memory out, uint256 fee) = _assistedSwap(
        plan.legs, watched, plan.intent.feeBps, plan.intent.feeToken, owner, intentHash);
    // ... mint with amount0Max/amount1Max from what is now held ...
    // ... refund _unowedBalance(token) of every action token to intent.recipient ...
    r.feeToken = plan.intent.feeToken;
    r.feeAmount = fee;
}
```

**F3 — balance compounded fees through any route, against the vault's own pool:**

```solidity
(uint160 anchor,) = priceAnchor.anchor(pool, evidence, limits.maxObservationAgeSeconds, limits.maxPriceImpactBps);
(, uint24 poolFee) = DominoSwapFloor.v4SpotAndFee(V4_POOL_MANAGER, pool, zeroForOne);
uint256 floor = DominoSwapFloor.minimumOutput(leg.amountIn, anchor, zeroForOne, poolFee, limits.maxSlippageBps);
if (leg.minAmountOut < floor) revert InvalidPlan();
uint256[] memory out = _executeLegs(legs, watched);   // no assisted-swap fee in automation
_chargeFee(DominoV2Types.FEE_KIND_AUTOMATION, token0, owner, DominoFeeRules.feeOf(consumed0, bps), planHash);
_chargeFee(DominoV2Types.FEE_KIND_AUTOMATION, token1, owner, DominoFeeRules.feeOf(consumed1, bps), planHash);
```

**F4 — auto-exit into USDG:** after the conversion legs, `_chargeFee(FEE_KIND_AUTO_EXIT, USDG, owner, DominoFeeRules.feeOf(convertedOut, FEE_AUTO_EXIT_BPS), mandateHash)`. If the recipient is frozen, the fee is owed and the exit completes.

## Size and gas

- The test host `AssistedSwapHarness` has every piece: the executor, the ledger, the rules, `_v4SwapPath` netting and the callbacks. Its runtime is **11,999 bytes** (Solidity 0.8.26, via-IR, 200 runs). That leaves about 12.5 KB of the 24,576-byte limit for a host's own logic. A fee-only host (the auto-exit shape) is 1,720 bytes.
- `_executeLegs` costs, per leg:
  - one `balanceOf` per tracked token before the first leg, and again after each leg (two extra `staticcall`s per leg for a two-token action);
  - an event;
  - for router legs, two approvals and two allowance reads.
- `assistedSwapFeeToken` makes one registry call per token appearance (two per leg).

## Evidence

Nine suites, 132 tests, run one suite at a time with `node scripts/test-contracts.mjs --match-path …`:

| Suite | Tests | What it pins |
| --- | ---: | --- |
| `test/v2/fees/DominoFeeRules.t.sol` | 16 | The fee-token table: inputs, outputs, hops, fallback, ETH vs WETH ties, leg order, Base's USDC. A 512-run fuzz against a reference model. The fee base, rounding, terms and automation tariff. |
| `test/v2/fees/DominoFeeLedger.t.sol` | 29 | Paying ERC-20s and ETH, no-return tokens and recipient-side taxes. Deferring on a refusing recipient (7702 without receive), a blacklist, a `false` return, no recipient, a broken registry or a self-payment. The gas cap with a gas-burning recipient and a gas-burning token. Backing, over-debit, ERC-7201 slot, accumulation. Flush to a rotated recipient, flush failures, and the lock against reentry. |
| `test/v2/route/DominoSwapExecutorRouter.t.sol` | 27 | Scripted adversarial routers against the deployed Permit2: pull more than `amountIn`, return less than the minimum, move another token, leave an ERC-20 or a Permit2 allowance (isolated with hostile tokens), refund part of the input, reenter (four ways), fail. Also native in/out, admission, malformed legs, limits, and constructor checks, including an executor-only host. |
| `test/v2/route/DominoSwapExecutorUniversalRouter.t.sol` | 7 | The deployed Universal Router 2.1.2, Permit2 and v4 PoolManager runtimes from Robinhood. A V4_SWAP leg (ERC-20 and native both ways) is accepted. Calldata that over-pulls, under-swaps or diverts the output is refused. |
| `test/v2/route/DominoSwapExecutorV3.t.sol` | 10 | The deployed Robinhood WETH/USDG 0.05% pool runtime at its CREATE2 address. Scripted pools for paths and failures. Forged, forwarded and repeated callbacks. Wrong amounts or token. Malformed paths. |
| `test/v2/route/DominoSwapExecutorV4.t.sol` | 16 | The vendored PoolManager: single, multi-hop, native, an exact minimum, a hooked pool that keeps 1% of the output, a partial fill, a taxed input, forged and forwarded callbacks, replay, malformed paths, and the netting entry point. |
| `test/v2/route/DominoSwapFloor.t.sol` | 12 | Quotes on both branches, fuzzed against v4-core's FullMath and ProtocolFeeLibrary. Slot0 read through `extsload`. The protocol fee counting in the floor (A7). The #3409682 case. |
| `test/v2/route/DominoAssistedSwap.t.sol` | 10 | End to end on the vendored PoolManager: the fee in the input, output, hop, fallback and native ETH; terms checked before anything moves; no swap, no fee; a frozen or 7702 recipient never blocks the swap; the fee must be funded. |
| `test/v2/route/DominoTokenOps.t.sol` | 5 | Reads that refuse silent or failing tokens, the transfer and approve return semantics, and the gas cap. |

**Deployed-bytecode fixtures.** `contracts/test/v2/route/fixtures/` holds four Robinhood runtimes read with `eth_getCode` on 1 Oct 2026 through the operator's node: Universal Router 2.1.2, Permit2, the v4 PoolManager, and the v3 WETH/USDG 0.05% pool. The suites check `keccak256(RUNTIME)` against the constant, and `backend/tests/test_v2_route_fixtures.py` checks the constant against `api-contracts/v2/chains/robinhood-4663.json`. The vendored PoolManager is deployed from its compiled artifact (`V2VendoredFixtures`), never `new`ed in a suite, so editing a test does not recompile it through IR.

**Mutation.** `contracts/mutations/v2-fees-route-2026-10-01.json` deletes or weakens every guard of these sources, one at a time, against the suite meant to catch it: **111 of 111 are caught**. Checks that can never be the deciding one were removed rather than kept unpinned: a v3 callback without a swap, a zero factory, and a v4 path without hops are all refused by the check that follows. Running the batch needs a sandbox seeded with an existing Forge cache. A fully cold sandbox sends every source to one solc-js job, which crashes (issue #145).

## F0 changes

None. No frozen type, interface, event or error changed, and the ABI exports (`node scripts/v2/export-abi.mjs --check`) are untouched. The executor reuses `IDominoPositionActions`' errors for leg failures. Its new event (`SwapLegExecuted`) and errors belong to the implementation, not to the frozen surface. `IPermit2AllowanceMinimal` (Permit2's `approve`/`allowance`) is declared next to the executor, not in `src/v2/external`, so the export set is unchanged; the deployed Permit2 fixture exercises both selectors.

## Decisions for the owner

The owner accepted all three on 2 October 2026, as implemented: rank first; one fee token per action; 0.65% on the swapped amount, not V1's inclusive formula. They are recorded in PRICING_POLICY.md, section V2.

1. **Rank first, or place first?** This implementation picks the best-ranked charge currency anywhere in the route: "a primeira moeda da lista que aparecer na operação". The other reading takes the input whenever it is any charge currency, then the output, then a hop. The two differ only when a rank-2 token (ETH/WETH) and the rank-1 stable both appear. For example, ETH → USDG charges USDG here and ETH under the other reading. Changing it is one comparison in `assistedSwapFeeToken`, plus the table above.
2. **Fallback with several non-charge inputs.** With TSLA → MANY and NVDA → MANY in one plan, only the TSLA legs pay: the fee has one token, the first leg's input. Domino's planner can route through a charge currency to charge everything. A third-party plan cannot avoid more than it could by swapping elsewhere first.
3. **The fee is 0.65% of the swapped amount, on top.** V1 charged 0.65% of a gross budget that included the fee, so 0.6542% of what was swapped. PRICING_POLICY.md still describes the V1 formula and changes with the V2 policies (#283).
