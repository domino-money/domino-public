# Onboarding v1 — disabled candidate

Contract version **1.1.0**, independent of `read-v1` and `session-v1`. Previews
never execute; `swap-route` alone returns unsigned transactions, for the wallet
to review and sign (below). Nothing here signs, sends or automates. Do not connect production
hooks until the frontend owner acknowledges the issue/PR handoff and staging gates pass.

Every POST route accepts JSON and use the same-origin session cookie and
`X-Domino-CSRF` header. The backend derives the owner from the authenticated
session. Request bodies cannot supply owner, recipient, tenant, signatures or
provider configuration. Responses carry `X-Domino-Onboarding-Contract: 1.1.0`
and `{ "contractVersion": "1.1.0", "preview": ... }`.

| Route | Request | Response |
| --- | --- | --- |
| `/api/onboarding/v1/swap-preview` | Exact input, currencies, slippage and impact limits | Full safe `UniswapQuote.preview` projection |
| `/api/onboarding/v1/position-preview` | Existing PoolId/PoolKey, spaced ticks, independent amount and optional budgets | Full safe `UniswapPosition.preview` projection |
| `/api/onboarding/v1/swap-route` | Existing PoolId/PoolKey, input currency (one of the pool's), exact input, slippage | Setup's assisted swap routed: the pool, or Uniswap's router with its unsigned transactions |

Field names inside `preview` are preserved from the backend adapters. Every
response has Unix-second `requestedAt`, `retrievedAt`, `expiresAt`; the preview
expires 30 seconds after request start. `preparedDeadline` on a position is
provider preparation metadata, never permission to execute an expired preview.
The two previews return no calldata, transaction or permit, and no route returns
an API key or session bearer.

`slippageBps` on every request is a whole number of basis points from 10 to 500
(0.1% to 5%), both ends included: the bound the app offers a person, checked by
the request models and this runtime alike. The provider adapters keep a wider
0–9999 guard of their own; it is not a product limit, and nothing past this
bound reaches them.

Raw amounts are canonical integer strings, never JavaScript numbers. Nullable
budgets, prices, gas observations and checks retain their meaning; unavailable
is not zero. Position `expectedDepositRaw` is distinct from `maximumDebitRaw`;
only the latter is the inspected upper debit limit. `adjustedPrices` uses raw
token1/token0 units and is not a human token price. No LP math is implemented here.
Swap tariff remains unselected; direct deposits have no Domino setup percentage.
Every `executionAvailable` flag remains false, even when observed limits pass.

`previewChecks` on a position is derived, not declared: runtime validation
recomputes `reasons` from the response's own fields and refuses any array that
differs, order included. Blocked reasons come first — `token{i}_maximum_exceeds_budget`
per token in index order, then `native_deposit_exceeds_balance` when
`nativeFunding.depositMaximumRaw` exceeds `reportedBalanceRaw`, then
`native_gas_reserve_exceeded` when that deposit plus `selectedGasReserveRaw`
does — then the incomplete ones: `token{i}_budget_unknown` in index order,
`native_balance_unknown` and `native_gas_reserve_unspecified` for a null balance
or reserve. A null balance excludes the exceeds-balance reason instead of adding
one. `status` follows from the array: `blocked` when a reason ends in `_exceeded`,
`_exceeds_budget` or `_exceeds_balance`, `incomplete` when other reasons remain,
`within_selected_limits` when none do; duplicates are refused. Every one of these,
and any value that makes the derivation throw, reaches the caller as a bare
`false` from `validateResponse` — the same answer a schema violation gives.

## swap-route

Setup's assisted swap, for a position's single-sided deposit, routed where it
returns the owner more. The default is the chosen pool: DominoSetup keeps
`assistedSwapFeeBps` (65) of the gross input for `feeRecipient` and swaps the rest
there, quoted by Uniswap's V4 quoter at `block`. Uniswap's Trading API is asked
for the same exact input with the same 65 bps as its only integrator fee, to the
same recipient, and may route through pools with hooks; the position's own pool
stays hookless. `decision` is `uniswap` only when all of these hold:

- the owner's quoted output beats the pool's by more than `thresholdBps` (50,
  0.5%): `amountOut × 10000 > pool × 10050`;
- the owner's whole sequence (the Permit2 approval, the Permit2 allowance, the
  router's execute) simulates on the chain's node at that block, credits the
  owner and the fee recipient at least the quote's minimums, and still beats
  the pool by more than the threshold.

Otherwise `decision` is `pool`, with the reason: `pool_within_threshold`,
`uniswap_simulation_failed`, or `uniswap_quote_unavailable` / `_rejected` /
`_invalid` when the provider gave no usable answer (then `uniswap` and
`advantageBps` are null). A pool the quoter cannot fill reports
`pool.amountOutRaw` `"0"`: any route that simulates beats it, and a `pool`
decision over it means no route can fill the swap. `advantageBps` is the floored
basis points of the owner's output (simulated when present, else quoted) above
the pool's, capped at 10^12 (the cap, too, when the pool returns nothing).

Only a `uniswap` decision carries transactions, all unsigned and from the owner:
`approval` (ERC-20 `approve` of the exact input to Permit2; null for native
input), `permitTransaction` (Permit2 `approve` of the exact input to the router;
null for native input) and `swapTransaction` (Universal Router 2.1.2 `execute`, with the exact input as
`value` for native input). The backend builds the Permit2 allowance itself:
the exact input, lapsing with the router call's own deadline, at most an hour
away. Uniswap's own permit transaction, which grants the router the maximum
uint160 for 30 days, is never passed on. No gas limit is given: the wallet or the
batch simulation estimates it (Uniswap's `/swap` answers a fixed 650,000, which a
large route exceeds). The schema pins the router, Permit2 and both
selectors; the runtime also reads the permit's four words (this token, the
router, the exact input, an expiry after the request and at most an hour past
the route's expiry) and recomputes the pool's fee and net input, the reason, the
advantage and which transactions exist from the amounts. A disagreement is a
bare `false`, as elsewhere. After the routed swap the owner deposits both
tokens through Setup with no Setup swap; Setup's own swap runs only on `pool`.

Import `runtime.mjs` for closed-shape validation and `types.ts` for types. Runtime
validation uses the exported schemas plus semantic range/status/amount checks.
The Python backend additionally recomputes Keccak PoolId from the PoolKey; the
browser validator is not a substitute for that check. The Worker rejects
noncanonical/exponent/fraction JSON number lexemes before runtime validation.
Unknown properties and unrecognized error codes fail closed.

Regenerate with `backend/.venv/bin/python scripts/export-onboarding-contract.py`;
use `--check` to detect drift. `fixtures/` are produced through synthetic adapter
transports; they make no network calls and contain no funded wallet or credential.
The manifest binds schemas, runtime, types, fixtures and producer source hashes.

Type-check the compile-only consumer sample with the existing pinned web tooling:
`node web/node_modules/typescript/bin/tsc --noEmit --strict --target es2022 --module nodenext --moduleResolution nodenext api-contracts/onboarding-v1/consumer.typecheck.mts`.
It verifies nullable raw strings, owner exclusion and non-executable response types.
