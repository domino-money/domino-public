# Domino — wallet assets, pool discovery and guided funding

9 September 2026. Product and implementation specification following the approved UI direction. These requirements extend the functional alpha. The first [read-only data qualification](reports/DISCOVERY_QUALIFICATION.md) is implemented; the complete guided journey and transaction features remain delivery work. The interface remains English and Robinhood Chain only.

**Approval recorded, 9 September 2026:** the user read the onboarding and fee documents and accepted their proposals. Wallet-first creation, advanced pool initialization, guided balancing and the pricing boundaries are approved for implementation. Data-provider qualification, numerical suggestion thresholds and the exact swap tariff calibration remain delivery work described by these documents; approval is not evidence of live readiness.

## Product decisions

Start with the assets the user already holds. Replace the earlier small token/stable catalogue as the entrance to the product with wallet discovery and contract-address search. Users choose their pair, LP trading fee, deposit budget and price range. Offer Auto-compound and Domino in the first functional alpha, with the strategy rules in [ALPHA_SCOPE.md](ALPHA_SCOPE.md).

Discovery is broader than execution eligibility. A token can appear with its balance and matching pools while a specific operation is unavailable. Explain the actual reason: unsupported transfer behavior, unreviewed hook, missing price evidence, unavailable route, or incomplete integration. A small handpicked token list must not be the only way to enter. Address verification, cached compatibility checks and simulations apply rules to candidates; they do not prove that an arbitrary token is safe.

Users can inspect compatible pools with low activity, but those pools cannot receive a suggestion badge. Choosing a pool and enabling its automation are separate capabilities. No activity, oracle, or transaction evidence may be invented to complete onboarding.

The user explicitly selected new-pool creation as an advanced alpha option when the desired pair/fee combination does not exist. The default path creates a position in an existing compatible pool; the advanced branch includes explicit price selection and bounded initialization plus first liquidity. Never initialize silently as a fallback.

## Guided creation journey

Each stage uses a focused card/dialog with a stable Back/Continue footer, preserved inputs and a compact summary. Paginate pool cards within the selection step. A normal procedure must not require scrolling down a long page; small screens and large text may use an accessible internal scroll area without hiding the action footer.

| Stage | What the user sees and chooses | Required behavior |
|---|---|---|
| Your token | Robinhood wallet assets, quantities, available balances and address search | Read native ETH separately; handle missing metadata and partial inventory; identify by chain/address, never symbol alone |
| Choose a pool | Pair, LP fee, TVL, 24h volume, fee APR based on 24h, data age and strategy availability | Compare existing pools for the selected token; filter by paired asset and LP fee; make the suggested choice explainable |
| Amount and range | Deposit budget, lower/upper prices and current price | User can edit the range; show effective tick-rounded bounds and a price scenario before accepting them |
| Balance your deposit | Token quantities needed, wallet contribution, optional swap and leftovers | Use existing paired assets only within the budget selected by the owner; otherwise offer to swap part of the selected token |
| Choose automation | Auto-compound or Domino, plain-language rules and editable limits | Domino trigger and overlap remain independent; show the next proposed range and fee-only funding |
| Review and create | Final composition, permitted spend, swap output floor, costs, range, NFT recipient and automation permissions | Display actual wallet steps and receipt-derived progress; resume safely after cancellation or reload |

The extra decisions need not become six large forms. Keep each card short, move secondary settings into a small advanced panel, and test the step count with LP beginners. Preserve the approved Tangerine language and single-column Activity feed. Receipt details remain available on demand.

## Explain the pair and calculate its composition

Suggested introductory copy:

> Your position helps people trade between two assets. Choose what to pair your token with. We will calculate how much of each asset your range needs.

Present actual available alternatives, such as token/USDG and token/ETH. USDG is a dollar-linked asset; ETH is another volatile asset. For ETH pairs, quote range prices in ETH per selected token and optionally show reliable USD conversions. Explain conversion toward the paired asset as the token rises relative to it; do not describe every pair as converting into dollars.

Native ETH and WETH have different currency identities. Support each through its validated integration and show any wrapping step and cost. Do not silently substitute one pool for the other.

There is no universal 50/50 deposit ratio. The current price and range determine required amounts; outside the range a position may require only one asset and be inactive. Calculate from exact pool state, token decimals and tick-rounded bounds, then display quantities and indicative value shares. Recalculate when the pool, amount, range or price changes. [Uniswap liquidity amount calculations](https://github.com/Uniswap/v4-periphery/blob/main/src/libraries/LiquidityAmounts.sol)

An illustrative card could say: “This range needs about $600 of TOKEN and $400 of USDG. Swap part of your selected TOKEN to complete the pair.” Those numbers are hypothetical, not a preset ratio or a live quote. The budget is $1,000 total before separately disclosed costs, not $1,000 of each asset. Explain that selling part of the token changes the user's exposure.

The funding planner compares direct funding and bounded balancing swaps. Solve the swap and mint together because a swap can change the pool price and thus its required mix. Favor productive liquidity within the chosen budget after costs; do not trade merely to eliminate negligible dust. If a route is missing or excessive in price impact, show the quantities the owner would need and allow adjusting the budget or pool. Do not assume the new, empty pool can supply its own balancing swap.

## Pool identity and choice of fee

Store a v4 pool using chain, verified PoolManager and PoolId, with the complete PoolKey. The pair, fee, tick spacing and hook identify that market. Selecting a different fixed LP fee means selecting another pool; creating a new position in the existing pool cannot change that pool's fee. A position independently chooses its range and liquidity. Dynamic-fee hooks need a separate reviewed integration. [Uniswap PoolKey](https://github.com/Uniswap/v4-core/blob/main/src/types/PoolKey.sol)

Keep **Pool trading fee**, paid by swaps through that pool, distinct from **Domino service fee**, approved at 2% of earned fees consumed by automation. Show both with their different bases in review. A higher LP fee does not guarantee higher earnings; trading volume can differ across fee choices.

Do not expose raw tick spacing or hook addresses as required beginner inputs. For existing pools, derive them from verified state. Advanced details show them and the PoolId. Validate requested fee values and tick spacing against the supported v4 configuration, rather than importing v3 fee-tier assumptions.

New-pool creation adds an advanced review of the owner-selected initial price, quote orientation, compatible fixed fee, tick spacing and hookless configuration. It must explain that a new pool has no trading history and may attract no trades. Require explicit review of the price and asset amounts; validate against the reviewed market-price policy. Use bounded initialization plus first mint in one transaction for this alpha branch, recheck whether the exact pool now exists, and handle competing initialization without accepting an unexpected price. This does not require the optional balancing swap to share that transaction. [Uniswap pool creation](https://developers.uniswap.org/docs/sdks/v4/guides/create-pool)

Domino successors continue to be positions in the same registered pool. They do not launch new fee tiers or move into a different pair automatically.

## Metrics users can compare

Each metric includes source, methodology version, as-of block/time and coverage. USD valuation requires a supported price source; a stablecoin symbol is not proof of a $1 price. Do not combine unrelated tokens or pools into one card's metrics.

| Display | Proposed definition |
|---|---|
| TVL | Current pool-attributed token balances valued in USD at the stated observation; distinguish from active liquidity/depth |
| Volume · 24h | Rolling trailing 24-hour swap volume in this exact pool, counting each trade once in USD |
| Fee APR · based on 24h | Annualized historical LP fee rate for this pool, with the calculation exposed in a tooltip |
| Updated | Observation age, coverage window and stale/incomplete state |

Proposed comparable fee APR methodology: `100 × 365 × LP fees earned in the trailing 24h / time-weighted average pool TVL over those 24h`. This is Domino's proposed pool-level statistic, not a claim that every provider uses it. Freeze the valuation convention before implementation; use timestamp-aligned prices for events and TVL samples. Reconstruct LP-attributable fees excluding protocol/hook deductions. Do not blindly multiply volume by a nominal fee when effective fees or deductions differ.

Pool APR is not the user's position APR, a forecast, compounded APY, or total return. It is gross of Domino's service fee and owner setup/exit costs, which are separately disclosed. Range-specific forward earnings require a separate, clearly labeled model; do not scale pool APR mechanically into a promise for a narrow position. Token appreciation and impermanent loss are outside this fee statistic.

Use rolling event/hour data with correct boundary handling; one calendar-day bucket is not a trailing 24-hour window. A pool with less than 24 hours of history displays its observed age and available activity, but no full-window APR or suggestion badge. Verified zero volume is zero; missing coverage is unavailable. Reorgs invalidate affected aggregates and rankings.

v4 uses a shared manager: a currency's total balance at PoolManager is not the TVL of each pool holding that currency. Likewise, the pool's active liquidity scalar is not USD TVL. Verify attribution, liquidity changes, swaps, donations and fee treatment against a pinned indexer model before publishing this metric.

## Suggestions: filter first, then compare

The first implementation should use a transparent rules engine, not an opaque AI selection or a “highest APR wins” button. Pool suggestions remain a research/qualification item until the following policy is calibrated on Robinhood data.

1. Require technical eligibility for the requested strategy and complete, fresh, sufficiently established market data.
2. Exclude zero or negligible volume, inadequate depth, unusable swap routes, unreliable valuation and material manipulation signals from suggestions. A large displayed APR cannot override these exclusions.
3. Evaluate absolute volume and its persistence across shorter windows; consider distinct trading activity, concentration and repeated patterns. Volume/TVL alone can reward thin or artificially traded pools. Addresses are not unique humans; these signals cannot certify absence of wash trading.
4. Among qualified pools, compare usable depth for this deposit/swap size, sustained volume, fee earnings and cost. Prefer an explainable shortlist; use APR as one input. Preserve manual selection among technically available choices.
5. Show reasons such as “More consistent trading activity” or “Lower estimated swap impact for your amount.” If nothing qualifies, say “No pool meets the suggestion criteria yet.” Paid boosts or token promotions must not affect ranking.

Set configurable minimum volume, observation age, activity persistence, concentration, depth/size, impact and freshness thresholds. Their numerical values and any ranking weights require a Robinhood sample study and versioned policy record; none are established by this document. Record each badge's inputs and exclusion reasons. Compare candidate rankings against thin, new and high-APR outliers before enabling the feature.

## Initial funding and ongoing fees are separate

Initial funding uses only the assets/amounts explicitly selected and approved by the owner. Swapping some selected TOKEN for USDG or ETH is allowed here. Leave an explicit amount of native ETH in the wallet for the actual setup sequence and subsequent owner actions; show it separately from LP fee balances. An ETH “Max” action must account for gas.

Show exact input caps, minimum output, price impact, slippage tolerance, quote expiry, expected leftovers and owner-paid gas. Connecting, authenticating or selecting a suggested pool grants no spending authority. Scope approvals to verified spenders and the required budget/expiry. No initial deposit or its balancing swap incurs the proposed 2% automation service fee.

The subsequent [pricing policy](PRICING_POLICY.md) adds a separate assisted-swap revenue line to this owner-funded flow, following the user's Revert fee-review request. Show its quoted rate, consumed-input basis, exact token fee and net amount reaching the DEX before approval. The proposed ceiling is 0.65%; the exact schedule remains to be selected. It is not a percentage of tokens deposited directly and cannot be added again to swaps performed inside the 2% automation service. A new-pool mint without a swap has no separate Domino setup percentage in this baseline.

For alpha, a guided owner-signed swap followed by mint is sufficient; an atomic swap-and-mint zap is not assumed. Recompute mint amounts after the swap receipt. If the next step is canceled, acquired assets remain under owner control and the flow can resume without repeating the trade. Track each actual transaction and replacement durably; no blind resend after a timeout. Unused tokens are returned to or remain with the owner and are not reclassified as earned fees. [Uniswap position minting](https://developers.uniswap.org/docs/sdks/v4/guides/managing-liquidity/position-minting)

Once enabled, Auto-compound and Domino consume only proven earned fees within their registered sequence. They cannot pull more wallet assets or sell existing LP principal. [Reinvestment policy](REINVESTMENT_POLICY.md) continues to govern that separate automation authority.

## Backend work and data-provider qualification

Retain the stack in [TECH_STACK.md](TECH_STACK.md). Add logical modules within it, not a new independently hosted service for every item:

- Wallet inventory: native balance, indexed token discovery, on-chain balance/decimal verification, address fallback, bounded metadata handling and account/chain invalidation. JSON-RPC alone does not enumerate every ERC-20 balance; inventory coverage must be tested and disclosed.
- Pool catalogue: discover Initialize events for the verified Robinhood v4 manager, map both currency sides, and reconcile full PoolKeys and operation capabilities. Cache shared reads across users.
- Metrics/indexing: reorg-aware swap/liquidity events, pool-attributed accounting, rolling aggregates and price-source provenance.
- Suggestion policy: versioned filters and ranking explanations independent of execution authorization and oracle checks.
- Funding quotes: exact budget/ratio/range calculations, bounded swap candidates, simulation and an expiring owner/pool-bound quote.
- Onboarding intents: recoverable wallet steps, receipt linkage and verified NFT ownership followed by optional automation activation.

Robinhood documents commercial RPC, archive access and indexed data services. Qualify actual wallet-inventory coverage, quotas and historical depth before selecting a plan. [Robinhood connectivity](https://docs.robinhood.com/chain/connecting/)

Uniswap documents v4 analytics queries, but those examples do not establish that a usable Robinhood deployment is available. Confirm chain, manager, schema, index head, reorg handling and history; otherwise run a controlled indexer/subgraph. [v4 query examples](https://developers.uniswap.org/docs/ecosystem/subgraphs/guides/v4-query-examples), [subgraph deployment guidance](https://developers.uniswap.org/docs/ecosystem/subgraphs/overview)

DEX Screener exposes token/pair discovery and volume/liquidity fields. It is an optional discovery cross-check, not a price oracle or an assumed source of reconciled LP fees. Subsequent [generic-token qualification](reports/GENERIC_TOKEN_QUALIFICATION.md) verifies sampled Robinhood candidates and demonstrates incomplete/asymmetric lookup coverage. Missing results cannot establish absence of a pool or justify initializing an assumed-missing market. Direct PoolId verification is an internal fallback; the beginner flow should obtain those identities from the catalogue rather than require the user to supply technical identifiers. [DEX Screener API](https://docs.dexscreener.com/api/reference)

The subsequent [persistent-catalogue slice](reports/CATALOGUE_QUALIFICATION.md) now supplies known identities automatically from either currency, with optional pair filtering and fresh chain-state verification. It contains 217 identities and a bounded Initialize-event history in a local PostgreSQL database. Its explicit partial-coverage flags remain essential: an empty catalogue search still cannot authorize new-pool initialization. Full history, rolling analytics, authenticated UI integration and transaction planning remain pending.

The [core-activity slice](reports/ACTIVITY_QUALIFICATION.md) persists per-pool swaps, liquidity changes, donations and protocol updates, with rolling raw-unit summaries and active-liquidity checks. API 0.5.0 adds [reconciled LP/protocol trading-fee allocation](reports/FEE_ACCOUNTING_QUALIFICATION.md) for hookless fixed-fee pools, independent of token symbols. These are pool-level allocations, not collectible NFT balances. USD volume, TVL and APR remain unqualified. [Metrics methodology](METRICS_METHODOLOGY.md) specifies the window, historical freshness and remaining position-accounting/valuation requirements. The two live samples are short histories; they do not qualify recommendation badges or a full trailing day of returns.

API 0.6.0 adds [qualified core-position principal and fee accounting](reports/POSITION_ACCOUNTING_QUALIFICATION.md), including a per-position read route. PoolManager caller/range/salt is an accounting identity; the onboarding flow still needs an admitted PositionManager NFT/owner resolver. These measurements do not yet provide a withdrawal quote, dollar TVL, complete-day APR or pool recommendation.

Public pool/activity/fee/core-position records now have applied local tables. Private wallet observations, capability decisions, ranking-policy evaluations, deposit quotes and onboarding intents remain candidate data additions. Cache shared market data separately from private owner budgets and drafts.

## Delivery and acceptance

1. Qualify Robinhood wallet discovery and pool/metric coverage, including missing/zero/stale states. Deliver recorded provenance and sample comparisons before presenting live figures.
2. Build wallet-first pool selection and explainable composition into the approved card journey, backed by the typed API. Keep practice and real holdings separate.
3. Implement and qualify exact owner-funded swap/mint and recovery, including the approved advanced initialization branch.
4. Integrate the resulting position with the generic vault and both functional-alpha strategies, including their independent execution review.

Acceptance includes a token outside any starter list; duplicate symbols/different contracts; missing inventory fallback; reversed token order and different decimals; USDG, native ETH and supported WETH paths; unavailable hooks/tokens; multiple fee pools; no meaningful volume despite extreme APR; new or stale data; range-dependent and one-sided funding; budget including gas; re-quote after swap; canceled/replaced transactions; donation-versus-deposit-versus-fee accounting; exactly-once mint reconciliation across restarts/reorgs; competing initialization; and a front-run price change preventing first mint outside the owner's bounds.

Re-estimate the alpha around discovery, metrics, funding, Domino and their qualification gates. Neither commercial data coverage, provider spending, new contracts nor live wallet actions are implied by this document.
