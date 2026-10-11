/** Real amount-step recovery with closed browser, wallet and HTTP fixtures. No live transactions. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeBrowser } from '../support/close-browser.mjs';
import { openFundingPage, USDG, ZERO, S2_OWNER, ARB_USDC, RECORDED_DEPOSIT, createChainReads, walletAssets, typeUsdg, signIn, homeReads, chainReads, together, offerReady } from '../support/funds-browser.mjs';
import { createOriginChain } from '../support/s2-origin-chain.mjs';
import { openJourney } from '../support/journey-browser.mjs';
import { createV2Chain, contractsFor, v3PoolOf } from '../support/v2-chain.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';
import { pressContinue } from '../support/new-position.mjs';

const require = createRequire(import.meta.url);
const { depositJournalKey } = require('../../.test-build/app/src/finance/v2/crosschain.js');
const fundingKey = `domino.funding.v1:${S2_OWNER}:4663`;
const shots = () => { const path = resolve(import.meta.dirname, '../../.test-artifacts'); mkdirSync(path, { recursive: true }); return path; };
const amount = (page) => page.locator('li[data-step="amount"] [data-pair-side="1"] input[inputmode="decimal"]');
let browser;
before(async () => {
  for (const options of process.env.DOMINO_BROWSER_PATH ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }] : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}]) {
    try { browser = await chromium.launch({ ...options, headless: true }); break; } catch {}
  }
  if (!browser) throw new Error('A Chromium browser is required.');
});
after(async () => closeBrowser(browser));

const pendingRecord = { provider: 'across', originChainId: 42161, destinationChainId: 4663, depositTxHash: RECORDED_DEPOSIT, requestId: null, lastState: 'pending' };
const journal = () => ({ key: depositJournalKey(4663, S2_OWNER), value: JSON.stringify([pendingRecord]) });
const restoredIntent = (state = 'sending') => ({ version: 1, id: 'accepted-before-reload', owner: S2_OWNER, destinationChainId: 4663, destinationToken: USDG,
  scope: 'previous-position', requiredRaw: '50000000', createdAt: 1791300000000,
  legs: [{ id: 'arb-usdc', originChainId: 42161, originToken: ARB_USDC, symbol: 'USDC', decimals: 6, maxInputRaw: '51000000', minimumOutputRaw: '50000000', destinationGas: false, state, depositTxHash: null }],
});

for (const state of ['ready', 'stopped']) {
  test(`an old ${state} plan with no submitted transaction is cleared before funding a new position`, async () => {
    const intent = { key: fundingKey, value: JSON.stringify(restoredIntent(state)) };
    const s = await openFundingPage(browser, { bridge: true, served: together(homeReads(), chainReads(42161, ARB_USDC)), intent });
    try {
      await typeUsdg(s, '20'); await signIn(s);
      await s.page.locator('[data-funding-state="ready"] [data-funds-deposit-button]').waitFor({ timeout: 30_000 });
      assert.equal(await s.page.evaluate((key) => localStorage.getItem(key), fundingKey), null, 'an unsent old plan is not retained as a transfer');
      assert.deepEqual(s.quotes().map((quote) => [quote.destinationToken, quote.amountRaw]), [[USDG, '20000000']]);
      assert.match(await s.page.locator('[data-funds-title]').innerText(), /Use your funds on Arbitrum One/);
      assert.doesNotMatch(await s.page.locator('[data-funds-offer]').innerText(), /Your transfer|already sent|On the way/);
      assert.match(await s.page.locator('[data-funds-lack]').innerText(), /20 USDG/);
      assert.equal(await amount(s.page).inputValue(), '20');
      assert.equal(s.wallet.calls('wallet_switchEthereumChain').length, 0);
      assert.equal(s.wallet.calls('wallet_sendCalls').length + s.wallet.calls('eth_sendTransaction').length, 0);
    } finally { await s.close(); }
  });
}

test('a restored fill refreshes the amount balance after the cache advances, while the wallet stays on its origin', async () => {
  const raw = { [ZERO]: 10n ** 16n, [USDG]: 0n };
  const destination = createChainReads({ chainId: 4663, tokens: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: USDG, symbol: 'USDG', decimals: 6 }], balances: raw });
  const combined = together(destination, chainReads(42161, ARB_USDC));
  let fresh = false, destinationReads = 0;
  const served = { answer(route, request) {
    const reply = combined.answer(route, request);
    if (!reply) return reply;
    if (route === 'chain-balances' && request.tokens.some((token) => token.chainId === 4663)) destinationReads++;
    if (fresh) reply.body = { ...reply.body, chains: reply.body.chains.map((chain) => chain.chainId !== 4663 || !chain.snapshot ? chain : { ...chain, snapshot: { ...chain.snapshot, number: chain.snapshot.number + 1, timestamp: chain.snapshot.timestamp + 1, hash: `0x${'ea'.repeat(32)}` } }) };
    return reply;
  } };
  const walletAssetsReply = () => {
    const body = JSON.parse(walletAssets(raw[ZERO]));
    body.items.find((item) => item.address === USDG).amountRaw = raw[USDG].toString();
    return JSON.stringify(body);
  };
  const s = await openFundingPage(browser, { bridge: true, served, journal: journal(), walletAssetsReply, clock: true });
  try {
    await typeUsdg(s, '50');
    await s.page.locator('[data-transfer-moving]').waitFor();
    assert.equal(await s.page.locator('[data-transfer-moving] .dm-transfer-track i').evaluate((el) => getComputedStyle(el).animationName), 'dm-transfer-travel');
    await s.page.emulateMedia({ reducedMotion: 'reduce' });
    assert.equal(await s.page.locator('[data-transfer-moving] .dm-transfer-track i').evaluate((el) => getComputedStyle(el).animationName), 'none');
    await s.page.locator('[data-funds-offer]').screenshot({ path: join(shots(), 'funds-transfer-in-progress.png'), animations: 'disabled' });
    await s.page.emulateMedia({ reducedMotion: 'no-preference' });
    await signIn(s);
    await s.page.locator('[data-funds-state="filled"] [data-funds-balance-state="updating"]').waitFor();
    await s.wallet.switchChain(42161);
    assert.equal(await s.page.locator('[data-funds-use]').count(), 0, 'the cached balance is not an arrival credit');
    const readsBefore = destinationReads;
    raw[USDG] = 100_000_000n; fresh = true;
    await s.page.clock.fastForward(11_100);
    await s.page.locator('[data-funds-balance-state="ready"]').waitFor({ timeout: 15_000 });
    assert.ok(destinationReads > readsBefore, 'arrival performs another read after the backend cache window');
    assert.match(await s.page.locator('[data-funds-state-text]').innerText(), /Funds arrived on Robinhood Chain/);
    assert.doesNotMatch(await s.page.locator('[data-funds-offer]').innerText(), /On the way|Settled/);
    assert.match(await s.page.locator('[data-funds-available]').innerText(), /100 USDG/);
    await s.page.locator('[data-funds-deposit] > details > summary').click();
    assert.match(await s.page.locator(`[data-funds-balance="${USDG}"]`).innerText(), /100/);
    await s.page.waitForFunction(() => document.querySelector('[data-pair-side="1"]')?.textContent?.includes('100'));
    assert.equal(await amount(s.page).inputValue(), '50', 'the original token amount survives arrival');
    assert.equal(s.wallet.state.chainId, 42161);
    assert.equal(s.wallet.calls('wallet_switchEthereumChain').length, 0, 'reading destination funds never switches the wallet back');
  } finally { await s.close(); }
});

test('a Base arrival keeps received status separate from spent USDC and offers only the remaining spendable ETH', async () => {
  const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const CAT = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const WETH = '0x4200000000000000000000000000000000000006';
  const pool = { dex: 3, currency0: USDC, currency1: CAT, fee: 3000, tickSpacing: 60, hooks: ZERO };
  const tick = 276320;
  const { sqrtPriceAtTick } = require('../../.test-build/app/src/finance/position.js');
  const pools = [{ pool, address: v3PoolOf(pool), sqrtPriceX96: sqrtPriceAtTick(tick), tick, liquidity: 10n ** 18n }];
  const raw = { [ZERO]: 800529491659974n, [USDC]: 1003048n, [CAT]: 0n, [WETH]: 0n };
  const tokens = [{ address: ZERO, symbol: 'ETH', name: 'Ether', decimals: 18 }, { address: USDC, symbol: 'USDC', name: 'USD Coin', decimals: 6 }, { address: CAT, symbol: 'CAT', name: 'Test Cat', decimals: 18 }, { address: WETH, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 }];
  const chain = createV2Chain({ chainId: 8453, pools, tokens, balances: raw });
  chain.switchTo(4663);
  const reads = createChainReads({ chainId: 8453, tokens, pools, balances: raw });
  let fresh = false, destinationReads = 0;
  const served = { answer(route, request) {
    const reply = reads.answer(route, request);
    if (route === 'chain-balances' && reply?.body?.chains) {
      destinationReads++;
      if (fresh) reply.body = { ...reply.body, chains: reply.body.chains.map((entry) => entry.chainId !== 8453 || !entry.snapshot ? entry : { ...entry, snapshot: { ...entry.snapshot, number: entry.snapshot.number + 1, timestamp: entry.snapshot.timestamp + 1, hash: `0x${'ea'.repeat(32)}` } }) };
    }
    return reply;
  } };
  const bridgeCalls = [];
  const routes = [async (request, url) => {
    if (url.pathname.startsWith('/api/read/v6/')) {
      const route = url.pathname.split('/').at(-1);
      const headers = { 'X-Domino-Read-Contract': '1.1.0-rc.1' };
      if (route === 'capabilities') return Response.json({ contractVersion: '1.1.0-rc.1', dataMode: 'live_read_only', chainIds: [4663, 8453, 42161], enabledReads: ['chain-balances'], walletAuthentication: false, privateAccounts: false, ownerTransactions: false, automation: false }, { headers });
      const reply = served.answer(route, await request.json());
      return Response.json(reply.body, { status: reply.status, headers });
    }
    if (url.pathname.startsWith('/api/crosschain/v1/')) {
      const route = url.pathname.split('/').at(-1);
      const headers = { 'X-Domino-Crosschain-Contract': '1.1.0-rc.1' };
      if (route === 'capabilities') return Response.json({ contractVersion: '1.1.0-rc.1', dataMode: 'live', enabledRoutes: ['origins', 'quote', 'status'] }, { headers });
      bridgeCalls.push(route);
      return Response.json({ error: 'route_not_available' }, { status: 404, headers });
    }
  }];
  const s = await openJourney(browser, chain, { dist: WALLET_V2_DIST, live: [8453], contracts: { 8453: contractsFor(8453) }, chainReads: served, routes, clock: true, artwork: true });
  try {
    const { page } = s;
    await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: depositJournalKey(8453, S2_OWNER), value: JSON.stringify([{ provider: 'relay', originChainId: 4663, destinationChainId: 8453, depositTxHash: RECORDED_DEPOSIT, requestId: `0x${'a1'.repeat(32)}`, lastState: 'filled' }]) });
    await page.reload();
    await page.getByRole('combobox', { name: 'Search a token' }).fill('coin');
    await page.locator(`[data-token-network-option="8453:${USDC}"]`).click({ timeout: 30_000 });
    await page.locator('[data-picker-network="8453"] input[name="pool-option"]').first().click();
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await pressContinue(current('pool')); await current('range').waitFor();
    await pressContinue(current('range')); await current('amount').waitFor();
    const typed = current('amount').locator('[data-pair-side="0"] input[inputmode="decimal"]');
    await typed.fill('0.1');
    await page.locator('[data-funds-state="filled"] [data-funds-balance-state="updating"]').waitFor();
    assert.match(await page.locator('[data-funds-state-text]').innerText(), /Funds arrived on Base/);
    assert.equal(await page.locator('[data-transfer-moving]').count(), 0, 'a confirmed arrival never keeps travelling');
    const before = destinationReads;
    raw[USDC] = 0n; fresh = true;
    await page.clock.fastForward(11_100);
    await page.locator('[data-funds-balance-state="ready"]').waitFor({ timeout: 15_000 });
    assert.ok(destinationReads > before);
    assert.equal(await typed.inputValue(), '0.1', 'arrival and a later spend do not resize the desired position');
    assert.match(await page.locator('[data-funds-available]').innerText(), /ETH/);
    assert.doesNotMatch(await page.locator('[data-funds-available]').innerText(), /USDC|0\.0008/);
    assert.doesNotMatch(await page.locator('[data-funds-offer]').innerText(), /On the way|Settled|1\.003048 USDC/);
    await page.locator('[data-funds-deposit] > details > summary').click();
    assert.equal((await page.locator(`[data-funds-balance="${USDC}"]`).innerText()).trim(), '0 USDC');
    assert.match(await page.locator(`[data-funds-balance="${ZERO}"]`).getAttribute('title'), /0\.000800529491659974 ETH/);
    assert.match(await page.locator('[data-funds-deposit] > details').innerText(), /current wallet balances, not transfer receipt amounts/);
    await page.locator('[data-funds-deposit] > details > summary').click();
    await page.locator('[data-funds-continuation]').waitFor();
    assert.match(await page.locator('[data-funds-continuation]').innerText(), /Use your ETH on Base/);
    assert.equal(await page.locator('[data-funds-nothing], [data-funds-signin], [data-funds-title]').count(), 0, 'verified arrival has one clear status and conversion action');
    await page.locator('[data-funds-offer]').screenshot({ path: join(shots(), 'funds-base-arrival-desktop.png'), animations: 'disabled' });
    assert.equal(s.planned.length, 0, 'an arrival does not quote or initiate a position');
    assert.deepEqual(bridgeCalls, [], 'restoring a known fill does not prepare another bridge');
    assert.equal(chain.chainNow(), 4663);
    assert.equal(chain.log.filter((method) => method === 'wallet_switchEthereumChain').length, 0);
    assert.equal(chain.sends.length, 0, 'nothing is approved or spent automatically');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('.dm-transfer-track i').evaluate((el) => getComputedStyle(el).animationName), 'none');
    await page.locator('[data-funds-offer]').screenshot({ path: join(shots(), 'funds-base-arrival-phone.png'), animations: 'disabled' });
  } finally { await s.close(); }
});

test('restored sending metadata stays unknown and cannot become another transfer after the position changed', async () => {
  const intent = { key: fundingKey, value: JSON.stringify(restoredIntent()) };
  const s = await openFundingPage(browser, { bridge: true, served: together(homeReads(), chainReads(42161, ARB_USDC)), intent });
  try {
    await typeUsdg(s, '20'); await signIn(s);
    await s.page.locator('[data-funding-leg-state="unknown"]').waitFor();
    assert.equal(await s.page.locator('[data-funds-deposit-button], [data-funds-use], [data-funding-review]').count(), 0);
    assert.equal(s.quotes().length, 0, 'an unknown accepted transfer is not replaced by a new quote');
    assert.equal(await amount(s.page).inputValue(), '20');
    assert.equal(JSON.parse(await s.page.evaluate((key) => localStorage.getItem(key), fundingKey)).legs[0].state, 'sending', 'restoring does not alter durable evidence');
  } finally { await s.close(); }
});

test('failure to persist an accepted plan pauses before any wallet network change or transaction', async () => {
  const s = await openFundingPage(browser, { bridge: true, served: together(homeReads(), chainReads(42161, ARB_USDC)) });
  try {
    const offer = await offerReady(s);
    await s.page.evaluate(() => {
      const save = Storage.prototype.setItem;
      Storage.prototype.setItem = function(key, value) {
        if (key.startsWith('domino.funding.v1:')) throw new DOMException('Storage is full', 'QuotaExceededError');
        return save.call(this, key, value);
      };
    });
    await offer.locator('[data-funds-deposit-button]').click();
    await s.page.locator('[data-funding-state="paused"]').waitFor();
    assert.match(await s.page.locator('[data-funds-run-notice]').innerText(), /paused|save/i);
    assert.equal(await amount(s.page).inputValue(), '50');
    assert.equal(s.wallet.calls('wallet_switchEthereumChain').length, 0);
    assert.equal(s.wallet.calls('eth_sendTransaction').length, 0);
    assert.equal(s.wallet.calls('wallet_sendCalls').length, 0);
  } finally { await s.close(); }
});

test('another tab recording an unknown transfer invalidates an already displayed proposal', async () => {
  const s = await openFundingPage(browser, { bridge: true, served: together(homeReads(), chainReads(42161, ARB_USDC)) });
  try {
    await offerReady(s);
    const other = await s.context.newPage();
    await other.goto(s.origin);
    await other.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: fundingKey, value: JSON.stringify(restoredIntent('unknown')) });
    await s.page.locator('[data-funding-leg-state="unknown"]').waitFor();
    assert.equal(await s.page.locator('[data-funds-deposit-button]').count(), 0, 'the old proposal can no longer be submitted');
    assert.equal(await amount(s.page).inputValue(), '50');
    assert.equal(s.wallet.calls('wallet_switchEthereumChain').length, 0);
    await other.close();
  } finally { await s.close(); }
});

test('an active transfer lock in another tab prevents a second wallet prompt for the same owner', async () => {
  const s = await openFundingPage(browser, { bridge: true, served: together(homeReads(), chainReads(42161, ARB_USDC)) });
  try {
    await offerReady(s);
    const other = await s.context.newPage();
    await other.goto(s.origin);
    await other.evaluate((owner) => {
      void navigator.locks.request(`domino-funding:${owner}`, async () => {
        window.__fundingLockHeld = true;
        await new Promise((resolve) => { window.__releaseFundingLock = resolve; });
      });
    }, S2_OWNER);
    await other.waitForFunction(() => window.__fundingLockHeld === true);
    await s.page.locator('[data-funds-deposit-button]').click();
    await s.page.locator('[data-error-code="funding_other_tab"]').waitFor();
    assert.equal(s.wallet.calls('wallet_switchEthereumChain').length, 0);
    assert.equal(s.wallet.calls('wallet_sendCalls').length + s.wallet.calls('eth_sendTransaction').length, 0);
    assert.equal(await s.page.evaluate((key) => localStorage.getItem(key), fundingKey), null, 'the busy attempt never persists a competing plan');
    await other.evaluate(() => window.__releaseFundingLock());
    await other.close();
  } finally { await s.close(); }
});

test('confirmed Ethereum gas shortage offers one reviewed alternative, never silently sending from another origin', async () => {
  const ETH_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const origin = createOriginChain({ owner: S2_OWNER, chainId: 1, gasPrice: 22_000_000_000n });
  const s = await openFundingPage(browser, { bridge: true, switching: true, sendOn: origin,
    balances: { native: { 1: 10_000_000_000_000n }, tokens: { [`1:${ETH_USDC}`]: { balance: 200_000_000n, decimals: 6 } } },
    served: together(homeReads(), chainReads(1, ETH_USDC, 200_000_000n, 10_000_000_000_000n), chainReads(42161, ARB_USDC)),
  });
  try {
    await offerReady(s);
    assert.match(await s.page.locator('[data-funds-title]').innerText(), /Ethereum/);
    await s.page.locator('[data-funds-deposit-button]').click();
    await s.page.locator('[data-funds-gas-review]').waitFor();
    assert.equal(await s.page.locator('[data-funds-deposit-button]').count(), 0, 'the failed route cannot be retried unchanged');
    assert.equal(origin.state.sent.length, 0, 'gas failure was confirmed before submission');
    const before = JSON.parse(await s.page.evaluate((key) => localStorage.getItem(key), fundingKey));
    assert.deepEqual(before.gasRecovery, { mode: 'token', reviewNeeded: true });
    await s.page.locator('[data-funds-gas-review]').click();
    await s.page.getByRole('button', { name: 'Use this updated transfer', exact: true }).waitFor();
    assert.equal(await s.page.locator('[data-funding-sources]').getAttribute('data-funding-sources'), '1');
    assert.equal(await s.page.locator('[data-funds-network]').getAttribute('data-funds-network'), '42161');
    assert.equal(await amount(s.page).inputValue(), '50');
    assert.equal(s.wallet.state.chainId, 1, 'reviewing another source does not change the wallet network');
    assert.equal(origin.state.sent.length, 0);
    assert.deepEqual(JSON.parse(await s.page.evaluate((key) => localStorage.getItem(key), fundingKey)), before, 'a revised proposal is not a new authorization');
  } finally { await s.close(); }
});

test('keeping more ETH cannot silently reduce the position amount when no funding alternative covers it', async () => {
  const ETH_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
  const eth = 18_000_000_000_000_000n;
  const origin = createOriginChain({ owner: S2_OWNER, chainId: 1, gasPrice: 22_000_000_000n, estimate: 110_000n });
  const s = await openFundingPage(browser, { bridge: true, switching: true, sendOn: origin, balances: { native: { 1: eth } },
    served: together(homeReads(), chainReads(1, ETH_USDC, 0n, eth)),
  });
  try {
    await offerReady(s);
    await s.page.locator('[data-funds-deposit-button]').click();
    await s.page.locator('[data-funds-gas-review]').waitFor();
    const quoteCount = s.quotes().length;
    await s.page.locator('[data-funds-gas-review]').click();
    await s.page.locator('[data-error-code="funding_gas_retry"]').waitFor();
    assert.match(await s.page.locator('[data-funds-run-notice]').innerText(), /Keeping more ETH/);
    assert.equal(await s.page.locator('[data-funds-deposit-button]').count(), 0);
    assert.equal(await amount(s.page).inputValue(), '50');
    assert.ok(s.quotes().slice(quoteCount).filter((q) => q.originChainId === 1).every((q) => BigInt(q.maxInputRaw ?? q.amountRaw) <= 12_000_000_000_000_000n));
    assert.equal(origin.state.sent.length, 0);
  } finally { await s.close(); }
});
