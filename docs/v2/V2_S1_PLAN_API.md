# Domino V2 — S1 plan API (position-plan-v1)

S1 of domino-money/domino#283 is manual management through the zap (F2): create with a swap, increase with a swap, change range and exit converted, on Uniswap v3 and v4, on Robinhood (4663), Base (8453) and Arbitrum One (42161). It is milestone M1. The owner decided on 2 October that **the server builds the plan and the app checks it** (F7 §2.4, §9 point 1). This document is that server: item 3c of #283.

Status: **candidate, disabled by default**, contract `1.0.0-rc.2`. Nothing is deployed. The listener plans only when started with `--enable` and a deployment manifest per chain (#301), and the app reaches it only through a Worker route; none of these exists yet (contract manifest status `candidate_disabled_pending_deployment_and_worker`).

rc.2 (owner, 2 Oct) changes two things from rc.1: every minimum is taken at the worst price within ±s ([Minimums](#minimums-at-the-worst-price-within-s-rc2)), and the answer carries the transaction's L1 data fee apart from its L2 gas ([L1 data fee](#l1-data-fee)).

## What this change adds

| Part | Where |
| --- | --- |
| The planner | `backend/v2_position_plan.py`: one plan, read at one pinned block |
| On-chain quoting and routes, reusable by other V2 planners | `backend/v2_quotes.py` (documented API at the top of the file) |
| Exact Uniswap math: liquidity, prices, a local exact-input swap with tick crossings | `backend/v2_liquidity.py` |
| F1b's fee rule, ported exactly | `backend/v2_fee_rule.py` |
| Encoding: structs, `routesHash`, intent hash, Permit2 and relayed typed data, zap call data | `backend/v2_plan_codec.py` |
| Router legs from the Uniswap Trading API | `backend/v2_uniswap_api.py` |
| The closed contract, its rules (the minimums' one definition, `plan_minimums`, included), the service and the listener | `backend/v2_position_plan_models.py`, `_rules.py`, `_service.py`, `_api.py` |
| The L1 data fee per stack: OP Stack's GasPriceOracle, Nitro's NodeInterface | `backend/v2_l1_fee.py` |
| Configuration and secrets; manifests through main's one loader, `backend/v2_manifest.py` (#306) | `backend/v2_position_plan_config.py` |
| The app's contract package: schemas, TypeScript types, fixtures, a runtime that rechecks a plan | `api-contracts/position-plan-v1/` |
| Events and errors of every deployable V2 contract, for receipts and reverts (F7 D7) | `api-contracts/v2/implementations/`, from `scripts/v2/export-abi.mjs` |

No V1 module, route, contract or manifest changes. `backend/v2_uniswap.py` (F6) gains two optional fields on `PositionState` (a v4 position's fee growth inside and its checkpoint); nothing else in it changes. Deployment manifests are read only through `backend/v2_manifest.py`, the loader #306 put on main; this change has none of its own.

## Owner decisions this applies

| Decision | Date | How |
| --- | --- | --- |
| Fee: 0.65% of the swapped amount, charged on it, in the best-ranked charge currency anywhere in the route (registry ranks; tie: input, output, hop), else the first leg's input; one fee token per action; no swap, no fee | 1–2 Oct | `v2_fee_rule.py` is F1b's `DominoFeeRules`, line for line. The planner reads the ranks from the deployed registry at the plan's block (`chargeCurrencyRank`). |
| Hooked v4 pools are refused for positions | 1–2 Oct | `position_plan_hooked_pool` for a create target or an existing position. Swap legs may still cross hooked pools only through the router, as F1b allows. |
| Deadlines: intent and Permit2, 5 minutes; quote, 3 minutes | 2 Oct | `deadline = requestedAt + 300`; `expiresAt = requestedAt + 180`. See [Deadlines and nonces](#deadlines-and-nonces-f7-9-point-3). |
| Slippage: default 0.5%, accepted 0.1%–5% | 2 Oct | `slippageBps` 10–500, default 50; anything else is `invalid_request`. |
| Every minimum at the worst price within ±s, as the Uniswap SDK's mintAmountsWithSlippage and burnAmountsWithSlippage; each leg's minAmountOut stays the quote less s | 2 Oct | Contract `1.0.0-rc.2`. See [Minimums](#minimums-at-the-worst-price-within-s-rc2). |
| The plan's cost includes the L1 data fee, apart from the L2 gas, at most one more billed call | 2 Oct | Base: GasPriceOracle inside a read the plan already makes (0 calls). Robinhood and Arbitrum: NodeInterface, one eth_call. See [L1 data fee](#l1-data-fee). |
| No Domino relayer at launch | 2 Oct | M1 uses `direct` and `permit2`. `relayed` plans are built (typed data, nonce, digest) but nothing sends them. |
| Pool creation is in M1 | 2 Oct | `initialPrice` (human price, base token, decimals) → exact `initSqrtPriceX96` and tick, both orientations returned. See [New pools](#new-pools). |
| EIP-7702 delegated accounts get the direct path only, until a verified EIP-1271 delegate list exists | 2 Oct | The planner reads `eth_getCode(owner)` on the action's chain. Any account with code gets `direct` only (`position_plan_consent_unsupported` otherwise). |
| Robinhood reads via the own node; Base and Arbitrum via hosted RPC, billed per call | 1–2 Oct | F6's endpoints. Reads are batched (Multicall3) and counted: 9–16 billed calls per plan on Base, one more on Nitro. See [Calls and cost](#calls-and-cost). |
| Keys server-side only, from systemd credentials or the environment | 1 Oct | `uniswap-api-key` credential or `DOMINO_UNISWAP_API_KEY`, as `crosschain_config.py` does. Never in a response, log line or error. |

## The endpoint (F7 §9, point 1)

`POST /api/position-plan/v1/plan` through the authenticated Worker route (not part of this change). The Worker forwards to the private listener at `http://127.0.0.1:8911/internal/position-plan/v1/plan`.

The boundary is the onboarding and cross-chain listeners' own (`backend/authenticated_api.py`):
- loopback only, `POST`, JSON;
- the Cloudflare Access assertion of the Worker's service identity;
- a SIWE session and its CSRF token;
- the header `X-Domino-Position-Plan-Contract: 1.0.0-rc.2`.

Limits: request body 8 KiB, response 384 KiB, 20 s per request, 8 plans at a time (`position_plan_capacity_busy` beyond them), 16 connections, one worker process.

**The owner is the session's wallet.** It receives the NFT and every refund. No request names an owner or a recipient, so F7 §2.5.4's "one account pays for another's position" is not offered.

### Request

| Field | Actions | Rule |
| --- | --- | --- |
| `chainId` | all | `4663`, `8453` or `42161` |
| `action` | all | `create`, `increase`, `changeRange`, `exit` |
| `consent` | all | `direct` (all); `permit2` (create, increase; ERC-20 inputs only); `relayed` (changeRange, exit; unused at launch) |
| `pool` | create | `PoolRef` (`dex`, `currency0` < `currency1`, `fee`, `tickSpacing`, `hooks` zero) |
| `position` | increase, changeRange, exit | `{dex, tokenId}`; the session's wallet must own it |
| `tickLower`, `tickUpper` | create, changeRange | multiples of the pool's spacing, lower < upper, inside TickMath's bounds |
| `inputs` | create, increase | 1–2 `{token, amountRaw}`: the pool's tokens, or exactly one other token. Native ETH pays a v3 WETH pool's WETH side (never together with WETH); what is left returns as WETH (F2, F7 §2.7) |
| `liquidityToRemove` | changeRange, exit | `"all"` or raw liquidity; `"0"` on exit collects fees only |
| `burn` | changeRange, exit | burn the NFT; needs all of its liquidity |
| `receive` | exit | `{"mode": "both"}` or `{"mode": "converted", "token": …}` |
| `initialPrice` | create on a pool with no price | `{price, baseToken, decimals0, decimals1}`: one whole `baseToken` is worth `price` whole tokens of the other currency |
| `slippageBps` | all | 10–500, default 50 |

A field outside its action, an unknown field, or a malformed value is `invalid_request` (400).

### Response

`{contractVersion: "1.0.0-rc.2", plan: {…}}`. The plan's fields:

| Field | What it is |
| --- | --- |
| `chainId`, `action`, `consent`, `owner`, `request`, `requestFingerprint` | The request as served (with the default slippage filled in) and the SHA-256 of its canonical JSON |
| `zap` | The zap the plan is for (`zap.v3` or `zap.v4` by `pool.dex`), from the server's manifest |
| `block` | Number, hash and timestamp of the block every read used |
| `requestedAt`, `retrievedAt`, `expiresAt`, `deadline` | Unix seconds. Sign before `expiresAt`; `deadline` is the intent's and the permit's |
| `pool` | The pool as read: id (v3 address or v4 pool id), price, tick, active liquidity, swap fee per direction (protocol fee included), or `initialized: false` |
| `initialPrice` | For a new pool: `sqrtPriceX96`, `tick`, `price0In1`, `price1In0` (from the integer, round trip), the decimals and whether the tokens' `decimals()` confirmed them |
| `position` | For increase, changeRange, exit: its range, liquidity, the liquidity to remove, uncollected fees, in range or not, its approval and its v4 subscriber |
| `zapPlan` | The exact `IDominoPositionActions` struct of the action (`CreatePlan`, `IncreasePlan`, `ChangeRangePlan`, `ExitPlan`), field for field, as decimal strings |
| `routesHash`, `intentHash` | As the zap computes them |
| `call` | The zap function and selector; for `direct`, the complete call data and `valueRaw` |
| `signature` | For `permit2` and `relayed`: the `eth_signTypedData_v4` JSON, its digest and, for Permit2, the `permit` to send with the signature |
| `legs` | Each swap leg: kind, tokens, `amountInRaw`, `expectedOutRaw`, `minAmountOutRaw`, the pools it crosses, and the quote's source (`local_simulation`, `quoter_v2`, `v4_quoter` or `uniswap_trading_api`) |
| `fee` | `bps` (65 or 0), `token`, `place` (`input`, `output`, `hop`, `fallback`, `none`), the expected basis and amount, and the ranks it used (`ranks`, every token the legs touch) |
| `expected` | The liquidity, the amounts that go into the position, the pool price after the legs, the withdrawal (principal and fees) for changeRange and exit, and what returns to the wallet (`returned`) |
| `minimums` | `liquidity` (= `intent.minLiquidity`), the slippage, the removal minima, and the bands they hold over: `mintBand` around the price the mint meets, `removalBand` around the pool's price (each the sqrt prices at −s and +s) |
| `routing` | Whether a router leg was asked for and what happened: `not_needed`, `not_configured`, `unavailable`, `refused`, `not_better`, `chosen`, with a reason code |
| `readiness` | The account (`eoa`, `eip7702` with its delegate, `contract`) and the consents it may use; balances and allowances against what the plan needs; the NFT's approval; the nonce; and the wallet's steps in order |
| `simulation` | The direct zap call from the owner at `block`: `ok` with the gas and the decoded `ActionResult`, `reverted` with the error's selector and name, or `not_run` with the reason |
| `l1DataFee` | The transaction's L1 data fee at `block`, apart from the simulation's L2 gas: `status`, `source` (`op_gas_price_oracle` or `nitro_node_interface`), `weiRaw`, and per source the bound and size (`upperBoundWeiRaw`, `transactionBytes`) or the L1 gas and its L2 price (`l1GasUnits`, `l2BaseFeeWei`); `unavailable` when the chain did not answer |
| `warnings` | `simulation_reverted`, `simulated_liquidity_below_minimum` |

`expected` is exact at `block`: on the test chains every swap delivered exactly `expectedOutRaw`, every fee was exactly `fee.amountRaw`, the liquidity exactly `expected.liquidity`, and the zap's refunds exactly `expected.returned` (see [Evidence](#evidence)).

### What the app checks

`api-contracts/position-plan-v1/runtime.mjs` exports `validateResponse` (the closed schema plus `checkPlan`) and the primitives it uses. `checkPlan` recomputes everything that follows from the plan's own fields:
- the fee terms from `fee.ranks`, with a JavaScript port of the same rule;
- `routesHash`, the intent hash, the Permit2 and relayed digests and typed data;
- the direct call data and value;
- the minimums and their bands, with an exact port of the zap's liquidity math (`planMinimums`);
- the L1 data fee's block and source for the chain;
- the deadlines;
- the request ↔ plan correspondence (action, ticks, inputs, burn, liquidity to remove).

Three things it cannot know, and the app must check (F7 §2.4, §7.3):
1. **Every Domino address** in the answer (`zap`, `call.to`, the typed data's `spender` and `verifyingContract`, the approval spenders) equals the app's pinned manifest for the chain. The manifest is the only source of addresses; the response is checked against it, never used as one.
2. **`fee.ranks`** equal the registry's `chargeCurrencyRank` (the profile's ranks while nothing is deployed; F7 §2.4, check 4).
3. **A new pool's `initSqrtPriceX96`** equals what the app computed from the price the user typed (F7 §2.6.5, check 13).

The app then simulates the call itself before asking for consent, as F7 §2.4 (check 11) says.

## How a plan is built

1. **One block.** The chain's shared head (F6's `HeadFollower`) gives the block; every read pins it. The zap's and the registry's runtime code are proven against the manifest's hashes once per process.
2. **The target.** The pool (or the new pool and its initial price) or the position: owner, range, liquidity, uncollected fees, approval. A position held by someone else is `position_plan_not_owner`: vault successors and other custody (F7 §2.13) are not planned here.
3. **The registry's ranks** of every token the plan may touch, whether the registry admits the profile's Universal Router (`routerVersion ≥ 212`), the free nonce of the consent path, and the account's code.
4. **The legs.** Each conversion is quoted at the block, several ways:
   - **the position's own pool, exactly**, in Python: the same swap steps as Pool.swap, with its initialized ticks read on demand (v4 through `PoolManager.extsload`, v3 through `tickBitmap`/`ticks`). For a change of range or an exit it swaps the pool as it will be after the withdrawal. The price after this leg is the price the mint meets.
   - **every other direct pool** of the pair: the profile's v3 fee tiers and v4's four standard hookless keys, through QuoterV2 and V4Quoter, all in one Multicall3 `aggregate3` call; a two-hop path through a charge currency when no direct pool answers;
   - **a Universal Router 2.1.2 leg** from the Uniswap Trading API, when a key is configured and the registry admits the router. It is chosen only if it delivers more than 10 bps (`ROUTER_ADVANTAGE_BPS`) beyond the best pool route, and refused if its route crosses the position's own pool (that pool's price must stay exact). It is re-quoted at the final amount; if the API no longer offers it, the best pool route takes its place.
5. **Sizing.** Every candidate route is sized so that the mint uses what the zap holds: the side being sold stops binding (a binary search on the two sides' liquidity, the fee included). Inputs outside the pool are split into one leg per pool token. An exit converts the guaranteed withdrawal (minimum principal plus fees) and leaves the rest of that token as it is (F2: legs spend exactly their `amountIn`).
6. **The fee** by F1b's rule over the legs as planned; with an input fee the swapped amount is capped so that amount plus fee fits what the zap holds.
7. **The minimums** with the owner's slippage `s`: each leg's `minAmountOut = floor(expectedOut × (1 − s))`; `minLiquidity` and the removal minima at the worst price within ±s ([Minimums](#minimums-at-the-worst-price-within-s-rc2)). An exit's `minLiquidity` is the liquidity it removes.
8. **The plan struct, the consent artifacts, the readiness, the L1 data fee and the simulation.** `amount0Max` and `amount1Max` are `2^128 − 1` (the zap adds what it holds; F2).

## Minimums at the worst price within ±s (rc.2)

rc.1 took every minimum as the expected amount less `s`. For a concentrated range that is far stricter than the price move `s` stands for: the liquidity a fixed set of tokens buys, and each token a withdrawal pays, move many times faster than the price. At the default 0.5%, a ±1% range reverted on a 0.005% move. The owner decided on 2 Oct to take each minimum at the worst price within ±s instead, as the Uniswap SDK's `mintAmountsWithSlippage` and `burnAmountsWithSlippage` do. `plan_minimums` in `backend/v2_position_plan_rules.py` is the one definition. The planner sets the minimums with it, the answer's checks recompute them with it, and `runtime.mjs` (`planMinimums`) ports it.

**The band.** Around a sqrt price `√p`, the point at `step` is `isqrt(√p² × (20000 + step × s) / 20000)` for `step` in −2…2: the edges are exactly the SDK's `ratiosAfterSlippage` (`encodeSqrtRatioX96(price × (1 ± s))`), clamped inside TickMath's bounds as the SDK clamps them.

**Withdrawals (changeRange, exit).** Removing `L` pays at least `amount0MinRemoved` = its currency0 at the band's upper edge around the pool's price, and at least `amount1MinRemoved` = its currency1 at the lower edge. currency0 falls as the price rises and currency1 rises, so anywhere inside the band each token pays at least its minimum: the exit executes. One step past either edge, v4's position manager reverts with `MinimumAmountInsufficient(uint128,uint128)`.

**Mints (create, increase, changeRange).** `minLiquidity` is the least the zap mints at the five points of the band around the price the mint meets (`expected.sqrtPriceX96After`), from the holdings it is sure of:
- the inputs;
- every leg at its `minAmountOut`, less the fee those outputs owe;
- for a change of range, the withdrawal at the same shift of the pool's price, plus the fees owed;
- native ETH that a v3 WETH pool takes counts as WETH.

The zap mints `LiquidityAmounts.getLiquidityForAmounts` of what it holds, so the mint executes anywhere in the band. On the worse side it reverts just past the edge (`InsufficientLiquidity(uint128,uint128)`). On the better side the liquidity falls more slowly, so the revert comes somewhat past that edge: a single liquidity bound cannot hold both sides exactly.

The tests execute plans at every point of the band, on the real zap:
- the minted liquidity equals the formula's to the wei;
- at the worse edge it equals `minLiquidity`;
- past it, the action reverts.

A change of range to the same range keeps its bound within a millionth of the liquidity it removes, because the withdrawal shifts with the price.

**What a move inside the band costs the owner.** A sandwich can push the price to the band's edge before the mint and back after it. The owner then holds a smaller position, the rest of the deposit refunded, and loses the position's impermanent loss over the round trip. The model below ignores the swap fees the attacker pays into the owner's new position, so it overstates the loss:

| Range around the price | s | Liquidity at the worse edge | Owner's loss, pushed to the edge and back |
| --- | ---: | ---: | ---: |
| ±1% | 0.5% | 66% of planned | 0.042% of the deposit |
| ±1% | 1% | 50% of planned | 0.13% of the deposit |
| ±2% | 0.5% | 80% of planned | 0.025% of the deposit |
| ±10% | 0.5% | 95% of planned | 0.006% of the deposit |
| ±10% | 5% | 64% of planned | 0.43% of the deposit |
| ±50% | 0.5% | 99% of planned | 0.001% of the deposit |

The cost of a move inside the band is small in value. A narrow position can come out much smaller than planned, with the excess returned. The review should show the minimum liquidity, which the bands make possible.

**Converted exits convert what the band guarantees.** A conversion leg spends exactly its `amountIn` (F2), so the planner sets it to the least the withdrawal pays of that token within the band, plus the fees owed. The rest of the token returns as is. For a narrow range most of it can come back unconverted. Share of currency0 converted at the planning price, for a position centred on it:

| Range | s = 0.1% | s = 0.5% | s = 1% |
| --- | ---: | ---: | ---: |
| ±1% | 90% | 50% | 0% |
| ±2% | 95% | 75% | 50% |
| ±10% | 99% | 95% | 89% |

For narrow positions the app should offer a lower `s` for converted exits, or an exit to both tokens. A change of range's rebalancing swap is bounded the same way.

## Consent paths

| Action | `direct` | `permit2` | `relayed` (unused at launch) |
| --- | --- | --- | --- |
| create | `create(plan)`, payable | `createWithPermit(plan, permit, signature)` | — |
| increase | `increase(plan)`, payable | `increaseWithPermit(plan, permit, signature)` | — |
| changeRange | `changeRange(plan)` | — | `changeRangeWithSignature(plan, signature)` |
| exit | `exit(plan)` | — | `exitWithSignature(plan, signature)` (signs `amount0Max = amount1Max = 0`) |

`readiness.steps` lists what the wallet does, in order:
- `approve_token`: an exact `approve` of each ERC-20 input with too little allowance, to the zap (`direct`) or to Permit2 (`permit2`). The call data is in the step. Tokens that need a zero allowance first are the app's to handle, as Setup V1 does (F7 §2.5.1).
- `approve_position`: `approve(zap, tokenId)` on the position manager, when the NFT is not approved to the zap (increase on v4; changeRange and exit on both).
- `sign_permit2` or `sign_relayed`: the typed data in `signature`.
- `send_action`: the zap call. For `direct` it is `call.data`. For the signed paths the app encodes the call with the signature (`runtime.mjs` `callData`).

`readiness.account.consents` is `["direct"]` for any account with code (an EIP-7702 delegation or a contract) and for native ETH inputs; otherwise `["direct", "permit2"]` (create, increase) or `["direct", "relayed"]` (changeRange, exit).

## Deadlines and nonces (F7 §9, point 3)

**Times.** `requestedAt` is the server's clock, in whole seconds, when the request arrives.
- `expiresAt = requestedAt + 180`. A plan that took longer to build is not sent (`preview_expired`); the app asks for consent only before `expiresAt`, and plans again after it.
- `deadline = intent.deadline = permit.deadline = requestedAt + 300` (the zap's `PlanExpired`, Permit2's `SignatureExpired`).
- A router leg's own calldata deadline must lie between `intent.deadline` and one hour from now; a router answer outside that is refused (`uniswap_api_deadline_unsuitable`), so a router leg never expires before the intent. The Trading API is not sent a deadline; the check is on what it returns.
- The simulation runs at `block.timestamp + 1`.

**Nonces.**
- `direct`: `intent.nonce = 0`. The zap does not read it; it is still part of the intent hash.
- `permit2`: a fresh random word `w` in `[2^240, 2^241)` per plan, and the lowest free bit `b` of `Permit2.nonceBitmap(owner, w)` at the block: `nonce = w × 256 + b`, and `permit.nonce = intent.nonce`. Permit2's bitmap is shared with every app that uses SignatureTransfer for the wallet, and sequential nonces live in the low words; a random high word keeps clear of them. `readiness.nonce` carries `word`, `bit` and `nonce`.
- `relayed`: the same scheme on the zap's own `nonceBitmap(owner, word)`.
- A signed plan that is not sent stays valid until `deadline`. The app keeps its nonce in its journal and, to cancel it, calls `Permit2.invalidateUnorderedNonces(word, 1 << bit)` or `zap.invalidateNonces(word, 1 << bit)` (F7 §2.10). A new plan never reuses a nonce: each takes a new random word.

## New pools

Only when the pool has no price: `pool.initialized` is false and the request carries `initialPrice`. `initialPrice` on a pool that has a price is `position_plan_pool_initialized` (409); a pool without a price and without `initialPrice` is `position_plan_pool_not_initialized` (409).

- **The price.** `initSqrtPriceX96 = floor(sqrt(P × 10^(d1 − d0)) × 2^96)` with exact integer arithmetic, where `P` is currency1 per currency0 (the request's price, inverted when `baseToken` is currency1); the tick is TickMath's `getTickAtSqrtPrice`. F7 §2.6.5's example is pinned by a test: 2,500 USDG per ETH (18 and 6 decimals), stated either way, is `3961408125713216879677197` at tick `-198080`. Values outside TickMath's bounds are `position_plan_price_invalid`.
- **Decimals.** The request's `decimals0` and `decimals1` are compared with each token's `decimals()` at the block; a difference is `position_plan_price_decimals_mismatch`. A token without `decimals()` is accepted with `decimalsVerified: false`.
- **Fee tier and spacing.** v3: `factory.feeAmountTickSpacing(fee)` must be non-zero and equal `tickSpacing` (`position_plan_pool_invalid`). v4: a static fee up to 1,000,000 pips and a spacing of 1–32,767, hookless.
- **Legs** never cross the new pool (it has no liquidity yet); the fee rule applies to the legs through other pools. A new v3 pool cannot be paid in native ETH (`position_plan_inputs_unsupported`).
- **`minLiquidity`** is taken over the band of ±s around the initial price (rc.2).
- **The simulation covers the initialization:** v4 through the zap's create (`PoolManager.initialize`), v3 through the position manager's `createAndInitializePoolIfNecessary`, both inside the zap call.
- **The race.** If someone initializes the pool first at another price, the zap does not re-initialize; it mints at that price. Within ±s of the owner's price the mint goes through, as a create on an existing pool would; further away the liquidity falls below `minLiquidity` and the transaction reverts with `InsufficientLiquidity(uint128,uint128)` (`0xe49b763d`). A plan requested after that point is refused with `position_plan_pool_initialized`. In both cases the app re-reads the pool and offers the ordinary create on the pool that now exists (F7 §2.6.5: "The pool was created by someone else at a different price. Review and try again.").

## Simulation and gas

- The direct zap call from the owner at `block`, with 30 M gas. With `eth_simulateV1` the missing approvals run first in the same simulated block (each ERC-20 input approved to the zap, the NFT approved when it is not), as the direct path's own steps would. The Permit2 and relayed paths move the same tokens through the same steps, so the direct call stands for them.
- `eth_simulateV1` runs on a client of its own: a provider without it answers with an error, which fails over only that client. The plan then falls back to `eth_call`, which runs only when nothing is missing (`not_run` / `approvals_missing` otherwise).
- `simulation.gasUnits` is the gas the simulated call used, L2 execution only, and `null` after the `eth_call` fallback (the app estimates gas itself before sending, F7 §2.4 check 11). The L1 data fee is reported apart, in `l1DataFee`.
- A revert is decoded against 45 known errors: the zap's, its libraries', Permit2's, the position managers', the Universal Router's, `Error(string)` and `Panic(uint256)`. They are the 45 selectors of F7 §2.12's table, cross-checked one by one.

## L1 data fee

Every plan prices its transaction's L1 data fee at `block`, apart from the L2 execution gas (`backend/v2_l1_fee.py`):

| Chain | Source | What is reported | Billed calls |
| --- | --- | --- | --- |
| Base (OP Stack) | `GasPriceOracle` predeploy (`0x4200…000F`): `getL1Fee(bytes)` of the unsigned transaction, FastLZ-compressed as the sequencer prices it; `getL1FeeUpperBound(uint256)` of its size | `weiRaw` (the estimate), `upperBoundWeiRaw`, `transactionBytes` | 0: both are views of an ordinary contract, inside the readiness Multicall3 read the plan already makes |
| Robinhood, Arbitrum One (Nitro) | `NodeInterface.gasEstimateL1Component(zap, false, data)` (`0x…00C8`), answered by the node, with Nitro's padding on the L1 price | `l1GasUnits` (the L1 component in L2 gas) × `l2BaseFeeWei` = `weiRaw` | 1 eth_call on a client of its own (a Multicall cannot reach NodeInterface); Robinhood's goes only to the own node |

- **The transaction priced** is the unsigned EIP-1559 envelope the wallet sends: the chain id, the zap, the value and the call data. A Permit2 or relayed call carries a placeholder signature of the real length. The fields only the wallet fixes (nonce, fees, gas limit) are placeholders at realistic sizes; they move the compressed size by a few bytes.
- On Nitro the L1 gas is charged as gas, on top of the simulation's execution gas. A simulation at a zero base fee leaves it out, so it is reported here.
- A zero answer is a fee of 0, reported with its source and block: Robinhood prices no L1 data today. `status: unavailable` (every amount `null`) only when the oracle or NodeInterface does not answer; the plan stands without it.
- Not included: an OP Stack operator fee (Isthmus), and the price of gas in ETH or USD.

The fixtures price real data:
- **Base:** they run Base's own GasPriceOracle and L1Block: proxies, implementations and the state they read, captured read-only from Base at a finalized block (`backend/tests/fixtures/v2-base-l1-fee.json`). On them the oracle reproduces Base's own answers for a sample transaction.
- **Robinhood:** the recorded plan carries the own node's NodeInterface answer for the plan's own call, read through the loopback tunnel at block 78,434,604: 0 L1 gas at a 0.032014 gwei base fee, a fee of 0. Robinhood is never read through the public RPC; the recorder refuses a non-loopback Robinhood URL.
- **Arbitrum One:** the same call, priced at block 511,063,234: 2,751 L1 gas at 0.020012 gwei = 55,053,012,000 wei (`backend/tests/fixtures/position-plan/nitro-l1-answers.json`). This exercises the non-zero path on real data.

The EVM tests on the local Robinhood chain answer from a stand-in at 0xc8 (16 L2 gas per byte at 0.01 gwei): a local chain has no NodeInterface.

## Errors

HTTP errors carry `{"error": "<code>"}` and nothing else.

| Code | HTTP | When |
| --- | ---: | --- |
| `invalid_request` | 400 | Shape, a field outside its action, slippage outside 10–500, `currency0 ≥ currency1`, duplicate inputs, ticks out of order |
| `session_required`, `csrf_invalid`, `origin_not_allowed`, `account_unsupported`, `session_rate_limited`, … | 401–429 | The shared session boundary (`onboarding_models.ERROR_STATUS_BY_CODE`) |
| `position_plan_capacity_busy` | 429 | More than 8 plans at once |
| `position_plan_not_owner` | 403 | The session's wallet does not own the position |
| `position_plan_position_not_found` | 404 | No such position on that manager (burned or never minted) |
| `position_plan_pool_not_initialized` | 409 | A pool without a price and no `initialPrice` |
| `position_plan_pool_initialized` | 409 | `initialPrice` for a pool that has a price (also the pool-creation race) |
| `preview_expired` | 409 | Building the plan passed `expiresAt` |
| `position_plan_pool_invalid` | 422 | Not a valid pool for the DEX and chain: v3 fee tier or spacing, v4 key bounds |
| `position_plan_hooked_pool` | 422 | A v4 pool with hooks |
| `position_plan_price_invalid` | 422 | The initial price is zero, out of TickMath's bounds, or its base token is not in the pool |
| `position_plan_price_decimals_mismatch` | 422 | The declared decimals differ from the tokens' |
| `position_plan_range_invalid` | 422 | Ticks not on the pool's spacing; a change of range to the same range |
| `position_plan_liquidity_invalid` | 422 | More liquidity than the position has; zero on a change of range |
| `position_plan_burn_needs_all` | 422 | `burn` without removing all the liquidity |
| `position_plan_inputs_unsupported` | 422 | More than one token outside the pool, or one outside plus another; native ETH with WETH; native ETH for a new v3 pool |
| `position_plan_consent_unsupported` | 422 | `permit2`/`relayed` for an account with code, or `permit2` with native ETH |
| `position_plan_no_route` | 422 | No pool or router route converts what the plan needs |
| `position_plan_amount_too_small` | 422 | The amounts buy zero liquidity, or the fee leaves nothing to swap |
| `position_plan_nothing_to_convert` | 422 | An exit converted to a token it already pays in, with nothing else to convert |
| `position_plan_fee_not_backed` | 502 | The planned fee would not be held (a planner fault, never expected) |
| `upstream_invalid_response`, `upstream_contract_mismatch` | 502 | A chain answer the planner cannot use; an answer that fails the closed contract |
| `position_plan_chain_unavailable` | 503 | The chain is not enabled on this listener |
| `position_plan_unavailable`, `upstream_unavailable` | 503 | The deployed code differs from the manifest, the registry cannot be read, the RPC is down or out of budget |
| `request_timeout` | 504 | Past the 20 s budget |

Router failures are not errors: the plan uses pool routes, and `routing.router` says why (`uniswap_api_rate_limited`, `uniswap_api_credentials_rejected`, `uniswap_api_route_unsupported`, `uniswap_api_command_unsupported`, `router_not_admitted`, `router_route_uses_position_pool`, …). The router's answer must be the request: the zap as swapper and recipient, no integrator fee or portion, only v3 and v4 pools, connected hops, the profile's router 2.1.2, `execute(commands, inputs, deadline)` with only commands 0x00, 0x04, 0x0b, 0x0c, 0x0e and 0x10, and no recipient other than the router's `MSG_SENDER`.

## Configuration and credentials

Read by `backend/v2_position_plan_config.py` and `backend/v2_position_plan_api.py`. Secrets come from the unit's systemd credentials (`LoadCredentialEncrypted=`, under `$CREDENTIALS_DIRECTORY`) when present, otherwise from the environment. A bad setting stops the listener with the setting's name, never its value.

| What | Environment | Credential | Needed |
| --- | --- | --- | --- |
| Enabled chains (profile names, comma separated) | `DOMINO_POSITION_PLAN_CHAINS`, e.g. `robinhood-4663,base-8453,arbitrum-42161` | – | yes |
| Deployment manifest per chain, absolute path | `DOMINO_POSITION_PLAN_MANIFEST_ROBINHOOD_4663`, `_BASE_8453`, `_ARBITRUM_42161` | – | per enabled chain |
| Uniswap Trading API key | `DOMINO_UNISWAP_API_KEY` | `uniswap-api-key` | no: without it, pool routes only |
| V2 chain RPC file (Base, Arbitrum; F6) | `DOMINO_V2_CHAIN_RPC_FILE`, URLs as `DOMINO_V2_RPC_<CHAIN>_<NAME>` or in the file | – | for Base and Arbitrum |
| Robinhood provider file (the read path's, own node first) | `--rpc-config <file>` | – | for Robinhood, and for the session's account check |
| Shared head files (F6) | `DOMINO_V2_HEAD_DIRECTORY` | – | no |
| Cloudflare Access service identity | `DOMINO_POSITION_PLAN_ACCESS_ISSUER`, `_AUDIENCE`, `_SERVICE_ID` | – | yes |
| Session boundary | `DOMINO_SESSION_ORIGIN`, `DOMINO_SESSION_ABUSE_SECRET` (64 hex), the session database | – | yes |

Run: `backend/.venv/bin/python backend/v2_position_plan_api.py --enable --rpc-config <Robinhood provider file> [--port 8911]`.

**Manifests (#301, PR #302).** The listener loads each chain's `deployment.json` through `v2_manifest.load_deployment` (#306), main's one loader, with production admission. That loader checks #302's format rule for rule and binds the manifest to the chain profile: the chain, the dependencies at the profile's addresses with their verified code hashes, the charge currencies, and every component at its CREATE3 address. Production admits only a verified public-chain manifest, built from committed sources and verified at the `finalized` tag. A refusal stops the listener with the setting and v2_manifest's code, for example `position_plan_config_manifest_base_8453:v2_deployment_not_admitted`. #302's Base fork rehearsal (copied into main's fixtures) is refused in production by a test.

Before its first plan, the planner proves on-chain the code of the components it calls: the registry and the zap, with `zap.v4.steps` for v4 (`Deployment.verify_code`, once per process).

**What the owner provides:**
1. **A Uniswap Trading API key** for router legs (the Uniswap Developers key V1's onboarding listener reads from its `--uniswap-config` file can serve, or a separate one for its own quota). Without it plans use pool routes only.
2. **The per-chain manifests** from #301's deployment.
3. **Hosted RPC for Base and Arbitrum**, as F6's provisioning list describes.
4. **The Worker route** `/api/position-plan/v1/` → this listener (F8). The systemd unit, its credentials and its egress to `trade-api.gateway.uniswap.org` and the RPC hosts are below.

### In production (Robinhood first)

`scripts/staging/install_position_plan.py` installs the listener and moves it to newer releases; it starts nothing. The tunnel hostname `vm-position-plan.domino.money`, its route to `127.0.0.1:8911` and its Access application are the bridge's.

1. **Install.** Run `install_position_plan.py --archive <tar> --archive-sha256 <hex> --commit <sha>`, first with `--inspect`, then with `--apply`.
   - **The first install** creates:
     - the identity `domino-position-plan`;
     - its peer row `domino domino-position-plan domino_session_auth`, proven by a connection as that user;
     - `/etc/domino/financial/position-plan`;
     - `/var/lib/domino-financial/position-plan`, with `catalogue-db.json`.
   - **Every release** writes `/opt/domino/financial/releases/<sha>/position-plan` (the backend, `api-contracts/v2` and the V2 manifests) and the unit naming it.
   - **Rollback:** `--rollback <sha>` puts back the previous unit, or removes it.
2. **Private files.** They go in `/etc/domino/financial/position-plan`, owned by `domino-position-plan`, mode 0600.
   - **`rpc.json`:** a version 4 provider file led by `https://rpc.domino.money/<token>/`. The session listener's own file is one. `EoaChecker` refuses the loopback proxy.
   - **`environment`:**
     - `DOMINO_POSITION_PLAN_CHAINS=robinhood-4663`;
     - `DOMINO_POSITION_PLAN_MANIFEST_ROBINHOOD_4663=/run/domino-v2-deployments/v2-robinhood-4663-2026-10-04/deployment.json`. The unit binds every release's manifests at that fixed path;
     - the Access application's issuer, audience and service ID;
     - the session listener's `DOMINO_SESSION_ORIGIN` and `DOMINO_SESSION_ABUSE_SECRET`.
3. **The Trading API key** is optional. Seal it once as `/etc/credstore.encrypted/uniswap-api-key` with `systemd-creds encrypt --with-key=host+tpm2 --name=uniswap-api-key`. The unit imports it (`ImportCredential=`) and unsets the environment variable, so the key is never read from a file in clear. The unit also opens the TPM to its device policy (`DeviceAllow=char-tpm rw`). systemd 255 does that by itself only for `LoadCredentialEncrypted=`. On 4 Oct the sealed key stopped the listener at start, with EPERM on `/dev/tpmrm0`, until a hand drop-in added the line.
4. **Egress.** Collect with `position-plan` enabled, render, review, update, then `nft -f`.
   - The role gets the `rpc`, `jwks` and `uniswap` classes, and the replies of its listener on 8911.
   - The tunnel gets the origin rule to 8911.
   - The 60 drop-in adds `--enable --rpc-config /run/domino-financial-position-plan-config/rpc.json`.
   - `domino-continuous-reads.target` wants the unit as a family.
5. **Start.** Run `daemon-reload`, then start the unit. A request without an Access assertion gets 403. Then a plan through the bridge.
6. **Base and Arbitrum,** once their fork qualification passes:
   - add them to `DOMINO_POSITION_PLAN_CHAINS`, each with its `DOMINO_POSITION_PLAN_MANIFEST_<CHAIN>`;
   - set `DOMINO_V2_CHAIN_RPC_FILE=/run/domino-financial-position-plan-config/chain-rpc.json`, a copy of the operator's file owned by `domino-position-plan`. The unit already imports the sealed `v2-rpc-*` URLs;
   - collect egress with `--v2-chains`.

## Calls and cost

Measured on the recorded fixtures (`backend/tests/fixtures/position-plan/recordings.json`). A billed call is each JSON-RPC call, each inside a batch included:

| Plan | HTTP requests | Billed calls |
| --- | ---: | ---: |
| create, Permit2, one own-pool leg | 8 | 9 |
| create, native ETH | 9 | 10 |
| create on a new pool, one leg through another pool | 9 | 10 |
| create from a token outside the pool (a v3 and a v4 leg) | 10 | 11 |
| increase, direct | 9 | 16 |
| change range, direct | 9 | 16 |
| exit converted, direct | 9 | 16 |
| exit to both tokens, relayed | 7 | 14 |
| create on Robinhood (Nitro), one own-pool leg (L1 data fee 0) | 10 | 11 |

Each count includes one head read (`eth_getBlockByNumber`, shared by every V2 service through F6's head file, at most one per chain every 2 s), the account's `eth_getCode` and one `eth_simulateV1`. The L1 data fee costs no call on Base (inside the readiness Multicall3) and one on Nitro (NodeInterface): the Robinhood create above is the Base one plus that call. Each round of pool quotes (a probe, then a confirmation at the final amount) is one Multicall3 call. A v4 position read is 9 calls (F6's reader); aggregating it through Multicall3 (F6's next billing lever) would save about 7.

Once per process, before the first plan: one batched read of the manifest's verification block and the code of the registry and the zap (with its v4 steps), plus F6's Uniswap code proofs (2 per version).

With a key, router legs add 2 Trading API calls (quote and swap) per conversion, and 2 more when the final amount differs from the probe: at most 8 per plan (two conversions). Each call has 6 s; the plan as a whole has the listener's 20 s.

## Evidence

| Test | What it proves |
| --- | --- |
| `test_v2_fee_rule.py` | Every vector of `DominoFeeRules.t.sol` and F1b's table; 2,000 random routes against an independent reference model |
| `test_v2_position_plan_evm.py` `FeeRuleParityEvmTests` | **Fee-rule parity on the deployed zap's bytecode.** For 96 random routes with random registry ranks (written into the registry's storage), `zap.create` with the Python rule's terms passes the zap's fee check (and stops later, at a router the registry deliberately does not admit), while every other token of the route is refused with `FeeMismatch`; plus F1b's table on the zap |
| `test_v2_position_plan_evm.py` journeys (vendored and Base-deployed Uniswap) | Each plan executed end to end with the real zap: create with a swap through Permit2; increase, change range and exit converted, direct; a v4 increase refunding the fees the position earned before it and from its own swap; exit to both tokens (no fee); a relayed exit sent by another account; v3 create, increase, change range and exit; native ETH on v4; native ETH paying a v3 WETH pool; a token outside the pool split in two legs; new v4 and v3 pools at the owner's price; refusals; an EIP-7702 delegated account (direct only). On every one, each leg delivered exactly `expectedOutRaw`, `FeeCharged` was exactly `fee.amountRaw`, the liquidity exactly `expected.liquidity`, and the zap's refunds exactly `expected.returned` (an exit without legs is paid by the position manager itself, with no refund) |
| `test_v2_position_plan_evm.py` `S1RouterLegEvmTests` | A router leg through Robinhood's deployed Universal Router 2.1.2 runtime, chosen when better and executed; a router route through the position's pool refused |
| `test_v2_position_plan_evm.py` local swap | The Python swap equals QuoterV2's and V4Quoter's answers across at least three initialized ticks, on v4 and v3 |
| `test_v2_position_plan_evm.py` minimums | On ±1% and ±10% v4 ranges, a create executes at every point of the ±s band with exactly the formula's liquidity, equals `minLiquidity` at the worse edge and reverts past it (`InsufficientLiquidity(uint128,uint128)`), and past the better edge where the formula falls below the minimum; an exit executes across the band, pays exactly its minimum at each edge and reverts one step past either (`MinimumAmountInsufficient(uint128,uint128)`); a converted exit of a ±1% position executes after a move inside the band |
| `test_v2_position_plan_evm.py` L1 data fee | Base: the captured GasPriceOracle reproduces Base's answers for a sample transaction, and the plan's fee and bound are the oracle's for the plan's own transaction, read with no call of its own; Robinhood: one NodeInterface call, the L1 gas of the call's bytes times the L2 base fee (stand-in), and `unavailable` with the plan intact when the node does not answer |
| `test_v2_l1_fee.py` real nodes, `test_position_plan_contract.py` | The own Robinhood node's answer for the recorded plan's call is a fee of 0 with its source and block, in the replayed plan too; Arbitrum One's answer for the same call is its L1 gas times its base fee. Treating a zero answer as missing fails both (mutants killed, in Python and in `runtime.mjs`) |
| `test_v2_position_plan_minimums.py`, `test_v2_l1_fee.py` | The minimums as properties (the SDK's band, every price inside it, legs at their minimum with the fee, native ETH as WETH, a same-range change within a millionth); RLP against the reference library, the unsigned transaction's fields, both sources' calls and failures |
| `test_v2_quotes.py`, `test_v2_liquidity.py`, `test_v2_plan_codec.py`, `test_v2_uniswap_api.py` | Quotes, ticks and Multicall3 decoding; the exact math (F7 §2.6.5's example included, and the fee growth a swap adds, protocol fee included); the codec against the EIP-712 goldens and the zap's selectors; every Trading API field that must match |
| `test_position_plan_contract.py` | The exported contract is current; fixtures replay the real service against recorded chain answers (no network); the consumer test; the listener's boundary, limits and launcher |
| `test_v2_position_plan_config.py` | Manifests through v2_manifest (production admits a verified public manifest; local tests, #302's fork rehearsal, another chain and a malformed one are refused, named), settings, secrets never echoed |
| `qualify_position_plan_fork.py` on Robinhood, 4 Oct 2026 ([report](../../reports/v2-position-plan-qualification-2026-10-04/robinhood-4663.json)) | **The deployed V2 on a fork of the chain, through the own node.** One plan of each kind on real pools (WETH/USDG v4, ETH/USDG v4, WETH/USDG v3) with the verified production manifest. 13 plans executed exactly as planned: each leg's output, the fee, the liquidity and the refunds, as in the journeys above. One more plan was made against the live node for the deployer and never sent: its quote came from the V4Quoter, its `eth_simulateV1` ran on Nitro, and NodeInterface answered its L1 component |

**Which deployer each EVM test uses.** All of them use `backend/tests/v2_s1_chain.py`, on a local Anvil with real Uniswap code:
- `vendored`: vendored v4, Base's v3 bytecode;
- `deployed`: Base's deployed v3 and v4 bytecode at Base's addresses, with the real Base profile;
- `router` (Robinhood, 4663): Robinhood's PoolManager and Universal Router 2.1.2 runtimes.

On the Base chains every F0 component is deployed at its CREATE3 address by #306's `v2_local_chain.deploy_v2` (the automation suite's deployer), and its manifest is loaded by `v2_manifest` as a local test, exactly as the listener loads a real one. The Robinhood chain has no v3 code for deploy_v2's v3 components, so there the fixture deploys the registry, `zap.v4.steps` and `zap.v4` itself and builds the `v2_manifest.Deployment` directly. None uses #302's `deploy-local.mjs` yet: its offline mode installs synthetic constructor dependencies that cannot swap or hold positions.

**Checks.**

```sh
DOMINO_TEST_EVM=1 backend/.venv/bin/python -m unittest discover -s backend/tests -p 'test_v2_position_plan_evm.py'  # needs the V2 artifacts
backend/.venv/bin/python scripts/export-position-plan-contract.py --check
node --test api-contracts/position-plan-v1/consumer.test.mjs
node scripts/v2/export-abi.mjs --check
```

CI's Backend job builds the V2 artifacts these tests deploy in its single V2 build step (#306's).

## ABI exports (F7 D7)

`scripts/v2/export-abi.mjs` now also writes `api-contracts/v2/implementations/`: for each deployable V2 contract, its events and errors with their topics and selectors, and `index.json`, which maps each F0/#301 component to the contracts that can emit through it (`zap.v4` → `DominoZapV4` + `DominoZapV4Steps`; `vault.v4` → the vault, its executor and the swap module; and so on).
- It is additive: `api-contracts/v2/abi/` and the interface pins are unchanged.
- The topics equal F7 §2.11's table (`SwapLegExecuted` `0x60154ef2…`).
- `--check` covers the new directory, stale or extra files included.
- These are not a frozen surface: they change with the implementations, and the app decodes with them.

Permit2's, the position managers' and the Universal Router's errors stay in the planner's table and in `REVERT_NAMES` of the contract runtime.

## What remains

- **The Worker route** (the bridge's). The unit, its egress role and its credentials are `install_position_plan.py` and the continuous egress policy ("In production" above); the manifests are #301's. The contract stays `candidate_disabled_pending_deployment_and_worker` until the bridge serves it.
- **Qualification on forks** (`backend/qualify_position_plan_fork.py`): one plan of each kind per chain, on the deployed V2.
  - **Robinhood: done on 4 Oct 2026, 14 of 14** ([evidence](#evidence)). That includes the V4Quoter, and `eth_simulateV1` on the own Nitro node.
  - **Base and Arbitrum:** still to run. They need their hosted RPC, reached through a loopback forwarder, because the tool takes no remote upstream, and their manifests added to the tool's list.
  - **The Trading API's live answers** with the zap as swapper: still synthetic in the tests. They need the owner's key.
- **Gas in money**: L2 `gasUnits` and the L1 data fee in wei; no gas price, no OP Stack operator fee, no ETH or USD value (F6's gas work).
- **Converted exits of narrow ranges** convert what the band guarantees ([table](#minimums-at-the-worst-price-within-s-rc2)): the app should offer a lower `s` for them, or an exit to both tokens.
- **Wrapping is never a leg.** The zap has no wrap or unwrap leg, so a WETH input for a v4 native-ETH pool, or an exit of a v3 WETH pool converted to native ETH, swaps WETH like any other token (through an ETH/WETH pool, with the fee) or finds no route. The app should offer WETH as the target on v3 and ETH on v4.
- **Inputs:** at most one token outside the pool.
- **Positions under automation** (F7 §2.13): only the wallet's own positions are planned. A vault successor is `position_plan_not_owner`, and the app enforces the armed-root rules.
- **Exit to both tokens and collect** are planned through the zap, without a fee. F7 §2.6.4 recommends calling the position manager directly for them, and the app may do so.
- **Billing:** Multicall3 aggregation of position reads (F6), which would take an increase, change range or exit from 16 to about 9 billed calls.

## Alignment with F7's draft request shape (§2.4)

F7 sketched the API before it existed and marked it "to be defined by item 3c". The contract's names, which F7 should adopt:

| F7 §2.4 draft | position-plan-v1 |
| --- | --- |
| `pool` (create) \| `tokenId` (others) | `pool` (create) \| `position: {dex, tokenId}` |
| `initSqrtPriceX96` (new pool) | `initialPrice: {price, baseToken, decimals0, decimals1}`; the answer carries `initialPrice.sqrtPriceX96` and `tick` (owner, 2 Oct) |
| `liquidityToRemoveRaw` | `liquidityToRemove` (`"all"` or raw) |
| `receive: "both" \| {convertTo}` | `receive: {mode: "both"} \| {mode: "converted", token}` |
| `consent: "direct" \| "permit2"` | adds `"relayed"` (unused at launch) |
| `plan: {intent, …}` | `zapPlan` (the struct), plus `call` and `signature` |
| `quote.legs`, `expectedLiquidity`, `expected0Raw`, `expected1Raw`, `fee {token, amountRaw, place}`, `gasUnits` | `legs`, `expected.liquidity`, `expected.amount0Raw` / `amount1Raw`, `fee {bps, token, place, basisRaw, amountRaw, ranks}`, `simulation.gasUnits` |
| `simulation: {block, ok, error}` | `block`; `simulation: {status, reason, method, error {selector, name}, gasUnits, result}` |
| "the answer carries no Domino address" | It carries `zap` and the typed data's addresses, which the signature needs; the app checks them against its manifest and never uses them as a source (§7.3 rule 6) |
| §2.9: minimums = expected × (1 − s) | Each minimum at the worst price within ±s (rc.2); `minimums.mintBand` / `removalBand` give the prices the action executes between |
| `gasUnits` only | `simulation.gasUnits` (L2) and `l1DataFee` (L1, wei), apart |
