# Current pool prices: direct RPC instead of CoinGecko

Owner correction, 13 September 2026: up-to-date prices must not depend on the
CoinGecko chart candidate. The earlier chart's latest timestamp was 106.240
seconds old when received. Its five-minute sample spacing never established
low publication latency. CoinGecko remains optional historical comparison;
reports now explicitly return `currentPriceAvailable: false` and the latest
sample's age at receipt.

## Direct RPC measurement

The existing product provider successfully returned current state for the
actual Robinhood WETH/USDG and MARLIN/USDG Uniswap v4 pools. No provider purchase
or own node was necessary. The bounded probe reused `ReadRpc` and
`DiscoveryReader`: chain 4663, manager code/link checks, complete PoolKey hash,
token code/decimals, block-pinned slot0 and block-hash rechecks.

| Measurement | Observed result |
| --- | --- |
| Initial verification, both pools and three tokens | 8.643 seconds |
| Subsequent head + two slot0 reads + block-hash recheck | 1.419 seconds |
| Age of the block when that refresh completed | 1.770 seconds |
| HTTP envelopes | 20; median 476 ms, range 422–1,015 ms |
| Total RPC items | 27, within the fixed limit of 30 |

The refresh used block **61,939,532**, hash
`0xc776d63464b91bde8671561b2af136f106f05b53f535823d5efcbfc18998235f`.
These are two bounded observations from this host, not a service SLA or a
production streaming benchmark. Token metadata and pool identity were reused
only from the initial verified snapshot nine seconds earlier; this does not
qualify an indefinite metadata cache.

Both pools had positive active liquidity at the initial snapshot and no hooks.
Decimals were read on-chain as WETH 18, USDG 6 and MARLIN 18. The pool ratio is
calculated exactly from `sqrtPriceX96² / 2^192 × 10^(decimals0-decimals1)`, with
inversion when needed for the selected display currency. The measured ratios
were approximately 2,479.652093 **USDG per WETH** and 0.000101973284 **USDG per
MARLIN**. Neither is a dollar price or an executable quote.

The ratio did not change between the two snapshots. A fresh block proves a
recent state observation; it does not prove a new trade occurred. Last-swap
time was not established by this state-only probe. Full identities, exact
rational values, timestamps and the original capture hash are in the
[sanitized RPC evidence](direct-rpc-pool-prices-2026-09-13.json).

## Selected update path

Read initial state using `StateView.getSlot0` at a specific block, then follow
`Swap` logs for the selected PoolManager and PoolIds over WebSocket. The v4
event includes the post-swap `sqrtPriceX96`, tick, liquidity and fee. Persist
block hash, transaction/log ordering, original event identity and local receipt
time; reconcile gaps with bounded log reads and handle removed/reorganized
events. A `newHeads` message alone must not invent a new trade or refresh the
age of an external dollar reference. Pending transactions are not executed
prices. A sequencer observation also remains distinct from Ethereum finality.
[Uniswap StateView](https://developers.uniswap.org/docs/protocols/v4/guides/state-view),
[v4 Swap definition](https://github.com/Uniswap/v4-core/blob/main/src/interfaces/IPoolManager.sol),
[Robinhood subscriptions](https://www.alchemy.com/docs/chains/robinhood-chain/robinhood-chain-api-endpoints/eth-subscribe),
[log removal semantics](https://www.alchemy.com/docs/reference/logs),
[Robinhood finality](https://docs.robinhood.com/chain/transaction-finality/).

The existing authenticated WebSocket endpoint also worked in a separate
15-second smoke test using Node's already installed native WebSocket client.
One connection and two `eth_subscribe` requests received **140 headers and two
WETH/USDG Swap logs**; no MARLIN swap was observed during this short window.
Connection setup took 578 ms and subscription acknowledgements 151–152 ms.
Header receipt minus block timestamp ranged from 208 to 1,193 ms. This is
timestamp age with one-second block timestamps and local-clock effects, not
measured network propagation time or an SLA. Header parent continuity and both
swap block hashes were checked against the captured headers. No independent
canonical/finality recheck or swap-value decoding was performed in this smoke
test. See the [sanitized streaming evidence](websocket-pool-price-probe-2026-09-13.json).
The connection was closed; no background collector remains running.

The current state path already exists in the product's discovery reader. This
delivery verifies its latency and corrects source selection; it does not claim
a persistent WebSocket ingestor or a new live-price UI has been deployed.

## Dollar conversion and execution

Keep the current pool ratio in its actual quote currency. Dollar conversion
requires a separate USDG/USD or ETH/USD observation with its own timestamp,
asset mapping and quality. Never assume USDG is exactly one dollar or refresh
an unchanged oracle answer merely because another block arrived. Pool-derived
USD remains pool-derived: it cannot silently become the independent historical
MARLIN source required by the existing strict APR contract.

The public Pyth catalog returned a GLOBAL DOLLAR/USD candidate with advertised
`fixed_rate@200ms` metadata. It supplied no Robinhood contract mapping; no price
updates or measured latency were obtained. MARLIN-name and exact-address
queries returned no candidate. Current Pyth documentation requires an API key
for Hermes updates, so public metadata access does not prove stream access.
Robinhood also documents Chainlink Data Streams support; network support does
not itself establish coverage of these exact tokens.
[Pyth USDG metadata](https://hermes.pyth.network/v2/price_feeds?query=USDG),
[current Pyth access](https://docs.pyth.network/price-feeds/core/upgrade/preparing),
[Robinhood Data Streams](https://docs.robinhood.com/chain/data-streams/),
[bounded source evidence](current-price-source-evidence-2026-09-13.json).

An amount-specific execution quote additionally needs current liquidity, fees,
price impact, hooks, a bounded route and simulation. Reading spot does not
authorize spending or predict a swap's net output.

## Validation and issue status

The CoinGecko candidate's 21 focused tests passed, including the added
regression that repeated retrieval preserves an old sample's age and never
marks it as a current price. The exact RPC ratio calculation and item counts
were independently checked against the saved values. No financial registry,
valuation policy, ledger, signer or execution capability was changed. Issue
#4 remains open for the separate historical USD qualification requirements.
