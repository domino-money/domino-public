# On-demand market reads: backend 0.8.0

The local HTTP API now returns provider TVL, 24h volume and optional hourly price
candles for a verified Robinhood Uniswap v4 pool without a local catalogue or
lifetime backfill. This implements the [MVP data strategy](../MVP_DATA_STRATEGY.md).
The public web preview remains practice-only.

## Live HTTP result

A temporary server bound only to loopback served real HTTP requests with
`catalogue=None`. Current chain reads used the separately configured product
Alchemy endpoint. Market/chart reads used GeckoTerminal's public API. The
temporary HTTP server was stopped after the probe; no background worker, wallet
request, signature, approval or financial transaction was started.

| Pool | Provider TVL USD | Provider volume 24h USD | Hourly candles | Total request time |
| --- | ---: | ---: | ---: | ---: |
| WETH/USDG, `84bd…ad0b6` | 459,121.3274 | 4,093,603.25685633 | 24 | 6.289 s |
| MARLIN/USDG, `db922…cc02e7` | 15,651.68 | 50,386.1528965015 | 24 | 6.502 s |
| WETH/USDG, cached repeat | Same stored observation | Same stored observation | 24 | 5.306 s |

These are observations from the run, not current quotes or independently
reconciled valuation. The cache repeat still rereads current chain state;
provider retrieval speed is not the latency of all RPC checks. No response
time or provider coverage SLA is implied.

The artifact records full public pool/currency identities, each chain snapshot,
provider retrieval times, source URLs, cache states and actual chart currency:
[HTTP probe](on-demand-market-http-probe-2026-09-09.json). The endpoint's
`priceToken=base` is the provider's explicitly returned base currency, which can
be USDG; it is not implicitly the first currency in a display pair name.

## Boundaries and review

The backend binds provider observations to chain 4663, full PoolId, both
currencies and the expected Uniswap v4 DEX identity. PoolId alone cannot prove
the manager because a fork can reuse the same key/hash. Missing or conflicting
DEX identity rejects market attribution. Charts additionally require the
requested base/quote role, matching actual currency and matching orientation
with the displayed market observation.

The independent review identified missing chain/chart orientation guards and
insufficient handling of another DEX's label. Both were corrected and covered
by seven independent regression tests, including stale-cache orientation
changes and provider-budget exhaustion. Cache/provider/service/review tests
also cover bounds, missing versus zero, error sanitization, failure retention,
concurrent read coalescing, canonicality changes and local HTTP restrictions.

The complete backend suite on this separate API branch passed **317 tests**
with `DOMINO_TEST_POSTGRES=1 DOMINO_TEST_EVM=1`, including its isolated PostgreSQL
and native EVM cases, with no skips. No web or contract source was changed.

The cache has 60-second freshness, at most 300-second stale fallback, a
15-second failure cooldown, 256 entries and 25 provider requests per minute.
These process-local development limits do not constitute a public distributed
rate limiter. Provider metric update times remain unknown. OHLCV can contain
an open hour or gaps and does not establish a complete rolling 24h LP-fee series.

## Uniswap readiness

The key was entered only at a hidden local prompt and saved outside Git with
mode 0600. The pool parser now accepts exact decimal strings seen in the live
response and retains bounds/missing values. A configured pool query completed
in 0.726 seconds; public unauthenticated access also worked, so that endpoint
alone is not proof of API-key authentication.

A separate configured Trading API quote completed in 3.135 seconds using
Robinhood router 2.1.1 and numeric chain IDs. See [Trading readiness](UNISWAP_TRADING_READINESS.md)
for the expired observation, request contract, gas/simulation limits and
network-specific corrections to the official skill's generic examples.

## Remaining

`feeApr24h` stays unavailable: this route does not invent LP fees from volume or
replace a time-weighted denominator with provider current TVL under the same
name. An admitted estimate or an indexed LP-fee method is a separate product
decision. Suggestions, the public authenticated browser bridge, quote adapter,
assisted-swap tariff, funding/mint flow and transaction execution remain work
for the alpha. The existing exact historical `/v1/read/pool-metrics` contract is
unchanged and its full replay tooling remains optional audit work.
