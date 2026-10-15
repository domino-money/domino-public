import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { closeBrowser } from '../support/close-browser.mjs';
import { launchBrowser } from '../support/s1-browser.mjs';
import { openJourney } from '../support/journey-browser.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';
import { contractsFor, createV2Chain } from '../support/v2-chain.mjs';
import { createChainReads } from '../support/chain-reads.mjs';

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await closeBrowser(browser); });
const tokens = Array.from({ length: 8 }, (_, index) => ({
  address: `0x${(0xcafe00 + index).toString(16).padStart(40, '0')}`,
  symbol: `CASHART${String(index).padStart(2, '0')}`, name: `Cash artwork ${index}`, decimals: 18, sources: ['uniswap_default_list'],
}));
const art = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#fb985b"/><path d="M8 8h8v8H8z" fill="#231b17"/></svg>';
const urlFor = token => `https://cdn.dexscreener.com/cms/images/token${token.address.slice(2)}`;
const prefix = 'https://api.dexscreener.com/token-pairs/v1/';
function dex(url) {
  if (url.startsWith('https://cdn.dexscreener.com/cms/images/token')) return { image: art };
  const chain = url.startsWith(`${prefix}base/`) ? 'base' : 'arbitrum';
  const token = tokens.find(token => url === `${prefix}${chain}/${token.address}`);
  if (!token) return [];
  return [{ chainId: chain, dexId: 'uniswap', pairAddress: `0x${'1234'.repeat(10)}`, baseToken: { address: token.address, symbol: token.symbol }, quoteToken: { address: '0x4200000000000000000000000000000000000006' }, liquidity: { usd: 100000 }, info: { imageUrl: urlFor(token) } }];
}

for (const hash of ['#/new', '#/markets']) test(`${hash}: token artwork is loaded only for visible search results and reused after reopening`, async () => {
  const chain = createV2Chain({ chainId: 8453, timestamp: Math.floor(Date.now() / 1000) });
  const reads = Object.fromEntries([8453, 42161].map(chainId => [chainId, createChainReads({ chainId, tokens, pools: [] })]));
  const s = await openJourney(browser, chain, {
    dist: WALLET_V2_DIST, hash, live: [8453, 42161], contracts: { 8453: contractsFor(8453), 42161: contractsFor(42161) }, connect: false,
    chainReads: { answer: (route, request) => reads[request.chainId]?.answer(route, request) }, dex,
  });
  try {
    const page = s.page;
    const search = page.locator('input[role="combobox"]');
    await search.fill('cashart');
    const hits = page.locator('[data-token-network-option]');
    await hits.nth(tokens.length * 2 - 1).waitFor({ state: 'attached' });
    await hits.first().locator('img[data-token-mark="provider"]').waitFor();
    await page.waitForTimeout(400);
    const metadata = () => s.dexAsked.filter(url => url.startsWith(`${prefix}base/`) || url.startsWith(`${prefix}arbitrum/`));
    const before = metadata();
    assert.ok(before.length > 0 && before.length < tokens.length * 2, `${before.length} lookups: offscreen tokens must not be requested yet`);
    const last = tokens.at(-1);
    assert.ok(!before.includes(`${prefix}arbitrum/${last.address}`));
    await page.locator('[role="listbox"]').evaluate(node => { node.scrollTop = node.scrollHeight; });
    const finalHit = page.locator(`[data-token-network-option="42161:${last.address}"]`);
    const image = finalHit.locator('img[data-token-mark="provider"]');
    await image.waitFor();
    await page.waitForFunction(node => node.complete && node.naturalWidth > 0, await image.elementHandle());
    assert.equal(await image.getAttribute('src'), `${urlFor(last)}?width=64&height=64&quality=85&format=auto`);
    const dir = resolve(import.meta.dirname, '../../.test-artifacts');
    mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: join(dir, `artwork-search-${hash.slice(2)}.png`) });
    await search.press('Escape');
    await page.waitForTimeout(300);
    await search.focus();
    await search.press('ArrowDown');
    await hits.first().locator('img[data-token-mark="provider"]').waitFor();
    await page.waitForTimeout(400);
    const asked = metadata();
    assert.equal(asked.length, new Set(asked).size, 'reopening never repeats an already answered artwork read');
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

// (2026-10-15, pack 7): a Base position's page showed two red 502s in the console, on GET /api/read/dex/token-pairs/base/
// <token>, the old path, for a token our edge had no read for. The page's token lookups ask the new path now, whose
// answer is a 200 that says the token is missing: no request leaves for /api/read/dex/, no error status, and the provider
// is not asked around it. The page's DEX resolver is built as production builds it (our edge first), behind our edge's
// real route code (tests/support/dex-edge-route.mjs) over a provider that refuses every read.
test('Base position page: token lookups ask /api/read/dex2/ only, and a missing token gives no error status', async () => {
  const { createDexEdgeRoute, createDexUpstream, edgeOnInTestBuild } = await import('../support/dex-edge-route.mjs');
  const { openPositionPage } = await import('../support/position-v2-page.mjs');
  const { activityOf, indexedToken, livePosition, portfolioOf } = await import('../support/s1-read6.mjs');
  const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const TEST = '0xb200000000000000000000000000000000000001';
  const ZERO = '0x0000000000000000000000000000000000000000';
  const manager = '0x03a520b32c04bf3beef7beb72e919cf822ed34f1';
  const pool = { dex: 3, currency0: USDC, currency1: TEST, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const now = Math.floor(Date.now() / 1000);
  const position = livePosition({ chainId: 8453, dex: 3, manager, tokenId: '6238157', owner: OWNER, pool, tickLower: -60, tickUpper: 60, liquidity: '1000000000',
    sqrtPriceX96: String(2n ** 96n), tick: 0, principal: ['2000000', '3000000'], feesOwed: ['250000', '500000'] });
  const portfolio = portfolioOf({ wallet: OWNER, tokens: [indexedToken(8453, USDC, 'USDC', 6), indexedToken(8453, TEST, 'TEST', 6)], positions: [position] });
  const chain = createV2Chain({ chainId: 8453, timestamp: now, positions: [{ dex: 3, tokenId: 6_238_157n, pool, tickLower: -60, tickUpper: 60, liquidity: 1_000_000_000n,
    principal: [2_000_000n, 3_000_000n], fees: [250_000n, 500_000n] }], pools: [{ pool, sqrtPriceX96: 2n ** 96n, tick: 0, liquidity: 1_000_000_000n }] });
  const upstream = createDexUpstream({ pairsOf: () => [], refuse: { status: 503 } });
  const edge = createDexEdgeRoute(upstream);
  let rewrites = null;
  const consoleErrors = [];
  const s = await openPositionPage(browser, chain, { hash: '#/positions/base-v3-6238157', read6: { portfolio, activity: activityOf({ wallet: OWNER }) }, routes: [edge.handle],
    prepare: async (context, origin) => {
      rewrites = await edgeOnInTestBuild(context, origin);
      context.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(`${message.text()} (${message.location()?.url ?? ''})`); });
    } });
  try {
    await s.page.locator('[data-position-detail][data-position-id="6238157"]').waitFor({ timeout: 30_000 });
    assert.equal(rewrites.count, 1, 'the page’s DEX resolver is built as production builds it (our edge first)');
    const deadline = Date.now() + 20_000;
    while (!edge.pairAsks().some((one) => one.tokens.includes(TEST)) && Date.now() < deadline) await s.page.waitForTimeout(100);
    await s.page.waitForTimeout(1500);
    await edge.settle();
    const lookups = edge.pairAsks();
    const report = JSON.stringify({ asked: edge.asked, direct: s.artwork, consoleErrors });
    assert.ok(lookups.some((one) => one.tokens.includes(TEST)), `the TEST token is looked up: ${report}`);
    assert.deepEqual(edge.asked.filter((one) => one.path === 'dex'), [], `no request leaves for /api/read/dex/: ${report}`);
    assert.ok(edge.asked.every((one) => one.status === 200), `every answer a 200, the missing token's too: ${report}`);
    assert.deepEqual(s.artwork.filter((url) => url.startsWith('https://api.dexscreener.com/')), [], `the provider is not asked around a missing token: ${report}`);
    // The signed-out session's own 401 is the page's, as on every page; none of the DEX lookups', and no 5xx at all.
    assert.deepEqual(consoleErrors.filter((text) => /\/api\/read\/dex|status of 5\d\d/.test(text)), [], `no red status line for a token lookup in the console: ${report}`);
  } finally { await s.close(); }
});
