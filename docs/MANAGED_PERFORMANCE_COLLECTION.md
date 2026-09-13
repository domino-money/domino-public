# Canonical managed-performance collection candidate (#97)

This candidate acquires and persists forward observations for a managed E2 vault
and exposes an owner-authenticated card projection. It does **not yet produce live
fee income or APR**. The financial receipt adapter from #89, implemented compound/
Domino effects from #88, and qualified event-time valuations must complete the
evidence consumed by [the #96 calculators](APR_METRICS.md). OxDecimal owns frontend
integration (#2), following review and acknowledgement of the new contract.

## Acquisition boundary

`PerformanceWorker.capture` establishes one finalized, end-of-block opening. A
trusted internal release adapter supplies the owner, vault, complete active NFT IDs
and admitted vault runtime hash. The collector verifies chain 4663, vault owner,
canonical Uniswap managers, active membership, root ownership/child custody and
range/pool binding. Historical calls use EIP-1898 block hashes with
`requireCanonical: true`; numeric headers are rechecked before accepting evidence.
The dependency bytecode is pinned. These identity checks do not replace reviewed
token/proxy/deployment admission.

The epoch ID binds chain, owner, vault and opening block hash. The registration
checkpoint is separate from the observation start: this does not reconstruct
history since deployment. Existing principal, unsettled fees, vault holdings,
accounted currencies and native balance are opening observations, **not new
income**. Unaccounted holdings may include donations. Balance differences and
price changes never prove trading fees.

Each `advance` acquires one bounded page after the durable cursor: contiguous
finalized headers, filtered vault/position/pair-transfer logs, and complete
receipts/transactions for discovered relevant hashes. No unrelated transaction
receipts are fetched. Full receipts preserve even unrelated logs inside a relevant
transaction. Ordering includes block, transaction, global log and receipt-local
ordinal, including identical timestamps. Event identity binds chain, transaction
hash and local ordinal; block hash is a separate inclusion identity, preventing a
re-included transaction from becoming a second canonical event.

Root transfers and transfers into/out of the vault retain raw order. Closing the
financial owner epoch and attributing its earned amounts still require the
financial adapter. A later holder cannot read the earlier owner's journal through
the private endpoint.

The RPC's finalized tag and log completeness remain provider trust boundaries,
not consensus proofs. Receipt/query cross-checks detect disagreement inside
discovered transactions; omission of an entire transaction is not detected.
Reverted actions without logs, native internal transfers, earned origins, changed
membership valuation and actual charges need #89's attempt/effect reconciliation.
The collector never asserts complete income coverage.

## Persistence and recovery

Migration `016_managed_performance.sql` adds private `domino_performance` epochs,
pages, receipts, events and transitions. Number 015 is reserved by #114. Apply 016
as the trusted DDL owner; preflight rejects foreign ownership, unsafe role
attributes and role memberships. `domino_performance_collector` writes;
`domino_performance_reader` has SELECT only. Both have forced owner RLS and no
session/deposit role membership. Service credentials stay internal; the
authenticated application derives the wallet owner.

RPC acquisition finishes outside the atomic page transaction. Revision fencing
prevents a slow worker overwriting newer work. Exact duplicate commits are
acknowledged without another inclusion; different content at one cursor is
rejected. Read failures append a sanitized transition while preserving the opening,
cursor and observations. **No timer resets.** Without a new finalized block, no
state changes; a previous failure clears when a new page succeeds.

A confirmed reorg marks old inclusions noncanonical while preserving their audit
history. A still-canonical opening permits replay under a new generation. A changed
opening makes the old epoch terminal `baseline_reorged`, requiring a new trusted
capture. Missing baseline confirmation is a read failure. PostgreSQL restore
preserves revisions and unresolved state; the next acquisition rechecks its cursor.
Restore itself does not qualify history.

## Private card contract

The additive [`performance-v1`](../api-contracts/performance-v1/README.md) candidate
is `1.0.0-rc.1`. The disabled factory defines
`POST /internal/performance/v1/cards`, with `X-Domino-Performance-Contract`.
There is no new CLI, listener port, bridge, deployment mapping or scheduler.

Requests contain only `{ "epochIds": [...] }`, at most eight unique IDs. Existing
Access/origin/CSRF/SIWE/admission checks precede the read; session validity is
rechecked before delivery. Foreign and unknown IDs return the same `not_found`
card. Raw openings, logs, receipts, SQL details and provider credentials are not
exposed. Responses carry `no-store, no-transform`.

The future managed-enrollment adapter must return the server-created epoch ID to
the owner's position record after trusted capture. This candidate has no public
epoch-creation/listing endpoint; a bare NFT ID or a previous holder's epoch cannot
substitute for that admission/binding step.

Tracked cards contain identities, opening/observed blocks, revision, replay
generation, observation counts and a separate collection state:

| Condition | Status / reason |
| --- | --- |
| Current forward observations | `measuring` / `forward_observations_only` |
| Latest read failed | `stale` / `latest_read_failed` |
| Snapshot older than 120 seconds | `stale` / `snapshot_stale` |
| Opening retained, replay needed | `partial` / `canonical_replay_required` |
| Opening reorganized | `unavailable` / `baseline_reorged` |

`observedSeconds` is the raw cursor span, **not qualified financial coverage**.
All current cards have `performanceStatus: unavailable`, reasons
`financial_receipt_adapter_required` and `event_time_valuation_required`, twelve
required literal-null financial metrics, `complete24h: false` and
`executionAvailable: false`. Python/browser validators reject injected financial
numbers and extra qualification flags. Qualified financial values require a
future reviewed contract revision.

## Budgets and refresh

Cards batch-read persisted state without blockchain acquisition or a value cache.
Every request sees the current durable revision and reauthorizes. The existing
boundary permits two concurrent requests, a 20-second total deadline and durable
quotas of 10/wallet, 20/IP and 60/global per minute. Request/response caps are
2/32 KiB. The suggested visible-card batch refresh is 30 seconds while measuring,
otherwise 60. Eight cards in one batch use two private requests/minute per wallet.
This arithmetic is **not a qualified production SLA**: session admission may read
RPC, collection has separate work, tabs need coalescing and finality affects age.

Collection defaults to four blocks/page (maximum 16), 1,024 RPC calls/step
(configurable up to 2,048), 256 discovered transactions, 4,096 logs and about 4 MB
of JSON. Headers allow up to 4,096 transaction hashes per block; only relevant
receipts are acquired, each capped at 256 KiB. Incremental budgets limit memory
before accumulation. Oversize results fail without truncation or advancement.
These development caps need real-activity/provider benchmarks before release
scheduling. Callers must apply the existing read deadline and serialize each
collector instance. There is no all-wallet polling or catch-up daemon here.

## Remaining acceptance

| #97 requirement | Result / dependency |
| --- | --- |
| Forward opening; old fees remain opening | Implemented; production capture admission pending |
| Canonical relevant events/receipts | Implemented with stated RPC completeness limits |
| Origins through swaps/children, actual costs counted once | Pending #88/#89 financial effect adapter |
| Full child/residual/out-of-range capital over time | Opening retained; interval ledger and qualified prices pending |
| Owner close and same-timestamp monetary attribution | Raw order retained; financial close adapter pending |
| Failure, duplicate, restart, reorg and restore isolation | Implemented; PostgreSQL and local EVM evidence |
| Private contract, fixtures and pins | Candidate for independent review and Decimal ACK |
| Qualified refresh and visible individual APR | Pending source budgets, financial adapter and frontend integration |

The issue stays open. UI observation warmup does not gate executor economics.
After a complete valued rolling day is proven, #96 can produce observed gross/net
fee APR. Shorter history retains actual fees and duration. Token-price P&L,
operator gas and projected APY remain separately named metrics.
