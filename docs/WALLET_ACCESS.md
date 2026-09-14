# Invited-wallet access — issue #49

Owner decision: the first alpha permits login and private wallet operations only
for explicitly admitted Robinhood wallets. Public token, pool, address and NFT
reads remain unauthenticated. Decimal owns Cloudflare/DNS and the frontend access
gate; the backend enforces wallet membership independently of that gate.

## Authority

Admission identity is chain **4663** plus a canonical address, never a symbol,
browser-selected owner, frontend flag or possession of a URL. The backend starts
with an empty list and denies login. Only the operator database role can grant or
revoke access. There is no public admin, enrollment or list endpoint.

SIWE remains mandatory, with the existing origin, nonce, expiry, signature,
CSRF and fresh plain-EOA checks. Whitelisting proves neither wallet possession
nor spending authority. Existing token/pool admission and exact transaction
checks remain separate requirements. Contract-wallet support is unchanged.

Every changed grant/revoke advances a durable generation. A challenge and its
resulting session bind that generation. Every well-formed address receives the
same challenge response; its internal snapshot is the admitted generation or NULL.
No membership result is returned until a valid SIWE ownership proof. Admission is
checked after that proof, before EOA RPC, and again before creating a session, then
on session lookup/refresh and private authorization. Revocation followed by re-grant
cannot resurrect an old session or previously issued sign-in challenge. A new
signature is required. No in-memory allow cache or process restart is needed.

GET `/me` stays read-only: it checks the current grant/generation without renewing
idle expiry, writing quota state, calling chain RPC or changing records. Matching
logout credentials can still clear a session after access is removed. Database
failures deny authentication; they never fall back to an open policy.

## Administration

`backend/manage_wallet_access.py` is a local operator CLI. It reads a private
database descriptor, uses the fixed `domino_wallet_access_operator` role, and
accepts only chain 4663. The role cannot read session bearer/CSRF hashes or modify
them. The auth role can read admission state but cannot enroll a wallet. Operator
changes and audit records commit atomically, serialized with auth transactions.

With the target database and operator identity explicitly provisioned:

```sh
backend/.venv/bin/python backend/manage_wallet_access.py list --limit 20
backend/.venv/bin/python backend/manage_wallet_access.py grant "$INVITED_WALLET"
backend/.venv/bin/python backend/manage_wallet_access.py revoke "$INVITED_WALLET"
```

`INVITED_WALLET` is an operator-supplied public address, not a private key.
Lowercase and valid checksum addresses are normalized; malformed addresses and
the zero address are rejected. The tool does not create a wallet, send a
transaction, change token permissions, start a service or activate a Worker.
An idempotent repeated grant/revoke does not advance an unchanged generation.

The current finite limits retain at most 10,000 wallet records and 100,000 audit
events. Grants stop at 90,000 events, reserving room to revoke every admitted
wallet. Records/generations are not silently deleted to recover capacity. A
capacity error needs an operator-reviewed retention/migration plan; it cannot
relax the admission policy. The alpha's small initial list is not a load test.

Use `--database-config /absolute/private/catalogue-db.json` before the command
when the operator has a separate descriptor. The file must satisfy the existing
owned/private Unix-socket configuration loader. It cannot select an arbitrary
database role. List pagination uses a bounded limit and the last address returned
as `nextAfter`; do not expose command output through a web endpoint.

The initial real-wallet list stays outside source control and CI. This task has
not invented or granted any real owner address. Synthetic test owners are
explicitly admitted only inside disposable test databases. Host provisioning is a separate task; configuration in a test database is not
deployment evidence.

## Revocation and private consumers

The shared `SessionStore._session` / `_active` boundary binds admission to the
session generation. The existing descendant `begin_preview` / `finish_preview`
methods must preserve these calls; onboarding and deposits use those methods
through `OnboardingAuth.begin` / `finish` before and after provider work.
Do not authenticate once at the edge and reuse that result as lasting permission.

Removal blocks new private authorization and response delivery once the new
state is observed. An operation racing with revocation can already have committed
an artifact/reservation; preserve that evidence. The backend cannot invalidate
a transaction already delivered to a wallet or prevent inclusion of a signature
already sent to the chain. Whitelisting is not an on-chain cancellation mechanism.

Do not delete operation/receipt/nonce evidence when removing an address. Any
independent operator reconciliation of previously sent transactions must preserve
its existing verification rules and remain possible without logging in as that
wallet. This change does not add such a worker, a recovery signer or a public
revocation bypass. Owners retain direct chain control of their wallets/NFTs.

## Consumer and migration

The candidate is **session-v1 3.0.0-rc.2**; the path family and six successful body
shapes stay the same. `wallet_not_allowed` (403) occurs only on `verify`, after a
valid SIWE signature. A known denial stops before EOA RPC; if access changes
during RPC, the final check also denies session creation. `challenge` and pre-proof
verification do not disclose list membership; invalid signatures return
`invalid_signature` (401) in either state.
The pre-proof wallet quota is removed: the 20/hour wallet budget is reserved only
after proof. Shared issuance limits are 5/minute/IP and 100/minute globally;
verification is 10/minute/IP and 200/minute globally. Both keep fixed table caps.
Revoked/obsolete sessions use `session_required` (401); unavailable admission
storage uses `session_store_unavailable` (503). Frontend handlers must keep these
states distinct, preserve public navigation and never auto-request a new signature
in response to rejection. Decimal's account/network-switch handling remains in
#14. The exact producer/digest and tests are announced before consumer integration.

Migration **011_wallet_access.sql** depends on 008_wallet_sessions.sql. Numbers
009 and 010 are already allocated to descendant onboarding/deposit state; retain
them and apply the complete ordered set when integrating the stack. The migration
does not grant any address and leaves pre-migration challenges/sessions without
an admission generation. Old rows cannot authenticate under the new guard.
An INSERT trigger takes the
same advisory lock and rejects sessions without a currently admitted, matching
generation. It blocks legacy writers that omit the field; it does not verify a
cryptographic signature or retrofit old producers with admission-aware reads.

Disable session and private-consumer ingress during a version/migration change.
Keep all auth processes on the same reviewed package and generate matching
consumer contracts. Returning to a legacy producer can still bypass
admission-aware reads for existing rows;
rollback must keep ingress off until a reviewed policy-preserving build is in
place. Never drop the membership/audit tables or resurrect sessions to rollback.
Public read payloads and their unauthenticated policy do not change.

## Hosting handoff

The owner selected an isolated VM on their home Linux server. A dedicated SSH
key is authorized and host inspection succeeded. The owner freed space on
the Linux system NVMe; the 100 GiB VM and empty PostgreSQL foundation are now installed.
Four initial wallet addresses were checksum-validated and saved privately for
later operator provisioning. Since then, per
[reports/P2_DELIVERY_2026-09-13.md](../reports/P2_DELIVERY_2026-09-13.md), three
pilot wallet grants remain present in the installed staging database. No private key,
wallet list or host endpoint is stored in this repository. See the
[home VM runbook](HOME_VM_RUNBOOK.md) for the backend/Decimal boundary, private
database roles, secrets, backups and validation before any service is enabled.
