# CoinGecko market reference candidate

**Role: optional historical comparison only.** The owner rejected CoinGecko
for up-to-date values on 13 September 2026. This adapter must not provide live
token prices, execution quotes or an automatic fallback for the on-chain price.
Five-minute chart spacing is not a low-latency update guarantee.
Use the [direct pool-state path](../reports/LOW_LATENCY_POOL_PRICES_2026-09-13.md)
for current pool ratios, with dollar conversion tracked separately.

`backend/coingecko_market_reference.py` obtains an attributed one-day USD chart
for a Robinhood token. It discovers the CoinGecko coin ID through the fixed
public contract endpoint and requires both `platforms.robinhood` and
`detail_platforms.robinhood` to match the requested address. Expected token
decimals are explicit and must match provider metadata. Symbols and token names
do not select currencies; native ETH is outside this contract-address adapter.

```sh
backend/.venv/bin/python backend/qualify_coingecko_reference.py \
  --currency 0xab35d04e1ee39c789c4a65d522417b3c7f2e4723 --decimals 18 \
  --output reports/my-coingecko-reference.json
```

The CLI makes at most two public requests to `api.coingecko.com`, with five
seconds per request and a twelve-second invocation deadline. It does not load
credentials or accept a provider URL. Provider access failures remain unavailable;
the adapter does not obtain a key, retry or switch sources. The destination's
parent directory must exist, and exclusive creation protects existing files and
symlinks. Reports contain validated identity, decimal prices and diagnostics;
provider names, symbols, descriptions, URLs and error bodies are omitted.

The parser accepts at most 1,000 points within the requested trailing day and
retrieval time. Integer millisecond labels are retained without rounding.
Binary floating-point prices, nonpositive/nonfinite values, conflicting duplicate
timestamps, future points and points outside the request bounds are rejected.
Exact duplicate observations are deduplicated; decimal text remains exact.

`maxGapMs`, endpoint offsets and sample counts describe provider sample labels.
Even a 300,000 ms maximum gap does not establish a point's publication time,
causal event-time coverage or independence from the target pool. A cross-chain
CoinGecko ID also does not prove that the provider prices the Robinhood token's
own market independently. The mapping is provider evidence, not an onchain
identity proof. Missing or delayed market updates cannot be made current merely
by retrieving or resampling the chart.

Reports declare `intendedUse: historical_comparison` and
`currentPriceAvailable: false`, even when the last sample label is recent.
`latestPointAgeAtRetrievalMs` measures the last chart timestamp's age when the
response arrived. It is not a measurement of first-publication latency or the
underlying last trade. The original live capture's latest label was already
106,240 ms old at receipt; that one observation is not a provider-wide SLA.

Every result remains `provider_reference_only`, with unqualified timestamp
semantics, independence and event-time coverage, and `executionAvailable: false`.
No `PriceSeries`, database import, production registry entry, API integration or
source fallback is added. Exact LP fees and capital remain separate from this
candidate USD valuation reference.

Sources: [CoinGecko contract identity endpoint](https://docs.coingecko.com/reference/coins-contract-address)
and [coin market chart endpoint](https://docs.coingecko.com/reference/coins-id-market-chart).
