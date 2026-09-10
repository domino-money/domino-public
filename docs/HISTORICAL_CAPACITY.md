# Historical ledger capacity and recovery

The optional historical audit workers qualify stored core pool activity. Their resource profiles do not admit a pool for execution, establish wallet ownership, provide prices, or make full-history replay a prerequisite for on-demand reads. These commands require an explicitly configured archive-capable provider when actually run. The implementation and regressions were tested with synthetic RPC fixtures, disposable PostgreSQL and an isolated v4 EVM reference; no new live backfill was performed.

## Resource limits and correctness checks

| Limit | Supported scope | Recovery |
|---|---|---|
| 128 lifetime positions / 256 known ticks | Default `standard` position worker profile | Explicitly select `extended` and resume |
| 1,024 lifetime positions / 2,048 known ticks | `extended` profile | A larger reviewed model is required; no unlimited mode |
| 32 events / 100,000 candidate simulation steps | One fee or position worker batch | Save a complete-event prefix and resume the same stored chunk |
| 8,192 simulation steps | Each individual swap candidate | An event exceeding this limit remains unsupported |
| 128 position/range/tick checks | One position reconciliation batch | Resume the next unchecked identity at the same historical block |
| 160 total RPC requests / 90 seconds | One position CLI worker instance | Fix provider availability, then resume; partial failed batches roll back |
| 60 total RPC requests / 90 seconds | One fee CLI worker instance | Fix provider availability, then resume |
| 8 MiB serialized progress | One unpublished pool/ledger checkpoint | Capacity review; no partial values published |
| 2,000 events | One source activity chunk | Reduce future activity spans; a single over-capacity block needs separate design |
| 5,000 live aggregate ranges | Activity replay, independent of core identities | Capacity review; smaller spans cannot reduce simultaneous live ranges |
| 50 batches | One explicit CLI invocation | Run another bounded invocation with a new report filename |

These are operational limits. v4 uint128/int128 bounds, fee-growth wrapping, tick-spacing alignment, exact swap outcomes, donation/protocol separation, position fee debt, settlement-journal totals and token-asset conservation are correctness requirements and do not change with a profile. The tick-liquidity cap continues to match pinned v4-core revision `46c6834698c48bc4a463a86d8420f4eb1d7f3b75`: its negative minimum tick division is floored. For spacing 60, the cap is `11505354575363080317263139282924270`; using truncation toward zero would incorrectly increase that cap. The unmodified vendored source and its hashes are checked, and the external test harness compares admission against the compiled v4 function.

The replay model retains closed positions and zeroed tick records. A reopened identity must preserve its prior settlement history and v4 last-inside-growth behavior; every cleared tick must still pass the on-chain zero-state check. Removing tombstones alone would not solve the default lifetime-position ceiling: 128 disjoint open/close identities can already occupy 256 ticks. This release supports a larger finite model with batched proofs; it does not implement unbounded identity archival or erase old accounting evidence.

The [bounded real-pool step benchmark](../reports/FEE_STEP_BENCHMARK.md) examined
the five chunks in the existing 2026-09-09 public qualification window. The
busiest **among those examined chunks** had 10 events, 4 swaps and 30 candidate
steps (0.03% of 100,000); the other four were empty. Actual batch replay reproduced
the single-pass result. The projected public events and a credential-free replay
command are committed for reproduction. This sparse sample does not establish
the busiest-ever chunk or calibrate the resource ceiling for high-activity pools;
that broader evidence remains open. Acquisition failure is unavailable with null
measurements, distinct from an examined empty chunk with zero steps.

## What is durable and what is available

Migration `007_historical_work.sql`, applied by the existing `dev_postgres.py start` helper, adds one unpublished checkpoint per pool and ledger (`fee` or `position`). Each row records its source chunk, complete-event offset, reconstructed models, pending journal rows, completed proof checks and a diagnostic. No new methodology version is needed: final v1 models and proof fields retain their existing meaning and previously qualified chunks remain valid.

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

For an offline diagnostic with an already configured local database, use the existing read-only database role and query the public work table; this does not require an RPC call:

```sql
SELECT pool_id, ledger, chunk_start, diagnostic
FROM domino_activity.historical_work
ORDER BY pool_id, ledger;
```

The activity live-range limit is distinct from historical identity accumulation. Smaller `manage_activity.py --span` values affect only future uncommitted log intervals. They do not modify existing chunks or cure simultaneous live-range/single-event limits. Existing stored fee/position chunks use the resumable procedure above, so destructive repartitioning is unnecessary.

## Independent downstream limits

The extended profile qualifies historical core-position and fee storage, including aggregate activity reads. It does not increase the separate capital/valuation replay ceiling or the existing individual-position NFT adapter's 600-RPC read budget. Those paths remain bounded and can return unavailable even when historical core totals are qualified. No price, public request schema, wallet session, transaction or daemon behavior changes in this release.

Regression coverage includes a 129-identity close history with 258 retained ticks and all 516 distinct proof calls, exact native close/reopen settlement conservation, event-budget resume within an unchanged stored chunk, partial-proof invisibility, failure/restart, late mismatch, reorg cascade, reader grants and real backup/restore. Run the full PostgreSQL/EVM suite from the backend README for ledger changes.
