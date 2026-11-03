/**
 * The integrated automation screens in a browser (Domino V2 integration, 2026-10-02, the AUTOMATION agent), on the
 * wallet-test-v2 build (V1's screens with V2 compiled in) served as the wallet suites serve it:
 *
 *   - preview (`window.__dominoV2Test.originOpen` alone, as on the preview alias before the deploy): on a plain position
 *     the connected wallet holds, the position page's "Auto-exit" (Changed on purpose 2026-10-06, the owner's point 5;
 *     once "Stop-loss / take-profit") opens one dialog in the look of the page's action dialogs: one sentence, the range's
 *     edges it closes at (no price typed), the 0.2% fee, the rest under Details, and the gate's locked sentence where its
 *     one button would be; nothing reaches the wallet. Managed positions shows nothing of Domino V2 while read-v6 has
 *     nothing to say about this wallet (real data only, no example rows).
 *   - live on the fake V2 vault chain (its contracts set and the backend's word through the test hooks; read-v6
 *     scripted as its route will answer: the package's own fixtures, adapted to the chain and held to the package's
 *     validator): a root closed by the S1 exit (burned) and one closed directly on Uniswap keep their vault's fees in
 *     view, on the position's page and in Managed positions, listed by owner (never from the NFT), with "Withdraw to
 *     wallet" (one EIP-5792 batch when the wallet batches) and "Return my reserves" (returnReserves(), rev4); "Leave
 *     automation" sends exitAll(), then offers v4's follow-ups. The card is the condensed one of the review of
 *     2026-10-03 (#8): a pill, one sentence, one figure, at most two buttons; the rest under its Details. Auto-exit
 *     (2026-10-06): a plain position turns it on with ONE signature and ONE wallet_sendCalls (approve, createVault,
 *     setExitModule, registerMandate), its card then says "Auto-exit on · closes at …" and "Turn off" revokes it; a
 *     protection-only automation is that one card, never a second; a running Auto-compound is never offered it.
 * Every page: no page error, no CSP violation, every wallet method answered, nothing outside the page's origin.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { decodeFunctionData, toFunctionSelector } from 'viem';
import { closeBrowser } from '../support/close-browser.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';

const APP = resolve(import.meta.dirname, '../..');
if (!existsSync(join(WALLET_V2_DIST, 'index.html'))) throw new Error('.wallet-test-v2-dist is missing. Run npm run build:wallet-test-v2 first (npm run test:v2in does).');
// The server takes the production CSP from the compiled middleware, and the fake chains read the unit build.
if (!existsSync(resolve(APP, '.test-build/app/functions/_middleware.js'))) execFileSync(process.execPath, ['scripts/test.mjs', '--build-only'], { cwd: APP, stdio: 'ignore' });
const { createFakeSession } = await import('../support/fake-session.mjs');
const { createWalletServer } = await import('../support/wallet-server.mjs');
const { ACCOUNTS, installWallets } = await import('../support/mock-wallet.mjs');
const { browserChain, poolIdOf, routeChain } = await import('../support/browser-chain.mjs');
const { routeConfirmation } = await import('../support/confirmation-route.mjs');
const { ABI, OTHER, OWNER, ZERO, createVaultChain, mandateHash } = await import('../support/v2-vault-chain.mjs');
const { READ6, read6Answer, walletFor } = await import('../support/v2-auto-page.mjs');
const { plainPortfolio } = await import('../support/v2-plain-portfolio.mjs');
const { FAKE } = await import('../v2/support/plans.mjs');

const LAUNCHES = process.env.DOMINO_BROWSER_PATH ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }] : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}];
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
const ARTWORK = /^https:\/\/(api|cdn)\.dexscreener\.com\//;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const AUTO_EXIT = FAKE.autoExit.toLowerCase();
const ZAP = '0x00000000000000000000000000000000000a9900';
const LOCKED = "This opens as soon as Domino's service is live on Robinhood Chain.";
const require = createRequire(import.meta.url);
const { sqrtPriceAtTick } = require('../../.test-build/app/src/lib/read/screens/poolRange.js');
/** The fake vault chain's root, in ETH / USDG (0.30%, spacing 60, no hooks). */
const ROOT = 3_409_682n;
const POOL = { currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60 };
const KEY = { ...POOL, hooks: ZERO };
const TOKENS = { [USDG]: { symbol: 'USDG', decimals: 6 } };
const SELECTOR = {
  withdrawReserves: toFunctionSelector('withdrawReserves(address,uint256,address)'),
  returnReserves: toFunctionSelector('returnReserves()'),
  exitAll: toFunctionSelector('exitAll()'),
  unsubscribe: toFunctionSelector('unsubscribe(uint256)'),
  approve: toFunctionSelector('approve(address,uint256)'),
  setExitModule: toFunctionSelector('setExitModule(address)'),
  revokeMandate: toFunctionSelector('revokeMandate(bytes32)'),
};
const SENDS_AND_SIGNATURES = ['eth_sendTransaction', 'eth_sendRawTransaction', 'wallet_sendCalls', 'eth_signTypedData_v4', 'personal_sign'];
const selectorOf = (data) => data.slice(0, 10);
const vaultArgs = (data) => decodeFunctionData({ abi: ABI.vault, data }).args.map((a) => (typeof a === 'string' ? a.toLowerCase() : a));
const shots = () => {
  const dir = resolve(process.env.DOMINO_POSITION_SHOTS ?? join(APP, '.test-artifacts'));
  mkdirSync(dir, { recursive: true });
  return dir;
};

let browser;
before(async () => {
  for (const options of LAUNCHES) {
    try {
      browser = await chromium.launch({ ...options, headless: true });
      break;
    } catch {
      // the next build
    }
  }
  if (!browser) throw new Error('A Chromium browser is required. Set DOMINO_BROWSER_PATH.');
});
after(async () => {
  await closeBrowser(browser);
});

/** Connects the wallet `name` from the header's dialog, without signing in. */
async function connect(page, name) {
  try {
    await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    // The header's own control; by its name when the header draws it another way.
    const opener = page.locator('header [aria-haspopup="dialog"]');
    if (await opener.count()) await opener.first().click();
    else await page.getByRole('button', { name: /Connect wallet/ }).first().click();
    await page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: `Connect ${name}`, exact: true }).click();
    await page.waitForFunction(() => ['signed_out', 'wrong_network'].includes(window.__dominoSessionProbe?.view().status));
    await page.keyboard.press('Escape');
  } catch (error) {
    // Where the page stood, with the failure.
    const where = await page.evaluate(() => ({ session: window.__dominoSessionProbe?.view() ?? null, hash: location.hash, header: document.querySelector('header')?.innerText ?? null, body: document.body.innerText.slice(0, 400) })).catch((failure) => String(failure));
    error.message += `
(page: ${JSON.stringify(where)})`;
    throw error;
  }
}

/** The page's own origin, data and blob only (the fonts are answered locally, as the finance suites do). */
const elsewhere = (requests, origin) => requests.filter((url) => !url.startsWith(`${origin}/`) && !url.startsWith('data:') && !url.startsWith('blob:') && !FONTS.test(url) && !ARTWORK.test(url));

/**
 * The served build, one browser context, V1's chain reads answered from `v1` (tests/support/browser-chain.mjs), the
 * page's errors, CSP violations and requests recorded. `wallet(context)` installs the browser wallet and returns it.
 */
async function serve({ v1, hooks, wallet, routes = [], confirmation = null }) {
  const fake = createFakeSession();
  const server = createWalletServer({ fake, dist: WALLET_V2_DIST, routes });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fake.origin = origin;
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.route(FONTS, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  const rpc = await routeChain(context, v1);
  if (confirmation) await routeConfirmation(context, confirmation);
  const installed = await wallet(context);
  await context.addInitScript((given) => {
    window.__dominoV2Test = { ...(window.__dominoV2Test ?? {}), ...given };
  }, hooks);
  const page = await context.newPage();
  const errors = [];
  const requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => requests.push(request.url()));
  return { page, origin, context, server, rpc, wallet: installed, errors, requests };
}

async function expandAutomation(page) {
  await page.waitForFunction(() => !document.querySelector('[data-position-loading]') && document.querySelector('[data-automation-control]'), { timeout: 30_000 });
  const control = page.locator('[data-automation-control]');
  await control.waitFor({ timeout: 30_000 });
  assert.equal(await control.count(), 1, 'one mode and status control per position');
  if (await control.getAttribute('data-automation-setup') !== null) return;
  if (await control.getAttribute('aria-expanded') === 'false') await control.click();
  await page.locator('[data-automation-management]').waitFor();
  assert.equal(await page.getByRole('dialog').count(), 1, 'one management popup, without a wallet dialog');
}

/** Preview: Test Wallet A (tests/support/mock-wallet.mjs), V2's gate open on the test origin, nothing live. */
async function openPreview(v1, hash, { portfolio = /^\/positions\/\d+$/.test(hash) ? plainPortfolio(v1, ACCOUNTS[0].address.toLowerCase()) : null, expand = true } = {}) {
  const s = await serve({ v1, hooks: { originOpen: true, ...(portfolio ? { read6: { portfolio } } : {}) }, wallet: (context) => installWallets(context) });
  const close = async () => {
    await s.context.close();
    await s.server.closeAll();
    assert.deepEqual(s.errors, [], 'no page error');
    assert.deepEqual(s.wallet.state.csp, [], 'no CSP violation');
    assert.deepEqual(s.wallet.state.refused, [], 'every method asked is one this wallet answers');
    assert.deepEqual(s.rpc.errors, [], 'the chain was asked only what it answers');
    assert.deepEqual(elsewhere(s.requests, s.origin), [], 'no request to any host but the page\'s own');
  };
  try {
    await s.page.goto(`${s.origin}/#${hash}`);
    await connect(s.page, 'Test Wallet A');
    if (expand && /^\/positions\/\d+$/.test(hash)) await expandAutomation(s.page);
    return { ...s, close };
  } catch (error) {
    // What the page said is kept with the failure (an assertion of close() would otherwise hide it).
    await close().catch((closing) => { error.message += `
(on close: ${closing.message})`; });
    throw error;
  }
}

/** Plain positions use the visible, preselected setup entry; existing Auto-exit setups keep their own control. */
async function openExit(page) {
  const setup = page.locator('[data-automation-setup]');
  if (await setup.count()) {
    const id = await setup.getAttribute('data-automate-entry');
    await setup.click();
    if (id !== null) {
      await page.locator(`[data-sequence-position="${id}"][aria-checked="true"]`).waitFor();
      await page.locator('[data-sequence-mode="protection"]').click();
      await page.locator('[data-sequence-action="protection"]').click();
    }
  } else {
    await page.locator('[data-automation-panel] [data-v2in-open="mandate"]:visible').click();
  }
}

const WALLET_NAME = 'V2 Test Wallet';

/**
 * Live on the fake V2 vault chain: the chain announced as a browser wallet of its own through EIP-6963 (as
 * tests/support/v2-auto-page.mjs does), its contracts set and the backend's word in the test hooks (src/v2/gate.ts:
 * `live`), read-v6's answers scripted (`read6`, src/v2in/automate/read6.tsx), V1's own reads answered from `v1`.
 */
async function openLive(chain, { hash, read6, v1, routes = [], beforeOpen = async () => {} }) {
  const methods = walletFor(chain);
  const csp = [];
  const s = await serve({
    v1,
    confirmation: chain,
    routes,
    hooks: { originOpen: true, contracts: { [chain.chainId]: chain.contracts }, backendOn: true, read6 },
    wallet: async (context) => {
      await context.exposeFunction('__dominoV2inWallet', (method, params) => methods.request(method, params));
      await context.exposeFunction('__dominoV2inCsp', (text) => csp.push(text));
      await context.addInitScript(({ name, unclaimed }) => {
        document.addEventListener('securitypolicyviolation', (event) => window.__dominoV2inCsp(`${event.violatedDirective} ${event.blockedURI}`));
        const provider = {
          async request({ method, params }) {
            const reply = await window.__dominoV2inWallet(method, params ?? []);
            if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code, data: reply.error.data });
            if (method === 'eth_call' && params?.[0]?.data?.startsWith(unclaimed)) window.__dominoUnclaimedReplies = (window.__dominoUnclaimedReplies ?? 0) + 1;
            return reply.result;
          },
          on() { return provider; },
          removeListener() { return provider; },
        };
        const detail = Object.freeze({ info: Object.freeze({ uuid: '8f2a7d1c-0000-4000-8000-0000000002f7', name, icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E', rdns: 'test.wallet.v2in' }), provider });
        const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
        window.addEventListener('eip6963:requestProvider', announce);
        announce();
      }, { name: WALLET_NAME, unclaimed: toFunctionSelector('unclaimed(address,address)') });
      return methods;
    },
  });
  const close = async () => {
    await s.context.close();
    await s.server.closeAll();
    assert.deepEqual(s.errors, [], 'no page error');
    assert.deepEqual(csp, [], 'no CSP violation');
    assert.deepEqual(methods.refused, [], 'every method asked is one this wallet answers');
    assert.deepEqual(chain.strange, [], 'every call reached a function its contract has');
    assert.deepEqual(s.rpc.errors, [], 'V1\'s chain reads were asked only what they answer');
    assert.deepEqual(elsewhere(s.requests, s.origin), [], 'no request to any host but the page\'s own');
    assert.ok(!chain.log.includes('personal_sign'), 'nothing is signed in');
  };
  try {
    await beforeOpen(s);
    await s.page.goto(`${s.origin}/#${hash}`);
    await connect(s.page, WALLET_NAME);
    if (/^\/positions\/\d+$/.test(hash)) await expandAutomation(s.page);
    return { ...s, chain, close };
  } catch (error) {
    // What the page said is kept with the failure (an assertion of close() would otherwise hide it).
    await close().catch((closing) => { error.message += `
(on close: ${closing.message})`; });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// read-v6 as its route will answer, about the fake chain's wallet and vault
// ---------------------------------------------------------------------------

const SINCE = { hash: `0x${'4b'.repeat(32)}`, snapshot: { hash: `0x${'cb'.repeat(32)}`, number: 73390040, timestamp: 1790424074 } };
const waitingOf = (reason) => ({ checkedAt: 1790431194, checkedBlock: 73400090, error: null, lastRevert: null, reason, since: 1790430594, sinceBlock: 73399490 });

/**
 * read-v6's portfolio for the fake chain's owner with its one vault on ROOT (the package's `portfolio-custody-lost`
 * fixture, adapted): the vault's custody as the index read it (`armed`, the disarm `reason`), paused or not, its
 * reserves (`[[token, raw]]`, all idle), why it waits, and the root's live read (`root`: { owner, liquidity }, or
 * null for a burned NFT, which read-v6 no longer lists). The stateNonce is the chain's now. `other` (added 2026-10-06,
 * the final check F7: { address, symbol, decimals }): the fixture's own pool, USDG and that token, in place of ETH / USDG.
 */
function listing(chain, vault, { armed, reason = null, paused = false, pausedBy = null, reserves, root, waiting = null, orders = null, autoExit = false, other = null }) {
  const swaps = other
    ? [[READ6.wallet, OWNER], [READ6.vault, vault], [READ6.module, AUTO_EXIT], [READ6.many, other.address]]
    : [[READ6.wallet, OWNER], [READ6.vault, vault], [READ6.module, AUTO_EXIT], [READ6.usdg, ZERO], [READ6.many, USDG]];
  const token = (address, symbol, decimals) => ({ address, chainId: 4663, decimals, price: null, priceReason: 'no_qualified_price_source', status: 'available', symbol });
  const pair = other ? [USDG, other.address] : [ZERO, USDG];
  return read6Answer('portfolio', 'portfolio-custody-lost', swaps, (body) => {
    // `orders` (added 2026-10-04): the fixture's own active order, adapted, in place of none.
    body.mandates = orders ? orders(body.mandates) : [];
    body.tokens = other ? [token(USDG, 'USDG', 6), token(other.address, other.symbol, other.decimals)] : [token(ZERO, 'ETH', 18), token(USDG, 'USDG', 6)];
    const v = body.vaults[0];
    v.rootTokenId = String(ROOT);
    v.members = [{ disarmReason: armed ? null : reason, parentTokenId: null, role: 'root', status: armed ? 'armed' : 'disarmed', tokenId: String(ROOT) }];
    v.custody = armed ? { armed: true, reason: null, since: null, source: null } : { armed: false, reason, since: SINCE, source: 'event' };
    Object.assign(v, { pausedBy, autoExitEnabled: autoExit, waiting });
    Object.assign(v.state, {
      exitModule: autoExit ? AUTO_EXIT : null,
      paused,
      rootArmed: armed,
      stateNonce: String(chain.vault(vault).stateNonce),
      quoteCurrency: USDG,
      policy: { maxOverlapBps: 500, maxPositions: 1, minimumIntervalSeconds: 3600, mode: 'simple', triggerDistanceBps: 500 },
      limits: { maxObservationAgeSeconds: 600, maxPriceImpactBps: 200, maxSlippageBps: 100, upsideBps: 1000 },
      members: [{ active: true, lots: pair.map((address) => ({ charged: '0', token: address, uncharged: '0' })), parentTokenId: null, successorTokenId: null, tickLower: -600, tickUpper: 600, tokenId: String(ROOT) }],
      reserves: reserves.map(([token, amount]) => ({ idle: String(amount), token, total: String(amount) })),
    });
    if (!root) {
      body.positions = [];
      return;
    }
    const p = body.positions[0];
    p.tokenId = String(ROOT);
    p.vault = { address: vault, role: 'root' };
    Object.assign(p.state, {
      owner: root.owner,
      custody: { approved: vault, subscriber: vault },
      liquidity: String(root.liquidity),
      feesOwed: ['0', '0'],
      principalAtSpot: root.liquidity === 0n ? ['0', '0'] : p.state.principalAtSpot,
    });
  });
}

/**
 * Domino V1's sequence release as the release Worker answers it once its profile has ended (2026-10-21 19:01:30 UTC, not
 * renewed: an expired profile is refused with 503 setup_configuration_unavailable), each time it is asked kept in `asked`.
 * Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §8): Set up automation's page no longer waits for V1's release
 * in a build that carries V2 (screens/Sequence.tsx), so the vault's own flow (src/v2in/automate/SetupEntry.tsx) opens with
 * that profile gone; until then this answered the pinned V1 record (src/finance/pin.ts) with its expiry ahead.
 */
const v1SequenceGone = (asked = []) => async (request, url) => {
  if (url.pathname !== '/api/setup/v1/sequence-release') return undefined;
  asked.push(request.method);
  return new Response(JSON.stringify({ error: 'setup_configuration_unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Domino-Setup-Contract': '1.0.0-rc.1' } });
};

/** V1's own chain read of ROOT (tests/support/browser-chain.mjs): its holder, liquidity, burned or not. */
const rootOnV1 = ({ holder = OWNER, liquidity = 0n, burned = false } = {}) => browserChain({
  positions: [{ tokenId: String(ROOT), holder, key: KEY, tickLower: -600, tickUpper: 600, liquidity, unclaimed: [0n, 0n], burned }],
  tokens: TOKENS,
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

test('Auto-exit entry chooses a chain-qualified NFT and opens the existing dialog; back, cancel and deep links preserve the intended position', async () => {
  const ID = '3135288';
  const holder = ACCOUNTS[0].address.toLowerCase();
  const v1 = browserChain({ positions: [{ tokenId: ID, holder, key: KEY, tickLower: -600, tickUpper: 600, liquidity: 10n ** 18n }], tokens: TOKENS });
  const { v2Chain } = require('../../.test-build/app/src/v2/chains.js');
  const usdcBase = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const portfolio = plainPortfolio(v1, holder, (body) => {
    const original = body.positions[0];
    body.positions.push({ ...structuredClone(original), chainId: 8453, dex: 3, positionManager: v2Chain(8453).uniswap.v3.positionManager,
      state: { ...structuredClone(original.state), pool: { ...original.state.pool, dex: 3, currency0: v2Chain(8453).wrappedNative.address, currency1: usdcBase } } });
    body.tokens.push({ ...body.tokens[0], chainId: 8453, address: v2Chain(8453).wrappedNative.address, symbol: 'WETH' });
    body.tokens.push({ ...body.tokens[0], chainId: 8453, address: usdcBase, symbol: 'USDC', decimals: 6 });
    body.chains = body.chains.map((chain) => ({ ...body.chains[0], chainId: chain.chainId }));
    body.coverage = 'complete';
    body.truncated = { positions: false, mandates: false, vaults: false };
  });
  const s = await openPreview(v1, '/automate', { portfolio });
  const { page } = s;
  try {
    const entry = page.locator('[data-v2in-protection]');
    await entry.waitFor();
    assert.equal(await entry.getAttribute('href'), '#/sequence/protection');
    await entry.click();
    await page.locator('[data-v2in-protection-setup]').waitFor();
    assert.equal(await page.locator('h1').innerText(), 'Set up Auto-exit');
    assert.equal(await page.locator('[data-sequence-mode]').count(), 0, 'the selected product is already Auto-exit');
    assert.equal(await page.locator('[data-protection-position]').count(), 2, 'same numeric ID in two namespaces remains two choices');
    assert.equal(await page.locator('[data-sequence-action="protection"]').isDisabled(), true);
    const base = page.locator(`[data-protection-position="8453:3:${ID}"]`);
    const usdc = base.locator('img[src="/tokens/usdc.svg"]');
    await usdc.waitFor();
    await usdc.evaluate(image => image.decode());
    assert.ok(await usdc.evaluate(image => image.naturalWidth > 0), 'Base USDC uses its real bundled artwork in the Auto-exit picker');
    await base.click();
    await page.locator('[data-sequence-action="protection"]').click();
    const dialog = page.locator('[data-v2in-dialog="mandate"]');
    await dialog.waitFor();
    assert.match(await dialog.innerText(), /live on Base/, 'the existing dialog received the selected chain, not the wallet network');
    assert.match(await dialog.locator('[data-mandate-fee]').innerText(), /0\.2%/);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    assert.equal(await base.getAttribute('aria-checked'), 'true', 'cancelling the dialog keeps the choice');
    await page.getByRole('link', { name: 'Back', exact: true }).click();
    await entry.waitFor();
    await page.goBack();
    await page.locator('[data-v2in-protection-setup]').waitFor();
    await page.evaluate((id) => { location.hash = `#/sequence/protection/robinhood-v4-${id}`; }, ID);
    await page.locator(`[data-protection-position="4663:4:${ID}"][aria-checked="true"]`).waitFor();
    await page.evaluate((id) => { location.hash = `#/sequence/protection/base-v3-${id}`; }, ID);
    await page.locator(`[data-protection-position="8453:3:${ID}"][aria-checked="true"]`).waitFor();
    await page.goBack();
    await page.locator(`[data-protection-position="4663:4:${ID}"][aria-checked="true"]`).waitFor();
    await page.setViewportSize({ width: 320, height: 800 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.locator('main').screenshot({ path: join(shots(), 'autoexit-picker-320.png'), animations: 'disabled' });
    assert.deepEqual(s.wallet.state.log.filter((entry) => SENDS_AND_SIGNATURES.includes(entry.method) || entry.method === 'wallet_switchEthereumChain'), [], 'picker and preview never sign, send or switch networks');
  } finally { await s.close(); }
});

test('Auto-exit picker recovers a failed portfolio read without a reload or a wallet action', async () => {
  const holder = ACCOUNTS[0].address.toLowerCase();
  const v1 = browserChain({ positions: [{ tokenId: '3135288', holder, key: KEY, tickLower: -600, tickUpper: 600, liquidity: 10n ** 18n }], tokens: TOKENS });
  const failed = { status: 503, body: { error: 'upstream_unavailable' } };
  const s = await openPreview(v1, '/sequence/protection/999999', { portfolio: failed });
  try {
    await s.page.locator('[data-sequence-positions="failed"]').waitFor();
    // Changed on purpose 2026-10-30 (QA round 2, the owner's rule: reads are asked again silently): no failure words and no
    // Try again; the loading rows stay while the portfolio is asked again by itself (src/v2in/lists/source.ts, 5 s after a
    // first failure).
    assert.doesNotMatch(await s.page.locator('main').innerText(), /couldn’t be checked|Try again/);
    assert.equal(await s.page.locator('[data-sequence-positions="failed"] .dm-seq-loading-row').count(), 3);
    const portfolio = plainPortfolio(v1, holder);
    await s.page.evaluate((value) => { window.__dominoV2Test.read6.portfolio = () => value; }, portfolio);
    await s.page.locator('[data-v2in-protection-setup]').waitFor({ timeout: 30_000 });
    assert.match(await s.page.locator('[data-sequence-position-missing]').innerText(), /Choose another position/);
    assert.equal(await s.page.locator('[data-sequence-action="protection"]').isDisabled(), true, 'missing intent never selects an unrelated NFT');
    assert.deepEqual(s.wallet.state.log.filter((entry) => SENDS_AND_SIGNATURES.includes(entry.method)), []);
  } finally { await s.close(); }
});

test('preview: Auto-exit on a plain position the wallet holds: the range\'s two edges, the fee, the rest under Details, and the locked sentence where its one button would be; Managed positions shows nothing of V2 for a wallet read-v6 knows nothing about; nothing reaches the wallet', async () => {
  const ID = '3135288';
  const holder = ACCOUNTS[0].address.toLowerCase();
  const v1 = browserChain({ positions: [{ tokenId: ID, holder, key: KEY, tickLower: -210000, tickUpper: -190000, liquidity: 2n ** 100n, unclaimed: [633825300114n, 0n] }], pools: { [poolIdOf(KEY)]: { sqrtPriceX96: (2n ** 96n) / 20000n, tick: -198080 } }, tokens: TOKENS });
  const s = await openPreview(v1, `/positions/${ID}`);
  const { page } = s;
  try {
    await page.locator(`[data-position-detail][data-position-id="${ID}"]`).waitFor({ timeout: 30_000 });
    const mount = page.locator(`[data-v2in-position="${ID}"]`);
    await mount.waitFor({ state: 'attached', timeout: 30_000 });
    assert.equal(await mount.getAttribute('data-v2in-mode'), 'preview');
    // A plain position: the card is there but quiet (its button is the actions row's); no vault card.
    const exit = mount.locator('[data-v2in-exit="plain"]');
    await exit.waitFor({ state: 'attached', timeout: 30_000 });
    assert.equal(await exit.isVisible(), false, 'no empty card: the actions row has the button');
    assert.equal(await mount.locator('[data-vault-card]').count(), 0, 'no vault of this wallet: no card');

    await openExit(page);
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="mandate"]');
    await dialog.waitFor();
    assert.equal(await dialog.locator('h2').innerText(), 'Auto-exit');
    assert.equal(await dialog.locator('.dm-pa-lede').innerText(), 'When the price reaches the end of your range, Domino closes this position and sends the tokens to your wallet.');
    // No price is typed: the range's own edges, the price inside it, so both; the lower first, in the chain's stable.
    assert.equal(await dialog.locator('input').count(), 0, 'nothing to type');
    const edges = dialog.locator('[data-mandate-edges="inside"] [data-mandate-edge]');
    assert.deepEqual(await edges.evaluateAll((items) => items.map((li) => [li.getAttribute('data-mandate-edge'), li.getAttribute('data-mandate-trigger'), li.getAttribute('data-exact')])), [
      ['falls', 'below', sqrtPriceAtTick(-210000).toString()],
      ['rises', 'above', sqrtPriceAtTick(-190000).toString()],
    ], 'exactly sqrtPriceAtTick(tickLower) and sqrtPriceAtTick(tickUpper)');
    assert.match(await edges.nth(0).innerText(), /^↘\s*falls to\s*759\.053 USDG per ETH$/);
    assert.match(await edges.nth(1).innerText(), /^↗\s*rises to\s*5,608\.12 USDG per ETH$/);
    // Changed on purpose 2026-10-06 (the review of point 5): the price now beside them; under the preview, the page's read.
    // Changed on purpose 2026-10-30 (QA round 2, N2): the screens' price rule (present.ts priceText), 2 decimals from 1,000.
    assert.equal(await dialog.locator('[data-mandate-now]').innerText(), 'Now 2,500.00');
    assert.equal(await dialog.locator('[data-mandate-near]').count(), 0, 'both ends far from the price: no warning');
    // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, the spec delta §2: one button is the acknowledgement and the
    // consent only with them in view above it): §4.6's fee line whole, warnings 1 and 2 (v4: no third), and the
    // protection-only automation's consent sentence, all outside Details, above where the button goes.
    assert.match(await dialog.locator('[data-mandate-fee]').innerText(), /^Fee\s+0\.2% of the position's value, only if it closes\. It's the only fee\.$/);
    const ack = dialog.locator('[data-mandate-ack]');
    assert.equal(await ack.isVisible(), true, 'in view, Details closed');
    assert.equal(await ack.evaluate((node) => node.closest('details')), null, 'never inside Details');
    assert.deepEqual(await ack.locator('[data-warning]').evaluateAll((notes) => notes.map((note) => [note.getAttribute('data-warning'), note.textContent])), [
      ['autoexit_warning_not_guaranteed', "The exit price is not guaranteed. In a sudden gap or a rug, the pool's liquidity can disappear before Domino closes the position."],
      ['autoexit_warning_reference_price', 'Domino closes it once the reference price passes the end of your range and the pool price is within the slippage limit of it.'],
    ]);
    assert.equal(await ack.locator('[data-mandate-consent]').innerText(), 'Auto-exit never reinvests. The fees this position earns leave with it when it closes, and the 0.2% fee counts them too.');
    assert.equal(await ack.locator('[data-mandate-owed]').count(), 0, 'nothing owed (and no review under the preview)');
    // Under the gate's preview: the gate's sentence where the button would be, never a button.
    assert.equal(await dialog.locator('[data-v2-locked]').innerText(), LOCKED);
    assert.equal(await dialog.locator('[data-mandate-send]').count(), 0);
    // Details: closed; warnings 5 and 7 and the pause on a change, the fixed terms, the wallet's integers and the steps
    // (a signature, then one batch).
    const details = dialog.locator('[data-mandate-details]');
    assert.equal(await details.evaluate((node) => node.open), false, 'closed until opened');
    await details.locator('summary').click();
    assert.deepEqual(await details.locator('[data-mandate-warnings] li').evaluateAll((items) => items.map((li) => li.getAttribute('data-warning'))), ['autoexit_warning_turn_off_pauses', 'autoexit_warning_halt', 'changes-pause']);
    assert.equal(await details.locator('[data-protection-only]').innerText(), "Auto-exit only closes this position. Domino doesn't reinvest its fees.");
    assert.match(await details.locator('[data-mandate-terms]').innerText(), /You receive\s+Both tokens, as withdrawn[\s\S]*Slippage limit\s+1% on top of the pool fee[\s\S]*Valid until\s+\d{1,2} \w+ 20\d\d/);
    assert.equal(await details.locator('[data-wallet-shows="below"]').innerText(), sqrtPriceAtTick(-210000).toString());
    assert.deepEqual(await details.locator('[data-wallet-steps="mandate-preview"] li').evaluateAll((items) => items.map((li) => li.getAttribute('data-wallet-step'))), ['sign-mandate', 'protect-batch']);
    assert.doesNotMatch(await dialog.innerText(), /vault|stop-loss|take-profit|order/i, 'no "vault", and Auto-exit by its name');
    const contained = async (label) => {
      const sizes = await dialog.evaluate((node) => [node, node.querySelector('.dm-flow-dialog-body')].map((el) => [el.clientWidth, el.scrollWidth]));
      for (const [client, scroll] of sizes) assert.ok(scroll <= client + 1, `${label}: no horizontal scrolling (${scroll} in ${client})`);
    };
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await contained(`dialog at ${width}`);
      await dialog.screenshot({ path: join(shots(), `v2in-autoexit-details-${width}-local-fixture.png`), animations: 'disabled' });
    }
    await details.locator('summary').click();
    await page.setViewportSize({ width: 1440, height: 1000 });
    await dialog.screenshot({ path: join(shots(), 'v2in-autoexit-preview.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' });

    // Public activity is independent of signing in. An absent route is shown as unavailable, never as no history.
    await page.evaluate(() => { location.hash = '#/positions'; });
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): the failed read is the hidden marker's, with no line.
    await page.locator('[data-automation-cards="integrated"] [data-activity-error]').waitFor({ state: 'attached', timeout: 30_000 });
    assert.doesNotMatch(await page.locator('[data-automation-cards="integrated"]').innerText(), /unavailable right now|try again automatically|checked again automatically/);
    assert.equal(await page.locator('[data-v2in-vaults], [data-vault-card], section[aria-labelledby="managed-title"]').count(), 0, 'no example rows or duplicate Managed wall');
    // Added 2026-10-06 (the integration review, ux #9): Automate's Auto-exit sends the person here: Auto-exit is named.
    const automation = page.locator('section[aria-labelledby="automation-title"]');
    assert.deepEqual(await automation.locator('.dm-acct-auto-name').allInnerTexts(), ['Auto-compound', 'Domino-compound', 'Auto-exit']);
    // Changed on purpose 2026-10-30 (QA round 2, N12): Auto-exit's trigger has one name across the app, "the end of your range",
    // in the imperative of the card's other two lines ("Reinvest earned fees", "Fund the next range").
    assert.equal(await automation.locator('[data-automation-feature="auto-exit"] .dm-acct-auto-text').innerText(), 'Close at the end of your range');
    await automation.screenshot({ path: join(shots(), 'v2in-positions-automation-card.png'), animations: 'disabled' });
    // …and Automate itself is about more than fees now.
    await page.evaluate(() => { location.hash = '#/automate'; });
    await page.locator('main [data-feature="protection"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(await page.locator('[data-automate] .dm-automation-choice-heading > h2').allInnerTexts(), ['New position', 'Auto-compound', 'Domino-compound', 'Auto-exit']);
    assert.doesNotMatch(await page.locator('main').innerText(), /Choose how to use your earned fees/);

    const asked = s.wallet.state.log.map((entry) => entry.method);
    for (const method of SENDS_AND_SIGNATURES) assert.ok(!asked.includes(method), `${method} is never asked in preview`);
  } finally {
    await s.close();
  }
});

// The same guarded entry is a visible action, without an extra menu or an empty setup card.
test('preview: a position page offers Auto-exit beside its other actions, and opens the same dialog; a range beside the price shows its far edge only', async () => {
  const ID = '3135288';
  const holder = ACCOUNTS[0].address.toLowerCase();
  // The price (tick -198080) under this range: a sell above today's price, closed at its top only.
  const v1 = browserChain({ positions: [{ tokenId: ID, holder, key: KEY, tickLower: -196200, tickUpper: -195000, liquidity: 2n ** 100n, unclaimed: [0n, 0n] }], pools: { [poolIdOf(KEY)]: { sqrtPriceX96: (2n ** 96n) / 20000n, tick: -198080 } }, tokens: TOKENS });
  const s = await openPreview(v1, `/positions/${ID}`);
  const { page } = s;
  try {
    const detail = page.locator(`[data-position-detail][data-position-id="${ID}"]`);
    await detail.waitFor({ timeout: 30_000 });
    // The panel's card says Auto-exit can be turned on here (a plain position the wallet holds, with liquidity).
    await page.locator(`[data-v2in-position="${ID}"] [data-v2in-exit="plain"] [data-v2in-open="mandate"]`).waitFor({ state: 'attached', timeout: 30_000 });
    const more = detail.locator('[data-position-actions] [data-position-v2-more]');
    await more.waitFor({ timeout: 30_000 });
    assert.equal(await more.getAttribute('role'), 'group');
    const entries = await more.locator('[data-position-v2-action]').evaluateAll((all) => all.map((one) => [one.getAttribute('data-position-v2-action'), one.textContent?.trim()]));
    assert.deepEqual(entries.map(([key]) => key), ['increase', 'changeRange', 'exit']);
    assert.equal(await more.locator('[data-position-v2-action="protect"]').count(), 0, 'automation is separate from liquidity actions');
    await openExit(page);
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="mandate"]');
    await dialog.waitFor();
    const edges = dialog.locator('[data-mandate-edges="below"] [data-mandate-edge]');
    assert.deepEqual(await edges.evaluateAll((items) => items.map((li) => [li.getAttribute('data-mandate-edge'), li.getAttribute('data-exact')])), [['rises', sqrtPriceAtTick(-195000).toString()]], 'the far edge alone: the near one is already crossed');
    await dialog.screenshot({ path: join(shots(), 'v2in-autoexit-far-edge.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' });
    const asked = s.wallet.state.log.map((entry) => entry.method);
    for (const method of SENDS_AND_SIGNATURES) assert.ok(!asked.includes(method), `${method} is never asked in preview`);
  } finally {
    await s.close();
  }
});

// Added 2026-10-06 (rugged's answer of 6 Oct, §3: performance-v2 is off on purpose, it is V1's "Start tracking", and V1 is
// off since 2026-10-05; "in V2, state and receipts come from read-v6's portfolio and activity"): in a build that carries V2,
// Managed positions is the vaults' card alone. V1's Performance, which asked performance-v2/epochs as soon as a session was
// signed in, is never mounted: nothing asks that route, signed out or in. Signed out, the one line for both cards stands as
// before; signed in, with Receipts drawn (V1's receipts unreadable here), Managed positions says its vaults appear here.
test('preview: integrated history never asks performance-v2 (V1\'s "Start tracking") and signing in creates no duplicate Managed card', async () => {
  const v1 = browserChain({ positions: [], tokens: TOKENS });
  const s = await openPreview(v1, '/positions');
  const { page } = s;
  const performance = () => s.requests.filter((url) => new URL(url).pathname.startsWith('/api/performance/'));
  try {
    const history = page.locator('[data-automation-cards="integrated"]');
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): the hidden marker (no line).
    await history.locator('[data-activity-error]').waitFor({ state: 'attached', timeout: 30_000 });
    assert.equal(await history.locator('section[aria-labelledby="receipts-title"]').count(), 1);
    // Signed in from the header's wallet dialog.
    await page.locator('header [aria-haspopup="dialog"]').click();
    await page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Sign in', exact: true }).click();
    await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in', null, { timeout: 30_000 });
    await page.keyboard.press('Escape');
    await history.locator('[data-activity-error]').waitFor({ state: 'attached', timeout: 30_000 });
    assert.equal(await page.locator('section[aria-labelledby="managed-title"], [data-v2in-vaults-empty], [data-automation-empty]').count(), 0, 'no duplicate empty or sign-in mural');
    await page.waitForTimeout(1_500);
    assert.equal(await page.locator('section[aria-label="Private performance"], [data-track-sequences], [data-performance]').count(), 0, 'no V1 history, no Start tracking');
    assert.deepEqual(performance(), [], 'performance-v2 is never asked');
    await history.screenshot({ path: join(shots(), 'v2in-history-signed-in-no-vaults.png'), animations: 'disabled' });
  } finally {
    await s.close();
  }
});

// ---------------------------------------------------------------------------
// Live, on the fake V2 vault chain
// ---------------------------------------------------------------------------

test('live: a root closed by the S1 exit (burned) keeps its vault\'s fees on its page; "Withdraw to wallet" takes both tokens in ONE wallet_sendCalls, and the card says so at once', async () => {
  const chain = createVaultChain({ chainId: 4663, atomic: 'ready', simulateV1: true, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -600, tickUpper: 600 }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: false });
  chain.setIdle(vault, USDG, 5_000_000n);
  chain.setIdle(vault, ZERO, 2_000_000_000_000_000n);
  chain.closeRoot(4, ROOT, { burn: true, by: ZAP });
  const portfolio = listing(chain, vault, { armed: false, reason: 'burned', reserves: [[ZERO, 2_000_000_000_000_000n], [USDG, 5_000_000n]], root: null, waiting: waitingOf('reserves_returnable') });
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ burned: true }) });
  const { page } = s;
  try {
    // V1's page says the NFT is gone; the vault, listed by owner, still shows what it holds.
    await page.locator('[data-empty="position-gone"]').waitFor({ timeout: 30_000 });
    const card = page.locator(`[data-automation-panel] section[data-vault-card="${vault}"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await card.getAttribute('data-vault-armed'), 'no');
    assert.equal(await card.getAttribute('data-vault-reserves'), 'held');
    assert.equal(await card.locator('[data-vault-pill]').innerText(), 'Closed');
    assert.equal(await card.locator('[data-vault-held] [data-reserves="held"]').innerText(), '0.002 ETH + 5 USDG');
    // rev4: the closed root's reserves reason is THE sentence (said first); §5.4's words moved under Details.
    assert.match(await card.locator('[data-vault-state][data-vault-waiting="reserves_returnable"]').innerText(), /^Your position is closed\. Its waiting fees are being returned to your wallet · since /);
    assert.match(await card.locator('[data-vault-details] [data-disarm-reason="3"]').textContent(), /^This position was closed\. Its automation has ended\./);
    // The condensed card (#8): the primary way out for a closed root, and Leave automation; the withdrawal and the hints under Details.
    assert.deepEqual(await card.locator('[data-vault-open]').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-vault-open'))), ['return', 'leave']);
    assert.deepEqual(await card.locator('[data-vault-more]').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-vault-more'))), ['withdraw']);
    assert.ok(await card.locator('[data-vault-details] [data-return-hint]').count());
    assert.equal(await card.locator('details[data-vault-details]').evaluate((details) => details.open), false, 'closed until opened');
    await page.locator('[data-automation-management]').screenshot({ path: join(shots(), 'v2in-reserves-burned-root.png'), animations: 'disabled' });

    await card.locator('details[data-vault-details] > summary').click();
    await card.locator('[data-vault-more="withdraw"]').click();
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="vault-withdraw"]');
    await dialog.waitFor();
    await dialog.locator('[data-wallet-steps="vault-withdraw"] li[data-wallet-step="withdraw-all-batch"]').waitFor({ timeout: 30_000 });
    assert.match(await dialog.locator('[data-vault-receive="withdraw"]').innerText(), /You receive\s+0\.002 ETH\s*5 USDG/);
    const press = dialog.locator('[data-v2in-send="withdraw"]');
    assert.equal(await press.innerText(), 'Withdraw in wallet');
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="withdraw"]')?.disabled === false, null, { timeout: 30_000 });
    assert.deepEqual(chain.sends, [], 'ready, for the person to confirm');
    assert.equal(chain.batches.length, 0);
    await press.click();
    await dialog.locator('[data-v2in-close]').waitFor({ timeout: 30_000 });

    assert.equal(chain.log.filter((method) => method === 'wallet_sendCalls').length, 1, 'one wallet prompt');
    assert.ok(!chain.log.includes('eth_sendTransaction'));
    const [batch] = chain.batches;
    assert.deepEqual(batch.calls.map((call) => [call.to.toLowerCase(), selectorOf(call.data)]), [[vault, SELECTOR.withdrawReserves], [vault, SELECTOR.withdrawReserves]]);
    assert.deepEqual(batch.calls.map((call) => vaultArgs(call.data)), [[ZERO, 2_000_000_000_000_000n, OWNER.toLowerCase()], [USDG, 5_000_000n, OWNER.toLowerCase()]], 'each names the owner as the recipient (#323)');
    assert.deepEqual(chain.paid.filter((p) => p.why === 'withdrawReserves').map((p) => [p.to, p.tokens[0], p.amounts[0]]), [[OWNER, ZERO, 2_000_000_000_000_000n], [OWNER, USDG, 5_000_000n]], 'everything to the owner, no fee');

    // The index has not caught up (the scripted answer is the same): the card shows the vault as read right after.
    await dialog.locator('[data-v2in-close]').click();
    await expandAutomation(page);
    const after = page.locator(`[data-automation-panel] section[data-vault-card="${vault}"][data-vault-source="chain"]`);
    await after.waitFor({ timeout: 30_000 });
    assert.equal(await after.getAttribute('data-vault-reserves'), 'none');
    assert.equal(await after.locator('[data-vault-open="withdraw"], [data-vault-open="return"], [data-vault-more="withdraw"], [data-vault-more="return"]').count(), 0, 'nothing left to withdraw is offered');
  } finally {
    await s.close();
  }
});

// Added 2026-10-04 (rugged97's delta of 4 Oct §2 item 1, #317): a withdrawal names its recipient.
test('live: a token that refuses the owner\'s wallet: Withdraw to wallet leads (never Return), says why before the wallet and offers "Send to another address you own"; the address typed (never the refusing wallet), the fees go there', async () => {
  const chain = createVaultChain({ chainId: 4663, simulateV1: true, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -600, tickUpper: 600 }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: false });
  chain.setIdle(vault, USDG, 5_000_000n);
  chain.closeRoot(4, ROOT, { burn: true, by: ZAP });
  chain.refuseTransfers(USDG, OWNER);
  const portfolio = listing(chain, vault, { armed: false, reason: 'burned', reserves: [[ZERO, 0n], [USDG, 5_000_000n]], root: null, waiting: waitingOf('reserves_unpayable') });
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ burned: true }) });
  const { page } = s;
  const other = OTHER.toLowerCase();
  try {
    const card = page.locator(`[data-automation-panel] section[data-vault-card="${vault}"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.match(await card.locator('[data-vault-state]').innerText(), /^Your position is closed, but your wallet can't receive one of the tokens\. Withdraw it from your automation · since /);
    // A return pays only the wallet that refuses: Withdraw to wallet leads, and Return is not offered.
    assert.deepEqual(await card.locator('[data-vault-open]').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-vault-open'))), ['withdraw', 'leave']);
    await card.locator('[data-vault-open="withdraw"]').click();
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="vault-withdraw"]');
    await dialog.waitFor();
    await dialog.locator(`[data-wallet-steps="vault-withdraw"] li[data-wallet-step="withdraw-${USDG}"]`).waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="withdraw"]')?.disabled === false, null, { timeout: 30_000 });
    await dialog.locator('[data-v2in-send="withdraw"]').click();
    // The simulation refuses before the wallet: the token's refusal in the spec's words, and the way out.
    const offer = dialog.locator('[data-v2in-send-elsewhere]');
    await offer.waitFor({ timeout: 30_000 });
    assert.match(await dialog.innerText(), /The transfer of USDG to your wallet failed\./);
    assert.equal(await offer.innerText(), 'Send to another address you own');
    assert.ok(!chain.log.includes('eth_sendTransaction'), 'nothing reached the wallet');
    await offer.click();
    const field = dialog.locator('[data-v2in-recipient]');
    await field.waitFor();
    assert.equal(await dialog.locator('[data-wallet-steps="vault-withdraw"]').count(), 0, 'nothing to confirm until an address is typed');
    await field.fill(OWNER);
    await dialog.locator('[data-v2in-recipient-problem]').waitFor({ timeout: 10_000 });
    assert.equal(await dialog.locator('[data-v2in-recipient-problem]').innerText(), "That's the wallet the transfer failed to. Choose another wallet you own.");
    await field.fill(OTHER);
    await dialog.locator(`[data-v2in-sent-to="${other}"]`).waitFor({ timeout: 10_000 });
    await dialog.locator(`li[data-wallet-step="withdraw-${USDG}"]`).waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="withdraw"]')?.disabled === false, null, { timeout: 30_000 });
    await dialog.screenshot({ path: join(shots(), 'v2in-withdraw-elsewhere.png'), animations: 'disabled' });
    await dialog.locator('[data-v2in-send="withdraw"]').click();
    await dialog.locator('[data-v2in-close]').waitFor({ timeout: 30_000 });
    const sent = chain.sends.at(-1);
    assert.deepEqual([sent.to.toLowerCase(), selectorOf(sent.data)], [vault, SELECTOR.withdrawReserves]);
    assert.deepEqual(vaultArgs(sent.data), [USDG, 5_000_000n, other], 'the named address, all of the USDG');
    assert.deepEqual(chain.paid.filter((p) => p.why === 'withdrawReserves').map((p) => [p.to, p.tokens[0], p.amounts[0]]), [[other, USDG, 5_000_000n]]);
  } finally {
    await s.close();
  }
});

test('live: a root closed directly on Uniswap, the vault paused: Managed positions lists it with the fees waiting (by owner, never from the NFT); on its page "Return my reserves" sends returnReserves(), both tokens to the owner, no fee', async () => {
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -600, tickUpper: 600 }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  chain.setIdle(vault, USDG, 5_000_000n);
  chain.setIdle(vault, ZERO, 2_000_000_000_000_000n);
  chain.closeRoot(4, ROOT);
  const portfolio = listing(chain, vault, { armed: false, reason: 'changed_outside_domino', paused: true, pausedBy: 'owner', reserves: [[ZERO, 2_000_000_000_000_000n], [USDG, 5_000_000n]], root: { owner: OWNER, liquidity: 0n } });
  const s = await openLive(chain, { hash: '/positions', read6: { portfolio }, v1: rootOnV1() });
  const { page } = s;
  try {
    const row = page.locator(`[data-v2-position-row="4663:${portfolio.body.positions[0].positionManager.toLowerCase()}:${ROOT}"]`);
    await row.waitFor({ timeout: 30_000 });
    assert.match(await row.innerText(), /Auto-compound/);
    assert.match(await row.locator('.dm-own-state').innerText(), /Closed/);
    assert.match(await row.innerText(), /Funds available in automation/);
    assert.equal(await row.locator('[data-v2-chain="4663"]').count(), 1);
    assert.equal(await row.locator('button').count(), 0, 'overview only navigates');
    assert.equal(await row.locator('[data-vault-idle], [data-return-hint], [data-vault-details]').count(), 0, 'the row carries no detail');
    const link = row;
    assert.equal(await link.getAttribute('href'), `#/positions/robinhood-v4-${ROOT}`);
    assert.equal(await page.locator('[data-v2in-vaults], [data-automation-recovery]').count(), 0, 'the listed root owns the recovery hint once');
    await row.screenshot({ path: join(shots(), 'v2in-managed-closed-root.png'), animations: 'disabled' });

    await link.click();
    await expandAutomation(page);
    const card = page.locator(`[data-automation-panel] section[data-vault-card="${vault}"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await card.locator('[data-vault-held] [data-reserves="held"]').innerText(), '0.002 ETH + 5 USDG');
    // Nothing waits: §5.4's sentence is THE sentence, with its reason.
    assert.equal(await card.locator('[data-vault-state]').getAttribute('data-disarm-reason'), '2');
    assert.match(await card.locator('[data-vault-state]').innerText(), /^This position was changed outside Domino\. · since /);
    // §5.6's second figure, the idle part (here everything is idle), under Details with the return hint.
    assert.match(await card.locator('[data-vault-details] [data-vault-idle]').textContent(), /Not used by automation\s*0\.002 ETH \+ 5 USDG/);
    assert.ok(await card.locator('[data-vault-details] [data-return-hint]').count());
    assert.deepEqual(await card.locator('[data-vault-open]').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-vault-open'))), ['return', 'leave']);
    await card.locator('[data-vault-open="return"]').click();
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="vault-return"]');
    await dialog.waitFor();
    // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
    assert.match(await dialog.locator('[data-vault-lede="return"]').innerText(), /^Your position is closed, so everything your automation holds can go back to your wallet in one transaction\. The fees your automation holds go to your wallet, and only to it\./);
    await dialog.locator('[data-wallet-step="return-reserves"]').waitFor({ timeout: 30_000 });
    assert.equal(await dialog.locator('[data-v2in-send="return"]').innerText(), 'Confirm in wallet');
    assert.equal(await dialog.locator('[data-vault-note="vault_returns_to_owner"]').count(), 0, 'the lede already says it: not twice');
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="return"]')?.disabled === false, null, { timeout: 30_000 });
    assert.deepEqual(chain.sends, [], 'ready, for the person to confirm');
    await dialog.locator('[data-v2in-send="return"]').click();
    await dialog.locator('[data-v2in-close]').waitFor({ timeout: 30_000 });

    const sent = chain.sends.at(-1);
    assert.deepEqual([sent.to.toLowerCase(), sent.data], [vault, SELECTOR.returnReserves], 'returnReserves(), no arguments');
    assert.equal(chain.sends.length, 1, 'one transaction for both tokens');
    assert.deepEqual(chain.paid.filter((p) => p.why === 'returnReserves').map((p) => [p.to, p.tokens[0], p.amounts[0]]), [[OWNER, ZERO, 2_000_000_000_000_000n], [OWNER, USDG, 5_000_000n]]);
    await dialog.locator('[data-v2in-close]').click();
    await expandAutomation(page);
    await page.locator(`[data-automation-panel] section[data-vault-card="${vault}"][data-vault-source="chain"][data-vault-reserves="none"]`).waitFor({ timeout: 30_000 });
  } finally {
    await s.close();
  }
});

test('live: "Leave automation" on a running vault\'s page sends exitAll() (the reserves back in the same action), then offers v4\'s follow-ups: removing Domino sends the position manager\'s unsubscribe', async () => {
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -600, tickUpper: 600 }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: false });
  chain.setIdle(vault, USDG, 4_000_000n);
  // Added 2026-10-04 (rugged97's delta of 4 Oct §2 item 3, #319): auto-exit on, so Leave automation says it pauses the orders.
  chain.setExitModule(vault, AUTO_EXIT);
  const liquidity = chain.nft(4, ROOT).liquidity;
  const portfolio = listing(chain, vault, { armed: true, reserves: [[ZERO, 0n], [USDG, 4_000_000n]], root: { owner: OWNER, liquidity } });
  // The post-exit balance refresh may finish while the next wallet confirmation is open. Keep both promises under
  // the test's control so a parent rerender cannot silently abandon the unsubscribe already offered to the wallet.
  const credits = Promise.withResolvers();
  const sending = Promise.withResolvers();
  const walletReply = Promise.withResolvers();
  const request = chain.request;
  const unclaimed = toFunctionSelector('unclaimed(address,address)');
  chain.request = async (method, params) => {
    const data = params?.[0]?.data ?? '';
    if (method === 'eth_call' && data.startsWith(unclaimed) && chain.sends.some(tx => tx.data === SELECTOR.exitAll)) await credits.promise;
    if (method === 'eth_sendTransaction' && data.startsWith(SELECTOR.unsubscribe)) {
      sending.resolve();
      await walletReply.promise;
    }
    return request(method, params);
  };
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ liquidity }) });
  const { page } = s;
  try {
    const card = page.locator(`[data-automation-panel] section[data-vault-card="${vault}"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await card.getAttribute('data-vault-status'), 'on');
    assert.equal(await card.getAttribute('data-vault-armed'), 'yes');
    assert.equal(await card.locator('[data-vault-pill]').innerText(), 'Automation on');
    // A running vault: the spec's own sentence (§2.13), the fees waiting, Withdraw to wallet and Leave automation; Pause under Details.
    // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
    assert.equal(await card.locator('[data-vault-state]').innerText(), 'Earned fees go back into this position.');
    assert.doesNotMatch(await card.innerText(), /vault/i);
    assert.deepEqual(await card.locator('[data-vault-open]').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-vault-open'))), ['withdraw', 'leave']);
    assert.deepEqual(await card.locator('[data-vault-more]').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-vault-more'))), ['pause']);
    // Changed on purpose 2026-10-30 (QA round 2, final review shell-3, the owner's Q1): the fee in Automate's one wording.
    assert.match(await card.locator('[data-vault-details]').textContent(), /Auto-compound: 2% of the earned fees it uses, each time/);
    assert.doesNotMatch(await card.locator('[data-vault-details]').textContent(), /reinvested fees/);
    // Auto-exit is separate from compounding (rugged97, 2026-10-06): a running Auto-compound is never offered it.
    await page.locator('[data-position-actions] [data-position-v2-more]').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-position-v2-action="protect"]').count(), 0, 'no Auto-exit on a running Auto-compound');
    assert.equal(await page.locator(`[data-automation-panel] [data-v2in-exit]:not([hidden])`).count(), 0, 'and no Auto-exit card');
    await card.locator('[data-vault-open="leave"]').click();
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="vault-leave"]');
    await dialog.waitFor();
    // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
    assert.equal(await dialog.locator('[data-vault-lede="leave"]').innerText(), `Your next positions and everything your automation can pay go to your wallet in one action, and position #${ROOT} stops being automated. No fee.`);
    assert.equal(await dialog.locator('[data-leave-v4]').innerText(), `Afterwards you can remove Domino from position #${ROOT} and revoke your automation's approval on it.`);
    assert.equal(await dialog.locator('[data-v2in-send="leave"]').innerText(), 'Confirm in wallet');
    await dialog.locator('[data-wallet-step="exit-all"]').waitFor({ timeout: 30_000 });
    assert.equal(await dialog.locator('[data-vault-note="vault_exit_all_pauses_orders"]').innerText(), 'This also pauses Auto-exit. You can turn it back on later.');
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="leave"]')?.disabled === false, null, { timeout: 30_000 });
    assert.deepEqual(chain.sends, [], 'for the person to confirm');
    await dialog.locator('[data-v2in-send="leave"]').click();
    await dialog.locator('[data-leave-follow-ups]').waitFor({ timeout: 30_000 });

    assert.deepEqual([chain.sends.at(-1).to.toLowerCase(), chain.sends.at(-1).data], [vault, SELECTOR.exitAll], 'exitAll(), never a direct close of the root');
    assert.deepEqual(chain.paid.filter((p) => p.why === 'exitAll').map((p) => [p.to, p.tokens[0], p.amounts[0]]), [[OWNER, USDG, 4_000_000n]], 'the reserves back in the same action');
    assert.equal(chain.vault(vault).disarmed, true);
    assert.equal(chain.vault(vault).exitModule, ZERO, 'auto-exit off with it: the orders pause (#319)');

    // v4's follow-ups (§5.6), each the person's own step: Remove Domino from this position.
    await dialog.locator('[data-v2in-follow="unsubscribe"]').click();
    await dialog.locator('h2', { hasText: 'Remove Domino from this position' }).waitFor();
    assert.equal(await dialog.locator('[data-vault-lede="unsubscribe"]').innerText(), `Domino is no longer notified of changes to position #${ROOT}. Your position stays in your wallet.`);
    assert.equal(await dialog.locator('[data-vault-receive]').count(), 0, 'a follow-up pays nothing');
    await dialog.locator('[data-wallet-step="unsubscribe"]').waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="leave"]')?.disabled === false, null, { timeout: 30_000 });
    const priorCreditReplies = await page.evaluate(() => window.__dominoUnclaimedReplies ?? 0);
    await dialog.locator('[data-v2in-send="leave"]').click();
    await sending.promise;
    credits.resolve();
    await page.waitForFunction(before => (window.__dominoUnclaimedReplies ?? 0) > before, priorCreditReplies);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await dialog.locator('[data-v2in-send="leave"]').isDisabled(), true, 'an unrelated balance refresh cannot unlock a confirmation still pending in the wallet');
    walletReply.resolve();
    await dialog.locator('[data-v2in-close]').waitFor({ timeout: 30_000 });
    const sent = chain.sends.at(-1);
    assert.deepEqual([sent.to.toLowerCase(), selectorOf(sent.data)], [chain.positionManager[4].toLowerCase(), SELECTOR.unsubscribe]);
    assert.equal(chain.sends.filter(tx => selectorOf(tx.data) === SELECTOR.unsubscribe).length, 1, 'the pending follow-up is sent exactly once across the balance refresh');
    assert.equal(chain.nft(4, ROOT).subscriber, ZERO, 'Domino no longer notified');
    // The other follow-up stays offered until done.
    assert.deepEqual(await dialog.locator('[data-v2in-follow]').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-v2in-follow'))), ['revoke-approval']);
    await dialog.screenshot({ path: join(shots(), 'v2in-leave-automation.png'), animations: 'disabled' });
  } finally {
    credits.resolve();
    walletReply.resolve();
    await s.close();
  }
});

// Added 2026-10-04 (rugged97's delta of 4 Oct §2 item 3, #319): Leave automation turns auto-exit off; its orders pause.
// Added 2026-11-02 (the owner: who leaves automation can turn it back on).
test('live: after Leave automation made here, "Turn back on" sends rearm(true), then resume(): automation runs again with the settings it had', async () => {
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -600, tickUpper: 600 }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: false });
  const liquidity = chain.nft(4, ROOT).liquidity;
  const portfolio = listing(chain, vault, { armed: true, reserves: [[ZERO, 0n], [USDG, 0n]], root: { owner: OWNER, liquidity } });
  const policy = { ...chain.vault(vault).policy };
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ liquidity }) });
  const { page } = s;
  try {
    const card = page.locator(`[data-automation-panel] section[data-vault-card="${vault}"]`);
    await card.waitFor({ timeout: 30_000 });
    await card.locator('[data-vault-open="leave"]').click();
    const leave = page.locator('[role="dialog"][data-v2in-dialog="vault-leave"]');
    await leave.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="leave"]')?.disabled === false, null, { timeout: 30_000 });
    await leave.locator('[data-v2in-send="leave"]').click();
    await leave.locator('[data-v2in-close]').waitFor({ timeout: 30_000 });
    await leave.locator('[data-v2in-close]').click();
    assert.equal(chain.vault(vault).disarmed, true);
    assert.equal(chain.vault(vault).paused, true);

    await expandAutomation(page);
    const again = card.locator('[data-vault-open="rearm"]');
    await again.waitFor({ timeout: 30_000 });
    assert.equal(await again.innerText(), 'Turn back on');
    await again.click();
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="vault-rearm"]');
    await dialog.waitFor();
    assert.equal(await dialog.locator('h2').innerText(), 'Turn back on');
    assert.equal(await dialog.locator('[data-vault-lede]').innerText(), 'Automation starts again for this position, with the settings it had. Confirm each step in your wallet.');
    await dialog.locator('[data-rearm-consent]').check();
    await dialog.locator('[data-wallet-steps="vault-rearm"] li[data-wallet-step="resume"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(await dialog.locator('[data-wallet-steps="vault-rearm"] li').evaluateAll((items) => items.map((li) => li.getAttribute('data-wallet-step'))), ['rearm', 'resume']);
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="rearm"]')?.disabled === false, null, { timeout: 30_000 });
    const before = chain.sends.length;
    await dialog.locator('[data-v2in-send="rearm"]').click();
    await dialog.locator('[data-v2in-close]').waitFor({ timeout: 60_000 });
    assert.deepEqual(chain.sends.slice(before).map((tx) => [tx.to.toLowerCase(), selectorOf(tx.data)]), [[vault, toFunctionSelector('rearm(bool)')], [vault, toFunctionSelector('resume()')]]);
    assert.equal(chain.vault(vault).disarmed, false);
    assert.equal(chain.vault(vault).paused, false);
    assert.deepEqual(chain.vault(vault).policy, policy, 'the settings it had');
    await dialog.locator('[data-v2in-close]').click();
    await page.locator(`section[data-vault-card="${vault}"][data-vault-status="on"]`).waitFor({ state: 'attached', timeout: 30_000 });
    await expandAutomation(page);
    assert.equal(await card.locator('[data-vault-pill]').innerText(), 'Automation on');
    assert.equal(await card.locator('[data-vault-open="rearm"]').count(), 0);
  } finally {
    await s.close();
  }
});

test('live: left automation on an earlier visit, its position approved elsewhere since: "Turn back on" asks the approval first, then rearm(true), then resume()', async () => {
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -600, tickUpper: 600 }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  chain.disarm(vault, 7);
  const liquidity = chain.nft(4, ROOT).liquidity;
  chain.approveOther(4, ROOT, '0x00000000000000000000000000000000000000AA');
  const portfolio = listing(chain, vault, { armed: false, reason: 'exit_all', paused: true, pausedBy: 'unknown', reserves: [[ZERO, 0n], [USDG, 0n]], root: { owner: OWNER, liquidity } });
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ liquidity }) });
  const { page } = s;
  try {
    const card = page.locator(`[data-automation-panel] section[data-vault-card="${vault}"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.match(await card.locator('[data-vault-state]').innerText(), /^You ended your automation\./);
    await card.locator('[data-vault-open="rearm"]').click();
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="vault-rearm"]');
    await dialog.waitFor();
    await dialog.locator('[data-rearm-consent]').check();
    await dialog.locator('[data-wallet-steps="vault-rearm"] li[data-wallet-step="resume"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(await dialog.locator('[data-wallet-steps="vault-rearm"] li').evaluateAll((items) => items.map((li) => li.getAttribute('data-wallet-step'))), ['approve-root', 'rearm', 'resume']);
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="rearm"]')?.disabled === false, null, { timeout: 30_000 });
    await dialog.locator('[data-v2in-send="rearm"]').click();
    await dialog.locator('[data-v2in-close]').waitFor({ timeout: 60_000 });
    assert.deepEqual(chain.sends.map((tx) => selectorOf(tx.data)), [toFunctionSelector('approve(address,uint256)'), toFunctionSelector('rearm(bool)'), toFunctionSelector('resume()')]);
    assert.equal(chain.vault(vault).disarmed, false);
    assert.equal(chain.vault(vault).paused, false);
  } finally {
    await s.close();
  }
});

test('live: an Auto-exit paused because auto-exit is off offers "Turn back on": one step, setExitModule(autoExit), as signed', async () => {
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -600, tickUpper: 600 }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  const liquidity = chain.nft(4, ROOT).liquidity;
  assert.equal(chain.vault(vault).exitModule, ZERO, 'auto-exit off, as Leave automation leaves it');
  const portfolio = listing(chain, vault, {
    armed: true, paused: true, pausedBy: 'owner', reserves: [[ZERO, 0n], [USDG, 0n]], root: { owner: OWNER, liquidity },
    orders: (fixture) => fixture.map((order) => ({ ...order, tokenId: String(ROOT), blockedBy: ['module_disabled'], moduleEnabled: false })),
  });
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ liquidity }) });
  const { page } = s;
  try {
    const card = page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="paused"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await card.locator('[data-exit-pill]').innerText(), 'Paused');
    // Changed on purpose 2026-10-06 (the final check, F8): the pause by its cause, never "turned off" beside "Turn off".
    assert.equal(await card.locator('[data-v2in-exit-line="paused"]').innerText(), "Paused: your automation doesn't allow Auto-exit right now.");
    assert.equal(await card.locator('[data-exit-off]').innerText(), 'Turn off');
    assert.doesNotMatch(await card.innerText(), /turned off/i);
    // Changed on purpose 2026-10-06 (the integration review, rugged-literal #2): Leave automation's pause (the module off)
    // keeps the automation Auto-exit's: this one card, never a second "Automation" card in compounding's words.
    assert.equal(await page.locator(`[data-automation-panel] [data-vault-card]`).count(), 0, 'one card for one product');
    const turnOn = card.locator('[data-order-module-on]');
    assert.equal(await turnOn.innerText(), 'Turn back on');
    await turnOn.click();
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="module-on"]');
    await dialog.waitFor();
    // Changed on purpose 2026-10-06 (the integration review, money #4): what it does, never "works again, nothing else
    // changes"; the pool's price read first (the order's lower end, 0.5 in raw units, is far under the price here).
    assert.equal(await dialog.locator('.dm-receipt-lede').innerText(), 'Auto-exit is turned back on as you signed it: Domino closes this position when the price reaches the end of your range.');
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="module-on"]')?.disabled === false, null, { timeout: 30_000 });
    assert.ok(chain.callsSince(0).some((c) => c.calls.includes('stateView.getSlot0')), 'the pool\'s price, read before the wallet');
    assert.equal(await dialog.locator('[data-exit-past]').count(), 0, 'no end passed: nothing to warn of');
    assert.deepEqual(chain.sends, [], 'for the person to confirm');
    await dialog.locator('[data-v2in-send="module-on"]').click();
    await dialog.locator('[data-v2in-close]').waitFor({ timeout: 30_000 });
    const sent = chain.sends.at(-1);
    assert.deepEqual([sent.to.toLowerCase(), selectorOf(sent.data)], [vault, SELECTOR.setExitModule]);
    assert.equal(chain.vault(vault).exitModule, AUTO_EXIT, 'auto-exit on again: the paused orders can fire');
    await dialog.screenshot({ path: join(shots(), 'v2in-auto-exit-back-on.png'), animations: 'disabled' });
    // Added 2026-10-06 (the final check, F2): on at once, from the step's own receipt, while the index still lists the pause;
    // no "Turn back on" left that would stop at "This step is already done.".
    await dialog.locator('[data-v2in-close]').click();
    await dialog.waitFor({ state: 'detached' });
    await expandAutomation(page);
    const on = page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="on"]`);
    await on.waitFor({ timeout: 30_000 });
    assert.equal(await on.locator('[data-exit-pill]').innerText(), 'On');
    assert.match(await on.locator('[data-v2in-exit-line="on"]').innerText(), /^Closes at /);
    assert.equal(await on.locator('[data-order-module-on]').count(), 0, 'nothing left to turn back on');
    assert.equal(await on.locator('[data-exit-off]').innerText(), 'Turn off');
    assert.equal(chain.sends.length, 1, 'one step, nothing more sent');
  } finally {
    await s.close();
  }
});

// Added 2026-10-06 (the final check F2's review): Leave automation made on an earlier visit and indexed (the vault paused,
// its module off, its root disarmed: exit_all), the order waiting with the record the automation writes for it
// (`exit_module_not_enabled`, no contract error). "Turn back on" made here: on at once, nothing left of that record. Then
// "Turn off": off at once, and Auto-exit can be turned on again ("Turn on", its automation's rearm first), as once the
// index lists both, while it still lists the pause and the order active.
test('live: after Leave automation, "Turn back on" then "Turn off" made here: on without the module\'s old waiting line, then off with "Turn on" offered again', async () => {
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -600, tickUpper: 600 }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  chain.disarm(vault, 7);
  const liquidity = chain.nft(4, ROOT).liquidity;
  assert.equal(chain.vault(vault).exitModule, ZERO, 'auto-exit off, as Leave automation leaves it');
  const portfolio = listing(chain, vault, {
    armed: false, reason: 'exit_all', paused: true, pausedBy: 'owner', reserves: [[ZERO, 0n], [USDG, 0n]], root: { owner: OWNER, liquidity },
    orders: (fixture) => fixture.map((order) => ({ ...order, tokenId: String(ROOT), blockedBy: ['module_disabled'], moduleEnabled: false, waiting: waitingOf('exit_module_not_enabled') })),
  });
  // That order on the chain's module, registered on that earlier visit (the fixture's own id and terms), active.
  const [order] = portfolio.body.mandates;
  const id = order.mandateHash.toLowerCase();
  chain.module().status.set(id, 1);
  chain.module().records.set(id, {
    signer: OWNER.toLowerCase(), signature: '0x',
    view: { owner: OWNER.toLowerCase(), validUntil: BigInt(order.validUntil), maxSlippageBps: order.terms.maxSlippageBps, receiveMode: 1, vault: vault.toLowerCase(), convertTo: order.terms.convertTo, triggerBelowSqrtPriceX96: BigInt(order.terms.triggerBelowSqrtPriceX96), triggerAboveSqrtPriceX96: 0n, tokenId: ROOT },
  });
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ liquidity }) });
  const { page } = s;
  const card = (state) => page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="${state}"]`);
  try {
    await card('paused').waitFor({ timeout: 30_000 });
    await card('paused').locator('[data-order-module-on]').click();
    const back = page.locator('[role="dialog"][data-v2in-dialog="module-on"]');
    await back.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="module-on"]')?.disabled === false, null, { timeout: 30_000 });
    await back.locator('[data-v2in-send="module-on"]').click();
    await back.locator('[data-v2in-close]').waitFor({ timeout: 30_000 });
    await back.locator('[data-v2in-close]').click();
    await back.waitFor({ state: 'detached' });
    await expandAutomation(page);
    const on = card('on');
    await on.waitFor({ timeout: 30_000 });
    assert.match(await on.locator('[data-v2in-exit-line="on"]').innerText(), /^Closes at /);
    assert.equal(await on.locator('[data-order-waiting]').count(), 0, 'the automation\'s record of the module off is gone with it: no bare "Waiting" line');

    await on.locator('[data-exit-off]').click();
    const off = page.locator('[role="dialog"][data-v2in-dialog="cancel-order"]');
    await off.waitFor();
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="cancel-order"]')?.disabled === false, null, { timeout: 30_000 });
    await off.locator('[data-v2in-send="cancel-order"]').click();
    await off.locator('[data-v2in-close]').waitFor({ timeout: 30_000 });
    assert.equal(chain.module().status.get(id), 2, 'revoked');
    await off.locator('[data-v2in-close]').click();
    await off.waitFor({ state: 'detached' });
    await expandAutomation(page);
    const none = card('off');
    await none.waitFor({ timeout: 30_000 });
    assert.equal(await none.locator('[data-exit-pill]').innerText(), 'Off');
    assert.equal(await none.locator('[data-v2in-exit-line="open"]').innerText(), 'Auto-exit is off. Turn it on to close this position at the end of its range.');
    const turnOn = none.locator('[data-vault-open="rearm"]');
    assert.equal(await turnOn.innerText(), 'Turn on');
    await none.locator('[data-exit-details] > summary').click();
    assert.equal(await none.locator('[data-exit-history]').count(), 0, 'history belongs to Activity');
    await none.screenshot({ path: join(shots(), 'v2in-autoexit-back-on-then-off.png'), animations: 'disabled' });
    await turnOn.click();
    const rearm = page.locator('[role="dialog"][data-v2in-dialog="vault-rearm"]');
    await rearm.waitFor();
    assert.equal(await rearm.locator('h2').innerText(), 'Turn on Auto-exit');
    assert.equal(await rearm.locator('[data-vault-lede]').getAttribute('data-vault-exit-rearm'), 'turn-on');
    assert.deepEqual(chain.sends.map((tx) => [tx.to.toLowerCase(), selectorOf(tx.data)]), [[vault.toLowerCase(), SELECTOR.setExitModule], [AUTO_EXIT, SELECTOR.revokeMandate]], 'nothing more sent');
  } finally {
    await s.close();
  }
});

// Added 2026-10-06 (the integration review, money #4): the module has no latch; an end the price passed while Auto-exit was
// paused closes the position on Domino's next pass. Said before the wallet opens, with a tick, and "Turn off instead".
test('live: "Turn back on" with the price already past the end of the range warns first: nothing is sent until the tick; "Turn off instead" opens Auto-exit\'s own Turn off', async () => {
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -600, tickUpper: 600 }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  // The order's lower end is 0.5 (2^95 in sqrt price): the pool now sits at 0.25, past it.
  chain.setPrice(4, KEY, 2n ** 94n);
  const liquidity = chain.nft(4, ROOT).liquidity;
  const portfolio = listing(chain, vault, {
    armed: true, paused: true, pausedBy: 'owner', reserves: [[ZERO, 0n], [USDG, 0n]], root: { owner: OWNER, liquidity },
    orders: (fixture) => fixture.map((order) => ({ ...order, tokenId: String(ROOT), blockedBy: ['module_disabled'], moduleEnabled: false })),
  });
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ liquidity }) });
  const { page } = s;
  try {
    const card = page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="paused"]`);
    await card.waitFor({ timeout: 30_000 });
    await card.locator('[data-order-module-on]').click();
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="module-on"]');
    await dialog.waitFor();
    const past = dialog.locator('[data-exit-past]');
    await past.waitFor({ timeout: 30_000 });
    assert.equal(await past.locator('[data-exit-past-note]').innerText(), "The price is already past the end of your range. Turning Auto-exit back on closes this position at today's price, with the 0.2% fee.");
    await dialog.locator('li[data-wallet-step="set-exit-module"]').waitFor({ timeout: 30_000 });
    assert.equal(await dialog.locator('[data-v2in-send="module-on"]').isDisabled(), true, 'held until the tick');
    await dialog.screenshot({ path: join(shots(), 'v2in-auto-exit-back-on-past.png'), animations: 'disabled' });
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const overflow = await dialog.evaluate((node) => [node, node.querySelector('.dm-flow-dialog-body')].some((el) => el && el.scrollWidth > el.clientWidth + 1));
      assert.equal(overflow, false, `no horizontal overflow at ${width}`);
      await dialog.screenshot({ path: join(shots(), `v2in-auto-exit-back-on-past-${width}.png`), animations: 'disabled' });
    }
    await page.setViewportSize({ width: 1280, height: 1000 });
    // "Turn off instead": Auto-exit's own Turn off, after which Turn on arms only the ends still ahead.
    await past.locator('[data-exit-past-off]').click();
    const off = page.locator('[role="dialog"][data-v2in-dialog="cancel-order"]');
    await off.waitFor({ timeout: 30_000 });
    assert.equal(await off.locator('h2').innerText(), 'Turn off Auto-exit');
    await off.getByRole('button', { name: 'Close' }).click();
    await off.waitFor({ state: 'detached' });
    // Or on anyway, ticked: then, and only then, the one step.
    await expandAutomation(page);
    await card.locator('[data-order-module-on]').click();
    await dialog.waitFor();
    await past.waitFor({ timeout: 30_000 });
    await dialog.locator('li[data-wallet-step="set-exit-module"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(chain.sends, [], 'nothing sent');
    await past.locator('[data-exit-past-ack]').check();
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="module-on"]')?.disabled === false, null, { timeout: 30_000 });
    await dialog.locator('[data-v2in-send="module-on"]').click();
    await dialog.locator('[data-v2in-close]').waitFor({ timeout: 30_000 });
    assert.deepEqual([chain.sends.at(-1).to.toLowerCase(), selectorOf(chain.sends.at(-1).data)], [vault, SELECTOR.setExitModule]);
  } finally {
    await s.close();
  }
});

// Added 2026-10-06 (the owner's point 5): a position in its protection-only automation with its Auto-exit on.
test('live: a protection-only automation with its Auto-exit on is ONE card: "Closes at …" from the listed edges, "Turn off", no automation card, no second Auto-exit; Set up automation offers it neither a second Auto-exit nor compounding', async () => {
  const liquidity = 10n ** 18n;
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -201060, tickUpper: -198060, liquidity }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  chain.setExitModule(vault, AUTO_EXIT);
  const [below, above] = [sqrtPriceAtTick(-201060), sqrtPriceAtTick(-198060)];
  const portfolio = listing(chain, vault, {
    armed: true, paused: true, pausedBy: 'owner', autoExit: true, reserves: [[ZERO, 0n], [USDG, 0n]], root: { owner: OWNER, liquidity },
    orders: (fixture) => fixture.slice(0, 1).map((order) => ({ ...order, tokenId: String(ROOT), status: 'active', expired: false, blockedBy: [], moduleEnabled: true, waiting: waitingOf('trigger_not_reached'), executed: null, revoked: null, terms: { triggerBelowSqrtPriceX96: String(below), triggerAboveSqrtPriceX96: String(above), receive: 'both', convertTo: null, maxSlippageBps: 100 } })),
  });
  // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §8): V1's sequence profile has ended, as after 21 Oct.
  const released = [];
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ liquidity }), routes: [v1SequenceGone(released)] });
  const { page } = s;
  try {
    const mount = page.locator(`[data-v2in-position="${ROOT}"][data-v2in-mode="live"]`);
    const card = page.locator('[data-automation-panel] [data-v2in-exit][data-exit-state="on"]');
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-automation-management] h2').innerText(), 'Auto-exit');
    assert.equal(await card.locator('[data-exit-pill]').innerText(), 'On');
    // Changed on purpose 2026-10-06 (the review of point 5): the title and the pill say "Auto-exit" and "On"; the line where.
    assert.match(await card.locator('[data-v2in-exit-line="on"]').innerText(), /^Closes at 1,855\.72 – 2,504\.92 USDG per ETH$/);
    assert.equal(await card.locator('[data-exit-off]').innerText(), 'Turn off');
    assert.equal(await card.locator('[data-order-waiting]').count(), 0, 'waiting for an edge is what it does: its line says where it closes');
    assert.equal(await mount.locator(`[data-vault-card="${vault}"]`).count(), 0, 'its automation is this card, not a second one');
    await page.locator('[data-position-actions] [data-position-v2-more]').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-position-v2-action="protect"]').count(), 0, 'one Auto-exit per position: no second one offered');
    assert.doesNotMatch(await card.innerText(), /vault|stop-loss|take-profit|order/i);
    await page.keyboard.press('Escape');
    await page.locator('[data-automation-management]').waitFor({ state: 'detached' });
    const valueFigure = page.locator('[data-position-overview] [data-cell="principal"] .dm-tick-fig');
    const fullValue = await valueFigure.textContent();
    assert.match(fullValue, /^\$[\d,]+\.\d{2}$/);
    for (const width of [1440, 1220, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.screenshot({ path: join(shots(), `position-autoexit-${width}.png`), fullPage: true, animations: 'disabled' });
      assert.equal(await valueFigure.textContent(), fullValue, `the complete principal amount remains at ${width}`);
      assert.equal(await valueFigure.evaluate(node => {
        const cell = node.closest('[data-cell]').getBoundingClientRect();
        return [...node.querySelectorAll('.dm-tick-d, .dm-position-amount-group')].every(digit => { const box = digit.getBoundingClientRect(); return box.left >= cell.left && box.right <= cell.right; });
      }), true, `every principal digit stays within its own card at ${width}`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `position with Auto-exit fits ${width}`);
      assert.equal(await page.locator('[data-position-actions] [data-automation-control]').count(), 1, 'Auto-exit remains beside the position actions');
    }
    await expandAutomation(page);
    await card.screenshot({ path: join(shots(), 'v2in-autoexit-card-on.png'), animations: 'disabled' });
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.screenshot({ path: join(shots(), `automation-management-autoexit-${width}.png`), fullPage: true, animations: 'disabled' });
      assert.equal(await page.locator('[data-automation-management] .dm-pa-body').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, `Auto-exit management fits at ${width}`);
    }
    await page.setViewportSize({ width: 1280, height: 1000 });
    // Changed on purpose 2026-10-06 (the integration review, rugged-literal #2): Leave automation (exitAll) turns the module
    // off, so Auto-exit pauses; it never ends it (Turn off does), and the review's note does not say it twice.
    await card.locator('[data-exit-details] > summary').click();
    await card.locator('[data-vault-more="leave"]').click();
    const leave = page.locator('[role="dialog"][data-v2in-dialog="vault-leave"]');
    await leave.waitFor();
    assert.equal(await leave.locator('[data-vault-lede="leave"]').innerText(), `Auto-exit pauses for position #${ROOT}, and anything your automation holds goes to your wallet. No fee. Turn off ends it for good.`);
    await leave.locator('[data-wallet-step="exit-all"]').waitFor({ timeout: 30_000 });
    assert.equal(await leave.locator('[data-vault-note="vault_exit_all_pauses_orders"]').count(), 0, 'the lede already says it: not twice');
    assert.doesNotMatch(await leave.innerText(), /for good, and|stops for position/);
    // Changed on purpose 2026-10-06 (the integration review's second pass): while Auto-exit is on, nothing offers to remove
    // Domino from the position or revoke its approval afterwards (an exit needs that approval).
    assert.equal(await leave.locator('[data-leave-v4]').count(), 0, 'no "remove Domino and revoke its approval" while Auto-exit is on');
    await leave.screenshot({ path: join(shots(), 'v2in-autoexit-leave.png'), animations: 'disabled' });
    await leave.getByRole('button', { name: 'Close' }).click();
    await leave.waitFor({ state: 'detached' });
    assert.deepEqual(chain.sends, [], 'nothing sent');
    // Set up automation offers it neither a second Auto-exit nor compounding (rugged97: "auto-exit has no fee compounding").
    await page.evaluate((id) => { location.hash = `#/sequence/protection/${id}`; }, String(ROOT));
    // The multichain picker also checks Base and Arbitrum; this fixture explicitly leaves those reads unavailable.
    // Changed on purpose 2026-10-30 (QA round 2, the owner's rule: missing information stays out of sight, and the review):
    // an answer that came back with those networks behind and nothing to offer is the plate at once, never endless loading
    // rows or failure words; the portfolio is still asked again by itself, and a list would replace the plate.
    const setup = page.locator('[data-sequence-positions="empty"]');
    await setup.waitFor({ timeout: 30_000 });
    assert.equal(released.length, 0, 'V2 never asks the inactive V1 release');
    assert.equal(await page.locator('[data-sequence-release="unavailable"]').count(), 0, 'no "Automation can’t be set up here."');
    assert.doesNotMatch(await page.locator('main').innerText(), /Automation can’t be set up here/);
    assert.match(await setup.innerText(), /No positions available for Auto-exit[\s\S]*This position isn’t available for a new Auto-exit\. Check its status in Positions\./);
    assert.doesNotMatch(await setup.innerText(), /couldn’t be checked|Try again/);
    assert.equal(await page.locator('[data-sequence-positions="failed"]').count(), 0, 'a portfolio that answered is not left loading');
    assert.equal(await page.locator('[data-sequence-action], [data-sequence-mode]').count(), 0, 'an automated NFT cannot choose a second Auto-exit or compounding');
    assert.equal(await setup.locator('[data-v2in-consent]').count(), 0, 'nothing to consent to');
    await setup.screenshot({ path: join(shots(), 'v2in-setup-autoexit-held.png'), animations: 'disabled' });
  } finally {
    await s.close();
  }
});

test('Auto-exit on USDG / ERC-20 writes the edges in the app\'s own units (USDG per ORB, the pool\'s order reversed), with each token\'s decimals', async () => {
  const ID = '3135299';
  const holder = ACCOUNTS[0].address.toLowerCase();
  const ORB = '0x8888888888888888888888888888888888888888';
  const key = { currency0: USDG, currency1: ORB, fee: 8000, tickSpacing: 80, hooks: ZERO };
  // Exact pool ratio 16e12 raw ORB / raw USDG: 1 ORB = 0.0625 USDG (18 vs 6 decimals).
  const sqrtPriceX96 = (2n ** 96n) * 4_000_000n;
  const tick = Math.floor(Math.log(16e12) / Math.log(1.0001));
  const v1 = browserChain({ positions: [{ tokenId: ID, holder, key, tickLower: 300000, tickUpper: 320000, liquidity: 10n ** 18n, unclaimed: [100n, 200n] }], pools: { [poolIdOf(key)]: { sqrtPriceX96, tick } }, tokens: { ...TOKENS, [ORB]: { symbol: 'ORB', decimals: 18 } } });
  const s = await openPreview(v1, `/positions/${ID}`);
  try {
    const { page } = s;
    await openExit(page);
    const dialog = page.locator('[data-v2in-dialog="mandate"]');
    const edges = dialog.locator('[data-mandate-edges="inside"] [data-mandate-edge]');
    await edges.first().waitFor();
    // In USDG per ORB the pool's upper tick is the lower price: the falling edge is triggerAbove.
    assert.deepEqual(await edges.evaluateAll((items) => items.map((li) => [li.getAttribute('data-mandate-edge'), li.getAttribute('data-mandate-trigger')])), [['falls', 'above'], ['rises', 'below']]);
    const prices = await edges.evaluateAll((items) => items.map((li) => li.querySelector('.dm-exit-edge-price').textContent));
    assert.match(prices[0], /^0\.01\d+ USDG per ORB$/);
    assert.match(prices[1], /^0\.09\d+ USDG per ORB$/);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      const overflow = await dialog.evaluate((node) => [node, node.querySelector('.dm-flow-dialog-body')].some((el) => el.scrollWidth > el.clientWidth + 1));
      assert.equal(overflow, false, `Auto-exit at ${width} has no horizontal overflow`);
      await dialog.screenshot({ path: join(shots(), `autoexit-orb-${width}-local-fixture.png`), animations: 'disabled' });
    }
    for (const method of SENDS_AND_SIGNATURES) assert.ok(!s.wallet.state.log.some((entry) => entry.method === method));
  } finally { await s.close(); }
});

// Added 2026-10-06 (the final check, F7): on a pool written the other way round (USDG per ORB: the pool's lower tick is
// the highest price shown), the card's Details name each end by the way the price moves to reach it, as its line does.
test('live: Auto-exit on, its pool written the other way round (USDG per ORB): Details say "Lower end" for the falling end and "Upper end" for the rising one', async () => {
  const ORB = '0x8888888888888888888888888888888888888888';
  const pool = { currency0: USDG, currency1: ORB, fee: 8000, tickSpacing: 80 };
  const key = { ...pool, hooks: ZERO };
  const liquidity = 10n ** 18n;
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool, tickLower: 300000, tickUpper: 320000, liquidity }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  chain.setExitModule(vault, AUTO_EXIT);
  const [below, above] = [sqrtPriceAtTick(300000), sqrtPriceAtTick(320000)];
  const portfolio = listing(chain, vault, {
    armed: true, paused: true, pausedBy: 'owner', autoExit: true, reserves: [[USDG, 0n], [ORB, 0n]], root: { owner: OWNER, liquidity }, other: { address: ORB, symbol: 'ORB', decimals: 18 },
    orders: (fixture) => fixture.slice(0, 1).map((order) => ({ ...order, tokenId: String(ROOT), status: 'active', expired: false, blockedBy: [], moduleEnabled: true, waiting: waitingOf('trigger_not_reached'), executed: null, revoked: null, terms: { triggerBelowSqrtPriceX96: String(below), triggerAboveSqrtPriceX96: String(above), receive: 'both', convertTo: null, maxSlippageBps: 100 } })),
  });
  // 1 ORB = 0.0625 USDG (16e12 raw ORB per raw USDG), inside the range: 0.0126… to 0.0936… USDG per ORB.
  const v1 = browserChain({ positions: [{ tokenId: String(ROOT), holder: OWNER, key, tickLower: 300000, tickUpper: 320000, liquidity, unclaimed: [0n, 0n] }], pools: { [poolIdOf(key)]: { sqrtPriceX96: (2n ** 96n) * 4_000_000n, tick: Math.floor(Math.log(16e12) / Math.log(1.0001)) } }, tokens: { ...TOKENS, [ORB]: { symbol: 'ORB', decimals: 18 } } });
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1 });
  const { page } = s;
  try {
    const card = page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="on"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.match(await card.locator('[data-v2in-exit-line="on"]').innerText(), /^Closes at 0\.01\d+ – 0\.09\d+ USDG per ORB$/, 'the line: the lower price first');
    await card.locator('[data-exit-details] > summary').click();
    const ends = await card.locator('[data-order-status="active"] > div').evaluateAll((rows) => rows.slice(0, 2).map((row) => [row.querySelector('dt').textContent, row.querySelector('dd').textContent, row.getAttribute('data-exit-end')]));
    assert.deepEqual(ends.map(([label, text]) => [label, text.replace(/[\d,.]+ USDG/, '… USDG')]), [
      ['Lower end', 'Closes if the price falls to … USDG per ORB'],
      ['Upper end', 'Closes if the price rises to … USDG per ORB'],
    ]);
    assert.match(ends[0][1], /^Closes if the price falls to 0\.01\d+ USDG per ORB$/, 'the lower end is the pool\'s upper tick here');
    assert.match(ends[1][1], /^Closes if the price rises to 0\.09\d+ USDG per ORB$/);
    assert.deepEqual(ends.map(([, , move]) => move), ['falls', 'rises']);
    await card.screenshot({ path: join(shots(), 'v2in-autoexit-details-inverted.png'), animations: 'disabled' });
    assert.deepEqual(chain.sends, []);
  } finally {
    await s.close();
  }
});

// Added 2026-10-06 (the owner's point 5; rugged97: "it must be automatic"): one signature, then ONE confirmation.
test('live: Auto-exit on a plain position is ONE signature and ONE wallet_sendCalls (approve, createVault, setExitModule, registerMandate); its card then says where it closes, and "Turn off" revokes it', async () => {
  const liquidity = 10n ** 18n;
  const chain = createVaultChain({ chainId: 4663, atomic: 'ready', simulateV1: true, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -201060, tickUpper: -198060, liquidity }] });
  // Changed on purpose 2026-10-06 (the review of point 5): the pool's own price, read through the wallet, chooses the edges.
  chain.setPrice(4, KEY, (2n ** 96n) / 20000n);
  const v1 = browserChain({ positions: [{ tokenId: String(ROOT), holder: OWNER, key: KEY, tickLower: -201060, tickUpper: -198060, liquidity, unclaimed: [0n, 0n] }], pools: { [poolIdOf(KEY)]: { sqrtPriceX96: (2n ** 96n) / 20000n, tick: -198080 } }, tokens: TOKENS });
  const portfolio = plainPortfolio(v1, OWNER);
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1 });
  try {
    const { page } = s;
    await openExit(page);
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="mandate"]');
    await dialog.waitFor();
    const send = dialog.locator('[data-mandate-send]');
    assert.equal(await send.innerText(), 'Turn on Auto-exit');
    // The reviews run behind the one button (the vault this wallet's next createVault makes, the order signed for it).
    await dialog.locator('[data-mandate-send]:not([disabled])').waitFor({ timeout: 30_000 });
    assert.equal(chain.log.includes('eth_signTypedData_v4'), false, 'nothing is signed before the press');
    assert.deepEqual(chain.sends, []);
    const [below, above] = [sqrtPriceAtTick(-201060), sqrtPriceAtTick(-198060)];
    assert.equal(await dialog.locator('[data-mandate-edges]').getAttribute('data-mandate-price'), 'chain', 'the pool\'s own price, read on chain');
    assert.ok(chain.callsSince(0).some((c) => c.calls.includes('stateView.getSlot0')));
    // Changed on purpose 2026-10-30 (QA round 2, N2): the screens' price rule (present.ts priceText), 2 decimals from 1,000.
    assert.equal(await dialog.locator('[data-mandate-now]').innerText(), 'Now 2,500.00');
    // 2,500 is 0.2% under the upper end (2,504.92): within the 1% band, it may close soon, and the dialog says so.
    assert.equal(await dialog.locator('[data-mandate-near]').innerText(), 'The price is close to the end of your range, so Auto-exit may close this position soon.');
    await dialog.screenshot({ path: join(shots(), 'v2in-autoexit-live-ready.png'), animations: 'disabled' });
    await send.click();
    await dialog.locator('[data-mandate-registered]').waitFor({ timeout: 60_000 });
    assert.equal(chain.log.filter((method) => method === 'eth_signTypedData_v4').length, 1, 'one signature');
    assert.equal(chain.log.filter((method) => method === 'wallet_sendCalls').length, 1, 'one confirmation');
    assert.equal(chain.log.includes('eth_sendTransaction'), false);
    const [batch] = chain.batches;
    const predicted = chain.predict(4, OWNER, 0n);
    assert.deepEqual(batch.calls.map((call) => [call.to.toLowerCase(), selectorOf(call.data)]), [
      [chain.positionManager[4].toLowerCase(), SELECTOR.approve],
      [FAKE.vaultFactoryV4.toLowerCase(), toFunctionSelector(ABI.factory.find((item) => item.type === 'function' && item.name === 'createVault'))],
      [predicted, SELECTOR.setExitModule],
      [AUTO_EXIT, batch.calls[3].data.slice(0, 10)],
    ]);
    const [mandate] = decodeFunctionData({ abi: ABI.autoExit, data: batch.calls[3].data }).args;
    assert.deepEqual([mandate.vault.toLowerCase(), mandate.tokenId, mandate.triggerBelowSqrtPriceX96, mandate.triggerAboveSqrtPriceX96, mandate.receiveMode, mandate.maxSlippageBps], [predicted, ROOT, below, above, 0, 100], 'the range\'s two edges, both tokens, 1%');
    const made = chain.vault(predicted);
    assert.deepEqual([made.paused, made.exitModule, made.policy.mode, made.policy.maxPositions], [true, AUTO_EXIT, 1, 1], 'the protection-only vault: paused, its module on');
    assert.equal(chain.module().status.get(mandateHash(mandate)), 1, 'registered, active');
    assert.equal(await dialog.locator('[data-mandate-registered]').innerText(), 'Auto-exit is on. Domino closes this position at the end of its range.');
    await dialog.screenshot({ path: join(shots(), 'v2in-autoexit-live-on.png'), animations: 'disabled' });
    await dialog.locator('[data-v2in-close]').click();
    await dialog.waitFor({ state: 'detached' });

    // The page says it at once (the index has not caught up: the session's own registration), and offers no second one.
    await expandAutomation(page);
    const card = page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="on"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.match(await card.locator('[data-v2in-exit-line="on"]').innerText(), /^Closes at 1,855\.72 – 2,504\.92 USDG per ETH$/);
    assert.equal(await page.locator('[data-position-v2-action="protect"]').count(), 0, 'one Auto-exit per position');
    await card.locator('[data-exit-off]').click();
    const off = page.locator('[role="dialog"][data-v2in-dialog="cancel-order"]');
    await off.waitFor();
    assert.equal(await off.locator('h2').innerText(), 'Turn off Auto-exit');
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="cancel-order"]')?.disabled === false, null, { timeout: 30_000 });
    await off.locator('[data-v2in-send="cancel-order"]').click();
    await off.locator('[data-v2in-close]').waitFor({ timeout: 30_000 });
    assert.equal(selectorOf(chain.sends.at(-1).data), SELECTOR.revokeMandate);
    assert.equal(chain.module().status.get(mandateHash(mandate)), 2, 'revoked');
    await off.locator('[data-v2in-close]').click();
    await page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="off"]`).waitFor({ state: 'attached', timeout: 30_000 });
  } finally { await s.close(); }
});

test('V2 detail: one setup link preselects the NFT, and both compounding reviews keep consent, exact fees and mobile layout', async () => {
  const ID = '3135288';
  const holder = ACCOUNTS[0].address.toLowerCase();
  const v1 = browserChain({ positions: [{ tokenId: ID, holder, minter: OTHER, key: KEY, tickLower: -600, tickUpper: 600, liquidity: 1000000n, unclaimed: [0n, 0n] }], tokens: TOKENS });
  const s = await openPreview(v1, `/positions/${ID}`, { expand: false });
  try {
    const { page } = s;
    const setup = page.locator('[data-automation-setup]');
    await setup.waitFor({ timeout: 30_000 });
    assert.equal(await setup.count(), 1);
    assert.equal(await setup.innerText(), 'Set up automation');
    assert.equal(await setup.getAttribute('href'), `#/sequence/${ID}`);
    assert.equal(await page.locator('[data-automation-panel]').isVisible(), false);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      await page.screenshot({ path: join(shots(), `v2-detail-setup-cta-${width}-local-fixture.png`), fullPage: true, animations: 'disabled' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `position fits at ${width}`);
    }
    await setup.click();
    await page.locator(`[data-sequence-position="${ID}"][aria-checked="true"]`).waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-sequence-mode][aria-checked="true"]').count(), 0, 'the link chooses only the NFT');
    assert.equal(s.requests.some((url) => /\/api\/setup\/v1\/sequence-release/.test(url)), false, 'V1 release cannot gate V2 setup');
    assert.equal(s.requests.some((url) => /\/api\/owned\/v2\/positions(?:\?|$)/.test(url)), false, 'the legacy SetupV1 catalogue is not needed for the direct detail-to-setup path');
    await page.screenshot({ path: join(shots(), 'v2-setup-preselected-local-fixture.png'), fullPage: true, animations: 'disabled' });
    const flow = page.locator('[data-v2in-setup="preview"]');
    for (const [mode, title, fee] of [['compound', 'Auto-compound', '2%'], ['domino', 'Domino-compound', '4%']]) {
      await flow.locator(`[data-sequence-mode="${mode}"]`).click();
      const consent = flow.locator('[data-v2in-consent]');
      assert.equal(await consent.isChecked(), false, 'each mode needs its own explicit consent');
      assert.equal(await flow.locator('[data-v2in-review]').count(), 0, 'a new mode clears the previous review');
      const reviewAction = flow.getByRole('button', { name: 'Review', exact: true });
      assert.equal(await reviewAction.isDisabled(), true);
      await consent.check();
      await reviewAction.click();
      const review = flow.locator('[data-v2in-review]');
      await review.waitFor();
      assert.equal(await review.locator('dd').nth(1).innerText(), title);
      // Changed on purpose 2026-10-30 (QA round 2, the owner's Q1): Automate's one wording, "each time", not "once".
      assert.equal(await review.locator('dd').nth(2).innerText(), `${fee} of the earned fees it uses, each time`);
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 960 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${mode} review fits at ${width}`);
        assert.ok(await flow.locator('.dm-mode-copy').evaluateAll(copies => copies.every(copy => {
          const content = copy.getBoundingClientRect();
          const choice = copy.closest('button').getBoundingClientRect();
          return content.top >= choice.top && content.bottom <= choice.bottom;
        })), `${mode} choice text and fees remain inside the card at ${width}`);
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await page.screenshot({ path: join(shots(), `v2-setup-${mode}-review-${width}-local-fixture.png`), fullPage: true, animations: 'disabled' });
      }
      await page.setViewportSize({ width: 1280, height: 960 });
    }
    for (const method of SENDS_AND_SIGNATURES) assert.equal(s.wallet.state.log.some((entry) => entry.method === method), false, 'opening setup never signs or sends');
  } finally { await s.close(); }
});

test('V2 detail: unread, stale, missing and failed custody never show Off or offer setup; Refresh recovers from read-v6', async () => {
  const ID = '3135288';
  const holder = ACCOUNTS[0].address.toLowerCase();
  const cases = [
    ['missing', (body) => { body.positions = []; }],
    ['not read', (body) => { body.positions[0].state = { status: 'not_read' }; }],
    ['custody failed', (body) => { const state = body.positions[0].state; body.positions[0].state = { status: 'unavailable', snapshot: state.snapshot, freshness: state.freshness, reason: 'custody_read_failed' }; }],
    ['stale', (body) => { body.positions[0].state.freshness = { status: 'stale', ageSeconds: 900 }; }],
    ['foreign subscriber', (body) => { body.positions[0].state.custody.subscriber = OTHER; }],
    ['wrong manager', (body) => { body.positions[0].positionManager = OTHER; }],
    ['hooked', (body) => { body.positions[0].state.pool.hooks = OTHER; }],
  ];
  for (const [name, edit] of cases) {
    const v1 = browserChain({ positions: [{ tokenId: ID, holder, key: KEY, tickLower: -600, tickUpper: 600, liquidity: 1000000n, unclaimed: [0n, 0n] }], tokens: TOKENS });
    const s = await openPreview(v1, `/positions/${ID}`, { portfolio: plainPortfolio(v1, holder, edit) });
    try {
      const control = s.page.locator('[data-automation-control]');
      await s.page.waitForFunction(() => !document.querySelector('[data-automation-control]')?.textContent.includes('Loading'));
      assert.equal(await s.page.locator('[data-automation-setup]').count(), 0, name);
      assert.doesNotMatch(await control.innerText(), /\bOff\b/, name);
      // (2026-10-15, pack 7 review): a state not read leaves no empty paragraph behind: neither the Auto-exit card's line nor
      // the automation's status note is drawn without words.
      const empty = await s.page.locator('.dm-exit-card-line, [data-automation-eligibility]').evaluateAll((items) => items.filter((item) => !item.textContent.trim()).length);
      assert.equal(empty, 0, `${name}: no empty line`);
      if (name === 'custody failed') {
        // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): the control names the automation alone; it said "· State unavailable".
        assert.doesNotMatch(await control.innerText(), /State unavailable|Updating|Loading/);
        // Changed on purpose 2026-10-30 (QA round 2, the owner's rule: no Retry or Refresh on a read surface): no Refresh;
        // the portfolio is asked again by itself (src/v2in/lists/source.ts), which a test build does only when asked to.
        assert.equal(await s.page.locator('[data-automation-refresh]').count(), 0);
        assert.equal(await s.page.getByRole('button', { name: 'Refresh', exact: true }).count(), 0);
      }
    } finally { await s.close(); }
  }
});

// Added 2026-10-06 (rugged's answer of 6 Oct, §4 item 7 and the spec delta §3: one Auto-exit per position; a second one active
// on the same position executes with value zero when it fires, the operator paying its gas). This page read its Auto-exit
// turned off and offers "Turn on" in its automation; another tab turned one on since, and read-v6 lists it by the press.
test('live: one Auto-exit per position: one turned on in another tab since the page read stops the press before the signature; nothing signed or sent, and the page reads again', async () => {
  const liquidity = 10n ** 18n;
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -201060, tickUpper: -198060, liquidity }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  chain.setExitModule(vault, AUTO_EXIT);
  chain.setPrice(4, KEY, (2n ** 96n) / 20000n);
  const terms = { triggerBelowSqrtPriceX96: String(sqrtPriceAtTick(-201060)), triggerAboveSqrtPriceX96: String(sqrtPriceAtTick(-198060)), receive: 'both', convertTo: null, maxSlippageBps: 100 };
  const turnedOff = (order) => ({ ...order, tokenId: String(ROOT), status: 'revoked', expired: false, blockedBy: [], moduleEnabled: true, waiting: null, executed: null, revoked: SINCE, terms });
  const listed = (orders) => listing(chain, vault, { armed: true, paused: true, pausedBy: 'owner', autoExit: true, reserves: [[ZERO, 0n], [USDG, 0n]], root: { owner: OWNER, liquidity }, orders });
  const portfolio = listed((fixture) => fixture.slice(0, 1).map(turnedOff));
  // What read-v6 lists once the other tab turned it on again: a second order of the position, active.
  const later = listed((fixture) => [...fixture.slice(0, 1).map(turnedOff), { ...fixture[0], mandateHash: `0x${'d4'.repeat(32)}`, tokenId: String(ROOT), status: 'active', expired: false, blockedBy: [], moduleEnabled: true, waiting: null, executed: null, revoked: null, terms }]);
  const v1 = browserChain({ positions: [{ tokenId: String(ROOT), holder: OWNER, key: KEY, tickLower: -201060, tickUpper: -198060, liquidity, unclaimed: [0n, 0n] }], pools: { [poolIdOf(KEY)]: { sqrtPriceX96: (2n ** 96n) / 20000n, tick: -198080 } }, tokens: TOKENS });
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1 });
  const { page } = s;
  try {
    const card = page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="off"]`);
    await card.waitFor({ timeout: 30_000 });
    await card.locator('[data-v2in-open="mandate"]').click();
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="mandate"]');
    await dialog.waitFor();
    await dialog.locator('[data-mandate-send]:not([disabled])').waitFor({ timeout: 30_000 });
    // Another tab turned Auto-exit on for this position meanwhile: read-v6 lists it now.
    await page.evaluate((answer) => { window.__dominoV2Test.read6.portfolio = answer; }, later);
    await dialog.locator('[data-mandate-send]').click();
    const refused = dialog.locator('[data-error-code="mandate_already_on"]');
    await refused.waitFor({ timeout: 30_000 });
    assert.equal(await refused.innerText(), 'Auto-exit is already on for this position.');
    assert.equal(await dialog.locator('[data-mandate-send]').isDisabled(), true, 'no second one offered');
    assert.equal(chain.log.includes('eth_signTypedData_v4'), false, 'nothing signed');
    assert.deepEqual(chain.sends, [], 'nothing sent');
    assert.equal(chain.module().status.size, 0, 'no order registered on the position\'s automation');
    // The page read again: behind the dialog its card says the one that is on; the dialog still says why, its button off.
    await page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="on"]`).waitFor({ state: 'attached', timeout: 30_000 });
    await page.waitForTimeout(500);
    assert.equal(await refused.innerText(), 'Auto-exit is already on for this position.', 'still said');
    assert.equal(await dialog.locator('[data-mandate-send]').isDisabled(), true);
    await dialog.screenshot({ path: join(shots(), 'v2in-autoexit-one-per-position.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' });
    await expandAutomation(page);
    await page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="on"]`).waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-position-v2-action="protect"]').count(), 0, 'and no second one is offered');
  } finally { await s.close(); }
});

// Added 2026-10-06 (found with rugged's answer of 6 Oct, §4 item 7): a failure before anything is signed is followed by a new
// review, whose new list took the run's notice with it; the dialog's own note keeps it said until the next press.
test('live: a signature declined in the wallet stays said after the dialog reviews again; the next press asks again and goes through', async () => {
  const liquidity = 10n ** 18n;
  const chain = createVaultChain({ chainId: 4663, atomic: 'ready', simulateV1: true, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -201060, tickUpper: -198060, liquidity }] });
  chain.setPrice(4, KEY, (2n ** 96n) / 20000n);
  const v1 = browserChain({ positions: [{ tokenId: String(ROOT), holder: OWNER, key: KEY, tickLower: -201060, tickUpper: -198060, liquidity, unclaimed: [0n, 0n] }], pools: { [poolIdOf(KEY)]: { sqrtPriceX96: (2n ** 96n) / 20000n, tick: -198080 } }, tokens: TOKENS });
  const portfolio = plainPortfolio(v1, OWNER);
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1 });
  try {
    const { page } = s;
    await openExit(page);
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="mandate"]');
    await dialog.waitFor();
    await dialog.locator('[data-mandate-send]:not([disabled])').waitFor({ timeout: 30_000 });
    // Each review of the order reads the module's slippage ceiling once.
    const reviews = () => chain.callsSince(0).filter((call) => call.calls.includes('autoExit.MAX_SLIPPAGE_BPS')).length;
    const before = reviews();
    chain.decline();
    await dialog.locator('[data-mandate-send]').click();
    const declined = dialog.locator('[data-error-code="declined"]');
    await declined.waitFor({ timeout: 30_000 });
    assert.equal(await declined.innerText(), 'You declined in your wallet. Nothing was sent.');
    // The dialog reviews again (a fresh signature number); once it has, the refusal is still said.
    for (let i = 0; i < 300 && reviews() === before; i += 1) await page.waitForTimeout(100);
    assert.ok(reviews() > before, 'reviewed again');
    await dialog.locator('[data-mandate-send]:not([disabled])').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(500);
    assert.equal(await declined.innerText(), 'You declined in your wallet. Nothing was sent.', 'still said');
    assert.deepEqual(chain.sends, []);
    await dialog.locator('[data-mandate-send]').click();
    await dialog.locator('[data-mandate-registered]').waitFor({ timeout: 60_000 });
    assert.equal(await dialog.locator('[data-error-code]').count(), 0, 'said until the next press');
    assert.equal(chain.log.filter((method) => method === 'eth_signTypedData_v4').length, 2, 'the refused ask, then the one signed');
  } finally { await s.close(); }
});

// Added 2026-10-06 (rugged's answer of 6 Oct, §4 item 2: a wallet without batching): another tab sets up automation on the
// wallet's other position between this dialog's signature and its createVault, taking the nonce the order was signed for
// (its vault is then the predicted address, with another root: an order registered for it would never execute, read-v6
// saying not_in_vault). The dialog makes the prediction, the approval and the signature again, then creates the vault.
test('live, a wallet that cannot batch: another vault takes the nonce after the approval; the prediction, the approval and the signature are made again before createVault', async () => {
  const liquidity = 10n ** 18n;
  const SECOND = ROOT + 1n;
  const chain = createVaultChain({ chainId: 4663, positions: [
    { dex: 4, tokenId: ROOT, pool: POOL, tickLower: -201060, tickUpper: -198060, liquidity },
    { dex: 4, tokenId: SECOND, pool: POOL, tickLower: -201060, tickUpper: -198060, liquidity },
  ] });
  chain.setPrice(4, KEY, (2n ** 96n) / 20000n);
  const manager = chain.positionManager[4].toLowerCase();
  const [first, next] = [chain.predict(4, OWNER, 0n), chain.predict(4, OWNER, 1n)];
  // The other tab: right after this page's approval is in a block, a vault for the other position on nonce 0.
  const request = chain.request;
  let landed = null;
  chain.request = async (method, params) => {
    const reply = await request(method, params);
    if (method === 'eth_sendTransaction' && landed === null && String(params?.[0]?.to).toLowerCase() === manager) landed = await chain.seedVault({ dex: 4, tokenId: SECOND });
    return reply;
  };
  const v1 = browserChain({ positions: [{ tokenId: String(ROOT), holder: OWNER, key: KEY, tickLower: -201060, tickUpper: -198060, liquidity, unclaimed: [0n, 0n] }], pools: { [poolIdOf(KEY)]: { sqrtPriceX96: (2n ** 96n) / 20000n, tick: -198080 } }, tokens: TOKENS });
  const portfolio = plainPortfolio(v1, OWNER);
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1 });
  try {
    const { page } = s;
    await openExit(page);
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="mandate"]');
    await dialog.waitFor();
    const send = dialog.locator('[data-mandate-send]');
    await dialog.locator('[data-mandate-send]:not([disabled])').waitFor({ timeout: 30_000 });
    await send.click();
    // Signed and approved, then the other vault took the nonce: said, and nothing created for the old prediction.
    const moved = dialog.locator('[data-error-code="vault_nonce_moved"]');
    await moved.waitFor({ timeout: 60_000 });
    assert.equal(await moved.innerText(), 'Another automation was set up from this wallet. Review again: your approval must point to the new one.');
    assert.equal(landed, first, 'the other tab\'s vault is at the address the order was signed for');
    assert.equal(chain.log.filter((method) => method === 'eth_signTypedData_v4').length, 1);
    assert.deepEqual(chain.sends.map((tx) => [tx.to.toLowerCase(), selectorOf(tx.data)]), [[manager, SELECTOR.approve]], 'the approval only: no createVault');
    // The new review is ready: one press makes the prediction's approval, the signature and the rest.
    await dialog.locator('[data-mandate-send]:not([disabled])').waitFor({ timeout: 30_000 });
    await send.click();
    await dialog.locator('[data-mandate-registered]').waitFor({ timeout: 60_000 });
    assert.equal(chain.log.filter((method) => method === 'eth_signTypedData_v4').length, 2, 'signed again, for the new prediction');
    const createVault = toFunctionSelector(ABI.factory.find((item) => item.type === 'function' && item.name === 'createVault'));
    const registerMandate = toFunctionSelector(ABI.autoExit.find((item) => item.type === 'function' && item.name === 'registerMandate'));
    assert.deepEqual(chain.sends.map((tx) => [tx.to.toLowerCase(), selectorOf(tx.data)]), [
      [manager, SELECTOR.approve],
      [manager, SELECTOR.approve],
      [FAKE.vaultFactoryV4.toLowerCase(), createVault],
      [next, SELECTOR.setExitModule],
      [AUTO_EXIT, registerMandate],
    ]);
    assert.deepEqual(decodeFunctionData({ abi: ABI.v4, data: chain.sends[1].data }).args.map((a) => (typeof a === 'string' ? a.toLowerCase() : a)), [next, ROOT], 'approved again, to the new prediction');
    const [mandate] = decodeFunctionData({ abi: ABI.autoExit, data: chain.sends[4].data }).args;
    assert.equal(mandate.vault.toLowerCase(), next, 'signed for the new prediction');
    assert.equal(chain.module().status.get(mandateHash(mandate)), 1, 'registered, active');
    assert.equal(chain.module().status.size, 1, 'the order signed for the old prediction was never registered');
    const made = chain.vault(next);
    assert.deepEqual([made.root.tokenId, made.paused, made.exitModule], [ROOT, true, AUTO_EXIT]);
    assert.equal(chain.vault(first).root.tokenId, SECOND, 'the other tab\'s vault holds the other position');
  } finally { await s.close(); }
});

// The current control is compact. Completed financial operations belong in Receipts/Activity, not a second result card.
test('live: a completed Auto-exit keeps its result in Activity and never offers the mandate again', async () => {
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -201060, tickUpper: -198060, liquidity: 10n ** 18n }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  chain.setExitModule(vault, AUTO_EXIT);
  chain.closeRoot(4, ROOT);
  chain.disarm(vault, 6);
  const [below, above] = [sqrtPriceAtTick(-201060), sqrtPriceAtTick(-198060)];
  const portfolio = listing(chain, vault, {
    armed: false, reason: 'auto_exit', paused: true, pausedBy: 'owner', autoExit: true, reserves: [[ZERO, 0n], [USDG, 0n]], root: { owner: OWNER, liquidity: 0n },
    orders: (fixture) => fixture.slice(0, 1).map((order) => ({ ...order, tokenId: String(ROOT), status: 'executed', expired: false, blockedBy: [], moduleEnabled: true, waiting: null, revoked: null, executed: { tx: SINCE, anchorSqrtPriceX96: String(below), delivered: ['500000000000000000', '1250000000'] }, terms: { triggerBelowSqrtPriceX96: String(below), triggerAboveSqrtPriceX96: String(above), receive: 'both', convertTo: null, maxSlippageBps: 100 } })),
  });
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ liquidity: 0n }) });
  const { page } = s;
  try {
    const card = page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="closed"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-automation-management] h2').innerText(), 'Auto-exit');
    assert.equal(await card.locator('[data-exit-pill]').innerText(), 'Completed');
    assert.equal(await card.locator('[data-v2in-exit-line="closed"]').innerText(), 'View the result in Activity.');
    assert.equal(await card.locator('[data-order-result]').count(), 0, 'no duplicated result or assumed 0.2% charge outside Activity');
    // Never offered again: no Turn on, no Turn back on, no rearm, nothing to turn off; no Auto-exit among the page's actions.
    assert.equal(await card.locator('[data-v2in-open="mandate"], [data-order-module-on], [data-vault-open="rearm"], [data-vault-more="rearm"], [data-exit-off]').count(), 0);
    assert.doesNotMatch(await card.innerText(), /Turn on|Turn back on|Approve again|Turn off/);
    assert.equal(await page.locator('[data-position-v2-action="protect"]').count(), 0);
    await card.screenshot({ path: join(shots(), 'v2in-autoexit-card-closed.png'), animations: 'disabled' });
  } finally { await s.close(); }
});

// Added 2026-10-06 (the review of the owner's point 5): Add liquidity on v4 moves the NFT's one approval to the zap, and
// Auto-exit's own vault waits for it. Turning it back on is Auto-exit's: its consent, never compounding's. Changed on
// purpose 2026-10-06 (the integration review, rugged-literal #1, money #4): said by what it does ("Approve again"; never
// "Auto-exit works again"), the pool's price read before the approval goes back (here inside the range: nothing to warn of).
/** Auto-exit's own vault on ROOT (range ticks -201060 to -198060), its order paused for a lost approval. */
async function approvalLost({ price }) {
  const liquidity = 10n ** 18n;
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -201060, tickUpper: -198060, liquidity }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  chain.setExitModule(vault, AUTO_EXIT);
  chain.approveOther(4, ROOT, FAKE.zapV4);
  if (price !== null) chain.setPrice(4, KEY, price);
  const [below, above] = [sqrtPriceAtTick(-201060), sqrtPriceAtTick(-198060)];
  const portfolio = listing(chain, vault, {
    armed: false, reason: 'custody_lost', paused: true, pausedBy: 'owner', autoExit: true, reserves: [[ZERO, 0n], [USDG, 0n]], root: { owner: OWNER, liquidity },
    orders: (fixture) => fixture.slice(0, 1).map((order) => ({ ...order, tokenId: String(ROOT), status: 'active', expired: false, blockedBy: ['custody_lost'], moduleEnabled: true, waiting: null, executed: null, revoked: null, terms: { triggerBelowSqrtPriceX96: String(below), triggerAboveSqrtPriceX96: String(above), receive: 'both', convertTo: null, maxSlippageBps: 100 } })),
  });
  // Added 2026-10-06 (rugged's answer of 6 Oct, §4 item 6): read-v6 read the position (and found its approval gone) before
  // anything this page sends, whose blocks start at the fake chain's 0x100001.
  portfolio.body.positions[0].state.snapshot.number = 0x10_0000 - 100;
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ liquidity }) });
  return { chain, vault, s };
}

test('live: Auto-exit paused because its position lost the approval: "Approve again" beside its line, in Auto-exit\'s words, the price read first; the vault still paused after', { timeout: 90_000 }, async () => {
  // The pool at about 2,500 USDG per ETH, inside the range: no end passed.
  const { chain, vault, s } = await approvalLost({ price: (2n ** 96n) / 20000n });
  const { page } = s;
  const previewPrice = Promise.withResolvers();
  const actionPriceStarted = Promise.withResolvers();
  const actionPriceReply = Promise.withResolvers();
  const request = chain.request;
  const getSlot0 = toFunctionSelector('getSlot0(bytes32)');
  const order = [];
  let confirming = false;
  chain.request = async (method, params) => {
    const data = params?.[0]?.data ?? '';
    if (method === 'eth_call' && data.startsWith(getSlot0)) {
      const actionRead = confirming;
      if (actionRead) {
        actionPriceStarted.resolve();
        await actionPriceReply.promise;
      }
      const reply = await request(method, params);
      if (actionRead) order.push('price-read');
      else previewPrice.resolve();
      return reply;
    }
    if (method === 'eth_sendTransaction' && data.startsWith(SELECTOR.approve)) order.push('approve');
    return request(method, params);
  };
  try {
    const card = page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="paused"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await card.locator('[data-exit-pill]').innerText(), 'Paused');
    assert.equal(await card.locator('[data-v2in-exit-line="paused"]').innerText(), 'Paused: Domino no longer has approval on this position.');
    // ONE control in the card's head ("Turn off"); the fix beside the line that says why, by what it does.
    assert.equal(await card.locator('[data-exit-off]').innerText(), 'Turn off');
    const fix = card.locator('[data-exit-fix="rearm"] [data-vault-open="rearm"]');
    assert.equal(await fix.innerText(), 'Approve again');
    assert.equal(await card.locator('[data-vault-open]').count(), 1, 'one fix');
    // Never a way to cut the position from its automation while its Auto-exit is paused (an exit needs the approval).
    assert.equal(await card.locator('[data-vault-more="unsubscribe"], [data-vault-more="revoke"]').count(), 0);
    await card.screenshot({ path: join(shots(), 'v2in-autoexit-paused-approval.png'), animations: 'disabled' });
    await fix.click();
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="vault-rearm"]');
    await dialog.waitFor();
    assert.equal(await dialog.locator('h2').innerText(), 'Auto-exit');
    assert.equal(await dialog.locator('[data-vault-lede]').innerText(), 'Approve this position again so Auto-exit can close it at the end of its range.');
    assert.equal(await dialog.locator('[data-vault-lede]').getAttribute('data-vault-exit-rearm'), 'approve');
    assert.doesNotMatch(await dialog.innerText(), /works again|Turn Auto-exit back on/, 'said by what it does');
    const consent = dialog.locator('label:has([data-rearm-consent])');
    assert.match(await consent.innerText(), /^Auto-exit never reinvests\./);
    assert.doesNotMatch(await dialog.innerText(), /reinvested by automation|(?<![.\d])2% fee|Automation starts again|Domino-compound|Auto-compound/, 'nothing of compounding (its 0.2% is Auto-exit\'s own)');
    await dialog.locator('[data-rearm-consent]').check();
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="rearm"]')?.disabled === false, null, { timeout: 30_000 });
    assert.deepEqual(await dialog.locator('[data-wallet-steps="vault-rearm"] li').evaluateAll((items) => items.map((li) => [li.getAttribute('data-wallet-step'), li.querySelector('.dm-flow-wstep-title')?.textContent])), [
      ['approve-root', 'Approve this position for Auto-exit'],
      ['rearm', 'Reconnect it to your automation'],
    ]);
    // The preview read is asynchronous and does not gate this button. The safety check is the action's fresh read,
    // immediately before approval: hold that reply so the test proves ordering, rather than racing the preview effect.
    await previewPrice.promise;
    assert.equal(await dialog.locator('[data-exit-past]').count(), 0, 'inside the range: nothing to warn of');
    assert.deepEqual(chain.sends, [], 'for the person to confirm');
    await dialog.screenshot({ path: join(shots(), 'v2in-autoexit-rearm.png'), animations: 'disabled' });
    confirming = true;
    await dialog.locator('[data-v2in-send="rearm"]').click();
    await actionPriceStarted.promise;
    assert.deepEqual(chain.sends, [], 'no approval while the action\'s pool-price read is pending');
    assert.deepEqual(order, [], 'the wallet has not been asked to approve before the price reply');
    actionPriceReply.resolve();
    await dialog.locator('[data-v2in-close]').waitFor({ timeout: 60_000 });
    // On v4 a moved approval never disarmed the root (the position manager tells no one): once it is back, the rearm has
    // nothing left to do, and the action is complete.
    assert.deepEqual(chain.sends.map((tx) => [tx.to.toLowerCase(), selectorOf(tx.data)]), [[chain.positionManager[4].toLowerCase(), SELECTOR.approve]], 'the approval back to its automation');
    assert.ok(order.indexOf('price-read') >= 0 && order.indexOf('price-read') < order.indexOf('approve'), 'the action reads the pool price before asking the wallet to approve');
    assert.equal(chain.nft(4, ROOT).approved, vault);
    assert.deepEqual(await dialog.locator('[data-error-code], .dm-error').allInnerTexts(), [], 'never "This step is already done." with no way on');
    assert.equal(chain.vault(vault).paused, true, 'still paused: Auto-exit only, nothing reinvested');
    assert.equal(chain.vault(vault).exitModule, AUTO_EXIT);
    // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §4 item 6): read-v6 still lists the lost approval (its read of the
    // position is older than the approval just given back): the card says "On" at once, never "Approve again" again.
    await dialog.locator('[data-v2in-close]').click();
    await dialog.waitFor({ state: 'detached' });
    await expandAutomation(page);
    const on = page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="on"]`);
    await on.waitFor({ timeout: 30_000 });
    assert.equal(await on.locator('[data-exit-pill]').innerText(), 'On');
    assert.match(await on.locator('[data-v2in-exit-line="on"]').innerText(), /^Closes at 1,855\.72 – 2,504\.92 USDG per ETH$/);
    assert.equal(await on.locator('[data-vault-open="rearm"]').count(), 0, 'no "Approve again" once it was');
  } finally {
    actionPriceReply.resolve();
    await s.close();
  }
});

// Added 2026-10-06 (the integration review, money #4): the approval back puts the signed order in force again, and an end
// the price passed meanwhile would close the position on the next pass.
test('live: "Approve again" with the price already past the end of the range warns first; nothing is sent until the tick; "Turn off instead" opens Auto-exit\'s own Turn off', async () => {
  // The fake chain's own price (4 in raw units, tick about 13,863): far above the range's upper end.
  const { chain, s } = await approvalLost({ price: null });
  const { page } = s;
  try {
    const card = page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="paused"]`);
    await card.waitFor({ timeout: 30_000 });
    await card.locator('[data-exit-fix="rearm"] [data-vault-open="rearm"]').click();
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="vault-rearm"]');
    await dialog.waitFor();
    const past = dialog.locator('[data-exit-past]');
    await past.waitFor({ timeout: 30_000 });
    assert.equal(await past.locator('[data-exit-past-note]').innerText(), "The price is already past the end of your range. Turning Auto-exit back on closes this position at today's price, with the 0.2% fee.");
    await dialog.locator('[data-rearm-consent]').check();
    await dialog.locator('[data-wallet-steps="vault-rearm"] li[data-wallet-step="approve-root"]').waitFor({ timeout: 30_000 });
    assert.equal(await dialog.locator('[data-v2in-send="rearm"]').isDisabled(), true, 'held until the tick');
    assert.deepEqual(chain.sends, []);
    await dialog.screenshot({ path: join(shots(), 'v2in-autoexit-rearm-past.png'), animations: 'disabled' });
    // "Turn off instead": the automation's dialog closes, and the card's own Turn off opens.
    await past.locator('[data-exit-past-off]').click();
    await dialog.waitFor({ state: 'detached' });
    const off = page.locator('[role="dialog"][data-v2in-dialog="cancel-order"]');
    await off.waitFor({ timeout: 30_000 });
    assert.equal(await off.locator('h2').innerText(), 'Turn off Auto-exit');
    await off.getByRole('button', { name: 'Close' }).click();
    await off.waitFor({ state: 'detached' });
    // Or ticked, on anyway: the approval goes back.
    await expandAutomation(page);
    await card.locator('[data-exit-fix="rearm"] [data-vault-open="rearm"]').click();
    await dialog.waitFor();
    await past.waitFor({ timeout: 30_000 });
    await dialog.locator('[data-rearm-consent]').check();
    await past.locator('[data-exit-past-ack]').check();
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="rearm"]')?.disabled === false, null, { timeout: 30_000 });
    await dialog.locator('[data-v2in-send="rearm"]').click();
    await dialog.locator('[data-v2in-close]').waitFor({ timeout: 60_000 });
    assert.deepEqual(chain.sends.map((tx) => selectorOf(tx.data)), [SELECTOR.approve]);
  } finally {
    await s.close();
  }
});

// Added 2026-10-06 (the integration review, rugged-literal #1): any change to the root (Collect fees, Add liquidity) turns
// the vault's live rootArmed false, while the exit, which needs the approval only, can still fire: Auto-exit is on.
test('live: Auto-exit on, its root disarmed by a change made outside it: "On" everywhere, never "Revoke approval" or "Remove Domino"', async () => {
  const liquidity = 10n ** 18n;
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -201060, tickUpper: -198060, liquidity }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  chain.setExitModule(vault, AUTO_EXIT);
  chain.disarm(vault, 2);
  const [below, above] = [sqrtPriceAtTick(-201060), sqrtPriceAtTick(-198060)];
  const portfolio = listing(chain, vault, {
    armed: false, reason: 'changed_outside_domino', paused: true, pausedBy: 'owner', autoExit: true, reserves: [[ZERO, 0n], [USDG, 0n]], root: { owner: OWNER, liquidity },
    orders: (fixture) => fixture.slice(0, 1).map((order) => ({ ...order, tokenId: String(ROOT), status: 'active', expired: false, blockedBy: [], moduleEnabled: true, waiting: waitingOf('trigger_not_reached'), executed: null, revoked: null, terms: { triggerBelowSqrtPriceX96: String(below), triggerAboveSqrtPriceX96: String(above), receive: 'both', convertTo: null, maxSlippageBps: 100 } })),
  });
  const s = await openLive(chain, { hash: '/positions', read6: { portfolio }, v1: rootOnV1({ liquidity }) });
  const { page } = s;
  try {
    // Automation lives in the position row, with no action that could detach an active exit.
    const row = page.locator(`[data-v2-position-row="4663:${portfolio.body.positions[0].positionManager.toLowerCase()}:${ROOT}"]`);
    await row.waitFor({ timeout: 30_000 });
    assert.equal(await row.locator('[data-v2-vault-role="root"] [data-running]').innerText(), 'Auto-exit');
    assert.doesNotMatch(await row.locator('[data-v2-vault-role="root"]').innerText(), /Off|Paused|Unavailable/);
    assert.equal(await row.locator('button').count(), 0, 'never Revoke approval or Remove Domino on an Auto-exit that is on');
    await row.click();
    await expandAutomation(page);
    const card = page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="on"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await card.locator('[data-exit-pill]').innerText(), 'On');
    assert.match(await card.locator('[data-v2in-exit-line="on"]').innerText(), /^Closes at 1,855\.72 – 2,504\.92 USDG per ETH$/);
    assert.equal(await card.locator('[data-vault-open], [data-exit-fix]').count(), 0, 'nothing to fix: it is on');
    await card.locator('[data-exit-details] > summary').click();
    assert.deepEqual(await card.locator('[data-vault-more]').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-vault-more'))), ['recover-token', 'recover-position'], 'no rearm, no Remove Domino, no Revoke approval');
    await card.screenshot({ path: join(shots(), 'v2in-autoexit-on-disarmed-root.png'), animations: 'disabled' });
    assert.deepEqual(chain.sends, []);
  } finally {
    await s.close();
  }
});

// Added 2026-10-06 (the integration review, rugged-literal #1): with none on, its automation's rearm is the first part of
// turning Auto-exit on, and Auto-exit's own dialog opens right after it.
test('live: Auto-exit off on a root a change disarmed: "Turn on" reconnects the position to its automation, then Auto-exit\'s own dialog opens by itself', async () => {
  const liquidity = 10n ** 18n;
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -201060, tickUpper: -198060, liquidity }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  chain.setExitModule(vault, AUTO_EXIT);
  chain.disarm(vault, 2);
  chain.setPrice(4, KEY, (2n ** 96n) / 20000n);
  const portfolio = listing(chain, vault, {
    armed: false, reason: 'changed_outside_domino', paused: true, pausedBy: 'owner', autoExit: true, reserves: [[ZERO, 0n], [USDG, 0n]], root: { owner: OWNER, liquidity },
    orders: (fixture) => fixture.slice(0, 1).map((order) => ({ ...order, tokenId: String(ROOT), status: 'revoked', expired: false, blockedBy: [], moduleEnabled: true, waiting: null, executed: null, revoked: SINCE })),
  });
  const v1 = browserChain({ positions: [{ tokenId: String(ROOT), holder: OWNER, key: KEY, tickLower: -201060, tickUpper: -198060, liquidity, unclaimed: [0n, 0n] }], pools: { [poolIdOf(KEY)]: { sqrtPriceX96: (2n ** 96n) / 20000n, tick: -198080 } }, tokens: TOKENS });
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1 });
  const { page } = s;
  try {
    const card = page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="off"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await card.locator('[data-v2in-exit-line="open"]').innerText(), 'Auto-exit is off. Turn it on to close this position at the end of its range.');
    const turnOn = card.locator('[data-vault-open="rearm"]');
    assert.equal(await turnOn.innerText(), 'Turn on');
    await turnOn.click();
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="vault-rearm"]');
    await dialog.waitFor();
    assert.equal(await dialog.locator('h2').innerText(), 'Turn on Auto-exit');
    assert.equal(await dialog.locator('[data-vault-lede]').innerText(), 'First, reconnect this position to your automation. Then you turn Auto-exit on.');
    assert.doesNotMatch(await dialog.innerText(), /works again|Turn Auto-exit back on/);
    await dialog.locator('[data-rearm-consent]').check();
    await dialog.locator('[data-wallet-steps="vault-rearm"] li[data-wallet-step="rearm"]').waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="rearm"]')?.disabled === false, null, { timeout: 30_000 });
    assert.equal(await dialog.locator('[data-exit-past]').count(), 0, 'none on: no order put back in force, nothing to warn of');
    await dialog.screenshot({ path: join(shots(), 'v2in-autoexit-turn-on-rearm.png'), animations: 'disabled' });
    await dialog.locator('[data-v2in-send="rearm"]').click();
    // The completed receipt remains the only modal. Its next action follows after the person closes it.
    await dialog.locator('[data-v2in-close]').waitFor({ timeout: 60_000 });
    assert.equal(await page.getByRole('dialog').count(), 1);
    assert.equal(await page.locator('[data-v2in-dialog="mandate"]').count(), 0);
    await dialog.locator('[data-v2in-close]').click();
    const mandate = page.locator('[role="dialog"][data-v2in-dialog="mandate"]');
    await mandate.waitFor({ timeout: 60_000 });
    assert.deepEqual(chain.sends.map((tx) => [tx.to.toLowerCase(), selectorOf(tx.data)]), [[vault, toFunctionSelector('rearm(bool)')]]);
    assert.equal(chain.vault(vault).disarmed, false);
    assert.equal(await mandate.locator('[data-mandate-send]').innerText(), 'Turn on Auto-exit');
    assert.equal(chain.log.includes('eth_signTypedData_v4'), false, 'nothing signed before its press');
    await mandate.screenshot({ path: join(shots(), 'v2in-autoexit-turn-on-then-mandate.png'), animations: 'disabled' });
  } finally {
    await s.close();
  }
});

// Added 2026-10-06 (the integration review's second pass, rugged-literal #1 and #2): Leave automation on Auto-exit's own
// automation while its Auto-exit is on turns its module off, so Auto-exit pauses. Nothing then offers to remove Domino from
// the position or to revoke its approval: once Auto-exit is turned back on, a revoked approval would keep it from closing.
test('live: Leave automation with Auto-exit on sends exitAll() and pauses it, in its words: no "remove Domino" or "revoke approval", before or after', async () => {
  const liquidity = 10n ** 18n;
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -201060, tickUpper: -198060, liquidity }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  chain.setExitModule(vault, AUTO_EXIT);
  const [below, above] = [sqrtPriceAtTick(-201060), sqrtPriceAtTick(-198060)];
  const portfolio = listing(chain, vault, {
    armed: true, paused: true, pausedBy: 'owner', autoExit: true, reserves: [[ZERO, 0n], [USDG, 0n]], root: { owner: OWNER, liquidity },
    orders: (fixture) => fixture.slice(0, 1).map((order) => ({ ...order, tokenId: String(ROOT), status: 'active', expired: false, blockedBy: [], moduleEnabled: true, waiting: waitingOf('trigger_not_reached'), executed: null, revoked: null, terms: { triggerBelowSqrtPriceX96: String(below), triggerAboveSqrtPriceX96: String(above), receive: 'both', convertTo: null, maxSlippageBps: 100 } })),
  });
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ liquidity }) });
  const { page } = s;
  try {
    const card = page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="on"]`);
    await card.waitFor({ timeout: 30_000 });
    await card.locator('[data-exit-details] > summary').click();
    await card.locator('[data-vault-more="leave"]').click();
    const leave = page.locator('[role="dialog"][data-v2in-dialog="vault-leave"]');
    await leave.waitFor();
    assert.equal(await leave.locator('[data-vault-lede="leave"]').innerText(), `Auto-exit pauses for position #${ROOT}, and anything your automation holds goes to your wallet. No fee. Turn off ends it for good.`);
    assert.equal(await leave.locator('[data-leave-v4]').count(), 0, 'nothing said of removing Domino or revoking its approval');
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="leave"]')?.disabled === false, null, { timeout: 30_000 });
    assert.deepEqual(chain.sends, [], 'for the person to confirm');
    await leave.locator('[data-v2in-send="leave"]').click();
    await leave.locator('[data-v2in-close]').waitFor({ timeout: 30_000 });
    assert.deepEqual(chain.sends.map((tx) => [tx.to.toLowerCase(), selectorOf(tx.data)]), [[vault, SELECTOR.exitAll]]);
    assert.equal(chain.vault(vault).exitModule, ZERO, 'its module off: Auto-exit paused, its order kept');
    assert.equal(chain.nft(4, ROOT).approved, vault, 'the approval an exit needs, untouched');
    assert.equal(await leave.locator('[data-leave-follow-ups], [data-v2in-follow]').count(), 0, 'no follow-up that would cut the position from it');
    await leave.screenshot({ path: join(shots(), 'v2in-autoexit-leave-done.png'), animations: 'disabled' });
    // Added 2026-10-06 (the final check, F2): paused at once, from exitAll's own receipt, while the index still lists it on,
    // as the dialog just said; its way back on beside the line that says why.
    await leave.locator('[data-v2in-close]').click();
    await leave.waitFor({ state: 'detached' });
    await expandAutomation(page);
    const paused = page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="paused"]`);
    await paused.waitFor({ timeout: 30_000 });
    assert.equal(await paused.locator('[data-exit-pill]').innerText(), 'Paused');
    assert.equal(await paused.locator('[data-v2in-exit-line="paused"]').innerText(), "Paused: your automation doesn't allow Auto-exit right now.");
    assert.equal(await paused.locator('[data-order-module-on]').innerText(), 'Turn back on');
    assert.equal(await paused.locator('[data-exit-off]').innerText(), 'Turn off');
    assert.doesNotMatch(await paused.innerText(), /turned off/i, 'a pause is never said as "turned off" beside "Turn off"');
    await paused.screenshot({ path: join(shots(), 'v2in-autoexit-left-paused.png'), animations: 'disabled' });
  } finally {
    await s.close();
  }
});

// Added 2026-10-06 (the integration review's second pass): with none on (turned off, expired, or it closed the position),
// Leave automation has nothing to pause: its automation stops for the position, and the follow-ups stay offered.
test('live: Leave automation with Auto-exit off says its automation stops for the position, never that Auto-exit pauses', async () => {
  const liquidity = 10n ** 18n;
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -201060, tickUpper: -198060, liquidity }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  chain.setExitModule(vault, AUTO_EXIT);
  chain.setPrice(4, KEY, (2n ** 96n) / 20000n);
  const portfolio = listing(chain, vault, {
    armed: true, paused: true, pausedBy: 'owner', autoExit: true, reserves: [[ZERO, 0n], [USDG, 0n]], root: { owner: OWNER, liquidity },
    orders: (fixture) => fixture.slice(0, 1).map((order) => ({ ...order, tokenId: String(ROOT), status: 'revoked', expired: false, blockedBy: [], moduleEnabled: true, waiting: null, executed: null, revoked: SINCE })),
  });
  const v1 = browserChain({ positions: [{ tokenId: String(ROOT), holder: OWNER, key: KEY, tickLower: -201060, tickUpper: -198060, liquidity, unclaimed: [0n, 0n] }], pools: { [poolIdOf(KEY)]: { sqrtPriceX96: (2n ** 96n) / 20000n, tick: -198080 } }, tokens: TOKENS });
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1 });
  const { page } = s;
  try {
    const card = page.locator(`[data-automation-panel] [data-v2in-exit][data-exit-state="off"]`);
    await card.waitFor({ timeout: 30_000 });
    await card.locator('[data-exit-details] > summary').click();
    await card.locator('[data-vault-more="leave"]').click();
    const leave = page.locator('[role="dialog"][data-v2in-dialog="vault-leave"]');
    await leave.waitFor();
    assert.equal(await leave.locator('[data-vault-lede="leave"]').innerText(), `Your Auto-exit automation stops for position #${ROOT}, and anything it holds goes to your wallet. No fee.`);
    assert.doesNotMatch(await leave.innerText(), /Auto-exit pauses|Turn off ends it/, 'nothing on to pause, and no Turn off on its card');
    assert.equal(await leave.locator('[data-leave-v4]').innerText(), `Afterwards you can remove Domino from position #${ROOT} and revoke your automation's approval on it.`);
    await leave.locator('[data-wallet-step="exit-all"]').waitFor({ timeout: 30_000 });
    await leave.screenshot({ path: join(shots(), 'v2in-autoexit-off-leave.png'), animations: 'disabled' });
    await leave.getByRole('button', { name: 'Close' }).click();
    await leave.waitFor({ state: 'detached' });
    assert.deepEqual(chain.sends, [], 'nothing sent');
  } finally {
    await s.close();
  }
});

// Added 2026-10-06 (the integration review's second pass, rugged-literal #1): where the page draws no Auto-exit card (its own
// read of the position missing, failed or still loading), Auto-exit's own automation is drawn as an automation card. That
// card never offers its rearm ("Approve again" or "Turn on"): only the Auto-exit card does, beside why Auto-exit is paused.
test('live: Auto-exit paused after Leave automation, its position\'s read missing: the automation card offers no rearm', async () => {
  const liquidity = 10n ** 18n;
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -201060, tickUpper: -198060, liquidity }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  const portfolio = listing(chain, vault, {
    armed: false, reason: 'exit_all', paused: true, pausedBy: 'owner', reserves: [[ZERO, 0n], [USDG, 0n]], root: { owner: OWNER, liquidity },
    orders: (fixture) => fixture.slice(0, 1).map((order) => ({ ...order, tokenId: String(ROOT), status: 'active', expired: false, blockedBy: ['module_disabled'], moduleEnabled: false, waiting: null, executed: null, revoked: null })),
  });
  // V1's own read finds no such NFT: the page has no position to draw the Auto-exit card with.
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ burned: true }) });
  const { page } = s;
  try {
    await page.locator('[data-empty="position-gone"]').waitFor({ timeout: 30_000 });
    const card = page.locator(`[data-automation-panel] section[data-vault-card="${vault}"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await page.locator(`[data-automation-panel] [data-v2in-exit]`).count(), 0, 'no Auto-exit card here');
    assert.equal(await card.getAttribute('data-vault-exit'), 'paused');
    assert.equal(await card.locator('[data-vault-pill]').innerText(), 'Auto-exit paused');
    // Its one line says where Auto-exit stands, never "Open the position": this is the position's page.
    assert.equal(await card.locator('[data-vault-state]').innerText(), 'Auto-exit is paused for this position.');
    assert.equal(await card.locator('[data-vault-open="rearm"], [data-vault-more="rearm"]').count(), 0, 'no rearm, under any name');
    assert.equal(await card.locator('[data-vault-more="unsubscribe"], [data-vault-more="revoke"], [data-vault-open="unsubscribe"], [data-vault-open="revoke"]').count(), 0, 'never a way to cut the position from it');
    assert.doesNotMatch(await card.innerText(), /Approve again|Turn on|Turn back on/);
    await card.screenshot({ path: join(shots(), 'v2in-autoexit-fallback-card.png'), animations: 'disabled' });
    assert.deepEqual(chain.sends, []);
  } finally {
    await s.close();
  }
});

test('one NFT with earlier setups has one overview row and one top control; previous balances stay available on mobile', async () => {
  const liquidity = 1_000_000n;
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -600, tickUpper: 600, liquidity }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT });
  const portfolio = listing(chain, vault, { armed: true, reserves: [[ZERO, 0n], [USDG, 0n]], root: { owner: OWNER, liquidity } });
  const previous = structuredClone(portfolio.body.vaults[0]);
  previous.address = '0x7777777777777777777777777777777777777777';
  previous.ownerNonce = '0';
  previous.pausedBy = 'owner';
  previous.autoExitEnabled = true;
  previous.state.paused = true;
  previous.state.rootArmed = false;
  previous.state.exitModule = AUTO_EXIT;
  previous.custody = { armed: false, reason: 'auto_exit', since: SINCE, source: 'event' };
  previous.members[0] = { ...previous.members[0], status: 'disarmed', disarmReason: 'auto_exit' };
  previous.state.reserves = [{ token: ZERO, idle: '0', total: '0' }, { token: USDG, idle: '5000000', total: '5000000' }];
  portfolio.body.vaults.unshift(previous);
  const readRuntime = await import('../../../api-contracts/read-v6/runtime.mjs');
  assert.equal(readRuntime.validateResponse('portfolio', portfolio.body), true, 'the combined history is a valid portfolio');
  const s = await openLive(chain, { hash: '/positions', read6: { portfolio }, v1: rootOnV1({ liquidity }) });
  try {
    const { page } = s;
    // Automation now lives on the unified NFT row; the separate Managed positions wall was removed.
    // Wait for read-v6's automation metadata as well as the faster historical inventory's row.
    const rows = page.locator(`[data-owned-rows] [data-v2-position-row$=":${ROOT}"]`);
    await rows.first().waitFor({ timeout: 30_000 });
    await rows.locator('[data-v2-vault-role="root"]').waitFor({ timeout: 30_000 });
    assert.equal(await rows.count(), 1, 'historical vaults never duplicate the NFT');
    assert.equal(await page.locator('[data-automated-position], section[aria-labelledby="managed-title"]').count(), 0, 'no second overview wall');
    assert.match(await rows.innerText(), /Auto-compound/);
    assert.doesNotMatch(await rows.innerText(), /Auto-exit/, 'the previous setup never replaces the current mode');
    assert.equal(await rows.locator('button').count(), 0, 'overview only navigates');
    assert.match(await rows.innerText(), /Funds available in automation/);
    await rows.click();
    const control = page.locator('[data-automation-control]');
    await control.waitFor();
    assert.equal(await page.locator('[data-automation-panel]').isVisible(), false, 'management stays out of the page until requested');
    assert.equal(await page.locator('[data-position-actions] [data-automation-control]').count(), 1, 'automation belongs to the action bar');
    assert.equal(await page.getByRole('dialog').count(), 0);
    await expandAutomation(page);
    const management = page.locator('[data-automation-management]');
    assert.equal(await management.locator('h2').innerText(), 'Auto-compound');
    assert.equal(await management.locator('[data-vault-details]').evaluate((node) => node.open), false);
    const panel = page.locator('[data-automation-panel]');
    assert.equal(await panel.locator('section[data-vault-card]').count(), 1);
    assert.equal(await panel.locator('section[data-vault-card]').getAttribute('data-vault-card'), vault, 'current NFT approval wins');
    assert.equal(await panel.locator('[data-exit-state="closed"]').count(), 0, 'the old Auto-exit does not replace the current mode');
    const detailsSummary = panel.locator('[data-vault-details] > summary');
    const previousSummary = panel.locator('[data-automation-recovery] > summary');
    await detailsSummary.focus();
    await page.keyboard.press('Tab');
    assert.equal(await previousSummary.evaluate(node => document.activeElement === node), true, 'closed details cannot strand focus on a hidden action or skip the next disclosure');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await detailsSummary.evaluate(node => document.activeElement === node), true, 'native disclosures participate in both directions of the modal tab order');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Enter');
    const held = panel.locator(`[data-recovery-vault="${previous.address}"]`);
    assert.match(await held.innerText(), /5 USDG/);
    assert.equal(await held.getByRole('button', { name: 'Resume', exact: true }).count(), 0);
    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await page.screenshot({ path: join(shots(), `one-nft-current-and-previous-setups-${width}.png`), fullPage: true, animations: 'disabled' });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await management.locator('.dm-pa-body').evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true, `management body fits at ${width}`);
      const foot = await management.locator('.dm-pa-foot').boundingBox();
      assert.ok(foot && foot.y >= 0 && foot.y + foot.height <= 845, `the way back remains on screen at ${width}: ${JSON.stringify(foot)}`);
    }
    await page.keyboard.press('Escape');
    await management.waitFor({ state: 'detached' });
    assert.equal(await control.evaluate((node) => document.activeElement === node), true, 'closing management returns focus to its toolbar control');
    assert.equal(await page.locator('[data-automation-panel]').isVisible(), false);
    assert.deepEqual(chain.log.filter((method) => SENDS_AND_SIGNATURES.includes(method) || method === 'wallet_switchEthereumChain'), [], 'reading management never signs, sends or switches');
  } finally { await s.close(); }
});

test('Auto-compound and Domino-compound management share the action sheet; recovery stays under More options and opening it cannot send', async () => {
  for (const [mode, label, words] of [[1, 'Auto-compound', 'Earned fees go back into this position.'], [2, 'Domino-compound', 'Earned fees can fund your next position.']]) {
    const liquidity = 1_000_000n;
    const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -600, tickUpper: 600, liquidity }] });
    const policy = { mode, triggerDistanceBps: 500, maxOverlapBps: 500, minimumIntervalSeconds: 3600, maxPositions: mode === 2 ? 3 : 1 };
    const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, policy });
    const portfolio = listing(chain, vault, { armed: true, reserves: [[ZERO, 0n], [USDG, 0n]], root: { owner: OWNER, liquidity } });
    portfolio.body.vaults[0].state.policy.mode = mode === 2 ? 'domino' : 'simple';
    portfolio.body.vaults[0].state.policy.maxPositions = policy.maxPositions;
    const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ liquidity }) });
    try {
      const { page } = s;
      const management = page.locator('[data-automation-management]');
      const card = management.locator('[data-vault-card]');
      assert.equal(await management.locator('h2').innerText(), label);
      assert.equal(await card.locator('[data-vault-state]').innerText(), words);
      assert.equal(await card.locator('[data-vault-open="leave"]').isVisible(), true);
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await page.screenshot({ path: join(shots(), `automation-management-${mode}-${width}.png`), fullPage: true, animations: 'disabled' });
        assert.equal(await management.locator('.dm-pa-body').evaluate(node => node.scrollWidth <= node.clientWidth + 1), true, `${label} management fits at ${width}`);
      }
      await page.setViewportSize({ width: 1280, height: 1000 });
      assert.equal(await card.locator('[data-vault-advanced-open]').count(), 2, 'token and position recovery remain available');
      assert.equal(await card.locator('[data-vault-advanced-open="recover-position"]').isVisible(), false);
      await card.locator('[data-vault-details] > summary').click();
      const more = card.locator('details').filter({ has: page.locator('[data-vault-advanced-open="recover-position"]') }).last();
      assert.equal(await more.locator('summary').innerText(), 'More options');
      await more.locator('summary').click();
      await card.locator('[data-vault-advanced-open="recover-position"]').click();
      const recover = page.locator('[role="dialog"][data-v2in-dialog="vault-recover-position"]');
      await recover.waitFor();
      assert.equal(await page.getByRole('dialog').count(), 1, 'the financial dialog replaces management');
      assert.equal(await page.locator('[data-automation-management]').count(), 0);
      assert.deepEqual(chain.sends, []);
      assert.equal(chain.log.some((method) => method === 'eth_signTypedData_v4' || method === 'personal_sign' || method === 'wallet_switchEthereumChain'), false);
      await page.keyboard.press('Escape');
      await recover.waitFor({ state: 'detached' });
      await expandAutomation(page);
      assert.equal(await management.locator('h2').innerText(), label, 'closing an action keeps the same management available');
    } finally { await s.close(); }
  }
});

test('Auto-exit recoverable credits stay in management; a different recipient is progressive and its claim replaces the sheet', async () => {
  const chain = createVaultChain({ chainId: 4663, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -201060, tickUpper: -198060, liquidity: 10n ** 18n }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: true });
  chain.setExitModule(vault, AUTO_EXIT);
  chain.closeRoot(4, ROOT);
  chain.disarm(vault, 6);
  chain.setUnclaimed(OWNER, USDG, 5_000_000n);
  const portfolio = listing(chain, vault, {
    armed: false, reason: 'auto_exit', paused: true, pausedBy: 'owner', autoExit: true, reserves: [[ZERO, 0n], [USDG, 0n]], root: { owner: OWNER, liquidity: 0n },
    orders: (fixture) => fixture.slice(0, 1).map((order) => ({ ...order, tokenId: String(ROOT), status: 'executed', expired: false, blockedBy: [], moduleEnabled: true, waiting: null, revoked: null,
      executed: { tx: SINCE, anchorSqrtPriceX96: String(sqrtPriceAtTick(-201060)), delivered: ['0', '0'] },
      terms: { triggerBelowSqrtPriceX96: String(sqrtPriceAtTick(-201060)), triggerAboveSqrtPriceX96: String(sqrtPriceAtTick(-198060)), receive: 'both', convertTo: null, maxSlippageBps: 100 } })),
  });
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ liquidity: 0n }) });
  try {
    const { page } = s;
    const management = page.locator('[data-automation-management]');
    const claim = management.locator('[data-claim]');
    await claim.waitFor();
    assert.match(await claim.innerText(), /5 USDG/);
    assert.equal(await claim.locator('[data-claim-recipient]').isVisible(), false, 'the default wallet needs no address field');
    await claim.getByText('Send to another address', { exact: true }).click();
    await claim.locator('[data-claim-recipient]').fill(OTHER);
    assert.deepEqual(chain.sends, [], 'reading or choosing a recipient sends nothing');
    await claim.locator(`[data-claim-open="${USDG}"]`).click();
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="claim"]');
    await dialog.waitFor();
    assert.equal(await page.getByRole('dialog').count(), 1);
    assert.equal(await management.count(), 0);
    assert.match(await dialog.innerText(), /5 USDG/);
    assert.match(await dialog.innerText(), new RegExp(OTHER, 'i'), 'the review keeps the chosen recipient after management closes');
    await dialog.locator('[data-v2in-send="claim"]:not([disabled])').waitFor({ timeout: 30_000 });
    await dialog.locator('[data-v2in-send="claim"]').click();
    await dialog.locator('[data-v2in-close]').waitFor({ timeout: 30_000 });
    assert.equal(chain.sends.length, 1);
    const { functionName, args } = decodeFunctionData({ abi: ABI.autoExit, data: chain.sends[0].data });
    assert.deepEqual([functionName, args.map((value) => String(value).toLowerCase())], ['claim', [USDG, OTHER.toLowerCase()]]);
    await dialog.locator('[data-v2in-close]').click();
    await expandAutomation(page);
    assert.equal(await page.locator('[data-automation-management] [data-claim]').count(), 0, 'the completed claim updates the available balance without a reload');
  } finally { await s.close(); }
});

// Final frontend pass: exercise both setup modes through the real UI and the fake wallet, including completion.
for (const [mode, title, policyMode, fee] of [['compound', 'Auto-compound', 1, '2%'], ['domino', 'Domino-compound', 2, '4%']]) {
  test(`final pass: ${title} setup validates limits, requires consent and completes its wallet steps`, async () => {
    const liquidity = 10n ** 18n;
    const chain = createVaultChain({ chainId: 4663, atomic: 'ready', simulateV1: true, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -600, tickUpper: 600, liquidity }] });
    const v1 = rootOnV1({ liquidity });
    const s = await openLive(chain, { hash: `/sequence/${mode}/${ROOT}`, read6: { portfolio: plainPortfolio(v1, OWNER) }, v1 });
    try {
      const { page } = s;
      const flow = page.locator('[data-v2in-setup="live"]');
      await flow.locator(`[data-sequence-position="${ROOT}"][aria-checked="true"]`).waitFor();
      assert.equal(await flow.locator(`[data-sequence-mode="${mode}"]`).getAttribute('aria-checked'), 'true');
      assert.match(await flow.locator(`[data-sequence-mode="${mode}"]`).innerText(), new RegExp(fee));
      const send = flow.locator('[data-sequence-action="run"]');
      assert.equal(await send.isDisabled(), true, 'a preselected mode does not supply consent');
      await flow.getByText('More limits', { exact: true }).click();
      const slippage = flow.locator('[data-setting-input="maxSlippagePercent"]');
      await slippage.fill('6');
      assert.equal(await slippage.getAttribute('aria-invalid'), 'true');
      await flow.locator('[data-v2in-consent]').check();
      assert.equal(await send.isDisabled(), true, 'invalid limits cannot open the wallet');
      await slippage.fill('0.5');
      assert.equal(await flow.locator('[data-v2in-consent]').isChecked(), false, 'editing a limit clears earlier consent');
      if (await slippage.evaluate(node => node.closest('details')?.open)) await flow.getByText('More limits', { exact: true }).click();
      await flow.locator('[data-v2in-consent]').check();
      await flow.locator('[data-sequence-action="run"]:not([disabled])').waitFor({ timeout: 30_000 });
      assert.deepEqual(chain.sends, [], 'review does not send');
      assert.equal(chain.log.includes('wallet_sendCalls'), false);
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 960 });
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${mode} fits at ${width}`);
        await page.screenshot({ path: join(shots(), `final-${mode}-ready-${width}.png`), fullPage: true, animations: 'disabled' });
      }
      await send.click();
      const done = page.locator('[data-v2in-created]');
      await done.waitFor({ timeout: 60_000 });
      const vault = await done.getAttribute('data-v2in-created');
      assert.equal(chain.vault(vault).policy.mode, policyMode, 'the chosen mode reaches the simulated chain');
      assert.equal(chain.vault(vault).limits.maxSlippageBps, 50, 'the exact edited limit reaches the simulated chain');
      assert.equal(chain.vault(vault).paused, false);
      assert.equal(chain.log.filter(method => method === 'wallet_sendCalls').length, 1, 'approval and setup share one supported wallet confirmation');
      assert.match(await done.innerText(), new RegExp(`${title} is set up`));
      assert.equal(await done.getByRole('link', { name: 'View position', exact: true }).getAttribute('href'), `#/positions/${ROOT}`);
      await done.screenshot({ path: join(shots(), `final-${mode}-complete-320.png`), animations: 'disabled' });
    } finally { await s.close(); }
  });
}

test('final pass: all three automation entries have an honest empty state and compounding read failures recover in place', async () => {
  const holder = ACCOUNTS[0].address.toLowerCase();
  const emptyChain = browserChain({ positions: [], tokens: TOKENS });
  for (const mode of ['compound', 'domino', 'protection']) {
    const completeEmpty = plainPortfolio(emptyChain, holder, body => {
      body.chains = body.chains.map(chain => ({ ...body.chains[0], chainId: chain.chainId }));
      body.coverage = 'complete';
      body.truncated = { positions: false, mandates: false, vaults: false };
    });
    const empty = await openPreview(emptyChain, `/sequence/${mode}`, { portfolio: completeEmpty });
    try {
      await empty.page.locator('[data-sequence-positions="empty"]').waitFor();
      assert.equal(await empty.page.getByRole('link', { name: 'View positions', exact: true }).getAttribute('href'), '#/positions');
      assert.equal(await empty.page.locator('[data-v2in-consent], [data-mandate-send]').count(), 0);
      await empty.page.setViewportSize({ width: 320, height: 800 });
      assert.ok(await empty.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await empty.page.locator('main').screenshot({ path: join(shots(), `final-${mode}-empty-320.png`), animations: 'disabled' });
      assert.deepEqual(empty.wallet.state.log.filter(entry => SENDS_AND_SIGNATURES.includes(entry.method)), []);
    } finally { await empty.close(); }
  }
  const v1 = browserChain({ positions: [{ tokenId: String(ROOT), holder, key: KEY, tickLower: -600, tickUpper: 600, liquidity: 10n ** 18n }], tokens: TOKENS });
  for (const mode of ['compound', 'domino']) {
    const s = await openPreview(v1, `/sequence/${mode}`, { portfolio: { status: 503, body: { error: 'upstream_unavailable' } } });
    try {
      await s.page.locator('[data-sequence-positions="failed"]').waitFor();
      assert.equal(await s.page.locator('[data-sequence-positions="empty"]').count(), 0, 'read failure is not an empty portfolio');
      // Changed on purpose 2026-10-30 (QA round 2, the owner's rule: reads are asked again silently): no Try again; the
      // portfolio is asked again by itself, 5 s after a first failure (src/v2in/lists/source.ts).
      assert.equal(await s.page.getByRole('button', { name: 'Try again', exact: true }).count(), 0);
      await s.page.evaluate(value => { window.__dominoV2Test.read6.portfolio = () => value; }, plainPortfolio(v1, holder));
      await s.page.locator(`[data-sequence-position="${ROOT}"]`).waitFor({ timeout: 30_000 });
      assert.equal(await s.page.locator('[data-v2in-consent]').count(), 0, 'recovery has not picked an NFT or supplied consent');
      assert.deepEqual(s.wallet.state.log.filter(entry => SENDS_AND_SIGNATURES.includes(entry.method)), []);
    } finally { await s.close(); }
  }
});


/** The identical NFT id on another network must select that manager, never Robinhood's. */
function multichainSetupPortfolio(chain, dex, pool, tokenId = ROOT) {
  return read6Answer('portfolio', 'portfolio-custody-lost', [[READ6.wallet, OWNER]], body => {
    const current = body.chains.find(entry => entry.chainId === 4663);
    body.chains = body.chains.map(entry => ({ ...structuredClone(current), chainId: entry.chainId }));
    body.coverage = 'complete';
    const template = body.positions[0];
    body.vaults = []; body.mandates = []; body.credits = [];
    body.truncated = { vaults: false, positions: false, mandates: false };
    body.positions = [{ ...template, chainId: chain.chainId, dex, tokenId: String(tokenId), vault: null,
      positionManager: chain.profile.uniswap['v' + dex].positionManager,
      state: { ...template.state, owner: OWNER, custody: { approved: null, subscriber: null },
        freshness: { status: 'fresh', ageSeconds: 0 }, pool: { ...pool, dex, hooks: ZERO },
        feesOwed: dex === 3 ? ['1200', '0'] : ['0', '0'], liquidity: String(10n ** 18n),
        tickLower: -600, tickUpper: 600, tick: 0, sqrtPriceX96: String(2n ** 96n), inRange: true,
      },
    }];
    body.tokens = [pool.currency0, pool.currency1].map(address => {
      const token = chain.profile.chargeCurrencies.find(value => value.address === address);
      return { chainId: chain.chainId, address, status: 'available', symbol: token?.symbol ?? (address === chain.profile.wrappedNative.address ? 'WETH' : 'ETH'), decimals: token?.decimals ?? 18, price: null, priceReason: 'no_qualified_price_source' };
    });
  });
}

for (const chainId of [8453, 42161]) for (const dex of [3, 4]) for (const mode of ['compound', 'domino']) {
  test('multichain setup: ' + chainId + ' v' + dex + ' ' + mode + ' preserves consent and sends only to its own manager and factory', async () => {
    const profile = require('../../.test-build/app/src/v2/chains.js').v2Chain(chainId);
    const stable = profile.chargeCurrencies.find(token => token.decimals === 6).address;
    const currencies = [dex === 3 ? profile.wrappedNative.address : ZERO, stable].sort((a,b) => BigInt(a) < BigInt(b) ? -1 : 1);
    const pool = { currency0: currencies[0], currency1: currencies[1], fee: 3000, tickSpacing: 60 };
    const chain = createVaultChain({ chainId, positions: [{ dex, tokenId: ROOT, pool, liquidity: 10n ** 18n, owed: dex === 3 ? [1200n,0n] : undefined }] });
    const slug = chainId === 8453 ? 'base' : 'arbitrum';
    const throughDetail = chainId === 8453 && dex === 3 && mode === 'compound';
    const s = await openLive(chain, { hash: throughDetail ? '/positions/' + slug + '-v' + dex + '-' + ROOT : '/sequence/' + mode + '/' + slug + '-v' + dex + '-' + ROOT,
      read6: { portfolio: multichainSetupPortfolio(chain, dex, pool) }, v1: rootOnV1({ liquidity: 10n ** 18n }) });
    try {
      const { page } = s;
      if (throughDetail) {
        const setup = page.locator('[data-automation-setup]');
        await setup.waitFor();
        assert.equal(await setup.getAttribute('href'), '#/sequence/base-v3-' + ROOT, 'the affected Base v3 detail offers all modes for that exact NFT');
        await setup.click();
        await page.locator('[data-sequence-mode="compound"]').click();
      }
      const flow = page.locator('[data-v2in-setup="live"]');
      await flow.locator('[data-sequence-position-key="' + chainId + ':' + dex + ':' + ROOT + '"][aria-checked="true"]').waitFor();
      assert.match(await flow.locator('[data-sequence-position]').innerText(), new RegExp(profile.name));
      assert.equal(await flow.locator('[data-sequence-action="run"]').isDisabled(), true);
      await flow.locator('[data-v2in-consent]').check();
      await flow.locator('[data-sequence-action="run"]:not([disabled])').waitFor({ timeout: 30_000 });
      assert.deepEqual(chain.sends, [], 'review is read-only');
      if (dex === 3) {
        assert.match(await flow.locator('[data-v3-owed-to-wallet]').innerText(), /sent to your wallet/);
        assert.match(await flow.locator('.dm-seq-consent').innerText(), /I agree to reinvest earned fees/);
        assert.doesNotMatch(await flow.locator('.dm-seq-consent').innerText(), /already earned and not collected will be reinvested/, 'v3 arming sends tokensOwed to the owner; consent must not claim they all get reinvested');
      }
      if (throughDetail) await page.screenshot({ path: join(shots(), 'base-v3-compound-ready-desktop.png'), fullPage: true, animations: 'disabled' });
      await page.setViewportSize({ width: 390, height: 960 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (throughDetail) await page.screenshot({ path: join(shots(), 'base-v3-compound-ready-mobile.png'), fullPage: true, animations: 'disabled' });
      if (throughDetail) {
        const lagging = multichainSetupPortfolio(chain, dex, pool); lagging.body.positions = [];
        await page.evaluate(answer => {
          window.__setupApprovalRefreshes = 0;
          window.__dominoV2Test.read6.portfolio = () => { window.__setupApprovalRefreshes++; return answer; };
        }, lagging);
      }
      await flow.locator('[data-sequence-action="run"]').click();
      const done = page.locator('[data-v2in-created]');
      await done.waitFor({ timeout: 60_000 });
      if (throughDetail) {
        await page.waitForFunction(() => window.__setupApprovalRefreshes > 0);
        assert.equal(await done.isVisible(), true, 'a portfolio refresh after approval cannot discard the active review or its completed result');
      }
      const vault = chain.vault(await done.getAttribute('data-v2in-created'));
      assert.equal(vault.dex, dex);
      assert.equal(vault.policy.mode, mode === 'domino' ? 2 : 1);
      assert.equal(vault.paused, false);
      assert.equal(chain.sends[0].to.toLowerCase(), profile.uniswap['v' + dex].positionManager);
      assert.equal(chain.sends[1].to.toLowerCase(), chain.contracts.addresses[dex === 3 ? 'vaultFactoryV3' : 'vaultFactoryV4']);
      assert.equal(chain.log.includes('personal_sign'), false);
      assert.equal(await done.getByRole('link', { name: 'View position', exact: true }).getAttribute('href'), '#/positions/' + slug + '-v' + dex + '-' + ROOT);
      if (dex === 3) assert.ok(chain.paid.some(entry => entry.why === 'v3-owed-at-arming' && entry.to === OWNER));
    } finally { await s.close(); }
  });
}


test('multichain setup: an unreadable Base approval resumes its existing hash and finishes without reload or duplicate send', async () => {
  const profile = require('../../.test-build/app/src/v2/chains.js').v2Chain(8453);
  const stable = profile.chargeCurrencies.find(token => token.decimals === 6).address;
  const currencies = [profile.wrappedNative.address, stable].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  const pool = { currency0: currencies[0], currency1: currencies[1], fee: 3000, tickSpacing: 60 };
  const chain = createVaultChain({ chainId: 8453, finality: 'lagging', positions: [{ dex: 3, tokenId: ROOT, pool, liquidity: 10n ** 18n }] });
  const request = chain.request.bind(chain); let unreadable = true, finalized = false;
  chain.request = async (...args) => {
    if (finalized && args[0] === 'eth_getBlockByNumber' && args[1]?.[0] === 'finalized') return request('eth_getBlockByNumber', ['latest', false]);
    const answer = await request(...args);
    if (args[0] === 'eth_getTransactionReceipt' && chain.sends.length === 1 && unreadable && answer.result) {
      unreadable = false;
      return { result: { ...answer.result, transactionHash: `0x${'ff'.repeat(32)}` } };
    }
    return answer;
  };
  // Changed on purpose 2026-10-15 (pack 8, incident C5): the page's clock is installed, so the one read at finality can
  // be reached (twenty minutes after inclusion on Base with no mark from read-v6, src/config/receiptSources.ts); and
  // read-v6's finalized mark for Base agrees with this wallet's own finalized block (behind the steps' blocks): the
  // mark is the queue's hint for that read on every chain now, and the fixtures' own mark said their blocks were final.
  const portfolio = multichainSetupPortfolio(chain, 3, pool), activity = read6Answer('activity', 'activity-empty', [[READ6.wallet, OWNER]]);
  for (const answer of [portfolio, activity]) for (const entry of answer.body.chains) if (entry.chainId === 8453 && entry.finalizedThrough) entry.finalizedThrough.number = 1;
  const s = await openLive(chain, { hash: '/sequence/compound/base-v3-' + ROOT,
    read6: { portfolio, activity }, v1: rootOnV1({ liquidity: 10n ** 18n }),
    beforeOpen: async ({ page }) => { await page.clock.install(); } });
  try {
    const { page } = s, flow = page.locator('[data-v2in-setup="live"]');
    await flow.locator('[data-v2in-consent]').check();
    const button = flow.locator('[data-sequence-action="run"]');
    await page.waitForFunction(() => document.querySelector('[data-sequence-action="run"]')?.disabled === false);
    await button.click();
    await flow.locator('[data-wallet-step="approve-root"][data-step-phase="failed"]').waitFor({ timeout: 30_000 });
    assert.equal(await button.innerText(), 'Check transaction');
    assert.match(await flow.locator('[data-wallet-step="approve-root"]').innerText(), /confirmation.*continue/i);
    assert.equal(chain.sends.length, 1);
    await button.click();
    await page.locator('[data-v2in-created]').waitFor({ timeout: 30_000 });
    assert.equal(chain.sends.length, 2, 'the existing approval was read; only the previously reviewed setup was sent next');
    assert.equal(chain.sends.filter(tx => tx.data.startsWith(SELECTOR.approve)).length, 1);
    // Added 2026-10-15 (pack 8, incident C5): both steps are in a block; their receipts are read through the wallet once
    // more each, at finality, and not before (the follow of ffbd80ab read each every 5 s, then 15 s, then 30 s).
    const receiptReads = () => chain.log.filter(method => method === 'eth_getTransactionReceipt').length;
    const included = receiptReads();
    await page.evaluate(() => { location.hash = '#/positions'; });
    await page.locator('[data-session-activity][data-v2-finality="included"]').waitFor({ timeout: 30_000 });
    await page.evaluate(id => { location.hash = '#/positions/base-v3-' + id; }, String(ROOT));
    await page.locator('[data-position-activity] [data-session-activity][data-v2-finality="included"]').waitFor({ timeout: 30_000 });
    await page.evaluate(() => { location.hash = '#/positions/receipts'; });
    const activity = page.locator('[data-session-activity]');
    await activity.waitFor({ timeout: 30_000 });
    assert.equal(await activity.getAttribute('data-v2-finality'), 'included');
    // Rewritten on purpose 2026-10-14 (incident C1; the owner's decision D0): this case held the defect. A setup whose
    // receipt was checked in a block is "Confirmed" at once, with the check; it said "Confirming" until Base's finalized
    // block passed it (15 to 20 minutes). Finality is one line of the opened receipt: "Confirmed. Not final on Ethereum
    // yet.", then "Final.". It was "Included, not final yet", then "Finalized".
    assert.equal(await activity.locator('summary .dm-receipt-check[aria-label="Confirmed"]').count(), 1, 'the check at inclusion');
    assert.equal(await activity.locator('.dm-receipt-exception').count(), 0, 'no pill');
    assert.doesNotMatch(await page.locator('main').innerText(), /Confirming/, '"Confirming" is nowhere on Receipts');
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): the network alone; it said 'Base · Updating history'.
    assert.equal(await activity.locator('.dm-activity-time').innerText(), 'Base', 'observation time is not a block timestamp');
    await activity.locator('summary').click();
    assert.match(await activity.innerText(), /Status\s+Confirmed\. Not final on Ethereum yet\./);
    // Ten minutes after inclusion, every timer due in them fired once: nothing reads the receipts yet.
    await page.clock.fastForward(10 * 60_000);
    await page.waitForTimeout(1_500);
    assert.equal(receiptReads(), included, 'no wallet read between inclusion and finality');
    finalized = true;
    await page.clock.fastForward(21 * 60_000);
    await page.locator('[data-session-activity][data-v2-finality="finalized"]').waitFor({ timeout: 30_000 });
    for (let n = 0; receiptReads() - included < 2 && n < 100; n++) await new Promise(done => setTimeout(done, 50));
    assert.equal(receiptReads() - included, 2, 'one read at finality for each of the two steps');
    assert.match(await activity.innerText(), /Status\s+Final\./);
    assert.doesNotMatch(await activity.innerText(), /Confirming|Not final on Ethereum yet|Included, not final yet|Finalized/);
    assert.equal(await activity.locator('summary .dm-receipt-check[aria-label="Confirmed"]').count(), 1, 'the same check once final');
    assert.equal(chain.sends.length, 2, 'after leaving setup, confirmation follows the same transaction without another wallet send');
  } finally { await s.close(); }
});

test('multichain setup: an approved step does not hide a later setup offered without a hash; checking refreshes without sending', async () => {
  const profile = require('../../.test-build/app/src/v2/chains.js').v2Chain(8453);
  const stable = profile.chargeCurrencies.find(token => token.decimals === 6).address;
  const currencies = [profile.wrappedNative.address, stable].sort((a, b) => BigInt(a) < BigInt(b) ? -1 : 1);
  const pool = { currency0: currencies[0], currency1: currencies[1], fee: 3000, tickSpacing: 60 };
  const chain = createVaultChain({ chainId: 8453, finality: 'lagging', positions: [{ dex: 3, tokenId: ROOT, pool, liquidity: 10n ** 18n }] });
  const request = chain.request.bind(chain); let offered = 0;
  chain.request = async (...args) => {
    if (args[0] === 'eth_sendTransaction' && ++offered === 2) return { error: { code: -32000, message: 'Wallet connection lost after offering the transaction.' } };
    return request(...args);
  };
  const s = await openLive(chain, { hash: '/sequence/compound/base-v3-' + ROOT,
    read6: { portfolio: multichainSetupPortfolio(chain, 3, pool) }, v1: rootOnV1({ liquidity: 10n ** 18n }) });
  try {
    const { page } = s, flow = page.locator('[data-v2in-setup="live"]');
    await flow.locator('[data-v2in-consent]').check();
    const button = flow.locator('[data-sequence-action="run"]');
    await flow.locator('[data-sequence-action="run"]:not([disabled])').waitFor();
    await button.click();
    await flow.locator('[data-wallet-step="create-vault"][data-step-phase="failed"]').waitFor({ timeout: 30_000 });
    assert.equal(await flow.locator('[data-wallet-step="approve-root"]').getAttribute('data-step-phase'), 'included');
    assert.equal(await button.innerText(), 'Check transaction');
    await button.click();
    await page.waitForFunction(() => document.querySelectorAll('[data-wallet-step="approve-root"]').length === 0
      && document.querySelector('[data-wallet-step="create-vault"]')?.getAttribute('data-step-phase') === 'idle');
    assert.equal(offered, 2, 'fresh chain review never reoffers the uncertain setup');
    assert.equal(chain.sends.length, 1, 'only the confirmed approval was included');
    await button.click();
    await flow.getByText(/This step was already sent from this page/).waitFor();
    assert.equal(offered, 2, 'the unknown-hash send guard remains closed until there is real proof');
  } finally { await s.close(); }
});

test('multichain setup: changing a repeated NFT id resets consent and review; preview never switches, signs or sends', async () => {
  const holder = ACCOUNTS[0].address.toLowerCase();
  const v1 = rootOnV1({ holder, liquidity: 10n ** 18n });
  const portfolio = plainPortfolio(v1, holder, body => {
    const root = body.positions[0], current = body.chains[0];
    body.chains = body.chains.map(entry => ({ ...structuredClone(current), chainId: entry.chainId }));
    body.coverage = 'complete';
    body.positions = [4663, 8453, 42161].flatMap(chainId => [3, 4].map(dex => {
      const profile = require('../../.test-build/app/src/v2/chains.js').v2Chain(chainId);
      const currencies = [dex === 3 ? profile.wrappedNative.address : ZERO, profile.chargeCurrencies.find(token => token.decimals === 6).address].sort((a,b) => BigInt(a) < BigInt(b) ? -1 : 1);
      return { ...structuredClone(root), chainId, dex, positionManager: profile.uniswap['v' + dex].positionManager,
        state: { ...structuredClone(root.state), pool: { ...root.state.pool, dex, currency0: currencies[0], currency1: currencies[1] } },
      };
    }));
  });
  const s = await openPreview(v1, '/sequence/compound/base-v3-' + ROOT, { portfolio, expand: false });
  try {
    const flow = s.page.locator('[data-v2in-setup="preview"]');
    await flow.locator('[data-sequence-position-key="8453:3:' + ROOT + '"][aria-checked="true"]').waitFor();
    assert.equal(await flow.locator('[data-sequence-position]').count(), 6);
    await flow.locator('[data-v2in-consent]').check();
    await flow.locator('[data-sequence-action="review"]').click();
    await flow.locator('[data-v2in-review]').waitFor();
    assert.match(await flow.locator('[data-v2in-review]').innerText(), /Base/);
    await flow.locator('[data-sequence-position-key="42161:4:' + ROOT + '"]').click();
    assert.equal(await flow.locator('[data-v2in-consent]').isChecked(), false);
    assert.equal(await flow.locator('[data-v2in-review]').count(), 0);
    assert.equal(await flow.locator('[data-sequence-action="review"]').isDisabled(), true);
    await flow.locator('[data-v2in-consent]').check();
    await flow.locator('[data-sequence-action="review"]').click();
    assert.match(await flow.locator('[data-v2in-review]').innerText(), /Arbitrum One/);
    await flow.locator('[data-sequence-position-key="42161:4:' + ROOT + '"]').focus();
    await s.page.keyboard.press('ArrowLeft');
    await flow.locator('[data-sequence-position-key="42161:3:' + ROOT + '"][aria-checked="true"]').waitFor();
    await s.page.waitForFunction(() => document.activeElement?.getAttribute('data-sequence-position-key') === '42161:3:3409682');
    assert.equal(await flow.locator('[data-v2in-consent]').isChecked(), false, 'keyboard selection also clears consent while preserving focus');
    const forbidden = [...SENDS_AND_SIGNATURES, 'wallet_switchEthereumChain'];
    assert.equal(s.wallet.state.log.some(entry => forbidden.includes(entry.method)), false);
  } finally { await s.close(); }
});

test('multichain setup: a receipt-backed Base mint waits past the old retry window and requires real indexed state', async () => {
  const chain = createVaultChain({ chainId: 8453 });
  const pool = { currency0: ZERO, currency1: chain.profile.chargeCurrencies.find(token => token.decimals === 6).address, fee: 3000, tickSpacing: 60 };
  const complete = multichainSetupPortfolio(chain, 4, pool);
  const empty = structuredClone(complete); empty.body.positions = [];
  const snapshot = complete.body.positions[0].state.snapshot;
  const hint = { wallet: OWNER, chainId: 8453, dex: 4, positionManager: chain.profile.uniswap.v4.positionManager, tokenId: String(ROOT),
    hash: '0x' + '87'.repeat(32), block: snapshot.number, blockHash: snapshot.hash, fee: 3000,
    tokens: complete.body.tokens.map(({ address, symbol, decimals }) => ({ address, symbol, decimals })),
  };
  const s = await openLive(chain, { hash: '/sequence/compound/base-v4-' + ROOT, read6: { portfolio: empty }, v1: rootOnV1({ liquidity: 10n ** 18n }),
    beforeOpen: async ({ page, context }) => {
      await page.clock.install();
      await context.addInitScript(({ hint, empty, complete }) => {
        window.__dominoRefresh = true;
        sessionStorage.setItem('domino:created-positions:v1:' + hint.wallet, JSON.stringify([{ ...hint, observedAt: Date.now() }]));
        window.__setupPortfolioReads = 0;
        window.__setupIndexed = false;
        window.__dominoV2Test.read6.portfolio = () => { window.__setupPortfolioReads++; return window.__setupIndexed ? complete : empty; };
      }, { hint, empty, complete });
    },
  });
  try {
    const { page } = s;
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): the loading rows and a hidden marker; it said 'Updating your position…'.
    await page.locator('[data-v2in-setup-updating]').waitFor({ state: 'attached' });
    assert.equal(await page.getByText('Updating your position…', { exact: true }).count(), 0);
    for (let turn = 0; turn < 3; turn++) {
      const before = await page.evaluate(() => window.__setupPortfolioReads);
      await page.clock.fastForward(5_100);
      await page.waitForFunction(previous => window.__setupPortfolioReads > previous, before);
    }
    assert.equal(await page.locator('[data-sequence-positions="empty"]').count(), 0, 'a delayed index does not become no eligible position after 10.5 seconds');
    assert.equal(await page.locator('[data-v2in-consent]').count(), 0, 'receipt identity alone never makes the position eligible');
    assert.deepEqual(chain.sends, []);
    await page.evaluate(() => { window.__setupIndexed = true; });
    await page.clock.fastForward(5_100);
    await page.locator('[data-sequence-position-key="8453:4:' + ROOT + '"][aria-checked="true"]').waitFor();
    assert.equal(await page.locator('[data-v2in-consent]').isChecked(), false, 'the real portfolio opens setup without implied consent');
    assert.equal(await page.locator('[data-sequence-action="run"]').isDisabled(), true);
    assert.deepEqual(chain.sends, []);
  } finally { await s.close(); }
});

for (const stopped of ['halted', 'no-operators']) test('multichain setup: explicit ' + stopped + ' blocks new approvals without claiming a running daemon', async () => {
  const chain = createVaultChain({ chainId: 8453 });
  const pool = { currency0: ZERO, currency1: chain.profile.chargeCurrencies.find(token => token.decimals === 6).address, fee: 3000, tickSpacing: 60 };
  const read = multichainSetupPortfolio(chain, 4, pool);
  const status = read.body.chains.find(entry => entry.chainId === 8453);
  if (stopped === 'halted') status.automationHalted = true; else status.operatorsAdmitted = 0;
  const s = await openLive(chain, { hash: '/sequence/compound/base-v4-' + ROOT, read6: { portfolio: read }, v1: rootOnV1({ liquidity: 10n ** 18n }) });
  try {
    const flow = s.page.locator('[data-v2in-setup="live"]');
    await flow.locator('[data-v2in-consent]').check();
    assert.equal(await flow.locator('[data-sequence-action="run"]').isDisabled(), true);
    assert.match(await flow.locator('#v2in-setup-reason').innerText(), stopped === 'halted' ? /temporarily paused/ : /not available/);
    assert.deepEqual(chain.sends, []);
    assert.equal(chain.calls.some(call => call.calls.some(name => name.endsWith('.predictVault'))), false);
  } finally { await s.close(); }
});
