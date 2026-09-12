/**
 * The session-v1 request builder and response classifier, driven with the
 * package's own runtime validators and fixtures. The order of classification
 * matters: a closed-beta gate refusal must be recognised before anything is
 * treated as a session answer, and nothing unvalidated is ever returned as a
 * success.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { FIXTURES, runtime } from './support/session-fixtures.mjs';

const require = createRequire(import.meta.url);
const { createSessionApi, OutgoingContractError, CONTRACT_HEADER, CSRF_HEADER, SESSION_PATH } = require(
  '../.test-build/app/src/session/api.js',
);

const VERSION = runtime.CONTRACT_VERSION;
const PREAUTH = 'p'.repeat(43);
const CSRF = 'c'.repeat(43);
const signal = () => new AbortController().signal;

function json(body, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', [CONTRACT_HEADER]: VERSION, ...headers },
  });
}

function recorder(respond = () => json(FIXTURES.responses.me), options = {}) {
  const sent = [];
  const fetch = async (url, init) => {
    sent.push({ url, init, headers: new Headers(init.headers) });
    return respond(url, init);
  };
  return { sent, api: createSessionApi({ fetch, runtime, ...options }) };
}

const failureOf = async (response, call = (api) => api.me(signal())) => {
  const outcome = await call(recorder(() => response).api);
  assert.equal(outcome.ok, false);
  return outcome.failure;
};

test('me is a plain GET: no body, no Content-Type, no CSRF; same-origin, no-store, no redirects', async () => {
  const { sent, api } = recorder();
  const outcome = await api.me(signal());
  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.body, FIXTURES.responses.me);
  const [{ url, init, headers }] = sent;
  assert.equal(url, '/api/session/v1/me');
  assert.equal(init.method, 'GET');
  assert.equal(init.body, undefined);
  assert.equal(headers.get('Content-Type'), null);
  assert.equal(headers.get(CSRF_HEADER), null);
  assert.equal(headers.get(CONTRACT_HEADER), VERSION);
  assert.equal(init.credentials, 'same-origin');
  assert.equal(init.mode, 'same-origin');
  assert.equal(init.cache, 'no-store');
  assert.equal(init.redirect, 'error');
});

test('each POST carries JSON, the contract version and exactly the CSRF its route takes', async () => {
  const { sent, api } = recorder((url) => json(FIXTURES.responses[url.slice(SESSION_PATH.length)]));
  const outcomes = [
    await api.bootstrap(signal()),
    await api.challenge(FIXTURES.requests.challenge, PREAUTH, signal()),
    await api.verify(FIXTURES.requests.verify, PREAUTH, signal()),
    await api.refresh(CSRF, signal()),
    await api.logout(CSRF, signal()),
  ];
  assert.deepEqual(
    outcomes.map((outcome) => outcome.ok),
    [true, true, true, true, true],
  );
  // Bootstrap must not send a CSRF: a present header that is not a credential
  // is refused by the service.
  assert.deepEqual(
    sent.map(({ headers }) => headers.get(CSRF_HEADER)),
    [null, PREAUTH, PREAUTH, CSRF, CSRF],
  );
  for (const { init, headers } of sent) {
    assert.equal(init.method, 'POST');
    assert.equal(headers.get('Content-Type'), 'application/json');
    assert.equal(headers.get(CONTRACT_HEADER), VERSION);
  }
  assert.deepEqual(JSON.parse(sent[0].init.body), {});
  assert.deepEqual(JSON.parse(sent[1].init.body), FIXTURES.requests.challenge);
  assert.deepEqual(JSON.parse(sent[2].init.body), FIXTURES.requests.verify);
  assert.deepEqual(JSON.parse(sent[4].init.body), {});
});

test('a body the contract rejects is refused before anything is sent', async () => {
  const { sent, api } = recorder();
  // An EIP-2098 compact signature is 64 bytes; the contract takes exactly 65.
  const compact = { ...FIXTURES.requests.verify, signature: `0x${'ab'.repeat(64)}` };
  await assert.rejects(api.verify(compact, PREAUTH, signal()), OutgoingContractError);
  await assert.rejects(
    api.challenge({ address: FIXTURES.requests.challenge.address, chainId: 1 }, PREAUTH, signal()),
    OutgoingContractError,
  );
  assert.equal(sent.length, 0);
});

test('the closed-beta gate refusal is recognised before any contract parsing', async () => {
  const gate = new Response('{"error":"beta_access_required"}', {
    status: 401,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
  assert.deepEqual(await failureOf(gate), { kind: 'gate_required' });
});

test('a gate outage is recognised by its missing contract header', async () => {
  const outage = new Response('<!doctype html><title>Unavailable</title>', {
    status: 503,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
  assert.deepEqual(await failureOf(outage), { kind: 'gate_unavailable' });
});

test('an answer without the contract header is never read as a session state', async () => {
  // Where the session Worker is not routed, the SPA fallback answers 200 HTML.
  const spa = new Response('<!doctype html><div id="root"></div>', { headers: { 'Content-Type': 'text/html' } });
  assert.deepEqual(await failureOf(spa), { kind: 'not_routed', status: 200 });
  assert.deepEqual(await failureOf(new Response('not found', { status: 404 })), { kind: 'not_routed', status: 404 });
  // A 401 that is not the gate's body is not the gate.
  const other = new Response('{"error":"session_required"}', { status: 401, headers: { 'Content-Type': 'application/json' } });
  assert.deepEqual(await failureOf(other), { kind: 'not_routed', status: 401 });
});

test('a wrong contract version, content type or JSON is a contract mismatch', async () => {
  assert.deepEqual(await failureOf(json(FIXTURES.responses.me, { headers: { [CONTRACT_HEADER]: '2.0.0' } })), {
    kind: 'contract_mismatch',
    detail: 'version',
  });
  const html = new Response('{}', { headers: { 'Content-Type': 'text/html', [CONTRACT_HEADER]: VERSION } });
  assert.deepEqual(await failureOf(html), { kind: 'contract_mismatch', detail: 'content_type' });
  const bad = new Response('{"authenticated":', { headers: { 'Content-Type': 'application/json', [CONTRACT_HEADER]: VERSION } });
  assert.deepEqual(await failureOf(bad), { kind: 'contract_mismatch', detail: 'json' });
});

test('a body over the 16 KiB limit is refused', async () => {
  const huge = new Response(`"${'x'.repeat(16400)}"`, {
    headers: { 'Content-Type': 'application/json', [CONTRACT_HEADER]: VERSION },
  });
  assert.deepEqual(await failureOf(huge), { kind: 'contract_mismatch', detail: 'json' });
});

test('a 200 that fails validation is a contract mismatch, never a success', async () => {
  assert.deepEqual(await failureOf(json({ ...FIXTURES.responses.me, role: 'admin' })), {
    kind: 'contract_mismatch',
    detail: 'body',
  });
  assert.deepEqual(await failureOf(json({ ...FIXTURES.responses.me, owner: { address: FIXTURES.responses.me.owner.address, chainId: 1 } })), {
    kind: 'contract_mismatch',
    detail: 'body',
  });
});

test('an error whose status does not match its code is a contract mismatch', async () => {
  assert.deepEqual(await failureOf(json({ error: 'wallet_not_allowed' }, { status: 401 })), {
    kind: 'contract_mismatch',
    detail: 'error_body',
  });
  assert.deepEqual(await failureOf(json({ error: 'teapot' }, { status: 418 })), {
    kind: 'contract_mismatch',
    detail: 'error_body',
  });
});

test('every error in the package fixtures is reported with its own code and status', async () => {
  for (const [code, { status, body }] of Object.entries(FIXTURES.errors)) {
    const headers = status === 429 ? { 'Retry-After': '60' } : {};
    assert.deepEqual(await failureOf(json(body, { status, headers })), {
      kind: 'session_error',
      status,
      code,
      retryAfterS: status === 429 ? 60 : null,
    });
  }
});

test('a request that outlives the client timeout reports a timeout', async () => {
  const hang = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  const outcome = await createSessionApi({ fetch: hang, runtime, timeoutMs: 20 }).me(signal());
  assert.deepEqual(outcome.failure, { kind: 'timeout' });
});

test('a caller abort reports aborted, and a failed fetch a network error', async () => {
  const hang = (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    });
  const controller = new AbortController();
  const pending = createSessionApi({ fetch: hang, runtime }).me(controller.signal);
  controller.abort();
  assert.deepEqual((await pending).failure, { kind: 'aborted' });

  const offline = createSessionApi({ fetch: () => Promise.reject(new TypeError('Failed to fetch')), runtime });
  assert.deepEqual((await offline.me(signal())).failure, { kind: 'network_error' });
});

test('on a browser without String#isWellFormed the runtime failure is reported, not thrown', async () => {
  const original = Object.getOwnPropertyDescriptor(String.prototype, 'isWellFormed');
  delete String.prototype.isWellFormed;
  try {
    const { sent, api } = recorder();
    const outcome = await api.verify(FIXTURES.requests.verify, PREAUTH, signal());
    assert.deepEqual(outcome.failure, { kind: 'runtime_error' });
    assert.equal(sent.length, 0);
  } finally {
    Object.defineProperty(String.prototype, 'isWellFormed', original);
  }
});

test("the server's Date header comes back for placing the expiry timer", async () => {
  const date = 'Thu, 10 Sep 2026 12:00:00 GMT';
  const { api } = recorder(() => json(FIXTURES.responses.me, { headers: { Date: date } }));
  const outcome = await api.me(signal());
  assert.equal(outcome.serverTime, Date.parse(date));
});
