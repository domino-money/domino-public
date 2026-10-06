# Historical ledger capacity and recovery

The optional historical audit workers qualify stored core pool activity. Their resource profiles do not admit a pool for execution, establish wallet ownership, provide prices, or make full-history replay a prerequisite for on-demand reads. These commands require an explicitly configured archive-capable provider when actually run. Capacity and recovery regressions use synthetic RPC fixtures, disposable PostgreSQL and an isolated v4 EVM reference. Separate bounded public fee-step measurements and their source coverage are recorded in [the benchmark report](../reports/FEE_STEP_BENCHMARK.md); they do not populate a deployed ledger.

This documentation was originally examined against [PR #54](https://github.com/domino-money/domino/pull/54), commit `973fec82cfa47134b6b45c6a351357b2d5edc86b`. Its capital commands and migration 012 are now integrated into main at `03ec1fad96122ca4cf163fc62da3d866f3e7cd87`, alongside the already merged #29 fee/position resume. Check that the relevant implementation and migrations are present before using its commands. This status update adds no runtime capability, requalification or deployment.

## Resource limits and correctness checks

| Limit | Supported scope | Recovery |
|---|---|---|
| 128 lifetime positions / 256 known ticks | Default `standard` position and capital worker profile | Explicitly select `extended` and resume |
| 1,024 lifetime positions / 2,048 known ticks | `extended` profile | A larger reviewed model is required; no unlimited mode |
| 32 events / 100,000 candidate simulation steps | One fee, position or capital worker batch | Save a complete-event prefix and resume the same stored chunk |
| 8,192 simulation steps | Each individual swap candidate | An event exceeding this limit remains unsupported |
| 128 position/range/tick checks | One position or capital reconciliation batch | Resume the next unchecked identity at the same historical block |
| 160 total RPC requests / 90 seconds | One position or capital CLI worker instance | Fix provider availability, then resume; partial failed batches roll back |
| 60 total RPC requests / 90 seconds | One fee CLI worker instance | Fix provider availability, then resume |
| 8 MiB serialized progress | One unpublished pool/ledger checkpoint | Capacity review; no partial values published |
| 2,000 events | One source activity chunk | Reduce future activity spans; a single over-capacity block needs separate design. A ledger that meets a stored chunk above it records `fee_event_budget_exhausted`, `position_event_budget_exhausted` or `capital_event_budget_exhausted` with `repair_source_then_resume`; reads keep that ledger null as `*_ledger_not_caught_up` |
| 5,000 live aggregate ranges | `standard` activity profile, independent of core identities | Explicitly select the `extended` activity profile and repeat the uncommitted interval |
| 10,000 live aggregate ranges | `extended` activity profile | Capacity review; no larger shipped profile, no truncation or unlimited mode |
| 50 batches | One explicit CLI invocation | Run another bounded invocation with a new report filename |

These are operational limits. v4 uint128/int128 bounds, fee-growth wrapping, tick-spacing alignment, exact swap outcomes, donation/protocol separation, position fee debt, settlement-journal totals and token-asset conservation are correctness requirements and do not change with a profile. The tick-liquidity cap continues to match pinned v4-core revision `46c6834698c48bc4a463a86d8420f4eb1d7f3b75`: its negative minimum tick division is floored. For spacing 60, the cap is `11505354575363080317263139282924270`; using truncation toward zero would incorrectly increase that cap. The unmodified vendored source and its hashes are checked, and the external test harness compares admission against the compiled v4 function.

The replay model retains closed positions and zeroed tick records. A reopened identity must preserve its prior settlement history and v4 last-inside-growth behavior; every cleared tick must still pass the on-chain zero-state check. Removing tombstones alone would not solve the default lifetime-position ceiling: 128 disjoint open/close identities can already occupy 256 ticks. This release supports a larger finite model with batched proofs; it does not implement unbounded identity archival or erase old accounting evidence.

## Planning for lifetime capacity

The limits apply **per pool to distinct keys retained in its canonical replay history**, including unpublished work. They are not a count of wallets, NFTs, events or currently funded positions. Forward replay never removes a position key or a tick key; normal source reorg recovery can replace an orphaned history. Repeated CLI invocations, a new day or a smaller block span do not reset these counts.

| Count | What consumes capacity | What closing or reopening changes |
|---|---|---|
| Core identities: 128 standard / 1,024 extended | Each distinct `(coreOwner, tickLower, tickUpper, salt)` within the pool | Closing keeps the key. Reopening the same tuple reuses it; a different salt, owner or boundary creates a different key. |
| Known ticks: 256 standard / 2,048 extended | Each distinct lower/upper tick retained by any known identity, counted once even if shared | A cleared tick remains a zeroed tombstone. Reopening a previously used boundary reuses that key; clearing it does not free a slot. |

The source of these ceilings is [the capacity profiles](../backend/historical_capacity.py); the counting and retention rules are in [position accounting](../backend/position_accounting.py). For example, 128 different identities sharing one range consume 128 identity slots and only two tick slots. 128 identities with disjoint ranges consume 128 identity slots and 256 tick slots even after every one closes. The next distinct identity exceeds standard capacity; selecting extended allows that 129th identity when all other accounting/resource checks pass. Extended has the same rule at 1,024 identities/2,048 ticks; it is not an unlimited or automatically growing profile.

An operator should use this sequence when approaching or reaching a ceiling:

1. Read `corePositionCount` and `knownTickCount` from a reconciled position report, together with its snapshot/coverage. `nonzeroLiquidityPositionCount` measures live positions and must not be used as remaining identity capacity. A lagging report describes its last qualified history, not every key in the pending chunk. The work table's `processedEvents` is an event offset, not a position/tick count.
2. Inspect that pool's `historical_work` diagnostic and the failing ledger. `core_position_budget_exhausted` or `core_tick_budget_exhausted` under standard has action `select_extended_profile_and_resume`. Keep source events, qualified ledgers and the saved complete-event prefix. Use the existing [resume procedure](#resume-an-already-stored-expensive-chunk), selecting `--capacity-profile extended` on the position and capital workers. Reconcile predecessors before downstream capital.
3. Continue bounded invocations with new report filenames. Keep extended on later invocations and later chunks: changing back to standard cannot accept an inherited model above 128/256, even if the new chunk is empty. Increasing `--max-steps` permits more batches in that invocation; it does not enlarge the model. Successful resumption can still meet a separate simulation, byte, source or valuation limit.
4. If the next event would exceed extended, stop retrying that unchanged input. Its `capacity_review_required` action has **no larger shipped profile, tombstone-purge command or identity-retirement mode** behind it. The affected ledger cannot pass that event with this implementation; its dependent current values remain unavailable while earlier qualified history is retained. The failure is scoped to that pool/ledger; it does not establish zero capital or invalidate other pools' histories.
5. Record the pool, selected profile, reason, source chunk and progress for a capacity change review. A future supported path would require a tested larger bounded model or a separately reviewed retirement/rehydration design. Neither deleting work nor replaying the same complete history from scratch removes its lifetime identities. Do not skip the event, advance the checkpoint manually or truncate history to make it fit.

This explains the narrower [issue #18 acceptance](https://github.com/domino-money/domino/issues/18#issuecomment-5625151665). It does not claim to satisfy the original live-tick-only budget proposal. [Identity retirement criteria](IDENTITY_RETIREMENT.md) identify the outstanding proof before any future implementation can safely reclaim working-set capacity.

The [bounded real-pool step benchmark](../reports/FEE_STEP_BENCHMARK.md) keeps
each dataset, measured scope, busiest examined chunk, acquisition exclusions and
replay command together. Candidate steps include failed candidate attempts, not
only accepted swaps or initialized-tick crossings. The original five sparse
chunks (30 steps at most) and later complete 40-swap lifecycle (240 steps) are
baseline evidence, not a high-load calibration. Synthetic stress proves the
actual 100,000/100,001 boundary and resumability separately from representativeness.
Acquisition failure is unavailable with null measurements, distinct from an
examined empty chunk with zero steps. Do not infer a global busiest pool or a
production service capacity from a bounded sample.

## What is durable and what is available

Migration `007_historical_work.sql` adds one unpublished checkpoint per pool and ledger (`fee` or `position`); `012_capital_work.sql` extends its ledger constraint to `capital`. The existing `dev_postgres.py start` helper applies both after the merged `006_chainlink_prices.sql`, without rewriting 007 or touching qualified rows. Each row records its source chunk, complete-event offset, reconstructed models, pending journal rows, completed proof checks and a diagnostic. No new methodology version is needed: final v1 models and proof fields retain their existing meaning and previously qualified chunks remain valid. Preserve later 008–011 migrations when combining their branches; 012 must follow 007.

The writer holds the existing advisory lock. Before saving progress it rechecks the historical end block and the activity tail; every later batch repeats those checks. Proof calls use a stable sorted order and the same historical block. Only after all events and all required checks succeed does one transaction write the qualified chunk and every fee/settlement row, then delete unpublished progress. Assets still satisfy `lpAssetsRaw = principalRaw + unsettledFeesRaw + roundingResidualRaw` per currency, with exact fee-source agreement and the existing cumulative settlement audit. Partial models never populate a financial quantity.

An error rolls back the current batch, then saves its safe reason in a separate transaction alongside the previous good progress. The existing historical activity read exposes this as `fees.accounting.historicalWork` or `liquidity.positionAccounting.historicalWork` when the corresponding ledger is unavailable. It includes `status`, `reason`, `action`, `capacityProfile`, source block bounds, event/check progress and finite limits. The financial fields stay null and the main unavailable reason names the failure. A direct position read continues to fail with that safe reason. Successful progress clears a stale failure; successful qualification removes the work row. A database outage may prevent saving a diagnostic, but cannot commit a partial ledger.

Activity owns canonical reorg recovery. Deleting an orphaned source chunk cascades through its unpublished work and diagnostics as well as existing derived rows. Never manually alter a source model, delete closed positions, zero fee debt, advance an event offset, or mark proof checks complete to bypass a capacity failure. Backup/restore must include all of `domino_activity`, including the new table; the reader role remains SELECT-only.

## Resume an already stored expensive chunk

1. Apply the migration with the existing `backend/.venv/bin/python backend/dev_postgres.py start` command. Stop other explicit writers first. Existing qualified data is retained.
2. Run `manage_fees.py` for the same registered pool and a new output path. A `fee_chunk_in_progress` result means a durable prefix was saved; repeat the command until `caught_up_to_activity`. There is no need to refetch or repartition the source activity chunk.
3. Run `manage_positions.py` for that pool. `position_chunk_in_progress` may describe event replay or reconciliation; repeat until caught up. The last checked identity resumes across process restarts.
4. For `core_position_budget_exhausted` or `core_tick_budget_exhausted` under `standard`, select `--capacity-profile extended`. This reuses valid saved progress and preserves all closed identities/ticks. Keep the extended profile on later invocations; switching back to standard cannot approve a larger model.
5. For `fee_step_budget_exhausted` that remains blocked at the same next event, more invocations or smaller source spans cannot solve that event. `capacity_review_required` means keep the ledger unavailable until a separately tested implementation supports it. Fix RPC/state discrepancies or perform normal activity reorg recovery before resuming other failure types.

Examples below are command templates; set `POOL_ID` to the already registered pool. Each output filename must be new:

```sh
backend/.venv/bin/python backend/manage_fees.py --pool-id "$POOL_ID" --max-steps 10 --output reports/fees-resume-01.json
backend/.venv/bin/python backend/manage_positions.py --pool-id "$POOL_ID" --capacity-profile extended --max-steps 10 --output reports/positions-resume-01.json
```

`--max-steps` now counts bounded batches, so a large source chunk can require multiple invocations. The command does not retry forever, schedule future runs, erase a previous report, or move the activity checkpoint. The 100,000-step budget is shared across all attempted candidates in a batch, including rejected attempts. If a later event exhausts it, only earlier complete events are saved; the failing event starts from that prefix in a new invocation. An individual candidate over 8,192 steps still blocks. A whole replay batch can also roll back for a correctness error or an identity/byte limit, retaining its earlier durable prefix.

The current reconstruction tries at most eight candidates per swap. Usually
there are up to two consumed-amount modes at the extreme limit and four at the
observed ending price. When both limits coincide, each iteration can try four
candidates; the implementation retains both iterations. A completed swap therefore
consumes at most 65,536 admitted simulation steps (8 × 8,192), below the 100,000
shared budget. A fresh batch can fit one such swap, not necessarily two. This
explains the relationship between the ceilings, not a claim that every real swap
is supported: one candidate can still exceed its own limit. The benchmark
documents observed work separately, and non-simulation work remains bounded by
event/model limits.

For an offline diagnostic with an already configured local database, use the existing read-only database role and query the public work table; this does not require an RPC call:

```sql
SELECT pool_id, ledger, chunk_start, diagnostic
FROM domino_activity.historical_work
ORDER BY pool_id, ledger;
```

## Resume an activity range overflow

Activity profiles bound simultaneously nonzero aggregate `(lower, upper)` ranges,
independently of lifetime core position/tick profiles. They are selected explicitly:

```sh
backend/.venv/bin/python backend/manage_activity.py --pool-id "$POOL_ID" --status
backend/.venv/bin/python backend/manage_activity.py --pool-id "$POOL_ID" --capacity-profile extended --through "$TARGET_BLOCK" --output reports/activity-extended-01.json
```

Migration `013_activity_diagnostics.sql` persists a range failure against its
checkpoint revision and predecessor. `--status` reads it without provider
configuration or RPC; it is stored operator evidence, not a fresh chain read.
Stop conflicting writers, inspect the failed interval/profile, and keep the
registered pool and target. The failed chunk has published no events and has
not advanced the checkpoint. Extended replays that interval from the preceding
committed model under the same event, canonicality and StateView checks. It does
not skip an event or reinterpret a previously qualified model. A successful
commit or canonical rewind clears the diagnostic atomically; a failed recorder
does not replace the original error.

Keep selecting extended for subsequent intervals while the model exceeds the
standard limit. An inherited model over the selected limit is rejected even on
an empty interval or one that would remove ranges. Above 10,000, keep the ledger
unavailable and request a reviewed capacity change. Repeating the same command,
choosing smaller spans or deleting history cannot solve that simultaneous limit.
Smaller `--span` values only help the separate 2,000-events-per-chunk limit on
future uncommitted intervals; a single block above that ceiling remains unsupported.

The fee, position and capital CLIs separately accept
`--activity-capacity-profile extended` to replay an extended activity model.
Their existing `--capacity-profile` still selects lifetime identity/tick capacity:
128/256 standard or 1,024/2,048 extended. For example:

```sh
backend/.venv/bin/python backend/manage_fees.py --pool-id "$POOL_ID" --activity-capacity-profile extended --output reports/fees-extended-activity-01.json
backend/.venv/bin/python backend/manage_positions.py --pool-id "$POOL_ID" --activity-capacity-profile extended --capacity-profile extended --output reports/positions-extended-activity-01.json
backend/.venv/bin/python backend/manage_metrics.py --pool-id "$POOL_ID" --activity-capacity-profile extended --capacity-profile extended --output reports/capital-extended-activity-01.json
```

Activity capacity is not proof of downstream capacity. A 5,001-range source may
qualify activity and fees yet still exceed the independent position/capital
identity limit. Those financial quantities remain unavailable with their own
diagnostics; source activity and earlier qualified history are retained. The raw
historical action `review_activity_capacity_profile_then_resume` tells the
operator to inspect the selected activity profile, use extended if still standard,
or seek a capacity review if already extended. It never authorizes an automatic
increase. Profile selection changes resources, not arithmetic or model content.

Changing the worker implementation invalidates unfinished method-bound work.
Review its diagnostic and changed code first, then use the existing explicit
fee/position `--restart-unpublished-work` or capital `--restart-capital-work`
procedure, with the intended profiles. This removes only that ledger's unpublished
work and replays its retained source chunk. Published history is not rewritten.

## Capital-specific resume and recovery

After fee and position qualification reach the activity tail, use the matching capital profile:

```sh
backend/.venv/bin/python backend/manage_metrics.py --pool-id "$POOL_ID" --capacity-profile extended --max-steps 10 --output reports/capital-resume-01.json
```

The capital worker retains one after-event point for every complete replayed event, then repeats the position/range/tick proof in batches of at most 128 checks. It compares the final activity and position models with their qualified source ledgers, rechecks the pool state and canonical block/tail, and commits every capital point plus the capital chunk in one transaction. Neither replay prefixes nor partial proofs are visible through capital/valuation reads. The same limits apply to empty and nonempty later chunks inheriting more than 128 identities. Selecting `extended` only for the first chunk is insufficient.

A finite invocation ending in `capital_chunk_in_progress` is successful progress. Its report has `capitalLedger.status: in_progress`, ledger-specific `historicalWork`, `result: null` and no price acquisition. Repeat the command with a new report filename. When capital catches up, the report can include stored metrics and the optional bounded price request. A capital checkpoint never qualifies USD prices. Consumers must preserve independently verified pool identity/snapshot data while unreconciled capital and derived valuation stay null; the read-v1 candidate in #26 handles that separate API boundary. This worker change does not activate that candidate or alter its schema.

Capital work binds its source chunk, events, preceding model and qualified position proof to a SHA-256 digest. A second digest binds the loaded capital/arithmetic/proof implementation, and a checkpoint digest covers the complete models, point prefix and proof offset. Changing source evidence or worker code therefore rejects saved work before it can resume. Capacity selection can change from `standard` to `extended`, because it changes finite resource bounds rather than the arithmetic. The method digest is captured when the worker module loads; always stop/restart worker processes when changing their code. A method mismatch does not invalidate published v1 capital.

`capital_work_method_mismatch`, `capital_work_source_mismatch` or `capital_work_checkpoint_mismatch` has action `restart_capital_work_after_review`. First inspect the diagnostic and review the changed implementation/source. If the source block is orphaned, run normal activity reorg recovery first; restart refuses an orphaned block or unavailable canonical verification. After resolving the cause, restart only the unpublished capital work:

```sh
backend/.venv/bin/python backend/manage_metrics.py --pool-id "$POOL_ID" --capacity-profile extended --restart-capital-work --max-steps 10 --output reports/capital-reviewed-restart-01.json
```

The explicit restart holds the writer lock, verifies the source block/tail and removes only that pool's unpublished `capital` row. It retains source events, fee/position ledgers and all published capital. The command prints the previous diagnostic and discarded checkpoint digest and includes them in its successful report, then replays the source from the beginning of that unpublished chunk. It is an operator CLI action, with no HTTP equivalent or automatic retry. It does not solve an unsupported single event, an extended-profile overflow or a bad source ledger. Those still require a capacity/source correction. Fee/position workers provide the analogous `--restart-unpublished-work` flag; #18 documents lifetime limits and [future retirement criteria](IDENTITY_RETIREMENT.md), without implementing retirement.

## Independent downstream limits

The extended profile now also qualifies historical capital in bounded batches. It does not increase the separate valuation window/event/price limits or the existing individual-position NFT adapter's 600-RPC read budget. Those paths remain bounded and can return unavailable even when historical core totals and capital are qualified. No price, public request schema, wallet session, transaction or daemon behavior changes in this release.

Regression coverage includes a 129-identity close history with 258 retained ticks and all 516 distinct proof calls for both positions and capital, the 128 threshold, empty and nonempty later capital chunks, native event-point balances and retained rounding residuals, event-budget resume within an unchanged stored chunk, partial-proof invisibility, failure/restart, late mismatch, source/method/checkpoint binding, reorg cascade, reader grants and real backup/restore. Fresh and upgraded 007 → 012 databases preserve pending work. Run the full PostgreSQL/EVM suite from the backend README for ledger changes.
