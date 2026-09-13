# Event-time price qualification

Evidence review: **13 September 2026 UTC**, for managed performance #97.

The current production price policy permits an observation age of **at most
300 seconds**. No source is presently qualified for the complete native
ETH/WETH, USDG and MARLIN currency set. The production registry in
[`price_history.py`](../backend/price_history.py) is empty; the managed valuation
adapter rejects reference-only objects. Raw collection, a successful price
request or a working public chart does not supply this qualification.

This document records technical evidence and the next implementation criteria.
It changes no policy, backend or runtime setting. The
[execution policy](EXECUTION_POLICY.md) applies; no named acknowledgement or
separate approval ceremony is needed to implement a supported qualification.

**Subsequent source discovery on 13 September:** the bounded
[source-solution investigation](../reports/HISTORICAL_PRICE_SOURCE_SOLUTION_2026-09-13.md)
successfully fetched five-minute histories for explicitly mapped canonical
Ethereum WETH and USDG addresses through Alchemy, and address-bound MARLIN
history through CoinGecko. This replaces an absolute source-unavailable
assumption with concrete reference adapters. It does not qualify historical
publication, target-pool independence or the strict event-time valuation below.

## Chainlink: real feeds, insufficient freshness for the production policy

The existing [archive adapter](../backend/chainlink_history.py) pins the
Robinhood standard ETH/USD and USDG/USD proxies, aggregator configuration,
decimals and asset mappings. Native ETH and canonical WETH have an explicit
ETH-reference mapping; USDG uses its own market price, never a fixed dollar peg.
Official identity sources include the [Robinhood contracts](https://docs.robinhood.com/chain/contracts/)
and [USDG issuer deployments](https://docs.paxos.com/guides/stablecoin/usdg/mainnet).

The [official feed directory](https://reference-data-directory.vercel.app/feeds-robinhood-mainnet.json)
was read during the 13 September investigation and still matched the adapter's
manifest digest. It identifies 8-decimal answers, an 86,400-second heartbeat
and a 0.5% deviation trigger for both feeds. These metadata fields establish
neither a 300-second update guarantee nor a maximum price error. Chainlink
documents the [historical round and timestamp model](https://docs.chain.link/data-feeds/historical-data).

| Reference | Standard proxy | Proven rounds in the 9 September sample | Largest answer interval |
| --- | --- | ---: | ---: |
| ETH/USD, mapped to WETH | `0x78f3556b67e17df817d51ef5a990cdaf09e8d3a9` | 17 | 30,769 s |
| USDG/USD | `0x61b7e5650328764b076a108eff5fa7282a1b9ad2` | 2 | 86,426 s |

These measurements come from the
[9 September archive proof](../reports/chainlink-alchemy-full-history-probe-2026-09-09.json),
at block **58,982,799**, over an 86,400-second requested interval. They are
historical evidence, **not a fresh onchain proof**. The 13 September public-RPC
attempt returned HTTP 403 before an onchain result; it established no current
round, decimals or coverage. Private credentials were not used in that research.

The existing [reference analytics policy](../reports/CHAINLINK_REFERENCE_POLICY.md)
allows answer age up to 86,520 seconds, measured from `answerUpdatedAt`, with
availability deferred to the proven publication block timestamp plus one second.
It preserves canonical publication/predecessor evidence and revalidation.
Its successful reference interval does not satisfy the ordinary 300-second
policy. Polling an unchanged round more often cannot refresh its age. Removing
`reference_only`, changing the label or raising `max_age` would not resolve this
evidence gap.

No MARLIN or POND feed was found among the 57 entries in the inspected Robinhood
directory. This is a bounded search result, not a universal absence claim.
The project's MARLIN address must never be replaced by an unrelated asset that
shares a name or by a price inferred from the measured pool.

## Alchemy: aggregation is documented; causal historical semantics are not

[`AlchemyHistorical`](../backend/price_history.py) requests 5-minute points.
Native ETH uses a symbol request; ERC20 requests bind `robinhood-mainnet` and
the exact address. The
[historical endpoint's expanded schema](https://www.alchemy.com/docs/data/prices-api/prices-api-endpoints/prices-api-endpoints/get-historical-token-prices)
provides string `value`, date-time `timestamp` and optional market data. It
allows 5-minute intervals over at most seven days. It does not define an OHLC
close, closed flag, first publication time or revision rule. The network field
is a string, not evidence that a particular token's Robinhood history exists.

The [Prices FAQ](https://www.alchemy.com/docs/reference/prices-api-faq) describes
volume-weighted exchange aggregation: symbol requests combine CEX and DEX
inputs; address requests use DEX inputs. This supports investigating Alchemy as
an external candidate. It does not identify the selected asset's contributing
venues or pools, so it does not establish independence from the target pool.

The [dated local probe](../reports/CAPITAL_PRICES_NFT_QUALIFICATION.md) obtained
native ETH points but reported unsupported Robinhood ERC20 histories on
9 September. That result must not be presented as today's provider capability.
The [Robinhood platform announcement](https://www.alchemy.com/blog/robinhood-chain-mainnet-is-live-on-alchemy)
also does not resolve exact token coverage or historical timestamp semantics.

A 5-minute interval is not proof of a candle close. Adding 300 seconds to the
returned timestamp would invent an availability rule; even a known close time
would not prove when its final value became available. The current adapter
therefore correctly stores these observations as unqualified.

## Public charts are a separate source and purpose

[`GeckoMarketData`](../backend/market_data.py), used by #128, fetches **hourly
OHLCV for the selected GeckoTerminal pool and exact currency address**. Its
`closed` flag is computed from candle start plus 3,600 seconds. The identity
correction prevents showing the other asset's chart. It does not turn the
pool's own chart into an independent price for valuing that pool, and it is
not an Alchemy historical-price adapter. See the
[recorded source-readiness findings](../reports/PRICE_SOURCE_READINESS.md).

## Qualification and continuous ingestion that preserve the current policy

For each selected pool and every currency used in capital, earned fees or
costs, the implementation needs all of the following:

1. **Exact identity and composition.** Bind chain 4663, canonical address,
   token and feed decimals, source identity and target pool. Establish actual
   selected-asset coverage and independent price composition. Wrapper mappings
   require evidence; stablecoin pegs and ticker substitutions are insufficient.
2. **Two distinct times.** Preserve the original price observation time for
   freshness and establish causal availability before an event uses the value.
   Publication or retrieval delay must not reset the original age. Reject
   future-price fill, backwards interpolation, ambiguous ordering and revisions
   that lack an explicit correction policy.
3. **A complete admitted interval.** Check every update, expiry boundary,
   interval endpoint and intervening segment against the 300-second ceiling.
   Keep genuine missing, stale, partial and unqualified states. A price known
   for one event does not prove continuous capital coverage or a full day.
4. **A typed, bounded ingestor.** Persist immutable source evidence and resumable
   progress separately from the UI collector. Bound actual provider spend,
   batch sizes, deadlines and retry/backoff; support catch-up without losing
   updates. Recheck identity/configuration, qualification validity and canonical
   evidence where applicable. Source correction, revocation, restart and restore
   must invalidate affected projections instead of silently reusing them.
5. **Capacity and accounting evidence.** The current price loader admits at most
   1,446 rows per source/currency window. Faster sources need explicit durable
   capacity and exact projection support; silently sampling away updates is not
   acceptable. Price coverage alone does not establish earned-fee origins,
   reconciled costs, ownership or complete capital intervals. Those remain
   requirements of [managed event-time valuation](MANAGED_EVENT_TIME_VALUATION.md).

A **prospective** ingestor can establish availability from the first response
it actually receives and persists, using it only for subsequent events while
retaining original price age. This avoids inventing an earlier publication time,
but cannot backfill earlier events or create an immediate 24-hour history.
It still needs identity, coverage and independent-composition evidence. Such a
path may reuse Alchemy if those facts qualify; a new subscription is not itself
a prerequisite or a qualification.

Higher-frequency candidates include Chainlink Data Streams, whose
[access requirements](https://docs.chain.link/data-streams/sign-up) and
[report timestamp semantics](https://docs.chain.link/data-streams/how-report-timestamps-work)
require a separate adapter and verified report identity. The research did not
establish usable stream credentials, full selected-feed IDs, decimals or a
complete causal interval. No provider can be promoted merely from metadata,
marketing coverage, an HTTP 200 or an observation's own qualification flag.
