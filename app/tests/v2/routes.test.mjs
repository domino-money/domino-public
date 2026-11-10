/**
 * src/v2/routes.ts (2026-10-02, the bridge side of spec F7 §2.4, §3.2 and §6.2): whether Domino V2's three API routes
 * are switched on, asked of their Workers' own capabilities. End to end through the real forwarder
 * (functions/_lib/bridge.ts) and the real Workers (bridge/src/worker.mjs, bridge/src/position-plan-worker.mjs,
 * bridge/src/crosschain-worker.mjs), with a tripwire as their upstream: nothing here leaves the process. Then each reply
 * the probe can meet, read, and the probe's one-minute memory.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createWorker } from '../../../bridge/src/worker.mjs';
import { createPositionPlanWorker } from '../../../bridge/src/position-plan-worker.mjs';
import { createCrosschainWorker } from '../../../bridge/src/crosschain-worker.mjs';
// Changed on purpose 2026-11-07 (day-9 rehearsal, finding F8): read-v6's versions are the package's own
// (api-contracts/read-v6/runtime.mjs), never literals, so a day-9 version move needs only docs/ELYSIUM_DAY9.md step 3.
import { CONTRACT_VERSION as V6_VERSION, NEXT_VERSION as V6_NEXT } from '../../../api-contracts/read-v6/runtime.mjs';
import { CONTRACT_VERSION as PLAN_VERSION } from '../../../api-contracts/position-plan-v1/runtime.mjs';
import { CONTRACT_VERSION as XC_VERSION } from '../../../api-contracts/crosschain-v1/runtime.mjs';

const require = createRequire(import.meta.url);
const routes = require('../../.test-build/app/src/v2/routes.js');
const { routeStateOf, askV2Route, routeServes, createV2RouteProbe, V2_ROUTE_SPECS, V2_ROUTE_MAX_BYTES, V2_ROUTE_TIMEOUT_MS, V2_ROUTE_REUSE_MS, V2_READ_ROUTE_REUSE_MS } = routes;
const { forward } = require('../../.test-build/app/functions/_lib/bridge.js');

const ORIGIN = 'https://domino.money';
const upstream = [];
const tripwire = async (url) => { upstream.push(String(url)); throw new Error('the probe reached for an upstream'); };
const READ = createWorker({ fetch: tripwire, getClientIp: (request) => request.headers.get('CF-Connecting-IP') });
const PLAN = createPositionPlanWorker({ fetch: tripwire });
const READ_OFF = { APP_ORIGIN: ORIGIN, GATEWAY_ORIGIN: 'https://vm-read.domino.money', READ_BRIDGE_ENABLED: 'false', READ_V6_BRIDGE_ENABLED: 'false', ENABLED_V6_READS: '' };
const READ_ON = { ...READ_OFF, READ_V6_BRIDGE_ENABLED: 'true', ENABLED_V6_READS: 'portfolio,activity', ACCESS_CLIENT_ID: 'placeholder-id', ACCESS_CLIENT_SECRET: 'placeholder-secret' };
const PLAN_OFF = { APP_ORIGIN: ORIGIN, POSITION_PLAN_BRIDGE_ENABLED: 'false', POSITION_PLAN_GATEWAY_ORIGIN: 'https://vm-position-plan.domino.money' };
const PLAN_ON = { ...PLAN_OFF, POSITION_PLAN_BRIDGE_ENABLED: 'true', POSITION_PLAN_ACCESS_CLIENT_ID: 'placeholder-id', POSITION_PLAN_ACCESS_CLIENT_SECRET: 'placeholder-secret' };
// Changed on purpose (data) 2026-10-02 (S2 wired): the crosschain Worker under bridge/wrangler.crosschain.toml's [vars], and on in memory.
const XC = createCrosschainWorker({ fetch: tripwire });
const XC_OFF = { APP_ORIGIN: ORIGIN, CROSSCHAIN_BRIDGE_ENABLED: 'false', CROSSCHAIN_GATEWAY_ORIGIN: 'https://vm-crosschain.domino.money' };
const XC_ON = { ...XC_OFF, CROSSCHAIN_BRIDGE_ENABLED: 'true', CROSSCHAIN_ACCESS_CLIENT_ID: 'placeholder-id', CROSSCHAIN_ACCESS_CLIENT_SECRET: 'placeholder-secret' };
const bound = (worker, settings) => ({ fetch: (request) => worker.fetch(request, settings) });

/** A RawGet as the page's same-origin GET reaches Pages: through forward(), read as lib/http reads a reply. */
function pageGet(env, seen = []) {
  return async (path, options) => {
    seen.push({ path, options });
    const response = await forward(new Request(`${ORIGIN}${path}`, { method: 'GET', headers: {
      ...options.headers, Host: 'domino.money', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
      'CF-Connecting-IP': '203.0.113.9',
    } }), env);
    return { kind: 'reply', reply: {
      status: response.status, opaqueRedirect: false, contentType: response.headers.get('Content-Type'),
      contractHeader: response.headers.get(options.contractHeader), requestIdHeader: null, retryAfterHeader: response.headers.get('Retry-After'),
      body: { kind: 'text', text: await response.text() },
    } };
  };
}

test('end to end, every state of both routes, through the real forwarder and Workers, with nothing sent upstream', async () => {
  const cases = [
    ['readV6', { READ_BRIDGE: bound(READ, READ_OFF) }, { on: false, reason: 'disabled' }],
    ['readV6', { READ_BRIDGE: bound(READ, READ_ON) }, { on: true, routes: ['portfolio', 'activity'] }],
    ['readV6', { READ_BRIDGE: bound(READ, { ...READ_ON, ENABLED_V6_READS: 'portfolio' }) }, { on: true, routes: ['portfolio'] }],
    ['readV6', { READ_BRIDGE: bound(READ, { ...READ_ON, ACCESS_CLIENT_SECRET: '' }) }, { on: false, reason: 'unavailable' }],
    ['readV6', {}, { on: false, reason: 'unavailable' }],
    // A read Worker deployed before read-v6 existed takes /api/read/v6/ for read-v1 and refuses it in read-v1's version.
    ['readV6', { READ_BRIDGE: { fetch: async () => new Response('{"error":"route_not_available"}', { status: 404,
      headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': '1.1.0-rc.3' } }) } }, { on: false, reason: 'not_deployed' }],
    // The plan route before its Worker is deployed and bound: exactly what an unowned path answers.
    ['plan', {}, { on: false, reason: 'not_deployed' }],
    ['plan', { POSITION_PLAN_BRIDGE: bound(PLAN, PLAN_OFF) }, { on: false, reason: 'disabled' }],
    ['plan', { POSITION_PLAN_BRIDGE: bound(PLAN, PLAN_ON) }, { on: true, routes: ['plan'] }],
    ['plan', { POSITION_PLAN_BRIDGE: bound(PLAN, { ...PLAN_ON, POSITION_PLAN_GATEWAY_ORIGIN: ORIGIN }) }, { on: false, reason: 'unavailable' }],
    ['plan', { POSITION_PLAN_BRIDGE: 'not a binding' }, { on: false, reason: 'unavailable' }],
    // The crosschain route, declared ahead of its Worker like the plan's: an unowned path until the Worker is bound.
    ['crosschain', {}, { on: false, reason: 'not_deployed' }],
    ['crosschain', { CROSSCHAIN_BRIDGE: bound(XC, XC_OFF) }, { on: false, reason: 'disabled' }],
    ['crosschain', { CROSSCHAIN_BRIDGE: bound(XC, XC_ON) }, { on: true, routes: ['origins', 'quote', 'status'] }],
    ['crosschain', { CROSSCHAIN_BRIDGE: bound(XC, { ...XC_ON, CROSSCHAIN_ACCESS_CLIENT_SECRET: '' }) }, { on: false, reason: 'unavailable' }],
    ['crosschain', { CROSSCHAIN_BRIDGE: 'not a binding' }, { on: false, reason: 'unavailable' }],
  ];
  for (const [route, env, expected] of cases) {
    const seen = [];
    assert.deepEqual(await askV2Route(route, pageGet(env, seen)), expected, `${route} ${JSON.stringify(Object.keys(env))} ${JSON.stringify(expected)}`);
    // Changed on purpose 2026-11-06 (read-v6 1.2.0-rc.1's window, src/v2/routes.ts): the read route is asked in 1.2.0-rc.1
    // first; a Worker that does not speak it (this branch's, which refuses it with a 502) is asked again in 1.1.0-rc.1.
    const versions = seen.map(({ options }) => options.headers[V2_ROUTE_SPECS[route].header]);
    if (route === 'readV6') assert.ok(versions.length === 1 ? versions[0] === V6_NEXT : versions.join() === `${V6_NEXT},${V6_VERSION}`, versions.join());
    else assert.deepEqual(versions, [V2_ROUTE_SPECS[route].version]);
  }
  assert.deepEqual(upstream, []);
});

test('askV2Route sends one GET of the route\'s capabilities, in its contract\'s version, within its limits', async () => {
  for (const [route, path, header, version] of [['readV6', '/api/read/v6/capabilities', 'X-Domino-Read-Contract', V6_VERSION],
    ['plan', '/api/position-plan/v1/capabilities', 'X-Domino-Position-Plan-Contract', PLAN_VERSION],
    ['crosschain', '/api/crosschain/v1/capabilities', 'X-Domino-Crosschain-Contract', XC_VERSION]]) {
    const seen = [];
    const controller = new AbortController();
    // Changed on purpose 2026-11-06: read-v6's 1.2.0-rc.1 first, then its own version, as before (src/v2/routes.ts), once
    // its Worker refused the first in its own version (review F2: a GET no Worker answered is not asked twice).
    const refusal = { kind: 'reply', reply: { status: 502, opaqueRedirect: false, contentType: 'application/json', contractHeader: V6_VERSION, requestIdHeader: null, retryAfterHeader: null, body: { kind: 'text', text: '{"error":"upstream_contract_mismatch"}' } } };
    await askV2Route(route, async (...args) => { seen.push(args); return route === 'readV6' && seen.length === 1 ? refusal : { kind: 'network' }; }, controller.signal);
    // Changed on purpose 2026-11-07 (day-9 rehearsal, finding F8): a package of one version (its NEXT_VERSION its own) has
    // no second version to ask: that refusal is then its own version's, asked once.
    assert.equal(seen.length, route === 'readV6' && V6_NEXT !== V6_VERSION ? 2 : 1);
    const [askedPath, options] = seen.at(-1);
    if (route === 'readV6') assert.deepEqual(seen[0][1].headers, { Accept: 'application/json', [header]: V6_NEXT });
    assert.equal(askedPath, path);
    assert.deepEqual(options.headers, { Accept: 'application/json', [header]: version });
    assert.equal(options.contractHeader, header);
    assert.equal(options.maxBytes, V2_ROUTE_MAX_BYTES);
    assert.equal(options.timeoutMs, V2_ROUTE_TIMEOUT_MS);
    assert.equal(options.signal, controller.signal);
    assert.equal(V2_ROUTE_SPECS[route].version, version);
  }
  assert.deepEqual(await askV2Route('plan', async () => { throw new Error('boom'); }), { on: false, reason: 'unavailable' }, 'a GET that throws');
});

const reply = (fields) => ({ kind: 'reply', reply: { status: 200, opaqueRedirect: false, contentType: 'application/json; charset=utf-8',
  contractHeader: null, requestIdHeader: null, retryAfterHeader: null, body: { kind: 'text', text: '' }, ...fields } });
const json = (value, fields = {}) => reply({ body: { kind: 'text', text: JSON.stringify(value) }, ...fields });
const V6_ON = { contractVersion: V6_VERSION, dataMode: 'live_read_only', chainIds: [4663, 8453, 42161], enabledReads: ['portfolio', 'activity'],
  walletAuthentication: false, privateAccounts: false, ownerTransactions: false, automation: false };
const PLAN_LIVE = { contractVersion: PLAN_VERSION, dataMode: 'live', enabledRoutes: ['plan'] };
const XC_LIVE = { contractVersion: XC_VERSION, dataMode: 'live', enabledRoutes: ['origins', 'quote', 'status'] };
const v6 = (value, status = 200) => json(value, { status, contractHeader: V6_VERSION });
const plan = (value, status = 200) => json(value, { status, contractHeader: PLAN_VERSION });
const xc = (value, status = 200) => json(value, { status, contractHeader: XC_VERSION });

test('only an exact capabilities answer is on; every other reply has its one reason', () => {
  for (const [route, result, expected] of [
    ['readV6', v6(V6_ON), { on: true, routes: ['portfolio', 'activity'] }],
    ['readV6', v6({ ...V6_ON, enabledReads: ['portfolio', 'activity', 'chain-pools', 'chain-balances', 'chain-tokens'] }),
      { on: true, routes: ['portfolio', 'activity', 'chain-pools', 'chain-balances', 'chain-tokens'] }],
    ['readV6', v6({ ...V6_ON, dataMode: 'disabled', enabledReads: [] }), { on: false, reason: 'disabled' }],
    ['plan', plan(PLAN_LIVE), { on: true, routes: ['plan'] }],
    ['plan', plan({ ...PLAN_LIVE, dataMode: 'disabled', enabledRoutes: [] }), { on: false, reason: 'disabled' }],
    // The route's own Worker saying the route is off.
    ['readV6', v6({ error: 'route_not_available' }, 404), { on: false, reason: 'disabled' }],
    ['plan', plan({ error: 'route_not_available' }, 404), { on: false, reason: 'disabled' }],
    ['plan', plan({ error: 'route_not_available', detail: 1 }, 404), { on: false, reason: 'unavailable' }],
    ['plan', plan({ error: 'method_not_allowed' }, 405), { on: false, reason: 'unavailable' }],
    // Nothing of this contract answers.
    ['plan', json({ error: 'not_found' }, { status: 404 }), { on: false, reason: 'not_deployed' }],
    ['readV6', json({ error: 'not_found' }, { status: 405 }), { on: false, reason: 'not_deployed' }],
    ['readV6', reply({ contentType: 'text/html; charset=utf-8', body: { kind: 'text', text: '<!doctype html>' } }), { on: false, reason: 'not_deployed' }],
    // The gate, the forwarder's 503, a Worker's refusal, a redirect, the network.
    ['plan', reply({ status: 401, body: { kind: 'text', text: '{"error":"beta_access_required"}' } }), { on: false, reason: 'gate_required' }],
    ['plan', reply({ status: 401, body: { kind: 'text', text: '{"error":"session_required"}' } }), { on: false, reason: 'unavailable' }],
    ['readV6', json({ error: 'bridge_unavailable' }, { status: 503 }), { on: false, reason: 'unavailable' }],
    ['readV6', reply({ status: 503, contentType: 'text/html', body: { kind: 'text', text: 'unavailable' } }), { on: false, reason: 'unavailable' }],
    ['readV6', v6({ error: 'upstream_unavailable' }, 503), { on: false, reason: 'unavailable' }],
    ['plan', plan({ error: 'origin_not_allowed' }, 403), { on: false, reason: 'unavailable' }],
    ['readV6', reply({ status: 0, opaqueRedirect: true }), { on: false, reason: 'unavailable' }],
    ['readV6', { kind: 'network' }, { on: false, reason: 'unavailable' }],
    ['readV6', { kind: 'timeout' }, { on: false, reason: 'unavailable' }],
    ['plan', { kind: 'aborted' }, { on: false, reason: 'aborted' }],
    // The contract's header, not its shape: never on.
    ['readV6', json(V6_ON, { contractHeader: '1.1.0-rc.3' }), { on: false, reason: 'invalid' }],
    ['plan', json(PLAN_LIVE, { contractHeader: '1.0.0-rc.1' }), { on: false, reason: 'invalid' }],
    ['readV6', v6({ ...V6_ON, contractVersion: '1.1.0-rc.3' }), { on: false, reason: 'invalid' }],
    ['readV6', v6({ ...V6_ON, chainId: 4663 }), { on: false, reason: 'invalid' }],
    ['readV6', v6({ ...V6_ON, chainIds: [8453, 4663, 42161] }), { on: false, reason: 'invalid' }],
    ['readV6', v6({ ...V6_ON, enabledReads: [] }), { on: false, reason: 'invalid' }],
    ['readV6', v6({ ...V6_ON, enabledReads: ['portfolio', 'portfolio'] }), { on: false, reason: 'invalid' }],
    ['readV6', v6({ ...V6_ON, enabledReads: ['portfolio', 'featured-pools'] }), { on: false, reason: 'invalid' }],
    ['readV6', v6({ ...V6_ON, dataMode: 'disabled' }), { on: false, reason: 'invalid' }],
    ['readV6', v6({ ...V6_ON, dataMode: 'live' }), { on: false, reason: 'invalid' }],
    ['readV6', v6({ ...V6_ON, walletAuthentication: true }), { on: false, reason: 'invalid' }],
    ['plan', plan({ ...PLAN_LIVE, enabledRoutes: ['plan', 'execute'] }), { on: false, reason: 'invalid' }],
    ['plan', plan({ ...PLAN_LIVE, dataMode: 'live_read_only' }), { on: false, reason: 'invalid' }],
    ['plan', plan({ ...PLAN_LIVE, chainIds: [8453] }), { on: false, reason: 'invalid' }],
    ['plan', plan([PLAN_LIVE]), { on: false, reason: 'invalid' }],
    ['plan', reply({ contractHeader: PLAN_VERSION, body: { kind: 'too_large' } }), { on: false, reason: 'invalid' }],
    ['plan', reply({ contractHeader: PLAN_VERSION, body: { kind: 'text', text: '{' } }), { on: false, reason: 'invalid' }],
    ['plan', reply({ contractHeader: PLAN_VERSION, contentType: 'text/plain', body: { kind: 'text', text: JSON.stringify(PLAN_LIVE) } }), { on: false, reason: 'invalid' }],
    // The crosschain route: the plan Worker's shape, with its three routes (a part of them served is on with that part).
    ['crosschain', xc(XC_LIVE), { on: true, routes: ['origins', 'quote', 'status'] }],
    ['crosschain', xc({ ...XC_LIVE, enabledRoutes: ['origins', 'quote'] }), { on: true, routes: ['origins', 'quote'] }],
    ['crosschain', xc({ ...XC_LIVE, dataMode: 'disabled', enabledRoutes: [] }), { on: false, reason: 'disabled' }],
    ['crosschain', xc({ error: 'route_not_available' }, 404), { on: false, reason: 'disabled' }],
    ['crosschain', json({ error: 'not_found' }, { status: 404 }), { on: false, reason: 'not_deployed' }],
    ['crosschain', json(XC_LIVE, { contractHeader: PLAN_VERSION }), { on: false, reason: 'invalid' }],
    ['crosschain', xc({ ...XC_LIVE, contractVersion: '1.0.0-rc.2' }), { on: false, reason: 'invalid' }],
    // Added 2026-10-06 (crosschain-v1 1.1.0-rc.1): a Worker still on 1.0.0-rc.1 keeps the offer locked until it moves.
    ['crosschain', json({ ...XC_LIVE, contractVersion: '1.0.0-rc.1' }, { contractHeader: '1.0.0-rc.1' }), { on: false, reason: 'invalid' }],
    ['crosschain', xc({ ...XC_LIVE, enabledRoutes: ['origins', 'quote', 'status', 'deposit'] }), { on: false, reason: 'invalid' }],
    ['crosschain', xc({ ...XC_LIVE, enabledRoutes: ['plan'] }), { on: false, reason: 'invalid' }],
    ['crosschain', xc({ ...XC_LIVE, dataMode: 'live_read_only' }), { on: false, reason: 'invalid' }],
    ['crosschain', xc({ error: 'upstream_unavailable' }, 503), { on: false, reason: 'unavailable' }],
  ]) {
    assert.deepEqual(routeStateOf(route, result), expected, `${route} ${JSON.stringify(result).slice(0, 160)}`);
  }
  assert.equal(routeServes({ on: true, routes: ['portfolio'] }, 'portfolio'), true);
  assert.equal(routeServes({ on: true, routes: ['portfolio'] }, 'activity'), false);
  assert.equal(routeServes({ on: false, reason: 'disabled' }, 'plan'), false);
  assert.equal(routeServes({ on: true, routes: ['origins', 'quote', 'status'] }, 'quote'), true);
  assert.equal(routeServes({ on: true, routes: ['status'] }, 'origins'), false);
});

// Rewritten on purpose 2026-10-15 (pack 7): the read route's "on" is kept V2_READ_ROUTE_REUSE_MS (five minutes; was
// V2_ROUTE_REUSE_MS, a minute); every other settled answer keeps its minute, as the plan route's below.
test('the probe keeps a settled answer a minute (the read route said on: five), shares one question, and keeps no failure', async () => {
  let clock = 1_000;
  const answers = { readV6: [v6(V6_ON)], plan: [{ kind: 'network' }, plan(PLAN_LIVE)] };
  const asked = [];
  // Changed on purpose 2026-11-06: the read Worker answers in the version asked, as it does in read-v6 1.2.0-rc.1's window.
  const inVersion = (result, version) => (result.kind === 'reply' && version !== V6_VERSION
    ? json({ ...JSON.parse(result.reply.body.text), contractVersion: version }, { status: result.reply.status, contractHeader: version }) : result);
  const probe = createV2RouteProbe({ now: () => clock, get: async (path, options) => {
    const route = path.includes('/read/v6/') ? 'readV6' : 'plan';
    asked.push(route);
    await Promise.resolve();
    const answer = answers[route].length > 1 ? answers[route].shift() : answers[route][0];
    return route === 'readV6' ? inVersion(answer, options.headers['X-Domino-Read-Contract']) : answer;
  } });
  // Two asks at once: one GET.
  const [first, second] = await Promise.all([probe.state('readV6'), probe.state('readV6')]);
  assert.deepEqual(first, { on: true, routes: ['portfolio', 'activity'] });
  assert.equal(first, second);
  assert.deepEqual(asked, ['readV6']);
  clock += V2_READ_ROUTE_REUSE_MS - 1;
  await probe.state('readV6');
  assert.deepEqual(asked, ['readV6'], 'kept for its five minutes');
  clock += 1;
  await probe.state('readV6');
  assert.deepEqual(asked, ['readV6', 'readV6'], 'asked again after it');
  // A failure is not kept: the next ask asks.
  assert.deepEqual(await probe.state('plan'), { on: false, reason: 'unavailable' });
  assert.deepEqual(await probe.state('plan'), { on: true, routes: ['plan'] });
  assert.deepEqual(asked, ['readV6', 'readV6', 'plan', 'plan']);
  clock += V2_ROUTE_REUSE_MS - 1;
  await probe.state('plan');
  assert.equal(asked.length, 4, "the plan route's answer is kept for its minute");
  clock += 1;
  await probe.state('plan');
  assert.equal(asked.length, 5, 'and asked again after it');
  probe.forget();
  await probe.state('plan');
  assert.equal(asked.length, 6, 'forget() asks afresh');
});
