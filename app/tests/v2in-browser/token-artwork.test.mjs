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
