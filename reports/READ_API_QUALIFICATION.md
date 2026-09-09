# Local read API and Alchemy qualification

9 September 2026. This implements the next internal onboarding dependency after [pool discovery qualification](DISCOVERY_QUALIFICATION.md). It is a local development API for public address reads; account authentication, persistent user records, frontend integration and financial execution remain separate work.

This report records API 0.1.0. The subsequent [generic-token revision](GENERIC_TOKEN_QUALIFICATION.md) adds API 0.2.0 behavior, schema changes and broader live evidence; the snapshots below remain historical qualification records.

## Measured result

The user configured Alchemy through the local hidden-input terminal flow. Robinhood mainnet and the expected manager links were checked before saving. The provider URL is stored with owner-only file permissions and excluded from Git; it is absent from API responses and these reports. Configuration applies only to the new product backend.

The [live HTTP report](read-api-qualification-2026-09-09.json) records:

| Check | Result |
|---|---|
| Indexed ERC-20 candidates | 12 rows returned, no malformed rows, no next page reported |
| On-chain balances | 13 currencies read successfully: the candidates plus native ETH |
| Balance snapshot | Block 58,692,029 at 2026-09-09 16:32:43 UTC; hash recorded in JSON |
| Pool discovery through HTTP | 17 of 17 returned v4 candidates verified; no unverified candidates |
| Pool snapshot | Block 58,692,333 at 2026-09-09 16:33:14 UTC; hash recorded in JSON |
| APR, suggestions and transactions | Unavailable; no new fee collection |

The earlier Blockscout HTTP 403 no longer blocks this wallet's provider-backed discovery. This does not certify every Robinhood wallet or token, production quotas, spam classification, or provider catalogue completeness. A returned candidate may have a zero balance; raw amounts are reread on-chain and omitted from shareable evidence. An absent next page means the provider exhausted this result, not that chain-wide completeness was independently proven.

The [final transport check](read-api-qualification-2026-09-09-final.json) repeats the wallet HTTP path after the last transport/error-handling changes. Development API processes are stopped after qualification; no daemon or public endpoint is installed.

## Implemented boundaries

- Optional Alchemy inventory uses an explicit Robinhood endpoint and checks its chain before sending a wallet query. Provider pages supply candidate addresses only. ETH balances, ERC-20 metadata and quantities are read independently at a pinned block, which is rechecked before returning.
- Twenty candidate rows per page, up to ten explicit token addresses, bounded RPC counts, response sizes and socket timeouts. A request-level budget prevents starting additional upstream calls after its deadline; this is not a hard end-to-end streaming cancellation guarantee.
- Signed pagination cursors bind the wallet, fallback-address set, provider configuration and chain. They expire after five minutes and after a server restart. They are neither wallet authentication nor financial permission. Each page has its own fresh balance snapshot; clients must not combine pages into a supposedly atomic wallet snapshot.
- Failed inventory preserves native and explicitly requested asset reads. An individual reverting token is listed as unavailable; its balance is not fabricated as zero. Provider failure, page exhaustion, excluded rows and a reorg are distinct states. No server balance cache or database exists yet.
- The local launcher binds only to `127.0.0.1`, disables access logs and proxy-header trust, rejects browser origins and rebinding hosts, requires bounded JSON bodies, serializes expensive reads and limits their start rate. This is a local testing boundary, not production authentication or distributed rate limiting.
- Routes accept no RPC URL, tenant override, calldata or signing payload. Responses are not cacheable. The upstream HTTP transport refuses redirects, and known failures use fixed error codes without provider credentials.

The authenticated `/wallet/assets` account API is **not** implemented by these public-address routes. Future account endpoints must derive the owner from a verified session. The current endpoint intentionally allows a local developer to inspect a supplied public wallet address and reports `walletControlVerified: false`.

## Verification

**49 backend tests passed**, including real ASGI request handling with deterministic chain/provider fixtures. Coverage includes precise uint256 balances, zero versus unavailable, pagination/expiry/tampering, owner/provider binding, wrong chain, broken tokens, reorgs, strict request fields, oversized streamed bodies, concurrent requests, retry after failure, credential redaction and private configuration permissions. Live HTTP qualification then exercised the local Uvicorn server against Alchemy and the public candidate catalogue.

The real wallet fit in one provider page. Multi-page behavior and cursor failures were tested with fixtures; live multi-page coverage still needs a suitable sample. Dependencies were installed in the backend's separate virtual environment, frozen in [requirements-api.lock](../backend/requirements-api.lock), and passed `pip check`. The current Starlette TestClient emits a non-failing deprecation notice about its `httpx` compatibility path; that test-tooling migration is not claimed complete.

## Next integration work

1. Add migrations, wallet authentication and session-derived account context; persist watchlists without inventing vault addresses. Verify replay, account switching and tenant isolation before exposing private account routes.
2. Connect the approved wallet-first UI through a same-origin/authenticated API boundary; represent paginated, unavailable and stale states without clearing the user's previous valid view. Do not expose this loopback API directly to the published site.
3. Persist a reorg-aware pool catalogue and reconcile historical LP fees, rolling volume, pool-attributed TVL and valuation before enabling APR or suggestions.
4. Continue owner-funded creation and the approved Auto-compound/Domino contract paths under their existing release gates. This read-only milestone is not the functional alpha.

See the [backend runbook](../backend/README.md) for setup, routes and reproduction. The [OpenAPI request contract](../backend/openapi-read.json) describes validated request bodies; response DTOs still need a fully typed contract for the frontend integration.

## Provider references

- [Robinhood connectivity](https://docs.robinhood.com/chain/connecting/) documents the mainnet Alchemy endpoint and indexed-data service context. Support was then tested with the configured account rather than inferred solely from documentation.
- [Alchemy token balances](https://www.alchemy.com/docs/data/token-api/token-api-endpoints/alchemy-get-token-balances) documents ERC-20 candidate retrieval and pagination. Indexed balances are not used as the app's authoritative balance snapshot.
