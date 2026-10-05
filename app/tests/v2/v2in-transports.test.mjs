/**
 * The integrated screens' data transports (src/v2in/dataSource.ts behind src/v2in/transports.ts; the base agent's item 5,
 * 2026-10-02): the gate's mode chooses, under the integration's data rule, never mixed:
 *
 *   - `off`: none;
 *   - `preview` and `live` alike: the site's routes only (real data only, the owner, 2026-10-02: no fixtures), each sent
 *     only while its capabilities serve it; an off route (disabled, not deployed, the gate, unavailable) is refused
 *     unsent with its reason, and `routeState` says why;
 *   - a test build's script replaces both, in either mode.
 * And the wiring: src/v2in/transports.ts hands in the page's routes (src/finance/v2/http.ts), the package's runtimes and
 * the test build's script (read only where __DOMINO_TEST_HOOKS__ is on).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as planRuntime from '../../../api-contracts/position-plan-v1/runtime.mjs';
import * as readRuntime from '../../../api-contracts/read-v6/runtime.mjs';

const require = createRequire(import.meta.url);
const APP = resolve(import.meta.dirname, '../..');
const BUILD = resolve(APP, '.test-build/app/src');
const { createV2Transports } = require(`${BUILD}/v2in/dataSource.js`);
const { readPortfolio, readActivity } = require(`${BUILD}/v2/read/v6.js`);
const { requestS1Plan } = require(`${BUILD}/v2/plan/client.js`);

const PLAN_FIXTURES = resolve(APP, '../api-contracts/position-plan-v1/fixtures');
const variant = (name) => JSON.parse(readFileSync(join(PLAN_FIXTURES, 'variants', `plan.${name}.json`), 'utf8'));
const CONNECTED = `0x${'c0'.repeat(20)}`;
const PREVIEW = Object.freeze({ mode: 'preview', chainId: 8453, contracts: {}, locked: true, lockedCopy: 'x' });
const LIVE = Object.freeze({ mode: 'live', chainId: 8453, contracts: {}, locked: false });
const OFF = Object.freeze({ mode: 'off' });
const RUNTIMES = { read: readRuntime, plan: planRuntime };

/** The site's routes as a fake: a probe answering `states`, and transports that record what reached them. */
function liveRoutes(states) {
  const reached = [];
  const asked = [];
  return {
    reached,
    asked,
    live: () => ({
      read: { kind: 'http', async post(route, body) { reached.push(['read', route, body]); return { status: 200, body: { route } }; } },
      plan: { kind: 'http', async plan(request) { reached.push(['plan', request]); return { status: 200, body: null }; } },
      probe: { async state(route) { asked.push(route); return states[route]; }, forget() {} },
    }),
  };
}
const noLive = () => assert.fail('the site\'s routes are never asked outside `live`');

test('off: no transports at all', () => {
  assert.equal(createV2Transports(OFF, { runtimes: RUNTIMES, live: noLive, script: () => null }), null);
});

test('preview: the same site routes as live (real data only; the owner, 2026-10-02), an off route refused unsent with its reason', async () => {
  const on = liveRoutes({ readV6: { on: true, routes: ['portfolio', 'activity'] }, plan: { on: true, routes: ['plan'] } });
  const t = createV2Transports(PREVIEW, { runtimes: RUNTIMES, live: on.live, script: () => null });
  assert.deepEqual([t.mode, t.source], ['preview', 'route']);
  assert.equal('exampleWallet' in t, false, 'every read is about the connected wallet: no example wallet, not even a null one');
  assert.deepEqual(await t.read.post('portfolio', { wallet: CONNECTED }), { status: 200, body: { route: 'portfolio' } });
  assert.deepEqual(on.reached.map(([kind]) => kind), ['read']);
  const off = liveRoutes({ readV6: { on: false, reason: 'not_deployed' }, plan: { on: false, reason: 'not_deployed' } });
  const p = createV2Transports(PREVIEW, { runtimes: RUNTIMES, live: off.live, script: () => null });
  await assert.rejects(p.read.post('portfolio', { wallet: CONNECTED }), /route_off_not_deployed/);
  assert.deepEqual(await p.routeState('readV6'), { on: false, reason: 'not_deployed' });
  assert.deepEqual(off.reached, [], 'nothing reached the route');
});

test('live: the site\'s routes only, each sent only while its capabilities serve it; an off route is refused unsent with its reason', async () => {
  const on = liveRoutes({ readV6: { on: true, routes: ['portfolio', 'activity'] }, plan: { on: true, routes: ['plan'] } });
  const t = createV2Transports(LIVE, { runtimes: RUNTIMES, live: on.live, script: () => null });
  assert.deepEqual([t.mode, t.source], ['live', 'route']);
  assert.equal('exampleWallet' in t, false);
  assert.deepEqual(await t.read.post('portfolio', { wallet: CONNECTED }), { status: 200, body: { route: 'portfolio' } });
  await t.plan.plan({ action: 'create' });
  assert.deepEqual(on.reached.map(([kind]) => kind), ['read', 'plan']);
  assert.deepEqual(on.asked, ['readV6', 'plan'], 'each asked of its capabilities first');

  for (const [label, states, refused] of [
    ['read-v6 switched off', { readV6: { on: false, reason: 'disabled' }, plan: { on: false, reason: 'not_deployed' } }, /route_off_disabled/],
    ['not deployed', { readV6: { on: false, reason: 'not_deployed' }, plan: { on: false, reason: 'not_deployed' } }, /route_off_not_deployed/],
    ['the beta gate', { readV6: { on: false, reason: 'gate_required' }, plan: { on: false, reason: 'gate_required' } }, /route_off_gate_required/],
    ['activity not enabled', { readV6: { on: true, routes: ['portfolio'] }, plan: { on: true, routes: ['plan'] } }, null],
  ]) {
    const routes = liveRoutes(states);
    const live = createV2Transports(LIVE, { runtimes: RUNTIMES, live: routes.live, script: () => null });
    if (refused) {
      await assert.rejects(live.read.post('portfolio', { wallet: CONNECTED }), refused, label);
      await assert.rejects(live.plan.plan({ action: 'create' }), /route_off_/, label);
      assert.deepEqual(routes.reached, [], `${label}: nothing reached the route`);
      assert.deepEqual(await live.routeState('readV6'), states.readV6, `${label}: the reason, for the screen's dash`);
      // Through the read client: a dash (unavailable), never the fixtures.
      assert.deepEqual(await readPortfolio(live.read, live.readRuntime, CONNECTED), { kind: 'unavailable', reason: 'network' });
    } else {
      await assert.rejects(live.read.post('activity', { wallet: CONNECTED }), /route_off/, label);
      assert.deepEqual(await live.read.post('portfolio', { wallet: CONNECTED }), { status: 200, body: { route: 'portfolio' } }, `${label}: portfolio still served`);
    }
  }
});

test('a test build\'s script replaces both, in either mode; the routes and the package\'s fixtures are then never used', async () => {
  const body = JSON.parse(readFileSync(resolve(APP, '../api-contracts/read-v6/fixtures/valid/portfolio-behind.json'), 'utf8'));
  for (const gate of [PREVIEW, LIVE]) {
    const asked = [];
    const t = createV2Transports(gate, {
      runtimes: RUNTIMES,
      live: noLive,
      script: () => ({ read6: { portfolio: { status: 200, body } }, plan: (request) => { asked.push(request); return request.action === 'create' ? { status: 503, body: { error: 'upstream_unavailable' } } : undefined; } }),
    });
    assert.equal(t.source, 'scripted');
    assert.equal('exampleWallet' in t, false);
    assert.deepEqual(await t.read.post('portfolio', { wallet: body.wallet }), { status: 200, body });
    await assert.rejects(t.read.post('activity', { wallet: body.wallet }), /no read-v6 answer scripted/, 'a read not scripted is refused');
    assert.deepEqual(await t.plan.plan({ action: 'create' }), { status: 503, body: { error: 'upstream_unavailable' } });
    await assert.rejects(t.plan.plan({ action: 'exit' }), /no plan scripted/);
    assert.deepEqual(await t.routeState('plan'), { on: true, routes: ['portfolio', 'activity', 'plan'] });
  }
});

test('the wiring: transports.ts hands in the page\'s routes, the package\'s runtimes and the test build\'s script, read only where the test hooks are on', () => {
  const source = readFileSync(join(APP, 'src/v2in/transports.ts'), 'utf8');
  assert.match(source, /live: \(\) => \(\{ read: liveReadV6Transport\(\), plan: livePlanTransport\(\), probe: \(probe \?\?= v2RouteProbe\(\)\) \}\)/);
  assert.match(source, /import \* as planRuntime from 'api-contracts\/position-plan-v1\/runtime\.mjs'/);
  assert.match(source, /import \* as readRuntime from 'api-contracts\/read-v6\/runtime\.mjs'/);
  assert.match(source, /if \(!TEST_HOOKS \|\| typeof window === 'undefined'\) return null/, 'the script is read only in a test build');
  assert.match(source, /const TEST_HOOKS: boolean = typeof __DOMINO_TEST_HOOKS__ === 'boolean' && __DOMINO_TEST_HOOKS__/);
  assert.doesNotMatch(source, /\bfetch\(|\.request\(|from '\.\.\/(?:session|wallet)\//, 'no fetch, no wallet, no session of its own');
  const core = readFileSync(join(APP, 'src/v2in/dataSource.ts'), 'utf8');
  const imports = [...core.matchAll(/^import[^;]*?from '([^']+)'/gm)].map((match) => match[1]);
  assert.deepEqual(imports.filter((spec) => /session|wallet|finance|runtime\.mjs|lib\//.test(spec)), [], 'the choice is pure: what it needs is handed in');
  const code = core.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\bfetch\(|\.request\(|\bwindow\b/, 'no fetch, no wallet, no page');
});
