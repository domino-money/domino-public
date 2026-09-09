# Capital history, price observations and NFT ownership

9 September 2026. Local API 0.7.0. Internal backend qualification; no public financial rollout or external audit.

## Delivered

- Persisted LP-attributed capital after every pool event, independently replayed against the reconciled position model and historical on-chain state.
- Exact raw time integrals and a conditional USD TVL, volume and pool trading-fee APR engine. The calculation uses time-weighted capital, prices at the relevant timestamps and one gross input leg per trade.
- Bounded Alchemy historical-price ingestion with explicit chain/currency identity, timestamps, provenance, idempotent persistence and conflict handling.
- Official PositionManager NFT-to-core mapping, actual owner reads and current principal/unsettled fees at a pinned block. Pool position records can resolve the owner at the ledger's historical snapshot; explicit NFT queries can use a fresh head.
- Saved the [home infrastructure study](../HOME_INFRASTRUCTURE_STUDY.md) for later use. No home hardware was accessed or provisioned.

**Live USD TVL and APR are not qualified.** The calculation engine is implemented and tested, but its production price-source registry has no qualified entries. The actual provider limitation below prevents those sample pools from receiving dollar metrics.

## Verification

**200 tests passed**, including **61 PostgreSQL tests** and **three native EVM methods**. The native reference retains 1,024 swap-step comparisons, 128 tick roundtrips, four Pool fee sequences and the 20-event original Pool/Position sequence.

New coverage includes:

- Every after-event balance compared with the existing original-v4 reference values.
- Hand-calculated daily APR and single-leg volume; capital/price changes between samples; same-second ordering; zero-duration endpoint changes; partial-day and zero-capital gates; exact raw amounts and extreme token decimals.
- Missing boundary prices, mid-interval stale gaps, wrong asset/network, future-price lookahead, source independence, conflicting observations and unqualified data that cannot self-promote.
- Full-day capital boundary integration on a synthetic chain, empty chunks, interrupted processing, writer serialization, reorg rollback/replay, missing source chunks/events, corrupt end balances, reader grants and actual dump/restore.
- NFT transfers observed by subsequent reads, historical owners, distinct salts, closed owned NFTs, cleared position metadata, RPC failure versus absent ownership, full PoolKey/range/core checks, ABI decoding, reorgs and strict HTTP inputs.

There are no new runtime dependencies. The backend environment passes its dependency consistency check. Financial contracts, the published UI and the live personal bot were not changed.

## Real Robinhood evidence

| Sample | Capital checkpoints | Recorded events | Observed history at snapshot | NFT result |
|---|---:|---:|---:|---|
| `0xc613…30ef` | 5 | 10 | 3,438 seconds | Core caller is not the admitted PositionManager; no NFT owner is inferred. |
| `0xb267…230a` | 2 | 6 | 1,008 seconds | One NFT/core mapping verified; direct NFT amounts and owner match the historical pool-position record. |

All seven capital checkpoints repeated on-chain reconciliation before persistence. Actual HTTP requests verified snapshot hashes, raw asset conservation and explicit historical freshness on both pools. Both snapshots were stale when queried and younger than 24 hours at their recorded endpoints; neither is presented as current daily analytics. A separate fresh read of the previously supplied NFT verified its owner directly at the same block. Artifact summaries omit owner addresses and NFT IDs.

The database contains **seven capital checkpoints, sixteen capital events and twelve external native-ETH price observations**. A backup of the actual public activity schema was restored into the isolated restore-test database and produced the same metric digest. A real local PostgreSQL restart also preserved counts and the complete stored metric digest. The private backup remains under the ignored backend runtime directory. Qualification API/worker processes are stopped after verification; the histories remain stored.

Evidence artifacts:

- [First pool capital and prices](capital-prices-live-2026-09-09.json)
- [Control pool capital and price failures](capital-prices-control-2026-09-09.json)
- [Actual HTTP metrics and NFT verification](capital-nft-http-2026-09-09.json)
- [Actual backup/restore and restart](capital-price-storage-2026-09-09.json)

## Price-source limitation

Alchemy returned twelve five-minute native-ETH observations. All three ERC-20 address queries across the sample pools returned HTTP 400. An additional bounded diagnostic of the first token's response confirmed that the response identifies `robinhood-mainnet` as unsupported. This finding concerns the **historical Prices API**, while the separately configured Robinhood RPC and token inventory remain working.

The [Alchemy endpoint documentation](https://www.alchemy.com/docs/data/prices-api/prices-api-endpoints/prices-api-endpoints/get-historical-token-prices) permits symbol or network/address lookup; actual chain coverage must still be tested. Its [price-source description](https://www.alchemy.com/docs/reference/prices-api-faq) distinguishes exchange aggregation from a validated independent oracle. We have not qualified target-pool independence or whether a five-minute timestamp represents a point observation versus a bucket statistic. Native-ETH points therefore remain observations, not an approved pricing feed. The backend does not alias WETH by ticker, assume a stablecoin peg or use the measured pool as its sole USD integrity check.

## Boundaries and next work

The valuation and capital methodology is specified in [METRICS_METHODOLOGY.md](../METRICS_METHODOLOGY.md). Price-source qualification and complete reconciled live daily windows are required before publishing dollar comparisons or APR. Select a source with demonstrated Robinhood address history, or implement an independently validated market/oracle indexing adapter, including historical currency decimals and timestamp semantics. Existing generic token and raw-amount reads continue to work when USD history is missing.

The NFT adapter follows Uniswap's [PositionManager](https://raw.githubusercontent.com/Uniswap/v4-periphery/main/src/PositionManager.sol) and [PositionInfoLibrary](https://raw.githubusercontent.com/Uniswap/v4-periphery/main/src/libraries/PositionInfoLibrary.sol). Owner reads are snapshot facts, not wallet authentication or proof of withdrawal authority. Past settled fees are not assigned to a new holder. Wallet-wide NFT inventory, durable watchlists, an ERC-721 transfer journal, authenticated sessions and settlement-path qualification remain separate work. Existing single-provider completeness assumptions and bounded reconciliation capacity also remain explicit.
