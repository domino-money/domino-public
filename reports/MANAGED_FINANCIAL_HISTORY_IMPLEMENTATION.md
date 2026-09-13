# #97 financial history integration evidence

Date: 2026-09-12. Branch: `codex/97-financial-history`.

## Scope and review base

This delivery connects #117's persisted canonical observations to #120's actual
V3 compound effects, complete per-block capital observations and an exact,
conditional private performance projection using stored qualified prices.
It does not close #97 or activate a service, signer, financial route, source,
frontend hook, VM migration or infrastructure change.

The review base `codex/97-financial-history-base` at
`7c4b82c700983c2a67ef08424a24a6c3ec73a5b6` is a **dependency-only aggregation** of
#117 (`26c0dca17d52a119fcb48a6ac4f3b29bcf82caf7`) and #120
(`6972d1f3eca048734cd2de041456e9dc0acfd255`), with main
`cc43d6c` (including #119 and #122). The only dependency merge resolution retains
both backend README descriptions. This base is not a separate delivery to merge.
Review this PR's delta, integrate the independently approved parents normally,
then rebuild/rebase this delivery onto main and verify the resulting delta/CI
before its own integration. Do not merge it into the temporary base branch.

The #119 correction was independently confirmed merged as `e6012dc`, from head
`cd9c701cad5c5c80f236313a30f2cc7ee7e54bc8`, with Decimal's approval and all four
checks passing; no competing branch update or duplicate integration was made.

## Evidence and corrections

- Exact acquired principal, pending fees, registration/core state and actual
  vault holdings include native residual and every known child's source reserves.
  The residual is counted once; principal appreciation is not trading income.
- The bounded worker derives V3 admission and plans from actual pinned getters
  and transaction calldata, runs the real receipt verifier, and saves JSON-only
  effects under raw/financial revision and replay-generation fences.
- Actual official-v4 local transactions pass through worker, verifier, reducer
  **and PostgreSQL**, including restart without double counting. Separate native
  and ERC20 flows prove old opening fees and waiting reserves do not become new
  earnings or receive duplicate service cuts.
- Private exact inputs now support up to 400 fractional digits/512 characters;
  final display rounding remains 18 places. Later blocks at the opening second
  carry block numbers and are distinguished from opening balances.
- Qualified prices are checked at actual dated credits/costs and every capital
  boundary. Unknown decimals, price gaps, foreign currencies, stale/reorged
  observations and ambiguous membership cannot produce complete APR.

Independent audit found and reproduced three reducer/store defects, all fixed:
(1) a same-block owner→other→owner transfer looked continuously owned; receipt
transfers now interrupt continuity; (2) a withdrawn child's unavailable NFT
principal poisoned all later blocks; proven inactive members now leave capital
while their fee reserves remain tracked; (3) page payloads were fetched before
applying the memory limit; one repeatable-read snapshot now checks SQL byte/count
bounds before payload loading.

The actual PostgreSQL/EVM integration exposed a fourth defect: reapplying 016
revoked 017 writer grants through `ALL TABLES`. Migration 016 now changes only its
five own tables. A regression reapplies 016 and then performs a financial write.
017 reapplication, malicious role/ownership drift, forced RLS, reader mutation
rejection, concurrent failure writes, replay generations and actual dump/restore
are covered. This change is packaging-only for staging: 001–014 remain the applied
foundation; 017 is explicitly admitted as inert source with its separate hash.

## Local validation

- Full backend run: **1,541 tests executed with PostgreSQL and EVM, zero skips**.
  The behavioral tests passed; the run identified two generated-artifact drift
  assertions after the private calculator schema changed. Regenerated only
  `docs/metrics-examples/managed.input.schema.json` and its manifest; the two
  focused example tests then passed. Example numerical outputs are unchanged.
  Exact-head remote CI must repeat the full suite after this correction.
- **163 Foundry tests + 15 Node contract/tooling tests passed**, with the pinned
  compiler/artifacts built in this isolated checkout. No production contract
  code was modified by this delta.
- Staging: **109 offline helper/upgrade tests + 18 disposable PostgreSQL tests
  passed**. No host installer or VM operation was run.
- All six API/export checks passed (read, read OpenAPI, session, onboarding,
  deposit, performance). Repository hygiene and authored whitespace checks passed.
- Independent reviewers ran the two new lifecycle regressions, 12 worker unit
  tests, 22 projection tests and 18 valuation tests, and reviewed the corresponding
  source/SQL boundaries. They are additional evidence, not GitHub peer approval.

The only dependencies used were the product development environment, task-local
PostgreSQL and isolated Anvil with pinned official-v4 reference sources. No
production credentials, upstream price/RPC probe or personal-bot runtime was used.

## Consumer notice and remaining gates

`performance-v1` **1.0.0-rc.1** still has identical schemas, fixtures, types,
validators and null financial fields. Only the two producer-source hashes
(acquisition and migration016) changed. New manifest SHA-256:

`1a390fb5271f7caa94ef5eeb7e667a303d502e457a2423e43bb7fbd632904cc9`

Decimal must acknowledge that exact producer candidate before adopting it. The
new private numerical projection is not a `performance-v1` response. No field was
silently renamed or widened for existing consumers. The shared metrics-example
manifest includes both calculator hashes; a concurrent pool-calculator change
must regenerate it after integration.

#97 remains open for reviewed actual source qualification (the production registry
is still empty), enrollment/epoch binding, failed/known executor attempt recovery,
future Domino/swap effect attribution, capacity/materialization/refresh
qualification, and a separately reviewed numerical card contract plus frontend
consumer integration. Gross native flows and complete L2 operator costs remain
unqualified; known records are retained separately. Current page/record limits
are explicit failure bounds, not a production full-day capacity guarantee.
See [the implementation contract](../docs/MANAGED_FINANCIAL_HISTORY.md) and
[dated price-source gaps](../docs/MANAGED_EVENT_TIME_VALUATION.md).
