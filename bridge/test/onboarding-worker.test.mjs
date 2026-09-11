import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createOnboardingWorker, ONBOARDING_LIMITS } from '../src/onboarding-worker.mjs';
import { CONTRACT_VERSION, ROUTES, ERROR_STATUS_BY_CODE,
  validateRequest, validateResponse } from '../../api-contracts/onboarding-v1/runtime.mjs';

const origin = 'https://app.example.invalid';
const session = 's'.repeat(43), csrf = 'c'.repeat(43);
const env = { APP_ORIGIN: origin, ONBOARDING_BRIDGE_ENABLED: 'true',
  ONBOARDING_GATEWAY_ORIGIN: 'https://onboarding.example.invalid',
  ONBOARDING_ACCESS_CLIENT_ID: 'synthetic-onboarding-id', ONBOARDING_ACCESS_CLIENT_SECRET: 'synthetic-onboarding-secret' };
const fixture = (path) => JSON.parse(readFileSync(new URL(`../../api-contracts/onboarding-v1/fixtures/${path}.json`, import.meta.url)));
const requests = Object.fromEntries(ROUTES.map((route) => [route, fixture(`requests/${route}`)]));
const responses = Object.fromEntries(ROUTES.map((route) => [route, fixture(`responses/${route}`)]));
function fresh(route = 'swap-preview', value = responses[route], now = Math.floor(Date.now() / 1000)) {
  const body = structuredClone(value);
  Object.assign(body.preview, { requestedAt: now, retrievedAt: now, expiresAt: now + 30 });
  if (route === 'position-preview') body.preview.preparedDeadline = now + 1200;
  return body;
}
function request(route = 'swap-preview', options = {}) {
  const { method = 'POST', body = JSON.stringify(requests[route] ?? {}), headers = {},
    url = `${origin}/api/onboarding/v1/${route}`, ...rest } = options;
  return new Request(url, { method, headers: { Origin: origin, 'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
    Cookie: `__Host-domino-session=${session}`, 'X-Domino-CSRF': csrf, ...headers },
    ...(['GET', 'HEAD'].includes(method) ? {} : { body, duplex: 'half' }), ...rest });
}
function response(value = fresh(), status = 200, headers = {}) {
  return new Response(typeof value === 'string' ? value : JSON.stringify(value), { status,
    headers: { 'Content-Type': 'application/json', 'X-Domino-Onboarding-Contract': CONTRACT_VERSION, ...headers } });
}
function harness(responder = () => response(), ip = '203.0.113.7') {
  const calls = [];
  return { calls, worker: createOnboardingWorker({ getClientIp: () => ip,
    fetch: (url, init) => { calls.push({ url, init }); return responder(url, init); } }) };
}
async function error(result, code) {
  assert.equal(result.status, ERROR_STATUS_BY_CODE[code]);
  assert.deepEqual(await result.json(), { error: code });
  assert.equal(result.headers.get('X-Domino-Onboarding-Contract'), CONTRACT_VERSION);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(result.headers.get('Set-Cookie'), null);
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), null);
}
async function flush() { for (let i = 0; i < 24; i++) await Promise.resolve(); }

test('onboarding defaults off and cannot inherit read or session activation', async () => {
  const h = harness();
  for (const settings of [{ APP_ORIGIN: origin }, { APP_ORIGIN: origin, ONBOARDING_BRIDGE_ENABLED: true },
    { APP_ORIGIN: origin, SESSION_BRIDGE_ENABLED: 'true', READ_BRIDGE_ENABLED: 'true' }]) {
    await error(await h.worker.fetch(request(), settings), 'route_not_available');
  }
  assert.equal(h.calls.length, 0);
});
for (const settings of [
  { APP_ORIGIN: 'http://app.example.invalid' }, { APP_ORIGIN: `${origin}/` },
  { ONBOARDING_GATEWAY_ORIGIN: origin }, { ONBOARDING_GATEWAY_ORIGIN: 'http://onboarding.example.invalid' },
  { ONBOARDING_GATEWAY_ORIGIN: `${env.ONBOARDING_GATEWAY_ORIGIN}/path` },
  { ONBOARDING_ACCESS_CLIENT_ID: '' }, { ONBOARDING_ACCESS_CLIENT_SECRET: 'bad\nsecret' },
  { ONBOARDING_ACCESS_CLIENT_SECRET: undefined, SESSION_ACCESS_CLIENT_SECRET: 'session-secret' },
  { ONBOARDING_ACCESS_CLIENT_ID: undefined, ACCESS_CLIENT_ID: 'reader-id' },
]) test(`invalid isolated configuration rejects ${JSON.stringify(settings)}`, async () => {
  const h = harness();
  await error(await h.worker.fetch(request(), { ...env, ...settings }), 'upstream_unavailable');
  assert.equal(h.calls.length, 0);
});

for (const route of ROUTES) test(`${route} forwards only fixed auth headers and preserves the exact safe preview`, async () => {
  const output = fresh(route);
  const h = harness(() => response(output, 200, { 'Set-Cookie': 'evil=secret', Location: 'https://evil.invalid',
    Authorization: 'secret', 'X-Provider-Key': 'secret', 'X-Domino-CSRF': 'secret' }));
  const result = await h.worker.fetch(request(route, { headers: {
    Cookie: `unrelated=secret; __Host-domino-preauth=${'p'.repeat(43)}; __Host-domino-session=${session}`,
    'X-Domino-Session': 'forged-session', 'X-Domino-Preauth': 'forged-preauth', 'X-Domino-Client-Id': 'forged-ip',
    'X-Domino-Browser-Origin': 'https://evil.invalid', 'CF-Access-Jwt-Assertion': 'forged-assertion',
    'CF-Access-Client-Id': 'forged-id', 'CF-Access-Client-Secret': 'forged-secret',
    Authorization: 'forged-bearer', 'X-Forwarded-For': '192.0.2.1', 'X-Arbitrary': 'secret',
  } }), env);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), output);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, `${env.ONBOARDING_GATEWAY_ORIGIN}/internal/onboarding/v1/${route}`);
  assert.equal(h.calls[0].init.method, 'POST');
  assert.equal(h.calls[0].init.redirect, 'manual');
  assert.equal(h.calls[0].init.body, JSON.stringify(requests[route]));
  assert.deepEqual(h.calls[0].init.headers, { 'Content-Type': 'application/json', 'X-Domino-Onboarding-Contract': '1.0.0',
    'CF-Access-Client-Id': env.ONBOARDING_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.ONBOARDING_ACCESS_CLIENT_SECRET,
    'X-Domino-Client-Id': '203.0.113.7', 'X-Domino-Browser-Origin': origin,
    'X-Domino-Session': session, 'X-Domino-CSRF': csrf });
  for (const name of ['Set-Cookie', 'Location', 'Authorization', 'X-Provider-Key', 'X-Domino-CSRF']) assert.equal(result.headers.get(name), null);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(result.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), null);
});

for (const path of ['/api/read/v1/token', '/api/session/v1/me', '/internal/onboarding/v1/swap-preview',
  '/api/onboarding/v1/swap-preview/', '/api/onboarding/v1/%73wap-preview',
  '/api/onboarding/v1/position-preview?owner=evil', '/api/onboarding/v1/swap-preview#other', '/api/onboarding/v1/execute']) {
  test(`unknown or alternate path ${path} cannot dispatch`, async () => {
    const h = harness();
    await error(await h.worker.fetch(request('swap-preview', { url: origin + path }), env), 'route_not_available');
    assert.equal(h.calls.length, 0);
  });
}
for (const method of ['GET', 'HEAD', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) test(`preview ${method} is unavailable`, async () => {
  const h = harness();
  await error(await h.worker.fetch(request('swap-preview', { method }), env), 'method_not_allowed');
  assert.equal(h.calls.length, 0);
});
for (const headers of [{ Origin: 'null' }, { Origin: 'https://other.example.invalid' },
  { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Mode': 'navigate' },
  { 'Sec-Fetch-Dest': 'iframe' }, { 'Sec-Fetch-User': '?1' }, { Host: 'other.example.invalid' }]) {
  test(`origin or fetch metadata rejects ${JSON.stringify(headers)}`, async () => {
    const h = harness();
    await error(await h.worker.fetch(request('swap-preview', { headers }), env), 'origin_not_allowed');
    assert.equal(h.calls.length, 0);
  });
}
test('Origin and session cannot be replaced by forged internal headers', async () => {
  const h = harness();
  const noOrigin = request(); noOrigin.headers.delete('Origin');
  await error(await h.worker.fetch(noOrigin, env), 'origin_not_allowed');
  const noSession = request('swap-preview', { headers: { 'X-Domino-Session': session } }); noSession.headers.delete('Cookie');
  await error(await h.worker.fetch(noSession, env), 'session_required');
  await error(await h.worker.fetch(request('swap-preview', { headers: { Cookie: `__Host-domino-preauth=${session}` } }), env), 'session_required');
  assert.equal(h.calls.length, 0);
});
test('CSRF is required and combined or malformed values fail closed', async () => {
  const h = harness();
  const missing = request(); missing.headers.delete('X-Domino-CSRF');
  await error(await h.worker.fetch(missing, env), 'csrf_invalid');
  for (const value of ['', csrf + ', ' + csrf, 'x'.repeat(44), 'x'.repeat(42), '"' + csrf + '"']) {
    await error(await h.worker.fetch(request('swap-preview', { headers: { 'X-Domino-CSRF': value } }), env), 'csrf_invalid');
  }
  assert.equal(h.calls.length, 0);
});
for (const cookie of [`__Host-domino-session=${session}; __Host-domino-session=${session}`, '__Host-domino-session',
  '__Host-domino-session=', `__Host-domino-session="${session}"`, `__Host-domino-session=${'%73'.repeat(43)}`,
  `__Host-domino-session=${session}, unrelated=secret`, `unrelated=${'x'.repeat(8193)}`]) {
  test(`ambiguous or oversized session cookie rejects ${cookie.slice(0, 55)}`, async () => {
    const h = harness();
    await error(await h.worker.fetch(request('swap-preview', { headers: { Cookie: cookie } }), env), 'invalid_request');
    assert.equal(h.calls.length, 0);
  });
}
test('unrelated and malformed preauth cookies are not parsed or forwarded', async () => {
  const h = harness();
  assert.equal((await h.worker.fetch(request('swap-preview', { headers: {
    Cookie: `__Host-domino-preauth=bad; __Host-domino-preauth=duplicate; __Host-domino-session=${session}`,
  } }), env)).status, 200);
  assert.equal(Object.keys(h.calls[0].init.headers).some((name) => name.toLowerCase().includes('preauth')), false);
});

for (const extra of ['owner', 'wallet', 'recipient', 'sessionId', 'tenant', 'rpcUrl', 'apiKey', 'calldata', 'permit']) {
  test(`browser ${extra} cannot override backend authority`, async () => {
    const h = harness();
    for (const route of ROUTES) await error(await h.worker.fetch(request(route, {
      body: JSON.stringify({ ...requests[route], [extra]: '0x' + 'a'.repeat(40) }),
    }), env), 'invalid_request');
    assert.equal(h.calls.length, 0);
  });
}
for (const lexeme of ['4663.0', '4.663e3', '4663.000000000000000001', '9007199254740993', 'true', '"4663"']) {
  test(`request chain lexical value ${lexeme} cannot round into acceptance`, async () => {
    const h = harness();
    const body = JSON.stringify(requests['swap-preview']).replace('"chainId":4663', `"chainId":${lexeme}`);
    await error(await h.worker.fetch(request('swap-preview', { body }), env), 'invalid_request');
    assert.equal(h.calls.length, 0);
  });
}
for (const [field, lexeme] of [['slippageBps', '5e1'], ['tickLower', '-120.0'], ['tickUpper', '180.0000000000000000001'],
  ['tick_spacing', '6e1'], ['fee_pips', '3000.0']]) test(`nested/integer field ${field} rejects ${lexeme}`, async () => {
  const h = harness();
  const body = JSON.stringify(requests['position-preview']).replace(new RegExp(`"${field}":-?[0-9]+`), `"${field}":${lexeme}`);
  await error(await h.worker.fetch(request('position-preview', { body }), env), 'invalid_request');
  assert.equal(h.calls.length, 0);
});
for (const body of ['[]', 'null', '{"chainId":4663,"chainId":4663}', '{"chainId":4663,"chain\\u0049d":4663}',
  '{"amountRaw":NaN}', '{"amountRaw":Infinity}', '{"value":1e999}', '{"__proto__":{}}', '\ufeff{}']) {
  test(`malformed or ambiguous JSON rejects ${body.slice(0, 55)}`, async () => {
    const h = harness();
    await error(await h.worker.fetch(request('swap-preview', { body }), env), 'invalid_request');
    assert.equal(h.calls.length, 0);
  });
}
test('raw money remains string data and malformed values never contact the provider', async () => {
  const h = harness();
  for (const value of [1000, 0, '0', '01', '1e3', '-1', String(2n ** 256n)]) {
    await error(await h.worker.fetch(request('swap-preview', { body: JSON.stringify({ ...requests['swap-preview'], amountRaw: value }) }), env), 'invalid_request');
  }
  assert.equal(h.calls.length, 0);
});
test('optional missing position limits associate with explicit nulls, preserving unavailable states', async () => {
  const output = fresh('position-preview', fixture('variants/position-preview.incomplete'));
  const selected = structuredClone(requests['position-preview']);
  for (const name of ['budget0Raw', 'budget1Raw', 'nativeBalanceRaw', 'nativeGasReserveRaw']) delete selected[name];
  const h = harness(() => response(output));
  const result = await h.worker.fetch(request('position-preview', { body: JSON.stringify(selected) }), env);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), output);
});
test('provider decimal precision and raw amounts survive output without Number coercion', async () => {
  const output = fresh('position-preview');
  output.preview.position.adjustedPrices.min = '0.988072305665616181955758512345678901234567890123456789';
  const h = harness(() => response(output));
  const result = await h.worker.fetch(request('position-preview'), env);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).preview.position.adjustedPrices.min, output.preview.position.adjustedPrices.min);
  assert.equal(h.calls[0].init.body, JSON.stringify(requests['position-preview']));
});
test('uint256 raw input and output beyond Number precision remain exact strings', async () => {
  const amount = 2n ** 200n + 199n, outgoing = amount * 2n, minimum = outgoing * 9950n / 10000n;
  const selected = { ...requests['swap-preview'], amountRaw: String(amount) };
  const output = fresh();
  output.preview.request.amountRaw = String(amount);
  Object.assign(output.preview.quote, { dexInputAmountRaw: String(amount), grossOutputAmountRaw: String(outgoing),
    grossMinimumOutputAmountRaw: String(minimum), policyMinimumOutputRaw: String(minimum),
    outputAfterProviderFeeRaw: String(outgoing), minimumAfterProviderFeeRaw: String(minimum) });
  Object.assign(output.preview.quote.routes[0][0], { amountInRaw: String(amount), amountOutRaw: String(outgoing) });
  const h = harness(() => response(output));
  const result = await h.worker.fetch(request('swap-preview', { body: JSON.stringify(selected) }), env);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).preview.quote.grossOutputAmountRaw, String(outgoing));
  assert.equal(JSON.parse(h.calls[0].init.body).amountRaw, String(amount));
});

for (const [code, status] of Object.entries(ERROR_STATUS_BY_CODE)) test(`safe exact error ${code} exposes no upstream headers`, async () => {
  const h = harness(() => response({ error: code }, status, { 'Set-Cookie': 'secret=1', 'X-Secret': 'secret' }));
  const result = await h.worker.fetch(request(), env);
  await error(result, code);
  assert.equal(result.headers.get('X-Secret'), null);
});
for (const route of ROUTES) test(`${route} rejects mismatched echo, chain and unexpected executable fields`, async () => {
  for (const mutate of [
    (body) => { body.preview.request.amountRaw += '1'; },
    (body) => { body.preview.request.chainId = 1; },
    (body) => { body.preview.chainId = 1; },
    (body) => { body.preview.executionAvailable = true; },
    (body) => { body.preview.calldata = '0x1234'; },
    (body) => { body.credentials = { session }; },
  ]) {
    const output = fresh(route); mutate(output);
    const h = harness(() => response(output));
    await error(await h.worker.fetch(request(route), env), 'upstream_contract_mismatch');
  }
});
test('position echo must match selected pool, range and funding values', async () => {
  for (const [field, value] of [['poolId', '0x' + 'f'.repeat(64)], ['tickLower', -180], ['tickUpper', 240],
    ['independentToken', requests['position-preview'].poolKey.currency1], ['budget0Raw', '999'], ['nativeBalanceRaw', '2000']]) {
    const output = fresh('position-preview'); output.preview.request[field] = value;
    const h = harness(() => response(output));
    await error(await h.worker.fetch(request('position-preview'), env), 'upstream_contract_mismatch');
  }
});
test('actual position and swap projections cannot detach from the echoed request', async () => {
  for (const [route, mutate] of [
    ['position-preview', (p) => { p.position.recipient = '0x' + 'f'.repeat(40); }],
    ['position-preview', (p) => { p.position.tickLower -= 60; }],
    ['position-preview', (p) => { p.position.poolId = '0x' + 'f'.repeat(64); }],
    ['position-preview', (p) => { p.nativeFunding.reportedBalanceRaw = '999'; }],
    ['swap-preview', (p) => { p.quote.dexInputAmountRaw = '999'; }],
    ['swap-preview', (p) => { p.quote.routes[0][0].tokenIn.address = '0x' + 'f'.repeat(40); }],
  ]) {
    const output = fresh(route); mutate(output.preview);
    const h = harness(() => response(output));
    await error(await h.worker.fetch(request(route), env), 'upstream_contract_mismatch');
  }
});
test('session CSRF and service values cannot escape in otherwise allowed numeric strings', async () => {
  for (const field of ['session', 'csrf', 'clientId', 'clientSecret']) {
    const secret = '7'.repeat(43), output = fresh(); output.preview.gas.feeWei = secret;
    const h = harness(() => response(output));
    const settings = { ...env }, headers = {};
    if (field === 'session') headers.Cookie = `__Host-domino-session=${secret}`;
    if (field === 'csrf') headers['X-Domino-CSRF'] = secret;
    if (field === 'clientId') settings.ONBOARDING_ACCESS_CLIENT_ID = secret;
    if (field === 'clientSecret') settings.ONBOARDING_ACCESS_CLIENT_SECRET = secret;
    await error(await h.worker.fetch(request('swap-preview', { headers }), settings), 'upstream_contract_mismatch');
  }
});
test('valid but expired preview is unavailable without repairing timestamps', async () => {
  const h = harness(() => response(fresh('swap-preview', responses['swap-preview'], Math.floor(Date.now() / 1000) - 30)));
  await error(await h.worker.fetch(request(), env), 'preview_expired');
});
test('incoherent or excessively future timestamps are rejected', async () => {
  for (const mutate of [(p) => { p.requestedAt = p.retrievedAt + 1; },
    (p) => { p.expiresAt++; }, (p) => { p.retrievedAt = p.expiresAt; },
    (p) => { p.requestedAt += 6; p.retrievedAt += 6; p.expiresAt += 6; }]) {
    const output = fresh(); mutate(output.preview);
    const h = harness(() => response(output));
    await error(await h.worker.fetch(request(), env), 'upstream_contract_mismatch');
  }
});
for (const raw of ['1.0', '1e0', '1.00000000000000001', '9007199254740993']) test(`response integer lexical ${raw} is not rounded`, async () => {
  const text = JSON.stringify(fresh()).replace('"schemaVersion":1', `"schemaVersion":${raw}`);
  const h = harness(() => response(text));
  await error(await h.worker.fetch(request(), env), 'upstream_invalid_response');
});
test('unversioned Access errors, redirects, HTML and arbitrary errors are sanitized', async () => {
  for (const output of [new Response('access denied', { status: 403 }), response('', 302, { Location: 'https://evil.invalid' }),
    response('<html>login</html>', 200, { 'Content-Type': 'text/html' }), response({ error: 'secret-provider-key' }, 503),
    response({ error: 'session_required', detail: 'secret' }, 401), response({ error: 'provider_unavailable' }, 403)]) {
    const h = harness(() => output);
    await error(await h.worker.fetch(request(), env), 'upstream_unavailable');
    assert.equal(h.calls.length, 1);
  }
});
test('contract versions are pinned on success and safe errors', async () => {
  for (const version of ['2.0.0', '1.0.0, 1.0.0']) {
    const h = harness(() => response(fresh(), 200, { 'X-Domino-Onboarding-Contract': version }));
    await error(await h.worker.fetch(request(), env), 'upstream_contract_mismatch');
    const local = harness();
    await error(await local.worker.fetch(request('swap-preview', { headers: { 'X-Domino-Onboarding-Contract': version } }), env), 'upstream_contract_mismatch');
    assert.equal(local.calls.length, 0);
  }
});
test('upstream encoded duplicate-key invalidUTF8 and oversized output fails closed', async () => {
  for (const output of [response(fresh(), 200, { 'Content-Encoding': 'gzip' }), response('{"preview":{},"preview":{}}'),
    response('x'.repeat(ONBOARDING_LIMITS.responseBytes + 1)), response(fresh(), 200, { 'Content-Length': String(ONBOARDING_LIMITS.responseBytes + 1) }),
    new Response(new Uint8Array([0xc3, 0x28]), { headers: { 'Content-Type': 'application/json', 'X-Domino-Onboarding-Contract': '1.0.0' } })]) {
    const h = harness(() => output);
    await error(await h.worker.fetch(request(), env), 'upstream_invalid_response');
  }
});
test('upload media, encodings, lengths and bytes are bounded independently of declared length', async () => {
  const h = harness();
  for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Type': 'application/json;charset=latin1' }, { 'Content-Encoding': 'gzip' }]) {
    await error(await h.worker.fetch(request('swap-preview', { headers }), env), 'json_required');
  }
  for (const headers of [{}, { 'Content-Length': '2' }]) {
    await error(await h.worker.fetch(request('swap-preview', { body: ' '.repeat(8193), headers }), env), 'request_too_large');
  }
  await error(await h.worker.fetch(request('swap-preview', { body: new Uint8Array([0xc3, 0x28]) }), env), 'invalid_request');
  assert.equal(h.calls.length, 0);
});
test('untrusted client identity cannot be replaced by browser-supplied identifiers', async () => {
  for (const ip of [null, '', 'example.invalid', '192.0.2.1, 192.0.2.2']) {
    const h = harness(undefined, ip);
    await error(await h.worker.fetch(request('swap-preview', { headers: { 'X-Domino-Client-Id': '192.0.2.1' } }), env), 'upstream_unavailable');
    assert.equal(h.calls.length, 0);
  }
});
test('already cancelled request does no upstream work', async () => {
  const controller = new AbortController(); controller.abort();
  const h = harness();
  await error(await h.worker.fetch(request('swap-preview', { signal: controller.signal }), env), 'request_timeout');
  assert.equal(h.calls.length, 0);
});
test('browser cancellation stops a transport ignoring AbortSignal without retries', async () => {
  const controller = new AbortController();
  const h = harness(() => { controller.abort(); return new Promise(() => {}); });
  await error(await h.worker.fetch(request('swap-preview', { signal: controller.signal }), env), 'request_timeout');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].init.signal.aborted, true);
});
test('five second upload budget cancels a stalled stream before dispatch', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const h = harness();
  const pending = h.worker.fetch(request('swap-preview', { body }), env);
  t.mock.timers.tick(ONBOARDING_LIMITS.bodyMs + 1);
  await error(await pending, 'request_timeout');
  assert.equal(cancelled, true); assert.equal(h.calls.length, 0);
});
test('upstream fetch and stream share twenty seconds and cancel late ignored work', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  let resolve, cancelled = false;
  const h = harness(() => new Promise((done) => { resolve = done; }));
  const pending = h.worker.fetch(request(), env);
  await flush(); assert.equal(h.calls.length, 1);
  t.mock.timers.tick(ONBOARDING_LIMITS.upstreamMs + 1);
  await error(await pending, 'upstream_timeout');
  assert.equal(h.calls[0].init.signal.aborted, true);
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await flush(); assert.equal(cancelled, true);
});
test('partial response chunks cannot reset the shared upstream deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  let cancelled = false;
  const h = harness(() => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); },
    cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json', 'X-Domino-Onboarding-Contract': '1.0.0' } }));
  const pending = h.worker.fetch(request(), env); await flush();
  t.mock.timers.tick(ONBOARDING_LIMITS.upstreamMs + 1);
  await error(await pending, 'upstream_timeout');
  assert.equal(cancelled, true); assert.equal(h.calls.length, 1);
});
test('synchronously fulfilled late upstream cannot bypass the absolute deadline', async (t) => {
  let now = 1000000; t.mock.method(Date, 'now', () => now);
  const h = harness(() => { now += ONBOARDING_LIMITS.upstreamMs; return response(); });
  await error(await h.worker.fetch(request(), env), 'upstream_timeout');
  assert.equal(h.calls.length, 1);
});
test('fulfilled upload after absolute body expiry cannot dispatch', async (t) => {
  let now = 1000000; t.mock.method(Date, 'now', () => now);
  const h = harness();
  const body = new ReadableStream({ pull(controller) { now += 5001;
    controller.enqueue(new TextEncoder().encode(JSON.stringify(requests['swap-preview']))); controller.close(); } });
  await error(await h.worker.fetch(request('swap-preview', { body }), env), 'request_timeout');
  assert.equal(h.calls.length, 0);
});
test('body parsing and credential work cannot extend the original five-second upload deadline', async (t) => {
  let now = 1000000; t.mock.method(Date, 'now', () => now);
  const originalParse = JSON.parse;
  t.mock.method(JSON, 'parse', (text, ...args) => {
    const value = originalParse(text, ...args);
    if (text === '"amountRaw"') now += 5001;
    return value;
  });
  const h = harness();
  await error(await h.worker.fetch(request(), env), 'request_timeout');
  assert.equal(h.calls.length, 0);
});
test('upstream parsing cannot return success after its absolute budget', async (t) => {
  let now = 1000000; t.mock.method(Date, 'now', () => now);
  const originalParse = JSON.parse;
  t.mock.method(JSON, 'parse', (text, ...args) => {
    const value = originalParse(text, ...args);
    if (text === '"uniswap_trading_quote_v1"') now += 20001;
    return value;
  });
  const h = harness();
  await error(await h.worker.fetch(request(), env), 'upstream_timeout');
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].init.signal.aborted, true);
});
test('shared producer fixtures satisfy the closed onboarding contract', () => {
  for (const route of ROUTES) {
    assert.equal(validateRequest(route, requests[route]), true);
    assert.equal(validateResponse(route, fresh(route)), true);
  }
});
