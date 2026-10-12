# Position USD display

The position list and detail use `usdOfPoolAmounts` for principal and collectible amounts. This aligns them with the owner-approved New position rule in `components/create/valuation.ts` (6 October 2026).

1. Prefer the sum of each nonzero amount at its independently qualified read-v6 USD price.
2. If exactly one currency has a positive qualified USD price, value both raw amounts in that currency at this position's observed `sqrtPriceX96`, then convert to USD. The result is a **pool-price estimate**, identified in the figure's provenance and the detail page. It is not a sale quote or a qualified independent price for the other token.
3. Without a qualified reference, a current coherent position observation, or the required reference decimals, do not invent USD. A measured zero remains zero. Hooked pools cannot supply this fallback.

All calculations use integers with explicit decimals and truncation. Pool order, amounts and spot belong to the same position observation; a newer direct read must not reuse the old index valuation. Existing short-lived memory still stores only complete independently priced valuations and retains its original expiry.

The producer's `pool_depth_below_floor` reason remains meaningful: it rejects an independent token quote under its reference-liquidity rule, currently USD 10,000 released across a 10% adverse token-price band. Total pool TVL is not this depth. The frontend does not change that floor, token price, reason or API contract. A pool-price estimate is never substituted into execution, swap quotes, tariff calculations or personal APR.

This is an app-only change using the existing response. It needs no RPC, contract, Worker binding or private producer change. Durable fee accounting, price history and personal APR for Base/Arbitrum remain separate producer/API work.

Regression coverage includes both price orientations, 6/18 decimals, raw conversion without guessing the unpriced token's decimals, stale/unread state, no anchor, hooked pools, unchanged qualified sums, zero amounts, newer direct observations, Base/Arbitrum list/detail parity and narrow viewports.
