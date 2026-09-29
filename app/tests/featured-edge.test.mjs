/**
 * POST /api/read/v5/featured-pools at the edge (functions/_lib/featuredEdge.ts,
 * functions/api/read/v5/featured-pools.ts; featured-pools v1 §10.3, §10.6):
 * the forwarder hands the request to the read Worker, only a valid 200 is kept
 * in the edge cache for 60 seconds under a synthetic GET key, only a request
 * the Worker would have answered with the list is answered from it, and the
 * gate still comes first and still sends no-store.
 *
 * The Worker is a recorder standing in for the READ_BRIDGE binding, except in
 * the last tests, which run the real read Worker (bridge/src/worker.mjs) with
 * its committed, disabled config and with read-v5 switched on over a fake
 * gateway. read-v5's own runtime is the contract throughout.
 *
 * Added 2026-09-26.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as runtime from '../../api-contracts/read-v5/runtime.mjs';
import { createWorker } from '../../bridge/src/worker.mjs';

const require = createRequire(import.meta.url);
const { answerFeatured, cacheKey, FEATURED_PATH, LIST_SECONDS, STALE_SECONDS } = require('../.test-build/app/functions/_lib/featuredEdge.js');
const { REFRESH_GUARD_MS } = require('../.test-build/app/functions/_lib/publicEdge.js');
const { onRequest: gate, LOGIN_PATH, API_CSP } = require('../.test-build/app/functions/_middleware.js');

const ORIGIN = 'https://domino.money';
const VERSION = runtime.CONTRACT_VERSION;
const CONTRACT = { CONTRACT_VERSION: VERSION, validateRequest: runtime.validateRequest, validateResponse: runtime.validateResponse };
const FIXTURES = new URL('../../api-contracts/read-v5/fixtures/', import.meta.url);
const fixtures = (kind) => readdirSync(new URL(`${kind}/`, FIXTURES)).filter((name) => name.endsWith('.json')).sort()
  .map((name) => [name, readFileSync(new URL(`${kind}/${name}`, FIXTURES), 'utf8')]);
const VALID = fixtures('valid');
const INVALID = fixtures('invalid');
const CURRENT = VALID.find(([name]) => name === 'current.json')[1];
const NONE = VALID.find(([name]) => name === 'none.json')[1];

/** The list read as the browser's fetch() sends it, as the edge hands it on. */
function ask({ url = `${ORIGIN}${FEATURED_PATH}`, method = 'POST', body = '{}', headers = {} } = {}) {
  const all = new Headers({
    Host: new URL(url).host,
    Origin: ORIGIN,
    'Content-Type': 'application/json',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'X-Domino-Read-Contract': VERSION,
    'CF-Connecting-IP': '203.0.113.9',
  });
  if (typeof body === 'string' || body instanceof Uint8Array) all.set('Content-Length', String(Buffer.byteLength(body)));
  for (const [name, value] of Object.entries(headers)) {
    if (value === null) all.delete(name);
    else all.set(name, value);
  }
  return new Request(url, { method, headers: all, ...(method === 'GET' || method === 'HEAD' ? {} : { body }) });
}

/** A read Worker's answer as bridge/src/worker.mjs writes it. */
function said(body = CURRENT, { status = 200, version = VERSION, type = 'application/json; charset=utf-8' } = {}) {
  return new Response(body, { status, headers: {
    'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    'X-Domino-Read-Contract': version, 'X-Domino-Request-Id': crypto.randomUUID(),
  } });
}

/** The READ_BRIDGE binding: keeps what reached it and answers `answer()`. */
function bridge(answer = () => said()) {
  const calls = [];
  return { calls, env: { READ_BRIDGE: { async fetch(request) { calls.push({ url: request.url, body: await request.clone().text(), headers: Object.fromEntries(request.headers) }); return answer(request); } } } };
}

/** caches.default, in memory, keyed like the Cache API: GET requests by URL. */
function memoryCache() {
  const entries = new Map();
  const puts = [];
  return {
    entries, puts,
    async match(request) {
      assert.equal(request.method, 'GET', 'the Cache API keeps GET only');
      const entry = entries.get(request.url);
      return entry ? entry.clone() : undefined;
    },
    async put(request, response) {
      assert.equal(request.method, 'GET', 'the Cache API keeps GET only');
      puts.push({ url: request.url, cacheControl: response.headers.get('Cache-Control') });
      entries.set(request.url, new Response(await response.text(), response));
    },
  };
}

function clock(start = Date.UTC(2026, 8, 26, 12)) {
  const at = { now: start };
  return { at, now: () => at.now };
}

const runtimeWith = (cache, time = clock(), extra = {}) => ({ contract: CONTRACT, cache, now: time.now, refreshing: new Map(), ...extra });

// Changed on purpose 2026-09-28 (speed wave, item 7, the owner's OK): a list older than 60 s is still served, for up to
// 15 minutes, while the request that found it goes on to the Worker in the background; the entry lives that long.
test('a valid list is passed on byte for byte and kept once; within 60 s the same question is answered from the edge', async () => {
  const cache = memoryCache();
  const time = clock();
  const { calls, env } = bridge();
  const later = [];
  const refreshing = new Map();
  const runtime = () => runtimeWith(cache, time, { waitUntil: (work) => later.push(work), refreshing });
  const first = await answerFeatured(ask(), env, runtime());
  assert.equal(first.status, 200);
  assert.equal(await first.text(), CURRENT);
  assert.equal(first.headers.get('X-Domino-Read-Contract'), VERSION);
  assert.match(first.headers.get('X-Domino-Request-Id'), /^[0-9a-f-]{36}$/, 'a Worker answer keeps its request id');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ORIGIN}${FEATURED_PATH}`);
  assert.equal(calls[0].body, '{}', 'the request goes on untouched');
  await Promise.all(later.splice(0));
  assert.deepEqual(cache.puts, [{ url: `${ORIGIN}/api/read/v5/cache/${VERSION}/featured-pools`, cacheControl: `max-age=${STALE_SECONDS}` }]);
  assert.equal(cacheKey(VERSION), cache.puts[0].url);
  assert.equal(first.headers.get('X-Domino-Edge-Cache'), null, 'the Worker answered');

  time.at.now += LIST_SECONDS * 1000 - 1;
  const hit = await answerFeatured(ask({ body: ' { }\n', headers: { 'X-Domino-Read-Contract': null } }), env, runtime());
  assert.equal(hit.status, 200);
  assert.equal(await hit.text(), CURRENT);
  assert.equal(hit.headers.get('Cache-Control'), 'no-store');
  assert.equal(hit.headers.get('X-Domino-Read-Contract'), VERSION);
  assert.equal(hit.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.match(hit.headers.get('Content-Type'), /^application\/json/);
  assert.equal(hit.headers.get('X-Domino-Request-Id'), null, 'no Worker handled it');
  assert.equal(hit.headers.get('X-Domino-Edge-Cache'), 'hit', 'and it says where it came from');
  assert.equal(calls.length, 1, 'the edge answered');
  assert.equal(later.length, 0, 'nothing to refresh within 60 s');
  assert.equal(cache.puts.length, 1);

  // From 60 s the entry is still served at once, and the request that found it goes on to the Worker in the background,
  // once, whose answer is kept for the next visitor.
  time.at.now += 1;
  const stale = await answerFeatured(ask(), env, runtime());
  assert.equal(await stale.text(), CURRENT);
  assert.equal(stale.headers.get('X-Domino-Edge-Cache'), null, 'the request that sends the refresh is counted by the gateway: no hit');
  const again = await answerFeatured(ask(), env, runtime());
  assert.equal(again.headers.get('X-Domino-Edge-Cache'), 'hit');
  assert.equal(later.length, 1, 'one refresh at a time');
  await Promise.all(later.splice(0));
  assert.equal(calls.length, 2);
  assert.equal(calls[1].body, '{}', 'the request as it came');
  assert.equal(cache.puts.length, 2);
  assert.equal(refreshing.size, 0);
  // Past 15 minutes it is not served at all.
  time.at.now += STALE_SECONDS * 1000;
  const gone = await answerFeatured(ask(), env, runtime());
  assert.equal(gone.headers.get('X-Domino-Edge-Cache'), null);
  assert.equal(calls.length, 3);
});

// Added 2026-09-28 (speed wave, item 7): switching the list off still reaches every visitor at their next read. The
// background read of a kept list meets the Worker's 404 route_not_available and takes the entry out.
test('a list switched off is taken out of the edge by the background read that meets the refusal; a failure leaves it', async () => {
  const cache = memoryCache();
  cache.delete = async (request) => cache.entries.delete(request.url);
  const time = clock();
  let off = false;
  let broken = false;
  const { calls, env } = bridge(() => (off ? said('{"error":"route_not_available"}', { status: 404 }) : broken ? said('{"error":"upstream_unavailable"}', { status: 503 }) : said()));
  const later = [];
  const refreshing = new Map();
  const runtime = () => runtimeWith(cache, time, { waitUntil: (work) => later.push(work), refreshing });
  await answerFeatured(ask(), env, runtime());
  await Promise.all(later.splice(0));
  broken = true;
  time.at.now += LIST_SECONDS * 1000;
  assert.equal(await (await answerFeatured(ask(), env, runtime())).text(), CURRENT, 'served, and refreshed behind');
  await Promise.all(later.splice(0));
  assert.equal(cache.entries.size, 1, 'a failed refresh leaves the entry');
  broken = false; off = true;
  time.at.now += REFRESH_GUARD_MS;
  assert.equal(await (await answerFeatured(ask(), env, runtime())).text(), CURRENT, 'served, and refreshed behind');
  await Promise.all(later.splice(0));
  assert.equal(cache.entries.size, 0, 'the route is off: the entry is out');
  const next = await answerFeatured(ask(), env, runtime());
  assert.equal(next.status, 404, 'the next visitor gets the Worker' + String.fromCharCode(8217) + 's own refusal');
  assert.equal(calls.length, 4);
});

test('every valid answer is kept, none included, and every invalid one is passed on and never kept', async () => {
  for (const [name, text] of VALID) {
    const cache = memoryCache();
    const { env } = bridge(() => said(text));
    const response = await answerFeatured(ask(), env, runtimeWith(cache));
    assert.equal(await response.text(), text, name);
    assert.equal(cache.puts.length, 1, name);
  }
  assert.equal(INVALID.length, 50);
  for (const [name, text] of INVALID) {
    const cache = memoryCache();
    const { env } = bridge(() => said(text));
    const response = await answerFeatured(ask(), env, runtimeWith(cache));
    assert.equal(response.status, 200, name);
    assert.equal(await response.text(), text, `${name}: passed on as it came`);
    assert.equal(cache.puts.length, 0, `${name}: never kept`);
  }
});

test('only a 200 with the v5 contract header and JSON is kept: refusals, errors and anything else pass on as they came', async () => {
  const answers = [
    () => said('{"error":"route_not_available"}', { status: 404 }),
    () => said('{"error":"upstream_contract_mismatch"}', { status: 502 }),
    () => said('{"error":"upstream_unavailable"}', { status: 503 }),
    () => said('{"error":"read_capacity_busy"}', { status: 429 }),
    () => said('{"error":"upstream_timeout"}', { status: 504 }),
    () => said(CURRENT, { version: '3.0.0-rc.1' }),
    // A valid list under any other status is still not a list the Worker served.
    () => said(CURRENT, { status: 203 }),
    () => said(CURRENT, { status: 503 }),
    () => said(CURRENT, { version: null }),
    () => said(CURRENT, { type: 'text/html' }),
    () => said('not json'),
    () => said(`${CURRENT} trailing`),
    () => said(NONE.replace('"status": "none"', '"status": "done"')),
  ];
  for (const answer of answers) {
    const cache = memoryCache();
    const { calls, env } = bridge(answer);
    const expected = answer();
    const response = await answerFeatured(ask(), env, runtimeWith(cache));
    assert.equal(response.status, expected.status);
    assert.equal(await response.text(), await expected.text());
    assert.equal(cache.puts.length, 0);
    await answerFeatured(ask(), env, runtimeWith(cache));
    assert.equal(calls.length, 2, 'nothing was kept, so the Worker is asked again');
  }
});

test('a request the Worker would refuse is never answered from the edge, even with a list kept', async () => {
  const variants = {
    'a GET': { method: 'GET' },
    'a PUT of {}': { method: 'PUT' },
    'a query string': { url: `${ORIGIN}${FEATURED_PATH}?refresh=1` },
    'another path': { url: `${ORIGIN}${FEATURED_PATH}/` },
    'another origin in the URL': { url: `https://domino-app-e65.pages.dev${FEATURED_PATH}` },
    'another Origin': { headers: { Origin: 'https://evil.example' } },
    'no Origin': { headers: { Origin: null } },
    'a cross-site fetch': { headers: { 'Sec-Fetch-Site': 'cross-site' } },
    'a navigation': { headers: { 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'Sec-Fetch-User': '?1' } },
    'a user activation': { headers: { 'Sec-Fetch-User': '?1' } },
    'a document destination': { headers: { 'Sec-Fetch-Dest': 'document' } },
    'a no-cors fetch': { headers: { 'Sec-Fetch-Mode': 'no-cors' } },
    'another Host': { headers: { Host: 'evil.example' } },
    'another contract': { headers: { 'X-Domino-Read-Contract': '3.0.0-rc.1' } },
    'a text body': { headers: { 'Content-Type': 'text/plain' } },
    'an encoded body': { headers: { 'Content-Encoding': 'gzip' } },
    'no length': { headers: { 'Content-Length': null } },
    'a Worker subrequest': { headers: { 'CF-Worker': 'other.example' } },
    'a key': { body: '{"poolIds":[]}' },
    'an array': { body: '[]' },
    'null': { body: 'null' },
    'not JSON': { body: '{' },
    'a byte order mark': { body: '﻿{}' },
    'invalid UTF-8': { body: new Uint8Array([0x7b, 0xff, 0x7d]) },
    'too long': { body: `{${' '.repeat(8192)}}` },
  };
  for (const [label, variant] of Object.entries(variants)) {
    const cache = memoryCache();
    const { calls, env } = bridge((request) => new URL(request.url).pathname === FEATURED_PATH && request.method === 'POST'
      ? said() : said('{"error":"route_not_available"}', { status: 404 }));
    await answerFeatured(ask(), env, runtimeWith(cache));
    assert.equal(calls.length, 1);
    const refusal = { status: 422, body: '{"error":"invalid_request"}' };
    const worker = bridge(() => said(refusal.body, { status: refusal.status }));
    const response = await answerFeatured(ask(variant), worker.env, runtimeWith(cache));
    const text = await response.text();
    assert.notEqual(text, CURRENT, `${label}: answered from the edge`);
    if (label === 'another origin in the URL' || label === 'a Worker subrequest') {
      // The forwarder's own refusals: before any binding.
      assert.equal(worker.calls.length, 0, label);
    } else {
      assert.equal(worker.calls.length, 1, `${label}: the Worker decides`);
      assert.equal(response.status, refusal.status, label);
    }
    assert.equal(cache.puts.length, 1, `${label}: nothing more was kept`);
  }
});

test('a kept entry that is stale, from the future, unstamped or not a valid list is not served', async () => {
  const time = clock();
  const entries = [
    // Changed on purpose 2026-09-28 (speed wave, item 7): stale is past 15 minutes now.
    new Response(CURRENT, { headers: { 'X-Featured-Stored-At': String(time.at.now - STALE_SECONDS * 1000) } }),
    new Response(CURRENT, { headers: { 'X-Edge-Stored-At': String(time.at.now - STALE_SECONDS * 1000) } }),
    new Response(CURRENT, { headers: { 'X-Featured-Stored-At': String(time.at.now + 1) } }),
    new Response(CURRENT, { headers: {} }),
    new Response(CURRENT, { headers: { 'X-Featured-Stored-At': 'soon' } }),
    new Response(INVALID[0][1], { headers: { 'X-Featured-Stored-At': String(time.at.now) } }),
    new Response('{}', { headers: { 'X-Featured-Stored-At': String(time.at.now) } }),
  ];
  for (const entry of entries) {
    const cache = memoryCache();
    cache.entries.set(cacheKey(VERSION), entry);
    const { calls, env } = bridge(() => said(NONE));
    const response = await answerFeatured(ask(), env, runtimeWith(cache, time));
    assert.equal(await response.text(), NONE);
    assert.equal(calls.length, 1);
  }
});

test('a cache that fails, or none at all, leaves the Worker answering; a put goes to waitUntil when there is one', async () => {
  const broken = { match: async () => { throw new Error('cache down'); }, put: async () => { throw new Error('cache down'); } };
  for (const cache of [broken, null]) {
    const { calls, env } = bridge();
    const response = await answerFeatured(ask(), env, runtimeWith(cache));
    assert.equal(response.status, 200);
    assert.equal(await response.text(), CURRENT);
    assert.equal(calls.length, 1);
  }
  const cache = memoryCache();
  const pending = [];
  const { env } = bridge();
  await answerFeatured(ask(), env, { ...runtimeWith(cache), waitUntil: (work) => pending.push(work) });
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.equal(cache.puts.length, 1);
  // Without a binding it is the forwarder's refusal, and nothing is kept.
  const bare = memoryCache();
  const response = await answerFeatured(ask(), {}, runtimeWith(bare));
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'bridge_unavailable' });
  assert.equal(bare.puts.length, 0);
});

// ---------------------------------------------------------------------------
// Behind the gate, as Pages runs it
// ---------------------------------------------------------------------------

const GATE = { BETA_PASSWORD: 'featured-suite-beta-password-01', BETA_COOKIE_KEY: 'Qm4tX8rLw1Kp7ZcN3dVy6HhJ2gFa9ReU5oTiBwErSzD' };

async function betaCookie() {
  const response = await gate({
    request: new Request(`${ORIGIN}${LOGIN_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: ORIGIN }, body: `password=${encodeURIComponent(GATE.BETA_PASSWORD)}` }),
    env: GATE,
    next: async () => assert.fail('login reached the app'),
  });
  return response.headers.get('Set-Cookie').split(';')[0];
}

test('the gate comes first: no cookie, no list, from the edge or the Worker; with one, the answer leaves no-store with the API CSP', async () => {
  const cache = memoryCache();
  const { calls, env } = bridge();
  let reached = 0;
  const next = (request) => async (passed) => { reached += 1; return answerFeatured(passed ?? request, { ...GATE, ...env }, runtimeWith(cache)); };
  const request = ask();
  const refused = await gate({ request, env: { ...GATE, ...env }, next: next(request) });
  assert.equal(refused.status, 401);
  assert.deepEqual(await refused.json(), { error: 'beta_access_required' });
  assert.equal(reached, 0);

  const cookie = await betaCookie();
  for (const expected of ['worker', 'edge']) {
    const signed = ask({ headers: { Cookie: `${cookie}; __Host-domino-session=${'s'.repeat(43)}` } });
    const response = await gate({ request: signed, env: { ...GATE, ...env }, next: next(signed) });
    assert.equal(response.status, 200, expected);
    assert.equal(await response.text(), CURRENT);
    // Changed on purpose 2026-09-28 (speed wave, item 13): a public read may be compressed on the way.
    assert.equal(response.headers.get('Cache-Control'), 'no-store', `${expected}: the browser keeps nothing`);
    assert.equal(response.headers.get('Content-Security-Policy'), API_CSP);
  }
  assert.equal(reached, 2);
  assert.equal(calls.length, 1, 'the second came from the edge');
  assert.equal('cookie' in calls[0].headers, false, 'a public read carries no cookie');
});

test('with the real read Worker: the committed config answers route_not_available and nothing is kept; switched on, a gateway list is kept', async () => {
  const text = readFileSync(new URL('../../bridge/wrangler.read.toml', import.meta.url), 'utf8');
  const committed = Object.fromEntries([...text.matchAll(/^([A-Z0-9_]+) = "(.*)"$/gm)].map((match) => [match[1], match[2]]));
  assert.equal(committed.READ_V5_BRIDGE_ENABLED, 'false');
  assert.equal(committed.ENABLED_V5_READS, '');
  const gateway = [];
  const worker = createWorker({
    getClientIp: (request) => request.headers.get('CF-Connecting-IP'),
    fetch: async (url, init) => {
      gateway.push({ url, init });
      return new Response(CURRENT, { headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': VERSION } });
    },
  });
  const bound = (vars) => ({ READ_BRIDGE: { fetch: (request) => worker.fetch(request, vars) } });

  const cache = memoryCache();
  const off = await answerFeatured(ask(), bound(committed), runtimeWith(cache));
  assert.equal(off.status, 404);
  assert.deepEqual(await off.json(), { error: 'route_not_available' });
  assert.equal(off.headers.get('X-Domino-Read-Contract'), VERSION);
  assert.equal(cache.puts.length, 0);
  assert.equal(gateway.length, 0);

  const on = { ...committed, GATEWAY_ORIGIN: 'https://gateway.example.invalid', READ_V5_BRIDGE_ENABLED: 'true',
    ENABLED_V5_READS: 'featured-pools', ACCESS_CLIENT_ID: 'synthetic-service-id', ACCESS_CLIENT_SECRET: 'synthetic-service-secret' };
  const first = await answerFeatured(ask(), bound(on), runtimeWith(cache));
  assert.equal(first.status, 200);
  assert.equal(await first.text(), CURRENT);
  assert.equal(gateway.length, 1);
  assert.equal(gateway[0].url, 'https://gateway.example.invalid/internal/read/v5/featured-pools');
  assert.equal(cache.puts.length, 1);
  const second = await answerFeatured(ask(), bound(on), runtimeWith(cache));
  assert.equal(await second.text(), CURRENT);
  assert.equal(gateway.length, 1, 'the VM was asked once');
});

// ---------------------------------------------------------------------------
// A pool's stored history at the edge (functions/_lib/historyEdge.ts, functions/api/read/v3/history.ts). Added
// 2026-09-28 (speed wave, item 45): the same rules as the list's, for a built history only, 20 s and no more.
// ---------------------------------------------------------------------------

const v3 = await import('../../api-contracts/read-v3/runtime.mjs');
const { historyFor } = await import('./markets-cards.fixtures.mjs');
const { answerHistory, historyKey, HISTORY_PATH, HISTORY_SECONDS } = require('../.test-build/app/functions/_lib/historyEdge.js');
const HISTORY_CONTRACT = { CONTRACT_VERSION: v3.CONTRACT_VERSION, validateRequest: v3.validateRequest, validateResponse: v3.validateResponse, matchesRequest: v3.matchesRequest };
const POOL = `0x${'ab'.repeat(32)}`;
const ETH = '0x0000000000000000000000000000000000000000';
const question = { poolId: POOL, currency: ETH, windowSeconds: 86400, resolutionSeconds: 3600 };
const askHistory = (body = question, headers = {}) => ask({ url: `${ORIGIN}${HISTORY_PATH}`, body: JSON.stringify(body), headers: { 'X-Domino-Read-Contract': v3.CONTRACT_VERSION, ...headers } });
const historySaid = (body, options = {}) => said(JSON.stringify(body), { version: v3.CONTRACT_VERSION, ...options });

test('a built 24h history is kept 20 s for the identical question; one not built, another answer or another question is not', async () => {
  const built = historyFor(question, { built: true });
  assert.equal(v3.validateResponse('history', built), true, 'the fixture passes read-v3’s own runtime');
  const cache = memoryCache();
  const time = clock();
  const { calls, env } = bridge(() => historySaid(built));
  const runtime = () => ({ contract: HISTORY_CONTRACT, cache, now: time.now, refreshing: new Map() });
  const first = await answerHistory(askHistory(), env, runtime());
  assert.equal(first.status, 200);
  assert.equal(cache.puts.length, 1);
  assert.equal(cache.puts[0].url, historyKey(v3.CONTRACT_VERSION, question));
  assert.equal(cache.puts[0].cacheControl, `max-age=${HISTORY_SECONDS}`);
  time.at.now += HISTORY_SECONDS * 1000 - 1;
  const hit = await answerHistory(askHistory(), env, runtime());
  assert.equal(hit.headers.get('X-Domino-Edge-Cache'), 'hit');
  assert.deepEqual(await hit.json(), built);
  assert.equal(calls.length, 1);
  // Another question, or past 20 s: the Worker.
  await answerHistory(askHistory({ ...question, windowSeconds: 604800 }), env, runtime());
  assert.equal(calls.length, 2);
  time.at.now += 1;
  const late = await answerHistory(askHistory(), env, runtime());
  assert.equal(late.headers.get('X-Domino-Edge-Cache'), null, 'never served stale');
  assert.equal(calls.length, 3);

  // Not built yet: passed on, never kept, so it shows the moment it is built.
  const notBuilt = historyFor(question, { built: false });
  const pending = memoryCache();
  const worker = bridge(() => historySaid(notBuilt));
  await answerHistory(askHistory(), worker.env, { contract: HISTORY_CONTRACT, cache: pending, now: time.now });
  assert.equal(pending.puts.length, 0);
  // An answer about another pool, a refusal, another contract: passed on, never kept.
  for (const answer of [() => historySaid({ ...built, poolId: `0x${'cd'.repeat(32)}` }), () => historySaid({ error: 'upstream_unavailable' }, { status: 503 }), () => said(JSON.stringify(built), { version: '1.0.0-rc.1' })]) {
    const store = memoryCache();
    await answerHistory(askHistory(), bridge(answer).env, { contract: HISTORY_CONTRACT, cache: store, now: time.now });
    assert.equal(store.puts.length, 0);
  }
  // A request the Worker would refuse is never answered from the edge.
  for (const variant of [askHistory({ ...question, extra: 1 }), askHistory(question, { Origin: 'https://evil.example' }), ask({ url: `${ORIGIN}${HISTORY_PATH}`, method: 'GET' })]) {
    const refusing = bridge(() => said('{"error":"invalid_request"}', { status: 422, version: v3.CONTRACT_VERSION }));
    const response = await answerHistory(variant, refusing.env, runtime());
    assert.equal(response.headers.get('X-Domino-Edge-Cache'), null);
    assert.equal(refusing.calls.length, 1);
  }
});
