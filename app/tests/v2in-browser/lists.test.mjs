/**
 * The Positions screen with read-v6 in it (src/v2in/lists, mounted from components/positions/OwnedPositions.tsx and
 * screens/Positions.tsx behind __DOMINO_V2__; spec F7 rev4 §6.2, §6.3, §2.11; the integration brief's data rule), in
 * wallet-test-v2 (.wallet-test-v2-dist, the wallet test build with V2 compiled in: `npm run test:v2in`), against V1's own
 * fake chain (tests/support/browser-chain.mjs: one open position of Test Wallet A, read through the site's chain routes)
 * and the site's read-v6 route as this suite answers it (its capabilities GET and the two POSTs, with the contract header):
 *
 *   - gate off (no hook opens the test origin): Positions is exactly V1's, and nothing of read-v6 is asked;
 *   - gate `preview`: real data only. A route that is not deployed leaves V1 intact, with no example positions or
 *     receipts. A route that serves the connected wallet contributes its own rows with partial/stale coverage.
 *   - gate `live` (`contracts` + `backendOn`, the fake chain's sets): the person's own positions from the route join V1's
 *     grid and tabs (a Robinhood Chain v4 NFT V1 lists is shown once), their receipts the Receipts card, no "Test data";
 *     the route off (not deployed) is one quiet line with its reason, never test data.
 */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { zeroAddress } from 'viem';
import { browserChain, routeChain } from '../support/browser-chain.mjs';
import { closeBrowser } from '../support/close-browser.mjs';
import { createFakeSession } from '../support/fake-session.mjs';
import { ACCOUNTS, installWallets } from '../support/mock-wallet.mjs';
import { ARTWORK } from '../support/new-position.mjs';
import { FIXTURE_TOKEN, createReadStub } from '../support/read-stub.mjs';
import { launchBrowser } from '../support/s1-browser.mjs';
import { contractsFor } from '../support/v2-chain.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';
import { createWalletServer } from '../support/wallet-server.mjs';
import * as runtime from '../../../api-contracts/read-v6/runtime.mjs';
import * as executionRuntime from '../../../api-contracts/execution-v1/runtime.mjs';

const APP = resolve(import.meta.dirname, '../..');
const CONTRACTS = resolve(APP, '../api-contracts');
const fixture = (name) => JSON.parse(readFileSync(join(CONTRACTS, 'read-v6', 'fixtures', 'valid', name), 'utf8'));
const OWNER = ACCOUNTS[0].address.toLowerCase();
/** Where the screens are kept for a look (V1's suites' own place, .test-artifacts). */
const shots = () => {
  const dir = resolve(APP, '.test-artifacts');
  mkdirSync(dir, { recursive: true });
  return dir;
};
const EXAMPLE_WALLET = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
const V1_OPEN = '3135288';
const TOKENS = { [FIXTURE_TOKEN.toLowerCase()]: { symbol: 'TOKEN', decimals: 6 } };
const STUB_KEY = { currency0: zeroAddress, currency1: FIXTURE_TOKEN.toLowerCase(), fee: 3000, tickSpacing: 60, hooks: zeroAddress };
const onChain = (tokenId) => ({ tokenId, holder: OWNER, key: STUB_KEY, tickLower: -60, tickUpper: 60, liquidity: 2n ** 100n, unclaimed: [633825300114n, 0n] });
const LIVE = { originOpen: true, backendOn: true, contracts: { 4663: contractsFor(4663), 8453: contractsFor(8453), 42161: contractsFor(42161) } };
// Changed on purpose 2026-10-06: read-v6 1.1.0-rc.1 (#363, qualified USD); the route answers its version.
const CONTRACT = '1.1.0-rc.1';
/** The read Worker's capabilities while its reads are on (bridge/src/worker.mjs; src/v2/routes.ts reads it). */
const CAPABILITIES = { contractVersion: CONTRACT, dataMode: 'live_read_only', chainIds: [4663, 8453, 42161], enabledReads: ['portfolio', 'activity'], walletAuthentication: false, privateAccounts: false, ownerTransactions: false, automation: false };

/** A package fixture as the site's route would answer it about the person's own wallet: only the wallet swapped, then validated. */
function about(route, body, wallet) {
  const answered = JSON.parse(JSON.stringify(body).replaceAll(EXAMPLE_WALLET, wallet));
  assert.equal(runtime.validateResponse(route, answered), true, `${route} still valid about ${wallet}`);
  return answered;
}

/** The read route as the read Worker answers while on: its capabilities, then `answer(route, body)` for each POST. */
const routeOn = (answer) => (method, route, body) => (method === 'GET' && route === 'capabilities' ? { status: 200, body: CAPABILITIES, contract: true } : { ...answer(route, body), contract: true });
/** No read Worker behind the path (the site's forwarder): a bare 404, no contract header. */
const routeMissing = () => ({ status: 404, body: { error: 'not_found' }, contract: false });

let browser;
before(async () => {
  browser = await launchBrowser();
});
after(async () => {
  await closeBrowser(browser);
});

/**
 * Positions of wallet-test-v2, Test Wallet A connected on Robinhood Chain with one open V1 position. `hooks`: the page's
 * `window.__dominoV2Test`; `readV6(method, route, body)`: the site's read-v6 route ({ status, body, contract }), recorded.
 */
async function scenario({ hooks = null, readV6 = routeMissing, hash = '#/positions', privateReceipts = null, sessionDisabled = false, refresh = false } = {}) {
  const fake = createFakeSession();
  fake.controls.disabled = sessionDisabled;
  const chain = browserChain({ positions: [onChain(V1_OPEN)], tokens: TOKENS });
  const read = createReadStub();
  const asked = [];
  const server = createWalletServer({
    fake,
    dist: WALLET_V2_DIST,
    routes: [
      async (request, url) => {
        if (privateReceipts !== null && url.pathname === '/api/execution/v1/list') {
          assert.ok(request.headers.get('cookie')?.includes('__Host-domino-session='));
          assert.ok(request.headers.get('X-Domino-CSRF'));
          const wire = JSON.parse(readFileSync(join(CONTRACTS, 'execution-v1/fixtures/status-wire.json'), 'utf8'));
          const body = { ...wire.responses['list.empty'], owner: OWNER, items: privateReceipts };
          assert.equal(executionRuntime.validateResponse('list', body), true);
          return Response.json(body, { headers: { 'X-Domino-Execution-Contract': executionRuntime.CONTRACT_VERSION } });
        }
        if (!url.pathname.startsWith('/api/read/v6/')) return undefined;
        const route = url.pathname.split('/').at(-1);
        const body = request.method === 'POST' ? JSON.parse(await request.text()) : null;
        asked.push({ method: request.method, route, body, contract: request.headers.get('x-domino-read-contract') });
        const answer = readV6(request.method, route, body);
        return Response.json(answer.body, { status: answer.status, headers: answer.contract ? { 'X-Domino-Read-Contract': CONTRACT } : {} });
      },
      (request, url) => read.handle(request, url),
    ],
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fake.origin = origin;
  const context = await browser.newContext({ viewport: { width: 1320, height: 1000 } });
  const errors = [];
  await context.route(/^https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) => route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await context.route(ARTWORK, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await routeChain(context, chain);
  const wallet = await installWallets(context);
  if (hooks) await context.addInitScript((value) => { window.__dominoV2Test = value; }, hooks);
  if (refresh) await context.addInitScript(() => { window.__dominoRefresh = true; });
  const page = await context.newPage();
  if (refresh) await page.clock.install();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/${hash}`);
  // Test Wallet A, from the header's dialog, on Robinhood Chain, without signing in.
  await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
  await page.locator('header [aria-haspopup="dialog"]').click();
  await page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Connect Test Wallet A', exact: true }).click();
  await page.waitForFunction(expected => window.__dominoSessionProbe?.view().status === expected, sessionDisabled ? 'blocked' : 'signed_out');
  await page.keyboard.press('Escape');
  return {
    page,
    asked,
    wallet,
    async close() {
      await context.close();
      await server.closeAll();
      assert.deepEqual(errors, [], 'no page error');
      assert.deepEqual(wallet.state.csp, [], 'no CSP violation');
      assert.deepEqual(chain.publicAsked, [], 'no public RPC');
    },
  };
}

const text = (locator) => locator.innerText().then((value) => value.replace(/\s+/g, ' ').trim());
const tabs = async (page) => {
  await page.getByRole('tab').first().waitFor();
  return page.getByRole('tab').allInnerTexts().then((all) => all.map((value) => value.replace(/\s+/g, ' ').trim()));
};
/** V1's open row, as V1's own suite reads it (tests/finance.browser.test.mjs). */
async function v1RowAsItIs(page) {
  const row = page.locator(`a[data-position-row="${V1_OPEN}"]`);
  await row.waitFor();
  assert.equal(await row.getAttribute('href'), `#/positions/${V1_OPEN}`);
  assert.match(await row.innerText(), /ETH\s*\/\s*TOKEN\s+0\.30% fee\s+Position #3135288\s+In range/);
}
/** V1's two cards with nothing of V2 in them. */
async function v1CardsExact(page) {
  assert.equal(await page.locator('[data-owned] [data-v2-position-row], [data-owned] [data-v2-examples-band], [data-owned] [data-v2-own-note], [data-owned] [data-test-data]').count(), 0, 'Your positions is V1’s own');
  assert.equal(await page.locator('section[aria-labelledby="receipts-title"] [data-v2-receipt], section[aria-labelledby="receipts-title"] [data-test-data]').count(), 0, 'Receipts is V1’s own');
  assert.doesNotMatch(await text(page.locator('[data-owned]')), /Example|Test data/);
}

test('gate off: Positions is exactly V1’s, and nothing of read-v6 is asked or drawn', async () => {
  const s = await scenario();
  try {
    await s.page.locator('[data-owned="ready"]').waitFor();
    await v1RowAsItIs(s.page);
    assert.deepEqual(await tabs(s.page), ['Open 1', 'Closed 0']);
    await s.page.waitForTimeout(500);
    assert.equal(await s.page.locator('[data-v2-position-row], [data-v2-examples], [data-v2-own-note], [data-v2-receipt]').count(), 0);
    assert.deepEqual(s.asked, [], 'the site’s read-v6 route is never asked');
    assert.doesNotMatch(await s.page.locator('main').innerText(), /Test data|Example/);
  } finally {
    await s.close();
  }
});

test('preview with no read-v6 route: V1 stays intact, with no fixture positions or extra example card', async () => {
  const s = await scenario({ hooks: { originOpen: true } });
  try {
    await s.page.locator('[data-owned="ready"]').waitFor();
    await v1RowAsItIs(s.page);
    await v1CardsExact(s.page);
    assert.deepEqual(await tabs(s.page), ['Open 1', 'Closed 0']);
    await s.page.locator('[data-automation-cards="merged"]').waitFor();
    await s.page.waitForFunction(() => document.querySelector('[data-owned-rows="open"] [data-position-row]'));
    assert.equal(await s.page.locator('[data-v2-examples], [data-v2-position-row], [data-test-data]').count(), 0);
    assert.doesNotMatch(await s.page.locator('main').innerText(), /Example positions|Test data/);
    assert.deepEqual([...new Set(s.asked.map(entry => entry.method + ' ' + entry.route))], ['GET capabilities']);
    assert.equal(s.wallet.state.signed.length, 0);
    await s.page.locator('main').screenshot({ path: join(shots(), 'v2-lists-preview-real-data-only.png') });
  } finally { await s.close(); }
});

test('preview receipts with no route: no fixture history, no invented transactions, and private sign-in remains explicit', async () => {
  const s = await scenario({ hooks: { originOpen: true }, hash: '#/positions/receipts' });
  try {
    await s.page.locator('[data-execution="signed_out"]').waitFor();
    assert.equal(await s.page.locator('[data-v2-examples], [data-v2-example-receipts], [data-v2-receipt], [data-test-data]').count(), 0);
    assert.doesNotMatch(await s.page.locator('main').innerText(), /Test data|Example positions/);
    assert.equal(s.wallet.state.signed.length, 0);
    assert.ok(!s.asked.some(entry => entry.method === 'POST'), 'missing capabilities never cause a portfolio or activity POST');
    assert.ok(s.asked.every(entry => entry.method === 'GET' && entry.route === 'capabilities'));
    assert.equal(await s.page.locator('[data-execution="signed_out"]').getByRole('button', { name: 'Sign in', exact: true }).count(), 1);
  } finally { await s.close(); }
});

test('preview reads the connected wallet from the site route and shows its partial/stale coverage without example data', async () => {
  const own = about('portfolio', fixture('portfolio-behind.json'), OWNER);
  const s = await scenario({ hooks: { originOpen: true }, readV6: routeOn(route => ({ status: 200, body: route === 'portfolio' ? own : about('activity', fixture('activity.json'), OWNER) })) });
  try {
    const note = s.page.locator('[data-owned] [data-v2-own-note="partial"]');
    await note.waitFor();
    assert.equal(await text(note), 'Showing Robinhood Chain. Base and Arbitrum One are unavailable right now.');
    assert.equal(await s.page.locator('a[data-v2-position-row="4663:4:7"] [data-v2-stale]').getAttribute('data-v2-stale'), 'updated 15 min ago');
    await v1RowAsItIs(s.page);
    assert.deepEqual(await tabs(s.page), ['Open 2', 'Closed 0']);
    assert.equal(await s.page.locator('[data-v2-examples], [data-test-data]').count(), 0);
    assert.doesNotMatch(await s.page.locator('main').innerText(), /Test data|Example positions/);
    assert.deepEqual(s.asked.find(entry => entry.route === 'portfolio').body, { wallet: OWNER });
    assert.deepEqual(s.asked.find(entry => entry.route === 'activity').body, { wallet: OWNER, limit: 20 });
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

test('live: the person’s own positions from the site’s route join V1’s grid and tabs, shown once, with no "Test data"', async () => {
  const own = about('portfolio', fixture('portfolio.json'), OWNER);
  // The same NFT V1 lists (Robinhood Chain's v4 position manager, its id): shown once, as V1's row.
  own.positions[2].tokenId = V1_OPEN;
  const s = await scenario({ hooks: LIVE, readV6: routeOn((route) => ({ status: 200, body: route === 'portfolio' ? own : about('activity', fixture('activity.json'), OWNER) })) });
  try {
    const rows = s.page.locator('[data-owned-rows="open"] a[data-v2-position-row]');
    await rows.first().waitFor();
    await v1RowAsItIs(s.page);
    assert.deepEqual(await rows.evaluateAll((all) => all.map((row) => row.getAttribute('data-v2-position-row'))), ['4663:4:7', '4663:4:8', '4663:4:12', '4663:4:13']);
    assert.equal(await s.page.locator(`[data-position-row="${V1_OPEN}"], [data-v2-position-row="4663:4:${V1_OPEN}"]`).count(), 1);
    await s.page.getByRole('tab', { name: /^Open 5/ }).waitFor();
    assert.deepEqual(await tabs(s.page), ['Open 5', 'Closed 0'], 'the person’s own rows count');
    assert.equal(await text(s.page.locator('[data-owned] [data-v2-own-note="partial"]')), 'Showing Robinhood Chain and Base. Arbitrum One is unavailable right now.');
    assert.equal(await s.page.locator('[data-v2-examples], [data-test-data]').count(), 0, 'no test data in a live list');
    const portfolio = s.asked.find((entry) => entry.route === 'portfolio');
    assert.deepEqual([portfolio.method, portfolio.contract, portfolio.body], ['POST', CONTRACT, { wallet: OWNER }]);
    assert.ok(s.asked.findIndex((entry) => entry.route === 'capabilities') < s.asked.indexOf(portfolio), 'the route’s capabilities asked first');
    // Receipts: the person's own, no sign-in needed (public chain data), no test data.
    const receipts = s.page.locator('section[aria-labelledby="receipts-title"] [data-v2-own-receipts="ok"] li[data-v2-receipt]');
    await receipts.first().waitFor();
    assert.equal(await receipts.count(), 4);
    const privateEntry = s.page.locator('section[aria-labelledby="receipts-title"] [data-execution="signed_out"]');
    await privateEntry.locator('[data-signed-out] > summary').click();
    assert.match(await text(privateEntry), /Sign in with your wallet to see more automation history/);
    assert.equal(await privateEntry.locator('.dm-acct-quiet').count(), 0, 'public receipts do not sit below a second empty-state plate');
    assert.equal(await privateEntry.getByRole('button', { name: 'Sign in', exact: true }).count(), 1);
    assert.equal(s.wallet.state.signed.length, 0, 'reading public activity does not ask for a signature');
    assert.deepEqual(s.asked.find((entry) => entry.route === 'activity').body, { wallet: OWNER, limit: 20 });
    if (process.env.DOMINO_RECEIPT_SHOTS) {
      mkdirSync(process.env.DOMINO_RECEIPT_SHOTS, { recursive: true });
      const section = s.page.locator('section[aria-labelledby="receipts-title"]');
      await receipts.first().locator('summary').click();
      for (const width of [390, 320]) {
        await s.page.setViewportSize({ width, height: 960 });
        assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `public receipts fit ${width}`);
        await section.screenshot({ path: join(process.env.DOMINO_RECEIPT_SHOTS, `receipts-v2-public-${width}.png`), animations: 'disabled' });
      }
      await s.page.setViewportSize({ width: 1320, height: 1000 });
    }
    await s.page.locator('main').screenshot({ path: join(shots(), 'v2-lists-live.png') });
  } finally {
    await s.close();
  }
});

test('live, the site’s route not deployed: V1 remains available without an empty V2 section or test data', async () => {
  const s = await scenario({ hooks: LIVE, readV6: routeMissing });
  try {
    await v1RowAsItIs(s.page);
    // V1's NFT can render before the independent V2 capabilities read settles.
    await s.page.locator('[data-automation-cards="merged"]').waitFor();
    await s.page.waitForFunction(() => document.querySelector('[data-owned-rows="open"] [data-position-row]'));
    assert.deepEqual(await tabs(s.page), ['Open 1', 'Closed 0']);
    assert.equal(await s.page.locator('[data-v2-position-row], [data-v2-examples], [data-test-data]').count(), 0);
    assert.equal(await s.page.locator('[data-v2-own-note], [data-v2-own-receipts]').count(), 0, 'a family not deployed is quiet; it is not a failed read');
    assert.equal(await s.page.locator('.dm-rcpt-session').count(), 0, 'no compact public-history treatment without public rows');
    assert.deepEqual([...new Set(s.asked.map((entry) => `${entry.method} ${entry.route}`))], ['GET capabilities'], 'only the capabilities are asked: nothing is posted to a route that is not there');
  } finally {
    await s.close();
  }
});

test('public receipts keep the unavailable sign-in reason visible without hiding their rows or offering a signature', async () => {
  const s = await scenario({ hooks: LIVE, sessionDisabled: true, hash: '#/positions/receipts', readV6: routeOn(route => ({ status: 200, body: about(route, fixture(`${route}.json`), OWNER) })) });
  try {
    await s.page.locator('[data-v2-receipt]').first().waitFor();
    const entry = s.page.locator('[data-execution="signed_out"] [data-signed-out="session_disabled"]');
    await entry.locator('summary').click();
    assert.match(await text(entry), /More automation history will show here once wallet sign-in is available\./);
    assert.equal(await entry.locator('button').count(), 0);
    assert.equal(await entry.getAttribute('class'), 'dm-activity-internal');
    assert.ok(await s.page.locator('[data-v2-receipt]').count() > 0);
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

test('explicit sign-in adds private automation receipts alongside public receipts without replacing either history', async () => {
  const wire = JSON.parse(readFileSync(join(CONTRACTS, 'execution-v1/fixtures/status-wire.json'), 'utf8'));
  const reserved = wire.responses['status.reserved'].item;
  const s = await scenario({ hooks: LIVE, hash: '#/positions/receipts', privateReceipts: [reserved], readV6: routeOn(route => ({ status: 200, body: about(route, fixture(`${route}.json`), OWNER) })) });
  try {
    await s.page.locator('[data-v2-receipt]').first().waitFor();
    const publicIds = await s.page.locator('[data-v2-receipt]').evaluateAll(rows => rows.map(row => row.dataset.v2Receipt));
    await s.page.locator('[data-execution="signed_out"] [data-signed-out] > summary').click();
    await s.page.locator('[data-execution="signed_out"]').getByRole('button', { name: 'Sign in', exact: true }).click();
    assert.equal(s.wallet.state.signed.length, 0);
    await s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Sign in', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await s.page.keyboard.press('Escape');
    await s.page.locator('[data-unified-activity]').getByRole('button', { name: 'Show more', exact: true }).click();
    const privateRow = s.page.locator(`[data-execution="ready"] [data-execution-intent="${reserved.intentId}"]`);
    await privateRow.waitFor();
    assert.equal(s.wallet.state.signed.length, 1);
    assert.match(await text(privateRow), /In progress Adding fees back/);
    const allIds = await s.page.locator('[data-v2-receipt]').evaluateAll(rows => rows.map(row => row.dataset.v2Receipt));
    assert.ok(publicIds.every(id => allIds.includes(id)), 'signing in and paging preserve every loaded public operation');
    assert.match(await text(privateRow), /Date unavailable/);
    assert.equal(await s.page.locator('.dm-rcpt-session').count(), 0);
    if (process.env.DOMINO_RECEIPT_SHOTS) {
      mkdirSync(process.env.DOMINO_RECEIPT_SHOTS, { recursive: true });
      await s.page.setViewportSize({ width: 390, height: 960 });
      assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await s.page.screenshot({ path: join(process.env.DOMINO_RECEIPT_SHOTS, 'receipts-private-and-public-390.png'), fullPage: true, animations: 'disabled' });
    }
  } finally { await s.close(); }
});

test('one overview shows four total public/private rows, keeps unsigned cancellations in details, and See all opens the combined history', async () => {
  const wire = JSON.parse(readFileSync(join(CONTRACTS, 'execution-v1/fixtures/status-wire.json'), 'utf8'));
  const reserved = wire.responses['status.reserved'].item;
  const planned = { ...reserved, intentId: '0x' + '34'.repeat(32), state: 'planned' };
  const cancelled = { ...reserved, intentId: '0x' + '56'.repeat(32), state: 'cancelled', canCancel: false };
  const short = fixture('activity.json'); short.items = short.items.slice(0, 3);
  const s = await scenario({ hooks: LIVE, privateReceipts: [reserved, planned, cancelled], readV6: routeOn((route) => ({ status: 200, body: about(route, route === 'activity' ? short : fixture('portfolio.json'), OWNER) })) });
  try {
    const card = s.page.locator('section[aria-labelledby="receipts-title"]');
    await card.locator('[data-v2-receipt]').first().waitFor();
    await card.locator('[data-signed-out] > summary').click();
    await card.getByRole('button', { name: 'Sign in', exact: true }).click();
    await s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Sign in', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await s.page.keyboard.press('Escape');
    await card.locator('[data-execution="ready"]').waitFor();
    assert.equal(await card.locator('[data-activity-rows]').getAttribute('data-activity-rows'), '4');
    assert.equal(await card.locator('[data-activity-rows] > [data-v2-receipt]').count(), 3);
    assert.equal(await card.locator('[data-activity-rows] > [data-execution-intent]').count(), 1);
    assert.equal(await card.locator('[data-activity-rows] [data-execution-cancelled]').count(), 0);
    assert.equal(await card.locator('[data-activity-internal]').getAttribute('open'), null);
    assert.equal(await card.locator('[data-activity-rows] time').count(), 3, 'known dates are visible without expanding a receipt');
    await card.locator('[data-receipts-all]').click();
    await s.page.locator('[data-activity-rows="5"]').waitFor();
    assert.equal(await s.page.locator('[data-activity-rows] > [data-execution-intent]').count(), 2);
    assert.match(await text(s.page.locator('[data-unified-activity]')), /Records without a date/);
    assert.equal(s.wallet.state.signed.length, 1, 'the only signature was the requested private sign-in');
    if (process.env.DOMINO_RECEIPT_SHOTS) {
      mkdirSync(process.env.DOMINO_RECEIPT_SHOTS, { recursive: true });
      for (const width of [1320, 390, 320]) {
        await s.page.setViewportSize({ width, height: 960 });
        assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await s.page.locator('[aria-labelledby="receipts-title"]').screenshot({ path: join(process.env.DOMINO_RECEIPT_SHOTS, `activity-unified-${width}.png`), animations: 'disabled' });
      }
    }
  } finally { await s.close(); }
});

test('See all continues after an older-page outage and wallet switches never retain the previous wallet rows', async () => {
  const whole = fixture('activity.json');
  const boundary = whole.items[4];
  const cursor = [boundary.tx.snapshot.timestamp, boundary.chainId, boundary.tx.snapshot.number, boundary.id.split(':')[2]].join('.');
  const first = { ...whole, items: whole.items.slice(0, 5), nextCursor: cursor };
  const older = { ...whole, items: whole.items.slice(5), nextCursor: null };
  const other = ACCOUNTS[1].address.toLowerCase();
  let tailReads = 0;
  const s = await scenario({ hooks: LIVE, hash: '#/positions/receipts', readV6: routeOn((route, request) => {
    if (route === 'portfolio') return { status: 200, body: about(route, fixture('portfolio.json'), request.wallet) };
    if (request.wallet === other) return { status: 200, body: about(route, { ...whole, items: [whole.items.at(-1)], nextCursor: null }, other) };
    if (request.cursor) {
      assert.equal(request.cursor, cursor);
      if (++tailReads === 1) return { status: 503, body: { error: 'upstream_unavailable' } };
      return { status: 200, body: about(route, older, OWNER) };
    }
    return { status: 200, body: about(route, first, OWNER) };
  }) });
  try {
    await s.page.locator('[data-activity-rows="5"]').waitFor();
    const initial = await s.page.locator('[data-v2-receipt]').evaluateAll(rows => rows.map(row => row.dataset.v2Receipt));
    await s.page.locator('[data-unified-activity]').getByRole('button', { name: 'Show more', exact: true }).click();
    await s.page.locator('[data-activity-error]').waitFor();
    assert.deepEqual(await s.page.locator('[data-v2-receipt]').evaluateAll(rows => rows.map(row => row.dataset.v2Receipt)), initial);
    await s.page.waitForFunction(() => !document.querySelector('[data-activity-error]'), null, { timeout: 15_000 });
    assert.equal(tailReads, 2);
    const ids = await s.page.locator('[data-v2-receipt]').evaluateAll(rows => rows.map(row => row.dataset.v2Receipt));
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.length > initial.length);
    assert.ok(initial.every(id => ids.includes(id)));
    assert.equal(await s.page.locator('[data-unified-activity]').getByRole('button', { name: 'Show more', exact: true }).count(), 0, 'the actual end is reached after retry');
    await s.wallet.switchAccount('a', 1);
    await s.page.waitForFunction(() => document.querySelectorAll('[data-v2-receipt]').length === 1);
    assert.equal(await s.page.locator('[data-v2-receipt]').getAttribute('data-v2-receipt'), whole.items.at(-1).id);
    assert.equal(await s.page.locator('[data-execution-intent]').count(), 0);
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

test('position Activity can continue when the first wallet page contains no matching position', async () => {
  const whole = fixture('activity.json');
  const unrelated = structuredClone(whole.items[0]);
  const created = structuredClone(whole.items.find(item => item.kind === 's1_action' && item.action === 'create'));
  const prior = created.tokenId; created.tokenId = V1_OPEN;
  for (const step of created.steps) if (step.tokenId === prior) step.tokenId = V1_OPEN;
  const cursor = [unrelated.tx.snapshot.timestamp, unrelated.chainId, unrelated.tx.snapshot.number, unrelated.id.split(':')[2]].join('.');
  const s = await scenario({ hooks: LIVE, hash: `#/positions/${V1_OPEN}`, readV6: routeOn((route, request) => ({ status: 200, body: about(route,
    route === 'portfolio' ? fixture('portfolio.json') : { ...whole, items: request.cursor ? [created] : [unrelated], nextCursor: request.cursor ? null : cursor }, OWNER) })) });
  try {
    const activity = s.page.locator('[data-position-activity]');
    await activity.getByRole('button', { name: 'Show more', exact: true }).waitFor();
    assert.equal(await activity.locator('[data-position-activity-item]').count(), 0);
    await activity.getByRole('button', { name: 'Show more', exact: true }).click();
    await activity.locator(`[data-position-activity-item="${created.id}"]`).waitFor();
    assert.ok(s.asked.some(ask => ask.route === 'activity' && ask.body?.cursor === cursor));
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

test('a public route disabled after loading keeps the unified rows visible with an update warning', async () => {
  let disabled = false;
  const s = await scenario({ hooks: LIVE, refresh: true, hash: '#/positions/receipts', readV6: routeOn((route) =>
    route === 'activity' && disabled
      ? { status: runtime.ERROR_STATUS_BY_CODE.route_not_available, body: { error: 'route_not_available' } }
      : { status: 200, body: about(route, fixture(`${route}.json`), OWNER) }) });
  try {
    await s.page.locator('[data-v2-receipt]').first().waitFor();
    const ids = await s.page.locator('[data-v2-receipt]').evaluateAll(rows => rows.map(row => row.dataset.v2Receipt));
    disabled = true;
    await s.page.clock.fastForward(60_001);
    await s.page.locator('[data-unified-activity] [data-activity-error]').waitFor();
    assert.deepEqual(await s.page.locator('[data-v2-receipt]').evaluateAll(rows => rows.map(row => row.dataset.v2Receipt)), ids);
    assert.match(await text(s.page.locator('[data-activity-error]')), /Showing loaded activity/);
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});
