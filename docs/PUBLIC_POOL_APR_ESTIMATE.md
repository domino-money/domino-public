# Public pool estimate candidate — read-v2

Related to #95 and the pool-table/ticker consumer in #13. This is an opt-in,
read-only API candidate. It creates no deployment, activates no Worker or
listener, and changes no frontend metric presentation. The live read-v1
`1.1.0-rc.3` routes, schemas, fields, capabilities and headers remain available
with their existing meaning. In particular, `feeApr24h` remains null.

## One observation, two projections

`POST /api/read/v2/pool-market` accepts exactly `{ "poolId": "0x…" }`, with a
canonical lowercase 32-byte PoolId. The client cannot supply a clock, volume,
TVL, fee, provider URL or chart option. The response header is
`X-Domino-Read-Contract: 2.0.0-rc.1`; the independent package is
`api-contracts/read-v2/`.

The body contains `schemaVersion: 1`, `chainId: 4663`, `poolId`, `market`,
`estimate`, and `executionAvailable: false`. `market` is the entire unchanged
read-v1 pool-market payload. Its `priceHistory` is always `not_requested`.
`estimate` is the separately named pool estimate described in
[APR_METRICS.md](APR_METRICS.md), including exact decimal strings, method,
inputs, reasons, limitations and original observation times.

The gateway calls the existing reader's pool-market exactly once, explicitly
without a chart. After verifying the read-v1 response and reader generation,
it captures Unix time and derives the estimate from that same response. It
checks the requested PoolId and the complete wrapper before returning it.
There is no second provider read, new cache, history reconstruction or caller
choice of backend. The reader API and its OpenAPI are unchanged.

Both versions share the same single-operation gate, client budget, reader
health reconciliation and total deadline. An in-flight v1 read can make v2
return 429, and vice versa. Browser disconnects do not release actual reader
work. The existing finite error/status contract applies to both namespaces.

## Metric semantics

The estimate is `36,500 × volume24hUSD × LP fee pips / 1,000,000 / current TVLUSD`.
It describes a hookless pool with a fixed fee, using GeckoTerminal-reported
inputs. It is neither a quoted provider APR nor independently reconciled LP
income, selected-range performance, APY or a return forecast. The original
coverage/qualification limitations remain part of every estimate.

Available values require a current protocol fee of zero. Uniswap v4 encodes
two directional protocol fees in 12-bit fields, each bounded at 1000 pips;
nonzero valid fields yield `protocol_fee_unsupported`, invalid directional
values yield `invalid_protocol_fee`. Aggregate 24h volume cannot establish the
directional LP share. The zero-current-fee case still does not prove historical
protocol fees; `protocol_fee_effect_not_reconciled` remains a limitation. See
the vendored official [ProtocolFeeLibrary](../backend/tests/reference/v4/src/libraries/ProtocolFeeLibrary.sol).
The raw fee is retained as `estimate.inputs.protocolFeeRaw`.

`status` is `available`, `stale` or `unavailable`. A usable decimal string is
`feeAprEstimate24hPercent`; null means unavailable. Reported zero volume can
produce real zero, but missing volume, zero/missing TVL, unsupported fees/hooks,
identity failure or expired evidence cannot. A rejected currency observation
retains its identity reason even after the provider data has been discarded.

The effective market age is the older of the existing cache age and elapsed
Unix time since retrieval. At 60 seconds it is stale; snapshot age over 120 seconds
is independently stale. Either age over 300 seconds removes the estimate.
`retrievedAt`, unknown provider update time and the original snapshot are
preserved. Returning or displaying a response must never reset these ages.
A consumer retaining a result must add its elapsed holding time and expire it;
`evaluatedAt` is not a replacement source timestamp.

## Consumer handoff

The consumer can reuse the existing market projection with `response.market` and
add a separate estimate presentation. The existing `Market.feeAprPercent` and
qualified-APR path must not silently acquire this estimate's meaning. Use copy
such as “Estimated pool fee APR”, with the attributed source, observation age
and limitations available. Retained stale values need a dated/stale state;
unavailable values must not fall back to the prior number or sample data.

The package includes generated TypeScript, schemas, runtime validation and
producer fixtures for zero, missing, stale, expired, unsupported and rejected
observations. The runtime validates data and arithmetic consistency; it never
fills or repairs a metric for the UI. On-chain identity verification remains
the producer's responsibility. Runtime/schema acceptance is not an independent
chain proof or provider qualification.

`GET /api/read/v2/capabilities` reports only this version, its own enabled reads
and disabled/live mode. Old v1 clients continue to use their original prefix
and exact version. The Pages forwarder routes both prefixes to the same trusted
READ_BRIDGE binding, strips every browser credential and preserves the version
header. Integrate producer and consumer together under
[EXECUTION_POLICY.md](EXECUTION_POLICY.md). Keep v1 available for at least the communicated 30-day migration
period and until its consumers migrate; this candidate schedules no removal.

## Separate opt-in and acceptance

The committed Worker configuration keeps both versions disabled. Existing
v1 controls remain `READ_BRIDGE_ENABLED` and `ENABLED_READS`. The v2 controls
are `READ_V2_BRIDGE_ENABLED` and `ENABLED_V2_READS`; absent values also leave v2
off. The only v2 read candidate is `pool-market`. A v1 flag cannot enable v2.

The production gateway's `--enable-v2` and `DOMINO_BRIDGE_V2_READS=pool-market` are
independent from v1 `--enable`/`DOMINO_BRIDGE_READS`. They use the existing read
Access verifier and the same reader on 8876. The reader requires no new flag or
API route. The development gateway on 8891 separately accepts `--enable-v2`,
with only `pool-market` in V2 and the existing reader on 8890. Its profile schema,
hot admission, verified Access principal, data/control budgets and one worker
are shared across both versions. V2 capabilities use the same authenticated
`/internal/read/v2/capabilities` route; `/internal/dev/v1/status` retains its
V1 schema. An enabled V1 flag does not enable V2. Existing reader cooldown,
qualification expiry, provider limits and the seven V1 routes are unchanged.

The chart reader uses the explicitly requested currency address in the fixed
Gecko OHLCV route. The development transport accepts that exact address form
under the existing three-Gecko-calls/minute budget; no provider host is added.

Apply the authorized runtime update and record its observed outcome:

1. Qualify a reviewed immutable gateway release while retaining the existing
   continuous read profile, credentials and v1 availability.
2. Coordinate the exact Access/Tunnel path allowance for
   `/internal/read/v2/pool-market` on the existing read hostname. Existing
   path restrictions may currently reject it before it reaches the gateway.
3. Qualify the gateway with its independent v2 opt-in and the existing
   single-operation/admission limits. No provider egress expansion is needed.
4. Enable v2 on the one existing read Worker, then test through authenticated
   Pages: response identity, source/age, a usable estimate, missing/stale states,
   v1 compatibility and rejection of unauthenticated/cross-site requests.

Rollback disables only the v2 Worker flag first and then drains/disables its
v2 gateway admission under the reviewed operational procedure. Preserve v1
services and flags. No database or financial state migration is involved.
