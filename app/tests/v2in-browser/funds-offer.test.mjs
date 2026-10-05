/** Round 5: the real inline V2 funding UI, served against controlled read/session/quote fixtures. No live wallet or network. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeBrowser } from '../support/close-browser.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';

const APP = resolve(import.meta.dirname, '../..');
if (!existsSync(join(WALLET_V2_DIST, 'index.html'))) throw new Error('.wallet-test-v2-dist is missing. Run npm run build:wallet-test-v2 first (npm run test:v2in does).');
// The server takes the production CSP from the compiled middleware (the unit build, as every browser suite needs).
if (!existsSync(resolve(APP, '.test-build/app/functions/_middleware.js'))) execFileSync(process.execPath, ['scripts/test.mjs', '--build-only'], { cwd: APP, stdio: 'ignore' });
const { routeChain } = await import('../support/browser-chain.mjs');
const { createFakeSession } = await import('../support/fake-session.mjs');
const { ARTWORK, pressContinue } = await import('../support/new-position.mjs');
const { FIXTURE_TOKEN, createReadStub } = await import('../support/read-stub.mjs');
const { installS2Wallet, S2_ACCOUNT, S2_OWNER } = await import('../support/s2-wallet.mjs');
const { createWalletServer } = await import('../support/wallet-server.mjs');

const V2_DIST = WALLET_V2_DIST;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const ZERO = '0x0000000000000000000000000000000000000000';
const READ = resolve(import.meta.dirname, '../../../api-contracts/read-v1/fixtures/gateway');
/** A read-v1 gateway fixture with the fixture TOKEN standing for USDG: its address and its symbol, nothing else. */
const asUsdg = (name) => readFileSync(resolve(READ, `${name}.json`), 'utf8').replaceAll(FIXTURE_TOKEN, USDG).replaceAll('"TOKEN"', '"USDG"');
/** What a wallet on Robinhood Chain is never asked by the offer on the preview: no switch, no read, no signature, no send. */
const NEVER = ['eth_sendTransaction', 'eth_signTypedData_v4', 'wallet_sendCalls', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_estimateGas', 'eth_getTransactionCount'];

let browser;
before(async () => {
  for (const options of process.env.DOMINO_BROWSER_PATH ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }] : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}]) {
    try {
      browser = await chromium.launch({ ...options, headless: true });
      break;
    } catch {}
  }
  if (!browser) throw new Error('A Chromium browser is required.');
});
after(async () => {
  await closeBrowser(browser);
});

const shot = (page, name) => {
  const dir = resolve(import.meta.dirname, '../../.test-artifacts');
  mkdirSync(dir, { recursive: true });
  return page.screenshot({ path: resolve(dir, name), fullPage: true });
};

/** The wallet's balances as the read service reports them: read-v1 wallet-assets.zero, TOKEN as USDG, and `ethWei` of ETH. */
function walletAssets(ethWei) {
  const body = JSON.parse(asUsdg('wallet-assets.zero'));
  body.items.find((item) => item.address === ZERO).amountRaw = String(ethWei);
  return JSON.stringify(body);
}

/**
 * The build served with the read stub (TOKEN as USDG; no USDG, and `ethWei` of ETH, none unless said) and the test wallet
 * connected on Robinhood Chain, at New position's amount step.
 */
async function openNewPosition({ gateOpen = true, ethWei = 0n, balances = {}, bridge = false } = {}) {
  const fake = createFakeSession();
  const errors = [];
  // The read stub's own fixture for each read (tests/support/read-stub.mjs), TOKEN as USDG, and the wallet's balances.
  const read = createReadStub({
    answer: (route, body) =>
      route === 'wallet-assets'
        ? walletAssets(ethWei)
        : asUsdg({ 'pool-market': 'pool-market.not-requested', token: body.token === ZERO ? 'token.native' : 'token.success' }[route] ?? `${route}.success`),
  });

  const bridgeCalls = [];
  const bridgeRoute = async (request, url) => {
    if (!bridge || !url.pathname.startsWith('/api/crosschain/v1/')) return undefined;
    const route = url.pathname.split('/').at(-1);
    const headers = { 'X-Domino-Crosschain-Contract': '1.0.0-rc.1' };
    if (route === 'capabilities') return Response.json({ contractVersion: '1.0.0-rc.1', dataMode: 'live', enabledRoutes: ['origins', 'quote', 'status'] }, { headers });
    const cookie = request.headers.get('cookie')?.match(/__Host-domino-session=([^;]+)/)?.[1];
    const session = fake.state.sessions.get(cookie);
    assert.ok(session && !session.revoked, 'private bridge reads use a real test session');
    assert.equal(request.headers.get('X-Domino-CSRF'), session.csrf);
    const body = await request.json(); bridgeCalls.push({ route, body });
    const file = route === 'quote' && body.destinationGas ? 'variants/quote.destination-gas' : route === 'quote' && body.slippageBps === 200 ? 'variants/quote.none' : 'responses/' + route;
    const data = JSON.parse(readFileSync(resolve(APP, '../api-contracts/crosschain-v1/fixtures/' + file + '.json'), 'utf8').replaceAll('0x1111111111111111111111111111111111111111', S2_OWNER));
    if (route === 'quote') {
      data.quote.requestedAt = data.quote.retrievedAt = Math.floor(Date.now() / 1000);
      data.quote.expiresAt = data.quote.requestedAt + 120;
      assert.deepEqual(body, Object.fromEntries(Object.entries(data.quote.request).filter(([key]) => key !== 'owner')));
    }
    return Response.json(data, { headers });
  };
  const server = createWalletServer({ fake, dist: V2_DIST, routes: [bridgeRoute, (request, url) => read.handle(request, url) ?? undefined] });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fake.origin = origin;
  const context = await browser.newContext({ viewport: { width: 1320, height: 1100 } });
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  const rpc = await routeChain(context);

  let signCalls = 0;
  if (bridge) {
    await context.exposeFunction('__r5SignTestMessage', async (raw) => { signCalls++; return S2_ACCOUNT.signMessage({ message: { raw } }); });
    await context.addInitScript(() => {
      const wrapped = new WeakSet();
      window.addEventListener('eip6963:announceProvider', (event) => {
        const provider = event.detail.provider;
        if (event.detail.info.name !== 'S2 Test Wallet' || wrapped.has(provider)) return;
        wrapped.add(provider);
        const original = provider.request.bind(provider);
        provider.request = (args) => args.method === 'personal_sign' ? window.__r5SignTestMessage(args.params[0]) : original(args);
      });
    });
  }
  const wallet = await installS2Wallet(context, { chainId: 4663, ...balances });
  // The gate's test-build hook (src/v2/gate.ts): opens V2 options on this server's origin; S2 is then `preview` here.
  if (gateOpen) await context.addInitScript(() => { window.__dominoV2Test = { originOpen: true }; });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const s = {
    page,
    wallet,
    context,
    bridgeCalls,
    signCalls: () => signCalls,
    async close() {
      await context.close();
      await server.closeAll();
      assert.deepEqual(errors, [], 'no page error');
      assert.deepEqual(wallet.state.sends, [], 'the wallet was never asked to send');
      assert.deepEqual(wallet.state.log.filter((entry) => NEVER.includes(entry.method)).map((entry) => entry.method), [], 'no automatic wallet switch, signature or transaction');
      assert.deepEqual(rpc.publicAsked ?? [], [], 'no public RPC');
    },
  };
  try {
    await page.goto(`${origin}/#/new`);
    await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await page.locator('header [aria-haspopup="dialog"]').click();
    await page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Connect S2 Test Wallet', exact: true }).click();
    await page.waitForFunction(() => window.__dominoSessionProbe?.view().status !== 'no_wallet');
    await page.keyboard.press('Escape');
    // Step 1: USDG and its pool; step 2: the range the pool's price gives; then the amount step.
    await page.getByRole('combobox', { name: 'Search a token' }).fill(USDG);
    await page.locator(`[data-token-option="${USDG}"]`).click();
    await page.locator('[data-picker="pool"] input[name="pool-option"]').first().click({ timeout: 30_000 });
    await page.locator('[data-chosen-pool]').waitFor();
    const current = (step) => page.locator(`li[data-step="${step}"][aria-current="step"]`);
    await pressContinue(current('pool'));
    await current('range').waitFor();
    await pressContinue(current('range'));
    await current('amount').waitFor();
    // The amount step's own balance read has answered (zero USDG, zero ETH).
    await page.locator('li[data-step="amount"] [data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
    return s;
  } catch (error) {
    await s.close().catch(() => {});
    throw error;
  }
}


const OUT = process.env.DOMINO_R5_SHOTS;
async function capture(s, name) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  for (const width of [1440, 390, 320]) {
    await s.page.setViewportSize({ width, height: 1080 });
    await s.page.locator('[data-funds-offer]').scrollIntoViewIfNeeded();
    await s.page.screenshot({ path: resolve(OUT, name + '-' + width + '.png'), fullPage: true });
    assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow at ' + width);
  }
}

test('insufficient funds automatically shows the inline offer and its real service state, without wallet prompts', async () => {
  const s = await openNewPosition();
  try {
    const offer = s.page.locator('[data-funds-offer]');
    await offer.waitFor();
    assert.equal(await offer.evaluate((el) => el.tagName), 'SECTION');
    assert.equal(await offer.locator(':scope > summary').count(), 0);
    assert.match(await offer.locator('[data-funds-locked]').innerText(), /isn't available yet/);
    assert.equal(await offer.locator('[data-funds-scan]').count(), 0, 'do not ask the wallet to scan for an unavailable bridge');
    assert.equal(await offer.locator('[data-funds-nothing]').count(), 0, 'an unread wallet is never reported empty');
    await capture(s, 'funds-unavailable-after-local-fixture');
  } finally { await s.close(); }
});

test('the current origin is read automatically once, with token amounts visible and no network switch', async () => {
  const s = await openNewPosition({ balances: { native: { 8453: 420000000000000000n }, tokens: {
    '8453:0x4200000000000000000000000000000000000006': { balance: 0n, decimals: 18 },
    '8453:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { balance: 120000000n, decimals: 6 },
  } } });
  try {
    await s.page.locator('[data-funds-offer]').waitFor();
    await s.wallet.switchChain(8453);
    await s.page.locator('[data-funds-found]').waitFor();
    assert.match(await s.page.locator('[data-funds-found]').innerText(), /0.42 ETH/);
    assert.match(await s.page.locator('[data-funds-found]').innerText(), /120 USDC/);
    assert.equal(await s.page.locator('[data-funds-bring]').first().isDisabled(), true, 'balances do not enable an unavailable bridge');
    const reads = () => s.wallet.state.log.filter((entry) => ['eth_call', 'eth_getBalance'].includes(entry.method)).length;
    const count = reads();
    await s.page.locator('[data-pair-side="1"] input[inputmode="decimal"]').fill('100');
    await s.page.waitForTimeout(600);
    assert.equal(reads(), count, 'typing does not rescan or disturb the caret');
    await capture(s, 'funds-balances-after-local-fixture');
  } finally { await s.close(); }
});

test('failed token reads show partial status, never nothing found or invented zeroes', async () => {
  const s = await openNewPosition();
  try {
    await s.page.locator('[data-funds-offer]').waitFor();
    await s.wallet.switchChain(8453);
    await s.page.locator('[data-funds-read-partial]').waitFor();
    assert.equal(await s.page.locator('[data-funds-nothing]').count(), 0);
    assert.equal(await s.page.locator('[data-funds-found]').count(), 0);
    assert.match(await s.page.locator('[data-funds-read-partial]').innerText(), /could not be checked/);
  } finally { await s.close(); }
});

test('a pool covered by the existing one-token swap keeps the cross-network offer out', async () => {
  const s = await openNewPosition({ ethWei: 500000000000000n + 1000000n });
  try {
    await s.page.waitForTimeout(500);
    assert.equal(await s.page.locator('[data-funds-offer]').count(), 0);
    await s.page.locator('[data-pair-side="1"] input[inputmode="decimal"]').fill('1000');
    await s.page.locator('[data-funds-offer]').waitFor();
    assert.equal(await s.page.locator('[data-funds-lack]').getAttribute('data-funds-lack'), 'short');
    await s.page.locator('[data-pair-side="1"] input[inputmode="decimal"]').fill('0.1');
    await s.page.locator('[data-funds-offer]').waitFor({ state: 'detached' });
  } finally { await s.close(); }
});

test('the closed V2 gate retains the original amount step without funds discovery', async () => {
  const s = await openNewPosition({ gateOpen: false });
  try {
    await s.page.waitForTimeout(500);
    assert.equal(await s.page.locator('[data-funds-offer]').count(), 0);
  } finally { await s.close(); }
});


test('a live bridge waits for explicit sign-in, loads origins after sign-in and drops the quote on logout', async () => {
  const s = await openNewPosition({ bridge: true });
  try {
    const offer = s.page.locator('[data-funds-offer]');
    await offer.locator('[data-funds-session="signed_out"]').waitFor();
    assert.equal(s.bridgeCalls.length, 0, 'no private request without session');
    assert.equal(s.signCalls(), 0);
    await offer.locator('[data-funds-signin]').click();
    const dialog = s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe.view().status === 'signed_in');
    await s.page.keyboard.press('Escape');
    await offer.locator('[data-funds-origins="ok"]').waitFor();
    assert.equal(s.bridgeCalls.filter((c) => c.route === 'origins').length, 1);
    assert.equal(s.signCalls(), 1, 'only the person\'s sign-in click signs the test message');
    await s.page.locator('#funds-origin-chain').click();
    await s.page.getByRole('option', { name: 'Arbitrum', exact: true }).click();
    await s.page.locator('#funds-origin-token').click();
    await s.page.getByRole('option', { name: /^USDC ·/ }).click();
    await s.page.locator('#funds-amount').fill('100');
    await offer.locator('[data-funds-get-quote]').click();
    await offer.locator('[data-funds-quote]').waitFor();
    assert.equal(s.bridgeCalls.filter((c) => c.route === 'quote').length, 1);
    await capture(s, 'funds-review-after-local-fixture');
    await s.page.locator('header [aria-haspopup="dialog"]').click();
    await dialog.getByRole('button', { name: 'Sign out', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe.view().status === 'signed_out');
    await s.page.keyboard.press('Escape');
    await offer.locator('[data-funds-session="signed_out"]').waitFor();
    assert.equal(await offer.locator('[data-funds-quote]').count(), 0);
    assert.equal(s.bridgeCalls.filter((c) => c.route === 'quote').length, 1, 'no automatic quote after logout');
  } finally { await s.close(); }
});



test('bridge review keeps fees, minimum received, optional destination gas and no-route reasons tied to the quoted plan', async () => {
  const s = await openNewPosition({ bridge: true });
  try {
    const offer = s.page.locator('[data-funds-offer]');
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
    const gas = offer.locator('[data-funds-destination-gas]');
    assert.equal(await gas.locator('input').isChecked(), false, 'gas delivery is the person\'s choice');
    await gas.locator('input').check();
    await offer.locator('[data-funds-get-quote]').click();
    const quote = offer.locator('[data-funds-quote]');
    await quote.waitFor();
    assert.equal(await quote.getAttribute('data-funds-decision'), 'relay');
    assert.match(await quote.locator('[data-funds-candidate="relay"] [data-funds-lines]').innerText(), /at least 97.046108 USDG/);
    assert.match(await quote.locator('[data-funds-bridge-elsewhere]').innerText(), /Domino fee 0.35% · via Relay/);
    assert.equal(await quote.locator('[data-funds-candidate="across"]').getAttribute('data-funds-status'), 'destination_gas_unsupported');
    assert.equal(await quote.locator('[data-funds-candidate="across"]').isVisible(), false, 'alternative is initially folded');
    await quote.locator('[data-funds-alternatives] > summary').click();
    assert.equal(await quote.locator('[data-funds-candidate="across"]').isVisible(), true, 'the alternative and its refusal reason remain accessible');
    assert.deepEqual(await quote.locator('[data-funds-step]').evaluateAll((steps) => steps.map((el) => el.getAttribute('data-funds-step'))), ['switch', 'approval', 'deposit']);
    await offer.locator('[data-funds-edit] > summary').click();
    await gas.locator('input').uncheck();
    await offer.locator('[data-funds-slippage] > summary').click();
    await offer.locator('[data-funds-slippage-input]').fill('2');
    await offer.locator('[data-funds-get-quote]').click();
    await s.page.waitForFunction(() => document.querySelector('[data-funds-quote]')?.getAttribute('data-funds-decision') === 'none');
    assert.equal(await quote.locator('[data-funds-deposit-button]').count(), 0, 'no send control for a plan with no route');
    assert.deepEqual(s.bridgeCalls.filter((entry) => entry.route === 'quote').map((entry) => [entry.body.destinationGas, entry.body.slippageBps]), [[true, 50], [false, 200]]);
  } finally { await s.close(); }
});
