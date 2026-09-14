import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import worker, { createWorker, ERROR_STATUS_BY_CODE, LIMITS } from '../src/worker.mjs';
import { CONTRACT_VERSION, ROUTES } from '../src/request-contract.mjs';

const origin = 'https://app.example.invalid';
const address = `0x${'1'.repeat(40)}`;
const otherAddress = `0x${'2'.repeat(40)}`;
const poolId = `0x${'3'.repeat(64)}`;
const env = {
  APP_ORIGIN: origin,
  GATEWAY_ORIGIN: 'https://gateway.example.invalid',
  READ_BRIDGE_ENABLED: 'true',
  ENABLED_READS: Object.keys(ROUTES).join(','),
  ACCESS_CLIENT_ID: 'synthetic-service-id',
  ACCESS_CLIENT_SECRET: 'synthetic-service-secret',
};
const payloads = {
  catalogue: { token: address }, 'pool-activity': { poolId }, 'pool-positions': { poolId }, 'pool-metrics': { poolId },
  token: { token: address },
  pools: { token: address, pairedToken: otherAddress, maxPools: 1, poolIds: [poolId] },
  'pool-market': { poolId, includePriceHistory: true, priceToken: 'quote' },
  'wallet-assets': { wallet: address, tokens: [otherAddress], autoDiscover: true, cursor: null },
  'nft-positions': { tokenIds: ['0', (2n ** 256n - 1n).toString()], blockNumber: null },
  'markets-snapshot': { poolIds: [poolId] },
};
const responseFixtures = Object.fromEntries(await Promise.all(Object.keys(ROUTES).map(async (route) => [
  route,
  await readFile(new URL(`../../api-contracts/read-v1/fixtures/producer/${route}.${route === 'wallet-assets' ? 'fallback' : route === 'pool-metrics' ? 'qualified' : 'success'}.json`, import.meta.url), 'utf8'),
])));

function request(route = 'token', options = {}) {
  const { method = 'POST', headers = {}, body = JSON.stringify(payloads[route] ?? {}), url = `${origin}/api/read/v1/${route}`, ...rest } = options;
  return new Request(url, {
    method,
    headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body, duplex: 'half' }),
    ...rest,
  });
}

// Every default fake response is a full shared producer fixture. The BFF must
// validate the nested contract even when the gateway reports the pinned version.
function upstream(route = 'token', options = {}) {
  return new Response(options.body ?? responseFixtures[route], {
    status: options.status ?? 200,
    headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': CONTRACT_VERSION, ...options.headers },
  });
}

function harness(responder = (_, init) => upstream()) {
  const calls = [];
  return { calls, worker: createWorker({
    getClientIp: () => '203.0.113.7',
    fetch: async (url, init) => { calls.push({ url, init }); return responder(url, init); },
  }) };
}

async function expectError(response, status, error) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error });
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('X-Domino-Read-Contract'), CONTRACT_VERSION);
  assert.match(response.headers.get('X-Domino-Request-Id'), /^[a-f0-9-]{36}$/);
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
}

test('default-off config exposes only disabled, read-only local capabilities', async () => {
  const h = harness();
  const response = await h.worker.fetch(new Request(`${origin}/api/read/v1/capabilities`), { APP_ORIGIN: origin });
  assert.deepEqual(await response.json(), {
    contractVersion: CONTRACT_VERSION, dataMode: 'disabled', chainId: 4663, enabledReads: [],
    walletAuthentication: false, privateAccounts: false, ownerTransactions: false, automation: false,
  });
  await expectError(await h.worker.fetch(request(), { APP_ORIGIN: origin }), 404, 'route_not_available');
  assert.equal(h.calls.length, 0);
});

test('configured capabilities list only explicitly enabled reads', async () => {
  const h = harness();
  const response = await h.worker.fetch(request('capabilities', { method: 'GET' }), { ...env, ENABLED_READS: 'token,pools' });
  assert.deepEqual((await response.json()).enabledReads, ['token', 'pools']);
  await expectError(await h.worker.fetch(request('wallet-assets'), { ...env, ENABLED_READS: 'token,pools' }), 404, 'route_not_available');
  assert.equal(h.calls.length, 0);
});

for (const patch of [
  { APP_ORIGIN: 'https://app.example.invalid/' }, { APP_ORIGIN: 'http://app.example.invalid' },
  { GATEWAY_ORIGIN: 'http://gateway.example.invalid' }, { GATEWAY_ORIGIN: 'https://gateway.example.invalid/internal/read/v1/token' },
  { GATEWAY_ORIGIN: 'https://name:password@gateway.example.invalid' }, { GATEWAY_ORIGIN: `${origin}` },
  { ENABLED_READS: 'token,unknown' }, { ENABLED_READS: 'token,token' }, { ENABLED_READS: '' },
  { ACCESS_CLIENT_SECRET: '' }, { ACCESS_CLIENT_ID: 'bad\r\nheader' },
]) test(`invalid deployment configuration fails closed: ${Object.keys(patch)[0]} ${JSON.stringify(patch)}`, async () => {
  const h = harness();
  await expectError(await h.worker.fetch(request(), { ...env, ...patch }), 503, 'upstream_unavailable');
  assert.equal(h.calls.length, 0);
});

for (const route of Object.keys(ROUTES)) test(`fixed mapping preserves ${route} request and response bytes`, async () => {
  const responseText = responseFixtures[route];
  const h = harness(() => upstream(route, { body: responseText }));
  const body = JSON.stringify(payloads[route]);
  const response = await h.worker.fetch(request(route, { body }), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), responseText);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, `${env.GATEWAY_ORIGIN}/internal/read/v1/${route}`);
  assert.equal(h.calls[0].init.body, body);
  assert.equal(h.calls[0].init.redirect, 'manual');
});

for (const path of [
  '/api/read/v1/health', '/health', '/openapi.json', '/v1/capabilities', '/api/v1/compound-preview',
  '/api/read/v1/token/', '/api/read/v1/token/extra', '/api/read/v1/%74oken', '/api/read/v1/token?url=https://evil.invalid',
  '/api/read/v1/token%2f..%2fhealth', '/api/read/v1/../health', '/api/session/v1/verify',
]) test(`unknown path never dispatches: ${path}`, async () => {
  const h = harness();
  await expectError(await h.worker.fetch(request('token', { url: `${origin}${path}` }), env), 404, 'route_not_available');
  assert.equal(h.calls.length, 0);
});

for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) test(`read method ${method} is rejected without CORS`, async () => {
  const h = harness();
  await expectError(await h.worker.fetch(request('token', { method }), env), 405, 'method_not_allowed');
  assert.equal(h.calls.length, 0);
});

for (const badOrigin of ['', 'null', 'https://evil.invalid', 'https://sibling.app.example.invalid', `${origin}, ${origin}`]) test(`reject POST Origin ${badOrigin}`, async () => {
  const h = harness();
  await expectError(await h.worker.fetch(request('token', { headers: { Origin: badOrigin } }), env), 403, 'origin_not_allowed');
  assert.equal(h.calls.length, 0);
});

test('missing POST Origin, foreign capabilities Origin, mismatched host and alternate Worker hostname fail', async () => {
  const h = harness();
  const missing = request(); missing.headers.delete('Origin');
  for (const input of [missing,
    request('capabilities', { method: 'GET', headers: { Origin: 'https://foreign.invalid' } }),
    request('token', { headers: { Host: 'foreign.invalid' } }),
    request('token', { url: 'https://preview.example.invalid/api/read/v1/token' }),
  ]) await expectError(await h.worker.fetch(input, env), 403, 'origin_not_allowed');
  assert.equal(h.calls.length, 0);
});

for (const headers of [
  { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'none' },
  { 'Sec-Fetch-Site': 'same-origin, cross-site' }, { 'Sec-Fetch-Mode': 'navigate' },
  { 'Sec-Fetch-Dest': 'document' }, { 'Sec-Fetch-User': '?1' },
]) test(`Fetch Metadata fails closed: ${JSON.stringify(headers)}`, async () => {
  const h = harness();
  await expectError(await h.worker.fetch(request('token', { headers }), env), 403, 'origin_not_allowed');
  assert.equal(h.calls.length, 0);
});

test('browser-supplied identities and arbitrary headers never reach the gateway', async () => {
  const h = harness();
  const response = await h.worker.fetch(request('token', { headers: {
    Authorization: 'browser-secret', Cookie: 'session=browser-secret',
    'CF-Access-Client-Id': 'spoofed-id', 'CF-Access-Client-Secret': 'spoofed-secret',
    'Cf-Access-Jwt-Assertion': 'spoofed-assertion', 'CF-Connecting-IP': '198.51.100.1',
    'X-Domino-Client-Id': 'spoofed-client', 'X-Forwarded-For': '192.0.2.8',
    Forwarded: 'host=evil.invalid', 'X-Provider-Url': 'https://evil.invalid',
  } }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls[0].init.headers, {
    'Content-Type': 'application/json', 'X-Domino-Read-Contract': CONTRACT_VERSION,
    'CF-Access-Client-Id': env.ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.ACCESS_CLIENT_SECRET,
    'X-Domino-Client-Id': '203.0.113.7',
  });
});

test('production metadata adapter rejects absent, ambiguous or malformed edge IP without transport', async () => {
  for (const value of [null, '203.0.113.7, 198.51.100.8', '999.1.1.1', 'attacker', '1234:invalid']) {
    const input = request();
    if (value !== null) input.headers.set('CF-Connecting-IP', value);
    await expectError(await worker.fetch(input, env), 503, 'upstream_unavailable');
  }
});

test('IPv6 trusted metadata is bounded and forwarded', async () => {
  let seen;
  const h = createWorker({ getClientIp: () => '2001:db8::7', fetch: async (_, init) => { seen = init; return upstream(); } });
  assert.equal((await h.fetch(request(), env)).status, 200);
  assert.equal(seen.headers['X-Domino-Client-Id'], '2001:db8::7');
});

test('optional browser contract header is exact and duplicate-safe', async () => {
  const h = harness();
  for (const version of ['2.0.0', `${CONTRACT_VERSION}, ${CONTRACT_VERSION}`, '']) await expectError(await h.worker.fetch(request('token', { headers: { 'X-Domino-Read-Contract': version } }), env), 502, 'upstream_contract_mismatch');
  assert.equal(h.calls.length, 0);
  assert.equal((await h.worker.fetch(request('token', { headers: { 'X-Domino-Read-Contract': CONTRACT_VERSION } }), env)).status, 200);
});

for (const headers of [
  { 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json, application/json' },
  { 'Content-Type': 'application/json; charset=latin1' }, { 'Content-Encoding': 'gzip' },
  { 'Content-Encoding': 'identity, identity' },
]) test(`invalid request media is rejected: ${JSON.stringify(headers)}`, async () => {
  const h = harness();
  await expectError(await h.worker.fetch(request('token', { headers }), env), 415, 'json_required');
  assert.equal(h.calls.length, 0);
});

for (const body of [
  '', 'null', '[]', 'true', '{bad}', '{"token":"x",}',
  `{"token":"${address}","token":"${otherAddress}"}`,
  `{"token":"${address}","\\u0074oken":"${otherAddress}"}`,
  JSON.stringify({ token: address, url: 'https://evil.invalid' }),
  JSON.stringify({ token: address, chainId: 1 }), JSON.stringify({ token: address, method: 'eth_sendTransaction' }),
  JSON.stringify({ token: address, nested: { a: 1 } }),
  `{"token":"${address}","number":1e999}`,
]) test(`strict JSON rejects invalid payload without echo: ${body.slice(0, 50)}`, async () => {
  const h = harness();
  await expectError(await h.worker.fetch(request('token', { body }), env), 422, 'invalid_request');
  assert.equal(h.calls.length, 0);
});

test('invalid UTF-8 and BOM are rejected instead of silently repaired', async () => {
  const h = harness();
  for (const body of [new Uint8Array([0xff]), new TextEncoder().encode(`\uFEFF${JSON.stringify(payloads.token)}`)]) {
    await expectError(await h.worker.fetch(request('token', { body }), env), 422, 'invalid_request');
  }
  assert.equal(h.calls.length, 0);
});

test('body byte bound is streamed, inclusive, and independent of Content-Length', async () => {
  const h = harness();
  const text = JSON.stringify(payloads.token).padEnd(LIMITS.requestBytes, ' ');
  assert.equal((await h.worker.fetch(request('token', { body: text }), env)).status, 200);
  let cancelled = false;
  const body = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode(text)); controller.enqueue(new Uint8Array([32]));
  }, cancel() { cancelled = true; } });
  await expectError(await h.worker.fetch(request('token', { body, headers: { 'Content-Length': '1' } }), env), 413, 'request_too_large');
  assert.equal(cancelled, true);
  assert.equal(h.calls.length, 1);
  for (const length of ['8193', '1, 2', '-1']) await expectError(await h.worker.fetch(request('token', { headers: { 'Content-Length': length } }), env), 413, 'request_too_large');
});

const invalidRouteBodies = [
  ['pools', { token: address, maxPools: true }], ['pools', { token: address, maxPools: 21 }],
  ['pools', { token: address, maxPools: 1, poolIds: [poolId, poolId] }],
  ['pools', { token: address, pairedToken: address.toUpperCase().replace('0X', '0x') }],
  ['pool-market', { poolId, includePriceHistory: 1 }], ['pool-market', { poolId, priceToken: address }],
  ['wallet-assets', { wallet: address, tokens: Array(11).fill(address) }],
  ['wallet-assets', { wallet: address, autoDiscover: 1 }], ['wallet-assets', { wallet: address, cursor: '' }],
  ['nft-positions', { tokenIds: [1] }], ['nft-positions', { tokenIds: ['1', '1'] }],
  ['nft-positions', { tokenIds: [(2n ** 256n).toString()] }], ['nft-positions', { tokenIds: [] }],
  ['nft-positions', { tokenIds: ['1'], blockNumber: true }],
];
for (const [route, body] of invalidRouteBodies) test(`exact request schema rejects ${route}: ${JSON.stringify(body).slice(0, 80)}`, async () => {
  const h = harness();
  await expectError(await h.worker.fetch(request(route, { body: JSON.stringify(body) }), env), 422, 'invalid_request');
  assert.equal(h.calls.length, 0);
});

test('integer lexemes preserve JS-safe bounds and reject fractional/scientific integer forms', async () => {
  const h = harness(() => upstream('nft-positions'));
  const body = '{"tokenIds":["1"],"blockNumber":9007199254740991}';
  assert.equal((await h.worker.fetch(request('nft-positions', { body }), env)).status, 200);
  assert.equal(h.calls[0].init.body, body);
  for (const value of ['9223372036854775808', '9007199254740992', '-1', '1.0', '1e0']) {
    await expectError(await h.worker.fetch(request('nft-positions', { body: `{"tokenIds":["1"],"blockNumber":${value}}` }), env), 422, 'invalid_request');
  }
});

test('gateway response cannot set cookies, redirects, CORS, diagnostics or request ID', async () => {
  const h = harness(() => upstream('token', { headers: {
    'Set-Cookie': 'secret=private', Location: 'https://evil.invalid', 'X-Secret': 'private',
    'Access-Control-Allow-Origin': '*', 'X-Domino-Request-Id': 'arbitrary-upstream-value',
  } }));
  const response = await h.worker.fetch(request(), env);
  assert.equal(response.status, 200);
  for (const header of ['Set-Cookie', 'Location', 'X-Secret', 'Access-Control-Allow-Origin']) assert.equal(response.headers.get(header), null);
  assert.match(response.headers.get('X-Domino-Request-Id'), /^[a-f0-9-]{36}$/);
});

for (const status of [301, 302, 307, 308, 401, 403]) test(`infrastructure status ${status} becomes safe availability error`, async () => {
  const h = harness(() => new Response('<html>private infrastructure login</html>', { status, headers: { Location: 'https://login.invalid' } }));
  await expectError(await h.worker.fetch(request(), env), 503, 'upstream_unavailable');
});

for (const version of [null, '2.0.0', `${CONTRACT_VERSION}, ${CONTRACT_VERSION}`]) test(`reject gateway contract header ${version}`, async () => {
  const h = harness(() => { const response = upstream(); if (version === null) response.headers.delete('X-Domino-Read-Contract'); else response.headers.set('X-Domino-Read-Contract', version); return response; });
  await expectError(await h.worker.fetch(request(), env), 502, 'upstream_contract_mismatch');
});

for (const body of ['{}', '{"schemaVersion":2,"chainId":4663}', '{"schemaVersion":1,"chainId":1}']) test(`version or chain mismatch fails closed: ${body}`, async () => {
  const h = harness(() => upstream('token', { body }));
  await expectError(await h.worker.fetch(request(), env), 502, 'upstream_contract_mismatch');
});

test('pinned versions cannot admit missing fields or live execution capabilities', async () => {
  const valid = JSON.parse(responseFixtures.token);
  const missingRequired = structuredClone(valid);
  delete missingRequired.asset.decimals;
  const liveExecution = structuredClone(valid);
  liveExecution.asset.executionAvailable = true;
  for (const payload of [
    { schemaVersion: 1, chainId: 4663, executionAvailable: true },
    missingRequired,
    liveExecution,
    { ...valid, liveExecution: true },
  ]) {
    const h = harness(() => upstream('token', { body: JSON.stringify(payload) }));
    await expectError(await h.worker.fetch(request(), env), 502, 'upstream_contract_mismatch');
  }
});

test('full market response schema rejects nested renames, wrong raw types and unknown states', async () => {
  const renamed = JSON.parse(responseFixtures['pool-market']);
  renamed.market.data.renamedLiquidityUsd = renamed.market.data.reportedLiquidityUsd;
  delete renamed.market.data.reportedLiquidityUsd;
  const changedState = JSON.parse(responseFixtures['pool-market']);
  changedState.market.status = 'fabricated_success';
  const numericRaw = JSON.parse(responseFixtures['wallet-assets']);
  numericRaw.items[0].amountRaw = 0;
  for (const [route, payload] of [['pool-market', renamed], ['pool-market', changedState], ['wallet-assets', numericRaw]]) {
    const h = harness(() => upstream(route, { body: JSON.stringify(payload) }));
    await expectError(await h.worker.fetch(request(route), env), 502, 'upstream_contract_mismatch');
  }
});

for (const body of ['bad json', 'null', '[]', '{"error":"private"}', '{"schemaVersion":1,"schemaVersion":1,"chainId":4663}', '{"schemaVersion":1,"chainId":4663,"number":1e999}']) test(`malformed gateway payload is sanitized: ${body}`, async () => {
  const h = harness(() => upstream('token', { body }));
  await expectError(await h.worker.fetch(request(), env), 502, 'upstream_invalid_response');
});

test('gateway output is streamed and bounded, with media/encoding checks', async () => {
  let cancelled = false;
  const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(LIMITS.responseBytes + 1)); }, cancel() { cancelled = true; } });
  const h = harness(() => upstream('token', { body: stream }));
  await expectError(await h.worker.fetch(request(), env), 502, 'upstream_invalid_response');
  assert.equal(cancelled, true);
  for (const headers of [{ 'Content-Encoding': 'gzip' }, { 'Content-Length': String(LIMITS.responseBytes + 1) }]) {
    const candidate = harness(() => upstream('token', { headers }));
    await expectError(await candidate.worker.fetch(request(), env), 502, 'upstream_invalid_response');
  }
});

test('infrastructure login HTML with 200 and no contract header is an availability failure', async () => {
  const h = harness(() => new Response('<html>private login</html>', { headers: { 'Content-Type': 'text/html' } }));
  await expectError(await h.worker.fetch(request(), env), 503, 'upstream_unavailable');
});

test('known errors retain exact status/code; Retry-After is bounded', async () => {
  for (const [error, status] of Object.entries(ERROR_STATUS_BY_CODE).filter(([, status]) => status !== 403)) {
    const h = harness(() => upstream('token', { status, body: JSON.stringify({ error }), headers: { 'Retry-After': '99999', 'X-Diagnostic': 'secret' } }));
    const response = await h.worker.fetch(request(), env);
    if (status === 429) assert.equal(response.headers.get('Retry-After'), '1');
    assert.equal(response.headers.get('X-Diagnostic'), null);
    await expectError(response, status, error);
  }
  const h = harness(() => upstream('token', { status: 429, body: '{"error":"read_capacity_busy"}', headers: { 'Retry-After': '12' } }));
  assert.equal((await h.worker.fetch(request(), env)).headers.get('Retry-After'), '12');
});

test('unknown, extra-key, mismatched-status errors and arbitrary 5xx text are safe', async () => {
  for (const [status, body, expected] of [
    [503, '{"error":"provider_secret"}', 'upstream_unavailable'],
    [503, '{"error":"upstream_unavailable","debug":"secret"}', 'upstream_invalid_response'],
    [500, '{"error":"invalid_request"}', 'upstream_unavailable'],
  ]) {
    const h = harness(() => upstream('token', { status, body }));
    await expectError(await h.worker.fetch(request(), env), ERROR_STATUS_BY_CODE[expected], expected);
  }
  const h = harness(() => upstream('token', { status: 500, body: 'private traceback', headers: { 'Content-Type': 'text/plain' } }));
  await expectError(await h.worker.fetch(request(), env), 503, 'upstream_unavailable');
});

test('transport errors are sanitized and not retried', async () => {
  const h = harness(() => { throw new Error('secret provider URL'); });
  await expectError(await h.worker.fetch(request(), env), 503, 'upstream_unavailable');
  assert.equal(h.calls.length, 1);
});

const flush = () => new Promise((resolve) => setImmediate(resolve));

test('five-second streamed upload deadline cancels without upstream dispatch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let cancelled = false;
  const h = harness();
  const pending = h.worker.fetch(request('token', { body: new ReadableStream({ cancel() { cancelled = true; } }) }), env);
  await flush();
  t.mock.timers.tick(5001);
  await expectError(await pending, 408, 'request_timeout');
  assert.equal(cancelled, true);
  assert.equal(h.calls.length, 0);
});

test('upstream headers and stream share one fifteen-second budget', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let resolveFetch, signal, cancelled = false;
  const h = harness((_, init) => { signal = init.signal; return new Promise((resolve) => { resolveFetch = resolve; }); });
  const pending = h.worker.fetch(request(), env);
  await flush();
  t.mock.timers.tick(14000);
  resolveFetch(upstream('token', { body: new ReadableStream({ cancel() { cancelled = true; } }) }));
  await flush();
  t.mock.timers.tick(1001);
  await expectError(await pending, 504, 'upstream_timeout');
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
  assert.equal(h.calls.length, 1);
});

test('near-deadline upload plus upstream work stay within total twenty seconds', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let inputController;
  const h = harness(() => new Promise(() => {}));
  const pending = h.worker.fetch(request('token', { body: new ReadableStream({ start(controller) { inputController = controller; } }) }), env);
  await flush();
  t.mock.timers.tick(4999);
  inputController.enqueue(new TextEncoder().encode(JSON.stringify(payloads.token))); inputController.close();
  await flush();
  t.mock.timers.tick(15001);
  await expectError(await pending, 504, 'upstream_timeout');
  assert.equal(h.calls.length, 1);
});

test('browser disconnect aborts active gateway fetch and does not retry', async () => {
  const abort = new AbortController();
  let signal;
  const h = harness((_, init) => { signal = init.signal; return new Promise(() => {}); });
  const pending = h.worker.fetch(request('token', { signal: abort.signal }), env);
  await flush();
  abort.abort();
  await expectError(await pending, 408, 'request_timeout');
  assert.equal(signal.aborted, true);
  assert.equal(h.calls.length, 1);
});

for (const elapsed of [15000, 21000]) test(`resolved transport after ${elapsed}ms cannot bypass absolute deadline`, async (t) => {
  let now = 0, signal;
  t.mock.method(Date, 'now', () => now);
  const h = harness((_, init) => {
    signal = init.signal;
    now += elapsed;
    return upstream();
  });
  await expectError(await h.worker.fetch(request(), env), 504, 'upstream_timeout');
  assert.equal(signal.aborted, true);
  assert.equal(h.calls.length, 1);
});

test('resolved upload after absolute body deadline cannot dispatch upstream', async (t) => {
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  const h = harness();
  const body = new ReadableStream({ pull(controller) {
    now += 5001;
    controller.enqueue(new TextEncoder().encode(JSON.stringify(payloads.token)));
    controller.close();
  } });
  await expectError(await h.worker.fetch(request('token', { body }), env), 408, 'request_timeout');
  assert.equal(h.calls.length, 0);
});

test('upload parsing remains inside the absolute body budget', async (t) => {
  let now = 0;
  const originalParse = JSON.parse;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(JSON, 'parse', (source, ...args) => {
    const value = originalParse(source, ...args);
    if (source === '"token"') now += 5001;
    return value;
  });
  const h = harness();
  await expectError(await h.worker.fetch(request(), env), 408, 'request_timeout');
  assert.equal(h.calls.length, 0);
});

test('response parsing cannot return success after absolute upstream expiry', async (t) => {
  let now = 0, signal;
  const originalParse = JSON.parse;
  t.mock.method(Date, 'now', () => now);
  t.mock.method(JSON, 'parse', (source, ...args) => {
    const value = originalParse(source, ...args);
    if (source === '"TOKEN"') now += 21000;
    return value;
  });
  const h = harness((_, init) => { signal = init.signal; return upstream(); });
  await expectError(await h.worker.fetch(request(), env), 504, 'upstream_timeout');
  assert.equal(signal.aborted, true);
  assert.equal(h.calls.length, 1);
});
