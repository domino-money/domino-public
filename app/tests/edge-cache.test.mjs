/**
 * The public reads at the edge, as changed 2026-10-01 (audit A6, A7 b, A14, B1, F7, I3; the owner's OK on more edge
 * caching): the featured list served at once while younger than five minutes, its evidence line when its list or
 * revision changes, misses coalesced per isolate, the stored overview kept a few seconds when settled, and DEX Screener
 * asked through our own edge, one token at a time.
 *
 * The Worker is a recorder standing in for the READ_BRIDGE binding; DEX Screener is a recorder standing in for fetch.
 * The contracts' own runtimes are the contract throughout.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { beforeEach, test } from 'node:test';
import * as v5 from '../../api-contracts/read-v5/runtime.mjs';
import * as v3 from '../../api-contracts/read-v3/runtime.mjs';
import { agedPoolEntry, pendingPoolEntry } from './support/stale-store.mjs';

const require = createRequire(import.meta.url);
const { answerFeatured, cacheKey, FEATURED_PATH, LIST_SECONDS, WAIT_AFTER_SECONDS, REFRESH_WAIT_MS, featuredEvidence } = require('../.test-build/app/functions/_lib/featuredEdge.js');
const { FOLLOW_WAIT_MS, LEAD_LIFE_MS, REFRESH_GUARD_MS } = require('../.test-build/app/functions/_lib/publicEdge.js');
const {
  answerOverview, overviewKey, OVERVIEW_PATH, OVERVIEW_SECONDS, OVERVIEW_SETTLING_SECONDS, OVERVIEW_STALE_SECONDS, OVERVIEW_WAIT_AFTER_SECONDS, OVERVIEW_ERROR_SECONDS,
  OVERVIEW_REFRESH_WAIT_MS, OVERVIEW_ERROR_WAIT_MS, settledOverview, usefulOverview,
} = require('../.test-build/app/functions/_lib/overviewEdge.js');
const {
  answerDex, answerDex2, dexAsk, dex2Ask, dexMemory, resetDexMemory, trimPair, trimPairOn, pairsForPrice, DEX_FRESH_SECONDS, DEX_STALE_SECONDS,
  DEX_KEPT_SECONDS, DEX_NONE_FRESH_SECONDS, DEX_READ_STALE_MS, DEX_MISS_SECONDS, DEX_MISS_MAX_SECONDS, DEX_ON_ITS_WAY_SECONDS, DEX_VISITOR, DEX_VISITOR_NEW, MAX_TOKENS,
} = require('../.test-build/app/functions/_lib/dexEdge.js');
const { quotesFromTokens } = require('../.test-build/app/src/lib/walletPrices.js');
const { walletHoldings } = require('../.test-build/app/src/lib/walletHoldings.js');

const ORIGIN = 'https://domino.money';
const FEATURED = { CONTRACT_VERSION: v5.CONTRACT_VERSION, CONTRACT_VERSIONS: v5.CONTRACT_VERSIONS, validateRequest: v5.validateRequest, validateResponse: v5.validateResponse };
const OVERVIEW = { CONTRACT_VERSION: v3.CONTRACT_VERSION, validateRequest: v3.validateRequest, validateResponse: v3.validateResponse, matchesRequest: v3.matchesRequest };
const CURRENT = readFileSync(new URL('../../api-contracts/read-v5/fixtures/valid/current.json', import.meta.url), 'utf8');
const OVERVIEW_BODY = JSON.parse(readFileSync(new URL('../../api-contracts/read-v3/fixtures/overview.json', import.meta.url), 'utf8'));
const POOL = OVERVIEW_BODY.requestedPoolIds[0];

function ask({ url = `${ORIGIN}${FEATURED_PATH}`, body = '{}', version = v5.CONTRACT_VERSION, headers = {} } = {}) {
  const all = new Headers({
    Host: new URL(url).host, Origin: ORIGIN, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty', 'X-Domino-Read-Contract': version, 'CF-Connecting-IP': '203.0.113.9', 'Content-Length': String(Buffer.byteLength(body)),
  });
  for (const [name, value] of Object.entries(headers)) value === null ? all.delete(name) : all.set(name, value);
  return new Request(url, { method: 'POST', headers: all, body });
}

function said(body, { status = 200, version = v5.CONTRACT_VERSION } = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Domino-Read-Contract': version, 'X-Domino-Request-Id': crypto.randomUUID() } });
}

function bridge(answer) {
  const calls = [];
  return { calls, env: { READ_BRIDGE: { async fetch(request) { calls.push(await request.clone().text()); return answer(request); } } } };
}

function memoryCache() {
  const entries = new Map();
  const puts = [];
  return {
    entries, puts,
    async match(request) { const entry = entries.get(request.url); return entry ? entry.clone() : undefined; },
    async put(request, response) { puts.push(request.url); entries.set(request.url, new Response(await response.text(), response)); },
  };
}

function clock(start = Date.UTC(2026, 9, 1, 12)) {
  const at = { now: start };
  return { at, now: () => at.now };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------
// A6: the featured list served at once while younger than five minutes
// ---------------------------------------------------------------------------

test('A6: a kept list past 60 s but younger than five minutes is served at once, dated, while it refreshes behind; older ones wait', async () => {
  const cache = memoryCache(), time = clock(), later = [], refreshing = new Map();
  let armed = 0;
  const worker = bridge(() => said(CURRENT));
  const rt = () => ({ contract: FEATURED, cache, now: time.now, refreshing, waitUntil: (work) => later.push(work), log: () => undefined,
    logged: { last: null }, timer: (ms, fire) => { armed += 1; assert.equal(ms, REFRESH_WAIT_MS); const handle = setTimeout(fire, 0); return () => clearTimeout(handle); } });
  await answerFeatured(ask(), worker.env, rt());
  await Promise.all(later.splice(0));
  time.at.now += LIST_SECONDS * 1000 + 30_000;
  const stale = await answerFeatured(ask(), worker.env, rt());
  assert.equal(await stale.text(), CURRENT);
  assert.equal(armed, 0, 'no wait for a list younger than five minutes');
  assert.equal(stale.headers.get('X-Domino-Edge-Cache'), null, 'this request sends the refresh, so the gateway counts it');
  assert.equal(stale.headers.get('X-Domino-Edge-Age'), String(LIST_SECONDS * 1000 + 30_000));
  assert.equal(stale.headers.get('Server-Timing'), 'edge;desc="stale"');
  await Promise.all(later.splice(0));
  assert.equal(worker.calls.length, 2, 'refreshed behind');
  // A fresh hit says so, and how old it is.
  const hit = await answerFeatured(ask(), worker.env, rt());
  assert.equal(hit.headers.get('X-Domino-Edge-Cache'), 'hit');
  assert.equal(hit.headers.get('X-Domino-Edge-Age'), '0');
  assert.equal(hit.headers.get('Server-Timing'), 'edge;desc="hit"');
  // Five minutes on, the visitor who finds it waits for its refresh, as #280 made every stale one wait.
  time.at.now += WAIT_AFTER_SECONDS * 1000;
  await answerFeatured(ask(), worker.env, rt());
  assert.equal(armed, 1);
  await Promise.all(later);
});

// ---------------------------------------------------------------------------
// B1: the evidence line
// ---------------------------------------------------------------------------

test('B1: one JSON line when a valid answer brings a list or revision this isolate has not seen, with withdrawn pools and their reasons', async () => {
  const list = JSON.parse(CURRENT);
  const withdrawn = { ...list, revision: (list.revision ?? 0) + 1, withdrawn: [{ poolId: `0x${'ab'.repeat(32)}`, reason: 'estimate_unavailable', at: list.servedAt }] };
  assert.equal(v5.validateResponse('featured-pools', withdrawn), true, 'the variant passes read-v5’s own runtime');
  const lines = [];
  const logged = { last: null };
  const cache = memoryCache(), time = clock();
  let body = CURRENT;
  const worker = bridge(() => said(body));
  const rt = () => ({ contract: FEATURED, cache: null, now: time.now, log: (line) => lines.push(line), logged });
  await answerFeatured(ask(), worker.env, rt());
  await answerFeatured(ask(), worker.env, rt());
  assert.equal(lines.length, 1, 'the same list and revision is logged once');
  const first = JSON.parse(lines[0]);
  assert.equal(first.event, 'featured_list');
  assert.equal(first.listId, list.listId);
  assert.equal(first.pools, list.pools.length);
  assert.equal(first.size, list.rules?.size ?? null);
  body = JSON.stringify(withdrawn);
  await answerFeatured(ask(), worker.env, rt());
  assert.equal(lines.length, 2);
  const second = JSON.parse(lines[1]);
  assert.equal(second.revision, withdrawn.revision);
  assert.deepEqual(second.withdrawn, [[`0x${'ab'.repeat(4)}`, 'estimate_unavailable', list.servedAt]], 'pool ids cut to eight digits');
  assert.ok(!lines.some((line) => line.includes('203.0.113.9')), 'nothing about the visitor');
  assert.equal(featuredEvidence('not json', 'x', { last: null }), null);
  void cache;
});

// ---------------------------------------------------------------------------
// F7: misses coalesced per isolate
// ---------------------------------------------------------------------------

test('F7: concurrent misses for one question send one read to the Worker; the others get its answer as a hit', async () => {
  const cache = memoryCache(), time = clock(), inflight = new Map();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const worker = bridge(async () => { await gate; return said(CURRENT); });
  let following = 0;
  const rt = () => ({ contract: FEATURED, cache, now: time.now, inflight, refreshing: new Map(), log: () => undefined, logged: { last: null },
    timer: (ms, fire) => { following += 1; const handle = setTimeout(fire, ms); return () => clearTimeout(handle); } });
  const leader = answerFeatured(ask(), worker.env, rt());
  while (inflight.size === 0) await tick();
  const followers = [answerFeatured(ask(), worker.env, rt()), answerFeatured(ask(), worker.env, rt())];
  while (following < 2) await tick();
  release();
  const [first, ...rest] = await Promise.all([leader, ...followers]);
  assert.equal(worker.calls.length, 1, 'one read for three visitors');
  assert.equal(first.headers.get('X-Domino-Edge-Cache'), null, 'the leader was the Worker’s');
  assert.equal(first.headers.get('Server-Timing'), 'edge;desc="miss"');
  for (const response of rest) {
    assert.equal(await response.text(), CURRENT);
    assert.equal(response.headers.get('X-Domino-Edge-Cache'), 'hit');
    assert.equal(response.headers.get('Server-Timing'), 'edge;desc="coalesced"');
  }
  assert.equal(inflight.size, 0, 'nothing left behind');
});

test('F7: a leader whose answer is not a valid 200 leaves its followers to ask the Worker themselves; a slow one, after FOLLOW_WAIT_MS', async () => {
  const time = clock(), inflight = new Map();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let n = 0;
  const worker = bridge(async () => { n += 1; if (n === 1) { await gate; return said('{"error":"read_capacity_busy"}', { status: 429 }); } return said(CURRENT); });
  let following = 0;
  const rt = () => ({ contract: FEATURED, cache: null, now: time.now, inflight, refreshing: new Map(), log: () => undefined, logged: { last: null },
    timer: (ms, fire) => { following += 1; const handle = setTimeout(fire, ms); return () => clearTimeout(handle); } });
  const leader = answerFeatured(ask(), worker.env, rt());
  while (inflight.size === 0) await tick();
  const follower = answerFeatured(ask(), worker.env, rt());
  while (following < 1) await tick();
  release();
  assert.equal((await leader).status, 429);
  const own = await follower;
  assert.equal(own.status, 200);
  assert.equal(own.headers.get('X-Domino-Edge-Cache'), null);
  assert.equal(worker.calls.length, 2);
  // A leader that never answers: the follower's own timer ends its wait.
  const stuck = bridge(() => new Promise(() => undefined));
  const fired = [];
  const slow = { contract: FEATURED, cache: null, now: time.now, inflight: new Map(), refreshing: new Map(), log: () => undefined, logged: { last: null },
    timer: (ms, fire) => { fired.push(ms); setTimeout(fire, 0); return () => undefined; } };
  void answerFeatured(ask(), stuck.env, slow);
  while (slow.inflight.size === 0) await tick();
  const answered = bridge(() => said(CURRENT));
  const late = await answerFeatured(ask(), { READ_BRIDGE: answered.env.READ_BRIDGE }, slow);
  assert.deepEqual(fired, [FOLLOW_WAIT_MS]);
  assert.equal(late.status, 200);
  assert.equal(answered.calls.length, 1, 'it asked the Worker itself');
});

// ---------------------------------------------------------------------------
// The stored overview at the edge (A7 b, A14)
// ---------------------------------------------------------------------------

const askOverview = (body = { poolIds: [POOL] }, headers = {}) => ask({ url: `${ORIGIN}${OVERVIEW_PATH}`, body: JSON.stringify(body), version: v3.CONTRACT_VERSION, headers });
const overviewSaid = (body = OVERVIEW_BODY, options = {}) => said(JSON.stringify(body), { version: v3.CONTRACT_VERSION, ...options });

const OVERVIEW_KEY = overviewKey(v3.CONTRACT_VERSION, { poolIds: [POOL] });
/** A runtime timer that records each bounded wait and ends it after `ms` of real time (cleared once the work is in). */
function waits() {
  const armed = [];
  return { armed, timer: (ms, fire) => { armed.push(ms); const handle = setTimeout(fire, ms); return () => clearTimeout(handle); } };
}
/** Every piece of work handed to waitUntil, including work handed on by work, settled. */
async function drain(later) {
  while (later.length > 0) await Promise.all(later.splice(0));
}

// Changed on purpose 2026-10-30 (launch capacity study, item 4): a kept overview is served at once for ten minutes (it was
// 30 s), and one at least 30 s old waits a second at most for its refresh.
// Changed on purpose 2026-10-30 (QA round 2, final review edge-1): served at once for two minutes, so its APR is still
// within the page's 300 s when it lands; past them the VM is waited for up to 5 s (OVERVIEW_ERROR_WAIT_MS).
test('a settled overview is kept for the identical question: fresh 10 s, served at once while it refreshes, waited for a second at most from 30 s, served at once no longer past two minutes', async () => {
  assert.equal(v3.validateResponse('overview', OVERVIEW_BODY), true);
  assert.equal(settledOverview(JSON.stringify(OVERVIEW_BODY)), true);
  assert.deepEqual(
    [OVERVIEW_SECONDS, OVERVIEW_SETTLING_SECONDS, OVERVIEW_WAIT_AFTER_SECONDS, OVERVIEW_STALE_SECONDS, OVERVIEW_ERROR_SECONDS, OVERVIEW_REFRESH_WAIT_MS, OVERVIEW_ERROR_WAIT_MS],
    [10, 2, 30, 120, 900, 1_000, 5_000],
  );
  const cache = memoryCache(), time = clock(), later = [];
  let down = false;
  const worker = bridge(() => (down ? overviewSaid({ error: 'upstream_unavailable' }, { status: 503 }) : overviewSaid()));
  const rt = (extra = {}) => ({ contract: OVERVIEW, cache, now: time.now, refreshing: new Map(), waitUntil: (work) => later.push(work), ...extra });
  const first = await answerOverview(askOverview(), worker.env, rt());
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-Domino-Request-Id') !== null, true, 'the Worker’s answer');
  await drain(later);
  assert.deepEqual(cache.puts, [OVERVIEW_KEY]);
  assert.equal(cache.entries.get(OVERVIEW_KEY).headers.get('Cache-Control'), `max-age=${OVERVIEW_ERROR_SECONDS}`, 'the cache keeps it for its stale-if-error life');
  assert.equal(cache.entries.get(OVERVIEW_KEY).headers.get('X-Edge-Settling'), null, 'settled');
  time.at.now += OVERVIEW_SECONDS * 1000 - 1;
  const hit = await answerOverview(askOverview(), worker.env, rt());
  assert.equal(hit.headers.get('X-Domino-Edge-Cache'), 'hit');
  assert.equal(hit.headers.get('X-Domino-Edge-Age'), String(OVERVIEW_SECONDS * 1000 - 1));
  assert.deepEqual(await hit.json(), OVERVIEW_BODY);
  assert.equal(worker.calls.length, 1);
  // Changed on purpose 2026-11-07 (edge hardening): the same pools asked with a limit are the same question (the producer
  // lists exactly the pools asked whatever the limit), answered from it, checked against the request as asked.
  const limited = await answerOverview(askOverview({ poolIds: [POOL], limit: 12 }), worker.env, rt());
  assert.equal(limited.headers.get('X-Domino-Edge-Cache'), 'hit');
  assert.deepEqual(await limited.json(), OVERVIEW_BODY);
  assert.equal(worker.calls.length, 1);
  // Another question is never answered from it.
  await answerOverview(askOverview({ poolIds: [POOL, `0x${'ab'.repeat(32)}`] }), worker.env, rt());
  assert.equal(worker.calls.length, 2);
  // Stale and younger than 30 s: served at once, its refresh behind.
  time.at.now += 1;
  const quick = waits();
  const stale = await answerOverview(askOverview(), worker.env, rt({ timer: quick.timer }));
  assert.equal(stale.headers.get('X-Domino-Edge-Cache'), null, 'the request that refreshes it is counted');
  assert.equal(stale.headers.get('Server-Timing'), 'edge;desc="stale"');
  assert.deepEqual(quick.armed, [], 'no wait');
  await drain(later);
  assert.equal(worker.calls.length, 3);
  // At least 30 s old: the request that refreshes it waits for the newer answer, a second at most.
  time.at.now += OVERVIEW_WAIT_AFTER_SECONDS * 1000;
  const slow = waits();
  const waited = await answerOverview(askOverview(), worker.env, rt({ timer: slow.timer }));
  assert.deepEqual(slow.armed, [OVERVIEW_REFRESH_WAIT_MS]);
  assert.equal(waited.headers.get('Server-Timing'), 'edge;desc="miss"', 'the refresh it waited for');
  assert.equal(waited.headers.get('X-Domino-Edge-Age'), '0');
  await drain(later);
  assert.equal(worker.calls.length, 4);
  // Served to two minutes, the VM failing its refresh included; past them the VM answers.
  time.at.now += OVERVIEW_STALE_SECONDS * 1000 - 1;
  down = true;
  const kept = cache.puts.length;
  const late = await answerOverview(askOverview(), worker.env, rt());
  assert.equal(late.headers.get('Server-Timing'), 'edge;desc="stale"');
  assert.equal(late.headers.get('X-Domino-Edge-Age'), String(OVERVIEW_STALE_SECONDS * 1000 - 1));
  assert.deepEqual(await late.json(), OVERVIEW_BODY);
  await drain(later);
  assert.equal(worker.calls.length, 5);
  assert.equal(cache.puts.length, kept, 'the failed refresh kept nothing');
  down = false;
  time.at.now += 1;
  const past = await answerOverview(askOverview(), worker.env, rt());
  assert.equal(past.headers.get('Server-Timing'), 'edge;desc="miss"', 'never served at once past two minutes');
  assert.equal(worker.calls.length, 6);
  await drain(later);
});

// Changed on purpose 2026-10-30 (launch capacity study, item 4): such an answer was passed on and never kept, so at launch
// load, with the provider behind, the edge kept nothing.
// Changed on purpose 2026-10-30 (review): fresh 2 s, below the page's first catch-up (marketsProvider.ts CATCH_UP_FLOOR_MS,
// 2.5 s), so that catch-up finds it stale and waits for the figures coming; it was 5 s.
test('an overview still collecting, refreshing, failed, or without provider figures is kept 2 s, and once stale its refresh is waited for at once; one with nothing to show, a refusal or another question’s answer never', async () => {
  const pool = OVERVIEW_BODY.pools[0];
  const variants = [
    { ...OVERVIEW_BODY, pools: [{ ...pool, acquisition: { ...pool.acquisition, status: 'pending' } }] },
    { ...OVERVIEW_BODY, pools: [{ ...pool, acquisition: { ...pool.acquisition, refreshing: true } }] },
    // The provider rate limited, as the store serves it (tests/support/stale-store.mjs).
    { ...OVERVIEW_BODY, pools: [agedPoolEntry(pool, OVERVIEW_BODY.generatedAt, { providerBusy: true })] },
    { ...OVERVIEW_BODY, tokens: OVERVIEW_BODY.tokens.map((token, i) => (i === 0 ? { ...token, value: null, observedAt: null, acquisition: { ...token.acquisition, status: 'pending' } } : token)) },
  ];
  for (const [index, body] of variants.entries()) {
    assert.equal(v3.validateResponse('overview', body), true, `variant ${index} passes read-v3’s own runtime`);
    assert.equal(settledOverview(JSON.stringify(body)), false, `variant ${index}`);
    assert.equal(usefulOverview(JSON.stringify(body)), true, `variant ${index}`);
    const cache = memoryCache(), time = clock(), later = [];
    let settledNow = false;
    const worker = bridge(() => overviewSaid(settledNow ? OVERVIEW_BODY : body));
    const rt = (extra = {}) => ({ contract: OVERVIEW, cache, now: time.now, refreshing: new Map(), waitUntil: (work) => later.push(work), ...extra });
    const response = await answerOverview(askOverview(), worker.env, rt());
    assert.equal(response.status, 200);
    await drain(later);
    assert.deepEqual(cache.puts, [OVERVIEW_KEY], `variant ${index} kept`);
    assert.equal(cache.entries.get(OVERVIEW_KEY).headers.get('X-Edge-Settling'), '1');
    // Within 2 s identical loads meet the edge, not the VM.
    time.at.now += OVERVIEW_SETTLING_SECONDS * 1000 - 1;
    const hit = await answerOverview(askOverview(), worker.env, rt());
    assert.equal(hit.headers.get('X-Domino-Edge-Cache'), 'hit');
    assert.deepEqual(await hit.json(), body);
    assert.equal(worker.calls.length, 1);
    // From 2 s (the page's first catch-up is 2.5 s at the soonest), the request that refreshes it waits for the newer
    // answer at once: here the settled one.
    time.at.now += 1;
    settledNow = true;
    const catchUp = waits();
    const caught = await answerOverview(askOverview(), worker.env, rt({ timer: catchUp.timer }));
    assert.deepEqual(catchUp.armed, [OVERVIEW_REFRESH_WAIT_MS], `variant ${index}: waited for`);
    assert.deepEqual(await caught.json(), OVERVIEW_BODY);
    await drain(later);
    assert.equal(worker.calls.length, 2);
    assert.equal(cache.entries.get(OVERVIEW_KEY).headers.get('X-Edge-Settling'), null, 'the settled answer replaced it');
  }
  // Nothing to show yet (every pool and token listed, none with a value): passed on, never kept.
  const pendingToken = (token) => ({ ...token, value: null, observedAt: null, acquisition: { ...token.acquisition, status: 'pending' } });
  const empty = { ...OVERVIEW_BODY, pools: OVERVIEW_BODY.pools.map((entry) => pendingPoolEntry(entry, OVERVIEW_BODY.generatedAt)), tokens: OVERVIEW_BODY.tokens.map(pendingToken) };
  assert.equal(v3.validateResponse('overview', empty), true, 'the variant passes read-v3’s own runtime');
  assert.equal(usefulOverview(JSON.stringify(empty)), false);
  // (review) Pools asked by id and none listed has nothing to show either; a page of no pools asked by none is settled.
  const none = { ...OVERVIEW_BODY, pools: [], tokens: [] };
  assert.equal(v3.validateResponse('overview', none), true, 'the variant passes read-v3’s own runtime');
  assert.equal(usefulOverview(JSON.stringify(none)), false);
  assert.equal(usefulOverview(JSON.stringify({ ...none, requestedPoolIds: [] })), true);
  const nothing = memoryCache();
  assert.equal((await answerOverview(askOverview(), bridge(() => overviewSaid(empty)).env, { contract: OVERVIEW, cache: nothing, now: clock().now })).status, 200);
  assert.equal(nothing.puts.length, 0, 'nothing to show is never kept');
  // It never replaces a kept answer that has figures: that one is still served, stale, while the VM collects.
  const kept = memoryCache(), time = clock(), later = [];
  let collecting = false;
  const store = bridge(() => overviewSaid(collecting ? empty : OVERVIEW_BODY));
  const rt = () => ({ contract: OVERVIEW, cache: kept, now: time.now, refreshing: new Map(), waitUntil: (work) => later.push(work) });
  await answerOverview(askOverview(), store.env, rt());
  await drain(later);
  collecting = true;
  time.at.now += OVERVIEW_SECONDS * 1000;
  assert.deepEqual(await (await answerOverview(askOverview(), store.env, rt())).json(), OVERVIEW_BODY);
  await drain(later);
  assert.equal(store.calls.length, 2);
  assert.equal(kept.puts.length, 1, 'the refresh with nothing to show kept nothing');
  assert.deepEqual(await (await answerOverview(askOverview(), store.env, rt())).json(), OVERVIEW_BODY);
  await drain(later);
  // An answer to another question, a refusal: passed on, never kept.
  const cache = memoryCache();
  await answerOverview(askOverview({ poolIds: [`0x${'cd'.repeat(32)}`] }), bridge(() => overviewSaid()).env, { contract: OVERVIEW, cache, now: clock().now });
  await answerOverview(askOverview(), bridge(() => overviewSaid({ error: 'read_capacity_busy' }, { status: 429 })).env, { contract: OVERVIEW, cache, now: clock().now });
  assert.equal(cache.puts.length, 0);
});

// ---------------------------------------------------------------------------
// Stale-if-error (2026-10-30, launch capacity study, item 4)
// ---------------------------------------------------------------------------

/** A cache holding the settled overview, kept at the clock's start; `delete` as the Cache API's. */
async function keptOverview(time = clock()) {
  const cache = memoryCache();
  cache.delete = async (request) => cache.entries.delete(request.url);
  await answerOverview(askOverview(), bridge(() => overviewSaid()).env, { contract: OVERVIEW, cache, now: time.now });
  return { cache, time };
}

test('stale-if-error: past two minutes and up to fifteen, a kept overview stands in for a 408, a 429, any 5xx, a 200 that is no answer or one with nothing to show, dated and counted; never for a refusal, never past fifteen', async () => {
  const failures = [
    ['408', () => overviewSaid({ error: 'request_timeout' }, { status: 408 })],
    ['429', () => overviewSaid({ error: 'read_capacity_busy' }, { status: 429 })],
    ...[500, 502, 503, 504, 520, 530].map((status) => [String(status), () => overviewSaid({ error: 'upstream_unavailable' }, { status })]),
    ['no answer', () => overviewSaid({ ...OVERVIEW_BODY, requestedPoolIds: [`0x${'cd'.repeat(32)}`] })],
    // (review) A valid answer with nothing to show never replaces the kept figures for the visitor either.
    ['nothing to show', () => overviewSaid({ ...OVERVIEW_BODY, pools: [], tokens: [] })],
  ];
  for (const [label, answer] of failures) {
    const { cache, time } = await keptOverview();
    time.at.now += OVERVIEW_STALE_SECONDS * 1000;
    const failing = bridge(answer);
    const response = await answerOverview(askOverview(), failing.env, { contract: OVERVIEW, cache, now: time.now, inflight: new Map(), refreshing: new Map() });
    assert.equal(response.status, 200, label);
    assert.deepEqual(await response.json(), OVERVIEW_BODY, label);
    assert.equal(response.headers.get('Server-Timing'), 'edge;desc="stale-if-error"', label);
    assert.equal(response.headers.get('X-Domino-Edge-Age'), String(OVERVIEW_STALE_SECONDS * 1000), `${label}: dated`);
    assert.equal(response.headers.get('X-Domino-Edge-Cache'), null, `${label}: this request reached the Worker, which counted it`);
    assert.equal(response.headers.get('X-Domino-Read-Contract'), v3.CONTRACT_VERSION);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.equal(response.headers.get('X-Domino-Request-Id'), null);
    assert.equal(failing.calls.length, 1, label);
    assert.equal(cache.puts.length, 1, `${label}: the failure is never kept`);
  }
  // The forwarder's own failure (no binding) too.
  {
    const { cache, time } = await keptOverview();
    time.at.now += OVERVIEW_STALE_SECONDS * 1000;
    const response = await answerOverview(askOverview(), {}, { contract: OVERVIEW, cache, now: time.now, inflight: new Map(), refreshing: new Map() });
    assert.equal(response.headers.get('Server-Timing'), 'edge;desc="stale-if-error"');
  }
  // A refusal is the Worker's say, passed on as it came; a route switched off also takes the entry out.
  {
    const { cache, time } = await keptOverview();
    time.at.now += OVERVIEW_STALE_SECONDS * 1000;
    const invalid = await answerOverview(askOverview(), bridge(() => overviewSaid({ error: 'invalid_request' }, { status: 422 })).env, { contract: OVERVIEW, cache, now: time.now, inflight: new Map(), refreshing: new Map() });
    assert.deepEqual([invalid.status, await invalid.json()], [422, { error: 'invalid_request' }]);
    assert.equal(cache.entries.size, 1);
    const off = await answerOverview(askOverview(), bridge(() => overviewSaid({ error: 'route_not_available' }, { status: 404 })).env, { contract: OVERVIEW, cache, now: time.now, inflight: new Map(), refreshing: new Map() });
    assert.deepEqual([off.status, await off.json()], [404, { error: 'route_not_available' }]);
    assert.equal(cache.entries.size, 0, 'the route is off: the entry is out');
  }
  // A working VM's answer is the answer, and it is kept.
  {
    const { cache, time } = await keptOverview();
    time.at.now += OVERVIEW_STALE_SECONDS * 1000;
    const response = await answerOverview(askOverview(), bridge(() => overviewSaid()).env, { contract: OVERVIEW, cache, now: time.now, inflight: new Map(), refreshing: new Map() });
    assert.equal(response.headers.get('Server-Timing'), 'edge;desc="miss"');
    assert.equal(cache.puts.length, 2);
  }
  // Past fifteen minutes nothing stands in.
  {
    const { cache, time } = await keptOverview();
    time.at.now += OVERVIEW_ERROR_SECONDS * 1000;
    const response = await answerOverview(askOverview(), bridge(() => overviewSaid({ error: 'upstream_unavailable' }, { status: 503 })).env, { contract: OVERVIEW, cache, now: time.now, inflight: new Map(), refreshing: new Map() });
    assert.equal(response.status, 503);
  }
});

// Changed on purpose 2026-10-30 (QA round 2, final review edge-1): the bound is OVERVIEW_ERROR_WAIT_MS, 5 s; it was a second.
test('stale-if-error: a VM that does not answer within 5 s has the kept overview stand in, and its answer, when it comes, is kept behind', async () => {
  const { cache, time } = await keptOverview();
  time.at.now += OVERVIEW_STALE_SECONDS * 1000;
  let release;
  const late = new Promise((resolve) => { release = resolve; });
  const slow = bridge(async () => { await late; return overviewSaid(); });
  const later = [];
  const armed = [];
  const response = await answerOverview(askOverview(), slow.env, { contract: OVERVIEW, cache, now: time.now, inflight: new Map(), refreshing: new Map(), waitUntil: (work) => later.push(work),
    timer: (ms, fire) => { armed.push(ms); setTimeout(fire, 0); return () => undefined; } });
  assert.deepEqual(armed, [OVERVIEW_ERROR_WAIT_MS]);
  assert.equal(response.headers.get('Server-Timing'), 'edge;desc="stale-if-error"');
  assert.deepEqual(await response.json(), OVERVIEW_BODY);
  release();
  await drain(later);
  assert.equal(cache.puts.length, 2, 'the late answer is kept for the next visitor');
  const next = await answerOverview(askOverview(), slow.env, { contract: OVERVIEW, cache, now: time.now });
  assert.equal(next.headers.get('X-Domino-Edge-Cache'), 'hit');
  assert.equal(slow.calls.length, 1);
});

// Added 2026-10-30 (QA round 2, final review edge-1): a copy served at once for ten minutes, and past them after a second,
// reached a page whose VM was healthy but slower than a second with every APR past the page's 300 s on arrival
// (lib/read/aprEstimate.ts maxStaleSeconds), so the page showed stand-ins or none and asked DEX Screener for each pair.
test('a kept overview 360 s old is not served at once: a VM that answers within 5 s gives its current overview, and a failure that comes at once still has the copy stand in', async () => {
  const AGE_MS = 360_000;
  assert.ok(AGE_MS > OVERVIEW_STALE_SECONDS * 1000 && AGE_MS < OVERVIEW_ERROR_SECONDS * 1000, 'past the at-once window, within the stand-in one');
  {
    const { cache, time } = await keptOverview();
    time.at.now += AGE_MS;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const vm = bridge(async () => { await gate; return overviewSaid(); });
    const armed = [], later = [];
    let answered = false;
    // The 5 s bound is armed and never runs out here: the VM answers within it (2.5 s under launch load, say).
    const asked = answerOverview(askOverview(), vm.env, { contract: OVERVIEW, cache, now: time.now, inflight: new Map(), refreshing: new Map(), waitUntil: (work) => later.push(work),
      timer: (ms) => { armed.push(ms); return () => undefined; } });
    void asked.then(() => { answered = true; });
    while (vm.calls.length === 0) await tick();
    for (let n = 0; n < 5; n += 1) await tick();
    assert.equal(answered, false, 'the 360 s copy is not served at once');
    assert.deepEqual(armed, [OVERVIEW_ERROR_WAIT_MS]);
    release();
    const response = await asked;
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Server-Timing'), 'edge;desc="miss"', 'the VM’s own answer');
    assert.notEqual(response.headers.get('X-Domino-Request-Id'), null);
    assert.equal(response.headers.get('X-Domino-Edge-Age'), null, 'dated as it arrives, not 360 s back');
    assert.deepEqual(await response.json(), OVERVIEW_BODY);
    await drain(later);
    assert.equal(cache.puts.length, 2, 'kept for the next visitor');
    assert.equal(vm.calls.length, 1);
  }
  // A 503 at once (the forwarder's, say): the copy stands in as it comes, without waiting out the 5 s.
  {
    const { cache, time } = await keptOverview();
    time.at.now += AGE_MS;
    const armed = [];
    const response = await answerOverview(askOverview(), bridge(() => overviewSaid({ error: 'upstream_unavailable' }, { status: 503 })).env,
      { contract: OVERVIEW, cache, now: time.now, inflight: new Map(), refreshing: new Map(), timer: (ms) => { armed.push(ms); return () => undefined; } });
    assert.deepEqual(armed, [OVERVIEW_ERROR_WAIT_MS], 'armed, never run out');
    assert.equal(response.headers.get('Server-Timing'), 'edge;desc="stale-if-error"');
    assert.equal(response.headers.get('X-Domino-Edge-Age'), String(AGE_MS));
    assert.deepEqual(await response.json(), OVERVIEW_BODY);
  }
});

test('stale-if-error: requests that join a failing or slow miss get the kept overview, which no gateway saw, and the VM is asked once', async () => {
  const { cache, time } = await keptOverview();
  time.at.now += OVERVIEW_STALE_SECONDS * 1000;
  const inflight = new Map();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // (2026-11-07) A 503: a 429 is now that one visitor's refusal, and its followers ask for themselves
  // (tests/edge-hardening.test.mjs, "a 429 is the asker's own").
  const worker = bridge(async () => { await gate; return overviewSaid({ error: 'upstream_unavailable' }, { status: 503 }); });
  let armed = 0;
  const rt = () => ({ contract: OVERVIEW, cache, now: time.now, inflight, refreshing: new Map(), timer: () => { armed += 1; return () => undefined; } });
  const leader = answerOverview(askOverview(), worker.env, rt());
  while (inflight.size === 0) await tick();
  const followers = [answerOverview(askOverview(), worker.env, rt()), answerOverview(askOverview(), worker.env, rt())];
  while (armed < 3) await tick();
  release();
  const [first, ...rest] = await Promise.all([leader, ...followers]);
  assert.equal(worker.calls.length, 1, 'one read of the VM for three visitors');
  assert.equal(first.headers.get('Server-Timing'), 'edge;desc="stale-if-error"');
  assert.equal(first.headers.get('X-Domino-Edge-Cache'), null);
  for (const response of rest) {
    assert.deepEqual(await response.json(), OVERVIEW_BODY);
    assert.equal(response.headers.get('X-Domino-Edge-Cache'), 'hit', 'no gateway saw it');
    assert.equal(response.headers.get('Server-Timing'), 'edge;desc="stale-if-error"');
  }
  assert.equal(inflight.size, 0, 'nothing left behind');
  // A miss that does not settle: a follower waits FOLLOW_WAIT_MS at the most, then the kept answer, and asks nothing.
  const stuck = bridge(() => new Promise(() => undefined));
  const fired = [];
  const slow = { contract: OVERVIEW, cache, now: time.now, inflight: new Map(), refreshing: new Map(), timer: (ms, fire) => { fired.push(ms); setTimeout(fire, 0); return () => undefined; } };
  const stand = await answerOverview(askOverview(), stuck.env, slow);
  assert.equal(stand.headers.get('Server-Timing'), 'edge;desc="stale-if-error"', 'the leader, at its own bound');
  const follower = await answerOverview(askOverview(), stuck.env, slow);
  assert.deepEqual(fired, [OVERVIEW_ERROR_WAIT_MS, FOLLOW_WAIT_MS]);
  assert.equal(follower.headers.get('Server-Timing'), 'edge;desc="stale-if-error"');
  assert.equal(follower.headers.get('X-Domino-Edge-Cache'), 'hit');
  assert.equal(stuck.calls.length, 1, 'the follower did not ask the stuck VM again');
  // One older than LEAD_LIFE_MS (its request cut off, say) is not joined: a new read starts.
  time.at.now += LEAD_LIFE_MS;
  const fresh = bridge(() => overviewSaid());
  const after = await answerOverview(askOverview(), fresh.env, { ...slow, timer: () => () => undefined });
  assert.equal(after.headers.get('Server-Timing'), 'edge;desc="miss"');
  assert.equal(fresh.calls.length, 1);
});

// Added 2026-10-30 (review of the launch change): the refresh guard was lifted as soon as a refresh settled, failed or
// not, and a read past ten minutes had no guard at all, so during a 429 storm every request in an isolate reached the VM.
test('a failing VM is asked about a question once per REFRESH_GUARD_MS in an isolate, served stale or past two minutes; meanwhile the kept overview is served as a hit', async () => {
  assert.equal(REFRESH_GUARD_MS, 10_000);
  const none = { ...OVERVIEW_BODY, pools: [], tokens: [] };
  // (2026-11-07) No 429 here any more: the gateway's refusal of one visitor (mostly its own budget) guards nothing for the
  // others (tests/edge-hardening.test.mjs, "a 429 is the asker's own"). A 408 joins in its place.
  const answers = [
    ['408', () => overviewSaid({ error: 'request_timeout' }, { status: 408 })],
    ['503', () => overviewSaid({ error: 'upstream_unavailable' }, { status: 503 })],
    ['nothing to show', () => overviewSaid(none)],
  ];
  for (const [window, age, made] of [['stale', OVERVIEW_SECONDS * 1000, 'stale'], ['past two minutes', OVERVIEW_STALE_SECONDS * 1000, 'stale-if-error']]) {
    for (const [label, answer] of answers) {
      const { cache, time } = await keptOverview();
      time.at.now += age;
      const refreshing = new Map(), inflight = new Map(), later = [];
      let good = false;
      const worker = bridge(() => (good ? overviewSaid() : answer()));
      const rt = () => ({ contract: OVERVIEW, cache, now: time.now, refreshing, inflight, waitUntil: (work) => later.push(work), timer: (_ms, fire) => { setTimeout(fire, 0); return () => undefined; } });
      const seen = [];
      // A hundred visitors over five seconds.
      for (let n = 0; n < 100; n += 1) {
        const response = await answerOverview(askOverview(), worker.env, rt());
        assert.deepEqual(await response.json(), OVERVIEW_BODY, `${window}, ${label}: the kept figures, every time`);
        seen.push(`${response.headers.get('Server-Timing')} ${response.headers.get('X-Domino-Edge-Cache')}`);
        await drain(later);
        time.at.now += 50;
      }
      assert.equal(worker.calls.length, 1, `${window}, ${label}: one read of the failing VM`);
      assert.equal(cache.puts.length, 1, `${window}, ${label}: nothing new kept`);
      assert.equal(seen[0], `edge;desc="${made}" null`, `${window}, ${label}: the request that asked is counted`);
      assert.deepEqual([...new Set(seen.slice(1))], [`edge;desc="${made}" hit`], `${window}, ${label}: the rest gave their read back`);
      // Once the guard is over, one read again; a good answer is kept, and lifts the guard.
      time.at.now += REFRESH_GUARD_MS;
      good = true;
      await answerOverview(askOverview(), worker.env, rt());
      await drain(later);
      assert.equal(worker.calls.length, 2, `${window}, ${label}: asked again after the guard`);
      assert.equal(cache.puts.length, 2, `${window}, ${label}: the good answer is kept`);
      assert.equal(refreshing.size, 0, `${window}, ${label}: the guard is lifted`);
      const after = await answerOverview(askOverview(), worker.env, rt());
      assert.equal(after.headers.get('Server-Timing'), 'edge;desc="hit"');
    }
  }
  // Followers of a leader whose answer has nothing to show get the kept figures, not that answer.
  {
    const { cache, time } = await keptOverview();
    time.at.now += OVERVIEW_STALE_SECONDS * 1000;
    const inflight = new Map();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const worker = bridge(async () => { await gate; return overviewSaid(none); });
    let armed = 0;
    const rt = () => ({ contract: OVERVIEW, cache, now: time.now, inflight, refreshing: new Map(), timer: () => { armed += 1; return () => undefined; } });
    const leader = answerOverview(askOverview(), worker.env, rt());
    while (inflight.size === 0) await tick();
    const follower = answerOverview(askOverview(), worker.env, rt());
    while (armed < 2) await tick();
    release();
    for (const response of await Promise.all([leader, follower])) {
      assert.deepEqual(await response.json(), OVERVIEW_BODY);
      assert.equal(response.headers.get('Server-Timing'), 'edge;desc="stale-if-error"');
    }
    assert.equal(worker.calls.length, 1);
    assert.equal(cache.puts.length, 1);
  }
  // A follower waits no longer than its leader does, FOLLOW_WAIT_MS at the most: one that joins 600 ms in waits a second;
  // one that joins 4.6 s in, the 400 ms left of the leader's 5 s (OVERVIEW_ERROR_WAIT_MS since the final review's edge-1).
  {
    const { cache, time } = await keptOverview();
    time.at.now += OVERVIEW_STALE_SECONDS * 1000;
    const stuck = bridge(() => new Promise(() => undefined));
    const fired = [];
    const slow = { contract: OVERVIEW, cache, now: time.now, inflight: new Map(), refreshing: new Map(), timer: (ms, fire) => { fired.push(ms); setTimeout(fire, 0); return () => undefined; } };
    await answerOverview(askOverview(), stuck.env, slow);
    time.at.now += 600;
    const early = await answerOverview(askOverview(), stuck.env, slow);
    time.at.now += 4_000;
    const follower = await answerOverview(askOverview(), stuck.env, slow);
    time.at.now += 400;
    const late = await answerOverview(askOverview(), stuck.env, slow);
    assert.deepEqual(fired, [OVERVIEW_ERROR_WAIT_MS, FOLLOW_WAIT_MS, 400], 'the last one waits nothing');
    for (const response of [early, follower, late]) {
      assert.equal(response.headers.get('Server-Timing'), 'edge;desc="stale-if-error"');
      assert.equal(response.headers.get('X-Domino-Edge-Cache'), 'hit');
    }
    assert.equal(stuck.calls.length, 1);
  }
});

// ---------------------------------------------------------------------------
// I3: DEX Screener through our own edge
// ---------------------------------------------------------------------------

const TOKEN = '0xefab538cf3c29237a47c6afb145d50ddf204a0a3';
const OTHER = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const pair = (pairAddress, base, quote, usd, extra = {}) => ({
  chainId: 'robinhood', dexId: 'uniswap', url: 'https://dexscreener.com/x', labels: ['v4'], pairAddress,
  baseToken: { address: base, name: 'Base', symbol: 'B' }, quoteToken: { address: quote, name: 'Quote', symbol: 'Q' },
  priceNative: '0.5', priceUsd: '0.002', txns: { h24: { buys: 1, sells: 2 } }, volume: { h24: 7500, h6: 1 }, priceChange: { h24: 1 },
  liquidity: { usd, base: 1, quote: 2 }, fdv: 1, marketCap: 1, pairCreatedAt: 1727000000000, info: { imageUrl: 'https://cdn.dexscreener.com/cms/images/abcdefgh?width=64', websites: [{ url: 'x' }] }, ...extra,
});
const getAsk = (path, headers = {}) => new Request(`${ORIGIN}/api/read/dex/${path}`, { method: 'GET', headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', ...headers } });

function upstream(answer) {
  const calls = [];
  return { calls, fetch: async (url, init) => { calls.push({ url, init }); return answer(url); } };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Added 2026-10-14 (incident of 2026-10-13, package D1): the route now remembers, per isolate, the tokens whose read gave
// nothing, the provider's own "wait" and each visitor's allowance (dexEdge.ts DexMemory). A case that gives no memory of
// its own uses the isolate's, emptied before each case here, so no case hears of another's refusals.
beforeEach(() => resetDexMemory());

test('I3: only a plain same-origin GET of the two paths, with addresses, is asked of the provider', () => {
  assert.deepEqual(dexAsk(getAsk(`token-pairs/${TOKEN.toUpperCase().replace('0X', '0x')}`))?.tokens, [TOKEN]);
  assert.deepEqual(dexAsk(getAsk(`tokens/${TOKEN},${OTHER},${TOKEN}`))?.tokens, [TOKEN, OTHER]);
  for (const bad of [
    getAsk(`token-pairs/${TOKEN},${OTHER}`), getAsk('token-pairs/0x123'), getAsk(`pairs/${TOKEN}`), getAsk(`token-pairs/${TOKEN}/x`),
    getAsk(`tokens/${Array.from({ length: 11 }, (_, i) => `0x${String(i).padStart(40, '0')}`).join(',')}`),
    getAsk(`token-pairs/${TOKEN}`, { 'Sec-Fetch-Site': 'cross-site' }), getAsk(`token-pairs/${TOKEN}`, { Origin: 'https://evil.example' }),
    getAsk(`token-pairs/${TOKEN}`, { 'CF-Worker': 'evil.example' }),
    new Request(`${ORIGIN}/api/read/dex/token-pairs/${TOKEN}?x=1`), new Request(`${ORIGIN}/api/read/dex/token-pairs/${TOKEN}`, { method: 'POST', body: '{}' }),
  ]) assert.equal(dexAsk(bad), null, bad.url);
});

test('I3: the provider’s pairs are passed on trimmed to the fields the page reads, Robinhood Chain only, one token per upstream read', async () => {
  const body = [pair(`0x${'31'.repeat(32)}`, TOKEN, OTHER, 40200), pair('0x' + '1'.repeat(40), TOKEN, OTHER, 5, { chainId: 'ethereum' }), { junk: true }];
  const dex = upstream(() => json(body));
  const cache = memoryCache(), time = clock();
  const response = await answerDex(getAsk(`token-pairs/${TOKEN}`), { cache, now: time.now, fetch: dex.fetch, inflight: new Map(), refreshing: new Map() });
  assert.equal(response.status, 200);
  const pairs = await response.json();
  assert.equal(pairs.length, 1);
  assert.deepEqual(Object.keys(pairs[0]).sort(), ['baseToken', 'chainId', 'dexId', 'info', 'labels', 'liquidity', 'pairAddress', 'pairCreatedAt', 'priceNative', 'priceUsd', 'quoteToken', 'volume'].sort());
  assert.deepEqual(pairs[0].liquidity, { usd: 40200 });
  assert.deepEqual(pairs[0].volume, { h24: 7500 });
  assert.deepEqual(pairs[0].info, { imageUrl: 'https://cdn.dexscreener.com/cms/images/abcdefgh?width=64' });
  assert.equal(dex.calls.length, 1);
  assert.equal(dex.calls[0].url, `https://api.dexscreener.com/token-pairs/v1/robinhood/${TOKEN}`);
  assert.equal(dex.calls[0].init.headers.Cookie, undefined, 'nothing of the visitor goes upstream');
  assert.equal(response.headers.get('X-Domino-Edge-Age'), '0');
  // Kept: the next ask within 30 s reads nothing upstream; past it, it is served while it is read again behind.
  time.at.now += DEX_FRESH_SECONDS * 1000 - 1;
  const hit = await answerDex(getAsk(`token-pairs/${TOKEN}`), { cache, now: time.now, fetch: dex.fetch, inflight: new Map(), refreshing: new Map() });
  assert.equal(hit.headers.get('Server-Timing'), 'edge;desc="hit"');
  assert.equal(dex.calls.length, 1);
  time.at.now += 1;
  const later = [];
  const stale = await answerDex(getAsk(`token-pairs/${TOKEN}`), { cache, now: time.now, fetch: dex.fetch, inflight: new Map(), refreshing: new Map(), waitUntil: (work) => later.push(work) });
  assert.equal(stale.headers.get('Server-Timing'), 'edge;desc="stale"');
  assert.equal(stale.headers.get('X-Domino-Edge-Age'), String(DEX_FRESH_SECONDS * 1000));
  await Promise.all(later);
  assert.equal(dex.calls.length, 2);
  assert.equal(trimPair({ ...pair('0x1', TOKEN, OTHER, 1), baseToken: { address: 'nope' } }), null);
});

test('I3: a batch is asked one token at a time, each token’s most liquid pairs and its base pair kept; a gap is a 502, never a partial answer', async () => {
  const many = Array.from({ length: 8 }, (_, i) => pair(`0x${String(i).padStart(64, 'a')}`, i === 7 ? TOKEN : OTHER, i === 7 ? OTHER : TOKEN, 100 * (8 - i)));
  const kept = pairsForPrice(many.map(trimPair), TOKEN);
  assert.equal(kept.length, 5, 'four most liquid, and the one it is the base of');
  assert.equal(kept.at(-1).baseToken.address, TOKEN);
  const dex = upstream((url) => (url.endsWith(TOKEN) ? json(many) : json([pair(`0x${'e'.repeat(64)}`, OTHER, TOKEN, 9)])));
  const response = await answerDex(getAsk(`tokens/${TOKEN},${OTHER}`), { cache: memoryCache(), now: clock().now, fetch: dex.fetch, inflight: new Map(), refreshing: new Map() });
  assert.equal(response.status, 200);
  assert.deepEqual(dex.calls.map((call) => call.url).sort(), [`https://api.dexscreener.com/token-pairs/v1/robinhood/${OTHER}`, `https://api.dexscreener.com/token-pairs/v1/robinhood/${TOKEN}`]);
  assert.ok((await response.json()).length <= 10);
  const refused = upstream((url) => (url.endsWith(OTHER) ? json({ error: 'rate limited' }, 429) : json(many)));
  // 2026-10-14 (D1): an isolate of its own, so the provider's "wait" this 429 leaves is not the next ask's (another edge, below).
  const gap = await answerDex(getAsk(`tokens/${TOKEN},${OTHER}`), { cache: memoryCache(), now: clock().now, fetch: refused.fetch, inflight: new Map(), refreshing: new Map(), memory: dexMemory() });
  assert.equal(gap.status, 502);
  assert.deepEqual(await gap.json(), { error: 'upstream_unavailable' });
  // A refusal is never kept; an answer past five minutes is not served.
  const cache = memoryCache(), time = clock();
  const once = upstream(() => json(many));
  await answerDex(getAsk(`token-pairs/${TOKEN}`), { cache, now: time.now, fetch: once.fetch, inflight: new Map(), refreshing: new Map() });
  time.at.now += DEX_STALE_SECONDS * 1000;
  const down = upstream(() => json({}, 503));
  const expired = await answerDex(getAsk(`token-pairs/${TOKEN}`), { cache, now: time.now, fetch: down.fetch, inflight: new Map(), refreshing: new Map() });
  assert.equal(expired.status, 502);
});

test('I3: Wallet prices include qualified v4 pairs omitted by the provider tokens endpoint, without another upstream read', async () => {
  // Public UFG responses observed 2026-10-11: tokens/v1 returned only the thin v3 pool;
  // token-pairs/v1 also returned these liquid v4 pools. Values are fixtures, never application quotes.
  const thin = pair('0x51eb8e500cc42a630e0daaa2168ad9908f35a034', TOKEN, OTHER, 1660.31, { labels: ['v3'], priceUsd: '0.001975' });
  const liquid = pair('0x1c508008e791483d2452111ca3cfc5ab8365f5a6e365d096cad2efb01623d7de', TOKEN, `0x${'0'.repeat(40)}`, 130994.11, { priceUsd: '0.001975', priceNative: '0.0000007795' });
  const dollar = pair('0x031fe000f185cdf1b8850821d22bdf4ed1e337909be7caa00c2b68594da83f03', TOKEN, OTHER, 27354.48, { priceUsd: '0.001951' });
  assert.equal(quotesFromTokens([thin], [TOKEN]).get(TOKEN), null, 'the original response still fails the unchanged liquidity threshold');
  const dex = upstream((url) => json(url.includes('/token-pairs/') ? [thin, dollar, liquid] : [thin]));
  const cache = memoryCache();
  const runtime = { cache, now: clock().now, fetch: dex.fetch, inflight: new Map(), refreshing: new Map() };
  const response = await answerDex(getAsk(`tokens/${TOKEN}`), runtime);
  assert.equal(response.status, 200);
  const body = await response.json();
  const quotes = quotesFromTokens(body, [TOKEN]);
  assert.deepEqual(quotes.get(TOKEN), { usd: '0.001975', liquidityUsd: 130994.11 });
  assert.equal(body[0].pairAddress, liquid.pairAddress, 'the existing most-liquid selection is preserved');
  const held = {
    key: `4663:${TOKEN}`, token: { chainId: 4663, address: TOKEN, symbol: 'UFG', decimals: 18 },
    amount: { state: 'value', text: '1363607' }, raw: (1363607n * 10n ** 18n).toString(), old: false,
  };
  assert.equal(walletHoldings([held], quotes).all[0].value, 2693123825n * 10n ** 12n, 'the real Wallet valuation path can price the held amount');
  assert.equal(walletHoldings([{ ...held, raw: (200000000n * 10n ** 18n).toString() }], quotes).all[0].value, null, 'a holding larger than the pool liquidity remains unqualified');
  assert.equal(dex.calls.length, 1, 'one token still costs one upstream request');
  assert.equal(dex.calls[0].url, `https://api.dexscreener.com/token-pairs/v1/robinhood/${TOKEN}`);
  assert.equal(dex.calls[0].init.headers.Cookie, undefined);
  const cached = await answerDex(getAsk(`tokens/${TOKEN}`), runtime);
  assert.deepEqual(await cached.json(), body);
  assert.equal(dex.calls.length, 1, 'the following price lookup reuses the existing cache');
});

test('I3 (2026-10-03): an ask answers before the page gives up on it: a token not read in time is a 502 at once, and its read goes on behind, kept for the next ask', async () => {
  let release = () => {};
  const slow = upstream(() => new Promise((resolve) => { release = () => resolve(json([pair(`0x${'41'.repeat(32)}`, TOKEN, OTHER, 900)])); }));
  const cache = memoryCache(), time = clock(), later = [];
  const runtime = { cache, now: time.now, fetch: slow.fetch, inflight: new Map(), refreshing: new Map(), waitUntil: (work) => later.push(work), answerMs: 30 };
  const started = Date.now();
  const late = await answerDex(getAsk(`token-pairs/${TOKEN}`), runtime);
  assert.equal(late.status, 502, 'the page hears at once and asks the provider itself');
  assert.ok(Date.now() - started < 1000, 'well before the page would give up');
  assert.equal(later.length, 1, 'the read goes on behind');
  release();
  await Promise.all(later);
  const hit = await answerDex(getAsk(`token-pairs/${TOKEN}`), { ...runtime, waitUntil: undefined });
  assert.equal(hit.status, 200, 'what the read brought back is kept');
  assert.equal(slow.calls.length, 1, 'and nothing more is asked upstream');
});

// Added 2026-10-06 (the owner's point 3: Base's and Arbitrum One's pools in New position with TVL, 24h volume and APR
// "like Robinhood Chain", from the same provider): token-pairs for a token on Base or Arbitrum One, by the provider's
// own name for the chain, asked and kept the same way, under that chain's own key.
test('I3 (2026-10-06): token-pairs/<base|arbitrum>/<token> asks the provider about that chain, passes on that chain’s pairs only, and keeps them apart from Robinhood Chain’s', async () => {
  assert.deepEqual(dexAsk(getAsk(`token-pairs/base/${TOKEN}`)), { kind: 'token-pairs', chain: 'base', tokens: [TOKEN], origin: ORIGIN });
  assert.equal(dexAsk(getAsk(`token-pairs/arbitrum/${TOKEN.toUpperCase().replace('0X', '0x')}`))?.chain, 'arbitrum');
  assert.equal(dexAsk(getAsk(`token-pairs/${TOKEN}`))?.chain, 'robinhood', 'Robinhood Chain keeps its path');
  // Added 2026-11-09 (Elysium's day 9, checklist step 6): Elysium's, by the provider's own name, as Base's.
  assert.deepEqual(dexAsk(getAsk(`token-pairs/elysium/${TOKEN}`)), { kind: 'token-pairs', chain: 'elysium', tokens: [TOKEN], origin: ORIGIN });
  for (const bad of [`token-pairs/robinhood/${TOKEN}`, `tokens/elysium/${TOKEN}`, `token-pairs/ethereum/${TOKEN}`, `tokens/base/${TOKEN}`, `token-pairs/base/${TOKEN},${OTHER}`, `token-pairs/base/0x123`, `token-pairs/base/${TOKEN}/x`, 'token-pairs/base/']) {
    assert.equal(dexAsk(getAsk(bad)), null, bad);
  }
  const V4_ID = `0x${'af'.repeat(32)}`;
  const V3_POOL = '0x529d2863a1521d0b57db028168fde2e97120017c';
  const body = [
    pair(V4_ID, TOKEN, OTHER, 136159, { chainId: 'base' }),
    pair(V3_POOL, TOKEN, OTHER, 939056, { chainId: 'base', labels: ['v3'] }),
    pair(`0x${'31'.repeat(32)}`, TOKEN, OTHER, 5),
  ];
  const dex = upstream(() => json(body));
  const cache = memoryCache(), time = clock();
  const response = await answerDex(getAsk(`token-pairs/base/${TOKEN}`), { cache, now: time.now, fetch: dex.fetch, inflight: new Map(), refreshing: new Map() });
  assert.equal(response.status, 200);
  assert.equal(dex.calls[0].url, `https://api.dexscreener.com/token-pairs/v1/base/${TOKEN}`);
  const pairs = await response.json();
  assert.deepEqual(pairs.map((p) => [p.chainId, p.pairAddress]), [['base', V4_ID], ['base', V3_POOL]], 'Base’s pairs only, v4 ids and v3 addresses both, named as the provider names them');
  // Changed on purpose 2026-10-14 (D1): one entry per chain and token for both views, so the key names the chain and no
  // longer the view (it was …/cache/v1/base/token-pairs/<token>).
  assert.deepEqual(cache.puts, [`${ORIGIN}/api/read/dex/cache/v2/base/${TOKEN}`], 'kept under Base’s own key');
  // The same address on Robinhood Chain is another token: its own read, its own key.
  const home = upstream(() => json(body));
  const robinhood = await answerDex(getAsk(`token-pairs/${TOKEN}`), { cache, now: time.now, fetch: home.fetch, inflight: new Map(), refreshing: new Map() });
  assert.deepEqual((await robinhood.json()).map((p) => p.chainId), ['robinhood']);
  assert.equal(home.calls[0].url, `https://api.dexscreener.com/token-pairs/v1/robinhood/${TOKEN}`);
  // Changed on purpose 2026-10-14 (D1): Robinhood Chain's key names its chain too (it was …/cache/v1/token-pairs/<token>).
  assert.equal(cache.puts[1], `${ORIGIN}/api/read/dex/cache/v2/robinhood/${TOKEN}`, 'Robinhood Chain’s own key');
  // Kept: Base's next ask within 30 s reads nothing upstream.
  const again = await answerDex(getAsk(`token-pairs/base/${TOKEN}`), { cache, now: time.now, fetch: dex.fetch, inflight: new Map(), refreshing: new Map() });
  assert.equal(again.headers.get('Server-Timing'), 'edge;desc="hit"');
  assert.equal(dex.calls.length, 1);
  assert.equal(trimPairOn('arbitrum')({ ...pair(V3_POOL, TOKEN, OTHER, 1), chainId: 'base' }), null, 'another chain’s pair is never passed on');
});

// ---------------------------------------------------------------------------
// D1 (incident of 2026-10-13, about nine 502 on /api/read/dex/ at every load): reads that cannot die, the reason in the
// answer, one kept entry per chain and token, misses remembered, a visitor's allowance, and a new path,
// /api/read/dex2/, whose answer is always a 200 that says each token's own state. The old path keeps its shape.
// ---------------------------------------------------------------------------

const getAsk2 = (path, headers = {}) => new Request(`${ORIGIN}/api/read/dex2/${path}`, { method: 'GET', headers: { 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors', 'Sec-Fetch-Dest': 'empty', ...headers } });
const nth = (i) => `0x${(i + 1).toString(16).padStart(40, '0')}`;
const tokenOf = (url) => url.split('/').at(-1);
/** One pair the provider would list for `token`, as its base. */
const own = (token, usd = 50_000) => pair(`0x${token.slice(2, 10)}${'5'.repeat(56)}`, token, OTHER, usd);
/** An isolate of a case's own, over one cache and one clock: its reads in flight, its refresh guard and what it remembers. */
function edge(dex, extra = {}) {
  const cache = memoryCache(), time = clock(), later = [];
  return { cache, time, later, rt: { cache, now: time.now, fetch: dex.fetch, inflight: new Map(), refreshing: new Map(), memory: dexMemory(), waitUntil: (work) => later.push(work), ...extra } };
}

test('D1: the new path takes the old path’s asks under its own prefix, and neither answers the other’s', async () => {
  assert.deepEqual(dex2Ask(getAsk2(`tokens/${TOKEN},${OTHER},${TOKEN}`)), { kind: 'tokens', chain: 'robinhood', tokens: [TOKEN, OTHER], origin: ORIGIN });
  assert.deepEqual(dex2Ask(getAsk2(`token-pairs/${TOKEN.toUpperCase().replace('0X', '0x')}`)), { kind: 'token-pairs', chain: 'robinhood', tokens: [TOKEN], origin: ORIGIN });
  assert.deepEqual(dex2Ask(getAsk2(`token-pairs/arbitrum/${TOKEN}`)), { kind: 'token-pairs', chain: 'arbitrum', tokens: [TOKEN], origin: ORIGIN });
  for (const bad of [
    getAsk2(`tokens/${Array.from({ length: MAX_TOKENS + 1 }, (_, i) => nth(i)).join(',')}`), getAsk2(`tokens/base/${TOKEN}`), getAsk2(`token-pairs/${TOKEN},${OTHER}`), getAsk2(`pairs/${TOKEN}`),
    getAsk2(`tokens/${TOKEN}`, { 'Sec-Fetch-Site': 'cross-site' }), getAsk2(`tokens/${TOKEN}`, { Origin: 'https://evil.example' }), getAsk2(`tokens/${TOKEN}`, { 'CF-Worker': 'evil.example' }),
    new Request(`${ORIGIN}/api/read/dex2/tokens/${TOKEN}?x=1`), new Request(`${ORIGIN}/api/read/dex2/tokens/${TOKEN}`, { method: 'POST', body: '{}' }), getAsk(`tokens/${TOKEN}`),
  ]) assert.equal(dex2Ask(bad), null, bad.url);
  assert.equal(dexAsk(getAsk2(`tokens/${TOKEN}`)), null, 'the old path’s reader never takes a new-path ask');
  const dex = upstream(() => json([own(TOKEN)]));
  const { rt } = edge(dex);
  assert.equal((await answerDex2(getAsk(`tokens/${TOKEN}`), rt)).status, 404);
  assert.equal((await answerDex(getAsk2(`tokens/${TOKEN}`), rt)).status, 404);
  assert.equal(dex.calls.length, 0);
});

test('D1: a read whose asker went away does not hold the next asks past its bound; past it a new read starts (it was a 502 for good)', async () => {
  // The first upstream read never settles, as when Cloudflare cancels the tasks of a request whose visitor left
  // (sharedWork.ts). `release` ends it with the case, so it leaves no timer behind.
  let release = () => {};
  let n = 0;
  const dex = upstream(() => (++n === 1 ? new Promise((resolve) => { release = () => resolve(json([])); }) : json([own(TOKEN)])));
  const { rt, time, later } = edge(dex, { answerMs: 30 });
  assert.equal((await answerDex(getAsk(`token-pairs/${TOKEN}`), rt)).status, 502, 'the first asker’s own read was late');
  time.at.now += 1_000;
  const waiting = await answerDex(getAsk(`token-pairs/${TOKEN}`), rt);
  assert.equal(waiting.status, 502, 'within the bound the next ask joins the read on its way, for no longer than its own 30 ms');
  assert.equal(dex.calls.length, 1);
  time.at.now += DEX_READ_STALE_MS;
  const after = await answerDex(getAsk(`token-pairs/${TOKEN}`), rt);
  assert.equal(after.status, 200, 'past the bound the dead read is not joined: a new one answers');
  assert.equal(dex.calls.length, 2);
  assert.equal(waiting.headers.get('Server-Timing'), `edge;desc="miss", miss;dur=1000;desc="joined ${TOKEN}"`, 'the old path’s 502 says it joined a read, and how old that read was');

  // The new path says the same as a state of its 200: its own read still on its way, then a read it joined, then pairs.
  let free = () => {};
  let m = 0;
  const slow = upstream(() => (++m === 1 ? new Promise((resolve) => { free = () => resolve(json([])); }) : json([own(TOKEN)])));
  const second = edge(slow, { answerMs: 30 });
  const first = await answerDex2(getAsk2(`tokens/${TOKEN}`), second.rt);
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()).tokens[TOKEN], { missing: 'late', retryAfterS: DEX_ON_ITS_WAY_SECONDS });
  assert.equal(first.headers.get('Server-Timing'), `edge;desc="miss", miss;desc="late ${TOKEN}"`);
  second.time.at.now += 4_000;
  const joined = await answerDex2(getAsk2(`tokens/${TOKEN}`), second.rt);
  assert.equal(joined.status, 200);
  assert.deepEqual((await joined.json()).tokens[TOKEN], { missing: 'joined', retryAfterS: (DEX_READ_STALE_MS - 4_000) / 1000 }, 'missing: joined, and when a new read may start');
  assert.equal(joined.headers.get('Server-Timing'), `edge;desc="miss", miss;dur=4000;desc="joined ${TOKEN}"`);
  assert.equal(slow.calls.length, 1);
  second.time.at.now += DEX_READ_STALE_MS;
  const fresh = await answerDex2(getAsk2(`tokens/${TOKEN}`), second.rt);
  assert.equal((await fresh.json()).tokens[TOKEN].pairs.length, 1);
  assert.equal(slow.calls.length, 2);
  release();
  free();
  await Promise.all([...later, ...second.later]);
});

test('D1: a read an ask joins takes none of its own lanes: six tokens joined to dead reads leave the other four read and answered', async () => {
  const tokens = Array.from({ length: 10 }, (_, i) => nth(i));
  const hung = new Map();
  const dex = upstream((url) => {
    const token = tokenOf(url);
    if (tokens.indexOf(token) < 6 && !hung.has(token)) return new Promise((resolve) => hung.set(token, () => resolve(json([]))));
    return json([own(token)]);
  });
  const { rt, time, later } = edge(dex, { answerMs: 30 });
  await answerDex(getAsk(`tokens/${tokens.slice(0, 6).join(',')}`), rt);
  assert.equal(dex.calls.length, 6);
  time.at.now += 1_000;
  const old = await answerDex(getAsk(`tokens/${tokens.join(',')}`), rt);
  assert.equal(old.status, 502);
  assert.equal(dex.calls.length, 10, 'the four tokens behind the six dead reads were read all the same (they never were)');
  const partial = await answerDex2(getAsk2(`tokens/${tokens.join(',')}`), rt);
  const body = await partial.json();
  for (const token of tokens.slice(0, 6)) assert.equal(body.tokens[token].missing, 'joined', token);
  for (const token of tokens.slice(6)) assert.equal(body.tokens[token].pairs[0].baseToken.address, token);
  assert.equal(dex.calls.length, 10);
  for (const end of hung.values()) end();
  await Promise.all(later);
});

test('D1: every upstream read is handed to waitUntil when it is created, not when the ask gives up on it', async () => {
  const releases = [];
  const dex = upstream((url) => new Promise((resolve) => releases.push(() => resolve(json([own(tokenOf(url))])))));
  const { rt, later } = edge(dex);
  const asking = answerDex(getAsk(`tokens/${TOKEN},${OTHER}`), rt);
  while (dex.calls.length < 2) await tick();
  assert.equal(later.length, 2, 'one piece of work per upstream read, while the ask still waits (there was none: a visitor who left took the read with it)');
  for (const answer of releases) answer();
  assert.equal((await asking).status, 200);
  await Promise.all(later);
  assert.equal(later.length, 2, 'and nothing more: every token had been read');
  // A token still waiting for a lane when the ask answers is read behind, and that wait is handed on too.
  const many = Array.from({ length: 8 }, (_, i) => nth(i));
  const held = [];
  const slow = upstream((url) => new Promise((resolve) => held.push(() => resolve(json([own(tokenOf(url))])))));
  const second = edge(slow, { answerMs: 30 });
  const late = await answerDex2(getAsk2(`tokens/${many.join(',')}`), second.rt);
  assert.equal(slow.calls.length, 6, 'six reads side by side');
  assert.equal(second.later.length, 7, 'the six reads, and the two tokens’ turn');
  assert.deepEqual(Object.values((await late.json()).tokens).map((state) => state.missing), Array(8).fill('late'));
  for (const answer of held.splice(0)) answer();
  while (slow.calls.length < 8) await tick();
  for (const answer of held.splice(0)) answer();
  await Promise.all(second.later);
  const hit = await answerDex2(getAsk2(`tokens/${many.join(',')}`), second.rt);
  assert.equal(hit.headers.get('Server-Timing'), 'edge;desc="hit"');
  assert.equal(slow.calls.length, 8, 'each read once, kept for the next ask');
});

test('D1: on the new path nine tokens answered and one refused is a 200 that says which and why; the old path keeps its 502, now with the reason', async () => {
  const tokens = Array.from({ length: 10 }, (_, i) => nth(i));
  const bad = tokens[6];
  const dex = upstream((url) => (url.endsWith(bad) ? json({ error: 'forbidden' }, 403) : json([own(tokenOf(url))])));
  const { rt, time } = edge(dex);
  const response = await answerDex2(getAsk2(`tokens/${tokens.join(',')}`), rt);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
  const body = await response.json();
  assert.deepEqual([body.v, body.now], [2, time.at.now]);
  assert.deepEqual(Object.keys(body.tokens), tokens, 'every asked token has a state, in the order asked');
  for (const token of tokens.filter((one) => one !== bad)) {
    assert.deepEqual(Object.keys(body.tokens[token]), ['at', 'pairs'], token);
    assert.equal(body.tokens[token].at, time.at.now, 'each with the time it was retrieved');
    assert.deepEqual(body.tokens[token].pairs.map((one) => one.baseToken.address), [token]);
  }
  assert.deepEqual(body.tokens[bad], { missing: 'status_403', retryAfterS: DEX_MISS_SECONDS });
  assert.equal(response.headers.get('Server-Timing'), `edge;desc="miss", miss;desc="status_403 ${bad}"`);
  assert.equal(dex.calls.length, 10);
  // A tab opened before the deploy asks the old path: its all-or-nothing 502, from what is kept and remembered.
  const old = await answerDex(getAsk(`tokens/${tokens.join(',')}`), rt);
  assert.equal(old.status, 502);
  assert.deepEqual(await old.json(), { error: 'upstream_unavailable' });
  assert.equal(old.headers.get('Server-Timing'), `edge;desc="miss", miss;desc="status_403 ${bad}"`);
  assert.equal(dex.calls.length, 10, 'nothing read again');
  const nine = await answerDex(getAsk(`tokens/${tokens.filter((one) => one !== bad).join(',')}`), rt);
  assert.equal(nine.status, 200, 'and the nine alone are the old path’s plain list');
  assert.equal((await nine.json()).length, 9);
});

test('D1: whatever the provider does, a new-path ask is a 200 that names the reason, in the body and in Server-Timing', async () => {
  const cases = [
    ['status_403', () => json({}, 403)],
    ['status_5xx', () => json({}, 502)],
    ['status_other', () => json({}, 404)],
    ['status_other', () => new Response(null, { status: 302, headers: { Location: 'https://example.com/' } })],
    ['not_json', () => new Response('<html>', { headers: { 'Content-Type': 'text/html' } })],
    ['not_json', () => new Response('{"pairs":[]}', { headers: { 'Content-Type': 'application/json' } })],
    ['not_json', () => new Response('[', { headers: { 'Content-Type': 'application/json' } })],
    ['too_large', () => new Response('[]', { headers: { 'Content-Type': 'application/json', 'Content-Length': '262145' } })],
    ['too_large', () => new Response(`[${' '.repeat(262145)}]`, { headers: { 'Content-Type': 'application/json' } })],
    ['network', () => { throw new TypeError('fetch failed'); }],
  ];
  for (const [reason, answer] of cases) {
    const dex = upstream(answer);
    const { rt, cache } = edge(dex);
    const response = await answerDex2(getAsk2(`token-pairs/base/${TOKEN}`), rt);
    assert.equal(response.status, 200, reason);
    assert.deepEqual((await response.json()).tokens, { [TOKEN]: { missing: reason, retryAfterS: DEX_MISS_SECONDS } }, reason);
    assert.equal(response.headers.get('Server-Timing'), `edge;desc="miss", miss;desc="${reason} ${TOKEN}"`);
    assert.equal(cache.puts.length, 0, 'nothing that is not an answer is ever kept');
    const old = await answerDex(getAsk(`token-pairs/base/${TOKEN}`), rt);
    assert.equal(old.status, 502);
    assert.equal(old.headers.get('Server-Timing'), `edge;desc="miss", miss;desc="${reason} ${TOKEN}"`, 'the old path’s 502 names it too');
    assert.equal(dex.calls.length, 1, 'and asks nothing again');
  }
  // A read the provider never answers gives up on its own timer: `timeout`.
  const calls = [];
  const never = (url, init) => new Promise((resolve, reject) => { calls.push(url); init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
  const { rt } = edge({ fetch: never }, { upstreamMs: 20 });
  const timed = await answerDex2(getAsk2(`tokens/${TOKEN}`), rt);
  assert.deepEqual((await timed.json()).tokens[TOKEN], { missing: 'timeout', retryAfterS: DEX_MISS_SECONDS });
  assert.equal(calls.length, 1);
});

test('D1: an upstream 429 with Retry-After: 20 makes no upstream call from this isolate for 20 s, for any token, view, chain or path', async () => {
  let refusing = true;
  const dex = upstream((url) => (refusing ? new Response('{"error":"rate limited"}', { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '20' } }) : json([own(tokenOf(url))])));
  const { rt, time } = edge(dex);
  assert.equal((await answerDex(getAsk(`tokens/${TOKEN}`), rt)).status, 502);
  assert.equal(dex.calls.length, 1);
  refusing = false;
  time.at.now += 19_999;
  const paused = await answerDex(getAsk(`tokens/${TOKEN},${OTHER}`), rt);
  assert.equal(paused.status, 502);
  assert.equal((await answerDex(getAsk(`token-pairs/base/${OTHER}`), rt)).status, 502);
  assert.equal(dex.calls.length, 1, 'zero upstream calls while the provider asked to wait (each ask used to call it again)');
  assert.equal(paused.headers.get('Server-Timing'), `edge;desc="miss", miss;desc="status_429 ${TOKEN}", miss;desc="status_429 ${OTHER}"`);
  const said = await answerDex2(getAsk2(`tokens/${TOKEN},${OTHER}`), rt);
  assert.equal(said.status, 200);
  assert.deepEqual((await said.json()).tokens, { [TOKEN]: { missing: 'status_429', retryAfterS: 1 }, [OTHER]: { missing: 'status_429', retryAfterS: 1 } });
  assert.equal(dex.calls.length, 1);
  time.at.now += 1;
  const again = await answerDex2(getAsk2(`tokens/${TOKEN},${OTHER}`), rt);
  assert.deepEqual(Object.values((await again.json()).tokens).map((state) => state.pairs.length), [1, 1], 'after its 20 s the provider is asked again');
  assert.equal(dex.calls.length, 3);
  // Without a Retry-After the wait is the first miss's; a longer one than five minutes is five minutes.
  for (const [header, seconds] of [[null, DEX_MISS_SECONDS], ['7200', DEX_MISS_MAX_SECONDS], ['soon', DEX_MISS_SECONDS]]) {
    const bare = upstream(() => new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json', ...(header === null ? {} : { 'Retry-After': header }) } }));
    const other = edge(bare);
    assert.equal((await (await answerDex2(getAsk2(`tokens/${TOKEN}`), other.rt)).json()).tokens[TOKEN].retryAfterS, seconds, String(header));
  }
  // What is kept is still served while the provider says to wait, and no read is tried behind it.
  let limited = false;
  const kept = upstream(() => (limited ? new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '60' } }) : json([own(TOKEN)])));
  const third = edge(kept);
  await answerDex(getAsk(`token-pairs/${TOKEN}`), third.rt);
  limited = true;
  await answerDex(getAsk(`token-pairs/${OTHER}`), third.rt);
  third.time.at.now += DEX_FRESH_SECONDS * 1000;
  const stale = await answerDex(getAsk(`token-pairs/${TOKEN}`), third.rt);
  assert.equal(stale.status, 200);
  assert.equal(stale.headers.get('Server-Timing'), `edge;desc="stale", miss;desc="status_429 ${TOKEN}"`);
  await Promise.all(third.later);
  assert.equal(kept.calls.length, 2, 'the kept answer left, with the reason it is not read again yet');
});

test('D1: a token whose read gave nothing is not asked again for 30 s, then 60, up to five minutes; an answer ends it', async () => {
  let status = 503;
  const dex = upstream((url) => (status === 200 ? json([own(tokenOf(url))]) : json({}, status)));
  const { rt, time } = edge(dex);
  const ask = () => answerDex(getAsk(`token-pairs/${TOKEN}`), rt);
  assert.equal((await ask()).status, 502);
  assert.equal(dex.calls.length, 1);
  let calls = 1;
  for (const seconds of [DEX_MISS_SECONDS, 60, 120, 240, DEX_MISS_MAX_SECONDS, DEX_MISS_MAX_SECONDS]) {
    time.at.now += seconds * 1000 - 1;
    assert.equal((await ask()).status, 502);
    assert.equal(dex.calls.length, calls, `not asked again within ${seconds} s (every ask used to reach the provider)`);
    const said = await answerDex2(getAsk2(`tokens/${TOKEN}`), rt);
    assert.deepEqual((await said.json()).tokens[TOKEN], { missing: 'status_5xx', retryAfterS: 1 });
    time.at.now += 1;
    assert.equal((await ask()).status, 502);
    assert.equal(dex.calls.length, ++calls, `asked once after ${seconds} s`);
  }
  // Another token is not held back by it.
  status = 200;
  assert.equal((await answerDex(getAsk(`token-pairs/${OTHER}`), rt)).status, 200);
  calls += 1;
  // An answer ends the token's own wait: its next miss starts from 30 s again.
  time.at.now += DEX_MISS_MAX_SECONDS * 1000;
  assert.equal((await ask()).status, 200);
  calls += 1;
  status = 503;
  time.at.now += DEX_STALE_SECONDS * 1000;
  assert.equal((await ask()).status, 502, 'the old path serves nothing past five minutes');
  time.at.now += DEX_MISS_SECONDS * 1000;
  await ask();
  assert.equal(dex.calls.length, calls + 2);
});

test('D1: tokens and token-pairs read one kept entry per chain and token: one upstream read for both views, on both paths', async () => {
  const many = Array.from({ length: 8 }, (_, i) => pair(`0x${String(i).padStart(64, 'a')}`, i === 7 ? TOKEN : OTHER, i === 7 ? OTHER : TOKEN, 100 * (8 - i)));
  const dex = upstream(() => json(many));
  const { rt, cache } = edge(dex);
  const prices = await answerDex(getAsk(`tokens/${TOKEN}`), rt);
  assert.equal((await prices.json()).length, 5, 'the price view: the four most liquid, and the one it is the base of');
  const list = await answerDex(getAsk(`token-pairs/${TOKEN}`), rt);
  assert.equal((await list.json()).length, 8, 'the whole list');
  assert.equal(dex.calls.length, 1, 'one upstream read for the two views (it was one each)');
  assert.deepEqual(cache.puts, [`${ORIGIN}/api/read/dex/cache/v2/robinhood/${TOKEN}`]);
  assert.equal(list.headers.get('Server-Timing'), 'edge;desc="hit"');
  const both = await Promise.all([answerDex2(getAsk2(`tokens/${TOKEN}`), rt), answerDex2(getAsk2(`token-pairs/${TOKEN}`), rt)]);
  assert.deepEqual((await Promise.all(both.map((response) => response.json()))).map((body) => body.tokens[TOKEN].pairs.length), [5, 8]);
  assert.equal(dex.calls.length, 1);
  // Another chain's token of the same address is another entry.
  await answerDex2(getAsk2(`token-pairs/base/${TOKEN}`), rt);
  assert.equal(dex.calls.length, 2);
  assert.equal(cache.puts[1], `${ORIGIN}/api/read/dex/cache/v2/base/${TOKEN}`);
});

test('D1: an entry is kept a day with its own retrieval time: read again past five minutes, served with that time when the read gives nothing, never by the old path', async () => {
  let up = true;
  const dex = upstream(() => (up ? json([own(TOKEN)]) : json({}, 503)));
  const { rt, time, later } = edge(dex);
  const t0 = time.at.now;
  assert.equal((await (await answerDex2(getAsk2(`tokens/${TOKEN}`), rt)).json()).tokens[TOKEN].at, t0);
  // Under five minutes it leaves at once with its own time, and is read again behind.
  time.at.now += DEX_STALE_SECONDS * 1000 - 1;
  const behind = await answerDex2(getAsk2(`tokens/${TOKEN}`), rt);
  assert.equal(behind.headers.get('Server-Timing'), 'edge;desc="stale"');
  const stale = await behind.json();
  assert.deepEqual([stale.now, stale.tokens[TOKEN].at], [time.at.now, t0], 'dated by its retrieval, never by this answer');
  await Promise.all(later.splice(0));
  assert.equal(dex.calls.length, 2);
  const t1 = time.at.now;
  // Past five minutes the provider is asked in the ask's own time, as before.
  time.at.now += DEX_STALE_SECONDS * 1000;
  const renewed = await answerDex2(getAsk2(`tokens/${TOKEN}`), rt);
  assert.equal(renewed.headers.get('Server-Timing'), 'edge;desc="miss"');
  assert.equal((await renewed.json()).tokens[TOKEN].at, time.at.now);
  assert.equal(dex.calls.length, 3);
  const t2 = time.at.now;
  assert.ok(t2 > t1);
  // The provider away, six hours on: the new path still answers, with the entry's own time; the old path never does.
  up = false;
  time.at.now += 6 * 3_600_000;
  const held = await answerDex2(getAsk2(`tokens/${TOKEN}`), rt);
  assert.equal(held.status, 200);
  const body = await held.json();
  assert.deepEqual([body.now, body.tokens[TOKEN].at, body.tokens[TOKEN].pairs.length], [time.at.now, t2, 1], 'six hours old, and it says so');
  assert.equal(held.headers.get('Server-Timing'), `edge;desc="stale", miss;desc="status_5xx ${TOKEN}"`);
  assert.equal(dex.calls.length, 4);
  const old = await answerDex(getAsk(`tokens/${TOKEN}`), rt);
  assert.equal(old.status, 502, 'a tab opened before the deploy reads a long age as none, so it gets no old figure');
  assert.equal(dex.calls.length, 4);
  // Past a day nothing is served.
  time.at.now = t2 + DEX_KEPT_SECONDS * 1000;
  assert.deepEqual((await (await answerDex2(getAsk2(`tokens/${TOKEN}`), rt)).json()).tokens[TOKEN].missing, 'status_5xx');
});

test('D1: an empty list is an answer, "none", and it is kept longer: ten minutes before the provider is asked again, on both paths', async () => {
  const dex = upstream(() => json([]));
  const { rt, time } = edge(dex);
  const first = await answerDex2(getAsk2(`tokens/${TOKEN}`), rt);
  assert.deepEqual((await first.json()).tokens[TOKEN], { at: time.at.now, none: true });
  const t0 = time.at.now;
  time.at.now += DEX_NONE_FRESH_SECONDS * 1000 - 1;
  const again = await answerDex2(getAsk2(`token-pairs/${TOKEN}`), rt);
  assert.deepEqual((await again.json()).tokens[TOKEN], { at: t0, none: true });
  assert.equal(again.headers.get('Server-Timing'), 'edge;desc="hit"');
  const old = await answerDex(getAsk(`token-pairs/${TOKEN}`), rt);
  assert.deepEqual([old.status, await old.json(), old.headers.get('X-Domino-Edge-Age')], [200, [], String(DEX_NONE_FRESH_SECONDS * 1000 - 1)]);
  assert.equal(dex.calls.length, 1, 'no read in ten minutes (it was one every 30 s while asked)');
  time.at.now += 1;
  await answerDex2(getAsk2(`tokens/${TOKEN}`), rt);
  assert.equal(dex.calls.length, 2);
});

test('D1: a visitor past its asks gets 429 alone, with the wait and what refused it; both paths draw on one allowance', async () => {
  const dex = upstream((url) => json([own(tokenOf(url))]));
  const { rt, time } = edge(dex);
  const from = (address) => ({ 'CF-Connecting-IP': address });
  for (let i = 0; i < DEX_VISITOR.burst; i += 1) {
    const response = await (i % 2 ? answerDex2(getAsk2(`tokens/${TOKEN}`, from('203.0.113.9')), rt) : answerDex(getAsk(`token-pairs/${TOKEN}`, from('203.0.113.9')), rt));
    assert.equal(response.status, 200, `ask ${i + 1}`);
  }
  const refused = await answerDex(getAsk(`token-pairs/${TOKEN}`, from('203.0.113.9')), rt);
  assert.equal(refused.status, 429, 'past its burst (the route had no limit per visitor)');
  assert.deepEqual(await refused.json(), { error: 'rate_limited' });
  assert.equal(refused.headers.get('Retry-After'), '1');
  assert.equal(refused.headers.get('Server-Timing'), 'limit;desc="asks"');
  assert.equal((await answerDex2(getAsk2(`tokens/${TOKEN}`, from('203.0.113.9')), rt)).status, 429);
  assert.equal((await answerDex(getAsk(`token-pairs/${TOKEN}`, from('198.51.100.7')), rt)).status, 200, 'another visitor is answered');
  assert.equal((await answerDex2(getAsk2(`tokens/${TOKEN}`), rt)).status, 200, 'and a request with no address (a local server, a test) is not limited');
  time.at.now += Math.ceil(60_000 / DEX_VISITOR.perMinute);
  assert.equal((await answerDex(getAsk(`token-pairs/${TOKEN}`, from('203.0.113.9')), rt)).status, 200, 'one more as the allowance refills');
  assert.equal((await answerDex(getAsk(`token-pairs/${TOKEN}`, from('203.0.113.9')), rt)).status, 429);
  assert.equal(dex.calls.length, 1, 'none of it reached the provider twice');
});

test('D1: addresses this edge has never seen are capped per visitor: past the allowance they are "capped" and read by no one, while seen ones still answer', async () => {
  const dex = upstream(() => json([]));
  const { rt, time } = edge(dex);
  const mine = { 'CF-Connecting-IP': '2001:db8:1:2::9' };
  const batch = (from) => Array.from({ length: MAX_TOKENS }, (_, i) => nth(from + i)).join(',');
  for (let i = 0; i < DEX_VISITOR_NEW.burst; i += MAX_TOKENS) assert.equal((await answerDex2(getAsk2(`tokens/${batch(i)}`, mine), rt)).status, 200);
  assert.equal(dex.calls.length, DEX_VISITOR_NEW.burst, 'one upstream read per unseen address, up to the allowance');
  const over = await answerDex2(getAsk2(`tokens/${nth(9_000)},${nth(0)}`, mine), rt);
  assert.equal(over.status, 200);
  assert.deepEqual((await over.json()).tokens, { [nth(9_000)]: { missing: 'capped', retryAfterS: 1 }, [nth(0)]: { at: time.at.now, none: true } });
  assert.equal(over.headers.get('Server-Timing'), `edge;desc="miss", miss;desc="capped ${nth(9_000)}"`);
  // The old path has no state per token: its answer is the visitor's own wait, which the page keeps to, never a 502 (a 502
  // sends every read of the chain to the provider directly for five minutes, lib/tokenArtwork.ts).
  const old = await answerDex(getAsk(`token-pairs/${nth(9_001)}`, mine), rt);
  assert.deepEqual([old.status, await old.json(), old.headers.get('Retry-After')], [429, { error: 'rate_limited' }, '1']);
  assert.equal(old.headers.get('Server-Timing'), `edge;desc="miss", miss;desc="capped ${nth(9_001)}", limit;desc="unseen"`);
  assert.equal(dex.calls.length, DEX_VISITOR_NEW.burst, 'the unseen ones were not read (any number used to be)');
  // The same network's other address shares the allowance. An ask with nothing but capped tokens is that wait itself, on
  // the new path too: the page keeps to a 429, and does not take "no token priced" for our edge being away.
  const alone = await answerDex2(getAsk2(`tokens/${nth(9_002)},${nth(9_003)}`, { 'CF-Connecting-IP': '2001:db8:1:ffff::1' }), rt);
  assert.deepEqual([alone.status, await alone.json(), alone.headers.get('Retry-After')], [429, { error: 'rate_limited' }, '1']);
  assert.equal(alone.headers.get('Server-Timing'), `edge;desc="miss", miss;desc="capped ${nth(9_002)}", miss;desc="capped ${nth(9_003)}", limit;desc="unseen"`);
  // Another network has its own.
  assert.deepEqual((await (await answerDex2(getAsk2(`tokens/${nth(9_000)}`, { 'CF-Connecting-IP': '198.51.100.7' }), rt)).json()).tokens[nth(9_000)], { at: time.at.now, none: true });
  assert.equal(dex.calls.length, DEX_VISITOR_NEW.burst + 1);
  time.at.now += Math.ceil(60_000 / DEX_VISITOR_NEW.perMinute);
  assert.equal((await (await answerDex2(getAsk2(`tokens/${nth(9_001)}`, mine), rt)).json()).tokens[nth(9_001)].none, true, 'one more as it refills');
  assert.equal(dex.calls.length, DEX_VISITOR_NEW.burst + 2);
});

test('D1: where the cache keeps nothing, a token this isolate has read before is still not a new address for its visitor', async () => {
  const dex = upstream((url) => json([own(tokenOf(url))]));
  const { rt } = edge(dex);
  // No cache at all, as a deployment whose host keeps none: every ask reads the provider again, as it always did there.
  const bare = { ...rt, cache: null };
  const mine = { 'CF-Connecting-IP': '203.0.113.9' };
  const batch = Array.from({ length: MAX_TOKENS }, (_, i) => nth(i)).join(',');
  const loads = DEX_VISITOR_NEW.burst / MAX_TOKENS + 3;
  for (let i = 0; i < loads; i += 1) {
    const response = await answerDex2(getAsk2(`tokens/${batch}`, mine), bare);
    assert.equal(response.status, 200, `load ${i + 1}`);
    assert.ok(Object.values((await response.json()).tokens).every((state) => state.pairs?.length === 1), `load ${i + 1}: the same ten tokens, never "capped"`);
  }
  assert.equal(dex.calls.length, loads * MAX_TOKENS);
  // Ten addresses were new, once; the rest of the allowance is still there for others.
  const fresh = await answerDex2(getAsk2(`tokens/${Array.from({ length: MAX_TOKENS }, (_, i) => nth(100 + i)).join(',')}`, mine), bare);
  assert.ok(Object.values((await fresh.json()).tokens).every((state) => state.pairs?.length === 1));
});

test('D1: the page and the edge agree: the Wallet card’s prices over the new path, a refused token left with no price yet, no direct call, each price at its own time', async () => {
  const { createTokenArtworkResolver, DEX_EDGE } = require('../.test-build/app/src/lib/tokenArtwork.js');
  const { createWalletPrices } = require('../.test-build/app/src/lib/walletPrices.js');
  const tokens = Array.from({ length: 12 }, (_, i) => nth(i));
  const bad = tokens[4];
  let up = true;
  const dex = upstream((url) => (up && !url.endsWith(bad) ? json([own(tokenOf(url), 100_000)]) : json({}, 503)));
  const { rt, time } = edge(dex);
  const t0 = time.at.now;
  // The page's clock runs seven seconds ahead of the edge's: a price's time is the page's now less the age the edge gives.
  const page = () => time.at.now + 7_000;
  const asked = [];
  const resolver = createTokenArtworkResolver({ edge: DEX_EDGE, now: time.now, wall: page, fetch: async (url) => {
    asked.push(url);
    // Our own edge only: anything else would be the provider, asked from the visitor's address.
    assert.ok(url.startsWith('/api/read/dex2/tokens/'), url);
    return answerDex2(getAsk2(url.slice('/api/read/dex2/'.length)), rt);
  } });
  const prices = createWalletPrices({ get: (list, signal) => resolver.tokenPrices(list, signal), seed: () => {}, now: page });
  const first = await prices.price(tokens);
  assert.equal(asked.length, 2, 'twelve tokens, two GETs');
  assert.equal(first.failed, false);
  assert.deepEqual([...first.quotes.keys()], tokens.filter((token) => token !== bad), 'eleven priced; the refused one has no price yet');
  for (const token of tokens.filter((one) => one !== bad)) assert.deepEqual([first.quotes.get(token), first.at.get(token)], [{ usd: '0.002', liquidityUsd: 100_000 }, t0 + 7_000], token);
  assert.equal(dex.calls.length, 12);
  // Half an hour on, the provider away: the edge answers from what it kept, and the page dates each price where it was retrieved.
  up = false;
  time.at.now += 1_800_000;
  const later = await prices.price(tokens);
  assert.equal(asked.length, 4, 'asked of our edge again, and of no one else');
  assert.equal(later.failed, false);
  assert.equal(later.quotes.size, 11);
  for (const token of tokens.filter((one) => one !== bad)) assert.deepEqual([later.quotes.get(token).usd, later.at.get(token)], ['0.002', t0 + 7_000], 'half an hour old, and dated so');
});

// ---------------------------------------------------------------------------
// 2026-11-07: Base's and Arbitrum One's pools by their own names. The provider lists 30 pairs a token, not ranked by
// liquidity: on 7 Nov Base USDC's 30 were its USDC/USDbC pools and a few others, Arbitrum One WETH's its bridged-USDC
// ones, so the WETH/USDC pools their pages list had no figures. Those pools are asked on the new path by name.
// ---------------------------------------------------------------------------

const BASE_WETH = '0x4200000000000000000000000000000000000006';
const BASE_USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const NO_ADDRESS = '0x0000000000000000000000000000000000000000';
/** Base's WETH/USDC 0.30% v3 pool, as the provider writes its address, and its ETH/USDC v4 pool by id (live, 7 Nov). */
const V3_POOL_LIVE = '0x6c561B446416E1A00E8E93E221854d6eA4171372';
const V3_NAME = V3_POOL_LIVE.toLowerCase();
const V4_NAME = '0xe070797535b13431808f8fc81fdbe7b41362960ed0b55bc2b6117c49c51b7eb9';
const UNKNOWN_NAME = `0x${'ab'.repeat(32)}`;
/** The provider's pairs endpoint as it answered on 7 Nov: `{schemaVersion, pairs, pair}`, `pairs: null` for a pool it does not know. */
const pairsEndpoint = (url) => {
  const name = tokenOf(url).toLowerCase();
  const pairs = name === V3_NAME ? [pair(V3_POOL_LIVE, BASE_WETH, BASE_USDC, 146056184.05, { chainId: 'base', labels: ['v3'] })]
    : name === V4_NAME ? [pair(V4_NAME, NO_ADDRESS, BASE_USDC, 4381526.99, { chainId: 'base' }), pair(`0x${'cd'.repeat(32)}`, NO_ADDRESS, BASE_USDC, 1, { chainId: 'base' })]
      : null;
  return json({ schemaVersion: '1.0.0', pairs, pair: null });
};

test('2026-11-07: pairs/<base|arbitrum>/<pools> is the new path’s alone: v3 addresses and v4 ids, at most ten, never Robinhood Chain', () => {
  assert.deepEqual(dex2Ask(getAsk2(`pairs/base/${V3_POOL_LIVE},${V4_NAME},${V3_NAME}`)), { kind: 'pairs', chain: 'base', tokens: [V3_NAME, V4_NAME], origin: ORIGIN });
  assert.equal(dex2Ask(getAsk2(`pairs/arbitrum/${V3_NAME}`))?.chain, 'arbitrum');
  // Added 2026-11-09 (Elysium's day 9, checklist step 6): Elysium's v4 pools by their ids, as Base's.
  assert.deepEqual(dex2Ask(getAsk2(`pairs/elysium/${V4_NAME}`)), { kind: 'pairs', chain: 'elysium', tokens: [V4_NAME], origin: ORIGIN });
  assert.equal(dex2Ask(getAsk2(`pairs/base/${Array.from({ length: MAX_TOKENS }, (_, i) => nth(i)).join(',')}`))?.tokens.length, MAX_TOKENS);
  for (const bad of [
    `pairs/${V3_NAME}`, `pairs/robinhood/${V3_NAME}`, `pairs/ethereum/${V3_NAME}`, `pairs/base/0x123`, `pairs/base/0x${'1'.repeat(50)}`, 'pairs/base/', `pairs/base/${V3_NAME}/x`,
    `pairs/base/${Array.from({ length: MAX_TOKENS + 1 }, (_, i) => nth(i)).join(',')}`, `tokens/base/${V3_NAME}`, `token-pairs/base/${V4_NAME}`, `tokens/${V4_NAME}`,
  ]) assert.equal(dex2Ask(getAsk2(bad)), null, bad);
  assert.equal(dexAsk(getAsk(`pairs/base/${V3_NAME}`)), null, 'the old path never had it');
  assert.equal(dexAsk(getAsk(`pairs/${V3_NAME}`)), null);
});

test('2026-11-07: each pool read from the provider’s pairs endpoint by its own name, one a request, kept under a key of its own; none for a pool it does not know; never a pair of another name', async () => {
  const dex = upstream(pairsEndpoint);
  const { rt, cache, time } = edge(dex);
  const response = await answerDex2(getAsk2(`pairs/base/${V3_NAME},${V4_NAME},${UNKNOWN_NAME}`), rt);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(dex.calls.map((call) => call.url), [V3_NAME, V4_NAME, UNKNOWN_NAME].map((name) => `https://api.dexscreener.com/latest/dex/pairs/base/${name}`), 'one pool per upstream request, on the provider’s pairs endpoint');
  const body = await response.json();
  assert.deepEqual([body.v, body.now, Object.keys(body.tokens)], [2, time.at.now, [V3_NAME, V4_NAME, UNKNOWN_NAME]]);
  assert.deepEqual(body.tokens[V3_NAME].pairs.map((p) => [p.chainId, p.dexId, p.labels, p.pairAddress, p.baseToken.address, p.quoteToken.address, p.liquidity.usd, p.volume.h24]),
    [['base', 'uniswap', ['v3'], V3_POOL_LIVE, BASE_WETH, BASE_USDC, 146056184.05, 7500]], 'the fields the page reads, as the provider wrote them');
  assert.equal(body.tokens[V3_NAME].at, time.at.now);
  assert.deepEqual(body.tokens[V4_NAME].pairs.map((p) => p.pairAddress), [V4_NAME], 'a pair of another name in the body is never passed on');
  assert.deepEqual(body.tokens[UNKNOWN_NAME], { at: time.at.now, none: true }, 'a pool the provider does not know: none');
  assert.deepEqual(cache.puts, [V3_NAME, V4_NAME, UNKNOWN_NAME].map((name) => `${ORIGIN}/api/read/dex/cache/v2/base/pair/${name}`), 'each under a key of its own');
  // Kept as a token's answer is: nothing upstream within 30 s, a none for ten minutes.
  const again = await answerDex2(getAsk2(`pairs/base/${V3_NAME},${UNKNOWN_NAME}`), rt);
  assert.equal(again.headers.get('Server-Timing'), 'edge;desc="hit"');
  time.at.now += DEX_FRESH_SECONDS * 1000;
  await answerDex2(getAsk2(`pairs/base/${UNKNOWN_NAME}`), rt);
  assert.equal(dex.calls.length, 3, 'none read again for ten minutes');
  // The same 20 bytes as a token on Base is another entry, read from token-pairs, never this pool's answer.
  const asToken = await answerDex2(getAsk2(`token-pairs/base/${V3_NAME}`), rt);
  assert.equal(dex.calls[3].url, `https://api.dexscreener.com/token-pairs/v1/base/${V3_NAME}`);
  assert.deepEqual((await asToken.json()).tokens[V3_NAME], { missing: 'not_json', retryAfterS: DEX_MISS_SECONDS }, 'the pairs endpoint’s shape is not a token-pairs body');
  assert.equal(cache.puts.length, 3);
  // Arbitrum One's pool of the same name is Arbitrum One's own read.
  await answerDex2(getAsk2(`pairs/arbitrum/${V3_NAME}`), rt);
  assert.equal(dex.calls[4].url, `https://api.dexscreener.com/latest/dex/pairs/arbitrum/${V3_NAME}`);
  assert.equal(cache.puts[3], `${ORIGIN}/api/read/dex/cache/v2/arbitrum/pair/${V3_NAME}`);
});

test('2026-11-07: a pool by name is refused, remembered and limited exactly as a token: the reason in its state, no other shape kept', async () => {
  const cases = [
    ['not_json', () => json([pair(V3_POOL_LIVE, BASE_WETH, BASE_USDC, 1, { chainId: 'base' })])],
    ['not_json', () => json({ pairs: {} })],
    ['not_json', () => json({})],
    ['status_5xx', () => json({}, 502)],
    ['status_403', () => json({}, 403)],
  ];
  for (const [reason, answer] of cases) {
    const dex = upstream(answer);
    const { rt, cache } = edge(dex);
    const said = await answerDex2(getAsk2(`pairs/base/${V3_NAME}`), rt);
    assert.deepEqual([said.status, (await said.json()).tokens[V3_NAME]], [200, { missing: reason, retryAfterS: DEX_MISS_SECONDS }], reason);
    assert.equal(said.headers.get('Server-Timing'), `edge;desc="miss", miss;desc="${reason} ${V3_NAME}"`);
    assert.equal(cache.puts.length, 0, reason);
    await answerDex2(getAsk2(`pairs/base/${V3_NAME}`), rt);
    assert.equal(dex.calls.length, 1, `${reason}: not read again for 30 s`);
  }
  // Another chain's pair in the body: none.
  const elsewhere = upstream(() => json({ pairs: [pair(V3_POOL_LIVE, BASE_WETH, BASE_USDC, 1)] }));
  assert.deepEqual((await (await answerDex2(getAsk2(`pairs/base/${V3_NAME}`), edge(elsewhere).rt)).json()).tokens[V3_NAME].none, true);
  // The provider's 429 stops this isolate's reads of pools and tokens alike.
  let refusing = true;
  const dex = upstream((url) => (refusing ? new Response('{}', { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '20' } }) : pairsEndpoint(url)));
  const { rt } = edge(dex);
  assert.equal((await (await answerDex2(getAsk2(`pairs/base/${V3_NAME}`), rt)).json()).tokens[V3_NAME].missing, 'status_429');
  refusing = false;
  assert.equal((await (await answerDex2(getAsk2(`token-pairs/base/${TOKEN}`), rt)).json()).tokens[TOKEN].missing, 'status_429');
  assert.equal(dex.calls.length, 1);
  // A visitor's unseen addresses count a pool's name too: each is one upstream read.
  const mine = { 'CF-Connecting-IP': '2001:db8:7:7::1' };
  const many = upstream(() => json({ pairs: null }));
  const capped = edge(many);
  for (let i = 0; i < DEX_VISITOR_NEW.burst; i += MAX_TOKENS) await answerDex2(getAsk2(`pairs/base/${Array.from({ length: MAX_TOKENS }, (_, j) => nth(i + j)).join(',')}`, mine), capped.rt);
  const over = await answerDex2(getAsk2(`pairs/base/${nth(9_000)},${nth(0)}`, mine), capped.rt);
  assert.deepEqual((await over.json()).tokens, { [nth(9_000)]: { missing: 'capped', retryAfterS: 1 }, [nth(0)]: { at: capped.time.at.now, none: true } });
  assert.equal(many.calls.length, DEX_VISITOR_NEW.burst);
});

test('2026-11-07: the page and the edge agree: the pools a token’s pairs leave out, asked of our edge by name, give the store DEX Screener’s own figures, by that name, no token made of them', async () => {
  const { createTokenArtworkResolver, DEX_EDGE } = require('../.test-build/app/src/lib/tokenArtwork.js');
  const { createDexStore } = require('../.test-build/app/src/lib/read/dexFigures.js');
  const dex = upstream(pairsEndpoint);
  const { rt, time } = edge(dex);
  const page = () => time.at.now + 7_000;
  const asked = [];
  const resolver = createTokenArtworkResolver({ edge: DEX_EDGE, now: time.now, wall: page, fetch: async (url) => {
    asked.push(url);
    // Our own edge only: the provider is never asked from the visitor's address for these.
    assert.ok(url.startsWith('/api/read/dex2/pairs/'), url);
    return answerDex2(getAsk2(url.slice('/api/read/dex2/'.length)), rt);
  } });
  const store = createDexStore(async () => null, page, resolver.edgePairs);
  await store.askPairs(8453, [V3_POOL_LIVE, V4_NAME, UNKNOWN_NAME]);
  assert.deepEqual(asked, [`/api/read/dex2/pairs/base/${V3_NAME},${V4_NAME},${UNKNOWN_NAME}`]);
  const at = Math.floor(page() / 1000);
  assert.deepEqual(store.chainPoolSeen(8453, V3_NAME), { poolId: V3_NAME, base: BASE_WETH, quote: BASE_USDC, liquidityUsd: '146056184.05', volume24hUsd: '7500.00', retrievedAt: at });
  assert.deepEqual([store.chainPoolSeen(8453, V4_NAME).base, store.chainPoolSeen(8453, V4_NAME).liquidityUsd], [NO_ADDRESS, '4381526.99'], 'the v4 pool by its id, native ETH by the zero address');
  assert.equal(store.chainPoolSeen(8453, `0x${'cd'.repeat(32)}`), null, 'nothing under another name');
  assert.equal(store.chainPoolSeen(8453, UNKNOWN_NAME), null);
  assert.equal(store.chainToken(8453, V3_NAME), null, 'a pool’s name never makes a token');
  assert.equal(store.chainPoolSeen(42161, V3_NAME), null, 'Base’s pool is not Arbitrum One’s');
  // Twelve names: two GETs of ten and two; Robinhood Chain never asks.
  await store.askPairs(42161, Array.from({ length: 12 }, (_, i) => nth(i)));
  assert.deepEqual(asked.slice(1).map((url) => url.split('/').at(-1).split(',').length), [10, 2]);
  await store.askPairs(4663, [`0x${'12'.repeat(32)}`]);
  assert.equal(asked.length, 3);
});
