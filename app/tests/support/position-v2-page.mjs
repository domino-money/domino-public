/**
 * TEST-ONLY. The position page's Domino V2 parts in a V2-compiled test build (src/v2in/position, the integration of
 * 2026-10-02), served on the loopback host with the fake session service, a fake chain announced as an EIP-6963 wallet
 * (the pattern of tests/support/s1-browser.mjs openS1), and `window.__dominoV2Test` set by an init script:
 *   - `originOpen: true`, which opens the gate on the test server's origin (src/v2/gate.ts V2GateTestHooks);
 *   - with `live` (the default), `contracts` (the fake chain's own set per chain) and `backendOn: true`: the chain is
 *     `live`, its sends run against the fake chain; without it the chain is `preview` (the fixture manifests, every send
 *     locked, the packages' own test data);
 *   - `read6` and `plan` (with `script`, the default under `live`): what the page's data reads instead of the site's
 *     routes (src/v2in/transports.ts, test builds only), the plan answered by a node planner through an exposed
 *     function; without them the preview reads the packages' own fixtures; `s1` more of the S1 hooks (`directCode`), as
 *     plain data.
 * `open: false` leaves the gate closed (no `originOpen`): the route is V1's.
 *
 * Every request to any host but the page's own is refused and recorded (`foreign`), every CSP violation recorded
 * (`csp`), every page error recorded (`errors`); `close()` asserts all three are empty. V1's optional token artwork
 * lookups at DEX Screener (src/lib/tokenArtwork.ts, which V1's suites answer the same way: tests/support/new-position.mjs
 * ARTWORK) are answered with nothing found and recorded apart (`artwork`).
 */
import assert from 'node:assert/strict';
import { createFakeSession } from './fake-session.mjs';
import { contractsFor } from './v2-chain.mjs';
import { WALLET_V2_DIST } from './wallet-dist.mjs';
import { createWalletServer } from './wallet-server.mjs';
import { confirmationRoute } from './confirmation-route.mjs';

export const WALLET_NAME = 'Position V2 Wallet';
/** DEX Screener's API and images, where V1's optional token artwork is looked up (tests/support/new-position.mjs ARTWORK). */
const ARTWORK = /^https:\/\/(api|cdn)\.dexscreener\.com\//;

export async function openPositionPage(browser, chain, { dist = WALLET_V2_DIST, hash, read6 = {}, planner = () => undefined, intercept = () => undefined, live = true, open = true, script = live, contracts, connect = true, viewport = { width: 1180, height: 960 }, s1 = {}, routes = [], creations = [], prepare = null, locale = null } = {}) {
  const fake = createFakeSession();
  const server = createWalletServer({ fake, dist, routes: [...routes, confirmationRoute(chain)] });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fake.origin = origin;
  // `locale` (2026-11-02, review M4): the browser's language, which says how a typed decimal comma is read; Chrome's own otherwise.
  const context = await browser.newContext({ viewport, ...(locale ? { locale } : {}) });
  const foreign = [], csp = [], errors = [];
  const artwork = [];
  await context.route((url) => !url.href.startsWith(origin), (route) => {
    foreign.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  // Registered after the blocker, so it answers first: the artwork lookups only.
  await context.route(ARTWORK, (route) => {
    artwork.push(route.request().url());
    return route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
  });
  const planned = [];
  await context.exposeFunction('__dominoPositionV2Wallet', async (method, params) => (await intercept(method, params)) ?? chain.request(method, params));
  await context.exposeFunction('__dominoPositionV2Plan', async (request) => {
    planned.push(request);
    return planner(request);
  });
  await context.exposeFunction('__dominoPositionV2Csp', (text) => csp.push(text));
  const sets = contracts ?? { 4663: contractsFor(4663), 8453: contractsFor(8453), 42161: contractsFor(42161) };
  await context.addInitScript(({ sets, read6, name, extra, live, open, script, creations }) => {
    for (const row of creations) {
      const key = `domino:created-positions:v1:${row.wallet.toLowerCase()}`;
      if (!sessionStorage.getItem(key)) sessionStorage.setItem(key, JSON.stringify(creations.filter(item => item.wallet.toLowerCase() === row.wallet.toLowerCase())));
    }
    window.__dominoV2Test = {
      ...(open ? { originOpen: true } : {}),
      ...(live ? { contracts: sets, backendOn: true } : {}),
      ...(script ? { read6, plan: (request) => window.__dominoPositionV2Plan(request) } : {}),
      s1: { ...extra },
    };
    document.addEventListener('securitypolicyviolation', (event) => window.__dominoPositionV2Csp(`${event.violatedDirective} ${event.blockedURI}`));
    const provider = {
      async request({ method, params }) {
        const reply = await window.__dominoPositionV2Wallet(method, params ?? []);
        if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code, data: reply.error.data });
        return reply.result;
      },
      on() { return provider; },
      removeListener() { return provider; },
    };
    const detail = Object.freeze({ info: Object.freeze({ uuid: '8f2a7d1c-0000-4000-8000-0000000000e3', name, icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E', rdns: 'test.wallet.positionv2' }), provider });
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  }, { sets, read6, name: WALLET_NAME, extra: s1, live, open, script, creations });
  // (2026-10-15, pack 7): `prepare(context, origin)` runs before the page's first load, for a route of the test's own
  // (the DEX resolver built as production builds it: tests/support/dex-edge-route.mjs edgeOnInTestBuild).
  if (prepare) await prepare(context, origin);
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const s = {
    page, context, origin, foreign, csp, errors, planned, artwork,
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
      await page.waitForFunction(() => ['no_wallet', 'signed_out', 'wrong_network'].includes(window.__dominoSessionProbe?.view().status));
      if (await page.evaluate(() => window.__dominoSessionProbe.view().status === 'no_wallet')) {
        // The header's Connect wallet, by its name (its `aria-haspopup` trigger is not findable in the V2 test build).
        await page.getByRole('button', { name: /Connect wallet/ }).first().click();
        await page.locator('[role="dialog"][aria-labelledby="wallet-dialog-title"]').getByRole('button', { name: `Connect ${WALLET_NAME}`, exact: true }).click();
        await page.waitForFunction(() => ['signed_out', 'wrong_network'].includes(window.__dominoSessionProbe?.view().status));
        await page.keyboard.press('Escape');
      }
    }
    return s;
  } catch (error) {
    await s.close().catch(() => {});
    throw error;
  }
}
