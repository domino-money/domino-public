# Wallet admission implementation — issue #49 / PR #53

This disabled backend candidate admits only operator-approved wallets on Robinhood
Chain. Public blockchain reads remain unauthenticated. No financial permission,
real wallet grant or deployment is part of this correction.

## Review correction and compatibility

Base: corrected session PR #33, `b2993dced9e898b3773a46c9cba5b2c6c468e481`.
OxDecimal reviewed the first admission candidate at
`673a9148de8e7980541a212b593c8b4d5764dd20` and requested changes in
[review 5173193517](https://github.com/domino-money/domino/pull/53#pullrequestreview-5173193517).
That review correctly identified unsigned membership disclosure and targeted
wallet-quota exhaustion. The corrected candidate is **session-v1 3.0.0-rc.2**.

Every well-formed address now receives a sign-in challenge with the same public
shape and status. The database privately snapshots the admitted generation, or
NULL when not admitted. `reserve_verify` only checks context, message, expiry
and bounded attempts; it does not disclose admission. Invalid signatures return
`invalid_signature` / 401 regardless of membership.

After a valid SIWE signature, `check_verified_admission` rechecks the stored
challenge/context and current generation before any EOA RPC. An already denied
wallet receives `wallet_not_allowed` / 403 there. A revocation during RPC is
caught again by authoritative `finish_verify`, under the shared database lock.
Finalization also binds the address, nonce and message to the verified challenge.
An old NULL snapshot cannot acquire permission from a later grant.

The former unsigned 20/hour target-wallet counter is removed. Its replacement is
reserved only after ownership proof and admission, before RPC; failed RPC still
consumes it. Shared IP limits stay at 5/minute for bootstrap/challenge and
10/minute for verification. Fixed global limits add 100/minute shared issuance
and 200/minute verification. Five attempts per challenge and all existing table
capacities remain. Unauthenticated targeting cannot spend a wallet's quota.

Successful body shapes and route paths are unchanged. Removed/obsolete sessions
still return `session_required` / 401, and unavailable admission storage returns
`session_store_unavailable` / 503. Public reads remain open. The frontend must
branch on the finite error code, stop the rejected sign-in flow and never
request another signature automatically. The rc.2 manifest now includes
`session_service.py`, binding the proof-before-admission ordering as well as the
schema/store/migration sources.

## Database defense and retained authority

Migration 011 retains the private grants/audit schema, generation progression,
operator-only function, reserved revocation capacity and fixed roles. No real
address is seeded. The operator cannot read bearer/CSRF state; auth can read
grants but cannot enroll a wallet. Generations and audit are not evicted.

The suggested defensive INSERT trigger is implemented. It takes the same
advisory lock and requires an allowed grant matching the new session's chain,
address and non-NULL generation. A legacy writer that omits the generation fails
closed. A non-superuser function owner is covered by the actual PostgreSQL tests.

This is a write defense, not a complete legacy rollback policy: an old producer
with admission-unaware read-only session lookup can still mishandle existing
rows. The trigger neither verifies SIWE nor retrofits that old code. All private
ingress must remain disabled during migration/rollback until one consistent,
policy-preserving package is in place. Existing rows are not changed or deleted
by operator revocation; current lookup guards deny them and matching credentials
can still log out. Public catalogue and authentication nonce evidence survive.

## Qualification

Local environment: Python 3.14, PostgreSQL 18, Node 25 and native Forge/Anvil
1.7.1. CI uses the repository's Node version and PostgreSQL 16; its result must
be checked separately on the published head. All checks below are offline.

| Check | Result |
| --- | --- |
| Full backend, PostgreSQL and native EVM enabled | 511 passed; zero skipped |
| Wallet-admission tests inside that suite | 29 passed |
| Read/session bridge | 372 passed; zero skipped |
| Native Solidity suite | 4 passed, including 512 fuzz runs; zero skipped |
| Read contract, OpenAPI and session export checks | Passed |
| Shared read/session strict TypeScript | Passed |
| Locked Python dependency consistency | Passed |
| Repository hygiene and diff whitespace | Passed |

Web code is unchanged; the previous rc.1 web checks were not rerun for this
backend correction. No remote RPC, provider key, production wallet or external
service was used.
The final producer commit/manifest and remote CI must be attached by the root
review/publication step; this working-tree correction is not yet committed.

The stronger regressions observe an actual advisory lock wait in PostgreSQL for
both the operator SQL function and the INSERT trigger, bypassing the Python
wrapper. Removing either lock causes its test to fail. NULL-generation tests
now verify the intended order: SIWE runs once, then denial occurs before EOA RPC;
an invalid signature never reaches admission. HTTP tests cover identical
challenge shapes and invalid-signature codes for admitted/unadmitted addresses.
Other tests cover revocation during proof/RPC, unsigned quota attacks, proven
wallet/global limits, missing admission storage, generation resurrection and
legacy inserts. The earlier rc.1 qualifier had 500 backend tests; its old
pre-signature-denial test was replaced because it encoded the reviewed defect.

## Boundaries and handoff

This stack predates the onboarding/deposit runtime. Its frozen descendant
preview methods prove inherited authorization guards, not a combined financial
HTTP integration. Preserve those guards and rerun the integrated suite later.
Numbers 009/010 and 012/013 remain reserved to their coordinated tasks; no new
migration number was taken.

The root task owns independent review, the exact commit, publication and the
updated notice to Decimal. Consumer acknowledgement is still required before
integration/enablement. Host VM provisioning continues separately; this correction
does not alter VM files, Cloudflare, DNS, frontend code or any real grant. See
[wallet access](../docs/WALLET_ACCESS.md),
[session contract](../api-contracts/session-v1/README.md) and
[home VM runbook](../docs/HOME_VM_RUNBOOK.md) for their separate boundaries.
