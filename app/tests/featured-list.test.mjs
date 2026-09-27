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
  assert.equal(SELECTED_POOL_CATALOGUE.find((entry) => entry.labels.includes('USDG')).addresses.includes(USDG), true);
  assert.equal(readsAsMainToken('USDG', addr('f6')), true);
  assert.equal(readsAsMainToken('USDG', USDG), false);
  assert.equal(readsAsMainToken('ETH', WETH), false, 'ether either way');
  assert.equal(isLookAlike({ token: { address: addr('f6'), symbol: 'USDG' } }), true, 'the wallet card still refuses the fake');
  // The wallet lists fall back to the main tokens and the embedded list's, never a featured list's.
  assert.deepEqual([...WALLET_FALLBACK_TOKENS], [WETH, USDG, ...catalogueTokens().map((t) => t.address).filter((a) => a !== WETH && a !== USDG)]);
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

test('fallback: current and repaired while valid are the server’s list with its title; carried_over, manual and a stale list are neutral; past 72 h, none, or no pools left is the embedded list', () => {
  const current = featured.listFrom(answered(answer([A, B])));
  assert.equal(current.source, 'server');
  assert.deepEqual(idsOf(current), [A.poolId, B.poolId]);
  assert.equal(featured.featuredTitle(current.source), 'Top pools · last 24h');
  assert.equal(current.method, 'Ranked daily at 12:00 UTC by estimated 24h fee APR among pools with no hooks, a fixed fee, at least $250K 24h volume and $250K liquidity. Order is set at selection; figures update live. Not a recommendation.');
  assert.equal(featured.listFrom(answered(read('valid/repaired.json'))).source, 'server');
  for (const [label, body] of [
    ['carried_over', answer([A, B], { status: 'carried_over' })],
    ['manual', read('valid/manual.json')],
    ['stale', answer([A, B], { servedAt: CURRENT.validUntil + 1 })],
    ['stale up to 72 h', answer([A, B], { servedAt: CURRENT.generatedAt + 72 * 3600 })],
  ]) {
    const list = featured.listFrom(answered(body));
    assert.equal(list.source, 'server_neutral', label);
    assert.equal(list.method, null, label);
    assert.equal(featured.featuredTitle(list.source), 'Selected pools', label);
    assert.ok(list.entries.length > 0, label);
  }
  for (const [label, outcome] of [
    ['older than 72 h', answered(answer([A, B], { servedAt: CURRENT.generatedAt + 72 * 3600 + 1 }))],
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
test('the method line names the owner’s selection time, 12:00 UTC, never the answer’s effectiveAt: a repair at 17:42 or a list published at 12:07', () => {
  const noon = CURRENT.effectiveAt;
  assert.equal(new Date(noon * 1000).toISOString().slice(11, 16), '12:00', 'the fixtures’ own time');
  const expected = 'Ranked daily at 12:00 UTC by estimated 24h fee APR among pools with no hooks, a fixed fee, at least $250K 24h volume and $250K liquidity. Order is set at selection; figures update live. Not a recommendation.';
  for (const [label, body] of [
    ['repaired at 17:42', { ...read('valid/repaired.json'), effectiveAt: noon + 5 * 3600 + 42 * 60, servedAt: noon + 5 * 3600 + 42 * 60 }],
    ['current published at 12:07', { ...clone(CURRENT), effectiveAt: noon + 7 * 60, servedAt: noon + 7 * 60 }],
  ]) {
    assert.ok(featured.validateFeatured(v5, body), `${label}: a valid answer`);
    const list = featured.listFrom(answered(body));
    assert.equal(list.source, 'server', label);
    assert.equal(list.method, expected, label);
    assert.doesNotMatch(list.method, /17:42|12:07/, label);
  }
  assert.equal(featured.FEATURED_SELECTION_TIME_UTC, '12:00');
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
  assert.deepEqual(calls, [{ path: '/api/read/v5/featured-pools', method: 'POST', body: '{}', contract: '1.0.0-rc.1' }]);
  assert.equal(STORED_LANE.has('featured-pools'), true);
  const asked = [];
  await featured.readFeaturedList({ transport: 'bridge', read: async (route, request, options) => (asked.push({ route, request, options }), { state: 'aborted' }) }, { clock: { monotonic: () => 1000 } });
  assert.deepEqual(asked, [{ route: 'featured-pools', request: {}, options: { priority: 'first', signal: undefined, deadlineAt: 2500 } }]);
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
test('the list costs the tab’s gateway budget nothing: Markets’ overview and six card histories start when they did before it', async () => {
  const { EDGE_ANSWERED } = built('lib/read/scheduler');
  assert.deepEqual([...EDGE_ANSWERED], ['featured-pools']);
  let steady = 0;
  const clock = { now: () => steady, monotonic: () => steady, random: () => 0, timer: () => () => {},
    sleep: async (ms, signal) => { if (signal?.aborted) throw signal.reason; steady += ms; } };
  const starts = [];
  const source = { transport: 'bridge', read: async (route, request, opts = {}) => {
    starts.push([route, clock.monotonic()]);
    opts.onAttempt?.();
    return { route, state: 'ok', data: {}, provenance: {} };
  } };
  const queue = createScheduledSource(source, { clock, unspacedStored: true });
  const history = (i) => ({ poolId: id((i + 1).toString(16).padStart(2, '0')), currency: NATIVE_ETH, windowSeconds: 86400, resolutionSeconds: 3600 });
  await featured.readFeaturedList(queue, { clock });
  await queue.read('overview', { poolIds: SELECTED_POOLS });
  for (let i = 0; i < 6; i++) await queue.read('history', history(i));
  assert.deepEqual(starts, [['featured-pools', 0], ['overview', 0], ...[0, 0, 0, 500, 2500, 4500].map((at) => ['history', at])],
    'the same starts as with no list read (read-public.test.mjs: 0, 0, 0, 0, 500, 2500, 4500)');
  // A list read never waits for the budget: asked with too little left for a gateway read, it goes at once.
  const late = starts.length;
  await featured.readFeaturedList(queue, { clock });
  assert.deepEqual(starts.slice(late), [['featured-pools', 4500]]);
  await queue.read('history', history(6));
  assert.deepEqual(starts.at(-1), ['history', 6500], 'the next gateway read keeps the budget’s own pace');
});

// --- the refresh: the list on screen changes only as §11.1 says ---

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

test('refresh: the same listId changes nothing; a reorder or a new pool waits; removals apply at once; a failure keeps the list', async () => {
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
  assert.equal(seen.length, 1, 'the same listId: nothing changed');
  await store.refresh();
  assert.deepEqual(idsOf(store.getSnapshot()), [A.poolId, B.poolId, C.poolId], 'no reorder on refresh');
  await store.refresh();
  assert.deepEqual(idsOf(store.getSnapshot()), [A.poolId, B.poolId, C.poolId], 'a new pool waits');
  await store.refresh();
  assert.deepEqual(idsOf(store.getSnapshot()), [A.poolId, B.poolId, C.poolId], 'a failure keeps the list');
  await store.refresh();
  assert.deepEqual(idsOf(store.getSnapshot()), [A.poolId, C.poolId], 'the removal at once, on the refresh that saw it');
  assert.equal(store.getSnapshot().source, 'server');
});

test('refresh: a removal beside a new pool applies at once while the new pool waits; the waiting list is taken on a remount after 30 min only', async () => {
  const first = answered(answer([A, B, C], { listId: listId('01') }));
  const repaired = answered(answer([A, C, pool(id('d4'), addr('d4'), 'TKND')], { listId: listId('05'), status: 'repaired' }));
  const { store, clock } = scripted(first, repaired);
  await store.ensure();
  await store.refresh();
  assert.deepEqual(idsOf(store.getSnapshot()), [A.poolId, C.poolId], 'B left at once');
  store.remount();
  assert.deepEqual(idsOf(store.getSnapshot()), [A.poolId, C.poolId], 'a remount before 30 min takes nothing');
  clock.advance(featured.FEATURED_REMOUNT_MS);
  store.remount();
  assert.deepEqual(idsOf(store.getSnapshot()), [A.poolId, C.poolId, id('d4')], 'a remount after 30 min takes the waiting list');
});

test('refresh: none or a route that is off mid-session switches to the embedded list at once; a server list then waits for a reload', async () => {
  const first = answered(answer([A, B], { listId: listId('01') }));
  const { store } = scripted(first, answered(read('valid/none-with-withdrawn.json')), first);
  await store.ensure();
  assert.equal(store.getSnapshot().source, 'server');
  await store.refresh();
  assert.equal(store.getSnapshot().source, 'bundled');
  assert.deepEqual(idsOf(store.getSnapshot()), SELECTED_POOLS);
  assert.equal(store.getSnapshot().withdrawn.size, 2, 'none still carries its removals');
  await store.refresh();
  assert.equal(store.getSnapshot().source, 'bundled', 'switching back on is an entry: it waits');
  const off = scripted(first, featured.answerOf({ route: 'featured-pools', state: 'disabled', reason: 'route_not_enabled', provenance: {} }));
  await off.store.ensure();
  await off.store.refresh();
  assert.equal(off.store.getSnapshot().source, 'bundled', 'route_not_available: at once');
});

test('the same list gone stale keeps its pools and drops its criterion title', async () => {
  const first = answered(answer([A, B], { listId: listId('01') }));
  const stale = answered(answer([A, B], { listId: listId('01'), servedAt: CURRENT.validUntil + 60 }));
  const { store } = scripted(first, stale);
  await store.ensure();
  assert.equal(store.getSnapshot().source, 'server');
  await store.refresh();
  assert.equal(store.getSnapshot().source, 'server_neutral');
  assert.equal(store.getSnapshot().method, null);
  assert.deepEqual(idsOf(store.getSnapshot()), [A.poolId, B.poolId]);
});

test('before its first answer the store paints the embedded list; a read that throws settles on it', async () => {
  const { store } = scripted(() => Promise.reject(new Error('boom')));
  assert.equal(store.getSnapshot().settled, false);
  assert.deepEqual(idsOf(store.getSnapshot()), SELECTED_POOLS);
  const settled = await store.ensure();
  assert.equal(settled.settled, true);
  assert.equal(settled.source, 'bundled');
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

test('the list first, then the markets of its pools; a refresh never reorders, applies a removal, and none switches to the embedded list', async () => {
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
  assert.deepEqual(rows(), [P.poolId, Q.poolId, R.poolId], 'no reorder on the refresh');
  minute(); done = settle(); provider.refresh(); await done;
  assert.deepEqual(rows(), [P.poolId, R.poolId], 'the removal, on the refresh that saw it');
  minute(); done = settle(); provider.refresh(); await done;
  assert.equal(store.getSnapshot().source, 'bundled');
  assert.deepEqual(calls.filter((c) => c.path === '/api/read/v3/overview').at(-1).body.poolIds, SELECTED_POOLS, 'none: the embedded list is read at once');
  assert.deepEqual(rows(), SELECTED_POOLS);
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

// --- entries, links, labels and New position ---

test('an entry names its symbols as untrusted labels, its fee as fee.ts writes it, its key, and its pinned mark; its link names USDG', () => {
  const [pinned, ranked] = CURRENT.pools.map(featured.entryOf);
  assert.deepEqual(pinned.labels, ['PONS', 'USDG']);
  assert.equal(pinned.fee, '0.30%');
  assert.equal(pinned.pinned, true);
  assert.equal(ranked.pinned, undefined);
  assert.equal(ranked.rankApr, '546.1');
  assert.deepEqual(pinned.artwork, [null, 'USDG']);
  assert.equal(referenceToken(pinned.addresses), USDG);
  assert.equal(referenceToken([NATIVE_ETH, addr('11')]), addr('11'), 'never native ETH: it names no contract');
  assert.equal(referenceToken([NATIVE_ETH, WETH]), WETH);
  const listings = poolListings([], [pinned, ranked]);
  assert.deepEqual(listings.map((l) => l.token), [USDG, USDG]);
  assert.deepEqual(poolListings([], SELECTED_POOL_CATALOGUE).map((l) => l.token), SELECTED_POOLS.map(() => USDG), 'every embedded row links with USDG');
});

test('the embedded labels are keyed by pool id, so a new order cannot move a label onto another pool', () => {
  const source = readFileSync(new URL('../src/config/selectedPoolCatalogue.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /LABELS\[index\]/);
  assert.deepEqual(SELECTED_POOL_CATALOGUE.map((entry) => entry.poolId), SELECTED_POOLS, 'every reviewed pool has its labels');
  const byId = Object.fromEntries(SELECTED_POOL_CATALOGUE.map((entry) => [entry.poolId, entry.labels.join('/')]));
  assert.equal(byId['0x84bd4e2d8be11aeb0afc1195b38f587b61e90068548f1063fdbe448fb8cad0b6'], 'WETH/USDG');
  assert.equal(byId['0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a'], 'PONS/USDG');
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
