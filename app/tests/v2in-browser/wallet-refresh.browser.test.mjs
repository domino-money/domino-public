import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { createReadStub } from '../support/read-stub.mjs';
import { createDirectChain } from '../support/v2-direct-chain.mjs';
import { activityOf, indexedToken, livePosition, portfolioOf } from '../support/s1-read6.mjs';
import { launchBrowser } from '../support/s1-browser.mjs';
import { openPositionPage } from '../support/position-v2-page.mjs';
import { closeBrowser } from '../support/close-browser.mjs';

const require = createRequire(import.meta.url);
const position = require('../../.test-build/app/src/finance/position.js');
const ZERO = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const UFG = '0xefab538cf3c29237a47c6afb145d50ddf204a0a3';
const pool = { dex: 4, currency0: ZERO, currency1: USDG, fee: 500, tickSpacing: 10, hooks: ZERO };
const range = { tickLower: -201060, tickUpper: -197040 };
const tick = -199020, sqrtPriceX96 = position.sqrtPriceAtTick(tick), liquidity = 10n ** 15n;
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../api-contracts/read-v1/fixtures/gateway/wallet-assets.last-page.json'), 'utf8'));
let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await closeBrowser(browser); });

function walletAnswer(now, ufg = null) {
  const body = structuredClone(fixture);
  body.snapshot.timestamp = now;
  body.inventory.retrievedAt = now;
  body.items[1] = { ...body.items[1], address: USDG, symbol: 'USDG', decimals: 6, amountRaw: '1000000' };
  if (ufg !== null) body.items.push({ ...body.items[1], address: UFG, symbol: 'UFG', decimals: 18, amountRaw: String(BigInt(ufg) * 10n ** 18n) });
  return JSON.stringify(body);
}

test('Wallet rechecks an omitted remembered UFG without discovery, retains it while unknown, and removes an exact zero', { timeout: 60_000 }, async () => {
  const now = Math.floor(Date.now() / 1000);
  const chain = createDirectChain({ chainId: 4663, timestamp: now, v4: [] });
  const read6 = { portfolio: portfolioOf({ wallet: chain.owner }), activity: activityOf({ wallet: chain.owner }) };
  let available = false, spent = false, checks = 0;
  const read = createReadStub({ reads: 'wallet-assets', answer: (route, body) => {
    if (route !== 'wallet-assets') return undefined;
    if (body.autoDiscover === false && body.tokens?.includes(UFG)) {
      checks++;
      if (!available) return new Response(JSON.stringify({ error: 'upstream_unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': '1.1.0-rc.3' } });
      return walletAnswer(now, spent ? 0 : 1000000);
    }
    return walletAnswer(now);
  } });
  const s = await openPositionPage(browser, chain, { hash: '#/positions', read6, routes: [read.handle], s1: { directCode: { 4663: chain.codeHashes } } });
  try {
    const { page } = s;
    await page.locator('[data-wallet-total]').waitFor();
    await page.evaluate(({ wallet, now, UFG, USDG }) => {
      localStorage.setItem('domino-wallet-v2:4663', JSON.stringify({ v: 1, wallets: { [wallet.toLowerCase()]: { at: now * 1000, whole: true,
        rows: [[UFG, 'UFG', 18, '1000000000000000000000000', 700], [USDG, 'USDG', 6, '1000000', 700]], quotes: [[UFG, '0.003', 100000, now * 1000]] } } }));
    }, { wallet: chain.owner, now, UFG, USDG });
    await page.reload();
    const card = page.locator('[data-portfolio-tokens]'), ufg = card.locator(`[data-wallet-row="${UFG}"]`);
    await card.locator('[data-wallet-value-unavailable]').waitFor();
    await page.waitForFunction(() => document.querySelector('[data-portfolio-tokens]')?.getAttribute('data-wallet-source') === 'read');
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): the earlier balance is a hidden marker; a screen reader heard "Balance from the previous reading; refreshing.".
    assert.equal(await ufg.locator('[data-wallet-balance-earlier]').count(), 1);
    assert.doesNotMatch(await ufg.innerText(), /previous reading|refreshing|updating/i);
    assert.equal(await ufg.locator('[data-usd]').count(), 0);
    assert.ok(checks > 0, 'the existing exact-address API was used for the omitted holding');
    assert.equal(await card.locator('[data-wallet-total]').count(), 0, 'the remaining USDG is not misrepresented as the whole wallet');
    available = true; spent = true;
    const before = checks;
    await page.reload();
    await page.waitForFunction((token) => {
      const card = document.querySelector('[data-portfolio-tokens]');
      return card?.getAttribute('data-wallet-source') === 'read' && !card.querySelector(`[data-wallet-row="${token}"]`) && card.querySelector('[data-wallet-total]');
    }, UFG);
    assert.ok(checks > before);
    assert.match(await card.locator('[data-wallet-total]').innerText(), /\$1\.00$/);
    const remembered = await page.evaluate(wallet => JSON.parse(localStorage.getItem('domino-wallet-v2:4663')).wallets[wallet.toLowerCase()].rows, chain.owner);
    assert.equal(remembered.some(([token]) => token === UFG), false, 'confirmed spent holdings are removed from browser memory too');
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

// Changed on purpose 2026-10-14 (incident of 2026-10-13, package D2): this was the rule that left production with "Wallet
// value unavailable." for the owner's 63 tokens (one held token's pool stopped qualifying, and the card withheld its whole
// total for a day). UFG still keeps its place with no USD, and is counted for nothing; the total is now the priced
// tokens' (USDG's $1.00) and says, under the figure, that one held token is not priced. It was no total at all.
test('Wallet keeps a previously priced UFG in the top rows when its quote disappears, and totals the priced tokens saying UFG is left out', { timeout: 60_000 }, async () => {
  const now = Math.floor(Date.now() / 1000);
  const chain = createDirectChain({ chainId: 4663, timestamp: now, v4: [] });
  const read6 = { portfolio: portfolioOf({ wallet: chain.owner }), activity: activityOf({ wallet: chain.owner }) };
  const read = createReadStub({ reads: 'wallet-assets', answer: route => route === 'wallet-assets' ? walletAnswer(now, 1000000) : undefined });
  const s = await openPositionPage(browser, chain, { hash: '#/positions', read6, routes: [read.handle], s1: { directCode: { 4663: chain.codeHashes } } });
  try {
    let priced = true;
    await s.context.route(/^https:\/\/(api|cdn)\.dexscreener\.com\//, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(priced ? [{ chainId: 'robinhood', baseToken: { address: UFG, symbol: 'UFG' }, quoteToken: { address: USDG }, priceUsd: '0.003', liquidity: { usd: 100000 } }] : []) }));
    await s.page.reload();
    const card = s.page.locator('[data-portfolio-tokens]');
    await card.locator(`[data-wallet-row="${UFG}"][data-wallet-priced]`).waitFor();
    assert.equal(await card.locator('[data-wallet-total] .dm-fig-xl').textContent(), '$3,001.00');
    assert.equal(await card.locator('[data-wallet-total-note]').count(), 0, 'every held token priced: no note');
    priced = false;
    await s.page.reload();
    await s.page.waitForFunction(() => {
      const card = document.querySelector('[data-portfolio-tokens]');
      return card?.getAttribute('data-wallet-source') === 'read' && card.getAttribute('data-wallet-prices') === 'ok' && card.querySelector('[data-wallet-total-note]');
    });
    assert.equal(await card.locator('[data-wallet-row]').first().getAttribute('data-wallet-row'), UFG);
    assert.equal(await card.locator(`[data-wallet-row="${UFG}"] [data-usd]`).count(), 0);
    assert.match(await card.locator(`[data-wallet-row="${UFG}"] [data-no-price]`).getAttribute('title'), /Not counted in the total/);
    assert.equal(await card.locator('[data-wallet-total] .dm-fig-xl').textContent(), '$1.00', 'USDG alone; UFG is not counted as anything');
    assert.equal(await card.locator('[data-wallet-total-note]').textContent(), 'Total of priced tokens · 1 not priced');
    assert.equal(await card.locator('[data-wallet-value-unavailable]').count(), 0);
    assert.equal(await card.locator(`[data-wallet-row="${UFG}"] [data-wallet-balance-earlier]`).count(), 0, 'only the price is missing; the current token balance still reads normally');
    assert.equal(chain.sends.length, 0);
  } finally { await s.close(); }
});

test('returning to Positions retains one complete wallet valuation and stable rows during a delayed balance read', { timeout: 60_000 }, async () => {
  const now = Math.floor(Date.now() / 1000);
  const chain = createDirectChain({ chainId: 4663, timestamp: now, v4: [] });
  const read6 = { portfolio: portfolioOf({ wallet: chain.owner }), activity: activityOf({ wallet: chain.owner }) };
  let hold = false, release;
  const delayed = new Promise(resolve => { release = resolve; });
  const read = createReadStub({ reads: 'wallet-assets', answer: async route => {
    if (route !== 'wallet-assets') return undefined;
    if (hold) await delayed;
    return walletAnswer(now, 1363607);
  } });
  const s = await openPositionPage(browser, chain, { hash: '#/positions', read6, routes: [read.handle], s1: { directCode: { 4663: chain.codeHashes } } });
  try {
    await s.context.route(/^https:\/\/(api|cdn)\.dexscreener\.com\//, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ chainId: 'robinhood', baseToken: { address: UFG, symbol: 'UFG' }, quoteToken: { address: USDG }, priceUsd: '0.003', liquidity: { usd: 100000 } }]) }));
    await s.page.reload();
    const card = s.page.locator('[data-portfolio-tokens]');
    const row = card.locator(`[data-wallet-row="${UFG}"]`);
    await row.locator('[data-usd]').waitFor();
    await s.page.waitForFunction(() => document.querySelector('[data-portfolio-tokens]')?.getAttribute('data-wallet-source') === 'read');
    const geometry = async () => ({ total: await card.locator('.dm-acct-total').boundingBox(), row: await row.boundingBox() });
    const before = await geometry();
    const total = await card.locator('[data-wallet-total] .dm-fig-xl').textContent();
    const price = await row.locator('[data-usd]').textContent();
    hold = true;
    await s.page.evaluate(() => { location.hash = '#/'; });
    await card.waitFor({ state: 'detached' });
    await s.page.evaluate(() => { location.hash = '#/positions'; });
    await row.locator('[data-wallet-value-snapshot]').waitFor();
    assert.equal(await card.locator('[data-wallet-total] .dm-fig-xl').textContent(), total);
    assert.equal(await row.locator('[data-usd]').textContent(), price);
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): the kept valuation's title is its own basis, never "Previous complete valuation. Checking the current balance.".
    assert.doesNotMatch(await row.locator('[data-usd]').getAttribute('title'), /Previous complete valuation|Checking/);
    // Changed on purpose 2026-11-09 (a local flake under load: the rows were measured while the card's entry animation still
    // ran): measured once every finite animation of the page has ended, so the check is of the layout, never of a frame.
    await s.page.evaluate(() => Promise.all(document.getAnimations().filter((one) => one.effect?.getTiming().iterations !== Infinity).map((one) => one.finished.catch(() => undefined))));
    const updating = await geometry();
    const totalHeightDelta = Math.abs(updating.total.height - before.total.height);
    const rowHeightDelta = Math.abs(updating.row.height - before.row.height);
    assert.ok(totalHeightDelta < 0.5, `the total occupies the same slot during refresh (height delta: ${totalHeightDelta}px)`);
    assert.ok(rowHeightDelta < 0.5, `the token row never adds a status line (height delta: ${rowHeightDelta}px)`);
    assert.ok(Math.abs((updating.row.y - updating.total.y) - (before.row.y - before.total.y)) < 0.5, 'the token list keeps its spacing under the total, independent of the card entry animation');
    for (const width of [1180, 390, 320]) {
      await s.page.setViewportSize({ width, height: 960 });
      const layout = await row.evaluate(node => {
        const units = node.querySelector('.dm-acct-token-units');
        return { nowrap: getComputedStyle(units).whiteSpace, oldHidden: node.querySelector('[data-wallet-balance-earlier]').hidden, overflow: document.documentElement.scrollWidth > innerWidth, height: units.getBoundingClientRect().height, line: parseFloat(getComputedStyle(units).lineHeight) };
      });
      assert.equal(layout.nowrap, 'nowrap');
      // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): the marker is hidden outright (it was an sr-only line).
      assert.equal(layout.oldHidden, true, 'the read status is a hidden marker, with no visible extra label');
      assert.equal(layout.overflow, false, `the wallet fits ${width}px`);
      assert.ok(layout.height <= layout.line + 0.5, 'the token quantity occupies exactly one line');
      // Changed on purpose 2026-11-07 (day-9 rehearsal, finding F12): app/.test-artifacts from this file's own place, which
      // the root .gitignore ignores; the path from the working directory wrote app/app/.test-artifacts when run from app/,
      // an untracked folder that stopped npm run release:build ("uncommitted changes").
      const directory = process.env.DOMINO_POSITION_SHOTS ? resolve(process.env.DOMINO_POSITION_SHOTS) : resolve(import.meta.dirname, '../../.test-artifacts');
      mkdirSync(directory, { recursive: true });
      await card.screenshot({ path: join(directory, `wallet-refresh-stable-${width}.png`), animations: 'disabled' });
    }
    release();
    await row.locator('[data-wallet-value-snapshot]').waitFor({ state: 'detached' });
    assert.equal(await row.locator('[data-usd]').textContent(), price);
    assert.equal(chain.sends.length, 0);
  } finally { release(); await s.close(); }
});

test('Wallet refreshes after its owner confirms, rejects pre-receipt balances and updates in place at the receipt block', { timeout: 60_000 }, async () => {
  const now = Math.floor(Date.now() / 1000);
  const v4 = [601001n, 601002n].map((tokenId) => ({ tokenId, pool, ...range, liquidity, sqrtPriceX96, tick, growthLast: [0n, 0n], growthNow: [0n, 0n] }));
  const chain = createDirectChain({ chainId: 4663, timestamp: now, v4 });
  const read6 = { portfolio: portfolioOf({ wallet: chain.owner,
    positions: v4.map((one) => livePosition({ chainId: 4663, manager: chain.at.v4PositionManager, tokenId: one.tokenId, owner: chain.owner, pool, ...range, liquidity, sqrtPriceX96, tick })),
    tokens: [indexedToken(4663, ZERO, 'ETH', 18), indexedToken(4663, USDG, 'USDG', 6)] }), activity: activityOf({ wallet: chain.owner }) };
  const oldBlock = 0x2fff, receiptBlock = 0x3000;
  let oldReplies = 0, currentRequested = false, releaseCurrent;
  const currentReady = new Promise((resolveReady) => { releaseCurrent = resolveReady; });
  const pageAt = (block, units) => {
    const page = structuredClone(fixture);
    page.snapshot.number = block; page.snapshot.timestamp = now;
    page.inventory.retrievedAt = now;
    page.items[1] = { ...page.items[1], address: USDG, symbol: 'USDG', amountRaw: String(BigInt(units) * 1_000_000n) };
    return JSON.stringify(page);
  };
  const read = createReadStub({ reads: 'wallet-assets', answer: async (route) => {
    if (route !== 'wallet-assets') return undefined;
    if (chain.sends.length === 0) return pageAt(oldBlock, 1);
    if (oldReplies++ === 0) return pageAt(oldBlock, 999);
    currentRequested = true;
    await currentReady;
    return pageAt(receiptBlock, 2);
  } });
  const s = await openPositionPage(browser, chain, { hash: '#/positions', read6, routes: [read.handle], s1: { directCode: { 4663: chain.codeHashes } } });
  try {
    const page = s.page, card = page.locator('[data-portfolio-tokens]');
    const balance = card.locator(`[data-wallet-row="${USDG}"] [data-balance]`);
    await balance.getByText('1', { exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('[data-portfolio-tokens]')?.getAttribute('data-wallet-source') === 'read');
    await card.evaluate((node) => { node.dataset.walletRegression = 'same-card'; window.__walletRegression = 'same-document'; });

    await page.locator('[data-bulk-close-open]').click();
    const dialog = page.locator('[data-bulk-close]');
    for (const choice of await dialog.getByRole('checkbox').all()) await choice.check();
    await dialog.getByRole('button', { name: 'Review 2 positions', exact: true }).click();
    await page.locator('[data-bulk-close="review"]').waitFor();
    await dialog.getByRole('button', { name: 'Close 2 positions', exact: true }).click();
    await page.locator('[data-bulk-close="done"]').waitFor();
    // The retry's arrival proves the pre-receipt page was handled. Hold the good reply to inspect what remained visible.
    await assert.doesNotReject(async () => {
      const deadline = Date.now() + 15_000;
      while (!currentRequested && Date.now() < deadline) await new Promise((done) => setTimeout(done, 25));
      assert.ok(currentRequested, 'the confirmed action refreshes Wallet automatically, then retries a stale node');
    });
    assert.equal(await balance.innerText(), '1', 'the older 999 USDG page cannot replace the last good balance');
    assert.equal(await card.locator('[data-wallet-total]').count(), 0, 'while the post-receipt balance is pending, the old total is not presented as current');
    releaseCurrent();
    await balance.getByText('2', { exact: true }).waitFor();
    assert.match(await card.locator('[data-wallet-total]').innerText(), /\$2\.00$/);
    assert.equal(await card.getAttribute('data-wallet-regression'), 'same-card');
    assert.equal(await page.evaluate(() => window.__walletRegression), 'same-document');
    assert.equal(chain.sends.length, 1, 'only the fake close transaction was sent');
    assert.deepEqual(chain.missing, []);
  } finally { releaseCurrent(); await s.close(); }
});
