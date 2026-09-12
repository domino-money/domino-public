# Public chart currency qualification — 2026-09-12

Issue: [#92](https://github.com/domino-money/domino/issues/92). Source baseline:
`cc43d6c3aad91283100d4484963dcc9135d2bf4b`. This is a separate candidate from
public APR #95/#127 and private performance #97/#125.

## Result and boundary

The adapter now asks for the token address selected by the already verified
pool-market observation. WETH/USDG's public chart qualifies with either selected
currency in this bounded sample. MARLIN/USDG remains unavailable because the
provider returned conflicting candles at duplicate timestamps. No candle is
removed, merged, inverted, filled or relabelled as another token's price. Current
market liquidity/volume remain independently readable when a chart fails.

These are attributed public-provider observations, not qualified execution prices
or APR inputs. There was no VM, Worker, deployment, private RPC, wallet, bot,
configuration, historical collector or activation change. There were zero RPC
requests. Public provider calls alone cannot establish current canonical PoolKey
identity: that separate production service check is exercised offline with the
existing deterministic RPC fixture here, not requalified on a live chain.

## Official selector and observed orientation

The [public GeckoTerminal Swagger](https://api.geckoterminal.com/docs/v2/swagger.json)
and its [official UI](https://api.geckoterminal.com/docs/index.html) document a
`token` selector accepting base, quote, or a token address. They define the USD
currency, hourly aggregation and an optional empty-interval flag defaulting to
false. The [CoinGecko pool OHLCV reference](https://docs.coingecko.com/reference/pool-ohlcv-contract-address)
confirms the address selector, Unix-second timestamps, OHLCV cell order and that
intervals without swaps are skipped by default. The implementation keeps the
existing one-hour, maximum-24, USD request with no empty-interval filling.

Metadata orientation is an observed provider behavior, rather than an assertion
that symbols or pair membership prove the selected asset. On both public pools,
`meta.base.address` equalled the explicitly requested address, including when
that address was the pool endpoint's quote token. The quote shorthand and the
explicit quote-token address also agreed in these samples. An explicit address
in `meta.quote` with a different `meta.base` is rejected; the implementation does
not accept either orientation indiscriminately.

The service still verifies chain 4663, PoolId, canonical currencies, provider and
DEX association before admitting market data. It resolves `priceToken` to the
market's address. That address enters both the actual upstream URL and the cache
key alongside pool and requested role. The adapter requires distinct metadata
addresses and the selected address in OHLCV `meta.base`; the service then checks
the whole pair and the requested address again.

Only after this binding, quote selection maps the metadata labels back to the
pool observation's orientation. The existing wire semantics remain:

- `selectedToken` is the caller's pool-relative `base` or `quote` selection.
- `currency` is `market.data[priceToken + 'Token']`.
- `baseToken` and `quoteToken` follow the same market observation.
- Exact OHLC/volume, timestamps, open-candle flags and gaps retain their values.

A later pool-orientation change selects a different cache entry. Failed refresh
cannot recover a stale chart for the previous currency. A same-currency stale
observation retains its original age under the existing cache policy.

## Finite public evidence

[The sanitized diagnostic](alpha-chart-currency-diagnostic-2026-09-12.json)
records twelve serial market GETs on 2026-09-12, approximately 17:24:29–17:27:59
UTC: eight initial requests, one retry each for three MARLIN 429 responses after
more than two minutes, and one final historical query with
`before_timestamp=1789146000`. There were no further attempts. Documentation
retrieval is separate from this market-request count. No provider response body
or request headers were retained in the report; it includes public URLs,
addresses, status, counts, timing and response SHA-256 only.

WETH's three successful chart reads returned 24 candles, 23 closed, no internal
gaps and `complete24h: false`. MARLIN's two explicit-address reads and quote
shorthand each returned 24 rows but failed the complete parser on timestamp
uniqueness. A single historical USDG-address request reproduced the same guard.
The parser never promotes 24 returned rows into proof of a complete rolling day.

The initial examination checked only numeric OHLC range relations and therefore
did not detect this failure. Running the complete parser exposed duplicate
hour timestamps, not an OHLC inversion or missing number:

| Sample | Timestamp (Unix seconds) | Original zero-based row indices | Failure |
| --- | --- | --- | --- |
| Current USDG in MARLIN pool | 1789146000 | 21 and 22 | `duplicate_timestamp` |
| Historical query ending at the 11/09 boundary | 1789059600 | 20 and 21 | `duplicate_timestamp` |

[The small public fixture](../backend/tests/fixtures/public-marlin-duplicate-candles.json)
retains only each conflicting pair, exact decimal strings, original indices,
query and full-response digest. The pairs differ in prices despite sharing the
hour timestamp. Neither row can be silently preferred. This reproduces a
concrete cause of `invalid_market_candles` now, including a query for the earlier
window; the raw rejected 11/09 response was not retained, so it cannot prove
byte-for-byte identity or a provider-side cause for that original response.

`providerElapsedSeconds` measures each curl GET process, including public HTTP
and local process overhead. `offlineParserElapsedSeconds` measures parsing the
captured response locally. Neither is local reader HTTP latency or public
Domino HTTPS latency; those were **not measured** in this task. The prior
[11/09 report](ALPHA_MARKET_REQUALIFICATION_2026-09-11.md) remains a distinct
end-to-end observation at its own source revision and date.

## Compatibility and diagnostics

Read-v1 stays `1.1.0-rc.3`: schemas, types, runtime and OpenAPI are unchanged.
Successful chart `sourceUrl` fixtures now show `token=<address>`; the source
manifest, frontend digest pin and metrics-example source digest are regenerated
together. This is a new producer candidate for consumer acknowledgement, not
permission to enable a route. There are no new wire fields or error enums.

`MarketCandleError.diagnostic` provides only a finite rule, zero-based row index
and finite field name for local inspection. It contains no raw value, URL or
provider exception text. The cache keeps its established public
`provider_unavailable` response and never exposes this diagnostic. Number,
row-count, timestamp, duplicate, future, hour-alignment and OHLC-range guards
remain strict; missing data is not zero. A provider correction is still needed
before the sampled MARLIN histories can qualify.

## Local verification

The deterministic regression suite covers both pool orientations, literal exact
OHLC/volume preservation, address in the wrong metadata side, wrong counterpart,
malformed selectors, symbol ambiguity, cache identity after orientation changes,
stale fallback isolation, zero versus missing, sparse/empty windows, every
candle rejection category, real service propagation and both public conflicting
pairs. No tests invoke live providers or credentials.

The focused producer/contract checks passed 100 Python tests. The bridge check
passed 650 bridge and 490 consumer tests; all 542 app tests passed. Read-v1's 244 generated files,
OpenAPI, session/onboarding/deposit exports and metrics examples reproduced
their checked-in bytes. Independent implementation review found no remaining
blockers. Required remote CI and Decimal's exact producer/pin acknowledgement
remain release gates; this evidence does not qualify a deployed chart.
