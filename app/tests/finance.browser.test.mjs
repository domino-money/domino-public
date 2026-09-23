import { jump } from './support/clock.mjs';
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
import { FIXTURE_TOKEN, createReadStub } from './support/read-stub.mjs';
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
    await s.page.getByRole('link', {name:'Set up Domino-compound'}).click();
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

/**
 * A browser wallet on Robinhood Chain that is also the chain behind a published setup deployment, for Create position.
 * It connects and never signs in: personal_sign is outside its set, so a sign-in attempt would be refused and recorded
 * like any other stray method. It answers the reads the deployment is verified with, the gas price, the wallet's
 * balances, the token's allowance, the nonce, simulation and balance reads a step is prepared with, and the
 * transaction, receipt and block reads a sent step is followed by. Every transaction it is handed is included in its
 * own block, all of them finalized (with `finality: 'lagging'`, none: the finalized block stays behind them all, as an
 * L2's does behind L1), and its state moves as the contract's would: an approval sets the allowance,
 * `open` records the funded operation under the id it named and counts the owner's nonce up, `mint` closes it with the
 * NFT `tokenId`, `cancel` closes it with its balances refunded. `seed` puts an operation on chain before the page
 * opens; `decline(name)` makes the wallet refuse, with 4001, the next transaction that calls `name`; `revert(name)` includes
 * it with status 0 and no effect.
 */
function fakeDepositChain(owner, { tokenId = 4242n, balances = {}, finality = 'final' } = {}) {
  const at = (byte, bytes = 20) => `0x${byte.toString(16).padStart(2, '0').repeat(bytes)}`;
  const setup = at(0x71), poolManager = at(0x72), positionManager = at(0x73), stateView = at(0x74), feeRecipient = at(0x75);
  const code = { [setup]: '0x6071', [poolManager]: '0x6072', [positionManager]: '0x6073', [stateView]: '0x6074' };
  const deployment = { setup, setupCodeHash: keccak256(code[setup]), poolManager, positionManager, stateView, poolManagerCodeHash: keccak256(code[poolManager]),
    positionManagerCodeHash: keccak256(code[positionManager]), stateViewCodeHash: keccak256(code[stateView]), feeRecipient, feeBps: 30, tariffVersion: '1', expiresAt: Math.floor(Date.now() / 1000) + 86_400 };
  const FINALIZED = { number: finality === 'lagging' ? '0x1' : '0x100', hash: at(0xbf, 32) };
  const lower = value => String(value).toLowerCase();
  const operationId = nonce => keccak256(encodeAbiParameters(parseAbiParameters('uint256,address,address,uint64'), [4663n, setup, owner, nonce]));
  const NONE = { owner: zeroAddress, key: { currency0: zeroAddress, currency1: zeroAddress, fee: 0, tickSpacing: 0, hooks: zeroAddress }, balance0: 0n, balance1: 0n, swapped: false, closed: false, tokenId: 0n };
  const operations = new Map(), allowances = new Map(), held = new Map(Object.entries(balances).map(([token, amount]) => [lower(token), amount]));
  const log = [], refused = [], missing = [], sends = [], viewed = [], declined = [];
  const refuse = new Set(), reverting = new Set(), reverted = new Set();
  let permitted = false;
  const blockOf = index => ({ number: numberToHex(0x10 + index), hash: at(0xb0 + index, 32) });
  const hashOf = index => at(0xc0 + index, 32);
  const decode = tx => decodeFunctionData({ abi: lower(tx.to) === setup ? setupChainAbi : erc20Abi, data: tx.data });
  function view(to, data) {
    if (to === stateView) {
      const { functionName } = decodeFunctionData({ abi: stateViewAbi, data });
      viewed.push(functionName);
      if (functionName === 'getSlot0') return encodeFunctionResult({ abi: stateViewAbi, functionName, result: [STUB_SQRT_PRICE, 0, 0, 3000] });
      throw new Error(`unexpected ${functionName} on the state view`);
    }
    if (to === setup) {
      const { functionName, args = [] } = decodeFunctionData({ abi: setupChainAbi, data });
      viewed.push(functionName);
      const answers = { manager: poolManager, positions: positionManager, stateView, feeRecipient, assistedFeeBps: 30, tariffVersion: 1n, ownerNonce: BigInt(operations.size),
        nextOperationId: operationId(BigInt(operations.size)), operation: operations.get(args[0]) ?? NONE, recoveryStarted: false };
      if (functionName in answers) return encodeFunctionResult({ abi: setupChainAbi, functionName, result: answers[functionName] });
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
  /** What the contracts make of a transaction once it is included. */
  function include(tx) {
    const { functionName, args } = decode(tx);
    if (lower(tx.to) !== setup) {
      if (functionName === 'approve' && lower(args[0]) === setup) allowances.set(lower(tx.to), args[1]);
      return;
    }
    if (functionName === 'open') operations.set(args[0], { owner, key: args[1], balance0: args[2], balance1: args[3], swapped: false, closed: false, tokenId: 0n });
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
        case 'eth_gasPrice': return { result: '0x5f5e100' };
        case 'eth_getTransactionCount': return { result: numberToHex(sends.length) };
        case 'eth_estimateGas': return { result: '0x186a0' };
        case 'eth_getBalance': return { result: '0xde0b6b3a7640000' };
        case 'eth_call': return { result: view(lower(params[0].to), params[0].data) };
        case 'eth_sendTransaction': {
          const { functionName } = decode(params[0]);
          if (refuse.delete(functionName)) { declined.push(functionName); return { error: { code: 4001, message: 'User rejected the request.' } }; }
          const index = sends.length; sends.push(params[0]);
          if (reverting.delete(functionName)) reverted.add(index); else include(params[0]);
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
          const index = Number(BigInt(params[0])) - 0x10;
          return { result: index >= 0 && index < sends.length ? blockOf(index) : null };
        }
      }
    } catch (error) {
      missing.push(String(error));
      return { error: { code: -32000, message: String(error) } };
    }
    refused.push(method);
    return { error: { code: 4200, message: `${method} is not supported` } };
  }
  return {
    log, refused, missing, sends, viewed, declined, request, operationId, tokenId, operations, release: { contractVersion: '1.0.0-rc.1', chainId: 4663, available: true, deployment },
    /** An operation of this owner already on chain, under the owner's next id. */
    seed(operation) { const id = operationId(BigInt(operations.size)); operations.set(id, { owner, swapped: false, closed: false, tokenId: 0n, ...operation }); return id; },
    decline(functionName) { refuse.add(functionName); },
    revert(functionName) { reverting.add(functionName); },
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
        if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code });
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
const stateViewAbi = parseAbi(['function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)']);
/** An amount with Review's default 0.5% slippage as room, rounded up: what the deposit takes of it (CreatePosition.tsx withRoom). */
const withRoom = amount => (amount * 10050n + 9999n) / 10000n;
/** The read stub's pool (support/read-stub.mjs), as the setup contract keys it: ETH against TOKEN, 0.30%, spacing 60, no hooks. */
const STUB_POOL_KEY = { currency0: zeroAddress, currency1: FIXTURE_TOKEN, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
/** The standard range the read stub's pool price (tick 0) gives New position, in ticks, as Review states it. */
const STUB_RANGE = [-3600, 4080];
/** The read stub's pool price: tick 0. */
const STUB_SQRT_PRICE = 2n ** 96n;
const lowerKey = key => ({ ...key, currency0: key.currency0.toLowerCase(), currency1: key.currency1.toLowerCase(), hooks: key.hooks.toLowerCase() });
/**
 * The read gateway's answer for the position NFT the chain above minted, once it exists: the read fixture's first
 * position (nft-positions.success), made this wallet's NFT `tokenId` in the stub's pool, at the minted range and
 * liquidity, holding what the deposit funded. Any other question keeps its fixture.
 */
const mintedPosition = (chain) => (route, body) => {
  const minted = [...chain.operations.values()].find(op => op.closed && op.tokenId !== 0n);
  if (route !== 'nft-positions' || !minted || JSON.stringify(body.tokenIds) !== JSON.stringify([String(minted.tokenId)])) return undefined;
  const [open, mint] = ['open', 'mint'].map(name => chain.decoded().find(tx => tx.functionName === name));
  const base = readGateway('nft-positions.success'), plan = mint.args[0];
  const item = { ...base.items[0], tokenId: String(minted.tokenId), owner: OWNER, salt: numberToHex(minted.tokenId, { size: 32 }), tickLower: plan.tickLower, tickUpper: plan.tickUpper,
    liquidityRaw: String(plan.liquidity), principalRaw: [String(open.args[2]), String(open.args[3])], unsettledFeesRaw: ['0', '0'], inRange: true, hasLiquidity: true };
  return JSON.stringify({ ...base, items: [item] });
};
/** Create position's step list as the page shows it: each step's key and state. */
const createSteps = page => page.locator('[data-create-steps] li').evaluateAll(items => items.map(item => [item.getAttribute('data-create-step'), item.getAttribute('data-create-step-state')]));

/**
 * The wallet-test build at New position's Review with the chain above connected on Robinhood Chain and nothing more:
 * Sign in is offered and never pressed. The release the setup client verifies is the chain's own. Resolves once
 * Create position's lazily loaded control is in (StageReview.tsx FinalControl). `answer` goes to the read stub.
 */
async function atReview(chain, { answer } = {}) {
  const read = createReadStub({ answer });
  const s = await scenario({ routes: [(request, url) => read.handle(request, url)] });
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
    await walkToReview(s.page);
    await s.page.locator('[data-create-position="idle"]').waitFor({ timeout: 30_000 });
    return Object.assign(s, { read, services });
  } catch (error) { await s.close().catch(() => {}); throw error; }
}

/** No service and no session took part, and the wallet was asked nothing outside connecting and the chain's own reads and sends. */
async function onlyTheWallet(s, chain) {
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
  const s = await atReview(chain, { answer: mintedPosition(chain) });
  const { setup } = chain.release.deployment;
  try {
    const button = s.page.locator('[data-create-position]');
    assert.equal(await button.innerText(), 'Create position');
    assert.equal(await s.page.locator('#create-reason').innerText(), 'Your wallet asks you to sign each step: an exact approval if needed, the deposit, then the position.');
    assert.equal(await s.page.getByRole('link', { name: 'Continue in Setup' }).count(), 0, 'no hand-off to Setup');
    assert.equal(await s.page.locator('[data-create-steps]').count(), 0, 'no step list before the press');
    assert.deepEqual(chain.sends, [], 'nothing is sent by arriving');
    // What Review says the position holds: the ETH the range pairs with the typed 1 TOKEN.
    const [, eth, token] = (await s.page.locator('[data-review-amounts]').innerText()).match(/^([\d.,]+) ETH \+ ([\d.,]+) TOKEN$/) ?? [];
    assert.equal(token, '1');

    await button.click();
    const list = s.page.locator('[data-create-steps]');
    await list.waitFor();
    assert.deepEqual((await createSteps(s.page)).map(([key]) => key), ['check', `approve:${FIXTURE_TOKEN}`, 'fund', 'mint'], 'one approval for the one ERC-20 (ETH needs none), the deposit, the mint');
    assert.equal(await s.page.locator('[data-create-position="running"]').innerText(), 'Creating position…');
    // Mid-flow: the balances checked, the approval included, the deposit on its way into a block.
    await s.page.locator('[data-create-step="fund"][data-create-step-state="chain"]').waitFor({ timeout: 60_000 });
    assert.deepEqual(await createSteps(s.page), [['check', 'done'], [`approve:${FIXTURE_TOKEN}`, 'done'], ['fund', 'chain'], ['mint', 'waiting']]);
    assert.match(await list.innerText(), /Approve\s+TOKEN[\s\S]*Deposit the tokens\s+Waiting for the network[\s\S]*Create the position\s+Next/);
    // The window as the person sees it, scrolled to the steps (a full-page capture draws the sticky header mid-page).
    await list.evaluate(element => element.scrollIntoView({ block: 'end' }));
    await s.page.screenshot({ path: join(shots(), 'create-position-steps.png') });

    // The mint read back closed with its NFT: the page opens that position on Positions.
    await s.page.waitForFunction(() => location.hash === '#/positions/4242', null, { timeout: 60_000 });
    await s.page.locator('#nft-ids').waitFor();
    assert.equal(await s.page.locator('#nft-ids').inputValue(), '4242', 'Positions looks up the new NFT');
    // The position read from chain: the one card is NFT 4242, in the pool chosen, at Review's range.
    const cards = s.page.locator('#chain-lookup [data-chain-cards]');
    await cards.waitFor({ timeout: 30_000 });
    assert.equal(await cards.getAttribute('data-chain-cards'), '1');
    assert.deepEqual(s.read.requests.filter(r => r.path.endsWith('/nft-positions')).map(r => JSON.parse(r.body)), [{ tokenIds: ['4242'] }], 'one read, of the new NFT');
    assert.match(await cards.innerText(), /ETH\s*\/\s*TOKEN[\s\S]*Ticks -3600 to 4080/);
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
    await onlyTheWallet(s, chain);
    assert.doesNotMatch(await s.page.locator('main').innerText(), FORBIDDEN);
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
    await s.page.waitForFunction(() => location.hash === '#/positions/4243', null, { timeout: 60_000 });
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
    assert.deepEqual(await createSteps(s.page), [['check', 'done'], [`approve:${FIXTURE_TOKEN}`, 'done'], ['fund', 'done'], ['mint', 'failed']]);
    assert.deepEqual(chain.decoded().map(tx => tx.functionName), ['approve', 'open'], 'the mint was never sent');
    assert.ok((await s.page.evaluate(() => location.hash)).startsWith('#/new'), 'still on New position');

    const refund = s.page.getByRole('button', { name: 'Refund the deposit instead', exact: true });
    await refund.click();
    await s.page.getByRole('status').filter({ hasText: 'The deposit was refunded to your wallet.' }).waitFor({ timeout: 60_000 });
    assert.deepEqual(await createSteps(s.page), [['refund', 'done']]);
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
    await s.page.waitForFunction(() => location.hash === '#/positions/4242', null, { timeout: 60_000 });
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
    assert.deepEqual((await createSteps(s.page)).find(([key]) => key === 'fund'), ['fund', 'failed'], 'the deposit is not shown as done');
    assert.equal(await s.page.locator('[data-create-notice="operation_not_owned"]').count(), 0, 'no word of another wallet');
    await s.page.getByRole('status').filter({ hasText: 'The deposit reverted on chain: nothing was deposited, only network gas was spent. Press Create position to try again.' }).waitFor({ timeout: 5_000 });
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
    assert.deepEqual(await receipts.locator('a').evaluateAll(links => links.map(link => link.getAttribute('href'))), ['#/sequence'], 'no external link: the one link is the way to pause');

    const cell = (currency, field) => done.locator(`[data-receipt-currency="${currency}"] [data-source-field="${field}"] dd`);
    await cell(TOKEN, 'grossOriginalConsumedRaw').getByText('1.5 TOKEN', { exact: true }).waitFor({ timeout: 30_000 });
    assert.deepEqual([await cell(TOKEN, 'serviceFeeRaw').innerText(), await cell(TOKEN, 'originalAfterRaw').innerText(), await cell(TOKEN, 'grossOriginalConsumedRaw').locator('span').getAttribute('title')], ['0.03 TOKEN', '0.25 TOKEN', "1,500,000 in the token’s smallest units."]);
    await done.locator(`[data-receipt-currency="${UNKNOWN}"] [data-amount-reason="decimals_unavailable"]`).first().waitFor({ timeout: 30_000 });
    assert.deepEqual([await cell(UNKNOWN, 'grossOriginalConsumedRaw').innerText(), await cell(UNKNOWN, 'grossOriginalConsumedRaw').locator('span').getAttribute('title')], ['—', "Token decimals unavailable. 42 in the token’s smallest units."]);
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
    await jump(s.page, '00:31');
    await receipts.locator(`[data-execution-intent="${reserved.intentId}"][data-execution-state="signing"]`).waitFor();
    assert.deepEqual(sent.map(call => [call.path, call.body, Boolean(call.csrf)]), [['/api/execution/v1/list', { afterIntentId: null, limit: 10 }, true], ['/api/execution/v1/status', { intentId: reserved.intentId }, true]]);
    assert.equal(await open.getByRole('link', { name: 'Pause the sequence' }).count(), 0, 'signed: no longer offered as stoppable');
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
 */
function fakeSequenceChain(owner, { roots, chains = {}, operator = null, serviceFeeBps = 400, maxPositions = 3,
  policyVersion = 1n, paused = false, limitsVersion = 1n, rootPermissionValid = true, vaultHeld = [], accounted = 0n, approved = true, settled = false }) {
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
      if (name === 'ownerOf') return held.get(args[0]) ?? owner;
      if (name === 'getPoolAndPositionInfo') return [poolKey, packedPosition];
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
    if (to === deployment.positionManager && functionName === 'approve') approvals.set(args[1], String(args[0]).toLowerCase());
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
      if (method === 'eth_getBalance') return { result: '0xde0b6b3a7640000' };
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

/**
 * The way back from a revoked operator, which this product could reach and not leave.
 *
 * `revokeOperator` sets the vault's operator to the zero address. Our own resume
 * builder then refuses with `sequence_activation_unavailable` (sequence.ts, the
 * `state.operator !== d.operator` clause) and the screen disables Review
 * activation — correctly, because resuming a vault with no operator would
 * un-pause an automation that cannot execute. But nothing offered the one
 * transaction that undoes it, so a person who revoked from this product could
 * never enable automation from it again.
 *
 * This exercises the whole path against the real component and the real builder.
 * The mock wallet refuses eth_sendTransaction by design, and logs its parameters
 * before refusing — so what WOULD be signed is read from that log, byte for byte,
 * without anything being signed.
 */
test('a revoked operator can be authorised again, and the transaction is setOperator with the deployment’s own operator', async () => {
  const s = await scenario();
  const ZERO = `0x${'00'.repeat(20)}`;
  const chain = fakeSequenceChain(OWNER, { roots: [100n], operator: ZERO });
  await s.context.exposeFunction('__dominoChainRead', (method, params) => chain.request(method, params));
  await s.context.addInitScript(() => {
    let wallet = window.__dominoWalletRequest;
    const request = (id, method, params) => ['eth_call', 'eth_getCode', 'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_estimateGas', 'eth_getBalance', 'eth_sendTransaction'].includes(method) ? window.__dominoChainRead(method, params) : wallet(id, method, params);
    Object.defineProperty(window, '__dominoWalletRequest', { configurable: true, get: () => request, set: value => { wallet = value; } });
  });
  try {
    await login(s.page);
    s.set({ sequenceRelease: { status: 200, body: chain.release } });
    await s.page.goto(`${s.origin}/#/sequence`);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');

    const main = s.page.locator('main');
    // Owner controls are their own path: the sequences are listed from the wallet first.
    await main.getByRole('button', { name: 'Read my sequences', exact: true }).click();
    await main.getByLabel('Sequence address').waitFor();
    await main.getByLabel('Sequence address').fill(chain.vaults[0]);
    await main.getByRole('button', { name: 'Read owned sequence', exact: true }).click();
    const restore = main.getByRole('button', { name: 'Review operator authorisation', exact: true });
    await restore.waitFor();

    // The dead end itself: activation cannot be reviewed while the operator is gone.
    const activation = main.getByRole('button', { name: 'Review activation', exact: true });
    if (await activation.count()) assert.equal(await activation.isDisabled(), true, 'activation stays refused until the operator is back');

    // Every owner step is bounded by the network budget, so it has to be set first.
    for (const [label, value] of [['Maximum wallet gas units', '300000'], ['Maximum fee per gas (wei)', '2000000000'],
      ['Maximum priority fee per gas (wei)', '1000000'], ['Keep native gas reserve (wei)', '0']]) {
      await main.getByLabel(label, { exact: true }).fill(value);
    }
    await s.page.waitForFunction(() => {
      const button = [...document.querySelectorAll('main button')].find((item) => item.textContent === 'Review operator authorisation');
      return Boolean(button) && !button.disabled;
    });
    await restore.click();
    const panel = main.locator('[role="region"][aria-label="Sequence wallet review"]');
    await panel.waitFor();
    const words = await panel.innerText();
    assert.match(words, /Review operator authorisation/, 'the step is named, not left as a code');
    assert.match(words, new RegExp(`Authorise operator ${chain.release.deployment.operator} to execute for root NFT #100 again\.`, 'i'), 'the address shown is the deployment’s own operator');
    assert.match(words, /The root NFT stays in your wallet/);
    assert.match(words, /no Domino service fee/, 'an owner transaction carries no service fee');
    assert.doesNotMatch(words, /0x0{40}/, 'the zero address is never offered as an operator');

    await panel.getByRole('checkbox').check();
    await panel.getByRole('button', { name: 'Send this step in wallet', exact: true }).click();
    for (let waited = 0; chain.sends.length === 0 && waited < 15000; waited += 250) await new Promise((done) => setTimeout(done, 250));
    assert.equal(chain.sends.length, 1, 'exactly one transaction was offered');
    const tx = chain.sends[0];
    assert.equal(String(tx.to).toLowerCase(), chain.vaults[0], 'sent to the sequence itself');
    const decoded = decodeFunctionData({ abi: parseAbi(['function setOperator(address next)']), data: tx.data });
    assert.equal(decoded.functionName, 'setOperator', 'one call, and it is the restoration');
    assert.deepEqual(decoded.args.map((value) => String(value).toLowerCase()), [chain.release.deployment.operator.toLowerCase()],
      'the argument is the deployment’s operator, never anything a person typed');
    assert.deepEqual([...new Set(chain.log)].sort(), ['eth_call', 'eth_estimateGas', 'eth_getBalance', 'eth_getBlockByNumber', 'eth_getCode', 'eth_getTransactionCount', 'eth_sendTransaction'],
      'reads, one simulation, one send — and nothing else');
    assert.deepEqual(s.wallet.state.refused, [], 'nothing was asked of the wallet outside its own set');
  } finally { await s.close(); }
});

test('with its operator in place a sequence is never offered the restoration', async () => {
  const s = await scenario();
  const chain = fakeSequenceChain(OWNER, { roots: [100n] });
  await s.context.exposeFunction('__dominoChainRead', (method, params) => chain.request(method, params));
  await s.context.addInitScript(() => {
    let wallet = window.__dominoWalletRequest;
    const request = (id, method, params) => ['eth_call', 'eth_getCode', 'eth_getBlockByNumber'].includes(method) ? window.__dominoChainRead(method, params) : wallet(id, method, params);
    Object.defineProperty(window, '__dominoWalletRequest', { configurable: true, get: () => request, set: value => { wallet = value; } });
  });
  try {
    await login(s.page);
    s.set({ sequenceRelease: { status: 200, body: chain.release } });
    await s.page.goto(`${s.origin}/#/sequence`);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    const main = s.page.locator('main');
    await main.getByRole('button', { name: 'Read my sequences', exact: true }).click();
    await main.getByLabel('Sequence address').waitFor();
    await main.getByLabel('Sequence address').fill(chain.vaults[0]);
    await main.getByRole('button', { name: 'Read owned sequence', exact: true }).click();
    await main.getByRole('button', { name: 'Review operator revocation', exact: true }).waitFor();
    assert.equal(await main.getByRole('button', { name: 'Review operator authorisation' }).count(), 0,
      'nothing to restore, so nothing is offered');
  } finally { await s.close(); }
});


async function openSequenceControls(s, chain) {
  await s.context.exposeFunction('__dominoChainRead', (method, params) => chain.request(method, params));
  await s.context.addInitScript(() => {
    let wallet = window.__dominoWalletRequest;
    const request = (id, method, params) => ['eth_call', 'eth_getCode', 'eth_getBlockByNumber', 'eth_getTransactionCount', 'eth_estimateGas', 'eth_getBalance', 'eth_sendTransaction', 'eth_getTransactionByHash', 'eth_getTransactionReceipt'].includes(method) ? window.__dominoChainRead(method, params) : wallet(id, method, params);
    Object.defineProperty(window, '__dominoWalletRequest', { configurable: true, get: () => request, set: value => { wallet = value; } });
  });
  await login(s.page);
  s.set({ sequenceRelease: { status: 200, body: chain.release } });
  await s.page.goto(`${s.origin}/#/sequence`);
  await s.page.reload();
  await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
  const main = s.page.locator('main');
  await main.getByRole('button', { name: 'Read my sequences', exact: true }).click();
  await main.getByLabel('Sequence address').waitFor();
  for (const [label, value] of [['Maximum wallet gas units', '300000'], ['Maximum fee per gas (wei)', '2000000000'],
    ['Maximum priority fee per gas (wei)', '1000000'], ['Keep native gas reserve (wei)', '0']]) {
    await main.getByLabel(label, { exact: true }).fill(value);
  }
  return main;
}

test('creation mode shows 2% or 4%, simple locks one position, and changing mode clears consent and the reviewed transaction', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [] });
  try {
    const main = await openSequenceControls(s, chain);
    await main.getByLabel('Root NFT ID', { exact: true }).fill('300');
    await main.getByRole('button', { name: 'Read my root NFT', exact: true }).click();
    const mode = main.getByRole('combobox', { name: /^Automation mode/ });
    await mode.waitFor();
    assert.equal(await mode.inputValue(), 'compound');
    const cap = main.getByLabel('Maximum positions, including root', { exact: true });
    assert.equal(await cap.inputValue(), '1');
    assert.equal(await cap.isDisabled(), true);
    for (const [label, value] of [['Distance to range ceiling (basis points)', '500'], ['Maximum successor overlap (basis points)', '2000'],
      ['Minimum execution interval (seconds)', '60'], ['Successor upside (basis points)', '5000'], ['Maximum swap slippage (basis points)', '100'],
      ['Maximum price impact (basis points)', '100'], ['Maximum execution gas cost (wei)', '1000000000000000'], ['Maximum observation age (seconds)', '60'], ['Forecast horizon (seconds)', '3600']]) {
      await main.getByLabel(label, { exact: true }).fill(value);
    }
    const consent = main.getByRole('checkbox', { name: /^I consent to using already uncollected fees/ });
    await consent.check();
    await main.getByRole('button', { name: 'Prepare approval or paused creation', exact: true }).click();
    const review = main.getByRole('region', { name: 'Sequence wallet review', exact: true });
    await review.waitFor();
    assert.match(await review.innerText(), /Auto-compound: 2%/);
    assert.equal(chain.simulations.at(-1).args[0].policy.serviceFeeBps, 200);
    assert.equal(chain.simulations.at(-1).args[0].policy.maxPositions, 1);
    await review.getByRole('checkbox').check();
    await mode.selectOption('domino');
    assert.equal(await review.count(), 0, 'the old reviewed step is removed');
    assert.equal(await consent.isChecked(), false, 'the changed price needs fresh consent');
    assert.equal(await main.getByRole('button', { name: 'Prepare approval or paused creation', exact: true }).isDisabled(), true);
    assert.equal(await cap.isDisabled(), false);
    await cap.fill('3');
    assert.match(await consent.locator('..').innerText(), /service fee is 4%/);
    await consent.check();
    await main.getByRole('button', { name: 'Prepare approval or paused creation', exact: true }).click();
    await review.waitFor();
    assert.match(await review.innerText(), /Domino-compound: 4%/);
    assert.equal(await review.getByRole('checkbox').isChecked(), false, 'new review needs its own acknowledgement');
    assert.equal(chain.simulations.at(-1).args[0].policy.serviceFeeBps, 400);
    assert.equal(chain.simulations.at(-1).args[0].policy.maxPositions, 3);
    assert.deepEqual(chain.missing, []);
    assert.equal(chain.sends.length, 0, 'reviewing alone never sends');
  } finally { await s.close(); }
});

test('management reads the current rate and reviews an explicit mode change; a second choice invalidates the acknowledgement', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [100n], serviceFeeBps: 200, maxPositions: 1 });
  try {
    const main = await openSequenceControls(s, chain);
    await main.getByLabel('Sequence address').fill(chain.vaults[0]);
    await main.getByRole('button', { name: 'Read owned sequence', exact: true }).click();
    await main.locator('[data-sequence-current-mode="compound"]').waitFor();
    assert.match(await main.locator('[data-sequence-current-mode]').innerText(), /Auto-compound · 2%/);
    await main.getByText('Adjust automation rules', { exact: true }).click();
    const mode = main.getByRole('combobox', { name: /^Automation mode for rule change/ });
    assert.equal(await mode.inputValue(), 'compound');
    await mode.selectOption('domino');
    for (const [label, value] of [['Distance to range ceiling (basis points)', '500'], ['Maximum successor overlap (basis points)', '2000'],
      ['Minimum execution interval (seconds)', '60'], ['Maximum positions, including root', '3']]) {
      await main.getByLabel(label, { exact: true }).fill(value);
    }
    await main.getByRole('button', { name: 'Review automation rule change', exact: true }).click();
    const review = main.getByRole('region', { name: 'Sequence wallet review', exact: true });
    await review.waitFor();
    assert.match(await review.innerText(), /New Domino-compound policy: 4%/);
    assert.equal(chain.simulations.at(-1).args[0].serviceFeeBps, 400);
    assert.equal(chain.simulations.at(-1).args[0].maxPositions, 3);
    assert.equal(chain.simulations.at(-1).args[0].paused, false, 'mode change preserves active state');
    await review.getByRole('checkbox').check();
    await mode.selectOption('compound');
    assert.equal(await review.count(), 0);
    assert.equal(await main.getByLabel('Maximum positions, including root', { exact: true }).inputValue(), '1');
    await main.getByRole('button', { name: 'Review automation rule change', exact: true }).click();
    await review.waitFor();
    assert.equal(await review.getByRole('checkbox').isChecked(), false);
    assert.match(await review.innerText(), /New Auto-compound policy: 2%/);
    assert.equal(chain.simulations.at(-1).args[0].serviceFeeBps, 200);
    assert.equal(chain.simulations.at(-1).args[0].maxPositions, 1);
    await review.getByRole('checkbox').check();
    await review.getByRole('button', { name: 'Send this step in wallet', exact: true }).click();
    await main.getByRole('heading', { name: 'Transaction receipt', exact: true }).waitFor();
    assert.equal(chain.sends.length, 1);
    const { functionName, args } = decodeFunctionData({ abi: chainAbi, data: chain.sends[0].data });
    assert.equal(functionName, 'setPolicy');
    assert.equal(args[0].serviceFeeBps, 200);
    assert.equal(args[0].maxPositions, 1);
    assert.deepEqual(chain.missing, []);
  } finally { await s.close(); }
});


test('a Domino sequence with a child cannot prepare a switch to simple mode', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [100n], chains: { 0: [{ id: 101n, active: true }] } });
  try {
    const main = await openSequenceControls(s, chain);
    await main.getByLabel('Sequence address').fill(chain.vaults[0]);
    await main.getByRole('button', { name: 'Read owned sequence', exact: true }).click();
    await main.locator('[data-sequence-current-mode="domino"]').waitFor();
    await main.getByText('Adjust automation rules', { exact: true }).click();
    await main.getByRole('combobox', { name: /^Automation mode for rule change/ }).selectOption('compound');
    for (const [label, value] of [['Distance to range ceiling (basis points)', '500'], ['Maximum successor overlap (basis points)', '2000'], ['Minimum execution interval (seconds)', '60']]) {
      await main.getByLabel(label, { exact: true }).fill(value);
    }
    await main.getByRole('button', { name: 'Review automation rule change', exact: true }).click();
    await main.locator('[data-notice-code="position_limit_below_membership"]').waitFor();
    assert.equal(await main.getByRole('region', { name: 'Sequence wallet review', exact: true }).count(), 0);
    assert.equal(chain.simulations.length, 0);
    assert.equal(chain.sends.length, 0);
    assert.deepEqual(chain.missing, []);
  } finally { await s.close(); }
});


// ---- The five owner functions that gained an interface: what the wallet would actually be asked to sign -----------

/**
 * `setPolicy`, `setExecutionLimits`, `rearmRoot`, `recoverUnmanagedPosition` and `recoverUntrackedCurrency` are owner
 * transactions this product now builds. performance.controller.test.mjs proves the closed ABI carries each signature;
 * these prove the transaction, by decoding the calldata of the one offer each step makes.
 *
 * As in the operator-authorisation case above, nothing is signed: the fake chain records eth_sendTransaction and
 * answers with a hash, so what WOULD be signed is read back byte for byte from what it recorded.
 */
const sequenceCall = (chain) => decodeFunctionData({ abi: chainAbi, data: chain.sends[0].data });

test('an automation rule change sends the whole policy struct: the four typed fields, the rest exactly as the vault reported it, and the next version', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [100n], serviceFeeBps: 400, maxPositions: 3, policyVersion: 7n, paused: true });
  try {
    const main = await openSequenceControls(s, chain);
    await main.getByLabel('Sequence address').fill(chain.vaults[0]);
    await main.getByRole('button', { name: 'Read owned sequence', exact: true }).click();
    await main.locator('[data-sequence-current-mode="domino"]').waitFor();
    await main.getByText('Adjust automation rules', { exact: true }).click();
    for (const [label, value] of [['Distance to range ceiling (basis points)', '1234'], ['Maximum successor overlap (basis points)', '777'],
      ['Minimum execution interval (seconds)', '900'], ['Maximum positions, including root', '5']]) {
      await main.getByLabel(label, { exact: true }).fill(value);
    }
    await main.getByRole('button', { name: 'Review automation rule change', exact: true }).click();
    const review = main.getByRole('region', { name: 'Sequence wallet review', exact: true });
    await review.waitFor();
    const words = await review.innerText();
    assert.match(words, /Policy version 7 to 8\./, 'the version is the vault’s own, one higher');
    assert.match(words, /this sequence stays paused/, 'the paused state is carried, never flipped here');
    assert.doesNotMatch(words, FORBIDDEN);
    await review.getByRole('checkbox').check();
    await review.getByRole('button', { name: 'Send this step in wallet', exact: true }).click();
    await main.getByRole('heading', { name: 'Transaction receipt', exact: true }).waitFor();
    assert.equal(chain.sends.length, 1, 'exactly one transaction was offered');
    assert.equal(String(chain.sends[0].to).toLowerCase(), chain.vaults[0], 'sent to the sequence itself');
    const { functionName, args } = sequenceCall(chain);
    assert.equal(functionName, 'setPolicy');
    // paused is carried straight from the chain. serviceFeeBps comes back the same value, but by a
    // round trip rather than a copy: with no mode chosen, sequence.ts:516 derives the mode from the
    // fee the vault reported and :523 maps that mode back to a fee. A fee the mapping does not know
    // refuses as invalid_sequence_policy instead of being silently rewritten. The mode-to-fee
    // mapping itself is pinned by the tests at :1037 and :1052.
    assert.deepEqual(args[0], { ...chain.policy, version: chain.policy.version + 1n, triggerDistanceBps: 1234, maxOverlapBps: 777, minimumIntervalSeconds: 900, maxPositions: 5 },
      'every field of the struct: the four typed, paused and serviceFeeBps as the chain reported them, version exactly one higher');
    assert.deepEqual(chain.missing, []);
  } finally { await s.close(); }
});

test('a safety limit change sends the whole limits struct at the next version, quotes the live values it re-read, and refuses a zero execution gas cap before anything is prepared', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [100n], limitsVersion: 5n });
  try {
    const main = await openSequenceControls(s, chain);
    await main.getByLabel('Sequence address').fill(chain.vaults[0]);
    await main.getByRole('button', { name: 'Read owned sequence', exact: true }).click();
    await main.getByText('Adjust safety limits', { exact: true }).click();
    const cap = main.getByLabel('Maximum execution gas cost (wei)', { exact: true });
    for (const [label, value] of [['Successor upside (basis points)', '7500'], ['Maximum swap slippage (basis points)', '250'],
      ['Maximum price impact (basis points)', '300'], ['Maximum execution gas cost (wei)', '0'], ['Maximum observation age (seconds)', '120'], ['Forecast horizon (seconds)', '7200']]) {
      await main.getByLabel(label, { exact: true }).fill(value);
    }
    const change = main.getByRole('button', { name: 'Review safety limit change', exact: true });
    const review = main.getByRole('region', { name: 'Sequence wallet review', exact: true });
    await change.click();
    await main.locator('[data-notice-code="invalid_sequence_policy"]').waitFor();
    assert.equal(await review.count(), 0, 'an executor with no gas to spend is refused in words, with nothing prepared');
    assert.equal(chain.sends.length, 0);

    await cap.fill('2000000000000000');
    await change.click();
    await review.waitFor();
    const words = await review.innerText();
    assert.match(words, /Successor upside 5000 to 7500 bps/, 'the current side of each pair is the vault’s, not the form’s');
    assert.match(words, /Limits version 5 to 6\./);
    assert.doesNotMatch(words, FORBIDDEN);
    await review.getByRole('checkbox').check();
    await review.getByRole('button', { name: 'Send this step in wallet', exact: true }).click();
    await main.getByRole('heading', { name: 'Transaction receipt', exact: true }).waitFor();
    assert.equal(chain.sends.length, 1);
    assert.equal(String(chain.sends[0].to).toLowerCase(), chain.vaults[0], 'sent to the sequence itself');
    const { functionName, args } = sequenceCall(chain);
    assert.equal(functionName, 'setExecutionLimits');
    assert.deepEqual(args[0], { version: chain.limits.version + 1n, upsideBps: 7500, maxSlippageBps: 250, maxPriceImpactBps: 300,
      maxGasCostWei: 2_000_000_000_000_000n, maxObservationAgeSeconds: 120, forecastHorizonSeconds: 7200 },
      'the six typed limits, and the version the vault reported plus one');
    assert.deepEqual(chain.missing, []);
  } finally { await s.close(); }
});

test('a lapsed root permission is repaired with rearmRoot, and the consent its review promises is the boolean the transaction carries', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [100n], rootPermissionValid: false });
  try {
    const main = await openSequenceControls(s, chain);
    await main.getByLabel('Sequence address').fill(chain.vaults[0]);
    await main.getByRole('button', { name: 'Read owned sequence', exact: true }).click();
    const repair = main.getByRole('button', { name: 'Review root permission repair', exact: true });
    await repair.click();
    const review = main.getByRole('region', { name: 'Sequence wallet review', exact: true });
    await review.waitFor();
    const words = await review.innerText();
    assert.match(words, /Re-establish this sequence’s permission over root NFT #100\./);
    assert.match(words, /Fees the root has not collected are consented to as part of it, exactly as at creation\./, 'what the boolean means is said before it is sent');
    assert.doesNotMatch(words, FORBIDDEN);
    await review.getByRole('checkbox').check();
    await review.getByRole('button', { name: 'Send this step in wallet', exact: true }).click();
    await main.getByRole('heading', { name: 'Transaction receipt', exact: true }).waitFor();
    assert.equal(chain.sends.length, 1);
    assert.equal(String(chain.sends[0].to).toLowerCase(), chain.vaults[0], 'sent to the sequence itself');
    const { functionName, args } = sequenceCall(chain);
    assert.equal(functionName, 'rearmRoot');
    assert.deepEqual(args, [true], 'consent is granted, never sent as false behind the sentence that promised it');
    assert.deepEqual(chain.missing, []);
  } finally { await s.close(); }
});

test('an NFT the sequence holds but does not manage is recovered by its exact token id, and a registered position is never offered that step', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [100n], chains: { 0: [{ id: 12n, active: false }, { id: 13n, active: true }] }, vaultHeld: [12n] });
  try {
    const main = await openSequenceControls(s, chain);
    await main.getByLabel('Sequence address').fill(chain.vaults[0]);
    await main.getByRole('button', { name: 'Read owned sequence', exact: true }).click();
    await main.locator('[data-sequence-current-mode="domino"]').waitFor();
    // A valid root permission is not a lapsed one, so the repair of the previous test is not among these controls.
    assert.equal(await main.getByRole('button', { name: 'Review root permission repair' }).count(), 0);
    await main.getByText('Child positions and fee reserves', { exact: true }).click();
    const read = main.getByRole('button', { name: 'Read position and earned-fee reserves', exact: true });
    const recovery = main.getByRole('button', { name: 'Review unmanaged NFT recovery', exact: true });
    await read.click();
    await main.getByRole('button', { name: 'Select successor', exact: true }).waitFor();
    assert.equal(await recovery.count(), 0, 'the registered root leaves through its own step, never as a stray NFT');

    // An active child IS offered the withdrawal. Without this, the negative below would
    // hold just as well for a button that had been renamed away, and prove nothing.
    const withdrawal = main.getByRole('button', { name: 'Review child NFT withdrawal', exact: true });
    await main.getByLabel('Root or child NFT ID', { exact: true }).fill('13');
    await read.click();
    await withdrawal.waitFor();
    assert.equal(await withdrawal.count(), 1, 'an active child leaves through its own step');

    await main.getByLabel('Root or child NFT ID', { exact: true }).fill('12');
    await read.click();
    await recovery.waitFor();
    assert.equal(await withdrawal.count(), 0, 'a withdrawn child is not offered as an active one');
    await recovery.click();
    const review = main.getByRole('region', { name: 'Sequence wallet review', exact: true });
    await review.waitFor();
    const words = await review.innerText();
    assert.match(words, /Return NFT #12, which this sequence holds but does not manage, to your wallet\./);
    assert.doesNotMatch(words, FORBIDDEN);
    await review.getByRole('checkbox').check();
    await review.getByRole('button', { name: 'Send this step in wallet', exact: true }).click();
    await main.getByRole('heading', { name: 'Transaction receipt', exact: true }).waitFor();
    assert.equal(chain.sends.length, 1);
    assert.equal(String(chain.sends[0].to).toLowerCase(), chain.vaults[0], 'sent to the sequence itself');
    const { functionName, args } = sequenceCall(chain);
    assert.equal(functionName, 'recoverUnmanagedPosition');
    assert.deepEqual(args, [12n], 'the NFT read back from the vault, never the root and never another member');
    assert.deepEqual(chain.missing, []);
  } finally { await s.close(); }
});

test('an untracked balance is returned as the exact currency and amount chosen, is offered only once the position is read, and refuses an amount of nothing', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [100n], accounted: 250n });
  const currency = `0x${'61'.repeat(20)}`;
  try {
    const main = await openSequenceControls(s, chain);
    await main.getByLabel('Sequence address').fill(chain.vaults[0]);
    await main.getByRole('button', { name: 'Read owned sequence', exact: true }).click();
    await main.getByText('Child positions and fee reserves', { exact: true }).click();
    const recovery = main.getByRole('button', { name: 'Review untracked balance recovery', exact: true });
    await main.getByLabel('Root or child NFT ID', { exact: true }).waitFor();
    assert.equal(await recovery.count(), 0, 'no currency and no amount before the position and its reserves are read');
    await main.getByRole('button', { name: 'Read position and earned-fee reserves', exact: true }).click();
    await recovery.waitFor();

    await main.getByRole('combobox', { name: /^Currency to return/ }).selectOption(currency);
    const amount = main.getByLabel('Amount to return (smallest units)', { exact: true });
    const review = main.getByRole('region', { name: 'Sequence wallet review', exact: true });
    await amount.fill('0');
    await recovery.click();
    await main.locator('[data-notice-code="invalid_amount"]').waitFor();
    assert.equal(await review.count(), 0, 'returning nothing is not a transaction');
    assert.equal(chain.sends.length, 0);

    await amount.fill('4200');
    await recovery.click();
    await review.waitFor();
    const words = await review.innerText();
    assert.match(words, new RegExp(`Return 4200 raw units of ${currency} to your wallet\\.`));
    assert.match(words, /books account for 250 units of it/, 'what the books already hold is read from the vault, not assumed');
    assert.doesNotMatch(words, FORBIDDEN);
    await review.getByRole('checkbox').check();
    await review.getByRole('button', { name: 'Send this step in wallet', exact: true }).click();
    await main.getByRole('heading', { name: 'Transaction receipt', exact: true }).waitFor();
    assert.equal(chain.sends.length, 1);
    assert.equal(String(chain.sends[0].to).toLowerCase(), chain.vaults[0], 'sent to the sequence itself');
    const { functionName, args } = sequenceCall(chain);
    assert.equal(functionName, 'recoverUntrackedCurrency');
    assert.deepEqual([String(args[0]).toLowerCase(), args[1]], [currency, 4200n], 'the pair chosen, unchanged: never the native default it started on');
    assert.deepEqual(chain.missing, []);
  } finally { await s.close(); }
});

// ---- The sequence receipt: exact identity, a budget for the gas fields, and no way to send again ------------------

/**
 * A wallet may reshape `gas`, `maxFeePerGas` and `maxPriorityFeePerGas` between the review and the chain (Rabby does),
 * and the old check held each to the reviewed figure, so successful transactions were reported as not matching. The
 * check now holds them to the budget the review approved — gas × maxFeePerGas — and the receipt's cost to the same,
 * while hash, from, to, calldata, nonce, value, chain and type stay exact. An inclusion past the budget is its own
 * state, apart from a revert and from a mismatch, and nothing on the screen sends a second time.
 *
 * Each case sends the root permission repair, the shortest owner step: one button, no field, no disclosure to open.
 * The review fixes gas at 120,000 units (the 100,000 estimate plus a fifth) at 2 gwei, so the approved budget is
 * 2.4e14 wei.
 */
const APPROVED_BUDGET = 120_000n * 2_000_000_000n;
async function sendRepair(s, chain) {
  const main = await openSequenceControls(s, chain);
  await main.getByLabel('Sequence address').fill(chain.vaults[0]);
  await main.getByRole('button', { name: 'Read owned sequence', exact: true }).click();
  await main.getByRole('button', { name: 'Review root permission repair', exact: true }).click();
  const review = main.getByRole('region', { name: 'Sequence wallet review', exact: true });
  await review.waitFor();
  await review.getByRole('checkbox').check();
  await review.getByRole('button', { name: 'Send this step in wallet', exact: true }).click();
  await main.getByRole('heading', { name: 'Transaction receipt', exact: true }).waitFor();
  assert.equal(chain.sends.length, 1);
  assert.deepEqual([chain.sends[0].gas, chain.sends[0].maxFeePerGas, chain.sends[0].maxPriorityFeePerGas], [numberToHex(120_000n), numberToHex(2_000_000_000n), numberToHex(1_000_000n)], 'the reviewed gas figures');
  assert.equal(BigInt(chain.sends[0].gas) * BigInt(chain.sends[0].maxFeePerGas), APPROVED_BUDGET);
  return main;
}
const checkReceipt = async (main, said) => {
  await main.getByRole('button', { name: 'Check canonical receipt', exact: true }).click();
  await main.getByRole('status').filter({ hasText: said }).waitFor();
  return main.getByRole('status').innerText();
};

test('a receipt whose gas fields the wallet raised above the review is accepted while gas × maxFeePerGas and the cost paid stay within the approved budget, and the hash is shown as text', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [100n], rootPermissionValid: false });
  try {
    const main = await sendRepair(s, chain);
    const hash = `0x${'cc'.repeat(32)}`;
    // The hash is text to copy, not a link: session.bundle.test.mjs keeps every external endpoint out of the deployable bundle.
    assert.equal(await main.locator('.dm-acct-hash', { hasText: hash }).count(), 1, 'the hash is shown as text');
    assert.equal(await main.locator('a[href^="http"]').count(), 0, 'and nothing on the page links out');
    // Every gas field above the review: 60,000 × 3 gwei = 1.8e14 and 50,000 × 2.5 gwei = 1.25e14, both under the 2.4e14 approved.
    chain.include({ transaction: { gas: numberToHex(60_000n), maxFeePerGas: numberToHex(3_000_000_000n), maxPriorityFeePerGas: numberToHex(2_000_000_000n) },
      receipt: { gasUsed: numberToHex(50_000n), effectiveGasPrice: numberToHex(2_500_000_000n) } });
    assert.equal(await checkReceipt(main, 'Receipt: Finalized.'), 'Receipt: Finalized. Read the root or owned sequence again before continuing.');
    assert.equal(await main.locator('[data-notice-code]').count(), 0, 'accepted: no error code beside the sentence');
    assert.equal(chain.sends.length, 1, 'checking a receipt sends nothing');
    assert.deepEqual(chain.missing, []);
  } finally { await s.close(); }
});

test('an included transaction whose gas × maxFeePerGas, or whose cost paid, is past the approved budget is its own state: not a revert, not a mismatch, and nothing is sent again', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [100n], rootPermissionValid: false });
  try {
    const main = await sendRepair(s, chain);
    const over = 'Receipt: Finalized, but past the approved network budget. Nothing was sent again. Read the root or owned sequence again to see where it stands.';
    // The reviewed 120,000 units at 3 gwei: 3.6e14, past the 2.4e14 approved.
    chain.include({ transaction: { maxFeePerGas: numberToHex(3_000_000_000n), maxPriorityFeePerGas: numberToHex(2_000_000_000n) } });
    assert.equal(await checkReceipt(main, 'past the approved network budget'), over);
    assert.equal(await main.locator('[data-notice-code]').count(), 0, 'a state, not an error');
    chain.include(null);
    assert.equal(await checkReceipt(main, 'Waiting to be included'), 'Receipt: Waiting to be included. Check again when the chain has progressed. No transaction is retried.');
    // The transaction fits, but the receipt says the chain charged 120,000 × 3 gwei: the receipt is held to the budget too.
    chain.include({ transaction: { gas: numberToHex(60_000n) }, receipt: { gasUsed: numberToHex(120_000n), effectiveGasPrice: numberToHex(3_000_000_000n) } });
    assert.equal(await checkReceipt(main, 'past the approved network budget'), over);
    // A revert stays a revert, whatever it cost.
    chain.include({ transaction: { maxFeePerGas: numberToHex(3_000_000_000n) }, receipt: { status: '0x0' } });
    assert.equal(await checkReceipt(main, 'Receipt: Reverted.'), 'Receipt: Reverted. Check again when the chain has progressed. No transaction is retried.');
    // A receipt with no cost on it cannot be held to the budget, and is refused as one that could not be read.
    chain.include({ receipt: { gasUsed: undefined } });
    await main.getByRole('button', { name: 'Check canonical receipt', exact: true }).click();
    await main.locator('[data-notice-code="invalid_receipt"]').waitFor();
    assert.equal(chain.sends.length, 1, 'across every state, one transaction was ever offered');
    for (const name of await main.getByRole('button').allInnerTexts()) assert.doesNotMatch(name, /send again|resend|retry|speed up|replace/i, `a control named ${name}`);
    assert.doesNotMatch(await main.innerText(), FORBIDDEN);
    assert.deepEqual(chain.missing, []);
  } finally { await s.close(); }
});

test('a receipt whose transaction went to another address, or carried other calldata, does not match the reviewed step, whatever it cost', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [100n], rootPermissionValid: false });
  try {
    const main = await sendRepair(s, chain);
    const mismatch = main.locator('[data-notice-code="receipt_identity_changed"]');
    chain.include({ transaction: { to: chain.release.deployment.factory } });
    await main.getByRole('button', { name: 'Check canonical receipt', exact: true }).click();
    await mismatch.waitFor();
    assert.equal(await mismatch.innerText(), 'That receipt does not match the reviewed step.');
    chain.include(null);
    await checkReceipt(main, 'Waiting to be included');
    chain.include({ transaction: { input: '0x' } });
    await main.getByRole('button', { name: 'Check canonical receipt', exact: true }).click();
    await mismatch.waitFor();
    assert.equal(await mismatch.innerText(), 'That receipt does not match the reviewed step.');
    // Said apart from the deployment's own sentence, which is about a profile, not a receipt.
    assert.equal(await main.locator('[data-notice-code="deployment_identity_changed"]').count(), 0);
    // The same transaction, unchanged, is still accepted afterwards: the refusal was the record's, not the page's.
    chain.include({});
    assert.equal(await checkReceipt(main, 'Receipt: Finalized.'), 'Receipt: Finalized. Read the root or owned sequence again before continuing.');
    assert.equal(chain.sends.length, 1);
    assert.deepEqual(chain.missing, []);
  } finally { await s.close(); }
});

test('while the service that runs automation is not in operation a paused sequence is not offered activation and says why, with every other control in place; an active one says nothing', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [100n], paused: true });
  try {
    const main = await openSequenceControls(s, chain);
    await main.getByLabel('Sequence address').fill(chain.vaults[0]);
    await main.getByRole('button', { name: 'Read owned sequence', exact: true }).click();
    const why = main.locator('[data-automation-service="not-operational"]');
    await why.waitFor();
    assert.equal(await why.innerText(), 'This sequence stays paused: the service that runs automation is not in operation, so activation is not offered.');
    assert.doesNotMatch(await why.innerText(), FORBIDDEN);
    assert.equal(await main.getByRole('button', { name: 'Review activation' }).count(), 0, 'no activation while nothing would run');
    assert.match(await main.innerText(), /Root NFT #100 · Paused · Operator 0x/, 'the chain’s own state is still said as the chain says it');
    // The rule and limit changes sit in closed disclosures; opened, so their buttons count as offered.
    for (const summary of ['Adjust automation rules', 'Adjust safety limits']) await main.getByText(summary, { exact: true }).click();
    for (const [name, disabled] of [['Review pause', true], ['Review operator revocation', false], ['Review root NFT approval revocation', false], ['Review automation rule change', false], ['Review safety limit change', false]]) {
      const button = main.getByRole('button', { name, exact: true });
      assert.equal(await button.count(), 1, `${name} is still offered`);
      assert.equal(await button.isDisabled(), disabled, `${name} is ${disabled ? 'disabled, as the sequence is already paused' : 'enabled'}`);
    }
    assert.deepEqual(chain.missing, []);
  } finally { await s.close(); }
  const active = await scenario(), running = fakeSequenceChain(OWNER, { roots: [100n], paused: false });
  try {
    const main = await openSequenceControls(active, running);
    await main.getByLabel('Sequence address').fill(running.vaults[0]);
    await main.getByRole('button', { name: 'Read owned sequence', exact: true }).click();
    await main.getByRole('button', { name: 'Review operator revocation', exact: true }).waitFor();
    assert.match(await main.innerText(), /Root NFT #100 · Active · Operator 0x/);
    assert.equal(await main.locator('[data-automation-service]').count(), 0, 'an active sequence has no activation to withhold');
    assert.equal(await main.getByRole('button', { name: 'Review activation' }).count(), 0);
  } finally { await active.close(); }
});

// ---- The guided creation: from a position link, two reviewed steps, no session ------------------------------------

test('a guided sequence link names a failed wallet read without exposing its provider reply or asking for a signature', async () => {
  const s = await scenario(), chain = fakeSequenceChain(OWNER, { roots: [5n] });
  const privateReply = 'private-provider-reply SECRET_CALLDATA_0xdeadbeef';
  await s.context.exposeFunction('__dominoChainRead', (method, params) => {
    if (method === 'eth_getCode') throw new Error(privateReply);
    return chain.request(method, params);
  });
  await s.context.addInitScript(() => {
    let wallet = window.__dominoWalletRequest;
    const request = (id, method, params) => ['eth_call', 'eth_getCode', 'eth_getBlockByNumber'].includes(method)
      ? window.__dominoChainRead(method, params) : wallet(id, method, params);
    Object.defineProperty(window, '__dominoWalletRequest', { configurable: true, get: () => request, set: value => { wallet = value; } });
  });
  try {
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await s.page.locator('header [aria-haspopup="dialog"]').click();
    await s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Connect Test Wallet A', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
    await s.page.keyboard.press('Escape');
    s.set({ sequenceRelease: { status: 200, body: chain.release } });
    await s.page.goto(`${s.origin}/#/sequence/compound/5`);
    await s.page.reload();
    const main = s.page.locator('main');
    const notice = main.locator('[data-notice-code="sequence_read_code"]');
    await notice.waitFor({ timeout: 30_000 });
    assert.match(await notice.innerText(), /wallet could not read deployed contract code/i);
    assert.doesNotMatch(await main.innerText(), /SECRET_CALLDATA|deadbeef/);
    assert.equal(await main.locator('[data-sequence-create]').count(), 0, 'the guided form stays closed after a failed read');
    assert.deepEqual(chain.sends, [], 'no wallet transaction was requested');
    assert.equal(s.wallet.state.signed.length, 0, 'no sign-in signature was requested');
  } finally { await s.close(); }
});

/**
 * SequenceCreate.tsx, driven the way a person reaches it: a link naming the mode and the position NFT, a wallet that
 * is connected and nothing more. The chain is the fake above with nothing approved and every send settled at once, so
 * the approval is the first step the review offers, the creation the second, and each receipt comes back finalized
 * on the first check. What the wallet was asked to sign is decoded from the two transactions the chain recorded.
 */
test('from a position link, a connected wallet without a session puts the NFT under Domino-compound in two reviewed steps: the approval, then the paused creation, with the defaults on the wire', async () => {
  const s = await scenario(), ROOT = 5n;
  const chain = fakeSequenceChain(OWNER, { roots: [], approved: false, settled: true });
  const { factory, positionManager, operator } = chain.release.deployment, vault = chain.predict(0);
  // Everything the sequence client and the gas suggestion ask of the wallet, past connecting, is the chain's to answer.
  await s.context.exposeFunction('__dominoChainRead', (method, params) => chain.request(method, params));
  await s.context.addInitScript((methods) => {
    let wallet = window.__dominoWalletRequest;
    const request = (id, method, params) => methods.includes(method) ? window.__dominoChainRead(method, params) : wallet(id, method, params);
    Object.defineProperty(window, '__dominoWalletRequest', { configurable: true, get: () => request, set: value => { wallet = value; } });
  }, ['eth_call', 'eth_getCode', 'eth_getBlockByNumber', 'eth_gasPrice', 'eth_getTransactionCount', 'eth_estimateGas', 'eth_getBalance', 'eth_sendTransaction', 'eth_getTransactionByHash', 'eth_getTransactionReceipt']);
  const services = [];
  s.page.on('request', request => { if (/\/api\/(deposit|session)\//.test(request.url())) services.push(new URL(request.url()).pathname); });
  const dialog = s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]');
  const lower = value => String(value).toLowerCase();
  try {
    // Connected on Robinhood Chain, and no further: Sign in is offered and never pressed.
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
    await s.page.locator('header [aria-haspopup="dialog"]').click();
    await dialog.getByRole('button', { name: 'Connect Test Wallet A', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
    await s.page.keyboard.press('Escape');

    // The link: the mode and the NFT in the hash, with the release published. Reloaded so the screen mounts on it.
    s.set({ sequenceRelease: { status: 200, body: chain.release } });
    await s.page.goto(`${s.origin}/#/sequence/domino/${ROOT}`);
    await s.page.reload();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
    const panel = s.page.locator('[data-sequence-create]');
    const root = panel.locator(`[data-sequence-root="${ROOT}"]`);
    // Read without a press: the deployment verified through the wallet, the sequences listed, the NFT inspected.
    await root.waitFor({ timeout: 30_000 });
    assert.equal(await panel.getAttribute('data-sequence-create-mode'), 'domino', 'the link’s mode is chosen');
    assert.equal(await panel.getAttribute('data-sequence-create'), 'limits', 'the position and the mode are in; the limits are next');
    assert.equal(await panel.locator('[data-sequence-mode="domino"]').getAttribute('aria-checked'), 'true');
    assert.match(await root.innerText(), new RegExp(`^NFT ${ROOT} · pool 0x[0-9a-f]{4}…[0-9a-f]{4} · ticks -60 to 60 · .* Yours, and not in a sequence\\.$`));
    assert.equal(await panel.locator('[data-sequence-create-review]').count(), 0, 'nothing is reviewed by arriving');
    assert.deepEqual(chain.sends, [], 'nothing is sent by arriving');
    assert.deepEqual([await panel.getByLabel('Positions in the sequence', { exact: true }).inputValue(), await panel.getByLabel('Successor upside (%)', { exact: true }).inputValue()], ['3', '50'], 'the defaults, in the units a person reads');

    // A quote choice is required even when the link selected the NFT and mode. The pool's token order is not consent.
    const quote = panel.getByRole('radiogroup', { name: 'Quote currency' });
    const quote0 = quote.getByRole('radio', { name: /^Quote: currency 0 / });
    const quote1 = quote.getByRole('radio', { name: /^Quote: currency 1 / });
    assert.match(await quote.innerText(), new RegExp(chain.poolKey.currency0), 'the full currency0 identity is shown');
    assert.match(await quote.innerText(), new RegExp(chain.poolKey.currency1), 'the full currency1 identity is shown');
    assert.equal(await quote0.isChecked(), false);
    assert.equal(await quote1.isChecked(), false);
    await panel.getByRole('checkbox', { name: /^I consent to using this NFT’s already uncollected fees/ }).check();
    assert.equal(await panel.getByRole('button', { name: 'Review the wallet steps', exact: true }).isDisabled(), true);
    await quote1.check();
    assert.equal(await panel.getByRole('button', { name: 'Review the wallet steps', exact: true }).isEnabled(), true);
    // Changing orientation invalidates even a prepared approval; the final choice makes currency0 the quote.
    await panel.getByRole('button', { name: 'Review the wallet steps', exact: true }).click();
    await panel.locator('[data-sequence-create-review="approve-root"]').waitFor({ timeout: 30_000 });
    await quote0.check();
    assert.equal(await panel.locator('[data-sequence-create-review]').count(), 0);
    assert.equal(await quote0.isChecked(), true);
    await panel.getByRole('button', { name: 'Review the wallet steps', exact: true }).click();
    const review = panel.locator('[data-sequence-create-review]');
    await panel.locator('[data-sequence-create-review="approve-root"]').waitFor({ timeout: 30_000 });
    assert.equal(await panel.getAttribute('data-sequence-create'), 'review');
    let words = await review.innerText();
    assert.match(words, /Review root NFT approval/, 'the step is named, not left as a code');
    assert.match(words, new RegExp(`Approve only NFT #${ROOT} to the predicted sequence\\. No approval for all NFTs\\.`));
    assert.match(words, new RegExp(`Sequence: ${vault}`), 'the predicted address, derived from the factory and the owner’s nonce');
    assert.doesNotMatch(words, FORBIDDEN);
    const sendStep = async (kind) => {
      const step = panel.locator(`[data-sequence-create-review="${kind}"]`);
      await step.getByRole('checkbox', { name: /^I reviewed the NFT, owner, sequence address, currencies, fees and limits for this single step\./ }).check();
      await step.getByRole('button', { name: 'Send this step in wallet', exact: true }).click();
      await panel.locator(`[data-sequence-create-sent="${kind}"][data-sequence-create-receipt="finalized"]`).waitFor({ timeout: 30_000 });
    };
    await sendStep('approve-root');

    // Its receipt in: the creation is reviewed on its own, with nothing pressed, and the defaults are what it carries.
    await panel.locator('[data-sequence-create-review="create"]').waitFor({ timeout: 30_000 });
    words = await review.innerText();
    assert.match(words, /Review paused sequence creation/);
    assert.match(words, new RegExp(`Create a paused sequence from NFT #${ROOT}\\.`));
    assert.match(words, /Your root NFT stays in your wallet\. This does not start automation\./);
    assert.match(words, new RegExp(`Base: ${chain.poolKey.currency1}\\. Quote: ${chain.poolKey.currency0}\\.`), 'the owner selected currency0 as the quote');
    assert.match(words, new RegExp(`Operator: ${operator}\\.`));
    assert.match(words, /Domino-compound: 4% of earned fees consumed, once; never principal or already charged lots\./);
    assert.match(words, /Trigger distance: 500 bps; maximum overlap: 2000 bps; minimum interval: 3600s; maximum positions: 3\./);
    assert.match(words, /Successor upside: 5000 bps; maximum slippage: 100 bps; maximum price impact: 100 bps\./);
    assert.match(words, /Execution gas cost cap: 5000000000000000 wei; observation age: 300s; forecast horizon: 604800s\./);
    assert.doesNotMatch(words, FORBIDDEN);
    await sendStep('create');

    // Created: the vault read back from the chain, paused, with the root NFT still in the wallet, and why it stays paused.
    const created = panel.locator(`[data-sequence-created="${vault}"]`);
    await created.waitFor({ timeout: 30_000 });
    assert.equal(await panel.getAttribute('data-sequence-create'), 'done');
    assert.match(await created.innerText(), new RegExp(`^Domino-compound is set up for position NFT ${ROOT}\\s+Sequence ${vault} · paused · operator 0x[0-9a-f]{4}…[0-9a-f]{4} · your NFT stays in your wallet\\.`));
    assert.equal(await created.locator('[data-automation-service="not-operational"]').innerText(), 'This sequence stays paused: the service that runs automation is not in operation, so activation is not offered.');
    assert.equal(await panel.locator('[data-sequence-create-review]').count(), 0, 'nothing left to send');
    assert.equal(await panel.locator('[data-notice-code]').count(), 0, 'no error code beside any sentence');
    assert.doesNotMatch(await panel.innerText(), FORBIDDEN);
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
