/**
 * The wallet-test-v2 build in a browser (Domino V2 integration, 2026-10-02, the base agent's item 3): the wallet-test
 * build with V2 compiled in, the build V1's suites run on again (scripts/v1-on-v2.mjs) and V2's integrated screens' own
 * browser suites run on (`npm run test:v2in`, this directory). It proves the harness, so a failure in a screen's suite
 * is the screen's:
 *
 *   - the page is marked as a V2 build (vite.config.ts v2BuildMark), which every release refuses;
 *   - served as the wallet suites serve it (tests/support/wallet-server.mjs: the production CSP, the fake session), V1's
 *     Home draws with no page error and no CSP violation;
 *   - tests/support/v2-gate-open.mjs, the preload of the V1 runs, opens V2's gate through the test build's own hook
 *     (`window.__dominoV2Test.originOpen`) in every page before its first script, and keeps whatever else a suite set.
 *
 * A screen's suite opens the gate itself: `context.addInitScript(() => { window.__dominoV2Test = { originOpen: true,
 * contracts: { 4663: <a fake chain's V2Contracts> }, backendOn: true } })` makes that chain `live` on the fake chain's
 * set (src/v2/gate.ts); `originOpen` alone leaves it `preview` (the fixture set, locked at the review).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';
import { closeBrowser } from '../support/close-browser.mjs';
import { WALLET_V2_DIST } from '../support/wallet-dist.mjs';

const APP = resolve(import.meta.dirname, '../..');
if (!existsSync(join(WALLET_V2_DIST, 'index.html'))) throw new Error('.wallet-test-v2-dist is missing. Run npm run build:wallet-test-v2 first (npm run test:v2in does).');
// The server takes the production CSP from the compiled middleware (the unit build, as every browser suite needs).
if (!existsSync(resolve(APP, '.test-build/app/functions/_middleware.js'))) execFileSync(process.execPath, ['scripts/test.mjs', '--build-only'], { cwd: APP, stdio: 'ignore' });
const { createFakeSession } = await import('../support/fake-session.mjs');
const { createWalletServer } = await import('../support/wallet-server.mjs');

const LAUNCHES = process.env.DOMINO_BROWSER_PATH ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }] : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}];

let browser;
let server;
let origin;

before(async () => {
  // The V1 runs' preload, as scripts/v1-on-v2.mjs loads it: it patches this process's chromium before the launch.
  await import('../support/v2-gate-open.mjs');
  for (const options of LAUNCHES) {
    try {
      browser = await chromium.launch({ ...options, headless: true });
      break;
    } catch {
      // the next build
    }
  }
  if (!browser) throw new Error('A Chromium browser is required. Set DOMINO_BROWSER_PATH.');
  const fake = createFakeSession();
  server = createWalletServer({ fake, dist: WALLET_V2_DIST });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  origin = `http://127.0.0.1:${server.address().port}`;
  fake.origin = origin;
});

after(async () => {
  await closeBrowser(browser);
  await server?.closeAll();
});

test('the build is marked as a V2 build, which every release refuses', async () => {
  const page = readFileSync(join(WALLET_V2_DIST, 'index.html'), 'utf8');
  assert.match(page, /<html data-v2-build="wallet-test-v2" lang="en">/);
  const { findForbidden } = await import('../../scripts/deploy-markers.mjs');
  assert.ok(findForbidden(page).some((hit) => hit.marker === 'V2 build'));
});

test('V1\'s Home draws on it with V2\'s gate opened by the preload, no page error and no CSP violation', async () => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // What a suite may have set already is kept by the preload's hook, which every page of this context starts with too.
  await context.addInitScript(() => {
    window.__dominoV2Test = { ...(window.__dominoV2Test ?? {}), marker: 'kept' };
  });
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error' && /Content Security Policy|Refused to/.test(message.text())) problems.push(`csp: ${message.text()}`);
  });
  try {
    await page.goto(`${origin}/#/`);
    await page.waitForSelector('header', { timeout: 30_000 });
    assert.equal(await page.evaluate(() => document.documentElement.dataset.v2Build), 'wallet-test-v2');
    assert.deepEqual(await page.evaluate(() => window.__dominoV2Test), { originOpen: true, marker: 'kept' });
    const direct = await browser.newPage();
    try {
      await direct.goto(`${origin}/#/`);
      assert.deepEqual(await direct.evaluate(() => window.__dominoV2Test), { originOpen: true }, 'a page opened without a context of its own too');
    } finally {
      await direct.close();
    }
    assert.deepEqual(problems, []);
  } finally {
    await context.close();
  }
});
