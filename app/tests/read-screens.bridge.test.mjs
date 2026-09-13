/**
 * The read screens in the bridge-test build: the real beta gate in front of
 * the unmodified bridge Worker (bridge/src/worker.mjs), with its gateway
 * replaced by package fixtures, as read-bridge.browser.test.mjs sets it up.
 *
 * What only this topology can show: the position lookup sends exactly the
 * typed IDs as a same-origin POST, the capabilities are asked once, reads
 * from the lookup and the landing are spaced the way the bridge admits them,
 * a refresh without the beta cookie is the gate's state (never a wallet
 * sign-in) and keeps the cards, pool activity is read only on demand, and
 * the wallet listing's continuation handle travels only in POST bodies (B4).
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

async function settled(page) {
  await page.waitForFunction(
    () => {
      const status = document.querySelector('#chain-lookup [data-screen-status]')?.getAttribute('data-screen-status');
      return status && status !== 'loading' && !document.querySelector('#chain-lookup [aria-disabled="true"]');
    },
    null,
    { timeout: 30_000 },
  );
  return page.locator('#chain-lookup [data-screen-status]').getAttribute('data-screen-status');
}

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
  // The section no longer carries a build pill; each card, opened, says its facts are read from chain.
  const first = page.locator('[data-chain-card]').first();
  await first.locator('summary').click();
  assert.match(await first.innerText(), /Read from chain/);

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

  const refreshed = edge.length;
  await page.getByRole('button', { name: 'Refresh' }).click();
  await settled(page);
  assert.equal(edge.filter((r) => r.method === 'GET').length, 1, 'capabilities are asked once per page load');
  assert.ok(edge.length > refreshed);
  assert.deepEqual(errors, []);
  await context.close();
});

test('a refresh without the beta cookie is the gate state: cards stay, no link, no wallet', async () => {
  const { context, page } = await visit('/app');
  await page.locator('#chain-lookup').waitFor();
  await lookUp(page);
  assert.equal(await settled(page), 'ok');
  await context.clearCookies();
  await page.getByRole('button', { name: 'Refresh' }).click();
  assert.equal(await settled(page), 'gate_required');
  const text = await page.locator('#chain-lookup [data-screen-status]').innerText();
  assert.match(text, /Beta access expired[\s\S]*Reload the page to sign in to the beta\./);
  assert.doesNotMatch(text, /wallet|connect/i);
  assert.equal(await page.locator('#chain-lookup a').count(), 0);
  assert.equal(await page.locator('[data-chain-card]').count(), 2, 'the last cards that worked stay');
  await context.close();
});

test('position reads switched off on the server: said plainly, and not one position is posted', async () => {
  BRIDGE.ENABLED_READS = 'token,pools,pool-market,pool-metrics';
  try {
    const { context, page } = await visit('/app');
    await page.locator('#chain-lookup').waitFor();
    await lookUp(page);
    assert.equal(await settled(page), 'disabled');
    assert.match(await page.locator('#chain-lookup [data-screen-status]').innerText(), /Position reads aren’t enabled on this server\./);
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
    assert.match(await page.locator('#chain-lookup [data-screen-status]').innerText(), /This server has live reads turned off\./);
    assert.deepEqual(posts(), []);
    await context.close();
  } finally {
    BRIDGE.READ_BRIDGE_ENABLED = 'true';
  }
});


/** The selected pools' lean load has finished on Markets: a row with a figure is on the page. */
const poolsSettled = (page) => page.waitForFunction(() => document.querySelectorAll('[data-selected-pools] tbody [data-metric]').length > 0, null, { timeout: 30_000 });
/** The fixture pool's card on the Markets rail has settled its hourly read: bars, or a line saying why there are none. */
const cardSettled = (page) => page.waitForFunction(() => document.querySelector('[data-market-card] [data-volume-bar], [data-market-card] [data-chart-unavailable]'), null, { timeout: 30_000 });
/**
 * The route's own reading on mount: the capabilities once per namespace, then the fixture pool's market and its two
 * tokens, then the rail card's one hourly read for that pool (with price history), queued behind the table's reads.
 */
const MOUNT = ['GET /api/read/v2/capabilities', 'GET /api/read/v1/capabilities', 'POST /api/read/v1/pool-market', 'POST /api/read/v1/token', 'POST /api/read/v1/token', 'POST /api/read/v1/pool-market'];
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
  const routes = () => posts().map((r) => r.path.replace('/api/read/v1/', ''));
  // F3's table path does not read pool-metrics (marketsProvider.ts:11, "No
  // pool-metrics read"), so the landing asks three times, not four.
  assert.deepEqual(routes().sort(), ['pool-market', 'token', 'token']);
  assert.deepEqual(edge.filter((r) => r.method === 'GET').map((r) => r.path), ['/api/read/v2/capabilities', '/api/read/v1/capabilities'], 'the optional estimate probe falls back before any V2 data POST');
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
    const cardRead = JSON.parse(posts()[3].body);
    assert.deepEqual(cardRead, { poolId: POOL, includePriceHistory: true, priceToken: 'quote' }, 'the card asks for the same candles the pool page would');
    assert.ok(posts()[3].at - posts()[2].at >= 1050, 'and queues behind the table\'s reads');
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
    assert.match(await card.innerText(), /Read at block 700/);
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
    const browser = page.locator('[data-catalogue-browser]');
    await browser.locator('summary').click();
    assert.match(await browser.innerText(), /a candidate opens once verified at the latest block/);
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
    const forbidden = /sign|approve|connect|deposit|swap|quote|mint|confirm|execute|buy|sell/i;
    for (const name of await page.locator('main button').allInnerTexts()) assert.doesNotMatch(name, forbidden, name);
    await page.waitForTimeout(1200);

    // The token search reads the chosen address, then the token's view reads it for itself (DESIGN.md E.2).
    assert.deepEqual(trail().slice(MOUNT.length), [
      'POST /api/read/v1/token',
      'POST /api/read/v1/token',
      'POST /api/read/v1/pools',
      'POST /api/read/v1/catalogue',
      'POST /api/read/v1/pools',
      'POST /api/read/v1/pool-market',
    ], 'only explicit public reads: no market polling, session or financial call');
    assert.deepEqual(posts().slice(4).map((r) => JSON.parse(r.body)), [
      { token: TOKEN },
      { token: TOKEN },
      { token: TOKEN },
      { token: TOKEN, limit: 20 },
      { token: TOKEN, maxPools: 1, poolIds: [POOL] },
      { poolId: POOL, includePriceHistory: false },
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
    assert.deepEqual(posts().slice(before).map((r) => JSON.parse(r.body)), [{ token: native }, { token: native }], 'the search\'s token read and the view\'s own, and no pools read on its own');
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

for (const route of ['pools', 'catalogue']) {
  test(`Markets retries a failed first ${route} read explicitly, without losing the searched token`, { timeout: 45_000 }, async () => {
    const { context, page, errors } = await visit('/pools');
    let calls = 0;
    let release = () => undefined;
    let started = () => undefined;
    const held = new Promise((resolve) => { release = resolve; });
    const retryStarted = new Promise((resolve) => { started = resolve; });
    overrideReply = (read, body) => {
      if (read !== route) return null;
      calls += 1;
      if (calls === 1) return { status: 503, text: fixture(`../error/${route}.upstream_unavailable`) };
      return (async () => { started(); await held; return REPLY(read, body); })();
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
      const status = page.locator(route === 'pools' ? '[data-found-pools] [data-picker="pool"] > [data-screen-status]' : '[data-catalogue] > [data-screen-status]');
      await status.getByText('The read service answered:', { exact: false }).waitFor({ timeout: 30_000 });
      assert.equal(await status.getAttribute('data-screen-status'), 'unavailable');
      await page.waitForTimeout(1200);
      assert.equal(calls, 1, '503 never starts an automatic retry');
      const retry = status.getByRole('button', { name: 'Retry', exact: true });
      assert.equal(await retry.count(), 1, `${route}: a failed first read needs an explicit Retry, with the token as searched`);
      await retry.click();
      await retryStarted;
      const trying = status.getByRole('button', { name: 'Trying again…', exact: true });
      assert.equal(await trying.getAttribute('aria-disabled'), 'true', 'Retry stays mounted and busy');
      await trying.evaluate((button) => { button.click(); button.click(); });
      await page.waitForTimeout(100);
      assert.equal(calls, 2, 'busy Retry cannot start another logical read');
      release();
      await page.locator(route === 'pools' ? '[data-found-pools] [data-pool-option="discovery"]' : '[data-catalogue-item]').waitFor({ timeout: 30_000 });
      assert.equal(await status.getByRole('button').count(), 0, 'a successful retry clears the failure');
      assert.equal(await page.locator('[data-token-lookup="ok"]').count(), 1, 'the searched token remains');
      assert.equal(await page.locator('[data-find-pools]').innerText(), 'Pools below', 'and its pools stay asked for');
      const requests = posts().filter((r) => r.path.endsWith(`/${route}`));
      assert.equal(requests.length, 2);
      const expected = route === 'pools' ? { token: TOKEN } : { token: TOKEN, limit: 20 };
      assert.deepEqual(requests.map((r) => JSON.parse(r.body)), [expected, expected], 'Retry repeats the same question, without a cursor or another token');
      assert.ok(requests[1].at - requests[0].at >= 1050, 'Retry uses the shared paced source');
      assert.deepEqual(errors, []);
    } finally {
      release();
      overrideReply = null;
      await context.close();
    }
  });
}

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
  assert.match(await wallet.innerText(), /Balances at the snapshot block\. Not proof of wallet control\./);
  // The handle is live now (the first page's next handle, not yet sent back): look while it exists.
  assert.equal(JSON.parse(walletReplies[0]).inventory.nextCursor, HANDLE);
  assert.deepEqual(await handlePlaces(page, HANDLE.slice(0, 16)), NOWHERE, 'the live handle is in the page');
  await wallet.getByRole('button', { name: 'Load more' }).click();
  await page.waitForFunction(() => /All pages loaded/.test(document.querySelector('[data-wallet-candidates]')?.textContent ?? ''), null, { timeout: 30_000 });
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
