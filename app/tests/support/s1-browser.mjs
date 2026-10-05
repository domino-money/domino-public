/**
 * TEST-ONLY. The S1 screens in the v2-test build (.v2-test-dist), served on 127.0.0.1 with the fake session service,
 * the fake V2 chain (./v2-chain.mjs) announced as an EIP-6963 wallet (the pattern of tests/position-actions.browser.test.mjs),
 * and `window.__dominoV2Test` set by an init script: the fake chain's own contracts per chain, `backendOn: true`, the
 * read-v6 answers (src/v2ui/read6.ts, built and validated by ./s1-read6.mjs) and the S1 plan answers
 * (src/v2ui/s1/source.ts), the plan answered by a node planner through an exposed function.
 *
 * Every request to any host but the page's own is refused and recorded (`foreign`), every CSP violation recorded
 * (`csp`), every page error recorded (`errors`); `close()` asserts all three are empty.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { createFakeSession } from './fake-session.mjs';
import { contractsFor } from './v2-chain.mjs';
import { createWalletServer } from './wallet-server.mjs';

export const APP = resolve(import.meta.dirname, '../..');
export const V2_DIST = resolve(APP, '.v2-test-dist');
export const WALLET_DIST = resolve(APP, '.wallet-test-dist');
export const PROD_DIST = resolve(APP, 'dist');
export const WALLET_NAME = 'S1 Wallet';

export async function launchBrowser() {
  for (const options of process.env.DOMINO_BROWSER_PATH ? [{ executablePath: process.env.DOMINO_BROWSER_PATH }] : [{ channel: 'chrome' }, { channel: 'chromium' }, { channel: 'msedge' }, {}]) {
    try { return await chromium.launch({ ...options, headless: true }); } catch { /* the next channel */ }
  }
  throw new Error('A Chromium browser is required.');
}

/** A build the suite needs and `npm run test:v2` does not make (the wallet-test and production builds), made once if missing. */
export function ensureBuild(dist, mode) {
  if (existsSync(resolve(dist, 'index.html'))) return;
  execFileSync(process.execPath, [resolve(APP, 'node_modules/vite/bin/vite.js'), 'build', '--mode', mode], { cwd: APP, stdio: 'ignore' });
}

/**
 * Opens `hash` of `dist` with `chain` as the wallet. `read6`: { portfolio?: { status, body }, activity?: { status, body } };
 * `planner(request)`: the plan answer (a body, `{ status, body }`, or undefined); `intercept(method, params)`: a reply that replaces the chain's for
 * one request, or undefined; `contracts`: the V2 contracts per chain (the fake chain's own by default); `s1`: more of
 * the S1 hooks (src/v2ui/s1/source.ts: `directCode`, `offer`), as plain data.
 */
export async function openS1(browser, chain, { dist = V2_DIST, hash = '#/v2/manage', read6 = {}, planner = () => undefined, intercept = () => undefined, contracts, connect = true, viewport = { width: 1180, height: 960 }, s1 = {} } = {}) {
  const fake = createFakeSession();
  const server = createWalletServer({ fake, dist });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fake.origin = origin;
  const context = await browser.newContext({ viewport });
  const foreign = [], csp = [], errors = [];
  await context.route((url) => !url.href.startsWith(origin), (route) => {
    foreign.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  const planned = [];
  await context.exposeFunction('__dominoS1Wallet', async (method, params) => (await intercept(method, params)) ?? chain.request(method, params));
  await context.exposeFunction('__dominoS1Plan', async (request) => {
    planned.push(request);
    return planner(request);
  });
  await context.exposeFunction('__dominoS1Csp', (text) => csp.push(text));
  const sets = contracts ?? { 4663: contractsFor(4663), 8453: contractsFor(8453), 42161: contractsFor(42161) };
  await context.addInitScript(({ sets, read6, name, extra }) => {
    window.__dominoV2Test = { contracts: sets, backendOn: true, read6, s1: { ...extra, plan: (request) => window.__dominoS1Plan(request) } };
    document.addEventListener('securitypolicyviolation', (event) => window.__dominoS1Csp(`${event.violatedDirective} ${event.blockedURI}`));
    const provider = {
      async request({ method, params }) {
        const reply = await window.__dominoS1Wallet(method, params ?? []);
        if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code, data: reply.error.data });
        return reply.result;
      },
      on() { return provider; },
      removeListener() { return provider; },
    };
    const detail = Object.freeze({ info: Object.freeze({ uuid: '8f2a7d1c-0000-4000-8000-0000000000e2', name, icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E', rdns: 'test.wallet.s1' }), provider });
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  }, { sets, read6, name: WALLET_NAME, extra: s1 });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const s = {
    page, context, origin, foreign, csp, errors, planned,
    /** Sets the read-v6 answers the page reads from now on. */
    async setRead6(next) { await page.evaluate((value) => { window.__dominoV2Test.read6 = value; }, next); },
    async close() {
      await context.close();
      await server.closeAll();
      assert.deepEqual(errors, [], 'no page error');
      assert.deepEqual(csp, [], 'no CSP violation');
      assert.deepEqual(foreign, [], 'no request to any host but the page’s own');
    },
  };
  try {
    await page.goto(`${origin}/${hash}`);
    if (connect) {
      // The fake wallet answers eth_accounts with its owner, as a wallet that already allowed this site: the page may
      // reconnect it by itself; otherwise the person connects it from the header.
      await page.waitForFunction(() => ['no_wallet', 'signed_out'].includes(window.__dominoSessionProbe?.view().status));
      if (await page.evaluate(() => window.__dominoSessionProbe.view().status === 'no_wallet')) {
        await page.locator('header [aria-haspopup="dialog"]').click();
        await page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: `Connect ${WALLET_NAME}`, exact: true }).click();
        await page.waitForFunction(() => window.__dominoSessionProbe?.view().status === 'signed_out');
        await page.keyboard.press('Escape');
      }
    }
    return s;
  } catch (error) {
    await s.close().catch(() => {});
    throw error;
  }
}
