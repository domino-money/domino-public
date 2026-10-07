/** Real amount-step recovery with closed browser, wallet and HTTP fixtures. No live transactions. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeBrowser } from '../support/close-browser.mjs';
import { openFundingPage, USDG, ZERO, S2_OWNER, ARB_USDC, RECORDED_DEPOSIT, createChainReads, walletAssets, typeUsdg, signIn, homeReads, chainReads, together, offerReady } from '../support/funds-browser.mjs';

const require = createRequire(import.meta.url);
const { depositJournalKey } = require('../../.test-build/app/src/finance/v2/crosschain.js');
const fundingKey = `domino.funding.v1:${S2_OWNER}:4663`;
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
    await signIn(s);
    await s.page.locator('[data-funds-state="filled"] [data-funds-balance-state="updating"]').waitFor();
    await s.wallet.switchChain(42161);
    assert.equal(await s.page.locator('[data-funds-use]').count(), 0, 'the cached balance is not an arrival credit');
    const readsBefore = destinationReads;
    raw[USDG] = 100_000_000n; fresh = true;
    await s.page.clock.fastForward(11_100);
    await s.page.locator('[data-funds-balance-state="ready"]').waitFor({ timeout: 15_000 });
    assert.ok(destinationReads > readsBefore, 'arrival performs another read after the backend cache window');
    assert.match(await s.page.locator(`[data-funds-balance="${USDG}"]`).innerText(), /100/);
    await s.page.waitForFunction(() => document.querySelector('[data-pair-side="1"]')?.textContent?.includes('100'));
    assert.equal(await amount(s.page).inputValue(), '50', 'the original token amount survives arrival');
    assert.equal(s.wallet.state.chainId, 42161);
    assert.equal(s.wallet.calls('wallet_switchEthereumChain').length, 0, 'reading destination funds never switches the wallet back');
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
