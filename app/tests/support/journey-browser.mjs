/**
 * TEST-ONLY. New position in a build that carries Domino V2 (wallet-test-v2, `.wallet-test-v2-dist`: `__DOMINO_V2__` and
 * the test hooks on), served on 127.0.0.1 with the fake session service, a fake V2 chain (./v2-chain.mjs) announced as
 * an EIP-6963 wallet (the pattern of tests/position-actions.browser.test.mjs), and `window.__dominoV2Test` set by an init
 * script the way the integration's gate reads it in test builds (src/v2/gate.ts V2GateTestHooks):
 *   - `originOpen: true` opens the gate on the test server's origin;
 *   - `contracts` + `backendOn` make a chain `live` on the fake chain's own contracts (else the chain is `preview`, on the
 *     fixture manifests, and runs to the review only);
 *   - `s1.plan`: the plan answered by a node planner through an exposed function (src/v2in/journey/source.ts reads it in
 *     test builds, standing in for the plan route);
 *   - `read6` (2026-10-06): read-v6's chain reads (`chainReads`, ./chain-reads.mjs) answered the same way, for the routes
 *     it serves (src/v2in/dataSource.ts: a script serves the chain reads it scripts, and only those).
 *
 * Every request to any host but the page's own is refused and recorded (`foreign`), every CSP violation recorded (`csp`),
 * every page error recorded (`errors`); `close()` asserts all three are empty. No network.
 */
import assert from 'node:assert/strict';
import { createFakeSession } from './fake-session.mjs';
import { createWalletServer } from './wallet-server.mjs';
import { ARTWORK } from './new-position.mjs';

export const WALLET_NAME = 'Journey Wallet';

/**
 * Opens New position (`hash`, `#/new` by default) of `dist` with `chain` as the wallet. `live`: the chains (ids) whose gate
 * is `live` on `contracts`; every other open chain is `preview`. `planner(request)`: the plan answer (a body,
 * `{ status, body }`, or undefined). `intercept(method, params)`: a reply that replaces the chain's for one request.
 * `originOpen` false leaves the gate closed (today's journey exactly). `read6` (2026-10-06): more of read-v6's routes,
 * `{ route: (request) => answer }`, for the position's own page a test opens from New position's success. `planner` null
 * (2026-10-06): no planner stands in for the plan route, so the owner's journey asks the plan for a signed-in session only,
 * as the site does (src/v2in/journey/source.ts testPlannerOn); the wallet a suite connects stays signed out.
 */
export async function openJourney(browser, chain, { dist, hash = '#/new', planner = () => undefined, intercept = () => undefined, contracts = {}, live = [], originOpen = true, connect = true, routes = [], viewport = { width: 1280, height: 1000 }, zapOnRobinhood = false, artwork = false, chainReads = null, read6 = null, dex = null } = {}) {
  const fake = createFakeSession();
  const server = createWalletServer({ fake, dist, routes });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  fake.origin = origin;
  const context = await browser.newContext({ viewport });
  const foreign = [], csp = [], errors = [], planned = [];
  await context.route((url) => !url.href.startsWith(origin), (route) => {
    foreign.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  // `artwork` (2026-10-05): today's journey asks DexScreener for token artwork, as the V1 suites answer it (an empty list);
  // registered after the refusal above, so it is asked first. `dex(url)` (2026-10-06): DEX Screener's own answer for a
  // URL instead, a body (token-pairs) or `{ image, contentType }` (an artwork image), else nothing found; every URL asked
  // is kept in `dexAsked`.
  const dexAsked = [];
  if (artwork || dex) {
    await context.route(ARTWORK, async (route) => {
      const url = route.request().url();
      dexAsked.push(url);
      const said = dex ? await dex(url) : undefined;
      if (said && said.image !== undefined) return route.fulfill({ status: 200, contentType: said.contentType ?? 'image/svg+xml', body: said.image });
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(said ?? []) });
    });
  }
  await context.exposeFunction('__dominoJourneyWallet', async (method, params) => (await intercept(method, params)) ?? chain.request(method, params));
  await context.exposeFunction('__dominoJourneyPlan', async (request) => {
    planned.push(request);
    return planner?.(request);
  });
  await context.exposeFunction('__dominoJourneyCsp', (text) => csp.push(text));
  // read-v6's chain reads (2026-10-06): `chainReads.answer(route, request)`, for the three routes, when a suite hands one in;
  // and any other route a suite scripts (`read6`), answered the same way.
  const scripted = { ...(chainReads ? Object.fromEntries(['chain-pools', 'chain-balances', 'chain-tokens'].map((route) => [route, (request) => chainReads.answer(route, request)])) : {}), ...(read6 ?? {}) };
  const chainRoutes = Object.keys(scripted);
  if (chainRoutes.length) await context.exposeFunction('__dominoChainRead', async (route, request) => (await scripted[route](request)) ?? null);
  const sets = Object.fromEntries(live.map((id) => [id, contracts[id]]));
  // `zapOnRobinhood` (2026-10-05): the zap path's screens on Robinhood Chain, which the owner's journey keeps out of every
  // deployable build (src/v2in/journey/NewPositionV2.tsx).
  await context.addInitScript(({ sets, liveOn, originOpen, name, zapOnRobinhood, chainRoutes, planning }) => {
    const read6 = chainRoutes.length ? { read6: Object.fromEntries(chainRoutes.map((route) => [route, (request) => window.__dominoChainRead(route, request).then((said) => said ?? undefined)])) } : {};
    const s1 = planning ? { s1: { plan: (request) => window.__dominoJourneyPlan(request) } } : {};
    window.__dominoV2Test = { originOpen, ...(liveOn ? { contracts: sets, backendOn: true } : {}), ...s1, journey: { zapOnRobinhood }, ...read6 };
    document.addEventListener('securitypolicyviolation', (event) => window.__dominoJourneyCsp(`${event.violatedDirective} ${event.blockedURI}`));
    const provider = {
      async request({ method, params }) {
        const reply = await window.__dominoJourneyWallet(method, params ?? []);
        if (reply.error) throw Object.assign(new Error(reply.error.message), { code: reply.error.code, data: reply.error.data });
        return reply.result;
      },
      on() { return provider; },
      removeListener() { return provider; },
    };
    const detail = Object.freeze({ info: Object.freeze({ uuid: '8f2a7d1c-0000-4000-8000-0000000000e3', name, icon: 'data:image/svg+xml,%3Csvg xmlns="http://www.w3.org/2000/svg"/%3E', rdns: 'test.wallet.journey' }), provider });
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail }));
    window.addEventListener('eip6963:requestProvider', announce);
    announce();
  }, { sets, liveOn: live.length > 0, originOpen, name: WALLET_NAME, zapOnRobinhood, chainRoutes, planning: planner !== null });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const s = {
    page, context, origin, foreign, csp, errors, planned, dexAsked,
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
