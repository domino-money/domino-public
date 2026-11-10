import { jump } from './support/clock.mjs';
import assert from 'node:assert/strict';
import { after, before } from 'node:test';
// 2026-10-01 (audit H2): CI runs this suite in parts, one job each; part() below names the part of the tests after it.
import { keepOnFailure, part, test } from './support/parts.mjs';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { closeBrowser } from './support/close-browser.mjs';
import { concatHex, encodeAbiParameters, keccak256, pad, toFunctionSelector } from 'viem';
import { logLimitError } from './support/log-limits.mjs';
import { createFakeOnboarding, routedSwapPreview } from './support/fake-onboarding.mjs';
import { routePermitAbi, routeExecuteAbi } from '../.test-build/app/src/finance/routedSwap.js';
import { ROUTE_PERMIT2, UNIVERSAL_ROUTER, ROUTE_FEE_RECIPIENT } from '../.test-build/app/src/finance/pin.js';
import { createFakeSession } from './support/fake-session.mjs';
import { createWalletServer, WALLET_DIST } from './support/wallet-server.mjs';
import { WALLET_V2_DIST } from './support/wallet-dist.mjs';
import { ACCOUNTS, installWallets } from './support/mock-wallet.mjs';
import { ARTWORK, choosePool, footerButton, pressContinue, walkToReview } from './support/new-position.mjs';
import { FIXTURE_TOKEN, createReadStub, gatewayError } from './support/read-stub.mjs';
// The mint's own sizing, from the unit build (npm test compiles it first, as check:app runs it first).
import { bandFor, bandLiquidity, mintPlanFor } from '../.test-build/app/src/lib/create/mintPlan.js';
// 2026-09-28 (one-sided, review): v4-core's tick maths, for what a one-sided mint takes and a price inside a range.
import { sqrtPriceAtTick } from '../.test-build/app/src/lib/read/screens/poolRange.js';
// 2026-09-25: a fake chain, and a recorded fees case as the chain it was read from. Since 2026-10-01 (RPC-SPEC) the page
// asks the site's own chain routes, answered by the routes' handler over that chain (tests/support/browser-chain.mjs).
import { SETUP_MINTED_TOPIC, browserChain, opIdOf, routeChain as routeRpc } from './support/browser-chain.mjs';
// 2026-09-27: a wallet that refunds a held deposit, for the test that holds the list's refresh during a refund.
import { createPositionChain } from './support/position-chain.mjs';
// 2026-10-01 (item H1): the point reads over a fake archive, and the chain RPC's charge for one address.
// 2026-10-02 (RPC-SPEC §11.4): a position and its own events, for the fees ledger's scenarios.
import { OWNER_STEPS, TOKENS as LEDGER_TOKENS, ledgerWorld } from './support/fees/ledger-world.mjs';
import { POOL_MANAGER as LEDGER_PM } from './support/fees/ledger-chain.mjs';
import { LEDGER_FLOOR, LEDGER_SCAN_BLOCKS } from '../.test-build/app/functions/_lib/feesLedger.js';
// 2026-09-27: how far back a later scan of the same wallet reads its logs, for the refresh tests.
import { REREAD_BLOCKS } from '../.test-build/app/functions/_lib/walletPositions.js';
import * as runtime from '../../api-contracts/performance-v2/runtime.mjs';
import * as executionRuntime from '../../api-contracts/execution-v1/runtime.mjs';
import * as depositRuntime from '../../api-contracts/deposit-v1/runtime.mjs';

let browser;
before(async () => {
  for (const options of process.env.DOMINO_BROWSER_PATH ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }] : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}]) {
    try { browser = await chromium.launch({ ...options, headless: true }); break; } catch {}
  }
  if (!browser) throw new Error('A Chromium browser is required.');
});
after(async () => { await closeBrowser(browser); });
const fixture = path => JSON.parse(readFileSync(new URL(`../../api-contracts/performance-v2/fixtures/${path}.json`, import.meta.url)));
const depositFixture = path => JSON.parse(readFileSync(new URL(`../../api-contracts/deposit-v1/fixtures/${path}.json`, import.meta.url)));
const statusWire = JSON.parse(readFileSync(new URL('../../api-contracts/execution-v1/fixtures/status-wire.json', import.meta.url)));
const OWNER = ACCOUNTS[0].address.toLowerCase();
const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
async function captureReceiptState(page, name, target) {
  if (!process.env.DOMINO_RECEIPT_SHOTS) return;
  mkdirSync(process.env.DOMINO_RECEIPT_SHOTS, { recursive: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 960 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name}: fits ${width}`);
    const frame = await target.evaluate(el => getComputedStyle(el).display === 'contents') ? target.locator('..') : target;
    await frame.screenshot({ path: join(process.env.DOMINO_RECEIPT_SHOTS, `${name}-${width}.png`), animations: 'disabled' });
  }
  await page.setViewportSize({ width: 1320, height: 1000 });
}
/** What the product rules keep off these screens. "Not connected" pills driven by ROADMAP are allowed; "not connected yet" is not. */
const FORBIDDEN = /not connected yet|not enabled|isn’t enabled|isn't enabled|aren't enabled|not available on this deployment|coming soon|in this release|\bbeta\b|\balpha\b|\bv4\b|read-only|temporarily unavailable|retry after|Last read/i;
const RELEASE_OFF = { status: 200, body: { contractVersion: '1.0.0-rc.1', chainId: 4663, available: false, deployment: null } };
/**
 * Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §3: performance-v2 is off on purpose, it is V1's "Start
 * tracking", and V1 is off since 2026-10-05): a build that carries Domino V2 (V1's suites run on wallet-test-v2,
 * scripts/v1-on-v2.mjs) never mounts V1's Performance (src/v2in/automate/ManagedVaults.tsx is its Managed positions, from
 * read-v6), so the tests of V1's history, its copies in this browser and Start tracking are the V1 build's alone.
 */
const V1_HISTORY = WALLET_DIST === WALLET_V2_DIST ? { skip: 'a build with Domino V2 draws no V1 history (rugged97, 6 Oct, §3)' } : {};

/**
 * `chain`: what the public RPC answers the page (tests/support/browser-chain.mjs), an empty chain unless one is given
 * (no position, no deposit, every NFT unknown), as the site's routes answered before 2026-09-25. `refresh` (2026-09-27):
 * Your positions and a position's page read themselves again on their own, as they do outside test builds.
 */
async function scenario({ clock = false, routes = [], chain = browserChain(), refresh = false, prefetch = false, points = false } = {}) {
  const fake = createFakeSession();
  const calls = [], executions = [], releases = [], deposits = [], errors = [];
  const state = { performance: 'available', execution: 'on', setupRelease: RELEASE_OFF, sequenceRelease: RELEASE_OFF, deposit: null };
  const server = createWalletServer({ fake, dist: WALLET_DIST, routes: [...routes, async (request, url) => {
    if (url.pathname.startsWith('/api/setup/v1/')) {
      releases.push({ path: url.pathname, method: request.method, contract: request.headers.get('X-Domino-Setup-Contract') });
      const answer = url.pathname === '/api/setup/v1/sequence-release' ? state.sequenceRelease : state.setupRelease;
      return json(answer.body, answer.status, { 'X-Domino-Setup-Contract': '1.0.0-rc.1' });
    }
    if (url.pathname.startsWith('/api/execution/v1/')) {
      executions.push(url.pathname);
      assert.ok(request.headers.get('cookie')?.includes('__Host-domino-session=')); assert.ok(request.headers.get('X-Domino-CSRF'));
      const headers = { 'X-Domino-Execution-Contract': executionRuntime.CONTRACT_VERSION };
      if (state.execution === 'off') return json({ error: 'route_not_available' }, 404, headers);
      const page = { ...statusWire.responses['list.empty'], owner: OWNER, items: [statusWire.responses['status.reserved'].item] };
      assert.ok(executionRuntime.validateResponse('list', page));
      return json(page, 200, headers);
    }
    if (url.pathname.startsWith('/api/deposit/v1/') && state.deposit) {
      const route = url.pathname.split('/').at(-1), body = JSON.parse(await request.text());
      deposits.push({ route, body });
      return state.deposit(route, body);
    }
    if (!url.pathname.startsWith('/api/performance/v2/')) return;
    calls.push(url.pathname);
    assert.ok(request.headers.get('cookie')?.includes('__Host-domino-session=')); assert.ok(request.headers.get('X-Domino-CSRF'));
    const route = url.pathname.split('/').at(-1), headers = { 'X-Domino-Performance-Contract': runtime.CONTRACT_VERSION };
    if (state.performance === 'off') return json({ error: 'route_not_available' }, 404, headers);
    const value = route === 'epochs' ? fixture('responses/epochs') : fixture(state.performance === 'available' ? 'responses/cards' : 'variants/stale');
    value.owner = OWNER;
    if (route === 'cards' && state.performance === 'available') {
      // A loss, an 18-decimal amount and a negative rate, as the producer may send them.
      Object.assign(value.cards[0].metrics, { newTradingFeesUsd: '0.500000000000000000', netFeeIncomeUsd: '-0.500000000000000000', timeWeightedCapitalUsd: '1234.567890123456789012', netFeeAprPercent: '-14.782500000000000000' });
    }
    assert.ok(runtime.validateResponse(route, value));
    return json(value, 200, headers);
  }] });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`; fake.origin = origin;
  const context = await browser.newContext({ viewport: { width: 1320, height: 1000 } });
  if (clock) await context.clock.install({ time: Date.now() });
  if (refresh) await context.addInitScript(() => { window.__dominoRefresh = true; });
  if (prefetch) await context.addInitScript(() => { window.__dominoAprPrefetch = true; });
  // 2026-10-01 (item H1): the fees history's point reads, on in a test build only when asked (src/lib/fees/spawn.ts).
  if (points) await context.addInitScript(() => { window.__dominoPoints = true; });
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const rpc = await routeRpc(context, chain);
  const wallet = await installWallets(context);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#/app`);
  return { page, origin, fake, calls, executions, releases, deposits, wallet, context, rpc, set(patch) { Object.assign(state, patch); }, async close() {
    await keepOnFailure(context); await context.close(); await server.closeAll(); assert.deepEqual(errors, []); assert.deepEqual(wallet.state.csp, []); assert.deepEqual(wallet.state.refused, []); assert.deepEqual(rpc.errors, [], 'the public RPC was asked only what it answers');
  } };
}
async function login(page) {
  await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
  await page.locator('header [aria-haspopup="dialog"]').click();
  const dialog = page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
  await dialog.getByRole('button', { name: 'Connect Test Wallet A', exact: true }).click();
  await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
  await page.keyboard.press('Escape');
}
const noManualReads = async (root) => {
  const names = await root.getByRole('button').allInnerTexts();
  for (const name of names) assert.doesNotMatch(name, /^(Refresh|Retry|First positions|Read execution receipts|Load deployment.*)$/, `a control named ${name}`);
};

part('automation');

// Changed on purpose (owner, 2026-09-27, round 5, "Domino is for people who know nothing about pools"): the signed-out
// sentences are plain, a managed position is one short row with three figures and the rest inside All figures, and a receipt
// is one short row whose sentence is inside it.
test('private history and receipts read themselves after login, format exact producer amounts, and disappear on account change', V1_HISTORY, async () => {
  const s = await scenario();
  try {
    // Changed on purpose 2026-10-01 (audit D2): with no wallet connected yet, each card says to connect one (it said
    // "Sign in" to every visitor); once connected and signed out, it says to sign in (below, after Sign out).
    // Changed on purpose 2026-10-01 (the D2 follow-up): with nothing to show for the same reason, one line for both cards.
    await s.page.getByText('Connect a wallet to see your automated positions and their receipts.', { exact: true }).waitFor();
    assert.deepEqual([s.calls.length, s.executions.length], [0, 0], 'nothing private is read while signed out');
    await login(s.page);
    const history = s.page.locator('section[aria-label="Private performance"]');
    await history.locator('[data-performance-status] details.dm-mp-more > summary').click();
    await history.getByText('-$0.50', { exact: true }).waitFor();
    for (const text of ['$1,234.57', '-14.78%', '365.00%', '$1.00']) await history.getByText(text, { exact: true }).first().waitFor();
    const other = history.locator('[data-metric-name="otherStrategyCostsUsd"]');
    assert.deepEqual([await other.locator('dt').innerText(), await other.locator('dd').innerText()], ['Other costs', '$0.00']);
    assert.equal(await history.locator('[data-metric-name="timeWeightedCapitalUsd"] dd').getAttribute('title'), '1234.567890123456789012 USD.', 'the exact decimal stays one hover away');
    assert.equal(await history.locator('[data-metric-name="operatorCostsUsd"] dd').innerText(), '—');
    const card = history.locator('[data-performance-status]');
    assert.deepEqual([await card.getAttribute('data-collection-status'), await card.getAttribute('data-external-flows'), await card.getAttribute('data-operator-costs-reason'), await card.getAttribute('data-snapshot-age')], ['measuring', 'incomplete', 'full_l2_cost_unqualified', '0']);
    assert.match(await card.getAttribute('title'), /^Window \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC to .* Deposits and withdrawals may be incomplete\.$/);
    assert.equal(await card.locator('.dm-pill').innerText(), 'Current');
    assert.doesNotMatch(await history.innerText(), /\bavailable\b|_|Observed \d+ seconds|Historical APR is not a forecast/, 'no raw enums and no caption under the figures');
    const receipts = s.page.locator('section[aria-label="Execution receipts"]');
    await s.page.locator('section[aria-label="Execution receipts"][data-execution="ready"]').waitFor();
    // The performance introduction stays. Receipts' compact preview uses its outer heading and each row's state.
    const line = async (section) => { const desc = section.locator('.dm-acct-desc'); return [await desc.innerText(), await desc.getAttribute('title')]; };
    assert.deepEqual(await line(history), ['How your automated positions did in the last 24 hours.', 'Missing prices and incomplete history show as dashes.']);
    assert.equal(await s.page.getByRole('heading', { name: 'Receipts', exact: true }).count(), 1);
    assert.equal(await receipts.locator('h2, .dm-acct-desc').count(), 0, 'the short preview does not duplicate its Receipts heading or introduction');
    const reserved = receipts.locator('[data-execution-state="reserved"]');
    // Changed on purpose (the owner, 2026-09-27, round 6): one plain phrase everywhere, the position page's "Fees added back".
    assert.equal(await reserved.locator('summary').innerText(), 'In progress\nAdding fees back');
    await reserved.locator('summary').click();
    assert.match(await receipts.innerText(), /Getting ready\. Nothing has been sent\./);
    // Scoped to the two private sections: other cards on this page belong to the read screens.
    assert.doesNotMatch(await history.innerText(), FORBIDDEN); assert.doesNotMatch(await receipts.innerText(), FORBIDDEN);
    await noManualReads(history); await noManualReads(receipts);
    assert.deepEqual([s.calls.length, s.executions.length, s.wallet.state.signed.length], [2, 1, 1], 'one epochs/cards cycle and one receipts page, with only the login signature');
    const screenshots = resolve(import.meta.dirname, '../.test-artifacts'); mkdirSync(screenshots, { recursive: true });
    await s.page.screenshot({ path: join(screenshots, 'p2-private-history.png'), fullPage: true });
    await s.wallet.switchAccount('a', 1);
    await history.getByText('-$0.50', { exact: true }).waitFor({ state: 'hidden' });
    await reserved.waitFor({ state: 'detached' });
    assert.deepEqual([s.calls.length, s.executions.length], [2, 1]);
  } finally { await s.close(); }
});

/** The tab hidden or shown, as the browser reports it to the page. */
const setVisibility = (page, value) => page.evaluate((state) => {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  Object.defineProperty(document, 'hidden', { value: state === 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}, value);

// Changed on purpose (review:wallet, receipts polling): a switched-off route used to be asked again every 60 s while the tab stayed visible, so
// this case fast-forwarded 65 s. It cannot change without a deploy, so it is not asked again on a timer; the owner coming back to the tab asks.
test('switched off, history and receipts show a quiet unavailable state and are not asked again on a timer; switched on, both fill in when the tab is shown again, with nothing pressed', V1_HISTORY, async () => {
  const s = await scenario({ clock: true });
  s.set({ performance: 'off', execution: 'off' });
  try {
    await login(s.page);
    await s.page.locator('section[data-performance="unavailable"][data-performance-reason="route_not_available"]').waitFor();
    await s.page.locator('section[data-execution="unavailable"][data-execution-reason="route_not_available"]').waitFor();
    await s.page.getByText('Your automated positions appear here.', { exact: true }).waitFor();
    await s.page.getByText('Receipts are unavailable right now.', { exact: true }).waitFor();
    await captureReceiptState(s.page, 'receipts-unavailable', s.page.locator('section[aria-label="Execution receipts"]'));
    for (const section of ['Private performance', 'Execution receipts']) {
      const text = await s.page.locator(`section[aria-label="${section}"]`).innerText();
      assert.doesNotMatch(text, FORBIDDEN, section);
      assert.doesNotMatch(text, /route not available|route_not_available/i, `${section}: raw route errors are never printed`);
    }
    await noManualReads(s.page.locator('section[aria-label="Private performance"]')); await noManualReads(s.page.locator('section[aria-label="Execution receipts"]'));
    const screenshots = resolve(import.meta.dirname, '../.test-artifacts'); mkdirSync(screenshots, { recursive: true });
    await s.page.screenshot({ path: join(screenshots, 'p2-private-off.png'), fullPage: true });
    s.set({ performance: 'available', execution: 'on' });
    const asked = [s.calls.length, s.executions.length];
    await jump(s.page, '10:00');
    assert.deepEqual([s.calls.length, s.executions.length], asked, 'a route that is not there is not asked again while the tab stays visible');
    await setVisibility(s.page, 'hidden');
    await setVisibility(s.page, 'visible');
    // Changed on purpose (round 5): the loss is inside All figures now; the row's own Fees earned says the history is in.
    await s.page.locator('[data-metric-name="newTradingFeesUsd"] dd').getByText('$0.50', { exact: true }).waitFor();
    await s.page.locator('section[data-execution="ready"]').waitFor();
    assert.equal(s.wallet.state.signed.length, 1, 'turning on asked the wallet for nothing');
  } finally { await s.close(); }
});

const deposit = (body, status = 200) => json(body, status, { 'X-Domino-Deposit-Contract': depositRuntime.CONTRACT_VERSION });
const owned = (body, id) => { const out = structuredClone(body); out.walletStep = null; out.operation.owner = OWNER; out.operation.id = id; return out; };
const listOf = (operations, hasMore = false) => ({ contractVersion: depositRuntime.CONTRACT_VERSION, operations: operations.map(op => { const { history, ...rest } = structuredClone(op); return { ...rest, historyCount: history.length, lastStep: history.at(-1) ?? null }; }),
  hasMore, nextBefore: hasMore ? operations.at(-1).id : null, serverBroadcastAvailable: false, automationAvailable: false });

// Changed on purpose (Create position): a position is opened from New position's last step through the wallet, so Setup no longer asks for a
// wallet to deposit. It says in one line where a new position is made, and links there.
test('setup reads its release on mount, points to New position for a new position, and makes no deposit request or wallet transaction by merely opening the screen', async () => {
  const s = await scenario(); const depositCalls = [];
  s.page.on('request', request => { if (request.url().includes('/api/deposit/')) depositCalls.push(request.url()); });
  try {
    await s.page.goto(`${s.origin}/#/setup`);
    const line = s.page.locator('[data-setup-new-position]');
    await line.waitFor();
    assert.equal(await line.innerText(), 'Opening a position? Start with New position.');
    assert.equal(await line.getByRole('link', { name: 'New position', exact: true }).getAttribute('href'), '/new');
    assert.equal(await s.page.locator('[data-setup-wallet], [data-wallet-deposit]').count(), 0, 'no deposit through the wallet here');
    // Changed on purpose (qa:visual, dead ends): with no release and no saved profile an Owner recovery card promised a recovery with no way
    // into it. Nothing is shown in its place; where the release stands is a hidden marker's data and title.
    const recovery = s.page.locator('[data-setup-release="unavailable"][data-setup-release-reason="release_not_available"]');
    await recovery.waitFor({ state: 'attached' });
    assert.deepEqual(s.releases, [{ path: '/api/setup/v1/release', method: 'GET', contract: '1.0.0-rc.1' }], 'one public GET on mount');
    assert.deepEqual([await recovery.isHidden(), await recovery.getAttribute('data-recovery-profile'), await recovery.getAttribute('title')], [true, 'none', 'Setup deployment unavailable: release not available.']);
    assert.equal(await s.page.getByRole('heading', { name: /owner recovery/i }).count(), 0, 'no card that promises a recovery it has no way into');
    assert.equal(await s.page.getByRole('button', { name: 'Read my operations' }).count(), 0, 'no saved profile: nothing to read');
    const text = await s.page.locator('main').innerText();
    assert.match(text, /Continue a deposit or recover tokens from an unfinished operation\./);
    assert.doesNotMatch(text, /Read and refund your setup operations|\byet\b/i, 'nothing in the card’s place');
    assert.doesNotMatch(text, /pool fees still apply|Fund a new operation|Mint or create a new pool|assisted swap/i, 'no pool fee on a direct deposit, no funding without a release');
    assert.doesNotMatch(text, FORBIDDEN);
    assert.deepEqual(depositCalls, []); assert.equal(s.wallet.state.signed.length, 0); assert.deepEqual(s.wallet.state.refused, []);
  } finally { await s.close(); }
});

test('setup lists deposits in words, adds More deposits, links to the blocking deposit, and never prints a code', async () => {
  const s = await scenario();
  const draft = owned(depositFixture('responses/get'), '00000000-0000-4000-8000-000000000040');
  const pending = owned(depositFixture('variants/pending'), '00000000-0000-4000-8000-000000000050');
  const older = owned(depositFixture('variants/confirmed'), '00000000-0000-4000-8000-000000000063');
  const first = listOf([draft.operation, pending.operation], true), second = listOf([older.operation]);
  for (const [route, body] of [['list', first], ['list', second], ['get', draft], ['get', pending], ['reconcile', pending]]) assert.ok(depositRuntime.validateResponse(route, body), route);
  s.set({ deposit: (route, body) => route === 'list' ? deposit(body.before ? second : first)
    : route === 'reconcile' ? deposit(pending)
    : route === 'get' ? deposit(body.intentId === pending.operation.id ? pending : draft)
    : route === 'prepare' ? deposit({ error: 'deposit_owner_busy' }, 409)
    : deposit({ error: 'route_not_available' }, 404) });
  try {
    await login(s.page);
    await s.page.goto(`${s.origin}/#/setup`);
    const list = s.page.locator('[data-deposits]');
    const rows = list.locator('[data-deposit-row]');
    // The list renders before boot reconciles its outstanding row. Wait for
    // boot to finish before asserting the complete sequence of requests.
    await rows.nth(1).waitFor();
    await s.page.locator('[data-deposits="ready"]').waitFor();
    assert.deepEqual(s.deposits.map(call => call.route), ['list', 'reconcile'], 'boot: the first page, then the outstanding deposit');
    const pair = '0x111111…111111 / 0x222222…222222 · 0.30%';
    assert.match(await rows.nth(0).innerText(), new RegExp(`^${pair.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s+\\S.*\\s+Draft · Updated \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d:\\d\\d UTC$`));
    assert.match(await rows.nth(1).innerText(), /Pending · Updated .* UTC\s+Reserved slot$/);
    await list.getByText('100 raw units of 0x111111…111111').first().waitFor({ timeout: 60_000 });
    assert.doesNotMatch(await list.innerText(), /draft ·|awaiting_wallet|_/);

    await rows.nth(0).click();
    const panel = s.page.locator('section[data-view]');
    await panel.getByRole('heading', { name: 'Draft saved' }).waitFor();
    const selection = panel.locator('[data-testid="selection"]');
    for (const text of ['Ticks -120 to 180', '0.5%', '100 raw units of 0x111111…111111']) await selection.getByText(text).first().waitFor();
    await panel.getByRole('button', { name: 'Prepare first step' }).click();
    const notice = s.page.locator('[data-deposit-notice="deposit_owner_busy"]');
    await notice.waitFor();
    assert.equal(await notice.innerText(), 'Another deposit of yours is still open or needs attention. Resolve it first.');
    await s.page.getByRole('button', { name: 'Open the blocking deposit' }).click();
    await panel.getByRole('heading', { name: 'Submitted, waiting for finalization' }).waitFor();
    assert.deepEqual(s.deposits.at(-1), { route: 'get', body: { intentId: pending.operation.id } });

    await list.getByRole('button', { name: 'More deposits' }).click();
    await rows.nth(2).waitFor();
    assert.deepEqual(s.deposits.filter(call => call.route === 'list').map(call => call.body), [{ limit: 20 }, { limit: 20, before: pending.operation.id }]);
    assert.equal(await list.getByRole('button', { name: 'More deposits' }).count(), 0, 'no more pages');
    assert.match(await rows.nth(2).innerText(), /Confirmed · Updated/);
    const screenshots = resolve(import.meta.dirname, '../.test-artifacts'); mkdirSync(screenshots, { recursive: true });
    await s.page.screenshot({ path: join(screenshots, 'p2-setup-deposits.png'), fullPage: true });
    const text = await s.page.locator('main').innerText();
    assert.doesNotMatch(text, FORBIDDEN);
    assert.doesNotMatch(text, /deposit_owner_busy|owner busy|Uniswap v4/);
    assert.equal(s.deposits.filter(call => call.route === 'create').length, 0);
    assert.equal(s.wallet.state.signed.length, 1, 'only the login signature');
  } finally { await s.close(); }
});

test('a switched-off deposit service leaves only the empty list: no line about deployments and nothing to press', async () => {
  const s = await scenario();
  s.set({ deposit: () => deposit({ error: 'route_not_available' }, 404) });
  try {
    await login(s.page);
    await s.page.goto(`${s.origin}/#/setup`);
    const list = s.page.locator('[data-deposits="ready"][data-deposits-reason="route_not_available"]');
    await list.waitFor();
    assert.match(await list.innerText(), /^Your deposits\s+Deposits you create appear here\.$/);
    assert.equal(await s.page.locator('[data-deposit-notice]').count(), 0);
    assert.deepEqual(s.deposits.map(call => call.route), ['list']);
    assert.doesNotMatch(await s.page.locator('main').innerText(), FORBIDDEN);
    assert.doesNotMatch(await s.page.locator('main').innerText(), /Deposits aren.t enabled|deposit service/i);
  } finally { await s.close(); }
});

// Changed on purpose (qa:visual, dead ends; then the owner's simpler automation page, 2026-09-24): without a release the page says in one
// plain muted line that automation can't be set up here, why in its data and title. There are no owner controls, no saved-profile
// recovery path and nothing to read or press.
// Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §8: V1's sequence profile ends 2026-10-21 19:01:30 UTC and is not renewed):
// on the build that carries Domino V2 (V1's suites run on wallet-test-v2, scripts/v1-on-v2.mjs) the page still reads its release once,
// but never waits for it (screens/Sequence.tsx): with no release and no wallet it asks for the wallet, and never says it can't be set up.
/** Set up automation without V1's release in a build that carries Domino V2: the wallet's empty state, never the release's line. */
async function sequenceWithoutRelease(s, label) {
  const connect = s.page.locator('main.dm-seq [data-sequence-wallet="none"]');
  await connect.waitFor();
  await until(() => s.releases.some((call) => call.path === '/api/setup/v1/sequence-release'), `${label}: the release asked`);
  assert.equal(await s.page.locator('[data-sequence-release="unavailable"]').count(), 0, `${label}: no "Automation can’t be set up here."`);
  // Changed on purpose 2026-10-30 (QA round 2, the owner's decision on N13): the plate says where a first position comes
  // from and offers New position (a link) beside Connect wallet, the one button.
  assert.match(await connect.innerText(), /^Connect your wallet\s+Your open positions appear here to choose from\. Don’t have a position\? Start with New position\.\s+Connect wallet\s+New position$/, label);
  assert.deepEqual(await s.page.locator('main button').allInnerTexts(), ['Connect wallet'], `${label}: the wallet's one button, no owner controls`);
}
test('sequence is reachable from Automate, reads its release on mount with no wallet, and without one says in one plain line that automation can’t be set up here (with Domino V2: goes on to the wallet)', async () => {
  const s = await scenario();
  try {
    // The way into sequences lives on Automate (DESIGN.md E.6), where wallet builds render its link.
    await s.page.goto(`${s.origin}/#/automate`);
    await s.page.getByRole('link', {name:'Set up Domino-compound'}).click();
    // Changed on purpose 2026-10-30 (QA round 2, the owner's decision on N13): before a wallet the V2 page keeps the mode
    // chosen (screens/Sequence.tsx); V1's legacy page, built for its own suites only, keeps its one title.
    await s.page.getByRole('heading', {name: WALLET_DIST === WALLET_V2_DIST ? 'Set up Domino-compound' : 'Set up automation', exact:true}).waitFor();
    if (WALLET_DIST === WALLET_V2_DIST) {
      await sequenceWithoutRelease(s, 'no release');
      assert.deepEqual(s.releases, [{ path: '/api/setup/v1/sequence-release', method: 'GET', contract: '1.0.0-rc.1' }], 'one public GET on mount');
      assert.doesNotMatch(await s.page.locator('main').innerText(), FORBIDDEN);
      assert.equal(s.wallet.state.signed.length, 0); assert.deepEqual(s.wallet.state.refused, []);
      return;
    }
    const line = s.page.locator('[data-sequence-release="unavailable"][data-sequence-release-reason="release_not_available"]');
    await line.waitFor();
    assert.deepEqual(s.releases, [{ path: '/api/setup/v1/sequence-release', method: 'GET', contract: '1.0.0-rc.1' }], 'one public GET on mount');
    assert.deepEqual([await line.evaluate(el => el.tagName), await line.innerText(), await line.getAttribute('title')],
      ['P', 'Automation can’t be set up here.', 'Sequence deployment unavailable: release not available.']);
    assert.match(await line.getAttribute('class'), /\btext-fg-muted\b/, 'a muted line, not a card or a panel');
    const text = await s.page.locator('main').innerText();
    assert.doesNotMatch(text, /Owner controls|Network budget|Create a paused sequence|Manage a sequence|Root NFT|Sequence address|Pause, revoke permissions|\byet\b/i, 'none of the removed cards');
    assert.doesNotMatch(text, /not available|not connected|No approval or transaction was requested/i);
    assert.doesNotMatch(text, FORBIDDEN);
    assert.equal(await s.page.locator('main input').count(), 0, 'nothing to type');
    assert.equal(await s.page.locator('main button').count(), 0, 'nothing to press');
    await noManualReads(s.page.locator('main'));
    const screenshots=resolve(import.meta.dirname,'../.test-artifacts');mkdirSync(screenshots,{recursive:true});
    await s.page.screenshot({path:join(screenshots,'p2-sequence-off.png'),fullPage:true});
    assert.equal(s.wallet.state.signed.length,0);assert.deepEqual(s.wallet.state.refused,[]);
  } finally {await s.close();}
});

test('a refused or failing release (403, 404, 503) is treated like available:false, and a profile saved by an earlier version brings nothing back', async () => {
  const s = await scenario();
  const address = (n) => `0x${n.toString(16).padStart(2, '0').repeat(20)}`;
  const hash = (n) => `0x${n.toString(16).padStart(2, '0').repeat(32)}`;
  const implementation = address(0x12);
  const saved = { contractVersion: '1.0.0-rc.1', chainId: 4663, available: true, deployment: {
    factory: address(0x11), implementation, poolManager: address(0x13), positionManager: address(0x14), stateView: address(0x15), readHelper: address(0x16), engine: address(0x17), routing: address(0x18), priceGuard: address(0x19),
    serviceFeeRecipient: address(0x1a), operator: address(0x1b), pricePublisher: address(0x1c), serviceFeeBps: 200, dominoServiceFeeBps: 400, expiresAt: 1,
    codeHashes: { factory: hash(0x21), implementation: hash(0x22), poolManager: hash(0x23), positionManager: hash(0x24), stateView: hash(0x25), readHelper: hash(0x26), engine: hash(0x27), routing: hash(0x28), priceGuard: hash(0x29),
      vault: keccak256(concatHex(['0x363d3d373d3d3d363d73', implementation, '0x5af43d82803e903d91602b57fd5bf3'])) } } };
  try {
    // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §8): with Domino V2 in the build the page goes on to the wallet.
    const v2 = WALLET_DIST === WALLET_V2_DIST;
    for (const [status, code] of [[403, 'origin_not_allowed'], [404, 'route_not_available'], [503, 'setup_configuration_unavailable']]) {
      s.set({ sequenceRelease: { status, body: { error: code } }, setupRelease: { status, body: { error: code } } });
      await s.page.goto(`${s.origin}/#/sequence`); await s.page.reload();
      if (v2) await sequenceWithoutRelease(s, `sequence ${status}`);
      else await s.page.locator(`[data-sequence-release="unavailable"][data-sequence-release-reason="${code}"]`).waitFor();
      assert.doesNotMatch(await s.page.locator('main').innerText(), /Create a paused sequence|not available|not connected/i, `sequence ${status}`);
      await s.page.goto(`${s.origin}/#/setup`); await s.page.reload();
      // No saved profile: no card, only the hidden marker that says where the release stands.
      await s.page.locator(`[data-setup-release="unavailable"][data-setup-release-reason="${code}"]`).waitFor({ state: 'attached' });
      assert.doesNotMatch(await s.page.locator('main').innerText(), /Fund a new operation|not connected|not available on this deployment/i, `setup ${status}`);
    }
    // Changed on purpose (2026-09-24): the saved profile only fed the owner controls' recovery path, which the owner removed.
    await s.page.evaluate((value) => localStorage.setItem('domino.sequence.public-recovery.v1', JSON.stringify(value)), saved);
    await s.page.goto(`${s.origin}/#/sequence`); await s.page.reload();
    if (v2) await sequenceWithoutRelease(s, 'a saved profile');
    else {
      await s.page.locator('[data-sequence-release="unavailable"]').waitFor();
      assert.equal(await s.page.locator('main button').count(), 0, 'a saved profile brings no controls back');
    }
    assert.ok(s.releases.every(call => call.method === 'GET'));
    assert.equal(s.wallet.state.signed.length, 0); assert.deepEqual(s.wallet.state.refused, [], 'mounting asked the wallet for nothing');
  } finally { await s.close(); }
});

// ---- Setup's assisted swap: a quote for the amount the owner types (G15) ----------------
part('create');

const hex = (n, bytes = 20) => `0x${n.toString(16).padStart(2, '0').repeat(bytes)}`;
/** The pair of the one setup operation the chain below lists for the owner: not the pair typed into the funding fields. */
const OPERATION_PAIR = [hex(0x33), hex(0x44)];
/** A published setup release whose contracts the chain wallet below answers for: code hashes, identities, fee and tariff, and one funded operation. */
const CHAIN = (() => {
  const setup = hex(0x51), poolManager = hex(0x52), positionManager = hex(0x53), stateView = hex(0x54), feeRecipient = hex(0x55);
  const code = { [setup]: '0x6051', [poolManager]: '0x6052', [positionManager]: '0x6053', [stateView]: '0x6054' };
  const deployment = { setup, setupCodeHash: keccak256(code[setup]), poolManager, positionManager, stateView, poolManagerCodeHash: keccak256(code[poolManager]),
    positionManagerCodeHash: keccak256(code[positionManager]), stateViewCodeHash: keccak256(code[stateView]), feeRecipient, feeBps: 30, tariffVersion: '1', expiresAt: Math.floor(Date.now() / 1000) + 86_400 };
  const address = value => encodeAbiParameters([{ type: 'address' }], [value]);
  const operationAbi = parseAbi(['struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
    'struct Operation { address owner; PoolKey key; uint128 balance0; uint128 balance1; bool swapped; bool closed; uint256 tokenId; }', 'function operation(bytes32) view returns (Operation)']);
  const operation = { owner: ACCOUNTS[0].address, key: { currency0: OPERATION_PAIR[0], currency1: OPERATION_PAIR[1], fee: 3000, tickSpacing: 60, hooks: zeroAddress }, balance0: 50_000n, balance1: 0n, swapped: false, closed: false, tokenId: 0n };
  const calls = { [toFunctionSelector('manager()')]: address(poolManager), [toFunctionSelector('positions()')]: address(positionManager), [toFunctionSelector('stateView()')]: address(stateView),
    [toFunctionSelector('feeRecipient()')]: address(feeRecipient), [toFunctionSelector('assistedFeeBps()')]: encodeAbiParameters([{ type: 'uint16' }], [30]),
    [toFunctionSelector('tariffVersion()')]: encodeAbiParameters([{ type: 'uint64' }], [1n]), [toFunctionSelector('ownerNonce(address)')]: encodeAbiParameters([{ type: 'uint64' }], [1n]),
    [toFunctionSelector('operation(bytes32)')]: encodeFunctionResult({ abi: operationAbi, functionName: 'operation', result: operation }),
    [toFunctionSelector('recoveryStarted(bytes32)')]: encodeAbiParameters([{ type: 'bool' }], [false]) };
  return { deployment, code, calls };
})();

/**
 * A browser wallet that can also answer the read-only calls Setup verifies a deployment with (eth_getCode and the
 * setup contract's views), for this one scenario: mock-wallet.mjs deliberately answers sign-in methods only. It signs
 * the sign-in message with the first test account and refuses, and records, every other method.
 */
async function installChainWallet(context) {
  const account = ACCOUNTS[0], state = { log: [], refused: [], permitted: false };
  await context.exposeFunction('__dominoChainWallet', async (method, params) => {
    state.log.push(method);
    switch (method) {
      case 'eth_requestAccounts': state.permitted = true; return { result: [account.address] };
      case 'wallet_requestPermissions': state.permitted = true; return { result: [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [account.address] }] }] };
      case 'wallet_revokePermissions': state.permitted = false; return { result: null };
      case 'eth_accounts': return { result: state.permitted ? [account.address] : [] };
      case 'eth_chainId': return { result: '0x1237' };
      case 'wallet_switchEthereumChain': return { result: null };
      case 'personal_sign': return { result: await account.signMessage({ message: { raw: params[0] } }) };
      case 'eth_getCode': return { result: CHAIN.code[String(params[0]).toLowerCase()] ?? '0x' };
      case 'eth_gasPrice': return { result: '0x5f5e100' };
      case 'eth_call': {
        const { to, data } = params[0];
        const answer = String(to).toLowerCase() === CHAIN.deployment.setup ? CHAIN.calls[String(data).slice(0, 10)] : undefined;
        if (answer) return { result: answer };
        break;
      }
    }
    state.refused.push(method);
    return { error: { code: 4200, message: `${method} is not supported` } };
  });
  await context.addInitScript(() => {
    const provider = {
      async request({ method, params }) {
        const reply = await window.__dominoChainWallet(method, params ?? []);
        if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
        return reply.result;
      },
      on() { return provider; },
      removeListener() { return provider; },
    };
    const detail = Object.freeze({ info: Object.freeze({ uuid: '8f2a7d1c-0000-4000-8000-0000000000c1', name: 'Chain Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E', rdns: 'test.wallet.chain' }), provider });
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  });
  return state;
}

test('the assisted swap quotes the amount the owner types for a signed-in wallet: once per pause in typing, the fee taken off, never derived, never by opening the fields again, and nothing sent to the wallet (G15)', async () => {
  let onboarding = null;
  const s = await scenario({ routes: [(request, url) => (url.pathname.startsWith('/api/onboarding/v1/') ? onboarding.handle(request) : undefined)] });
  onboarding = createFakeOnboarding({ session: s.fake });
  onboarding.origin = s.origin;
  s.set({ setupRelease: { status: 200, body: { contractVersion: '1.0.0-rc.1', chainId: 4663, available: true, deployment: CHAIN.deployment } }, deposit: () => deposit({ error: 'route_not_available' }, 404) });
  const chain = await installChainWallet(s.context);
  const dialog = s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
  try {
    await s.page.goto(`${s.origin}/#/setup`);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await s.page.locator('header [aria-haspopup="dialog"]').click();
    await dialog.getByRole('button', { name: 'Connect Chain Wallet', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await s.page.keyboard.press('Escape');

    const advanced = s.page.locator('[data-setup-release="available"]');
    await advanced.getByRole('button', { name: 'Read my operations', exact: true }).click();
    await advanced.getByText('Deployment verified through your wallet. Choose an existing operation or review new funding.', { exact: true }).waitFor({ timeout: 30_000 });
    const field = (label) => advanced.locator('label', { hasText: label }).locator('input');
    await advanced.locator('details', { hasText: 'Fund a new operation' }).locator('summary').click();
    await field('Token 0 address').fill('0x1111111111111111111111111111111111111111');
    await field('Token 1 address').fill('0x2222222222222222222222222222222222222222');

    const swap = advanced.locator('details[data-assisted-swap]');
    const quote = swap.locator('section[data-swap-preview]');
    const quoteIs = (status) => s.page.waitForFunction((wanted) => document.querySelector('details[data-assisted-swap] section[data-swap-preview]')?.getAttribute('data-swap-preview') === wanted, status, { timeout: 30_000 });
    await swap.locator('summary').click();
    await quoteIs('off');
    assert.equal(await quote.getAttribute('data-swap-preview-reason'), 'not_formed', 'no amount typed: nothing to quote');
    assert.equal(onboarding.calls('swap-preview').length, 0);

    await field('Swap gross input').fill('10000');
    await quoteIs('current');
    const [first] = onboarding.calls('swap-preview');
    assert.deepEqual(first.body, { chainId: 4663, tokenIn: '0x1111111111111111111111111111111111111111', tokenOut: '0x2222222222222222222222222222222222222222', amountRaw: '9970', slippageBps: 50, maxPriceImpactBps: 100 },
      'the typed 10,000 less the published 30 bps fee (30): exactly what the pool would receive');
    const [session] = s.fake.sessionsFor(ACCOUNTS[0].address).filter(row => row.active);
    assert.equal(first.csrf, session.csrf);
    const rows = Object.fromEntries(await quote.locator('[data-swap-row]').evaluateAll(nodes => nodes.map(node => [node.getAttribute('data-swap-row'), node.querySelector('dd').textContent])));
    assert.deepEqual(rows, { input: '9,970', output: '19,940', minimum: '19,840', impact: '0.03%', 'provider-fee': 'None reported', gas: '0.00001 ETH', simulation: 'No failure reported', checks: 'Within your limits' });
    assert.match(await quote.locator('[data-swap-row="input"] dd').getAttribute('title'), /^A quote for this amount, current until \d\d:\d\d:\d\d\. Your amount less the assisted swap fee: what the pool receives\.$/);

    // A burst of typing is one more request, for the last amount only.
    await field('Swap gross input').fill('20000');
    await field('Swap gross input').fill('30000');
    await s.page.waitForFunction(() => document.querySelector('details[data-assisted-swap] [data-swap-row="input"] dd')?.textContent === '29,910', null, { timeout: 30_000 });
    assert.deepEqual(onboarding.calls('swap-preview').map(call => call.body.amountRaw), ['9970', '29910']);

    // Folded away, nothing more is asked.
    await swap.locator('summary').click();
    await s.page.waitForTimeout(1_000);
    assert.equal(onboarding.calls('swap-preview').length, 2);

    // Opened again, the fields ask for nothing already asked: a quote follows what is typed. A failed quote is what an opening used to ask again.
    const swaps = () => onboarding.calls('swap-preview');
    await swap.locator('summary').click();
    onboarding.failNext('swap-preview', 'provider_unavailable');
    await field('Swap gross input').fill('40000');
    await quoteIs('unavailable');
    await swap.locator('summary').click();
    await swap.locator('summary').click();
    await s.page.waitForTimeout(1_000);
    assert.deepEqual(swaps().map(call => call.body.amountRaw), ['9970', '29910', '39880'], 'folding and opening again asks for nothing more');

    // An operation chosen from the list quotes its own pair; typing another Operation ID leaves that pair behind, so the quote is never for it.
    const asked = async (count) => { for (const end = Date.now() + 30_000; swaps().length < count;) { assert.ok(Date.now() < end, `waiting for swap quote ${count}`); await s.page.waitForTimeout(50); } };
    await advanced.getByRole('button', { name: /^Funded · 0x/ }).click();
    assert.equal(await advanced.getByRole('button', { name: 'Review token 0 refund', exact: true }).isEnabled(), true);
    assert.equal(await advanced.getByRole('button', { name: 'Review token 1 refund', exact: true }).isEnabled(), false);
    await asked(4);
    await quoteIs('current');
    assert.deepEqual([swaps().at(-1).body.tokenIn, swaps().at(-1).body.tokenOut], OPERATION_PAIR, 'the chosen operation’s pair');
    await field('Operation ID').fill(`0x${'ab'.repeat(32)}`);
    await asked(5);
    await quoteIs('current');
    assert.deepEqual([swaps().length, swaps().at(-1).body.tokenIn, swaps().at(-1).body.tokenOut], [5, '0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222'], 'back to the funding fields’ pair');

    // The release gone at a press shows recovery and folds the swap away with its section; found again at the next press, the swap comes back
    // folded, and a folded swap asks for nothing, whatever was typed. Coming back to Setup first picks up the profile the first press saved.
    await s.page.goto(`${s.origin}/#/automate`);
    await s.page.goto(`${s.origin}/#/setup`);
    await s.page.locator('[data-setup-release="available"][data-recovery-profile="saved"]').waitFor();
    const readOperations = async (heading) => {
      await s.page.getByRole('button', { name: 'Read my operations', exact: true }).click();
      await s.page.getByText(heading, { exact: true }).waitFor({ timeout: 30_000 });
    };
    await readOperations('Deployment verified through your wallet. Choose an existing operation or review new funding.');
    await advanced.locator('details', { hasText: 'Fund a new operation' }).locator('summary').click();
    await field('Token 0 address').fill('0x1111111111111111111111111111111111111111');
    await field('Token 1 address').fill('0x2222222222222222222222222222222222222222');
    await swap.locator('summary').click();
    await field('Swap gross input').fill('50000');
    await quoteIs('current');
    const before = swaps().length;
    s.set({ setupRelease: RELEASE_OFF });
    await readOperations('The saved deployment was verified on chain. Read or refund your existing operations below.');
    assert.equal(await s.page.locator('details[data-assisted-swap]').count(), 0, 'recovery: no assisted swap');
    s.set({ setupRelease: { status: 200, body: { contractVersion: '1.0.0-rc.1', chainId: 4663, available: true, deployment: CHAIN.deployment } } });
    await readOperations('Deployment verified through your wallet. Choose an existing operation or review new funding.');
    await swap.waitFor();
    assert.equal(await swap.getAttribute('open'), null, 'back folded');
    await s.page.waitForTimeout(1_500);
    assert.deepEqual([swaps().length, await quote.getAttribute('data-swap-preview'), await quote.getAttribute('data-swap-preview-reason')], [before, 'off', 'not_open'], 'a folded swap asks for nothing');

    // The independently read recovery phase disables economic actions in the UI,
    // while leaving the remaining currency's owner refund available.
    CHAIN.calls[toFunctionSelector('recoveryStarted(bytes32)')] = encodeAbiParameters([{ type: 'bool' }], [true]);
    try {
      await readOperations('Deployment verified through your wallet. Choose an existing operation or review new funding.');
      await advanced.getByRole('button', { name: /^Recovering · 0x/ }).click();
      assert.equal(await advanced.locator('details[data-assisted-swap]').count(), 0);
      assert.equal(await advanced.getByText('Mint or create a new pool', { exact: true }).count(), 0);
      assert.equal(await advanced.getByRole('button', { name: 'Review token 0 refund', exact: true }).isEnabled(), true);
    } finally {
      CHAIN.calls[toFunctionSelector('recoveryStarted(bytes32)')] = encodeAbiParameters([{ type: 'bool' }], [false]);
    }

    const text = await advanced.innerText();
    assert.doesNotMatch(text, FORBIDDEN);
    assert.doesNotMatch(text, /Preview only|\bpreview\b/i);
    await noManualReads(advanced);
    assert.deepEqual(onboarding.state.violations, [], 'onboarding protocol violations');
    assert.ok(!chain.log.includes('eth_sendTransaction') && !chain.log.includes('eth_signTypedData_v4'), 'nothing was offered to the wallet');
    assert.deepEqual(chain.refused, [], 'the wallet was asked only for sign-in and read-only calls');
    assert.deepEqual(s.deposits.filter(call => call.route !== 'list'), [], 'no deposit request');
    // Optional review captures of the existing recovery controls over this fake chain.
    if (process.env.DOMINO_SETUP_SHOTS) {
      const out = resolve(process.env.DOMINO_SETUP_SHOTS);
      mkdirSync(out, { recursive: true });
      for (const width of [1180, 390, 320]) {
        await s.page.setViewportSize({ width, height: 900 });
        assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `recovery fits ${width}`);
        await advanced.screenshot({ path: join(out, `recovery-depois-${width}.png`) });
      }
    }
  } finally { await s.close(); }
});

// ---- Create position: New position's last step opens the position through the wallet, with no session and no Setup ----

/** The setup contract's ABI as finance/setup.ts lists it, and the token's, parsed so the chain below can decode every call and encode every answer. */
const setupChainAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct Operation { address owner; PoolKey key; uint128 balance0; uint128 balance1; bool swapped; bool closed; uint256 tokenId; }',
  'struct SwapPlan { bytes32 operationId; bool zeroForOne; uint128 grossInput; uint128 minOutput; uint160 sqrtPriceLimitX96; uint64 deadline; }',
  'struct MintPlan { bytes32 operationId; int24 tickLower; int24 tickUpper; uint128 liquidity; uint128 maxAmount0; uint128 maxAmount1; uint160 minSqrtPriceX96; uint160 maxSqrtPriceX96; uint160 initialSqrtPriceX96; uint64 deadline; }',
  'function manager() view returns (address)', 'function positions() view returns (address)', 'function stateView() view returns (address)', 'function feeRecipient() view returns (address)',
  'function assistedFeeBps() view returns (uint16)', 'function tariffVersion() view returns (uint64)', 'function ownerNonce(address) view returns (uint64)', 'function nextOperationId(address) view returns (bytes32)',
  'function operation(bytes32) view returns (Operation)', 'function recoveryStarted(bytes32) view returns (bool)',
  'function open(bytes32 id, PoolKey key, uint128 amount0, uint128 amount1) payable', 'function swap(SwapPlan) returns (uint128 output)', 'function mint(MintPlan)', 'function cancel(bytes32)',
  'function recoverCurrency(bytes32 id, address currency, uint128 amount)',
]);
/** finance/setup.ts's token ABI, and the balance read Create position checks the wallet with before asking it anything (CreatePosition.tsx). */
const erc20Abi = parseAbi(['function allowance(address,address) view returns(uint256)', 'function approve(address,uint256) returns(bool)', 'function balanceOf(address) view returns (uint256)']);
/** Uniswap's V4Quoter as finance/setup.ts's quoterAbi lists it: what Create position asks before a one-token deposit. */
const quoterChainAbi = parseAbi([
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }',
  'function quoteExactInputSingle(QuoteExactSingleParams params) returns (uint256 amountOut, uint256 gasEstimate)',
  'function poolManager() view returns (address)',
]);
/** The pinned quoter (src/finance/pin.ts V4_QUOTER) and its real runtime code, whose keccak256 is the pinned hash. */
const QUOTER = JSON.parse(readFileSync(new URL('./support/v4-quoter.code.json', import.meta.url), 'utf8'));
/** An ERC-20's Transfer(address,address,uint256) topic (fix round 3.1: the fake deposit chain's router swaps emit it). */
const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
/** Two recognized EIP-7702 delegates' runtime code as read on Robinhood Chain (src/finance/delegates.ts). */
const DELEGATES = JSON.parse(readFileSync(new URL('./support/eip7702-delegates.code.json', import.meta.url), 'utf8'));

/**
 * A browser wallet on Robinhood Chain that is also the chain behind a published setup deployment, for Create position.
 * It connects and never signs in: personal_sign is outside its set, so a sign-in attempt would be refused and recorded
 * like any other stray method. It answers the reads the deployment is verified with, the gas price, the wallet's
 * balances, the token's allowance, the nonce, simulation and balance reads a step is prepared with, and the
 * transaction, receipt and block reads a sent step is followed by. Every transaction it is handed is included in its
 * own block, all of them finalized (with `finality: 'lagging'`, none: the finalized block stays behind them all, as an
 * L2's does behind L1), and its state moves as the contract's would: an approval sets the allowance,
 * `open` records the funded operation under the id it named and counts the owner's nonce up, `swap` exchanges part of
 * one side for the other inside the pool (DominoSetup.swap: the gross input leaves that side, the output joins the
 * other, once per operation), `mint` closes it with the NFT `tokenId`, `cancel` closes it with its balances refunded.
 * The wallet holds `eth` wei of ETH and `balances` of each ERC-20. The pool has a constant `liquidity` around the
 * stub's price and swaps as v4-core's swap math does (`swapAt`): a swap, simulated or sent, pays the deployment's
 * assisted fee on the gross input and the pool's 0.30% on the rest, and one that is sent moves the price its
 * StateView reports. A swap that would cross its price limit, or return less than its minimum, reverts, as the contract
 * does. `swapOutput` is what a size buys from the stub's first price. `seed` puts an operation on chain
 * before the page opens; `decline(name)` makes the wallet refuse, with 4001, the next transaction that calls `name`;
 * `revert(name)` includes it with status 0 and no effect.
 *
 * Added 2026-09-24, for the check before a one-token deposit: its StateView also answers getLiquidity (the constant
 * `liquidity`, which may be 0n: nothing in range) and slot0's `protocolFee`; its latest block carries the time; and
 * Uniswap's V4Quoter sits at the pinned address with its real code, answering poolManager() with this deployment's
 * PoolManager and quoteExactInputSingle with the same swap maths on the net amount (no assisted fee), or reverting
 * NotEnoughLiquidity, wrapped as V4Quoter wraps it, when nothing is in range. Every quoter question is kept in
 * `quoted`, with the block tag it was asked at (never in `quotes`, which counts the setup contract's own simulations);
 * eth_blockNumber answers the newest block's number. A call the contract refuses —
 * a partial fill, a short output — answers as a node does, code 3 with its revert data, and is kept in `reverts`.
 *
 * Added (review, 2026-09-24): `liquidFrom`, a square-root price above the stub's where the pool's `liquidity` starts:
 * below it nothing is in range, so getLiquidity reports 0 at the stub's price, a swap that raises the price crosses the
 * empty stretch for nothing in and nothing out and fills above it (as v4-core crosses empty ticks), and one that lowers
 * it finds nothing. `quoteDelayMs`: how long each quoter question takes to answer, as a slow wallet's does.
 *
 * Added 2026-09-28 (one-sided, review): after `moveOnOpen(price)`, an `open` included leaves the pool's square-root
 * price there, as if another trader's swap moved it between the deposit and the mint.
 *
 * Added in fix round 3 (2026-10-01): `keptBlocks`, the old state the node keeps, as the chain's RPC keeps about 2,000
 * blocks and publicnode none: a nonce read at a height more than `keptBlocks` blocks under the newest one is refused
 * ('missing trie node', kept in `pruned`), where it used to answer at any height like an archive node. `mine(n)` adds n
 * blocks with nothing of this wallet's, so a replacement grows old. A router swap included takes its input through
 * Permit2, as Uniswap's router does: the token's allowance to Permit2 and Permit2's allowance to the router go down by
 * it. `holdInWallet(name)`: the wallet takes the next send that calls `name` and gives its hash, but mines nothing yet;
 * `cancelHeld()` is the person cancelling it later. A send both sped up and `revert`ed is included reverted.
 *
 * Added in fix round 3.1 (2026-10-01): eth_getLogs answers the ERC-20 Transfer logs of each router swap included (its input
 * from the owner, its output to the owner), refused past the chain RPC's limits (tests/support/log-limits.mjs), or not at
 * all with `logs: false` (a wallet's RPC that does not serve logs). `later(s)`: the newest block's time runs `s` seconds
 * ahead (an allowance's expiry passed). `stallInWallet(name)`: the wallet never answers the next send that calls `name`
 * (a reload while it shows it, or a signer slower than the page waits); `approveStalled()` is the person approving it
 * later: it is mined at the nonce the page prepared, and the page never hears its hash.
 *
 * Added in fix round 3.2 (2026-10-02): `profile(name)` makes the wallet's RPC answer as one measured on the chain
 * (config/chainRobinhood.ts): 'drpc' refuses state at any numbered block, the head included ("Unknown state"), and logs
 * spanning over 200 blocks; 'publicnode' refuses logs from further than 100 blocks under the head (its state depth is
 * `keptBlocks`). `burnNonce()`: another transaction of the wallet's, shaped as a Cancel (0 ETH to itself), takes the next
 * nonce in the newest block. `setPermit(token, amount, expiration)`: the router's Permit2 allowance set otherwise (the
 * Uniswap app); `lockdown(token)`: Permit2's lockdown, its amount to 0 with the same expiry (a revoke tool).
 */
function fakeDepositChain(owner, { tokenId = 4242n, balances = {}, eth = 10n ** 18n, liquidity = 5n * 10n ** 17n, liquidFrom = null, protocolFee = 0, clockSkew = 0, finality = 'final', quoteDelayMs = 0, ownerCode = '0x', delegateCode = null, atomic = null, capabilities = null, batchError = null, simulation = 'ok', routed = false, keptBlocks = null, logs = true } = {}) {
  const at = (byte, bytes = 20) => `0x${byte.toString(16).padStart(2, '0').repeat(bytes)}`;
  const setup = at(0x71), poolManager = at(0x72), positionManager = at(0x73), stateView = at(0x74), feeRecipient = routed ? ROUTE_FEE_RECIPIENT : at(0x75);
  const code = { [setup]: '0x6071', [poolManager]: '0x6072', [positionManager]: '0x6073', [stateView]: '0x6074', [QUOTER.address]: QUOTER.code };
  const deployment = { setup, setupCodeHash: keccak256(code[setup]), poolManager, positionManager, stateView, poolManagerCodeHash: keccak256(code[poolManager]),
    positionManagerCodeHash: keccak256(code[positionManager]), stateViewCodeHash: keccak256(code[stateView]), feeRecipient, feeBps: routed ? 65 : 30, tariffVersion: '1', expiresAt: Math.floor(Date.now() / 1000) + 86_400 };
  if (routed) { code[ROUTE_PERMIT2] = '0x6001'; code[UNIVERSAL_ROUTER] = '0x6002'; }
  const routeAllowances = new Map(), permits = new Map(), routerOutputs = new Map();
  const FINALIZED = { number: finality === 'lagging' ? '0x1' : '0x100', hash: at(0xbf, 32) };
  const lower = value => String(value).toLowerCase();
  // The owner's own code: none, a plain EOA, or an EIP-7702 designator whose delegate answers `delegateCode`.
  if (ownerCode !== '0x') code[lower(owner)] = ownerCode;
  if (delegateCode !== null) code[`0x${ownerCode.slice(8)}`] = delegateCode;
  const operationId = nonce => keccak256(encodeAbiParameters(parseAbiParameters('uint256,address,address,uint64'), [4663n, setup, owner, nonce]));
  const NONE = { owner: zeroAddress, key: { currency0: zeroAddress, currency1: zeroAddress, fee: 0, tickSpacing: 0, hooks: zeroAddress }, balance0: 0n, balance1: 0n, swapped: false, closed: false, tokenId: 0n };
  const operations = new Map(), allowances = new Map(), held = new Map(Object.entries(balances).map(([token, amount]) => [lower(token), amount]));
  const log = [], refused = [], missing = [], sends = [], viewed = [], declined = [], quotes = [], quoted = [], reverts = [];
  /** The pool's square-root price now: the stub's, until a swap is included. */
  let sqrtPrice = STUB_SQRT_PRICE;
  /** Where an `open` included leaves the pool's price (moveOnOpen), or null: where it was. */
  let priceOnOpen = null;
  /** What is in range at square-root price `price`: the pool's `liquidity`, or nothing below `liquidFrom`. */
  const liquidityAt = price => (liquidFrom !== null && price < liquidFrom ? 0n : liquidity);
  /**
   * What `gross` swapped from the square-root price `from` buys, and the price it leaves: the assisted fee off the
   * gross, the pool's 0.30% off the rest, then v4-core's SqrtPriceMath along the constant liquidity, rounded as it is.
   * `feeBps` 0 is the pool alone, as V4Quoter quotes a net amount.
   */
  const swapAt = (gross, zeroForOne, from = sqrtPrice, feeBps = deployment.feeBps) => {
    const net = gross - (gross * BigInt(feeBps)) / 10000n;
    const curve = (net * 997n) / 1000n;
    // Null: the swap finds nothing in range to fill it.
    if (liquidity === 0n) return null;
    if (zeroForOne) {
      // Token 0 in lowers the price, never below `liquidFrom`: under it nothing is in range.
      if (liquidityAt(from) === 0n) return null;
      const after = (liquidity * Q96 * from + (liquidity * Q96 + curve * from) - 1n) / (liquidity * Q96 + curve * from);
      return liquidFrom !== null && after < liquidFrom ? null : [(liquidity * (from - after)) / Q96, after];
    }
    // Token 1 in raises the price: a stretch with nothing in range, below `liquidFrom`, is crossed for nothing in and
    // nothing out, as v4-core crosses empty ticks; the swap then runs along `liquidity` from there.
    const start = liquidityAt(from) === 0n ? liquidFrom : from;
    const after = start + (curve * Q96) / liquidity;
    return [(liquidity * Q96 * (after - start)) / after / start, after];
  };
  /** What `gross` buys from the stub's first price, the one each test's single swap starts from. */
  const swapOutput = (gross, zeroForOne) => swapAt(gross, zeroForOne, STUB_SQRT_PRICE)?.[0];
  /** A refusal by the contract, answered as a node answers one: code 3 with the revert data (InvalidSetup() unless said). */
  const reverting = (why, data = '0x30070737') => Object.assign(new Error(`execution reverted: ${why}`), { revertData: data });
  /** DominoSetup.swap's own checks, then its output and the price it leaves; a partial or short fill reverts. */
  const swapped = plan => {
    const op = operations.get(plan.operationId);
    if (!op || op.closed || op.swapped || plan.grossInput === 0n || plan.minOutput === 0n || plan.grossInput > (plan.zeroForOne ? op.balance0 : op.balance1)) throw reverting('InvalidSetup()');
    if (plan.zeroForOne ? plan.sqrtPriceLimitX96 >= sqrtPrice : plan.sqrtPriceLimitX96 <= sqrtPrice) throw reverting('price limit on the wrong side');
    const filled = swapAt(plan.grossInput, plan.zeroForOne);
    if (!filled) throw reverting('nothing in range: the swap consumes nothing');
    const [output, after] = filled;
    if (plan.zeroForOne ? after < plan.sqrtPriceLimitX96 : after > plan.sqrtPriceLimitX96) throw reverting('a partial fill');
    if (output < plan.minOutput) throw reverting('InvalidSetup()');
    return [output, after];
  };
  /** V4Quoter's NotEnoughLiquidity(poolId), wrapped as it wraps every failure: UnexpectedRevertBytes(bytes). */
  const notEnoughLiquidity = key => concatHex(['0x6190b2b0', encodeAbiParameters(parseAbiParameters('bytes'), [concatHex(['0x7a5ed734',
    keccak256(encodeAbiParameters(parseAbiParameters('(address,address,uint24,int24,address)'), [[key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]]))])])]);
  const refuse = new Set(), toRevert = new Set(), reverted = new Set();
  let permitted = false;
  // 2026-10-01 (audit C1): the wallet's own network, Robinhood Chain unless a test moves it, the networks it knows, a
  // switch or an add the person refuses once, and every network it was asked to add.
  let walletChainId = 4663, refuseNetwork = null;
  const knownChains = new Set([4663]), added = [];
  // 2026-10-01 (audit C2): sends the wallet answers with an error that proves nothing either way, sending nothing.
  const lose = new Set(), lost = [];
  // 2026-10-01 (audit C14): sends the person replaces in the wallet. "Speed up": the same call included under another
  // hash than the one the page was given. "Cancel": a 0-ETH transfer to the account itself takes the nonce, and the
  // call never happens (`burned` nonces, beside `sends`).
  const speedUp = new Set(), cancelInWallet = new Set();
  let burned = 0;
  // Fix round 2 (2026-10-01): each cancel as the chain has it, in the block the next send would be in (`at`), so the
  // nonce read at a block height and that block's transactions tell it from a sped-up send, as on a real chain.
  const cancels = [];
  // Fix round 3 (2026-10-01): blocks with nothing of this wallet's (`mine`), the block each send is in (`minedAt`), the
  // newest block (`head`, where the next send goes, as before), the heights a pruned nonce read was refused at, and the
  // sends the wallet holds unmined (`holdInWallet`).
  let idle = 0;
  const minedAt = [], pruned = [], waiting = [], hold = new Set();
  // Fix round 3.1: the newest block's time ahead by `later` seconds; sends the wallet never answers (`stallInWallet`).
  let later = 0;
  const stall = new Set(), stalled = [];
  // Fix round 3.2: the wallet RPC's profile (null: the chain's own, as before).
  let rpcProfile = null;
  const head = () => sends.length + idle;
  /** Includes `tx` in the newest block: its index among the sends. */
  const mineSend = tx => { const index = sends.length; minedAt.push(head()); sends.push(tx); return index; };
  const blockOf = index => ({ number: numberToHex(0x10 + index), hash: at(0xb0 + index, 32) });
  const hashOf = index => at(0xc0 + index, 32);
  const decode = tx => decodeFunctionData({ abi: lower(tx.to) === setup ? setupChainAbi : routed && lower(tx.to) === ROUTE_PERMIT2 ? routePermitAbi : routed && lower(tx.to) === UNIVERSAL_ROUTER ? routeExecuteAbi : erc20Abi, data: tx.data });
  function view(to, data, tag) {
    if (routed && to === ROUTE_PERMIT2) {
      const { functionName, args } = decodeFunctionData({ abi: routePermitAbi, data });
      if (functionName === 'allowance') return encodeFunctionResult({ abi: routePermitAbi, functionName, result: [...(permits.get(lower(args[1])) ?? [0n, 0]), 0] });
      return '0x';
    }
    if (routed && to === UNIVERSAL_ROUTER) return '0x';
    // The one-wei payment to the owner's own account that an account with code is probed with (finance/setup.ts
    // acceptsNativeEth): this account's code accepts it.
    if (to === lower(owner) && ownerCode !== '0x' && !data) { viewed.push('native_probe'); return '0x'; }
    if (to === stateView) {
      const { functionName } = decodeFunctionData({ abi: stateViewAbi, data });
      viewed.push(functionName);
      if (functionName === 'getSlot0') return encodeFunctionResult({ abi: stateViewAbi, functionName, result: [sqrtPrice, 0, protocolFee, 3000] });
      if (functionName === 'getLiquidity') return encodeFunctionResult({ abi: stateViewAbi, functionName, result: liquidityAt(sqrtPrice) });
      throw new Error(`unexpected ${functionName} on the state view`);
    }
    if (to === QUOTER.address) {
      const { functionName, args } = decodeFunctionData({ abi: quoterChainAbi, data });
      viewed.push(functionName);
      if (functionName === 'poolManager') return encodeFunctionResult({ abi: quoterChainAbi, functionName, result: poolManager });
      const [{ poolKey, zeroForOne, exactAmount, hookData }] = args;
      quoted.push({ exactAmount, zeroForOne, sent: sends.length, tag });
      if (JSON.stringify(lowerKey(poolKey), (_, v) => (typeof v === 'bigint' ? String(v) : v)) !== JSON.stringify(STUB_POOL_KEY) || hookData !== '0x') throw new Error('a quote for another pool');
      // The pool alone, on the net amount: no assisted fee (the setup contract takes it off the gross first).
      const filled = swapAt(exactAmount, zeroForOne, sqrtPrice, 0);
      if (!filled) throw reverting('NotEnoughLiquidity', notEnoughLiquidity(poolKey));
      return encodeFunctionResult({ abi: quoterChainAbi, functionName, result: [filled[0], 120_000n] });
    }
    if (to === setup) {
      const { functionName, args = [] } = decodeFunctionData({ abi: setupChainAbi, data });
      viewed.push(functionName);
      const answers = { manager: poolManager, positions: positionManager, stateView, feeRecipient, assistedFeeBps: deployment.feeBps, tariffVersion: 1n, ownerNonce: BigInt(operations.size),
        nextOperationId: operationId(BigInt(operations.size)), operation: operations.get(args[0]) ?? NONE, recoveryStarted: false };
      if (functionName in answers) return encodeFunctionResult({ abi: setupChainAbi, functionName, result: answers[functionName] });
      if (functionName === 'swap') {
        const [output] = swapped(args[0]);
        // A quote is the swap simulated with a minimum of one unit (finance/setup.ts quoteSwap and swap's own simulation).
        if (args[0].minOutput === 1n) quotes.push(args[0]);
        return encodeFunctionResult({ abi: setupChainAbi, functionName, result: output });
      }
      if (['open', 'mint', 'cancel'].includes(functionName)) return '0x';
      throw new Error(`unexpected ${functionName} on the setup contract`);
    }
    const { functionName, args } = decodeFunctionData({ abi: erc20Abi, data });
    viewed.push(functionName);
    if (functionName === 'allowance') return encodeFunctionResult({ abi: erc20Abi, functionName, result: lower(args[1]) === setup ? allowances.get(to) ?? 0n : routed && lower(args[1]) === ROUTE_PERMIT2 ? routeAllowances.get(to) ?? 0n : 0n });
    if (functionName === 'approve') return encodeFunctionResult({ abi: erc20Abi, functionName, result: true });
    if (functionName === 'balanceOf') return encodeFunctionResult({ abi: erc20Abi, functionName, result: lower(args[0]) === lower(owner) ? held.get(to) ?? 0n : 0n });
    throw new Error(`unexpected ${functionName} on ${to}`);
  }
  /**
   * A batch (EIP-5792), as a wallet that executes it atomically does: `atomic` is what the wallet says of chain 4663
   * (`supported`, `ready`, or nothing), `batchError` its answer to the first batch it is offered (a refusal such as
   * 5750 or 5760), `simulation` whether it carries eth_simulateV1. `capabilities`, when given, is the wallet's whole
   * answer to wallet_getCapabilities instead, as `{ result }` or `{ error }` (2026-09-28: the keys other wallets write,
   * and Rabby's -32601); `atomic` still says what its batches do. Each call is checked as the setup contract checks it
   * (the operation id the owner opens next, the allowance, the ETH carried, the swap's own limits) and applied in turn;
   * one that fails undoes them all.
   */
  const batches = [];
  let capability = atomic, refuseBatch = batchError;
  function check(tx) {
    if (routed && lower(tx.to) === UNIVERSAL_ROUTER) {
      const p = routerOutputs.get(tx.data);
      if (!p) throw reverting('unregistered route');
      const input = p.request.tokenIn, gross = BigInt(p.request.amountRaw);
      if (BigInt(tx.value ?? '0x0') !== (input === zeroAddress ? gross : 0n)) throw reverting('router native value');
      if (input !== zeroAddress && ((routeAllowances.get(input) ?? 0n) < gross || (permits.get(input)?.[0] ?? 0n) < gross)) throw reverting('router allowance');
      return;
    }
    if (lower(tx.to) !== setup) return;
    const { functionName, args } = decode(tx);
    if (functionName === 'open') {
      const [id, key, amount0, amount1] = args;
      if (id !== operationId(BigInt(operations.size)) || BigInt(tx.value ?? '0x0') !== (key.currency0 === zeroAddress ? amount0 : 0n)) throw reverting('InvalidSetup()');
      for (const [currency, amount] of [[key.currency0, amount0], [key.currency1, amount1]]) {
        if (currency !== zeroAddress && amount > 0n && (allowances.get(lower(currency)) ?? 0n) < amount) throw reverting('the allowance is short');
      }
    }
    if (functionName === 'swap') swapped(args[0]);
    if (functionName === 'mint' && (operations.get(args[0].operationId)?.closed ?? true)) throw reverting('InvalidSetup()');
  }
  function atomically(calls, keep) {
    const saved = { allowances: new Map(allowances), routeAllowances: new Map(routeAllowances), permits: new Map(permits), held: new Map(held), eth, operations: new Map(operations), sqrtPrice };
    const results = [];
    for (const call of calls) {
      if (results.some(result => result.status === '0x0')) { results.push({ status: '0x0', gasUsed: '0x0' }); continue; }
      try {
        const tx = { from: owner, to: call.to, data: call.data, value: call.value };
        check(tx);
        include(tx);
        results.push({ status: '0x1', gasUsed: '0x30d40' });
      } catch {
        results.push({ status: '0x0', gasUsed: '0x0' });
      }
    }
    if (!keep || results.some(result => result.status === '0x0')) {
      allowances.clear(); saved.allowances.forEach((value, key) => allowances.set(key, value));
      routeAllowances.clear(); saved.routeAllowances.forEach((value, key) => routeAllowances.set(key, value));
      permits.clear(); saved.permits.forEach((value, key) => permits.set(key, value));
      held.clear(); saved.held.forEach((value, key) => held.set(key, value)); eth = saved.eth;
      operations.clear(); saved.operations.forEach((value, key) => operations.set(key, value));
      sqrtPrice = saved.sqrtPrice;
    }
    return results;
  }
  /** What the contracts make of a transaction once it is included. */
  function include(tx) {
    const { functionName, args } = decode(tx);
    if (routed && lower(tx.to) === ROUTE_PERMIT2) { permits.set(lower(args[0]), [args[2], args[3]]); return; }
    if (routed && lower(tx.to) === UNIVERSAL_ROUTER) {
      check(tx);
      const p = routerOutputs.get(tx.data), gross = BigInt(p.request.amountRaw), output = BigInt(p.uniswap.amountOutRaw);
      if (p.request.tokenIn === zeroAddress) eth -= gross;
      else {
        held.set(p.request.tokenIn, (held.get(p.request.tokenIn) ?? 0n) - gross);
        // Fix round 3: the input goes through Permit2, as Uniswap's router takes it: both allowances go down by it.
        routeAllowances.set(p.request.tokenIn, (routeAllowances.get(p.request.tokenIn) ?? 0n) - gross);
        const [amount, expiration] = permits.get(p.request.tokenIn);
        permits.set(p.request.tokenIn, [amount - gross, expiration]);
      }
      if (p.tokenOut === zeroAddress) eth += output; else held.set(p.tokenOut, (held.get(p.tokenOut) ?? 0n) + output);
      return;
    }
    if (lower(tx.to) !== setup) {
      if (functionName === 'approve' && lower(args[0]) === setup) allowances.set(lower(tx.to), args[1]);
      if (routed && functionName === 'approve' && lower(args[0]) === ROUTE_PERMIT2) routeAllowances.set(lower(tx.to), args[1]);
      return;
    }
    if (functionName === 'open') {
      operations.set(args[0], { owner, key: args[1], balance0: args[2], balance1: args[3], swapped: false, closed: false, tokenId: 0n });
      if (priceOnOpen !== null) sqrtPrice = priceOnOpen;
    }
    if (functionName === 'swap') {
      const plan = args[0], op = operations.get(plan.operationId), [output, after] = swapped(plan);
      sqrtPrice = after;
      operations.set(plan.operationId, { ...op, swapped: true,
        balance0: plan.zeroForOne ? op.balance0 - plan.grossInput : op.balance0 + output,
        balance1: plan.zeroForOne ? op.balance1 + output : op.balance1 - plan.grossInput });
    }
    if (functionName === 'mint') operations.set(args[0].operationId, { ...operations.get(args[0].operationId), balance0: 0n, balance1: 0n, closed: true, tokenId });
    if (functionName === 'cancel') operations.set(args[0], { ...operations.get(args[0]), balance0: 0n, balance1: 0n, closed: true });
  }
  async function request(method, params) {
    log.push(method);
    try {
      switch (method) {
        case 'personal_sign':
          if (routed) return { result: await ACCOUNTS[0].signMessage({ message: { raw: params[0] } }) };
          break;
        case 'eth_requestAccounts': permitted = true; return { result: [owner] };
        case 'wallet_requestPermissions': permitted = true; return { result: [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [owner] }] }] };
        case 'wallet_revokePermissions': permitted = false; return { result: null };
        case 'eth_accounts': return { result: permitted ? [owner] : [] };
        case 'eth_chainId': return { result: numberToHex(walletChainId) };
        case 'wallet_switchEthereumChain': {
          if (refuseNetwork === 'switch') { refuseNetwork = null; return { error: { code: 4001, message: 'User rejected the request.' } }; }
          const target = Number(BigInt(params[0].chainId));
          if (!knownChains.has(target)) return { error: { code: 4902, message: `Unrecognized chain ID "${params[0].chainId}". Try adding the chain using wallet_addEthereumChain first.` } };
          walletChainId = target;
          return { result: null };
        }
        case 'wallet_addEthereumChain': {
          added.push(params[0]);
          if (refuseNetwork === 'add') { refuseNetwork = null; return { error: { code: 4001, message: 'User rejected the request.' } }; }
          // As MetaMask does: the network is added, and the wallet switches to it.
          walletChainId = Number(BigInt(params[0].chainId));
          knownChains.add(walletChainId);
          return { result: null };
        }
        case 'eth_getCode': return { result: code[lower(params[0])] ?? '0x' };
        case 'wallet_getCapabilities':
          if (capabilities) return capabilities;
          return { result: capability ? { '0x1237': { atomic: { status: capability } } } : {} };
        case 'eth_simulateV1': {
          if (simulation !== 'ok') return { error: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } };
          return { result: [{ calls: atomically(params[0].blockStateCalls[0].calls, false) }] };
        }
        case 'wallet_sendCalls': {
          if (refuseBatch) { const error = refuseBatch; refuseBatch = null; return { error }; }
          const [{ version, chainId, from, atomicRequired, calls }] = params;
          const results = atomically(calls, true);
          const done = results.every(result => result.status === '0x1');
          const id = `0x${(0xba7c0 + batches.length).toString(16)}`;
          batches.push({ id, version, chainId, from, atomicRequired, calls, status: done ? 200 : 500 });
          // A wallet that was ready has now turned on its smart account.
          if (done && capability === 'ready') capability = 'supported';
          return { result: { id } };
        }
        case 'wallet_getCallsStatus': {
          const batch = batches.find(entry => entry.id === params[0]);
          if (!batch) return { error: { code: 5730, message: 'Unknown bundle id' } };
          return { result: { version: '2.0.0', id: batch.id, chainId: '0x1237', status: batch.status, atomic: true, receipts: [] } };
        }
        case 'eth_gasPrice': return { result: '0x5f5e100' };
        case 'eth_getTransactionCount': {
          // At a block height (fix round 2): the sends in the blocks up to it, and the cancels among them.
          if (!/^0x[0-9a-f]+$/i.test(params[1] ?? '')) return { result: numberToHex(sends.length + burned) };
          if (rpcProfile === 'drpc') return { error: { code: -32000, message: 'Unknown state' } };
          const upTo = Number(BigInt(params[1])) - 0x10;
          // State the node no longer keeps (fix round 3), refused as a pruned node refuses it.
          if (keptBlocks !== null && upTo < head() - keptBlocks) { pruned.push(upTo); return { error: { code: -32000, message: 'missing trie node' } }; }
          return { result: numberToHex(minedAt.filter(block => block <= upTo).length + cancels.filter(entry => entry.at <= upTo).length) };
        }
        case 'eth_estimateGas': return { result: '0x186a0' };
        case 'eth_getBalance': return { result: numberToHex(eth) };
        case 'eth_call':
          // A slow wallet: each quoter question takes `quoteDelayMs` to answer.
          if (quoteDelayMs > 0 && lower(params[0].to) === QUOTER.address) await new Promise(resolve => setTimeout(resolve, quoteDelayMs));
          if (rpcProfile === 'drpc' && params[1] !== 'latest') return { error: { code: -32000, message: 'Unknown state' } };
          return { result: view(lower(params[0].to), params[0].data, params[1]) };
        // The newest block's number, as eth_getBlockByNumber('latest') has it.
        case 'eth_blockNumber': return { result: blockOf(head()).number };
        case 'eth_sendTransaction': {
          const { functionName } = decode(params[0]);
          if (refuse.delete(functionName)) { declined.push(functionName); return { error: { code: 4001, message: 'User rejected the request.' } }; }
          if (lose.delete(functionName)) { lost.push(functionName); return { error: { code: -32603, message: 'Internal JSON-RPC error.' } }; }
          if (cancelInWallet.delete(functionName)) {
            burned += 1;
            cancels.push({ at: head(), tx: { hash: at(0xf0 + burned, 32), from: owner, to: owner, input: '0x', value: '0x0', nonce: params[0].nonce } });
            return { result: at(0xd0 + burned, 32) };
          }
          // Held in the wallet, unmined (fix round 3): what the person does with it comes later (cancelHeld).
          if (hold.delete(functionName)) { waiting.push(params[0]); return { result: at(0xa0 + waiting.length, 32) }; }
          // Never answered (fix round 3.1): what the person does with it comes later (approveStalled).
          if (stall.delete(functionName)) { stalled.push(params[0]); return new Promise(() => {}); }
          // A speed-up that reverts (fix round 3): included under the other hash, with status 0 and no effect.
          if (speedUp.delete(functionName)) {
            const index = mineSend(params[0]);
            if (toRevert.delete(functionName)) reverted.add(index); else include(params[0]);
            return { result: at(0xe0 + index, 32) };
          }
          const index = mineSend(params[0]);
          if (toRevert.delete(functionName)) reverted.add(index); else include(params[0]);
          return { result: hashOf(index) };
        }
        case 'eth_getLogs': {
          // Fix round 3.1: the Transfer logs of the router swaps included, as an ERC-20 emits them.
          if (!logs) return { error: { code: -32601, message: 'the method eth_getLogs does not exist/is not available' } };
          const filter = params[0], refusal = logLimitError(filter);
          if (refusal) return { error: refusal };
          const from = Number(BigInt(filter.fromBlock)), to = Number(BigInt(filter.toBlock));
          if (rpcProfile === 'drpc' && to - from > 200) return { error: { code: 35, message: 'ranges over 10000 blocks are not supported on free plan' } };
          if (rpcProfile === 'publicnode' && from < 0x10 + head() - 100) return { error: { code: -32000, message: 'Archive requests require a personal token' } };
          const fits = (value, wanted) => wanted === null || wanted === undefined || (Array.isArray(wanted) ? wanted.map(lower).includes(value) : lower(wanted) === value);
          const found = [];
          sends.forEach((tx, i) => {
            if (!routed || lower(tx.to) !== UNIVERSAL_ROUTER || reverted.has(i)) return;
            const number = 0x10 + minedAt[i], p = routerOutputs.get(tx.data);
            if (number < from || number > to || !p) return;
            const transfers = [[p.request.tokenIn, owner, poolManager], [p.tokenOut, poolManager, owner]].filter(([token]) => token !== zeroAddress);
            for (const [token, source, target] of transfers) {
              const log = { address: lower(token), topics: [TRANSFER_TOPIC, pad(lower(source)), pad(lower(target))], data: '0x', blockNumber: numberToHex(number), transactionHash: hashOf(i), logIndex: '0x0' };
              if (fits(log.address, filter.address) && (filter.topics ?? []).every((wanted, place) => fits(log.topics[place], wanted))) found.push(log);
            }
          });
          return { result: found };
        }
        case 'eth_getTransactionByHash': case 'eth_getTransactionReceipt': {
          const index = sends.findIndex((_, i) => hashOf(i) === lower(params[0]));
          if (index === -1) return { result: null };
          const sent = sends[index], block = { blockHash: blockOf(minedAt[index]).hash, blockNumber: blockOf(minedAt[index]).number };
          return { result: method === 'eth_getTransactionByHash'
            ? { hash: hashOf(index), from: sent.from, to: sent.to, input: sent.data, value: sent.value, nonce: sent.nonce, chainId: sent.chainId, type: sent.type, gas: sent.gas, maxFeePerGas: sent.maxFeePerGas, maxPriorityFeePerGas: sent.maxPriorityFeePerGas, ...block }
            : { transactionHash: hashOf(index), from: sent.from, to: sent.to, status: reverted.has(index) ? '0x0' : '0x1', gasUsed: '0xc350', effectiveGasPrice: sent.maxFeePerGas, ...block } };
        }
        case 'eth_getBlockByNumber': {
          if (params[0] === 'finalized') return { result: FINALIZED };
          // The newest block, at this machine's time (`clockSkew` seconds on): the chain's clock, which Create position compares its own with.
          if (params[0] === 'latest') return { result: { ...blockOf(head()), timestamp: numberToHex(Math.floor(Date.now() / 1000) + clockSkew + later) } };
          const index = Number(BigInt(params[0])) - 0x10;
          const cancelled = cancels.filter(entry => entry.at === index).map(entry => entry.tx);
          const sentHere = sends.map((_, i) => i).filter(i => minedAt[i] === index);
          // Bodies are never pruned (fix round 3: only state is); the newest block, empty, is not there yet.
          if (index < 0 || index > head() || (index === head() && !cancelled.length && !sentHere.length)) return { result: null };
          // With its transactions when asked for them (fix round 2): a cancel first, then the send of that block.
          const mined = sentHere.map(i => ({ hash: hashOf(i), from: sends[i].from, to: sends[i].to, input: sends[i].data, value: sends[i].value, nonce: sends[i].nonce }));
          return { result: params[1] === true ? { ...blockOf(index), transactions: [...cancelled, ...mined] } : blockOf(index) };
        }
      }
    } catch (error) {
      if (error.revertData) {
        reverts.push(error.message);
        return { error: { code: 3, message: 'execution reverted', data: error.revertData } };
      }
      missing.push(String(error));
      return { error: { code: -32000, message: String(error) } };
    }
    refused.push(method);
    return { error: { code: 4200, message: `${method} is not supported` } };
  }
  return {
    log, refused, missing, sends, viewed, declined, quotes, quoted, reverts, request, operationId, tokenId, operations, swapOutput, batches,
    registerRoute(preview) { if (preview.uniswap?.swapTransaction) routerOutputs.set(preview.uniswap.swapTransaction.data, preview); },
    /** Test-only capability change across a reload; pending offers must still be recovered before changing paths. */
    setAtomic(status) { capability = status; },
    /** A batch's call decoded against the contract it goes to. */
    decodeCall: call => decode({ to: call.to, data: call.data }),
    /** A batch simulated on this chain as the chain's RPC would (eth_simulateV1's calls), changing nothing. */
    simulate: calls => atomically(calls, false), price: () => sqrtPrice, release: { contractVersion: '1.0.0-rc.1', chainId: 4663, available: true, deployment },
    /** Where `amount` swapped from the stub's first price leaves the pool's square-root price: through the setup contract (its fee off the gross), or, with `feeBps` 0, a net amount as V4Quoter quotes it. */
    priceAfter: (amount, zeroForOne, feeBps = deployment.feeBps) => swapAt(amount, zeroForOne, STUB_SQRT_PRICE, feeBps)?.[1],
    /** What is in range at a square-root price (`liquidFrom`). */
    liquidityAt,
    /** What the wallet holds: its ETH, and its balance of an ERC-20. */
    eth, balanceOf: token => held.get(lower(token)) ?? 0n,
    /** An operation of this owner already on chain, under the owner's next id. */
    seed(operation) { const id = operationId(BigInt(operations.size)); operations.set(id, { owner, swapped: false, closed: false, tokenId: 0n, ...operation }); return id; },
    decline(functionName) { refuse.add(functionName); },
    /** The wallet answers this send once with an error that proves nothing either way (-32603), and sends nothing. */
    lose(functionName) { lose.add(functionName); },
    /** The person speeds this send up in the wallet: it is included, under another hash than the page was given. */
    speedUp(functionName) { speedUp.add(functionName); },
    /** The person cancels this send in the wallet: a 0-ETH transfer to the account takes its nonce, and it never happens. */
    cancelInWallet(functionName) { cancelInWallet.add(functionName); },
    /** Fix round 3: `n` blocks with nothing of this wallet's; the heights a nonce read was refused at (`keptBlocks`). */
    mine(n) { idle += n; }, pruned,
    /** Fix round 3: the wallet gives a hash for the next send that calls `functionName` and mines nothing yet. */
    holdInWallet(functionName) { hold.add(functionName); },
    /** Fix round 3: the person cancels the send the wallet holds: a 0-ETH transfer to the account takes its nonce, in the newest block. */
    cancelHeld() {
      const tx = waiting.shift();
      burned += 1;
      cancels.push({ at: head(), tx: { hash: at(0xf0 + burned, 32), from: owner, to: owner, input: '0x', value: '0x0', nonce: tx.nonce } });
    },
    /** Fix round 3.1: the newest block's time runs `seconds` ahead of this machine's clock (0: as it is). */
    later(seconds) { later = seconds; },
    /** Fix round 3.1: the wallet never answers the next send that calls `functionName`. */
    stallInWallet(functionName) { stall.add(functionName); },
    /** Fix round 3.1: the person approves the send the wallet never answered: it is mined, at the nonce the page prepared. */
    approveStalled() { const tx = stalled.shift(); mineSend(tx); include(tx); }, stalled,
    /** Fix round 3.2: the wallet's RPC answers as dRPC or publicnode does from now on (null: the chain's own). */
    profile(name) { rpcProfile = name; },
    /** Fix round 3.2: another transaction of the wallet's, shaped as a Cancel, takes the next nonce in the newest block. */
    burnNonce() {
      const nonce = numberToHex(sends.length + burned);
      burned += 1;
      cancels.push({ at: head(), tx: { hash: at(0xf0 + burned, 32), from: owner, to: owner, input: '0x', value: '0x0', nonce } });
    },
    /** Fix round 3.2: the router's Permit2 allowance for `token` set otherwise (the Uniswap app). */
    setPermit(token, amount, expiration) { permits.set(lower(token), [amount, expiration]); },
    /** Fix round 3.2: Permit2's lockdown of the router for `token`: its amount to 0, its expiry kept. */
    lockdown(token) { const [, expiration] = permits.get(lower(token)); permits.set(lower(token), [0n, expiration]); },
    /** Fix round 3: Permit2's allowance to the router for `token`, as [amount, expiration], or undefined. */
    permitOf: token => permits.get(lower(token)),
    lost,
    /** The wallet moves to another network (the page hears it through installDepositWallet's emit); `forget` drops Robinhood Chain from it. */
    moveWallet(chainId, { forget = false } = {}) { walletChainId = chainId; knownChains.add(chainId); if (forget) knownChains.delete(4663); },
    /** The person refuses the next network switch ('switch') or the next network add ('add') in the wallet. */
    refuseNetworkOnce(kind) { refuseNetwork = kind; },
    added, walletChain: () => walletChainId,
    moveOnOpen(price) { priceOnOpen = price; },
    revert(functionName) { toRevert.add(functionName); },
    /** Every transaction sent, decoded against the contract it went to. */
    decoded: () => sends.map(tx => ({ to: lower(tx.to), from: lower(tx.from), value: BigInt(tx.value), nonce: tx.nonce, ...decode(tx) })),
  };
}

/** The chain above announced as a browser wallet of its own (EIP-6963), beside the mock wallets, which stay untouched. */
async function installDepositWallet(context, chain) {
  await context.exposeFunction('__dominoDepositWallet', (method, params) => chain.request(method, params));
  await context.addInitScript(() => {
    // 2026-10-01 (audit C1): the wallet's events, as an EIP-1193 provider has them; a test says one with
    // window.__depositWalletEmit (a network the wallet moved to, as chainChanged's hex id).
    const listeners = new Map();
    const provider = {
      async request({ method, params }) {
        const reply = await window.__dominoDepositWallet(method, params ?? []);
        // A revert keeps its data, as a node's reply does: { code: 3, message: 'execution reverted', data }.
        if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code }, reply.error.data ? { data: reply.error.data } : {});
        return reply.result;
      },
      on(event, listener) { listeners.set(event, [...(listeners.get(event) ?? []), listener]); return provider; },
      removeListener(event, listener) { listeners.set(event, (listeners.get(event) ?? []).filter(other => other !== listener)); return provider; },
    };
    window.__depositWalletEmit = (event, value) => { for (const listener of listeners.get(event) ?? []) listener(value); };
    const detail = Object.freeze({ info: Object.freeze({ uuid: '8f2a7d1c-0000-4000-8000-0000000000d1', name: 'Deposit Wallet', icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E', rdns: 'test.wallet.deposit' }), provider });
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  });
}

/** The deployed StateView's price read: what Create position sizes the mint at. */
const stateViewAbi = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)', 'function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)']);
/** An amount with Review's default 0.5% slippage as room, rounded up: what the deposit takes of it (CreatePosition.tsx withRoom). */
const withRoom = amount => (amount * 10050n + 9999n) / 10000n;
/** The read stub's pool (support/read-stub.mjs), as the setup contract keys it: ETH against TOKEN, 0.30%, spacing 60, no hooks. */
const STUB_POOL_KEY = { currency0: zeroAddress, currency1: FIXTURE_TOKEN, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
/**
 * The standard range the read stub's pool price (tick 0) gives New position, in ticks, as Review states it. Changed on
 * purpose 2026-09-28 (one-sided): the app writes this pool's price as TOKEN's in ETH (lib/read/orientation.ts), and
 * Closer is 0.7× to 1.5× of that price, so the pool's ticks are the old ones negated and swapped (were -3600 to 4080).
 */
const STUB_RANGE = [-4080, 3600];
/** The read stub's pool price: tick 0. */
const STUB_SQRT_PRICE = 2n ** 96n;
/**
 * ETH for gas only beside 10,000,000,000 TOKEN typed at STUB_RANGE, which pairs with about 0.0089 ETH: 0.008 ETH.
 * Changed on purpose 2026-09-28 (one-sided): 0.01 ETH, while Closer (-3600 to 4080) paired that TOKEN with 0.0112 ETH.
 */
const GAS_ONLY_ETH = 8n * 10n ** 15n;
const Q96 = 2n ** 96n;
const lowerKey = key => ({ ...key, currency0: key.currency0.toLowerCase(), currency1: key.currency1.toLowerCase(), hooks: key.hooks.toLowerCase() });
/**
 * The public RPC for the chain above, as a position's page reads it (2026-09-25: the page reads the chain itself, since
 * the RPC rate-limits Cloudflare's edge; before, the fees relay's /state): the NFT the chain minted, once it exists,
 * this wallet's, in the stub's pool at the minted range and liquidity, the pool at tick 0; any other id unknown.
 */
const mintedChain = (chain) => {
  const rpc = browserChain({ tokens: { [FIXTURE_TOKEN.toLowerCase()]: { symbol: 'TOKEN', decimals: 6 } } });
  Object.defineProperty(rpc, 'positions', {
    get: () => {
      const minted = [...chain.operations.values()].find(op => op.closed && op.tokenId !== 0n);
      const mint = chain.decoded().find(tx => tx.functionName === 'mint');
      if (!minted || !mint) return [];
      const plan = mint.args[0];
      return [{ tokenId: String(minted.tokenId), holder: OWNER, key: lowerKey(STUB_POOL_KEY), tickLower: plan.tickLower, tickUpper: plan.tickUpper, liquidity: plan.liquidity, unclaimed: [0n, 0n] }];
    },
  });
  return rpc;
};
/**
 * The read gateway's wallet page for the chain above: the read fixture's (wallet-assets.last-page), holding what the
 * chain's wallet holds of ETH and TOKEN, so Review's plan and Create position read the same balances, as they do when
 * the read service and the wallet look at one chain.
 */
const walletAssets = (chain) => (route) => {
  if (route !== 'wallet-assets') return undefined;
  const base = readGateway('wallet-assets.last-page');
  const items = base.items.map(item => ({ ...item, amountRaw: String(item.address === zeroAddress ? chain.eth : chain.balanceOf(item.address)) }));
  return JSON.stringify({ ...base, items });
};
/** The first answer any of `answers` gives, for the read stub. */
const firstAnswer = (...answers) => (route, body) => answers.map(answer => answer?.(route, body)).find(reply => reply !== undefined);
/** Review's list of wallet steps as the page shows it: each step's key and live state (null before Create position runs). */
const walletStepStates = page => page.locator('[data-wallet-steps] li').evaluateAll(items => items.map(item => [item.getAttribute('data-wallet-step'), item.getAttribute('data-step-state')]));

/**
 * Changed on purpose (2026-09-24, the three features joined up): once the position exists, Review offers what comes
 * next in Create position's place instead of opening Positions on its own (components/create/CreatedNext.tsx): keep it
 * as a plain position and open it, or automate it with Auto-compound or Domino-compound, the position chosen. Waits
 * for that offer for `id`, checks its three ways, optionally keeps a picture of it, and takes the first.
 * Changed on purpose 2026-10-06 (the review of the next update): on the build that carries Domino V2 (V1's suites run on
 * wallet-test-v2, scripts/v1-on-v2.mjs), Auto-exit is offered beside them for a range that is not full, opening the
 * position's page (CreatedNext.tsx); no range made here is full. The build without V2 offers the three alone.
 */
async function openCreated(page, id, timeout = 60_000, shot = null) {
  const next = page.locator(`[data-created-position="${id}"]`);
  await next.waitFor({ timeout });
  assert.equal(await page.locator('[data-create-position]').innerText(), 'Position created');
  const v2 = WALLET_DIST === WALLET_V2_DIST;
  assert.deepEqual(await next.locator('a').evaluateAll((links) => links.map((a) => [a.getAttribute('data-created-next'), a.getAttribute('href')])), [
    ['plain', `/positions/${id}`],
    ['compound', `/sequence/compound/${id}`],
    ['domino', `/sequence/domino/${id}`],
    ...(v2 ? [['autoexit', `/positions/${id}`]] : []),
  ]);
  assert.match(await next.innerText(), new RegExp(`Position NFT ${id} is in your wallet\\.[\\s\\S]*Plain position[\\s\\S]*View position[\\s\\S]*Auto-compound · 2%[\\s\\S]*Domino-compound · 4%`));
  if (v2) assert.match(await next.locator('[data-created-next="autoexit"]').innerText(), /Auto-exit · 0\.2% of the position’s value, only if it closes[\s\S]*Closes it at the end of its range and sends the tokens to your wallet\.[\s\S]*Turn on/);
  assert.ok(!(await page.locator('[data-journey-footer] > button').first().isVisible()), 'Back rests once the position exists');
  if (shot) {
    await next.evaluate((element) => element.scrollIntoView({ block: 'end' }));
    await page.screenshot({ path: join(shots(), shot) });
  }
  await next.locator('[data-created-next="plain"]').click();
  await page.waitForFunction((want) => location.pathname + location.hash === `/positions/${want}`, id, { timeout: 10_000 });
}
/** Records every change of Review's wallet steps from now on, in `window.__walletStepLog`, as `key=state` lists. */
const recordWalletSteps = page => page.evaluate(() => {
  const log = (window.__walletStepLog = []);
  const record = () => {
    const now = [...document.querySelectorAll('[data-wallet-steps] li')].map(item => `${item.getAttribute('data-wallet-step')}=${item.getAttribute('data-step-state')}`).join(' ');
    if (now && log.at(-1) !== now) log.push(now);
  };
  new MutationObserver(record).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-step-state', 'data-wallet-step'] });
});
/**
 * 2026-09-28 (review): records every change of the line under Create position with Review's wallet steps at that
 * moment, in `window.__reasonLog`, as `line | key=state ...`, from now on.
 */
const recordReason = page => page.evaluate(() => {
  const log = (window.__reasonLog = []);
  const record = () => {
    const line = document.querySelector('#create-reason')?.textContent ?? '';
    const now = `${line} | ${[...document.querySelectorAll('[data-wallet-steps] li')].map(item => `${item.getAttribute('data-wallet-step')}=${item.getAttribute('data-step-state')}`).join(' ')}`;
    if (log.at(-1) !== now) log.push(now);
  };
  record();
  new MutationObserver(record).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['data-step-state', 'data-wallet-step'] });
});
/**
 * A press that went on step by step: while the wallet was asked a step of its own (an approval, the deposit, the swap
 * or the mint), the line said to confirm each step, never "one signature for every step". `steps`: the keys the wallet
 * was asked, in order (an approval as `approve`); `batchAsked`: whether the wallet was offered the batch first, and the
 * line said one signature while it was.
 */
async function saidEachStep(page, { batchAsked, steps }) {
  const log = await page.evaluate(() => window.__reasonLog);
  const asking = log.filter(entry => /(?:^| )(?:approve:\S+|fund|swap|mint)=wallet(?: |$)/.test(entry.split(' | ')[1]));
  const keys = [...new Set(asking.flatMap(entry => entry.split(' | ')[1].split(' ').filter(pair => pair.endsWith('=wallet')).map(pair => pair.split(/[:=]/)[0])))];
  assert.deepEqual(keys, steps, `the wallet was asked each step: ${log.join('\n')}`);
  assert.deepEqual(asking.filter(entry => !entry.startsWith('Confirm each step in your wallet. | ')), [], 'each step is said as its own');
  const batch = log.filter(entry => / batch=wallet(?: |$)/.test(` ${entry.split(' | ')[1]}`));
  assert.equal(batch.length > 0, batchAsked, `the batch was ${batchAsked ? '' : 'never '}offered: ${log.join('\n')}`);
  assert.ok(batch.every(entry => entry.startsWith('Confirm in your wallet: one signature for every step. | ')), 'one signature while the batch was offered');
}
/** The order in which the recorded steps turned done, each with what the others were at that moment. */
async function doneOrder(page) {
  const log = await page.evaluate(() => window.__walletStepLog);
  const order = [];
  for (const entry of log) {
    const states = Object.fromEntries(entry.split(' ').map(pair => pair.split('=')));
    for (const [key, state] of Object.entries(states)) if (state === 'done' && !order.some(done => done.key === key)) order.push({ key, states });
  }
  return { log, order };
}

/**
 * The wallet-test build at New position's Review with the chain above connected on Robinhood Chain and nothing more:
 * Sign in is offered and never pressed. The release the setup client verifies is the chain's own, and the read
 * service reports the chain wallet's balances. Resolves once Create position's lazily loaded control is in
 * (StageReview.tsx FinalControl). `answer` goes to the read stub; `amount` is the TOKEN amount typed; `routes` are
 * more same-origin endpoints for the wallet-server, asked before the read stub. `walk` (added 2026-10-31, free-amounts):
 * a walk of the steps to Review of the scenario's own, in place of walkToReview's.
 */
async function atReview(chain, { answer, amount, range = null, routes = [], routedQuote = undefined, walk = null } = {}) {
  const read = createReadStub({ answer: firstAnswer(answer, walletAssets(chain)) });
  let onboarding;
  const s = await scenario({ chain: mintedChain(chain), routes: [...routes, (request, url) => routedQuote !== undefined && url.pathname.startsWith('/api/onboarding/v1/') ? onboarding.handle(request) : undefined, (request, url) => read.handle(request, url)] });
  try {
    if (routedQuote !== undefined) { onboarding = createFakeOnboarding({ session: s.fake }); onboarding.origin = s.origin; onboarding.controls.swapRoute = routedQuote; }
    await s.context.route(ARTWORK, route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await installDepositWallet(s.context, chain);
    s.set({ setupRelease: { status: 200, body: chain.release } });
    const services = [];
    s.page.on('request', request => { if (/\/api\/(deposit|session)\//.test(request.url())) services.push(new URL(request.url()).pathname); });
    const dialog = s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
    await s.page.goto(`${s.origin}/#/new`);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await s.page.locator('header [aria-haspopup="dialog"]').click();
    await dialog.getByRole('button', { name: 'Connect Deposit Wallet', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
    if (routedQuote !== undefined) {
      await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
      await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    }
    await s.page.keyboard.press('Escape');
    if (walk) await walk(s.page);
    else await walkToReview(s.page, { amount, range });
    await s.page.locator('[data-create-position="idle"]').waitFor({ timeout: 30_000 });
    // Review's plan is drawn once the read service has answered the wallet's balances.
    await s.page.locator('[data-review-plan]').waitFor({ timeout: 30_000 });
    return Object.assign(s, { read, services, onboarding });
  } catch (error) { await s.close().catch(() => {}); throw error; }
}

for (const pressing of [false, true]) test(`New position’s delayed title scroll ${pressing ? 'does not move a pressed Continue away' : 'still reveals its focused title and allows keyboard Continue'}`, async () => {
  const read = createReadStub();
  const s = await scenario({ routes: [(request, url) => read.handle(request, url)] });
  try {
    await s.context.route(ARTWORK, route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.setViewportSize({ width: 1320, height: 600 });
    await s.page.goto(`${s.origin}/#/new`);
    await choosePool(s.page);
    await s.page.evaluate(() => {
      const schedule = window.setTimeout.bind(window);
      const cancel = window.clearTimeout.bind(window);
      const scroll = window.scrollTo.bind(window);
      window.__stepScrollTimers = [];
      window.__stepScrollCalls = [];
      // Hold only StepList's after-animation scroll, not network reads or rendering. Deliver it at the exact
      // pointer-down/up boundary that can occur under load; make its scroll immediate to remove frame timing.
      window.setTimeout = (callback, ms, ...args) => {
        if (ms !== 260) return schedule(callback, ms, ...args);
        const id = schedule(() => {}, 60_000);
        window.__stepScrollTimers.push({ id, deliver: () => callback(...args) });
        return id;
      };
      window.clearTimeout = (id) => {
        window.__stepScrollTimers = window.__stepScrollTimers.filter(timer => timer.id !== id);
        return cancel(id);
      };
      window.scrollTo = (options, y) => {
        window.__stepScrollCalls.push(options);
        if (typeof options === 'object') return scroll({ ...options, behavior: 'instant' });
        return scroll(options, y);
      };
    });
    await footerButton(s.page, 'Continue').click();
    const range = s.page.locator('li[data-step="range"][aria-current="step"]');
    await range.waitFor();
    await s.page.waitForFunction(() => window.__stepScrollTimers.length > 0);
    const next = range.locator('[data-journey-footer]').getByRole('button', { name: 'Continue', exact: true });
    await next.scrollIntoViewIfNeeded();
    await s.page.evaluate(async () => {
      await Promise.all(document.getAnimations().map(animation => animation.finished.catch(() => {})));
      const heading = document.querySelector('li[data-step="range"][aria-current="step"] h2');
      const header = document.querySelector('header').getBoundingClientRect().bottom;
      window.scrollTo({ top: window.scrollY + heading.getBoundingClientRect().top - header + 24, behavior: 'instant' });
      window.__stepScrollCalls = [];
    });
    const point = await next.boundingBox();
    assert.ok(point, 'the enabled Continue is visible');
    const headingTop = await range.locator('h2').evaluate(element => element.getBoundingClientRect().top);
    const headerBottom = await s.page.locator('header').evaluate(element => element.getBoundingClientRect().bottom);
    assert.ok(headingTop < headerBottom + 8, `the held timer would bring the title back below the header (${headingTop} < ${headerBottom + 8})`);
    if (pressing) {
      await s.page.mouse.move(point.x + point.width / 2, point.y + point.height / 2);
      await s.page.mouse.down();
    }
    try {
      assert.equal(await (pressing ? next : range.locator('h2')).evaluate(element => document.activeElement === element), true, pressing ? 'the user is interacting with Continue' : 'the newly opened title still owns focus');
      await s.page.evaluate(() => window.__stepScrollTimers.splice(0).forEach(timer => timer.deliver()));
    } finally { if (pressing) await s.page.mouse.up(); }
    assert.equal(await s.page.evaluate(() => window.__stepScrollCalls.length), pressing ? 0 : 1, pressing ? 'no automatic scroll during the press' : 'the untouched title is still brought into view');
    if (!pressing) {
      await next.focus();
      await next.press('Enter');
    }
    await s.page.locator('li[data-step="amount"][aria-current="step"] [data-pair-side="1"] input[inputmode="decimal"]').waitFor({ timeout: 3_000 });
    assert.deepEqual(s.wallet.state.signed, []);
    assert.deepEqual(s.deposits, []);
  } finally { await s.close(); }
});

/**
 * No service and no session took part, and the wallet was asked nothing outside connecting and the chain's own reads and sends.
 * `reverts`: whether the contract may have refused a simulated call (a swap size past its price limit); by default none did.
 */
async function onlyTheWallet(s, chain, { reverts = false } = {}) {
  if (!reverts) assert.deepEqual(chain.reverts, [], 'no simulated call was refused');
  // The one session route seen is the boot-time GET that asks whether a session exists to restore; none was started.
  assert.deepEqual(s.services.filter(path => path !== '/api/session/v1/me'), [], 'no deposit service and no session request');
  assert.deepEqual(s.deposits, []);
  assert.deepEqual([...new Set(s.fake.state.log.map(entry => `${entry.method} ${entry.route}`))], ['GET me'], 'the session service was only asked whether a session exists, never for one');
  assert.equal(s.wallet.state.signed.length, 0, 'no sign-in signature');
  assert.ok(!chain.log.includes('personal_sign') && !chain.log.includes('eth_signTypedData_v4'), 'the wallet was never asked to sign a message');
  assert.deepEqual(chain.refused, [], 'every method Create position asked is one this wallet answers');
  assert.deepEqual(chain.missing, [], 'every call reached a contract that answers it');
}

test('Create position opens the position from Review through a connected wallet with no session: the exact approval, the deposit, then the mint at Review’s range, and the page opens the new position on Positions', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n } });
  const s = await atReview(chain);
  const { setup } = chain.release.deployment;
  try {
    const button = s.page.locator('[data-create-position]');
    assert.equal(await button.innerText(), 'Create position');
    // Changed on purpose (round 6, 2026-09-27, the owner: New position for people who know nothing about pools): each reason is one short sentence.
    assert.equal(await s.page.locator('#create-reason').innerText(), 'Your wallet will ask you to confirm each step.');
    assert.equal(await s.page.getByRole('link', { name: 'Continue in Setup' }).count(), 0, 'no hand-off to Setup');
    assert.deepEqual(chain.sends, [], 'nothing is sent by arriving');
    // The wallet holds both tokens: Review plans both, and nothing is swapped.
    assert.equal(await s.page.locator('[data-review-amounts]').getAttribute('data-review-plan'), 'both');
    assert.equal(await s.page.locator('[data-review-swap], [data-review-swap-note], [data-review-short]').count(), 0);
    // What Review says the position holds: the ETH the range pairs with the typed 1 TOKEN.
    // Changed on purpose (round 6, 2026-09-27): the headline is short for reading; each side's exact figure is its data-exact.
    assert.match(await s.page.locator('[data-review-amounts]').innerText(), /^[\d.,]+ ETH \+ 1 TOKEN$/);
    const [eth, token] = await s.page.locator('[data-review-amounts] [data-exact]').evaluateAll(sides => sides.map(side => side.getAttribute('data-exact')));
    assert.equal(token, '1');
    // Before the press the list is the plan: each step by its key, none of them running.
    const list = s.page.locator('[data-wallet-steps]');
    assert.equal(await list.getAttribute('data-live'), null);
    assert.deepEqual(await walletStepStates(s.page), [[`approve:${FIXTURE_TOKEN}`, null], ['fund', null], ['mint', null]]);
    await recordWalletSteps(s.page);

    await button.click();
    await s.page.locator('[data-wallet-steps][data-live]').waitFor();
    assert.deepEqual((await walletStepStates(s.page)).map(([key]) => key), [`approve:${FIXTURE_TOKEN}`, 'fund', 'mint'], 'one approval for the one ERC-20 (ETH needs none), the deposit, the mint');
    assert.equal(await s.page.locator('[data-create-position="running"]').innerText(), 'Creating position…');
    // Mid-flow: the approval included, the deposit on its way into a block.
    await s.page.locator('[data-wallet-step="fund"][data-step-state="chain"]').waitFor({ timeout: 60_000 });
    assert.deepEqual(await walletStepStates(s.page), [[`approve:${FIXTURE_TOKEN}`, 'done'], ['fund', 'chain'], ['mint', 'waiting']]);
    // Changed on purpose (round 6, 2026-09-27, the owner: New position for people who know nothing about pools): short titles, the token by its symbol.
    assert.match(await list.innerText(), /Approve TOKEN\s+Done[\s\S]*Deposit both tokens\s+Waiting for the network[\s\S]*Create the position\s+Next/);
    // The window as the person sees it, scrolled to the steps (a full-page capture draws the sticky header mid-page).
    await list.evaluate(element => element.scrollIntoView({ block: 'end' }));
    await s.page.screenshot({ path: join(shots(), 'create-position-steps.png') });

    // The mint read back closed with its NFT: the page opens that position on Positions.
    await openCreated(s.page, '4242', 60_000, 'create-position-next.png');
    // Changed on purpose (owner, 2026-09-24): #/positions/<id> is the position's own page now, not the lookup by id,
    // read from chain (not the read service; by the page itself since 2026-09-25), and nothing about it is kept in the browser.
    const detail = s.page.locator('[data-position-detail][data-position-id="4242"]');
    await detail.waitFor({ timeout: 30_000 });
    assert.equal(await s.page.locator('#nft-ids').count(), 0, 'no id to type: the page is the position');
    // The position read from chain: NFT 4242, in the pool chosen, at Review's range, this wallet's.
    assert.deepEqual(s.read.requests.filter(r => r.path.endsWith('/nft-positions')), [], 'the read service is not asked');
    assert.deepEqual(await s.page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter(key => /positions/i.test(key))), [], 'no memory of the new position in the browser');
    assert.match(await detail.locator('h1').innerText(), /^ETH\s*\/\s*TOKEN$/);
    assert.match(await detail.locator('.dm-pos-chips').innerText(), /#4242\s+In range/);
    // Changed on purpose (2026-09-27, the owner: technical data only in Details, closed until opened, at the page's end).
    await detail.locator('[data-position-details] > summary').click();
    assert.match(await detail.locator('.dm-pos-facts').innerText(), new RegExp(`Owner\\s+${OWNER}[\\s\\S]*Ticks\\s+${STUB_RANGE[0]} to ${STUB_RANGE[1]}`));
    await s.page.screenshot({ path: join(shots(), 'create-position-positions.png'), fullPage: true });

    // What the wallet was asked to sign, in order, decoded from the calldata it recorded.
    assert.equal(chain.sends.length, 3, 'the approval, the deposit and the mint, one signature each');
    const [approve, open, mint] = chain.decoded();
    assert.deepEqual([approve.functionName, approve.to, approve.from, approve.args[0].toLowerCase(), approve.args[1], approve.value, approve.nonce], ['approve', FIXTURE_TOKEN, OWNER, setup, withRoom(1_000_000n), 0n, '0x0'],
      'an exact allowance of the typed 1 TOKEN with the 0.5% slippage room, to the setup contract, never unlimited');
    const [id, key, amount0, amount1] = open.args;
    assert.deepEqual([open.functionName, open.to, open.from, open.nonce, id], ['open', setup, OWNER, '0x1', chain.operationId(0n)], 'the owner’s first operation id');
    assert.deepEqual(lowerKey(key), STUB_POOL_KEY, 'the pool chosen on the first step');
    assert.deepEqual([amount1, open.value], [withRoom(1_000_000n), amount0], 'the typed 1 TOKEN with its slippage room; token 0 is native ETH, so its amount travels as the value');
    assert.equal(amount0, withRoom(parseUnits(eth.replaceAll(',', ''), 18)), 'the ETH amount is the one Review showed, with the same room');
    const plan = mint.args[0];
    assert.deepEqual([mint.functionName, mint.to, mint.from, mint.value, mint.nonce], ['mint', setup, OWNER, 0n, '0x2']);
    assert.deepEqual([plan.operationId, plan.tickLower, plan.tickUpper, plan.maxAmount0, plan.maxAmount1, plan.initialSqrtPriceX96], [id, ...STUB_RANGE, amount0, withRoom(1_000_000n), 0n],
      'Review’s range, the funded balances as caps, the existing pool');
    assert.ok(chain.viewed.includes('getSlot0'), 'the mint was priced from the chain, through the wallet');
    assert.ok(plan.liquidity > 0n, 'a position, not an empty one');
    assert.ok(plan.minSqrtPriceX96 > 0n && plan.minSqrtPriceX96 < STUB_SQRT_PRICE && STUB_SQRT_PRICE < plan.maxSqrtPriceX96, 'a price band around the price as read');
    assert.equal(chain.operations.get(id).tokenId, 4242n);
    assert.ok(chain.viewed.includes('balanceOf'), 'the wallet’s TOKEN balance was checked before anything was asked');
    assert.deepEqual(chain.quotes, [], 'nothing was swapped or even quoted: the wallet held both tokens');
    assert.deepEqual(chain.quoted, [], 'and the pool was not checked for a swap: V4Quoter was never asked');
    assert.ok(!chain.viewed.includes('getLiquidity') && !chain.viewed.includes('poolManager'));
    // The steps turned done one at a time, in order, each while the ones after it were still to come.
    const { order } = await doneOrder(s.page);
    assert.deepEqual(order.map(({ key }) => key), [`approve:${FIXTURE_TOKEN}`, 'fund', 'mint']);
    for (const [index, { key, states }] of order.entries()) for (const later of order.slice(index + 1)) assert.notEqual(states[later.key], 'done', `${later.key} was done before ${key}`);
    await onlyTheWallet(s, chain);
    assert.doesNotMatch(await s.page.locator('main').innerText(), FORBIDDEN);
  } finally { await s.close(); }
});

// Added 2026-10-31 (QA round 2 follow-ups, free-amounts; the owner: "no new position você pode digitar o valor que você
// quiser também... se o usuário tiver os dois tokens, não precisa ser autoajustar. Só se o usuário quiser. Tem que ser livre
// isso. Mas tem que ter a opção de preencher de forma automática"). 1 TOKEN pairs with 892,661 wei at the stub's price and
// range (pairAmount.ts); 500,000 wei typed over it pairs with 0.560122 TOKEN, so ETH limits the position.
test('New position’s amounts are free: one typed fills in the other, a figure typed over it stays with a line saying what stays in the wallet, Fill in for me works it out again, and Review, Back and Create position keep the amount that limits the position', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n } });
  const ETH_TYPED = '0.0000000000005';
  const LINE = /^Your range uses 0\.560122 TOKEN and 0\.0000000000005 ETH\. 0\.439878 TOKEN stays in your wallet\.$/;
  const step = (page) => page.locator('[data-stage-card="amount"] [data-stage="amount"]');
  const field = (page, side) => step(page).locator(`[data-pair-side="${side}"] input[inputmode="decimal"]`);
  const role = (page, side) => step(page).locator(`[data-pair-side="${side}"]`).getAttribute('data-pair-role');
  const caption = (page, side) => step(page).locator(`[data-pair-side="${side}"] .dm-flow-pair-caption`).innerText();
  const s = await atReview(chain, {
    walk: async (page) => {
      await choosePool(page);
      const current = (name) => page.locator(`li[data-step="${name}"][aria-current="step"]`);
      await pressContinue(current('pool'));
      await current('range').waitFor();
      await pressContinue(current('range'));
      await current('amount').waitFor();
      await step(page).locator('[data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
      // One amount typed: the other is filled in for the person, and says so; nothing to take back, no line.
      await field(page, 1).fill('1');
      await page.waitForFunction(() => document.querySelector('[data-pair-side="0"] input')?.value === '0.000000000000892661');
      assert.deepEqual([await role(page, 1), await role(page, 0)], ['typed', 'derived']);
      assert.equal(await caption(page, 0), 'Also needed, worked out for you');
      assert.equal(await step(page).locator('[data-pair-fill]').count(), 0);
      assert.equal(await step(page).locator('[data-amount-left]').count(), 0);
      // The live region is there, empty and out of sight, before its first words.
      assert.equal(await step(page).locator('p[role="status"].sr-only').count(), 1);

      // A figure typed over it is the person's own: both stay as typed, both captions say so, and the line says what stays.
      await field(page, 0).fill(ETH_TYPED);
      const line = step(page).locator('[data-amount-left="1"]');
      await line.waitFor();
      assert.match(await line.innerText(), LINE);
      assert.equal(await line.getAttribute('role'), 'status');
      assert.deepEqual([await role(page, 1), await role(page, 0)], ['typed', 'typed']);
      assert.deepEqual([await caption(page, 1), await caption(page, 0)], ['You enter', 'You enter']);
      assert.deepEqual([await field(page, 1).inputValue(), await field(page, 0).inputValue()], ['1', ETH_TYPED]);
      // Fill in for me sits with the figure typed second only. Changed on purpose 2026-10-31 (its review): its name says the
      // token it fills in, after the visible words; the wallet holds the 1 TOKEN typed, so what stays is in it.
      const fill = step(page).locator('[data-pair-fill="0"]');
      assert.equal(await fill.textContent(), 'Fill in for me (ETH)');
      assert.equal(await fill.ariaSnapshot(), '- button "Fill in for me (ETH)"');
      assert.equal(await step(page).locator('[data-pair-fill="1"]').count(), 0);
      assert.equal(await line.getAttribute('data-amount-left-held'), 'true');
      await page.screenshot({ path: join(shots(), 'create-amount-free.png'), fullPage: true });
      // Added 2026-10-31 (its review): on a phone the panel's foot wraps with Max still on its balance's line, and Fill in
      // for me never above it; nothing scrolls sideways.
      await page.setViewportSize({ width: 375, height: 812 });
      await page.screenshot({ path: join(shots(), 'create-amount-free-375.png'), fullPage: true });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'the amount step fits 375px');
      const middle = (box) => box.y + box.height / 2;
      for (const side of [0, 1]) {
        const foot = step(page).locator(`[data-pair-side="${side}"] .dm-flow-balance`);
        const balanceLine = await foot.locator('.dm-flow-balance-line').boundingBox();
        const max = foot.locator(`[data-pair-max="${side}"]`);
        if (await max.count()) assert.ok(Math.abs(middle(await max.boundingBox()) - middle(balanceLine)) < 4, `Max stays on its balance’s line (side ${side})`);
      }
      const ownLine = await step(page).locator('[data-pair-side="0"] .dm-flow-balance-line').boundingBox();
      assert.ok(middle(await fill.boundingBox()) >= middle(ownLine) - 4, 'Fill in for me never sits above its balance');
      await page.setViewportSize({ width: 1320, height: 1000 });

      // Pressed: that figure is worked out from the other again, the line goes, and the field it filled in has the focus.
      await fill.click();
      await page.waitForFunction(() => document.querySelector('[data-pair-side="0"] input')?.value === '0.000000000000892661');
      assert.equal(await role(page, 0), 'derived');
      assert.equal(await caption(page, 0), 'Also needed, worked out for you');
      assert.equal(await step(page).locator('[data-amount-left], [data-pair-fill]').count(), 0);
      assert.equal(await page.evaluate(() => document.activeElement?.id), 'create-amount-0');
      assert.equal(await field(page, 1).inputValue(), '1', 'the first figure never moved');

      // Typed over again, and on to Review.
      await field(page, 0).fill(ETH_TYPED);
      await line.waitFor();
      await pressContinue(current('amount'));
      await page.locator('[data-stage-card="review"]').waitFor();
    },
  });
  const { setup } = chain.release.deployment;
  try {
    // Review plans the amount that limits the position: the ETH typed, and the TOKEN the range pairs with it.
    assert.equal(await s.page.locator('[data-review-amounts]').getAttribute('data-review-plan'), 'both');
    const exact = () => s.page.locator('[data-review-amounts] [data-exact]').evaluateAll(sides => sides.map(side => side.getAttribute('data-exact')));
    assert.deepEqual(await exact(), [ETH_TYPED, '0.560122']);

    // Back keeps both figures as typed, and the line; Continue brings the same plan.
    await footerButton(s.page, 'Back').click();
    await step(s.page).waitFor();
    assert.deepEqual([await field(s.page, 1).inputValue(), await field(s.page, 0).inputValue()], ['1', ETH_TYPED]);
    assert.deepEqual([await role(s.page, 1), await role(s.page, 0)], ['typed', 'typed']);
    assert.match(await step(s.page).locator('[data-amount-left="1"]').innerText(), LINE);
    await footerButton(s.page, 'Continue').click();
    await s.page.locator('[data-create-position="idle"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(await exact(), [ETH_TYPED, '0.560122']);

    // Create position sends that plan: the TOKEN the range pairs with the ETH, never the 1 TOKEN typed.
    await s.page.locator('[data-create-position]').click();
    await s.page.locator('[data-created-position="4242"]').waitFor({ timeout: 60_000 });
    const [approve, open] = chain.decoded();
    assert.deepEqual([approve.functionName, approve.args[0].toLowerCase(), approve.args[1]], ['approve', setup, withRoom(560_122n)]);
    const [, , amount0, amount1] = open.args;
    assert.deepEqual([open.functionName, amount0, open.value, amount1], ['open', withRoom(500_000n), withRoom(500_000n), withRoom(560_122n)]);
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

// Added 2026-10-31 (QA round 2 follow-ups, free-amounts review; the owner: "tem que ter a opção de preencher de forma
// automática quando o usuário não tem o token"): a wallet with no TOKEN can't fund two figures of its own, so a figure typed
// over the worked-out ETH makes ETH the amount and the TOKEN is worked out from it, as before free amounts.
test('New position with a wallet that holds no TOKEN: a figure typed over the worked-out ETH makes ETH the amount, the TOKEN is worked out again, and nothing offers to fill in', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address);
  const ETH_TYPED = '0.0000000000005';
  const step = (page) => page.locator('[data-stage-card="amount"] [data-stage="amount"]');
  const field = (page, side) => step(page).locator(`[data-pair-side="${side}"] input[inputmode="decimal"]`);
  const role = (page, side) => step(page).locator(`[data-pair-side="${side}"]`).getAttribute('data-pair-role');
  const s = await atReview(chain, {
    walk: async (page) => {
      await choosePool(page);
      const current = (name) => page.locator(`li[data-step="${name}"][aria-current="step"]`);
      await pressContinue(current('pool'));
      await current('range').waitFor();
      await pressContinue(current('range'));
      await current('amount').waitFor();
      await step(page).locator('[data-pair-balance="ready"]').first().waitFor({ timeout: 30_000 });
      await field(page, 1).fill('1');
      await page.waitForFunction(() => document.querySelector('[data-pair-side="0"] input')?.value === '0.000000000000892661');
      await field(page, 0).fill(ETH_TYPED);
      await page.waitForFunction(() => document.querySelector('[data-pair-side="1"] input')?.value === '0.560122');
      assert.deepEqual([await role(page, 0), await role(page, 1)], ['typed', 'derived']);
      assert.equal(await step(page).locator('[data-pair-side="1"] .dm-flow-pair-caption').innerText(), 'Also needed, worked out for you');
      assert.equal(await step(page).locator('[data-pair-fill], [data-amount-left]').count(), 0);
      await pressContinue(current('amount'));
      await page.locator('[data-stage-card="review"]').waitFor();
    },
  });
  try {
    // Review plans the ETH typed as the amount, and the TOKEN the range pairs with it, which the wallet's ETH buys.
    assert.equal(await s.page.locator('[data-review-amounts]').getAttribute('data-review-plan'), 'swap');
    await footerButton(s.page, 'Back').click();
    await step(s.page).waitFor();
    assert.deepEqual([await role(s.page, 0), await role(s.page, 1)], ['typed', 'derived']);
    assert.equal(await field(s.page, 0).inputValue(), ETH_TYPED);
  } finally { await s.close(); }
});

test('an account delegated (EIP-7702) to a contract this app does not recognize: Create position names it and asks the wallet nothing until the person confirms, then approves, deposits and mints', async () => {
  const delegate = '0x' + 'de'.repeat(20);
  const chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n }, ownerCode: '0xef0100' + delegate.slice(2), delegateCode: '0x6000' });
  const s = await atReview(chain);
  try {
    // What the press itself reads and asks, apart from what the page read before it.
    const [viewedBefore, loggedBefore] = [chain.viewed.length, chain.log.length];
    await s.page.locator('[data-create-position]').click();
    const notice = s.page.locator('[data-create-notice="delegate_unrecognized"]');
    await notice.waitFor({ timeout: 30_000 });
    assert.equal(await notice.innerText(), `Your account runs a smart-account contract (EIP-7702) that Domino does not recognize: ${delegate}. That code can move everything the account holds, including the position this would create. Nothing was sent. Continue only if you set up this smart account in your wallet yourself.`);
    assert.equal(await s.page.locator('#create-reason').innerText(), 'Your wallet is asked nothing until you confirm the smart account below, or connect another account.');
    assert.equal(await s.page.locator('[data-create-position]').getAttribute('data-create-position'), 'failed');
    // Said before anything else was read or asked: no balance, no allowance, no probe, no simulation, nothing sent.
    assert.deepEqual(chain.sends, []);
    const asked = chain.log.slice(loggedBefore), viewed = chain.viewed.slice(viewedBefore);
    assert.ok(!asked.includes('eth_estimateGas') && !asked.includes('eth_getBalance') && !asked.includes('eth_sendTransaction'), asked.join(', '));
    assert.ok(!viewed.includes('balanceOf') && !viewed.includes('allowance') && !viewed.includes('native_probe'), viewed.join(', '));
    await s.page.screenshot({ path: join(shots(), 'create-position-unrecognized-delegate.png'), fullPage: true });
    // Pressed again without confirming: the same stop, still nothing asked.
    await s.page.locator('[data-create-position]').click();
    await s.page.locator('[data-create-position="failed"]').waitFor({ timeout: 30_000 });
    await notice.waitFor({ timeout: 30_000 });
    assert.deepEqual(chain.sends, []);
    // Confirmed: the same press runs again, and the position is made as for any account.
    const confirm = s.page.locator(`[data-create-confirm-delegate="${delegate}"]`);
    assert.equal(await confirm.innerText(), 'I set up this smart account: continue');
    await confirm.click();
    await openCreated(s.page, '4242', 60_000);
    assert.deepEqual(chain.decoded().map(tx => tx.functionName), ['approve', 'open', 'mint']);
    assert.ok(chain.viewed.includes('native_probe'), 'the account has code, so the ETH it may be paid back was probed as well');
    assert.equal(await s.page.locator('[data-create-notice="delegate_unrecognized"], [data-create-confirm-delegate]').count(), 0);
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

test('an account delegated (EIP-7702) to a recognized wallet’s contract creates its position with no question: Simple7702Account’s own code, as read on Robinhood Chain', async () => {
  const delegate = '0xe6cae83bde06e4c305530e199d7217f42808555b';
  const chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n }, ownerCode: '0xef0100' + delegate.slice(2), delegateCode: DELEGATES.code[delegate] });
  const s = await atReview(chain);
  try {
    await s.page.locator('[data-create-position]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.deepEqual(chain.decoded().map(tx => tx.functionName), ['approve', 'open', 'mint']);
    assert.equal(await s.page.locator('[data-create-notice="delegate_unrecognized"], [data-create-confirm-delegate]').count(), 0);
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

/** The wallet's one batch, its calls decoded against the contracts they go to, each with the ETH it carries. */
const batchCalls = (chain, batch) => batch.calls.map(call => ({ ...chain.decodeCall(call), to: call.to.toLowerCase(), value: BigInt(call.value) }));

/** Route choices are synthetic and registered with this scenario's fake node only, never a public provider. */
function chosenRoute(chain, percent = 110n) {
  return ({ request, now }) => {
    const poolOut = chain.swapOutput(BigInt(request.amountRaw), request.tokenIn === zeroAddress) ?? 0n;
    const preview = routedSwapPreview({ request, now, poolOutRaw: String(poolOut), amountOutRaw: String(poolOut > 0n ? poolOut * percent / 100n : BigInt(request.amountRaw)) });
    chain.registerRoute(preview);
    return preview;
  };
}

for (const nativeInput of [false, true]) test(`routed Create position ${nativeInput ? 'native input' : 'ERC20 input'} requires review before one atomic wallet offer and deposits both tokens without a Setup swap`, { timeout: 120_000 }, async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, atomic: 'supported', ...(nativeInput ? {} : { eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 2n * typed } }) });
  const s = await atReview(chain, { amount: nativeInput ? undefined : '10000000000', routedQuote: chosenRoute(chain) });
  try {
    await s.page.locator('#create-reason', { hasText: 'sign once' }).waitFor();
    assert.equal(s.onboarding.calls('swap-route').length, 0, 'typing and arriving at Review never request a route');
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    const request = s.onboarding.calls('swap-route')[0].body;
    assert.equal(s.onboarding.calls('swap-route').length, 1);
    assert.equal(request.tokenIn, nativeInput ? zeroAddress : FIXTURE_TOKEN);
    assert.equal('owner' in request, false, 'the session supplies the owner');
    await s.page.locator('[data-review-route="uniswap"]').waitFor();
    // Changed on purpose 2026-10-01 (audit E20): CREATE's plain words, with no "guaranteed" and no "router".
    assert.match(await s.page.locator('[data-review-route-minimum]').innerText(), /You receive at least[\s\S]*after the fee[\s\S]*0\.65%, once/);
    assert.doesNotMatch(await s.page.locator('[data-stage="review"]').innerText(), /guaranteed|router|Price impact/i);
    assert.deepEqual([chain.sends, chain.batches], [[], []], 'the newly chosen route never signs before the person reviews it');
    await s.page.locator('[data-create-position="failed"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.equal(s.onboarding.calls('swap-route').length, 1, 'a current route is reused for consent, not polled');
    assert.equal(chain.batches.length, 1);
    assert.deepEqual(chain.sends, []);
    const calls = batchCalls(chain, chain.batches[0]);
    const swapIndex = calls.findIndex(call => call.to === UNIVERSAL_ROUTER);
    assert.ok(swapIndex >= 0);
    if (!nativeInput) assert.deepEqual(calls.slice(0, 3).map(call => [call.to, call.functionName]), [[FIXTURE_TOKEN, 'approve'], [ROUTE_PERMIT2, 'approve'], [UNIVERSAL_ROUTER, 'execute']]);
    else assert.equal(calls[0].functionName, 'execute');
    assert.equal(calls[swapIndex].value, nativeInput ? BigInt(request.amountRaw) : 0n);
    const setup = calls.filter(call => call.to === chain.release.deployment.setup);
    assert.deepEqual(setup.map(call => call.functionName), ['open', 'mint'], 'no second swap or second swap fee in Setup');
    assert.ok(setup[0].args[2] > 0n && setup[0].args[3] > 0n);
    assert.ok(chain.log.indexOf('eth_simulateV1') < chain.log.indexOf('wallet_sendCalls'));
    assert.deepEqual(s.onboarding.state.violations, []);
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
  } finally { await s.close(); }
});

test('routed Create position warns before sequential signing and never repeats a completed router swap when the later deposit is declined', { timeout: 150_000 }, async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 2n * typed } });
  const s = await atReview(chain, { amount: '10000000000', routedQuote: chosenRoute(chain) });
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    // Changed on purpose 2026-10-01 (integration pass 3): the copy workstream (lib/create/copy.ts ROUTED.sequential) says
    // "what you received stays in your wallet" for "the received tokens stay in your wallet".
    assert.match(await s.page.locator('[data-review-route-risk]').innerText(), /stop after the swap[\s\S]*what you received stays in your wallet[\s\S]*fee are not undone/);
    assert.deepEqual(chain.sends, []);
    chain.decline('open');
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice]', { hasText: 'The Uniswap swap completed and its fee was collected.' }).waitFor({ timeout: 60_000 });
    assert.match(await s.page.locator('[data-create-notice]').innerText(), /received tokens remain in your wallet[\s\S]*continue without another swap/);
    const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
    assert.equal(routerCalls().length, 1, 'the swap completed before the user declined depositing');
    assert.ok(chain.declined.includes('open'));
    assert.deepEqual(chain.batches, []);
    await s.page.locator('[data-create-position="failed"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.equal(routerCalls().length, 1);
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 1 (2026-10-01): a routed Uniswap swap the person replaces in the wallet ("Cancel" here) never gets a receipt
// for its own hash. Its journal used to stay, holding Create position for that wallet in that browser for good; it is
// now let go, settled by the chain (its nonce passed with no transaction under its hash), and the next press asks for a
// fresh quote and review before anything is signed.
test('a routed Uniswap swap cancelled in the wallet is said at once and lets go of its journal; the next press reviews again and swaps once', { timeout: 150_000 }, async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 2n * typed } });
  chain.cancelInWallet('execute');
  const s = await atReview(chain, { amount: '10000000000', routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    const said = s.page.locator('[data-create-notice="route_replaced"]');
    await said.waitFor({ timeout: 60_000 });
    // Changed on purpose 2026-10-01 (fix round 2): the transaction that took the nonce is read, so a cancel is said as one.
    // Changed on purpose in fix round 3: "this swap", since another transaction of the wallet's may have swapped something else.
    assert.match(await said.innerText(), /^Your wallet replaced the Uniswap swap with another transaction, so this swap did not happen and no swap fee was collected for it\./);
    assert.equal(routerCalls().length, 0, 'the swap never happened');
    assert.deepEqual(await records(s.page), [], 'its journal and nonce are let go');
    // The next press reads the balances again and asks for a fresh review before anything is signed.
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    assert.equal(routerCalls().length, 0, 'nothing is sent again on its own');
    await s.page.locator('[data-create-position="failed"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.equal(routerCalls().length, 1, 'one swap, after its review');
    assert.deepEqual(await records(s.page), []);
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 2 (2026-10-01): "Speed up" sends the same router call under another hash, so the page's own hash is never
// mined either. The transaction that took the nonce is read: the reviewed router call, included, is the swap, done. The
// press goes on to the deposit as after any swap, and no fresh quote, second swap or second fee is ever offered.
test('a routed Uniswap swap sped up in the wallet is the swap, done: the press goes on to the deposit and never offers a second swap', { timeout: 150_000 }, async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 2n * typed } });
  chain.speedUp('execute');
  const s = await atReview(chain, { amount: '10000000000', routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.equal(routerCalls().length, 1, 'the sped-up swap, once');
    assert.equal(s.onboarding.calls('swap-route').length, 1, 'no fresh quote');
    assert.deepEqual(chain.decoded().filter(call => call.to === chain.release.deployment.setup).map(call => call.functionName), ['open', 'mint'], 'no second swap or fee in Setup');
    assert.deepEqual(await records(s.page), [], 'its journal is let go once the position exists');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 2 (2026-10-01): the same speed-up found again after a reload, where only the hash and nonce survive. The
// router call at that nonce swapped, so the journal stays: the next press says so and uses the wallet's balances, never a
// fresh quote or a second swap (route_use_balances stops a deposit they cannot cover). Before, the journal was let go,
// and a wallet holding enough of the first token was offered a second swap and fee.
test('a sped-up routed Uniswap swap found again after a reload keeps its journal and never offers a second swap', { timeout: 180_000 }, async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 2n * typed } });
  chain.speedUp('execute');
  chain.decline('open');
  const s = await atReview(chain, { amount: '10000000000', routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice]', { hasText: 'The Uniswap swap completed and its fee was collected.' }).waitFor({ timeout: 60_000 });
    assert.equal(routerCalls().length, 1);
    assert.equal((await records(s.page)).length, 2, 'the journal keeps the hash and nonce of the swap');
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await walkToReview(s.page, { amount: '10000000000' });
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_recovered"]').waitFor({ timeout: 60_000 });
    assert.equal((await records(s.page)).length, 2, 'a swap that happened keeps its journal');
    await s.page.locator('[data-create-position="failed"]').click();
    // The wallet's balances cover both tokens now: the deposit is made from them, with no swap of any kind.
    await openCreated(s.page, '4242', 60_000);
    assert.equal(routerCalls().length, 1, 'no second swap');
    assert.equal(s.onboarding.calls('swap-route').length, 1, 'no fresh quote');
    assert.deepEqual(chain.decoded().filter(call => call.to === chain.release.deployment.setup).map(call => call.functionName), ['open', 'mint'], 'no swap in Setup either');
    assert.deepEqual(await records(s.page), [], 'its journal is let go once the position exists');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 3 (2026-10-01): the wallet's RPC keeps little old state (about 2,000 blocks on the chain's own RPC, none on
// publicnode), so a replacement found minutes later cannot be searched for in history. The fake chain now refuses a
// nonce read more than `keptBlocks` blocks back.
// Changed on purpose in fix round 3.1 (2026-10-01): the reviewed router call is found by the token it paid this wallet
// (eth_getLogs through the wallet, from the block the swap was sent after), so the speed-up is said as completed, as it
// is; the wallet's balances fund the deposit with no fresh quote and no second swap.
test('a sped-up routed Uniswap swap found after a reload on a node that no longer keeps its state is found by the tokens it paid the wallet: said as completed, and the deposit is made from the wallet’s balances with no second swap', { timeout: 180_000 }, async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 2n * typed }, keptBlocks: 4 });
  chain.speedUp('execute');
  chain.decline('open');
  const s = await atReview(chain, { amount: '10000000000', routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    // In the same press the replacement is a block old: the history finds the reviewed call, and the press goes on.
    await s.page.locator('[data-create-notice]', { hasText: 'The Uniswap swap completed and its fee was collected.' }).waitFor({ timeout: 60_000 });
    assert.deepEqual(chain.pruned, [], 'only state the node keeps was asked for');
    assert.equal(routerCalls().length, 1);
    assert.equal(chain.permitOf(FIXTURE_TOKEN)[0], 0n, 'the swap spent its Permit2 allowance');
    // Minutes later the node no longer keeps the state of the block the speed-up is in.
    chain.mine(12);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await walkToReview(s.page, { amount: '10000000000' });
    await s.page.locator('[data-create-position="idle"]').click();
    const said = s.page.locator('[data-create-notice="route_recovered"]');
    await said.waitFor({ timeout: 60_000 });
    assert.match(await said.innerText(), /^Your earlier Uniswap swap completed\./);
    assert.ok(chain.pruned.length > 0, 'the old state was refused');
    assert.ok(chain.log.includes('eth_getLogs'), 'found by the tokens it paid the wallet');
    assert.equal((await records(s.page)).length, 2, 'a swap that happened keeps its journal');
    await s.page.locator('[data-create-position="failed"]').click();
    // The wallet's balances cover both tokens: the deposit is made from them, with no swap of any kind.
    await openCreated(s.page, '4242', 60_000);
    assert.equal(routerCalls().length, 1, 'no second swap');
    assert.equal(s.onboarding.calls('swap-route').length, 1, 'no fresh quote');
    assert.deepEqual(chain.decoded().filter(call => call.to === chain.release.deployment.setup).map(call => call.functionName), ['open', 'mint'], 'no swap in Setup either');
    assert.deepEqual(await records(s.page), [], 'its journal is let go once the position exists');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 3.1 (2026-10-01), the recheck's high finding: the same speed-up on a wallet's RPC that serves no logs. Its
// Permit2 allowance reads exactly as the reviewed swap leaves it, so the swap went through. A later one-token press that
// the balances cannot cover used to say it could not confirm the swap and offer "It did not go through", whose one click
// led to a fresh quote and a second swap and fee for the same deposit. It now says the swap went through, asks to use
// both balances, and offers no way to a second swap.
// Changed on purpose in fix round 3.2 (2026-10-02): a revoke of that allowance (Permit2's lockdown) leaves it the same, so
// the page says what the chain shows and never that the swap went through; every guard of a completed swap stays.
test('a sped-up routed Uniswap swap whose Permit2 allowance reads spent by it, with no logs and no old state, keeps every guard of a completed swap, never said as proof: a later one-token press the balances cannot cover offers no way to a second swap', { timeout: 180_000 }, async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 4n * typed }, keptBlocks: 4, logs: false });
  chain.speedUp('execute');
  chain.decline('open');
  const s = await atReview(chain, { amount: '10000000000', routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  const release = s.page.locator('[data-create-route-release]');
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice]', { hasText: 'The Uniswap swap completed and its fee was collected.' }).waitFor({ timeout: 60_000 });
    assert.equal(routerCalls().length, 1);
    chain.mine(12);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    // Twice the amount: what the swap paid does not cover it, and the wallet holds enough TOKEN for a one-token deposit.
    await walkToReview(s.page, { amount: '20000000000' });
    await s.page.locator('[data-create-position="idle"]').click();
    const said = s.page.locator('[data-create-notice="route_spent"]');
    await said.waitFor({ timeout: 60_000 });
    // Changed on purpose in fix round 3.2: a revoke leaves the same allowance, so it is never said as proof.
    assert.match(await said.innerText(), /The chain shows Uniswap can no longer take the amount your earlier Uniswap swap was to spend, as after a swap that went through, so no new swap is offered for this deposit\./);
    assert.doesNotMatch(await said.innerText(), /the swap went through|took from your wallet/);
    assert.ok(chain.pruned.length > 0, 'the old state was refused');
    assert.equal(await release.count(), 0);
    await s.page.locator('[data-create-position="failed"]').click();
    const balances = s.page.locator('[data-create-notice="route_use_balances"]');
    await balances.waitFor({ timeout: 60_000 });
    assert.match(await balances.innerText(), /^Your earlier Uniswap swap may have gone through: the chain shows Uniswap can no longer take what it was to spend\. Use both tokens now in your wallet[\s\S]*No second swap will be sent\./);
    assert.equal(await release.count(), 0, 'no “It did not go through”');
    assert.equal(await s.page.locator('[data-create-notice="route_unconfirmed"]').count(), 0);
    assert.equal(routerCalls().length, 1, 'no second swap');
    assert.equal(s.onboarding.calls('swap-route').length, 1, 'no fresh quote');
    assert.equal((await records(s.page)).length, 2, 'the journal stays');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 3 (2026-10-01): the high finding. The swap waits in the wallet, the page is reloaded, the person cancels it
// in the wallet and comes back minutes later: the node no longer keeps the state of the cancel's block. It used to read
// as `unknown`, keep the journal for good, and say on every later press that the swap completed.
// Changed on purpose in fix round 3.1 (2026-10-01): the swap's Permit2 allowance, untouched, no longer lets the journal go
// at once: a wallet may have signed the swap under a nonce of its own, still to come. The page says the swap has not taken
// the tokens and when it never can; once that time is past (Permit2 refuses the expired allowance, and the router call's
// deadline is the same), the journal is let go and the next press reviews a fresh quote before one swap is sent.
test('a routed Uniswap swap cancelled in the wallet after a reload, found when the node no longer keeps that state: its Permit2 allowance is untouched, so the page says when it can never go through, then lets its journal go, and the next press reviews again and swaps once', { timeout: 180_000 }, async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 2n * typed }, keptBlocks: 4 });
  chain.holdInWallet('execute');
  const s = await atReview(chain, { amount: '10000000000', routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    // The swap was handed to the wallet, which holds it: its hash is in the journal beside its nonce (kept with the claim
    // since fix round 3.1), and the page waits.
    await s.page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('domino.routed-offer.v1.') && /\|0x/.test(localStorage.getItem(key))), null, { timeout: 60_000 });
    assert.equal((await records(s.page)).length, 2);
    const permit = chain.permitOf(FIXTURE_TOKEN);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    chain.cancelHeld();
    chain.mine(12);
    await walkToReview(s.page, { amount: '10000000000' });
    await s.page.locator('[data-create-position="idle"]').click();
    const waiting = s.page.locator('[data-create-notice="route_untouched"]');
    await waiting.waitFor({ timeout: 60_000 });
    assert.match(await waiting.innerText(), /^Your wallet replaced the Uniswap swap with another transaction\. The swap has not taken your tokens, and after \d{1,2}:\d{2}\s?[AP]M it never can\./);
    assert.ok(chain.pruned.length > 0, 'the old state was refused');
    assert.deepEqual(chain.permitOf(FIXTURE_TOKEN), permit, 'the allowance the swap would spend, untouched');
    assert.equal((await records(s.page)).length, 2, 'kept until nothing can take the input');
    assert.equal(await s.page.locator('[data-create-route-release]').count(), 0);
    // Pressed again before then: still nothing let go, nothing quoted.
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-position="failed"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-notice="route_untouched"]').waitFor({ timeout: 60_000 });
    assert.equal(s.onboarding.calls('swap-route').length, 1);
    assert.equal((await records(s.page)).length, 2);
    // Past the allowance's expiry on the chain's clock: the swap never happened and never can.
    chain.later(1_900);
    await s.page.locator('[data-create-position="failed"]').click();
    const said = s.page.locator('[data-create-notice="route_replaced"]');
    await said.waitFor({ timeout: 60_000 });
    assert.match(await said.innerText(), /^Your wallet replaced the Uniswap swap with another transaction, so this swap did not happen and no swap fee was collected for it\./);
    assert.deepEqual(await records(s.page), [], 'its journal and nonce are let go');
    assert.equal(routerCalls().length, 0, 'the swap never happened');
    chain.later(0);
    // The next press reads the balances again and asks for a fresh review before anything is signed.
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    assert.equal(s.onboarding.calls('swap-route').length, 2, 'a fresh quote');
    assert.equal(routerCalls().length, 0, 'nothing is sent again on its own');
    await s.page.locator('[data-create-position="failed"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.equal(routerCalls().length, 1, 'one swap, after its review');
    assert.deepEqual(await records(s.page), []);
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 3 (2026-10-01): an ETH input has no allowance to read, so a cancel found when the node no longer keeps its
// state cannot be told apart, after a reload or on any later press. The page never says it completed. A later press on
// the one-token deposit says it could not confirm the swap; only the person's word, after checking their wallet, lets the
// journal go, and a fresh quote is reviewed before one swap is sent.
// Changed on purpose in fix round 3.1: the sentence says what this deposit needs, never that the wallet holds none of it;
// and the cancel is found after a reload (the search no longer gives up at a refused read, so a cancel in the newest block
// is found in the same press: the case below).
test('an ETH-input routed swap cancelled in the wallet after a reload, on a node that no longer keeps that state, cannot be told apart: the page never says it completed, and only the person’s word that it did not go through leads to a reviewed new quote and one swap', { timeout: 240_000 }, async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, keptBlocks: 4 });
  chain.holdInWallet('execute');
  const s = await atReview(chain, { routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  const release = s.page.locator('[data-create-route-release]');
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    assert.equal(s.onboarding.calls('swap-route')[0].body.tokenIn, zeroAddress, 'ETH in');
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('domino.routed-offer.v1.') && /\|0x/.test(localStorage.getItem(key))), null, { timeout: 60_000 });
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    chain.cancelHeld();
    chain.mine(12);
    await walkToReview(s.page, {});
    await s.page.locator('[data-create-position="idle"]').click();
    const unknown = s.page.locator('[data-create-notice="route_replaced_unknown"]');
    await unknown.waitFor({ timeout: 60_000 });
    assert.doesNotMatch(await unknown.innerText(), /completed|fee was collected/);
    assert.ok(chain.pruned.length > 0, 'the old state was refused');
    assert.ok(chain.log.includes('eth_getLogs'), 'the logs were asked, and show no swap (a cancel pays nothing)');
    assert.equal((await records(s.page)).length, 2, 'the journal stays');
    assert.equal(await release.count(), 0, 'no way out before a press finds the wallet short of the other token');
    // The next press: the wallet holds only ETH, so the deposit needs a swap. It used to say the swap completed.
    await s.page.locator('[data-create-position="failed"]').click();
    const unconfirmed = s.page.locator('[data-create-notice="route_unconfirmed"]');
    await unconfirmed.waitFor({ timeout: 60_000 });
    assert.match(await unconfirmed.innerText(), /^We could not confirm whether your earlier Uniswap swap went through\. Check your wallet activity\. If it went through, what you received is in your wallet, and this deposit needs more TOKEN than your wallet holds now/);
    assert.doesNotMatch(await unconfirmed.innerText(), /completed|fee was collected|does not hold/);
    assert.equal(await s.page.locator('#create-reason').innerText(), 'Check your wallet activity before you continue.');
    assert.equal(s.onboarding.calls('swap-route').length, 1, 'nothing quoted');
    assert.equal((await records(s.page)).length, 2, 'the journal stays until the person says so');
    await release.click();
    await s.page.locator('[data-create-notice="route_released"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(await records(s.page), [], 'let go on the person’s word');
    assert.equal(routerCalls().length, 0, 'nothing sent');
    assert.equal(await release.count(), 0);
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    assert.equal(s.onboarding.calls('swap-route').length, 2, 'a fresh quote, reviewed before anything is signed');
    assert.equal(routerCalls().length, 0);
    await s.page.locator('[data-create-position="failed"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.equal(routerCalls().length, 1, 'one swap, after its review');
    assert.deepEqual(await records(s.page), []);
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 3.1 (2026-10-01), the recheck's low finding: the search for the transaction at the nonce gave up at its first
// refused read. On a node that keeps the state of the newest block only, an ETH-input cancel there is now found in the
// same press: the journal is let go, and nothing is sent again on its own.
test('an ETH-input routed swap cancelled in the wallet, on a node that keeps only the newest block’s state, is found at once above the state refused: the journal is let go and nothing is sent again', { timeout: 150_000 }, async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, keptBlocks: 0 });
  chain.cancelInWallet('execute');
  const s = await atReview(chain, { routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    const said = s.page.locator('[data-create-notice="route_replaced"]');
    await said.waitFor({ timeout: 60_000 });
    assert.match(await said.innerText(), /^Your wallet replaced the Uniswap swap with another transaction, so this swap did not happen/);
    assert.ok(chain.pruned.length > 0, 'a read under the newest block was refused, and the search went on above it');
    assert.deepEqual(await records(s.page), [], 'its journal and nonce are let go');
    assert.equal(routerCalls().length, 0, 'the swap never happened, and nothing is sent again on its own');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 3.1 (2026-10-01), the recheck's high finding (case B): an ETH-input speed-up found after old state is gone read
// `unknown` (no allowance to read) and offered "It did not go through". The reviewed router call is found by the TOKEN it
// paid the wallet: it completed, and no way to a second swap is offered.
test('an ETH-input routed swap sped up in the wallet, on a node that keeps no old state, is found by the TOKEN it paid the wallet: completed in the same press and after a reload, with no second swap', { timeout: 180_000 }, async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, keptBlocks: 0 });
  chain.speedUp('execute');
  chain.decline('open');
  const s = await atReview(chain, { routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    assert.equal(s.onboarding.calls('swap-route')[0].body.tokenIn, zeroAddress, 'ETH in');
    await s.page.locator('[data-create-position="failed"]').click();
    // Even in the same press the node keeps no state of the replacement's block: the TOKEN it paid tells it.
    await s.page.locator('[data-create-notice]', { hasText: 'The Uniswap swap completed and its fee was collected.' }).waitFor({ timeout: 60_000 });
    assert.ok(chain.pruned.length > 0, 'the old state was refused');
    assert.equal(routerCalls().length, 1);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await walkToReview(s.page, {});
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_recovered"]').waitFor({ timeout: 60_000 });
    assert.equal(await s.page.locator('[data-create-route-release]').count(), 0);
    assert.equal((await records(s.page)).length, 2);
    await s.page.locator('[data-create-position="failed"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.equal(routerCalls().length, 1, 'no second swap');
    assert.equal(s.onboarding.calls('swap-route').length, 1, 'no fresh quote');
    assert.deepEqual(chain.decoded().filter(call => call.to === chain.release.deployment.setup).map(call => call.functionName), ['open', 'mint'], 'no swap in Setup either');
    assert.deepEqual(await records(s.page), [], 'its journal is let go once the position exists');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 3.1 (2026-10-01), the recheck's high finding: a swap offered to the wallet whose hash never came back (here the
// page is reloaded while the wallet shows it) was claimed with no nonce, and every later press of the wallet in this
// browser, both-token deposits too, stopped for good with "Domino will not offer it again". Its nonce is now kept with
// the claim. While it is still free, the page asks the person; once the swap is approved, what took the nonce is read:
// the reviewed call, completed, and no second swap.
test('a routed Uniswap swap the wallet never answered before a reload is never held for good: while its nonce is free the page asks, and approved later it is found as the swap, completed, with no second swap', { timeout: 180_000 }, async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 2n * typed } });
  chain.stallInWallet('execute');
  const s = await atReview(chain, { amount: '10000000000', routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    // The claim and its nonce are kept before the wallet is asked; the wallet never answers.
    await s.page.waitForFunction(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')).length === 2, null, { timeout: 60_000 });
    await until(() => chain.stalled.length === 1, 'the wallet to hold the swap', 60_000);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await walkToReview(s.page, { amount: '10000000000' });
    await s.page.locator('[data-create-position="idle"]').click();
    const open = s.page.locator('[data-create-notice="wallet_request_open"]');
    await open.waitFor({ timeout: 60_000 });
    // Changed on purpose in fix round 3.2: it may be another tab's offer, and closing a dialog here rejects nothing.
    assert.equal(await open.innerText(), 'Your wallet may still be showing a Uniswap swap that Domino offered, in this tab or another. Approve or reject it there. If you rejected it there, say so below.');
    await s.page.locator('[data-create-forget-request]').waitFor();
    assert.equal((await records(s.page)).length, 2, 'nothing let go while the swap may still be signed');
    // The person approves it in the wallet after all: it is mined at the nonce kept, and the page never heard its hash.
    chain.approveStalled();
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice="route_recovered"]').waitFor({ timeout: 60_000 });
    assert.equal(routerCalls().length, 1);
    await s.page.locator('[data-create-position="failed"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.equal(routerCalls().length, 1, 'no second swap');
    assert.equal(s.onboarding.calls('swap-route').length, 1, 'no fresh quote');
    assert.deepEqual(chain.decoded().filter(call => call.to === chain.release.deployment.setup).map(call => call.functionName), ['open', 'mint'], 'no swap in Setup either');
    assert.deepEqual(await records(s.page), [], 'its journal is let go once the position exists');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 3.1 (2026-10-01): the same swap the wallet never answered, rejected there. The person says so; its nonce is
// still free with nothing pending, so the journal is let go and nothing is sent.
// Changed on purpose in fix round 3.2 (2026-10-02): the wallet may still show it after all (a phone wallet keeps a request
// that a dialog closed here never rejected), and it can go through until its router deadline: for an ETH input a second
// swap would then run too. A new Uniswap route waits until that time, said in the notice; the pool's own assisted swap
// does not wait, and makes this position.
test('a routed Uniswap swap the wallet never answered, rejected there: “I rejected it in my wallet” lets its journal go while its nonce is free; until its deadline no new Uniswap swap is offered, and the pool’s own assisted swap makes the position', { timeout: 180_000 }, async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 2n * typed } });
  chain.stallInWallet('execute');
  const s = await atReview(chain, { amount: '10000000000', routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  const holds = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-hold.v1.')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.waitForFunction(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')).length === 2, null, { timeout: 60_000 });
    await until(() => chain.stalled.length === 1, 'the wallet to hold the swap', 60_000);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await walkToReview(s.page, { amount: '10000000000' });
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="wallet_request_open"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-forget-request]').click();
    const forgotten = s.page.locator('[data-create-notice="request_forgotten"]');
    await forgotten.waitFor({ timeout: 30_000 });
    assert.match(await forgotten.innerText(), /^Nothing was sent\. Press Create position to continue\. A new Uniswap swap can be offered after \d{1,2}:\d{2}\s?[AP]M, when the one you rejected can no longer go through\.$/);
    assert.deepEqual(await records(s.page), [], 'let go on the person’s word, its nonce still free');
    assert.equal((await holds(s.page)).length, 1, 'a new Uniswap route waits for the deadline');
    assert.equal(routerCalls().length, 0, 'nothing sent');
    // Before the deadline: the pool fills the swap itself, and no Uniswap route is asked for.
    await s.page.locator('[data-create-position="failed"]').click();
    await openCreated(s.page, '4242', 90_000);
    assert.equal(s.onboarding.calls('swap-route').length, 1, 'no new route before the deadline');
    assert.equal(routerCalls().length, 0, 'no Uniswap swap');
    assert.deepEqual(chain.decoded().filter(call => call.to === chain.release.deployment.setup).map(call => call.functionName), ['open', 'swap', 'mint'], 'the pool’s own assisted swap');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

/** Fix round 3.2: the hold on a new Uniswap route as if its time had passed a minute ago on the chain's clock. */
const pastHold = page => page.evaluate(() => {
  const key = Object.keys(localStorage).find(name => name.startsWith('domino.routed-hold.v1.'));
  localStorage.setItem(key, String(Math.floor(Date.now() / 1000) - 60));
});

// Fix round 3.2 (2026-10-02): the same, in a pool that cannot fill the swap itself, so only the Uniswap route could serve
// the deposit. Until the rejected swap's deadline the page says why none is offered, and when; after it, a fresh quote is
// reviewed and one swap sent.
test('a routed Uniswap swap rejected in the wallet after a reload, in a pool that cannot fill the swap itself: the page says no new Uniswap swap is offered until its deadline, then reviews a fresh quote and swaps once', { timeout: 240_000 }, async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, liquidity: 0n });
  chain.stallInWallet('execute');
  const s = await atReview(chain, { routedQuote: chosenRoute(chain) });
  const holds = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-hold.v1.')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    await until(() => chain.stalled.length === 1, 'the wallet to hold the swap', 60_000);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await walkToReview(s.page, {});
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="wallet_request_open"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-forget-request]').click();
    await s.page.locator('[data-create-notice="request_forgotten"]').waitFor({ timeout: 30_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    const held = s.page.locator('[data-create-notice="pool_no_liquidity"]');
    await held.waitFor({ timeout: 60_000 });
    assert.match(await held.innerText(), /^This pool has no liquidity at its current price[\s\S]*The Uniswap swap you said you rejected could still go through until \d{1,2}:\d{2}\s?[AP]M if your wallet still shows it, so no new Uniswap swap is offered before then\.$/);
    assert.equal(s.onboarding.calls('swap-route').length, 1, 'no new route before the deadline');
    // Past its deadline on the chain's clock: the hold goes, and a fresh quote is reviewed before one swap is sent. (The
    // deadline is moved into the past rather than the chain's clock ahead: the pool's own check refuses a device clock
    // far off the chain's, and this press reaches it.)
    await pastHold(s.page);
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    assert.equal(s.onboarding.calls('swap-route').length, 2, 'a fresh quote');
    assert.deepEqual(await holds(s.page), [], 'the hold is let go once its time has passed');
    await s.page.locator('[data-create-position="failed"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.equal(routerCalls().length, 1, 'one swap, after its review');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

/** Fix round 3.1: the journal's record as if kept for a deposit in another pool (its pool digest another pool's). */
const fromAnotherPool = page => page.evaluate(() => {
  const key = Object.keys(localStorage).find(name => name.startsWith('domino.routed-offer-nonce.v1.'));
  const parts = localStorage.getItem(key).split('|');
  parts[6] = '0x' + '99'.repeat(32);
  localStorage.setItem(key, parts.join('|'));
});

/** Fix round 3.2: the pool digest the journal kept for the swap, as written for this pool. */
const keptPool = page => page.evaluate(() => {
  const key = Object.keys(localStorage).find(name => name.startsWith('domino.routed-offer-nonce.v1.'));
  return localStorage.getItem(key).split('|')[6];
});
/** Fix round 3.2: the record moved aside, as if for the pool of digest `pool` (this pool's, read with keptPool). */
const parkedFor = (page, pool) => page.evaluate(digest => {
  const key = Object.keys(localStorage).find(name => name.startsWith('domino.routed-parked.v1.'));
  const parts = localStorage.getItem(key).split('|');
  parts[7] = digest;
  localStorage.setItem(key, parts.join('|'));
}, pool);
const parkedKeys = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-parked.v1.')));
/** Fix round 3.2: the journal's record as if its router deadline had passed a minute ago on the chain's clock. */
const pastDeadline = page => page.evaluate(() => {
  const key = Object.keys(localStorage).find(name => name.startsWith('domino.routed-offer-nonce.v1.'));
  const parts = localStorage.getItem(key).split('|');
  parts[7] = String(Math.floor(Date.now() / 1000) - 60);
  localStorage.setItem(key, parts.join('|'));
});

// Fix round 3.1 (2026-10-01), the recheck's medium finding: a routed swap known to have gone through, never followed by a
// mint, stopped every one-token deposit in every pool for good, saying to use "both tokens now in your wallet" of a pool it
// had nothing to do with. The record keeps the pool it was for: in another pool it is said once, and that deposit goes on
// as with no earlier swap (a fresh quote, reviewed).
// Changed on purpose in fix round 3.2 (2026-10-02), the recheck's finding: its record was let go there, and back in its own
// pool the same one-token deposit could be offered a second swap and fee. It is now moved aside for its pool, never let
// go: this deposit still goes on, and back in its own pool the record still holds that deposit to the wallet's balances.
test('a routed Uniswap swap that went through for another pool’s deposit is said once and moved aside: this deposit goes on as with no earlier swap, and back in its own pool no second swap is offered', { timeout: 240_000 }, async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 4n * typed } });
  chain.speedUp('execute');
  chain.decline('open');
  const s = await atReview(chain, { amount: '10000000000', routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice]', { hasText: 'The Uniswap swap completed and its fee was collected.' }).waitFor({ timeout: 60_000 });
    const own = await keptPool(s.page);
    await fromAnotherPool(s.page);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await walkToReview(s.page, { amount: '20000000000' });
    await s.page.locator('[data-create-position="idle"]').click();
    const said = s.page.locator('[data-create-notice="route_recovered_elsewhere"]');
    await said.waitFor({ timeout: 60_000 });
    assert.match(await said.innerText(), /^Your earlier Uniswap swap, for a deposit in another pool, went through: what you received is in your wallet, and that pool’s deposit uses it without another swap\./);
    assert.doesNotMatch(await said.innerText(), /both wallet balances|both tokens/);
    assert.deepEqual(await records(s.page), [], 'out of the slot');
    assert.equal((await parkedKeys(s.page)).length, 1, 'moved aside for its own pool, never let go');
    // This deposit needs a swap: it is quoted and reviewed as any, never stopped by the other pool's swap.
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    assert.equal(s.onboarding.calls('swap-route').length, 2, 'a fresh quote for this deposit');
    // Back in its own pool, the same one-token deposit: the record moved aside still guards it.
    await parkedFor(s.page, own);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await walkToReview(s.page, { amount: '20000000000' });
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_recovered"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    const balances = s.page.locator('[data-create-notice="route_use_balances"]');
    await balances.waitFor({ timeout: 60_000 });
    assert.match(await balances.innerText(), /^Your earlier Uniswap swap completed\. Use both tokens now in your wallet[\s\S]*No second swap will be sent\./);
    assert.equal(s.onboarding.calls('swap-route').length, 2, 'no fresh quote for the deposit the swap was for');
    assert.equal(routerCalls().length, 1, 'no second swap');
    assert.equal(await s.page.locator('[data-create-route-release]').count(), 0);
    assert.equal((await parkedKeys(s.page)).length, 1, 'still held for its pool');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 3.1 (2026-10-01): a replaced swap nothing could tell apart, kept for another pool's deposit, guards that pool
// only. Here it says nothing: this deposit is made with the pool's own assisted swap (the Uniswap route waits, since the
// journal holds one routed swap at a time), and the record stays for its own pool, untouched by this mint.
test('a replaced routed swap not told apart, kept for another pool’s deposit, holds up nothing here: the pool’s own assisted swap makes this position, and the record stays for its pool', { timeout: 240_000 }, async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, keptBlocks: 4 });
  chain.holdInWallet('execute');
  const s = await atReview(chain, { routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('domino.routed-offer.v1.') && /\|0x/.test(localStorage.getItem(key))), null, { timeout: 60_000 });
    await fromAnotherPool(s.page);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    // Cancelled in the wallet, found when the node no longer keeps that state, with no allowance to read (ETH in): not told apart.
    chain.cancelHeld();
    chain.mine(12);
    await walkToReview(s.page, {});
    await s.page.locator('[data-create-position="idle"]').click();
    await openCreated(s.page, '4242', 90_000);
    assert.ok(chain.pruned.length > 0, 'the old state was refused');
    assert.equal(routerCalls().length, 0, 'no Uniswap swap');
    assert.equal(s.onboarding.calls('swap-route').length, 1, 'no new route asked');
    assert.deepEqual(chain.decoded().filter(call => call.to === chain.release.deployment.setup).map(call => call.functionName), ['open', 'swap', 'mint'], 'the pool’s own assisted swap');
    assert.equal(await s.page.locator('[data-create-notice="route_unconfirmed"]').count(), 0);
    assert.equal((await records(s.page)).length, 2, 'the record stays for its own pool');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 3.2 (2026-10-02), the recheck's finding: a record for another pool's deposit that may still go through turned
// off the Uniswap route here without a word; in a pool that cannot fill the swap itself the deposit failed on the pool's
// reason alone, and the record was never settled from here. The page now says the route waits for it and until when;
// once its deadline has passed on the chain's clock it is moved aside for its own pool, and a fresh quote is reviewed.
test('a replaced routed swap not told apart, kept for another pool’s deposit, in a pool that cannot fill the swap itself: the page says the Uniswap route waits and until when; after its deadline it is moved aside and a fresh quote is reviewed here', { timeout: 240_000 }, async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, keptBlocks: 4, liquidity: 0n });
  chain.holdInWallet('execute');
  const s = await atReview(chain, { routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('domino.routed-offer.v1.') && /\|0x/.test(localStorage.getItem(key))), null, { timeout: 60_000 });
    await fromAnotherPool(s.page);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    chain.cancelHeld();
    chain.mine(12);
    await walkToReview(s.page, {});
    await s.page.locator('[data-create-position="idle"]').click();
    const said = s.page.locator('[data-create-notice="pool_no_liquidity"]');
    await said.waitFor({ timeout: 90_000 });
    assert.match(await said.innerText(), /^This pool has no liquidity at its current price[\s\S]*An earlier Uniswap swap, for a deposit in another pool, could still go through until \d{1,2}:\d{2}\s?[AP]M, so no new Uniswap swap is offered here before then\.$/);
    assert.equal(s.onboarding.calls('swap-route').length, 1, 'no route asked while it may still go through');
    assert.equal((await records(s.page)).length, 2, 'the record stays for its own pool');
    // Past its deadline on the chain's clock: it can never go through, and it is moved aside for its pool. (Its deadline
    // is moved into the past rather than the chain's clock ahead: the pool's own check refuses a device clock far off.)
    await pastDeadline(s.page);
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    assert.equal(s.onboarding.calls('swap-route').length, 2, 'a fresh quote here');
    assert.deepEqual(await records(s.page), [], 'out of the slot');
    assert.equal((await parkedKeys(s.page)).length, 1, 'still kept for its own pool');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 3.2 (2026-10-02), the recheck's high finding: a swap the wallet never answered, whose nonce another transaction
// of the wallet's then took. Nothing proves it was replaced: the wallet may still show it, and sign it under the next nonce.
// It used to be said as replaced, and "It did not go through" was offered; the old request could then still run, a second
// swap and fee for one deposit. No new swap is offered until its router deadline; approved meanwhile, it is the swap.
test('a routed Uniswap swap the wallet never answered, whose nonce another transaction took: never said replaced, no way to a new swap before its deadline, and approved late it is found as the swap', { timeout: 240_000 }, async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true });
  chain.stallInWallet('execute');
  const s = await atReview(chain, { routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  const release = s.page.locator('[data-create-route-release]');
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    await until(() => chain.stalled.length === 1, 'the wallet to hold the swap', 60_000);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    // Another transaction of the wallet's, shaped as a Cancel, takes the nonce kept for the swap.
    chain.burnNonce();
    await walkToReview(s.page, {});
    await s.page.locator('[data-create-position="idle"]').click();
    const waiting = s.page.locator('[data-create-notice="route_waiting"]');
    await waiting.waitFor({ timeout: 60_000 });
    assert.match(await waiting.innerText(), /^Another transaction from your wallet went out in place of the Uniswap swap this page offered, and your wallet may still be showing that swap: reject it there if it is\. It can go through only until \d{1,2}:\d{2}\s?[AP]M/);
    assert.doesNotMatch(await waiting.innerText(), /replaced/);
    assert.equal((await records(s.page)).length, 2, 'nothing let go');
    assert.equal(await release.count(), 0);
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice="route_waiting"]').waitFor({ timeout: 60_000 });
    assert.equal(await release.count(), 0, 'no way to a new swap before its deadline');
    assert.equal(s.onboarding.calls('swap-route').length, 1);
    // The person approves it after all: the wallet signs it under the next nonce, and it pays the wallet its TOKEN.
    chain.approveStalled();
    await s.page.locator('[data-create-position="failed"]').click();
    await openCreated(s.page, '4242', 90_000);
    assert.equal(routerCalls().length, 1, 'no second swap');
    assert.equal(s.onboarding.calls('swap-route').length, 1, 'no fresh quote');
    assert.deepEqual(chain.decoded().filter(call => call.to === chain.release.deployment.setup).map(call => call.functionName), ['open', 'mint'], 'no swap in Setup either');
    assert.deepEqual(await records(s.page), []);
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});
test('a routed Uniswap swap the wallet never answered, whose nonce another transaction took, never approved: once its deadline has passed on the chain’s clock, the person’s word leads to a reviewed new quote and one swap', { timeout: 240_000 }, async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true });
  chain.stallInWallet('execute');
  const s = await atReview(chain, { routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  const release = s.page.locator('[data-create-route-release]');
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    await until(() => chain.stalled.length === 1, 'the wallet to hold the swap', 60_000);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    chain.burnNonce();
    await walkToReview(s.page, {});
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_waiting"]').waitFor({ timeout: 60_000 });
    chain.later(1_900);
    await s.page.locator('[data-create-position="failed"]').click();
    const unconfirmed = s.page.locator('[data-create-notice="route_unconfirmed"]');
    await unconfirmed.waitFor({ timeout: 60_000 });
    assert.match(await unconfirmed.innerText(), /^We could not confirm whether your earlier Uniswap swap went through\./);
    assert.equal((await records(s.page)).length, 2, 'kept until the person says so');
    await release.click();
    await s.page.locator('[data-create-notice="route_released"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(await records(s.page), []);
    chain.later(0);
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    assert.equal(s.onboarding.calls('swap-route').length, 2, 'a fresh quote, reviewed before anything is signed');
    await s.page.locator('[data-create-position="failed"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.equal(routerCalls().length, 1, 'one swap, after its review');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 3.2 (2026-10-02), the recheck's finding: a swap the wallet signed, its hash back, that the chain never shows,
// its nonce still free, stopped every press in every pool, both-token deposits too, with no way out. It may still reach
// the network until its deadline: only this deposit's swap waits; after the deadline, the person's word.
test('a routed Uniswap swap signed with its hash back that the chain never shows, its nonce still free: only this deposit’s swap waits until its deadline, then the person’s word leads to a reviewed new quote and one swap', { timeout: 240_000 }, async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 2n * typed } });
  chain.holdInWallet('execute');
  const s = await atReview(chain, { amount: '10000000000', routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  const release = s.page.locator('[data-create-route-release]');
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('domino.routed-offer.v1.') && /\|0x/.test(localStorage.getItem(key))), null, { timeout: 60_000 });
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await walkToReview(s.page, { amount: '10000000000' });
    await s.page.locator('[data-create-position="idle"]').click();
    const unseen = s.page.locator('[data-create-notice="route_waiting"]');
    await unseen.waitFor({ timeout: 60_000 });
    assert.match(await unseen.innerText(), /^Your wallet signed the Uniswap swap, and the network does not show it yet\. It can still go through until \d{1,2}:\d{2}\s?[AP]M/);
    assert.equal(await release.count(), 0);
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice="route_waiting"]').waitFor({ timeout: 60_000 });
    assert.equal(await release.count(), 0, 'no way to a new swap before its deadline');
    assert.equal(s.onboarding.calls('swap-route').length, 1);
    assert.equal((await records(s.page)).length, 2);
    chain.later(1_900);
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice="route_unconfirmed"]').waitFor({ timeout: 60_000 });
    await release.click();
    await s.page.locator('[data-create-notice="route_released"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(await records(s.page), []);
    chain.later(0);
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    assert.equal(s.onboarding.calls('swap-route').length, 2, 'a fresh quote');
    await s.page.locator('[data-create-position="failed"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.equal(routerCalls().length, 1, 'one swap, after its review: the signed one never reached the chain');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 3.2 (2026-10-02), the recheck's finding: a replaced swap after which the wallet used Uniswap otherwise (its
// Permit2 allowance set again) was `changed` for good: one-token deposits in its pool and the Uniswap route everywhere
// stayed off. It holds only until the router call's deadline; then the person's word, after checking their wallet.
test('a replaced routed swap after which the wallet used Uniswap otherwise holds only until its deadline: then the person’s word leads to a reviewed new quote and one swap', { timeout: 240_000 }, async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 2n * typed }, keptBlocks: 4 });
  chain.holdInWallet('execute');
  const s = await atReview(chain, { amount: '10000000000', routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  const release = s.page.locator('[data-create-route-release]');
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('domino.routed-offer.v1.') && /\|0x/.test(localStorage.getItem(key))), null, { timeout: 60_000 });
    const [amount, expiration] = chain.permitOf(FIXTURE_TOKEN);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    chain.cancelHeld();
    // The Uniswap app sets the router's allowance again meanwhile, until another time.
    chain.setPermit(FIXTURE_TOKEN, amount, expiration + 60);
    chain.mine(12);
    await walkToReview(s.page, { amount: '10000000000' });
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_replaced_unknown"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    const changed = s.page.locator('[data-create-notice="route_changed"]');
    await changed.waitFor({ timeout: 60_000 });
    assert.match(await changed.innerText(), /the chain shows your wallet used Uniswap since\. It can go through only until \d{1,2}:\d{2}\s?[AP]M, so no new swap is offered for this deposit before then\./);
    assert.equal(await release.count(), 0, 'never on the person’s word while it could still go through');
    chain.later(1_900);
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice="route_unconfirmed"]').waitFor({ timeout: 60_000 });
    assert.equal((await records(s.page)).length, 2);
    await release.click();
    await s.page.locator('[data-create-notice="route_released"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(await records(s.page), []);
    chain.later(0);
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    assert.equal(s.onboarding.calls('swap-route').length, 2, 'a fresh quote');
    await s.page.locator('[data-create-position="failed"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.equal(routerCalls().length, 1, 'one swap, after its review');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 3.2 (2026-10-02), the recheck's findings: a cancel, then Permit2's lockdown (what revoke tools call), leaves the
// router's allowance exactly as the swap leaves it, and the page said "the swap went through". It now says what the chain
// shows and never that; every guard of a completed swap stays.
test('a routed Uniswap swap cancelled in the wallet, then its Permit2 allowance revoked: the allowance reads as a swap leaves it, so no second swap is offered, and the page never says the swap went through', { timeout: 240_000 }, async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 4n * typed }, keptBlocks: 4 });
  chain.holdInWallet('execute');
  const s = await atReview(chain, { amount: '10000000000', routedQuote: chosenRoute(chain) });
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.waitForFunction(() => Object.keys(localStorage).some(key => key.startsWith('domino.routed-offer.v1.') && /\|0x/.test(localStorage.getItem(key))), null, { timeout: 60_000 });
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    chain.cancelHeld();
    chain.lockdown(FIXTURE_TOKEN);
    chain.mine(12);
    await walkToReview(s.page, { amount: '20000000000' });
    await s.page.locator('[data-create-position="idle"]').click();
    const said = s.page.locator('[data-create-notice="route_spent"]');
    await said.waitFor({ timeout: 60_000 });
    assert.match(await said.innerText(), /The chain shows Uniswap can no longer take the amount your earlier Uniswap swap was to spend, as after a swap that went through/);
    assert.doesNotMatch(await said.innerText(), /the swap went through|took from your wallet/);
    await s.page.locator('[data-create-position="failed"]').click();
    const balances = s.page.locator('[data-create-notice="route_use_balances"]');
    await balances.waitFor({ timeout: 60_000 });
    assert.match(await balances.innerText(), /^Your earlier Uniswap swap may have gone through/);
    assert.equal(await s.page.locator('[data-create-route-release]').count(), 0);
    assert.equal(routerCalls().length, 0, 'nothing swapped');
    assert.equal(s.onboarding.calls('swap-route').length, 1, 'no fresh quote');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 3.2 (2026-10-02), the recheck's high finding: the fix of 3.1 held only on a wallet RPC that serves numbered
// state and logs at any depth. On dRPC (state at 'latest' only, logs over 200 blocks refused) a speed-up found after a
// reload read `unknown`, and "It did not go through" was offered. Its allowance, read at 'latest', reads spent.
test('a sped-up routed Uniswap swap found after a reload on a wallet RPC that answers state at latest only (dRPC): its allowance reads spent at latest, so a later one-token press offers no way to a second swap', { timeout: 240_000 }, async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 4n * typed } });
  chain.speedUp('execute');
  chain.decline('open');
  const s = await atReview(chain, { amount: '10000000000', routedQuote: chosenRoute(chain) });
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice]', { hasText: 'The Uniswap swap completed and its fee was collected.' }).waitFor({ timeout: 60_000 });
    // The wallet now reads through dRPC, and the swap is 300 blocks old: past dRPC's log span.
    chain.profile('drpc');
    chain.mine(300);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await walkToReview(s.page, { amount: '20000000000' });
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_spent"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice="route_use_balances"]').waitFor({ timeout: 60_000 });
    assert.equal(await s.page.locator('[data-create-route-release]').count(), 0, 'no “It did not go through”');
    assert.equal(await s.page.locator('[data-create-notice="route_unconfirmed"]').count(), 0);
    assert.equal(routerCalls().length, 1, 'no second swap');
    assert.equal(s.onboarding.calls('swap-route').length, 1, 'no fresh quote');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 3.2 (2026-10-02), the same finding, said plainly: an ETH input has no allowance to read, and publicnode serves
// logs only about 100 blocks back and little state. A speed-up found after that cannot be told apart: the page never says
// it completed or failed, asks the person to check their wallet, and only their word leads to a reviewed new quote.
test('an ETH-input routed swap sped up, found after a reload on publicnode (logs about 100 blocks back, little state): it cannot be told apart, said plainly, and only the person’s word leads to a new quote', { timeout: 240_000 }, async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, keptBlocks: 30, eth: 10n ** 19n });
  chain.speedUp('execute');
  chain.decline('open');
  const s = await atReview(chain, { routedQuote: chosenRoute(chain) });
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice]', { hasText: 'The Uniswap swap completed and its fee was collected.' }).waitFor({ timeout: 60_000 });
    chain.profile('publicnode');
    chain.mine(200);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    // Twice the amount: what the swap paid does not cover it, so this deposit needs a swap.
    await walkToReview(s.page, { amount: '2' });
    await s.page.locator('[data-create-position="idle"]').click();
    const unknown = s.page.locator('[data-create-notice="route_replaced_unknown"]');
    await unknown.waitFor({ timeout: 60_000 });
    assert.match(await unknown.innerText(), /we could not confirm what your wallet did\. Check your wallet activity/);
    assert.doesNotMatch(await unknown.innerText(), /completed|did not happen/);
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice="route_unconfirmed"]').waitFor({ timeout: 60_000 });
    assert.match(await s.page.locator('[data-create-notice="route_unconfirmed"]').innerText(), /^We could not confirm whether your earlier Uniswap swap went through\. Check your wallet activity\. If it went through, what you received is in your wallet/);
    assert.ok(chain.pruned.length > 0, 'the old state was refused');
    assert.equal(routerCalls().length, 1, 'nothing sent again on its own');
    assert.equal(s.onboarding.calls('swap-route').length, 1, 'nothing quoted before the person says so');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

// Fix round 3 (2026-10-01): a speed-up whose replacement reverts, in the same press. The router call at the nonce is
// read with its receipt: it reverted, so nothing was swapped and no fee collected; the journal is let go and the next
// press reviews a fresh quote before one swap is sent.
test('a routed Uniswap swap sped up in the wallet whose replacement reverts is said as reverted at once, lets go of its journal, and the next press reviews again and swaps once', { timeout: 150_000 }, async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 2n * typed } });
  chain.speedUp('execute');
  chain.revert('execute');
  const s = await atReview(chain, { amount: '10000000000', routedQuote: chosenRoute(chain) });
  const records = page => page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.routed-offer')));
  const routerCalls = () => chain.decoded().filter(call => call.to === UNIVERSAL_ROUTER);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    await s.page.locator('[data-create-position="failed"]').click();
    const said = s.page.locator('[data-create-notice="route_reverted"]');
    await said.waitFor({ timeout: 60_000 });
    assert.match(await said.innerText(), /^Your wallet replaced the Uniswap swap, and the replacement reverted\. Nothing was swapped and no swap fee was collected; network gas was spent\./);
    assert.equal(routerCalls().length, 1, 'the reverted replacement');
    assert.equal(chain.permitOf(FIXTURE_TOKEN)[0], BigInt(s.onboarding.calls('swap-route')[0].body.amountRaw), 'nothing spent');
    assert.deepEqual(await records(s.page), [], 'its journal and nonce are let go');
    assert.deepEqual(chain.decoded().filter(call => call.to === chain.release.deployment.setup), [], 'nothing deposited');
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor({ timeout: 60_000 });
    assert.equal(s.onboarding.calls('swap-route').length, 2, 'a fresh quote');
    await s.page.locator('[data-create-position="failed"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.equal(routerCalls().length, 2, 'the reverted one, and one swap after its review');
    assert.equal(chain.permitOf(FIXTURE_TOKEN)[0], 0n, 'one swap spent its allowance');
    assert.deepEqual(chain.decoded().filter(call => call.to === chain.release.deployment.setup).map(call => call.functionName), ['open', 'mint'], 'no swap in Setup');
    assert.deepEqual(await records(s.page), []);
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

test('routed Create position keeps the selected-pool path on a failed quote and blocks a valid zero-output pool decision before any wallet offer', { timeout: 150_000 }, async () => {
  for (const empty of [false, true]) {
    const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, atomic: 'supported' });
    const s = await atReview(chain, { routedQuote: null });
    try {
      if (empty) s.onboarding.controls.swapRoute = ({ request, now }) => {
        const p = JSON.parse(readFileSync(new URL('../../api-contracts/onboarding-v1/fixtures/variants/swap-route.unavailable.json', import.meta.url))).preview;
        const gross = BigInt(request.amountRaw), fee = gross * 65n / 10000n;
        Object.assign(p, { request, requestedAt: now, retrievedAt: now, expiresAt: now + 30, tokenOut: request.tokenIn === request.poolKey.currency0 ? request.poolKey.currency1 : request.poolKey.currency0 });
        Object.assign(p.pool, { amountInRaw: String(gross), feeRaw: String(fee), netInputRaw: String(gross - fee), amountOutRaw: '0' });
        return p;
      };
      else s.onboarding.failNext('swap-route', 'provider_unavailable');
      await s.page.locator('[data-create-position="idle"]').click();
      if (empty) {
        await s.page.locator('[data-create-notice="pool_no_liquidity"]').waitFor({ timeout: 60_000 });
        assert.deepEqual([chain.sends, chain.batches], [[], []]);
      } else {
        await openCreated(s.page, '4242', 60_000);
        assert.deepEqual(batchCalls(chain, chain.batches[0]).filter(call => call.to === chain.release.deployment.setup).map(call => call.functionName), ['open', 'swap', 'mint']);
        assert.equal(batchCalls(chain, chain.batches[0]).some(call => call.to === UNIVERSAL_ROUTER), false);
      }
      assert.equal(s.onboarding.calls('swap-route').length, 1);
      assert.deepEqual(s.onboarding.state.violations, []);
      assert.deepEqual(chain.missing, []);
    } finally { await s.close(); }
  }
});

test('routed Create position quarantines an unknown atomic offer across reload and cannot switch to a second sequential swap', { timeout: 120_000 }, async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, atomic: 'supported', eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 2n * typed }, batchError: { code: -32603, message: 'The wallet connection ended after the offer.' } });
  const s = await atReview(chain, { amount: '10000000000', routedQuote: chosenRoute(chain) });
  const offers = () => chain.log.filter(method => method === 'wallet_sendCalls').length;
  const records = page => page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('domino.routed-offer.v1.')));
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor();
    await s.page.locator('[data-create-position="failed"]').click();
    await s.page.locator('[data-create-notice]:not([data-create-notice="route_review_required"])').waitFor();
    await s.page.locator('[data-create-position="failed"]').waitFor();
    assert.equal(offers(), 1, 'one wallet offer whose reply was lost is not an explicit rejection');
    const saved = await records(s.page);
    assert.equal(saved.length, 1);
    assert.match(saved[0][0], /^domino\.routed-offer\.v1\.[0-9a-f]{64}$/);
    assert.match(saved[0][1], /^[0-9a-f-]{36}\|b:0x[0-9a-f]{64}$/, 'only the claim and public Setup operation id survive');
    assert.deepEqual(chain.sends, []);
    chain.setAtomic(null);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await walkToReview(s.page, { amount: '10000000000' });
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="batch_unknown"]').waitFor({ timeout: 30_000 });
    assert.equal(offers(), 1, 'reload cannot offer the unknown batch again');
    assert.deepEqual(chain.sends, [], 'nor can the fallback offer an independent router transfer');
    assert.equal(s.onboarding.calls('swap-route').length, 1, 'the pending operation is checked before requesting a new route');
    assert.deepEqual(await records(s.page), saved, 'unknown is not treated as rejected or completed');
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

test('routed Create position never uses a ready quote from a signed-out session and reviews fresh changed terms before sending', { timeout: 120_000 }, async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { routed: true, atomic: 'supported' });
  const s = await atReview(chain, { routedQuote: chosenRoute(chain) });
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor();
    const firstMinimum = await s.page.locator('[data-review-route-minimum]').innerText();
    const dialog = s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
    await s.page.locator('header [aria-haspopup="dialog"]').click();
    await dialog.getByRole('button', { name: 'Sign out', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await s.page.keyboard.press('Escape');
    s.onboarding.controls.swapRoute = chosenRoute(chain, 120n);
    await s.page.locator('[data-create-position]').click();
    await s.page.waitForFunction(previous => {
      const current = document.querySelector('[data-review-route-minimum]')?.innerText;
      return Boolean(current) && current !== previous;
    }, firstMinimum);
    await s.page.locator('[data-create-notice="route_review_required"]').waitFor();
    assert.equal(s.onboarding.calls('swap-route').length, 2, 'the old session quote is replaced, even though its deadline has not elapsed');
    assert.notEqual(await s.page.locator('[data-review-route-minimum]').innerText(), firstMinimum);
    assert.deepEqual([chain.sends, chain.batches], [[], []], 'renewing a session does not silently approve different terms');
    await s.page.locator('[data-create-position="failed"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.equal(chain.batches.length, 1);
    assert.equal(s.onboarding.calls('swap-route').length, 2);
    assert.deepEqual(chain.sends, []);
    assert.deepEqual(chain.missing, []);
    assert.deepEqual(chain.refused, []);
    assert.deepEqual(s.onboarding.state.violations, []);
  } finally { await s.close(); }
});

test('a wallet that executes batches atomically creates the position with one signature: the exact approval, the deposit and the mint in one batch, and no transaction of their own', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n }, atomic: 'supported' });
  const s = await atReview(chain);
  const { setup } = chain.release.deployment;
  try {
    // The wallet's capability is read before the press, and asks nothing of the person: one signature, nothing to choose.
    await s.page.locator('#create-reason', { hasText: 'Your wallet asks you to sign once: every step together, or none of them.' }).waitFor({ timeout: 30_000 });
    assert.equal(await s.page.locator('[data-create-batch]').count(), 0);
    assert.deepEqual([chain.sends, chain.batches], [[], []], 'nothing asked by arriving');
    // 2026-09-28 (the owner): Review's list is the one signature from the start, not only once the press runs.
    await s.page.locator('[data-wallet-steps]:not([data-live]) [data-wallet-step="batch"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(await s.page.locator('[data-wallet-steps] li').evaluateAll(items => items.map(item => item.getAttribute('data-wallet-step'))), ['batch'], 'one wallet step before the press');
    assert.equal(await s.page.locator('[data-wallet-step="batch"] .dm-flow-wstep-title').innerText(), 'Approve, deposit and create the position');
    assert.equal(await s.page.locator('[data-wallet-step="batch"] .dm-flow-wstep-note').innerText(), 'All in one go, with the exact amounts. Anything the range doesn’t use comes back to you.');
    // The window as the person sees it once the steps have settled, scrolled to the list and the button under it.
    await s.page.waitForTimeout(1_000);
    await s.page.locator('[data-wallet-steps]').evaluate(element => element.scrollIntoView({ block: 'center' }));
    await s.page.waitForTimeout(300);
    await s.page.screenshot({ path: join(shots(), 'create-position-batch-review.png') });
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-wallet-step="batch"]').waitFor();
    assert.equal(await s.page.locator('[data-wallet-steps] li').count(), 1, 'one wallet step');
    assert.match(await s.page.locator('[data-wallet-step="batch"]').innerText(), /Approve, deposit and create the position/);
    await openCreated(s.page, '4242', 60_000);
    assert.deepEqual(chain.sends, [], 'no transaction of its own: the wallet was asked for one batch');
    assert.equal(chain.batches.length, 1);
    const [batch] = chain.batches;
    assert.deepEqual([batch.version, batch.chainId, batch.from.toLowerCase(), batch.atomicRequired, batch.status], ['2.0.0', '0x1237', OWNER, true, 200]);
    const [approve, open, mint] = batchCalls(chain, batch);
    assert.deepEqual([approve.functionName, approve.to, approve.args[0].toLowerCase()], ['approve', FIXTURE_TOKEN, setup]);
    const [id, key, amount0, amount1] = open.args;
    assert.deepEqual([open.functionName, open.to, id, open.value, approve.args[1]], ['open', setup, chain.operationId(0n), amount0, amount1], 'the id the contract opens next; the ETH as its value; the exact allowance');
    assert.deepEqual(lowerKey(key), STUB_POOL_KEY);
    assert.deepEqual([mint.functionName, mint.args[0].operationId, mint.args[0].maxAmount0 <= amount0, mint.args[0].maxAmount1 <= amount1], ['mint', id, true, true]);
    assert.equal(chain.operations.get(id).tokenId, 4242n);
    assert.ok(chain.log.indexOf('eth_simulateV1') < chain.log.indexOf('wallet_sendCalls'), 'simulated whole before the wallet was asked');
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

test('a wallet that can batch once it turns on its smart account is offered one signature beside the steps; declined, nothing is sent, and asked again it creates the position in one batch', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n }, atomic: 'ready', batchError: { code: 5750, message: 'Atomic-ready wallet rejected upgrade' } });
  const s = await atReview(chain);
  try {
    const offer = s.page.locator('[data-create-batch="offer"]');
    await offer.waitFor({ timeout: 30_000 });
    assert.equal(await offer.innerText(), 'Sign all steps at once');
    // Changed on purpose (2026-09-28, beginner first): no "(EIP-7702)" on the main screen.
    assert.equal(await s.page.locator('#create-batch-note').innerText(), 'Your wallet will first ask to turn on its smart account. Your address stays the same, and your key stays in control.');
    assert.equal(await s.page.locator('#create-reason').innerText(), 'Your wallet will ask you to confirm each step.', 'the steps stay the main way');
    // Review keeps the steps while the one signature is only offered: nothing is chosen for the person.
    assert.deepEqual(await s.page.locator('[data-wallet-steps] li').evaluateAll(items => items.map(item => item.getAttribute('data-wallet-step'))), [`approve:${FIXTURE_TOKEN}`, 'fund', 'mint']);
    // Once the steps have settled, the list with the button and the offer under it (a full-page capture caught the panels mid-way).
    await s.page.waitForTimeout(1_000);
    await s.page.locator('#create-batch-note').evaluate(element => element.scrollIntoView({ block: 'center' }));
    await s.page.waitForTimeout(300);
    await s.page.screenshot({ path: join(shots(), 'create-position-batch-offer.png') });
    await offer.click();
    const notice = s.page.locator('[data-create-notice="batch_upgrade_declined"]');
    await notice.waitFor({ timeout: 30_000 });
    assert.equal(await notice.innerText(), 'You declined turning on your wallet’s smart account. Nothing was deposited. Press Create position to go step by step, or sign all steps at once again.');
    assert.deepEqual([chain.sends, chain.batches], [[], []]);
    // Still offered, and nothing is latched: asked again, one batch makes the position.
    await offer.click();
    await openCreated(s.page, '4242', 60_000);
    assert.deepEqual(chain.sends, []);
    assert.deepEqual(batchCalls(chain, chain.batches[0]).map(call => call.functionName), ['approve', 'open', 'mint']);
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

// 2026-09-28 (the owner: the UI must work whenever a wallet can batch). EIP-5792 writes chain keys in hex and keeps chain
// 0x0 for what a wallet supports on every chain; viem reads decimal keys too. Each is read as 0x1237's own entry.
test('a wallet that states its batches under chain 0x0, or under a decimal key, is read as for 0x1237: one step on Review and one batch, or the offer beside the steps', async () => {
  let chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n }, capabilities: { result: { '0x0': { atomic: { status: 'supported' } } } } });
  let s = await atReview(chain);
  try {
    await s.page.locator('#create-reason', { hasText: 'sign once' }).waitFor({ timeout: 30_000 });
    await s.page.locator('[data-wallet-steps]:not([data-live]) [data-wallet-step="batch"]').waitFor({ timeout: 30_000 });
    assert.equal(await s.page.locator('[data-wallet-steps] li').count(), 1);
    await s.page.locator('[data-create-position="idle"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.deepEqual(chain.sends, [], 'no transaction of its own');
    assert.deepEqual(batchCalls(chain, chain.batches[0]).map(call => call.functionName), ['approve', 'open', 'mint']);
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
  chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n }, atomic: 'ready', capabilities: { result: { '4663': { atomic: { status: 'ready' } } } } });
  s = await atReview(chain);
  try {
    await s.page.locator('[data-create-batch="offer"]').waitFor({ timeout: 30_000 });
    assert.deepEqual((await walletStepStates(s.page)).map(([key]) => key), [`approve:${FIXTURE_TOKEN}`, 'fund', 'mint'], 'the steps stay while one signature is only offered');
    await s.page.locator('[data-create-batch="offer"]').click();
    // Chosen, the list is the one step the wallet is asked for.
    await s.page.locator('[data-wallet-steps][data-live] [data-wallet-step="batch"]').waitFor({ timeout: 30_000 });
    await openCreated(s.page, '4242', 60_000);
    assert.deepEqual(chain.sends, []);
    assert.equal(chain.batches.length, 1);
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

// Rabby (measured 25 Sep 2026; its source at v0.94.10, 23 Sep 2026): no EIP-5792 method, and it refuses any EIP-7702
// transaction a site asks for. An account delegated elsewhere still signs plain transactions in it, one per step.
test('a wallet without batches (wallet_getCapabilities -32601, as Rabby answers) on an account already delegated (EIP-7702): Review keeps the steps, nothing offers one signature, and each step is signed', async () => {
  const delegate = '0xe6cae83bde06e4c305530e199d7217f42808555b';
  const chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n }, ownerCode: '0xef0100' + delegate.slice(2), delegateCode: DELEGATES.code[delegate],
    capabilities: { error: { code: -32601, message: 'method wallet_getCapabilities not found' } } });
  const s = await atReview(chain);
  try {
    await s.page.locator('#create-reason', { hasText: 'Your wallet will ask you to confirm each step.' }).waitFor({ timeout: 30_000 });
    // The wallet was asked, and its refusal is its answer: the line under Create position stays the steps' own.
    for (let beat = 0; beat < 300 && !chain.log.includes('wallet_getCapabilities'); beat++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(chain.log.includes('wallet_getCapabilities'));
    await new Promise(resolve => setTimeout(resolve, 500));
    assert.equal(await s.page.locator('#create-reason').innerText(), 'Your wallet will ask you to confirm each step.');
    assert.equal(await s.page.locator('[data-create-batch]').count(), 0, 'no one-signature choice');
    assert.deepEqual((await walletStepStates(s.page)).map(([key]) => key), [`approve:${FIXTURE_TOKEN}`, 'fund', 'mint']);
    await s.page.locator('[data-create-position="idle"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.deepEqual(chain.decoded().map(tx => tx.functionName), ['approve', 'open', 'mint'], 'one signature per step');
    assert.deepEqual(chain.batches, []);
    assert.ok(!chain.log.includes('wallet_sendCalls') && !chain.log.includes('eth_simulateV1'), 'no batch was prepared or offered');
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

// 2026-09-28 (audit): a batch the wallet never answered (a closed tab, an error other than a refusal) left its latch in
// the browser for good, and every later press of a wallet that batches ended "could not be read". Past the mint's latest
// deadline the batch can execute nothing, and the latch is freed (finance/setup.ts BATCH_LATCH_EXPIRY_S).
test('a batch the wallet never answered holds Create position while its page is open and it could still execute, and no longer once its page is gone or it cannot: then one new batch makes the position', async () => {
  // The latch as the journal keeps it (finance/nonce.ts): a claim with no wallet id, and when it was claimed. Changed on
  // purpose 2026-10-01 (fix round 1): the time carries the mark of a claim whose page holds its lock (LIVE_MARK); a latch
  // without it (the release before) is let go by its age alone (tests/wallet-compat.test.mjs).
  const seed = (page, operationId, age) => page.evaluate(([hash, seconds]) => {
    localStorage.setItem(`domino.offered-batch.v1.${hash}`, crypto.randomUUID());
    localStorage.setItem(`domino.offered-batch-at.v1.${hash}`, `${Math.floor(Date.now() / 1000) - seconds}L`);
  }, [keccak256(stringToHex(`4663|${OWNER}|${operationId}`)).slice(2), age]);
  // 2026-10-01 (audit C2): the page that offered a batch holds a lock while the batch may be open in the wallet
  // (finance/nonce.ts); held here as an open tab of that page would hold it.
  const holdOpen = (page, operationId) => page.evaluate((hash) => new Promise((granted) => {
    void navigator.locks.request(`domino.offered-live.v1.b${hash}`, () => { granted(); return new Promise(() => {}); });
  }), keccak256(stringToHex(`4663|${OWNER}|${operationId}`)).slice(2));
  // Claimed a minute ago by a page still open: it may still execute, so it is watched, and nothing is offered or sent.
  let chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n }, atomic: 'supported' });
  let s = await atReview(chain);
  try {
    await seed(s.page, chain.operationId(0n), 60);
    await holdOpen(s.page, chain.operationId(0n));
    await s.page.locator('#create-reason', { hasText: 'sign once' }).waitFor({ timeout: 30_000 });
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-notice="batch_unknown"]').waitFor({ timeout: 30_000 });
    assert.deepEqual([chain.sends, chain.batches], [[], []]);
    assert.ok(!chain.log.includes('wallet_sendCalls'));
  } finally { await s.close(); }
  // Changed on purpose 2026-10-01 (audit C2, the owner's OK): claimed a minute ago by a page that is gone (reloaded or
  // closed during the prompt) and never answered by the wallet: freed at once, since the setup contract refuses a second
  // batch for the operation, so one still open in the wallet cannot run twice. One new batch makes the position.
  chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n }, atomic: 'supported' });
  s = await atReview(chain);
  try {
    await seed(s.page, chain.operationId(0n), 60);
    await s.page.locator('#create-reason', { hasText: 'sign once' }).waitFor({ timeout: 30_000 });
    await s.page.locator('[data-create-position="idle"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.deepEqual(chain.sends, []);
    assert.equal(chain.batches.length, 1);
    assert.deepEqual(await s.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.offered-batch'))), [], 'the old latch and the new one, both done');
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
  // Claimed 26 minutes ago, its page still open: past anything it could do. Freed, and one new batch makes the position.
  chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n }, atomic: 'supported' });
  s = await atReview(chain);
  try {
    await seed(s.page, chain.operationId(0n), 26 * 60);
    await holdOpen(s.page, chain.operationId(0n));
    await s.page.locator('#create-reason', { hasText: 'sign once' }).waitFor({ timeout: 30_000 });
    await s.page.locator('[data-create-position="idle"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.deepEqual(chain.sends, []);
    assert.equal(chain.batches.length, 1);
    assert.deepEqual(await s.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.offered-batch'))), [], 'the old latch and the new one, both done');
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

// 2026-09-28 (the chain's own RPC unreachable on Vivo's DNS): a wallet that does not simulate a batch had it simulated
// at a public fallback. Changed on purpose (RPC-SPEC D7, 2026-10-01, the owner's rule: nothing is read from a public RPC):
// at the site's own fixed route, POST /api/chain/v1/simulate, once the deployment turns it on (off by default); no RPC
// host is asked to simulate anything.
test('a batch the wallet cannot simulate is simulated on the site’s own simulate route when it is on, and signed once; no RPC host is asked', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n }, atomic: 'supported', simulation: 'unsupported' });
  const s = await atReview(chain);
  try {
    s.rpc.simulate = (params) => [{ calls: chain.simulate(params[0].blockStateCalls[0].calls) }];
    await s.page.locator('#create-reason', { hasText: 'sign once' }).waitFor({ timeout: 30_000 });
    await s.page.locator('[data-create-position="idle"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.ok(s.rpc.edgeLog.includes('/api/chain/v1/simulate'), 'simulated on the site’s route');
    assert.deepEqual(s.rpc.publicAsked, [], 'no RPC host was asked anything');
    assert.deepEqual(chain.sends, []);
    assert.equal(chain.batches.length, 1, 'signed once');
  } finally { await s.close(); }
});

test('a one-token deposit in one batch: the ETH as the deposit’s value, the swap for at least what the quotes found less the slippage limit, and the mint sized for that least', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { eth: 10n ** 18n, atomic: 'supported' });
  const s = await atReview(chain);
  const { setup } = chain.release.deployment;
  try {
    await s.page.locator('#create-reason', { hasText: 'sign once' }).waitFor({ timeout: 30_000 });
    await s.page.locator('[data-create-position="idle"]').click();
    await openCreated(s.page, '4242', 90_000);
    assert.deepEqual(chain.sends, []);
    const [open, swap, mint] = batchCalls(chain, chain.batches[0]);
    assert.deepEqual([open.functionName, swap.functionName, mint.functionName, open.to, swap.to, mint.to], ['open', 'swap', 'mint', setup, setup, setup], 'ETH needs no approval');
    const [id, , amount0, amount1] = open.args;
    assert.deepEqual([amount1, open.value], [0n, amount0], 'ETH alone, as the value');
    const plan = swap.args[0];
    assert.deepEqual([plan.operationId, plan.zeroForOne], [id, true]);
    // What that gross buys at the pool's first price, the one the quotes were read at: the minimum is it less 0.5%, never more.
    const output = chain.swapOutput(plan.grossInput, true);
    assert.equal(plan.minOutput, (output * 9950n) / 10000n);
    const caps = mint.args[0];
    assert.ok(caps.maxAmount1 <= plan.minOutput && caps.maxAmount0 <= amount0 - plan.grossInput, 'the mint counts only on the least the swap pays');
    assert.equal(chain.operations.get(id).tokenId, 4242n);
    await onlyTheWallet(s, chain, { reverts: true });
  } finally { await s.close(); }
});

// 2026-09-28 (review): once the same press goes on step by step, the line under Create position says to confirm each
// step, never "one signature for every step", while the wallet asks for the approval, the deposit and the mint.
// Changed on purpose (RPC-SPEC D7): a batch the wallet cannot simulate is no longer simulated on the chain's RPC; the
// site's own simulate route is (the test above, when it is on).
test('a batch the wallet cannot make after all goes step by step in the same press; one nothing simulates goes step by step too', async () => {
  // Said supported, refused as unsupported: asked once, then each step as for any wallet.
  let chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n }, atomic: 'supported', batchError: { code: 5760, message: 'Atomicity not supported' } });
  let s = await atReview(chain);
  try {
    await s.page.locator('#create-reason', { hasText: 'sign once' }).waitFor({ timeout: 30_000 });
    await recordReason(s.page);
    await s.page.locator('[data-create-position="idle"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.deepEqual(chain.decoded().map(tx => tx.functionName), ['approve', 'open', 'mint']);
    assert.deepEqual(chain.batches, []);
    assert.equal(chain.log.filter(method => method === 'wallet_sendCalls').length, 1, 'asked once, refused, never again');
    await saidEachStep(s.page, { batchAsked: true, steps: ['approve', 'fund', 'mint'] });
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
  // Changed on purpose (RPC-SPEC D7, 2026-10-01): no simulation in the wallet, and the site's simulate route off, as a
  // deployment has it by default (or on, with a node that does not carry the method): the batch is never offered, and
  // the same press goes on step by step, said as such. No RPC host is asked to simulate.
  for (const route of ['off', 'unsupported']) {
    chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n }, atomic: 'supported', simulation: 'unsupported' });
    s = await atReview(chain);
    try {
      if (route === 'unsupported') s.rpc.simulate = () => { throw Object.assign(new Error('the method eth_simulateV1 does not exist/is not available'), { code: -32601 }); };
      await s.page.locator('#create-reason', { hasText: 'sign once' }).waitFor({ timeout: 30_000 });
      await recordReason(s.page);
      await s.page.locator('[data-create-position="idle"]').click();
      await openCreated(s.page, '4242', 60_000);
      assert.ok(s.rpc.edgeLog.includes('/api/chain/v1/simulate'), `${route}: the site’s simulate route was asked`);
      assert.deepEqual(chain.batches, [], route);
      assert.equal(chain.log.filter(method => method === 'wallet_sendCalls').length, 0, `${route}: nothing unsimulated is offered as a batch`);
      assert.deepEqual(chain.decoded().map(tx => tx.functionName), ['approve', 'open', 'mint'], `${route}: each step, as for any wallet`);
      await saidEachStep(s.page, { batchAsked: false, steps: ['approve', 'fund', 'mint'] });
    } finally { await s.close(); }
  }
});

test('Create position finds this wallet’s earlier deposit in the same pool and mints it: no approval and no second deposit, only the mint, and the page opens that position', async () => {
  // A block that is included and not yet final is enough to go on, as it is on an L2 whose finalized block trails by minutes.
  const chain = fakeDepositChain(ACCOUNTS[0].address, { tokenId: 4243n, finality: 'lagging' });
  // Funded earlier and never minted (a declined mint, a closed tab): open, not closed, not recovering, this wallet's, this pool.
  const id = chain.seed({ key: STUB_POOL_KEY, balance0: 2_000_000n, balance1: 1_000_000n });
  const s = await atReview(chain);
  const { setup } = chain.release.deployment;
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    // Found, not chosen: its amounts are said, and the wallet is asked nothing until the next press.
    await s.page.getByRole('status').filter({ hasText: /^You have an earlier deposit in this pool: [\d.,]+ ETH and 1 TOKEN\. Press Create position to create this range from it, or refund it to your wallet\.$/ }).waitFor({ timeout: 30_000 });
    assert.deepEqual(chain.sends, [], 'nothing was sent by finding it');
    assert.equal(chain.viewed.filter(name => name === 'nextOperationId').length, 1, 'one pending-batch recovery identity check on the first press');
    assert.equal(await s.page.getByRole('button', { name: 'Refund the deposit instead', exact: true }).count(), 1, 'it can be refunded instead');
    await s.page.locator('[data-create-position="held"]').click();
    await openCreated(s.page, '4243', 60_000);
    assert.equal(chain.sends.length, 1, 'the mint alone');
    const [mint] = chain.decoded();
    const plan = mint.args[0];
    assert.deepEqual([mint.functionName, mint.to, mint.from, mint.value, mint.nonce], ['mint', setup, OWNER, 0n, '0x0']);
    assert.deepEqual([plan.operationId, plan.tickLower, plan.tickUpper, plan.maxAmount0, plan.maxAmount1, plan.initialSqrtPriceX96], [id, ...STUB_RANGE, 2_000_000n, 1_000_000n, 0n],
      'the held operation, Review’s range, the held balances as caps');
    assert.ok(plan.liquidity > 0n);
    assert.ok(!chain.viewed.includes('allowance') && !chain.viewed.includes('balanceOf'), 'no allowances or wallet token balances for new funding were read');
    // nextOperationId identifies any pending batch before continuing; it does not prepare new funding.
    // The two explicit presses each read that recovery identity once, and the held id/range/caps above still mint alone.
    assert.equal(chain.viewed.filter(name => name === 'nextOperationId').length, 2, 'one pending-batch identity read per explicit press, without duplicate recovery reads');
    assert.equal(chain.operations.size, 1, 'no second operation');
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

// 2026-09-28 (review): a held deposit's mint is never in a batch, so with a wallet that signs everything at once the
// line under Create position still says to confirm each step while the wallet asks for the mint.
test('with a wallet that signs everything at once, an earlier deposit’s mint is its own step, and Create position says so', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { tokenId: 4243n, atomic: 'supported' });
  chain.seed({ key: STUB_POOL_KEY, balance0: 2_000_000n, balance1: 1_000_000n });
  const s = await atReview(chain);
  try {
    await s.page.locator('#create-reason', { hasText: 'sign once' }).waitFor({ timeout: 30_000 });
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-position="held"]').waitFor({ timeout: 30_000 });
    await recordReason(s.page);
    await s.page.locator('[data-create-position="held"]').click();
    await openCreated(s.page, '4243', 60_000);
    assert.deepEqual(chain.decoded().map(tx => tx.functionName), ['mint'], 'the mint alone');
    assert.deepEqual(chain.batches, []);
    assert.equal(chain.log.filter(method => method === 'wallet_sendCalls').length, 0, 'no batch is offered for a held deposit');
    await saidEachStep(s.page, { batchAsked: false, steps: ['mint'] });
  } finally { await s.close(); }
});

test('a mint declined in the wallet leaves the deposit held: Create position says so, offers the refund, and the refund sends cancel for that operation', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n } });
  chain.decline('mint');
  const s = await atReview(chain);
  const { setup } = chain.release.deployment;
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    const held = s.page.locator('[data-create-position="held"]');
    await held.waitFor({ timeout: 60_000 });
    assert.equal(await held.innerText(), 'Create position', 'pressed again, it mints the held deposit');
    assert.deepEqual(chain.declined, ['mint']);
    await s.page.getByRole('status').filter({ hasText: 'You declined in your wallet. Your deposit is held: press Create position to continue, or refund it.' }).waitFor();
    // Changed on purpose (round 6, 2026-09-27, the owner: New position for people who know nothing about pools): one short sentence.
    assert.equal(await s.page.locator('#create-reason').innerText(), 'You have a deposit waiting in this pool. Press Create position to finish from it, or refund it.');
    assert.deepEqual(await walletStepStates(s.page), [[`approve:${FIXTURE_TOKEN}`, 'done'], ['fund', 'done'], ['mint', 'failed']]);
    assert.deepEqual(chain.decoded().map(tx => tx.functionName), ['approve', 'open'], 'the mint was never sent');
    assert.ok((await s.page.evaluate(() => location.pathname + location.hash)).startsWith('/new'), 'still on New position');

    const refund = s.page.getByRole('button', { name: 'Refund the deposit instead', exact: true });
    await refund.click();
    await s.page.getByRole('status').filter({ hasText: 'The deposit was refunded to your wallet.' }).waitFor({ timeout: 60_000 });
    assert.deepEqual(await walletStepStates(s.page), [['refund', 'done']]);
    assert.equal(await s.page.locator('[data-create-position]').getAttribute('data-create-position'), 'idle');
    assert.equal(await refund.count(), 0, 'nothing left to refund');
    const [, open, cancel] = chain.decoded();
    assert.deepEqual([cancel.functionName, cancel.to, cancel.from, cancel.value, cancel.nonce, cancel.args[0]], ['cancel', setup, OWNER, 0n, '0x2', open.args[0]], 'cancel for the operation the deposit opened, at the nonce the declined mint gave back');
    assert.deepEqual([chain.operations.get(open.args[0]).closed, chain.operations.get(open.args[0]).tokenId], [true, 0n]);
    assert.ok((await s.page.evaluate(() => location.pathname + location.hash)).startsWith('/new'));
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

test('pressed again after a declined mint, Create position mints the held deposit: only the mint is sent, never a second approval or deposit, and the page opens the position', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n } });
  chain.decline('mint');
  const s = await atReview(chain);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-position="held"]').click({ timeout: 60_000 });
    await openCreated(s.page, '4242', 60_000);
    const [, open, mint] = chain.decoded();
    assert.deepEqual(chain.decoded().map(tx => [tx.functionName, tx.nonce]), [['approve', '0x0'], ['open', '0x1'], ['mint', '0x2']], 'one approval, one deposit, and the mint at the nonce the declined one gave back');
    assert.deepEqual([mint.args[0].operationId, mint.args[0].maxAmount0, mint.args[0].maxAmount1], [open.args[0], open.args[2], open.args[3]], 'the held operation, capped at what it holds');
    assert.equal(chain.operations.size, 1, 'no second operation');
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

// 2026-10-01 (audit C2, the owner's OK): a send the wallet answered with an error that proves nothing either way keeps
// its nonce latched, so the next press says the request may still be open in the wallet. "I rejected it in my wallet"
// lets the latch go while the chain shows nothing pending; nothing is sent by it, and the press after it prepares and
// reviews the step anew. The lost request is never sent again by the page itself.
test('a mint the wallet answered with an unknown error holds the next press until the person says they rejected it; then Create position mints once', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n } });
  chain.lose('mint');
  const s = await atReview(chain);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    const held = s.page.locator('[data-create-position="held"]');
    await held.waitFor({ timeout: 60_000 });
    assert.deepEqual(chain.lost, ['mint']);
    assert.deepEqual(chain.decoded().map(tx => tx.functionName), ['approve', 'open'], 'the lost mint sent nothing');
    const sendsAsked = () => chain.log.filter(method => method === 'eth_sendTransaction').length;
    assert.equal(sendsAsked(), 3, 'the approval, the deposit and the one mint the wallet lost');

    // The next press finds the mint's nonce still latched by this page: it says so, sends nothing, and offers the way out.
    await held.click();
    const open = s.page.locator('[data-create-notice="wallet_request_open"]');
    await open.waitFor({ timeout: 30_000 });
    assert.equal(await open.innerText(), 'Your wallet may still be showing an earlier request from this page. Approve or reject it there. If you already rejected or closed it, say so below.');
    assert.equal(sendsAsked(), 3, 'nothing is sent while the request may be open');
    const forget = s.page.locator('[data-create-forget-request]');
    assert.equal(await forget.innerText(), 'I rejected it in my wallet');
    await forget.click();
    await s.page.locator('[data-create-notice="request_forgotten"]').filter({ hasText: 'Nothing was sent. Press Create position to continue.' }).waitFor({ timeout: 30_000 });
    assert.equal(await forget.count(), 0, 'the way out is gone once used');
    assert.equal(sendsAsked(), 3, 'and saying so sends nothing either');

    // The press after it reviews the mint anew and sends it once, at the nonce nothing on chain used.
    await held.click();
    await openCreated(s.page, '4242', 60_000);
    assert.deepEqual(chain.decoded().map(tx => [tx.functionName, tx.nonce]), [['approve', '0x0'], ['open', '0x1'], ['mint', '0x2']]);
    assert.equal(sendsAsked(), 4, 'one more send in all: the mint the person asked for');
    assert.equal(chain.operations.size, 1, 'no second operation');
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

// 2026-10-01 (audit C14): a transaction the person replaced in the wallet ("Speed up" or "Cancel") is known at once by
// its nonce: the chain does not know the hash the page was given, and the account's nonce has passed it. The page reads
// the state again and goes on from what happened; it used to watch the unknown hash as pending for five minutes.
test('a mint sped up in the wallet: the page finds the position by reading the operation again, and opens it', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n } });
  chain.speedUp('mint');
  const s = await atReview(chain);
  try {
    const started = Date.now();
    await s.page.locator('[data-create-position="idle"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.ok(Date.now() - started < 60_000, 'well before the five minutes an unknown hash used to be watched');
    assert.deepEqual(chain.decoded().map(tx => [tx.functionName, tx.nonce]), [['approve', '0x0'], ['open', '0x1'], ['mint', '0x2']], 'nothing sent twice');
    assert.equal(chain.operations.size, 1);
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

test('a deposit cancelled in the wallet is said within seconds, not after five minutes: nothing was deposited, and the next press deposits once', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n } });
  chain.cancelInWallet('open');
  const s = await atReview(chain);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    const said = s.page.locator('[data-create-notice="transaction_replaced"]');
    await said.waitFor({ timeout: 60_000 });
    assert.equal(await said.innerText(), 'Your wallet replaced the deposit with another transaction, and nothing was deposited. Press Create position again.');
    assert.deepEqual(chain.decoded().map(tx => tx.functionName), ['approve'], 'the deposit never happened');
    assert.equal(chain.operations.size, 0);

    await s.page.locator('[data-create-position="failed"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.deepEqual(chain.decoded().map(tx => [tx.functionName, tx.nonce]), [['approve', '0x0'], ['open', '0x2'], ['mint', '0x3']], 'one deposit, after the nonce the cancel took, and no second approval');
    assert.equal(chain.operations.size, 1);
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

test('an approval cancelled in the wallet stops the press instead of asking again; the next press approves once', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n } });
  chain.cancelInWallet('approve');
  const s = await atReview(chain);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    const said = s.page.locator('[data-create-notice="transaction_replaced"]');
    await said.waitFor({ timeout: 60_000 });
    assert.equal(await said.innerText(), 'Your wallet replaced the approval with another transaction, and nothing was approved. Press Create position again.');
    assert.equal(chain.log.filter(method => method === 'eth_sendTransaction').length, 1, 'the cancelled approval was not asked for again in the same press');
    assert.deepEqual(chain.sends, []);

    await s.page.locator('[data-create-position="failed"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.deepEqual(chain.decoded().map(tx => [tx.functionName, tx.nonce]), [['approve', '0x1'], ['open', '0x2'], ['mint', '0x3']], 'the approval once, after the nonce the cancel took');
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

// 2026-10-01 (audit C1, the owner's OK): Review's "Switch to Robinhood Chain" asks the wallet to switch, adds the network
// when the wallet does not have it (wallet_addEthereumChain, EIP-3085), and says every refusal under the button; it used
// to drop the outcome, and a wallet without Robinhood Chain could never get past it.
test('a wallet moved to another network at Review: Switch to Robinhood Chain says a refusal, then adds the network and Review is back as it was', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n } });
  const s = await atReview(chain);
  try {
    chain.moveWallet(1, { forget: true });
    await s.page.evaluate(() => window.__depositWalletEmit('chainChanged', '0x1'));
    const button = s.page.locator('[data-create-position="connect"]');
    await button.waitFor({ timeout: 10_000 });
    assert.equal(await button.innerText(), 'Switch to Robinhood Chain');
    assert.equal(await s.page.locator('#create-reason').innerText(), 'Switch your wallet to Robinhood Chain to continue.');

    // Refused in the wallet: said under the button, and the button is there to press again.
    chain.refuseNetworkOnce('add');
    await button.click();
    const refused = s.page.locator('[data-create-notice="switch_add_rejected"]');
    await refused.waitFor({ timeout: 10_000 });
    assert.equal(await refused.innerText(), 'Your wallet declined adding Robinhood Chain.');
    assert.equal(await button.innerText(), 'Switch to Robinhood Chain');
    assert.equal(await button.isEnabled(), true);
    assert.equal(chain.walletChain(), 1);

    // Pressed again: the switch, the network added with Robinhood Chain's own details, and the wallet on it.
    await button.click();
    await s.page.locator('[data-create-position="idle"]').waitFor({ timeout: 10_000 });
    assert.equal(chain.walletChain(), 4663);
    assert.equal(await s.page.locator('[data-create-notice]').count(), 0, 'the refusal is cleared by the press that worked');
    assert.equal(await s.page.locator('#create-reason').innerText(), 'Your wallet will ask you to confirm each step.');
    const asked = chain.log.filter(method => method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain');
    assert.deepEqual(asked, ['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain', 'wallet_addEthereumChain']);
    assert.equal(chain.added.length, 2);
    for (const params of chain.added) {
      assert.deepEqual(params, {
        chainId: '0x1237',
        chainName: 'Robinhood Chain',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        // RPC-SPEC §7.5: the chain's official RPC alone, the wallet's own (src/wallet/chain.ts).
        rpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
        blockExplorerUrls: ['https://robinhoodchain.blockscout.com'],
      });
    }
    assert.deepEqual(chain.sends, [], 'nothing was sent by switching');
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

// On an L2 the finalized block trails by minutes: a failed transaction is said as soon as its block is canonical (finance/setup.ts receipt).
test('a deposit that reverts in a block not yet final is reported as reverted, and no mint is prepared', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n }, finality: 'lagging' });
  chain.revert('open');
  const s = await atReview(chain);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-position="failed"], [data-create-position="held"], [data-create-position="done"]').waitFor({ timeout: 60_000 });
    assert.deepEqual(chain.decoded().map(tx => tx.functionName), ['approve', 'open'], 'no mint after a deposit that did not happen');
    assert.equal(await s.page.locator('[data-create-position]').getAttribute('data-create-position'), 'failed');
    assert.deepEqual((await walletStepStates(s.page)).find(([key]) => key === 'fund'), ['fund', 'failed'], 'the deposit is not shown as done');
    assert.equal(await s.page.locator('[data-create-notice="operation_not_owned"]').count(), 0, 'no word of another wallet');
    await s.page.getByRole('status').filter({ hasText: 'The deposit reverted on chain: nothing was deposited, only network gas was spent. Press Create position to try again.' }).waitFor({ timeout: 5_000 });
  } finally { await s.close(); }
});

// ---- A range beside today's price takes one token alone (2026-09-28, one-sided, the owner: "if I hold only MANY and
// want to sell it, I put the range above today's price. No swap: only one side of the pool's pair.") The fixture pool
// reads "1 TOKEN = 0.000000000001 ETH" (lib/read/orientation.ts): a range above that price takes TOKEN alone. ----

test('a range above today’s price with TOKEN only: the amount step asks for TOKEN alone, Review lists Approve TOKEN, Deposit TOKEN and Create, and nothing is swapped', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 5_000_000n } });
  const s = await atReview(chain, { range: ['0.0000000000015', '0.000000000003'] });
  const { setup } = chain.release.deployment;
  try {
    // No mode and no word of buying or selling: the range step and Review say what they always said.
    assert.doesNotMatch(await s.page.locator('main').innerText(), /\b(buy|sell|buying|selling)\b/i);
    // The rail's Amount row names TOKEN alone, never "0 ETH".
    assert.match(await s.page.locator('li[data-step="amount"] .dm-flow-row-summary').innerText(), /^1 TOKEN$/);
    const amounts = s.page.locator('[data-review-amounts]');
    assert.equal(await amounts.getAttribute('data-review-plan'), 'both', 'the wallet funds it as it is: no swap');
    assert.equal(await amounts.innerText(), '1 TOKEN', 'the one token it takes, never "0 ETH +"');
    assert.equal(await s.page.locator('[data-review-swap], [data-review-swap-note]').count(), 0);
    assert.equal(await s.page.locator('[data-review-position]').innerText(), 'Today’s price is outside this range, so the position won’t earn fees until the price moves into it.');
    assert.deepEqual(await walletStepStates(s.page), [[`approve:${FIXTURE_TOKEN}`, null], ['fund', null], ['mint', null]]);
    const steps = await s.page.locator('[data-wallet-steps]').innerText();
    assert.match(steps, /Approve TOKEN[\s\S]*Deposit TOKEN[\s\S]*Create the position/);
    assert.doesNotMatch(steps, /Swap|both tokens/);
    // The preview says it calmly: no red Out of range.
    assert.equal(await s.page.locator('.dm-flow-preview [data-preview-waits]').innerText(), 'Earns once the price is in range');
    assert.equal(await s.page.locator('.dm-flow-preview .dm-pill--out').count(), 0);
    await s.page.locator('[data-stage-card="review"]').screenshot({ path: join(shots(), 'one-sided-review.png') });

    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-wallet-steps][data-live]').waitFor();
    assert.deepEqual((await walletStepStates(s.page)).map(([key]) => key), [`approve:${FIXTURE_TOKEN}`, 'fund', 'mint'], 'the chain’s balances make the same plan');
    await openCreated(s.page, '4242', 60_000);
    const sent = chain.decoded();
    assert.deepEqual(sent.map(tx => tx.functionName), ['approve', 'open', 'mint'], 'no swap');
    const [approve, open, mint] = sent;
    // Changed on purpose 2026-09-28 (one-sided, review): exactly the 1 TOKEN Review shows, with no slippage room (was
    // withRoom(1_000_000n)): a one-sided mint makes position of all of it, so a room made the position larger than Review.
    assert.deepEqual([approve.to, approve.args[0].toLowerCase(), approve.args[1]], [FIXTURE_TOKEN, setup, 1_000_000n], 'the 1 TOKEN alone is approved');
    assert.deepEqual([open.args[2], open.args[3], open.value], [0n, 1_000_000n, 0n], 'the 1 TOKEN alone is deposited, and no ETH');
    const minted = mint.args[0];
    assert.ok(minted.tickLower < minted.tickUpper && minted.tickUpper <= 0, `the pool’s range lies at or under its tick 0 (TOKEN dearer): ${minted.tickLower} to ${minted.tickUpper}`);
    assert.deepEqual([minted.maxAmount0, minted.maxAmount1], [0n, 1_000_000n]);
    // The position takes no more than the 1 TOKEN typed (v4-core rounds a mint's amount up), and all but the mint's 10 bps slack of it.
    const taken = (minted.liquidity * (sqrtPriceAtTick(minted.tickUpper) - sqrtPriceAtTick(minted.tickLower)) + Q96 - 1n) / Q96;
    assert.ok(taken <= 1_000_000n && taken >= 998_900n, `the mint takes ${taken} of the 1,000,000 deposited`);
    assert.equal(chain.quoted.length, 0, 'the pool was never asked for a swap quote');
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

test('a range whose lowest price is today’s exactly: Review plans TOKEN alone, and Create position sends no swap the review did not show', async () => {
  // The study's edge case (2026-09-28): the range's edge on the pool's price, where the mint's slippage band used to
  // reach into the range and Create position swapped about 1% of the deposit for ETH without saying so.
  const chain = fakeDepositChain(ACCOUNTS[0].address, { eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 5_000_000n } });
  const s = await atReview(chain, { range: ['0.000000000001', '0.000000000002'] });
  try {
    assert.equal(await s.page.locator('[data-review-amounts]').getAttribute('data-review-plan'), 'both');
    assert.deepEqual(await walletStepStates(s.page), [[`approve:${FIXTURE_TOKEN}`, null], ['fund', null], ['mint', null]]);
    await s.page.locator('[data-create-position="idle"]').click();
    await openCreated(s.page, '4242', 60_000);
    const sent = chain.decoded();
    assert.deepEqual(sent.map(tx => tx.functionName), ['approve', 'open', 'mint'], 'no swap');
    const minted = sent[2].args[0];
    assert.equal(minted.tickUpper, 0, 'the range’s edge is the pool’s tick');
    assert.equal(minted.maxAmount0, 0n);
    assert.equal(minted.minSqrtPriceX96, STUB_SQRT_PRICE, 'the mint’s band stops at the range’s edge, where TOKEN alone makes it');
    assert.ok(minted.maxSqrtPriceX96 > STUB_SQRT_PRICE);
    assert.equal(chain.quoted.length, 0);
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

test('a one-token deposit for a range beside the price, and the price moves into the range before the mint: no swap Review did not show, the deposit held and said so; the next press swaps part of it and mints', async () => {
  // Added 2026-09-28 (one-sided, review): the guard in CreatePosition.tsx swapIfNeeded (INTO_RANGE). Review planned TOKEN
  // alone for a range above today's price; once the deposit is in, the pool's price moves to half its tick-0 price
  // (TOKEN twice as dear, 2·10⁻¹² ETH), inside the range of 1.5·10⁻¹² to 3·10⁻¹² ETH, which then needs ETH too.
  const inside = (STUB_SQRT_PRICE * 7071n) / 10000n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 5_000_000n } });
  chain.moveOnOpen(inside);
  const s = await atReview(chain, { range: ['0.0000000000015', '0.000000000003'] });
  try {
    assert.equal(await s.page.locator('[data-review-amounts]').getAttribute('data-review-plan'), 'both');
    assert.deepEqual(await walletStepStates(s.page), [[`approve:${FIXTURE_TOKEN}`, null], ['fund', null], ['mint', null]]);
    await s.page.locator('[data-create-position="idle"]').click();
    const notice = s.page.locator('[data-create-notice="range_needs_both"]');
    await notice.waitFor({ timeout: 60_000 });
    assert.equal(await notice.innerText(), 'The price moved into your range, which now needs both tokens. Your deposit is held: press Create position to swap part of it and finish, or refund it.');
    const again = s.page.locator('[data-create-position="held"]');
    await again.waitFor();
    const sent = chain.decoded();
    assert.deepEqual(sent.map(tx => tx.functionName), ['approve', 'open'], 'the approval and the deposit Review showed, and no swap');
    assert.deepEqual([chain.quotes, chain.quoted], [[], []], 'no swap was even quoted');
    const [held] = [...chain.operations.values()];
    assert.deepEqual([held.balance0, held.balance1, held.swapped, held.closed], [0n, 1_000_000n, false, false], 'the deposit is held as it was made');
    assert.deepEqual(await walletStepStates(s.page), [[`approve:${FIXTURE_TOKEN}`, 'done'], ['fund', 'done'], ['mint', 'waiting']], 'no swap step was shown');
    assert.doesNotMatch(await s.page.locator('[data-wallet-steps]').innerText(), /Swap/);

    // The next press on the held deposit swaps part of it, as the sentence said: the step appears, then the mint.
    await again.click();
    await s.page.locator('[data-wallet-steps] li[data-wallet-step="swap"]').waitFor({ timeout: 30_000 });
    await openCreated(s.page, '4242', 60_000);
    const all = chain.decoded();
    assert.deepEqual(all.map(tx => tx.functionName), ['approve', 'open', 'swap', 'mint']);
    const [, , swap, mint] = all;
    assert.equal(swap.args[0].zeroForOne, false, 'part of the TOKEN, for ETH');
    assert.ok(swap.args[0].grossInput > 0n && swap.args[0].grossInput < 1_000_000n, `part of it: ${swap.args[0].grossInput}`);
    assert.ok(chain.quotes.length >= 1, 'the contract was asked what sizes buy, after the deposit');
    const minted = mint.args[0];
    assert.ok(minted.maxAmount0 > 0n && minted.maxAmount1 > 0n, 'both tokens, for a range the price is inside');
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

// ---- Create position with one of the pool's two tokens: part of it is swapped inside the pool before the mint ----

/** Each wallet step's marker, whether it is drawn in the money-in green (styles/flow.css), and what it shows. */
const markers = page => page.evaluate(() => {
  const probe = document.createElement('span');
  probe.style.background = 'var(--money-in)';
  document.body.append(probe);
  const green = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return [...document.querySelectorAll('[data-wallet-steps] li .dm-step-marker')].map(marker => [marker.textContent, getComputedStyle(marker).backgroundColor === green]);
});
/** The steps turned done one at a time, in `keys` order, each while every step after it was not done yet. */
async function doneInTurn(page, keys) {
  const { log, order } = await doneOrder(page);
  assert.deepEqual(order.map(({ key }) => key), keys, log.join('\n'));
  for (const [index, { key, states }] of order.entries()) {
    for (const later of keys.slice(index + 1)) assert.notEqual(states[later], 'done', `${later} was done no later than ${key}`);
  }
  return log;
}

test('with TOKEN and only gas in ETH, Review plans the swap; Create position approves and deposits the typed TOKEN alone, swaps part of it for ETH inside the pool, mints, and opens the position, each wallet step turning green in turn', async () => {
  // 10,000,000,000 TOKEN (6 decimals) pairs with about 0.0089 ETH at this range; the wallet holds 0.008 ETH, enough for
  // gas only (GAS_ONLY_ETH, changed on purpose 2026-09-28, one-sided).
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 2n * typed } });
  const s = await atReview(chain, { amount: '10000000000' });
  const { setup } = chain.release.deployment;
  try {
    // Review: the plan is the swap from TOKEN, in the headline and the line under it, with the note that says why.
    const amounts = s.page.locator('[data-review-amounts]');
    assert.equal(await amounts.getAttribute('data-review-plan'), 'swap');
    // Changed on purpose (round 6, 2026-09-27, the owner: New position for people who know nothing about pools): "About" once before the estimates, no
    // "≈"; the amounts are short, each side's exact figure its data-exact; the swap line and its note are one short sentence each.
    assert.match(await amounts.innerText(), /^About [\d.,]+ TOKEN \+ [\d.,]+ ETH$/, 'what the position holds after the swap');
    const bought = await amounts.locator('[data-review-side="0"]').getAttribute('data-exact');
    const swapLine = s.page.locator('[data-review-swap]');
    assert.equal(await swapLine.getAttribute('data-review-swap'), '1', 'from TOKEN, currency 1');
    const [, from, part] = (await swapLine.innerText()).match(/^You put in ([\d.,]+) TOKEN\. About ([\d.,]+) TOKEN of it is swapped for ETH\.$/) ?? [];
    assert.equal(from, '10,000,000,000', 'the typed amount is the budget');
    const partRaw = parseUnits(part.replaceAll(',', ''), 6);
    assert.ok(partRaw > typed / 3n && partRaw < (typed * 2n) / 3n, `about half of it at this range: ${part}`);
    assert.ok(parseUnits(bought.replaceAll(',', ''), 18) > 0n);
    assert.equal(await s.page.locator('[data-review-swap-note]').innerText(),
      'You don’t have enough ETH, so part of your TOKEN is swapped for it in this pool first. The swapped part pays the pool’s fee and Domino’s 0.65% fee.');
    assert.equal(await s.page.locator('[data-review-short]').count(), 0);
    // Review keeps its two sections: no deposit amounts per token, and nothing that asks for a sign-in.
    assert.deepEqual(await s.page.locator('[data-stage="review"] h3').allInnerTexts(), ['Your position', 'In your wallet']);
    assert.doesNotMatch(await s.page.locator('main').innerText(), /Deposit amounts per token|Sign in with your wallet to see these amounts\./);
    assert.equal(await s.page.locator('section[data-stage="balance"]').count(), 0);
    // The wallet steps, in order: approve TOKEN, deposit it, swap, create. None running before the press.
    assert.deepEqual(await walletStepStates(s.page), [[`approve:${FIXTURE_TOKEN}`, null], ['fund', null], ['swap', null], ['mint', null]]);
    const list = s.page.locator('[data-wallet-steps]');
    assert.match(await list.innerText(), /Approve TOKEN[\s\S]*Deposit TOKEN[\s\S]*Swap part of your deposit\s+Swaps part of it for the other token in this pool\. Fee: 0\.65% of the swapped part\.[\s\S]*Create the position/);
    assert.doesNotMatch(await s.page.locator('[data-wallet-step="fund"]').innerText(), /Native ETH/, 'the TOKEN deposit sends no ETH, and says none');
    assert.deepEqual((await markers(s.page)).map(([text]) => text), ['1', '2', '3', '4']);
    await s.page.locator('[data-stage-card="review"]').screenshot({ path: join(shots(), 'swap-review.png') });
    assert.deepEqual(chain.sends, [], 'nothing is sent by arriving');

    await recordWalletSteps(s.page);
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-wallet-steps][data-live]').waitFor();
    assert.deepEqual((await walletStepStates(s.page)).map(([key]) => key), [`approve:${FIXTURE_TOKEN}`, 'fund', 'swap', 'mint'], 'the chain’s balances make the same plan');
    // Every step done and drawn green, a moment before Positions opens.
    await s.page.locator('[data-wallet-step="mint"][data-step-state="done"]').waitFor({ timeout: 90_000 });
    assert.deepEqual(await walletStepStates(s.page), [[`approve:${FIXTURE_TOKEN}`, 'done'], ['fund', 'done'], ['swap', 'done'], ['mint', 'done']]);
    // The done state and check render before the marker's background-color transition settles.
    await s.page.waitForFunction(() => {
      const probe = document.createElement('span');
      probe.style.background = 'var(--money-in)';
      document.body.append(probe);
      const green = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const steps = [...document.querySelectorAll('[data-wallet-steps] li .dm-step-marker')];
      return steps.length === 4 && steps.every(marker => marker.textContent === '✓' && getComputedStyle(marker).backgroundColor === green);
    }, null, { timeout: 2_000 });
    assert.deepEqual(await markers(s.page), [['✓', true], ['✓', true], ['✓', true], ['✓', true]], 'each done step shows a check on green');
    assert.equal((await list.innerText()).match(/\bDone\b/g)?.length, 4, 'each says Done');
    await s.page.locator('[data-stage-card="review"]').screenshot({ path: join(shots(), 'swap-steps-done.png') });
    const log = await doneInTurn(s.page, [`approve:${FIXTURE_TOKEN}`, 'fund', 'swap', 'mint']);
    assert.ok(log.some(entry => entry.includes('swap=wallet')) && log.some(entry => entry.includes('swap=chain')), 'the swap was asked of the wallet, then waited for');
    await openCreated(s.page, '4242', 60_000);
    // Changed on purpose (owner, 2026-09-24): the new position's own page, not the lookup by id.
    await s.page.locator('[data-position-detail][data-position-id="4242"]').waitFor({ timeout: 30_000 });

    // What the wallet signed, decoded: four transactions, one more than with both tokens.
    const sent = chain.decoded();
    assert.deepEqual(sent.map(tx => tx.functionName), ['approve', 'open', 'swap', 'mint']);
    const [approve, open, swap, mint] = sent;
    assert.deepEqual([approve.to, approve.from, approve.args[0].toLowerCase(), approve.args[1], approve.value, approve.nonce], [FIXTURE_TOKEN, OWNER, setup, typed, 0n, '0x0'],
      'an exact allowance of the typed TOKEN: the typed amount is the budget, so no room is added');
    const [id, key, amount0, amount1] = open.args;
    assert.deepEqual([open.to, open.from, open.nonce, id, amount0, amount1, open.value], [setup, OWNER, '0x1', chain.operationId(0n), 0n, typed, 0n], 'the TOKEN alone, no ETH');
    assert.deepEqual(lowerKey(key), STUB_POOL_KEY);
    const plan = swap.args[0];
    assert.deepEqual([swap.to, swap.from, swap.value, swap.nonce, plan.operationId, plan.zeroForOne], [setup, OWNER, 0n, '0x2', id, false], 'TOKEN (currency 1) for ETH, in the operation just funded');
    assert.ok(plan.grossInput > 0n && plan.grossInput < typed, `part of the deposit: ${plan.grossInput}`);
    // Sized from the contract's own quotes, each the swap simulated through the wallet, then the swap itself simulated
    // once more before it is offered.
    assert.ok(chain.quotes.length >= 2 && chain.quotes.length <= 11, `${chain.quotes.length} quotes: at most ten to size it, and the swap's own simulation`);
    assert.ok(chain.quotes.every(quote => quote.operationId === id && quote.zeroForOne === false), 'every quote for this operation, TOKEN for ETH');
    assert.equal(chain.quotes.at(-1).grossInput, plan.grossInput, 'the size offered is the size last simulated');
    // Before any of it, the pool was checked through the wallet: V4Quoter asked what sizes of TOKEN buy, while nothing
    // had been sent, and the swap step said Checking… before the approval reached the wallet.
    assert.ok(chain.quoted.length >= 2 && chain.quoted.every(q => q.sent === 0 && q.zeroForOne === false), `${chain.quoted.length} quoter questions, all before the first send`);
    // Added (review, 2026-09-24): each size and the one just above it, which give the price the swap ends at, are asked at
    // one block number read for them, never at 'latest', where a block between the two calls would skew their difference.
    assert.equal(chain.quoted.length % 2, 0, 'the sizes in pairs');
    for (let i = 0; i < chain.quoted.length; i += 2) {
      const [size, next] = chain.quoted.slice(i, i + 2);
      assert.match(size.tag, /^0x[0-9a-f]+$/, 'a block number');
      assert.equal(next.tag, size.tag, 'the pair at one block');
      assert.ok(next.exactAmount > size.exactAmount);
    }
    assert.ok(log.findIndex(entry => entry.includes('swap=reading')) < log.findIndex(entry => entry.includes(`approve:${FIXTURE_TOKEN}=wallet`)), 'checked before the approval');
    assert.equal(await s.page.locator('[data-review-liquidity]').count(), 0, 'the pool reports liquidity: Review says nothing about it');
    assert.equal(plan.minOutput, (chain.swapOutput(plan.grossInput, false) * 9950n) / 10000n, 'at least the simulated output less the 0.5% slippage limit');
    assert.ok(plan.sqrtPriceLimitX96 > STUB_SQRT_PRICE && plan.sqrtPriceLimitX96 <= (STUB_SQRT_PRICE * 10500n) / 10000n, 'a price limit above the price: TOKEN in pushes it up, at most 5% in square root');
    const minted = mint.args[0], received = chain.swapOutput(plan.grossInput, false);
    assert.deepEqual([mint.to, mint.value, mint.nonce, minted.operationId, minted.tickLower, minted.tickUpper, minted.maxAmount0, minted.maxAmount1, minted.initialSqrtPriceX96],
      [setup, 0n, '0x3', id, ...STUB_RANGE, received, typed - plan.grossInput, 0n], 'Review’s range, capped at what the operation holds after the swap');
    // TOKEN in pushed the price up; the mint is drawn around the price the swap left, and both sides of the deposit
    // cover (nearly) the same liquidity there: the split was sized for that price, not the one before it.
    const after = chain.price();
    assert.ok(after > STUB_SQRT_PRICE, 'the swap moved the pool');
    assert.ok(minted.minSqrtPriceX96 < after && after < minted.maxSqrtPriceX96, 'the mint’s band is around the price after the swap');
    const expected = mintPlanFor({ sqrtPriceX96: String(after), tickLower: STUB_RANGE[0], tickUpper: STUB_RANGE[1], balance0: received, balance1: typed - plan.grossInput, slippageBps: 50 });
    assert.equal(minted.liquidity, expected.liquidity, 'the liquidity the balances make across the band');
    const [from0, from1] = bandLiquidity(bandFor(after, ...STUB_RANGE, 50), received, typed - plan.grossInput);
    assert.ok((from0 > from1 ? from0 - from1 : from1 - from0) * 200n <= (from0 > from1 ? from0 : from1), `both sides alike, within 0.5%: ${from0} and ${from1}`);
    assert.deepEqual([chain.operations.get(id).swapped, chain.operations.get(id).closed, chain.operations.get(id).tokenId], [true, true, 4242n]);
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

test('with ETH only and TOKEN typed, the ETH pays for the whole position: deposited as the value with room, part swapped for TOKEN inside the pool, then the mint; no approval is asked', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { eth: 10n ** 18n });
  const s = await atReview(chain);
  const { setup } = chain.release.deployment;
  try {
    assert.equal(await s.page.locator('[data-review-amounts]').getAttribute('data-review-plan'), 'swap');
    const swapLine = s.page.locator('[data-review-swap]');
    assert.equal(await swapLine.getAttribute('data-review-swap'), '0', 'from ETH, currency 0');
    // Changed on purpose (round 6, 2026-09-27): the line says what goes in and how much is swapped; what it buys is the headline's.
    const [, from, part] = (await swapLine.innerText()).match(/^You put in ([\d.,]+) ETH\. About ([\d.,]+) ETH of it is swapped for TOKEN\.$/) ?? [];
    const bought = await s.page.locator('[data-review-amounts] [data-review-side="1"]').getAttribute('data-exact');
    const reviewed = parseUnits(from.replaceAll(',', ''), 18);
    assert.ok(parseUnits(part.replaceAll(',', ''), 18) < reviewed);
    assert.ok(parseUnits(bought.replaceAll(',', ''), 6) >= 1_000_000n, `the typed 1 TOKEN, at least: ${bought}`);
    await s.page.locator('[data-review-swap-note]').waitFor();
    // ETH needs no approval: it travels with the deposit.
    assert.deepEqual(await walletStepStates(s.page), [['fund', null], ['swap', null], ['mint', null]]);
    assert.match(await s.page.locator('[data-wallet-steps]').innerText(), /Deposit ETH[\s\S]*Swap part of your deposit[\s\S]*Create the position/);

    await recordWalletSteps(s.page);
    await s.page.locator('[data-create-position="idle"]').click();
    await openCreated(s.page, '4242', 90_000);
    await doneInTurn(s.page, ['fund', 'swap', 'mint']);
    const sent = chain.decoded();
    assert.deepEqual(sent.map(tx => tx.functionName), ['open', 'swap', 'mint'], 'no approval');
    const [open, swap, mint] = sent;
    const [id, , amount0, amount1] = open.args;
    assert.deepEqual([open.to, open.nonce, id, amount1], [setup, '0x0', chain.operationId(0n), 0n], 'ETH alone');
    assert.ok(amount0 > 0n && open.value === amount0, 'the ETH travels as the value');
    // Review estimated with the published 0.65% fee; the chain's deployment charges its own (0.30% here), so the deposit is a little less.
    assert.ok(amount0 <= reviewed && amount0 * 1000n >= reviewed * 990n, `${amount0} against Review’s ${reviewed}`);
    const plan = swap.args[0];
    assert.deepEqual([swap.value, swap.nonce, plan.operationId, plan.zeroForOne], [0n, '0x1', id, true], 'ETH (currency 0) for TOKEN');
    assert.ok(plan.grossInput > 0n && plan.grossInput < amount0);
    assert.ok(plan.sqrtPriceLimitX96 < STUB_SQRT_PRICE && plan.sqrtPriceLimitX96 >= (STUB_SQRT_PRICE * 9500n) / 10000n, 'a price limit below the price: ETH in pushes it down');
    assert.equal(plan.minOutput, (chain.swapOutput(plan.grossInput, true) * 9950n) / 10000n);
    const minted = mint.args[0];
    assert.deepEqual([mint.nonce, minted.operationId, minted.maxAmount0, minted.maxAmount1], ['0x2', id, amount0 - plan.grossInput, chain.swapOutput(plan.grossInput, true)]);
    assert.ok(minted.liquidity > 0n);
    assert.ok(!chain.viewed.includes('allowance'), 'no allowance was even read');
    assert.ok(chain.quoted.length >= 2 && chain.quoted.every(q => q.sent === 0 && q.zeroForOne === true), 'the pool was checked for ETH in before the deposit');
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

// Added 2026-09-28 (round 6 review): the amount typed in the token the wallet does not hold. The swap then buys the typed
// token, and the wallet's other token pays for the whole position. The typed panel stays as typed, never quieted like a
// panel the swap fills. The line under the panels says, from the wallet's side, what comes out of it and how much of that
// is swapped: the deposit Review names. Changed on purpose 2026-10-06 (the owner's point 4): that line is one short
// sentence ("Domino swaps about … for you, so … comes from your wallet."), and above 2% (the spec's line) the step and
// Review warn in the same words, the spec's.
test('typed in the token the wallet lacks, the typed panel stays whole and the line says what comes from the wallet; above 2% the step and Review warn in the spec’s one line', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { eth: 10n ** 18n });
  const s = await atReview(chain);
  try {
    const [, put] = (await s.page.locator('[data-review-swap]').innerText()).match(/^You put in ([\d.,]+) ETH\./) ?? [];
    assert.ok(put, 'Review names the ETH deposit');
    assert.equal(await s.page.locator('[data-review-slippage-warning]').count(), 0, 'nothing to warn about at 0.5%');
    await footerButton(s.page, 'Back').click();
    const amount = s.page.locator('[data-stage-card="amount"] [data-stage="amount"]');
    await amount.waitFor();
    const typed = amount.locator('[data-pair-side="1"]');
    assert.equal(await typed.getAttribute('data-pair-role'), 'typed');
    assert.equal(await typed.locator('input').inputValue(), '1');
    assert.equal(await amount.locator('[data-plan-side]').count(), 0, 'no panel is quieted: the typed one is the amount asked for, and the other is paid in full');
    const [ink, full] = await typed.locator('input').evaluate(node => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--fg)';
      document.body.append(probe);
      const fg = getComputedStyle(probe).color;
      probe.remove();
      return [getComputedStyle(node).color, fg];
    });
    assert.equal(ink, full, 'the typed amount keeps its full ink');
    const line = amount.locator('[data-amount-swap="0"]');
    assert.equal(await line.getAttribute('data-amount-swap-typed'), '');
    const [, part, from] = (await line.innerText()).match(/^Domino swaps about ([\d.,]+) ETH for TOKEN for you, so ([\d.,]+) ETH comes from your wallet\.$/) ?? [];
    assert.equal(from, put, 'the deposit Review names, shown here too');
    const partRaw = parseUnits(part.replaceAll(',', ''), 18);
    assert.ok(partRaw > 0n && partRaw < parseUnits(from.replaceAll(',', ''), 18), `part of it: ${part} of ${from}`);
    assert.equal(await amount.locator('[data-amount-short]').count(), 0);

    // 3%, typed under Advanced: the step warns beside its slider, and Review warns in the same words.
    await amount.locator('[data-flow-advanced] > summary').click();
    await amount.locator('#create-slippage-exact').fill('3');
    await amount.locator('[data-slippage-warning]').waitFor();
    assert.equal(await amount.locator('[data-slippage-warning]').innerText(), 'High slippage: you may receive noticeably less than quoted.');
    await footerButton(s.page, 'Continue').click();
    await s.page.locator('[data-stage-card="review"] [data-review-slippage-warning]').waitFor();
    assert.equal(await s.page.locator('[data-review-slippage-warning]').innerText(), 'High slippage: you may receive noticeably less than quoted.');
    assert.equal(await s.page.locator('[data-review-details]').evaluate(node => node.open), false, 'the tolerance itself stays inside the closed Details');
    assert.deepEqual(chain.sends, [], 'nothing is sent by going back and forth');
  } finally { await s.close(); }
});

// Added 2026-10-31 (QA round 2 follow-ups, Q12 and Q24): Review names every automation the created view and Automate offer,
// with "Automate." kept on one line (the hidden new-tab words gave the line a break before the period); and its Details
// list the pair's contracts in the order the headline names the pair (TOKEN / ETH), never the pool's own (ETH first).
test('Review names every automation with “Automate.” on one line, and its Details list the contracts in the pair’s order', async () => {
  // Whether the period after the link sits on the line of the link's visible word.
  const sameLine = (node) => {
    const box = (text) => { const range = document.createRange(); range.selectNodeContents(text); return range.getBoundingClientRect(); };
    const dot = [...node.childNodes].find((child) => child.nodeType === Node.TEXT_NODE && child.textContent === '.');
    const word = node.querySelector('a').firstChild;
    return dot !== undefined && Math.abs(box(dot).top - box(word).top) < 2;
  };
  const chain = fakeDepositChain(ACCOUNTS[0].address, { eth: 10n ** 18n });
  const s = await atReview(chain);
  try {
    const later = s.page.locator('[data-stage-card="review"] [data-review-automate-later]');
    assert.match(await later.innerText(), /^You can add Auto-compound, Domino-compound or Auto-exit after the position is created, from Automate/);
    const kept = later.locator('.whitespace-nowrap');
    assert.equal(await kept.count(), 1);
    assert.equal(await kept.locator('a[target="_blank"]').count(), 1, 'the link is inside it');
    assert.equal(await kept.evaluate(node => node.textContent), 'Automate (opens in a new tab).', 'the link, then its period');
    assert.equal(await kept.evaluate(sameLine), true, 'the period on the link’s line');
    const size = s.page.viewportSize();
    for (const width of [390, 360]) {
      await s.page.setViewportSize({ width, height: 844 });
      assert.equal(await kept.evaluate(sameLine), true, `at ${width} px too`);
    }
    await s.page.setViewportSize(size);
    assert.match(await s.page.locator('[data-review-headline] .dm-flow-headline-pair').innerText(), /^TOKEN \/ ETH/);
    const details = s.page.locator('[data-review-details]');
    await details.locator('summary').click();
    const contracts = await details.locator('.dm-flow-facts-tokens > span').allInnerTexts();
    assert.equal(contracts.length, 2);
    assert.match(contracts[0], /^TOKEN\b/, 'the token the price is written for first');
    assert.match(contracts[1], /^ETH\s+native$/, 'then the token it is written in');
    assert.deepEqual(chain.sends, []);
  } finally { await s.close(); }
});

// ---- Before a one-token deposit (2026-09-24): the owner deposited 0.1 USDG alone into USDG/NET 8%, a pool with nothing
// in range; every swap reverted and the deposit was held. A one-token deposit is now made only into a pool that can
// swap part of it, and a pool that cannot is said before the wallet is asked for anything. ----

/** The read service's pools answer with the fixture pool's liquidity reported as zero, as DexScreener reported the owner's pool. */
const emptyPools = (route) => {
  if (route !== 'pools') return undefined;
  const base = readGateway('pools.success');
  return JSON.stringify({ ...base, pools: base.pools.map(pool => ({ ...pool, providerMetrics: { ...pool.providerMetrics, reportedLiquidityUsd: '0.00' } })) });
};

test('a one-token deposit into a pool with nothing in range is refused before anything is sent: Review warns from the pool’s reported liquidity, and Create position reads the pool, says nothing was deposited, and asks the wallet for nothing', async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 2n * typed }, liquidity: 0n });
  const s = await atReview(chain, { answer: emptyPools, amount: '10000000000' });
  try {
    assert.equal(await s.page.locator('[data-review-amounts]').getAttribute('data-review-plan'), 'swap');
    // Review, from the figure it already has and no wallet read: one neutral line under the swap note.
    const warning = s.page.locator('[data-review-liquidity="none"]');
    // Changed on purpose (round 6, 2026-09-27, the owner: New position for people who know nothing about pools): plain words.
    assert.equal(await warning.innerText(), 'This pool is empty, so part of your deposit can’t be swapped in it. Add both tokens, or choose another pool.');
    assert.equal(await warning.getAttribute('data-tone'), 'neutral');
    assert.deepEqual(chain.viewed, [], 'Review read nothing through the wallet');
    await recordWalletSteps(s.page);
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-position="failed"]').waitFor({ timeout: 60_000 });
    const notice = s.page.locator('[data-create-notice="pool_no_liquidity"]');
    assert.equal(await notice.innerText(), 'This pool has no liquidity at its current price, so part of your deposit cannot be swapped in it. Nothing was deposited. Deposit both tokens, or choose another pool.');
    assert.deepEqual(chain.sends, [], 'no approval and no deposit');
    assert.deepEqual(await walletStepStates(s.page), [[`approve:${FIXTURE_TOKEN}`, 'waiting'], ['fund', 'waiting'], ['swap', 'failed'], ['mint', 'waiting']], 'stopped at the check, before the approval');
    assert.ok((await s.page.evaluate(() => window.__walletStepLog)).some(entry => entry.includes('swap=reading')), 'the swap step said Checking… while the pool was read');
    assert.equal(await s.page.getByRole('button', { name: 'Refund the deposit instead', exact: true }).count(), 0, 'nothing is held');
    assert.ok(chain.viewed.includes('getLiquidity'), 'the pool’s in-range liquidity was read on chain, through the wallet');
    // Changed on purpose (review, 2026-09-24): the quotes decide, and nothing in range only picks the sentence. V4Quoter
    // refused every size asked, NotEnoughLiquidity, as it did for the owner's pool.
    assert.ok(chain.quoted.length >= 1 && chain.quoted.every(q => q.sent === 0), `${chain.quoted.length} sizes asked, all before anything was sent`);
    assert.deepEqual(chain.reverts, chain.quoted.map(() => 'execution reverted: NotEnoughLiquidity'), 'each refused by the quoter');
    assert.ok(!chain.log.includes('eth_estimateGas') && !chain.viewed.includes('allowance'), 'no spending step was prepared');
    assert.equal(chain.viewed.filter(name => name === 'nextOperationId').length, 1, 'only the pending-batch recovery identity was read, not a new funding preparation');
    assert.ok(!chain.log.includes('wallet_sendCalls'), 'no atomic spending request was offered either');
    assert.equal(chain.operations.size, 0);
    await onlyTheWallet(s, chain, { reverts: true });
    assert.doesNotMatch(await s.page.locator('main').innerText(), FORBIDDEN);
  } finally { await s.close(); }
});

test('in a pool too thin for the balanced split, the check backs off to a swap the pool fills inside its limit before anything is sent, and Create position approves, deposits, swaps and mints', async () => {
  const typed = 10n ** 16n;
  // 5·10¹⁶ of liquidity: swapping half the TOKEN, as the balanced split would, moves the square-root price about 10%.
  const chain = fakeDepositChain(ACCOUNTS[0].address, { eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 2n * typed }, liquidity: 5n * 10n ** 16n });
  const s = await atReview(chain, { amount: '10000000000' });
  try {
    const [, part] = (await s.page.locator('[data-review-swap]').innerText()).match(/About ([\d.,]+) TOKEN of it is swapped/) ?? [];
    const balanced = parseUnits(part.replaceAll(',', ''), 6);
    const limit = (STUB_SQRT_PRICE * 10500n) / 10000n, check = (STUB_SQRT_PRICE * 10450n) / 10000n;
    assert.ok(chain.priceAfter(balanced, false) > limit, 'Review’s balanced split would pass the swap’s 5% limit here');
    assert.equal(await s.page.locator('[data-review-liquidity]').count(), 0, 'the pool reports liquidity');
    await s.page.locator('[data-create-position="idle"]').click();
    await openCreated(s.page, '4242', 90_000);
    const sent = chain.decoded();
    assert.deepEqual(sent.map(tx => tx.functionName), ['approve', 'open', 'swap', 'mint']);
    const [, open, swap, mint] = sent;
    assert.deepEqual([open.args[2], open.args[3]], [0n, typed], 'the typed TOKEN alone');
    // The check, before any send: V4Quoter was asked net sizes, a size past 4.5% was refused and one inside it found.
    assert.ok(chain.quoted.length >= 4 && chain.quoted.every(q => q.sent === 0 && q.zeroForOne === false), `${chain.quoted.length} quoter questions, all before the first send`);
    assert.ok(chain.quoted.some(q => chain.priceAfter(q.exactAmount, false, 0) >= check), 'a size that would end past the check was asked, and refused');
    assert.ok(chain.quoted.some(q => chain.priceAfter(q.exactAmount, false, 0) < check), 'and a size inside it');
    // After the deposit the contract's own quotes size the swap sent, and it fills inside the 5% limit.
    const plan = swap.args[0];
    assert.ok(plan.grossInput > 0n && plan.grossInput < balanced, `a smaller swap than the balanced ${balanced}: ${plan.grossInput}`);
    assert.ok(chain.price() > STUB_SQRT_PRICE && chain.price() <= limit, 'the swap filled, inside its limit');
    assert.ok(chain.reverts.length >= 1 && chain.reverts.every(why => /a partial fill/.test(why)), 'the contract refused the balanced size as a partial fill');
    assert.ok(mint.args[0].liquidity > 0n);
    assert.deepEqual([chain.operations.get(open.args[0]).swapped, chain.operations.get(open.args[0]).tokenId], [true, 4242n]);
    await onlyTheWallet(s, chain, { reverts: true });
  } finally { await s.close(); }
});

test('a held one-token deposit in a pool with nothing in range: Create position says it cannot be swapped there, signs nothing, and puts the refund first', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { liquidity: 0n, finality: 'lagging' });
  // The owner's case: 0.1 of one token deposited alone, and nothing in range to swap part of it against.
  const id = chain.seed({ key: STUB_POOL_KEY, balance0: 0n, balance1: 100_000n });
  const s = await atReview(chain);
  const { setup } = chain.release.deployment;
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.getByRole('status').filter({ hasText: /^You have an earlier deposit in this pool: [\d.,]+ ETH and 0\.1 TOKEN\./ }).waitFor({ timeout: 30_000 });
    await s.page.locator('[data-create-position="held"]').click();
    const notice = s.page.locator('[data-create-notice="held_pool_no_liquidity"]');
    await notice.waitFor({ timeout: 60_000 });
    assert.equal(await notice.innerText(), 'This pool has no liquidity at its current price, so your deposit cannot be swapped in it. Refund the deposit to your wallet.');
    const again = s.page.locator('[data-create-position="held"]');
    await again.waitFor();
    assert.deepEqual(chain.sends, [], 'nothing was signed');
    assert.ok(!chain.log.includes('eth_sendTransaction') && !chain.log.includes('eth_estimateGas'), 'nothing was even prepared');
    // Changed on purpose (review, 2026-09-24): the contract's own quotes decide. It refused every size simulated.
    assert.deepEqual([chain.quotes, chain.quoted], [[], []], 'no size filled, and V4Quoter is not asked after a deposit');
    assert.ok(chain.reverts.length >= 1 && chain.reverts.every(why => why === 'execution reverted: nothing in range: the swap consumes nothing'), `${chain.reverts.length} sizes simulated, each refused`);
    assert.deepEqual(await walletStepStates(s.page), [['fund', 'done'], ['swap', 'failed'], ['mint', 'waiting']]);
    // The refund is the one main action now; Create position stays, drawn second.
    const refund = s.page.locator('[data-create-refund="first"]');
    assert.equal(await refund.innerText(), 'Refund the deposit instead');
    assert.match(await refund.getAttribute('class'), /\bdm-btn--primary\b/);
    assert.match(await again.getAttribute('class'), /\bdm-btn--outline\b/);
    // Changed on purpose (round 6, 2026-09-27/28, the owner: plain words): one short sentence, "refund" as the button says it.
    assert.equal(await s.page.locator('#create-reason').innerText(), 'You have a deposit waiting in this pool. Refund it to your wallet.');
    await refund.click();
    await s.page.getByRole('status').filter({ hasText: 'The deposit was refunded to your wallet.' }).waitFor({ timeout: 60_000 });
    const [cancel] = chain.decoded();
    assert.deepEqual([chain.sends.length, cancel.functionName, cancel.to, cancel.args[0]], [1, 'cancel', setup, id], 'the refund of that deposit, and nothing else');
    assert.equal(await s.page.locator('[data-create-refund]').count(), 0);
    await onlyTheWallet(s, chain, { reverts: true });
  } finally { await s.close(); }
});

// ---- Review, 2026-09-24: nothing in range at a pool's price is not a pool that cannot swap. A range the price reaches
// may fill the swap, as the quotes say; nothing in range only picks the sentence once no size fills. ----

/** A square-root price 1.6% above the stub's: the pool's liquidity starts there, and nothing is in range below it. */
const LIQUID_FROM = (STUB_SQRT_PRICE * 10160n) / 10000n;

test('a pool with nothing in range at its price and a range just above it: the quotes find the swap filling there, inside its limit, and Create position approves, deposits, swaps and mints', async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { eth: GAS_ONLY_ETH, balances: { [FIXTURE_TOKEN]: 2n * typed }, liquidFrom: LIQUID_FROM });
  const s = await atReview(chain, { amount: '10000000000' });
  try {
    assert.equal(chain.liquidityAt(STUB_SQRT_PRICE), 0n, 'nothing in range at the pool’s price');
    assert.equal(await s.page.locator('[data-review-amounts]').getAttribute('data-review-plan'), 'swap');
    await s.page.locator('[data-create-position="idle"]').click();
    await openCreated(s.page, '4242', 90_000);
    assert.equal(await s.page.locator('[data-create-notice="pool_no_liquidity"]').count(), 0);
    const sent = chain.decoded();
    assert.deepEqual(sent.map(tx => tx.functionName), ['approve', 'open', 'swap', 'mint'], 'the flow went on');
    const [, open, swap, mint] = sent;
    assert.deepEqual([open.args[2], open.args[3]], [0n, typed], 'the typed TOKEN alone');
    // Before any send, the pool read with nothing in range, and V4Quoter asked what sizes buy: they filled.
    assert.ok(chain.viewed.includes('getLiquidity'));
    assert.ok(chain.quoted.length >= 2 && chain.quoted.every(q => q.sent === 0 && q.zeroForOne === false), `${chain.quoted.length} quoter questions, all before the first send`);
    // The swap crossed the empty stretch and filled inside its 5% limit, in the range above.
    const plan = swap.args[0], limit = (STUB_SQRT_PRICE * 10500n) / 10000n;
    assert.ok(plan.grossInput > 0n && plan.grossInput < typed);
    assert.ok(chain.price() > LIQUID_FROM && chain.price() <= limit, `filled above ${LIQUID_FROM}, inside ${limit}: ${chain.price()}`);
    assert.ok(mint.args[0].liquidity > 0n);
    assert.deepEqual([chain.operations.get(open.args[0]).swapped, chain.operations.get(open.args[0]).tokenId], [true, 4242n]);
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

test('a held one-token deposit in a pool with nothing in range at its price and a range just above it: the contract’s quotes fill, and Create position swaps and mints it, with no refund first', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { tokenId: 4243n, liquidFrom: LIQUID_FROM, finality: 'lagging' });
  const id = chain.seed({ key: STUB_POOL_KEY, balance0: 0n, balance1: 10n ** 15n });
  const s = await atReview(chain);
  try {
    assert.equal(chain.liquidityAt(STUB_SQRT_PRICE), 0n, 'nothing in range at the pool’s price');
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.getByRole('status').filter({ hasText: /^You have an earlier deposit in this pool: 0 ETH and [\d.,]+ TOKEN\./ }).waitFor({ timeout: 30_000 });
    await s.page.locator('[data-create-position="held"]').click();
    await openCreated(s.page, '4243', 90_000);
    assert.equal(await s.page.locator('[data-create-notice="held_pool_no_liquidity"]').count(), 0);
    assert.equal(await s.page.locator('[data-create-refund]').count(), 0, 'no refund put first');
    const sent = chain.decoded();
    assert.deepEqual(sent.map(tx => tx.functionName), ['swap', 'mint'], 'no second deposit: the swap, then the mint');
    const [swap, mint] = sent;
    assert.deepEqual([swap.args[0].operationId, swap.args[0].zeroForOne, mint.args[0].operationId], [id, false, id]);
    assert.ok(chain.viewed.includes('getLiquidity'), 'the pool read with nothing in range');
    assert.ok(chain.quotes.length >= 2 && chain.quotes.every(quote => quote.operationId === id), 'sized from the contract’s own quotes, which filled');
    assert.ok(chain.price() > LIQUID_FROM, 'the swap crossed the empty stretch and filled above it');
    assert.deepEqual([chain.operations.get(id).swapped, chain.operations.get(id).tokenId], [true, 4243n]);
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

test('leaving New position while the pool is checked before a one-token deposit: nothing is prepared or sent, and the check stops', async () => {
  const typed = 10n ** 16n;
  // A slow wallet: each quoter question takes a second, so the check is still running when the person leaves.
  const chain = fakeDepositChain(ACCOUNTS[0].address, { eth: 10n ** 16n, balances: { [FIXTURE_TOKEN]: 2n * typed }, quoteDelayMs: 1_000 });
  const s = await atReview(chain, { amount: '10000000000' });
  const until = async (done, ms = 30_000) => {
    const end = Date.now() + ms;
    while (!done()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  };
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-wallet-step="swap"][data-step-state="reading"]').waitFor({ timeout: 30_000 });
    // The first size answered, and more to come: the person leaves by another page's link.
    await until(() => chain.quoted.length >= 1);
    const fundingReads = () => chain.viewed.filter(name => ['allowance', 'balanceOf', 'nextOperationId'].includes(name));
    const fundingReadsBeforeLeave = fundingReads();
    await s.page.evaluate(() => { location.hash = '#/docs'; });
    const left = chain.quoted.length;
    await s.page.locator('[data-create-position]').waitFor({ state: 'detached', timeout: 10_000 });
    // Quiet for three questions' time, then two seconds more for anything the check would have been followed by.
    let seen = chain.log.length, quietSince = Date.now();
    await until(() => {
      if (chain.log.length !== seen) { seen = chain.log.length; quietSince = Date.now(); }
      return Date.now() - quietSince > 3_000;
    }, 60_000);
    await new Promise(resolve => setTimeout(resolve, 2_000));
    assert.deepEqual(chain.sends, [], 'no approval and no deposit');
    assert.ok(!chain.log.includes('eth_sendTransaction'), 'the wallet was never asked to sign');
    assert.ok(!chain.log.includes('eth_estimateGas') && !chain.viewed.includes('allowance'), 'no spending step was prepared');
    assert.equal(chain.viewed.filter(name => name === 'nextOperationId').length, 1, 'the sole recovery identity read preceded the pool check');
    assert.deepEqual(fundingReads(), fundingReadsBeforeLeave, 'leaving stops new funding/recovery reads as well as spending preparation');
    assert.ok(!chain.log.includes('wallet_sendCalls'), 'the wallet was never asked for an atomic batch');
    assert.ok(chain.quoted.length <= left + 1, `the check stopped with the question in flight: ${left} asked when the page was left, ${chain.quoted.length} in all`);
    assert.equal(chain.operations.size, 0);
  } finally { await s.close(); }
});

test('a device clock far off the chain’s stops a one-token deposit before anything is sent, with its own sentence', async () => {
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { eth: 10n ** 16n, balances: { [FIXTURE_TOKEN]: 2n * typed }, clockSkew: 900 });
  const s = await atReview(chain, { amount: '10000000000' });
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    const notice = s.page.locator('[data-create-notice="device_clock_off"]');
    await notice.waitFor({ timeout: 60_000 });
    assert.equal(await notice.innerText(), 'Your device’s clock is more than 5 minutes off the network’s time. Nothing was deposited. Set the clock right, then try again.');
    assert.equal(await s.page.locator('[data-create-position]').getAttribute('data-create-position'), 'failed');
    assert.deepEqual([chain.sends, chain.quoted], [[], []]);
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

// Changed on purpose (owner, 2026-09-24): a pool with hooks is no longer listed and then refused at Continue; it is
// never listed. Domino's setup contract refuses it (DominoSetup.open), so step 1 leaves it out of the search itself,
// before any row or count, and says nothing about hooks. journey.canContinue still refuses one if it ever arrived
// (create-journey.test.mjs), and a link to one preselects nothing (Journey.tsx).
test('a pool with hooks is never listed at the pool step: the muted empty line, nothing chosen, and Continue stays off', async () => {
  const HOOKS = `0x${'ab'.repeat(20)}`;
  const hooked = (route) => {
    if (route !== 'pools') return undefined;
    const base = readGateway('pools.success');
    return JSON.stringify({ ...base, pools: base.pools.map(pool => ({ ...pool, poolKey: { ...pool.poolKey, hooks: HOOKS }, integrationClass: 'requires_separate_adapter' })) });
  };
  const read = createReadStub({ answer: hooked });
  const s = await scenario({ routes: [(request, url) => read.handle(request, url)] });
  await s.context.route(ARTWORK, route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  try {
    await s.page.goto(`${s.origin}/#/new`);
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await s.page.getByRole('combobox', { name: 'Search a token' }).fill(FIXTURE_TOKEN);
    await s.page.locator(`[data-token-option="${FIXTURE_TOKEN}"]`).click();
    const picker = s.page.locator('[data-picker="pool"][data-pools-state="ok"]');
    await picker.waitFor({ timeout: 30_000 });
    assert.equal(await picker.getAttribute('data-picker-variant'), 'create');
    assert.equal(await picker.getAttribute('data-pools-hidden'), '1', 'the hooked pool was read, and left out');
    assert.equal(await s.page.locator('[data-pool-option]').count(), 0, 'no row for it');
    assert.equal(await s.page.locator('[data-picker="pool"] input[name="pool-option"]').count(), 0);
    assert.equal(await picker.locator('[data-pools-empty]').innerText(), 'No pools to show for this token.');
    assert.equal(await s.page.locator('[data-chosen-pool]').count(), 0);
    const stage = await s.page.locator('[data-stage="token"]').innerText();
    assert.doesNotMatch(stage, /hooks|adapter|verified at block|No market figures/i, 'hooks are never mentioned');
    assert.doesNotMatch(stage, FORBIDDEN);
    const next = footerButton(s.page, 'Continue');
    assert.equal(await next.isDisabled(), true);
    assert.equal(await s.page.locator('#continue-reason').innerText(), 'Choose a pool to continue.');
    // Changed on purpose (owner, 2026-09-24): step 1 has nowhere to go back to, so it offers Continue alone.
    assert.equal(await footerButton(s.page, 'Back').count(), 0, 'no Back on step 1');
    // The provider lists no pool for the token here, so the read is today's, for the token alone.
    assert.deepEqual(read.requests.filter(r => r.path === '/api/read/v1/pools').map(r => JSON.parse(r.body)), [{ token: FIXTURE_TOKEN }]);
    assert.equal(await s.page.locator('[data-stage="range"]').count(), 0, 'the range step is not reached');
    assert.equal(await s.page.locator('[data-create-position]').count(), 0);
  } finally { await s.close(); }
});

// Added 2026-09-24 (owner): the other way into step 1 is a link carrying a pool id (a pool page's New position,
// or a shared #/new/<id>). A pool with hooks is verified like any other and then not preselected: the search is
// offered instead, and why is said only in the step's live region and data, never as a panel.
test('a link to a pool with hooks preselects nothing: the search is offered, and the reason is data and a live region only', async () => {
  const HOOKS = `0x${'ab'.repeat(20)}`;
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const LINKED = `0x${'e'.repeat(64)}`;
  const asked = [];
  const hookedById = (route, body) => {
    if (route !== 'pools') return undefined;
    asked.push(body);
    const base = readGateway('pools.success'), [pool] = base.pools;
    return JSON.stringify({
      ...base,
      selectedToken: USDG,
      tokens: base.tokens.map(token => (token.address === FIXTURE_TOKEN ? { ...token, address: USDG, symbol: 'USDG' } : token)),
      pools: [{ ...pool, poolId: LINKED, currencies: [pool.currencies[0], USDG], poolKey: { ...pool.poolKey, currency1: USDG, hooks: HOOKS }, integrationClass: 'requires_separate_adapter', requestedById: true }],
    });
  };
  const read = createReadStub({ answer: hookedById });
  const s = await scenario({ routes: [(request, url) => read.handle(request, url)] });
  await s.context.route(ARTWORK, route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  try {
    await s.page.goto(`${s.origin}/#/new/${LINKED}`);
    const stage = s.page.locator('[data-stage="token"][data-preselect="unsupported"]');
    await stage.waitFor({ timeout: 30_000 });
    assert.equal(await stage.getAttribute('data-preselect-reason'), 'hooks');
    assert.equal(await s.page.locator('[data-chosen-pool]').count(), 0, 'nothing is preselected');
    assert.equal(await s.page.locator('[data-deposit-choice]').count(), 0);
    await s.page.getByRole('combobox', { name: 'Search a token' }).waitFor();
    assert.equal(await stage.locator('p[role="status"].sr-only').first().textContent(), 'Pool from the link: This pool has hooks, and positions can only be created here in pools without hooks. Choose another pool.');
    // Changed on purpose (owner, 2026-09-24): until a token is chosen step 1 shows no Back and no Continue (they
    // arrive with the token); the reason stays in the footer's live region, out of sight.
    assert.equal(await s.page.locator('[data-journey-footer] button').count(), 0, 'no buttons before a token is chosen');
    assert.equal(await s.page.locator('#continue-reason').textContent(), 'Choose a token to continue.');
    assert.deepEqual(asked, [{ token: USDG, maxPools: 1, poolIds: [LINKED] }], 'the link is verified against USDG, by its id alone, once');
  } finally { await s.close(); }
});

// Added 2026-09-27 (round 6, the owner: New position from a pool page looked different from New position from
// Positions). A pool page's link names the token the page verified the pool with (#/new/<id>/<token>), so a pool of
// neither list is verified with it rather than with USDG, which it may not hold; and the pool arrives exactly as a
// pool chosen from the list does: the chosen pool and Continue, with no question about which token is deposited.
test('a link from a pool page verifies the pool with the token it names, and step 1 is the chosen pool and Continue, as from the list', async () => {
  const LINKED = `0x${'f'.repeat(64)}`;
  const asked = [];
  const byId = (route, body) => {
    if (route !== 'pools') return undefined;
    asked.push(body);
    const base = readGateway('pools.success'), [pool] = base.pools;
    return JSON.stringify({ ...base, pools: [{ ...pool, poolId: LINKED, requestedById: true }] });
  };
  const read = createReadStub({ answer: byId });
  const s = await scenario({ routes: [(request, url) => read.handle(request, url)] });
  await s.context.route(ARTWORK, route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  try {
    await s.page.goto(`${s.origin}/#/new/${LINKED}/${FIXTURE_TOKEN}`);
    const stage = s.page.locator('[data-stage="token"][data-preselect="verified"]');
    await stage.waitFor({ timeout: 30_000 });
    assert.deepEqual(asked, [{ token: FIXTURE_TOKEN, maxPools: 1, poolIds: [LINKED] }], 'verified once, with the token the link names');
    assert.equal(await s.page.locator('[data-chosen-pool]').getAttribute('data-chosen-pool'), LINKED);
    // Changed on purpose 2026-10-01 (audit E21): the fee as every chip writes it.
    assert.equal(await s.page.locator('[data-chosen-pool] .dm-chip').innerText(), 'Uniswap · 0.30% fee');
    assert.equal(await s.page.locator('[data-deposit-choice], [data-deposit-token]').count(), 0, 'no question about which token is deposited');
    assert.equal(await s.page.getByRole('combobox', { name: 'Search a token' }).count(), 0, 'the pool is chosen: no search until Change pool');
    const next = footerButton(s.page, 'Continue');
    assert.equal(await next.isDisabled(), false, 'Continue at once, as when the pool is chosen from the list');
    await next.click();
    await s.page.locator('[data-stage="range"]').waitFor();
    // Changed on purpose 2026-10-01 (integration pass 3, audit E21): the step's row writes the fee as every chip does
    // (components/create/StepList.tsx, lib/format/fee.ts feeWords).
    // Changed on purpose 2026-10-30 (QA round 2, Q24): the pair named as its price is written ("1 TOKEN = … ETH"), as Markets does.
    assert.equal(await s.page.locator('li[data-step="pool"] .dm-flow-row-summary').innerText(), 'TOKEN / ETH · 0.30% fee', 'no "deposit TOKEN" on the row');
  } finally { await s.close(); }
});

// Added 2026-09-28 (round 6 review): New position's own Range step (components/create/RangeStep.tsx), which replaced
// the Markets dialog's range controls inside the flow, driven the way a person does: the three widths and their words, the
// keyboard on the width switch, a price typed the way the page writes one, a refused price whose error leaves with Custom,
// the line for a range that does not hold today's price, and the price read again once it is 5 minutes old, once. The
// fixture pool is ETH/TOKEN at tick 0 with a tick spacing of 60: 1 ETH = 1,000,000,000,000 TOKEN.
// Changed on purpose 2026-09-28 (one-sided): the app writes a token's price in ETH (lib/read/orientation.ts), so the step
// reads "1 TOKEN = 0.000000000001 ETH", its lowest price first; each end's tick (data-bound-tick) is still the pool's own,
// so the lowest price sits at the pool's upper tick. Its prices are too small for thousands separators: the typed price
// is a plain decimal now.
test('New position’s Range step: Closer, Wider and Custom in words, the arrow keys, a typed price moved outward, a refused price cleared by a preset, the out-of-range line, and a stale price read again once', async () => {
  const read = createReadStub();
  const s = await scenario({ clock: true, routes: [(request, url) => read.handle(request, url)] });
  await s.context.route(ARTWORK, route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  try {
    await s.page.goto(`${s.origin}/#/new`);
    await choosePool(s.page);
    await footerButton(s.page, 'Continue').click();
    const step = s.page.locator('li[data-step="range"] [data-picker="range"]');
    await step.waitFor();
    const ticks = () => step.locator('[data-bound-tick]').allTextContents();
    const checked = () => step.locator('[role="radio"][aria-checked="true"]').allInnerTexts();
    const away = () => step.locator('.dm-flow-bound-away').allInnerTexts();
    const alerts = step.locator('[role="alert"]');
    const lowerPrice = step.locator('#range-lower-price'), upperPrice = step.locator('#range-upper-price');
    const focused = () => s.page.evaluate(() => document.activeElement?.getAttribute('data-width'));

    // Closer by default: today's price and both ends as "1 TOKEN = …", how far each is from today, and no field to type in.
    assert.equal(await step.locator('[data-pool-price-text]').innerText(), '1 TOKEN = 0.000000000001 ETH');
    assert.deepEqual(await checked(), ['Closer']);
    assert.deepEqual(await ticks(), ['3600', '-4080']);
    assert.deepEqual(await away(), ['30% below today', '50% above today']);
    // Changed on purpose 2026-10-30 (QA round 2, Q30): literal width lines (lib/create/copy.ts widthLines).
    assert.equal(await step.locator('.dm-flow-width-line').innerText(), 'Earns more per dollar, but the price leaves it sooner.');
    assert.equal(await step.locator('[data-range-bound="lower"] [data-bound-price]').innerText(), '1 TOKEN = 0.000000000000697689 ETH');
    assert.equal(await step.locator('[data-range-bound="upper"] [data-bound-price]').innerText(), '1 TOKEN = 0.00000000000150378 ETH');
    assert.equal(await step.locator('input').count(), 0, 'no field, step or slider until Custom');
    // Changed on purpose 2026-10-30 (QA round 2, Q30): the width lines say "per dollar"; a price is still never "X per Y".
    assert.doesNotMatch(await step.innerText(), /≈|\bper (?!dollar)|\btick/i, 'no "≈", no "per" in a price, no ticks on screen');

    await step.getByRole('radio', { name: 'Wider' }).click();
    assert.deepEqual(await checked(), ['Wider']);
    assert.deepEqual(await ticks(), ['6960', '-6960']);
    assert.deepEqual(await away(), ['50% below today', '101% above today']);
    assert.equal(await step.locator('.dm-flow-width-line').innerText(), 'Stays in range longer, earns less per dollar.');

    // The arrow keys move the width switch, and the focus with it; Home and End go to either end.
    await step.getByRole('radio', { name: 'Wider' }).focus();
    await s.page.keyboard.press('ArrowLeft');
    assert.deepEqual([await checked(), await ticks(), await focused()], [['Closer'], ['3600', '-4080'], 'standard']);
    await s.page.keyboard.press('End');
    assert.deepEqual([await checked(), await ticks()], [['Custom'], ['3600', '-4080']], 'Custom keeps the range it opens on');
    assert.equal(await step.locator('.dm-flow-width-line').innerText(), 'Set your own lowest and highest price.');
    await s.page.keyboard.press('Home');
    assert.deepEqual(await checked(), ['Closer']);
    await s.page.keyboard.press('ArrowRight');
    assert.deepEqual([await checked(), await ticks()], [['Wider'], ['6960', '-6960']]);
    await s.page.keyboard.press('ArrowLeft');
    await s.page.keyboard.press('ArrowLeft');
    assert.deepEqual([await checked(), await ticks(), await focused()], [['Custom'], ['3600', '-4080'], 'custom'], 'from Closer, left wraps round to Custom');
    assert.equal(await lowerPrice.count(), 1, 'Custom opens the fields');
    assert.equal(await upperPrice.inputValue(), '0.00000000000150378', 'the field holds the price as the page writes it');

    // A typed price moves outward to the pool's step: TOKEN's highest price 2·10⁻¹² ETH, the pool's tick −6960.
    await upperPrice.fill('0.000000000002');
    await upperPrice.press('Enter');
    assert.deepEqual(await ticks(), ['3600', '-6960']);
    assert.deepEqual(await away(), ['30% below today', '101% above today']);
    assert.equal(await alerts.count(), 0);

    // A refused price is said in plain words under its field, until a preset replaces the range; it does not come back.
    await lowerPrice.fill('lots');
    await lowerPrice.press('Enter');
    assert.equal(await alerts.innerText(), 'Enter a price as a number, like 2000 or 0.5.');
    await lowerPrice.fill('0.000000000009');
    await lowerPrice.press('Enter');
    assert.equal(await alerts.innerText(), 'The lowest price must stay below the highest price.');
    assert.equal(await lowerPrice.getAttribute('aria-invalid'), 'true');
    assert.deepEqual(await ticks(), ['3600', '-6960'], 'the range is untouched');
    await step.getByRole('radio', { name: 'Closer' }).click();
    assert.deepEqual([await checked(), await ticks()], [['Closer'], ['3600', '-4080']]);
    assert.equal(await alerts.count(), 0, 'the error leaves with Custom');
    await footerButton(s.page, 'Continue').click();
    await s.page.locator('li[data-step="amount"][aria-current="step"]').waitFor();
    await footerButton(s.page, 'Back').click();
    await s.page.locator('li[data-step="range"][aria-current="step"]').waitFor();
    assert.equal(await alerts.count(), 0, 'and is not there after Amount and Back');
    await step.getByRole('radio', { name: 'Custom' }).click();
    assert.equal(await alerts.count(), 0, 'nor when Custom opens again');
    assert.equal(await lowerPrice.inputValue(), '0.000000000000697689', 'the field shows the range’s own price, not the refused one');
    assert.equal(await lowerPrice.getAttribute('aria-invalid'), null);

    // A lowest price above today's: the range does not hold today's price, and one line says what that means.
    assert.equal(await step.locator('p[data-range-position]').count(), 0, 'nothing to warn about while the range holds the price');
    await lowerPrice.fill('0.0000000000011');
    await lowerPrice.press('Enter');
    assert.deepEqual(await ticks(), ['-900', '-4080'], 'moved outward, down to the pool’s step');
    assert.deepEqual(await away(), ['9.4% above today', '50% above today']);
    assert.equal(await step.locator('p[data-range-position="below"]').innerText(), 'No fees until the price rises into this range.');
    await step.getByRole('radio', { name: 'Closer' }).click();
    assert.equal(await step.locator('p[data-range-position]').count(), 0);

    // Five minutes on the page: the price is stale, which is said in its data only (QA round 2 sweep: no title about its
    // age), and nothing is read by itself. The next change to the range reads it again, once; the price is fresh after
    // that, so the changes after it read nothing.
    const priceReads = () => read.requests.filter(r => r.path === '/api/read/v1/pools' && JSON.parse(r.body).maxPools === 1 && JSON.parse(r.body).poolIds?.length === 1).length;
    const before = priceReads();
    await jump(s.page, '05:01');
    await s.page.waitForFunction(() => document.querySelector('li[data-step="range"] [data-picker="range"]')?.getAttribute('data-price-state') === 'stale');
    assert.equal(await step.locator('[data-pool-price-text]').getAttribute('title'), null);
    assert.equal(priceReads(), before, 'nothing is read by itself');
    await step.getByRole('radio', { name: 'Wider' }).click();
    assert.deepEqual(await ticks(), ['6960', '-6960'], 'the width is drawn at once');
    await s.page.waitForFunction(() => document.querySelector('li[data-step="range"] [data-picker="range"]')?.getAttribute('data-price-read') === 'ok');
    assert.equal(priceReads(), before + 1, 'read again, once');
    assert.equal(await step.getAttribute('data-price-state'), 'usable');
    await step.getByRole('radio', { name: 'Closer' }).click();
    await step.getByRole('radio', { name: 'Custom' }).click();
    await s.page.waitForTimeout(500);
    assert.equal(priceReads(), before + 1, 'a fresh price is not read again');
    assert.deepEqual(await ticks(), ['3600', '-4080']);
  } finally { await s.close(); }
});

// Added 2026-09-24 (owner): New position's preview is the card of the position being made, and it shows at every width
// (under the steps below 1024). It is aria-hidden (the steps say everything it shows) and draws the Journey's own
// state, so pointing at a pool row asks nothing of the network. Its head folds away over the pool it showed rather than
// vanishing (the card must not jump), and stilled, its picture is the whole composition, fee pips included. Step 1
// offers Continue only once a token is chosen, and its arrival is stilled under reduced motion too.
test('New position’s preview shows under the steps on a phone, aria-hidden, rests complete under reduced motion, previews a pointed pool with no read and folds it away; Continue arrives with the token', async () => {
  const read = createReadStub();
  const s = await scenario({ routes: [(request, url) => read.handle(request, url)] });
  await s.context.route(ARTWORK, route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  try {
    await s.page.setViewportSize({ width: 390, height: 844 });
    await s.page.emulateMedia({ reducedMotion: 'reduce' });
    await s.page.goto(`${s.origin}/#/new`);
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    const aside = s.page.locator('aside.dm-flow-preview');
    await aside.waitFor();
    assert.equal(await aside.getAttribute('aria-hidden'), 'true');
    assert.equal(await aside.getAttribute('data-preview'), 'empty');
    // Changed on purpose 2026-10-30 (QA round 2, CI): both boxes in one read. Step 1's suggested pools (N19) can arrive
    // between two separate reads and grow the steps above the preview, which then moves down with them.
    const { card, box } = await s.page.evaluate(() => {
      const rect = (selector) => { const b = document.querySelector(selector).getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height }; };
      return { card: rect('.dm-flow-card'), box: rect('aside.dm-flow-preview') };
    });
    assert.ok(box.width > 300 && box.height > 200, `the preview is shown on a phone (${box.width} x ${box.height})`);
    assert.ok(box.y >= card.y + card.height, 'under the steps');
    assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth), 390, 'nothing overflows the phone');
    // Stilled, the picture rests complete: the four fee pips its legend names show, and nothing in it runs.
    const pips = await aside.locator('.dm-flow-pv-art .pip').evaluateAll(nodes => nodes.map(node => [getComputedStyle(node).animationName, Number(getComputedStyle(node).opacity)]));
    assert.equal(pips.length, 4);
    for (const [name, opacity] of pips) assert.ok(name === 'none' && opacity >= 0.5, `a resting pip shows (${name}, ${opacity})`);
    assert.deepEqual(await aside.locator('.dm-flow-pv-legend li').allInnerTexts(), ['In range', 'Out of range', 'Price range', 'Fees earned']);
    assert.equal(await s.page.locator('[data-journey-footer] button').count(), 0, 'no buttons before a token is chosen');

    await s.page.getByRole('combobox', { name: 'Search a token' }).fill(FIXTURE_TOKEN);
    await s.page.locator(`[data-token-option="${FIXTURE_TOKEN}"]`).click();
    const next = footerButton(s.page, 'Continue');
    await next.waitFor();
    assert.equal(await s.page.locator('[data-journey-footer] button').count(), 1, 'Continue alone: step 1 has nowhere to go back to');
    assert.ok(parseFloat(await next.evaluate(node => getComputedStyle(node).animationDuration)) < 0.001, 'its arrival is stilled');

    // With motion, on a wide screen: pointing at a row opens the head, and leaving it folds the head away over its pool.
    await s.page.emulateMedia({ reducedMotion: 'no-preference' });
    await s.page.setViewportSize({ width: 1320, height: 1000 });
    const row = s.page.locator('[data-pool-option]').first();
    await row.waitFor({ timeout: 30_000 });
    await s.page.waitForTimeout(300);
    const asked = [];
    const ask = request => { if (/\/api\/|rpc\.mainnet/.test(request.url())) asked.push(request.url()); };
    s.page.on('request', ask);
    await row.hover();
    await aside.locator('.dm-flow-pv-fold[data-open] .dm-flow-pv-pair').waitFor();
    assert.equal(await aside.getAttribute('data-preview'), 'pointed');
    // Changed on purpose 2026-10-30 (QA round 2, Q24): named as its price is written, as Markets and the pool page name it.
    assert.equal(await aside.locator('.dm-flow-pv-pair').innerText(), 'TOKEN / ETH');
    await s.page.waitForFunction(() => document.querySelector('.dm-flow-pv-fold').getBoundingClientRect().height > 40);
    // Read in the same task as the commit that closes the fold (a MutationObserver's microtask), before any frame. The
    // observer is in place before the pointer moves.
    await aside.evaluate(node => {
      const fold = node.querySelector('.dm-flow-pv-fold');
      window.__folding = new Promise(done => {
        const observer = new MutationObserver(() => {
          if (fold.hasAttribute('data-open')) return;
          observer.disconnect();
          done({ heads: fold.querySelectorAll('.dm-flow-pv-pool').length, height: fold.getBoundingClientRect().height });
        });
        observer.observe(fold, { attributes: true, attributeFilter: ['data-open'] });
        setTimeout(() => { observer.disconnect(); done({ heads: -1, height: -1 }); }, 10_000);
      });
    });
    await s.page.mouse.move(2, 2);
    const closing = await s.page.evaluate(() => window.__folding);
    assert.equal(closing.heads, 1, 'the head is still drawn as the fold starts to close');
    assert.ok(closing.height > 40, `the fold closes from its open height, it does not snap shut (${closing.height})`);
    await aside.locator('.dm-flow-pv-pool').waitFor({ state: 'detached' });
    assert.equal(await aside.getAttribute('data-preview'), 'empty');
    s.page.off('request', ask);
    assert.deepEqual(asked, [], 'the preview reads nothing of its own');
  } finally { await s.close(); }
});

// Added 2026-09-24 (owner): the pools listed at step 1 are the most liquid ones, sorted by TVL, each with its TVL,
// 24h volume and APR. The provider's token-pairs list (the same GET the token artwork makes) only names which pool ids
// the read service verifies; what each row shows is the read service's own reply, and its order is that reply's TVL.
test('New position names the provider’s most liquid pools in its one pools read, and lists the usable ones by TVL, each with TVL, 24h volume and APR', async () => {
  const HOOKS = `0x${'ab'.repeat(20)}`;
  const ZERO = `0x${'0'.repeat(40)}`;
  const [X, Y, Z] = ['a', 'b', 'c'].map(digit => `0x${digit.repeat(64)}`);
  const v4 = (pairAddress, usd) => ({ chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress, baseToken: { address: FIXTURE_TOKEN }, quoteToken: { address: ZERO }, liquidity: { usd } });
  // Three v4 pools for the token, and a pair from another exchange with more liquidity than all of them.
  const pairs = [v4(Y, 200), { ...v4(`0x${'d'.repeat(40)}`, 1e9), labels: ['v3'] }, v4(X, 300), v4(Z, 100)];
  const mixed = (route) => {
    if (route !== 'pools') return undefined;
    const base = readGateway('pools.success'), [pool] = base.pools;
    const metrics = (usd, volume) => ({ ...pool.providerMetrics, reportedLiquidityUsd: usd, volume24hUsd: volume });
    return JSON.stringify({ ...base, pools: [
      { ...pool, poolId: X, poolKey: { ...pool.poolKey, hooks: HOOKS }, integrationClass: 'requires_separate_adapter', providerMetrics: metrics('9000000.00', '1.00'), requestedById: true },
      { ...pool, poolId: Y, providerMetrics: metrics('50.00', '1234.56'), requestedById: true },
      { ...pool, poolId: Z, providerMetrics: metrics('900.00', '100.00'), requestedById: true },
    ] });
  };
  const read = createReadStub({ answer: mixed });
  const s = await scenario({ routes: [(request, url) => read.handle(request, url)] });
  const listed = [];
  await s.context.route(ARTWORK, route => {
    const url = new URL(route.request().url());
    if (url.host === 'api.dexscreener.com') listed.push(url.pathname);
    const body = url.pathname === `/token-pairs/v1/robinhood/${FIXTURE_TOKEN}` ? JSON.stringify(pairs) : '[]';
    return route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  try {
    await s.page.goto(`${s.origin}/#/new`);
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await s.page.getByRole('combobox', { name: 'Search a token' }).fill(FIXTURE_TOKEN);
    await s.page.locator(`[data-token-option="${FIXTURE_TOKEN}"]`).click();
    const picker = s.page.locator('[data-picker="pool"][data-pools-state="ok"]');
    await picker.waitFor({ timeout: 30_000 });
    assert.deepEqual(read.requests.filter(r => r.path === '/api/read/v1/pools').map(r => JSON.parse(r.body)), [{ token: FIXTURE_TOKEN, maxPools: 3, poolIds: [X, Y, Z] }], 'the three v4 pools, most liquid first, and nothing else');
    assert.equal(listed.filter(path => path === `/token-pairs/v1/robinhood/${FIXTURE_TOKEN}`).length, 1, 'the artwork and the hints shared one GET');
    const rows = picker.locator('[data-pool-option]');
    assert.equal(await rows.count(), 2, 'the hooked pool is not a row, however liquid');
    assert.equal(await picker.getAttribute('data-pools-hidden'), '1');
    // Changed on purpose (round 6, 2026-09-27): New position's rows no longer print their pool id; it is data-pool-key.
    assert.deepEqual(await rows.evaluateAll(els => els.map(el => el.getAttribute('data-pool-key'))), [Z, Y], 'the read service’s TVL decides the order: $900 before $50');
    const figures = await rows.evaluateAll(els => els.map(el => [...el.querySelectorAll('[data-provider-figure], [data-row-apr]')].map(cell => cell.innerText.replace(/\s+/g, ' ').trim())));
    // Changed on purpose 2026-10-01 (audit E21): the one APR rule of every screen (lib/format/apr.ts).
    assert.deepEqual(figures, [
      ['TVL $900.00', '24h volume $100.00', 'APR 12.2% est.'],
      ['TVL $50.00', '24h volume $1.2K', 'APR 2,704% est.'],
    ]);
    const stage = await s.page.locator('[data-stage="token"]').innerText();
    assert.doesNotMatch(stage, /verified at block|No market figures|Pool details|hooks|adapter|coverage|catalogue|Rejected/i, 'no disclosure, no footnote, no panel');
    assert.doesNotMatch(stage, FORBIDDEN);
    assert.equal(await s.page.locator('[data-stage="token"] details').count(), 0);
    await s.page.locator('[data-stage="token"]').screenshot({ path: join(shots(), 'create-pool-step.png') });
    // On a phone the three figures stack under the pair, and nothing scrolls sideways.
    await s.page.setViewportSize({ width: 390, height: 900 });
    assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true, 'no sideways scroll at phone width');
    await s.page.locator('[data-stage="token"]').screenshot({ path: join(shots(), 'create-pool-step-phone.png') });
    await s.page.setViewportSize({ width: 1320, height: 1000 });
    // The first row is the most liquid usable pool, and it continues.
    await picker.locator('input[name="pool-option"]').first().click();
    assert.equal(await s.page.locator('[data-chosen-pool]').getAttribute('data-chosen-pool'), Z);
    assert.equal(await footerButton(s.page, 'Continue').isDisabled(), false);
  } finally { await s.close(); }
});

// Review 2026-09-23: the provider's token-pairs list is a 30-pair sample. For USDG it named none of the site's
// featured pools (U/USDG, cbBTC/USDG, ETH/USDG, WETH/USDG), so step 1 never listed the largest usable USDG pools.
// The featured pools that hold the token are named first, then the provider's, each once.
// Changed on purpose 2026-10-04 (the owner's new embedded list): the six featured pools are ETH/USDG, PONS/USDG,
// USDG/ORBIO, CASHCAT/USDG, USDG/UBIK and USDG/VIRTUAL, in that order; ETH/USDG and PONS/USDG are now first and second.
// Changed on purpose 2026-11-02 (the owner's new embedded list): ETH/USDG 0.05%, PONS/USDG, ETH/TORCH, CASHCAT/USDG,
// USDG/PRIORS and USDG/VIRTUAL. ETH/TORCH holds no USDG, so the five others are the featured pools named for USDG.
test('for USDG the pools read names the featured pools first, then the provider’s, each once', async () => {
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const ZERO = `0x${'0'.repeat(40)}`;
  // Changed on purpose 2026-10-04 (the owner: the embedded list approved on 4 Oct, PR #322): the new six, in their order.
  // Changed on purpose 2026-11-02 (the owner: the embedded list approved on 2 Nov): that day's six, in their order.
  const FEATURED = [
    '0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982',
    '0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a',
    '0x1649550af1e3363b4c25236434530af7e6886b183e1f574a98fdd1d04d287a2d',
    '0xa92a3df27a00a276183ff7265fd8affa11df1fe8bb23ddfaf13f6c879a3f818b',
    '0x9be7ab27227e115085b0949a819a73f6963ddc6da0c6204d37757c24297706e8',
    '0xa95732060867f07aa9b8ae9a4b7b8d737bc3374f1dfbb952759c5ed676e8737c',
  ];
  const [ETH_USDG, PONS_USDG, ETH_TORCH] = FEATURED;
  const X = `0x${'a'.repeat(64)}`;
  // The provider's list: one pool of its own, and one featured pool it happens to hold.
  const v4 = (pairAddress, usd) => ({ chainId: 'robinhood', dexId: 'uniswap', labels: ['v4'], pairAddress, baseToken: { address: `0x${'3'.repeat(40)}` }, quoteToken: { address: USDG }, liquidity: { usd } });
  const pairs = [v4(X, 9e6), v4(PONS_USDG, 3e6)];
  const usdg = (route, body) => {
    if (route === 'token' && body.token === USDG) {
      const base = readGateway('token.success');
      return JSON.stringify({ ...base, asset: { ...base.asset, address: USDG, symbol: 'USDG' } });
    }
    if (route !== 'pools') return undefined;
    const base = readGateway('pools.success'), [pool] = base.pools;
    const holding = (poolId) => ({ ...pool, poolId, currencies: [ZERO, USDG], poolKey: { ...pool.poolKey, currency0: ZERO, currency1: USDG }, requestedById: true });
    return JSON.stringify({
      ...base,
      selectedToken: USDG,
      tokens: base.tokens.map(token => (token.address === FIXTURE_TOKEN ? { ...token, address: USDG, symbol: 'USDG' } : token)),
      pools: [holding(ETH_USDG)],
    });
  };
  const read = createReadStub({ answer: usdg });
  const s = await scenario({ routes: [(request, url) => read.handle(request, url)] });
  await s.context.route(ARTWORK, route => {
    const url = new URL(route.request().url());
    const body = url.pathname === `/token-pairs/v1/robinhood/${USDG}` ? JSON.stringify(pairs) : '[]';
    return route.fulfill({ status: 200, contentType: 'application/json', body });
  });
  try {
    await s.page.goto(`${s.origin}/#/new`);
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await s.page.getByRole('combobox', { name: 'Search a token' }).fill(USDG);
    await s.page.locator(`[data-token-option="${USDG}"]`).click();
    const picker = s.page.locator('[data-picker="pool"][data-pools-state="ok"]');
    await picker.waitFor({ timeout: 30_000 });
    assert.deepEqual(
      read.requests.filter(r => r.path === '/api/read/v1/pools').map(r => JSON.parse(r.body)),
      [{ token: USDG, maxPools: 6, poolIds: [...FEATURED.filter((poolId) => poolId !== ETH_TORCH), X] }],
      'the five featured pools that hold USDG, in catalogue order, then the provider’s own, PONS/USDG not twice',
    );
    assert.equal(await picker.locator('[data-pool-option]').count(), 1);
    // Changed on purpose (round 6, 2026-09-27): New position's rows no longer print their pool id; it is data-pool-key.
    assert.equal(await picker.locator('[data-pool-option]').first().getAttribute('data-pool-key'), ETH_USDG.toLowerCase(), 'the row is the read service’s own');
  } finally { await s.close(); }
});

// Added 2026-10-31 (QA round 2 follow-ups, R20, R18 and N57): step 1 by keyboard and pointer. A token read is heard by its
// name, never by a block number; an arrow in the pools moves without choosing (it chose at once, and the focus fell to the
// page's start), Enter chooses, and the focus lands on the chosen pool's Change pool; Change pool by a click leaves the
// focus on Keep this pool, and from the keyboard on the search.
test('New position’s step 1 by keyboard and pointer: the token heard by its name, arrows that choose nothing, and the focus kept through Change pool', async () => {
  const read = createReadStub();
  const s = await scenario({ routes: [(request, url) => read.handle(request, url)] });
  await s.context.route(ARTWORK, route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  const focusedOn = (selector) => s.page.waitForFunction((css) => document.activeElement?.matches(css) ?? false, selector, { timeout: 10_000 });
  try {
    await s.page.goto(`${s.origin}/#/new`);
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await s.page.getByRole('combobox', { name: 'Search a token' }).fill(FIXTURE_TOKEN);
    await s.page.locator(`[data-token-option="${FIXTURE_TOKEN}"]`).click();
    const said = s.page.locator('[data-token-search-status="ok"]');
    await said.waitFor({ state: 'attached', timeout: 30_000 });
    assert.equal(await said.textContent(), 'TOKEN selected.');
    const radio = s.page.locator('[data-picker="pool"] input[name="pool-option"]').first();
    await radio.waitFor({ timeout: 30_000 });
    await radio.focus();
    await s.page.keyboard.press('ArrowDown');
    await s.page.keyboard.press('ArrowUp');
    assert.equal(await s.page.locator('[data-chosen-pool]').count(), 0, 'an arrow chooses nothing');
    assert.equal(await radio.evaluate(node => document.activeElement === node && !node.checked), true, 'the focus stays on the row, unchosen');
    await s.page.keyboard.press('Enter');
    await s.page.locator('[data-chosen-pool]').waitFor();
    await focusedOn('[data-chosen-pool] button');
    await s.page.locator('[data-chosen-pool] button').click();
    await focusedOn('[data-keep-pool]');
    await s.page.locator('[data-keep-pool]').click();
    await focusedOn('[data-chosen-pool] button');
    await s.page.keyboard.press('Enter');
    await focusedOn('#create-token-search');
  } finally { await s.close(); }
});

// Added 2026-09-28 (speed wave, study items 27, 30 and 33): the chosen token's pools are asked beside its token read
// (lib/create/poolsAhead.ts), Change pool shows the list the flow read, with no second read, and Create position's code
// is asked once a pool is chosen, before Review. Only when things are asked changed: every screen is the same.
test('New position reads the chosen token’s pools once, Change pool shows that list again with no read, and Create position’s code is loaded before Review', async () => {
  const read = createReadStub();
  const s = await scenario({ routes: [(request, url) => read.handle(request, url)] });
  await s.context.route(ARTWORK, route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  const chunks = [];
  s.page.on('request', (request) => { if (/\/assets\/DepositAmounts-[\w-]+\.js$/.test(request.url())) chunks.push(request.url()); });
  const reads = (route) => read.requests.filter(r => r.path === `/api/read/v1/${route}`);
  try {
    await s.page.goto(`${s.origin}/#/new`);
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await choosePool(s.page);
    assert.deepEqual(reads('pools').map(r => JSON.parse(r.body)), [{ token: FIXTURE_TOKEN }], 'one pools read for the chosen token');
    assert.equal(reads('token').length, 1, 'one token read');
    // Create position's chunk is asked once the pool is chosen, not when Review opens.
    await s.page.waitForFunction(() => performance.getEntriesByType('resource').some((entry) => /\/assets\/DepositAmounts-/.test(entry.name)), undefined, { timeout: 10_000 });
    assert.equal(chunks.length, 1, 'the chunk is asked once');
    assert.equal(await s.page.locator('[data-stage-card="review"]').count(), 0, 'before Review');
    // Change pool: the list the flow read, at once, the chosen pool still checked, and nothing read again.
    await s.page.locator('[data-chosen-pool] button').click();
    const picker = s.page.locator('[data-picker="pool"]');
    await picker.waitFor();
    assert.equal(await picker.getAttribute('data-pools-state'), 'ok', 'the kept list, never a loading one');
    assert.equal(await picker.locator('input[name="pool-option"]:checked').count(), 1, 'the chosen pool is still the checked row');
    await s.page.waitForTimeout(1500);
    assert.equal(reads('pools').length, 1, 'Change pool read nothing');
    // The chosen pool's radio is already checked: keeping it is the step's own button.
    await s.page.getByRole('button', { name: 'Keep this pool', exact: true }).click();
    await s.page.locator('[data-chosen-pool]').waitFor();
    await pressContinue(s.page);
    await s.page.locator('[data-stage="range"]').waitFor();
    await pressContinue(s.page);
    await s.page.locator('[data-pair-side="1"] input[inputmode="decimal"]').fill('1');
    // Changed on purpose 2026-09-28 (speed wave, after review): Review draws the loaded Create position in the frame it
    // opens, never the disabled stand-in React holds 300 ms for a lazy control. Every change to the page is watched from
    // here: the footer's first Review frame names the control it drew, and the stand-in's line must never appear.
    await s.page.evaluate((loading) => {
      const seen = (window.__reviewDrawn = { first: null, standIn: false });
      const look = () => {
        const footer = document.querySelector('[data-journey-footer][data-final]');
        if (!footer) return;
        if (seen.first === null) seen.first = footer.querySelector('[data-create-position]')?.getAttribute('data-create-position') ?? 'nothing';
        if (document.querySelector('#create-reason')?.textContent === loading) seen.standIn = true;
      };
      new MutationObserver(look).observe(document.body, { childList: true, subtree: true, characterData: true });
    }, 'Loading the wallet steps…');
    await pressContinue(s.page);
    await s.page.locator('[data-stage-card="review"]').waitFor();
    await s.page.locator('[data-create-position="connect"]').waitFor();
    assert.equal(chunks.length, 1, 'Review found the chunk loaded');
    assert.deepEqual(await s.page.evaluate(() => window.__reviewDrawn), { first: 'connect', standIn: false }, 'Create position (Connect wallet, with no wallet) in Review’s first frame, and never the stand-in');
  } finally { await s.close(); }
});

// Added 2026-09-28 (speed wave, after review; study item 27): the pools read starts at the choice, not once the token
// read has answered. The provider lane carries one read at a time (scheduler.ts), so a pools read cannot leave while
// the token read is still on the wire, whenever it was asked; what shows when it was asked is a token read that failed
// for the moment. The choice then has no token, and the field waits 3 to 5 s to ask again, quietly. Only a pools read
// asked at the choice leaves in that gap; a list mounted for the token asks nothing before the token read answers. The
// token-pairs list the pools read's hints come from is asked earlier still, once the row is pointed at.
// 2026-09-28, speed/wave-a-release (speed/reads merged with speed/newpos): the provider lane now carries two reads at
// once, 0 ms apart (scheduler.ts width, minIntervalMs), so the pools read no longer needs the token read's failure to
// leave; the order this test pins holds all the same.
test('New position asks the chosen token’s pools at the choice: they are read while its token read, failed for the moment, waits to be asked again', async () => {
  let tokenReads = 0;
  const read = createReadStub({ answer: (route) => (route === 'token' && tokenReads++ === 0 ? gatewayError('upstream_unavailable', 503) : undefined) });
  const s = await scenario({ routes: [(request, url) => read.handle(request, url)] });
  const pairs = [];
  await s.context.route(ARTWORK, (route) => {
    if (/\/token-pairs\//.test(route.request().url())) pairs.push(route.request().url().toLowerCase());
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  const provider = () => read.requests.filter(r => r.path.startsWith('/api/read/v1/') && r.method === 'POST').map(r => r.path.replace('/api/read/v1/', ''));
  try {
    await s.page.goto(`${s.origin}/#/new`);
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await s.page.getByRole('combobox', { name: 'Search a token' }).fill(FIXTURE_TOKEN);
    // The row offered for the pasted address is pointed at: the token-pairs list its hints come from is asked now,
    // before the choice (warmPoolHints), so the pools read does not wait for it.
    for (let waited = 0; !pairs.some(url => url.endsWith(FIXTURE_TOKEN)) && waited < 5000; waited += 50) await s.page.waitForTimeout(50);
    assert.ok(pairs.some(url => url.endsWith(FIXTURE_TOKEN)), 'the pointed token’s pairs were asked before it was chosen');
    await s.page.locator(`[data-token-option="${FIXTURE_TOKEN}"]`).click();
    const picker = s.page.locator('[data-picker="pool"][data-pools-state="ok"]');
    await picker.waitFor({ timeout: 30_000 });
    assert.deepEqual(provider(), ['token', 'pools', 'token'], 'the pools read left between the failed token read and its quiet re-ask');
    assert.deepEqual(read.requests.filter(r => r.path === '/api/read/v1/pools').map(r => JSON.parse(r.body)), [{ token: FIXTURE_TOKEN }]);
    assert.ok(await picker.locator('input[name="pool-option"]').count() > 0, 'the list shows the rows that read brought');
    await s.page.waitForTimeout(1500);
    assert.deepEqual(provider(), ['token', 'pools', 'token'], 'the list took that read: nothing read again');
  } finally { await s.close(); }
});

// Added 2026-09-28 (speed wave, after review; study item 27): a choice whose token read fails for good has no list to
// take its pools read, so that read is cancelled before it leaves (TokenSearch's onChoose(null)); before item 27 it was
// never asked at all. Changed on purpose 2026-09-28, speed/wave-a-release (speed/reads merged with speed/newpos): the
// provider lane no longer holds the pools read 1.1 s (two reads at once, 0 ms apart: scheduler.ts width, minIntervalMs),
// so what holds it here is its hints (poolHints.ts hintsWithin, up to HINT_WAIT_MS): the token-pairs list answers 2 s
// late, the token read fails for good long before, and the read is cancelled while it waits for them.
test('New position cancels the chosen token’s pools read when the token read fails for good: nothing more is read for that choice', async () => {
  const read = createReadStub({ answer: (route) => (route === 'token' ? gatewayError('invalid_request', 422) : undefined) });
  const s = await scenario({ routes: [(request, url) => read.handle(request, url)] });
  await s.context.route(ARTWORK, async (route) => {
    if (/\/token-pairs\//.test(route.request().url())) await new Promise((wake) => setTimeout(wake, 2000));
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }).catch(() => undefined);
  });
  const reads = (route) => read.requests.filter(r => r.path === `/api/read/v1/${route}`);
  try {
    await s.page.goto(`${s.origin}/#/new`);
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await s.page.getByRole('combobox', { name: 'Search a token' }).fill(FIXTURE_TOKEN);
    await s.page.locator(`[data-token-option="${FIXTURE_TOKEN}"]`).click();
    await s.page.locator('[data-token-search-failed]').waitFor({ timeout: 30_000 });
    // Past the hints' late answer and their 2.5 s cap, when a pools read still asked would have left.
    await s.page.waitForTimeout(3000);
    assert.equal(reads('token').length, 1, 'the token read, final at once');
    assert.equal(reads('pools').length, 0, 'the choice’s pools read was cancelled before it left');
    assert.equal(await s.page.locator('[data-picker="pool"]').count(), 0, 'no list, as before');
  } finally { await s.close(); }
});

// Added 2026-09-28, speed/wave-a-release (speed/reads merged with speed/newpos): with its hints at hand, the pools read
// leaves beside the token read (two reads at once), and a token read that then fails for good finds it on the wire. It
// is dropped all the same (dropCreatePools cancels it and keeps no answer): no list, and nothing more is read for that
// choice.
test('New position drops a pools read already out when the token read fails for good: no list, nothing read again', async () => {
  const read = createReadStub({ answer: (route) => (route === 'token' ? gatewayError('invalid_request', 422) : undefined) });
  const s = await scenario({ routes: [(request, url) => read.handle(request, url)] });
  await s.context.route(ARTWORK, route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  const reads = (route) => read.requests.filter(r => r.path === `/api/read/v1/${route}`);
  try {
    await s.page.goto(`${s.origin}/#/new`);
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await s.page.getByRole('combobox', { name: 'Search a token' }).fill(FIXTURE_TOKEN);
    await s.page.locator(`[data-token-option="${FIXTURE_TOKEN}"]`).click();
    await s.page.locator('[data-token-search-failed]').waitFor({ timeout: 30_000 });
    const pools = reads('pools').length;
    assert.ok(pools <= 1, 'at most the one pools read that left beside the token read');
    await s.page.waitForTimeout(3000);
    assert.equal(reads('token').length, 1, 'the token read, final at once');
    assert.equal(reads('pools').length, pools, 'nothing more is read for that choice');
    assert.equal(await s.page.locator('[data-picker="pool"]').count(), 0, 'no list, as before');
  } finally { await s.close(); }
});

// Added 2026-09-28 (speed wave, after review; study item 30): a pools answer is kept for one New position flow only.
// Leaving the flow forgets it (Journey's unmount, forgetCreatePools), so a new flow reads the pools afresh, as before.
test('New position forgets the pools it read once the flow is left: the same token in a new flow is read again', async () => {
  const read = createReadStub();
  const s = await scenario({ routes: [(request, url) => read.handle(request, url)] });
  await s.context.route(ARTWORK, route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  const reads = (route) => read.requests.filter(r => r.path === `/api/read/v1/${route}`);
  try {
    await s.page.goto(`${s.origin}/#/new`);
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await choosePool(s.page);
    assert.equal(reads('pools').length, 1);
    await s.page.evaluate(() => { window.location.hash = '#/app'; });
    await s.page.waitForFunction(() => document.querySelector('[data-journey-footer]') === null);
    await s.page.evaluate(() => { window.location.hash = '#/new'; });
    await s.page.getByRole('combobox', { name: 'Search a token' }).fill(FIXTURE_TOKEN);
    await s.page.locator(`[data-token-option="${FIXTURE_TOKEN}"]`).click();
    await s.page.locator('[data-picker="pool"][data-pools-state="ok"]').waitFor({ timeout: 30_000 });
    assert.deepEqual(reads('pools').map(r => JSON.parse(r.body)), [{ token: FIXTURE_TOKEN }, { token: FIXTURE_TOKEN }], 'the new flow read the pools again');
  } finally { await s.close(); }
});

// Added 2026-09-28 (speed wave, study items 28 and 29): the stored search answers a longer query from a complete answer
// to a shorter one, with no read (searchAnswers.ts), and a catalogue token the search verified is handed over as it
// answered, with no token read. The tokens listed are the service's own answer to each query: here, the symbols that
// begin with it, as backend/public_observations.py searches.
test('typing a name slowly asks the stored search once, and a catalogue token it verified is chosen with no token read', async () => {
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const ZERO = `0x${'0'.repeat(40)}`;
  const v3 = (name) => JSON.parse(readFileSync(new URL(`../../api-contracts/read-v3/fixtures/${name}.json`, import.meta.url), 'utf8'));
  const searches = [];
  let answerUs;
  const heldUs = new Promise((done) => { answerUs = done; });
  const stored = async (route, body) => {
    if (route !== 'search') {
      const base = v3(route);
      if (route === 'overview') Object.assign(base, { selectedToken: body.token ?? null, requestedPoolIds: body.poolIds ?? [] });
      return JSON.stringify(base);
    }
    searches.push(body.query);
    // The service answers "us" only once the test says so, after "d" and "g" are typed (below).
    if (body.query === 'us') await heldUs;
    const base = v3('search'), [token] = base.tokens;
    const usdg = JSON.parse(JSON.stringify(token).split(FIXTURE_TOKEN).join(USDG).split('"TOKEN"').join('"USDG"'));
    const q = body.query.trim().toLowerCase();
    return JSON.stringify({ ...base, query: body.query, tokens: [token, usdg].filter(entry => entry.value.asset.symbol.toLowerCase().startsWith(q)).sort((a, b) => (a.address < b.address ? -1 : 1)) });
  };
  const usdg = (route) => {
    if (route !== 'pools') return undefined;
    const base = readGateway('pools.success'), [pool] = base.pools;
    return JSON.stringify({
      ...base,
      selectedToken: USDG,
      tokens: base.tokens.map(token => (token.address === FIXTURE_TOKEN ? { ...token, address: USDG, symbol: 'USDG' } : token)),
      // ETH/USDG, one of the featured pools the read names for USDG. Changed on purpose 2026-11-02 (the owner's new
      // embedded list): the 0.05% pool, which replaced the 0.01% one in the list.
      pools: [{ ...pool, poolId: '0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982', currencies: [ZERO, USDG], poolKey: { ...pool.poolKey, currency0: ZERO, currency1: USDG }, requestedById: true }],
    });
  };
  const read = createReadStub({ answer: usdg, stored });
  const s = await scenario({ routes: [(request, url) => read.handle(request, url)] });
  await s.context.route(ARTWORK, route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  const reads = (route) => read.requests.filter(r => r.path === `/api/read/v1/${route}`);
  try {
    await s.page.goto(`${s.origin}/#/new`);
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    const field = s.page.getByRole('combobox', { name: 'Search a token' });
    await field.click();
    // A pause after each key, longer than the search's 350 ms: before, each one was a read of its own.
    for (const key of ['u', 's']) { await field.press(key); await s.page.waitForTimeout(500); }
    // Changed on purpose 2026-09-28 (speed wave, after review): "d" and "g" are typed while the read for "us" is still
    // out, as a slow service leaves it. Before, the next key threw that read away, its read already spent, and asked
    // "usd"; now it is let finish, and its complete answer answers "usd" and "usdg".
    for (let waited = 0; searches.length === 0 && waited < 10_000; waited += 50) await s.page.waitForTimeout(50);
    assert.deepEqual(searches, ['us'], 'the read for "us" is out');
    const answered = s.page.waitForResponse(response => response.url().endsWith('/api/read/v3/search'));
    for (const key of ['d', 'g']) { await field.press(key); await s.page.waitForTimeout(500); }
    answerUs();
    await answered;
    // The answer is kept a moment after it arrives (TokenSearch's read settles, then keeps it).
    await s.page.waitForTimeout(300);
    assert.deepEqual(searches, ['us'], '"usd" and "usdg" were answered from the complete answer to "us"');
    const options = await s.page.locator('[data-token-option]').evaluateAll(els => els.map(el => el.getAttribute('data-token-option')));
    assert.deepEqual(options, [USDG], 'the one token whose symbol begins with "usdg"');
    await s.page.locator(`[data-token-option="${USDG}"]`).click();
    await s.page.locator('[data-picker="pool"][data-pools-state="ok"]').waitFor({ timeout: 30_000 });
    assert.equal(reads('token').length, 0, 'USDG came as the search verified it: no token read');
    assert.deepEqual(reads('pools').map(r => JSON.parse(r.body).token), [USDG], 'one pools read, for USDG');
  } finally { answerUs(); await s.close(); }
});

test('with no wallet connected Review’s last control is Connect wallet, says why, and opens the header’s wallet dialog', async () => {
  const read = createReadStub();
  const s = await scenario({ routes: [(request, url) => read.handle(request, url)] });
  await s.context.route(ARTWORK, route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  try {
    await s.page.goto(`${s.origin}/#/new`);
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await walkToReview(s.page);
    const connect = s.page.locator('[data-create-position="connect"]');
    await connect.waitFor({ timeout: 30_000 });
    assert.equal(await connect.innerText(), 'Connect wallet');
    // Changed on purpose (round 6, 2026-09-27, the owner: New position for people who know nothing about pools): one short sentence.
    assert.equal(await s.page.locator('#create-reason').innerText(), 'Connect a wallet to create this position.');
    assert.equal(await s.page.getByRole('button', { name: 'Create position', exact: true }).count(), 0);
    assert.equal(await s.page.getByRole('link', { name: 'Continue in Setup' }).count(), 0, 'no hand-off to Setup');
    await connect.click();
    const dialog = s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
    await dialog.waitFor();
    await dialog.getByRole('button', { name: 'Connect Test Wallet A', exact: true }).waitFor();
    assert.deepEqual(s.releases, [], 'nothing about a deployment is read before a wallet is there');
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

// ---- G13 receipt identity and status refresh; G16 Start tracking from owned sequences ---------------------------
part('automation');

import { decodeFunctionData, encodeFunctionResult, numberToHex, parseAbi, parseAbiParameters, parseUnits, stringToHex, zeroAddress } from 'viem';

const readGateway = name => JSON.parse(readFileSync(new URL(`../../api-contracts/read-v1/fixtures/gateway/${name}.json`, import.meta.url)));
const shots = () => { const dir = resolve(import.meta.dirname, '../.test-artifacts'); mkdirSync(dir, { recursive: true }); return dir; };

/** read-v1 answered inside the browser context: the capabilities, then token details, with decimals for `known` and without for any other address. */
async function answerTokenReads(context, known) {
  const asked = [], capabilities = readGateway('capabilities.live_read_only'), headers = { 'X-Domino-Read-Contract': capabilities.contractVersion };
  await context.route(/\/api\/read\/v1\/(capabilities|token)$/, async route => {
    const request = route.request();
    if (request.url().endsWith('/capabilities')) return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify(capabilities) });
    const token = request.postDataJSON().token.toLowerCase(), base = readGateway(known[token] ? 'token.success' : 'token.missing-decimals');
    asked.push(token);
    return route.fulfill({ status: 200, contentType: 'application/json', headers, body: JSON.stringify({ ...base, asset: { ...base.asset, address: token, ...known[token] } }) });
  });
  return asked;
}

// Changed on purpose (owner, 2026-09-27, round 5: "Receipts" ran down the page forever, a tall card per receipt with its raw
// hashes): one short row per receipt, a plain chip (Done, In progress, Cancelled...), what it re-added, and the detail one
// click away. The hashes are short there, each whole in its title and its copy; the amounts are in token units, summed
// per token. The receipt still names no link out of the app: its one link is how to pause.
test('a finalized receipt is one short row: Done, what it added back, and its detail one click away with amounts per token and copyable ids; a stoppable intent links to how to pause, and an open one refreshes in place', async () => {
  const s = await scenario({ clock: true });
  const TOKEN = '0x' + '11'.repeat(20), UNKNOWN = '0x' + '33'.repeat(20);
  const reserved = statusWire.responses['status.reserved'].item;
  const finalized = { ...reserved, intentId: '0x' + '56'.repeat(32), state: 'reconciled', canCancel: false, signer: '0x' + '57'.repeat(20), nonceRaw: '3',
    attempts: [{ ordinal: 0, transactionHash: '0x' + 'ab'.repeat(32) }],
    receipt: { transactionHash: '0x' + 'ab'.repeat(32), blockNumberRaw: '8123456', blockHash: '0x' + 'cd'.repeat(32), canonical: true, finalized: true, serviceFeeBps: 200,
      serviceFeeRecipient: '0x' + '78'.repeat(20), liquidityIncreaseRaw: '1000000', fullL2CostWei: null, sources: [
        { sourceId: '0x' + '9a'.repeat(32), currency: TOKEN, grossOriginalConsumedRaw: '1500000', chargedConsumedRaw: '0', serviceFeeRaw: '30000', liquidityAddedRaw: '1470000', originalAfterRaw: '250000', chargedAfterRaw: '0' },
        { sourceId: '0x' + '9b'.repeat(32), currency: UNKNOWN, grossOriginalConsumedRaw: '42', chargedConsumedRaw: '0', serviceFeeRaw: '1', liquidityAddedRaw: '41', originalAfterRaw: '0', chargedAfterRaw: '0' }] } };
  const list = { ...statusWire.responses['list.empty'], owner: OWNER, items: [reserved, finalized] };
  const status = { ...statusWire.responses['status.reserved'], owner: OWNER, item: { ...reserved, state: 'signing', canCancel: false, signer: '0x' + '57'.repeat(20), nonceRaw: '4' } };
  assert.ok(executionRuntime.validateResponse('list', list)); assert.ok(executionRuntime.validateResponse('status', status));
  const sent = [];
  await s.context.route(/\/api\/execution\/v1\/(list|status)$/, async route => {
    const request = route.request(), path = new URL(request.url()).pathname;
    sent.push({ path, body: request.postDataJSON(), csrf: request.headers()['x-domino-csrf'] ?? null });
    await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', headers: { 'X-Domino-Execution-Contract': executionRuntime.CONTRACT_VERSION }, body: JSON.stringify(path.endsWith('/list') ? list : status) });
  });
  const asked = await answerTokenReads(s.context, { [TOKEN]: { symbol: 'TOKEN', decimals: 6 } });
  await s.context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: s.origin });
  try {
    await login(s.page);
    const receipts = s.page.locator('section[aria-label="Execution receipts"]');
    const done = receipts.locator(`[data-execution-intent="${finalized.intentId}"]`), open = receipts.locator(`[data-execution-intent="${reserved.intentId}"]`);
    await done.locator('summary').waitFor();
    assert.deepEqual(await receipts.locator('[data-execution-intent]').evaluateAll(rows => rows.map(row => row.getAttribute('data-execution-intent'))), [reserved.intentId, finalized.intentId], 'what is under way first');
    // The row: its chip, what it did and what it added, in token units summed per token; a token with no decimals is a dash.
    await done.locator('[data-receipt-added]').getByText('1.47 TOKEN', { exact: true }).waitFor({ timeout: 30_000 });
    await done.locator(`[data-receipt-added] [data-receipt-currency="${UNKNOWN}"] [data-amount-reason="decimals_unavailable"]`).waitFor({ timeout: 30_000 });
    // Changed on purpose (the owner, 2026-09-27, round 6): "Fees added back", the position page's phrase (was "Fees re-added").
    assert.equal(await done.locator('summary').innerText(), 'Done\nFees added back\n1.47 TOKEN + —');
    assert.equal(await done.locator('.dm-pill').getAttribute('title'), 'Finalized');
    assert.deepEqual([await open.locator('summary').innerText(), await open.locator('.dm-pill').getAttribute('title')], ['In progress\nAdding fees back', 'Reserved']);
    assert.doesNotMatch(await receipts.innerText(), /0x[0-9a-f]{4}/, 'no hash in sight until a row is opened');
    assert.deepEqual([...asked].sort(), [TOKEN, UNKNOWN], 'one token read per currency, through the read path');

    // Its detail: four plain lines, then the technical part, each id short, whole in its title and in its copy.
    await done.locator('summary').click();
    const line = name => done.locator(`[data-receipt-line="${name}"]`);
    assert.deepEqual(await Promise.all(['grossOriginalConsumedRaw', 'serviceFeeRaw', 'liquidityAddedRaw', 'originalAfterRaw'].map(name => line(name).innerText())),
      ['Fees used\n1.5 TOKEN + —', 'Service fee (2%)\n0.03 TOKEN + —', 'Added to your position\n1.47 TOKEN + —', 'Kept for next time\n0.25 TOKEN']);
    assert.equal(await line('grossOriginalConsumedRaw').locator('[data-amount="units"]').getAttribute('title'), '1.5. 1,500,000 in the token’s smallest units.');
    assert.equal(await line('grossOriginalConsumedRaw').locator('[data-amount="unknown"]').getAttribute('title'), 'Token decimals unavailable. 42 in the token’s smallest units.');
    for (const [field, label, value] of [['transaction-hash', 'Copy transaction', finalized.receipt.transactionHash], ['service-fee-recipient', 'Copy fee paid to', finalized.receipt.serviceFeeRecipient], ['intent', 'Copy receipt id', finalized.intentId]]) {
      const row = done.locator(`[data-receipt-field="${field}"]`);
      assert.equal(await row.locator('dd .dm-mono').innerText(), `${value.slice(0, 6)}…${value.slice(-4)}`, `${field} is short`);
      assert.equal(await row.locator('dd .dm-mono').getAttribute('title'), value, `${field} is whole in its title`);
      assert.equal(await row.getByRole('button', { name: label }).count(), 1, `${field} has a copy button`);
    }
    await done.getByRole('button', { name: 'Copy transaction' }).click();
    await done.locator('[data-receipt-field="transaction-hash"] [data-copied]').waitFor();
    assert.equal(await s.page.evaluate(() => navigator.clipboard.readText()), finalized.receipt.transactionHash);

    // The open one: what it is waiting for, and how to stop it while it can be.
    assert.equal(await open.getAttribute('data-execution-can-cancel'), 'true');
    await open.locator('summary').click();
    // Changed on purpose (2026-09-27, round 5 review): the sentence is plain ("a transaction slot is reserved" was for engineers).
    assert.match(await open.innerText(), /Getting ready\. Nothing has been sent\.\s+It can still be stopped: press Pause on your position’s page before it is signed\.\s+How to pause/);
    assert.equal(await open.getByRole('link', { name: 'How to pause', exact: true }).getAttribute('href'), '/docs/non-custodial#pause-revoke-withdraw');
    assert.deepEqual(await receipts.locator('a').evaluateAll(links => links.map(link => link.getAttribute('href'))), ['/docs/non-custodial#pause-revoke-withdraw'], 'no external link: the one link is how to pause');
    assert.deepEqual([await done.getAttribute('data-execution-can-cancel'), await done.getByRole('link').count()], ['false', 0]);
    const text = await receipts.innerText();
    assert.doesNotMatch(text, FORBIDDEN); assert.doesNotMatch(text, /_/, 'no code is printed');
    await noManualReads(receipts);
    await s.page.screenshot({ path: join(shots(), 'p2-receipt-identity.png'), fullPage: true });
    await captureReceiptState(s.page, 'receipts-expanded', receipts);

    assert.deepEqual(sent.map(call => call.path), ['/api/execution/v1/list'], 'only the page so far');
    await jump(s.page, '00:31');
    await receipts.locator(`[data-execution-intent="${reserved.intentId}"][data-execution-state="signing"]`).waitFor();
    assert.deepEqual(sent.map(call => [call.path, call.body, Boolean(call.csrf)]), [['/api/execution/v1/list', { afterIntentId: null, limit: 20 }, true], ['/api/execution/v1/status', { intentId: reserved.intentId }, true]]);
    assert.equal(await open.getByRole('link', { name: 'How to pause' }).count(), 0, 'signed: no longer offered as stoppable');
    assert.deepEqual(await receipts.locator('[data-execution-intent]').evaluateAll(cards => cards.map(card => card.getAttribute('data-execution-intent'))), [reserved.intentId, finalized.intentId], 'replaced where it stands');
    assert.equal(s.wallet.state.signed.length, 1, 'only the login signature');
  } finally { await s.close(); }
});

// ---- Receipts, many, few and none (owner, 2026-09-27, round 5): the Positions tab's short Recent list, and its own page ---------
//
// The situation in the owner's screenshot: a wallet whose automation cancelled most of its attempts before sending them, with a
// finalized compound among them. The receipts arrive ten to a page, in the service's id order (execution-v1 carries no time).

const USDG_TOKEN = '0x' + '5a'.repeat(20), UFG_TOKEN = '0x' + '6b'.repeat(20);
const intentOf = n => '0x' + n.toString(16).padStart(64, '0');
/** A receipt of `state`, numbered `n`; a finalized one at `block`, re-adding `usdg` USDG (6 decimals) and `ufg` UFG (18). */
function receiptItem(n, state, { block = 0, usdg = '0', ufg = '0' } = {}) {
  const base = { ...statusWire.responses['status.reserved'].item, intentId: intentOf(n), state, canCancel: state === 'reserved', reason: state === 'cancelled' ? 'price_moved' : '' };
  if (state !== 'reconciled') return base;
  const tx = '0x' + (n + 0x40).toString(16).padStart(2, '0').repeat(32);
  const source = (currency, added, sourceByte) => {
    const used = (BigInt(added) * 100n) / 98n, fee = used - BigInt(added);
    return { sourceId: '0x' + sourceByte.repeat(32), currency, grossOriginalConsumedRaw: String(used), chargedConsumedRaw: '0', serviceFeeRaw: String(fee), liquidityAddedRaw: added, originalAfterRaw: '0', chargedAfterRaw: '0' };
  };
  return { ...base, canCancel: false, signer: '0x' + '57'.repeat(20), nonceRaw: String(n), attempts: [{ ordinal: 0, transactionHash: tx }],
    receipt: { transactionHash: tx, blockNumberRaw: String(block), blockHash: '0x' + 'cd'.repeat(32), canonical: true, finalized: true, serviceFeeBps: 200,
      serviceFeeRecipient: '0x' + '78'.repeat(20), liquidityIncreaseRaw: '230436590688', fullL2CostWei: null,
      sources: [source(USDG_TOKEN, usdg, '9a'), source(UFG_TOKEN, ufg, '9b')].filter(one => one.liquidityAddedRaw !== '0') } };
}
/** The list route answering `pages` in order, each page's cursor the last id of the one before; every call is logged. */
async function answerReceipts(context, pages) {
  const asked = [];
  await context.route(/\/api\/execution\/v1\/(list|status)$/, async route => {
    const request = route.request(), body = request.postDataJSON(), path = new URL(request.url()).pathname;
    asked.push({ path, body });
    const at = body.afterIntentId === null || body.afterIntentId === undefined ? 0 : pages.findIndex(page => page.at(-1)?.intentId === body.afterIntentId) + 1;
    const items = path.endsWith('/list') ? pages[at] ?? [] : [];
    const answer = path.endsWith('/list')
      ? { ...statusWire.responses['list.empty'], owner: OWNER, items, nextAfterIntentId: at + 1 < pages.length ? items.at(-1).intentId : null }
      : { ...statusWire.responses['status.missing'], owner: OWNER, item: pages.flat().find(item => item.intentId === body.intentId) ?? null };
    assert.ok(executionRuntime.validateResponse(path.endsWith('/list') ? 'list' : 'status', answer), `${path} answer is valid`);
    await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', headers: { 'X-Domino-Execution-Contract': executionRuntime.CONTRACT_VERSION }, body: JSON.stringify(answer) });
  });
  await answerTokenReads(context, { [USDG_TOKEN]: { symbol: 'USDG', decimals: 6 }, [UFG_TOKEN]: { symbol: 'UFG', decimals: 18 } });
  return asked;
}
// The receipts' prints go to DOMINO_RECEIPT_SHOTS when it is set, else beside the other prints (integration, 2026-09-27:
// no machine's own folder in the suite).
const RECEIPT_SHOTS = process.env.DOMINO_RECEIPT_SHOTS || resolve(import.meta.dirname, '../.test-artifacts');
/** Until every amount a row shows has its token's details: none still reading. */
async function unitsRead(section) {
  await section.locator('[data-receipt-added]').first().waitFor();
  await section.page().waitForFunction(root => !root.querySelector('[data-receipt-added] [data-amount-reason="reading"]'), await section.elementHandle(), { timeout: 30_000 });
}
/** What the rows of a receipts list say, in order: each summary's text, one line per row. */
const rowTexts = list => list.locator(':scope > li > details > summary').evaluateAll(rows => rows.map(row => row.innerText.replace(/\n+/g, ' | ')));
/** Desktop 1280x900 and phone 390x844: the Receipts and Managed pair, and the whole page, for the owner. */
async function shootBoth(page, name, target = null) {
  mkdirSync(RECEIPT_SHOTS, { recursive: true });
  for (const [label, size] of [['desktop', { width: 1280, height: 900 }], ['phone', { width: 390, height: 844 }]]) {
    await page.setViewportSize(size);
    // Past the chevrons' turn (150 ms) and the layout's settling, so a picture never catches a row half open.
    await page.waitForTimeout(400);
    // The sticky header is hidden for the crop only, so it never lies over the top of a card taller than the phone's screen
    // (through the CSSOM: the page's CSP refuses an injected style sheet).
    const header = (hidden) => page.evaluate(value => { document.querySelector('.dm-header').style.visibility = value; }, hidden ? 'hidden' : '');
    if (target) { await target.scrollIntoViewIfNeeded(); await header(true); await target.screenshot({ path: join(RECEIPT_SHOTS, `${name}-${label}.png`) }); await header(false); }
    // From the top, so the sticky header sits where it belongs in the whole-page picture.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);
    await page.screenshot({ path: join(RECEIPT_SHOTS, `${name}-${label}-page.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 1320, height: 1000 });
}

// Changed on purpose (2026-09-27, round 5 review): the Positions tab and the receipts page share one controller, so See all
// and the way back read no list of their own (execution-v1 allows one read per 30 s), and a failed receipt's sentence is plain.
// 2026-09-28 (speed wave B, item 25: Receipts named its tokens one at a time through the read path, 1.1 s apart, about 2.7
// to 4.5 s on a first visit): a receipt's tokens are named from one read of the chain for all of them (their symbol() and
// decimals() in one aggregate3), and only one the chain gives no decimals for goes on to the read path. Changed on purpose
// (RPC-SPEC, 2026-10-01, the owner's rule: nothing is read from a public RPC): no read of the chain for them any more; a
// token this visit's chain routes named is named at once, and every other one is read-v1's `token` read, as before.
test('a receipt’s tokens are named from the read path, nothing read of the chain for them; one it gives no decimals for says so', async () => {
  const TOKEN = '0x' + '11'.repeat(20), OTHER = '0x' + '22'.repeat(20), UNKNOWN = '0x' + '33'.repeat(20);
  const chain = browserChain({ tokens: { [TOKEN]: { symbol: 'TOKEN', decimals: 6 }, [OTHER]: { symbol: 'OTH', decimals: 18 } } });
  const s = await scenario({ clock: true, chain });
  const reserved = statusWire.responses['status.reserved'].item;
  const source = (id, currency, added) => ({ sourceId: '0x' + id.repeat(32), currency, grossOriginalConsumedRaw: added, chargedConsumedRaw: '0', serviceFeeRaw: '0', liquidityAddedRaw: added, originalAfterRaw: '0', chargedAfterRaw: '0' });
  const finalized = { ...reserved, intentId: '0x' + '56'.repeat(32), state: 'reconciled', canCancel: false, signer: '0x' + '57'.repeat(20), nonceRaw: '3',
    attempts: [{ ordinal: 0, transactionHash: '0x' + 'ab'.repeat(32) }],
    receipt: { transactionHash: '0x' + 'ab'.repeat(32), blockNumberRaw: '8123456', blockHash: '0x' + 'cd'.repeat(32), canonical: true, finalized: true, serviceFeeBps: 200,
      serviceFeeRecipient: '0x' + '78'.repeat(20), liquidityIncreaseRaw: '1000000', fullL2CostWei: null,
      sources: [source('9a', TOKEN, '1470000'), source('9b', OTHER, '2000000000000000000'), source('9c', UNKNOWN, '41')] } };
  const list = { ...statusWire.responses['list.empty'], owner: OWNER, items: [finalized] };
  assert.ok(executionRuntime.validateResponse('list', list));
  await s.context.route(/\/api\/execution\/v1\/(list|status)$/, async route => {
    await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', headers: { 'X-Domino-Execution-Contract': executionRuntime.CONTRACT_VERSION }, body: JSON.stringify(list) });
  });
  const asked = await answerTokenReads(s.context, { [TOKEN]: { symbol: 'TOKEN', decimals: 6 }, [OTHER]: { symbol: 'OTH', decimals: 18 } });
  try {
    await login(s.page);
    const done = s.page.locator(`section[aria-label="Execution receipts"] [data-execution-intent="${finalized.intentId}"]`);
    await done.locator('[data-receipt-added]').getByText('1.47 TOKEN', { exact: true }).waitFor({ timeout: 30_000 });
    await done.locator('[data-receipt-added]').getByText('2 OTH', { exact: true }).waitFor({ timeout: 30_000 });
    await done.locator(`[data-receipt-added] [data-receipt-currency="${UNKNOWN}"] [data-amount-reason="decimals_unavailable"]`).waitFor({ timeout: 30_000 });
    assert.deepEqual([...asked].sort(), [TOKEN, OTHER, UNKNOWN].sort(), 'each token asked of the read path once');
    const reads = chain.log.filter((call) => call.method === 'eth_call' && call.params[0].data.includes('95d89b41'));
    assert.equal(reads.length, 0, 'nothing read of the chain for the receipt’s tokens');
  } finally { await s.close(); }
});

test('many receipts: the Positions tab shows four short rows at most, cancelled ones folded into one, and See all opens their own page with what the tab read, where the next page arrives by itself', async () => {
  const s = await scenario({ clock: true });
  const first = [receiptItem(1, 'cancelled'), receiptItem(2, 'reconciled', { block: 7346840, usdg: '16490000', ufg: '1086592191816706700000' }), receiptItem(3, 'cancelled'),
    receiptItem(4, 'reserved'), receiptItem(5, 'cancelled'), receiptItem(6, 'cancelled'), receiptItem(7, 'reconciled', { block: 7351002, usdg: '4200000' }),
    receiptItem(8, 'cancelled'), receiptItem(9, 'cancelled'), receiptItem(10, 'cancelled')];
  const second = [receiptItem(11, 'reconciled', { block: 7349977, ufg: '52000000000000000000' }), receiptItem(12, 'cancelled'), receiptItem(13, 'reverted')];
  const asked = await answerReceipts(s.context, [first, second]);
  try {
    await login(s.page);
    const card = s.page.locator('section[aria-labelledby="receipts-title"]');
    const receipts = card.locator('section[aria-label="Execution receipts"]');
    const list = receipts.locator('.dm-rcpt-list');
    await unitsRead(receipts);
    // Four rows: the one under way, the two finalized ones by block (latest first), and the seven cancelled ones as one.
    assert.equal(await receipts.getAttribute('data-execution-rows'), '4');
    assert.deepEqual(await rowTexts(list), ['In progress | Adding fees back', 'Done | Fees added back | 4.2 USDG', 'Done | Fees added back | 16.49 USDG + 1,086.59 UFG', 'Cancelled | 7 cancelled before sending']);
    assert.doesNotMatch(await card.innerText(), /0x[0-9a-f]{4}|Sequence|Intent|raw units|canonical/i, 'no hash, code or raw unit in sight');
    assert.equal(await receipts.getByRole('button', { name: 'Show more' }).count(), 0, 'the preview never grows: its card links the full list instead');
    const listReads = () => asked.filter(call => call.path.endsWith('/list')).length;
    assert.equal(listReads(), 1, 'the first page, once');
    const bounded = await card.boundingBox();
    assert.ok(bounded.height < 520, `the Receipts card stays short: ${bounded.height}px`);
    // The cancelled ones, opened: one sentence and their ids, each whole in its title with its reason.
    const folded = list.locator('[data-execution-cancelled]');
    assert.equal(await folded.getAttribute('data-execution-cancelled'), '7');
    await folded.locator('summary').click();
    assert.match(await folded.innerText(), /Automation stopped these before sending anything, so nothing changed and no fee was charged\./);
    assert.deepEqual(await folded.locator('[data-execution-intent]').evaluateAll(ids => ids.map(id => id.getAttribute('data-execution-intent'))), [1, 3, 5, 6, 8, 9, 10].map(intentOf));
    assert.equal(await folded.locator(`[data-execution-intent="${intentOf(1)}"]`).getAttribute('title'), `${intentOf(1)}. price moved`);
    await folded.locator('summary').click();
    await list.locator(`[data-execution-intent="${intentOf(2)}"] summary`).click();
    await shootBoth(s.page, 'many-positions-tab', s.page.locator('.dm-acct-pair'));
    await list.locator(`[data-execution-intent="${intentOf(2)}"] summary`).click();

    // See all, in the card's head: the full list on its own page, Positions still lit in the header.
    const all = card.locator('[data-receipts-all]');
    assert.deepEqual([await all.innerText(), await all.getAttribute('href')], ['See all', '/positions/receipts']);
    await all.click();
    await s.page.waitForFunction(() => location.pathname + location.hash === '/positions/receipts');
    // The hash changes before the page's own chunk renders; wait for its heading (CI read "Positions" first, 2026-09-28).
    await s.page.getByRole('heading', { level: 1, name: 'Receipts' }).waitFor();
    assert.equal(await s.page.getByRole('heading', { level: 1 }).innerText(), 'Receipts');
    assert.equal(await s.page.locator('header nav[aria-label="Main"] a[aria-current="page"]').innerText(), 'Positions');
    assert.equal(await s.page.locator('main a.dm-pos-back').getAttribute('href'), '/positions');
    const full = s.page.locator('section[aria-label="Execution receipts"]');
    await s.page.locator('section[aria-label="Execution receipts"][data-execution="ready"]').waitFor();
    await unitsRead(full);
    assert.deepEqual(await rowTexts(full.locator('.dm-rcpt-list')), ['In progress | Adding fees back', 'Done | Fees added back | 4.2 USDG', 'Done | Fees added back | 16.49 USDG + 1,086.59 UFG', 'Cancelled | 7 cancelled before sending']);
    assert.equal(listReads(), 1, 'the page shows what the Positions tab read: no list read of its own');
    assert.equal(await s.page.locator('[data-receipts-all]').count(), 0, 'the page does not link itself');
    await shootBoth(s.page, 'many-receipts-page');
    // Back to Positions and See all again: the same rows at once, and still that one read.
    await s.page.locator('main a.dm-pos-back').click();
    await s.page.waitForFunction(() => location.pathname + location.hash === '/positions');
    await list.waitFor();
    await unitsRead(receipts);
    assert.deepEqual(await rowTexts(list), ['In progress | Adding fees back', 'Done | Fees added back | 4.2 USDG', 'Done | Fees added back | 16.49 USDG + 1,086.59 UFG', 'Cancelled | 7 cancelled before sending']);
    await all.click();
    await s.page.waitForFunction(() => location.pathname + location.hash === '/positions/receipts');
    // The old Positions list also matches `full`; a changed hash alone does not mean the Receipts page committed.
    await s.page.getByRole('heading', { level: 1, name: 'Receipts' }).waitFor();
    await full.locator('.dm-rcpt-list').waitFor();
    assert.equal(listReads(), 1, 'nor does the way back, nor See all again');
    // Changed on purpose (the owner, 2026-09-27, round 6: Show more vanished and the rest never came): the next page is read by
    // itself at the contract's pace (one read per 30 s), with no press, and the rows take it in where they belong.
    // Changed on purpose (2026-09-28, round 6 review): while it is on its way Show more is offered (it was left out until the whole
    // read ended, so it went away while the rest was coming); the rest still comes with nothing pressed, and then it goes.
    const reads = asked.filter(call => call.path.endsWith('/list')).length;
    // Waited for, not counted at once (audit H3: CI counted 0 on PR #280): the page draws Show more from the shared
    // receipts as it mounts, and the rest cannot come before the clock's jump below, so nothing can take it away first.
    await full.getByRole('button', { name: 'Show more' }).waitFor();
    assert.equal(await full.getByRole('button', { name: 'Show more' }).count(), 1, 'more on its way: Show more is offered');
    await jump(s.page, '00:31');
    await full.locator(`[data-execution-intent="${intentOf(11)}"]`).waitFor();
    assert.equal(await full.getByRole('button', { name: 'Show more' }).count(), 0, 'nothing pressed, the rest came by itself; the end, nothing more');
    await unitsRead(full);
    assert.deepEqual(asked.filter(call => call.path.endsWith('/list')).slice(reads).map(call => call.body), [{ afterIntentId: intentOf(10), limit: 20 }]);
    assert.deepEqual(await rowTexts(full.locator('.dm-rcpt-list')), ['In progress | Adding fees back', 'Done | Fees added back | 4.2 USDG', 'Done | Fees added back | 52 UFG', 'Done | Fees added back | 16.49 USDG + 1,086.59 UFG', 'Failed | Fees not added back', 'Cancelled | 8 cancelled before sending']);
    // The failed one, opened: what happened, in plain words.
    const failed = full.locator(`[data-execution-intent="${intentOf(13)}"]`);
    await failed.locator('summary').click();
    assert.match(await failed.innerText(), /The network turned it down: nothing changed and no fee was taken\./);
    const text = await full.innerText();
    assert.doesNotMatch(text, FORBIDDEN); assert.doesNotMatch(text, /_/, 'no code is printed');
    assert.doesNotMatch(text, /revert|nonce|canonical|finality|inclusion|broadcast|transaction slot/i, 'no word for engineers');
    await failed.locator('summary').click();
    await noManualReads(full);
    await full.locator('[data-execution-cancelled] summary').click();
    await shootBoth(s.page, 'many-receipts-page-more');
    assert.equal(s.wallet.state.signed.length, 1, 'only the login signature');
  } finally { await s.close(); }
});

test('few receipts and none: a short list with nothing to fold, and a friendly empty plate; Managed positions shows one short row per position with its figures one click away', V1_HISTORY, async () => {
  for (const [name, pages] of [['few', [[receiptItem(1, 'cancelled'), receiptItem(2, 'reconciled', { block: 7346840, usdg: '16490000', ufg: '1086592191816706700000' })]]], ['none', [[]]]]) {
    const s = await scenario();
    await answerReceipts(s.context, pages);
    try {
      await login(s.page);
      const receipts = s.page.locator('section[aria-label="Execution receipts"]');
      await s.page.locator('section[aria-label="Execution receipts"][data-execution="ready"]').waitFor();
      const history = s.page.locator('section[aria-label="Private performance"]');
      const row = history.locator('.dm-mp-row[data-performance-status]');
      await row.waitFor();
      if (name === 'few') {
        await unitsRead(receipts);
        assert.deepEqual(await rowTexts(receipts.locator('.dm-rcpt-list')), ['Done | Fees added back | 16.49 USDG + 1,086.59 UFG', 'Cancelled | Cancelled before sending']);
      } else {
        const quiet = receipts.locator('.dm-acct-quiet');
        // Changed on purpose (the owner, 2026-09-27, round 6): "adds your fees back", with no hyphen to break (was "re-adds").
        assert.equal(await quiet.innerText(), 'Nothing yet. Each time automation adds your fees back, its receipt shows here.');
        assert.equal(await receipts.locator('.dm-rcpt-list').count(), 0);
      }
      // Managed positions: the position's name opens its page; three figures at a glance, the rest inside All figures.
      // Changed on purpose (the owner, 2026-09-27, round 6): "Fees added back", the one phrase every screen uses (was "Re-added").
      assert.equal(await row.locator('.dm-mp-name').getAttribute('href'), '/positions/1');
      assert.deepEqual(await row.locator(':scope > .dm-mp-figs > div').evaluateAll(cells => cells.map(cell => [cell.querySelector('dt').textContent, cell.querySelector('dd').textContent])),
        [['Fees earned', '$0.50'], ['Fees added back', '$50.00'], ['APR after fees', '-14.78%']]);
      // Each label on one line, on desktop and phone.
      // Changed on purpose 2026-10-03 (the owner: the site looks too big at 100%; at 80% it looks right): one 16px line in
      // design px, at the root's scale (styles/tokens.css: 0.8 at 1280px, 1 at 390px).
      for (const width of [1280, 390]) {
        await s.page.setViewportSize({ width, height: 844 });
        const line = await s.page.evaluate(() => Math.round((16 * Number.parseFloat(getComputedStyle(document.documentElement).fontSize)) / 16));
        assert.deepEqual(await row.locator(':scope > .dm-mp-figs dt').evaluateAll(labels => labels.map(dt => Math.round(dt.getBoundingClientRect().height))), [line, line, line], `one line each at ${width}px`);
      }
      await s.page.setViewportSize({ width: 1320, height: 1000 });
      assert.equal(await history.getByText('Vault', { exact: false }).count(), 0, 'no vault in sight');
      await shootBoth(s.page, `${name}-positions-tab`, s.page.locator('.dm-acct-pair'));
    } finally { await s.close(); }
  }
});

const chainAbi = parseAbi([
  'struct Policy { uint16 serviceFeeBps; uint16 triggerDistanceBps; uint16 maxOverlapBps; uint32 minimumIntervalSeconds; uint8 maxPositions; uint64 version; bool paused; }',
  'struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }',
  'struct ExecutionLimits { uint64 version; uint32 upsideBps; uint16 maxSlippageBps; uint16 maxPriceImpactBps; uint128 maxGasCostWei; uint32 maxObservationAgeSeconds; uint32 forecastHorizonSeconds; }',
  'struct InitParams { uint256 rootTokenId; bytes32 expectedPoolId; address baseCurrency; address quoteCurrency; address operator; bool consentToUncollectedFees; Policy policy; ExecutionLimits limits; }',
  'function predictVault(address,uint256) view returns(address)', 'function ownerOf(uint256) view returns(address)',
  'function getPoolAndPositionInfo(uint256) view returns(PoolKey,uint256)', 'function getApproved(uint256) view returns(address)',
  'function approve(address to, uint256 tokenId)', 'function createVault(InitParams,uint256) returns(address)',
  'struct Position { bool known; bool active; bool isRoot; uint256 parentTokenId; uint64 generation; int24 tickLower; int24 tickUpper; bytes32 registrationBaselineId; bytes32 identity; bytes32 source0; bytes32 source1; }',
  'function implementation() view returns(address)', 'function implementationCodeHash() view returns(bytes32)', 'function poolManager() view returns(address)', 'function positionManager() view returns(address)',
  'function stateView() view returns(address)', 'function serviceFeeRecipient() view returns(address)', 'function factory() view returns(address)', 'function implementationVersion() view returns(uint64)',
  'function readHelper() view returns(address)', 'function executionEngine() view returns(address)', 'function nextOwnerNonce(address) view returns(uint256)', 'function vaultForSequence(bytes32) view returns(address)',
  'function isVault(address) view returns(bool)', 'function owner() view returns(address)', 'function sequenceId() view returns(bytes32)', 'function policy() view returns(Policy)', 'function rootTokenId() view returns(uint256)',
  'function operator() view returns(address)', 'function rootPermissionValid() view returns(bool)', 'function baseCurrency() view returns(address)', 'function quoteCurrency() view returns(address)',
  'function stateNonce() view returns(uint64)', 'function position(uint256) view returns(Position)', 'function successorOf(uint256) view returns(uint256)', 'function activePositions() view returns(uint256)',
  // The rest of the non-recovery verification, which only the sequence screen's
  // connect reaches: the implementation's five code-hash getters, the engine's
  // three helpers by address and by hash, and the guard's publisher.
  'function readHelperCodeHash() view returns(bytes32)', 'function executionEngineCodeHash() view returns(bytes32)', 'function poolManagerCodeHash() view returns(bytes32)',
  'function positionManagerCodeHash() view returns(bytes32)', 'function stateViewCodeHash() view returns(bytes32)', 'function routingHelper() view returns(address)',
  'function priceGuard() view returns(address)', 'function readHelperHash() view returns(bytes32)', 'function routingHelperHash() view returns(bytes32)',
  'function priceGuardHash() view returns(bytes32)', 'function publisher() view returns(address)',
  // The vault's own limits and balance reads, which the safety-limit change and the recovery steps make before anything is offered.
  'struct Balance { uint128 original; uint128 charged; }',
  'function executionLimits() view returns(ExecutionLimits)', 'function feeBalance(bytes32,address) view returns(Balance)',
  'function accountedCurrency(address) view returns(uint256)',
  // Simulated before it is offered, so the call has to resolve here too.
  'function setOperator(address next)', 'function setPolicy(Policy next)', 'function setExecutionLimits(ExecutionLimits next)',
  'function rearmRoot(bool consentToUncollectedFees)', 'function recoverUnmanagedPosition(uint256 tokenId)', 'function recoverUntrackedCurrency(address currency, uint256 amount)',
  // 2026-09-25 (owner): a sequence's Turn on and Pause, the owner's one transaction each on the vault.
  'function resume()', 'function pause()',
  // 2026-10-02 (rugged97's spec rev3 §2.13): the fees waiting in a vault, read per source and withdrawn by its owner.
  'struct Source { bool known; uint256 tokenId; address originalCurrency; bytes32 positionIdentity; }',
  'function source(bytes32) view returns(Source)', 'function withdrawFeeReserves(bytes32,address,uint128,uint128)',
]);

/**
 * A chain with a published sequence deployment and `roots.length` sequences created by `owner`, answered only for
 * the reads the sequence client makes. Anything else is refused as a non-read, and every method asked is logged.
 *
 * The vault's own state is what the owner steps re-read before they build anything, so each part of it is a knob:
 * `policyVersion`, `paused`, `limitsVersion` and `rootPermissionValid` for the vault's policy, limits and permission,
 * `vaultHeld` for NFTs the position manager reports the vault holding, and `accounted` for the units its books claim.
 * The policy and limits answered are also returned, so a test can compare a built struct against them field by field.
 *
 * Two knobs are for the guided creation, whose steps change the chain they are sent to. `approved: false` leaves every
 * NFT unapproved until an `approve` is sent, instead of reporting it approved to its predicted vault up front; a sent
 * `createVault` then registers the vault at the address it predicted, with the policy and limits it carried, so the
 * vault's views and the factory's `isVault`/`vaultForSequence` answer for it. `settled: true` includes every sent
 * transaction at once in the finalized block, instead of leaving it pending until `include` is called.
 *
 * Four more are for what Set up automation refuses or survives (added 2026-09-24 with the audit's fixes): `subscribed` lists the
 * NFTs whose PositionInfo carries the position manager's hasSubscriber flag, `holder` is who holds every NFT when it is not the
 * owner, `lostApproval` includes a sent `approve` without recording it, and `balance` is the owner's ETH.
 *
 * Added 2026-10-02 (the fees waiting in a vault, rugged97's spec rev3 §2.13): each position a vault registered has two fee
 * sources of its own (sourceOf), and `reserves` books balances on them, per vault (by its nonce): [{ tokenId, source: 0 or
 * 1, currency: 'base' or 'quote', original, charged }]. A sent or batched `withdrawFeeReserves` pays them out as the vault
 * does (and refuses more than is booked), moving the vault's state nonce on; `rootPermissionValid` may be a list, one per
 * vault. `refuseNextSend()` makes the wallet refuse the next transaction (4001, the person declined), and `dropNextSend()`
 * makes it lose its answer to the next one (-32603), which it never sent.
 *
 * Added with the review of the fee withdrawal (2026-10-02): each withdrawal is recorded as the vault records it, a
 * FeeReservesWithdrawn log under the transaction that paid it (eth_getLogs answers them, refused past the chain RPC's
 * limits, tests/support/log-limits.mjs), and a batch the wallet confirmed names that transaction in its receipts.
 * `automationRun(nonce, lines)` is an operator execution: it sets the balances `lines` name ({ tokenId, source, currency,
 * original, charged }), spending or crediting fees with no withdrawal, and moves the vault's state nonce on, as
 * executionApply and _credit do. `cancelNextInWallet(name, effect)` runs `effect` when the cancel takes the nonce, and
 * `failVaultReads(nonce, on)` makes every read of that vault fail (-32000) while on.
 */
function fakeSequenceChain(owner, { roots, chains = {}, operator = null, serviceFeeBps = 400, maxPositions = 3,
  policyVersion = 1n, paused = false, limitsVersion = 1n, rootPermissionValid = true, vaultHeld = [], accounted = 0n, approved = true, settled = false,
  subscribed = [], holder = null, lostApproval = false, balance = '0xde0b6b3a7640000', atomic = null, batchError = null, holdBatch = false, simulation = 'wallet',
  reserves = {} }) {
  const at = (byte, bytes = 20) => `0x${byte.toString(16).padStart(2, '0').repeat(bytes)}`, zero = at(0, 32);
  const cloneOf = implementation => concatHex(['0x363d3d373d3d3d363d73', implementation, '0x5af43d82803e903d91602b57fd5bf3']);
  const implementation = at(0x42), factoryCode = '0x6001', implementationCode = '0x6002';
  const deployment = { factory: at(0x41), implementation, poolManager: at(0x43), positionManager: at(0x44), stateView: at(0x45), readHelper: at(0x46), engine: at(0x47), routing: at(0x48), priceGuard: at(0x49),
    serviceFeeRecipient: at(0x4a), operator: at(0x4b), pricePublisher: at(0x4c), serviceFeeBps: 200, dominoServiceFeeBps: 400, expiresAt: 4_000_000_000, codeHashes: null };
  // Every component carries code whose hash is the one the profile declares, so
  // a FULL verify() passes — not only the recovery subset. Without this the
  // sequence screen's connect fails with "The deployed code no longer matches
  // its profile", because eth_getCode answered 0x for everything but the
  // factory, the implementation and the vaults.
  const COMPONENTS = ['factory', 'implementation', 'poolManager', 'positionManager', 'stateView', 'readHelper', 'engine', 'routing', 'priceGuard'];
  const codeOf = new Map(COMPONENTS.map((name, index) => [deployment[name], name === 'factory' ? factoryCode : name === 'implementation' ? implementationCode : `0x60${(0x10 + index).toString(16)}`]));
  deployment.codeHashes = Object.fromEntries([...COMPONENTS.map((name) => [name, keccak256(codeOf.get(deployment[name]))]), ['vault', keccak256(cloneOf(implementation))]]);
  const typeHash = keccak256(stringToHex('DominoSequence(uint256 chainId,address factory,address owner,uint256 nonce)'));
  const initHash = keccak256(concatHex(['0x3d602d80600a3d3981f3', cloneOf(implementation)]));
  const poolKey = { currency0: at(0x61), currency1: at(0x62), fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  const poolId = keccak256(encodeAbiParameters(parseAbiParameters('(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)'), [poolKey]));
  const packedPosition = (BigInt(poolId) >> 56n << 56n) | (BigInt.asUintN(24, -60n) << 8n) | (60n << 32n);
  const identity = nonce => {
    const id = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,uint256,address,address,uint256'), [typeHash, 4663n, deployment.factory, owner, BigInt(nonce)]));
    return { id, vault: `0x${keccak256(concatHex(['0xff', deployment.factory, id, initHash])).slice(-40)}` };
  };
  const predict = nonce => identity(nonce).vault;
  // The sequences this owner created, by address: the ones `roots` names, then any a sent `createVault` adds.
  const vaults = new Map(roots.map((root, nonce) => [identity(nonce).vault, { id: identity(nonce).id, root, chain: chains[nonce] ?? [], nonce: 1n,
    valid: Array.isArray(rootPermissionValid) ? rootPermissionValid[nonce] : rootPermissionValid, balances: new Map() }]));
  // Each registered position's two fee sources, its own; and the balances `reserves` books on them, by source and currency.
  const sourceOf = (tokenId, index) => keccak256(stringToHex(`domino-fee-source:${tokenId}:${index}`));
  const balanceKey = (sourceId, currency) => `${String(sourceId).toLowerCase()}|${String(currency).toLowerCase()}`;
  for (const [nonce, list] of Object.entries(reserves)) {
    const vault = vaults.get(identity(Number(nonce)).vault);
    for (const line of list) vault.balances.set(balanceKey(sourceOf(BigInt(line.tokenId), line.source), line.currency === 'base' ? at(0x61) : at(0x62)), { original: BigInt(line.original), charged: BigInt(line.charged ?? 0n) });
  }
  const memberIds = vault => [vault.root, ...vault.chain.map(member => member.id)];
  /** What a withdrawal of `amounts` from `vault` leaves, or null when the vault refuses it (an unknown source, a currency outside the pool, more than is booked). */
  function withdrawn(vault, [sourceId, currency, original, charged], balances = vault.balances) {
    const known = memberIds(vault).some(id => [0, 1].some(index => sourceOf(id, index) === String(sourceId).toLowerCase()));
    const booked = balances.get(balanceKey(sourceId, currency)) ?? { original: 0n, charged: 0n };
    if (!known || ![at(0x61), at(0x62)].includes(String(currency).toLowerCase()) || original + charged === 0n || original > booked.original || charged > booked.charged) return null;
    return { key: balanceKey(sourceId, currency), left: { original: booked.original - original, charged: booked.charged - charged } };
  }
  // With `approved: false`, which NFT is approved to whom: what a sent `approve` records.
  const approvals = new Map();
  // The position manager reports these NFTs as held by the first vault: what an unmanaged-position recovery checks before it builds.
  const held = new Map(vaultHeld.map(tokenId => [tokenId, [...vaults.keys()][0]]));
  const policy = { serviceFeeBps, triggerDistanceBps: 500, maxOverlapBps: 2000, minimumIntervalSeconds: 60, maxPositions, version: policyVersion, paused };
  const limits = { version: limitsVersion, upsideBps: 5000, maxSlippageBps: 100, maxPriceImpactBps: 100, maxGasCostWei: 1_000_000_000_000_000n, maxObservationAgeSeconds: 60, forecastHorizonSeconds: 3600 };
  // The owner steps the vault can be asked to sign; each is simulated before it is offered, and none of them answers anything.
  const WRITES = ['setOperator', 'setPolicy', 'setExecutionLimits', 'rearmRoot', 'recoverUnmanagedPosition', 'recoverUntrackedCurrency', 'resume', 'pause'];
  // Two distinct fee sources, so a position's four reserve balances are four distinct source-and-currency pairs; each
  // position's own (2026-10-02: they were the same two for every position).
  const position = (known, active, isRoot, parentTokenId, tokenId) => ({ known, active, isRoot, parentTokenId, generation: 0n, tickLower: -60, tickUpper: 60, registrationBaselineId: zero, identity: zero,
    source0: known ? sourceOf(tokenId, 0) : zero, source1: known ? sourceOf(tokenId, 1) : zero });
  function answer(to, name, args) {
    const shared = { poolManager: deployment.poolManager, positionManager: deployment.positionManager, stateView: deployment.stateView, serviceFeeRecipient: deployment.serviceFeeRecipient };
    if ((to === deployment.factory || to === implementation) && name in shared) return shared[name];
    if (to === deployment.factory) {
      const answers = { implementation, implementationCodeHash: deployment.codeHashes.implementation, nextOwnerNonce: BigInt(vaults.size) };
      if (name in answers) return answers[name];
      if (name === 'vaultForSequence') return [...vaults].find(([, vault]) => vault.id === args[0])?.[0] ?? zeroAddress;
      if (name === 'isVault') return vaults.has(args[0].toLowerCase());
      if (name === 'predictVault') return predict(args[1]);
      if (name === 'createVault') return predict(args[1]);
    }
    if (to === implementation) {
      const answers = { factory: deployment.factory, implementation, implementationVersion: 4n, readHelper: deployment.readHelper, executionEngine: deployment.engine,
        readHelperCodeHash: deployment.codeHashes.readHelper, executionEngineCodeHash: deployment.codeHashes.engine,
        poolManagerCodeHash: deployment.codeHashes.poolManager, positionManagerCodeHash: deployment.codeHashes.positionManager, stateViewCodeHash: deployment.codeHashes.stateView };
      if (name in answers) return answers[name];
    }
    // The rest of the non-recovery verification: the managers point at the pool
    // manager, the read helper at both, the engine at its three helpers by
    // address and by code hash, and the guard at its publisher.
    if ((to === deployment.positionManager || to === deployment.stateView) && name === 'poolManager') return deployment.poolManager;
    if (to === deployment.positionManager) {
      if (name === 'ownerOf') return held.get(args[0]) ?? holder ?? owner;
      if (name === 'getPoolAndPositionInfo') return [poolKey, subscribed.includes(args[0]) ? packedPosition | 1n : packedPosition];
      if (name === 'getApproved') return approved ? predict(vaults.size) : approvals.get(args[0]) ?? zeroAddress;
      // Simulated before it is offered, like the vault's own writes below.
      if (name === 'approve') return undefined;
    }
    if (to === deployment.readHelper) {
      const answers = { positionManager: deployment.positionManager, stateView: deployment.stateView };
      if (name in answers) return answers[name];
    }
    if (to === deployment.engine) {
      const answers = { factory: deployment.factory, readHelper: deployment.readHelper, routingHelper: deployment.routing, priceGuard: deployment.priceGuard,
        readHelperHash: deployment.codeHashes.readHelper, routingHelperHash: deployment.codeHashes.routing, priceGuardHash: deployment.codeHashes.priceGuard };
      if (name in answers) return answers[name];
    }
    if (to === deployment.priceGuard && name === 'publisher') return deployment.pricePublisher;
    const vault = vaults.get(to);
    if (vault) {
      const index = id => vault.chain.findIndex(member => member.id === id);
      const answers = { owner, sequenceId: vault.id, rootTokenId: vault.root, operator: operator ?? deployment.operator, rootPermissionValid: vault.valid, baseCurrency: at(0x61), quoteCurrency: at(0x62), stateNonce: vault.nonce,
        policy: vault.policy ?? policy, executionLimits: vault.limits ?? limits, accountedCurrency: accounted,
        activePositions: BigInt(1 + vault.chain.filter(member => member.active).length) };
      if (name in answers) return answers[name];
      if (name === 'position') return args[0] === vault.root ? position(true, true, true, 0n, args[0]) : index(args[0]) === -1 ? position(false, false, false, 0n, args[0])
        : position(true, vault.chain[index(args[0])].active, false, index(args[0]) === 0 ? vault.root : vault.chain[index(args[0]) - 1].id, args[0]);
      if (name === 'successorOf') return args[0] === vault.root ? vault.chain[0]?.id ?? 0n : index(args[0]) === -1 ? 0n : vault.chain[index(args[0]) + 1]?.id ?? 0n;
      if (name === 'feeBalance') return vault.balances.get(balanceKey(args[0], args[1])) ?? { original: 0n, charged: 0n };
      if (name === 'source') {
        const tokenId = memberIds(vault).find(id => [0, 1].some(i => sourceOf(id, i) === String(args[0]).toLowerCase()));
        return tokenId === undefined ? { known: false, tokenId: 0n, originalCurrency: zeroAddress, positionIdentity: zero }
          : { known: true, tokenId, originalCurrency: sourceOf(tokenId, 0) === String(args[0]).toLowerCase() ? at(0x61) : at(0x62), positionIdentity: zero };
      }
      // Simulated before it is offered, and refused as the vault refuses it.
      if (name === 'withdrawFeeReserves') { if (!withdrawn(vault, args)) throw new Error('InsufficientReserve'); return undefined; }
      if (WRITES.includes(name)) return undefined;
    }
    throw new Error(`unexpected ${name} on ${to}`);
  }
  const log = [], missing = [], refused = [], sends = [], simulations = [];
  // The transactions this chain records, each under its own hash, once a test says they were included: `transaction`
  // overrides what the wallet actually sent (the gas fields are a wallet's to reshape, the rest is not), `receipt`
  // overrides the receipt. Until `include` is called a transaction has no receipt, so a check finds it pending — unless
  // the chain was made with `settled`, and then every send is included at once.
  const hashOf = index => at(0xcc + index, 32);
  let included = settled ? { transaction: {}, receipt: {} } : null;
  const include = (patch) => { included = patch ? { transaction: patch.transaction ?? {}, receipt: patch.receipt ?? {} } : null; };
  // 2026-10-01 (audit C14): the next send (of the function named, or any) replaced in the wallet. "Speed up": the same call
  // mined under another hash than the one the page is given. "Cancel": a 0-ETH transfer to the account itself takes the
  // nonce (`burned`), and the call never happens.
  let speedNext = null, cancelNext = null, cancelEffect = null, burned = 0, refuseNext = false, dropNext = false;
  const replacing = (wanted, tx) => wanted === true || (wanted !== null && decodeFunctionData({ abi: chainAbi, data: tx.data }).functionName === wanted);
  /**
   * What the contracts make of a sent transaction: an approval is recorded against its NFT, a creation registers the vault
   * it predicted, and a vault's resume or pause (2026-09-25) flips its policy's paused flag.
   */
  function apply(tx, transactionHash = null) {
    const to = String(tx.to).toLowerCase();
    const vault = vaults.get(to);
    if (vault) {
      const { functionName, args } = decodeFunctionData({ abi: chainAbi, data: tx.data });
      if (functionName === 'resume' || functionName === 'pause') { vault.policy = { ...(vault.policy ?? policy), paused: functionName === 'pause' }; vault.nonce += 1n; }
      // 2026-10-02: the vault pays a fee reserve to its owner (contracts/src/DominoVaultV4.sol withdrawFeeReserves), and
      // records it: FeeReservesWithdrawn(sourceId, currency, owner, original, charged, the state nonce it moved to).
      if (functionName === 'withdrawFeeReserves') {
        const out = withdrawn(vault, args);
        if (!out) throw new Error('a withdrawal the vault refuses was sent');
        vault.balances.set(out.key, out.left); vault.nonce += 1n; withdrawals.push({ vault: to, args });
        vaultLogs.push({ address: to, topics: [RESERVES_WITHDRAWN, String(args[0]).toLowerCase(), padded(args[1]), padded(owner)],
          data: `0x${[args[2], args[3], vault.nonce].map((value) => word(value).slice(2)).join('')}`, blockNumber: '0x10', blockHash: at(0xbb, 32),
          transactionHash: transactionHash ?? at(0xfe, 32), logIndex: numberToHex(vaultLogs.length), removed: false });
      }
      return;
    }
    if (to !== deployment.positionManager && to !== deployment.factory) return;
    const { functionName, args } = decodeFunctionData({ abi: chainAbi, data: tx.data });
    if (to === deployment.positionManager && functionName === 'approve' && !lostApproval) approvals.set(args[1], String(args[0]).toLowerCase());
    if (to === deployment.factory && functionName === 'createVault') {
      const [params, nonce] = args, { id, vault } = identity(nonce);
      vaults.set(vault, { id, root: params.rootTokenId, chain: [], policy: params.policy, limits: params.limits, nonce: 1n, valid: Array.isArray(rootPermissionValid) ? true : rootPermissionValid, balances: new Map() });
    }
  }
  /**
   * A batch (EIP-5792) as a wallet that executes it atomically: `atomic` is what the wallet says of chain 4663, `batchError`
   * its answer to the first batch it is offered, `holdBatch` that batch taken and held unsent (status 100, which a test may
   * change, or mark `forgotten`: an id the wallet no longer knows), and `simulation: 'unsupported'` a wallet without
   * eth_simulateV1. The factory creates only at the owner's next nonce, and only a vault its root NFT is approved to; each
   * call is checked in turn, and one that fails undoes them all.
   */
  const batches = [], withdrawals = [], vaultLogs = [];
  let capability = atomic, refuseBatch = batchError, hold = holdBatch;
  // 2026-10-02 (review of the fee withdrawal): the vault's own record of each withdrawal, and the vaults whose reads fail.
  const RESERVES_WITHDRAWN = keccak256(stringToHex('FeeReservesWithdrawn(bytes32,address,address,uint128,uint128,uint64)'));
  const word = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
  const padded = (address) => `0x${String(address).slice(2).toLowerCase().padStart(64, '0')}`;
  const failing = new Set();
  function batchResults(calls) {
    const created = new Map(), approvedHere = new Map(), paidHere = new Map();
    let failed = false;
    const results = calls.map(call => {
      if (failed) return { status: '0x0', gasUsed: '0x0' };
      const to = String(call.to).toLowerCase(), { functionName, args } = decodeFunctionData({ abi: chainAbi, data: call.data });
      // 2026-10-02: a vault's fee withdrawals, each against what the earlier ones of the batch left.
      const vault = vaults.get(to);
      if (vault && functionName === 'withdrawFeeReserves') {
        const out = withdrawn(vault, args, new Map([...vault.balances, ...(paidHere.get(to) ?? new Map())]));
        if (!out) { failed = true; return { status: '0x0', gasUsed: '0x0' }; }
        paidHere.set(to, new Map([...(paidHere.get(to) ?? new Map()), [out.key, out.left]]));
        return { status: '0x1', gasUsed: '0xea60' };
      }
      const ok = to === deployment.positionManager && functionName === 'approve' ? true
        : to === deployment.factory && functionName === 'createVault'
          ? args[1] === BigInt(vaults.size + created.size) && (approved || approvedHere.get(args[0].rootTokenId) === predict(args[1]) || approvals.get(args[0].rootTokenId) === predict(args[1]))
          : false;
      if (!ok) { failed = true; return { status: '0x0', gasUsed: '0x0' }; }
      if (functionName === 'approve') approvedHere.set(args[1], String(args[0]).toLowerCase());
      if (functionName === 'createVault') created.set(args[1], true);
      return { status: '0x1', gasUsed: '0x30d40' };
    });
    return { results, ok: !failed };
  }
  async function request(method, params) {
    log.push(method);
    try {
      if (method === 'wallet_getCapabilities') return { result: capability ? { '0x1237': { atomic: { status: capability } } } : {} };
      if (method === 'eth_simulateV1') {
        if (simulation === 'unsupported') return { error: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } };
        return { result: [{ calls: batchResults(params[0].blockStateCalls[0].calls).results }] };
      }
      if (method === 'wallet_sendCalls') {
        if (refuseBatch) { const error = refuseBatch; refuseBatch = null; return { error }; }
        const [{ version, chainId, from, atomicRequired, calls }] = params;
        const id = `0x${(0x5eba7 + batches.length).toString(16)}`;
        if (hold) {
          hold = false;
          batches.push({ id, version, chainId, from, atomicRequired, calls, status: 100 });
          return { result: { id } };
        }
        const { ok } = batchResults(calls);
        // The one transaction the wallet carried the batch in (2026-10-02): its receipts name it, and so does the vault's record.
        const transactionHash = at(0xf0 + batches.length, 32);
        if (ok) for (const call of calls) apply({ to: call.to, data: call.data }, transactionHash);
        batches.push({ id, version, chainId, from, atomicRequired, calls, status: ok ? 200 : 500, transactionHash });
        if (ok && capability === 'ready') capability = 'supported';
        return { result: { id } };
      }
      if (method === 'wallet_getCallsStatus') {
        const batch = batches.find(entry => entry.id === params[0] && !entry.forgotten);
        const receipts = batch?.status === 200 && batch.transactionHash && !batch.unnamed ? [{ transactionHash: batch.transactionHash, status: '0x1', blockNumber: '0x10', blockHash: at(0xbb, 32) }] : [];
        return batch ? { result: { version: '2.0.0', id: batch.id, chainId: '0x1237', status: batch.status, atomic: true, receipts } } : { error: { code: 5730, message: 'Unknown bundle id' } };
      }
      if (method === 'eth_getBlockByNumber') return { result: { number: '0x10', hash: at(0xbb, 32) } };
      // A suite that routes these here keeps them off the mock wallet, which
      // refuses anything outside its login set and fails the scenario's close.
      if (method === 'eth_getTransactionCount') return { result: numberToHex(sends.length + burned) };
      if (method === 'eth_estimateGas') return { result: '0x186a0' };
      if (method === 'eth_getBalance') return { result: balance };
      if (method === 'eth_gasPrice') return { result: '0x5f5e100' };
      if (method === 'eth_sendTransaction') {
        if (refuseNext) { refuseNext = false; return { error: { code: 4001, message: 'User rejected the request.' } }; }
        if (dropNext) { dropNext = false; return { error: { code: -32603, message: 'The wallet connection ended before it answered.' } }; }
        if (replacing(cancelNext, params[0])) { cancelNext = null; burned += 1; const effect = cancelEffect; cancelEffect = null; effect?.(); return { result: at(0xd0 + burned, 32) }; }
        const index = sends.length; sends.push(params[0]); apply(params[0], hashOf(index));
        if (replacing(speedNext, params[0])) { speedNext = null; return { result: at(0xe0 + index, 32) }; }
        return { result: hashOf(index) };
      }
      if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') {
        const index = sends.findIndex((_, i) => hashOf(i) === String(params[0]).toLowerCase());
        if (index === -1) return { result: null };
        // 2026-10-01 (audit C14): a node knows a transaction still pending by its hash (no block yet); only its receipt waits.
        if (!included) {
          const sent = sends[index];
          return { result: method === 'eth_getTransactionByHash' ? { hash: hashOf(index), from: sent.from, to: sent.to, input: sent.data, value: sent.value, nonce: sent.nonce, blockHash: null, blockNumber: null } : null };
        }
        const sent = sends[index], hash = hashOf(index);
        const block = { blockHash: at(0xbb, 32), blockNumber: '0x10' };
        if (method === 'eth_getTransactionByHash') return { result: { hash, from: sent.from, to: sent.to, input: sent.data, value: sent.value, nonce: sent.nonce, chainId: sent.chainId, type: sent.type,
          gas: sent.gas, maxFeePerGas: sent.maxFeePerGas, maxPriorityFeePerGas: sent.maxPriorityFeePerGas, ...block, ...included.transaction } };
        return { result: { transactionHash: hash, from: sent.from, to: sent.to, status: '0x1', gasUsed: '0xc350', effectiveGasPrice: sent.maxFeePerGas, ...block, ...included.receipt } };
      }
      if (method === 'eth_getCode') {
        const target = String(params[0]).toLowerCase();
        return { result: codeOf.get(target) ?? (vaults.has(target) ? cloneOf(implementation) : [poolKey.currency0, poolKey.currency1].includes(target) ? '0x6000' : '0x') };
      }
      // 2026-10-02 (review of the fee withdrawal): the vaults' own records, as the chain RPC answers a log filter.
      if (method === 'eth_getLogs') {
        const [filter] = params, refusal = logLimitError(filter);
        if (refusal) return { error: refusal };
        const from = BigInt(filter.fromBlock), to = BigInt(filter.toBlock);
        const fits = (value, wanted) => wanted === null || wanted === undefined || (Array.isArray(wanted) ? wanted.map((one) => String(one).toLowerCase()).includes(value) : String(wanted).toLowerCase() === value);
        return { result: vaultLogs.filter((log) => fits(log.address, filter.address) && BigInt(log.blockNumber) >= from && BigInt(log.blockNumber) <= to
          && (filter.topics ?? []).every((wanted, place) => fits(log.topics[place], wanted))) };
      }
      if (method === 'eth_call' && failing.has(String(params[0].to).toLowerCase())) return { error: { code: -32000, message: 'header not found' } };
      if (method === 'eth_call') {
        const { functionName, args = [] } = decodeFunctionData({ abi: chainAbi, data: params[0].data });
        if (['createVault', 'setPolicy'].includes(functionName)) simulations.push({ functionName, args });
        return { result: encodeFunctionResult({ abi: chainAbi, functionName, result: answer(String(params[0].to).toLowerCase(), functionName, args) }) };
      }
      refused.push(method);
      return { error: { code: 4200, message: `${method} is not a read` } };
    } catch (error) {
      missing.push(String(error));
      return { error: { code: -32000, message: String(error) } };
    }
  }
  return { log, missing, refused, sends, simulations, batches, withdrawals, request, include, predict, poolKey, poolId, policy, limits, vaults: [...vaults.keys()], release: { contractVersion: '1.0.0-rc.1', chainId: 4663, available: true, deployment },
    // 2026-10-02: the fees booked on a vault's sources now, a fee source's id, and the wallet refusing or losing the next send.
    balanceOf: (nonce, tokenId, source, currency) => vaults.get(identity(nonce).vault).balances.get(balanceKey(sourceOf(BigInt(tokenId), source), currency === 'base' ? at(0x61) : at(0x62))) ?? { original: 0n, charged: 0n },
    sourceOf, refuseNextSend: () => { refuseNext = true; }, dropNextSend: () => { dropNext = true; },
    // 2026-10-01 (audit C14): the person speeds the next send (of `name`) up, or cancels it, in the wallet; the nonces cancels took.
    speedUpNext: (name = true) => { speedNext = name; }, cancelNextInWallet: (name = true, effect = null) => { cancelNext = name; cancelEffect = effect; }, burned: () => burned,
    // 2026-10-02 (review of the fee withdrawal): an operator execution that spends or credits fees, with no withdrawal; the
    // vaults' own records; a vault whose reads fail.
    automationRun: (nonce, lines) => {
      const vault = vaults.get(identity(nonce).vault);
      for (const line of lines) vault.balances.set(balanceKey(sourceOf(BigInt(line.tokenId), line.source), line.currency === 'base' ? at(0x61) : at(0x62)), { original: BigInt(line.original), charged: BigInt(line.charged ?? 0n) });
      vault.nonce += 1n;
    },
    vaultLogs, failVaultReads: (nonce, on = true) => { const vault = identity(nonce).vault; if (on) failing.add(vault); else failing.delete(vault); },
    holdNext: () => { hold = true; }, simulate: calls => batchResults(calls).results };
}

test('Start tracking is offered for the sequences the wallet lists, reads each one\'s positions from its vault, and sends enroll with the session: nothing typed, nothing signed', V1_HISTORY, async () => {
  const s = await scenario();
  const chain = fakeSequenceChain(OWNER, { roots: [100n, 200n], chains: { 0: [{ id: 11n, active: true }, { id: 12n, active: false }] } });
  // The mock wallet answers only login methods, so chain reads reach this fake chain; a wallet method outside both is still refused and fails the run.
  await s.context.exposeFunction('__dominoChainRead', (method, params) => chain.request(method, params));
  await s.context.addInitScript(() => {
    // Whichever runs first, this script or the wallet binding, the binding is kept for everything but the three chain reads.
    let wallet = window.__dominoWalletRequest;
    const request = (id, method, params) => ['eth_call', 'eth_getCode', 'eth_getBlockByNumber'].includes(method) ? window.__dominoChainRead(method, params) : wallet(id, method, params);
    Object.defineProperty(window, '__dominoWalletRequest', { configurable: true, get: () => request, set: value => { wallet = value; } });
  });
  const enrolls = [];
  await s.context.route(/\/api\/performance\/v2\/enroll$/, async route => {
    const request = route.request(), body = request.postDataJSON(), answer = fixture('responses/enroll');
    enrolls.push({ body, csrf: request.headers()['x-domino-csrf'] ?? null, method: request.method() });
    Object.assign(answer, { owner: OWNER, enrollment: { ...answer.enrollment, vault: body.vault, tokenIds: body.tokenIds } });
    assert.ok(runtime.validateResponse('enroll', answer));
    await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', headers: { 'X-Domino-Performance-Contract': runtime.CONTRACT_VERSION }, body: JSON.stringify(answer) });
  });
  try {
    await login(s.page);
    const history = s.page.locator('section[aria-label="Private performance"]');
    await s.page.locator('section[data-sequences="unavailable"][data-sequences-reason="no_deployment"]').waitFor();
    assert.equal(await history.locator('[data-track-sequences]').count(), 0, 'without a deployment there is nothing to offer, and nothing says so');
    assert.equal(await history.locator('input').count(), 0, 'no typed vault address or position IDs');
    assert.equal(chain.log.length, 0, 'nothing is read from the chain without a deployment');

    s.set({ sequenceRelease: { status: 200, body: chain.release } });
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    const track = history.locator('[data-track-sequences]');
    await track.waitFor();
    const rows = track.locator('[data-trackable-sequence]');
    assert.deepEqual(await rows.evaluateAll(items => items.map(item => item.getAttribute('data-trackable-sequence'))), [chain.vaults[1], chain.vaults[0]], 'newest first');
    // Changed on purpose (owner, 2026-09-27, round 5; then its review: no address on the main screen): the row names its
    // position, and the automation's address is only the row's title.
    assert.match(await rows.nth(0).innerText(), /^Position #200\s+Start tracking$/);
    assert.equal(await rows.nth(0).getAttribute('title'), chain.vaults[1]);
    assert.doesNotMatch(await history.innerText(), /0x[0-9a-f]{4}/, 'no address in sight');
    assert.equal(await history.locator('input').count(), 0, 'every sequence is listed, so nothing is typed');
    assert.doesNotMatch(await history.innerText(), FORBIDDEN);
    await noManualReads(history);

    const row = track.locator(`[data-trackable-sequence="${chain.vaults[0]}"]`);
    await row.getByRole('button', { name: 'Start tracking', exact: true }).click();
    // Changed on purpose (2026-09-27, round 5 review): the outcome in plain words ("observation" and "collection" were for engineers).
    await row.locator('[data-enrollment-outcome="sent"]').getByText('Tracking requested. Its figures show here once they are first read.', { exact: true }).waitFor();
    assert.deepEqual(enrolls, [{ body: { vault: chain.vaults[0], tokenIds: ['100', '11'] }, csrf: enrolls[0]?.csrf, method: 'POST' }], 'the vault and its complete active set: the root and the successor it still holds');
    assert.ok(enrolls[0].csrf, 'sent with the session CSRF');
    assert.equal(await row.getByRole('button', { name: 'Start tracking' }).count(), 0, 'sent: not offered again');
    await s.page.screenshot({ path: join(shots(), 'p2-track-sequences.png'), fullPage: true });
    assert.deepEqual([...new Set(chain.log)].sort(), ['eth_call', 'eth_getBlockByNumber', 'eth_getCode'], 'the chain was only read');
    assert.deepEqual([...new Set(s.wallet.state.log.map(entry => entry.method))].filter(method => !['eth_accounts', 'eth_chainId', 'eth_requestAccounts', 'personal_sign', 'wallet_requestPermissions', 'wallet_switchEthereumChain'].includes(method)), []);
    assert.equal(s.wallet.state.signed.length, 1, 'only the login signature: Start tracking is not a wallet transaction');
  } finally { await s.close(); }
});

// Added 2026-09-27 (round 5 review): the owner's own case, a wallet whose position already runs Auto-compound and that nothing
// tracks yet. Managed positions must not tell him to turn Auto-compound on right above the Start tracking that offers his
// automation; and once tracking is asked for, the row that waits for its first figures is named by its position, never by
// the automation's address, and the position is not named a second time under Track your automations.
test('with an automation the wallet owns and nothing tracked, Managed positions points at Start tracking; a position waiting for its first figures is named by its position, once, with no address in sight', V1_HISTORY, async () => {
  const s = await scenario();
  const chain = fakeSequenceChain(OWNER, { roots: [3325113n] });
  await s.context.exposeFunction('__dominoChainRead', (method, params) => chain.request(method, params));
  await s.context.addInitScript(() => {
    // Whichever runs first, this script or the wallet binding, the binding is kept for everything but the three chain reads.
    let wallet = window.__dominoWalletRequest;
    const request = (id, method, params) => ['eth_call', 'eth_getCode', 'eth_getBlockByNumber'].includes(method) ? window.__dominoChainRead(method, params) : wallet(id, method, params);
    Object.defineProperty(window, '__dominoWalletRequest', { configurable: true, get: () => request, set: value => { wallet = value; } });
  });
  // The history service tracks nothing for this wallet at first; then it lists one position waiting for its first figures.
  let enrollments = [];
  await s.context.route(/\/api\/performance\/v2\/epochs$/, async route => {
    const answer = { ...fixture('responses/epochs'), owner: OWNER, enrollments };
    assert.ok(runtime.validateResponse('epochs', answer), 'the epochs answer is valid');
    await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', headers: { 'X-Domino-Performance-Contract': runtime.CONTRACT_VERSION }, body: JSON.stringify(answer) });
  });
  try {
    await login(s.page);
    s.set({ sequenceRelease: { status: 200, body: chain.release } });
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    const history = s.page.locator('section[aria-label="Private performance"]');
    const track = history.locator('[data-track-sequences]');
    await track.waitFor();
    assert.equal(await history.locator('.dm-acct-plot').innerText(), 'Nothing tracked yet: press Start tracking below.');
    assert.doesNotMatch(await history.innerText(), /Turn on Auto-compound/, 'never told to turn on what is already on');
    const offered = track.locator('[data-trackable-sequence]');
    assert.equal(await offered.count(), 1);
    assert.match(await offered.innerText(), /^Position #3325113\s+Start tracking$/);
    assert.equal(await offered.getAttribute('title'), chain.vaults[0], 'the automation’s address is only the row’s title');
    assert.doesNotMatch(await history.innerText(), /0x[0-9a-f]{4}|Automation 0x|vault|sequence/i, 'no address or engineer’s word in sight');
    await shootBoth(s.page, 'managed-track', s.page.locator('.dm-acct-pair'));

    // Tracking asked for: the service lists the position, waiting for its first figures.
    enrollments = [{ enrollmentId: '0x' + '12'.repeat(32), vault: chain.vaults[0], tokenIds: ['3325113'], epochId: null, status: 'queued', reason: 'awaiting_baseline', updatedAt: 87410 }];
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    const waiting = history.locator('[data-enrollment-status="queued"]');
    await waiting.waitFor();
    assert.equal(await waiting.locator('.dm-mp-name').innerText(), 'Position #3325113');
    assert.equal(await waiting.locator('.dm-mp-name').getAttribute('href'), '/positions/3325113', 'it opens its position, as a tracked row does');
    assert.equal(await waiting.getAttribute('title'), chain.vaults[0], 'the automation’s address is only the row’s title');
    assert.deepEqual([await waiting.locator('.dm-acct-status').innerText(), await waiting.locator('.dm-acct-note').innerText()], ['Tracking requested', 'Waiting for its first figures.']);
    // Its only automation is tracked now: the row above says so, and Track your automations is left out rather than naming it twice.
    await s.page.locator('section[aria-label="Private performance"][data-sequences="ready"]').waitFor();
    assert.equal(await track.count(), 0, 'the position is not named twice');
    assert.equal(await history.locator('.dm-acct-plot').count(), 0, 'no empty sentence beside the waiting position');
    const text = await history.innerText();
    assert.doesNotMatch(text, /0x[0-9a-f]{4}|vault|sequence|observation|canonical|collection/i, 'no address or engineer’s word in sight');
    assert.doesNotMatch(text, FORBIDDEN);
    await noManualReads(history);
    await shootBoth(s.page, 'managed-waiting', s.page.locator('.dm-acct-pair'));
    assert.equal(s.wallet.state.signed.length, 1, 'only the login signature');
  } finally { await s.close(); }
});

// ---- The automation page (the owner's simpler page, 2026-09-24): the wallet's open positions, one action, two wallet steps ----
//
// Changed on purpose (owner, 2026-09-24): the Owner controls, Network budget, Create a paused sequence and Manage a sequence cards,
// every typed NFT id or address, and the review wall are gone, and so are the tests that drove them (operator restoration, rule and
// limit changes, repairs, recoveries, the receipt check button and activation readiness). finance/sequence.ts keeps that logic,
// unchanged. What is left is one guided card: pick a position, a mode, the quote currency, keep the limits, consent, and press Set up
// automation, which runs the approval and the paused creation through the same client, each read back by hash.
//
// The positions arrive from useWalletPositions (lib/walletPositions.ts: the page's own read of the chain since 2026-09-25,
// tested at the end of this file); these tests inject them through the test-only lab route (#/sequence-lab/<spec>, App.tsx
// behind __DOMINO_TEST_HOOKS__), as the hook would.

/** A position as useWalletPositions answers it, in the fake chain's pool. The symbols are what the page shows, never the addresses. */
const walletPosition = (chain, tokenId, patch = {}) => ({
  tokenId: String(tokenId), status: 'open', poolId: chain.poolId,
  currencies: [{ address: chain.poolKey.currency0, symbol: 'AAA', decimals: 18 }, { address: chain.poolKey.currency1, symbol: 'BBB', decimals: 6 }],
  fee: 3000, tickSpacing: 60, hooks: zeroAddress, tickLower: -60, tickUpper: 60, liquidity: '1000', sqrtPriceX96: null, tick: 0, unclaimedFees: null, principal: null, ...patch,
});
const labHash = (spec) => `#/sequence-lab/${encodeURIComponent(JSON.stringify(spec))}`;
/** Everything the sequence client and the gas suggestion ask of the wallet, past connecting. */
const CHAIN_METHODS = ['eth_call', 'eth_getCode', 'eth_getBlockByNumber', 'eth_gasPrice', 'eth_getTransactionCount', 'eth_estimateGas', 'eth_getBalance', 'eth_sendTransaction', 'eth_getTransactionByHash', 'eth_getTransactionReceipt'];

/** Sends `methods` to the fake chain (or to `answer`), keeping every other wallet method on the mock wallet, which refuses what it does not know. */
async function routeChain(s, chain, methods, answer = (method, params) => chain.request(method, params)) {
  await s.context.exposeFunction('__dominoChainRead', answer);
  await s.context.addInitScript((names) => {
    // Whichever runs first, this script or the wallet binding, the binding is kept for everything but the chain's methods.
    let wallet = window.__dominoWalletRequest;
    const request = (id, method, params) => names.includes(method) ? window.__dominoChainRead(method, params) : wallet(id, method, params);
    Object.defineProperty(window, '__dominoWalletRequest', { configurable: true, get: () => request, set: value => { wallet = value; } });
  }, methods);
}

/** Connected on Robinhood Chain and no further: Sign in is offered and never pressed. */
async function connectOnly(page) {
  await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
  await page.locator('header [aria-haspopup="dialog"]').click();
  await page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Connect Test Wallet A', exact: true }).click();
  await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
  await page.keyboard.press('Escape');
}

/** The wallet methods a batch (EIP-5792) takes, routed to the fake chain beside CHAIN_METHODS. */
const BATCH_METHODS = ['wallet_getCapabilities', 'eth_simulateV1', 'wallet_sendCalls', 'wallet_getCallsStatus'];

/** A link naming the mode and the position, with the release published: the quote currency 0 chosen, consent ticked, Set up automation pressed (unless `press` is false). */
async function setUpFromLink(s, chain, { mode = 'compound', tokenId = '5', press = true } = {}) {
  s.set({ sequenceRelease: { status: 200, body: chain.release } });
  await s.page.goto(`${s.origin}/${labHash({ positions: [walletPosition(chain, tokenId)], mode, tokenId })}`);
  await s.page.reload();
  const card = s.page.locator('[data-sequence-create]');
  await card.waitFor({ timeout: 30_000 });
  await card.getByRole('radiogroup', { name: 'Quote currency' }).getByRole('radio', { name: 'AAA', exact: true }).click();
  await card.getByRole('checkbox', { name: /^I consent to using this NFT’s already uncollected fees/ }).check();
  if (press) await card.getByRole('button', { name: 'Set up automation', exact: true }).click();
  return card;
}

test('with no wallet the page asks to connect; connected, the wallet’s own positions are the only way in, and with none open it points to New position, reading nothing from the chain', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [] });
  await routeChain(s, chain, CHAIN_METHODS);
  // The wallet's positions, as the page reads them from the public RPC (2026-09-25): the scenario's empty chain, none.
  try {
    s.set({ sequenceRelease: { status: 200, body: chain.release } });
    await s.page.goto(`${s.origin}/#/sequence/compound/5`);
    await s.page.reload();
    const main = s.page.locator('main');
    const connect = main.locator('[data-sequence-wallet="none"]');
    await connect.getByText('Connect your wallet', { exact: true }).waitFor();
    await connect.getByRole('button', { name: 'Connect wallet', exact: true }).click();
    const dialog = s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
    await dialog.getByRole('button', { name: 'Connect Test Wallet A', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
    await s.page.keyboard.press('Escape');
    const empty = main.locator('[data-sequence-positions="empty"]');
    await empty.getByText('No open positions', { exact: true }).waitFor();
    assert.equal(await empty.getByRole('link', { name: 'New position' }).getAttribute('href'), '/new');
    assert.equal(await main.locator('input').count(), 0, 'no NFT id or address is ever typed');
    const text = await main.innerText();
    assert.doesNotMatch(text, /Owner controls|Network budget|Create a paused sequence|Manage a sequence|Root NFT|Read my sequences|Sequence address/i);
    assert.doesNotMatch(text, FORBIDDEN);
    // Changed on purpose 2026-09-28 (speed wave B, item 23): a wallet that never opened a setup operation (its nonce, read
    // with the head in the list's first call) has no position. Changed on purpose (RPC-SPEC, 2026-10-01): the list is the
    // site's route, asked once; what it reads of the chain for it is the route's own (tests/chain-routes.test.mjs).
    assert.equal(s.rpc.edgeLog.filter((path) => path === '/api/owned/v2/positions').length, 1, 'the positions are read once, through the site’s route');
    assert.deepEqual(chain.log, [], 'nothing is read from the chain by opening the page');
    assert.deepEqual(chain.sends, []);
    assert.equal(s.wallet.state.signed.length, 0, 'no sign-in signature');
  } finally { await s.close(); }
});

// 2026-10-01 (audit C1, the owner's OK): Automate's "Switch network" says how the switch ended, in the wallet dialog's
// words, and adds Robinhood Chain to a wallet that does not have it; it used to drop the outcome and show nothing.
test('a wallet on another network at Automate: Switch network says a refusal, then adds Robinhood Chain and the wallet’s positions are read', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [] });
  await routeChain(s, chain, CHAIN_METHODS);
  try {
    s.set({ sequenceRelease: { status: 200, body: chain.release } });
    await s.page.goto(`${s.origin}/#/sequence/compound/5`);
    await s.page.reload();
    const main = s.page.locator('main');
    await main.locator('[data-sequence-wallet="none"]').getByRole('button', { name: 'Connect wallet', exact: true }).click();
    const dialog = s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
    await dialog.getByRole('button', { name: 'Connect Test Wallet A', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
    await s.page.keyboard.press('Escape');
    await main.locator('[data-sequence-positions="empty"]').waitFor();

    // The person moves the wallet to a network, and Robinhood Chain is not among the wallet's own.
    s.wallet.forgetChain('a', 4663);
    await s.wallet.switchChain('a', 1);
    const elsewhere = main.locator('[data-sequence-wallet="other-network"]');
    await elsewhere.getByText('Switch to Robinhood Chain', { exact: true }).waitFor();
    const button = elsewhere.getByRole('button', { name: 'Switch network', exact: true });
    s.wallet.rejectNext('a', 'wallet_addEthereumChain');
    await button.click();
    const notice = elsewhere.locator('[data-sequence-switch-notice]');
    await notice.waitFor();
    assert.equal(await notice.innerText(), 'Your wallet declined adding Robinhood Chain.');
    assert.equal(await button.isEnabled(), true, 'pressed again whenever the person is ready');

    await button.click();
    await main.locator('[data-sequence-positions="empty"]').waitFor({ timeout: 10_000 });
    assert.equal(s.wallet.wallet('a').chainId, 4663);
    assert.deepEqual(s.wallet.added('a').map((params) => [params.chainId, params.chainName, params.rpcUrls[0]]), [['0x1237', 'Robinhood Chain', 'https://rpc.mainnet.chain.robinhood.com']]);
    assert.deepEqual(s.wallet.state.log.filter((entry) => /^wallet_(switch|add)EthereumChain$/.test(entry.method)).map((entry) => entry.method),
      ['wallet_switchEthereumChain', 'wallet_addEthereumChain', 'wallet_switchEthereumChain', 'wallet_addEthereumChain']);
    assert.deepEqual(chain.sends, []);
    assert.equal(s.wallet.state.signed.length, 0, 'no sign-in signature');
  } finally { await s.close(); }
});

test('a failed wallet read at Set up automation is named without its provider reply, and nothing is sent or signed', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [] });
  const privateReply = 'private-provider-reply SECRET_CALLDATA_0xdeadbeef';
  await routeChain(s, chain, ['eth_call', 'eth_getCode', 'eth_getBlockByNumber', 'eth_gasPrice'], (method, params) => {
    if (method === 'eth_getCode') throw new Error(privateReply);
    return chain.request(method, params);
  });
  try {
    await connectOnly(s.page);
    const card = await setUpFromLink(s, chain);
    const notice = card.locator('[data-notice-code="sequence_read_code"]');
    await notice.waitFor({ timeout: 30_000 });
    assert.equal(await notice.innerText(), 'The wallet could not read deployed contract code. Check its RPC connection, then press Set up automation again.');
    assert.equal(await card.locator('[data-wallet-step="approve-root"]').getAttribute('data-step-state'), 'failed');
    assert.doesNotMatch(await s.page.locator('main').innerText(), /SECRET_CALLDATA|deadbeef/);
    assert.deepEqual(chain.sends, [], 'no wallet transaction was requested');
    assert.equal(s.wallet.state.signed.length, 0, 'no sign-in signature was requested');
  } finally { await s.close(); }
});

test('a rejected contract read at Set up automation exposes only the closed function stage', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [] });
  const privateReply = 'private-provider-reply SECRET_CALLDATA_0xdeadbeef';
  const attempts = [];
  await routeChain(s, chain, ['eth_call', 'eth_getCode', 'eth_getBlockByNumber', 'eth_gasPrice'], (method, params) => {
    if (method === 'eth_call' && params[0].data.startsWith(toFunctionSelector('nextOwnerNonce(address)'))) {
      attempts.push(params[1]);
      throw new Error(privateReply);
    }
    return chain.request(method, params);
  });
  try {
    await connectOnly(s.page);
    const card = await setUpFromLink(s, chain);
    const notice = s.page.locator('main [data-notice-code="sequence_read_call"]');
    await notice.waitFor({ timeout: 30_000 });
    assert.equal(await notice.getAttribute('data-notice-stage'), 'factory_next_owner_nonce');
    assert.ok(attempts.length >= 3, 'a persistent provider rejection exhausts the bounded retry');
    assert.equal(new Set(attempts.slice(0, 3)).size, 1, 'all attempts use the same pinned block');
    assert.doesNotMatch(await s.page.locator('main').innerText(), /SECRET_CALLDATA|deadbeef/);
    assert.equal(await card.getByRole('button', { name: 'Set up automation', exact: true }).isEnabled(), true, 'pressed again once the wallet recovers');
    assert.deepEqual(chain.sends, []);
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

test('isolated wallet rejections at the engine verification calls recover at the pinned block, and the setup carries on', async () => {
  // Approved already (the fake's default), so the creation is the one step the chain prepares.
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [], settled: true });
  const { engine } = chain.release.deployment;
  const selectors = { readHelperHash: toFunctionSelector('readHelperHash()'), priceGuard: toFunctionSelector('priceGuard()') };
  const attempts = { readHelperHash: [], priceGuard: [] };
  const codeAttempts = [];
  await routeChain(s, chain, CHAIN_METHODS, (method, params) => {
    if (method === 'eth_getCode' && params[0].toLowerCase() === engine.toLowerCase()) {
      codeAttempts.push(params[1]);
      if (codeAttempts.length === 1) throw new Error('private-provider-reply SECRET_CALLDATA_0xdeadbeef');
    }
    if (method === 'eth_call' && params[0].to.toLowerCase() === engine.toLowerCase()) {
      const name = Object.keys(selectors).find(key => params[0].data.startsWith(selectors[key]));
      if (name) {
        attempts[name].push(params[1]);
        if (attempts[name].length === 1) throw new Error('private-provider-reply SECRET_CALLDATA_0xdeadbeef');
      }
    }
    return chain.request(method, params);
  });
  try {
    await connectOnly(s.page);
    await setUpFromLink(s, chain);
    const main = s.page.locator('main');
    await main.locator(`[data-sequence-created="${chain.predict(0)}"]`).waitFor({ timeout: 60_000 });
    assert.ok(codeAttempts.length >= 2, 'the rejected bytecode read was retried');
    assert.equal(codeAttempts[0], codeAttempts[1], 'bytecode retry used the same pinned block');
    for (const name of Object.keys(selectors)) {
      assert.ok(attempts[name].length >= 2, `${name} was retried after one rejected read`);
      assert.equal(attempts[name][0], attempts[name][1], `${name} retry used the same pinned block`);
    }
    assert.equal(attempts.readHelperHash[0], attempts.priceGuard[0], 'both engine reads belong to one pinned verification');
    assert.equal(await main.locator('[data-notice-code]').count(), 0);
    assert.doesNotMatch(await main.innerText(), /SECRET_CALLDATA|deadbeef/);
    assert.deepEqual(chain.sends.map(tx => decodeFunctionData({ abi: chainAbi, data: tx.data }).functionName), ['createVault'], 'approved already: only the creation is offered');
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

test('a wallet that executes batches atomically sets up automation with one signature: the root NFT’s approval and the paused creation in one batch', async () => {
  const s = await scenario();
  const chain = fakeSequenceChain(OWNER, { roots: [], approved: false, settled: true, atomic: 'supported' });
  const { factory, positionManager } = chain.release.deployment, vault = chain.predict(0);
  await routeChain(s, chain, [...CHAIN_METHODS, ...BATCH_METHODS]);
  try {
    await connectOnly(s.page);
    const card = await setUpFromLink(s, chain, { press: false });
    await card.locator('#sequence-reason', { hasText: 'Your wallet asks you to sign once: the approval and the sequence together.' }).waitFor({ timeout: 30_000 });
    assert.equal(await card.locator('[data-sequence-batch]').count(), 0, 'nothing to choose: the batch needs no upgrade');
    await card.getByRole('button', { name: 'Set up automation', exact: true }).click();
    await s.page.locator(`[data-sequence-created="${vault}"]`).waitFor({ timeout: 60_000 });
    assert.deepEqual(chain.sends, [], 'no transaction of its own: the wallet was asked for one batch');
    assert.equal(chain.batches.length, 1);
    const [batch] = chain.batches;
    assert.deepEqual([batch.version, batch.chainId, batch.from.toLowerCase(), batch.atomicRequired, batch.status], ['2.0.0', '0x1237', OWNER, true, 200]);
    const calls = batch.calls.map(call => ({ to: call.to.toLowerCase(), ...decodeFunctionData({ abi: chainAbi, data: call.data }) }));
    assert.deepEqual(calls.map(call => [call.to, call.functionName]), [[positionManager, 'approve'], [factory, 'createVault']]);
    assert.deepEqual([calls[0].args[0].toLowerCase(), calls[0].args[1]], [vault, 5n], 'only NFT #5, to the predicted sequence');
    assert.deepEqual([calls[1].args[0].rootTokenId, calls[1].args[1], calls[1].args[0].policy.paused], [5n, 0n, true], 'the paused creation at the owner’s next nonce');
    assert.ok(chain.log.includes('eth_simulateV1') && chain.log.indexOf('eth_simulateV1') < chain.log.indexOf('wallet_sendCalls'), 'simulated whole before the wallet was asked');
    assert.deepEqual(await s.page.locator('[data-wallet-step]').evaluateAll(items => items.map(item => [item.getAttribute('data-wallet-step'), item.getAttribute('data-step-state')])), [['batch', 'done']]);
    assert.deepEqual([chain.missing, chain.refused], [[], []]);
  } finally { await s.close(); }
});

test('a wallet that can batch once it turns on its smart account sets up automation step by step, with one signature offered beside it; declined, nothing is sent, and asked again it sets up automation in one batch', async () => {
  // Set up automation itself stays step by step for it: the upgrade is the person's choice, never the page's.
  let s = await scenario();
  let chain = fakeSequenceChain(OWNER, { roots: [], approved: false, settled: true, atomic: 'ready' });
  await routeChain(s, chain, [...CHAIN_METHODS, ...BATCH_METHODS]);
  try {
    await connectOnly(s.page);
    const card = await setUpFromLink(s, chain, { press: false });
    await card.locator('[data-sequence-batch="offer"]').waitFor({ timeout: 30_000 });
    await card.getByRole('button', { name: 'Set up automation', exact: true }).click();
    await s.page.locator(`[data-sequence-created="${chain.predict(0)}"]`).waitFor({ timeout: 60_000 });
    assert.deepEqual(chain.batches, []);
    assert.deepEqual(chain.sends.map(tx => decodeFunctionData({ abi: chainAbi, data: tx.data }).functionName), ['approve', 'createVault']);
  } finally { await s.close(); }
  s = await scenario();
  chain = fakeSequenceChain(OWNER, { roots: [], approved: false, settled: true, atomic: 'ready', batchError: { code: 5750, message: 'Atomic-ready wallet rejected upgrade' } });
  const vault = chain.predict(0);
  await routeChain(s, chain, [...CHAIN_METHODS, ...BATCH_METHODS]);
  try {
    await connectOnly(s.page);
    const card = await setUpFromLink(s, chain, { press: false });
    const offer = card.locator('[data-sequence-batch="offer"]');
    await offer.waitFor({ timeout: 30_000 });
    assert.equal(await offer.innerText(), 'Sign both steps at once');
    // Changed on purpose (2026-09-28, beginner first): no "(EIP-7702)" on the main screen.
    assert.equal(await card.locator('#sequence-batch-note').innerText(), 'Your wallet will first ask to turn on its smart account. Your address stays the same, and your key stays in control.');
    assert.equal(await card.locator('#sequence-reason').innerText(), 'Your wallet asks you to approve the position, then to create the sequence.', 'the steps stay the main way');
    await offer.click();
    const notice = card.locator('[data-notice-code="batch_upgrade_declined"]');
    await notice.waitFor({ timeout: 30_000 });
    assert.equal(await notice.innerText(), 'You declined turning on your wallet’s smart account. Nothing was created. Press Set up automation to go step by step, or sign both steps at once again.');
    assert.deepEqual([chain.sends, chain.batches], [[], []]);
    await offer.click();
    await s.page.locator(`[data-sequence-created="${vault}"]`).waitFor({ timeout: 60_000 });
    assert.deepEqual(chain.sends, []);
    assert.deepEqual(chain.batches[0].calls.map(call => decodeFunctionData({ abi: chainAbi, data: call.data }).functionName), ['approve', 'createVault']);
  } finally { await s.close(); }
});

test('a batch the wallet still held when the page went away is not offered again; once the wallet says it did not include it, the next press offers a new one', async () => {
  const s = await scenario();
  const chain = fakeSequenceChain(OWNER, { roots: [], approved: false, settled: true, atomic: 'supported', holdBatch: true });
  const vault = chain.predict(0);
  await routeChain(s, chain, [...CHAIN_METHODS, ...BATCH_METHODS]);
  try {
    await connectOnly(s.page);
    await setUpFromLink(s, chain);
    await s.page.locator('[data-wallet-step="batch"][data-step-state="chain"]').waitFor({ timeout: 30_000 });
    assert.equal(chain.batches.length, 1);
    // The page goes away while the wallet holds the batch: the latch outlives it, and the press after asks the wallet first.
    const card = await setUpFromLink(s, chain);
    const waiting = card.locator('[data-notice-code="batch_already_offered"]');
    await waiting.waitFor({ timeout: 30_000 });
    assert.equal(await waiting.innerText(), 'A batch for this sequence is already waiting in your wallet. Check your wallet activity: nothing is sent twice.');
    assert.equal(chain.batches.length, 1, 'nothing offered twice while the wallet holds it');
    chain.batches[0].status = 400;
    await setUpFromLink(s, chain);
    await s.page.locator(`[data-sequence-created="${vault}"]`).waitFor({ timeout: 60_000 });
    assert.deepEqual(chain.batches.map(batch => batch.status), [400, 200], 'freed by the wallet’s answer, and offered anew');
    assert.deepEqual(chain.sends, []);
    assert.deepEqual([chain.missing, chain.refused], [[], []]);
  } finally { await s.close(); }
});

test('a sent batch is watched until the wallet says what became of it: each outcome has its sentence, one that cannot execute is shown failed, and the next press offers a new batch', async () => {
  const s = await scenario();
  const chain = fakeSequenceChain(OWNER, { roots: [], approved: false, settled: true, atomic: 'supported' });
  await routeChain(s, chain, [...CHAIN_METHODS, ...BATCH_METHODS]);
  try {
    await connectOnly(s.page);
    const card = await setUpFromLink(s, chain, { press: false });
    await card.locator('#sequence-reason', { hasText: 'sign once' }).waitFor({ timeout: 30_000 });
    for (const [outcome, code, state, text] of [
      [400, 'sequence_batch_dropped', 'failed', 'Your wallet did not include the batch. Press Set up automation again.'],
      [500, 'sequence_step_reverted', 'failed', 'The transaction reverted: nothing changed, only network gas was spent. Press Set up automation to try again.'],
      ['forgotten', 'sequence_batch_unknown', 'sent', 'The batch’s outcome could not be read. Check your wallet activity, then press Set up automation again: the chain is read first, and nothing is sent twice.'],
    ]) {
      chain.holdNext();
      await card.getByRole('button', { name: 'Set up automation', exact: true }).click();
      await s.page.locator('[data-wallet-step="batch"][data-step-state="chain"]').waitFor({ timeout: 30_000 });
      const batch = chain.batches.at(-1);
      if (outcome === 'forgotten') batch.forgotten = true;
      else batch.status = outcome;
      const notice = card.locator(`[data-notice-code="${code}"]`);
      await notice.waitFor({ timeout: 30_000 });
      assert.equal(await notice.innerText(), text);
      assert.equal(await s.page.locator('[data-wallet-step="batch"]').getAttribute('data-step-state'), state, `${outcome}: ${state}`);
    }
    await card.getByRole('button', { name: 'Set up automation', exact: true }).click();
    await s.page.locator(`[data-sequence-created="${chain.predict(0)}"]`).waitFor({ timeout: 60_000 });
    assert.deepEqual(chain.batches.map(batch => batch.forgotten ? 'forgotten' : batch.status), [400, 500, 'forgotten', 200], 'each one freed, and one batch created the sequence');
    assert.deepEqual(chain.sends, []);
    assert.deepEqual([chain.missing, chain.refused], [[], []]);
  } finally { await s.close(); }
});

// Changed on purpose (RPC-SPEC D7, 2026-10-01, the owner's rule: nothing is read from a public RPC): the site's own fixed
// simulate route in place of the chain's RPC. On (a deployment that turns it on), the batch is simulated there and signed
// once; off (the default), the same press goes step by step.
test('a sequence batch the wallet cannot simulate is simulated on the site’s simulate route when it is on; off, the same press goes step by step', async () => {
  for (const routeOn of [true, false]) {
    const s = await scenario();
    const chain = fakeSequenceChain(OWNER, { roots: [], approved: false, settled: true, atomic: 'supported', simulation: 'unsupported' });
    await routeChain(s, chain, [...CHAIN_METHODS, ...BATCH_METHODS]);
    if (routeOn) s.rpc.simulate = (params) => [{ calls: chain.simulate(params[0].blockStateCalls[0].calls) }];
    try {
      await connectOnly(s.page);
      const card = await setUpFromLink(s, chain, { press: false });
      await card.locator('#sequence-reason', { hasText: 'sign once' }).waitFor({ timeout: 30_000 });
      await card.getByRole('button', { name: 'Set up automation', exact: true }).click();
      await s.page.locator(`[data-sequence-created="${chain.predict(0)}"]`).waitFor({ timeout: 60_000 });
      assert.ok(s.rpc.edgeLog.includes('/api/chain/v1/simulate'), 'the site’s simulate route was asked');
      if (routeOn) {
        assert.deepEqual([chain.sends, chain.batches.length], [[], 1], 'simulated on the site’s route, and signed once');
      } else {
        assert.deepEqual(chain.batches, []);
        assert.deepEqual(chain.sends.map(tx => decodeFunctionData({ abi: chainAbi, data: tx.data }).functionName), ['approve', 'createVault'], 'no simulation: each step, as for any wallet');
      }
      assert.deepEqual([chain.missing, chain.refused], [[], []]);
    } finally { await s.close(); }
  }
});

test('a batch with the root already approved holds only the creation; a batch the wallet cannot make goes step by step in the same press', async () => {
  let s = await scenario();
  let chain = fakeSequenceChain(OWNER, { roots: [], approved: true, settled: true, atomic: 'supported' });
  await routeChain(s, chain, [...CHAIN_METHODS, ...BATCH_METHODS]);
  try {
    await connectOnly(s.page);
    const card = await setUpFromLink(s, chain, { press: false });
    await card.locator('#sequence-reason', { hasText: 'sign once' }).waitFor({ timeout: 30_000 });
    await card.getByRole('button', { name: 'Set up automation', exact: true }).click();
    await s.page.locator(`[data-sequence-created="${chain.predict(0)}"]`).waitFor({ timeout: 60_000 });
    assert.deepEqual(chain.batches[0].calls.map(call => decodeFunctionData({ abi: chainAbi, data: call.data }).functionName), ['createVault'], 'approved already: only the creation');
  } finally { await s.close(); }
  s = await scenario();
  chain = fakeSequenceChain(OWNER, { roots: [], approved: false, settled: true, atomic: 'supported', batchError: { code: 5760, message: 'Atomicity not supported' } });
  await routeChain(s, chain, [...CHAIN_METHODS, ...BATCH_METHODS]);
  try {
    await connectOnly(s.page);
    const card = await setUpFromLink(s, chain, { press: false });
    await card.locator('#sequence-reason', { hasText: 'sign once' }).waitFor({ timeout: 30_000 });
    await card.getByRole('button', { name: 'Set up automation', exact: true }).click();
    await s.page.locator(`[data-sequence-created="${chain.predict(0)}"]`).waitFor({ timeout: 60_000 });
    assert.deepEqual(chain.batches, []);
    assert.deepEqual(chain.sends.map(tx => decodeFunctionData({ abi: chainAbi, data: tx.data }).functionName), ['approve', 'createVault'], 'refused as unsupported: each step as for any wallet');
    assert.equal(chain.log.filter(method => method === 'wallet_sendCalls').length, 1, 'asked once, refused, never again');
  } finally { await s.close(); }
});

/**
 * SequenceCreate.tsx, driven the way a person reaches it: a position page's link naming the mode and the position, a wallet that is
 * connected and nothing more. The chain is the fake above with nothing approved and every send settled at once, so Set up automation
 * offers the approval first and the creation second, each receipt finalized on its first check. What the wallet was asked to sign is
 * decoded from the two transactions the chain recorded.
 */
test('from a position link, one press puts the NFT under Domino-compound: the approval, then the paused creation, each step turning green, with the defaults on the wire', async () => {
  const s = await scenario(), ROOT = 5n;
  const chain = fakeSequenceChain(OWNER, { roots: [], approved: false, settled: true });
  const { factory, positionManager, operator } = chain.release.deployment, vault = chain.predict(0);
  await routeChain(s, chain, CHAIN_METHODS);
  const services = [];
  s.page.on('request', request => { if (/\/api\/(deposit|session)\//.test(request.url())) services.push(new URL(request.url()).pathname); });
  const lower = value => String(value).toLowerCase();
  try {
    await connectOnly(s.page);
    // The link: the mode and the NFT, with the wallet's positions (an open one elsewhere, and a closed one) and the release published.
    s.set({ sequenceRelease: { status: 200, body: chain.release } });
    const positions = [walletPosition(chain, ROOT), walletPosition(chain, 7, { tick: 500 }), walletPosition(chain, 9, { status: 'closed', liquidity: '0' })];
    await s.page.goto(`${s.origin}/${labHash({ positions, mode: 'domino', tokenId: String(ROOT) })}`);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
    const main = s.page.locator('main');
    const card = main.locator('[data-sequence-create]');
    await card.waitFor({ timeout: 30_000 });

    // The picker: the wallet's open positions only, the link's one chosen; the link's mode chosen; the quote currency next.
    const picker = card.getByRole('radiogroup', { name: 'Your open positions' });
    assert.deepEqual(await picker.getByRole('radio').evaluateAll(items => items.map(item => [item.getAttribute('data-sequence-position'), item.getAttribute('aria-checked')])), [['5', 'true'], ['7', 'false']], 'open positions only; the link preselects its own');
    // Changed on purpose 2026-10-01 (integration pass 3, audit E21): the picker's chip writes the fee as every chip does
    // (components/automate/PositionPicker.tsx, lib/format/fee.ts feeWords).
    assert.match((await picker.getByRole('radio').first().innerText()).trim(), /^AAA \/ BBB\s+0\.30% fee\s+#5$/);
    assert.equal(await card.getAttribute('data-sequence-create-mode'), 'domino');
    assert.equal(await card.getAttribute('data-sequence-create'), 'quote');
    assert.equal(await card.locator('[data-sequence-mode="domino"]').getAttribute('aria-checked'), 'true');
    assert.equal(await main.locator('input:not([type="checkbox"])').count(), 0, 'nothing is typed to choose the position');
    const action = card.getByRole('button', { name: 'Set up automation', exact: true });
    assert.equal(await action.isDisabled(), true, 'the quote currency and consent come first');
    // The quote currency: two token buttons, symbols only, neither chosen by the pool's token order.
    const quote = card.getByRole('radiogroup', { name: 'Quote currency' });
    assert.match((await quote.innerText()).trim(), /^AAA\s+BBB$/);
    assert.deepEqual(await quote.getByRole('radio').evaluateAll(items => items.map(item => item.getAttribute('aria-checked'))), ['false', 'false']);
    await quote.getByRole('radio', { name: 'AAA', exact: true }).click();
    // The limits a person sets at a glance, at their defaults; the rest folded away under More limits.
    assert.deepEqual([await card.getByLabel('Next range higher by (%)', { exact: true }).inputValue(), await card.getByLabel('Positions in the sequence', { exact: true }).inputValue()], ['50', '3']);
    assert.equal(await card.locator('details').evaluate(details => details.open), false, 'More limits starts folded');
    assert.equal(await card.locator('summary').innerText(), 'More limits');
    await card.getByRole('checkbox', { name: /^I consent to using this NFT’s already uncollected fees/ }).check();
    assert.equal(await action.isEnabled(), true);
    const step = key => card.locator(`[data-wallet-step="${key}"]`);
    assert.match(await step('approve-root').innerText(), /Approve position #5/);
    assert.deepEqual([await step('approve-root').getAttribute('data-step-state'), await step('create').getAttribute('data-step-state')], ['upcoming', 'upcoming']);
    const text = await main.innerText();
    assert.doesNotMatch(text, /Owner controls|Network budget|Create a paused sequence|Manage a sequence|Root NFT|basis points|\bbps\b|\bwei\b|0x[0-9a-f]{6}/i, 'no removed card, no raw units, no address');
    assert.doesNotMatch(text, FORBIDDEN);
    await s.page.screenshot({ path: join(shots(), 'p2-sequence-ready.png'), fullPage: true });
    await action.click();

    // Created: both steps green, the vault read back from the chain, and the way to the docs for switching it on.
    const created = main.locator(`[data-sequence-created="${vault}"]`);
    await created.waitFor({ timeout: 60_000 });
    assert.equal(await created.getAttribute('data-sequence-create'), 'done');
    assert.match(await created.innerText(), /^\s*Domino-compound is set up for position #5\s+It starts paused, and your position stays in your wallet\./);
    assert.deepEqual(await created.locator('[data-wallet-step]').evaluateAll(items => items.map(item => item.getAttribute('data-step-state'))), ['done', 'done']);
    assert.equal(await created.getByRole('link', { name: 'How to switch it on' }).getAttribute('href'), '/docs/domino-compound#start-and-stop');
    // 2026-09-24 (the three features joined up): and the way back to the position, which Positions now shows in its sequence.
    assert.equal(await created.getByRole('link', { name: 'View position' }).getAttribute('href'), '/positions/5');
    assert.equal(await main.locator('[data-notice-code]').count(), 0, 'no error code beside any sentence');
    assert.doesNotMatch(await created.innerText(), FORBIDDEN);
    await s.page.screenshot({ path: join(shots(), 'p2-sequence-create.png'), fullPage: true });

    // What the wallet was asked to sign, in order, decoded from the calldata the chain recorded.
    assert.equal(chain.sends.length, 2, 'the approval, then the creation');
    const [approve, create] = chain.sends.map(tx => ({ to: lower(tx.to), from: lower(tx.from), value: BigInt(tx.value), nonce: tx.nonce, ...decodeFunctionData({ abi: chainAbi, data: tx.data }) }));
    assert.deepEqual([approve.functionName, approve.to, approve.from, lower(approve.args[0]), approve.args[1], approve.value, approve.nonce], ['approve', positionManager, OWNER, vault, ROOT, 0n, '0x0'],
      'only this NFT, approved to the predicted sequence on the position manager, from the owner, as the first transaction');
    const [params, ownerNonce] = create.args;
    assert.deepEqual([create.functionName, create.to, create.from, create.value, create.nonce, ownerNonce], ['createVault', factory, OWNER, 0n, '0x1', 0n], 'the owner’s first sequence, as the second transaction');
    assert.deepEqual({ ...params, baseCurrency: lower(params.baseCurrency), quoteCurrency: lower(params.quoteCurrency), operator: lower(params.operator) }, {
      rootTokenId: ROOT, expectedPoolId: chain.poolId, baseCurrency: chain.poolKey.currency1, quoteCurrency: chain.poolKey.currency0, operator, consentToUncollectedFees: true,
      policy: { serviceFeeBps: 400, triggerDistanceBps: 500, maxOverlapBps: 2000, minimumIntervalSeconds: 3600, maxPositions: 3, version: 1n, paused: true },
      limits: { version: 1n, upsideBps: 5000, maxSlippageBps: 100, maxPriceImpactBps: 100, maxGasCostWei: 5_000_000_000_000_000n, maxObservationAgeSeconds: 300, forecastHorizonSeconds: 604_800 },
    }, 'the whole InitParams: the pool read from the NFT, the deployment’s operator, consent, the 4% paused policy and the default limits in bps, seconds and wei');
    // The network budget came from the wallet's own price (finance/gas.ts): twice 0.1 gwei, no priority fee; nobody typed it.
    assert.deepEqual(chain.sends.map(tx => [tx.maxFeePerGas, tx.maxPriorityFeePerGas]), [['0xbebc200', '0x0'], ['0xbebc200', '0x0']]);

    // No service and no session took part, and the wallet was asked nothing outside connecting and the chain's own
    // reads and sends. The one session route seen is the boot-time GET that asks whether a session exists to restore.
    assert.deepEqual(services.filter(path => path !== '/api/session/v1/me'), [], 'no deposit service and no session request');
    assert.deepEqual(s.deposits, []);
    assert.deepEqual([...new Set(s.fake.state.log.map(entry => `${entry.method} ${entry.route}`))], ['GET me'], 'the session service was only asked whether a session exists, never for one');
    assert.equal(s.wallet.state.signed.length, 0, 'no sign-in signature');
    // Changed on purpose (2026-09-25, EIP-5792 batches, PR 2): the screen also asks what the wallet can do with a batch
    // (wallet_getCapabilities, finance/batch.ts atomicStatus), a read that opens and signs nothing. This wallet names no
    // batch, so the two steps above are what it was asked to sign.
    assert.deepEqual([...new Set(s.wallet.state.log.map(entry => entry.method))].filter(method => !['eth_accounts', 'eth_chainId', 'eth_requestAccounts', 'wallet_requestPermissions', 'wallet_switchEthereumChain'].includes(method)), ['wallet_getCapabilities'], 'the wallet itself was only asked to connect, and what it can batch');
    assert.deepEqual([...new Set(chain.log)].sort(), ['eth_call', 'eth_estimateGas', 'eth_gasPrice', 'eth_getBalance', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getTransactionByHash', 'eth_getTransactionCount', 'eth_getTransactionReceipt', 'eth_sendTransaction'],
      'reads, the network price, one simulation and one send per step, and the receipts');
    assert.deepEqual(chain.refused, [], 'every method asked is one this chain answers');
    assert.deepEqual(chain.missing, [], 'every call reached a contract that answers it');
  } finally { await s.close(); }
});

// ---- Set up automation's refusals and its failures after a send (added 2026-09-24, from an adversarial audit of the released build) ----

/** What the wallet steps say now, in order: approve-root, then create. */
const stepStates = (card) => card.locator('[data-wallet-step]').evaluateAll(items => items.map(item => item.getAttribute('data-step-state')));
/** The one sentence the page says under Set up automation, once it says one. */
async function said(card) {
  const notice = card.locator('p[role="status"]');
  await notice.waitFor({ timeout: 60_000 });
  return { text: await notice.innerText(), code: await notice.getAttribute('data-notice-code') };
}
/** What preparing a wallet step asks the chain for: none of it means nothing was prepared. */
const PREPARING = ['eth_getTransactionCount', 'eth_estimateGas', 'eth_getBalance', 'eth_sendTransaction'];
/** The hash the fake chain gives the n-th send. */
const sentHash = (index) => `0x${(0xcc + index).toString(16).repeat(32)}`;

test('a position something is already subscribed to is refused before its approval is prepared, and the picker then shows it with that sentence and no longer offers it', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [], approved: false, settled: true, subscribed: [5n] });
  await routeChain(s, chain, CHAIN_METHODS);
  try {
    await connectOnly(s.page);
    s.set({ sequenceRelease: { status: 200, body: chain.release } });
    await s.page.goto(`${s.origin}/${labHash({ positions: [walletPosition(chain, 5), walletPosition(chain, 7)], mode: 'compound', tokenId: '5' })}`);
    await s.page.reload();
    const card = s.page.locator('[data-sequence-create]');
    await card.waitFor({ timeout: 30_000 });
    await card.getByRole('radiogroup', { name: 'Quote currency' }).getByRole('radio', { name: 'AAA', exact: true }).click();
    await card.getByRole('checkbox', { name: /^I consent to using this NFT’s already uncollected fees/ }).check();
    await card.getByRole('button', { name: 'Set up automation', exact: true }).click();
    assert.deepEqual(await said(card), { text: 'This position is already linked to a sequence or another contract.', code: 'position_subscribed' });
    assert.deepEqual(chain.sends, [], 'nothing was offered to the wallet');
    assert.deepEqual(chain.log.filter(method => PREPARING.includes(method)), [], 'no approval was even prepared');
    // The picker: #5 carries the sentence and can't be chosen; #7 is still offered; nothing is chosen for the person.
    const picker = card.getByRole('radiogroup', { name: 'Your open positions' });
    assert.deepEqual(await picker.getByRole('radio').evaluateAll(items => items.map(item => [item.getAttribute('data-sequence-position'), item.getAttribute('aria-checked'), item.disabled])),
      [['5', 'false', true], ['7', 'false', false]]);
    assert.match(await picker.locator('[data-sequence-position="5"]').innerText(), /#5\s+This position is already linked to a sequence or another contract\.$/);
    assert.equal(await card.getAttribute('data-sequence-create'), 'position', 'back to choosing a position');
    await picker.locator('[data-sequence-position="7"]').click();
    assert.equal(await card.getAttribute('data-sequence-create'), 'quote', 'another position can still be chosen, the link’s mode kept');
    assert.equal(s.wallet.state.signed.length, 0);
    assert.deepEqual(chain.missing, []);
  } finally { await s.close(); }
});

test('a listed position the wallet no longer holds is refused as that, with nothing prepared', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [], approved: false, settled: true, holder: `0x${'dd'.repeat(20)}` });
  await routeChain(s, chain, CHAIN_METHODS);
  try {
    await connectOnly(s.page);
    const card = await setUpFromLink(s, chain);
    assert.deepEqual(await said(card), { text: 'This position is no longer in your wallet.', code: 'position_not_in_wallet' });
    assert.deepEqual(chain.sends, []);
    assert.deepEqual(chain.log.filter(method => PREPARING.includes(method)), []);
    assert.deepEqual(chain.missing, []);
  } finally { await s.close(); }
});

test('after the approval was sent, a failure never says that nothing was sent: the approval stays done and the creation failed', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [], approved: false, settled: true });
  // The creation's estimate is refused by the node, after the approval was sent and landed.
  let estimates = 0;
  await routeChain(s, chain, CHAIN_METHODS, (method, params) => method === 'eth_estimateGas' && ++estimates === 2 ? { error: { code: -32000, message: 'execution reverted' } } : chain.request(method, params));
  try {
    await connectOnly(s.page);
    const card = await setUpFromLink(s, chain);
    assert.deepEqual(await said(card), { text: 'A transaction was sent. Check your wallet activity before pressing Set up automation again.', code: null });
    assert.deepEqual(await stepStates(card), ['done', 'failed']);
    assert.deepEqual(chain.sends.map(tx => decodeFunctionData({ abi: chainAbi, data: tx.data }).functionName), ['approve'], 'the approval alone was sent');
  } finally { await s.close(); }
});

test('when the creation was sent but its receipt could not be read, the step stays sent and nothing claims that nothing was sent', async () => {
  // Changed on purpose (2026-09-25): once the press ends, a sent step whose receipt never settled is `sent`, not `chain`, so
  // nothing spins or says it waits for the network while nothing reads its receipt. The approval's own receipt is the second case.
  for (const [index, states] of [[1, ['done', 'sent']], [0, ['sent', 'upcoming']]]) {
    const s = await scenario({ clock: true }), chain = fakeSequenceChain(OWNER, { roots: [], approved: false, settled: true });
    let failedReads = 0;
    await routeChain(s, chain, CHAIN_METHODS, (method, params) => {
      if (method === 'eth_getTransactionReceipt' && String(params[0]).toLowerCase() === sentHash(index)) {
        failedReads++;
        return { error: { code: -32000, message: 'header not found' } };
      }
      return chain.request(method, params);
    });
    try {
      await connectOnly(s.page);
      const card = await setUpFromLink(s, chain);
      await until(() => failedReads >= 2, 'the same sent receipt retried', 30_000);
      assert.equal(chain.sends.length, index + 1, 'recovering receipt reads never sends the transaction again');
      assert.equal(await card.locator('p[role="status"]').count(), 0, 'a transient read failure does not end receipt recovery');
      // Recovery is bounded by the existing four-minute deadline, not the old immediate-failure behavior.
      // The operation is deliberately still busy; advance the controlled clock instead of waiting four real minutes.
      await jump(s.page, '04:01', { pending: true });
      assert.equal((await said(card)).text, 'A transaction was sent. Check your wallet activity before pressing Set up automation again.');
      assert.deepEqual(await stepStates(card), states, 'the step is sent, not failed: only its receipt can say that');
      assert.equal(chain.sends.length, index + 1);
      const list = card.locator('[data-wallet-steps]');
      assert.equal(await list.locator('.dm-step-marker[data-state="current"]').count(), 0, 'no step is shown as running');
      assert.deepEqual(await list.locator('.dm-step-marker').evaluateAll((markers) => markers.map((marker) => getComputedStyle(marker, '::after').animationName)), ['none', 'none'], 'no marker spins');
      assert.doesNotMatch(await list.innerText(), /Waiting for the network|Confirm in your wallet/);
      assert.equal(await card.getByRole('button', { name: 'Set up automation', exact: true }).isEnabled(), true, 'the press has ended');
    } finally { await s.close(); }
  }
});

test('a sequence whose creation receipt is in is shown created, even when a read of it right after fails', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [], approved: false, settled: true });
  // A node behind the block that holds the creation: the new sequence's code reads as none.
  await routeChain(s, chain, CHAIN_METHODS, (method, params) => method === 'eth_getCode' && String(params[0]).toLowerCase() === chain.predict(0) ? { result: '0x' } : chain.request(method, params));
  try {
    await connectOnly(s.page);
    await setUpFromLink(s, chain);
    const created = s.page.locator(`main [data-sequence-created="${chain.predict(0)}"]`);
    await created.waitFor({ timeout: 60_000 });
    assert.deepEqual(await stepStates(created), ['done', 'done']);
    assert.equal(await s.page.locator('main p[role="status"]').count(), 0, 'no failure is said');
  } finally { await s.close(); }
});

// 2026-10-01 (audit C14): Set up automation's two steps replaced in the wallet ("Speed up" or "Cancel") are known within
// seconds by their nonce, and the chain read again says whether each happened. A cancelled approval stops the press at its
// own step and is never asked for again in it; a sped-up creation is shown created.
test('an approval cancelled in the wallet stops Set up automation at its step without asking again; the next press approves once, and a creation sped up is shown created', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [], approved: false, settled: true });
  const vault = chain.predict(0);
  await routeChain(s, chain, CHAIN_METHODS);
  const sends = () => chain.log.filter((method) => method === 'eth_sendTransaction').length;
  try {
    await connectOnly(s.page);
    chain.cancelNextInWallet('approve');
    const card = await setUpFromLink(s, chain);
    assert.deepEqual(await said(card), { text: 'Your wallet replaced the approval with another transaction, and nothing was approved. Press Set up automation again.', code: 'sequence_approval_replaced' });
    assert.deepEqual(await stepStates(card), ['failed', 'upcoming']);
    assert.deepEqual([chain.sends.length, chain.burned(), sends()], [0, 1, 1], 'the cancelled approval was not asked for again in the same press');

    // The next press: the approval once, at the nonce after the one the cancel took; then the creation, sped up.
    chain.speedUpNext('createVault');
    await card.getByRole('button', { name: 'Set up automation', exact: true }).click();
    const created = s.page.locator(`main [data-sequence-created="${vault}"]`);
    await created.waitFor({ timeout: 60_000 });
    assert.deepEqual(await stepStates(created), ['done', 'done']);
    assert.equal(await s.page.locator('main p[role="status"]').count(), 0, 'no failure is said');
    assert.deepEqual(chain.sends.map((tx) => [decodeFunctionData({ abi: chainAbi, data: tx.data }).functionName, tx.nonce]), [['approve', '0x1'], ['createVault', '0x2']], 'each step once');
    assert.equal(sends(), 3);
    assert.deepEqual([chain.missing, chain.refused], [[], []]);
  } finally { await s.close(); }
});

// The page no longer has a review or a network budget: the sentences it can reach name neither.
test('not enough ETH for a step is said as the network fee it does not cover, not as a reserve set in a network budget', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [], approved: false, settled: true, balance: '0x0' });
  await routeChain(s, chain, CHAIN_METHODS);
  try {
    await connectOnly(s.page);
    const card = await setUpFromLink(s, chain);
    assert.deepEqual(await said(card), { text: 'Your ETH does not cover the network fee for this step.', code: 'native_gas_reserve_insufficient' });
    assert.deepEqual(chain.sends, []);
  } finally { await s.close(); }
});

test('a creation that is no longer what was prepared sends the owner back to Set up automation, not to a review', async () => {
  // The approval was sent and included, yet the chain still asks for it.
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [], approved: false, settled: true, lostApproval: true });
  await routeChain(s, chain, CHAIN_METHODS);
  try {
    await connectOnly(s.page);
    const card = await setUpFromLink(s, chain);
    assert.deepEqual(await said(card), { text: 'The sequence changed since it was prepared. Press Set up automation again.', code: 'sequence_preparation_changed' });
    assert.deepEqual(await stepStates(card), ['done', 'failed']);
    assert.equal(chain.sends.length, 1, 'the approval alone');
    assert.doesNotMatch(await s.page.locator('main').innerText(), /review|network budget|reserve you set/i);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------
// Positions: the connected wallet's own list, and a page per position (owner, 2026-09-24)
// Rewritten later the same day: the list is what DominoSetupV1 minted to the wallet, read from chain, every row drawn from
// that one answer (no nft-positions read, no lookup by NFT id, nothing kept in the browser).
// Changed on purpose (2026-09-25): the public RPC answers 429 to every call from Cloudflare's edge, so the site's routes
// (POST /api/owned/v2/positions, /api/fees/v1/*) failed in production and the list said "No positions to show". The page
// now reads the chain itself, with the routes' own code: these tests answer the RPC's host with a fake chain
// (tests/support/browser-chain.mjs) and check that no route of the site is asked, and that a read that failed is never
// shown as a wallet with nothing.
// ---------------------------------------------------------------------------
part('positions');

/** The stub's pool as the chain keys it: ETH against TOKEN, 0.30%, spacing 60, no hooks. */
const STUB_KEY = { currency0: zeroAddress, currency1: FIXTURE_TOKEN.toLowerCase(), fee: 3000, tickSpacing: 60, hooks: zeroAddress };
const STUB_POOL_ID = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }], [zeroAddress, FIXTURE_TOKEN, 3000, 60, zeroAddress]));
const TOKENS = { [FIXTURE_TOKEN.toLowerCase()]: { symbol: 'TOKEN', decimals: 6 } };
/** 2^100 of liquidity in -60..60 at tick 0. */
const LIQUIDITY = 2n ** 100n;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

/** One of the chain's positions: held by the connected wallet, in the stub's pool at tick 0, -60 to 60, 633,825,300,114 wei of ETH unclaimed, unless `patch` says otherwise. */
const onChain = (tokenId, patch = {}) => ({ tokenId, holder: OWNER, key: STUB_KEY, tickLower: -60, tickUpper: 60, liquidity: LIQUIDITY, unclaimed: [633825300114n, 0n], ...patch });
/** Closed: all of its liquidity removed, the NFT kept by its owner. */
const closedOnChain = (tokenId, patch = {}) => onChain(tokenId, { liquidity: 0n, unclaimed: [0n, 0n], ...patch });

/** What the chain holds for 0xf618…c0a: one open position created through DominoSetupV1; here, eleven closed ones too. */
const OWNED_OPEN = '3135288';
const OWNED_CLOSED = ['3134000', '3133000', '3132000', '3131000', '3130000', '3129000', '3128000', '3127000', '3126000', '3125000', '3124000'];
const BIG_ID = '57896044618658097711785492504343953926634992332820282019728792003956564819969';

/** The site's own routes that read the chain for the page, recorded if the page ever asks one again: it must not. */
function siteRoutes() {
  const asked = [];
  return {
    asked,
    async route(request, url) {
      // 2026-09-25, later: and the automation state's (functions/api/automation/v1/state.ts), read by the page since.
      if (!/^\/api\/(?:owned|fees|automation)\//.test(url.pathname)) return undefined;
      asked.push(`${request.method} ${url.pathname}`);
      return Response.json({ error: 'route_not_available' }, { status: 404 });
    },
  };
}

/** Connects Test Wallet A (or the wallet `name`s) from the header's dialog, on Robinhood Chain, without signing in. */
async function connectWallet(page, name = 'Test Wallet A') {
  await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
  await page.locator('header [aria-haspopup="dialog"]').click();
  const dialog = page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
  await dialog.getByRole('button', { name: `Connect ${name}`, exact: true }).click();
  await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
  await page.keyboard.press('Escape');
}

/** The read service's nft-positions questions the page asked, in order: none any more. */
const nftReads = (read) => read.requests.filter((r) => r.path.endsWith('/nft-positions')).map((r) => JSON.parse(r.body).tokenIds);
/**
 * Everything the page keeps in the browser about positions (owner, 2026-09-26: dark only, so no appearance key either).
 * Changed on purpose (2026-09-28, the owner, on his phone: Your positions stayed on its loading rows while the RPC
 * refused his address): the list keeps one display copy of the chain's last answer per wallet and chain (OWNED_COPY),
 * which it draws at once on the next visit while the chain is read.
 */
const kept = (page) => page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((key) => /position|owned/i.test(key)));
/** The list's display copy for Test Wallet A on Robinhood Chain (components/positions/OwnedPositions.tsx). */
const OWNED_COPY = `domino.kept.v1.owned.4663.${OWNER}`;

/**
 * 2026-09-28: the public RPC refusing this browser's address as it does live, while `until` (a time) is ahead: every
 * request is answered 429 with the allow-origin `*,*` a browser cannot read, so the page sees a failed fetch. `asked`
 * keeps every request, answered or refused, with its time and its calls (method, and a log read's first topic).
 */
function refusing(chain) {
  const answer = chain.fetch;
  const state = { until: 0, asked: [] };
  chain.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const refused = Date.now() < state.until;
    state.asked.push({ at: Date.now(), refused, calls: (Array.isArray(body) ? body : [body]).map((call) => ({ method: call.method, topic: call.params?.[0]?.topics?.[0], params: call.params })) });
    if (refused) return new Response('Too Many Requests', { status: 429, headers: { 'access-control-allow-origin': '*,*', 'content-type': 'text/plain' } });
    return answer(url, init);
  };
  return state;
}
/** After a reload or in a new tab: the wallet connects again by itself, or is connected again from the header. */
async function reconnect(page) {
  await page.waitForFunction(() => ['no-wallet', 'kept', 'ready', 'loading', 'retrying', 'unlisted'].includes(document.querySelector('[data-owned]')?.getAttribute('data-owned')), null, { timeout: 15_000 });
  if ((await page.locator('[data-owned]').getAttribute('data-owned')) === 'no-wallet') await connectWallet(page);
}
/** The rows of Your positions as they read, in order. */
// Changed on purpose 2026-10-02 (review of the rules, finding 11): a row's Your APR is its ledger's ("not measured" for one
// that cannot be measured), which a copy drawn before any read cannot know ("— on its page"): its words are left out.
// Changed on purpose (2026-10-15, pack 8): a row's Your APR is no part of the wallet's copy (it is its ledger's, read for the
// chain's list only), so its dash is left out as its words were; pack 7 made the words a bare dash, and pack 8 answers a
// position minted before Domino's release at once, so the first drawing of such a row now already holds that dash.
const ownedRows = (page) => page.locator('[data-owned] a[data-position-row]').evaluateAll((rows) => rows.map((row) => `${row.getAttribute('data-position-row')} ${row.innerText.replace(/\s+/g, ' ').trim().replace(/Your APR (?:— on its page|not measured|—)/, 'Your APR')}`));

/** What the list card showed since recordList, once a wallet was connected (the no-wallet and waiting cards left out). */
const listSeen = (page) => page.evaluate(() => window.__ownedSeen.filter((what) => !/^(?:no-wallet|waiting|other-network)\b/.test(what)));
/** From now on, every state the list card shows, in order: data-owned, and which empty state or line it carries. */
const recordList = (page) =>
  page.evaluate(() => {
    window.__ownedSeen = [];
    const note = () => {
      const card = document.querySelector('[data-owned]');
      if (!card) return;
      const empty = card.querySelector('[data-empty]')?.getAttribute('data-empty');
      const line = card.querySelector('[data-owned-note]')?.getAttribute('data-owned-note');
      const what = [card.getAttribute('data-owned'), empty, line].filter(Boolean).join(':');
      if (window.__ownedSeen.at(-1) !== what) window.__ownedSeen.push(what);
    };
    note();
    new MutationObserver(note).observe(document.body, { childList: true, subtree: true, attributes: true });
  });

test('Positions lists the positions the wallet created through Domino, Open 1 and Closed 11, straight from the chain read, and each row opens the position’s page', async () => {
  const chain = browserChain({ positions: [onChain(OWNED_OPEN), ...OWNED_CLOSED.map((id) => closedOnChain(id))], tokens: TOKENS });
  const site = siteRoutes();
  const read = createReadStub();
  const s = await scenario({ chain, routes: [site.route, (request, url) => read.handle(request, url)] });
  const chunks = [];
  s.page.on('request', (request) => {
    const name = new URL(request.url()).pathname.split('/').pop();
    if (/^(PositionActions|HeldDeposits)-/.test(name)) chunks.push(name.split('-')[0]);
  });
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    // No wallet yet: one empty state that asks for one, and nothing is listed or read.
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    assert.equal((await s.page.locator('[data-empty="owned-connect"]').innerText()).replace(/\s+/g, ' '), 'Connect a wallet to see your positions. Connect wallet');
    assert.deepEqual([chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length, nftReads(read).length], [0, 0], 'nothing is asked without a wallet');

    await recordList(s.page);
    await connectWallet(s.page);
    const card = s.page.locator('[data-owned="ready"]');
    await card.waitFor();
    // One read of the chain by the page itself, the address in its POST bodies only; no route of the site.
    assert.equal(chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length, 1);
    assert.deepEqual(site.asked, [], 'no route of the site is asked');
    assert.deepEqual(await listSeen(s.page), ['loading', 'ready'], 'the loading rows, then the list');
    const tabs = s.page.getByRole('tab');
    assert.deepEqual((await tabs.allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim()), ['Open 1', 'Closed 11']);
    assert.equal(await s.page.getByRole('tab', { selected: true }).innerText().then((text) => text.replace(/\s+/g, ' ')), 'Open 1');
    assert.equal(await card.getAttribute('data-owned-block'), String(chain.head));

    // The open position's row, every figure from the chain read: the read service is never asked.
    const row = s.page.locator(`a[data-position-row="${OWNED_OPEN}"][data-snapshot="${chain.head}"]`);
    await row.waitFor();
    assert.equal(await row.getAttribute('href'), `/positions/${OWNED_OPEN}`);
    const rowText = await row.innerText();
    // Changed on purpose (the owner, round 6, 2026-09-27: one tidy row a position, plain words): the pair and "0.30% fee"
    // over In range; the NFT id is for a screen reader only ("Position #3135288"), no longer a chip.
    assert.match(rowText, /ETH\s*\/\s*TOKEN\s+0\.30% fee\s+Position #3135288\s+In range/);
    // Changed on purpose 2026-10-01 (audit E7): an amount under a millionth reads "<0.000001", every digit in its title.
    assert.match(rowText, /633,825,300,114 ETH|<0\.000001 ETH/);
    assert.equal(await s.page.locator('[data-position-row]').count(), 1);
    // 2026-09-24 (the three features joined up): its feature from chain and the way to automate it. Changed on purpose
    // (round 6, 2026-09-27): in the row's Automation column, over the row as its sibling, no longer a line under it with
    // "Plain position" and a picture: a plain position shows Automate alone. Changed on purpose (2026-09-28, review: a
    // click on a badge is the row's, so the cell has no tooltip): its state is the cell's data attribute only.
    const feature = s.page.locator(`[data-position-item="${OWNED_OPEN}"] > [data-position-automation="${OWNED_OPEN}"]`);
    await feature.locator('a[data-automate-entry]').waitFor();
    assert.equal(await feature.getAttribute('data-automation'), 'plain');
    assert.equal(await feature.getAttribute('title'), null);
    assert.match(await feature.innerText(), /^Automate$/);
    assert.equal(await feature.locator('a').getAttribute('href'), `/sequence/${OWNED_OPEN}`);
    assert.equal(await s.page.locator('[data-position-row] a, [data-position-row] button').count(), 0, 'the row stays one link, with nothing inside it');
    assert.deepEqual(nftReads(read), [], 'no nft-positions read: the rows are the chain read');
    assert.equal(await s.page.locator('details[data-lookup-disclosure], #nft-ids, #chain-lookup').count(), 0, 'no lookup by NFT id');
    assert.deepEqual(chunks, [], 'no held deposits: their chunk is not loaded');
    await s.page.locator('[data-owned-rows]').screenshot({ path: join(shots(), 'positions-open.png') });

    // Closed: ten rows, the eleventh behind Show 1 more, all from the same answer. A closed position kept its NFT.
    await s.page.getByRole('tab', { name: /^Closed/ }).click();
    const closedRows = s.page.locator('[data-owned-rows="closed"] a[data-position-row]');
    await closedRows.nth(9).waitFor();
    assert.equal(await closedRows.count(), 10);
    assert.deepEqual(await closedRows.locator('[data-position-status]').evaluateAll((pills) => [...new Set(pills.map((pill) => pill.textContent))]), ['Closed']);
    assert.equal(await closedRows.first().getAttribute('data-row-state'), 'closed');
    assert.equal(await closedRows.first().locator('.dm-own-closed-caption').innerText(), 'View history');
    assert.equal(await closedRows.first().locator('[data-cell="apr"]').count(), 0, 'closed positions do not carry an empty APR column');
    // Changed on purpose 2026-10-30 (QA round 2, N45): a closed row with nothing left draws no zero figures at all; hidden for
    // the eye only, every closed row read "Value … Fees to collect …" to a screen reader.
    assert.doesNotMatch(await closedRows.first().innerText(), /Value|Fees to collect/, 'no zero figures on a closed row');
    assert.equal(await closedRows.first().locator('.dm-own-figs').count(), 0, 'empty closed figures are not drawn');
    await s.page.getByRole('button', { name: 'Show 1 more', exact: true }).click();
    await s.page.locator(`[data-owned-rows="closed"] a[data-position-row="${OWNED_CLOSED[10]}"]`).waitFor();
    assert.equal(await s.page.getByRole('button', { name: /^Show \d+ more$/ }).count(), 0);
    assert.equal(chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length, 1, 'the tabs and Show more ask nothing');
    await s.page.locator('main').screenshot({ path: join(shots(), 'positions-closed.png') });
    const listText = await s.page.locator('main').innerText();
    assert.doesNotMatch(listText, FORBIDDEN);
    assert.doesNotMatch(listText, /comma|type (?:the|an) NFT id|Look up|Position NFTs/i, 'no typed ids asked for');
    // Changed on purpose (2026-09-28): the list's display copy of the chain's answer, and nothing else.
    assert.deepEqual(await kept(s.page), [OWNED_COPY], 'nothing about positions is kept in the browser but the list’s copy');

    // A row is a link to the position's own page, read from the chain by the page.
    await s.page.getByRole('tab', { name: /^Open/ }).click();
    await row.click();
    await s.page.waitForFunction((id) => location.pathname + location.hash === `/positions/${id}`, OWNED_OPEN);
    const detail = s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"]`);
    await detail.waitFor();
    await detail.locator('[data-stat="price"] [data-current-price="usable"]').waitFor();
    assert.match(await detail.locator('h1').innerText(), /^ETH\s*\/\s*TOKEN$/);
    // Changed on purpose (2026-09-27, the owner: plain words for someone who knows nothing of pools): the fee tier says
    // "fee" beside Your APR; the key figures are Position value, Fees to collect, Your APR and Current price, the
    // price followed by its quote unit, and the range under it as a bar with its two ends, without "≈"; the facts are in Details,
    // closed until opened.
    // Changed on purpose 2026-10-01 (audit E5): the NFT's number is no longer in the chip; a screen reader still hears it.
    // Changed on purpose 2026-10-30 (QA round 2, N60): the network's chip after the fee's, as the Base/Arbitrum page has it.
    assert.match(await detail.locator('.dm-pos-chips').innerText(), /Uniswap · 0\.30% fee\s+Robinhood Chain\s+Position #3135288\s+In range/);
    assert.equal(await detail.locator('.dm-pos-chips .dm-chip', { hasText: '#3135288' }).count(), 0, 'no NFT number on the chip');
    const stats = await detail.locator('[data-position-stats]').innerText();
    // Changed on purpose 2026-09-28 (one-sided): TOKEN's price in ETH, the app's one way round (lib/read/orientation.ts).
    // Changed on purpose 2026-10-03 (the owner's point 10: "tokens go from $0.001 to $1,000,000"): a tiny price with its
    // zeros after the point counted ("0.0₁₁1" is 0.000000000001), as the Price range chart writes it too.
    assert.match(stats, /Current price\s+0\.0₁₁1\s+ETH per TOKEN\s+0\.0₁₂994018\s+Your range\s+0\.0₁₁100602\s+In range: earning fees/, 'the pool’s price from the same read, with no button to ask for it');
    assert.equal(await detail.locator('[data-stat="price"] [data-current-price="usable"]').getAttribute('title'), `Pool price at block ${await detail.getAttribute('data-snapshot')}: ≈0.000000000001`, 'every digit in its title');
    assert.match(stats, /Fees to collect\s+<?[\d.,]+ ETH\s+0 TOKEN/);
    assert.match(stats, /Position value\s+[\d.,]+ ETH/);
    // Your APR waits for the fees history (a skeleton meanwhile); this chain has none to give it, so a dash and why.
    const apr = detail.locator('[data-cell="apr"]:not([data-apr="loading"]):not([data-apr="idle"])');
    await apr.waitFor({ timeout: 15_000 });
    // Changed on purpose 2026-10-02 (RPC-SPEC §11.4): this chain holds none of the position's events (not even its mint
    // above block 69,249,061), so its ledger cannot measure its fees earned, and says so.
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): a dash, with nothing under it ("Not measured for this position").
    assert.match(await apr.innerText(), /^Your APR\s+—$/, 'no fees history on this chain: a dash, never a guess');
    // 2026-09-27 (review): a pair without USDG stacks each tile in its own flow (the rows line up across the tiles only
    // for one-line USD figures), so the reason stands right under its dash, not at the foot of the tallest tile.
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): no reason under the dash any more.
    assert.equal(await apr.locator('.dm-stat-sub').count(), 0, 'nothing under the dash');
    assert.doesNotMatch(stats, /≈|Principal|Unclaimed/i);
    assert.equal(await detail.getByRole('button', { name: 'Show current price' }).count(), 0);
    assert.equal(await detail.locator('[data-position-details]').getAttribute('open'), null, 'Details closed');
    // And on a phone, where the hint beside it is hidden, the Details chevron keeps to the right edge (the same review).
    await s.page.setViewportSize({ width: 390, height: 844 });
    const edge = await detail.locator('[data-position-details] > summary').evaluate((head) => head.getBoundingClientRect().right - head.querySelector('svg').getBoundingClientRect().right);
    assert.ok(edge >= 0 && edge <= 24, `the chevron ${edge}px from the right edge`);
    await s.page.setViewportSize({ width: 1320, height: 1000 });
    await detail.locator('[data-position-details] > summary').click();
    const facts = await detail.locator('.dm-pos-facts').innerText();
    assert.match(facts, /NFT id\s+3135288/);
    assert.match(facts, new RegExp(`Owner\\s+${OWNER}`));
    assert.match(facts, new RegExp(`Liquidity\\s+${LIQUIDITY}`));
    assert.match(facts, /Ticks\s+-60 to 60/);
    // Changed on purpose (2026-09-24, the three features joined up): Automate left the facts' links for the owner's own
    // actions in the title row, beside Collect fees and Close position, and opens the automation page with this position
    // chosen and the mode still to choose; the position's feature is a pill beside its range status.
    assert.deepEqual(await detail.locator('.dm-pos-links a').evaluateAll((links) => links.map((a) => [a.textContent, a.getAttribute('href')])), [
      ['Pool', `/pool/${STUB_POOL_ID}/${FIXTURE_TOKEN.toLowerCase()}`],
      // Changed on purpose (round 6, 2026-09-27): the link names the pool's token after its id, as the Pool link does, so
      // New position verifies an unlisted pool with it instead of USDG.
      // Changed on purpose 2026-10-30 (QA round 2, Q33/N43): one name for the New position flow.
      ['New position in this pool', `/new/${STUB_POOL_ID}/${FIXTURE_TOKEN}`],
    ]);
    await detail.locator('[data-position-actions] a[data-automate-entry]').waitFor();
    assert.deepEqual(await detail.locator('[data-position-actions] a[data-automate-entry]').evaluate((a) => [a.textContent, a.getAttribute('href')]), ['Automate', `/sequence/${OWNED_OPEN}`]);
    assert.equal(await detail.locator('.dm-pos-chips [data-automation="plain"]').innerText(), 'Plain position');
    // Changed on purpose 2026-10-01 (fees item A21): the page's state read is two calls, the first at 'latest' (naming its
    // block through ArbSys), the second at that block: the head here, where it read head − 2 before.
    assert.ok(chain.log.some((call) => call.method === 'eth_call' && call.params[1] === 'latest') && chain.log.some((call) => call.method === 'eth_call' && Number(call.params[1]) === chain.head), 'the page reads its NFT from the chain, at the block its first call ran at');
    assert.deepEqual(nftReads(read), [], 'and never from the read service');
    assert.ok(!read.requests.some((r) => r.path.endsWith('/pool-market')), 'nor the pool’s price: it came with the read');
    // The owner's actions have their mount: the chunk is opened on the page, behind the wallet flag.
    await s.page.waitForFunction(() => performance.getEntriesByType('resource').some((entry) => /\/PositionActions-[\w-]+\.js$/.test(entry.name)));
    // 2026-09-27 (the owner: Domino's own buttons): one primary, a plain position's Collect fees; Automate outlined;
    // Close position the one danger.
    await detail.locator('[data-position-action="collect"]').waitFor();
    assert.deepEqual(await detail.locator('[data-position-actions] :is(a, button)').evaluateAll((all) => all.map((one) => [one.textContent, one.className.match(/\bdm-btn--(\w+)/)?.[1]])), [
      ['Automate', 'outline'],
      ['Collect fees', 'primary'],
      ['Close position', 'danger'],
    ]);
    assert.doesNotMatch(await detail.innerText(), FORBIDDEN);
    await s.page.screenshot({ path: join(shots(), 'position-detail.png'), fullPage: true });

    // A closed position's page: Closed, and no Automate.
    await s.page.evaluate((id) => { location.hash = `#/positions/${id}`; }, OWNED_CLOSED[0]);
    const closed = s.page.locator(`[data-position-detail][data-position-id="${OWNED_CLOSED[0]}"]`);
    await closed.waitFor();
    assert.equal(await closed.locator('[data-position-status]').innerText(), 'Closed');
    assert.equal(await closed.getByRole('link', { name: 'Automate' }).count(), 0);
    // Back to the list.
    await s.page.getByRole('link', { name: 'Positions', exact: true }).first().click();
    await s.page.locator('[data-owned="ready"]').waitFor();
    assert.deepEqual(site.asked, [], 'no route of the site was asked at any point');
    assert.deepEqual([chain.refused, chain.missing], [[], []], 'the page asked the chain only what the reads may');
    assert.deepEqual(s.wallet.state.signed, [], 'nothing was signed');
  } finally { await s.close(); }
});

// 2026-10-01 (audit V7, the optional part the owner approved): View address shows that public address's positions too,
// read-only, in the same list: no wallet needed, nothing to act on (no Automate, no held deposit or its refund, no New
// position), read once (no refresh, no browser copy, no history read ahead), and Use the connected wallet goes back.
test('View address lists that address’s positions read-only beside its tokens, with no wallet; read once, nothing to act on; Use the connected wallet goes back to the wallet’s own', async () => {
  const OTHER = '0x7777777777777777777777777777777777777777';
  const deposit = { key: STUB_KEY, balance0: 1000n, balance1: 0n };
  const chain = browserChain({
    positions: [onChain(OWNED_OPEN), onChain('4000001', { holder: OTHER }), closedOnChain('4000002', { holder: OTHER })],
    tokens: TOKENS,
    deposits: { [OTHER]: [deposit] },
  });
  const site = siteRoutes();
  const read = createReadStub();
  const s = await scenario({ clock: true, chain, refresh: true, prefetch: true, routes: [site.route, (request, url) => read.handle(request, url)] });
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    // Changed on purpose 2026-11-09 (a flake on CI's slow runner, twice that day: the page drew Positions, "Connect a wallet",
    // and the address was never shown): the link is followed once the page has opened, its session read and its own list
    // drawn, so the page's start cannot write its own address over the link's.
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await s.page.locator('[data-empty="owned-connect"]').waitFor({ timeout: 15_000 });
    // A link to the address, with no wallet connected: its positions, named by the address.
    await s.page.evaluate((address) => { location.hash = `#/portfolio/${address}`; }, OTHER);
    const card = s.page.locator(`[data-owned="ready"][data-owned-viewed="${OTHER}"]`);
    await card.waitFor({ timeout: 15_000 });
    assert.equal((await card.locator('#own-title').innerText()).replace(/\s+/g, ' ').trim(), 'Positions of 0x7777…7777');
    assert.equal(await card.locator('#own-title [title]').getAttribute('title'), OTHER, 'the full address one hover away');
    assert.deepEqual((await card.getByRole('tab').allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim()), ['Open 1', 'Closed 1']);
    const row = card.locator('a[data-position-row="4000001"]');
    await row.waitFor();
    assert.equal(await row.getAttribute('href'), '/positions/4000001', 'each row opens the position’s public page');
    // Nothing to act on: no Automate, no held deposit or refund (though the address holds one), no New position, no Connect.
    assert.equal(await s.page.locator('a[data-automate-entry]').count(), 0);
    assert.equal(await s.page.locator('[data-held-deposits]').count(), 0);
    assert.equal(await card.getByRole('button').count(), 0);
    assert.equal(await card.getByRole('link', { name: 'New position' }).count(), 0);
    assert.equal(await s.page.locator('[data-empty="owned-connect"]').count(), 0, 'no wallet needed');
    assert.equal(await s.page.locator('[data-portfolio-address]').getAttribute('data-portfolio-address'), OTHER, 'the Wallet card views the same address');
    assert.equal(await s.page.locator('[data-automation-cards]').count(), 0, 'no automation cards beside that address (fix round 1)');
    assert.doesNotMatch(await card.innerText(), FORBIDDEN);
    await s.page.screenshot({ path: join(shots(), 'v7-viewed-address.png'), fullPage: true });
    // Read once: the scan of that address, and no refresh 30 s later (the wallet's own list refreshes), no browser copy,
    // and no history read ahead for its rows (the list's APR prefetch is on in this scenario).
    assert.equal(chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length, 1);
    await jump(s.page, '00:31');
    await s.page.waitForTimeout(500);
    assert.equal(chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length, 1, 'not read again on a timer');
    assert.deepEqual(chain.log.filter((entry) => entry.method === 'eth_getLogs' && entry.params[0].topics?.[0] !== SETUP_MINTED_TOPIC), [], 'no history read for its rows');
    assert.deepEqual(await kept(s.page), [], 'nothing about that address kept in the browser');
    assert.deepEqual(site.asked, [], 'no route of the site');

    // Connected, on its own list, then View another address from the Wallet card: the list follows the address shown.
    await s.page.evaluate(() => { location.hash = '#/positions'; });
    await connectWallet(s.page);
    await s.page.locator(`[data-owned="ready"]:not([data-owned-viewed]) a[data-position-row="${OWNED_OPEN}"]`).waitFor({ timeout: 15_000 });
    assert.equal((await s.page.locator('#own-title').innerText()).trim(), 'Your positions');
    const wallet = s.page.locator('[data-portfolio-address]');
    await wallet.getByRole('button', { name: 'View another address', exact: true }).click();
    await wallet.getByPlaceholder('Public address, 0x…').fill(OTHER);
    await wallet.getByRole('button', { name: 'View address', exact: true }).click();
    await s.page.locator(`[data-owned-viewed="${OTHER}"] a[data-position-row="4000001"]`).waitFor({ timeout: 15_000 });
    assert.equal(await s.page.locator('a[data-position-row]').count(), 1, 'that address’s open row alone, not the wallet’s');
    assert.equal(await s.page.locator('a[data-automate-entry]').count(), 0);
    // Fix round 1 (2026-10-01): the signed-in wallet's Managed positions and Receipts (or their one line) are not shown
    // beside another address's positions, where a beginner would read them as that address's.
    assert.equal(await s.page.locator('[data-automation-cards]').count(), 0, 'no automation cards while another address is viewed');
    await wallet.getByRole('button', { name: 'Use the connected wallet', exact: true }).click();
    await s.page.locator(`[data-owned="ready"]:not([data-owned-viewed]) a[data-position-row="${OWNED_OPEN}"]`).waitFor({ timeout: 15_000 });
    assert.equal((await s.page.locator('#own-title').innerText()).trim(), 'Your positions');
    await s.page.locator(`a[data-automate-entry]`).first().waitFor();
    assert.equal(await s.page.locator('[data-automation-cards]').count(), 1, 'back with the wallet’s own list');
  } finally { await s.close(); }
});

// The owner's complaint of 2026-09-25: with the RPC refusing the site's routes, a read that failed drew "No positions to
// show" for a wallet with four open positions. A failed read now says nothing about the wallet: the loading rows and one
// quiet line while it is asked again on its own (2, 5 and 10 s), one calm line if those fail too; never the empty state.
test('a read that fails is never “no positions”: the loading rows and one quiet line while it is asked again, the list and the held deposit once the chain answers, one calm line if it keeps failing, and no Retry', async () => {
  const deposit = { key: { currency0: zeroAddress, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: zeroAddress }, balance0: 0n, balance1: 100000n };
  const chain = browserChain({ positions: [onChain(OWNED_OPEN), ...OWNED_CLOSED.map((id) => closedOnChain(id))], tokens: { ...TOKENS, [USDG]: { symbol: 'USDG', decimals: 6 } }, deposits: { [OWNER]: [deposit] } });
  // The chain refuses the page's first two reads, then answers. Changed on purpose (RPC-SPEC, 2026-10-01): the list is the
  // site's route, which says so (502 chain_unavailable, its short wait), whatever the node's own failure was.
  const { refusingRoute } = await import('./support/edge-busy.mjs');
  const site = siteRoutes();
  const read = createReadStub();
  const s = await scenario({ chain, routes: [site.route, (request, url) => read.handle(request, url)] });
  const owned = await refusingRoute(s.context, '/api/owned/v2/positions', { body: { error: 'chain_unavailable' }, retryAfter: 12 });
  owned.times = 2;
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    await recordList(s.page);
    await connectWallet(s.page);

    // Refused: the loading rows stay, with one quiet line; the reason is a data attribute only.
    const again = s.page.locator('[data-owned="retrying"]');
    await again.waitFor();
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): the line is a hidden marker ("Reading your positions from the chain…").
    assert.equal(await again.locator('[data-owned-note="rereading"]').innerText(), '');
    assert.equal(await again.getAttribute('data-owned-reason'), 'chain_unavailable');
    assert.equal(await again.locator('[data-owned-loading]').count(), 1, 'the loading rows stay');
    assert.equal(await s.page.getByRole('button', { name: /^(Retry|Refresh|Try again|Read again)$/ }).count(), 0, 'no Retry');
    const text = await s.page.locator('main').innerText();
    assert.doesNotMatch(text, FORBIDDEN);
    assert.doesNotMatch(text, /No positions|chain_unavailable|Look up|NFT id/i, 'no empty state, no code, no lookup');

    // A link that carries several ids, arriving while the page is open: it is the list, nothing is looked up.
    await s.page.evaluate((big) => { location.hash = `#/positions/1,${big}`; }, BIG_ID);
    await s.page.locator('[data-owned]').waitFor();
    assert.equal(await s.page.locator('[data-position-detail], [data-position-loading]').count(), 0);
    assert.deepEqual(nftReads(read), [], 'no id of the link is read');
    await recordList(s.page);

    // Asked again on its own (2 s, then 5 s): the chain answers, with the list and the held deposit, whose tokens came
    // with the answer (no token read), and its chunk opens.
    await s.page.locator('[data-owned="ready"]').waitFor({ timeout: 20_000 });
    const seen = await listSeen(s.page);
    assert.ok(seen.every((what) => /^(?:loading|retrying:rereading|ready)$/.test(what)), `only the loading rows, the quiet line and the list: ${seen.join(' → ')}`);
    assert.deepEqual((await s.page.getByRole('tab').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()), ['Open 1', 'Closed 11']);
    await s.page.waitForFunction(() => performance.getEntriesByType('resource').some((entry) => /\/HeldDeposits-[\w-]+\.js$/.test(entry.name)));
    assert.deepEqual(read.requests.filter((r) => r.path.endsWith('/token')), [], 'the deposit’s tokens came with the chain read');

    // Another wallet, and the chain refuses every read: asked again after 2, 5 and 10 s, then one calm line.
    chain.outage = 500;
    await recordList(s.page);
    await s.wallet.switchAccount('a', 1);
    const unread = s.page.locator('[data-owned="unlisted"]');
    await unread.waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): a hidden marker, no line ("Your positions couldn’t be read right now.").
    assert.equal(await unread.locator('[data-owned-note="unread"]').innerText(), '');
    assert.doesNotMatch(await unread.innerText(), /couldn’t be read/);
    assert.equal(await unread.getAttribute('data-owned-reason'), 'chain_unavailable');
    const after = await listSeen(s.page);
    assert.ok(after.every((what) => /^(?:ready|loading|retrying:rereading|unlisted:unread)$/.test(what)), `never an empty state: ${after.join(' → ')}`);
    assert.equal(await s.page.locator('[data-owned] [data-empty]').count(), 0, 'no empty state in the card');
    assert.equal(await s.page.getByRole('button', { name: /^(Retry|Refresh|Try again|Read again)$/ }).count(), 0, 'and no Retry');
    assert.doesNotMatch(await s.page.locator('main').innerText(), /No positions/);
    assert.deepEqual(site.asked, [], 'no route of the site is asked');
    // Changed on purpose (2026-09-28): the first wallet's list, read, is kept as its display copy; the other's never was.
    assert.deepEqual(await kept(s.page), [OWNED_COPY], 'nothing about positions is kept in the browser but the list’s copy');
    assert.deepEqual(s.wallet.state.signed, [], 'nothing was signed');
  } finally { await s.close(); }
});

// 2026-09-27, the owner's OK ("pode fazer") on the study of 7074cbd: Your positions reads itself again every 30 s and a
// position's page every 5 s, while the tab is visible, with no reload: only the figures change, in place. These three
// run with the refresh on (scenario's `refresh`, window.__dominoRefresh in test builds only) on Playwright's clock, so
// one jump past a refresh's time is one refresh.

/** The wallet's SetupMinted log reads, each as the block range it asked: one per scan of its list. */
const mintedRanges = (chain) => chain.log.filter((call) => call.method === 'eth_getLogs' && call.params[0].topics?.[0] === SETUP_MINTED_TOPIC).map((call) => [Number(call.params[0].fromBlock), Number(call.params[0].toBlock)]);
/** The exact unclaimed amount the open row shows first, in its title (ETH, 18 decimals). */
const rowFees = (page) => page.locator(`a[data-position-row="${OWNED_OPEN}"] [data-cell="fees"] [data-amount]`).first().getAttribute('title');
/**
 * From now on, whether the list card ever shows its loading rows, a skeleton, its quiet line or a reason, and whether the
 * open row and the card are still the elements they were (a refresh changes them in place).
 */
// Changed on purpose 2026-10-02 (CI, PR #312): the watch starts once the card has settled. A row's Your APR is a skeleton
// while its first ledger is read; on a slow runner that first read could still be on its way when the watch began, and
// the skeleton of the first paint was then counted as a refresh's. The refresh itself must still show none.
const watchInPlace = async (page) => {
  await page.waitForFunction(() => !document.querySelector('[data-owned] .dm-skel, [data-owned] [data-owned-loading]'), undefined, { timeout: 15_000 });
  return watchInPlaceNow(page);
};
const watchInPlaceNow = (page) =>
  page.evaluate((id) => {
    const card = document.querySelector('[data-owned]');
    const row = document.querySelector(`a[data-position-row="${id}"]`);
    window.__inPlace = { loading: [], same: () => document.querySelector('[data-owned]') === card && document.querySelector(`a[data-position-row="${id}"]`) === row };
    const note = () => {
      const now = document.querySelector('[data-owned]');
      for (const what of ['[data-owned-loading]', '.dm-skel', '.dm-own-skel-band', '[data-owned-note]', '[data-empty]', '[data-owned-reason]']) {
        if (now?.matches(what) || now?.querySelector(what)) window.__inPlace.loading.push(what);
      }
    };
    new MutationObserver(note).observe(document.body, { childList: true, subtree: true, attributes: true });
  }, OWNED_OPEN);
const inPlace = (page) => page.evaluate(() => ({ loading: [...new Set(window.__inPlace.loading)], same: window.__inPlace.same() }));
/** Polls `check` in this process until it holds. */
async function until(check, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((done) => setTimeout(done, 25));
  }
}
/**
 * A scenario on Playwright's clock with the refresh on, the wallet connected and its list read once. `wallet`: a wallet
 * of the test's own ({ request, release }, tests/support/position-chain.mjs), announced as the Deposit Wallet before the
 * page loads again and connected instead of Test Wallet A, with its setup release published.
 */
async function refreshing(chain, { wallet = null } = {}) {
  const site = siteRoutes();
  const read = createReadStub();
  const s = await scenario({ clock: true, refresh: true, chain, routes: [site.route, (request, url) => read.handle(request, url)] });
  await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  if (wallet) {
    await installDepositWallet(s.context, wallet);
    s.set({ setupRelease: { status: 200, body: wallet.release } });
    await s.page.reload();
  }
  await s.page.locator('[data-empty="owned-connect"]').waitFor();
  await connectWallet(s.page, wallet ? 'Deposit Wallet' : undefined);
  await s.page.locator(`[data-owned="ready"][data-owned-block="${chain.head}"] a[data-position-row="${OWNED_OPEN}"]`).waitFor();
  // The open row's feature, read from the chain once the list is in: read before any clock jump, so every later call is the refresh's.
  await s.page.locator(`[data-position-automation="${OWNED_OPEN}"] a[data-automate-entry]`).waitFor();
  assert.equal(chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length, 1);
  return { s, site, read };
}
/**
 * From now on, whether a position's page ever shows its skeleton, its unread or its gone state, and whether it is still
 * the element it was (a refresh changes its header in place).
 */
const watchDetail = (page) =>
  page.evaluate(() => {
    const at = document.querySelector('[data-position-detail]');
    window.__detail = { loading: [], same: () => document.querySelector('[data-position-detail]') === at };
    new MutationObserver(() => {
      for (const what of ['[data-position-loading]', '[data-empty="position-unread"]', '[data-empty="position-gone"]']) if (document.querySelector(what)) window.__detail.loading.push(what);
    }).observe(document.body, { childList: true, subtree: true });
  });
const detailInPlace = (page) => page.evaluate(() => ({ loading: [...new Set(window.__detail.loading)], same: window.__detail.same() }));

// Changed on purpose (RPC-SPEC P1, 2026-10-01): the page asks the site's route for the owner alone; the edge keeps the
// wallet's SetupMinted walk (RPC-SPEC D4), so the page's own memory of the minted ids (the next scan reading only the
// recent logs) is gone, and each refresh is one POST of the owner.
test('Your positions and a position’s page read themselves again while the tab is shown: new figures in place, no loading rows or skeleton, the same answer draws nothing, and each refresh is one ask of the site’s route', async () => {
  const open = onChain(OWNED_OPEN);
  const chain = browserChain({ positions: [open, closedOnChain(OWNED_CLOSED[0])], tokens: TOKENS });
  const first = chain.head;
  const { s, site } = await refreshing(chain);
  try {
    assert.equal(await rowFees(s.page), '0.000000633825300114');
    await recordList(s.page);
    await watchInPlace(s.page);

    // Fees accrue: 30 s later the list reads the chain again and the row's figures change where they stand. 2026-10-02
    // (RPC fix round 2): the route keeps an answer 25 s (functions/_lib/owned.ts CACHE_SECONDS), a little less than the
    // list's 30 s refresh, so the refresh 30 s later reaches the node (the review's finding 14 had moved this to 41 s).
    chain.head = first + 120;
    open.unclaimed = [1_267_650_600_228n, 0n];
    await jump(s.page, '00:31');
    await s.page.locator(`[data-owned="ready"][data-owned-block="${chain.head}"]`).waitFor();
    await s.page.waitForFunction((id) => document.querySelector(`a[data-position-row="${id}"] [data-cell="fees"] [data-amount]`)?.getAttribute('title') === '0.000001267650600228', OWNED_OPEN);
    assert.equal(chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length, 2);
    assert.deepEqual(await inPlace(s.page), { loading: [], same: true }, 'the same card and row, never a loading row, a skeleton or a line');
    assert.deepEqual(await listSeen(s.page), ['ready'], 'ready all along');
    assert.equal(await s.page.locator(`a[data-position-row="${OWNED_OPEN}"]`).getAttribute('data-snapshot'), String(chain.head));
    // Each read is the site's route, asked for the owner alone (it keeps the wallet's walk itself).
    assert.equal(chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length, 2, 'two asks of the route: the first read and the refresh');

    // Nothing changed but the head: read, and nothing is drawn again (the block on screen stays the one it was read at).
    const drawn = chain.head;
    chain.head += 120;
    await jump(s.page, '00:31');
    await until(() => chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length === 3, 'the third scan');
    await s.page.waitForTimeout(300);
    assert.equal(await s.page.locator('[data-owned]').getAttribute('data-owned-block'), String(drawn), 'the same answer is not drawn again');
    assert.deepEqual(await inPlace(s.page), { loading: [], same: true });

    // A position's page shares the state reader and refreshes after five seconds, in place.
    const stateAsks = () => chain.edgeLog.filter((path) => path === '/api/fees/v1/state').length;
    const asked = stateAsks();
    await s.page.locator(`a[data-position-row="${OWNED_OPEN}"]`).click();
    const detail = s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"]`);
    await detail.locator('[data-stat="price"] [data-current-price="usable"]').waitFor();
    const fees = () => detail.locator('[data-stat="fees"] [data-amount]').first().getAttribute('title');
    // The list's warm row paints first at its head. Wait for the page's own answer before measuring the following minute's
    // refresh. Changed on purpose 2026-10-01 (fees item A21): the page reads at the block its first call ran at, the head
    // here as the row's, where it read head − 2 before: its own read is told by its NFT asked of the chain again.
    // Changed on purpose 2026-10-14 (incident 2026-10-13, design 2.5, package Q1): told by its question to the state route,
    // which the edge may answer from the list's read of a moment before (a batch's answer is kept per NFT for 5 s), so
    // without asking the chain again.
    await until(() => stateAsks() > asked, 'the page’s own read');
    await s.page.waitForTimeout(300);
    await s.page.waitForFunction((block) => document.querySelector('[data-position-detail]')?.getAttribute('data-snapshot') === String(block), chain.head);
    assert.equal(await fees(), '0.000001267650600228');
    const read = await detail.getAttribute('data-snapshot');
    await watchDetail(s.page);
    chain.head += 120;
    open.unclaimed = [2_535_301_200_456n, 0n];
    await jump(s.page, '00:02');
    await s.page.waitForTimeout(300);
    assert.equal(await detail.getAttribute('data-snapshot'), read, 'not before the five-second refresh');
    await jump(s.page, '00:04');
    await s.page.waitForFunction((block) => document.querySelector('[data-position-detail]')?.getAttribute('data-snapshot') === String(block), chain.head);
    await s.page.waitForFunction(() => document.querySelector('[data-position-detail] [data-stat="fees"] [data-amount]')?.getAttribute('title') === '0.000002535301200456');
    assert.deepEqual(await detailInPlace(s.page), { loading: [], same: true }, 'the same page, never the skeleton');
    assert.deepEqual(site.asked, [], 'no route of the site is asked');
    assert.deepEqual([chain.refused, chain.missing], [[], []]);
    assert.deepEqual(s.wallet.state.signed, [], 'nothing was signed');
  } finally { await s.close(); }
});

test('a hidden tab asks nothing: the list’s refresh waits while the tab is hidden and runs once when it is shown again', async () => {
  const open = onChain(OWNED_OPEN);
  const chain = browserChain({ positions: [open], tokens: TOKENS });
  const { s } = await refreshing(chain);
  try {
    await setVisibility(s.page, 'hidden');
    const asked = chain.log.length;
    chain.head += 120;
    open.unclaimed = [1_267_650_600_228n, 0n];
    await jump(s.page, '00:31');
    await jump(s.page, '10:00');
    await s.page.waitForTimeout(500);
    assert.deepEqual(chain.log.slice(asked).map((call) => call.method), [], 'nothing is asked of the chain while the tab is hidden');
    assert.equal(await rowFees(s.page), '0.000000633825300114');
    await setVisibility(s.page, 'visible');
    await until(() => chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length === 2, 'the refresh once the tab is shown');
    await s.page.waitForFunction((id) => document.querySelector(`a[data-position-row="${id}"] [data-cell="fees"] [data-amount]`)?.getAttribute('title') === '0.000001267650600228', OWNED_OPEN);
    await s.page.waitForTimeout(500);
    assert.equal(chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length, 2, 'once');
  } finally { await s.close(); }
});

test('a failed refresh keeps the figures: no loading rows, no line and no reason over them, not asked again at 2, 5 or 10 s nor at 30 s but after 60 s, and drawn once the chain answers', async () => {
  const open = onChain(OWNED_OPEN);
  const chain = browserChain({ positions: [open], tokens: TOKENS });
  const { s } = await refreshing(chain);
  try {
    await recordList(s.page);
    await watchInPlace(s.page);
    const ownedReads = () => chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length;
    chain.outage = 500;
    // 2026-10-02 (RPC fix round 2): the route keeps the first answer 25 s, so the refresh 30 s later reaches the node.
    await jump(s.page, '00:31');
    await until(() => ownedReads() === 2, 'the inventory refresh the chain refused');
    await s.page.waitForTimeout(500);
    const card = s.page.locator('[data-owned]');
    assert.deepEqual([await card.getAttribute('data-owned'), await card.getAttribute('data-owned-reason'), await card.getAttribute('data-owned-block')], ['ready', null, String(chain.head)]);
    assert.equal(await rowFees(s.page), '0.000000633825300114', 'the figures on screen stay');
    assert.deepEqual(await inPlace(s.page), { loading: [], same: true });
    assert.deepEqual(await listSeen(s.page), ['ready']);
    assert.equal(await s.page.getByRole('button', { name: /^(Retry|Refresh|Try again|Read again)$/ }).count(), 0, 'and no Retry');

    // 31 s later (past the quick waits and the list's own 30 s): not asked again.
    await jump(s.page, '00:31');
    await s.page.waitForTimeout(500);
    // Changed on purpose 2026-09-28 (speed wave B, item 23): the list's first call is its head and nonce's aggregate3.
    assert.equal(ownedReads(), 2, 'inventory is not asked again before 60 s; independent fee reads do not alter its retry');
    // Past 60 s: asked again, and this time the chain answers.
    chain.outage = null;
    chain.head += 120;
    open.unclaimed = [1_267_650_600_228n, 0n];
    await jump(s.page, '00:31');
    await s.page.locator(`[data-owned="ready"][data-owned-block="${chain.head}"]`).waitFor();
    assert.equal(await rowFees(s.page), '0.000001267650600228');
    assert.deepEqual(await inPlace(s.page), { loading: [], same: true });
    assert.deepEqual(await listSeen(s.page), ['ready']);
    assert.equal(chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length, 3, 'the route asked three times: the first read, the refresh it could not answer, the one it did');
  } finally { await s.close(); }
});

// The review of 2026-09-27: a position's page stopped reading itself for good after a short outage (its tick fell back
// to the 3/12/30 s waits, then ended), which left its header stale for the rest of the visit. Once it shows a position,
// a failed refresh keeps its header while the shared reader retries with bounded backoff. Retry-After remains
// authoritative even when the normal five-second poll is due.
test('a position’s page keeps its header through failures and missing reads, honors Retry-After, and recovers in place without ending its retries', async () => {
  const open = onChain(OWNED_OPEN);
  const chain = browserChain({ positions: [open], tokens: TOKENS });
  const { s } = await refreshing(chain);
  try {
    const stateAsks = () => chain.edgeLog.filter((path) => path === '/api/fees/v1/state').length;
    const asked = stateAsks();
    await s.page.locator(`a[data-position-row="${OWNED_OPEN}"]`).click();
    const detail = s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"]`);
    await detail.locator('[data-stat="price"] [data-current-price="usable"]').waitFor();
    const header = async () => [await detail.getAttribute('data-snapshot'), await detail.locator('[data-stat="fees"] [data-amount]').first().getAttribute('title')];
    /**
     * The header once it shows the chain's head and these fees. Changed on purpose 2026-10-01 (fees item A21): read at the
     * block its first call ran at (the head, as the list's row), where it was read at head − 2; the page's own first read
     * is told by its NFT asked of the chain again.
     */
    const drawn = (fees) => s.page.waitForFunction(([block, title]) => {
      const page = document.querySelector('[data-position-detail]');
      return page?.getAttribute('data-snapshot') === String(block) && page.querySelector('[data-stat="fees"] [data-amount]')?.getAttribute('title') === title;
    }, [chain.head, fees]);
    // Changed on purpose 2026-10-14 (incident 2026-10-13, design 2.5, package Q1): the page's own first read is told by its
    // question to the state route, which the edge may answer from the list's read of a moment before (a batch's answer is
    // kept per NFT for 5 s), so without asking the chain again.
    await until(() => stateAsks() > asked, 'the page’s own read');
    await s.page.waitForTimeout(300);
    await drawn('0.000000633825300114');
    assert.deepEqual(await header(), [String(chain.head), '0.000000633825300114']);
    // A cold ledger now discovers bounded windows, each carrying newer state. Finish that independent read first:
    // this scenario measures the header's own refresh/retry schedule, not a concurrently advancing ledger cursor.
    await s.page.waitForFunction(() => {
      const last = document.querySelector('[data-history-source]')?.getAttribute('data-ledger-last');
      return last && !['reading', 'unanswered', 'unavailable', 'rate_limited'].includes(last);
    }, undefined, { timeout: 15_000 });
    await watchDetail(s.page);
    let stateUnavailable = false;
    let stateRequests = 0;
    await s.context.route((url) => url.pathname === '/api/fees/v1/state', async (route) => {
      stateRequests++;
      if (stateUnavailable) return route.fulfill({ status: 503, headers: { 'Retry-After': '10', 'Cache-Control': 'no-store' }, contentType: 'application/json', body: JSON.stringify({ v: 1, error: 'source_unavailable' }) });
      return route.fallback();
    });
    const refused = [];
    const down = () => { chain.outage = (call) => (refused.push(call.method), 500); };
    /** From now on, whether one more read was refused, or asked for the NFT (ownerOf). */
    const refusedOnce = () => { const n = refused.length; return () => refused.length > n; };
    const readOnce = () => { const n = chain.asked.get(OWNED_OPEN) ?? 0; return () => (chain.asked.get(OWNED_OPEN) ?? 0) > n; };
    /** Jumps the clock, waits for the read it set off (`done`), and lets the page take its answer. */
    const leap = async (ticks, done = () => true) => {
      await jump(s.page, ticks);
      await until(done, `the read after ${ticks}`);
      await s.page.waitForTimeout(1_000);
    };

    // A ten-second Retry-After must beat the five-second poll even when the service recovers immediately.
    stateUnavailable = true;
    await leap('00:06', () => stateRequests === 1);
    const shown = await header();
    stateUnavailable = false;
    chain.head += 120;
    open.unclaimed = [1_267_650_600_228n, 0n];
    await leap('00:04');
    assert.equal(stateRequests, 1, 'the normal poll does not bypass Retry-After');
    assert.deepEqual(await header(), shown, 'verified figures stay during the required wait');
    await jump(s.page, '00:06');
    await drawn('0.000001267650600228');

    // Eight refreshes in a row that fail: the RPC's 500s, then four reads of an NFT its node does not know (not_found),
    // then the 500s three more times. The old page ended its reads at the fourth not_found (after three quick asks), and
    // at the fourth failure (its tick and three retries); bounded retry backoff keeps asking and eventually draws the
    // chain's answer in place. Each leap is beyond the maximum applicable wait, with no fabricated zero in between.
    const kept = await header();
    down();
    await leap('01:01', refusedOnce());
    chain.outage = null;
    open.burned = true;
    await leap('01:01', readOnce());
    for (let i = 0; i < 3; i++) await leap('02:01', readOnce());
    open.burned = false;
    down();
    for (let i = 0; i < 3; i++) await leap('02:01', refusedOnce());
    assert.deepEqual(await header(), kept, 'the header stays through them all');
    chain.outage = null;
    chain.head += 120;
    open.unclaimed = [2_535_301_200_456n, 0n];
    await jump(s.page, '02:01');
    await drawn('0.000002535301200456');
    assert.deepEqual(await detailInPlace(s.page), { loading: [], same: true }, 'the same page all along: never the skeleton, the unread or the gone state');
    assert.equal(await s.page.getByRole('button', { name: /^(Retry|Refresh|Try again|Read again)$/ }).count(), 0, 'and no Retry');
  } finally { await s.close(); }
});

// The study's risk 4 (2026-09-27 review): a refresh must never unmount the held deposits mid-refund. HeldDeposits says
// when a refund is on its way (onBusy) and OwnedPositions holds the list's refresh until it is over.
test('a held deposit’s refund holds the list’s refresh: nothing is read while the wallet is asked, the deposit and its line stay, and the list is read again once the refund is over, then every 30 s', async () => {
  const key = { currency0: zeroAddress, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  const deposit = { key, balance0: 0n, balance1: 100000n };
  const chain = browserChain({ positions: [onChain(OWNED_OPEN)], tokens: { ...TOKENS, [USDG]: { symbol: 'USDG', decimals: 6 } }, deposits: { [OWNER]: [deposit] } });
  // The wallet: a chain of its own that holds the same deposit, under the operation id the list read, and refunds it.
  // Its prompt to send is held until the test lets it go, as a person reading it in their wallet would.
  const wallet = createPositionChain(OWNER, { deposits: [{ key, balance0: 0n, balance1: 100000n }], timestamp: chain.timestamp });
  const operationId = opIdOf(OWNER, 0);
  wallet.operations.set(operationId, wallet.operations.get(wallet.operationId(0n)));
  let prompt = null, confirm;
  const confirmed = new Promise((done) => (confirm = done));
  const request = async (method, params) => {
    if (method === 'eth_sendTransaction') {
      prompt = params[0];
      await confirmed;
    }
    return wallet.request(method, params);
  };
  const { s } = await refreshing(chain, { wallet: { request, release: wallet.release } });
  try {
    const card = s.page.locator('[data-held-deposits]');
    const row = card.locator(`[data-held-deposit="${operationId}"]`);
    await row.waitFor();
    await card.getByRole('button', { name: 'Refund to wallet', exact: true }).click();
    await until(() => prompt !== null, 'the wallet asked to send the refund');
    assert.equal(await row.locator('[data-held-progress="wallet"]').innerText(), 'Confirm in your wallet…');

    // Two of the list's 30 s refreshes fall due while the wallet is asked (the refund's button is busy): neither reads,
    // not even the head a scan starts with.
    const asked = chain.log.length;
    await jump(s.page, '00:31', { pending: true });
    await jump(s.page, '00:31', { pending: true });
    await s.page.waitForTimeout(1_000);
    assert.deepEqual(chain.log.slice(asked).map((call) => call.method), [], 'no refresh while the refund is on its way');
    assert.equal(chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length, 1);
    assert.equal(await row.locator('[data-held-progress="wallet"]').count(), 1, 'the deposit and its line stay');

    // Confirmed: the refund is sent and included, and the list is read again at once, without the deposit.
    deposit.closed = true;
    confirm();
    await until(() => chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length === 2, 'the list read again once the refund is over', 30_000);
    assert.deepEqual([wallet.sends.length, wallet.paid], [1, [{ to: OWNER, currencies: [zeroAddress, USDG], amounts: [0n, 100000n] }]]);
    await card.waitFor({ state: 'detached' });
    await s.page.locator(`[data-owned="ready"] a[data-position-row="${OWNED_OPEN}"]`).waitFor();
    // And the refresh goes on at its own pace.
    await jump(s.page, '00:31');
    await until(() => chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length === 3, 'the refresh 30 s later');
    assert.deepEqual([wallet.refused, wallet.missing], [[], []], 'the wallet was asked only what it answers');
    assert.deepEqual([chain.refused, chain.missing], [[], []]);
  } finally { await s.close(); }
});

test('an initial position read failure recovers from the fees store before the page retries, without connecting a wallet', async () => {
  const chain = browserChain({ positions: [onChain(OWNED_OPEN)], tokens: TOKENS });
  const fetch = chain.fetch;
  let heads = 0;
  let held = false;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  chain.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    // Changed on purpose 2026-10-01 (fees item A21): a position's state read asks no eth_blockNumber any more: its first
    // call is an aggregate3 at 'latest' (its block named by ArbSys). The first one (the read warmed for the page) fails;
    // the later ones (the fees store's own) are held.
    if (body.method === 'eth_call' && body.params?.[1] === 'latest') {
      heads += 1;
      if (heads === 1) return new Response('Unavailable', { status: 500 });
      // Loading -> failed replaces the FeesCard subscription. Its cancelled read can remain in this mock while
      // the new consumer starts a replacement; hold all recovery reads, not just that abandoned second request.
      held = true;
      await gate;
    }
    return fetch(url, init);
  };
  const s = await scenario({ chain, clock: true, refresh: true });
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    await s.page.evaluate((id) => { location.hash = `#/positions/${id}`; }, OWNED_OPEN);
    await s.page.locator('[data-empty="position-unread"]').waitFor();
    await until(() => held, 'the fees store’s independent state read');
    // Pause only after both reads started (the RPC runtime has a brief
    // startup handshake). The held store answer, not the page's pending
    // three-second retry, must recover this header.
    await s.page.clock.pauseAt(new Date(await s.page.evaluate(() => Date.now() + 100)));
    assert.equal(await s.page.locator('[data-position-detail]').count(), 0);
    release();
    const detail = s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"][data-snapshot="${chain.head}"]`);
    await detail.waitFor({ timeout: 10_000 });
    assert.equal(await s.page.locator('[data-empty="position-unread"]').count(), 0);
    assert.equal(await detail.locator('[data-cell="apr"]').count(), 1, 'Your APR is mounted again with the recovered position');
    assert.equal(await detail.locator('[data-position-actions]').count(), 0, 'public state is not an authenticated wallet');
    assert.deepEqual(s.wallet.state.signed, []);
  } finally { release(); await s.close(); }
});

test('a different NFT’s stored state cannot populate a missing position or replace its confirmed absence', async () => {
  const MISSING = '919191';
  const chain = browserChain({ positions: [onChain(OWNED_OPEN)], tokens: TOKENS });
  const s = await scenario({ chain, clock: true, refresh: true });
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    await s.page.evaluate((id) => { location.hash = `#/positions/${id}`; }, OWNED_OPEN);
    // Changed on purpose 2026-10-01 (fees item A21): the page reads at the block its first call ran at, the head here.
    await s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"][data-snapshot="${chain.head}"]`).waitFor();
    await s.page.evaluate((id) => { location.hash = `#/positions/${id}`; }, MISSING);
    // Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the page asks the NFT's state and its ledger together, each of which
    // reads it once.
    await until(() => (chain.asked.get(MISSING) ?? 0) >= 1, 'the first missing-NFT read');
    assert.equal(await s.page.locator('[data-position-detail]').count(), 0, 'the previous position’s cached values never cross identities');
    // Changed on purpose 2026-10-01 (fees item D5): an id below PositionManager.nextTokenId that the chain does not show was
    // minted and burned: said at once, where the page asked it again at 4, 9 and 13 s before saying so.
    const gone = s.page.locator('[data-empty="position-gone"]');
    await gone.waitFor();
    assert.match(await gone.innerText(), new RegExp(`NFT #${MISSING} was not found`));
    await jump(s.page, '02:01');
    assert.equal(await gone.count(), 1, 'a confirmed absence stays absent');
    assert.equal(await s.page.locator('[data-position-detail], [data-position-actions]').count(), 0);
    // And an id far past nextTokenId was never minted: no position with that number, said at once (item D5).
    const NEVER = '99999999';
    await s.page.evaluate((id) => { location.hash = `#/positions/${id}`; }, NEVER);
    const missing = s.page.locator('[data-empty="position-missing"]');
    await missing.waitFor();
    assert.match(await missing.innerText(), new RegExp(`No position #${NEVER} was found`));
    assert.equal(await s.page.locator('[data-empty="position-gone"], [data-position-detail]').count(), 0, 'never “no longer exists” for an id never minted');
    assert.deepEqual(s.wallet.state.signed, []);
  } finally { await s.close(); }
});

/** Someone else's wallet: the NFTs a visitor who is not their owner opens. */
const OTHER_OWNER = '0x3333333333333333333333333333333333333333';

// Review of 2026-09-25: Create position opens #/positions/<id> 3 s after the mint. 2026-09-24: the page reads two blocks
// behind the head: an NFT the chain does not show yet is asked again (3, 8, 12 s) with the skeleton kept, before the page
// says it no longer exists.
test('a position’s page asks an NFT the chain does not show yet again, the skeleton kept, and shows the position once it is there', async () => {
  const NEW = '4242';
  const chain = browserChain({ positions: [onChain(NEW, { holder: OTHER_OWNER, from: 1 })], tokens: TOKENS });
  const s = await scenario({ chain });
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    // Everything the page draws on the way, recorded as it happens.
    await s.page.evaluate((id) => {
      window.__positionSeen = [];
      const note = (what) => { if (window.__positionSeen.at(-1) !== what) window.__positionSeen.push(what); };
      new MutationObserver(() => {
        if (document.querySelector('[data-empty="position-gone"]')) note('gone');
        else if (document.querySelector('[data-position-detail]')) note('position');
        else if (document.querySelector('[data-position-loading]')) note('loading');
      }).observe(document.body, { childList: true, subtree: true, attributes: true });
      location.hash = `#/positions/${id}`;
    }, NEW);
    const pageAsks = () => chain.asked.get(NEW) ?? 0;
    for (let i = 0; i < 100 && pageAsks() === 0; i++) await s.page.waitForTimeout(50);
    await s.page.waitForTimeout(700);
    assert.equal(await s.page.locator('[data-position-loading]').count(), 1, 'the skeleton stays while the NFT is asked again');
    assert.equal(await s.page.locator('[data-empty="position-gone"]').count(), 0, 'nothing says it no longer exists');
    const detail = s.page.locator(`[data-position-detail][data-position-id="${NEW}"]`);
    await detail.waitFor({ timeout: 10_000 });
    assert.deepEqual(await s.page.evaluate(() => window.__positionSeen), ['loading', 'position'], 'the skeleton, then the position, and never the empty state');
    assert.match(await detail.locator('h1').innerText(), /^ETH\s*\/\s*TOKEN$/);
  } finally { await s.close(); }
});

// Review of 2026-09-25: the page offered "Add to this pool" (#/new/<poolId>) for a pool with hooks or a dynamic fee, which
// New position refuses on arrival with nothing preselected. It links only to a pool Domino can open a position in. (A pool
// with hooks is one the chain read names as such: its page says its details could not be read, with no link at all.)
test('a position’s page offers New position in this pool only for a pool with no hooks and a fixed fee', async () => {
  const [PLAIN, HOOKED, DYNAMIC] = ['4242', '4243', '4244'];
  const chain = browserChain({
    positions: [onChain(PLAIN, { holder: OTHER_OWNER }), onChain(HOOKED, { holder: OTHER_OWNER, key: { ...STUB_KEY, hooks: `0x${'4a'.repeat(20)}` } }), onChain(DYNAMIC, { holder: OTHER_OWNER, key: { ...STUB_KEY, fee: 8388608 } })],
    tokens: TOKENS,
  });
  const s = await scenario({ chain });
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    const links = {};
    for (const id of [PLAIN, DYNAMIC]) {
      await s.page.evaluate((next) => { location.hash = `#/positions/${next}`; }, id);
      const detail = s.page.locator(`[data-position-detail][data-position-id="${id}"]`);
      await detail.waitFor({ timeout: 10_000 });
      links[id] = await detail.locator('.dm-pos-links a').evaluateAll((all) => all.map((a) => a.textContent));
    }
    // 2026-09-24: Automate is the owner's own action in the title row now (and never for a pool a sequence refuses).
    assert.deepEqual(links, { [PLAIN]: ['Pool', 'New position in this pool'], [DYNAMIC]: ['Pool'] });
    assert.equal(await s.page.locator('a[data-automate-entry]').count(), 0, 'someone else’s position offers no Automate');
    await s.page.evaluate((next) => { location.hash = `#/positions/${next}`; }, HOOKED);
    const hooked = s.page.locator('[data-position-reason="hooked_pool"]');
    await hooked.waitFor({ timeout: 10_000 });
    assert.equal(await s.page.locator('.dm-pos-links a').count(), 0, 'a pool with hooks: no link');
    assert.equal(await s.page.locator('a[href^="/new/"]').count(), 0, 'no way into New position with the dynamic-fee or hooked pool on its page');
  } finally { await s.close(); }
});

// Review of 2026-09-25: every visitor of a position's page downloaded the owner's actions chunk (Collect fees, Close
// position and the setup client under them, about 27.5 kB gzip), which then drew nothing for anyone but the owner. The
// page opens it only for the NFT's owner, connected on Robinhood Chain.
test('a position’s page downloads the owner’s actions only for the owner’s wallet: not with no wallet, not for someone else’s NFT', async () => {
  const [THEIRS, MINE] = ['4242', '4243'];
  const chain = browserChain({ positions: [onChain(THEIRS, { holder: OTHER_OWNER }), onChain(MINE)], tokens: TOKENS });
  const s = await scenario({ chain });
  const chunks = [];
  s.page.on('request', (request) => {
    const name = new URL(request.url()).pathname.split('/').pop();
    if (/^PositionActions-/.test(name)) chunks.push(name);
  });
  /** Opens `id`'s page and waits until it has drawn, its pool price included. */
  const open = async (id) => {
    await s.page.evaluate((next) => { location.hash = `#/positions/${next}`; }, id);
    const detail = s.page.locator(`[data-position-detail][data-position-id="${id}"]`);
    await detail.waitFor({ timeout: 10_000 });
    await detail.locator('[data-stat="price"] [data-current-price]').waitFor();
    await s.page.waitForTimeout(300);
    return detail;
  };
  /** Shows `address`'s list read-only (the Wallet card's View address), so the position opened next is opened from it. */
  const viewList = async (address) => {
    await s.page.evaluate((next) => { location.hash = `#/portfolio/${next}`; }, address);
    await s.page.locator(`[data-owned-viewed="${address}"]`).waitFor({ timeout: 15_000 });
  };
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    // No wallet: the wallet's own NFT is a public page, with no actions and nothing of them downloaded.
    await open(MINE);
    assert.deepEqual(chunks, [], 'no wallet: the actions chunk is not requested');
    assert.equal(await s.page.locator('[data-position-actions]').count(), 0);
    // Added 2026-10-30 (QA round 2, N43): opened from a link, nothing says whose the actions are (the holder may be a Domino
    // vault, which nobody connects); opened from the holder's own list (View address), one quiet line says it.
    assert.equal(await s.page.locator('[data-position-owner-only]').count(), 0, 'opened from a link: no line');
    await viewList(OWNER);
    await open(MINE);
    assert.match(await s.page.locator('[data-position-owner-only="no-wallet"]').innerText(), /^Connect the owner wallet [\s\S]+ to collect fees, add or close\.$/);
    assert.deepEqual(chunks, [], 'opened from the list: still not requested');
    // An NFT that address does not hold (as a Domino-compound successor is its vault's, not its list's address): no line.
    await open(THEIRS);
    assert.equal(await s.page.locator('[data-position-owner-only]').count(), 0, 'held by another address than the list’s: no line');
    // Connected, on someone else's NFT: still nothing.
    await viewList(OTHER_OWNER);
    await open(THEIRS);
    await connectWallet(s.page);
    await s.page.waitForTimeout(500);
    assert.deepEqual(chunks, [], 'someone else’s NFT: not requested either');
    assert.equal(await s.page.locator('[data-position-actions]').count(), 0);
    await s.page.locator('[data-position-owner-only="other-wallet"]').waitFor();
    assert.match(await s.page.locator('[data-position-owner-only]').innerText(), /^Only the owner wallet [\s\S]+ can collect fees, add or close\.$/);
    // The wallet's own NFT: its actions, and their chunk.
    await open(MINE);
    await s.page.locator('.dm-pos-actions[data-position-actions]').waitFor();
    assert.equal(await s.page.locator('[data-position-owner-only]').count(), 0, 'the owner reads no such line');
    await s.page.waitForFunction(() => performance.getEntriesByType('resource').some((entry) => /\/PositionActions-[\w-]+\.js$/.test(entry.name)));
    assert.equal(chunks.length, 1, 'requested once, for the owner');
    assert.deepEqual(s.wallet.state.signed, [], 'nothing was signed');
  } finally { await s.close(); }
});

// Review of 2026-09-24 (the three features): a position's page offered its owner Automate for any open NFT in a pool with
// no hooks and a fixed fee, one opened elsewhere included, and the automation page, which lists only the wallet's own
// Domino positions, then said "No open positions" (and asked the wallet's list again, fresh). Automate, and the Plain
// position pill, are offered only for a position the automation page lists; a sequence's state is still said to anyone.
test('a position’s page offers Automate and says Plain position only for one of the wallet’s own open Domino positions: not for an NFT it opened elsewhere, not for a closed one, and the list is not read again for it', async () => {
  const ELSEWHERE = '2827280';
  // The wallet holds ELSEWHERE too, open, in the same usable pool; DominoSetupV1 minted it to someone else.
  const chain = browserChain({ positions: [onChain(OWNED_OPEN), ...OWNED_CLOSED.map((id) => closedOnChain(id)), onChain(ELSEWHERE, { minter: OTHER_OWNER })], tokens: TOKENS });
  const s = await scenario({ chain });
  /** Opens `id`'s page as its owner and waits until its actions and the wallet's list are in. */
  const open = async (id) => {
    await s.page.evaluate((next) => { location.hash = `#/positions/${next}`; }, id);
    const detail = s.page.locator(`[data-position-detail][data-position-id="${id}"]`);
    await detail.waitFor({ timeout: 10_000 });
    await detail.locator('[data-position-actions] button').first().waitFor({ timeout: 10_000 });
    await s.page.waitForTimeout(600);
    return detail;
  };
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    await connectWallet(s.page);
    await s.page.locator('[data-owned="ready"]').waitFor();

    // One of the wallet's Domino positions, open: Automate beside the owner's actions, and its feature beside its range.
    const mine = await open(OWNED_OPEN);
    await mine.locator('[data-position-actions] a[data-automate-entry]').waitFor();
    assert.equal(await mine.locator('[data-position-actions] a[data-automate-entry]').getAttribute('href'), `/sequence/${OWNED_OPEN}`);
    assert.equal(await mine.locator('.dm-pos-chips [data-automation="plain"]').innerText(), 'Plain position');

    // The wallet holds this NFT, open, in the same usable pool, but did not open it with Domino: the owner's actions
    // stay, and nothing says Plain position or offers Automate, which would lead to a page that does not list it.
    const elsewhere = await open(ELSEWHERE);
    assert.ok(await elsewhere.getByRole('button', { name: 'Close position' }).count() > 0, 'the owner’s own actions are there');
    assert.equal(await elsewhere.locator('a[data-automate-entry]').count(), 0, 'no Automate for an NFT opened elsewhere');
    assert.equal(await elsewhere.locator('.dm-pos-chips [data-automation]').count(), 0, 'and no Plain position pill');

    // Closed, though one of the wallet's: no Automate and no pill, as its row on Positions has no line either.
    const closed = await open(OWNED_CLOSED[0]);
    assert.equal(await closed.locator('[data-position-status]').innerText(), 'Closed');
    assert.equal(await closed.locator('a[data-automate-entry], .dm-pos-chips [data-automation]').count(), 0);

    // A link to the automation page for the NFT opened elsewhere (typed, or kept from before): its list is the wallet's
    // Domino positions, and a missing id that no New position made here is not asked for again, fresh.
    const before = chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length;
    await s.page.evaluate((id) => { location.hash = `#/sequence/${id}`; }, ELSEWHERE);
    // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §8): with Domino V2 in the build the page never waits for V1's
    // release, so its own mount (src/v2in/automate/SetupEntry.tsx) may be what it draws first.
    await s.page.locator('main.dm-seq :is([data-sequence-release], [data-v2in-setup])').first().waitFor({ timeout: 10_000 });
    await s.page.waitForTimeout(1_000);
    // Changed on purpose 2026-09-28 (speed wave B, item 18): the wallet's list read a moment ago on Positions is this
    // visit's, kept in the page's memory: the automation page takes it and reads it neither once more nor for an id it lacks.
    assert.equal(chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length - before, 0, 'the wallet’s list kept from Positions, not read again, and not for an id it lacks');
    assert.deepEqual(s.wallet.state.signed, [], 'nothing was signed');
  } finally { await s.close(); }
});

// Review of 2026-09-24 (the three features): once a position existed, New position rested on its success until the person
// left the page. Back was hidden, every step locked, and the footer's or the menu's New position (the very hash already
// open) did nothing. It now opens a fresh flow at the first step. The new position's page, opened next with a list the
// endpoint kept from before the mint, asks that list again, fresh, once, and then offers Automate.
test('after a success, New position in the footer opens a fresh flow at step 1; the new position’s page asks the wallet’s list again, fresh, once, and offers Automate', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { tokenId: 4243n, finality: 'lagging' });
  chain.seed({ key: STUB_POOL_KEY, balance0: 2_000_000n, balance1: 1_000_000n });
  const s = await atReview(chain);
  // The RPC's first read of the wallet's list comes from a node behind the mint, as a load-balanced RPC may: it lacks the
  // new NFT; any later read has it.
  let behind = true;
  s.rpc.history = (filter) => (behind && filter.topics?.[0] === SETUP_MINTED_TOPIC ? ((behind = false), []) : null);
  try {
    await s.page.locator('[data-create-position="idle"]').click();
    await s.page.locator('[data-create-position="held"]').click({ timeout: 60_000 });
    const next = s.page.locator('[data-created-position="4243"]');
    await next.waitFor({ timeout: 60_000 });
    assert.equal(await s.page.evaluate(() => location.pathname + location.hash), '/new');
    assert.equal(await s.page.locator('li[data-step="review"][data-state="current"]').count(), 1);
    // The done steps above the offer are not locked: each still opens (and leaving Review ends the offer).
    assert.deepEqual(await s.page.locator('li[data-step-done] button.dm-flow-row').evaluateAll((rows) => rows.map((row) => row.disabled)), [false, false, false]);

    // The footer's New position is the hash already open: it starts again at the first step, with nothing chosen.
    await s.page.locator('footer').getByRole('link', { name: 'New position', exact: true }).click();
    await next.waitFor({ state: 'detached', timeout: 10_000 });
    await s.page.locator('li[data-step="pool"][data-state="current"]').waitFor({ timeout: 10_000 });
    assert.equal(await s.page.evaluate(() => location.pathname + location.hash), '/new', 'the same page');
    assert.equal(await s.page.locator('li[data-step-done], [data-create-position], [data-created-position]').count(), 0, 'no step done, no Create position, no offer');
    assert.ok(await s.page.evaluate(() => window.scrollY) < 200, 'at the top of the page');
    assert.equal(chain.sends.length, 1, 'nothing more was sent');

    // The position's own page: the list kept from before the mint lacks it, so it is asked once more, fresh, and Automate
    // is offered once that answer names it.
    await s.page.evaluate(() => { location.hash = '#/positions/4243'; });
    const detail = s.page.locator('[data-position-detail][data-position-id="4243"]');
    await detail.waitFor({ timeout: 30_000 });
    await detail.locator('[data-position-actions] a[data-automate-entry]').waitFor({ timeout: 20_000 });
    assert.equal(await detail.locator('[data-position-actions] a[data-automate-entry]').getAttribute('href'), '/sequence/4243');
    assert.equal(await detail.locator('.dm-pos-chips [data-automation="plain"]').innerText(), 'Plain position');
    // Changed on purpose 2026-10-01 (RPC-SPEC D4): the edge reads the wallet's ids from DominoSetupV1's state, which a
    // node's lagging SetupMinted logs do not hide (they give only the mint's block, functions/_lib/ownedMints.ts): the
    // list read after the mint names the new position, and it is asked once more only while the kept list lacks it.
    const asked = s.rpc.edgeLog.filter((path) => path === '/api/owned/v2/positions').length;
    assert.ok(asked >= 1 && asked <= 2, `the list, read again at most once (${asked})`);
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
});

// 2026-09-24 (the three features): a position already in a sequence says which one and whether it runs, on its row and
// on its page, and offers no Automate. Review of the same day: a sequence that does not run offers its next step, the
// docs on switching it on (the automation page's own link once a sequence is set up), instead of nothing.
test('a paused Auto-compound says so on its row and its page, offers how to switch it on and no Automate, beside a plain position that offers Automate', async () => {
  const PLAIN = '3135289';
  const VAULT = `0x${'5a'.repeat(20)}`;
  // Changed on purpose (2026-09-25): the feature is read from the chain by the page itself, no longer from the site's
  // POST /api/automation/v1/state: OWNED_OPEN's subscriber is a vault Domino's factory made, rooted at it, at 2% (Auto-
  // compound) and paused; PLAIN has no subscriber.
  const chain = browserChain({
    positions: [onChain(OWNED_OPEN, { subscriber: VAULT }), onChain(PLAIN)],
    tokens: TOKENS,
    vaults: { [VAULT]: { root: OWNED_OPEN, feeBps: 200, paused: true, valid: true } },
  });
  const site = siteRoutes();
  const s = await scenario({ chain, routes: [site.route] });
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    await connectWallet(s.page);
    const paused = s.page.locator(`[data-position-automation="${OWNED_OPEN}"][data-automation="compound"]`);
    await paused.waitFor();
    assert.equal(await paused.getAttribute('data-automation-state'), 'paused');
    // Changed on purpose (the owner, round 6, 2026-09-27: one tidy row, a small badge): the row says Auto-compound and,
    // under it, Paused; how to switch it on is its page's (below), no longer a link on the row.
    assert.match(await paused.innerText(), /^Auto-compound\s+Paused$/);
    // Changed on purpose (2026-09-28, review: a click on the badge is the row's): no tooltip on the cell; Paused is written.
    assert.equal(await paused.getAttribute('title'), null);
    assert.equal(await paused.locator('a').count(), 0, 'no second sequence on it, and no link on the row');
    const plain = s.page.locator(`[data-position-automation="${PLAIN}"][data-automation="plain"]`);
    await plain.locator('a[data-automate-entry]').waitFor();
    assert.equal(await plain.locator('a[data-automate-entry]').getAttribute('href'), `/sequence/${PLAIN}`);

    await s.page.evaluate((id) => { location.hash = `#/positions/${id}`; }, OWNED_OPEN);
    const detail = s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"]`);
    await detail.waitFor({ timeout: 10_000 });
    await detail.locator('[data-position-actions] a[data-automate-docs]').waitFor({ timeout: 10_000 });
    assert.equal(await detail.locator('.dm-pos-chips [data-automation="compound"]').innerText(), 'Auto-compound · Paused');
    assert.deepEqual(await detail.locator('[data-position-actions] a').evaluateAll((links) => links.map((a) => [a.textContent, a.getAttribute('href')])), [['How to switch it on', '/docs/auto-compound#where-it-starts']]);
    assert.doesNotMatch(await detail.innerText(), FORBIDDEN);
    // Read by the page from the chain: the subscribers, then the vault's factory check, root, policy and permission.
    const reads = chain.log.filter((call) => call.method === 'eth_call').map((call) => call.params[0].data);
    assert.ok(reads.some((data) => data.includes('16a24131')), 'the subscriber of each NFT');
    assert.ok(reads.some((data) => data.includes('652b9b41') && data.includes('0505c8c9')), 'and the vault, once');
    assert.deepEqual([site.asked, chain.missing, chain.refused], [[], [], []], 'no route of the site; nothing but the reads');
    assert.deepEqual(s.wallet.state.signed, [], 'nothing was signed');
  } finally { await s.close(); }
});

// ---- A sequence's Turn on and Pause (the owner, 2026-09-25: "vamos ligar tudo") ------------------------------------
part('automation');
// A sequence is created paused, and since Manage a sequence left (2026-09-24) nothing switched it on. Its root position's
// page now offers Turn on once the automation service says, through the signed-in session, that it is ready for this
// owner and vault (POST /api/execution/v1/availability), and Pause while it runs. Each press is the one owner
// transaction the vault takes, prepared through the sequence client and read back by hash; the pill follows at once.

/**
 * The execution route's availability answer: `ready` says what the service says; every question is kept, with the
 * test's `phase` at the time it came. Each answer expires `lifetime` seconds after its check (the contract's most is
 * 10), and a test can hold the answer to a question until it lets it go (`gate`, given the question's index).
 */
function availabilityRoute(owner, ready) {
  const service = {
    asked: [],
    phases: [],
    phase: null,
    lifetime: 10,
    gate: null,
    answered: 0,
    async route(request, url) {
      if (url.pathname !== '/api/execution/v1/availability') return undefined;
      assert.ok(request.headers.get('cookie')?.includes('__Host-domino-session='), 'asked within the session');
      assert.ok(request.headers.get('X-Domino-CSRF'), 'with its CSRF');
      const body = JSON.parse(await request.text());
      const index = service.asked.push(body) - 1;
      service.phases.push(service.phase);
      await service.gate?.(index);
      const now = Math.floor(Date.now() / 1000);
      const answer = { contractVersion: executionRuntime.CONTRACT_VERSION, chainId: 4663, owner, vault: body.vault, operational: ready(), checkedAtEpoch: now, expiresAtEpoch: now + service.lifetime };
      assert.ok(executionRuntime.validateResponse('availability', answer));
      service.answered += 1;
      return json(answer, 200, { 'X-Domino-Execution-Contract': executionRuntime.CONTRACT_VERSION });
    },
  };
  return service;
}

/**
 * OWNED_OPEN as the root of a paused Domino-compound sequence this wallet created: the public RPC reads it so (its
 * subscriber, the factory's vault, paused), and the wallet's chain (fakeSequenceChain) holds that vault. A resume or
 * pause the wallet sends lands on both at once, as one chain would show it.
 */
function pausedRoot() {
  const seq = fakeSequenceChain(OWNER, { roots: [BigInt(OWNED_OPEN)], paused: true, settled: true });
  const [VAULT] = seq.vaults;
  const chain = browserChain({
    positions: [onChain(OWNED_OPEN, { subscriber: VAULT })],
    tokens: TOKENS,
    vaults: { [VAULT]: { root: OWNED_OPEN, feeBps: 400, paused: true, valid: true } },
  });
  const answer = async (method, params) => {
    const reply = await seq.request(method, params);
    if (method === 'eth_sendTransaction' && String(params[0].to).toLowerCase() === VAULT) {
      const { functionName } = decodeFunctionData({ abi: chainAbi, data: params[0].data });
      chain.vaults[VAULT].paused = functionName === 'pause';
    }
    return reply;
  };
  return { seq, chain, VAULT, answer };
}

/** Opens OWNED_OPEN's page and waits for its pill. */
async function openRoot(s) {
  await s.page.evaluate((id) => { location.hash = `#/positions/${id}`; }, OWNED_OPEN);
  const detail = s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"]`);
  await detail.waitFor({ timeout: 10_000 });
  await detail.locator('.dm-pos-chips [data-automation="domino"]').waitFor({ timeout: 10_000 });
  return detail;
}

test('a paused sequence’s page offers Turn on once the service says it is ready: one resume to the vault, the pill says Active, and Pause pauses it again', async () => {
  const { seq, chain, VAULT, answer } = pausedRoot();
  const service = availabilityRoute(OWNER, () => true);
  const s = await scenario({ chain, routes: [service.route] });
  await routeChain(s, seq, CHAIN_METHODS, answer);
  // The wallet's chain methods reach the fake chain from the next load on.
  await s.page.reload();
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    s.set({ sequenceRelease: { status: 200, body: seq.release } });
    await login(s.page);
    const detail = await openRoot(s);
    const pill = detail.locator('.dm-pos-chips [data-automation="domino"]');
    assert.equal(await pill.innerText(), 'Domino-compound · Paused');

    // The service's word, asked for this vault within the session: Turn on, in the place of the docs link.
    const turnOn = detail.locator('[data-position-actions] button[data-sequence-switch="turn-on"]');
    await turnOn.waitFor({ timeout: 10_000 });
    assert.equal(await turnOn.innerText(), 'Turn on');
    assert.deepEqual(service.asked, [{ vault: VAULT }]);
    assert.equal(await detail.locator('a[data-automate-docs], a[data-automate-entry]').count(), 0, 'Turn on stands where the docs link stood');
    assert.deepEqual(await detail.locator('[data-position-actions] button').allInnerTexts(), ['Turn on', 'Collect fees', 'Close position']);
    // 2026-09-27 (Domino's buttons): the sequence's Turn on is the one primary; Collect fees outlined; Close the danger.
    assert.deepEqual(await detail.locator('[data-position-actions] button').evaluateAll((all) => all.map((one) => one.className.match(/\bdm-btn--(\w+)/)?.[1])), ['primary', 'outline', 'danger']);
    await s.page.screenshot({ path: join(shots(), 'p2-sequence-turn-on.png'), fullPage: true });

    // The page also asks again just before each answer lapses (about every 8 seconds), so the questions are counted
    // by the phase they came in rather than in total (the review of 2026-09-25).
    service.phase = 'turn-on';
    await turnOn.click();
    const pause = detail.locator('[data-position-actions] button[data-sequence-switch="pause"]');
    await pause.waitFor({ timeout: 30_000 });
    service.phase = 'active';
    assert.equal(await pill.innerText(), 'Domino-compound · Active', 'the pill follows at once');
    assert.equal(await detail.locator('[data-sequence-switch-note]').innerText(), 'Turned on.');
    // One transaction, the vault's resume(), asked again of the service before it was prepared and before it was sent.
    assert.equal(seq.sends.length, 1);
    assert.equal(String(seq.sends[0].to).toLowerCase(), VAULT);
    assert.equal(decodeFunctionData({ abi: chainAbi, data: seq.sends[0].data }).functionName, 'resume');
    assert.equal(seq.sends[0].value, '0x0');
    assert.ok(service.phases.filter((phase) => phase === 'turn-on').length >= 2, 'asked twice more before the wallet was asked');

    // Pause: no service asked, the vault's pause(), and Turn on is back once the service is asked again.
    await s.page.waitForTimeout(500);
    service.phase = 'pause';
    await pause.click();
    await turnOn.waitFor({ timeout: 30_000 });
    assert.equal(await pill.innerText(), 'Domino-compound · Paused');
    assert.equal(seq.sends.length, 2);
    assert.equal(decodeFunctionData({ abi: chainAbi, data: seq.sends[1].data }).functionName, 'pause');
    assert.equal(service.phases.filter((phase) => phase === 'active').length, 0, 'nothing is asked of the service while the sequence runs');
    assert.ok(service.phases.filter((phase) => phase === 'pause').length >= 1, 'Pause asked nothing of the service; the paused sequence was asked for again');
    assert.deepEqual([...new Set(service.asked.map((body) => body.vault))], [VAULT], 'only ever this vault');
    assert.doesNotMatch(await detail.innerText(), FORBIDDEN);
    assert.doesNotMatch(await s.page.locator('main').innerText(), /review|network budget|Owner controls|Manage a sequence/i, 'no review wall and none of the removed cards');
    assert.deepEqual([seq.missing, seq.refused], [[], []]);
    assert.equal(s.wallet.state.signed.length, 1, 'only the sign-in');
  } finally { await s.close(); }
});

// 2026-10-01 (audit C14): Turn on or Pause replaced in the wallet ("Speed up" or "Cancel") is known within seconds by its
// nonce, and the vault read again says whether it switched; it used to be waited for up to four minutes. Nothing is sent
// again for a replaced step.
test('Turn on sped up in the wallet is turned on within seconds; a Pause cancelled in the wallet says the sequence was not paused, and nothing is sent again', async () => {
  const { seq, chain, VAULT } = pausedRoot();
  // The public RPC follows the wallet's chain, as pausedRoot's does, but only for a send the chain carried out: a cancel
  // takes the nonce and switches nothing.
  const answer = async (method, params) => {
    const burned = seq.burned();
    const reply = await seq.request(method, params);
    if (method === 'eth_sendTransaction' && String(params[0].to).toLowerCase() === VAULT && seq.burned() === burned) {
      const { functionName } = decodeFunctionData({ abi: chainAbi, data: params[0].data });
      chain.vaults[VAULT].paused = functionName === 'pause';
    }
    return reply;
  };
  const service = availabilityRoute(OWNER, () => true);
  const s = await scenario({ chain, routes: [service.route] });
  await routeChain(s, seq, CHAIN_METHODS, answer);
  await s.page.reload();
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    s.set({ sequenceRelease: { status: 200, body: seq.release } });
    await login(s.page);
    const detail = await openRoot(s);
    const pill = detail.locator('.dm-pos-chips [data-automation="domino"]');
    const turnOn = detail.locator('[data-position-actions] button[data-sequence-switch="turn-on"]');
    await turnOn.waitFor({ timeout: 10_000 });
    const sends = () => seq.log.filter((method) => method === 'eth_sendTransaction').length;

    // "Speed up": the resume is mined under another hash than the one the page was given.
    seq.speedUpNext('resume');
    const started = Date.now();
    await turnOn.click();
    const pause = detail.locator('[data-position-actions] button[data-sequence-switch="pause"]');
    await pause.waitFor({ timeout: 30_000 });
    assert.ok(Date.now() - started < 30_000, 'within seconds, not after the four-minute wait');
    assert.equal(await pill.innerText(), 'Domino-compound · Active');
    assert.equal(await detail.locator('[data-sequence-switch-note]').innerText(), 'Turned on.');
    assert.equal(seq.sends.length, 1);

    // "Cancel": the Pause never happens; said within seconds, and Pause is offered again for a new press.
    await s.page.waitForTimeout(500);
    seq.cancelNextInWallet('pause');
    await pause.click();
    const note = detail.locator('[data-sequence-switch-note="sequence_step_replaced"]');
    await note.waitFor({ timeout: 40_000 });
    // Changed on purpose 2026-10-01 (integration pass 3, the copy review): "automation", not "sequence", in Create position's pattern.
    assert.equal(await note.innerText(), 'Your wallet replaced this step with another transaction, and automation was not paused. Press Pause again.');
    assert.equal(await pill.innerText(), 'Domino-compound · Active', 'still running');
    assert.deepEqual([seq.sends.length, seq.burned(), sends()], [1, 1, 2], 'the cancelled Pause was not offered again');
    await pause.waitFor();
    assert.equal(await pause.isEnabled(), true);
    assert.doesNotMatch(await detail.innerText(), FORBIDDEN);
    assert.deepEqual([seq.missing, seq.refused], [[], []]);
  } finally { await s.close(); }
});

// The review of 2026-09-25: the execution contract lets a "ready" live at most 10 seconds after the service's check, so
// Turn on never stands on an answer the service has declared expired. Here the service's first answer holds 3 seconds
// and its next is held back: Turn on goes when the first lapses, with no newer answer in, and the docs link is back;
// when the next ready arrives, Turn on returns. Nothing is sent.
test('Turn on goes when the service’s ready answer expires with no newer one, and returns with the next ready', async () => {
  const { seq, chain, VAULT, answer } = pausedRoot();
  const service = availabilityRoute(OWNER, () => true);
  service.lifetime = 3;
  let letGo;
  const held = new Promise((resolve) => { letGo = resolve; });
  service.gate = (index) => (index >= 1 ? held : undefined);
  const s = await scenario({ chain, routes: [service.route] });
  await routeChain(s, seq, CHAIN_METHODS, answer);
  await s.page.reload();
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    s.set({ sequenceRelease: { status: 200, body: seq.release } });
    await login(s.page);
    const detail = await openRoot(s);
    const turnOn = detail.locator('[data-position-actions] button[data-sequence-switch="turn-on"]');
    await turnOn.waitFor({ timeout: 10_000 });
    assert.equal(service.answered, 1);
    // Asked again a second before it lapses; that answer is held, so the first one lapses and Turn on goes.
    await turnOn.waitFor({ state: 'detached', timeout: 5_000 });
    assert.equal(service.answered, 1, 'gone with no newer answer in');
    for (let wait = 0; wait < 20 && service.asked.length < 2; wait += 1) await s.page.waitForTimeout(100);
    assert.deepEqual(service.asked, [{ vault: VAULT }, { vault: VAULT }], 'asked again before it lapsed');
    const docs = detail.locator('[data-position-actions] a[data-automate-docs]');
    await docs.waitFor({ timeout: 2_000 });
    assert.equal(await detail.locator('.dm-pos-chips [data-automation="domino"]').innerText(), 'Domino-compound · Paused');
    // The held answer arrives, ready for another 10 seconds: Turn on is back.
    service.lifetime = 10;
    letGo();
    await turnOn.waitFor({ timeout: 5_000 });
    assert.equal(service.answered, 2);
    assert.equal(seq.sends.length, 0, 'nothing was sent');
  } finally {
    letGo();
    await s.close();
  }
});

// The automation page's success (SequenceCreate.tsx): View position stays, and Turn on takes the place of the docs link
// once the service says the new sequence is ready; until then the docs link stays (the guided creation test above).
test('the success card offers Turn on in the place of the docs link once the service says the new sequence is ready, and turns it on', async () => {
  const chain = fakeSequenceChain(OWNER, { roots: [], settled: true });
  const vault = chain.predict(0);
  const service = availabilityRoute(OWNER, () => true);
  const s = await scenario({ routes: [service.route] });
  await routeChain(s, chain, CHAIN_METHODS);
  try {
    await login(s.page);
    await setUpFromLink(s, chain);
    const created = s.page.locator(`[data-sequence-created="${vault}"]`);
    await created.waitFor({ timeout: 60_000 });
    const turnOn = created.locator('button[data-sequence-switch="turn-on"]');
    await turnOn.waitFor({ timeout: 10_000 });
    assert.equal(await turnOn.innerText(), 'Turn on');
    assert.equal(await created.getByRole('link', { name: 'How to switch it on' }).count(), 0, 'Turn on stands where the docs link stood');
    assert.equal(await created.getByRole('link', { name: 'View position' }).getAttribute('href'), '/positions/5');
    assert.deepEqual(service.asked, [{ vault }]);
    await turnOn.click();
    await created.locator('button[data-sequence-switch="pause"]').waitFor({ timeout: 30_000 });
    assert.equal(await created.locator('[data-sequence-switch-note]').innerText(), 'Turned on.');
    assert.deepEqual(chain.sends.map((tx) => decodeFunctionData({ abi: chainAbi, data: tx.data }).functionName), ['createVault', 'resume']);
    assert.equal(String(chain.sends[1].to).toLowerCase(), vault);
    assert.deepEqual([chain.missing, chain.refused], [[], []]);
  } finally { await s.close(); }
});

test('with the execution route not available, a paused sequence’s page shows nothing new: signed out, the way to sign in; signed in, the pill and the docs link, and nothing is sent', async () => {
  const { seq, chain, answer } = pausedRoot();
  const s = await scenario({ chain });
  await routeChain(s, seq, CHAIN_METHODS, answer);
  await s.page.reload();
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    // The execution bridge Worker switched off, as it is in production today: route_not_available (404).
    s.set({ sequenceRelease: { status: 200, body: seq.release }, execution: 'off' });
    await connectWallet(s.page);
    const detail = await openRoot(s);

    // Connected, not signed in: the service can only be asked within a session, so the way to sign in stands there.
    const signIn = detail.locator('[data-position-actions] [data-sequence-switch="sign-in"]');
    await signIn.waitFor({ timeout: 10_000 });
    assert.equal(await signIn.innerText(), 'Sign in to turn on');
    assert.deepEqual(s.executions, [], 'nothing private is asked without a session');
    await signIn.click();
    const dialog = s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await s.page.keyboard.press('Escape');

    // Signed in: the route answers route_not_available, which is "not ready". Nothing new: the pill and the docs link.
    const docs = detail.locator('[data-position-actions] a[data-automate-docs]');
    await docs.waitFor({ timeout: 10_000 });
    for (let wait = 0; wait < 100 && s.executions.length === 0; wait += 1) await s.page.waitForTimeout(100);
    await s.page.waitForTimeout(500);
    assert.deepEqual(s.executions, ['/api/execution/v1/availability']);
    assert.equal(await detail.locator('[data-sequence-switch]').count(), 0, 'no Turn on, and no way to sign in any more');
    assert.equal(await detail.locator('.dm-pos-chips [data-automation="domino"]').innerText(), 'Domino-compound · Paused');
    assert.equal(await docs.innerText(), 'How to switch it on');
    assert.equal(seq.sends.length, 0, 'nothing was sent');
  } finally { await s.close(); }
});

part('positions');

// 2026-10-02 (RPC-SPEC §11.4, rugged97's rules for the site's token, C:/dwt/rpc-plan/RUGGED_RPC_SITE_2026-10-02.md): a
// position's fees history is its own ledger (POST /api/fees/v2/ledger, functions/_lib/feesLedger.ts): every settlement
// from the position's own events and the engine's, read by Domino's node from block 69,249,061 on, never a pool's
// history; the page folds it with the position's state (lib/fees/ledger.ts). It replaces the fees replay worker, its
// point reads and the list's prefetch queue, and their tests here. The positions are tests/support/fees/ledger-world.mjs's.

/** How many times the page asked the site's ledger route. */
const ledgerAsked = (chain) => chain.edgeLog.filter((path) => path === '/api/fees/v2/ledger').length;
/** A pool's own history, which no route reads (rugged97's rule 2): Swap, Initialize, Donate. */
const POOL_HISTORY = ['0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f', '0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438', '0x29ef05caaff9404b7cb6d1c0e9bbae9eaa7ab2541feba1a9c4248594c08156cb'];
/**
 * Every log read the world's node answered keeps to rugged97's rules: from block 69,249,061, windows of 10,000,000 at most
 * (the transport's LOCAL_RPC_LOG_BLOCKS since the review of the rules, 2026-10-02; 1,000,000 before), the PoolManager one
 * block at a time, no pool history.
 */
function nodeRulesKept(world) {
  assert.ok(world.asked.length > 0, 'the node was read');
  for (const filter of world.asked) {
    const what = JSON.stringify(filter);
    assert.ok(filter.from >= 69_249_061, `below the floor: ${what}`);
    assert.ok(filter.to - filter.from + 1 <= 10_000_000, `a window past 10,000,000 blocks: ${what}`);
    if ([filter.address].flat().map((one) => String(one).toLowerCase()).includes(LEDGER_PM)) assert.equal(filter.from, filter.to, `the PoolManager over more than one block: ${what}`);
    assert.ok(![filter.topics[0]].flat().some((topic) => POOL_HISTORY.includes(topic)), `a pool's history: ${what}`);
  }
}

test('a position’s fees history is its own ledger, read from the site’s ledger route: the owner’s Auto-compound position drawn exact from its settlements, none of the pool’s history, and at once on a return', async () => {
  const world = ledgerWorld({ holder: OWNER });
  const chain = world.chain;
  const site = siteRoutes();
  const s = await scenario({ chain, routes: [site.route] });
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    const started = Date.now();
    await s.page.evaluate(() => { location.hash = '#/positions/3325113'; });
    await s.page.locator('[data-position-detail][data-position-id="3325113"]').waitFor({ timeout: 15_000 });
    const verified = s.page.locator('[data-fees-card][data-fees-state="verified"]');
    await verified.first().waitFor({ timeout: 30_000 });
    const drawn = Date.now() - started;
    // Your APR, from the ledger the card draws (lib/positionApr.ts, no read of its own), since the position opened at
    // today's prices; the last 24 hours only from a point measured about a day ago (here the mint).
    const apr = s.page.locator('[data-cell="apr"][data-apr="ready"]');
    await apr.waitFor({ timeout: 5_000 });
    assert.equal(await apr.locator('details').getAttribute('open'), null, 'period details stay quiet until requested');
    await apr.getByText('Period details', { exact: true }).click();
    assert.match(await apr.innerText(), /^Your APR\s+[\d,]+(\.\d)?%\s+Period details\s+Since opened \([^)]+\)(\s+Last 24 hours: [\d,]+(\.\d)?%)?$/);
    assert.doesNotMatch(await s.page.locator('main').innerText(), /\best\./, 'no estimate anywhere');
    // Its Activity in a card of its own: the three compounds, each one row, and its opening.
    assert.equal(await verified.first().locator('.dm-fees-act').count(), 0, 'the fees card lists no activity');
    const rows = await activityRowsOf(s.page);
    assert.deepEqual(rows.map((row) => row.slice(0, 3)), [['auto', true, 'Fees added back'], ['auto', true, 'Fees added back'], ['auto', true, 'Fees added back'], ['mint', false, 'Opened']]);
    // The site's state and ledger routes, and nothing of the retired logs route; every node read within the rules.
    assert.ok(chain.edgeLog.includes('/api/fees/v1/state'), 'the position’s state, from the site’s state route');
    assert.ok(ledgerAsked(chain) >= 1, 'its ledger, from the site’s ledger route');
    assert.ok(!chain.edgeLog.includes('/api/fees/v1/logs'), 'no logs route');
    nodeRulesKept(world);
    assert.deepEqual(chain.publicAsked, [], 'no public node');
    // Away and back in the same visit: the history is the store's, drawn with the page at once.
    await s.page.evaluate(() => { location.hash = '#/positions'; });
    await s.page.locator('[data-position-detail]').waitFor({ state: 'detached', timeout: 10_000 });
    const back = Date.now();
    await s.page.evaluate(() => { location.hash = '#/positions/3325113'; });
    await verified.first().waitFor({ timeout: 5_000 });
    const again = Date.now() - back;
    assert.deepEqual(chain.refused, [], 'nothing but the reads');
    assert.deepEqual(site.asked, [], 'nothing past the chain routes is asked');
    await s.page.screenshot({ path: join(shots(), 'position-fees-ledger.png'), fullPage: true });
    console.log(`# verified ${drawn} ms after the page was opened (${world.asked.length} log reads at the node), ${again} ms on a return`);
  } finally { await s.close(); }
});

test('Your positions: each open row’s Your APR is its own ledger’s, asked with the list for the connected wallet; a row whose fees can’t be measured says so on its page; no figure moves', async () => {
  const world = ledgerWorld({ holder: OWNER, extraPositions: [onChain(OWNED_OPEN)], tokens: { ...LEDGER_TOKENS, ...TOKENS } });
  const chain = world.chain;
  const site = siteRoutes();
  // 2026-10-02 (the fee chart's periods back): the site's read bridge lists read-v1 nft-positions, as deployed; the list
  // never reads a position at a past block (its Your APR is since opened), only a position's page may.
  const pastAsked = [];
  const read = createReadStub({ reads: 'nft-positions', answer: (route, body) => { pastAsked.push(body); return world.pastAnswer(body.blockNumber); } });
  const s = await scenario({ chain, routes: [site.route, (request, url) => (url.pathname.startsWith('/api/read/') ? read.handle(request, url) : undefined)] });
  const ledgers = [];
  const coldReads = Math.ceil((chain.head - LEDGER_FLOOR + 1) / LEDGER_SCAN_BLOCKS);
  s.page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/fees/v2/ledger') ledgers.push(JSON.parse(request.postData() ?? '{}')); });
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    // Where each row's figures stand the moment the list is drawn, before any APR.
    await s.page.evaluate(() => {
      window.__rowEdges = () => [...document.querySelectorAll('a[data-position-row]')].map((row) => ['principal', 'fees', 'apr'].map((cell) => Math.round(row.querySelector(`[data-cell="${cell}"]`).getBoundingClientRect().right)));
      new MutationObserver((_, observer) => {
        if (document.querySelectorAll('[data-owned="ready"] a[data-position-row]').length < 2) return;
        observer.disconnect();
        window.__drawn = { edges: window.__rowEdges() };
      }).observe(document.body, { subtree: true, childList: true, attributes: true });
    });
    await connectWallet(s.page);
    await s.page.locator('[data-owned="ready"]').waitFor({ timeout: 20_000 });
    const order = await s.page.locator('a[data-position-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-position-row')));
    assert.deepEqual([...order].sort(), [OWNED_OPEN, '3325113']);
    // The rows' ledgers, asked together (eight ids a request at most), with no position's page open.
    const apr = s.page.locator('[data-position-row="3325113"] [data-cell="apr"][data-apr="ready"]');
    await apr.waitFor({ timeout: 20_000 });
    assert.match((await apr.locator('.dm-own-fig').innerText()).trim(), /^[\d,]+(\.\d)?%$/);
    assert.equal(await apr.getAttribute('title'), 'Since the position opened');
    assert.ok(ledgers.some((body) => [...body.tokenIds].sort().join() === [OWNED_OPEN, '3325113'].sort().join()), `one request for both rows: ${JSON.stringify(ledgers)}`);
    assert.ok(ledgers.every((body) => body.tokenIds.length <= 8));
    // 2026-10-02 (review of the chart's tabs, finding 1): the cell says, in data attributes, how many ledger requests this
    // visit made for the row and how the last ended.
    assert.deepEqual([await apr.getAttribute('data-ledger-asks'), await apr.getAttribute('data-ledger-last')], ['1', 'exact']);
    assert.equal(ledgers.filter((body) => body.tokenIds.includes('3325113')).length, 1, 'verified mint discovery qualifies the known NFT in one request, without a historical floor walk');
    assert.equal(await s.page.locator('[data-position-detail]').count(), 0, 'no page was opened for it');
    assert.deepEqual(pastAsked, [], 'the list reads no position at a past block');
    // A row whose ledger cannot measure its fees (here: none of its events on the node) keeps a dash and says why; its
    // page has no figure either, so it says so rather than "on its page" (2026-10-02, review of the rules, finding 11).
    const dash = s.page.locator(`[data-position-row="${OWNED_OPEN}"] [data-cell="apr"][data-apr="missing"]`);
    await dash.waitFor({ timeout: 10_000 });
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): a dash in place of "not measured", and no title ("Not measured for this position").
    assert.equal((await dash.innerText()).replace(/\s+/g, ' ').trim(), 'Your APR —');
    assert.equal(await dash.getAttribute('title'), null);
    // Changed on purpose (2026-10-15, pack 8; study-charts.md fix 5): minted before the floor (none of its events on the
    // node), it is answered `before_floor` by the list's one request, where it took `coldReads` requests of a scan from the
    // floor in LEDGER_SCAN_BLOCKS steps to come to the same answer.
    assert.deepEqual([await dash.getAttribute('data-ledger-asks'), await dash.getAttribute('data-ledger-last')], ['1', 'before_floor']);
    assert.ok(coldReads > 1);
    assert.match(await dash.getAttribute('data-ledger-last'), /^(?!exact$)[a-z_]+$/, 'its ledger’s why');
    assert.doesNotMatch(await s.page.locator('[data-owned]').innerText(), /\best\./, 'no estimate');
    // Nothing moved: the figures stand where they were first drawn, now that the APR is in.
    const drawn = await s.page.evaluate(() => window.__drawn);
    assert.deepEqual(await s.page.evaluate(() => window.__rowEdges()), drawn.edges, 'every figure where it was first drawn');
    assert.deepEqual(pastAsked, [], 'still none, the rows drawn');
    // Its page: the same figure.
    await s.page.locator('a[data-position-row="3325113"]').click();
    const detail = s.page.locator('[data-position-detail][data-position-id="3325113"]');
    await detail.waitFor({ timeout: 15_000 });
    const pageApr = detail.locator('[data-cell="apr"][data-apr="ready"]');
    await pageApr.waitFor({ timeout: 15_000 });
    const figure = (await pageApr.locator('.dm-pos-apr').innerText()).trim().split(/\s/)[0];
    // Its Details: the list's completed discovery serves the page too, without starting another history scan.
    const source = detail.locator('[data-history-source="ledger"]');
    assert.deepEqual([await source.getAttribute('data-ledger-asks'), await source.getAttribute('data-ledger-last')], ['1', 'exact']);
    // The other position's page says plainly that its fees earned can't be measured, its fees ready to collect exact.
    await s.page.evaluate((id) => { location.hash = `#/positions/${id}`; }, OWNED_OPEN);
    const quiet = s.page.locator('[data-fees-card][data-fees-state="unclaimed-only"][data-fees-reason="not_exact"]');
    await quiet.waitFor({ timeout: 15_000 });
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): the card's flat plot says nothing ("Fees earned can’t be measured for this position. Fees ready to collect is exact.").
    assert.doesNotMatch(await quiet.innerText(), /can’t be measured|is exact/);
    assert.equal(await s.page.getByRole('button', { name: /^(Retry|Refresh|Try again|Read again)$/ }).count(), 0, 'no Retry');
    // Back: the row's figure is the page's.
    await s.page.evaluate(() => { location.hash = '#/positions'; });
    const again = s.page.locator('[data-position-row="3325113"] [data-cell="apr"][data-apr="ready"]');
    await again.waitFor({ timeout: 5_000 });
    assert.equal((await again.locator('.dm-own-fig').innerText()).trim(), figure);
    // The list's display copy and nothing else about positions (the fee history's copies hold no address).
    assert.deepEqual(await kept(s.page), [OWNED_COPY], 'nothing about positions is kept in the browser but the list’s copy');
    nodeRulesKept(world);
    assert.deepEqual(site.asked, [], 'no route of the site is asked');
    assert.deepEqual(chain.refused, [], 'nothing but the reads');
    await s.page.locator('[data-owned]').screenshot({ path: join(shots(), 'positions-apr.png') });
  } finally { await s.close(); }
});

// 2026-10-02 (the owner's preview: the ledger was asked once per page load, and a position's page then never asked it, its
// Fees earned card and Your APR skeletons for the visit). The route answers a first read it could not finish `reading`
// (functions/_lib/feesLedger.ts: past LEDGER_STEP's lookups, or past the question's byte budget). The store asks again
// 2 s later only while a screen shows the id; the owner's click into another row left this one with no screen, and a kept
// `reading` ledger stopped every later screen from asking (lib/fees/store.ts needsLedger).
test('a row whose ledger answered `reading` as the owner opened another row is asked again on its own page and on the list', async () => {
  const { edgeRoutes } = await import('./support/edge-routes.mjs');
  const { RPC_URL } = await import('./support/browser-chain.mjs');
  const world = ledgerWorld({ holder: OWNER, extraPositions: [onChain(OWNED_OPEN)], tokens: { ...LEDGER_TOKENS, ...TOKENS } });
  const chain = world.chain;
  const site = siteRoutes();
  const s = await scenario({ chain, routes: [site.route] });
  // The first ledger answer as the deployment gives a first read it could not finish: every row `reading`.
  const own = edgeRoutes({ fetch: (_url, init) => chain.fetch(RPC_URL, init) });
  const ledgers = [];
  const coldReads = Math.ceil((chain.head - LEDGER_FLOOR + 1) / LEDGER_SCAN_BLOCKS);
  await s.context.route((url) => url.pathname === '/api/fees/v2/ledger', async (route) => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    ledgers.push(body.tokenIds);
    // All requests use this same edge/cache, as on the deployment. Falling back after the first answer would switch
    // to scenario's separate edge and make the second request start discovery from the floor again.
    const real = await own(new Request('https://edge.test/api/fees/v2/ledger', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://edge.test', 'sec-fetch-site': 'same-origin' }, body: JSON.stringify(body) }));
    const value = await real.json();
    if (ledgers.length === 1) value.positions = value.positions.map((one) => (one.ok ? { ...one, exact: false, why: 'reading' } : one));
    return route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(value) });
  });
  const asked = (id) => ledgers.filter((ids) => ids.includes(id)).length;
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    await connectWallet(s.page);
    await s.page.locator('[data-owned="ready"]').waitFor({ timeout: 20_000 });
    await until(() => ledgers.length >= 1, 'the list’s ledger read');
    assert.deepEqual([...ledgers[0]].sort(), [OWNED_OPEN, '3325113'].sort(), 'both rows asked with the list');
    // The click into the main position, before the store's 2 s `reading` retry: its page reads on and draws it.
    await s.page.locator('a[data-position-row="3325113"]').click();
    await s.page.locator('[data-position-detail][data-position-id="3325113"]').waitFor({ timeout: 15_000 });
    await s.page.locator('[data-fees-card][data-fees-state="verified"]').first().waitFor({ timeout: 15_000 });
    // Past the other row's 2 s retry (fired with no screen showing it) and the store's 3 s release.
    await new Promise((done) => setTimeout(done, 4_000));
    assert.equal(asked(OWNED_OPEN), 1, 'no screen showed it: not asked again meanwhile');
    // Its own page asks its ledger again, and its card leaves its skeleton.
    await s.page.evaluate((id) => { location.hash = `#/positions/${id}`; }, OWNED_OPEN);
    await s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"]`).waitFor({ timeout: 15_000 });
    await s.page.locator('[data-fees-card][data-fees-state="unclaimed-only"][data-fees-reason="not_exact"]').waitFor({ timeout: 15_000 });
    // Changed on purpose (2026-10-15, pack 8; study-charts.md fix 5): minted before the floor, its page's one request is
    // answered `before_floor` at once from the discovery the list's request completed, where the page read on through
    // `coldReads` requests of a scan from the floor.
    assert.equal(asked(OWNED_OPEN), 2, 'its page asks once more and is answered at once, without restarting discovery');
    assert.ok(coldReads > 2);
    // Back on the list: its row says why there is no figure, never a skeleton for the visit.
    await s.page.evaluate(() => { location.hash = '#/positions'; });
    await s.page.locator(`[data-position-row="${OWNED_OPEN}"] [data-cell="apr"][data-apr="missing"]`).waitFor({ timeout: 15_000 });
    await s.page.locator('[data-position-row="3325113"] [data-cell="apr"][data-apr="ready"]').waitFor({ timeout: 15_000 });
    assert.deepEqual(site.asked, []);
  } finally { await s.close(); }
});

// The node busy for one ledger read (its 429, Retry-After 1 s: Domino's node, or this visitor's share of it): the card
// stays calm with the chain's unclaimed figure, no Retry is offered, and the store asks again on its own first wait
// (lib/fees/store.ts RETRY_MS), so the chart is drawn seconds later, not a minute.
test('the ledger route refuses once: the card stays calm with the chain’s unclaimed figure, and the chart is drawn after the store’s first wait, not a minute later', async () => {
  const world = ledgerWorld({ holder: OWNER });
  const chain = world.chain;
  const site = siteRoutes();
  const s = await scenario({ chain, routes: [site.route] });
  const asks = [];
  await s.context.route((url) => url.pathname === '/api/fees/v2/ledger', (route) => {
    asks.push(Date.now());
    if (asks.length === 1) return route.fulfill({ status: 429, contentType: 'application/json; charset=utf-8', headers: { 'Retry-After': '1', 'Cache-Control': 'no-store' }, body: JSON.stringify({ v: 1, error: 'rate_limited' }) });
    return route.fallback();
  });
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    await s.page.evaluate(() => { location.hash = '#/positions/3325113'; });
    await s.page.locator('[data-position-detail][data-position-id="3325113"]').waitFor({ timeout: 15_000 });
    await until(() => asks.length >= 1, 'the refused ledger read');
    const calm = s.page.locator('[data-fees-card]');
    await calm.first().waitFor({ timeout: 10_000 });
    assert.match(await calm.first().innerText(), /Ready to collect[\s\S]*\$[\d,]+\.\d\d/, 'the chain’s unclaimed figure meanwhile');
    assert.equal(await s.page.getByRole('button', { name: /^(Retry|Refresh|Try again|Read again)$/ }).count(), 0, 'no Retry');
    const verified = s.page.locator('[data-fees-card][data-fees-state="verified"]');
    await verified.first().waitFor({ timeout: 20_000 });
    assert.ok(asks.length >= 2, 'asked again by the store');
    const wait = asks[1] - asks[0];
    assert.ok(wait >= 900 && wait < 15_000, `asked again ${wait} ms after the refusal`);
    assert.deepEqual(site.asked, []);
  } finally { await s.close(); }
});

// 2026-09-28 (the owner, on his phone, in a wallet's in-app browser: Your positions stayed on its loading rows with
// "Reading your positions from the chain…" while the public RPC refused his address). The list keeps this browser's copy
// of the chain's last answer, per wallet and chain, and draws it at once on the next visit (data-owned="kept") while the
// chain is read, then the chain's own list in its place. Display only: the held deposit and its refund, the automation's
// badges and reads wait for the chain; a copy the parser refuses (another wallet's answer under this one's name, a broken
// field) or one over a week old is dropped, never drawn; and the chain saying the wallet has none forgets it. Review of
// 2026-09-28: once a read failed, the card's one quiet line stands over the copy as it stands over the loading rows.
// Changed on purpose (RPC-SPEC, 2026-10-01: the page asks the site's own route, which reads Domino's node at the edge):
// "while the RPC refuses" is now "while POST /api/owned/v2/positions answers 502 chain_busy" (the node or the visitor's
// limiter refusing). The page asks again when the route's Retry-After is over. There is no cross-tab pacing, no shared
// cooldown and no reach probe any more: they paced the public RPC (lib/chain/browser.ts), which the list no longer reads.
test('Your positions draws this browser’s copy at once while the site’s route answers chain_busy, then the chain’s list in its place; a broken, another wallet’s or an old copy is never drawn', async () => {
  const { refusingRoute } = await import('./support/edge-busy.mjs');
  const deposit = { key: { currency0: zeroAddress, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: zeroAddress }, balance0: 0n, balance1: 100000n };
  const chain = browserChain({ positions: [onChain(OWNED_OPEN), closedOnChain(OWNED_CLOSED[0])], tokens: { ...TOKENS, [USDG]: { symbol: 'USDG', decimals: 6 } }, deposits: { [OWNER]: [deposit] } });
  const site = siteRoutes();
  const read = createReadStub();
  const s = await scenario({ chain, routes: [site.route, (request, url) => read.handle(request, url)] });
  const RETRY_S = 3;
  const owned = await refusingRoute(s.context, '/api/owned/v2/positions', { retryAfter: RETRY_S });
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    await connectWallet(s.page);
    await s.page.locator(`[data-owned="ready"] a[data-position-row="${OWNED_OPEN}"]`).waitFor({ timeout: 20_000 });
    await s.page.locator('[data-held-deposit]').waitFor();
    await s.page.locator(`[data-position-automation="${OWNED_OPEN}"] a[data-automate-entry]`).waitFor();
    const fresh = await ownedRows(s.page);
    const tabs = async () => (await s.page.getByRole('tab').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim());
    assert.deepEqual(await tabs(), ['Open 1', 'Closed 1']);
    const copy = JSON.parse(await s.page.evaluate((name) => localStorage.getItem(name), OWNED_COPY));
    assert.deepEqual(Object.keys(copy).sort(), ['at', 'data'], 'dated');
    assert.deepEqual([copy.data.owner, copy.data.block, copy.data.positions.map((p) => p.tokenId), copy.data.deposits], [OWNER, chain.head, [OWNED_OPEN, OWNED_CLOSED[0]], []], 'the chain’s answer, never its held deposit');
    assert.deepEqual(await kept(s.page), [OWNED_COPY]);

    // Reloaded while the route refuses this wallet: the copy at once, as it was drawn, and nothing that acts or reads for
    // it; then the chain's list in its place once the route answers.
    owned.until = Date.now() + 60_000;
    await s.page.reload();
    await recordList(s.page);
    await reconnect(s.page);
    await s.page.locator(`[data-owned="kept"][data-owned-block="${chain.head}"] a[data-position-row="${OWNED_OPEN}"]`).waitFor({ timeout: 5_000 });
    assert.deepEqual(await ownedRows(s.page), fresh, 'the rows as they were drawn');
    assert.deepEqual(await tabs(), ['Open 1', 'Closed 1']);
    assert.equal(await s.page.locator('[data-owned] [data-owned-loading], [data-owned] [data-empty]').count(), 0, 'no loading rows, no empty state');
    assert.equal(await s.page.locator('[data-held-deposit], [data-position-automation]').count(), 0, 'no held deposit to refund, no automation read for the copy');
    await until(() => owned.asked.some((request) => request.refused), 'the list asked the route, refused');
    // The copy is never drawn as the chain's answer of now: the one quiet line the loading rows have stands over its rows.
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): the copy's rows stand alone; the line is a hidden marker ("Reading your positions from the chain…").
    const note = s.page.locator('[data-owned="kept"] [data-owned-note="rereading"]');
    await note.waitFor({ state: 'attached', timeout: 20_000 });
    assert.equal(await note.innerText(), '');
    assert.equal(await s.page.locator('[data-owned]').getAttribute('data-owned-reason'), 'chain_busy');
    assert.deepEqual(await ownedRows(s.page), fresh, 'the copy’s rows stay under it');
    assert.equal(await s.page.locator('[data-owned] [data-owned-loading], [data-owned] [data-empty]').count(), 0);
    // Refused again: each ask waits the route's Retry-After from the one before, never sooner.
    await until(() => owned.asked.filter((request) => request.refused).length >= 2, 'asked again after the route’s wait', 15_000);
    const refused = owned.asked.filter((request) => request.refused);
    for (let i = 1; i < refused.length; i++) assert.ok(refused[i].at - refused[i - 1].at >= RETRY_S * 1000 - 250, `ask ${i + 1} ${refused[i].at - refused[i - 1].at} ms after the one before`);
    const lifted = Date.now();
    owned.until = 0;
    await s.page.locator(`[data-owned="ready"] a[data-position-row="${OWNED_OPEN}"]`).waitFor({ timeout: RETRY_S * 1000 + 6_000 });
    const late = Date.now() - lifted;
    assert.ok(late < RETRY_S * 1000 + 4_000, `the chain’s list ${late} ms after the route answered again`);
    console.log(`# Wallet copy: ${refused.length} asks refused, each after the route’s ${RETRY_S} s; the chain’s list ${late} ms after the route answered`);
    assert.equal(await s.page.locator('[data-owned] [data-owned-note]').count(), 0, 'and no line over the chain’s list');
    await s.page.locator('[data-held-deposit]').waitFor();
    await s.page.locator(`[data-position-automation="${OWNED_OPEN}"] a[data-automate-entry]`).waitFor();
    assert.deepEqual(await listSeen(s.page), ['kept', 'kept:rereading', 'ready'], 'the copy, the copy under the quiet line, then the chain’s list: never the loading rows');
    assert.deepEqual(await ownedRows(s.page), fresh);

    // Copies that are never drawn: the reload finds none it may draw, the route refusing meanwhile, and drops them.
    const other = ACCOUNTS[1].address.toLowerCase();
    const week = 7 * 86_400_000;
    const broken = { ...copy.data, positions: [{ ...copy.data.positions[0], liquidity: '0' }] };
    for (const [label, entry] of [
      ['another wallet’s answer under this one’s name', { at: Date.now(), data: { ...copy.data, owner: other } }],
      ['an open position with no liquidity', { at: Date.now(), data: broken }],
      ['older than a week', { at: Date.now() - week - 60_000, data: copy.data }],
    ]) {
      await s.page.evaluate(([name, value]) => localStorage.setItem(name, JSON.stringify(value)), [OWNED_COPY, entry]);
      owned.until = Date.now() + 60_000;
      await s.page.reload();
      await recordList(s.page);
      await reconnect(s.page);
      await s.page.locator('[data-owned] [data-owned-loading]').waitFor({ timeout: 15_000 });
      assert.equal(await s.page.locator('[data-owned] a[data-position-row]').count(), 0, `${label}: not drawn`);
      assert.equal(await s.page.evaluate((name) => localStorage.getItem(name), OWNED_COPY), null, `${label}: dropped`);
      assert.ok(!(await listSeen(s.page)).includes('kept'), label);
    }

    // The chain says the wallet has none now: the list says so, and the copy is forgotten. (The route's answer of none is
    // given here as the route sends it: the edge keeps a wallet's answer for a while, which is the edge's own rule.)
    owned.until = 0;
    await s.page.locator(`[data-owned="ready"] a[data-position-row="${OWNED_OPEN}"]`).waitFor({ timeout: 20_000 });
    assert.notEqual(await s.page.evaluate((name) => localStorage.getItem(name), OWNED_COPY), null, 'kept again from the chain’s answer');
    chain.positions.length = 0;
    chain.deposits[OWNER] = [];
    const none = await refusingRoute(s.context, '/api/owned/v2/positions', { status: 200, body: { v: 1, answer: { owner: OWNER, block: chain.head, positions: [], deposits: [] }, automation: { block: chain.head, positions: [] }, mints: [], capped: false } });
    none.until = Date.now() + 60_000;
    await s.page.reload();
    await reconnect(s.page);
    await s.page.locator('[data-owned="ready"] [data-empty="owned-none"]').waitFor({ timeout: 20_000 });
    assert.deepEqual(await kept(s.page), [], 'forgotten');
    assert.deepEqual(site.asked, [], 'nothing reached the server behind the site’s routes');
    assert.deepEqual(s.wallet.state.signed, [], 'nothing was signed');
    assert.ok(chain.edgeLog.includes('/api/owned/v2/positions'), 'the list is the site’s own route');
    assert.deepEqual(chain.publicAsked, [], 'no public RPC was asked anything');
  } finally { await s.close(); }
});

// Review of 2026-09-28. This browser's copy is the chain's answer of when it was kept, its USD figures valued at that
// block's pool prices. The Wallet card counts a price for an hour and no longer ("an older price gives no value and no
// total": lib/walletMemory.ts WALLET_PRICE_MAX_AGE_MS); so does the copy. Kept a moment ago it is drawn as it was, its
// USD figures and Total value included; kept two hours ago, its rows show their token amounts only, and the band waits
// in its place for the chain, as while the list is read. And a copy is never drawn as the chain's answer of now: while
// the chain fails, the card's quiet line stands over it, then its calm line once the quick re-asks failed too (the band
// leaves then, as it does over the loading rows); the chain's own list, once it answers, has its figures and no line.
test('a copy kept over an hour ago shows no USD figure and no Total value until the chain answers, and the card’s lines stand over a copy while the chain fails', async () => {
  const usdgKey = (fee) => ({ currency0: zeroAddress, currency1: USDG, fee, tickSpacing: 60, hooks: zeroAddress });
  const chain = browserChain({ positions: [onChain('5', { key: usdgKey(3000), unclaimed: [0n, 2_500_000n] }), onChain('7', { key: usdgKey(500) })], tokens: { [USDG]: { symbol: 'USDG', decimals: 6 } } });
  const site = siteRoutes();
  const s = await scenario({ chain, routes: [site.route] });
  const card = s.page.locator('[data-owned]');
  const usd = () => card.locator('[data-cell="principal"] .dm-own-fig, [data-cell="fees"] .dm-own-fig').allInnerTexts();
  const band = card.locator('.dm-portfolio:not(.dm-own-skel-band)');
  const again = async () => {
    await s.page.reload();
    await recordList(s.page);
    await reconnect(s.page);
  };
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    await connectWallet(s.page);
    await s.page.locator('[data-owned="ready"] a[data-position-row="5"]').waitFor({ timeout: 20_000 });
    const fresh = await ownedRows(s.page);
    const figures = await usd();
    assert.equal(figures.length, 4, 'Value and Fees ready to collect in USD, on both rows');
    assert.ok(figures.every((figure) => /^\$/.test(figure)), figures.join(' '));
    const total = await band.innerText();
    assert.match(total, /Total value/);

    // Kept a moment ago, the chain failing: drawn as it was, its USD figures and its total included. Changed on purpose
    // 2026-10-01 (RPC-SPEC): the list is the site's route, whose answer the edge keeps 30 s, so the chain's failure is the
    // route's own answer to it (502 chain_unavailable, functions/_lib/owned.ts), given here at once.
    const { refusingRoute } = await import('./support/edge-busy.mjs');
    const failing = await refusingRoute(s.context, '/api/owned/v2/positions', { body: { error: 'chain_unavailable' }, retryAfter: 12 });
    failing.until = Infinity;
    chain.outage = 500;
    await again();
    await s.page.locator('[data-owned="kept"] a[data-position-row="5"]').waitFor({ timeout: 5_000 });
    assert.deepEqual(await ownedRows(s.page), fresh, 'the rows as they were drawn');
    assert.equal(await band.innerText(), total, 'and the band');

    // Kept two hours ago: the token amounts only, no USD and no total; the band waits in its place.
    await s.page.evaluate((name) => {
      const entry = JSON.parse(localStorage.getItem(name));
      localStorage.setItem(name, JSON.stringify({ ...entry, at: Date.now() - 2 * 3_600_000 }));
    }, OWNED_COPY);
    await again();
    await s.page.locator('[data-owned="kept"] a[data-position-row="5"]').waitFor({ timeout: 5_000 });
    assert.deepEqual(await usd(), [], 'no USD figure on the rows');
    assert.doesNotMatch(await card.innerText(), /\$|Total value/, 'no USD anywhere on the card, and no total');
    assert.equal(await card.locator('.dm-own-skel-band').count(), 1, 'the band waits in its place');
    assert.match(await s.page.locator('a[data-position-row="5"]').innerText(), /2\.5 USDG/, 'the copy’s own token amounts');
    assert.equal(await s.page.locator('[data-owned] a[data-position-row]').count(), 2);

    // The chain keeps failing: the quiet line over the copy while it is asked again, then the calm one; the copy stays.
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): hidden markers, no line ("Reading your positions from the chain…", then "Your positions couldn’t be read right now.").
    const note = card.locator('[data-owned-note]');
    await card.locator('[data-owned-note="rereading"]').waitFor({ state: 'attached', timeout: 5_000 });
    assert.equal(await note.innerText(), '');
    await card.locator('[data-owned-note="unread"]').waitFor({ state: 'attached', timeout: 30_000 });
    assert.doesNotMatch(await card.innerText(), /Reading your positions|couldn’t be read/);
    assert.deepEqual([await card.getAttribute('data-owned'), await card.getAttribute('data-owned-reason')], ['kept', 'chain_unavailable']);
    assert.equal(await card.locator('.dm-portfolio').count(), 0, 'the band leaves once the list could not be read');
    assert.equal(await s.page.locator('[data-owned] a[data-position-row]').count(), 2, 'the copy stays');
    assert.equal(await card.locator('[data-owned-loading], [data-empty]').count(), 0);
    assert.equal(await s.page.getByRole('button', { name: /^(Retry|Refresh|Try again|Read again)$/ }).count(), 0, 'no Retry');
    const seen = await listSeen(s.page);
    assert.ok(seen.every((what) => /^kept(?::rereading|:unread)?$/.test(what)) && seen.at(-1) === 'kept:unread', seen.join(' → '));

    // The chain answers: its USD figures and total, no line, and the copy kept again at this time.
    chain.outage = null;
    failing.until = 0;
    await again();
    await s.page.locator('[data-owned="ready"] a[data-position-row="5"]').waitFor({ timeout: 15_000 });
    assert.deepEqual(await ownedRows(s.page), fresh);
    assert.equal(await band.innerText(), total);
    assert.equal(await note.count(), 0);
    assert.ok(Date.now() - JSON.parse(await s.page.evaluate((name) => localStorage.getItem(name), OWNED_COPY)).at < 60_000, 'kept again, now');
    assert.deepEqual(site.asked, [], 'no route of the site is asked');
  } finally { await s.close(); }
});

// 2026-09-28 (the owner, on his phone, with five tabs open: Your positions stayed on its loading rows while the public
// RPC refused his address, and the list's own read had no way ahead of the fees histories). Two tabs of one browser: A
// shows a position's page (the recorded 3325113, its history replayed by A's fees worker); B opens Positions while the
// list's source refuses for a few seconds. B draws this browser's copy at once and the chain's list as soon as the source
// lets it in, and B, the list's tab, starts no history run.
// Changed on purpose (RPC-SPEC, 2026-10-01: the page asks the site's own route, which reads Domino's node at the edge):
// the refusal is now POST /api/owned/v2/positions answering 502 chain_busy for B's tab. Cross-tab pacing is gone: the
// list's read held every tab's fees lanes and its refusals rested them all because one public RPC address served both
// (lib/chain/browser.ts holdReads and the shared cooldown); the list's route and the fees' reads no longer share a
// limit in the browser, so this test no longer holds A's history read nor measures the lanes' rests.
// Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the list's tab reads its rows' ledgers (their Your APR), so it no longer
// promises to start no history; A's page draws 3325113's ledger.
test('the site’s route refusing for a few seconds while another tab reads a position’s history: the list is drawn at once from this browser’s copy and from the route as soon as it answers', async () => {
  const { refusingRoute } = await import('./support/edge-busy.mjs');
  // Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the ledger world's 3325113, read by its own ledger, beside a plain row.
  const world = ledgerWorld({ holder: OWNER, extraPositions: [onChain(OWNED_OPEN)], tokens: { ...LEDGER_TOKENS, ...TOKENS } });
  const chain = world.chain;
  const site = siteRoutes();
  const s = await scenario({ chain, routes: [site.route] });
  let b = null;
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    await connectWallet(s.page);
    // A's list (it keeps this browser's copy), then 3325113's page: its ledger is read and drawn.
    await s.page.locator('[data-owned="ready"] a[data-position-row="3325113"]').waitFor({ timeout: 20_000 });
    await s.page.evaluate(() => { location.hash = '#/positions/3325113'; });
    await s.page.locator('[data-fees-card][data-fees-state="verified"]').first().waitFor({ timeout: 30_000 });

    // B opens Positions; the route refuses B's list for six seconds from now (B's own routes only: A's page reads on).
    b = await s.context.newPage();
    await b.addInitScript(() => {
      window.__ownedReadyAt = 0;
      const observed = new MutationObserver(() => {
        if (!document.querySelector('[data-owned="ready"] a[data-position-row="3325113"]')) return;
        window.__ownedReadyAt = Date.now();
        observed.disconnect();
      });
      observed.observe(document, { childList: true, subtree: true, attributes: true });
    });
    const owned = await refusingRoute(b, '/api/owned/v2/positions', { retryAfter: 2 });
    const first = Date.now();
    owned.until = first + 6_000;
    await b.goto(`${s.origin}/#/app`);
    await recordList(b);
    await reconnect(b);
    // B's copy (A kept it) at once, before any answer.
    await b.locator('[data-owned="kept"] a[data-position-row="3325113"]').waitFor({ timeout: 5_000 });
    await until(() => owned.asked.some((request) => request.refused), 'B’s list asked the route, refused');
    await b.locator('[data-owned="ready"] a[data-position-row="3325113"]').waitFor({ timeout: 30_000 });
    const ready = await b.evaluate(() => window.__ownedReadyAt);
    assert.ok(ready > first, 'the browser observed B’s chain-backed list');
    const late = ready - owned.until;
    assert.ok(late < 6_000, `B’s list from the route ${late} ms after it answered again`);
    assert.deepEqual(await listSeen(b), ['kept', 'kept:rereading', 'ready'], 'B: the copy, the quiet line over it, then the chain’s list; never the loading rows');
    const refused = owned.asked.filter((request) => request.refused);
    console.log(`# B: its copy at once, the chain’s list ${late} ms after the route answered again; ${refused.length} asks refused`);
    assert.deepEqual(site.asked, [], 'nothing reached the server behind the site’s routes');
  } finally {
    await b?.close();
    await s.close();
  }
});

// 2026-09-27 (the owner: show when Domino's automation put the fees back; the review of r5/position: never from the
// collect-and-increase pattern alone). Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the positions are the ledger
// world's (tests/support/fees/ledger-world.mjs), held by Test Wallet A: a plain one whose owner collected three times,
// and the Auto-compound one whose three compounds the engine's own events name, with one collect of its owner's after
// them. Activity lists every row, newest first, in plain words; only the engine's compounds are "Fees added back", with
// the chart's own mark and what the automation put back (their sum is the card's "added $X back"); the owner's collect
// stays "Fees collected".
/** Every row of a position's Activity: its kind, whether it is the automation's, verb, date, figure, and the quiet line under the figure. */
async function activityRowsOf(page) {
  const activity = page.locator('[data-position-activity]');
  await activity.waitFor({ timeout: 60_000 });
  const more = activity.getByRole('button', { name: /^Show \d+ more$/ });
  if (await more.count()) await more.click();
  return activity.locator('.dm-fees-act').evaluateAll((rows) => rows.map((row) => {
    const text = (selector) => row.querySelector(selector)?.innerText.replace(/\s+/g, ' ').trim() ?? null;
    return [row.dataset.kind, row.hasAttribute('data-auto'), text('.dm-fees-act-verb'), text('.dm-fees-act-date'), text('.dm-fees-act-value'), text('.dm-fees-act-tokens')];
  }));
}

test('a position’s Activity names Domino’s automation only where the engine’s own events do, with what it put back, and never from a collect and an increase alone', async () => {
  const collect = (block, fees) => ({ block, kind: 'collect', fees });
  const worlds = {
    plain: ledgerWorld({ holder: OWNER, vault: null, steps: OWNER_STEPS.map((step) => collect(step.block, step.fees)) }),
    automated: ledgerWorld({ holder: OWNER, steps: [...OWNER_STEPS, collect(73_900_000, [1_000_000n, 300_000_000_000_000_000_000n])] }),
  };
  const rows = {};
  for (const [name, world] of Object.entries(worlds)) {
    const chain = world.chain;
    const site = siteRoutes();
    const s = await scenario({ chain, routes: [site.route] });
    try {
      await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
      await s.page.locator('[data-empty="owned-connect"]').waitFor();
      await s.page.evaluate(() => { location.hash = '#/positions/3325113'; });
      await s.page.locator('[data-position-detail][data-position-id="3325113"]').waitFor({ timeout: 15_000 });
      const card = s.page.locator('[data-fees-card][data-fees-state="verified"]');
      await card.waitFor({ timeout: 60_000 });
      if (name === 'automated') {
        await s.page.locator('[data-position-activity] .dm-fees-act[data-auto]').first().waitFor({ timeout: 20_000 });
        await card.getByText('Breakdown', { exact: true }).click();
        await card.locator('[data-automation-impact] [data-impact="added"]').waitFor({ timeout: 20_000 });
      }
      rows[name] = await activityRowsOf(s.page);
      if (name === 'automated') {
        // What the rows say the automation put back is what the card says it did, to the rounding of each row.
        const added = await card.locator('[data-automation-impact] [data-impact="added"]').innerText();
        const total = Number(/added \$([\d,.]+) back/.exec(added)[1].replace(/,/g, ''));
        const sum = rows[name].filter((row) => row[1]).reduce((all, row) => all + Number(row[4].replace(/[$,]/g, '')), 0);
        assert.ok(Math.abs(sum - total) <= 0.005 * 3, `the rows' $${sum.toFixed(2)} against the card's ${added}`);
        assert.equal(await s.page.locator('[data-position-activity] .dm-fees-act[data-auto] .dm-fees-auto-glyph').count(), 3, 'the chart’s own mark on each');
        assert.equal(await s.page.locator('[data-position-activity] .dm-fees-act[data-auto] .dm-fees-act-verb').first().getAttribute('title'), 'Auto-compound added these fees back into your position');
        await s.page.locator('[data-position-activity]').screenshot({ path: join(shots(), 'position-activity-automated.png') });
      } else {
        assert.equal(await s.page.locator('.dm-fees-auto-glyph, [data-automation-impact]').count(), 0, 'nothing of an automation, anywhere on the page');
      }
      assert.doesNotMatch(await s.page.locator('[data-position-activity]').innerText(), /0x[0-9a-f]{6}/i, 'no transaction hash on the page');
      nodeRulesKept(world);
      assert.deepEqual(chain.refused, [], 'nothing but the reads');
      assert.deepEqual(site.asked, [], 'no route of the site is asked');
    } finally { await s.close(); }
  }
  const DATE = /^\d\d-\d\d \d\d:\d\d UTC$/;
  const shape = (row) => [row[0], row[1], row[2], DATE.test(row[3]), row[4] === null ? null : /^\$[\d,]+\.\d\d$/.test(row[4])];
  // Plain: the owner's own three collects, each with the fees it took, in neutral words; no row is the automation's.
  assert.deepEqual(rows.plain.map(shape), [
    ['collect', false, 'Fees collected', true, true],
    ['collect', false, 'Fees collected', true, true],
    ['collect', false, 'Fees collected', true, true],
    ['mint', false, 'Opened', true, null],
  ]);
  for (const row of rows.plain.slice(0, 3)) assert.match(row[5], /USDG .* UFG/, 'the tokens it took');
  // Automated: the owner's collect, then the three the engine names, one row each, with what Auto-compound put back.
  assert.deepEqual(rows.automated.map(shape), [
    ['collect', false, 'Fees collected', true, true],
    ['auto', true, 'Fees added back', true, true],
    ['auto', true, 'Fees added back', true, true],
    ['auto', true, 'Fees added back', true, true],
    ['mint', false, 'Opened', true, null],
  ]);
  for (const row of rows.automated.filter((one) => one[1])) assert.equal(row[5], 'by Auto-compound');
});

// 2026-09-28: the DNS of Vivo, one of Brazil's largest ISPs, answered NXDOMAIN for every host under chain.robinhood.com,
// and the page read through the chain's public fallbacks while its own RPC could not be reached (two scenarios here).
// Changed on purpose (RPC-SPEC §3.4, 2026-10-01, the owner's rule: nothing is read from a public RPC): one scenario. The
// site's chain routes without their node (no secret yet, or the node away: every route answers 503 source_unavailable)
// show the calm states, never "No positions", and no public node is asked; once the node is there, the list, a position's
// header and figures and its fees card are drawn from the routes.
test('the site’s chain routes without their node, then with it: Your positions, a position’s header and figures and its fees card go from their calm states to drawn, and no public node is asked', async () => {
  const open = onChain(OWNED_OPEN);
  const chain = browserChain({ positions: [open, ...OWNED_CLOSED.slice(0, 3).map((id) => closedOnChain(id))], tokens: TOKENS, operations: true });
  // The node away: every chain route answers 503 (RPC-SPEC §2.2). Until UNIT fees lands, a position's state and its fees
  // history are still read from the chain's RPC by the page: that fails too (a 500, never a rate refusal), as the node.
  chain.edge = 'off';
  chain.outage = 500;
  const site = siteRoutes();
  const s = await scenario({ clock: true, refresh: true, chain, routes: [site.route] });
  const feesSettled = () => s.page.waitForFunction(() => document.querySelectorAll('[data-fees-card]').length > 0 && document.querySelectorAll('[data-fees-card][data-fees-state="loading"]').length === 0, null, { timeout: 45_000 });
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    await recordList(s.page);
    await connectWallet(s.page);
    // The list: its calm line at once (the route named a wait of minutes), over no row and never the empty state.
    const card = s.page.locator('[data-owned]');
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): a hidden marker, no line ("Your positions couldn’t be read right now.").
    await card.locator('[data-owned-note="unread"]').waitFor({ state: 'attached', timeout: 20_000 });
    assert.doesNotMatch(await card.innerText(), /couldn’t be read/);
    assert.deepEqual([await card.getAttribute('data-owned'), await card.getAttribute('data-owned-reason')], ['unlisted', 'chain_unavailable']);
    assert.equal(await card.locator('[data-empty], a[data-position-row]').count(), 0, 'never “No positions”');
    assert.ok((await listSeen(s.page)).every((what) => !/owned-none/.test(what)), 'never the empty state');
    assert.equal(await s.page.getByRole('button', { name: /^(Retry|Refresh|Try again|Read again)$/ }).count(), 0, 'no Retry');

    // A position's page: its calm state, and the fees card's.
    await s.page.evaluate((id) => { location.hash = `#/positions/${id}`; }, OWNED_OPEN);
    await s.page.locator('[data-empty="position-unread"]').waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): the title alone ("Its details could not be read just now." is gone), and the fees card's dash has no label ("Fees not available yet").
    assert.doesNotMatch(await s.page.locator('[data-empty="position-unread"]').innerText(), /could not be read/);
    const feeFrame = s.page.locator('[data-fees-card]');
    await feeFrame.locator('[data-pending-plot]').waitFor();
    assert.equal(await feeFrame.locator('.dm-fees-summary .dm-fig-hero').innerText(), '—', 'a failed read is not zero earned');
    assert.equal(await feeFrame.locator('.dm-chart-line, [data-fees-zero]').count(), 0, 'no invented fee series');
    assert.doesNotMatch(await s.page.locator('main').evaluate((root) => {
      const rest = root.cloneNode(true); rest.querySelectorAll('[data-fees-card]').forEach((card) => card.remove()); return rest.textContent;
    }), FORBIDDEN);
    assert.ok(chain.edgeLog.includes('/api/owned/v2/positions'), 'the list asked the site’s route');

    // The node is there: the page's next reads draw the position, its figures and its fees card, then the list.
    chain.edge = 'up';
    chain.outage = null;
    // Changed on purpose (2026-10-15, pack 8, Q3): past 6:15, not 5:01: the routes' "no node" wait (Retry-After 300 s) now
    // has 0 to 25% added at random in the page (src/lib/jitter.ts), so its next read comes 300 to 375 s on, never sooner.
    await jump(s.page, '06:16', { pending: true });
    const detail = s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"]`);
    await detail.waitFor({ timeout: 30_000 });
    assert.match(await detail.locator('.dm-pos-name').innerText(), new RegExp(`#${OWNED_OPEN}`));
    assert.equal(await detail.locator('[data-position-status]').getAttribute('data-position-status'), 'in-range');
    assert.match(await detail.locator('[data-position-stats]').innerText(), /Fees to collect\s+<?[\d.,]+ ETH/);
    await feesSettled();
    const fees = await detail.locator('[data-fees-card]').first().getAttribute('data-fees-state');
    assert.ok(!['loading', 'unavailable'].includes(fees), `the fees card is drawn (${fees})`);
    await s.page.evaluate(() => { location.hash = '#/positions'; });
    await s.page.locator(`[data-owned="ready"][data-owned-block="${chain.head}"] a[data-position-row="${OWNED_OPEN}"]`).waitFor({ timeout: 20_000 });
    assert.equal(await s.page.locator('[data-owned] [data-owned-note]').count(), 0, 'and no line over the chain’s list');
    assert.doesNotMatch(await s.page.locator('main').innerText(), FORBIDDEN);
    assert.deepEqual(chain.publicAsked, [], 'no public RPC, ever');
    assert.deepEqual(site.asked, [], 'nothing reached the server behind the site’s routes');
    assert.deepEqual(chain.refused, [], 'nothing but the reads');
  } finally { await s.close(); }
});

// 2026-09-28 (fix/vivo-release): a position's page with the chain's own RPC unreachable, drawn through the fallbacks.
// Changed on purpose (RPC-SPEC P2, 2026-10-01): with the site's chain routes without their node, the page draws the read
// gateway's row of the NFT (read-v1 `nft-positions`, its pool's `pool-market` and its token's `token`: the page's other
// source), at the gateway's own block and with no action on it, until its own read answers; then that answer in its place.
test('a position’s page with the site’s chain routes without their node: the read gateway’s row, with no action on it, then the page’s own read in its place once the node is there', async () => {
  const { liveNft } = await import('./support/edge-busy.mjs');
  const chain = browserChain({ positions: [onChain(OWNED_OPEN)], tokens: TOKENS });
  // The node away (RPC-SPEC §2.2); until UNIT fees lands, the page's own state read is the chain's RPC: a 500 there.
  chain.edge = 'off';
  chain.outage = 500;
  const NFTS = readGateway('nft-positions.success');
  assert.equal(NFTS.items[0].poolId, STUB_POOL_ID, 'the recorded NFT is in the stub’s pool');
  const read = createReadStub({ answer: (route, body) => (route === 'nft-positions' ? liveNft(NFTS, { ...NFTS.items[0], tokenId: body.tokenIds[0], owner: OWNER, poolKey: STUB_KEY }) : undefined) });
  const site = siteRoutes();
  const s = await scenario({ clock: true, chain, routes: [site.route, (request, url) => read.handle(request, url)] });
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    await connectWallet(s.page);
    await s.page.evaluate((id) => { location.hash = `#/positions/${id}`; }, OWNED_OPEN);
    const detail = s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"]`);
    const at = (block) => s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"][data-snapshot="${block}"]`);
    // The gateway's row: its own block, the pair, the range and the fees ready to collect, and no action for the owner.
    await at(NFTS.snapshot.number).waitFor({ timeout: 30_000 });
    assert.match(await detail.locator('.dm-pos-name').innerText(), /ETH/);
    assert.match(await detail.locator('[data-position-stats]').innerText(), /Fees to collect\s+<?[\d.,]+ ETH/);
    assert.equal((await detail.locator('[data-ticks]').textContent()).trim(), '-60 to 60');
    assert.equal(await detail.locator('[data-position-actions]').count(), 0, 'no action on the gateway’s row');
    assert.equal(await detail.getAttribute('data-position-read'), 'gateway');
    // Changed on purpose 2026-10-15 (pack 7 review): every action is hidden, so the line saying why stays; only its
    // "We’ll keep trying automatically." half left with the status notices.
    const waiting = detail.locator('[data-position-actions-waiting][role="status"]');
    assert.equal(await waiting.innerText(), 'Actions are temporarily unavailable while we refresh this position’s data.');
    assert.deepEqual(nftReads(read), [[OWNED_OPEN]], 'the gateway asked once');
    // The existing owner notice and the neutral pending fee frame explain only the unavailable data.
    const feeFrame = detail.locator('[data-fees-card]');
    await feeFrame.locator('[data-pending-plot]').waitFor();
    assert.equal(await feeFrame.locator('.dm-fees-summary .dm-fig-hero').innerText(), '—');
    assert.equal(await feeFrame.locator('.dm-chart-line, [data-fees-zero]').count(), 0, 'the gateway row does not invent a fee history');
    assert.doesNotMatch(await s.page.locator('main').evaluate((root) => {
      const rest = root.cloneNode(true); rest.querySelectorAll('[data-fees-card], [data-position-actions-waiting]').forEach((item) => item.remove()); return rest.textContent;
    }), FORBIDDEN);

    // The node is there: the page's own read, at the head, in place of the row, and the owner's actions with it.
    chain.edge = 'up';
    chain.outage = null;
    // Changed on purpose (2026-10-15, pack 8, Q3): past 6:15, not 5:01: the routes' "no node" wait (Retry-After 300 s) now
    // has 0 to 25% added at random in the page (src/lib/jitter.ts), so its next read comes 300 to 375 s on, never sooner.
    await jump(s.page, '06:16', { pending: true });
    await at(chain.head).waitFor({ timeout: 30_000 });
    // The owner toolbar and its lazy-loaded button group both mark actions; wait for the toolbar.
    await detail.locator('.dm-pos-actions[data-position-actions]').waitFor({ timeout: 15_000 });
    await detail.locator('[data-position-action="collect"]').waitFor();
    await detail.locator('[data-position-action="close"]').waitFor();
    assert.equal(await detail.getAttribute('data-position-read'), 'chain');
    assert.equal(await waiting.count(), 0, 'the explanation leaves when the original owner controls return');
    assert.match(await detail.locator('[data-position-stats]').innerText(), /Fees to collect\s+<?[\d.,]+ ETH/);
    assert.deepEqual(nftReads(read), [[OWNED_OPEN]], 'the gateway was not asked again over the page’s own read');
    assert.deepEqual(chain.publicAsked, [], 'no public RPC, ever');
    assert.deepEqual(site.asked, [], 'nothing reached the server behind the site’s routes');
  } finally { await s.close(); }
});

// 2026-09-25: the automation page's position picker is the same browser read (useWalletPositions → the page's own scan):
// the wallet's open positions from the chain, a closed one left out, and the link's position preselected.
test('the automation page lists the wallet’s open positions from the page’s own chain read, and a failed read is loading, then one line, never “no open positions”', async () => {
  const sequence = fakeSequenceChain(OWNER, { roots: [] });
  const chain = browserChain({ positions: [onChain('5'), closedOnChain('6'), onChain('7', { holder: OTHER_OWNER })], tokens: TOKENS });
  const site = siteRoutes();
  const s = await scenario({ chain, routes: [site.route] });
  await routeChain(s, sequence, CHAIN_METHODS);
  try {
    s.set({ sequenceRelease: { status: 200, body: sequence.release } });
    await s.page.goto(`${s.origin}/#/sequence/compound/5`);
    await s.page.reload();
    await connectOnly(s.page);
    const option = s.page.locator('[data-sequence-position]');
    await option.first().waitFor({ timeout: 15_000 });
    assert.deepEqual(await option.evaluateAll((all) => all.map((button) => [button.getAttribute('data-sequence-position'), button.getAttribute('aria-checked')])), [['5', 'true']], 'the open one, chosen by the link; the closed one and someone else’s are not listed');
    assert.equal(chain.edgeLog.filter((path) => path === '/api/owned/v2/positions').length, 1);
    assert.deepEqual(site.asked, [], 'no route of the site is asked');

    // Another wallet, and a chain that refuses every read: loading while it is asked again, then one line; never "No open positions".
    chain.outage = 500;
    await s.wallet.switchAccount('a', 1);
    await s.page.locator('[data-sequence-positions="loading"]').waitFor();
    const failed = s.page.locator('[data-sequence-positions="failed"]');
    await failed.waitFor({ timeout: 30_000 });
    assert.equal(await s.page.locator('[data-sequence-positions="empty"]').count(), 0);
    assert.deepEqual(sequence.sends, [], 'nothing is sent');
    assert.equal(s.wallet.state.signed.length, 0, 'no sign-in signature');
  } finally { await s.close(); }
});

// ---- Receipts never blank (the owner, 2026-09-27, round 6) ------------------------------------------------------------------
part('automation');
//
// The receipts page painted from nothing on every read, blanked whenever the tab was hidden (a window covering the browser counts)
// and lost Show more's rows to the next refresh. Now what is shown stays through every read, a hidden tab and a failure; Show
// more and an opened row keep their state; and a reload paints from this browser's copy before any read answers.

/** Records, in the page, every moment the receipts section shows no list, or an empty or loading line in its place. */
const watchBlank = (page) => page.evaluate(() => {
  window.__receiptsBlank = [];
  const check = () => {
    const section = document.querySelector('section[aria-label="Execution receipts"]');
    if (section && (!section.querySelector('.dm-rcpt-list') || section.querySelector('.dm-acct-quiet'))) window.__receiptsBlank.push(section.innerText.slice(0, 80));
  };
  new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
});

test('the receipts page never blanks: reads merge in place, a hidden tab and a failed read keep every row, Show more and an opened row keep their state; reloaded, it paints from this browser’s copy before any read answers', async () => {
  const s = await scenario({ clock: true });
  // Twenty-four compounds and one cancelled attempt: two of the service's pages of twenty, in its id order.
  const items = [...Array.from({ length: 24 }, (_, n) => receiptItem(n + 1, 'reconciled', { block: 7_340_000 + n * 97, usdg: String((n + 1) * 1_000_000) })), receiptItem(25, 'cancelled')];
  const pages = [items.slice(0, 20), items.slice(20)];
  const asked = await answerReceipts(s.context, pages);
  const listReads = () => asked.filter(call => call.path.endsWith('/list')).length;
  const LIST = /\/api\/execution\/v1\/list$/;
  try {
    await login(s.page);
    await s.page.evaluate(() => { location.hash = '#/positions/receipts'; });
    const full = s.page.locator('section[aria-label="Execution receipts"]');
    const list = full.locator('.dm-rcpt-list');
    await s.page.locator('section[aria-label="Execution receipts"][data-execution="ready"]').waitFor();
    await unitsRead(full);
    // The second page by itself, at the contract's pace: the rows take it in, newest first.
    await jump(s.page, '00:31');
    await full.locator(`[data-execution-intent="${intentOf(24)}"]`).waitFor();
    assert.equal(listReads(), 2);
    await unitsRead(full);
    assert.equal(await full.getAttribute('data-execution-rows'), '10', 'ten rows at first');
    assert.deepEqual((await rowTexts(list)).slice(0, 2), ['Done | Fees added back | 24 USDG', 'Done | Fees added back | 23 USDG']);
    // Show more: ten more rows at once, from what was read; and one row opened.
    await full.getByRole('button', { name: 'Show more', exact: true }).click();
    assert.equal(await full.getAttribute('data-execution-rows'), '20');
    const opened = list.locator(`[data-execution-intent="${intentOf(20)}"] > details`);
    await opened.locator('summary').click();
    assert.equal(await opened.evaluate(details => details.open), true);
    await watchBlank(s.page);

    // A hidden tab (a window covering the browser counts) keeps every row, and reads nothing.
    await setVisibility(s.page, 'hidden');
    await jump(s.page, '10:00');
    assert.equal(listReads(), 2, 'hidden: nothing is read');
    assert.equal(await full.getAttribute('data-execution-rows'), '20');
    // Shown again after longer than five minutes: the list is read again, quietly.
    await setVisibility(s.page, 'visible');
    await until(() => listReads() === 3, 'the list read again');

    // The service fails: what is shown stays.
    const refuse = route => route.fulfill({ status: 503, contentType: 'application/json; charset=utf-8', headers: { 'X-Domino-Execution-Contract': executionRuntime.CONTRACT_VERSION }, body: JSON.stringify({ error: 'execution_store_unavailable' }) });
    await s.context.route(LIST, refuse);
    await jump(s.page, '00:31');
    await s.page.locator('section[aria-label="Execution receipts"][data-execution="unavailable"][data-execution-reason="execution_store_unavailable"]').waitFor();
    assert.equal(await full.getAttribute('data-execution-rows'), '20', 'a failed read keeps every row');
    // Changed on purpose 2026-10-15 (pack 7, owner: no status notices): what is shown stays, with no line ("Showing saved receipts. New activity couldn’t be loaded."): a hidden marker.
    assert.equal(await full.locator('[data-receipts-update="unavailable"]').count(), 1);
    assert.equal(await full.locator('[data-receipts-update]').innerText(), '');
    await captureReceiptState(s.page, 'receipts-saved', full);
    // Back, with a new compound: the next ask, a minute on, finds it; it joins at the top, every other row where it was.
    await s.context.unroute(LIST, refuse);
    pages[1].push(receiptItem(26, 'reconciled', { block: 7_400_000, usdg: '99000000' }));
    await jump(s.page, '01:01');
    await full.locator(`[data-execution-intent="${intentOf(26)}"]`).waitFor();
    await unitsRead(full);
    assert.equal(await full.getAttribute('data-execution'), 'ready');
    assert.equal(await full.locator('[data-receipts-update]').count(), 0, 'the update note clears after a successful read');
    assert.deepEqual((await rowTexts(list)).slice(0, 3), ['Done | Fees added back | 99 USDG', 'Done | Fees added back | 24 USDG', 'Done | Fees added back | 23 USDG']);
    assert.equal(await full.getAttribute('data-execution-rows'), '20', 'Show more kept its rows through every read');
    assert.equal(await opened.evaluate(details => details.open), true, 'the opened row is still open');
    assert.deepEqual(await s.page.evaluate(() => window.__receiptsBlank), [], 'the list never blanked, and no empty or loading line took its place');
    assert.doesNotMatch(await full.innerText(), /Reading receipts|Loading|re-add/i);
    await opened.locator('summary').click();
    await shootBoth(s.page, 'r6-receipts-page-after-refreshes');
    const kept = await s.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.kept.v1.')).sort());
    // Managed positions keep theirs too once their first read answered on Positions (#/app, where the login lands).
    assert.deepEqual(kept.filter(key => !key.startsWith('domino.kept.v1.managed.4663.' + OWNER)), ['domino.kept.v1.receipts.4663.' + OWNER, 'domino.kept.v1.tokens'], 'one versioned copy per kind and wallet, and the public token details');

    // Reloaded with the list route held: while the session is checked and after, this browser's copy paints the rows, amounts
    // in token units, before any read answers.
    const held = [];
    await s.context.route(LIST, route => { held.push(route); });
    await s.page.reload();
    // The wallet reconnects by itself and its session is found again: the rows are this browser's copy, the list read held.
    await full.locator(`[data-execution-intent="${intentOf(26)}"]`).waitFor();
    assert.ok(['checking', 'loading'].includes(await full.getAttribute('data-execution')), 'no read has answered');
    assert.equal(await full.locator(`[data-execution-intent="${intentOf(26)}"] [data-receipt-added]`).innerText(), '99 USDG', 'token details kept too');
    assert.equal(await full.getAttribute('data-execution-rows'), '10');
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await until(() => held.length === 1, 'the list asked, and held');
    assert.equal(await full.getAttribute('data-execution'), 'loading');
    assert.equal(await full.getAttribute('data-execution-rows'), '10', 'signed in, the same rows');
    await shootBoth(s.page, 'r6-receipts-page-from-copy');
    for (const route of held) await route.abort().catch(() => {});
  } finally { await s.close(); }
});

test('a copy this browser kept for another wallet, or one the contract refuses, is never shown', V1_HISTORY, async () => {
  const s = await scenario({ clock: true });
  const other = '0x' + 'ee'.repeat(20);
  const good = receiptItem(1, 'reconciled', { block: 7_340_000, usdg: '5000000' });
  const held = [];
  await s.context.route(/\/api\/execution\/v1\/list$/, route => { held.push(route); });
  try {
    await login(s.page);
    // Planted while signed in, so the reload finds the session again (a check that finds none forgets the copy instead):
    // another wallet's copy, and this wallet's with a finalized receipt missing its receipt.
    await s.page.evaluate(({ owner, other, good }) => {
      const at = Date.now();
      localStorage.setItem(`domino.kept.v1.receipts.4663.${other}`, JSON.stringify({ at, data: [good] }));
      localStorage.setItem(`domino.kept.v1.receipts.4663.${owner}`, JSON.stringify({ at, data: [{ ...good, receipt: null }] }));
    }, { owner: OWNER, other, good });
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    const receipts = s.page.locator('section[aria-label="Execution receipts"]');
    await s.page.locator('section[aria-label="Execution receipts"][data-execution="loading"]').waitFor();
    assert.equal(await receipts.locator('[data-execution-intent]').count(), 0, 'nothing from another wallet, nothing the contract refuses');
    assert.equal(await receipts.locator('.dm-acct-quiet').innerText(), 'Loading receipts…');
    await captureReceiptState(s.page, 'receipts-loading', receipts);
    assert.equal(await s.page.evaluate(owner => localStorage.getItem(`domino.kept.v1.receipts.4663.${owner}`), OWNER), null, 'the refused copy is dropped');
    assert.notEqual(await s.page.evaluate(other => localStorage.getItem(`domino.kept.v1.receipts.4663.${other}`), other), null, 'another wallet’s is left alone');
    for (const route of held) await route.abort().catch(() => {});
  } finally { await s.close(); }
});

// Managed positions never flash empty either (the owner, 2026-09-27, round 6), and a sign-out forgets what this browser kept.
test('Managed positions never flash empty: a hidden tab, a failed read and the way back keep the cards; reloaded, they paint from this browser’s copy; signing out forgets every private copy', V1_HISTORY, async () => {
  const s = await scenario({ clock: true });
  await answerReceipts(s.context, [[receiptItem(2, 'reconciled', { block: 7346840, usdg: '16490000' })]]);
  const PERFORMANCE = /\/api\/performance\/v2\//, LIST = /\/api\/execution\/v1\/list$/;
  try {
    await login(s.page);
    const history = s.page.locator('section[aria-label="Private performance"]');
    const row = history.locator('.dm-mp-row[data-performance-status]');
    await row.waitFor();
    await s.page.locator('section[aria-label="Execution receipts"][data-execution="ready"]').waitFor();
    // Every moment either card shows no rows, from here on.
    await s.page.evaluate(() => {
      window.__cardsBlank = [];
      const check = () => {
        const managed = document.querySelector('section[aria-label="Private performance"]'), receipts = document.querySelector('section[aria-label="Execution receipts"]');
        if (location.pathname + location.hash !== '/positions/receipts' && !managed?.querySelector('.dm-mp-row')) window.__cardsBlank.push(`managed: ${managed?.innerText.slice(0, 60) ?? 'gone'}`);
        if (!receipts?.querySelector('.dm-rcpt-list')) window.__cardsBlank.push(`receipts: ${receipts?.innerText.slice(0, 60) ?? 'gone'}`);
      };
      new MutationObserver(check).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    // Hidden: nothing is read and the cards stay; shown again, they are read again in place.
    const reads = s.calls.length;
    await setVisibility(s.page, 'hidden');
    await jump(s.page, '10:00');
    assert.equal(s.calls.length, reads, 'hidden: nothing is read');
    await setVisibility(s.page, 'visible');
    await until(() => s.calls.length >= reads + 2, 'read again once shown');
    // The service fails: the cards stay, the failure is only the section's data.
    const refuse = route => route.fulfill({ status: 503, contentType: 'application/json; charset=utf-8', headers: { 'X-Domino-Performance-Contract': runtime.CONTRACT_VERSION }, body: JSON.stringify({ error: 'performance_store_unavailable' }) });
    await s.context.route(PERFORMANCE, refuse);
    await jump(s.page, '01:01');
    await s.page.locator('section[aria-label="Private performance"][data-performance="unavailable"]').waitFor();
    assert.equal(await row.count(), 1, 'a failed read keeps the card');
    await s.context.unroute(PERFORMANCE, refuse);
    // Away to the receipts page and back: the card is there at once, with no read of its own.
    await s.page.evaluate(() => { location.hash = '#/positions/receipts'; });
    await s.page.locator('.dm-rcpt-list').waitFor();
    await s.page.evaluate(() => { location.hash = '#/positions'; });
    await row.waitFor({ timeout: 2_000 });
    assert.deepEqual(await s.page.evaluate(() => window.__cardsBlank), [], 'neither card ever showed no rows');
    assert.deepEqual(await s.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.kept.v1.')).sort()),
      [`domino.kept.v1.managed.4663.${OWNER}`, `domino.kept.v1.receipts.4663.${OWNER}`, 'domino.kept.v1.tokens']);

    // Reloaded with every private read held: this browser's copies paint both cards before any answer, and from the first
    // frame neither card says to sign in, that its rows will appear, or that it is loading.
    const held = [];
    await s.context.route(PERFORMANCE, route => { held.push(route); });
    await s.context.route(LIST, route => { held.push(route); });
    await s.context.addInitScript(() => {
      window.__cardsSaid = [];
      const check = () => {
        for (const section of document.querySelectorAll('section[aria-label="Private performance"], section[aria-label="Execution receipts"]')) {
          const text = section.innerText;
          if (/Sign in with|appear here|Loading|Reading/.test(text)) window.__cardsSaid.push(text.slice(0, 80));
        }
      };
      new MutationObserver(check).observe(document, { subtree: true, childList: true, characterData: true });
    });
    await s.page.reload();
    await row.waitFor();
    await s.page.locator('section[aria-label="Execution receipts"] .dm-rcpt-list').waitFor();
    assert.ok(['checking', 'loading'].includes(await history.getAttribute('data-performance')), 'no read has answered');
    assert.deepEqual(await row.locator(':scope > .dm-mp-figs dd').allInnerTexts(), ['$0.50', '$50.00', '-14.78%'], 'the figures kept');
    await shootBoth(s.page, 'r6-positions-from-copy', s.page.locator('.dm-acct-pair'));
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    assert.deepEqual(await s.page.evaluate(() => window.__cardsSaid), [], 'no sign-in, empty or loading line on the way');
    await s.context.unroute(PERFORMANCE);
    await s.context.unroute(LIST);
    for (const route of held.splice(0)) await route.abort().catch(() => {});

    // Signed out: both cards say so, and this browser forgets the wallet's private copies (the public token details stay).
    await s.page.locator('header [aria-haspopup="dialog"]').click();
    await s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Sign out', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
    await s.page.keyboard.press('Escape');
    // Changed on purpose 2026-10-01 (the D2 follow-up): with nothing to show for the same reason, one line for both cards.
    await s.page.getByText('Sign in with your wallet to see your automated positions and their receipts.', { exact: true }).waitFor();
    assert.deepEqual(await s.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.kept.v1.'))), ['domino.kept.v1.tokens']);
  } finally { await s.close(); }
});

// 2026-10-01 (audit D2): connected and signed out, each card says to sign in and carries the button the audit asks for,
// which opens the header's wallet dialog: signing in there fills both cards. Nothing private is read before.
// Changed on purpose 2026-10-01 (the D2 follow-up): with nothing to show for the same reason, the two cards are one calm
// line in one card, with its one Sign in; signing in puts both cards back, filled.
test('connected and signed out, the cards’ one line offers Sign in, which opens the wallet dialog, and signing in there fills both cards', async () => {
  const s = await scenario();
  try {
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    const dialog = s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
    const merged = s.page.locator('[data-automation-cards="merged"] [data-automation-empty]');
    await s.page.locator('[data-automation-empty="no_wallet"]').waitFor();
    await s.page.locator('header [aria-haspopup="dialog"]').click();
    await dialog.getByRole('button', { name: 'Connect Test Wallet A', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
    await s.page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    await s.page.locator('[data-automation-empty="signed_out"]').waitFor();
    assert.equal((await merged.innerText()).replace(/\s+/g, ' ').trim(), 'Managed positions and receipts Sign in with your wallet to see your automated positions and their receipts. Sign in');
    assert.equal(await s.page.locator('main').getByText(/^Sign in with your wallet to see your (automated positions|receipts)\.$/).filter({ visible: true }).count(), 0, 'not said twice');
    assert.deepEqual(await Promise.all(['managed-title', 'receipts-title'].map((id) => s.page.locator(`section[aria-labelledby="${id}"]`).isVisible())), [false, false]);
    assert.equal(await s.page.locator('[data-receipts-all]').isVisible(), false, 'no See all with nothing to list');
    assert.deepEqual([s.calls.length, s.executions.length], [0, 0], 'nothing private is read while signed out');
    await merged.getByRole('button', { name: 'Sign in', exact: true }).click();
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await s.page.keyboard.press('Escape');
    await s.page.locator('section[aria-label="Execution receipts"][data-execution="ready"]').waitFor();
    assert.equal(await s.page.locator('[data-automation-cards="split"]').count(), 1, 'both cards back, filled');
    assert.equal(await s.page.locator('[data-automation-empty]').count(), 0);
    assert.equal(await s.page.locator('[data-signed-out]').count(), 0);
    assert.equal(await s.page.locator('[data-receipts-all]').isVisible(), true);
    assert.equal(s.wallet.state.signed.length, 1, 'the one sign-in signature');
  } finally { await s.close(); }
});

// 2026-10-01 (the D2 follow-up): signed in, with no automation and no receipt yet, Managed positions and Receipts have
// nothing to show for the same reason: one calm line for both. A receipt read later puts both cards back.
test('signed in with nothing automated and no receipt yet, the two cards are one calm line; a receipt read later puts both cards back', async () => {
  const s = await scenario({ clock: true });
  await s.context.route(/\/api\/performance\/v2\/epochs$/, async (route) => {
    const answer = { ...fixture('responses/epochs'), owner: OWNER, enrollments: [] };
    assert.ok(runtime.validateResponse('epochs', answer), 'the epochs answer is valid');
    await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', headers: { 'X-Domino-Performance-Contract': runtime.CONTRACT_VERSION }, body: JSON.stringify(answer) });
  });
  const pages = [[]];
  await answerReceipts(s.context, pages);
  try {
    await login(s.page);
    const merged = s.page.locator('[data-automation-empty="empty"]');
    await merged.waitFor();
    // Changed on purpose 2026-10-01 (integration pass 3, the copy review): the line is shorter, with "here" once.
    assert.equal((await merged.innerText()).replace(/\s+/g, ' ').trim(), 'Managed positions and receipts Nothing here yet. Turn on Auto-compound for a position to follow it and its receipts here.');
    assert.equal(await merged.locator('button').count(), 0, 'nothing to press');
    assert.doesNotMatch(await merged.innerText(), FORBIDDEN);
    await s.page.locator('section[aria-label="Execution receipts"][data-execution="ready"]').waitFor({ state: 'attached' });
    assert.deepEqual(await Promise.all(['managed-title', 'receipts-title'].map((id) => s.page.locator(`section[aria-labelledby="${id}"]`).isVisible())), [false, false], 'the two cards stay, hidden, and go on reading');
    await shootBoth(s.page, 'd2-nothing-yet', s.page.locator('.dm-acct-pair'));
    // A receipt: read at the list's own next read (every five minutes while the tab is shown), it puts both cards back.
    pages[0] = [receiptItem(2, 'reconciled', { block: 7346840, usdg: '16490000' })];
    await jump(s.page, '05:01');
    await s.page.locator('section[aria-label="Execution receipts"] [data-execution-intent]').first().waitFor();
    assert.equal(await s.page.locator('[data-automation-cards="split"]').count(), 1);
    assert.equal(await s.page.locator('[data-automation-empty]').count(), 0);
    // Changed on purpose 2026-10-06 (rugged's answer of 6 Oct, §3): with Domino V2 in the build, Managed positions is the
    // vaults' card (no V1 history), whose plate says where they appear.
    const plate = WALLET_DIST === WALLET_V2_DIST ? 'Your automated positions appear here.' : 'Nothing here yet. Turn on Auto-compound for a position and how it does shows here.';
    await s.page.getByText(plate, { exact: true }).waitFor();
  } finally { await s.close(); }
});

// 2026-09-28, round 6 review: the copies were forgotten only by the cards' own controllers, which stop once no Positions view is
// shown, so a sign-out on any other page left them in this browser (up to 30 days), and the next visit painted the signed-out
// wallet's receipts while its session was checked. The wallet island, on every page, forgets every private copy instead.
test('signing out or letting the wallet go on any page forgets every private copy, and the next visit paints none of them', V1_HISTORY, async () => {
  const s = await scenario();
  await answerReceipts(s.context, [[receiptItem(1, 'reconciled', { block: 7_340_000, usdg: '5000000' }), receiptItem(2, 'reconciled', { block: 7_340_100, usdg: '7000000' })]]);
  const kept = () => s.page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('domino.kept.v1.')).sort());
  const dialog = s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
  const both = [`domino.kept.v1.managed.4663.${OWNER}`, `domino.kept.v1.receipts.4663.${OWNER}`, 'domino.kept.v1.tokens'];
  /** Until this browser keeps exactly `want`; else fails with what it keeps. */
  const keptIs = (want, label) => s.page.waitForFunction(names => JSON.stringify(Object.keys(localStorage).filter(key => key.startsWith('domino.kept.v1.')).sort()) === JSON.stringify(names), want, { timeout: 10_000 })
    .catch(async () => assert.deepEqual(await kept(), want, label));
  /** Positions, until both cards kept their copy; then Markets, where no card is shown. */
  const keepThenLeave = async () => {
    await s.page.evaluate(() => { location.hash = '#/positions'; });
    await s.page.locator('section[aria-label="Execution receipts"][data-execution="ready"] [data-execution-intent]').first().waitFor();
    await s.page.locator('section[aria-label="Private performance"] .dm-mp-row').first().waitFor();
    await keptIs(both, 'both copies kept');
    await s.page.evaluate(() => { location.hash = '#/markets'; });
    await s.page.waitForFunction(() => !document.querySelector('section[aria-label="Execution receipts"], section[aria-label="Private performance"]'));
  };
  try {
    await login(s.page);
    await keepThenLeave();
    // Sign out from the header's wallet dialog, on Markets.
    await s.page.locator('header [aria-haspopup="dialog"]').click();
    await dialog.getByRole('button', { name: 'Sign out', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
    await s.page.keyboard.press('Escape');
    await keptIs(['domino.kept.v1.tokens'], 'signed out on Markets: only the public token details stay');

    // The next visit, on Positions: while the wallet's session is checked, no private row paints.
    await s.context.addInitScript(() => {
      window.__painted = [];
      new MutationObserver(() => {
        const rows = document.querySelectorAll('section[aria-label="Execution receipts"] [data-execution-intent], section[aria-label="Private performance"] .dm-mp-row').length;
        if (rows) window.__painted.push(rows);
      }).observe(document, { subtree: true, childList: true });
    });
    await s.page.evaluate(() => { location.hash = '#/positions'; });
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out', null, { timeout: 30_000 });
    // Changed on purpose 2026-10-01 (the D2 follow-up): signed out, the two cards are one line for both.
    await s.page.getByText('Sign in with your wallet to see your automated positions and their receipts.', { exact: true }).waitFor();
    assert.deepEqual(await s.page.evaluate(() => window.__painted), [], 'a signed-out wallet’s receipts and positions never paint');

    // Signed in again, then another account picked in the wallet, on Markets: that session ends, and the same.
    await s.page.locator('header [aria-haspopup="dialog"]').click();
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await s.page.keyboard.press('Escape');
    await keepThenLeave();
    await s.wallet.switchAccount('a', 1);
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
    await keptIs(['domino.kept.v1.tokens'], 'another account on Markets: only the public token details stay');
    // And a wallet let go: signed out, then disconnected, keeps none either.
    await s.page.locator('header [aria-haspopup="dialog"]').click();
    await dialog.getByRole('button', { name: 'Disconnect wallet', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await s.page.keyboard.press('Escape');
    await keptIs(['domino.kept.v1.tokens'], 'let go: only the public token details stay');
  } finally { await s.close(); }
});

// ---- Fees waiting in a vault (2026-10-02; rugged97's spec rev3 §2.13, the V1 incident of that day) -------------------
part('automation');
// An owner closed his vault's root position, and the fees its automation had collected and not yet reinvested (the vault's
// fee reserves) stayed in the vault with no screen offering them back. They are shown now whenever any is above zero,
// whatever became of the root, on Positions (every vault the wallet created) and on the root's own page, with Withdraw to
// wallet: one transaction per balance, as the contract takes them, or one batch for a wallet that batches atomically. The
// wallet's chain is fakeSequenceChain (its `reserves`); the site's routes read browserChain, whose roots say what became
// of each position.

const RESERVE_BASE = `0x${'61'.repeat(20)}`, RESERVE_QUOTE = `0x${'62'.repeat(20)}`;
const RESERVE_TOKENS = { [RESERVE_BASE]: { symbol: 'AAA', decimals: 18 }, [RESERVE_QUOTE]: { symbol: 'BBB', decimals: 6 } };
/** The owner's words (the spec's §5.6), on the card and in the review. */
const RESERVES_LEDE = 'Fees the automation collected and had not reinvested yet. They’re yours: withdrawing charges no Domino fee.';
const OTHER_HOLDER = `0x${'0b'.repeat(20)}`;

/**
 * A connected wallet (Test Wallet A, not signed in) whose vaults hold fees: the wallet's chain is `seq`, and the site's
 * routes read `positions` and `vaults` (each given `seq`, whose vault addresses they need). Batches are answered by the
 * wallet's chain when `batch` is set.
 *
 * Added with the review of the fee withdrawal (2026-10-02): the wallet's chain answers the vaults' own records
 * (eth_getLogs); `release` is what the release Worker answers (the published one by default), and `shipped` stands in
 * for the V1 release a deployable build ships for recovery (src/finance/pin.ts SEQUENCE_RECOVERY_RECORD), which a test
 * build has none of unless a test gives one.
 *
 * Changed on purpose 2026-11-09 (core flows, V1 leftovers): the card no longer asks the release Worker
 * (src/finance/reservesLive.ts): V1's profile expired on 2026-10-21 and the request only met a 503. The shipped record
 * stands in by default (the very deployment every deployable build ships), so each test reads the vaults as before;
 * `shipped: null` is a build with none.
 */
async function reservesScenario({ seq, positions = () => [], vaults = () => ({}), batch = false, release = { status: 200, body: seq.release }, shipped = seq.release, clock = false }) {
  const chain = browserChain({ positions: positions(seq), tokens: TOKENS, vaults: vaults(seq) });
  // (2026-10-15, pack 7): `clock` installs the page's clock, so a test can step past the minute a read is kept.
  const s = await scenario({ chain, clock });
  await routeChain(s, seq, [...CHAIN_METHODS, 'eth_getLogs', ...(batch ? BATCH_METHODS : [])]);
  const tokenReads = await answerTokenReads(s.context, RESERVE_TOKENS);
  await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  if (shipped) await s.context.addInitScript((record) => { window.__dominoRecoveryRecord = record; }, shipped);
  s.set({ sequenceRelease: release });
  await s.page.reload();
  await connectOnly(s.page);
  return { s, chain, tokenReads };
}
const goTo = (s, hash) => s.page.evaluate((next) => { location.hash = next; }, hash);
/** The withdrawals the wallet sent, decoded: where each went, its value, and its exact arguments. */
const sentWithdrawals = (seq) => seq.sends.map((tx) => {
  const { functionName, args } = decodeFunctionData({ abi: chainAbi, data: tx.data });
  return { to: String(tx.to).toLowerCase(), value: tx.value, functionName, args };
});
const reservesDialog = (s) => s.page.locator('[role="dialog"][aria-labelledby="reserves-dialog-title"]');

test('fees waiting in the vault of an armed root: Positions shows them per token, exactly, and Withdraw to wallet sends one withdrawal per balance, each once, then the card goes', async () => {
  const seq = fakeSequenceChain(OWNER, { roots: [BigInt(OWNED_OPEN)], settled: true, reserves: { 0: [
    { tokenId: BigInt(OWNED_OPEN), source: 0, currency: 'base', original: 1_250_000_000_000_000_000n },
    { tokenId: BigInt(OWNED_OPEN), source: 1, currency: 'quote', original: 2_500_000n },
  ] } });
  const { s, chain } = await reservesScenario({ seq,
    positions: (q) => [onChain(OWNED_OPEN, { subscriber: q.vaults[0] })],
    vaults: (q) => ({ [q.vaults[0]]: { root: OWNED_OPEN, feeBps: 400, paused: false, valid: true } }) });
  try {
    await goTo(s, '#/positions');
    const card = s.page.locator('section[data-fee-reserves="positions"]');
    await card.waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
    assert.equal(await card.getByRole('heading').innerText(), 'Fees waiting in your automation');
    assert.equal(await card.locator('.dm-reserves-lede').innerText(), RESERVES_LEDE);
    const row = card.locator(`[data-reserve-vault="${seq.vaults[0]}"]`);
    await row.locator(`[data-reserve-currency="${RESERVE_QUOTE}"]`).getByText('2.5 BBB', { exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await row.locator(`[data-reserve-currency="${RESERVE_BASE}"]`).innerText(), '1.25 AAA', 'every digit, in the token’s own units');
    assert.equal(await row.locator('a').getAttribute('href'), `/positions/${OWNED_OPEN}`);
    assert.equal(await row.locator('[data-reserve-status]').innerText(), 'Automation on');
    const text = await card.innerText();
    assert.doesNotMatch(text, /\$|USD/, 'no price is made up for them');
    assert.doesNotMatch(text, /0x[0-9a-f]{4}/, 'no address in sight');
    assert.doesNotMatch(text, FORBIDDEN);
    await noManualReads(card);
    assert.equal(seq.sends.length, 0, 'opening the page sends nothing');
    await s.page.screenshot({ path: join(shots(), 'p2-fee-reserves-card.png'), fullPage: true });
    await s.page.setViewportSize({ width: 390, height: 844 });
    await card.screenshot({ path: join(shots(), 'p2-fee-reserves-card-phone.png') });
    await s.page.setViewportSize({ width: 1320, height: 1000 });

    // The review: read again through the wallet, exactly what comes back, no Domino fee, the network fee, two transactions.
    await row.getByRole('button', { name: 'Withdraw to wallet', exact: true }).click();
    const dialog = reservesDialog(s);
    await s.page.locator('[data-reserves-dialog="ready"]').waitFor({ timeout: 30_000 });
    const review = dialog.locator('[data-reserves-review]');
    assert.equal(await dialog.locator('.dm-receipt-lede').innerText(), RESERVES_LEDE);
    assert.deepEqual(await review.locator('[data-reserve-currency]').allInnerTexts(), ['1.25 AAA', '2.5 BBB']);
    assert.match(await review.innerText(), /Domino fee\s+None/);
    assert.match(await dialog.locator('[data-reserves-network-fee]').innerText(), /^Network fee\s+Up to [0-9.]+ ETH each$/);
    assert.equal(await dialog.locator('[data-reserves-steps]').innerText(), 'Your wallet asks you to confirm 2 transactions, one after the other: your automation pays each balance on its own.');
    assert.equal(seq.sends.length, 0, 'the review sends nothing');
    assert.equal(await dialog.getByRole('button', { name: 'Withdraw in wallet', exact: true }).isEnabled(), true);
    await s.page.screenshot({ path: join(shots(), 'p2-fee-reserves-review.png') });

    await dialog.getByRole('button', { name: 'Withdraw in wallet', exact: true }).click();
    await s.page.locator('[data-reserves-dialog="done"]').waitFor({ timeout: 60_000 });
    assert.equal(await dialog.getByRole('heading').innerText(), 'Returned to your wallet');
    const receipt = dialog.locator('[data-reserves-receipt]');
    assert.deepEqual(await receipt.locator('[data-reserve-currency]').allInnerTexts(), ['1.25 AAA', '2.5 BBB']);
    assert.equal(await receipt.locator('[data-reserves-transaction]').count(), 2, 'each transaction, its hash copyable');
    assert.deepEqual(sentWithdrawals(seq), [
      { to: seq.vaults[0], value: '0x0', functionName: 'withdrawFeeReserves', args: [seq.sourceOf(BigInt(OWNED_OPEN), 0), RESERVE_BASE, 1_250_000_000_000_000_000n, 0n] },
      { to: seq.vaults[0], value: '0x0', functionName: 'withdrawFeeReserves', args: [seq.sourceOf(BigInt(OWNED_OPEN), 1), RESERVE_QUOTE, 2_500_000n, 0n] },
    ], 'one exact withdrawal per balance, each sent once, to the vault, with no value');
    assert.deepEqual([seq.balanceOf(0, OWNED_OPEN, 0, 'base'), seq.balanceOf(0, OWNED_OPEN, 1, 'quote')], [{ original: 0n, charged: 0n }, { original: 0n, charged: 0n }]);
    await s.page.screenshot({ path: join(shots(), 'p2-fee-reserves-returned.png') });

    // Done: the vault holds nothing now, and the card is gone.
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await s.page.locator('[data-fee-reserves-read="positions"][data-fee-reserves-state="ready"][hidden]').waitFor({ state: 'attached', timeout: 30_000 });
    assert.equal(await s.page.locator('section[data-fee-reserves]').count(), 0);
    assert.equal(seq.sends.length, 2, 'nothing more was sent');
    assert.deepEqual([seq.missing, seq.refused], [[], []]);
    assert.equal(s.wallet.state.signed.length, 0, 'no sign-in: withdrawing needs only the connected wallet');
    assert.deepEqual(chain.publicAsked, [], 'no public RPC');
  } finally { await s.close(); }
});

test('a closed root (no liquidity) keeps its vault’s fees on its page: a refusal in the wallet sends nothing and says so, and the next press withdraws them once', async () => {
  const seq = fakeSequenceChain(OWNER, { roots: [BigInt(OWNED_OPEN)], settled: true, rootPermissionValid: false, reserves: { 0: [
    { tokenId: BigInt(OWNED_OPEN), source: 0, currency: 'base', original: 300_000_000_000_000_000n, charged: 25n },
  ] } });
  const { s } = await reservesScenario({ seq,
    positions: (q) => [closedOnChain(OWNED_OPEN, { subscriber: q.vaults[0] })],
    vaults: (q) => ({ [q.vaults[0]]: { root: OWNED_OPEN, feeBps: 200, paused: false, valid: false } }) });
  try {
    await goTo(s, `#/positions/${OWNED_OPEN}`);
    const detail = s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"]`);
    await detail.waitFor({ timeout: 30_000 });
    const card = detail.locator('section[data-fee-reserves="position"]');
    await card.waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
    assert.equal(await card.getByRole('heading').innerText(), 'Fees waiting in your automation');
    assert.equal(await card.locator('.dm-reserves-lede').innerText(), RESERVES_LEDE);
    // Its own fees and their already charged units together: 0.3 AAA and 25 of its smallest units.
    await card.locator(`[data-reserve-currency="${RESERVE_BASE}"]`).getByText('0.300000000000000025 AAA', { exact: true }).waitFor({ timeout: 30_000 });
    assert.equal(await card.locator('a').count(), 0, 'on its own page, no link to itself');
    await s.page.screenshot({ path: join(shots(), 'p2-fee-reserves-position.png'), fullPage: true });

    await card.getByRole('button', { name: 'Withdraw to wallet', exact: true }).click();
    await s.page.locator('[data-reserves-dialog="ready"]').waitFor({ timeout: 30_000 });
    const dialog = reservesDialog(s);
    assert.match(await dialog.locator('[data-reserves-network-fee]').innerText(), /^Network fee\s+Up to [0-9.]+ ETH$/);
    assert.equal(await dialog.locator('[data-reserves-steps], [data-reserves-batch]').count(), 0, 'one transaction');

    // Declined in the wallet: nothing sent, said so, and the review stays to press again.
    seq.refuseNextSend();
    await dialog.getByRole('button', { name: 'Withdraw in wallet', exact: true }).click();
    const notice = dialog.locator('[data-reserves-notice="declined"]');
    await notice.waitFor({ timeout: 30_000 });
    assert.equal(await notice.innerText(), 'You declined in your wallet. Nothing was sent.');
    assert.equal(seq.sends.length, 0);
    assert.equal(seq.log.filter((method) => method === 'eth_sendTransaction').length, 1, 'the wallet was asked once');
    await dialog.getByRole('button', { name: 'Withdraw in wallet', exact: true }).click();
    await s.page.locator('[data-reserves-dialog="done"]').waitFor({ timeout: 60_000 });
    assert.deepEqual(sentWithdrawals(seq), [{ to: seq.vaults[0], value: '0x0', functionName: 'withdrawFeeReserves', args: [seq.sourceOf(BigInt(OWNED_OPEN), 0), RESERVE_BASE, 300_000_000_000_000_000n, 25n] }]);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await detail.locator('[data-fee-reserves-read="position"][data-fee-reserves-state="ready"][hidden]').waitFor({ state: 'attached', timeout: 30_000 });
    assert.equal(await detail.locator('section[data-fee-reserves]').count(), 0, 'nothing is left to withdraw');
    assert.equal(seq.sends.length, 1, 'sent once');
  } finally { await s.close(); }
});

test('roots burned and moved to another wallet: Positions lists both vaults, the burned NFT’s page offers its vault’s fees, the moved one’s page none, and a batch wallet withdraws a vault in one signature', async () => {
  const seq = fakeSequenceChain(OWNER, { roots: [100n, 200n], settled: true, atomic: 'supported', rootPermissionValid: false, reserves: {
    0: [{ tokenId: 100n, source: 0, currency: 'base', original: 1_000_000_000_000_000_000n }, { tokenId: 100n, source: 1, currency: 'quote', original: 5_000_000n }],
    1: [{ tokenId: 200n, source: 0, currency: 'base', original: 2_000_000_000_000_000_000n }],
  } });
  const { s } = await reservesScenario({ seq, batch: true,
    positions: () => [onChain('100', { burned: true }), onChain('200', { holder: OTHER_HOLDER })] });
  try {
    await goTo(s, '#/positions');
    const card = s.page.locator('section[data-fee-reserves="positions"]');
    await card.waitFor({ timeout: 30_000 });
    const rows = card.locator('[data-reserve-vault]');
    await card.locator(`[data-reserve-vault="${seq.vaults[0]}"] [data-reserve-currency="${RESERVE_QUOTE}"]`).getByText('5 BBB', { exact: true }).waitFor({ timeout: 30_000 });
    assert.deepEqual(await rows.evaluateAll((all) => all.map((row) => row.getAttribute('data-reserve-root'))), ['200', '100'], 'every vault the wallet created, newest first');
    assert.deepEqual(await rows.locator('[data-reserve-status]').allInnerTexts(), ['Automation stopped', 'Automation stopped']);

    // The burned root's page: the NFT no longer exists, and its vault's fees are offered under it.
    await goTo(s, '#/positions/100');
    await s.page.locator('[data-empty="position-gone"]').waitFor({ timeout: 30_000 });
    const gone = s.page.locator('section[data-fee-reserves="position"]');
    await gone.waitFor({ timeout: 30_000 });
    assert.deepEqual(await gone.locator('[data-reserve-vault]').evaluateAll((all) => all.map((row) => row.getAttribute('data-reserve-vault'))), [seq.vaults[0]], 'only the vault whose root it was');
    // The moved root's page: another wallet's position, and nothing of this wallet's vault on it.
    await goTo(s, '#/positions/200');
    await s.page.locator('[data-position-detail][data-position-id="200"]').waitFor({ timeout: 30_000 });
    assert.equal(await s.page.locator('section[data-fee-reserves]').count(), 0);

    await goTo(s, '#/positions');
    await card.waitFor({ timeout: 30_000 });
    await card.locator(`[data-reserve-vault="${seq.vaults[0]}"]`).getByRole('button', { name: 'Withdraw to wallet', exact: true }).click();
    await s.page.locator('[data-reserves-dialog="ready"]').waitFor({ timeout: 30_000 });
    const dialog = reservesDialog(s);
    assert.equal(await dialog.locator('[data-reserves-batch]').innerText(), 'One signature in your wallet: everything comes back together, or nothing does.');
    await dialog.getByRole('button', { name: 'Withdraw in wallet', exact: true }).click();
    await s.page.locator('[data-reserves-dialog="done"]').waitFor({ timeout: 60_000 });
    assert.deepEqual(await dialog.locator('[data-reserves-receipt] [data-reserve-currency]').allInnerTexts(), ['1 AAA', '5 BBB']);
    // 2026-10-02 (review finding 4): the receipt names the one transaction that carried the batch, as the wallet's receipt does.
    assert.deepEqual(await dialog.locator('[data-reserves-transaction]').evaluateAll((all) => all.map((row) => row.getAttribute('data-reserves-transaction'))), [seq.batches[0].transactionHash]);
    assert.equal(seq.sends.length, 0, 'no transaction of its own');
    assert.equal(seq.batches.length, 1, 'one batch, offered once');
    const [offered] = seq.batches;
    assert.deepEqual([offered.version, offered.chainId, offered.from, offered.atomicRequired], ['2.0.0', '0x1237', OWNER, true]);
    assert.deepEqual(offered.calls.map((call) => [String(call.to).toLowerCase(), call.value, decodeFunctionData({ abi: chainAbi, data: call.data }).args]), [
      [seq.vaults[0], '0x0', [seq.sourceOf(100n, 0), RESERVE_BASE, 1_000_000_000_000_000_000n, 0n]],
      [seq.vaults[0], '0x0', [seq.sourceOf(100n, 1), RESERVE_QUOTE, 5_000_000n, 0n]],
    ]);
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    // The other vault still holds its fees, and is still offered.
    await s.page.waitForFunction((vault) => !document.querySelector(`[data-reserve-vault="${vault}"]`), seq.vaults[0], { timeout: 30_000 });
    assert.deepEqual(await card.locator('[data-reserve-vault]').evaluateAll((all) => all.map((row) => row.getAttribute('data-reserve-root'))), ['200']);
    assert.deepEqual([seq.missing, seq.refused], [[], []]);
  } finally { await s.close(); }
});

test('with every reserve at zero nothing is shown, on Positions or on the root’s page, after the vault was read', async () => {
  const seq = fakeSequenceChain(OWNER, { roots: [BigInt(OWNED_OPEN)], settled: true });
  const { s } = await reservesScenario({ seq,
    positions: (q) => [onChain(OWNED_OPEN, { subscriber: q.vaults[0] })],
    vaults: (q) => ({ [q.vaults[0]]: { root: OWNED_OPEN, feeBps: 400, paused: true, valid: true } }) });
  try {
    await goTo(s, '#/positions');
    await s.page.locator('[data-fee-reserves-read="positions"][data-fee-reserves-state="ready"][hidden]').waitFor({ state: 'attached', timeout: 30_000 });
    assert.equal(await s.page.locator('section[data-fee-reserves]').count(), 0);
    await goTo(s, `#/positions/${OWNED_OPEN}`);
    const detail = s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"]`);
    await detail.locator('[data-fee-reserves-read="position"][data-fee-reserves-state="ready"][hidden]').waitFor({ state: 'attached', timeout: 30_000 });
    assert.equal(await s.page.locator('section[data-fee-reserves]').count(), 0);
    assert.ok(seq.log.includes('eth_call'), 'the vault was read');
    assert.equal(seq.sends.length, 0);
  } finally { await s.close(); }
});

test('a withdrawal whose wallet answer was lost is never offered again: the next press stops before the wallet, and nothing is sent twice', async () => {
  const seq = fakeSequenceChain(OWNER, { roots: [BigInt(OWNED_OPEN)], settled: true, reserves: { 0: [
    { tokenId: BigInt(OWNED_OPEN), source: 1, currency: 'quote', original: 7_000_000n },
  ] } });
  const { s } = await reservesScenario({ seq,
    positions: (q) => [onChain(OWNED_OPEN, { subscriber: q.vaults[0] })],
    vaults: (q) => ({ [q.vaults[0]]: { root: OWNED_OPEN, feeBps: 400, paused: false, valid: true } }) });
  try {
    await goTo(s, '#/positions');
    const card = s.page.locator('section[data-fee-reserves="positions"]');
    await card.waitFor({ timeout: 30_000 });
    await card.getByRole('button', { name: 'Withdraw to wallet', exact: true }).click();
    await s.page.locator('[data-reserves-dialog="ready"]').waitFor({ timeout: 30_000 });
    const dialog = reservesDialog(s);
    seq.dropNextSend();
    await dialog.getByRole('button', { name: 'Withdraw in wallet', exact: true }).click();
    const notice = dialog.locator('[data-reserves-notice]');
    await notice.waitFor({ timeout: 30_000 });
    assert.equal(await notice.innerText(), 'Your wallet may or may not have sent it. Check your wallet activity before trying again. This step won’t be offered twice, even after a reload.');
    const asked = () => seq.log.filter((method) => method === 'eth_sendTransaction').length;
    assert.equal(asked(), 1);
    // Pressed again: the same step is held by the page's latch on its nonce, before the wallet is asked.
    await dialog.getByRole('button', { name: 'Withdraw in wallet', exact: true }).click();
    await dialog.locator('[data-reserves-notice="wallet_request_open"]').waitFor({ timeout: 30_000 });
    assert.equal(await dialog.locator('[data-reserves-notice]').innerText(), 'Your wallet may still be showing an earlier request from this site. Approve or reject it there. If you already rejected or closed it, reload this page.');
    assert.equal(asked(), 1, 'the wallet was not asked again');
    // Closed and opened again: the review stops at the same place, and still nothing is sent.
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await card.getByRole('button', { name: 'Withdraw to wallet', exact: true }).click();
    await reservesDialog(s).locator('[data-reserves-notice="wallet_request_open"]').waitFor({ timeout: 30_000 });
    assert.equal(asked(), 1);
    assert.equal(seq.sends.length, 0, 'nothing was sent');
    assert.deepEqual(seq.balanceOf(0, OWNED_OPEN, 1, 'quote'), { original: 7_000_000n, charged: 0n }, 'the fees are still in the vault');
  } finally { await s.close(); }
});

// ---- The review of the fee withdrawal (2026-10-02): its eight findings, in the page ----------------------------------
// A withdrawal is proved by the vault's own record of it (finding 1), and the receipt names the transaction that paid
// (finding 4); every vault the wallet created is looked in (findings 2 and 6), with a quiet line while some are still to
// be, a vault whose read fails keeps its row and is asked again on its own (finding 8); a chain of members longer than one
// read is walked in pages (finding 3); the fees are found and withdrawn with no release and nothing saved in the browser
// (finding 5); and an amount is never a skeleton for good, nor sent while unnamed (finding 7).

const transactionsOf = (dialog) => dialog.locator('[data-reserves-transaction]').evaluateAll((all) => all.map((row) => row.getAttribute('data-reserves-transaction')));
const ARMED = (q) => ({ [q.vaults[0]]: { root: OWNED_OPEN, feeBps: 400, paused: false, valid: true } });

test('review findings 1 and 4: a withdrawal the wallet sped up counts by the vault’s own record, though new fees were credited meanwhile, and the receipt names the transaction that paid', async () => {
  const seq = fakeSequenceChain(OWNER, { roots: [BigInt(OWNED_OPEN)], settled: true, reserves: { 0: [
    { tokenId: BigInt(OWNED_OPEN), source: 0, currency: 'base', original: 1_250_000_000_000_000_000n },
  ] } });
  const { s } = await reservesScenario({ seq, positions: (q) => [onChain(OWNED_OPEN, { subscriber: q.vaults[0] })], vaults: ARMED });
  try {
    await goTo(s, '#/positions');
    const card = s.page.locator('section[data-fee-reserves="positions"]');
    await card.waitFor({ timeout: 30_000 });
    await card.getByRole('button', { name: 'Withdraw to wallet', exact: true }).click();
    await s.page.locator('[data-reserves-dialog="ready"]').waitFor({ timeout: 30_000 });
    const dialog = reservesDialog(s);
    // "Speed up": mined under another hash than the one the page was given.
    seq.speedUpNext('withdrawFeeReserves');
    await dialog.getByRole('button', { name: 'Withdraw in wallet', exact: true }).click();
    await until(() => seq.sends.length === 1, 'the withdrawal sent', 30_000);
    // The automation's next run credits new fees to the same balance before the page reads the vault again: the balance
    // is above zero, which the old rule took for a withdrawal that did not happen.
    seq.automationRun(0, [{ tokenId: OWNED_OPEN, source: 0, currency: 'base', original: 4_000_000_000_000_000n }]);
    await s.page.locator('[data-reserves-dialog="done"]').waitFor({ timeout: 60_000 });
    assert.equal(await dialog.getByRole('heading').innerText(), 'Returned to your wallet');
    assert.deepEqual(await dialog.locator('[data-reserves-receipt] [data-reserve-currency]').allInnerTexts(), ['1.25 AAA']);
    assert.deepEqual(await transactionsOf(dialog), [seq.vaultLogs[0].transactionHash], 'the transaction that took its place, never the replaced one');
    assert.equal(seq.log.filter((method) => method === 'eth_sendTransaction').length, 1, 'sent once');
    assert.ok(seq.log.includes('eth_getLogs'), 'found by the vault’s own record');
    // The fees credited since are offered next.
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await card.locator(`[data-reserve-currency="${RESERVE_BASE}"]`).getByText('0.004 AAA', { exact: true }).waitFor({ timeout: 30_000 });
    assert.deepEqual([seq.missing, seq.refused], [[], []]);
  } finally { await s.close(); }
});

test('review finding 1: a withdrawal the wallet cancelled while the automation reinvested those fees is never said to have reached the wallet', async () => {
  const seq = fakeSequenceChain(OWNER, { roots: [BigInt(OWNED_OPEN)], settled: true, reserves: { 0: [
    { tokenId: BigInt(OWNED_OPEN), source: 0, currency: 'base', original: 1_250_000_000_000_000_000n },
  ] } });
  const { s } = await reservesScenario({ seq, positions: (q) => [onChain(OWNED_OPEN, { subscriber: q.vaults[0] })], vaults: ARMED });
  try {
    await goTo(s, '#/positions');
    const card = s.page.locator('section[data-fee-reserves="positions"]');
    await card.waitFor({ timeout: 30_000 });
    await card.getByRole('button', { name: 'Withdraw to wallet', exact: true }).click();
    await s.page.locator('[data-reserves-dialog="ready"]').waitFor({ timeout: 30_000 });
    const dialog = reservesDialog(s);
    // "Cancel" takes the nonce, and in that window an operator execution spends the whole reserve on liquidity: the balance
    // is zero and the state nonce moved, as a withdrawal would leave them, but nothing reached the wallet.
    seq.cancelNextInWallet('withdrawFeeReserves', () => seq.automationRun(0, [{ tokenId: OWNED_OPEN, source: 0, currency: 'base', original: 0n }]));
    await dialog.getByRole('button', { name: 'Withdraw in wallet', exact: true }).click();
    const notice = dialog.locator('[data-reserves-notice="reserve_withdrawal_replaced"]');
    await notice.waitFor({ timeout: 60_000 });
    // Changed on purpose 2026-10-04 (the owner: no "vault" in the UI; "your automation").
    assert.equal(await notice.innerText(), 'Your wallet replaced the withdrawal with another transaction. Your automation shows no record of paying these fees, so the outcome is unknown. Check your wallet activity before trying again: your automation is read first, and nothing is sent twice.');
    assert.equal(await dialog.getByRole('heading').innerText(), 'Withdraw to wallet', 'never “Returned to your wallet”');
    assert.equal(await dialog.locator('[data-reserves-receipt], [data-reserves-transaction]').count(), 0, 'no receipt, no transaction named');
    assert.deepEqual([seq.sends.length, seq.burned(), seq.withdrawals.length], [0, 1, 0]);
    // The card reads the vault again: nothing waits there now, and it goes.
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await s.page.locator('[data-fee-reserves-read="positions"][data-fee-reserves-state="ready"][hidden]').waitFor({ state: 'attached', timeout: 30_000 });
    assert.equal(seq.log.filter((method) => method === 'eth_sendTransaction').length, 1, 'nothing offered again');
  } finally { await s.close(); }
});

// Retitled on purpose 2026-10-15 (pack 7, owner: no status notices): it said “a quiet line says while it cannot be read”.
test('review findings 2, 6 and 8: the fees in a vault older than the sixteen newest are found and offered, asked again quietly while it cannot be read, and its burned root’s page offers them too', async () => {
  const roots = Array.from({ length: 17 }, (_, i) => BigInt(300 + i));
  const seq = fakeSequenceChain(OWNER, { roots, settled: true, rootPermissionValid: false, reserves: {
    0: [{ tokenId: 300n, source: 1, currency: 'quote', original: 3_000_000n }],
    16: [{ tokenId: 316n, source: 0, currency: 'base', original: 1_000_000_000_000_000_000n }],
  } });
  // The oldest vault cannot be read at first.
  seq.failVaultReads(0, true);
  const { s } = await reservesScenario({ seq, positions: () => [onChain('300', { burned: true })] });
  try {
    await goTo(s, '#/positions');
    const card = s.page.locator('section[data-fee-reserves="positions"]');
    await card.locator(`[data-reserve-vault="${seq.vaults[16]}"]`).waitFor({ timeout: 60_000 });
    const line = card.locator('[data-reserves-checking]');
    // While the oldest vault is still to be read, and once its read failed, it is asked again on its own.
    // Changed on purpose 2026-10-15 (pack 7), changed on purpose (owner: no status notices): no line says so any more
    // ("Your older automations are still being checked…", then "Some of your automations couldn’t be checked just now.
    // This page asks again on its own."); the section's state says "checking", and the card shows only its rows.
    await s.page.locator('section[data-fee-reserves="positions"][data-fee-reserves-state="checking"]').waitFor({ timeout: 30_000 });
    assert.equal(await line.count(), 0, 'no status line');
    await card.screenshot({ path: join(shots(), 'p2-fee-reserves-checking.png') });
    assert.doesNotMatch(await card.innerText(), /Retry|Try again|still being checked|couldn’t be checked|asks again/);
    // Readable again: asked again on its own, and its row joins the newest one's.
    seq.failVaultReads(0, false);
    const oldest = card.locator(`[data-reserve-vault="${seq.vaults[0]}"]`);
    await oldest.locator(`[data-reserve-currency="${RESERVE_QUOTE}"]`).getByText('3 BBB', { exact: true }).waitFor({ timeout: 60_000 });
    assert.deepEqual(await card.locator('[data-reserve-vault]').evaluateAll((all) => all.map((row) => row.getAttribute('data-reserve-root'))), ['316', '300'], 'newest first');
    await s.page.locator('section[data-fee-reserves="positions"][data-fee-reserves-state="ready"]').waitFor({ timeout: 30_000 });
    assert.equal(await line.count(), 0, 'every vault looked in');

    // The burned root's page: the vault whose root it was, seventeenth from the newest.
    await goTo(s, '#/positions/300');
    await s.page.locator('[data-empty="position-gone"]').waitFor({ timeout: 30_000 });
    const gone = s.page.locator('section[data-fee-reserves="position"]');
    await gone.locator(`[data-reserve-vault="${seq.vaults[0]}"]`).waitFor({ timeout: 60_000 });
    await gone.getByRole('button', { name: 'Withdraw to wallet', exact: true }).click();
    await s.page.locator('[data-reserves-dialog="ready"]').waitFor({ timeout: 30_000 });
    const dialog = reservesDialog(s);
    await dialog.getByRole('button', { name: 'Withdraw in wallet', exact: true }).click();
    await s.page.locator('[data-reserves-dialog="done"]').waitFor({ timeout: 60_000 });
    assert.deepEqual(sentWithdrawals(seq), [{ to: seq.vaults[0], value: '0x0', functionName: 'withdrawFeeReserves', args: [seq.sourceOf(300n, 1), RESERVE_QUOTE, 3_000_000n, 0n] }]);
    assert.deepEqual(await transactionsOf(dialog), [seq.vaultLogs[0].transactionHash]);
    assert.deepEqual([seq.missing, seq.refused], [[], []]);
  } finally { await s.close(); }
});

// Retitled on purpose 2026-10-15 (pack 7, owner: no status notices): it said “one never read says so quietly until it can be”.
test('review finding 8: a vault already on screen keeps its row when a later read of it fails, and one never read is asked again, with nothing on screen, until it can be', async () => {
  const seq = fakeSequenceChain(OWNER, { roots: [100n, 200n], settled: true, rootPermissionValid: false, reserves: {
    0: [{ tokenId: 100n, source: 0, currency: 'base', original: 1_000_000_000_000_000_000n }],
    1: [{ tokenId: 200n, source: 0, currency: 'base', original: 2_000_000_000_000_000_000n }],
  } });
  const { s } = await reservesScenario({ seq, positions: () => [onChain('100', { burned: true }), onChain('200', { burned: true })] });
  try {
    await goTo(s, '#/positions');
    const card = s.page.locator('section[data-fee-reserves="positions"]');
    const first = card.locator(`[data-reserve-vault="${seq.vaults[0]}"]`), second = card.locator(`[data-reserve-vault="${seq.vaults[1]}"]`);
    await first.waitFor({ timeout: 30_000 });
    await second.waitFor({ timeout: 30_000 });
    // The first vault's reads fail from now on; the second's fees are withdrawn, and the card reads both again.
    seq.failVaultReads(0, true);
    await second.getByRole('button', { name: 'Withdraw to wallet', exact: true }).click();
    await s.page.locator('[data-reserves-dialog="ready"]').waitFor({ timeout: 30_000 });
    const dialog = reservesDialog(s);
    await dialog.getByRole('button', { name: 'Withdraw in wallet', exact: true }).click();
    await s.page.locator('[data-reserves-dialog="done"]').waitFor({ timeout: 60_000 });
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await second.waitFor({ state: 'detached', timeout: 30_000 });
    assert.equal(await first.count(), 1, 'the vault whose read failed keeps its row');
    assert.equal(await first.locator(`[data-reserve-currency="${RESERVE_BASE}"]`).innerText(), '1 AAA');
    assert.equal(await card.locator('[data-reserves-checking]').count(), 0, 'nothing unseen: no line');
  } finally { await s.close(); }

  // A vault never read whose reads keep failing: it is asked again on its own until it can be, and its fees are shown then.
  // Changed on purpose 2026-10-15 (pack 7), changed on purpose (owner: no status notices): a card with "Your automation
  // couldn’t be checked for fees just now. This page asks again on its own." stood there meanwhile; nothing does now (the
  // hidden marker counts the failed reads).
  const lone = fakeSequenceChain(OWNER, { roots: [100n], settled: true, rootPermissionValid: false, reserves: {
    0: [{ tokenId: 100n, source: 0, currency: 'base', original: 1_000_000_000_000_000_000n }],
  } });
  lone.failVaultReads(0, true);
  const { s: t } = await reservesScenario({ seq: lone, positions: () => [onChain('100', { burned: true })] });
  try {
    await goTo(t, '#/positions');
    await t.page.locator('[data-fee-reserves-read="positions"][data-fee-reserves-state="checking"][data-fee-reserves-misses="2"][hidden]').waitFor({ state: 'attached', timeout: 60_000 });
    assert.equal(await t.page.locator('section.dm-reserves').count(), 0, 'nothing on screen while it cannot be read');
    assert.doesNotMatch(await t.page.locator('body').innerText(), /couldn’t be checked|asks again/);
    lone.failVaultReads(0, false);
    const card = t.page.locator('section[data-fee-reserves="positions"]');
    await card.locator(`[data-reserve-vault="${lone.vaults[0]}"]`).waitFor({ timeout: 60_000 });
  } finally { await t.close(); }
});

/**
 * (2026-10-15, pack 7): every time the card is on screen or off it, and the words it had, recorded in the page from now
 * on (a MutationObserver), so a test sees a flash no screenshot would catch.
 */
const watchReservesCard = (page) => page.evaluate(() => {
  const seen = (window.__reservesCardSeen = []);
  const look = () => {
    const card = document.querySelector('section.dm-reserves');
    const on = card !== null;
    if (seen.at(-1)?.on !== on) seen.push({ on, text: card?.textContent ?? '' });
    else if (on && seen.at(-1).text !== card.textContent) seen.push({ on, text: card.textContent });
  };
  look();
  new MutationObserver(look).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
});
const reservesCardSeen = (page) => page.evaluate(() => window.__reservesCardSeen);
/**
 * Steps the page's clock past the card's waits (lib/automate/reserves.ts RESERVE_REASK_MS) `times` times, letting each read
 * it starts answer in real time.
 */
async function stepReserveReads(page, times = 5) {
  for (let i = 0; i < times; i++) {
    await page.clock.fastForward(121_000);
    await page.waitForTimeout(1_500);
  }
}

test('pack 7 (2026-10-15, the owner: “Fees waiting in your automation” kept appearing and disappearing, saying it couldn’t be checked): with nothing waiting and every read failing nothing is ever shown; fees waiting stay on screen, unchanged, through a later visit whose reads fail', async () => {
  // The owner's Positions: his automation holds no fees, and the wallet's reads of it fail (a node that has not seen the
  // read's block yet answers "header not found"). The card used to come up after two failed reads with "Your automation
  // couldn’t be checked for fees just now. This page asks again on its own." and go again once a read went through.
  const empty = fakeSequenceChain(OWNER, { roots: [100n], settled: true, rootPermissionValid: false, reserves: {} });
  empty.failVaultReads(0, true);
  const { s } = await reservesScenario({ seq: empty, positions: () => [onChain('100', { burned: true })], clock: true });
  try {
    await watchReservesCard(s.page);
    await goTo(s, '#/positions');
    const marker = s.page.locator('[data-fee-reserves-read="positions"]');
    await marker.waitFor({ state: 'attached', timeout: 30_000 });
    await stepReserveReads(s.page);
    assert.ok(empty.log.filter((method) => method === 'eth_call').length > 0, 'the automation was read');
    assert.deepEqual(await reservesCardSeen(s.page), [{ on: false, text: '' }], 'never on screen while nothing waits, failing or not');
    assert.doesNotMatch(await s.page.locator('body').innerText(), /couldn’t be checked|asks again|still being checked/);
    // Readable again: still nothing to show, and nothing shown.
    empty.failVaultReads(0, false);
    for (let i = 0; i < 6 && (await s.page.locator('[data-fee-reserves-read="positions"][data-fee-reserves-state="ready"]').count()) === 0; i++) await stepReserveReads(s.page, 1);
    await s.page.locator('[data-fee-reserves-read="positions"][data-fee-reserves-state="ready"][hidden]').waitFor({ state: 'attached', timeout: 30_000 });
    assert.deepEqual(await reservesCardSeen(s.page), [{ on: false, text: '' }]);
  } finally { await s.close(); }

  // Fees waiting: the card shows them; the owner opens another page and comes back after the minute a read is kept, and
  // every read fails meanwhile. The card used to go, then come back with the failure line; it stays as it was now.
  const seq = fakeSequenceChain(OWNER, { roots: [100n], settled: true, rootPermissionValid: false, reserves: {
    0: [{ tokenId: 100n, source: 0, currency: 'base', original: 1_000_000_000_000_000_000n }],
  } });
  const { s: t } = await reservesScenario({ seq, positions: () => [onChain('100', { burned: true })], clock: true });
  try {
    await goTo(t, '#/positions');
    const card = t.page.locator('section[data-fee-reserves="positions"]');
    const row = card.locator(`[data-reserve-vault="${seq.vaults[0]}"]`);
    await row.locator(`[data-reserve-currency="${RESERVE_BASE}"]`).getByText('1 AAA', { exact: true }).waitFor({ timeout: 30_000 });
    const before = await card.innerText();
    seq.failVaultReads(0, true);
    await goTo(t, '#/positions/receipts');
    await card.waitFor({ state: 'detached', timeout: 30_000 });
    await t.page.clock.fastForward(65_000);
    await watchReservesCard(t.page);
    await goTo(t, '#/positions');
    // Back at once with the last figures, before any read answers.
    await row.locator(`[data-reserve-currency="${RESERVE_BASE}"]`).getByText('1 AAA', { exact: true }).waitFor({ timeout: 5_000 });
    await stepReserveReads(t.page);
    assert.equal(await card.innerText(), before, 'the same card, word for word');
    const seen = await reservesCardSeen(t.page);
    assert.deepEqual(seen.slice(1).map((entry) => entry.on), seen.slice(1).map(() => true), 'never off screen once back');
    assert.ok(seen.every((entry) => !/couldn’t be checked|asks again|still being checked/.test(entry.text)), 'never a failure line');
  } finally { await t.close(); }
});

test('pack 7 review (2026-10-15): after a withdrawal, a re-read that fails never keeps the fees from before it for a later visit', async () => {
  const seq = fakeSequenceChain(OWNER, { roots: [BigInt(OWNED_OPEN)], settled: true, reserves: { 0: [
    { tokenId: BigInt(OWNED_OPEN), source: 0, currency: 'base', original: 1_250_000_000_000_000_000n },
  ] } });
  const { s } = await reservesScenario({ seq, positions: (q) => [onChain(OWNED_OPEN, { subscriber: q.vaults[0] })], vaults: ARMED, clock: true });
  try {
    await goTo(s, '#/positions');
    const card = s.page.locator('section[data-fee-reserves="positions"]');
    await card.locator(`[data-reserve-currency="${RESERVE_BASE}"]`).getByText('1.25 AAA', { exact: true }).waitFor({ timeout: 30_000 });
    await card.getByRole('button', { name: 'Withdraw to wallet', exact: true }).click();
    await s.page.locator('[data-reserves-dialog="ready"]').waitFor({ timeout: 30_000 });
    const dialog = reservesDialog(s);
    // The wallet replaces the withdrawal, the automation spends the reserve meanwhile, and from then on every read of the
    // vault fails: the card's read after the withdrawal (reservesChanged) cannot see that nothing waits now.
    seq.cancelNextInWallet('withdrawFeeReserves', () => {
      seq.automationRun(0, [{ tokenId: OWNED_OPEN, source: 0, currency: 'base', original: 0n }]);
      seq.failVaultReads(0, true);
    });
    const calls = () => seq.log.filter((method) => method === 'eth_call').length;
    await dialog.getByRole('button', { name: 'Withdraw in wallet', exact: true }).click();
    await dialog.locator('[data-reserves-notice="reserve_withdrawal_replaced"]').waitFor({ timeout: 60_000 });
    // The card's re-read, and its first ask again (3 s later), each fail.
    const since = calls();
    await s.page.clock.fastForward(4_000);
    await until(() => calls() >= since + 2, 'the card to read the vault again', 30_000);
    await s.page.waitForTimeout(1_000);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    // Another page, back after the minute a read is kept: the fees from before the withdrawal are never painted from this
    // visit's copy (before the fix, the failed re-read wrote them back into it).
    await goTo(s, '#/positions/receipts');
    await card.waitFor({ state: 'detached', timeout: 30_000 });
    await s.page.clock.fastForward(65_000);
    await watchReservesCard(s.page);
    await goTo(s, '#/positions');
    // The card's place (its hidden marker, or the card itself before the fix), then its reads, which still fail.
    await s.page.locator('[data-fee-reserves-read="positions"], section[data-fee-reserves="positions"]').first().waitFor({ state: 'attached', timeout: 30_000 });
    await stepReserveReads(s.page, 2);
    assert.deepEqual(await reservesCardSeen(s.page), [{ on: false, text: '' }], 'never on screen with the fees already gone');
    // Readable again: nothing waits, and nothing is shown.
    seq.failVaultReads(0, false);
    for (let i = 0; i < 6 && (await s.page.locator('[data-fee-reserves-read="positions"][data-fee-reserves-state="ready"]').count()) === 0; i++) await stepReserveReads(s.page, 1);
    await s.page.locator('[data-fee-reserves-read="positions"][data-fee-reserves-state="ready"][hidden]').waitFor({ state: 'attached', timeout: 30_000 });
    assert.deepEqual(await reservesCardSeen(s.page), [{ on: false, text: '' }]);
  } finally { await s.close(); }
});

test('review finding 3: a vault whose chain of positions is longer than one read is read in pages, and the fees of a position far down it are withdrawn', async () => {
  const members = Array.from({ length: 40 }, (_, i) => ({ id: BigInt(1000 + i), active: i % 4 === 0 }));
  const seq = fakeSequenceChain(OWNER, { roots: [100n], chains: { 0: members }, settled: true, rootPermissionValid: false, reserves: {
    0: [{ tokenId: 1035n, source: 1, currency: 'quote', original: 77n, charged: 3n }],
  } });
  const { s } = await reservesScenario({ seq, positions: () => [onChain('100', { burned: true })] });
  try {
    await goTo(s, '#/positions');
    const card = s.page.locator('section[data-fee-reserves="positions"]');
    const row = card.locator(`[data-reserve-vault="${seq.vaults[0]}"]`);
    await row.locator(`[data-reserve-currency="${RESERVE_QUOTE}"]`).getByText('0.00008 BBB', { exact: true }).waitFor({ timeout: 60_000 });
    await row.getByRole('button', { name: 'Withdraw to wallet', exact: true }).click();
    await s.page.locator('[data-reserves-dialog="ready"]').waitFor({ timeout: 60_000 });
    const dialog = reservesDialog(s);
    await dialog.getByRole('button', { name: 'Withdraw in wallet', exact: true }).click();
    await s.page.locator('[data-reserves-dialog="done"]').waitFor({ timeout: 60_000 });
    assert.deepEqual(sentWithdrawals(seq), [{ to: seq.vaults[0], value: '0x0', functionName: 'withdrawFeeReserves', args: [seq.sourceOf(1035n, 1), RESERVE_QUOTE, 77n, 3n] }]);
    assert.deepEqual([seq.missing, seq.refused], [[], []]);
  } finally { await s.close(); }
});

test('review finding 5: with the release refused or switched off and nothing saved in this browser, the fees are still found and withdrawn with the V1 release the build ships, and the release is never asked', async () => {
  const seq = fakeSequenceChain(OWNER, { roots: [100n], settled: true, rootPermissionValid: false, reserves: {
    0: [{ tokenId: 100n, source: 0, currency: 'base', original: 2_000_000_000_000_000_000n }],
  } });
  // The release Worker refuses the expired profile (bridge/src/sequence-release.mjs: 503 setup_configuration_unavailable).
  const { s } = await reservesScenario({ seq, positions: () => [onChain('100', { burned: true })], release: { status: 503, body: { error: 'setup_configuration_unavailable' } }, shipped: seq.release });
  try {
    const saved = () => s.page.evaluate(() => localStorage.getItem('domino.sequence.public-recovery.v1'));
    assert.equal(await saved(), null, 'nothing saved in this browser: it never set up automation');
    await goTo(s, '#/positions');
    const card = s.page.locator('section[data-fee-reserves="positions"]');
    await card.locator(`[data-reserve-currency="${RESERVE_BASE}"]`).getByText('2 AAA', { exact: true }).waitFor({ timeout: 30_000 });
    // Switched off (available: false): the page opened again still finds them, and withdraws them.
    s.set({ sequenceRelease: RELEASE_OFF });
    await s.page.reload();
    // The wallet connects again by itself (connected, not signed in).
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out', null, { timeout: 30_000 });
    await goTo(s, '#/positions');
    await card.locator(`[data-reserve-currency="${RESERVE_BASE}"]`).getByText('2 AAA', { exact: true }).waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-11-09 (core flows, V1 leftovers): the card never asks the release (it only met a 503).
    assert.equal(s.releases.filter((asked) => asked.path === '/api/setup/v1/sequence-release').length, 0, 'the release is never asked by the card');
    await card.getByRole('button', { name: 'Withdraw to wallet', exact: true }).click();
    await s.page.locator('[data-reserves-dialog="ready"]').waitFor({ timeout: 30_000 });
    const dialog = reservesDialog(s);
    await dialog.getByRole('button', { name: 'Withdraw in wallet', exact: true }).click();
    await s.page.locator('[data-reserves-dialog="done"]').waitFor({ timeout: 60_000 });
    assert.deepEqual(sentWithdrawals(seq), [{ to: seq.vaults[0], value: '0x0', functionName: 'withdrawFeeReserves', args: [seq.sourceOf(100n, 0), RESERVE_BASE, 2_000_000_000_000_000_000n, 0n] }]);
    assert.equal(await saved(), null, 'nothing is kept: no release is published');
    assert.deepEqual([seq.missing, seq.refused], [[], []]);
  } finally { await s.close(); }
});

test('review finding 7: a token the read path cannot name yet shows every digit in its smallest units, never a skeleton for good, and the review cannot be sent while an amount is unnamed', async () => {
  const seq = fakeSequenceChain(OWNER, { roots: [100n], settled: true, rootPermissionValid: false, reserves: {
    0: [{ tokenId: 100n, source: 1, currency: 'quote', original: 2_500_000n }],
  } });
  const { s } = await reservesScenario({ seq, positions: () => [onChain('100', { burned: true })] });
  try {
    // The read path cannot name BBB for now (503, upstream unavailable): a failure that may pass, asked again.
    const headers = { 'X-Domino-Read-Contract': readGateway('capabilities.live_read_only').contractVersion };
    let refusals = 0;
    await s.context.route(/\/api\/read\/v1\/token$/, async (route) => {
      if (route.request().postDataJSON().token.toLowerCase() !== RESERVE_QUOTE) return route.fallback();
      refusals += 1;
      return route.fulfill({ status: 503, contentType: 'application/json', headers, body: JSON.stringify({ error: 'upstream_unavailable' }) });
    });
    await goTo(s, '#/positions');
    const card = s.page.locator('section[data-fee-reserves="positions"]');
    await card.waitFor({ timeout: 30_000 });
    await card.getByRole('button', { name: 'Withdraw to wallet', exact: true }).click();
    await s.page.locator('[data-reserves-dialog="ready"]').waitFor({ timeout: 30_000 });
    const dialog = reservesDialog(s);
    const send = dialog.getByRole('button', { name: 'Withdraw in wallet', exact: true });
    assert.equal(await dialog.locator('[data-reserves-review] .dm-reserves-skel').count(), 1, 'the amount, not named yet');
    assert.equal(await send.isEnabled(), false, 'not while the amount is unnamed');
    // After the third try: every digit, in its smallest units, and the review can be sent.
    const raw = dialog.locator(`[data-reserves-review] [data-reserve-currency="${RESERVE_QUOTE}"][data-amount="raw"]`);
    await raw.waitFor({ timeout: 40_000 });
    assert.equal(await raw.innerText(), '2,500,000 units of 0x6262…6262');
    assert.ok(refusals >= 3, `asked ${refusals} times`);
    assert.equal(await send.isEnabled(), true);
    assert.equal(await card.locator(`[data-reserve-currency="${RESERVE_QUOTE}"]`).innerText(), '2,500,000 units of 0x6262…6262', 'the card’s row too');
    await send.click();
    await s.page.locator('[data-reserves-dialog="done"]').waitFor({ timeout: 60_000 });
    assert.deepEqual(sentWithdrawals(seq).map((sent) => sent.args), [[seq.sourceOf(100n, 1), RESERVE_QUOTE, 2_500_000n, 0n]]);
  } finally { await s.close(); }
});
