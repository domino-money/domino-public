/**
 * TEST-ONLY. New position in a build that carries Domino V2 (wallet-test-v2, `.wallet-test-v2-dist`: `__DOMINO_V2__` and
 * the test hooks on), served on 127.0.0.1 with the fake session service, a fake V2 chain (./v2-chain.mjs) announced as
 * an EIP-6963 wallet (the pattern of tests/position-actions.browser.test.mjs), and `window.__dominoV2Test` set by an init
 * script the way the integration's gate reads it in test builds (src/v2/gate.ts V2GateTestHooks):
 *   - `originOpen: true` opens the gate on the test server's origin;
 *   - `contracts` + `backendOn` make a chain `live` on the fake chain's own contracts (else the chain is `preview`, on the
 *     fixture manifests, and runs to the review only);
 *   - `s1.plan`: the plan answered by a node planner through an exposed function (src/v2in/journey/source.ts reads it in
 *     test builds, standing in for the plan route).
 *
 * Every request to any host but the page's own is refused and recorded (`foreign`), every CSP violation recorded (`csp`),
 * every page error recorded (`errors`); `close()` asserts all three are empty. No network.
 */
import assert from 'node:assert/strict';
import { createFakeSession } from './fake-session.mjs';
import { createWalletServer } from './wallet-server.mjs';

export const WALLET_NAME = 'Journey Wallet';

/**
 * Opens New position (`hash`, `#/new` by default) of `dist` with `chain` as the wallet. `live`: the chains (ids) whose gate
 * is `live` on `contracts`; every other open chain is `preview`. `planner(request)`: the plan answer (a body,
 * `{ status, body }`, or undefined). `intercept(method, params)`: a reply that replaces the chain's for one request.
 * `originOpen` false leaves the gate closed (today's journey exactly).
 */
export async function openJourney(browser, chain, { dist, hash = '#/new', planner = () => undefined, intercept = () => undefined, contracts = {}, live = [], originOpen = true, connect = true, routes = [], viewport = { width: 1280, height: 1000 } } = {}) {
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
  await context.exposeFunction('__dominoJourneyWallet', async (method, params) => (await intercept(method, params)) ?? chain.request(method, params));
  await context.exposeFunction('__dominoJourneyPlan', async (request) => {
    planned.push(request);
    return planner(request);
  });
  await context.exposeFunction('__dominoJourneyCsp', (text) => csp.push(text));
  const sets = Object.fromEntries(live.map((id) => [id, contracts[id]]));
  await context.addInitScript(({ sets, liveOn, originOpen, name }) => {
    window.__dominoV2Test = { originOpen, ...(liveOn ? { contracts: sets, backendOn: true } : {}), s1: { plan: (request) => window.__dominoJourneyPlan(request) } };
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
  }, { sets, liveOn: live.length > 0, originOpen, name: WALLET_NAME });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  const s = {
    page, context, origin, foreign, csp, errors, planned,
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
