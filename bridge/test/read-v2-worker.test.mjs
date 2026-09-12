import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import worker, { createWorker, LIMITS } from '../src/worker.mjs';
import { CONTRACT_VERSION as V1_VERSION } from '../../api-contracts/read-v1/runtime.mjs';
import {
  CONTRACT_VERSION, ERROR_STATUS_BY_CODE, validateResponse,
} from '../../api-contracts/read-v2/runtime.mjs';

const origin = 'https://app.example.invalid';
const fixtureRoot = new URL('../../api-contracts/read-v2/fixtures/', import.meta.url);
const fixtureText = await readFile(new URL('responses/pool-market.json', fixtureRoot), 'utf8');
const fixture = JSON.parse(fixtureText);
const v1Text = await readFile(new URL('../../api-contracts/read-v1/fixtures/producer/token.success.json', import.meta.url), 'utf8');
const v1MarketText = await readFile(new URL('../../api-contracts/read-v1/fixtures/producer/pool-market.success.json', import.meta.url), 'utf8');
const env = {
  APP_ORIGIN: origin,
  GATEWAY_ORIGIN: 'https://gateway.example.invalid',
  READ_V2_BRIDGE_ENABLED: 'true',
  ENABLED_V2_READS: 'pool-market',
  ACCESS_CLIENT_ID: 'synthetic-service-id',
  ACCESS_CLIENT_SECRET: 'synthetic-service-secret',
};

function request(options = {}) {
  const { route = 'pool-market', version = 2, method = 'POST', headers = {},
    body = JSON.stringify({ poolId: fixture.poolId }), url = `${origin}/api/read/v${version}/${route}`, ...rest } = options;
  return new Request(url, {
    method, headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body, duplex: 'half' }), ...rest,
  });
}

function upstream({ body = fixtureText, status = 200, version = CONTRACT_VERSION, headers = {} } = {}) {
  return new Response(body, { status, headers: {
    'Content-Type': 'application/json', 'X-Domino-Read-Contract': version, ...headers,
  } });
}

function harness(responder = () => upstream()) {
  const calls = [];
  return { calls, worker: createWorker({
    getClientIp: () => '203.0.113.7',
    fetch: async (url, init) => { calls.push({ url, init }); return responder(url, init); },
  }) };
}

async function expectError(response, status, error, version = CONTRACT_VERSION) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error });
  assert.equal(response.headers.get('X-Domino-Read-Contract'), version);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.match(response.headers.get('X-Domino-Request-Id'), /^[a-f0-9-]{36}$/);
}

for (const flag of [undefined, 'false', true, 'TRUE', ' true', 'true ']) {
  test(`read-v2 remains disabled without the exact opt-in string: ${JSON.stringify(flag)}`, async () => {
    const h = harness();
    const settings = { APP_ORIGIN: origin, READ_V2_BRIDGE_ENABLED: flag };
    const response = await h.worker.fetch(new Request(`${origin}/api/read/v2/capabilities`), settings);
    const payload = await response.json();
    assert.equal(response.headers.get('X-Domino-Read-Contract'), CONTRACT_VERSION);
    assert.equal(validateResponse('capabilities', payload), true);
    assert.deepEqual(payload, {
      contractVersion: CONTRACT_VERSION, dataMode: 'disabled', chainId: 4663, enabledReads: [],
      walletAuthentication: false, privateAccounts: false, ownerTransactions: false, automation: false,
    });
    await expectError(await h.worker.fetch(request(), settings), 404, 'route_not_available');
    assert.equal(h.calls.length, 0);
  });
}

for (const v1 of [false, true]) for (const v2 of [false, true]) {
  test(`read version switches are independent: v1=${v1}, v2=${v2}`, async () => {
    const h = harness((url) => url.includes('/v1/') ? upstream({ body: v1Text, version: V1_VERSION }) : upstream());
    const settings = { ...env, READ_BRIDGE_ENABLED: String(v1), ENABLED_READS: 'token', READ_V2_BRIDGE_ENABLED: String(v2) };
    for (const [version, enabled, contract] of [[1, v1, V1_VERSION], [2, v2, CONTRACT_VERSION]]) {
      const response = await h.worker.fetch(request({ version, route: 'capabilities', method: 'GET' }), settings);
      assert.equal(response.headers.get('X-Domino-Read-Contract'), contract);
      const payload = await response.json();
      assert.equal(payload.contractVersion, contract);
      assert.equal(payload.dataMode, enabled ? 'live_read_only' : 'disabled');
      assert.deepEqual(payload.enabledReads, enabled ? [version === 1 ? 'token' : 'pool-market'] : []);
    }
    const token = request({ version: 1, route: 'token', body: JSON.stringify({ token: `0x${'1'.repeat(40)}` }) });
    const responses = await Promise.all([h.worker.fetch(token, settings), h.worker.fetch(request(), settings)]);
    for (const [response, enabled, contract, text] of [
      [responses[0], v1, V1_VERSION, v1Text], [responses[1], v2, CONTRACT_VERSION, fixtureText],
    ]) {
      if (enabled) {
        assert.equal(response.status, 200);
        assert.equal(response.headers.get('X-Domino-Read-Contract'), contract);
        assert.equal(await response.text(), text);
      } else await expectError(response, 404, 'route_not_available', contract);
    }
    assert.equal(h.calls.length, Number(v1) + Number(v2));
  });
}

test('invalid configuration for the other version cannot break this version', async () => {
  const h = harness((url) => url.includes('/v1/') ? upstream({ body: v1Text, version: V1_VERSION }) : upstream());
  assert.equal((await h.worker.fetch(request(), {
    ...env, READ_BRIDGE_ENABLED: 'true', ENABLED_READS: 'invalid',
  })).status, 200);
  assert.equal((await h.worker.fetch(request({ version: 1, route: 'token', body: JSON.stringify({ token: `0x${'1'.repeat(40)}` }) }), {
    ...env, READ_BRIDGE_ENABLED: 'true', ENABLED_READS: 'token', ENABLED_V2_READS: 'invalid',
  })).status, 200);
  assert.equal(h.calls.length, 2);
});

for (const patch of [
  { ENABLED_V2_READS: undefined }, { ENABLED_V2_READS: '' }, { ENABLED_V2_READS: 'token' },
  { ENABLED_V2_READS: 'pool-market,token' }, { ENABLED_V2_READS: 'pool-market,pool-market' },
  { ENABLED_V2_READS: ' pool-market' }, { ENABLED_V2_READS: '__proto__' },
  { GATEWAY_ORIGIN: `${env.GATEWAY_ORIGIN}/internal/read/v1/pool-market` },
  { GATEWAY_ORIGIN: origin }, { GATEWAY_ORIGIN: 'http://gateway.example.invalid' },
  { ACCESS_CLIENT_ID: '' }, { ACCESS_CLIENT_SECRET: 'bad\r\nheader' },
]) test(`active read-v2 configuration fails closed: ${JSON.stringify(patch)}`, async () => {
  const h = harness();
  await expectError(await h.worker.fetch(request(), { ...env, ...patch }), 503, 'upstream_unavailable');
  assert.equal(h.calls.length, 0);
});

test('fixed v2 mapping preserves original request and full response bytes', async () => {
  const h = harness();
  const body = ` { "poolId" : "${fixture.poolId}" }\n`;
  const response = await h.worker.fetch(request({ body }), env);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), fixtureText);
  assert.equal(response.headers.get('X-Domino-Read-Contract'), CONTRACT_VERSION);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, `${env.GATEWAY_ORIGIN}/internal/read/v2/pool-market`);
  assert.equal(h.calls[0].init.method, 'POST');
  assert.equal(h.calls[0].init.body, body);
  assert.equal(h.calls[0].init.redirect, 'manual');
});

test('v2 strips browser credentials and forwards only configured service identity and trusted client metadata', async () => {
  const h = harness(() => upstream({ headers: {
    'Set-Cookie': 'private=secret', Location: 'https://foreign.invalid', 'X-Upstream-Diagnostic': 'private',
  } }));
  const response = await h.worker.fetch(request({ headers: {
    Cookie: 'session=browser-secret', Authorization: 'Bearer browser-secret',
    'CF-Access-Client-Id': 'browser-service', 'CF-Access-Client-Secret': 'browser-secret',
    'Cf-Access-Jwt-Assertion': 'browser-jwt', 'X-Domino-Client-Id': '198.51.100.1',
    Forwarded: 'for=198.51.100.1', 'X-Forwarded-For': '198.51.100.1', 'X-Browser-Header': 'private',
  } }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(h.calls[0].init.headers, {
    'Content-Type': 'application/json', 'X-Domino-Read-Contract': CONTRACT_VERSION,
    'CF-Access-Client-Id': env.ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.ACCESS_CLIENT_SECRET,
    'X-Domino-Client-Id': '203.0.113.7',
  });
  for (const header of ['Set-Cookie', 'Location', 'X-Upstream-Diagnostic', 'Access-Control-Allow-Origin']) {
    assert.equal(response.headers.get(header), null);
  }
});

test('production v2 adapter requires trusted edge client metadata', async () => {
  await expectError(await worker.fetch(request(), env), 503, 'upstream_unavailable');
});

test('v2 origin and fetch-metadata checks run before dispatch', async () => {
  const missingOrigin = request(); missingOrigin.headers.delete('Origin');
  const h = harness();
  for (const input of [
    missingOrigin, request({ headers: { Origin: 'https://foreign.invalid' } }),
    request({ headers: { Origin: `${origin}, ${origin}` } }), request({ headers: { Host: 'foreign.invalid' } }),
    request({ url: 'https://foreign.invalid/api/read/v2/pool-market' }),
    request({ headers: { 'Sec-Fetch-Site': 'same-site' } }), request({ headers: { 'Sec-Fetch-Mode': 'navigate' } }),
    request({ headers: { 'Sec-Fetch-Dest': 'document' } }), request({ headers: { 'Sec-Fetch-User': '?1' } }),
    request({ route: 'capabilities', method: 'GET', headers: { Origin: 'https://foreign.invalid' } }),
  ]) await expectError(await h.worker.fetch(input, env), 403, 'origin_not_allowed');
  assert.equal(h.calls.length, 0);
});

test('v2 exposes only exact pool-market POST and capabilities GET paths', async () => {
  const h = harness();
  for (const suffix of ['token', 'pools', 'session', 'health', 'openapi.json', 'pool-market/',
    'pool-market/extra', '%70ool-market', 'pool-market?url=https://foreign.invalid', 'pool-market#fragment']) {
    await expectError(await h.worker.fetch(request({ route: suffix }), env), 404, 'route_not_available');
  }
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    await expectError(await h.worker.fetch(request({ method }), env), 405, 'method_not_allowed');
  }
  await expectError(await h.worker.fetch(request({ route: 'capabilities' }), env), 405, 'method_not_allowed');
  assert.equal(h.calls.length, 0);
});

test('v2 request is only a poolId: no history, version, chain or URL selectors', async () => {
  const h = harness();
  for (const payload of [
    {}, null, [], { poolId: 1 }, { poolId: `0x${'g'.repeat(64)}` }, { poolId: `${fixture.poolId}\n` },
    { poolId: `0x${fixture.poolId.slice(2).toUpperCase()}` },
    ...Object.entries({ includePriceHistory: false, priceToken: 'base', chainId: 4663,
      url: 'https://foreign.invalid', rpcUrl: 'https://foreign.invalid', contractVersion: V1_VERSION,
      schemaVersion: 1, version: 1, estimate: {} }).map(([key, value]) => ({ poolId: fixture.poolId, [key]: value })),
  ]) await expectError(await h.worker.fetch(request({ body: JSON.stringify(payload) }), env), 422, 'invalid_request');
  for (const body of [
    `{"poolId":"${fixture.poolId}","poolId":"${fixture.poolId}"}`,
    `{"poolId":"${fixture.poolId}","\\u0070oolId":"${fixture.poolId}"}`,
    `{"poolId":"${fixture.poolId}",}`, '\ufeff' + JSON.stringify({ poolId: fixture.poolId }),
  ]) await expectError(await h.worker.fetch(request({ body }), env), 422, 'invalid_request');
  assert.equal(h.calls.length, 0);
});

test('v2 upload enforces content encoding, media type and streamed byte limit', async () => {
  const h = harness();
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Encoding': 'gzip' }]) {
    await expectError(await h.worker.fetch(request({ headers }), env), 415, 'json_required');
  }
  await expectError(await h.worker.fetch(request({ body: ' '.repeat(LIMITS.requestBytes + 1) }), env), 413, 'request_too_large');
  await expectError(await h.worker.fetch(request({ body: new Uint8Array([0xff]) }), env), 422, 'invalid_request');
  assert.equal(h.calls.length, 0);
});

test('browser contract headers cannot select the other version', async () => {
  const h = harness();
  await expectError(await h.worker.fetch(request({ headers: { 'X-Domino-Read-Contract': V1_VERSION } }), env), 502, 'upstream_contract_mismatch');
  await expectError(await h.worker.fetch(request({ version: 1, route: 'token', headers: { 'X-Domino-Read-Contract': CONTRACT_VERSION } }), {
    ...env, READ_BRIDGE_ENABLED: 'true', ENABLED_READS: 'token',
  }), 502, 'upstream_contract_mismatch', V1_VERSION);
  assert.equal(h.calls.length, 0);
});

test('gateway version and payload must both match the fixed v2 contract', async () => {
  for (const options of [
    { version: V1_VERSION }, { version: `${CONTRACT_VERSION}, ${CONTRACT_VERSION}` },
    { body: v1MarketText }, { body: fixtureText, headers: { 'X-Domino-Read-Contract': '' } },
  ]) {
    const h = harness(() => upstream(options));
    await expectError(await h.worker.fetch(request(), env), 502, 'upstream_contract_mismatch');
    assert.equal(h.calls.length, 1);
  }
  const h = harness(() => upstream({ version: V1_VERSION }));
  await expectError(await h.worker.fetch(request({ version: 1 }), {
    ...env, READ_BRIDGE_ENABLED: 'true', ENABLED_READS: 'pool-market',
  }), 502, 'upstream_contract_mismatch', V1_VERSION);
});

test('v2 rejects root, nested market and estimate contract drift without repairing data', async () => {
  for (const mutate of [
    value => { value.extra = true; }, value => { value.executionAvailable = true; },
    value => { value.chainId = 1; }, value => { value.schemaVersion = 2; },
    value => { value.market.extra = true; }, value => { value.estimate.extra = true; },
    value => { delete value.estimate; },
  ]) {
    const value = structuredClone(fixture); mutate(value);
    const h = harness(() => upstream({ body: JSON.stringify(value) }));
    await expectError(await h.worker.fetch(request(), env), 502, 'upstream_contract_mismatch');
  }
});

test('a schema-valid v2 response for another requested pool fails closed', async () => {
  assert.equal(validateResponse('pool-market', fixture), true);
  const h = harness();
  const otherPoolId = `0x${fixture.poolId[2] === '0' ? '1' : '0'}${fixture.poolId.slice(3)}`;
  await expectError(await h.worker.fetch(request({ body: JSON.stringify({ poolId: otherPoolId }) }), env), 502, 'upstream_contract_mismatch');
  assert.equal(h.calls.length, 1);
});

for (const name of (await readdir(new URL('producer/', fixtureRoot))).filter(name => /^pool-market\..+\.json$/.test(name))) {
  test(`v2 preserves the full producer state ${name}`, async () => {
    const text = await readFile(new URL(`producer/${name}`, fixtureRoot), 'utf8');
    const payload = JSON.parse(text);
    assert.equal(validateResponse('pool-market', payload), true);
    const h = harness(() => upstream({ body: text }));
    const response = await h.worker.fetch(request({ body: JSON.stringify({ poolId: payload.poolId }) }), env);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), text);
  });
}

test('v2 sanitizes HTML, redirects and Access failures to finite JSON', async () => {
  for (const options of [
    { status: 200, body: '<html>login</html>', headers: { 'Content-Type': 'text/html' } },
    { status: 504, body: '<html>timeout</html>', headers: { 'Content-Type': 'text/html' } },
    { status: 302, headers: { Location: 'https://foreign.invalid' } }, { status: 401 }, { status: 403 },
  ]) {
    const h = harness(() => upstream(options));
    await expectError(await h.worker.fetch(request(), env), 503, 'upstream_unavailable');
    assert.equal(h.calls.length, 1);
  }
});

test('v2 permits only exact finite error/status pairs and bounds Retry-After', async () => {
  for (const [error, status] of Object.entries(ERROR_STATUS_BY_CODE)) {
    const h = harness(() => upstream({ status, body: JSON.stringify({ error }), headers: { 'Retry-After': '999' } }));
    const response = await h.worker.fetch(request(), env);
    // Infrastructure 401/403 remains sanitized, even with a plausible envelope.
    if (status === 401 || status === 403) await expectError(response, 503, 'upstream_unavailable');
    else {
      assert.equal(response.headers.get('Retry-After'), status === 429 ? '1' : null);
      await expectError(response, status, error);
    }
  }
  for (const [body, code] of [[{ error: 'private_failure' }, 'upstream_unavailable'],
    [{ error: 'upstream_unavailable', private: 'secret' }, 'upstream_invalid_response'],
    [{ error: 'request_timeout' }, 'upstream_unavailable']]) {
    const h = harness(() => upstream({ status: 503, body: JSON.stringify(body) }));
    await expectError(await h.worker.fetch(request(), env), code === 'upstream_invalid_response' ? 502 : 503, code);
  }
});

test('v2 rejects oversized, invalid UTF-8, duplicate-key and encoded gateway bodies', async () => {
  for (const options of [
    { body: ' '.repeat(LIMITS.responseBytes + 1) }, { body: new Uint8Array([0xff]) },
    { body: '{"schemaVersion":1,"schemaVersion":1}' }, { headers: { 'Content-Encoding': 'gzip' } },
  ]) {
    const h = harness(() => upstream(options));
    await expectError(await h.worker.fetch(request(), env), 502, 'upstream_invalid_response');
  }
});

const flush = () => new Promise(resolve => setImmediate(resolve));

test('v2 streamed upload retains the five-second budget with no dispatch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let cancelled = false;
  const h = harness();
  const pending = h.worker.fetch(request({ body: new ReadableStream({ cancel() { cancelled = true; } }) }), env);
  await flush(); t.mock.timers.tick(5001);
  await expectError(await pending, 408, 'request_timeout');
  assert.equal(cancelled, true);
  assert.equal(h.calls.length, 0);
});

test('v2 gateway headers and response streaming share the fifteen-second deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let resolveFetch, signal, cancelled = false;
  const h = harness((_, init) => { signal = init.signal; return new Promise(resolve => { resolveFetch = resolve; }); });
  const pending = h.worker.fetch(request(), env);
  await flush(); t.mock.timers.tick(14000);
  resolveFetch(upstream({ body: new ReadableStream({ cancel() { cancelled = true; } }) }));
  await flush(); t.mock.timers.tick(1001);
  await expectError(await pending, 504, 'upstream_timeout');
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
  assert.equal(h.calls.length, 1);
});

test('v2 absolute deadline rejects late resolved transport without retries', async (t) => {
  let now = 0, signal;
  t.mock.method(Date, 'now', () => now);
  const h = harness((_, init) => { signal = init.signal; now += 21000; return upstream(); });
  await expectError(await h.worker.fetch(request(), env), 504, 'upstream_timeout');
  assert.equal(signal.aborted, true);
  assert.equal(h.calls.length, 1);
});

test('v2 browser disconnect cancels the current gateway request', async () => {
  const abort = new AbortController();
  let signal;
  const h = harness((_, init) => { signal = init.signal; return new Promise(() => {}); });
  const pending = h.worker.fetch(request({ signal: abort.signal }), env);
  await flush(); abort.abort();
  await expectError(await pending, 408, 'request_timeout');
  assert.equal(signal.aborted, true);
  assert.equal(h.calls.length, 1);
});
