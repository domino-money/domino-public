# Durable private execution

13 September 2026 · E5 / #89. This extends migration 015 with the explicitly
applied `019_execution_journal.sql`; neither migration provisions a signer,
listener, worker loop, credential, VM service or production activation.
`EXECUTION_POLICY.md` governs collaboration; runtime consent and accounting
checks still apply.

`execution_runner.ExecutionRunner.step` performs one bounded intent attempt or
recovery pass. `execution_cli.py` is the private signer-process interface: its
commands accept owner/intent/worker identifiers, never transaction fields or raw
calldata. A separate authenticated **read-only** gateway in
`execution_status.py` has no signing, cancellation, nonce or broadcast route.

## Signing and persistence

The private signer loads a configured synthetic/test or operator key separately
from the API. Its admitted chain is 4663. Exact deployment code hashes, factory,
vault, manager, implementation, helper/engine and service recipient are matched
again at a canonical block. The key boundary reconstructs the registered typed
ABI from the immutable E1 plan and observation, checks current policy, limits,
operator generation, state nonce and individual root permission, then simulates
the exact zero-value call. Gas and type-2 fee ceilings must fit both the plan
and explicit signer policy. Defaults keep signing disabled and new work blocked
in restore-only mode; no universal live gas/subsidy settings are supplied.

The transaction nonce belongs to the global `(4663, signer)` stream, across
owners. A locked high-water row and the original global unique reservation index
serialize allocation. A preexisting claim is reused, never incremented because
of a timeout. The owner-wallet deposit nonce stream is untouched.

The `signing` journal commits **before** the key operation. Its existence blocks
both Python and direct-SQL unsigned cancellation. The signer then independently
rebuilds the transaction, signs it, recovers its sender, decodes and compares
all transaction fields and hashes the exact bytes. Bytes, hash, immutable
financial intent, nonce and fence commit before any broadcast. Signing ambiguity
cannot re-enable cancellation. Recovery can reconstruct the same unsigned
preimage; an already persisted signed attempt is never signed again.

Only the signer database role can read signed bytes. The worker cannot create
fee credits, write the journal/effect or read bytes. The status reader has column
privileges only for the public projection and forced owner isolation. Table-owner
sessions also remain subject to forced RLS. The signer/reconciler is a trusted
private principal: RLS prevents accidental cross-owner queries, not a fully
compromised private service intentionally changing its owner context. Database
administrator/key compromise is outside this application isolation boundary.

A live intent lock and fencing check surround broadcast. An expired/taken-over
worker cannot initiate another send. RPC timeout, an unexpected hash, a lost
reply, or a failed post-send commit are ambiguous outcomes. The persisted attempt
is inspected on the next explicit pass; there is no alternate RPC or fresh nonce
fallback. Replacements are explicit, limited to at most three by schema and to
the configured lower count, use a minimum 10% bump, and preserve recipient,
nonce, gas, zero value and exact calldata. Requalification and the total gas
ceiling apply to every replacement. Estimation uses a canonical block rather
than the pending state containing the attempt being replaced.

## Canonical receipts and recovery

Every recorded hash is checked, including replaced attempts. Canonical block
membership, transaction/receipt identity and finalized status precede acceptance.
The existing independent E4 receipt verifier checks the actual manager/vault
balance effects and E1 source allocations. One intent has at most one canonical
financial effect and one row per consumed lot; repeated reconciliation is
idempotent. Collection credits remain classified as realized accrual with
**unknown earning time**, never invented 24h income. Original and converted
amounts stay separate and the 200 bps service cut applies only to consumed
original fees. No additional owner gas deduction or setup fee is introduced.

Receipt, realized credit origins, exact per-lot debits and release of collection
and lot reservations commit together. Unused earned fees retain their original
uncharged identity. A canonical revert consumes its signer nonce but releases
fee reservations without a financial effect. Nonce/successor tombstones are not
silently deleted. Failed, missing or noncanonical receipts cannot release signed
reservations merely because a deadline/lease expired.

A lost canonical receipt invalidates its displayed financial effect and marks
the sequence for reconciliation. Debit tombstones remain conservative: reorgs
never recreate fee money automatically. Re-inclusion of the same transaction can
revalidate the same effect; an unresolved different replacement or changed
financial effect requires explicit investigation. Restore-only is the default:
restoring a database does not authorize new work. A backup predating an unknown
external broadcast cannot prove no transaction exists; keep signing disabled,
reconcile the signer nonce, vault intent/state and all retained signed attempts,
and requalify the deployment before permitting new work.

The implementation exposes receipt gas product with full L2 cost unavailable;
Robinhood execution/data-posting cost, confirmation policy, token/route admission,
operator cohort funding, key custody/rotation and external restore procedures
still need environment-specific qualification. Local Anvil finality is synthetic
and does not establish production finality. This delivery performs no real send.

## Read-only status contract

`POST /internal/execution/v1/status` takes `{ "intentId": "0x…" }`.
`POST /internal/execution/v1/list` takes optional `afterIntentId` (default null)
and `limit` (1–20, default 10). The header is
`X-Domino-Execution-Contract: 1.0.0-rc.1`. Request and response models live in
`execution_status.py`; fixtures are under `backend/tests/fixtures/execution`.

The status/list response includes `contractVersion`, `chainId`, authenticated
`owner`, `executionAvailable:false` and `item` or `items` with
`nextAfterIntentId`. Each item includes `intentId`, `sequenceHash`, state/reason,
public signer address/nonce, attempt hashes, `canCancel`, and a bounded canonical
receipt or null. Missing and foreign intents both return `item:null`. `canCancel`
describes the private pre-sign boundary; it does not create a browser cancel API.

List uses ascending intent-ID keyset pagination under the session owner. The
position is not an authorization bearer or a frozen snapshot: new intents may
appear on a new refresh. Owner, signer, nonce, transaction bytes, gas and action
fields are forbidden in either request. `OnboardingAuth` checks session and CSRF,
then rechecks revocation after the final read. `AuthenticatedGateway` preserves
loopback/JWT/browser-origin forwarding, limits, deadlines and no-store responses.
The gateway is disabled unless explicitly constructed with `enabled=True`.

## Local verification

The focused tests use a private Unix-socket PostgreSQL cluster and a loopback
Anvil chain with public synthetic keys and pinned official-v4 fixtures. They
exercise persisted signing, ambiguity, replacements, operator revocation/revert,
byte identity, fencing, owner isolation, actual `pg_dump`/`pg_restore`, canonical
exactly-once effects and reorg invalidation. The status tests exercise the real
session orchestration and HTTP boundary with synthetic authentication fixtures.
No personal bot, wallet runtime, credential or production provider participates.

```sh
DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1 backend/.venv/bin/python -m unittest discover -s backend/tests -p test_execution_runner_evm.py -v
backend/.venv/bin/python -m unittest discover -s backend/tests -p test_execution_status.py -v
DOMINO_TEST_POSTGRES=1 backend/.venv/bin/python -m unittest discover -s backend/tests -p test_execution_store.py -v
```

## Private status listener

`python backend/execution_status.py serve` starts a disabled listener at
`127.0.0.1:8901`. To enable only the authenticated read surface, use
`serve --enable --config /absolute/private/execution-status.json`. This command
does not load an execution key, signer, admission or transaction RPC client.
No signing, replacement or cancellation route exists in this listener.

The explicit JSON configuration has these exact keys:

```json
{
  "schemaVersion": 1,
  "kind": "domino-execution-status",
  "runtimeDirectory": "/absolute/private/execution-status-runtime",
  "database": {"host": "/absolute/private/pg-socket", "port": 5432, "dbname": "domino_catalogue"},
  "session": {
    "origin": "https://domino.money",
    "abuseSecretFile": "/absolute/private/session-abuse-secret",
    "rpcEndpoint": "https://rpc.mainnet.chain.robinhood.com",
    "rpcAllowedHosts": ["rpc.mainnet.chain.robinhood.com"]
  },
  "access": {
    "issuer": "https://example.cloudflareaccess.com",
    "audience": "0000000000000000000000000000000000000000000000000000000000000000",
    "serviceId": "replace-with-execution-service-identity"
  }
}
```

The example is a shape, not deployment qualification or usable Access settings.
The status service gets its own Access identity. The session origin and abuse
secret must match the session service; the secret file contains exactly 64
lowercase hexadecimal characters, optionally followed by one newline. Database
settings cannot choose a role: session authentication uses `domino_session_auth`
and status reads use `domino_execution_reader`. The RPC endpoint is used only
for the existing plain-EOA session check, with no fallback or environment override.

The config, secret and runtime directory must be outside every product checkout,
owned by the service user, with file mode `0600` and directory mode `0700`.
Symlinks, hardlinked files, writable foreign ancestors, duplicate JSON keys,
unknown fields and absent files are rejected. Startup holds a singleton lock;
the server binds only loopback 8901, uses one process, disables forwarded-header
trust and access logs, and retains the shared bounded authenticated worker slots.
Each status SQL operation inherits the remaining request deadline and uses a
read-only transaction. The schema still reports `executionAvailable: false`:
reading receipts does not enable financial execution.

Cloudflare Access may duplicate its service assertion as a single cookie.
Only `CF_Authorization=<exact cf-access-jwt-assertion>` is normalized; the JWT is
still verified. Other cookies, additional values and duplicate headers fail
closed. Session and CSRF credentials remain in their dedicated internal headers.
