# Price-source readiness and diagnostics

9 September 2026. Initial triage for GitHub issue #4, not completed production price qualification. Two read-only subagents independently researched provider documentation and reviewed the existing implementation; the coordinating agent reviewed the findings and implemented the diagnostic correction below.

## Implemented correction

Previously, `load_price_series` labeled a currency `qualified` as soon as a qualification registry entry existed, including when it had zero observations. The valuation engine still rejected missing coverage, so this was a latent diagnostic inconsistency rather than publication of a fabricated APR. Today's production registry is empty, preventing this path from appearing for a live qualified source.

The corrected diagnostic distinguishes code-approved source quality from observed time coverage. It verifies both endpoints plus intervals between price changes and expiries, including fractional-time gaps. A qualified source with no observations now reports unavailable/missing; one with a gap reports unavailable/incomplete. Source-unqualified observations remain unqualified. The registry remains empty and valuation arithmetic is unchanged.

Regression tests cover no observations, missing initial history, an internal gap, endpoint expiry, a fractional stale gap despite fresh endpoints, exact expiry-boundary coverage, and observations without source approval. Response details are documented in [METRICS_METHODOLOGY.md](../METRICS_METHODOLOGY.md) before frontend adoption.

## Provider triage

| Candidate | Evidence from official documentation | Evidence still needed |
| --- | --- | --- |
| Chainlink | Robinhood describes crypto and Stock Token feeds. Chainlink exposes historical rounds and documents heartbeat/deviation updates, aggregator phases and answer timestamps. | Verified feed proxies and asset mapping for the currencies selected by the user, historical rounds, target-pool independence, and actual coverage under Domino's age bound. |
| CoinGecko / GeckoTerminal | Address-bound token OHLCV uses the most liquid pool; querying by token does not make the underlying price independent of that pool. | Robinhood/address coverage, causal bucket semantics, and independent composition for the particular pool being measured. |
| Pyth Benchmarks | Historical feed queries exist; the current documentation requires an API key. | Robinhood-address-to-feed mapping, actual supported tokens and historical freshness. No authenticated probe was made. |
| DefiLlama | The official SDK describes historical `chain:address` queries and search windows. | Exact Robinhood coverage, source composition, revision policy and whether a returned observation can follow the requested instant. |

Sources: [Robinhood feeds](https://docs.robinhood.com/chain/oracles-and-price-feeds/), [Chainlink historical rounds](https://docs.chain.link/data-feeds/historical-data), [Chainlink feed directory](https://docs.chain.link/data-feeds/price-feeds/addresses?network=robinhood&page=1), [CoinGecko token OHLCV](https://docs.coingecko.com/reference/token-ohlcv-token-address), [Pyth historical data](https://docs.pyth.network/price-feeds/core/use-historical-price-data), and [DefiLlama official SDK](https://github.com/DefiLlama/api-sdk).

These are documentation findings, not verified price observations for ETH, USDG, MARLIN or arbitrary Robinhood tokens. No account was created, credential read, paid service enabled or production feed registered during this triage.

## Next bounded qualification step

Start with a read-only Chainlink probe after resolving official feed addresses and asset identity. Pin the network, proxy, asset address/native identity, decimals, aggregator phase and round, and canonical block. Read a short bounded history, retaining answer timestamps, observation availability and retrieval provenance. Reject invalid/incomplete rounds, unsupported identities and causal gaps rather than filling them with future prices.

Measure actual update intervals against the current maximum age of 300 seconds. A longer heartbeat may leave legitimate gaps; do not silently increase the policy to obtain an APR. Establish availability and independence for each currency before expanding to a complete day. Stock Token feeds also need their token-specific adjustment and market-hours semantics; a stock ticker is not a token valuation rule.

A new provider requires a reviewed storage migration and explicit chain/source selection: the present table and writer accept only `alchemy_historical`. Before incremental price caching, define observation/qualification revisions separately from the pool-activity revision. Qualification evidence also needs bounded validity and adapter versioning where guarantees change over time.

Issue #4 remains open. Generic address acceptance does not imply that every token has an independent USD feed. USD TVL/APR stay unavailable wherever currency identity, source integrity, causal history or complete coverage is unqualified.

## First live probe — same issue, still unqualified

The follow-up [public evidence artifact](price-source-live-probe-2026-09-09.json) records direct documentation metadata and bounded public reads. It supersedes the initial triage's uncertainty about exact ETH/USD and USDG/USD proxies and GeckoTerminal address coverage. It does not qualify production valuation.

At Robinhood block **58,961,877**, hash `0xcee734b02b82019c3f00bc7ee49bdd1cee6a588bb223b82f222e74822ab312ec`, both standard and SVR proxies returned valid descriptions, 8 decimals, their documented aggregators and current round data. The block hash was rechecked after the snapshot and after historical reads. Chainlink's table identifies the main manifest proxy as Standard and the secondary proxy as SVR; they use the same aggregator/report and are not independent corroborating sources. [Official SVR description](https://docs.chain.link/data-feeds/svr-feeds).

| Feed | Standard proxy | Rounds sampled | Latest answer age at snapshot | Largest sampled update interval |
| --- | --- | ---: | ---: | ---: |
| ETH/USD | `0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9` | 17 | 3,342 seconds | 30,769 seconds |
| USDG/USD | `0x61b7e5650328764b076a108eff5fa7282a1b9ad2` | 2 | 30,832 seconds | 86,426 seconds |

Both samples reach at or before the trailing-day boundary. Reads stayed in the current aggregator phase and did not exceed 32 preceding-round calls per feed. This proves retrievable round history at the pinned block, not complete validation of each round's historical publication block or all prior phases.

The official manifest gives both feeds a **86,400-second heartbeat and 0.5% deviation threshold**. Actual ages and intervals exceed Domino's present 300-second validity cap. Extending that cap silently would be incorrect. Define and test an adapter-specific validity policy, tolerances and stale/unavailable behavior against the documented source before deciding whether these references are admissible. A nominal heartbeat is not a guarantee of exact update timing or a fixed error bound.

The official Robinhood contract list identifies the canonical USDG and WETH addresses already used by the backend fixtures. Chainlink metadata identifies Global Dollar and Ethereum as CEX reference prices. Associate these reviewed identities explicitly; do not map arbitrary symbols or assume a stablecoin peg. [Robinhood token contracts](https://docs.robinhood.com/chain/contracts/).

GeckoTerminal's complete three-page network listing includes `robinhood`, and public token-address requests returned USDG, WETH and MARLIN prices and their top-pool identities. These are available provider observations. This probe did not fetch OHLCV history, establish price composition or verify independence from a target pool; they remain unqualified.

The documentation review also found a chain-availability question: Robinhood recommends a Chainlink Sequencer Uptime check, while the current [Chainlink supported-network list](https://docs.chain.link/data-feeds/l2-sequencer-feeds) does not list Robinhood. Resolve the supported control or review an alternative before any execution use. Current snapshot hash/freshness checks are not a proven replacement for a historical downtime policy.

**Next implementation:** a bounded historical Chainlink adapter with explicit canonical asset/proxy mapping, source-specific validity rules, phase/publication-time provenance and tests; reviewed storage/source selection; then valuation against a reconciled complete pool day. Arbitrary tokens still need an independently assessed market-price path. No frontend work or PR #7/#8 merge is a prerequisite for further read-only investigation.
