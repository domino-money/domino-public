# deposit-v1 — 1.1.0-rc.4 candidate

This disabled candidate expands the closed1.0.0 contract with superseded state,
quota errors, allowance observations, observed replacement envelopes and nonce-conflict evidence. Producers, workers and consumers must
agree on1.1.0-rc.4 and the new manifest digest before activation; older headers
are rejected. Frontend acknowledgement remains pending.

Disabled owner-signed direct-deposit API. This package is separate from
`onboarding-v1` previews and does not activate financial operations. Issue #42
coordinates the breaking receipt migration from `1.1.0-rc.2` to `1.1.0-rc.3`;
its exact changes are listed below.
Issue #44 adds a further migration from rc.3 to rc.4 for reviewed-token admission.

## Reviewed-token candidate migration (#44)

- `walletStep.admission.policyVersion` also accepts `direct_existing_pool_v2`.
  V2 requires `tokenReviews: [{address, reviewId}]`, exactly the selected non-native
  currencies in canonical order. V1 permits only null/absent tokenReviews.
- `ReceiptPosition` adds required `amount0Basis` and `amount1Basis`: raw amounts
  are non-null only for `admitted_standard_transfer_events` or
  `reviewed_proxy_transfer_events`. Other bases are `native_net_unavailable`,
  `token_review_changed`, `token_review_unavailable`, `legacy_token_review_unqualified`.
  Never convert those null quantities to zero.
- Proxy amounts are transfer-event quantities under matching reviewed historical
  endpoint assumptions, not transaction-level balance traces or proof that an
  issuer could not transiently upgrade within a block.
- New errors: `deposit_token_changed` (409), `deposit_token_restricted` (422),
  `deposit_token_check_unavailable` (503). Stop the signature flow on these
  responses. A backend rejection cannot cancel an already delivered transaction.
- Every wallet payload, including a repeated prepare response, is freshly
  revalidated against token/policy state without changing its persisted nonce.

Fixtures `reviewed-proxy`, `proxy-event-amounts` and `token-review-changed` cover
these additions. [Policy and consumer guidance](../../docs/REVIEWED_TOKEN_ADMISSION.md)
describe issuer controls, USDG payout-group limits, historical review retention,
resource bounds and rollback. Exact-package acknowledgment is required before
frontend integration; no hook or public route was activated here.

All routes are same-origin POST JSON at `/api/deposit/v1/{route}` with the
existing HttpOnly SIWE session cookie and `X-Domino-CSRF`. Optional request and
mandatory response version header: `X-Domino-Deposit-Contract: 1.1.0-rc.4`.

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

Robinhood Nitro's `eth_estimateGas` bundles execution and data-posting gas. The
prepared gas limit includes a 20% buffer within the selected cap; it is not an
execution-only estimate. Native headroom reserves the planned native deposit,
selected reserve and this step's `gasLimitRaw × maxFeePerGasRaw`. Do not add a
second L1 fee to that bound. Estimates and buffers do not guarantee inclusion or
future fees. See [RPC qualification](../../reports/DEPOSIT_RPC_QUALIFICATION.md).

Persist only the operation ID in application state; never the session bearer or
an executable transaction in browser storage. After reload, obtain the operation
and reconcile outstanding work. Expiry or cancellation is not proof that an
already handed-off transaction was never sent. An ambiguous issued step stays
reserved; a wallet nonce-cancellation/replacement can be reconciled after finality.

History distinguishes pending/finalized receipts, direct deposit principal and
zero Domino setup fee. Gas and token quantities stay raw strings. Receipt fields
have these exact meanings:

| Field | Contract semantics |
| --- | --- |
| `grossGasFeeRaw` | `gasUsedRaw × effectiveGasPriceRaw`, before any separate ArbOS resource refund |
| `l1GasUsedRaw` | Nullable observed Nitro `gasUsedForL1`, in child-chain gas units and no greater than `gasUsedRaw` |
| `l1FeeRaw` | Nullable `l1GasUsedRaw × effectiveGasPriceRaw`; included in the gross fee, never added again |
| `totalFeeRaw` | Required null; exact net fees/refunds are not qualified |

Known-zero poster gas returns zero strings; absent poster gas returns null for
both L1 fields. A provider extension named `l1Fee` does not supply this contract's
L1 amount. Do not label gross fee or gross-minus-poster as exact net cost, infer
zero refunds from absent resource fields, or infer native net deposit/refund
from whole-block balances. `currentOwner` is a recorded chain observation, not a
new authorization or a promise that ownership will remain unchanged.

## Coordinated candidate migration — issue #42

`executionFeeRaw` is removed and replaced by `grossGasFeeRaw`; `l1GasUsedRaw` is
new; `l1FeeRaw` changes to an included amount derived only from that operand;
`totalFeeRaw` narrows to null. Update the producer, worker, schemas, types,
validators, fixtures and package manifest together. The header changes from `1.1.0-rc.2` to `1.1.0-rc.3`
for this explicit migration before first release. Pin the exact candidate commit/digest and obtain consumer
acknowledgement **before integration**, following
[API compatibility](../../docs/API_COMPATIBILITY.md). No frontend acknowledgement
or public deployment is implied by this package. Older candidate headers and receipts are not accepted by the new public wire.

Legacy private receipts are projected from their raw gas usage and price; old
derived execution/L1/additive-total values are not trusted as qualified fee
components. Without the new poster-gas operand, L1 fields are null. Net total
stays null, and the original operation/nonce/NFT evidence is preserved.

Fixtures are synthetic. Candidate validators and offline tests do not qualify
token behavior, deployments, HTTPS staging or the actual frontend integration.
Live preparation requires an explicit reviewed local admission manifest. The
[deployment review](../../reports/DEPOSIT_DEPLOYMENT_REVIEW.md) found both WETH
and USDG are upgradeable proxies and therefore blocked by the legacy immutable
token policy. That review created no production manifest. Issue #44 adds separate
[reviewed v2 profiles](../../docs/REVIEWED_TOKEN_ADMISSION.md) and disabled
configuration tooling; it does not enable deposits. The earlier
[local-fork evidence](../../reports/DEPOSIT_FORK_QUALIFICATION.md) uses controlled
test assumptions to characterize deployed mechanics; it does not grant token
eligibility, prove absent future upgrades or qualify Nitro net gas charges.
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
