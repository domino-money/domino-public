# Fee candidate-step benchmark — issue #19

The bounded benchmark measured the actual `replay_fees` implementation against
five historical chunks from the public Robinhood pool
`0xc613d796ce23c7344334ac5373063c89479675876d25738ee78cf0642f2a30ef`.
The fixed window is the one in [the original fee qualification](fee-ledger-live-2026-09-09.json)
and includes the [original activity sample](activity-index-2026-09-09.json).

| Examined blocks, inclusive | Events | Swaps | Candidate steps admitted | Shared budget used |
| --- | ---: | ---: | ---: | ---: |
| 58,738,261–58,743,260 | 10 | 4 | 30 | 0.03% |
| 58,743,261–58,748,260 | 0 | 0 | 0 | 0% |
| 58,748,261–58,753,260 | 0 | 0 | 0 | 0% |
| 58,753,261–58,763,260 | 0 | 0 | 0 | 0% |
| 58,763,261–58,772,342 | 0 | 0 | 0 | 0% |

The first chunk is the **busiest among these five examined chunks**. It is not a
claim about this pool's busiest-ever chunk or other pools. This sparse sample
does **not** calibrate the 100,000-step limit for high-activity markets. Broader
representative dense-window evidence remains open; the operational ceiling is
unchanged. Issue #19's global/high-activity calibration must not be marked
complete solely from this measurement.

## Acquisition and provenance

On 2026-09-10, the configured product provider supplied the fixed window in
**34 read-only RPC requests**, including chain-ID validation and a second check
of every requested boundary and event block hash. The final hash/timestamp and
replayed cumulative fees, fee growth, price, tick, protocol setting and liquidity
match the original historical qualification. Completeness remains a
single-provider assumption. This is historical proof revalidation, not current
pool analytics or a new indexing/backfill run. No ledger was changed.

The existing product public catalogue was first attempted using its read-only
role and was unavailable. The public RPC failed DNS resolution before returning
a chain ID. Only the already authorized product provider configuration was then
loaded through `load_config`; its URL/key were neither printed nor exported.

The [machine-readable measurement](fee-step-benchmark-2026-09-10.json) includes
per-chunk counts, budget use, timings, input/output hashes and actual batch-replay
comparison. The [projected event fixture](fee-step-events-2026-09-10.json) retains
the precise amounts, block/log ordering, event fingerprints and boundary hashes
needed to reproduce core-fee work offline. Sender, position salt and transaction
hash are omitted because this benchmark does not reconstruct individual
positions or attribution. It must not be used as a position-ledger source.

## What the counter measures

The harness observes the existing shared-budget decrement in `simulate`, through
the existing `budget` argument. It does not patch core math, alter fee results or
count only the winning candidate. All admitted candidate steps count, including
candidate replays that fail to match the recorded swap. An attempted decrement
below zero is counted separately as a rejected attempt; no swap-step math runs
for that attempt. Single-candidate exhaustion at 8,192 steps is distinguished
from shared-budget exhaustion at 100,000 steps.

Each chunk is measured once as a direct replay and once through the actual
`historical_capacity.replay_batch` path. The reported 30 steps are for one direct
chunk replay; 60 total steps include the independent 30-step resume-path check.
Both produce identical final models and fee rows. Wall timings describe this
machine/run only and are not capacity guarantees.

Tests also use more than 32 synthetic events to verify complete-prefix resume,
and reduce the shared budget to 18 **inside a test only** to force the real
public swaps through budget exhaustion and resumption. The resumed output
matches the original unbounded-by-that-test-limit result. A failed first event
remains explicitly over budget. An unavailable acquisition uses null totals and
a null busiest chunk; it must never be interpreted as measured zero work.

## Reproduce offline

This command needs no provider, database or credential and never rechecks
canonicality. The output path must be new:

```sh
backend/.venv/bin/python backend/benchmark_fee_steps.py \
  --source fixture --fixture reports/fee-step-events-2026-09-10.json \
  --output reports/my-offline-fee-step-benchmark.json
backend/.venv/bin/python -m unittest discover -s backend/tests -p 'test_fee_step_benchmark.py' -v
```

The fixed recorded window can also be read from an explicitly configured public
catalogue, using only `domino_catalogue_reader` and a read-only transaction:

```sh
backend/.venv/bin/python backend/benchmark_fee_steps.py \
  --source catalogue --database-config backend/runtime/catalogue-db.json \
  --output reports/my-stored-fee-step-benchmark.json
```

An explicitly authorized future RPC recheck uses the same finite historical
window. `configured-rpc` requires `--provider-config`; there is no implicit
private-config search. `public-rpc` uses the built-in public endpoint:

```sh
backend/.venv/bin/python backend/benchmark_fee_steps.py \
  --source configured-rpc --provider-config backend/runtime/providers.json \
  --output reports/my-rechecked-fee-step-benchmark.json
```

The harness caps input at 8 MiB, 8 chunks, 2,000 events per chunk and 10,000 events
total, with at most 400 resume batches per chunk and one million candidate-step
attempts across both replay paths. It retains the actual 8,192-per-candidate and
100,000-shared-step arithmetic-worker limits. Acquisition uses at most 80 RPC
requests and the existing 60-second transport budget. Replay checks a 30-second
deadline between events/batches and every step admission. These are cooperative
deadlines using the existing transport/SQL timeouts, not an assertion of hard
wall-clock interruption of an already blocked external operation. There is no
background loop, automatic retry, provider discovery, signer or ledger write.
