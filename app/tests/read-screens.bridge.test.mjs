/**
 * The read screens in the bridge-test build: the real beta gate in front of
 * the unmodified bridge Worker (bridge/src/worker.mjs), with its gateway
 * replaced by package fixtures, as read-bridge.browser.test.mjs sets it up.
 *
 * What only this topology can show: Positions posts nothing to the read
 * service (2026-09-24: the lookup by typed NFT ids is gone; the wallet's list
 * and a position's page read chain data through the site's own endpoints),
 * reads from the landing are spaced the way the bridge admits them, pool
 * activity is read by the figures dialog
 * only when it opens and by the pool page where the route is listed, and the
 * wallet listing's continuation handle travels only in POST bodies (B4).
 *
 * Changed on purpose 2026-09-28 (speed wave, item 1): "spaced the way the
 * bridge admits them" is now the gateway's per-client budget, not 1.1 s
 * between any two reads (assertWithinBudget below).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeBrowser } from './support/close-browser.mjs';
import { createWorker } from '../../bridge/src/worker.mjs';
import { BRIDGE_DIST, createGatedServer } from '../scripts/gated-server.mjs';
import { handlePlaces, handleSightings, NOWHERE, watchForHandle } from './handle-watch.mjs';

const PASSWORD = 'screens-bridge-beta-password';
const GATE = { BETA_PASSWORD: PASSWORD, BETA_COOKIE_KEY: 'Pk2mP9vQx4Lr7TbW1cNy6ZsJ3dGa8FeU5oViRtYqWeD' };
const APP = 'https://app.test';
const ALL_READS = 'token,pools,pool-market,wallet-assets,nft-positions,catalogue,pool-activity,pool-positions,pool-metrics';
const BRIDGE = {
  APP_ORIGIN: APP,
  READ_BRIDGE_ENABLED: 'true',
  READ_V2_BRIDGE_ENABLED: 'false',
  ENABLED_V2_READS: '',
  GATEWAY_ORIGIN: 'https://gateway.test',
  ENABLED_READS: ALL_READS,
  ACCESS_CLIENT_ID: 'screens-bridge-client',
  ACCESS_CLIENT_SECRET: 'screens-bridge-secret',
};
const RC3 = '1.1.0-rc.3';
const BIG = '57896044618658097711785492504343953926634992332820282019728792003956564819969';
const READ = resolve(import.meta.dirname, '../../api-contracts/read-v1/fixtures/gateway');
const fixture = (name) => readFileSync(join(READ, `${name}.json`), 'utf8');
const OWNER = '0x3333333333333333333333333333333333333333';
const TOKEN = '0x1111111111111111111111111111111111111111';
/** The stub gateway's continuation handle: 64 hex characters, unlike any hash in the fixtures, so any copy of it is found. */
const HANDLE = 'd15ea5e0'.repeat(8);
const firstWalletPage = () => {
  const body = JSON.parse(fixture('wallet-assets.opaque-page'));
  body.inventory.nextCursor = HANDLE;
  return JSON.stringify(body);
};

if (!existsSync(join(BRIDGE_DIST, 'index.html'))) {
  throw new Error('.bridge-dist/index.html is missing. Run `npm run build:bridge-test` before this test.');
}

const LAUNCHES = process.env.DOMINO_BROWSER_PATH
  ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }]
  : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}];

const REPLY = (route, body) => {
  if (route === 'wallet-assets') return { status: 200, text: body.cursor === undefined ? firstWalletPage() : fixture('wallet-assets.last-page') };
  const name = {
    'pool-market': 'pool-market.not-requested',
    'pool-metrics': 'pool-metrics.unqualified',
    'pool-activity': 'pool-activity.partial',
    'nft-positions': 'nft-positions.success',
    token: body.token === '0x0000000000000000000000000000000000000000' ? 'token.native' : 'token.success',
  }[route];
  return { status: 200, text: fixture(name ?? `${route}.success`) };
};

/** Every request to /api/ as the browser sent it, with the time it arrived, before the gate. */
let edge = [];
let upstream = [];
/** wallet-assets replies exactly as the bridge handed them to the browser. */
let walletReplies = [];
/** A test may control one gateway reply; all other reads keep the package fixtures. */
let overrideReply = null;

const worker = createWorker({
  getClientIp: () => '198.51.100.21',
  fetch: async (url, init) => {
    const route = new URL(url).pathname.replace('/internal/read/v1/', '');
    const body = JSON.parse(init.body);
    upstream.push({ route, body, raw: init.body });
    const reply = await (overrideReply?.(route, body, init.signal) ?? REPLY(route, body));
    return new Response(reply.text, { status: reply.status, headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': RC3 } });
  },
});

async function api(request) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  if (headers.get('origin') === url.origin) headers.set('origin', APP);
  headers.delete('host');
  const body = request.method === 'GET' ? undefined : await request.text();
  const response = await worker.fetch(new Request(new URL(`${url.pathname}${url.search}`, APP), { method: request.method, headers, body }), BRIDGE);
  if (url.pathname === '/api/read/v1/wallet-assets') walletReplies.push(await response.clone().text());
  return response;
}

let server;
let origin;
let browser;

before(async () => {
  const observe = (request) => {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return;
    const entry = { method: request.method, path: url.pathname, at: Date.now(), headers: Object.fromEntries(request.headers), body: null };
    edge.push(entry);
    if (request.method === 'POST') void request.clone().text().then((text) => (entry.body = text));
  };
  server = createGatedServer({ env: GATE, dist: BRIDGE_DIST, api, observe });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  for (const options of LAUNCHES) {
    try {
      browser = await chromium.launch(options);
      break;
    } catch {
      // try the next build
    }
  }
  if (!browser) throw new Error('No Chromium build could be launched. Set DOMINO_BROWSER_PATH.');
});

after(async () => {
  // Close the listener and keep-alive sockets before waiting for Chromium.
  const serverClosed = server ? new Promise((done, reject) => {
    server.close((error) => error ? reject(error) : done());
    server.closeAllConnections();
  }) : Promise.resolve();
  await Promise.all([serverClosed, closeBrowser(browser)]);
});
afterEach(async () => { await Promise.all(browser.contexts().map(context => context.close())); });

/**
 * `until`: what the first load waits for. Added 2026-09-28 (speed wave, item 1): a test that holds a read on the wire
 * waits for `load`, since reads no longer leave 1.1 s apart, so no half-second of quiet comes before the held one.
 */
async function visit(route, setup, { until = 'networkidle' } = {}) {
  edge = [];
  upstream = [];
  walletReplies = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // 2026-09-25: a test may answer the page's third-party requests itself (the Wallet card's one price GET) before it loads.
  if (setup) await setup(context);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`uncaught: ${error.message}`));
  // Authenticate through the real gate before loading the requested route.
  // A temporary Home document would schedule reads that can outlive its
  // navigation and contaminate the next route's request trace.
  const login = await context.request.post(`${origin}/__beta/login`, { form: { password: PASSWORD }, headers: { Origin: origin }, maxRedirects: 0 });
  assert.equal(login.status(), 303);
  await page.goto(`${origin}/#${route}`, { waitUntil: until });
  return { context, page, errors };
}

/** What the eye gets of an element: its text without the screen-reader-only parts. */
const visibleText = (locator) =>
  locator.evaluate((root) => {
    const copy = root.cloneNode(true);
    for (const hidden of copy.querySelectorAll('.sr-only')) hidden.remove();
    return copy.textContent.replace(/\s+/g, ' ').trim();
  });

const posts = () => edge.filter((r) => r.method === 'POST');

/**
 * POST arrivals within the gateway's per-client budget (backend ClientBudgets: a burst of five, then one every two
 * seconds), counted as the gateway counts them, at arrival. Changed on purpose 2026-09-28 (speed wave, item 1): this
 * build used to hold every read 1.1 s after the one before it; the gateway has no start interval since #241 and runs
 * two reads at a time, so reads now leave 0 ms apart, two on the wire at most, within that budget (scheduler.ts), and
 * the 1.1 s comes back only after a refusal.
 */
function assertWithinBudget(list) {
  let tokens = 5;
  for (let i = 0; i < list.length; i++) {
    if (i > 0) tokens = Math.min(5, tokens + (list[i].at - list[i - 1].at) / 2000);
    tokens -= 1;
    // A few milliseconds of transit either way, which the page's quarter of a read in hand absorbs.
    assert.ok(tokens >= -0.05, `POST ${i} (${list[i].path}) arrived over the budget: ${list.map((r) => r.at - list[0].at).join(', ')} ms`);
  }
}

// Changed on purpose (owner, 2026-09-24): the lookup by typed NFT ids is gone, and with it every nft-positions post.
test('Positions posts nothing to the read service: no lookup by NFT id, no position read', async () => {
  const { context, page, errors } = await visit('/app');
  await page.locator('[data-owned]').waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual(edge, [], 'the page reads nothing from the read service');
  assert.equal(await page.locator('#nft-ids, #chain-lookup').count(), 0);
  await page.evaluate((big) => { location.hash = `#/positions/1,${big}`; }, BIG);
  await page.waitForTimeout(300);
  assert.deepEqual(posts().filter((r) => r.path.endsWith('/nft-positions')), [], 'a link with ids reads none of them');
  assert.deepEqual(errors, []);
  await context.close();
});

/**
 * The selected pools' load has finished on Markets: its status is settled and a row with a figure is on the page.
 * A row is on screen as soon as its market read answers, before the reads that follow it, so a figure alone is not enough.
 */
const poolsSettled = (page) =>
  page.waitForFunction(() => {
    const status = document.querySelector('[data-selected-pools] [data-read-status]')?.getAttribute('data-read-status');
    return status && status !== 'loading' && document.querySelectorAll('[data-selected-pools] tbody [data-metric]').length > 0;
  }, null, { timeout: 30_000 });
/**
 * The fixture pool's card on the Markets rail has settled its read: a price line, bars, or the row's 24h figure with why
 * there is no chart in its data. Changed 2026-09-24: the card draws the pool's stored price line where read-v3 lists
 * `history`; this Worker has read-v3 off, so here the card still makes its read-v1 hourly read.
 */
const cardSettled = (page) => page.waitForFunction(() => document.querySelector('[data-market-card] [data-price-line], [data-market-card] [data-volume-bar], [data-market-card] [data-chart-unavailable]'), null, { timeout: 30_000 });
/**
 * The route's reads on mount: the disabled stored namespace, V1/V2 capabilities,
 * the fixture pool's market and two tokens, pool-metrics and the card's
 * hourly read, which every card makes at mount whether in view or not. The
 * card is independent of the rest of the table's readiness.
 */
const MOUNT = ['GET /api/read/v3/capabilities', 'GET /api/read/v1/capabilities', 'GET /api/read/v2/capabilities', 'POST /api/read/v1/pool-market', 'POST /api/read/v1/token', 'POST /api/read/v1/token', 'POST /api/read/v1/pool-metrics', 'POST /api/read/v1/pool-market'];
const MOUNT_POSTS = MOUNT.filter((line) => line.startsWith('POST')).length;
const trail = () => edge.map((r) => `${r.method} ${r.path}`);
const POOL = '0x0911afcb281d7bcae2d71443ceaeebd0f89b4537708449970d797622b4b4c941';

/**
 * Searches an address on Markets: typed as a pair name it matches no selected pool, so the empty state's token search
 * starts from it, and choosing the address there is one token read that opens the token's view by the address bar.
 */
async function search(page, address) {
  await poolsSettled(page);
  await page.locator('#markets-search').fill(address);
  const combobox = page.getByRole('combobox', { name: 'Token name or address' });
  await combobox.waitFor();
  assert.equal(await combobox.inputValue(), address, 'the token search starts from the typed address');
  await combobox.click();
  await page.locator(`[data-token-option="${address.toLowerCase()}"]`).click();
  await page.waitForFunction((wire) => location.hash === `#/markets/${wire}`, address);
}

test('the landing reads one listed pool, never a placeholder id, and pool activity only when a pool is opened', async () => {
  const { context, page, errors } = await visit('/');
  await page.locator('#pools tbody tr').first().waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('#pools tbody tr [data-provenance]'), null, { timeout: 30_000 });
  await page.waitForFunction(() => ['none', 'partial'].includes(document.querySelector('#pools [data-read-status]')?.getAttribute('data-read-status')), null, { timeout: 30_000 });
  const routes = () => posts().map((r) => r.path.replace('/api/read/v1/', ''));
  // This Worker lists pool-metrics, which is the read service's consent: the row reads it once, after its market and
  // tokens. The snapshot is not listed, so it is never asked.
  assert.deepEqual(routes(), ['pool-market', 'token', 'token', 'pool-metrics']);
  assert.deepEqual(edge.filter((r) => r.method === 'GET').map((r) => r.path), ['/api/read/v3/capabilities', '/api/read/v1/capabilities', '/api/read/v2/capabilities'], 'disabled V3 falls back to V1 and the optional estimate probe, with no V2/V3 data POST');
  assert.equal(await page.locator('#pools [data-apr-estimate]').getAttribute('data-apr-estimate'), 'unavailable');
  for (const r of upstream) assert.doesNotMatch(JSON.stringify(r.body), /0{62}a[2-5]/, 'a placeholder pool id was requested');
  assert.equal(routes().includes('pool-activity'), false);
  await page.locator('#pools [data-pool-figures]').click();
  await page.locator('[data-pool-figures-dialog]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-figures-activity]')?.getAttribute('data-figures-activity') !== 'loading', null, { timeout: 30_000 });
  assert.equal(routes().filter((r) => r === 'pool-activity').length, 1);
  assert.match(await page.locator('[data-pool-figures-dialog]').innerText(), /Pool is 19 s old/);
  // Changed on purpose 2026-09-28 (speed wave, item 1): the dialog's read shares the table's budget, no longer 1.1 s apart.
  assertWithinBudget(posts());
  assert.deepEqual(errors, []);
  await context.close();
});

test('Markets reads the searched token, then its pools and the catalogue only on demand, through the public bridge; a pool page opens only from a verified read', async () => {
  const { context, page, errors } = await visit('/pools');
  try {
    await page.getByRole('heading', { name: 'Markets', exact: true }).waitFor();
    // The selected pools are on Markets: their lean load, and the rail card's one hourly read for its pool (read-v1: this Worker lists no read-v3 history), are the route's only reading on mount.
    await poolsSettled(page);
    await cardSettled(page);
    await page.waitForTimeout(300);
    assert.deepEqual(trail().sort(), [...MOUNT].sort(), 'route mount reads the selected pools and the card, and nothing else');
    const cardIndex = posts().findIndex((read) => JSON.parse(read.body).includePriceHistory === true);
    const cardRead = JSON.parse(posts()[cardIndex].body);
    assert.deepEqual(cardRead, { poolId: POOL, includePriceHistory: true, priceToken: 'quote' }, 'the card asks for the same candles the pool page would');
    // Changed on purpose 2026-09-28 (speed wave, item 1): the budget it shares is the gateway's, no longer 1.1 s apart.
    assert.ok(cardIndex > 0, 'the independent card reads after the table');
    assertWithinBudget(posts());
    await page.locator('#markets-search').fill(TOKEN);
    const combobox = page.getByRole('combobox', { name: 'Token name or address' });
    await combobox.waitFor();
    assert.equal(await combobox.inputValue(), TOKEN, 'no selected pool matches, so the token search starts from the address');
    await page.waitForTimeout(300);
    assert.deepEqual(trail().sort(), [...MOUNT].sort(), 'typing an address reads nothing: only choosing it asks');
    await combobox.click();
    await page.locator(`[data-token-option="${TOKEN}"]`).click();
    const card = page.locator('[data-token-lookup="ok"]');
    await card.waitFor({ timeout: 30_000 });
    assert.equal(await page.evaluate(() => location.hash), `#/markets/${TOKEN}`, 'the searched token is the link');
    // Where and when the token was read is the row's title and the card's data, never a caption on the card.
    assert.doesNotMatch(await card.innerText(), /Read at block|Robinhood Chain/);
    assert.equal(await card.getAttribute('data-token-block'), '700');
    assert.equal(await card.locator('.dm-mkt-lookup-token').getAttribute('title'), 'Read at block 700 on Robinhood Chain.');
    await page.waitForTimeout(300);
    assert.equal(await page.locator('[data-found-pools]').count(), 0, 'a search asks first: no pools until Find pools');
    assert.equal(posts().some((r) => r.path.endsWith('/pools')), false, 'and no pools read on its own');

    await page.locator('[data-find-pools]').click();
    const pool = page.locator('[data-found-pools] [data-pool-option="discovery"]');
    await pool.waitFor({ timeout: 30_000 });
    assert.equal(await page.locator('[data-find-pools]').innerText(), 'Pools below');
    await pool.locator('summary').click();
    const poolText = await pool.innerText();
    assert.match(poolText, /Found by provider discovery, verified on chain/);
    assert.doesNotMatch(poolText, /GeckoTerminal|DexScreener/, 'the provider is never named on a screen');
    assert.match(poolText, /verified at block 700/);
    // Live pool: whether an estimate exists is not knowable ahead of time, so the
    // outcome is read off the attribute and the words are required to agree with it.
    assert.doesNotMatch(poolText, /Pool APR unavailable/, 'the constant caveat is gone');
    const aprState = await pool.locator('[data-row-apr]').getAttribute('data-row-apr');
    assert.ok(['estimate', 'stale', 'none'].includes(aprState), `unexpected APR state ${aprState}`);
    if (aprState === 'none') assert.doesNotMatch(poolText, /% est\./, 'a refusal prints no percentage');
    else assert.match(poolText, /% est\./, 'an estimate prints its percentage');
    assert.equal(await pool.locator('input').count(), 0, 'on Explore a pool row is a way in, not a choice');
    assert.equal(posts().some((r) => r.path.endsWith('/catalogue')), false, 'catalogue is not loaded with discovery');
    // No caption about where the pools or the catalogue come from: the rows and the candidates say it themselves.
    assert.doesNotMatch(await page.locator('[data-found-pools]').innerText(), /figures reported by a market data provider|neutral order/);
    const browser = page.locator('[data-catalogue-browser]');
    await browser.locator('summary').click();
    assert.doesNotMatch(await browser.innerText(), /Stored candidates for one token, paged/);
    await browser.getByRole('button', { name: 'Load catalogue candidates' }).click();
    await page.locator('[data-catalogue-item]').waitFor({ timeout: 30_000 });
    assert.match(await page.locator('[data-catalogue]').innerText(), /Configured interval only, blocks \d+–(?:\d+|not yet indexed)\. Not complete history\./);
    assert.equal(await page.locator('[data-catalogue-item] input[type="radio"]').count(), 0, 'a stored candidate is not a selectable verified pool');
    assert.equal(await page.locator('[data-catalogue-item]').getByRole('button', { name: 'Verify at the latest block' }).count(), 1, 'a candidate opens only after a verification read');

    // The pool row opens its page, which starts from a verified read of that one id, then the page's lean market read.
    await pool.locator('[data-open-pool]').click();
    await page.waitForFunction((hash) => location.hash === hash, `#/pool/${POOL}/${TOKEN}`);
    const workspace = page.locator(`[data-pool-workspace="${POOL}"]`);
    await workspace.waitFor({ timeout: 30_000 });
    // Changed on purpose (2026-09-27, round 6, the pool page for beginners): the verification is a row of Details, the
    // one closed card at the end of the page that holds everything technical.
    await workspace.locator('[data-pool-details] > summary').click();
    // Changed on purpose 2026-10-01 (audit I1): the pool was read on chain; its tokens are not called verified.
    assert.match(await workspace.innerText(), /On chain at block 700/);
    await page.waitForFunction(() => document.querySelectorAll('[data-pool-figures] [data-metric]').length > 0, null, { timeout: 30_000 });
    // Changed on purpose (2026-09-27, round 6): a typical range to read, drawn on the pool's price, replaces the planner.
    const range = page.locator('[data-pool-range-guide]');
    await range.waitFor();
    assert.equal(await range.getAttribute('data-pool-range-guide'), 'ready');
    assert.equal(await page.locator('main [data-picker="range"], main input[type="range"]').count(), 0, 'nothing to drag that saves nothing');
    // Changed on purpose (round 6, 2026-09-27): New position's link names the token this page verified the pool with, so
    // New position verifies it the same way (a pool of neither list may not hold USDG). Its name is the pool page's own,
    // Create a position (r6/poolpage and r6/newposition merged, 2026-09-28).
    assert.equal(await page.locator('main').getByRole('link', { name: 'Create a position' }).getAttribute('href'), `#/new/${POOL}/${TOKEN}`);
    // Every optional route this Worker lists is read by the page itself, one after another: its history, its activity, its positions.
    await page.locator('[data-pool-positions]:not([data-pool-positions="loading"])').waitFor({ timeout: 30_000 });
    const forbidden = /sign|approve|connect|deposit|swap|quote|mint|confirm|execute|buy|sell/i;
    for (const name of await page.locator('main button').allInnerTexts()) assert.doesNotMatch(name, forbidden, name);
    await page.waitForTimeout(1200);

    // The metadata already read for this address is reused by the search and
    // token view; neither creates another token request within its TTL.
    assert.deepEqual(trail().slice(MOUNT.length), [
      'POST /api/read/v1/pools',
      'POST /api/read/v1/catalogue',
      'POST /api/read/v1/pools',
      'POST /api/read/v1/pool-market',
      'POST /api/read/v1/pool-metrics',
      'POST /api/read/v1/pool-activity',
      'POST /api/read/v1/pool-positions',
    ], 'only the public reads the page lists: no market polling, session or financial call');
    assert.deepEqual(posts().slice(MOUNT_POSTS).map((r) => JSON.parse(r.body)), [
      { token: TOKEN }, // Find pools
      { token: TOKEN, limit: 20 },
      { token: TOKEN, maxPools: 1, poolIds: [POOL] },
      { poolId: POOL, includePriceHistory: false },
      { poolId: POOL },
      { poolId: POOL },
      { poolId: POOL },
    ]);
    for (const r of edge) {
      assert.equal(r.headers['sec-fetch-site'], 'same-origin');
      for (const forbidden of ['authorization', 'x-domino-csrf', 'x-domino-session']) assert.equal(r.headers[forbidden], undefined, forbidden);
    }
    // Changed on purpose 2026-09-28 (speed wave, item 1): within the gateway's budget, no longer 1.1 s apart.
    assertWithinBudget(posts());

    // Back on Markets with no token in the link, nothing of the search remains; a new search starts from its own token reads.
    await page.locator('nav[aria-label="Breadcrumb"]').getByRole('link', { name: 'Markets' }).click();
    await page.waitForFunction(() => location.hash === '#/markets');
    await page.getByRole('heading', { name: 'Markets', exact: true }).waitFor();
    assert.equal(await page.locator('[data-token-lookup], [data-pool-option], [data-catalogue-item]').count(), 0, 'leaving the search discards its findings');
    const before = posts().length;
    const native = '0x0000000000000000000000000000000000000000';
    await search(page, native);
    await page.locator('[data-token-lookup="ok"][data-token-card="native"]').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(300);
    assert.equal(await page.locator('[data-found-pools], [data-pool-option]').count(), 0, 'a new token has no pools until asked');
    assert.deepEqual(posts().slice(before), [], 'the native metadata is still cached; selecting it starts no pool read');
    // Changed on purpose (2026-09-27): through the docs, since the owner removed Settings (round 6, point 6).
    await page.goto(`${origin}/#/docs`);
    await page.getByRole('heading', { name: 'Docs', exact: true }).waitFor();
    await page.goto(`${origin}/#/pools`);
    await page.getByRole('heading', { name: 'Markets', exact: true }).waitFor();
    assert.equal(await page.locator('[data-token-lookup], [data-pool-option]').count(), 0, 'leaving the route discards its choices');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('a token view opened by a link reads the token itself, then finds its pools', async () => {
  const { context, page, errors } = await visit(`/markets/${TOKEN}`);
  try {
    await page.locator('[data-token-lookup="ok"]').waitFor({ timeout: 30_000 });
    // A link is a question already asked: its pools are found without a press.
    await page.locator('[data-found-pools] [data-pool-option="discovery"]').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(300);
    const bodies = posts().map((r) => ({ path: r.path, body: JSON.parse(r.body) }));
    const tokenReads = bodies.filter((r) => r.path === '/api/read/v1/token');
    assert.deepEqual(tokenReads.map((r) => r.body), [{ token: TOKEN }], 'no search handed anything over: the view reads the token, once');
    const at = bodies.findIndex((r) => r.path === '/api/read/v1/token');
    assert.deepEqual(bodies[at + 1], { path: '/api/read/v1/pools', body: { token: TOKEN } }, 'then the pools of the token it read');
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
});

test('Markets with markets-snapshot listed: the stored pool is on screen from one read, its tokens and history follow, and the mount never asks the estimate namespace', async () => {
  BRIDGE.ENABLED_READS = `${ALL_READS},markets-snapshot`;
  overrideReply = (route) => (route === 'markets-snapshot' ? { status: 200, text: fixture('markets-snapshot.subset') } : null);
  try {
    const { context, page, errors } = await visit('/pools');
    try {
      await page.getByRole('heading', { name: 'Markets', exact: true }).waitFor();
      await poolsSettled(page);
      await cardSettled(page);
      await page.waitForTimeout(300);
      assert.deepEqual(trail().sort(), [
        'GET /api/read/v3/capabilities',
        'GET /api/read/v1/capabilities',
        'POST /api/read/v1/markets-snapshot',
        'POST /api/read/v1/token',
        'POST /api/read/v1/token',
        'POST /api/read/v1/pool-metrics',
        'POST /api/read/v1/pool-market',
      ].sort(), 'a fresh stored entry needs no market read of its own: the only pool-market is the card’s hourly read, which is read-v1’s');
      assert.deepEqual(JSON.parse(posts()[0].body), { poolIds: [POOL] });
      assert.deepEqual(JSON.parse(posts().find((read) => JSON.parse(read.body).includePriceHistory === true).body), { poolId: POOL, includePriceHistory: true, priceToken: 'quote' });
      assert.equal(await page.locator('[data-selected-pools] tbody tr[data-row-source="markets-snapshot"]').count(), 1);
      // Changed on purpose 2026-09-28 (speed wave, item 1): within the gateway's budget, no longer 1.1 s apart.
      assertWithinBudget(posts());
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    BRIDGE.ENABLED_READS = ALL_READS;
    overrideReply = null;
  }
});

for (const route of ['pools', 'catalogue']) {
  test(`Markets asks a failed first ${route} read again on its own, quietly, without losing the searched token`, { timeout: 60_000 }, async () => {
    const { context, page, errors } = await visit('/pools');
    let calls = 0;
    overrideReply = (read, body) => {
      if (read !== route) return null;
      calls += 1;
      if (calls === 1) return { status: 503, text: fixture(`../error/${route}.upstream_unavailable`) };
      return REPLY(read, body);
    };
    try {
      await page.getByRole('heading', { name: 'Markets', exact: true }).waitFor();
      await search(page, TOKEN);
      await page.locator('[data-token-lookup="ok"]').waitFor({ timeout: 30_000 });
      await page.locator('[data-find-pools]').click();
      if (route === 'catalogue') {
        await page.locator('[data-found-pools] [data-pool-option="discovery"]').waitFor({ timeout: 30_000 });
        await page.locator('[data-catalogue-browser] summary').click();
        await page.locator('[data-catalogue-browser]').getByRole('button', { name: 'Load catalogue candidates' }).click();
      }
      const holder = route === 'pools' ? '[data-found-pools] [data-picker="pool"]' : '[data-catalogue]';
      const state = route === 'pools' ? 'data-pools-state' : 'data-catalogue-state';
      await page.waitForFunction(([selector, name]) => document.querySelector(selector)?.getAttribute(name) === 'unavailable', [holder, state], { timeout: 30_000 });
      // No panel and no Retry: why is said to assistive technology, and is the title of what stands in for the list.
      const block = page.locator(holder);
      assert.equal(await block.getByRole('button', { name: /Retry|Trying again/ }).count(), 0, `${route}: no retry control`);
      assert.equal(await block.locator('.dm-inset[role="status"], [data-screen-status]:not(.sr-only)').count(), 0, `${route}: no status panel`);
      assert.match(await block.locator('[role="status"]').first().textContent(), /The read service answered: read service unavailable\./);
      if (route === 'pools') assert.equal(await block.locator('[data-pools-unavailable]').count(), 0, 'while it waits to be asked again, nothing says there are no pools');
      assert.equal(calls, 1, 'nothing is asked again at once');
      // After its quiet wait the same question goes out again, on its own, through the shared paced source.
      await page.locator(route === 'pools' ? '[data-found-pools] [data-pool-option="discovery"]' : '[data-catalogue-item]').waitFor({ timeout: 30_000 });
      assert.equal(await page.locator('[data-token-lookup="ok"]').count(), 1, 'the searched token remains');
      assert.equal(await page.locator('[data-find-pools]').innerText(), 'Pools below', 'and its pools stay asked for');
      const requests = posts().filter((r) => r.path.endsWith(`/${route}`));
      assert.equal(requests.length, 2);
      const expected = route === 'pools' ? { token: TOKEN } : { token: TOKEN, limit: 20 };
      assert.deepEqual(requests.map((r) => JSON.parse(r.body)), [expected, expected], 'the same question, without a cursor or another token');
      // About 4 s, give or take the quiet policy's quarter of jitter (transient.ts): never sooner than 3 s.
      assert.ok(requests[1].at - requests[0].at >= 3000, 'asked again only after the quiet wait');
      assert.deepEqual(errors, []);
    } finally {
      overrideReply = null;
      await context.close();
    }
  });
}

test('Markets: a pools list that fails for good leaves one plain muted line, its code in data and its reason in the title, and is not asked again; a hop’s refusal before it is asked again', { timeout: 60_000 }, async () => {
  const { context, page, errors } = await visit('/pools');
  // The dev lane's name-search walk (2026-09-15): pools {token} answered 502 upstream_contract_mismatch, which a gateway that
  // does not stamp its mid-hop failures sends for a hop that is only flapping, so it is asked again on its own (transient.ts).
  // The lane's other 502, upstream_invalid_response, is a reply that comes back the same.
  let answered = 0;
  overrideReply = (read) => {
    if (read !== 'pools') return null;
    answered += 1;
    return answered === 1 ? { status: 502, text: fixture('../error/pools.upstream_contract_mismatch') } : { status: 502, text: '{"error":"upstream_invalid_response"}' };
  };
  try {
    await page.getByRole('heading', { name: 'Markets', exact: true }).waitFor();
    await search(page, TOKEN);
    await page.locator('[data-token-lookup="ok"]').waitFor({ timeout: 30_000 });
    await page.locator('[data-find-pools]').click();
    const picker = page.locator('[data-found-pools] [data-picker="pool"]');
    await page.locator('[data-found-pools] [data-picker="pool"][data-pools-state="incompatible"]').waitFor({ timeout: 30_000 });
    assert.equal(await picker.locator('[data-pools-unavailable]').count(), 0, 'while a hop’s refusal waits to be asked again, nothing says there are no pools');
    const line = page.locator('[data-found-pools] [data-pools-unavailable]');
    await line.waitFor({ timeout: 30_000 });
    const lists = () => posts().filter((r) => r.path.endsWith('/pools'));
    assert.equal(lists().length, 2, 'the hop’s refusal was asked again once, on its own');
    assert.ok(lists()[1].at - lists()[0].at >= 3000, 'after the quiet wait (transient.ts): never sooner than 3 s');
    assert.equal(await line.innerText(), 'No pools to show for this token.');
    assert.equal(await line.getAttribute('data-pools-unavailable'), 'upstream_invalid_response');
    assert.match(await line.getAttribute('title'), /Pool data unavailable\. The read service answered: upstream invalid response\./);
    assert.match(await line.getAttribute('class'), /\btext-fg-muted\b/, 'one plain muted line');
    assert.equal(await picker.getByRole('button', { name: /Retry|again/i }).count(), 0, 'no retry control');
    assert.doesNotMatch(await visibleText(picker), /^—$|contract mismatch|invalid response|unavailable/i, 'no bare dash, and no reason printed');
    await page.waitForTimeout(5_500);
    assert.equal(lists().length, 2, 'a reply the hop could not read comes back the same: not asked again');
    assert.deepEqual(errors, []);
  } finally {
    overrideReply = null;
    await context.close();
  }
});

test('the pool page never shows activity months behind the chain as the last 24 hours: every figure a dash, how far behind only in the title', { timeout: 60_000 }, async () => {
  // The dev lane's WETH/USDG answer (2026-09-15): a covered window of 116 swaps, 4,891,659 s behind the chain head.
  overrideReply = (read) => {
    if (read !== 'pool-activity') return null;
    const body = JSON.parse(fixture('pool-activity.stale'));
    body.freshness = { ...body.freshness, ageSeconds: 4_891_659, status: 'stale' };
    return { status: 200, text: JSON.stringify(body) };
  };
  const { context, page, errors } = await visit(`/pool/${POOL}/${TOKEN}`);
  try {
    // Changed on purpose (2026-09-27, round 6, the pool page for beginners): the activity figures are a part of the
    // page's closed Details card, under a heading of their own; the page's Recent activity says the last day in words.
    await page.locator('[data-pool-details] > summary').click();
    const card = page.locator('[data-pool-activity]');
    await page.locator('[data-pool-activity="unavailable"]').waitFor({ timeout: 30_000 });
    assert.equal(await card.getAttribute('data-activity-reason'), 'activity_stale');
    const why = 'Stale: indexed 56 days behind the chain head, at block 700, too far behind to show as the last 24 hours.';
    assert.equal(await card.getAttribute('title'), why);
    assert.equal(await card.locator('[role="status"]').textContent(), why, 'a screen reader hears why');
    const shown = await visibleText(card);
    assert.equal(shown.replace(/[^—]/g, '').length, 10, `every figure is a dash: ${shown}`);
    assert.doesNotMatch(shown, /Older than 24 h|24 h covered|observed|10 to 700|stale|behind|indexed chain events/i, 'no window, pool age, blocks or reason on the card');
    assert.equal(await card.locator('h3').getAttribute('title'), 'Swaps and fees over the 24 hours up to the last indexed block, from indexed chain events.');
    assert.equal(posts().filter((r) => r.path.endsWith('/pool-activity')).length, 1, 'one read, not asked again');
    assert.deepEqual(errors, []);
  } finally {
    overrideReply = null;
    await context.close();
  }
});

/** Answers the provider (DEX Screener) for the page itself, and keeps every URL it was asked (2026-09-25: the Wallet card's one price GET). */
const provider = (asked, answer) => async (context) => {
  await context.route(/^https:\/\/(api|cdn)\.dexscreener\.com\//, (route) => {
    asked.push(route.request().url());
    const reply = answer(route.request().url());
    return reply === null ? route.fulfill({ status: 503, contentType: 'text/plain', body: 'busy' }) : route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(reply) });
  });
};

// The tokens the wallet list checks by address (src/config/selectedPoolCatalogue.ts WALLET_FALLBACK_TOKENS): WETH and
// USDG, the main tokens, then the selected pools' other tokens in catalogueTokens() order.
// Changed on purpose 2026-10-04 (the owner's new embedded list): seven, from six. MARLIN, cbBTC and U left with their
// pools; WETH is still checked as a main token, though no selected pool holds it any more.
const SELECTED_TOKENS = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73', // WETH
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168', // USDG
  '0x39dbed3a2bd333467115de45665cc57f813c4571', // PONS
  '0xaa07a0e9209e16ac99708c3ec70159c6ef3128a3', // ORBIO
  '0x020bfc650a365f8bb26819deaabf3e21291018b4', // CASHCAT
  '0x812486eaea648819853f8e372dc9f1516c7868bd', // UBIK
  '0xc6911796042b15d7fa4f6cde69e245ddcd3d9c31', // VIRTUAL
];

test('a partial wallet page lists what was read with no notice, checks the selected pool tokens once by address, and never says the list is complete', async () => {
  const USDG = SELECTED_TOKENS[1];
  overrideReply = (route, body) => {
    if (route !== 'wallet-assets') return null;
    if (body.autoDiscover === false) {
      // The by-address check: native ETH, and a USDG balance.
      const check = JSON.parse(fixture('wallet-assets.not-requested'));
      check.items[1].address = USDG;
      return { status: 200, text: JSON.stringify(check) };
    }
    // The only page, which skipped seven provider candidates for the request budget.
    const page = JSON.parse(fixture('wallet-assets.last-page'));
    page.inventory = { ...page.inventory, candidatesProbed: 13, candidatesSkipped: 7, skippedReason: 'request_budget_exhausted' };
    return { status: 200, text: JSON.stringify(page) };
  };
  try {
    const { context, page, errors } = await visit(`/portfolio/${OWNER}`);
    try {
      const list = page.locator('[data-portfolio-tokens]');
      await page.locator(`[data-wallet-row="${USDG}"][data-wallet-row-via="address"]`).waitFor({ timeout: 30_000 });
      assert.equal(await list.getAttribute('data-wallet-partial'), '7');
      assert.equal(await list.getAttribute('data-wallet-skipped-reason'), 'request_budget_exhausted');
      // Every digit of the balance leads the title (changed on purpose: the row shows six significant digits), then where it came from.
      assert.match(await list.locator(`[data-wallet-row="${USDG}"] [data-balance]`).getAttribute('title'), /^57,896,044,618,658,097,711,785,492,504,343,953,926,634,992,332,820,282,019,728,792,003,956,564\.820091 · Checked by address at block 700$/);
      assert.match(await list.locator('.dm-acct-tokens-count').getAttribute('title'), /7 provider candidates weren’t checked in this read\./);

      const walletPosts = posts().filter((r) => r.path === '/api/read/v1/wallet-assets');
      assert.deepEqual(walletPosts.map((r) => JSON.parse(r.body)), [
        { wallet: OWNER, autoDiscover: true },
        { wallet: OWNER, tokens: SELECTED_TOKENS, autoDiscover: false },
      ], 'one listing, then one check of the selected pools’ tokens the page lacks, and nothing else');
      // Changed on purpose 2026-09-28 (speed wave, item 1): the pacing it shares is the gateway's budget, no longer 1.1 s.
      assertWithinBudget(posts());

      const text = await list.innerText();
      assert.doesNotMatch(text, /All pages loaded|weren’t checked|skipped|partial/i, 'the partial coverage is not printed, and nothing calls the list complete');
      assert.match(text, /3 tokens listed/);
      assert.equal(await list.locator('[data-screen-status], .dm-inset, .text-money-wait, .dm-acct-tokens-foot').count(), 0, 'no status panel, footnote or yellow');
      assert.equal(await list.getByRole('button', { name: /Retry|Refresh|Load more|All pages loaded/ }).count(), 0, 'nothing to press: the page has no next one');
      await page.waitForTimeout(1500);
      assert.equal(posts().filter((r) => r.path === '/api/read/v1/wallet-assets').length, 2, 'the check is made once');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    overrideReply = null;
  }
});

/** A wallet-assets reply that lists exactly `items` (built from the last-page fixture's native and token rows) on a finished provider page. */
function walletPage(items, inventory = {}) {
  const body = JSON.parse(fixture('wallet-assets.last-page'));
  const [native, token] = body.items;
  body.items = items({ native, token });
  body.inventory = { ...body.inventory, hasMore: false, nextCursor: null, ...inventory };
  return { status: 200, text: JSON.stringify(body) };
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
/** The wallet-assets POST bodies the browser sent, in order; a body still being read is an empty object. */
const walletBodies = () => posts().filter((r) => r.path === '/api/read/v1/wallet-assets').map((r) => (r.body === null ? {} : JSON.parse(r.body)));

test('an address whose provider page lists nothing held: the selected pools’ tokens are asked for by address, the form is offered, and nothing calls the list complete', async () => {
  // The live review's address: a PoolManager holding a pool's reserves, for which the provider returned no rows and the reply listed native ETH at 0.
  const USDG = SELECTED_TOKENS[1];
  overrideReply = (route, body) => {
    if (route !== 'wallet-assets') return null;
    if (body.tokens === undefined) return walletPage(({ native }) => [native], { rowsReceived: 0, candidatesProbed: 0 });
    // The selected pools' tokens, by address: this address holds USDG.
    return walletPage(({ native, token }) => [native, ...body.tokens.map((address) => ({ ...token, address, amountRaw: address === USDG ? '1500000' : '0' }))], { rowsReceived: 0, candidatesProbed: 0 });
  };
  try {
    const { context, page, errors } = await visit(`/portfolio/${OWNER}`);
    try {
      const list = page.locator('[data-portfolio-tokens]');
      await list.locator(`[data-wallet-row="${USDG}"]`).waitFor({ timeout: 30_000 });
      assert.deepEqual(walletBodies(), [
        { wallet: OWNER, autoDiscover: true },
        // Changed on purpose (2026-09-20): this second read is the by-address
        // check the test's own name describes. Discovery has just reported
        // that this address holds nothing listed, so asking it to look again
        // is work with a known answer — and it is what made a single-token
        // balance cost about 90 local RPC items instead of 12.
        { wallet: OWNER, tokens: SELECTED_TOKENS, autoDiscover: false },
      ], 'the list showed nothing held, so the selected pools’ tokens are asked for once, by their addresses');
      assert.equal(await list.locator(`[data-wallet-row="${USDG}"] [data-balance]`).innerText(), '1.5');
      assert.equal(await list.getAttribute('data-wallet-verified-checked'), '');
      const count = list.locator('.dm-acct-tokens-count');
      assert.match(await count.getAttribute('title'), /Balances checked for the verified pool tokens by their exact addresses\./);
      assert.doesNotMatch(`${await count.getAttribute('title')} ${await list.innerText()}`, /All pages loaded|complete/i, 'a provider page never makes the list complete');
      assert.equal(await list.locator('[data-wallet-tokens-form]').count(), 1, 'Check balances is offered, for any other token');
      await page.waitForTimeout(1500);
      assert.equal(walletBodies().length, 2, 'asked once per address, not again for the answer');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    overrideReply = null;
  }
});

// Changed on purpose (review of 2026-09-25): the Wallet card values the whole list, so it reads the list's pages on its
// own and nothing waits for Load more. The check a partial list is owed now goes out once, after the last page, for
// what the whole list lacks (here the same six tokens: neither page lists one), instead of after page 1 with Load
// more pressed behind it. The session-level rule that a check on the wire is joined, never asked twice, is still
// covered in tests/screens.test.mjs. Since 2026-10-04 (the owner's new embedded list) the tokens are seven, all of
// SELECTED_TOKENS; neither page lists one still.
test('a partial list is read to its last page on its own, then checked once by address for what the whole list lacks, and its balance stays', async () => {
  const USDG = SELECTED_TOKENS[1];
  overrideReply = async (route, body) => {
    if (route !== 'wallet-assets') return null;
    if (body.autoDiscover === false) {
      // The by-address check takes a while on the wire.
      await sleep(1500);
      const check = JSON.parse(fixture('wallet-assets.not-requested'));
      check.items[1].address = USDG;
      return { status: 200, text: JSON.stringify(check) };
    }
    if (body.cursor !== undefined) return { status: 200, text: fixture('wallet-assets.last-page') };
    // A first page with more to come, which skipped seven provider candidates.
    const first = JSON.parse(firstWalletPage());
    first.inventory = { ...first.inventory, candidatesProbed: 13, candidatesSkipped: 7, skippedReason: 'request_budget_exhausted' };
    return { status: 200, text: JSON.stringify(first) };
  };
  const asked = [];
  try {
    const { context, page, errors } = await visit(`/portfolio/${OWNER}`, provider(asked, () => []));
    try {
      const list = page.locator('[data-portfolio-tokens]');
      await list.locator(`[data-wallet-row="${USDG}"][data-wallet-row-via="address"]`).waitFor({ timeout: 30_000 });
      assert.equal(await list.getAttribute('data-wallet-pages'), '2', 'both pages were read, without a press');
      await page.waitForTimeout(1500);
      assert.deepEqual(walletBodies(), [
        { wallet: OWNER, autoDiscover: true },
        { wallet: OWNER, autoDiscover: true, cursor: HANDLE },
        { wallet: OWNER, tokens: SELECTED_TOKENS, autoDiscover: false },
      ], 'the pages first, then one check of the selected pools’ tokens the whole list lacks, and nothing else');
      assert.equal(await list.getAttribute('data-wallet-partial'), '7');
      assert.equal(await list.getAttribute('data-wallet-total-withheld'), 'skipped_candidates', 'candidates the pages skipped were never valued: no total claims to be the wallet’s');
      assert.equal(await list.locator('[data-wallet-total]').count(), 0);
      assert.equal(await list.getByRole('button', { name: /Load more|All pages loaded/ }).count(), 0, 'the last page leaves nothing to press, and says nothing about being complete');
      assert.equal(asked.filter((url) => url.includes('/tokens/v1/')).length, 1, 'one price GET, for the whole list');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    overrideReply = null;
  }
});


// 2026-09-25 (owner: the Wallet card lists only the main tokens, by USD value, "if that doesn't cause too much load").
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const NATIVE = '0x0000000000000000000000000000000000000000';
const UFG = '0xefab538cf3c29237a47c6afb145d50ddf204a0a3';
const FAKE_USDG = '0x3c261bf9087b11bd30861881492ed02e9ad1c7de';
const DUST = '0x4444444444444444444444444444444444444444';
const UNPRICED = '0x5555555555555555555555555555555555555555';
/** A wallet holding 0.01 ETH, 5.5 USDG, 1,000,000 UFG, a second "USDG", a token worth ten cents and one with no price. */
const heldWallet = () => walletPage(({ native, token }) => [
  { ...native, amountRaw: '10000000000000000' },
  { ...token, address: SELECTED_TOKENS[1], symbol: 'USDG', decimals: 6, amountRaw: '5500000' },
  { ...token, address: UFG, symbol: 'UFG', decimals: 18, amountRaw: '1000000000000000000000000' },
  { ...token, address: FAKE_USDG, symbol: 'USDG', decimals: 18, amountRaw: '50000000000000000000' },
  { ...token, address: DUST, symbol: 'DUST', decimals: 18, amountRaw: '1000000000000000000' },
  { ...token, address: UNPRICED, symbol: 'NOPE', decimals: 18, amountRaw: '1000000000000000000000' },
]);
const providerPair = (base, priceUsd, usd) => ({ chainId: 'robinhood', dexId: 'uniswap', baseToken: { address: base, symbol: 'X' }, quoteToken: { address: SELECTED_TOKENS[1], symbol: 'USDG' }, priceUsd, liquidity: { usd } });

const rowsOf = (list) => list.locator('[data-wallet-row]').evaluateAll((rows) => rows.map((row) => row.getAttribute('data-wallet-row')));

// Changed on purpose (round 6, 2026-09-27; the owner: convert every token to USD and ALWAYS show the top 3 by value):
// the card showed the five largest holdings worth $1 and left out dust and every token without a price. Now the top 3
// are the card, and "Show all" opens every other held token: dust with its value, the priceless last with a dash.
// A second "USDG" (a look-alike) is still left out.
test('the Wallet card: the total, then the top 3 by USD value from ONE provider GET; Show all opens the rest, dust valued, the priceless last; a second USDG left out', async () => {
  overrideReply = (route) => (route === 'wallet-assets' ? heldWallet() : null);
  const asked = [];
  try {
    const { context, page, errors } = await visit(`/portfolio/${OWNER}`, provider(asked, (url) => (url.includes('/tokens/v1/') ? [
      providerPair(WETH, '2000', 1e7),
      providerPair(UFG, '0.003', 165_000),
      providerPair(FAKE_USDG, '1', 1e6),
      providerPair(DUST, '0.1', 1e6),
    ] : [])));
    try {
      const list = page.locator('[data-portfolio-tokens]');
      await page.locator('[data-portfolio-tokens][data-wallet-prices="ok"] [data-wallet-total]').waitFor({ timeout: 30_000 });
      assert.equal(await list.locator('[data-wallet-total] .dm-fig-xl').textContent(), '$3,025.60', '1,000,000 UFG at $0.003, 0.01 ETH at WETH’s $2,000, 5.5 USDG at $1 and one DUST at $0.10');
      assert.deepEqual(await rowsOf(list), [UFG, NATIVE, SELECTED_TOKENS[1]], 'the top 3, largest first');
      assert.deepEqual(await list.locator('[data-usd]').allTextContents(), ['$3,000.00', '$20.00', '$5.50']);
      assert.deepEqual(await list.locator('[data-balance]').allTextContents(), ['1,000,000', '0.01', '5.5'], 'each amount, small, under its symbol');
      assert.equal(await list.getAttribute('data-wallet-held'), '5', 'five tokens held, the look-alike aside');
      assert.equal(await list.locator('[data-token-mark="unknown"]').count(), 1, 'UFG has no artwork in the reply: its disc');
      assert.equal(await list.locator('[data-token-mark="unknown"]').getAttribute('data-letters'), 'UF', 'a monogram, never an empty circle');
      assert.equal(await list.locator('[data-token-mark="unknown"]').textContent(), '', 'drawn by its class: copying the row never picks the letters up');

      const all = list.getByRole('button', { name: 'Show all 5' });
      assert.equal(await all.getAttribute('aria-expanded'), 'false');
      await all.click();
      assert.deepEqual(await rowsOf(list), [UFG, NATIVE, SELECTED_TOKENS[1], DUST, UNPRICED], 'every held token: dust by its value, the priceless last');
      assert.deepEqual(await list.locator('[data-usd]').allTextContents(), ['$3,000.00', '$20.00', '$5.50', '$0.10']);
      assert.equal(await visibleText(list.locator(`[data-wallet-row="${UNPRICED}"] [data-no-price]`)), '—', 'no price: a quiet dash');
      assert.equal(await list.locator(`[data-wallet-row="${UNPRICED}"] [data-no-price] .sr-only`).textContent(), 'No price', 'and words for a screen reader');
      assert.equal(await list.locator('[data-wallet-unpriced-note]').innerText(), 'No price found');
      assert.equal(await list.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded'), 'true');
      assert.equal(await list.locator(`[data-wallet-row="${FAKE_USDG}"]`).count(), 0, 'the second USDG never');

      assert.match(await list.locator('.dm-acct-tokens-count').textContent(), /6 tokens listed/, 'the count line still counts what was listed');
      const prices = asked.filter((url) => url.includes('/tokens/v1/robinhood/'));
      assert.equal(prices.length, 1, 'one price GET for the page view');
      // Review of 2026-09-25: only what the wallet holds is named: no selected-pool token it does not hold, no look-alike.
      assert.equal(new URL(prices[0]).pathname, `/tokens/v1/robinhood/${[WETH, UNPRICED, DUST, UFG].sort().join(',')}`);
      assert.deepEqual(asked.filter((url) => url.includes('/token-pairs/')), [], 'the price reply answered the artwork: no GET per row');
      assert.equal(await list.getAttribute('data-wallet-total-withheld'), null, 'a whole list: its total is shown');
      assert.equal(walletBodies().length, 1, 'one listing, nothing else asked of the read service');
      await page.waitForTimeout(1000);
      assert.equal(asked.filter((url) => url.includes('/tokens/v1/')).length, 1, 'not asked again');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    overrideReply = null;
  }
});

// Changed on purpose (round 6): with no prices the card listed native ETH, WETH and USDG only, by their amounts. Now
// it lists what the wallet holds as always: USDG is still $1, every other token shows its amount and a dash, the main
// tokens first; no total.
test('the Wallet card without prices: USDG at $1, the others with their amounts and a dash, the main tokens first, and no total', async () => {
  overrideReply = (route) => (route === 'wallet-assets' ? heldWallet() : null);
  const asked = [];
  try {
    const { context, page, errors } = await visit(`/portfolio/${OWNER}`, provider(asked, () => null));
    try {
      const list = page.locator('[data-portfolio-tokens]');
      await page.locator('[data-portfolio-tokens][data-wallet-prices="failed"] [data-wallet-row]').first().waitFor({ timeout: 30_000 });
      assert.deepEqual(await rowsOf(list), [SELECTED_TOKENS[1], NATIVE, DUST], 'USDG ($1 without a provider), then native ETH, then by symbol');
      assert.deepEqual(await list.locator('[data-balance]').allTextContents(), ['5.5', '0.01', '1']);
      assert.deepEqual(await list.locator('[data-usd]').allTextContents(), ['$5.50'], 'no dollar figure without a price');
      assert.equal(await list.locator('[data-no-price]').count(), 2);
      assert.equal(await list.locator('[data-wallet-total]').count(), 0, 'no total');
      assert.equal(await list.getAttribute('data-wallet-total-withheld'), 'unanswered_prices');
      assert.equal(await list.getByRole('button', { name: /Retry|again/i }).count(), 0, 'no retry control');
      assert.equal(asked.filter((url) => url.includes('/tokens/v1/')).length, 1);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    overrideReply = null;
  }
});

const MANY = '0xa26992c4268a8a78a4d872fe4bdad2ed03ac287d';
/** A first page with a second after it: 0.01 ETH, 5.5 USDG and 1,000 UFG ($3). */
const pageWithMore = () => {
  const reply = walletPage(({ native, token }) => [
    { ...native, amountRaw: '10000000000000000' },
    { ...token, address: SELECTED_TOKENS[1], symbol: 'USDG', decimals: 6, amountRaw: '5500000' },
    { ...token, address: UFG, symbol: 'UFG', decimals: 18, amountRaw: '1000000000000000000000' },
  ], { hasMore: true, nextCursor: HANDLE });
  return reply;
};
/** The second page: the largest holding, 1,000,000 MANY ($2,000). */
const pageTwo = () => walletPage(({ native, token }) => [
  { ...native, amountRaw: '10000000000000000' },
  { ...token, address: MANY, symbol: 'MANY', decimals: 18, amountRaw: '1000000000000000000000000' },
]);
const twoPagePrices = (url) => (url.includes('/tokens/v1/') ? [providerPair(WETH, '2000', 1e7), providerPair(UFG, '0.003', 165_000), providerPair(MANY, '0.002', 400_000)] : []);
/**
 * Every set of rows and total the card ever showed, in order (a MutationObserver from the first frame), and every
 * moment it showed no row at all after it had shown some (round 6: the card must never shrink to nothing). Round 6
 * also counts every time a total on screen went away, and every time the total's placeholder came up
 * (`window.__mark()` starts both counts again, for what happens after it).
 */
const watchTotals = async (context) => {
  await context.addInitScript(() => {
    window.__totals = [];
    window.__shown = [];
    window.__emptied = 0;
    window.__totalGone = 0;
    window.__placeholders = 0;
    let hadTotal = false;
    let hadPlaceholder = false;
    window.__mark = () => {
      window.__totalGone = 0;
      window.__placeholders = 0;
    };
    const look = () => {
      const card = document.querySelector('[data-portfolio-tokens]');
      const rows = card ? [...card.querySelectorAll('[data-wallet-row]')].map((row) => row.getAttribute('data-wallet-row')).join(',') : '';
      if (window.__shown.at(-1) !== rows) {
        if (rows === '' && window.__shown.some((seen) => seen !== '')) window.__emptied += 1;
        window.__shown.push(rows);
      }
      const total = card?.querySelector('[data-wallet-total]');
      if (hadTotal && !total) window.__totalGone += 1;
      hadTotal = Boolean(total);
      const placeholder = Boolean(card?.querySelector('.dm-acct-total-skel'));
      if (placeholder && !hadPlaceholder) window.__placeholders += 1;
      hadPlaceholder = placeholder;
      if (!total) return;
      if (window.__totals.at(-1) !== rows) window.__totals.push(rows);
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true });
  });
};

// Review of 2026-09-25: the total and the top holdings are the whole list's. A wallet whose largest holding is on page 2
// must never show page 1's sum as its value: the card reads page 2 on its own and draws the list once it is whole.
// Changed on purpose (round 6): the prices of page 1's tokens are asked as soon as page 1 lands, and page 2's new token
// alone when page 2 does (no address is asked twice); the card still draws once, the whole list in its final order.
test('the Wallet card reads every page before it values the list: the largest holding on page 2 leads, and no partial total or order is ever shown', async () => {
  overrideReply = async (route, body) => {
    if (route !== 'wallet-assets') return null;
    if (body.cursor === undefined) return pageWithMore();
    await sleep(1200);
    return pageTwo();
  };
  const asked = [];
  try {
    const { context, page, errors } = await visit(`/portfolio/${OWNER}`, async (ctx) => {
      await provider(asked, twoPagePrices)(ctx);
      await watchTotals(ctx);
    });
    try {
      const list = page.locator('[data-portfolio-tokens]');
      await page.locator('[data-portfolio-tokens][data-wallet-prices="ok"] [data-wallet-total]').waitFor({ timeout: 30_000 });
      assert.deepEqual(walletBodies(), [{ wallet: OWNER, autoDiscover: true }, { wallet: OWNER, autoDiscover: true, cursor: HANDLE }], 'page 2 read on its own, with the handle page 1 gave');
      assert.equal(await list.getAttribute('data-wallet-pages'), '2');
      assert.equal(await list.locator('[data-wallet-total] .dm-fig-xl').textContent(), '$2,028.50', 'MANY $2,000 + ETH $20 + USDG $5.50 + UFG $3');
      assert.deepEqual(await rowsOf(list), [MANY, NATIVE, SELECTED_TOKENS[1]], 'page 2’s MANY leads the top 3');
      const prices = asked.filter((url) => url.includes('/tokens/v1/')).map((url) => new URL(url).pathname);
      assert.deepEqual(prices, [`/tokens/v1/robinhood/${[WETH, UFG].sort().join(',')}`, `/tokens/v1/robinhood/${MANY}`], 'page 1’s tokens, then page 2’s new one: none asked twice');
      assert.deepEqual(await page.evaluate(() => window.__shown.filter((rows) => rows !== '')), [[MANY, NATIVE, SELECTED_TOKENS[1]].join(',')], 'drawn once, the whole list in its final order');
      assert.deepEqual(await page.evaluate(() => window.__totals), [[MANY, NATIVE, SELECTED_TOKENS[1]].join(',')], 'a total was only ever shown over the whole list');
      assert.equal(await list.getByRole('button', { name: /Load more/ }).count(), 0, 'nothing left to press');
      assert.equal(await list.getByRole('button', { name: 'Show all 4' }).count(), 1);
      assert.match(await list.locator('.dm-acct-tokens-count').textContent(), /page 2 of up to 5/);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    overrideReply = null;
  }
});

// Review of 2026-09-25: pressing Load more blanked the card to skeletons until the next page landed. A later step keeps
// the rows on screen, and a list with a page it could not read shows no total at all. Round 6: "Show all" stays open
// through it.
test('a page the list could not read leaves its rows with no total; Load more keeps them on screen while it reads, Show all stays open, then the whole list is valued', async () => {
  let secondAsks = 0;
  overrideReply = async (route, body) => {
    if (route !== 'wallet-assets') return null;
    if (body.cursor === undefined) return pageWithMore();
    secondAsks += 1;
    // First a reply the hop could not read, which is final (never asked again on its own); then, pressed, page 2 after a while.
    if (secondAsks === 1) return { status: 502, text: '{"error":"upstream_invalid_response"}' };
    await sleep(2000);
    return pageTwo();
  };
  const asked = [];
  try {
    const { context, page, errors } = await visit(`/portfolio/${OWNER}`, async (ctx) => {
      await provider(asked, twoPagePrices)(ctx);
      await watchTotals(ctx);
    });
    try {
      const list = page.locator('[data-portfolio-tokens]');
      await page.locator('[data-portfolio-tokens][data-wallet-prices="ok"][data-wallet-total-withheld]').waitFor({ timeout: 30_000 });
      assert.equal(await list.getAttribute('data-wallet-total-withheld'), 'read_failed');
      assert.equal(await list.locator('[data-wallet-total]').count(), 0, 'page 2 is unread: no figure claims to be the wallet’s value');
      assert.deepEqual(await rowsOf(list), [NATIVE, SELECTED_TOKENS[1], UFG], 'page 1’s holdings, by value');
      const more = list.getByRole('button', { name: 'Load more' });
      await more.click();
      for (const wait of [100, 700, 700]) {
        await page.waitForTimeout(wait);
        assert.deepEqual(await rowsOf(list), [NATIVE, SELECTED_TOKENS[1], UFG], 'the rows stay while the next page is read');
        assert.equal(await list.locator('li[aria-hidden="true"]').count(), 0, 'no skeleton rows in their place');
        assert.equal(await list.locator('.dm-acct-tokens-actions button').last().textContent(), 'Loading…');
      }
      await page.locator('[data-portfolio-tokens] [data-wallet-total]').waitFor({ timeout: 30_000 });
      assert.equal(await list.locator('[data-wallet-total] .dm-fig-xl').textContent(), '$2,028.50');
      assert.deepEqual(await rowsOf(list), [MANY, NATIVE, SELECTED_TOKENS[1]]);
      await list.getByRole('button', { name: 'Show all 4' }).click();
      assert.deepEqual(await rowsOf(list), [MANY, NATIVE, SELECTED_TOKENS[1], UFG]);
      assert.equal(secondAsks, 2, 'the final failure was not asked again on its own; the press asked once');
      assert.deepEqual(asked.filter((url) => url.includes('/tokens/v1/')).map((url) => new URL(url).pathname), [
        `/tokens/v1/robinhood/${[WETH, UFG].sort().join(',')}`,
        `/tokens/v1/robinhood/${MANY}`,
      ], 'the press priced only the token it added: the rest are kept in memory');
      assert.equal(await page.evaluate(() => window.__emptied), 0, 'never shrank to nothing');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    overrideReply = null;
  }
});

// Round 6 (2026-09-27; the owner: the Wallet card's tokens took far too long to appear, and a card must never blank out
// on a refresh). The card keeps its last whole list per address in the browser: a second visit draws it at once, with
// its total, before the read service has answered anything; the list is read again behind it and nothing on screen
// empties meanwhile. A read that fails leaves the remembered list, and its total, on screen.
test('a second visit draws the remembered list at once, then reads it again behind it; a failed read leaves it on screen', async () => {
  let slow = false;
  let failing = false;
  overrideReply = async (route, body) => {
    if (route !== 'wallet-assets') return null;
    if (failing) return { status: 502, text: '{"error":"upstream_invalid_response"}' };
    if (slow) await sleep(2500);
    return body.cursor === undefined ? pageWithMore() : pageTwo();
  };
  const asked = [];
  try {
    const { context, page, errors } = await visit(`/portfolio/${OWNER}`, async (ctx) => {
      await provider(asked, twoPagePrices)(ctx);
      await watchTotals(ctx);
    });
    try {
      const list = page.locator('[data-portfolio-tokens]');
      await page.locator('[data-portfolio-tokens][data-wallet-prices="ok"] [data-wallet-total]').waitFor({ timeout: 30_000 });
      await list.getByRole('button', { name: 'Show all 4' }).click();
      const kept = await page.evaluate(() => Object.keys(localStorage));
      // Changed on purpose 2026-10-01 (the chain2 workstream, part B, audit G10): the key names its chain.
      assert.deepEqual(kept, ['domino-wallet-v2:4663'], 'one key, the card’s');
      const stored = await page.evaluate(() => localStorage.getItem('domino-wallet-v2:4663'));
      assert.doesNotMatch(stored, new RegExp(HANDLE), 'the continuation handle is never kept');
      assert.ok(stored.includes(OWNER.toLowerCase()) && stored.includes(MANY), 'the address and its tokens');

      // A second visit, the read service now slow: the remembered list is on screen before any wallet-assets reply.
      slow = true;
      const before = walletBodies().length;
      await page.reload();
      await list.locator('[data-wallet-total]').waitFor({ timeout: 5_000 });
      assert.equal(await list.getAttribute('data-wallet-source'), 'memory', 'drawn from memory');
      assert.equal(await list.getAttribute('data-wallet-pages'), '0', 'before the first page of the new read has landed');
      assert.equal(await list.locator('[data-wallet-total] .dm-fig-xl').textContent(), '$2,028.50');
      assert.deepEqual(await rowsOf(list), [MANY, NATIVE, SELECTED_TOKENS[1]]);
      assert.equal(await list.locator('li[aria-hidden="true"]').count(), 0, 'no skeleton on a second visit');
      await page.locator('[data-portfolio-tokens][data-wallet-source="read"]').waitFor({ timeout: 30_000 });
      assert.equal(walletBodies().length - before, 2, 'the list was read again, both pages');
      assert.deepEqual(await page.evaluate(() => [...new Set(window.__shown.filter((rows) => rows !== ''))]), [[MANY, NATIVE, SELECTED_TOKENS[1]].join(',')], 'the same rows all along');
      assert.equal(await page.evaluate(() => window.__emptied), 0, 'never shrank to nothing while it was read again');

      // A third visit, the read service failing: the remembered list stays, with its total.
      failing = true;
      await page.reload();
      await list.locator('[data-wallet-total]').waitFor({ timeout: 5_000 });
      await page.locator('[data-portfolio-tokens][data-wallet-status="failed"]').waitFor({ timeout: 30_000 });
      assert.deepEqual(await rowsOf(list), [MANY, NATIVE, SELECTED_TOKENS[1]], 'the rows stay');
      assert.equal(await list.locator('[data-wallet-total] .dm-fig-xl').textContent(), '$2,028.50', 'and the total');
      assert.equal(await list.locator('[data-wallet-empty]').count(), 0, 'no empty line');
      assert.equal(await page.evaluate(() => window.__emptied), 0);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    overrideReply = null;
  }
});

// Round 6: the list is read again every five minutes while the page is shown. The rows stay, "Show all" stays open.
test('the quiet re-read every five minutes keeps the rows and keeps Show all open', async () => {
  overrideReply = (route, body) => (route === 'wallet-assets' ? (body.cursor === undefined ? pageWithMore() : pageTwo()) : null);
  const asked = [];
  try {
    const { context, page, errors } = await visit(`/portfolio/${OWNER}`, async (ctx) => {
      await provider(asked, twoPagePrices)(ctx);
      await watchTotals(ctx);
      // Fake timers that tick on their own, so five minutes can pass at once.
      await ctx.clock.install();
    });
    try {
      const list = page.locator('[data-portfolio-tokens]');
      await page.locator('[data-portfolio-tokens][data-wallet-prices="ok"] [data-wallet-total]').waitFor({ timeout: 30_000 });
      await list.getByRole('button', { name: 'Show all 4' }).click();
      const before = walletBodies().length;
      await page.evaluate(() => window.__mark());
      await page.clock.fastForward('05:01');
      for (let i = 0; i < 120 && walletBodies().length < before + 2; i++) await page.waitForTimeout(250);
      assert.equal(walletBodies().length, before + 2, 'read again, both pages');
      await page.locator('[data-portfolio-tokens][data-wallet-source="read"]').waitFor({ timeout: 30_000 });
      assert.equal(await page.evaluate(() => window.__placeholders), 0, 'no placeholder where the total stood');
      assert.equal(await list.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded'), 'true', 'Show all is still open');
      assert.deepEqual(await rowsOf(list), [MANY, NATIVE, SELECTED_TOKENS[1], UFG]);
      assert.equal(await page.evaluate(() => window.__emptied), 0, 'never shrank to nothing');
      assert.equal(await page.evaluate(() => window.__totalGone), 0, 'the total stayed on screen through the re-read');
      assert.equal(await list.locator('[data-wallet-total] .dm-fig-xl').textContent(), '$2,028.50');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    overrideReply = null;
  }
});

// Round 6 (2026-09-27; the owner: the Wallet card's tokens took far too long to appear). A first visit waits for the
// whole list and its prices FIRST_PAINT_MS (5 s) at most: a page that takes longer leaves the pages already read on
// screen, by value, under the total's placeholder, and the whole list follows in place, with its total. Nothing is
// ever emptied, and no total is ever shown over part of the list.
test('a slow list on a first visit: the pages already read are drawn within five seconds, then the whole list and its total, never emptied', { timeout: 60_000 }, async () => {
  overrideReply = async (route, body) => {
    if (route !== 'wallet-assets') return null;
    if (body.cursor === undefined) return pageWithMore();
    await sleep(8000);
    return pageTwo();
  };
  const asked = [];
  try {
    // Changed on purpose 2026-09-28 (speed wave, item 1): page 2 leaves at once, no longer 1.1 s after page 1, so the
    // first load is waited for until `load`: no half-second of quiet comes before page 2's eight seconds.
    const { context, page, errors } = await visit(`/portfolio/${OWNER}`, async (ctx) => {
      await provider(asked, twoPagePrices)(ctx);
      await watchTotals(ctx);
    }, { until: 'load' });
    try {
      const list = page.locator('[data-portfolio-tokens]');
      await list.locator('[data-wallet-row]').first().waitFor({ timeout: 7_000 });
      assert.equal(await list.getAttribute('data-wallet-pages'), '1', 'drawn while page 2 is still on the wire');
      assert.deepEqual(await rowsOf(list), [NATIVE, SELECTED_TOKENS[1], UFG], 'page 1’s holdings, by value');
      assert.equal(await list.locator('[data-wallet-total]').count(), 0, 'no total over part of the list');
      assert.equal(await list.locator('.dm-acct-total-skel').count(), 1, 'the total’s place is held');
      await page.locator('[data-portfolio-tokens] [data-wallet-total]').waitFor({ timeout: 30_000 });
      assert.deepEqual(await rowsOf(list), [MANY, NATIVE, SELECTED_TOKENS[1]], 'the whole list, in its final order');
      assert.equal(await list.locator('[data-wallet-total] .dm-fig-xl').textContent(), '$2,028.50');
      assert.equal(await list.locator('.dm-acct-total-skel').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.__totals), [[MANY, NATIVE, SELECTED_TOKENS[1]].join(',')], 'a total only over the whole list');
      assert.equal(await page.evaluate(() => window.__emptied), 0, 'never shrank to nothing');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    overrideReply = null;
  }
});

// Round 6: a list that is not whole (its page skipped candidates) has no total. Read again every five minutes, it
// brings up no placeholder where a total would be, and its rows stay as they are.
test('a list with no total is read again quietly: no placeholder comes up and its rows stay as they are', async () => {
  const USDG = SELECTED_TOKENS[1];
  overrideReply = (route, body) => {
    if (route !== 'wallet-assets') return null;
    if (body.autoDiscover === false) return walletPage(({ native, token }) => [native, { ...token, address: USDG, symbol: 'USDG', decimals: 6, amountRaw: '5500000' }]);
    return walletPage(({ native, token }) => [
      { ...native, amountRaw: '10000000000000000' },
      { ...token, address: UFG, symbol: 'UFG', decimals: 18, amountRaw: '1000000000000000000000000' },
    ], { candidatesProbed: 13, candidatesSkipped: 7, skippedReason: 'request_budget_exhausted' });
  };
  const asked = [];
  try {
    const { context, page, errors } = await visit(`/portfolio/${OWNER}`, async (ctx) => {
      await provider(asked, twoPagePrices)(ctx);
      await watchTotals(ctx);
      await ctx.clock.install();
    });
    try {
      const list = page.locator('[data-portfolio-tokens]');
      await page.locator('[data-portfolio-tokens][data-wallet-prices="ok"][data-wallet-total-withheld="skipped_candidates"]').waitFor({ timeout: 30_000 });
      assert.deepEqual(await rowsOf(list), [UFG, NATIVE, USDG]);
      await page.evaluate(() => window.__mark());
      const before = walletBodies().length;
      await page.clock.fastForward('05:01');
      for (let i = 0; i < 120 && walletBodies().length < before + 2; i++) await page.waitForTimeout(250);
      assert.equal(walletBodies().length, before + 2, 'read again: the page, then its check by address');
      await page.locator('[data-portfolio-tokens][data-wallet-source="read"]').waitFor({ timeout: 30_000 });
      assert.equal(await page.evaluate(() => window.__placeholders), 0, 'no placeholder for a total the list never had');
      assert.equal(await list.locator('[data-wallet-total]').count(), 0);
      assert.deepEqual([...new Set(await page.evaluate(() => window.__shown.filter((rows) => rows !== '')))], [[UFG, NATIVE, USDG].join(',')], 'the same rows all along');
      assert.equal(await page.evaluate(() => window.__emptied), 0);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    overrideReply = null;
  }
});

// Review of round 6 (2026-09-28): every quiet re-read took the form for other tokens off the page and put it back, so
// the open form closed and what was typed in it was lost, every five minutes. The form now stays, the same element.
test('the form for other tokens stays open, with what was typed in it, through the quiet re-reads', { timeout: 90_000 }, async () => {
  const USDG = SELECTED_TOKENS[1];
  overrideReply = async (route, body) => {
    if (route !== 'wallet-assets') return null;
    await sleep(1500);
    if (body.tokens === undefined) return walletPage(({ native }) => [native], { rowsReceived: 0, candidatesProbed: 0 });
    return walletPage(({ native, token }) => [native, ...body.tokens.map((address) => ({ ...token, address, amountRaw: address === USDG ? '1500000' : '0' }))], { rowsReceived: 0, candidatesProbed: 0 });
  };
  try {
    const { context, page, errors } = await visit(`/portfolio/${OWNER}`, async (ctx) => {
      await provider([], () => [])(ctx);
      await ctx.clock.install();
    });
    try {
      const list = page.locator('[data-portfolio-tokens]');
      await list.locator(`[data-wallet-row="${USDG}"]`).waitFor({ timeout: 30_000 });
      await page.locator('[data-portfolio-tokens][data-wallet-source="read"]').waitFor({ timeout: 30_000 });
      await list.locator('details.dm-acct-tokens-more > summary').click();
      await list.locator('#portfolio-tokens').fill('0x1234');
      // The very element typed into is marked: a form taken off the page and put back would be a new one.
      await page.evaluate(() => { document.querySelector('#portfolio-tokens').dataset.typedHere = 'yes'; });
      for (const round of [1, 2]) {
        const before = walletBodies().length;
        await page.clock.fastForward('05:01');
        for (let i = 0; i < 120 && walletBodies().length < before + 1; i++) await page.waitForTimeout(250);
        assert.equal(walletBodies().length, before + 1, `read again (${round}): the selected pools' tokens, by address`);
        await page.locator('[data-portfolio-tokens][data-wallet-source="memory"]').waitFor({ timeout: 10_000 }).catch(() => {});
        await page.locator('[data-portfolio-tokens][data-wallet-source="read"]').waitFor({ timeout: 30_000 });
        assert.equal(await list.locator('details.dm-acct-tokens-more').evaluate((details) => details.open), true, `still open after re-read ${round}`);
        assert.equal(await list.locator('#portfolio-tokens').inputValue(), '0x1234', `what was typed is still there after re-read ${round}`);
        assert.equal(await list.locator('#portfolio-tokens').getAttribute('data-typed-here'), 'yes', 'the same element all along');
      }
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    overrideReply = null;
  }
});

const AIRDROP = '0x6666666666666666666666666666666666666666';
const NEWDROP = '0x7777777777777777777777777777777777777777';
const NEWER = '0x8888888888888888888888888888888888888888';
/** The first page (0.01 ETH, 5.5 USDG, 1,000 UFG) with 1,000 of each extra [address, symbol] after them. */
const pageOneWith = (extras) => walletPage(({ native, token }) => [
  { ...native, amountRaw: '10000000000000000' },
  { ...token, address: SELECTED_TOKENS[1], symbol: 'USDG', decimals: 6, amountRaw: '5500000' },
  { ...token, address: UFG, symbol: 'UFG', decimals: 18, amountRaw: '1000000000000000000000' },
  ...extras.map(([address, symbol]) => ({ ...token, address, symbol, decimals: 18, amountRaw: '1000000000000000000000' })),
], { hasMore: true, nextCursor: HANDLE });

// Review of round 6 (2026-09-28): the memory kept prices with no time of their own, and each list read wrote them back
// under the list's new time. With the provider down, the card showed a total at prices days or weeks old, as current.
// A price now counts for an hour after its answer: past that, the remembered list is drawn with no total, its rows in
// their last known order by value (an airdrop with no price never takes a top-3 place), and writing the list back
// keeps each price's own time.
test('a remembered list whose prices are more than an hour old: no total at old prices, the rows in their last order, each price keeping its time', { timeout: 60_000 }, async () => {
  let pricesDown = false;
  overrideReply = (route, body) => (route === 'wallet-assets' ? (body.cursor === undefined ? pageOneWith([[AIRDROP, 'AAA']]) : pageTwo()) : null);
  const asked = [];
  try {
    const { context, page, errors } = await visit(`/portfolio/${OWNER}`, async (ctx) => {
      await provider(asked, (url) => (pricesDown ? null : twoPagePrices(url)))(ctx);
      await watchTotals(ctx);
    });
    try {
      const list = page.locator('[data-portfolio-tokens]');
      await page.locator('[data-portfolio-tokens][data-wallet-prices="ok"] [data-wallet-total]').waitFor({ timeout: 30_000 });
      assert.equal(await list.locator('[data-wallet-total] .dm-fig-xl').textContent(), '$2,028.50');
      assert.deepEqual(await rowsOf(list), [MANY, NATIVE, SELECTED_TOKENS[1]]);
      const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('domino-wallet-v2:4663')));
      // Two hours pass (the kept list and every kept price made two hours older), and the provider is down.
      const TWO_HOURS = 2 * 3600_000;
      await page.evaluate((shift) => {
        const all = JSON.parse(localStorage.getItem('domino-wallet-v2:4663'));
        for (const wallet of Object.values(all.wallets)) {
          wallet.at -= shift;
          for (const price of wallet.quotes) price[3] -= shift;
        }
        localStorage.setItem('domino-wallet-v2:4663', JSON.stringify(all));
      }, TWO_HOURS);
      const aged = (await stored()).wallets[OWNER.toLowerCase()].quotes.map((price) => [price[0], price[3]]);
      assert.equal(aged.length, 4, 'WETH, UFG, MANY and the airdrop (answered: no price)');
      pricesDown = true;
      await page.reload();
      await list.locator('[data-wallet-row]').first().waitFor({ timeout: 5_000 });
      assert.deepEqual(await rowsOf(list), [MANY, NATIVE, SELECTED_TOKENS[1]], 'drawn from memory at once, in the last known order by value');
      await page.locator('[data-portfolio-tokens][data-wallet-prices="failed"][data-wallet-source="read"]').waitFor({ timeout: 30_000 });
      assert.equal(await list.locator('[data-wallet-total]').count(), 0, 'no total at prices two hours old');
      assert.equal(await list.getAttribute('data-wallet-total-withheld'), 'unanswered_prices');
      assert.deepEqual(await page.evaluate(() => window.__totals), [], 'no total was ever shown on this visit');
      assert.deepEqual(await rowsOf(list), [MANY, NATIVE, SELECTED_TOKENS[1]], 'still in that order: the airdrop AAA takes no top-3 place');
      assert.deepEqual(await list.locator('[data-usd]').allTextContents(), ['$5.50'], 'USDG alone has a value ($1 needs no provider)');
      assert.equal(await list.locator('[data-no-price]').count(), 2, 'the others a quiet dash');
      await list.getByRole('button', { name: 'Show all 5' }).click();
      assert.deepEqual(await rowsOf(list), [MANY, NATIVE, SELECTED_TOKENS[1], UFG, AIRDROP]);
      assert.equal(await page.evaluate(() => window.__emptied), 0, 'never shrank to nothing');
      const after = (await stored()).wallets[OWNER.toLowerCase()];
      assert.deepEqual(after.quotes.map((price) => [price[0], price[3]]), aged, 'the list was written back; every price kept its own time');
      assert.ok(after.at > Date.now() - 60_000, 'the list itself is the new read');
      // Another visit: still no total.
      await page.reload();
      await page.locator('[data-portfolio-tokens][data-wallet-prices="failed"][data-wallet-source="read"]').waitFor({ timeout: 30_000 });
      assert.equal(await list.locator('[data-wallet-total]').count(), 0);
      assert.deepEqual(await page.evaluate(() => window.__totals), []);
      // The provider back: the prices are answered again, and the total with them.
      pricesDown = false;
      await page.reload();
      await page.locator('[data-portfolio-tokens][data-wallet-prices="ok"] [data-wallet-total]').waitFor({ timeout: 30_000 });
      assert.equal(await list.locator('[data-wallet-total] .dm-fig-xl').textContent(), '$2,028.50');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    overrideReply = null;
  }
});

// Review of round 6 (2026-09-28): a read that named a token the wallet did not hold before took the total away until
// that token's price came back, with nothing in its place: the card shrank and grew again. The total on screen now
// stays while the new token's price is asked, on a quiet re-read and on a later visit drawn from memory alike.
/** Answers the provider's price GETs for the two pages, NEWDROP ($0.01) and NEWER ($0.001), each `delay()` ms late. */
const delayedPrices = (asked, delay) => async (context) => {
  await context.route(/^https:\/\/(api|cdn)\.dexscreener\.com\//, async (route) => {
    const url = route.request().url();
    asked.push(url);
    const prices = url.includes('/tokens/v1/');
    if (prices && delay() > 0) await sleep(delay());
    const reply = prices ? [...twoPagePrices(url), providerPair(NEWDROP, '0.01', 1e6), providerPair(NEWER, '0.001', 1e6)] : [];
    return route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(reply) });
  });
};
/** Waits until the card's total reads `text`, a few seconds at most, and says what it read last. */
const totalBecomes = async (page, text) => {
  const read = () => page.locator('[data-portfolio-tokens] [data-wallet-total] .dm-fig-xl').textContent({ timeout: 1000 }).catch(() => null);
  for (let i = 0; i < 60 && (await read()) !== text; i++) await page.waitForTimeout(250);
  return read();
};

test('a new token on a quiet re-read leaves the total on screen while its price is asked', { timeout: 60_000 }, async () => {
  let extras = [];
  let delay = 0;
  overrideReply = (route, body) => (route === 'wallet-assets' ? (body.cursor === undefined ? pageOneWith(extras) : pageTwo()) : null);
  const asked = [];
  try {
    const { context, page, errors } = await visit(`/portfolio/${OWNER}`, async (ctx) => {
      await delayedPrices(asked, () => delay)(ctx);
      await watchTotals(ctx);
      await ctx.clock.install();
    });
    try {
      await page.locator('[data-portfolio-tokens][data-wallet-prices="ok"] [data-wallet-total]').waitFor({ timeout: 30_000 });
      assert.equal(await totalBecomes(page, '$2,028.50'), '$2,028.50');
      await page.evaluate(() => window.__mark());
      // The re-read's first page names NEWDROP (1,000 at $0.01), its price answered 800 ms after it is asked.
      extras = [[NEWDROP, 'NEWDROP']];
      delay = 800;
      const before = walletBodies().length;
      const pricesBefore = asked.filter((url) => url.includes('/tokens/v1/')).length;
      await page.clock.fastForward('05:01');
      for (let i = 0; i < 120 && walletBodies().length < before + 2; i++) await page.waitForTimeout(250);
      assert.equal(walletBodies().length, before + 2, 'read again, both pages');
      assert.equal(await totalBecomes(page, '$2,038.50'), '$2,038.50', 'NEWDROP counted once its price came');
      assert.ok(asked.filter((url) => url.includes('/tokens/v1/')).slice(pricesBefore).some((url) => url.includes(NEWDROP)), 'its price was asked');
      assert.equal(await page.evaluate(() => window.__totalGone), 0, 'the total never left the screen');
      assert.equal(await page.evaluate(() => window.__placeholders), 0, 'and no placeholder came up in its place');
      assert.equal(await page.evaluate(() => window.__emptied), 0);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    overrideReply = null;
  }
});

test('a later visit drawn from memory whose first page names a new token keeps its total on screen while that price is asked', { timeout: 60_000 }, async () => {
  let extras = [[NEWDROP, 'NEWDROP']];
  let delay = 0;
  overrideReply = (route, body) => (route === 'wallet-assets' ? (body.cursor === undefined ? pageOneWith(extras) : pageTwo()) : null);
  const asked = [];
  try {
    const { context, page, errors } = await visit(`/portfolio/${OWNER}`, async (ctx) => {
      await delayedPrices(asked, () => delay)(ctx);
      await watchTotals(ctx);
    });
    try {
      const list = page.locator('[data-portfolio-tokens]');
      await page.locator('[data-portfolio-tokens][data-wallet-prices="ok"] [data-wallet-total]').waitFor({ timeout: 30_000 });
      assert.equal(await totalBecomes(page, '$2,038.50'), '$2,038.50');
      // The next visit: its first page names NEWER (1,000 at $0.001), every price answered 800 ms after it is asked.
      extras = [[NEWDROP, 'NEWDROP'], [NEWER, 'NEWER']];
      delay = 800;
      await page.reload();
      await list.locator('[data-wallet-total]').waitFor({ timeout: 5_000 });
      assert.equal(await list.locator('[data-wallet-total] .dm-fig-xl').textContent(), '$2,038.50', 'the remembered total, at once');
      assert.equal(await totalBecomes(page, '$2,039.50'), '$2,039.50', 'NEWER counted once its price came');
      await page.locator('[data-portfolio-tokens][data-wallet-prices="ok"][data-wallet-source="read"]').waitFor({ timeout: 30_000 });
      assert.equal(await page.evaluate(() => window.__totalGone), 0, 'the total never left the screen');
      assert.equal(await page.evaluate(() => window.__placeholders), 0, 'and no placeholder came up in its place');
      assert.equal(await page.evaluate(() => window.__emptied), 0);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    overrideReply = null;
  }
});

// The public-wallet selector's app entrance is New position's first step (DESIGN.md E.4): "More ways to find a
// token", then the token picker's public listing. B4 does not depend on a lab-only modal.
// Removed with the surface they drove. Both tests reached the public wallet
// listing through New position's "More ways to find a token" disclosure, which
// the owner's review of 2026-09-19 deleted: step 1 is now one search field.
//
// What still covers their subject:
//   - the handle goes back exactly and never leaves the pager
//     -> tests/screens.test.mjs, "the wallet handle goes back exactly as received"
//   - the handle never reaches the page, a URL, a Referer or storage
//     -> tests/read-screens.browser.test.mjs, "a public address lists tokens as a
//        public lookup; Load more sends the handle back exactly"
//   - Load more waiting behind an in-flight check
//     -> src/components/portfolio/PortfolioTokens.tsx carries that behaviour now
//
// What is not covered any more, and should be restored against
// `#/portfolio/<address>`: these two assertions through the real Worker bridge
// in a browser — that the POST body reaching the bridge is byte for byte the
// handle the stub sent, and that the bridge hands the gateway those same bytes.
// The portfolio sends a different request shape (it carries `tokens`), so the
// rewrite is not a selector swap and was not folded into this change.