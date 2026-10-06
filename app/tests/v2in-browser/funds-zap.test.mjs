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
import { createChainReads } from '../support/chain-reads.mjs';
import { quoteFor } from '../support/crosschain-quotes.mjs';
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

/** ETH at the read fixtures' ETH/USD round, in USDG units per wei: what the bridge stub delivers for ETH sent as USDG. */
const FIXTURE_ETH_USD = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../api-contracts/read-v6/fixtures/valid/chain-pools.json'), 'utf8')).tokens.find((token) => token.symbol === 'ETH').price.usd;
const ETH_AS_USDG = { num: BigInt(FIXTURE_ETH_USD.replace('.', '').slice(0, FIXTURE_ETH_USD.indexOf('.') + 6)), den: 10n ** 18n };

async function openFunding({ balance = 0n, failed = false, bridge = true, served = null } = {}) {
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
    // Changed on purpose 2026-10-06 (the review): whatever amount is asked, as ../support/crosschain-quotes.mjs answers it;
    // ETH sent as USDG at the read fixtures' round, through Relay alone (Across bridges one token as itself only).
    if (route === 'quote') return Response.json(quoteFor(body, S2_OWNER, 'responses/quote', body.originToken === ZERO && body.destinationToken === USDG ? { rate: ETH_AS_USDG, relayOnly: true } : {}), { headers });
    const data = JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../api-contracts/crosschain-v1/fixtures/responses/' + route + '.json'), 'utf8').replaceAll('0x1111111111111111111111111111111111111111', S2_OWNER));
    if (route === 'origins') data.origins.destinationToken = body.destinationToken;
    return Response.json(data, { headers });
  }];
  const s = await openJourney(browser, chain, { dist: WALLET_V2_DIST, live: [4663], contracts: { 4663: contractsFor(4663) }, routes, zapOnRobinhood: true, chainReads: served,
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

// Changed on purpose 2026-10-05 (the owner: "it has to happen behind the scenes"): the offer is one sentence and Domino's
// other networks; what a click on one does (sign in once, move the wallet there, read, choose, quote) is
// tests/v2in-browser/funds-offer.test.mjs's, whose wallet can move between networks.
test('live V2 Amount automatically finds its exact shortfall and offers the other Domino networks, asking nothing before the choice', async () => {
  const s = await openFunding();
  try {
    const offer = s.zap.locator('[data-funds-offer][data-funds-mode="live"]');
    await offer.waitFor();
    assert.equal(await offer.getAttribute('data-funds-token'), USDG);
    assert.equal(await offer.locator('[data-funds-lack]').innerText(), 'You need 50 USDG more on Robinhood Chain.');
    assert.equal(s.walletMethods.includes('wallet_switchEthereumChain'), false);
    assert.equal(s.walletMethods.includes('personal_sign'), false);
    assert.deepEqual(s.calls, []);
    await captureCard(s, 'offer');
    const readsBefore = s.walletMethods.filter((method) => method === 'eth_getBalance').length;
    await s.zap.locator(`[data-zap-amount="${USDG}"] input`).fill('60');
    await offer.locator('[data-funds-lack]').getByText('You need 60 USDG more on Robinhood Chain.', { exact: true }).waitFor();
    assert.equal(s.walletMethods.filter((method) => method === 'eth_getBalance').length, readsBefore, 'typing reuses the destination read');
    // Changed on purpose 2026-10-06: the networks show once Domino's service answered for them (here it reads none: each
    // keeps its button, the wallet's own read there).
    await offer.locator('[data-funds-network]').first().waitFor();
    assert.deepEqual(await offer.locator('[data-funds-network]').evaluateAll((els) => els.map((el) => [el.getAttribute('data-funds-network'), el.textContent.trim()])), [['8453', 'Base'], ['42161', 'Arbitrum One']]);
    assert.equal(await offer.locator('[data-funds-signin], #funds-origin-chain, [data-funds-scan]').count(), 0, 'no separate sign-in, no list of networks, no scan');
    assert.deepEqual(s.calls, [], 'nothing asked before the choice');
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

// Added 2026-10-06 (the review of 2026-10-06, its blocker: a US$100 position offered to bring all the ETH held elsewhere):
// what the position lacks is USDG, and only ETH is held on another network. The amount asked is about what it lacks,
// worked out at the prices Domino's service read, or, with none, from the first quote's own rate; never the balance.
const ARB_WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const ARB_USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const BASE_WETH = '0x4200000000000000000000000000000000000006';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
/** 0.02 ETH, and nothing else, on `chainId` as Domino's service reads it (Base's ETH is priced there; Arbitrum One's is not). */
const etherOnly = (chainId) => createChainReads({
  chainId,
  tokens: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: chainId === 8453 ? BASE_WETH : ARB_WETH, symbol: 'WETH', decimals: 18 }, { address: chainId === 8453 ? BASE_USDC : ARB_USDC, symbol: 'USDC', decimals: 6 }],
  balances: { [ZERO]: 20_000_000_000_000_000n },
});
const signInFromDialog = async (page) => {
  const dialog = page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForFunction(() => window.__dominoSessionProbe.view().status === 'signed_in');
  await page.keyboard.press('Escape');
};
const ALL_ETH = 20_000_000_000_000_000n - 500_000_000_000_000n; // 0.02 ETH less the gas Review keeps

test('ETH held on Base for the USDG the position lacks: one quote of about 50 USDG of ETH at the read prices, never all of it', async () => {
  const s = await openFunding({ served: etherOnly(8453) });
  try {
    const offer = s.zap.locator('[data-funds-offer][data-funds-mode="live"]');
    await offer.locator('[data-funds-network-holds="8453"]').waitFor({ timeout: 30_000 });
    await offer.locator('[data-funds-network="8453"]').click();
    await signInFromDialog(s.page);
    const quote = offer.locator('[data-funds-quote]');
    await quote.waitFor({ timeout: 30_000 });
    const asked = s.calls.filter((c) => c.route === 'quote').map((c) => c.body);
    assert.equal(asked.length, 1, 'the read prices sized it: one quote');
    assert.deepEqual([asked[0].originChainId, asked[0].originToken, asked[0].destinationToken], [8453, ZERO, USDG]);
    const sent = BigInt(asked[0].amountRaw);
    // 50 USDG at the fixtures' US$4,000.12 an ETH, with 2% room: about 0.01275 ETH.
    assert.ok(sent > 12_500_000_000_000_000n && sent < 13_000_000_000_000_000n, `about the need: ${sent}`);
    assert.ok(sent * 3n < ALL_ETH * 2n, 'never all of it');
    assert.match((await quote.locator('[data-funds-deposit-button]').innerText()).trim(), /^Bring 0\.0127\d* ETH from Base$/);
    assert.match((await quote.locator('[data-funds-receive] .dm-funds-delivery').innerText()).trim(), /^You receive about 50\.\d+ USDG on Robinhood Chain \(at least 50\.\d+ USDG\)$/, 'what arrives covers the 50 USDG');
    assert.equal(await offer.locator('[data-funds-short-holding]').count(), 0, 'enough there: nothing said about it');
    assert.equal(s.chain.sends.length, 0);
    await captureCard(s, 'other-kind');
  } finally { await s.close(); }
});

test('ETH held on Arbitrum One with no price read: all of it is quoted once, and the quote shown is sized from that rate', async () => {
  const s = await openFunding({ served: etherOnly(42161) });
  try {
    const offer = s.zap.locator('[data-funds-offer][data-funds-mode="live"]');
    await offer.locator('[data-funds-network-holds="42161"]').waitFor({ timeout: 30_000 });
    await offer.locator('[data-funds-network="42161"]').click();
    await signInFromDialog(s.page);
    const quote = offer.locator('[data-funds-quote]:not([aria-busy])');
    await s.page.waitForFunction(() => /^Bring 0\.01\d* ETH from Arbitrum One$/.test(document.querySelector('[data-funds-quote] [data-funds-deposit-button]')?.textContent?.trim() ?? ''), null, { timeout: 30_000 });
    const asked = s.calls.filter((c) => c.route === 'quote').map((c) => BigInt(c.body.amountRaw));
    assert.equal(asked.length, 2, 'a first quote, and one more: never a third');
    assert.equal(asked[0], ALL_ETH, 'the first: all that can be sent, its rate only');
    assert.ok(asked[1] > 12_000_000_000_000_000n && asked[1] < 13_500_000_000_000_000n, `the one shown: about the need at that rate, ${asked[1]}`);
    assert.equal(await quote.count(), 1);
    assert.equal(s.chain.sends.length, 0);
  } finally { await s.close(); }
});
