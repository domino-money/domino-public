/**
 * The bridge source in a real browser, behind the real gate, against the real
 * bridge Worker.
 *
 * The bridge-test build (vite build --mode bridge-test) is served through the
 * compiled beta gate. /api/* goes, once the gate admits it, to
 * bridge/src/worker.mjs unmodified, with its gateway replaced by package
 * fixtures. The only translation is the one Cloudflare would make: the Worker
 * requires an https origin, so this origin is presented to it as one.
 *
 * This proves the Pages-middleware topology only. A Worker route mounted on
 * the zone would run instead of the Pages middleware; that composition is an
 * open question for rugged97, not something this test can show.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeContext, leaving, watch } from './page-watch.mjs';
import { createWorker } from '../../bridge/src/worker.mjs';
import { BRIDGE_DIST, createGatedServer } from '../scripts/gated-server.mjs';

const PASSWORD = 'bridge-test-beta-password';
const GATE = { BETA_PASSWORD: PASSWORD, BETA_COOKIE_KEY: 'Qk2mP9vQx4Lr7TbW1cNy6ZsJ3dGa8FeU5oViRtYqWeB' };
const APP = 'https://app.test';
const BRIDGE = {
  APP_ORIGIN: APP,
  READ_BRIDGE_ENABLED: 'true',
  GATEWAY_ORIGIN: 'https://gateway.test',
  ENABLED_READS: 'token,pools,pool-market,wallet-assets,nft-positions,catalogue,pool-activity,pool-positions,pool-metrics',
  ACCESS_CLIENT_ID: 'bridge-test-client',
  ACCESS_CLIENT_SECRET: 'bridge-test-secret',
};
const RC3 = '1.1.0-rc.3';
const READ = resolve(import.meta.dirname, '../../api-contracts/read-v1/fixtures/gateway');
const fixture = (name) => readFileSync(join(READ, `${name}.json`), 'utf8');
/** The package's fixture pool, which the bridge-test build asks for. */
const FIXTURE_POOL = JSON.parse(fixture('pool-market.not-requested')).poolId;

/**
 * The Path session-v1's bridge gives its session and preauth cookies, read
 * from bridge/src/session-worker.mjs so this test follows the producer. A
 * Path that covers /api/read/v1/ means the browser sends those cookies to
 * this origin with every public read; the app cannot leave them out while
 * keeping the beta cookie, and a __Host- cookie must be Path=/. The gate
 * therefore drops every cookie from a public read before passing it on.
 */
const SESSION_COOKIE_PATH = (() => {
  const source = readFileSync(resolve(import.meta.dirname, '../../bridge/src/session-worker.mjs'), 'utf8');
  const found = source.match(/__Host-domino-\$\{name\}=[^`]*?;\s*Path=([^;`\s]+)/);
  if (!found) throw new Error('session-worker.mjs no longer sets __Host-domino-${name} with a Path; update this test.');
  return found[1];
})();
const READ_PATH = '/api/read/v1/';
const SESSION_COOKIES_COVER_READS = SESSION_COOKIE_PATH === '/' || READ_PATH.startsWith(SESSION_COOKIE_PATH.endsWith('/') ? SESSION_COOKIE_PATH : `${SESSION_COOKIE_PATH}/`);

if (!existsSync(join(BRIDGE_DIST, 'index.html'))) {
  throw new Error('.bridge-dist/index.html is missing. Run `npm run build:bridge-test` before this test.');
}

const LAUNCHES = process.env.DOMINO_BROWSER_PATH
  ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }]
  : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}];

/** What the gateway answers; a test may replace any reply, or hold it with a promise. */
const DEFAULT_REPLY = (route, body) => {
  const name = {
    'pool-market': 'pool-market.not-requested',
    'pool-metrics': 'pool-metrics.qualified',
    token: body.token === '0x0000000000000000000000000000000000000000' ? 'token.native' : 'token.success',
  }[route];
  return { status: 200, text: fixture(name ?? `${route}.success`) };
};
let answer = DEFAULT_REPLY;
/** Every request the browser sent to /api/, as it arrived at the edge, before the gate. */
let edge = [];
/** Every request to /api/ as the gate passed it on. */
let seen = [];
/** Every request the Worker sent on to the gateway. */
let upstream = [];

const worker = createWorker({
  getClientIp: () => '198.51.100.20',
  fetch: async (url, init) => {
    const route = new URL(url).pathname.replace('/internal/read/v1/', '');
    const body = JSON.parse(init.body);
    upstream.push({ route, body, headers: Object.fromEntries(new Headers(init.headers)) });
    const reply = (await answer(route, body)) ?? DEFAULT_REPLY(route, body);
    return new Response(reply.text, {
      status: reply.status,
      headers: { 'Content-Type': 'application/json', ...(reply.contract === null ? {} : { 'X-Domino-Read-Contract': RC3 }), ...reply.headers },
    });
  },
});

/** The gate's `next` for /api/*: the Worker, seeing this origin as its https app origin. */
async function api(request) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  seen.push({ method: request.method, path: url.pathname, headers: Object.fromEntries(headers) });
  if (headers.get('origin') === url.origin) headers.set('origin', APP);
  headers.delete('host');
  const body = request.method === 'GET' ? undefined : await request.text();
  return worker.fetch(new Request(new URL(`${url.pathname}${url.search}`, APP), { method: request.method, headers, body }), BRIDGE);
}

let server;
let origin;
let browser;

before(async () => {
  const observe = (request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) edge.push({ method: request.method, path: url.pathname, headers: Object.fromEntries(request.headers) });
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

/**
 * A signed-in visitor on the landing, with fresh request logs. `reply` replaces
 * the default gateway answers from the first read; `session` plants the
 * session and preauth cookies exactly as session-v1's bridge sets them.
 */
async function visit({ reply = DEFAULT_REPLY, session = false } = {}) {
  answer = reply;
  edge = [];
  seen = [];
  upstream = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  if (session) {
    const url = new URL(origin);
    await context.addCookies(
      [['session', 'sessiontoken'], ['preauth', 'preauthtoken']].map(([name, value]) => ({
        name: `__Host-domino-${name}`,
        value,
        domain: url.hostname,
        path: SESSION_COOKIE_PATH,
        secure: true,
        httpOnly: true,
        sameSite: 'Lax',
      })),
    );
    const planted = (await context.cookies()).map((c) => c.name);
    assert.ok(planted.includes('__Host-domino-session') && planted.includes('__Host-domino-preauth'), `session cookies were not planted: ${planted}`);
  }
  const page = await context.newPage();
  // Per page, and teardown-aware: an ERR_ABORTED of a view this test leaves is the test's doing (page-watch.mjs).
  const { problems: errors } = watch(page, { console: false, requests: false, responses: false });
  await page.goto(`${origin}/`, { waitUntil: 'networkidle' });
  await page.fill('#password', PASSWORD);
  leaving(page);
  await Promise.all([page.waitForNavigation({ waitUntil: 'networkidle' }), page.click('button[type="submit"]')]);
  return { context, page, errors };
}

const statusOf = (page) => page.locator('#pools [data-read-status]');
async function settled(page) {
  await page.waitForFunction(() => {
    const status = document.querySelector('#pools [data-read-status]')?.getAttribute('data-read-status');
    return status && status !== 'loading' && !document.querySelector('#pools [aria-disabled="true"]');
  }, null, { timeout: 30_000 });
  return statusOf(page).getAttribute('data-read-status');
}

test('the bridge build reads through the same-origin bridge, adds no credential of its own, and no cookie gets past the gate', async () => {
  const { context, page, errors } = await visit({ session: true });
  assert.equal(await settled(page), 'none');
  const row = page.locator('#pools tbody tr');
  assert.equal(await row.count(), 1);
  assert.match(await row.innerText(), /\$12\.3K\s*·\s*GeckoTerminal[\s\S]*Unavailable/);
  assert.equal(await row.locator('td').last().locator('[data-metric]').getAttribute('data-metric'), 'unavailable', 'no APR is provided, so none is shown');

  const reads = seen.map((r) => `${r.method} ${r.path}`);
  // The lean path, in order: pool-market without price history, then each token once. Never pool-metrics.
  assert.deepEqual(reads, ['GET /api/read/v1/capabilities', 'POST /api/read/v1/pool-market', 'POST /api/read/v1/token', 'POST /api/read/v1/token']);
  assert.deepEqual(upstream.find((call) => call.route === 'pool-market').body, { poolId: FIXTURE_POOL, includePriceHistory: false });
  // What the browser sent to this origin.
  assert.deepEqual(edge.map((r) => `${r.method} ${r.path}`), reads, 'every read passed through the gate once');
  for (const request of edge) {
    const h = request.headers;
    assert.match(h.cookie ?? '', /__Host-domino-beta=/, 'the gate cookie reaches the gate');
    assert.equal(h['sec-fetch-site'], 'same-origin');
    assert.equal(h['x-domino-read-contract'], RC3);
    for (const forbidden of ['authorization', 'x-domino-csrf', 'x-domino-session', 'x-domino-preauth']) assert.equal(h[forbidden], undefined, forbidden);
    // The browser attaches every cookie whose Path covers the read route; fetch cannot pick one out.
    // With session-v1's Path=/ that includes the session and preauth cookies, as far as the gate.
    if (SESSION_COOKIES_COVER_READS) assert.match(h.cookie, /__Host-domino-session=sessiontoken/, 'the browser sends a Path=/ session cookie to the edge');
    else assert.doesNotMatch(h.cookie, /domino-session|domino-preauth/, 'a narrowed session cookie stays off public reads');
    if (request.method === 'POST') assert.equal(h['content-type'], 'application/json');
  }
  // What the gate passed on: the same reads, with no cookie of any kind.
  for (const request of seen) {
    assert.equal(request.headers.cookie, undefined, `${request.path} went past the gate with a cookie`);
    for (const [name, value] of Object.entries(request.headers)) assert.doesNotMatch(value, /sessiontoken|preauthtoken|domino-beta/, `a credential went past the gate in ${name}`);
    assert.equal(request.headers['x-domino-read-contract'], RC3, 'the read itself went on unchanged');
  }
  // The gateway never sees the browser's cookie, origin or headers, and no session credential in any header.
  assert.deepEqual(upstream.map((call) => call.route), ['pool-market', 'token', 'token'], 'the gateway saw the same three reads');
  for (const call of upstream) {
    assert.equal(call.headers.cookie, undefined);
    assert.equal(call.headers.origin, undefined);
    for (const forbidden of ['authorization', 'x-domino-csrf', 'x-domino-session', 'x-domino-preauth']) assert.equal(call.headers[forbidden], undefined, forbidden);
    for (const [name, value] of Object.entries(call.headers)) assert.doesNotMatch(value, /sessiontoken|preauthtoken/, `the session credential reached the gateway in ${name}`);
  }
  assert.match(await page.locator('[data-build-banner="bridge"]').innerText(), /Not deployable/);
  assert.deepEqual(errors, []);
  await closeContext(context);
});

test('Settings in the bridge-test build says what dist says: live reads built in, switched on by the server', async () => {
  const { context, page } = await visit();
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.waitForTimeout(150);
  const text = await page.locator('#root').innerText();
  assert.match(text, /Live reads\s+Built in, switched on by the server/);
  assert.match(text, /Signing\s+Off/, 'reading is the only thing the test build turns on');
  await closeContext(context);
});

const cellStates = (page) => page.locator('#pools tbody [data-metric]').evaluateAll((els) => els.map((el) => el.getAttribute('data-metric')));

test('a refresh without the cookie is gate_required, and the last rows stay, marked stale', async () => {
  // Provider figures are what the lean table shows: they must turn stale too.
  const { context, page } = await visit();
  assert.equal(await settled(page), 'none');
  const before = await cellStates(page);
  assert.ok(before.includes('provider') && !before.includes('qualified'), `the page starts from current provider figures: ${before}`);
  assert.match(await page.locator('#pools tbody tr').innerText(), /GeckoTerminal/);
  await context.clearCookies();
  await page.getByRole('button', { name: 'Refresh' }).click();
  assert.equal(await settled(page), 'gate_required');
  assert.match(await statusOf(page).innerText(), /Sign in again[\s\S]*|Beta access needed/);
  assert.equal(await page.locator('#pools tbody tr').count(), 1, 'the last good rows stay');
  const states = await cellStates(page);
  assert.ok(!states.includes('qualified') && !states.includes('provider') && !states.includes('calculated'), `retained rows read as current: ${states}`);
  // The provider's figures and the vol/TVL Domino calculates from them.
  const current = before.filter((state) => state === 'provider' || state === 'calculated').length;
  assert.equal(states.filter((state) => state === 'stale').length, current, `every provider and calculated cell turned stale: ${states}`);
  assert.ok(states.includes('stale'));
  assert.match(await statusOf(page).innerText(), /marked stale/);
  // Refresh gave way to the failure's own controls: focus moved to the heading, not to the page.
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Selected pools', 'focus fell to the page after a failed Refresh');
  await closeContext(context);
});

test('a gate configuration broken at runtime is gate_unavailable; once fixed, Retry recovers and focus lands on the heading', async () => {
  const { context, page } = await visit();
  // Closed even when an assertion fails, so a held read cannot leak into the next test.
  try {
    await settled(page);
    const password = GATE.BETA_PASSWORD;
    GATE.BETA_PASSWORD = '';
    try {
      await page.getByRole('button', { name: 'Refresh' }).click();
      assert.equal(await settled(page), 'gate_unavailable');
      assert.match(await statusOf(page).innerText(), /Access is paused/);
    } finally {
      GATE.BETA_PASSWORD = password;
    }
    // Hold the gateway so the retry stays in flight: the kept rows must stay stale beside the failure it retries.
    let release = () => undefined;
    const held = new Promise((done) => {
      release = done;
    });
    answer = async () => {
      await held;
      return undefined;
    };
    try {
      await page.getByRole('button', { name: 'Retry' }).click();
      await page.waitForFunction(() => document.querySelector('#pools [aria-disabled="true"]'));
      assert.equal(await statusOf(page).getAttribute('data-read-status'), 'gate_unavailable');
      const during = await page.evaluate(() =>
        [...document.querySelectorAll('#pools tbody [data-metric], .dm-marquee [data-metric]')].map((el) => el.getAttribute('data-metric')),
      );
      assert.ok(during.includes('stale'), `rows during the retry: ${during}`);
      assert.deepEqual(during.filter((state) => state === 'qualified' || state === 'provider'), [], 'retained rows read as current during the retry');
    } finally {
      release();
    }
    assert.equal(await settled(page), 'none');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Selected pools');
  } finally {
    await closeContext(context);
  }
});

test('a gateway without the contract header is shown as a contract mismatch, and nothing from it', async () => {
  const { context, page } = await visit();
  // The first load reads to the end before the gateway changes and the page reloads: none of its reads is cut
  // short, or still at the bridge when the reloaded page asks.
  assert.equal(await settled(page), 'none');
  answer = (route, body) => (route === 'pool-market' ? { ...DEFAULT_REPLY(route, body), contract: null } : undefined);
  leaving(page);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await settled(page), 'incompatible');
  assert.match(await statusOf(page).innerText(), /disagree on the contract version/);
  assert.equal(await page.locator('#pools tbody tr').count(), 0);
  await closeContext(context);
});

test('with live reads off on the server, nothing is posted at all', async () => {
  BRIDGE.READ_BRIDGE_ENABLED = 'false';
  try {
    const { context, page } = await visit();
    assert.equal(await settled(page), 'disabled');
    assert.match(await statusOf(page).innerText(), /Live data is switched off for now[\s\S]*switched off on the server/);
    assert.deepEqual(seen.map((r) => r.method), ['GET']);
    await closeContext(context);
  } finally {
    BRIDGE.READ_BRIDGE_ENABLED = 'true';
  }
});

test('a 503 is shown with Retry and never asked again on its own; a 429 is asked again after its Retry-After', async () => {
  const { context, page } = await visit();
  try {
    await settled(page);
    const marketReads = () => upstream.filter((call) => call.route === 'pool-market').length;

    // A 503: shown as itself after one attempt, until the person presses Retry.
    upstream = [];
    let failed = false;
    answer = (route) => {
      if (route !== 'pool-market' || failed) return undefined;
      failed = true;
      return { status: 503, text: '{"error":"upstream_unavailable"}' };
    };
    leaving(page);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await settled(page), 'unavailable');
    assert.match(await statusOf(page).innerText(), /Temporarily unavailable[\s\S]*answered: read service unavailable/);
    assert.equal(marketReads(), 1, 'the 503 was asked again automatically');
    await page.getByRole('button', { name: 'Retry' }).click();
    assert.equal(await settled(page), 'none');
    assert.equal(marketReads(), 2, 'Retry asked once more');

    // One 429: asked again after its Retry-After, and the rows come back.
    upstream = [];
    let busy = false;
    answer = (route) => {
      if (route !== 'pool-market' || busy) return undefined;
      busy = true;
      return { status: 429, text: '{"error":"read_capacity_busy"}', headers: { 'Retry-After': '1' } };
    };
    await page.getByRole('button', { name: 'Refresh' }).click();
    assert.equal(await settled(page), 'none');
    assert.equal(marketReads(), 2, 'one 429, one automatic retry');

    // A 429 every time: three attempts in all, then shown with its wait.
    upstream = [];
    answer = (route) => (route === 'pool-market' ? { status: 429, text: '{"error":"read_capacity_busy"}', headers: { 'Retry-After': '1' } } : undefined);
    await page.getByRole('button', { name: 'Refresh' }).click();
    assert.equal(await settled(page), 'busy');
    assert.match(await statusOf(page).innerText(), /Try again in 1 s/);
    assert.equal(marketReads(), 3);
  } finally {
    await closeContext(context);
  }
});
