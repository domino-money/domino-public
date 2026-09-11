# deposit-v1 — 1.1.0-rc.2 candidate

This disabled candidate expands the closed1.0.0 contract with superseded state,
quota errors, allowance observations, observed replacement envelopes and nonce-conflict evidence. Producers, workers and consumers must
agree on1.1.0-rc.2 and the new manifest digest before activation; older headers
are rejected. Frontend acknowledgement remains pending.

Disabled owner-signed direct-deposit API. This package is separate from
`onboarding-v1` previews; it introduces no existing-field rename or activation.

All routes are same-origin POST JSON at `/api/deposit/v1/{route}` with the
existing HttpOnly SIWE session cookie and `X-Domino-CSRF`. Optional request and
mandatory response version header: `X-Domino-Deposit-Contract: 1.1.0-rc.2`.

- `create`: idempotencyKey UUID and immutable selection (pool, spaced ticks,
  exact amounts/budgets and explicit per-step gas caps).
- `get`, `allowances`: intentId. `list`: optional limit, 1–20, and owner-bound `before` UUID.
  Compact summaries return `hasMore` and `nextBefore`; `get` supplies history.
- `prepare`, `reconcile`, `cancel`: intentId and current version.
- `report`: intentId, version and transactionHash (only a hint).

Use the exported request/response types, schemas and runtime validators.
`walletStep` is non-null only for `prepare`; it contains the exact transaction
already persisted by the backend. Convert its raw decimal fields to the wallet
library's bigint/hex quantities without floating-point conversion. Recheck chain,
account, `validateWalletStep`, gas caps and `expiresAt` before requesting a wallet
signature. Never refresh the nonce or alter destination/calldata/value silently.
Every approval and mint needs the owner's wallet interaction. The backend has
no signing or broadcast capability.

Mint transactions expire on-chain after 120 seconds. Permit2 authorization uses
a bounded one-hour expiration and an exact amount; an ERC20 approval itself has
no time expiry. These differ from the 30-second wallet handoff validity. All
three are visible in the step kind and inspected transaction.

Persist only the operation ID in application state; never the session bearer or
an executable transaction in browser storage. After reload, obtain the operation
and reconcile outstanding work. Expiry or cancellation is not proof that an
already handed-off transaction was never sent. An ambiguous issued step stays
reserved; a wallet nonce-cancellation/replacement can be reconciled after finality.

History distinguishes pending/finalized receipts, direct deposit principal and
zero Domino setup fee. Gas and token quantities stay raw strings. Missing L1 gas
or native net transfer accounting is null; never label execution-only gas as the
complete network cost. `currentOwner` is a recorded chain observation, not a new
authorization or a promise that ownership will remain unchanged.

Fixtures are synthetic. Candidate validators and offline tests do not qualify
token behavior, deployments, HTTPS staging or the actual frontend integration.
Live preparation also requires an explicit reviewed local admission manifest.
Obtain frontend acknowledgement of this version/digest before browser activation.
Rollback disables the deposit worker/listener, preserves unresolved operation
evidence and restores matching package/consumer/producer versions.


This unreleased candidate adds terminal `superseded` and the `allowances` route.
Consumers must accept the new state only with finalized foreign-effect evidence;
it is neither a mint nor a claim that approval was revoked. `allowances` returns
the normal operation plus pinned raw ERC20/Permit2 observations; missing values
are null, expired Permit2 exposure is distinct from persistent ERC20 permission,
and `walletStep` is always null. The runbook maps the closed revocation-guidance
code to exact owner-reviewed approve-zero methods. Snapshot evidence does not
establish token admission or authorize any transaction.

New capacity errors distinguish owner active pressure from retained history.
Never-issued requests have a7day online idempotency window; issued evidence is
retained online at least90days after a terminal update and can then be exported
by explicit operator maintenance. Operation IDs removed after archival return
not-found; the audited archive is the long-term evidence, not a browser database.
Retain user-facing archive/reference instructions before production activation.
No existing wallet artifact/admission fields were relaxed. Coordinate this
candidate with #46 admission and the session-v2 consumer before enabling it.

`receipt.transaction` is nullable for legacy/different-effect receipts. Otherwise it
records the observed nonce, gas limit and fee caps as raw strings, plus the exact
`selectedLimitsExceeded` list. A wallet replacement above selected limits may
confirm/revert after normal receipt, finality and NFT checks; show the breach
alongside the actual result. Prepared wallet artifacts remain capped.

Every history step includes `reportedEffectConflicts`. A nonempty list prevents
terminal completion and requires attention even if the issued nonce finalized.
The list is durable; a missing later lookup is not evidence that another-nonce
effect disappeared. There is no automatic conflict clearing or replacement mint.
Unknown durable hashes whose identity cannot be read remain held; previously
identified same-nonce hashes can disappear after a verified wallet speed-up.
Identity is checkpointed before subsequent RPC reads; timeout/auth failures do
not convert an unclassified hash into proof of no execution.
Legacy receipts project `transaction:null` and legacy steps an empty conflict list.
Migration014 reclaims at most32 expired never-issued rows across owners per create,
while preserving all issued history and the existing active/retained limits.
