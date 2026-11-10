/**
 * The owner's position actions in the page (components/positions/PositionActions.tsx, HeldDeposits.tsx), on the
 * wallet-test build, mounted alone through its test-only lab route (#/position-lab/<spec>, screens/PositionLab.tsx)
 * with the props a Positions screen passes. The wallet is tests/support/position-chain.mjs announced through
 * EIP-6963: it answers the reads, simulations and sends, and its PositionManager and StateView carry their real
 * runtime code. Connected, never signed in: the actions need no Domino session.
 *
 * What is held here: the exact calldata the PositionManager receives for Collect fees and Close position (value 0,
 * one transaction each), that a rejection in the wallet sends nothing more, that the refund of a held deposit is
 * DominoSetupV1.cancel(operationId), and that the dialogs say what the owner receives in plain words.
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeBrowser } from './support/close-browser.mjs';
import { decodeAbiParameters, decodeFunctionData, encodeFunctionData } from 'viem';
import { browserChain, poolIdOf, routeChain } from './support/browser-chain.mjs';
import { createFakeSession } from './support/fake-session.mjs';
import { installWallets } from './support/mock-wallet.mjs';
import { POSITION_MANAGER, createPositionChain } from './support/position-chain.mjs';
import { createWalletServer } from './support/wallet-server.mjs';

const require = createRequire(import.meta.url);
// The client under test, from the unit build (npm test compiles it first, as check:app runs it first).
const position = require('../.test-build/app/src/finance/position.js');
const { setupAbi } = require('../.test-build/app/src/finance/setup.js');

let browser;
before(async () => {
  for (const options of process.env.DOMINO_BROWSER_PATH ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }] : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}]) {
    try { browser = await chromium.launch({ ...options, headless: true }); break; } catch {}
  }
  if (!browser) throw new Error('A Chromium browser is required.');
});
after(async () => { await closeBrowser(browser); });

/** What the product rules keep off these screens (finance.browser.test.mjs FORBIDDEN), and no sample or practice wording. */
const FORBIDDEN = /not connected yet|not enabled|isn’t enabled|isn't enabled|aren't enabled|not available on this deployment|coming soon|in this release|\bbeta\b|\balpha\b|\bv4\b|read-only|temporarily unavailable|retry after|Last read|sample|practice/i;
const shots = () => { const dir = resolve(import.meta.dirname, '../.test-artifacts'); mkdirSync(dir, { recursive: true }); return dir; };

const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168', UFG = '0xefab538cf3c29237a47c6afb145d50ddf204a0a3';
const TIMESTAMP = 1_790_000_000;
/** NFT 3135288's pool and range as read on mainnet, here this wallet's, with fees earned since its last update. */
const NFT = { tokenId: 3135288n, key: { currency0: USDG, currency1: UFG, fee: 792831, tickSpacing: 9303, hooks: '0x0000000000000000000000000000000000000000' },
  tickLower: 334908, tickUpper: 353514, liquidity: 52252322368158n, sqrtPriceX96: 1975446435897848877405867861624282655n, tick: 340651,
  growthLast: [5n << 128n, 7n << 128n] };
NFT.growthNow = [NFT.growthLast[0] + (1234n << 128n) / NFT.liquidity + 1n, NFT.growthLast[1] + ((5n * 10n ** 17n) << 128n) / NFT.liquidity + 1n];
const FEES = [0, 1].map((i) => position.feesOwed(NFT.growthNow[i], NFT.growthLast[i], NFT.liquidity));
const CURRENCIES = [{ address: USDG, symbol: 'USDG', decimals: 6 }, { address: UFG, symbol: 'UFG', decimals: 18 }];
/** The props a Positions screen passes for this NFT, as the read service reported it. */
const actionsFor = (overrides = {}) => ({ tokenId: '3135288', owner: OWNER, liquidityRaw: String(NFT.liquidity), unsettledFeesRaw: FEES.map(String), currencies: CURRENCIES, hooks: NFT.key.hooks, ...overrides });

/** The chain above announced as a browser wallet of its own (EIP-6963), passing on a refusal's code and revert data as wallets do. */
async function installPositionWallet(context, chain) {
  await context.exposeFunction('__dominoPositionWallet', (method, params) => chain.request(method, params));
  await context.addInitScript(() => {
    const provider = {
      async request({ method, params }) {
        const reply = await window.__dominoPositionWallet(method, params ?? []);
        if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code, data: reply.error.data });
        return reply.result;
      },
      on() { return provider; },
      removeListener() { return provider; },
    };
    const detail = Object.freeze({ info: Object.freeze({ uuid: '8f2a7d1c-0000-4000-8000-0000000000e1', name: 'Position Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E', rdns: 'test.wallet.position' }), provider });
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  });
}

/**
 * The wallet-test build at the lab with `spec`, the chain connected on Robinhood Chain and not signed in. `hash`: a
 * route of the app instead of the lab (2026-09-25: a position's own page); `rpc`: the public RPC the page reads, an empty
 * chain unless given.
 */
async function atLab(chain, spec, { hash = null, rpc: chainRpc = undefined } = {}) {
  const fake = createFakeSession();
  const releases = [], errors = [];
  const server = createWalletServer({ fake, routes: [async (request, url) => {
    if (url.pathname !== '/api/setup/v1/release') return undefined;
    releases.push(request.headers.get('X-Domino-Setup-Contract'));
    // `chain.release = null`: no release Worker on the route, so the page fallback answers, as for a route not bound yet.
    if (chain.release === null) return undefined;
    return new Response(JSON.stringify(chain.release), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Domino-Setup-Contract': '1.0.0-rc.1' } });
  }] });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`; fake.origin = origin;
  const context = await browser.newContext({ viewport: { width: 1180, height: 900 } });
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  // 2026-09-25: the page reads Robinhood Chain's public RPC itself (the wallet's positions on Positions and on the
  // automation page, a position's state, the fees history), since the RPC rate-limits Cloudflare's edge. That one host
  // is answered here by an empty chain (tests/support/browser-chain.mjs): no position, no deposit, every NFT unknown,
  // as the site's routes answered before; a request the CSP refused never reaches it.
  const rpc = await routeChain(context, chainRpc);
  const wallets = await installWallets(context);
  await installPositionWallet(context, chain);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const s = { page, chain, releases, fake, async close() {
    await context.close(); await server.closeAll();
    assert.deepEqual(errors, []); assert.deepEqual(wallets.state.csp, []); assert.deepEqual(wallets.state.refused, []);
    assert.deepEqual(chain.refused, [], 'every method asked is one this wallet answers');
    assert.deepEqual(chain.missing, [], 'every call reached a contract that answers it');
    assert.ok(!chain.log.includes('personal_sign'), 'nothing is signed in');
    assert.deepEqual([rpc.errors, rpc.refused, rpc.missing], [[], [], []], 'the public RPC was asked only what it answers');
  } };
  try {
    if (hash) await page.goto(`${origin}/#${hash}`);
    else {
      await page.goto(`${origin}/#/position-lab/${encodeURIComponent(JSON.stringify(spec))}`);
      await page.locator('[data-position-lab="ready"]').waitFor();
    }
    await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await page.locator('header [aria-haspopup="dialog"]').click();
    await page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Connect Position Wallet', exact: true }).click();
    await page.waitForFunction(() => ['signed_out', 'wrong_network'].includes(window.__dominoSessionProbe?.view().status));
    await page.keyboard.press('Escape');
    return s;
  } catch (error) { await s.close().catch(() => {}); throw error; }
}
const chainFor = (options = {}) => createPositionChain(OWNER, { timestamp: TIMESTAMP, positions: [{ ...NFT, ...options.position }], deposits: options.deposits ?? [], finality: options.finality });
/** A wallet initially on Base/Arbitrum. It deliberately omits chainChanged, as some injected wallets do. */
function networkWallet(chain, initial, outcomes = []) {
  const request = chain.request;
  let network = initial;
  chain.request = async (method, params) => {
    if (method === 'eth_chainId') { chain.log.push(method); return { result: `0x${network.toString(16)}` }; }
    if (method === 'wallet_switchEthereumChain') {
      chain.log.push(method);
      const next = outcomes.shift();
      const outcome = typeof next === 'function' ? await next() : next;
      if (outcome) return { error: { code: outcome, message: 'Network change declined or pending.' } };
      network = Number(params[0].chainId);
      return { result: null };
    }
    return request(method, params);
  };
  return chain;
}

test('position actions stay visible on Base and Arbitrum; an intentional collect switches and reads before any send', async () => {
  for (const network of [8453, 42161]) {
    const chain = networkWallet(chainFor(), network);
    const s = await atLab(chain, { position: actionsFor() });
    try {
      await s.page.locator('[data-position-action="collect"]').waitFor();
      await s.page.locator('[data-position-action="close"]').waitFor();
      assert.equal(chain.log.includes('wallet_switchEthereumChain'), false, 'visiting does not switch the wallet');
      await s.page.locator('[data-position-action="collect"]').click();
      const dialog = s.page.locator('[data-position-dialog="collect"]');
      await dialog.locator('[data-position-send="collect"]:not([disabled])').waitFor();
      assert.equal(chain.log.filter(method => method === 'wallet_switchEthereumChain').length, 1);
      assert.deepEqual(chain.sends, [], 'network switch and fresh review never send');
      assert.match(await text(dialog.locator('[data-position-receive]')), /0\.001234 USDG/);
      await dialog.locator('[data-position-send="collect"]').click();
      await dialog.locator('[data-position-progress="done"]').waitFor();
      assert.equal(chain.sends.length, 1, 'only the separate reviewed confirmation sends');
    } finally { await s.close(); }
  }
});

test('a refused network switch keeps the position dialog and offers a working retry without another transaction', async () => {
  const chain = networkWallet(chainFor(), 8453, [4001]);
  const s = await atLab(chain, { position: actionsFor() });
  try {
    await s.page.locator('[data-position-action="close"]').click();
    const dialog = s.page.locator('[data-position-dialog="close"]');
    await dialog.locator('[data-position-notice="position_network_user_rejected"]').waitFor();
    assert.match(await text(dialog), /Your wallet declined the network switch/);
    assert.deepEqual(chain.sends, []);
    await dialog.locator('[data-position-retry]').click();
    await dialog.locator('[data-position-send="close"]:not([disabled])').waitFor();
    assert.equal(chain.log.filter(method => method === 'wallet_switchEthereumChain').length, 2);
    assert.deepEqual(chain.sends, [], 'retry only prepares the review');
  } finally { await s.close(); }
});

test('a pending network switch explains the wallet request; dismissing it cancels further preparation', async () => {
  let finish;
  const waiting = new Promise(resolve => { finish = resolve; });
  const chain = networkWallet(chainFor(), 8453, [() => waiting]);
  const s = await atLab(chain, { position: actionsFor() });
  try {
    await s.page.locator('[data-position-action="collect"]').click();
    const dialog = s.page.locator('[data-position-dialog="collect"]');
    await dialog.locator('[data-position-progress="switching"]').waitFor();
    assert.match(await text(dialog), /Switch to Robinhood Chain in your wallet/);
    assert.equal(await dialog.locator('[data-position-send="collect"]').isDisabled(), true);
    assert.equal(await s.page.locator('[data-position-action="close"]').isDisabled(), true, 'another action cannot replace a pending wallet intent');
    await dialog.screenshot({ path: join(shots(), 'position-network-pending.png') });
    await s.page.keyboard.press('Escape');
    finish(null);
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
    assert.equal(chain.log.includes('eth_call'), false, 'dismissed intent performs no position preparation');
    assert.deepEqual(chain.sends, []);
    await s.page.locator('[data-position-action="collect"]').waitFor();
  } finally { finish(null); await s.close(); }
});

test('the Robinhood position page retains the owner action row while the connected wallet is on Base', async () => {
  const chain = networkWallet(chainFor(), 8453);
  const rpc = browserChain({
    positions: [{ tokenId: '3135288', holder: OWNER, key: NFT.key, tickLower: NFT.tickLower, tickUpper: NFT.tickUpper, liquidity: NFT.liquidity, unclaimed: FEES }],
    pools: { [poolIdOf(NFT.key)]: { sqrtPriceX96: NFT.sqrtPriceX96, tick: NFT.tick } },
    tokens: { [USDG]: { symbol: 'USDG', decimals: 6 }, [UFG]: { symbol: 'UFG', decimals: 18 } },
  });
  const s = await atLab(chain, null, { hash: '/positions/3135288', rpc });
  try {
    await s.page.locator('[data-position-detail] [data-position-action="collect"]').waitFor();
    await s.page.locator('[data-position-detail] [data-position-action="close"]').waitFor();
    assert.equal(chain.log.includes('wallet_switchEthereumChain'), false);
    assert.deepEqual(chain.sends, []);
  } finally { await s.close(); }
});
const text = (locator) => locator.innerText();
/** The one transaction sent, decoded: where it went, with what value, and the DECREASE / TAKE_PAIR it carries. */
function sentStep(chain) {
  assert.equal(chain.sends.length, 1, 'one transaction');
  const [tx] = chain.sends;
  const { args: [unlockData, deadline] } = decodeFunctionData({ abi: position.positionManagerAbi, data: tx.data });
  const [actions, params] = decodeAbiParameters(position.unlockParameters, unlockData);
  return { tx, deadline, actions, decrease: decodeAbiParameters(position.decreaseParameters, params[0]), take: decodeAbiParameters(position.takePairParameters, params[1]).map((address) => address.toLowerCase()) };
}

test('Collect fees reads the position through the wallet, says what it pays, and sends DECREASE 0 + TAKE_PAIR to the PositionManager', async () => {
  const chain = chainFor();
  const s = await atLab(chain, { position: actionsFor() });
  try {
    const collect = s.page.locator('[data-position-action="collect"]'), close = s.page.locator('[data-position-action="close"]');
    assert.deepEqual([await text(collect), await text(close)], ['Collect fees', 'Close position']);
    assert.deepEqual(chain.log.filter((m) => m === 'eth_call'), [], 'nothing is read before a press');
    await collect.click();
    const dialog = s.page.locator('[role="dialog"][data-position-dialog="collect"]');
    await dialog.locator('[data-position-send="collect"]:not([disabled])').waitFor();
    assert.equal(await text(dialog.locator('h2')), 'Collect fees');
    const receive = await text(dialog.locator('[data-position-receive] > div').first());
    assert.match(receive, /^You receive\s+0\.001234 USDG\s+0\.5 UFG$/, 'the fees as the chain has them now');
    assert.match(await text(dialog.locator('[data-position-network-fee]')), /^Network fee\s+Up to 0\.000048 ETH$/, '240,000 gas at twice the gas price');
    assert.equal(await dialog.locator('[data-position-warning]').count(), 0);
    assert.doesNotMatch(await text(dialog), FORBIDDEN);
    assert.equal(await dialog.getByRole('button', { name: /retry|try again/i }).count(), 0, 'no Retry');
    await s.page.screenshot({ path: join(shots(), 'position-collect.png') });
    assert.deepEqual(chain.sends, [], 'nothing is sent by opening the dialog');

    await dialog.getByRole('button', { name: 'Collect in wallet', exact: true }).click();
    await dialog.locator('[data-position-progress="done"]').waitFor({ timeout: 30_000 });
    assert.equal(await text(dialog.locator('[data-position-progress]')), 'Done');
    const { tx, deadline, actions, decrease, take } = sentStep(chain);
    assert.deepEqual([tx.to, tx.value, tx.from, tx.chainId, tx.type], [POSITION_MANAGER, '0x0', OWNER, '0x1237', '0x2']);
    assert.equal(deadline, BigInt(TIMESTAMP) + 480n, 'the latest block’s time plus the signing window and inclusion room');
    assert.equal(tx.data, position.collectData(NFT.tokenId, USDG, UFG, OWNER, deadline), 'byte for byte');
    assert.deepEqual([actions, decrease, take], ['0x0111', [NFT.tokenId, 0n, 0n, 0n, '0x'], [USDG, UFG, OWNER]]);
    assert.deepEqual(chain.paid, [{ to: OWNER, currencies: [USDG, UFG], amounts: FEES }]);
    await s.page.locator('[data-position-lab][data-changes="1"]').waitFor();
    assert.equal(s.releases.length, 0, 'no Domino service was asked');
    await dialog.getByRole('button', { name: 'Back to position', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
  } finally { await s.close(); }
});

test('Close position removes all of the liquidity with minimums from the slippage chosen, pays principal and fees, and keeps the NFT', async () => {
  const chain = chainFor();
  const s = await atLab(chain, { position: actionsFor() });
  try {
    await s.page.locator('[data-position-action="close"]').click();
    const dialog = s.page.locator('[role="dialog"][data-position-dialog="close"]');
    await dialog.locator('[data-position-send="close"]:not([disabled])').waitFor();
    const principal = position.principalAt(NFT.sqrtPriceX96, NFT.tick, NFT.tickLower, NFT.tickUpper, NFT.liquidity);
    assert.deepEqual(principal, [994039n, 325205393406295768765n]);
    assert.match(await text(dialog.locator('[data-position-receive] > div').first()), /^You receive\s+0\.995273 USDG\s+325\.705 UFG$/, 'principal and fees');
    // At the default 0.5%: the band minimums proven on mainnet, plus the fees.
    assert.match(await text(dialog.locator('[data-position-at-least]')), /^At least\s+0\.990047 USDG\s+322\.448 UFG$/);
    assert.equal(await dialog.locator('[data-slippage-choice]').getAttribute('data-slippage-bps'), '50');
    // Changed on purpose 2026-10-01 (audit E5): the slippage tolerance is under the dialog's closed Advanced, as on New position.
    assert.equal(await dialog.locator('[data-close-advanced]').getAttribute('open'), null, 'closed until opened');
    await dialog.locator('[data-close-advanced] > summary').click();
    // Changed on purpose 2026-10-06 (the owner's point 4: one rule everywhere): above 2% the spec's one sentence, as
    // New position and Domino V2's dialogs say it; 1% is no longer warned about.
    await dialog.locator('#close-slippage-exact').fill('3');
    assert.equal(await text(dialog.locator('[data-slippage-warning]')), 'High slippage: you may receive noticeably less than quoted.');
    await dialog.locator('[data-slippage-preset="100"]').click();
    assert.equal(await dialog.locator('[data-slippage-warning]').count(), 0, '1% is not warned about');
    const minimums = position.closeMinimums(NFT.sqrtPriceX96, NFT.tickLower, NFT.tickUpper, NFT.liquidity, 100);
    assert.match(await text(dialog.locator('[data-position-at-least]')), /^At least\s+0\.98\d+ USDG\s+319\.\d+ UFG$/, 'the minimums follow the limit chosen');
    assert.doesNotMatch(await text(dialog), FORBIDDEN);
    await s.page.screenshot({ path: join(shots(), 'position-close.png') });

    await dialog.getByRole('button', { name: 'Close in wallet', exact: true }).click();
    await dialog.locator('[data-position-progress="done"]').waitFor({ timeout: 30_000 });
    const { tx, deadline, actions, decrease, take } = sentStep(chain);
    assert.deepEqual([tx.to, tx.value], [POSITION_MANAGER, '0x0']);
    assert.equal(tx.data, position.closeData(NFT.tokenId, NFT.liquidity, minimums[0], minimums[1], USDG, UFG, OWNER, deadline), 'byte for byte, at 1%');
    assert.deepEqual([actions, decrease, take], ['0x0111', [NFT.tokenId, NFT.liquidity, minimums[0], minimums[1], '0x'], [USDG, UFG, OWNER]]);
    assert.deepEqual(chain.paid, [{ to: OWNER, currencies: [USDG, UFG], amounts: [principal[0] + FEES[0], principal[1] + FEES[1]] }]);
    assert.equal(chain.nft(NFT.tokenId).liquidity, 0n, 'the NFT stays, empty');
    await s.page.locator('[data-position-lab][data-changes="1"]').waitFor();
  } finally { await s.close(); }
});

test('a rejection in the wallet sends nothing more and says so; a price that moves before the send is refused in words', async () => {
  const chain = chainFor();
  const s = await atLab(chain, { position: actionsFor() });
  try {
    await s.page.locator('[data-position-action="collect"]').click();
    const dialog = s.page.locator('[role="dialog"][data-position-dialog="collect"]');
    await dialog.locator('[data-position-send="collect"]:not([disabled])').waitFor();
    chain.decline();
    await dialog.getByRole('button', { name: 'Collect in wallet', exact: true }).click();
    await dialog.locator('[data-position-notice="declined"]').waitFor({ timeout: 30_000 });
    assert.equal(await text(dialog.locator('[data-position-notice]')), 'You declined in your wallet. Nothing was sent.');
    assert.deepEqual([chain.sends.length, chain.declined.length], [0, 1]);
    const asked = chain.log.length;
    await s.page.waitForTimeout(2500);
    assert.equal(chain.log.length, asked, 'nothing more reached the wallet after the rejection');
    assert.equal(chain.log.filter((m) => m === 'eth_sendTransaction').length, 1);
    assert.equal(await s.page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith('domino.offered-nonce.v1.')).length), 0, 'the nonce claim was released');
    assert.equal(await dialog.getByRole('button', { name: /retry/i }).count(), 0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    // The price leaves the band between the press's read and the send: the send's own simulation refuses it.
    await s.page.locator('[data-position-action="close"]').click();
    const closing = s.page.locator('[role="dialog"][data-position-dialog="close"]');
    await closing.locator('[data-position-send="close"]:not([disabled])').waitFor();
    chain.once('eth_estimateGas', () => chain.move(NFT.tokenId, (NFT.sqrtPriceX96 * 98n) / 100n, NFT.tick - 405));
    await closing.getByRole('button', { name: 'Close in wallet', exact: true }).click();
    await closing.locator('[data-position-notice="position_price_moved"]').waitFor({ timeout: 30_000 });
    assert.equal(await text(closing.locator('[data-position-notice]')), 'The price moved past your slippage limit. Nothing was sent. Raise the limit, or try again.');
    assert.deepEqual([chain.sends.length, chain.declined.length], [0, 1], 'nothing was offered to the wallet');
  } finally { await s.close(); }
});

test('Refund to wallet sends DominoSetupV1.cancel for the held deposit and reads the page again', async () => {
  const chain = chainFor({ deposits: [{ key: { currency0: USDG, currency1: UFG, fee: 792831, tickSpacing: 9303 }, balance0: 100000n, balance1: 0n }] });
  const operationId = chain.operationId(0n);
  const held = { owner: OWNER, deposits: [{ operationId, currency0: USDG, currency1: UFG, fee: 792831, tickSpacing: 9303, hooks: NFT.key.hooks, balance0: '100000', balance1: '0', currencies: CURRENCIES }] };
  const s = await atLab(chain, { held });
  try {
    const card = s.page.locator('[data-held-deposits]');
    assert.equal(await text(card.locator('h2')), 'Deposits not yet in a position');
    assert.match(await text(card.locator(`[data-held-deposit="${operationId}"]`)), /USDG \/ UFG\s+0\.1 USDG · 0 UFG\s+Refund to wallet/);
    assert.doesNotMatch(await text(card), FORBIDDEN);
    await s.page.screenshot({ path: join(shots(), 'position-held-deposit.png') });
    await card.getByRole('button', { name: 'Refund to wallet', exact: true }).click();
    await card.locator('[data-held-progress="done"]').waitFor({ timeout: 30_000 });
    assert.equal(await text(card.locator('[data-held-progress]')), 'Refunded to your wallet');
    assert.equal(chain.sends.length, 1);
    const [tx] = chain.sends;
    assert.deepEqual([tx.to, tx.value, tx.from], [chain.setup, '0x0', OWNER]);
    assert.equal(tx.data, encodeFunctionData({ abi: setupAbi, functionName: 'cancel', args: [operationId] }), 'cancel(operationId), byte for byte');
    assert.deepEqual(chain.paid, [{ to: OWNER, currencies: [USDG, UFG], amounts: [100000n, 0n] }]);
    assert.deepEqual(s.releases, ['1.0.0-rc.1'], 'the published setup profile, read once');
    await s.page.locator('[data-position-lab][data-changes="1"]').waitFor();
    assert.equal(await card.getByRole('button', { name: 'Refund to wallet' }).count(), 0);
    assert.deepEqual(await s.page.evaluate(() => JSON.parse(localStorage.getItem('domino.setup.public-recovery.v1'))), chain.release,
      'the profile the wallet just verified, kept for a refund while none is published');
  } finally { await s.close(); }
});

test('Refund to wallet needs no published release: the profile this browser saved is used, and without one the page says what stays true', async () => {
  const chain = chainFor({ deposits: [{ key: { currency0: USDG, currency1: UFG, fee: 792831, tickSpacing: 9303 }, balance0: 100000n, balance1: 0n }] });
  const operationId = chain.operationId(0n);
  const held = { owner: OWNER, deposits: [{ operationId, currency0: USDG, currency1: UFG, fee: 792831, tickSpacing: 9303, hooks: NFT.key.hooks, balance0: '100000', balance1: '0', currencies: CURRENCIES }] };
  const published = chain.release;
  const off = { contractVersion: '1.0.0-rc.1', chainId: 4663, available: false, deployment: null };
  const s = await atLab(chain, { held });
  try {
    const card = s.page.locator('[data-held-deposits]');
    const refund = card.getByRole('button', { name: 'Refund to wallet', exact: true });
    const notice = card.locator('[data-held-notice]');
    // Switched off, and no profile saved in this browser: nothing can be prepared here, and pressing again would not change that.
    chain.release = off;
    await refund.click();
    await card.locator('[data-held-notice="release_not_available"]').waitFor({ timeout: 30_000 });
    // Changed on purpose (2026-09-25, audit of 754014c): the notice no longer sends anyone to "Setup’s owner recovery".
    // That page offers no recovery in this state (with no release and no saved profile it renders nothing to do), or else
    // the raw Network budget and Operation ID form. The notice's own words stay, and nothing on the card links away.
    assert.equal(await text(notice), 'The refund can’t be prepared on this page right now. Nothing was sent: your deposit stays held and refundable.');
    assert.equal(await card.locator('a').count(), 0, 'no link on the card, to Setup or anywhere');
    assert.doesNotMatch(await text(card), /owner recovery|Setup/);
    assert.doesNotMatch(await text(card), FORBIDDEN);
    assert.deepEqual([chain.sends.length, chain.log.includes('eth_sendTransaction')], [0, false], 'nothing was offered to the wallet');
    // No release Worker answering at all: that may pass, so this one says try again.
    chain.release = null;
    await refund.click();
    await card.locator('[data-held-notice="route_missing"]').waitFor({ timeout: 30_000 });
    assert.equal(await text(notice), 'The deployment could not be confirmed just now. Nothing was sent. Try again in a moment.');
    assert.equal(chain.sends.length, 0);
    // The profile this browser saved when a wallet last verified it, a day past its expiry, while the release is off:
    // checked on chain through the wallet, and the refund is cancel(operationId).
    chain.release = off;
    await s.page.evaluate((saved) => localStorage.setItem('domino.setup.public-recovery.v1', JSON.stringify(saved)),
      { ...published, deployment: { ...published.deployment, expiresAt: Math.floor(Date.now() / 1000) - 86_400 } });
    await refund.click();
    await card.locator('[data-held-progress="done"]').waitFor({ timeout: 30_000 });
    assert.equal(chain.sends.length, 1);
    const [tx] = chain.sends;
    assert.deepEqual([tx.to, tx.value, tx.from], [chain.setup, '0x0', OWNER]);
    assert.equal(tx.data, encodeFunctionData({ abi: setupAbi, functionName: 'cancel', args: [operationId] }), 'cancel(operationId), byte for byte');
    assert.deepEqual(chain.paid, [{ to: OWNER, currencies: [USDG, UFG], amounts: [100000n, 0n] }]);
    assert.ok(chain.log.includes('eth_getCode'), 'the saved profile is checked on chain');
    assert.equal(s.releases.length, 3, 'the release is asked at each press');
    await s.page.locator('[data-position-lab][data-changes="1"]').waitFor();
  } finally { await s.close(); }
});

// 2026-10-01 (audit C14): a refund, a collect or a close the person replaced in the wallet ("Speed up" or "Cancel") is known
// within seconds by its nonce (the chain does not know the hash the page was given, and the account has mined past it), and
// the chain read again says whether it happened. They used to be watched as pending for five minutes. Nothing is ever sent
// again for a replaced step: the next press reviews anew.
test('a refund sped up in the wallet reads refunded within seconds; one cancelled says the deposit is still held, and the next press refunds it once', async () => {
  const key = { currency0: USDG, currency1: UFG, fee: 792831, tickSpacing: 9303 };
  const chain = chainFor({ deposits: [{ key, balance0: 100000n, balance1: 0n }, { key, balance0: 200000n, balance1: 0n }] });
  const ids = [chain.operationId(0n), chain.operationId(1n)];
  const held = { owner: OWNER, deposits: ids.map((operationId, i) => ({ operationId, ...key, hooks: NFT.key.hooks, balance0: String(100000 * (i + 1)), balance1: '0', currencies: CURRENCIES })) };
  const s = await atLab(chain, { held });
  try {
    const card = s.page.locator('[data-held-deposits]');
    const sends = () => chain.log.filter((m) => m === 'eth_sendTransaction').length;
    // "Speed up": the refund is mined under another hash than the one the page was given.
    chain.speedUp();
    const first = card.locator(`[data-held-deposit="${ids[0]}"]`);
    const started = Date.now();
    await first.getByRole('button', { name: 'Refund to wallet', exact: true }).click();
    await first.locator('[data-held-progress="done"]').waitFor({ timeout: 30_000 });
    assert.ok(Date.now() - started < 30_000, 'within seconds, not after the five-minute watch');
    assert.equal(await first.locator('[data-held-notice]').count(), 0);
    assert.deepEqual(chain.paid, [{ to: OWNER, currencies: [USDG, UFG], amounts: [100000n, 0n] }]);
    await s.page.locator('[data-position-lab][data-changes="1"]').waitFor();

    // "Cancel": its nonce is taken by a transfer to the account itself, and the deposit stays held.
    chain.cancelInWallet();
    const second = card.locator(`[data-held-deposit="${ids[1]}"]`);
    await second.getByRole('button', { name: 'Refund to wallet', exact: true }).click();
    await second.locator('[data-held-notice="replaced"]').waitFor({ timeout: 40_000 });
    assert.equal(await text(second.locator('[data-held-notice]')), 'Your wallet replaced the refund with another transaction, and your deposit is still held. Try the refund again.');
    assert.equal(chain.operations.get(ids[1]).closed, false);
    assert.equal(sends(), 2, 'the cancelled refund was not offered again');
    assert.doesNotMatch(await text(card), FORBIDDEN);
    assert.equal(await card.getByRole('button', { name: /retry/i }).count(), 0, 'no Retry');

    // The next press refunds it once, at the nonce after the one the cancel took.
    await second.getByRole('button', { name: 'Refund to wallet', exact: true }).click();
    await second.locator('[data-held-progress="done"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(chain.sends.map((tx) => tx.nonce), ['0x0', '0x2']);
    assert.deepEqual(chain.paid.map((paid) => paid.amounts), [[100000n, 0n], [200000n, 0n]]);
    assert.equal(sends(), 3);
  } finally { await s.close(); }
});

test('a collect sped up in the wallet ends done within seconds; a close cancelled in the wallet says the position was not closed, and the next press closes it once', async () => {
  const chain = chainFor();
  const s = await atLab(chain, { position: actionsFor() });
  try {
    const sends = () => chain.log.filter((m) => m === 'eth_sendTransaction').length;
    await s.page.locator('[data-position-action="collect"]').click();
    const collect = s.page.locator('[role="dialog"][data-position-dialog="collect"]');
    await collect.locator('[data-position-send="collect"]:not([disabled])').waitFor();
    chain.speedUp();
    const started = Date.now();
    await collect.getByRole('button', { name: 'Collect in wallet', exact: true }).click();
    await collect.locator('[data-position-progress="done"]').waitFor({ timeout: 30_000 });
    assert.ok(Date.now() - started < 30_000, 'within seconds, not after the five-minute watch');
    assert.deepEqual(chain.paid, [{ to: OWNER, currencies: [USDG, UFG], amounts: FEES }]);
    await s.page.locator('[data-position-lab][data-changes="1"]').waitFor();
    await collect.getByRole('button', { name: 'Back to position', exact: true }).click();
    await collect.waitFor({ state: 'detached' });

    await s.page.locator('[data-position-action="close"]').click();
    const closing = s.page.locator('[role="dialog"][data-position-dialog="close"]');
    await closing.locator('[data-position-send="close"]:not([disabled])').waitFor();
    chain.cancelInWallet();
    await closing.getByRole('button', { name: 'Close in wallet', exact: true }).click();
    await closing.locator('[data-position-notice="replaced"]').waitFor({ timeout: 40_000 });
    // Changed on purpose 2026-10-01 (integration pass 3, the copy review): "this step", and what is still true in plain words.
    assert.equal(await text(closing.locator('[data-position-notice]')), 'Your wallet replaced this step with another transaction, and the position is still open. Press Close in wallet again.');
    assert.equal(chain.nft(NFT.tokenId).liquidity, NFT.liquidity, 'nothing was closed');
    assert.equal(sends(), 2, 'the cancelled close was not offered again');
    assert.doesNotMatch(await text(closing), FORBIDDEN);
    assert.equal(await closing.getByRole('button', { name: /retry/i }).count(), 0, 'no Retry');

    // Pressed again: one close, at the nonce after the one the cancel took.
    await closing.locator('[data-position-send="close"]:not([disabled])').waitFor();
    await closing.getByRole('button', { name: 'Close in wallet', exact: true }).click();
    await closing.locator('[data-position-progress="done"]').waitFor({ timeout: 30_000 });
    assert.equal(chain.nft(NFT.tokenId).liquidity, 0n);
    assert.deepEqual(chain.sends.map((tx) => tx.nonce), ['0x0', '0x2']);
    assert.equal(sends(), 3);
  } finally { await s.close(); }
});

test('a receipt read that fails once is read again: the refund and a collect end done, and the page reads again', async () => {
  const chain = chainFor({ deposits: [{ key: { currency0: USDG, currency1: UFG, fee: 792831, tickSpacing: 9303 }, balance0: 100000n, balance1: 0n }] });
  const operationId = chain.operationId(0n);
  const held = { owner: OWNER, deposits: [{ operationId, currency0: USDG, currency1: UFG, fee: 792831, tickSpacing: 9303, hooks: NFT.key.hooks, balance0: '100000', balance1: '0', currencies: CURRENCIES }] };
  const s = await atLab(chain, { position: actionsFor(), held });
  try {
    const receipts = () => chain.log.filter((m) => m === 'eth_getTransactionReceipt').length;
    // The wallet's node fails the first receipt read (-32603), as MetaMask does now and then.
    chain.failNext('eth_getTransactionReceipt');
    const card = s.page.locator('[data-held-deposits]');
    await card.getByRole('button', { name: 'Refund to wallet', exact: true }).click();
    await card.locator('[data-held-progress="done"]').waitFor({ timeout: 30_000 });
    assert.equal(await card.locator('[data-held-notice]').count(), 0, 'no failure said');
    assert.equal(receipts(), 2, 'the failed read, then the one that found the refund');
    await s.page.locator('[data-position-lab][data-changes="1"]').waitFor();

    chain.failNext('eth_getTransactionReceipt');
    await s.page.locator('[data-position-action="collect"]').click();
    const dialog = s.page.locator('[role="dialog"][data-position-dialog="collect"]');
    await dialog.locator('[data-position-send="collect"]:not([disabled])').waitFor();
    await dialog.getByRole('button', { name: 'Collect in wallet', exact: true }).click();
    await dialog.locator('[data-position-progress="done"]').waitFor({ timeout: 30_000 });
    assert.equal(await dialog.locator('[data-position-notice]').count(), 0);
    assert.equal(receipts(), 4);
    assert.equal(chain.sends.length, 2);
    await s.page.locator('[data-position-lab][data-changes="2"]').waitFor();
  } finally { await s.close(); }
});

test('the press never sends what the dialog did not show: fees settled elsewhere stop the collect, a price that moved stops the close for a second look', async () => {
  const chain = chainFor();
  const s = await atLab(chain, { position: actionsFor() });
  try {
    await s.page.locator('[data-position-action="collect"]').click();
    const collect = s.page.locator('[role="dialog"][data-position-dialog="collect"]');
    await collect.locator('[data-position-send="collect"]:not([disabled])').waitFor();
    assert.match(await text(collect.locator('[data-position-receive] > div').first()), /^You receive\s+0\.001234 USDG\s+0\.5 UFG$/);
    // Settled from another tab or by an operator while the dialog is open: nothing is owed any more.
    chain.grow(NFT.tokenId, NFT.growthLast);
    await collect.getByRole('button', { name: 'Collect in wallet', exact: true }).click();
    await collect.locator('[data-position-nothing]').waitFor({ timeout: 30_000 });
    assert.equal(await text(collect.locator('[data-position-nothing]')), 'There are no fees to collect right now.');
    assert.match(await text(collect.locator('[data-position-receive] > div').first()), /^You receive\s+0 USDG\s+0 UFG$/, 'the figures read at the press');
    assert.equal(await collect.locator('[data-position-send="collect"]').isDisabled(), true);
    assert.deepEqual([chain.sends.length, chain.log.includes('eth_sendTransaction')], [0, false], 'no empty collect reaches the wallet');
    await collect.getByRole('button', { name: 'Close', exact: true }).click();

    chain.grow(NFT.tokenId, NFT.growthNow);
    await s.page.locator('[data-position-action="close"]').click();
    const closing = s.page.locator('[role="dialog"][data-position-dialog="close"]');
    await closing.locator('[data-position-send="close"]:not([disabled])').waitFor();
    const atLeast = closing.locator('[data-position-at-least]');
    const shown = await text(atLeast);
    assert.match(shown, /^At least\s+0\.990047 USDG\s+322\.448 UFG$/);
    // The price falls about 2% while the dialog is open: at the press the close would pay less UFG than the figures on screen.
    const moved = { sqrtPriceX96: (NFT.sqrtPriceX96 * 99n) / 100n, tick: NFT.tick - 202 };
    chain.move(NFT.tokenId, moved.sqrtPriceX96, moved.tick);
    const send = closing.getByRole('button', { name: 'Close in wallet', exact: true });
    await send.click();
    await closing.locator('[data-position-notice="changed"]').waitFor({ timeout: 30_000 });
    assert.equal(await text(closing.locator('[data-position-notice]')), 'The amounts changed since you opened this. Check them, then press again.');
    assert.notEqual(await text(atLeast), shown, 'the new figures are on screen');
    assert.deepEqual([chain.sends.length, chain.log.includes('eth_sendTransaction')], [0, false], 'nothing was offered to the wallet');
    await closing.locator('[data-position-send="close"]:not([disabled])').waitFor();
    // The second press sends what is now on screen: the minimums at the new price.
    await send.click();
    await closing.locator('[data-position-progress="done"]').waitFor({ timeout: 30_000 });
    const minimums = position.closeMinimums(moved.sqrtPriceX96, NFT.tickLower, NFT.tickUpper, NFT.liquidity, 50);
    const { decrease } = sentStep(chain);
    assert.deepEqual(decrease, [NFT.tokenId, NFT.liquidity, minimums[0], minimums[1], '0x']);
  } finally { await s.close(); }
});

test('only the owner sees the actions; hooked pools are refused, an empty position offers no close, and a subscribed one says automation stops', async () => {
  const chain = chainFor({ position: { hasSubscriber: true } });
  const other = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';
  const s = await atLab(chain, { position: actionsFor({ owner: other }), held: { owner: other, deposits: [] } });
  try {
    await s.page.waitForTimeout(500);
    assert.equal(await s.page.locator('[data-position-actions], [data-held-deposits]').count(), 0, 'another wallet’s position shows no action');
    // The same page for the owner, in turn: hooks, an empty NFT, a subscribed one.
    const open = (spec) => s.page.evaluate((hash) => { location.hash = hash; }, `#/position-lab/${encodeURIComponent(JSON.stringify(spec))}`);
    await open({ position: actionsFor({ hooks: '0x00000000000000000000000000000000000000c0' }) });
    await s.page.locator('[data-position-actions="hooks"]').waitFor();
    for (const action of ['collect', 'close']) {
      const button = s.page.locator(`[data-position-action="${action}"]`);
      assert.deepEqual([await button.isDisabled(), await button.getAttribute('title')], [true, 'Positions in pools with hooks can’t be collected or closed here.']);
    }
    await open({ position: actionsFor({ liquidityRaw: '0', unsettledFeesRaw: ['0', '0'] }) });
    await s.page.locator('[data-position-actions=""]').waitFor();
    assert.equal(await s.page.locator('[data-position-action="close"]').count(), 0, 'no Close position at zero liquidity');
    assert.equal(await s.page.locator('[data-position-action="collect"]').isDisabled(), true, 'no fees to collect');
    // Changed on purpose 2026-11-09 (the core-flows fix, item d): fees the read service did not report no longer turn
    // Collect fees off with a reason only a mouse could see: it opens, and its dialog reads the fees on chain itself.
    await open({ position: actionsFor({ unsettledFeesRaw: null }) });
    await s.page.locator('[data-position-action="collect"]').waitFor();
    assert.deepEqual([await s.page.locator('[data-position-action="collect"]').isDisabled(), await s.page.locator('[data-position-action="collect"]').getAttribute('title'), await s.page.locator('[data-position-action="close"]').isDisabled()], [false, null, false]);
    await open({ position: actionsFor() });
    await s.page.locator('[data-position-action="close"]').waitFor();
    await s.page.locator('[data-position-action="close"]').click();
    const dialog = s.page.locator('[role="dialog"][data-position-dialog="close"]');
    await dialog.locator('[data-position-warning="automation"]').waitFor();
    assert.equal(await text(dialog.locator('[data-position-warning]')), 'Collecting fees or closing stops Domino automation for this position.');
    // (QA round 2, N49) The same subscribed position as the root of Auto-exit's own vault: its subscriber is that vault and
    // Auto-exit stays on, so the dialog, read and ready to send, says nothing of stopping automation.
    await s.page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await open({ position: actionsFor({ autoExitRoot: true }) });
    await s.page.locator('[data-position-action="close"]').click();
    await dialog.locator('[data-position-send="close"]:not([disabled])').waitFor({ timeout: 30_000 });
    assert.equal(await dialog.locator('[data-position-warning="automation"]').count(), 0, 'no automation note on an Auto-exit root');
    assert.deepEqual(chain.sends, []);
  } finally { await s.close(); }
});

// 2026-09-25 (audit of 754014c, re-checked on the page's own chain reads): after Collect and Close on a position's own
// page, everything that shows the position reads it again at once. Found on the released build: the fees card kept its
// unclaimed figure for up to a minute (its own state read, every STATE_REFRESH_MS), and Automate and the Plain position
// pill stayed on a closed position (the wallet's list was read before the Close). On return, the Positions list reads
// the chain afresh: it says Closed.
test('after Collect and Close on a position’s page, its figures, its fees card, Automate and the list show the new state at once', async () => {
  const chain = chainFor();
  const key = { ...NFT.key, currency0: USDG, currency1: UFG };
  // The public RPC as the page reads it, following the wallet's chain: each included send moves its head on, and the
  // position's liquidity and unclaimed fees are the wallet chain's. Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the
  // fees card shows its unclaimed figure in whatever state its ledger leaves it (this chain holds none of the position's
  // events: Fees earned not measured), so the test reads the figure, not a loading state.
  const rpc = browserChain({
    positions: [{ tokenId: '3135288', holder: OWNER, key, tickLower: NFT.tickLower, tickUpper: NFT.tickUpper, get liquidity() { return chain.nft(NFT.tokenId).liquidity; }, get unclaimed() { return chain.sends.length ? [0n, 0n] : FEES; } }],
    pools: { [poolIdOf(key)]: { sqrtPriceX96: NFT.sqrtPriceX96, tick: NFT.tick } },
    tokens: { [USDG]: { symbol: 'USDG', decimals: 6 }, [UFG]: { symbol: 'UFG', decimals: 18 } },
  });
  const HEAD = rpc.head;
  Object.defineProperty(rpc, 'head', { get: () => HEAD + 10 * chain.sends.length });
  const s = await atLab(chain, null, { hash: '/positions/3135288', rpc });
  try {
    const page = s.page;
    const detail = page.locator('[data-position-detail][data-position-id="3135288"]');
    await detail.waitFor({ timeout: 15_000 });
    await detail.locator('[data-position-actions] a[data-automate-entry]').waitFor({ timeout: 15_000 });
    assert.equal(await text(detail.locator('.dm-pos-chips [data-automation="plain"]')), 'Plain position');
    const card = page.locator('[data-fees-card]');
    await card.waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => /0\.001234 USDG[\s\S]*0\.5 UFG/.test(document.querySelector('[data-fees-card]')?.innerText ?? ''), null, { timeout: 15_000 });
    assert.match(await text(card), /0\.001234 USDG[\s\S]*0\.5 UFG/, 'the card’s unclaimed figure');
    await detail.locator('[data-cell="fees"]').getByText('Token amounts', { exact: true }).click();
    assert.match(await text(detail.locator('[data-stat="fees"]')), /0\.001234\s+USDG/);

    // Collect fees: the page's figures and the card's are 0 at once, not a minute later.
    await page.locator('[data-position-action="collect"]').click();
    const collect = page.locator('[role="dialog"][data-position-dialog="collect"]');
    await collect.locator('[data-position-send="collect"]:not([disabled])').waitFor({ timeout: 30_000 });
    await collect.getByRole('button', { name: 'Collect in wallet', exact: true }).click();
    await collect.locator('[data-position-progress="done"]').waitFor({ timeout: 30_000 });
    const collected = Date.now();
    await collect.getByRole('button', { name: 'Back to position', exact: true }).click();
    await page.waitForFunction(() => !/0\.001234/.test(document.querySelector('[data-stat="fees"]')?.textContent ?? '0.001234'), null, { timeout: 5_000 });
    await page.waitForFunction(() => {
      const shown = document.querySelector('[data-fees-card]');
      return !shown || !/0\.001234/.test(shown.textContent ?? '');
    }, null, { timeout: 5_000 });
    const took = Date.now() - collected;
    assert.ok(took < 5_000, `the fees card's figure followed the collect in ${took} ms`);

    // Close position: Closed at once, and neither Automate nor the Plain position pill any more.
    await page.locator('[data-position-action="close"]').click();
    const close = page.locator('[role="dialog"][data-position-dialog="close"]');
    await close.locator('[data-position-send="close"]:not([disabled])').waitFor({ timeout: 30_000 });
    await close.getByRole('button', { name: 'Close in wallet', exact: true }).click();
    await close.locator('[data-position-progress="done"]').waitFor({ timeout: 30_000 });
    await close.getByRole('button', { name: 'Back to position', exact: true }).click();
    await detail.locator('[data-position-status="closed"]').waitFor({ timeout: 5_000 });
    await page.waitForFunction(() => document.querySelectorAll('a[data-automate-entry], .dm-pos-chips [data-automation="plain"]').length === 0, null, { timeout: 5_000 });
    assert.equal(chain.sends.length, 2, 'the collect and the close');

    // Positions, read afresh: the position is under Closed (the automation page's picker reads the same way, on its own mount).
    await page.evaluate(() => { location.hash = '#/positions'; });
    await page.locator('[data-owned="ready"]').waitFor({ timeout: 5_000 });
    assert.deepEqual((await page.getByRole('tab').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()), ['Open 0', 'Closed 1']);
  } finally { await s.close(); }
});
