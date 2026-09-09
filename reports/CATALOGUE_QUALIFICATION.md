# Persistent pool catalogue — API 0.3.0

9 September 2026. Local read-only integration on Robinhood mainnet, chain 4663. No personal-bot configuration, financial permissions, fee policy, web deployment or wallet transactions changed.

## Measured result

The local PostgreSQL catalogue holds **217 distinct pool identities and 135 distinct currency addresses**. This is a catalogue count, not a certification of 135 token implementations or their automation compatibility.

| Evidence | Result |
|---|---|
| Previously observed PoolKeys, freshly revalidated | 42, at block 58,748,151 |
| Direct `Initialize` events | 175 across six committed chunks |
| Continuous indexed interval | 58,736,592–58,742,591 inclusive: 6,000 blocks |
| Indexer process restart/resume | Next chunk began at 58,741,592; then reported caught up to the requested target |
| PostgreSQL stop/start | Identical rows, fingerprint, revision and checkpoint after restart |
| Backend tests | 92 passed, including 15 against real PostgreSQL |
| Dependency validation | `pip check` passed; tested versions frozen in `requirements-api.lock` |

Raw evidence: [initial indexing](catalogue-index-2026-09-09.json), [resumed indexing](catalogue-resume-2026-09-09.json), and [database restart](catalogue-storage-2026-09-09.json). Seed observations and indexed events remain separate sources. The seed observation block is later than the indexed interval and does not extend its continuous coverage.

## Automatic lookup across both currencies

The [live HTTP check](catalogue-http-2026-09-09.json) found the previously known WETH/USDG pool from either selected currency **without sending a PoolId to the API**. WETH's provider response still contained zero accepted v4 candidates; the stored catalogue supplied the key, and a fresh StateView read verified the pool at the request's block.

The reverse USDG query returned six verified pair candidates: the one stored identity plus five provider candidates. Two other provider candidates failed PoolKey validation (`invalid_pool_key`) and were excluded. These results deliberately do not claim symmetric or complete discovery: provider-only candidates do not become database writes inside the reader API.

A second [live HTTP check](catalogue-event-http-2026-09-09.json) verified a pool learned from the new Initialize index, paired with a token outside the previous token matrix. Both query directions returned its freshly verified state with `catalogueSource: initialize_event`, again without explicit IDs. WETH's provider response again contributed zero accepted v4 candidates. This exercises the event-to-database-to-reader path on real chain data.

`POST /v1/read/catalogue` returns stored candidate identities, both currency mappings, provenance, coverage and a revision-bound keyset page. A stored result is labeled `catalogue_candidate`; it is not a fresh chain-state assertion. `POST /v1/read/pools` loads matching catalogue candidates and rechecks complete PoolKey hashes and current StateView state at a pinned block, then rechecks the block itself. Both routes accept an optional `pairedToken`; the two currencies must differ.

The reader can use a full known PoolKey from an event or verified observation without relying on PositionManager's truncated-key cache. Execution remains unavailable regardless of catalogue source. Provider metrics remain externally reported and unreconciled; APR and suggestions remain unavailable.

## Persistence and failure behavior

`migrations/001_catalogue.sql` is an applied, standalone migration for **public market identities only**. Its tables hold index state, committed chunks, Initialize events and separately observed hints. It does not apply the proposed private-account `schema.sql`.

Each indexing chunk and its next-block checkpoint commit in one PostgreSQL transaction. A database advisory lock admits one catalogue writer. Exact repeated logs are deduplicated; conflicting event identities and repeated initialization of the same pool abort the entire chunk. Network failures preserve the last committed checkpoint. A process can resume by omitting `--start-block`; its stored start cannot silently change.

Before advancing, the indexer compares the stored tail hash with the provider's canonical block. A confirmed change rolls back affected chunks and their events to the latest matching checkpoint among the most recent 64. It also removes hints observed after that point. If no checkpoint matches, it replays the configured interval from its start using a newly checked base hash. In-flight block changes abort the current chunk. A read failure alone never triggers a rewind.

Pagination binds the page cursor to the catalogue revision. If a writer changes the catalogue between pages, HTTP 409 asks the caller to restart pagination; the API does not silently combine different revisions. The lookup order is PoolId order, **not a recommendation ranking**. The fresh-pool endpoint loads at most 100 catalogue candidates and verifies at most 20 pools per request. Coverage/truncation flags remain explicit; browse the stored pages and verify selected IDs when more results exist.

The tests cover ABI and full-hash rejection, stale/uninitialized pools, provider/database fallback, pair filtering, page invalidation, duplicate handling, transaction rollback, writer serialization, short and full-window reorg recovery, restart/resume, reader write denial and a `pg_dump`/`pg_restore` roundtrip into a separate disposable database. Reorganization cases use deterministic test branches; no mainnet reorg was induced or claimed.

## Local operation and remaining scope

The tested database is PostgreSQL **18.6**, installed through Homebrew. The project cluster lives under the ignored backend runtime directory and listens only on a private Unix socket, with TCP disabled. The reader has SELECT grants and the writer has DML grants; both are separate from the local administrative role. Local socket authentication trusts this OS user and is **not production authentication or tenant isolation**. No Homebrew startup service was registered. Test databases use fixed names distinct from the populated catalogue.

The [backend runbook](../backend/README.md#persistent-public-catalogue--api-030) provides start, stop, test and bounded indexing commands. This qualification runs explicit batches, not a scheduled indexer. It does not provide full history, continuous catch-up, cloud hosting, managed backups or operational alerting.

The CLI limits one log query to 1,000 blocks, the response to 2 MB, and one decoded response to 2,000 events. A response exceeding those local bounds fails rather than advancing coverage; silent omission of events by the RPC cannot be detected by header checks alone. The configured Alchemy endpoint accepted these sampled historical ranges; this does not establish unlimited throughput, pricing or archive-depth guarantees. Targets are kept at least 200 blocks behind the observed head. That is a development margin in this prototype, not an assertion of Ethereum settlement finality. RPC completeness and canonicality still rely on the configured provider; independent-provider reconciliation is pending.

Next dependencies are wider historical/live coverage, reconciled rolling volume/LP-fee accounting and pool-attributed TVL, then calibrated pool suggestions. Wallet authentication, private durable accounts, connected UI, funding quotes, public vaults, owner-signed setup and Domino execution remain separate alpha work.

## Primary references

The event decoder follows the indexed/non-indexed fields in Uniswap's [PoolManager interface](https://raw.githubusercontent.com/Uniswap/v4-core/main/src/interfaces/IPoolManager.sol). Historical requests use Alchemy's documented [Robinhood `eth_getLogs` endpoint](https://www.alchemy.com/docs/chains/robinhood-chain/robinhood-chain-api-endpoints/eth-get-logs). The local cluster uses the initialization options documented by [PostgreSQL](https://www.postgresql.org/docs/current/app-initdb.html).
