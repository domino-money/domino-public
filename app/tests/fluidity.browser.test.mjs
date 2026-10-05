/**
 * Real browser over a fake node, never a live wallet or backend. Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the
 * position is tests/support/fees/ledger-world.mjs's (the owner's 3325113 as recorded on 2026-09-27), its history its own
 * ledger from the site's ledger route, in place of a replay of its recorded pool.
 */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeBrowser } from './support/close-browser.mjs';
import { createWalletServer } from './support/wallet-server.mjs';
import { createFakeSession } from './support/fake-session.mjs';
import { routeChain } from './support/browser-chain.mjs';
import { HOLDER, NOW, ledgerWorld } from './support/fees/ledger-world.mjs';
import { createReadStub } from './support/read-stub.mjs';

let browser;
before(async () => {
  for (const options of process.env.DOMINO_BROWSER_PATH ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }] : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}]) {
    try { browser = await chromium.launch({ ...options, headless: true }); break; } catch {}
  }
  if (!browser) throw new Error('A Chromium browser is required.');
});
after(async () => closeBrowser(browser));

test('a verified public chart survives reload as a labelled snapshot before the node answers, then becomes the fresh ledger', { timeout: 120_000 }, async (t) => {
  const world = ledgerWorld();
  const chain = world.chain;
  const ID = '3325113';
  const fake = createFakeSession();
  // 2026-10-02 (the fee chart's periods back): the site's read bridge lists read-v1 nft-positions, as deployed; every read
  // of the position at a past block is kept here, with whether the saved copy was on screen then.
  const past = [];
  let copyShown = false;
  const read = createReadStub({ reads: 'nft-positions', answer: (_route, body) => { past.push({ ...body, copyShown }); return world.pastAnswer(body.blockNumber); } });
  const server = createWalletServer({ fake, routes: [(request, url) => (url.pathname.startsWith('/api/read/') ? read.handle(request, url) : undefined)] });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fake.origin = origin;
  const context = await browser.newContext({ viewport: { width: 1320, height: 1000 } });
  // The recording and its age are fixed, not silently promoted to today's live chain.
  // Playwright's clock stubs User Timing too. Fix only Date so elapsed measurements stay native.
  await context.addInitScript((now) => {
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [now])); }
      static now() { return now; }
    };
  }, (NOW + 5) * 1000);
  let held = false, release;
  const heldPaths = [];
  const gate = new Promise((done) => { release = done; });
  await routeChain(context, chain);
  // Changed on purpose 2026-10-01 (RPC-SPEC): the page's reads are the site's own chain routes, whose answers the edge
  // keeps (a state 10 s), so the reload's reads are held at the routes, not at the chain behind them.
  await context.route((url) => /^\/api\/(?:owned\/v2\/positions|fees\/(?:v1\/state|v2\/ledger)|automation\/v1\/(?:state|record))$/.test(url.pathname), async (route) => {
    if (held) { heldPaths.push(new URL(route.request().url()).pathname); await gate; }
    return route.fallback();
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}/#/positions/${ID}`);
    await page.locator('[data-fees-state="verified"]').waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => performance.getEntriesByType('measure').some((e) => e.name.startsWith('domino:load:') && e.name.endsWith(':chart:current')), null, { timeout: 10_000 });
    const cold = await page.evaluate(() => performance.getEntriesByType('measure').filter((e) => e.name.startsWith('domino:load:')).map((e) => ({ name: e.name, ms: e.duration })));
    assert.ok(cold.some((e) => e.name.endsWith(':chart:current')), 'a drawn chart, not a completed request, records readiness');
    const saved = await page.evaluate(() => localStorage.getItem('domino:public-fee-history:2'));
    assert.ok(saved, 'only a completed verified public history is saved');
    assert.ok(!saved.toLowerCase().includes(HOLDER.slice(2)), 'no wallet ownership is persisted with the chart');
    assert.equal(await page.locator('[data-position-actions]').count(), 0);
    const firstCount = chain.log.length;
    held = true;
    await page.reload();
    const cached = page.locator('[data-fees-state="cached"]');
    await cached.waitFor({ timeout: 10_000 });
    copyShown = true;
    // Its periods from the points it kept (24H starts at the mint, a measured point a day old), with nothing read for them.
    assert.deepEqual(await cached.getByRole('radio').allInnerTexts(), ['24H', '7D', 'All']);
    assert.equal(await cached.getAttribute('data-fees-period-state'), 'drawn');
    await page.waitForFunction(() => performance.getEntriesByType('measure').some((e) => e.name.startsWith('domino:load:') && e.name.endsWith(':chart:cached')), null, { timeout: 10_000 });
    assert.match(await cached.innerText(), /saved|snapshot/i);
    assert.equal(await page.locator('[data-position-actions]').count(), 0, 'a snapshot is never financial authority');
    assert.equal(await page.locator('[data-position-detail]').count(), 0, 'saved history cannot populate live principal or owner');
    assert.equal(chain.log.length, firstCount, 'the cached plot is visible without a new successful chain read');
    // Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the page asks the state and the ledger together; the saved chart
    // starts no automation lookup of its own.
    assert.ok(!heldPaths.includes('/api/automation/v1/state'), `the early chart starts no automation lookup: ${heldPaths.join(', ')}`);
    assert.ok(heldPaths.filter((path) => path === '/api/fees/v1/state').length <= 1, 'one state read');
    const warm = await page.evaluate(() => performance.getEntriesByType('measure').filter((e) => e.name.startsWith('domino:load:')).map((e) => ({ name: e.name, ms: e.duration })));
    assert.ok(warm.some((e) => e.name.endsWith(':chart:cached')));
    assert.ok(!warm.some((e) => e.name.endsWith(':chart:current')), 'saved must not be counted as current');
    t.diagnostic(`Recorded fixture: cold verified chart ${Math.round(cold.find((e) => e.name.endsWith(':chart:current')).ms)} ms; reload saved chart ${Math.round(warm.find((e) => e.name.endsWith(':chart:cached')).ms)} ms, RPC still held. This is not a live-site benchmark.`);
    assert.deepEqual(past.filter((one) => one.copyShown), [], 'a saved copy reads nothing at a past block');
    held = false; release();
    await page.locator('[data-fees-state="verified"]').waitFor({ timeout: 60_000 });
    copyShown = false;
    assert.equal(await page.locator('[data-fees-state="cached"]').count(), 0);
    assert.deepEqual(await page.locator('[data-fees-state="verified"]').getByRole('radio').allInnerTexts(), ['24H', '7D', 'All'], 'the same periods, current');
    assert.deepEqual(errors, []);
    assert.deepEqual(chain.refused, []);
  } finally {
    held = false; release();
    await context.close();
    await server.closeAll();
  }
});
