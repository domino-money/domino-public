/**
 * /uniswap-v3/{read,actions}/v1/<route> at this site's edge (functions/_lib/uniswap-v3/edge.ts and
 * functions/_lib/uniswap-v3/handler.ts, 2026-10-01, the chain2 workstream, audit item G9): 404 not_enabled without its
 * service binding; with it, only this site's own browser POSTs, credentials stripped, the canonical origin for his
 * Worker, his answer with this site's safety headers; capabilities kept at the edge under a key naming the chain id.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as read from '../functions/_lib/uniswap-v3/contracts/uniswap-v3-read-v1/runtime.mjs';
import * as actions from '../functions/_lib/uniswap-v3/contracts/uniswap-v3-actions-v1/runtime.mjs';

const require = createRequire(import.meta.url);
const edge = require('../.test-build/app/functions/_lib/uniswap-v3/edge.js');
const { APP_ORIGIN, PREVIEW_ORIGIN } = require('../.test-build/app/functions/_lib/bridge.js');
const { ELYSIUM } = require('../.test-build/app/src/config/chains.js');

const pinOf = (family) => JSON.parse(readFileSync(new URL(`../functions/_lib/uniswap-v3/contracts/${family}/pin.json`, import.meta.url), 'utf8'));
const READ_PIN = pinOf('uniswap-v3-read-v1');
const ACTIONS_PIN = pinOf('uniswap-v3-actions-v1');
const contract = (runtime, pin) => ({ CONTRACT_VERSION: runtime.CONTRACT_VERSION, ROUTES: runtime.ROUTES, validateRequest: runtime.validateRequest, validateResponse: runtime.validateResponse, pin });
const CONTRACTS = { read: contract(read, READ_PIN), actions: contract(actions, ACTIONS_PIN) };
const WIRE = JSON.parse(readFileSync(new URL('./fixtures/elysium/uniswap-v3-read-v1.wire.json', import.meta.url), 'utf8'));
const H = 'X-Domino-Uniswap-V3-Read-Contract';

function memoryCache() {
  const map = new Map();
  return {
    map,
    match: async (request) => map.get(request.url)?.clone(),
    put: async (request, response) => void map.set(request.url, response.clone()),
    delete: async (request) => map.delete(request.url),
  };
}

function runtime({ cache = memoryCache(), now = () => 1_000_000 } = {}) {
  return { contracts: CONTRACTS, cache, now };
}

/** A browser's same-origin POST from `origin`. */
function browserPost(origin, path, body = WIRE.requests.capabilities, extra = {}) {
  return new Request(`${origin}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty',
      [H]: READ_PIN.contractVersion,
      [`${H}-Digest`]: READ_PIN.manifestSha256,
      Cookie: '__Host-domino-beta=secret; other=1',
      Authorization: 'Bearer nope',
      'CF-Access-Client-Id': 'x',
      'X-Forwarded-For': '1.2.3.4',
      ...extra,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

/** His Worker as a binding: records what reached it, answers `reply()`. */
function binding(reply = () => his(WIRE.responses.capabilities)) {
  const seen = [];
  return {
    seen,
    fetch: async (request) => {
      seen.push({ url: request.url, method: request.method, headers: Object.fromEntries(request.headers), body: await request.text() });
      return reply(request);
    },
  };
}

const his = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', [H]: READ_PIN.contractVersion, [`${H}-Digest`]: READ_PIN.manifestSha256, 'Set-Cookie': 'x=1', 'Access-Control-Allow-Origin': APP_ORIGIN, 'Cache-Control': 'public, max-age=999', ...extra } });

const answer = (request, env, rt = runtime()) => edge.answerUniswapV3(request, env, rt);
const errorOf = async (response) => (await response.json()).error;

test('without the service binding every route of his answers 404 not_enabled; anything else 404 not_found', async () => {
  const response = await answer(browserPost(APP_ORIGIN, '/uniswap-v3/read/v1/capabilities'), {});
  assert.equal(response.status, 404);
  assert.equal(await errorOf(response), 'not_enabled');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get(H), null, 'this site\'s own answer carries no contract header');
  for (const path of ['/uniswap-v3/read/v1/nope', '/uniswap-v3/read/v2/capabilities', '/uniswap-v3/write/v1/prepare', '/uniswap-v3/read/v1/capabilities?x=1', '/uniswap-v3//read/v1/capabilities']) {
    const r = await answer(browserPost(APP_ORIGIN, path), {});
    assert.deepEqual([r.status, await errorOf(r)], [404, 'not_found'], path);
  }
});

test('only this site\'s own origins: production, and the preview alias only where CHAIN2_PREVIEW is "true"', async () => {
  const bridge = binding();
  for (const origin of ['https://abc123.domino-app-e65.pages.dev', 'https://evil.example', PREVIEW_ORIGIN]) {
    const r = await answer(browserPost(origin, '/uniswap-v3/read/v1/capabilities'), { ELYSIUM_BRIDGE: bridge });
    assert.deepEqual([r.status, await errorOf(r)], [404, 'not_found'], origin);
  }
  const preview = await answer(browserPost(PREVIEW_ORIGIN, '/uniswap-v3/read/v1/capabilities'), { ELYSIUM_BRIDGE: bridge, CHAIN2_PREVIEW: 'true' });
  assert.equal(preview.status, 200);
  assert.equal(bridge.seen.length, 1);
});

test('only a browser\'s own same-origin JSON POST reaches his Worker', async () => {
  const bridge = binding();
  const env = { ELYSIUM_BRIDGE: bridge };
  const path = '/uniswap-v3/read/v1/capabilities';
  const cases = [
    [browserPost(APP_ORIGIN, path, undefined, { 'CF-Worker': 'example.com' }), 403, 'worker_subrequest_refused'],
    [new Request(`${APP_ORIGIN}${path}`, { method: 'GET' }), 405, 'method_not_allowed'],
    [browserPost(APP_ORIGIN, path, undefined, { Origin: 'https://evil.example' }), 403, 'origin_not_allowed'],
    [browserPost(APP_ORIGIN, path, undefined, { 'Sec-Fetch-Site': 'cross-site' }), 403, 'origin_not_allowed'],
    [browserPost(APP_ORIGIN, path, undefined, { 'Sec-Fetch-Mode': 'navigate' }), 403, 'origin_not_allowed'],
    [browserPost(APP_ORIGIN, path, undefined, { 'Sec-Fetch-User': '?1' }), 403, 'origin_not_allowed'],
    [browserPost(APP_ORIGIN, path, undefined, { 'Content-Type': 'text/plain' }), 415, 'unsupported_media_type'],
    [browserPost(APP_ORIGIN, path, 'x'.repeat(edge.MAX_REQUEST_BYTES + 1)), 413, 'body_too_large'],
  ];
  for (const [request, status, error] of cases) {
    const r = await answer(request, env);
    assert.deepEqual([r.status, await errorOf(r)], [status, error]);
  }
  assert.equal(bridge.seen.length, 0, 'none of them reached his Worker');
});

test('what reaches his Worker: the canonical URL and Origin, his contract headers, the body; no cookie and no credential', async () => {
  const bridge = binding(() => his(WIRE.responses.pool));
  const body = WIRE.requests.pool;
  const r = await answer(browserPost(PREVIEW_ORIGIN, '/uniswap-v3/read/v1/pool', body), { ELYSIUM_BRIDGE: bridge, CHAIN2_PREVIEW: 'true' });
  assert.equal(r.status, 200);
  const [seen] = bridge.seen;
  assert.equal(seen.url, `${APP_ORIGIN}/uniswap-v3/read/v1/pool`);
  assert.equal(seen.method, 'POST');
  assert.deepEqual(JSON.parse(seen.body), body);
  assert.deepEqual(Object.keys(seen.headers).sort(), ['content-type', 'origin', H.toLowerCase(), `${H}-Digest`.toLowerCase()].sort());
  assert.equal(seen.headers.origin, APP_ORIGIN);
  assert.equal(seen.headers[H.toLowerCase()], READ_PIN.contractVersion);
});

test('his answer leaves with this site\'s safety headers and his contract headers, and nothing of his cookies or CORS', async () => {
  const bridge = binding(() => his(WIRE.responses.pool));
  const r = await answer(browserPost(APP_ORIGIN, '/uniswap-v3/read/v1/pool', WIRE.requests.pool), { ELYSIUM_BRIDGE: bridge });
  assert.deepEqual(await r.json(), WIRE.responses.pool);
  assert.equal(r.headers.get('Cache-Control'), 'no-store');
  assert.equal(r.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.equal(r.headers.get('Content-Security-Policy'), "default-src 'none'; frame-ancestors 'none'");
  assert.equal(r.headers.get(H), READ_PIN.contractVersion);
  assert.equal(r.headers.get(`${H}-Digest`), READ_PIN.manifestSha256);
  assert.equal(r.headers.get('Set-Cookie'), null);
  assert.equal(r.headers.get('Access-Control-Allow-Origin'), null);
  // His refusal keeps its status and body.
  const refused = await answer(browserPost(APP_ORIGIN, '/uniswap-v3/read/v1/pool', WIRE.requests.pool), { ELYSIUM_BRIDGE: binding(() => his({ error: 'service_disabled' }, 404)) });
  assert.deepEqual([refused.status, await errorOf(refused)], [404, 'service_disabled']);
  const broken = await answer(browserPost(APP_ORIGIN, '/uniswap-v3/read/v1/pool', WIRE.requests.pool), { ELYSIUM_BRIDGE: { fetch: async () => { throw new Error('down'); } } });
  assert.deepEqual([broken.status, await errorOf(broken)], [503, 'bridge_unavailable']);
});

test('capabilities is kept at the edge for 30 s, under a key naming the origin and the chain id, when his runtime validates it', async () => {
  let now = 1_000_000;
  const cache = memoryCache();
  const rt = runtime({ cache, now: () => now });
  const bridge = binding();
  const env = { ELYSIUM_BRIDGE: bridge };
  const first = await answer(browserPost(APP_ORIGIN, '/uniswap-v3/read/v1/capabilities'), env, rt);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get(edge.EDGE_HEADER), null);
  const [key] = cache.map.keys();
  assert.equal(key, edge.edgeKey(APP_ORIGIN, ELYSIUM.id, 'read', READ_PIN.contractVersion, READ_PIN.manifestSha256));
  assert.ok(key.includes(`/${ELYSIUM.id}/`), 'the chain id is in the key');
  const second = await answer(browserPost(APP_ORIGIN, '/uniswap-v3/read/v1/capabilities'), env, rt);
  assert.equal(second.headers.get(edge.EDGE_HEADER), 'hit');
  assert.deepEqual(await second.json(), WIRE.responses.capabilities);
  assert.equal(second.headers.get(H), READ_PIN.contractVersion);
  assert.equal(bridge.seen.length, 1, 'the second came from the edge');
  now += edge.CAPABILITIES_SECONDS * 1000;
  await answer(browserPost(APP_ORIGIN, '/uniswap-v3/read/v1/capabilities'), env, rt);
  assert.equal(bridge.seen.length, 2, 'past 30 s his Worker is asked again');
});

test('nothing else is kept: an invalid or unpinned capabilities answer, another route, another chain id, a wrong digest', async () => {
  const cases = [
    [() => his({ ...WIRE.responses.capabilities, extra: 1 }), WIRE.requests.capabilities, 'capabilities', {}],
    [() => his(WIRE.responses.capabilities, 200, { [H]: '1.0.0-rc.1' }), WIRE.requests.capabilities, 'capabilities', {}],
    [() => his(WIRE.responses.pool), WIRE.requests.pool, 'pool', {}],
    [() => his(WIRE.responses.capabilities), { chainId: 4663, protocol: 'uniswap-v3' }, 'capabilities', {}],
    [() => his(WIRE.responses.capabilities), WIRE.requests.capabilities, 'capabilities', { [`${H}-Digest`]: '0'.repeat(64) }],
  ];
  for (const [reply, body, route, extra] of cases) {
    const cache = memoryCache();
    await answer(browserPost(APP_ORIGIN, `/uniswap-v3/read/v1/${route}`, body, extra), { ELYSIUM_BRIDGE: binding(reply) }, runtime({ cache }));
    assert.equal(cache.map.size, 0, JSON.stringify(body));
  }
});

test('preview and production never share a kept answer, and every key carries a chain id', async () => {
  const cache = memoryCache();
  const rt = runtime({ cache });
  await answer(browserPost(APP_ORIGIN, '/uniswap-v3/read/v1/capabilities'), { ELYSIUM_BRIDGE: binding() }, rt);
  await answer(browserPost(PREVIEW_ORIGIN, '/uniswap-v3/read/v1/capabilities'), { ELYSIUM_BRIDGE: binding(), CHAIN2_PREVIEW: 'true' }, rt);
  assert.deepEqual([...cache.map.keys()].sort(), [edge.edgeKey(APP_ORIGIN, ELYSIUM.id, 'read', READ_PIN.contractVersion, READ_PIN.manifestSha256), edge.edgeKey(PREVIEW_ORIGIN, ELYSIUM.id, 'read', READ_PIN.contractVersion, READ_PIN.manifestSha256)].sort());
  assert.throws(() => edge.edgeKey(APP_ORIGIN, 0, 'read', 'v', 'd'));
  assert.throws(() => edge.edgeKey(APP_ORIGIN, Number.NaN, 'read', 'v', 'd'));
});

// Changed on purpose 2026-10-01 (the chain2 workstream, part B): the route file exists now, and it is one line that names
// this handler as the route's onRequest; tests/owned.test.mjs reads Pages' own route table for it, and
// tests/gate.test.mjs what the middleware does on the way.
test('the handler hands in his runtimes and pins, vendored inside functions/, and its one route file routes to it', () => {
  const handler = readFileSync(new URL('../functions/_lib/uniswap-v3/handler.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const imports = [...handler.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(imports, ['./contracts/uniswap-v3-read-v1/runtime.mjs', './contracts/uniswap-v3-actions-v1/runtime.mjs', './contracts/uniswap-v3-read-v1/pin.json', './contracts/uniswap-v3-actions-v1/pin.json', '../publicEdge', './edge']);
  assert.match(handler, /export async function onUniswapV3Request\(/);
  // Pages routes a file by an export named onRequest (or onRequestGet, …): none in the handler, which a route file names.
  assert.doesNotMatch(handler, /export\s+(?:async\s+)?(?:function|const)\s+onRequest/);
  const route = readFileSync(new URL('../functions/uniswap-v3/[[path]].ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').trim();
  assert.equal(route, "export { onUniswapV3Request as onRequest } from '../_lib/uniswap-v3/handler'", 'the route file names the handler, and does nothing else');
  assert.deepEqual(readdirSync(new URL('../functions/uniswap-v3/', import.meta.url)), ['[[path]].ts'], 'one route file');
});

test('his runtimes and pins as the handler takes them validate his fixtures, so the edge checks with his own code', () => {
  for (const [name, c] of Object.entries(CONTRACTS)) {
    assert.equal(c.pin.contractVersion, c.CONTRACT_VERSION, name);
    assert.ok(c.ROUTES.includes('capabilities'));
  }
  assert.ok(CONTRACTS.read.validateResponse('capabilities', WIRE.responses.capabilities));
  assert.equal(CONTRACTS.read.validateResponse('capabilities', { ...WIRE.responses.capabilities, chainId: 4663 }), false);
});
