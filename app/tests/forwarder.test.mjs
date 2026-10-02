/**
 * The /api chain on Pages, one request at a time:
 *
 *   browser → functions/_middleware.ts (beta gate) → functions/api/[[path]].ts
 *           → forward() in functions/_lib/bridge.ts → service binding → Worker
 *
 * Two kinds of binding stand in for Cloudflare's:
 *   - recorders, which keep exactly what reached them, for the forwarder's own
 *     rules: whenever the forwarder refuses, no binding may have been called;
 *   - the real bridge Workers from bridge/src, each with the [vars] of its
 *     reviewed disabled config (#75: every flag "false", APP_ORIGIN
 *     https://domino.money), for the chain from end to end.
 *
 * globalThis.fetch is replaced before any Worker module loads, so every
 * Worker's default export holds the tripwire as its upstream transport. An
 * upstream request is recorded, and the chain tests and the last test in this
 * file fail on it. Nothing here enables a deployment: the F1V-C1 tests alone
 * build enabled Workers, in memory, with placeholder credentials and the
 * tripwire as their transport, and each is refused before any upstream call.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { beforeEach, test } from 'node:test';

const upstream = [];
globalThis.fetch = async (input) => {
  upstream.push(input instanceof Request ? input.url : String(input));
  throw new Error('the forwarder suite reached for an upstream');
};

// Imported only now: each default export captures globalThis.fetch as it loads.
const WORKERS = {
  setup: (await import('../../bridge/src/setup-release.mjs')).default,
  execution: (await import('../../bridge/src/execution-worker.mjs')).default,
  read: (await import('../../bridge/src/worker.mjs')).default,
  session: (await import('../../bridge/src/session-worker.mjs')).default,
  onboarding: (await import('../../bridge/src/onboarding-worker.mjs')).default,
  deposit: (await import('../../bridge/src/deposit-worker.mjs')).default,
  performance: (await import('../../bridge/src/performance-worker.mjs')).default,
};
const RUNTIME = {
  setup: await import('../../bridge/src/setup-release.mjs'),
  execution: await import('../../api-contracts/execution-v1/runtime.mjs'),
  read: await import('../../api-contracts/read-v1/runtime.mjs'),
  session: await import('../../api-contracts/session-v1/runtime.mjs'),
  onboarding: await import('../../api-contracts/onboarding-v1/runtime.mjs'),
  deposit: await import('../../api-contracts/deposit-v1/runtime.mjs'),
  performance: await import('../../api-contracts/performance-v2/runtime.mjs'),
};

const require = createRequire(import.meta.url);
const { onRequest: gate, LOGIN_PATH, CHAIN_ROUTE } = require('../.test-build/app/functions/_middleware.js');
const { onRequest: apiRoute } = require('../.test-build/app/functions/api/[[path]].js');
const { forward, PREVIEW_ORIGIN } = require('../.test-build/app/functions/_lib/bridge.js');

const ORIGIN = 'https://domino.money';
const PREVIEW = 'https://preview.domino-app-e65.pages.dev';
const PASSWORD = 'forwarder-suite-beta-password';
const GATE = { BETA_PASSWORD: PASSWORD, BETA_COOKIE_KEY: 'Rk7sV2mQx9Lp4TbN8cWy3ZdJ6hGa1FeU5oXiQwErTzB' };

/** The committed disabled configs, including the separately disabled read-v2 candidate. */
const DISABLED = {
  setup: { SETUP_WALLET_ENABLED: 'false' },
  execution: { EXECUTION_BRIDGE_ENABLED: 'false', APP_ORIGIN: ORIGIN, EXECUTION_GATEWAY_ORIGIN: 'https://vm-execution.domino.money' },
  performance: { PERFORMANCE_BRIDGE_ENABLED: 'false', APP_ORIGIN: ORIGIN, PERFORMANCE_GATEWAY_ORIGIN: 'https://vm-performance.domino.money' },
  read: {
    READ_BRIDGE_ENABLED: 'false',
    READ_V2_BRIDGE_ENABLED: 'false',
    READ_V3_BRIDGE_ENABLED: 'false',
    READ_V4_BRIDGE_ENABLED: 'false',
    READ_V5_BRIDGE_ENABLED: 'false',
    APP_ORIGIN: 'https://domino.money',
    GATEWAY_ORIGIN: 'https://vm-read.domino.money',
    ENABLED_READS: '',
    ENABLED_V2_READS: '',
    ENABLED_V3_READS: '',
    ENABLED_V4_READS: '',
    ENABLED_V5_READS: '',
  },
  session: {
    SESSION_BRIDGE_ENABLED: 'false',
    APP_ORIGIN: 'https://domino.money',
    SESSION_GATEWAY_ORIGIN: 'https://vm-session.domino.money',
  },
  onboarding: {
    ONBOARDING_BRIDGE_ENABLED: 'false',
    APP_ORIGIN: 'https://domino.money',
    ONBOARDING_GATEWAY_ORIGIN: 'https://vm-onboarding.domino.money',
  },
  deposit: {
    DEPOSIT_BRIDGE_ENABLED: 'false',
    APP_ORIGIN: 'https://domino.money',
    DEPOSIT_GATEWAY_ORIGIN: 'https://vm-deposit.domino.money',
  },
};

const PREAUTH = `__Host-domino-preauth=${'p'.repeat(43)}`;
const SESSION = `__Host-domino-session=${'s'.repeat(43)}`;
const CSRF = 'c'.repeat(43);

/** What this suite expects of each family, written out rather than read from the code under test. */
const FAMILY = {
  setup: { binding: 'SETUP_BRIDGE', service: 'domino-setup-bridge', contract: 'x-domino-setup-contract', csrf: false, cookie: null },
  execution: { binding: 'EXECUTION_BRIDGE', service: 'domino-execution-bridge', contract: 'x-domino-execution-contract', csrf: true, cookie: SESSION },
  performance: { binding: 'PERFORMANCE_BRIDGE', service: 'domino-performance-bridge', contract: 'x-domino-performance-contract', csrf: true, cookie: SESSION },
  read: { binding: 'READ_BRIDGE', service: 'domino-read-bridge', contract: 'x-domino-read-contract', csrf: false, cookie: null },
  session: {
    binding: 'SESSION_BRIDGE',
    service: 'domino-session-bridge',
    contract: 'x-domino-session-contract',
    csrf: true,
    cookie: `${PREAUTH}; ${SESSION}`,
  },
  onboarding: {
    binding: 'ONBOARDING_BRIDGE',
    service: 'domino-onboarding-bridge',
    contract: 'x-domino-onboarding-contract',
    csrf: true,
    cookie: SESSION,
  },
  deposit: {
    binding: 'DEPOSIT_BRIDGE',
    service: 'domino-deposit-bridge',
    contract: 'x-domino-deposit-contract',
    csrf: true,
    cookie: SESSION,
  },
};
const FAMILIES = ['read', 'session', 'onboarding', 'deposit', 'performance', 'execution', 'setup'];

/** A well-formed browser call per family, on a route each Worker really has. */
const ROUTE = {
  setup: { path: '/api/setup/v1/release', body: '{}' },
  execution: { path: '/api/execution/v1/list', body: '{}' },
  performance: { path: '/api/performance/v2/epochs', body: '{}' },
  read: { path: '/api/read/v1/pools', body: JSON.stringify({ token: `0x${'1'.repeat(40)}` }) },
  session: { path: '/api/session/v1/bootstrap', body: '{}' },
  onboarding: { path: '/api/onboarding/v1/position-preview', body: '{}' },
  deposit: { path: '/api/deposit/v1/create', body: '{}' },
};

/**
 * Pages, minus Cloudflare. The root middleware runs first; its next() goes to
 * functions/api/[[path]].ts when Pages routes the path there, and to the
 * static files otherwise, which answer with index.html and a 200 the way
 * Pages' fallback for a single-page app does.
 *
 * The route is the one wrangler 4.130.0 generates for that file, /api/:path*,
 * and its router matches it with path-to-regexp 6.3.0, with end: true and in
 * any case. API_ROUTE is that matcher's own regular expression, verbatim, as
 * pathToRegexp('/api/:path*', [], { end: true }) builds it. Every segment must
 * be non-empty: /api, /api/, /api/x/ and /API/... reach the file; /api//x,
 * /api/read/v1//capabilities, /api/x//, /apix and //api/... do not (a test
 * below pins these cases, as observed by running wrangler's own bundle of
 * these functions).
 */
const API_ROUTE = /^\/api(?:\/((?:[^\/#\?]+?)(?:\/(?:[^\/#\?]+?))*))?[\/#\?]?$/i;
let served = 0;
beforeEach(() => {
  served = 0;
});

function pages(request, env) {
  const next = async (passed) => {
    const onward = passed ?? request;
    if (API_ROUTE.test(new URL(onward.url).pathname)) return apiRoute({ request: onward, env });
    served += 1;
    return new Response('<!doctype html><title>app</title>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  };
  return gate({ request, env, next });
}

async function signIn() {
  const response = await gate({
    request: new Request(`${ORIGIN}${LOGIN_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN },
      body: `password=${encodeURIComponent(PASSWORD)}`,
    }),
    env: GATE,
    next: async () => assert.fail('login reached the app'),
  });
  assert.equal(response.status, 303);
  return response.headers.get('Set-Cookie').split(';')[0];
}
const BETA = await signIn();
assert.match(BETA, /^__Host-domino-beta=v1\./);

/**
 * An API call as a browser's fetch() makes it from a page on `origin`, as the
 * edge hands it to Pages: Host, Fetch Metadata, CF-Connecting-IP, the beta
 * cookie, and Origin plus a JSON body for anything but GET and HEAD. An extra
 * header set to null is removed.
 */
function call(path, { method = 'GET', body, origin = ORIGIN, cookie = BETA, headers = {} } = {}) {
  const url = `${origin}${path}`;
  const all = new Headers({
    Host: new URL(url).host,
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'CF-Connecting-IP': '203.0.113.9',
  });
  if (cookie) all.set('Cookie', cookie);
  if (body !== undefined) {
    all.set('Origin', origin);
    all.set('Content-Type', 'application/json');
    if (typeof body === 'string') all.set('Content-Length', String(Buffer.byteLength(body)));
  }
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) all.delete(name);
    else all.set(name, value);
  }
  return new Request(url, { method, headers: all, body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) });
}

/** A binding that keeps what reached it and answers `answer(request)`. */
function recorder(answer = () => Response.json({ ok: true })) {
  const calls = [];
  return {
    calls,
    binding: {
      async fetch(request) {
        calls.push({
          method: request.method,
          url: request.url,
          headers: Object.fromEntries(request.headers),
          body: request.body === null ? null : new Uint8Array(await request.arrayBuffer()),
        });
        return answer(request);
      },
    },
  };
}

/** One recorder per family, bound under the names Pages will use. */
function recorders(answer) {
  const bound = Object.fromEntries(FAMILIES.map((family) => [family, recorder(answer)]));
  const env = { ...GATE };
  for (const family of FAMILIES) env[FAMILY[family].binding] = bound[family].binding;
  return { bound, env, calls: () => FAMILIES.reduce((sum, family) => sum + bound[family].calls.length, 0) };
}

/** A service binding to a real Worker: it sees the forwarded request and its own env, nothing else. */
function workers() {
  const calls = [];
  const env = { ...GATE };
  for (const family of FAMILIES) {
    env[FAMILY[family].binding] = {
      fetch(request) {
        calls.push(`${family} ${request.method} ${request.url}`);
        return WORKERS[family].fetch(request, DISABLED[family]);
      },
    };
  }
  return { env, calls };
}

/** A refusal from the forwarder or the gate: JSON, and nothing that looks like a Worker's answer. */
async function refused(response, status, error) {
  assert.equal(response.status, status);
  assert.match(response.headers.get('Content-Type') ?? '', /^application\/json/);
  assert.deepEqual(await response.json(), { error });
  const worker = [...response.headers.keys()].filter((name) => name.startsWith('x-domino-'));
  assert.deepEqual(worker, [], 'a refusal carried an X-Domino-* header');
}

/** An answer from a real Worker: its contract header, and the error its runtime maps to that status. */
async function workerSaid(response, family, error) {
  assert.equal(response.headers.get(FAMILY[family].contract), RUNTIME[family].CONTRACT_VERSION, `${family} contract header`);
  assert.equal(response.status, RUNTIME[family].ERROR_STATUS_BY_CODE[error], `${family} status for ${error}`);
  assert.deepEqual(await response.json(), { error });
}

// ---------------------------------------------------------------------------
// The whole chain, with the real Workers and their reviewed disabled config.
// ---------------------------------------------------------------------------

test('the real read Worker, disabled, answers capabilities through the whole chain without an upstream call', async () => {
  const { env, calls } = workers();
  const response = await pages(call('/api/read/v1/capabilities'), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-domino-read-contract'), RUNTIME.read.CONTRACT_VERSION);
  assert.deepEqual(await response.json(), {
    contractVersion: RUNTIME.read.CONTRACT_VERSION,
    dataMode: 'disabled',
    chainId: 4663,
    enabledReads: [],
    walletAuthentication: false,
    privateAccounts: false,
    ownerTransactions: false,
    automation: false,
  });
  assert.deepEqual(calls, ['read GET https://domino.money/api/read/v1/capabilities']);
  assert.equal(served, 0);
  assert.deepEqual(upstream, []);
});

test('each real Worker, disabled, refuses a well-formed browser call as route_not_available, calling nothing upstream', async () => {
  const { env, calls } = workers();
  for (const family of FAMILIES) {
    const { path, body } = ROUTE[family];
    const response = await pages(call(path, { method: 'POST', body, headers: { 'X-Domino-CSRF': CSRF } }), env);
    // route_not_available, not origin_not_allowed: the Worker's browser checks
    // passed on what the forwarder forwarded (URL, Origin, Fetch Metadata, Host).
    await workerSaid(response, family, 'route_not_available');
  }
  await workerSaid(await pages(call('/api/session/v1/me'), env), 'session', 'route_not_available');
  assert.equal(calls.length, FAMILIES.length + 1);
  assert.equal(served, 0);
  assert.deepEqual(upstream, []);
});

test('the real Workers run their own browser checks on the forwarded headers', async () => {
  const { env } = workers();
  const variants = {
    'a cross-site request': { 'Sec-Fetch-Site': 'cross-site' },
    'a navigation': { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-User': '?1' },
    'another origin': { Origin: 'https://evil.example' },
  };
  for (const family of FAMILIES) {
    for (const [label, headers] of Object.entries(variants)) {
      const { path, body } = ROUTE[family];
      const response = await pages(call(path, { method: 'POST', body, headers }), env);
      assert.equal(response.headers.get(FAMILY[family].contract), RUNTIME[family].CONTRACT_VERSION, `${family}: ${label}`);
      await workerSaid(response, family, 'origin_not_allowed');
    }
  }
  assert.deepEqual(upstream, []);
});

test('the Worker sees the original URL: a query string reaches the real read Worker, which refuses it', async () => {
  const { env, calls } = workers();
  await workerSaid(await pages(call('/api/read/v1/capabilities?refresh=1'), env), 'read', 'route_not_available');
  assert.deepEqual(calls, ['read GET https://domino.money/api/read/v1/capabilities?refresh=1']);
  assert.deepEqual(upstream, []);
});

test('a preview or pages.dev host never reaches a Worker, even with every binding in place', async () => {
  const { env, calls } = workers();
  const hosts = [
    'https://domino-app-e65.pages.dev',
    'https://abc123de.domino-app-e65.pages.dev',
    'https://preview.domino-app-e65.pages.dev',
    'http://domino.money',
    'https://domino.money:8443',
  ];
  for (const origin of hosts) {
    for (const family of FAMILIES) {
      const { path, body } = ROUTE[family];
      await refused(await pages(call(path, { method: 'POST', body, origin }), env), 404, 'not_found');
    }
    await refused(await pages(call('/api/read/v1/capabilities', { origin }), env), 404, 'not_found');
  }
  assert.deepEqual(calls, []);
  assert.equal(served, 0);
  assert.deepEqual(upstream, []);
});

test('the origin is checked before the binding: a preview host without bindings gets 404, not 503', async () => {
  for (const family of FAMILIES) {
    const { path, body } = ROUTE[family];
    const response = await pages(call(path, { method: 'POST', body, origin: 'https://domino-app-e65.pages.dev' }), GATE);
    await refused(response, 404, 'not_found');
  }
});

// The named preview has an explicit public-read alias, not another entrance
// to session or financial Workers. The original browser checks happen before
// its request can be translated to the read Worker's canonical origin.
test('the preview alias is one exact HTTPS origin and an exact opt-in', async () => {
  assert.equal(PREVIEW_ORIGIN, PREVIEW);
  const { env, calls } = recorders();
  for (const value of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true ', true, 1]) {
    await refused(await pages(call('/api/read/v1/capabilities', { origin: PREVIEW }), {
      ...env, PREVIEW_PUBLIC_READS: value,
    }), 404, 'not_found');
  }
  assert.equal(calls(), 0);
});

test('preview capabilities in every public read version reach the real Worker without a fabricated Origin', async () => {
  const { env, calls } = workers();
  env.PREVIEW_PUBLIC_READS = 'true';
  for (const version of [1, 2, 3, 4, 5]) {
    const path = `/api/read/v${version}/capabilities`;
    const response = await pages(call(path, { origin: PREVIEW }), env);
    assert.equal(response.status, 200, path);
    assert.ok(response.headers.get('x-domino-read-contract'), path);
    const body = await response.json();
    assert.equal(body.dataMode, 'disabled');
    assert.equal(body.chainId, 4663);
    assert.deepEqual(body.enabledReads, []);
    assert.equal(body.walletAuthentication, false);
    assert.equal(body.ownerTransactions, false);
  }
  assert.deepEqual(calls, [1, 2, 3, 4, 5].map(version => `read GET ${ORIGIN}/api/read/v${version}/capabilities`));
  assert.deepEqual(upstream, []);
});

test('preview public POSTs preserve method, bytes, query and contract while translating only the vetted origin', async () => {
  const paths = [
    '/api/read/v1/pools', '/api/read/v2/pool-market', '/api/read/v3/overview',
    '/api/read/v4/sequence-snapshot', '/api/read/v5/featured-pools',
  ];
  for (const path of paths) {
    const { binding, calls } = recorder();
    const body = '{ "token": "0x1111111111111111111111111111111111111111" }\n';
    const response = await pages(call(`${path}?unchanged=1`, {
      method: 'POST', body, origin: PREVIEW,
      headers: { 'X-Domino-Read-Contract': 'test-contract', 'Content-Length': String(Buffer.byteLength(body)) },
    }), { ...GATE, PREVIEW_PUBLIC_READS: 'true', READ_BRIDGE: binding });
    assert.equal(response.status, 200, path);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${ORIGIN}${path}?unchanged=1`);
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers.host, 'domino.money');
    assert.equal(calls[0].headers.origin, ORIGIN);
    assert.equal(calls[0].headers['x-domino-read-contract'], 'test-contract');
    assert.equal(calls[0].headers['content-length'], String(Buffer.byteLength(body)));
    assert.equal(new TextDecoder().decode(calls[0].body), body);
  }
});

test('preview POST origin translation passes the real read Worker and queries still get its own refusal', async () => {
  const { env, calls } = workers();
  env.PREVIEW_PUBLIC_READS = 'true';
  await workerSaid(await pages(call(ROUTE.read.path, {
    method: 'POST', body: ROUTE.read.body, origin: PREVIEW,
  }), env), 'read', 'route_not_available');
  await workerSaid(await pages(call('/api/read/v1/capabilities?refresh=1', {
    origin: PREVIEW, headers: { Origin: PREVIEW },
  }), env), 'read', 'route_not_available');
  assert.deepEqual(calls, [
    `read POST ${ORIGIN}${ROUTE.read.path}`,
    `read GET ${ORIGIN}/api/read/v1/capabilities?refresh=1`,
  ]);
  assert.deepEqual(upstream, []);
});

test('enabled preview keeps every private family shut even if every binding is accidentally present', async () => {
  const { env, calls } = recorders();
  env.PREVIEW_PUBLIC_READS = 'true';
  for (const family of FAMILIES.filter(name => name !== 'read')) {
    const { path, body } = ROUTE[family];
    await refused(await pages(call(path, { method: 'POST', body, origin: PREVIEW }), env), 404, 'not_found');
  }
  for (const path of ['/api/session/v1/me', '/api/other/v1/x', '/api/read/v6/capabilities', '/api/read/v1//capabilities']) {
    await refused(await pages(call(path, { origin: PREVIEW }), env), 404, 'not_found');
  }
  assert.equal(calls(), 0);
});

test('preview opt-in never admits other pages.dev, hash, lookalike, insecure or port-bearing origins', async () => {
  const { env, calls } = recorders();
  env.PREVIEW_PUBLIC_READS = 'true';
  for (const origin of [
    'https://domino-app-e65.pages.dev', 'https://abc123de.domino-app-e65.pages.dev',
    'https://other.domino-app-e65.pages.dev', 'https://preview.domino-app-e65.pages.dev.evil.example',
    'https://preview.domino-app-e65.pages.dev.', 'http://preview.domino-app-e65.pages.dev',
    'https://preview.domino-app-e65.pages.dev:8443',
  ]) {
    await refused(await pages(call('/api/read/v1/capabilities', { origin }), env), 404, 'not_found');
    await refused(await pages(call(ROUTE.read.path, { method: 'POST', body: ROUTE.read.body, origin }), env), 404, 'not_found');
  }
  assert.equal(calls(), 0);
});

test('preview original Host, Origin and Fetch Metadata are checked before the service sees canonical headers', async () => {
  const { env, calls } = recorders();
  env.PREVIEW_PUBLIC_READS = 'true';
  for (const headers of [
    { Host: 'domino.money' }, { Host: 'preview.domino-app-e65.pages.dev.evil.example' },
    { Origin: null }, { Origin: ORIGIN }, { Origin: 'https://evil.example' },
    { Origin: `${PREVIEW}.evil.example` }, { 'Sec-Fetch-Site': 'cross-site' },
    { 'Sec-Fetch-Site': 'same-site' }, { 'Sec-Fetch-Mode': 'navigate' },
    { 'Sec-Fetch-Dest': 'document' }, { 'Sec-Fetch-User': '?1' },
  ]) {
    await refused(await pages(call(ROUTE.read.path, {
      method: 'POST', body: ROUTE.read.body, origin: PREVIEW, headers,
    }), env), 403, 'origin_not_allowed');
  }
  for (const headers of [{ Origin: ORIGIN }, { Origin: 'https://evil.example' }, { Host: 'domino.money' }]) {
    await refused(await pages(call('/api/read/v1/capabilities', { origin: PREVIEW, headers }), env), 403, 'origin_not_allowed');
  }
  // No-Origin is an exception for exact capabilities GETs, never all GETs.
  for (const path of ['/api/read/v1/pools', '/api/read/v1/capabilities/']) {
    await refused(await pages(call(path, { origin: PREVIEW }), env), 403, 'origin_not_allowed');
  }
  assert.equal(calls(), 0);
});

test('preview accepts omitted optional browser metadata but does not synthesize an Origin on capabilities GET', async () => {
  const { binding, calls } = recorder();
  const response = await pages(call('/api/read/v1/capabilities', {
    origin: PREVIEW,
    headers: { Host: null, 'Sec-Fetch-Site': null, 'Sec-Fetch-Mode': null, 'Sec-Fetch-Dest': null },
  }), { ...GATE, PREVIEW_PUBLIC_READS: 'true', READ_BRIDGE: binding });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].headers.origin, undefined);
  assert.equal(calls[0].url, `${ORIGIN}/api/read/v1/capabilities`);
});

test('preview keeps the CF-Worker refusal and beta gate ahead of its public-read adapter', async () => {
  const { env, calls } = recorders();
  env.PREVIEW_PUBLIC_READS = 'true';
  await refused(await pages(call('/api/read/v1/capabilities', {
    origin: PREVIEW, headers: { 'CF-Worker': 'other-zone.example' },
  }), env), 403, 'worker_subrequest_refused');
  await refused(await pages(call('/api/read/v1/capabilities', { origin: PREVIEW, cookie: null }), env), 401, 'beta_access_required');
  assert.equal(calls(), 0);
});

test('preview public reads strip every cookie and unrelated credential, preserving only the edge client address', async () => {
  const { binding, calls } = recorder();
  const response = await pages(call(ROUTE.read.path, {
    method: 'POST', body: ROUTE.read.body, origin: PREVIEW,
    cookie: `${BETA}; ${PREAUTH}; ${SESSION}; unrelated=private-cookie`,
    headers: {
      Authorization: 'Bearer private-auth', 'CF-Access-Client-Id': 'private-id',
      'CF-Access-Client-Secret': 'private-secret', 'Cf-Access-Jwt-Assertion': 'private-jwt',
      'X-Domino-CSRF': CSRF, 'X-Domino-Browser-Origin': 'https://evil.example',
      'X-Forwarded-For': '198.51.100.7', 'X-Forwarded-Host': 'evil.example',
      Forwarded: 'host=evil.example', 'X-Real-IP': '198.51.100.8',
    },
  }), { ...GATE, PREVIEW_PUBLIC_READS: 'true', READ_BRIDGE: binding });
  assert.equal(response.status, 200);
  assert.equal(calls.length, 1);
  const headers = calls[0].headers;
  for (const name of [
    'cookie', 'authorization', 'cf-access-client-id', 'cf-access-client-secret', 'cf-access-jwt-assertion',
    'x-domino-csrf', 'x-domino-browser-origin', 'x-forwarded-for', 'x-forwarded-host', 'forwarded', 'x-real-ip',
  ]) assert.equal(headers[name], undefined, name);
  assert.equal(headers['cf-connecting-ip'], '203.0.113.9');
  assert.doesNotMatch(JSON.stringify(calls), /private-auth|private-id|private-secret|private-jwt|private-cookie/);
});

test('an admitted preview with no read binding reports bridge_unavailable, not an unsupported origin', async () => {
  await refused(await pages(call('/api/read/v1/capabilities', { origin: PREVIEW }), {
    ...GATE, PREVIEW_PUBLIC_READS: 'true',
  }), 503, 'bridge_unavailable');
});

// ---------------------------------------------------------------------------
// The gate still comes first.
// ---------------------------------------------------------------------------

test('without a valid beta cookie every /api call gets the gate 401 and nothing is forwarded', async () => {
  const { env, calls } = recorders();
  const paths = [
    ...FAMILIES.map((family) => ROUTE[family].path),
    '/api/session/v1/me',
    '/api/x',
    '/api',
    // An empty segment goes to the forwarder without Pages' route, but still
    // only after the gate.
    '/api//x',
    '/api/read/v1//capabilities',
  ];
  const jars = [null, `${PREAUTH}; ${SESSION}`, '__Host-domino-beta=v1.1.AAAA', `${BETA}; ${BETA}`];
  for (const path of paths) {
    for (const cookie of jars) {
      const response = await pages(call(path, { method: 'POST', body: '{}', cookie, headers: { 'CF-Worker': 'x.example' } }), env);
      await refused(response, 401, 'beta_access_required');
      await refused(await pages(call(path, { cookie }), env), 401, 'beta_access_required');
    }
  }
  assert.equal(calls(), 0);
  assert.equal(served, 0);
});

// ---------------------------------------------------------------------------
// Routing inside the forwarder.
// ---------------------------------------------------------------------------

test('each family goes to its own binding and to no other', async () => {
  for (const family of FAMILIES) {
    const { bound, env } = recorders();
    const { path, body } = ROUTE[family];
    const response = await pages(call(path, { method: 'POST', body }), env);
    assert.equal(response.status, 200);
    for (const other of FAMILIES) assert.equal(bound[other].calls.length, other === family ? 1 : 0, `${family} → ${other}`);
  }
  // The Worker, not the forwarder, decides whether a route under its prefix
  // exists, a trailing slash included: Pages routes that path to the forwarder.
  const { bound, env } = recorders();
  await pages(call('/api/read/v1/'), env);
  await pages(call('/api/read/v1/no-such-read'), env);
  await pages(call('/api/read/v1/capabilities/'), env);
  await pages(call('/api/read/v4/sequence-snapshot', { method: 'POST', body: '{}' }), env);
  assert.equal(bound.read.calls.length, 4, 'V4 goes to the same read binding');
  // 2026-09-26: read-v5, the featured pools list, too (its route file calls forward() as the catch-all does).
  await pages(call('/api/read/v5/featured-pools', { method: 'POST', body: '{}' }), env);
  await pages(call('/api/read/v5/capabilities'), env);
  assert.equal(bound.read.calls.length, 6, 'V5 goes to the same read binding');
  for (const other of FAMILIES.filter((family) => family !== 'read')) assert.equal(bound[other].calls.length, 0, other);
});

test("the stand-in routes /api as wrangler's bundle does: no path with an empty segment reaches functions/api/[[path]].ts", () => {
  const routed = ['/api', '/api/', '/api/x', '/api/x/', '/API/read/v1/capabilities', '/api/read/v1/capabilities/', '/api/a%2Fb'];
  const fallThrough = [
    '/api//',
    '/api//x',
    '/api/x//',
    '/API//READ',
    '/api/read/v1//capabilities',
    '/api/read/v1/capabilities//',
    '/apix',
    '//api/read/v1/capabilities',
    '/api%2Fread/v1/capabilities',
  ];
  for (const path of routed) assert.equal(API_ROUTE.test(path), true, path);
  for (const path of fallThrough) assert.equal(API_ROUTE.test(path), false, path);
});

test('an /api path no family owns gets a JSON 404 from the forwarder, never index.html', async () => {
  const { env, calls } = recorders();
  const paths = [
    '/api',
    '/api/',
    '/api/x',
    '/api/read',
    '/api/read/v1',
    '/api/read/v6/capabilities',
    '/api/read/v5',
    '/api/read//v5/featured-pools',
    '/api/read/v5//featured-pools',
    '/api/readx/v1/capabilities',
    '/api/sessions/v1/me',
    '/api/deposit/v1',
    '/API/read/v1/capabilities',
    '/api/Read/v1/capabilities',
    '/api/read/V1/capabilities',
    '/api/internal/read/v1/pools',
    // An empty segment. Pages' route does not match these, so the middleware
    // hands them to the forwarder itself, and none belongs to a family, not
    // even under a family's prefix.
    '/api//',
    '/api//x',
    '/api/x//',
    '/API//READ',
    '/api//read/v1/capabilities',
    '/api/read//v1/capabilities',
    '/api/read/v1//capabilities',
    '/api/read/v1/capabilities//',
    '/api/session/v1//me',
    '/api/session/v1//challenge',
    '/api/onboarding/v1//position-preview',
    '/api/deposit//v1/create',
    '/api/deposit/v1//create',
  ];
  for (const path of paths) {
    await refused(await pages(call(path), env), 404, 'not_found');
    await refused(await pages(call(path, { method: 'POST', body: '{}' }), env), 404, 'not_found');
  }
  for (const method of ['PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    await refused(await pages(call('/api//x', { method }), env), 404, 'not_found');
  }
  const head = await pages(call('/api//x', { method: 'HEAD' }), env);
  assert.equal(head.status, 404);
  assert.match(head.headers.get('Content-Type') ?? '', /^application\/json/);
  assert.equal(calls(), 0);
  assert.equal(served, 0, 'an /api path was answered with the app');
});

// 2026-10-01 (RPC-SPEC §2.1, §2.7): Domino's own chain routes. Pages routes their six paths to their own functions
// (functions/api/{owned,fees,automation,chain}/…, ahead of the catch-all: tests/owned.test.mjs pins wrangler's order),
// which answer from Domino's own node (functions/_lib/chainRoutes.ts). No bridge family owns them: the forwarder alone
// refuses them, and no binding is ever asked, whatever the request.
test('Domino’s own chain routes are no bridge family’s: their own functions answer them past the gate, with no cookie and no binding', async () => {
  const { env, calls } = recorders();
  const files = {
    '/api/owned/v2/positions': ['owned/v2/positions', 400, { error: 'invalid_request' }],
    '/api/fees/v1/state': ['fees/v1/state', 400, { v: 1, error: 'bad_request' }],
    // Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the ledger route, in place of the fees replay's /logs.
    '/api/fees/v2/ledger': ['fees/v2/ledger', 400, { v: 1, error: 'bad_request' }],
    '/api/automation/v1/state': ['automation/v1/state', 400, { error: 'invalid_request' }],
    '/api/automation/v1/record': ['automation/v1/record', 400, { v: 1, error: 'bad_request' }],
    '/api/chain/v1/simulate': ['chain/v1/simulate', 404, { v: 1, error: 'not_enabled' }],
  };
  const log = console.log;
  console.log = () => {};
  try {
    for (const [path, [file, status, body]] of Object.entries(files)) {
      assert.equal(CHAIN_ROUTE.test(path), true, path);
      await refused(await forward(call(path, { method: 'POST', body: '{}' }), env), 404, 'not_found');
      const { onRequest } = require(`../.test-build/app/functions/api/${file}.js`);
      const handed = [];
      const answered = await gate({ request: call(path, { method: 'POST', body: '{}' }), env, next: async (passed) => (handed.push(passed), onRequest({ request: passed, env })) });
      assert.equal(handed.length, 1, path);
      assert.equal(handed[0].headers.get('Cookie'), null, `${path}: no cookie past the gate`);
      assert.equal(answered.status, status, path);
      assert.deepEqual(await answered.json(), body, path);
      apiHeaders(answered, path, path);
    }
  } finally {
    console.log = log;
  }
  assert.equal(calls(), 0, 'no binding was asked');
  assert.deepEqual(upstream, []);
});

// ---------------------------------------------------------------------------
// Bindings: missing, wrong, failing.
// ---------------------------------------------------------------------------

test('a missing binding gives 503 bridge_unavailable and calls nothing else', async () => {
  for (const family of FAMILIES) {
    const { bound, env, calls } = recorders();
    delete env[FAMILY[family].binding];
    const { path, body } = ROUTE[family];
    await refused(await pages(call(path, { method: 'POST', body }), env), 503, 'bridge_unavailable');
    assert.equal(calls(), 0);
    assert.equal(bound[family].calls.length, 0);
  }
});

test('anything that is not a service binding gives 503 bridge_unavailable', async () => {
  const wrong = ['domino-read-bridge', '', 0, 42, true, null, [], {}, { fetch: 'domino-read-bridge' }, { fetch: true }, () => Response.json({})];
  for (const family of FAMILIES) {
    for (const value of wrong) {
      const { path, body } = ROUTE[family];
      const response = await pages(call(path, { method: 'POST', body }), { ...GATE, [FAMILY[family].binding]: value });
      await refused(response, 503, 'bridge_unavailable');
    }
  }
});

test('a binding that throws, rejects or answers no Response gives 503 bridge_unavailable', async () => {
  const failing = {
    throws: { fetch: () => { throw new Error('binding broke'); } },
    rejects: { fetch: async () => { throw new Error('binding broke'); } },
    'answers undefined': { fetch: async () => undefined },
    'answers text': { fetch: async () => 'ok' },
    'answers a lookalike': { fetch: async () => ({ status: 200, headers: new Headers(), body: null }) },
  };
  for (const family of FAMILIES) {
    for (const [label, binding] of Object.entries(failing)) {
      const { path, body } = ROUTE[family];
      const response = await pages(call(path, { method: 'POST', body }), { ...GATE, [FAMILY[family].binding]: binding });
      assert.equal(response.status, 503, `${family}: ${label}`);
      await refused(response, 503, 'bridge_unavailable');
    }
  }
});

// ---------------------------------------------------------------------------
// What the Worker receives.
// ---------------------------------------------------------------------------

/** Headers a browser, a proxy or an attacker may add, none of which a Worker may see. */
const NEVER = {
  Authorization: 'Bearer stolen',
  'Proxy-Authorization': 'Basic c3RvbGVu',
  Accept: 'application/json',
  'Accept-Encoding': 'gzip, br',
  'Accept-Language': 'en',
  'User-Agent': 'Mozilla/5.0',
  Referer: 'https://domino.money/',
  'X-Forwarded-For': '198.51.100.1',
  'X-Forwarded-Host': 'evil.example',
  'X-Forwarded-Proto': 'http',
  'X-Real-IP': '198.51.100.2',
  'True-Client-IP': '198.51.100.3',
  Forwarded: 'for=198.51.100.4',
  Via: '1.1 proxy.example',
  'CF-Access-Client-Id': 'stolen-client-id',
  'CF-Access-Client-Secret': 'stolen-client-secret',
  'Cf-Access-Jwt-Assertion': 'eyJhbGciOiJSUzI1NiJ9.stolen.signature',
  'CF-Ray': '8f00000000000000-LHR',
  'CF-IPCountry': 'XX',
  'CF-Visitor': '{"scheme":"https"}',
  'CDN-Loop': 'cloudflare',
  'Content-Encoding': 'gzip',
  'Transfer-Encoding': 'chunked',
  'X-Domino-Session': 's'.repeat(43),
  'X-Domino-Preauth': 'p'.repeat(43),
  'X-Domino-Client-Id': '198.51.100.5',
  'X-Domino-Browser-Origin': 'https://domino.money',
  'X-Domino-Request-Id': 'forged',
  'X-Domino-Anything-Else': '1',
  'X-HTTP-Method-Override': 'DELETE',
  'X-Original-URL': '/internal/read/v1/pools',
  'X-Rewrite-URL': '/internal/read/v1/pools',
  Priority: 'u=1',
  TE: 'trailers',
};

test('the Worker receives an allowlisted header set, and nothing else', async () => {
  for (const family of FAMILIES) {
    const { bound, env } = recorders();
    const { path, body } = ROUTE[family];
    const contracts = Object.fromEntries(FAMILIES.map((other) => [FAMILY[other].contract, `${other}-version`]));
    const headers = {
      ...NEVER,
      ...contracts,
      'X-Domino-CSRF': CSRF,
      'Sec-Fetch-User': '?1',
      Cookie: `theme=dark; ${BETA}; ${PREAUTH}; ${SESSION}`,
    };
    const response = await pages(call(path, { method: 'POST', body, headers }), env);
    assert.equal(response.status, 200);
    const [seen] = bound[family].calls;
    const expected = {
      'cf-connecting-ip': '203.0.113.9',
      'content-length': String(Buffer.byteLength(body)),
      'content-type': 'application/json',
      host: 'domino.money',
      origin: 'https://domino.money',
      'sec-fetch-dest': 'empty',
      'sec-fetch-mode': 'cors',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-user': '?1',
      [FAMILY[family].contract]: `${family}-version`,
    };
    if (FAMILY[family].csrf) expected['x-domino-csrf'] = CSRF;
    if (FAMILY[family].cookie) expected.cookie = FAMILY[family].cookie;
    assert.deepEqual(seen.headers, expected, family);
  }
});

test('Content-Encoding and Transfer-Encoding never reach a Worker, which reads the body as the bytes it is given', async () => {
  for (const family of FAMILIES) {
    const { bound, env } = recorders();
    const { path, body } = ROUTE[family];
    const headers = { 'Content-Encoding': 'gzip', 'Transfer-Encoding': 'chunked' };
    await pages(call(path, { method: 'POST', body, headers }), env);
    const [seen] = bound[family].calls;
    assert.equal(seen.headers['content-encoding'], undefined, family);
    assert.equal(seen.headers['transfer-encoding'], undefined, family);
    assert.equal(new TextDecoder().decode(seen.body), body, family);
  }
});

test('each family gets only its own cookies, verbatim; the beta cookie never leaves', async () => {
  const jar = [
    'theme=dark',
    BETA,
    PREAUTH,
    '__Host-domino-session-extra=1',
    SESSION,
    '__host-domino-session=lowercase',
    'x=__Host-domino-session=inside-a-value',
  ].join('; ');
  for (const family of FAMILIES) {
    const { bound, env } = recorders();
    const { path, body } = ROUTE[family];
    await pages(call(path, { method: 'POST', body, cookie: jar }), env);
    const [seen] = bound[family].calls;
    assert.equal(seen.headers.cookie, FAMILY[family].cookie ?? undefined, family);
    assert.doesNotMatch(seen.headers.cookie ?? '', /domino-beta/, family);
  }
});

test('duplicate and malformed family cookies arrive as they were sent, so the Worker still refuses them', async () => {
  const jars = {
    duplicate: [`__Host-domino-session=A`, 'theme=dark', `__Host-domino-session=B`, BETA],
    'valueless part': ['__Host-domino-session', BETA],
    'spaced part': [`  __Host-domino-session = A  `, BETA],
  };
  const forwarded = {
    duplicate: '__Host-domino-session=A; __Host-domino-session=B',
    'valueless part': '__Host-domino-session',
    'spaced part': '__Host-domino-session = A',
  };
  for (const family of ['session', 'onboarding', 'deposit', 'performance']) {
    for (const [label, parts] of Object.entries(jars)) {
      const { bound, env } = recorders();
      const { path, body } = ROUTE[family];
      await pages(call(path, { method: 'POST', body, cookie: parts.join(';') }), env);
      assert.equal(bound[family].calls[0].headers.cookie, forwarded[label], `${family}: ${label}`);
    }
  }
  const { bound, env } = recorders();
  await pages(call(ROUTE.session.path, { method: 'POST', body: '{}', cookie: `${PREAUTH}; ${PREAUTH}; ${BETA}` }), env);
  assert.equal(bound.session.calls[0].headers.cookie, `${PREAUTH}; ${PREAUTH}`);
});

test('the read family gets no Cookie header at all, and a family without cookies of its own gets none', async () => {
  const { bound, env } = recorders();
  await pages(call('/api/read/v1/capabilities', { cookie: `${BETA}; ${PREAUTH}; ${SESSION}` }), env);
  assert.equal('cookie' in bound.read.calls[0].headers, false);
  await pages(call(ROUTE.session.path, { method: 'POST', body: '{}', cookie: `${BETA}; theme=dark` }), env);
  assert.equal('cookie' in bound.session.calls[0].headers, false);
  await pages(call(ROUTE.onboarding.path, { method: 'POST', body: '{}', cookie: `${PREAUTH}; ${BETA}` }), env);
  assert.equal('cookie' in bound.onboarding.calls[0].headers, false, 'onboarding must not see the preauth cookie');
});

test('CF-Connecting-IP is copied exactly, and nothing else can stand in for it', async () => {
  for (const ip of ['203.0.113.9', '2001:db8::7']) {
    const { bound, env } = recorders();
    const spoof = { 'CF-Connecting-IP': ip, 'X-Forwarded-For': '198.51.100.1', 'X-Real-IP': '198.51.100.2', 'True-Client-IP': '198.51.100.3' };
    await pages(call(ROUTE.session.path, { method: 'POST', body: '{}', headers: spoof }), env);
    const seen = bound.session.calls[0].headers;
    assert.equal(seen['cf-connecting-ip'], ip);
    for (const name of ['x-forwarded-for', 'x-real-ip', 'true-client-ip']) assert.equal(seen[name], undefined, name);
  }
  const { bound, env } = recorders();
  await pages(call(ROUTE.read.path, { method: 'POST', body: '{}', headers: { 'CF-Connecting-IP': null, 'X-Real-IP': '198.51.100.2' } }), env);
  assert.equal(bound.read.calls[0].headers['cf-connecting-ip'], undefined);
});

test('a request carrying CF-Worker is refused with 403 before any binding is looked at', async () => {
  for (const family of FAMILIES) {
    for (const zone of ['other-zone.example', 'domino.money', '']) {
      const { env, calls } = recorders();
      const { path, body } = ROUTE[family];
      const request = () => call(path, { method: 'POST', body, headers: { 'CF-Worker': zone } });
      await refused(await pages(request(), env), 403, 'worker_subrequest_refused');
      assert.equal(calls(), 0);
      // Refused the same way when the binding is missing: no binding state leaks.
      await refused(await pages(request(), GATE), 403, 'worker_subrequest_refused');
    }
  }
});

test("the Worker's answer comes back whole, Set-Cookie included", async () => {
  const cookies = [
    '__Host-domino-preauth=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0',
    `${SESSION}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=43200`,
  ];
  const { env } = recorders(
    () =>
      new Response('{"authenticated":true}', {
        status: 200,
        headers: [
          ['Content-Type', 'application/json; charset=utf-8'],
          ['X-Domino-Session-Contract', RUNTIME.session.CONTRACT_VERSION],
          ['X-Domino-Request-Id', 'request-1'],
          ...cookies.map((cookie) => ['Set-Cookie', cookie]),
        ],
      }),
  );
  const response = await pages(call('/api/session/v1/verify', { method: 'POST', body: '{}' }), env);
  assert.equal(response.status, 200);
  assert.deepEqual(response.headers.getSetCookie(), cookies);
  assert.equal(response.headers.get('X-Domino-Session-Contract'), RUNTIME.session.CONTRACT_VERSION);
  assert.equal(response.headers.get('X-Domino-Request-Id'), 'request-1');
  assert.deepEqual(await response.json(), { authenticated: true });
});

test('the Worker receives the original method, URL and body bytes', async () => {
  const path = '/api/deposit/v1/list?before=a%2Fb&limit=2';
  for (const method of ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE']) {
    const { bound, env } = recorders();
    const body = ['GET', 'HEAD'].includes(method) ? undefined : `{"method":"${method}","text":"é ☃"}`;
    const request = call(path, { method, body });
    const original = request.url;
    await pages(request, env);
    const [seen] = bound.deposit.calls;
    assert.equal(seen.method, method);
    assert.equal(seen.url, original);
    if (body === undefined) assert.equal(seen.body, null, method);
    else assert.equal(new TextDecoder().decode(seen.body), body, method);
  }
  const bytes = Uint8Array.from({ length: 256 }, (_, i) => i);
  const binary = recorders();
  await pages(call(ROUTE.onboarding.path, { method: 'POST', body: bytes }), binary.env);
  assert.deepEqual(binary.bound.onboarding.calls[0].body, bytes);
  const streamed = recorders();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"streamed":'));
      controller.enqueue(new TextEncoder().encode('true}'));
      controller.close();
    },
  });
  await pages(call(ROUTE.session.path, { method: 'POST', body: stream }), streamed.env);
  assert.equal(new TextDecoder().decode(streamed.bound.session.calls[0].body), '{"streamed":true}');
});

test('forward() on its own refuses with no-store: another origin, a path no family owns, an empty segment', async () => {
  const tripwire = { fetch: () => assert.fail('a binding was called') };
  const env = { READ_BRIDGE: tripwire, SESSION_BRIDGE: tripwire, ONBOARDING_BRIDGE: tripwire, DEPOSIT_BRIDGE: tripwire };
  const urls = [
    'https://domino-app-e65.pages.dev/api/read/v1/capabilities',
    'https://domino.money/api/other/v1/x',
    'https://domino.money/api/read/v1//capabilities',
    'https://domino.money/api/session/v1//me',
    'https://domino.money/api/onboarding/v1/status//',
    'https://domino.money/api/deposit/v1//create',
  ];
  for (const url of urls) {
    const response = await forward(new Request(url), env);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    await refused(response, 404, 'not_found');
  }
});

// ---------------------------------------------------------------------------
// How /api answers leave the middleware.
// ---------------------------------------------------------------------------

const { APP_CSP, API_CSP, LOGOUT_PATH } = require('../.test-build/app/functions/_middleware.js');

/**
 * The headers every /api answer past the gate must leave with. Changed on purpose 2026-09-28 (speed wave, item 13): a
 * public read (`path` under /api/read/) leaves with no-store alone, so the edge may compress it; every other /api answer
 * keeps no-transform.
 */
function apiHeaders(response, label, path = '') {
  // 2026-10-01 (RPC-SPEC §2.7): Domino's own chain routes leave as a public read does.
  assert.equal(response.headers.get('Cache-Control'), path.startsWith('/api/read/') || CHAIN_ROUTE.test(path) ? 'no-store' : 'no-store, no-transform', label);
  assert.equal(response.headers.get('Content-Security-Policy'), "default-src 'none'; frame-ancestors 'none'", label);
  assert.equal(API_CSP, "default-src 'none'; frame-ancestors 'none'");
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff', label);
  assert.equal(response.headers.get('X-Frame-Options'), 'DENY', label);
  assert.equal(response.headers.get('Strict-Transport-Security'), 'max-age=31536000', label);
  assert.equal(response.headers.get('Cross-Origin-Resource-Policy'), 'same-origin', label);
  assert.equal(response.headers.get('X-Robots-Tag'), 'noindex, nofollow', label);
  assert.match(response.headers.get('Vary') ?? '', /Cookie/, label);
}

test('every /api answer past the gate leaves with no-store, no-transform (no-store alone for a public read) and a CSP that renders nothing', async () => {
  const real = workers();
  const cacheable = recorders(
    () =>
      new Response('{}', {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=600', 'Content-Security-Policy': 'default-src *' },
      }),
  );
  const cases = {
    'a real Worker answer': ['/api/read/v1/capabilities', await pages(call('/api/read/v1/capabilities'), real.env)],
    'a real Worker refusal': [ROUTE.deposit.path, await pages(call(ROUTE.deposit.path, { method: 'POST', body: '{}' }), real.env)],
    'a Worker answer that asked to be cached': [ROUTE.session.path, await pages(call(ROUTE.session.path, { method: 'POST', body: '{}' }), cacheable.env)],
    'an unknown path': ['/api/x', await pages(call('/api/x'), real.env)],
    'the bare /api': ['/api', await pages(call('/api'), real.env)],
    // Not /api/read/: an upper-case path keeps no-transform.
    'an upper-case path': ['/API/read/v1/capabilities', await pages(call('/API/read/v1/capabilities'), real.env)],
    'a preview host': ['/api/read/v1/capabilities', await pages(call('/api/read/v1/capabilities', { origin: 'https://domino-app-e65.pages.dev' }), real.env)],
    'a Worker subrequest': ['/api/read/v1/capabilities', await pages(call('/api/read/v1/capabilities', { headers: { 'CF-Worker': 'x.example' } }), real.env)],
    'a missing binding': ['/api/read/v1/capabilities', await pages(call('/api/read/v1/capabilities'), GATE)],
    'an empty segment': ['/api//x', await pages(call('/api//x'), real.env)],
    'an empty segment under a family prefix': ['/api/read/v1//capabilities', await pages(call('/api/read/v1//capabilities'), real.env)],
  };
  for (const [label, [path, response]] of Object.entries(cases)) apiHeaders(response, label, path);
  assert.deepEqual(upstream, []);
});

test("the gate's own answers and the app's pages keep the headers they had", async () => {
  const { env } = recorders();
  const locked = await pages(call('/api/read/v1/capabilities', { cookie: null }), env);
  assert.equal(locked.status, 401);
  assert.equal(locked.headers.get('Cache-Control'), 'no-store');
  assert.equal(locked.headers.get('Content-Security-Policy'), "default-src 'none'; frame-ancestors 'none'");
  for (const path of ['/', '/apix', '//api/read/v1/capabilities']) {
    const page = await pages(call(path, { headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } }), env);
    assert.equal(page.status, 200, path);
    assert.equal(page.headers.get('Content-Security-Policy'), APP_CSP, path);
    assert.equal(page.headers.get('Cache-Control'), 'private, no-cache', path);
  }
  // Changed on purpose 2026-10-01 (platform workstream, D1): a path that names a file the deployment does not hold, which
  // Pages answers with the app's page, is a 404 that no cache keeps; /api.json is such a file, not an API path.
  const file = await pages(call('/api.json', { headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' } }), env);
  assert.equal(file.status, 404);
  assert.equal(file.headers.get('Cache-Control'), 'no-store');
  assert.equal(served, 4);
});

// ---------------------------------------------------------------------------
// Production hosts: CANONICAL_HOSTS_ONLY.
// ---------------------------------------------------------------------------

const FOREIGN = [
  'https://domino-app-e65.pages.dev',
  'https://abc123de.domino-app-e65.pages.dev',
  'https://preview.domino-app-e65.pages.dev',
  'https://main.domino-app-e65.pages.dev',
  'https://sub.domino.money',
  'https://domino.money.',
  'https://domino.money.evil.example',
  'https://www.domino.money.evil.example',
  'https://localhost',
  'https://127.0.0.1',
];

const loginPost = (origin) =>
  new Request(`${origin}${LOGIN_PATH}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin },
    body: `password=${encodeURIComponent(PASSWORD)}`,
  });

test('with CANONICAL_HOSTS_ONLY on, any other host gets a JSON 404 before configuration, login or cookie', async () => {
  const { env, calls } = recorders();
  env.CANONICAL_HOSTS_ONLY = 'true';
  for (const origin of FOREIGN) {
    const requests = {
      navigation: new Request(`${origin}/`, { headers: { 'Sec-Fetch-Mode': 'navigate', Accept: 'text/html' } }),
      asset: new Request(`${origin}/assets/index.js`),
      'authenticated API call': call('/api/read/v1/capabilities', { origin }),
      login: loginPost(origin),
      logout: new Request(`${origin}${LOGOUT_PATH}`, { method: 'POST', headers: { Origin: origin } }),
    };
    for (const [label, request] of Object.entries(requests)) {
      const response = await pages(request, env);
      assert.equal(response.headers.get('Set-Cookie'), null, `${origin} ${label}`);
      await refused(response, 404, 'not_found');
    }
    // Before the configuration too: a deployment missing its secrets still says 404 here.
    await refused(await pages(new Request(`${origin}/`), { CANONICAL_HOSTS_ONLY: 'true' }), 404, 'not_found');
  }
  assert.equal(calls(), 0);
  assert.equal(served, 0);
});

test('with it on, domino.money keeps the gate exactly as before and www still redirects to it', async () => {
  const { env, calls } = recorders();
  env.CANONICAL_HOSTS_ONLY = 'true';
  const page = await pages(new Request(`${ORIGIN}/`, { headers: { 'Sec-Fetch-Mode': 'navigate' } }), env);
  assert.equal(page.status, 401);
  assert.match(await page.text(), /Access password/);
  await refused(await pages(call('/api/read/v1/capabilities', { cookie: null }), env), 401, 'beta_access_required');
  const login = await pages(loginPost(ORIGIN), env);
  assert.equal(login.status, 303);
  assert.match(login.headers.get('Set-Cookie'), /^__Host-domino-beta=v1\./);
  const app = await pages(new Request(`${ORIGIN}/`, { headers: { 'Sec-Fetch-Mode': 'navigate', Cookie: BETA } }), env);
  assert.equal(app.status, 200);
  assert.equal(served, 1);
  assert.equal((await pages(call(ROUTE.read.path, { method: 'POST', body: '{}' }), env)).status, 200);
  assert.equal(calls(), 1);
  for (const path of ['/some/path?x=1', '/api/read/v1/capabilities']) {
    const redirect = await pages(new Request(`https://www.domino.money${path}`, { headers: { 'Sec-Fetch-Mode': 'navigate' } }), env);
    assert.equal(redirect.status, 301, path);
    assert.equal(redirect.headers.get('Location'), `https://domino.money${path}`);
  }
  assert.equal(calls(), 1);
  assert.equal(served, 1);
});

test('the host allowlist is off unless the variable is exactly "true", so previews keep their gate', async () => {
  const { env, calls } = recorders();
  for (const value of [undefined, '', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true ']) {
    const preview = { ...env, CANONICAL_HOSTS_ONLY: value };
    for (const origin of ['https://domino-app-e65.pages.dev', 'https://preview.domino-app-e65.pages.dev']) {
      const page = await pages(new Request(`${origin}/`, { headers: { 'Sec-Fetch-Mode': 'navigate' } }), preview);
      assert.equal(page.status, 401, `${JSON.stringify(value)} ${origin}`);
      assert.match(await page.text(), /Access password/);
      // Past the gate the forwarder's origin check still keeps the API shut.
      await refused(await pages(call('/api/read/v1/capabilities', { origin }), preview), 404, 'not_found');
    }
  }
  assert.equal(calls(), 0);
  assert.equal(served, 0);
});

// ---------------------------------------------------------------------------
// wrangler.toml: unchanged production bindings, and preview's public-read-only opt-in.
// ---------------------------------------------------------------------------

/**
 * The tables and keys of app/wrangler.toml, read with just enough TOML for
 * that one file: whole-line comments, [table] and [[array]] headers, and
 * key = value lines. Anything else fails the test rather than being skipped.
 */
function wranglerToml() {
  const { readFileSync } = require('node:fs');
  const text = readFileSync(new URL('../wrangler.toml', import.meta.url), 'utf8');
  const tables = [{ header: '(top level)', keys: {} }];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      tables.push({ header: line, keys: {} });
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*("[^"]*")$/.exec(line);
    assert.ok(pair, `wrangler.toml line not understood: ${raw}`);
    tables.at(-1).keys[pair[1]] = pair[2];
  }
  return tables;
}

test('wrangler.toml: preview gets its public-read opt-in, its setup release and their two bindings; production keeps all seven', () => {
  const tables = wranglerToml();
  // Each Pages environment declares its own vars/services. Nothing belongs
  // at the top level where an unrelated environment could inherit it.
  for (const { header } of tables.slice(1)) {
    assert.ok(['[env.production.vars]', '[[env.production.services]]', '[env.preview.vars]', '[[env.preview.services]]'].includes(header), `table ${header} is not allowed`);
  }
  for (const key of Object.keys(tables[0].keys)) {
    assert.ok(['name', 'pages_build_output_dir', 'compatibility_date', 'compatibility_flags'].includes(key), `top-level ${key}`);
  }
  const production = tables.filter(({ header }) => header === '[env.production.vars]');
  assert.equal(production.length, 1);
  // Changed on purpose 2026-10-02 (RPC-SPEC §11.4, rugged97's answer Q4: his node answers eth_simulateV1): the simulate
  // route is on in both environments, a value of the repository's (the owner deploys it), never a secret.
  assert.deepEqual(production[0].keys, { CANONICAL_HOSTS_ONLY: '"true"', LOCAL_RPC_SIMULATE: '"true"' });
  // Service bindings: one table per family, each naming a binding and a
  // Worker and nothing else (no entrypoint, no environment).
  const services = tables.filter(({ header }) => header === '[[env.production.services]]');
  assert.equal(services.length, FAMILIES.length);
  for (const { keys } of services) assert.deepEqual(Object.keys(keys).sort(), ['binding', 'service']);
  // Changed on purpose 2026-10-01 (platform workstream, H7): and the setup release, public deployment identities, named
  // in PREVIEW_FAMILIES and bound to production's own setup Worker (reached like the reads, translated).
  // Changed on purpose 2026-10-01 (the chain2 workstream, part B): and CHAIN2_PREVIEW, the middleware's own setting that
  // opens the page's CSP to the second chain's RPC in the preview (functions/_middleware.ts APP_CSP_CHAIN2). No
  // ELYSIUM_BRIDGE binding: rugged97's Worker for it is not deployed.
  assert.deepEqual(tables.filter(({ header }) => header === '[env.preview.vars]').map(({ keys }) => keys), [
    { PREVIEW_PUBLIC_READS: '"true"', PREVIEW_FAMILIES: '"setup"', CHAIN2_PREVIEW: '"true"', LOCAL_RPC_SIMULATE: '"true"' },
  ]);
  assert.deepEqual(tables.filter(({ header }) => header === '[[env.preview.services]]').map(({ keys }) => keys), [
    { binding: '"READ_BRIDGE"', service: '"domino-read-bridge"' },
    { binding: '"SETUP_BRIDGE"', service: '"domino-setup-bridge"' },
  ]);
  assert.ok(!Object.values(tables).some(({ keys }) => Object.values(keys).includes('"ELYSIUM_BRIDGE"')), 'no binding for a Worker that does not exist');
  assert.ok(!tables.filter(({ header }) => header.startsWith('[env.production')).some(({ keys }) => 'CHAIN2_PREVIEW' in keys), 'production never gets it');
});

test('the deploy scripts pin wrangler 4.130.0, whose Pages router the stand-in and onward() follow', async () => {
  // API_ROUTE above and onward() in functions/_middleware.ts follow the route
  // matching of wrangler 4.130.0 (path-to-regexp 6.3.0). Before this pin
  // moves, rebuild these functions with the new version, check which /api
  // paths reach functions/api/[[path]].ts, and update both.
  // Both deploy scripts go through scripts/release.mjs, which uploads the
  // recorded dist with the wrangler it pins, so the pin is asserted there:
  // its WRANGLER constant and the one command each deploy runs.
  const { readFileSync } = require('node:fs');
  const { scripts } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(scripts.deploy, 'node scripts/release.mjs deploy production');
  assert.equal(scripts['deploy:preview'], 'node scripts/release.mjs deploy preview');
  const { WRANGLER, deployCommand } = await import('../scripts/release.mjs');
  assert.equal(WRANGLER, 'wrangler@4.130.0');
  for (const target of ['preview', 'production']) {
    const command = ['npx', ...deployCommand(target, { gitHead: '0'.repeat(40) })].join(' ');
    assert.match(command, /^npx --yes wrangler@4\.130\.0 pages deploy \.\/dist\b/, target);
  }
});

/**
 * app/wrangler.toml as wrangler 4.130.0 reads it for each Pages environment,
 * through its own config reader: unstable_readConfig, the normalizing and
 * validating reader its Pages commands also run before their Pages-only
 * checks. It runs in a child process, so nothing wrangler loads can touch this
 * file's upstream tripwire, offline, with a placeholder token and account; it
 * never deploys. wrangler is web's dependency, pinned to the version the
 * deploy scripts run (scripts/release.mjs's WRANGLER).
 */
let wranglerRead;
function wrangler() {
  if (wranglerRead) return wranglerRead;
  const { spawnSync } = require('node:child_process');
  const { existsSync, readFileSync } = require('node:fs');
  const { fileURLToPath } = require('node:url');
  const web = JSON.parse(readFileSync(new URL('../../web/package.json', import.meta.url), 'utf8'));
  assert.equal({ ...web.dependencies, ...web.devDependencies }.wrangler, '4.130.0', "web/package.json's wrangler pin");
  const dir = fileURLToPath(new URL('../../web/node_modules/wrangler/', import.meta.url));
  assert.ok(existsSync(`${dir}package.json`), 'wrangler is missing: run npm --prefix web ci first');
  const script = [
    'const [dir, config] = process.argv.slice(1);',
    "const { version } = require(dir + 'package.json');",
    "const { unstable_readConfig } = require(dir + 'wrangler-dist/cli.js');",
    'const read = (env) => {',
    '  const c = unstable_readConfig({ config, env }, { hideWarnings: false });',
    '  return { name: c.name, targetEnvironment: c.targetEnvironment, vars: c.vars, services: c.services };',
    '};',
    // pagesDeploy: no environment, as `pages deploy` reads the file to find the project.
    "process.stdout.write(JSON.stringify({ version, production: read('production'), preview: read('preview'), pagesDeploy: read(undefined) }));",
  ].join('\n');
  const config = fileURLToPath(new URL('../wrangler.toml', import.meta.url));
  const run = spawnSync(process.execPath, ['-e', script, dir, config], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CLOUDFLARE_API_TOKEN: 'invalid-review-token',
      CLOUDFLARE_ACCOUNT_ID: '0'.repeat(32),
      WRANGLER_SEND_METRICS: 'false',
    },
  });
  assert.equal(run.status, 0, run.stderr);
  // No warning either: wrangler reports a key it does not know here.
  assert.equal(run.stderr, '');
  wranglerRead = JSON.parse(run.stdout);
  return wranglerRead;
}

test('wrangler 4.130.0 reads seven production Workers, and for preview only the read and setup Workers it enables', () => {
  const read = wrangler();
  assert.equal(read.version, '4.130.0');
  assert.equal(read.production.targetEnvironment, 'production');
  // Changed on purpose 2026-10-02 (RPC-SPEC §11.4): and the simulate route's switch, in both environments.
  assert.deepEqual(read.production.vars, { CANONICAL_HOSTS_ONLY: 'true', LOCAL_RPC_SIMULATE: 'true' });
  assert.deepEqual(
    read.production.services,
    FAMILIES.map((family) => ({ binding: FAMILY[family].binding, service: FAMILY[family].service })),
  );
  assert.equal(read.preview.targetEnvironment, 'preview');
  // Changed on purpose 2026-10-01 (the chain2 workstream, part B): and CHAIN2_PREVIEW, for the preview alone.
  assert.deepEqual(read.preview.vars, { PREVIEW_PUBLIC_READS: 'true', PREVIEW_FAMILIES: 'setup', CHAIN2_PREVIEW: 'true', LOCAL_RPC_SIMULATE: 'true' });
  assert.deepEqual(read.preview.services, [{ binding: 'READ_BRIDGE', service: 'domino-read-bridge' }, { binding: 'SETUP_BRIDGE', service: 'domino-setup-bridge' }]);
});

test("the binding names forward() looks up are exactly the names wrangler.toml binds, each to its family's Worker", async () => {
  const bound = Object.fromEntries(wrangler().production.services.map(({ binding, service }) => [binding, service]));
  const looked = [];
  for (const family of FAMILIES) {
    // An env that records every name forward() reads from it and holds nothing.
    const names = [];
    const env = new Proxy({}, { get: (_, name) => (names.push(name), undefined) });
    await refused(await forward(new Request(`${ORIGIN}${ROUTE[family].path}`), env), 503, 'bridge_unavailable');
    assert.equal(names.length, 1, `${family} read ${names.map(String).join(', ')}`);
    assert.equal(bound[names[0]], FAMILY[family].service, `${family} → ${String(names[0])} → a Worker`);
    looked.push(names[0]);
  }
  assert.deepEqual(looked.sort(), Object.keys(bound).sort());
});

test('both deploys target the Pages project wrangler.toml names, domino-app, and no doc calls domino-app-e65 anything but its pages.dev hostname', async () => {
  const { readFileSync } = require('node:fs');
  const { fileURLToPath } = require('node:url');
  // How wrangler 4.130.0's `pages deploy` picks the project: it reads the
  // config with no environment, then takes --project-name, else that name.
  // A name with no such project (8000007) is treated as a new project, so
  // renaming it to the pages.dev label would offer to create one and leave
  // domino.money as it was.
  const cli = readFileSync(fileURLToPath(new URL('../../web/node_modules/wrangler/wrangler-dist/cli.js', import.meta.url)), 'utf8');
  assert.ok(cli.includes('config2 = readPagesConfig({ ...args, config: configPath, env: void 0 });'), 'pages deploy reads the config with no environment');
  assert.ok(cli.includes('let projectName = args.projectName ?? config2?.name ?? cachedProjectName;'), 'pages deploy takes --project-name, else the config name');
  const { deployCommand } = await import('../scripts/release.mjs');
  for (const target of ['preview', 'production']) {
    assert.ok(!deployCommand(target, { gitHead: '0'.repeat(40) }).includes('--project-name'), `${target} passes no --project-name`);
  }
  const project = wrangler().pagesDeploy.name;
  assert.equal(project, 'domino-app');

  // Every doc names that project, and domino-app-e65 only ever as a hostname:
  // Cloudflare appended -e65 to the pages.dev label, not to the project.
  const offenders = [];
  for (const doc of ['app/README.md', 'FRONTEND_HANDOFF.md', 'TECH_STACK.md']) {
    const text = readFileSync(new URL(`../../${doc}`, import.meta.url), 'utf8');
    for (const [, named] of text.matchAll(/--project-name\s+([\w-]+)/g)) if (named !== project) offenders.push(`${doc}: --project-name ${named}`);
    for (const [, named] of text.matchAll(/Workers & Pages → `([^`]+)`/g)) if (named !== project) offenders.push(`${doc}: Workers & Pages → ${named}`);
    for (const hit of text.matchAll(/domino-app-e65(?!\.pages\.dev)/g)) {
      offenders.push(`${doc}: …${text.slice(Math.max(0, hit.index - 50), hit.index + 30).replace(/\s+/g, ' ')}…`);
    }
  }
  assert.deepEqual(offenders, []);

  // Where the README walks through a release, it says so in as many words
  // (compared with its line breaks as spaces: Markdown wraps anywhere).
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const release = readme.slice(readme.indexOf('**Deploying.**'), readme.indexOf('**After every Pages deploy')).replace(/\s+/g, ' ');
  assert.match(release, new RegExp(`the Pages project is \`${project}\``));
  assert.match(release, /`domino-app-e65\.pages\.dev` is only its hostname/);
});

/**
 * An environment as wrangler.toml deploys it: its vars, the gate's secrets,
 * and each declared binding bound to the real bridge Worker of that service
 * name, under its reviewed disabled config.
 */
function deployed(environment) {
  const { vars, services } = wrangler()[environment];
  const calls = [];
  const env = { ...GATE, ...vars };
  for (const { binding, service } of services) {
    const family = FAMILIES.find((name) => FAMILY[name].service === service);
    assert.ok(family, `${binding} names ${service}, which is no bridge Worker`);
    env[binding] = {
      fetch(request) {
        calls.push(`${service} ${request.method} ${request.url}`);
        return WORKERS[family].fetch(request, DISABLED[family]);
      },
    };
  }
  return { env, calls };
}

test('production as wrangler.toml binds it: every family reaches its own disabled Worker and gets its disabled answer, nothing upstream', async () => {
  const { env, calls } = deployed('production');
  const capabilities = await pages(call('/api/read/v1/capabilities'), env);
  assert.equal(capabilities.status, 200);
  assert.equal(capabilities.headers.get('x-domino-read-contract'), RUNTIME.read.CONTRACT_VERSION);
  const document = await capabilities.json();
  assert.equal(document.dataMode, 'disabled');
  assert.deepEqual(document.enabledReads, []);
  for (const family of FAMILIES) {
    const { path, body } = ROUTE[family];
    const response = await pages(call(path, { method: 'POST', body, headers: { 'X-Domino-CSRF': CSRF } }), env);
    await workerSaid(response, family, 'route_not_available');
  }
  await workerSaid(await pages(call('/api/session/v1/me'), env), 'session', 'route_not_available');
  assert.deepEqual(calls, [
    'domino-read-bridge GET https://domino.money/api/read/v1/capabilities',
    ...FAMILIES.map((family) => `${FAMILY[family].service} POST https://domino.money${ROUTE[family].path}`),
    'domino-session-bridge GET https://domino.money/api/session/v1/me',
  ]);
  assert.equal(served, 0);
  assert.deepEqual(upstream, []);
});

test('preview as wrangler.toml deploys it reaches only the read and setup Workers, from its exact named alias', async () => {
  const { env, calls } = deployed('preview');
  assert.deepEqual(Object.keys(env).filter((name) => name.endsWith('_BRIDGE')), ['READ_BRIDGE', 'SETUP_BRIDGE']);
  assert.equal(env.PREVIEW_PUBLIC_READS, 'true');
  assert.equal(env.PREVIEW_FAMILIES, 'setup');
  const capability = await pages(call('/api/read/v1/capabilities', { origin: PREVIEW }), env);
  assert.equal(capability.status, 200);
  assert.equal((await capability.json()).dataMode, 'disabled');
  await workerSaid(await pages(call(ROUTE.read.path, {
    method: 'POST', body: ROUTE.read.body, origin: PREVIEW,
  }), env), 'read', 'route_not_available');
  // 2026-10-01 (H7): the setup release, translated like the reads; the real setup Worker gives its disabled answer.
  const release = await pages(call('/api/setup/v1/release', { origin: PREVIEW }), env);
  assert.equal(release.status, 200);
  assert.deepEqual(await release.json(), { contractVersion: '1.0.0-rc.1', chainId: 4663, available: false, deployment: null });
  for (const family of FAMILIES.filter(name => name !== 'read' && name !== 'setup')) {
    const { path, body } = ROUTE[family];
    await refused(await pages(call(path, { method: 'POST', body, origin: PREVIEW }), env), 404, 'not_found');
  }
  for (const family of FAMILIES) {
    const { path, body } = ROUTE[family];
    await refused(await pages(call(path, {
      method: 'POST', body, origin: 'https://abc123de.domino-app-e65.pages.dev',
    }), env), 404, 'not_found');
  }
  await refused(await pages(call('/api/read/v1/capabilities', { origin: 'https://abc123de.domino-app-e65.pages.dev' }), env), 404, 'not_found');
  assert.deepEqual(calls, [
    `domino-read-bridge GET ${ORIGIN}/api/read/v1/capabilities`,
    `domino-read-bridge POST ${ORIGIN}${ROUTE.read.path}`,
    `domino-setup-bridge GET ${ORIGIN}/api/setup/v1/release`,
  ]);
  assert.equal(served, 0);
  assert.deepEqual(upstream, []);
});

// ---------------------------------------------------------------------------
// The gate's public-read step (#69) and the forwarder, together. The gate
// hands next() a copy of a public read with no Cookie header at all; that copy
// is what functions/api/[[path]].ts and forward() see, and what the read
// binding receives. Every other family goes on as the browser sent it and gets
// only its own cookies from forward().
// ---------------------------------------------------------------------------

/**
 * pages(), plus what the gate handed next() and what reached
 * functions/api/[[path]].ts. `handed` holds the request next() was given, or
 * undefined when it was called with none (the browser's request goes on).
 */
function tracedPages(request, env) {
  const handed = [];
  const routed = [];
  const next = async (passed) => {
    handed.push(passed);
    const onward = passed ?? request;
    if (API_ROUTE.test(new URL(onward.url).pathname)) {
      routed.push({ url: onward.url, cookie: onward.headers.get('Cookie') });
      return apiRoute({ request: onward, env });
    }
    served += 1;
    return new Response('<!doctype html><title>app</title>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  };
  return { response: gate({ request, env, next }), handed, routed };
}

const JAR = `theme=dark; ${BETA}; ${PREAUTH}; ${SESSION}`;

test('a signed-in capabilities read: gate → no Cookie header → [[path]].ts → forward() → READ_BRIDGE, with no cookie of any kind', async () => {
  const { bound, env, calls } = recorders();
  const traced = tracedPages(call('/api/read/v1/capabilities', { cookie: JAR }), env);
  const response = await traced.response;
  assert.equal(response.status, 200);
  // The gate handed on a request of its own, stripped of every cookie.
  assert.equal(traced.handed.length, 1);
  assert.ok(traced.handed[0] instanceof Request, 'the gate passed the browser request on unchanged');
  assert.equal(traced.handed[0].headers.get('Cookie'), null);
  // That request, not the browser's, is what the route file and forward() got.
  assert.deepEqual(traced.routed, [{ url: `${ORIGIN}/api/read/v1/capabilities`, cookie: null }]);
  // And the read binding received no Cookie header, and no credential under any name.
  assert.equal(calls(), 1);
  const [seen] = bound.read.calls;
  assert.equal('cookie' in seen.headers, false);
  for (const [name, value] of Object.entries(seen.headers)) {
    assert.doesNotMatch(value, /domino-beta|domino-session|domino-preauth|theme=dark/, `a cookie went on in ${name}`);
  }
  assert.equal(seen.method, 'GET');
  assert.equal(seen.url, `${ORIGIN}/api/read/v1/capabilities`);
  apiHeaders(response, 'signed-in capabilities read', '/api/read/v1/capabilities');
});

test('the same signed-in capabilities read reaches the real read Worker, disabled, and it answers', async () => {
  const { env, calls } = workers();
  const traced = tracedPages(call('/api/read/v1/capabilities', { cookie: JAR }), env);
  const response = await traced.response;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-domino-read-contract'), RUNTIME.read.CONTRACT_VERSION);
  assert.equal((await response.json()).dataMode, 'disabled');
  assert.equal(traced.handed[0]?.headers.get('Cookie'), null);
  assert.deepEqual(calls, ['read GET https://domino.money/api/read/v1/capabilities']);
  assert.deepEqual(upstream, []);
});

test('read-v2 uses the existing binding with no cookies and remains independently disabled', async () => {
  const { env, calls } = workers();
  const traced = tracedPages(call('/api/read/v2/capabilities', { cookie: JAR }), env);
  const response = await traced.response;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-domino-read-contract'), '2.0.0-rc.1');
  const data = await response.json();
  assert.equal(data.dataMode, 'disabled');
  assert.deepEqual(data.enabledReads, []);
  assert.equal(traced.handed[0]?.headers.get('Cookie'), null);
  assert.deepEqual(calls, ['read GET https://domino.money/api/read/v2/capabilities']);
  assert.deepEqual(upstream, []);
});

test('read-v3 uses the existing beta-gated binding and remains independently disabled', async () => {
  const { env, calls } = workers();
  const traced = tracedPages(call('/api/read/v3/capabilities', { cookie: JAR }), env);
  const response = await traced.response;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-domino-read-contract'), '3.0.0-rc.1');
  const data = await response.json();
  assert.equal(data.dataMode, 'disabled');
  assert.deepEqual(data.enabledReads, []);
  assert.equal(traced.handed[0]?.headers.get('Cookie'), null);
  assert.deepEqual(calls, ['read GET https://domino.money/api/read/v3/capabilities']);
  assert.deepEqual(upstream, []);
});

test('read-v5 uses the existing beta-gated binding and the committed config keeps it off', async () => {
  const { env, calls } = workers();
  const traced = tracedPages(call('/api/read/v5/featured-pools', {
    method: 'POST', body: '{}', cookie: JAR, headers: { 'X-Domino-Read-Contract': '1.0.0-rc.1' },
  }), env);
  const response = await traced.response;
  // route_not_available is what the app reads as "no served list": it keeps the embedded one.
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('x-domino-read-contract'), '1.0.0-rc.1');
  assert.deepEqual(await response.json(), { error: 'route_not_available' });
  assert.equal(traced.handed[0]?.headers.get('Cookie'), null);
  const capabilities = await (tracedPages(call('/api/read/v5/capabilities', { cookie: JAR }), env).response);
  assert.equal((await capabilities.json()).dataMode, 'disabled');
  assert.deepEqual(calls, ['read POST https://domino.money/api/read/v5/featured-pools', 'read GET https://domino.money/api/read/v5/capabilities']);
  assert.deepEqual(upstream, []);
});

test('read-v5 forwarding keeps the empty request and its version, and removes cookies and credentials', async () => {
  const { bound, env } = recorders();
  const traced = tracedPages(call('/api/read/v5/featured-pools', {
    method: 'POST', body: '{}', cookie: JAR,
    headers: { 'X-Domino-Read-Contract': '1.0.0-rc.1', Authorization: 'Bearer forbidden',
      'CF-Access-Client-Secret': 'forbidden', 'X-Domino-Client-Id': '192.0.2.99', 'X-Domino-CSRF': CSRF },
  }), env);
  assert.equal((await traced.response).status, 200);
  const [seen] = bound.read.calls;
  assert.equal(seen.url, `${ORIGIN}/api/read/v5/featured-pools`);
  assert.equal(new TextDecoder().decode(seen.body), '{}');
  assert.equal(seen.headers['x-domino-read-contract'], '1.0.0-rc.1');
  assert.equal(seen.headers['cf-connecting-ip'], '203.0.113.9');
  for (const name of ['cookie', 'authorization', 'cf-access-client-secret', 'x-domino-client-id', 'x-domino-csrf']) {
    assert.equal(name in seen.headers, false, name);
  }
});

test('read-v3 forwarding preserves selection and removes cookies and credentials', async () => {
  const { bound, env } = recorders();
  const body = JSON.stringify({ poolIds: [`0x${'a'.repeat(64)}`] });
  const traced = tracedPages(call('/api/read/v3/overview', {
    method: 'POST', body, cookie: JAR,
    headers: { 'X-Domino-Read-Contract': '3.0.0-rc.1', Authorization: 'Bearer forbidden',
      'CF-Access-Client-Secret': 'forbidden', 'X-Domino-Client-Id': '192.0.2.99' },
  }), env);
  assert.equal((await traced.response).status, 200);
  assert.equal(traced.handed[0]?.headers.get('Cookie'), null);
  const [seen] = bound.read.calls;
  assert.equal(seen.url, `${ORIGIN}/api/read/v3/overview`);
  assert.equal(new TextDecoder().decode(seen.body), body);
  assert.equal(seen.headers['x-domino-read-contract'], '3.0.0-rc.1');
  for (const name of ['cookie', 'authorization', 'cf-access-client-secret', 'x-domino-client-id']) {
    assert.equal(name in seen.headers, false, name);
  }
});

test('read-v2 POST preserves request bytes and version while discarding credentials at Pages', async () => {
  const { bound, env } = recorders();
  const body = JSON.stringify({ poolId: `0x${'a'.repeat(64)}` });
  const traced = tracedPages(call('/api/read/v2/pool-market', {
    method: 'POST', body, cookie: JAR,
    headers: { 'X-Domino-Read-Contract': '2.0.0-rc.1', Authorization: 'Bearer forbidden',
      'CF-Access-Client-Secret': 'forbidden', 'X-Domino-Client-Id': '192.0.2.99' },
  }), env);
  assert.equal((await traced.response).status, 200);
  assert.equal(traced.handed[0]?.headers.get('Cookie'), null);
  const [seen] = bound.read.calls;
  assert.equal(seen.url, `${ORIGIN}/api/read/v2/pool-market`);
  assert.equal(new TextDecoder().decode(seen.body), body);
  assert.equal(seen.headers['x-domino-read-contract'], '2.0.0-rc.1');
  for (const name of ['cookie', 'authorization', 'cf-access-client-secret', 'x-domino-client-id']) {
    assert.equal(name in seen.headers, false, name);
  }
});

test('a signed-in POST read loses its cookies at the gate and keeps its method, URL, contract header and body bytes', async () => {
  const { bound, env } = recorders();
  const { path, body } = ROUTE.read;
  const traced = tracedPages(
    call(path, { method: 'POST', body, cookie: JAR, headers: { 'X-Domino-Read-Contract': RUNTIME.read.CONTRACT_VERSION } }),
    env,
  );
  assert.equal((await traced.response).status, 200);
  assert.equal(traced.handed[0]?.headers.get('Cookie'), null);
  const [seen] = bound.read.calls;
  assert.equal('cookie' in seen.headers, false);
  assert.equal(seen.method, 'POST');
  assert.equal(seen.url, `${ORIGIN}${path}`);
  assert.equal(seen.headers['x-domino-read-contract'], RUNTIME.read.CONTRACT_VERSION);
  assert.equal(new TextDecoder().decode(seen.body), body);
});

test('session, onboarding and deposit go past the gate as the browser sent them and still get only their named cookies', async () => {
  for (const family of ['session', 'onboarding', 'deposit', 'performance']) {
    const { bound, env } = recorders();
    const { path, body } = ROUTE[family];
    const traced = tracedPages(call(path, { method: 'POST', body, cookie: JAR, headers: { 'X-Domino-CSRF': CSRF } }), env);
    assert.equal((await traced.response).status, 200, family);
    // Not a public read: the gate calls next() with no request of its own.
    assert.deepEqual(traced.handed, [undefined], family);
    assert.deepEqual(traced.routed, [{ url: `${ORIGIN}${path}`, cookie: JAR }], family);
    assert.equal(bound[family].calls[0].headers.cookie, FAMILY[family].cookie, family);
    assert.doesNotMatch(bound[family].calls[0].headers.cookie, /domino-beta|theme=dark/, family);
  }
});

test('signed in, an /api path with an empty segment still gets the JSON 404, read prefix included, and nothing is called', async () => {
  const { env, calls } = recorders();
  for (const path of ['/api//x', '/api/read/v1//capabilities', '/api/read//v1/capabilities', '/api/read/v1/capabilities//', '/api/session/v1//me']) {
    for (const method of ['GET', 'POST']) {
      const traced = tracedPages(call(path, { method, cookie: JAR, ...(method === 'POST' ? { body: '{}' } : {}) }), env);
      const response = await traced.response;
      await refused(response, 404, 'not_found');
      apiHeaders(response, `${method} ${path}`, path);
      // onward() answered it: Pages' next() and the route file never saw it.
      assert.deepEqual(traced.handed, [], `${method} ${path}`);
      assert.deepEqual(traced.routed, [], `${method} ${path}`);
    }
  }
  assert.equal(calls(), 0);
  assert.equal(served, 0);
});

test('with CANONICAL_HOSTS_ONLY on, a signed-in read on domino.money still loses its cookies, and another host is refused before the gate', async () => {
  const { bound, env, calls } = recorders();
  env.CANONICAL_HOSTS_ONLY = 'true';
  const home = tracedPages(call('/api/read/v1/capabilities', { cookie: JAR }), env);
  assert.equal((await home.response).status, 200);
  assert.equal(home.handed[0]?.headers.get('Cookie'), null);
  assert.equal('cookie' in bound.read.calls[0].headers, false);
  for (const origin of FOREIGN) {
    for (const path of ['/api/read/v1/capabilities', '/api/read/v1//capabilities', ROUTE.session.path]) {
      const traced = tracedPages(call(path, { origin, cookie: JAR }), env);
      const response = await traced.response;
      await refused(response, 404, 'not_found');
      assert.equal(response.headers.get('Set-Cookie'), null);
      assert.deepEqual(traced.handed, [], `${origin}${path}`);
    }
  }
  assert.equal(calls(), 1);
  assert.equal(served, 0);
});

// ---------------------------------------------------------------------------
// Content-Encoding (review note F1V-C1). forward() drops the header, so an
// enabled Worker reads a compressed body as the identity bytes it was given,
// and its strict UTF-8 and JSON parsing refuses them as invalid_request. The
// Workers below are enabled in memory only, with placeholder credentials and
// the tripwire as their transport: each refusal comes before any upstream
// call, and the tripwire fails the suite if one is ever made.
// ---------------------------------------------------------------------------

const { gzipSync } = require('node:zlib');
const ENABLED_WORKERS = {
  execution: (await import('../../bridge/src/execution-worker.mjs')).createExecutionWorker({ fetch: globalThis.fetch }),
  read: (await import('../../bridge/src/worker.mjs')).createWorker({ fetch: globalThis.fetch }),
  session: (await import('../../bridge/src/session-worker.mjs')).createSessionWorker({ fetch: globalThis.fetch }),
  onboarding: (await import('../../bridge/src/onboarding-worker.mjs')).createOnboardingWorker({ fetch: globalThis.fetch }),
  deposit: (await import('../../bridge/src/deposit-worker.mjs')).createDepositWorker({ fetch: globalThis.fetch }),
  performance: (await import('../../bridge/src/performance-worker.mjs')).createPerformanceWorker({ fetch: globalThis.fetch }),
};
const ENABLED = {
  execution: { EXECUTION_BRIDGE_ENABLED: 'true', APP_ORIGIN: ORIGIN, EXECUTION_GATEWAY_ORIGIN: 'https://vm-execution.domino.money', EXECUTION_ACCESS_CLIENT_ID: 'placeholder-client-id', EXECUTION_ACCESS_CLIENT_SECRET: 'placeholder-client-secret' },
  performance: { PERFORMANCE_BRIDGE_ENABLED: 'true', APP_ORIGIN: ORIGIN, PERFORMANCE_GATEWAY_ORIGIN: 'https://vm-performance.domino.money', PERFORMANCE_ACCESS_CLIENT_ID: 'placeholder-client-id', PERFORMANCE_ACCESS_CLIENT_SECRET: 'placeholder-client-secret' },
  read: {
    READ_BRIDGE_ENABLED: 'true',
    APP_ORIGIN: ORIGIN,
    GATEWAY_ORIGIN: 'https://vm-read.domino.money',
    ENABLED_READS: 'pools',
    ACCESS_CLIENT_ID: 'placeholder-client-id',
    ACCESS_CLIENT_SECRET: 'placeholder-client-secret',
  },
  session: {
    SESSION_BRIDGE_ENABLED: 'true',
    APP_ORIGIN: ORIGIN,
    SESSION_GATEWAY_ORIGIN: 'https://vm-session.domino.money',
    SESSION_ACCESS_CLIENT_ID: 'placeholder-client-id',
    SESSION_ACCESS_CLIENT_SECRET: 'placeholder-client-secret',
  },
  onboarding: {
    ONBOARDING_BRIDGE_ENABLED: 'true',
    APP_ORIGIN: ORIGIN,
    ONBOARDING_GATEWAY_ORIGIN: 'https://vm-onboarding.domino.money',
    ONBOARDING_ACCESS_CLIENT_ID: 'placeholder-client-id',
    ONBOARDING_ACCESS_CLIENT_SECRET: 'placeholder-client-secret',
  },
  deposit: {
    DEPOSIT_BRIDGE_ENABLED: 'true',
    APP_ORIGIN: ORIGIN,
    DEPOSIT_GATEWAY_ORIGIN: 'https://vm-deposit.domino.money',
    DEPOSIT_ACCESS_CLIENT_ID: 'placeholder-client-id',
    DEPOSIT_ACCESS_CLIENT_SECRET: 'placeholder-client-secret',
  },
};

function enabledWorkers() {
  const env = { ...GATE };
  for (const family of FAMILIES.filter(family => family !== 'setup')) {
    env[FAMILY[family].binding] = { fetch: (request) => ENABLED_WORKERS[family].fetch(request, ENABLED[family]) };
  }
  return env;
}

/** A gzip body with Content-Encoding: gzip, as a non-browser client could send it. */
function compressed(family, cookie = JAR) {
  const bytes = gzipSync(Buffer.from(ROUTE[family].body));
  return call(ROUTE[family].path, {
    method: 'POST',
    body: bytes,
    cookie,
    headers: { 'Content-Encoding': 'gzip', 'Content-Length': String(bytes.byteLength), 'X-Domino-CSRF': CSRF },
  });
}

test('F1V-C1: a Content-Encoding body reaches an enabled Worker through the forwarder without the header and is refused as invalid_request', async () => {
  const env = enabledWorkers();
  for (const family of FAMILIES.filter(family => family !== 'setup')) {
    await workerSaid(await pages(compressed(family), env), family, 'invalid_request');
  }
  assert.deepEqual(upstream, []);
});

test('F1V-C1 control: the same request sent to an enabled Worker directly, header and all, is refused as json_required', async () => {
  for (const family of FAMILIES.filter(family => family !== 'setup')) {
    const request = compressed(family, family === 'read' ? null : SESSION);
    const response = await ENABLED_WORKERS[family].fetch(request, ENABLED[family]);
    await workerSaid(response, family, 'json_required');
  }
  assert.deepEqual(upstream, []);
});

test('no test in this file reached for an upstream', () => {
  assert.deepEqual(upstream, []);
});

// Setup uses GET only and never receives private session credentials.
test('public setup identities remain explicitly unavailable until a real release is enabled', async () => {
  const {env}=workers();
  const result=await pages(call('/api/setup/v1/release'),env);
  assert.equal(result.status,200);
  assert.deepEqual(await result.json(),{contractVersion:'1.0.0-rc.1',chainId:4663,available:false,deployment:null});
  assert.equal(result.headers.get('Set-Cookie'),null);
});

// ---------------------------------------------------------------------------
// 2026-10-01, platform workstream (H7): the exact preview alias may use the other families, each named in
// PREVIEW_FAMILIES. A public one (the setup release) is translated like the reads, after its browser is checked; a
// private one goes on as the browser sent it, to a binding the preview environment names, which must be a Worker
// deployed for the preview alias (docs/PREVIEW_PUBLIC_READS.md).
// ---------------------------------------------------------------------------

test('the preview alias uses another family only when PREVIEW_FAMILIES names it, exactly', async () => {
  const { env, calls } = recorders();
  env.PREVIEW_PUBLIC_READS = 'true';
  for (const value of [undefined, '', 'Setup', 'setups', 'setup2', 'read', 'all', '*', 'setup;session', true, 1]) {
    env.PREVIEW_FAMILIES = value;
    await refused(await pages(call('/api/setup/v1/release', { origin: PREVIEW }), env), 404, 'not_found');
    await refused(await pages(call(ROUTE.session.path, { method: 'POST', body: '{}', origin: PREVIEW }), env), 404, 'not_found');
  }
  assert.equal(calls(), 0);
  // The reads keep their own opt-in: 'read' in PREVIEW_FAMILIES is not one.
  env.PREVIEW_PUBLIC_READS = 'false';
  env.PREVIEW_FAMILIES = 'read, setup';
  await refused(await pages(call('/api/read/v1/capabilities', { origin: PREVIEW }), env), 404, 'not_found');
  assert.equal(calls(), 0);
  // Names around commas may carry spaces; every other host stays refused whatever the list says.
  env.PREVIEW_FAMILIES = ' setup , session ';
  assert.equal((await pages(call('/api/setup/v1/release', { origin: PREVIEW }), env)).status, 200);
  for (const origin of ['https://abc123de.domino-app-e65.pages.dev', 'https://domino-app-e65.pages.dev', 'http://preview.domino-app-e65.pages.dev']) {
    await refused(await pages(call('/api/setup/v1/release', { origin }), env), 404, 'not_found');
  }
});

test('preview setup release: checked as a browser’s, translated like the reads, with no cookie, and the real Worker answers', async () => {
  const { env, calls } = workers();
  env.PREVIEW_FAMILIES = 'setup';
  const response = await pages(call('/api/setup/v1/release', { origin: PREVIEW }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-domino-setup-contract'), '1.0.0-rc.1');
  assert.deepEqual(await response.json(), { contractVersion: '1.0.0-rc.1', chainId: 4663, available: false, deployment: null });
  assert.deepEqual(calls, [`setup GET ${ORIGIN}/api/setup/v1/release`]);
  for (const headers of [{ Origin: 'https://evil.example' }, { Origin: `${PREVIEW}.evil.example` }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Mode': 'navigate' }, { Host: 'domino.money' }]) {
    await refused(await pages(call('/api/setup/v1/release', { origin: PREVIEW, headers }), env), 403, 'origin_not_allowed');
  }
  const { binding, calls: seen } = recorder();
  const answered = await pages(call('/api/setup/v1/release', { origin: PREVIEW, cookie: `${BETA}; ${SESSION}` }), { ...GATE, PREVIEW_FAMILIES: 'setup', SETUP_BRIDGE: binding });
  assert.equal(answered.status, 200);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${ORIGIN}/api/setup/v1/release`);
  assert.equal(seen[0].headers.host, 'domino.money');
  assert.equal(seen[0].headers.cookie, undefined, 'no cookie of any kind crosses the public alias');
});

test('preview private families go on exactly as the browser sent them, with their own cookies only, to the preview’s binding', async () => {
  for (const family of ['session', 'onboarding', 'deposit', 'performance', 'execution']) {
    const { binding, calls } = recorder();
    const env = { ...GATE, PREVIEW_FAMILIES: family, [FAMILY[family].binding]: binding };
    const { path, body } = ROUTE[family];
    const response = await pages(call(path, { method: 'POST', body, origin: PREVIEW, cookie: JAR, headers: { 'X-Domino-CSRF': CSRF } }), env);
    assert.equal(response.status, 200, family);
    assert.equal(calls.length, 1, family);
    assert.equal(calls[0].url, `${PREVIEW}${path}`, `${family}: the preview's own origin, not translated`);
    assert.equal(calls[0].headers.origin, PREVIEW, family);
    assert.equal(calls[0].headers.host, new URL(PREVIEW).host, family);
    assert.equal(calls[0].headers.cookie, FAMILY[family].cookie, `${family}: its own cookies only, never the beta cookie`);
    assert.equal(calls[0].headers['x-domino-csrf'], CSRF, family);
    // Another family on the same list stays as shut as before.
    const other = family === 'session' ? 'execution' : 'session';
    await refused(await pages(call(ROUTE[other].path, { method: 'POST', body: '{}', origin: PREVIEW }), env), 404, 'not_found');
  }
  // Production's own Workers answer https://domino.money only: bound on the preview by mistake, they refuse its calls.
  const { env } = workers();
  env.PREVIEW_FAMILIES = 'session';
  const refusedByWorker = await pages(call(ROUTE.session.path, { method: 'POST', body: '{}', origin: PREVIEW, cookie: JAR, headers: { 'X-Domino-CSRF': CSRF } }), env);
  assert.ok([403, 404].includes(refusedByWorker.status), String(refusedByWorker.status));
  assert.equal(refusedByWorker.headers.get(FAMILY.session.contract), RUNTIME.session.CONTRACT_VERSION, 'the Worker’s own refusal');
});
