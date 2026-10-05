/**
 * The deployable dist in a real browser, behind the real gate, with a stub
 * where the /api forwarder and its bridge would be. Every honest state the
 * landing can be in, and exactly what each one costs on the wire:
 *
 *   (a) forwarder 503 bridge_unavailable   Live data unavailable: 2 GETs, 0 POST, no Retry
 *   (b) forwarder 404 not_found            Live data isn't available here
 *   (c) capabilities off, or no reads      Live data is switched off for now: 0 POST
 *   (d) reads enabled                      3 GETs + the lean load in order; APR unavailable; provider and age
 *   (e) 404 route_not_available            switched off, after the first POST
 *   (f) producer 503                       Temporarily unavailable, never asked again on its own
 *   (g) 429 read_capacity_busy             asked again under R-1 after its Retry-After
 *   (h) no access cookie                   the gate's 401: Access expired
 *   (i)-(l) #93's display rules, per row   provider figures dated by retrieval only; a rejected,
 *                                          stale, null or failed pool never takes the others with it;
 *                                          a pool still busy after R-1 is asked again on its own
 *   (n) pool-metrics listed                the lean load, then one pool-metrics read a row; qualified
 *                                          figures in the cells, the ticker and the figures dialog
 *   (o)-(p) markets-snapshot listed        one snapshot read puts every row on screen before any token
 *                                          read; only what it could not answer for is read on demand,
 *                                          and a failed snapshot is never shown or said
 *   (q) rows complete one by one           each row's tokens right after its market read; a price waits
 *                                          quietly until then, never Unavailable for decimals not read
 *
 * The stub's capabilities are production's by default: the seven public reads,
 * with V3 disabled, so the optional legacy routes are not listed and cost no
 * POST (the capabilities GETs answer whether they are). Listing one is what turns it on.
 *
 * Home's Selected pools card shows the pools and their figures and nothing
 * else, as the owner decided on reviewing the redesign: no status panel, no
 * Refresh, no Retry, no sign-in link. Each state above is said only in the
 * table's visually hidden live region, as its code and its title. A read
 * that a service refused only because it was busy is asked again on its own,
 * that read alone; nothing else is.
 *
 * With nothing read, the six reviewed pools are still listed from the
 * catalogue's labels alone (src/config/selectedPoolCatalogue.ts): every
 * figure a dash that says it is unavailable, never a number. A read replaces
 * exactly the row whose pool id it answers.
 *
 * The stub serves test data only: package fixtures rewritten to the six
 * selected pool ids, with made-up pairs and symbols. Everything else is the
 * real dist, the real gate and the real read pipeline, and R-1's pacing runs
 * in real time here, so this file is timing-sensitive: rerun it once if it flakes.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeBrowser } from './support/close-browser.mjs';
import { closeContext, leaving, watch } from './page-watch.mjs';
import { DIST, createGatedServer } from '../scripts/gated-server.mjs';

const PASSWORD = 'release-test-beta-password';
const GATE = { BETA_PASSWORD: PASSWORD, BETA_COOKIE_KEY: 'Rk2mP9vQx4Lr7TbW1cNy6ZsJ3dGa8FeU5oViRtYqWeC' };
const RC3 = '1.1.0-rc.3';
const READ = resolve(import.meta.dirname, '../../api-contracts/read-v1/fixtures/gateway');
const fixture = (name) => JSON.parse(readFileSync(join(READ, `${name}.json`), 'utf8'));
const V3_DISABLED = { ...JSON.parse(readFileSync(new URL('../../api-contracts/read-v3/fixtures/capabilities.json', import.meta.url), 'utf8')), dataMode: 'disabled', enabledReads: [] };

/** The pools dist reads, taken from the reviewed config itself: six of them. */
const SELECTED = readFileSync(resolve(import.meta.dirname, '../src/config/selectedPools.ts'), 'utf8').match(/0x[0-9a-f]{64}/g);
const NATIVE = '0x0000000000000000000000000000000000000000';
const TOKEN_Y = `0x${'22'.repeat(20)}`;
const TOKEN_Z = `0x${'33'.repeat(20)}`;
const TOKEN_W = `0x${'44'.repeat(20)}`;
/**
 * Test pairs on the six pool ids, four tokens between them, so the shared
 * ones are read once. Not the pools' real pairs: only reads establish those.
 */
const PAIRS = {
  [SELECTED[0]]: [NATIVE, TOKEN_Y],
  [SELECTED[1]]: [TOKEN_Y, TOKEN_Z],
  [SELECTED[2]]: [NATIVE, TOKEN_Z],
  [SELECTED[3]]: [TOKEN_Y, TOKEN_W],
  [SELECTED[4]]: [NATIVE, TOKEN_W],
  [SELECTED[5]]: [TOKEN_Z, TOKEN_W],
};
const SYMBOLS = { [TOKEN_Y]: 'TKY', [TOKEN_Z]: 'TKZ', [TOKEN_W]: 'TKW' };
/**
 * Each row's label, from the token reads. Changed on purpose 2026-10-01 (audit E21): in the order the row's price is
 * written (lib/read/orientation.ts pricePair, "1 TKY = … ETH" beside "TKY/ETH"), no longer the pool's own order; a pool
 * of two ordinary tokens keeps the pool's order.
 */
const LABELS = ['TKY/ETH', 'TKY/TKZ', 'TKZ/ETH', 'TKY/TKW', 'TKW/ETH', 'TKZ/TKW'];
/**
 * The tokens a set of rows reads, in order: each token of each pool whose row
 * is on screen, in table order, once. A pool whose market read failed has no
 * tokens to read.
 */
function tokenWire(pools = SELECTED) {
  const wire = [];
  const read = new Set();
  for (const poolId of pools) {
    for (const token of PAIRS[poolId]) {
      if (read.has(token)) continue;
      read.add(token);
      wire.push('POST token');
    }
  }
  return wire;
}
/**
 * The lean load, in order: each pool's market without price history, its row on screen as it answers, then the
 * tokens that row still needs, so the rows complete one by one (#138 §5). A pool that `failed` reads no tokens; one
 * `busy` after R-1 was asked three times, and reads none either.
 */
function loadWire(failed = [], busy = []) {
  const wire = [];
  const read = new Set();
  for (const poolId of SELECTED) {
    wire.push(...Array(busy.includes(poolId) ? 3 : 1).fill('POST pool-market'));
    if (failed.includes(poolId) || busy.includes(poolId)) continue;
    for (const token of PAIRS[poolId]) {
      if (read.has(token)) continue;
      read.add(token);
      wire.push('POST token');
    }
  }
  return wire;
}
const LOAD = loadWire();
const TOKENS_IN_ORDER = [NATIVE, TOKEN_Y, TOKEN_Z, TOKEN_W];
/** What production's read capabilities list today: the seven public reads, and none of the optional routes. */
const PRODUCTION_READS = ['token', 'pools', 'pool-market', 'wallet-assets', 'nft-positions', 'catalogue', 'pool-activity'];
const listing = (enabledReads) => ({ ...fixture('capabilities.live_read_only'), enabledReads });

if (!existsSync(join(DIST, 'index.html'))) {
  throw new Error('dist/index.html is missing. Run `npm run build` before this test.');
}

assert.equal(SELECTED.length, 6, 'the reviewed selection is six pools');
// ETH/TKY reads both its tokens, TKY/TKZ reads TKZ, ETH/TKZ nothing new, TKY/TKW reads TKW, and the last two nothing new.
assert.deepEqual(LOAD, ['POST pool-market', 'POST token', 'POST token', 'POST pool-market', 'POST token', 'POST pool-market', 'POST pool-market', 'POST token', 'POST pool-market', 'POST pool-market']);

function marketFor(poolId) {
  const body = fixture('pool-market.not-requested');
  const currencies = PAIRS[poolId];
  body.poolId = poolId;
  body.pool.poolId = poolId;
  body.pool.currencies = currencies;
  body.pool.poolKey.currency0 = currencies[0];
  body.pool.poolKey.currency1 = currencies[1];
  body.market.data.poolId = poolId;
  body.market.data.currencies = currencies;
  body.market.data.baseToken = currencies[1];
  body.market.data.quoteToken = currencies[0];
  return body;
}

/** Another package fixture of the pool-market route, rewritten to one selected pool the same way. */
function marketVariant(poolId, name) {
  const body = fixture(`pool-market.${name}`);
  // The table asks with includePriceHistory: false, and an answer carrying history would be refused as
  // not about that request, so the variant answers it the way not-requested does.
  body.priceHistory = fixture('pool-market.not-requested').priceHistory;
  const currencies = PAIRS[poolId];
  body.poolId = poolId;
  body.pool.poolId = poolId;
  body.pool.currencies = currencies;
  body.pool.poolKey.currency0 = currencies[0];
  body.pool.poolKey.currency1 = currencies[1];
  if (body.market.data) {
    body.market.data.poolId = poolId;
    body.market.data.currencies = currencies;
    body.market.data.baseToken = currencies[1];
    body.market.data.quoteToken = currencies[0];
  }
  return body;
}

/** pool-metrics' qualified fixture, answering for one selected pool. */
function metricsFor(poolId) {
  const body = fixture('pool-metrics.qualified');
  body.poolId = poolId;
  if (body.coverage && 'poolId' in body.coverage) body.coverage.poolId = poolId;
  return body;
}

/** The read service's stored snapshot holding these pools, from their rewritten market reads, fresh, as an answer to the six ids. */
function snapshotFor(pools) {
  const body = fixture('markets-snapshot.subset');
  body.requested = SELECTED;
  body.pools = pools.map((poolId) => {
    const read = marketFor(poolId);
    return { poolId, pool: read.pool, market: read.market, observedAt: body.builtAt };
  });
  return body;
}

function tokenFor(address) {
  if (address === NATIVE) return fixture('token.native');
  const body = fixture('token.success');
  body.asset.address = address;
  body.asset.symbol = SYMBOLS[address];
  return body;
}

const json = (status, body, headers = {}) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers } });
/** A reply the bridge authors: always with the contract header. */
const bridge = (status, body, headers = {}) => json(status, body, { 'X-Domino-Read-Contract': RC3, ...headers });

/** The bridge, stubbed: the capabilities given (production's by default), and each POST from the rewritten fixtures unless `reply` answers it. */
function bridgeStub({ capabilities = listing(PRODUCTION_READS), reply = () => undefined } = {}) {
  return async (request) => {
    const path = new URL(request.url).pathname;
    // The additive stored namespace is disabled here so these scenarios exercise the legacy reads.
    if (path === '/api/read/v3/capabilities' && request.method === 'GET') return json(200, V3_DISABLED, { 'X-Domino-Read-Contract': V3_DISABLED.contractVersion });
    if (path === '/api/read/v2/capabilities') return json(404, { error: 'not_found' });
    const route = path.replace('/api/read/v1/', '');
    if (request.method === 'GET' && route === 'capabilities') return bridge(200, capabilities);
    const body = JSON.parse(await request.text());
    const custom = await reply(route, body);
    if (custom) return custom;
    if (route === 'pool-market') return bridge(200, marketFor(body.poolId));
    if (route === 'token') return bridge(200, tokenFor(body.token));
    return bridge(404, { error: 'route_not_available' });
  };
}

/** The forwarder's own refusal: JSON, no contract header, exactly as #80 writes it. */
const forwarder = (status, code) => async () => json(status, `{"error":"${code}"}`);

let handler = bridgeStub();
/** Every request the gate let through to /api, as it arrived there, with the time it arrived. */
let reads = [];
/** Every request the browser sent to /api, before the gate, whether the gate let it through or not. */
let edge = [];
/**
 * Added 2026-10-01 (audit I3): DEX Screener asked through our own edge (functions/api/read/dex, its own Pages Function,
 * not the read service's forwarder), for artwork the build does not bundle. Not a read: kept apart from `reads` and
 * `edge`, and answered as an edge that has no pairs for the token, so no test here reaches the provider.
 */
const DEX_PATH = '/api/read/dex/';
let dex = [];

async function api(request) {
  const url = new URL(request.url);
  if (url.pathname.startsWith(DEX_PATH)) {
    dex.push(`${request.method} ${url.pathname}`);
    return json(200, []);
  }
  const body = request.method === 'POST' ? JSON.parse(await request.clone().text()) : null;
  reads.push({ method: request.method, path: url.pathname, body, at: Date.now() });
  return handler(request);
}

function observe(request) {
  const path = new URL(request.url).pathname;
  if (path.startsWith('/api/') && !path.startsWith(DEX_PATH)) edge.push({ method: request.method, path });
}

const LAUNCHES = process.env.DOMINO_BROWSER_PATH
  ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }]
  : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}];

let server;
let origin;
let browser;

before(async () => {
  server = createGatedServer({ env: GATE, api, observe });
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
  await closeBrowser(browser);
  await new Promise((done) => server.close(done));
});

/**
 * A signed-in visitor on the deployable landing, with the given stub behind /api and a fresh log. `onPage` is handed
 * the page before anything loads, for a stub that looks at the page while it answers.
 */
async function visit(stub, { onPage } = {}) {
  handler = stub;
  reads = [];
  edge = [];
  dex = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  onPage?.(page);
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
/**
 * The markets' reads, in order. Changed on purpose (2026-09-26, featured pools v1 §11.1): the page's featured list
 * POST (read-v5), asked before them, is left out here and checked on its own (`listReads`, tests (r) to (u)); the
 * stub answers it route_not_available under another contract, so every test above keeps the embedded list.
 */
const FEATURED_PATH = '/api/read/v5/featured-pools';
const wire = () => reads.filter((r) => r.path !== FEATURED_PATH).map((r) => `${r.method} ${r.path.replace('/api/read/v1/', '').replace('/api/read/v2/', 'v2 ').replace('/api/read/v3/', 'v3 ')}`);
/** The featured list's reads, and where each stood among all the page's reads. */
const listReads = () => reads.flatMap((r, index) => (r.path === FEATURED_PATH ? [{ index, method: r.method, body: r.body }] : []));

/**
 * Home asks a read service that was only busy again on its own, the one read
 * it refused and nothing else, the first time once its Retry-After and at
 * least 4 s have passed since the busy answer, drawn within ±25%: between 3
 * and 5 s (recoverQuietly in marketsProvider.ts). Waiting past the latest of
 * that shows a state is not asked again at all.
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
async function saidQuietly(page, code, title, label = code) {
  const status = statusOf(page);
  assert.equal(await status.getAttribute('data-read-status'), code, label);
  assert.equal(await status.textContent(), title, `${label}: the status is its title alone`);
  assert.deepEqual(
    await status.evaluate((el) => {
      const box = el.getBoundingClientRect();
      return { hidden: box.width <= 1 && box.height <= 1, inside: el.children.length };
    }),
    { hidden: true, inside: 0 },
    `${label}: no status panel on Home`,
  );
  assert.equal(await page.locator('#pools').getByRole('button', { name: /Refresh|Retry|Trying again/ }).count(), 0, `${label}: no Refresh or Retry on Home`);
  assert.equal(await page.locator('#pools').getByRole('link', { name: 'Sign in again' }).count(), 0, `${label}: no sign-in link on Home`);
}

/** The rows a read answered, and the rows still standing on the catalogue's labels alone. */
const liveRows = (page) => page.locator('#pools tbody tr:not([data-pool-catalogue])');
const catalogueRows = (page) => page.locator('#pools tbody tr[data-pool-catalogue]');

/**
 * A failed landing keeps the six catalogue rows, with a dash in every figure
 * cell that says it is unavailable: no figure, no estimate, no dollar text,
 * and nothing called a sample. Nothing stands in for the read.
 */
async function nothingInvented(page, label) {
  const found = await page.evaluate(() => ({
    rows: document.querySelectorAll('#pools tbody tr').length,
    catalogue: document.querySelectorAll('#pools tbody tr[data-pool-catalogue]').length,
    live: document.querySelectorAll('#pools tbody tr:not([data-pool-catalogue])').length,
    metrics: document.querySelectorAll('[data-metric], [data-apr-estimate]').length,
    dashes: Array.from(document.querySelectorAll('#pools tbody tr[data-pool-catalogue] td')).filter((td) => td.innerText.trim() === '—').length,
    unavailable: Array.from(document.querySelectorAll('#pools tbody tr[data-pool-catalogue] [aria-label]')).map((el) => el.getAttribute('aria-label')).filter((text) => /^(Price|TVL|24h volume|Pool APR) unavailable$/.test(text)).length,
    dollars: /\$\s?\d/.test(document.querySelector('#pools').innerText),
    sample: /sample|practice/i.test(document.body.innerText),
  }));
  assert.deepEqual(found, { rows: 6, catalogue: 6, live: 0, metrics: 0, dashes: 24, unavailable: 24, dollars: false, sample: false }, label);
}

/** The strip lists the six catalogue pools by their labels, an APR dash each, and no figure. */
async function tickerFromCatalogue(page, label) {
  const items = page.locator('.dm-marquee > a[data-pool-catalogue]');
  assert.equal(await items.count(), 6, `${label}: the ticker lists the six catalogue pools`);
  for (const text of await items.allInnerTexts()) assert.match(text, /Est\. APR —$/, `${label}: the ticker names no APR, in the words a read row without an estimate has`);
  assert.equal(await page.locator('[data-ticker] [data-metric], [data-ticker] [data-apr-estimate]').count(), 0, `${label}: no figure in the ticker`);
  assert.doesNotMatch(await page.locator('[data-ticker]').innerText(), /\$\s?\d|\d%\s*est/, `${label}: no figure in the ticker`);
}

test('(a) no bridge behind the forwarder: live data is not connected, one capabilities GET per attempted namespace, no POST, no Retry, and the ticker shows no figure either', async () => {
  const { context, page, errors } = await visit(forwarder(503, 'bridge_unavailable'));
  try {
    assert.equal(await settled(page), 'not_connected');
    await saidQuietly(page, 'not_connected', 'Live data unavailable');
    await nothingInvented(page, 'not connected');
    await tickerFromCatalogue(page, 'not connected');
    await page.waitForTimeout(PAST_BUSY_RECOVERY_MS);
    // The stored capabilities refusal permits the legacy check; that refusal ends the load before the estimate namespace is asked.
    assert.deepEqual(wire(), ['GET v3 capabilities', 'GET capabilities'], 'each namespace asked once, and never again on its own, not even when a busy service would have been');
    // Added 2026-10-01 (audit I3): artwork the build does not bundle is asked through our own edge, one token a GET,
    // each token once; nothing else of DEX Screener while live data is not connected.
    assert.ok(dex.every((line) => /^GET \/api\/read\/dex\/token-pairs\/0x[0-9a-f]{40}$/.test(line)), dex.join(', '));
    assert.equal(new Set(dex).size, dex.length, 'each token asked once');
    assert.deepEqual(errors, []);
  } finally {
    await closeContext(context);
  }
});

test('(b) a forwarder that does not serve this address, as on a preview host: said so, one capabilities GET per attempted namespace, no POST', async () => {
  const { context, page } = await visit(forwarder(404, 'not_found'));
  try {
    assert.equal(await settled(page), 'not_connected');
    await saidQuietly(page, 'not_connected', "Live data isn't available here");
    await nothingInvented(page, 'not found');
    assert.deepEqual(wire(), ['GET v3 capabilities', 'GET capabilities']);
  } finally {
    await closeContext(context);
  }
});

test('(c) live reads switched off on the server, or the pool route not listed: said so, and nothing posted', async () => {
  for (const [label, capabilities, expected] of [
    ['data mode disabled', fixture('capabilities.disabled'), ['GET v3 capabilities', 'GET capabilities']],
    ['no reads enabled', listing([]), ['GET v3 capabilities', 'GET capabilities']],
    // Reads are on, so the pools are asked for, through the estimate namespace first: the route is refused before any POST.
    ['pool-market not enabled', listing(['token']), ['GET v3 capabilities', 'GET capabilities', 'GET v2 capabilities']],
  ]) {
    const { context, page } = await visit(bridgeStub({ capabilities }));
    try {
      assert.equal(await settled(page), 'disabled', label);
      await saidQuietly(page, 'disabled', 'Live data is switched off for now', label);
      await nothingInvented(page, label);
      await tickerFromCatalogue(page, label);
      assert.deepEqual(wire(), expected, label);
    } finally {
      await closeContext(context);
    }
  }
});

test('(d) reads enabled: one capabilities GET per namespace and the lean load in order, never pool-metrics; the APR unavailable, figures named with their age; a reload costs the same again', async () => {
  const { context, page, errors } = await visit(bridgeStub());
  try {
    assert.equal(await settled(page), 'none');
    const first = ['GET v3 capabilities', 'GET capabilities', 'GET v2 capabilities', ...LOAD];
    assert.deepEqual(wire(), first);
    assert.deepEqual(reads.filter((r) => r.path.endsWith('/pool-market')).map((r) => r.body), SELECTED.map((poolId) => ({ poolId, includePriceHistory: false })));
    assert.deepEqual(reads.filter((r) => r.path.endsWith('/token')).map((r) => r.body.token), TOKENS_IN_ORDER, 'each shared token is read once');

    const rows = liveRows(page);
    assert.equal(await rows.count(), 6, 'every pool has its read row');
    assert.equal(await catalogueRows(page).count(), 0, 'no row is left on the catalogue alone');
    for (const row of await rows.all()) {
      const text = await row.innerText();
      // The figure itself, and beside it the row's provenance line: the provider, dated by its retrieval age.
      assert.match(text, /\$12\.3K/);
      assert.match(await row.locator('[data-provenance]').getAttribute('data-provenance'), /^Pool verified on-chain at block 700 · Reported by a market data provider, retrieved \d+ s ago$/, 'the figure is the provider’s, dated by its retrieval age');
      assert.doesNotMatch(text, /\bas of\b|updated at/i, 'never "as of" or "updated at": the provider update time is unknown');
      const figures = await row.locator('[data-metric]').evaluateAll((els) => els.map((el) => [el.innerText.trim(), el.getAttribute('data-metric'), el.getAttribute('title')]));
      assert.deepEqual(figures.map(([value, state]) => [value, state]), [['$12.3K', 'provider'], ['$0.00', 'provider']], 'the two provider figures');
      for (const [, , title] of figures) assert.match(title, expect.reportedByProvider, 'each figure carries its provenance');
      // The price is the pool's own ratio from chain state: its own attribute, never a figure one.
      const price = row.locator('td').nth(1);
      assert.equal(await price.locator('[data-pool-price]').getAttribute('data-pool-price'), 'usable');
      assert.equal(await price.locator('[data-metric], [data-apr-estimate]').count(), 0, 'the price carries no figure attribute');
      assert.doesNotMatch(await price.innerText(), /\$/, 'a ratio between two tokens, never dollars');
      const apr = row.locator('td').nth(4);
      // Without an estimate the cell shows the same dash as a catalogue row; the reason stays in its title.
      assert.equal(await apr.innerText(), '—');
      assert.equal(await apr.locator('[data-apr-estimate]').getAttribute('data-apr-estimate'), 'unavailable', 'no APR is provided, so none is shown');
      assert.match(await apr.locator('[title]').getAttribute('title'), /Pool estimate, not position APR, APY or a return forecast\. Estimated APR is (not enabled on this connection|unavailable; market figures use the supported read connection)\./, 'and says why');
    }
    // The stub reports each pool the provider's way round (base = currency1): the label is the app's own, the way the
    // row's price is written (E21, 2026-10-01), whatever the provider's order.
    for (const [index, label] of LABELS.entries()) {
      assert.equal(await rows.nth(index).locator('td').first().locator('span.font-medium').innerText(), label, 'symbols come from the token reads, in the order the price is written');
    }
    // And the price with the read decimals (ETH 18, TKY 6). Changed on purpose 2026-09-27 (r6/marketsdata, the owner's
    // plain-price rule): one of a token, so much of the other, the way round that reads as 1 or more. Changed on purpose
    // 2026-09-28 (one-sided): a token's price in ETH, the app's one way round (lib/read/orientation.ts).
    assert.equal((await rowView(rows.nth(0))).price.text, '1 TKY = 0.000000000001 ETH');
    assert.equal(await page.locator('a[href*="geckoterminal"]').count(), 0, 'sourceUrl is never linked');
    // #93: the headers name who reported each figure, on a phone as on a laptop; the ratio is Domino's; the estimate says what it is.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const heads = await page.locator('#pools thead th').evaluateAll((ths) => ths.map((th) => th.innerText.replace(/\s+/g, ' ').trim()));
      assert.deepEqual(heads, ['Pool', 'Price', 'TVL reported by a market data provider', '24h volume reported by a market data provider', 'APR', 'Details'], `${width}px`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.doesNotMatch(await page.locator('body').innerText(), /geckoterminal\.com/i, 'nor shown');
    assert.match(await rows.nth(1).innerText(), /TKY[\s\S]*TKZ/);
    const ticker = await page.locator('.dm-marquee').innerText();
    assert.match(ticker, /TKZ[\s\S]*Est\. APR —/, 'the ticker shows the same result set');
    assert.doesNotMatch(ticker, /APR unavailable/, 'one label for a pool without an APR figure, read or not');
    assert.equal(await page.locator('.dm-marquee > a[data-pool-catalogue]').count(), 0, 'and no catalogue-only item');
    const aprStates = await page.locator('.dm-marquee [data-apr-estimate]').evaluateAll((els) => els.map((el) => el.getAttribute('data-apr-estimate')));
    assert.ok(aprStates.length >= 6 && aprStates.every((state) => state === 'unavailable'), `and no APR figure: ${aprStates}`);
    const aprTitles = await page.locator('.dm-marquee [data-apr-estimate] [title]').evaluateAll((els) => els.map((el) => el.getAttribute('title')));
    assert.ok(aprTitles.every((title) => /^Pool estimate, not position APR, APY or a return forecast\. Estimated APR is /.test(title)), `the reason is in the title: ${aprTitles}`);

    leaving(page);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await settled(page), 'none');
    assert.deepEqual(wire(), [...first, ...first], 'a reload reads everything again: nothing outlives the page');
    assert.deepEqual(errors, []);
  } finally {
    await closeContext(context);
  }
});

/** The provenance every value cell carries in its title, in the table's own words. */
const expect = {
  reportedByProvider: /^Reported by a market data provider, retrieved \d+ s ago\. Not reconciled by Domino\.$/,
};

test('(e) the pool route switched off between the GET and the first POST: said so, and the second pool is never asked', async () => {
  const { context, page } = await visit(bridgeStub({ reply: (route) => (route === 'pool-market' ? bridge(404, { error: 'route_not_available' }) : undefined) }));
  try {
    assert.equal(await settled(page), 'disabled');
    await saidQuietly(page, 'disabled', 'Live data is switched off for now');
    await nothingInvented(page, 'route switched off');
    assert.deepEqual(wire(), ['GET v3 capabilities', 'GET capabilities', 'GET v2 capabilities', 'POST pool-market']);
  } finally {
    await closeContext(context);
  }
});

test('(f) a producer 503: temporarily unavailable, with no Retry on Home, never asked again on its own; a reload reads again', async () => {
  let down = true;
  const { context, page } = await visit(bridgeStub({ reply: (route) => (route === 'pool-market' && down ? bridge(503, { error: 'upstream_unavailable' }) : undefined) }));
  try {
    assert.equal(await settled(page), 'unavailable');
    // The read service's own words ("answered: read service unavailable") are the read lab's to show now.
    await saidQuietly(page, 'unavailable', 'Temporarily unavailable');
    await nothingInvented(page, 'producer 503');
    await tickerFromCatalogue(page, 'producer 503');
    const failed = wire();
    assert.deepEqual(failed, ['GET v3 capabilities', 'GET capabilities', 'GET v2 capabilities', ...SELECTED.map(() => 'POST pool-market')], 'each pool asked once');
    await page.waitForTimeout(PAST_BUSY_RECOVERY_MS);
    assert.deepEqual(wire(), failed, 'and none asked again on its own, not even when a busy service would have been');

    // With no Retry on Home, a reload is how a person asks again.
    down = false;
    leaving(page);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await settled(page), 'none');
    assert.deepEqual(wire().slice(failed.length), ['GET v3 capabilities', 'GET capabilities', 'GET v2 capabilities', ...LOAD], 'one reload, one lean load after the capabilities');
    assert.equal(await liveRows(page).count(), 6);
    assert.equal(await catalogueRows(page).count(), 0);
  } finally {
    await closeContext(context);
  }
});

test('(g) a 429 read_capacity_busy is asked again under R-1 after its Retry-After, and the rows come', async () => {
  let busy = 1;
  const { context, page } = await visit(
    bridgeStub({ reply: (route) => (route === 'pool-market' && busy-- > 0 ? bridge(429, { error: 'read_capacity_busy' }, { 'Retry-After': '1' }) : undefined) }),
  );
  try {
    assert.equal(await settled(page), 'none');
    assert.deepEqual(wire(), ['GET v3 capabilities', 'GET capabilities', 'GET v2 capabilities', 'POST pool-market', ...LOAD], 'one automatic retry, then the lean load');
    assert.equal(await liveRows(page).count(), 6);
  } finally {
    await closeContext(context);
  }
});

test('(h) without the access cookie a read is the gate’s 401: beta access needed, nothing reaches the bridge, the last rows stay, marked stale, and the gate is not asked again on its own', async () => {
  // Home has no Refresh, so the read after the cookie is gone is the one Home makes on its own: the second
  // pool's read service is still busy after R-1 on the first load, and the table asks again once its wait has passed.
  const { context, page } = await visit(
    bridgeStub({ reply: (route, body) => (route === 'pool-market' && body.poolId === SELECTED[1] ? bridge(429, { error: 'read_capacity_busy' }, { 'Retry-After': '1' }) : undefined) }),
  );
  try {
    assert.equal(await settled(page), 'partial');
    assert.equal(await liveRows(page).count(), 5);
    await context.clearCookies();
    const before = reads.length;
    const knocked = edge.length;
    await statusIs(page, 'gate_required');
    // The way back ("Sign in again") is the read lab's to show now; Home says only that access is needed.
    await saidQuietly(page, 'gate_required', 'Access expired');
    assert.equal(reads.length, before, 'the gate refused the read: nothing reached the bridge');
    assert.deepEqual(edge.slice(knocked).map((r) => `${r.method} ${r.path}`), ['POST /api/read/v1/pool-market'], 'the gate’s 401 stopped the load at its first read');
    assert.equal(await liveRows(page).count(), 5, 'the last good rows stay');
    const states = await page.locator('#pools tbody [data-metric]').evaluateAll((els) => els.map((el) => el.getAttribute('data-metric')));
    assert.ok(states.includes('stale') && !states.includes('provider') && !states.includes('calculated'), `retained rows read as current: ${states}`);
    const refused = edge.length;
    await page.waitForTimeout(PAST_BUSY_RECOVERY_MS);
    assert.equal(edge.length, refused, 'the gate’s answer is never asked again on its own');
  } finally {
    await closeContext(context);
  }
});

/**
 * One row's cells and provenance, as a reader sees them: the pool's price (its own ratio, with its state), then
 * the three figures after it (TVL, 24h volume, APR), with the state and title of each.
 */
async function rowView(row) {
  const [price, ...cells] = await row.locator('td').evaluateAll((tds) => tds.slice(1, 5).map((td) => {
    const el = td.querySelector('[data-metric], [data-apr-estimate], [data-pool-price]');
    return {
      text: td.innerText.replace(/\s+/g, ' ').trim(),
      metric: el?.getAttribute('data-metric') ?? el?.getAttribute('data-apr-estimate') ?? null,
      state: el?.getAttribute('data-pool-price') ?? null,
      title: el?.getAttribute('title') ?? el?.querySelector('[title]')?.getAttribute('title') ?? null,
    };
  }));
  return {
    pair: await row.locator('td').first().locator('span.font-medium').innerText(),
    provenance: await row.locator('[data-provenance]').getAttribute('data-provenance'),
    price,
    cells,
  };
}

/**
 * A pool that failed keeps its catalogue row, dashes only, and nothing called
 * a sample stands in for it; every other row has its read figures and no more.
 */
async function nothingStandsIn(page, liveCount) {
  const text = await page.locator('#pools').innerText();
  assert.doesNotMatch(text, /sample|practice|placeholder/i);
  assert.equal(await liveRows(page).count(), liveCount);
  assert.equal(await liveRows(page).locator('[data-metric]').count(), liveCount * 2, 'two figures a read row, no more');
  assert.equal(await liveRows(page).locator('[data-apr-estimate]').count(), liveCount, 'and one APR estimate cell each');
  assert.equal(await liveRows(page).locator('td:nth-child(2) [data-pool-price]').count(), liveCount, 'and the pool’s price in its own cell');
  assert.equal(await liveRows(page).locator('td:nth-child(2) [data-metric]').count(), 0, 'which is never a figure');
  const fallen = catalogueRows(page);
  assert.equal(await fallen.count(), 6 - liveCount, 'the failed pool falls back to its catalogue labels');
  assert.equal(await fallen.locator('[data-metric], [data-apr-estimate]').count(), 0, 'with no figure at all');
  for (const row of await fallen.all()) {
    assert.deepEqual(await row.locator('td').evaluateAll((tds) => tds.slice(1, 5).map((td) => td.innerText.trim())), ['—', '—', '—', '—']);
  }
}

test('(i) #93 per row: provider figures dated only by retrieval; a rejected pool keeps its verified row with its metrics unavailable, and the other rows are untouched', async () => {
  const { context, page, errors } = await visit(
    bridgeStub({ reply: (route, body) => (route === 'pool-market' && body.poolId === SELECTED[1] ? bridge(200, marketVariant(SELECTED[1], 'rejected-currencies')) : undefined) }),
  );
  try {
    assert.equal(await settled(page), 'none', 'a rejected provider observation is a valid read, not a failure');
    assert.deepEqual(wire(), ['GET v3 capabilities', 'GET capabilities', 'GET v2 capabilities', ...LOAD], 'the rejected pool still reads its tokens, so its row is labelled from them');
    const rows = liveRows(page);
    assert.equal(await rows.count(), 6);

    const ok = await rowView(rows.nth(0));
    assert.equal(ok.pair, 'TKY/ETH', 'as its price is written (E21)');
    assert.match(ok.provenance, /^Pool verified on-chain at block 700 · Reported by a market data provider, retrieved \d+ s ago$/);
    assert.deepEqual(ok.cells.map((c) => c.metric), ['provider', 'provider', 'unavailable']);
    assert.equal(ok.cells[0].text, '$12.3K', 'the figure alone in the cell; the row’s provenance and the cell’s title say it is a provider’s');
    assert.match(ok.cells[0].title, expect.reportedByProvider);
    assert.equal(ok.cells[1].text, '$0.00');
    assert.match(ok.cells[1].title, expect.reportedByProvider);
    assert.equal(ok.cells[2].text, '—', 'APR unavailable, never an estimate: the same dash as a catalogue row');
    // The price comes from the verified pool's own state, not from the provider.
    assert.equal(ok.price.state, 'usable');
    assert.equal(ok.price.metric, null);

    const rejected = await rowView(rows.nth(1));
    assert.equal(rejected.pair, 'TKY/TKZ', 'the verified pool row stays, labelled from its own token reads');
    assert.equal(rejected.provenance, 'Pool verified on-chain at block 700 · Provider figures rejected: provider data did not match this pool');
    assert.deepEqual(rejected.cells.map((c) => [c.text, c.metric]), [['Unavailable', 'rejected'], ['Unavailable', 'rejected'], ['—', 'unavailable']]);
    assert.equal(rejected.price.state, 'usable', 'a rejected provider observation takes nothing from the chain’s own price');

    for (const index of [2, 3, 4, 5]) {
      const other = await rowView(rows.nth(index));
      assert.equal(other.pair, LABELS[index]);
      assert.deepEqual(other.cells.map((c) => c.metric), ['provider', 'provider', 'unavailable'], `row ${index} is untouched`);
    }

    assert.doesNotMatch(await page.locator('#pools').innerText(), /\bas of\b|updated at/i);
    assert.equal(await page.locator('a[href*="geckoterminal"]').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await closeContext(context);
  }
});

test('(j) #93 per row: a stale observation is marked stale in its state and its title, in the ink of a current figure with no word beside it, and a null figure is not reported, never $0', async () => {
  const missing = fixture('pool-market.missing').market.data;
  assert.deepEqual([missing.reportedLiquidityUsd, missing.volume24hUsd], [null, null], 'the package fixture reports both as null');
  const variant = { [SELECTED[0]]: 'stale', [SELECTED[1]]: 'missing' };
  const { context, page } = await visit(bridgeStub({ reply: (route, body) => (route === 'pool-market' && variant[body.poolId] ? bridge(200, marketVariant(body.poolId, variant[body.poolId])) : undefined) }));
  try {
    assert.equal(await settled(page), 'none');
    const rows = liveRows(page);
    assert.equal(await rows.count(), 6);

    const stale = await rowView(rows.nth(0));
    assert.match(stale.provenance, /^Pool verified on-chain at block 700 · Reported by a market data provider, retrieved \d+ s ago · stale$/);
    assert.deepEqual(stale.cells.slice(0, 2).map((c) => c.metric), ['stale', 'stale']);
    // The owner's decision on the redesign: a stale figure is never yellow and has no "· stale" beside it. That it
    // is stale is its state, and its title in words.
    assert.equal(stale.cells[0].text, '$12.3K', 'no stale word beside the figure');
    assert.match(stale.cells[0].title, /^Reported by a market data provider, retrieved \d+ s ago\. Not reconciled by Domino\. Stale, not current\.$/);
    assert.equal(stale.cells[1].text, '$0.00');
    assert.match(stale.cells[1].title, /^Reported by a market data provider, retrieved \d+ s ago\. Not reconciled by Domino\. Stale, not current\.$/);

    const nulls = await rowView(rows.nth(1));
    const notReported = ['Not reported by the provider', 'absent'];
    assert.deepEqual(nulls.cells.map((c) => [c.text, c.metric]), [notReported, notReported, ['—', 'unavailable']], 'unavailable, said as the provider that reported null; no estimate is a dash');
    assert.equal(nulls.cells[0].title, 'Unavailable: the market data provider reported no value');
    assert.doesNotMatch(await rows.nth(1).innerText(), /\$\s*0|\b0\.00\b/, 'null never renders as zero');

    const current = await rowView(rows.nth(2));
    assert.deepEqual(current.cells.map((c) => c.metric), ['provider', 'provider', 'unavailable'], 'the other rows stay current');
    const ink = (row) => row.locator('[data-metric]').evaluateAll((els) => els.slice(0, 2).map((el) => getComputedStyle(el).color));
    assert.deepEqual(await ink(rows.nth(0)), await ink(rows.nth(2)), 'a stale figure is drawn in the same ink as a current one');
  } finally {
    await closeContext(context);
  }
});

test('(k) #93 per row: a 504 on one pool drops only that pool, whose own row says so, and is not asked again on its own', async () => {
  const { context, page } = await visit(
    bridgeStub({ reply: (route, body) => (route === 'pool-market' && body.poolId === SELECTED[0] ? bridge(504, { error: 'upstream_timeout' }) : undefined) }),
  );
  try {
    assert.equal(await settled(page), 'partial');
    const rows = liveRows(page);
    assert.equal(await rows.count(), 5, 'the other pools keep their rows');
    const other = await rowView(rows.nth(0));
    assert.equal(other.pair, 'TKY/TKZ');
    assert.equal(other.cells[0].text, '$12.3K');
    // Home no longer names the failed pool and its route in a status line (that is the read lab's now): the
    // status is its title alone, and the failed pool's own row says its data is not available, below.
    await saidQuietly(page, 'partial', 'Some pool data could not be read');
    const settledWire = wire();
    assert.deepEqual(settledWire, ['GET v3 capabilities', 'GET capabilities', 'GET v2 capabilities', ...loadWire([SELECTED[0]])], 'the failed pool reads no tokens; the others read theirs');
    await page.waitForTimeout(PAST_BUSY_RECOVERY_MS);
    assert.deepEqual(wire(), settledWire, 'nothing asked again on its own: a timeout is not a busy service');
    await nothingStandsIn(page, 5);
    // The failed pool's row is the catalogue's, which says so.
    assert.equal(await catalogueRows(page).first().locator('a').first().getAttribute('title'), 'Listed on Uniswap. Pool figures are unavailable.');
  } finally {
    await closeContext(context);
  }
});

// Changed on purpose 2026-10-03 (the owner): the footer's Pause motion control is gone, so check (m), that it covered no
// figure or text with all six pools on screen, has nothing left to check.

test('(l) #93 per row: a 429 that outlasts R-1 on one pool leaves the other pools’ rows, and Home asks that pool again on its own, alone, once the wait has passed', async () => {
  let busy = true;
  const { context, page } = await visit(
    bridgeStub({ reply: (route, body) => (route === 'pool-market' && busy && body.poolId === SELECTED[1] ? bridge(429, { error: 'read_capacity_busy' }, { 'Retry-After': '1' }) : undefined) }),
  );
  try {
    assert.equal(await settled(page), 'partial');
    // The load's last request: its answer, and so the busy state, came after it. Timed on this side, however slow the page is to report.
    const loadEnded = reads.at(-1).at;
    const busyPool = (r) => r.path.endsWith('/pool-market') && r.body?.poolId === SELECTED[1];
    const attempts = reads.filter(busyPool).length;
    assert.ok(attempts >= 1 && attempts <= 3, `the busy pool is asked at most three times under R-1 (${wire()})`);
    // Every other read in its place: each row's tokens right after its market read, the busy pool reading none.
    assert.deepEqual(
      reads.filter((r) => !busyPool(r) && r.path !== FEATURED_PATH).map((r) => `${r.method} ${r.path.replace('/api/read/v1/', '').replace('/api/read/v2/', 'v2 ').replace('/api/read/v3/', 'v3 ')}`),
      ['GET v3 capabilities', 'GET capabilities', 'GET v2 capabilities', ...loadWire([SELECTED[1]]).filter((line, index) => !(line === 'POST pool-market' && index === 3))],
    );
    const rows = liveRows(page);
    assert.equal(await rows.count(), 5);
    assert.equal((await rowView(rows.nth(0))).pair, 'TKY/ETH');
    // Which pool was busy is the read lab's to say now; Home says only that some pool data could not be read.
    await saidQuietly(page, 'partial', 'Some pool data could not be read');
    await nothingStandsIn(page, 5);

    // Busy was all that went wrong, and Home has no Retry, so Home asks again on its own: not before the
    // service's wait and 4 s (within ±25%) have passed, and only the read that was busy. The busy pool's row comes.
    const first = reads.length;
    // The markets' own reads so far (wire() leaves the featured list's out).
    const firstWire = wire().length;
    busy = false;
    await page.waitForFunction(
      () => document.querySelector('#pools [data-read-status]')?.getAttribute('data-read-status') === 'none' && document.querySelectorAll('#pools tbody tr[data-pool-catalogue]').length === 0,
      null,
      { timeout: 30_000 },
    );
    // The capabilities answer and every token's metadata were read on the first load and are kept for the page.
    assert.deepEqual(wire().slice(firstWire), ['POST pool-market'], 'asked again once, on its own: that pool’s market read alone, with the capabilities and token answers kept');
    assert.deepEqual(reads[first].body, { poolId: SELECTED[1], includePriceHistory: false });
    assert.ok(reads[first].at - loadEnded >= EARLIEST_BUSY_RECOVERY_MS - 100, `asked again ${reads[first].at - loadEnded} ms after the busy answer, before its wait had passed`);
    assert.equal(await liveRows(page).count(), 6);
    assert.equal((await rowView(liveRows(page).nth(1))).pair, 'TKY/TKZ', 'the row that came back is named from the kept token metadata');
    await saidQuietly(page, 'none', '');
    await page.waitForTimeout(PAST_BUSY_RECOVERY_MS);
    assert.deepEqual(wire().slice(firstWire), ['POST pool-market'], 'and nothing more once every pool has its row');
  } finally {
    await closeContext(context);
  }
});

test('(n) pool-metrics listed: the lean load, then one pool-metrics read a row; qualified figures in the cells, the ticker and the figures dialog', async () => {
  const { context, page, errors } = await visit(
    bridgeStub({ capabilities: listing([...PRODUCTION_READS, 'pool-metrics']), reply: (route, body) => (route === 'pool-metrics' ? bridge(200, metricsFor(body.poolId)) : undefined) }),
  );
  try {
    assert.equal(await settled(page), 'none');
    assert.deepEqual(wire(), ['GET v3 capabilities', 'GET capabilities', 'GET v2 capabilities', ...LOAD, ...SELECTED.map(() => 'POST pool-metrics')], 'listing it is the consent: one read a row, after the rows and their tokens');
    assert.deepEqual(reads.filter((r) => r.path.endsWith('/pool-metrics')).map((r) => r.body), SELECTED.map((poolId) => ({ poolId })));
    const rows = liveRows(page);
    assert.equal(await rows.count(), 6);
    for (const row of await rows.all()) {
      const view = await rowView(row);
      // Changed on purpose 2026-10-01 (integration pass 3, after the copy workstream's audit E21): the table's APR follows the
      // one APR rule of every screen too, whole percents from 100%, as the ticker below already did.
      assert.deepEqual(view.cells.map((c) => [c.text, c.metric]), [['$0.000020', 'qualified'], ['$0.000029', 'qualified'], ['158%', 'qualified']], 'Domino’s qualified figures, its APR where the estimate would be');
      assert.match(view.provenance, /^Pool verified on-chain at block 700 · Reported by a market data provider, retrieved \d+ s ago · Domino history fresh, 10 s$/);
      assert.equal(await row.locator('[data-apr-estimate]').count(), 0, 'no estimate beside a qualified APR');
    }
    const heads = await page.locator('#pools thead th').evaluateAll((ths) => ths.map((th) => th.innerText.replace(/\s+/g, ' ').trim()));
    assert.deepEqual(heads.slice(2, 4), ['TVL', '24h volume'], 'no provider named in the headers of figures that are not the provider’s');

    // The ticker shows the same APR, in its own ink and never yellow, and no estimate beside it.
    const items = page.locator('.dm-marquee > a');
    assert.equal(await items.count(), 6);
    const aprs = await items.evaluateAll((els) => els.map((el) => {
      const apr = el.querySelector('[data-metric]');
      return [apr?.innerText.trim(), apr?.getAttribute('data-metric'), apr?.getAttribute('style'), el.querySelectorAll('[data-apr-estimate]').length];
    }));
    // Changed on purpose 2026-10-01 (audit E21): the one APR rule of every screen: whole percents from 100%.
    for (const apr of aprs) assert.deepEqual(apr, ['158% APR', 'qualified', 'color: var(--money-in);', 0]);
    assert.doesNotMatch(await page.locator('[data-ticker]').innerHTML(), /money-wait/);

    // The figures dialog names the history behind the APR: its 24h LP fees and time-weighted TVL.
    await rows.first().locator('[data-pool-figures]').click();
    const dialog = page.locator('[data-pool-figures-dialog]');
    await dialog.waitFor();
    const qualified = dialog.locator('[data-figures-qualified="yes"]');
    await qualified.waitFor();
    const facts = await qualified.locator('dl > div').evaluateAll((divs) => divs.map((div) => [div.querySelector('dt').innerText.trim(), div.querySelector('dd').innerText.trim()]));
    // Changed on purpose 2026-10-01 (integration pass 3, after audit E21): the dialog's Pool APR follows the one APR rule too.
    assert.deepEqual(facts, [['TVL', '$0.000020'], ['24h volume', '$0.000029'], ['24h LP fees', '<$0.000001'], ['Time-weighted TVL', '$0.000020'], ['Pool APR', '158%']]);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
  } finally {
    await closeContext(context);
  }
});

test('(o) markets-snapshot listed: one snapshot read puts all six rows on screen before any token read, and fresh stored rows need no market read', async () => {
  let watched = null;
  /** The table as it stood when the first token read reached the bridge, before any token was answered. */
  let atFirstToken = null;
  const { context, page, errors } = await visit(
    bridgeStub({
      capabilities: listing([...PRODUCTION_READS, 'markets-snapshot']),
      reply: async (route) => {
        if (route === 'markets-snapshot') return bridge(200, snapshotFor(SELECTED));
        if (route === 'token' && atFirstToken === null) {
          atFirstToken = { wire: wire(), rows: await watched.evaluate(() => Array.from(document.querySelectorAll('#pools tbody tr'), (tr) => [
            tr.getAttribute('data-row-source'),
            Array.from(tr.querySelectorAll('[data-metric], [data-apr-estimate], [data-pool-price]'), (el) => el.getAttribute('data-metric') ?? el.getAttribute('data-apr-estimate') ?? el.getAttribute('data-pool-price')),
          ])) };
        }
        return undefined;
      },
    }),
    { onPage: (opened) => { watched = opened; } },
  );
  try {
    assert.equal(await settled(page), 'none');
    assert.deepEqual(atFirstToken.wire, ['GET v3 capabilities', 'GET capabilities', 'POST markets-snapshot', 'POST token'], 'the snapshot was the only read answered when the first token read arrived');
    // Not read yet is not unavailable: the price cell waits quietly for the decimals the token reads bring.
    assert.deepEqual(atFirstToken.rows, SELECTED.map(() => ['markets-snapshot', ['loading', 'provider', 'provider', 'unavailable']]), 'and all six rows were on screen with their stored figures, the price waiting for the decimals the token reads bring');
    const pending = await page.evaluate(() => document.querySelectorAll('#pools [data-pool-price="loading"]').length);
    assert.equal(pending, 0, 'and nothing is left waiting once the reads have settled');
    assert.deepEqual(reads.find((r) => r.path.endsWith('/markets-snapshot')).body, { poolIds: SELECTED }, 'the selected pools, and only them');
    assert.equal(await catalogueRows(page).count(), 0);
    assert.deepEqual(wire(), ['GET v3 capabilities', 'GET capabilities', 'POST markets-snapshot', ...tokenWire()], 'no pool-market read and no estimate namespace');
    const rows = liveRows(page);
    assert.equal(await rows.count(), 6);
    for (const [index, label] of LABELS.entries()) {
      const view = await rowView(rows.nth(index));
      assert.equal(view.pair, label);
      assert.equal(await rows.nth(index).getAttribute('data-row-source'), 'markets-snapshot');
      assert.match(view.provenance, /^Pool verified on-chain at block 700 · Reported by a market data provider, retrieved \d+ s ago$/, 'the usual provenance, dated by the stored retrieval age');
      assert.deepEqual(view.cells.map((c) => [c.text, c.metric]), [['$12.3K', 'provider'], ['$0.00', 'provider'], ['—', 'unavailable']]);
      // G14: an estimate's title comes from its own limitations; a stored row has none, so it says what the figure would be and why it is missing.
      assert.equal(view.cells[2].title, 'Pool estimate, not position APR, APY or a return forecast. Estimated APR is read with the pool’s own market figures, not with stored ones.', 'the estimate cell says what it is and why a stored row has none');
      assert.equal(view.price.state, 'usable');
    }
    assert.doesNotMatch(`${await page.locator('#pools').innerText()} ${await page.locator('[data-ticker]').innerText()}`, /snapshot|stored/i, 'no word about where the rows came from');
    assert.deepEqual(errors, []);
  } finally {
    await closeContext(context);
  }
});

test('(p) markets-snapshot listed: a pool the store does not hold is read on demand after the stored rows’ tokens; a failed snapshot is never shown or said', async () => {
  const snapshotListed = listing([...PRODUCTION_READS, 'markets-snapshot']);
  {
    const { context, page, errors } = await visit(bridgeStub({ capabilities: snapshotListed, reply: (route) => (route === 'markets-snapshot' ? bridge(200, snapshotFor(SELECTED.slice(1))) : undefined) }));
    try {
      assert.equal(await settled(page), 'none');
      assert.deepEqual(
        wire(),
        ['GET v3 capabilities', 'GET capabilities', 'POST markets-snapshot', ...tokenWire(SELECTED.slice(1)), 'GET v2 capabilities', 'POST pool-market'],
        'stored rows and their tokens first, then the one pool the store did not hold',
      );
      assert.deepEqual(reads.filter((r) => r.path.endsWith('/pool-market')).map((r) => r.body), [{ poolId: SELECTED[0], includePriceHistory: false }]);
      const sources = await liveRows(page).evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-row-source')));
      assert.deepEqual(sources, ['pool-market', ...SELECTED.slice(1).map(() => 'markets-snapshot')]);
      assert.equal((await rowView(liveRows(page).first())).pair, 'TKY/ETH', 'its tokens were already read for the stored rows');
      assert.deepEqual(errors, []);
    } finally {
      await closeContext(context);
    }
  }
  {
    const failing = bridgeStub({ capabilities: snapshotListed, reply: (route) => (route === 'markets-snapshot' ? bridge(503, { error: 'upstream_unavailable' }) : undefined) });
    const { context, page, errors } = await visit(failing);
    try {
      assert.equal(await settled(page), 'none', 'a failed snapshot is no problem of the table');
      await saidQuietly(page, 'none', '');
      assert.deepEqual(wire(), ['GET v3 capabilities', 'GET capabilities', 'POST markets-snapshot', 'GET v2 capabilities', ...LOAD], 'the pools are read as before, in the same load');
      const sources = await liveRows(page).evaluateAll((trs) => trs.map((tr) => tr.getAttribute('data-row-source')));
      assert.deepEqual(sources, SELECTED.map(() => 'pool-market'));
      assert.deepEqual(errors, []);
    } finally {
      await closeContext(context);
    }
  }
});

test('(q) the rows complete one by one: a price waits quietly while its row’s token reads are to come, and is never Unavailable for decimals not read yet', async () => {
  let watched = null;
  /** Each price cell of the live rows, as the page stood when each market or token read reached the bridge. */
  const seen = [];
  const { context, page, errors } = await visit(
    bridgeStub({
      reply: async (route, body) => {
        if (watched && (route === 'pool-market' || route === 'token')) {
          const prices = await watched.evaluate(() =>
            Array.from(document.querySelectorAll('#pools tbody tr:not([data-pool-catalogue])'), (tr) => {
              const cell = tr.querySelector('[data-pool-price]');
              return [cell?.getAttribute('data-pool-price') ?? null, cell?.getAttribute('title') ?? null];
            }),
          );
          seen.push({ route, asked: body.poolId ?? body.token, prices });
        }
        return undefined;
      },
    }),
    { onPage: (opened) => { watched = opened; } },
  );
  try {
    assert.equal(await settled(page), 'none');
    assert.deepEqual(wire(), ['GET v3 capabilities', 'GET capabilities', 'GET v2 capabilities', ...LOAD]);
    const markets = seen.filter((entry) => entry.route === 'pool-market');
    assert.equal(markets.length, 6);
    for (const [index, entry] of markets.entries()) {
      // Every row on screen when the next pool is asked for is complete: its price is usable.
      assert.deepEqual(entry.prices.map(([state]) => state), Array(index).fill('usable'), `rows complete before pool ${index + 1} is read`);
    }
    for (const entry of seen) {
      for (const [state, title] of entry.prices) {
        assert.notEqual(state, 'unavailable', `a price read as unavailable while its reads were still to come: ${JSON.stringify(entry)}`);
        if (state === 'loading') assert.equal(title, null, 'a waiting price says nothing');
      }
    }
    assert.ok(seen.some((entry) => entry.route === 'token' && entry.prices.at(-1)?.[0] === 'loading'), 'the row whose token is being read waits quietly');
    const settledPrices = await liveRows(page).evaluateAll((trs) => trs.map((tr) => tr.querySelector('[data-pool-price]').getAttribute('data-pool-price')));
    assert.deepEqual(settledPrices, SELECTED.map(() => 'usable'));
    assert.equal(await page.locator('#pools [data-pool-price="loading"]').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await closeContext(context);
  }
});

// ---------------------------------------------------------------------------
// The featured pools list (read-v5, featured pools v1 §11, added 2026-09-26), served and not. The deployable build
// reads it first, as one POST of {}, then the markets of the pools it names. Served and current: its pools in its
// order, "Top pools · last 24h" and a Pinned chip (the method line under the title was removed 2026-09-28, the owner:
// "Não precisa ter essa descrição"). Not served: the embedded six under "Selected pools", exactly as before. A pool
// it withdrew is refused on New position when a link opens it.
// ---------------------------------------------------------------------------

const V5 = '1.0.0-rc.1';
const LIST = JSON.parse(readFileSync(new URL('../../api-contracts/read-v5/fixtures/valid/current.json', import.meta.url), 'utf8'));
const SYMBOL_OF = { [NATIVE]: 'ETH', ...SYMBOLS };
/** A featured pool for one of the stub's pools: the key its pool-market read has (3000 pips, spacing 60, no hooks). */
function listed(poolId, slot, pinned) {
  const [currency0, currency1] = PAIRS[poolId];
  const base = JSON.parse(JSON.stringify(LIST.pools[pinned ? 0 : 1]));
  return {
    ...base, slot, poolId,
    poolKey: { currency0, currency1, feeMode: 'fixed', fee_pips: 3000, hooks: NATIVE, tick_spacing: 60 },
    tokens: [currency0, currency1].map((address) => ({ address, decimals: 18, symbol: SYMBOL_OF[address] })),
  };
}
/** The list served now: SELECTED[5] pinned, then SELECTED[0], an order the reviewed list does not have. */
const SERVED = [SELECTED[5], SELECTED[0]];
const servedList = (patch = {}) => ({ ...JSON.parse(JSON.stringify(LIST)), pools: [listed(SERVED[0], 1, true), listed(SERVED[1], 2, false)], withdrawn: [], ...patch });
const v5 = (status, body) => json(status, body, { 'X-Domino-Read-Contract': V5 });
const withList = (answer, options = {}) => bridgeStub({ ...options, reply: (route, body) => (route === FEATURED_PATH ? answer() : options.reply?.(route, body)) });
const SERVED_LINKS = [`#/pool/${SERVED[0]}/${TOKEN_Z}`, `#/pool/${SERVED[1]}/${TOKEN_Y}`];

test('(r) a list served and current: its pools in its order, read first, under "Top pools · last 24h" with a Pinned chip and no line under the title; links name the pool and a token', async () => {
  const { context, page, errors } = await visit(withList(() => v5(200, servedList())));
  try {
    assert.equal(await settled(page), 'none');
    // Changed on purpose 2026-09-27 (r6/marketsdata): the read-v3 capabilities GET, which takes no place in the queue,
    // is asked beside the list; the list is still the page's first POST, and nothing about a pool is read before it.
    assert.deepEqual(listReads().map(({ method, body }) => ({ method, body })), [{ method: 'POST', body: {} }], 'one POST of {}');
    assert.equal(reads.findIndex((r) => r.method === 'POST'), listReads()[0].index, 'the list is the page’s first POST');
    assert.ok(reads.slice(0, listReads()[0].index).every((r) => r.path.endsWith('/capabilities')), 'only the capabilities beside it');
    assert.deepEqual(reads.filter((r) => r.path.endsWith('/pool-market')).map((r) => r.body.poolId), SERVED, 'then the markets of its pools, in its order');
    assert.equal(await page.locator('#pools [data-featured-source]').getAttribute('data-featured-source'), 'server');
    assert.equal(await page.locator('#pools h2').first().innerText(), 'Top pools · last 24h');
    // Changed on purpose 2026-09-28 (the owner: "Não precisa ter essa descrição"): no method line under the title.
    assert.doesNotMatch(await page.locator('body').innerText(), /Ranked daily|Not a recommendation/, 'no method line anywhere');
    const rows = liveRows(page);
    assert.deepEqual(await rows.evaluateAll((trs) => trs.map((tr) => tr.querySelector('a').getAttribute('href'))), SERVED_LINKS);
    assert.equal(await catalogueRows(page).count(), 0);
    assert.deepEqual(await rows.evaluateAll((trs) => trs.map((tr) => tr.querySelector('[data-pinned]')?.textContent ?? null)), ['Pinned', null], 'the pinned pool says so, in words');
    assert.deepEqual(await page.locator('.dm-marquee > a:not([data-pool-catalogue])').evaluateAll((as) => as.map((a) => a.getAttribute('href'))), SERVED_LINKS, 'the ticker shows the same list');
    assert.deepEqual(errors, []);
  } finally {
    await closeContext(context);
  }
});

test('(s) the list off (route_not_available), none, older than 72 h or invalid: the embedded six under "Selected pools", nothing else changed', async () => {
  for (const [label, answer] of [
    ['route_not_available', () => v5(404, { error: 'route_not_available' })],
    ['none', () => v5(200, JSON.parse(readFileSync(new URL('../../api-contracts/read-v5/fixtures/valid/none.json', import.meta.url), 'utf8')))],
    ['older than 72 h', () => v5(200, servedList({ servedAt: LIST.generatedAt + 72 * 3600 + 1 }))],
    ['invalid', () => v5(200, { ...servedList(), extra: true })],
  ]) {
    const { context, page, errors } = await visit(withList(answer));
    try {
      assert.equal(await settled(page), 'none', label);
      assert.equal(listReads().length, 1, `${label}: one list read`);
      assert.equal(await page.locator('#pools [data-featured-source]').getAttribute('data-featured-source'), 'bundled', label);
      assert.equal(await page.locator('#pools h2').first().innerText(), 'Selected pools', label);
      assert.deepEqual(reads.filter((r) => r.path.endsWith('/pool-market')).map((r) => r.body.poolId), SELECTED, `${label}: the embedded six are read`);
      assert.equal(await liveRows(page).count(), 6, label);
      assert.equal(await page.locator('[data-pinned]').count(), 0, `${label}: no Pinned chip`);
      assert.deepEqual(errors, [], label);
    } finally {
      await closeContext(context);
    }
  }
});

test('(t) a stale list (validUntil passed, within 72 h) and a carried_over one keep their pools under the neutral title', async () => {
  for (const [label, patch] of [['stale', { servedAt: LIST.validUntil + 60 }], ['carried_over', { status: 'carried_over' }]]) {
    const { context, page } = await visit(withList(() => v5(200, servedList(patch))));
    try {
      assert.equal(await settled(page), 'none', label);
      assert.equal(await page.locator('#pools [data-featured-source]').getAttribute('data-featured-source'), 'server_neutral', label);
      assert.equal(await page.locator('#pools h2').first().innerText(), 'Selected pools', label);
      assert.deepEqual(await liveRows(page).evaluateAll((trs) => trs.map((tr) => tr.querySelector('a').getAttribute('href'))), SERVED_LINKS, `${label}: the server’s pools`);
      assert.equal(await page.locator('[data-pinned]').count(), 0, `${label}: no ranking claim`);
    } finally {
      await closeContext(context);
    }
  }
});

test('(u) New position refuses a pool the list withdrew, opened by a link, with the owner’s plain line, and verifies nothing', async () => {
  const none = JSON.parse(readFileSync(new URL('../../api-contracts/read-v5/fixtures/valid/none-with-withdrawn.json', import.meta.url), 'utf8'));
  none.withdrawn = [{ ...none.withdrawn[0], poolId: SELECTED[1] }];
  const { context, page, errors } = await visit(withList(() => v5(200, none)));
  try {
    leaving(page);
    await page.goto(`${origin}/#/new/${SELECTED[1]}`, { waitUntil: 'networkidle' });
    await page.locator('[data-preselect="withdrawn"]').waitFor({ timeout: 30_000 });
    // Changed on purpose 2026-10-01 (audit B2, I1): the line is said for safety reasons alone, a look-alike pool's included.
    assert.equal(await page.locator('[data-preselect-withdrawn]').innerText(), 'For safety, Domino doesn’t open positions in this pool. Choose another pool.');
    assert.equal(reads.filter((r) => r.path.endsWith('/pools')).length, 0, 'the withdrawn pool is never verified');
    assert.deepEqual(errors, []);
  } finally {
    await closeContext(context);
  }
});

// Changed on purpose 2026-10-02 (owner: only today's list on Markets). Audit B5 (2026-10-01) put a second table,
// "Selected pools", under today's list on Markets: the embedded pools the list did not name (on production, WETH/USDG
// 0.02%, cbBTC/USDG, U/USDG, ETH/USDG 0.01%). The owner had removed it before and wants only today's list. A short
// list keeps its count and opens the catalogue search; no second table, and the pools the list does not name are not read.
test('(v) Markets with a short list: today’s table alone, with its count and the catalogue search open; no second "Selected pools" table, and the pools the list does not name are never read', async () => {
  const { context, page, errors } = await visit(withList(() => v5(200, servedList())));
  try {
    assert.equal(await settled(page), 'none');
    const from = reads.length;
    await page.evaluate(() => {
      window.location.hash = '#/markets';
    });
    await page.waitForFunction(() => {
      const status = document.querySelector('[data-selected-pools] [data-read-status]')?.getAttribute('data-read-status');
      return status && status !== 'loading' && document.querySelectorAll('[data-selected-pools] tbody tr:not([data-pool-catalogue])').length === 2;
    }, null, { timeout: 30_000 });
    // Long enough for the removed section to have read its four pools and painted them (about 3 s when it was there).
    await page.waitForTimeout(8_000);
    assert.equal(await page.locator('[data-selected-beyond]').count(), 0, 'no second table');
    assert.equal(await page.locator('main [data-selected-pools]').count(), 1, 'one pools table on Markets');
    assert.equal(await page.locator('main section.dm-mkt-pools').count(), 1, 'one pools section on Markets');
    assert.equal(await page.locator('#markets-pools-title').innerText(), 'Top pools · last 24h', 'today’s title');
    assert.doesNotMatch(await page.locator('main').innerText(), /Selected pools/, 'no "Selected pools" heading anywhere on Markets');
    assert.deepEqual(await page.locator('main [data-selected-pools] tbody tr').evaluateAll((trs) => trs.map((tr) => tr.querySelector('a').getAttribute('href'))), SERVED_LINKS, 'today’s pools, in its order, and nothing else');
    // Changed on purpose 2026-10-03 (the owner): a short list no longer says "2 of 6 today"; it still opens the catalogue search.
    assert.equal(await page.locator('main [data-featured-count]').count(), 0, 'no count beside the title');
    assert.equal(await page.locator('[data-catalogue-search]').evaluate((details) => details.open), true, 'the catalogue search is open on a short list');
    const others = SELECTED.filter((poolId) => !SERVED.includes(poolId));
    assert.deepEqual(reads.slice(from).filter((r) => r.path.endsWith('/pool-market') && others.includes(r.body.poolId)).map((r) => r.body.poolId), [], 'the pools the list does not name are never read');
    assert.deepEqual(errors, []);
  } finally {
    await closeContext(context);
  }
});
