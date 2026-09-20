import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createWorker } from '../src/worker.mjs';
import { CONTRACT_VERSION, validateResponse } from '../../api-contracts/read-v3/runtime.mjs';

const origin = 'https://app.example.invalid';
const fixtureRoot = new URL('../../api-contracts/read-v3/fixtures/', import.meta.url);
const fixtures = Object.fromEntries(await Promise.all(['overview', 'history', 'search'].map(async route =>
  [route, JSON.parse(await readFile(new URL(`${route}.json`, fixtureRoot), 'utf8'))])));
// The response-only fixture predates a full requested window. Bind it to the
// actual request here while retaining its observed candle and partial coverage.
fixtures.history.requestedWindow = { startTimestamp: 0, endTimestamp: 86400 };
fixtures.history.gaps = [{ startTimestamp: 0, endTimestamp: 900 }, { startTimestamp: 1000, endTimestamp: 86400 }];
const bodies = {
  overview: fixtures.overview.selectedToken ? { token: fixtures.overview.selectedToken } : { poolIds: fixtures.overview.requestedPoolIds },
  history: { poolId: fixtures.history.poolId, currency: fixtures.history.currency },
  search: { query: fixtures.search.query },
};
const env = {
  APP_ORIGIN: origin, GATEWAY_ORIGIN: 'https://gateway.example.invalid',
  READ_V3_BRIDGE_ENABLED: 'true', ENABLED_V3_READS: 'overview,history,search',
  ACCESS_CLIENT_ID: 'synthetic-service-id', ACCESS_CLIENT_SECRET: 'synthetic-service-secret',
};

function request(route = 'overview', options = {}) {
  const { method = 'POST', body = JSON.stringify(bodies[route] ?? {}), headers = {},
    url = `${origin}/api/read/v3/${route}` } = options;
  return new Request(url, { method,
    headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers },
    ...(method === 'GET' ? {} : { body }) });
}
function response(body, { status = 200, version = CONTRACT_VERSION, headers = {} } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: {
    'Content-Type': 'application/json', 'X-Domino-Read-Contract': version, ...headers,
  } });
}
function harness(responder = (url) => response(fixtures[url.split('/').at(-1)])) {
  const calls = [];
  return { calls, worker: createWorker({ getClientIp: () => '203.0.113.7',
    fetch: async (url, init) => { calls.push({ url, init }); return responder(url, init); } }) };
}
async function error(result, status, code) {
  assert.equal(result.status, status);
  assert.deepEqual(await result.json(), { error: code });
  assert.equal(result.headers.get('X-Domino-Read-Contract'), CONTRACT_VERSION);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(result.headers.get('Set-Cookie'), null);
}

for (const enabled of [undefined, 'false', true, 'TRUE', ' true']) {
  test(`V3 is disabled without exact opt-in ${String(enabled)}`, async () => {
    const h = harness();
    const settings = { ...env, READ_V3_BRIDGE_ENABLED: enabled };
    const result = await h.worker.fetch(request('capabilities', { method: 'GET' }), settings);
    const data = await result.json();
    assert.equal(validateResponse('capabilities', data), true);
    assert.equal(data.dataMode, 'disabled');
    assert.deepEqual(data.enabledReads, []);
    await error(await h.worker.fetch(request(), settings), 404, 'route_not_available');
    assert.equal(h.calls.length, 0);
  });
}

for (const route of Object.keys(fixtures)) {
  test(`V3 ${route} preserves validated bytes, version and fixed route`, async () => {
    const h = harness();
    const raw = JSON.stringify(bodies[route]);
    const result = await h.worker.fetch(request(route, { body: raw, headers: {
      Cookie: 'synthetic-secret=not-forwarded', Authorization: 'Bearer not-forwarded',
      'X-Domino-Read-Contract': CONTRACT_VERSION,
    } }), env);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('X-Domino-Read-Contract'), CONTRACT_VERSION);
    assert.equal(result.headers.get('Set-Cookie'), null);
    assert.deepEqual(await result.json(), fixtures[route]);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].url, `https://gateway.example.invalid/internal/read/v3/${route}`);
    assert.equal(h.calls[0].init.body, raw);
    const headers = new Headers(h.calls[0].init.headers);
    assert.equal(headers.get('Cookie'), null);
    assert.equal(headers.get('Authorization'), null);
    assert.equal(headers.get('X-Domino-Read-Contract'), CONTRACT_VERSION);
  });
}

test('V3 routes remain exact and cannot enter V1 or V2 producer paths', async () => {
  const h = harness();
  for (const route of ['token', 'pool-market', 'overview/extra', 'overview/', '%6fverview', 'history?foo=bar']) {
    await error(await h.worker.fetch(request(route), env), 404, 'route_not_available');
  }
  const result = await h.worker.fetch(request('token', { url: `${origin}/api/read/v1/token` }), env);
  assert.equal(result.status, 404);
  assert.equal(result.headers.get('X-Domino-Read-Contract'), '1.1.0-rc.3');
  assert.equal(h.calls.length, 0);
});

test('V3 accepts explicit safe integer limits, revisions and history windows without changing request bytes', async () => {
  for (const [route, body] of [
    ['overview', { ...bodies.overview, limit: 24, revision: fixtures.overview.revision }],
    ['history', { ...bodies.history, windowSeconds: 86400, resolutionSeconds: 3600 }],
    ['search', { ...bodies.search, limit: 20 }],
  ]) {
    const h = harness();
    const raw = JSON.stringify(body);
    const result = await h.worker.fetch(request(route, { body: raw }), env);
    assert.equal(result.status, 200, route);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].init.body, raw);
  }
});

test('V3 refuses fractional, exponent and unsafe integer spellings before upstream I/O', async () => {
  for (const [route, field, invalid] of [
    ['overview', 'limit', '24.0'], ['overview', 'limit', '2.4e1'],
    ['overview', 'limit', '24.0000000000000001'], ['overview', 'revision', '9007199254740993'],
    ['history', 'windowSeconds', '86400.0'], ['history', 'resolutionSeconds', '36e2'],
    ['search', 'limit', '20.5'],
  ]) {
    const h = harness();
    const raw = JSON.stringify(bodies[route]).replace(/}$/, `,"${field}":${invalid}}`);
    await error(await h.worker.fetch(request(route, { body: raw }), env), 422, 'invalid_request');
    assert.equal(h.calls.length, 0);
  }
});

test('V3 rejects invalid selectors, unknown fields and oversized requested windows before forwarding', async () => {
  const h = harness();
  for (const body of [{}, { ...bodies.overview, rpcUrl: 'https://invalid.example' },
                      { ...bodies.overview, limit: true }, { poolIds: Array(25).fill(fixtures.history.poolId) }]) {
    await error(await h.worker.fetch(request('overview', { body: JSON.stringify(body) }), env), 422, 'invalid_request');
  }
  await error(await h.worker.fetch(request('history', { body: JSON.stringify({ ...bodies.history, windowSeconds: 2592000, resolutionSeconds: 60 }) }), env), 422, 'invalid_request');
  assert.equal(h.calls.length, 0);
});

test('V3 rejects wrong selection even when the upstream response has a valid schema', async () => {
  for (const [route, mutate] of [
    ['overview', value => { value.requestedPoolIds = [`0x${'b'.repeat(64)}`]; value.pools = []; }],
    ['history', value => { value.currency = `0x${'2'.repeat(40)}`; }],
    ['search', value => { value.query = 'OTHER'; }],
  ]) {
    const data = structuredClone(fixtures[route]); mutate(data);
    const h = harness(() => response(data));
    await error(await h.worker.fetch(request(route), env), 502, 'upstream_contract_mismatch');
  }
});

test('V3 validates upstream protocol, preserves safe refusal and rejects private diagnostics', async () => {
  for (const version of ['1.1.0-rc.3', '2.0.0-rc.1']) {
    const h = harness(() => response(fixtures.overview, { version }));
    await error(await h.worker.fetch(request(), env), 502, 'upstream_contract_mismatch');
  }
  const limited = harness(() => response({ error: 'read_capacity_busy' }, { status: 429, headers: { 'Retry-After': '3' } }));
  const result = await limited.worker.fetch(request(), env);
  assert.equal(result.headers.get('Retry-After'), '3');
  await error(result, 429, 'read_capacity_busy');
  const privateError = harness(() => response({ error: 'private diagnostic' }, { status: 503 }));
  await error(await privateError.worker.fetch(request(), env), 503, 'upstream_unavailable');
});

test('V3 preserves same-origin browser checks', async () => {
  const h = harness();
  await error(await h.worker.fetch(request('overview', { headers: { Origin: 'https://elsewhere.invalid' } }), env), 403, 'origin_not_allowed');
  assert.equal(h.calls.length, 0);
});
