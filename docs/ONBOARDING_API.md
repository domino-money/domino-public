# Authenticated onboarding previews — issue #38

The `onboarding-v1` 1.1.0 candidate connects SIWE sessions to the existing Uniswap
swap and LP adapters, and routes Setup's assisted swap (`swap-route`, below). It
supplies a typed API for frontend integration, without another liquidity formula
or swap-ratio solver. A login never becomes permission to spend. Every preview's
execution flag remains false; `swap-route` returns unsigned transactions that only
the owner's wallet can sign.

The worker and private listener are **disabled by default**. No `app/` or `web/`
file, public deployment or personal-bot setting changes. The task-local branch
combines corrected session #33/#53 and preview #35/#37 dependencies, without merging into main.

## Exact browser contract

Every route uses POST JSON, the existing HttpOnly session cookie and
`X-Domino-CSRF` from login or the latest `/api/session/v1/me` response. An optional
request `X-Domino-Onboarding-Contract` must equal `1.1.0`; every response includes
that header. Success is `{"contractVersion":"1.1.0","preview":...}`. Errors are
`{"error":"fixed_code"}` with the package's declared HTTP status.

| Route | Required body | Optional body, default null |
| --- | --- | --- |
| `/api/onboarding/v1/swap-preview` | `chainId`, `tokenIn`, `tokenOut`, `amountRaw`, `slippageBps`, `maxPriceImpactBps` | None |
| `/api/onboarding/v1/position-preview` | `chainId`, `poolId`, `poolKey`, `independentToken`, `amountRaw`, `tickLower`, `tickUpper`, `slippageBps` | `budget0Raw`, `budget1Raw`, `nativeBalanceRaw`, `nativeGasReserveRaw` |
| `/api/onboarding/v1/swap-route` | `chainId`, `poolId`, `poolKey`, `tokenIn` (one of the pool's currencies), `amountRaw` (at most uint128), `slippageBps` | None |

`chainId` is the integer 4663. `poolKey` preserves the read contract's
`currency0`, `currency1`, `fee_pips`, `tick_spacing`, `hooks` names. Its addresses
and full PoolId use canonical lowercase. Only existing hookless fixed-fee v4
pools are admitted as the position's pool; a routed swap may pass through pools
with hooks. Human-price orientation and spaced ticks come from the
official frontend/SDK. Native ETH and WETH remain distinct identities.

`slippageBps` is a whole number of basis points from 10 to 500 (0.1% to 5%),
both ends included, on every route: the bound the app offers a person, and the
tolerance the position's amount caps and the swap's minimum output are drawn
with. The adapters' 0–9999 guard is the provider's, not a product limit.

Unknown fields are rejected, including browser `owner`, `recipient`, `tenant`,
provider URLs, keys, signatures and calldata. Owner/recipient always comes from
the authenticated session. Wallet/network switching still requires the
[session runbook](WALLET_SESSIONS.md) logout/account-switch behavior.

The nested `preview` preserves the existing adapter fields and units. Token
quantities are exact integer strings. `expectedDepositRaw` is a provider estimate;
`maximumDebitRaw` is the inspected encoded cap. Unspent values concern only the
selected budget. Unknown budgets, balances and gas remain null. Supplied balances
and gas reserves are **unverified**; a zero reserve does not prove adequate gas.
This reserve is native gas headroom, not an allocation of idle reinvestable fees.
Adjusted position prices are raw token1/token0, never display prices.

Swap `amountRaw` is DEX input, excluding the unselected Domino assisted-swap
tariff. Direct deposits incur no Domino setup percentage or 2% earned-fee cut.
Neither route charges fees or combines a swap and mint into an atomic operation.
See [quote semantics](FUNDING_QUOTE_PREVIEW.md) and
[position semantics](POSITION_PREVIEW.md).

## swap-route: Setup's assisted swap, routed

For a single-sided deposit, Setup swaps part of the input into the pool's other
currency. `swap-route` decides where that swap runs, on every request:

1. **The pool.** DominoSetup keeps 65 bps of the gross input for its fee
   recipient and swaps the rest in the position's own pool. The V4 quoter prices
   that net input at the node's head block. A quoter revert (too little
   liquidity, pool not initialized) means the pool returns nothing.
2. **Uniswap.** The Trading API is asked for the same exact input, owner as
   swapper and recipient, the request's slippage, Universal Router 2.1.2, V2/V3/V4
   pools with hooks admitted, and Domino's 65 bps to the same recipient as its only
   integrator fee. The fee comes out of the output instead of the input. The
   adapter refuses any answer that is not exactly that, then asks `/swap` for
   that quote's router call. Both calls together are bounded at 6 seconds,
   inside a 10-second plan.

   The provider's own simulation is not used. It runs before the allowance the
   route adds, fails for any owner who holds the input, and then the quote
   carries no router call. The Permit2 allowance is built by the backend, not
   taken from the provider, whose permit grants the router the maximum uint160
   for 30 days. Ours is the exact input, lapsing with the router call's deadline
   (30 minutes, at most an hour).
3. **The decision.** Uniswap is chosen only when the owner's output beats the
   pool's by more than 0.5% (`out × 10000 > pool × 10050`), and the owner's whole
   sequence also beats it:
   - the sequence is ERC-20 approval to Permit2, the Permit2 allowance of the
     exact input to the router, and the router's `execute`;
   - it is run through `eth_simulateV1` on the same block;
   - it must credit the owner and the fee recipient at least the quote's minimums.

   Anything else keeps the pool, including a provider timeout or error, and the
   response names the reason.

Only a `uniswap` decision carries transactions, and they are unsigned. The app
must follow this order:
1. If the input is ERC-20 and its allowance to Permit2 is below the input,
   `approve` Permit2 for the exact input.
2. Send `permitTransaction`, when present.
3. Send `swapTransaction`.
4. Call Setup `open` with both tokens.
5. Call `mint`.

Setup's own swap does not run in this path. On `pool` the flow is today's. The
schema pins the router, Permit2 and both selectors. The runtime re-derives
everything else from the amounts: the permit's four words, the pool's fee and
net input, the reason, the advantage, and which transactions exist. The
[package README](../api-contracts/onboarding-v1/README.md#swap-route) has the
field rules.

The route reads the chain through the first configured RPC. That RPC must allow
`eth_simulateV1`, and the node answers it. The route shares the listener,
quotas and error table with the previews. Without a route service the listener
answers `route_not_available`, and a node failure answers
`upstream_unavailable`.

## Freshness and errors

`requestedAt`, `retrievedAt`, `expiresAt` use Unix seconds; expiry is 30 seconds
from provider-request start. Backend and worker bind the response to the actual
request and check freshness again before delivery. Position `preparedDeadline`
does not extend that lifetime. No response refreshes itself or authorizes a
signature. `previewChecks.status` can be blocked/incomplete even with HTTP200;
`within_selected_limits` is not execution readiness.

| Response | Frontend behavior |
| --- | --- |
| 400 `invalid_request` | Correct the input against the contract. |
| 401 `session_required` | Clear private preview and use the session flow. |
| 403 `csrf_invalid` | Refresh current session/CSRF and discard the old preview; do not automatically request another signature. |
| 403 `account_unsupported` | Explain the login scope (EOAs, plain or EIP-7702 delegated; not contract wallets); public reads remain separate. |
| 409 `preview_expired` | Request a fresh preview when needed. |
| 422 `provider_request_rejected` | Preserve selection and explain unavailable input/route; do not substitute a pool. |
| 429 rate/capacity error | Honor `Retry-After: 60`; no background retry loop. |
| 502/503/504 | Preserve inputs and show unavailable data, never manufactured zero amounts. |

The package exports all exact error/status combinations. Responses are JSON,
no-store, nosniff, with random request ID and no CORS, Set-Cookie or Location
forwarding. No raw provider errors, logs of request bodies, keys, session bearers,
signatures, full addresses or IPs are introduced.

## Auth and resource boundaries

The standalone worker requires same-origin POST plus CSRF. It extracts only
`__Host-domino-session`, then constructs new allowlisted headers. Preauth/other
cookies and forged browser owner/internal identity headers are never forwarded.
The future frontend uses `credentials: 'same-origin'`; it never reads a bearer.
Cloudflare ingress supplies the client IP under the existing reviewed trust
assumptions; this worker must not be mounted on an arbitrary header-trusting host.

The private listener permits numeric-loopback clients and only
`/internal/onboarding/v1/{swap-preview,position-preview,swap-route}`. Browser Origin, Cookie
and Authorization headers are forbidden. Its separate Access service JWT must
verify before any session DB, account RPC or Uniswap work.

The session store reserves the IP attempt, checks active session/chain/CSRF, and
reserves account/global quotas. The existing EOA checker runs before the
provider. Fresh DB guards before and after provider work reject expiry, logout
and changed session credentials while a calculation is running. The final
`session-v1` 3.0.0-rc.4 authority rechecks the live session before account RPC
and again before delivery. A revoked, logged-out or expired session invalidates
old cookies with `session_required`, and so does an EIP-7702 delegate that
changed since sign-in; there is no per-wallet denial, because
3.0.0-rc.3 removed the admission list. GET `/session/me` is read-only and recovers the same
CSRF for reload/two tabs; it does not renew expiry or replace the financial
request's fresh EOA check. Previews and protected refresh keep CSRF stable.

| Limit | Candidate |
| --- | --- |
| Request / response | 8 KiB / 128 KiB |
| Upload | 5 seconds |
| Worker total / upstream | 25 / 20 seconds, shared absolute deadlines |
| Private listener total | 20 seconds including upload, Access, DB, account RPC and provider |
| Uniswap request | Existing 12 seconds, shortened by remaining parent budget |
| Concurrent private workers | 2, no queue, singleton listener |
| IP / account / global | 20 / 10 / 60 per 60-second window, shared by every route |

Durable limits use keyed IP/account identifiers in the existing auth schema.
IP scope is canonical IPv4 or IPv6 /64. Multiple sessions share an account quota.
Failures retain reserved attempts; process restart does not reset them. These are
conservative development limits, not a production SLA; fixed-window bursts remain
bounded by concurrency. Timeout/disconnect retains a worker's slot until the
actual operation exits. There are no retries, cached unsigned transactions or
scheduled execution. The composed producer applies session migrations008/011/027
alongside the public data migrations001–007/012/013; 027 detaches 011's
session-insert gate. Preview adds no new migration or public-reader permission.

## Reproduction and launch configuration

Use the merged branch's pinned Python/Node dependencies. These tests require no
API key, wallet funds or internet provider:

```sh
backend/.venv/bin/python backend/dev_postgres.py prepare-tests
DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1 backend/.venv/bin/python -m unittest discover -s backend/tests -q
backend/.venv/bin/python scripts/export-onboarding-contract.py --check
npm --prefix bridge run check
node web/node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext api-contracts/onboarding-v1/consumer.typecheck.mts
backend/.venv/bin/python backend/dev_postgres.py stop
```

The HTTP flow test signs SIWE with a synthetic test key, uses the real session
store/listeners and actual adapters with synthetic provider responses, and blocks
external HTTP. It is not real HTTPS/Cloudflare staging evidence.

`backend/.venv/bin/python backend/onboarding_api.py` starts only the disabled
loopback listener on port8880 and reads no credential/RPC/DB configuration. A
separate private lock is under `backend/runtime/onboarding/`; existing personal,
read and session ports are excluded. Multiple configured workers are rejected.

Eventual operator enablement uses `--enable --rpc-config <private-file>
--uniswap-config <private-file>`. Owned-file/0600 loaders remain enforced; keys
are not argument values. Use the **same session database**, persistent
`DOMINO_SESSION_ABUSE_SECRET` and `DOMINO_SESSION_ORIGIN` as login. Additional
settings are `DOMINO_ONBOARDING_ACCESS_ISSUER`,
`DOMINO_ONBOARDING_ACCESS_AUDIENCE`, `DOMINO_ONBOARDING_ACCESS_SERVICE_ID`.
Provision onboarding ingress separately from read/session Access identities.

`bridge/wrangler.onboarding.example.toml` is non-deploying: flags false, no route,
workers.dev/preview URLs off. Its proposed hostname is not provisioned. Future
worker settings are `APP_ORIGIN`, `ONBOARDING_GATEWAY_ORIGIN` and secret-store
`ONBOARDING_ACCESS_CLIENT_ID` / `ONBOARDING_ACCESS_CLIENT_SECRET`.

## Handoff, activation and rollback

[Execution policy](EXECUTION_POLICY.md) supersedes historical owner, ACK and
approval procedures here. Any authorized collaborator or agent may implement
and operate within scope, recording results alongside or after execution.
Technical controls, compatibility evidence and wallet consent still apply.

The [shared package](../api-contracts/onboarding-v1/README.md) includes schemas,
types, runtime validation, deterministic fixtures and producer hashes. The onboarding payload contract is 1.1.0 (swap-route added, the previews unchanged); inherited read-v1 rc.3 and
session-v1 3.0.0-rc.4 must be pinned from this combined producer. Session/source
manifest hashes change with the composed private authorization methods. Any
authorized collaborator may integrate amount/range/review hooks and run rendering
tests; validator tests alone do not establish the actual consumer behavior.

Validate version/digest, hooks and null/error/expiry handling; record consumer
evidence alongside or after delivery under [API_COMPATIBILITY.md](API_COMPATIBILITY.md). Staging
must verify HTTPS cookies, exact origin/routes, separate Access audiences,
trusted client-IP metadata, singleton/quota behavior, redacted logging and
provider capacity. Cloudflare credentials for domino.money remain deferred.
Preserve the security validation scenarios in the existing spec. External review
may supplement that evidence; it is not a permission gate under EXECUTION_POLICY.md,
and no external audit may be claimed without its actual report.

Rollback disables the onboarding worker/listener and restores matching consumer,
producer and contract builds. Login/public reads can remain available. This
feature does not migrate session data, rotate credentials or authorize financial
operations. Signing, broadcast and receipt reconciliation remain separate work.
