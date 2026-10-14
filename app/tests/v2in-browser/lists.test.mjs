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
import { browserChain, routeChain, RPC_URL } from '../support/browser-chain.mjs';
import { closeBrowser } from '../support/close-browser.mjs';
import { edgeFetch } from '../support/edge-routes.mjs';
import { createFakeSession } from '../support/fake-session.mjs';
import { ledgerWorld, OWNER_STATE, TOKENS as LEDGER_TOKENS, UFG, USDG } from '../support/fees/ledger-world.mjs';
import { ACCOUNTS, installWallets } from '../support/mock-wallet.mjs';
import { ARTWORK } from '../support/new-position.mjs';
import { historyFor } from '../support/price-range-cases.mjs';
import { FIXTURE_TOKEN, createReadStub } from '../support/read-stub.mjs';
import { launchBrowser } from '../support/s1-browser.mjs';
import { activityOf, ethUsdPrice, indexedToken, livePosition, portfolioOf } from '../support/s1-read6.mjs';
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
  const dir = resolve(process.env.DOMINO_POSITION_SHOTS ?? join(APP, '.test-artifacts'));
  mkdirSync(dir, { recursive: true });
  return dir;
};
const EXAMPLE_WALLET = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
const V1_OPEN = '3135288';
const rowKey = (id) => `4663:${fixture('portfolio.json').positions[0].positionManager.toLowerCase()}:${id}`;
const TOKENS = { [FIXTURE_TOKEN.toLowerCase()]: { symbol: 'TOKEN', decimals: 6 } };
const STUB_KEY = { currency0: zeroAddress, currency1: FIXTURE_TOKEN.toLowerCase(), fee: 3000, tickSpacing: 60, hooks: zeroAddress };
const onChain = (tokenId) => ({ tokenId, holder: OWNER, key: STUB_KEY, tickLower: -60, tickUpper: 60, liquidity: 2n ** 100n, unclaimed: [633825300114n, 0n] });
const LIVE = { originOpen: true, backendOn: true, contracts: { 4663: contractsFor(4663), 8453: contractsFor(8453), 42161: contractsFor(42161) } };
// Changed on purpose 2026-10-06: read-v6 1.1.0-rc.1 (#363, qualified USD); the route answers its version.
const CONTRACT = '1.1.0-rc.1';
/** The read Worker's capabilities while its reads are on (bridge/src/worker.mjs; src/v2/routes.ts reads it). */
const CAPABILITIES = { contractVersion: CONTRACT, dataMode: 'live_read_only', chainIds: [4663, 8453, 42161], enabledReads: ['portfolio', 'activity'], walletAuthentication: false, privateAccounts: false, ownerTransactions: false, automation: false };

/**
 * The time under a dollar figure that is not current. Changed on purpose 2026-10-14 (package V1, review): the words
 * carry the day when the moment is not today by the page's clock ("as of 10-13 22:40 UTC"), so the cases that push the
 * page's clock forward by minutes accept it (a run across midnight UTC).
 */
const AS_OF = /^as of (\d\d-\d\d )?\d\d:\d\d UTC$/;

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
async function scenario({ hooks = null, readV6 = routeMissing, hash = '#/positions', privateReceipts = null, localCloses = [], creations = [], sessionDisabled = false, refresh = false, chainOptions = {}, stored = undefined, ledgerReply = null, connect = true, artwork = null } = {}) {
  const fake = createFakeSession();
  fake.controls.disabled = sessionDisabled;
  const chain = browserChain({ positions: [onChain(V1_OPEN)], tokens: TOKENS, ...chainOptions });
  const read = createReadStub({ stored });
  const asked = [];
  const ledgerAsked = [];
  const planAsked = [];
  const server = createWalletServer({
    fake,
    dist: WALLET_V2_DIST,
    routes: [
      async (request, url) => {
        if (url.pathname === '/api/position-plan/v1/capabilities') {
          planAsked.push(request.method);
          return Response.json({ error: 'not_found' }, { status: 404 });
        }
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
        const answer = await readV6(request.method, route, body);
        return Response.json(answer.body, { status: answer.status, headers: { ...(answer.contract ? { 'X-Domino-Read-Contract': CONTRACT } : {}), ...(answer.retryAfter ? { 'Retry-After': answer.retryAfter } : {}) } });
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
  await context.route(ARTWORK, artwork ?? ((route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })));
  await routeChain(context, chain);
  if (ledgerReply) await context.route('**/api/fees/v2/ledger', async route => {
    const body = route.request().postDataJSON();
    ledgerAsked.push(body);
    const reply = await ledgerReply(body);
    await route.fulfill({ status: reply.status, contentType: 'application/json', body: JSON.stringify(reply.body) });
  });
  const wallet = await installWallets(context);
  if (creations.length) await context.addInitScript(rows => {
    for (const owner of new Set(rows.map(row => row.wallet.toLowerCase()))) sessionStorage.setItem(`domino:created-positions:v1:${owner}`, JSON.stringify(rows.filter(row => row.wallet.toLowerCase() === owner)));
  }, creations);
  if (localCloses.length) await context.addInitScript((rows) => {
    for (const owner of new Set(rows.map(row => row.wallet.toLowerCase()))) localStorage.setItem(`domino:confirmed-closes:v1:${owner}`, JSON.stringify(rows.filter(row => row.wallet.toLowerCase() === owner)));
  }, localCloses);
  if (hooks) await context.addInitScript((value) => { window.__dominoV2Test = value; }, hooks);
  if (refresh) await context.addInitScript(() => { window.__dominoRefresh = true; });
  const page = await context.newPage();
  if (refresh) await page.clock.install();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/${hash}`);
  // Test Wallet A, from the header's dialog, on Robinhood Chain, without signing in.
  await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'no_wallet');
  if (connect) {
    await page.locator('header [aria-haspopup="dialog"]').click();
    await page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Connect Test Wallet A', exact: true }).click();
    await page.waitForFunction(expected => window.__dominoSessionProbe?.view().status === expected, sessionDisabled ? 'blocked' : 'signed_out');
    await page.keyboard.press('Escape');
  }
  return {
    page,
    asked,
    ledgerAsked,
    planAsked,
    wallet,
    // The fake chain itself, for a test that moves its head and its time (2026-10-14, package V1).
    chain,
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

for (const connect of [false, true]) test(`Robinhood V4 prefixed links load public fees and APR with S1 unavailable, wallet ${connect ? 'connected' : 'disconnected'}`, async () => {
  const tokenId = '3659830';
  const head = 71_700_000;
  const end = Math.floor(Date.now() / 1000);
  const openedAt = end - 40 * 60;
  const world = ledgerWorld({
    tokenId: BigInt(tokenId), holder: OWNER, vault: null, steps: [], head,
    now: end, mint: { block: head - 24_000, liquidity: 36_560_795_792_617_752n },
    tokens: { ...LEDGER_TOKENS, [UFG]: { symbol: 'PONS', decimals: 18 } },
  });
  const ledger = edgeFetch({ fetch: (_url, init) => world.chain.fetch(RPC_URL, init) });
  const historyReads = [];
  const s = await scenario({
    hooks: { originOpen: true }, hash: `#/positions/robinhood-v4-${tokenId}`, connect, chainOptions: world.chain,
    ledgerReply: async request => {
      const response = await ledger('/api/fees/v2/ledger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      const body = await response.json();
      const position = body.positions?.find(item => item.tokenId === tokenId);
      if (position?.mint) position.mint.sqrtPriceX96 = String(BigInt(position.state.sqrtPriceX96) * 101n / 100n);
      return { status: response.status, body };
    },
    stored: (route, body) => {
      assert.equal(route, 'history');
      const now = 1e12 / (Number(OWNER_STATE.sqrtPriceX96) / 2 ** 96) ** 2;
      const answer = historyFor({ id: Number(tokenId), now, quote: { address: USDG } }, body, { end });
      answer.candles = answer.candles.slice(-1); // The first hour supplies only its one current close.
      historyReads.push(answer);
      return JSON.stringify(answer);
    },
  });
  try {
    const detail = s.page.locator(`[data-position-detail][data-position-id="${tokenId}"]`);
    await detail.locator('[data-fees-card][data-fees-state="verified"]').waitFor();
    await detail.locator('[data-cell="apr"][data-apr="ready"]').waitFor();
    assert.match(await detail.locator('h1').innerText(), /PONS/);
    const apr = detail.locator('[data-cell="apr"]');
    assert.equal(await apr.locator('details').getAttribute('open'), null, 'period accounting starts behind its disclosure');
    await apr.getByText('Period details', { exact: true }).click();
    assert.match(await apr.innerText(), /Since opened \(40 minutes\)/);
    assert.doesNotMatch(await detail.innerText(), /Not measured on this network yet/);
    assert.equal(await s.page.locator('[data-position-v2]').count(), 0, 'the write gate never selects a different read page');
    await detail.getByRole('tab', { name: 'Price range', exact: true }).click();
    const range = detail.locator('[data-pvr-where][data-pvr-line]');
    await range.locator('.dm-pvr-line').first().waitFor();
    assert.equal(Number(await range.getAttribute('data-pvr-first')), openedAt, 'the price line starts at the verified mint measurement');
    assert.equal(Number(await range.getAttribute('data-pvr-start')), openedAt);
    const width = await range.evaluate(node => ({
      line: Math.max(...[...node.querySelectorAll('.dm-pvr-line')].map(path => path.getBBox().width)),
      plot: node.querySelector('svg').viewBox.baseVal.width || node.querySelector('svg').getBoundingClientRect().width,
    }));
    assert.ok(width.line > width.plot * 0.6, `a real price path spans the first-hour plot (${width.line}/${width.plot}), not just a dot`);
    assert.ok(historyReads.length > 0 && historyReads.every(answer => answer.candles.length === 1));
    assert.equal(s.wallet.state.signed.length, 0, 'public figures require no wallet signature');
    if (connect) {
      await detail.locator('[data-position-v2-mount="preview"]').waitFor({ state: 'attached' });
      assert.ok(s.planAsked.length > 0, 'S1 capabilities were unavailable and its actions remain preview-only');
    } else assert.equal(await s.page.locator('[data-position-actions]').count(), 0, 'public reads do not grant owner actions');
  } finally { await s.close(); }
});

const tabs = async (page) => {
  await page.getByRole('tab').first().waitFor();
  return page.getByRole('tab').allInnerTexts().then((all) => all.map((value) => value.replace(/\s+/g, ' ').trim()));
};
/** V1's open row, as V1's own suite reads it (tests/finance.browser.test.mjs). */
async function v1RowAsItIs(page) {
  const row = page.locator(`a[data-v2-position-row="${rowKey(V1_OPEN)}"]`);
  await row.waitFor();
  assert.equal(await row.getAttribute('href'), `#/positions/robinhood-v4-${V1_OPEN}`);
  assert.match(await row.innerText(), /Position #3135288/);
  assert.equal(await row.locator('[data-cell="apr"]').count(), 1, 'historical NFTs use the same APR column');
}
/** V1's two cards with nothing of V2 in them. */
async function v1CardsExact(page) {
  assert.equal(await page.locator('[data-owned] [data-v2-position-row]').count(), 1, 'the historical NFT uses the unified collection');
  assert.equal(await page.locator('[data-owned] [data-v2-examples-band], [data-owned] [data-test-data]').count(), 0);
  assert.equal(await page.locator('section[aria-labelledby="receipts-title"] [data-v2-receipt], section[aria-labelledby="receipts-title"] [data-test-data]').count(), 0, 'Receipts is V1’s own');
  assert.doesNotMatch(await text(page.locator('[data-owned]')), /Example|Test data/);
}

test('the unified collection follows external closure on reconnect, retains it through failure and fits narrow screens', async () => {
  const own = about('portfolio', fixture('portfolio.json'), OWNER);
  own.positions = [own.positions[0]];
  own.positions[0].vault = null;
  own.vaults = [];
  own.mandates = [];
  let failure = false;
  const s = await scenario({ hooks: LIVE, readV6: routeOn((route) => route === 'portfolio' && failure ? { status: 503, body: { error: 'upstream_unavailable' } } : { status: 200, body: route === 'portfolio' ? own : about('activity', fixture('activity.json'), OWNER) }) });
  try {
    await s.page.getByRole('tab', { name: /^Open 2/ }).waitFor();
    own.positions[0].state.liquidity = '0';
    own.positions[0].state.principalAtSpot = ['0', '0'];
    own.positions[0].state.snapshot.number += 10;
    await s.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await s.page.getByRole('tab', { name: /^Closed 1/ }).waitFor();
    assert.deepEqual(await tabs(s.page), ['Open 1', 'Closed 1']);
    await s.page.getByRole('tab', { name: /^Closed 1/ }).click();
    await s.page.locator(`[data-v2-position-row="${rowKey('7')}"] [data-position-status="closed"]`).waitFor();
    const closed = s.page.locator(`[data-v2-position-row="${rowKey('7')}"]`);
    assert.match(await closed.locator('[data-cell="fees"]').innerText(), /0\.0012 USDG/, 'external closure does not hide uncollected fees');
    assert.ok(await closed.locator('[data-cell="principal"]').evaluate(cell => cell.closest('.dm-own-empty-figure')?.getBoundingClientRect().height <= 1), 'known empty principal becomes a history row');
    failure = true;
    await s.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await s.page.locator('[data-owned] [data-v2-own-note="failed"]').waitFor();
    assert.deepEqual(await tabs(s.page), ['Open 1', 'Closed 1'], 'failed refresh never resurrects a closed position');
    for (const width of [1024, 736, 390, 320]) {
      await s.page.setViewportSize({ width, height: 980 });
      assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `collection and wallet fit ${width}px`);
      assert.equal(await s.page.locator('[data-owned] .dm-own-label').evaluateAll(labels => labels.filter(label => !label.closest('.dm-own-empty-figure')).every(label => label.getBoundingClientRect().right <= label.parentElement.getBoundingClientRect().right + 1)), true, `visible column labels stay in their cells at ${width}px`);
    }
    await s.page.locator('[data-owned]').screenshot({ path: join(shots(), 'positions-unified-closed-320.png'), animations: 'disabled' });
    assert.equal(s.wallet.state.signed.length, 0, 'inventory refresh requires no wallet transaction');
  } finally { await s.close(); }
});

test('the list and the detail display the same verified APR for a new V2 NFT', async () => {
  const tokenId = '3659830';
  const world = ledgerWorld({ tokenId: BigInt(tokenId), holder: OWNER, vault: null, steps: [] });
  const ledger = edgeFetch({ fetch: (_url, init) => world.chain.fetch(RPC_URL, init) });
  const own = about('portfolio', fixture('portfolio.json'), OWNER);
  own.positions = [own.positions[0]];
  own.positions[0].tokenId = tokenId;
  own.positions[0].vault = null;
  own.vaults = [];
  own.mandates = [];
  const s = await scenario({ hooks: LIVE, chainOptions: world.chain,
    readV6: routeOn(route => ({ status: 200, body: route === 'portfolio' ? own : about('activity', fixture('activity.json'), OWNER) })),
    ledgerReply: async request => {
      const response = await ledger('/api/fees/v2/ledger', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) });
      return { status: response.status, body: await response.json() };
    },
  });
  try {
    const row = s.page.locator(`[data-v2-position-row="${rowKey(tokenId)}"]`);
    const apr = row.locator('[data-cell="apr"][data-apr="ready"]');
    await apr.waitFor();
    const listText = await apr.locator('.dm-own-fig').textContent();
    assert.match(listText, /%/);
    assert.ok(s.ledgerAsked.length > 0 && s.ledgerAsked.every(request => request.tokenIds.length <= 8));
    await row.click();
    const detail = s.page.locator('[data-position-detail] [data-cell="apr"][data-apr="ready"]');
    await detail.waitFor();
    assert.ok((await detail.innerText()).includes(listText), 'one qualified financial projection in both screens');
  } finally { await s.close(); }
});

// Rewritten on purpose 2026-10-14 (the incident of 2026-10-13, package V1; the owner: "USD unavailable" must not appear
// on a position). This case held the defect: with no price the cell said "USD unavailable" and kept the two token amounts
// for screen readers and a hover title only. Now the two amounts are the cell's figure, in view, with one short reason
// per row; the columns keep their layout as before.
test('with no USD price the two token amounts are the figure, in view, with one short reason; the columns keep their layout', async () => {
  const own = about('portfolio', fixture('portfolio.json'), OWNER);
  own.positions = [own.positions[0]];
  own.positions[0].vault = null;
  own.vaults = [];
  own.mandates = [];
  const s = await scenario({ hooks: LIVE, refresh: true, readV6: routeOn(route => ({ status: 200, body: route === 'portfolio' ? own : activityOf({ wallet: OWNER }).body })) });
  try {
    const row = s.page.locator(`[data-v2-position-row="${rowKey('7')}"]`);
    const cell = row.locator('[data-cell="fees"]');
    await cell.locator('[data-usd="fees"]').waitFor();
    assert.equal(await cell.locator('[data-usd="fees"]').innerText(), '<$0.01');
    await cell.hover();
    assert.equal(await cell.locator('.dm-own-split, .dm-own-amounts').count(), 0, 'hover does not create a second visual layout');
    assert.match(await cell.getAttribute('title'), /0\.0012 USDG/);
    for (const token of own.tokens) { token.price = null; token.priceReason = 'no_qualified_price_source'; }
    own.positions[0].state.feesOwed = ['2800', '0'];
    own.positions[0].state.snapshot.number += 10;
    assert.equal(runtime.validateResponse('portfolio', own), true);
    await s.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await s.page.waitForFunction(key => document.querySelector(`[data-v2-position-row="${key}"] [data-cell="fees"]`)?.getAttribute('title')?.includes('0.0028 USDG'), rowKey('7'));
    assert.equal(await cell.locator('[data-usd], .dm-own-dash').count(), 0, 'missing pricing neither hides fees nor retains the old USD total');
    assert.match(await cell.getAttribute('title'), /^A reliable USD price isn’t available for every token held\. [\s\S]*0\.0028 USDG/, 'the reason in full, then every digit');
    const amounts = cell.locator('.dm-own-amounts[data-token-amounts]');
    assert.equal(await amounts.isVisible(), true, 'the measured fees are the figure, in view');
    assert.match(await amounts.innerText(), /0\.0028\s+USDG/);
    assert.equal(await amounts.locator('.dm-acct-amount').count(), 2);
    assert.doesNotMatch(await row.innerText(), /USD unavailable/i, 'the bare words are gone');
    assert.deepEqual(await row.locator('[data-usd-why]').allInnerTexts(), ['No reliable USD price'], 'one short reason for the row');
    assert.equal(await row.locator('[data-cell="principal"] [data-usd-why]').count(), 1, 'under the first figure that has none');
    assert.match(await row.getAttribute('data-usd-reason'), /no_qualified_price_source/);
    for (const width of [1320, 1024, 736, 390, 320]) {
      await s.page.setViewportSize({ width, height: 960 });
      assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `fees fit ${width}px`);
      assert.equal(await cell.locator('.dm-own-label').textContent(), 'Fees to collect');
      // Clipped 1px assistive text at the cell's right edge contributes to scrollWidth without painting outside it.
      const geometry = await cell.evaluate(node => {
        const bounds = node.getBoundingClientRect();
        const visible = [...node.children].filter(child => getComputedStyle(child).clip === 'auto' && getComputedStyle(child).display !== 'none');
        return { cell: bounds.toJSON(), visible: visible.map(child => ({ text: child.textContent, rect: child.getBoundingClientRect().toJSON() })) };
      });
      assert.ok(geometry.visible.every(({ rect }) => rect.left >= geometry.cell.left - 0.5 && rect.right <= geometry.cell.right + 0.5), `visible fees stay within their column at ${width}px: ${JSON.stringify(geometry)}`);
      if (width === 1320 || width === 390) await s.page.screenshot({ path: join(shots(), `positions-visible-token-fees-${width}.png`), fullPage: true });
    }
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

// Rewritten on purpose 2026-10-14 (the incident of 2026-10-13, package V1; the owner's decision D4: "the last complete
// figure with 'as of HH:MM' in place of 'USD unavailable'"). This case held the rule of #414: the kept valuation went as
// soon as any amount changed ("new balances cannot borrow earlier USD values"), which wrote "USD unavailable". Now the
// last complete valuation stays, said with its time, while the position is the same size; it goes only when the
// position's liquidity changes, and then the row shows its token amounts and a short reason, never the bare words.
test('a failed price read keeps the last complete valuation, said with its time, until the position changes size', async () => {
  const own = about('portfolio', fixture('portfolio.json'), OWNER);
  own.positions = [own.positions[0]];
  own.positions[0].vault = null; own.vaults = []; own.mandates = [];
  own.tokens[1].decimals = 18; own.tokens[1].status = 'available';
  own.servedAt = Math.floor(Date.now() / 1000);
  for (const token of own.tokens) if (token.price?.snapshot) token.price.snapshot.timestamp = own.servedAt;
  const s = await scenario({ hooks: LIVE, refresh: true, readV6: routeOn(route => ({ status: 200, body: route === 'portfolio' ? own : activityOf({ wallet: OWNER }).body })) });
  try {
    const row = s.page.locator(`[data-v2-position-row="${rowKey('7')}"]`);
    await row.locator('[data-usd="principal"]').waitFor();
    const before = await row.locator('[data-usd]').allTextContents();
    // With one anchor the fresh pool now provides its own mark. Lose both prices to exercise remembered USD.
    for (const token of own.tokens) { token.price = null; token.priceReason = 'price_read_failed'; }
    await s.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await row.locator('[data-usd="principal"][data-usd-snapshot]').waitFor();
    assert.deepEqual(await row.locator('[data-usd]').allTextContents(), before, 'principal and fees remain the same complete observation');
    assert.match(await row.locator('[data-cell="principal"]').getAttribute('title'), /^Last complete valuation, from \d\d-\d\d \d\d:\d\d UTC\. /);
    const asOf = await row.locator('[data-usd-as-of]').allInnerTexts();
    assert.equal(asOf.length, 2, 'each of the two figures says its time');
    for (const words of asOf) assert.match(words, AS_OF);
    assert.equal(await row.locator('[data-usd-as-of="principal"]').isVisible(), true, 'in view, not only for a screen reader');
    assert.equal(await row.getAttribute('data-usd-reason'), 'price_read_failed');
    // The fees grew and the index read the position again; the prices still cannot be read. The same position: its last
    // complete valuation stays, with its time, and the title has the new token amounts.
    own.positions[0].state.feesOwed[0] = '8800';
    own.positions[0].state.snapshot.number += 10;
    await s.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await s.page.waitForFunction(key => document.querySelector(`[data-v2-position-row="${key}"] [data-cell="fees"]`)?.getAttribute('title')?.includes('0.0088 USDG'), rowKey('7'));
    assert.deepEqual(await row.locator('[data-usd][data-usd-snapshot]').allTextContents(), before, 'still the last complete valuation, dated');
    assert.equal(await row.locator('[data-usd-as-of]').count(), 2);
    // A withdrawal changed its size: the figure from before would be of another position. Its tokens are the figure now.
    own.positions[0].state.liquidity = String(BigInt(own.positions[0].state.liquidity) / 2n);
    own.positions[0].state.snapshot.number += 10;
    await s.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await row.locator('[data-cell="principal"] .dm-own-amounts').waitFor();
    assert.equal(await row.locator('[data-usd], [data-usd-snapshot], [data-usd-as-of]').count(), 0, 'a valuation of another size of position is never shown');
    assert.deepEqual(await row.locator('[data-usd-why]').allInnerTexts(), ['USD price is updating']);
    assert.doesNotMatch(await s.page.locator('[data-owned]').innerText(), /USD unavailable/i);
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-14 (the incident of 2026-10-13, package V1). The owner's row said "USD unavailable" while the Wallet card
// priced tokens: a Robinhood position that is in both inventories lost its dollars 60 s after its last state reading, and
// the state route was being refused (429). Now the row is current for about two minutes, then keeps its last complete
// valuation and says its time, for as long as the route is refused; it is current again at the next reading.
test('the state route answering 429 never writes "USD unavailable": the row keeps its last valuation and says its time', async () => {
  const manager = fixture('portfolio.json').positions[0].positionManager.toLowerCase();
  const key = { currency0: USDG, currency1: UFG, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  const start = Math.floor(Date.now() / 1000);
  let ahead = 0;
  const position = livePosition({ chainId: 4663, dex: 4, manager, tokenId: V1_OPEN, owner: OWNER, pool: key, tickLower: -60, tickUpper: 60,
    liquidity: '10000000000', sqrtPriceX96: String(2n ** 96n), tick: 0, principal: ['29000000', '29000000'], feesOwed: ['2000000', '0'] });
  // The index read it before the chain's head: the state route's own reading is the newest the browser holds.
  position.state.snapshot.number = 71_600_000;
  const stable = { ...indexedToken(4663, USDG, 'USDG', 6), price: { source: 'chain_stable', usd: '1.000000000000000000', snapshot: null, pool: null, ethUsd: null, depthUsd: null }, priceReason: null };
  const own = portfolioOf({ wallet: OWNER, tokens: [stable, { ...indexedToken(4663, UFG, 'UFG', 18), priceReason: 'pool_depth_below_floor' }], positions: [position] }).body;
  const s = await scenario({ hooks: LIVE, refresh: true,
    chainOptions: { timestamp: start, positions: [{ tokenId: V1_OPEN, holder: OWNER, key, tickLower: -60, tickUpper: 60, liquidity: 10_000_000_000n, unclaimed: [2_000_000n, 0n] }], tokens: { [USDG]: { symbol: 'USDG', decimals: 6 }, [UFG]: { symbol: 'UFG', decimals: 18 } } },
    readV6: routeOn(route => ({ status: 200, body: route === 'portfolio' ? { ...own, servedAt: start + ahead } : activityOf({ wallet: OWNER }).body })) });
  try {
    const row = s.page.locator(`[data-v2-position-row="${rowKey(V1_OPEN)}"]`);
    const owned = s.page.locator('[data-owned]');
    await row.locator('[data-usd="principal"][data-usd-basis="pool-price"]').waitFor();
    await row.locator('[data-usd="fees"]').waitFor();
    assert.equal(await row.locator('[data-usd-snapshot], [data-usd-as-of]').count(), 0, 'a current figure says no time');
    const before = await row.locator('[data-usd]').allTextContents();
    assert.equal(before[1], '$2.00', '2 USDG of fees at the chain’s own reading');
    // Half a minute at a time: the portfolio is read on (new prices each time), the state route refuses every ask.
    let refused = 0;
    await s.page.route('**/api/fees/v1/state', (route) => { refused += 1; return route.fulfill({ status: 429, headers: { 'Retry-After': '5' }, contentType: 'application/json', body: JSON.stringify({ error: 'rate_limited' }) }); });
    const step = async () => {
      const asked = s.asked.filter(entry => entry.route === 'portfolio').length;
      ahead += 31;
      await s.page.clock.fastForward(31_000);
      await s.page.evaluate(() => window.dispatchEvent(new Event('online')));
      await s.page.waitForFunction(() => true);
      for (let tries = 0; tries < 50 && s.asked.filter(entry => entry.route === 'portfolio').length === asked; tries++) await new Promise(done => setTimeout(done, 100));
      assert.ok(s.asked.filter(entry => entry.route === 'portfolio').length > asked, 'the portfolio was read again');
      await s.page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    };
    for (let minute = 0; minute < 10; minute++) {
      await step();
      assert.doesNotMatch(await owned.innerText(), /USD unavailable/i, `no bare words ${ahead} s after the last reading`);
      assert.deepEqual(await row.locator('[data-usd]').allTextContents(), before, `its dollars are still there ${ahead} s after the last reading`);
    }
    assert.ok(refused > 0, 'the state route was asked, and refused');
    // Five minutes on: the last complete valuation, with its time, and why it is not current.
    await row.locator('[data-usd="principal"][data-usd-snapshot]').waitFor();
    const said = await row.locator('[data-usd-as-of]').allInnerTexts();
    assert.equal(said.length, 2);
    for (const words of said) assert.match(words, AS_OF);
    assert.equal(await row.getAttribute('data-usd-reason'), 'stale_position_or_chain');
    // Rewritten on purpose 2026-10-14 (package V1, review): the title said only "Last complete valuation, from …", so
    // the estimate lost its basis line exactly while it was also old. It says both, and so does the screen reader's line.
    assert.match(await row.locator('[data-cell="principal"]').getAttribute('title'), /^Last complete valuation, from \d\d-\d\d \d\d:\d\d UTC\. Estimated from the pool price at block \d+, converted with USDG’s qualified USD price\. This is not a sale quote\. \d[\d.]* USDG \+ /);
    assert.match(await row.locator('[data-cell="principal"] [data-usd-estimate]').textContent(), /^Estimated from the pool price at block \d+, converted with USDG’s qualified USD price\. This is not a sale quote\.$/);
    assert.equal(await row.locator('[data-cell="principal"] [data-usd="principal"]').getAttribute('data-usd-basis'), 'pool-price');
    // The route answers again, at a later block: the row is current, and says no time.
    await s.page.unroute('**/api/fees/v1/state');
    s.chain.head += 3_000;
    // The route's own handler keeps an answer five real seconds (functions/_lib/fees.ts LIVE_STATE_MS), and this suite's
    // minutes are the page's clock's, not the handler's: wait them out, so the next ask reads the chain's new head.
    await new Promise(done => setTimeout(done, 5_200));
    for (let tries = 0; tries < 8 && await row.locator('[data-usd-snapshot]').count() > 0; tries++) {
      s.chain.timestamp = start + ahead + 31;
      await step();
    }
    assert.equal(await row.locator('[data-usd-snapshot], [data-usd-as-of]').count(), 0, 'current again at the next reading');
    assert.equal(await row.getAttribute('data-usd-reason'), null);
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-14 (package V1, decision D4): "current" is about two minutes. One failed read changes nothing on the
// row; with every read failing, the figures stay and say their time once no newer answer has arrived for two minutes
// (by the page's own clock), and are current again with the next answer.
test('one failed portfolio read changes nothing; with every read failing the figures stay and say their time after two minutes', async () => {
  const own = about('portfolio', fixture('portfolio.json'), OWNER);
  own.positions = [own.positions[0]];
  own.positions[0].vault = null; own.vaults = []; own.mandates = [];
  own.tokens[1].decimals = 18; own.tokens[1].status = 'available';
  own.servedAt = Math.floor(Date.now() / 1000);
  for (const token of own.tokens) if (token.price?.snapshot) token.price.snapshot.timestamp = own.servedAt;
  let failing = false;
  const s = await scenario({ hooks: LIVE, refresh: true, readV6: routeOn(route => route === 'portfolio' && failing ? { status: 503, body: { error: 'upstream_unavailable' } } : { status: 200, body: route === 'portfolio' ? own : activityOf({ wallet: OWNER }).body }) });
  try {
    const row = s.page.locator(`[data-v2-position-row="${rowKey('7')}"]`);
    await row.locator('[data-usd="principal"]').waitFor();
    const before = await row.locator('[data-usd]').allTextContents();
    failing = true;
    await s.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await s.page.locator('[data-owned] [data-v2-own-note="failed"]').waitFor();
    assert.deepEqual(await row.locator('[data-usd]').allTextContents(), before);
    assert.equal(await row.locator('[data-usd-as-of], [data-usd-snapshot]').count(), 0, 'a figure is current for about two minutes, whatever the newest attempt did');
    await s.page.clock.fastForward(121_000);
    await row.locator('[data-usd-as-of="principal"]').waitFor();
    assert.deepEqual(await row.locator('[data-usd]').allTextContents(), before, 'the last figures stay');
    for (const words of await row.locator('[data-usd-as-of]').allInnerTexts()) assert.match(words, AS_OF);
    assert.equal(await row.locator('[data-usd-as-of]').count(), 2);
    assert.doesNotMatch(await s.page.locator('[data-owned]').innerText(), /USD unavailable/i);
    // Added 2026-10-14 (package V1, review). The two minutes were counted from the mount of whichever screen drew the
    // answer, and the reader keeps the last good answer across screens: on every way back the list showed its old
    // figures with no time for two more minutes (and so did a position opened from it). An old answer is old at once.
    const said = await row.locator('[data-usd-as-of]').allInnerTexts();
    await s.page.evaluate(() => { location.hash = '#/docs'; });
    await row.waitFor({ state: 'detached' });
    await s.page.evaluate(() => { location.hash = '#/positions'; });
    await row.locator('[data-usd="principal"]').waitFor();
    assert.deepEqual(await row.locator('[data-usd-as-of]').allInnerTexts(), said, 'the list on the way back says the time at once, with no two minutes to wait again');
    assert.deepEqual(await row.locator('[data-usd]').allTextContents(), before);
    // The next answer: current again, no time under the figures.
    failing = false;
    own.servedAt += 200;
    // Past the wait a failed read named for the next one (./read.ts readAgainAfter: a minute at most).
    await s.page.clock.fastForward(61_000);
    await s.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await row.locator('[data-usd-as-of]').first().waitFor({ state: 'detached' });
    assert.deepEqual(await row.locator('[data-usd]').allTextContents(), before);
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-14 (package V1, review). A USDG pair that read-v6 does not join (here it does not list the NFT) has its
// dollars from the site's own inventory alone, with USDG at $1: a constant, so the figure was "current" whatever the age
// of its reading, and such a row was exempt from the list's "as of". Nothing polls the inventory: with the state route
// refused, half-hour-old dollars were drawn as current, with no time and no badge. The row is dated by its own reading.
test('a dollar row only the site’s inventory lists says its time once its own reading is two minutes old', async () => {
  const key = { currency0: USDG, currency1: UFG, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  const start = Math.floor(Date.now() / 1000);
  let ahead = 0;
  // read-v6 answers, and says nothing of this NFT nor of its tokens.
  const none = portfolioOf({ wallet: OWNER, tokens: [], positions: [] }).body;
  const s = await scenario({ hooks: LIVE, refresh: true,
    chainOptions: { timestamp: start, positions: [{ tokenId: V1_OPEN, holder: OWNER, key, tickLower: -60, tickUpper: 60, liquidity: 10_000_000_000n, unclaimed: [2_000_000n, 0n] }], tokens: { [USDG]: { symbol: 'USDG', decimals: 6 }, [UFG]: { symbol: 'UFG', decimals: 18 } } },
    readV6: routeOn(route => ({ status: 200, body: route === 'portfolio' ? { ...none, servedAt: start + ahead } : activityOf({ wallet: OWNER }).body })) });
  try {
    const row = s.page.locator(`[data-v2-position-row="${rowKey(V1_OPEN)}"]`);
    const cell = row.locator('[data-cell="principal"]');
    await row.locator('[data-usd="principal"][data-usd-basis="pool-price"]').waitFor();
    await row.locator('[data-usd="fees"]').waitFor();
    const before = await row.locator('[data-usd]').allTextContents();
    assert.equal(before[1], '$2.00', '2 USDG of fees, with USDG at $1');
    assert.match(await cell.getAttribute('title'), /^Estimated from the pool price at block \d+, with USDG at \$1\. This is not a sale quote\. /);
    assert.equal(await row.locator('[data-usd-as-of], [data-usd-snapshot]').count(), 0, 'a current figure says no time');
    // The state route refuses every ask from here on; the portfolio is read on, and still says nothing of this NFT.
    let refused = 0;
    await s.page.route('**/api/fees/v1/state', (route) => { refused += 1; return route.fulfill({ status: 429, headers: { 'Retry-After': '5' }, contentType: 'application/json', body: JSON.stringify({ error: 'rate_limited' }) }); });
    // What the page draws after its timers ran (real time: the page's clock is this suite's, its drawing is not).
    const settle = () => new Promise(done => setTimeout(done, 250));
    for (const seconds of [31, 31, 31]) {
      ahead += seconds;
      await s.page.clock.fastForward(seconds * 1000);
      await settle();
      assert.deepEqual(await row.locator('[data-usd]').allTextContents(), before);
      assert.equal(await row.locator('[data-usd-as-of]').count(), 0, `current ${ahead} s after its reading: about two minutes, whatever the newest attempt did`);
    }
    for (const seconds of [31, 31, 31, 31, 31, 31]) {
      ahead += seconds;
      await s.page.clock.fastForward(seconds * 1000);
      await settle();
    }
    // Five minutes with nothing newer: the same dollars, each with the time of the reading they are of, and the basis.
    await row.locator('[data-usd-as-of="principal"]').waitFor();
    assert.ok(refused > 0, 'the state route was asked, and refused');
    assert.deepEqual(await row.locator('[data-usd]').allTextContents(), before, 'the last figures stay');
    const said = await row.locator('[data-usd-as-of]').allInnerTexts();
    assert.equal(said.length, 2, 'each of the two figures says its time (neither did until 2026-10-14)');
    for (const words of said) assert.match(words, AS_OF);
    assert.equal(await row.locator('[data-usd-as-of="principal"]').isVisible(), true);
    assert.match(await cell.getAttribute('title'), /^Last complete valuation, from \d\d-\d\d \d\d:\d\d UTC\. Estimated from the pool price at block \d+, with USDG at \$1\. This is not a sale quote\. /);
    assert.doesNotMatch(await s.page.locator('[data-owned]').innerText(), /USD unavailable/i);
    // The route answers again, at a later block: the row is current, and says no time.
    await s.page.unroute('**/api/fees/v1/state');
    s.chain.head += 3_000;
    // The route's own handler keeps an answer five real seconds (functions/_lib/fees.ts LIVE_STATE_MS).
    await new Promise(done => setTimeout(done, 5_200));
    for (let tries = 0; tries < 8 && await row.locator('[data-usd-as-of]').count() > 0; tries++) {
      ahead += 31;
      s.chain.timestamp = start + ahead;
      await s.page.clock.fastForward(31_000);
      await s.page.evaluate(() => window.dispatchEvent(new Event('online')));
      await settle();
    }
    assert.equal(await row.locator('[data-usd-as-of], [data-usd-snapshot]').count(), 0, 'current again at the next reading');
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-14 (package V1, review), the other side of the case above: a healthy list never says "as of". The rows
// were worked out again only when the portfolio reader drew something (./source.ts reprojects a good answer; a failed
// one is a new reply): with no good answer held and none coming (here read-v6 answers what its contract refuses, which is
// asked again only after five minutes), a row of the site's own inventory stayed on an older reading than the list's
// state read kept bringing. Dated by that reading, it would say "as of" on a page whose state route answers.
test('with no portfolio answer coming, an inventory row follows the state route’s readings and never says "as of" while it answers', async () => {
  const key = { currency0: USDG, currency1: UFG, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  const start = Math.floor(Date.now() / 1000);
  const s = await scenario({ hooks: LIVE, refresh: true, readV6: routeOn(() => ({ status: 200, body: { not: 'a portfolio' } })),
    chainOptions: { timestamp: start, positions: [{ tokenId: V1_OPEN, holder: OWNER, key, tickLower: -60, tickUpper: 60, liquidity: 10_000_000_000n, unclaimed: [2_000_000n, 0n] }], tokens: { [USDG]: { symbol: 'USDG', decimals: 6 }, [UFG]: { symbol: 'UFG', decimals: 18 } } } });
  try {
    const row = s.page.locator(`[data-v2-position-row="${rowKey(V1_OPEN)}"]`);
    await row.locator('[data-usd="principal"][data-usd-basis="pool-price"]').waitFor();
    const before = await row.locator('[data-usd]').allTextContents();
    const first = Number(await row.getAttribute('data-position-block'));
    assert.ok(first > 0);
    // Five reads of the list, half a minute apart, the chain 300 blocks further each time.
    for (let read = 1; read <= 5; read++) {
      s.chain.head += 300;
      s.chain.timestamp = start + read * 31;
      // The route's own handler keeps an answer five real seconds (functions/_lib/fees.ts LIVE_STATE_MS).
      await new Promise(done => setTimeout(done, 5_200));
      await s.page.clock.fastForward(31_000);
      await s.page.waitForFunction(([selector, block]) => Number(document.querySelector(selector)?.getAttribute('data-position-block')) >= block, [`[data-v2-position-row="${rowKey(V1_OPEN)}"]`, first + read * 300]);
      assert.equal(await row.locator('[data-usd-as-of], [data-usd-snapshot]').count(), 0, `${read * 31} s on, with a reading of this half minute: current, no time`);
      assert.deepEqual(await row.locator('[data-usd]').allTextContents(), before);
    }
    assert.equal(s.asked.filter(entry => entry.route === 'portfolio').length, 1, 'read-v6’s refused answer was not asked again in these minutes');
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-14 (package V1, review). Robinhood Chain's own position page took its prices from the CONNECTED wallet's
// portfolio only, so "the page shows its row's dollars" held for an owner on his own position. A visitor who opened one
// (no wallet, or one that holds neither token) saw the page's own USDG rule, a different figure, and token amounts for
// ETH / token. The page now also takes the OWNER's answer, the one the owner's row is valued with. No request is added:
// the page's Activity already reads the owner's portfolio through the same reader and key, once per half minute.
test('a visitor’s position page shows the dollars of the owner’s row, from the owner’s portfolio its Activity already reads, and adds no request', async () => {
  const manager = fixture('portfolio.json').positions[0].positionManager.toLowerCase();
  const key = { currency0: zeroAddress, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  const at = Math.floor(Date.now() / 1000);
  const position = livePosition({ chainId: 4663, dex: 4, manager, tokenId: V1_OPEN, owner: OWNER, pool: key, tickLower: -60, tickUpper: 60,
    liquidity: '1000000000', sqrtPriceX96: String(2n ** 96n), tick: 0, principal: ['1', '1'], feesOwed: [String(10n ** 15n), '0'] });
  position.state.snapshot.number = 71_600_000;
  const eth = { ...indexedToken(4663, zeroAddress, 'ETH', 18), price: ethUsdPrice(4663, '4000.000000000000000000', at), priceReason: null };
  const stable = { ...indexedToken(4663, USDG, 'USDG', 6), price: { source: 'chain_stable', usd: '1.000000000000000000', snapshot: null, pool: null, ethUsd: null, depthUsd: null }, priceReason: null };
  const own = portfolioOf({ wallet: OWNER, tokens: [eth, stable], positions: [position] }).body;
  let failing = false, ahead = 0;
  // Opened by its link, with no wallet and no list before it: the hardest case (nothing in this tab's memory).
  const s = await scenario({ hooks: LIVE, connect: false, refresh: true, hash: `#/positions/robinhood-v4-${V1_OPEN}`,
    chainOptions: { timestamp: at, positions: [{ tokenId: V1_OPEN, holder: OWNER, key, tickLower: -60, tickUpper: 60, liquidity: 1_000_000_000n, unclaimed: [10n ** 15n, 0n] }], tokens: { [USDG]: { symbol: 'USDG', decimals: 6 } } },
    readV6: routeOn(route => (route === 'portfolio' && failing ? { status: 503, body: { error: 'upstream_unavailable' } } : { status: 200, body: route === 'portfolio' ? { ...own, servedAt: at + ahead } : activityOf({ wallet: OWNER }).body })) });
  const portfolios = () => s.asked.filter(entry => entry.route === 'portfolio');
  const until = async (count) => { for (let tries = 0; tries < 60 && portfolios().length < count; tries++) await new Promise(done => setTimeout(done, 100)); };
  try {
    const detail = s.page.locator(`[data-position-detail][data-position-id="${V1_OPEN}"]`);
    const value = detail.locator('[data-cell="principal"] [data-usd="principal"]'), fees = detail.locator('[data-cell="fees"] [data-usd="fees"]');
    // Both tokens at read-v6's qualified prices, as the owner's row has them: 0.001 ETH of fees at $4,000 a coin. The
    // page's own rule (USDG at $1 and this pool's price, where one wei of ETH is one unit of USDG) says $1,000,000,000.
    await value.waitFor();
    await fees.waitFor();
    assert.equal(await s.page.locator('[data-position-v2]').count(), 0, 'Robinhood Chain’s own position page');
    assert.equal(await fees.textContent(), '$4.00', 'the owner’s row’s dollars (the page’s own USDG rule until 2026-10-14)');
    assert.deepEqual([await value.getAttribute('data-usd-basis'), await fees.getAttribute('data-usd-basis')], ['qualified-prices', 'qualified-prices']);
    assert.match(await value.getAttribute('title'), /^Qualified valuation at block \d+$/);
    assert.equal(await detail.locator('[data-usd-as-of], [data-usd-why]').count(), 0, 'a current figure says no time');
    const shown = [await value.textContent(), await fees.textContent()];
    // One read of the owner's portfolio, the page's Activity's own; then one per half minute, never two.
    assert.equal(portfolios().length, 1);
    assert.ok(JSON.stringify(portfolios()[0].body).toLowerCase().includes(OWNER), 'about the position’s owner');
    for (let read = 2; read <= 4; read++) {
      ahead += 31;
      await s.page.clock.fastForward(31_000);
      await until(read);
      await new Promise(done => setTimeout(done, 300));
      assert.equal(portfolios().length, read, `${(read - 1) * 31} s on the page: ${read} reads of the owner’s portfolio, one per half minute, as before this part read it too`);
    }
    assert.deepEqual([await value.textContent(), await fees.textContent()], shown);
    assert.equal(await detail.locator('[data-usd-as-of]').count(), 0, 'a healthy page says no time');
    // read-v6 goes away: the same figures stay, and say their time once nothing newer has arrived for two minutes.
    failing = true;
    await s.page.clock.fastForward(125_000);
    await detail.locator('[data-usd-as-of="principal"]').waitFor();
    assert.deepEqual([await value.textContent(), await fees.textContent()], shown, 'the last figures stay');
    for (const words of await detail.locator('[data-position-stats] [data-usd-as-of]').allInnerTexts()) assert.match(words, AS_OF);
    assert.doesNotMatch(await detail.locator('[data-position-stats]').innerText(), /USD unavailable/i);
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

// Added 2026-10-14 (package V1; the owner's decision D3). The owner's ETH / IMD position showed dollars in its row and
// token amounts on its own page: Robinhood Chain's page valued a pair with USDG only. One valuation now: the same
// dollars in both, at the pool's own price with ETH's qualified price, and the basis said on the page.
test('an ETH / token position shows the same dollars on its own page as in its row, with the basis said', async () => {
  const manager = fixture('portfolio.json').positions[0].positionManager.toLowerCase();
  const key = { currency0: zeroAddress, currency1: UFG, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  const at = Math.floor(Date.now() / 1000);
  const position = livePosition({ chainId: 4663, dex: 4, manager, tokenId: V1_OPEN, owner: OWNER, pool: key, tickLower: -60, tickUpper: 60,
    liquidity: String(10n ** 18n), sqrtPriceX96: String(2n ** 96n), tick: 0, principal: ['1', '1'], feesOwed: [String(10n ** 15n), '0'] });
  position.state.snapshot.number = 71_600_000;
  const eth = { ...indexedToken(4663, zeroAddress, 'ETH', 18), price: ethUsdPrice(4663, '4000.000000000000000000', at), priceReason: null };
  const own = portfolioOf({ wallet: OWNER, tokens: [eth, { ...indexedToken(4663, UFG, 'UFG', 18), priceReason: 'pool_depth_below_floor' }], positions: [position] }).body;
  const s = await scenario({ hooks: LIVE,
    chainOptions: { timestamp: at, positions: [{ tokenId: V1_OPEN, holder: OWNER, key, tickLower: -60, tickUpper: 60, liquidity: 10n ** 18n, unclaimed: [10n ** 15n, 0n] }], tokens: { [UFG]: { symbol: 'UFG', decimals: 18 } } },
    readV6: routeOn(route => ({ status: 200, body: route === 'portfolio' ? own : activityOf({ wallet: OWNER }).body })) });
  try {
    const row = s.page.locator(`[data-v2-position-row="${rowKey(V1_OPEN)}"]`);
    await row.locator('[data-usd="principal"][data-usd-basis="pool-price"]').waitFor();
    // The fees are in ETH alone: at ETH's own qualified price, with no pool mark to say.
    await row.locator('[data-usd="fees"][data-usd-basis="qualified-prices"]').waitFor();
    const inRow = await row.locator('[data-usd]').allTextContents();
    // 0.001 ETH of fees at $4,000 a coin: ordinary arithmetic, no valuation helper.
    assert.equal(inRow[1], '$4.00');
    assert.match(inRow[0], /^\$\d+\.\d\d$/);
    assert.match(await row.locator('[data-cell="principal"]').getAttribute('title'), /pool price.*ETH.*qualified USD price/i);
    // Added 2026-10-14 (package V1, review). read-v6 cannot read ETH's price for the moment ("eth_usd_stale"; UFG's
    // standing reason beside it): the estimate stays, with its time and its basis. That standing reason cleared the kept
    // valuation, so the owner's own kind of row fell back to token amounts and "USD price is updating".
    const priced = own.tokens[0].price;
    own.tokens[0] = { ...own.tokens[0], price: null, priceReason: 'eth_usd_stale' };
    await s.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await row.locator('[data-usd="principal"][data-usd-snapshot]').waitFor();
    assert.deepEqual(await row.locator('[data-usd]').allTextContents(), inRow, 'the same dollars');
    assert.equal(await row.getAttribute('data-usd-reason'), 'eth_usd_stale,pool_depth_below_floor');
    const dated = await row.locator('[data-usd-as-of]').allInnerTexts();
    assert.equal(dated.length, 2, 'each figure says its time');
    for (const words of dated) assert.match(words, AS_OF);
    assert.match(await row.locator('[data-cell="principal"]').getAttribute('title'), /^Last complete valuation, from \d\d-\d\d \d\d:\d\d UTC\. Estimated from the pool price at block \d+, converted with ETH’s qualified USD price\. This is not a sale quote\. /, 'the time and the basis, both');
    assert.match(await row.locator('[data-cell="fees"]').getAttribute('title'), /^Last complete valuation, from \d\d-\d\d \d\d:\d\d UTC\. 0\.001 ETH/, 'the fees were at ETH’s own price: no estimate to say');
    assert.doesNotMatch(await row.innerText(), /USD price is updating|USD unavailable/i);
    own.tokens[0] = { ...own.tokens[0], price: priced, priceReason: null };
    await s.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await row.locator('[data-usd="principal"]:not([data-usd-snapshot])').waitFor();
    assert.deepEqual(await row.locator('[data-usd]').allTextContents(), inRow);
    assert.equal(await row.locator('[data-usd-as-of]').count(), 0, 'current again with the next priced answer');
    await row.click();
    const detail = s.page.locator(`[data-position-detail][data-position-id="${V1_OPEN}"]`);
    const value = detail.locator('[data-cell="principal"] [data-usd="principal"]'), fees = detail.locator('[data-cell="fees"] [data-usd="fees"]');
    await value.waitFor();
    await fees.waitFor();
    assert.equal(await s.page.locator('[data-position-v2]').count(), 0, 'Robinhood Chain’s own position page');
    assert.deepEqual([await value.textContent(), await fees.textContent()], inRow, 'one valuation: the page and the row show the same dollars (token amounts on the page until 2026-10-14)');
    assert.equal(await value.getAttribute('data-usd-basis'), 'pool-price');
    assert.match(await value.getAttribute('title'), /^Estimated from the pool price at block \d+, converted with ETH’s qualified USD price\. This is not a sale quote\.$/, 'the estimate names the pool mark and its qualified anchor');
    assert.equal(await fees.getAttribute('data-usd-basis'), 'qualified-prices');
    assert.match(await fees.getAttribute('title'), /^Qualified valuation at block \d+$/);
    assert.equal(await detail.locator('[data-usd-as-of], [data-usd-why]').count(), 0, 'a current figure says no time and needs no reason');
    assert.doesNotMatch(await detail.innerText(), /USD unavailable/i);
    const details = detail.locator('[data-position-details]');
    await details.locator('summary').click();
    assert.match(await details.locator('[data-usd-detail]').innerText(), /^Estimated from the pool price at block \d+, converted with ETH’s qualified USD price\./, 'and Details says it in words anyone can read on a phone');
    // The token amounts are one step away, as on every valued position.
    await detail.locator('[data-cell="principal"] details summary').click();
    assert.match(await detail.locator('[data-cell="principal"] [data-stat="principal"]').innerText(), /ETH[\s\S]*UFG/);
    for (const width of [1280, 390, 320]) {
      await s.page.setViewportSize({ width, height: 960 });
      assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `the valued page fits ${width}px`);
    }
    assert.equal(s.wallet.state.signed.length, 0, 'valuation needs no wallet signature');
  } finally { await s.close(); }
});

test('a portfolio price-budget miss is recovered through the existing targeted chain-pools route and one coherent reread', async () => {
  const pools = fixture('chain-pools.json'), token = pools.tokens.find(token => token.address === pools.token);
  const usdc = pools.tokens.find(token => token.symbol === 'USDC'), manager = '0x03a520b32c04bf3beef7beb72e919cf822ed34f1';
  const ready = portfolioOf({ wallet: OWNER, tokens: [token, usdc].map(token => ({ ...token, chainId: 8453 })), positions: [
    livePosition({ chainId: 8453, dex: 3, manager, tokenId: '6238188', owner: OWNER,
      pool: { currency0: token.address, currency1: usdc.address, fee: 3000, tickSpacing: 60 }, tickLower: -60, tickUpper: 60, liquidity: '1000000000', sqrtPriceX96: String(2n ** 96n), tick: 0,
      principal: ['1000000000000000000', '1000000'], feesOwed: ['100000000000000', '10000'] }),
  ] }).body;
  const missing = structuredClone(ready);
  missing.tokens.find(item => item.address === token.address).price = null;
  missing.tokens.find(item => item.address === token.address).priceReason = 'pricing_limit_reached';
  let warmed = false, release;
  const pending = new Promise(resolve => { release = resolve; });
  const s = await scenario({ hooks: LIVE, refresh: true, readV6: async (method, route) => {
    if (route === 'capabilities') return { status: 200, body: { ...CAPABILITIES, enabledReads: [...CAPABILITIES.enabledReads, 'chain-pools'] }, contract: true };
    if (route === 'chain-pools') { await pending; warmed = true; return { status: 200, body: pools, contract: true }; }
    return { status: 200, body: route === 'portfolio' ? warmed ? ready : missing : activityOf({ wallet: OWNER }).body, contract: true };
  } });
  try {
    const row = s.page.locator(`[data-v2-position-row="8453:${manager}:6238188"]`);
    await row.locator('[data-usd="principal"][data-usd-basis="pool-price"]').waitFor();
    assert.equal(await row.locator('[data-usd="fees"]').getAttribute('data-usd-basis'), 'pool-price', 'the remaining USDC anchor supplies a provisional pool mark');
    assert.match(await row.locator('[data-cell="principal"]').getAttribute('title'), /pool price/i);
    release();
    await row.locator('[data-usd="principal"][data-usd-basis="qualified-prices"]').waitFor();
    assert.equal(await row.locator('[data-usd="principal"]').textContent(), '$1,001.03');
    assert.equal(await row.locator('[data-usd="fees"]').textContent(), '$0.11');
    const targets = s.asked.filter(request => request.route === 'chain-pools');
    assert.deepEqual(targets.map(request => request.body), [{ chainId: 8453, token: token.address }], 'the target uses its full address and chain, never a paired pool or another provider');
    assert.equal(s.asked.filter(request => request.route === 'portfolio').length, 2, 'one initial portfolio plus one coherent reread');
    warmed = false;
    await s.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await row.locator('[data-usd="principal"][data-usd-basis="pool-price"]').waitFor();
    assert.equal(s.asked.filter(request => request.route === 'chain-pools').length, 1, 'the same missing source waits for its cooldown');
    ready.positions[0].state.principalAtSpot[0] = '2000000000000000000';
    ready.positions[0].state.feesOwed[1] = '20000';
    await s.page.clock.fastForward(60_001);
    await row.locator('[data-usd="principal"]').filter({ hasText: '$2,001.06' }).waitFor();
    assert.equal(s.asked.filter(request => request.route === 'chain-pools').length, 2, 'a later transient miss can warm the expired source again');
    assert.equal(await row.locator('[data-usd="fees"]').textContent(), '$0.12');
    await s.page.evaluate(() => { location.hash = '#/positions/base-v3-6238188'; });
    await s.page.locator('[data-position-detail] [data-usd="principal"]').filter({ hasText: '$2,001.06' }).waitFor();
    assert.equal(await s.page.locator('[data-position-detail] [data-usd="fees"]').textContent(), '$0.12', 'detail and list use the newly read complete amounts and prices');
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { release(); await s.close(); }
});

test('a first targeted price read that is rate limited recovers on a later visible poll after Retry-After', async () => {
  const pools = fixture('chain-pools.json'), token = pools.tokens.find(token => token.address === pools.token);
  const usdc = pools.tokens.find(token => token.symbol === 'USDC'), manager = '0x03a520b32c04bf3beef7beb72e919cf822ed34f1';
  const ready = portfolioOf({ wallet: OWNER, tokens: [token, usdc].map(token => ({ ...token, chainId: 8453 })), positions: [
    livePosition({ chainId: 8453, dex: 3, manager, tokenId: '6238189', owner: OWNER,
      pool: { currency0: token.address, currency1: usdc.address, fee: 3000, tickSpacing: 60 }, tickLower: -60, tickUpper: 60, liquidity: '1000000000', sqrtPriceX96: String(2n ** 96n), tick: 0,
      principal: ['1000000000000000000', '1000000'], feesOwed: ['100000000000000', '10000'] }),
  ] }).body;
  const missing = structuredClone(ready);
  missing.tokens.find(item => item.address === token.address).price = null;
  missing.tokens.find(item => item.address === token.address).priceReason = 'price_read_failed';
  let attempts = 0, warmed = false, limited, releaseLimit;
  const firstAttempt = new Promise(resolve => { limited = resolve; });
  const limitReply = new Promise(resolve => { releaseLimit = resolve; });
  const s = await scenario({ hooks: LIVE, refresh: true, readV6: async (method, route) => {
    if (route === 'capabilities') return { status: 200, body: { ...CAPABILITIES, enabledReads: [...CAPABILITIES.enabledReads, 'chain-pools'] }, contract: true };
    if (route === 'chain-pools') {
      if (++attempts === 1) { limited(); await limitReply; return { status: 429, body: { error: 'read_capacity_busy' }, retryAfter: '120', contract: true }; }
      warmed = true; return { status: 200, body: pools, contract: true };
    }
    return { status: 200, body: route === 'portfolio' ? warmed ? ready : missing : activityOf({ wallet: OWNER }).body, contract: true };
  } });
  try {
    const row = s.page.locator(`[data-v2-position-row="8453:${manager}:6238189"]`);
    await row.locator('[data-usd="principal"][data-usd-basis="pool-price"]').waitFor();
    await firstAttempt;
    const response = s.page.waitForResponse(response => response.url().endsWith('/api/read/v6/chain-pools') && response.status() === 429);
    releaseLimit(); await (await response).finished();
    await s.page.clock.fastForward(60_001);
    await s.page.evaluate(() => window.dispatchEvent(new Event('online')));
    assert.equal(attempts, 1, 'the one-minute token cooldown cannot override the longer reader Retry-After');
    assert.equal(await row.locator('[data-usd="principal"]').getAttribute('data-usd-basis'), 'pool-price', 'the qualified recovery cannot finish during the rate-limit window');
    await s.page.clock.fastForward(60_001);
    await row.locator('[data-usd="principal"][data-usd-basis="qualified-prices"]').waitFor();
    assert.equal(await row.locator('[data-usd="principal"]').textContent(), '$1,001.03');
    assert.equal(await row.locator('[data-usd="fees"]').textContent(), '$0.11');
    assert.equal(attempts, 2, 'the failed first attempt never disables recovery for the rest of the visit');
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { releaseLimit(); await s.close(); }
});

// Rewritten on purpose 2026-10-14 (package V1): the cells said "USD unavailable" over amounts kept for a title; the
// two token amounts are now the cells' figures, in view, with one short reason for the row. Still no invented USD or APR.
test('Base without qualified USD shows its token amounts as the figures, with a short reason, without inventing USD or APR', async () => {
  const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const basecat = '0xb2000000000000000000004c27f6523082f41d01';
  const manager = '0x03a520b32c04bf3beef7beb72e919cf822ed34f1';
  const own = portfolioOf({ wallet: OWNER, tokens: [indexedToken(8453, usdc, 'USDC', 6), indexedToken(8453, basecat, 'BASECAT', 18)], positions: [
    livePosition({ chainId: 8453, dex: 3, manager, tokenId: '6238157', owner: OWNER,
      pool: { currency0: usdc, currency1: basecat, fee: 3000, tickSpacing: 60 }, tickLower: -60, tickUpper: 60, liquidity: '1000000000', sqrtPriceX96: String(2n ** 96n), tick: 0,
      principal: ['412537', '22675000000000000000'], feesOwed: ['5193', '317608000000000000'] }),
  ] });
  const s = await scenario({ hooks: LIVE, readV6: routeOn(route => route === 'portfolio' ? own : activityOf({ wallet: OWNER })) });
  try {
    const row = s.page.locator(`[data-v2-position-row="8453:${manager}:6238157"]`);
    const fees = row.locator('[data-cell="fees"]');
    await fees.locator('.dm-own-amounts').waitFor();
    assert.match(await fees.locator('.dm-own-amounts').innerText(), /0\.005193\s+USDC\s+0\.317608\s+BASECAT/, 'the fees, in tokens, in view');
    assert.match(await row.locator('[data-cell="principal"] .dm-own-amounts').innerText(), /0\.412537\s+USDC\s+22\.675\s+BASECAT/);
    assert.match(await fees.getAttribute('title'), /0\.005193 USDC \+ 0\.317608 BASECAT/);
    assert.match(await row.locator('[data-cell="principal"]').getAttribute('title'), /0\.412537 USDC \+ 22\.675 BASECAT/);
    assert.equal(await row.locator('[data-usd]').count(), 0);
    assert.deepEqual(await row.locator('[data-usd-why]').allInnerTexts(), ['No reliable USD price']);
    assert.doesNotMatch(await row.innerText(), /USD unavailable/i);
    assert.equal(await row.locator('[data-cell="apr"] .dm-own-dash').innerText(), '—');
    assert.ok(s.ledgerAsked.every(request => !request.tokenIds.includes('6238157')), 'a Base NFT never goes to the Robinhood ledger');
    for (const width of [1320, 390, 320]) {
      await s.page.setViewportSize({ width, height: 960 });
      assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.equal(await fees.locator('.dm-own-amounts').isVisible(), true);
      assert.equal(await row.locator('.dm-own-amounts, [data-usd-why]').evaluateAll((nodes) => nodes.every((node) => { const cell = node.closest('.dm-own-cell').getBoundingClientRect(), box = node.getBoundingClientRect(); return box.left >= cell.left - 0.5 && box.right <= cell.right + 0.5; })), true, `the amounts and the reason stay inside their cells at ${width}px`);
      assert.equal(await s.page.locator('.dm-acct-token-units').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height <= parseFloat(getComputedStyle(node).lineHeight) + 0.5)), true, 'even an extreme balance remains one line');
      if (width !== 320) await s.page.screenshot({ path: join(shots(), `positions-base-visible-fees-${width}.png`), fullPage: true });
    }
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

for (const network of [
  { name: 'Base', key: 'base', chainId: 8453, usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', manager: '0x03a520b32c04bf3beef7beb72e919cf822ed34f1' },
  { name: 'Arbitrum', key: 'arbitrum', chainId: 42161, usdc: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', manager: '0xc36442b4a4522e871399cd717abdd847ab11fe88' },
]) test(`pool-price USD: ${network.name} list and detail share one anchored valuation`, async () => {
  const testToken = '0xb200000000000000000000000000000000000001';
  const tokenId = '6238157';
  const anchor = { ...indexedToken(network.chainId, network.usdc, 'USDC', 6),
    price: { source: 'chain_stable', usd: '1.000000000000000000', snapshot: null, pool: null, ethUsd: null, depthUsd: null }, priceReason: null };
  const unpriced = { ...indexedToken(network.chainId, testToken, 'TEST', 6), priceReason: 'pool_depth_below_floor' };
  // Equal decimals and sqrtPriceX96 = 2^96: exactly one TEST per USDC. No valuation helper computes the expectations.
  // Principal: 2 USDC + 3 TEST = $5.00. Fees: 0.25 USDC + 0.5 TEST = $0.75.
  const own = portfolioOf({ wallet: OWNER, tokens: [anchor, unpriced], positions: [
    livePosition({ chainId: network.chainId, dex: 3, manager: network.manager, tokenId, owner: OWNER,
      pool: { currency0: network.usdc, currency1: testToken, fee: 3000, tickSpacing: 60 }, tickLower: -60, tickUpper: 60,
      liquidity: '1000000000', sqrtPriceX96: String(2n ** 96n), tick: 0,
      principal: ['2000000', '3000000'], feesOwed: ['250000', '500000'] }),
  ] });
  const s = await scenario({ hooks: LIVE, readV6: routeOn(route => route === 'portfolio' ? own : activityOf({ wallet: OWNER })) });
  try {
    const row = s.page.locator(`[data-v2-position-row="${network.chainId}:${network.manager}:${tokenId}"]`);
    await row.locator('[data-usd="principal"][data-usd-basis="pool-price"]').waitFor();
    assert.deepEqual(await row.locator('[data-usd]').allTextContents(), ['$5.00', '$0.75']);
    for (const name of ['principal', 'fees']) {
      assert.match(await row.locator(`[data-cell="${name}"]`).getAttribute('title'), /pool price/i);
      assert.equal(await row.locator(`[data-usd="${name}"]`).getAttribute('data-usd-basis'), 'pool-price');
    }
    assert.equal(await row.locator('[data-cell="apr"] .dm-own-dash').innerText(), '—', 'a spot mark never fabricates personal APR');
    for (const width of [1280, 390, 320]) {
      await s.page.setViewportSize({ width, height: 960 });
      assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${network.name} marked USD fits ${width}px`);
      await s.page.screenshot({ path: join(shots(), `positions-pool-price-${network.key}-${width}.png`), fullPage: true, animations: 'disabled' });
    }
    await row.click();
    const detail = s.page.locator(`[data-position-detail][data-position-id="${tokenId}"]`);
    await detail.locator('[data-usd="principal"][data-usd-basis="pool-price"]').waitFor();
    assert.deepEqual(await detail.locator('[data-usd]').allTextContents(), ['$5.00', '$0.75'], 'the same shared read values the list and the position page');
    assert.match(await detail.locator('[data-position-details] [data-stat="principal"]').textContent(), /2\s+USDC.*3\s+TEST/);
    assert.match(await detail.locator('[data-position-details] [data-stat="fees"]').textContent(), /0\.25\s+USDC.*0\.5\s+TEST/);
    assert.equal(s.wallet.state.signed.length, 0, 'valuation needs no wallet signature');
    assert.equal(s.planAsked.length, 0, 'valuation never prepares a transaction');
  } finally { await s.close(); }
});

// Added 2026-10-14 (package V1, review). Two things an estimate lost once nothing newer had arrived for two minutes: its
// basis (the title and Details said only "Last complete valuation, from …", in the row and on the page), and, on the
// page opened from the list, its time (the two minutes were counted again from the page's mount).
test('a Base estimate nothing newer has arrived for says its time and its basis, in its row and at once on its own page', async () => {
  const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', manager = '0x03a520b32c04bf3beef7beb72e919cf822ed34f1';
  const testToken = '0xb200000000000000000000000000000000000001', tokenId = '6238157';
  const anchor = { ...indexedToken(8453, usdc, 'USDC', 6), price: { source: 'chain_stable', usd: '1.000000000000000000', snapshot: null, pool: null, ethUsd: null, depthUsd: null }, priceReason: null };
  const own = portfolioOf({ wallet: OWNER, tokens: [anchor, { ...indexedToken(8453, testToken, 'TEST', 6), priceReason: 'pool_depth_below_floor' }], positions: [
    livePosition({ chainId: 8453, dex: 3, manager, tokenId, owner: OWNER, pool: { currency0: usdc, currency1: testToken, fee: 3000, tickSpacing: 60 }, tickLower: -60, tickUpper: 60,
      liquidity: '1000000000', sqrtPriceX96: String(2n ** 96n), tick: 0, principal: ['2000000', '3000000'], feesOwed: ['250000', '500000'] }),
  ] });
  let failing = false;
  const s = await scenario({ hooks: LIVE, refresh: true, readV6: routeOn(route => route === 'portfolio' ? (failing ? { status: 503, body: { error: 'upstream_unavailable' } } : own) : activityOf({ wallet: OWNER })) });
  try {
    const row = s.page.locator(`[data-v2-position-row="8453:${manager}:${tokenId}"]`);
    await row.locator('[data-usd="principal"][data-usd-basis="pool-price"]').waitFor();
    assert.deepEqual(await row.locator('[data-usd]').allTextContents(), ['$5.00', '$0.75']);
    assert.equal(await row.locator('[data-usd-as-of]').count(), 0);
    // read-v6 goes away: every read fails from here on.
    failing = true;
    await s.page.evaluate(() => window.dispatchEvent(new Event('online')));
    await s.page.locator('[data-owned] [data-v2-own-note="failed"]').waitFor();
    await s.page.clock.fastForward(121_000);
    await row.locator('[data-usd-as-of="principal"]').waitFor();
    const said = await row.locator('[data-usd-as-of]').allInnerTexts();
    assert.equal(said.length, 2);
    for (const words of said) assert.match(words, AS_OF);
    const both = /^Last complete valuation, from \d\d-\d\d \d\d:\d\d UTC\. Estimated from the pool price at block \d+, converted with USDC’s qualified USD price\. This is not a sale quote\./;
    for (const name of ['principal', 'fees']) {
      assert.match(await row.locator(`[data-cell="${name}"]`).getAttribute('title'), both, `${name}: the time and the basis, both`);
      assert.match(await row.locator(`[data-cell="${name}"] [data-usd-estimate]`).textContent(), /^Estimated from the pool price at block \d+, converted with USDC’s qualified USD price\. This is not a sale quote\.$/, 'and for a screen reader');
    }
    // Its own page, opened now: the same figures, saying the same time at once, and still what they are an estimate of.
    await row.click();
    const detail = s.page.locator(`[data-position-detail][data-position-id="${tokenId}"]`);
    await detail.locator('[data-usd="principal"][data-usd-basis="pool-price"]').waitFor();
    assert.equal(await s.page.locator('[data-position-v2]').count(), 1, 'the position page of a chain read-v6 alone reads');
    assert.deepEqual(await detail.locator('[data-position-stats] [data-usd]').allTextContents(), ['$5.00', '$0.75']);
    assert.deepEqual(await detail.locator('[data-position-stats] [data-usd-as-of]').allInnerTexts(), said, 'no two minutes to wait again: an old answer is old at once');
    for (const name of ['principal', 'fees']) assert.match(await detail.locator(`[data-usd="${name}"]`).getAttribute('title'), new RegExp(`${both.source}$`));
    const details = detail.locator('[data-position-details]');
    await details.locator('summary').click();
    assert.match(await details.locator('[data-usd-detail]').innerText(), new RegExp(`${both.source}$`), 'Details says both');
    assert.doesNotMatch(await detail.innerText(), /USD unavailable/i);
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

test('a newly created Base position stays visible while indexing even when every older position is closed', async () => {
  const manager = '0x03a520b32c04bf3beef7beb72e919cf822ed34f1';
  const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
  const basecat = '0xb2000000000000000000004c27f6523082f41d01';
  const tokens = [indexedToken(8453, usdc, 'USDC', 6), indexedToken(8453, basecat, 'BASECAT', 18)];
  const own = portfolioOf({ wallet: OWNER, tokens, positions: [livePosition({ chainId: 8453, dex: 3, manager, tokenId: '6238100', owner: OWNER,
    pool: { currency0: usdc, currency1: basecat, fee: 3000, tickSpacing: 60 }, tickLower: -60, tickUpper: 60, liquidity: '0', sqrtPriceX96: String(2n ** 96n), tick: 0 })] });
  const hint = { wallet: OWNER, chainId: 8453, positionManager: manager, dex: 3, tokenId: '6238157', hash: '0x' + 'ab'.repeat(32),
    block: 52469635, blockHash: '0x' + 'cd'.repeat(32), observedAt: Date.now(), fee: 3000, tokens: tokens.map(({ address, symbol, decimals }) => ({ address, symbol, decimals })) };
  const s = await scenario({ hooks: LIVE, creations: [hint], chainOptions: { positions: [] }, readV6: routeOn(route => route === 'portfolio' ? own : activityOf({ wallet: OWNER })) });
  try {
    const row = s.page.locator(`[data-v2-position-row="8453:${manager}:6238157"]`);
    await row.waitFor();
    assert.match(await text(row), /Updating/);
    assert.equal(await row.locator('[data-usd]').count(), 0, 'the mint hint does not invent a balance');
    await s.page.getByRole('tab', { name: /^Closed/ }).click();
    await s.page.locator(`[data-v2-position-row="8453:${manager}:6238100"]`).waitFor();
    assert.equal(await row.count(), 0, 'an explicit Closed selection is respected');
    await s.page.getByRole('tab', { name: /^Open/ }).click();
    await row.waitFor();
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

test('read gate off: historical NFTs remain in the unified collection and read-v6 is not asked', async () => {
  const s = await scenario();
  try {
    await s.page.locator('[data-owned="ready"]').waitFor();
    await v1RowAsItIs(s.page);
    assert.deepEqual(await tabs(s.page), ['Open 1', 'Closed 0']);
    await s.page.waitForTimeout(500);
    assert.equal(await s.page.locator('[data-v2-position-row]').count(), 1);
    assert.equal(await s.page.locator('[data-v2-examples], [data-v2-own-note], [data-v2-receipt]').count(), 0);
    assert.deepEqual(s.asked, [], 'the site’s read-v6 route is never asked');
    assert.doesNotMatch(await s.page.locator('main').innerText(), /Test data|Example/);
    const summary = s.page.locator('section[aria-labelledby="receipts-title"] section[aria-label="Execution receipts"]');
    assert.equal(await summary.locator('h2, .dm-acct-desc').count(), 0, 'the preview uses its wrapper heading and one wallet state');
    await s.page.getByRole('link', { name: 'Receipts', exact: true }).click();
    const history = s.page.locator('section[aria-label="Execution receipts"]');
    await history.locator('h2').waitFor({ state: 'attached' });
    assert.equal(await history.locator('h2').textContent(), 'Execution receipts', 'full history retains its introduction');
    assert.equal(await history.locator('.dm-acct-desc').innerText(), 'What automation did for your positions.');
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
    await s.page.locator('[data-automation-cards="integrated"]').waitFor();
    await s.page.waitForFunction(() => document.querySelector('[data-owned-rows="open"] [data-v2-position-row]'));
    assert.equal(await s.page.locator('[data-v2-examples], [data-test-data]').count(), 0);
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
    await s.page.locator('[data-execution="signed_out"] [data-signed-out] > summary').click();
    assert.equal(await s.page.locator('[data-execution="signed_out"]').getByRole('button', { name: 'Sign in', exact: true }).count(), 1);
  } finally { await s.close(); }
});

test('preview reads the connected wallet from the site route and shows its partial/stale coverage without example data', async () => {
  const own = about('portfolio', fixture('portfolio-behind.json'), OWNER);
  const s = await scenario({ hooks: { originOpen: true }, readV6: routeOn(route => ({ status: 200, body: route === 'portfolio' ? own : about('activity', fixture('activity.json'), OWNER) })) });
  try {
    const note = s.page.locator('[data-owned] [data-v2-own-note="partial"]');
    await note.waitFor({ timeout: 5_000 }).catch(async () => assert.fail(JSON.stringify({ requests: s.asked, content: await s.page.locator('[data-owned]').innerText() })));
    assert.equal(await text(note), 'Showing Robinhood Chain. Base and Arbitrum One are unavailable right now.');
    assert.equal(await s.page.locator(`a[data-v2-position-row="${rowKey('7')}"] [data-v2-stale]`).getAttribute('data-v2-stale'), 'updated 15 min ago');
    await v1RowAsItIs(s.page);
    assert.deepEqual(await tabs(s.page), ['Open 2', 'Closed 0']);
    assert.equal(await s.page.locator('[data-v2-examples], [data-test-data]').count(), 0);
    assert.doesNotMatch(await s.page.locator('main').innerText(), /Test data|Example positions/);
    assert.deepEqual(s.asked.find(entry => entry.route === 'portfolio').body, { wallet: OWNER });
    assert.deepEqual(s.asked.find(entry => entry.route === 'activity').body, { wallet: OWNER, limit: 20 });
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

test('live: one collection merges both inventories and counts only positions with proven liquidity', async () => {
  const own = about('portfolio', fixture('portfolio.json'), OWNER);
  // The same NFT V1 lists (Robinhood Chain's v4 position manager, its id): shown once, as V1's row.
  own.positions[2].tokenId = V1_OPEN;
  let releasePortfolio;
  const portfolioReady = new Promise(resolveReady => { releasePortfolio = resolveReady; });
  const respond = routeOn((route) => ({ status: 200, body: route === 'portfolio' ? own : about('activity', fixture('activity.json'), OWNER) }));
  const s = await scenario({ hooks: LIVE, readV6: async (method, route, body) => {
    if (method === 'POST' && route === 'portfolio') await portfolioReady;
    return respond(method, route, body);
  } });
  try {
    const rows = s.page.locator('[data-owned-rows="open"] a[data-v2-position-row]');
    await rows.first().waitFor();
    await v1RowAsItIs(s.page);
    assert.deepEqual(await rows.evaluateAll(all => all.map(row => row.getAttribute('data-v2-position-row').split(':').at(-1))), [V1_OPEN], 'historical rows stay visible while the independent portfolio read is pending');
    releasePortfolio();
    await rows.nth(4).waitFor();
    assert.deepEqual((await rows.evaluateAll((all) => all.map((row) => row.getAttribute('data-v2-position-row').split(':').at(-1)))).sort(), ['7', '8', '12', '13', V1_OPEN].sort());
    assert.equal(await s.page.locator(`[data-v2-position-row="${rowKey(V1_OPEN)}"]`).count(), 1);
    await s.page.getByRole('tab', { name: /^Open 3/ }).waitFor();
    assert.deepEqual(await tabs(s.page), ['Open 3', 'Closed 0'], 'unknown positions remain visible without being counted as Open');
    assert.match(await s.page.locator('[data-owned-status]').innerText(), /3 open and 0 closed positions.*2 positions still being checked/);
    assert.equal(await rows.locator('[data-cell="apr"]').count(), 5, 'every row has the qualified APR projection');
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
    assert.equal(await privateEntry.locator('[data-signed-out]').count(), 0, 'optional private-history explanation belongs in See all');
    assert.equal(await privateEntry.locator('.dm-acct-quiet').count(), 0, 'public receipts do not sit below a second empty-state plate');
    assert.equal(await privateEntry.getByRole('button', { name: 'Sign in', exact: true }).count(), 0);
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
    releasePortfolio();
    await s.close();
  }
});

test('live, the site’s route not deployed: V1 remains available without an empty V2 section or test data', async () => {
  let releaseCapabilities;
  const capabilities = new Promise(resolve => { releaseCapabilities = resolve; });
  const s = await scenario({ hooks: LIVE, readV6: async () => { await capabilities; return routeMissing(); } });
  try {
    await v1RowAsItIs(s.page);
    // V1 and the merged signed-out card can render before the independent receipts probe finishes. The transient
    // loading scaffold is not a failed-read notice. Hold the probe so this order is exercised on every runner.
    const loading = s.page.locator('[data-v2-own-receipts="loading"]');
    await loading.waitFor({ state: 'attached' });
    releaseCapabilities();
    await loading.waitFor({ state: 'detached' });
    await s.page.locator('[data-automation-cards="integrated"] [data-activity-error]').waitFor();
    await s.page.waitForFunction(() => document.querySelector('[data-owned-rows="open"] [data-v2-position-row]'));
    assert.deepEqual(await tabs(s.page), ['Open 1', 'Closed 0']);
    assert.equal(await s.page.locator('[data-v2-position-row]').count(), 1);
    assert.equal(await s.page.locator('[data-v2-examples], [data-test-data]').count(), 0);
    assert.equal(await s.page.locator('[data-v2-own-receipts="unavailable"]').count(), 1, 'unavailable public history never becomes a silent private-only fallback');
    assert.equal(await s.page.locator('.dm-rcpt-session').count(), 0, 'no compact public-history treatment without public rows');
    assert.deepEqual([...new Set(s.asked.map((entry) => `${entry.method} ${entry.route}`))], ['GET capabilities'], 'only the capabilities are asked: nothing is posted to a route that is not there');
  } finally {
    releaseCapabilities();
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

test('one overview shows four total operations; cancellations and optional sign-in stay in the full history', async () => {
  const wire = JSON.parse(readFileSync(join(CONTRACTS, 'execution-v1/fixtures/status-wire.json'), 'utf8'));
  const reserved = wire.responses['status.reserved'].item;
  const planned = { ...reserved, intentId: '0x' + '34'.repeat(32), state: 'planned' };
  const cancelled = { ...reserved, intentId: '0x' + '56'.repeat(32), state: 'cancelled', canCancel: false };
  const short = fixture('activity.json'); short.items = short.items.slice(0, 3);
  const s = await scenario({ hooks: LIVE, privateReceipts: [reserved, planned, cancelled], readV6: routeOn((route) => ({ status: 200, body: about(route, route === 'activity' ? short : fixture('portfolio.json'), OWNER) })) });
  try {
    const card = s.page.locator('section[aria-labelledby="receipts-title"]');
    await card.locator('[data-v2-receipt]').first().waitFor();
    await card.locator('[data-receipts-all]').click();
    await card.locator('[data-signed-out] > summary').click();
    await card.getByRole('button', { name: 'Sign in', exact: true }).click();
    await s.page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: 'Sign in', exact: true }).click();
    await s.page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_in');
    await s.page.keyboard.press('Escape');
    await s.page.evaluate(() => { location.hash = '#/positions'; });
    await card.locator('[data-execution="ready"]').waitFor();
    assert.equal(await card.locator('[data-activity-rows]').getAttribute('data-activity-rows'), '4');
    assert.equal(await card.locator('[data-activity-rows] > [data-v2-receipt]').count(), 3);
    assert.equal(await card.locator('[data-activity-rows] > [data-execution-intent]').count(), 1);
    assert.equal(await card.locator('[data-activity-rows] [data-execution-cancelled]').count(), 0);
    assert.equal(await card.locator('[data-activity-internal]').count(), 0, 'the overview has no technical checks drawer');
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
    assert.ok(initial.every(id => ids.includes(id)), `initial operations must survive recovery; missing: ${initial.filter(id => !ids.includes(id)).join(', ')}`);
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

test('a matching creation receipt dates the position price chart and retries the ledger without inventing fees or APR', { timeout: 60_000 }, async () => {
  const whole = fixture('activity.json');
  const created = structuredClone(whole.items.find(item => item.kind === 's1_action' && item.action === 'create'));
  const end = Math.floor(Date.now() / 1000);
  const openedAt = end - 3 * 3_600 - 137;
  const mintBlock = 71_699_000;
  created.tokenId = V1_OPEN;
  created.id = `4663:${mintBlock}:6`;
  Object.assign(created.tx.snapshot, { number: mintBlock, timestamp: openedAt });
  for (const step of created.steps) step.tokenId = V1_OPEN;
  // An equal numeric NFT on another chain or manager is not this position's creation.
  const otherChain = structuredClone(created);
  otherChain.chainId = 8453;
  otherChain.tx.finality = 'unfinalized';
  otherChain.id = `8453:${mintBlock + 2}:6`;
  Object.assign(otherChain.tx.snapshot, { number: mintBlock + 2, timestamp: openedAt + 20 });
  const otherDex = structuredClone(created);
  otherDex.id = `4663:${mintBlock + 1}:6`;
  Object.assign(otherDex.tx.snapshot, { number: mintBlock + 1, timestamp: openedAt + 10 });
  for (const step of otherDex.steps) step.pool.dex = 3;
  const cursor = [otherDex.tx.snapshot.timestamp, otherDex.chainId, otherDex.tx.snapshot.number, 6].join('.');
  const priceReads = [];
  let firstLedger;
  const ledgerFailed = new Promise(resolve => { firstLedger = resolve; });
  const s = await scenario({
    hooks: LIVE, hash: `#/positions/${V1_OPEN}`, chainOptions: { timestamp: end },
    ledgerReply: () => { firstLedger(); return { status: 502, body: { v: 1, error: 'rpc_unavailable' } }; },
    readV6: async (method, route, request) => {
      if (method === 'GET') return { status: 200, body: CAPABILITIES, contract: true };
      if (route === 'activity') await ledgerFailed;
      const body = route === 'portfolio' ? fixture('portfolio.json') : { ...whole, items: request.cursor ? [created] : [otherChain, otherDex], nextCursor: request.cursor ? null : cursor };
      return { status: 200, body: about(route, body, OWNER), contract: true };
    },
    stored: (route, body) => {
      assert.equal(route, 'history');
      const answer = historyFor({ id: 3135288, now: 1e-12, quote: { address: zeroAddress } }, body, { end });
      priceReads.push(answer);
      return JSON.stringify(answer);
    },
  });
  try {
    const activity = s.page.locator('[data-position-activity]');
    await activity.getByRole('button', { name: 'Show more', exact: true }).waitFor();
    await s.page.locator('[data-fees-card][data-fees-state="unclaimed-only"][data-fees-reason="rpc_unavailable"]').waitFor();
    await s.page.getByRole('tab', { name: 'Price range', exact: true }).click();
    const range = s.page.locator('[data-pvr-where]');
    assert.equal(await range.getAttribute('data-pvr-history'), 'unknown_mint');
    assert.equal(await range.getAttribute('data-pvr-opened'), null);
    assert.equal(await activity.locator('[data-position-activity-item]').count(), 0);
    assert.equal(await range.locator('.dm-pvr-line').count(), 0, 'pool history may prefetch, but no position line is drawn before mint is proven');
    assert.ok(s.ledgerAsked.length > 0);
    assert.ok(s.ledgerAsked.every(request => !request.mintHints), 'neither unrelated identity supplies a mint hint');

    const hinted = s.page.waitForRequest(request => request.url().endsWith('/api/fees/v2/ledger') && !!request.postDataJSON()?.mintHints, { timeout: 15_000 });
    await activity.getByRole('button', { name: 'Show more', exact: true }).click();
    await activity.locator(`[data-position-activity-item="${created.id}"]`).waitFor();
    const retry = (await hinted).postDataJSON();
    assert.deepEqual(retry.mintHints, [{ tokenId: V1_OPEN, block: mintBlock, tx: created.tx.hash }]);
    assert.equal(retry.fresh, true, 'new mint evidence retries the failed ledger');
    await s.page.locator('[data-pvr-where][data-pvr-line]').waitFor();
    assert.equal(Number(await range.getAttribute('data-pvr-opened')), openedAt);
    assert.equal(Number(await range.getAttribute('data-pvr-start')), openedAt);
    assert.ok(Number(await range.getAttribute('data-pvr-first')) >= openedAt, 'the price line contains no point before mint');
    assert.ok(priceReads.some(answer => answer.candles.some(candle => candle.startTimestamp < openedAt)), 'the full pool history actually contained older candles to exclude');
    await s.page.getByRole('tab', { name: 'Fees', exact: true }).click();
    await s.page.locator('[data-fees-card][data-fees-state="unclaimed-only"][data-fees-reason="rpc_unavailable"]').waitFor();
    assert.equal(await s.page.locator('[data-cell="apr"][data-apr="ready"]').count(), 0, 'a creation date never fabricates fee accounting or APR');
    assert.doesNotMatch(await s.page.locator('[data-cell="apr"]').innerText(), /[\d,.]+%/);
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});

test('an empty Auto-exit is one compact receipt, with details on demand, also inside position Activity', async () => {
  const whole = fixture('activity.json');
  const exited = whole.items.find(item => item.kind === 'auto_exit');
  Object.assign(exited, { tokenId: V1_OPEN, withdrawn: ['0', '0'], delivered: ['0', '0'], deferred: [], reservesReturned: [], legs: [], tariffs: [] });
  whole.items = [exited];
  whole.nextCursor = null;
  const portfolio = fixture('portfolio.json');
  portfolio.vaults.find(vault => vault.address === exited.vault).dex = 4;
  const s = await scenario({ hooks: LIVE, hash: '#/positions/receipts', readV6: routeOn((route) => ({ status: 200, body: about(route, route === 'portfolio' ? portfolio : whole, OWNER) })) });
  try {
    const row = s.page.locator(`[data-v2-receipt="${exited.id}"]`);
    await row.waitFor();
    assert.equal(await s.page.locator('[data-v2-receipt]').count(), 1);
    assert.match(await row.locator('summary').innerText(), /Auto-exit: nothing to withdraw from #3135288/);
    assert.doesNotMatch(await row.locator('summary').innerText(), /0\.2%|raw units|0 USDG|0 MANY/);
    assert.equal(await row.locator('details').evaluate(node => node.open), false);
    await row.locator('summary').click();
    assert.match(await row.locator('[data-receipt-line="empty-exit"]').innerText(), /No tokens were withdrawn or sent to your wallet/);
    assert.equal(await row.locator('[data-receipt-fee]').count(), 0);
    await row.locator('[data-v2-explorer]').waitFor();
    await row.locator('summary').click();
    await s.page.setViewportSize({ width: 390, height: 844 });
    await row.screenshot({ path: join(shots(), 'autoexit-empty-receipt-mobile.png'), animations: 'disabled' });
    assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
    await s.page.setViewportSize({ width: 1320, height: 1000 });
    await s.page.goto(`${s.page.url().split('#')[0]}#/positions/${V1_OPEN}`);
    const activity = s.page.locator('[data-position-activity]');
    await activity.locator(`[data-position-activity-item="${exited.id}"]`).waitFor();
    assert.match(await activity.innerText(), /Auto-exit: nothing to withdraw from #3135288/);
    assert.equal(await s.page.locator('[data-v2-receipt]').count(), 1, 'one result on the position page');
    assert.equal(await activity.locator('[data-v2-receipt]').count(), 1, 'that result belongs to Activity');
    await activity.screenshot({ path: join(shots(), 'autoexit-empty-position-activity.png'), animations: 'disabled' });
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

test('setup is one human receipt with all effects, one gas cost and open details preserved after refresh', async () => {
  const body = fixture('activity.json');
  const created = structuredClone(body.items.find(item => item.kind === 'vault_created'));
  const registered = structuredClone(body.items.find(item => item.kind === 'auto_exit_event' && item.event === 'MandateRegistered'));
  const settings = structuredClone(body.items.find(item => item.kind === 'vault_event'));
  const block = created.tx.snapshot.number;
  for (const [index, item] of [created, settings, registered].entries()) {
    item.tx = structuredClone(created.tx);
    item.id = `4663:${block}:${index + 1}`;
  }
  body.items = [registered, settings, created]; body.nextCursor = null;
  let head = body;
  const s = await scenario({ hooks: { originOpen: true }, refresh: true, hash: '#/positions/receipts', readV6: routeOn(route => ({ status: 200, body: about(route, route === 'activity' ? head : fixture('portfolio.json'), OWNER) })) });
  try {
    const row = s.page.locator(`[data-v2-receipt="${registered.id}"]`);
    await row.waitFor();
    assert.equal(await s.page.locator('[data-v2-receipt]').count(), 1);
    assert.equal(await row.getAttribute('data-receipt-effects'), '3');
    await row.locator('summary').click();
    assert.equal(await row.locator('[data-receipt-effect]').count(), 3);
    assert.equal(await row.locator('[data-receipt-field="gas-used"]').count(), 1);
    const extra = structuredClone(fixture('activity.json').items[0]);
    head = { ...body, items: [extra, ...body.items] };
    await s.page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await s.page.waitForFunction(() => document.querySelectorAll('[data-v2-receipt]').length === 2);
    assert.equal(await row.locator('details').getAttribute('open'), '', 'stable operation identity preserves the disclosure');
    assert.equal(s.wallet.state.signed.length, 0, 'reading is independent from write gates and wallet signatures');
    if (process.env.DOMINO_RECEIPT_SHOTS) {
      mkdirSync(process.env.DOMINO_RECEIPT_SHOTS, { recursive: true });
      for (const width of [1320, 390, 320]) {
        await s.page.setViewportSize({ width, height: 960 });
        assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await s.page.locator('main').screenshot({ path: join(process.env.DOMINO_RECEIPT_SHOTS, `receipts-grouped-${width}.png`), animations: 'disabled' });
      }
    }
  } finally { await s.close(); }
});

test('compact Open and Closed rows resolve real token artwork by identity and retain fees without a wall of zeroes', async () => {
  const pons = '0x39dbed3a2bd333467115de45665cc57f813c4571';
  const manager = fixture('portfolio.json').positions[0].positionManager;
  const pool = { dex: 4, currency0: pons, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: zeroAddress };
  const common = { chainId: 4663, manager, owner: OWNER, pool, tickLower: -60, tickUpper: 60, sqrtPriceX96: 2n ** 96n, tick: 0 };
  const positions = [
    livePosition({ ...common, tokenId: 41n, liquidity: 10n ** 18n, principal: ['1000000000000000000', '1000000'] }),
    livePosition({ ...common, tokenId: 42n, liquidity: 0n }),
    livePosition({ ...common, tokenId: 43n, liquidity: 0n, feesOwed: ['0', '1000000'] }),
    livePosition({ ...common, tokenId: 44n, liquidity: 0n }),
  ];
  const own = portfolioOf({ wallet: OWNER, positions, tokens: [indexedToken(4663, pons, 'PONS', 18), indexedToken(4663, USDG, 'USDG', 6)] });
  const askedArtwork = [];
  const image = 'https://cdn.dexscreener.com/cms/images/positionponsart';
  const s = await scenario({ hooks: LIVE, readV6: routeOn(route => route === 'portfolio' ? own : activityOf({ wallet: OWNER })), artwork: route => {
    const url = route.request().url(); askedArtwork.push(url);
    if (url.startsWith(image)) return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO9sAAAAASUVORK5CYII=', 'base64') });
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(url.endsWith(`/robinhood/${pons}`) ? [{ chainId: 'robinhood', baseToken: { address: pons, symbol: 'UNTRUSTED' }, info: { imageUrl: image } }] : []) });
  } });
  try {
    const open = s.page.locator(`[data-v2-position-row="${rowKey('41')}"]`);
    await open.locator('[data-token-mark="provider"]').waitFor();
    await s.page.waitForFunction(key => { const image = document.querySelector(`[data-v2-position-row="${key}"] [data-token-mark="provider"]`); return image?.complete && image.naturalWidth > 0; }, rowKey('41'));
    assert.equal(await open.locator('[data-token-mark="provider"]').getAttribute('src'), `${image}?width=64&height=64&quality=85&format=auto`);
    assert.match(await open.innerText(), /PONS/);
    assert.doesNotMatch(await open.innerText(), /UNTRUSTED/);
    assert.equal(await open.locator('[data-v2-chain-badge], [data-v2-dex-badge], .dm-own-badge').count(), 0, 'metadata is a quiet line, not repeated badges');
    assert.equal(await open.locator('[data-cell="apr"]').count(), 1);
    await s.page.getByRole('tab', { name: /^Open 2/ }).waitFor();
    await s.page.getByRole('tab', { name: /^Closed 3/ }).click();
    const closed = s.page.locator(`[data-v2-position-row="${rowKey('42')}"]`);
    const fees = s.page.locator(`[data-v2-position-row="${rowKey('43')}"]`);
    await closed.waitFor();
    assert.equal(await closed.locator('.dm-own-closed-caption').innerText(), 'View history');
    assert.equal(await closed.locator('[data-cell="apr"]').count(), 0);
    assert.match(await closed.innerText(), /0 PONS[\s\S]*0 USDG/, 'measured zero amounts remain accessible');
    assert.ok(await closed.locator('.dm-own-figs').evaluate(node => node.getBoundingClientRect().height <= 1), 'known zeroes do not occupy visible columns');
    assert.match(await fees.locator('[data-cell="fees"]').innerText(), /1 USDG/, 'uncollected fees on a closed NFT stay visible');
    assert.ok(await fees.locator('[data-cell="fees"]').evaluate(node => node.getBoundingClientRect().height > 1));
    assert.equal(askedArtwork.filter(url => url.endsWith(`/robinhood/${pons}`)).length, 1, 'all open/closed NFTs share one bounded lookup for the same chain/address');
    for (const width of [1440, 1320, 1280, 1024, 736, 390, 320]) {
      await s.page.setViewportSize({ width, height: 960 });
      assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Closed fits ${width}px`);
      assert.ok(await closed.evaluate(node => node.getBoundingClientRect().height >= 44), 'whole-row touch target remains usable');
      await s.page.locator('[data-owned]').screenshot({ path: join(shots(), `positions-clean-closed-${width}.png`), animations: 'disabled' });
      await s.page.getByRole('tab', { name: /^Open 2/ }).click();
      await open.waitFor();
      assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Open fits ${width}px`);
      assert.ok(await open.evaluate(node => node.scrollWidth <= node.clientWidth), 'row contents fit the collection');
      assert.ok(await open.locator('[data-cell="principal"]').isVisible());
      assert.ok(await open.locator('[data-cell="fees"]').isVisible());
      assert.ok(await open.evaluate(row => [...row.querySelectorAll('.dm-own-label')].every(label => {
        const own = label.getBoundingClientRect(); const cell = label.parentElement.getBoundingClientRect();
        return own.left >= cell.left - 1 && own.right <= cell.right + 1;
      })), 'financial labels wrap inside their own cells without overlapping adjacent metrics');
      assert.equal(await open.locator('a, button').count(), 0, 'the row stays one clear destination');
      await s.page.locator('[data-owned]').screenshot({ path: join(shots(), `positions-clean-open-${width}.png`), animations: 'disabled' });
      await s.page.getByRole('tab', { name: /^Closed 3/ }).click();
    }
  } finally { await s.close(); }
});

// Added 2026-10-14 (incident C1; the owner's decision D0): "Confirmed" is in a block of the chain with success, and the
// row carries its check from that moment, on every network. It waited for the chain's finalized block before, under a
// pill "Confirming": about 16 minutes on Robinhood Chain (measured 2026-10-13), 15 to 20 on Base and Arbitrum One, with
// nothing wrong. Finality is one line of the opened receipt; a deferred delivery keeps its own pill.
test('a receipt above the finalized block carries the check on every network and never says "Confirming"; a deferred delivery keeps its pill', async () => {
  const whole = fixture('activity.json');
  const created = whole.items.find(item => item.kind === 's1_action' && item.action === 'create');
  const exited = whole.items.find(item => item.kind === 'auto_exit');
  assert.deepEqual([created.tx.finality, exited.tx.finality, exited.deferred.length > 0], ['finalized', 'unfinalized', true], 'the fixture: one final receipt, one deferred delivery');
  // One receipt per network above its finalized block (Base and Arbitrum One report none in the fixture), newest first,
  // each its own transaction.
  const fresh = [42161, 8453, 4663].map((chainId, index) => {
    const item = structuredClone(created);
    const block = chainId === 4663 ? 73_399_500 : 52_000_000;
    Object.assign(item, { chainId, id: `${chainId}:${block}:6`, intentHash: `0x${String(index + 1).repeat(64)}` });
    Object.assign(item.tx, { finality: 'unfinalized', hash: `0x${String(index + 4).repeat(64)}` });
    Object.assign(item.tx.snapshot, { number: block, timestamp: exited.tx.snapshot.timestamp + 30 - index * 10, hash: `0x${String(index + 7).repeat(64)}` });
    return item;
  });
  const activity = { ...whole, items: [...fresh, exited, created], nextCursor: null };
  const s = await scenario({ hooks: LIVE, hash: '#/positions/receipts', readV6: routeOn(route => ({ status: 200, body: about(route, route === 'activity' ? activity : fixture('portfolio.json'), OWNER) })) });
  try {
    await s.page.locator('[data-activity-rows="5"]').waitFor();
    for (const item of fresh) {
      const row = s.page.locator(`[data-v2-receipt="${item.id}"]`);
      await row.waitFor();
      assert.equal(await row.getAttribute('data-v2-finality'), 'included', `${item.chainId}: the fact is unchanged, not final yet`);
      assert.equal(await row.locator('summary .dm-receipt-check[aria-label="Confirmed"]').count(), 1, `${item.chainId}: the check at once`);
      assert.equal(await row.locator('summary .dm-receipt-exception').count(), 0, `${item.chainId}: no pill`);
      await row.locator('summary').click();
      assert.equal(await text(row.locator('[data-receipt-field="state"]')), 'Status Confirmed. Not final on Ethereum yet.', `${item.chainId}: finality is one line of the opened receipt`);
    }
    const final = s.page.locator(`[data-v2-receipt="${created.id}"]`);
    assert.equal(await final.getAttribute('data-v2-finality'), 'finalized');
    assert.equal(await final.locator('summary .dm-receipt-check[aria-label="Confirmed"]').count(), 1, 'the same check once final');
    await final.locator('summary').click();
    assert.equal(await text(final.locator('[data-receipt-field="state"]')), 'Status Final.');
    const claim = s.page.locator(`[data-v2-receipt="${exited.id}"]`);
    assert.equal(await text(claim.locator('summary .dm-receipt-exception')), 'Delivery deferred', 'a delivery still to claim keeps its pill');
    assert.equal(await claim.locator('summary .dm-receipt-check').count(), 0, 'and no check until it is claimed, as before');
    assert.doesNotMatch(await s.page.locator('main').innerText(), /Confirming|Finalized|Included, not final/, 'no receipt waits on a word for its finalized block');
    assert.equal(s.wallet.state.signed.length, 0);
    if (process.env.DOMINO_RECEIPT_SHOTS) {
      mkdirSync(process.env.DOMINO_RECEIPT_SHOTS, { recursive: true });
      for (const width of [1320, 390]) {
        await s.page.setViewportSize({ width, height: 960 });
        assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await s.page.locator('main').screenshot({ path: join(process.env.DOMINO_RECEIPT_SHOTS, `receipts-confirmed-${width}.png`), animations: 'disabled' });
      }
    }
  } finally { await s.close(); }
});

test('a local bulk-close confirmation is one receipt with aggregate amounts and no invented native payout or timestamp', async () => {
  const owned = fixture('portfolio.json');
  const position = owned.positions.find(item => item.chainId === 4663 && item.dex === 4);
  const activity = { ...fixture('activity.json'), items: [], nextCursor: null };
  const local = { wallet: OWNER, chainId: 4663, dex: 4, positionManager: position.positionManager,
    hash: '0x' + 'd'.repeat(64), block: 9999, blockHash: '0x' + 'b'.repeat(64), tokenIds: ['7', '8'],
    amounts: [{ token: zeroAddress, amount: null }], at: null, state: 'included',
    gas: { gasUsed: '123456', effectiveGasPrice: '20000000', l1Fee: null } };
  const s = await scenario({ hooks: { originOpen: true }, hash: '#/positions/receipts', localCloses: [local], readV6: routeOn(route => ({ status: 200, body: about(route, route === 'activity' ? activity : owned, OWNER) })) });
  try {
    const row = s.page.locator(`[data-local-close-receipt="${local.hash}"]`);
    await row.waitFor();
    assert.equal(await s.page.locator('[data-activity-rows]').getAttribute('data-activity-rows'), '1');
    assert.match(await row.innerText(), /2 positions closed/);
    assert.match(await row.innerText(), /Date unavailable/);
    assert.equal(await row.locator('time').count(), 0);
    // Added 2026-10-14 (incident C1; the owner's decision D0): a close this browser checked in a block is confirmed at
    // once; it said "Confirming" until the finalized block passed it.
    assert.equal(await row.locator('summary .dm-receipt-check[aria-label="Confirmed"]').count(), 1);
    assert.doesNotMatch(await row.innerText(), /Confirming/);
    await row.locator('summary').click();
    assert.match(await row.innerText(), /Status\s+Confirmed\. Not final on Ethereum yet\./);
    assert.match(await row.innerText(), /ETH: amount not reported/);
    assert.match(await row.innerText(), /saved on this device/);
    assert.equal(await row.locator('[data-receipt-field="gas-used"]').count(), 1);
    assert.equal(await row.locator('[data-local-close-token]').count(), 1);
    await s.wallet.switchAccount('a', 1);
    await row.waitFor({ state: 'detached' });
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});
