import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { concatHex, encodeAbiParameters, keccak256, toFunctionSelector } from 'viem';
import { createFakeOnboarding } from './support/fake-onboarding.mjs';
import { createFakeSession } from './support/fake-session.mjs';
import { createWalletServer } from './support/wallet-server.mjs';
import { ACCOUNTS, installWallets } from './support/mock-wallet.mjs';
import { ARTWORK, walkToReview } from './support/new-position.mjs';
import { createReadStub } from './support/read-stub.mjs';
import * as runtime from '../../api-contracts/performance-v2/runtime.mjs';
import * as executionRuntime from '../../api-contracts/execution-v1/runtime.mjs';
import * as depositRuntime from '../../api-contracts/deposit-v1/runtime.mjs';

let browser;
before(async () => {
  for (const options of process.env.DOMINO_BROWSER_PATH ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }] : [{ channel: 'chrome' }, { channel: 'chromium' }, {}]) {
    try { browser = await chromium.launch({ ...options, headless: true }); break; } catch {}
  }
  if (!browser) throw new Error('A Chromium browser is required.');
});
after(async () => { await browser?.close(); });
const fixture = path => JSON.parse(readFileSync(new URL(`../../api-contracts/performance-v2/fixtures/${path}.json`, import.meta.url)));
const depositFixture = path => JSON.parse(readFileSync(new URL(`../../api-contracts/deposit-v1/fixtures/${path}.json`, import.meta.url)));
const statusWire = JSON.parse(readFileSync(new URL('../../api-contracts/execution-v1/fixtures/status-wire.json', import.meta.url)));
const OWNER = ACCOUNTS[0].address.toLowerCase();
const json = (body, status, headers) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
/** What the product rules keep off these screens. "Not connected" pills driven by ROADMAP are allowed; "not connected yet" is not. */
const FORBIDDEN = /not connected yet|not enabled|isn’t enabled|isn't enabled|aren't enabled|not available on this deployment|coming soon|in this release|\bbeta\b|\balpha\b|\bv4\b|read-only|temporarily unavailable|retry after|Last read/i;
const RELEASE_OFF = { status: 200, body: { contractVersion: '1.0.0-rc.1', chainId: 4663, available: false, deployment: null } };

async function scenario({ clock = false, routes = [] } = {}) {
  const fake = createFakeSession(); fake.admit(ACCOUNTS[0].address);
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
  const wallet = await installWallets(context);
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${origin}/#/app`);
  return { page, origin, fake, calls, executions, releases, deposits, wallet, context, set(patch) { Object.assign(state, patch); }, async close() {
    await context.close(); await server.closeAll(); assert.deepEqual(errors, []); assert.deepEqual(wallet.state.csp, []); assert.deepEqual(wallet.state.refused, []);
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
    await s.page.clock.fastForward('10:00');
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

test('setup reads its release on mount, asks for sign-in, and makes no deposit request or wallet transaction by merely opening the screen', async () => {
  const s = await scenario(); const depositCalls = [];
  s.page.on('request', request => { if (request.url().includes('/api/deposit/')) depositCalls.push(request.url()); });
  try {
    await s.page.goto(`${s.origin}/#/setup`);
    await s.page.getByText('Sign in with your wallet to prepare a deposit or view its receipts.', { exact: true }).waitFor();
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
    await rows.nth(1).waitFor();
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

// Changed on purpose (qa:visual, dead ends): without a release or a saved profile the Owner controls card promised actions it had no control
// for, on the page Automate's primary way in opens. One plain muted line says there is nothing to manage instead, why in its data and title.
test('sequence is reachable from Automate, reads its release on mount with no wallet, and without one or a saved profile says in one plain line that there is nothing to manage', async () => {
  const s = await scenario();
  try {
    // The way into sequences lives on Automate (DESIGN.md E.6), where wallet builds render its link.
    await s.page.goto(`${s.origin}/#/automate`);
    await s.page.getByRole('link', {name:'Create or manage a sequence'}).click();
    await s.page.getByRole('heading', {name:'Your sequences',exact:true}).waitFor();
    const line = s.page.locator('[data-sequence-release="unavailable"][data-sequence-release-reason="release_not_available"]');
    await line.waitFor();
    assert.deepEqual(s.releases, [{ path: '/api/setup/v1/sequence-release', method: 'GET', contract: '1.0.0-rc.1' }], 'one public GET on mount');
    assert.deepEqual([await line.evaluate(el => el.tagName), await line.innerText(), await line.getAttribute('data-recovery-profile'), await line.getAttribute('title')],
      ['P', 'No sequence to manage here.', 'none', 'Sequence deployment unavailable: release not available.']);
    assert.match(await line.getAttribute('class'), /\btext-fg-muted\b/, 'a muted line, not a card or a panel');
    assert.equal(await s.page.getByRole('heading', {name:'Owner controls'}).count(), 0, 'no card that promises controls it has none of');
    const text = await s.page.locator('main').innerText();
    assert.doesNotMatch(text, /Pause, revoke permissions|\byet\b/i, 'nothing promised');
    assert.doesNotMatch(text, /Create a paused sequence|Network budget|not available|not connected|No approval or transaction was requested/i);
    assert.doesNotMatch(text, FORBIDDEN);
    assert.equal(await s.page.getByRole('button', {name:'Read my sequences'}).count(), 0, 'no saved profile: nothing to read');
    await noManualReads(s.page.locator('main'));
    const screenshots=resolve(import.meta.dirname,'../.test-artifacts');mkdirSync(screenshots,{recursive:true});
    await s.page.screenshot({path:join(screenshots,'p2-sequence-off.png'),fullPage:true});
    assert.equal(s.wallet.state.signed.length,0);assert.deepEqual(s.wallet.state.refused,[]);
  } finally {await s.close();}
});

test('a refused or failing release (403, 404, 503) is treated like available:false, and a saved profile keeps the owner recovery path', async () => {
  const s = await scenario();
  const address = (n) => `0x${n.toString(16).padStart(2, '0').repeat(20)}`;
  const hash = (n) => `0x${n.toString(16).padStart(2, '0').repeat(32)}`;
  const implementation = address(0x12);
  const saved = { contractVersion: '1.0.0-rc.1', chainId: 4663, available: true, deployment: {
    factory: address(0x11), implementation, poolManager: address(0x13), positionManager: address(0x14), stateView: address(0x15), readHelper: address(0x16), engine: address(0x17), routing: address(0x18), priceGuard: address(0x19),
    serviceFeeRecipient: address(0x1a), operator: address(0x1b), pricePublisher: address(0x1c), serviceFeeBps: 200, expiresAt: 1,
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
    await s.page.evaluate((value) => localStorage.setItem('domino.sequence.public-recovery.v1', JSON.stringify(value)), saved);
    await s.page.goto(`${s.origin}/#/sequence`); await s.page.reload();
    const controls = s.page.locator('[data-sequence-release="unavailable"][data-recovery-profile="saved"]');
    await controls.waitFor();
    await controls.getByRole('button', {name:'Read my sequences'}).waitFor();
    assert.equal(await s.page.getByRole('heading', {name:'Create a paused sequence'}).count(), 0, 'a saved profile never brings creation back');
    assert.ok(s.releases.every(call => call.method === 'GET'));
    assert.equal(s.wallet.state.signed.length, 0); assert.deepEqual(s.wallet.state.refused, [], 'mounting asked the wallet for nothing');
  } finally { await s.close(); }
});

// ---- New position to Setup: the verified choices as a pre-filled deposit draft (G9) ----

test('Continue in Setup carries the verified choices as a pre-filled deposit draft, in memory, for the signed-in session only, and sends nothing until Create (G9)', async () => {
  const read = createReadStub();
  const s = await scenario({ routes: [(request, url) => read.handle(request, url)] });
  await s.context.route(ARTWORK, route => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  s.set({ deposit: () => deposit({ error: 'route_not_available' }, 404) });
  const dialog = s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
  try {
    await login(s.page);
    await s.page.goto(`${s.origin}/#/new`);
    await walkToReview(s.page);
    // This server has no onboarding service: the amounts stay a dash, with why on the section, and nothing blocks the way on.
    await s.page.locator('section[data-stage="balance"][data-preview="off"][data-preview-reason="feature_unavailable"]').waitFor({ timeout: 30_000 });
    assert.equal(await s.page.locator('#create-reason').innerText(), 'Setup opens with this pool, range and amount filled in. Nothing is sent until you create the draft there.');
    assert.doesNotMatch(await s.page.locator('main').innerText(), /carried over|Request details|"chainId"/);
    assert.deepEqual(s.deposits, [], 'New position sends nothing to the deposit service');

    await s.page.getByRole('link', { name: 'Continue in Setup', exact: true }).click();
    const draft = s.page.locator('form[data-setup-draft="new-position"]');
    await draft.waitFor();
    assert.match(await draft.innerText(), /Token 0: 0x0000000000000000000000000000000000000000\s+Token 1: 0x1111111111111111111111111111111111111111/);
    assert.match(await draft.innerText(), /Filled in from New position\. Enter the budgets and network limits, then create the draft\. Nothing is sent before that\./);
    const field = (label, control = 'input') => draft.locator('label', { hasText: label }).locator(control);
    assert.equal(await field('Input amount is in', 'select').inputValue(), '1', 'the deposit token is the pool’s token 1');
    for (const [label, value] of [['Input amount (smallest token units)', '1000000'], ['Lower tick', '-3600'], ['Upper tick', '4080'], ['Slippage limit (basis points)', '50'], ['Maximum token 0 spend (smallest units)', ''], ['Maximum token 1 spend (smallest units)', ''], ['Maximum gas units', '']]) {
      assert.equal(await field(label).inputValue(), value, label);
    }
    await s.page.waitForTimeout(500);
    assert.deepEqual(s.deposits.map(call => call.route), ['list'], 'filling in the draft sends nothing: only the list Setup reads for any signed-in visit');
    const kept = await s.page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + location.href);
    assert.doesNotMatch(kept, /1000000|-3600|4080|0911afcb/, 'the choices live in memory only: never storage or the URL');
    assert.doesNotMatch(await s.page.locator('main').innerText(), FORBIDDEN);

    // Any session change clears them: signed out and in again, Setup starts from an empty draft.
    await s.page.locator('header [aria-haspopup="dialog"]').click();
    await dialog.getByRole('button', { name: 'Sign out', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
    await s.page.getByText('Sign in with your wallet to prepare a deposit or view its receipts.', { exact: true }).waitFor();
    await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await s.page.keyboard.press('Escape');
    await s.page.locator('[data-deposits]').waitFor();
    assert.equal(await s.page.locator('form[data-setup-draft]').count(), 0, 'nothing carried survives a session change');
    await s.page.goto(`${s.origin}/#/automate`);
    await s.page.goto(`${s.origin}/#/setup`);
    await s.page.locator('[data-deposits]').waitFor();
    assert.equal(await s.page.locator('form[data-setup-draft]').count(), 0, 'nor a visit after it');
    assert.equal(s.deposits.filter(call => call.route === 'create').length, 0, 'no deposit draft was created');
    assert.equal(s.wallet.state.signed.length, 2, 'the two sign-in signatures only');
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
    [toFunctionSelector('operation(bytes32)')]: encodeFunctionResult({ abi: operationAbi, functionName: 'operation', result: operation }) };
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

// ---- G13 receipt identity and status refresh; G16 Start tracking from owned sequences ---------------------------

import { decodeFunctionData, encodeFunctionResult, parseAbi, parseAbiParameters, stringToHex, zeroAddress } from 'viem';

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
    assert.deepEqual(await receipts.locator('a').evaluateAll(links => links.map(link => link.getAttribute('href'))), ['#/sequence'], 'no external link: the one link is the way to pause');

    const cell = (currency, field) => done.locator(`[data-receipt-currency="${currency}"] [data-source-field="${field}"] dd`);
    await cell(TOKEN, 'grossOriginalConsumedRaw').getByText('1.5 TOKEN', { exact: true }).waitFor({ timeout: 30_000 });
    assert.deepEqual([await cell(TOKEN, 'serviceFeeRaw').innerText(), await cell(TOKEN, 'originalAfterRaw').innerText(), await cell(TOKEN, 'grossOriginalConsumedRaw').locator('span').getAttribute('title')], ['0.03 TOKEN', '0.25 TOKEN', "1,500,000 in the token's smallest units."]);
    await done.locator(`[data-receipt-currency="${UNKNOWN}"] [data-amount-reason="decimals_unavailable"]`).first().waitFor({ timeout: 30_000 });
    assert.deepEqual([await cell(UNKNOWN, 'grossOriginalConsumedRaw').innerText(), await cell(UNKNOWN, 'grossOriginalConsumedRaw').locator('span').getAttribute('title')], ['—', "Token decimals unavailable. 42 in the token's smallest units."]);
    assert.deepEqual([...asked].sort(), [TOKEN, UNKNOWN], 'one token read per currency, through the read path');

    assert.equal(await open.getAttribute('data-execution-can-cancel'), 'true');
    assert.match(await open.innerText(), /A transaction slot is reserved\. Nothing has been sent\.\s+It can still be stopped: pause your sequence before it is signed\./);
    assert.equal(await open.getByRole('link', { name: 'Pause the sequence', exact: true }).getAttribute('href'), '#/sequence');
    assert.deepEqual([await done.getAttribute('data-execution-can-cancel'), await done.getByRole('link').count()], ['false', 0]);
    const text = await receipts.innerText();
    assert.doesNotMatch(text, FORBIDDEN); assert.doesNotMatch(text, /_/, 'no code is printed');
    await noManualReads(receipts);
    await s.page.screenshot({ path: join(shots(), 'p2-receipt-identity.png'), fullPage: true });

    assert.deepEqual(sent.map(call => call.path), ['/api/execution/v1/list'], 'only the page so far');
    await s.page.clock.fastForward('00:31');
    await receipts.locator(`[data-execution-intent="${reserved.intentId}"][data-execution-state="signing"]`).waitFor();
    assert.deepEqual(sent.map(call => [call.path, call.body, Boolean(call.csrf)]), [['/api/execution/v1/list', { afterIntentId: null, limit: 10 }, true], ['/api/execution/v1/status', { intentId: reserved.intentId }, true]]);
    assert.equal(await open.getByRole('link', { name: 'Pause the sequence' }).count(), 0, 'signed: no longer offered as stoppable');
    assert.deepEqual(await receipts.locator('[data-execution-intent]').evaluateAll(cards => cards.map(card => card.getAttribute('data-execution-intent'))), [reserved.intentId, finalized.intentId], 'replaced where it stands');
    assert.equal(s.wallet.state.signed.length, 1, 'only the login signature');
  } finally { await s.close(); }
});

const chainAbi = parseAbi([
  'struct Policy { uint16 serviceFeeBps; uint16 triggerDistanceBps; uint16 maxOverlapBps; uint32 minimumIntervalSeconds; uint8 maxPositions; uint64 version; bool paused; }',
  'struct Position { bool known; bool active; bool isRoot; uint256 parentTokenId; uint64 generation; int24 tickLower; int24 tickUpper; bytes32 registrationBaselineId; bytes32 identity; bytes32 source0; bytes32 source1; }',
  'function implementation() view returns(address)', 'function implementationCodeHash() view returns(bytes32)', 'function poolManager() view returns(address)', 'function positionManager() view returns(address)',
  'function stateView() view returns(address)', 'function serviceFeeRecipient() view returns(address)', 'function factory() view returns(address)', 'function implementationVersion() view returns(uint64)',
  'function readHelper() view returns(address)', 'function executionEngine() view returns(address)', 'function nextOwnerNonce(address) view returns(uint256)', 'function vaultForSequence(bytes32) view returns(address)',
  'function isVault(address) view returns(bool)', 'function owner() view returns(address)', 'function sequenceId() view returns(bytes32)', 'function policy() view returns(Policy)', 'function rootTokenId() view returns(uint256)',
  'function operator() view returns(address)', 'function rootPermissionValid() view returns(bool)', 'function baseCurrency() view returns(address)', 'function quoteCurrency() view returns(address)',
  'function stateNonce() view returns(uint64)', 'function position(uint256) view returns(Position)', 'function successorOf(uint256) view returns(uint256)', 'function activePositions() view returns(uint256)',
]);

/**
 * A chain with a published sequence deployment and `roots.length` sequences created by `owner`, answered only for
 * the reads the sequence client makes. Anything else is refused as a non-read, and every method asked is logged.
 */
function fakeSequenceChain(owner, { roots, chains = {} }) {
  const at = (byte, bytes = 20) => `0x${byte.toString(16).padStart(2, '0').repeat(bytes)}`, zero = at(0, 32);
  const cloneOf = implementation => concatHex(['0x363d3d373d3d3d363d73', implementation, '0x5af43d82803e903d91602b57fd5bf3']);
  const implementation = at(0x42), factoryCode = '0x6001', implementationCode = '0x6002';
  const deployment = { factory: at(0x41), implementation, poolManager: at(0x43), positionManager: at(0x44), stateView: at(0x45), readHelper: at(0x46), engine: at(0x47), routing: at(0x48), priceGuard: at(0x49),
    serviceFeeRecipient: at(0x4a), operator: at(0x4b), pricePublisher: at(0x4c), serviceFeeBps: 200, expiresAt: 4_000_000_000,
    codeHashes: { factory: keccak256(factoryCode), implementation: keccak256(implementationCode), poolManager: at(0x53, 32), positionManager: at(0x54, 32), stateView: at(0x55, 32), readHelper: at(0x56, 32),
      engine: at(0x57, 32), routing: at(0x58, 32), priceGuard: at(0x59, 32), vault: keccak256(cloneOf(implementation)) } };
  const typeHash = keccak256(stringToHex('DominoSequence(uint256 chainId,address factory,address owner,uint256 nonce)'));
  const initHash = keccak256(concatHex(['0x3d602d80600a3d3981f3', cloneOf(implementation)]));
  const vaults = new Map(roots.map((root, nonce) => {
    const id = keccak256(encodeAbiParameters(parseAbiParameters('bytes32,uint256,address,address,uint256'), [typeHash, 4663n, deployment.factory, owner, BigInt(nonce)]));
    return [`0x${keccak256(concatHex(['0xff', deployment.factory, id, initHash])).slice(-40)}`, { id, root, chain: chains[nonce] ?? [] }];
  }));
  const position = (known, active, isRoot, parentTokenId) => ({ known, active, isRoot, parentTokenId, generation: 0n, tickLower: -60, tickUpper: 60, registrationBaselineId: zero, identity: zero, source0: zero, source1: zero });
  function answer(to, name, args) {
    const shared = { poolManager: deployment.poolManager, positionManager: deployment.positionManager, stateView: deployment.stateView, serviceFeeRecipient: deployment.serviceFeeRecipient };
    if ((to === deployment.factory || to === implementation) && name in shared) return shared[name];
    if (to === deployment.factory) {
      const answers = { implementation, implementationCodeHash: deployment.codeHashes.implementation, nextOwnerNonce: BigInt(roots.length) };
      if (name in answers) return answers[name];
      if (name === 'vaultForSequence') return [...vaults].find(([, vault]) => vault.id === args[0])?.[0] ?? zeroAddress;
      if (name === 'isVault') return vaults.has(args[0].toLowerCase());
    }
    if (to === implementation) {
      const answers = { factory: deployment.factory, implementation, implementationVersion: 4n, readHelper: deployment.readHelper, executionEngine: deployment.engine };
      if (name in answers) return answers[name];
    }
    const vault = vaults.get(to);
    if (vault) {
      const index = id => vault.chain.findIndex(member => member.id === id);
      const answers = { owner, sequenceId: vault.id, rootTokenId: vault.root, operator: deployment.operator, rootPermissionValid: true, baseCurrency: at(0x61), quoteCurrency: at(0x62), stateNonce: 1n,
        policy: { serviceFeeBps: 200, triggerDistanceBps: 500, maxOverlapBps: 2000, minimumIntervalSeconds: 60, maxPositions: 3, version: 1n, paused: false },
        activePositions: BigInt(1 + vault.chain.filter(member => member.active).length) };
      if (name in answers) return answers[name];
      if (name === 'position') return args[0] === vault.root ? position(true, true, true, 0n) : index(args[0]) === -1 ? position(false, false, false, 0n)
        : position(true, vault.chain[index(args[0])].active, false, index(args[0]) === 0 ? vault.root : vault.chain[index(args[0]) - 1].id);
      if (name === 'successorOf') return args[0] === vault.root ? vault.chain[0]?.id ?? 0n : index(args[0]) === -1 ? 0n : vault.chain[index(args[0]) + 1]?.id ?? 0n;
    }
    throw new Error(`unexpected ${name} on ${to}`);
  }
  const log = [];
  async function request(method, params) {
    log.push(method);
    try {
      if (method === 'eth_getBlockByNumber') return { result: { number: '0x10', hash: at(0xbb, 32) } };
      if (method === 'eth_getCode') {
        const target = String(params[0]).toLowerCase();
        return { result: target === deployment.factory ? factoryCode : target === implementation ? implementationCode : vaults.has(target) ? cloneOf(implementation) : '0x' };
      }
      if (method === 'eth_call') {
        const { functionName, args = [] } = decodeFunctionData({ abi: chainAbi, data: params[0].data });
        return { result: encodeFunctionResult({ abi: chainAbi, functionName, result: answer(String(params[0].to).toLowerCase(), functionName, args) }) };
      }
      return { error: { code: 4200, message: `${method} is not a read` } };
    } catch (error) {
      return { error: { code: -32000, message: String(error) } };
    }
  }
  return { log, request, vaults: [...vaults.keys()], release: { contractVersion: '1.0.0-rc.1', chainId: 4663, available: true, deployment } };
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
