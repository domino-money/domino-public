# Domino read, session, onboarding and deposit BFF candidates

Issue #40 adds `src/deposit-worker.mjs`, a disabled owner-signed direct-deposit
transport with a separate `deposit-v1` contract and Access identity. It shares
bounded authenticated transport with onboarding, preserves read/session payloads
and performs no signing or broadcast. See the
[deposit runbook](../docs/DIRECT_DEPOSITS.md) and
[shared package](../api-contracts/deposit-v1/README.md). No frontend hook or
deployment route is activated. The new shared transport is covered by both the
existing onboarding and new deposit tests.

The isolated `src/onboarding-worker.mjs` adds disabled, session-bound swap and
position previews for #38. Its `onboarding-v1` contract, routes, Access identity
and limits are separate; read/session capabilities and payloads do not change.
See the [onboarding runbook](../docs/ONBOARDING_API.md) and
[shared package](../api-contracts/onboarding-v1/README.md). No app hook or
deployment route is activated by this source candidate.

The separate, disabled `src/session-worker.mjs` now implements the session
transport for backend #31/frontend #14. It has its own routes, Access identity,
auth listener and private storage; it does not add session routes to the reader.
See the [session contract](../api-contracts/session-v1/README.md) and
[session runbook](../docs/WALLET_SESSIONS.md). The sections below describe the
unchanged **read Worker** only.

This directory contains an undeployed Cloudflare Worker candidate for contract
`read-v1` / `1.1.0-rc.3`. Live reads default to **disabled**. It has no wallet session,
private account, signer, transaction or automation routes. It does not change
the web app or its existing practice endpoints.

The Worker uses native Fetch, Streams, AbortController and Web Crypto APIs;
there are no runtime npm dependencies. Its source imports the shared contract
version, per-route response versions, runtime validator and finite error table from
[`api-contracts/read-v1/runtime.mjs`](../api-contracts/read-v1/runtime.mjs).
Keep that package alongside `bridge/` when bundling.

## Offline checks

From the repository root:

```sh
npm --prefix bridge run check
```

This runs JavaScript syntax checks and Node's built-in test runner. Tests use
synthetic gateway responses, synthetic service credentials, reserved `.invalid`
hosts and reserved documentation IPs. There are no network/provider calls,
deployments, credentials to obtain or extra packages to install. Tests inject
transport through `createWorker({ fetch, getClientIp })`; this does not bypass
environment flags, origin checks, schemas or budgets. Clock tests use Node's
test-only fake timers, leaving production deadlines fixed.

The shared fixture consumer covers producer success/missing/zero/partial/stale
states, safe errors, version rejection and gateway capabilities/cursor fixtures.
The authenticated Python gateway owns cursor replacement. Both gateway and BFF
validate full response schemas. The BFF also checks UTF-8/JSON syntax, duplicate
keys, bounded response bytes, contract and schema versions, chain ID, and exact
error envelopes. Tests use complete shared producer fixtures for successful fake
responses and reject missing fields, nested contract drift and live execution
flags. These are transport/contract tests, not frontend rendering tests.

## Route and request contract

| Browser route | Fixed gateway path |
| --- | --- |
| `POST /api/read/v1/token` | `/internal/read/v1/token` |
| `POST /api/read/v1/pools` | `/internal/read/v1/pools` |
| `POST /api/read/v1/pool-market` | `/internal/read/v1/pool-market` |
| `POST /api/read/v1/wallet-assets` | `/internal/read/v1/wallet-assets` |
| `POST /api/read/v1/nft-positions` | `/internal/read/v1/nft-positions` |
| `POST /api/read/v1/catalogue` | `/internal/read/v1/catalogue` |
| `POST /api/read/v1/pool-activity` | `/internal/read/v1/pool-activity` |
| `POST /api/read/v1/pool-positions` | `/internal/read/v1/pool-positions` |
| `POST /api/read/v1/pool-metrics` | `/internal/read/v1/pool-metrics` |
| `GET /api/read/v1/capabilities` | Local response; no upstream call |

Only these exact paths/methods are handled. Query strings, encoded suffixes,
extra path components, all other read routes, sessions, writes, health and
OpenAPI paths are rejected. An unknown route never selects a network destination.
Mount only `/api/read/v1/*` on the eventual application origin; routing the
entire app to this standalone Worker would intercept unrelated pages/APIs.

POST requires the exact configured HTTPS `Origin`. Capabilities GET permits an
absent Origin but rejects any other origin. The actual request URL origin must
also equal the configuration; a supplied Host must match. Fetch Metadata, when
present, must indicate same origin, a fetch mode (`cors` or `same-origin`) and an
empty destination. Browser navigation and cross-site/sibling requests fail.
These headers reduce browser abuse and do not authenticate wallets or users.

Sensitive header values are matched exactly; combined duplicate values fail
instead of selecting one. Fetch's Headers abstraction combines repeated values;
the ingress platform must also reject malformed HTTP framing before creating a
Request. URL parsing/normalization is platform-owned; the Worker can inspect
only the request URL delivered by that platform, and still selects from a fixed
destination map.

JSON requests are limited to 8,192 streamed UTF-8 bytes and five seconds of
upload time. Only identity Content-Encoding and `application/json` (optionally
UTF-8 charset) are accepted. Invalid UTF-8/BOM, duplicate object keys including
escaped equivalents, non-finite numbers, unknown fields, alternate chain/URL/RPC
selectors and wrong scalar types are rejected. Request validation enforces the
ten-token fallback, twenty-pool check, ten explicit-pool ID, distinct uint256
NFT ID and JavaScript-safe nonnegative block/revision limits. Number lexemes and original validated JSON text
are retained while unsafe block/revision integers are rejected before forwarding.

The optional browser `X-Domino-Read-Contract` header must equal `1.1.0-rc.3` when
supplied. Every BFF response includes that version and its own random UUID in
`X-Domino-Request-Id`. The gateway must emit the exact contract header on success
and safe errors; absent/combined/different versions fail closed.

## Upstream boundary and limits

The Worker constructs a new POST to its configured gateway origin and fixed
internal path. It sends only Content-Type, the pinned contract header,
`CF-Access-Client-Id`, `CF-Access-Client-Secret`, and `X-Domino-Client-Id` from
trusted edge metadata. Browser Cookie, Authorization, Origin, Forwarded,
X-Forwarded, Access assertions and arbitrary headers are never forwarded.
Incoming client identifiers and Access credentials cannot override server values.

The production adapter reads only Cloudflare's `CF-Connecting-IP` ingress value,
validates a bounded IPv4/IPv6 literal and passes it as `X-Domino-Client-Id`.
The gateway hashes that identifier with its server secret before budgeting.
This header is trustworthy **only behind the reviewed ingress path: the
`domino-app` production Pages Function and its private Worker service binding**.
An arbitrary Node server or a direct test Request cannot prove that it came from
connection metadata. The ingress path must exclude paths through untrusted
same-zone Workers/subrequests that can alter the effective client identity, and
its Cloudflare client-IP settings must be verified in staging. Never expose the
test factory as an HTTP configuration surface or trust a browser-selected ID.

The gateway is responsible for validating the actual Access Service Auth JWT,
its fixed issuer/audience/signature/expiry/service identity, central IP/global
admission, single-process topology, full response schemas, reader deadlines,
and opaque cursor bindings. Presence of the two service headers alone is not
proof of authenticated ingress. The existing loopback reader's Origin/Host
restrictions remain enforced by that reader.

One request has a maximum twenty-second total budget. Upstream fetch and response
streaming share at most fifteen seconds, reduced by any remaining total budget.
There are no retries or redirect following. Timeout/disconnect aborts the native
fetch; an explicit race also bounds a transport that ignores cancellation.
Absolute expiry is also checked after awaited operations, decoding, parsing and
validation, and before returning success; a delayed timer callback cannot allow
late data through. This cannot establish that remote work stopped: the
gateway/reader must retain admission for the actual work lifetime.

Upstream output is limited to 1 MiB while streaming. The gateway must send
identity-encoded JSON; encoded output is rejected to avoid runtime decompression
ambiguity. Depth/node bounds additionally protect the JSON parser. Successful
JSON text and field names remain unchanged; the gateway owns replacement of
the internal inventory cursor. The Worker performs no HTML rendering, metadata
URL fetch, raw-amount coercion or price/APR repair.

All browser responses are JSON, `Cache-Control: no-store` and `nosniff`, with no
CORS permission. Cookies, Location and upstream diagnostic headers are dropped.
Only shared finite error codes with their exact status pass through. Unknown
errors and infrastructure login redirects/401/403 become sanitized availability
errors; they do not initiate wallet sign-in. Rate-limit `Retry-After` is normalized
to an integer from 1–60 seconds, defaulting to 1. Errors never echo input,
upstream bodies, headers, credentials or stack traces. This implementation logs
no bodies, addresses, IPs, cursors, credentials or other diagnostics.

## Disabled example configuration

[`wrangler.example.toml`](wrangler.example.toml) is a non-deploying example with
live reads off, no real routes, and both workers.dev/preview URLs off.
`https://domino.money` is the user-selected app origin. This historical example
still uses `https://read-origin.domino.money`; the selected staging candidate is
[`wrangler.read.toml`](wrangler.read.toml), with `https://vm-read.domino.money`.
Neither hostname is established as provisioned or qualified by these files.
Historical examples, implementation reports and test fixture hosts are not
deployment inputs. The file does not connect DNS,
provision a Worker, configure Access or run a deployment. Cloudflare credentials
and actual staging are deferred. The candidate's source entry is `src/worker.mjs`.

| Setting | Meaning |
| --- | --- |
| `APP_ORIGIN` | Required exact HTTPS origin; no trailing slash, path, query or userinfo |
| `READ_BRIDGE_ENABLED` | Only the exact string `true` enables reads; all other values disable them |
| `ENABLED_READS` | When enabled, nonempty comma-separated allowlisted suffixes; no spaces/duplicates |
| `GATEWAY_ORIGIN` | When enabled, separate exact HTTPS origin; no arbitrary URL/path |
| `ACCESS_CLIENT_ID` | When enabled, environment-specific Worker secret |
| `ACCESS_CLIENT_SECRET` | When enabled, environment-specific Worker secret |

Invalid active configuration returns a safe 503 and never contacts the gateway.
When reads are disabled, gateway credentials/configuration are not needed;
capabilities reports `dataMode: disabled`, an empty `enabledReads`, chain 4663,
and all authentication/private-account/owner-transaction/automation flags false.
Rollback sets `READ_BRIDGE_ENABLED` to `false`; capabilities then explicitly
announces unavailable reads and POST routes stop dispatching.

## Separate release evidence

This candidate and offline tests do not establish deployed isolation, actual
Service Auth claims, trusted client-IP metadata, origin/routing/edge logs,
cohort admission or measured provider capacity. Real activation still needs the
documented independent staging gate covering app pages and `/api/*`, no alternate
hostname bypass, Access/Tunnel/secret rotation and outage drills, tested log
redaction/retention, load evidence and frontend/backend acknowledgement.
Frontend hooks, adapters and live flags in the web app are owned by the separate
frontend task and are untouched here. See
[`API_READ_BRIDGE.md`](../docs/API_READ_BRIDGE.md),
[`API_READ_BRIDGE_TEST_PLAN.md`](../docs/API_READ_BRIDGE_TEST_PLAN.md), and
[`API_COMPATIBILITY.md`](../docs/API_COMPATIBILITY.md).

The [next candidate notice](../docs/READ_CONTRACT_CANDIDATE_1_1.md) defines the nine-route consumer handoff.


## Selected disabled staging configuration

The four concrete `wrangler.read.toml`, `wrangler.session.toml`,
`wrangler.onboarding.toml` and `wrangler.deposit.toml` files use the selected
`domino.money`/`vm-*` origins, all flags false, no public routes or preview URLs,
and disabled observability/Logpush. They do not provision Cloudflare resources or
Pages bindings. Decimal owns the reviewed Pages gate/host-check/API forwarder and
its later service-binding PR. Deposit secrets/Access/Tunnel are deferred.

Run `python3 scripts/staging/check_bridge_configs.py` from the repository root to
check the disabled configuration boundary offline. Changing that boundary needs
an explicit reviewed release; passing the check says nothing about remote
resources, old deployments, allowed binding callers or trusted client IP. See
[the staging handoff](../docs/STAGING_BACKEND_HANDOFF.md) and
[the cloudflared unit](../docs/CLOUDFLARED_STAGING.md).
