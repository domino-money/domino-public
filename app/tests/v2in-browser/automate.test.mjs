/**
 * The integrated automation screens in a browser (Domino V2 integration, 2026-10-02, the AUTOMATION agent), on the
 * wallet-test-v2 build (V1's screens with V2 compiled in) served as the wallet suites serve it:
 *
 *   - preview (`window.__dominoV2Test.originOpen` alone, as on the preview alias before the deploy): on a plain position
 *     the connected wallet holds, the position page's "Stop-loss / take-profit" runs the order form, in the look of the
 *     page's action dialogs, to its review (each trigger in words and as the wallet will show it, the §4.7 warnings, the
 *     Protection-only consent) and stops at the gate's locked sentence; nothing reaches the wallet. Managed positions
 *     shows nothing of Domino V2 while read-v6 has nothing to say about this wallet (real data only, no example rows).
 *   - live on the fake V2 vault chain (its contracts set and the backend's word through the test hooks; read-v6
 *     scripted as its route will answer: the package's own fixtures, adapted to the chain and held to the package's
 *     validator): a root closed by the S1 exit (burned) and one closed directly on Uniswap keep their vault's fees in
 *     view, on the position's page and in Managed positions, listed by owner (never from the NFT), with "Withdraw to
 *     wallet" (one EIP-5792 batch when the wallet batches) and "Return my reserves" (returnReserves(), rev4); "Leave
 *     automation" sends exitAll(), then offers v4's follow-ups. The card is the condensed one of the review of
 *     2026-10-03 (#8): a pill, one sentence, one figure, at most two buttons; the rest under its Details.
 * Every page: no page error, no CSP violation, every wallet method answered, nothing outside the page's origin.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
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
const { ABI, OTHER, OWNER, ZERO, createVaultChain } = await import('../support/v2-vault-chain.mjs');
const { READ6, read6Answer, walletFor } = await import('../support/v2-auto-page.mjs');
const { FAKE } = await import('../v2/support/plans.mjs');

const LAUNCHES = process.env.DOMINO_BROWSER_PATH ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }] : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}];
const FONTS = /^https:\/\/fonts\.(googleapis|gstatic)\.com\//;
const ARTWORK = /^https:\/\/(api|cdn)\.dexscreener\.com\//;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const AUTO_EXIT = FAKE.autoExit.toLowerCase();
const ZAP = '0x00000000000000000000000000000000000a9900';
const LOCKED = "This opens as soon as Domino's service is live on Robinhood Chain.";
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
async function serve({ v1, hooks, wallet }) {
  const fake = createFakeSession();
  const server = createWalletServer({ fake, dist: WALLET_V2_DIST });
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
async function openLive(chain, { hash, read6, v1 }) {
  const methods = walletFor(chain);
  const csp = [];
  const s = await serve({
    v1,
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
function listing(chain, vault, { armed, reason = null, paused = false, pausedBy = null, reserves, root, waiting = null, orders = null }) {
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
    Object.assign(v, { pausedBy, autoExitEnabled: false, waiting });
    Object.assign(v.state, {
      exitModule: null,
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

/** V1's own chain read of ROOT (tests/support/browser-chain.mjs): its holder, liquidity, burned or not. */
const rootOnV1 = ({ holder = OWNER, liquidity = 0n, burned = false } = {}) => browserChain({
  positions: [{ tokenId: String(ROOT), holder, key: KEY, tickLower: -600, tickUpper: 600, liquidity, unclaimed: [0n, 0n], burned }],
  tokens: TOKENS,
});

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

test('preview: Stop-loss / take-profit on a plain position the wallet holds runs to its review and stops at the locked sentence; Managed positions shows nothing of V2 for a wallet read-v6 knows nothing about; nothing reaches the wallet', async () => {
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
    // A plain position: the protection-only path (decisions #18, #25); no vault card (nothing read-v6 says about this wallet).
    const exit = mount.locator('[data-v2in-exit="plain"]');
    await exit.waitFor({ state: 'attached', timeout: 30_000 });
    assert.equal(await exit.locator('h2').innerText(), 'Stop-loss / take-profit');
    // One title, one line, one button (the owner: few words; the detail is in the dialog).
    assert.match(await exit.locator('[data-v2in-exit-line="open"]').innerText(), /^Withdraw this position by itself when the price falls or rises to a level you set\. Cancel at any time\.$/);
    assert.equal(await exit.locator('[data-v2in-open="mandate"]').innerText(), 'Set up');
    assert.equal(await mount.locator('[data-vault-card]').count(), 0, 'no vault of this wallet: no card');
    assert.equal(await exit.isVisible(), false, 'the empty setup card no longer duplicates the position action');

    await page.locator('[data-position-actions] [data-position-v2-action="protect"]').click();
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="mandate"]');
    await dialog.waitFor();
    assert.equal(await dialog.locator('h2').innerText(), 'Stop-loss / take-profit');
    // The price in the chain's stable, as the app's other screens write prices (spec §4.3).
    assert.match(await dialog.locator('[data-mandate-input="falls"]').getAttribute('aria-label'), /^Exit if the price falls to \(USDG per ETH\)/);
    assert.equal(await dialog.locator('[data-mandate-review]').isDisabled(), true, 'nothing typed: no review');
    await dialog.locator('[data-mandate-reference="current"]').waitFor();
    assert.equal(await dialog.locator('[data-mandate-current-price]').innerText(), '2,500', 'the chain pool integer with actual ETH/USDG decimals');
    const falls = dialog.locator('[data-mandate-input="falls"]');
    const rises = dialog.locator('[data-mandate-input="rises"]');
    assert.equal(await falls.inputValue(), '', 'no default signed trigger');
    await dialog.locator('[data-mandate-shortcut="falls-10"]').click();
    assert.equal(await falls.inputValue(), '2250');
    assert.match(await dialog.locator('[data-mandate-distance="falls"]').innerText(), /−10%/);
    await dialog.locator('[data-mandate-shortcut="rises-20"]').click();
    assert.equal(await rises.inputValue(), '3000');
    await dialog.screenshot({ path: join(shots(), 'v2in-mandate-selected-local-fixture.png'), animations: 'disabled' });
    await dialog.locator('[data-mandate-switch]').click();
    assert.equal(await dialog.locator('[data-mandate-current-price]').innerText(), '0.0004');
    assert.ok(Number(await falls.inputValue()) < 0.0004 && Number(await rises.inputValue()) > 0.0004, 'switching quote reverses directions and keeps the selected thresholds');
    await dialog.locator('[data-mandate-switch]').click();
    assert.ok(Math.abs(Number(await falls.inputValue()) / 2250 - 1) < 1e-12);
    assert.ok(Math.abs(Number(await rises.inputValue()) / 3000 - 1) < 1e-12);
    await dialog.getByRole('button', { name: 'Clear lower exit' }).click();
    await dialog.getByRole('button', { name: 'Clear upper exit' }).click();
    assert.equal(await dialog.locator('[data-mandate-review]').isDisabled(), true);
    const contained = async (label) => {
      const sizes = await dialog.evaluate((node) => [node, node.querySelector('.dm-flow-dialog-body')].map((el) => [el.clientWidth, el.scrollWidth]));
      for (const [client, scroll] of sizes) assert.ok(scroll <= client + 1, `${label}: no horizontal scrolling (${scroll} in ${client})`);
    };
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await contained(`form at ${width}`);
      await dialog.screenshot({ path: join(shots(), `v2in-mandate-form-${width}-local-fixture.png`), animations: 'disabled' });
    }
    const settings = dialog.locator('.dm-exit-settings');
    assert.equal(await settings.getAttribute('open'), null, 'extra settings start folded, with current values in their summary');
    await settings.locator('summary').click();
    await settings.getByRole('radio', { name: 'Other', exact: true }).click();
    const slippage = dialog.locator('[data-mandate-input="slippage"]');
    await slippage.fill('6');
    assert.equal(await slippage.getAttribute('aria-invalid'), 'true');
    await settings.locator('summary').click();
    assert.equal(await slippage.evaluate((input) => input === document.activeElement), true, 'invalid settings stay open and their input receives focus');
    await contained('invalid settings at 320');
    await slippage.fill('1');
    assert.equal(await slippage.isVisible(), true, 'correcting a field does not close the settings around it');
    const validity = dialog.locator('[data-mandate-input="validity"]');
    await validity.fill('0');
    assert.equal(await validity.getAttribute('aria-invalid'), 'true');
    await validity.fill('30');
    await settings.locator('summary').click();
    assert.equal(await settings.getAttribute('open'), null);
    await dialog.locator('[data-mandate-input="falls"]').fill('2000');
    await dialog.locator('[data-mandate-review]').click();
    await dialog.locator('h2', { hasText: 'Review your exit order' }).waitFor();

    // The review: every term in words, each trigger with the integer the wallet will show (decision #20).
    const terms = dialog.locator('[data-mandate-terms]');
    assert.match(await terms.locator('[data-mandate-trigger="below"]').innerText(), /Exit if the price falls to (?:2,000|1,999\.\d+) USDG per ETH/);
    await terms.locator('[data-mandate-trigger="below"] summary').click();
    assert.match(await terms.locator('[data-wallet-shows="below"]').innerText(), /^Your wallet will show this as \d{20,}$/);
    await contained('expanded wallet value at 320');
    await terms.locator('[data-mandate-trigger="below"] summary').click();
    assert.match(await terms.locator('[data-mandate-trigger="above"]').innerText(), /Off$/);
    assert.equal(await terms.locator('[data-wallet-shows="above"]').count(), 0, 'a trigger that is off has no integer');
    // The owner and the vault are technical detail (#9): under Details, not in the terms.
    // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation"): the Details name it Automation.
    assert.doesNotMatch(await terms.innerText(), /Owner|Automation|[Vv]ault/);
    assert.match(await dialog.locator('[data-mandate-details]').textContent(), /Automation:\s*New, only protects this position/);
    assert.doesNotMatch(await dialog.innerText(), /vault/i);
    assert.match(await terms.locator('[data-mandate-receive]').innerText(), /Receive both tokens/);
    assert.ok(await dialog.locator('[data-mandate-warnings] li').count() >= 3, 'the mandatory warnings');
    // The protection sentence once, on the form (#10): the review does not say it again.
    assert.equal(await dialog.locator('[data-protection-only]').count(), 0);
    const send = dialog.locator('[data-mandate-send]');
    assert.equal(await send.innerText(), 'Confirm in wallet');
    assert.equal(await send.isDisabled(), true);
    assert.deepEqual(await dialog.locator('[data-wallet-steps="mandate-preview"] li').evaluateAll((items) => items.map((li) => li.getAttribute('data-wallet-step'))), ['create-batch', 'sign-mandate', 'register-batch']);
    await dialog.locator('[data-mandate-ack]').check();
    await dialog.locator('[data-protection-consent]').check();
    // Where the wallet would be asked: the gate's sentence, and the button stays locked.
    assert.equal(await dialog.locator('[data-v2-locked]').innerText(), LOCKED);
    assert.equal(await send.isDisabled(), true, 'locked in preview');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await dialog.locator('.dm-flow-dialog-body').evaluate((body) => { body.scrollTop = 0; });
      await contained(`review at ${width}`);
      await dialog.screenshot({ path: join(shots(), `v2in-mandate-review-${width}-local-fixture.png`), animations: 'disabled' });
    }
    await dialog.locator('.dm-flow-dialog-body').evaluate((body) => { body.scrollTop = body.scrollHeight; });
    await dialog.screenshot({ path: join(shots(), 'v2in-mandate-review-preview.png'), animations: 'disabled' });
    await dialog.getByRole('button', { name: 'Close' }).click();
    await dialog.waitFor({ state: 'detached' });

    // Managed positions: real data only (the owner, 2026-10-02). read-v6's route is not deployed on this origin, so nothing
    // of V2 is drawn, and Positions' layout is V1's: connected and signed out, V1's one calm line stands for both cards.
    await page.evaluate(() => { location.hash = '#/positions'; });
    await page.locator('[data-automation-cards="merged"] [data-automation-empty]').waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-v2in-vaults], [data-vault-card], [data-read6-failed]').count(), 0, 'no example rows, no note of a route that is simply not on yet');

    const asked = s.wallet.state.log.map((entry) => entry.method);
    for (const method of SENDS_AND_SIGNATURES) assert.ok(!asked.includes(method), `${method} is never asked in preview`);
  } finally {
    await s.close();
  }
});

// The same guarded protection entry is now a visible action, without an extra menu or an empty setup card.
test('preview: a position page offers Stop-loss / take-profit beside its other actions, and opens the same order dialog', async () => {
  const ID = '3135288';
  const holder = ACCOUNTS[0].address.toLowerCase();
  const v1 = browserChain({ positions: [{ tokenId: ID, holder, key: KEY, tickLower: -60, tickUpper: 60, liquidity: 2n ** 100n, unclaimed: [633825300114n, 0n] }], tokens: TOKENS });
  const s = await openPreview(v1, `/positions/${ID}`);
  const { page } = s;
  try {
    const detail = page.locator(`[data-position-detail][data-position-id="${ID}"]`);
    await detail.waitFor({ timeout: 30_000 });
    // The panel's card says an order can be set here (a plain position the wallet holds, with liquidity).
    await page.locator(`[data-v2in-position="${ID}"] [data-v2in-exit="plain"] [data-v2in-open="mandate"]`).waitFor({ state: 'attached', timeout: 30_000 });
    const more = detail.locator('[data-position-actions] [data-position-v2-more]');
    await more.waitFor({ timeout: 30_000 });
    assert.equal(await more.getAttribute('role'), 'group');
    const entries = await more.locator('[data-position-v2-action]').evaluateAll((all) => all.map((one) => [one.getAttribute('data-position-v2-action'), one.textContent?.trim()]));
    assert.deepEqual(entries.map(([key]) => key), ['increase', 'changeRange', 'exit', 'protect']);
    assert.deepEqual(entries.at(-1), ['protect', 'Stop-loss / take-profit']);
    await more.locator('[data-position-v2-action="protect"]').click();
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="mandate"]');
    await dialog.waitFor();
    assert.match(await dialog.locator('[data-mandate-input="falls"]').getAttribute('aria-label'), /^Exit if the price falls to/);
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
    await card.locator('[data-vault-open="leave"]').click();
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="vault-leave"]');
    await dialog.waitFor();
    // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
    assert.equal(await dialog.locator('[data-vault-lede="leave"]').innerText(), `Your next positions and everything your automation can pay go to your wallet in one action, and position #${ROOT} stops being automated. No fee.`);
    assert.equal(await dialog.locator('[data-leave-v4]').innerText(), `Afterwards you can remove Domino from position #${ROOT} and revoke your automation's approval on it.`);
    assert.equal(await dialog.locator('[data-v2in-send="leave"]').innerText(), 'Confirm in wallet');
    await dialog.locator('[data-wallet-step="exit-all"]').waitFor({ timeout: 30_000 });
    assert.equal(await dialog.locator('[data-vault-note="vault_exit_all_pauses_orders"]').innerText(), 'This also pauses your auto-exit orders. You can turn them back on later.');
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
test('live: an exit order paused because auto-exit is off offers "Turn auto-exit back on": one step, setExitModule(autoExit), the order as signed', async () => {
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
    const order = page.locator(`[data-v2in-position="${ROOT}"] [data-order][data-order-status="active"]`);
    await order.waitFor({ timeout: 30_000 });
    assert.equal(await order.locator('[data-order-condition="mandate_module_off"]').innerText(), 'Paused: auto-exit is turned off for your automation.');
    const turnOn = page.locator(`[data-v2in-position="${ROOT}"] [data-order-module-on]`);
    assert.equal(await turnOn.innerText(), 'Turn auto-exit back on');
    await turnOn.click();
    const dialog = page.locator('[role="dialog"][data-v2in-dialog="module-on"]');
    await dialog.waitFor();
    assert.equal(await dialog.locator('.dm-receipt-lede').innerText(), 'Your paused exit orders work again, exactly as you signed them. Nothing else changes.');
    await page.waitForFunction(() => document.querySelector('[data-v2in-send="module-on"]')?.disabled === false, null, { timeout: 30_000 });
    assert.deepEqual(chain.sends, [], 'for the person to confirm');
    await dialog.locator('[data-v2in-send="module-on"]').click();
    await dialog.locator('[data-v2in-close]').waitFor({ timeout: 30_000 });
    const sent = chain.sends.at(-1);
    assert.deepEqual([sent.to.toLowerCase(), selectorOf(sent.data)], [vault, toFunctionSelector('setExitModule(address)')]);
    assert.equal(chain.vault(vault).exitModule, AUTO_EXIT, 'auto-exit on again: the paused orders can fire');
    await dialog.screenshot({ path: join(shots(), 'v2in-auto-exit-back-on.png'), animations: 'disabled' });
  } finally {
    await s.close();
  }
});

test('protection on USDG / ERC-20 uses the actual page price with different decimals and reversed price units', async () => {
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
    await dialog.locator('[data-mandate-reference="current"]').waitFor();
    assert.equal(await dialog.locator('[data-mandate-current-price]').innerText(), '0.0625');
    assert.match(await dialog.locator('[data-mandate-input="falls"]').getAttribute('aria-label'), /USDG per ORB/);
    await dialog.locator('[data-mandate-shortcut="falls-20"]').click();
    assert.equal(await dialog.locator('[data-mandate-input="falls"]').inputValue(), '0.05');
    await dialog.locator('[data-mandate-shortcut="rises-20"]').click();
    assert.equal(await dialog.locator('[data-mandate-input="rises"]').inputValue(), '0.075');
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 960 });
      const overflow = await dialog.evaluate((node) => [node, node.querySelector('.dm-flow-dialog-body')].some((el) => el.scrollWidth > el.clientWidth + 1));
      assert.equal(overflow, false, `protection at ${width} has no horizontal overflow`);
      await dialog.screenshot({ path: join(shots(), `protection-orb-selected-${width}-local-fixture.png`), animations: 'disabled' });
    }
    await dialog.locator('[data-mandate-switch]').click();
    assert.equal(await dialog.locator('[data-mandate-current-price]').innerText(), '16');
    assert.ok(Number(await dialog.locator('[data-mandate-input="falls"]').inputValue()) < 16);
    assert.ok(Number(await dialog.locator('[data-mandate-input="rises"]').inputValue()) > 16);
    await dialog.locator('[data-mandate-review]').click();
    await dialog.locator('[data-mandate-terms]').waitFor();
    assert.match(await dialog.locator('[data-mandate-trigger="below"]').innerText(), /Exit if the price falls/);
    assert.match(await dialog.locator('[data-mandate-trigger="above"]').innerText(), /Exit if the price rises/);
    for (const method of SENDS_AND_SIGNATURES) assert.ok(!s.wallet.state.log.some((entry) => entry.method === method));
  } finally { await s.close(); }
});

test('live protection registers the exact chosen exit only after warnings, signature and wallet confirmation', async () => {
  const liquidity = 10n ** 18n;
  const chain = createVaultChain({ chainId: 4663, atomic: 'ready', simulateV1: true, positions: [{ dex: 4, tokenId: ROOT, pool: POOL, tickLower: -600, tickUpper: 600, liquidity }] });
  const vault = await chain.seedVault({ dex: 4, tokenId: ROOT, startPaused: false });
  const portfolio = listing(chain, vault, { armed: true, reserves: [[ZERO, 0n], [USDG, 0n]], root: { owner: OWNER, liquidity } });
  const s = await openLive(chain, { hash: `/positions/${ROOT}`, read6: { portfolio }, v1: rootOnV1({ liquidity }) });
  try {
    const { page } = s;
    await page.locator('[data-position-v2-action="protect"]').click();
    const dialog = page.locator('[data-v2in-dialog="mandate"]');
    await dialog.locator('[data-mandate-shortcut="falls-10"]:not([disabled])').click();
    const chosen = await dialog.locator('[data-mandate-input="falls"]').inputValue();
    assert.notEqual(chosen, '');
    await dialog.locator('[data-mandate-review]').click();
    await dialog.locator('[data-mandate-terms]').waitFor();
    const send = dialog.locator('[data-mandate-send]');
    assert.equal(await send.isDisabled(), true, 'review alone never authorizes a signature');
    assert.equal(chain.log.includes('eth_signTypedData_v4'), false);
    await dialog.locator('[data-mandate-ack]').check();
    await dialog.locator('[data-mandate-send]:not([disabled])').waitFor({ timeout: 30_000 });
    assert.equal(chain.log.includes('eth_signTypedData_v4'), false, 'acknowledgement alone never signs');
    await send.click();
    await dialog.locator('[data-mandate-registered]').waitFor({ timeout: 30_000 });
    assert.ok(chain.log.includes('eth_signTypedData_v4'));
    assert.ok(chain.log.includes('wallet_sendCalls'), 'enable and register batch uses the existing money client');
    assert.match(await dialog.locator('[data-mandate-trigger="below"]').innerText(), /Exit if the price falls/);
    assert.match(await dialog.locator('[data-mandate-trigger="above"]').innerText(), /Off$/);
    assert.equal(await dialog.locator('[data-mandate-send]').count(), 0, 'registered order cannot be accidentally sent twice');
  } finally { await s.close(); }
});
