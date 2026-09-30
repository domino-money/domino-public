# Owner-funded swap quote preview

Issue [#34](https://github.com/domino-money/domino/issues/34). Internal candidate,
10 September 2026. `backend/uniswap_quote.py` and `preview_swap.py` implement the
next onboarding dependency after the successful Trading API readiness probe.
This is a DEX quote observation, not the completed LP funding plan. It does not
choose how much to swap, calculate range composition or authorize spending.

## Scope and inputs

The caller explicitly supplies owner, input/output currency addresses, a positive
DEX input in uint256 base units, slippage in whole basis points (0–9,999), and
maximum provider-reported price impact in whole basis points (0–10,000). Those
validation ranges are not recommended user defaults or execution policies.
Robinhood chain 4663 is fixed. No symbols, assumed token decimals, default amount
or default risk tolerance are used.

The request uses `EXACT_INPUT`, owner as both swapper and recipient, `BEST_PRICE`,
V4-only routes without hooks, and explicit router version 2.1.2 (Uniswap sunsets
2.0 and 2.1.1 on 21 October 2026). Eight split paths
of up to four hops each are accepted. Full PoolKeys must hash to the supplied
PoolIds, pools cannot repeat, currency paths must connect, and path-boundary
amounts must sum to the exact requested input and quoted output. Intermediate
amounts are optional upstream; when both sides are reported they must agree.
Token decimals remain unknown when absent; conflicting metadata is rejected.

Direct native-currency v4 paths can be observed. Pure WRAP/UNWRAP and paths whose
synthetic native/WETH edge was omitted fail with an explicit unsupported-route
code. Native ETH is never silently treated as WETH. Non-v4 routes, hooks,
dynamic fees and explicitly reported transfer taxes are outside this preview
scope. An otherwise accepted token is not certified transfer-safe.

Each call makes one fixed HTTPS request with a 12-second monotonic budget and
2 MB response cap, no retry, cache, redirect, queue or background work. Existing
parent deadlines can only shorten the budget. DNS resolution remains a blocking
OS operation; a late DNS result cannot start a connection. The fixed router and
attribution headers are accepted only at the exact quote URL. Other read
transport/header restrictions are preserved.

## Amounts, costs and validity

All raw quantities are strings. Percent observations are normalized decimal
strings. Slippage checking uses integer arithmetic:
`floor(gross output × (10000 − slippageBps) / 10000)`.
The provider minimum must be at least this floor and no greater than its quote.

| Result field | Meaning |
| --- | --- |
| `request` / `requestFingerprint` | Exact normalized owner/chain/currencies/input/limits and their deterministic SHA-256; comparison only, not a signature or unique intent |
| `quote.dexInputAmountRaw` | Input quoted to the DEX; not the total LP budget and not inclusive of a future Domino assisted fee |
| `quote.grossOutputAmountRaw` / `grossMinimumOutputAmountRaw` | Provider output before any API output portion fee |
| `quote.outputAfterProviderFeeRaw` / `minimumAfterProviderFeeRaw` | Available only for an explicitly zero provider fee; still excludes the unselected Domino tariff and owner gas |
| `providerOutputFee` | Legacy portion fields plus normalized aggregate recipients; unknown values stay null |
| `providerOutputFee.zeroEvidence` | Explicit legacy zero, or a complete 100% owner aggregate with matching amounts/minimum; absent legacy fields stay null even in the latter case |
| `dominoFee` | Unselected tariff, null rate/amount, approved 65 bps ceiling on consumed gross owner input; no automation fee on principal |
| `gas` | Provider estimates only; excludes approvals and does not certify all network costs |
| `simulation` | Unknown, failures reported, or no failures reported; never independent execution proof |
| `previewChecks` | Only observed impact, provider-fee, gas-presence and simulation checks; never general funding readiness |
| `requestedAt`, `retrievedAt`, `expiresAt` | Local Unix seconds; validity ends 30 seconds from request start, never 30 seconds after receipt |
| `provenance` | Provider block number if present, null hash, source/schema/router and explicit lack of independent state verification |

Nonzero provider output fees are disclosed but unsupported for a net preview.
Unknown fees prevent a net figure. Aggregate amounts, recipients and basis
points must agree with any supplied legacy fields; contradictory data is
rejected. Pool trading costs are already reflected in the output and are not
subtracted a second time.

The approved Domino assisted-swap fee uses the owner's consumed **gross input**,
with the remainder quoted to the DEX. Uniswap's optional output portion is a
different basis and does not implement that policy. This module selects no
tariff, fee recipient or collection mechanism, and applies no 2% automation cut.
The later owner funding planner must quote the post-service-fee DEX input and
bind the final disclosed amounts to the actual owner budget and operation.

`status` is always `preview_only` and `executionAvailable` is always false.
`within_observed_limits` does not prove wallet funds, allowance, owner control,
token safety, pool state, balanced LP funding or execution readiness. In
particular, missing `approvalApplicable` means an approval may be needed; false
describes a routing mechanism, not verified on-chain allowance.

## Run explicitly

Use the private Uniswap configuration created by `configure_uniswap.py`, or pass
its path explicitly. Never provide a key as a command argument. This example
uses a public burn-address placeholder and makes one external quote read:

```sh
backend/.venv/bin/python backend/preview_swap.py \
  --owner 0x000000000000000000000000000000000000dead \
  --token-in 0x0bd7d308f8e1639fab988df18a8011f41eacad73 \
  --token-out 0x5fc5360d0400a0fd4f2af552add042d716f1d168 \
  --amount-raw 1000000000000000 \
  --slippage-bps 50 --max-price-impact-bps 100
```

The CLI prints the normalized JSON. Missing/invalid configuration or rejected
quotes produce a fixed safe error and a nonzero exit. A valid observation with
blocked preview checks is still a successful read; consumers must inspect its
checks and expiry. Optional `--config-file` selects another private file without
copying it. No service listener starts. No `/check_approval`, `/swap`, order,
signature, permit or broadcast operation is called. The raw provider quote,
permits, transaction data, swap steps, IDs and untrusted symbols are discarded.

## Integration and remaining work

There is no new public HTTP route, contract package or frontend hook. Existing
`read-v1`, `session-v1` and frontend source are unchanged. This candidate is
stacked on #27 solely for the bounded HTTP transport and Uniswap configuration.
Its normalized example is the [sanitized live evidence](../reports/funding-quote-live-2026-09-10.json).

Next owner-funded work is the exact range/budget composition planner, tariff
calibration, fresh balance/deployment checks and simulations, followed by
durable owner-bound swap/mint intents with cancellation/replacement recovery.
Before exposing quotes, add a reviewed authenticated and rate-limited adapter,
versioned request/response schemas and fixtures, and the frontend compatibility
notice/acknowledgement. This module is not an HTTP service or rate-limit layer.
Owner signing and execution require their separate concrete review gates.

#4 remains open: no production price source or full reconciled 24-hour APR is
qualified here. Its optional lifetime replay is not an onboarding prerequisite.
The deferred Cloudflare setup and consumer evidence remain #5 integration work.

## Primary reference sources

- [Uniswap quote API](https://developers.uniswap.org/docs/api-reference/aggregator_quote): exact-input output fees, slippage, simulation and routing semantics.
- [Supported chains](https://developers.uniswap.org/docs/trading/swapping-api/supported-chains): Robinhood 4663.
- [Sunset of Universal Router 2.0 and 2.1.1](https://developers.uniswap.org/docs/changelog/active-notifications/sunset-of-universal-router-2-0-and-2-1-1): pinning either fails from 21 October 2026; 2.1.2 is the replacement.
- [Pinned OpenAPI](https://github.com/Uniswap/interface/blob/da6d36f71c4d2fd665b0aae1a052a4ffda917b31/packages/api/src/clients/trading/api.json): source schema, not blindly trusted validation.
- [Pinned route serialization](https://github.com/Uniswap/routing-api/blob/f5a81893b812b6745b1f8b7fa3a55a714cb9d89b/lib/handlers/quote/quote.ts#L568): boundary amounts and string tick spacing.
- [Pinned SDK output floor](https://github.com/Uniswap/sdks/blob/1d7d7129e1e005db8fed0c8970301470b46b68a0/sdks/router-sdk/src/entities/trade.ts#L333): multiplication by one minus tolerance.

The installed swap-integration skill 1.5.0 guides the flow. Current official
numeric chain IDs and router 2.1.2 supersede its generic string/2.0 examples.
