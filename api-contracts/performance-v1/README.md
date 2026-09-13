# Private collection cards — performance-v1

`1.0.0-rc.1` is a disabled candidate. No frontend route, Worker binding, listener
process, source flag or deployment is enabled by this package. It is separate
from `read-v1` and its public pool comparison data.

The internal POST path is `/internal/performance/v1/cards`; the exact response
header is `X-Domino-Performance-Contract: 1.0.0-rc.1`. Requests contain 1–8 unique
nonzero lowercase `epochIds` only. Owner comes from the existing SIWE session,
and the service reauthorizes before returning every result. Unknown and foreign
epochs share the same `not_found` card. No browser owner, provider, evidence,
signature or transaction parameter is accepted. This package creates no browser
path: the future authenticated BFF and its activation require separate review.

Tracked cards expose the original baseline, last recorded snapshot, source
revision, replay generation and raw observation counts. `observedSeconds` is
the recorded timestamp span, **not** proven income/capital coverage. Counts are
pages, receipts and events, not successful compounds or earned fees. Failed
reads retain the dated snapshot; reorg/replay states remain explicit.

`collectionStatus` is separate from `performanceStatus`, which is always
`unavailable`. All USD/APR/APY fields are required literal nulls. The reasons are
`financial_receipt_adapter_required` and `event_time_valuation_required`.
Neither 24 hours of raw observations nor a synthetic fixture unlocks financial
metrics. `complete24h` and `executionAvailable` are always false. Opening
capital/fees, raw receipts and private credential data never enter this shape.

`refreshAfterSeconds` is a bounded recommendation (30 or 60), not an installed
poller. The service rereads durable revisions and has no independent value cache;
HTTP responses use `no-store, no-transform`. A consumer must apply the shared
request budget to a visible-card batch, preserve original timestamps and check
that the response owner/ordered epoch IDs match its authenticated request. A
successful structural validation alone does not establish that association.

Use `runtime.mjs` with generated schemas/types. It supports the discriminated
`oneOf` cards, required null/false constants, safe integers, uint256 string bounds,
closed objects and cross-field collection invariants. Generic JSON Schema alone
does not enforce `x-maximum-raw` or every semantic invariant. Validators operate
on parsed values: JavaScript cannot recover duplicate keys or distinguish `30`
from `30.0` after JSON parsing. The producer's HTTP ingress rejects duplicate keys
and noncanonical numeric input; this candidate request has no numeric fields.

Fixtures are synthetic wire examples, not recorded wallet activity or provider
qualification. The manifest pins producer sources and generated files. Re-export
after any pinned source changes, then obtain the frontend owner's explicit ACK
under `docs/API_COMPATIBILITY.md` before integration or activation.

```sh
python scripts/export-performance-contract.py --check
python -m unittest discover -s backend/tests -p test_performance_contract.py -v
node web/node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext api-contracts/performance-v1/types.ts api-contracts/performance-v1/runtime.d.mts api-contracts/performance-v1/consumer.typecheck.mts
```
