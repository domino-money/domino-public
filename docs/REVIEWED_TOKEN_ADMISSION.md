# Reviewed tokens for direct deposits — issue #44

The disabled deposit candidate accepts reviewed immutable tokens and reviewed
ERC-1967 transparent/UUPS proxies under `direct_existing_pool_v2`. The initial
proxy profiles are Robinhood WETH and USDG. Discovery still accepts arbitrary
token addresses; a readable token or a successful quote never creates admission.

The user approved supporting issuer-controlled assets with explicit checks and
residual risk. These checks do not prevent an issuer from upgrading, freezing or
pausing its token. Neither this policy nor a matching hash promises asset safety,
an immutable transaction-time implementation or an emergency response window.

## Review and identity

The [source review](../reports/UPGRADEABLE_TOKEN_REVIEW.md) records compiler/runtime
comparisons, layouts, administrators and the exact initial scope. The
[candidate profiles](../reports/robinhood-reviewed-token-profiles-2026-09-10.json)
are public review inputs. They are not an enabled production configuration.

Each profile binds its chain-context address, proxy runtime, implementation
address/runtime, proxy kind, admin and zero beacon, code dependencies, fixed
storage/getter observations and operative storage predicates. A SHA-256 review ID
binds the complete record. Predicates come only from operator-reviewed local
configuration; browser requests cannot supply contracts, slots, getters or rules.
Symbols, issuer names, provider results and simulation success are not selectors
for trust.

WETH pins both its ProxyAdmin and the implementation behind its governance
proxy. USDG pins its implementation, administrator observations, reviewed admin
facet code and seven selector mappings. Pause/freeze checks read authenticated
storage directly rather than trusting a replaceable facet getter.

USDG admission requires:

- Pause byte zero at slot 4, offset 20.
- `frozen` mapping at compiler-confirmed slot **6**, low byte zero for the actual
  owner, Permit2 and PoolManager. A source comment incorrectly said slot 7.
- Payout group zero in `balanceData`, mapping slot 1, bits 128–143, for owner and
  PoolManager. Accounts enrolled in a payout group are outside this initial
  finite profile and receive `deposit_token_restricted`; the code does not opt
  them out or move their rewards. PoolManager and the explicit test owners met
  this condition in the recorded observations.

Initialization and governance observations are also pinned. The observed USDG
admin-transfer delay is not an upgrade delay. Governance getter/code observations
are not a complete audit of authorization members or every governance path.
The source review states the remaining evidence limits explicitly.

## Preparation and re-delivery

Admission validation and selected-pair complexity checks run before provider/RPC
work. Every new preparation verifies the token profiles at its canonical source
block, then checks them again at a fresh canonical block after composition and
simulation. Ordinary selected amounts, approval targets, gas ceilings, pool/range,
recipient, nonce and deadlines remain enforced.

The final service handoff calls `preparer.revalidate` for **every** wallet payload,
including re-delivery of a persisted step. It checks the current manifest and
review IDs, token state, protocol identity, plain-EOA owner, nonce, canonicality
and expiry. It never substitutes new calldata, recomposes the transaction or
silently releases a nonce. If revalidation fails after issuance was persisted,
the reservation and history remain intact.

New finite errors:

| Error | HTTP | Meaning for a consumer |
| --- | ---: | --- |
| `deposit_token_changed` | 409 | Reviewed identity/policy changed; stop requesting a wallet signature and require review |
| `deposit_token_restricted` | 422 | An operative condition such as pause, freeze or payout group prevents this path |
| `deposit_token_check_unavailable` | 503 | Required identity/state could not be read reliably; no payload is authorized |

Shared deadline expiry remains `request_timeout`. None of these errors means an
already delivered/signed/sent transaction was cancelled. A browser must still
check the supplied expiry and wallet identity before signature. The backend
cannot invalidate a copy already inside a wallet or enforce checks atomically
with a direct PositionManager call. There is no new signing relay or custom
on-chain wrapper in this slice.

## Receipts and history

Submitted hashes continue through reconciliation even when current preparation
is blocked. Token identity is checked at the receipt block and its canonical
parent using the review ID issued with the step. Historical checks share the
reconciler's RPC budget. They are independent of current manifest expiry.

For supported v1 immutable tokens, the preparer's receipt guard retains a
detached copy of the validated manifest's ID and token code hashes. An issued
artifact must name that exact v1 manifest and a token reviewed in it. Both
historical endpoints must match its code hash before an approval or transfer
amount is qualified. The internal review ID is the complete manifest ID and
`upgradeable` is false; no v2 profile or new public field is invented. The
manifest's reviewed standard-transfer, nonrebasing and nonupgradeable claims
remain mandatory. This does not admit proxies or arbitrary readable tokens.

Minted NFT identity, transaction identity, canonicality, status and gas are
preserved. Token amount fields describe observed transfer events under the
reviewed behavior assumptions; their basis is explicit:

| `amount0Basis` / `amount1Basis` | Corresponding amount |
| --- | --- |
| `admitted_standard_transfer_events` | Raw event quantity for a matched reviewed immutable token |
| `reviewed_proxy_transfer_events` | Raw event quantity for a proxy with matching reviewed historical endpoints |
| `token_review_changed` | null |
| `token_review_unavailable` | null |
| `legacy_token_review_unqualified` | null |
| `native_net_unavailable` | null |

Matching before/after block identities **cannot exclude a transient same-block
upgrade and restoration**. Proxy event amounts do not prove a transaction-level
balance trace or include separately accrued token rewards. Unmatched identity
never gets relabeled as a trusted standard-transfer amount. Native net spend and
refund remain unavailable in public receipts; controlled local-fork deltas are
separate experimental evidence.

For successful approvals, changed or unknown legacy token evidence moves the
operation to attention; unavailable evidence leaves it pending. Both retain the
finalized nonce/receipt evidence and the reservation. Finalized reverts and
independently proven cancellation behavior retain their existing handling.
With its matching v1 review and canonical event, a finalized approval confirms
and returns the operation to draft (or completes a requested cancellation).
An approval previously stuck under the empty v1 guard can be reconciled again
with the exact manifest, retaining its issued artifact, nonce and history.
This task does not resolve all older #41 nonce/disposition and capacity findings;
those remain separate blockers for public activation.

Stored artifacts and raw historical receipts are not rewritten. Legacy v1
artifacts remain parseable. Old amount labels without bound identity evidence
project as unavailable rather than gaining retroactive review. A v2 manifest
may retain up to 32 prior profiles in `reviewArchive`; these can verify old
receipts but cannot authorize new deposits. Preserve that archive when retiring
a profile. Reconciliation does not reinterpret an old review ID as a new one.
The v1 guard binds only the manifest loaded for that preparer, not an archive of
arbitrary older manifests. Keep that review available while its issued steps
are unresolved. A replaced or unknown v1 manifest is not silently remapped to
the current one. Startup still requires a valid active manifest; this fix does
not add an expired-manifest loader or a v1 review-archive migration.

## Resource limits and configuration

The active manifest contains at most 32 token profiles. A selected pair is
admissible only within **36 identity reads and 48 operative reads per endpoint**.
An individually unusable profile is rejected. This reserves room for two-endpoint
historical checks and the protocol/receipt path. Preparation, revalidation and
reconciliation use bounded 160-request adapters; the reconciliation engine also
caps actual calls at 160. The shared deadlines, response-size limits, narrow
method list and no-retry behavior remain in force.

An offline regression measures 145 actual reads for the admitted worst-shaped
historical scan/hint path, including the independent finalized nonce proof
from #41, and confirms a successful receipt. A separate overrun
regression stops at 160 and never returns a false success.

To create a private configuration from the explicitly reviewed candidate:

```sh
backend/.venv/bin/python backend/reviewed_admission_config.py \
  --profiles reports/robinhood-reviewed-token-profiles-2026-09-10.json \
  --output backend/runtime/reviewed-admission.json
```

The helper creates an owned mode-0600 file in a private directory, refuses to
overwrite an existing path, and makes no network request or activation. Validity
ends 30 days after the recorded review, not 30 days after running the helper.
A changed/expired review requires a new reviewed record; rerunning the command
does not renew it. Preserve historical reviews when assembling a replacement.

The existing listener accepts this file through `--admission-file` after release
gates are completed. Preparing the file does not supply `--enable`, provision a
host, activate a worker, connect frontend hooks or grant a wallet permission.

## Consumer coordination

This is another explicit coordinated pre-release migration of the unacknowledged,
undeployed `deposit-v1` **1.1.0-rc.4 candidate**, migrated from rc.3. `walletStep.admission.policyVersion`
accepts `direct_existing_pool_v2`; that policy requires canonical non-native
`tokenReviews: [{address, reviewId}]`. Legacy v1 has null/absent tokenReviews.
`ReceiptPosition` adds the two required basis fields above; three finite errors
are added. Request routes, owner authority and fee policy are unchanged.

OxDecimal owns the frontend handlers/display. The shared package contains exact
schemas, fixtures, validators and types; integration must acknowledge its final
digest before enabling a real consumer. Display a support/unavailability state
with optional details, and never coerce a null amount into zero. Rollback keeps
the service disabled, restores producer/consumer versions together and preserves
operation history, reservations and review archives.
