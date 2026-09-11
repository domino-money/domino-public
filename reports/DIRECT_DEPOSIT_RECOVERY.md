# Direct-deposit recovery corrections — #40 / #41

This disabled deposit-v1 1.1.0-rc.2 candidate addresses the review of
`3a7314d9292067281332b4e102c2e4b4eca4455c`. The existing direct-deposit base remains
#39. No listener, wallet, provider or production database is activated.

## Result

A same-effect replacement at the issued nonce now records the actual finalized
mint/approval/revert even when the wallet exceeds selected gas/fee limits. The
receipt exposes the observed envelope and exact `selectedLimitsExceeded` list.
Prepared artifacts still enforce selected limits. Actual gas usage and paid price
must fit the observed envelope; receipt/log/NFT, canonicality and finality checks
remain required. Reorgs retain the initial evidence and any newer reservation.

A reported exact-call transaction at another nonce records sticky conflict
evidence and blocks terminal completion, cancellation and supersession. Identity
is checkpointed before later fallible reads. If authentication, deadline or DB
failure prevents that checkpoint, a later missing unclassified hash still holds
the reservation. A hash previously identified at the original nonce can disappear
after a speed-up without blocking its verified replacement. Unknown hints are
never silently discarded; malformed missing identity fields are not null values.
The canonical scan may identify a reported hash absent from the RPC hash index.
Unsupported same-call envelopes also cannot prove the mint did not execute.

There is deliberately no automatic adoption of a different nonce or conflict-clear
procedure. Such cases need audited chain resolution; preparing another mint while
that evidence remains unresolved is prohibited.

Migration014 replaces bounded expiry under the existing global capacity lock.
Each creation can reclaim at most32 rows older than7days with no issued history
and no outstanding artifact, across every owner. One eligible caller slot and one
global active-draft slot are reserved; the rest advance oldest-first. Tests reach
both real limits (10,000 active and50,000 retained), including absent owners,
active-slot starvation by cancelled rows, mixed evidence and concurrent retries.
The trusted DDL role may be NOSUPERUSER/NOBYPASSRLS. Forced owner RLS, the limited
service role, transactional counters and rollback remain enforced. Migrations009
and010 are not rewritten by this correction.

Issued terminal evidence remains online for at least90days. The existing explicit
operator archive must durably write and verify private evidence before reclaiming
those rows. Owner quotas remain16 active/128 retained and global limits remain
10,000 active/50,000 retained. A heavy owner can still reach its retained quota;
this is a documented product limit. Archived allowance history is not available
through online operation lookup; maintain private archive lookup and backups.

## Validation

The full combined backend suite passed **826 tests, zero skips**, using isolated
PostgreSQL and native Anvil. The bridge passed **525 tests, zero skips**; native
Forge passed **4 tests** including512 fuzz runs. Strict deposit TypeScript,
all five contract/OpenAPI exporter checks and repository hygiene passed.
The pinned npm Forge shim and root-relative compiler path are unsuitable on this
host; the local Solidity check invoked the pinned native Forge from `contracts/`.
CI separately validates the repository launcher in its supported environment.

Independent regressions passed **25 tests** using the real receipt reconciler,
service and durable PostgreSQL store, including HTTP projection; only chain/auth/
preparation inputs are synthetic. The 14 capacity tests include10,000 active and
50,000 retained rows. All these tests are included in the826 total; counts are not
additive. Independent source review also checked maintenance privileges and hint
checkpoint failures; the missing-target finding was fixed and regression-tested. Earlier baseline red runs reproduced the
selected-cap bug, global saturation and first-observation interruption bug.
Contract tests mirror envelope/conflict semantics in Python and JavaScript.
Migration tests cover limited roles, lock concurrency, replay and backup/restore.

## Integration

Consumers must acknowledge the rc.2 manifest and display actual receipt outcome
plus selected-limit breaches. Old headers are rejected by closed workers/producers.
Legacy stored receipts project `transaction:null`; legacy steps project an empty
conflict list. Rollback disables the worker/listener and preserves unresolved
history while restoring matched producer/consumer versions.

The stack still needs ancestor integration and external review. Preserve #46 token
admission, #43 gas accounting and the separately reviewed session contract when
combining branches; regenerate contracts on that combined head. These tests do
not establish consumer ACK, deployed staging, token qualification or activation.
