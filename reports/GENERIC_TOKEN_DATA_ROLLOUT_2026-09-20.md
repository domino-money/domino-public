# Persistent public data rollout — 20 September 2026

**Current status: recovered and validated.** Runtime `3e304d8` is operational;
final verification below supersedes the temporary network interruption.
Acquired observations are available; historical backfill continues progressively.

Implementation: `db676d6430516b60b534d66820f85249d6048a2c` plus
`b0efeb30548c72e75c806c45cb31bac9437e04d1` (demand/history/CI repair).

## VM activation

The reader, gateway and three persistent collector lanes run the repaired release
on `domino-alpha-01`. They retain the existing private configuration, beta/Access
boundaries, TLS validation, systemd hardening and egress restrictions. Current
state uses the configured local Robinhood RPC; deep historical work uses the
separately configured archival provider. No financial execution was enabled.

Migrations 023–026 were applied transactionally. The original backup was restored
into a separate database; the final migration sequence was reapplied twice there.
A second 269 MB custom-format backup preceded the demand repair and passed archive
listing validation. Backups and private configuration remain in root-protected
storage on the VM. No observations or indexing checkpoints were discarded.

The initial live pass exposed a discovery feedback loop: a pool's currency
metadata also requested that currency's pool discovery. Stablecoin relationships
expanded into about 1,200 pools and filled pending admission. The collectors were
stopped before public V3 activation. Migration 026 separates explicit search from
metadata prerequisites, repairs artificial interest once, and preserves acquired
data. The prior 17 requested pools were re-admitted. Persistent scheduling gives
recent user demand three turns and background work one, without resetting that
cadence on worker restart. New explicit demand has capacity independent of
background prerequisites.

History now caches its exact window boundary against the pinned target. It
validates that boundary on resumption instead of searching from genesis for each
chunk. The adaptive span's successful-step count persists across ticks/restarts;
timeouts shrink the span, and eight successful steps allow it to recover.

## Bounded VM qualification

Evidence: [raw samples](public-data-vm-repair-2026-09-20.jsonl) and
[summary](public-data-vm-summary-2026-09-20.json). Nine samples, ten seconds apart,
read the real PostgreSQL-backed HTTP reader. This excludes public TLS, Cloudflare,
Access and browser costs; the small sample does not establish an SLA.

| Read | Median | Maximum |
| --- | ---: | ---: |
| Selected six-pool overview | 21.23 ms | 84.87 ms |
| Stored history | 14.28 ms | 16.35 ms |
| Generic-token overview | 32.21 ms | 35.19 ms |

Every measured response was HTTP 200 and passed the V3 request/response validator.
A previously unknown fixture token had verified metadata by the ten-second
sample and all 15 discovered pools ready by the thirty-second sample. Those are
sampling bounds, not exact acquisition durations. The response to the initial
pending request took 9.36 ms; pending does not mean its data was already acquired.

The six pools' chain ages ranged from 1 to 25 seconds during warm-up with the prior
17 requested pools plus the generic token's 15 pools. Across the last three
samples, ages were 1–14 seconds. This is evidence for the observed load, not a
freshness guarantee for arbitrarily many simultaneous tokens.

Stored pool count increased by exactly the searched token's 15 pools (1,252 to
1,267), and currency metadata did not recursively expand the graph. Existing
pending work continued to drain. Canonical historical coverage advanced from
1,401,562 to 1,707,810 blocks across 14 to 19 pools. There were 443 history jobs;
none had yet completed its whole requested window. Partial/stale history remains
explicit and no empty gaps are filled with fabricated candles.

## Verification

The implementation's earlier focused evidence is recorded in
[the implementation record](../docs/GENERIC_TOKEN_DATA_IMPLEMENTATION.md).
The repair additionally passed real PostgreSQL suites for observations (40),
queue priority (19), queue/CLI regression (26), history (32), and safe local
PostgreSQL cleanup (13); staging PostgreSQL and helper suites passed as well.
These are individual suite counts, not a deduplicated total. Contract exports
were checked sequentially V1→V2→V3; schemas, fixtures, types and runtimes stayed
byte-identical, while producer manifests/pins changed as required. Python/JS
parity passed 39 cases. Frontend build, lint, 34 pin/OpenAPI/adapter checks and
focused browser navigation/render regressions passed.

## Public rollout and comparison

[Publication workflow 35483926504](https://github.com/domino-money/domino/actions/runs/35483926504)
succeeded, publishing the same recorded frontend to preview/production and
activating authenticated V3 Worker/tunnel routes. V1/V2 remain available.

Three independent cold frontend data pipelines used the actual compiled app
loader, scheduler, adapter and contract validators against `https://domino.money`.
Authentication used the existing beta gate; credentials/cookies are absent from
artifacts. [Sanitized summary](frontend-stored-production-summary-2026-09-20.json)
links each raw run.

| Measure | Prior implementation | Stored V3 implementation |
| --- | ---: | ---: |
| Six rows + metadata settled, run1 | 21.243 s | 1.487 s |
| Run2 | 21.184 s | 0.390 s |
| Run3 | 19.460 s | 0.430 s |
| Requests per load | 17 | 2 |
| Scheduler waiting per load | 13.53–15.53 s | 0 s |
| HTTP429 responses per load | 2 | 0 |

All six new responses were HTTP200 and passed contract validation. The three
samples are not a public p95/SLA measurement. They measure the data pipeline,
not DOM paint, and include both cached and newly established network paths.
Settled metadata is not proof that external-provider TVL/APR is available.

A separate real browser verified the beta-authenticated homepage's six on-chain
ratios and generic TRADOOR discovery/detail with ratio-history controls. Existing
provider throttling was visibly represented as unavailable/stale. The validation
also exposed a cold-restart analytics-cache issue, addressed in the follow-up
record below.

Historical backfill continues independently of browser sessions. A first-ever
token request can return pending; fully acquired data and fully covered history
are separate states.


## Provider cache and collector period follow-up

A cold collector restart originally discarded in-memory provider cache state,
so a refused refresh could replace valid durable analytics with an unavailable
observation. The follow-up restores only eligible persisted observations before
collecting, preserves their original provider time/age, and still rejects invalid
identity/canonicality or expired data. Never-requested prerequisite pools no
longer consume external-provider quota. All 73 focused collector/cache/read and
deadline tests passed. The shared provider budget remains 25/minute.

The current-state unit's pause changes from1s to0.2s without raising RPC/claim
limits. [Journal qualification](public-current-period-qualification-2026-09-20.json)
recorded76 publication intervals for the six selected pools: median6.025s,
maximum7.015s; zero current-lane retries. This run searched RUBEN (one pool),
whereas the preceding repair run searched CRUMBS (15 pools), so it is not a
controlled load comparison. Tick-completion logs have up to one tick's timing
uncertainty. A final fixed-token qualification follows activation of the cache
repair.

The existing deep-queue worker records progress before ending its50-second
budget and returns exit1 for that deferred pass. Systemd can show that oneshot
as failed; the active timer schedules its next pass. The inspected passes each
persisted6–8 indexed steps. This is an observed retryable budget condition,
separate from the three continuously running collector services.


## Final deployment and interrupted qualification

Final runtime: `3e304d8e268b1b9ffda55771adfbf6a2471272e4`.
[Publication35484580611](https://github.com/domino-money/domino/actions/runs/35484580611)
succeeded. The VM activation confirmed reader, gateway and all three collector
services active at that release. The second release archive SHA256 was
`b65633575d12991dd9d5fa8ce4db4f44a686d4d8f7afbe62b55b960d398ad80e`.
The prior release's [full CI35483815064](https://github.com/domino-money/domino/actions/runs/35483815064)
passed Backend, Contracts, Repository hygiene, Frontend and Deploy gated preview.
The final cache delta passed its73 focused tests and28 pins/reconciliation checks;
its full CI was still running when the network interruption was diagnosed.

The final fixed-load run could not start: the clawber tailnet peer became offline,
with lastSeen `2026-09-20T02:40:19.1Z`. Local Tailscale stayed online. SSH to the
host and the VM failed before executing commands. The separate RPC endpoint
returned HTTP530/Cloudflare1033 (no connector), and the public data route returned
HTTP503/upstream_unavailable. The operator reported a possible residential-network
outage and was away from home. The exact failure cause has not been established;
no claim of successful final production qualification is made.

The earlier unpaced ad-hoc public probe files are retained: one transient503,
then five validated successes and a429 on the sixth immediate request. That429
matches the unchanged five-request client burst. The later paced attempt stopped
on upstream_unavailable while the host was offline. These probes are separate
from the three successful frontend-pipeline benchmark runs above.

A single [bounded recovery script](../scripts/watch-public-data-recovery.py)
waits up to120minutes without AI calls or saved credentials. It checks for the
known host, expected release and active services, then runs the fixed CRUMBS
(15pools)+six selected-pool loopback qualification once. It does not restart or
reconfigure infrastructure. Mutable status is written to
`reports/public-data-recovery-status.json`; completed samples, if obtained, go to
`reports/public-data-vm-final-2026-09-20.jsonl`. A timeout or failed attempt is
recorded explicitly. No unbounded watcher or recurring AI task was created.


## Network recovered — final qualification completed

The operator reported the network back at00:05BRT. The05:00 watcher was cancelled
and the final qualification ran immediately, without restarting or reconfiguring
any service. Reader, gateway and all three collectors remained active at
`3e304d8e268b1b9ffda55771adfbf6a2471272e4`; the collector target was enabled.
The [full CI for this exact runtime](https://github.com/domino-money/domino/actions/runs/35484523834)
passed all jobs, including Frontend, Backend, Contracts, hygiene and gated preview.
No subsequent product/deployment change was present on main.

The [authenticated RPC smoke](rpc-after-network-recovery-2026-09-20.json) used
the reader UID, its systemd mount namespace and the application's transport.
It returned chain ID0x1237 (4663), block67,609,234 with timestamp age0seconds,
and no JSON-RPC errors; the two-call batch took31.33ms. A raw DNS probe outside
the reader namespace had failed because DNS is intentionally denied to that
UID: the service mounts its approved host pins. No DNS or egress rule was weakened.

[Final raw samples](public-data-vm-final-2026-09-20.jsonl) and
[final statistical summary](public-data-final-summary-2026-09-20.json) now contain
real results for the same CRUMBS token with15 ready pools plus the6 selected
pools. All nine reads of each route validated. Loopback medians were21.52ms
(selected overview),13.74ms (history) and33.19ms (CRUMBS overview).

The first sample retained outage-era snapshots rather than inventing fresh
values. In the remaining eight samples, snapshot ages were1–11seconds. Six-pool
publication intervals had median11.069s and maximum14.007s; after excluding each
pool's first recovery interval, median11.000s and maximum11.996s. Journal markers
are emitted at tick completion and have the timing uncertainty documented in
the summary. Current/history recorded no retries in this final window.

Nine paced [authenticated public requests](public-api-recovered-2026-09-20.jsonl)
all returned HTTP200 and passed response/request identity validation:

| Route | Samples | Minimum | Median | Maximum |
| --- | ---: | ---: | ---: | ---: |
| overview | 3 | 860.00ms | 873.05ms | 1412.38ms |
| history | 3 | 123.45ms | 201.65ms | 234.51ms |
| search | 3 | 112.30ms | 155.12ms | 333.40ms |

These three samples per public route are not an SLA or public p95 estimate.
A real authenticated browser independently rendered CRUMBS with15 pool rows
(16 table rows including the header) and no console errors. The temporary tab
was then closed.

Historical stored coverage increased by700,000 pool-blocks across7 additional
pools during the80-second window. One global window was already complete, and
no new whole window completed in this sample. The requested chart remained
partial/stale with its acquisition gap visible. Provider analytics ended with
one available and five stale observations; their ages/provenance were preserved.
This qualification does not claim complete history or fresh external analytics
for every pool.

No recovery watcher or periodic AI monitoring remains active. The mutable status
file records the completed qualification and the cancelled schedule.
