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
import { activityOf, indexedToken, livePosition, portfolioOf } from '../support/s1-read6.mjs';
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

test('fees remain visible as token balances when USD pricing is unavailable, across desktop and phone widths', async () => {
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
    assert.match(await cell.getAttribute('title'), /^USD estimate unavailable\.[\s\S]*0\.0028 USDG/);
    assert.match(await cell.locator('.dm-own-amounts').innerText(), /0\.0028 USDG/, 'the same measured fees as the detail page are visible');
    assert.equal(await cell.locator('.dm-own-amounts .dm-acct-amount').count(), 2);
    assert.equal(await cell.locator('.dm-own-amounts').isVisible(), true);
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

test('Base fees without a qualified USD price stay visible beside principal without inventing USD or APR', async () => {
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
    assert.match(await text(fees), /0\.005193 USDC\s+0\.317608 BASECAT/);
    assert.match(await text(row.locator('[data-cell="principal"]')), /0\.412537 USDC\s+22\.675 BASECAT/);
    assert.equal(await row.locator('[data-usd]').count(), 0);
    assert.equal(await row.locator('[data-cell="apr"] .dm-own-dash').innerText(), '—');
    assert.ok(s.ledgerAsked.every(request => !request.tokenIds.includes('6238157')), 'a Base NFT never goes to the Robinhood ledger');
    for (const width of [1320, 390, 320]) {
      await s.page.setViewportSize({ width, height: 960 });
      assert.ok(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.equal(await fees.locator('.dm-own-amounts').isVisible(), true);
      if (width !== 320) await s.page.screenshot({ path: join(shots(), `positions-base-visible-fees-${width}.png`), fullPage: true });
    }
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
    await row.locator('summary').click();
    assert.match(await row.innerText(), /ETH: amount not reported/);
    assert.match(await row.innerText(), /saved on this device/);
    assert.equal(await row.locator('[data-receipt-field="gas-used"]').count(), 1);
    assert.equal(await row.locator('[data-local-close-token]').count(), 1);
    await s.wallet.switchAccount('a', 1);
    await row.waitFor({ state: 'detached' });
    assert.equal(s.wallet.state.signed.length, 0);
  } finally { await s.close(); }
});
