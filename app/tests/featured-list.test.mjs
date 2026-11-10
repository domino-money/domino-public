/**
 * The featured pools list (read-v5, featured pools v1 §11; src/lib/read/featuredList.ts), from the answers the
 * producer's own fixtures give (api-contracts/read-v5/fixtures) and the runtime the Worker runs: what the app believes
 * of an answer, which list the page shows (the fallback table, by the server's clock), how a refresh changes it, and
 * how a row is bound to its entry. Added 2026-09-26 with the list; spec §11.9's cases.
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as v1 from '../../api-contracts/read-v1/runtime.mjs';
import * as v2 from '../../api-contracts/read-v2/runtime.mjs';
import * as v3 from '../../api-contracts/read-v3/runtime.mjs';
import * as v5 from '../../api-contracts/read-v5/runtime.mjs';
import { overviewFor } from './markets-cards.fixtures.mjs';

const require = createRequire(import.meta.url);
const built = (name) => require(`../.test-build/app/src/${name}.js`);
const featured = built('lib/read/featuredList');
const { SELECTED_POOLS } = built('config/selectedPools');
const { SELECTED_POOL_CATALOGUE, WALLET_FALLBACK_TOKENS, catalogueTokens, poolListings, referenceToken } = built('config/selectedPoolCatalogue');
const { MAIN_TOKENS, USDG, WETH, NATIVE_ETH, readsAsMainToken } = built('config/mainTokens');
const { isLookAlike } = built('lib/walletHoldings');
const { USDG: PRICED_USDG } = built('lib/walletPrices');
const { STORED_LANE } = built('lib/read/scheduler');
const { createEstimateSource } = built('lib/read/estimateSource');
const { createPublicSource } = built('lib/read/publicSource');
const { createPublicMetadataCache } = built('lib/read/publicMetadataCache');
const { createScheduledSource } = built('lib/read/scheduler');
const { createReadMarketsProvider } = built('lib/read/marketsProvider');
const { realClock } = built('lib/read/pipeline');
const { featuredPoolIds } = built('lib/read/screens/featuredPools');
const journey = built('lib/create/journey');

const FIXTURES = new URL('../../api-contracts/read-v5/fixtures/', import.meta.url);
const read = (path) => JSON.parse(readFileSync(new URL(path, FIXTURES), 'utf8'));
const CURRENT = read('valid/current.json');
const clone = (value) => JSON.parse(JSON.stringify(value));
const id = (hex) => `0x${hex.repeat(64 / hex.length)}`;
const addr = (hex) => `0x${hex.repeat(40 / hex.length)}`;
const listId = (hex) => id(hex);

/** A valid `current` answer holding `pools` (each re-slotted), under `listId`, with any other field changed by `patch`. */
function answer(pools = CURRENT.pools, patch = {}) {
  const body = clone(CURRENT);
  body.pools = clone(pools).map((pool, index) => ({ ...pool, slot: index + 1 }));
  body.withdrawn = body.withdrawn.filter((entry) => !body.pools.some((pool) => pool.poolId === entry.poolId));
  return Object.assign(body, patch);
}
/** A ranked pool of `token` (currency1 when above USDG's address, else currency0) against USDG, under `poolId`. */
function pool(poolId, token, symbol, extra = {}) {
  const base = clone(CURRENT.pools[1]);
  const pair = [{ address: token, decimals: 18, symbol }, { address: USDG, decimals: 6, symbol: 'USDG' }].sort((a, b) => (a.address < b.address ? -1 : 1));
  base.poolId = poolId;
  base.poolKey.currency0 = pair[0].address;
  base.poolKey.currency1 = pair[1].address;
  base.tokens = pair;
  return Object.assign(base, extra);
}
const A = pool(id('a1'), addr('b1'), 'TKNA');
const B = pool(id('b2'), addr('c2'), 'TKNB');
const C = pool(id('c3'), addr('d3'), 'TKNC');
const ok = (body) => ({ route: 'featured-pools', state: 'ok', data: body, provenance: { transport: 'bridge', contract: null, receivedAt: 0, attempts: 1 }, observation: { block: null, providers: [] } });
const answered = (body) => featured.answerOf(ok(body));
const idsOf = (list) => list.entries.map((entry) => entry.poolId);

// --- the validator: the runtime, then the app's own checks ---

test('every valid fixture passes validateFeatured, every invalid one is refused whole', () => {
  for (const name of readdirSync(new URL('valid/', FIXTURES))) assert.ok(featured.validateFeatured(v5, read(`valid/${name}`)), name);
  const invalid = readdirSync(new URL('invalid/', FIXTURES));
  assert.ok(invalid.length >= 50);
  for (const name of invalid) assert.equal(featured.validateFeatured(v5, read(`invalid/${name}`)), null, name);
});

test('§11.9 validator cases: extra key, hooks, 0x800000, fee_pips 1_000_000, repeated ids, unsorted currencies, 13 pools, long, bidi and null symbols, none with pools', () => {
  const refused = (label, change) => {
    const body = answer([A, B]);
    change(body);
    assert.equal(featured.validateFeatured(v5, body), null, label);
  };
  refused('extra key', (body) => { body.extra = 1; });
  refused('hooks', (body) => { body.pools[0].poolKey.hooks = addr('77'); });
  refused('dynamic fee 0x800000', (body) => { body.pools[0].poolKey.fee_pips = 0x800000; body.pools[0].poolKey.feeMode = 'dynamic'; });
  refused('fee_pips 1_000_000', (body) => { body.pools[0].poolKey.fee_pips = 1_000_000; });
  refused('repeated id', (body) => { body.pools[1].poolId = body.pools[0].poolId; });
  refused('currency0 >= currency1', (body) => { const k = body.pools[0].poolKey; [k.currency0, k.currency1] = [k.currency1, k.currency0]; body.pools[0].tokens.reverse(); });
  refused('13 pools', (body) => { body.pools = Array.from({ length: 13 }, (_, i) => ({ ...pool(id(`${(i + 16).toString(16)}`), addr((i + 16).toString(16)), `T${i}`), slot: i + 1 })); });
  refused('long symbol', (body) => { body.pools[0].tokens[1].symbol = 'X'.repeat(33); });
  refused('bidi symbol', (body) => { body.pools[0].tokens[1].symbol = 'AB‮CD'; });
  refused('null symbol', (body) => { body.pools[0].tokens[1].symbol = null; });
  refused('none with pools', (body) => { body.status = 'none'; });
});

// Changed on purpose (2026-09-26, after review): a symbol with the text of a web address used to be accepted and shown
// as its characters. Spec §11.9 lists it among the cases the client refuses, and the selector refuses it
// (backend/featured_pools.py UNSAFE_SYMBOL_TEXT, token_symbol_unsafe): the app now drops that pool too.
test('§11.9: a symbol with the text of a web address or a claim drops its pool, as the selector’s own rule does; the rest of the list stands', () => {
  assert.deepEqual([...featured.UNSAFE_SYMBOL_TEXT], ['.', '/', ':', 'WWW', 'HTTP', 'CLAIM'], 'the selector’s list, backend/featured_pools.py');
  const unsafe = ['https://x.io', 'claim.x.io', 'x.io', 'a/b', 'a:b', 'www', 'Http', 'httpToken', 'CLAIMABLE', 'claim'];
  unsafe.forEach((symbol, index) => {
    const hex = (0xe0 + index).toString(16);
    const listed = pool(id(hex), addr(hex), symbol);
    const valid = featured.validateFeatured(v5, answer([A, listed, B]));
    assert.ok(valid, `${symbol}: the runtime lets it through; the app's own check is the one that refuses`);
    assert.deepEqual(valid.pools.map((p) => p.poolId), [A.poolId, B.poolId], symbol);
    assert.deepEqual(valid.dropped, [{ poolId: listed.poolId, reason: 'unsafe_symbol' }], symbol);
  });
  // Either side of the pair: a first currency's symbol is checked as well.
  const low = pool(id('0e'), addr('01'), 'claim.x.io');
  assert.equal(low.tokens[0].symbol, 'claim.x.io');
  assert.equal(featured.featuredPoolProblem(low), 'unsafe_symbol');
  // A plain symbol, any case, stays.
  for (const symbol of ['PONS', 'wstETH', 'TKN-2', 'A_B']) assert.equal(featured.featuredPoolProblem(pool(id('0f'), addr('0f'), symbol)), null, symbol);
  // Every valid fixture's pools are still kept whole.
  assert.deepEqual(featured.validateFeatured(v5, CURRENT).dropped, []);
});

test('a token that reads as a main token on another contract drops its pool, and the real USDG is not re-pointed', () => {
  const fake = pool(id('f6'), addr('f6'), 'USDG');
  const cyrillic = pool(id('a7'), addr('a7'), 'WЕTH');
  const valid = featured.validateFeatured(v5, answer([A, fake, cyrillic, B]));
  assert.deepEqual(valid.pools.map((p) => p.poolId), [A.poolId, B.poolId]);
  assert.deepEqual(valid.dropped, [{ poolId: fake.poolId, reason: 'look_alike' }, { poolId: cyrillic.poolId, reason: 'look_alike' }]);
  // The main tokens are frozen, and every place that asks what USDG is gets the one address.
  assert.ok(Object.isFrozen(MAIN_TOKENS) && MAIN_TOKENS.every(Object.isFrozen));
  assert.equal(USDG, '0x5fc5360d0400a0fd4f2af552add042d716f1d168');
  assert.equal(PRICED_USDG, USDG);
  // Changed on purpose 2026-10-04 (the owner's new embedded list): the first row labelled USDG is now ETH/USDG, which
  // names no addresses (only a read of its pool says native or wrapped). Every row that names them binds its USDG label
  // to the one address.
  const bound = SELECTED_POOL_CATALOGUE.filter((entry) => entry.addresses && entry.labels.includes('USDG'));
  assert.ok(bound.length > 0);
  for (const entry of bound) assert.equal(entry.addresses[entry.labels.indexOf('USDG')], USDG, entry.poolId);
  assert.equal(readsAsMainToken('USDG', addr('f6')), true);
  assert.equal(readsAsMainToken('USDG', USDG), false);
  assert.equal(readsAsMainToken('ETH', WETH), false, 'ether either way');
  assert.equal(isLookAlike({ token: { address: addr('f6'), symbol: 'USDG' } }), true, 'the wallet card still refuses the fake');
  // The wallet lists fall back to the main tokens and the embedded list's, never a featured list's.
  // Changed on purpose 2026-11-02 (the owner's new embedded list): ETH/TORCH names native ETH by the zero address, which
  // the wallet lists still leave aside (no contract to ask), as below.
  assert.ok(catalogueTokens().some((t) => t.address === NATIVE_ETH), 'ETH/TORCH names native ETH');
  assert.deepEqual([...WALLET_FALLBACK_TOKENS], [WETH, USDG, ...catalogueTokens().map((t) => t.address).filter((a) => a !== WETH && a !== USDG && a !== NATIVE_ETH)]);
  assert.ok(Object.isFrozen(WALLET_FALLBACK_TOKENS));
  assert.equal(WALLET_FALLBACK_TOKENS.includes(NATIVE_ETH), false);
});

test('FEATURED_DENY is empty, and a pool named in it is left out of any list', () => {
  assert.equal(featured.FEATURED_DENY.size, 0);
  featured.FEATURED_DENY.add(B.poolId);
  try {
    const valid = featured.validateFeatured(v5, answer([A, B]));
    assert.deepEqual(valid.dropped, [{ poolId: B.poolId, reason: 'denied' }]);
  } finally {
    featured.FEATURED_DENY.delete(B.poolId);
  }
});

// --- the fallback table, always by the server's clock ---

test('fallback: current and repaired while valid are the server’s list with its title; carried_over, manual and a stale list are neutral; past its limit, none, or no pools left is the embedded list', () => {
  // Changed on purpose 2026-11-02 (rugged's Top pools diagnosis, item 1): the limit is 36 h from the selection's end.
  const SELECTED_AT = CURRENT.window.end;
  const shortValid = SELECTED_AT + 30 * 3600;
  const current = featured.listFrom(answered(answer([A, B])));
  assert.equal(current.source, 'server');
  assert.deepEqual(idsOf(current), [A.poolId, B.poolId]);
  assert.equal(featured.featuredTitle(current.source), 'Top pools · last 24h');
  // Changed on purpose 2026-09-28 (the owner: "Não precisa ter essa descrição"): the method line under the title is
  // gone, and the list carries no text for it.
  assert.equal('method' in current, false, 'no method line');
  assert.equal(featured.listFrom(answered(read('valid/repaired.json'))).source, 'server');
  for (const [label, body] of [
    ['carried_over', answer([A, B], { status: 'carried_over' })],
    ['manual', read('valid/manual.json')],
    ['stale', answer([A, B], { validUntil: shortValid, servedAt: shortValid + 1 })],
    ['stale up to 36 h', answer([A, B], { validUntil: shortValid, servedAt: SELECTED_AT + 36 * 3600 })],
    ['carried_over up to 36 h', answer([A, B], { status: 'carried_over', servedAt: SELECTED_AT + 36 * 3600 })],
    ['manual up to 72 h', { ...read('valid/manual.json'), servedAt: read('valid/manual.json').generatedAt + 72 * 3600 }],
  ]) {
    const list = featured.listFrom(answered(body));
    assert.equal(list.source, 'server_neutral', label);
    assert.equal(featured.featuredTitle(list.source), 'Selected pools', label);
    assert.ok(list.entries.length > 0, label);
  }
  for (const [label, outcome] of [
    ['older than 36 h', answered(answer([A, B], { servedAt: SELECTED_AT + 36 * 3600 + 1 }))],
    // 2 Nov's revision 94: a repair at 15:00 moved generatedAt, and the list still counts from its selection.
    ['repaired later, older than 36 h', answered(answer([A, B], { status: 'carried_over', generatedAt: SELECTED_AT + 3 * 3600, effectiveAt: SELECTED_AT + 3 * 3600, servedAt: SELECTED_AT + 36 * 3600 + 1 }))],
    ['manual, older than 72 h', answered({ ...read('valid/manual.json'), servedAt: read('valid/manual.json').generatedAt + 72 * 3600 + 1 })],
    ['none', answered(read('valid/none.json'))],
    ['none with withdrawn', answered(read('valid/none-with-withdrawn.json'))],
    ['every pool dropped', answered(answer([pool(id('f6'), addr('f6'), 'USDG')]))],
    ['failed', { kind: 'failed' }],
  ]) {
    const list = featured.listFrom(outcome);
    assert.equal(list, featured.BUNDLED_LIST, label);
    assert.deepEqual(idsOf(list), SELECTED_POOLS, `${label}: the embedded six`);
    assert.equal(featured.featuredTitle(list.source), 'Selected pools');
  }
  assert.deepEqual(answered(read('valid/none-with-withdrawn.json')).withdrawn.length, 2, 'none may still carry the week’s removals');
});

// Added 2026-09-26 after review: the service sets effectiveAt to when it served the list (backend/featured_live.py
// `_serve`), so a repair, or a list published late, carries a time that is not the selection's. The fixtures all say
// 12:00 and could not show it.
// Changed on purpose 2026-09-28 (the owner: "Não precisa ter essa descrição"): the method line that printed the
// selection time is gone. What stays is the title: a repair or a late publication keeps "Top pools · last 24h", and a
// current list that does not name its rules takes the neutral title, as it did when the line could not be written.
test('a repair at 17:42 or a list published at 12:07 keeps the criterion title; a current list without its rules takes the neutral one', () => {
  const noon = CURRENT.effectiveAt;
  assert.equal(new Date(noon * 1000).toISOString().slice(11, 16), '12:00', 'the fixtures’ own time');
  for (const [label, body] of [
    ['repaired at 17:42', { ...read('valid/repaired.json'), effectiveAt: noon + 5 * 3600 + 42 * 60, servedAt: noon + 5 * 3600 + 42 * 60 }],
    ['current published at 12:07', { ...clone(CURRENT), effectiveAt: noon + 7 * 60, servedAt: noon + 7 * 60 }],
  ]) {
    assert.ok(featured.validateFeatured(v5, body), `${label}: a valid answer`);
    const list = featured.listFrom(answered(body));
    assert.equal(list.source, 'server', label);
    assert.equal(featured.featuredTitle(list.source), 'Top pools · last 24h', label);
  }
  const unruled = { ...clone(CURRENT), rules: null };
  assert.ok(featured.validateFeatured(v5, unruled), 'rules may be null on the wire');
  assert.equal(featured.listFrom(answered(unruled)).source, 'server_neutral', 'no rules, no criterion title');
  assert.equal('methodLine' in featured, false, 'nothing writes a method line');
});

/** The app's composition, over a fake fetch: the featured route beside the stored and legacy namespaces. */
function composed(reply, { clock } = {}) {
  const calls = [];
  const fetch = async (path, init) => {
    calls.push({ path, method: init.method, body: init.body ?? null, contract: init.headers?.['X-Domino-Read-Contract'] });
    if (path === '/api/read/v5/featured-pools') return reply(init);
    throw new Error(`unexpected read: ${path}`);
  };
  const options = { enabled: true, validators: v1, fetch, clock };
  const inner = featured.createFeaturedReadSource(createPublicSource(createEstimateSource(options, v2), options, v3), options, v5);
  const source = createPublicMetadataCache(createScheduledSource(inner, { minIntervalMs: 0, budget: null, clock }), clock);
  return { source, calls };
}
const json = (status, body, contract = v5.CONTRACT_VERSION) =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...(contract ? { 'X-Domino-Read-Contract': contract } : {}) } });

test('the list is one POST of {} to read-v5 with its contract header, first in the queue, on the stored lane, and no capabilities GET', async () => {
  const { source, calls } = composed(() => json(200, answer([A, B])));
  const outcome = await featured.readFeaturedList(source);
  assert.equal(outcome.state, 'ok');
  assert.deepEqual(calls, [{ path: '/api/read/v5/featured-pools', method: 'POST', body: '{}', contract: '1.0.0-rc.2' }]);
  assert.equal(STORED_LANE.has('featured-pools'), true);
  const asked = [];
  await featured.readFeaturedList({ transport: 'bridge', read: async (route, request, options) => (asked.push({ route, request, options }), { state: 'aborted' }) }, { clock: { monotonic: () => 1000 } });
  assert.deepEqual(asked, [{ route: 'featured-pools', request: {}, options: { priority: 'first', signal: undefined, deadlineAt: 2500 } }]);
});

// Added 2026-09-28 (speed wave, item 10): the deployable page sends its first list read before the app starts
// (public/early-list.js until 2026-10-01; since then the page's inline boot script, functions/_lib/boot.ts, in every
// build but sending only where the build's table says `early`, vite.config.ts boot); the app's first attempt takes
// that reply, through the same checks, instead of sending another. A reply that fails to arrive sends the attempt.
test('the first reads take the replies the page sent before the app started, once each, through the same checks', async () => {
  const { takeEarly, EARLY_LIST_MS } = built('lib/read/earlyList');
  const calls = [];
  const fetch = async (path, init) => {
    calls.push([path, init.method]);
    return path === '/api/read/v3/capabilities' ? json(200, JSON.parse(readFileSync(new URL('../../api-contracts/read-v3/fixtures/capabilities.json', import.meta.url), 'utf8')), v3.CONTRACT_VERSION) : json(200, answer([A, B]));
  };
  const early = new Map();
  const options = { enabled: true, validators: v1, fetch, first: (path, method) => { const key = `${method} ${path}`; const reply = early.get(key) ?? null; early.delete(key); return reply; } };
  const inner = featured.createFeaturedReadSource(createPublicSource(createEstimateSource(options, v2), options, v3), options, v5);
  const source = createScheduledSource(inner, { minIntervalMs: 0, budget: null });
  early.set('POST /api/read/v5/featured-pools', Promise.resolve(json(200, answer([A, B]))));
  early.set('GET /api/read/v3/capabilities', Promise.resolve(json(200, JSON.parse(readFileSync(new URL('../../api-contracts/read-v3/fixtures/capabilities.json', import.meta.url), 'utf8')), v3.CONTRACT_VERSION)));
  const taken = await featured.readFeaturedList(source);
  assert.deepEqual([taken.state, calls.length], ['ok', 0], 'the early reply, and no request of its own');
  assert.deepEqual([(await source.routeEnabled('overview')).state, calls.length], ['enabled', 0], 'the capabilities, from the early reply too');
  early.set('POST /api/read/v5/featured-pools', Promise.resolve(json(200, { schemaVersion: 1 })));
  const refused = await featured.readFeaturedList(source);
  assert.deepEqual([refused.state, refused.reason, calls.length], ['invalid', 'response_contract', 0], 'checked as any reply is');
  early.set('POST /api/read/v5/featured-pools', Promise.reject(new TypeError('offline')));
  const sent = await featured.readFeaturedList(source);
  assert.deepEqual([sent.state, calls], ['ok', [['/api/read/v5/featured-pools', 'POST']]], 'one that never arrived: the attempt is sent');
  const after = await featured.readFeaturedList(source);
  assert.deepEqual([after.state, calls.length], ['ok', 2], 'no early reply left: sent');

  // The slot: each reply taken once; the first ask leaves the slot taken, so the page's script sends nothing after it.
  const reply = Promise.resolve(new Response('{}'));
  globalThis.__dominoEarly = { at: performance.now(), replies: { 'POST /api/read/v5/featured-pools': reply } };
  assert.equal(takeEarly('/api/read/v3/capabilities', 'GET'), null, 'nothing sent for it');
  assert.equal(takeEarly('/api/read/v5/featured-pools', 'POST'), reply);
  assert.equal(takeEarly('/api/read/v5/featured-pools', 'POST'), null, 'once');
  globalThis.__dominoEarly = { at: performance.now() - EARLY_LIST_MS, replies: { 'POST /api/read/v5/featured-pools': reply } };
  assert.equal(takeEarly('/api/read/v5/featured-pools', 'POST'), null, 'too old: let go');
  delete globalThis.__dominoEarly;
  assert.equal(takeEarly('/api/read/v5/featured-pools', 'POST'), null);
  assert.deepEqual(globalThis.__dominoEarly, { at: -Infinity, replies: {} }, 'nothing sent: the slot is taken all the same');
  delete globalThis.__dominoEarly;

  // The page's script: the two same-origin requests the app itself sends first, on Home and Markets only, once.
  // Changed on purpose 2026-10-01 (platform workstream, F1/F3): inline in the page (functions/_lib/boot.ts), reading
  // the route table the build writes beside it; it also asks for the route's code (tests/platform.test.mjs).
  const { BOOT_SCRIPT: script, MARKETS_COPY_KEY } = require('../.test-build/app/functions/_lib/boot.js');
  const { ROUTES } = built('routeTable');
  // 2026-10-01 (the chain2 workstream, part B, audit G10): the copy's key names its chain, and the script reads exactly
  // the key the app keeps the copy under.
  const { PAINT_KEY } = built('lib/read/marketsPaint');
  assert.equal(PAINT_KEY, 'domino-markets-v2:4663');
  assert.equal(MARKETS_COPY_KEY, PAINT_KEY);
  assert.ok(script.includes(`localStorage.getItem('${PAINT_KEY}')`), 'the script reads that key');
  assert.equal([...script.matchAll(/\bfetch\s*\(/g)].length, 1, 'one call');
  assert.match(script, /var reply = fetch\(path, \{\n\s*method: method,\n\s*headers: body === undefined \? \{ Accept: 'application\/json' \} : \{ 'Content-Type': 'application\/json', Accept: 'application\/json' \},\n\s*body: body,\n\s*mode: 'same-origin',\n\s*credentials: 'same-origin',\n\s*redirect: 'manual',\n\s*cache: 'no-store',\n\s*referrerPolicy: 'same-origin',\n\s*\}\)/);
  // Changed on purpose 2026-10-01 (audit A7 b, the owner's OK): the stored overview of the list's pools too, the moment
  // the list answers, on a first visit (no copy of the last overview kept in this browser, which it only reads). Inline
  // in the boot script since the platform merge (functions/_lib/boot.ts), with the same steps public/early-list.js had.
  assert.deepEqual([...script.matchAll(/['"`](https?:\/\/[^'"`]*|\/[a-z][^'"`]*)['"`]/g)].map((match) => match[1]), ['/api/read/v5/featured-pools', '/api/read/v3/capabilities', '/api/read/v3/overview'], 'no other address');
  assert.doesNotMatch(script, /\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon|sessionStorage|indexedDB|document\.cookie|eval)\b/);
  assert.deepEqual([...script.matchAll(/localStorage\.(\w+)/g)].map((match) => match[1]), ['getItem'], 'the copy is only read');
  assert.match(script, /if \(data\.early !== true \|\| window\.__dominoEarly !== undefined\) return/, 'nothing once the app has read, nor in a build that reads no live list');
  assert.match(script, /if \(page !== 'overview' && \(page !== 'markets' \|\| second\)\) return/, 'Home and Markets only');
  // Changed on purpose 2026-11-07 (pages of their own, src/lib/route.ts): the script reads the address's path, or a link
  // from before (`/#/markets`) as it is; `route` is either, as the address bar shows it.
  const at = (route) => (route === '' || route.startsWith('#') ? { pathname: '/', hash: route } : { pathname: route.split('#')[0], hash: route.includes('#') ? route.slice(route.indexOf('#')) : '' });
  const run = (route, slot, early = true) => {
    const sent = [];
    const data = { early, pages: ROUTES, chunks: {} };
    const document = { getElementById: (id) => (id === 'dm-boot' ? { textContent: JSON.stringify(data) } : null), createElement: () => ({ setAttribute() {} }), head: { appendChild() {} } };
    const context = { location: at(route), performance, window: slot === undefined ? {} : { __dominoEarly: slot }, fetch: (path, init) => (sent.push([init.method, path, init.body ?? null]), new Promise(() => {})) };
    new Function('window', 'document', 'location', 'performance', 'fetch', script)(context.window, document, context.location, context.performance, context.fetch);
    return [sent, Object.keys(context.window.__dominoEarly?.replies ?? {})];
  };
  const both = [[['POST', '/api/read/v5/featured-pools', '{}'], ['GET', '/api/read/v3/capabilities', null]], ['POST /api/read/v5/featured-pools', 'GET /api/read/v3/capabilities']];
  assert.deepEqual(['', '#/', '#/#pools', '#/markets', '#/pools'].map((hash) => run(hash)), Array(5).fill(both));
  assert.deepEqual(['/', '/#pools', '/markets', '/pools', '/markets#top'].map((path) => run(path)), Array(5).fill(both));
  assert.deepEqual(['#/pool/0xab', '#/positions', '#/new', '#/docs'].map((hash) => run(hash)), Array(4).fill([[], []]));
  assert.deepEqual(['/pool/0xab', '/positions', '/new', '/docs', '/docs#x'].map((path) => run(path)), Array(5).fill([[], []]));
  // A token's own view shows no list (src/components/explore/routes.ts), and since 2026-10-01 Markets with anything else
  // after it is not found (src/App.tsx parseHash): nothing is sent there.
  assert.deepEqual([`#/markets/0x${'1'.repeat(40)}`, `#/pools/0x${'aB'.repeat(20)}#x`, '#/explore/0xab', '#/nope', `/markets/0x${'1'.repeat(40)}`, '/nope'].map((hash) => run(hash)), Array(6).fill([[], []]));
  assert.deepEqual(run('#/', { at: -Infinity, replies: {} }), [[], []], 'the app read first');
  assert.deepEqual(run('#/', undefined, false), [[], []], 'a build that reads no live list sends nothing');

  // The overview after the list (A7 b): the list's pools in its order, lowercase, under the very question; none for an
  // answer with no pools, a refusal, or a visitor with a copy of the last overview. Changed 2026-10-01 (release.browser
  // (r) to (t)): only where the read-v3 capabilities list the overview, as the app asks it, and read through a copy at
  // once, so an answer the app never takes does not stay open in the browser.
  const CAPABILITIES_V3 = readFileSync(new URL('../../api-contracts/read-v3/fixtures/capabilities.json', import.meta.url), 'utf8');
  const listed = async (status, body, kept = null, capabilities = { status: 200, body: CAPABILITIES_V3 }, overview = () => new Promise(() => {})) => {
    const sent = [];
    const window = {};
    // Changed on purpose 2026-10-01 (the chain2 workstream, part B, G10): the copy's key names its chain, and the script
    // reads the very key the app keeps it under.
    const storage = { getItem: (key) => (key === PAINT_KEY ? kept : null) };
    const fetch = (path, init) => {
      sent.push([init.method, path, init.body ?? null]);
      if (path === '/api/read/v5/featured-pools') return Promise.resolve(new Response(JSON.stringify(body), { status }));
      if (path === '/api/read/v3/capabilities' && capabilities !== null) return Promise.resolve(new Response(capabilities.body, { status: capabilities.status }));
      return path === '/api/read/v3/overview' ? overview() : new Promise(() => {});
    };
    const document = { getElementById: (id) => (id === 'dm-boot' ? { textContent: JSON.stringify({ early: true, pages: ROUTES, chunks: {} }) } : null), createElement: () => ({ setAttribute() {} }), head: { appendChild() {} } };
    new Function('window', 'document', 'location', 'performance', 'fetch', 'localStorage', script)(window, document, { pathname: '/', hash: '' }, performance, fetch, storage);
    await new Promise((resolve) => setTimeout(resolve, 10));
    return [sent.slice(2), Object.keys(window.__dominoEarly.replies).slice(2), window.__dominoEarly.replies];
  };
  const question = JSON.stringify({ poolIds: [A.poolId.toLowerCase(), B.poolId.toLowerCase()] });
  const two = { pools: [{ poolId: A.poolId.toUpperCase().replace('0X', '0x') }, { poolId: B.poolId }] };
  assert.deepEqual((await listed(200, two)).slice(0, 2), [[['POST', '/api/read/v3/overview', question]], [`POST /api/read/v3/overview ${question}`]]);
  assert.deepEqual((await listed(200, { pools: [] })).slice(0, 2), [[], []], 'none for a list with no pools');
  assert.deepEqual((await listed(503, { error: 'upstream_unavailable' })).slice(0, 2), [[], []], 'none for a refusal');
  assert.deepEqual((await listed(200, { pools: [{ poolId: A.poolId }] }, JSON.stringify({ receivedAt: Date.now() - 60_000 }))).slice(0, 2), [[], []], 'none with a copy: the app reads beside the list');
  assert.deepEqual((await listed(200, { pools: [{ poolId: 'javascript:' }] })).slice(0, 2), [[], []], 'never a pool id that is not one');
  const caps = (patch) => ({ status: 200, body: JSON.stringify({ ...JSON.parse(CAPABILITIES_V3), ...patch }) });
  assert.deepEqual((await listed(200, two, null, caps({ enabledReads: ['history', 'search'] }))).slice(0, 2), [[], []], 'none where the capabilities do not list the overview');
  assert.deepEqual((await listed(200, two, null, caps({ dataMode: 'disabled' }))).slice(0, 2), [[], []], 'none where the read-v3 data is switched off');
  assert.deepEqual((await listed(200, two, null, { status: 503, body: '{"error":"upstream_unavailable"}' })).slice(0, 2), [[], []], 'none for a capabilities refusal');
  assert.deepEqual((await listed(200, two, null, null)).slice(0, 2), [[], []], 'none while the capabilities have not answered');
  // The overview's answer is read through to its end at once (a body in three parts, pulled only when read), and stays
  // whole for the app.
  let ended = false;
  const parts = ['{"pools":', '[],', '"tokens":[]}'];
  const streamed = () => {
    let at = 0;
    const body = new ReadableStream({ pull(controller) { if (at < parts.length) controller.enqueue(new TextEncoder().encode(parts[at++])); else { ended = true; controller.close(); } } }, { highWaterMark: 0 });
    return Promise.resolve(new Response(body, { status: 200 }));
  };
  const drained = await listed(200, two, null, undefined, streamed);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(ended, true, 'read to its end through a copy, whether or not the app takes it');
  assert.equal(await (await drained[2][`POST /api/read/v3/overview ${question}`]).text(), parts.join(''), 'the answer the app takes is whole');
  // The app takes it only for that very question.
  const earlyOverview = Promise.resolve(new Response("{}"));
  globalThis.__dominoEarly = { at: performance.now(), replies: { [`POST /api/read/v3/overview ${question}`]: earlyOverview } };
  assert.equal(takeEarly('/api/read/v3/overview', 'POST', JSON.stringify({ poolIds: [A.poolId.toLowerCase()] })), null, 'another question');
  assert.equal(takeEarly('/api/read/v3/overview', 'POST', question), earlyOverview);
  // Added 2026-10-31 (QA round 2 follow-ups, N41): the script asks the overview only once the list and the capabilities have
  // answered, so it is kept for the app's own first ask with that very body for EARLY_OVERVIEW_MS; the list's reply, and
  // anything under a bare key, are still let go after EARLY_LIST_MS. The app used to drop it and send the same question.
  const { EARLY_OVERVIEW_MS } = built('lib/read/earlyList');
  assert.equal(EARLY_OVERVIEW_MS, 30_000);
  const slow = Promise.resolve(new Response('{}'));
  globalThis.__dominoEarly = { at: performance.now() - EARLY_LIST_MS - 1, replies: { [`POST /api/read/v3/overview ${question}`]: slow, 'POST /api/read/v5/featured-pools': reply } };
  assert.equal(takeEarly('/api/read/v5/featured-pools', 'POST'), null, 'the list past 5 s: let go');
  assert.equal(takeEarly('/api/read/v3/overview', 'POST', question), slow, 'the overview past 5 s: taken');
  globalThis.__dominoEarly = { at: performance.now() - EARLY_OVERVIEW_MS, replies: { [`POST /api/read/v3/overview ${question}`]: slow } };
  assert.equal(takeEarly('/api/read/v3/overview', 'POST', question), null, 'the overview past 30 s: let go');
  globalThis.__dominoEarly = { at: performance.now() - EARLY_LIST_MS - 1, replies: { 'POST /api/read/v3/overview': slow } };
  assert.equal(takeEarly('/api/read/v3/overview', 'POST', question), null, 'a reply under the bare key keeps the 5 s limit');
  delete globalThis.__dominoEarly;
});

test('fallback on the wire: route_not_available, no forwarder, a 5xx, invalid JSON, another contract and a timeout all give the embedded list', async () => {
  const cases = [
    ['route_not_available', () => json(404, { error: 'route_not_available' }), 'off'],
    ['the forwarder has no v5 family', () => json(404, '{"error":"not_found"}', null), 'off'],
    ['no forwarder at all', () => new Response('<!doctype html>', { status: 200, headers: { 'Content-Type': 'text/html' } }), 'off'],
    ['5xx', () => json(503, { error: 'upstream_unavailable' }), 'failed'],
    ['502 a stored list the producer refuses', () => json(502, { error: 'upstream_contract_mismatch' }), 'failed'],
    ['invalid JSON', () => json(200, '{"schemaVersion":'), 'failed'],
    ['an invalid answer', () => json(200, read('invalid/hooked-pool.json')), 'failed'],
    ['another contract', () => json(200, answer([A]), '1.1.0-rc.3'), 'failed'],
    ['a read-v5 version the app does not take', () => json(200, answer([A]), '1.0.0-rc.3'), 'failed'],
  ];
  for (const [label, reply, kind] of cases) {
    const { source } = composed(reply);
    const answer_ = featured.answerOf(await featured.readFeaturedList(source));
    assert.equal(answer_.kind, kind, label);
    assert.equal(featured.listFrom(answer_), featured.BUNDLED_LIST, label);
  }
  const started = Date.now();
  const { source } = composed(() => new Promise(() => {}));
  const late = await featured.readFeaturedList(source);
  const took = Date.now() - started;
  assert.equal(late.state, 'unavailable');
  assert.equal(late.cause.kind, 'read_deadline');
  assert.ok(took >= 1400 && took < 4000, `the 1.5 s deadline (${took} ms)`);
  assert.equal(featured.listFrom(featured.answerOf(late)), featured.BUNDLED_LIST);
});

// Added 2026-09-26 after review: the list's POST spent one read of the tab's gateway budget, though the gateway never
// sees it (the forwarder's or the Worker's 404 while it is off, the edge cache once on, §10.6). Every Markets card's
// history read went one budget slot later: the last at 6.5 s instead of 4.5 s.
// Changed on purpose 2026-09-28 (speed wave, item 4): the list costs nothing only when the edge cache answered it
// (the Pages Function's X-Domino-Edge-Cache: hit, provenance `edge`). A miss does reach the gateway, which counts it:
// it drew two refusals on Markets opened directly. So the list takes a read as it starts and gives it back on a hit;
// it still never waits for the budget. Nor does a list the read Worker refused, its route switched off there (UNCOUNTED,
// with the answers the beta gate, Cloudflare Access or a missing Worker make): the gateway never saw those either.
test('the list costs the tab’s gateway budget nothing when the edge answers it: Markets’ overview and six card histories start when they did before it; a miss is counted', async () => {
  const { EDGE_ANSWERED, EDGE_CACHED, UNCOUNTED } = built('lib/read/scheduler');
  assert.deepEqual([...EDGE_ANSWERED], ['featured-pools']);
  assert.ok(EDGE_CACHED.has('featured-pools'));
  assert.deepEqual([...UNCOUNTED].sort(), ['access_required', 'gate_required', 'gate_unavailable', 'not_connected']);
  const run = async (hit) => {
    let steady = 0;
    const clock = { now: () => steady, monotonic: () => steady, random: () => 0, timer: () => () => {},
      sleep: async (ms, signal) => { if (signal?.aborted) throw signal.reason; steady += ms; } };
    const starts = [];
    const source = { transport: 'bridge', read: async (route, request, opts = {}) => {
      starts.push([route, clock.monotonic()]);
      opts.onAttempt?.();
      if (route === 'featured-pools' && typeof hit === 'object') return { route, provenance: {}, ...hit };
      return { route, state: 'ok', data: {}, provenance: route === 'featured-pools' && hit ? { edge: true } : {} };
    } };
    const queue = createScheduledSource(source, { clock, unspacedStored: true });
    const history = (i) => ({ poolId: id((i + 1).toString(16).padStart(2, '0')), currency: NATIVE_ETH, windowSeconds: 86400, resolutionSeconds: 3600 });
    await featured.readFeaturedList(queue, { clock });
    await queue.read('overview', { poolIds: SELECTED_POOLS });
    for (let i = 0; i < 6; i++) await queue.read('history', history(i));
    return { starts, queue, history, clock };
  };
  const { starts, queue, history, clock } = await run(true);
  assert.deepEqual(starts, [['featured-pools', 0], ['overview', 0], ...[0, 0, 0, 500, 2500, 4500].map((at) => ['history', at])],
    'the same starts as with no list read (read-public.test.mjs: 0, 0, 0, 0, 500, 2500, 4500)');
  // A list read never waits for the budget: asked with too little left for a gateway read, it goes at once.
  const late = starts.length;
  await featured.readFeaturedList(queue, { clock });
  assert.deepEqual(starts.slice(late), [['featured-pools', 4500]]);
  await queue.read('history', history(6));
  assert.deepEqual(starts.at(-1), ['history', 6500], 'the next gateway read keeps the budget’s own pace');
  // A miss is a gateway read: the cards go one budget slot later.
  const missed = await run(false);
  assert.deepEqual(missed.starts.slice(2).map(([, at]) => at), [0, 0, 500, 2500, 4500, 6500]);
  // Refused in front of the gateway: as a hit.
  for (const answer of [{ state: 'disabled', reason: 'route_not_enabled' }, { state: 'not_connected', reason: 'no_forwarder' }, { state: 'gate_required' }]) {
    assert.deepEqual((await run(answer)).starts.slice(2).map(([, at]) => at), [0, 0, 0, 500, 2500, 4500], answer.state);
  }
  // Another failure may have reached the gateway: counted.
  assert.deepEqual((await run({ state: 'unavailable', cause: { kind: 'producer', code: 'upstream_unavailable', status: 503 }, retryable: true })).starts.slice(2).map(([, at]) => at), [0, 0, 500, 2500, 4500, 6500]);
});

// Added 2026-09-28 after review (speed wave, item 4): the Pages Function's header, through the real bridge source and
// the queue, is what gives the read back. Nothing tested the header all the way: losing it would have spent a read of
// the budget on every edge hit, silently.
test('an answer with X-Domino-Edge-Cache: hit, through the bridge source and the queue, is marked edge and gives its read back; without it the read is kept', async () => {
  const { GATEWAY_BUDGET } = built('lib/read/scheduler');
  const { EDGE_CACHE_HEADER } = built('lib/read/bridgeSource');
  assert.equal(EDGE_CACHE_HEADER, 'X-Domino-Edge-Cache');
  const run = async (headers) => {
    const clock = { now: () => 1_000, monotonic: () => 0, random: () => 0, timer: () => () => {}, sleep: async () => {} };
    let kept = null;
    const store = { load: () => kept, save: (state) => { kept = state; } };
    const fetch = async (path) => {
      assert.equal(path, '/api/read/v5/featured-pools');
      const reply = json(200, answer([A, B]));
      for (const [name, value] of Object.entries(headers)) reply.headers.set(name, value);
      return reply;
    };
    const options = { enabled: true, validators: v1, fetch, clock };
    const inner = featured.createFeaturedReadSource(createPublicSource(createEstimateSource(options, v2), options, v3), options, v5);
    const queue = createScheduledSource(inner, { clock, budgetStore: store, minIntervalMs: 0, refusedIntervalMs: 1100, unspacedStored: true, width: 2 });
    const outcome = await featured.readFeaturedList(queue, { clock });
    return { state: outcome.state, edge: outcome.provenance.edge ?? null, kept };
  };
  assert.deepEqual(await run({ 'X-Domino-Edge-Cache': 'hit' }), { state: 'ok', edge: true, kept: { tokens: GATEWAY_BUDGET.burst, at: 1_000 } }, 'the edge answered: the budget whole');
  assert.deepEqual(await run({}), { state: 'ok', edge: null, kept: { tokens: GATEWAY_BUDGET.burst - 1, at: 1_000 } }, 'the Worker answered: one read spent');
  assert.deepEqual((await run({ 'X-Domino-Edge-Cache': 'miss' })).kept.tokens, GATEWAY_BUDGET.burst - 1, 'only `hit` is the edge');
});

// --- refresh: every accepted publication and its figures reach the open page ---

/** A clock whose monotonic time only a test moves. */
function steadyClock() {
  let at = 0;
  return { monotonic: () => at, now: () => at, random: () => 0, advance: (ms) => { at += ms; }, timer: () => () => {}, sleep: async () => {} };
}
/** A store over a script of answers; each read takes the next one, the last repeating. */
function scripted(...answers) {
  const clock = steadyClock();
  let at = 0;
  const reads = [];
  const store = featured.createFeaturedStore({ clock, read: async () => { reads.push(at); const next = answers[Math.min(at, answers.length - 1)]; at += 1; return typeof next === 'function' ? next() : next; } });
  return { store, clock, reads };
}

test('refresh: an identical publication changes nothing; intra-day order, admissions and removals apply at once, and a failure keeps the list', async () => {
  const first = answered(answer([A, B, C], { listId: listId('01') }));
  const reordered = answered(answer([C, A, B], { listId: listId('02') }));
  const entered = answered(answer([A, B, C, pool(id('d4'), addr('d4'), 'TKND')], { listId: listId('03') }));
  const removed = answered(answer([A, C], { listId: listId('04'), status: 'repaired' }));
  const { store } = scripted(first, first, reordered, entered, { kind: 'failed' }, removed);
  const seen = [];
  store.subscribe(() => seen.push(idsOf(store.getSnapshot())));
  await store.ensure();
  assert.deepEqual(idsOf(store.getSnapshot()), [A.poolId, B.poolId, C.poolId]);
  assert.equal(store.getSnapshot().settled, true);
  await store.refresh();
  assert.equal(seen.length, 1, 'the same publication and content: nothing changed');
  await store.refresh();
  assert.deepEqual(idsOf(store.getSnapshot()), [C.poolId, A.poolId, B.poolId], 'the intra-day order reaches the same open page');
  await store.refresh();
  assert.deepEqual(idsOf(store.getSnapshot()), [A.poolId, B.poolId, C.poolId, id('d4')], 'a newly admitted pool appears on the same refresh');
  await store.refresh();
  assert.deepEqual(idsOf(store.getSnapshot()), [A.poolId, B.poolId, C.poolId, id('d4')], 'a failure keeps the list');
  await store.refresh();
  assert.deepEqual(idsOf(store.getSnapshot()), [A.poolId, C.poolId], 'the removal at once, on the refresh that saw it');
  assert.equal(store.getSnapshot().source, 'server');
});

/** Another valid daily publication; listId deliberately stays the same unless its ordered identities change. */
function nextDay(pools, patch = {}) {
  const day = 24 * 3600;
  return answer(pools.map((entry) => ({ ...entry, ...(entry.rankInputs ? { rankInputs: { ...entry.rankInputs, evaluatedAt: entry.rankInputs.evaluatedAt + day } } : {}) })), {
    revision: CURRENT.revision + 1,
    selectionDate: new Date((CURRENT.effectiveAt + day) * 1000).toISOString().slice(0, 10),
    generatedAt: CURRENT.generatedAt + day,
    effectiveAt: CURRENT.effectiveAt + day,
    validUntil: CURRENT.validUntil + day,
    servedAt: CURRENT.servedAt + day,
    window: { start: CURRENT.window.start + day, end: CURRENT.window.end + day },
    ...patch,
  });
}

test('the same listId refreshes publication and selection figures, and notifies only when displayed content changes', async () => {
  const first = answer([A, B]);
  const changed = clone(A);
  changed.rankInputs = { ...changed.rankInputs, rankApr: '72', freshApr: '72', reportedLiquidityUsd: '654321', volume24hUsd: '3456789', evaluatedAt: changed.rankInputs.evaluatedAt + 60 };
  const revised = answer([changed, B], { revision: first.revision + 1, effectiveAt: first.effectiveAt + 60, servedAt: first.servedAt + 60 });
  const tomorrow = nextDay([changed, B], { revision: revised.revision + 1 });
  const same = { ...clone(tomorrow), servedAt: tomorrow.servedAt + 60 };
  const relabelled = clone(same);
  relabelled.pools[0].tokens.find((token) => token.symbol === 'TKNA').symbol = 'TKNA2';
  for (const body of [first, revised, tomorrow, same, relabelled]) assert.ok(featured.validateFeatured(v5, body), 'a valid publication');
  assert.equal(first.listId, tomorrow.listId, 'pool identities and order stayed the same across days');
  const { store } = scripted(...[first, revised, tomorrow, same, relabelled].map(answered));
  const seen = [];
  store.subscribe(() => seen.push(store.getSnapshot()));
  const original = await store.ensure();
  await store.refresh();
  let current = store.getSnapshot();
  assert.deepEqual([current.revision, current.selectionDate, current.effectiveAt], [revised.revision, revised.selectionDate, revised.effectiveAt]);
  assert.deepEqual(current.entries[0].selection, { tvlUsd: '654321', volume24hUsd: '3456789', apr: '72', evaluatedAt: changed.rankInputs.evaluatedAt });
  assert.equal(current.entries[0].rankApr, '72');
  assert.notEqual(original.entries[0].selection.evaluatedAt, current.entries[0].selection.evaluatedAt, 'the prior snapshot remains unchanged');
  await store.refresh();
  current = store.getSnapshot();
  assert.deepEqual([current.revision, current.selectionDate, current.effectiveAt], [tomorrow.revision, tomorrow.selectionDate, tomorrow.effectiveAt]);
  assert.equal(current.entries[0].selection.evaluatedAt, tomorrow.pools[0].rankInputs.evaluatedAt, 'today’s fallback figures reach the open page');
  assert.equal(seen.length, 3);
  await store.refresh();
  assert.equal(store.getSnapshot(), current, 'a later servedAt alone does not replace the snapshot');
  assert.equal(seen.length, 3, 'an identical publication does not notify');
  await store.refresh();
  assert.ok(store.getSnapshot().entries[0].labels.includes('TKNA2'), 'entry content is compared even under the same revision');
  assert.equal(seen.length, 4);
});

test('a new selection day adopts the complete ranking immediately, including survivors when another pool enters', async () => {
  const D = pool(id('d4'), addr('d4'), 'TKND');
  for (const pools of [[C, A, B], [D, C, A]]) {
    const daily = nextDay(pools, { listId: listId('02') });
    assert.ok(featured.validateFeatured(v5, daily));
    const { store } = scripted(answered(answer([A, B, C], { listId: listId('01') })), answered(daily), answered(daily));
    await store.ensure();
    await store.refresh();
    assert.deepEqual(idsOf(store.getSnapshot()), pools.map((entry) => entry.poolId), 'server order without remount or thirty-minute wait');
    await store.refresh();
    assert.deepEqual(idsOf(store.getSnapshot()), pools.map((entry) => entry.poolId), 'same-ID refresh keeps the adopted daily ranking');
  }
  const today = answer([D, C, A], { listId: listId('02'), status: 'repaired' });
  const tomorrow = nextDay([D, C, A], { listId: today.listId });
  const { store } = scripted(answered(answer([A, B, C], { listId: listId('01') })), answered(today), answered(tomorrow));
  await store.ensure();
  await store.refresh();
  assert.deepEqual(idsOf(store.getSnapshot()), [D.poolId, C.poolId, A.poolId], 'today’s intra-day repair adopts the full server order');
  await store.refresh();
  assert.equal(store.getSnapshot().listId, today.listId, 'the daily publication may have exactly the same listId');
  assert.deepEqual(idsOf(store.getSnapshot()), [D.poolId, C.poolId, A.poolId], 'that ID cannot keep survivors in the previous day’s order');
});

test('intra-day admissions adopt server order immediately and retain it through metadata refreshes and remounts', async () => {
  const D = pool(id('d4'), addr('d4'), 'TKND');
  const replacement = answer([D, C, A], { listId: listId('02'), revision: CURRENT.revision + 1, status: 'repaired' });
  const updated = clone(replacement);
  updated.pools[1].rankInputs.freshApr = '81';
  updated.pools[1].rankInputs.rankApr = '81';
  const { store } = scripted(answered(answer([A, B, C], { listId: listId('01') })), answered(replacement), answered(updated), answered(updated));
  await store.ensure();
  await store.refresh();
  assert.deepEqual(idsOf(store.getSnapshot()), [D.poolId, C.poolId, A.poolId], 'the withdrawal, admission and order take effect together');
  await store.refresh();
  assert.equal(store.getSnapshot().entries[1].selection.apr, '81', 'survivors receive new metadata in the authoritative order');
  store.remount();
  assert.deepEqual(idsOf(store.getSnapshot()), [D.poolId, C.poolId, A.poolId], 'no remount or delay is needed');
  assert.equal(store.getSnapshot().entries[1].selection.apr, '81', 'remount does not restore the older metadata');
  await store.refresh();
  assert.deepEqual(idsOf(store.getSnapshot()), [D.poolId, C.poolId, A.poolId]);
});

test('same-publication metadata updates cannot readmit a pool whose own read did not bind', async () => {
  const body = answer([A, B, C]);
  const updated = clone(body);
  updated.pools[0].rankInputs.freshApr = '82';
  const { store } = scripted(answered(body), answered(updated));
  await store.ensure();
  store.unbind([B.poolId]);
  await store.refresh();
  assert.deepEqual(idsOf(store.getSnapshot()), [A.poolId, C.poolId]);
  assert.equal(store.getSnapshot().entries[0].selection.apr, '82');
});

test('a repaired order cannot readmit an unbound identity; a corrected pool key may be checked afresh', async () => {
  const first = answer([A, B, C]);
  const reordered = answer([C, B, A], { listId: listId('02'), revision: first.revision + 1 });
  const corrected = clone(reordered);
  corrected.revision += 1;
  corrected.pools[1].poolKey.fee_pips += 1;
  const { store } = scripted(...[first, reordered, corrected].map(answered));
  await store.ensure();
  store.unbind([B.poolId]);
  await store.refresh();
  assert.deepEqual(idsOf(store.getSnapshot()), [C.poolId, A.poolId], 'changing listId or revision does not erase the rejected identity');
  await store.refresh();
  assert.deepEqual(idsOf(store.getSnapshot()), [C.poolId, B.poolId, A.poolId], 'a corrected key returns for verification by the markets provider');
});

test('older publications cannot restore withdrawn pools, replace selection figures, or erase safety withdrawals', async () => {
  const latest = nextDay([C, A], { listId: listId('09'), revision: CURRENT.revision + 5,
    withdrawn: [{ poolId: B.poolId, at: CURRENT.servedAt, reason: 'excluded_by_owner' }] });
  const olderRevision = answer([A, B, C], { revision: latest.revision - 1, servedAt: latest.servedAt + 120 });
  const olderDay = answer([A, B, C], { revision: latest.revision, servedAt: latest.servedAt + 120 });
  const olderObservation = { ...clone(latest), servedAt: latest.servedAt - 1, withdrawn: [] };
  const olderNone = { ...read('valid/none.json'), servedAt: latest.servedAt - 1 };
  for (const body of [latest, olderRevision, olderDay, olderObservation, olderNone]) assert.ok(featured.validateFeatured(v5, body));
  const { store } = scripted(...[latest, olderRevision, olderDay, olderObservation, olderNone].map(answered));
  const shown = await store.ensure();
  for (let i = 0; i < 4; i++) {
    await store.refresh();
    assert.equal(store.getSnapshot(), shown, 'stale data does not notify or replace the accepted snapshot');
    assert.deepEqual(idsOf(store.getSnapshot()), [C.poolId, A.poolId]);
    assert.equal(store.getSnapshot().withdrawn.has(B.poolId), true);
  }
});

test('a fresh none and explicit route shutdown still apply, while the publication guard survives fallback', async () => {
  const latest = nextDay([C, A], { listId: listId('09'), revision: CURRENT.revision + 5 });
  const none = { ...read('valid/none.json'), servedAt: latest.servedAt + 60 };
  const stale = answer([A, B, C], { revision: latest.revision - 1, servedAt: none.servedAt + 60 });
  const recovered = { ...clone(latest), revision: latest.revision + 1, servedAt: none.servedAt + 120 };
  const off = featured.answerOf({ route: 'featured-pools', state: 'disabled', reason: 'route_not_enabled', provenance: {} });
  const { store } = scripted(...[latest, none, stale, recovered].map(answered), off);
  await store.ensure();
  await store.refresh();
  assert.equal(store.getSnapshot().source, 'bundled', 'newer validated none takes effect');
  await store.refresh();
  assert.equal(store.getSnapshot().source, 'bundled', 'fallback does not forget the newest accepted publication');
  await store.refresh();
  assert.deepEqual(idsOf(store.getSnapshot()), [C.poolId, A.poolId]);
  await store.refresh();
  assert.equal(store.getSnapshot().source, 'bundled', 'a current route shutdown is authoritative');
});

test('overlapping reads cannot undo a newer answer, including a delayed route-off and equal-publication metadata', async () => {
  const initial = answer([A, B, C]);
  const updated = { ...clone(initial), revision: initial.revision + 1, servedAt: initial.servedAt + 60,
    pools: [C, A].map((entry, i) => ({ ...clone(entry), slot: i + 1 })),
    withdrawn: [{ poolId: B.poolId, at: initial.servedAt, reason: 'excluded_by_owner' }] };
  const olderMetadata = clone(updated);
  olderMetadata.pools[0].rankInputs.freshApr = '999';
  const off = featured.answerOf({ route: 'featured-pools', state: 'disabled', reason: 'route_not_enabled', provenance: {} });
  for (const late of [answered(initial), answered(olderMetadata), off]) {
    const pending = [];
    let first = true;
    const store = featured.createFeaturedStore({ clock: steadyClock(), read: () => {
      if (first) { first = false; return Promise.resolve(answered(initial)); }
      return new Promise((resolve) => pending.push(resolve));
    } });
    await store.ensure();
    const early = store.refresh(), newer = store.refresh();
    pending[1](answered(updated));
    await newer;
    const accepted = store.getSnapshot();
    pending[0](late);
    await early;
    assert.equal(store.getSnapshot(), accepted);
    assert.deepEqual(idsOf(accepted), [C.poolId, A.poolId]);
    assert.equal(accepted.withdrawn.has(B.poolId), true);
  }
});

test('a route shutdown wins over an earlier in-flight list, even when that list names a higher revision', async () => {
  const initial = answer([A, B, C]);
  const newer = answer([C, A], { revision: initial.revision + 1, servedAt: initial.servedAt + 60 });
  const pending = [];
  let first = true;
  const store = featured.createFeaturedStore({ clock: steadyClock(), read: () => {
    if (first) { first = false; return Promise.resolve(answered(initial)); }
    return new Promise((resolve) => pending.push(resolve));
  } });
  await store.ensure();
  const early = store.refresh(), shutdown = store.refresh();
  pending[1](featured.answerOf({ route: 'featured-pools', state: 'disabled', reason: 'route_not_enabled', provenance: {} }));
  await shutdown;
  const stopped = store.getSnapshot();
  pending[0](answered(newer));
  await early;
  assert.equal(store.getSnapshot(), stopped, 'a delayed answer cannot undo the explicit shutdown');
  assert.equal(stopped.source, 'bundled');
  const recovery = store.refresh();
  pending[2](answered(newer));
  await recovery;
  assert.deepEqual(idsOf(store.getSnapshot()), [C.poolId, A.poolId], 'a read started after shutdown can confirm recovery');
});

test('refresh: a removal and its admitted replacement apply together without reload or a thirty-minute wait', async () => {
  const first = answered(answer([A, B, C], { listId: listId('01') }));
  const repaired = answered(answer([A, C, pool(id('d4'), addr('d4'), 'TKND')], { listId: listId('05'), status: 'repaired' }));
  const { store } = scripted(first, repaired);
  await store.ensure();
  await store.refresh();
  assert.deepEqual(idsOf(store.getSnapshot()), [A.poolId, C.poolId, id('d4')], 'B leaves and its replacement appears together');
  store.remount();
  assert.deepEqual(idsOf(store.getSnapshot()), [A.poolId, C.poolId, id('d4')], 'remount is not required for admission');
});

test('refresh: a disabled route falls back, and a recovered server list is admitted without reload', async () => {
  const first = answered(answer([A, B], { listId: listId('01') }));
  const { store } = scripted(first, answered(read('valid/none-with-withdrawn.json')), first);
  await store.ensure();
  assert.equal(store.getSnapshot().source, 'server');
  await store.refresh();
  assert.equal(store.getSnapshot().source, 'bundled');
  assert.deepEqual(idsOf(store.getSnapshot()), SELECTED_POOLS);
  assert.equal(store.getSnapshot().withdrawn.size, 2, 'none still carries its removals');
  await store.refresh();
  assert.equal(store.getSnapshot().source, 'server', 'the recovered validated server list takes effect immediately');
  const off = scripted(first, featured.answerOf({ route: 'featured-pools', state: 'disabled', reason: 'route_not_enabled', provenance: {} }));
  await off.store.ensure();
  await off.store.refresh();
  assert.equal(off.store.getSnapshot().source, 'bundled', 'route_not_available: at once');
});

test('the same list gone stale keeps its pools and drops its criterion title', async () => {
  const first = answered(answer([A, B], { listId: listId('01') }));
  const shortValid = CURRENT.window.end + 30 * 3600;
  const stale = answered(answer([A, B], { listId: listId('01'), validUntil: shortValid, servedAt: shortValid + 60 }));
  const past = answered(answer([A, B], { listId: listId('01'), validUntil: shortValid, servedAt: CURRENT.window.end + 36 * 3600 + 1 }));
  const { store } = scripted(first, stale, past);
  await store.ensure();
  assert.equal(store.getSnapshot().source, 'server');
  await store.refresh();
  assert.equal(store.getSnapshot().source, 'server_neutral');
  assert.deepEqual(idsOf(store.getSnapshot()), [A.poolId, B.poolId]);
  await store.refresh();
  assert.equal(store.getSnapshot().source, 'bundled', 'an open tab leaves the list once it passes its limit');
  assert.deepEqual(idsOf(store.getSnapshot()), SELECTED_POOLS);
});

test('before its first answer the store paints the embedded list; a read that throws settles on it', async () => {
  const { store } = scripted(() => Promise.reject(new Error('boom')));
  assert.equal(store.getSnapshot().settled, false);
  assert.deepEqual(idsOf(store.getSnapshot()), SELECTED_POOLS);
  const settled = await store.ensure();
  assert.equal(settled.settled, true);
  assert.equal(settled.source, 'bundled');
});

// Added 2026-09-28 (speed wave, item 8). A first read that found no answer (its 1.5 s passed, the service was busy, an
// edge page) put the embedded list up for 30 minutes: the served list waited for a remount, and Home, its ticker,
// Markets and a link showed the wrong pools for half an hour (the study's harness: still the embedded list at +31 min).
test('a first read that found no answer puts up the embedded list only until an answer comes: asked again seconds on, and the first answer takes the screen at once', async () => {
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const first = answered(answer([A, B], { listId: listId('01') }));
  const timers = [];
  const clock = { ...steadyClock(), timer: (ms, fire) => { const row = { ms, fire, cancelled: false }; timers.push(row); return () => { row.cancelled = true; }; } };
  const answers = [{ kind: 'failed', passing: true }, { kind: 'failed', passing: true }, first, { kind: 'failed', passing: true }];
  const firsts = [];
  const store = featured.createFeaturedStore({ clock, read: async (_signal, isFirst) => { firsts.push(isFirst === true); return answers.shift() ?? first; } });
  await store.ensure();
  assert.equal(store.getSnapshot().source, 'bundled');
  assert.deepEqual(timers.map((timer) => timer.ms), [3_000], 'asked again 3 s on');
  timers[0].fire(); await settle();
  assert.equal(store.getSnapshot().source, 'bundled');
  assert.deepEqual(timers.map((timer) => timer.ms), [3_000, 6_000], 'then 6 s on');
  timers[1].fire(); await settle();
  assert.deepEqual([store.getSnapshot().source, idsOf(store.getSnapshot())], ['server', [A.poolId, B.poolId]], 'the first answer takes the screen at once');
  // Changed on purpose 2026-10-01 (audit B3): every read made while the embedded list only holds the place has the first
  // read's longer deadline, the reads asked again included; a refresh of a served list keeps 1.5 s.
  assert.deepEqual(firsts, [true, true, true], 'each read made while the embedded list holds the place');
  await store.refresh();
  assert.equal(firsts.at(-1), false, 'a refresh of a served list keeps the short deadline');
  assert.deepEqual([store.getSnapshot().source, timers.length], ['server', 2], 'a later failure keeps the list, and nothing more is asked on the store’s own');
  // The markets' own refresh takes the first answer at once too.
  const refreshed = scripted({ kind: 'failed', passing: true }, first);
  await refreshed.store.ensure();
  await refreshed.store.refresh();
  assert.equal(refreshed.store.getSnapshot().source, 'server');
  // A later validated list replaces an initial none without requiring a reload.
  const none = scripted(answered(read('valid/none.json')), first);
  await none.store.ensure();
  await none.store.refresh();
  assert.equal(none.store.getSnapshot().source, 'server');
  // At most three asks of its own, 3, 6 and 12 s apart.
  const down = [];
  const downClock = { ...steadyClock(), timer: (ms, fire) => { down.push(ms); void Promise.resolve().then(fire); return () => {}; } };
  const failing = featured.createFeaturedStore({ clock: downClock, read: async () => ({ kind: 'failed', passing: true }) });
  await failing.ensure();
  for (let i = 0; i < 10; i++) await settle();
  assert.deepEqual(down, featured.FEATURED_RETRY_MS);
  // A failure that cannot clear by itself (an invalid list) is not asked again.
  const invalid = [];
  const invalidClock = { ...steadyClock(), timer: (ms) => (invalid.push(ms), () => {}) };
  await featured.createFeaturedStore({ clock: invalidClock, read: async () => ({ kind: 'failed' }) }).ensure();
  assert.deepEqual(invalid, []);
  assert.deepEqual(featured.answerOf({ route: 'featured-pools', state: 'unavailable', cause: { kind: 'read_deadline', limit: 'read' }, retryable: true, provenance: {} }), { kind: 'failed', passing: true });
  assert.deepEqual(featured.answerOf({ route: 'featured-pools', state: 'invalid', reason: 'response_contract', provenance: {} }), { kind: 'failed' });
  // The first read may be given longer: 3.5 s where the page waits for it.
  assert.equal(featured.FEATURED_FIRST_DEADLINE_MS, 3_500);
  const deadlines = [];
  const source = { transport: 'bridge', read: async (route, request, options) => (deadlines.push(options.deadlineAt), { route, state: 'aborted', provenance: {} }) };
  await featured.readFeaturedList(source, { clock: { monotonic: () => 100 } });
  await featured.readFeaturedList(source, { clock: { monotonic: () => 100 }, deadlineMs: featured.FEATURED_FIRST_DEADLINE_MS });
  assert.deepEqual(deadlines, [1_600, 3_600]);
});

// Added 2026-09-26 after review: ensure() used to resolve, for good, to the snapshot of the page's first answer, so a
// pool a later refresh withdrew was still verified and preselected by New position when a link opened it in that tab.
test('ensure() after a refresh gives the list as it is now: a pool a repaired answer withdrew is refused by New position’s check', async () => {
  const [first, second] = CURRENT.pools;
  const withdrawn = { ...clone(read('valid/none-with-withdrawn.json').withdrawn[0]), poolId: second.poolId };
  const repaired = { ...clone(read('valid/repaired.json')), pools: [{ ...clone(first), slot: 1 }], withdrawn: [withdrawn] };
  assert.ok(featured.validateFeatured(v5, repaired), 'a valid repaired answer that withdraws the second pool');
  const { store } = scripted(answered(answer(CURRENT.pools)), answered(repaired));
  const before = await store.ensure();
  assert.equal(before.withdrawn.has(second.poolId), false);
  assert.equal(before.entries.length, 2);
  await store.refresh();
  assert.equal(store.getSnapshot().withdrawn.has(second.poolId), true);
  // A link opened now, in the same tab: Journey waits for ensure(), then checks the list as it is.
  const now = await store.ensure();
  assert.equal(now, store.getSnapshot(), 'the live snapshot, not the first answer’s');
  assert.equal(now.withdrawn.has(second.poolId), true);
  assert.deepEqual(idsOf(now), [first.poolId]);
  const linked = journey.preselectFrom(second.poolId, now.entries);
  assert.ok(linked.ok);
  assert.equal(now.withdrawn.has(linked.key), true, 'New position refuses it');
  // Journey reads the store after ensure(), never the value ensure() resolved with at the time.
  const code = readFileSync(new URL('../src/components/create/Journey.tsx', import.meta.url), 'utf8');
  assert.match(code, /void listed\.ensure\(\)\.then\(async \(\) => \{\n\s+const list = listed\.getSnapshot\(\)/);
});

// --- binding: a row stands only when its read is the pool its entry names ---

/** A featured pool with the v3 overview fixture's key (ETH/TOKEN, 0.30%, spacing 60) under `poolId`. */
function storedPool(poolId, extra = {}) {
  return pool(poolId, addr('11'), 'TOKEN', {
    poolKey: { currency0: NATIVE_ETH, currency1: addr('11'), feeMode: 'fixed', fee_pips: 3000, hooks: NATIVE_ETH, tick_spacing: 60 },
    tokens: [{ address: NATIVE_ETH, decimals: 18, symbol: 'ETH' }, { address: addr('11'), decimals: 18, symbol: 'TOKEN' }],
    ...extra,
  });
}

/** The app's markets provider over the featured list, both read through the composed source with a fake fetch. */
function marketsOver(lists) {
  let listAt = 0;
  const calls = [];
  const fetch = async (path, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    const reply = (status, data, contract) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': contract } });
    if (path === '/api/read/v5/featured-pools') { const next = lists[Math.min(listAt, lists.length - 1)]; listAt += 1; return typeof next === 'function' ? next() : reply(200, next, v5.CONTRACT_VERSION); }
    if (path === '/api/read/v3/capabilities') return reply(200, JSON.parse(readFileSync(new URL('../../api-contracts/read-v3/fixtures/capabilities.json', import.meta.url), 'utf8')), v3.CONTRACT_VERSION);
    if (path === '/api/read/v3/overview') return reply(200, overviewFor(body), v3.CONTRACT_VERSION);
    throw new Error(`unexpected read: ${path}`);
  };
  const options = { enabled: true, validators: v1, fetch };
  const inner = featured.createFeaturedReadSource(createPublicSource(createEstimateSource(options, v2), options, v3), options, v5);
  const source = createPublicMetadataCache(createScheduledSource(inner, { minIntervalMs: 0, budget: null }));
  const store = featured.createFeaturedStore({ read: (signal) => featured.readFeaturedList(source, { signal }).then(featured.answerOf) });
  // The provider reads the list again only once a refresh interval has passed since it last did: `minute()` passes one.
  let offset = 0;
  const clock = { ...realClock, monotonic: () => realClock.monotonic() + offset, now: () => realClock.now() + offset };
  const provider = createReadMarketsProvider({ source, poolIds: [], pools: featured.poolListOf(store), kind: 'bridge', clock, refreshMs: 60_000 });
  const minute = () => { offset += 60_000; };
  const settle = () => new Promise((resolve) => {
    const check = () => { if (provider.getSnapshot().phase !== 'loading') { stop(); resolve(provider.getSnapshot()); } };
    const stop = provider.subscribe(check);
  });
  const rows = () => provider.getSnapshot().result?.markets.map((m) => m.poolId) ?? [];
  return { provider, store, settle, rows, calls, minute };
}

test('the list first, then its markets; intra-day refresh adopts order and removals, and none switches to the embedded list', async () => {
  const [P, Q, R] = [storedPool(id('a1')), storedPool(id('b2')), storedPool(id('c3'))];
  const { provider, store, settle, rows, calls, minute } = marketsOver([
    answer([P, Q, R], { listId: listId('01') }),
    answer([R, Q, P], { listId: listId('02') }),
    answer([P, R], { listId: listId('03'), status: 'repaired' }),
    read('valid/none.json'),
  ]);
  let done = settle();
  provider.ensure();
  await done;
  assert.equal(calls[0].path, '/api/read/v5/featured-pools', 'the list is read first');
  assert.deepEqual(calls.find((c) => c.path === '/api/read/v3/overview').body.poolIds, [P.poolId, Q.poolId, R.poolId]);
  assert.deepEqual(rows(), [P.poolId, Q.poolId, R.poolId]);
  const lists = () => calls.filter((c) => c.path === '/api/read/v5/featured-pools').length;
  done = settle(); provider.refresh(); await done;
  assert.equal(lists(), 1, 'a load within the minute (a catch-up) reads the markets alone');
  minute(); done = settle(); provider.refresh(); await done;
  assert.equal(lists(), 2);
  assert.deepEqual(rows(), [R.poolId, Q.poolId, P.poolId], 'server order on the same refresh');
  minute(); done = settle(); provider.refresh(); await done;
  assert.deepEqual(rows(), [P.poolId, R.poolId], 'the removal, on the refresh that saw it');
  minute(); done = settle(); provider.refresh(); await done;
  assert.equal(store.getSnapshot().source, 'bundled');
  assert.deepEqual(calls.filter((c) => c.path === '/api/read/v3/overview').at(-1).body.poolIds, SELECTED_POOLS, 'none: the embedded list is read at once');
  assert.deepEqual(rows(), SELECTED_POOLS);
});

test('the markets provider follows the next day’s ranking in an open page on its ordinary refresh', async () => {
  const [P, Q, R] = [storedPool(id('a1')), storedPool(id('b2')), storedPool(id('c3'))];
  const daily = nextDay([R, Q, P], { listId: listId('02') });
  const { provider, store, settle, rows, calls, minute } = marketsOver([
    answer([P, Q, R], { listId: listId('01') }), daily,
  ]);
  let done = settle();
  provider.ensure();
  await done;
  minute();
  done = settle();
  provider.refresh();
  await done;
  assert.deepEqual(rows(), [R.poolId, Q.poolId, P.poolId]);
  assert.deepEqual(calls.filter((call) => call.path === '/api/read/v3/overview').at(-1).body.poolIds, [R.poolId, Q.poolId, P.poolId]);
  assert.equal(store.getSnapshot().revision, daily.revision);
  assert.equal(store.getSnapshot().selectionDate, daily.selectionDate);
});

test('a row whose read is another pool than its entry names is dropped, and with none left the embedded list is read', async () => {
  const good = storedPool(id('a1'));
  const wrongFee = storedPool(id('b2'), { poolKey: { ...storedPool(id('b2')).poolKey, fee_pips: 500 } });
  const { provider, store, settle, rows } = marketsOver([answer([good, wrongFee], { listId: listId('01') })]);
  let done = settle();
  provider.ensure();
  await done;
  // The drop reaches the list after the load settles; the rows follow it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(idsOf(store.getSnapshot()), [good.poolId]);
  assert.deepEqual(rows(), [good.poolId]);

  const onlyWrong = marketsOver([answer([wrongFee], { listId: listId('02') })]);
  done = onlyWrong.settle();
  onlyWrong.provider.ensure();
  await done;
  // All dropped: the embedded list, and a load of it.
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(onlyWrong.store.getSnapshot().source, 'bundled');
  await new Promise((resolve) => {
    const check = () => { if (onlyWrong.provider.getSnapshot().phase === 'ready' && onlyWrong.rows().length === SELECTED_POOLS.length) resolve(); };
    onlyWrong.provider.subscribe(check); check();
  });
  assert.deepEqual(onlyWrong.rows(), SELECTED_POOLS);
});

test('bindsToEntry: the key, the currencies and the integration class must all be the entry’s; a pending row is not a mismatch; the embedded list binds by id alone', () => {
  const entry = featured.entryOf(storedPool(id('a1')));
  const read_ = { poolKey: { currency0: NATIVE_ETH, currency1: addr('11'), feeMode: 'fixed', fee_pips: 3000, hooks: NATIVE_ETH, tick_spacing: 60 }, currencies: [NATIVE_ETH, addr('11')], integrationClass: 'hookless_fixed_fee' };
  assert.equal(featured.bindsToEntry(entry, read_), true);
  assert.equal(featured.bindsToEntry(entry, { ...read_, poolKey: { ...read_.poolKey, tick_spacing: 10 } }), false);
  assert.equal(featured.bindsToEntry(entry, { ...read_, poolKey: { ...read_.poolKey, hooks: addr('77') } }), false);
  assert.equal(featured.bindsToEntry(entry, { ...read_, currencies: [NATIVE_ETH, addr('12')] }), false);
  assert.equal(featured.bindsToEntry(entry, { ...read_, integrationClass: 'requires_separate_adapter' }), false);
  assert.equal(featured.bindsToEntry(SELECTED_POOL_CATALOGUE[0], { ...read_, integrationClass: 'requires_separate_adapter' }), true, 'the embedded list: bound by id');
  // A pending overview entry (no value) has no row to bind, so it stays listed: see marketsProvider.ts `bound`.
});

// Added 2026-09-28 (featured-policy v2, read-v5 rc.2). The VM serves rc.1 until rugged's step 2, and this build goes out
// first: an rc.1 list, held to rc.1's rules, is still the server's list, and the app asks in rc.2.
test('during the transition an rc.1 list is still the server’s list; the app asks in rc.2, and rc.1 keeps its own rules', async () => {
  assert.deepEqual(v5.CONTRACT_VERSIONS, ['1.0.0-rc.1', '1.0.0-rc.2']);
  const v1List = read('valid/current-policy-v1.json');
  for (const [body, contract] of [[{ ...clone(v1List), contractVersion: '1.0.0-rc.1' }, '1.0.0-rc.1'], [v1List, '1.0.0-rc.2'], [CURRENT, '1.0.0-rc.2']]) {
    const { source, calls } = composed(() => json(200, body, contract));
    const outcome = await featured.readFeaturedList(source);
    assert.equal(outcome.state, 'ok', contract);
    assert.equal(calls[0].contract, '1.0.0-rc.2', 'asked in rc.2');
    const list = featured.listFrom(featured.answerOf(outcome));
    assert.equal(list.source, 'server', `${contract}: the criterion title`);
    assert.deepEqual(list.entries.map((entry) => entry.rankApr ?? null), body.pools.map((item) => item.rankInputs?.rankApr ?? null));
  }
  // rc.2's ranking and its nulls under rc.1's name are refused whole: the embedded list stands.
  const { source } = composed(() => json(200, { ...clone(CURRENT), contractVersion: '1.0.0-rc.1' }, '1.0.0-rc.1'));
  const refused = featured.answerOf(await featured.readFeaturedList(source));
  assert.equal(refused.kind, 'failed');
  assert.equal(featured.listFrom(refused), featured.BUNDLED_LIST);
});

// --- entries, links, labels and New position ---

test('an entry names its symbols as untrusted labels, its fee as fee.ts writes it, its key, and its pinned mark; its link names USDG', () => {
  const [pinned, ranked] = CURRENT.pools.map(featured.entryOf);
  assert.deepEqual(pinned.labels, ['PONS', 'USDG']);
  assert.equal(pinned.fee, '0.30%');
  assert.equal(pinned.pinned, true);
  assert.equal(ranked.pinned, undefined);
  // Policy v2 (read-v5 rc.2, 2026-09-28): the list ranks by today's APR, so rankApr is freshApr.
  assert.equal(ranked.rankApr, '551.0');
  assert.equal(featured.entryOf(read('valid/current-policy-v1.json').pools[1]).rankApr, '546.1', 'a v1 list keeps the lower of two days');
  assert.deepEqual(pinned.artwork, [null, 'USDG']);
  assert.equal(referenceToken(pinned.addresses), USDG);
  assert.equal(referenceToken([NATIVE_ETH, addr('11')]), addr('11'), 'never native ETH: it names no contract');
  assert.equal(referenceToken([NATIVE_ETH, WETH]), WETH);
  const listings = poolListings([], [pinned, ranked]);
  assert.deepEqual(listings.map((l) => l.token), [USDG, USDG]);
  // Changed on purpose 2026-11-02 (the owner's new embedded list): ETH/TORCH, third, holds no USDG. Its row names both
  // currencies, so its link names TORCH, never native ETH, and a link to it is verified with TORCH.
  const TORCH = '0x000050e18ffa3f8f7ad170eb9cef160eb3ed1111';
  assert.deepEqual(poolListings([], SELECTED_POOL_CATALOGUE).map((l) => l.token), SELECTED_POOLS.map((_, index) => (index === 2 ? TORCH : USDG)), 'every embedded row links with USDG but ETH/TORCH');
  assert.equal(journey.verificationToken(journey.preselectFrom(SELECTED_POOLS[2])), TORCH);
  assert.equal(journey.verificationToken(journey.preselectFrom(SELECTED_POOLS[0])), USDG, 'ETH/USDG, which names no addresses');
});

test('the embedded labels are keyed by pool id, so a new order cannot move a label onto another pool', () => {
  const source = readFileSync(new URL('../src/config/selectedPoolCatalogue.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /LABELS\[index\]/);
  assert.deepEqual(SELECTED_POOL_CATALOGUE.map((entry) => entry.poolId), SELECTED_POOLS, 'every reviewed pool has its labels');
  const byId = Object.fromEntries(SELECTED_POOL_CATALOGUE.map((entry) => [entry.poolId, entry.labels.join('/')]));
  // Changed on purpose 2026-10-04 (the owner's new embedded list): WETH/USDG left the list, and ETH/USDG and PONS/USDG
  // moved up from fifth and sixth to first and second. Each pool id still carries its own labels, the four new ones too.
  // Changed on purpose 2026-11-02 (the owner's new embedded list): ETH/USDG 0.05% in place of 0.01%, ETH/TORCH where
  // USDG/ORBIO was and USDG/PRIORS where USDG/UBIK was; PONS/USDG, CASHCAT/USDG and USDG/VIRTUAL stay where they were.
  assert.deepEqual(byId, {
    '0x387bf619da4d3fb62bb276482693dba1b9b3520f573cabdfe033384a24125982': 'ETH/USDG',
    '0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a': 'PONS/USDG',
    '0x1649550af1e3363b4c25236434530af7e6886b183e1f574a98fdd1d04d287a2d': 'ETH/TORCH',
    '0xa92a3df27a00a276183ff7265fd8affa11df1fe8bb23ddfaf13f6c879a3f818b': 'CASHCAT/USDG',
    '0x9be7ab27227e115085b0949a819a73f6963ddc6da0c6204d37757c24297706e8': 'USDG/PRIORS',
    '0xa95732060867f07aa9b8ae9a4b7b8d737bc3374f1dfbb952759c5ed676e8737c': 'USDG/VIRTUAL',
  });
  assert.deepEqual(SELECTED_POOL_CATALOGUE.map((entry) => entry.fee), ['0.05%', '0.30%', '0.30%', '0.269%', '1.00%', '0.30%'], 'fees as fee.ts writes the keys’ fee_pips');
});

test('New position names a featured list’s pools by their validated keys; a link to one is verified with a currency its entry names', () => {
  const entries = CURRENT.pools.map(featured.entryOf);
  assert.deepEqual(featuredPoolIds(USDG, null, entries), entries.map((entry) => entry.poolId));
  assert.deepEqual(featuredPoolIds(addr('b1'), null, entries), [entries[1].poolId]);
  const linked = journey.preselectFrom(entries[1].poolId, entries);
  assert.equal(linked.catalogue.poolId, entries[1].poolId);
  assert.equal(journey.verificationToken(linked), USDG);
  assert.equal(journey.preselectFrom(SELECTED_POOLS[0], entries).catalogue.poolId, SELECTED_POOLS[0], 'an embedded pool is still found');
});

test('only the deployable build reads the list: a fixture or test build gets the embedded list, settled, and never asks', () => {
  const store = featured.bundledStore();
  assert.equal(store.getSnapshot().settled, true);
  assert.equal(store.getSnapshot().source, 'bundled');
  const code = readFileSync(new URL('../src/lib/read/featuredSource.ts', import.meta.url), 'utf8');
  assert.match(code, /if \(__DOMINO_POOL_SET__ !== 'selected'\) return \(store = bundledStore\(\)\)/);
  const markets = readFileSync(new URL('../src/lib/read/bridgeMarkets.ts', import.meta.url), 'utf8');
  assert.match(markets, /if \(__DOMINO_POOL_SET__ !== 'selected'\) return createReadMarketsProvider\(\{ source, poolIds: BRIDGE_TEST_POOLS, kind: 'bridge', refreshMs: 60_000 \}\)/);
});
