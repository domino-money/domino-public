# Resume activity indexing after a live-range resource limit

Activity replay has two explicit, finite resource profiles: `standard` admits
5,000 simultaneously live ranges; `extended` admits 10,000. This doubles the
range-state ceiling without changing Uniswap arithmetic, canonical source
checks, event ordering or active-liquidity reconciliation. The selected profile
is an operator resource choice, not an empirically calibrated production limit.
No automatic escalation is performed.

The activity worker still processes at most 2,000 source events and 10,000 blocks
per chunk; one CLI invocation permits at most 50 such bounded steps. A range
failure rolls back the entire attempted chunk. Earlier
chunks, event rows, the source revision and last committed snapshot remain
unchanged. Retry starts at the existing `next_block`, re-fetches canonical source
and replays that chunk; no event is omitted and no partial model is published.
A source reorg still rewinds orphaned chunks and dependent ledgers before replay.

Migration 013 already stores the last failed activity attempt. This change needs
no new migration. Read status without provider configuration:

```sh
backend/.venv/bin/python backend/manage_activity.py --pool-id <pool-id> --status
```

A new standard-profile range failure includes `capacityProfile: standard`,
`liveRangeLimit: 5000`, observed lower-bound range count, unchanged checkpoint
revision, source hashes, and `select_extended_activity_profile_and_resume`.
After reviewing resource availability, rerun the original bounded command with
`--capacity-profile extended` and a new output filename:

```sh
backend/.venv/bin/python backend/manage_activity.py --pool-id <pool-id> \
  --through <reviewed-target-block> --span <reviewed-span> --max-steps 5 \
  --capacity-profile extended --output reports/activity-extended-run.json
```

Select `extended` again on every later indexing invocation that must consume
more than 5,000 stored live ranges. A default worker rejects an inherited extended
model even when the next chunk is empty or would remove a range. Once an
explicitly extended replay reduces the model to 5,000 or fewer live ranges, the
standard profile can consume it again.

The extended ceiling is final for this implementation. A 10,001st live range
produces `capacity_review_required`, `resumeAboveLimitSupported: false` and a
persisted 10,000-range limit. Reducing the block span cannot bypass either range
ceiling. A successful atomic commit or a source rewind clears obsolete
activity diagnostics. Historical diagnostic records created by an older worker
retain their recorded content; `capacityProfiles` separately lists capabilities
of the current code. Status remains an operator observation, not a fresh-chain
check, an APR/TVL qualification or a financial value.

## Downstream work has independent limits

Fee, position and capital workers accept the separate
`--activity-capacity-profile standard|extended` option. Their existing
`--capacity-profile` still chooses position/tick resources; it does not change
the activity-range ceiling. The default identity limits remain 128 positions /
256 ticks; extended remains 1,024 positions / 2,048 ticks. The public owner-read
RPC/response budgets are unchanged. Activity at 10,000 ranges does not mean
position/capital history or public NFT reads support 10,000 identities.

For example, a fee worker that needs the larger activity state uses:

```sh
backend/.venv/bin/python backend/manage_fees.py --pool-id <pool-id> \
  --activity-capacity-profile extended --max-steps 5 \
  --output reports/fees-extended-activity-run.json
```

All replay entrypoints and completed-prefix/empty-batch paths validate the
selected activity capacity before processing financial effects. The profile
never enters the financial model, source binding or stored proof. Changing only
the profile under the same implementation therefore preserves a valid saved
prefix: the failing event is retried without replaying or double-counting
completed journal rows. Existing block/hash, model/journal/proof bindings still
apply. The PostgreSQL 8 MiB checkpoint-size bound is unchanged.

A downstream range failure retains the existing `historicalWork` field shape
and records `review_activity_capacity_profile_then_resume`. If the invocation
used standard, review selecting extended; if it already used extended, further
capacity work is required. The CLI success/failure envelope identifies
`activityCapacityProfile`. Fee/position/capital metrics remain unavailable if
any independent bound or qualification fails. Read-v1 consumers must apply the
separately reviewed historical-state projection; this operator change grants
no public execution capability.

This implementation changes replay and checkpoint callgraph code already
covered by both method digests. Unpublished work created by an older
implementation needs its existing reviewed `--restart-unpublished-work` or
`--restart-capital-work` procedure. Published history is retained. Merely
changing a profile within this implementation needs no restart. Never bypass a
method/source/checkpoint mismatch by rewriting a digest.

## Offline evidence

`test_activity_capacity.py` exercises actual 5,000/5,001 and 10,000/10,001 bounds,
input immutability and unchanged results within the default budget; the real
PostgreSQL replay extends an existing 5,000-range prefix, rejects empty default
work above that prefix, and checks canonical reorg/rollback/backup recovery.
A fee checkpoint stops at offset 32 before range 5,001 and resumes that same
checkpoint under the explicit extended activity profile. No provider or wallet
is used. These tests establish bounded replay behavior, not representative
mainnet throughput or a calibrated global fee-step limit.
