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

const worker = createWorker({
  getClientIp: () => '198.51.100.21',
  fetch: async (url, init) => {
    const route = new URL(url).pathname.replace('/internal/read/v1/', '');
    const body = JSON.parse(init.body);
    upstream.push({ route, body, raw: init.body });
    const reply = REPLY(route, body);
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
  await browser?.close();
  await new Promise((done) => server.close(done));
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
  await page.getByRole('button', { name: 'Show lookup' }).click();
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
  assert.match(await page.locator('#chain-lookup').innerText(), /Chain read/);

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

test('the landing reads one listed pool, never a placeholder id, and pool activity only when a pool is opened', async () => {
  const { context, page, errors } = await visit('/');
  await page.locator('#pools tbody tr').first().waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => document.querySelector('[data-pool-figure-notes]'), null, { timeout: 30_000 });
  const routes = () => posts().map((r) => r.path.replace('/api/read/v1/', ''));
  // F3's table path does not read pool-metrics (marketsProvider.ts:11, "No
  // pool-metrics read"), so the landing asks three times, not four.
  assert.deepEqual(routes().sort(), ['pool-market', 'token', 'token']);
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

// OPEN QUESTION for @rugged97: this case drives the create flow of #72 ("New
// position" -> Choose token -> List tokens from a public address), and that
// flow is not on this base: `ChainSelectionSlot` (slots.tsx:47) is mounted by
// nothing outside the lab until #72 lands, so the app route has no way in.
//
// What stays covered meanwhile: the handle never reaching the page, the DOM or
// storage is asserted live in read-screens.browser.test.mjs ('a public address
// lists tokens as a public lookup...'), with the same handle-watch helpers.
// What is NOT covered until this case runs again: the bridge leg — that the
// bytes the page POSTs are the bytes the bridge forwards upstream, and that no
// edge request carries the handle in a URL or a Referer. Restore this case with
// #72; nothing here was weakened to make it pass.
test.skip('B4: the wallet handle goes back to the bridge byte for byte in the POST body, and never into a URL, a Referer, storage or the page', async () => {
  const { context, page, errors } = await visit('/app');
  // A fresh document with the watcher in place before any app code runs; the reads so far don't count.
  await page.addInitScript(watchForHandle, HANDLE.slice(0, 16));
  await page.reload({ waitUntil: 'networkidle' });
  edge = [];
  upstream = [];
  walletReplies = [];
  const seen = [];
  page.on('request', (request) => seen.push({ url: request.url(), referer: request.headers().referer ?? '' }));
  await page.getByRole('button', { name: 'New position' }).click();
  const dialog = page.locator('[role="dialog"]');
  await dialog.getByRole('button', { name: 'Choose token' }).click();
  await dialog.getByRole('button', { name: 'List tokens from a public address' }).click();
  await page.fill('#wallet-address', OWNER);
  await dialog.getByRole('button', { name: 'List tokens', exact: true }).click();
  const wallet = dialog.locator('[data-wallet-candidates]');
  await page.waitForFunction(() => document.querySelector('[data-wallet-pages="1"]'), null, { timeout: 30_000 });
  assert.match(await wallet.innerText(), /Public lookup, not your wallet/);
  // The handle is live now (the first page's next handle, not yet sent back): look while it exists.
  assert.equal(JSON.parse(walletReplies[0]).inventory.nextCursor, HANDLE);
  assert.deepEqual(await handlePlaces(page, HANDLE.slice(0, 16)), NOWHERE, 'the live handle is in the page');
  await wallet.getByRole('button', { name: 'Load more' }).click();
  await page.waitForFunction(() => /All pages loaded/.test(document.querySelector('[data-wallet-candidates]')?.textContent ?? ''), null, { timeout: 30_000 });

  // What the browser received is the stub's handle, untouched by the bridge.
  assert.equal(walletReplies.length, 2);
  assert.equal(JSON.parse(walletReplies[0]).inventory.nextCursor, HANDLE);
  const walletPosts = posts().filter((r) => r.path === '/api/read/v1/wallet-assets');
  assert.deepEqual(walletPosts.map((r) => r.body), [JSON.stringify({ wallet: OWNER, autoDiscover: true }), JSON.stringify({ wallet: OWNER, autoDiscover: true, cursor: HANDLE })]);
  // ...and the bridge hands the gateway those same bytes.
  const up = upstream.filter((r) => r.route === 'wallet-assets');
  assert.deepEqual(up.map((r) => r.raw), walletPosts.map((r) => r.body));
  assert.equal(up[1].body.cursor, HANDLE);

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
