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
import { test } from 'node:test';
import * as v5 from '../../api-contracts/read-v5/runtime.mjs';
import * as v3 from '../../api-contracts/read-v3/runtime.mjs';

const require = createRequire(import.meta.url);
const { answerFeatured, cacheKey, FEATURED_PATH, LIST_SECONDS, WAIT_AFTER_SECONDS, REFRESH_WAIT_MS, featuredEvidence } = require('../.test-build/app/functions/_lib/featuredEdge.js');
const { FOLLOW_WAIT_MS } = require('../.test-build/app/functions/_lib/publicEdge.js');
const { answerOverview, overviewKey, OVERVIEW_PATH, OVERVIEW_SECONDS, OVERVIEW_STALE_SECONDS, settledOverview } = require('../.test-build/app/functions/_lib/overviewEdge.js');
const { answerDex, dexAsk, trimPair, trimPairOn, pairsForPrice, DEX_FRESH_SECONDS, DEX_STALE_SECONDS } = require('../.test-build/app/functions/_lib/dexEdge.js');
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

test('a settled overview is kept for the identical question: fresh 10 s, served to 30 s while it refreshes, dated, its read given back', async () => {
  assert.equal(v3.validateResponse('overview', OVERVIEW_BODY), true);
  assert.equal(settledOverview(JSON.stringify(OVERVIEW_BODY)), true);
  const cache = memoryCache(), time = clock(), later = [];
  const worker = bridge(() => overviewSaid());
  const rt = () => ({ contract: OVERVIEW, cache, now: time.now, refreshing: new Map(), waitUntil: (work) => later.push(work) });
  const first = await answerOverview(askOverview(), worker.env, rt());
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('X-Domino-Request-Id') !== null, true, 'the Worker’s answer');
  await Promise.all(later.splice(0));
  assert.deepEqual(cache.puts, [overviewKey(v3.CONTRACT_VERSION, { poolIds: [POOL] })]);
  time.at.now += OVERVIEW_SECONDS * 1000 - 1;
  const hit = await answerOverview(askOverview(), worker.env, rt());
  assert.equal(hit.headers.get('X-Domino-Edge-Cache'), 'hit');
  assert.equal(hit.headers.get('X-Domino-Edge-Age'), String(OVERVIEW_SECONDS * 1000 - 1));
  assert.deepEqual(await hit.json(), OVERVIEW_BODY);
  assert.equal(worker.calls.length, 1);
  // Another question is never answered from it.
  await answerOverview(askOverview({ poolIds: [POOL], limit: 12 }), worker.env, rt());
  assert.equal(worker.calls.length, 2);
  time.at.now += 1;
  const stale = await answerOverview(askOverview(), worker.env, rt());
  assert.equal(stale.headers.get('X-Domino-Edge-Cache'), null, 'the request that refreshes it is counted');
  await Promise.all(later.splice(0));
  assert.equal(worker.calls.length, 3);
  time.at.now += OVERVIEW_STALE_SECONDS * 1000;
  await answerOverview(askOverview(), worker.env, rt());
  assert.equal(worker.calls.length, 4, 'never served past 30 s');
});

test('an overview still collecting, refreshing, failed, or without provider figures is passed on and never kept', async () => {
  const pool = OVERVIEW_BODY.pools[0];
  const variants = [
    { ...OVERVIEW_BODY, pools: [{ ...pool, acquisition: { ...pool.acquisition, status: 'pending' } }] },
    { ...OVERVIEW_BODY, pools: [{ ...pool, acquisition: { ...pool.acquisition, refreshing: true } }] },
    { ...OVERVIEW_BODY, pools: [{ ...pool, value: { ...pool.value, market: { ...pool.value.market, market: { status: 'unavailable', reason: 'provider_rate_limited', data: null, cache: pool.value.market.market.cache } } } }] },
    { ...OVERVIEW_BODY, tokens: OVERVIEW_BODY.tokens.map((token, i) => (i === 0 ? { ...token, value: null, observedAt: null, acquisition: { ...token.acquisition, status: 'pending' } } : token)) },
  ];
  for (const [index, body] of variants.entries()) {
    assert.equal(settledOverview(JSON.stringify(body)), false, `variant ${index}`);
    const cache = memoryCache();
    const response = await answerOverview(askOverview(), bridge(() => overviewSaid(body)).env, { contract: OVERVIEW, cache, now: clock().now });
    assert.equal(response.status, 200);
    assert.equal(cache.puts.length, 0, `variant ${index} passed on, never kept`);
  }
  // An answer to another question, a refusal: passed on, never kept.
  const cache = memoryCache();
  await answerOverview(askOverview({ poolIds: [`0x${'cd'.repeat(32)}`] }), bridge(() => overviewSaid()).env, { contract: OVERVIEW, cache, now: clock().now });
  await answerOverview(askOverview(), bridge(() => overviewSaid({ error: 'read_capacity_busy' }, { status: 429 })).env, { contract: OVERVIEW, cache, now: clock().now });
  assert.equal(cache.puts.length, 0);
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
  const gap = await answerDex(getAsk(`tokens/${TOKEN},${OTHER}`), { cache: memoryCache(), now: clock().now, fetch: refused.fetch, inflight: new Map(), refreshing: new Map() });
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
  for (const bad of [`token-pairs/robinhood/${TOKEN}`, `token-pairs/ethereum/${TOKEN}`, `tokens/base/${TOKEN}`, `token-pairs/base/${TOKEN},${OTHER}`, `token-pairs/base/0x123`, `token-pairs/base/${TOKEN}/x`, 'token-pairs/base/']) {
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
  assert.deepEqual(cache.puts, [`${ORIGIN}/api/read/dex/cache/v1/base/token-pairs/${TOKEN}`], 'kept under Base’s own key');
  // The same address on Robinhood Chain is another token: its own read, its own key.
  const home = upstream(() => json(body));
  const robinhood = await answerDex(getAsk(`token-pairs/${TOKEN}`), { cache, now: time.now, fetch: home.fetch, inflight: new Map(), refreshing: new Map() });
  assert.deepEqual((await robinhood.json()).map((p) => p.chainId), ['robinhood']);
  assert.equal(home.calls[0].url, `https://api.dexscreener.com/token-pairs/v1/robinhood/${TOKEN}`);
  assert.equal(cache.puts[1], `${ORIGIN}/api/read/dex/cache/v1/token-pairs/${TOKEN}`, 'Robinhood Chain’s key as it always was');
  // Kept: Base's next ask within 30 s reads nothing upstream.
  const again = await answerDex(getAsk(`token-pairs/base/${TOKEN}`), { cache, now: time.now, fetch: dex.fetch, inflight: new Map(), refreshing: new Map() });
  assert.equal(again.headers.get('Server-Timing'), 'edge;desc="hit"');
  assert.equal(dex.calls.length, 1);
  assert.equal(trimPairOn('arbitrum')({ ...pair(V3_POOL, TOKEN, OTHER, 1), chainId: 'base' }), null, 'another chain’s pair is never passed on');
});
