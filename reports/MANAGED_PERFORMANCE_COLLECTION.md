# #97 canonical collection implementation evidence

Date: 2026-09-12. Base: `b50d4b0af05a03b9c8e6a5b77cbfff8156f0719c`.
Branch: `codex/97-managed-performance`. #116 merged during this work; the candidate
was rebased onto its resulting `main` before final validation. No contract source, frontend source, running
service, VM, Cloudflare configuration or personal-bot state is changed.

## Delivered

- Canonical, read-only opening and bounded relevant receipt/event acquisition.
- Private PostgreSQL journal with immutable openings, revision fencing, replay
  generations, preserved orphan inclusions and owner isolation.
- One-step internal worker with durable failure/reorg handling and no scheduler.
- Disabled authenticated batch-card producer, closed `performance-v1` candidate,
  TypeScript/Python/browser validators, fixtures and content/source hashes.
- CI export drift and shared type checks; [acceptance and integration limits](../docs/MANAGED_PERFORMANCE_COLLECTION.md).

## Review findings resolved before handoff

The independent review reproduced finality retreating during opening capture.
Capture now confirms the finalized boundary again before accepting it. Reorg
exceptions confirm the currently observed opening header; a failed confirmation
preserves the old journal and records a read failure.

Root review also required isolated role membership/DDL ownership preflight,
relevant-only receipt requests, strict scalar/model bounds, coherent card states,
and incremental response budgets. A raw journal span never becomes a proof of
fee or capital coverage. Opening holdings and accrued fees cannot populate the
financial response fields.

The first remote CI run exposed a test-fixture race: Anvil may return a transaction
hash before publishing its receipt. The EVM fixture now polls for that same mined
transaction under a five-second deadline, without resending it or inventing a receipt. The
production collector and exported consumer digest are unchanged by this correction.

## Validation

On the rebased candidate, the full backend suite passed **1,363 tests in 155.553
seconds, with zero skips**, with both PostgreSQL and Anvil enabled. Contract checks
passed **129 Foundry tests and 14 Node tests**, including the bytecode budget.
TypeScript strict consumer checks, all existing contract exports, the new export,
and repository hygiene (1,132 tracked files, zero findings) passed. The new contract
includes 158 Python/browser boundary cases. Remote exact-head CI is recorded in
the PR. Reproduce with a product-only environment and task-local PostgreSQL:

```sh
npm ci --no-audit --no-fund
python -m pip install -r backend/requirements-api.lock
python backend/dev_postgres.py prepare-tests
DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1 python -m unittest discover -s backend/tests -v
python scripts/export-performance-contract.py --check
npm --prefix web ci --no-audit --no-fund
node web/node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext api-contracts/performance-v1/types.ts api-contracts/performance-v1/runtime.d.mts api-contracts/performance-v1/consumer.typecheck.mts
npm run test:contracts
python backend/dev_postgres.py stop
```

New checks exercise RPC header/log/receipt disagreement, request and memory caps,
same-timestamp ordering, failed reads, duplicate pages, CAS races, real PostgreSQL
dump/restore, RLS even with omitted owner filters, SQL reader isolation, immutable
history, reorg/re-inclusion and terminal opening changes. HTTP checks cover Access,
origin, session/CSRF/admission error mapping, late revocation, uniform foreign/missing
epochs, batched reads, stale snapshots and rejection of financial-number injection.
Browser/Python parity checks include all states and nested closed-object mutations.

The local Anvil tests compile synthetic getter/event contracts and exercise real
EIP-1898 reads, receipts, gas fields, transaction-local ordinals and reorgs through
the read-only adapter. They do **not** qualify deployed E2 contracts, production
tokens, RPC finality/completeness, income origins or event-time prices. No upstream
RPC, wallet secret or financial transaction is used by these tests.

## Actual integration boundary

#97 remains open. #88/#89 must supply canonical economic effects and immutable
earned origins, and qualified prices must value complete capital intervals before
the #96 calculator can publish real fees or individual APR. Raw receipt gas stays
evidence; it is not an extra automatic strategy debit or qualified net L2 cost.
The current card contract deliberately requires null financial metrics and false
complete-day/execution flags, even after 24 hours of raw observations.

The new contract requires Decimal's exact digest/version/fixtures acknowledgement
before frontend/BFF integration. Production admission, collector scheduling and
30–60-second refresh capacity still require a measured release configuration.
Public pool comparison data and existing read/session/onboarding/deposit contracts
retain their existing schemas and pins. This candidate neither completes #97 nor
claims that live APR is already connected to the user's cards.
