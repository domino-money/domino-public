# Exchange-mapped reference prices — 16 September 2026

First increment of T3.5 (#162): the collector half of the recorded decision in
[HISTORICAL_PRICE_SOURCE_SOLUTION_2026-09-13.md](HISTORICAL_PRICE_SOURCE_SOLUTION_2026-09-13.md).
The strict production rule is untouched: `PRODUCTION_QUALIFICATIONS` stays empty
and no read may treat these observations as qualified USD.

## What was added

| Piece | What it does |
|---|---|
| `backend/migrations/021_reference_price_sources.sql` | Admits two new source names and constrains their provenance: the mapping must name the row's own currency, and the reference identity must match the provider (Alchemy ⇒ an Ethereum mainnet address, CoinGecko ⇒ a listed coin id) |
| `backend/reference_prices.py` | The explicit mapping table with its probe evidence; the Alchemy Prices adapter for a mapped Ethereum address; the CoinGecko chart conversion; storage that validates every row before it opens a writer transaction |
| `backend/collect_reference_prices.py` | Bounded CLI: fetch one mapped reference for a window, report observations/first/last/max gap, and store only with `--store` |
| `backend/tests/test_reference_prices.py` | 12 tests: mapping and provider refusal, echoed-identity refusal, sub-second and wrong-coin refusal, pre-connection row validation, and three PostgreSQL tests (store-and-read, the constraint refusing a mismatched mapping, the reader role unable to write) |

## The mappings, with the evidence that established them

| Robinhood currency | Reference | Recorded in |
|---|---|---|
| WETH `0x0bd7d308…ad73` | Ethereum `0xc02aaa39…6cc2` (eth-mainnet) | `reports/price-source-candidates-2026-09-13.json` canonical WETH probe |
| USDG `0x5fc5360d…d168` | Ethereum `0xe3431676…491d` (eth-mainnet) | same file, canonical USDG probe |
| MARLIN `0xab35d04e…4723` | CoinGecko `jt-marlin` | same file, MARLIN address mapping |

## The real collection

Alchemy, 24-hour window on the 5-minute grid, stored in the local database:

| Currency | Observations | Span | Max gap |
|---|---|---|---|
| WETH | 289 | 86,400 s | 300 s |
| USDG | 289 | 86,400 s | 300 s |

Both were written with their mapping provenance (`provider`, `reference`,
`robinhoodCurrency`, `mappingVersion`, `intervalSeconds`, `evidence`) and with
`pointTimestampSemanticsQualified: false` and `targetPoolIndependenceVerified:
false` — the row says what it is.

CoinGecko was attempted for MARLIN and the provider refused (`503`/rate limit on
its public endpoint) across three bounded retries. The adapter itself works —
the 13 September probe returned 289 points, and a direct call today returned 289
again once — so this is a provider condition, not a mapping problem. The retry
belongs to the operator loop that will run the collector.

## What the constraint refuses, verified

- provenance naming another currency for the row's currency → refused;
- an Alchemy source carrying a CoinGecko-style identity → refused;
- an unknown source name → refused;
- from the reader role, an insert into the observations table → refused.

## What T3.5 still needs

1. **Consumption.** The reference series is stored and labelled but nothing
   reads it yet for analytics: `metrics_service`/`valuation` need a reference
   path that reports `reference_analytics_only` (the label `valuation.py`
   already knows) with the mapping and cadence visible in the payload. This is
   the piece that unblocks #166, #163 and #173.
2. **Coverage.** Only three currencies are mapped. Every other listed token
   needs a recorded probe and a mapping before it gets a reference series.
3. **Freshness policy.** The strict rule stays at 300 s and the reference path
   must state its own age tolerance; the collection is a 5-minute provider
   grid, not a live feed, and the payload must keep saying so.
4. **The owner's display decision.** The recorded decision allows attributed
   retrospective analytics on this path, never a silent replacement of the
   qualified USD/APR fields.
