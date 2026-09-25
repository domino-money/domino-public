# Session contract 3.0.0-rc.4 candidate

Unreleased and disabled. This contract belongs to the backend dependency #31
of wallet UI #14. It does not change `read-v1`, connect any frontend hook,
authorize spending, or enable automation. Activation needs backend/consumer
review and separate deployment evidence.

Issue #182 removes the per-wallet admission list that #49 added. Proving
control of an address through SIWE is now the only condition this contract
places on login, and it authorizes no spending and makes no market or token
eligible for a deposit. Public read-v1 queries remain unauthenticated. Who may
reach the site at all is decided before this contract, by the shared beta
password at the edge, which is not part of it.

`challenge` has the same successful shape for every well-formed address.
Invalid signatures return `invalid_signature` (401). There is no per-wallet
denial: a well-formed address whose owner signs the issued message signs in.
A storage outage remains `session_store_unavailable` (503), never a wallet
rejection.

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

Use `X-Domino-Session-Contract: 3.0.0-rc.4`. All responses include this header and
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
anything. Its `validation` is the **last stored observation**, which can be
stale. `authenticated:true` establishes session identity, not current EOA
eligibility or transaction permission. POST `refresh` with the recovered `X-Domino-CSRF`
performs the fresh EOA check and renews idle/snapshot state. Both tabs retain
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
`account_unsupported` denotes an observed contract account; unknown code
state gives `account_check_unavailable`. `validation.method` is `plain_eoa` for
an account without code, or `eip7702_delegated` for an EOA whose code is exactly
one EIP-7702 designator (`0xef0100` and a nonzero address). The latter also
carries `delegate`, that address in lowercase. Its key still signs, so the SIWE
signature proves control either way. The session keeps the delegate it was
admitted with: when a fresh check (refresh or a protected endpoint) observes a
delegate added, changed or cleared, the server revokes the session and answers
`session_required`, and the browser signs in again. Any other code is
`account_unsupported`, as before.
Cookie/session tokens never appear in public response bodies.

This rc.4 candidate admits EIP-7702 accounts: `validation` becomes one of two
closed shapes, and consumers that matched `method: "plain_eoa"` exactly must
accept `eip7702_delegated` in the same change. Paths, requests and the error set
are unchanged. The session policy moves from `plain_eoa_v1` to
`eoa_or_7702_v1`, so every earlier session signs in once more.

The earlier 2.0.0 candidate corrected the mutating GET semantics of 1.0.0.
The 3.0.0-rc.1 and rc.2 candidates added a mandatory admission policy and
generation-bound login/session state. This rc.3 candidate removes it again:
`wallet_not_allowed` is gone from the closed error set, and `verify` can no
longer refuse an address that proved ownership. Consumers that matched that
code exhaustively must drop it in the same change. Paths and successful public
body shapes are unchanged. Pin the producer commit/digest and obtain consumer
acknowledgment before integrating; no mixed producer/Worker/consumer versions
are supported.

Apply migration 041 before this producer: it adds the stored `delegate` and
admits the new policy, and it accepts rows from the previous producer, so it can
precede the deploy. A producer from before rc.4 must not run against sessions
created under `eoa_or_7702_v1`; it treats them as inactive, which is safe.

Apply migration 027 with ingress disabled, before running this producer against
a database that has migration 011. 011's `wallet_access_session_insert` trigger
refuses a session INSERT on its own, so a producer that no longer writes an
admission generation is denied every login until 027 detaches it. 027 leaves
the `domino_wallet_access` schema, its grants and append-only audit, and the
operator role in place, unused; no code path reads them. Both
`admission_generation` columns stay, unwritten and unread. Rollback to a
producer that enforces admission needs the trigger restored and grants issued
first, or every login is refused after a valid signature. An old random-CSRF
session remains unrecoverable. Preserve the admission audit and financial
history; do not restore old sessions to make a rollback appear successful.

Regenerate with `backend/.venv/bin/python scripts/export-session-contract.py`;
CI uses `--check` and cross-language fixture/mutation tests. See the
[session runbook](../../docs/WALLET_SESSIONS.md) for lifetimes, routing,
isolation, startup and activation/rollback requirements.
See [wallet access](../../docs/WALLET_ACCESS.md) for what the retired gate was
and what replaced it, and the
[home VM handoff](../../docs/HOME_VM_RUNBOOK.md) for the selected hosting scope.
