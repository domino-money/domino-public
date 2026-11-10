/**
 * Edge hardening of 2026-11-07 (after rugged97's attack test of the open site): the public reads that reached the VM on
 * every request are kept at the edge too, and the overview's and the history's keys join the spellings their producer
 * answers alike, so neither a burst of visitors nor one address sending the app's own questions in other spellings costs
 * the VM more than one read a key. Nothing of a wallet is ever kept.
 *
 *   - token search (read-v3 search, functions/_lib/searchEdge.ts): hit, miss, stale, stale-if-error, the query's one
 *     spelling (ASCII spaces around it and ASCII case) with each asker's own query echoed, followers of a miss in another
 *     spelling, and the Worker's own refusals passed on, never kept;
 *   - read-v6's chain-pools and chain-tokens (functions/_lib/chainEdge.ts): `servedAt` and the age written as of the
 *     moment an answer leaves, as the producer writes its own cached answers, each version asked kept apart, and the
 *     wallet's reads never answered or kept here;
 *   - the overview's and the history's keys (overviewEdge.ts, historyEdge.ts): the same keys for every question the
 *     app sends, and one key for the spellings their producer answers alike.
 *
 * The Worker is a recorder standing in for the READ_BRIDGE binding. The contracts' own runtimes are the contract throughout.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as v3 from '../../api-contracts/read-v3/runtime.mjs';
import * as v6 from '../../api-contracts/read-v6/runtime.mjs';

const require = createRequire(import.meta.url);
const { EDGE_HEADER, EDGE_AGE_HEADER, FOLLOW_WAIT_MS, LEAD_LIFE_MS } = require('../.test-build/app/functions/_lib/publicEdge.js');
const {
  answerSearch, searchKey, searchQuery, servedSearch, SEARCH_PATH, SEARCH_DEFAULT_LIMIT, SEARCH_SECONDS, SEARCH_STALE_SECONDS, SEARCH_ERROR_SECONDS,
  SEARCH_ERROR_WAIT_MS,
} = require('../.test-build/app/functions/_lib/searchEdge.js');
const {
  answerChainPools, answerChainTokens, chainPoolsKey, chainTokensKey, servedPools, CHAIN_POOLS_PATH, CHAIN_TOKENS_PATH, POOLS_SECONDS,
  TOKENS_SECONDS, TOKENS_STALE_SECONDS, TOKENS_ERROR_SECONDS, TOKENS_ERROR_WAIT_MS, TOKENS_DEFAULT_LIMIT, LIVE_FRESH_SECONDS,
} = require('../.test-build/app/functions/_lib/chainEdge.js');
const { answerOverview, overviewKey, OVERVIEW_PATH, OVERVIEW_DEFAULT_LIMIT, OVERVIEW_SECONDS, OVERVIEW_STALE_SECONDS } = require('../.test-build/app/functions/_lib/overviewEdge.js');
const { answerHistory, historyKey, HISTORY_PATH, HISTORY_SECONDS, HISTORY_DEFAULT_WINDOW_SECONDS, HISTORY_DEFAULT_RESOLUTION_SECONDS } = require('../.test-build/app/functions/_lib/historyEdge.js');

const ORIGIN = 'https://domino.money';
const SEARCH = { CONTRACT_VERSION: v3.CONTRACT_VERSION, validateRequest: v3.validateRequest, validateResponse: v3.validateResponse, matchesRequest: v3.matchesRequest };
const OVERVIEW = SEARCH;
const CHAIN = { CONTRACT_VERSION: v6.CONTRACT_VERSION, CONTRACT_VERSIONS: v6.CONTRACT_VERSIONS, validateRequest: v6.validateRequest, validateResponse: v6.validateResponse, validateExchange: v6.validateExchange };
const fixture = (path) => JSON.parse(readFileSync(new URL(`../../api-contracts/${path}`, import.meta.url), 'utf8'));
const SEARCH_BODY = fixture('read-v3/fixtures/search.json');
const OVERVIEW_BODY = fixture('read-v3/fixtures/overview.json');
const HISTORY_BODY = fixture('read-v3/fixtures/history.json');
const POOLS_BODY = fixture('read-v6/fixtures/valid/chain-pools.json');
const TOKENS_BODY = fixture('read-v6/fixtures/valid/chain-tokens.json');
const POOLS_ASK = { chainId: POOLS_BODY.chainId, token: POOLS_BODY.token, pairedToken: POOLS_BODY.pairedToken };
const POOL = OVERVIEW_BODY.requestedPoolIds[0];
const NEXT = v6.NEXT_VERSION;

/** A browser's same-origin JSON POST, as the page's fetch sends it. */
function ask(path, body, { version = v3.CONTRACT_VERSION, headers = {}, url = `${ORIGIN}${path}`, method = 'POST' } = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  const all = new Headers({
    Host: new URL(url).host, Origin: ORIGIN, 'Content-Type': 'application/json', 'Sec-Fetch-Site': 'same-origin', 'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty', 'CF-Connecting-IP': '203.0.113.9', 'Content-Length': String(Buffer.byteLength(text)),
    ...(version === null ? {} : { 'X-Domino-Read-Contract': version }),
  });
  for (const [name, value] of Object.entries(headers)) value === null ? all.delete(name) : all.set(name, value);
  return new Request(url, method === 'GET' ? { method, headers: all } : { method, headers: all, body: text });
}

/** The read Worker's answer: as bridge/src/worker.mjs headersFor writes it. */
function said(body, { status = 200, version = v3.CONTRACT_VERSION, headers = {} } = {}) {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-Domino-Read-Contract': version, 'X-Domino-Request-Id': crypto.randomUUID(), ...headers },
  });
}

function bridge(answer) {
  const calls = [];
  return { calls, env: { READ_BRIDGE: { async fetch(request) { const text = await request.clone().text(); calls.push(text); return answer(request, text); } } } };
}

function memoryCache() {
  const entries = new Map();
  const puts = [];
  return {
    entries, puts,
    async match(request) { const entry = entries.get(request.url); return entry ? entry.clone() : undefined; },
    async put(request, response) { puts.push(request.url); entries.set(request.url, new Response(await response.text(), response)); },
    async delete(request) { return entries.delete(request.url); },
  };
}

function clock(start) {
  const at = { now: start };
  return { at, now: () => at.now };
}

async function drain(later) {
  while (later.length > 0) await Promise.all(later.splice(0));
}

/** The header names an answer carries, sorted. */
const headerNames = (response) => [...response.headers.keys()].sort();
/** What every answer from the edge carries, the overview's and the history's since 2026-10-01: no request id, since no Worker handled it. */
const EDGE_ANSWER_HEADERS = ['cache-control', 'content-type', 'server-timing', 'x-content-type-options', 'x-domino-edge-age', 'x-domino-read-contract'];

// ---------------------------------------------------------------------------
// Token search (read-v3)
// ---------------------------------------------------------------------------

const askSearch = (body, options) => ask(SEARCH_PATH, body, options);
const searchSaid = (query, options) => said({ ...SEARCH_BODY, query }, options);
/** A Worker that answers every search with the fixture's tokens, its query echoed as the producer echoes it. */
const searchWorker = (status = () => 200) => bridge((_request, text) => {
  const code = status();
  if (code !== 200) return said({ error: code === 429 ? 'read_capacity_busy' : 'upstream_unavailable' }, { status: code, headers: code === 429 ? { 'Retry-After': '2' } : {} });
  return searchSaid(JSON.parse(text).query);
});

test('search: the limits are the ones measured against real use, and the fixture is an answer read-v3 accepts', () => {
  assert.deepEqual([SEARCH_DEFAULT_LIMIT, SEARCH_SECONDS, SEARCH_STALE_SECONDS, SEARCH_ERROR_SECONDS, SEARCH_ERROR_WAIT_MS], [20, 20, 60, 900, 1_000]);
  assert.equal(v3.validateResponse('search', SEARCH_BODY), true);
  assert.equal(v3.matchesRequest('search', { query: SEARCH_BODY.query }, SEARCH_BODY), true);
});

test('search: a miss is the Worker’s own answer, kept; the same question within 20 s is answered here, headers as the overview’s and the history’s', async () => {
  const cache = memoryCache(), time = clock(Date.UTC(2026, 10, 7, 12)), later = [];
  const worker = searchWorker();
  const rt = () => ({ contract: SEARCH, cache, now: time.now, refreshing: new Map(), inflight: new Map(), waitUntil: (work) => later.push(work) });
  const first = await answerSearch(askSearch({ query: 'TOKEN', limit: 20 }), worker.env, rt());
  assert.equal(first.status, 200);
  assert.notEqual(first.headers.get('X-Domino-Request-Id'), null, 'the Worker’s answer, as it came');
  assert.equal(first.headers.get('Server-Timing'), 'edge;desc="miss"');
  assert.equal(first.headers.get(EDGE_HEADER), null);
  assert.deepEqual(await first.json(), SEARCH_BODY);
  await drain(later);
  assert.deepEqual(cache.puts, [searchKey(v3.CONTRACT_VERSION, { query: 'token' })]);
  assert.equal(cache.entries.get(cache.puts[0]).headers.get('Cache-Control'), `max-age=${SEARCH_ERROR_SECONDS}`);
  time.at.now += SEARCH_SECONDS * 1000 - 1;
  const hit = await answerSearch(askSearch({ query: 'TOKEN', limit: 20 }), worker.env, rt());
  assert.equal(hit.status, 200);
  assert.equal(hit.headers.get(EDGE_HEADER), 'hit');
  assert.equal(hit.headers.get(EDGE_AGE_HEADER), String(SEARCH_SECONDS * 1000 - 1));
  assert.equal(hit.headers.get('Server-Timing'), 'edge;desc="hit"');
  assert.equal(hit.headers.get('X-Domino-Read-Contract'), v3.CONTRACT_VERSION);
  assert.equal(hit.headers.get('Cache-Control'), 'no-store');
  assert.equal(hit.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.deepEqual(headerNames(hit), [...EDGE_ANSWER_HEADERS, 'x-domino-edge-cache'].sort());
  assert.equal(await hit.text(), JSON.stringify(SEARCH_BODY), 'the kept bytes, as the Worker gave them');
  assert.equal(worker.calls.length, 1);
  // The overview's hit carries exactly the same headers.
  const overviewCache = memoryCache();
  const overviewWorker = bridge(() => said(OVERVIEW_BODY));
  const overviewRt = { contract: OVERVIEW, cache: overviewCache, now: time.now, refreshing: new Map(), inflight: new Map() };
  await answerOverview(ask(OVERVIEW_PATH, { poolIds: [POOL] }), overviewWorker.env, overviewRt);
  const overviewHit = await answerOverview(ask(OVERVIEW_PATH, { poolIds: [POOL] }), overviewWorker.env, overviewRt);
  assert.deepEqual(headerNames(overviewHit), headerNames(hit), 'the same headers as today’s overview hit');
});

test('search: a query told apart only by ASCII case or the spaces around it is one question, each asker’s own query echoed; no other is joined', async () => {
  assert.equal(searchQuery('  TokEn \t'), 'token');
  assert.equal(searchQuery('USD Coin'), 'usd coin', 'spaces inside stay');
  assert.equal(searchQuery('ÉTH'), 'Éth', 'a letter outside ASCII keeps its case');
  assert.notEqual(searchKey(v3.CONTRACT_VERSION, { query: 'ÉTH' }), searchKey(v3.CONTRACT_VERSION, { query: 'éth' }));
  // Review of 2026-11-07: every space Python's str.strip() cuts (str.isspace(), Python 3.12), so a no-break space or an
  // ideographic one around a query is no question of its own; none it keeps (U+FEFF, U+180E, U+200B) is cut.
  const STRIPPED = [0x9, 0xa, 0xb, 0xc, 0xd, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
    0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000];
  for (const code of STRIPPED) {
    const space = String.fromCodePoint(code);
    assert.equal(searchQuery(`${space}${space}ETH${space}`), 'eth', `U+${code.toString(16).padStart(4, '0')} is cut around a query`);
    assert.equal(searchQuery(`E${space}TH`), `e${space}th`, 'and kept inside it');
  }
  for (const code of [0xfeff, 0x180e, 0x200b]) {
    const kept = String.fromCodePoint(code);
    assert.equal(searchQuery(`${kept}eth`), `${kept}eth`, `U+${code.toString(16)} is no space to strip(): kept`);
  }
  assert.equal(searchKey(v3.CONTRACT_VERSION, { query: 'eth' }), searchKey(v3.CONTRACT_VERSION, { query: 'ETH', limit: SEARCH_DEFAULT_LIMIT }), 'the default limit is the page’s');
  assert.notEqual(searchKey(v3.CONTRACT_VERSION, { query: 'eth', limit: 5 }), searchKey(v3.CONTRACT_VERSION, { query: 'eth' }));
  assert.notEqual(searchKey(v3.CONTRACT_VERSION, { query: 'eth' }), searchKey(v3.CONTRACT_VERSION, { query: 'eth2' }));
  const cache = memoryCache(), time = clock(Date.UTC(2026, 10, 7, 12));
  const worker = searchWorker();
  const rt = () => ({ contract: SEARCH, cache, now: time.now, refreshing: new Map(), inflight: new Map() });
  await answerSearch(askSearch({ query: 'TOKEN' }), worker.env, rt());
  for (const query of ['token', ' Token ', 'tOKEN\n']) {
    const hit = await answerSearch(askSearch({ query }), worker.env, rt());
    assert.equal(hit.headers.get(EDGE_HEADER), 'hit', JSON.stringify(query));
    const data = await hit.json();
    assert.equal(data.query, query, 'the asker’s own query');
    assert.deepEqual(data.tokens, SEARCH_BODY.tokens);
    assert.equal(v3.matchesRequest('search', { query }, data), true, 'an answer to the very question asked');
    assert.deepEqual(Object.keys(data), Object.keys(SEARCH_BODY), 'the same fields, in the same order');
  }
  assert.equal(worker.calls.length, 1);
  await answerSearch(askSearch({ query: 'TOKENS' }), worker.env, rt());
  await answerSearch(askSearch({ query: 'TOKEN', limit: 5 }), worker.env, rt());
  assert.equal(worker.calls.length, 3, 'another query, another limit: the Worker’s');
  // The kept text serves an answer to another spelling only through read-v3's own check.
  assert.equal(servedSearch({ query: 'TOKEN' }, JSON.stringify(SEARCH_BODY)), JSON.stringify(SEARCH_BODY), 'the same echo: the same bytes');
  assert.equal(servedSearch({ query: 1 }, JSON.stringify(SEARCH_BODY)), null);
});

test('search: a follower of a miss asked in another spelling gets the leader’s answer with its own query, and no gateway sees it', async () => {
  const cache = memoryCache(), time = clock(Date.UTC(2026, 10, 7, 12)), inflight = new Map();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const worker = bridge(async (_request, text) => { await gate; return searchSaid(JSON.parse(text).query); });
  const rt = () => ({ contract: SEARCH, cache, now: time.now, refreshing: new Map(), inflight });
  const leader = answerSearch(askSearch({ query: 'TOKEN' }), worker.env, rt());
  await new Promise((resolve) => setImmediate(resolve));
  const follower = answerSearch(askSearch({ query: 'token' }), worker.env, rt());
  // Well within the follower's own wait (FOLLOW_WAIT_MS, a second): it is waiting on the leader by then.
  await new Promise((resolve) => setTimeout(resolve, 50));
  release();
  const [led, followed] = await Promise.all([leader, follower]);
  assert.equal((await led.json()).query, 'TOKEN');
  assert.equal(followed.headers.get('Server-Timing'), 'edge;desc="coalesced"');
  assert.equal(followed.headers.get(EDGE_HEADER), 'hit', 'no gateway saw it');
  assert.equal((await followed.json()).query, 'token');
  assert.equal(worker.calls.length, 1, 'one read for both');
});

test('search: past 20 s served at once while it refreshes behind; past a minute it stands in only for a failure, for fifteen minutes', async () => {
  const cache = memoryCache(), time = clock(Date.UTC(2026, 10, 7, 12)), later = [], refreshing = new Map();
  let status = 200;
  const worker = searchWorker(() => status);
  const rt = () => ({ contract: SEARCH, cache, now: time.now, refreshing, inflight: new Map(), waitUntil: (work) => later.push(work) });
  await answerSearch(askSearch({ query: 'TOKEN' }), worker.env, rt());
  await drain(later);
  time.at.now += SEARCH_SECONDS * 1000;
  const stale = await answerSearch(askSearch({ query: 'token' }), worker.env, rt());
  assert.equal(stale.headers.get('Server-Timing'), 'edge;desc="stale"');
  assert.equal(stale.headers.get(EDGE_HEADER), null, 'the request that refreshes it is counted');
  assert.equal((await stale.json()).query, 'token');
  await drain(later);
  assert.equal(worker.calls.length, 2, 'refreshed behind');
  // Past the stale minute, with the VM failing: the kept answer stands in, with the asker's query.
  time.at.now += SEARCH_STALE_SECONDS * 1000;
  status = 503;
  const standIn = await answerSearch(askSearch({ query: 'Token' }), worker.env, rt());
  assert.equal(standIn.status, 200);
  assert.equal(standIn.headers.get('Server-Timing'), 'edge;desc="stale-if-error"');
  assert.equal(standIn.headers.get(EDGE_HEADER), null, 'this request reached the Worker');
  assert.equal((await standIn.json()).query, 'Token');
  await drain(later);
  // A refusal for load (429) stands in for the visitor it was given to, and guards nothing for anyone else (review of
  // 2026-11-07: mostly that visitor's own budget).
  status = 429;
  refreshing.clear();
  const busy = await answerSearch(askSearch({ query: 'TOKEN' }), worker.env, rt());
  assert.equal(busy.status, 200);
  assert.equal(busy.headers.get('Server-Timing'), 'edge;desc="stale-if-error"');
  await drain(later);
  assert.equal(refreshing.size, 0, 'no guard after a 429');
  // Past fifteen minutes the Worker's own failure is passed on as it came.
  time.at.now += SEARCH_ERROR_SECONDS * 1000;
  refreshing.clear();
  status = 503;
  const failed = await answerSearch(askSearch({ query: 'TOKEN' }), worker.env, rt());
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: 'upstream_unavailable' });
});

test('search: a question the Worker would refuse is its own to refuse, and nothing it refuses or fails is ever kept', async () => {
  const cache = memoryCache(), time = clock(Date.UTC(2026, 10, 7, 12));
  const worker = bridge(() => said({ error: 'invalid_request' }, { status: 422 }));
  const rt = () => ({ contract: SEARCH, cache, now: time.now, refreshing: new Map(), inflight: new Map() });
  const malformed = [
    askSearch({ query: '' }),
    askSearch({ query: 'x'.repeat(97) }),
    askSearch({ query: 'eth', limit: 25 }),
    askSearch({ query: 'eth', extra: true }),
    askSearch({ query: '   ' }),
    askSearch('{"query":'),
    askSearch({ query: 'eth' }, { headers: { Origin: 'https://evil.example' } }),
    askSearch({ query: 'eth' }, { headers: { 'Content-Type': 'text/plain' } }),
    askSearch({ query: 'eth' }, { headers: { 'Content-Length': null } }),
    askSearch({ query: 'eth' }, { headers: { 'Sec-Fetch-Site': 'cross-site' } }),
    askSearch({ query: 'eth' }, { headers: { 'CF-Worker': 'example.com' } }),
    askSearch({ query: 'eth' }, { version: 'other-version' }),
    askSearch({ query: 'eth' }, { url: `${ORIGIN}${SEARCH_PATH}?x=1` }),
    ask(SEARCH_PATH, '', { method: 'GET' }),
  ];
  for (const request of malformed) {
    const answer = await answerSearch(request, worker.env, rt());
    assert.notEqual(answer.headers.get(EDGE_HEADER), 'hit');
  }
  // The CF-Worker one is the forwarder's own refusal; every other is the Worker's.
  assert.equal(worker.calls.length, malformed.length - 1);
  assert.deepEqual(cache.puts, [], 'nothing kept');
  // A valid question whose answer is a failure or a refusal: passed on, never kept.
  for (const status of [404, 408, 422, 429, 500, 503, 504]) {
    const failing = bridge(() => said({ error: 'upstream_unavailable' }, { status }));
    const answer = await answerSearch(askSearch({ query: 'eth' }), failing.env, rt());
    assert.equal(answer.status, status);
  }
  // An answer to another question (an echo that is not the asker's), or not the contract's, is never kept either.
  const wrong = bridge(() => searchSaid('other'));
  await answerSearch(askSearch({ query: 'eth' }), wrong.env, rt());
  const unversioned = bridge(() => said(SEARCH_BODY, { version: 'other' }));
  await answerSearch(askSearch({ query: 'TOKEN' }), unversioned.env, rt());
  assert.deepEqual(cache.puts, []);
});

// ---------------------------------------------------------------------------
// read-v6 chain-pools and chain-tokens
// ---------------------------------------------------------------------------

const askPools = (body = POOLS_ASK, options = {}) => ask(CHAIN_POOLS_PATH, body, { version: v6.CONTRACT_VERSION, ...options });
const askTokens = (body, options = {}) => ask(CHAIN_TOKENS_PATH, body, { version: v6.CONTRACT_VERSION, ...options });
const v6Said = (body, options = {}) => said(body, { version: body.contractVersion ?? v6.CONTRACT_VERSION, ...options });

test('chain reads: the limits add little to the producer’s own copies (chain-pools 15 s; the index’s tokens 60 s, looked-up ones live), and the fixtures are answers read-v6 accepts', () => {
  // Review of 2026-11-07: chain-pools never stands in for a failure; chain-tokens fresh 10 s and stale to 30 s (30 and 60 before).
  assert.deepEqual([POOLS_SECONDS, TOKENS_SECONDS, TOKENS_STALE_SECONDS, TOKENS_ERROR_SECONDS, TOKENS_ERROR_WAIT_MS, TOKENS_DEFAULT_LIMIT, LIVE_FRESH_SECONDS], [5, 10, 30, 900, 1_000, 20, 60]);
  assert.equal(v6.validateResponse('chain-pools', POOLS_BODY), true);
  assert.equal(v6.validateExchange('chain-pools', POOLS_ASK, POOLS_BODY), true);
  assert.equal(v6.validateExchange('chain-tokens', { chainId: TOKENS_BODY.chainId, query: TOKENS_BODY.query, limit: 20 }, TOKENS_BODY), true);
});

test('chain-pools: kept 5 s and served with servedAt and its age as of the moment it leaves, as the producer stamps its own copy; never served stale', async () => {
  const cache = memoryCache(), time = clock(POOLS_BODY.servedAt * 1000), later = [];
  const worker = bridge(() => v6Said(POOLS_BODY));
  const rt = () => ({ contract: CHAIN, cache, now: time.now, refreshing: new Map(), inflight: new Map(), waitUntil: (work) => later.push(work) });
  const first = await answerChainPools(askPools(), worker.env, rt());
  assert.notEqual(first.headers.get('X-Domino-Request-Id'), null, 'the Worker’s answer, as it came');
  assert.equal(await first.text(), JSON.stringify(POOLS_BODY));
  await drain(later);
  assert.deepEqual(cache.puts, [chainPoolsKey(v6.CONTRACT_VERSION, POOLS_ASK)]);
  assert.equal(cache.entries.get(cache.puts[0]).headers.get('Cache-Control'), `max-age=${POOLS_SECONDS}`, 'kept no longer than it is served');
  time.at.now += 3_400;
  const hit = await answerChainPools(askPools(), worker.env, rt());
  assert.equal(hit.headers.get(EDGE_HEADER), 'hit');
  assert.deepEqual(headerNames(hit), [...EDGE_ANSWER_HEADERS, 'x-domino-edge-cache'].sort(), 'the headers of every edge answer');
  assert.equal(hit.headers.get('X-Domino-Read-Contract'), v6.CONTRACT_VERSION);
  const data = await hit.json();
  assert.equal(data.servedAt, POOLS_BODY.servedAt + 3, 'served now, in the producer’s whole seconds');
  assert.deepEqual(data.freshness, { ageSeconds: data.servedAt - POOLS_BODY.snapshot.timestamp, status: 'fresh' });
  assert.deepEqual({ ...data, servedAt: POOLS_BODY.servedAt, freshness: POOLS_BODY.freshness }, POOLS_BODY, 'nothing else changed');
  assert.deepEqual(Object.keys(data), Object.keys(POOLS_BODY), 'the same fields, in the same order');
  assert.equal(v6.validateResponse('chain-pools', data) && v6.validateExchange('chain-pools', POOLS_ASK, data), true, 'what the page checks');
  assert.equal(worker.calls.length, 1);
  // Past 5 s the VM is asked again (it answers from its own 15 s copy): no stale answer is served at once.
  time.at.now = POOLS_BODY.servedAt * 1000 + POOLS_SECONDS * 1000;
  const again = await answerChainPools(askPools(), worker.env, rt());
  assert.equal(again.headers.get('Server-Timing'), 'edge;desc="miss"');
  assert.equal(worker.calls.length, 2);
  // The producer's clock ahead of the edge's: servedAt never goes back.
  assert.equal(JSON.parse(servedPools(JSON.stringify(POOLS_BODY), (POOLS_BODY.servedAt - 30) * 1000)).servedAt, POOLS_BODY.servedAt);
});

// Review of 2026-11-07 (D1, D2): a kept chain-pools answer stood in for the VM's after a second's wait, even while the VM
// was healthy, and one visitor's 429 had it stand in for everyone's. A chain-pools answer is a live price, and the page
// reads the pool through the wallet when the VM fails: nothing kept ever stands in for it now.
test('chain-pools: no kept answer ever stands in for the VM’s, a failure or a 429 reaches the page as it came, and nothing guards the key', async () => {
  const cache = memoryCache(), time = clock(POOLS_BODY.servedAt * 1000), later = [], refreshing = new Map();
  let status = 200;
  let armed = 0;
  const worker = bridge(() => (status === 200 ? v6Said(POOLS_BODY)
    : said({ error: status === 429 ? 'read_capacity_busy' : 'upstream_unavailable' }, { status, version: v6.CONTRACT_VERSION, headers: status === 429 ? { 'Retry-After': '3' } : {} })));
  const rt = () => ({ contract: CHAIN, cache, now: time.now, refreshing, inflight: new Map(), waitUntil: (work) => later.push(work), timer: (ms, fire) => { armed += 1; const handle = setTimeout(fire, ms); return () => clearTimeout(handle); } });
  await answerChainPools(askPools(), worker.env, rt());
  await drain(later);
  for (const [code, after] of [[503, POOLS_SECONDS * 1000], [429, 1_000], [504, 40_000]]) {
    status = code;
    time.at.now += after;
    const failed = await answerChainPools(askPools(), worker.env, rt());
    assert.equal(failed.status, code, `a ${code} reaches the page as it came`);
    assert.equal(failed.headers.get('Server-Timing'), null, 'the Worker’s own answer');
    if (code === 429) assert.equal(failed.headers.get('Retry-After'), '3', 'its wait too');
    await drain(later);
  }
  assert.equal(armed, 0, 'no wait was cut short: the Worker’s own result was waited for');
  assert.equal(refreshing.size, 0, 'no guard: the next visitor asks the VM');
  status = 200;
  const fresh = await answerChainPools(askPools(), worker.env, rt());
  assert.equal(fresh.headers.get('Server-Timing'), 'edge;desc="miss"');
  assert.equal(worker.calls.length, 5, 'every one of them asked the VM');
});

// Review of 2026-11-07 (D1): a request that joined a chain-pools read on its way gave up after FOLLOW_WAIT_MS (1 s) and got
// the kept answer, or asked the VM again, though the read takes 1.7 to 3 s.
test('chain-pools: a request that joins a read on its way waits for it whole and gets its answer; one VM read, and the read is seen through for them', async () => {
  const cache = memoryCache(), time = clock(POOLS_BODY.servedAt * 1000), inflight = new Map(), later = [];
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const worker = bridge(async () => { await gate; return v6Said(POOLS_BODY); });
  const waits = [];
  const rt = () => ({ contract: CHAIN, cache, now: time.now, refreshing: new Map(), inflight, waitUntil: (work) => later.push(work),
    timer: (ms) => { waits.push(ms); return () => undefined; } });
  const leader = answerChainPools(askPools(), worker.env, rt());
  while (inflight.size === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(later.length, 1, 'the leader’s read is handed to waitUntil, so it settles even once its own visitor has gone');
  time.at.now += 1_500;
  const follower = answerChainPools(askPools(), worker.env, rt());
  while (waits.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(waits, [LEAD_LIFE_MS - 1_500], 'as long as the leader may take, not FOLLOW_WAIT_MS');
  assert.ok(waits[0] > FOLLOW_WAIT_MS);
  // The chain read lands well past a second.
  time.at.now += 1_200;
  release();
  const [led, followed] = await Promise.all([leader, follower]);
  assert.equal(led.headers.get('Server-Timing'), 'edge;desc="miss"');
  assert.equal(followed.headers.get('Server-Timing'), 'edge;desc="coalesced"');
  assert.equal(followed.headers.get(EDGE_HEADER), 'hit', 'no gateway saw it');
  const data = await followed.json();
  assert.equal(data.servedAt, POOLS_BODY.servedAt + 2, 'the leader’s fresh read, served as of now');
  assert.deepEqual(data.freshness, { ageSeconds: data.servedAt - POOLS_BODY.snapshot.timestamp, status: 'fresh' });
  assert.equal(worker.calls.length, 1, 'one read for both');
  await drain(later);
  assert.equal(inflight.size, 0, 'nothing left behind');
  // A leader that fails leaves its follower to ask the VM itself, as before; nothing kept stands in.
  time.at.now += POOLS_SECONDS * 1000;
  let n = 0;
  let fail;
  const failing = new Promise((resolve) => { fail = resolve; });
  const flaky = bridge(async () => { n += 1; if (n === 1) { await failing; return said({ error: 'upstream_unavailable' }, { status: 503, version: v6.CONTRACT_VERSION }); } return v6Said(POOLS_BODY); });
  const first = answerChainPools(askPools(), flaky.env, rt());
  while (inflight.size === 0) await new Promise((resolve) => setImmediate(resolve));
  const second = answerChainPools(askPools(), flaky.env, rt());
  while (waits.length === 1) await new Promise((resolve) => setImmediate(resolve));
  fail();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(one.status, 503);
  assert.equal(two.status, 200);
  assert.equal(two.headers.get('Server-Timing'), 'edge;desc="miss"', 'its own read');
  assert.equal(flaky.calls.length, 2);
});

test('chain-pools: each version asked is kept apart, and a request in one is never answered in the other', async () => {
  const cache = memoryCache(), time = clock(POOLS_BODY.servedAt * 1000);
  const worker = bridge((request) => {
    const version = request.headers.get('X-Domino-Read-Contract');
    return v6Said({ ...POOLS_BODY, contractVersion: version });
  });
  const rt = () => ({ contract: CHAIN, cache, now: time.now, refreshing: new Map(), inflight: new Map() });
  assert.notEqual(chainPoolsKey(v6.CONTRACT_VERSION, POOLS_ASK), chainPoolsKey(NEXT, POOLS_ASK));
  assert.equal(chainPoolsKey(v6.CONTRACT_VERSION, POOLS_ASK), chainPoolsKey(v6.CONTRACT_VERSION, { ...POOLS_ASK }), 'one key a question');
  await answerChainPools(askPools(POOLS_ASK, { version: NEXT }), worker.env, rt());
  const next = await answerChainPools(askPools(POOLS_ASK, { version: NEXT }), worker.env, rt());
  assert.equal(next.headers.get(EDGE_HEADER), 'hit');
  assert.equal(next.headers.get('X-Domino-Read-Contract'), NEXT);
  assert.equal((await next.json()).contractVersion, NEXT);
  const current = await answerChainPools(askPools(), worker.env, rt());
  assert.equal(current.headers.get('Server-Timing'), 'edge;desc="miss"', 'the other version is not answered from it');
  assert.equal((await current.json()).contractVersion, v6.CONTRACT_VERSION);
  // A request naming no version is answered in the route's first, as the Worker answers it.
  const unnamed = await answerChainPools(askPools(POOLS_ASK, { version: null }), worker.env, rt());
  assert.equal(unnamed.headers.get(EDGE_HEADER), 'hit');
  assert.equal(unnamed.headers.get('X-Domino-Read-Contract'), v6.CONTRACT_VERSION);
  assert.equal(worker.calls.length, 2);
});

test('chain-tokens: one question for each spelling the producer folds alike, each asker’s own query echoed, servedAt as of now, stale behind', async () => {
  const cache = memoryCache(), time = clock(TOKENS_BODY.servedAt * 1000), later = [];
  const worker = bridge((_request, text) => v6Said({ ...TOKENS_BODY, query: JSON.parse(text).query }));
  const rt = () => ({ contract: CHAIN, cache, now: time.now, refreshing: new Map(), inflight: new Map(), waitUntil: (work) => later.push(work) });
  const asked = { chainId: TOKENS_BODY.chainId, query: 'Aero', limit: 8 };
  await answerChainTokens(askTokens(asked), worker.env, rt());
  await drain(later);
  assert.deepEqual(cache.puts, [chainTokensKey(v6.CONTRACT_VERSION, { chainId: TOKENS_BODY.chainId, query: 'aero', limit: 8 })]);
  time.at.now += 8_000;
  const hit = await answerChainTokens(askTokens({ ...asked, query: ' AERO ' }), worker.env, rt());
  assert.equal(hit.headers.get(EDGE_HEADER), 'hit');
  const data = await hit.json();
  assert.equal(data.query, ' AERO ');
  assert.equal(data.servedAt, TOKENS_BODY.servedAt + 8);
  assert.deepEqual(data.tokens, TOKENS_BODY.tokens);
  assert.equal(v6.validateExchange('chain-tokens', { ...asked, query: ' AERO ' }, data), true);
  assert.equal(worker.calls.length, 1);
  assert.equal(chainTokensKey(v6.CONTRACT_VERSION, { chainId: 8453, query: 'aero' }), chainTokensKey(v6.CONTRACT_VERSION, { chainId: 8453, query: 'AERO', limit: 20 }));
  assert.notEqual(chainTokensKey(v6.CONTRACT_VERSION, { chainId: 8453, query: 'aero' }), chainTokensKey(v6.CONTRACT_VERSION, { chainId: 42161, query: 'aero' }), 'another chain, another question');
  // Another limit: another question.
  await answerChainTokens(askTokens({ ...asked, limit: 9 }), worker.env, rt());
  assert.equal(worker.calls.length, 2);
  await drain(later);
  // Past 10 s: served at once while the request refreshes it behind.
  time.at.now += TOKENS_SECONDS * 1000;
  const stale = await answerChainTokens(askTokens(asked), worker.env, rt());
  assert.equal(stale.headers.get('Server-Timing'), 'edge;desc="stale"');
  await drain(later);
  assert.equal(worker.calls.length, 3);
});

test('the wallet’s reads are never answered or kept here: no route of these takes their paths or their bodies, and no key names a wallet', async () => {
  const cache = memoryCache(), time = clock(POOLS_BODY.servedAt * 1000);
  const wallet = '0x00000000000000000000000000000000000000aa';
  const worker = bridge(() => v6Said({ ...POOLS_BODY, wallet }));
  const rt = () => ({ contract: CHAIN, cache, now: time.now, refreshing: new Map(), inflight: new Map() });
  const bodies = [{ wallet }, { wallet, limit: 20 }, { wallet, tokens: null }];
  for (const path of ['/api/read/v6/portfolio', '/api/read/v6/activity', '/api/read/v6/chain-balances', '/api/read/v6/position-fees']) {
    for (const body of bodies) {
      await answerChainPools(ask(path, body, { version: v6.CONTRACT_VERSION }), worker.env, rt());
      await answerChainTokens(ask(path, body, { version: v6.CONTRACT_VERSION }), worker.env, rt());
    }
  }
  // A wallet's body on a chain read's own path is not that read's question: the Worker's to refuse.
  for (const body of bodies) {
    await answerChainPools(askPools(body), worker.env, rt());
    await answerChainTokens(askTokens(body), worker.env, rt());
  }
  assert.deepEqual(cache.puts, [], 'nothing kept');
  assert.equal(worker.calls.length, 4 * bodies.length * 2 + bodies.length * 2, 'each forwarded as it came');
  // Only the two chain reads have a route of their own under /api/read/v6/; the wallet's reach the catch-all.
  const routes = new URL('../functions/api/read/v6/', import.meta.url);
  assert.deepEqual(readdirSync(routes).sort(), ['chain-pools.ts', 'chain-tokens.ts']);
  for (const name of ['portfolio', 'activity', 'chain-balances', 'position-fees']) assert.equal(existsSync(new URL(`${name}.ts`, routes)), false, name);
  // No key names anything but the chain, the token or the query.
  assert.doesNotMatch(chainPoolsKey(v6.CONTRACT_VERSION, POOLS_ASK) + chainTokensKey(v6.CONTRACT_VERSION, { chainId: 8453, query: 'x' }), /wallet/);
});

// ---------------------------------------------------------------------------
// The overview's and the history's keys
// ---------------------------------------------------------------------------

test('overview and history keys: the app’s own questions keep the keys they had; the spellings their producer answers alike share one', () => {
  const token = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
  const key = (question) => `${ORIGIN}/api/read/v3/cache/${encodeURIComponent(v3.CONTRACT_VERSION)}/overview/${encodeURIComponent(JSON.stringify(question))}`;
  // As before 2026-11-07, for every question a screen sends.
  assert.equal(overviewKey(v3.CONTRACT_VERSION, { poolIds: [POOL] }), key([null, [POOL], null, null, null]));
  assert.equal(overviewKey(v3.CONTRACT_VERSION, { token, limit: 24 }), key([token, [], null, null, 24]));
  assert.equal(overviewKey(v3.CONTRACT_VERSION, { token, limit: 24, afterPoolId: POOL, revision: 7 }), key([token, [], POOL, 7, 24]));
  // Pools by id: the limit is no part of the question.
  for (const limit of [1, 12, 24]) assert.equal(overviewKey(v3.CONTRACT_VERSION, { poolIds: [POOL], limit }), overviewKey(v3.CONTRACT_VERSION, { poolIds: [POOL] }));
  assert.notEqual(overviewKey(v3.CONTRACT_VERSION, { poolIds: [POOL], revision: 5 }), overviewKey(v3.CONTRACT_VERSION, { poolIds: [POOL] }), 'a revision stays its own question');
  // A token's pages: a limit left out is the default, 24; another limit is another question.
  assert.equal(OVERVIEW_DEFAULT_LIMIT, 24);
  assert.equal(overviewKey(v3.CONTRACT_VERSION, { token }), overviewKey(v3.CONTRACT_VERSION, { token, limit: 24 }));
  assert.notEqual(overviewKey(v3.CONTRACT_VERSION, { token, limit: 10 }), overviewKey(v3.CONTRACT_VERSION, { token, limit: 24 }));
  // The history: a window or resolution left out is the default; every screen names both, so its keys are as before.
  const historyAt = (question) => `${ORIGIN}/api/read/v3/cache/${encodeURIComponent(v3.CONTRACT_VERSION)}/history/${encodeURIComponent(JSON.stringify(question))}`;
  const asked = { poolId: HISTORY_BODY.poolId, currency: HISTORY_BODY.currency };
  assert.deepEqual([HISTORY_DEFAULT_WINDOW_SECONDS, HISTORY_DEFAULT_RESOLUTION_SECONDS], [86_400, 3_600]);
  for (const [window, resolution] of [[86_400, 3_600], [604_800, 3_600], [2_592_000, 86_400]]) {
    assert.equal(historyKey(v3.CONTRACT_VERSION, { ...asked, windowSeconds: window, resolutionSeconds: resolution }), historyAt([asked.poolId, asked.currency, window, resolution]));
  }
  assert.equal(historyKey(v3.CONTRACT_VERSION, asked), historyKey(v3.CONTRACT_VERSION, { ...asked, windowSeconds: 86_400, resolutionSeconds: 3_600 }));
  assert.equal(historyKey(v3.CONTRACT_VERSION, { ...asked, resolutionSeconds: 3_600 }), historyKey(v3.CONTRACT_VERSION, asked));
  assert.notEqual(historyKey(v3.CONTRACT_VERSION, { ...asked, windowSeconds: 604_800 }), historyKey(v3.CONTRACT_VERSION, asked));
});

test('overview and history: a spelling the producer answers alike is answered from the edge, checked against the very request; a revision the catalogue is not at never is', async () => {
  const time = clock(Date.UTC(2026, 10, 7, 12));
  const overviewCache = memoryCache();
  const overviewWorker = bridge(() => said(OVERVIEW_BODY));
  const overviewRt = () => ({ contract: OVERVIEW, cache: overviewCache, now: time.now, refreshing: new Map(), inflight: new Map() });
  await answerOverview(ask(OVERVIEW_PATH, { poolIds: [POOL] }), overviewWorker.env, overviewRt());
  const limited = await answerOverview(ask(OVERVIEW_PATH, { poolIds: [POOL], limit: 3 }), overviewWorker.env, overviewRt());
  assert.equal(limited.headers.get(EDGE_HEADER), 'hit');
  assert.deepEqual(await limited.json(), OVERVIEW_BODY);
  const revised = await answerOverview(ask(OVERVIEW_PATH, { poolIds: [POOL], revision: OVERVIEW_BODY.revision + 1 }), overviewWorker.env, overviewRt());
  assert.notEqual(revised.headers.get(EDGE_HEADER), 'hit', 'another revision is the Worker’s');
  assert.equal(overviewWorker.calls.length, 2);
  const historyCache = memoryCache();
  const historyWorker = bridge(() => said(HISTORY_BODY));
  const historyRt = () => ({ contract: OVERVIEW, cache: historyCache, now: time.now, refreshing: new Map(), inflight: new Map() });
  const asked = { poolId: HISTORY_BODY.poolId, currency: HISTORY_BODY.currency };
  await answerHistory(ask(HISTORY_PATH, { ...asked, windowSeconds: 86_400, resolutionSeconds: 3_600 }), historyWorker.env, historyRt());
  time.at.now += HISTORY_SECONDS * 1000 - 1;
  const defaulted = await answerHistory(ask(HISTORY_PATH, asked), historyWorker.env, historyRt());
  assert.equal(defaulted.headers.get(EDGE_HEADER), 'hit');
  assert.deepEqual(await defaulted.json(), HISTORY_BODY);
  assert.equal(historyWorker.calls.length, 1);
});

// ---------------------------------------------------------------------------
// A 429 is the asker's own (review of 2026-11-07, D2)
// ---------------------------------------------------------------------------

// The gateway's 429 (read_capacity_busy) is mostly one visitor's own budget, keyed on its address. It held the key for every
// visitor in the isolate: one address past its budget, asking every 10 s, kept every visitor on the kept answer, on the
// overview's, the history's and the featured list's routes since 2026-10-30, and on the new routes with them.
test('a 429 is the asker’s own: it stands in for that visitor alone, never guards the key, and the next visitor asks the VM itself, on every route kept at the edge', async () => {
  const A = '198.51.100.7', B = '203.0.113.20';
  const from = (ip) => ({ headers: { 'CF-Connecting-IP': ip } });
  const tokensAsk = { chainId: TOKENS_BODY.chainId, query: TOKENS_BODY.query, limit: 20 };
  const routes = [
    { name: 'search', answer: answerSearch, contract: SEARCH, request: (ip) => askSearch({ query: 'TOKEN' }, from(ip)), good: () => searchSaid('TOKEN'), version: v3.CONTRACT_VERSION, fresh: SEARCH_SECONDS, stale: SEARCH_STALE_SECONDS },
    { name: 'chain-tokens', answer: answerChainTokens, contract: CHAIN, request: (ip) => askTokens(tokensAsk, from(ip)), good: () => v6Said(TOKENS_BODY), version: v6.CONTRACT_VERSION, fresh: TOKENS_SECONDS, stale: TOKENS_STALE_SECONDS },
    { name: 'overview', answer: answerOverview, contract: OVERVIEW, request: (ip) => ask(OVERVIEW_PATH, { poolIds: [POOL] }, from(ip)), good: () => said(OVERVIEW_BODY), version: v3.CONTRACT_VERSION, fresh: OVERVIEW_SECONDS, stale: OVERVIEW_STALE_SECONDS },
  ];
  for (const route of routes) {
    const cache = memoryCache(), time = clock(TOKENS_BODY.servedAt * 1000), later = [], refreshing = new Map(), inflight = new Map();
    const plan = [];
    let hold = null;
    const worker = bridge(async () => {
      const status = plan.shift() ?? 200;
      const waiting = hold;
      hold = null;
      if (waiting) await waiting;
      if (status === 200) return route.good();
      return said({ error: status === 429 ? 'read_capacity_busy' : 'upstream_unavailable' }, { status, version: route.version, headers: status === 429 ? { 'Retry-After': '2' } : {} });
    });
    const rt = () => ({ contract: route.contract, cache, now: time.now, refreshing, inflight, waitUntil: (work) => later.push(work), timer: () => () => undefined });
    const run = async (ip) => {
      const response = await route.answer(route.request(ip), worker.env, rt());
      await drain(later);
      return response;
    };
    assert.equal((await run(A)).status, 200, `${route.name}: kept`);
    // Past its stale life, A past its budget: the kept answer stands in for A alone, and nothing guards the key.
    time.at.now += route.stale * 1000;
    plan.push(429);
    const own = await run(A);
    assert.equal(own.status, 200, `${route.name}: A’s own stand-in`);
    assert.equal(own.headers.get('Server-Timing'), 'edge;desc="stale-if-error"');
    assert.equal(refreshing.size, 0, `${route.name}: no guard after a 429`);
    // B, half a second later, reaches the VM and gets its answer, not the kept one.
    time.at.now += 500;
    const next = await run(B);
    assert.equal(next.headers.get('Server-Timing'), 'edge;desc="miss"', `${route.name}: B asked the VM itself`);
    assert.equal(worker.calls.length, 3);
    // Past its stale life again: A leads a read the gateway refuses; B, who joined it, asks the VM itself.
    time.at.now += route.stale * 1000;
    let release;
    hold = new Promise((resolve) => { release = resolve; });
    plan.push(429, 200);
    const leader = route.answer(route.request(A), worker.env, rt());
    while (inflight.size === 0) await new Promise((resolve) => setImmediate(resolve));
    const follower = route.answer(route.request(B), worker.env, rt());
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const [led, followed] = await Promise.all([leader, follower]);
    await drain(later);
    assert.equal(led.headers.get('Server-Timing'), 'edge;desc="stale-if-error"', `${route.name}: A’s own stand-in`);
    assert.equal(followed.headers.get('Server-Timing'), 'edge;desc="miss"', `${route.name}: B’s own read, not A’s stand-in`);
    assert.equal(worker.calls.length, 5);
    assert.equal(refreshing.size, 0);
    // Within its stale window: A's request refreshes it behind and is refused; the guard is lifted, and B's request
    // refreshes it with its own budget.
    time.at.now += route.fresh * 1000;
    plan.push(429, 200);
    const staleA = await run(A);
    assert.equal(staleA.headers.get('Server-Timing'), 'edge;desc="stale"', `${route.name}: served at once`);
    assert.equal(worker.calls.length, 6);
    assert.equal(refreshing.size, 0, `${route.name}: a refused refresh lifts its guard`);
    await run(B);
    assert.equal(worker.calls.length, 7, `${route.name}: B’s request refreshed it`);
    // A 503 is the VM failing: it still guards the key, and B gets the kept answer with no read, as before.
    time.at.now += route.stale * 1000;
    plan.push(503);
    const failing = await run(A);
    assert.equal(failing.headers.get('Server-Timing'), 'edge;desc="stale-if-error"');
    assert.equal(refreshing.size, 1, `${route.name}: a 503 guards the key`);
    const guarded = await run(B);
    assert.equal(guarded.headers.get('Server-Timing'), 'edge;desc="stale-if-error"');
    assert.equal(guarded.headers.get(EDGE_HEADER), 'hit', `${route.name}: no gateway saw it`);
    assert.equal(worker.calls.length, 8, `${route.name}: the failing VM was let alone`);
  }
});

// ---------------------------------------------------------------------------
// The routes' own files, as Pages runs them (review of 2026-11-07, D4)
// ---------------------------------------------------------------------------

test('the three new routes’ own files answer from the edge with the contracts’ real runtimes, bundled as wrangler bundles them', async (t) => {
  const { build } = require('esbuild');
  const root = fileURLToPath(new URL('..', import.meta.url));
  const out = mkdtempSync(join(tmpdir(), 'edge-routes-'));
  const previous = globalThis.caches;
  t.after(() => {
    globalThis.caches = previous;
    rmSync(out, { recursive: true, force: true });
  });
  await build({
    entryPoints: {
      search: join(root, 'functions/api/read/v3/search.ts'),
      'chain-pools': join(root, 'functions/api/read/v6/chain-pools.ts'),
      'chain-tokens': join(root, 'functions/api/read/v6/chain-tokens.ts'),
    },
    bundle: true, format: 'esm', platform: 'neutral', target: 'es2022', outdir: out, outExtension: { '.js': '.mjs' }, logLevel: 'silent',
  });
  const tokensAsk = { chainId: TOKENS_BODY.chainId, query: TOKENS_BODY.query, limit: 20 };
  const routes = [
    ['search', () => askSearch({ query: 'TOKEN' }), () => searchSaid('TOKEN'), () => askSearch({ query: 'token ' })],
    ['chain-pools', () => askPools(), () => v6Said(POOLS_BODY), () => askPools()],
    ['chain-tokens', () => askTokens(tokensAsk), () => v6Said(TOKENS_BODY), () => askTokens({ ...tokensAsk, query: ` ${TOKENS_BODY.query.toUpperCase()}` })],
  ];
  for (const [name, request, answer, other] of routes) {
    const cache = memoryCache();
    globalThis.caches = { default: cache };
    const route = await import(pathToFileURL(join(out, `${name}.mjs`)).href);
    const worker = bridge(() => answer());
    const later = [];
    const context = (made) => ({ request: made, env: worker.env, waitUntil: (work) => later.push(work) });
    const first = await route.onRequest(context(request()));
    assert.equal(first.status, 200, name);
    assert.equal(first.headers.get('Server-Timing'), 'edge;desc="miss"', `${name}: the Worker’s answer`);
    await drain(later);
    assert.equal(cache.puts.length, 1, `${name}: kept in caches.default`);
    const hit = await route.onRequest(context(other()));
    assert.equal(hit.status, 200, name);
    assert.equal(hit.headers.get(EDGE_HEADER), 'hit', `${name}: answered from the edge`);
    const data = await hit.json();
    const version = name === 'search' ? v3 : v6;
    const asked = JSON.parse(await other().text());
    if (name === 'search') assert.equal(v3.validateResponse('search', data) && v3.matchesRequest('search', asked, data), true, `${name}: the real runtime accepts it`);
    else assert.equal(v6.validateResponse(name, data) && v6.validateExchange(name, asked, data), true, `${name}: the real runtime accepts it`);
    assert.equal(hit.headers.get('X-Domino-Read-Contract'), version.CONTRACT_VERSION);
    assert.equal(worker.calls.length, 1, `${name}: one read`);
    // A request the Worker would refuse is its own to refuse, and is not kept.
    const refused = bridge(() => said({ error: 'invalid_request' }, { status: 422, version: version.CONTRACT_VERSION }));
    const bad = await route.onRequest({ request: ask(new URL(request().url).pathname, { nonsense: true }, { version: version.CONTRACT_VERSION }), env: refused.env, waitUntil: (work) => later.push(work) });
    assert.equal(bad.status, 422, `${name}: the Worker’s refusal`);
    await drain(later);
    assert.equal(cache.puts.length, 1, `${name}: nothing more kept`);
  }
});
