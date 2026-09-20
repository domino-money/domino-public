# Reuse audit: generic persistent token data

Date: 19 September 2026. Reviewed baseline: `origin/main` at `bc336b5`.
Planning branch before this audit: `codex/frontend-data-latency`, `91dd52d`.

## Conclusion

Substantial relevant work is already integrated. The latency/persistence plan
must extend the existing queue, catalogue, followers, snapshots, contracts,
explorer and progressive reader. Several observed failures are incomplete
integration or runtime activation, not missing implementations.

The [revised plan](../docs/GENERIC_TOKEN_DATA_PLAN.md) separates that reuse from
the remaining generic token persistence and history work. A mandatory replacement
API family (`read-v3`) was removed; only a demonstrated wire-contract gap warrants
an additive contract. Existing strict V1/V2 consumers remain supported.

## Scope and evidence

- Fetched remote refs and examined current code, commit history, ancestry and
  integration equivalents. Git author names below attribute recorded commits;
  they do not identify which model or agent produced them.
- GitHub had no open PRs at inspection. Read the current discussions in
  [#138](https://github.com/domino-money/domino/issues/138),
  [#177](https://github.com/domino-money/domino/issues/177), and the focused tasks
  [#158](https://github.com/domino-money/domino/issues/158),
  [#160](https://github.com/domino-money/domino/issues/160),
  [#161](https://github.com/domino-money/domino/issues/161),
  [#163](https://github.com/domino-money/domino/issues/163),
  [#169](https://github.com/domino-money/domino/issues/169).
- All 14 existing, non-prunable registered local worktrees were clean before
  this documentation update. No uncommitted implementation was found there.
  This does not establish the state of an unpushed checkout on another machine.
- Runtime findings below come from the earlier same-day
  [production investigation](FRONTEND_DATA_LATENCY_2026-09-19.md), not new live
  probes. This review changed no runtime, deployed no services and reran no code
  suites. Existing tests were inspected as reuse evidence.

## Delivered foundations and exact remaining work

| Foundation already in main | Commit / recorded author | Remaining delta |
| --- | --- | --- |
| Durable pool requests, restricted SQL request function, deduplication, `SKIP LOCKED` claim and stale-claim recovery | [`8bdf831`](https://github.com/domino-money/domino/commit/8bdf831), Vinicius Dimovici Krul | Extend `pool_requests.py` / migration 020 for generic token interest, recurring due work and publication fencing. Do not create an unrelated competing queue. |
| Least-recently-served pool rotation | [`85f4163`](https://github.com/domino-money/domino/commit/85f4163), Vinicius Dimovici Krul | Fairness across job kinds and recurring `following` work. Basic round-robin is already implemented. |
| Arbitrary pool identity verified from Initialize | [`774f5b1`](https://github.com/domino-money/domino/commit/774f5b1), Vinicius Dimovici Krul | Connect submitted token searches to persisted metadata/discovery/acquisition. Any-pool identity itself is delivered. |
| Bounded followers, shared heads, AdaptiveSpan and within-pass retry | [`55efb5a`](https://github.com/domino-money/domino/commit/55efb5a), rugged97; [`914e8ba`](https://github.com/domino-money/domino/commit/914e8ba), Vinicius Dimovici Krul | Wire the adaptive path into `--queue-worker`, persist learned span and recur on following pools. That worker still passes fixed `args.span`. |
| Markets snapshot and bridge mapping | [`a1cd01f`](https://github.com/domino-money/domino/commit/a1cd01f), [`c13238f`](https://github.com/domino-money/domino/commit/c13238f), Crawber | Reuse snapshot/bridge while adding bundled metadata and preserving qualified V2 APR estimates. |
| Atomic snapshot file, startup restoration and background refresher | [`27a1d73`](https://github.com/domino-money/domino/commit/27a1d73), Vinicius Dimovici Krul | Generalize beyond the global 24-pool retention ceiling and enable its public consumption. Preserve original observation age during migration. |
| Separate stored/provider admission slots | [`48d84d5`](https://github.com/domino-money/domino/commit/48d84d5), crawber-bot | Fix gateway global health veto and snapshot lane selection. `pool-metrics` still checks canonicality via RPC; do not falsely classify it as provider-free. |
| Shared read source/scheduler, deadlines, pagination and public explorer | [`4592e67`](https://github.com/domino-money/domino/commit/4592e67), [`7e7173c`](https://github.com/domino-money/domino/commit/7e7173c), OxDecimal | Reuse those components; add durable registry/observation reuse across visits and generalized readiness. |
| Snapshot-first paint, per-row progress, retained rows, memory metadata and bounded failure recovery | [`39c59c2`](https://github.com/domino-money/domino/commit/39c59c2), OxDecimal | Refresh successful responses, remove metadata HTTP waterfall through aggregates, and allow charts to progress without unrelated rows. These are extensions to an existing progressive UI. |
| Batched pool identity and metadata reads | `328992a`, `d52c5ad`, Vinicius Dimovici Krul | Reuse and persist results; batching inside discovery does not remove the frontend's separate token-name requests. |
| Recent live activity window and honest coverage/display | `c0d647b`, `1458815`, `6d08cde`, `d5b0542`, Vinicius Dimovici Krul | Persist the recent window asynchronously and locate elapsed-time boundaries. Coverage labels were already corrected; do not repeat that fix. |
| Resumable activity/fee/position/capital accounting and canonical financial history | `918b45e`, `03ec1fa`, [`26e7294`](https://github.com/domino-money/domino/commit/26e7294), rugged97 | Schedule/activate existing reducers with qualified coverage; add missing public candle projections. Empty runtime ledgers do not mean no accounting implementation exists. |
| Direct pool-state/current-price architecture | [`c380695`](https://github.com/domino-money/domino/commit/c380695), rugged97 | Reuse [existing probes and decision](LOW_LATENCY_POOL_PRICES_2026-09-13.md). The report explicitly did not deliver a persistent ingestor. |
| Current local RPC, separate historical RPC and Alchemy inventory routing | `b2dcc8c`, rugged97 | Upgrade/configure the separately installed queue-worker release too. Reader activation did not upgrade it. |

Existing private performance work provides useful scheduling examples:
`275e5f3` (leases and fenced publication), `de529f2` (global RPC budget), and
`5f8b3c1` (minute projections), all recorded as rugged97. Reuse pure helpers and
test patterns; public acquisition must not borrow private owner tables/RLS or
the visibility expiry that stops private enrollment when a user leaves.

## Branches are not a second backlog

Each branch in this table passed `git merge-base --is-ancestor <ref> origin/main`
and had zero commits in `origin/main..<ref>`:

| Remote branch, under `origin/codex/` | HEAD |
| --- | --- |
| `any-pool-requests` | `3ae6a6c` |
| `any-pool-identity` | `774f5b1` |
| `any-pool-walk` | `55efb5a` |
| `request-queue-docs` | `81bac9a` |
| `queue-deploy-fixes` | `8ee8124` |
| `queue-worker-vm` | `8bfe77a` |
| `live-window-activity` | `6b2611a` |
| `read-pin-refresh` | `aad3452` |

Three other cases require more than an ancestry check:

- `codex/3-public-pool-explorer`: original commits `4c99fca` and `df76dd7`
  were integrated as squash `7e7173c` in
  [PR #131](https://github.com/domino-money/domino/pull/131). Their aggregated
  `app/` diff matches the squash, with patch-id
  `abcae56b97b17ef8e7000c17a25e14ed451295d7`. Separate `git cherry` plus signs
  do not establish missing work.
- `feature/read-screens-live`: the integrated transplant is `4592e67`,
  [PR #112](https://github.com/domino-money/domino/pull/112), including the
  shared source, scheduler and deadline fixes. Do not merge the old source
  branch over the newer implementation.
- Original financial commits `c3e243c` / `f64f277` are not main ancestors, but
  `26e7294` explicitly integrates the work from PR #125. The current financial
  projection also carries subsequent receipt-log-index improvements.

No integration of these old branches is proposed.

## What remains operational versus new

The earlier live benchmark found disabled public `markets-snapshot` and
`pool-metrics` capabilities, a provider-health veto on stored reads, 15 pools
parked in `following`, two repeated log-size failures and an older queue-worker
release. Those findings explain why delivered code has not yielded the desired
experience. They require integration fixes, explicit service configuration and
qualification; merely enabling every route is insufficient.

Genuinely unfinished generic behavior is narrower than the original plan:

1. Persist validated token metadata and aggregate search interest; connect
   submitted address/name selection to durable discovery/acquisition.
2. Keep identities/history beyond the 24-pool snapshot LRU, with recurrence,
   fenced publication, fair budgets and durable observations.
3. Acquire recent windows asynchronously and build bounded canonical history
   projections/candles while deep replay progresses independently.
4. Serve the required bundled metadata/figures/coverage with no upstream work
   on the stored path; extend a wire contract only where existing types cannot
   express it, preserving current APR semantics.
5. Extend existing UI queries with successful-data refresh and independent
   charts, then measure arbitrary-token/revisit/history behavior and capacity.

GitHub status must be interpreted chronologically. The 18 September #138
comment correctly described missing snapshot persistence then; `27a1d73` and
the subsequent #177 activation record supersede that finding. The latest
OxDecimal comment on #177, at 19:19:33 UTC on 19 September, confirms frontend
publication at `d5b0542`, acknowledges the corrected coverage labels, and points
to on-chain ingestion as remaining work. Issue checkboxes alone are not evidence
that code is missing, integrated or enabled.

## Plan corrections made

- Added an explicit delivered-foundations map and incremental delivery scope.
- Replaced a new-queue assumption with extension of migration 020 and existing
  catalogue/worker state, including a deliberate migration if replacement is needed.
- Replaced new adaptive/follower/accounting implementation with integration of
  the algorithms and reducers already present.
- Made `read-v3` conditional on the precise contract delta. Existing-route
  admission, storage and refresh fixes can proceed without it.
- Preserved public explorer, progressive rows, pagination, scheduler, APR
  interpretation and already-corrected live-window coverage.
- Kept genuinely missing persistence/recurrence/history requirements and the
  measured acceptance targets. Reuse reduces duplicate engineering; it does
  not establish that those targets are already met.

Validation for this change: documentation diff and evidence/reference checks.
No application code, tests, GitHub discussions or deployed configuration changed.
