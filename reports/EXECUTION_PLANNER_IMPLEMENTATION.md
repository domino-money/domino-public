# E3 pure planner implementation evidence

12 September 2026 · [#87](https://github.com/domino-money/domino/issues/87)

The candidate evaluates self-compound, fee redirection, new Domino positions and
waiting using E1 observations and fee-origin budgets. It compares direct paths,
explicit smaller/full swap quotes and partial/full liquidity amounts with
separate owner and operator gates. It is offline, deterministic and non-signing.
The [contract and assumptions](../docs/PURE_EXECUTION_PLANNER.md) define its
scope and remaining integration.

## Source and dependency boundary

- New implementation: `backend/execution_planner.py`.
- New tests: `backend/tests/test_execution_planner.py`.
- New fixture verifier: `backend/tests/execution_planner_vectors.py`.
- New synthetic artifact: `backend/tests/fixtures/execution/planner-vectors.json`.
- E1 hardening dependency: `7d169696a7483608ae9b433fa25a32fe074c42e9` (#113),
  containing implementation `3b473247e93ddc071723215c254ae8fce759b752` (#99).
- Existing E1 models/accounting/receipt consistency, v4 math, API contracts,
  frontend, financial contracts, provider configuration and service flags are
  unchanged by this planner increment. No personal-bot source/runtime is used.

The synthetic artifact records five reproducible case summaries, its explicit
settings and its test constructor. It is a review fixture, not independent
proof of the calculator or a deployment profile. Independent formula/boundary
assertions in the tests establish the economically material properties.

## Focused validation

```sh
backend/.venv/bin/python -m unittest discover -s backend/tests -p test_execution_planner.py -v
```

**35 tests passed, zero skips.** The isolated environment uses the unchanged
pinned `backend/requirements-api.lock`. Test-only translations validate selected
self/redirect/swap budgets with the unchanged E1 `validate_candidate` boundary.
No provider, credential, real wallet, transaction or signer is used.

Covered cases include:

- Maximum eligible integer liquidity, no fixed reserve/growth cap, source-level
  floor rounding, exact fee plateau, mixed charged/original fees and retained
  reservations/accrual provenance.
- Finite direct/smaller/full swap/partial-quantity comparison, fee-only swap
  funding, minimum output, stale or unqualified quotes and complete-path gas.
- Independent owner/operator rejection, exposure/price/depth/gas changes,
  bounded sample and forecast windows, stale observation and unavailable data.
- Pool fee-budget conservation, incumbent owner dilution and zero new fee share
  when the owner already supplies all existing active liquidity.
- Both immutable quote orientations, independent trigger/overlap, inward ticks,
  raw half-open endpoints, existing successors, cap/pending states, below-range
  reuse/wait and nonrecursive incoming-fee routing.
- Zero/reserved incoming source cannot change a child's self-compound action
  into a redirect; inactive historical reserve cannot produce a new collection.
- Isolated read failure and recovery preserve samples/elapsed wait. Duplicate
  reads add no measurement; reorg epoch changes require fresh history. Token
  appreciation alone creates no earned fee units.

## Full integration and fixture reproduction

The coordinating agent ran the repository's full required PostgreSQL/EVM
backend suite on this candidate plus its #99 dependency: **1,347 tests passed,
zero skipped, in 157.357 seconds**. Production planner and focused test source
matched the independently reviewed bytes during that run. This does not imply
provider, fork, deployment or financial release qualification.

The five review examples reproduce with:

```sh
backend/.venv/bin/python backend/tests/execution_planner_vectors.py
```

**Five vectors matched.** This separate fixture verifier was added after the full
integration run; it changes no production code or discovered unit test and was
run independently. It imports only the synthetic test constructors.

`git diff --check` passed. Final repository hygiene checked **1,100 files with
zero findings**, including the fixture verifier. Generated runtime artifacts
remain ignored. Fixture SHA-256, identifying evidence rather than a signable
domain: `c5906a1a539d578d2ed71a7a0e397990298cef2dcc07a10e05b93a9377f0620f`.

## Independent internal review corrections

Read-only review identified and the implementation corrected four material
issues before publication:

1. A rate-per-liquidity extrapolation could exceed total pool fees and omit the
   owner's incumbent dilution. The current formula uses a bounded pool fee flow
   and incremental owner share. The exact low-flow case now rejects the oversized
   action; a sole owner has zero incremental share of fixed flow.
2. Routed sources with zero/fully reserved balances could incorrectly produce a
   redirect action. Sources/action now derive from actual consumed allocations.
3. Inverted orientation's excluded human floor was treated as an upper exit.
   The exact endpoint now redirects to an in-range member or waits.
4. Maximum-only sizing could wait despite a profitable smaller reinvestment.
   Explicit partial liquidity alternatives now participate in every path's
   economic comparison; the supplied counterexample selects a profitable partial
   action instead of its loss-making maximum.

All exact repros have regression assertions. The corrected implementation was
read again independently; 35/35 focused tests passed. Internal review does not replace the independent collaborator review required
by repository policy or the separate financial release gates.

## Practical limits

The chosen output is the best of the explicit finite candidate set, not a
continuous optimizer or proof of optimal execution frequency. A historical
minimum and haircut cannot guarantee future fees. Destination exposure, total
and competing liquidity bounds, independent price integrity, complete gas cost
and route admission need qualified real adapters. Boolean fixture assertions do
not supply that qualification.

`executionAvailable` remains false in every decision. Actual collection,
conversion, child mint, residual lineage, reservations, on-chain enforcement,
recovery and transaction reconstruction are not implemented here. The current
work does not close financial release gates or alter frontend/API contracts.
