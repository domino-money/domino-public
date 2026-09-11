# Recovery of unpublished historical work

This #19 increment builds on the capital checkpoint work in [#54](https://github.com/domino-money/domino/pull/54). It adds source/method/checkpoint binding and an explicit restart to the existing fee and position workers. It does not change v4 arithmetic, the published methodology version, prices, or the accepted [finite capacity profiles](HISTORICAL_CAPACITY.md).

## Checkpoint identity and reviewed restart

A saved fee/position prefix now binds the source pool/key, activity chunk and events, preceding model, and (for positions) the qualified fee source. Its implementation digest covers replay arithmetic, checkpoint handling and the ordering of reconciliation calls. The checkpoint digest covers the saved model, event journal and proof offset. A resumed prefix must contain exactly the swap or modification records implied by its processed source events. Profile selection is deliberately excluded from the binding so that an upgrade from standard to extended can reuse the same verified prefix.

The digest detects accidental or incompatible changes; it is not authentication against an actor able to rewrite the database and recompute all hashes. Existing writer-role, immutable source and canonical-chain assumptions still apply. A changed implementation does not retrospectively requalify old published methodology-v1 chunks.

Installing this increment also changes capital's implementation digest because its proof path shares the changed position/checkpoint code. Any unfinished #54 capital checkpoint therefore needs its existing reviewed `--restart-capital-work` procedure. Already published chunks are retained; this is not an automatic data migration.

An old unbound checkpoint or changed method reports `historical_work_method_mismatch`; a changed source reports `historical_work_source_mismatch`; invalid progress reports `historical_work_checkpoint_mismatch`. The diagnostic action is `restart_unpublished_work_after_review`. No automatic reset, skip or publication occurs. Dependent unqualified fee/position amounts remain null, and the saved prefix remains available for inspection.

1. Preserve the diagnostic and checkpoint identity from `domino_activity.historical_work`, including the pool, ledger, chunk and digests. Identify the code/source change; repairing a changed source is distinct from accepting a new implementation.
2. Confirm that the source history is canonical and complete. If it was orphaned, run the existing activity reorg recovery; do not accept an orphan by deleting its derived checkpoint. If published methodology is wrong, this command cannot migrate or repair it.
3. After reviewing the cause, run the appropriate command below with the chosen trusted profile and a new report filename. `POOL_ID` is the selected registered public pool; it is not a wallet or a runtime allowlist.

```sh
backend/.venv/bin/python backend/manage_fees.py --pool-id "$POOL_ID" --restart-unpublished-work --max-steps 10 --output reports/fee-reviewed-restart-01.json
backend/.venv/bin/python backend/manage_positions.py --pool-id "$POOL_ID" --capacity-profile extended --restart-unpublished-work --max-steps 10 --output reports/position-reviewed-restart-01.json
```

The explicit command holds the writer lock, checks the source end block and activity tail before and after the reads, and deletes only the selected unpublished work row. It refuses work already associated with a qualified chunk. The CLI prints/records the discarded checkpoint digest, previous diagnostic and source bounds, then replays that same chunk from its beginning. Earlier qualified chunks and their journals are retained. Repeat ordinary bounded commands with new report filenames until the whole chunk reconciles. Capital retains its separate `--restart-capital-work` procedure from #54.

Changing the profile, retrying an RPC error, or continuing the same implementation does not require restart. Restart cannot make an unsupported single event, a model over the extended lifetime ceiling, or a bad source valid. A smaller span does not repartition an already stored chunk. No command here changes runtime scheduling or exposes a public HTTP write.

## Resource checks and remaining capacity limits

Apply [migration 013](../backend/migrations/013_activity_diagnostics.sql) before deploying this worker increment. It adds bounded operator metadata to the existing pool row; it does not advance a source revision or qualify any history. The local PostgreSQL helper applies it after 012.

After a 5,000-range failure, inspect its persisted status without an RPC or provider configuration read:

```sh
backend/.venv/bin/python backend/manage_activity.py --pool-id "$POOL_ID" --status
```

Add `--output reports/activity-status-01.json` for an optional new report file. The result records the attempted interval/hashes, checkpoint revision, last committed snapshot, limit and `capacity_review_required` action. It always marks canonicality as unchecked and current-24h usability false. The failed model is never published; success or a source rewind clears its diagnostic atomically. A late failure recorder cannot replace status after another worker advances or rewinds. If the database itself is unavailable, diagnostic persistence is best effort and the original indexing error is retained; absence of a diagnostic does not establish health or catch-up.

The public read retains its original snapshot, independent canonicality check and existing freshness rule. Recording a diagnostic does not make an old snapshot fresh, manufacture TVL, or create an extended activity profile. The unchanged overflow still cannot advance beyond 5,000 live ranges. This closes the missing operational visibility, not the larger activity-capacity or busy-pool qualification work remaining in #19.

| Bound | Type and behavior |
| --- | --- |
| 128/256 standard and 1,024/2,048 extended identities/ticks | Resource ceiling over lifetime keys. Standard may resume under extended; exceeding extended remains unavailable pending a reviewed capacity/retirement change. |
| 32 replay events and 128 proof calls per batch | Work budgets. Save only a complete-event prefix or a completed ordered proof prefix, then resume. No partial qualified ledger is published. |
| 100,000 candidate simulation steps per batch / 8,192 per candidate | Resource bounds across all candidate attempts. A batch can stop after its last complete event. A single unsupported event remains blocked; calibration evidence does not authorize raising these limits. See the [fee-step study](../reports/FEE_STEP_BENCHMARK.md). |
| 8 MiB saved JSONB text | Storage resource ceiling. The worker asks PostgreSQL for `octet_length(progress::jsonb::text)` before saving, using the same normalization as the database constraint. Exponent expansion and Unicode/whitespace normalization cannot turn this check into a misleading generic database failure. Over-limit work remains explicitly blocked. |
| Maximum cumulative proof offset | Derived from the largest trusted profile: positions + distinct ranges (at most positions) + ticks. No independent literal 4,096 needs to be maintained when profiles change. |
| 5,000 active activity ranges | Resource ceiling independent of lifetime position keys. An unchanged input above this bound cannot resume under a larger shipped activity profile. Preserve the last committed snapshot; a smaller block span does not guarantee relief. A capacity change needs separate evidence. |

v4 integer bounds, modular fee-growth arithmetic, exact event/state reconciliation, journal conservation and canonicality are correctness requirements. They are not relaxed as recovery options. The internal operator diagnostics in this document do not expand the pinned public read-v1 schema; its consuming stack must preserve stable unavailable/null responses when integrating these raw worker states.
