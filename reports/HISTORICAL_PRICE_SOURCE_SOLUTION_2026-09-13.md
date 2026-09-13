# Historical price sources: working alternatives and RPC decision

Research and bounded source probes on 13 September 2026 UTC, against Domino
`7e2384327baa808a744f9ed4840317d960998174`, with implementation integrated and
tested over `1359a3b2e0503c4c723adcbfaee2dc35c8350f1c`. This updates issue #4's previous
source-unavailable assessment. There are usable **market-reference histories**;
the remaining distinction is adapting/qualifying their meaning rather than
assuming that Robinhood RPC support includes an address-based Prices API.

## Decision

Start with the existing managed archive RPC for canonical token accounting,
Alchemy for explicitly mapped canonical ETH/WETH/USDG references, and a
CoinGecko contract-address-to-coin-ID adapter for listed assets such as MARLIN.
Retain Chainlink as a separately named oracle reference and market comparison.
Use indexed pool prices only as explicitly pool-derived references. An own
archive node is a capacity/availability option, not the missing USD feed.

Exact token fees, principal, service charges and transfers remain exact and
separate from the quality of their USD conversion. Reference USD history is
useful for analytics without claiming independently reconciled event-time
prices or granting financial execution authority. No stablecoin is assumed to
be one dollar; no arbitrary token is matched by its symbol.

The universal 300-second qualification ceiling in `backend/price_history.py`
is Domino's current methodology, not a network or Chainlink rule. Chainlink
publishes on deviation or heartbeat; its documentation instructs applications
to choose acceptable age limits and account for transmission delays. A
24-hour-heartbeat feed is not automatically broken after five minutes, nor
does that heartbeat establish an error bound or uninterrupted availability.
The existing reference policy already makes this distinction. This delivery
does **not** silently alter the strict production qualification registry.
[Chainlink freshness](https://docs.chain.link/data-feeds#check-the-timestamp-of-the-latest-answer),
[historical rounds](https://docs.chain.link/data-feeds/historical-data).

## Observed source availability

These are actual bounded HTTP probes, not inferred availability from vendor
logos. Sample cadence describes returned timestamps, not how frequently the
underlying market changed or when each historical value was first published.

| Query | Observed result | What it establishes |
| --- | --- | --- |
| Alchemy, canonical Ethereum WETH address | HTTP 200; exact network/address echoed; 290 observations, maximum gap 300s | Stronger identity than symbol search; usable external WETH market reference explicitly mapped to the canonical Robinhood wrapper. |
| Alchemy, canonical Ethereum USDG address | HTTP 200; exact network/address echoed; 290 observations, maximum gap 300s; observed USD range 0.9998430394–1.0000649928 | Stronger issuer-bound USDG reference; no assumed dollar parity or assertion of identical executable prices across chains. |
| Alchemy, WETH by Robinhood network/address | HTTP 400; sanitized category `unsupported_network` | The Prices API's network coverage differs from the working RPC. |
| Alchemy, explicit ETH market reference | HTTP 200; 290 observations over a day plus one five-minute boundary; maximum gap 300s | A usable external ETH reference exists. It must be bound to native ETH/canonical WETH explicitly, not any token named ETH. |
| Alchemy, explicit USDG market reference | HTTP 200; 290 observations, maximum gap 300s | USDG historical observations exist; they are not fixed parity. The symbol response alone does not prove a token contract identity. |
| CoinGecko, MARLIN identity and one-day chart | `jt-marlin` metadata binds Robinhood address `0xab35d04e1ee39c789c4a65d522417b3c7f2e4723`, 18 decimals; 289 price points, maximum gap 300s | Listed-token discovery and history can be address-bound. Current metadata lists Pons, Uniswap v4 and Ramses venues. |
| GeckoTerminal, independent USDG/WETH v3 pool | Both currency orientations return 300 candles, 290 in the day plus boundary; maximum gap 300s; empty intervals disabled | A pool-derived comparison is available, subject to exact pair/orientation and pool identity checks. |
| GeckoTerminal, MARLIN/Pons pool | 142 candles in the day; maximum gap 3,300s | This particular trade-history source does not supply continuous five-minute observations. |
| DefiLlama, historical chain/address query | WETH and USDG returned observations 20s before the requested time; MARLIN absent | A point-in-time comparison candidate; this single query proves neither whole-day coverage nor independence. |

The first Alchemy request interval was 2026-09-12 02:20:00 to
2026-09-13 02:25:00 UTC, with the full target day starting at 02:25. The
CoinGecko and pool queries were taken shortly afterward. Missing data remain
missing; `include_empty_intervals=true` would carry the prior close into empty
candles and must not be treated as new observations. `before_timestamp` and
base/quote metadata also require validation: the measured provider included
an equal boundary candle and changed metadata orientation for quote requests.
[CoinGecko chart API](https://docs.coingecko.com/demo/reference/coins-id-market-chart),
[address identity API](https://docs.coingecko.com/reference/coins-contract-address),
[pool candles](https://docs.coingecko.com/reference/pool-ohlcv-contract-address).

Fourteen research requests plus four adapter-validation provider requests and
five separately bounded public-RPC probes were made. The
[sanitized evidence inventory](price-source-candidates-2026-09-13.json)
records timestamps, identity, observed cadence, value ranges and SHA-256 hashes
of the three original captures and three CLI reports. It contains no provider credential URL.
The CoinGecko chart's observed range begins later than the fixed Alchemy target
day; it must not be reported as filling that missing leading boundary.

CoinGecko describes market prices as an aggregate of selected tickers with
outlier filtering and volume weighting. Multiple current venues do not prove
historical exclusion of the target pool or reveal the contributors to every
past point. Alchemy's public historical shape supplies value/timestamp but
does not establish first-publication or bucket-close semantics. Consequently,
neither data availability nor a regular five-minute grid alone qualifies the
strict causal fee-valuation contract.
[CoinGecko methodology](https://www.coingecko.com/en/methodology),
[Alchemy Prices FAQ](https://www.alchemy.com/docs/reference/prices-api-faq).

USDG's issuer documents its Ethereum and Robinhood contracts and cross-chain
deployment. Use that evidence for an explicit canonical reference mapping;
preserve target-chain decimals and never infer an arbitrary wrapped asset's
identity or market equivalence from a ticker.
[Paxos USDG deployments](https://docs.paxos.com/guides/stablecoin/usdg/mainnet).

The successful address requests use Ethereum WETH
`0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2` and USDG
`0xe343167631d89b6ffc58b88d6b7fb0228795491d`, explicitly mapped to Robinhood
WETH `0x0bd7d308f8e1639fab988df18a8011f41eacad73` and USDG
`0x5fc5360d0400a0fd4f2af552add042d716f1d168`. Price per whole token does not
permit copying a source-chain raw amount or token decimal count to another
chain. The returned USDG series varied around one dollar; its largest absolute
deviation in this probe was approximately 1.57 basis points.
[Canonical Ethereum WETH](https://ercs.ethereum.org/ERCS/erc-7528),
[Alchemy historical API](https://www.alchemy.com/docs/data/prices-api/prices-api-endpoints/prices-api-endpoints/get-historical-token-prices).

## How comparable applications do it

| Primary source | Confirmed method | Domino implication |
| --- | --- | --- |
| Uniswap v3-subgraph, Robinhood | Stablecoin configuration treats USDG as $1; WETH is priced through a selected WETH/USDG pool. Other tokens use permitted pools with sufficient liquidity, choosing the largest eligible liquidity. | Pool-derived USD analytics are common. Domino should preserve its stricter no-assumed-peg and no-zero-for-missing rules. |
| Beefy API, Robinhood | Combines external reference prices with concentrated-liquidity pool ticks; even USDG can be derived from paired WETH. | A deterministic reference graph can supply coverage without claiming independent USD observations at every pool. |
| Revert | USD PnL uses prices at deposits, withdrawals, fees and other cashflows; HOLD comparison revalues flows using current prices. Its backtester documents periodic pool snapshots and approximation. | Keep token accounting, historical valuation and return benchmarks separate. The cited documentation does not identify its production price provider or freshness SLA. |
| VFAT | Its documented fee APR is a seven-day estimate using current pool capital. | A competitor APR is not automatically the same rolling-day fee-income/time-weighted-capital metric. |

Source pins inspected:

- Uniswap `b4a0e8d34b8238482cadd3929ae88d3426a7067b`:
  [Robinhood config](https://github.com/Uniswap/v3-subgraph/blob/b4a0e8d34b8238482cadd3929ae88d3426a7067b/config/robinhood-mainnet/chain.ts),
  [pricing](https://github.com/Uniswap/v3-subgraph/blob/b4a0e8d34b8238482cadd3929ae88d3426a7067b/src/common/pricing.ts),
  [swap accounting](https://github.com/Uniswap/v3-subgraph/blob/b4a0e8d34b8238482cadd3929ae88d3426a7067b/src/v3/mappings/swap.ts).
- Beefy `d3b61fbf0beb4d963c86867b4591c3a9bf660fce`:
  [pool-derived prices](https://github.com/beefyfinance/beefy-api/blob/d3b61fbf0beb4d963c86867b4591c3a9bf660fce/src/utils/fetchConcentratedLiquidityTokenPrices.ts),
  [base price service](https://github.com/beefyfinance/beefy-api/blob/d3b61fbf0beb4d963c86867b4591c3a9bf660fce/src/api/stats/getAmmPrices.ts).
- Revert [position analytics](https://docs.revert.finance/revert/position-analytics/uniswap-v3-positions)
  and [backtester method](https://docs.revert.finance/revert/technical-docs/backtester).
- VFAT [APR documentation](https://docs.vfat.io/aprs/).

The Uniswap and Beefy Robinhood examples use a v3 pool. They demonstrate a
pricing methodology, not a drop-in v4 event/indexing implementation for Domino.

## RPC and indexer choice

Use the existing archive-capable provider and bounded incremental indexers,
retaining block hashes, replay generations and checkpoints. Read only the
managed subjects/window needed; do not make lifetime reconstruction an
onboarding prerequisite. A second provider can independently check selected
canonical headers, receipts and historical calls when configured.

Alchemy documents archive availability and Robinhood logs, with plan-specific
range limits. QuickNode explicitly offers Robinhood mainnet archive support.
RPC quotas and historical capabilities must be measured on the selected
endpoint; a provider's label is not a capacity test. Five tiny public-RPC
probes in this investigation returned HTTP 403, which proves current access
failure in this environment, not missing chain history.
[Alchemy archive/plans](https://www.alchemy.com/docs/reference/pricing-plans),
[Robinhood logs](https://www.alchemy.com/docs/chains/robinhood-chain/robinhood-chain-api-endpoints/eth-get-logs),
[QuickNode Robinhood](https://www.quicknode.com/chains/robinhood).

An own Robinhood node is operationally possible. Official requirements include
8+ CPU cores, 64 GB RAM (128 GB recommended), several TB of local NVMe and L1
execution **and** beacon access. Published snapshots are pruned; archive must
sync from genesis and needs historical blob access. The documented storage
envelope already exceeds the project's previously described 1-TB host.
Provision only after a measured quota, cost, retention or availability need
justifies that footprint; this investigation installed no node or paid plan.
[Robinhood node guide](https://docs.robinhood.com/chain/run-a-full-node/),
[Nitro archive configuration](https://docs.arbitrum.io/run-arbitrum-node/more-types/run-archive-node),
[historical beacon providers](https://docs.arbitrum.io/run-arbitrum-node/l1-ethereum-beacon-chain-rpc-providers).

## Integration boundary

Two bounded candidate adapters and CLI entry points are implemented:

- [Canonical market reference](../docs/MARKET_REFERENCE_HISTORY.md) requests
  exact Ethereum WETH/USDG addresses for the reviewed Robinhood mapping, or
  the fixed native ETH reference. Identity echoes are mandatory; there is no
  arbitrary ticker fallback. The live WETH and USDG CLI runs each returned
  290 observations over the original requested interval, including both
  boundaries, with no missing five-minute grid points.
- [CoinGecko contract-bound reference](../docs/COINGECKO_MARKET_REFERENCE.md)
  discovers the provider coin ID from the exact Robinhood address and verifies
  platform address and decimal metadata before requesting a one-day chart.
  The live MARLIN run returned 289 points, with a maximum internal gap of 300s;
  the leading 154.035s and trailing 105.965s without a point remain explicit.
  This is a generic listed-token adapter, not a MARLIN runtime allowlist.

CoinGecko's automatic granularity gives five-minute points for the current day;
older range queries have different resolution/plan requirements. Preserve
observations incrementally instead of assuming that this public endpoint can
backfill arbitrary past five-minute windows.
[CoinGecko historical granularity](https://docs.coingecko.com/demo/reference/coins-id-market-chart),
[range options](https://docs.coingecko.com/reference/coins-id-market-chart-range).

All **90 focused offline tests passed**, with zero failures or skips: both
candidate suites, exact valuation, price capacity and managed performance
valuation. They cover identity substitution, precise decimals, missing/null
points, conflicting duplicates, bounds, provider failures and credential-safe
reports. Review also caught and corrected a receipt timestamp taken before the
Alchemy response; regression tests now require the post-response time and
reject an invalid/regressing receipt clock. Independent review found no further
actionable issues. No unrelated UI/contract test pass is claimed.

The delivered read-only candidates make source reproduction concrete. They
must preserve provider observation time, receipt time, token identity, sample
coverage and unqualified temporal/composition flags. They do not write the
ledger, mutate a pricing registry or switch browser fields. The remaining
production work is to persist/version those references, decide the explicit
reference-valuation contract and verify it against the managed token ledger.

For strict independent event-time valuation, collect references prospectively
with known receipt/publication bounds or obtain source-specific historical
publication/composition evidence. A new node alone cannot supply either. For
retrospective market-reference analytics, use the declared sampled method and
show its attribution and incomplete/stale state without renaming it as the
existing qualified USD/APR field.
