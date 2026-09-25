# Invited-wallet access — retired (issues #49, #182)

**Owner decision by OxDecimal, 21 September 2026: the per-wallet whitelist is
removed.** Issue #49 had made explicit admission a second gate on wallet login,
on top of the shared beta password at the edge. Issue #182 removes it. This page
records what it was, what the removal cost, and what is left in the database.

The shared beta password (`app/functions/_middleware.ts`) is untouched and is
now the only gate. Public token, pool, address and NFT reads remain
unauthenticated, as they always were.

## What is gone

- `backend/wallet_access.py` and `backend/manage_wallet_access.py`: the operator
  module and its grant/revoke/list CLI.
- Every admission check in `backend/session_store.py`: the challenge-time
  generation snapshot, the check after SIWE proof, the check before session
  creation, and the one on session lookup, refresh and private authorization.
- `wallet_not_allowed` (403), from `session-v1`, `performance-v1`,
  `performance-v2` and `execution-v1`, and the `not_invited` state the frontend
  showed for it.
- Migration 011's `wallet_access_session_insert` trigger, dropped by
  [027_remove_wallet_access_gate.sql](../backend/migrations/027_remove_wallet_access_gate.sql).

SIWE is unchanged and still mandatory: origin, nonce, expiry, signature, CSRF
and the fresh EOA check all remain. Proving control of an address is now
the only thing login asks for. It proves neither spending authority nor token or
pool eligibility, exactly as before; those admission checks are separate and
untouched.

## What the product lost

Before this change there were two independent layers. The password gated reading
the site; the whitelist gated signing in with a wallet, which is what reaches
onboarding, deposit, performance, execution and private history. Now anyone
holding the shared password can sign in with any wallet and reach those routes,
and the password cannot be revoked per person. The whitelist was the beta's only
per-person revocation. OxDecimal weighed this and decided; it is recorded here
so the trade is on the record rather than discovered later.

Rotating the shared password remains a global revocation for everyone at once.
Session-level revocation is unaffected: `sessions.revoked_at`, logout, expiry,
the 30-minute idle deadline and the `account_unsupported` revocation all work as
before.

## What the removal fixed

Production's `grants` table is empty. As it stood, the day `SESSION_BRIDGE_ENABLED`
was turned on, every tester would have been refused **after already signing in
their wallet**, because the check ran after the SIWE proof. That trap is gone
from the switch-on runbook.

## What stays in the database

Migration 027 drops only the trigger. Everything else 011 created stays in
place, unused:

| Object | State |
| --- | --- |
| `domino_wallet_access` schema | Present, unused |
| `grants` | Present, empty in production; read by nothing |
| `audit` | Present; append-only history, deliberately kept |
| `set_access(text, boolean)` | Present; writes rows nothing reads |
| `guard_session_insert()` | Present; attached to no trigger |
| `domino_wallet_access_operator` role | Present; no CLI uses it |
| `challenges.admission_generation` | Present, nullable, no longer written |
| `sessions.admission_generation` | Present, nullable, no longer written |

Because nothing reads `grants` any more, **a grant written into it now admits
nobody and revoking one refuses nobody.** Do not treat `set_access` as a working
revocation. Dropping the columns, the function, the tables or the role is a
separate, optional change; the audit table is history worth keeping.

## Applying it

Apply 027 with session and private-consumer ingress disabled, before running a
producer built from this change against a database that already has 011. The
order matters in one direction only: 011's trigger refuses a session INSERT on
its own, independently of Python, so a producer that no longer writes an
admission generation is denied **every** login until 027 runs.

```sh
psql -f backend/migrations/027_remove_wallet_access_gate.sql
```

`backend/dev_postgres.py` applies it after 011 when it provisions a development
or test database, so those match a migrated one. The staging installers package
it as source without applying it (`prepare_disabled.py` and `upgrade_financial.py`
list it under `PACKAGED_ONLY_MIGRATIONS`); an operator applies it to the
installed database as the step above.

Rolling back to a producer that enforces admission needs the trigger restored
**and** grants issued first, or every login is refused after a valid signature.
Do not delete the audit table or resurrect sessions to make a rollback look
successful.

## Consumer

This change made the candidate **session-v1 3.0.0-rc.3** (rc.4 later admitted
EIP-7702 accounts; see [wallet sessions](WALLET_SESSIONS.md)); the path family and six successful
body shapes stay the same. The only wire change is the removal of
`wallet_not_allowed` from the closed error set. A consumer that matched it
exhaustively — `app/src/session/errors.ts` types `ERROR_CLASS` as a complete
`Record<SessionErrorCode, ErrorClass>` — must drop it in the same change, which
is why backend, contracts and frontend moved in one PR.

Unchanged: the 20/hour wallet budget is still reserved only after proof;
issuance limits are 5/minute/IP and 100/minute globally, verification 10/minute/IP
and 200/minute globally, all with fixed table caps. Revoked or expired sessions
still use `session_required` (401) and an unavailable store still uses
`session_store_unavailable` (503). Frontend handlers must keep those distinct,
preserve public navigation, and never auto-request a signature in response to a
rejection.

## Hosting

The [home VM runbook](HOME_VM_RUNBOOK.md) holds the backend/Decimal boundary,
private database roles, secrets, backups and validation before any service is
enabled. Three pilot wallet grants remain in the installed staging database per
[reports/P2_DELIVERY_2026-09-13.md](../reports/P2_DELIVERY_2026-09-13.md); after
027 they admit nobody and refuse nobody. No private key, wallet list or host
endpoint is stored in this repository.
