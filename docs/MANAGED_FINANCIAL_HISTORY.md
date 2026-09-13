# Forward managed financial history (#97)

This internal producer joins #117's canonical journal to #120's V3 compound
receipt verifier and stored, independently qualified event-time prices. It is a
review candidate, not a running service or a new browser endpoint. The existing
`performance-v1` card response still requires null financial fields.

## Pipeline and identities

1. A trusted enrollment selects the immutable owner, vault, managed NFTs and
   reviewed runtime admission. `PerformanceWorker` records a finalized opening
   and bounded forward raw pages. There is no lifetime/global pool backfill.
2. `FinancialHistoryWorker.advance(owner, epoch_id)` captures that same opening
   or consumes one already persisted raw page. `FinancialCollector` observes
   every header's exact position principal, collectible fees, registration/core
   checkpoints, source balances and actual vault holdings. It reads only the
   relevant pool's Swap/Donate/Modify logs and relevant full transaction receipts.
3. Actual V3 calldata determines the compound plan. Immutable opening getters
   determine the eight-pin admission. The real `CompoundReceiptReconciler`
   independently checks the canonical/finalized transaction, source amounts,
   consumption, charge and liquidity increase. An emitted completion alone is
   insufficient. Receipt and transaction rereads must match acquisition.
4. The reducer separates trading accrual, fee realization, reinvestment, actual
   service debits, known external cash movements and unclassified changes.
   Migration 017 stores immutable evidence/deltas and a separate financial cursor
   in the owner-bound `domino_performance` schema.
5. The private financial projection converts these persisted facts through
   `performance_valuation.py` into the existing exact managed calculator. Every
   capital/price/membership boundary is retained; unavailable evidence remains
   unavailable. No frontend hook or public-read field is changed.

V1/V2 openings remain inspectable. A V3 completion without admitted V3 getters
and eight runtime pins cannot advance as verified V3 effects. Known children and
old source reserves remain in the immutable owner's epoch even if the root NFT
leaves. A new NFT holder never inherits that owner's private history.

## What counts as income and capital

For a continuously owned, unchanged position, or an exactly reconciled same-NFT
V3 compound in a donation-free block, collectible trading accrual is:

`pending_after + verified_realized_in_block - pending_before`

This is an integer collectible-accrual convention with the core's Q128 floors,
not a claim to recover pre-rounding theoretical fee allocation. Positive growth
requires observed swaps. Manual/unreconciled liquidity changes, donations, missing
observations or uncertain ownership interrupt attribution. Facts stay available
for audit; they are not relabeled as new earnings. Collecting old opening fees or
waiting reserves does not earn those fees again. Actual service charges are dated
when paid, including charges on opening fees, and occur once.

Capital uses each continuously managed NFT's principal plus pending fees, and
actual vault holdings once. Accounted/source reserves are constituents of those
holdings, not additional capital. Native holdings are a third residual asset in
an ERC20/ERC20 strategy. Out-of-range principal remains capital. Unrelated tokens
outside the declared strategy currencies are outside this calculation's scope.

Observations are finalized end-of-block balances: the previous observation is
held over `[previous_timestamp, next_timestamp)`. This explicit block convention
does not invent intrablock wall-clock timestamps. Different blocks with the same
second have zero elapsed capital duration but retain ordered new credits/debits
following the opening block. A timestamp alone never proves ownership. Leaving
and returning within one block marks lost continuity even with equal endpoints;
reentrant/zero-duration lifetimes remain unsupported for complete APR attribution.
A canonically inactive child no longer contributes NFT principal; its retained
fee reserves still contribute through the one residual bucket.

Actual pair-token transfers are acquired even without a vault/NFT event. Known
withdrawals and recoveries are not new service charges. Native net balance changes
cannot establish gross deposits/withdrawals without additional trace evidence,
including offsetting transfers within a block. Consequently complete external
flow totals remain unavailable; dated known movements are retained separately.
No balance increase is inferred to be trading income.

GasUsed × effectiveGasPrice is raw receipt evidence, not qualified full L2 cost.
Operator costs remain unavailable without full cost coverage; operator-funded gas
is never deducted again from the strategy's service cut. Swap/Domino receipt
attribution awaits those executor paths and must not be inferred from V3 self
compound support.

## Persistence and bounded work

Financial heads/pages use forced owner RLS and isolated collector/reader roles.
Openings/page contents are immutable. Writes fence both raw revision/generation
and financial revision; raw progress and financial progress are independent.
A failed acquisition preserves the financial cursor/opening. A conflict cannot
be replaced with a stale failure write. Reorg generations retain old audit rows
but the current reader cannot mix them into a new generation. Readers use one
repeatable-read snapshot. SQL counts and byte totals are checked before fetching
page JSON, and the parser checks its own bounds again.

One worker step permits at most 2,048 shared read-only RPC requests, including all
state observations, receipt verifications and final rechecks. Raw pages contain
1–16 blocks (default 4); raw-page sizing must be qualified with member count and
actual provider budget before scheduling. An oversized persisted page fails
without advancing; this version does not silently split or drop its observations.
There is no polling loop, scheduler, signer, gas estimate or send method here.

One financial read is limited to 4,096 pages/16 MiB of deltas and the calculator's
record/segment limits. These are failure bounds, **not** evidence that a full day
on a high-frequency chain fits. Incremental materialization, retention/replay
capacity and visible-card 30–60 second refresh budgets must be qualified before
production. Exhaustion never becomes a truncated complete APR.

Migration 017 is applied only by the task-local test setup in this change. The
staging package explicitly permits its exact filename as inert source, with a
separate hash. The foundation installer still applies 001–014 only; no performance
schema, role, listener, SQL migration, VM service or flag is activated by packaging.

## Remaining integration gates

The [event-time valuation document](MANAGED_EVENT_TIME_VALUATION.md) records why
the current production price registry is empty. Arbitrary addresses, successful
RPC reads, stablecoin symbols and target-pool prices do not qualify independent
USD history. A selected pool's complete currency set needs reviewed causal
mapping, actual source coverage and freshness; qualification is not fabricated
by this implementation.

Before numerical card data can be exposed: review and integrate the dependency
PRs and this producer; qualify actual prices and refresh capacity; bind approved
enrollment to the owner epoch; finish known/failed attempt recovery and the
supported execution-effect paths; publish a separately reviewed numerical card
contract/fixtures/pin and obtain Decimal's consumer acknowledgement. The existing
wire contract is unchanged apart from its exact producer-source hash. Its fields
must not be repurposed while Decimal builds against the null-only candidate.

A complete rolling day may produce observed fee APR. Shorter complete history
reports measured fees/time, with no projected APY or token-price P&L. UI warmup
never changes an executor's economic decision or resets after a failed read.
