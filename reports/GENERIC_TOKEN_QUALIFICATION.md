# Generic Robinhood token lookup — implementation and live evidence

9 September 2026. API 0.2.0 accepts currency addresses supplied by the caller. MARLIN is one regression case; no MARLIN, stablecoin or starter-token list restricts the backend runtime. This revision improves read coverage and failure handling, not transaction eligibility.

## Results

The [recorded HTTP matrix](generic-token-qualification-2026-09-09.json) passed all eleven cases: **nine ERC-20 candidates, native ETH, and one no-code control**. The API verified **42 distinct v4 pool identities** across these queries and read ten currency balances in a separate batch, preserving the expected no-code failure as an individual unavailable item. The balance batch used the public zero address; no user wallet or its holdings were queried.

| Case | Decimals read | Provider v4 candidates | Pool identities verified in this bounded run |
|---|---:|---:|---:|
| ETH native | 18 | 30 | 5 |
| USDG | 6 | 28 | 5 |
| WETH | 18 | 0 | 1, via explicit PoolId |
| MARLIN regression | 18 | 16 | 5 |
| TRADOOR | 18 | 10 | 5 |
| CRUMBS | 18 | 29 | 5 |
| RUBEN | 18 | 6 | 5 |
| MAD | 18 | 13 | 5 |
| BAG | 18 | 6 | 5 |
| ZZZ | 18 | 27 | 5 |
| No-code control | Unavailable | 0 | 0 |

The run intentionally probes at most five pools per case. Some pools appear for both currencies; the 42 count removes those duplicates. The artifact records omitted-candidate counts, pool keys, classification and block/hash for each read. There were 33 fixed-fee hookless identities and nine identities requiring a separate adapter; neither classification authorizes execution or certifies token safety.

Read snapshots span **17:34:30–17:37:59 UTC**. Each API request checks its own block at completion, rather than pretending the whole matrix shares one atomic snapshot. These are observations from that time, not a permanent pool count. MARLIN's returned candidate count also changed from earlier samples, illustrating why discovery counts require observation timestamps.

## A confirmed catalogue gap

The WETH query returned 30 other/rejected markets and no accepted v4 candidates. A candidate seen from the USDG side supplied PoolId `0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6`. The API recovered and verified its complete PoolKey and state on Robinhood, including WETH and USDG, despite its absence from the WETH candidate list.

This is direct evidence that an empty token-level provider result cannot prove a pool does not exist. The new explicit-ID path resolves this known case. It is an internal integration mechanism; the beginner UI should not ask users to hunt for PoolIds. A shared persistent catalogue from Initialize events is still required to supply broader, consistent coverage automatically. The PositionManager key cache itself also has incomplete coverage for pools it does not know.

## Changes made

- Added standalone `POST /v1/read/token`, independent of wallet inventory and the pool provider. Address identity and block freshness remain explicit when metadata is incomplete or no contract exists.
- Made decimals and symbols optional read metadata. Missing decimals preserve a successful `balanceOf` in exact raw units and explicitly disable decimal conversion. Zero decimals is valid; no default 18 is inserted. Standard string and legacy bytes32 symbols share one pinned call. Invalid/control/oversized symbol text cannot replace the contract address.
- Separated pool identity verification from token metadata availability. A missing symbol or decimals no longer removes a correctly verified pool. `tokenMetadataStatus` records the limitation, and execution remains unavailable.
- Added bounded `poolIds` to the pool request. Each complete identifier is verified, deduplicated and checked for the selected currency. Explicit IDs take priority within the request budget; IDs for a different token are rejected.
- Made pool-provider failures explicit without discarding independent token reads. Failed discovery has null counts and an unavailable state; a successful empty response has a received state and zero counts. Both retain incomplete coverage semantics.
- Versioned wallet and pool envelopes to schema 2 and regenerated the OpenAPI request contract. Contract metadata is labeled `erc20_candidate`, since readable methods alone cannot establish ERC-20 conformance or economic behavior.

Implementation: [reader](../backend/discovery.py), [service](../backend/read_service.py), [API](../backend/read_api.py), [new regression tests](../backend/tests/test_token_generality.py), [public test manifest](../backend/tests/fixtures/robinhood-token-matrix.json) and [HTTP matrix runner](../backend/qualify_token_matrix.py). The manifest is solely a test fixture and is not imported by the runtime or used to recommend assets.

## Verification and limits

**65 backend tests passed.** New cases cover arbitrary addresses sharing a symbol, non-stable/non-native pairs, native-versus-wrapped identity, decimals 0/6/8/18 and uint8 boundaries, missing precision with readable balances, string/bytes32 symbols, control characters, provider outage, empty results, explicit PoolIds, wrong-token IDs, absent contract code, request limits and reorgs. The live matrix then exercised the local Uvicorn HTTP service against the configured Alchemy RPC and public pool candidates. Temporary development servers were stopped afterward.

The live sample has decimals 6 and 18; other precision and malformed-metadata variants were tested with deterministic fixtures. The live explicit-ID case demonstrates a provider omission, while complete provider outages were tested with fixtures. No claim is made that every token, pool, hook or provider failure has been exercised on mainnet.

The API does not certify transfer behavior, rebase mechanics, tax tokens, access controls, stock-token restrictions, usable swap depth or hook safety. Those remain separate operation-specific qualification work before creation, swaps, Auto-compound or Domino can execute. Historical APR, TVL reconciliation, suggestions, wallet authentication, durable account data and frontend integration are still pending. No live personal-bot code, contract, financial permission or fee collection changed in this revision.

The next discovery dependency is persistent pool indexing with reorg recovery, cross-currency lookup and exact missing-pool checks for advanced initialization. A broader production qualification must measure coverage and quota/cost behavior rather than infer them from this sample.

## Primary references

- [ERC-20 specification](https://eips.ethereum.org/EIPS/eip-20) explicitly makes name, symbol and decimals optional; missing display metadata must not become invented precision.
- [Robinhood token contracts](https://docs.robinhood.com/chain/contracts/) supplies the canonical WETH and USDG addresses used as test cases.
- [DEX Screener API](https://docs.dexscreener.com/api/reference) supplies candidate discovery; its observed coverage limitations are preserved in the matrix rather than treated as authoritative absence.
