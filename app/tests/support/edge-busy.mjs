/**
 * One of the site's own chain routes (src/lib/edge/chainRoutes.ts) refusing for a while, as the edge does when the node
 * or the visitor's limiter refuses (RPC-SPEC §2.5), for the browser suites of UNIT positions. Installed on a Playwright
 * context after tests/support/browser-chain.mjs routeChain (so it is asked first): while `until` (a time, this
 * machine's clock) is ahead, or for the next `times` requests, every request to `path` is answered `status` with `body`
 * and `Retry-After`; otherwise it falls back to the routes over the fake chain. `asked` keeps every request, with its time
 * and whether it was refused. With `status: 200` it is an answer of the test's own (a route's envelope), not a refusal.
 * Not a suite of its own.
 */
export async function refusingRoute(context, path, { status = 502, body = { error: 'chain_busy' }, retryAfter = 2 } = {}) {
  const state = { until: 0, times: 0, asked: [] };
  await context.route((url) => url.pathname === path, async (route) => {
    const refused = Date.now() < state.until || state.times > 0;
    if (state.times > 0) state.times -= 1;
    state.asked.push({ at: Date.now(), refused });
    if (!refused) return route.fallback();
    return route.fulfill({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(retryAfter) }, body: JSON.stringify(body) });
  });
  return state;
}

/**
 * read-v1 `nft-positions` answering `tokenId` live at the gateway's snapshot, for tests/support/read-stub.mjs `answer`:
 * the package's own recorded answer (api-contracts/read-v1/fixtures/gateway/nft-positions.success.json) with its first
 * item made this NFT (its owner, pool, range and figures as given). JSON text, as the stub takes it.
 */
export function liveNft(fixture, { tokenId, owner, poolId, poolKey, tickLower, tickUpper, liquidityRaw, principalRaw, unsettledFeesRaw }) {
  const body = JSON.parse(JSON.stringify(fixture));
  const item = { ...body.items[0], tokenId, owner, poolId, tickLower, tickUpper, liquidityRaw, principalRaw, unsettledFeesRaw, hasLiquidity: liquidityRaw !== '0' };
  item.poolKey = { currency0: poolKey.currency0, currency1: poolKey.currency1, feeMode: 'fixed', fee_pips: poolKey.fee, hooks: poolKey.hooks, tick_spacing: poolKey.tickSpacing };
  body.items = [item];
  return JSON.stringify(body);
}
