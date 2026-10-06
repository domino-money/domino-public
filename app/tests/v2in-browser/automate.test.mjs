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
const { ABI, OTHER, OWNER, ZERO, createVaultChain, mandateHash } = await import('../support/v2-vault-chain.mjs');
const { READ6, read6Answer, walletFor } = await import('../support/v2-auto-page.mjs');
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
    await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
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
async function serve({ v1, hooks, wallet, routes = [] }) {
  const fake = createFakeSession();
  const server = createWalletServer({ fake, dist: WALLET_V2_DIST, routes });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fake.origin = origin;
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
  await context.route(FONTS, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  const rpc = await routeChain(context, v1);
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

/** Preview: Test Wallet A (tests/support/mock-wallet.mjs), V2's gate open on the test origin, nothing live. */
async function openPreview(v1, hash) {
  const s = await serve({ v1, hooks: { originOpen: true }, wallet: (context) => installWallets(context) });
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
    return { ...s, close };
  } catch (error) {
    // What the page said is kept with the failure (an assertion of close() would otherwise hide it).
    await close().catch((closing) => { error.message += `
(on close: ${closing.message})`; });
    throw error;
  }
}

const WALLET_NAME = 'V2 Test Wallet';

/**
 * Live on the fake V2 vault chain: the chain announced as a browser wallet of its own through EIP-6963 (as
 * tests/support/v2-auto-page.mjs does), its contracts set and the backend's word in the test hooks (src/v2/gate.ts:
 * `live`), read-v6's answers scripted (`read6`, src/v2in/automate/read6.tsx), V1's own reads answered from `v1`.
 */
async function openLive(chain, { hash, read6, v1, routes = [] }) {
  const methods = walletFor(chain);
  const csp = [];
  const s = await serve({
    v1,
    routes,
    hooks: { originOpen: true, contracts: { [chain.chainId]: chain.contracts }, backendOn: true, read6 },
    wallet: async (context) => {
      await context.exposeFunction('__dominoV2inWallet', (method, params) => methods.request(method, params));
      await context.exposeFunction('__dominoV2inCsp', (text) => csp.push(text));
      await context.addInitScript((name) => {
        document.addEventListener('securitypolicyviolation', (event) => window.__dominoV2inCsp(`${event.violatedDirective} ${event.blockedURI}`));
        const provider = {
          async request({ method, params }) {
            const reply = await window.__dominoV2inWallet(method, params ?? []);
            if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code, data: reply.error.data });
            return reply.result;
          },
          on() { return provider; },
          removeListener() { return provider; },
        };
        const detail = Object.freeze({ info: Object.freeze({ uuid: '8f2a7d1c-0000-4000-8000-0000000002f7', name, icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E', rdns: 'test.wallet.v2in' }), provider });
        const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
        window.addEventListener('eip6963:requestProvider', announce);
        announce();
      }, WALLET_NAME);
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
    await s.page.goto(`${s.origin}/#${hash}`);
    await connect(s.page, WALLET_NAME);
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
 * null for a burned NFT, which read-v6 no longer lists). The stateNonce is the chain's now.
 */
function listing(chain, vault, { armed, reason = null, paused = false, pausedBy = null, reserves, root, waiting = null, orders = null, autoExit = false }) {
  const swaps = [[READ6.wallet, OWNER], [READ6.vault, vault], [READ6.module, AUTO_EXIT], [READ6.usdg, ZERO], [READ6.many, USDG]];
  return read6Answer('portfolio', 'portfolio-custody-lost', swaps, (body) => {
    // `orders` (added 2026-10-04): the fixture's own active order, adapted, in place of none.
    body.mandates = orders ? orders(body.mandates) : [];
    body.tokens = [
      { address: ZERO, chainId: 4663, decimals: 18, price: null, priceReason: 'no_qualified_price_source', status: 'available', symbol: 'ETH' },
      { address: USDG, chainId: 4663, decimals: 6, price: null, priceReason: 'no_qualified_price_source', status: 'available', symbol: 'USDG' },
    ];
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
      members: [{ active: true, lots: [{ charged: '0', token: ZERO, uncharged: '0' }, { charged: '0', token: USDG, uncharged: '0' }], parentTokenId: null, successorTokenId: null, tickLower: -600, tickUpper: 600, tokenId: String(ROOT) }],
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
 * Set up automation's page opens once Domino V1's sequence release is published (screens/Sequence.tsx), and only then
 * mounts the vault's own flow (src/v2in/automate/SetupEntry.tsx): the release Worker's answer, as the pinned V1 record
 * (src/finance/pin.ts) with its expiry ahead. Added 2026-10-06 (the owner's point 5) for Set up automation's Auto-exit guard.
 */
const { SEQUENCE_RECOVERY_RECORD } = require('../../.test-build/app/src/finance/pin.js');
const v1SequenceRelease = () => async (request, url) => {
  if (url.pathname !== '/api/setup/v1/sequence-release') return undefined;
  const body = { ...SEQUENCE_RECOVERY_RECORD, deployment: { ...SEQUENCE_RECOVERY_RECORD.deployment, expiresAt: Math.floor(Date.now() / 1000) + 30 * 86_400 } };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Domino-Setup-Contract': '1.0.0-rc.1' } });
};

/** V1's own chain read of ROOT (tests/support/browser-chain.mjs): its holder, liquidity, burned or not. */
const rootOnV1 = ({ holder = OWNER, liquidity = 0n, burned = false } = {}) => browserChain({
  positions: [{ tokenId: String(ROOT), holder, key: KEY, tickLower: -600, tickUpper: 600, liquidity, unclaimed: [0n, 0n], burned }],
  tokens: TOKENS,
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

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

    await page.locator('[data-position-actions] [data-position-v2-action="protect"]').click();
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
    assert.equal(await dialog.locator('[data-mandate-now]').innerText(), 'Now 2,500');
    assert.equal(await dialog.locator('[data-mandate-near]').count(), 0, 'both ends far from the price: no warning');
    assert.match(await dialog.locator('[data-mandate-fee]').innerText(), /^Fee\s+0\.2% of the position's value, only if it closes$/);
    // Under the gate's preview: the gate's sentence where the button would be, never a button.
    assert.equal(await dialog.locator('[data-v2-locked]').innerText(), LOCKED);
    assert.equal(await dialog.locator('[data-mandate-send]').count(), 0);
    // Details: closed; the warnings, the fixed terms, the wallet's integers and the steps (a signature, then one batch).
    const details = dialog.locator('[data-mandate-details]');
    assert.equal(await details.evaluate((node) => node.open), false, 'closed until opened');
    await details.locator('summary').click();
    assert.deepEqual(await details.locator('[data-mandate-warnings] li').evaluateAll((items) => items.map((li) => li.getAttribute('data-warning'))), ['autoexit_warning_not_guaranteed', 'autoexit_warning_reference_price', 'autoexit_warning_turn_off_pauses', 'autoexit_warning_halt', 'changes-pause']);
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

    // Managed positions: real data only (the owner, 2026-10-02). read-v6's route is not deployed on this origin, so nothing
    // of V2 is drawn, and Positions' layout is V1's: connected and signed out, V1's one calm line stands for both cards.
    await page.evaluate(() => { location.hash = '#/positions'; });
    await page.locator('[data-automation-cards="merged"] [data-automation-empty]').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-v2in-vaults], [data-vault-card], [data-read6-failed]').count(), 0, 'no example rows, no note of a route that is simply not on yet');
    // Added 2026-10-06 (the integration review, ux #9): Automate's Auto-exit sends the person here: Auto-exit is named.
    const automation = page.locator('section[aria-labelledby="automation-title"]');
    assert.deepEqual(await automation.locator('.dm-acct-auto-name').allInnerTexts(), ['Auto-compound', 'Domino-compound', 'Auto-exit']);
    assert.equal(await automation.locator('[data-automation-feature="auto-exit"] .dm-acct-auto-text').innerText(), 'Closes it at the end of its range and sends the tokens to your wallet.');
    await automation.screenshot({ path: join(shots(), 'v2in-positions-automation-card.png'), animations: 'disabled' });
    // …and Automate itself is about more than fees now.
    await page.evaluate(() => { location.hash = '#/automate'; });
    await page.locator('main [data-feature="protection"]').waitFor({ timeout: 30_000 });
    assert.match(await page.locator('main').innerText(), /Choose what Domino does for your position\./);
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
    assert.deepEqual(entries.map(([key]) => key), ['increase', 'changeRange', 'exit', 'protect']);
    assert.deepEqual(entries.at(-1), ['protect', 'Auto-exit']);
    await more.locator('[data-position-v2-action="protect"]').click();
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
    const card = page.locator(`[data-v2in-position="${ROOT}"][data-v2in-mode="live"] section[data-vault-card="${vault}"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await card.getAttribute('data-vault-armed'), 'no');
    assert.equal(await card.getAttribute('data-vault-reserves'), 'held');
    assert.equal(await card.locator('[data-vault-pill]').innerText(), 'Automation off');
    assert.equal(await card.locator('[data-vault-held] [data-reserves="held"]').innerText(), '0.002 ETH + 5 USDG');
    // rev4: the closed root's reserves reason is THE sentence (said first); §5.4's words moved under Details.
    assert.match(await card.locator('[data-vault-state][data-vault-waiting="reserves_returnable"]').innerText(), /^Your position is closed\. Its waiting fees are being returned to your wallet · since /);
    assert.match(await card.locator('[data-vault-details] [data-disarm-reason="3"]').textContent(), /^This position was closed\. Its automation has ended\./);
    // The condensed card (#8): the primary way out for a closed root, and Leave automation; the withdrawal and the hints under Details.
    assert.deepEqual(await card.locator('[data-vault-open]').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-vault-open'))), ['return', 'leave']);
    assert.deepEqual(await card.locator('[data-vault-more]').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-vault-more'))), ['withdraw']);
    assert.ok(await card.locator('[data-vault-details] [data-return-hint]').count());
    assert.equal(await card.locator('details[data-vault-details]').evaluate((details) => details.open), false, 'closed until opened');
    await page.locator(`[data-v2in-position="${ROOT}"]`).screenshot({ path: join(shots(), 'v2in-reserves-burned-root.png'), animations: 'disabled' });

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
    const after = page.locator(`[data-v2in-position="${ROOT}"] section[data-vault-card="${vault}"][data-vault-source="chain"]`);
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
    const card = page.locator(`[data-v2in-position="${ROOT}"][data-v2in-mode="live"] section[data-vault-card="${vault}"]`);
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
    const vaults = page.locator('[data-v2in-vaults]');
    await vaults.waitFor({ timeout: 30_000 });
    assert.equal(await vaults.locator('> .dm-acct-note').first().innerText(), 'Fees waiting to be reinvested, and your ways out.');
    // The row (#8): the name, its chain (§8.2), the pill, the figure line and the one primary button; its page has the rest.
    const row = vaults.locator(`li[data-vault-card="${vault}"]`);
    assert.equal(await row.locator('.dm-acct-status').innerText(), 'Automation off');
    assert.equal(await row.locator('[data-vault-held]').innerText(), 'Fees collected, not yet reinvested: 0.002 ETH + 5 USDG');
    assert.equal(await row.locator('[data-v2-chain-badge="4663"]').count(), 1);
    assert.deepEqual(await row.locator('button').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-vault-open'))), ['return']);
    assert.equal(await row.locator('[data-vault-idle], [data-return-hint], [data-vault-details]').count(), 0, 'the row carries no detail');
    const link = row.locator('a.dm-mp-name');
    assert.equal(await link.getAttribute('href'), `#/positions/${ROOT}`);
    await page.locator('.dm-auto-frame', { has: vaults }).screenshot({ path: join(shots(), 'v2in-managed-closed-root.png'), animations: 'disabled' });

    await link.click();
    const card = page.locator(`[data-v2in-position="${ROOT}"] section[data-vault-card="${vault}"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await card.locator('[data-vault-held] [data-reserves="held"]').innerText(), '0.002 ETH + 5 USDG');
    // Nothing waits: §5.4's sentence is THE sentence, with its reason.
    assert.equal(await card.locator('[data-vault-state]').getAttribute('data-disarm-reason'), '2');
    assert.match(await card.locator('[data-vault-state]').innerText(), /^This position was changed outside Domino\. Automation stopped for it\. · since /);
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
    await page.locator(`[data-v2in-position="${ROOT}"] section[data-vault-card="${vault}"][data-vault-source="chain"][data-vault-reserves="none"]`).waitFor({ timeout: 30_000 });
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
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ liquidity }) });
  const { page } = s;
  try {
    const card = page.locator(`[data-v2in-position="${ROOT}"] section[data-vault-card="${vault}"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await card.getAttribute('data-vault-status'), 'on');
    assert.equal(await card.getAttribute('data-vault-armed'), 'yes');
    assert.equal(await card.locator('[data-vault-pill]').innerText(), 'Automation on');
    // A running vault: the spec's own sentence (§2.13), the fees waiting, Withdraw to wallet and Leave automation; Pause under Details.
    // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
    assert.match(await card.locator('[data-vault-state]').innerText(), /^Your automation reinvests this position's fees\. If you change it, move it or approve another app, it stops for this position until you turn it back on\.$/);
    assert.doesNotMatch(await card.innerText(), /vault/i);
    assert.deepEqual(await card.locator('[data-vault-open]').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-vault-open'))), ['withdraw', 'leave']);
    assert.deepEqual(await card.locator('[data-vault-more]').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-vault-more'))), ['pause']);
    assert.match(await card.locator('[data-vault-details]').textContent(), /Auto-compound: 2% of reinvested fees/);
    // Auto-exit is separate from compounding (rugged97, 2026-10-06): a running Auto-compound is never offered it.
    await page.locator('[data-position-actions] [data-position-v2-more]').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-position-v2-action="protect"]').count(), 0, 'no Auto-exit on a running Auto-compound');
    assert.equal(await page.locator(`[data-v2in-position="${ROOT}"] [data-v2in-exit]:not([hidden])`).count(), 0, 'and no Auto-exit card');
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
    await dialog.locator('[data-v2in-send="leave"]').click();
    await dialog.locator('[data-v2in-close]').waitFor({ timeout: 30_000 });
    const sent = chain.sends.at(-1);
    assert.deepEqual([sent.to.toLowerCase(), selectorOf(sent.data)], [chain.positionManager[4].toLowerCase(), SELECTOR.unsubscribe]);
    assert.equal(chain.nft(4, ROOT).subscriber, ZERO, 'Domino no longer notified');
    // The other follow-up stays offered until done.
    assert.deepEqual(await dialog.locator('[data-v2in-follow]').evaluateAll((buttons) => buttons.map((b) => b.getAttribute('data-v2in-follow'))), ['revoke-approval']);
    await dialog.screenshot({ path: join(shots(), 'v2in-leave-automation.png'), animations: 'disabled' });
  } finally {
    await s.close();
  }
});

// Added 2026-10-04 (rugged97's delta of 4 Oct §2 item 3, #319): Leave automation turns auto-exit off; its orders pause.
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
    const card = page.locator(`[data-v2in-position="${ROOT}"] [data-v2in-exit][data-exit-state="paused"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await card.locator('[data-exit-pill]').innerText(), 'Paused');
    assert.equal(await card.locator('[data-v2in-exit-line="paused"]').innerText(), 'Paused: Auto-exit is turned off for this position.');
    // Changed on purpose 2026-10-06 (the integration review, rugged-literal #2): Leave automation's pause (the module off)
    // keeps the automation Auto-exit's: this one card, never a second "Automation" card in compounding's words.
    assert.equal(await page.locator(`[data-v2in-position="${ROOT}"] [data-vault-card]`).count(), 0, 'one card for one product');
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
    const card = page.locator(`[data-v2in-position="${ROOT}"] [data-v2in-exit][data-exit-state="paused"]`);
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
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ liquidity }), routes: [v1SequenceRelease()] });
  const { page } = s;
  try {
    const mount = page.locator(`[data-v2in-position="${ROOT}"][data-v2in-mode="live"]`);
    const card = mount.locator('[data-v2in-exit][data-exit-state="on"]');
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await card.locator('h2').innerText(), 'Auto-exit');
    assert.equal(await card.locator('[data-exit-pill]').innerText(), 'On');
    // Changed on purpose 2026-10-06 (the review of point 5): the title and the pill say "Auto-exit" and "On"; the line where.
    assert.match(await card.locator('[data-v2in-exit-line="on"]').innerText(), /^Closes at 1,855\.72 – 2,504\.92 USDG per ETH$/);
    assert.equal(await card.locator('[data-exit-off]').innerText(), 'Turn off');
    assert.equal(await card.locator('[data-order-waiting]').count(), 0, 'waiting for an edge is what it does: its line says where it closes');
    assert.equal(await mount.locator(`[data-vault-card="${vault}"]`).count(), 0, 'its automation is this card, not a second one');
    await page.locator('[data-position-actions] [data-position-v2-more]').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-position-v2-action="protect"]').count(), 0, 'one Auto-exit per position: no second one offered');
    assert.doesNotMatch(await card.innerText(), /vault|stop-loss|take-profit|order/i);
    await card.screenshot({ path: join(shots(), 'v2in-autoexit-card-on.png'), animations: 'disabled' });
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
    const setup = page.locator('[data-v2in-setup="live"]');
    await setup.waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => document.querySelector('#v2in-setup-reason')?.textContent === 'Auto-exit is already on for this position.', null, { timeout: 30_000 });
    assert.equal(await setup.locator('[data-sequence-action="protection"]').isDisabled(), true, 'no second Auto-exit');
    await setup.locator('[data-sequence-mode="compound"]').click();
    assert.equal(await setup.locator('#v2in-setup-reason').innerText(), 'This position is set up for Auto-exit, which never reinvests its fees. Choose another position.');
    assert.equal(await setup.locator('[data-sequence-action="run"]').isDisabled(), true, 'no compounding on an Auto-exit position');
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
    await page.locator('[data-position-v2-action="protect"]').click();
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


// Added 2026-10-06 (the owner's point 5; rugged97: "it must be automatic"): one signature, then ONE confirmation.
test('live: Auto-exit on a plain position is ONE signature and ONE wallet_sendCalls (approve, createVault, setExitModule, registerMandate); its card then says where it closes, and "Turn off" revokes it', async () => {
  const liquidity = 10n ** 18n;
  const chain = createVaultChain({ chainId: 4663, atomic: 'ready', simulateV1: true, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -201060, tickUpper: -198060, liquidity }] });
  // Changed on purpose 2026-10-06 (the review of point 5): the pool's own price, read through the wallet, chooses the edges.
  chain.setPrice(4, KEY, (2n ** 96n) / 20000n);
  const portfolio = read6Answer('portfolio', 'portfolio-empty', [[READ6.wallet, OWNER]]);
  const v1 = browserChain({ positions: [{ tokenId: String(ROOT), holder: OWNER, key: KEY, tickLower: -201060, tickUpper: -198060, liquidity, unclaimed: [0n, 0n] }], pools: { [poolIdOf(KEY)]: { sqrtPriceX96: (2n ** 96n) / 20000n, tick: -198080 } }, tokens: TOKENS });
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1 });
  try {
    const { page } = s;
    await page.locator('[data-position-v2-action="protect"]').click();
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
    assert.equal(await dialog.locator('[data-mandate-now]').innerText(), 'Now 2,500');
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
    const card = page.locator(`[data-v2in-position="${ROOT}"] [data-v2in-exit][data-exit-state="on"]`);
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
    await page.locator(`[data-v2in-position="${ROOT}"] [data-v2in-exit][data-exit-state="off"]`).waitFor({ state: 'attached', timeout: 30_000 });
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
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ liquidity }) });
  return { chain, vault, s };
}

test('live: Auto-exit paused because its position lost the approval: "Approve again" beside its line, in Auto-exit\'s words, the price read first; the vault still paused after', async () => {
  // The pool at about 2,500 USDG per ETH, inside the range: no end passed.
  const { chain, vault, s } = await approvalLost({ price: (2n ** 96n) / 20000n });
  const { page } = s;
  try {
    const card = page.locator(`[data-v2in-position="${ROOT}"] [data-v2in-exit][data-exit-state="paused"]`);
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
    assert.ok(chain.callsSince(0).some((c) => c.calls.includes('stateView.getSlot0')), 'the pool\'s price, read before the approval goes back');
    assert.equal(await dialog.locator('[data-exit-past]').count(), 0, 'inside the range: nothing to warn of');
    assert.deepEqual(chain.sends, [], 'for the person to confirm');
    await dialog.screenshot({ path: join(shots(), 'v2in-autoexit-rearm.png'), animations: 'disabled' });
    await dialog.locator('[data-v2in-send="rearm"]').click();
    await dialog.locator('[data-v2in-close]').waitFor({ timeout: 60_000 });
    // On v4 a moved approval never disarmed the root (the position manager tells no one): once it is back, the rearm has
    // nothing left to do, and the action is complete.
    assert.deepEqual(chain.sends.map((tx) => [tx.to.toLowerCase(), selectorOf(tx.data)]), [[chain.positionManager[4].toLowerCase(), SELECTOR.approve]], 'the approval back to its automation');
    assert.equal(chain.nft(4, ROOT).approved, vault);
    assert.deepEqual(await dialog.locator('[data-error-code], .dm-error').allInnerTexts(), [], 'never "This step is already done." with no way on');
    assert.equal(chain.vault(vault).paused, true, 'still paused: Auto-exit only, nothing reinvested');
    assert.equal(chain.vault(vault).exitModule, AUTO_EXIT);
  } finally {
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
    const card = page.locator(`[data-v2in-position="${ROOT}"] [data-v2in-exit][data-exit-state="paused"]`);
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
    // Managed positions: "Auto-exit", and no button that would cut the position from it.
    const row = page.locator(`[data-v2in-vaults] li[data-vault-card="${vault}"]`);
    await row.waitFor({ timeout: 30_000 });
    assert.equal(await row.getAttribute('data-vault-exit'), 'on');
    assert.equal(await row.locator('.dm-acct-status').innerText(), 'Auto-exit');
    assert.equal(await row.locator('button').count(), 0, 'never Revoke approval or Remove Domino on an Auto-exit that is on');
    await row.locator('a.dm-mp-name').click();
    const card = page.locator(`[data-v2in-position="${ROOT}"] [data-v2in-exit][data-exit-state="on"]`);
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
    const card = page.locator(`[data-v2in-position="${ROOT}"] [data-v2in-exit][data-exit-state="off"]`);
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
    // Reconnected: Auto-exit's own dialog follows by itself, its one button for the person to press.
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
    const card = page.locator(`[data-v2in-position="${ROOT}"] [data-v2in-exit][data-exit-state="on"]`);
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
    const card = page.locator(`[data-v2in-position="${ROOT}"] [data-v2in-exit][data-exit-state="off"]`);
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
    const card = page.locator(`[data-v2in-position="${ROOT}"][data-v2in-mode="live"] section[data-vault-card="${vault}"]`);
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await page.locator(`[data-v2in-position="${ROOT}"] [data-v2in-exit]`).count(), 0, 'no Auto-exit card here');
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
