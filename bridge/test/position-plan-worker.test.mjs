// position-plan-v1 through the authenticated bridge (spec F7 §2.4; the bridge side of #308, 2026-10-02): the session
// boundary of onboarding's and deposit's transport, every plan held to the package's runtime (checkPlan included) and
// to the request this browser sent, off until its own flag says otherwise, and a capabilities GET of its own.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { createPositionPlanWorker, POSITION_PLAN_LIMITS } from '../src/position-plan-worker.mjs';
import { CONTRACT_VERSION, ROUTES, ERROR_STATUS_BY_CODE, validateRequest, validateResponse, validateError } from '../../api-contracts/position-plan-v1/runtime.mjs';

const origin = 'https://app.example.invalid';
const session = 's'.repeat(43), csrf = 'c'.repeat(43);
const HEADER = 'X-Domino-Position-Plan-Contract';
const env = { APP_ORIGIN: origin, POSITION_PLAN_BRIDGE_ENABLED: 'true',
  POSITION_PLAN_GATEWAY_ORIGIN: 'https://position-plan.example.invalid',
  POSITION_PLAN_ACCESS_CLIENT_ID: 'synthetic-plan-id', POSITION_PLAN_ACCESS_CLIENT_SECRET: 'synthetic-plan-secret' };
const fixtures = new URL('../../api-contracts/position-plan-v1/fixtures/', import.meta.url);
const json = (path) => JSON.parse(readFileSync(new URL(path, fixtures), 'utf8'));
const PLANS = [['responses/plan.json', json('responses/plan.json')],
  ...readdirSync(new URL('variants/', fixtures)).sort().map((name) => [`variants/${name}`, json(`variants/${name}`)])];
const ANSWER = json('responses/plan.json');
const REQUEST = json('requests/plan.json');

/** What a browser sends for a plan: its echo without the owner and without the fields left out (null), as the app writes it. */
function sentFor(answer) {
  const { owner: _owner, ...echo } = answer.plan.request;
  const sent = Object.fromEntries(Object.entries(echo).filter(([, value]) => value !== null));
  if (sent.receive && sent.receive.token === null) sent.receive = { mode: sent.receive.mode };
  return sent;
}

/** Date.now() inside the plan's own minute: ten seconds after the listener asked the chain. */
function during(t, answer = ANSWER, offset = 10) {
  const now = (answer.plan.requestedAt + offset) * 1000;
  t.mock.method(Date, 'now', () => now);
}

function request(options = {}) {
  const { method = 'POST', body = JSON.stringify(REQUEST), headers = {},
    url = `${origin}/api/position-plan/v1/plan`, ...rest } = options;
  return new Request(url, { method, headers: { Origin: origin, 'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
    Cookie: `__Host-domino-session=${session}`, 'X-Domino-CSRF': csrf, ...headers },
    ...(['GET', 'HEAD'].includes(method) ? {} : { body, duplex: 'half' }), ...rest });
}
function capabilitiesRequest(headers = {}, method = 'GET') {
  return new Request(`${origin}/api/position-plan/v1/capabilities`, { method,
    headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', ...headers },
    ...(method === 'GET' || method === 'HEAD' ? {} : { body: '{}', duplex: 'half' }) });
}
function response(value = ANSWER, status = 200, headers = {}) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status,
    headers: { 'Content-Type': 'application/json', [HEADER]: CONTRACT_VERSION, ...headers } });
}
function harness(responder = () => response(), ip = '203.0.113.7') {
  const calls = [];
  return { calls, worker: createPositionPlanWorker({ getClientIp: () => ip,
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

/** The [vars] of the reviewed bridge/wrangler.position-plan.toml, as committed. */
function committed() {
  const toml = readFileSync(new URL('../wrangler.position-plan.toml', import.meta.url), 'utf8');
  const section = toml.slice(toml.indexOf('[vars]\n') + '[vars]\n'.length).split(/\n\[/)[0];
  return { toml, vars: Object.fromEntries(section.split('\n').filter((line) => /^[A-Z0-9_]+ = "/.test(line))
    .map((line) => { const [, name, value] = line.match(/^([A-Z0-9_]+) = "(.*)"$/); return [name, value]; })) };
}

test('the committed config keeps the plan route off, logs nothing and names its own gateway', async () => {
  const { toml, vars } = committed();
  assert.deepEqual(vars, { POSITION_PLAN_BRIDGE_ENABLED: 'false', APP_ORIGIN: 'https://domino.money',
    POSITION_PLAN_GATEWAY_ORIGIN: 'https://vm-position-plan.domino.money' });
  assert.match(toml, /^name = "domino-position-plan-bridge"$/m);
  assert.match(toml, /^main = "src\/position-plan-worker\.mjs"$/m);
  assert.match(toml, /^\[observability\]\nenabled = false$/m);
  const h = harness();
  await error(await h.worker.fetch(request(), { ...vars, APP_ORIGIN: origin }), 'route_not_available');
  const capabilities = await h.worker.fetch(capabilitiesRequest(), { ...vars, APP_ORIGIN: origin });
  assert.deepEqual(await capabilities.json(), { contractVersion: CONTRACT_VERSION, dataMode: 'disabled', enabledRoutes: [] });
  assert.equal(h.calls.length, 0);
});

test('the route defaults off and cannot inherit another family\'s activation', async () => {
  const h = harness();
  for (const settings of [{ APP_ORIGIN: origin }, { APP_ORIGIN: origin, POSITION_PLAN_BRIDGE_ENABLED: true },
    { APP_ORIGIN: origin, POSITION_PLAN_BRIDGE_ENABLED: 'TRUE' }, { APP_ORIGIN: origin, POSITION_PLAN_BRIDGE_ENABLED: ' true' },
    { APP_ORIGIN: origin, ONBOARDING_BRIDGE_ENABLED: 'true', SESSION_BRIDGE_ENABLED: 'true', READ_BRIDGE_ENABLED: 'true',
      ONBOARDING_GATEWAY_ORIGIN: 'https://onboarding.example.invalid', ONBOARDING_ACCESS_CLIENT_ID: 'x', ONBOARDING_ACCESS_CLIENT_SECRET: 'y' }]) {
    await error(await h.worker.fetch(request(), settings), 'route_not_available');
    const capabilities = await h.worker.fetch(capabilitiesRequest(), settings);
    assert.equal((await capabilities.json()).dataMode, 'disabled');
  }
  assert.equal(h.calls.length, 0);
});

for (const settings of [
  { APP_ORIGIN: 'http://app.example.invalid' }, { APP_ORIGIN: `${origin}/` },
  { POSITION_PLAN_GATEWAY_ORIGIN: origin }, { POSITION_PLAN_GATEWAY_ORIGIN: 'http://position-plan.example.invalid' },
  { POSITION_PLAN_GATEWAY_ORIGIN: `${env.POSITION_PLAN_GATEWAY_ORIGIN}/internal` },
  { POSITION_PLAN_ACCESS_CLIENT_ID: '' }, { POSITION_PLAN_ACCESS_CLIENT_SECRET: 'bad\nsecret' },
  { POSITION_PLAN_ACCESS_CLIENT_SECRET: undefined, ONBOARDING_ACCESS_CLIENT_SECRET: 'onboarding-secret' },
  { POSITION_PLAN_ACCESS_CLIENT_ID: undefined, ACCESS_CLIENT_ID: 'reader-id' },
  { POSITION_PLAN_GATEWAY_ORIGIN: undefined, GATEWAY_ORIGIN: 'https://vm-read.example.invalid' },
]) test(`an incomplete configuration answers upstream_unavailable, capabilities included: ${JSON.stringify(settings)}`, async () => {
  const h = harness();
  await error(await h.worker.fetch(request(), { ...env, ...settings }), 'upstream_unavailable');
  await error(await h.worker.fetch(capabilitiesRequest(), { ...env, ...settings }), 'upstream_unavailable');
  assert.equal(h.calls.length, 0);
});

test('every plan the producer serves passes through exactly, with only the fixed authentication headers upstream', async (t) => {
  assert.deepEqual([...ROUTES], ['plan']);
  assert.equal(PLANS.length, 9);
  for (const [name, answer] of PLANS) {
    t.mock.restoreAll();
    during(t, answer);
    const sent = sentFor(answer);
    assert.equal(validateRequest('plan', sent), true, `${name}: the app could send it`);
    const body = JSON.stringify(sent);
    const h = harness(() => response(answer, 200, { 'Set-Cookie': 'evil=secret', Location: 'https://evil.invalid',
      Authorization: 'secret', 'X-Provider-Key': 'secret', 'X-Domino-CSRF': 'secret' }));
    const result = await h.worker.fetch(request({ body, headers: {
      Cookie: `unrelated=secret; __Host-domino-preauth=${'p'.repeat(43)}; __Host-domino-session=${session}`,
      'X-Domino-Session': 'forged-session', 'X-Domino-Client-Id': 'forged-ip', 'X-Domino-Browser-Origin': 'https://evil.invalid',
      'CF-Access-Jwt-Assertion': 'forged-assertion', 'CF-Access-Client-Id': 'forged-id', 'CF-Access-Client-Secret': 'forged-secret',
      Authorization: 'forged-bearer', 'X-Forwarded-For': '192.0.2.1',
    } }), env);
    assert.equal(result.status, 200, name);
    assert.deepEqual(await result.json(), answer, name);
    assert.equal(validateResponse('plan', answer), true);
    assert.equal(result.headers.get(HEADER), CONTRACT_VERSION);
    assert.equal(result.headers.get('Cache-Control'), 'no-store');
    assert.equal(result.headers.get('X-Content-Type-Options'), 'nosniff');
    for (const header of ['Set-Cookie', 'Location', 'Authorization', 'X-Provider-Key', 'X-Domino-CSRF', 'Access-Control-Allow-Origin']) {
      assert.equal(result.headers.get(header), null, header);
    }
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].url, `${env.POSITION_PLAN_GATEWAY_ORIGIN}/internal/position-plan/v1/plan`);
    assert.equal(h.calls[0].init.method, 'POST');
    assert.equal(h.calls[0].init.redirect, 'manual');
    assert.equal(h.calls[0].init.body, body, 'the browser\'s bytes, as they came');
    assert.deepEqual(h.calls[0].init.headers, { 'Content-Type': 'application/json', [HEADER]: CONTRACT_VERSION,
      'CF-Access-Client-Id': env.POSITION_PLAN_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.POSITION_PLAN_ACCESS_CLIENT_SECRET,
      'X-Domino-Client-Id': '203.0.113.7', 'X-Domino-Browser-Origin': origin,
      'X-Domino-Session': session, 'X-Domino-CSRF': csrf });
  }
});

test('the plan answers this browser\'s request: a plan for another one is refused after its one upstream call', async (t) => {
  during(t);
  const other = '0x' + '9'.repeat(40);
  for (const [label, mutate] of [
    ['another range', (body) => { body.tickLower = -600; }],
    ['another amount', (body) => { body.inputs[0].amountRaw = '999'; }],
    ['another pool tier', (body) => { body.pool.fee = 500; }],
    ['another pool', (body) => { body.pool.currency1 = other; }],
    ['another consent', (body) => { body.consent = 'direct'; }],
    ['another chain', (body) => { body.chainId = 42161; }],
    ['another slippage', (body) => { body.slippageBps = 100; }],
    ['another input token', (body) => { body.inputs[0].token = body.pool.currency1; }],
    ['a second input', (body) => { body.inputs.push({ token: body.pool.currency1, amountRaw: '1' }); }],
    ['a starting price', (body) => { body.initialPrice = { price: '1', baseToken: body.pool.currency0, decimals0: 18, decimals1: 18 }; }],
  ]) {
    const body = structuredClone(REQUEST);
    mutate(body);
    assert.equal(validateRequest('plan', body), true, label);
    const h = harness();
    await error(await h.worker.fetch(request({ body: JSON.stringify(body) }), env), 'upstream_contract_mismatch');
    assert.equal(h.calls.length, 1, label);
  }
  // The exit's `receive` and `burn` (the package's own request match does not cover `receive`).
  const exit = PLANS.find(([name]) => name.endsWith('exit-converted-direct.json'))[1];
  t.mock.restoreAll();
  during(t, exit);
  for (const [label, mutate] of [
    ['both instead of converted', (body) => { body.receive = { mode: 'both' }; }],
    ['converted to the other token', (body) => { body.receive = { mode: 'converted', token: other }; }],
    ['no burn', (body) => { body.burn = false; }],
    ['part of the liquidity', (body) => { body.liquidityToRemove = '1'; }],
    ['another position', (body) => { body.position.tokenId = '8'; }],
  ]) {
    const body = sentFor(exit);
    mutate(body);
    assert.equal(validateRequest('plan', body), true, label);
    await error(await harness(() => response(exit)).worker.fetch(request({ body: JSON.stringify(body) }), env), 'upstream_contract_mismatch');
  }
});

test('what the listener fills in is still this request: the default slippage, a field sent as null, an address in another case', async (t) => {
  during(t);
  const { slippageBps: _s, ...withoutSlippage } = REQUEST;
  assert.equal((await harness().worker.fetch(request({ body: JSON.stringify(withoutSlippage) }), env)).status, 200, 'slippage 50 by default');
  const explicitNulls = { ...REQUEST, position: null, burn: null, receive: null, initialPrice: null, liquidityToRemove: null };
  assert.equal(validateRequest('plan', explicitNulls), true);
  assert.equal((await harness().worker.fetch(request({ body: JSON.stringify(explicitNulls) }), env)).status, 200, 'explicit nulls');
  const upper = structuredClone(REQUEST);
  upper.pool.currency0 = upper.pool.currency0.toUpperCase().replace('0X', '0x');
  upper.inputs[0].token = upper.inputs[0].token.toUpperCase().replace('0X', '0x');
  assert.equal(validateRequest('plan', upper), true);
  assert.equal((await harness().worker.fetch(request({ body: JSON.stringify(upper) }), env)).status, 200, 'an address\'s case names the same address');
  const relayed = PLANS.find(([name]) => name.endsWith('exit-relayed.json'))[1];
  t.mock.restoreAll();
  during(t, relayed);
  const both = { ...sentFor(relayed), receive: { mode: 'both', token: null } };
  assert.equal((await harness(() => response(relayed)).worker.fetch(request({ body: JSON.stringify(both) }), env)).status, 200, 'receive.token null, sent or not');
});

test('a plan the package refuses never reaches the browser', async (t) => {
  during(t);
  for (const [label, mutate] of [
    ['the fee', (plan) => { plan.fee.amountRaw = String(BigInt(plan.fee.amountRaw) + 1n); }],
    ['the routes hash', (plan) => { plan.routesHash = '0x' + '1'.repeat(64); }],
    ['the zap', (plan) => { plan.zap = '0x' + '2'.repeat(40); }],
    ['a leg minimum', (plan) => { plan.legs[0].minAmountOutRaw = '0'; }],
    ['the deadline', (plan) => { plan.deadline = String(Number(plan.deadline) + 1); }],
    ['the quote lifetime', (plan) => { plan.expiresAt += 60; }],
    ['the echo\'s owner', (plan) => { plan.request.owner = '0x' + '3'.repeat(40); }],
    ['an executable extra', (plan) => { plan.executionAvailable = true; }],
  ]) {
    const answer = structuredClone(ANSWER);
    mutate(answer.plan);
    assert.equal(validateResponse('plan', answer), false, label);
    const h = harness(() => response(answer));
    await error(await h.worker.fetch(request(), env), 'upstream_contract_mismatch');
    assert.equal(h.calls.length, 1);
  }
  await error(await harness(() => response({ ...ANSWER, contractVersion: '1.0.0-rc.1' })).worker.fetch(request(), env), 'upstream_contract_mismatch');
});

test('a plan past its minute is preview_expired, never repaired; one from the future is refused', async (t) => {
  during(t, ANSWER, ANSWER.plan.expiresAt - ANSWER.plan.requestedAt);
  await error(await harness().worker.fetch(request(), env), 'preview_expired');
  t.mock.restoreAll();
  during(t, ANSWER, -10);
  await error(await harness().worker.fetch(request(), env), 'upstream_contract_mismatch');
  t.mock.restoreAll();
  during(t, ANSWER, -5);
  assert.equal((await harness().worker.fetch(request(), env)).status, 200, 'five seconds of clock difference are tolerated');
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

test('only the one POST path dispatches, and a request is the package\'s exactly', async () => {
  const h = harness();
  for (const path of ['/api/position-plan/v1/plan/', '/api/position-plan/v1/%70lan', '/api/position-plan/v1/plan?owner=evil',
    '/api/position-plan/v1/plan#other', '/api/position-plan/v1/execute', '/api/position-plan/v1/', '/api/position-plan/v2/plan',
    '/internal/position-plan/v1/plan', '/api/onboarding/v1/swap-route', '/api/read/v6/portfolio']) {
    await error(await h.worker.fetch(request({ url: origin + path }), env), 'route_not_available');
  }
  for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    await error(await h.worker.fetch(request({ method }), env), 'method_not_allowed');
  }
  for (const extra of ['owner', 'recipient', 'wallet', 'refundTo', 'rpcUrl', 'calldata', 'permit', 'zap']) {
    await error(await h.worker.fetch(request({ body: JSON.stringify({ ...REQUEST, [extra]: '0x' + 'a'.repeat(40) }) }), env), 'invalid_request');
  }
  const text = JSON.stringify(REQUEST);
  for (const body of [text.replace('"chainId":8453', '"chainId":8453.0'), text.replace('"chainId":8453', '"chainId":8.453e3'),
    text.replace('"slippageBps":50', '"slippageBps":5e1'), text.replace('"tickLower":-1200', '"tickLower":-1200.0'),
    text.replace('"chainId":8453', '"chainId":"8453"'), text.replace('"chainId":8453', '"chainId":1'),
    text.replace('"slippageBps":50', '"slippageBps":5'), JSON.stringify({ ...REQUEST, inputs: [{ ...REQUEST.inputs[0], amountRaw: 1000 }] }),
    '[]', 'null', '{"chainId":8453,"chainId":8453}', '{"__proto__":{}}', '﻿{}', '{']) {
    await error(await h.worker.fetch(request({ body }), env), 'invalid_request');
  }
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json;charset=latin1' }, { 'Content-Encoding': 'gzip' }]) {
    await error(await h.worker.fetch(request({ headers }), env), 'json_required');
  }
  for (const headers of [{}, { 'Content-Length': '2' }]) {
    await error(await h.worker.fetch(request({ body: ' '.repeat(POSITION_PLAN_LIMITS.requestBytes + 1), headers }), env), 'request_too_large');
  }
  for (const version of ['1.0.0-rc.1', '1.0.0', `${CONTRACT_VERSION}, ${CONTRACT_VERSION}`]) {
    await error(await h.worker.fetch(request({ headers: { [HEADER]: version } }), env), 'upstream_contract_mismatch');
  }
  assert.equal(h.calls.length, 0);
});

// Changed on purpose 3 Nov 2026 (launch round P2): a 429 keeps the listener's own Retry-After (it was always 60).
for (const [code, status] of Object.entries(ERROR_STATUS_BY_CODE)) test(`the listener's refusal ${code} passes with its own status, a 429 with its own Retry-After, and nothing else of it`, async () => {
  assert.equal(validateError(status, { error: code }), true);
  const h = harness(() => response({ error: code }, status, { 'Set-Cookie': 'secret=1', 'X-Secret': 'secret', 'Retry-After': '5' }));
  const result = await h.worker.fetch(request(), env);
  assert.equal(result.headers.get('Retry-After'), status === 429 ? '5' : null);
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
  for (const version of ['2.0.0', '1.0.0-rc.1', `${CONTRACT_VERSION}, ${CONTRACT_VERSION}`]) {
    await error(await harness(() => response(ANSWER, 200, { [HEADER]: version })).worker.fetch(request(), env), 'upstream_contract_mismatch');
  }
  const text = JSON.stringify(ANSWER);
  for (const output of [response(ANSWER, 200, { 'Content-Encoding': 'gzip' }), response('{"plan":{},"plan":{}}'),
    response(text.replace('"schemaVersion":1', '"schemaVersion":1.0')), response(text.replace('"tickLower":-1200', '"tickLower":-1200.0')),
    response('x'.repeat(POSITION_PLAN_LIMITS.responseBytes + 1)),
    response(ANSWER, 200, { 'Content-Length': String(POSITION_PLAN_LIMITS.responseBytes + 1) }),
    new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'Content-Type': 'application/json', [HEADER]: CONTRACT_VERSION } })]) {
    await error(await harness(() => output).worker.fetch(request(), env), 'upstream_invalid_response');
  }
});

test('a session or CSRF value can never come back inside a plan', async (t) => {
  during(t);
  // 43 characters of the plan's own intent hash, a valid credential shape: as the session, then as the CSRF token.
  const echoed = ANSWER.plan.intentHash.slice(2, 45);
  assert.match(echoed, /^[A-Za-z0-9_-]{43}$/);
  for (const headers of [{ Cookie: `__Host-domino-session=${echoed}` }, { 'X-Domino-CSRF': echoed }]) {
    await error(await harness().worker.fetch(request({ headers }), env), 'upstream_contract_mismatch');
  }
  for (const name of ['POSITION_PLAN_ACCESS_CLIENT_ID', 'POSITION_PLAN_ACCESS_CLIENT_SECRET']) {
    await error(await harness().worker.fetch(request(), { ...env, [name]: echoed }), 'upstream_contract_mismatch');
  }
});

test('an upload stalled past five seconds never dispatches', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const h = harness();
  const pending = h.worker.fetch(request({ body }), env);
  t.mock.timers.tick(POSITION_PLAN_LIMITS.bodyMs + 1);
  await error(await pending, 'request_timeout');
  assert.equal(cancelled, true);
  assert.equal(h.calls.length, 0);
});

test('the listener has its 20 s and the whole request 21 s, under the page\'s 22 s; late work is cancelled', async (t) => {
  assert.equal(POSITION_PLAN_LIMITS.upstreamMs, 20_000);
  assert.equal(POSITION_PLAN_LIMITS.totalMs, 21_000);
  assert.ok(POSITION_PLAN_LIMITS.totalMs < 22_000, 'app/src/v2/plan/httpTransport.ts S1_PLAN_TIMEOUT_MS');
  assert.equal(POSITION_PLAN_LIMITS.requestBytes, 8 * 1024);
  assert.equal(POSITION_PLAN_LIMITS.responseBytes, 384 * 1024);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  let resolve, cancelled = false;
  const h = harness(() => new Promise((done) => { resolve = done; }));
  const pending = h.worker.fetch(request(), env);
  await flush();
  assert.equal(h.calls.length, 1);
  t.mock.timers.tick(POSITION_PLAN_LIMITS.upstreamMs + 1);
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

test('capabilities: a local GET with no session that says whether the route is on, and nothing more', async () => {
  const h = harness();
  const on = await h.worker.fetch(capabilitiesRequest(), env);
  assert.equal(on.status, 200);
  assert.deepEqual(await on.json(), { contractVersion: CONTRACT_VERSION, dataMode: 'live', enabledRoutes: ['plan'] });
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
  await error(await h.worker.fetch(new Request(`${origin}/api/position-plan/v1/capabilities?x=1`), env), 'route_not_available');
  await error(await h.worker.fetch(capabilitiesRequest({ [HEADER]: '1.0.0-rc.1' }), env), 'upstream_contract_mismatch');
  assert.equal((await h.worker.fetch(capabilitiesRequest({ [HEADER]: CONTRACT_VERSION }), env)).status, 200);
  assert.equal(h.calls.length, 0, 'never upstream');
});

test('capabilities and the plan route agree on every configuration', async (t) => {
  during(t);
  for (const settings of [{ ...env }, { ...env, POSITION_PLAN_BRIDGE_ENABLED: 'false' }, { APP_ORIGIN: origin },
    { ...env, POSITION_PLAN_ACCESS_CLIENT_SECRET: '' }, { ...env, POSITION_PLAN_GATEWAY_ORIGIN: origin }, { ...env, APP_ORIGIN: 'nope' }]) {
    const capability = await harness().worker.fetch(capabilitiesRequest(), settings);
    const plan = await harness().worker.fetch(request(), settings);
    const said = capability.status === 200 ? (await capability.json()).dataMode : (await capability.json()).error;
    const did = plan.status === 200 ? 'live' : (await plan.json()).error;
    assert.equal(said === 'disabled' ? 'route_not_available' : said, did, JSON.stringify(settings));
  }
});
