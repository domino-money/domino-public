/**
 * The read screens in the bridge-test build: the real beta gate in front of
 * the unmodified bridge Worker (bridge/src/worker.mjs), with its gateway
 * replaced by package fixtures, as read-bridge.browser.test.mjs sets it up.
 *
 * What only this topology can show: the position lookup sends exactly the
 * typed IDs as a same-origin POST, the capabilities are asked once, reads
 * from the lookup and the landing are spaced the way the bridge admits them,
 * a refresh without the beta cookie is the gate's state (never a wallet
 * sign-in) and keeps the cards, pool activity is read by the figures dialog
 * only when it opens and by the pool page where the route is listed, and the
 * wallet listing's continuation handle travels only in POST bodies (B4).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
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
  await Promise.all([serverClosed, browser?.close()]);
});

async function visit(route) {
  edge = [];
  upstream = [];
  walletReplies = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(`uncaught: ${error.message}`));
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  await page.fill('#password', PASSWORD);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('button[type="submit"]')]);
  if (route !== '/') {
    // A fresh document on the route: the landing's own reads from signing in must not be counted here.
    await page.goto(`${origin}/#${route}`, { waitUntil: 'networkidle' });
    edge = [];
    upstream = [];
    await page.reload({ waitUntil: 'networkidle' });
  }
  return { context, page, errors };
}

/** The lookup settled: its live region (drawn nowhere) names a state other than loading, and nothing in the section is busy. */
async function settled(page) {
  await page.waitForFunction(
    () => {
      const status = document.querySelector('#chain-lookup [data-lookup-status]')?.getAttribute('data-lookup-status');
      return status && status !== 'loading' && !document.querySelector('#chain-lookup [aria-disabled="true"]');
    },
    null,
    { timeout: 30_000 },
  );
  return page.locator('#chain-lookup [data-lookup-status]').getAttribute('data-lookup-status');
}

/** What the eye gets of an element: its text without the screen-reader-only parts. */
const visibleText = (locator) =>
  locator.evaluate((root) => {
    const copy = root.cloneNode(true);
    for (const hidden of copy.querySelectorAll('.sr-only')) hidden.remove();
    return copy.textContent.replace(/\s+/g, ' ').trim();
  });

async function lookUp(page) {
  const show = page.getByRole('button', { name: 'Show lookup' });
  if (await show.count()) await show.click();
  await page.fill('#nft-ids', `1 ${BIG}`);
  await page.getByRole('button', { name: 'Look up positions' }).click();
}

const posts = () => edge.filter((r) => r.method === 'POST');

test('the lookup posts exactly the typed IDs, asks capabilities once, and spaces its reads the way the bridge admits them', async () => {
  const { context, page, errors } = await visit('/app');
  await page.locator('#chain-lookup').waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual(edge, [], 'the Dashboard reads nothing until asked');
  await lookUp(page);
  assert.equal(await settled(page), 'ok');
  assert.equal(await page.locator('[data-chain-card]').count(), 2);
  // No build pill and no source pill (changed on purpose, review of 2026-09-14): each row's snapshot is its title and data attributes.
  const first = page.locator('[data-chain-card]').first();
  await first.locator('summary').click();
  assert.doesNotMatch(await first.innerText(), /Read from chain|Public data|Snapshot:/);
  assert.equal(await first.getAttribute('data-snapshot'), '700');
  assert.match(await first.locator('summary').getAttribute('title'), /^Block 700 · /);

  assert.deepEqual(edge.map((r) => `${r.method} ${r.path}`), [
    'GET /api/read/v1/capabilities',
    'POST /api/read/v1/nft-positions',
    'POST /api/read/v1/token',
    'POST /api/read/v1/token',
  ]);
  assert.equal(posts()[0].body, JSON.stringify({ tokenIds: ['1', BIG] }), 'exactly the typed IDs, no pinned block');
  for (const r of edge) {
    assert.equal(r.headers['sec-fetch-site'], 'same-origin');
    assert.equal(r.headers['x-domino-read-contract'], RC3);
    for (const forbidden of ['authorization', 'x-domino-csrf', 'x-domino-session']) assert.equal(r.headers[forbidden], undefined, forbidden);
  }
  const starts = posts().map((r) => r.at);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 1050, `POST starts ${starts[i] - starts[i - 1]} ms apart`);
  // Recorded for the open question on whether the capabilities GET counts against the bridge's start rate.
  console.log(`capabilities GET to first POST: ${posts()[0].at - edge[0].at} ms`);

  // The same ids again read them again, through the one capabilities answer: there is no Refresh.
  assert.equal(await page.locator('#chain-lookup').getByRole('button', { name: 'Refresh' }).count(), 0);
  const refreshed = edge.length;
  await page.getByRole('button', { name: 'Look up positions' }).click();
  for (const started = Date.now(); edge.length <= refreshed && Date.now() - started < 30_000; ) await page.waitForTimeout(50);
  await settled(page);
  assert.equal(edge.filter((r) => r.method === 'GET').length, 1, 'capabilities are asked once per page load');
  assert.ok(edge.length > refreshed);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a lookup without the beta cookie is the gate state: cards stay, the words only in a title, no link, no wallet', async () => {
  const { context, page } = await visit('/app');
  await page.locator('#chain-lookup').waitFor();
  await lookUp(page);
  assert.equal(await settled(page), 'ok');
  await context.clearCookies();
  await page.getByRole('button', { name: 'Look up positions' }).click();
  assert.equal(await settled(page), 'gate_required');
  const title = await page.locator('#chain-lookup [data-chain-cards]').getAttribute('title');
  assert.match(title, /^Site access expired\. Reload the page to sign in again\. The cards below are from the last read that worked/);
  assert.doesNotMatch(title, /wallet|connect|beta/i);
  assert.equal(await page.locator('#chain-lookup').getAttribute('data-lookup-reason'), 'gate_required');
  assert.doesNotMatch(await visibleText(page.locator('#chain-lookup')), /access expired/i, 'nothing about the gate is printed');
  assert.equal(await page.locator('#chain-lookup a').count(), 0);
  assert.equal(await page.locator('[data-chain-card]').count(), 2, 'the last cards that worked stay');
  await context.close();
});

test('position reads switched off on the server: an empty state that says why only in its title, and not one position is posted', async () => {
  const emptyTitle = (page) => page.locator('#chain-lookup [data-empty="positions-failed"]').locator('xpath=..').getAttribute('title');
  BRIDGE.ENABLED_READS = 'token,pools,pool-market,pool-metrics';
  try {
    const { context, page } = await visit('/app');
    await page.locator('#chain-lookup').waitFor();
    await lookUp(page);
    assert.equal(await settled(page), 'disabled');
    assert.match(await emptyTitle(page), /Position reads aren’t enabled on this server\./);
    assert.equal(await page.locator('#chain-lookup [data-empty="positions-failed"]').innerText(), 'No positions to show');
    assert.deepEqual(posts(), []);
    await context.close();
  } finally {
    BRIDGE.ENABLED_READS = ALL_READS;
  }
  BRIDGE.READ_BRIDGE_ENABLED = 'false';
  try {
    const { context, page } = await visit('/app');
    await page.locator('#chain-lookup').waitFor();
    await lookUp(page);
    assert.equal(await settled(page), 'disabled');
    assert.match(await emptyTitle(page), /This server has live reads turned off\./);
    assert.deepEqual(posts(), []);
    await context.close();
  } finally {
    BRIDGE.READ_BRIDGE_ENABLED = 'true';
  }
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
/** The fixture pool's card on the Markets rail has settled its hourly read: bars, or a line saying why there are none. */
const cardSettled = (page) => page.waitForFunction(() => document.querySelector('[data-market-card] [data-volume-bar], [data-market-card] [data-chart-unavailable]'), null, { timeout: 30_000 });
/**
 * The route's own reading on mount: the read capabilities, which list pool-metrics here, then the estimate
 * namespace's; the fixture pool's market and its two tokens, then its pool-metrics; then the rail card's one hourly
 * read for that pool (with price history), queued behind the table's reads.
 */
const MOUNT = ['GET /api/read/v1/capabilities', 'GET /api/read/v2/capabilities', 'POST /api/read/v1/pool-market', 'POST /api/read/v1/token', 'POST /api/read/v1/token', 'POST /api/read/v1/pool-metrics', 'POST /api/read/v1/pool-market'];
/** The rail card's hourly read: the last POST of the mount. */
const CARD_READ = MOUNT.filter((line) => line.startsWith('POST')).length - 1;
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
  assert.deepEqual(edge.filter((r) => r.method === 'GET').map((r) => r.path), ['/api/read/v1/capabilities', '/api/read/v2/capabilities'], 'the read capabilities first, then the optional estimate probe, which falls back before any V2 data POST');
  assert.equal(await page.locator('#pools [data-apr-estimate]').getAttribute('data-apr-estimate'), 'unavailable');
  for (const r of upstream) assert.doesNotMatch(JSON.stringify(r.body), /0{62}a[2-5]/, 'a placeholder pool id was requested');
  assert.equal(routes().includes('pool-activity'), false);
  await page.locator('#pools [data-pool-figures]').click();
  await page.locator('[data-pool-figures-dialog]').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-figures-activity]')?.getAttribute('data-figures-activity') !== 'loading', null, { timeout: 30_000 });
  assert.equal(routes().filter((r) => r === 'pool-activity').length, 1);
  assert.match(await page.locator('[data-pool-figures-dialog]').innerText(), /Pool is 19 s old/);
  const starts = posts().map((r) => r.at);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 1050, 'the dialog read queued behind the table reads, spaced');
  assert.deepEqual(errors, []);
  await context.close();
});

test('Markets reads the searched token, then its pools and the catalogue only on demand, through the public bridge; a pool page opens only from a verified read', async () => {
  const { context, page, errors } = await visit('/pools');
  try {
    await page.getByRole('heading', { name: 'Markets', exact: true }).waitFor();
    // The selected pools are on Markets: their lean load, and the rail card's one hourly read for its pool, are the route's only reading on mount.
    await poolsSettled(page);
    await cardSettled(page);
    await page.waitForTimeout(300);
    assert.deepEqual(trail(), MOUNT, 'route mount reads the selected pools, then the card\'s hourly read, and nothing else');
    const cardRead = JSON.parse(posts()[CARD_READ].body);
    assert.deepEqual(cardRead, { poolId: POOL, includePriceHistory: true, priceToken: 'quote' }, 'the card asks for the same candles the pool page would');
    assert.ok(posts()[CARD_READ].at - posts()[CARD_READ - 1].at >= 1050, 'and queues behind the table\'s reads');
    await page.locator('#markets-search').fill(TOKEN);
    const combobox = page.getByRole('combobox', { name: 'Token name or address' });
    await combobox.waitFor();
    assert.equal(await combobox.inputValue(), TOKEN, 'no selected pool matches, so the token search starts from the address');
    await page.waitForTimeout(300);
    assert.deepEqual(trail(), MOUNT, 'typing an address reads nothing: only choosing it asks');
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
    assert.match(poolText, /Found by DexScreener discovery, verified on chain/);
    assert.match(poolText, /verified at block 700/);
    assert.match(poolText, /Pool APR unavailable/);
    assert.doesNotMatch(poolText, /APR\s*0(?:\.0+)?%/);
    assert.equal(await pool.locator('input').count(), 0, 'on Explore a pool row is a way in, not a choice');
    assert.equal(posts().some((r) => r.path.endsWith('/catalogue')), false, 'catalogue is not loaded with discovery');
    // No caption about where the pools or the catalogue come from: the rows and the candidates say it themselves.
    assert.doesNotMatch(await page.locator('[data-found-pools]').innerText(), /figures reported by DexScreener|neutral order/);
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
    assert.match(await workspace.innerText(), /Verified at block 700/);
    await page.waitForFunction(() => document.querySelectorAll('[data-pool-figures] [data-metric]').length > 0, null, { timeout: 30_000 });
    // The range planner is always on the pool page, not behind a tab.
    const range = page.locator('[data-picker="range"]');
    await range.waitFor();
    assert.equal(await range.getAttribute('data-price-state'), 'usable');
    assert.deepEqual(await range.locator('input[type="range"]').evaluateAll((els) => els.map((el) => el.id)), ['range-lower', 'range-upper']);
    assert.equal(await page.locator('main').getByRole('link', { name: 'New position' }).getAttribute('href'), `#/new/${POOL}`);
    // Every optional route this Worker lists is read by the page itself, one after another: its history, its activity, its positions.
    await page.locator('[data-pool-positions]:not([data-pool-positions="loading"])').waitFor({ timeout: 30_000 });
    const forbidden = /sign|approve|connect|deposit|swap|quote|mint|confirm|execute|buy|sell/i;
    for (const name of await page.locator('main button').allInnerTexts()) assert.doesNotMatch(name, forbidden, name);
    await page.waitForTimeout(1200);

    // The token search reads the chosen address once and hands its answer to the token's view, which does not read it again (#138 §5).
    assert.deepEqual(trail().slice(MOUNT.length), [
      'POST /api/read/v1/token',
      'POST /api/read/v1/pools',
      'POST /api/read/v1/catalogue',
      'POST /api/read/v1/pools',
      'POST /api/read/v1/pool-market',
      'POST /api/read/v1/pool-metrics',
      'POST /api/read/v1/pool-activity',
      'POST /api/read/v1/pool-positions',
    ], 'only the public reads the page lists: no market polling, session or financial call');
    assert.deepEqual(posts().slice(CARD_READ + 1).map((r) => JSON.parse(r.body)), [
      { token: TOKEN }, // the search's token read, handed to the view
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
    const starts = posts().map((r) => r.at);
    for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 1050, `POST starts ${starts[i] - starts[i - 1]} ms apart`);

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
    assert.deepEqual(posts().slice(before).map((r) => JSON.parse(r.body)), [{ token: native }], 'the search’s one token read, handed to the view, and no pools read on its own');
    await page.goto(`${origin}/#/settings`);
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
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
      assert.deepEqual(trail(), [
        'GET /api/read/v1/capabilities',
        'POST /api/read/v1/markets-snapshot',
        'POST /api/read/v1/token',
        'POST /api/read/v1/token',
        'POST /api/read/v1/pool-metrics',
        'POST /api/read/v1/pool-market',
      ], 'a fresh stored entry needs no market read of its own: the only pool-market is the card’s hourly read, which is read-v1’s');
      assert.deepEqual(JSON.parse(posts()[0].body), { poolIds: [POOL] });
      assert.deepEqual(JSON.parse(posts().at(-1).body), { poolId: POOL, includePriceHistory: true, priceToken: 'quote' });
      assert.equal(await page.locator('[data-selected-pools] tbody tr[data-row-source="markets-snapshot"]').count(), 1);
      const starts = posts().map((r) => r.at);
      for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 1050, `POST starts ${starts[i] - starts[i - 1]} ms apart`);
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
    const card = page.locator('[data-pool-activity]');
    await page.locator('[data-pool-activity="unavailable"]').waitFor({ timeout: 30_000 });
    assert.equal(await card.getAttribute('data-activity-reason'), 'activity_stale');
    const why = 'Stale: indexed 56 days behind the chain head, at block 700, too far behind to show as the last 24 hours.';
    assert.equal(await card.getAttribute('title'), why);
    assert.equal(await card.locator('[role="status"]').textContent(), why, 'a screen reader hears why');
    const shown = await visibleText(card);
    assert.equal(shown.replace(/[^—]/g, '').length, 10, `every figure is a dash: ${shown}`);
    assert.doesNotMatch(shown, /Older than 24 h|24 h covered|observed|10 to 700|stale|behind|indexed chain events/i, 'no window, pool age, blocks or reason on the card');
    assert.equal(await card.locator('h2').getAttribute('title'), 'Swaps and fees over the 24 hours up to the last indexed block, from indexed chain events.');
    assert.equal(posts().filter((r) => r.path.endsWith('/pool-activity')).length, 1, 'one read, not asked again');
    assert.deepEqual(errors, []);
  } finally {
    overrideReply = null;
    await context.close();
  }
});

// The selected pools' tokens, by address, in catalogueTokens() order (src/config/selectedPoolCatalogue.ts).
const SELECTED_TOKENS = [
  '0x0bd7d308f8e1639fab988df18a8011f41eacad73', // WETH
  '0x5fc5360d0400a0fd4f2af552add042d716f1d168', // USDG
  '0xab35d04e1ee39c789c4a65d522417b3c7f2e4723', // MARLIN
  '0xcec185eb182c47d1ba1efc84e6959e18cd620be4', // cbBTC
  '0xce24439f2d9c6a2289f741120fe202248b666666', // U
  '0x39dbed3a2bd333467115de45665cc57f813c4571', // PONS
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
      assert.ok(walletPosts[1].at - walletPosts[0].at >= 1050, 'the check shares the public read pacing');

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
        { wallet: OWNER, tokens: SELECTED_TOKENS, autoDiscover: true },
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

test('Load more pressed while a partial list’s check is on the wire waits for it: one check for one list, and its balance stays', async () => {
  const USDG = SELECTED_TOKENS[1];
  overrideReply = async (route, body) => {
    if (route !== 'wallet-assets') return null;
    if (body.autoDiscover === false) {
      // The by-address check takes a while on the wire.
      await sleep(2500);
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
  try {
    const { context, page, errors } = await visit(`/portfolio/${OWNER}`);
    try {
      const list = page.locator('[data-portfolio-tokens]');
      await page.locator('[data-portfolio-tokens][data-wallet-pages="1"]').waitFor({ timeout: 30_000 });
      for (const started = Date.now(); !walletBodies().some((b) => b.autoDiscover === false) && Date.now() - started < 30_000; ) await page.waitForTimeout(50);
      assert.equal(walletBodies().filter((b) => b.autoDiscover === false).length, 1, 'the check is on the wire');
      await list.getByRole('button', { name: 'Load more' }).click();
      await page.locator('[data-portfolio-tokens][data-wallet-pages="2"]').waitFor({ timeout: 30_000 });
      await list.locator(`[data-wallet-row="${USDG}"][data-wallet-row-via="address"]`).waitFor({ timeout: 30_000 });
      await page.waitForTimeout(2000);
      assert.deepEqual(walletBodies(), [
        { wallet: OWNER, autoDiscover: true },
        { wallet: OWNER, tokens: SELECTED_TOKENS, autoDiscover: false },
        { wallet: OWNER, autoDiscover: true, cursor: HANDLE },
      ], 'Load more waited behind the check instead of cancelling it and asking for it again after page 2');
      assert.equal(await list.getByRole('button', { name: /Load more|All pages loaded/ }).count(), 0, 'the last page leaves nothing to press, and says nothing about being complete');
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
test('B4: the wallet handle goes back to the bridge byte for byte in the POST body, and never into a URL, a Referer, storage or the page', async () => {
  const { context, page, errors } = await visit('/new');
  // A fresh document with the watcher in place before any app code runs; the reads so far don't count.
  await page.addInitScript(watchForHandle, HANDLE.slice(0, 16));
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'New position', exact: true }).waitFor();
  edge = [];
  upstream = [];
  walletReplies = [];
  const seen = [];
  page.on('request', (request) => seen.push({ url: request.url(), referer: request.headers().referer ?? '' }));
  const moreWays = page.locator('summary', { hasText: 'More ways to find a token' });
  await moreWays.click();
  const ways = page.locator('details').filter({ has: moreWays });
  const listing = ways.locator('[data-wallet-candidates]');
  await listing.getByRole('button', { name: 'List tokens from a public address' }).click();
  await page.fill('#wallet-address', OWNER);
  await page.waitForTimeout(300);
  assert.deepEqual(edge, [], 'wallet listing waits for an explicit request, not opening the listing');
  await listing.getByRole('button', { name: 'List tokens', exact: true }).click();
  const wallet = listing;
  await page.waitForFunction(() => document.querySelector('[data-wallet-pages="1"]'), null, { timeout: 30_000 });
  // What the list says about itself is its title, never a footnote (changed on purpose: the review of 2026-09-14 moved data-source captions off product screens).
  const about = wallet.locator('[data-wallet-count]');
  assert.equal(await about.innerText(), '2 tokens listed · page 1 of up to 5');
  assert.match(await about.getAttribute('title'), /^One page of the provider’s inventory\. More are available\. Balances at the snapshot block\. Not proof of wallet control\. Block 700 · Alchemy \(inventory\)\.$/);
  assert.doesNotMatch(await wallet.innerText(), /Balances at the snapshot block|Not proof of wallet control|Block \d/);
  // The handle is live now (the first page's next handle, not yet sent back): look while it exists.
  assert.equal(JSON.parse(walletReplies[0]).inventory.nextCursor, HANDLE);
  assert.deepEqual(await handlePlaces(page, HANDLE.slice(0, 16)), NOWHERE, 'the live handle is in the page');
  await wallet.getByRole('button', { name: 'Load more' }).click();
  await page.waitForFunction(() => document.querySelector('[data-wallet-candidates] [data-wallet-pages="2"]'), null, { timeout: 30_000 });
  // No list is called complete: after the last page there is nothing to press, and no "All pages loaded".
  assert.equal(await wallet.getByRole('button', { name: /Load more|All pages loaded/ }).count(), 0);
  // The listed tokens become candidates by address only, and no link anywhere carries the handle.
  const listed = ways.locator('[data-candidate] [data-address]');
  assert.ok((await listed.count()) > 0, 'the listed tokens are on the page');
  for (const address of await listed.allTextContents()) assert.match(address.trim(), /^0x[0-9a-fA-F]{40}$/, address);
  const linked = await page.locator('a[href]').evaluateAll((els, prefix) => els.map((a) => a.getAttribute('href')).filter((href) => href.includes(prefix)), HANDLE.slice(0, 16));
  assert.deepEqual(linked, [], 'no link carries the handle');

  // What the browser received is the stub's handle, untouched by the bridge.
  assert.equal(walletReplies.length, 2);
  assert.equal(JSON.parse(walletReplies[0]).inventory.nextCursor, HANDLE);
  const walletPosts = posts().filter((r) => r.path === '/api/read/v1/wallet-assets');
  assert.deepEqual(walletPosts.map((r) => r.body), [JSON.stringify({ wallet: OWNER, autoDiscover: true }), JSON.stringify({ wallet: OWNER, autoDiscover: true, cursor: HANDLE })]);
  // ...and the bridge hands the gateway those same bytes.
  const up = upstream.filter((r) => r.route === 'wallet-assets');
  assert.deepEqual(up.map((r) => r.raw), walletPosts.map((r) => r.body));
  assert.equal(up[1].body.cursor, HANDLE);
  // New position reads nothing on mount, so the listing's first request asks the read capabilities, once (a screen
  // read never probes the estimate namespace, as the lookup above shows); the listing itself is two POSTs and nothing else.
  assert.deepEqual(edge.map((r) => `${r.method} ${r.path}`), [
    'GET /api/read/v1/capabilities',
    'POST /api/read/v1/wallet-assets',
    'POST /api/read/v1/wallet-assets',
  ], 'a public wallet listing never starts a login or private operation');
  assert.ok(walletPosts[1].at - walletPosts[0].at >= 1050, 'wallet pages share the public read pacing');

  const inUrlOrReferer = [
    ...edge.map((r) => [`${r.method} ${r.path}`, r.path, r.headers.referer ?? '']),
    ...seen.map((r) => [r.url, r.url, r.referer]),
  ].filter(([, url, referer]) => url.includes(HANDLE) || referer.includes(HANDLE) || url.includes(HANDLE.slice(0, 16)) || referer.includes(HANDLE.slice(0, 16)));
  assert.deepEqual(inUrlOrReferer, [], 'the handle reached a URL or a Referer');
  assert.deepEqual(await handlePlaces(page, HANDLE.slice(0, 16)), NOWHERE, 'the handle is in the page after the last page');
  assert.deepEqual(await handleSightings(page), [], 'the handle was written into the page at some moment');
  assert.deepEqual(errors, []);
  await context.close();
});

test('New position’s public listing: Load more pressed while a partial list’s check is on the wire waits for it, and the check is sent once', async () => {
  const USDG = SELECTED_TOKENS[1];
  overrideReply = async (route, body) => {
    if (route !== 'wallet-assets') return null;
    if (body.autoDiscover === false) {
      await sleep(2500);
      const check = JSON.parse(fixture('wallet-assets.not-requested'));
      check.items[1].address = USDG;
      return { status: 200, text: JSON.stringify(check) };
    }
    if (body.cursor !== undefined) return { status: 200, text: fixture('wallet-assets.last-page') };
    const first = JSON.parse(firstWalletPage());
    first.inventory = { ...first.inventory, candidatesProbed: 13, candidatesSkipped: 7, skippedReason: 'request_budget_exhausted' };
    return { status: 200, text: JSON.stringify(first) };
  };
  try {
    const { context, page, errors } = await visit('/new');
    try {
      await page.getByRole('heading', { name: 'New position', exact: true }).waitFor();
      const moreWays = page.locator('summary', { hasText: 'More ways to find a token' });
      await moreWays.click();
      const listing = page.locator('details').filter({ has: moreWays }).locator('[data-wallet-candidates]');
      await listing.getByRole('button', { name: 'List tokens from a public address' }).click();
      await page.fill('#wallet-address', OWNER);
      await listing.getByRole('button', { name: 'List tokens', exact: true }).click();
      await listing.locator('[data-wallet-pages="1"]').waitFor({ timeout: 30_000 });
      for (const started = Date.now(); !walletBodies().some((b) => b.autoDiscover === false) && Date.now() - started < 30_000; ) await page.waitForTimeout(50);
      assert.equal(walletBodies().filter((b) => b.autoDiscover === false).length, 1, 'the check is on the wire');
      await listing.getByRole('button', { name: 'Load more' }).click();
      await listing.locator('[data-wallet-pages="2"]').waitFor({ timeout: 30_000 });
      // The check's balance became a candidate, by address.
      await page.locator('[data-candidate] [data-address]', { hasText: /0x5fc5/i }).first().waitFor({ state: 'attached', timeout: 30_000 });
      await page.waitForTimeout(2000);
      assert.deepEqual(walletBodies(), [
        { wallet: OWNER, autoDiscover: true },
        { wallet: OWNER, tokens: SELECTED_TOKENS, autoDiscover: false },
        { wallet: OWNER, autoDiscover: true, cursor: HANDLE },
      ], 'one check for one list: Load more never cancels it and asks again');
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  } finally {
    overrideReply = null;
  }
});
