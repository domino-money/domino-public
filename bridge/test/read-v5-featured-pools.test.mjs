// read-v5 in the read Worker (featured-pools v1 §10.3): one fixed route, the
// same question for every visitor, off until its own two flags say otherwise.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { createWorker } from '../src/worker.mjs';
import { CONTRACT_VERSION as V3_VERSION } from '../../api-contracts/read-v3/runtime.mjs';
import { CONTRACT_VERSION, ERROR_STATUS_BY_CODE, ROUTES } from '../../api-contracts/read-v5/runtime.mjs';

const origin = 'https://app.example.invalid';
const fixtures = new URL('../../api-contracts/read-v5/fixtures/', import.meta.url);
const read = (kind) => readdirSync(new URL(`${kind}/`, fixtures)).filter((name) => name.endsWith('.json')).sort()
  .map((name) => [name, readFileSync(new URL(`${kind}/${name}`, fixtures), 'utf8')]);
const VALID = read('valid');
const INVALID = read('invalid');
const CURRENT = VALID.find(([name]) => name === 'current.json')[1];
const env = {
  APP_ORIGIN: origin,
  GATEWAY_ORIGIN: 'https://gateway.example.invalid',
  READ_V5_BRIDGE_ENABLED: 'true',
  ENABLED_V5_READS: 'featured-pools',
  ACCESS_CLIENT_ID: 'synthetic-service-id',
  ACCESS_CLIENT_SECRET: 'synthetic-service-secret',
};

/** The [vars] of the reviewed bridge/wrangler.read.toml, as committed. */
function committedVars() {
  const text = readFileSync(new URL('../wrangler.read.toml', import.meta.url), 'utf8');
  const section = text.slice(text.indexOf('[vars]\n') + '[vars]\n'.length).split(/\n\[/)[0];
  return Object.fromEntries(section.split('\n').filter((line) => /^[A-Z0-9_]+ = "/.test(line))
    .map((line) => { const [, name, value] = line.match(/^([A-Z0-9_]+) = "(.*)"$/); return [name, value]; }));
}

function request(options = {}) {
  const { method = 'POST', headers = {}, body = '{}', url = `${origin}/api/read/v5/featured-pools` } = options;
  return new Request(url, {
    method, headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body, duplex: 'half' }),
  });
}

function upstream({ body = CURRENT, status = 200, version = CONTRACT_VERSION, headers = {} } = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': version, ...headers } });
}

function harness(responder = () => upstream()) {
  const calls = [];
  return { calls, worker: createWorker({
    getClientIp: () => '203.0.113.7',
    fetch: async (url, init) => { calls.push({ url, init }); return responder(url, init); },
  }) };
}

async function expectError(response, status, error) {
  assert.equal(response.status, status);
  assert.deepEqual(await response.json(), { error });
  assert.equal(response.headers.get('X-Domino-Read-Contract'), CONTRACT_VERSION);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(response.headers.get('Set-Cookie'), null);
}

test('the committed config keeps read-v5 off: route_not_available, and nothing is sent upstream', async () => {
  const vars = committedVars();
  assert.equal(vars.READ_V5_BRIDGE_ENABLED, 'false');
  assert.equal(vars.ENABLED_V5_READS, '');
  const h = harness();
  // Only the origin is the test's: the Worker checks it before the route.
  await expectError(await h.worker.fetch(request(), { ...vars, APP_ORIGIN: origin }), ERROR_STATUS_BY_CODE.route_not_available, 'route_not_available');
  const capabilities = await h.worker.fetch(request({ method: 'GET', url: `${origin}/api/read/v5/capabilities` }), { ...vars, APP_ORIGIN: origin });
  assert.equal(capabilities.status, 200);
  assert.equal((await capabilities.json()).dataMode, 'disabled');
  assert.equal(h.calls.length, 0);
});

for (const flag of [undefined, 'false', true, 'TRUE', ' true', 'true ', '1']) {
  test(`read-v5 stays off without the exact opt-in string: ${JSON.stringify(flag)}`, async () => {
    const h = harness();
    const settings = { ...env, READ_V5_BRIDGE_ENABLED: flag };
    await expectError(await h.worker.fetch(request(), settings), 404, 'route_not_available');
    const response = await h.worker.fetch(request({ method: 'GET', url: `${origin}/api/read/v5/capabilities` }), settings);
    assert.equal(response.headers.get('X-Domino-Read-Contract'), CONTRACT_VERSION);
    assert.deepEqual(await response.json(), {
      contractVersion: CONTRACT_VERSION, dataMode: 'disabled', chainId: 4663, enabledReads: [],
      walletAuthentication: false, privateAccounts: false, ownerTransactions: false, automation: false,
    });
    assert.equal(h.calls.length, 0);
  });
}

for (const reads of [undefined, '', 'overview', 'sequence-snapshot', 'capabilities', 'featured-pools,overview',
  'featured-pools,featured-pools', ' featured-pools', 'featured-pools ', 'Featured-pools', 'featured_pools', '__proto__', 'constructor']) {
  test(`read-v5 fails closed when ENABLED_V5_READS names anything but its route: ${JSON.stringify(reads)}`, async () => {
    const h = harness();
    const settings = { ...env, ENABLED_V5_READS: reads };
    await expectError(await h.worker.fetch(request(), settings), 503, 'upstream_unavailable');
    // The whole protocol, capabilities included, not just the one route.
    await expectError(await h.worker.fetch(request({ method: 'GET', url: `${origin}/api/read/v5/capabilities` }), settings), 503, 'upstream_unavailable');
    assert.equal(h.calls.length, 0);
  });
}

for (const patch of [{ GATEWAY_ORIGIN: origin }, { GATEWAY_ORIGIN: 'http://gateway.example.invalid' },
  { ACCESS_CLIENT_ID: '' }, { ACCESS_CLIENT_SECRET: 'bad\r\nheader' }, { APP_ORIGIN: undefined }]) {
  test(`active read-v5 configuration fails closed: ${JSON.stringify(patch)}`, async () => {
    const h = harness();
    await expectError(await h.worker.fetch(request(), { ...env, ...patch }), 503, 'upstream_unavailable');
    assert.equal(h.calls.length, 0);
  });
}

test('on, it forwards {} to the one upstream path with the service identity and relays every valid answer byte for byte', async () => {
  assert.deepEqual(Object.keys(ROUTES), ['featured-pools']);
  assert.equal(VALID.length, 5);
  for (const [name, text] of VALID) {
    const h = harness(() => upstream({ body: text }));
    const response = await h.worker.fetch(request({ body: ' { }\n' }), env);
    assert.equal(response.status, 200, name);
    assert.equal(await response.text(), text, name);
    assert.equal(response.headers.get('X-Domino-Read-Contract'), CONTRACT_VERSION);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(h.calls.length, 1);
    const [{ url, init }] = h.calls;
    assert.equal(url, 'https://gateway.example.invalid/internal/read/v5/featured-pools');
    assert.equal(init.method, 'POST');
    assert.equal(init.body, ' { }\n', 'the request bytes are forwarded as they came');
    assert.equal(init.redirect, 'manual');
    const headers = new Headers(init.headers);
    assert.equal(headers.get('X-Domino-Read-Contract'), CONTRACT_VERSION);
    assert.equal(headers.get('CF-Access-Client-Id'), env.ACCESS_CLIENT_ID);
    assert.equal(headers.get('CF-Access-Client-Secret'), env.ACCESS_CLIENT_SECRET);
    assert.equal(headers.get('X-Domino-Client-Id'), '203.0.113.7');
    assert.equal(headers.get('Cookie'), null);
    assert.equal(headers.get('Origin'), null);
  }
  const capabilities = await harness().worker.fetch(request({ method: 'GET', url: `${origin}/api/read/v5/capabilities` }), env);
  assert.deepEqual((await capabilities.json()).enabledReads, ['featured-pools']);
});

test('every invalid list the producer could store is refused as upstream_contract_mismatch, never relayed', async () => {
  assert.equal(INVALID.length, 50);
  for (const [name, text] of INVALID) {
    const h = harness(() => upstream({ body: text }));
    const response = await h.worker.fetch(request(), env);
    assert.equal(response.status, 502, name);
    assert.deepEqual(await response.json(), { error: 'upstream_contract_mismatch' }, name);
    assert.equal(h.calls.length, 1);
  }
});

test('the request names nothing: any key, shape or selector is refused before upstream I/O', async () => {
  for (const body of ['{"poolIds":[]}', '{"limit":6}', '{"url":"https://evil.invalid"}', '{"__proto__":{}}', '{"":null}',
    '[]', 'null', '""', '0', '{}{}', '{', '', '{"a":1,"a":1}']) {
    const h = harness();
    const response = await h.worker.fetch(request({ body }), env);
    assert.equal(response.status, 422, body);
    assert.deepEqual(await response.json(), { error: 'invalid_request' }, body);
    assert.equal(h.calls.length, 0, body);
  }
  for (const [headers, error] of [[{ 'Content-Type': 'text/plain' }, 'json_required'], [{ 'Content-Encoding': 'gzip' }, 'json_required']]) {
    const h = harness();
    await expectError(await h.worker.fetch(request({ headers }), env), ERROR_STATUS_BY_CODE[error], error);
    assert.equal(h.calls.length, 0);
  }
});

test('only the exact POST path reaches it; other versions cannot name it and it cannot name theirs', async () => {
  const h = harness();
  for (const url of [`${origin}/api/read/v5/featured-pools/`, `${origin}/api/read/v5/featured-pools?x=1`, `${origin}/api/read/v5/Featured-pools`,
    `${origin}/api/read/v5/%66eatured-pools`, `${origin}/api/read/v5/featured_pools`, `${origin}/api/read/v5/overview`,
    `${origin}/api/read/v5/sequence-snapshot`, `${origin}/api/read/v5/token`, `${origin}/api/read/v5/`, `${origin}/api/read/v4/featured-pools`,
    `${origin}/api/read/v3/featured-pools`, `${origin}/api/read/v1/featured-pools`]) {
    const response = await h.worker.fetch(request({ url }), { ...env, READ_V4_BRIDGE_ENABLED: 'true', ENABLED_V4_READS: 'sequence-snapshot' });
    assert.equal(response.status, 404, url);
    assert.deepEqual(await response.json(), { error: 'route_not_available' }, url);
  }
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
    const response = await h.worker.fetch(request({ method, body: method === 'GET' || method === 'HEAD' ? undefined : '{}' }), env);
    assert.equal(response.status, 405, method);
  }
  // A browser contract header, if sent, is v5's exactly. (read-v4 happens to
  // share v5's version string, so the path, not the header, keeps them apart.)
  for (const version of [V3_VERSION, '1.0.0-rc.2', `${CONTRACT_VERSION}, ${CONTRACT_VERSION}`]) {
    await expectError(await h.worker.fetch(request({ headers: { 'X-Domino-Read-Contract': version } }), env), 502, 'upstream_contract_mismatch');
  }
  assert.equal(h.calls.length, 0);
  assert.equal((await harness().worker.fetch(request({ headers: { 'X-Domino-Read-Contract': CONTRACT_VERSION } }), env)).status, 200);
});

test('browser checks run before dispatch', async () => {
  const h = harness();
  for (const headers of [{ Origin: 'https://evil.invalid' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Mode': 'navigate' },
    { 'Sec-Fetch-Dest': 'document' }, { 'Sec-Fetch-User': '?1' }]) {
    await expectError(await h.worker.fetch(request({ headers }), env), 403, 'origin_not_allowed');
  }
  assert.equal(h.calls.length, 0);
});

test('the gateway answer must carry v5 and be finite JSON; a known refusal passes with its own status', async () => {
  for (const [responder, status, error] of [
    [() => upstream({ version: V3_VERSION }), 502, 'upstream_contract_mismatch'],
    [() => upstream({ version: '1.0.0-rc.2' }), 502, 'upstream_contract_mismatch'],
    [() => upstream({ headers: { 'Content-Type': 'text/html' }, body: '<html>login</html>' }), 503, 'upstream_unavailable'],
    [() => upstream({ status: 302, headers: { Location: 'https://evil.invalid' } }), 503, 'upstream_unavailable'],
    [() => upstream({ body: '{"error":"upstream_contract_mismatch"}', status: 502 }), 502, 'upstream_contract_mismatch'],
    [() => upstream({ body: '{"error":"route_not_available"}', status: 404 }), 404, 'route_not_available'],
    [() => upstream({ body: '{"error":"read_capacity_busy"}', status: 429 }), 429, 'read_capacity_busy'],
    [() => upstream({ body: '{"error":"private_detail"}', status: 503 }), 503, 'upstream_unavailable'],
    [() => upstream({ body: `${CURRENT.slice(0, -2)},"schemaVersion":1}` }), 502, 'upstream_invalid_response'],
    [() => upstream({ body: '{"error":"upstream_unavailable"}' }), 502, 'upstream_invalid_response'],
  ]) {
    const h = harness(responder);
    await expectError(await h.worker.fetch(request(), env), status, error);
    assert.equal(h.calls.length, 1, 'no retry');
  }
});

test('read-v4 and read-v5 switch independently, and a broken v5 list cannot break v4', async () => {
  const both = { ...env, READ_V4_BRIDGE_ENABLED: 'true', ENABLED_V4_READS: 'sequence-snapshot' };
  for (const [settings, v4, v5] of [
    [{ ...both, READ_V4_BRIDGE_ENABLED: 'false' }, 'disabled', 'live_read_only'],
    [{ ...both, READ_V5_BRIDGE_ENABLED: 'false' }, 'live_read_only', 'disabled'],
    [both, 'live_read_only', 'live_read_only'],
  ]) {
    const h = harness();
    for (const [version, mode] of [[4, v4], [5, v5]]) {
      const response = await h.worker.fetch(request({ method: 'GET', url: `${origin}/api/read/v${version}/capabilities` }), settings);
      assert.equal((await response.json()).dataMode, mode, `v${version}`);
    }
  }
  const h = harness();
  const v4 = await h.worker.fetch(request({ method: 'GET', url: `${origin}/api/read/v4/capabilities` }), { ...both, ENABLED_V5_READS: 'overview' });
  assert.equal(v4.status, 200);
  const v5 = await h.worker.fetch(request({ method: 'GET', url: `${origin}/api/read/v5/capabilities` }), { ...both, ENABLED_V4_READS: 'featured-pools' });
  assert.equal(v5.status, 200);
});
