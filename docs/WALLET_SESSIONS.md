# Wallet sessions: backend candidate and integration runbook

10 September 2026 · Backend [#31](https://github.com/domino-money/domino/issues/31),
frontend dependency [#14](https://github.com/domino-money/domino/issues/14)

This candidate implements wallet login independently of public reads. It is
disabled, undeployed, and not connected to `app/` or `web/`. It gives no token
approval, NFT permission, deposit, swap, withdrawal, compound or Domino authority.
There is no private portfolio/settings API in this release. The verified owner
context is a prerequisite for that later work; public NFT ownership stays public
snapshot data and practice positions stay browser-local simulations.

Issue #182 removes the [wallet admission](WALLET_ACCESS.md) that #49 had added,
raising this disabled candidate to `session-v1` **3.0.0-rc.3**. There is no
allowlist: proving control of an address through SIWE is the only condition on
login, and `wallet_not_allowed` is gone from the closed error set. Public reads
remain unauthenticated, as they always were, and who may reach the site at all
is still decided before this contract by the shared beta password at the edge.
Well-formed challenge requests are uniform; unsigned requests never consume a
target wallet's shared quota. Successful response shapes and the read-only
GET/protected POST separation stay unchanged. See the linked runbook for
migration 027, which must run before this producer meets a database that has
011.

EIP-7702 accounts may sign in from `session-v1` **3.0.0-rc.4**. An EOA whose
code is exactly one EIP-7702 designator still signs with its own key, which is
what SIWE proves, so the policy `eoa_or_7702_v1` admits it next to the plain
EOA. The session keeps the delegate it was admitted with, and a later check that
observes another one revokes it for a fresh sign-in. Migration 041 must run
before this producer; see [Delegated accounts (EIP-7702)](#delegated-accounts-eip-7702).

## Components and fixed traffic boundaries

```text
same-origin browser /api/session/v1/*
  -> separate disabled session Worker
  -> HTTPS Access Service Auth + Tunnel (separate auth audience/identity)
  -> loopback 127.0.0.1:8879 /internal/session/v1/*
  -> private PostgreSQL schema + fresh read-only Robinhood account-code check
```

`bridge/src/session-worker.mjs` handles only the six session paths. It sends
named preauth/session credentials, CSRF, the checked canonical browser origin
and trusted connection IP to `backend/session_api.py`. The listener verifies
the Access JWT signature, issuer, audience, service ID and expiry before auth
work. Neither unrestricted Cookie/Authorization headers nor caller-selected
identity headers are forwarded. The public reader and read gateway receive no
session data. No browser request selects an upstream URL or SQL role.

The Worker accepts only its configured HTTPS application origin. POST requires
exact Origin; GET `me` allows absent Origin but rejects a different one. Fetch
Metadata, when supplied, must describe a same-origin fetch and empty destination.
SameSite is additional protection, not the sole CSRF control. The ingress must
preserve these properties and authoritative Cloudflare client-IP metadata; an
arbitrary server that trusts a user-supplied `CF-Connecting-IP` is not equivalent.

The BFF and listener reject duplicate JSON keys, extra fields and encoded bodies.
POST bodies are limited to 8192 streamed bytes and five seconds; total requests
have twenty seconds, with at most fifteen for the BFF's auth fetch/response.
Responses are limited to 16 KiB at the BFF. Cancellation/timeout retains the
Python worker slot until the actual operation finishes. Four worker slots,
single-process listener, bounded SQL timeouts and no work queue limit this alpha
implementation. This is a measured-bounds design, not a public traffic SLA.

## SIWE and account support

The server issues the exact HTTPS-origin/domain, EIP-55 address, chain 4663,
32-hex-character nonce, issuance/expiry and a fixed sign-in-only statement. The
stored challenge and the browser's preauth/CSRF context must match. Message
substitution, another address/chain/context, unexpected fields, expiry and replay
are rejected even if the replacement has a mathematically valid signature.

`session_siwe.py` uses the official `siwe==4.4.0` ABNF parser/serializer and
`eth-account==0.13.7` local EIP-191 recovery. It deliberately does not call the
library's optional Web3/contract-signature verification path. The tested lock
pins `abnf==2.2.0`: the resolver's newer 2.9.0 parser rejects this SIWE grammar
at import. Dependency upgrades must rerun the exact-version synthetic tests;
these pins and code review do not constitute an external audit.
[SIWE source](https://github.com/spruceid/siwe-py),
[ERC-4361](https://eips.ethereum.org/EIPS/eip-4361).

EOAs are admitted: an account with no code (`plain_eoa`), or one whose code is
exactly one EIP-7702 designator, `0xef0100` followed by a nonzero address
(`eip7702_delegated`, reported with that `delegate`). A fresh check verifies
chain, a recent block, account code at that numeric block, and the canonical
block/chain again. Failover must prove the same chain/block; it cannot change an
already observed snapshot. Any other code is a contract account and is
unsupported, as is a designator one byte short or long, with another prefix or
naming the zero address. Counterfactual signatures and ERC-1271 verification are
not implemented: a delegated account still signs SIWE with its own key, and the
65-byte signature limit stays. Unknown code, stale or changed snapshots and
exhausted reads fail closed. No wallet brand establishes account type. A code
read alone is not login.
[ERC-1271](https://eips.ethereum.org/EIPS/eip-1271),
[EIP-7702](https://eips.ethereum.org/EIPS/eip-7702).

The account check has a nested ten-second/16-request ceiling and permits block
age at most 120 seconds, with at most fifteen seconds of future clock skew.
Every protected POST `refresh` rereads code and then reauthorizes the same
stored session before touching it. GET `me` only returns stored identity and the
last stored code snapshot; it never claims a fresh account check or grants
transaction authority. During refresh, canonical contract code revokes that
session (`account_unsupported`), and so does an account whose delegate differs
from the one it was admitted with: a delegate added, changed or cleared answers
`session_required` after the revocation commits. The protected preview,
deposit, performance and execution-status endpoints apply the same rule through
the shared store. An unavailable check denies the request without converting it
into an unsupported-wallet claim or silently deleting a still-valid session. The
policy is `eoa_or_7702_v1`; a future policy change requires a migration and
reauthentication.

## Durable state, expiry and logout

Migration `008_wallet_sessions.sql` creates `domino_sessions`, separate from the
public catalogue. `domino_session_auth` has only schema usage and auth-table
DML. Catalogue reader/writer roles have no access. This is authentication storage,
not the candidate tenant-ledger schema and not proof of future tenant-object RLS.

Opaque cookie tokens and preauth CSRF tokens are random 256-bit values.
Authenticated CSRF is base64url HMAC-SHA256, keyed by the opaque session bearer
with domain context `domino/session-csrf/v2`. Only SHA-256 hashes are stored.
This one-way derived CSRF is recoverable on reload with the HttpOnly cookie,
stable across tabs/restarts and independent of abuse-secret rotation; it cannot
be used to reconstruct the bearer. A newly minted session has a new CSRF. Rate
keys use a server-secret HMAC, not plain IPs or enumerable address hashes. SIWE messages contain public addresses, nonce and
times; signatures and bearer tokens are not stored. No positive session cache
can survive logout or a restart. Short transactions use a shared advisory lock;
signature verification and RPC calls run outside it. The database clock controls
expiry, including a final guard before committing authentication mutations.

| State/control | Limit |
| --- | --- |
| Preauth cookie/context | 10 minutes |
| Challenge | Up to 5 minutes, never beyond preauth expiry |
| Verification attempts | 5 per challenge, atomically reserved |
| Session | 12 hours absolute; 30 minutes idle |
| Bootstrap + challenge issuance | Shared 5/minute/trusted IP |
| Successful ownership proof before EOA RPC | 20/hour/proven wallet |
| Bootstrap + challenge issuance globally | Shared 100/minute |
| Verification globally | 200/minute |
| Verification | 10/minute/trusted IP |
| Protected session refresh | 30/minute, burst 5 per IP and verified account |

These limits are abuse controls, not proof that an anonymous requester owns an
address. IPv4-mapped IPv6 is normalized to IPv4; other IPv6 addresses share a
/64 abuse scope so interface-address rotation cannot reset limits. Expected
denials commit attempt/rate reservations. Saturation returns a
fixed 429 rather than evicting live security records. Each transaction performs
indexed cleanup in batches of at most 100 per cleanup pass; table capacities are
10,000 contexts, 20,000 challenges, 10,000 sessions, 50,000 issuance/rate keys and
20,000 private-limit keys. Expired/revoked records are unusable immediately even
before physical cleanup. Idle installations require operator-scheduled cleanup
before any promised data-retention maximum; request-driven cleanup alone gives
no wall-clock deletion guarantee.

Successful verification atomically consumes the challenge and context, revokes
any supplied inactive prior session, and creates one session. Bootstrap and
verify refuse a presented active session (`session_exists`); logout must complete
before switching identity. This prevents another preauth tab from replacing an
active login while logout is in flight. Concurrent valid requests
can create at most one. Issuing a new challenge invalidates the earlier challenge
for that context. Bootstrap refuses to overwrite an active session, including a
session just created from the still-present preauth context.

Logout uses session+CSRF, or the matching preauth+CSRF to abort an in-flight login.
It revokes the source context and any session created from it, so verification
cannot resurrect that context after logout. It never grants read access and does
not require RPC or spend the protected-refresh rate budget. A foreign preauth context
cannot revoke an unrelated authenticated session. Concurrent `refresh` cannot revive
a revoked session or extend beyond the original absolute/idle deadline.

The cookies are `__Host-domino-preauth` and `__Host-domino-session`, with Secure,
HttpOnly, SameSite=Lax, Path=/ and no Domain. Only the BFF emits them from a
closed internal directive schema. It rejects credential/CSRF aliasing and strips
all upstream cookies/diagnostic headers. All responses are JSON, no-store,
nosniff, with request ID and contract version. A lost response is not evidence
that a transaction in the session store rolled back.

### Delegated accounts (EIP-7702)

Apply 041 before running a producer built from rc.4. It adds the nullable
`sessions.delegate`, lets `policy` take `eoa_or_7702_v1` besides the old value,
and ties a delegate to the new policy and to a lowercase nonzero address. It
accepts every row the previous producer writes, so it can run before the deploy
with ingress open; the reverse order refuses every login, because the new
producer writes a policy and a column that only 041 admits.

```sh
psql -f backend/migrations/041_session_delegated_accounts.sql
```

Sessions created under `plain_eoa_v1` stay stored but stop being live, since the
store compares the policy, so each browser signs in once more after the deploy.
`backend/dev_postgres.py` applies 041 on every run; the staging installers
package it as source (`PACKAGED_ONLY_MIGRATIONS`) and an operator applies it as
above. A rollback to an rc.3 producer needs no schema change: it never reads
`delegate` and treats `eoa_or_7702_v1` sessions as inactive, so those browsers
sign in again under the old policy.

## Frontend handoff, still owned by #14

The unreleased contract is [`session-v1` 2.0.0](../api-contracts/session-v1/README.md).
It adds no fields to `read-v1`; in particular the read-only capability endpoint
still says `walletAuthentication:false` for its own release. Do not infer that a
separately deployed session Worker exists from read capabilities. Session UI
activation needs an explicit coordinated frontend deployment flag.

Follow bootstrap → challenge → user signs the exact message → verify. After a
page reload, GET `me` using only the same-origin HttpOnly session cookie; it
returns the same CSRF and last stored identity/code-check snapshot without
mutation. It runs a PostgreSQL READ ONLY transaction: no cleanup, quota,
idle/snapshot renewal, RPC or revocation. Its validation can be stale. The
listener's bounded admission/timeouts still apply; GET does not consume the
shared protected-refresh budget. Deployment ingress needs request admission for
reads before activation, as with the other release traffic controls.

Use POST `refresh` with exact Origin and the returned CSRF for a fresh EOA
check and idle/snapshot renewal. It keeps the CSRF stable so two tabs can
refresh/write concurrently. A failed or missing CSRF reaches no EOA check and
cannot revoke the session. Protected preview/deposit endpoints must retain
their own session+CSRF authorization and fresh EOA checks; GET `me` does not
replace them. A refresh cannot extend the original twelve-hour absolute expiry,
revive an idle-expired session or resurrect logout. On `csrf_invalid`, recover
with `me`; do not automatically request a signature.

Clear the private view on wallet/network changes, complete logout of the old
session, then start sign-in for the new identity.
The backend cannot observe those UI changes and continues to bind only its
existing session address.

If verification's response is lost, first try GET `me`: an applied HttpOnly
session cookie recovers identity/CSRF. If no session cookie was applied, abort
using the still-held preauth/CSRF within its ten-minute window, then start a new
sign-in flow. Do not replay the consumed signature. A storage/RPC failure is
unavailable, distinct from `session_required`. Unsupported code-bearing wallets
may still use public reads. See shared safe error fixtures and exact schemas;
frontend adapter/rendering tests remain outstanding in this candidate's evidence.

## Earlier 2.0.0 transition and the admission migrations

[Execution policy](EXECUTION_POLICY.md) supersedes historical owner, ACK and
approval procedures here. Any authorized collaborator or agent may implement
and operate within scope, recording results alongside or after execution.
Technical controls, compatibility evidence and wallet consent still apply.

The earlier 2.0.0 candidate kept the family/path `session-v1` and separated GET
recovery from refresh. 3.0.0-rc.1 and rc.2 added admitted wallets and
generation-bound session/challenge state; the current rc.3 candidate takes both
back out. Deployment must
remain disabled until the consumer implements GET recovery plus POST refresh
and matches the new producer commit/digest. Any authorized collaborator may
complete and validate both sides without another person's ACK. No mixed-version
session replicas or workers are supported. Before a transition, disable session and authenticated
preview/deposit ingress, revoke old contexts/challenges/sessions through the
operator-controlled auth store, and deploy matching producers and consumers.
Do not merely relabel existing rows: old random CSRF cannot be recovered by GET,
and old retained CSRF must not remain usable in descendant authenticated routes.
An old session presented to GET returns `session_required` without writing.
The candidate does not change a deployed database or invoke revocation.

Migration 011 added nullable generations and a session-INSERT trigger enforcing
them. Migration 027 drops that trigger and leaves everything else 011 created
dormant, including the append-only admission audit, which is retained. Apply 027
with ingress disabled: until it runs, the trigger refuses every session INSERT
this producer makes, because the producer no longer writes a generation.
Rollback to an admission-enforcing producer needs the trigger restored and
grants issued first, and also keeps ingress off until that build is reviewed.
The owner-selected hosting target is described in the
[home VM handoff](HOME_VM_RUNBOOK.md).

The descendant `begin_preview` / `finish_preview` store guards continue checking
the stored CSRF hash, so newly derived CSRF uses their existing interface.
Keep those methods and their fresh EOA checks during stack integration. The
session Worker gains `/refresh`; authenticated Worker routing stays unchanged.
Rollback requires the same ingress-off, revoke and matched-version procedure;
restoring old session rows or mixing old consumers with a new producer is unsafe.

## Local reproduction and launch configuration

Install `backend/requirements-api.lock` into an isolated Python 3.14 environment.
Development PostgreSQL setup creates the auth role/schema only in the task-local
Unix-socket cluster. It does not apply a migration to production. Full CI needs
PostgreSQL and the existing pinned EVM test tools, with no wallet or provider key.

```sh
backend/.venv/bin/python backend/dev_postgres.py prepare-tests
DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1 backend/.venv/bin/python -m unittest discover -s backend/tests -v
backend/.venv/bin/python scripts/export-session-contract.py --check
npm --prefix bridge run check
backend/.venv/bin/python backend/dev_postgres.py stop
```

`backend/.venv/bin/python backend/session_api.py` starts only the disabled
loopback listener on 8879. It reserves neither the personal dashboard port 8765
nor public-reader/gateway ports 8876/8878. Enabling is a later explicit operator
step (`--enable --rpc-config <private-file>`), after the release gates below.
The trusted configuration file must pass the existing owned-file/0600 loader;
URLs cannot be submitted through HTTP. The auth listener uses the local database
descriptor with the fixed `domino_session_auth` role.

| Auth process configuration | Meaning |
| --- | --- |
| `DOMINO_SESSION_ORIGIN` | Exact canonical HTTPS application origin |
| `DOMINO_SESSION_ABUSE_SECRET` | Separate persistent random 32-byte secret, encoded as 64 lowercase hex; stable across replicas/restarts |
| `DOMINO_SESSION_ACCESS_ISSUER` | Reviewed Cloudflare Access team issuer |
| `DOMINO_SESSION_ACCESS_AUDIENCE` | Separate auth Access application audience |
| `DOMINO_SESSION_ACCESS_SERVICE_ID` | Allowed auth BFF service identity |

The Worker template is `bridge/wrangler.session.example.toml`, not a provisioned
deployment. `SESSION_BRIDGE_ENABLED` stays `false`. Its eventual secret store
holds `SESSION_ACCESS_CLIENT_ID` and `SESSION_ACCESS_CLIENT_SECRET`; its configured
destination is `SESSION_GATEWAY_ORIGIN`. The auth service identity is distinct
from the public reader identity. Keep credentials out of command arguments,
prompts, source, browser storage and logs. Rotating the abuse secret resets its
rate namespaces; do not rotate it independently in each worker or on restart.

## Activation and rollback gates

Code, synthetic tests and contract fixtures can advance while disabled. They do
not prove real HTTPS cookies, wallet rendering, Cloudflare/Tunnel framing or
production database permissions. For domino.money, verify the following and
record the results alongside or after delivery:

1. Backend and frontend commit/contract digest, compatibility evidence and
   actual adapter tests, including multiple wallets/tabs and account/chain changes.
2. Separate auth Access application/service identity, exact origin/path mapping,
   Tunnel-only loopback ingress and authoritative client-IP/framing tests. No
   preview/alternate hostname or reader identity may reach authenticated state.
3. Least-privilege production migration/role credentials, time synchronization,
   bounded storage/cleanup monitoring and a restore procedure that invalidates
   sessions/challenges rather than resurrecting previously revoked credentials.
4. End-to-end HTTPS bootstrap/login/expiry/logout, supported EOA RPC checks,
   cancellation/lost-response handling and failure-mode tests on the frozen build.
5. Edge, Tunnel, database and error-reporting redaction/retention: no bodies,
   signatures, full addresses, bearer/CSRF tokens or service credentials. Request
   IDs and fixed statuses are permitted. Preserve the security validation
   scenarios for public exposure. External review may supplement the evidence
   without becoming a permission gate; internal checks are not an external audit.

Rollback first disables the session Worker and listener, then revokes outstanding
contexts/sessions with the auth store under operator control. Restore matching
frontend/backend/contract versions together; never reuse an old challenge after
a restore or treat missing sessions as authorization. Public reads can remain
available independently. No rollback step signs, moves or collects user funds.
