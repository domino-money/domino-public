# Onboarding v1 — disabled candidate

Contract version **1.0.0**, independent of `read-v1` and `session-v1`. This is a
preview boundary, not a transaction or automation API. Do not connect production
hooks until the frontend owner acknowledges the issue/PR handoff and staging gates pass.

Both POST routes accept JSON and use the same-origin session cookie and
`X-Domino-CSRF` header. The backend derives the owner from the authenticated
session. Request bodies cannot supply owner, recipient, tenant, signatures or
provider configuration. Responses carry `X-Domino-Onboarding-Contract: 1.0.0`
and `{ "contractVersion": "1.0.0", "preview": ... }`.

| Route | Request | Response |
| --- | --- | --- |
| `/api/onboarding/v1/swap-preview` | Exact input, currencies, slippage and impact limits | Full safe `UniswapQuote.preview` projection |
| `/api/onboarding/v1/position-preview` | Existing PoolId/PoolKey, spaced ticks, independent amount and optional budgets | Full safe `UniswapPosition.preview` projection |

Field names inside `preview` are preserved from the backend adapters. Both
responses have Unix-second `requestedAt`, `retrievedAt`, `expiresAt`; the preview
expires 30 seconds after request start. `preparedDeadline` on a position is
provider preparation metadata, never permission to execute an expired preview.
No calldata, transaction, permit, API key or session bearer is returned.

`slippageBps` on both requests is a whole number of basis points from 10 to 500
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
