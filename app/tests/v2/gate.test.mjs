/**
 * src/v2/gate.ts, the S2 gate (Changed on purpose (data) 2026-10-02 (S2 wired), spec F7 §3.1): deposits from another
 * network use no Domino contract on any chain, so their gate is the crosschain route's own word (src/v2/routes.ts, the
 * Worker's capabilities) and never a manifest: `live` where the route serves origins and quote, `preview` otherwise,
 * still only on the preview alias and the development server and only for a V2 chain. Every other service's gate is as
 * it was (the manifest and the backend's word). The probe is handed in, as the origin is; a compile outside Vite never
 * reaches the page's.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const BUILD = resolve(import.meta.dirname, '../../.test-build/app/src');
const PREVIEW_ALIAS = 'https://preview.domino-app-e65.pages.dev';
const DEV_ORIGIN = 'http://localhost:5273';

/** The gate module loaded fresh with V2 compiled `on` (src/v2/flag.ts reads the define once, at load). */
function gateWith(on) {
  const paths = ['v2/gate.js', 'v2/capabilities.js', 'v2/flag.js'].map((name) => require.resolve(resolve(BUILD, name)));
  for (const path of paths) delete require.cache[path];
  globalThis.__DOMINO_V2__ = on;
  try {
    return require(resolve(BUILD, 'v2/gate.js'));
  } finally {
    delete globalThis.__DOMINO_V2__;
    for (const path of paths) delete require.cache[path];
  }
}

/** A probe answering `state` for the crosschain route, recording what it was asked. */
function probe(state) {
  const asked = [];
  return { asked, routes: async () => ({ state: async (route) => { asked.push(route); if (state instanceof Error) throw state; return state; } }) };
}
const ON = (routes) => ({ on: true, routes });
const OFF = (reason) => ({ on: false, reason });

test('S2 is live exactly where the crosschain route serves origins and quote; preview otherwise, with the offer\'s own lock in mind', async () => {
  const { v2Gate, s2RouteOpen } = gateWith(true);
  for (const [state, expected] of [
    [ON(['origins', 'quote', 'status']), 'live'],
    [ON(['origins', 'quote']), 'live'],
    [ON(['status']), 'preview'],
    [ON(['origins']), 'preview'],
    [ON(['quote', 'status']), 'preview'],
    [OFF('disabled'), 'preview'],
    [OFF('not_deployed'), 'preview'],
    [OFF('unavailable'), 'preview'],
    [OFF('gate_required'), 'preview'],
    [OFF('invalid'), 'preview'],
    [new Error('the probe failed'), 'preview'],
  ]) {
    const p = probe(state);
    const gate = await v2Gate('s2', 4663, PREVIEW_ALIAS, p.routes);
    assert.equal(gate.mode, expected, JSON.stringify(state instanceof Error ? 'throws' : state));
    assert.deepEqual(p.asked, ['crosschain'], 'the crosschain route, once');
    assert.equal(gate.chainId, 4663);
    assert.equal(gate.locked, expected === 'preview');
    assert.ok(Object.isFrozen(gate));
    if (!(state instanceof Error)) assert.equal(s2RouteOpen(state), expected === 'live');
    if (expected === 'preview') assert.equal(gate.lockedCopy, 'This opens as soon as Domino\'s service is live on Robinhood Chain.');
  }
  // What a live S2 gate carries as contracts is never read by the offer (tests/v2/funds-source.test.mjs); S2 itself has
  // no Domino contract (spec F7 §3.1). Changed on purpose 2026-10-04 (V2 deployed, #327): Base's manifest is pinned, so
  // the set is the chain's production one (it was the fixture set the preview carries, marked as such).
  const live = await v2Gate('s2', 8453, PREVIEW_ALIAS, probe(ON(['origins', 'quote', 'status'])).routes);
  assert.equal(live.mode, 'live');
  assert.equal(live.contracts.fixture, false);
  assert.equal(live.contracts.chainId, 8453);
  assert.equal(live.contracts.deployment.admission, 'production');
});

test('S2 opens only on the site, the preview alias and the development server, only for a V2 chain, only in a build with V2: the probe is not even asked otherwise', async () => {
  const on = gateWith(true);
  // Changed on purpose 2026-10-04 (the owner: the site runs on V2): domino.money opens like the preview alias; a deployment's
  // own hash URL, an empty origin and the chains V2 does not serve stay off.
  for (const [chainId, origin] of [[4663, 'https://abc123.domino-app-e65.pages.dev'], [4663, ''], [1, PREVIEW_ALIAS], [99801, DEV_ORIGIN], [4663, 'https://www.domino.money']]) {
    const p = probe(ON(['origins', 'quote', 'status']));
    assert.deepEqual(await on.v2Gate('s2', chainId, origin, p.routes), { mode: 'off' }, `${chainId} at ${origin || '(no origin)'}`);
    assert.deepEqual(p.asked, []);
  }
  for (const origin of ['https://domino.money', PREVIEW_ALIAS, DEV_ORIGIN]) {
    assert.equal((await on.v2Gate('s2', 42161, origin, probe(ON(['origins', 'quote', 'status'])).routes)).mode, 'live', origin);
  }
  const off = gateWith(false);
  const p = probe(ON(['origins', 'quote', 'status']));
  assert.deepEqual(await off.v2Gate('s2', 4663, PREVIEW_ALIAS, p.routes), { mode: 'off' }, 'a build without V2');
  assert.deepEqual(p.asked, []);
});

test('s2Gate is the offer\'s way in, with the page\'s probe; v2Gate(\'s2\') without a probe has no word and is preview', async () => {
  const { v2Gate, s2Gate } = gateWith(true);
  const p = probe(ON(['origins', 'quote', 'status']));
  assert.equal((await s2Gate(4663, p.routes, PREVIEW_ALIAS)).mode, 'live');
  assert.deepEqual(await s2Gate(4663, p.routes, 'https://abc123.domino-app-e65.pages.dev'), { mode: 'off' }, 'the same origin rule');
  assert.deepEqual(await s2Gate(1, p.routes, PREVIEW_ALIAS), { mode: 'off' }, 'the same chain rule');
  assert.deepEqual(p.asked, ['crosschain'], 'asked once, for the open gate alone');
  const without = await v2Gate('s2', 4663, PREVIEW_ALIAS);
  assert.equal(without.mode, 'preview', 'no probe handed in: the route has no word, S2 is preview');
  assert.equal(without.locked, true);
});

test('every other service keeps its gate: the manifest and the backend\'s word, never the route', async () => {
  const { v2Gate } = gateWith(true);
  // Changed on purpose 2026-10-04 (V2 deployed, #327): Robinhood's manifest is pinned, so each service asks its OWN route
  // for the backend's word (S1 the plan route, the vault and auto-exit read-v6; it asked none while no manifest was
  // pinned). The crosschain route's capabilities answered there are not that word: preview, locked.
  // Changed on purpose 2026-10-04 (the owner: the site runs on V2): a build that takes no fixture sets (this node build, as
  // a deployable one) carries the chain's pinned production set while locked; the fixture set is the fixture builds' alone.
  for (const [service, route] of [['s1', 'plan'], ['vault', 'readV6'], ['autoExit', 'readV6']]) {
    const p = probe(ON(['origins', 'quote', 'status']));
    const gate = await v2Gate(service, 4663, PREVIEW_ALIAS, p.routes);
    assert.equal(gate.mode, 'preview', `${service}: its own route does not say it is on`);
    assert.equal(gate.locked, true);
    assert.equal(gate.contracts.fixture, false);
    assert.equal(gate.contracts.deployment.admission, 'production');
    assert.deepEqual(p.asked, [route], `${service} asks its own route, never the crosschain route`);
  }
  // A build that takes the fixture sets (preview-v2, the test builds) carries the fixture set while locked.
  globalThis.__DOMINO_V2_FIXTURE_SETS__ = true;
  try {
    const fixtures = gateWith(true);
    const gate = await fixtures.v2Gate('s1', 4663, PREVIEW_ALIAS, probe(OFF('not_deployed')).routes);
    assert.equal(gate.mode, 'preview');
    assert.equal(gate.contracts.fixture, true);
  } finally {
    delete globalThis.__DOMINO_V2_FIXTURE_SETS__;
  }
});

// Added 2026-10-05 (rugged97: Robinhood Chain first). Changed on purpose the same day (rugged97, "pode ligar": Base and
// Arbitrum One passed their fork qualification, 15 of 15 plans exact on each, #342): the three chains.
test('S1 goes live where the planner plans, the three chains, on the plan route\'s word; off without it', async () => {
  const { v2Gate, S1_PLAN_CHAINS } = gateWith(true);
  assert.deepEqual(S1_PLAN_CHAINS, [4663, 8453, 42161]);
  for (const chainId of [4663, 8453, 42161]) {
    const on = probe(ON(['plan']));
    const live = await v2Gate('s1', chainId, PREVIEW_ALIAS, on.routes);
    assert.equal(live.mode, 'live', `${chainId}: the plan route on`);
    assert.equal(live.contracts.fixture, false);
    assert.equal(live.contracts.deployment.admission, 'production', 'the pinned set');
    assert.deepEqual(on.asked, ['plan']);
    const off = probe(OFF('disabled'));
    const preview = await v2Gate('s1', chainId, PREVIEW_ALIAS, off.routes);
    assert.equal(preview.mode, 'preview', `${chainId}: the plan route off`);
    assert.equal(preview.locked, true);
    // The vault and auto-exit are read-v6's, indexed on every chain.
    const read = probe(ON(['portfolio', 'activity']));
    assert.equal((await v2Gate('vault', chainId, PREVIEW_ALIAS, read.routes)).mode, 'live', `${chainId}: the vault follows read-v6`);
  }
});

test('the pure rule: origins and quote served, whatever else is', () => {
  const { s2RouteOpen } = gateWith(true);
  assert.equal(s2RouteOpen(ON(['origins', 'quote', 'status'])), true);
  assert.equal(s2RouteOpen(ON(['quote', 'origins'])), true);
  assert.equal(s2RouteOpen(ON(['origins', 'status'])), false);
  assert.equal(s2RouteOpen(ON([])), false);
  assert.equal(s2RouteOpen(OFF('disabled')), false);
});

test("the backend's word on the other services is their route's (2026-10-03): S1 the plan route, the vault and auto-exit read-v6; a probe that fails has no word", async () => {
  const { serviceRouteOpen } = gateWith(true);
  const plan = { plan: ON(['plan']), readV6: OFF('not_deployed') };
  const read = { plan: OFF('not_deployed'), readV6: ON(['portfolio', 'activity']) };
  const routesOf = (states) => async () => ({ state: async (route) => states[route] });
  assert.equal(await serviceRouteOpen('s1', routesOf(plan)), true);
  assert.equal(await serviceRouteOpen('vault', routesOf(plan)), false);
  assert.equal(await serviceRouteOpen('autoExit', routesOf(plan)), false);
  assert.equal(await serviceRouteOpen('s1', routesOf(read)), false);
  assert.equal(await serviceRouteOpen('vault', routesOf(read)), true);
  assert.equal(await serviceRouteOpen('autoExit', routesOf(read)), true);
  assert.equal(await serviceRouteOpen('vault', routesOf({ readV6: ON(['activity']) })), false, 'portfolio is the read the vault screens need');
  assert.equal(await serviceRouteOpen('s1', async () => { throw new Error('network'); }), false, 'a probe that fails has no word');
});
