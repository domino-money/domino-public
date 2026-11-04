// Launch round P3 (4 Nov 2026), item 7, testing without real money: a private family's Worker (the session Worker and
// the transport onboarding, deposit, performance, execution, position-plan and crosschain share) admits the exact Pages
// preview origins PREVIEW_ORIGINS lists besides APP_ORIGIN, and tells its listener which one it admitted. One listed
// origin is admitted from its own host only; every other origin, a sibling, a suffix or prefix, another scheme or port,
// another case, a trailing slash, null, and a request whose URL and Origin name two different admitted origins, are
// refused before any upstream call. Each guard is pinned here: deleting it fails a test below.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createSessionWorker } from '../src/session-worker.mjs';
import { createExecutionWorker } from '../src/execution-worker.mjs';
import { createCrosschainWorker } from '../src/crosschain-worker.mjs';
import { createPositionPlanWorker } from '../src/position-plan-worker.mjs';
import { MAX_PREVIEW_ORIGINS } from '../src/worker.mjs';
import { CONTRACT_VERSION as SESSION_VERSION } from '../../api-contracts/session-v1/runtime.mjs';
import { CONTRACT_VERSION as CROSSCHAIN_VERSION } from '../../api-contracts/crosschain-v1/runtime.mjs';
import { CONTRACT_VERSION as PLAN_VERSION } from '../../api-contracts/position-plan-v1/runtime.mjs';

const app = 'https://app.example.invalid';
// A preview alias of one Pages project, and what else that project or another can serve.
const preview = 'https://preview.pages-project.invalid';
const token = 's'.repeat(43), preauth = 'p'.repeat(43), csrf = 'c'.repeat(43);
const SESSION_ENV = { APP_ORIGIN: app, PREVIEW_ORIGINS: preview, SESSION_BRIDGE_ENABLED: 'true',
  SESSION_GATEWAY_ORIGIN: 'https://auth.example.invalid',
  SESSION_ACCESS_CLIENT_ID: 'synthetic-auth-id', SESSION_ACCESS_CLIENT_SECRET: 'synthetic-auth-secret' };
const EXECUTION_ENV = { APP_ORIGIN: app, PREVIEW_ORIGINS: preview, EXECUTION_BRIDGE_ENABLED: 'true',
  EXECUTION_GATEWAY_ORIGIN: 'https://execution.example.invalid',
  EXECUTION_ACCESS_CLIENT_ID: 'synthetic-client', EXECUTION_ACCESS_CLIENT_SECRET: 'synthetic-secret' };
const CROSSCHAIN_ENV = { APP_ORIGIN: app, PREVIEW_ORIGINS: preview, CROSSCHAIN_BRIDGE_ENABLED: 'true',
  CROSSCHAIN_GATEWAY_ORIGIN: 'https://crosschain.example.invalid',
  CROSSCHAIN_ACCESS_CLIENT_ID: 'synthetic-crosschain-id', CROSSCHAIN_ACCESS_CLIENT_SECRET: 'synthetic-crosschain-secret' };
const PLAN_ENV = { APP_ORIGIN: app, PREVIEW_ORIGINS: preview, POSITION_PLAN_BRIDGE_ENABLED: 'true',
  POSITION_PLAN_GATEWAY_ORIGIN: 'https://position-plan.example.invalid',
  POSITION_PLAN_ACCESS_CLIENT_ID: 'synthetic-plan-id', POSITION_PLAN_ACCESS_CLIENT_SECRET: 'synthetic-plan-secret' };

const loggedIn = { authenticated: true, owner: { address: `0x${'1'.repeat(40)}`, chainId: 4663 }, expiresAt: '2026-09-10T20:00:00Z',
  csrfToken: csrf, validation: { method: 'plain_eoa', blockNumber: '123', blockHash: `0x${'a'.repeat(64)}` } };
const SESSION_ANSWERS = {
  bootstrap: { result: { status: 'challenge_required', csrfToken: csrf, expiresAt: '2026-09-10T20:00:00Z' }, credentials: { preauth } },
  me: { result: loggedIn, credentials: {} },
};
const execution = JSON.parse(readFileSync(new URL('../../api-contracts/execution-v1/fixtures/status-wire.json', import.meta.url)));

/** Origins that must never pass for `preview` (or `app`): each is a different origin, or not one at all. */
const FOREIGN = [
  'https://other.pages-project.invalid',            // another deployment (branch or hash) of the same Pages project
  'https://pages-project.invalid',                  // the project's own parent name
  'https://evil.preview.pages-project.invalid',     // a host under the listed one: a suffix match would admit it
  'https://evilpreview.pages-project.invalid',      // a string ending in the listed host
  'https://preview.pages-project.invalid.evil.invalid', // a string starting with the listed origin
  'http://preview.pages-project.invalid',           // another scheme
  'https://preview.pages-project.invalid:8443',     // another port
  'https://evil.invalid',
];
/** Spellings no browser sends for the listed origin: as an Origin header they name nothing admitted. */
const MISSPELLED = ['https://PREVIEW.pages-project.invalid', 'https://Preview.Pages-Project.invalid',
  `${preview}/`, `${preview}:443`, 'null', '', 'preview.pages-project.invalid', `${preview}, ${preview}`];

function sessionRequest(route = 'bootstrap', { url, origin, headers = {}, method = route === 'me' ? 'GET' : 'POST' } = {}) {
  const page = url ?? preview;
  return new Request(`${page}/api/session/v1/${route}`, { method, headers: {
    ...(origin === null ? {} : { Origin: origin ?? page }), 'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', 'X-Domino-CSRF': csrf, ...headers },
    ...(method === 'GET' ? {} : { body: '{}', duplex: 'half' }) });
}
function executionRequest({ url = preview, origin, headers = {} } = {}) {
  return new Request(`${url}/api/execution/v1/status`, { method: 'POST', headers: {
    ...(origin === null ? {} : { Origin: origin ?? url }), 'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty',
    Cookie: `__Host-domino-session=${token}`, 'X-Domino-CSRF': csrf, ...headers },
    body: JSON.stringify(execution.requests.status), duplex: 'half' });
}
function capabilitiesRequest(family, { url = preview, origin, headers = {} } = {}) {
  return new Request(`${url}/api/${family}/v1/capabilities`, { method: 'GET', headers: {
    ...(origin === undefined || origin === null ? {} : { Origin: origin }),
    'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', ...headers } });
}
function json(value, header, version) {
  return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json', [header]: version } });
}
function sessionHarness() {
  const calls = [];
  return { calls, worker: createSessionWorker({ getClientIp: () => '203.0.113.7', fetch: async (url, init) => {
    calls.push({ url, init });
    return json(SESSION_ANSWERS[String(url).split('/').at(-1)], 'X-Domino-Session-Contract', SESSION_VERSION);
  } }) };
}
function executionHarness() {
  const calls = [];
  return { calls, worker: createExecutionWorker({ getClientIp: () => '203.0.113.7', fetch: async (url, init) => {
    calls.push({ url, init });
    return json(execution.responses['status.reserved'], 'X-Domino-Execution-Contract', '1.0.0-rc.1');
  } }) };
}
const tripwire = (calls) => async (url) => { calls.push(String(url)); throw new Error('no upstream call is expected'); };
async function refused(result, code = 'origin_not_allowed', label = code) {
  assert.deepEqual(await result.json(), { error: code }, label);
  assert.equal(result.status, code === 'origin_not_allowed' ? 403 : 503, label);
  assert.equal(result.headers.get('Set-Cookie'), null);
  assert.equal(result.headers.get('Access-Control-Allow-Origin'), null);
}

test('the session Worker admits the listed preview from its own host and tells the listener it was the preview', async () => {
  const h = sessionHarness();
  for (const [page, route] of [[preview, 'bootstrap'], [app, 'bootstrap'], [preview, 'me'], [app, 'me']]) {
    const result = await h.worker.fetch(sessionRequest(route, { url: page }), SESSION_ENV);
    assert.equal(result.status, 200, `${page} ${route}`);
    assert.equal(h.calls.at(-1).init.headers['X-Domino-Browser-Origin'], page, 'the admitted origin, never another');
    if (route === 'bootstrap') {
      // __Host-: host-only, so the preview's cookie is the preview host's alone (and production's is production's).
      assert.deepEqual(result.headers.getSetCookie(),
        [`__Host-domino-preauth=${preauth}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600`]);
    }
  }
  // A same-origin GET of me may omit Origin on the preview as on production: the URL's origin is the one admitted.
  const reload = await h.worker.fetch(sessionRequest('me', { origin: null, headers: { Cookie: `__Host-domino-session=${token}` } }), SESSION_ENV);
  assert.equal(reload.status, 200);
  assert.equal(h.calls.at(-1).init.headers['X-Domino-Browser-Origin'], preview);
  assert.equal(h.calls.length, 5);
});

test('the authenticated transport admits the listed preview and names it upstream', async () => {
  const h = executionHarness();
  for (const page of [preview, app]) {
    const result = await h.worker.fetch(executionRequest({ url: page }), EXECUTION_ENV);
    assert.equal(result.status, 200, await result.clone().text());
    assert.equal(h.calls.at(-1).init.headers['X-Domino-Browser-Origin'], page);
  }
});

test('the capabilities GETs of crosschain and position-plan answer the listed preview as they answer production', async () => {
  for (const [family, worker, env, header, version] of [
    ['crosschain', createCrosschainWorker({ fetch: tripwire([]) }), CROSSCHAIN_ENV, 'X-Domino-Crosschain-Contract', CROSSCHAIN_VERSION],
    ['position-plan', createPositionPlanWorker({ fetch: tripwire([]) }), PLAN_ENV, 'X-Domino-Position-Plan-Contract', PLAN_VERSION],
  ]) {
    for (const [url, origin] of [[preview, preview], [preview, undefined], [app, app]]) {
      const result = await worker.fetch(capabilitiesRequest(family, { url, origin }), env);
      assert.equal(result.status, 200, `${family} ${url}`);
      assert.equal(result.headers.get(header), version);
      assert.equal((await result.json()).dataMode, 'live');
    }
    for (const origin of [...FOREIGN, 'https://PREVIEW.pages-project.invalid', app]) {
      await refused(await worker.fetch(capabilitiesRequest(family, { origin }), env));
    }
    await refused(await worker.fetch(capabilitiesRequest(family, { url: app, origin: preview }), env));
    await refused(await worker.fetch(capabilitiesRequest(family), { ...env, PREVIEW_ORIGINS: '' }));
  }
});

test('nothing but the listed origin passes: other hosts, suffixes, schemes, ports, cases and pairings are refused', async () => {
  const session = sessionHarness(), transport = executionHarness();
  const cases = [
    // The page on a foreign host, saying so.
    ...FOREIGN.map((origin) => ({ url: origin, origin })),
    // The listed host's URL with any other Origin, the production origin included.
    ...[...FOREIGN, ...MISSPELLED, app].map((origin) => ({ url: preview, origin })),
    // Production's URL with the preview's Origin: two admitted origins are still two.
    { url: app, origin: preview },
    // The listed host, but a sibling deployment's fetch (same site, not same origin) or a navigation.
    { url: preview, headers: { 'Sec-Fetch-Site': 'same-site' } },
    { url: preview, headers: { 'Sec-Fetch-Site': 'cross-site' } },
    { url: preview, headers: { 'Sec-Fetch-Mode': 'navigate' } },
    { url: preview, headers: { Host: 'other.pages-project.invalid' } },
  ];
  for (const options of cases) {
    const label = JSON.stringify(options);
    for (const route of ['bootstrap', 'me']) {
      await refused(await session.worker.fetch(sessionRequest(route, options), SESSION_ENV), 'origin_not_allowed', `${route} ${label}`);
    }
    await refused(await transport.worker.fetch(executionRequest(options), EXECUTION_ENV), 'origin_not_allowed', label);
  }
  // A POST from the preview must name it; only me, a GET, may leave Origin out.
  await refused(await session.worker.fetch(sessionRequest('bootstrap', { origin: null }), SESSION_ENV));
  await refused(await transport.worker.fetch(executionRequest({ origin: null }), EXECUTION_ENV));
  assert.equal(session.calls.length + transport.calls.length, 0);
});

test('no preview is admitted unless one is listed: unset and empty keep production alone', async () => {
  const session = sessionHarness(), transport = executionHarness();
  for (const listed of [undefined, '']) {
    const sessionEnv = { ...SESSION_ENV, PREVIEW_ORIGINS: listed }, executionEnv = { ...EXECUTION_ENV, PREVIEW_ORIGINS: listed };
    await refused(await session.worker.fetch(sessionRequest('bootstrap'), sessionEnv));
    await refused(await session.worker.fetch(sessionRequest('me', { origin: null }), sessionEnv));
    await refused(await transport.worker.fetch(executionRequest(), executionEnv));
    assert.equal((await session.worker.fetch(sessionRequest('bootstrap', { url: app }), sessionEnv)).status, 200);
    assert.equal((await transport.worker.fetch(executionRequest({ url: app }), executionEnv)).status, 200);
  }
  assert.equal(session.calls.length + transport.calls.length, 4);
});

test('a second listed preview is admitted from its own host, and never speaks for the first', async () => {
  const second = 'https://p3-testing.pages-project.invalid';
  const env = { ...SESSION_ENV, PREVIEW_ORIGINS: `${preview},${second}` };
  const h = sessionHarness();
  for (const page of [preview, second]) {
    assert.equal((await h.worker.fetch(sessionRequest('bootstrap', { url: page }), env)).status, 200);
    assert.equal(h.calls.at(-1).init.headers['X-Domino-Browser-Origin'], page);
  }
  await refused(await h.worker.fetch(sessionRequest('bootstrap', { url: preview, origin: second }), env));
  await refused(await h.worker.fetch(sessionRequest('bootstrap', { url: second, origin: preview }), env));
  assert.equal(h.calls.length, 2);
});

// Changed on purpose 2026-11-04 (review L3): a broken list used to answer upstream_unavailable to production too. It
// now turns preview admission off, and only that: production serves, every preview is refused, the error is logged.
const BROKEN = (() => {
  const longest = `https://${Array(4).fill('a'.repeat(63)).join('.')}.dev`;
  assert.ok(longest.length > 261);
  return [
    'https://*.pages-project.invalid', '*.pages-project.invalid', '.pages-project.invalid', 'https://*',
    'http://preview.pages-project.invalid', `${preview}/`, `${preview}/api`, `${preview}:443`, `${preview}:8443`,
    'https://PREVIEW.pages-project.invalid', 'https://preview.Pages-Project.invalid', 'preview.pages-project.invalid',
    'https://user@preview.pages-project.invalid', 'https://192.0.2.1', 'https://[2001:db8::1]', 'https://preview.pages-project.invalid.',
    'https://-preview.pages-project.invalid', 'https://preview-.pages-project.invalid', 'https://preview_x.pages-project.invalid',
    `${preview}, https://other.pages-project.invalid`, `${preview},`, `,${preview}`, `${preview},${preview}`, ' ',
    Array.from({ length: MAX_PREVIEW_ORIGINS + 1 }, (_, n) => `https://b${n}.pages-project.invalid`).join(','),
    app, longest, true, ['https://preview.pages-project.invalid'], new String(preview),
  ];
})();

/** console.error, recorded: the Workers' loud error when a list is malformed. */
function logged(t) {
  const lines = [];
  t.mock.method(console, 'error', (line) => { lines.push(JSON.parse(line)); });
  return lines;
}

test('a malformed list turns preview admission off and only that: production serves, every preview is refused, loudly', async (t) => {
  for (const listed of BROKEN) {
    t.mock.restoreAll();
    const lines = logged(t);
    const session = sessionHarness(), transport = executionHarness();
    const sessionEnv = { ...SESSION_ENV, PREVIEW_ORIGINS: listed }, executionEnv = { ...EXECUTION_ENV, PREVIEW_ORIGINS: listed };
    assert.equal((await session.worker.fetch(sessionRequest('bootstrap', { url: app }), sessionEnv)).status, 200, String(listed));
    assert.equal(session.calls.at(-1).init.headers['X-Domino-Browser-Origin'], app);
    assert.equal((await transport.worker.fetch(executionRequest({ url: app }), executionEnv)).status, 200, String(listed));
    // Whatever the list meant to admit, nothing of it is: the listed host's own request is refused.
    for (const page of [preview, 'https://b0.pages-project.invalid', 'https://p3-testing.pages-project.invalid']) {
      await refused(await session.worker.fetch(sessionRequest('bootstrap', { url: page }), sessionEnv), 'origin_not_allowed', String(listed));
      await refused(await transport.worker.fetch(executionRequest({ url: page }), executionEnv), 'origin_not_allowed', String(listed));
    }
    for (const [family, worker, env, label] of [
      ['crosschain', createCrosschainWorker({ fetch: tripwire([]) }), CROSSCHAIN_ENV, 'crosschain-bridge'],
      ['position-plan', createPositionPlanWorker({ fetch: tripwire([]) }), PLAN_ENV, 'position-plan-bridge'],
    ]) {
      assert.equal((await worker.fetch(capabilitiesRequest(family, { url: app, origin: app }), { ...env, PREVIEW_ORIGINS: listed })).status, 200);
      await refused(await worker.fetch(capabilitiesRequest(family, { origin: preview }), { ...env, PREVIEW_ORIGINS: listed }));
      assert.ok(lines.some((line) => line.service === label), label);
    }
    assert.equal(session.calls.length + transport.calls.length, 2, String(listed));
    assert.ok(lines.length >= 8, String(listed));
    for (const line of lines) assert.deepEqual({ ...line, service: undefined }, { service: undefined, error: 'preview_origins_invalid', previewAdmission: 'off' });
    assert.ok(lines.some((line) => line.service === 'session-bridge') && lines.some((line) => line.service === 'execution-bridge'));
  }
});

test('a valid list logs nothing, and the most a list may hold is admitted, each from its own host', async (t) => {
  const lines = logged(t);
  const most = Array.from({ length: MAX_PREVIEW_ORIGINS }, (_, n) => `https://b${n}.pages-project.invalid`);
  const h = sessionHarness();
  for (const page of most) {
    assert.equal((await h.worker.fetch(sessionRequest('bootstrap', { url: page }), { ...SESSION_ENV, PREVIEW_ORIGINS: most.join(',') })).status, 200);
  }
  for (const listed of [undefined, '', preview]) {
    assert.equal((await h.worker.fetch(sessionRequest('bootstrap', { url: app }), { ...SESSION_ENV, PREVIEW_ORIGINS: listed })).status, 200);
  }
  assert.deepEqual(lines, []);
});

test('the gateway is never a browser origin: listing it turns preview admission off, production serves', async (t) => {
  const lines = logged(t);
  const session = sessionHarness(), transport = executionHarness();
  const sessionEnv = { ...SESSION_ENV, PREVIEW_ORIGINS: `${preview},${SESSION_ENV.SESSION_GATEWAY_ORIGIN}` };
  const executionEnv = { ...EXECUTION_ENV, PREVIEW_ORIGINS: EXECUTION_ENV.EXECUTION_GATEWAY_ORIGIN };
  assert.equal((await session.worker.fetch(sessionRequest('bootstrap', { url: app }), sessionEnv)).status, 200);
  await refused(await session.worker.fetch(sessionRequest('bootstrap', { url: preview }), sessionEnv));
  await refused(await session.worker.fetch(sessionRequest('bootstrap', { url: SESSION_ENV.SESSION_GATEWAY_ORIGIN }), sessionEnv));
  assert.equal((await transport.worker.fetch(executionRequest({ url: app }), executionEnv)).status, 200);
  await refused(await transport.worker.fetch(executionRequest({ url: EXECUTION_ENV.EXECUTION_GATEWAY_ORIGIN }), executionEnv));
  for (const [family, worker, env, key] of [
    ['crosschain', createCrosschainWorker({ fetch: tripwire([]) }), CROSSCHAIN_ENV, 'CROSSCHAIN_GATEWAY_ORIGIN'],
    ['position-plan', createPositionPlanWorker({ fetch: tripwire([]) }), PLAN_ENV, 'POSITION_PLAN_GATEWAY_ORIGIN'],
  ]) {
    assert.equal((await worker.fetch(capabilitiesRequest(family, { url: app, origin: app }), { ...env, PREVIEW_ORIGINS: env[key] })).status, 200);
    await refused(await worker.fetch(capabilitiesRequest(family, { url: env[key], origin: env[key] }), { ...env, PREVIEW_ORIGINS: env[key] }));
  }
  assert.equal(lines.filter((line) => line.error === 'preview_origins_invalid').length, lines.length);
  assert.ok(lines.length >= 6);
  // APP_ORIGIN as its own gateway is production's misconfiguration, which still refuses everything (unchanged).
  await refused(await session.worker.fetch(sessionRequest('bootstrap', { url: app }), { ...SESSION_ENV, SESSION_GATEWAY_ORIGIN: app }), 'upstream_unavailable');
});
