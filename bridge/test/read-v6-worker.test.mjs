// read-v6 in the read Worker (spec F7 §6.2; the bridge side of #305, 2026-10-02): Domino V2's wallet reads, portfolio
// and activity, off until their own two flags say otherwise, every answer held to the package's runtime and to the
// request it answers (validateExchange) before it is relayed.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { createWorker, LIMITS } from '../src/worker.mjs';
import { CONTRACT_VERSION as V5_VERSION } from '../../api-contracts/read-v5/runtime.mjs';
import { CONTRACT_VERSION, ERROR_STATUS_BY_CODE, ROUTES, validateError } from '../../api-contracts/read-v6/runtime.mjs';

const origin = 'https://app.example.invalid';
const fixtures = new URL('../../api-contracts/read-v6/fixtures/', import.meta.url);
const text = (path) => readFileSync(new URL(path, fixtures), 'utf8');
const list = (kind) => readdirSync(new URL(`${kind}/`, fixtures)).filter((name) => name.endsWith('.json')).sort()
  .map((name) => [name, text(`${kind}/${name}`)]);
// A fixture answers the longest route its file name starts with, then `.` or `-`.
const routeOf = (name) => [...ROUTES].sort((a, b) => b.length - a.length).find((r) => name.startsWith(r) && '.-'.includes(name[r.length]));
const VALID = list('valid');
const INVALID = list('invalid');
const REQUESTS = Object.fromEntries(['portfolio', 'activity', 'chain-pools', 'chain-balances', 'chain-tokens']
  .map((route) => [route, text(`requests/${route}.json`)]));
const ALL_READS = 'portfolio,activity,chain-pools,chain-balances,chain-tokens';
const WALLET = JSON.parse(REQUESTS.portfolio).wallet;
/** The request each valid answer answers: the page fixture its own request (limit 3, a cursor), the others a first page. */
// A chain read's request is read off its answer; the asked balances answer their request fixture.
function requestFor(name) {
  const route = routeOf(name);
  if (route === 'chain-pools' || route === 'chain-tokens' || route === 'chain-balances') {
    const body = JSON.parse(text(`valid/${name}`));
    if (route === 'chain-pools') return JSON.stringify({ chainId: body.chainId, token: body.token, ...(body.pairedToken ? { pairedToken: body.pairedToken } : {}) });
    if (route === 'chain-tokens') return JSON.stringify({ chainId: body.chainId, query: body.query });
    return name.startsWith('chain-balances-asked') ? REQUESTS['chain-balances'] : JSON.stringify({ wallet: body.wallet });
  }
  return name === 'activity-page.json' ? REQUESTS.activity : JSON.stringify({ wallet: WALLET });
}
const PORTFOLIO = text('valid/portfolio.json');
const env = {
  APP_ORIGIN: origin,
  GATEWAY_ORIGIN: 'https://gateway.example.invalid',
  READ_V6_BRIDGE_ENABLED: 'true',
  ENABLED_V6_READS: 'portfolio,activity',
  ACCESS_CLIENT_ID: 'synthetic-service-id',
  ACCESS_CLIENT_SECRET: 'synthetic-service-secret',
};

/** The [vars] of the reviewed bridge/wrangler.read.toml, as committed. */
function committedVars() {
  const toml = readFileSync(new URL('../wrangler.read.toml', import.meta.url), 'utf8');
  const section = toml.slice(toml.indexOf('[vars]\n') + '[vars]\n'.length).split(/\n\[/)[0];
  return Object.fromEntries(section.split('\n').filter((line) => /^[A-Z0-9_]+ = "/.test(line))
    .map((line) => { const [, name, value] = line.match(/^([A-Z0-9_]+) = "(.*)"$/); return [name, value]; }));
}

function request(route = 'portfolio', options = {}) {
  const { method = 'POST', headers = {}, body = JSON.stringify({ wallet: WALLET }), url = `${origin}/api/read/v6/${route}`, signal } = options;
  return new Request(url, {
    method, signal, headers: { Origin: origin, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', ...headers },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body, duplex: 'half' }),
  });
}
const capabilitiesRequest = (headers = {}) => request('capabilities', { method: 'GET', headers });

function upstream({ body = PORTFOLIO, status = 200, version = CONTRACT_VERSION, headers = {} } = {}) {
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

const DISABLED_CAPABILITIES = {
  contractVersion: CONTRACT_VERSION, dataMode: 'disabled', chainIds: [4663, 8453, 42161], enabledReads: [],
  walletAuthentication: false, privateAccounts: false, ownerTransactions: false, automation: false,
};

test('the committed config keeps read-v6 off: route_not_available on both routes, nothing sent upstream', async () => {
  const vars = committedVars();
  assert.equal(vars.READ_V6_BRIDGE_ENABLED, 'false');
  assert.equal(vars.ENABLED_V6_READS, '');
  const h = harness();
  // Only the origin is the test's: the Worker checks it before the route.
  const settings = { ...vars, APP_ORIGIN: origin };
  for (const route of ['portfolio', 'activity']) {
    await expectError(await h.worker.fetch(request(route), settings), ERROR_STATUS_BY_CODE.route_not_available, 'route_not_available');
  }
  const capabilities = await h.worker.fetch(capabilitiesRequest(), settings);
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.headers.get('X-Domino-Read-Contract'), CONTRACT_VERSION);
  assert.deepEqual(await capabilities.json(), DISABLED_CAPABILITIES);
  assert.equal(h.calls.length, 0);
});

for (const flag of [undefined, 'false', true, 'TRUE', ' true', 'true ', '1']) {
  test(`read-v6 stays off without the exact opt-in string: ${JSON.stringify(flag)}`, async () => {
    const h = harness();
    const settings = { ...env, READ_V6_BRIDGE_ENABLED: flag };
    await expectError(await h.worker.fetch(request(), settings), 404, 'route_not_available');
    await expectError(await h.worker.fetch(request('activity'), settings), 404, 'route_not_available');
    assert.deepEqual(await (await h.worker.fetch(capabilitiesRequest(), settings)).json(), DISABLED_CAPABILITIES);
    assert.equal(h.calls.length, 0);
  });
}

for (const reads of [undefined, '', 'featured-pools', 'capabilities', 'portfolio,portfolio', 'portfolio,overview',
  ' portfolio', 'portfolio ', 'Portfolio', 'portfolio, activity', 'portfolio;activity', '__proto__', 'constructor', '0', '1']) {
  test(`read-v6 fails closed when ENABLED_V6_READS names anything but its routes: ${JSON.stringify(reads)}`, async () => {
    const h = harness();
    const settings = { ...env, ENABLED_V6_READS: reads };
    await expectError(await h.worker.fetch(request(), settings), 503, 'upstream_unavailable');
    // The whole protocol, capabilities included, not just one route.
    await expectError(await h.worker.fetch(capabilitiesRequest(), settings), 503, 'upstream_unavailable');
    assert.equal(h.calls.length, 0);
  });
}

test('ENABLED_V6_READS may open one route alone, and the other stays route_not_available', async () => {
  for (const [reads, open, shut] of [['portfolio', 'portfolio', 'activity'], ['activity', 'activity', 'portfolio']]) {
    const settings = { ...env, ENABLED_V6_READS: reads };
    const h = harness((url) => upstream({ body: url.endsWith('/activity') ? text('valid/activity.json') : PORTFOLIO }));
    assert.equal((await h.worker.fetch(request(open), settings)).status, 200, reads);
    await expectError(await h.worker.fetch(request(shut), settings), 404, 'route_not_available');
    assert.equal(h.calls.length, 1, 'only the open route went upstream');
    assert.deepEqual((await (await h.worker.fetch(capabilitiesRequest(), settings)).json()).enabledReads, [reads]);
  }
  const both = await harness().worker.fetch(capabilitiesRequest(), { ...env, ENABLED_V6_READS: 'activity,portfolio' });
  assert.deepEqual(await both.json(), { ...DISABLED_CAPABILITIES, dataMode: 'live_read_only', enabledReads: ['activity', 'portfolio'] });
});

for (const patch of [{ GATEWAY_ORIGIN: origin }, { GATEWAY_ORIGIN: 'http://gateway.example.invalid' },
  { GATEWAY_ORIGIN: 'https://gateway.example.invalid/internal' }, { ACCESS_CLIENT_ID: '' },
  { ACCESS_CLIENT_SECRET: 'bad\r\nheader' }, { ACCESS_CLIENT_SECRET: undefined }, { APP_ORIGIN: undefined }]) {
  test(`active read-v6 configuration fails closed: ${JSON.stringify(patch)}`, async () => {
    const h = harness();
    await expectError(await h.worker.fetch(request(), { ...env, ...patch }), 503, 'upstream_unavailable');
    assert.equal(h.calls.length, 0);
  });
}

test('on, each route goes to its one upstream path with the service identity, and every valid answer is relayed byte for byte', async () => {
  assert.deepEqual([...ROUTES].sort(), ['activity', 'chain-balances', 'chain-pools', 'chain-tokens', 'portfolio']);
  assert.equal(VALID.length, 18);
  const every = { ...env, ENABLED_V6_READS: ALL_READS };
  for (const [name, body] of VALID) {
    const route = routeOf(name);
    const sent = requestFor(name);
    const h = harness(() => upstream({ body }));
    const response = await h.worker.fetch(request(route, { body: sent }), every);
    assert.equal(response.status, 200, name);
    assert.equal(await response.text(), body, name);
    assert.equal(response.headers.get('X-Domino-Read-Contract'), CONTRACT_VERSION);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
    assert.match(response.headers.get('X-Domino-Request-Id'), /^[0-9a-f-]{36}$/);
    assert.equal(h.calls.length, 1);
    const [{ url, init }] = h.calls;
    assert.equal(url, `https://gateway.example.invalid/internal/read/v6/${route}`);
    assert.equal(init.method, 'POST');
    assert.equal(init.body, sent, 'the request bytes are forwarded as they came');
    assert.equal(init.redirect, 'manual');
    assert.deepEqual(init.headers, {
      'Content-Type': 'application/json', 'X-Domino-Read-Contract': CONTRACT_VERSION,
      'CF-Access-Client-Id': env.ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.ACCESS_CLIENT_SECRET,
      'X-Domino-Client-Id': '203.0.113.7',
    });
  }
  const capabilities = await harness().worker.fetch(capabilitiesRequest(), every);
  assert.deepEqual(await capabilities.json(), { ...DISABLED_CAPABILITIES, dataMode: 'live_read_only', enabledReads: ALL_READS.split(',') });
  const two = await harness().worker.fetch(capabilitiesRequest(), env);
  assert.deepEqual(await two.json(), { ...DISABLED_CAPABILITIES, dataMode: 'live_read_only', enabledReads: ['portfolio', 'activity'] });
});

test('the capabilities name the three chains every stored answer carries, in the answers\' own order', () => {
  for (const [name, body] of VALID.filter(([name]) => !name.startsWith('chain-'))) {
    assert.deepEqual(JSON.parse(body).chains.map((chain) => chain.chainId), DISABLED_CAPABILITIES.chainIds, name);
    assert.equal(JSON.parse(body).schemaVersion, 1, name);
  }
});

test('every invalid answer the producer could serve is refused as upstream_contract_mismatch, never relayed', async () => {
  assert.equal(INVALID.length, 170);
  const every = { ...env, ENABLED_V6_READS: ALL_READS };
  for (const [name, body] of INVALID) {
    const route = routeOf(name);
    const h = harness(() => upstream({ body }));
    const sent = route === 'activity' ? REQUESTS.activity : route.startsWith('chain-') ? requestFor(`${route}.json`) : JSON.stringify({ wallet: WALLET });
    const response = await h.worker.fetch(request(route, { body: sent }), every);
    // A defect the Worker's own envelope check meets first (an answer of another version) is the same refusal.
    assert.equal(response.status, 502, name);
    assert.deepEqual(await response.json(), { error: 'upstream_contract_mismatch' }, name);
    assert.equal(h.calls.length, 1, name);
  }
});

test('an answer about another wallet, or a page longer than asked, is refused: the exchange is the package\'s', async () => {
  const other = '0x' + 'b2'.repeat(20);
  await expectError(await harness().worker.fetch(request('portfolio', { body: JSON.stringify({ wallet: other }) }), env), 502, 'upstream_contract_mismatch');
  const page = text('valid/activity-page.json');
  const shorter = JSON.stringify({ ...JSON.parse(REQUESTS.activity), limit: 2 });
  await expectError(await harness(() => upstream({ body: page })).worker.fetch(request('activity', { body: shorter }), env), 502, 'upstream_contract_mismatch');
  // activity.json's fourteen items answer a first page at the default limit (20), and not a page of ten.
  const fourteen = text('valid/activity.json');
  assert.equal((await harness(() => upstream({ body: fourteen })).worker.fetch(request('activity'), env)).status, 200);
  await expectError(await harness(() => upstream({ body: fourteen })).worker.fetch(request('activity', { body: JSON.stringify({ wallet: WALLET, limit: 10 }) }), env), 502, 'upstream_contract_mismatch');
});

test('a request is the package\'s exactly: any other key, case, bound, lexeme or shape is refused before upstream I/O', async () => {
  for (const [route, body] of [
    ['portfolio', JSON.stringify({ wallet: WALLET.toUpperCase().replace('0X', '0x') })],
    ['portfolio', JSON.stringify({ wallet: WALLET, chainId: 4663 })],
    ['portfolio', JSON.stringify({ wallet: WALLET, limit: 3 })],
    ['portfolio', JSON.stringify({})],
    ['portfolio', JSON.stringify({ wallet: '0x12' })],
    ['activity', JSON.stringify({ wallet: WALLET, limit: 0 })],
    ['activity', JSON.stringify({ wallet: WALLET, limit: 51 })],
    ['activity', JSON.stringify({ wallet: WALLET, limit: '3' })],
    ['activity', `{"wallet":"${WALLET}","limit":3.0}`],
    ['activity', `{"wallet":"${WALLET}","limit":3e0}`],
    ['activity', `{"wallet":"${WALLET}","limit":9007199254740993}`],
    ['activity', JSON.stringify({ wallet: WALLET, cursor: '1.1.1.1' })],
    ['activity', JSON.stringify({ wallet: WALLET, cursor: 7 })],
    ['activity', JSON.stringify({ wallet: WALLET, url: 'https://evil.invalid' })],
    ['activity', `{"wallet":"${WALLET}","wallet":"${WALLET}"}`],
    ['activity', '{"__proto__":{}}'], ['activity', '[]'], ['activity', 'null'], ['activity', ''], ['activity', '{'],
  ]) {
    const h = harness();
    const response = await h.worker.fetch(request(route, { body }), env);
    assert.equal(response.status, 422, `${route} ${body}`);
    assert.deepEqual(await response.json(), { error: 'invalid_request' }, `${route} ${body}`);
    assert.equal(h.calls.length, 0, `${route} ${body}`);
  }
  // A valid limit and cursor pass as written, exact integer lexeme included.
  const h = harness(() => upstream({ body: text('valid/activity-page.json') }));
  assert.equal((await h.worker.fetch(request('activity', { body: REQUESTS.activity }), env)).status, 200);
  assert.equal(h.calls[0].init.body, REQUESTS.activity);
  for (const [headers, error] of [[{ 'Content-Type': 'text/plain' }, 'json_required'], [{ 'Content-Encoding': 'gzip' }, 'json_required']]) {
    const refused = harness();
    await expectError(await refused.worker.fetch(request('portfolio', { headers }), env), ERROR_STATUS_BY_CODE[error], error);
    assert.equal(refused.calls.length, 0);
  }
  const big = harness();
  await expectError(await big.worker.fetch(request('portfolio', { body: ' '.repeat(LIMITS.requestBytes + 1) }), env), 413, 'request_too_large');
  assert.equal(big.calls.length, 0);
});

test('only the exact POST paths reach it; other versions cannot name its routes and it cannot name theirs', async () => {
  const h = harness();
  for (const url of [`${origin}/api/read/v6/portfolio/`, `${origin}/api/read/v6/portfolio?wallet=1`, `${origin}/api/read/v6/Portfolio`,
    `${origin}/api/read/v6/%70ortfolio`, `${origin}/api/read/v6/featured-pools`, `${origin}/api/read/v6/token`, `${origin}/api/read/v6/`,
    `${origin}/api/read/v6/capabilities/`, `${origin}/api/read/v5/portfolio`, `${origin}/api/read/v1/portfolio`, `${origin}/api/read/v3/activity`]) {
    const response = await h.worker.fetch(request('portfolio', { url }), {
      ...env, READ_V5_BRIDGE_ENABLED: 'true', ENABLED_V5_READS: 'featured-pools', READ_V3_BRIDGE_ENABLED: 'true', ENABLED_V3_READS: 'overview,history,search',
    });
    assert.equal(response.status, 404, url);
    assert.deepEqual(await response.json(), { error: 'route_not_available' }, url);
  }
  for (const method of ['GET', 'HEAD', 'PUT', 'DELETE', 'OPTIONS']) {
    const response = await h.worker.fetch(request('portfolio', { method }), env);
    assert.equal(response.status, 405, method);
  }
  assert.equal((await h.worker.fetch(request('capabilities'), env)).status, 405, 'capabilities is GET only');
  // A browser contract header, if sent, is v6's exactly.
  for (const version of [V5_VERSION, '1.0.0-rc.2', '1.0.0', `${CONTRACT_VERSION}, ${CONTRACT_VERSION}`]) {
    await expectError(await h.worker.fetch(request('portfolio', { headers: { 'X-Domino-Read-Contract': version } }), env), 502, 'upstream_contract_mismatch');
    await expectError(await h.worker.fetch(capabilitiesRequest({ 'X-Domino-Read-Contract': version }), env), 502, 'upstream_contract_mismatch');
  }
  assert.equal(h.calls.length, 0);
  assert.equal((await harness().worker.fetch(request('portfolio', { headers: { 'X-Domino-Read-Contract': CONTRACT_VERSION } }), env)).status, 200);
});

test('browser checks run before dispatch; a capabilities GET may omit Origin but not name another', async () => {
  const h = harness();
  for (const headers of [{ Origin: 'https://evil.invalid' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Mode': 'navigate' }, { 'Sec-Fetch-Dest': 'document' }, { 'Sec-Fetch-User': '?1' }, { Host: 'other.example.invalid' }]) {
    await expectError(await h.worker.fetch(request('portfolio', { headers }), env), 403, 'origin_not_allowed');
    await expectError(await h.worker.fetch(capabilitiesRequest(headers), env), 403, 'origin_not_allowed');
  }
  const noOrigin = request(); noOrigin.headers.delete('Origin');
  await expectError(await h.worker.fetch(noOrigin, env), 403, 'origin_not_allowed');
  const capability = capabilitiesRequest(); capability.headers.delete('Origin');
  assert.equal((await h.worker.fetch(capability, env)).status, 200);
  assert.equal(h.calls.length, 0);
});

test('the gateway answer must carry v6 and be finite JSON; a known refusal passes with its own status', async () => {
  for (const [responder, status, error] of [
    [() => upstream({ version: V5_VERSION }), 502, 'upstream_contract_mismatch'],
    [() => upstream({ version: '1.0.0-rc.2' }), 502, 'upstream_contract_mismatch'],
    [() => upstream({ headers: { 'Content-Type': 'text/html' }, body: '<html>login</html>' }), 503, 'upstream_unavailable'],
    [() => upstream({ status: 302, headers: { Location: 'https://evil.invalid' } }), 503, 'upstream_unavailable'],
    [() => upstream({ status: 401, body: '{"error":"origin_not_allowed"}' }), 503, 'upstream_unavailable'],
    [() => upstream({ body: '{"error":"catalogue_database_unavailable"}', status: 503 }), 503, 'catalogue_database_unavailable'],
    [() => upstream({ body: '{"error":"upstream_unavailable"}', status: 503 }), 503, 'upstream_unavailable'],
    [() => upstream({ body: '{"error":"route_not_available"}', status: 404 }), 404, 'route_not_available'],
    [() => upstream({ body: '{"error":"read_deadline_exceeded"}', status: 504 }), 504, 'read_deadline_exceeded'],
    [() => upstream({ body: '{"error":"invalid_request"}', status: 422 }), 422, 'invalid_request'],
    [() => upstream({ body: '{"error":"v2_receipt_unanchored"}', status: 503 }), 503, 'upstream_unavailable'],
    [() => upstream({ body: '{"error":"read_capacity_busy"}', status: 503 }), 503, 'upstream_unavailable'],
    [() => upstream({ body: '{"error":"upstream_unavailable"}' }), 502, 'upstream_invalid_response'],
    [() => upstream({ body: `${PORTFOLIO.slice(0, -2)},"schemaVersion":1}` }), 502, 'upstream_invalid_response'],
    [() => upstream({ body: JSON.stringify({ ...JSON.parse(PORTFOLIO), schemaVersion: 2 }) }), 502, 'upstream_contract_mismatch'],
    [() => upstream({ body: JSON.stringify({ ...JSON.parse(PORTFOLIO), chainId: 4663 }) }), 502, 'upstream_contract_mismatch'],
    [() => upstream({ headers: { 'Content-Encoding': 'gzip' } }), 502, 'upstream_invalid_response'],
    [() => upstream({ body: ' '.repeat(LIMITS.responseBytes + 1) }), 502, 'upstream_invalid_response'],
    [() => upstream({ headers: { 'Content-Length': String(LIMITS.responseBytes + 1) } }), 502, 'upstream_invalid_response'],
    [() => new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': CONTRACT_VERSION } }), 502, 'upstream_invalid_response'],
  ]) {
    const h = harness(responder);
    await expectError(await h.worker.fetch(request(), env), status, error);
    assert.equal(h.calls.length, 1, 'no retry');
  }
  // Busy: the wait is passed on, bounded to 1-60 s.
  for (const [given, passed] of [['7', '7'], ['600', '1'], [null, '1']]) {
    const busy = harness(() => upstream({ body: '{"error":"read_capacity_busy"}', status: 429, headers: given ? { 'Retry-After': given } : {} }));
    const response = await busy.worker.fetch(request(), env);
    assert.equal(response.headers.get('Retry-After'), passed);
    await expectError(response, 429, 'read_capacity_busy');
  }
  // Every error the Worker writes is one the package's validateError accepts with that status.
  for (const [code, status] of Object.entries(ERROR_STATUS_BY_CODE)) assert.equal(validateError(status, { error: code }), true, code);
});

test('the gateway exchange shares the read budget: a stalled upstream is cut at 15 s and its late body cancelled', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let resolve, cancelled = false;
  const h = harness(() => new Promise((done) => { resolve = done; }));
  const pending = h.worker.fetch(request(), env);
  for (let i = 0; i < 24; i++) await Promise.resolve();
  assert.equal(h.calls.length, 1);
  t.mock.timers.tick(LIMITS.upstreamMs + 1);
  await expectError(await pending, 504, 'upstream_timeout');
  assert.equal(h.calls[0].init.signal.aborted, true);
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  for (let i = 0; i < 24; i++) await Promise.resolve();
  assert.equal(cancelled, true);
});

test('the hop record names the route and never the wallet, the cursor or the answer', async (t) => {
  const lines = [];
  t.mock.method(console, 'log', (line) => { lines.push(line); });
  await harness(() => upstream({ body: text('valid/activity-page.json') })).worker.fetch(request('activity', { body: REQUESTS.activity }), env);
  await harness().worker.fetch(request('portfolio', { body: JSON.stringify({ wallet: '0x' + 'b2'.repeat(20) }) }), env);
  assert.equal(lines.length, 2);
  const [first, second] = lines.map((line) => JSON.parse(line));
  assert.deepEqual({ ...first, requestId: null, durationMs: null }, {
    service: 'read-bridge', requestId: null, route: 'activity', contractVersion: CONTRACT_VERSION, method: 'POST', status: 200, durationMs: null,
  });
  assert.equal(second.reason, 'upstream_contract_mismatch');
  // The request id is a random UUID: left out, so it can never be mistaken for a leak.
  const all = [first, second].map(({ requestId: _id, ...rest }) => JSON.stringify(rest)).join('\n');
  assert.equal(/b1b1b1|b2b2b2|1790425234|0x/.test(all), false, 'no wallet, cursor or answer in the record');
});

test('read-v5 and read-v6 switch independently, and a broken v6 list cannot break v5', async () => {
  const both = { ...env, READ_V5_BRIDGE_ENABLED: 'true', ENABLED_V5_READS: 'featured-pools' };
  for (const [settings, v5, v6] of [
    [{ ...both, READ_V5_BRIDGE_ENABLED: 'false' }, 'disabled', 'live_read_only'],
    [{ ...both, READ_V6_BRIDGE_ENABLED: 'false' }, 'live_read_only', 'disabled'],
    [both, 'live_read_only', 'live_read_only'],
  ]) {
    const h = harness();
    for (const [version, mode] of [[5, v5], [6, v6]]) {
      const response = await h.worker.fetch(request('capabilities', { method: 'GET', url: `${origin}/api/read/v${version}/capabilities` }), settings);
      assert.equal((await response.json()).dataMode, mode, `v${version}`);
    }
  }
  const h = harness();
  const v5 = await h.worker.fetch(request('capabilities', { method: 'GET', url: `${origin}/api/read/v5/capabilities` }), { ...both, ENABLED_V6_READS: 'overview' });
  assert.equal(v5.status, 200);
  assert.equal((await v5.json()).chainId, 4663, 'read-v5 keeps its one chain');
  const v6 = await h.worker.fetch(capabilitiesRequest(), { ...both, ENABLED_V5_READS: 'portfolio' });
  assert.equal(v6.status, 200);
});
