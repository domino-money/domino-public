/**
 * The deployable dist in a real browser, behind the real gate, with a stub
 * where the /api forwarder and its bridge would be. Every honest state the
 * landing can be in, and exactly what each one costs on the wire:
 *
 *   (a) forwarder 503 bridge_unavailable   Live data isn't connected yet: 1 GET, 0 POST, no Retry
 *   (b) forwarder 404 not_found            Live data isn't available on this address
 *   (c) capabilities off, or no reads      Live data is switched off for now: 0 POST
 *   (d) reads enabled                      1 GET + 5 POSTs in order; APR unavailable; provider and age
 *   (e) 404 route_not_available            switched off, after the first POST
 *   (f) producer 503                       Temporarily unavailable with Retry, never asked again on its own
 *   (g) 429 read_capacity_busy             asked again under R-1 after its Retry-After
 *   (h) no access cookie                   the gate's 401: Beta access needed
 *   (i)-(l) #93's display rules, per row   provider figures dated by retrieval only; a rejected,
 *                                          stale, null or failed pool never takes the other with it
 *
 * The stub serves test data only: package fixtures rewritten to the two
 * selected pool ids, with made-up pairs and symbols. Everything else is the
 * real dist, the real gate and the real read pipeline, and R-1's pacing runs
 * in real time here, so this file is timing-sensitive: rerun it once if it flakes.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeContext, leaving, watch } from './page-watch.mjs';
import { DIST, createGatedServer } from '../scripts/gated-server.mjs';
import { TOGGLE_VIEWPORTS, textUnderToggle } from './toggle-overlap.mjs';

const PASSWORD = 'release-test-beta-password';
const GATE = { BETA_PASSWORD: PASSWORD, BETA_COOKIE_KEY: 'Rk2mP9vQx4Lr7TbW1cNy6ZsJ3dGa8FeU5oViRtYqWeC' };
const RC3 = '1.1.0-rc.3';
const READ = resolve(import.meta.dirname, '../../api-contracts/read-v1/fixtures/gateway');
const fixture = (name) => JSON.parse(readFileSync(join(READ, `${name}.json`), 'utf8'));

/** The pools dist reads, taken from the reviewed config itself. */
const SELECTED = readFileSync(resolve(import.meta.dirname, '../src/config/selectedPools.ts'), 'utf8').match(/0x[0-9a-f]{64}/g);
const NATIVE = '0x0000000000000000000000000000000000000000';
const TOKEN_Y = `0x${'22'.repeat(20)}`;
const TOKEN_Z = `0x${'33'.repeat(20)}`;
/** Test pairs, A/Y and Y/Z sharing Y. Not the pools' real pairs: only reads establish those. */
const PAIRS = { [SELECTED[0]]: [NATIVE, TOKEN_Y], [SELECTED[1]]: [TOKEN_Y, TOKEN_Z] };
const SYMBOLS = { [TOKEN_Y]: 'TKY', [TOKEN_Z]: 'TKZ' };
const LOAD = ['POST pool-market', 'POST token', 'POST token', 'POST pool-market', 'POST token'];

if (!existsSync(join(DIST, 'index.html'))) {
  throw new Error('dist/index.html is missing. Run `npm run build` before this test.');
}

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

/** The bridge, stubbed: the capabilities given, and each POST from the rewritten fixtures unless `reply` answers it. */
function bridgeStub({ capabilities = fixture('capabilities.live_read_only'), reply = () => undefined } = {}) {
  return async (request) => {
    const route = new URL(request.url).pathname.replace('/api/read/v1/', '');
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
/** Every request the gate let through to /api, as it arrived there. */
let reads = [];

async function api(request) {
  const url = new URL(request.url);
  const body = request.method === 'POST' ? JSON.parse(await request.clone().text()) : null;
  reads.push({ method: request.method, path: url.pathname, body });
  return handler(request);
}

const LAUNCHES = process.env.DOMINO_BROWSER_PATH
  ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }]
  : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}];

let server;
let origin;
let browser;

before(async () => {
  server = createGatedServer({ env: GATE, api });
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

/** A signed-in visitor on the deployable landing, with the given stub behind /api and a fresh log. */
async function visit(stub) {
  handler = stub;
  reads = [];
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
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
const wire = () => reads.map((r) => `${r.method} ${r.path.replace('/api/read/v1/', '')}`);

/** A failed landing shows no row, no figure and nothing called a sample: nothing stands in for the read. */
async function nothingInvented(page, label) {
  const found = await page.evaluate(() => ({
    rows: document.querySelectorAll('#pools tbody tr').length,
    metrics: document.querySelectorAll('[data-metric]').length,
    sample: /sample|practice/i.test(document.body.innerText),
  }));
  assert.deepEqual(found, { rows: 0, metrics: 0, sample: false }, label);
}

test('(a) no bridge behind the forwarder: live data is not connected, one GET, no POST, no Retry, and the ticker says the same', async () => {
  const { context, page, errors } = await visit(forwarder(503, 'bridge_unavailable'));
  try {
    assert.equal(await settled(page), 'not_connected');
    assert.match(await statusOf(page).innerText(), /Live data isn't connected yet/);
    assert.equal(await page.locator('#pools').getByRole('button', { name: /Retry|Refresh/ }).count(), 0, 'nothing to retry');
    assert.equal(await page.locator('[data-ticker-status]').innerText(), "Live data isn't connected yet");
    await nothingInvented(page, 'not connected');
    await page.waitForTimeout(2500);
    assert.deepEqual(wire(), ['GET capabilities'], 'asked once, and never again on its own');
    assert.deepEqual(errors, []);
  } finally {
    await closeContext(context);
  }
});

test('(b) a forwarder that does not serve this address, as on a preview host: said so, one GET, no POST', async () => {
  const { context, page } = await visit(forwarder(404, 'not_found'));
  try {
    assert.equal(await settled(page), 'not_connected');
    assert.match(await statusOf(page).innerText(), /Live data isn't available on this address/);
    assert.equal(await page.locator('#pools').getByRole('button', { name: 'Retry' }).count(), 0);
    await nothingInvented(page, 'not found');
    assert.deepEqual(wire(), ['GET capabilities']);
  } finally {
    await closeContext(context);
  }
});

test('(c) live reads switched off on the server, or the pool route not listed: said so, and nothing posted', async () => {
  const live = fixture('capabilities.live_read_only');
  for (const [label, capabilities] of [
    ['data mode disabled', fixture('capabilities.disabled')],
    ['no reads enabled', { ...live, enabledReads: [] }],
    ['pool-market not enabled', { ...live, enabledReads: ['token'] }],
  ]) {
    const { context, page } = await visit(bridgeStub({ capabilities }));
    try {
      assert.equal(await settled(page), 'disabled', label);
      assert.match(await statusOf(page).innerText(), /Live data is switched off for now/, label);
      assert.equal(await page.locator('#pools').getByRole('button', { name: 'Retry' }).count(), 0, label);
      await nothingInvented(page, label);
      assert.deepEqual(wire(), ['GET capabilities'], label);
    } finally {
      await closeContext(context);
    }
  }
});

test('(d) reads enabled: one GET and five POSTs in order, never pool-metrics; the APR unavailable, figures named with their age; a reload costs the same again', async () => {
  const { context, page, errors } = await visit(bridgeStub());
  try {
    assert.equal(await settled(page), 'none');
    const first = ['GET capabilities', ...LOAD];
    assert.deepEqual(wire(), first);
    assert.deepEqual(reads.filter((r) => r.path.endsWith('/pool-market')).map((r) => r.body), SELECTED.map((poolId) => ({ poolId, includePriceHistory: false })));
    assert.deepEqual(reads.filter((r) => r.path.endsWith('/token')).map((r) => r.body.token), [NATIVE, TOKEN_Y, TOKEN_Z], 'the shared token is read once');

    const rows = page.locator('#pools tbody tr');
    assert.equal(await rows.count(), 2);
    for (const row of await rows.all()) {
      const text = await row.innerText();
      assert.match(text, /\$12\.3K\s*·\s*GeckoTerminal/, 'the provider is named');
      assert.match(text, /Pool verified on-chain at block 700 · Reported by GeckoTerminal, retrieved \d+ s ago/, 'dated by its retrieval age');
      assert.doesNotMatch(text, /\bas of\b|updated at/i, 'never "as of" or "updated at": the provider update time is unknown');
      const apr = row.locator('td').last();
      assert.equal(await apr.innerText(), 'Unavailable');
      assert.equal(await apr.locator('[data-metric]').getAttribute('title'), 'Unavailable: APR not provided by the read service yet');
    }
    // The stub reports each pool the provider's way round (base = currency1): the label keeps the pool's own order.
    assert.equal(await rows.nth(0).locator('td').first().locator('span.font-medium').innerText(), 'ETH/TKY', 'symbols come from the token reads, in the pool’s order');
    assert.equal(await rows.nth(1).locator('td').first().locator('span.font-medium').innerText(), 'TKY/TKZ');
    assert.equal(await page.locator('a[href*="geckoterminal"]').count(), 0, 'sourceUrl is never linked');
    // #93: the headers name who reported each figure, on a phone as on a laptop; the ratio is Domino's.
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const heads = await page.locator('#pools thead th').evaluateAll((ths) => ths.map((th) => th.innerText.replace(/\s+/g, ' ').trim()));
      assert.deepEqual(heads, ['Pool', 'TVL (reported by GeckoTerminal)', '24h volume (reported by GeckoTerminal)', '24h vol/TVL (calculated by Domino)', 'Pool APR'], `${width}px`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.doesNotMatch(await page.locator('body').innerText(), /geckoterminal\.com/i, 'nor shown');
    assert.match(await rows.nth(1).innerText(), /TKY[\s\S]*TKZ/);
    const ticker = await page.locator('.dm-marquee').innerText();
    assert.match(ticker, /TKZ[\s\S]*APR unavailable/, 'the ticker shows the same result set');
    const aprStates = await page.locator('.dm-marquee [data-metric]').evaluateAll((els) => els.map((el) => el.getAttribute('data-metric')));
    assert.ok(aprStates.length >= 2 && aprStates.every((state) => state === 'unavailable'), `and no APR figure: ${aprStates}`);

    leaving(page);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await settled(page), 'none');
    assert.deepEqual(wire(), [...first, ...first], 'a reload reads everything again: nothing is cached');
    assert.deepEqual(errors, []);
  } finally {
    await closeContext(context);
  }
});

test('(e) the pool route switched off between the GET and the first POST: said so, and the second pool is never asked', async () => {
  const { context, page } = await visit(bridgeStub({ reply: (route) => (route === 'pool-market' ? bridge(404, { error: 'route_not_available' }) : undefined) }));
  try {
    assert.equal(await settled(page), 'disabled');
    assert.match(await statusOf(page).innerText(), /Live data is switched off for now/);
    await nothingInvented(page, 'route switched off');
    assert.deepEqual(wire(), ['GET capabilities', 'POST pool-market']);
  } finally {
    await closeContext(context);
  }
});

test('(f) a producer 503: temporarily unavailable with a Retry, never asked again on its own; one Retry reads again', async () => {
  let down = true;
  const { context, page } = await visit(bridgeStub({ reply: (route) => (route === 'pool-market' && down ? bridge(503, { error: 'upstream_unavailable' }) : undefined) }));
  try {
    assert.equal(await settled(page), 'unavailable');
    assert.match(await statusOf(page).innerText(), /Temporarily unavailable[\s\S]*answered: read service unavailable/);
    assert.equal(await page.locator('[data-ticker-status]').innerText(), 'Temporarily unavailable');
    await nothingInvented(page, 'producer 503');
    const failed = wire();
    assert.deepEqual(failed, ['GET capabilities', 'POST pool-market', 'POST pool-market'], 'each pool asked once');
    await page.waitForTimeout(2500);
    assert.deepEqual(wire(), failed, 'and neither asked again on its own');

    down = false;
    await page.getByRole('button', { name: 'Retry' }).click();
    assert.equal(await settled(page), 'none');
    assert.deepEqual(wire().slice(failed.length), LOAD, 'one Retry, one lean load; the capabilities answer is kept');
    assert.equal(await page.locator('#pools tbody tr').count(), 2);
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
    assert.deepEqual(wire(), ['GET capabilities', 'POST pool-market', ...LOAD], 'one automatic retry, then the lean load');
    assert.equal(await page.locator('#pools tbody tr').count(), 2);
  } finally {
    await closeContext(context);
  }
});

test('(h) without the access cookie a read is the gate’s 401: sign in again, nothing reaches the bridge, and the last rows stay, marked stale', async () => {
  const { context, page } = await visit(bridgeStub());
  try {
    assert.equal(await settled(page), 'none');
    await context.clearCookies();
    const before = reads.length;
    await page.getByRole('button', { name: 'Refresh' }).click();
    assert.equal(await settled(page), 'gate_required');
    assert.match(await statusOf(page).innerText(), /Beta access needed/);
    assert.equal(await page.getByRole('link', { name: 'Sign in again' }).getAttribute('href'), '/');
    assert.equal(reads.length, before, 'the gate refused the read: nothing reached the bridge');
    assert.equal(await page.locator('#pools tbody tr').count(), 2, 'the last good rows stay');
    const states = await page.locator('#pools tbody [data-metric]').evaluateAll((els) => els.map((el) => el.getAttribute('data-metric')));
    assert.ok(states.includes('stale') && !states.includes('provider'), `retained rows read as current: ${states}`);
  } finally {
    await closeContext(context);
  }
});

/** One row's cells and provenance, as a reader sees them. */
async function rowView(row) {
  const cells = await row.locator('td').evaluateAll((tds) => tds.slice(1).map((td) => {
    const el = td.querySelector('[data-metric]');
    return { text: td.innerText.replace(/\s+/g, ' ').trim(), metric: el?.getAttribute('data-metric') ?? null, title: el?.getAttribute('title') ?? null };
  }));
  return {
    pair: await row.locator('td').first().locator('span.font-medium').innerText(),
    provenance: await row.locator('[data-provenance]').innerText(),
    cells,
  };
}

/** A pool that failed leaves no row, no figure and nothing called a sample in its place. */
async function nothingStandsIn(page) {
  const text = await page.locator('#pools').innerText();
  assert.doesNotMatch(text, /sample|practice|placeholder/i);
  assert.equal(await page.locator('#pools tbody [data-metric]').count(), 4, 'one row of four figures, no more');
}

const shortPool = (id) => `${id.slice(0, 6)}…${id.slice(-4)}`;

test('(i) #93 per row: GeckoTerminal figures dated only by retrieval; a rejected pool keeps its verified row with its metrics unavailable, and the other row is untouched', async () => {
  const { context, page, errors } = await visit(
    bridgeStub({ reply: (route, body) => (route === 'pool-market' && body.poolId === SELECTED[1] ? bridge(200, marketVariant(SELECTED[1], 'rejected-currencies')) : undefined) }),
  );
  try {
    assert.equal(await settled(page), 'none', 'a rejected provider observation is a valid read, not a failure');
    assert.deepEqual(wire(), ['GET capabilities', ...LOAD], 'the rejected pool still reads its tokens, so its row is labelled from them');
    const rows = page.locator('#pools tbody tr');
    assert.equal(await rows.count(), 2);

    const ok = await rowView(rows.nth(0));
    assert.equal(ok.pair, 'ETH/TKY');
    assert.match(ok.provenance, /^Pool verified on-chain at block 700 · Reported by GeckoTerminal, retrieved \d+ s ago$/);
    assert.deepEqual(ok.cells.map((c) => c.metric), ['provider', 'provider', 'calculated', 'unavailable']);
    assert.match(ok.cells[0].text, /^\$12\.3K\s*·\s*GeckoTerminal$/);
    assert.match(ok.cells[0].title, /^Reported by GeckoTerminal, retrieved \d+ s ago\. Not reconciled by Domino\.$/);
    // 24h vol/TVL is Domino's division of GeckoTerminal's two figures: GeckoTerminal never reported it.
    assert.match(ok.cells[2].text, /^0\.00\s*·\s*calculated$/);
    assert.doesNotMatch(ok.cells[2].text, /GeckoTerminal/, 'no provider suffix on a ratio the provider did not report');
    assert.match(ok.cells[2].title, /^Calculated by Domino from GeckoTerminal's reported 24h volume and TVL, retrieved \d+ s ago\. Those figures are not reconciled by Domino\.$/);
    assert.equal(ok.cells[3].text, 'Unavailable', 'APR unavailable, never an estimate');

    const rejected = await rowView(rows.nth(1));
    assert.equal(rejected.pair, 'TKY/TKZ', 'the verified pool row stays, labelled from its own token reads');
    assert.equal(rejected.provenance, 'Pool verified on-chain at block 700 · GeckoTerminal figures rejected: provider data did not match this pool');
    assert.deepEqual(rejected.cells.map((c) => [c.text, c.metric]), [['Unavailable', 'rejected'], ['Unavailable', 'rejected'], ['Unavailable', 'unavailable'], ['Unavailable', 'unavailable']]);

    assert.doesNotMatch(await page.locator('#pools').innerText(), /\bas of\b|updated at/i);
    assert.equal(await page.locator('a[href*="geckoterminal"]').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    await closeContext(context);
  }
});

test('(j) #93 per row: a stale observation carries a visible stale marker, and a null figure is not reported, never $0', async () => {
  const missing = fixture('pool-market.missing').market.data;
  assert.deepEqual([missing.reportedLiquidityUsd, missing.volume24hUsd], [null, null], 'the package fixture reports both as null');
  const variant = { [SELECTED[0]]: 'stale', [SELECTED[1]]: 'missing' };
  const { context, page } = await visit(bridgeStub({ reply: (route, body) => (route === 'pool-market' ? bridge(200, marketVariant(body.poolId, variant[body.poolId])) : undefined) }));
  try {
    assert.equal(await settled(page), 'none');
    const rows = page.locator('#pools tbody tr');
    assert.equal(await rows.count(), 2);

    const stale = await rowView(rows.nth(0));
    assert.match(stale.provenance, /^Pool verified on-chain at block 700 · Reported by GeckoTerminal, retrieved \d+ s ago · stale$/);
    assert.deepEqual(stale.cells.slice(0, 3).map((c) => c.metric), ['stale', 'stale', 'stale']);
    assert.match(stale.cells[0].text, /^\$12\.3K\s*·\s*stale\s*·\s*GeckoTerminal$/, 'the stale marker is on screen, not only in a title');
    assert.match(stale.cells[0].title, /^Reported by GeckoTerminal, retrieved \d+ s ago\. Not reconciled by Domino\. Stale, not current\.$/);
    assert.match(stale.cells[2].text, /^0\.00\s*·\s*stale\s*·\s*calculated$/);
    assert.match(stale.cells[2].title, /^Calculated by Domino from GeckoTerminal's reported 24h volume and TVL, retrieved \d+ s ago\. Those figures are not reconciled by Domino\. Stale, not current\.$/);

    const nulls = await rowView(rows.nth(1));
    const notReported = ['Not reported by GeckoTerminal', 'absent'];
    assert.deepEqual(nulls.cells.map((c) => [c.text, c.metric]), [notReported, notReported, ['Unavailable', 'unavailable'], ['Unavailable', 'unavailable']], 'unavailable, in the name of the source that reported null');
    assert.equal(nulls.cells[0].title, 'Unavailable: GeckoTerminal reported no value');
    assert.doesNotMatch(await rows.nth(1).innerText(), /\$\s*0|\b0\.00\b/, 'null never renders as zero');
  } finally {
    await closeContext(context);
  }
});

test('(k) #93 per row: a 504 on one pool drops only that pool, says which, and is not asked again on its own', async () => {
  const { context, page } = await visit(
    bridgeStub({ reply: (route, body) => (route === 'pool-market' && body.poolId === SELECTED[0] ? bridge(504, { error: 'upstream_timeout' }) : undefined) }),
  );
  try {
    assert.equal(await settled(page), 'partial');
    const rows = page.locator('#pools tbody tr');
    assert.equal(await rows.count(), 1, 'the other pool keeps its row');
    const other = await rowView(rows.nth(0));
    assert.equal(other.pair, 'TKY/TKZ');
    assert.match(other.cells[0].text, /^\$12\.3K\s*·\s*GeckoTerminal$/);
    const status = await statusOf(page).innerText();
    assert.match(status, /Some pool data could not be read/);
    assert.ok(status.includes(`Pool ${shortPool(SELECTED[0])}, pool-market: temporarily unavailable.`), status);
    const settledWire = wire();
    assert.deepEqual(settledWire, ['GET capabilities', 'POST pool-market', 'POST pool-market', 'POST token', 'POST token']);
    await page.waitForTimeout(2500);
    assert.deepEqual(wire(), settledWire, 'nothing asked again on its own');
    await nothingStandsIn(page);
  } finally {
    await closeContext(context);
  }
});

test('(m) with both pools on screen, the appearance toggle covers no figure, heading or footer text at 390, 768 or 1280 wide', async () => {
  const { context, page, errors } = await visit(bridgeStub());
  try {
    assert.equal(await settled(page), 'none');
    assert.equal(await page.locator('#pools tbody tr').count(), 2);
    for (const [width, height] of TOGGLE_VIEWPORTS) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(100);
      const { hits, seen } = await textUnderToggle(page, ['#pools table', 'footer']);
      assert.deepEqual(seen, ['#pools table', 'footer'], `${width}px`);
      assert.deepEqual(hits, [], `the toggle covers text at ${width}x${height}:\n${hits.join('\n')}`);
    }
    assert.deepEqual(errors, []);
  } finally {
    await closeContext(context);
  }
});

test('(l) #93 per row: a 429 that outlasts R-1 on one pool leaves the other pool’s row', async () => {
  const { context, page } = await visit(
    bridgeStub({ reply: (route, body) => (route === 'pool-market' && body.poolId === SELECTED[1] ? bridge(429, { error: 'read_capacity_busy' }, { 'Retry-After': '1' }) : undefined) }),
  );
  try {
    assert.equal(await settled(page), 'partial');
    const pm = wire().filter((line) => line === 'POST pool-market').length;
    assert.ok(pm >= 2 && pm <= 4, `the busy pool is asked at most three times under R-1 (${wire()})`);
    assert.deepEqual(wire().slice(0, 4), ['GET capabilities', 'POST pool-market', 'POST token', 'POST token']);
    const rows = page.locator('#pools tbody tr');
    assert.equal(await rows.count(), 1);
    assert.equal((await rowView(rows.nth(0))).pair, 'ETH/TKY');
    assert.ok((await statusOf(page).innerText()).includes(`Pool ${shortPool(SELECTED[1])}, pool-market: read service busy.`));
    await nothingStandsIn(page);
  } finally {
    await closeContext(context);
  }
});
