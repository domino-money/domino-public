# API compatibility and frontend notice

Applies to [issue #5](https://github.com/domino-money/domino/issues/5) and the
frontend adapter owned by OxDecimal in [issue #1](https://github.com/domino-money/domino/issues/1).
This policy addresses the user's explicit request to announce real API
connections and field changes before frontend hooks consume them.

## Current baseline and gaps

The next disabled producer candidate is `read-v1 / 1.1.0-rc.3`, reconciling #26
with current main, #52 and the approved #59 projection. The
[coordinated change notice](READ_CONTRACT_CANDIDATE_1_1.md) records the nine routes,
field semantics, numeric bounds, fixtures, load-test limitations and consumer
acknowledgement requirements. Pin the final producer commit and SHA-256 of its
manifest; previous candidate acknowledgements do not cover this change.

Producer and gateway responses now have closed schemas, generated TypeScript,
runtime consumer tests, a typecheck consumer and a bounded progressive-read
helper. A [fixture/backend-local consumer ACK](https://github.com/domino-money/domino/issues/1#issuecomment-5630832974)
has been received; adapter review/integration and HTTPS qualification remain
pending on #1. The deployment and real-data switch remain disabled.

### NFT ID OpenAPI correction

The producer follow-up to [the issue #1 ACK](https://github.com/domino-money/domino/issues/1#issuecomment-5634425074)
describes `NftPositionsRequest.tokenIds` as canonical decimal strings from zero
through `2**256 - 1`, including a strict end of string. The old OpenAPI pattern
allowed 78-digit overflow and, in some JSON Schema validators, a final newline.
Python and the shared read runtime already reject those values; their accepted
requests, responses, errors and `1.1.0-rc.3` version are unchanged. Regeneration
changes the OpenAPI file and only the `backend/read_api.py` source entry in the
read manifest; shared schemas, validators, types and fixtures keep their bytes.
The OpenAPI pattern now appends `(?![\s\S])` to its `$` anchor; the shared schema
keeps `$` and its runtime already requires a full match. A textual schema diff
therefore still needs an explicit account of this equivalent runtime boundary.
Consumers must receive the new OpenAPI and manifest digests in the integration
notice before updating their source pins. This correction does not activate reads.

## Version and field rules

Use `read-v1` for the first browser contract major and a semantic contract
version (the current candidate is `1.1.0-rc.3`). It is distinct from the
Python application version and existing per-response `schemaVersion` values.
Do not rewrite those fields to make them equal.

Preserve successful backend payloads and names across the prefix mapping in
[the bridge specification](API_READ_BRIDGE.md), with one declared exception:
`inventory.nextCursor` becomes an opaque gateway handle and input `cursor` is
exchanged back server-side. Names, type and pagination semantics stay stable;
the internal signed cursor must never reach the browser. Keep separate
producer and gateway/browser fixtures and test that substitution explicitly.
Important PR #10 examples:

| Existing field | Meaning to preserve |
| --- | --- |
| `market.data.reportedLiquidityUsd` | Provider-reported decimal-string USD figure, possibly null |
| `market.data.volume24hUsd` | Provider-reported 24h volume, possibly null |
| `market.status` | Observation availability/rejection state; not transaction status |
| `market.cache.ageSeconds` | Retrieval age, not known provider update time |
| `priceHistory.data.currency` | Actual chart currency address |
| `priceHistory.status` | Includes `not_requested`; absence of a chart is not zero price |
| `feeApr24h` | Null in this candidate; do not manufacture an estimate under this name |
| `snapshot` | Preserve original block/hash/timestamp field names and units |
| `executionAvailable` | False in this read candidate |

These paths describe the pending candidate, not a field migration. Reference
the [actual fixture at the pinned commit](https://github.com/domino-money/domino/blob/c5fad7cbfe5f6d7d7c65ff0b02769f7bd050101d/reports/on-demand-market-http-probe-2026-09-09.json).
The complete schemas must also cover the other endpoints and nested states.

| Change | Required treatment |
| --- | --- |
| Rename/removal; type, requiredness, nullability, unit, identity, fee basis or semantic change | Breaking; new major/route or an explicit coordinated migration before any first release |
| New enum value or changed default/order/page behavior | Treat as breaking until consumer fallback tests prove compatibility |
| Optional additive field/route | Minor only after old-consumer tests pass and affected consumers are notified |
| Internal refactor with identical observable contract | Patch; tests prove existing fixtures remain accepted |
| Mock → real source, deployment target, cache/freshness or capability change | Operational notice and release acknowledgement even if schemas are unchanged |

For an already deployed major, keep the old route available for at least 30
days after a communicated replacement, until consumers migrate. Record any
longer agreed overlap. If an unsafe version cannot remain available, disable
the affected route with an explicit error and notify immediately; do not reuse
its field names for different semantics. New deployments cannot silently move
an existing major to an incompatible response.

## Negotiation and frontend behavior

The first live adapter will pin a contract major and accepted minor range in
its build. The capabilities response and `X-Domino-Read-Contract` header identify
the deployed version; every enabled read returns that header. The BFF validates
the producer contract before returning a successful response.

Unknown major, absent required version header, failed runtime validation or
unknown capability state means incompatible/unavailable. Preserve the previous
timestamped card and display a retry/update state. Do not coerce numeric strings,
replace missing fields with zero, calculate a guessed APR or enable financial
buttons to make the response appear usable.

The schema generator, manifest and header enforcement now have offline tests.
This candidate local API emits the contract header. Public deployment and the
frontend rendering/release matrix still require their own evidence.

## Required notice and acknowledgement

The author posts the notice to the integration issue and links it from the PR,
tagging @OxDecimal for frontend impact. If another issue contains affected
hooks, cross-link it. Send notice before merging a contract change or flipping
the data-source flag, not merely in the final release summary.

```text
API change / real-data activation notice
Issue and PR:
Backend commit and contract version/digest:
Frontend candidate commit and affected hooks/screens:
Routes and exact field changes (before -> after, or "none"):
Types, units, nullability, states and error changes:
Fixture/schema links and producer/consumer test results:
Environment and proposed activation window:
Feature flag, migration sequence and rollback:
Frontend acknowledgement link:
Backend acknowledgement link:
```

Acknowledgement means the consumer owner confirms its candidate handles the
contract and the planned switch. A comment's existence, silence, a suggested
reviewer or an assistant's prediction is not acknowledgement. The release
owner verifies the record before activation. Development behind disabled flags
continues while integration review is pending. Main protection remains in place.

This is currently a documented release process, not a GitHub-enforced deployment
gate. Its automation belongs with the actual bridge/deployment implementation.
