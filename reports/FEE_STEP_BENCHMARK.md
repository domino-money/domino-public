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


## Broader bounded sample and actual-limit stress — issue #19 follow-up

The public RPC was available for this follow-up. A fresh read of the original
five-chunk window again produced the exact 30-step result in 34 requests, without
private provider configuration or a database connection. See the
[public-RPC recheck](fee-step-public-rpc-probe-2026-09-10.json). This confirms the
old evidence; it does not make that sparse pool busy.

A separate [recent public study](fee-step-recent-study-2026-09-10.json) surveyed
blocks **59,774,872–59,784,871**. It observed 132 Initialize logs, of which 84
had hookless fixed-fee keys supported by the fee-replay adapter. It examined only
the eight oldest supported initializations in that bounded window, then selected
the one with the highest provider-observed swap count. Those selection counts
are explicitly unreconciled diagnostics; they are not a network-wide ranking or
proof that excluded pools are inactive. Adapter support does not establish
market/token admission or financial authority.

| Complete selected lifecycle | Events | Swaps | Candidate steps | Shared limit use |
| --- | ---: | ---: | ---: | ---: |
| Pool `0x46525dc119850396470f132c4a989d7192cb692139db891b5a4cdcd684c11b17`, blocks 59,775,312–59,784,871 | 45 | 40 | 240 | 0.24% |

For this selected pool, the harness acquired every core event from Initialize
through the pinned endpoint. It verified each event's block hash and timestamps,
rechecked all requested boundary/event headers, and reconstructed exact core fee
work. Price, tick, protocol fee, active liquidity and both global fee-growth
values match StateView at that same block; the endpoint hash was rechecked after
measurement. This used **99 read-only RPC requests** under one shared allowance,
not separate allowances for selection, acquisition, state checks and the final
recheck. Completeness still assumes a truthful single provider.

Direct replay and the real 32-event resume path produced identical output hashes;
the two batch offsets were 32 and 45. The 240 direct candidate steps are eight
times the original sample, with 480 including the separate resume comparison.
The [projected public events](fee-step-recent-events-2026-09-10.json) preserve the
canonical proof and exact amounts while excluding sender, salt and transaction
hash. The [offline reproduction](fee-step-recent-replay-2026-09-10.json) matches
the stored endpoint and 240-step result and explicitly makes no fresh-canonicality
claim. It is fee-replay evidence, not position attribution or a new ledger.

This is a more active real sample, **still far below a representative high-step
market calibration**. Forty swaps with 240 candidate steps do not justify a
100,000-step operating ceiling, establish a busiest-ever chunk, or cover deeply
crossing/adversarial paths. `productionCapacityCalibrated` remains false and the
Decimal acceptance item remains open. The core limits have not changed.

### Separate synthetic resource-bound stress

The [synthetic workload](fee-step-synthetic-stress-2026-09-10.json) creates 200
adjacent ranges and 160 alternating full-width swaps: 361 events total. Events
are generated by the existing simulator solely to supply deterministic work.
This is not an independent financial oracle, a chain sample, a live operation,
or evidence that such a workload is representative of Robinhood usage.

Without reducing or increasing the actual worker constants, direct reconstruction
admits exactly **100,000 candidate steps**, rejects attempt **100,001**, and reports
`shared_steps` exhaustion. The actual bounded resume path completes all 361
events. Its result also matches a separate one-event-at-a-time replay, including
the complete output hash, without widening any individual worker allowance.
Generation, direct replay, batched resume and the single-event comparison share
one million-step/30-second harness allowance. Their total is **516,001 attempts**:
32,000 generation steps, 100,001 direct attempts, 192,000 batched-resume steps and
192,000 single-event comparison steps. No RPC is used. This proves a finite
recovery workload at the real shared boundary, not production calibration.

### Reproduction and remaining study

Public selection and acquisition are explicit and bounded; these command
examples are opt-in reads. Use fresh output names:

```sh
backend/.venv/bin/python backend/benchmark_fee_steps.py \
  --source public-study --scan-blocks 10000 \
  --events-output reports/my-recent-fee-events.json \
  --output reports/my-recent-fee-study.json
backend/.venv/bin/python backend/benchmark_fee_steps.py \
  --source study-fixture --fixture reports/fee-step-recent-events-2026-09-10.json \
  --output reports/my-recent-offline-replay.json
backend/.venv/bin/python backend/benchmark_fee_steps.py \
  --source synthetic-stress --output reports/my-synthetic-fee-stress.json
```

The recent-study mode uses only the built-in public RPC, never private provider
or database configuration. It accepts a 1,000-, 5,000- or 10,000-block selection
window, at most 256 initialization logs, eight candidate pools and 2,000 swap
selection logs/events in a measured chunk. Selection is deterministic within the
observed sample. One 256-request/60-second allowance covers the complete network
invocation; the existing 30-second/million-step replay limit also applies. The
original fixed-window modes retain their 80-request allowance. Exhaustion, RPC
failure, conflicting logs, reorgs or state mismatches produce unavailable/null
measurement fields, never measured zero work or a silently truncated success.
There are no ledger writes, automatic retries, polling or provider/configuration search.

The next empirical study must deliberately sample pools with more initialized
crossings and busier chunks across several pinned windows, while retaining a
complete initialization-to-chunk model or a separately verified state anchor.
Swap counts are only a selection aid: measure all candidate reconstruction work,
report selection exclusions, compare exact endpoint state and publish the
busiest *examined* chunk with its population/window limits. Do not skip missing
liquidity history, reset the shared invocation allowance per pool, or enlarge a
worker constant to force the study through. If a candidate exceeds a read/work
budget, record it as excluded/unavailable and design a separately reviewed
bounded acquisition/resume step. A representative maximum/percentile claim needs
that broader evidence; this follow-up deliberately makes neither claim.

Focused validation: 18 benchmark tests pass offline, covering both retained real
samples, exact resume output, mismatch/reorg rejection, no private configuration
access, malformed selection logs with an explicit unavailable report, one shared
RPC/work allowance and the actual 100,000-step synthetic stop.
No runtime accounting/math/store file was modified, no user PostgreSQL/runtime
was accessed, and no transaction was signed or sent.

## Dense, explicitly selected lifecycle study — reconciliation of #19

The new study scans a fixed population rather than truncating it to the eight
oldest pools. Its public survey covers blocks **59,790,805–59,830,804**:
786 Initialize events, 591 supported hookless/fixed-fee pools and 9,759 observed
Swap/ModifyLiquidity logs. Every supported initialization in that population is
considered. The deterministic selection chooses three different pools: first the
leader in distinct observed ranges, then the remaining swap-count leader, then
the remaining leader in accumulated absolute tick travel divided by tick spacing.
The third comparison uses exact fractions. These selection statistics are
unreconciled provider diagnostics, not qualified fees or a network-wide ranking.
Pools initialized before the survey window are excluded explicitly.

The selected range leader has 60 distinct observed ranges and 595 swaps; the
swap-count leader has 1,264 swaps; the movement leader has 101 swaps. Distinct
ranges and tick travel are only selection aids. The actual measurement counts
all candidate reconstruction work and separately records initialized ticks crossed
by the matched swap reconstruction. Percentiles use nearest rank over the named
observed population; they are not confidence intervals or market-wide estimates.

The [initial public attempt](fee-step-dense-study-2026-09-10.json) ended with
HTTP 429 after 18 logical requests. A paced
[40,000-block survey/acquisition](fee-step-dense-40k-study-2026-09-10.json) ended
with `rpc_error` after 754 logical requests, retaining its complete selection
statistics and null measurement totals. A separate public read isolated the
failure: StateView `getSlot0` at block 59,804,470 returned error -32000,
`metadata is not found, 59804473`; the identical read at the pinned final block
59,830,804 and at latest succeeded. Historical logs/headers being readable does
not establish that this public node retains every intermediate contract state.
No automatic retry loop, zero-work result or successful canonicality claim was
substituted for either failed invocation.

The subsequent configured-provider invocation uses only the existing, explicitly
selected **product** provider configuration through `load_config`. It reuses the
public selection record to avoid rescanning, independently rechecks chain ID,
the exact pinned head and each selected Initialize event, and does not present
the old selection counts as newly revalidated. No provider URL, API key, wallet,
private runtime, database connection or transaction is included in the artifact.
The [seven-read archive probe](fee-step-archive-provider-probe-2026-09-10.json)
confirmed that the configured source could read the exact intermediate StateView
checkpoint missing from the public source, with the same chain and block hash.

### Acquisition, accounting and proof bounds

Each selected pool starts at its exact Initialize event. All five supported core
event kinds are acquired across contiguous fixed chunks of at most 10,000 blocks,
with at most eight chunks per pool. No arbitrary mid-history fee-growth anchor,
missing liquidity prefix or chunk partition is silently accepted. Every event
and boundary header is checked and rechecked, and the price, tick, protocol fee,
active liquidity and both global fee-growth values are compared with StateView
at **every** chunk endpoint. The final pinned head is checked again after replay.
The source-completeness assumption remains one provider; these proofs are neither
finality guarantees nor protection against a consistently dishonest RPC service.

Selection, event acquisition, header batches, StateView proofs and final checks
share one 8,192-logical-method/600-second allowance. Each batch contains at most
eight read-only methods and every method consumes the allowance individually;
reordered responses require the exact unique expected integer IDs. HTTP envelopes
are spaced by one second, without retrying failures. The selection ceiling is
2,048 initializations, 1,024 supported candidates and 20,000 selection logs. The
acquisition ceiling is 2,000 events per chunk and **10,000 events across all
selected pools**, enforced while reading logs before further header/state work.
Serialized input/output is capped at 8 MiB. These remain cooperative deadlines
around the existing bounded transport, not hard interruption of an outstanding
system call.

Replay, actual 32-event resume and the additional crossing/candidate inspection
share the existing one-million-attempt/30-second allowance across every pool.
The inspection wraps only the unchanged simulator call boundary to measure each
candidate, including failures; it restores the original callable on both success
and error. No arithmetic, worker ceiling or execution policy is modified. Every
chunk's resumed complete output must match direct replay when the direct replay
fits its real 100,000-step budget. Each stored chunk checkpoint is mandatory and
bound to its block/hash/timestamp. If a direct replay exhausts the budget, its
step count is a **censored lower bound**: both nested and global busiest-chunk
inferences, and the direct-chunk percentile summary, become unavailable rather
than ranking tied capped values as complete costs.

```sh
backend/.venv/bin/python backend/benchmark_fee_steps.py \
  --source public-dense --scan-blocks 40000 --through-block 59830804 \
  --events-output reports/my-dense-events.json \
  --output reports/my-dense-study.json

# Select an existing private product provider configuration explicitly:
backend/.venv/bin/python backend/benchmark_fee_steps.py \
  --source configured-dense --provider-config /path/to/product/providers.json \
  --selection-fixture reports/fee-step-dense-40k-study-2026-09-10.json \
  --events-output reports/my-configured-dense-events.json \
  --output reports/my-configured-dense-study.json

backend/.venv/bin/python backend/benchmark_fee_steps.py \
  --source dense-fixture --fixture reports/my-configured-dense-events.json \
  --output reports/my-dense-offline-replay.json
```

A reused selection's validated recorded window controls the reported scope;
`--scan-blocks` does not relabel that earlier survey. An explicit `--through-block`
must match its recorded head. Offline replay checks recorded endpoint evidence
and exact output hashes, but `currentCanonicalityAssessed` remains false. Current
network/state availability must be established by a new bounded online invocation.
Both online and offline modes validate the recorded scope, selected identities
and dataset endpoint before reporting a window. Before exporting a complete
acquisition, a structural preflight also requires consecutive chunk bounds,
ordered in-range events and the exact first Initialize/key; a visibly missing
middle chunk or Initialize cannot be archived as complete. The acquisition is now
saved before replay with `acquisition.status=complete` and
`acquisition.replayStatus=not_assessed`: an independently bounded replay failure
leaves reusable evidence without claiming a measured or reconciled result.
Incomplete acquisitions are never exported. The successful online evidence below
predates that archive-timing improvement; its full dataset was exported after
successful replay, and is accepted unchanged by the final offline validator.

### Measured results and decision

The [configured study](fee-step-dense-configured-study-2026-09-10.json) completed
all three selected Initialize-to-head histories, **2,143 events / 1,960 swaps in
ten chunks**. It used **4,024 logical RPC methods**, below the declared 8,192-method
allowance, without a retry or rate-limit failure. All ten StateView checkpoints
matched; all ten direct/resume hashes matched. The exported
[complete event/checkpoint evidence](fee-step-dense-configured-events-2026-09-10.json)
is 2,182,388 bytes and needs no provider access for replay. The independent
[offline invocation](fee-step-dense-offline-replay-2026-09-10.json) reproduced every
cost, checkpoint and output hash with `currentCanonicalityAssessed=false`.
Both invocations report the same canonical JSON input SHA-256:
`85ec4dfca8fc358331de39903cc65d8b4a5ad4f67f64dc43eb71c6dee55e4c1a`.

| Selected pool (full PoolId in artifacts) | Complete events / swaps | Chunks | Max chunk steps | Max actual ≤32-event batch | Max steps / swap | Max steps / candidate | Max initialized ticks crossed / swap |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Range leader `a2d27dad…e0da180` | 757 / 595 | 4 | 1,896 | 240 | 24 | 4 | 3 |
| Swap leader `647f6687…7ca2f49` | 1,272 / 1,264 | 2 | **5,550** | 204 | 24 | 4 | 1 |
| Movement leader `12649fbb…7f759` | 114 / 101 | 4 | 1,116 | **1,116** | **294** | **51** | 2 |

The busiest of these **ten complete, fixed chunks** is the swap leader's
59,810,871–59,820,870 interval: 918 events including 913 swaps, **5,550 admitted
steps / 5.55%** of the shared budget. Its exact direct/resume output SHA-256 is
`30b964658cc0b3be47d452f7473f4a85ab63f8ca79a6f55e29332cacda6130fb`.
This is not the busiest sliding interval, the busiest of all 591 survey pools,
or the global busiest pool. The remaining 588 supported pools were selection
candidates, not complete replay measurements. A distinct-range count of 60 did
not produce a swap crossing dozens of initialized ticks: the observed maximum
was three. The movement leader's 51-step candidate demonstrates additional
iteration work despite only two initialized crossings at most. The evidence is
substantially more demanding than the earlier 40-swap/240-step sample but does
not certify a heavily populated tick-crossing extreme.

The named observed populations have these nearest-rank summaries; no population
outside this study is implied:

| Population | Count | Minimum | p50 | p95 | p99 | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Complete chunk steps, all selected pools | 10 | 150 | 776 | 5,550 | 5,550 | 5,550 |
| Actual resumed batch steps, all selected pools | 70 | 6 | 192 | 240 | 1,116 | 1,116 |
| Candidate steps, range leader | 3,570 | 1 | 1 | 2 | 3 | 4 |
| Candidate steps, swap leader | 7,584 | 1 | 1 | 1 | 2 | 4 |
| Candidate steps, movement leader | 602 | 1 | 1 | 48 | 49 | 51 |
| Reconstructed-swap steps, range leader | 595 | 6 | 6 | 12 | 18 | 24 |
| Reconstructed-swap steps, swap leader | 1,264 | 6 | 6 | 6 | 12 | 24 |
| Reconstructed-swap steps, movement leader | 101 | 6 | 6 | 192 | 294 | 294 |

All direct costs are complete, uncensored counts. The three passes used a total
of **43,350** step attempts: 14,450 direct, 14,450 resumed, 14,450 for the additional
candidate/crossing inspection. The online direct replay time summed to 266.015 ms
over ten chunks, with 96.607 ms in the busiest chunk. Those are local observations
on Python 3.14.3 / macOS 26.6.2 arm64, not a Linux VM or production SLA benchmark.
The externally observed process start was 2026-09-11 00:36:47 UTC and report file
completion was 00:46:02.205 UTC (approximately 555 seconds, including pacing,
proofs and replay). This wall duration was observed from the process timestamp
and file completion, not an instrumented acquisition-only timer. It must not be
confused with CPU cost, a reusable provider SLA or a user-facing onboarding wait.

**Decision: retain the 100,000 shared-step operational budget.** The measured
busiest complete chunk leaves 94,450 steps of headroom; the ceiling is about
18.0 times its observed cost. The most expensive actual 32-event resume batch
consumes 1.116% of the cap, whose ceiling is about 89.6 times that cost. The sample gives
no evidence requiring an increase; lowering the limit to the observed maximum
would incorrectly overfit these three young pools.

There is also a structural reason to retain headroom beyond this sample. The
unchanged `reconstruct_swap` can try **eight** simulator candidates: if the
reported after-price equals the global extreme limit, both identical entries in
its two-limit list take the four-candidate branch. The new resource regression
exercises that actual branch; it does not deduplicate it or act as an independent
fee oracle. With the independent 8,192-step candidate ceiling, a supported
reconstruction admits at most **8 × 8,192 = 65,536** steps. A fresh 100,000 allowance
therefore accommodates one such maximum supported reconstruction, with 34,464
steps remaining. It does **not** guarantee two (131,072) or a full 32-event batch.
An event exceeding the independent candidate ceiling remains unsupported; a
cumulative shared-budget exhaustion remains a bounded stop handled by the
existing tested resume mechanism. The retained synthetic 100,000-stop evidence
tests that enforcement and recovery, rather than market representativeness.

`productionCapacityCalibrated=false` and `globalBusiestAssessed=false` remain
intentional. This task now supplies a real, independently endpoint-checked
busiest chunk within the declared complete lifecycle scope and a reasoned
operational threshold decision. It does not supply a production hardware/concurrency
cohort, network-wide tail distribution, provider SLA or dense-crossing worst case.
No worker/accounting/math constant, database, execution path or transaction was
changed by the study.

Focused validation: **36 offline tests pass, zero skips** (18 retained benchmark
tests plus 18 dense-study tests). The real three-pool fixture regression compares
every direct/resume output and recorded StateView checkpoint; other tests cover
batch envelopes, shared budgets, reorgs, bounded selection, configured-source
opt-in, offline scope binding, censored rankings, missing intermediate proofs,
pre-replay evidence preservation and the eight-candidate limit branch. Full
integration testing belongs to the coordinating branch; no PostgreSQL or live
execution test was run by this benchmark task.

Primary protocol references: [Uniswap v4 deployments](https://developers.uniswap.org/docs/protocols/v4/deployments),
[Robinhood Chain documentation](https://docs.robinhood.com/chain/) and the pinned
Uniswap reference source/provenance in `backend/tests/reference/v4/`. The benchmark
uses the repository's reviewed PoolManager/StateView identities and existing ABI
parsers; it does not discover deployments by a token symbol or accept an arbitrary
contract from a client.
