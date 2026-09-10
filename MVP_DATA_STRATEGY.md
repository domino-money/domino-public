# MVP data strategy

The alpha uses existing APIs and indexed sources to show a token's pools and
available market history on demand. Opening, importing or creating a position
must not wait for a replay of that pool's lifetime events. The full historical
reconstruction is parked as optional accounting/audit tooling; its saved
checkpoints remain intact and the 55-day reference case is not complete.

## Small integration path

1. Discover existing pairs from an indexed provider and verify the exact chain,
   currencies and v4 PoolKey. Retain provider identity and retrieval time.
2. Read available prices, volume and TVL from provider APIs through the backend
   and a bounded cache. State the provider's method and period. A 7-day estimate
   or current-TVL denominator is not our reconstructed 24h fee APR.
3. Use the Uniswap Liquidity API for pool information and evaluate its position
   construction endpoints for onboarding. Use the Trading API for swap quotes
   and routing. Credentials stay server-side; wallet signatures remain separate.
4. Before any future financial action, check fresh balances, NFT ownership,
   deployment, range, approvals, swap limits and transaction simulation. External
   catalogue metrics alone cannot authorize execution.

For an uncached token, make bounded provider reads and display available results
without starting a lifetime backfill. Provider failure produces an explicit
unavailable metric. An entirely new pool has no own historical volume or APR;
other pools are references, not invented history for the new pool.

Domino's own accounting remains responsible for managed positions, settings,
execution intents, fee provenance and the approved service-fee policy. Provider
analytics and exact internal accounting have separate fields and provenance.

## Current implementation and next gate

`backend/uniswap_liquidity.py` implements one read-only Robinhood v4
`/lp/pool_info` request by pair, fee, tick spacing and optional hook. It preserves
raw integer amounts, optional reserves and missing timestamps. A hashed PoolKey
checks the association of response fields; it does not independently prove
provider state at a block. This endpoint alone supplies no rolling 24h fee or
volume history and no USD conversion.

The hidden-prompt configurator checks one public pool and stores the API key in
ignored local configuration only after that read succeeds. Offline tests cover
the request contract, identity checks, optional fields, error sanitization and
credential handling. The configured key completed both the pool query and one
Robinhood Trading API quote; see [Trading readiness](reports/UNISWAP_TRADING_READINESS.md).
The quote uses router 2.1.1 and numeric chain IDs, correcting generic skill
examples for this network.

API 0.8.0 adds `/v1/read/pool-market`: a current on-chain pool identity plus
attributed GeckoTerminal TVL/24h volume and optional hourly prices. Its bounded
in-memory cache coalesces requests and marks retained observations stale after
60 seconds. No catalogue or lifetime history is required. This local read route
does not enable a public browser bridge, an APR calculation or swap execution.

The official `swap-integration` skill v1.5.0 was installed locally for Codex from
`uniswap/uniswap-ai`. Its Trading API workflow will guide the swap integration;
examples still need chain-specific and transaction-policy validation. A
contributor can install it with:

```sh
npx skills add uniswap/uniswap-ai --skill swap-integration --agent codex --global
```

See [source research](reports/ON_DEMAND_SOURCES_RESEARCH.md) for measured public
provider coverage, response times and conflicts, and the official
[pool_info documentation](https://developers.uniswap.org/docs/api-reference/pool_info).
