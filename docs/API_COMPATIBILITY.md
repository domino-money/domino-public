# API compatibility and frontend notice

Applies to [issue #5](https://github.com/domino-money/domino/issues/5) and the
shared frontend adapter in [issue #1](https://github.com/domino-money/domino/issues/1).
Technical compatibility rules remain applicable. Under [EXECUTION_POLICY.md](EXECUTION_POLICY.md), any authorized collaborator may update producer and consumer together; a notice records the change and does not require a named owner's acknowledgement or a separate approval window.

## Mode-specific automation fees — 21 September 2026

The owner selected 200 bps for simple Auto-compound and 400 bps for every
Domino-compound recipe. Policy's Solidity tuple and E1 typed field order are
unchanged; the exact rate now discriminates mode and new policies accept only
those two rates. Simple requires `maxPositions=1`, root-only sources and
same-position execution. Historical receipts remain historical; the public
receipt rate maximum widens from 200 to 400 without repricing old events.

The predeployment sequence profile now requires `dominoServiceFeeBps:400` as well
as `serviceFeeBps:200`. Producer, bridge, SDK, wallet review and generated receipt
schemas change together. The closed parser refuses old single-rate profiles for
new admission. Candidate `1.0.0-rc.1` and route names remain unchanged while these
undeployed producers/consumers are revised; fresh manifest and runtime pins are
required. A mainnet deployment has not been activated against either profile.

SDK `SequenceOptions.automationMode` is required. An owner may explicitly select
a new mode in `setPolicy`; omission preserves the current mode. Policy version
and state nonce invalidate prior prepared plans. Withdrawals remain owner-only
and available independently of tariff eligibility. No assisted-swap cap change
or second internal-swap fee is part of this update. The unapplied candidate
`backend/schema.sql` also admits only 200/400 for new sequence policy; existing
runtime journal migrations and historical receipts are unchanged. Regenerate
any candidate staging bundle whose schema digest pins that file.

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
describes `NftPositionsRequest.tokenIds` as unique canonical decimal strings from
zero through `2**256 - 1`, including a strict end of string. The old OpenAPI
pattern allowed 78-digit overflow and, with Python `re.search`, a final newline;
the array also lacked the `uniqueItems: true` metadata.
Python and the shared read runtime already reject those values; their accepted
requests, responses, errors and `1.1.0-rc.3` version are unchanged. Regeneration
changes the OpenAPI file and only the `backend/read_api.py` source entry in the
read manifest; shared schemas, validators, types and fixtures keep their bytes.
The OpenAPI pattern appends `(?![\s\S])` to its `$` anchor.
[ECMAScript](https://tc39.es/ecma262/multipage/text-processing.html#sec-compileassertion)
without the multiline (`m`) flag already requires the actual end at `$`;
[Python `re`](https://docs.python.org/3.14/library/re.html) can also match before
a terminal LF. The extra assertion guards that Python behavior. The shared
schema keeps `$` and its runtime also requires a full match, so a textual schema
diff still needs an explicit account of this equivalent runtime boundary.

[JSON Schema's recommended regex subset](https://json-schema.org/understanding-json-schema/reference/regular_expressions)
explicitly includes positive and negative lookahead; this assertion is not
excluded from that subset. That guidance does not establish compatibility with
every tool. The persistent Node test runs the exported pattern in ECMAScript
with `u` and without `m`, checks array metadata, and compares existing runtime
acceptance. The Python regression covers `re.search`, the model and HTTP input.
The separate #74 Ajv 2020-12 boundary evidence remains specific to the tested
tool/version; neither native regex test is a complete JSON Schema validator.
Consumers using other engines must verify equivalent bounds and uniqueness or
reject unsupported schemas, rather than dropping the assertion or coercing IDs.
Consumers must receive the new OpenAPI and manifest digests in the integration
notice before updating their source pins. This correction does not activate reads.

### Private listener response transformations

Following [the HTTPS handoff request](https://github.com/domino-money/domino/issues/45#issuecomment-5634619206),
the read gateway (8878), session (8879), onboarding (8880) and deposit (8881)
listeners emit `Cache-Control: no-store, no-transform` on successful and error
responses. Their JSON remains uncompressed, with its exact `Content-Length`;
the Workers still reject non-identity `Content-Encoding`. The directive asks
intermediaries to preserve those bytes; offline checks do not qualify an actual
Tunnel/Access path. Payloads, size limits, versions and enablement stay unchanged.

The four manifests record the listener sources that determine these headers,
including newly listed session and authenticated-service listener files. Only
source provenance changes, not the shared schemas, fixtures or validators.
The disabled HTTP smoke now checks cache directives independently of order,
requires `no-transform` on these four private listeners and rejects compressed
responses. It intentionally fails against the earlier `a5a855c` installation
until the listener update is rolled out. Historical installation evidence and
the reader-only `no-store` policy on 8876 remain unchanged.

## Version and field rules

### Slippage bound on a person's own requests

`slippageBps` on `onboarding-v1` swap-preview and position-preview and on the
`deposit-v1` create selection is now 10 to 500 basis points (0.1% to 5%), both
ends included, instead of 0 to 9999. The wider range was the provider adapters'
guard, never a product limit; the bound is now the one the app offers a person
(presets of 0.1%, 0.5% and 1%, a default of 0.5%, any exact hundredth of a
percent up to 5%, a warning above 1%) and the request models check the same
numbers. Contract versions are unchanged: request and response names, types
and requiredness are the same, both producer and the only consumer moved in
the same commit, and both packages remain disabled candidates. Regeneration
changes only the `slippageBps` `minimum`/`maximum` in the schemas that carry
it, `schema-data.mjs`, the READMEs and the manifests; the app's producer pins
follow the new manifest digests. A stored deposit draft with a slippage outside
the bound would now fail response validation; none exists on any deployment,
and the fixtures all carry 50.

The [#123 bounded RPC batching notice](READ_RPC_BATCHING.md) records source
`adba60f45fe20e53b2b38fde040c9eeb03fad380` and the regenerated read manifest.
Only three backend source hashes change; the shared wire files, OpenAPI,
contract versions and other manifests remain identical. The candidate still
needs its full endpoint qualification before rollout. Display aging also no
longer claims that a refresh failed when none was attempted.

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
| Mock → real source, deployment target, cache/freshness or capability change | Concise operational notice even if schemas are unchanged; no mandatory acknowledgement |

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

## Change notice without an approval queue

Record meaningful API or real-data changes in the existing issue/PR or commit with the implementation. Any authorized collaborator can update and validate the affected producers and consumers; no advance notice reply, frontend-owner ACK, backend-owner ACK or release-owner sign-off is required. Use the current [execution policy](EXECUTION_POLICY.md), including for older candidate notices that describe the former acknowledgement process.

```text
API / real-data change
Commit and contract version/digest:
Affected routes, fields and consumers:
Compatibility/migration and fixtures:
Checks actually run and known limitations:
Environment, activation and recovery:
```

Keep the technical version/field semantics above. Fix real incompatibilities or use a compatible migration/rollback; do not wait for a particular collaborator merely to approve work that can be completed directly.
