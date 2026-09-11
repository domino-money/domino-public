# Read contract 1.1.0-rc.2 — coordinated prerelease notice

This disabled producer candidate follows the accepted #5/#26 decisions. The previous,
unreleased 1.0.0 manifest at `395856bf6ee3a0870c6fb674f9a260961d5f29ab`
has SHA-256 `09b7f6731356a0d2193846a2f0aee90ab7295131d1e5ef337b2e93596624a7f9`. Neither candidate has consumer sign-off or deployed compatibility obligations.
The new manifest hashes every generated file and the producer modules; pin its SHA-256
and the final producer commit in the shared #1 acknowledgement. Do not use a branch name as a pin.

## Observable changes

| Before | 1.1.0-rc.2 |
| --- | --- |
| Five browser read routes | Nine: adds catalogue, pool-activity, pool-positions, pool-metrics |
| Pool union inferred from optional fields | pools[].poolKind is discovery or catalogue; catalogue.items[] explicitly catalogue |
| Fee sentinel mixed with fixed fees | Every public response PoolKey adds feeMode fixed/dynamic; fee_pips remains raw, dynamic exactly 8388608 |
| Generic reason strings and priceToken string | Closed literal unions; known transport failures map explicitly, unexpected producer reasons fail closed |
| NFT integer block accepted through int64 | Request blockNumber is a nonnegative safe JS integer, at most 9007199254740991 |
| Catalogue revision integer through int64 | Same safe JS integer maximum; pagination requires revision |
| Optional nonnullable response fields advertised default:null | Invalid defaults removed; no coercion/default insertion |
| Historical incompleteness could fail the whole page | Known capital-not-ready/window-capacity states keep capital current/integrals null; price-capacity keeps already verified capital but USD and incomplete counts null |
| Unreconciled position endpoint raised an availability error | Valid snapshot response with positionAccounting unavailable and explicit reason |

Stored/raw PoolKeys retain their original five fields. Only the read response adds
feeMode; no PoolId hashing, execution or fee arithmetic changes. Merged historical storage changes retain their own accounting tests.
The provider pool-market feeApr24h stays null. Historical valuation has separate
qualified_historical_calculation / reference_analytics_only / unavailable states.
Reference analytics is never a production qualification. Qualified fixtures install
an offline test-only price registry; the production registry remains empty.

## Reconciliation with current main and the data producers

The candidate incorporates main `191e0a743d8af1c95400993cca6b456b8967ba5c`,
#52 storage safeguards, #58 bounded activity/recovery, #63 legacy Chainlink
storage guards and #59's historical-work projection. It supersedes rc.1; the
prior producer/manifest pins do not acknowledge this combined source. All 219
non-manifest read-v1 artifacts remain identical to the preceding rc.2 candidate.
Nine source hashes change; the current manifest SHA-256 is
`52941a3035a87c470ad2fde918cc69f4d340a75baf17944c55c0e6cfc107cb69`.

- Response JSON integer fields are bounded to JavaScript's safe integer range;
  smaller domain bounds stay smaller. Exact token amounts, growth counters and NFT
  IDs remain decimal strings. Out-of-range numbers are rejected, never rounded.
- `usableAsCurrent24h` requires fresh, complete, qualified historical valuation
  with a nonnull APR. `reference_analytics_only` keeps its calculated values and
  always leaves that flag false. No production price source is qualified.
- Only known progress/capacity/dependency states become unavailable ledgers.
  A position waiting on `reconciled_fee_chunk_required` remains readable with
  `position_ledger_not_caught_up`. Stored RPC/network/database failures return safe
  503/504 errors. Malformed, unknown or inconsistent work fails closed with 502.
  Capital reads validate both pending position and capital work before classifying
  it as ordinary lag.
- A saved capital-worker `reconciled_position_chunk_required` diagnostic can mean
  a missing chunk or a wrong methodology. The read checks that exact dependency:
  absence remains `capital_ledger_not_caught_up`; a mismatched methodology fails
  closed. Missing prerequisite positions use `reconciled_position_tail_required`.
  No new response enum is needed and the raw operator diagnostic is preserved.
- Price overflow is handled per currency: the other currency's exact diagnostics
  survive, verified capital is retained, and USD/APR remain unavailable.
- The manifest includes the handwritten Worker request validator. Boundary parity
  tests cover all nine routes. All nine HTTP handlers are registered once and use
  the same sanitized error boundary.

## Browser consumption

Use fixtures/gateway rather than producer fixtures; wallet pagination handles must
be opaque. All producer fixtures pass through the real Gateway.execute transformation.
Historical fixture responses run the actual store readers, fee/position/capital
calculations, ReadService canonicality check and gateway with synthetic SQL/RPC rows.
They are deterministic tests, not observed Robinhood balances, staging evidence or SLA.

The optional progressive.mjs helper provides one serial queue per screen, at most
12 distinct pending reads, identical-query coalescing, independent subscriber abort,
1.1-second minimum starts, two bounded 429 retries, Retry-After plus small jitter,
and a 60-second total budget including queued time. Last-subscriber cancellation
aborts obsolete work; dispose clears timers, pending work and retained data.
It retains six timestamped public token/market/catalogue/activity/metrics responses
per instance; it never retains wallet-assets or NFT positions. Dispose on screen/account
context replacement and render retained data with its original snapshot/freshness.
This helper is not imported into the app: Decimal must wire and test the actual adapters.

The original cheap-read regression uses three simultaneous five-read pages and a
longer explicit probe retry allowance. It does not exercise NFT-owner RPC work or
establish fairness for the helper's default two retries.

The added expensive-read regression uses the real ReadRpc ABI decoder, ReadService,
reader, gateway and JavaScript helper with 128 official-manager NFT positions.
It verifies 384 NFT identity/owner/liquidity RPCs. A controlled blocked provider
holds the real admission slot until five concurrent pages exhaust their default
retries; after release the full position response succeeds and admission recovers.
Separate cases verify reader deadlines stop additional RPCs and disconnected
clients do not release still-running work. No external provider is used.

This demonstrates a current capacity limitation, not a staging-capacity pass.
Positions should be loaded on demand after the first useful reads. Real provider
latency, simultaneous users, trusted client-IP ingress and bounded failure rates
still need measured staging acceptance before real activation. Increasing retries,
semaphores, replicas or wallet caching is not part of this reconciliation.
See [combined evidence](../reports/READ_BRIDGE_RECONCILIATION.md).

## Remaining dependencies and consumer acknowledgement

- The combined branch must pass the full PostgreSQL/EVM suite, including the real
  1446/1447 moving price window, mixed-source diagnostics, reorg/no-write rollback,
  reviewed quarantine and extended capital replay cases. The #63 legacy guards now
  join the same tree: both currency bundles must validate and commit atomically.
  Existing legacy observations are not cleaned or qualified by this integration;
  retain their original report/row evidence and the separate reviewed repair procedure.
- Actual database/integrity/RPC failure remains an error. Only named incomplete states
  are represented as unavailable data; those responses still undergo canonicality checks.
- Consumer acknowledgement remains PENDING. Decimal must record exact producer commit,
  contract version and manifest digest, frontend commit, nine covered routes, passing
  adapter/rendering tests (including unavailable/stale/partial and opaque continuation),
  and disabled capabilities on #1 and link it from #26. Five-route acknowledgement is partial.
  Reviewed disabled source can merge before this ACK; real consumer activation cannot.
- The capital work method digest changes when the combined read-side validation
  changes `capital_store.py`. An unpublished checkpoint from standalone #58 fails
  closed with `capital_work_method_mismatch`; use the reviewed restart procedure
  to rebuild it, preserving published ledgers. This is not an automatic migration.
- No deployment, real-data flag change, signer, wallet session or transaction activation.

Public reads do not require SIWE. The browser uses the same-origin BFF; the authenticated
service gateway makes a real loopback reader request. The reader still rejects browser
Origins. The reviewed invitation perimeter must cover pages and /api/* and protect
alternate hostnames. Main #61 provides the beta password gate; source integration
does not attest to its deployed configuration. Service authentication is separate.
CF-Connecting-IP is only a reviewed ingress abuse
identity, never wallet authorization. No CORS/header-forgery shortcut is accepted.
