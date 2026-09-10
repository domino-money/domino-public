# Uniswap Trading API: Robinhood read-only readiness

The locally configured Uniswap key was used for **one successful quote request** on Robinhood mainnet, chain `4663`, at `2026-09-10 02:02:29–02:02:32 UTC` (September 9 in São Paulo). The response arrived in **3.135 seconds**. This confirms a usable external quote path for the tested public pair; it does not depend on Domino's historical pool ledger.

Sanitized evidence: [trading-api-read-probe-2026-09-09.json](trading-api-read-probe-2026-09-09.json).

## Observed result

| Field | Provider observation |
| --- | --- |
| Request | `EXACT_INPUT`: `1000000000000000` WETH base units, or **0.001 WETH** |
| Quote output | `2461513` USDG base units, or **2.461513 USDG** |
| Minimum output | `2449205` USDG base units, or **2.449205 USDG** |
| Slippage | **0.5%** |
| Routing | `CLASSIC`, one hookless v4 pool, fee `200` pips |
| PoolId | `0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6` |
| Reported price impact | **0.03%** |
| Estimated gas | `192161` units; `46196465205000` wei |
| Provider gas USD estimate | **0.07529905334762742 USD** |
| Reported block | `59031060`; no block hash supplied or independently revalidated |
| Simulation failure codes | Empty list; this is not an independent successful execution test |

WETH identity was `0x0bd7d308f8e1639fab988df18a8011f41eacad73` with 18 decimals; USDG was `0x5fc5360d0400a0fd4f2af552add042d716f1d168` with 6 decimals. The response matched the requested chain, exact input, both token addresses, placeholder swapper, slippage and trade type. The route matched the known public pool ID; no claim of a new on-chain snapshot verification is made. The sanitized route does not retain a tick-spacing value because that response field did not have the integer type expected by this bounded probe.

Gas figures are the provider's estimates, not receipts or independently priced costs. The API's `gasUseEstimate` excludes additional token approvals. Absent `portionBips` and `portionAmount` were preserved as unknown rather than converted to zero. [Official quote schema at the inspected commit](https://github.com/Uniswap/interface/blob/da6d36f71c4d2fd665b0aae1a052a4ffda917b31/packages/api/src/clients/trading/api.json).

## Request contract and skill corrections

The request used the documented fixed endpoint `POST https://trade-api.gateway.uniswap.org/v1/quote`, `BEST_PRICE`, `protocols: ["V4"]`, and `hooksOptions: "V4_NO_HOOKS"`. This deliberately tests an AMM route; UniswapX was not exercised. The current official chain table also lists Robinhood support for UniswapX V3. Coverage of one pair is not a promise that any token, pool, amount or routing mode will quote successfully. [Supported chains](https://developers.uniswap.org/docs/trading/swapping-api/supported-chains), [quote endpoint](https://developers.uniswap.org/docs/api-reference/aggregator_quote).

The installed `swap-integration` skill version 1.5.0 was read. Two generic examples require correction for this network/current API:

- **Router header:** send `x-universal-router-version: 2.1.1`. Robinhood has no 2.0 deployment; current official documentation explicitly says requesting 2.0 on Robinhood errors. The skill's blanket 2.0 header should not be copied into the Robinhood integration.
- **Chain ID type:** the current official OpenAPI defines numeric chain IDs. This successful probe used `tokenInChainId: 4663` and `tokenOutChainId: 4663`, correcting the skill's assertion that these must be strings.

The key was loaded through `uniswap_config.load_config` and attached only as `x-api-key`. Agent attribution was sent as the exact three-field JSON object for `swap-integration`, `human_mediated`, version `1.5.0`. The transport retained its bounded response size, 20-second request timeout, and redirect rejection. No key was placed in command arguments, output or the evidence artifact. No new runtime API or client module was created.

## Scope and next integration step

The required `swapper` was the public placeholder `0x000000000000000000000000000000000000dead`, **not the user's wallet**. `permitAmount: "EXACT"` and `generatePermitAsTransaction: false` were requested. The response included permit data; it was discarded. No approval endpoint, `/swap`, order submission, signature, broadcast or token movement was performed.

The configured request succeeded, but this task did not perform a missing-key/invalid-key control; it does not claim an independent authentication audit. In particular, success from the separate LP `pool_info` endpoint cannot establish key validity, because that endpoint also responds without a key.

For the next slice, add a narrowly scoped backend quote adapter using the corrected headers and numeric chain IDs, bind every response to the requested chain/tokens/amount/slippage, preserve simulation/fee/gas limitations, and expire quotes promptly. Current quote data must not be persisted as executable authorization. Actual swaps remain a separate reviewed flow with the real user's wallet, fresh quote, appropriate approvals and simulation, and explicit signing. Read-only pool discovery and quote preview can advance immediately without completing lifetime pool replay.
