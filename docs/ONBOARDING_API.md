# Authenticated onboarding previews — issue #38

The `onboarding-v1` 1.0.0 candidate connects SIWE sessions to the existing Uniswap
swap and LP adapters. It supplies a typed API for frontend integration, without
another liquidity formula or swap-ratio solver. A login never becomes permission
to spend. Every execution flag remains false.

The worker and private listener are **disabled by default**. No `app/` or `web/`
file, public deployment or personal-bot setting changes. The task-local branch
combines corrected session #33/#53 and preview #35/#37 dependencies, without merging into main.

## Exact browser contract

Both routes use POST JSON, the existing HttpOnly session cookie and
`X-Domino-CSRF` from login or the latest `/api/session/v1/me` response. An optional
request `X-Domino-Onboarding-Contract` must equal `1.0.0`; every response includes
that header. Success is `{"contractVersion":"1.0.0","preview":...}`. Errors are
`{"error":"fixed_code"}` with the package's declared HTTP status.

| Route | Required body | Optional body, default null |
| --- | --- | --- |
| `/api/onboarding/v1/swap-preview` | `chainId`, `tokenIn`, `tokenOut`, `amountRaw`, `slippageBps`, `maxPriceImpactBps` | None |
| `/api/onboarding/v1/position-preview` | `chainId`, `poolId`, `poolKey`, `independentToken`, `amountRaw`, `tickLower`, `tickUpper`, `slippageBps` | `budget0Raw`, `budget1Raw`, `nativeBalanceRaw`, `nativeGasReserveRaw` |

`chainId` is the integer 4663. `poolKey` preserves the read contract's
`currency0`, `currency1`, `fee_pips`, `tick_spacing`, `hooks` names. Its addresses
and full PoolId use canonical lowercase. Only existing hookless fixed-fee v4
pools are admitted. Human-price orientation and spaced ticks come from the
official frontend/SDK. Native ETH and WETH remain distinct identities.

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
| 403 `account_unsupported` | Explain current plain-EOA login scope; public reads remain separate. |
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
`/internal/onboarding/v1/{swap-preview,position-preview}`. Browser Origin, Cookie
and Authorization headers are forbidden. Its separate Access service JWT must
verify before any session DB, account RPC or Uniswap work.

The session store reserves the IP attempt, checks active session/chain/CSRF, and
reserves account/global quotas. The existing plain-EOA checker runs before the
provider. Fresh DB guards before and after provider work reject expiry, logout
and changed session credentials while a calculation is running. The final
`session-v1` 3.0.0-rc.2 authority also checks wallet admission/generation before
account RPC and again before delivery. Revocation/regrant invalidates old cookies
with `session_required`; `wallet_not_allowed` remains login verify-only after
valid possession proof. GET `/session/me` is read-only and recovers the same
CSRF for reload/two tabs; it does not renew expiry or replace the financial
request's fresh plain-EOA check. Previews and protected refresh keep CSRF stable.

| Limit | Candidate |
| --- | --- |
| Request / response | 8 KiB / 128 KiB |
| Upload | 5 seconds |
| Worker total / upstream | 25 / 20 seconds, shared absolute deadlines |
| Private listener total | 20 seconds including upload, Access, DB, account RPC and provider |
| Uniswap request | Existing 12 seconds, shortened by remaining parent budget |
| Concurrent private workers | 2, no queue, singleton listener |
| IP / account / global | 20 / 10 / 60 per 60-second window, shared by both routes |

Durable limits use keyed IP/account identifiers in the existing auth schema.
IP scope is canonical IPv4 or IPv6 /64. Multiple sessions share an account quota.
Failures retain reserved attempts; process restart does not reset them. These are
conservative development limits, not a production SLA; fixed-window bursts remain
bounded by concurrency. Timeout/disconnect retains a worker's slot until the
actual operation exits. There are no retries, cached unsigned transactions or
scheduled execution. The composed producer applies session/admission migrations008/011 alongside
the public data migrations001–007/012/013. Preview adds no new migration or
public-reader permission.

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
types, runtime validation, deterministic fixtures and producer hashes. The onboarding payload contract stays 1.0.0; inherited read-v1 rc.3 and
session-v1 3.0.0-rc.2 must be pinned from this combined producer. Session/source
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
