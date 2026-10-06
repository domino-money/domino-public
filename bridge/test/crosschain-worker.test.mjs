// crosschain-v1 through the authenticated bridge (spec F7 §3.2; the bridge side of S2, open point #17, 2026-10-02): the
// session boundary of onboarding's, deposit's and position-plan's transport, every answer held to the package's runtime
// (the decision recomputed, the steps to the pinned contracts only) and to the request this browser sent, off until its
// own flag says otherwise, a capabilities GET of its own, and never a call to a provider.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { createCrosschainWorker, CROSSCHAIN_LIMITS } from '../src/crosschain-worker.mjs';
import { CONTRACT_VERSION, ROUTES, ERROR_STATUS_BY_CODE, validateRequest, validateResponse, validateError } from '../../api-contracts/crosschain-v1/runtime.mjs';

const origin = 'https://app.example.invalid';
const session = 's'.repeat(43), csrf = 'c'.repeat(43);
const HEADER = 'X-Domino-Crosschain-Contract';
const env = { APP_ORIGIN: origin, CROSSCHAIN_BRIDGE_ENABLED: 'true',
  CROSSCHAIN_GATEWAY_ORIGIN: 'https://crosschain.example.invalid',
  CROSSCHAIN_ACCESS_CLIENT_ID: 'synthetic-crosschain-id', CROSSCHAIN_ACCESS_CLIENT_SECRET: 'synthetic-crosschain-secret' };
const fixtures = new URL('../../api-contracts/crosschain-v1/fixtures/', import.meta.url);
const json = (path) => JSON.parse(readFileSync(new URL(path, fixtures), 'utf8'));
const routeOf = (name) => name.split('/').at(-1).split('.')[0];
const REQUESTS = Object.fromEntries(ROUTES.map((route) => [route, json(`requests/${route}.json`)]));
const RESPONSES = Object.fromEntries(ROUTES.map((route) => [route, json(`responses/${route}.json`)]));
/** Every answer the producer serves: the three responses, then the variants, each with its route. */
const ANSWERS = [...ROUTES.map((route) => [`responses/${route}.json`, route, RESPONSES[route]]),
  ...readdirSync(new URL('variants/', fixtures)).sort().map((name) => [`variants/${name}`, routeOf(name), json(`variants/${name}`)])];
const QUOTE = RESPONSES.quote, STATUS = RESPONSES.status, ORIGINS = RESPONSES.origins;
const OTHER = '0x' + '9'.repeat(40);
/** Charge currencies of the three destinations (XC schema-data destinations): Robinhood Chain's WETH, Base's USDC. */
const WETH_RH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73', USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';

/** What a browser sends for an answer: its echo without the owner (a listing echoes the destination it was asked for). */
function sentFor(route, answer) {
  if (route === 'origins') return { destinationChainId: answer.origins.destinationChainId, destinationToken: answer.origins.destinationToken };
  const { owner: _owner, ...echo } = route === 'quote' ? answer.quote.request : answer.status.request;
  return echo;
}

/** When the service answered: a listing's retrievedAt, a quote's requestedAt, a status report's checkedAt. */
const anchor = (route, answer) => (route === 'origins' ? answer.origins.retrievedAt : route === 'quote' ? answer.quote.requestedAt : answer.status.checkedAt);

/** Date.now() inside the answer's own minute: ten seconds after the listener answered. */
function during(t, route = 'quote', answer = RESPONSES[route], offset = 10) {
  const now = (anchor(route, answer) + offset) * 1000;
  t.mock.method(Date, 'now', () => now);
}

function request(options = {}) {
  const { route = 'quote', method = 'POST', body = JSON.stringify(REQUESTS[route]), headers = {},
    url = `${origin}/api/crosschain/v1/${route}`, ...rest } = options;
  return new Request(url, { method, headers: { Origin: origin, 'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
    Cookie: `__Host-domino-session=${session}`, 'X-Domino-CSRF': csrf, ...headers },
    ...(['GET', 'HEAD'].includes(method) ? {} : { body, duplex: 'half' }), ...rest });
}
function capabilitiesRequest(headers = {}, method = 'GET') {
  return new Request(`${origin}/api/crosschain/v1/capabilities`, { method,
    headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', ...headers },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}', duplex: 'half' }) });
}
function response(value, status = 200, headers = {}) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status,
    headers: { 'Content-Type': 'application/json', [HEADER]: CONTRACT_VERSION, ...headers } });
}
/** The listener's own fixture for whichever route was asked, unless the test answers otherwise. */
const fixtureFor = (url) => response(RESPONSES[routeOf(String(url))]);
function harness(responder = fixtureFor, ip = '203.0.113.7') {
  const calls = [];
  return { calls, worker: createCrosschainWorker({ getClientIp: () => ip,
    fetch: (url, init) => { calls.push({ url, init }); return responder(url, init); } }) };
}
async function error(result, code) {
  assert.equal(result.status, ERROR_STATUS_BY_CODE[code], code);
  assert.deepEqual(await result.json(), { error: code });
  assert.equal(result.headers.get(HEADER), CONTRACT_VERSION);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(result.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(result.headers.get('Set-Cookie'), null);
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), null);
}
async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }

/** The [vars] of the reviewed bridge/wrangler.crosschain.toml, as committed. */
function committed() {
  const toml = readFileSync(new URL('../wrangler.crosschain.toml', import.meta.url), 'utf8');
  const section = toml.slice(toml.indexOf('[vars]\n') + '[vars]\n'.length).split(/\n\[/)[0];
  return { toml, vars: Object.fromEntries(section.split('\n').filter((line) => /^[A-Z0-9_]+ = "/.test(line))
    .map((line) => { const [, name, value] = line.match(/^([A-Z0-9_]+) = "(.*)"$/); return [name, value]; })) };
}

test('the committed config keeps the three routes off, logs nothing and names its own gateway', async () => {
  const { toml, vars } = committed();
  assert.deepEqual(vars, { CROSSCHAIN_BRIDGE_ENABLED: 'false', APP_ORIGIN: 'https://domino.money',
    CROSSCHAIN_GATEWAY_ORIGIN: 'https://vm-crosschain.domino.money' });
  assert.match(toml, /^name = "domino-crosschain-bridge"$/m);
  assert.match(toml, /^main = "src\/crosschain-worker\.mjs"$/m);
  assert.match(toml, /^\[observability\]\nenabled = false$/m);
  const h = harness();
  for (const route of ROUTES) await error(await h.worker.fetch(request({ route }), { ...vars, APP_ORIGIN: origin }), 'route_not_available');
  const capabilities = await h.worker.fetch(capabilitiesRequest(), { ...vars, APP_ORIGIN: origin });
  assert.deepEqual(await capabilities.json(), { contractVersion: CONTRACT_VERSION, dataMode: 'disabled', enabledRoutes: [] });
  assert.equal(h.calls.length, 0);
});

test('the routes default off and cannot inherit another family\'s activation', async () => {
  const h = harness();
  for (const settings of [{ APP_ORIGIN: origin }, { APP_ORIGIN: origin, CROSSCHAIN_BRIDGE_ENABLED: true },
    { APP_ORIGIN: origin, CROSSCHAIN_BRIDGE_ENABLED: 'TRUE' }, { APP_ORIGIN: origin, CROSSCHAIN_BRIDGE_ENABLED: ' true' },
    { APP_ORIGIN: origin, ONBOARDING_BRIDGE_ENABLED: 'true', POSITION_PLAN_BRIDGE_ENABLED: 'true', SESSION_BRIDGE_ENABLED: 'true',
      POSITION_PLAN_GATEWAY_ORIGIN: 'https://position-plan.example.invalid', POSITION_PLAN_ACCESS_CLIENT_ID: 'x', POSITION_PLAN_ACCESS_CLIENT_SECRET: 'y' }]) {
    for (const route of ROUTES) await error(await h.worker.fetch(request({ route }), settings), 'route_not_available');
    const capabilities = await h.worker.fetch(capabilitiesRequest(), settings);
    assert.equal((await capabilities.json()).dataMode, 'disabled');
  }
  assert.equal(h.calls.length, 0);
});

for (const settings of [
  { APP_ORIGIN: 'http://app.example.invalid' }, { APP_ORIGIN: `${origin}/` },
  { CROSSCHAIN_GATEWAY_ORIGIN: origin }, { CROSSCHAIN_GATEWAY_ORIGIN: 'http://crosschain.example.invalid' },
  { CROSSCHAIN_GATEWAY_ORIGIN: `${env.CROSSCHAIN_GATEWAY_ORIGIN}/internal` },
  { CROSSCHAIN_ACCESS_CLIENT_ID: '' }, { CROSSCHAIN_ACCESS_CLIENT_SECRET: 'bad\nsecret' },
  { CROSSCHAIN_ACCESS_CLIENT_SECRET: undefined, POSITION_PLAN_ACCESS_CLIENT_SECRET: 'plan-secret' },
  { CROSSCHAIN_ACCESS_CLIENT_ID: undefined, ACCESS_CLIENT_ID: 'reader-id' },
  { CROSSCHAIN_GATEWAY_ORIGIN: undefined, GATEWAY_ORIGIN: 'https://vm-read.example.invalid' },
]) test(`an incomplete configuration answers upstream_unavailable, capabilities included: ${JSON.stringify(settings)}`, async () => {
  const h = harness();
  await error(await h.worker.fetch(request(), { ...env, ...settings }), 'upstream_unavailable');
  await error(await h.worker.fetch(capabilitiesRequest(), { ...env, ...settings }), 'upstream_unavailable');
  assert.equal(h.calls.length, 0);
});

test('every answer the producer serves passes through exactly, for its route, with only the fixed authentication headers upstream', async (t) => {
  assert.deepEqual([...ROUTES], ['origins', 'quote', 'status']);
  // Changed on purpose (data) 2026-10-06 (1.1.0-rc.1): three quotes by output join the variants.
  assert.equal(ANSWERS.length, 13);
  for (const [name, route, answer] of ANSWERS) {
    t.mock.restoreAll();
    during(t, route, answer);
    const sent = sentFor(route, answer);
    assert.equal(validateRequest(route, sent), true, `${name}: the app could send it`);
    const body = JSON.stringify(sent);
    const h = harness(() => response(answer, 200, { 'Set-Cookie': 'evil=secret', Location: 'https://evil.invalid',
      Authorization: 'secret', 'X-Provider-Key': 'secret', 'X-Domino-CSRF': 'secret' }));
    const result = await h.worker.fetch(request({ route, body, headers: {
      Cookie: `unrelated=secret; __Host-domino-preauth=${'p'.repeat(43)}; __Host-domino-session=${session}`,
      'X-Domino-Session': 'forged-session', 'X-Domino-Client-Id': 'forged-ip', 'X-Domino-Browser-Origin': 'https://evil.invalid',
      'CF-Access-Jwt-Assertion': 'forged-assertion', 'CF-Access-Client-Id': 'forged-id', 'CF-Access-Client-Secret': 'forged-secret',
      Authorization: 'forged-bearer', 'X-Forwarded-For': '192.0.2.1',
    } }), env);
    assert.equal(result.status, 200, name);
    assert.deepEqual(await result.json(), answer, name);
    assert.equal(validateResponse(route, answer), true);
    assert.equal(result.headers.get(HEADER), CONTRACT_VERSION);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.equal(result.headers.get('X-Content-Type-Options'), 'nosniff');
    for (const header of ['Set-Cookie', 'Location', 'Authorization', 'X-Provider-Key', 'X-Domino-CSRF', 'Access-Control-Allow-Origin']) {
      assert.equal(result.headers.get(header), null, header);
    }
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].url, `${env.CROSSCHAIN_GATEWAY_ORIGIN}/internal/crosschain/v1/${route}`, 'the gateway, never a provider');
    assert.equal(h.calls[0].init.method, 'POST');
    assert.equal(h.calls[0].init.redirect, 'manual');
    assert.equal(h.calls[0].init.body, body, 'the browser\'s bytes, as they came');
    assert.deepEqual(h.calls[0].init.headers, { 'Content-Type': 'application/json', [HEADER]: CONTRACT_VERSION,
      'CF-Access-Client-Id': env.CROSSCHAIN_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.CROSSCHAIN_ACCESS_CLIENT_SECRET,
      'X-Domino-Client-Id': '203.0.113.7', 'X-Domino-Browser-Origin': origin,
      'X-Domino-Session': session, 'X-Domino-CSRF': csrf });
  }
});

test('the answer is about this browser\'s request: one for another request is refused after its one upstream call', async (t) => {
  during(t);
  for (const [route, label, mutate] of [
    ['origins', 'another destination token', (body) => { body.destinationToken = WETH_RH; }],
    ['origins', 'another destination chain', (body) => { body.destinationChainId = 8453; body.destinationToken = USDC_BASE; }],
    ['quote', 'another amount', (body) => { body.amountRaw = '999'; }],
    ['quote', 'another origin chain', (body) => { body.originChainId = 8453; }],
    ['quote', 'another origin token', (body) => { body.originToken = OTHER; }],
    ['quote', 'another destination token', (body) => { body.destinationToken = WETH_RH; }],
    ['quote', 'another slippage', (body) => { body.slippageBps = 100; }],
    ['quote', 'destination gas asked', (body) => { body.destinationGas = true; }],
    ['quote', 'asked by output', (body) => { body.amountKind = 'output'; body.maxInputRaw = body.amountRaw; }],
    ['status', 'another deposit', (body) => { body.depositTxHash = '0x' + 'e'.repeat(64); }],
    ['status', 'another origin chain', (body) => { body.originChainId = 8453; }],
    ['status', 'another previous state', (body) => { body.previousState = null; }],
  ]) {
    const body = structuredClone(REQUESTS[route]);
    mutate(body);
    assert.equal(validateRequest(route, body), true, label);
    const h = harness();
    await error(await h.worker.fetch(request({ route, body: JSON.stringify(body) }), env), 'upstream_contract_mismatch', `${route}: ${label}`);
    assert.equal(h.calls.length, 1, label);
  }
  // A quote by output (1.1.0-rc.1) is about its cap too: the same answer for another cap, or asked by exact input, is not it.
  const byOutput = ANSWERS.find(([name]) => name.endsWith('quote.output.json'))[2];
  t.mock.restoreAll();
  during(t, 'quote', byOutput);
  const asked = sentFor('quote', byOutput);
  assert.equal((await harness(() => response(byOutput)).worker.fetch(request({ body: JSON.stringify(asked) }), env)).status, 200);
  for (const changed of [{ ...asked, maxInputRaw: '150000001' }, { ...asked, amountKind: 'exact_input', maxInputRaw: null }]) {
    assert.equal(validateRequest('quote', changed), true);
    await error(await harness(() => response(byOutput)).worker.fetch(request({ body: JSON.stringify(changed) }), env), 'upstream_contract_mismatch');
  }
  t.mock.restoreAll();
  during(t);
  // Relay's answer is a request about Relay: the same report for Across's request is not it.
  const relay = ANSWERS.find(([name]) => name.endsWith('status.relay-filled.json'))[2];
  const sent = sentFor('status', relay);
  await error(await harness(() => response(STATUS)).worker.fetch(request({ route: 'status', body: JSON.stringify(sent) }), env), 'upstream_contract_mismatch');
});

test('an address or hash in another case names the same one: what the listener echoes in lowercase is still this request', async (t) => {
  during(t);
  const upper = (value) => value.toUpperCase().replace('0X', '0x');
  const quote = { ...REQUESTS.quote, originToken: upper(REQUESTS.quote.originToken), destinationToken: upper(REQUESTS.quote.destinationToken) };
  assert.equal(validateRequest('quote', quote), true);
  assert.equal((await harness().worker.fetch(request({ body: JSON.stringify(quote) }), env)).status, 200, 'the quote');
  const status = { ...REQUESTS.status, depositTxHash: upper(REQUESTS.status.depositTxHash) };
  assert.equal(validateRequest('status', status), true);
  assert.equal((await harness().worker.fetch(request({ route: 'status', body: JSON.stringify(status) }), env)).status, 200, 'the status report');
  const origins = { ...REQUESTS.origins, destinationToken: upper(REQUESTS.origins.destinationToken) };
  assert.equal(validateRequest('origins', origins), true);
  assert.equal((await harness().worker.fetch(request({ route: 'origins', body: JSON.stringify(origins) }), env)).status, 200, 'the listing');
  // Relay's request id is an opaque string: its case is part of it.
  const relay = ANSWERS.find(([name]) => name.endsWith('status.relay-awaiting.json'))[2];
  const sent = { ...sentFor('status', relay), requestId: upper(relay.status.request.requestId) };
  await error(await harness(() => response(relay)).worker.fetch(request({ route: 'status', body: JSON.stringify(sent) }), env), 'upstream_contract_mismatch');
});

test('an answer the package refuses never reaches the browser: a misdirected step, a rewritten decision, a report that went backwards', async (t) => {
  during(t);
  for (const [route, label, mutate] of [
    ['quote', 'the deposit\'s target', (q) => { q.steps[1].transaction.to = OTHER; }],
    ['quote', 'the approval\'s spender', (q) => { q.steps[0].approval.spender = OTHER; }],
    ['quote', 'the approval\'s amount', (q) => { q.steps[0].approval.amountRaw = String(BigInt(q.steps[0].approval.amountRaw) * 2n); }],
    ['quote', 'the approval\'s calldata', (q) => { q.steps[0].transaction.data = q.steps[0].transaction.data.slice(0, -2) + 'ff'; }],
    ['quote', 'a step on another chain', (q) => { q.steps[1].transaction.chainId = 8453; }],
    ['quote', 'the refund\'s recipient', (q) => { q.candidates[0].refund.recipient = OTHER; }],
    ['quote', 'the fee to the owner', (q) => { q.feeRecipient = q.request.owner; }],
    ['quote', 'the steps\' order', (q) => { q.steps.reverse(); }],
    ['quote', 'the decision', (q) => { q.decision = q.decision === 'relay' ? 'across' : 'relay'; }],
    ['quote', 'the advantage', (q) => { q.comparison.advantageRaw = '1'; }],
    ['quote', 'the candidates\' order', (q) => { q.candidates.reverse(); }],
    ['quote', 'the reason', (q) => { q.reason = 'only_quote'; }],
    ['quote', 'the quote lifetime', (q) => { q.expiresAt += 60; }],
    ['quote', 'the echo\'s owner', (q) => { q.request.owner = '0x' + '3'.repeat(40); }],
    ['status', 'a state that went backwards', (s) => { s.request.previousState = 'refunded'; }],
    ['status', 'a terminal state said otherwise', (s) => { s.terminal = false; }],
    ['status', 'a held report', (s) => { s.state = 'pending'; s.transition = 'held'; }],
    ['status', 'a fee measured at nothing', (s) => { s.fee.amountRaw = '0'; }],
    ['status', 'another poll interval', (s) => { s.nextCheckSeconds = 10; }],
    ['origins', 'the providers\' order', (o) => { o.providers.reverse(); }],
    ['origins', 'a chain by another name', (o) => { o.chains[0].name = 'Elsewhere'; }],
    ['origins', 'the destination among the origins', (o) => { o.chains.push({ chainId: 4663, name: 'Robinhood Chain', tokens: [] }); }],
  ]) {
    const answer = structuredClone(RESPONSES[route]);
    mutate(answer[route]);
    assert.equal(validateResponse(route, answer), false, label);
    const h = harness(() => response(answer));
    await error(await h.worker.fetch(request({ route }), env), 'upstream_contract_mismatch');
    assert.equal(h.calls.length, 1, label);
  }
  // Note: the owner the listener echoes passes this Worker (it has no account to compare with); the app compares it.
  await error(await harness(() => response({ ...QUOTE, contractVersion: '1.0.0-rc.2' })).worker.fetch(request(), env), 'upstream_contract_mismatch');
});

test('a quote past its two minutes is preview_expired, never repaired; one from the future is refused; a listing and a report do not expire', async (t) => {
  during(t, 'quote', QUOTE, QUOTE.quote.expiresAt - QUOTE.quote.requestedAt);
  await error(await harness().worker.fetch(request(), env), 'preview_expired');
  t.mock.restoreAll();
  during(t, 'quote', QUOTE, -10);
  await error(await harness().worker.fetch(request(), env), 'upstream_contract_mismatch');
  t.mock.restoreAll();
  during(t, 'quote', QUOTE, -5);
  assert.equal((await harness().worker.fetch(request(), env)).status, 200, 'five seconds of clock difference are tolerated');
  t.mock.restoreAll();
  // A listing served stale for an hour (XC README: cached 10 min, served stale up to 1 h) and a report read an hour ago.
  during(t, 'origins', ORIGINS, 3600);
  assert.equal((await harness().worker.fetch(request({ route: 'origins' }), env)).status, 200, 'a listing');
  t.mock.restoreAll();
  during(t, 'status', STATUS, 3600);
  assert.equal((await harness().worker.fetch(request({ route: 'status' }), env)).status, 200, 'a report');
  t.mock.restoreAll();
  during(t, 'status', STATUS, -10);
  await error(await harness().worker.fetch(request({ route: 'status' }), env), 'upstream_contract_mismatch');
});

test('the session, CSRF and browser checks refuse before any upstream call', async () => {
  const h = harness();
  const noCookie = request(); noCookie.headers.delete('Cookie');
  await error(await h.worker.fetch(noCookie, env), 'session_required');
  await error(await h.worker.fetch(request({ headers: { Cookie: `__Host-domino-preauth=${session}` } }), env), 'session_required');
  for (const cookie of [`__Host-domino-session=${session}; __Host-domino-session=${session}`, '__Host-domino-session=',
    `__Host-domino-session="${session}"`, `unrelated=${'x'.repeat(8193)}`]) {
    await error(await h.worker.fetch(request({ headers: { Cookie: cookie } }), env), 'invalid_request');
  }
  const noCsrf = request(); noCsrf.headers.delete('X-Domino-CSRF');
  await error(await h.worker.fetch(noCsrf, env), 'csrf_invalid');
  for (const value of ['', `${csrf}, ${csrf}`, 'x'.repeat(42), `"${csrf}"`]) {
    await error(await h.worker.fetch(request({ headers: { 'X-Domino-CSRF': value } }), env), 'csrf_invalid');
  }
  for (const headers of [{ Origin: 'null' }, { Origin: 'https://other.example.invalid' }, { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Mode': 'navigate' }, { 'Sec-Fetch-Dest': 'iframe' }, { 'Sec-Fetch-User': '?1' },
    { Host: 'other.example.invalid' }]) {
    await error(await h.worker.fetch(request({ headers }), env), 'origin_not_allowed');
  }
  const noOrigin = request(); noOrigin.headers.delete('Origin');
  await error(await h.worker.fetch(noOrigin, env), 'origin_not_allowed');
  for (const ip of [null, '', 'example.invalid', '192.0.2.1, 192.0.2.2']) {
    const untrusted = harness(undefined, ip);
    await error(await untrusted.worker.fetch(request({ headers: { 'X-Domino-Client-Id': '192.0.2.1' } }), env), 'upstream_unavailable');
    assert.equal(untrusted.calls.length, 0);
  }
  assert.equal(h.calls.length, 0);
});

test('only the three POST paths dispatch, and a request is the package\'s exactly: no owner, recipient, refund or fee field', async () => {
  const h = harness();
  for (const path of ['/api/crosschain/v1/quote/', '/api/crosschain/v1/%71uote', '/api/crosschain/v1/quote?owner=evil',
    '/api/crosschain/v1/quote#other', '/api/crosschain/v1/execute', '/api/crosschain/v1/deposit', '/api/crosschain/v1/',
    '/api/crosschain/v2/quote', '/internal/crosschain/v1/quote', '/api/onboarding/v1/swap-route', '/api/position-plan/v1/plan']) {
    await error(await h.worker.fetch(request({ url: origin + path }), env), 'route_not_available');
  }
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    await error(await h.worker.fetch(request({ method }), env), 'method_not_allowed');
  }
  for (const extra of ['owner', 'recipient', 'refundTo', 'feeRecipient', 'appFeeBps', 'integratorId', 'apiKey', 'rpcUrl']) {
    await error(await h.worker.fetch(request({ body: JSON.stringify({ ...REQUESTS.quote, [extra]: '0x' + 'a'.repeat(40) }) }), env), 'invalid_request');
    await error(await h.worker.fetch(request({ route: 'status', body: JSON.stringify({ ...REQUESTS.status, [extra]: '0x' + 'a'.repeat(40) }) }), env), 'invalid_request');
  }
  const text = JSON.stringify(REQUESTS.quote);
  for (const body of [text.replace('"originChainId":42161', '"originChainId":42161.0'), text.replace('"originChainId":42161', '"originChainId":4.2161e4'),
    text.replace('"slippageBps":50', '"slippageBps":5e1'), text.replace('"slippageBps":50', '"slippageBps":5'),
    text.replace('"originChainId":42161', '"originChainId":"42161"'), text.replace('"originChainId":42161', '"originChainId":4663'),
    text.replace('"amountRaw":"100000000"', '"amountRaw":100000000'), text.replace('"amountRaw":"100000000"', '"amountRaw":"0"'),
    text.replace('"destinationGas":false', '"destinationGas":"false"'), text.replace(`"destinationToken":"${REQUESTS.quote.destinationToken}"`, `"destinationToken":"${OTHER}"`),
    JSON.stringify({ ...REQUESTS.status, requestId: '0x' + '1'.repeat(64) }),
    '[]', 'null', '{"originChainId":42161,"originChainId":42161}', '{"__proto__":{}}', '﻿{}', '{']) {
    await error(await h.worker.fetch(request({ body }), env), 'invalid_request');
  }
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json;charset=latin1' }, { 'Content-Encoding': 'gzip' }]) {
    await error(await h.worker.fetch(request({ headers }), env), 'json_required');
  }
  for (const headers of [{}, { 'Content-Length': '2' }]) {
    await error(await h.worker.fetch(request({ body: ' '.repeat(CROSSCHAIN_LIMITS.requestBytes + 1), headers }), env), 'request_too_large');
  }
  // 1.0.0-rc.1 too: the listener's switch window is the listener's; this Worker speaks the package's one version.
  for (const version of ['1.0.0-rc.1', '1.0.0-rc.2', '1.0.0', `${CONTRACT_VERSION}, ${CONTRACT_VERSION}`]) {
    await error(await h.worker.fetch(request({ headers: { [HEADER]: version } }), env), 'upstream_contract_mismatch');
  }
  assert.equal(h.calls.length, 0);
});

for (const [code, status] of Object.entries(ERROR_STATUS_BY_CODE)) test(`the listener's refusal ${code} passes with its own status, and nothing else of it`, async () => {
  assert.equal(validateError(status, { error: code }), true);
  const h = harness(() => response({ error: code }, status, { 'Set-Cookie': 'secret=1', 'X-Secret': 'secret', 'Retry-After': '5' }));
  const result = await h.worker.fetch(request(), env);
  assert.equal(result.headers.get('Retry-After'), status === 429 ? '60' : null);
  await error(result, code);
  assert.equal(result.headers.get('X-Secret'), null);
});

test('what is not the listener\'s answer is unavailable, a foreign version a mismatch, broken bytes invalid', async (t) => {
  during(t);
  for (const output of [new Response('access denied', { status: 403 }), response('', 302, { Location: 'https://evil.invalid' }),
    response('<html>login</html>', 200, { 'Content-Type': 'text/html' }), response({ error: 'secret-provider-key' }, 503),
    response({ error: 'session_required', detail: 'secret' }, 401), response({ error: 'position_plan_not_owner' }, 404),
    response({ error: 'onboarding_capacity_busy' }, 503)]) {
    await error(await harness(() => output).worker.fetch(request(), env), 'upstream_unavailable');
  }
  for (const version of ['2.0.0', '1.0.0-rc.1', '1.0.0-rc.2', `${CONTRACT_VERSION}, ${CONTRACT_VERSION}`]) {
    await error(await harness(() => response(QUOTE, 200, { [HEADER]: version })).worker.fetch(request(), env), 'upstream_contract_mismatch');
  }
  const text = JSON.stringify(QUOTE);
  for (const output of [response(QUOTE, 200, { 'Content-Encoding': 'gzip' }), response('{"quote":{},"quote":{}}'),
    response(text.replace('"schemaVersion":1', '"schemaVersion":1.0')), response(text.replace('"appFeeBps":35', '"appFeeBps":35.0')),
    response('x'.repeat(CROSSCHAIN_LIMITS.responseBytes + 1)),
    response(QUOTE, 200, { 'Content-Length': String(CROSSCHAIN_LIMITS.responseBytes + 1) }),
    new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'Content-Type': 'application/json', [HEADER]: CONTRACT_VERSION } })]) {
    await error(await harness(() => output).worker.fetch(request(), env), 'upstream_invalid_response');
  }
  // The listener's answer for another route is not this route's, and a refusal is never a 200.
  await error(await harness(() => response(STATUS)).worker.fetch(request(), env), 'upstream_contract_mismatch');
  await error(await harness(() => response({ error: 'crosschain_deposit_not_found' }, 200)).worker.fetch(request(), env), 'upstream_contract_mismatch');
});

test('a session or CSRF value can never come back inside an answer', async (t) => {
  during(t);
  // 43 characters of the quote's own request fingerprint, a valid credential shape: as the session, then as the CSRF token.
  const echoed = QUOTE.quote.requestFingerprint.slice(0, 43);
  assert.match(echoed, /^[A-Za-z0-9_-]{43}$/);
  for (const headers of [{ Cookie: `__Host-domino-session=${echoed}` }, { 'X-Domino-CSRF': echoed }]) {
    await error(await harness().worker.fetch(request({ headers }), env), 'upstream_contract_mismatch');
  }
  for (const name of ['CROSSCHAIN_ACCESS_CLIENT_ID', 'CROSSCHAIN_ACCESS_CLIENT_SECRET']) {
    await error(await harness().worker.fetch(request(), { ...env, [name]: echoed }), 'upstream_contract_mismatch');
  }
});

test('an upload stalled past five seconds never dispatches', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const h = harness();
  const pending = h.worker.fetch(request({ body }), env);
  t.mock.timers.tick(CROSSCHAIN_LIMITS.bodyMs + 1);
  await error(await pending, 'request_timeout');
  assert.equal(cancelled, true);
  assert.equal(h.calls.length, 0);
});

test('the listener has its 20 s and the whole request 25 s, under the page\'s 27 s; late work is cancelled', async (t) => {
  assert.equal(CROSSCHAIN_LIMITS.upstreamMs, 20_000);
  assert.equal(CROSSCHAIN_LIMITS.totalMs, 25_000);
  assert.ok(CROSSCHAIN_LIMITS.totalMs < 27_000, 'app/src/v2/crosschain/transport.ts CROSSCHAIN_TIMEOUT_MS');
  assert.equal(CROSSCHAIN_LIMITS.requestBytes, 4096, 'crosschain_models.MAX_BODY');
  assert.equal(CROSSCHAIN_LIMITS.responseBytes, 256 * 1024, 'crosschain_models.MAX_RESPONSE');
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let resolve, cancelled = false;
  const h = harness(() => new Promise((done) => { resolve = done; }));
  const pending = h.worker.fetch(request(), env);
  await flush();
  assert.equal(h.calls.length, 1);
  t.mock.timers.tick(CROSSCHAIN_LIMITS.upstreamMs + 1);
  await error(await pending, 'upstream_timeout');
  assert.equal(h.calls[0].init.signal.aborted, true);
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await flush();
  assert.equal(cancelled, true);
});

test('a browser that goes away stops a transport ignoring cancellation, without a retry', async () => {
  const controller = new AbortController();
  const h = harness(() => { controller.abort(); return new Promise(() => {}); });
  await error(await h.worker.fetch(request({ signal: controller.signal }), env), 'request_timeout');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].init.signal.aborted, true);
});

test('capabilities: a local GET with no session that says whether the routes are on, and nothing more', async () => {
  const h = harness();
  const on = await h.worker.fetch(capabilitiesRequest(), env);
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), { contractVersion: CONTRACT_VERSION, dataMode: 'live', enabledRoutes: ['origins', 'quote', 'status'] });
  for (const [name, value] of [['Content-Type', 'application/json; charset=utf-8'], ['Cache-Control', 'no-store'],
    ['X-Content-Type-Options', 'nosniff'], [HEADER, CONTRACT_VERSION], ['Set-Cookie', null], ['Access-Control-Allow-Origin', null]]) {
    assert.equal(on.headers.get(name), value, name);
  }
  // The browser's own Origin, or none; never another, never a navigation.
  assert.equal((await h.worker.fetch(capabilitiesRequest({ Origin: origin }), env)).status, 200);
  for (const headers of [{ Origin: 'https://other.example.invalid' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Mode': 'navigate' }, { 'Sec-Fetch-User': '?1' }]) {
    await error(await h.worker.fetch(capabilitiesRequest(headers), env), 'origin_not_allowed');
  }
  await error(await h.worker.fetch(capabilitiesRequest({}, 'POST'), env), 'method_not_allowed');
  await error(await h.worker.fetch(new Request(`${origin}/api/crosschain/v1/capabilities?x=1`), env), 'route_not_available');
  await error(await h.worker.fetch(capabilitiesRequest({ [HEADER]: '1.0.0-rc.2' }), env), 'upstream_contract_mismatch');
  await error(await h.worker.fetch(capabilitiesRequest({ [HEADER]: '1.0.0-rc.1' }), env), 'upstream_contract_mismatch');
  assert.equal((await h.worker.fetch(capabilitiesRequest({ [HEADER]: CONTRACT_VERSION }), env)).status, 200);
  assert.equal(h.calls.length, 0, 'never upstream');
});

test('capabilities and the three routes agree on every configuration', async (t) => {
  // The three fixtures were answered in the same second, so one clock serves them all.
  assert.equal(anchor('origins', ORIGINS), anchor('quote', QUOTE));
  assert.equal(anchor('status', STATUS), anchor('quote', QUOTE));
  during(t);
  for (const settings of [{ ...env }, { ...env, CROSSCHAIN_BRIDGE_ENABLED: 'false' }, { APP_ORIGIN: origin },
    { ...env, CROSSCHAIN_ACCESS_CLIENT_SECRET: '' }, { ...env, CROSSCHAIN_GATEWAY_ORIGIN: origin }, { ...env, APP_ORIGIN: 'nope' }]) {
    const capability = await harness().worker.fetch(capabilitiesRequest(), settings);
    const said = capability.status === 200 ? (await capability.json()).dataMode : (await capability.json()).error;
    for (const route of ROUTES) {
      const answered = await harness().worker.fetch(request({ route }), settings);
      const did = answered.status === 200 ? 'live' : (await answered.json()).error;
      assert.equal(said === 'disabled' ? 'route_not_available' : said, did, `${route} ${JSON.stringify(settings)}`);
    }
  }
});
