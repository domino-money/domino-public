import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { createDirectChain } from '../support/v2-direct-chain.mjs';
import { activityOf, indexedToken, livePosition, portfolioOf } from '../support/s1-read6.mjs';
import { launchBrowser } from '../support/s1-browser.mjs';
import { openPositionPage, WALLET_NAME } from '../support/position-v2-page.mjs';
import { closeBrowser } from '../support/close-browser.mjs';

const require = createRequire(import.meta.url);
const position = require('../../.test-build/app/src/finance/position.js');
const ZERO = '0x0000000000000000000000000000000000000000';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const pool = { dex: 4, currency0: ZERO, currency1: USDC, fee: 500, tickSpacing: 10, hooks: ZERO };
const RANGE = { tickLower: -201060, tickUpper: -197040 };
const TICK = -199020;
const SQRT = position.sqrtPriceAtTick(TICK);
const LIQUIDITY = 10n ** 15n;
const shots = resolve(import.meta.dirname, '../../.test-artifacts');
mkdirSync(shots, { recursive: true });
let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await closeBrowser(browser); });

async function scenario(viewport = { width: 1320, height: 960 }, hash = '#/positions', intercept = () => undefined) {
  const v4 = [501001n, 501002n].map((tokenId) => ({ tokenId, pool, ...RANGE, liquidity: LIQUIDITY, sqrtPriceX96: SQRT, tick: TICK, growthLast: [0n, 0n], growthNow: [0n, 0n] }));
  const chain = createDirectChain({ chainId: 8453, timestamp: Math.floor(Date.now() / 1000), v4 });
  const read6 = { portfolio: portfolioOf({ wallet: chain.owner,
    positions: v4.map((one) => livePosition({ chainId: 8453, manager: chain.at.v4PositionManager, tokenId: one.tokenId, owner: chain.owner, pool, ...RANGE, liquidity: LIQUIDITY, sqrtPriceX96: SQRT, tick: TICK })),
    tokens: [indexedToken(8453, ZERO, 'ETH', 18), indexedToken(8453, USDC, 'USDC', 6)] }), activity: activityOf({ wallet: chain.owner }) };
  const page = await openPositionPage(browser, chain, { hash, read6, viewport, intercept: (method, params) => intercept(method, params, chain), s1: { directCode: { 8453: chain.codeHashes } } });
  return { ...page, chain };
}

test('bulk close: selection → one review → one fake transaction; refusal can be reviewed again and a local receipt covers both NFTs', async () => {
  const s = await scenario({ width: 390, height: 844 });
  try {
    const page = s.page;
    await page.locator('[data-bulk-close-open]').click();
    const dialog = page.locator('[data-bulk-close]');
    assert.equal(await dialog.getByRole('checkbox').count(), 2);
    for (const choice of await dialog.getByRole('checkbox').all()) await choice.check();
    await dialog.getByRole('button', { name: 'Review 2 positions', exact: true }).click();
    await page.locator('[data-bulk-close="review"]').waitFor();
    assert.match(await dialog.innerText(), /No|None/);
    await dialog.screenshot({ path: resolve(shots, 'close-many-review-390.png') });
    s.chain.decline();
    await dialog.getByRole('button', { name: 'Close 2 positions', exact: true }).click();
    await page.locator('[data-bulk-close="failed"]').waitFor();
    assert.equal(s.chain.sends.length, 0);
    await dialog.getByRole('button', { name: 'Review again' }).click();
    await page.locator('[data-bulk-close="review"]').waitFor();
    await dialog.getByRole('button', { name: 'Close 2 positions', exact: true }).click();
    await page.locator('[data-bulk-close="done"]').waitFor();
    assert.equal(s.chain.sends.length, 1);
    assert.equal(s.chain.v4Position(501001n).liquidity, 0n);
    assert.equal(s.chain.v4Position(501002n).liquidity, 0n);
    const saved = await page.evaluate((owner) => JSON.parse(localStorage.getItem(`domino:confirmed-closes:v1:${owner}`)), s.chain.owner);
    assert.deepEqual(saved[0].tokenIds, ['501001', '501002']);
    assert.equal(saved[0].state, 'finalized');
    assert.equal(saved[0].amounts.find((entry) => entry.token === ZERO).amount, null);
    assert.deepEqual(s.chain.missing, []);
  } finally { await s.close(); }
});

async function offerGroup(page) {
  await page.locator('[data-bulk-close-open]').click();
  const dialog = page.locator('[data-bulk-close]');
  for (const choice of await dialog.getByRole('checkbox').all()) await choice.check();
  await dialog.getByRole('button', { name: 'Review 2 positions', exact: true }).click();
  await page.locator('[data-bulk-close="review"]').waitFor();
  await dialog.getByRole('button', { name: 'Close 2 positions', exact: true }).click();
}
async function reopen(page) {
  await page.reload();
  await page.waitForFunction(() => ['no_wallet', 'signed_out', 'wrong_network'].includes(window.__dominoSessionProbe?.view().status));
  if (await page.evaluate(() => window.__dominoSessionProbe.view().status === 'no_wallet')) {
    await page.getByRole('button', { name: /Connect wallet/ }).first().click();
    await page.getByRole('button', { name: `Connect ${WALLET_NAME}`, exact: true }).click();
    await page.waitForFunction(() => ['signed_out', 'wrong_network'].includes(window.__dominoSessionProbe?.view().status));
    await page.keyboard.press('Escape');
  }
  await page.locator('[data-bulk-close-open]').click();
}
test('reload while pending restores only Check status, then clears the durable intent after canonical confirmation', async () => {
  let pending = true;
  const s = await scenario(undefined, undefined, (method) => method === 'eth_getTransactionReceipt' && pending ? { result: null } : undefined);
  try {
    await offerGroup(s.page);
    await s.page.locator('[data-bulk-close="sent"]').waitFor();
    await s.page.waitForFunction(() => JSON.parse(localStorage.getItem('domino.pending-close.v1'))?.[0]?.hash);
    await reopen(s.page);
    await s.page.locator('[data-bulk-close="waiting"]').waitFor();
    assert.equal(s.chain.sends.length, 1);
    assert.equal(await s.page.getByRole('button', { name: 'Close 2 positions', exact: true }).count(), 0);
    pending = false;
    await s.page.getByRole('button', { name: 'Check status', exact: true }).click();
    await s.page.locator('[data-bulk-close="done"]').waitFor();
    assert.equal(s.chain.sends.length, 1);
    assert.deepEqual(await s.page.evaluate(() => JSON.parse(localStorage.getItem('domino.pending-close.v1'))), []);
  } finally { await s.close(); }
});
test('reload with no hash never reoffers: a wrong hash stays blocked, a matching receipt recovers, and 320px remains contained', async () => {
  let txHash;
  const s = await scenario({ width: 320, height: 844 }, '#/positions', async (method, params, chain) => {
    if (method !== 'eth_sendTransaction') return undefined;
    const reply = await chain.request(method, params); txHash = reply.result;
    return { error: { code: -32000, message: 'Connection lost after accepting transaction' } };
  });
  try {
    await offerGroup(s.page);
    await s.page.locator('[data-bulk-close="unknown"]').waitFor();
    assert.equal(await s.page.evaluate(() => JSON.parse(localStorage.getItem('domino.pending-close.v1'))[0].hash), null);
    await reopen(s.page);
    const dialog = s.page.locator('[data-bulk-close="unknown"]'); await dialog.waitFor();
    assert.equal(s.chain.sends.length, 1);
    await dialog.getByText('Find your transaction', { exact: true }).click();
    await dialog.getByLabel('Transaction hash from your wallet').fill('0x' + 'f'.repeat(64));
    await dialog.getByRole('button', { name: 'Check status', exact: true }).click();
    await dialog.getByText('This transaction has not been found yet.', { exact: false }).waitFor();
    assert.equal(s.chain.sends.length, 1);
    assert.ok(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth));
    await dialog.screenshot({ path: resolve(shots, 'close-many-recovery-320.png') });
    await dialog.getByLabel('Transaction hash from your wallet').fill(txHash);
    await dialog.getByRole('button', { name: 'Check status', exact: true }).click();
    await s.page.locator('[data-bulk-close="done"]').waitFor();
    assert.equal(s.chain.sends.length, 1);
    assert.deepEqual(await s.page.evaluate(() => JSON.parse(localStorage.getItem('domino.pending-close.v1'))), []);
  } finally { await s.close(); }
});
test('a manually recovered unknown hash follows included through finalized without entering the sender or sending twice', async () => {
  let txHash, final = false;
  const s = await scenario(undefined, undefined, async (method, params, chain) => {
    if (method === 'eth_getBlockByNumber' && params[0] === 'finalized' && !final) return { result: { number: '0x0' } };
    if (method !== 'eth_sendTransaction') return undefined;
    const reply = await chain.request(method, params); txHash = reply.result;
    return { error: { code: -32000, message: 'Connection lost after accepting transaction' } };
  });
  try {
    await offerGroup(s.page); await s.page.locator('[data-bulk-close="unknown"]').waitFor();
    await s.page.getByText('Find your transaction', { exact: true }).click();
    await s.page.getByLabel('Transaction hash from your wallet').fill(txHash);
    await s.page.getByRole('button', { name: 'Check status', exact: true }).click();
    await s.page.waitForFunction((owner) => JSON.parse(localStorage.getItem(`domino:confirmed-closes:v1:${owner}`))?.[0]?.state === 'included', s.chain.owner);
    final = true;
    await s.page.locator('[data-bulk-close="done"]').waitFor();
    assert.equal(s.chain.sends.length, 1);
    assert.deepEqual(await s.page.evaluate(() => JSON.parse(localStorage.getItem('domino.pending-close.v1'))), []);
  } finally { await s.close(); }
});

for (const changed of [false, true]) test(`a wallet ${changed ? 'replacement with another effect' : 'speed-up'} is proved after reload without another app send`, async () => {
  const originalHash = '0x' + 'a'.repeat(64); let original, offers = 0;
  const s = await scenario(undefined, undefined, (method, params) => {
    if (method === 'eth_sendTransaction') { offers++; original = params[0]; return { result: originalHash }; }
    if (method === 'eth_getTransactionByHash' && params[0] === originalHash) return { result: { ...original, hash: originalHash, input: original.data } };
    if (method === 'eth_getTransactionReceipt' && params[0] === originalHash) return { result: null };
    return undefined;
  });
  try {
    await offerGroup(s.page);
    await s.page.waitForFunction(() => JSON.parse(localStorage.getItem('domino.pending-close.v1'))?.[0]?.hash);
    await reopen(s.page); await s.page.locator('[data-bulk-close="waiting"]').waitFor();
    // The wallet replaces the pending transaction outside Domino, preserving its nonce.
    const replacement = await s.chain.request('eth_sendTransaction', [{ ...original, ...(changed ? { to: s.chain.owner, data: '0x' } : {}) }]);
    assert.ok(replacement.result);
    await s.page.getByText('Updated transaction in your wallet?', { exact: true }).click();
    await s.page.getByLabel('Transaction hash from your wallet').fill(replacement.result);
    await s.page.getByRole('button', { name: 'Check status', exact: true }).click();
    await s.page.locator(`[data-bulk-close="${changed ? 'failed' : 'done'}"]`).waitFor();
    assert.equal(offers, 1, 'only the original user offer came from Domino');
    assert.deepEqual(await s.page.evaluate(() => JSON.parse(localStorage.getItem('domino.pending-close.v1'))), []);
    const receipts = await s.page.evaluate((owner) => JSON.parse(localStorage.getItem(`domino:confirmed-closes:v1:${owner}`)) ?? [], s.chain.owner);
    if (changed) {
      assert.match(await s.page.locator('[data-bulk-close]').innerText(), /replaced in your wallet/);
      assert.equal(receipts.length, 0, 'a different transaction is never a close receipt');
      assert.equal(s.chain.v4Position(501001n).liquidity, LIQUIDITY);
    } else {
      assert.equal(receipts.length, 1); assert.equal(receipts[0].hash, replacement.result);
      assert.equal(s.chain.v4Position(501001n).liquidity, 0n);
    }
  } finally { await s.close(); }
});

test('Automate leads with New position above three desktop choices, stacks on mobile, and preserves native art without playback controls', async () => {
  const s = await scenario({ width: 1320, height: 960 }, '#/automate');
  try {
    await s.page.getByRole('link', { name: 'Choose a position', exact: true }).waitFor();
    const cards = s.page.locator('[data-automation-card]');
    assert.equal(await cards.count(), 4);
    const slugs = ['new-position', 'auto-compound', 'domino-compound', 'auto-exit'];
    for (const [index, slug] of slugs.entries()) {
      const link = cards.nth(index).locator('.dm-automation-choice-doc');
      assert.equal(await link.getAttribute('href'), `#/docs/${slug}`);
      await link.click();
      await s.page.locator(`[data-docs-page="${slug}"]`).waitFor();
      await s.page.goBack();
      await cards.nth(index).waitFor();
    }
    assert.equal(await cards.first().getByRole('heading', { name: 'New position', exact: true }).count(), 1);
    assert.equal(await cards.first().locator('.choice-create-plus').count(), 1);
    assert.equal(await cards.first().locator('.choice-create-band').count(), 1, 'one destination range');
    assert.equal(await cards.first().locator('.choice-create-tile').count(), 1, 'two inputs create one position');
    assert.equal(await cards.first().locator('.choice-fund').count(), 2);
    const exit = cards.nth(3);
    assert.equal(await exit.locator('.as-exit-fill').count(), 1);
    assert.equal(await exit.locator('.as-boundary').count(), 1, 'the price reaches the range boundary');
    assert.equal(await exit.locator('.as-wallet').count(), 1);
    assert.equal(await exit.locator('.as-wallet-token').count(), 2, 'both tokens return to the wallet');
    assert.match(await exit.innerText(), /Price reaches your limit[\s\S]*Position closes[\s\S]*Your wallet/);
    assert.equal(await s.page.getByRole('button', { name: /Replay|Pause/ }).count(), 0);
    for (const width of [1320, 390, 320]) {
      await s.page.setViewportSize({ width, height: 960 });
      const boxes = await cards.evaluateAll((elements) => elements.map((element) => { const r = element.getBoundingClientRect(); return { x: r.x, y: r.y, bottom: r.bottom, right: r.right, width: r.width }; }));
      assert.ok(boxes.every((box) => box.right <= width && box.x >= 0));
      assert.ok(boxes[1].y > boxes[0].bottom, 'New position leads above the automation choices');
      if (width === 1320) {
        assert.equal(boxes[1].y, boxes[2].y); assert.equal(boxes[2].y, boxes[3].y);
        assert.ok(Math.abs(boxes[1].width - boxes[2].width) < 1 && Math.abs(boxes[2].width - boxes[3].width) < 1);
        assert.ok(boxes[2].x > boxes[1].right && boxes[3].x > boxes[2].right, 'three separated columns');
      } else for (let i = 1; i < boxes.length; i++) assert.ok(boxes[i].y > boxes[i - 1].bottom, 'one separated column on mobile');
      await s.page.screenshot({ path: resolve(shots, `automate-compact-${width}.png`), fullPage: true });
    }
    await s.page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await exit.locator('.as-exit-price').evaluate((node) => getComputedStyle(node).animationName), 'none');
    assert.equal(await s.page.locator('.choice-fund').first().evaluate((node) => getComputedStyle(node).animationName), 'none');
    assert.equal(await cards.first().locator('.choice-create-tile').evaluate((node) => getComputedStyle(node).opacity), '1', 'the still creation picture shows its completed position');
    assert.equal(await exit.locator('.as-exit-fill').evaluate((node) => getComputedStyle(node).fillOpacity), '0.05', 'the still exit picture has a closed, unfilled range');
    assert.equal(await exit.evaluate((node) => {
      const wallet = node.querySelector('.as-wallet').getBoundingClientRect();
      return [...node.querySelectorAll('.as-wallet-token')].every((token) => {
        const bounds = token.getBoundingClientRect();
        const x = (bounds.left + bounds.right) / 2, y = (bounds.top + bounds.bottom) / 2;
        return getComputedStyle(token).opacity === '1' && x >= wallet.left && x <= wallet.right && y >= wallet.top && y <= wallet.bottom;
      });
    }), true, 'the returned tokens are already inside the wallet in reduced motion');
    await cards.first().hover();
    assert.ok(['none', '0px', '0px 0px'].includes(await cards.first().evaluate((node) => getComputedStyle(node).translate)), 'reduced motion keeps the card still on hover');
    assert.equal(s.chain.sends.length, 0);
  } finally { await s.close(); }
});
