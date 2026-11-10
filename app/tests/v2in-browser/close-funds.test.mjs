/**
 * Added 2026-11-09 (the core-flows fix; the owner: getting your money back from a closed position must be totally easy).
 * A closed position whose automation still holds its fees ("Funds available in automation"):
 *   - on its own page, Withdraw to wallet stands in the actions row, one press from the dialog that sends them to the
 *     wallet (it sat behind the automation's control and its sheet);
 *   - in the Positions list, its closed row says Withdraw to wallet where it said View history, and opening it lands on
 *     that same dialog (src/v2in/automate/handoff.ts, focus `withdraw`).
 * On the wallet-test-v2 build, live on a fake Base chain, read-v6 scripted (tests/support/position-v2-page.mjs).
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { closeBrowser } from '../support/close-browser.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';

const APP = resolve(import.meta.dirname, '../..');
if (!existsSync(join(WALLET_V2_DIST, 'index.html'))) throw new Error('.wallet-test-v2-dist is missing. Run npm run build:wallet-test-v2 first (npm run test:v2in does).');
const { activityOf, indexedToken, livePosition, portfolioOf, vaultOf } = await import('../support/s1-read6.mjs');
const { launchBrowser } = await import('../support/s1-browser.mjs');
const { createDirectChain } = await import('../support/v2-direct-chain.mjs');
const { openPositionPage } = await import('../support/position-v2-page.mjs');

const require = createRequire(import.meta.url);
const position = require('../../.test-build/app/src/finance/position.js');
const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const VAULT = '0x00000000000000000000000000000000000000aa';
const pool = { dex: 4, currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10, hooks: ZERO };
const RANGE = { tickLower: -201060, tickUpper: -197040 };
const TICK = -199020;
const SQRT = position.sqrtPriceAtTick(TICK);
const text = async (locator) => (await locator.innerText()).replace(/\s+/g, ' ').trim();
const shotsDir = () => { const dir = resolve(process.env.DOMINO_CLOSE_SHOTS ?? join(APP, '.test-artifacts')); mkdirSync(dir, { recursive: true }); return dir; };
async function shoot(page, name) {
  const before = page.viewportSize();
  for (const [size, viewport] of [['desktop-1440', { width: 1440, height: 900 }], ['phone-390', { width: 390, height: 844 }]]) {
    await page.setViewportSize(viewport);
    await page.waitForTimeout(250);
    await page.screenshot({ path: join(shotsDir(), `${name}-${size}.png`) });
  }
  if (before) await page.setViewportSize(before);
}

let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await closeBrowser(browser); });

/** A closed root (no liquidity) on Base whose automation still holds 0.001 ETH and 2.5 USDC of its fees. */
async function scenario(hash) {
  const tokenId = 5_200_001n;
  const chain = createDirectChain({ chainId: 8453, timestamp: Math.floor(Date.now() / 1000), v4: [{ tokenId, pool, ...RANGE, liquidity: 0n, sqrtPriceX96: SQRT, tick: TICK, growthLast: [0n, 0n], growthNow: [0n, 0n] }] });
  const manager = chain.at.v4PositionManager;
  const read6 = { portfolio: portfolioOf({ wallet: chain.owner,
    positions: [livePosition({ chainId: 8453, manager, tokenId, owner: chain.owner, pool, ...RANGE, liquidity: 0n, sqrtPriceX96: SQRT, tick: TICK, vault: { address: VAULT, role: 'root' } })],
    vaults: [vaultOf({ wallet: chain.owner, chainId: 8453, address: VAULT, rootTokenId: tokenId, pool, reserves: ['1000000000000000', '2500000'], armed: false })],
    tokens: [indexedToken(8453, ZERO, 'ETH', 18), indexedToken(8453, USDC, 'USDC', 6)] }), activity: activityOf({ wallet: chain.owner }) };
  return openPositionPage(browser, chain, { hash, read6, viewport: { width: 1440, height: 900 }, s1: { directCode: { 8453: chain.codeHashes } } });
}

test('a closed position with funds left in its automation: Withdraw to wallet in its row opens that dialog', async () => {
  const s = await scenario('#/positions/base-v4-5200001');
  try {
    const page = s.page;
    const withdraw = page.locator('[data-automation-withdraw]');
    await withdraw.waitFor({ timeout: 30_000 });
    assert.equal(await text(withdraw), 'Withdraw to wallet');
    assert.equal(await page.locator('[data-position-action="close"]').count(), 0, 'nothing left to close');
    await shoot(page, 'funds-left-position');
    await withdraw.click();
    const dialog = page.locator('[role="dialog"]').filter({ hasText: 'Withdraw to wallet' });
    await dialog.locator('[data-vault-receive="withdraw"]').waitFor({ timeout: 30_000 });
    assert.match(await text(dialog.locator('[data-vault-receive="withdraw"]')), /You receive .*ETH.*USDC Domino fee None/);
    await shoot(page, 'funds-left-withdraw-dialog');
  } finally { await s.close(); }
});

test('the Positions list: a closed row with funds left says Withdraw to wallet, and opening it lands on that dialog', async () => {
  const s = await scenario('#/positions');
  try {
    const page = s.page;
    await page.getByRole('tab', { name: /^Closed/ }).click();
    const caption = page.locator('[data-row-withdraw]');
    await caption.waitFor({ timeout: 30_000 });
    assert.equal(await text(caption), 'Withdraw to wallet');
    await shoot(page, 'funds-left-list-row');
    await caption.click();
    const dialog = page.locator('[role="dialog"]').filter({ hasText: 'Withdraw to wallet' });
    await dialog.locator('[data-vault-receive="withdraw"]').waitFor({ timeout: 30_000 });
  } finally { await s.close(); }
});
