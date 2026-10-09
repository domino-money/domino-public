import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
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
const pool = { dex: 4, currency0: ZERO, currency1: USDG, fee: 500, tickSpacing: 10, hooks: ZERO };
const range = { tickLower: -201060, tickUpper: -197040 };
const tick = -199020, sqrtPriceX96 = position.sqrtPriceAtTick(tick), liquidity = 10n ** 15n;
const fixture = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../api-contracts/read-v1/fixtures/gateway/wallet-assets.last-page.json'), 'utf8'));
let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await closeBrowser(browser); });

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
    assert.match(await card.locator('[data-wallet-total]').innerText(), /\$1\.00$/);
    releaseCurrent();
    await balance.getByText('2', { exact: true }).waitFor();
    assert.match(await card.locator('[data-wallet-total]').innerText(), /\$2\.00$/);
    assert.equal(await card.getAttribute('data-wallet-regression'), 'same-card');
    assert.equal(await page.evaluate(() => window.__walletRegression), 'same-document');
    assert.equal(chain.sends.length, 1, 'only the fake close transaction was sent');
    assert.deepEqual(chain.missing, []);
  } finally { releaseCurrent(); await s.close(); }
});
