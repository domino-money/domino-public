# VFAT MCP: discovery and historical-data assessment

9 September 2026, America/Sao_Paulo; provider response timestamps are 10 September, 00:21–00:22 UTC. Bounded public, read-only investigation. No wallet address, credential, signature or transaction was supplied; no MCP installation or application integration was made.

**VFAT is a useful candidate for pool discovery, external comparisons and read-only API integration. This probe confirms Robinhood and concrete Uniswap v4 data, but does not qualify a Domino price source or replace the accounting backend.** Curated requests and responses are in [the live evidence](vfat-mcp-probe-2026-09-09.json).

## Confirmed live coverage

- The public MCP endpoint initialized as `vfat-mcp-server` version `0.2.0` and listed 28 tools. `list_supported_chains` returned Robinhood, chain **4663**, with the canonical WETH address. Provider capability flags are not execution permission.
- A chain-filtered opportunity search returned two requested records, one v3 and one v4, and reported **1,836 chain opportunities**. That count is not a v4-only count or proof of exhaustive chain coverage.
- The v4 record was **SPY/USDG**, PoolId `0xfe2a80bb5618fd14984b92ca6d45bf5ba67443ddb1435e28b2e48df2fc1526cd`, fee 3,000 pips, tick spacing 60. Preserve chain plus full PoolId: its shared contract address alone is not v4 pool identity. This probe read provider data; it did not independently verify the complete PoolKey on-chain or qualify stock-token valuation.
- The exact-address token request included MARLIN, WETH and USDG, but returned only WETH and USDG. Two Robinhood searches for `MARLIN`, with and without a v4 protocol filter, returned zero matches. This demonstrates a gap in these responses; it does not prove that VFAT never supports that token, or that no MARLIN pool exists.

## Different metrics and time semantics

The [official APR documentation](https://docs.vfat.io/aprs/) describes seven days of swap fees against current pool funds. The live v4 `aprBasis` makes this more specific: `feeWindowDays: 7`, denominator `activePoolLiquidity`, and `assumesFullTimeInRange: true`. Domino's approved statistic instead uses trailing **24-hour** LP trading fees over **time-weighted total LP-attributed assets**. VFAT's APR must therefore remain an attributed external estimate; it cannot populate Domino's APR24h field without a separate compatible calculation.

`get_pool_history` documents the **last 30 closed UTC days**, and its MCP input fixes the bucket to `day`. The underlying [OpenAPI](https://api.vfat.io/openapi.json) lists `hour` and `day`, which does not establish that hourly history is actually prepared. The probe requested `limit: 2`; it received two daily points and `truncated: true`, while the summary described 30 available/expected points. We did not retrieve or independently validate all 30 days. Closed calendar-day buckets are not the current rolling 24-hour window.

The response explicitly reported `activityCompleteness: unverified`, `feeGrowthStatus.quality: partial`, and scheduled fee-growth preparation at **29/30 buckets**. Its warnings said the requested range was not fully covered and closed. The summary's 100% observation-coverage fields and point-level `valuationQuality: complete` do not override those independent limitations. Keep all quality dimensions visible.

TVL came from `metrics-farm-snapshots`; daily point labels and `snapshotObservedAt` were different timestamps. For example, the point labeled 9 September used a TVL snapshot at 23:00 UTC that day. A daily label cannot be treated as the instant that all its data became available. Snapshot TVL is not Domino's event-time capital integral. The response also distinguished total, active and in-range TVL; those denominators must not be interchanged.

## Price-source gaps

WETH and USDG each returned **18 timestamped observations** spanning 24 hours, with internal gaps of up to **four hours**. Their `oracleAddress` fields had no accompanying oracle-chain identifier, historical round/publication proof, or source-composition contract in this response. A token's `chainId: 4663` does not establish the chain on which its pricing oracle operates. Do not assume those oracle addresses are the Robinhood standard feed proxies.

An exact-address cross-check against [Chainlink's Ethereum mainnet catalogue](https://reference-data-directory.vercel.app/feeds-mainnet.json) found a concrete identity ambiguity: VFAT's USDG `oracleAddress`, `0x3e7d1eab13ad0104d2750b8863b489d65364e32d`, is listed there as **Ethereum USDT/USD**, with base asset `USDT` and 8 decimals. VFAT's WETH oracle address, `0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419`, is listed as **Ethereum ETH/USD**, with base asset `ETH` and 8 decimals. Because VFAT did not identify the oracle chain or derivation, this match **does not prove its internal algorithm prices USDG using USDT**. It does require clarification before treating that metadata as an approved USDG feed mapping.

The catalogue was fetched at `2026-09-10T00:48:55Z`; response SHA-256: `374effc436ebf06851c3a79aff4bbb5332b3a2744030bbb20d85a50d262fae95`. The evidence artifact retains only the two matched entries' proxy addresses, pairs, base assets, decimals and blockchain, together with this provenance.

The sampled observations use JSON numbers and hour-aligned timestamps. Their point-versus-bucket meaning, causal availability, precision, revision policy and independence from a pool being ranked are still unqualified. They cannot be carried forward under a new validity rule merely to eliminate coverage gaps. Missing MARLIN data stays unavailable; neither its symbol nor another pool's spot price supplies an approved replacement.

## Backend suitability and next use

The [official MCP page](https://vfat.io/mcp) advertises no-key access, unsigned quotes and help with API integration. The live API-discovery tools returned a documented `/v4/pool-history` operation and response schema. This supersedes the initial documentation-only uncertainty about whether an API/history contract exists.

One `list_supported_protocols` call returned the explicit upstream error `rate_limited`; the protocol listing was not successfully assessed. General service health was reported as OK, which does not prove every pool pipeline is complete. A future adapter should bound and cache reads, honor throttling, preserve prior observations on failure and separate provider availability from data qualification. This probe did not establish commercial redistribution terms, rate quotas, support commitments or an SLA; confirm those before relying on VFAT as a public-app dependency.

The official [Sickle v4 connector](https://github.com/vfat-io/sickle-public/blob/main/contracts/connectors/UniswapV4Connector.sol) is an additional implementation reference under the repository's [MIT license](https://github.com/vfat-io/sickle-public/blob/main/LICENSE). A source-code license does not establish hosted-data usage terms, and this assessment is not a contract audit.

The immediate fit is an optional discovery/comparison adapter that preserves source, exact asset identity, timestamps, truncation and quality. Before production historical valuation, independently reconcile a complete target interval, document the price/TVL/fee conventions and validate source identity and causal coverage. **No dependency, runtime adapter, production qualification, signing capability or change to Domino's APR methodology was enabled by this assessment.**
