# Reviewed-token composition — rc.4 handoff

PR #46 composes reviewed immutable/proxy admission with PR #43 Nitro fees and
PR #41 recovery. **Deposit-v1 moves from `1.1.0-rc.3` to `1.1.0-rc.4`.**
The old header is rejected; producer, BFF, closed schemas, runtime validators,
types, fixtures and manifest must move together. This is a disabled candidate
with a new consumer ACK pending, not an activated token manifest or wallet flow.

## Consumer changes

`walletStep.admission.policyVersion` can be `direct_existing_pool_v2`, whose
`tokenReviews` bind exactly the non-native currencies in canonical PoolKey
order. V1 cannot claim a token review. Every fresh or repeated wallet handoff
is revalidated before delivery; denial preserves any already issued nonce and
artifact. Session admission, generation, CSRF and expiry still apply around the
provider work and final serialization, including revocation followed by regrant.

Receipt positions require `amount0Basis` and `amount1Basis`. Only
`admitted_standard_transfer_events` and `reviewed_proxy_transfer_events` permit
non-null amounts. Native net, changed/unavailable review and legacy unqualified
evidence return null with the corresponding basis. Retain the verified NFT,
observed transaction and Nitro gas even when token amounts are unqualified.
Proxy endpoint checks are a stated assumption; they do not prove there was no
transient same-block upgrade or establish transaction-level balance changes.

Handle `deposit_token_changed` (409), `deposit_token_restricted` (422) and
`deposit_token_check_unavailable` (503) by stopping the signature procedure.
Such rejection cannot cancel a wallet transaction already handed off. Recovery
retains selected-limit breaches, persistent cross-nonce conflicts and unknown
hashes, initial finalized receipts/reorgs, allowance observations and quotas.
Neither a matched token review nor a qualified mint clears another-nonce effect.
Nitro `l1FeeRaw` remains included in gross gas and `totalFeeRaw` remains null.

## Composition proof and gates

The bounded scan regression now measures **145 requests**, including #41's
independent finalized nonce read and72 token-identity reads; both engine and
transport remain capped at160. A separate exhaustion test cannot return a
successful receipt. HTTP/real-PG tests preserve issuance through denied session
or token revalidation; combined recovery tests exercise proxy review bases,
Nitro fee operands, cap breaches and durable other-nonce conflicts. See the
PR handoff for actually run full-suite counts and package manifest hashes.
Migrations001–014 and capacity maintenance remain unchanged by this increment.
Read/session/onboarding packages retain the composed upstream behavior; any
source-pin changes are explicitly regenerated, not represented as a wire change.

The [profile policy](REVIEWED_TOKEN_ADMISSION.md) and
[implementation evidence](../reports/UPGRADEABLE_ADMISSION_IMPLEMENTATION.md)
describe the dated September10 qualification. This composition did not rerun
live forks, send real transactions or create a production admission file.
Before activation obtain the exact version/digest ACK and independent review,
verify the affected wallet and receipt hooks, and finish HTTPS staging and
operator admission gates. Rollback disables worker/listener and restores
matching packages while keeping unresolved private evidence. Archived profiles
may support historical receipt interpretation; they never authorize a new
wallet handoff. Never drop history or reissue a mint to work around a denial.
