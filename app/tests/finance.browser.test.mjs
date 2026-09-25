import { jump } from './support/clock.mjs';
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { closeBrowser } from './support/close-browser.mjs';
import { concatHex, encodeAbiParameters, keccak256, toFunctionSelector } from 'viem';
import { createFakeOnboarding } from './support/fake-onboarding.mjs';
import { createFakeSession } from './support/fake-session.mjs';
import { createWalletServer } from './support/wallet-server.mjs';
import { ACCOUNTS, installWallets } from './support/mock-wallet.mjs';
import { ARTWORK, footerButton, walkToReview } from './support/new-position.mjs';
import { FIXTURE_TOKEN, createReadStub } from './support/read-stub.mjs';
// The mint's own sizing, from the unit build (npm test compiles it first, as check:app runs it first).
import { bandFor, bandLiquidity, mintPlanFor } from '../.test-build/app/src/lib/create/mintPlan.js';
// 2026-09-25: the public RPC as the page reads it, answered by a fake chain (the page reads the chain itself since the RPC
// rate-limits Cloudflare's edge), and a recorded fees case as the chain it was read from.
import { SETUP_MINTED_TOPIC, browserChain, busyHistory, routeChain as routeRpc } from './support/browser-chain.mjs';
import { caseChain } from './support/fees/case-chain.mjs';
// 2026-09-25: the fees worker's lane to the RPC, whose pace the busy-history test holds it to.
import { LANE_PACE } from '../.test-build/app/src/lib/chain/browser.js';
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
/** What the product rules keep off these screens. "Not connected" pills driven by ROADMAP are allowed; "not connected yet" is not. */
const FORBIDDEN = /not connected yet|not enabled|isn’t enabled|isn't enabled|aren't enabled|not available on this deployment|coming soon|in this release|\bbeta\b|\balpha\b|\bv4\b|read-only|temporarily unavailable|retry after|Last read/i;
const RELEASE_OFF = { status: 200, body: { contractVersion: '1.0.0-rc.1', chainId: 4663, available: false, deployment: null } };

/**
 * `chain`: what the public RPC answers the page (tests/support/browser-chain.mjs), an empty chain unless one is given
 * (no position, no deposit, every NFT unknown), as the site's routes answered before 2026-09-25.
 */
async function scenario({ clock = false, routes = [], chain = browserChain() } = {}) {
  const fake = createFakeSession();
  const calls = [], executions = [], releases = [], deposits = [], errors = [];
  const state = { performance: 'available', execution: 'on', setupRelease: RELEASE_OFF, sequenceRelease: RELEASE_OFF, deposit: null };
  const server = createWalletServer({ fake, dist: resolve(import.meta.dirname, '../.wallet-test-dist'), routes: [...routes, async (request, url) => {
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
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, route => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  const rpc = await routeRpc(context, chain);
  const wallet = await installWallets(context);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#/app`);
  return { page, origin, fake, calls, executions, releases, deposits, wallet, context, rpc, set(patch) { Object.assign(state, patch); }, async close() {
    await context.close(); await server.closeAll(); assert.deepEqual(errors, []); assert.deepEqual(wallet.state.csp, []); assert.deepEqual(wallet.state.refused, []); assert.deepEqual(rpc.errors, [], 'the public RPC was asked only what it answers');
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

test('private history and receipts read themselves after login, format exact producer amounts, and disappear on account change', async () => {
  const s = await scenario();
  try {
    await s.page.getByText('Sign in with your wallet to view private history.', { exact: true }).waitFor();
    await s.page.getByText('Sign in with your wallet to view private execution receipts.', { exact: true }).waitFor();
    assert.deepEqual([s.calls.length, s.executions.length], [0, 0], 'nothing private is read while signed out');
    await login(s.page);
    const history = s.page.locator('section[aria-label="Private performance"]');
    await history.getByText('-$0.50', { exact: true }).waitFor();
    for (const text of ['$1,234.57', '-14.78%', '365.00%', '$1.00']) await history.getByText(text, { exact: true }).first().waitFor();
    const other = history.locator('[data-metric-name="otherStrategyCostsUsd"]');
    assert.deepEqual([await other.locator('dt').innerText(), await other.locator('dd').innerText()], ['Other strategy costs', '$0.00']);
    assert.equal(await history.locator('[data-metric-name="timeWeightedCapitalUsd"] dd').getAttribute('title'), '1234.567890123456789012 USD.', 'the exact decimal stays one hover away');
    assert.equal(await history.locator('[data-metric-name="operatorCostsUsd"] dd').innerText(), '—');
    const card = history.locator('[data-performance-status]');
    assert.deepEqual([await card.getAttribute('data-collection-status'), await card.getAttribute('data-external-flows'), await card.getAttribute('data-operator-costs-reason'), await card.getAttribute('data-snapshot-age')], ['measuring', 'incomplete', 'full_l2_cost_unqualified', '0']);
    assert.match(await card.getAttribute('title'), /^Window \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC to .* Deposits and withdrawals may be incomplete\.$/);
    assert.equal(await card.locator('.dm-pill').innerText(), 'Current');
    assert.doesNotMatch(await history.innerText(), /\bavailable\b|_|Observed \d+ seconds|Historical APR is not a forecast/, 'no raw enums and no caption under the figures');
    const receipts = s.page.locator('section[aria-label="Execution receipts"]');
    await s.page.locator('section[aria-label="Execution receipts"][data-execution="ready"]').waitFor();
    // Changed on purpose (qa:visual, Positions): one plain line under each heading; how a missing or uncertain figure shows is that line's title, never a caption.
    const line = async (section) => { const desc = section.locator('.dm-acct-desc'); return [await desc.innerText(), await desc.getAttribute('title')]; };
    assert.deepEqual(await line(history), ['Positions under automation, over the last 24 hours.', 'Missing prices and incomplete history show as dashes.']);
    assert.deepEqual(await line(receipts), ['Transactions automation sent for your sequences.', 'An uncertain or reorganized transaction is never shown as completed.']);
    assert.equal(await receipts.getByRole('heading', { name: 'Reserved', exact: true }).count(), 1);
    assert.match(await receipts.innerText(), /A transaction slot is reserved\. Nothing has been sent\./);
    // Scoped to the two private sections: other cards on this page belong to the read screens.
    assert.doesNotMatch(await history.innerText(), FORBIDDEN); assert.doesNotMatch(await receipts.innerText(), FORBIDDEN);
    await noManualReads(history); await noManualReads(receipts);
    assert.deepEqual([s.calls.length, s.executions.length, s.wallet.state.signed.length], [2, 1, 1], 'one epochs/cards cycle and one receipts page, with only the login signature');
    const screenshots = resolve(import.meta.dirname, '../.test-artifacts'); mkdirSync(screenshots, { recursive: true });
    await s.page.screenshot({ path: join(screenshots, 'p2-private-history.png'), fullPage: true });
    await s.wallet.switchAccount('a', 1);
    await history.getByText('-$0.50', { exact: true }).waitFor({ state: 'hidden' });
    await receipts.getByRole('heading', { name: 'Reserved', exact: true }).waitFor({ state: 'hidden' });
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
test('switched off, history and receipts are quiet empty cards with their reason in data attributes and are not asked again on a timer; switched on, both fill in when the tab is shown again, with nothing pressed', async () => {
  const s = await scenario({ clock: true });
  s.set({ performance: 'off', execution: 'off' });
  try {
    await login(s.page);
    await s.page.locator('section[data-performance="unavailable"][data-performance-reason="route_not_available"]').waitFor();
    await s.page.locator('section[data-execution="unavailable"][data-execution-reason="route_not_available"]').waitFor();
    await s.page.getByText('Managed positions for this wallet appear here.', { exact: true }).waitFor();
    await s.page.getByText('Receipts for this wallet appear here.', { exact: true }).waitFor();
    for (const section of ['Private performance', 'Execution receipts']) {
      const text = await s.page.locator(`section[aria-label="${section}"]`).innerText();
      assert.doesNotMatch(text, FORBIDDEN, section);
      assert.doesNotMatch(text, /route not available|route_not_available|unavailable right now/i, `${section}: the reason is never printed`);
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
    await s.page.getByText('-$0.50', { exact: true }).waitFor();
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
    assert.equal(await line.innerText(), 'To open a new position, use New position: its last step creates it through your wallet.');
    assert.equal(await line.getByRole('link', { name: 'New position', exact: true }).getAttribute('href'), '#/new');
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
    assert.match(text, /You pay network gas; Uniswap pool fees apply only if you swap\./);
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
test('sequence is reachable from Automate, reads its release on mount with no wallet, and without one says in one plain line that automation can’t be set up here', async () => {
  const s = await scenario();
  try {
    // The way into sequences lives on Automate (DESIGN.md E.6), where wallet builds render its link.
    await s.page.goto(`${s.origin}/#/automate`);
    await s.page.getByRole('link', {name:'Set up Domino-compound'}).click();
    await s.page.getByRole('heading', {name:'Set up automation',exact:true}).waitFor();
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
    for (const [status, code] of [[403, 'origin_not_allowed'], [404, 'route_not_available'], [503, 'setup_configuration_unavailable']]) {
      s.set({ sequenceRelease: { status, body: { error: code } }, setupRelease: { status, body: { error: code } } });
      await s.page.goto(`${s.origin}/#/sequence`); await s.page.reload();
      await s.page.locator(`[data-sequence-release="unavailable"][data-sequence-release-reason="${code}"]`).waitFor();
      assert.doesNotMatch(await s.page.locator('main').innerText(), /Create a paused sequence|not available|not connected/i, `sequence ${status}`);
      await s.page.goto(`${s.origin}/#/setup`); await s.page.reload();
      // No saved profile: no card, only the hidden marker that says where the release stands.
      await s.page.locator(`[data-setup-release="unavailable"][data-setup-release-reason="${code}"]`).waitFor({ state: 'attached' });
      assert.doesNotMatch(await s.page.locator('main').innerText(), /Fund a new operation|not connected|not available on this deployment/i, `setup ${status}`);
    }
    // Changed on purpose (2026-09-24): the saved profile only fed the owner controls' recovery path, which the owner removed.
    await s.page.evaluate((value) => localStorage.setItem('domino.sequence.public-recovery.v1', JSON.stringify(value)), saved);
    await s.page.goto(`${s.origin}/#/sequence`); await s.page.reload();
    await s.page.locator('[data-sequence-release="unavailable"]').waitFor();
    assert.equal(await s.page.locator('main button').count(), 0, 'a saved profile brings no controls back');
    assert.ok(s.releases.every(call => call.method === 'GET'));
    assert.equal(s.wallet.state.signed.length, 0); assert.deepEqual(s.wallet.state.refused, [], 'mounting asked the wallet for nothing');
  } finally { await s.close(); }
});

// ---- Setup's assisted swap: a quote for the amount the owner types (G15) ----------------

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
 */
function fakeDepositChain(owner, { tokenId = 4242n, balances = {}, eth = 10n ** 18n, liquidity = 5n * 10n ** 17n, liquidFrom = null, protocolFee = 0, clockSkew = 0, finality = 'final', quoteDelayMs = 0, ownerCode = '0x', delegateCode = null, atomic = null, batchError = null, simulation = 'ok' } = {}) {
  const at = (byte, bytes = 20) => `0x${byte.toString(16).padStart(2, '0').repeat(bytes)}`;
  const setup = at(0x71), poolManager = at(0x72), positionManager = at(0x73), stateView = at(0x74), feeRecipient = at(0x75);
  const code = { [setup]: '0x6071', [poolManager]: '0x6072', [positionManager]: '0x6073', [stateView]: '0x6074', [QUOTER.address]: QUOTER.code };
  const deployment = { setup, setupCodeHash: keccak256(code[setup]), poolManager, positionManager, stateView, poolManagerCodeHash: keccak256(code[poolManager]),
    positionManagerCodeHash: keccak256(code[positionManager]), stateViewCodeHash: keccak256(code[stateView]), feeRecipient, feeBps: 30, tariffVersion: '1', expiresAt: Math.floor(Date.now() / 1000) + 86_400 };
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
  const blockOf = index => ({ number: numberToHex(0x10 + index), hash: at(0xb0 + index, 32) });
  const hashOf = index => at(0xc0 + index, 32);
  const decode = tx => decodeFunctionData({ abi: lower(tx.to) === setup ? setupChainAbi : erc20Abi, data: tx.data });
  function view(to, data, tag) {
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
      const answers = { manager: poolManager, positions: positionManager, stateView, feeRecipient, assistedFeeBps: 30, tariffVersion: 1n, ownerNonce: BigInt(operations.size),
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
    if (functionName === 'allowance') return encodeFunctionResult({ abi: erc20Abi, functionName, result: lower(args[1]) === setup ? allowances.get(to) ?? 0n : 0n });
    if (functionName === 'approve') return encodeFunctionResult({ abi: erc20Abi, functionName, result: true });
    if (functionName === 'balanceOf') return encodeFunctionResult({ abi: erc20Abi, functionName, result: lower(args[0]) === lower(owner) ? held.get(to) ?? 0n : 0n });
    throw new Error(`unexpected ${functionName} on ${to}`);
  }
  /**
   * A batch (EIP-5792), as a wallet that executes it atomically does: `atomic` is what the wallet says of chain 4663
   * (`supported`, `ready`, or nothing), `batchError` its answer to the first batch it is offered (a refusal such as
   * 5750 or 5760), `simulation` whether it carries eth_simulateV1. Each call is checked as the setup contract checks it
   * (the operation id the owner opens next, the allowance, the ETH carried, the swap's own limits) and applied in turn;
   * one that fails undoes them all.
   */
  const batches = [];
  let capability = atomic, refuseBatch = batchError;
  function check(tx) {
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
    const saved = { allowances: new Map(allowances), operations: new Map(operations), sqrtPrice };
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
      operations.clear(); saved.operations.forEach((value, key) => operations.set(key, value));
      sqrtPrice = saved.sqrtPrice;
    }
    return results;
  }
  /** What the contracts make of a transaction once it is included. */
  function include(tx) {
    const { functionName, args } = decode(tx);
    if (lower(tx.to) !== setup) {
      if (functionName === 'approve' && lower(args[0]) === setup) allowances.set(lower(tx.to), args[1]);
      return;
    }
    if (functionName === 'open') operations.set(args[0], { owner, key: args[1], balance0: args[2], balance1: args[3], swapped: false, closed: false, tokenId: 0n });
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
        case 'eth_requestAccounts': permitted = true; return { result: [owner] };
        case 'wallet_requestPermissions': permitted = true; return { result: [{ parentCapability: 'eth_accounts', caveats: [{ type: 'restrictReturnedAccounts', value: [owner] }] }] };
        case 'wallet_revokePermissions': permitted = false; return { result: null };
        case 'eth_accounts': return { result: permitted ? [owner] : [] };
        case 'eth_chainId': return { result: '0x1237' };
        case 'wallet_switchEthereumChain': return { result: null };
        case 'eth_getCode': return { result: code[lower(params[0])] ?? '0x' };
        case 'wallet_getCapabilities': return { result: capability ? { '0x1237': { atomic: { status: capability } } } : {} };
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
        case 'eth_getTransactionCount': return { result: numberToHex(sends.length) };
        case 'eth_estimateGas': return { result: '0x186a0' };
        case 'eth_getBalance': return { result: numberToHex(eth) };
        case 'eth_call':
          // A slow wallet: each quoter question takes `quoteDelayMs` to answer.
          if (quoteDelayMs > 0 && lower(params[0].to) === QUOTER.address) await new Promise(resolve => setTimeout(resolve, quoteDelayMs));
          return { result: view(lower(params[0].to), params[0].data, params[1]) };
        // The newest block's number, as eth_getBlockByNumber('latest') has it.
        case 'eth_blockNumber': return { result: blockOf(sends.length).number };
        case 'eth_sendTransaction': {
          const { functionName } = decode(params[0]);
          if (refuse.delete(functionName)) { declined.push(functionName); return { error: { code: 4001, message: 'User rejected the request.' } }; }
          const index = sends.length; sends.push(params[0]);
          if (toRevert.delete(functionName)) reverted.add(index); else include(params[0]);
          return { result: hashOf(index) };
        }
        case 'eth_getTransactionByHash': case 'eth_getTransactionReceipt': {
          const index = sends.findIndex((_, i) => hashOf(i) === lower(params[0]));
          if (index === -1) return { result: null };
          const sent = sends[index], block = { blockHash: blockOf(index).hash, blockNumber: blockOf(index).number };
          return { result: method === 'eth_getTransactionByHash'
            ? { hash: hashOf(index), from: sent.from, to: sent.to, input: sent.data, value: sent.value, nonce: sent.nonce, chainId: sent.chainId, type: sent.type, gas: sent.gas, maxFeePerGas: sent.maxFeePerGas, maxPriorityFeePerGas: sent.maxPriorityFeePerGas, ...block }
            : { transactionHash: hashOf(index), from: sent.from, to: sent.to, status: reverted.has(index) ? '0x0' : '0x1', gasUsed: '0xc350', effectiveGasPrice: sent.maxFeePerGas, ...block } };
        }
        case 'eth_getBlockByNumber': {
          if (params[0] === 'finalized') return { result: FINALIZED };
          // The newest block, at this machine's time (`clockSkew` seconds on): the chain's clock, which Create position compares its own with.
          if (params[0] === 'latest') return { result: { ...blockOf(sends.length), timestamp: numberToHex(Math.floor(Date.now() / 1000) + clockSkew) } };
          const index = Number(BigInt(params[0])) - 0x10;
          return { result: index >= 0 && index < sends.length ? blockOf(index) : null };
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
    revert(functionName) { toRevert.add(functionName); },
    /** Every transaction sent, decoded against the contract it went to. */
    decoded: () => sends.map(tx => ({ to: lower(tx.to), from: lower(tx.from), value: BigInt(tx.value), nonce: tx.nonce, ...decode(tx) })),
  };
}

/** The chain above announced as a browser wallet of its own (EIP-6963), beside the mock wallets, which stay untouched. */
async function installDepositWallet(context, chain) {
  await context.exposeFunction('__dominoDepositWallet', (method, params) => chain.request(method, params));
  await context.addInitScript(() => {
    const provider = {
      async request({ method, params }) {
        const reply = await window.__dominoDepositWallet(method, params ?? []);
        // A revert keeps its data, as a node's reply does: { code: 3, message: 'execution reverted', data }.
        if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code }, reply.error.data ? { data: reply.error.data } : {});
        return reply.result;
      },
      on() { return provider; },
      removeListener() { return provider; },
    };
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
/** The standard range the read stub's pool price (tick 0) gives New position, in ticks, as Review states it. */
const STUB_RANGE = [-3600, 4080];
/** The read stub's pool price: tick 0. */
const STUB_SQRT_PRICE = 2n ** 96n;
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
 */
async function openCreated(page, id, timeout = 60_000, shot = null) {
  const next = page.locator(`[data-created-position="${id}"]`);
  await next.waitFor({ timeout });
  assert.equal(await page.locator('[data-create-position]').innerText(), 'Position created');
  assert.deepEqual(await next.locator('a').evaluateAll((links) => links.map((a) => [a.getAttribute('data-created-next'), a.getAttribute('href')])), [
    ['plain', `#/positions/${id}`],
    ['compound', `#/sequence/compound/${id}`],
    ['domino', `#/sequence/domino/${id}`],
  ]);
  assert.match(await next.innerText(), new RegExp(`Position NFT ${id} is in your wallet\\.[\\s\\S]*Plain position[\\s\\S]*View position[\\s\\S]*Auto-compound · 2%[\\s\\S]*Domino-compound · 4%`));
  assert.ok(!(await page.locator('[data-journey-footer] > button').first().isVisible()), 'Back rests once the position exists');
  if (shot) {
    await next.evaluate((element) => element.scrollIntoView({ block: 'end' }));
    await page.screenshot({ path: join(shots(), shot) });
  }
  await next.locator('[data-created-next="plain"]').click();
  await page.waitForFunction((want) => location.hash === `#/positions/${want}`, id, { timeout: 10_000 });
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
 * more same-origin endpoints for the wallet-server, asked before the read stub.
 */
async function atReview(chain, { answer, amount, routes = [] } = {}) {
  const read = createReadStub({ answer: firstAnswer(answer, walletAssets(chain)) });
  const s = await scenario({ chain: mintedChain(chain), routes: [...routes, (request, url) => read.handle(request, url)] });
  try {
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
    await s.page.keyboard.press('Escape');
    await walkToReview(s.page, { amount });
    await s.page.locator('[data-create-position="idle"]').waitFor({ timeout: 30_000 });
    // Review's plan is drawn once the read service has answered the wallet's balances.
    await s.page.locator('[data-review-plan]').waitFor({ timeout: 30_000 });
    return Object.assign(s, { read, services });
  } catch (error) { await s.close().catch(() => {}); throw error; }
}

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
    assert.equal(await s.page.locator('#create-reason').innerText(), 'Your wallet asks you to sign each step in the list above, in order.');
    assert.equal(await s.page.getByRole('link', { name: 'Continue in Setup' }).count(), 0, 'no hand-off to Setup');
    assert.deepEqual(chain.sends, [], 'nothing is sent by arriving');
    // The wallet holds both tokens: Review plans both, and nothing is swapped.
    assert.equal(await s.page.locator('[data-review-amounts]').getAttribute('data-review-plan'), 'both');
    assert.equal(await s.page.locator('[data-review-swap], [data-review-swap-note], [data-review-short]').count(), 0);
    // What Review says the position holds: the ETH the range pairs with the typed 1 TOKEN.
    const [, eth, token] = (await s.page.locator('[data-review-amounts]').innerText()).match(/^([\d.,]+) ETH \+ ([\d.,]+) TOKEN$/) ?? [];
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
    assert.match(await list.innerText(), /Approve the exact amount\s+TOKEN[\s\S]*Done[\s\S]*Deposit the tokens\s+Waiting for the network[\s\S]*Create the position\s+Next/);
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
    assert.match(await detail.locator('.dm-pos-facts').innerText(), new RegExp(`Owner\\s+${OWNER}[\\s\\S]*Ticks\\s+-3600 to 4080`));
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

test('a wallet that executes batches atomically creates the position with one signature: the exact approval, the deposit and the mint in one batch, and no transaction of their own', async () => {
  const chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n }, atomic: 'supported' });
  const s = await atReview(chain);
  const { setup } = chain.release.deployment;
  try {
    // The wallet's capability is read before the press, and asks nothing of the person: one signature, nothing to choose.
    await s.page.locator('#create-reason', { hasText: 'Your wallet asks you to sign once: every step together, or none of them.' }).waitFor({ timeout: 30_000 });
    assert.equal(await s.page.locator('[data-create-batch]').count(), 0);
    assert.deepEqual([chain.sends, chain.batches], [[], []], 'nothing asked by arriving');
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
    assert.equal(await s.page.locator('#create-batch-note').innerText(), 'Your wallet will first ask to turn on its smart account (EIP-7702). Your address stays the same, and your key stays in control.');
    assert.equal(await s.page.locator('#create-reason').innerText(), 'Your wallet asks you to sign each step in the list above, in order.', 'the steps stay the main way');
    await s.page.screenshot({ path: join(shots(), 'create-position-batch-offer.png'), fullPage: true });
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

test('a batch the wallet cannot make after all goes step by step in the same press; one the wallet cannot simulate is simulated on the chain’s RPC', async () => {
  // Said supported, refused as unsupported: asked once, then each step as for any wallet.
  let chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n }, atomic: 'supported', batchError: { code: 5760, message: 'Atomicity not supported' } });
  let s = await atReview(chain);
  try {
    await s.page.locator('#create-reason', { hasText: 'sign once' }).waitFor({ timeout: 30_000 });
    await s.page.locator('[data-create-position="idle"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.deepEqual(chain.decoded().map(tx => tx.functionName), ['approve', 'open', 'mint']);
    assert.deepEqual(chain.batches, []);
    assert.equal(chain.log.filter(method => method === 'wallet_sendCalls').length, 1, 'asked once, refused, never again');
    await onlyTheWallet(s, chain);
  } finally { await s.close(); }
  // No eth_simulateV1 in the wallet: the chain's own RPC simulates the batch, and the wallet still signs it once.
  chain = fakeDepositChain(ACCOUNTS[0].address, { balances: { [FIXTURE_TOKEN]: 5_000_000n }, atomic: 'supported', simulation: 'unsupported' });
  s = await atReview(chain);
  const asked = [];
  try {
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' };
    await s.context.route(/rpc\.mainnet\.chain\.robinhood\.com/, async route => {
      const request = route.request();
      if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const body = JSON.parse(request.postData() ?? '{}');
      asked.push(body.method);
      if (body.method !== 'eth_simulateV1') return route.fulfill({ status: 500, headers: cors, body: '' });
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [{ calls: chain.simulate(body.params[0].blockStateCalls[0].calls) }] }) });
    });
    await s.page.locator('#create-reason', { hasText: 'sign once' }).waitFor({ timeout: 30_000 });
    await s.page.locator('[data-create-position="idle"]').click();
    await openCreated(s.page, '4242', 60_000);
    assert.deepEqual(asked, ['eth_simulateV1']);
    assert.deepEqual(chain.sends, []);
    assert.equal(chain.batches.length, 1);
    assert.deepEqual(chain.refused, [], 'the wallet’s refusal of eth_simulateV1 is its own answer, not a method this page needs');
  } finally { await s.close(); }
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
    assert.ok(!chain.viewed.includes('allowance') && !chain.viewed.includes('balanceOf') && !chain.viewed.includes('nextOperationId'), 'nothing about a new deposit was even read');
    assert.equal(chain.operations.size, 1, 'no second operation');
    await onlyTheWallet(s, chain);
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
    assert.equal(await s.page.locator('#create-reason').innerText(), 'A deposit is held for this pool. Press Create position to create the position from it, or refund it.');
    assert.deepEqual(await walletStepStates(s.page), [[`approve:${FIXTURE_TOKEN}`, 'done'], ['fund', 'done'], ['mint', 'failed']]);
    assert.deepEqual(chain.decoded().map(tx => tx.functionName), ['approve', 'open'], 'the mint was never sent');
    assert.ok((await s.page.evaluate(() => location.hash)).startsWith('#/new'), 'still on New position');

    const refund = s.page.getByRole('button', { name: 'Refund the deposit instead', exact: true });
    await refund.click();
    await s.page.getByRole('status').filter({ hasText: 'The deposit was refunded to your wallet.' }).waitFor({ timeout: 60_000 });
    assert.deepEqual(await walletStepStates(s.page), [['refund', 'done']]);
    assert.equal(await s.page.locator('[data-create-position]').getAttribute('data-create-position'), 'idle');
    assert.equal(await refund.count(), 0, 'nothing left to refund');
    const [, open, cancel] = chain.decoded();
    assert.deepEqual([cancel.functionName, cancel.to, cancel.from, cancel.value, cancel.nonce, cancel.args[0]], ['cancel', setup, OWNER, 0n, '0x2', open.args[0]], 'cancel for the operation the deposit opened, at the nonce the declined mint gave back');
    assert.deepEqual([chain.operations.get(open.args[0]).closed, chain.operations.get(open.args[0]).tokenId], [true, 0n]);
    assert.ok((await s.page.evaluate(() => location.hash)).startsWith('#/new'));
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
  // 10,000,000,000 TOKEN (6 decimals) pairs with about 0.0112 ETH at this range; the wallet holds 0.01 ETH, enough for gas only.
  const typed = 10n ** 16n;
  const chain = fakeDepositChain(ACCOUNTS[0].address, { eth: 10n ** 16n, balances: { [FIXTURE_TOKEN]: 2n * typed } });
  const s = await atReview(chain, { amount: '10000000000' });
  const { setup } = chain.release.deployment;
  try {
    // Review: the plan is the swap from TOKEN, in the headline and the line under it, with the note that says why.
    const amounts = s.page.locator('[data-review-amounts]');
    assert.equal(await amounts.getAttribute('data-review-plan'), 'swap');
    assert.match(await amounts.innerText(), /^≈[\d.,]+ TOKEN \+ ≈[\d.,]+ ETH$/, 'what the position holds after the swap');
    const swapLine = s.page.locator('[data-review-swap]');
    assert.equal(await swapLine.getAttribute('data-review-swap'), '1', 'from TOKEN, currency 1');
    const [, from, part, bought] = (await swapLine.innerText()).match(/^From your wallet: ([\d.,]+) TOKEN\. About ([\d.,]+) TOKEN of it is swapped for ≈([\d.,]+) ETH\.$/) ?? [];
    assert.equal(from, '10,000,000,000', 'the typed amount is the budget');
    const partRaw = parseUnits(part.replaceAll(',', ''), 6);
    assert.ok(partRaw > typed / 3n && partRaw < (typed * 2n) / 3n, `about half of it at this range: ${part}`);
    assert.ok(parseUnits(bought.replaceAll(',', ''), 18) > 0n);
    assert.equal(await s.page.locator('[data-review-swap-note]').innerText(),
      'Your wallet does not hold enough ETH, so part of your TOKEN is swapped for it inside this pool before the position is created. The amounts are estimates before the pool’s price impact. The swap returns at least what your slippage limit allows; the pool’s fee and Domino’s assisted-swap fee (0.65%) apply to the swapped part.');
    assert.equal(await s.page.locator('[data-review-short]').count(), 0);
    // Review keeps Your choices and Wallet steps: no deposit amounts per token, and nothing that asks for a sign-in.
    assert.deepEqual(await s.page.locator('[data-stage="review"] h3').allInnerTexts(), ['Your choices', 'Wallet steps']);
    assert.doesNotMatch(await s.page.locator('main').innerText(), /Deposit amounts per token|Sign in with your wallet to see these amounts\./);
    assert.equal(await s.page.locator('section[data-stage="balance"]').count(), 0);
    // The wallet steps, in order: approve TOKEN, deposit it, swap, create. None running before the press.
    assert.deepEqual(await walletStepStates(s.page), [[`approve:${FIXTURE_TOKEN}`, null], ['fund', null], ['swap', null], ['mint', null]]);
    const list = s.page.locator('[data-wallet-steps]');
    assert.match(await list.innerText(), /Approve the exact amount\s+TOKEN[\s\S]*Deposit the token\s+TOKEN[\s\S]*Swap for the other token\s+One swap inside this pool[\s\S]*Domino’s assisted-swap fee \(0\.65%\)[\s\S]*Create the position/);
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
    const [, from, part, bought] = (await swapLine.innerText()).match(/^From your wallet: ([\d.,]+) ETH\. About ([\d.,]+) ETH of it is swapped for ≈([\d.,]+) TOKEN\.$/) ?? [];
    const reviewed = parseUnits(from.replaceAll(',', ''), 18);
    assert.ok(parseUnits(part.replaceAll(',', ''), 18) < reviewed);
    assert.ok(parseUnits(bought.replaceAll(',', ''), 6) >= 1_000_000n, `the typed 1 TOKEN, at least: ${bought}`);
    await s.page.locator('[data-review-swap-note]').waitFor();
    // ETH needs no approval: it travels with the deposit.
    assert.deepEqual(await walletStepStates(s.page), [['fund', null], ['swap', null], ['mint', null]]);
    assert.match(await s.page.locator('[data-wallet-steps]').innerText(), /Deposit the token\s+ETH[\s\S]*Native ETH travels with it[\s\S]*Swap for the other token[\s\S]*Create the position/);

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
  const chain = fakeDepositChain(ACCOUNTS[0].address, { eth: 10n ** 16n, balances: { [FIXTURE_TOKEN]: 2n * typed }, liquidity: 0n });
  const s = await atReview(chain, { answer: emptyPools, amount: '10000000000' });
  try {
    assert.equal(await s.page.locator('[data-review-amounts]').getAttribute('data-review-plan'), 'swap');
    // Review, from the figure it already has and no wallet read: one neutral line under the swap note.
    const warning = s.page.locator('[data-review-liquidity="none"]');
    assert.equal(await warning.innerText(), 'This pool reports no liquidity, so part of a one-token deposit cannot be swapped in it. Deposit both tokens, or choose another pool.');
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
    assert.ok(!chain.log.includes('eth_estimateGas') && !chain.viewed.includes('allowance') && !chain.viewed.includes('nextOperationId'), 'no step was even prepared');
    assert.equal(chain.operations.size, 0);
    await onlyTheWallet(s, chain, { reverts: true });
    assert.doesNotMatch(await s.page.locator('main').innerText(), FORBIDDEN);
  } finally { await s.close(); }
});

test('in a pool too thin for the balanced split, the check backs off to a swap the pool fills inside its limit before anything is sent, and Create position approves, deposits, swaps and mints', async () => {
  const typed = 10n ** 16n;
  // 5·10¹⁶ of liquidity: swapping half the TOKEN, as the balanced split would, moves the square-root price about 10%.
  const chain = fakeDepositChain(ACCOUNTS[0].address, { eth: 10n ** 16n, balances: { [FIXTURE_TOKEN]: 2n * typed }, liquidity: 5n * 10n ** 16n });
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
    assert.equal(await s.page.locator('#create-reason').innerText(), 'A deposit is held for this pool. Refund it to your wallet.');
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
  const chain = fakeDepositChain(ACCOUNTS[0].address, { eth: 10n ** 16n, balances: { [FIXTURE_TOKEN]: 2n * typed }, liquidFrom: LIQUID_FROM });
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
    assert.ok(!chain.log.includes('eth_estimateGas') && !chain.viewed.includes('allowance') && !chain.viewed.includes('nextOperationId'), 'no step was even prepared');
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
    await s.page.getByRole('combobox', { name: 'Token in the pool' }).fill(FIXTURE_TOKEN);
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
    await s.page.getByRole('combobox', { name: 'Token in the pool' }).waitFor();
    assert.equal(await stage.locator('p[role="status"].sr-only').first().textContent(), 'Pool from the link: This pool has hooks, and positions can only be created here in pools without hooks. Choose another pool.');
    // Changed on purpose (owner, 2026-09-24): until a token is chosen step 1 shows no Back and no Continue (they
    // arrive with the token); the reason stays in the footer's live region, out of sight.
    assert.equal(await s.page.locator('[data-journey-footer] button').count(), 0, 'no buttons before a token is chosen');
    assert.equal(await s.page.locator('#continue-reason').textContent(), 'Choose a token to continue.');
    assert.deepEqual(asked, [{ token: USDG, maxPools: 1, poolIds: [LINKED] }], 'the link is verified against USDG, by its id alone, once');
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
    const [card, box] = [await s.page.locator('.dm-flow-card').boundingBox(), await aside.boundingBox()];
    assert.ok(box.width > 300 && box.height > 200, `the preview is shown on a phone (${box.width} x ${box.height})`);
    assert.ok(box.y >= card.y + card.height, 'under the steps');
    assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth), 390, 'nothing overflows the phone');
    // Stilled, the picture rests complete: the four fee pips its legend names show, and nothing in it runs.
    const pips = await aside.locator('.dm-flow-pv-art .pip').evaluateAll(nodes => nodes.map(node => [getComputedStyle(node).animationName, Number(getComputedStyle(node).opacity)]));
    assert.equal(pips.length, 4);
    for (const [name, opacity] of pips) assert.ok(name === 'none' && opacity >= 0.5, `a resting pip shows (${name}, ${opacity})`);
    assert.deepEqual(await aside.locator('.dm-flow-pv-legend li').allInnerTexts(), ['In range', 'Out of range', 'Price range', 'Fees earned']);
    assert.equal(await s.page.locator('[data-journey-footer] button').count(), 0, 'no buttons before a token is chosen');

    await s.page.getByRole('combobox', { name: 'Token in the pool' }).fill(FIXTURE_TOKEN);
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
    assert.equal(await aside.locator('.dm-flow-pv-pair').innerText(), 'ETH / TOKEN');
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
    await s.page.getByRole('combobox', { name: 'Token in the pool' }).fill(FIXTURE_TOKEN);
    await s.page.locator(`[data-token-option="${FIXTURE_TOKEN}"]`).click();
    const picker = s.page.locator('[data-picker="pool"][data-pools-state="ok"]');
    await picker.waitFor({ timeout: 30_000 });
    assert.deepEqual(read.requests.filter(r => r.path === '/api/read/v1/pools').map(r => JSON.parse(r.body)), [{ token: FIXTURE_TOKEN, maxPools: 3, poolIds: [X, Y, Z] }], 'the three v4 pools, most liquid first, and nothing else');
    assert.equal(listed.filter(path => path === `/token-pairs/v1/robinhood/${FIXTURE_TOKEN}`).length, 1, 'the artwork and the hints shared one GET');
    const rows = picker.locator('[data-pool-option]');
    assert.equal(await rows.count(), 2, 'the hooked pool is not a row, however liquid');
    assert.equal(await picker.getAttribute('data-pools-hidden'), '1');
    assert.deepEqual(await rows.evaluateAll((els, ids) => els.map(el => ids.find(poolId => el.textContent.includes(poolId))), [X, Y, Z]), [Z, Y], 'the read service’s TVL decides the order: $900 before $50');
    const figures = await rows.evaluateAll(els => els.map(el => [...el.querySelectorAll('[data-provider-figure], [data-row-apr]')].map(cell => cell.innerText.replace(/\s+/g, ' ').trim())));
    assert.deepEqual(figures, [
      ['TVL $900.00', '24h volume $100.00', 'APR 12.17% est.'],
      ['TVL $50.00', '24h volume $1.2K', 'APR 2703.69% est.'],
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
test('for USDG the pools read names the featured pools first, then the provider’s, each once', async () => {
  const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const ZERO = `0x${'0'.repeat(40)}`;
  const FEATURED = [
    '0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6',
    '0xdb922f0619e11b0c1e6c3a142798f0243060b8a4331ea4f4e7de80e898cc02e7',
    '0x94c62eebf6454231b2fcd0259ede448ae3c6ad8617718cd88dab20b30cfae48a',
    '0xf399bd1544377680d48c62fd85c2105b869e55906c4189cc5ab3b4e83446928c',
    '0x24107d152f14a76d292123265ae3f3c71f863fc2f4ef7ba49d64e78d28ea379e',
    '0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a',
  ];
  const [ETH_USDG, PONS_USDG] = [FEATURED[4], FEATURED[5]];
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
    await s.page.getByRole('combobox', { name: 'Token in the pool' }).fill(USDG);
    await s.page.locator(`[data-token-option="${USDG}"]`).click();
    const picker = s.page.locator('[data-picker="pool"][data-pools-state="ok"]');
    await picker.waitFor({ timeout: 30_000 });
    assert.deepEqual(
      read.requests.filter(r => r.path === '/api/read/v1/pools').map(r => JSON.parse(r.body)),
      [{ token: USDG, maxPools: 7, poolIds: [...FEATURED, X] }],
      'the six featured pools in catalogue order, then the provider’s own, PONS/USDG not twice',
    );
    assert.equal(await picker.locator('[data-pool-option]').count(), 1);
    assert.ok((await picker.locator('[data-pool-option]').first().textContent()).includes(ETH_USDG), 'the row is the read service’s own');
  } finally { await s.close(); }
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
    assert.equal(await s.page.locator('#create-reason').innerText(), 'Connect your wallet to create the position. Each transaction appears in your wallet to sign.');
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

test('a finalized receipt shows its transaction hash, block hash and fee recipient whole with copy buttons, amounts in token units, a stoppable intent links to its sequence, and an open one refreshes in place', async () => {
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
    await done.getByRole('heading', { name: 'Finalized', exact: true }).waitFor();
    for (const [field, label, value] of [['transaction-hash', 'Copy transaction hash', finalized.receipt.transactionHash], ['block-hash', 'Copy block hash', finalized.receipt.blockHash], ['service-fee-recipient', 'Copy service fee recipient', finalized.receipt.serviceFeeRecipient]]) {
      const row = done.locator(`[data-receipt-field="${field}"]`);
      assert.match(await row.innerText(), new RegExp(value), `${field} is shown whole`);
      assert.equal(await row.getByRole('button', { name: label }).count(), 1, `${field} has a copy button`);
    }
    await done.getByRole('button', { name: 'Copy transaction hash' }).click();
    await done.locator('[data-receipt-field="transaction-hash"] [data-copied]').waitFor();
    assert.equal(await s.page.evaluate(() => navigator.clipboard.readText()), finalized.receipt.transactionHash);
    // Changed on purpose (2026-09-24): the automation page no longer pauses (the owner removed its controls); the link says how, on the docs.
    assert.deepEqual(await receipts.locator('a').evaluateAll(links => links.map(link => link.getAttribute('href'))), ['#/docs/non-custodial#pause-revoke-withdraw'], 'no external link: the one link is how to pause');

    const cell = (currency, field) => done.locator(`[data-receipt-currency="${currency}"] [data-source-field="${field}"] dd`);
    await cell(TOKEN, 'grossOriginalConsumedRaw').getByText('1.5 TOKEN', { exact: true }).waitFor({ timeout: 30_000 });
    assert.deepEqual([await cell(TOKEN, 'serviceFeeRaw').innerText(), await cell(TOKEN, 'originalAfterRaw').innerText(), await cell(TOKEN, 'grossOriginalConsumedRaw').locator('span').getAttribute('title')], ['0.03 TOKEN', '0.25 TOKEN', "1,500,000 in the token’s smallest units."]);
    await done.locator(`[data-receipt-currency="${UNKNOWN}"] [data-amount-reason="decimals_unavailable"]`).first().waitFor({ timeout: 30_000 });
    assert.deepEqual([await cell(UNKNOWN, 'grossOriginalConsumedRaw').innerText(), await cell(UNKNOWN, 'grossOriginalConsumedRaw').locator('span').getAttribute('title')], ['—', "Token decimals unavailable. 42 in the token’s smallest units."]);
    assert.deepEqual([...asked].sort(), [TOKEN, UNKNOWN], 'one token read per currency, through the read path');

    assert.equal(await open.getAttribute('data-execution-can-cancel'), 'true');
    assert.match(await open.innerText(), /A transaction slot is reserved\. Nothing has been sent\.\s+It can still be stopped: pause your sequence before it is signed\./);
    assert.equal(await open.getByRole('link', { name: 'How to pause', exact: true }).getAttribute('href'), '#/docs/non-custodial#pause-revoke-withdraw');
    assert.deepEqual([await done.getAttribute('data-execution-can-cancel'), await done.getByRole('link').count()], ['false', 0]);
    const text = await receipts.innerText();
    assert.doesNotMatch(text, FORBIDDEN); assert.doesNotMatch(text, /_/, 'no code is printed');
    await noManualReads(receipts);
    await s.page.screenshot({ path: join(shots(), 'p2-receipt-identity.png'), fullPage: true });

    assert.deepEqual(sent.map(call => call.path), ['/api/execution/v1/list'], 'only the page so far');
    await jump(s.page, '00:31');
    await receipts.locator(`[data-execution-intent="${reserved.intentId}"][data-execution-state="signing"]`).waitFor();
    assert.deepEqual(sent.map(call => [call.path, call.body, Boolean(call.csrf)]), [['/api/execution/v1/list', { afterIntentId: null, limit: 10 }, true], ['/api/execution/v1/status', { intentId: reserved.intentId }, true]]);
    assert.equal(await open.getByRole('link', { name: 'How to pause' }).count(), 0, 'signed: no longer offered as stoppable');
    assert.deepEqual(await receipts.locator('[data-execution-intent]').evaluateAll(cards => cards.map(card => card.getAttribute('data-execution-intent'))), [reserved.intentId, finalized.intentId], 'replaced where it stands');
    assert.equal(s.wallet.state.signed.length, 1, 'only the login signature');
  } finally { await s.close(); }
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
 */
function fakeSequenceChain(owner, { roots, chains = {}, operator = null, serviceFeeBps = 400, maxPositions = 3,
  policyVersion = 1n, paused = false, limitsVersion = 1n, rootPermissionValid = true, vaultHeld = [], accounted = 0n, approved = true, settled = false,
  subscribed = [], holder = null, lostApproval = false, balance = '0xde0b6b3a7640000' }) {
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
  const vaults = new Map(roots.map((root, nonce) => [identity(nonce).vault, { id: identity(nonce).id, root, chain: chains[nonce] ?? [] }]));
  // With `approved: false`, which NFT is approved to whom: what a sent `approve` records.
  const approvals = new Map();
  // The position manager reports these NFTs as held by the first vault: what an unmanaged-position recovery checks before it builds.
  const held = new Map(vaultHeld.map(tokenId => [tokenId, [...vaults.keys()][0]]));
  const policy = { serviceFeeBps, triggerDistanceBps: 500, maxOverlapBps: 2000, minimumIntervalSeconds: 60, maxPositions, version: policyVersion, paused };
  const limits = { version: limitsVersion, upsideBps: 5000, maxSlippageBps: 100, maxPriceImpactBps: 100, maxGasCostWei: 1_000_000_000_000_000n, maxObservationAgeSeconds: 60, forecastHorizonSeconds: 3600 };
  // The owner steps the vault can be asked to sign; each is simulated before it is offered, and none of them answers anything.
  const WRITES = ['setOperator', 'setPolicy', 'setExecutionLimits', 'rearmRoot', 'recoverUnmanagedPosition', 'recoverUntrackedCurrency'];
  // Two distinct fee sources, so a position's four reserve balances are four distinct source-and-currency pairs.
  const position = (known, active, isRoot, parentTokenId) => ({ known, active, isRoot, parentTokenId, generation: 0n, tickLower: -60, tickUpper: 60, registrationBaselineId: zero, identity: zero, source0: at(0x71, 32), source1: at(0x72, 32) });
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
      const answers = { owner, sequenceId: vault.id, rootTokenId: vault.root, operator: operator ?? deployment.operator, rootPermissionValid, baseCurrency: at(0x61), quoteCurrency: at(0x62), stateNonce: 1n,
        policy: vault.policy ?? policy, executionLimits: vault.limits ?? limits, accountedCurrency: accounted,
        activePositions: BigInt(1 + vault.chain.filter(member => member.active).length) };
      if (name in answers) return answers[name];
      if (name === 'position') return args[0] === vault.root ? position(true, true, true, 0n) : index(args[0]) === -1 ? position(false, false, false, 0n)
        : position(true, vault.chain[index(args[0])].active, false, index(args[0]) === 0 ? vault.root : vault.chain[index(args[0]) - 1].id);
      if (name === 'successorOf') return args[0] === vault.root ? vault.chain[0]?.id ?? 0n : index(args[0]) === -1 ? 0n : vault.chain[index(args[0]) + 1]?.id ?? 0n;
      if (name === 'feeBalance') return { original: 0n, charged: 0n };
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
  /** What the contracts make of a sent transaction: an approval is recorded against its NFT, a creation registers the vault it predicted. */
  function apply(tx) {
    const to = String(tx.to).toLowerCase();
    if (to !== deployment.positionManager && to !== deployment.factory) return;
    const { functionName, args } = decodeFunctionData({ abi: chainAbi, data: tx.data });
    if (to === deployment.positionManager && functionName === 'approve' && !lostApproval) approvals.set(args[1], String(args[0]).toLowerCase());
    if (to === deployment.factory && functionName === 'createVault') {
      const [params, nonce] = args, { id, vault } = identity(nonce);
      vaults.set(vault, { id, root: params.rootTokenId, chain: [], policy: params.policy, limits: params.limits });
    }
  }
  async function request(method, params) {
    log.push(method);
    try {
      if (method === 'eth_getBlockByNumber') return { result: { number: '0x10', hash: at(0xbb, 32) } };
      // A suite that routes these here keeps them off the mock wallet, which
      // refuses anything outside its login set and fails the scenario's close.
      if (method === 'eth_getTransactionCount') return { result: numberToHex(sends.length) };
      if (method === 'eth_estimateGas') return { result: '0x186a0' };
      if (method === 'eth_getBalance') return { result: balance };
      if (method === 'eth_gasPrice') return { result: '0x5f5e100' };
      if (method === 'eth_sendTransaction') { const index = sends.length; sends.push(params[0]); apply(params[0]); return { result: hashOf(index) }; }
      if (method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt') {
        const index = sends.findIndex((_, i) => hashOf(i) === String(params[0]).toLowerCase());
        if (!included || index === -1) return { result: null };
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
  return { log, missing, refused, sends, simulations, request, include, predict, poolKey, poolId, policy, limits, vaults: [...vaults.keys()], release: { contractVersion: '1.0.0-rc.1', chainId: 4663, available: true, deployment } };
}

test('Start tracking is offered for the sequences the wallet lists, reads each one\'s positions from its vault, and sends enroll with the session: nothing typed, nothing signed', async () => {
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
    assert.match(await rows.nth(0).innerText(), /^Position #200\s+Sequence 0x[0-9a-f]{4}…[0-9a-f]{4}\s+Start tracking$/);
    assert.equal(await history.locator('input').count(), 0, 'every sequence is listed, so nothing is typed');
    assert.doesNotMatch(await history.innerText(), FORBIDDEN);
    await noManualReads(history);

    const row = track.locator(`[data-trackable-sequence="${chain.vaults[0]}"]`);
    await row.getByRole('button', { name: 'Start tracking', exact: true }).click();
    await row.locator('[data-enrollment-outcome="sent"]').getByText('Tracking requested. The first observation appears after collection.', { exact: true }).waitFor();
    assert.deepEqual(enrolls, [{ body: { vault: chain.vaults[0], tokenIds: ['100', '11'] }, csrf: enrolls[0]?.csrf, method: 'POST' }], 'the vault and its complete active set: the root and the successor it still holds');
    assert.ok(enrolls[0].csrf, 'sent with the session CSRF');
    assert.equal(await row.getByRole('button', { name: 'Start tracking' }).count(), 0, 'sent: not offered again');
    await s.page.screenshot({ path: join(shots(), 'p2-track-sequences.png'), fullPage: true });
    assert.deepEqual([...new Set(chain.log)].sort(), ['eth_call', 'eth_getBlockByNumber', 'eth_getCode'], 'the chain was only read');
    assert.deepEqual([...new Set(s.wallet.state.log.map(entry => entry.method))].filter(method => !['eth_accounts', 'eth_chainId', 'eth_requestAccounts', 'personal_sign', 'wallet_requestPermissions', 'wallet_switchEthereumChain'].includes(method)), []);
    assert.equal(s.wallet.state.signed.length, 1, 'only the login signature: Start tracking is not a wallet transaction');
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

/** A link naming the mode and the position, with the release published: the quote currency 0 chosen, consent ticked, Set up automation pressed. */
async function setUpFromLink(s, chain, { mode = 'compound', tokenId = '5' } = {}) {
  s.set({ sequenceRelease: { status: 200, body: chain.release } });
  await s.page.goto(`${s.origin}/${labHash({ positions: [walletPosition(chain, tokenId)], mode, tokenId })}`);
  await s.page.reload();
  const card = s.page.locator('[data-sequence-create]');
  await card.waitFor({ timeout: 30_000 });
  await card.getByRole('radiogroup', { name: 'Quote currency' }).getByRole('radio', { name: 'AAA', exact: true }).click();
  await card.getByRole('checkbox', { name: /^I consent to using this NFT’s already uncollected fees/ }).check();
  await card.getByRole('button', { name: 'Set up automation', exact: true }).click();
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
    assert.equal(await empty.getByRole('link', { name: 'New position' }).getAttribute('href'), '#/new');
    assert.equal(await main.locator('input').count(), 0, 'no NFT id or address is ever typed');
    const text = await main.innerText();
    assert.doesNotMatch(text, /Owner controls|Network budget|Create a paused sequence|Manage a sequence|Root NFT|Read my sequences|Sequence address/i);
    assert.doesNotMatch(text, FORBIDDEN);
    assert.equal(s.rpc.scans(OWNER), 1, 'the positions are read from the chain, once');
    assert.deepEqual(chain.log, [], 'nothing is read from the chain by opening the page');
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
    assert.match((await picker.getByRole('radio').first().innerText()).trim(), /^AAA \/ BBB\s+0\.30%\s+#5$/);
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
    assert.equal(await created.getByRole('link', { name: 'How to switch it on' }).getAttribute('href'), '#/docs/domino-compounder#start-and-stop');
    // 2026-09-24 (the three features joined up): and the way back to the position, which Positions now shows in its sequence.
    assert.equal(await created.getByRole('link', { name: 'View position' }).getAttribute('href'), '#/positions/5');
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
    assert.deepEqual([...new Set(s.wallet.state.log.map(entry => entry.method))].filter(method => !['eth_accounts', 'eth_chainId', 'eth_requestAccounts', 'wallet_requestPermissions', 'wallet_switchEthereumChain'].includes(method)), [], 'the wallet itself was only asked to connect');
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
    const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [], approved: false, settled: true });
    await routeChain(s, chain, CHAIN_METHODS, (method, params) => method === 'eth_getTransactionReceipt' && String(params[0]).toLowerCase() === sentHash(index)
      ? { error: { code: -32000, message: 'header not found' } } : chain.request(method, params));
    try {
      await connectOnly(s.page);
      const card = await setUpFromLink(s, chain);
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

/** Connects Test Wallet A from the header's dialog, on Robinhood Chain, without signing in. */
async function connectWallet(page) {
  await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
  await page.locator('header [aria-haspopup="dialog"]').click();
  const dialog = page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
  await dialog.getByRole('button', { name: 'Connect Test Wallet A', exact: true }).click();
  await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
  await page.keyboard.press('Escape');
}

/** The read service's nft-positions questions the page asked, in order: none any more. */
const nftReads = (read) => read.requests.filter((r) => r.path.endsWith('/nft-positions')).map((r) => JSON.parse(r.body).tokenIds);
/** Everything the page keeps in the browser that is not the appearance or a session's own key. */
const kept = (page) => page.evaluate(() => [...Object.keys(localStorage), ...Object.keys(sessionStorage)].filter((key) => /position/i.test(key)));

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
    assert.equal((await s.page.locator('[data-empty="owned-connect"]').innerText()).replace(/\s+/g, ' '), 'Connect a wallet to see your positions Connect wallet');
    assert.deepEqual([chain.scans(OWNER), nftReads(read).length], [0, 0], 'nothing is asked without a wallet');

    await recordList(s.page);
    await connectWallet(s.page);
    const card = s.page.locator('[data-owned="ready"]');
    await card.waitFor();
    // One read of the chain by the page itself, the address in its POST bodies only; no route of the site.
    assert.equal(chain.scans(OWNER), 1);
    assert.deepEqual(site.asked, [], 'no route of the site is asked');
    assert.deepEqual(await listSeen(s.page), ['loading', 'ready'], 'the loading rows, then the list');
    const tabs = s.page.getByRole('tab');
    assert.deepEqual((await tabs.allInnerTexts()).map((text) => text.replace(/\s+/g, ' ').trim()), ['Open 1', 'Closed 11']);
    assert.equal(await s.page.getByRole('tab', { selected: true }).innerText().then((text) => text.replace(/\s+/g, ' ')), 'Open 1');
    assert.equal(await card.getAttribute('data-owned-block'), String(chain.head));

    // The open position's row, every figure from the chain read: the read service is never asked.
    const row = s.page.locator(`a[data-position-row="${OWNED_OPEN}"][data-snapshot="${chain.head}"]`);
    await row.waitFor();
    assert.equal(await row.getAttribute('href'), `#/positions/${OWNED_OPEN}`);
    const rowText = await row.innerText();
    assert.match(rowText, /ETH\s*\/\s*TOKEN[\s\S]*0\.30%\s*·\s*#3135288[\s\S]*In range/);
    assert.match(rowText, /633,825,300,114 ETH|0\.000000633825 ETH/);
    assert.equal(await s.page.locator('[data-position-row]').count(), 1);
    // 2026-09-24 (the three features joined up): under the open row, its feature from chain and the way to automate it.
    const feature = s.page.locator(`[data-position-automation="${OWNED_OPEN}"]`);
    await feature.locator('a[data-automate-entry]').waitFor();
    assert.equal(await feature.getAttribute('data-automation'), 'plain');
    assert.match(await feature.innerText(), /^Plain position\s+Automate$/);
    assert.equal(await feature.locator('a').getAttribute('href'), `#/sequence/${OWNED_OPEN}`);
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
    await s.page.getByRole('button', { name: 'Show 1 more', exact: true }).click();
    await s.page.locator(`[data-owned-rows="closed"] a[data-position-row="${OWNED_CLOSED[10]}"]`).waitFor();
    assert.equal(await s.page.getByRole('button', { name: /^Show \d+ more$/ }).count(), 0);
    assert.equal(chain.scans(OWNER), 1, 'the tabs and Show more ask nothing');
    await s.page.locator('main').screenshot({ path: join(shots(), 'positions-closed.png') });
    const listText = await s.page.locator('main').innerText();
    assert.doesNotMatch(listText, FORBIDDEN);
    assert.doesNotMatch(listText, /comma|type (?:the|an) NFT id|Look up|Position NFTs/i, 'no typed ids asked for');
    assert.deepEqual(await kept(s.page), [], 'nothing about positions is kept in the browser');

    // A row is a link to the position's own page, read from the chain by the page.
    await s.page.getByRole('tab', { name: /^Open/ }).click();
    await row.click();
    await s.page.waitForFunction((id) => location.hash === `#/positions/${id}`, OWNED_OPEN);
    const detail = s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"]`);
    await detail.waitFor();
    await detail.locator('[data-stat="price"] [data-current-price="usable"]').waitFor();
    assert.match(await detail.locator('h1').innerText(), /^ETH\s*\/\s*TOKEN$/);
    assert.match(await detail.locator('.dm-pos-chips').innerText(), /Uniswap · 0\.30% · #3135288\s+In range/);
    const stats = await detail.locator('[data-position-stats]').innerText();
    assert.match(stats, /CURRENT PRICE\s+≈1,000,000,000,000 TOKEN per ETH/, 'the pool’s price from the same read, with no button to ask for it');
    assert.match(stats, /RANGE\s+≈994,018,000,000 – ≈1,006,020,000,000/);
    assert.match(stats, /UNCLAIMED FEES\s+[\d.,]+ ETH\s+0 TOKEN/);
    assert.equal(await detail.getByRole('button', { name: 'Show current price' }).count(), 0);
    const facts = await detail.locator('.dm-pos-facts').innerText();
    assert.match(facts, /NFT id\s+3135288/);
    assert.match(facts, new RegExp(`Owner\\s+${OWNER}`));
    assert.match(facts, new RegExp(`Liquidity\\s+${LIQUIDITY}`));
    assert.match(facts, /Ticks\s+-60 to 60/);
    // Changed on purpose (2026-09-24, the three features joined up): Automate left the facts' links for the owner's own
    // actions in the title row, beside Collect fees and Close position, and opens the automation page with this position
    // chosen and the mode still to choose; the position's feature is a pill beside its range status.
    assert.deepEqual(await detail.locator('.dm-pos-links a').evaluateAll((links) => links.map((a) => [a.textContent, a.getAttribute('href')])), [
      ['Pool', `#/pool/${STUB_POOL_ID}/${FIXTURE_TOKEN.toLowerCase()}`],
      ['Add to this pool', `#/new/${STUB_POOL_ID}`],
    ]);
    await detail.locator('[data-position-actions] a[data-automate-entry]').waitFor();
    assert.deepEqual(await detail.locator('[data-position-actions] a[data-automate-entry]').evaluate((a) => [a.textContent, a.getAttribute('href')]), ['Automate', `#/sequence/${OWNED_OPEN}`]);
    assert.equal(await detail.locator('.dm-pos-chips [data-automation="plain"]').innerText(), 'Plain position');
    assert.ok(chain.log.some((call) => call.method === 'eth_call' && Number(call.params[1]) === chain.head - 2), 'the page reads its NFT from the chain, at head − 2');
    assert.deepEqual(nftReads(read), [], 'and never from the read service');
    assert.ok(!read.requests.some((r) => r.path.endsWith('/pool-market')), 'nor the pool’s price: it came with the read');
    // The owner's actions have their mount: the chunk is opened on the page, behind the wallet flag.
    await s.page.waitForFunction(() => performance.getEntriesByType('resource').some((entry) => /\/PositionActions-[\w-]+\.js$/.test(entry.name)));
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

// The owner's complaint of 2026-09-25: with the RPC refusing the site's routes, a read that failed drew "No positions to
// show" for a wallet with four open positions. A failed read now says nothing about the wallet: the loading rows and one
// quiet line while it is asked again on its own (2, 5 and 10 s), one calm line if those fail too; never the empty state.
test('a read that fails is never “no positions”: the loading rows and one quiet line while it is asked again, the list and the held deposit once the chain answers, one calm line if it keeps failing, and no Retry', async () => {
  const deposit = { key: { currency0: zeroAddress, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: zeroAddress }, balance0: 0n, balance1: 100000n };
  const chain = browserChain({ positions: [onChain(OWNED_OPEN), ...OWNED_CLOSED.map((id) => closedOnChain(id))], tokens: { ...TOKENS, [USDG]: { symbol: 'USDG', decimals: 6 } }, deposits: { [OWNER]: [deposit] } });
  // The chain refuses the page's first two reads, then answers.
  let refusals = 0;
  chain.outage = (call) => (call.method === 'eth_blockNumber' && ++refusals <= 2 ? 500 : null);
  const site = siteRoutes();
  const read = createReadStub();
  const s = await scenario({ chain, routes: [site.route, (request, url) => read.handle(request, url)] });
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    await recordList(s.page);
    await connectWallet(s.page);

    // Refused: the loading rows stay, with one quiet line; the reason is a data attribute only.
    const again = s.page.locator('[data-owned="retrying"]');
    await again.waitFor();
    assert.equal(await again.locator('[data-owned-note]').innerText(), 'Reading your positions from the chain…');
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
    assert.equal(await unread.locator('[data-owned-note]').innerText(), 'Your positions couldn’t be read right now.');
    assert.equal(await unread.getAttribute('data-owned-reason'), 'chain_unavailable');
    const after = await listSeen(s.page);
    assert.ok(after.every((what) => /^(?:ready|loading|retrying:rereading|unlisted:unread)$/.test(what)), `never an empty state: ${after.join(' → ')}`);
    assert.equal(await s.page.locator('[data-owned] [data-empty]').count(), 0, 'no empty state in the card');
    assert.equal(await s.page.getByRole('button', { name: /^(Retry|Refresh|Try again|Read again)$/ }).count(), 0, 'and no Retry');
    assert.doesNotMatch(await s.page.locator('main').innerText(), /No positions/);
    assert.deepEqual(site.asked, [], 'no route of the site is asked');
    assert.deepEqual(await kept(s.page), [], 'nothing about positions is kept in the browser');
    assert.deepEqual(s.wallet.state.signed, [], 'nothing was signed');
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
test('a position’s page offers Add to this pool only for a pool with no hooks and a fixed fee', async () => {
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
    assert.deepEqual(links, { [PLAIN]: ['Pool', 'Add to this pool'], [DYNAMIC]: ['Pool'] });
    assert.equal(await s.page.locator('a[data-automate-entry]').count(), 0, 'someone else’s position offers no Automate');
    await s.page.evaluate((next) => { location.hash = `#/positions/${next}`; }, HOOKED);
    const hooked = s.page.locator('[data-position-reason="hooked_pool"]');
    await hooked.waitFor({ timeout: 10_000 });
    assert.equal(await s.page.locator('.dm-pos-links a').count(), 0, 'a pool with hooks: no link');
    assert.equal(await s.page.locator('a[href^="#/new/"]').count(), 0, 'no way into New position with the dynamic-fee or hooked pool on its page');
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
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    // No wallet: the wallet's own NFT is a public page, with no actions and nothing of them downloaded.
    await open(MINE);
    assert.deepEqual(chunks, [], 'no wallet: the actions chunk is not requested');
    assert.equal(await s.page.locator('[data-position-actions]').count(), 0);
    // Connected, on someone else's NFT: still nothing.
    await open(THEIRS);
    await connectWallet(s.page);
    await s.page.waitForTimeout(500);
    assert.deepEqual(chunks, [], 'someone else’s NFT: not requested either');
    assert.equal(await s.page.locator('[data-position-actions]').count(), 0);
    // The wallet's own NFT: its actions, and their chunk.
    await open(MINE);
    await s.page.locator('.dm-pos-actions[data-position-actions]').waitFor();
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
    assert.equal(await mine.locator('[data-position-actions] a[data-automate-entry]').getAttribute('href'), `#/sequence/${OWNED_OPEN}`);
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
    const before = chain.scans(OWNER);
    await s.page.evaluate((id) => { location.hash = `#/sequence/${id}`; }, ELSEWHERE);
    await s.page.locator('main.dm-seq [data-sequence-release]').first().waitFor({ timeout: 10_000 });
    await s.page.waitForTimeout(1_000);
    assert.equal(chain.scans(OWNER) - before, 1, 'the wallet’s list was read once, and not again for an id it lacks');
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
    assert.equal(await s.page.evaluate(() => location.hash), '#/new');
    assert.equal(await s.page.locator('li[data-step="review"][data-state="current"]').count(), 1);
    // The done steps above the offer are not locked: each still opens (and leaving Review ends the offer).
    assert.deepEqual(await s.page.locator('li[data-step-done] button.dm-flow-row').evaluateAll((rows) => rows.map((row) => row.disabled)), [false, false, false]);

    // The footer's New position is the hash already open: it starts again at the first step, with nothing chosen.
    await s.page.locator('footer').getByRole('link', { name: 'New position', exact: true }).click();
    await next.waitFor({ state: 'detached', timeout: 10_000 });
    await s.page.locator('li[data-step="pool"][data-state="current"]').waitFor({ timeout: 10_000 });
    assert.equal(await s.page.evaluate(() => location.hash), '#/new', 'the same page');
    assert.equal(await s.page.locator('li[data-step-done], [data-create-position], [data-created-position]').count(), 0, 'no step done, no Create position, no offer');
    assert.ok(await s.page.evaluate(() => window.scrollY) < 200, 'at the top of the page');
    assert.equal(chain.sends.length, 1, 'nothing more was sent');

    // The position's own page: the list kept from before the mint lacks it, so it is asked once more, fresh, and Automate
    // is offered once that answer names it.
    await s.page.evaluate(() => { location.hash = '#/positions/4243'; });
    const detail = s.page.locator('[data-position-detail][data-position-id="4243"]');
    await detail.waitFor({ timeout: 30_000 });
    await detail.locator('[data-position-actions] a[data-automate-entry]').waitFor({ timeout: 20_000 });
    assert.equal(await detail.locator('[data-position-actions] a[data-automate-entry]').getAttribute('href'), '#/sequence/4243');
    assert.equal(await detail.locator('.dm-pos-chips [data-automation="plain"]').innerText(), 'Plain position');
    assert.equal(s.rpc.scans(OWNER), 2, 'the list from before the mint, then one more read');
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
    assert.match(await paused.innerText(), /^Auto-compound · Paused\s+How to switch it on$/);
    assert.equal(await paused.getByRole('link').getAttribute('href'), '#/docs/auto-compound#where-it-starts');
    assert.equal(await paused.locator('a[data-automate-entry]').count(), 0, 'no second sequence on it');
    const plain = s.page.locator(`[data-position-automation="${PLAIN}"][data-automation="plain"]`);
    await plain.locator('a[data-automate-entry]').waitFor();
    assert.equal(await plain.locator('a[data-automate-entry]').getAttribute('href'), `#/sequence/${PLAIN}`);

    await s.page.evaluate((id) => { location.hash = `#/positions/${id}`; }, OWNED_OPEN);
    const detail = s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"]`);
    await detail.waitFor({ timeout: 10_000 });
    await detail.locator('[data-position-actions] a[data-automate-docs]').waitFor({ timeout: 10_000 });
    assert.equal(await detail.locator('.dm-pos-chips [data-automation="compound"]').innerText(), 'Auto-compound · Paused');
    assert.deepEqual(await detail.locator('[data-position-actions] a').evaluateAll((links) => links.map((a) => [a.textContent, a.getAttribute('href')])), [['How to switch it on', '#/docs/auto-compound#where-it-starts']]);
    assert.doesNotMatch(await detail.innerText(), FORBIDDEN);
    // Read by the page from the chain: the subscribers, then the vault's factory check, root, policy and permission.
    const reads = chain.log.filter((call) => call.method === 'eth_call').map((call) => call.params[0].data);
    assert.ok(reads.some((data) => data.includes('16a24131')), 'the subscriber of each NFT');
    assert.ok(reads.some((data) => data.includes('652b9b41') && data.includes('0505c8c9')), 'and the vault, once');
    assert.deepEqual([site.asked, chain.missing, chain.refused], [[], [], []], 'no route of the site; nothing but the reads');
    assert.deepEqual(s.wallet.state.signed, [], 'nothing was signed');
  } finally { await s.close(); }
});

// 2026-09-25: the fees history through the page's own chain reads in the browser: the replay worker reads the logs from
// the RPC itself, under its own CSP (functions/_middleware.ts WORKER_CSP, served by the test server as in production),
// and the card is drawn only because the replay equals the chain's unclaimed fees. The chain is the recorded one of NFT
// 3136705 (tests/support/fees/case-chain.mjs), and no route of the site is asked.
test('a position’s fees history is read from the chain by the page and its worker, and drawn once the replay equals the chain’s unclaimed fees', async () => {
  const chain = caseChain('3136705');
  const site = siteRoutes();
  const s = await scenario({ chain, routes: [site.route] });
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    await s.page.evaluate(() => { location.hash = '#/positions/3136705'; });
    await s.page.locator('[data-position-detail][data-position-id="3136705"]').waitFor({ timeout: 15_000 });
    const card = s.page.locator('[data-fees-card][data-fees-state="verified"]');
    await card.first().waitFor({ timeout: 45_000 });
    const logs = chain.log.filter((call) => call.method === 'eth_getLogs');
    assert.ok(logs.some((call) => call.params[0].topics[0] === '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'), 'the NFT’s Transfer logs, read by the worker');
    assert.ok(logs.some((call) => Array.isArray(call.params[0].topics[0])), 'and the pool’s logs');
    assert.deepEqual(chain.refused, [], 'nothing but the reads');
    assert.deepEqual(site.asked, [], 'no route of the site is asked');
    await s.page.screenshot({ path: join(shots(), 'position-fees-chain.png'), fullPage: true });
  } finally { await s.close(); }
});

// Review of 2026-09-25: the fees replays ran in the visitor's browser with two requests in flight per history and four
// tries per refused call, used up the public RPC's per-address limit, and the RPC then refused the page's own list and
// position reads too (the list took 7.4 s to come back; a busy position's card loaded for minutes). Here the chain
// limits one address as the RPC does (a budget of reply bytes a reply may overdraw, refused with the allow-origin
// `*,*` a browser cannot read) and the position's pool has a long liquidity history. While it is replayed, the list and
// the position's page come back within about two seconds; once the RPC refuses the replay, the card stops loading at
// once (the band keeps the unclaimed figure) and the worker asks nothing more.
// Changed on purpose (2026-09-25, later): the page's budget is 2 MB and a probe comes first. This pool is quiet now (the
// probe lets the replay start) and its history, 1.7 MB, is read for a while under the budget.
test('while a busy history is replayed the list and the position’s page come back at once, and a refusal ends the replay instead of a card loading for minutes', async () => {
  const history = busyHistory({ tokenId: OWNED_OPEN, key: STUB_KEY, owner: OWNER, perEpoch: 200 });
  const chain = browserChain({ positions: [onChain(OWNED_OPEN)], tokens: TOKENS, history, limit: { capacity: 256 * 1024, perSecond: 400 * 1024 } });
  const site = siteRoutes();
  const s = await scenario({ chain, routes: [site.route] });
  // The pool's epochs: Initialize, ModifyLiquidity and ProtocolFeeUpdated (the probe asks five kinds, the swap days two).
  const poolLogs = () => chain.log.filter((call) => call.method === 'eth_getLogs' && Array.isArray(call.params[0].topics[0]) && call.params[0].topics[0].length === 3).length;
  const within = async (what, locator, ms) => {
    const started = Date.now();
    await locator.waitFor({ timeout: 15_000 });
    const took = Date.now() - started;
    assert.ok(took < ms, `${what} in ${took} ms`);
    return took;
  };
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    await connectWallet(s.page);
    await s.page.locator('[data-owned="ready"]').waitFor({ timeout: 15_000 });

    // The position's page: its state at once, then its fees card loading while the worker reads the pool's epochs.
    await s.page.evaluate((id) => { location.hash = `#/positions/${id}`; }, OWNED_OPEN);
    await s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"]`).waitFor({ timeout: 15_000 });
    await s.page.locator('[data-fees-card][data-fees-state="loading"]').waitFor({ timeout: 15_000 });
    for (let i = 0; i < 150 && poolLogs() < 3; i++) await new Promise((done) => setTimeout(done, 100));
    assert.ok(poolLogs() >= 3, 'the pool’s epochs are being read');

    // Back to the list, and to the position again, while its epochs are still read: each within about two seconds.
    await s.page.evaluate(() => { location.hash = '#/positions'; });
    const listed = await within('the list', s.page.locator('[data-owned="ready"]'), 2_500);
    await s.page.evaluate((id) => { location.hash = `#/positions/${id}`; }, OWNED_OPEN);
    const shown = await within('the position’s page', s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"]`), 2_500);
    const readBefore = poolLogs();
    await s.page.locator('[data-fees-card][data-fees-state="loading"]').waitFor({ timeout: 5_000 });
    for (let i = 0; i < 100 && poolLogs() === readBefore; i++) await new Promise((done) => setTimeout(done, 100));
    assert.ok(poolLogs() > readBefore, `the replay went on meanwhile (list ${listed} ms, page ${shown} ms)`);
    // Paced by bytes (changed on purpose, 2026-09-25: a pool's epochs may be asked in capped tenths, small replies a few
    // milliseconds apart within the lane's burst): the worker's pool log reads never ran ahead of the lane's burst and
    // rate (lib/chain/browser.ts LANE_PACE), by more than the one reply that may overdraw it.
    const reads = chain.log.filter((call) => call.method === 'eth_getLogs' && Array.isArray(call.params[0].topics[0]) && call.params[0].topics[0].length === 3);
    let read = 0;
    for (const [i, call] of reads.entries()) {
      const allowed = LANE_PACE.burstBytes + (LANE_PACE.bytesPerSecond * (call.at - reads[0].at)) / 1000 + Math.max(0, ...reads.slice(0, i).map((r) => r.bytes));
      assert.ok(read <= allowed, `read ${read} B before call ${i} at +${call.at - reads[0].at} ms: over the lane's pace (${Math.round(allowed)} B)`);
      read += call.bytes;
    }
    assert.ok(reads.every((call) => call.bytes < 256 * 1024), `no large reply: ${Math.max(...reads.map((call) => call.bytes))} B at most`);

    // The RPC starts refusing this address. The replay ends at the first refusal: no card left loading, nothing asked
    // again by the worker, and the band still shows the chain's unclaimed fees.
    const refusedBefore = chain.refusals.length;
    chain.limit = { capacity: 256 * 1024, perSecond: 1, tokens: -1 };
    const stopped = Date.now();
    await s.page.waitForFunction(() => document.querySelectorAll('[data-fees-card][data-fees-state="loading"]').length === 0, null, { timeout: 10_000 });
    const took = Date.now() - stopped;
    assert.ok(took < 5_000, `the card stopped loading ${took} ms after the first refusal`);
    await new Promise((done) => setTimeout(done, 3_000));
    const refused = chain.refusals.slice(refusedBefore);
    assert.equal(refused.length, 1, `one refused request, and nothing asked again: ${refused.map((r) => r.method).join(', ')}`);
    assert.match(await s.page.locator('[data-position-stats]').innerText(), /UNCLAIMED FEES\s+[\d.,]+ ETH/);
    assert.equal(await s.page.locator('[data-fees-card]').count(), 0, 'the band shows the unclaimed figure: no card repeats it');

    // The RPC lets this address in again: the list is read at once.
    chain.limit = null;
    await s.page.evaluate(() => { location.hash = '#/positions'; });
    await within('the list after the refusals', s.page.locator('[data-owned="ready"]'), 2_500);
    assert.deepEqual(site.asked, [], 'no route of the site is asked');
  } finally { await s.close(); }
});

// Changed on purpose (2026-09-25, review of r3/chain, option a): the Positions list replays no fees history. Its
// aggregate card replayed every open position's history from the visitor's own browser, which the public RPC's
// per-address limit could not bear (PONS/USDG's history is over 60 MB), and its refusals then held back the list's own
// reads. Each row shows its unclaimed fees from the list's read; no Transfer or pool log is asked, and no Fees card.
test('the list replays no fees history: each row shows its unclaimed fees from the list’s read, no log is asked, and no Fees card', async () => {
  const usdgKey = (fee) => ({ currency0: zeroAddress, currency1: USDG, fee, tickSpacing: 60, hooks: zeroAddress });
  const chain = browserChain({ positions: [onChain('5', { key: usdgKey(3000), unclaimed: [0n, 2_500_000n] }), onChain('7', { key: usdgKey(500) })], tokens: { [USDG]: { symbol: 'USDG', decimals: 6 } } });
  const site = siteRoutes();
  const s = await scenario({ chain, routes: [site.route] });
  const workers = [];
  s.page.on('worker', (worker) => workers.push(worker.url()));
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    await connectWallet(s.page);
    await s.page.locator('[data-owned="ready"]').waitFor({ timeout: 15_000 });
    assert.deepEqual((await s.page.getByRole('tab').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()), ['Open 2', 'Closed 0']);
    assert.match(await s.page.locator('a[data-position-row="5"]').innerText(), /2\.5 USDG|\$2\.50/, 'the row’s unclaimed fees, from the list’s read');
    await new Promise((done) => setTimeout(done, 3_000));
    const logs = chain.log.filter((call) => call.method === 'eth_getLogs' && call.params[0].topics?.[0] !== SETUP_MINTED_TOPIC);
    assert.deepEqual(logs, [], 'no Transfer, pool or swap log: nothing is replayed for the list');
    assert.deepEqual(workers, [], 'no replay worker is created');
    assert.equal(await s.page.locator('[data-fees-card]').count(), 0, 'and no Fees card');
    assert.deepEqual(site.asked, [], 'no route of the site is asked');
  } finally { await s.close(); }
});

// 2026-09-25 (the owner's positions must never go missing again): a position in a pool busy now (PONS/USDG's history is
// over 60 MB) can never verify in a browser. Its page probes the pool's last minutes before reading any of its
// history, and stops there: no pool epoch is read, the card never loads for long, the band keeps the unclaimed figure,
// and the list and the page come back at once, with no refusal of the page's reads.
test('a history the probe says cannot verify is never read: no pool epoch, no card loading for long, the list and the page at once', async () => {
  const history = busyHistory({ tokenId: OWNED_OPEN, key: STUB_KEY, owner: OWNER, recent: 40 });
  const chain = browserChain({ positions: [onChain(OWNED_OPEN)], tokens: TOKENS, history, limit: { capacity: 256 * 1024, perSecond: 400 * 1024 } });
  const site = siteRoutes();
  const s = await scenario({ chain, routes: [site.route] });
  const asked = (kinds) => chain.log.filter((call) => call.method === 'eth_getLogs' && Array.isArray(call.params[0].topics[0]) && call.params[0].topics[0].length === kinds).length;
  const within = async (what, locator, ms) => {
    const started = Date.now();
    await locator.waitFor({ timeout: 15_000 });
    const took = Date.now() - started;
    assert.ok(took < ms, `${what} in ${took} ms`);
    return took;
  };
  try {
    await s.context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
    await s.page.locator('[data-empty="owned-connect"]').waitFor();
    await connectWallet(s.page);
    await within('the list', s.page.locator('[data-owned="ready"]'), 5_000);
    await s.page.evaluate((id) => { location.hash = `#/positions/${id}`; }, OWNED_OPEN);
    await within('the position’s page', s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"]`), 2_500);
    // The probe (five kinds of log) is asked, then no card is left loading, quickly.
    for (let i = 0; i < 150 && asked(5) === 0; i++) await new Promise((done) => setTimeout(done, 100));
    assert.equal(asked(5), 1, 'one probe');
    const probe = chain.log.find((call) => call.method === 'eth_getLogs' && call.params[0].topics[0].length === 5).params[0];
    assert.equal(Number(probe.toBlock) - Number(probe.fromBlock) + 1, 3_600, 'of the pool’s last 3,600 blocks, six minutes');
    await s.page.waitForFunction(() => document.querySelectorAll('[data-fees-card][data-fees-state="loading"]').length === 0, null, { timeout: 5_000 });
    await new Promise((done) => setTimeout(done, 2_000));
    assert.equal(asked(3), 0, 'no epoch of the pool’s history is read');
    assert.equal(asked(2), 0, 'nor any swap day');
    assert.match(await s.page.locator('[data-position-stats]').innerText(), /UNCLAIMED FEES\s+[\d.,]+ ETH/);
    assert.equal(await s.page.locator('[data-fees-card]').count(), 0, 'the band shows the unclaimed figure: no card repeats it, no chart');
    // Back to the list, and to the page again: each at once, and nothing of the page's was refused.
    await s.page.evaluate(() => { location.hash = '#/positions'; });
    await within('the list again', s.page.locator('[data-owned="ready"]'), 2_500);
    await s.page.evaluate((id) => { location.hash = `#/positions/${id}`; }, OWNED_OPEN);
    await within('the position’s page again', s.page.locator(`[data-position-detail][data-position-id="${OWNED_OPEN}"]`), 2_500);
    assert.deepEqual(chain.refusals, [], 'no read was refused');
    assert.deepEqual(site.asked, [], 'no route of the site is asked');
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
    assert.equal(chain.scans(OWNER), 1);
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
