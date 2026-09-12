/**
 * The session client behind the /api chain main gained in F1 (#80): forward()
 * in functions/_lib/bridge.ts in front of the real session bridge Worker, with
 * the [vars] of its reviewed disabled config, read from
 * bridge/wrangler.session.toml itself.
 *
 * The client builds each request exactly as it does in the browser. The fetch
 * below adds what the browser and the edge add to it (Host, Fetch Metadata for
 * the client's own mode, CF-Connecting-IP, Origin on a POST, every cookie the
 * site holds) and hands the result to forward(). What a deployment can answer
 * the client today:
 *
 *   production, bound        the disabled Worker's route_not_available, with
 *                            its contract header: sign-in is switched off
 *   a preview host           the forwarder's 404 not_found, no contract
 *                            header: sign-in is not routed there
 *   binding missing/throws   503 bridge_unavailable, no contract header: an
 *                            outage to check again, never a session answer
 *
 * The middleware in front of forward() runs in the gated browser tests
 * (tests/support/wallet-server.mjs uses the real one) and in
 * tests/forwarder.test.mjs.
 *
 * globalThis.fetch is a tripwire before the Worker loads, as in
 * tests/forwarder.test.mjs: the Worker's default export captures it as its
 * upstream transport, so an upstream call fails this file.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { FIXTURES, runtime } from './support/session-fixtures.mjs';

const upstream = [];
globalThis.fetch = async (input) => {
  upstream.push(input instanceof Request ? input.url : String(input));
  throw new Error('the session forwarder suite reached for an upstream');
};
// Imported only now: the Worker's default export captures globalThis.fetch as it loads.
const worker = (await import('../../bridge/src/session-worker.mjs')).default;

const require = createRequire(import.meta.url);
const { createSessionApi } = require('../.test-build/app/src/session/api.js');
const { classify } = require('../.test-build/app/src/session/errors.js');
const { blockedFor } = require('../.test-build/app/src/session/machine.js');
const { forward } = require('../.test-build/app/functions/_lib/bridge.js');

/** The [vars] of the session Worker's reviewed disabled config, as the file states them. */
function disabledVars() {
  const toml = readFileSync(resolve(import.meta.dirname, '../../bridge/wrangler.session.toml'), 'utf8');
  const section = toml.split(/^\[vars\]\s*$/m)[1].split(/^\[/m)[0];
  const vars = Object.fromEntries([...section.matchAll(/^([A-Z_]+) = "([^"]*)"\s*$/gm)].map((match) => [match[1], match[2]]));
  assert.equal(vars.SESSION_BRIDGE_ENABLED, 'false', 'the reviewed config is the disabled one');
  return vars;
}
const DISABLED = disabledVars();
const ORIGIN = DISABLED.APP_ORIGIN;
assert.equal(ORIGIN, 'https://domino.money');
const PREVIEW = 'https://0123abcd.domino-app-e65.pages.dev';

const BETA = '__Host-domino-beta=v1.placeholder';
const PREAUTH_COOKIE = `__Host-domino-preauth=${'p'.repeat(43)}`;
const SESSION_COOKIE = `__Host-domino-session=${'s'.repeat(43)}`;
const JAR = `${BETA}; theme=dark; ${PREAUTH_COOKIE}; ${SESSION_COOKIE}`;
const PREAUTH = 'q'.repeat(43);
const CSRF = 'c'.repeat(43);
const signal = () => new AbortController().signal;

/**
 * The session client wired to forward() the way a page on `origin` reaches
 * it. `bound` is what SESSION_BRIDGE holds: the disabled Worker, nothing, or a
 * binding that throws. Each request the client sends and each request the
 * binding receives is recorded, with lowercase header names on both sides.
 */
function chain({ origin = ORIGIN, bound = 'worker' } = {}) {
  const sent = [];
  const reached = [];
  const env = {};
  if (bound !== 'missing') {
    env.SESSION_BRIDGE = {
      async fetch(request) {
        reached.push({ method: request.method, url: request.url, headers: Object.fromEntries(request.headers) });
        if (bound === 'throws') throw new Error('the binding failed');
        return worker.fetch(request, DISABLED);
      },
    };
  }
  const fetch = async (path, init) => {
    const url = new URL(path, origin);
    const headers = new Headers(init.headers);
    sent.push({ method: init.method, path, headers: Object.fromEntries(headers) });
    // What a browser adds to this same-origin fetch(), and the edge to the
    // request it hands Pages. A same-origin GET carries no Origin.
    headers.set('Host', url.host);
    headers.set('Sec-Fetch-Site', 'same-origin');
    headers.set('Sec-Fetch-Mode', init.mode);
    headers.set('Sec-Fetch-Dest', 'empty');
    headers.set('CF-Connecting-IP', '203.0.113.9');
    headers.set('Cookie', JAR);
    if (init.method !== 'GET') headers.set('Origin', origin);
    const request = new Request(url, { method: init.method, headers, body: init.body, redirect: init.redirect, signal: init.signal });
    return forward(request, env);
  };
  return { sent, reached, api: createSessionApi({ fetch, runtime }) };
}

/** Every route the client has, each with the arguments it sends in a sign-in. */
const routes = (api) => [
  ['me', () => api.me(signal())],
  ['bootstrap', () => api.bootstrap(signal())],
  ['challenge', () => api.challenge(FIXTURES.requests.challenge, PREAUTH, signal())],
  ['verify', () => api.verify(FIXTURES.requests.verify, PREAUTH, signal())],
  ['refresh', () => api.refresh(CSRF, signal())],
  ['logout', () => api.logout(CSRF, signal())],
];

test('production: every route reaches the disabled session Worker with all its headers, and reads as switched off', async () => {
  const { sent, reached, api } = chain();
  for (const [route, send] of routes(api)) {
    const outcome = await send();
    assert.equal(outcome.ok, false, route);
    // route_not_available, not origin_not_allowed or a contract mismatch: the
    // Worker's browser checks passed on what the forwarder kept, and its
    // answer carries the contract header the client requires.
    assert.deepEqual(
      outcome.failure,
      { kind: 'session_error', status: runtime.ERROR_STATUS_BY_CODE.route_not_available, code: 'route_not_available', retryAfterS: null },
      route,
    );
    assert.equal(classify(outcome.failure.code), 'disabled');
    assert.equal(blockedFor(outcome.failure).failure, 'service_disabled', route);
  }
  assert.equal(reached.length, sent.length);
  for (const [index, request] of reached.entries()) {
    const { method, path, headers } = sent[index];
    assert.equal(request.method, method);
    assert.equal(request.url, `${ORIGIN}${path}`);
    for (const [name, value] of Object.entries(headers)) assert.equal(request.headers[name], value, `${path}: ${name} reaches the Worker`);
    assert.equal(request.headers.cookie, `${PREAUTH_COOKIE}; ${SESSION_COOKIE}`, `${path}: the session cookies only, the beta cookie stays behind`);
  }
  assert.deepEqual(
    sent.map(({ headers }) => headers['x-domino-csrf'] ?? null),
    [null, null, PREAUTH, PREAUTH, CSRF, CSRF],
    'the CSRF each route takes was sent, and forwarded above',
  );
  assert.deepEqual(upstream, []);
});

test('a preview host: the forwarder refuses before any binding, and the client reads not routed, never a session answer', async () => {
  const { reached, api } = chain({ origin: PREVIEW });
  for (const [route, send] of routes(api)) {
    const outcome = await send();
    assert.deepEqual(outcome.failure, { kind: 'not_routed', status: 404 }, route);
    assert.equal(blockedFor(outcome.failure).failure, 'service_disabled', route);
  }
  assert.deepEqual(reached, []);
  assert.deepEqual(upstream, []);
});

test('a missing or failing binding: 503 bridge_unavailable is an outage to check again, never a session answer', async () => {
  for (const bound of ['missing', 'throws']) {
    const { reached, api } = chain({ bound });
    for (const [route, send] of routes(api)) {
      const outcome = await send();
      // Like any platform 5xx without the contract header; verify's handling
      // of it (me first, then the preauth abort) is in the machine tests.
      assert.deepEqual(outcome.failure, { kind: 'gate_unavailable' }, `${bound} ${route}`);
      const view = blockedFor(outcome.failure);
      assert.equal(view.status, 'blocked');
      assert.equal(view.retry, 'check', `${bound} ${route}`);
    }
    assert.equal(reached.length, bound === 'throws' ? 6 : 0, bound);
  }
  assert.deepEqual(upstream, []);
});
