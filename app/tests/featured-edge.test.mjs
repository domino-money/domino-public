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
const { answerFeatured, cacheKey, FEATURED_PATH, LIST_SECONDS, STALE_SECONDS, WAIT_AFTER_SECONDS, ERROR_SECONDS, REFRESH_WAIT_MS } = require('../.test-build/app/functions/_lib/featuredEdge.js');
const { REFRESH_GUARD_MS } = require('../.test-build/app/functions/_lib/publicEdge.js');
const { PREVIEW_ORIGIN } = require('../.test-build/app/functions/_lib/bridge.js');
const { onRequest: gate, LOGIN_PATH, API_CSP } = require('../.test-build/app/functions/_middleware.js');

const ORIGIN = 'https://domino.money';
const VERSION = runtime.CONTRACT_VERSION;
const CONTRACT = { CONTRACT_VERSION: VERSION, CONTRACT_VERSIONS: runtime.CONTRACT_VERSIONS, validateRequest: runtime.validateRequest, validateResponse: runtime.validateResponse };
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
const previewAsk = (options = {}) => ask({ ...options, url: options.url ?? `${PREVIEW_ORIGIN}${FEATURED_PATH}`, headers: { Origin: PREVIEW_ORIGIN, ...options.headers } });

test('a ready featured refresh is returned to the same caller, with one binding call and its quota charge', async () => {
  const cache = memoryCache(), time = clock(), later = [], refreshing = new Map();
  let fresh = false;
  const worker = bridge(() => said(fresh ? NONE : CURRENT));
  const rt = () => runtimeWith(cache, time, { refreshing, waitUntil: work => later.push(work) });
  await answerFeatured(ask(), worker.env, rt()); await Promise.all(later.splice(0));
  // Changed on purpose 2026-10-01 (audit A6): only a list at least five minutes old waits for its refresh.
  fresh = true; time.at.now += WAIT_AFTER_SECONDS * 1000;
  const result = await answerFeatured(ask(), worker.env, rt());
  assert.equal(await result.text(), NONE);
  assert.equal(result.headers.get('X-Domino-Edge-Cache'), null);
  assert.equal(worker.calls.length, 2);
  await Promise.all(later);
});

test('slow featured refresh waits at most one second, keeps the dated cache and coalesces visitors', async () => {
  const cache = memoryCache(), time = clock(), later = [], refreshing = new Map();
  let unblock, fire, armed;
  const timerReady = new Promise(resolve => { armed = resolve; });
  let slow = false;
  const worker = bridge(() => slow ? new Promise(resolve => { unblock = resolve; }) : said());
  const rt = () => runtimeWith(cache, time, { refreshing, waitUntil: work => later.push(work), timer: (ms, fn) => {
    assert.equal(ms, 1000); fire = fn; armed(); return () => {};
  } });
  await answerFeatured(ask(), worker.env, rt()); await Promise.all(later.splice(0));
  const before = await cache.entries.get(cacheKey(VERSION)).clone().text();
  slow = true; time.at.now += WAIT_AFTER_SECONDS * 1000;
  const first = answerFeatured(ask(), worker.env, rt()); await timerReady;
  const shared = await answerFeatured(ask(), worker.env, rt());
  assert.equal(shared.headers.get('X-Domino-Edge-Cache'), 'hit');
  assert.equal(await shared.text(), CURRENT);
  fire(); const expiredWait = await first;
  assert.equal(await expiredWait.text(), CURRENT);
  assert.equal(expiredWait.headers.get('X-Domino-Edge-Cache'), null);
  assert.equal(await cache.entries.get(cacheKey(VERSION)).clone().text(), before);
  assert.equal(cache.puts.length, 1, 'waiting does not extend the old entry lifetime');
  while (!unblock) await new Promise(resolve => setImmediate(resolve));
  unblock(said(NONE)); await Promise.all(later);
  assert.equal(worker.calls.length, 2, 'one original and one refresh, not one per visitor');
});

test('preview public caches are opt-in and isolated from production, while forwarding only canonical public reads', async () => {
  const cache = memoryCache();
  const production = bridge(() => said(CURRENT));
  const preview = bridge(() => said(NONE));
  const env = { ...preview.env, PREVIEW_PUBLIC_READS: 'true' };
  await answerFeatured(ask(), production.env, runtimeWith(cache));
  const first = await answerFeatured(previewAsk({ headers: {
    Cookie: '__Host-domino-beta=synthetic; __Host-domino-session=synthetic',
    Authorization: 'Bearer synthetic', 'CF-Access-Client-Secret': 'synthetic',
  } }), env, runtimeWith(cache));
  assert.equal(await first.text(), NONE, 'preview never takes the production entry');
  assert.equal(preview.calls.length, 1);
  assert.equal(preview.calls[0].url, `${ORIGIN}${FEATURED_PATH}`);
  assert.equal(preview.calls[0].headers.origin, ORIGIN);
  assert.equal(preview.calls[0].headers.host, new URL(ORIGIN).host);
  for (const header of ['cookie', 'authorization', 'cf-access-client-secret']) assert.equal(header in preview.calls[0].headers, false);
  const hit = await answerFeatured(previewAsk(), env, runtimeWith(cache));
  assert.equal(await hit.text(), NONE);
  assert.equal(hit.headers.get('X-Domino-Edge-Cache'), 'hit');
  assert.equal(hit.headers.get('X-Domino-Request-Id'), null);
  assert.equal(preview.calls.length, 1, 'the second preview read costs no Worker call');
  assert.equal(await (await answerFeatured(ask(), production.env, runtimeWith(cache))).text(), CURRENT, 'preview never replaces production');
  assert.equal(production.calls.length, 1);
  assert.deepEqual(cache.puts.map(({ url }) => url), [cacheKey(VERSION), cacheKey(VERSION, PREVIEW_ORIGIN)]);
});

test('a warm preview cache cannot bypass opt-in, binding, original browser checks or exact host isolation', async () => {
  const cache = memoryCache();
  const { calls, env: bound } = bridge();
  const env = { ...bound, PREVIEW_PUBLIC_READS: 'true' };
  await answerFeatured(previewAsk(), env, runtimeWith(cache));
  for (const flag of [undefined, 'false', 'TRUE']) {
    const response = await answerFeatured(previewAsk(), { ...env, PREVIEW_PUBLIC_READS: flag }, runtimeWith(cache));
    assert.equal(response.status, 404);
    assert.equal(response.headers.get('X-Domino-Edge-Cache'), null);
  }
  for (const reader of [undefined, null, 'reader', { fetch: 'no' }]) {
    const response = await answerFeatured(previewAsk(), { ...env, READ_BRIDGE: reader }, runtimeWith(cache));
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('X-Domino-Edge-Cache'), null);
  }
  for (const headers of [
    { Origin: ORIGIN }, { Origin: null }, { Origin: 'https://evil.example' }, { Host: 'domino.money' },
    { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Mode': 'navigate' }, { 'Sec-Fetch-Dest': 'document' },
    { 'Sec-Fetch-User': '?1' }, { 'CF-Worker': 'other.example' },
  ]) {
    const response = await answerFeatured(previewAsk({ headers }), env, runtimeWith(cache));
    assert.equal(response.status, 403, JSON.stringify(headers));
    assert.equal(response.headers.get('X-Domino-Edge-Cache'), null);
  }
  for (const origin of ['https://abc123.domino-app-e65.pages.dev', 'https://domino-app-e65.pages.dev', 'https://preview.domino-app-e65.pages.dev.evil.example']) {
    const response = await answerFeatured(previewAsk({ url: `${origin}${FEATURED_PATH}`, headers: { Origin: origin } }), env, runtimeWith(cache));
    assert.equal(response.status, 404);
  }
  assert.equal(calls.length, 1, 'none of the refused requests reaches a binding');
  assert.equal(cache.puts.length, 1);
});

test('a stale preview list refreshes behind the gate without refreshing production or extending its lifetime', async () => {
  const cache = memoryCache();
  const time = clock();
  const worker = bridge();
  const env = { ...worker.env, PREVIEW_PUBLIC_READS: 'true' };
  const later = [];
  const refreshing = new Map();
  const rt = () => runtimeWith(cache, time, { refreshing, waitUntil: (work) => later.push(work) });
  await answerFeatured(previewAsk(), env, rt());
  await Promise.all(later.splice(0));
  time.at.now += LIST_SECONDS * 1000;
  const stale = await answerFeatured(previewAsk(), env, rt());
  assert.equal(await stale.text(), CURRENT);
  assert.equal(stale.headers.get('X-Domino-Edge-Cache'), null, 'the refreshing visitor keeps its gateway budget charge');
  await Promise.all(later.splice(0));
  assert.equal(worker.calls.length, 2);
  assert.ok(worker.calls.every((call) => call.url === `${ORIGIN}${FEATURED_PATH}`));
  assert.ok(cache.puts.every(({ url }) => url === cacheKey(VERSION, PREVIEW_ORIGIN)));
  time.at.now += STALE_SECONDS * 1000;
  const expired = await answerFeatured(previewAsk(), env, rt());
  assert.equal(expired.headers.get('X-Domino-Edge-Cache'), null);
  assert.equal(worker.calls.length, 3, 'past the existing stale window the Worker must answer');
  await Promise.all(later);
});

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
  // Changed on purpose 2026-10-01 (the chain2 workstream, part B, audit item G10): the key names the chain the list is of.
  // Changed on purpose 2026-10-30 (launch item 4): the cache keeps it for its stale-if-error hour, past its 15 minutes.
  assert.deepEqual(cache.puts, [{ url: `${ORIGIN}/api/read/v5/cache/4663/${VERSION}/featured-pools`, cacheControl: `max-age=${ERROR_SECONDS}` }]);
  assert.equal(cacheKey(VERSION), cache.puts[0].url);
  assert.equal(cacheKey(VERSION, ORIGIN, 99801), `${ORIGIN}/api/read/v5/cache/99801/${VERSION}/featured-pools`, 'another chain, another key');
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
  // Changed on purpose 2026-10-01 (audit A6): a list younger than five minutes is served at once while its refresh runs
  // behind; past that the visitor waits for the refresh, and a ready refusal reaches them.
  time.at.now += WAIT_AFTER_SECONDS * 1000;
  const disabled = await answerFeatured(ask(), env, runtime());
  assert.equal(disabled.status, 404, 'a ready definitive refusal reaches this visitor, not just the next one');
  assert.deepEqual(await disabled.json(), { error: 'route_not_available' });
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
  assert.equal(INVALID.length, 57);
  for (const [name, text] of INVALID) {
    const cache = memoryCache();
    const { env } = bridge(() => said(text));
    const response = await answerFeatured(ask(), env, runtimeWith(cache));
    assert.equal(response.status, 200, name);
    assert.equal(await response.text(), text, `${name}: passed on as it came`);
    assert.equal(cache.puts.length, 0, `${name}: never kept`);
  }
});

// Added 2026-09-28 (featured-policy v2, read-v5 rc.2): this route and the Worker go out while the VM still serves rc.1.
test('during the transition a list is kept and served in the version the Worker answered it in, and a request may ask in either', async () => {
  const RC1 = '1.0.0-rc.1';
  assert.deepEqual(runtime.CONTRACT_VERSIONS, [RC1, VERSION]);
  const RC1_LIST = JSON.stringify({ ...JSON.parse(VALID.find(([name]) => name === 'current-policy-v1.json')[1]), contractVersion: RC1 });
  const cache = memoryCache();
  const time = clock();
  const { calls, env } = bridge(() => said(RC1_LIST, { version: RC1 }));
  const first = await answerFeatured(ask({ headers: { 'X-Domino-Read-Contract': RC1 } }), env, runtimeWith(cache, time));
  assert.equal(first.headers.get('X-Domino-Read-Contract'), RC1);
  assert.equal(await first.text(), RC1_LIST);
  assert.deepEqual(cache.puts.map((put) => put.url), [cacheKey(VERSION)], 'kept under the key of the version this build speaks');
  for (const asked of [RC1, VERSION, null]) {
    const hit = await answerFeatured(ask({ headers: { 'X-Domino-Read-Contract': asked } }), env, runtimeWith(cache, time));
    assert.equal(hit.headers.get('X-Domino-Edge-Cache'), 'hit', String(asked));
    assert.equal(hit.headers.get('X-Domino-Read-Contract'), RC1, 'served in the version it was answered in');
    assert.equal(await hit.text(), RC1_LIST);
  }
  assert.equal(calls.length, 1);
  // A request in a version the route does not take is the Worker's to refuse, never the edge's to answer.
  const refusing = bridge(() => said('{"error":"upstream_contract_mismatch"}', { status: 502 }));
  const other = await answerFeatured(ask({ headers: { 'X-Domino-Read-Contract': '1.0.0-rc.3' } }), refusing.env, runtimeWith(cache, time));
  assert.equal(other.status, 502);
  assert.equal(refusing.calls.length, 1);
  // An answer in a version the route does not take, or whose list names another version than its header, is not kept.
  for (const [text, version] of [[CURRENT, '1.0.0-rc.3'], [CURRENT, RC1], [RC1_LIST, VERSION]]) {
    const fresh = memoryCache();
    const response = await answerFeatured(ask(), bridge(() => said(text, { version })).env, runtimeWith(fresh, time));
    assert.equal(await response.text(), text, version);
    assert.equal(fresh.puts.length, 0, `${version}: never kept`);
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

async function betaCookie(origin = ORIGIN) {
  const response = await gate({
    request: new Request(`${origin}${LOGIN_PATH}`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: origin }, body: `password=${encodeURIComponent(GATE.BETA_PASSWORD)}` }),
    env: GATE,
    next: async () => assert.fail('login reached the app'),
  });
  return response.headers.get('Set-Cookie').split(';')[0];
}

test('the preview beta gate refuses access before a warm public cache and preserves no-store on hits', async () => {
  const cache = memoryCache();
  const worker = bridge();
  const env = { ...GATE, ...worker.env, PREVIEW_PUBLIC_READS: 'true' };
  const cookie = await betaCookie(PREVIEW_ORIGIN);
  let reached = 0;
  const serve = (request) => gate({ request, env, next: async (passed) => {
    reached += 1;
    return answerFeatured(passed ?? request, env, runtimeWith(cache));
  } });
  for (const expected of [null, 'hit']) {
    const response = await serve(previewAsk({ headers: { Cookie: cookie } }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('X-Domino-Edge-Cache'), expected);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('Content-Security-Policy'), API_CSP);
  }
  const refused = await serve(previewAsk());
  assert.equal(refused.status, 401);
  assert.deepEqual(await refused.json(), { error: 'beta_access_required' });
  assert.equal(reached, 2, 'unsigned request never reaches the warm cache');
  assert.equal(worker.calls.length, 1);
});

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
const { answerHistory, historyKey, HISTORY_PATH, HISTORY_SECONDS, HISTORY_STALE_SECONDS, HISTORY_ERROR_SECONDS, HISTORY_ERROR_WAIT_MS } = require('../.test-build/app/functions/_lib/historyEdge.js');
const HISTORY_CONTRACT = { CONTRACT_VERSION: v3.CONTRACT_VERSION, validateRequest: v3.validateRequest, validateResponse: v3.validateResponse, matchesRequest: v3.matchesRequest };
const POOL = `0x${'ab'.repeat(32)}`;
const ETH = '0x0000000000000000000000000000000000000000';
const question = { poolId: POOL, currency: ETH, windowSeconds: 86400, resolutionSeconds: 3600 };
const askHistory = (body = question, headers = {}) => ask({ url: `${ORIGIN}${HISTORY_PATH}`, body: JSON.stringify(body), headers: { 'X-Domino-Read-Contract': v3.CONTRACT_VERSION, ...headers } });
const historySaid = (body, options = {}) => said(JSON.stringify(body), { version: v3.CONTRACT_VERSION, ...options });

test('preview history cache is origin-scoped, fresh for 20 s, stale to 60 s, keeps an incomplete answer 20 s only and never a failed one', async () => {
  const built = historyFor(question, { built: true });
  const cache = memoryCache();
  const time = clock();
  const worker = bridge(() => historySaid(built));
  const env = { ...worker.env, PREVIEW_PUBLIC_READS: 'true' };
  const later = [];
  const refreshing = new Map();
  const rt = () => ({ contract: HISTORY_CONTRACT, cache, now: time.now, refreshing, waitUntil: (work) => later.push(work) });
  const request = () => previewAsk({ url: `${PREVIEW_ORIGIN}${HISTORY_PATH}`, body: JSON.stringify(question), headers: { 'X-Domino-Read-Contract': v3.CONTRACT_VERSION } });
  await answerHistory(askHistory(), env, rt());
  await answerHistory(request(), env, rt());
  assert.equal(worker.calls.length, 2, 'preview did not borrow production history');
  assert.deepEqual(cache.puts.map(({ url }) => url), [historyKey(v3.CONTRACT_VERSION, question), historyKey(v3.CONTRACT_VERSION, question, PREVIEW_ORIGIN)]);
  assert.equal((await answerHistory(request(), env, rt())).headers.get('X-Domino-Edge-Cache'), 'hit');
  assert.equal(worker.calls.length, 2);
  // Changed on purpose 2026-10-01 (audit A14): past 20 s it is served at once, dated, while it is read again behind.
  time.at.now += HISTORY_SECONDS * 1000;
  const stale = await answerHistory(request(), env, rt());
  assert.equal(stale.headers.get('X-Domino-Edge-Cache'), null, 'the request that sends the refresh is counted');
  assert.equal(stale.headers.get('X-Domino-Edge-Age'), String(HISTORY_SECONDS * 1000));
  await Promise.all(later.splice(0));
  assert.equal(worker.calls.length, 3);
  time.at.now += HISTORY_STALE_SECONDS * 1000;
  assert.equal((await answerHistory(request(), env, rt())).headers.get('X-Domino-Edge-Cache'), null);
  assert.equal(worker.calls.length, 4, 'past a minute the Worker answers');
  // Changed on purpose 2026-10-15 (pack 7): one not built yet is kept too, for 20 s only, under preview's own key.
  const young = memoryCache();
  await answerHistory(request(), { ...bridge(() => historySaid(historyFor(question, { built: false }))).env, PREVIEW_PUBLIC_READS: 'true' }, { ...rt(), cache: young });
  assert.deepEqual(young.puts, [{ url: historyKey(v3.CONTRACT_VERSION, question, PREVIEW_ORIGIN), cacheControl: `max-age=${HISTORY_SECONDS}` }]);
  for (const answer of [() => historySaid({ error: 'upstream_unavailable' }, { status: 503 })]) {
    const pending = memoryCache();
    const upstream = bridge(answer);
    await answerHistory(request(), { ...upstream.env, PREVIEW_PUBLIC_READS: 'true' }, { ...rt(), cache: pending });
    assert.equal(pending.puts.length, 0);
  }
});

test('a built 24h history is kept 20 s for the identical question; one not built only 20 s; another answer or another question is not', async () => {
  const built = historyFor(question, { built: true });
  assert.equal(v3.validateResponse('history', built), true, 'the fixture passes read-v3’s own runtime');
  const cache = memoryCache();
  const time = clock();
  const { calls, env } = bridge(() => historySaid(built));
  const later = [];
  const runtime = () => ({ contract: HISTORY_CONTRACT, cache, now: time.now, refreshing: new Map(), waitUntil: (work) => later.push(work) });
  const first = await answerHistory(askHistory(), env, runtime());
  assert.equal(first.status, 200);
  await Promise.all(later.splice(0));
  assert.equal(cache.puts.length, 1);
  assert.equal(cache.puts[0].url, historyKey(v3.CONTRACT_VERSION, question));
  // Changed on purpose 2026-10-30 (launch item 4): the cache keeps it for its stale-if-error life, past its minute.
  assert.equal(cache.puts[0].cacheControl, `max-age=${HISTORY_ERROR_SECONDS}`);
  time.at.now += HISTORY_SECONDS * 1000 - 1;
  const hit = await answerHistory(askHistory(), env, runtime());
  assert.equal(hit.headers.get('X-Domino-Edge-Cache'), 'hit');
  assert.deepEqual(await hit.json(), built);
  assert.equal(calls.length, 1);
  // Another question, or past 20 s: the Worker.
  await answerHistory(askHistory({ ...question, windowSeconds: 604800 }), env, runtime());
  assert.equal(calls.length, 2);
  // Changed on purpose 2026-10-01 (audit A14): from 20 s to a minute it is served at once while it is read again behind.
  time.at.now += 1;
  const late = await answerHistory(askHistory(), env, runtime());
  assert.equal(late.headers.get('X-Domino-Edge-Cache'), null, 'served stale; the request that sends the refresh is counted');
  assert.deepEqual(await late.json(), built);
  await Promise.all(later.splice(0));
  assert.equal(calls.length, 3);
  time.at.now += HISTORY_STALE_SECONDS * 1000;
  const gone = await answerHistory(askHistory(), env, runtime());
  assert.equal(gone.headers.get('X-Domino-Edge-Cache'), null, 'never served past a minute');
  await Promise.all(later.splice(0));
  assert.equal(calls.length, 4);

  // Changed on purpose 2026-10-15 (pack 7): not built yet is kept too, but for 20 s only (it was never kept), so it shows
  // within 20 s of being built (the pack 7 test below).
  const notBuilt = historyFor(question, { built: false });
  const pending = memoryCache();
  const worker = bridge(() => historySaid(notBuilt));
  await answerHistory(askHistory(), worker.env, { contract: HISTORY_CONTRACT, cache: pending, now: time.now });
  assert.deepEqual(pending.puts.map(({ cacheControl }) => cacheControl), [`max-age=${HISTORY_SECONDS}`]);
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

// (2026-10-15, pack 7): every viewer of a young pool reached rugged97's gateway on every view: an answer not built yet,
// partial, stale or unavailable was passed on and never kept. Such an answer is kept now too, served as it is for
// HISTORY_SECONDS and no longer (never past it while it is read again behind), so a pool that becomes ready shows within
// 20 s. A real error is still never kept.
test('pack 7: a not-ready history answer is kept HISTORY_SECONDS only, so a young pool’s viewers reach the gateway once per 20 s; an error never', async () => {
  const built = historyFor(question, { built: true });
  const notBuilt = historyFor(question, { built: false });
  const half = built.requestedWindow.startTimestamp + 12 * 3600;
  const variants = {
    not_built: notBuilt,
    unavailable: { ...notBuilt, status: 'unavailable', reason: 'pool_not_in_catalogue' },
    partial: { ...built, status: 'partial', reason: 'history_acquisition_pending', covered: [{ startTimestamp: half, endTimestamp: built.requestedWindow.endTimestamp }], gaps: [{ startTimestamp: built.requestedWindow.startTimestamp, endTimestamp: half }], candles: built.candles.slice(12) },
    stale: { ...built, status: 'stale', reason: 'snapshot_stale' },
  };
  for (const [status, body] of Object.entries(variants)) {
    assert.equal(v3.validateResponse('history', body), true, `${status}: the fixture passes read-v3’s own runtime`);
    const cache = memoryCache();
    const time = clock();
    const later = [];
    const { calls, env } = bridge(() => historySaid(body));
    const runtime = () => ({ contract: HISTORY_CONTRACT, cache, now: time.now, refreshing: new Map(), inflight: new Map(), waitUntil: (work) => later.push(work) });
    // Ten viewers within 20 s: one gateway call.
    for (let viewer = 0; viewer < 10; viewer++) {
      const response = await answerHistory(askHistory(), env, runtime());
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), body, `${status}: the answer as the gateway gave it`);
      await Promise.all(later.splice(0));
      time.at.now += 1_000;
    }
    assert.equal(calls.length, 1, `${status}: ten views within 20 s, one gateway call (it was ten)`);
    assert.equal(cache.puts[0].cacheControl, `max-age=${HISTORY_SECONDS}`, `${status}: kept 20 s, not a minute`);
    // Past 20 s it is never served stale: the gateway answers, so a pool that became ready shows at once.
    time.at.now += HISTORY_SECONDS * 1000;
    const next = await answerHistory(askHistory(), env, runtime());
    assert.equal(next.headers.get('X-Domino-Edge-Age'), null, `${status}: not served from the edge past 20 s`);
    await Promise.all(later.splice(0));
    assert.equal(calls.length, 2, `${status}: past 20 s the gateway`);
  }
  // The pool becomes ready: its built history replaces the kept not-ready one within 20 s.
  {
    const cache = memoryCache();
    const time = clock();
    let ready = false;
    const { calls, env } = bridge(() => historySaid(ready ? built : notBuilt));
    const runtime = () => ({ contract: HISTORY_CONTRACT, cache, now: time.now, refreshing: new Map(), inflight: new Map() });
    assert.equal((await (await answerHistory(askHistory(), env, runtime())).json()).status, 'not_built');
    ready = true;
    time.at.now += HISTORY_SECONDS * 1000;
    assert.equal((await (await answerHistory(askHistory(), env, runtime())).json()).status, 'available');
    assert.equal(calls.length, 2);
  }
  // A real error is never kept: every viewer still reaches the gateway.
  for (const answer of [() => historySaid({ error: 'upstream_unavailable' }, { status: 503 }), () => historySaid({ error: 'rate_limited' }, { status: 429 }), () => historySaid({ ...notBuilt, poolId: `0x${'cd'.repeat(32)}` })]) {
    const cache = memoryCache();
    const time = clock();
    const { calls, env } = bridge(answer);
    for (let viewer = 0; viewer < 3; viewer++) await answerHistory(askHistory(), env, { contract: HISTORY_CONTRACT, cache, now: time.now, refreshing: new Map(), inflight: new Map() });
    assert.equal(cache.puts.length, 0);
    assert.equal(calls.length, 3);
  }
});

// ---------------------------------------------------------------------------
// Stale-if-error (2026-10-30, launch capacity study, item 4): past its stale window, a kept list or built history still
// stands in for the Worker's failure, for a while; never for a refusal, and never one not built.
// ---------------------------------------------------------------------------

test('stale-if-error: a built history past its minute stands in for a failure of the gateway’s, or for none within a second, dated, up to fifteen minutes; one not built never does', async () => {
  assert.deepEqual([HISTORY_ERROR_SECONDS, HISTORY_ERROR_WAIT_MS], [15 * 60, 1_000]);
  const built = historyFor(question, { built: true });
  // (review) 408 too: read-v3's request_timeout, the Worker's own deadline.
  for (const status of [408, 429, 502, 503, 504]) {
    const cache = memoryCache();
    const time = clock();
    await answerHistory(askHistory(), bridge(() => historySaid(built)).env, { contract: HISTORY_CONTRACT, cache, now: time.now });
    time.at.now += HISTORY_STALE_SECONDS * 1000;
    const failing = bridge(() => historySaid({ error: 'upstream_unavailable' }, { status }));
    const response = await answerHistory(askHistory(), failing.env, { contract: HISTORY_CONTRACT, cache, now: time.now, inflight: new Map(), refreshing: new Map() });
    assert.equal(response.status, 200, String(status));
    assert.deepEqual(await response.json(), built);
    assert.equal(response.headers.get('Server-Timing'), 'edge;desc="stale-if-error"');
    assert.equal(response.headers.get('X-Domino-Edge-Age'), String(HISTORY_STALE_SECONDS * 1000));
    assert.equal(response.headers.get('X-Domino-Edge-Cache'), null);
    assert.equal(failing.calls.length, 1);
    assert.equal(cache.puts.length, 1, 'the failure is never kept');
    // Past fifteen minutes nothing stands in.
    time.at.now += HISTORY_ERROR_SECONDS * 1000;
    assert.equal((await answerHistory(askHistory(), failing.env, { contract: HISTORY_CONTRACT, cache, now: time.now, inflight: new Map(), refreshing: new Map() })).status, status);
  }
  // (review) A gateway that does not answer within HISTORY_ERROR_WAIT_MS: the kept history at that bound, and the answer,
  // when it comes, kept behind; it waited for the Worker's own 20 s before.
  {
    const cache = memoryCache();
    const time = clock();
    await answerHistory(askHistory(), bridge(() => historySaid(built)).env, { contract: HISTORY_CONTRACT, cache, now: time.now });
    time.at.now += HISTORY_STALE_SECONDS * 1000;
    let release;
    const late = new Promise((resolve) => { release = resolve; });
    const slow = bridge(async () => { await late; return historySaid(built); });
    const armed = [], later = [];
    const response = await answerHistory(askHistory(), slow.env, { contract: HISTORY_CONTRACT, cache, now: time.now, inflight: new Map(), refreshing: new Map(),
      waitUntil: (work) => later.push(work), timer: (ms, fire) => { armed.push(ms); setTimeout(fire, 0); return () => undefined; } });
    assert.deepEqual(armed, [HISTORY_ERROR_WAIT_MS]);
    assert.equal(response.headers.get('Server-Timing'), 'edge;desc="stale-if-error"');
    assert.deepEqual(await response.json(), built);
    release();
    while (later.length > 0) await Promise.all(later.splice(0));
    assert.equal(cache.puts.length, 2, 'the late answer is kept');
    // The stale-while-revalidate minute is untouched: a history 20 s old is served at once, with no wait.
    time.at.now += HISTORY_SECONDS * 1000;
    const quick = [];
    const stale = await answerHistory(askHistory(), slow.env, { contract: HISTORY_CONTRACT, cache, now: time.now, inflight: new Map(), refreshing: new Map(),
      waitUntil: (work) => later.push(work), timer: (ms, fire) => { quick.push(ms); setTimeout(fire, 0); return () => undefined; } });
    assert.equal(stale.headers.get('Server-Timing'), 'edge;desc="stale"');
    assert.deepEqual(quick, []);
    while (later.length > 0) await Promise.all(later.splice(0));
  }
  // One not built yet is kept 20 s and no longer, not even for a failure.
  const cache = memoryCache();
  const time = clock();
  await answerHistory(askHistory(), bridge(() => historySaid(historyFor(question, { built: false }))).env, { contract: HISTORY_CONTRACT, cache, now: time.now });
  time.at.now += HISTORY_SECONDS * 1000;
  const refused = await answerHistory(askHistory(), bridge(() => historySaid({ error: 'upstream_unavailable' }, { status: 503 })).env, { contract: HISTORY_CONTRACT, cache, now: time.now, inflight: new Map(), refreshing: new Map() });
  assert.equal(refused.status, 503);
});

test('stale-if-error: a list past its 15 minutes stands in for a failure of the Worker’s, or for none within a second, up to an hour; a list switched off still reaches the visitor and leaves the edge', async () => {
  assert.equal(ERROR_SECONDS, 60 * 60);
  for (const status of [429, 502, 503, 504]) {
    const cache = memoryCache();
    const time = clock();
    await answerFeatured(ask(), bridge().env, runtimeWith(cache, time));
    time.at.now += STALE_SECONDS * 1000;
    const failing = bridge(() => said('{"error":"upstream_unavailable"}', { status }));
    const response = await answerFeatured(ask(), failing.env, runtimeWith(cache, time, { inflight: new Map() }));
    assert.equal(response.status, 200, String(status));
    assert.equal(await response.text(), CURRENT);
    assert.equal(response.headers.get('Server-Timing'), 'edge;desc="stale-if-error"');
    assert.equal(response.headers.get('X-Domino-Edge-Age'), String(STALE_SECONDS * 1000));
    assert.equal(response.headers.get('X-Domino-Edge-Cache'), null);
    assert.equal(response.headers.get('X-Domino-Read-Contract'), VERSION);
    assert.equal(cache.puts.length, 1);
    time.at.now += ERROR_SECONDS * 1000;
    assert.equal((await answerFeatured(ask(), failing.env, runtimeWith(cache, time, { inflight: new Map() }))).status, status, 'past an hour nothing stands in');
  }
  // A Worker that does not answer within REFRESH_WAIT_MS (below the page's 1.5 s deadline): the kept list at that bound.
  {
    const cache = memoryCache();
    const time = clock();
    await answerFeatured(ask(), bridge().env, runtimeWith(cache, time));
    time.at.now += STALE_SECONDS * 1000;
    const armed = [];
    const response = await answerFeatured(ask(), bridge(() => new Promise(() => undefined)).env,
      runtimeWith(cache, time, { inflight: new Map(), timer: (ms, fire) => { armed.push(ms); setTimeout(fire, 0); return () => undefined; } }));
    assert.deepEqual(armed, [REFRESH_WAIT_MS]);
    assert.equal(await response.text(), CURRENT);
    assert.equal(response.headers.get('Server-Timing'), 'edge;desc="stale-if-error"');
  }
  // Switched off: the Worker's 404 reaches this visitor and takes the entry out.
  {
    const cache = memoryCache();
    cache.delete = async (request) => cache.entries.delete(request.url);
    const time = clock();
    await answerFeatured(ask(), bridge().env, runtimeWith(cache, time));
    time.at.now += STALE_SECONDS * 1000;
    const off = await answerFeatured(ask(), bridge(() => said('{"error":"route_not_available"}', { status: 404 })).env, runtimeWith(cache, time, { inflight: new Map() }));
    assert.deepEqual([off.status, await off.json()], [404, { error: 'route_not_available' }]);
    assert.equal(cache.entries.size, 0);
  }
});
