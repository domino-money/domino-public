/** The live V2 create journey reaches the shared bridge offer. Everything here is a local test wallet/service. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { closeBrowser } from '../support/close-browser.mjs';
import { openJourney } from '../support/journey-browser.mjs';
import { launchBrowser } from '../support/s1-browser.mjs';
import { S2_ACCOUNT, S2_OWNER } from '../support/s2-wallet.mjs';
import { contractsFor, createV2Chain } from '../support/v2-chain.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';

const require = createRequire(import.meta.url);
const { sqrtPriceAtTick } = require('../../.test-build/app/src/finance/position.js');
const ZERO = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const POOL = { dex: 4, currency0: ZERO, currency1: USDG, fee: 500, tickSpacing: 10, hooks: ZERO };
const TICK = -199020;
let browser;
before(async () => { browser = await launchBrowser(); });
after(async () => { await closeBrowser(browser); });

async function openFunding({ balance = 0n, failed = false, bridge = true } = {}) {
  const calls = [], walletMethods = [];
  const chain = createV2Chain({ chainId: 4663, timestamp: Math.floor(Date.now() / 1000), balances: { [USDG]: balance }, pools: [{ pool: POOL, sqrtPriceX96: sqrtPriceAtTick(TICK), tick: TICK, liquidity: 10n ** 16n }] });
  chain.switchTo(4663);
  const routes = [async (request, url) => {
    if (!bridge || !url.pathname.startsWith('/api/crosschain/v1/')) return undefined;
    const route = url.pathname.split('/').at(-1);
    const headers = { 'X-Domino-Crosschain-Contract': '1.0.0-rc.1' };
    if (route === 'capabilities') return Response.json({ contractVersion: '1.0.0-rc.1', dataMode: 'live', enabledRoutes: ['origins', 'quote', 'status'] }, { headers });
    const body = await request.json(); calls.push({ route, body });
    assert.ok(request.headers.get('X-Domino-CSRF'));
    const data = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../api-contracts/crosschain-v1/fixtures/responses/' + route + '.json'), 'utf8').replaceAll('0x1111111111111111111111111111111111111111', S2_OWNER));
    if (route === 'quote') {
      data.quote.requestedAt = data.quote.retrievedAt = Math.floor(Date.now() / 1000);
      data.quote.expiresAt = data.quote.requestedAt + 120;
      assert.deepEqual(body, Object.fromEntries(Object.entries(data.quote.request).filter(([key]) => key !== 'owner')));
    }
    return Response.json(data, { headers });
  }];
  const s = await openJourney(browser, chain, { dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, routes,
    intercept: async (method, params) => {
      walletMethods.push(method);
      if (method === 'personal_sign') return { result: await S2_ACCOUNT.signMessage({ message: { raw: params[0] } }) };
      if (failed && method === 'eth_call' && params[0]?.to === USDG && params[0]?.data?.startsWith('0x70a08231')) return { error: { code: -32603, message: 'balance unavailable' } };
    },
  });
  try {
    const zap = s.page.locator('[data-zap-journey="4663"][data-zap-gate="live"]');
    await zap.waitFor();
    const finder = zap.locator('[data-pool-find]');
    await finder.locator('summary').click();
    await finder.getByRole('radiogroup', { name: 'First token' }).getByRole('radio', { name: 'ETH', exact: true }).click();
    await finder.getByRole('radiogroup', { name: 'Second token' }).getByRole('radio', { name: 'USDG', exact: true }).click();
    await finder.getByRole('radiogroup', { name: 'Fee tier' }).getByRole('radio', { name: '0.05%', exact: true }).click();
    await finder.locator('[data-pool-read]').click();
    await zap.locator('[data-chosen-pool][data-pool-source="wallet"]').waitFor();
    await zap.locator('[data-zap-continue="pool"]').click();
    await zap.locator('[data-zap-continue="range"]').click();
    await zap.locator(`[data-zap-amount="${USDG}"] input`).fill('50');
    return { ...s, zap, chain, calls, walletMethods };
  } catch (error) { await s.close().catch(() => {}); throw error; }
}

async function captureCard(s, suffix) {
  if (!process.env.DOMINO_R5_SHOTS) return;
  const directory = resolve(process.env.DOMINO_R5_SHOTS); mkdirSync(directory, { recursive: true });
  for (const width of [1440, 390, 320]) {
    await s.page.setViewportSize({ width, height: 1000 });
    const card = s.zap.locator('[data-funds-offer]');
    await card.scrollIntoViewIfNeeded();
    assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}: no horizontal overflow`);
    await card.screenshot({ path: resolve(directory, `funds-v2-${suffix}-local-fixture-${width}.png`) });
  }
}

test('live V2 Amount automatically finds its exact shortfall and reaches the shared bridge quote after explicit sign-in', async () => {
  const s = await openFunding();
  try {
    const offer = s.zap.locator('[data-funds-offer][data-funds-mode="live"]');
    await offer.waitFor();
    assert.equal(await offer.getAttribute('data-funds-token'), USDG);
    assert.equal(await offer.locator('[data-funds-lack]').innerText(), '50 USDG more needed.');
    assert.equal(s.walletMethods.includes('wallet_switchEthereumChain'), false);
    assert.equal(s.walletMethods.includes('personal_sign'), false);
    assert.deepEqual(s.calls, []);
    await captureCard(s, 'offer');
    const readsBefore = s.walletMethods.filter((method) => method === 'eth_getBalance').length;
    await s.zap.locator(`[data-zap-amount="${USDG}"] input`).fill('60');
    await offer.locator('[data-funds-lack]').getByText('60 USDG more needed.', { exact: true }).waitFor();
    assert.equal(s.walletMethods.filter((method) => method === 'eth_getBalance').length, readsBefore, 'typing reuses the destination read');
    await offer.locator('[data-funds-signin]').click();
    await s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Sign in', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe.view().status === 'signed_in');
    await s.page.keyboard.press('Escape');
    await offer.locator('[data-funds-origins="ok"]').waitFor();
    await s.page.locator('#funds-origin-chain').click();
    await s.page.getByRole('option', { name: 'Arbitrum', exact: true }).click();
    await s.page.locator('#funds-origin-token').click();
    await s.page.getByRole('option', { name: /^USDC ·/ }).click();
    await s.page.locator('#funds-amount').fill('100');
    await offer.locator('[data-funds-get-quote]').click();
    await offer.locator('[data-funds-quote]').waitFor();
    assert.equal(await offer.locator('[data-funds-edit]').getAttribute('open'), null, 'quote keeps the sending form folded and editable');
    assert.equal(await offer.locator('[data-funds-alternatives]').getAttribute('open'), null, 'the selected route gets focus');
    assert.deepEqual(s.calls.map((call) => call.route), ['origins', 'quote']);
    assert.equal(s.calls[1].body.destinationToken, USDG);
    await captureCard(s, 'quote');
    assert.equal(s.chain.sends.length, 0);
  } finally { await s.close(); }
});

test('V2 with sufficient selected tokens does not suggest a bridge', async () => {
  const s = await openFunding({ balance: 5_000_000_000n });
  try {
    await s.zap.locator('[data-zap-funds]').waitFor();
    await s.page.waitForFunction(() => document.querySelector('[data-zap-funds]') && !document.querySelector('[data-zap-funds-balance]'));
    assert.equal(await s.zap.locator('[data-funds-offer]').count(), 0);
    assert.deepEqual(s.calls, []);
    assert.equal(s.chain.sends.length, 0);
  } finally { await s.close(); }
});

test('an unread V2 balance is unavailable, never a zero shortfall; disconnect removes all account-scoped funding state', async () => {
  const s = await openFunding({ failed: true });
  try {
    await s.zap.locator('[data-zap-funds-balance="unavailable"]').waitFor();
    assert.equal(await s.zap.locator('[data-funds-offer]').count(), 0);
    assert.deepEqual(s.calls, []);
    await s.page.locator('header [aria-haspopup="dialog"]').click();
    await s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Disconnect wallet', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe.view().status === 'no_wallet');
    assert.equal(await s.zap.locator('[data-zap-funds]').count(), 0);
    assert.equal(s.walletMethods.includes('wallet_switchEthereumChain'), false);
    assert.equal(s.chain.sends.length, 0);
  } finally { await s.close(); }
});
