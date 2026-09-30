/** Real browser over recorded public chain fixtures, never a live wallet or backend. */
import assert from 'node:assert/strict';
import { before, after, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeBrowser } from './support/close-browser.mjs';
import { createWalletServer } from './support/wallet-server.mjs';
import { createFakeSession } from './support/fake-session.mjs';
import { routeChain } from './support/browser-chain.mjs';
import { caseChain } from './support/fees/case-chain.mjs';

let browser;
before(async () => {
  for (const options of process.env.DOMINO_BROWSER_PATH ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }] : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}]) {
    try { browser = await chromium.launch({ ...options, headless: true }); break; } catch {}
  }
  if (!browser) throw new Error('A Chromium browser is required.');
});
after(async () => closeBrowser(browser));

test('a verified public chart survives reload as a labelled snapshot before the RPC answers, then becomes a fresh replay', { timeout: 120_000 }, async (t) => {
  const chain = caseChain('3325113');
  const fake = createFakeSession();
  const server = createWalletServer({ fake });
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
  }, (chain.fixture.state.timestamp + 5) * 1000);
  const rawFetch = chain.fetch;
  let held = false, heldRequests = 0, release;
  const gate = new Promise((done) => { release = done; });
  chain.fetch = async (...args) => { if (held) { heldRequests += 1; await gate; } return rawFetch(...args); };
  await routeChain(context, chain);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${origin}/#/positions/${chain.id}`);
    await page.locator('[data-fees-state="verified"]').waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => performance.getEntriesByType('measure').some((e) => e.name.startsWith('domino:load:') && e.name.endsWith(':chart:current')), null, { timeout: 10_000 });
    const cold = await page.evaluate(() => performance.getEntriesByType('measure').filter((e) => e.name.startsWith('domino:load:')).map((e) => ({ name: e.name, ms: e.duration })));
    assert.ok(cold.some((e) => e.name.endsWith(':chart:current')), 'a drawn chart, not a completed request, records readiness');
    const saved = await page.evaluate(() => localStorage.getItem('domino:public-fee-history:1'));
    assert.ok(saved, 'only a completed verified public replay is saved');
    assert.ok(!saved.includes(chain.fixture.state.positions[0].owner), 'no wallet ownership is persisted with the chart');
    assert.equal(await page.locator('[data-position-actions]').count(), 0);
    const firstCount = chain.log.length;
    held = true;
    await page.reload();
    const cached = page.locator('[data-fees-state="cached"]');
    await cached.waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => performance.getEntriesByType('measure').some((e) => e.name.startsWith('domino:load:') && e.name.endsWith(':chart:cached')), null, { timeout: 10_000 });
    assert.match(await cached.innerText(), /saved|snapshot/i);
    assert.equal(await page.locator('[data-position-actions]').count(), 0, 'a snapshot is never financial authority');
    assert.equal(await page.locator('[data-position-detail]').count(), 0, 'saved history cannot populate live principal or owner');
    assert.equal(chain.log.length, firstCount, 'the cached plot is visible without a new successful RPC response');
    assert.ok(heldRequests <= 1, 'the early chart shares the state read instead of starting an extra automation lookup');
    const warm = await page.evaluate(() => performance.getEntriesByType('measure').filter((e) => e.name.startsWith('domino:load:')).map((e) => ({ name: e.name, ms: e.duration })));
    assert.ok(warm.some((e) => e.name.endsWith(':chart:cached')));
    assert.ok(!warm.some((e) => e.name.endsWith(':chart:current')), 'saved must not be counted as current');
    t.diagnostic(`Recorded fixture: cold verified chart ${Math.round(cold.find((e) => e.name.endsWith(':chart:current')).ms)} ms; reload saved chart ${Math.round(warm.find((e) => e.name.endsWith(':chart:cached')).ms)} ms, RPC still held. This is not a live-site benchmark.`);
    held = false; release();
    await page.locator('[data-fees-state="verified"]').waitFor({ timeout: 60_000 });
    assert.equal(await page.locator('[data-fees-state="cached"]').count(), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(chain.refused, []);
  } finally {
    held = false; release();
    await context.close();
    await server.closeAll();
  }
});
