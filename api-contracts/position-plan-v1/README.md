# position-plan-v1: S1 plans for the V2 zap

Contract `1.0.0-rc.2` for S1 of [#283](https://github.com/domino-money/domino/issues/283) (manual management, milestone M1): a create, increase, change of range or exit on a Uniswap v3 or v4 pool of Robinhood (4663), Base (8453) or Arbitrum One (42161), planned by the server for the zap (F2). The service, its configuration and its decisions are in [docs/v2/V2_S1_PLAN_API.md](../../docs/v2/V2_S1_PLAN_API.md); the app side is F7 §2.

POST `/api/position-plan/v1/plan` through the authenticated bridge (private origin `/internal/position-plan/v1/plan`, `backend/v2_position_plan_api.py`), with `X-Domino-Position-Plan-Contract: 1.0.0-rc.2`, a SIWE session and CSRF. The owner is always the session's wallet: it receives the NFT and every refund. No request names an owner or a recipient.

## Request

| Field | Actions | Rule |
| --- | --- | --- |
| `chainId` | all | `4663`, `8453` or `42161` |
| `action` | all | `create`, `increase`, `changeRange`, `exit` |
| `consent` | all | `direct` (all), `permit2` (create, increase; ERC-20 inputs only), `relayed` (changeRange, exit; no relayer exists at launch) |
| `pool` | create | `PoolRef`; `hooks` must be zero (hooked v4 pools are refused for positions) |
| `position` | increase, changeRange, exit | `{dex, tokenId}`; the session's wallet must own it |
| `tickLower`, `tickUpper` | create, changeRange | multiples of the pool's spacing |
| `inputs` | create, increase | 1–2 `{token, amountRaw}`: the pool's tokens, or exactly one other token. Native ETH (`0x0…0`) pays a v3 WETH pool's WETH side (not together with WETH); what is left returns as WETH |
| `liquidityToRemove` | changeRange, exit | `"all"` or a raw amount (`"0"` collects fees on exit) |
| `burn` | changeRange, exit | burn the NFT; needs all its liquidity |
| `receive` | exit | `{mode: "both"}` or `{mode: "converted", token}` |
| `initialPrice` | create of a pool with no price | `{price, baseToken, decimals0, decimals1}`: one whole `baseToken` is worth `price` whole tokens of the other currency |
| `slippageBps` | all | 10–500, default 50 |

## Response (`plan`)

- `zapPlan`: the exact `IDominoPositionActions` plan struct for the action. `call`: the zap function, its selector and, for `direct`, the complete call data and value. `signature` (`permit2`, `relayed`): the `eth_signTypedData_v4` JSON, its digest, and for Permit2 the `permit` to pass with the signature.
- `routesHash`, `intentHash`: recomputed by `runtime.mjs` and by the zap.
- `legs`: each swap leg as quoted at `block`: kind, tokens, `amountInRaw`, `expectedOutRaw`, `minAmountOutRaw`, the pools and the quote's source (`local_simulation` for the position's own pool, `quoter_v2`, `v4_quoter`, `uniswap_trading_api`).
- `fee`: the Domino fee by F1b's rule: bps (65, or 0 with no legs), token, place (`input`/`output`/`hop`/`fallback`/`none`), the expected basis and amount, and the registry ranks it read (`ranks`).
- `expected`: liquidity, the amounts that go into the position, the pool price after the legs, the withdrawal (principal and fees) for changeRange/exit, and what returns to the wallet (`returned`).
- `minimums` (rc.2): each at the worst price within ±s, as the Uniswap SDK's `mintAmountsWithSlippage` / `burnAmountsWithSlippage`: `minLiquidity` is the least the zap mints over the band around the mint's price (`mintBand`) from what it is sure to hold (legs at their minimum, the fee at those outputs); the removal minima are what removing pays at the band's edges around the pool's price (`removalBand`); an exit's `minLiquidity` is the liquidity removed. Each leg's `minAmountOut` is `floor(expectedOut × (1 − s))`. `planMinimums` recomputes them with the zap's exact math.
- `readiness`: the account's kind (`eoa`, `eip7702`, `contract`; an account with code gets `direct` only), balances, ERC-20 allowances to the zap or Permit2, the NFT's approval to the zap, the nonce chosen, and the wallet `steps` in order (exact `approve` call data; the action itself is `call`).
- `l1DataFee`: the transaction's L1 data fee at `block`, apart from the L2 gas: on Base the GasPriceOracle's `getL1Fee` of the unsigned transaction (`weiRaw`) and `getL1FeeUpperBound` (`upperBoundWeiRaw`); on Robinhood and Arbitrum NodeInterface's `l1GasUnits × l2BaseFeeWei`; `status: unavailable` when the chain did not answer.
- `simulation`: the zap call from the owner at `block` (`eth_simulateV1` with the missing approvals first, else `eth_call`), its gas and `ActionResult`, or the revert's selector and name.
- `requestedAt`, `expiresAt` (`requestedAt + 180`: sign before it), `deadline` (`requestedAt + 300`: the intent's and the permit's deadline).

Every Domino address in the answer (`zap`, `call.to`, the typed data's `spender` / `verifyingContract`, approval spenders) must equal the app's pinned deployment manifest (#301); `fee.ranks` must equal the registry's (or the profile's) ranks. `runtime.mjs` cannot check those, the app must.

## Checks

```sh
backend/.venv/bin/python scripts/export-position-plan-contract.py --check
node --test api-contracts/position-plan-v1/consumer.test.mjs
```

`backend/tests/test_position_plan_contract.py` runs both. The fixtures are the real service replaying chain answers recorded from the local test chains of `backend/tests/v2_s1_chain.py` (synthetic tokens and wallets): eight Base plans, with Base's own GasPriceOracle state, and one Robinhood plan, whose L1 data fee is the own Robinhood node's NodeInterface answer for its call (0 today: a fee of 0, not a missing one). The Worker route (`/api/position-plan/v1/`) is not part of this candidate.
