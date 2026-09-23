# Automation cycle — delivery record, 21 September 2026

What [V4_AUTOMATION_CYCLE_POST_DEPLOY.md](../docs/V4_AUTOMATION_CYCLE_POST_DEPLOY.md) asked
for, what exists now, what was validated and how, and what is still open. The spec's
own closing rule applies: this delivery is a **library** and an **integration tested on
a disposable chain and database**. It is **not an active service**. Nothing in the
repository configures, funds, admits or starts it, and the mainnet profiles keep
`executionAvailable: false`.

## Deliverables (spec §10)

| # | Asked | Delivered | Where |
| --- | --- | --- | --- |
| 1 | Observation/history producer and economic evidence adapters | Admission derived from the verified deployment and checked link by link; the planner's `Observation` read at one block hash with the ledger offered only where the vault's fee balances agree; a pool fee/liquidity sampler with epochs and coverage; price qualification against Chainlink USD feeds on the chain; depth/activity bounds over the sampled window; exact swap quotes by walking initialized ticks with the core's step math; complete-path gas (publication + execution + the node's L1 data component) converted to the quote asset | `automation_observer.py`, `automation_evidence.py` |
| 2 | Planner integration with plan construction, reservation and persistence | `Candidate` → `ExecutionPlan`, proved against `validate_candidate` and the V4 wire before persisting; the anchor's on-chain id computed offline and persisted with the intent (`commitments.priceObservationId`); reservation through the existing store | `automation_plan.py`, `execution_store.persist` |
| 3 | Publisher worker and restricted signer, journal, anchor bound to the cycle | `PublisherSigner`: `publish(Observation)` for the admitted guard only, rebuilt before signing, qualified by simulation to the exact id; `PublicationJournal`: signed bytes persisted in the same transaction as the nonce claim, one row per observation id, send/check/recover; `domino_execution_publisher` role | `publisher_signer.py`, migration 028 |
| 4 | Orchestrator linking publication to the executor/reconciler | `SequenceCycle`: lease per sequence, evaluate without transacting, re-plan at a fresh head, persist → reserve → publish inside the source-block window → executor step with the intent-bound anchor → reconcile; every transition durable before its side effect; costs recorded from receipts | `automation_cycle.py`, `automation_store.py` |
| 5 | Versioned configuration, installation, limits, metrics, alerts, runbook | Strict private configuration with every parameter explicit and a `configVersion` on every cycle; CLI `status`/`evaluate`/`run-once`/`serve`/`pause`/`suspend`/`publications`; runbook with installation, pass anatomy, failure table and activation steps | `automation_config.py`, `automation_cli.py`, [runbook](../docs/AUTOMATION_CYCLE_RUNBOOK.md) |
| 6 | Integrated tests, fork evidence, limitations, controlled activation | Offline suites for every module and a disposable Anvil + PostgreSQL suite driving the whole cycle with restarts, contention, a lost reply, a lost window, a revoked anchor, a moved price, an unfunded signer, pauses, a reorg and an exact swap-quote replay | `backend/tests/test_automation_*.py`, `test_publisher_signer.py`, this record |

## Approved rules preserved (spec §3)

Tariffs stay 200/400 bps, charged once on consumed original fees, by the existing
contracts and planner; the cycle adds no rate. Internal swaps carry no extra fee; their
DEX cost and impact enter the planner as `swapLossQuote`. Only the sequence's own
tracked lots and accruals are offered, and only when the vault agrees with the ledger.
Gas is the company's ETH, funded manually: the cycle refuses to start a pass below the
configured minimum balance of either signer and never touches the fee recipient's key.
The guard band is what the deployed contract says; the cycle publishes the pool's spot
at the source block and never a substituted price. Publication happens only for a plan
the planner selected and the builder proved; a wait publishes nothing. M-1/M-2/M-3 are
untouched: no contract, artifact or manifest changed for this delivery.

## How the decision varies (spec §4)

The planner is the one that existed; the cycle feeds it what it lacked. Balances come
from settled origins minus spends, with other intents' active claims as the reserved
part. Gas is the complete path, publication included, at the head's buffered base fee
plus the L1 component, converted through the same references at the operator-adverse
bound; the plan's `maxGasCostWei` is the smaller of the owner's limit and the
configured cap, a separate number from the envelope ceiling the signer enforces. Swap
quotes are exact for the observed block and carry the engine's own minimum-output
floor; the planner's M-2 prefilter and the engine's full-consumption bound remain the
gates. The 15 % operator buffer is `operatorCostBufferBps: 1500` in the configuration,
versioned, not inferred.

One thing the integration found and the plan builder now does: the planner sizes a
candidate to spend the selected funds exactly at the observed price, but the execution
adds liquidity after its own swap has moved the price and settles with round-up, so an
exact plan is short by a few units on the sold side and the engine refuses it with
`InvalidAmount()` before anything is spent. The builder re-simulates the swap, sizes
the addition at the price the swap leaves, keeps `plan.liquiditySlackBps` back so the
caps have room, and refuses a swap whose actual output would not be consumed by that
addition; the orchestrator then tries the planner's next eligible candidate - a smaller
swap or the direct addition - instead of publishing for a plan that cannot execute.

## Failure behaviour (spec §8)

Covered by the integrated suite where a disposable chain can produce the situation:
insufficient history and uneconomic candidates wait without a transaction; a signer
below its minimum refuses before spending; a lost source-block window abandons the
unsigned intent; a revoked anchor and a price outside the plan band are refused by the
executor before the key is used, with the intent cancelled and the publication's cost
on record; a lost broadcast reply recovers the same publication; a crash after the
publication was signed, and after the execution was submitted, resumes with the same
bytes and one receipt; two workers cannot lease one sequence; the operator pause and the
owner's pause both stop new work; a reorg after a completed cycle is detected through
the vault/ledger disagreement, recorded as `reorged` by the executor and suspends the
sequence for operator reconciliation. Not producible on Anvil and therefore not
claimed: real sequencer inclusion latency against the 255-block window, a real
`finalized` lag, an execution that reverts after signing (the executor's own suite covers
that path).

## Validation

Offline, no chain and no database (`python -m unittest`):

- `test_automation_config.py` (6): the private configuration parses only when complete,
  refuses unknown and missing fields, duplicate JSON keys, a shared key file and bad
  planner numbers; the plan band and the gas estimate arithmetic.
- `test_automation_plan.py` (6): direct, netting, swap and successor candidates become
  plans that pass `validate_candidate` and rebuild on the V4 wire; a swap quote with a
  route commitment made for another price limit is unrepresentable; the liquidity slack;
  the observation point and the guard's id preimage; the publish calldata.
- `test_automation_evidence.py` (10): the tick-bitmap walk against a brute-force search
  on random bitmaps; the swap simulator against the core step math on one range and
  across a range boundary, with partial fills refused; the contract's ratio and
  minimum-output arithmetic; reference qualification (fresh, stale, divergent, wrongly
  configured, missing); gas conversion through the native reference; full evidence
  letting the planner choose; the sampler's epochs, gaps, same-second readings and
  zero-liquidity restarts; the history's coherence rules.
- `test_publisher_signer.py` (4): policy and point shapes; qualification against the
  current publisher, the source window and the simulated id; envelope caps; signing
  that rebuilds from the point and refuses a handed envelope.

PostgreSQL, actual roles (`DOMINO_TEST_POSTGRES=1`):

- `test_automation_store.py` (3): one lease per sequence with a fence every write
  needs, the same worker resuming its own lease, tenant isolation, cycle immutability
  and terminal states, shared samples and controls, the worker's read-only view of
  publications without their signed bytes.

Anvil and PostgreSQL together (`DOMINO_TEST_EVM=1`), `test_automation_cycle_evm.py`
(7, about 95 s), on the V4 fixture stack with a competing position, fixture USD feeds,
a fixture node interface at `0xc8`, a 1 wei base fee, the publisher rotated to a
synthetic key through the guardian, and the owner's policy at a 1 % trigger distance:

1. Without history the cycle waits and publishes nothing; with history it publishes one
   observation from the publisher key (the guard's stored point equals the plan's source
   block, hash and price), reserves one intent bound to that id, signs one attempt,
   parks at `executing` before finality, resumes without new work, reconciles once with
   its gas costs on the cycle, moves the waiting interval to the receipt block, and runs
   a second cycle from ledger lots plus fresh accruals with the vault and ledger agreeing.
2. A crash after the publication was signed, and another after the execution was
   submitted, resume with the same bytes and nonce: one publication row, one attempt,
   one effect.
3. A lost `eth_sendRawTransaction` reply leaves `broadcast_unknown`; the check finds
   the receipt and the cycle continues with the same publication.
4. A second worker cannot lease the sequence; the operator pause skips; an unfunded
   publisher is refused before any transaction; the owner's pause makes the planner
   wait; nothing is published or reserved in any of those.
5. Thirty-two blocks between planning and publication lose the window
   (`publish_publisher_source_window`), the unsigned intent is cancelled; a revoked
   anchor (`anchor_revoked`) and a 5 % price move (`price_outside_plan_band`) after
   publication are refused before signing, with the intent cancelled and no journal row.
6. A reverted chain after a completed cycle: the ledger disagrees with the vault, the
   executor records `reorged`, the effect loses canonicality, the sequence is suspended.
7. A swap cycle: the chosen plan's swap output, replayed with the tick walk at the
   source block and the plan's own price limit, equals the engine's `FeesConverted`
   output exactly; the swap input equals the plan's.

Also run: the existing `test_execution_store.py`, `test_execution_runner_v4_evm.py`
and `test_execution_runner_evm.py` suites (the intent store now carries the anchor;
the private signer CLI prefers it), the offline adapter/model/planner suites, the
staging upgrade tests with migration 028 registered, `export-execution-contract.py
--check`, repository hygiene (0 findings) and contract hygiene (clean).

Not run, and not claimed: anything against the mainnet deployment or the own node.

## Open before activation

- **Ledger completeness.** Delivered on 22 September, see the addendum below. The
  ledger now also learns from the vault's own fee events: owner withdrawals become
  debits, and an execution the ledger cannot represent becomes an exception for the
  operator instead of a silent wait.
- **Reference feeds per pool.** Only currencies with an admitted Chainlink feed on 4663
  qualify. WETH/USDG and ETH/USDG have feeds in `chainlink_history.FEEDS`; every other
  pool waits by design until a reference is admitted and qualified.
- **Timing on the real sequencer.** The guard admits a source block for 255 blocks,
  measured at 15–37 s on the live node. The cycle bounds itself with
  `maxSourceBlockAge` and refuses late publication, but the achievable margin with the
  real tunnel, real inclusion and the executor's qualification is an activation
  measurement.
- **Gas units on the deployed contracts.** The configuration carries measured units from
  the gas funding study; re-measure them on the V1 addresses before activation.
- **Successor economics.** `successorActiveFractionBps` is an explicit operator
  assumption for a range that is not active yet; the integrated suite drives the root
  path and leaves MINT to the executor's suite and the offline plan tests.
- **Host installation.** Role mappings, the systemd unit and the private files follow
  the financial services' pattern but are not scripted here.

## Addendum, 22 September 2026: the ledger's reader of vault fee events

What the first delivery left open as the next piece for unattended operation. The
vault's fee balances move through exactly two paths: the executor (`executionCredit`,
`executionConvert`, `executionApply`, reported by the engine's `FeesRealized`,
`FeesConverted` and `BudgetApplied`) and the owner's `withdrawFeeReserves`, reported by
the vault's `FeeReservesWithdrawn`. The executor's own reconciliation already records
the first path for the transactions it signed. The reader (`backend/automation_ledger.py`,
migration `029_ledger_index.sql`) covers the rest from finalized blocks, one sequence at
a time, from a durable cursor:

- An owner withdrawal becomes a `withdrawals` row (the chain fact: source, currency,
  original and charged amounts, block, state nonce) with `withdrawal_debits` attributing
  it to the ledger's lots by one documented convention: original amount to original lots,
  charged amount to converted lots, the oldest available lot first, quarantined lots
  after, never more than a lot still holds. What the lots cannot absorb stays on the row
  as unattributed, so a withdrawal of money the ledger never knew keeps the disagreement
  visible instead of hiding it. The planner's view (`available_lots`), the claim guard and
  the spend guard all count the debits.
- An execution transaction whose events appear on the chain is checked against the
  journal by hash: a reconciled canonical effect of ours is verified and passed over; one
  of ours still pending in the journal holds the reader before its block; anything else
  (`foreign_execution`, or `unreconciled_execution` for a transaction we signed whose
  journal ended in `attention`, `reorged` or a different intent) is a `ledger_exceptions`
  row that suspends the sequence (`ledger_exception`) until an operator records what the
  evidence supports and acknowledges it. The reader does not invent lots or lineage for
  an execution it did not reconcile.
- The cycle reads before every evaluation when `ledger.indexer` is `inline` (the service
  user then also holds `domino_execution_ledger`); `external` leaves the reading to an
  `index` run. New CLI operations: `index` (with `--from-block` for an explicit rescan),
  `ledger`, `acknowledge`. `status` reports the cursor, the latest withdrawals and
  exceptions.

Two things found while integrating and fixed with it: the chain reader's request budget
was never reset between passes, so a long-running `serve` would have refused every read
after its 4096th request; it is reset at the start of every pass and status read now. And
a constraint deferred to commit could leave a store connection open; the store closes
its connection in every case.

Validation, all on the disposable chain and database:

- `test_automation_ledger.py` (9, offline): first pass starts the cursor at the
  finalized head and reads nothing; a withdrawal is recorded at its receipt position
  with the block-scoped log index kept as evidence; the window is bounded and `catch_up`
  repeats it, a rescan never moves the cursor back; an own reconciled execution is
  verified and a pending one holds the cursor until reconciled; foreign, attention and
  wrong-intent transactions become exceptions with their events on record; off-canonical
  logs, reverted receipts, receipts missing the log, another owner's withdrawal, a log
  budget and finality moving back are refused with nothing recorded; the configuration
  refuses an absent or unknown `ledger` section.
- `test_automation_ledger_store.py` (5, PostgreSQL with the actual roles): the oldest
  lot is debited first and the planner's view follows, the same event is the same row, a
  changed amount is a conflict, excess is unattributed, another tenant sees nothing; the
  claim guard and the signer's spend guard refuse one unit past the debited lot
  (deleting either guard's new line fails the test); withdrawals and debits are
  immutable by privilege for the reconciliation role and by trigger for everyone, a
  debit past the lot and a withdrawal without matching debits are refused, the worker
  reads and never writes; exceptions are recorded once and acknowledged once; cursors
  move forward only and are tenant-scoped; the reconciliation role cannot read signed bytes.
- `test_automation_cycle_evm.py`, one more scenario (8 in all, about 120 s): after a
  completed cycle the pass following reconciliation verifies our own execution's events;
  the owner withdraws half of one source's original reserve; before finality the planner
  waits on `ledger_chain_mismatch` and the sequence is not suspended; after finality the
  withdrawal is recorded with the exact amount, source, currency and transaction, the
  ledger's lots equal the vault's balance again, status shows the cursor and the row, a
  second read records nothing, and the cycle acts again from the reduced lots.
- Also run: the executor suites, the store suites, the offline automation suites, the
  staging registries with 029, repository and contract hygiene, and the hygiene job's
  steps verbatim.

## Addendum, 22 September 2026: host installation

`scripts/staging/install_automation.py`, documented in
[AUTOMATION_INSTALL.md](../docs/AUTOMATION_INSTALL.md), follows the financial upgrade's
pattern for one component: an immutable source release under
`/opt/domino/financial/releases/<commit>/automation`, the `domino-automation` system
user, an off unit with the financial services' hardening and a `ConditionPathExists`
on the private configuration, migrations 028 and 029 in one receipted transaction
guarded by the financial upgrade's receipt, the publisher role made `LOGIN`, and the
peer rows mapping the service user to the four execution roles. Plan, inspect (baseline),
apply under a root-only lock with a step journal, and a scoped rollback that removes the
unit and restores the peer files while retaining the schema. It creates no
configuration, key or funding and starts nothing. `test_install_automation.py` (5, no
host) runs in the repository-hygiene job. The procedure has not been run on the
production VM as part of this delivery.

## Addendum, 22 September 2026: gas units on the deployed contracts, and the pool's protocol fee

[GAS_UNITS_V1_2026-09-22.md](GAS_UNITS_V1_2026-09-22.md) re-measures the units on the
mainnet addresses, on an Anvil fork of the public endpoint: the study's fork experiment
with the deployed stack adopted (runtime hashes checked against the manifest), twice, and
then the automation cycle itself run end to end on the fork with synthetic keys, a
disposable database and real Chainlink references. The cycle executed a direct compound
and a compound with a swap on the deployed engine, through the whole service path
including the ledger's reader; the successor cycles waited as uneconomic at the
rehearsal's fee volumes and their units come from the fork experiment.

Found on the way and fixed: the live WETH/USDG pool charges a protocol fee (52 pips each
direction on top of the 200-pip LP fee), and the evidence builder refused any pool with a
protocol fee, so on that pool the cycle could never have built evidence or acted. The
swap fee is now composed as the core composes it; the composition is pinned by an
integrated replay of the automation's own swap quote against the engine's output on a
fixture pool with the same fee, which fails with the LP fee alone.

Also found by the repository's CI after the ledger reader landed, and fixed: after a
reorg that removes a completed execution, the observed block predates the waiting
interval the completion had moved to the receipt's block. The planner's history model
refused that window (`future_wait_start`), and the pass's lease release then failed the
sequence row's own check (`waiting_since <= last_attempt_at`), hiding the first error.
The integrated reorg test only passed when the execution landed in the same second as
the snapshot, which the reader's extra work no longer allowed. Now a pass whose observed
block predates the interval restarts the interval at that block, the planner's window is
clamped to the block it is measured at, and a failed release never hides the error in
flight. The reorg test forces the ordering; deleting either clause fails it.

Still open, unchanged from the list above: reference feeds per pool, timing on the real
sequencer, successor economics.

## Addendum, 22 September 2026: new tokens, no price reference

The owner rejected both the Chainlink reference and the calm-market triggers proposed
afterwards: Domino's market is mostly new, volatile tokens, the owner of a vault answers
for the position, and the data must come from the project node and the Uniswap API.
[NEW_TOKEN_AUTOMATION_STUDY_2026-09-22.md](NEW_TOKEN_AUTOMATION_STUDY_2026-09-22.md)
measures what the contracts require, short-horizon price moves, manipulation economics,
balancing needs and the hook census on the node, and proposes the replacement: no
volatility gate, latency as a requirement, the owner's bands, and a per-pool swap cap at
fee × depth. The "reference feeds per pool" item above is superseded by it.

## Addendum, 22 September 2026: the new-token proposal implemented

The owner approved the study's proposal without the hooks. What changed:

- **Prices from the pool.** The Chainlink section of the configuration is gone. The
  anchor is the pool's spot at the observed block; the planner values the other currency
  at the spot plus or minus `pricing.valuationBandBps`. Gas converts one to one when the
  quote is ETH or WETH, and through an admitted native/quote pool, read at the same
  block, for any other quote; a quote without one leaves the evidence unqualified. The
  valuation margin is its own small number rather than the owner's impact limit: valued
  over the impact band, a swap would count about twice the impact of its value as loss,
  and the owners who widen the limit for volatile tokens would see their swaps refused.
- **The owner's band.** The plan's price band is the owner's `maxPriceImpactBps`, with
  the routing helper's rounding: the plan band, the swap's price limit and the engine's
  impact check are one bound. Before, the service kept half of it on the square root, and
  at 50 square-root basis points or more the band's upper edge fell outside the engine's
  bound, since (1.005)² exceeds 1.01.
- **The swap cap.** Every compound swap in a pool, summed over all vaults over the
  swaps observed within 256 blocks either side (the guard's window, since an execution
  lands up to 255 blocks after the block it observed), stays below fee × depth ×
  `swapCap.depthMultiplierBps`. Depth
  is the least running average of L × √P from the spot to the owner's impact bound in the
  swap's direction, walked tick by tick: that is the exact break-even of a push and its
  restore, so a liquidity gap next to the spot zeroes the cap and a far one lowers it in
  proportion. Migration `030_swap_exposure.sql` holds the shares, readable by every
  tenant's worker and written only by its own; a share is reserved under a per-pool lock
  before the intent exists, and given back when the intent is cancelled unsigned. Quotes
  above what the window has left are not offered; the direct addition stays open.
- **Latency.** The act path re-reads only the pool, the vault and the ledger, and
  re-quotes only the destinations the evaluation found eligible. Each cycle records the
  source block, the wall-clock milliseconds of each phase of the pass that acted, the
  blocks to the publication and to the execution, the execution's chain seconds after
  the source and whether that met `scheduling.latencyTargetSeconds`.
- **Timing.** `serve` honours each sequence's due time. It did not before: the runbook
  said it did, but the loop ran every sequence every interval, so the waiting backoff
  never applied. A sequence that is not due is skipped from the database alone, with
  no chain read. Every wait is jittered by up to `scheduling.jitterBps`, from the
  system's random source. After `scheduling.failureBackoffAfter` consecutive paid
  failures (a publication with a receipt) the wait doubles per failure up to the
  maximum, and the operator's expected gas cost carries the publications a completed
  cycle is expected to take: paid attempts plus one over completions plus one, over the
  last 20.
- **App.** The default maximum slippage is 1%.
- Two debugging prints left in the reorg re-check by `7d79e5e` are removed.

An independent adversarial review of the change checked `impact_bounds` against the
helper's `checkSwapPrices` on 200,000 random cases and the cap against an independent
least-running-average computation on 3,000 random pools, and found what is fixed here
before it landed: a configurable window below 256 blocks broke the cap's guarantee; the
reservation guard did not tie a share to its sequence's pool, bound the window above, or
refuse to give back the share of an intent that may still be signed; a cycle opened
before cycles recorded latency would have failed on resumption; a resumed publication
could be counted as a failure without having been paid, or the reverse; the maximum
backoff could be shorter than a normal pass; and a skipped sequence still read its
admission from the chain.

Testing those fixes found two older defects, fixed here as well. A publication signed
and never sent held its nonce: if its cycle was abandoned in the same run, or if the
service came back after its expiry and the expiry check retired it unsent, every later
publication of the key queued behind the gap. A signed publication is now always sent
before anything retires it; a late one reverts at the guard and spends its nonce. And
the keyless `evaluate` command resumed a cycle in flight and, lacking the keys,
abandoned it, even with its publication paid; it now reports the cycle and leaves it.

The integrated suite on Anvil and PostgreSQL covers the race for a pool's last share
between two vaults (the second stops with `swap_cap_exhausted` before any intent or
transaction, and the next pass quotes no swap), the share given back after a failed
persist and after a revoked anchor, the latency record of a completed cycle, the failure
count of paid and unpaid abandonments, and a sequence resumed by the service loop before
its due time. Every guard added here was checked by mutation: deleting it fails a test.

Still open: latency on the real node and sequencer, measured from the first manual
pass; successor economics.

## Addendum, 22 September 2026: a publication the node dropped

A publication that was sent, then dropped by the node and never mined, held its nonce
for good. The journal's head was already past it, so every later publication of the key
was signed with a higher nonce, waited behind the gap and expired in turn. In the running
service nothing drove such a row again (a cycle that stops waiting leaves its row live),
and at a restart the check retired it as `expired`, a state nothing could leave. The key
stayed stuck until someone stepped in.

Two ways out were weighed. The first signs the next publication with the unspent nonce.
That gives one nonce two signed transactions. If the old copy was still held somewhere
and landed first, it would revert at the guard, and the new row would end in `attention`
with `publication_nonce_consumed_without_receipt`: no double publication and no stuck
key, but the signal meant for a key used by someone else would fire on the journal's own
bytes, and the retired row could never record the revert it paid for. It would also need
a migration, since `publications` is unique on signer and nonce. The second way keeps one
signature per nonce and is what the journal now does. Before `prepare` claims a nonce,
`resend_unspent` sends again the same bytes of every row holding a nonce that the chain
has not spent and the node does not hold, live or expired, in nonce order. A late point
reverts at the guard and spends the nonce, and the new publication is mined behind it.
Migration `031_publication_resend.sql` lets an expired row become live again when its
bytes are sent, and in no other way; recovery then records its receipt (`reverted`, with
the gas it cost).

The integrated suite drops a sent publication with automine off. After a restart retires
it as expired, the next cycle's publication is mined behind its revert; without a restart
the row is still live, and the same happens. A row whose nonce is spent, and one the node
still holds, are not sent again; a plain `send` leaves an expired row alone; recovery
records both reverts, and the journal's head ends equal to the chain's nonce. The guard
refuses every other way out of `expired`. Every guard added was checked by mutation:
deleting it fails a test.

Still open: the revert of a publication sent again is not counted as a paid failure of
the cycle that gave it up. The old bytes carry the fee cap of the moment they were signed
(twice the base fee plus the priority fee, within the policy's maximum), so a base fee
that has since more than doubled holds the key back until it falls. A nonce this journal
never signed, such as a transaction sent from the publisher key by hand and then dropped,
still needs the operator.

## Addendum, 22 September 2026: an execution the node dropped

The operator's executor had the same gap as the publisher, through a different door.
With no receipt and its nonce unspent, a step re-sends an execution's recorded bytes
only after requalifying them against the current chain. When requalification failed
(the plan's deadline had passed, the price had left the plan's band, the operator was
unfunded, the owner had acted), the step retired the intent in `attention` with
`execution_revalidation_failed`. Nothing ever sent those bytes again and the sequence
was suspended, so the nonce stayed unspent. Every later execution of the operator key,
for every owner, is signed on a higher nonce and would have waited behind it.
Reproduced on Anvil with the node dropping every send of one execution, both past its
deadline and with the price out of the band before it.

Requalification still guards every re-send while the deadline is ahead. A failure no
longer retires the intent: it waits (`execution_revalidation_pending`), not suspended,
and goes out again when the bytes requalify. Once the plan's deadline is behind the head,
every block refuses the bytes (`validateCompoundPrice` reverts past the deadline, and the
anchor expires with it), so they are sent again as recorded. The engine reverts them,
the nonce is spent, and the canonical revert releases the claims, as for any execution
that reverts. Once they have been broadcast, anyone can re-broadcast the same bytes; the
executor suite already relies on the chain refusing them. A disabled signer sends
nothing. No schema change: the journal's guard does not restrict its states.

The integrated suite covers both paths. In the first, the node drops an execution; with
the price out of the band and the head exactly at the deadline, the intent waits. Past
the deadline, a disabled signer sends nothing, and an enabled one sends the bytes: they
revert, the nonce is spent, the sequence stays active and the next execution lands. In the
second, the node drops an execution while the operator is unfunded; the intent waits,
then lands once funded. Six mutants of the change, including the original code and the
deadline boundary, each fail a test.

Still open: until the deadline passes, a dropped execution that does not requalify holds
the key back for up to the plan's remaining lifetime. Freeing the nonce costs one
reverted execution. The revert is a paid failure of the cycle that made it, with its
backoff.
