# Uniswap LP position preview — issue #36

[Execution policy](EXECUTION_POLICY.md) supersedes historical owner, ACK and
approval procedures here. Any authorized collaborator or agent may implement
and operate within scope, recording results alongside or after execution.
Technical controls, compatibility evidence and wallet consent still apply.

The internal `UniswapPosition` adapter calls Uniswap's `/lp/create` to calculate
the second deposit token and prepare an unsigned existing-pool mint. Domino
validates the returned identity and spending limits, then discards the executable
payload. There is no second liquidity formula, swap-ratio solver or fallback
engine in this integration.

That statement is about this backend adapter, and only it. The browser does
derive the dependent amount, in `app/src/lib/create/pairAmount.ts`: exact
integer arithmetic on the pool's own `sqrtPriceX96` as read and the chosen
ticks through `sqrtPriceAtTick`, which is v4-core's `TickMath` — the same
inputs and the same v4-core formulas this adapter's provider uses, with no
floating point and no price approximation. It exists because a person cannot
choose a range or an amount without seeing what the other field becomes, and
onboarding-v1 is a disabled candidate. It fills that field and nothing else:
the expected deposit, the maximum debit with slippage and whether a wallet
covers them remain this preview's to report, and Review shows this preview's
figures, never the browser's. The browser's number is the amount at the price
of the read it came from; the mint rounds in the pool's favour and the price
moves.

This is a backend candidate stacked on #35. No public route, shared `read-v1`
field, browser hook, frontend file or deployment configuration changes. Frontend
integration requires a defined and validated browser contract, which any
authorized collaborator may implement; this Python result is not that contract.
The personal bot is independent.

## Division of responsibility

| Component | Responsibility |
| --- | --- |
| Frontend + official Uniswap SDK | Pair/fee/range/amount selection, including the dependent amount shown in the field a person types into (see above); human-price orientation and conversion to canonical spaced ticks; later review and wallet interaction. |
| Uniswap LP API | Fetch pool state, calculate dependent amount and liquidity, prepare the mint using its SDK. |
| Domino backend | Keep the API key private; bind chain, pool, owner, range and request; inspect mint maxima; report selected-budget checks, uncertainty and freshness. |
| Later execution integration | Authenticate owner, refresh balances/allowances/state, validate complete transaction and slippage semantics, simulate, review/sign, broadcast and reconcile the receipt. |

`/lp/create` is not a swap-to-balance optimizer. A swap quote from #35 and this
mint preview are not an atomic funding operation. Swap-assisted onboarding and
advanced initialization of a genuinely new pool remain separate Uniswap
integration work. No silent initialization, arbitrary hooks, dynamic fees,
Permit2 signatures, approvals or wrapped-token aliases are admitted here.

## Explicit local use

Configure the product key with `configure_uniswap.py` at its hidden prompt.
The key is never an argument or output. `--config-file` can select another
product worktree's private configuration without copying it.

Example public placeholder, existing WETH/USDG pool, raw amounts and canonical
ticks (not a funded wallet or a recommendation):

```sh
backend/.venv/bin/python backend/preview_position.py \
  --owner 0x000000000000000000000000000000000000dead \
  --pool-id 0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6 \
  --currency0 0x0bd7d308f8e1639fab988df18a8011f41eacad73 \
  --currency1 0x5fc5360d0400a0fd4f2af552add042d716f1d168 \
  --fee-pips 200 --tick-spacing 4 \
  --independent-token 0x0bd7d308f8e1639fab988df18a8011f41eacad73 \
  --amount-raw 1000000000000000 \
  --tick-lower -200000 --tick-upper -196000 --slippage-bps 50 \
  --budget0-raw 2000000000000000 --budget1-raw 100000000
```

Success writes one JSON line to stdout, exit 0, including a blocked or incomplete
preview. Invalid input/provider failure writes a fixed-code JSON line to stderr,
exit 2. No partial success or raw exception text is emitted. This command has no
network/import side effect until invoked and makes at most one API request.

The only provider destination is `https://liquidity.api.uniswap.org/lp/create`.
The existing HTTPS transport denies redirects, caps the response at 2 MB and
rejects duplicate JSON keys/nonfinite numbers. The complete operation shares a
12-second deadline, with no retries or cache. A preview expires 30 seconds from
request start. The prepared transaction's exact deadline is request start plus
1,200 seconds; that longer upstream deadline does not extend preview freshness.

## Inputs and units

Provide canonical `PoolKey` currencies, fee, spacing and full PoolId. The adapter
checks their hash association; it does not independently prove that the pool
exists at a fresh on-chain block. Chain 4663, no hooks and a fixed fee are required.
Either currency may be independent. Native ETH is the zero address; WETH stays a
distinct ERC-20 address. Native settlement/refund has offline coverage; live
qualification in this slice covers ERC-20/ERC-20 only.

This slice deliberately accepts **ticks only**. The official frontend/SDK handles
human price orientation/decimals and tick spacing. Both response ticks and encoded
mint ticks must match the request exactly; the adapter never widens the range.
Returned `adjustedPrices` are attributed provider values in
`raw_token1_per_raw_token0`, not human prices or independently checked tick-price
math. `humanPrices` stays null. Live WETH/USDG (18/6 decimals) showed a raw value
around `0.000000002…`; displaying it directly as a USDG/WETH price would be wrong.
This avoids the ambiguous units in upstream `priceBounds` prose/examples.

All token quantities are decimal integer strings in base units. No symbol or
guessed decimal selects a token or changes an amount. `amountRaw` is the requested
nominal independent amount; it is not a promise that the prepared mint can spend
only that amount. Budget caps are separately selected per currency.

## Spending limits and uncertainty

Each token reports:

| Field | Meaning |
| --- | --- |
| `expectedDepositRaw` | Nominal amount returned by Uniswap. Actual deposit is unknown until execution. |
| `maximumDebitRaw` | Maximum token debit decoded from the mint action's `amount0Max`/`amount1Max`. |
| `selectedBudgetRaw` | Optional user-selected ceiling; no wallet balance is implied. |
| `estimatedUnspentBudgetRaw` | Selected budget minus nominal amount, or null when unknown/over budget. |
| `unspentAtMaximumRaw` | Selected budget minus encoded maximum, or null when unknown/over budget. |

These leftovers concern the **selected budget**, not all wallet tokens, unclaimed
fees, an idle reserve policy or realized change. A zero is preserved when known.
An unknown cap remains null and produces an incomplete check. Encoded maxima
above either cap produce `blocked`, even if nominal amounts fit. An independent
input already exceeding its selected budget is rejected before the provider call.

Do not rely on `dependentToken.amount` as enforcement: a real probe sent one raw
USDG unit and the provider returned more than two million raw units. Domino
marked that preview blocked. Also, concentrated-liquidity slippage is not a flat
percentage added to each nominal token amount: a 0.5% request yielded a WETH cap
about 2.39% above the nominal input in the sample. We retain the provider's exact
encoded limits and require the selected budgets to cover them; we do not derive
another slippage/LP formula. `slippageModelIndependentlyVerified` remains false.

Optional `nativeBalanceRaw` and `nativeGasReserveRaw` check that native mint value
plus the selected reserve fits the caller-reported balance. A reserve requires a
balance. The reserve is a gas headroom check, not a fixed percentage of earnings.
Neither value is independently read here, and an explicit zero reserve does not
prove that execution needs no gas. Missing gas remains null. Even
`within_selected_limits` says only that the supplied caps/headroom fit the
observed values; **every preview has `executionAvailable: false`**.

Direct deposit has no Domino setup percentage or earned-fee automation cut. No
swap is performed and no assisted-swap tariff is selected. Network costs remain
separate. No funds or service fees are charged by calling this preview.

## Prepared-mint inspection

`lp_mint_inspection.py` accepts one canonical `modifyLiquidities(bytes,uint256)`
call to the fixed Robinhood PositionManager from the selected owner. It decodes
and re-encodes every ABI layer, rejecting noncanonical offsets/padding/trailing
bytes. Calldata is capped at 64 KiB. PoolKey, ticks, deadline, NFT recipient,
settlement currencies and empty hook data must match. Liquidity is positive and
within signed-int128 capacity; maxima use the action's uint128 fields.

Only `MINT_POSITION → SETTLE_PAIR` is admitted, with a native `SWEEP` refund to the
verified owner/caller when needed. Native `value` must equal the native mint cap;
ERC-20-only calls must send zero ETH. Arbitrary multicalls, swaps, permits, pool
initialization, wrapping, additional actions/recipients and other targets are
rejected. No calldata, permits, signatures, raw provider messages or request IDs
leave the preview. Hash/fingerprint association is not wallet authorization.

Static inspection proves only these structural associations. It does not prove
provider pricing, current code/state, token transfer behavior, allowances, actual
gas, favorable economics, or execution success. The API request explicitly uses
`simulateTransaction: false`; the result is not described as a successful
simulation. A future signing path needs its own reviewed validation and cannot
turn this result into authorization by flipping `executionAvailable`.

## References and validation

- [Official LP API guide](https://developers.uniswap.org/docs/liquidity/liquidity-provisioning-api/integration-guide)
- [Pinned API schema](https://github.com/Uniswap/interface/blob/da6d36f71c4d2fd665b0aae1a052a4ffda917b31/packages/api/src/clients/trading/api.json)
- [Official frontend request builder](https://github.com/Uniswap/interface/blob/da6d36f71c4d2fd665b0aae1a052a4ffda917b31/apps/web/src/features/Liquidity/utils/generateLiquidityServiceCreateCalldata.ts)
- [Pinned v4 SDK position builder](https://github.com/Uniswap/sdks/blob/1d7d7129e1e005db8fed0c8970301470b46b68a0/sdks/v4-sdk/src/PositionManager.ts)
- [Pinned action ABI](https://github.com/Uniswap/sdks/blob/1d7d7129e1e005db8fed0c8970301470b46b68a0/sdks/v4-sdk/src/utils/v4Planner.ts)
- [Qualification evidence](../reports/POSITION_PREVIEW_IMPLEMENTATION.md)

Offline focused checks need no API key, wallet, RPC or funds:

```sh
backend/.venv/bin/python -m unittest discover -s backend/tests -p test_uniswap_position.py -v
backend/.venv/bin/python -m unittest discover -s backend/tests -p test_lp_mint_inspection.py -v
backend/.venv/bin/python -m unittest discover -s backend/tests -p test_preview_position.py -v
```
