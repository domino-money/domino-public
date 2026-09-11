# Session contract 2.0.0 candidate

Unreleased and disabled. This contract belongs to the backend dependency #31
of wallet UI #14. It does not change `read-v1`, connect any frontend hook,
authorize spending, or enable automation. Activation needs backend/consumer
review and separate deployment evidence.

`types.ts` and `schemas/` are generated from the Python session models;
`runtime.mjs` validates strict browser JSON without dependencies. The BFF uses
it to enforce requests and public results and to strip the private cookie
directives from internal auth responses. `manifest.json` binds the source,
schemas, types, validators and model-validated fixtures. The fixtures use an
explicit public test scalar, reserved `.invalid` origin, fixed times and
synthetic credentials. They cannot log in to any running session service.

| Browser endpoint | Request | Result |
| --- | --- | --- |
| `POST /api/session/v1/bootstrap` | `{}` | Pre-login CSRF token and expiry; HttpOnly preauth cookie |
| `POST /api/session/v1/challenge` | `{address, chainId: 4663}` | Exact server-issued `message`, `challengeId`, `expiresAt` |
| `POST /api/session/v1/verify` | `{challengeId, message, signature}` | Verified owner, absolute session expiry, CSRF and code-check snapshot; HttpOnly session cookie |
| `GET /api/session/v1/me` | No body or query | Stored session identity, stable recoverable CSRF and last stored code-check snapshot; no mutation |
| `POST /api/session/v1/refresh` | `{}` | Fresh code-check snapshot and renewed idle deadline; same CSRF and absolute expiry |
| `POST /api/session/v1/logout` | `{}` | `{authenticated:false}` after durable revocation; clears both cookies |

POST needs exact `Origin`, JSON and same-origin Fetch Metadata when available.
Challenge, verify, refresh and logout require `X-Domino-CSRF` bound to the caller's
preauth/session. Cookies must be sent with same-origin fetch credentials; do
not copy them into JavaScript storage. Login signatures and messages belong
only in the active sign-in flow, never telemetry.

Use `X-Domino-Session-Contract: 2.0.0`. All responses include this header and
`Cache-Control: no-store`. The version is independent of `read-v1`. Bodies are
closed: unknown fields, alternate chains, guessed owner/role/session selectors,
duplicate JSON keys and coerced scalars are invalid. A message is at most 2048
UTF-8 bytes, and the initial signature is exactly 65 bytes (`0x` plus 130 hex
characters). Returned owner addresses are lowercase; SIWE addresses use EIP-55.
Block numbers are canonical decimal strings up to 20 digits. Timestamps are
valid UTC RFC3339 strings ending in `Z`.

On reload, GET `me` with the HttpOnly session cookie and no old CSRF. It reads
stored identity and recovers the same session-bound CSRF without rotating it,
renewing idle expiry, reserving quota, cleaning records, checking RPC or revoking
anything. Its `validation` is the **last stored observation**, which can be stale;
`authenticated:true` establishes session identity, not current EOA eligibility
or transaction permission. POST `refresh` with the recovered `X-Domino-CSRF`
performs the fresh plain-EOA check and renews idle/snapshot state. Both tabs retain
the same CSRF; neither refresh invalidates an in-flight write in the other tab.
Protected preview/deposit endpoints must still reauthorize session+CSRF and make
their own fresh checks. Never use `me` as that guard.

A `csrf_invalid` response never triggers an automatic signature. Re-read `me`
for a known session; `session_required` requires sign-in, whereas unavailable
storage is a retryable unavailable state. Clear the active private view on
wallet account/network change and require login for the new identity; the server
authorizes only its existing session identity until then.
Do not relabel practice cards as live holdings.

Bootstrap and verify refuse to replace a presented active session
(`session_exists`). Complete logout before signing in to a different identity;
this avoids cross-tab replacement/logout races. Expired/inactive session cookies
can be replaced by successful verification. Logout can
also abort a pending login with its own preauth cookie/CSRF; it revokes a
session created by that exact context if verification raced with logout.
After a lost verify response, first try `me`: if the HttpOnly session cookie
was applied, it recovers the session without replaying the used signature.
Otherwise abort with the original preauth/CSRF while valid, then start sign-in. A successful logout is confirmed by server state, not cookie removal
alone. Logout does not require a working chain RPC.

`fixtures/errors.json` is the finite status/code map. Treat unavailable storage
or account code reads as unavailable, not as a logged-out or unsupported wallet.
`account_unsupported` denotes an observed code-bearing account; unknown code
state gives `account_check_unavailable`. The initial method is `plain_eoa` only.
Cookie/session tokens never appear in public response bodies.

This replaces the unreleased 1.0.0 candidate's mutating GET semantics. The
family/path stays `session-v1`; the header/manifest semantic version is 2.0.0.
Freeze a new producer digest and consumer acknowledgement together. With all
session and authenticated consumer ingress disabled, revoke old sessions and
preauth/challenges before changing versions; do not run mixed 1.0.0/2.0.0 workers.
An old random-CSRF session cannot be recovered by `me` and fails closed as
`session_required` without modifying its hash. No automatic migration or
production revocation is performed by this candidate. See rollout controls in
the runbook before any activation.

Regenerate with `backend/.venv/bin/python scripts/export-session-contract.py`;
CI uses `--check` and cross-language fixture/mutation tests. See the
[session runbook](../../docs/WALLET_SESSIONS.md) for lifetimes, routing,
isolation, startup and activation/rollback requirements.
