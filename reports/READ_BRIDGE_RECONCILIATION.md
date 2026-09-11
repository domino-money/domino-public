# Read bridge and price storage reconciliation

## Scope and ancestry

The combined #26 producer incorporates main
`191e0a743d8af1c95400993cca6b456b8967ba5c`, #52 at
`484e9e6961fe9b05cad64c20a988664ee038993e`, #58 at
`0ce7da279e19e66cf08f9c6b90bfc53295444b7e`, #63 at
`8b98f29a9c02bc24319023b13c3485714a234f0b` and the previously approved #59
projection. Original branch ancestry is preserved. The #52/#63 updates are pure
merges of main; their feature patches are byte-identical to the earlier candidates.
These data producers retain separate review and integration records. Integrate
the reviewed data PRs before #26 and confirm the resulting base/diff after squash.

No new public API field, response enum, frontend wiring or live capability is added
by this integration. The 219 non-manifest read-v1 files are unchanged from #26
`a0821d5d537727fc7b1c2700b51f68d0dfc54d0e`; nine producer-source pins change.
The rc.2 manifest SHA-256 is now
`52941a3035a87c470ad2fde918cc69f4d340a75baf17944c55c0e6cfc107cb69`.
Pin this digest together with the final producer commit for consumer adoption.

## Result

- Ordinary unfinished fee, position and capital histories remain null/unavailable
  without losing canonical snapshot context. Known capacity and dependency states
  do not become 502 contract errors.
- Stored RPC/network/database failures produce finite 503/504 errors. Unknown,
  malformed, source, checkpoint or reorg diagnostics are not converted into ordinary
  lag. Capital reads check both sidecar layers. For the worker's ambiguous
  `reconciled_position_chunk_required`, the exact position chunk is reread: a missing
  dependency remains capital lag, while a wrong methodology fails closed. Operator
  reports, unpublished prefixes and committed ledgers are not modified by reads.
- Per-currency price overflow retains the other currency's exact diagnostics and
  already reconciled capital. All pool USD/APR values stay null on overflow. Real
  PostgreSQL tests exercise 1,446/1,447 observation windows and recovery.
- `usableAsCurrent24h` requires qualified, complete and fresh historical valuation.
  A real reference-only valuation fixture retains computed values but cannot set
  that flag. Pool-market provider `feeApr24h` remains null.
- `read-v1 / 1.1.0-rc.2` caps response JSON integers at JavaScript's safe range,
  preserves tighter domain bounds, and leaves raw amounts/NFT IDs as exact strings.
  The manifest pins producer sources and the handwritten Worker request validator;
  258 request boundary cases cover all nine routes in Python and both JS validators.
  Unexpected producer reason strings fail closed; only explicit transport codes are
  normalized. Duplicate HTTP registration and the unused raw-error fallback are removed.

## Capacity evidence and limitation

`backend/tests/test_read_expensive_capacity.py` uses synthetic stored rows and
provider transport, with the production ReadRpc ABI decoder, ReadService, reader,
LocalReaderHTTP, gateway and actual JavaScript progressive helper. Its identity
verifier is synthetic: it does not establish deployed ingress authentication.

The test includes 128 official PositionManager NFT rows, requiring 384 NFT
identity/owner/liquidity RPCs. A controlled provider stall holds the single admission
slot until five simultaneous pages exhaust the helper's default two retries. After
release, the complete position response succeeds and reads recover. The other
cases verify that a client disconnect keeps both admission gates occupied until
actual worker exit, rejected requests start no extra provider work, and a scaled
reader deadline stops subsequent RPCs and then releases capacity.

These are correctness and failure-behavior tests. The current global slot can still
make other pages exhaust retries during an expensive read. They do not qualify
provider throughput, public concurrency or staging capacity. The frontend can load
positions last and on demand; actual activation still requires cohort measurements
and acceptable error/latency results. This task does not increase retry budgets,
concurrency or replicas, and introduces no wallet/NFT cache.

## Current combined verification

The full combined producer passed **579 PostgreSQL/native-EVM tests, zero skips**.
The first run exposed three subcases of the inherited capital-corruption test
expectation described below; after that assertion was aligned with the strict
read contract, the entire suite passed. Production runtime was not loosened.
The 16 legacy-storage regressions and the #58 capacity/benchmark/recovery tests
run in this same suite.

The bridge command passed **794 JavaScript tests** (328 bridge and 466 shared
consumer/progressive), strict NodeNext TypeScript checking and both export drift
checks. Solidity passed **29 tests**, including seven fuzz cases with 512 runs,
and **three launcher tests**. Repository hygiene and `git diff --check` passed.
All checks used synthetic sources, disposable PostgreSQL and local native EVM;
the test database was stopped afterwards.

The app/web/lockfiles remain byte-identical to reviewed main191e0a7. That exact
frontend tree was freshly checked in the parallel #52 update: web17 tests plus
typecheck/lint/build; app64 tests plus typecheck/lint/build,17 served-build render
tests and8 beta-gate browser tests. These shared-source checks are distinct from
this candidate's bridge/contract tests; they are not live-adapter or staging evidence.

Independent source review compared 71 runtime files with their source PRs. Seventy
are byte-identical; the composed `capital_store.py` preserves the #58 writer AST
and the earlier #26 read-validation AST. Both sliced and legacy before-commit
guards are retained. All 220 artifacts and32 source hashes validate, with nine
source-pin changes and no public wire change. Consumer ACK and external approval
of the published head remain separate records.

## Earlier reconciliation evidence

The earlier main420/#52 producer passed **497 full PostgreSQL/native-EVM tests in 62.851s,
zero skips**, including the new persisted capital-failure and expensive-read cases.
The bridge command passed **794 JavaScript tests** (328 Worker/bridge and 466 shared
consumer/progressive), strict NodeNext TypeScript consumer checking, and both
export drift checks. Solidity passed **29 tests** plus **three launcher tests**;
all seven Solidity fuzz cases ran 512 iterations. Repository hygiene passed.
Tests used synthetic sources and this checkout's private disposable PostgreSQL
cluster. Exact producer/manifest pins are recorded in the #26 handoff.
Reproduce from a clean checkout with README's pinned Node/Python dependencies:

```sh
python backend/dev_postgres.py prepare-tests
DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1 python -m unittest discover -s backend/tests -v
python backend/dev_postgres.py stop
npm run check:read-bridge
npm run test:contracts
python scripts/export-read-contract.py --check
python scripts/export-read-openapi.py --check
node web/node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext api-contracts/read-v1/types.ts api-contracts/read-v1/runtime.d.mts api-contracts/read-v1/consumer.typecheck.mts
python scripts/check-repository.py
```

## Remaining release dependencies

### Issue #19 producer compatibility supplement

The projection now accepts the exact `activity_range_budget_exhausted` /
`review_activity_capacity_profile_then_resume` pair for fee, position and capital
work. It also accepts both the persisted legacy `repair_source_then_resume` and
the #58 `restart_unpublished_work_after_review` instruction for fee/position
`historical_work_method_mismatch`. These known states retain null financial
quantities and the existing public ledger-not-caught-up reasons. Unknown actions,
source/checkpoint corruption and invalid limits still fail closed.

The public rc.2 schema, types and fixtures remain unchanged. The combined tree
now contains the #58 ancestry and the #63 storage guards; regeneration updates nine
source pins, including the historical stores/capacity/accounting and Chainlink
reference validator. The earlier `cbc5b438…` digest does not cover this tree.

Earlier supplementary evidence included ten HTTP/projection regressions and a
separate probe over 20 actual #19 diagnostics with 28 route/helper checks across
both profiles and all three ledgers. The current combined suite runs those
versioned tests alongside the actual #58 and #63 tests; source validation does not
become a frontend ACK or production-capacity claim.

One inherited #58 test needed an integration expectation update. After it reseals
a tampered capital row identity, the worker still rejects the checkpoint before
reusing proof or publishing anything. The combined strict read now also rejects
the saved corruption with `upstream_contract_mismatch`, rather than reporting
ordinary unavailable data. The regression explicitly expects that error while
retaining zero-publication, unchanged-progress/count and no-proof-call assertions.
No runtime change was needed for this adjustment.

The capital method digest hashes all of `capital_store.py`; the combined read-side
checks therefore change that digest even though the #58 writer is preserved.
An unpublished capital checkpoint created by standalone #58 fails closed with
`capital_work_method_mismatch` until the operator reviews and restarts that work.
Restart rebuilds unpublished work; it must not rewrite published ledgers or skip
source events. Fee/position and capital restart limitations remain documented in
`docs/HISTORICAL_RECOVERY.md`. No stored checkpoint was migrated by this task.

Fresh review/CI are required for the final reconciled heads. Decimal's #1 acknowledgement
must name the exact rc.2 producer commit, manifest SHA-256, consumer commit, nine
routes and adapter/rendering tests. The shared package itself is not a frontend
integration or acknowledgement. Staging, Cloudflare credentials/routing, provider
capacity and real-data activation remain separate evidence gates.

The #63 fix now guards the legacy qualification write: complete reference success,
frozen canonical evidence and bundle integrity are checked before both currencies
commit atomically. Existing legacy rows are not repaired or qualified by this
integration. Their report/row evidence and separate repair gate remain in
`LEGACY_CHAINLINK_STORAGE.md`; #52's sliced quarantine does not accept that format.
The #52 writer-lock budget and reviewed quarantine limitations remain documented
in `PRICE_WINDOW_CAPACITY.md`. Production price qualifications remain empty.
