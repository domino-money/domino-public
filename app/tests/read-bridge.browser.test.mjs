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
import { after, afterEach, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeBrowser } from './support/close-browser.mjs';
import { closeContext, leaving, watch } from './page-watch.mjs';
import { createWorker } from '../../bridge/src/worker.mjs';
import { BRIDGE_DIST, createGatedServer } from '../scripts/gated-server.mjs';

const PASSWORD = 'bridge-test-beta-password';
const GATE = { BETA_PASSWORD: PASSWORD, BETA_COOKIE_KEY: 'Qk2mP9vQx4Lr7TbW1cNy6ZsJ3dGa8FeU5oViRtYqWeB' };
const APP = 'https://app.test';
/**
 * The read Worker's routes as production enables them today: the seven public
 * reads, none of the optional ones. A test lists one to turn it on.
 */
const PRODUCTION_READS = 'token,pools,pool-market,wallet-assets,nft-positions,catalogue,pool-activity';
const BRIDGE = {
  APP_ORIGIN: APP,
  READ_BRIDGE_ENABLED: 'true',
  GATEWAY_ORIGIN: 'https://gateway.test',
  ENABLED_READS: PRODUCTION_READS,
  ACCESS_CLIENT_ID: 'bridge-test-client',
  ACCESS_CLIENT_SECRET: 'bridge-test-secret',
};
const RC3 = '1.1.0-rc.3';
/** The estimate namespace's contract (read-v2, src/lib/read/pin.ts): what its own capabilities GET carries. */
const V2 = '2.0.0-rc.1';
/** The contract header a request must carry: its namespace's, and no other. */
const contractFor = (path) => (path.startsWith('/api/read/v3/') ? '3.0.0-rc.1' : path.startsWith('/api/read/v2/') ? V2 : RC3);
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
    upstream.push({ route, body, headers: Object.fromEntries(new Headers(init.headers)), at: Date.now() });
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

afterEach(async () => { await Promise.all(browser.contexts().map(context => context.close())); });

after(async () => {
  await closeBrowser(browser);
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
/** Waits until the landing's status is `code`, whatever it passes through on the way. */
const statusIs = (page, code) =>
  page.waitForFunction((wanted) => document.querySelector('#pools [data-read-status]')?.getAttribute('data-read-status') === wanted, code, { timeout: 30_000 });

const NATIVE = '0x0000000000000000000000000000000000000000';
/** The read service's 429, asking for a wait of 1 s. */
const BUSY = { status: 429, text: '{"error":"read_capacity_busy"}', headers: { 'Retry-After': '1' } };
/** The fixture pool's other token stays busy past R-1: the pool's row stands, beside a problem that is only busy. */
const TOKEN_BUSY = (route, body) => (route === 'token' && body.token !== NATIVE ? BUSY : undefined);

/**
 * Home asks a read service that was only busy again on its own, the one read
 * it refused and nothing else: the first time once its Retry-After and at
 * least 4 s have passed since the busy answer, then at twice that, each drawn
 * within ±25% (recoverQuietly in marketsProvider.ts). Waiting past the latest
 * first re-ask shows a state is not asked again at all.
 */
const BUSY_RECOVERY_MS = 4_000;
const EARLIEST_BUSY_RECOVERY_MS = BUSY_RECOVERY_MS * 0.75;
const PAST_BUSY_RECOVERY_MS = BUSY_RECOVERY_MS * 1.25 + 1_500;

/**
 * How the landing says a read state: only in the table's polite live region,
 * visually hidden, as the state's code and its title alone. No detail, no
 * line and nothing to press in it, and no Refresh, Retry or sign-in link on
 * the card: the owner's decision on the redesign.
 */
async function saidQuietly(page, code, title) {
  const status = statusOf(page);
  assert.equal(await status.getAttribute('data-read-status'), code);
  assert.equal(await status.textContent(), title, `${code}: the status is its title alone`);
  assert.deepEqual(
    await status.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { hidden: box.width <= 1 && box.height <= 1, inside: el.children.length };
    }),
    { hidden: true, inside: 0 },
    `${code}: no status panel on Home`,
  );
  assert.equal(await page.locator('#pools').getByRole('button', { name: /Refresh|Retry|Trying again/ }).count(), 0, `${code}: no Refresh or Retry on Home`);
  assert.equal(await page.locator('#pools').getByRole('link', { name: 'Sign in again' }).count(), 0, `${code}: no sign-in link on Home`);
}

test('the bridge build reads through the same-origin bridge, adds no credential of its own, and no cookie gets past the gate', async () => {
  const { context, page, errors } = await visit({ session: true });
  assert.equal(await settled(page), 'none');
  const row = page.locator('#pools tbody tr');
  assert.equal(await row.count(), 1);
  // The figure alone in its cell; the provider named in the row's provenance line, dated by its retrieval age, and in the cell's title.
  assert.deepEqual(
    await row.locator('[data-metric]').evaluateAll((els) => els.map((el) => [el.innerText.trim(), el.getAttribute('data-metric')])),
    [['$12.3K', 'provider'], ['$0.00', 'provider']],
  );
  // The price is the pool's own ratio from chain state, in its own cell: never a figure attribute.
  assert.equal(await row.locator('td').nth(1).locator('[data-pool-price]').count(), 1);
  assert.equal(await row.locator('td').nth(1).locator('[data-metric]').count(), 0);
  assert.match(await row.locator('[data-provenance]').getAttribute('data-provenance'), /^Pool verified on-chain at block 700 · Reported by a market data provider, retrieved \d+ s ago$/);
  assert.match(await row.locator('[data-metric]').first().getAttribute('title'), /^Reported by a market data provider, retrieved \d+ s ago\. Not reconciled by Domino\.$/);
  const apr = row.locator('td').nth(4);
  assert.equal(await apr.innerText(), '—', 'no estimate: the catalogue dash, reason in its title');
  assert.equal(await apr.locator('[data-apr-estimate]').getAttribute('data-apr-estimate'), 'unavailable', 'no APR is provided, so none is shown');

  const reads = seen.map((r) => `${r.method} ${r.path}`);
  // The lean path starts with the disabled V3 namespace, then the read namespace's capabilities and the
  // estimate namespace's, then pool-market without price history, then each token once. Never pool-metrics.
  assert.deepEqual(reads, ['GET /api/read/v3/capabilities', 'GET /api/read/v1/capabilities', 'GET /api/read/v2/capabilities', 'POST /api/read/v1/pool-market', 'POST /api/read/v1/token', 'POST /api/read/v1/token']);
  assert.deepEqual(upstream.find((call) => call.route === 'pool-market').body, { poolId: FIXTURE_POOL, includePriceHistory: false });
  // What the browser sent to this origin.
  assert.deepEqual(edge.map((r) => `${r.method} ${r.path}`), reads, 'every read passed through the gate once');
  for (const request of edge) {
    const h = request.headers;
    assert.match(h.cookie ?? '', /__Host-domino-beta=/, 'the gate cookie reaches the gate');
    assert.equal(h['sec-fetch-site'], 'same-origin');
    assert.equal(h['x-domino-read-contract'], contractFor(request.path), `${request.path} names its namespace's contract`);
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
    assert.equal(request.headers['x-domino-read-contract'], contractFor(request.path), 'the read itself went on unchanged');
  }
  // The gateway never sees the browser's cookie, origin or headers, and no session credential in any header.
  assert.deepEqual(upstream.map((call) => call.route), ['pool-market', 'token', 'token'], 'the gateway saw the same three reads, and nothing for the estimate namespace');
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

// Changed on purpose (2026-09-27, the owner's round 6, point 6): the Settings page is gone, and with it the build card this
// test read. An old link to it opens the docs, which read nothing, in this build too.
test('an old Settings link in the bridge-test build opens the docs and reads nothing', async () => {
  const { context, page } = await visit();
  const before = edge.length;
  await page.evaluate(() => { location.hash = '#/settings'; });
  await page.getByRole('heading', { level: 1, name: 'Docs', exact: true }).waitFor();
  await page.waitForTimeout(150);
  const text = await page.locator('#root').innerText();
  assert.doesNotMatch(text, /AUTOMATED SIGNING|WALLET TRANSACTIONS|Live reads are built in|Nothing in this build signs a transaction/);
  assert.deepEqual(edge.slice(before), [], 'the docs ask the gateway nothing');
  await closeContext(context);
});

const cellStates = (page) => page.locator('#pools tbody [data-metric]').evaluateAll((els) => els.map((el) => el.getAttribute('data-metric')));

test('a read without the cookie is gate_required, the last rows stay, marked stale, and the gate is not asked again on its own', async () => {
  // Home has no Refresh, so the read after the cookie is gone is the one Home makes on its own: a token read is
  // still busy after R-1 on the first load, and the table asks that token again once its wait has passed.
  // Provider figures are what the lean table shows: they must turn stale too.
  const { context, page } = await visit({ reply: TOKEN_BUSY });
  try {
    assert.equal(await settled(page), 'partial');
    const before = await cellStates(page);
    assert.ok(before.includes('provider') && !before.includes('qualified'), `the page starts from current provider figures: ${before}`);
    // The row attributes its figures in its provenance (title and data), not as a printed line under the pair.
    assert.match(await page.locator('#pools tbody tr [data-provenance]').getAttribute('data-provenance'), /Reported by a market data provider/);
    await context.clearCookies();
    const knocked = edge.length;
    await statusIs(page, 'gate_required');
    await saidQuietly(page, 'gate_required', 'Access expired');
    assert.deepEqual(edge.slice(knocked).map((r) => `${r.method} ${r.path}`), ['POST /api/read/v1/token'], 'the gate’s 401 stopped the re-ask at its one read: the busy token, nothing else');
    assert.equal(await page.locator('#pools tbody tr').count(), 1, 'the last good rows stay');
    const states = await cellStates(page);
    assert.ok(!states.includes('qualified') && !states.includes('provider') && !states.includes('calculated'), `retained rows read as current: ${states}`);
    // The provider's figures, and anything Domino calculates from them.
    const current = before.filter((state) => state === 'provider' || state === 'calculated').length;
    assert.equal(states.filter((state) => state === 'stale').length, current, `every provider and calculated cell turned stale: ${states}`);
    assert.ok(states.includes('stale'));
    // No focus assertion after a failed Refresh any more: the owner removed Refresh and Retry from Home, so nothing there takes focus.
    const refused = edge.length;
    await page.waitForTimeout(PAST_BUSY_RECOVERY_MS);
    assert.equal(edge.length, refused, 'the gate’s answer is never asked again on its own');
  } finally {
    await closeContext(context);
  }
});

test('a gate configuration broken at runtime is gate_unavailable: the rows stay, marked stale, it is not asked again on its own, even once fixed, and a reload recovers', async () => {
  // Home has no Refresh, so the read that meets the broken gate is the one Home makes on its own, as above.
  const { context, page } = await visit({ reply: TOKEN_BUSY });
  const password = GATE.BETA_PASSWORD;
  // Closed, and the gate restored, even when an assertion fails, so nothing leaks into the next test.
  try {
    assert.equal(await settled(page), 'partial');
    GATE.BETA_PASSWORD = '';
    try {
      await statusIs(page, 'gate_unavailable');
    } finally {
      GATE.BETA_PASSWORD = password;
    }
    await saidQuietly(page, 'gate_unavailable', 'Access is paused');
    const kept = await cellStates(page);
    assert.ok(kept.includes('stale'), `rows kept beside the failure: ${kept}`);
    assert.deepEqual(kept.filter((state) => state === 'qualified' || state === 'provider'), [], 'retained rows read as current beside the failure');
    const paused = edge.length;
    await page.waitForTimeout(PAST_BUSY_RECOVERY_MS);
    assert.equal(edge.length, paused, 'a paused gate is never asked again on its own, even once it is fixed');
    // No focus assertion after a Retry that recovers any more: the owner removed Retry from Home, so a reload is the way back.
    answer = DEFAULT_REPLY;
    leaving(page);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await settled(page), 'none');
    assert.ok((await cellStates(page)).includes('provider'), 'the reload reads the rows again, current');
  } finally {
    GATE.BETA_PASSWORD = password;
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
  // Which side disagreed ("disagree on the contract version") is the read lab's to show now; tests/read.test.mjs
  // holds the bridge's upstream_contract_mismatch.
  await saidQuietly(page, 'incompatible', 'Read contract mismatch');
  assert.equal(await page.locator('#pools tbody tr').count(), 0);
  await closeContext(context);
});

test('with live reads off on the server, nothing is posted at all', async () => {
  BRIDGE.READ_BRIDGE_ENABLED = 'false';
  try {
    const { context, page } = await visit();
    assert.equal(await settled(page), 'disabled');
    // "switched off on the server" is the read lab's to show now; tests/read.test.mjs holds bridge_data_mode_disabled.
    await saidQuietly(page, 'disabled', 'Live data is switched off for now');
    await page.waitForTimeout(PAST_BUSY_RECOVERY_MS);
    // The read namespace's capabilities say reads are off, so the estimate namespace is never asked.
    assert.deepEqual(seen.map((r) => `${r.method} ${r.path}`), ['GET /api/read/v3/capabilities', 'GET /api/read/v1/capabilities'], 'one capabilities GET per checked namespace, no POST, and nothing asked again on its own');
    await closeContext(context);
  } finally {
    BRIDGE.READ_BRIDGE_ENABLED = 'true';
  }
});

test('a 503 is never asked again on its own, and Home has no Retry for it; a 429 is asked again after its Retry-After, and a service still busy after that is asked again by Home on its own, later each time', async () => {
  const { context, page } = await visit();
  // A held read is released even when an assertion fails, so it cannot leak into the next test.
  let release = () => undefined;
  try {
    await settled(page);
    const marketReads = () => upstream.filter((call) => call.route === 'pool-market');

    // A 503: shown as itself after one attempt, and never asked again on its own. With no Retry on Home, a reload asks again.
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
    await saidQuietly(page, 'unavailable', 'Temporarily unavailable');
    await page.waitForTimeout(PAST_BUSY_RECOVERY_MS);
    assert.equal(marketReads().length, 1, 'the 503 was asked again automatically');
    leaving(page);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await settled(page), 'none');
    assert.equal(marketReads().length, 2, 'the reload asked once more');

    // One 429: asked again after its Retry-After, and the rows come back.
    upstream = [];
    let busy = false;
    answer = (route) => {
      if (route !== 'pool-market' || busy) return undefined;
      busy = true;
      return BUSY;
    };
    leaving(page);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await settled(page), 'none');
    assert.equal(marketReads().length, 2, 'one 429, one automatic retry');

    // A token read busy past R-1: the pool's row stands, current, beside a problem that is only busy.
    upstream = [];
    answer = TOKEN_BUSY;
    leaving(page);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await settled(page), 'partial');
    // The load's last request: its answer, and so the busy state, came after it. Timed on this side, however slow the page is to report.
    const loadEnded = upstream.at(-1).at;
    await saidQuietly(page, 'partial', 'Some pool data could not be read');
    assert.ok((await cellStates(page)).includes('provider'));
    const busyToken = () => upstream.filter((call) => call.route === 'token' && call.body.token !== NATIVE);
    assert.equal(busyToken().length, 3, 'three attempts under R-1');
    const waitFor = async (check, what) => {
      const deadline = Date.now() + 30_000;
      while (!check()) {
        assert.ok(Date.now() < deadline, what);
        await page.waitForTimeout(100);
      }
    };

    // Home asks again on its own once the wait has passed (3 s at the least: 4 s within ±25%), never before, and
    // only the token that was busy: never the pool's market read. Busy again: three attempts, and the row stays as
    // it was, current, beside the same problem.
    await waitFor(() => busyToken().length === 6, 'Home did not ask the busy token again');
    assert.ok(busyToken()[3].at - loadEnded >= EARLIEST_BUSY_RECOVERY_MS - 100, `asked again ${busyToken()[3].at - loadEnded} ms after the busy answer, before its wait had passed`);
    await page.waitForTimeout(500);
    assert.deepEqual(upstream.map((call) => call.route), ['pool-market', 'token', 'token', 'token', 'token', 'token', 'token', 'token'], 'the busy token alone was asked again: no market read, not the native token');
    const retryEnded = busyToken().at(-1).at;
    await saidQuietly(page, 'partial', 'Some pool data could not be read');
    assert.ok((await cellStates(page)).includes('provider'), 'the row read a moment ago stays current');

    // Asked again once more, at twice the wait, and held in flight: the rows stay as they are, quietly, while it runs.
    const held = new Promise((done) => {
      release = done;
    });
    answer = async (route, body) => {
      if (route === 'token' && body.token !== NATIVE) await held;
      return undefined;
    };
    await waitFor(() => busyToken().length === 7, 'Home did not ask the busy token again the second time');
    assert.ok(busyToken()[6].at - retryEnded >= 2 * EARLIEST_BUSY_RECOVERY_MS - 100, `asked again ${busyToken()[6].at - retryEnded} ms after the second busy answer, before twice the wait had passed`);
    assert.equal(await statusOf(page).getAttribute('data-read-status'), 'partial', 'what is being asked again stays said, quietly');
    const during = await page.evaluate(() =>
      [...document.querySelectorAll('#pools tbody [data-metric], .dm-marquee [data-metric]')].map((el) => el.getAttribute('data-metric')),
    );
    assert.ok(during.includes('provider'), `rows during the re-ask: ${during}`);
    release();
    await statusIs(page, 'none');
    assert.ok((await cellStates(page)).includes('provider'), 'and the row is complete');
    assert.equal(marketReads().length, 1, 'with the one market read of the load');
  } finally {
    release();
    await closeContext(context);
  }
});

/** Runs `body` with the Worker enabling `reads`, and puts production's routes back whatever happens. */
async function withReads(reads, body) {
  BRIDGE.ENABLED_READS = reads;
  try {
    await body();
  } finally {
    BRIDGE.ENABLED_READS = PRODUCTION_READS;
  }
}
const edgeTrail = () => edge.map((r) => `${r.method} ${r.path}`);

test('markets-snapshot enabled on the Worker: one snapshot read puts the row on screen while its token reads are still held, and no market read follows', async () => {
  await withReads(`${PRODUCTION_READS},markets-snapshot`, async () => {
    let release = () => undefined;
    const held = new Promise((done) => {
      release = done;
    });
    const { context, page, errors } = await visit({
      reply: async (route) => {
        if (route === 'markets-snapshot') return { status: 200, text: fixture('markets-snapshot.subset') };
        if (route === 'token') await held;
        return undefined;
      },
    });
    try {
      await page.waitForFunction(() => document.querySelector('#pools tbody tr[data-row-source="markets-snapshot"] [data-provenance]'), null, { timeout: 30_000 });
      while (!upstream.some((call) => call.route === 'token')) await page.waitForTimeout(25);
      assert.deepEqual(upstream.map((call) => call.route), ['markets-snapshot', 'token'], 'the row is on screen while the first token read is held at the gateway');
      assert.deepEqual(upstream[0].body, { poolIds: [FIXTURE_POOL] }, 'the pool this build reads, and only it');
      release();
      assert.equal(await settled(page), 'none');
      assert.deepEqual(edgeTrail(), ['GET /api/read/v3/capabilities', 'GET /api/read/v1/capabilities', 'POST /api/read/v1/markets-snapshot', 'POST /api/read/v1/token', 'POST /api/read/v1/token'], 'no estimate namespace and no market read: the stored entry is fresh');
      assert.deepEqual(upstream.map((call) => call.route), ['markets-snapshot', 'token', 'token']);
      const row = page.locator('#pools tbody tr');
      assert.equal(await row.count(), 1);
      assert.equal(await row.getAttribute('data-row-source'), 'markets-snapshot');
      assert.deepEqual(await row.locator('[data-metric]').evaluateAll((els) => els.map((el) => [el.innerText.trim(), el.getAttribute('data-metric')])), [['$12.3K', 'provider'], ['$0.00', 'provider']]);
      assert.match(await row.locator('[data-provenance]').getAttribute('data-provenance'), /^Pool verified on-chain at block 700 · Reported by a market data provider, retrieved \d+ s ago$/);
      assert.equal(await row.locator('td').nth(1).locator('[data-pool-price]').getAttribute('data-pool-price'), 'usable');
      assert.deepEqual(errors, []);
    } finally {
      release();
      await closeContext(context);
    }
  });
});

test('markets-snapshot enabled but failing at the gateway: the pool is read in the same load, and nothing is shown or said of the failure', async () => {
  await withReads(`${PRODUCTION_READS},markets-snapshot`, async () => {
    const { context, page, errors } = await visit({ reply: (route) => (route === 'markets-snapshot' ? { status: 503, text: '{"error":"upstream_unavailable"}' } : undefined) });
    try {
      assert.equal(await settled(page), 'none');
      await saidQuietly(page, 'none', '');
      assert.deepEqual(edgeTrail(), ['GET /api/read/v3/capabilities', 'GET /api/read/v1/capabilities', 'POST /api/read/v1/markets-snapshot', 'GET /api/read/v2/capabilities', 'POST /api/read/v1/pool-market', 'POST /api/read/v1/token', 'POST /api/read/v1/token']);
      const row = page.locator('#pools tbody tr');
      assert.equal(await row.getAttribute('data-row-source'), 'pool-market');
      assert.deepEqual(await cellStates(page), ['provider', 'provider']);
      assert.deepEqual(errors, []);
    } finally {
      await closeContext(context);
    }
  });
});

test('pool-metrics enabled on the Worker: the row reads it after its market and tokens, and shows Domino’s qualified figures in place of the provider’s', async () => {
  await withReads(`${PRODUCTION_READS},pool-metrics`, async () => {
    const { context, page, errors } = await visit();
    try {
      assert.equal(await settled(page), 'none');
      assert.deepEqual(upstream.map((call) => call.route), ['pool-market', 'token', 'token', 'pool-metrics']);
      assert.deepEqual(upstream.at(-1).body, { poolId: FIXTURE_POOL });
      const row = page.locator('#pools tbody tr');
      assert.deepEqual(await row.locator('[data-metric]').evaluateAll((els) => els.map((el) => [el.innerText.trim(), el.getAttribute('data-metric')])), [['$0.000020', 'qualified'], ['$0.000029', 'qualified'], ['158.06%', 'qualified']]);
      assert.match(await row.locator('[data-provenance]').getAttribute('data-provenance'), / · Domino history fresh, 10 s$/);
      assert.equal(await row.locator('[data-apr-estimate]').count(), 0, 'the qualified APR stands where the estimate would');
      assert.deepEqual(errors, []);
    } finally {
      await closeContext(context);
    }
  });
});
