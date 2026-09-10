# Immediate pool discovery: external indexed sources

Follow-up: the configured Uniswap pool read and one Trading API quote now
succeeded; see [Trading readiness](UNISWAP_TRADING_READINESS.md). API 0.8.0 adds
the on-demand GeckoTerminal path described in [qualification](ON_DEMAND_MARKET_QUALIFICATION.md).
The original observations and limitations below retain their research-time scope.

Research completed 2026-09-10 01:34 UTC. Scope: Robinhood mainnet, chain ID `4663`; public documentation and small public HTTP reads only. No credentials were obtained, configured provider URLs read, transactions sent, or provider subscriptions created. VFAT is assessed separately in `VFAT_MCP_ASSESSMENT.md`.

## Decision

**A new pool does not need Domino's lifetime ledger before it can appear in onboarding.** DEX Screener already supplies immediate candidates; GeckoTerminal is a verified complementary source for pool IDs, token candidates, reported liquidity, rolling 24h volume, and existing OHLCV. Small live requests completed in approximately 0.3–0.6 seconds in this session. Those measurements demonstrate an available path, not a latency or coverage guarantee.

Keep three independent statuses: pool identity/compatibility verified with bounded current on-chain reads; provider-reported discovery metrics; and Domino historical accounting verification in the background. The latter must not block showing a compatible pool or collecting the user's position preferences. Provider-reported metrics can be shown with clear attribution without being promoted into qualified historical LP accounting.

## Sources and concrete access

| Source | Concrete access | Useful immediately | Boundary |
| --- | --- | --- | --- |
| DEX Screener | Public `GET /token-pairs/v1/robinhood/{tokenAddress}` and `/latest/dex/pairs/robinhood/{poolId}` | Existing indexed candidates, `liquidity.usd`, `volume.h24` | No exact LP-fee ledger; metadata and liquidity can conflict with other sources. |
| GeckoTerminal | Public `GET /api/v2/networks/robinhood/tokens/{tokenAddress}/pools`, `/pools/{poolId}`, `/pools/{poolId}/ohlcv/hour` | Verified v4 full PoolId lookup, pool discovery, `reserve_in_usd`, `volume_usd.h24`, historical OHLCV | Token result is paginated; not a proof of all pools. No 24h LP-fee field in the tested pool response. |
| Uniswap LP API | Authenticated `POST https://liquidity.api.uniswap.org/lp/pool_info` | Documented chain `4663`, protocol `V4`, token-pair lookup and up to 20 full PoolId references | Current reserves/state; not rolling 24h volume or LP fees. Not live-tested because it requires a key. |
| Uniswap v4 subgraph | Official source supports `robinhood-mainnet`; hosted deployment must be identified | Schema/mappings support existing pool/hour/day history | No currently callable Robinhood Graph deployment was qualified in this bounded investigation. |
| Alchemy | Archive RPC and documented Data APIs | Current/historical on-chain verification and wallet/token data | No documented precomputed Robinhood pool TVL/volume/LP-fee endpoint established here. Alchemy Subgraphs were discontinued. |
| Robinhood Blockscout | Explorer / Blockscout APIs | Indexed contracts, transactions and logs | No documented ready-made v4 PoolId rolling analytics endpoint established here. |

Sources: [DEX Screener API reference](https://docs.dexscreener.com/api/reference), [GeckoTerminal API guide](https://apiguide.geckoterminal.com/), [Uniswap pool_info](https://developers.uniswap.org/docs/api-reference/pool_info), [Alchemy Data APIs](https://www.alchemy.com/docs/data), [Blockscout APIs](https://docs.blockscout.com/devs/apis).

## Live public reads

These are provider observations during this research session, not a common block snapshot or audited values. The pair/token calls below were not recorded with a provider metric-update timestamp. Differences must not be interpreted as simultaneous on-chain discrepancies.

**USDG/WETH pool:** `0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6`.

- [GeckoTerminal exact-pool request](https://api.geckoterminal.com/api/v2/networks/robinhood/pools/0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6) succeeded in 0.316 seconds. Name `USDG / WETH 0.02%`, DEX `uniswap-v4-robinhood`, liquidity `459471.6285` USD and 24h volume `4045772.52922924` USD.
- Returned token identities: USDG `0x5fc5360d0400a0fd4f2af552add042d716f1d168` and WETH `0x0bd7d308f8e1639fab988df18a8011f41eacad73`.
- [Existing hourly history request](https://api.geckoterminal.com/api/v2/networks/robinhood/pools/0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6/ohlcv/hour?aggregate=1&limit=2&currency=usd) succeeded in 0.466 seconds at `2026-09-10T01:33:42.980813Z`; server Date `Thu, 10 Sep 2026 01:33:42 GMT`. Returned two existing candles starting at Unix seconds `1789002000` and `1788998400`, with volume `91305.41471006711` and `106040.33225885186`. Raw response SHA-256: `b904f0fb2b13f0389b93eba111bdebdfd2a99812900db571230b1e0b1a4b1097`. A returned current-hour candle can be incomplete; this request does not prove a complete 24h window.

**MARLIN token:** `0xab35d04e1ee39c789c4a65d522417b3c7f2e4723`.

- [GeckoTerminal token pools, page 1](https://api.geckoterminal.com/api/v2/networks/robinhood/tokens/0xab35d04e1ee39c789c4a65d522417b3c7f2e4723/pools?page=1): 20 results in 0.573 seconds.
- [DEX Screener token pairs](https://api.dexscreener.com/token-pairs/v1/robinhood/0xab35d04e1ee39c789c4a65d522417b3c7f2e4723): 14 results in 0.504 seconds.
- For PoolId `0xdb922f0619e11b0c1e6c3a142798f0243060b8a4331ea4f4e7de80e898cc02e7`, GeckoTerminal reported liquidity `15666.0073` USD and volume `63115.3562800432` USD; DEX Screener reported liquidity `2088.02` USD and volume `62503.34` USD. **The liquidity disagreement is material.** Do not average it away or silently choose the larger denominator for an APR.
- PoolId `0x59a626b46f61a117f13a4f3d31264dc9afcafff4c95c3e79d094f07cc050a3f0` was classified `pons-v2-dex` by GeckoTerminal and Uniswap/v4 by DEX Screener. GeckoTerminal's display name called the quote WETH while its address was native ETH (`0x0000000000000000000000000000000000000000`). **Names and DEX labels are discovery hints; chain, addresses and full PoolKey must decide compatibility.**

These samples prove existing coverage for these pools/token only. Neither provider response establishes complete Robinhood pool coverage.

## Methods and what the numbers mean

**Uniswap LP API:** `pool_info` documents token-pair lookup or known references, with chain `4663` and V4 support. Returned `token0Reserves`/`token1Reserves` are best-effort core principal for v4: uncollected fees, donations, and assets held by hooks are excluded. With custom accounting hooks, these approximate swappable reserves. This is a useful explicitly defined current-state metric, not a substitute for Domino's historical LP-attributed capital. The endpoint documents no 24h volume/LP-fee fields. [Endpoint documentation](https://developers.uniswap.org/docs/api-reference/pool_info).

**GeckoTerminal:** use the pool's reported `reserve_in_usd` and `volume_usd.h24` directly as attributed provider metrics; do not claim that Domino reproduced their price selection or rolling-window accounting. Its token price comes from the first top-ranked pool, so it is not an independent oracle. OHLCV is price/volume chart history, not balances, liquidity history or collected fees. [FAQ and ranking](https://apiguide.geckoterminal.com/faq), [CoinGecko on-chain use cases](https://docs.coingecko.com/docs/common-use-cases), [OHLCV schema](https://docs.coingecko.com/reference/pool-ohlcv-contract-address).

**Official subgraph:** pinned source commit `0c13ab2fbd95306272528ed781511d7e2aa338d3` configures Robinhood PoolManager `0x8366a39cc670b4001a1121b8f6a443a643e40951` from block `9070`, and PositionManager `0x58daec3116aae6d93017baaea7749052e8a04fa7` from `9073`. Pool/hour/day entities contain volume, fees, and TVL. The swap mapping estimates `feesUSD = amountTotalUSDTracked × event fee / 1,000,000`; that expression does not subtract protocol fees. Hour/day TVL is assigned from the current pool TVL, not a time-weighted capital integral. Thus even obtaining an indexed deployment would not automatically qualify those fields as Domino net LP-fee APR. [Pinned networks](https://github.com/Uniswap/v4-subgraph/blob/0c13ab2fbd95306272528ed781511d7e2aa338d3/networks.json), [swap mapping](https://github.com/Uniswap/v4-subgraph/blob/0c13ab2fbd95306272528ed781511d7e2aa338d3/src/mappings/swap.ts), [interval mapping](https://github.com/Uniswap/v4-subgraph/blob/0c13ab2fbd95306272528ed781511d7e2aa338d3/src/utils/intervalUpdates.ts).

Uniswap cautions that its documented public subgraph examples are not official deployments and may be unmaintained. A candidate hosted Robinhood deployment must be checked for network/contracts, schema, indexed head, errors, pricing rules, and window completeness before use. A full current rolling day cannot be established by simply summing 24 calendar-hour buckets when the end lies inside an hour. [Subgraph overview](https://developers.uniswap.org/docs/ecosystem/subgraphs/overview).

**APR:** `365 × estimated 24h fees / current reported liquidity` is a possible explicitly labeled provider-based fee APR estimate, not realized return, position-specific APR, a projection, or Domino's capital-time methodology. The shortcut `24h volume × current fee tier` is especially insufficient for changing fees, protocol share or hook economics. No exact rolling net LP-fee series was established by the public sources tested here; keep that field unavailable or explicitly estimated until its separate method is admitted.

## Access, caching and service constraints

- DEX Screener documents 300 requests/minute for these pair/token endpoints. Its terms allow commercial use subject to restrictions including direct competition and unauthorized redistribution/resale; do not assume an unrestricted data redistribution license or an SLA. [API limits](https://docs.dexscreener.com/api/reference), [API terms](https://docs.dexscreener.com/api/api-terms-and-conditions).
- GeckoTerminal's free public API documents 30 calls/minute and is beta. Preserve attribution. The CoinGecko paid on-chain API has separate plans and authentication; paid cache/history limits must not be assumed for the free endpoint. [Public FAQ](https://apiguide.geckoterminal.com/faq), [API guide](https://apiguide.geckoterminal.com/).
- Uniswap LP requests require `x-api-key` on a server-side proxy. The integration guide gives a 15-second caching example and backoff handling; this is not an endpoint freshness guarantee. Confirm actual account/LP quotas and applicable API terms when configuring access. No key was requested or tested here. [Integration guide](https://developers.uniswap.org/docs/liquidity/liquidity-provisioning-api/integration-guide).
- Official v4-subgraph source is GPL-3.0; hosted query-service terms are separate. A Graph gateway generally requires its own key. No hosted Robinhood identifier or indexing completeness was verified. [Source license](https://github.com/Uniswap/v4-subgraph/blob/0c13ab2fbd95306272528ed781511d7e2aa338d3/LICENSE), [Graph access in Uniswap docs](https://developers.uniswap.org/docs/ecosystem/subgraphs/overview).
- Alchemy's subgraph query service was sunset on **December 8, 2025**. The repository's old `deploy:alchemy` path is therefore not evidence of an available service. Archive RPC remains useful for bounded verification and background audit. [Deprecation notice](https://www.alchemy.com/docs/alchemy-subgraphs/deprecation-notice), [Robinhood archive provider guidance](https://docs.robinhood.com/chain/connecting/).
- Blockscout now documents deprecated per-instance API support and a universal PRO API requiring a key. Its general APIs are not an established v4 analytics service. Specific PRO coverage and quotas for Robinhood were not verified here. [Blockscout API overview](https://docs.blockscout.com/devs/apis).

## Proposed integration boundary

Use existing DEX Screener discovery plus a bounded GeckoTerminal adapter, with server-side caching keyed by chain/address or full PoolId and provider. A suggested Domino policy is 30–60 seconds with request coalescing, jitter, provider rate limits and a short client deadline; this is our proposed policy, not a provider freshness claim. Store retrieval time, provider timestamp when present, methodology, request scope and coverage limits. Show cached age when stale; failure is not zero liquidity or zero volume.

Resolve pool identity and current state independently with bounded reads. Allow onboarding to proceed after the required compatibility and execution checks; enqueue history enrichment/audit separately. A provider disagreement should mark that metric uncertain and remove it from automatic recommendations that require reliable ranking, without making the entire pool disappear. Keep the audited price/capital pipeline available for deeper analytics and reconciliation without making it the universal cold-start discovery path.

Next access option to validate is the documented Uniswap LP API using a locally configured key. A hosted Robinhood subgraph may add already-indexed historical aggregates, but obtaining and qualifying that endpoint remains a separate task. No runtime source, qualification toggle, or execution behavior was changed by this research.
