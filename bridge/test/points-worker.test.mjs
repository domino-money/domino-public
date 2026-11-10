// points-v1 through the authenticated bridge (docs/points/POINTS.md, part 3; 7 Nov 2026): the session boundary of the
// plan's transport, every answer held to the package's runtime (points that add up, a link that names the referrer
// sent unless an earlier one holds), off until its own flag says otherwise, and a capabilities GET of its own.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createPointsWorker } from '../src/points-worker.mjs';
import { CONTRACT_VERSION, ERROR_STATUS_BY_CODE } from '../../api-contracts/points-v1/runtime.mjs';

const origin = 'https://app.example.invalid';
const session = 's'.repeat(43), csrf = 'c'.repeat(43);
const HEADER = 'X-Domino-Points-Contract';
const env = { APP_ORIGIN: origin, POINTS_BRIDGE_ENABLED: 'true', POINTS_GATEWAY_ORIGIN: 'https://points.example.invalid',
  POINTS_ACCESS_CLIENT_ID: 'synthetic-points-id', POINTS_ACCESS_CLIENT_SECRET: 'synthetic-points-secret' };
const fixtures = new URL('../../api-contracts/points-v1/fixtures/', import.meta.url);
const json = (path) => JSON.parse(readFileSync(new URL(path, fixtures), 'utf8'));
const POINTS = json('responses/points.json'), LINK = json('responses/link.json'), LINK_REQUEST = json('requests/link.json');

function request(route = 'points', body = route === 'points' ? {} : LINK_REQUEST, headers = {}) {
  return new Request(`${origin}/api/points/v1/${route}`, { method: 'POST', duplex: 'half', body: JSON.stringify(body),
    headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty', Cookie: `__Host-domino-session=${session}`, 'X-Domino-CSRF': csrf, ...headers } });
}
function capabilities() {
  return new Request(`${origin}/api/points/v1/capabilities`,
    { headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty' } });
}
function answer(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json', [HEADER]: CONTRACT_VERSION } });
}
function harness(responder = () => answer(POINTS)) {
  const calls = [];
  return { calls, worker: createPointsWorker({ getClientIp: () => '203.0.113.7',
    fetch: (url, init) => { calls.push({ url, init }); return responder(url, init); } }) };
}
async function error(result, code) {
  assert.equal(result.status, ERROR_STATUS_BY_CODE[code], code);
  assert.deepEqual(await result.json(), { error: code });
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
}
function committed() {
  const toml = readFileSync(new URL('../wrangler.points.toml', import.meta.url), 'utf8');
  const section = toml.slice(toml.indexOf('[vars]\n') + '[vars]\n'.length).split(/\n\[/)[0];
  return { toml, vars: Object.fromEntries(section.split('\n').filter((line) => /^[A-Z0-9_]+ = "/.test(line))
    .map((line) => { const [, name, value] = line.match(/^([A-Z0-9_]+) = "(.*)"$/); return [name, value]; })) };
}

test('the committed config keeps the routes off, logs nothing and names its own gateway', async () => {
  const { toml, vars } = committed();
  assert.deepEqual(vars, { POINTS_BRIDGE_ENABLED: 'false', APP_ORIGIN: 'https://domino.money',
    POINTS_GATEWAY_ORIGIN: 'https://points-gateway.example.invalid', PREVIEW_ORIGINS: '' });
  assert.match(toml, /^name = "domino-points-bridge"$/m);
  assert.match(toml, /^main = "src\/points-worker\.mjs"$/m);
  assert.match(toml, /^\[observability\]\nenabled = false$/m);
  const h = harness();
  await error(await h.worker.fetch(request(), { ...vars, APP_ORIGIN: origin }), 'route_not_available');
  const off = await h.worker.fetch(capabilities(), { ...vars, APP_ORIGIN: origin });
  assert.deepEqual(await off.json(), { contractVersion: CONTRACT_VERSION, dataMode: 'disabled', enabledRoutes: [] });
  assert.equal(h.calls.length, 0);
});

test('points are forwarded with the session and the Access pair, and come back as the listener answered', async () => {
  const h = harness();
  const result = await h.worker.fetch(request(), env);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), POINTS);
  assert.equal(result.headers.get(HEADER), CONTRACT_VERSION);
  const [{ url, init }] = h.calls;
  assert.equal(url, 'https://points.example.invalid/internal/points/v1/points');
  assert.equal(init.headers['X-Domino-Session'], session);
  assert.equal(init.headers['X-Domino-CSRF'], csrf);
  assert.equal(init.headers[HEADER], CONTRACT_VERSION);
  assert.equal(init.headers['CF-Access-Client-Id'], 'synthetic-points-id');
  const live = await h.worker.fetch(capabilities(), env);
  assert.deepEqual((await live.json()).enabledRoutes.sort(), ['link', 'points']);
});

test('an answer that does not hold never reaches the browser', async () => {
  const broken = { ...POINTS, wallet: { ...POINTS.wallet, points: '9999.000000' } };
  await error(await harness(() => answer(broken)).worker.fetch(request(), env), 'upstream_contract_mismatch');
  // A recorded link must name the referrer this browser sent; an existing one names the first.
  const other = '0x' + 'ab'.repeat(20);
  await error(await harness(() => answer({ ...LINK, referrer: other })).worker.fetch(request('link'), env),
    'upstream_contract_mismatch');
  const held = await harness(() => answer({ ...LINK, status: 'existing', referrer: other })).worker.fetch(request('link'), env);
  assert.equal(held.status, 200);
  assert.equal((await held.json()).referrer, other);
  // The listener's refusal passes through as the contract says it.
  await error(await harness(() => answer({ error: 'referral_signature_mismatch' }, 422)).worker.fetch(request('link'), env),
    'referral_signature_mismatch');
});

test('a request outside the contract is refused before any upstream call', async () => {
  const h = harness();
  await error(await h.worker.fetch(request('link', { ...LINK_REQUEST, referee: LINK_REQUEST.referrer }), env), 'invalid_request');
  await error(await h.worker.fetch(request('points', { wallet: LINK_REQUEST.referrer }), env), 'invalid_request');
  await error(await h.worker.fetch(request('quote', {}), env), 'route_not_available');
  assert.equal(h.calls.length, 0);
});
