import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSessionWorker, SESSION_LIMITS } from '../src/session-worker.mjs';
import { CONTRACT_VERSION, ERROR_STATUS_BY_CODE, validateRequest, validateResponse, validateEnvelope } from '../../api-contracts/session-v1/runtime.mjs';

const origin = 'https://app.example.invalid';
const address = `0x${'1'.repeat(40)}`;
const token = 's'.repeat(43), preauth = 'p'.repeat(43), csrf = 'c'.repeat(43);
const env = { APP_ORIGIN: origin, SESSION_BRIDGE_ENABLED: 'true',
  SESSION_GATEWAY_ORIGIN: 'https://auth.example.invalid',
  SESSION_ACCESS_CLIENT_ID: 'synthetic-auth-id', SESSION_ACCESS_CLIENT_SECRET: 'synthetic-auth-secret' };
const expiresAt = '2026-09-10T20:00:00Z';
const loggedIn = { authenticated: true, owner: { address, chainId: 4663 }, expiresAt, csrfToken: csrf,
  validation: { method: 'plain_eoa', blockNumber: '123', blockHash: `0x${'a'.repeat(64)}` } };
const message = `${new URL(origin).host} wants you to sign in with your Ethereum account:\n${address}\n\nSign in to Domino. This does not authorize any transactions.\n\nURI: ${origin}/\nVersion: 1\nChain ID: 4663\nNonce: ${'a'.repeat(32)}\nIssued At: 2026-09-10T19:55:00Z\nExpiration Time: ${expiresAt}`;
const payloads = { bootstrap: {}, challenge: { address, chainId: 4663 },
  verify: { challengeId: 'a'.repeat(32), message, signature: `0x${'1'.repeat(130)}` }, me: {}, refresh: {}, logout: {} };
const envelopes = {
  bootstrap: { result: { status: 'challenge_required', csrfToken: csrf, expiresAt }, credentials: { preauth } },
  challenge: { result: { challengeId: 'a'.repeat(32), message, expiresAt }, credentials: {} },
  verify: { result: loggedIn, credentials: { preauth: null, session: token } },
  me: { result: loggedIn, credentials: {} },
  refresh: { result: loggedIn, credentials: {} },
  logout: { result: { authenticated: false }, credentials: { preauth: null, session: null } },
};
function request(route = 'bootstrap', options = {}) {
  const { method = route === 'me' ? 'GET' : 'POST', body = JSON.stringify(payloads[route] ?? {}), headers = {}, url = `${origin}/api/session/v1/${route}`, ...rest } = options;
  return new Request(url, { method, headers: { Origin: origin, 'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', 'X-Domino-CSRF': csrf, ...headers },
    ...(['GET', 'HEAD'].includes(method) ? {} : { body, duplex: 'half' }), ...rest });
}
function response(body, status = 200, headers = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status,
    headers: { 'Content-Type': 'application/json', 'X-Domino-Session-Contract': CONTRACT_VERSION, ...headers } });
}
function harness(responder = () => response(envelopes.bootstrap), ip = '203.0.113.7') {
  const calls = [];
  return { calls, worker: createSessionWorker({ getClientIp: () => ip,
    fetch: async (url, init) => { calls.push({ url, init }); return responder(url, init); } }) };
}
async function error(result, code) {
  assert.equal(result.status, ERROR_STATUS_BY_CODE[code]);
  assert.deepEqual(await result.json(), { error: code });
  assert.equal(result.headers.get('Set-Cookie'), null);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), null);
  assert.equal(result.headers.get('X-Domino-Session-Contract'), CONTRACT_VERSION);
}

test('session routes are disabled by default and never use read activation flags', async () => {
  const h = harness();
  for (const patch of [{}, { SESSION_BRIDGE_ENABLED: true }, { READ_BRIDGE_ENABLED: 'true' }]) {
    await error(await h.worker.fetch(request(), { APP_ORIGIN: origin, ...patch }), 'route_not_available');
  }
  assert.equal(h.calls.length, 0);
});
for (const patch of [
  { APP_ORIGIN: 'http://app.example.invalid' }, { APP_ORIGIN: `${origin}/` },
  { SESSION_GATEWAY_ORIGIN: origin }, { SESSION_GATEWAY_ORIGIN: `${env.SESSION_GATEWAY_ORIGIN}/path` },
  { SESSION_GATEWAY_ORIGIN: 'http://auth.example.invalid' }, { SESSION_ACCESS_CLIENT_ID: '' },
  { SESSION_ACCESS_CLIENT_SECRET: 'bad\nheader' }, { SESSION_ACCESS_CLIENT_SECRET: undefined, ACCESS_CLIENT_SECRET: 'reader-secret' },
]) test(`invalid auth configuration rejects ${JSON.stringify(patch)}`, async () => {
  const h = harness();
  await error(await h.worker.fetch(request(), { ...env, ...patch }), 'upstream_unavailable');
  assert.equal(h.calls.length, 0);
});

for (const route of Object.keys(payloads)) test(`${route} maps to its isolated POST auth route, strips cookie directives`, async () => {
  const h = harness(() => response(envelopes[route], 200, {
    'Set-Cookie': 'evil=1; Domain=example.invalid', 'Authorization': 'upstream-secret', 'X-Leak': 'provider-secret',
  }));
  const result = await h.worker.fetch(request(route, { headers: { Cookie: `unrelated=browser-secret; __Host-domino-preauth=${preauth}; __Host-domino-session=${token}`,
    Authorization: 'spoofed-bearer', 'CF-Access-Client-Secret': 'spoofed-service-secret',
    'X-Domino-Client-Id': 'evil', 'X-Domino-Session': 'evil', 'X-Domino-Browser-Origin': 'evil', 'X-Anything': 'evil' } }), env);
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), envelopes[route].result);
  assert.equal(h.calls.length, 1);
  const call = h.calls[0];
  assert.equal(call.url, `${env.SESSION_GATEWAY_ORIGIN}/internal/session/v1/${route}`);
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.redirect, 'manual');
  assert.equal(call.init.body, JSON.stringify(payloads[route]));
  assert.deepEqual(call.init.headers, { 'Content-Type': 'application/json', 'X-Domino-Session-Contract': CONTRACT_VERSION,
    'CF-Access-Client-Id': env.SESSION_ACCESS_CLIENT_ID, 'CF-Access-Client-Secret': env.SESSION_ACCESS_CLIENT_SECRET,
    'X-Domino-Client-Id': '203.0.113.7', 'X-Domino-Browser-Origin': origin,
    'X-Domino-preauth': preauth, 'X-Domino-session': token, 'X-Domino-CSRF': csrf });
  assert.equal(result.headers.get('Authorization'), null);
  assert.equal(result.headers.get('X-Leak'), null);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  const cookies = result.headers.getSetCookie();
  assert.equal(cookies.length, Object.keys(envelopes[route].credentials).length);
  for (const cookie of cookies) {
    assert.match(cookie, /^__Host-domino-(preauth|session)=/);
    assert.ok(cookie.includes('; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age='));
    assert.ok(!cookie.includes('Domain=') && !cookie.includes('evil'));
  }
  if (route === 'verify') {
    assert.ok(cookies.some((cookie) => cookie.includes('preauth=;') && cookie.endsWith('Max-Age=0')));
    assert.ok(cookies.some((cookie) => cookie.includes(`session=${token};`) && cookie.endsWith('Max-Age=43200')));
  }
  if (route === 'logout') assert.ok(cookies.every((cookie) => cookie.endsWith('Max-Age=0')));
});

test('an EIP-7702 account passes through with its delegate; a malformed one is a contract mismatch', async () => {
  const delegated = { ...loggedIn, validation: { ...loggedIn.validation, method: 'eip7702_delegated', delegate: `0x${'d7'.repeat(20)}` } };
  for (const route of ['verify', 'me', 'refresh']) {
    const ok = harness(() => response({ ...envelopes[route], result: delegated }));
    const result = await ok.worker.fetch(request(route), env);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), delegated);
  }
  for (const validation of [{ ...delegated.validation, delegate: `0x${'0'.repeat(40)}` },
    { ...loggedIn.validation, delegate: `0x${'d7'.repeat(20)}` }, { ...loggedIn.validation, method: 'contract' }]) {
    const bad = harness(() => response({ ...envelopes.me, result: { ...loggedIn, validation } }));
    await error(await bad.worker.fetch(request('me'), env), 'upstream_contract_mismatch');
  }
});

for (const path of ['/api/read/v1/token', '/api/session/v1/me/', '/api/session/v1/%6de',
  '/api/session/v1/verify?account=evil', '/api/session/v1/private', '/internal/session/v1/bootstrap']) {
  test(`no alternate route ${path}`, async () => {
    const h = harness();
    await error(await h.worker.fetch(request('bootstrap', { url: origin + path }), env), 'route_not_available');
    assert.equal(h.calls.length, 0);
  });
}
for (const method of ['GET', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']) test(`bootstrap ${method} is unavailable`, async () => {
  const h = harness();
  await error(await h.worker.fetch(request('bootstrap', { method }), env), 'method_not_allowed');
  assert.equal(h.calls.length, 0);
});
test('me only accepts GET without body or tenant parameters', async () => {
  const h = harness();
  await error(await h.worker.fetch(request('me', { method: 'POST' }), env), 'method_not_allowed');
  await error(await h.worker.fetch(request('me', { headers: { 'Content-Length': '1' } }), env), 'invalid_request');
  await error(await h.worker.fetch(request('me', { url: `${origin}/api/session/v1/me?owner=${address}` }), env), 'route_not_available');
  assert.equal(h.calls.length, 0);
});

for (const headers of [{ Origin: 'https://sibling.example.invalid' }, { Origin: 'null' },
  { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Mode': 'navigate' },
  { 'Sec-Fetch-Dest': 'iframe' }, { 'Sec-Fetch-User': '?1' }, { Host: 'sibling.example.invalid' }]) {
  test(`origin / Fetch Metadata rejection ${JSON.stringify(headers)}`, async () => {
    const h = harness();
    for (const route of ['bootstrap', 'challenge', 'verify', 'me', 'refresh', 'logout']) {
      await error(await h.worker.fetch(request(route, { headers }), env), 'origin_not_allowed');
    }
    assert.equal(h.calls.length, 0);
  });
}
test('POST needs Origin; same-origin GET me can omit it', async () => {
  const h = harness(() => response(envelopes.me));
  const bad = request(); bad.headers.delete('Origin');
  await error(await h.worker.fetch(bad, env), 'origin_not_allowed');
  const good = request('me'); good.headers.delete('Origin');
  assert.equal((await h.worker.fetch(good, env)).status, 200);
});
test('reload GET needs no CSRF; refresh requires POST with Origin and CSRF', async () => {
  const h = harness((url) => response(url.endsWith('/me') ? envelopes.me : envelopes.refresh));
  const reload = request('me', { headers: { Cookie: `__Host-domino-session=${token}` } });
  for (const name of ['Origin', 'X-Domino-CSRF', 'Sec-Fetch-Site', 'Sec-Fetch-Mode', 'Sec-Fetch-Dest']) reload.headers.delete(name);
  const recovered = await h.worker.fetch(reload, env);
  assert.equal(recovered.status, 200);
  assert.equal((await recovered.json()).csrfToken, csrf);
  assert.equal(h.calls[0].init.headers['X-Domino-CSRF'], undefined);
  assert.equal(recovered.headers.get('Set-Cookie'), null);
  const noOrigin = request('refresh'); noOrigin.headers.delete('Origin');
  await error(await h.worker.fetch(noOrigin, env), 'origin_not_allowed');
  await error(await h.worker.fetch(request('refresh', { method: 'GET' }), env), 'method_not_allowed');
  const refreshed = await h.worker.fetch(request('refresh', { headers: { Cookie: `__Host-domino-session=${token}` } }), env);
  assert.equal(refreshed.status, 200);
  assert.equal((await refreshed.json()).csrfToken, csrf);
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls[1].init.headers['X-Domino-CSRF'], csrf);
  assert.equal(refreshed.headers.get('Set-Cookie'), null);
});
test('canonical Access failure is preserved as 503 without credentials', async () => {
  const h = harness(() => response({ error: 'upstream_unavailable' }, 503));
  await error(await h.worker.fetch(request('refresh'), env), 'upstream_unavailable');
});
for (const route of ['challenge', 'verify', 'refresh', 'logout']) test(`${route} needs bounded CSRF before dispatch`, async () => {
  const h = harness();
  const missing = request(route); missing.headers.delete('X-Domino-CSRF');
  await error(await h.worker.fetch(missing, env), 'csrf_invalid');
  for (const value of ['', `${csrf}, ${csrf}`, 'x'.repeat(44), 'x'.repeat(42), `"${csrf}"`]) {
    await error(await h.worker.fetch(request(route, { headers: { 'X-Domino-CSRF': value } }), env), 'csrf_invalid');
  }
  assert.equal(h.calls.length, 0);
});
for (const cookie of [`__Host-domino-session=${token}; __Host-domino-session=${token}`,
  `__Host-domino-preauth=${preauth}; __Host-domino-preauth=${preauth}`,
  `__Host-domino-session="${token}"`, `__Host-domino-session=${'%73'.repeat(43)}`,
  '__Host-domino-session', '__Host-domino-session=', `__Host-domino-session=${token}, unrelated=secret`,
  `unrelated=${'x'.repeat(8193)}`]) test(`ambiguous/oversized credential is rejected (${cookie.slice(0, 50)})`, async () => {
  const h = harness();
  await error(await h.worker.fetch(request('bootstrap', { headers: { Cookie: cookie } }), env), 'invalid_request');
  assert.equal(h.calls.length, 0);
});

for (const [route, body] of [
  ['bootstrap', '{"tenant":"someone"}'], ['logout', '{"sessionId":"someone"}'],
  ['bootstrap', '[]'], ['bootstrap', '{"x":1,"x":2}'], ['bootstrap', '{"__proto__":{}}'],
  ['challenge', `{"address":"${address}","chainId":4663,"chainId":4663}`],
  ['challenge', `{"address":"${address}","chainId":4663.0}`],
  ['challenge', `{"address":"${address}","chainId":4.663e3}`],
  ['challenge', JSON.stringify({ address, chainId: '4663' })],
  ['challenge', JSON.stringify({ address, chainId: 1 })],
  ['verify', JSON.stringify({ ...payloads.verify, message: 'é'.repeat(1025) })],
  ['verify', JSON.stringify({ ...payloads.verify, message: '\ud800' })],
  ['verify', JSON.stringify({ ...payloads.verify, signature: `0x${'1'.repeat(128)}` })],
  ['verify', JSON.stringify({ ...payloads.verify, signature: `0x${'1'.repeat(130)}\n` })],
]) test(`strict input contract rejects ${route} ${body.slice(0, 55)}`, async () => {
  const h = harness();
  await error(await h.worker.fetch(request(route, { body }), env), 'invalid_request');
  assert.equal(h.calls.length, 0);
});
for (const headers of [{ 'Content-Type': 'text/plain' }, { 'Content-Encoding': 'gzip' },
  { 'Content-Type': 'application/json; charset=latin1' }]) test(`encoded/non-JSON request ${JSON.stringify(headers)}`, async () => {
  const h = harness();
  await error(await h.worker.fetch(request('bootstrap', { headers }), env), 'json_required');
  assert.equal(h.calls.length, 0);
});
test('streamed body has a byte cap regardless of Content-Length', async () => {
  const h = harness();
  for (const headers of [{}, { 'Content-Length': '2' }]) {
    await error(await h.worker.fetch(request('bootstrap', { headers, body: ' '.repeat(SESSION_LIMITS.requestBytes + 1) }), env), 'request_too_large');
  }
  await error(await h.worker.fetch(request('bootstrap', { headers: { 'Content-Length': '8193' } }), env), 'request_too_large');
  assert.equal(h.calls.length, 0);
});
test('invalid UTF8 body is not repaired into a signed message', async () => {
  const h = harness();
  await error(await h.worker.fetch(request('bootstrap', { body: new Uint8Array([0xc3, 0x28]) }), env), 'invalid_request');
  assert.equal(h.calls.length, 0);
});

for (const [code, status] of Object.entries(ERROR_STATUS_BY_CODE)) test(`finite error ${code} is safe and sets no cookies`, async () => {
  const h = harness(() => response({ error: code }, status, { 'Set-Cookie': 'evil=1' }));
  await error(await h.worker.fetch(request(), env), code);
});
for (const body of [
  { ...envelopes.me, secret: 'private' }, { ...envelopes.me, credentials: { session: token } },
  { ...envelopes.me, result: { ...loggedIn, sessionToken: token } },
  { ...envelopes.me, result: { ...loggedIn, owner: { address, chainId: 1 } } },
  { ...envelopes.me, result: { ...loggedIn, authenticated: false } },
  { ...envelopes.me, result: { ...loggedIn, expiresAt: '2026-02-30T10:00:00Z' } },
  { ...envelopes.me, result: { ...loggedIn, validation: { ...loggedIn.validation, method: 'erc1271' } } },
  { ...envelopes.me, result: { ...loggedIn, validation: { ...loggedIn.validation, blockNumber: String(2n ** 256n) } } },
  { ...envelopes.me, result: { ...loggedIn, csrfToken: csrf + '\n' } },
]) test(`malformed success never leaks credentials: ${JSON.stringify(body).slice(0, 65)}`, async () => {
  const h = harness(() => response(body));
  await error(await h.worker.fetch(request('me'), env), 'upstream_contract_mismatch');
});
test('unknown/internal errors are replaced, never forwarded', async () => {
  for (const [body, status] of [[{ error: 'sql-password-secret' }, 503], [{ error: 'invalid_signature', detail: 'secret' }, 401],
    [{ error: 'invalid_signature' }, 200], [{ error: 'upstream_unavailable' }, 403]]) {
    const h = harness(() => response(body, status));
    await error(await h.worker.fetch(request(), env), status === 200 ? 'upstream_contract_mismatch' : 'upstream_unavailable');
  }
});
test('upstream redirects/HTML never follow or become authenticated responses', async () => {
  for (const output of [response('', 302, { Location: 'https://evil.invalid' }),
    response('<html>login</html>', 200, { 'Content-Type': 'text/html' })]) {
    const h = harness(() => output);
    await error(await h.worker.fetch(request(), env), 'upstream_unavailable');
    assert.equal(h.calls.length, 1);
  }
});
test('upstream duplicate keys, oversized output and compression fail closed', async () => {
  for (const output of [response('{"result":{},"result":{},"credentials":{}}'),
    response('x'.repeat(SESSION_LIMITS.responseBytes + 1)), response(envelopes.bootstrap, 200, { 'Content-Encoding': 'gzip' })]) {
    const h = harness(() => output);
    await error(await h.worker.fetch(request(), env), 'upstream_invalid_response');
  }
});
test('version mismatch leaves browser cookie untouched', async () => {
  const h = harness(() => response(envelopes.bootstrap, 200, { 'X-Domino-Session-Contract': '1.0.0' }));
  await error(await h.worker.fetch(request(), env), 'upstream_contract_mismatch');
});
test('missing trusted connection IP cannot use a browser-supplied account or IP', async () => {
  const h = harness(undefined, null);
  await error(await h.worker.fetch(request('bootstrap', { headers: { 'X-Domino-Client-Id': '203.0.113.7' } }), env), 'upstream_unavailable');
  assert.equal(h.calls.length, 0);
});
test('request cancellation stops an upstream ignoring AbortSignal', async () => {
  const controller = new AbortController();
  const h = harness(() => { controller.abort(); return new Promise(() => {}); });
  await error(await h.worker.fetch(request('bootstrap', { signal: controller.signal }), env), 'request_timeout');
});
test('body deadline cancels a stalled upload without dispatch', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let cancelled = false;
  const body = new ReadableStream({ cancel() { cancelled = true; } });
  const h = harness();
  const pending = h.worker.fetch(request('bootstrap', { body }), env);
  context.mock.timers.tick(SESSION_LIMITS.bodyMs + 1);
  await error(await pending, 'request_timeout');
  assert.equal(h.calls.length, 0);
  assert.equal(cancelled, true);
});
test('shared contract treats chain identity and message lengths strictly', () => {
  assert.equal(validateRequest('challenge', { address, chainId: 4663 }), true);
  assert.equal(validateRequest('challenge', { address, chainId: true }), false);
  assert.equal(validateResponse('verify', loggedIn), true);
  assert.equal(validateEnvelope('verify', envelopes.verify), true);
  assert.equal(validateEnvelope('challenge', envelopes.verify), false);
});

test('an already cancelled me request cannot dispatch to auth', async () => {
  const controller = new AbortController(); controller.abort();
  const h = harness(() => new Promise(() => {}));
  await error(await h.worker.fetch(request('me', { signal: controller.signal }), env), 'request_timeout');
  assert.equal(h.calls.length, 0);
});
for (const chain of ['4663.00000000000000001', '4663.0', '4.663e3', '"4663"']) {
  test(`upstream noncanonical chain lexeme ${chain} cannot become authenticated`, async () => {
    const raw = JSON.stringify(envelopes.me).replace('"chainId":4663', `"chainId":${chain}`);
    const h = harness(() => response(raw));
    await error(await h.worker.fetch(request('me'), env), 'upstream_contract_mismatch');
  });
}
test('issued or existing bearer aliases never appear as public CSRF or message text', async () => {
  for (const route of ['bootstrap', 'verify', 'me']) {
    const body = structuredClone(envelopes[route]);
    body.result.csrfToken = route === 'bootstrap' ? preauth : token;
    const h = harness(() => response(body));
    await error(await h.worker.fetch(request(route, { headers: { Cookie: `__Host-domino-session=${token}` } }), env), 'upstream_contract_mismatch');
  }
  const body = structuredClone(envelopes.challenge); body.result.message += `\n${preauth}`;
  const h = harness(() => response(body));
  await error(await h.worker.fetch(request('challenge', { headers: { Cookie: `__Host-domino-preauth=${preauth}` } }), env), 'upstream_contract_mismatch');
  const alias = structuredClone(envelopes.verify); alias.credentials.session = csrf;
  const issued = harness(() => response(alias));
  await error(await issued.worker.fetch(request('verify'), env), 'upstream_contract_mismatch');
});
test('unversioned Access rejection is availability failure, not a wallet login result', async () => {
  const h = harness(() => new Response('{"error":"upstream_unavailable"}', { status: 403, headers: { 'Content-Type': 'application/json' } }));
  await error(await h.worker.fetch(request(), env), 'upstream_unavailable');
});
test('session upstream stall times out and cancels its eventual body', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let resolve, cancelled = false;
  const h = harness(() => new Promise((done) => { resolve = done; }));
  const pending = h.worker.fetch(request('me'), env);
  assert.equal(h.calls.length, 1);
  context.mock.timers.tick(SESSION_LIMITS.upstreamMs + 1);
  await error(await pending, 'upstream_timeout');
  assert.equal(h.calls[0].init.signal.aborted, true);
  resolve(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(cancelled, true);
});
test('session upstream response stream cannot exceed the shared fetch budget', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  let cancelled = false;
  const h = harness(() => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
    headers: { 'Content-Type': 'application/json', 'X-Domino-Session-Contract': CONTRACT_VERSION },
  }));
  const pending = h.worker.fetch(request('me'), env);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  context.mock.timers.tick(SESSION_LIMITS.upstreamMs + 1);
  await error(await pending, 'upstream_timeout');
  assert.equal(cancelled, true);
});
test('late synchronous upstream result cannot bypass the absolute session deadline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000 });
  const h = harness(() => { context.mock.timers.setTime(17000); return response(envelopes.me); });
  await error(await h.worker.fetch(request('me'), env), 'upstream_timeout');
});
