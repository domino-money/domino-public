# Read-v1 contract candidate

This shared package describes the nine backend 0.8 read response families and
the proposed bridge capabilities. Contract `1.1.0-rc.3` is a release candidate behind
disabled live flags, pending the acknowledgement recorded in
[API_COMPATIBILITY.md](../../docs/API_COMPATIBILITY.md). It does not activate
frontend imports, establish a wallet session, authorize transactions or deploy
a public service. Existing response `schemaVersion` values remain 1 or 2.

- `schemas/`: standalone JSON Schema draft 2020-12 requests/responses. Every
  response object has explicit properties and rejects unknown keys. Optional
  fields reflect actual omissions; required nullable fields cannot be omitted.
- `types.ts`: generated TypeScript types. Monetary and raw uint256 values are
  strings; never convert them to `Number`. Other integer fields retain their
  backend wire units (block numbers, Unix seconds, pips, ticks and counts).
- `runtime.mjs` and `runtime.d.mts`: portable, dependency-free validation for
  Node, Workers and future mock/live adapters. `validateResponse` and
  `validateRequest` return booleans; `assertResponse` and `assertRequest` return
  the original validated object or throw a fixed safe error. `validateError`
  checks both the finite code and its HTTP status. No function coerces values,
  inserts defaults, removes unknown fields, renders HTML or fetches URLs.
- `fixtures/index.json`: deterministic producer, gateway, error and incompatible
  payload cases. Producer fixtures run the real `ReadService`, Gecko parser,
  market cache and inventory adapter with fake upstreams. Tests use synthetic
  identities and a public fixture HMAC key; no network or private configuration.
- `manifest.json`: contract/application versions and SHA-256 digests. The
  generator fails on schema, type, fixture or runtime drift.

```sh
backend/.venv/bin/python scripts/export-read-contract.py
backend/.venv/bin/python scripts/export-read-contract.py --check
backend/.venv/bin/python -m unittest discover -s backend/tests -p test_read_contract.py -v
node --test api-contracts/read-v1/consumer.test.mjs
```

```ts
import { assertResponse } from './runtime.mjs';
const payload = assertResponse('pool-market', await response.json());
// Render payload.market.data?.volume24hUsd without manufacturing a missing value.
```

Validate the required `X-Domino-Read-Contract` header and accepted contract range
before calling the body validator. The validator does not authenticate a
response, prove freshness, enforce transport budgets or inspect browser origins;
those are gateway/BFF responsibilities. It expects parsed JSON. A transport
must reject duplicate keys and preserve numeric integer lexemes when forwarding
numbers. NFT block and catalogue revision requests are constrained to safe JS integers. `BigInt` can interpret decimal
quantity strings after validation, but no automatic conversion occurs here.

Request schemas include `x-domino-constraints` for relational requirements JSON
Schema cannot express without custom extensions: currencies differ ignoring
case and explicit pool IDs fit `maxPools`. The runtime enforces these and unique
uint256 NFT IDs. Consumers must use the runtime, or implement all documented
extensions alongside a standard schema validator. The runtime fails closed on
unknown schema assertion keywords and is tested against the same producer corpus.

`inventory.nextCursor` is the sole gateway success transformation: the signed
producer cursor becomes a 256-bit opaque handle. Separate
`wallet-assets.page.json` and `wallet-assets.opaque-page.json` fixtures prove that
all other fields, names and nullability remain identical. The fixture uses the
actual gateway's `OpaqueCursors.wrap` and `unwrap` with deterministic test
randomness, including continuation through the production inventory service;
its handle is 64 lowercase hexadecimal characters. A cursor conveys
pagination state, never wallet ownership.

Pool-market chart selection is pool-relative: `selectedToken` keeps the request's
`priceToken`, `currency` is the corresponding `market.data` token address, and
history `baseToken`/`quoteToken` keep that market's orientation. The producer asks
GeckoTerminal for the explicit address and requires it in OHLCV `meta.base`, then
maps only verified metadata labels back to the pool orientation. No candle is
inverted or filled; duplicate timestamps reject the chart without erasing market
metrics. See the [#92 qualification report](../../reports/ALPHA_CHART_CURRENCY_QUALIFICATION_2026-09-12.md)
for public evidence and the separate upstream/chain trust boundaries.

Metadata symbols and provider labels are untrusted text even after validation.
Render them as escaped text (for example ordinary React interpolation), never
HTML, and do not use source metadata as fetch/link/image destinations without a
separate policy. Consumer tests deliberately retain an HTML-like symbol.

The consumer tests validate the shared payloads and mutation cases. The actual
OxDecimal frontend adapter and rendered screen tests remain a separate handoff;
this package does not claim that the current practice UI consumes live reads.


See the [coordinated prerelease notice](../../docs/READ_CONTRACT_CANDIDATE_1_1.md)
for the before/after contract, exact unavailable states, progressive.mjs helper,
load-test limits and required consumer acknowledgement. consumer.typecheck.mts
proves poolKind, feeMode, priceToken and nullable historical state narrowing;
CI also runs consumer.test.mjs and progressive.test.mjs at runtime.

## Reconciled candidate 1.1.0-rc.3

This stricter, still-disabled candidate preserves field names and raw amount
strings. Every response JSON integer is bounded to JavaScript's safe range
(`-9007199254740991` through `9007199254740991`), with nonnegative or tighter
protocol limits where applicable. Raw uint256 and cumulative monetary strings
retain their existing ranges. Never round an oversized number into this range.

`pool-metrics.usableAsCurrent24h` may be true only with
`valuation.status: qualified_historical_calculation`, complete 24-hour capital
and valuation, fresh snapshot status and a non-null `feeAprPercent`. This
relational rule is exported as `x-domino-constraints` and enforced by the Python
and portable runtime validators. A reference-analytics fixture deliberately
retains calculated APR/TVL while keeping the flag false. This does not admit a
production price source.

The manifest also pins the handwritten Worker request validator. Boundary
parity tests compare the Python request models, shared runtime and exact-lexeme
Worker validator across all nine routes. This candidate requires a new exact
consumer acknowledgement before integration; no live flags are enabled.
