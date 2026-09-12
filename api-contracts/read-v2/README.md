# Read-v2 pool estimate candidate

Contract `2.0.0-rc.1` adds an opt-in `pool-market` response at the production and
development gateways' `/internal/read/v2/pool-market`. Existing `read-v1`
schemas and payloads remain available. Keep consumer pins and runtime flags
consistent under the [execution policy](../../docs/EXECUTION_POLICY.md); no
named consumer acknowledgement is an execution gate.

The sole request is `{ "poolId": "<full lowercase PoolId>" }`. The gateway
obtains one completed read-v1 `pool-market` response with price history off,
then derives the estimate using its server clock. The wrapper contains
`schemaVersion`, `chainId`, `poolId`, the unchanged read-v1 body in `market`,
the separately named `estimate`, and `executionAvailable: false`.

`estimate.feeAprEstimate24hPercent` is a decimal string or null. Render it as
**estimated (24h)** with GeckoTerminal attribution and retrieval age. A reported
zero is zero; null is unavailable. Retained stale values keep their original
dates. Provider retrieval is not provider update time; this is not a qualified
historical APR, position return, APY, ranking or suggestion. `feeApr24h` in the
nested read-v1 body remains null. Dynamic fees, hooks, nonzero protocol fees,
invalid identities and unusable/expired inputs do not produce an estimate.

The package exports `CONTRACT_VERSION`, `ENABLED_READS`, `ROUTES`,
`ERROR_STATUS_BY_CODE`, `validateRequest`, `validateResponse`, `validateError`,
`assertRequest` and `assertResponse`. Assertions return the original input or
throw fixed safe errors. Validation never coerces, fills, repairs, fetches or
renders anything. The runtime is dependency-free and accepts parsed JSON.
Check the response contract header and request-to-response PoolId association
at the transport boundary as well.

Python recomputes the entire estimate from its nested evidence, including
PoolKey hash verification. The portable runtime checks observable identity
associations, inputs, provenance, state, ages, reasons and exact decimal value.
Its bounded BigInt arithmetic **only rejects inconsistent supplied values**;
it exposes no calculator and never supplies a replacement APR to the UI.
The runtime does not recompute Keccak, requalify on-chain identity, authenticate
the producer, reread canonical blocks or establish the provider's update time.
A producer identity rejection can only preserve an unavailable/null result.
Structural/runtime agreement is not proof of chain state or financial evidence.

`fixtures/producer/` uses the real reader, Gecko parser, cache and calculator
with fake transports and fixed clocks. No chart call, credentials, live RPC or
private collector is involved. The corpus covers exact amounts, zero, missing,
stale, expired, unsupported and rejected observations, plus invalid mutations.
`schemas/` describes shape; `x-domino-constraints` and runtime checks describe
relationships that a generic JSON Schema validator alone cannot enforce.

```sh
python -B scripts/export-read-v2-contract.py --check
python -B -m unittest discover -s backend/tests -p test_read_v2_contract.py -v
node --test api-contracts/read-v2/consumer.test.mjs
node --test api-contracts/read-v2/consumer.browser.test.mjs
node app/node_modules/typescript/bin/tsc --noEmit --strict --target ES2022 --module NodeNext --moduleResolution NodeNext api-contracts/read-v2/consumer.typecheck.mts
```

The browser test uses the app's existing `playwright-core` dependency and a
local Chromium installation (`DOMINO_BROWSER_PATH` may select it). It tests
the portable contract in a browser, not an integrated app screen. Generated
files use UTF-8/LF bytes; `--check` compares actual bytes and manifest digests.
