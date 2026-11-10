import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as v1 from '../../api-contracts/read-v1/runtime.mjs';
import * as v2 from '../../api-contracts/read-v2/runtime.mjs';
import * as v3 from '../../api-contracts/read-v3/runtime.mjs';

const require = createRequire(import.meta.url);
const built = name => require(`../.test-build/app/src/lib/read/${name}.js`);
const { createBridgeSource } = built('bridgeSource');
const { createEstimateSource } = built('estimateSource');
const { createPublicSource } = built('publicSource');
const { createPublicMetadataCache } = built('publicMetadataCache');
const { createScheduledSource } = built('scheduler');
const { loadSelectedPools, createReadMarketsProvider } = built('marketsProvider');
const { overviewRows, overviewPoolOption } = built('publicOverview');
const { GATE_REFUSAL } = built('interpret');
const fixture = route => JSON.parse(readFileSync(new URL(`../../api-contracts/read-v3/fixtures/${route}.json`, import.meta.url), 'utf8'));
const initial = fixture('overview');
const pool = initial.pools[0].poolId;
const token = initial.tokens[0].address;

test('stored APR age is counted once and still expires on its monotonic deadline', () => {
  const data = fixture('overview'), at = 100_000;
  data.generatedAt = data.pools[0].observedAt + 14;
  const p = data.pools[0].value.estimate.provenance;
  p.effectiveMarketAgeSeconds = 14; p.snapshotAgeSeconds = 14;
  const provenance = { transport: 'bridge', receivedAt: at, receivedMonotonic: at, attempts: 1 };
  const row = overviewRows({ data, provenance })[0];
  const { presentAprEstimate } = built('aprEstimate');
  const read = ms => presentAprEstimate(row.feeAprEstimate, { wall: 999999999, monotonic: at + ms });
  assert.equal(read(0).ageSeconds, 14, 'not 28 seconds');
  assert.equal(read(45_000).ageSeconds, 59);
  assert.equal(read(286_000).text !== null, true, 'the original 300-second boundary is retained');
  assert.equal(read(287_000).text, null, 'expired data is never promoted to current');
  assert.equal(row.poolState.servedAgeSeconds, 14, 'pool state keeps its own stored observation age');
});

test('a successful disabled capability answer is renewed after sixty seconds, shared by concurrent callers', async () => {
  let at = 0, enabled = false, calls = 0;
  const clock = { ...built('pipeline').realClock, now: () => at, monotonic: () => at };
  const source = createBridgeSource({ enabled: true, validators: v3, namespace: 'v3', clock, fetch: async () => {
    calls++; const data = fixture('capabilities');
    if (!enabled) { data.dataMode = 'disabled'; data.enabledReads = []; }
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': v3.CONTRACT_VERSION } });
  } });
  assert.equal((await source.routeEnabled('overview')).outcome.state, 'disabled');
  enabled = true; at = 59_999;
  assert.equal((await source.routeEnabled('overview')).outcome.state, 'disabled');
  at = 60_000;
  const result = await Promise.all([source.routeEnabled('overview'), source.routeEnabled('overview')]);
  assert.ok(result.every(value => value.state === 'enabled'));
  assert.equal(calls, 2);
});

function setup({ answer = () => fixture('overview'), enabled = true, clock } = {}) {
  const calls = [];
  const fetch = async (path, init) => {
    calls.push({ path, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    let response;
    if (path === '/api/read/v3/capabilities') {
      response = fixture('capabilities');
      if (!enabled) { response.dataMode = 'disabled'; response.enabledReads = []; }
    } else if (path === '/api/read/v3/overview') response = answer();
    else throw new Error(`unexpected read: ${path}`);
    return response instanceof Response ? response : new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': v3.CONTRACT_VERSION } });
  };
  const options = { enabled: true, validators: v1, fetch, clock };
  const publicSource = createPublicSource(createEstimateSource(options, v2), options, v3);
  const source = createPublicMetadataCache(createScheduledSource(publicSource, { minIntervalMs: 0, budget: null, clock }), clock);
  return { source, calls };
}

test('stored table gets metadata and APR in one overview POST, retains original observation age and makes no provider fanout', async () => {
  const data = fixture('overview'); data.generatedAt += 40;
  const { source, calls } = setup({ answer: () => data });
  const loaded = await loadSelectedPools(source, [pool], undefined, undefined, { overview: true });
  assert.equal(loaded.rows.length, 1);
  assert.deepEqual(calls.map(c => c.path), ['/api/read/v3/capabilities', '/api/read/v3/overview']);
  assert.equal(loaded.rows[0].feeAprEstimate.data.feeAprEstimate24hPercent, data.pools[0].value.estimate.feeAprEstimate24hPercent);
  assert.equal(Object.values(loaded.rows[0].tokens).find(asset => asset.address === token).decimals, 6);
  const read = await source.read('overview', { poolIds: [pool] });
  assert.equal(calls.length, 2, 'the following page reuses its just-read bundle briefly');
  const row = overviewRows(read)[0];
  assert.equal(row.provenance.market.receivedAt, read.provenance.receivedAt, 'market/APR ages already include stored age');
  const option = overviewPoolOption(read, pool);
  assert.equal(option.kind, 'stored'); assert.equal(option.block, data.pools[0].value.market.snapshot.number);
  assert.equal(option.readAt, read.provenance.receivedAt - 40_000, 'pool state still retains its actual observation age');
  assert.equal(option.catalogue, null, 'a stored observation is not fabricated catalogue provenance');
  const metadata = await source.read('token', { token });
  assert.equal(metadata.state, 'ok'); assert.equal(calls.length, 2, 'metadata is reusable outside the table');
  assert.equal(metadata.provenance.receivedAt, read.provenance.receivedAt - 40_000);
});

test('a bad overview identity, a gate refusal, or invalid nested APR never triggers fallback reads', async () => {
  for (const answer of [
    () => ({ ...fixture('overview'), requestedPoolIds: [] }),
    () => new Response(GATE_REFUSAL, { status: 401, headers: { 'Content-Type': 'application/json' } }),
    () => { const data = fixture('overview'); data.pools[0].value.estimate.feeAprEstimate24hPercent = '999'; return data; },
  ]) {
    const { source, calls } = setup({ answer });
    const loaded = await loadSelectedPools(source, [pool], undefined, undefined, { overview: true });
    assert.equal(loaded.rows.length, 0);
    assert.ok(loaded.blocking || loaded.problems.length);
    assert.deepEqual(calls.map(c => c.path), ['/api/read/v3/capabilities', '/api/read/v3/overview']);
  }
});

test('disabled V3 capability permits the older read path without a V3 POST', async () => {
  const { source, calls } = setup({ enabled: false });
  assert.equal((await source.routeEnabled('overview')).state, 'not_enabled');
  assert.equal((await source.routeEnabled('overview')).state, 'not_enabled');
  assert.deepEqual(calls.map(c => c.path), ['/api/read/v3/capabilities']);
});

test('V3 and legacy reads share one queue, exact-request coalescing and request cancellation', async () => {
  let release;
  const arrived = new Promise(done => { release = done; });
  const calls = [];
  const base = setup();
  const combined = {
    transport: 'bridge',
    routeEnabled: base.source.routeEnabled,
    async read(route, request, options) {
      calls.push(route);
      if (route === 'overview') { await arrived; return base.source.read(route, request, options); }
      return { route, state: 'aborted', provenance: { transport: 'bridge', contract: null, receivedAt: 0, attempts: 0 } };
    },
  };
  const source = createScheduledSource(combined, { minIntervalMs: 0, budget: null });
  const first = source.read('overview', { poolIds: [pool] });
  const second = source.read('overview', { poolIds: [pool] });
  const old = source.read('token', { token });
  assert.deepEqual(calls, ['overview']);
  release();
  const outcomes = await Promise.all([first, second, old]);
  assert.equal(outcomes[0].state, 'ok'); assert.equal(outcomes[1].state, 'ok');
  assert.deepEqual(calls, ['overview', 'token']);
});

test('pending acquisition is explicit and does not require keeping a component open to finish backend work', async () => {
  const pending = fixture('overview');
  for (const entry of [...pending.pools, ...pending.tokens]) {
    entry.value = null; entry.observedAt = null;
    entry.acquisition = { status: 'pending', refreshing: false, reason: null, nextAttemptAt: null };
  }
  const { source, calls } = setup({ answer: () => pending });
  const provider = createReadMarketsProvider({ source, poolIds: [pool], kind: 'bridge' });
  const state = await new Promise(resolve => {
    const stop = provider.subscribe(() => { const state = provider.getSnapshot(); if (state.phase !== 'loading') { stop(); resolve(state); } });
    provider.ensure();
  });
  assert.equal(state.phase, 'ready'); assert.equal(state.acquiring, true);
  assert.equal(state.result.markets.length, 0, 'no synthetic zero or fake metadata');
  assert.equal(calls.filter(c => c.method === 'POST').length, 1);
});

test('legacy source still rejects V3 routes through its original contract', async () => {
  const source = createBridgeSource({ enabled: true, validators: v1, fetch: () => { throw new Error('no request should escape'); } });
  assert.equal((await source.read('overview', { poolIds: [pool] })).state, 'invalid');
});

// Added 2026-09-20. The producer publishes exactly when it will try an
// acquisition again (Acquisition.nextAttemptAt) and whether one is in flight
// (refreshing). The provider ignored both and invented
// `5000 * 2 ** min(acquisitionChecks++, 4)`, which line 684 plus refreshMs made
// unreachable anyway. The trap in using nextAttemptAt is that it is the read
// service's wall clock: comparing it to the browser's would import arbitrary
// skew into a schedule, which figures.ts forbids outright. The same reply
// carries generatedAt, so the wait is derived entirely in server time.
test('the acquisition wait comes from the producer’s own schedule, in server time, never from this browser’s clock', () => {
  const provider = readFileSync(new URL('../src/lib/read/marketsProvider.ts', import.meta.url), 'utf8');
  const scheduling = provider.slice(provider.indexOf('const waiting ='), provider.indexOf('const set = ('));

  assert.match(scheduling, /Math\.min\(\.\.\.due\) - overview\.data\.generatedAt/, 'the delay is a difference of two server times');
  assert.doesNotMatch(scheduling, /Date\.now\(\)|clock\.wall/, 'no browser clock anywhere near the schedule');
  assert.match(scheduling, /acquisition\.refreshing/, 'a lease in flight is honoured');
  assert.match(scheduling, /ACQUISITION_FLOOR_MS = 5000/, 'there is a floor');
  assert.match(scheduling, /Math\.min\(activeRefreshMs, Math\.max\(ACQUISITION_FLOOR_MS, schedule\.inMs\)\)/, 'and a ceiling, so a long backoff parks no long timer');
  assert.doesNotMatch(provider, /acquisitionChecks/, 'the unreachable invented backoff is gone, not left beside its replacement');
  // The soonest pending entry sets the pace, so one slow row cannot stall the page.
  assert.match(scheduling, /due\.length \? Math\.max\(0, Math\.min\(\.\.\.due\)/);
});

// Added 2026-09-20 after watching it happen. rugged's development reader has no
// /internal/read/v3 route yet: it answers 404 with an empty body. The bridge
// calls that `invalid`, `invalid` is a blocking outcome, and the markets table
// stopped with no rows and no retry — while every read-v1 and read-v2 call
// beside it answered 200 with real figures. read-v3 is an addition over a
// complete read path; it must never be able to take the page down with it.
test('read-v3 failing does not take the page down when V1/V2 can still serve it', async () => {
  const gone = async (path, init) => {
    if (path.startsWith('/api/read/v3/')) return new Response('', { status: 404 });
    return new Response(JSON.stringify(fixture('capabilities')), { headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': v3.CONTRACT_VERSION } });
  };
  const options = { enabled: true, validators: v1, fetch: gone };
  const legacy = { transport: 'bridge', read: async () => ({ state: 'ok', route: 'pools', data: {} }), routeEnabled: async () => ({ state: 'enabled' }) };
  const source = createPublicSource(legacy, options, v3);
  const check = await source.routeEnabled('overview', {});
  assert.equal(check.state, 'not_enabled', 'a reader without the namespace falls back, it does not fail the page');
  // A legacy route is untouched by any of this.
  assert.deepEqual(await source.routeEnabled('pools', {}), { state: 'enabled' });
});

// Added 2026-09-28 (speed wave, item 3). One edge page on the read-v3 capabilities GET sent Home's table down the older
// path: one v2 provider read per pool, 4.9 s each, the table in 10 to 38 s instead of about 1 s (measured in the
// study's harness: the sixth row at 32.4 s). A failure that can pass by itself is asked again at once, twice at most;
// only an answer that says no (or a final failure, the development reader's empty 404 among them) sends the page to
// V1/V2, and a failure that is still passing is the table's to ask again (FAILED_RETRY_MS), not a reason to fan out.
test('a read-v3 capabilities check that fails in passing is asked again at once; still failing, it is a failure, never the older path', async () => {
  const caps = () => new Response(JSON.stringify(fixture('capabilities')), { headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': v3.CONTRACT_VERSION } });
  const edgePage = () => new Response('<html>502</html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
  const legacy = { transport: 'bridge', read: async () => assert.fail('no legacy read'), routeEnabled: async () => ({ state: 'enabled' }) };
  const sourceWith = (answers) => {
    const gets = [];
    const fetch = async (path) => { gets.push(path); return (answers.shift() ?? caps)(); };
    return { gets, source: createPublicSource(legacy, { enabled: true, validators: v1, fetch }, v3) };
  };
  const once = sourceWith([edgePage]);
  assert.deepEqual(await once.source.routeEnabled('overview', {}), { state: 'enabled' }, 'one edge page, then the answer');
  assert.equal(once.gets.length, 2);
  const down = sourceWith([edgePage, edgePage, edgePage, edgePage]);
  const failed = await down.source.routeEnabled('overview', {});
  assert.deepEqual([failed.state, failed.outcome.state, failed.outcome.cause.kind, failed.outcome.cause.status], ['failed', 'unavailable', 'edge', 502]);
  assert.equal(down.gets.length, 3, 'asked twice more, and no more');
  // The development reader's empty 404 is final: the older path at once, asked once.
  const gone = sourceWith([() => new Response('', { status: 404 })]);
  assert.deepEqual(await gone.source.routeEnabled('overview', {}), { state: 'not_enabled' });
  assert.equal(gone.gets.length, 1);
  // A cancelled check is a cancelled check.
  const leaving = new AbortController();
  leaving.abort();
  assert.equal((await sourceWith([]).source.routeEnabled('overview', { signal: leaving.signal })).outcome.state, 'aborted');

  // The table: one edge page, then the overview, and never a provider read.
  const wire = [];
  let v3caps = 0;
  const fetch = async (path, init) => {
    wire.push(path);
    if (path === '/api/read/v3/capabilities') return (v3caps++ === 0 ? edgePage : caps)();
    if (path === '/api/read/v3/overview') return new Response(JSON.stringify({ ...fixture('overview'), requestedPoolIds: JSON.parse(init.body).poolIds }), { headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': v3.CONTRACT_VERSION } });
    return assert.fail(`unexpected ${path}`);
  };
  const options = { enabled: true, validators: v1, fetch };
  const table = createPublicMetadataCache(createScheduledSource(createPublicSource(createEstimateSource(options, v2), options, v3), { minIntervalMs: 0, budget: null, unspacedStored: true, width: 2 }));
  const loaded = await loadSelectedPools(table, [pool], undefined, undefined, { overview: true });
  assert.equal(loaded.rows.length, 1);
  assert.deepEqual(wire, ['/api/read/v3/capabilities', '/api/read/v3/capabilities', '/api/read/v3/overview']);
});

// Added 2026-09-28 (speed wave, item 6): a pool's page opened from Home or Markets asked again for what they had just
// read, its overview and its 24h chart (activity 3.2 s after the click from Markets, in the study's harness).
test('a pool’s overview is cut from the table’s, once, within 30 s; a card’s 24h history answers the chart’s identical question for 30 s', async () => {
  const { overviewFor: many } = await import('./markets-cards.fixtures.mjs');
  const [P, Q] = [`0x${'a1'.repeat(32)}`, `0x${'b2'.repeat(32)}`];
  let steady = 0;
  const clock = { now: () => 1_000_000 + steady, monotonic: () => steady, random: () => 0, timer: () => () => {}, sleep: async () => {} };
  const posts = [];
  const provenance = () => ({ transport: 'bridge', contract: v3.CONTRACT_VERSION, receivedAt: 1_000_000 + steady, receivedMonotonic: steady, attempts: 1 });
  const source = { transport: 'bridge', supportsStoredReads: true, read: async (route, request) => {
    posts.push([route, request]);
    const data = route === 'overview' ? { ...many(request), acquisitionAccepted: false } : { history: request };
    return { route, state: 'ok', data, observation: { block: null, providers: [] }, provenance: provenance() };
  } };
  const cache = createPublicMetadataCache(source, clock);
  const table = await cache.read('overview', { poolIds: [P, Q] });
  steady += 10_000;
  const slice = await cache.read('overview', { poolIds: [Q] });
  assert.equal(posts.length, 1, 'no second overview');
  assert.deepEqual(slice.data.requestedPoolIds, [Q]);
  assert.deepEqual(slice.data.pools.map((entry) => entry.poolId), [Q]);
  assert.equal(slice.data.acquisitionAccepted, false, 'the answer’s own acquisitionAccepted');
  const currencies = slice.data.pools[0].value.market.pool.currencies;
  assert.ok(slice.data.tokens.length > 0 && slice.data.tokens.every((entry) => currencies.includes(entry.address)), 'the pool’s own tokens');
  assert.equal(slice.provenance.receivedAt, table.provenance.receivedAt, 'dated as it was read');
  assert.equal(slice.provenance.attempts, 0);
  // The page's own second read (its workspace) joins it; its later reads go to the service.
  await cache.read('overview', { poolIds: [Q] });
  assert.equal(posts.length, 1);
  steady += 5_000;
  await cache.read('overview', { poolIds: [Q] });
  assert.equal(posts.length, 2, 'once per pool and answer');
  // Another pool of the table, past 30 s: asked.
  steady += 16_000;
  await cache.read('overview', { poolIds: [P] });
  assert.equal(posts.length, 3, 'past 30 s the table’s answer is too old');

  const history = { poolId: P, currency: token, windowSeconds: 86400, resolutionSeconds: 3600 };
  const card = await cache.read('history', history);
  steady += 29_000;
  const chart = await cache.read('history', history);
  assert.equal(posts.length, 4, 'the chart’s question, answered by the card’s answer');
  assert.equal(chart.provenance.receivedMonotonic, card.provenance.receivedMonotonic);
  await cache.read('history', { ...history, windowSeconds: 604800 });
  assert.equal(posts.length, 5, 'another window is another question');
  steady += 1_000;
  await cache.read('history', history);
  assert.equal(posts.length, 6, 'past 30 s it is asked');
});

// Added 2026-09-28 after review (speed wave, item 45): a built history the edge kept (functions/api/read/v3/history.ts)
// comes back with X-Domino-Edge-Cache: hit; through the real read-v3 source and the queue, that answer gives its read
// back, and one the Worker made keeps it.
test('a v3 history answered from the edge cache, through the read-v3 source and the queue, is marked edge and gives its read back', async () => {
  const history = fixture('history');
  const request = { poolId: history.poolId, currency: history.currency, windowSeconds: 86400, resolutionSeconds: 3600 };
  const run = async (hit) => {
    const clock = { now: () => 1_000, monotonic: () => 0, random: () => 0, timer: () => () => {}, sleep: async () => {} };
    let kept = null;
    const store = { load: () => kept, save: (state) => { kept = state; } };
    const fetch = async (path) => {
      const body = path === '/api/read/v3/capabilities' ? fixture('capabilities') : path === '/api/read/v3/history' ? history : assert.fail(`unexpected read: ${path}`);
      const headers = { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': v3.CONTRACT_VERSION, ...(hit && path.endsWith('/history') ? { 'X-Domino-Edge-Cache': 'hit' } : {}) };
      return new Response(JSON.stringify(body), { headers });
    };
    const options = { enabled: true, validators: v1, fetch, clock };
    const queue = createScheduledSource(createPublicSource(createEstimateSource(options, v2), options, v3), { clock, budgetStore: store, minIntervalMs: 0, refusedIntervalMs: 1100, unspacedStored: true, width: 2 });
    const outcome = await queue.read('history', request);
    return { state: outcome.state, edge: outcome.provenance.edge ?? null, tokens: kept?.tokens };
  };
  assert.deepEqual(await run(true), { state: 'ok', edge: true, tokens: 5 }, 'the edge answered: the budget whole');
  assert.deepEqual(await run(false), { state: 'ok', edge: null, tokens: 4 }, 'the Worker answered: one read spent');
});

// Added 2026-09-28 (speed wave, item 44): a pool's page paints from this browser's copy of the last overview.
test('paintedPool: the copy names the pool with the token the page verifies it against, dated as it was read; nothing else', () => {
  const { paintedPool } = built('publicOverview');
  const data = fixture('overview');
  const held = data.pools[0].value.market.pool.currencies[0].toLowerCase();
  const memory = { load: () => ({ data, provenance: { transport: 'bridge', contract: v3.CONTRACT_VERSION, receivedAt: 5, attempts: 0 } }) };
  const hit = paintedPool(memory, pool, held);
  assert.equal(hit.option.key, pool);
  assert.equal(hit.overview.state, 'ok');
  assert.equal(hit.overview.provenance.receivedAt, 5, 'dated as it was read');
  assert.equal(paintedPool(memory, pool, `0x${'9'.repeat(40)}`), null, 'another token: nothing');
  assert.equal(paintedPool(memory, `0x${'9'.repeat(64)}`, held), null, 'another pool: nothing');
  assert.equal(paintedPool({ load: () => null }, pool, held), null, 'no copy: nothing');
  assert.equal(paintedPool(null, pool, held), null, 'a build that keeps none: nothing');
});

test('a gate failure on read-v3 is still a failure: signing in is the way out, not another route', async () => {
  const source = readFileSync(new URL('../src/lib/read/publicSource.ts', import.meta.url), 'utf8');
  assert.match(source, /const GATE = new Set\(\['gate_required', 'gate_unavailable', 'access_required'\]\)/);
  assert.match(source, /!GATE\.has\(check\.outcome\.state\)/, 'everything but a gate state falls back');
});

// Added 2026-09-20. An adversarial pass raised this as a gap: the v1/v2 path
// binds a pool-market reply's inner provider block to the pool it claims to be
// about (interpret.ts, the 'pool-market' case), and the stored v3 path appeared
// not to. Tested directly, it is NOT a gap — read-v3's own runtime refuses all
// three forgeries before our code sees them. These pin that guarantee, so if it
// ever weakens on the producer's side we find out here rather than by rendering
// one pool's figures under another pool's name.
test('read-v3 refuses an overview whose stored figures belong to another pool or token', () => {
  const intact = fixture('overview');
  assert.equal(v3.validateResponse('overview', intact), true, 'the fixture itself is admitted');

  const movedPool = fixture('overview');
  const entry = movedPool.pools.find((row) => row.value);
  assert.ok(entry, 'the fixture has a pool with a stored market');
  entry.value.market.market.data.poolId = `0x${'cd'.repeat(32)}`;
  assert.equal(v3.validateResponse('overview', movedPool), false, 'a provider block about another pool');

  const movedCurrencies = fixture('overview');
  movedCurrencies.pools.find((row) => row.value).value.market.market.data.currencies = [`0x${'ee'.repeat(20)}`, `0x${'ff'.repeat(20)}`];
  assert.equal(v3.validateResponse('overview', movedCurrencies), false, 'a provider block about other currencies');

  const movedToken = fixture('overview');
  const holder = movedToken.tokens.find((row) => row.value);
  assert.ok(holder, 'the fixture has a token with a stored value');
  holder.value.asset.address = `0x${'ab'.repeat(20)}`;
  assert.equal(v3.validateResponse('overview', movedToken), false, 'a token value about another address');
});

// Changed on purpose 2026-09-24 (marketsProvider.ts, where activeRefreshMs is
// set). A settled stored overview was asked again every five seconds: about
// eleven extra reads a minute through the tab's one queue and its 30-a-minute
// budget, ahead of the Markets cards' own reads. It now waits the ordinary
// minute; only a load still acquiring keeps the five-second floor.
test('a settled stored overview is asked again after a minute, not every five seconds; one still acquiring keeps its five-second floor', async () => {
  const refreshAfter = async (answer) => {
    const timers = [];
    const clock = { now: () => 1_010_000, monotonic: () => 0, random: () => 0,
      sleep: (_ms, signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })),
      timer: (ms) => { timers.push(ms); return () => {}; } };
    const { source } = setup({ answer, clock });
    const provider = createReadMarketsProvider({ source, poolIds: [pool], kind: 'bridge', clock, refreshMs: 60_000, visibility: { hidden: () => false, onChange: () => () => {} } });
    await new Promise(resolve => {
      const stop = provider.subscribe(() => { if (provider.getSnapshot().phase !== 'loading') { stop(); resolve(); } });
      provider.ensure();
    });
    const before = timers.length;
    const release = provider.recoverQuietly();
    const planned = timers.slice(before);
    release();
    return planned;
  };
  assert.deepEqual(await refreshAfter(() => fixture('overview')), [60_000]);
  const pending = fixture('overview');
  for (const entry of [...pending.pools, ...pending.tokens]) {
    entry.value = null; entry.observedAt = null;
    entry.acquisition = { status: 'pending', refreshing: false, reason: null, nextAttemptAt: null };
  }
  assert.deepEqual(await refreshAfter(() => pending), [5_000]);
});

// ---------------------------------------------------------------------------
// Added 2026-09-25 (r4/metrics). The owner, on production: Home's Selected pools
// TVL, 24h volume and APR, and the ticker's APR, took long to appear; ETH/USDG
// and PONS/USDG said "Unavailable" on Home while Markets had their figures. The
// production tail showed the six Markets cards' stored history reads going out
// 1.1 s and then 2 s apart, one at a time, with the table's overview queued
// behind all six (13:07:06-13:07:18 UTC). Two causes on our side, both pinned
// here: the queue spaced stored reads for a rule the gateway's stored lane does
// not have and gave the table no precedence; and an overview that served pools
// without figures the store was about to collect was asked again only a minute
// later. support/stale-store.mjs builds that store answer.
// ---------------------------------------------------------------------------
const { STORED_LANE } = built('scheduler');
const { CATCH_UP_BACKOFF, CATCH_UP_FLOOR_MS, CATCH_UP_MARGIN_MS, CATCH_UP_SHOWN_MS, CATCH_UP_WINDOW_MS, retainRowAsStale } = built('marketsProvider');
const { withStalePools } = await import('./support/stale-store.mjs');

/** Monotonic ms that only a sleep moves: every sleep ends at once, as in read.test.mjs's fakeClock. */
function instantClock() {
  let steady = 0;
  return { now: () => steady, monotonic: () => steady, random: () => 0, timer: () => () => {},
    sleep: async (ms, signal) => { if (signal?.aborted) throw signal.reason; steady += ms; } };
}
/** Monotonic ms moved by `advance` alone; a sleep waits for it, or for its signal. */
function steppedClock() {
  let steady = 0;
  const sleepers = new Set();
  return {
    now: () => steady, monotonic: () => steady, random: () => 0, timer: () => () => {},
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      if (signal?.aborted) { reject(signal.reason); return; }
      const sleeper = { at: steady + ms, resolve };
      sleepers.add(sleeper);
      signal?.addEventListener('abort', () => { sleepers.delete(sleeper); reject(signal.reason); }, { once: true });
    }),
    advance(ms) { steady += ms; for (const sleeper of [...sleepers]) if (sleeper.at <= steady) { sleepers.delete(sleeper); sleeper.resolve(); } },
    get sleeping() { return sleepers.size; },
  };
}
const turn = () => new Promise((resolve) => setTimeout(resolve, 0));
/** A source that answers at once, one attempt a read, and logs each start. */
function startsOn(clock, hold = () => null) {
  const starts = [];
  return { starts, source: { transport: 'bridge', read: async (route, request, opts = {}) => {
    starts.push([route, clock.monotonic()]);
    opts.onAttempt?.();
    await hold(route, request);
    return { route, state: 'ok', data: {}, provenance: {} };
  } } };
}
const historyOf = (i) => ({ poolId: `0x${(i + 1).toString(16).padStart(64, '0')}`, currency: token, windowSeconds: 86400, resolutionSeconds: 3600 });
const tokenOf = (i) => ({ token: `0x${(i + 1).toString(16).padStart(40, '0')}` });

test('stored reads skip the provider lane’s 1.1 s and wait for the tab’s budget alone; provider-lane reads keep 1.1 s among themselves', async () => {
  // Changed on purpose (2026-09-26, featured pools v1 §11.1): read-v5's featured list is a stored read on the same lane.
  assert.deepEqual([...STORED_LANE].sort(), ['featured-pools', 'history', 'overview', 'search'], 'the stored routes: the gateway’s stored lane, four slots and no start interval');

  // Markets opening: the table’s overview, then the six cards’ histories, then two provider-lane reads.
  const clock = instantClock();
  const { starts, source } = startsOn(clock);
  const queue = createScheduledSource(source, { clock, unspacedStored: true });
  await queue.read('overview', { poolIds: [pool] });
  for (let i = 0; i < 6; i++) await queue.read('history', historyOf(i));
  await queue.read('token', tokenOf(0));
  await queue.read('token', tokenOf(1));
  // Five in the burst less the quarter kept in hand: four at once, then the budget’s own pace (half a read a
  // second). The provider-lane reads wait for the budget too, and 1.1 s between their own starts.
  assert.deepEqual(starts.map(([, at]) => at), [0, 0, 0, 0, 500, 2500, 4500, 6500, 8500]);
  // Never more than the gateway admits: a burst of five, then 30 a minute.
  let tokens = 5, last = 0;
  for (const [, at] of starts) { tokens = Math.min(5, tokens + (at - last) / 2000); last = at; tokens -= 1; assert.ok(tokens >= 0, `over budget at ${at} ms`); }

  // Before (and still for local-live): every read 1.1 s after the one before, the cards done at 6.6 s at best.
  const spacedClock = instantClock();
  const spaced = startsOn(spacedClock);
  const spacedQueue = createScheduledSource(spaced.source, { clock: spacedClock });
  await spacedQueue.read('overview', { poolIds: [pool] });
  for (let i = 0; i < 6; i++) await spacedQueue.read('history', historyOf(i));
  for (let i = 1; i < spaced.starts.length; i++) assert.ok(spaced.starts[i][1] - spaced.starts[i - 1][1] >= 1100, `${spaced.starts}`);
  assert.ok(spaced.starts.at(-1)[1] >= 6600);

  // A stored read neither waits for the spacing nor moves it on.
  const bareClock = instantClock();
  const bare = startsOn(bareClock);
  const bareQueue = createScheduledSource(bare.source, { clock: bareClock, budget: null, unspacedStored: true });
  await bareQueue.read('token', tokenOf(0));
  await bareQueue.read('history', historyOf(0));
  await bareQueue.read('token', tokenOf(1));
  assert.deepEqual(bare.starts, [['token', 0], ['history', 0], ['token', 1100]]);
});

test('a read asked first goes before queued reads, even one already waiting for its turn on the wire', async () => {
  // Markets coming back: a card’s history on the wire, the next one waiting for the budget, then the table’s refresh.
  const clock = steppedClock();
  const { starts, source } = startsOn(clock);
  const queue = createScheduledSource(source, { clock, unspacedStored: true, budget: { burst: 2, perMinute: 30 } });
  const cardA = queue.read('history', historyOf(0));
  const cardB = queue.read('history', historyOf(1));
  await turn();
  assert.equal(clock.sleeping, 1, 'the second card waits for the budget');
  const table = queue.read('overview', { poolIds: [pool] }, { priority: 'first' });
  await turn();
  clock.advance(500);
  await turn();
  clock.advance(2000);
  await turn();
  await Promise.all([cardA, cardB, table]);
  assert.deepEqual(starts, [['history', 0], ['overview', 500], ['history', 2500]], 'the table took the waiting card’s turn; the card went next');

  // A queued read joined by a reader asked first moves up with it; reads asked first keep their own order.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const joinClock = steppedClock();
  const joined = startsOn(joinClock, (route) => (route === 'search' ? held : null));
  const joinQueue = createScheduledSource(joined.source, { clock: joinClock, budget: null, minIntervalMs: 0, unspacedStored: true });
  const running = joinQueue.read('search', { query: 'usdg', limit: 20 });
  const later = joinQueue.read('history', historyOf(3));
  const queued = joinQueue.read('history', historyOf(2));
  const again = joinQueue.read('history', historyOf(2), { priority: 'first' });
  const firstToo = joinQueue.read('overview', { poolIds: [pool] }, { priority: 'first' });
  await turn();
  release();
  await Promise.all([running, later, queued, again, firstToo]);
  assert.deepEqual(joined.starts.map(([route]) => route), ['search', 'history', 'overview', 'history']);
  assert.deepEqual(joined.starts.length, 4, 'the joined read went out once');
});

test('a reader asked first that joins a read already waiting for its turn keeps that turn for it', async () => {
  // Fixed 2026-09-25 after review. A card's history waits for the budget, out of the queue; the table asks the same
  // read first, then its own overview first. The history keeps its turn instead of being woken and sent behind.
  const clock = steppedClock();
  const { starts, source } = startsOn(clock);
  const queue = createScheduledSource(source, { clock, unspacedStored: true, budget: { burst: 2, perMinute: 30 } });
  const cardA = queue.read('history', historyOf(0));
  const cardB = queue.read('history', historyOf(1));
  await turn();
  assert.equal(clock.sleeping, 1, 'the second card waits for the budget');
  const joiner = queue.read('history', historyOf(1), { priority: 'first' });
  const table = queue.read('overview', { poolIds: [pool] }, { priority: 'first' });
  await turn();
  clock.advance(500);
  await turn();
  clock.advance(2000);
  await turn();
  await Promise.all([cardA, cardB, joiner, table]);
  assert.deepEqual(starts, [['history', 0], ['history', 500], ['overview', 2500]]);
});

test('the markets provider asks every read of its load first', () => {
  const provider = readFileSync(new URL('../src/lib/read/marketsProvider.ts', import.meta.url), 'utf8');
  const load = provider.slice(provider.indexOf('async function readMarkets('), provider.indexOf('export async function loadSelectedPools('));
  const reads = load.match(/source\.read\([^)]*\)[^\n]*/g) ?? [];
  assert.ok(reads.length >= 5, `${reads.length} reads found`);
  for (const read of reads) assert.match(read, /, asked\)/, read);
  // Changed on purpose 2026-09-28 (speed wave, item 11): a refresh of rows already settled on screen is not asked first.
  assert.match(load, /const asked = options\.inPlace \? \{ signal \} : \{ signal, priority: 'first' as const \}/);
});

// Added 2026-09-28 (speed wave, items 2 and 11), measured with the study's latencies: a row the provider was busy for
// was asked again through its v2 market read (4.9 s on the provider lane, then a token read and a card history for a
// row of another shape), and every catch-up ask of settled rows went first, ahead of the next page's reads.
test('a stored table asks a busy provider row again through the overview, and its refreshes do not go first', async () => {
  const { generatedAt } = fixture('overview');
  const five = [0, 3, 6, 10, 17].map((s) => limited({ refreshing: true, observedAt: generatedAt + s }));
  const busy = await catchUpTrace([...five, caughtUp], { loads: 6 });
  assert.deepEqual(busy.seen.at(-1), figures(60_000), 'the busy row asked again a minute after it was seen, with the figures');
  assert.equal(busy.overviews, 6, 'through the overview');
  assert.equal(busy.fanned, 0, 'no provider read fanned out');
  // Priorities: the first load's reads first, the minute's refresh of the settled rows in line.
  let steady = 0;
  const timers = [];
  const reads = { now: () => 1_010_000 + steady, monotonic: () => steady, random: () => 0, timer: () => () => {},
    sleep: (_ms, signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) };
  const clock = { ...reads, timer: (ms, fire) => { timers.push(() => { steady += ms; fire(); }); return () => {}; } };
  const priorities = [];
  const { source } = setup({ clock: reads });
  const watched = { ...source, read: (route, request, options) => (priorities.push(options?.priority ?? null), source.read(route, request, options)) };
  const provider = createReadMarketsProvider({ source: watched, poolIds: [pool], kind: 'bridge', clock, refreshMs: 60_000, visibility: { hidden: () => false, onChange: () => () => {} } });
  const release = provider.recoverQuietly();
  await new Promise((resolve) => { const stop = provider.subscribe(() => { if (provider.getSnapshot().phase !== 'loading') { stop(); resolve(); } }); provider.ensure(); });
  const before = timers.length;
  timers.at(-1)();
  for (let j = 0; j < 200 && timers.length === before; j++) await turn();
  release();
  assert.deepEqual(priorities, ['first', null], 'the load first; its refresh in line');
});

/**
 * One provider over a store whose overview answers are `answers` in turn (then `after`), held by a table as Home and
 * Markets hold it, its timers fired one at a time. Each look: the timer planned after a load (ms), whether the row
 * waits for its figures, its TVL state, its estimate's status, and the monotonic ms when that load settled.
 */
async function catchUpTrace(answers, { loads = answers.length, after = () => fixture('overview'), holder = true, view = null } = {}) {
  let steady = 0;
  const timers = [];
  // The reads' own deadlines never fire here; the provider's timers are the ones this test fires, one at a time.
  const reads = { now: () => 1_010_000 + steady, monotonic: () => steady, random: () => 0, timer: () => () => {},
    sleep: (_ms, signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) };
  const clock = { ...reads, timer: (ms, fire) => { timers.push({ ms, fire: () => { steady += ms; fire(); } }); return () => {}; } };
  const queued = [...answers];
  const { source, calls } = setup({ clock: reads, answer: () => {
    const answer = (queued.shift() ?? after)();
    assert.equal(v3.validateResponse('overview', answer), true, 'the store’s answer passes read-v3’s own runtime');
    return answer;
  } });
  const provider = createReadMarketsProvider({ source, poolIds: [pool], kind: 'bridge', clock, refreshMs: 60_000, visibility: { hidden: () => false, onChange: () => () => {} } });
  // The table holds the quiet re-asks from its first render, before the first answer lands.
  const release = holder ? provider.recoverQuietly() : () => {};
  await new Promise((resolve) => {
    const stop = provider.subscribe(() => { if (provider.getSnapshot().phase !== 'loading') { stop(); resolve(); } });
    provider.ensure();
  });
  const row = () => provider.getSnapshot().result.markets[0];
  const seen = [];
  // `view` (added 2026-09-28) looks at something else than the row, for a pool that has none yet.
  const look = () => seen.push({ at: steady, next: timers.at(-1)?.ms ?? null, ...(view ? view(provider.getSnapshot()) : { pending: row().figuresPending === true, tvl: row().tvlUsd.state, apr: row().feeAprEstimate.data?.status }) });
  look();
  for (let i = 1; i < loads; i++) {
    const before = timers.length;
    timers.at(-1).fire();
    for (let j = 0; j < 200 && timers.length === before; j++) await turn();
    assert.ok(timers.length > before, 'the load settled and planned its next ask');
    look();
  }
  release();
  return { seen, overviews: calls.filter((call) => call.path === '/api/read/v3/overview').length, fanned: calls.filter((call) => call.method === 'POST' && call.path !== '/api/read/v3/overview').length, row };
}

const behind = (options) => () => withStalePools(fixture('overview'), [pool], options);
const caughtUp = () => fixture('overview');
const waits = (at, next) => ({ at, next, pending: true, tvl: 'unavailable', apr: 'unavailable' });
const says = (at, next) => ({ at, next, pending: false, tvl: 'unavailable', apr: 'unavailable' });
const figures = (at) => ({ at, next: 60_000, pending: false, tvl: 'provider', apr: 'available' });

/**
 * Existing valid producer evidence, still dated and stale; only its stored acquisition schedule varies, and, with `age`
 * (added 2026-10-30, N41 review), how old its provider figures were when served (the fixture's own: 60 s).
 */
const staleFigures = ({ inSeconds = 5, refreshing = false, reason = null, age = null } = {}) => () => {
  const data = fixture('overview');
  data.pools[0].value = JSON.parse(readFileSync(new URL('../../api-contracts/read-v2/fixtures/producer/pool-market.stale.json', import.meta.url), 'utf8'));
  data.pools[0].acquisition = { status: 'ready', refreshing, reason, nextAttemptAt: inSeconds === null ? null : data.generatedAt + inSeconds };
  if (age !== null) {
    const value = data.pools[0].value;
    value.market.market.cache.ageSeconds = age;
    Object.assign(value.estimate.provenance, { cacheAgeSeconds: age, effectiveMarketAgeSeconds: age });
  }
  return data;
};

// Changed on purpose 2026-10-30 (QA round 2, N41): a row that already shows stale figures is no longer asked again
// seconds after each refresh (every minute's overview went out twice); it refreshes at the ordinary minute, silently.
test('stale public figures stay on screen and refresh at the ordinary minute, without masks, changed ages, catch-up asks or provider fanout', async () => {
  const expected = staleFigures()();
  const initial = await catchUpTrace([staleFigures()]);
  assert.deepEqual(initial.seen, [{ at: 0, next: 60_000, pending: false, tvl: 'stale', apr: 'stale' }]);
  assert.equal(initial.row().tvlUsd.value, expected.pools[0].value.market.market.data.reportedLiquidityUsd, 'retain the producer figure');
  assert.deepEqual(initial.row().feeAprEstimate.data, expected.pools[0].value.estimate, 'no change to the estimate, status or original provenance');
  const recovered = await catchUpTrace([staleFigures(), caughtUp]);
  assert.deepEqual(recovered.seen, [{ at: 0, next: 60_000, pending: false, tvl: 'stale', apr: 'stale' }, figures(60_000)]);
  assert.equal(recovered.overviews, 2, 'one overview a minute, no catch-up ask between');
  assert.equal(recovered.fanned, 0);
  const running = await catchUpTrace([staleFigures({ refreshing: true, inSeconds: 30 }), caughtUp]);
  assert.equal(running.seen[0].next, 60_000);
  assert.equal(running.seen[0].pending, false);
});

test('stale public figures are asked once a minute and respect collector failures, distant schedules and no viewers', async () => {
  const stuck = await catchUpTrace([staleFigures(), staleFigures(), staleFigures(), staleFigures(), staleFigures()]);
  assert.deepEqual(stuck.seen.map(({ at, next, pending }) => [at, next, pending]), [
    [0, 60_000, false], [60_000, 60_000, false], [120_000, 60_000, false], [180_000, 60_000, false], [240_000, 60_000, false],
  ]);
  for (const options of [{ reason: 'collection_failed' }, { inSeconds: 120 }, { inSeconds: null }]) {
    const blocked = await catchUpTrace([staleFigures(options)]);
    assert.equal(blocked.seen[0].next, 60_000, JSON.stringify(options));
    assert.equal(blocked.seen[0].pending, false);
  }
  const unseen = await catchUpTrace([staleFigures()], { holder: false });
  assert.equal(unseen.seen[0].next, null, 'no accelerated read without a visible consumer');
  assert.equal(unseen.fanned, 0);
});

// Added 2026-10-30 (N41 review): stale figures that would pass their five minutes before the ordinary refresh lands
// (served at 280 s: the APR estimate would turn to a stand-in on screen, and ask DEX Screener for it) still catch up
// just after the store's collection, as before N41; ones that will still be within it then (230 s) wait for the minute.
test('stale public figures close to their five-minute limit still catch up after the imminent collection; others wait for the minute', async () => {
  const late = staleFigures({ age: 280 });
  const recovered = await catchUpTrace([late, caughtUp]);
  assert.deepEqual(recovered.seen, [{ at: 0, next: 6_500, pending: false, tvl: 'stale', apr: 'stale' }, figures(6_500)], 'kept on screen, no mask, asked just after the collection');
  assert.equal(recovered.overviews, 2);
  assert.equal(recovered.fanned, 0);
  const initial = await catchUpTrace([late]);
  assert.deepEqual(initial.row().feeAprEstimate.data, late().pools[0].value.estimate, 'no change to the estimate or its ages');
  const leased = await catchUpTrace([staleFigures({ age: 280, refreshing: true, inSeconds: 30 }), caughtUp]);
  assert.deepEqual(leased.seen.map(({ at, next, pending }) => [at, next, pending]), [[0, CATCH_UP_FLOOR_MS, false], [CATCH_UP_FLOOR_MS, 60_000, false]]);
  const stuck = await catchUpTrace([late, late, late, late, late]);
  assert.deepEqual(stuck.seen.map(({ at, next, pending }) => [at, next, pending]), [
    [0, 6_500, false], [6_500, 6_500, false], [13_000, 6_500, false], [19_500, 60_000, false], [79_500, 60_000, false],
  ], 'bounded by the catch-up window, as before');
  const unseen = await catchUpTrace([late], { holder: false });
  assert.equal(unseen.seen[0].next, null, 'no accelerated read without a visible consumer');
  const within = await catchUpTrace([staleFigures({ age: 230 }), caughtUp]);
  assert.deepEqual(within.seen, [{ at: 0, next: 60_000, pending: false, tvl: 'stale', apr: 'stale' }, figures(60_000)]);
  assert.equal(within.overviews, 2, 'one overview a minute');
});

test('a pool whose figures aged out waits for them and is asked again just after the store’s collection, not a minute later', async () => {
  const soon = 5_000 + CATCH_UP_MARGIN_MS;
  // The store collects the pool at the 5 s its own demand rule gives it (026_public_demand.sql) and has figures.
  const plain = await catchUpTrace([behind(), caughtUp]);
  assert.deepEqual(plain.seen, [waits(0, soon), figures(soon)]);
  assert.equal(plain.overviews, 2, 'one overview POST a load');
  assert.equal(plain.fanned, 0, 'no provider read fanned out');

  // A lease held is a collection under way: asked again at the floor.
  const leased = await catchUpTrace([behind({ refreshing: true, inSeconds: 30 }), caughtUp]);
  assert.deepEqual(leased.seen, [waits(0, CATCH_UP_FLOOR_MS), figures(CATCH_UP_FLOOR_MS)]);

  // A slow collector (four pools a tick, up to 12 s each): the collection is due, then running, then published.
  // Each ask in a row waits 1.4 times as long as the last: 6.5 s, then 3.5 s, then 4.9 s. Changed on purpose 2026-09-27
  // (r6/marketsdata, the owner: USDG/U sat on loading bars on Home): the placeholder stands only while the next ask
  // falls within CATCH_UP_SHOWN_MS (8 s) of the first; past it the row says what it has while the asks go on.
  const slow = await catchUpTrace([behind(), behind({ inSeconds: 0 }), behind({ refreshing: true }), caughtUp]);
  assert.equal(CATCH_UP_BACKOFF, 1.4);
  assert.deepEqual(slow.seen, [waits(0, 6_500), says(6_500, 3_500), says(10_000, 4_900), figures(14_900)]);
  // Still running at the fourth: asked at 21.76 s, within the window; published by then.
  const later = await catchUpTrace([behind(), behind({ inSeconds: 0 }), behind({ refreshing: true }), behind({ refreshing: true }), caughtUp]);
  assert.deepEqual(later.seen, [waits(0, 6_500), says(6_500, 3_500), says(10_000, 4_900), says(14_900, 6_860), figures(21_760)]);

  // A row kept after a failed refresh is asked again by nobody: it does not keep waiting.
  assert.equal(retainRowAsStale({ ...plain.row(), figuresPending: true }, 1_000).figuresPending, undefined);
});

test('a pool whose figures are not coming says Unavailable at once, and the page keeps its minute', async () => {
  // Reviewer's must-fix, 2026-09-25: each of these showed a loading placeholder in the first cut.
  // The store's last collection failed: last_error set, backed off (manage_public_data.py fail()), never brought forward.
  const failed = await catchUpTrace([behind({ reason: 'collection_failed', inSeconds: 240 })], { loads: 3, after: behind({ reason: 'collection_failed', inSeconds: 180 }) });
  assert.deepEqual(failed.seen, [says(0, 60_000), says(60_000, 60_000), says(120_000, 60_000)]);
  // The next collection is two minutes off (an idle pool another tab asked for moments ago).
  const far = await catchUpTrace([behind({ inSeconds: 120 })], { loads: 2 });
  assert.deepEqual(far.seen, [says(0, 60_000), figures(60_000)]);
  // Changed on purpose 2026-09-28 (the owner's Home, the first day of the daily list): a pool whose collector holds no
  // provider figures for it (cache age null) said Unavailable at once here, though the overview's own request brings
  // its collection within seconds. It now waits for that collection, and one that brings none ends the wait at once
  // (the tests after 'a pool stops waiting…').
  // No table holds the quiet re-asks (a pool page's ticker alone): nothing will ask again soon, so nothing waits.
  const alone = await catchUpTrace([behind()], { loads: 1, holder: false });
  assert.equal(alone.seen[0].pending, false);
});

test('a pool stops waiting when a collection since brought no figures, or when its window runs out, and waits afresh only after it caught up', async () => {
  const { generatedAt } = fixture('overview');
  const observed = fixture('overview').pools[0].observedAt;
  // The store collected the pool after the page asked (its observation moved on) and still has no figures: the
  // provider has none now. One extra ask, then Unavailable, then the ordinary minute.
  const empty = await catchUpTrace([behind(), behind({ observedAt: generatedAt + 6 }), behind({ observedAt: generatedAt + 66 })], { loads: 3 });
  assert.ok(observed < generatedAt + 6);
  assert.deepEqual(empty.seen, [waits(0, 6_500), says(6_500, 60_000), says(66_500, 60_000)]);

  // A store that keeps saying "in 5 s" and never publishes: asks at 6.5, 13 and 19.5 s, the next would fall past
  // CATCH_UP_WINDOW_MS (19.5 + 6.86 > 25 s), so the page is back to its minute at 19.5 s. Changed on purpose
  // 2026-09-27 (r6/marketsdata): the row says Unavailable from 6.5 s (the ask after it falls past CATCH_UP_SHOWN_MS),
  // not 19.5 s, while the asks go on.
  assert.equal(CATCH_UP_WINDOW_MS, 25_000);
  const stuck = await catchUpTrace([behind(), behind(), behind(), behind(), behind()], { loads: 6 });
  assert.deepEqual(stuck.seen, [waits(0, 6_500), says(6_500, 6_500), says(13_000, 6_500), says(19_500, 60_000), says(79_500, 60_000), figures(139_500)]);
  assert.equal(stuck.overviews, 6);

  // Caught up, then behind again later: a new wait. Changed on purpose 2026-09-27 (r6/marketsdata, the owner: USDG/U sat
  // on loading bars): while it waits, the row shows the figures this page last had for the pool, stale and dated
  // (keepFigures), not a placeholder; its estimate is the retained one.
  const again = await catchUpTrace([behind(), behind({ observedAt: generatedAt + 6 }), caughtUp, behind()], { loads: 5 });
  assert.deepEqual(again.seen, [waits(0, 6_500), says(6_500, 60_000), figures(66_500), { at: 126_500, next: 6_500, pending: true, tvl: 'stale', apr: 'available' }, figures(133_000)]);
  assert.equal(again.row().tvlUsd.state, 'provider', 'the collection’s own figures replace the kept ones');
});

// ---------------------------------------------------------------------------
// Added 2026-09-28. The owner, on production, the first day of the daily list (read-v5 live at 12:00 UTC): Home's "Top
// pools · last 24h" showed ETH/NOTE and PONS/USDG with Unavailable TVL and 24h volume, and the Worker saw the overview
// asked at 12:53:13, :16 and :19, then nothing. The store serves a pool's cache age as null whenever its collector
// holds no provider figures for it at all (backend/market_cache.py `_result`), and a pool it never collected with no
// stored value (acquisition pending); the page waited for neither, though the overview's own request brings either
// collection within five seconds (026_public_demand.sql). A collection the provider was rate limited for (about six
// GeckoTerminal calls a minute from the VM) ended a wait at once too.
// ---------------------------------------------------------------------------
const { withPendingPools } = await import('./support/stale-store.mjs');
const limited = (options) => behind({ neverCovered: true, providerBusy: true, ...options });
const pending = (options) => () => withPendingPools(fixture('overview'), [pool], options);
/** A look at a pool with no row yet: whether its catalogue row shows a placeholder, and its row's TVL once it has one. */
const shownAs = (snapshot) => ({ placeholder: snapshot.placeholders?.includes(pool.toLowerCase()) === true, row: snapshot.result.markets[0]?.tvlUsd.state ?? null });

test('a pool the collector holds no figures for waits for the collection the request brings; one that brings none ends the wait at once', async () => {
  const { generatedAt } = fixture('overview');
  // The collection lands with figures: the row waits, then shows them, as a pool whose figures aged out does.
  const lands = await catchUpTrace([behind({ neverCovered: true }), caughtUp]);
  assert.deepEqual(lands.seen, [waits(0, 6_500), figures(6_500)]);
  assert.equal(lands.fanned, 0, 'no provider read fanned out');
  // The provider does not list the pool (a 404 is provider_unavailable, market_cache.py): the collection publishes
  // without figures and the wait ends there, one ask later; the page is back to its minute.
  const unlisted = await catchUpTrace([behind({ neverCovered: true }), behind({ neverCovered: true, observedAt: generatedAt + 6 }), behind({ neverCovered: true, observedAt: generatedAt + 66 })], { loads: 3 });
  assert.deepEqual(unlisted.seen, [waits(0, 6_500), says(6_500, 60_000), says(66_500, 60_000)]);
  assert.equal(unlisted.overviews, 3, 'one ask more than before, once a visit');
});

test('a collection the provider was rate limited for does not end the wait: the asks go on within the window, and the figures land', async () => {
  const { generatedAt } = fixture('overview');
  // 12:53:13 as the store would serve it: no figures in the collector, a collection under way. The one published at
  // +3 s was rate limited (a 429, provider_rate_limited); the one after the provider's 15 s cooldown brings figures.
  const once = await catchUpTrace([limited({ refreshing: true }), limited({ refreshing: true, observedAt: generatedAt + 3 }), limited({ observedAt: generatedAt + 8 }), caughtUp]);
  assert.deepEqual(once.seen, [waits(0, CATCH_UP_FLOOR_MS), waits(2_500, 3_500), says(6_000, 6_500), figures(12_500)]);
  assert.equal(once.fanned, 0, 'no provider read fanned out');
  // The same collection without figures for any other reason ends the wait, as before.
  const other = await catchUpTrace([behind({ neverCovered: true, refreshing: true }), behind({ neverCovered: true, refreshing: true, observedAt: generatedAt + 3 })]);
  assert.deepEqual(other.seen, [waits(0, CATCH_UP_FLOOR_MS), says(2_500, 60_000)]);
  // Rate limited at every collection: the placeholder stands CATCH_UP_SHOWN_MS at the most, the asks end with
  // CATCH_UP_WINDOW_MS (17.76 + 9.6 > 25 s), and the page is back to its slow cadence: the busy row's own quiet
  // re-ask a minute after it was first seen (PROVIDER_BUSY_WAIT_MS), then the ordinary minute.
  const always = await catchUpTrace([0, 3, 6, 10, 17].map((s) => limited({ refreshing: true, observedAt: generatedAt + s })));
  assert.deepEqual(always.seen, [waits(0, 2_500), waits(2_500, 3_500), says(6_000, 4_900), says(10_900, 6_860), says(17_760, 42_240)]);
  assert.equal(always.overviews, 5);
});

test('a row still unavailable after the window is asked again each minute, quietly, and fills in without a reload', async () => {
  const { generatedAt } = fixture('overview');
  // The collection after the request brought none; forty seconds later the provider answers, and the next minute's
  // ask shows it.
  const later = await catchUpTrace([behind({ neverCovered: true }), behind({ neverCovered: true, observedAt: generatedAt + 6 }), behind({ neverCovered: true, observedAt: generatedAt + 45 }), caughtUp]);
  assert.deepEqual(later.seen, [waits(0, 6_500), says(6_500, 60_000), says(66_500, 60_000), figures(126_500)]);
  assert.equal(later.fanned, 0, 'the overview alone, no provider read');
});

test('a pool the store never collected keeps a placeholder in its catalogue row while its first collection runs, never for long', async () => {
  // The overview's own request creates the pool's entry, due at once: asked again at CATCH_UP_FLOOR_MS, the lease
  // held, then 3.5 s later, when the collection has published.
  const first = await catchUpTrace([pending(), pending({ refreshing: true }), caughtUp], { view: shownAs });
  assert.deepEqual(first.seen, [
    { at: 0, next: 2_500, placeholder: true, row: null },
    { at: 2_500, next: 3_500, placeholder: true, row: null },
    { at: 6_000, next: 60_000, placeholder: false, row: 'provider' },
  ]);
  assert.equal(first.fanned, 0);
  // The collector does not come: the placeholder stands CATCH_UP_SHOWN_MS at the most, then the row's dashes say what
  // it has, and the catch-up ends with its window. An entry still pending is asked at the store's own five-second
  // floor, as before this change.
  const down = await catchUpTrace([pending(), pending(), pending(), pending(), pending()], { view: shownAs });
  assert.deepEqual(down.seen, [
    { at: 0, next: 2_500, placeholder: true, row: null },
    { at: 2_500, next: 3_500, placeholder: true, row: null },
    { at: 6_000, next: 4_900, placeholder: false, row: null },
    { at: 10_900, next: 5_000, placeholder: false, row: null },
    { at: 15_900, next: 5_000, placeholder: false, row: null },
  ]);
  // A pool whose first collection failed (last_error set, backed off) is not waited for.
  const failed = await catchUpTrace([pending({ reason: 'collection_failed', inSeconds: 60 })], { loads: 1, view: shownAs });
  assert.equal(failed.seen[0].placeholder, false);
});

// ---------------------------------------------------------------------------
// Added 2026-09-27 (r6/marketsdata). The owner, on production: TVL, 24h volume and APR on Home, the ticker and Markets
// sometimes took very long to appear, and USDG/U sat on loading bars. Measured in the harness with production's
// latency (support/markets-latency.mjs): the first figures waited for the featured list, then the capabilities, then
// the overview, one after the other; stored reads went out one at a time; every visit started from nothing; a first
// load that failed was never asked again.
// ---------------------------------------------------------------------------
const { createPaintMemory, PAINT_KEY, PAINT_MAX_AGE_MS } = built('marketsPaint');
const { keepFigures, FAILED_RETRY_MS } = built('marketsProvider');
const { overviewFor } = await import('./markets-cards.fixtures.mjs');

test('two stored reads at once: the list and the table’s overview travel together, the next stored read waits for a slot, and each takes its budget as it starts', async () => {
  const clock = steppedClock();
  const gates = new Map();
  const starts = [];
  // Each read waits for its gate (the capabilities, say) before its one attempt goes out.
  // Changed on purpose 2026-09-28 (speed wave, items 1 and 4): the width is every lane's (`width`), and the list takes
  // its read from the budget too, giving it back when its answer came from the edge cache, as here.
  const source = { transport: 'bridge', read: async (route, request, opts = {}) => {
    starts.push([route, clock.monotonic()]);
    await new Promise((open) => gates.set(`${route}:${request.poolId ?? ''}`, open));
    opts.onAttempt?.();
    return { route, state: 'ok', data: {}, provenance: route === 'featured-pools' ? { edge: true } : {} };
  } };
  const open = async (route, i) => { gates.get(`${route}:${i === undefined ? '' : historyOf(i).poolId}`)(); await turn(); await turn(); };
  const queue = createScheduledSource(source, { clock, unspacedStored: true, width: 2, budget: { burst: 3, perMinute: 30 } });
  const reads = [queue.read('featured-pools', {}, { priority: 'first' }), queue.read('overview', { poolIds: [pool] }, { priority: 'first' }), ...[0, 1, 2].map((i) => queue.read('history', historyOf(i)))];
  await turn();
  assert.deepEqual(starts, [['featured-pools', 0], ['overview', 0]], 'the list and the overview at once; the cards wait for a slot');
  await open('featured-pools');
  assert.deepEqual(starts.at(-1), ['history', 0], 'a slot frees: the first card');
  // A burst of three: the overview took one as it started and the first card another, though neither has sent
  // anything yet. The second card needs a read and a quarter, and one is left: it waits half a second.
  await open('overview');
  assert.equal(starts.length, 3);
  clock.advance(500);
  await turn();
  assert.deepEqual(starts.at(-1), ['history', 500]);
  await open('history', 0);
  assert.equal(starts.length, 4, 'the third card waits for the budget’s own pace');
  clock.advance(2000);
  await turn();
  assert.deepEqual(starts.at(-1), ['history', 2500]);
  await open('history', 1);
  await open('history', 2);
  assert.deepEqual((await Promise.all(reads)).map((outcome) => outcome.state), ['ok', 'ok', 'ok', 'ok', 'ok']);

  // A read that never sent anything (a route not listed) gives its budget back: four in a burst of two, no wait.
  const instant = instantClock();
  const silent = createScheduledSource({ transport: 'bridge', read: async (route) => ({ route, state: 'disabled', reason: 'route_not_enabled', provenance: {} }) },
    { clock: instant, unspacedStored: true, width: 2, budget: { burst: 2, perMinute: 30 } });
  for (let i = 0; i < 4; i++) await silent.read('history', historyOf(i));
  assert.equal(instant.monotonic(), 0);

  // Without a width, one at a time, as before.
  // Changed on purpose 2026-09-28 (speed wave, item 1): the list, which the edge answers almost always, takes no place
  // of the width (the gateway's workers never see it then), so two gateway reads show the one at a time here.
  const serial = steppedClock();
  const one = startsOn(serial, () => new Promise((resolve) => setTimeout(resolve, 5)));
  const serialQueue = createScheduledSource(one.source, { clock: serial, unspacedStored: true, budget: null });
  const both = [serialQueue.read('overview', { poolIds: [pool] }), serialQueue.read('history', historyOf(0))];
  await turn();
  assert.deepEqual(one.starts.map(([route]) => route), ['overview']);
  await Promise.all(both);
  assert.deepEqual(one.starts.map(([route]) => route), ['overview', 'history']);
  const beside = startsOn(steppedClock(), () => new Promise((resolve) => setTimeout(resolve, 5)));
  const besideQueue = createScheduledSource(beside.source, { clock: steppedClock(), unspacedStored: true, budget: null });
  const three = [besideQueue.read('overview', { poolIds: [pool] }), besideQueue.read('featured-pools', {}), besideQueue.read('history', historyOf(0))];
  await turn();
  assert.deepEqual(beside.starts.map(([route]) => route), ['overview', 'featured-pools'], 'the list goes beside the one read the width allows');
  await Promise.all(three);
});

// Added 2026-09-28 (speed wave, items 4 and 5): a read waiting for the budget looks again as soon as some comes back,
// here the list's read, which the edge answered: the pool page's overview waited for its whole computed wait.
test('a read waiting for the budget goes as soon as the list’s read gives its budget back', async () => {
  const clock = steppedClock();
  const gates = new Map();
  const starts = [];
  const source = { transport: 'bridge', read: async (route, request, opts = {}) => {
    starts.push([route, clock.monotonic()]);
    opts.onAttempt?.();
    await new Promise((open) => gates.set(route, open));
    return { route, state: 'ok', data: {}, provenance: route === 'featured-pools' ? { edge: true } : {} };
  } };
  const queue = createScheduledSource(source, { clock, unspacedStored: true, width: 2, budget: { burst: 2, perMinute: 30 } });
  const list = queue.read('featured-pools', {}, { priority: 'first' });
  const overview = queue.read('overview', { poolIds: [pool] });
  await turn();
  assert.deepEqual(starts, [['featured-pools', 0]], 'the overview waits: the list took a read, one is left, and a read and a quarter is wanted');
  assert.equal(clock.sleeping, 1);
  gates.get('featured-pools')(); await turn(); await turn();
  assert.deepEqual(starts, [['featured-pools', 0], ['overview', 0]], 'the edge answered the list: the overview goes at once');
  gates.get('overview')();
  assert.deepEqual((await Promise.all([list, overview])).map((outcome) => outcome.state), ['ok', 'ok']);
});

test('a read whose reader left before its attempt gives its budget back once, and an attempt that still goes out spends its own', async () => {
  // A source that does not stop at the abort: its attempt goes out after the reader has left.
  const clock = steppedClock();
  const late = [];
  const source = { transport: 'bridge', read: async (route, request, opts = {}) => {
    await new Promise((go) => late.push(() => { opts.onAttempt?.(); go(); }));
    return { route, state: 'ok', data: {}, provenance: {} };
  } };
  const queue = createScheduledSource(source, { clock, unspacedStored: true, width: 2, budget: { burst: 2, perMinute: 30 } });
  const leaving = new AbortController();
  const gone = queue.read('history', historyOf(0), { signal: leaving.signal });
  await turn();
  leaving.abort();
  assert.equal((await gone).state, 'aborted');
  late.shift()();
  await turn();
  // Two in a burst of two: one spent by the attempt that went out, one left; the next read wants a read and a quarter.
  const next = queue.read('history', historyOf(1));
  await turn();
  assert.equal(late.length, 0, 'it waits for the budget');
  clock.advance(500);
  await turn();
  assert.equal(late.length, 1, 'half a second later');
  late.shift()();
  assert.equal((await next).state, 'ok');
});

/** A list the test answers (marketsProvider.ts PoolList): `answer` puts its pools on screen and says so. */
function heldList(ids) {
  const listeners = new Set();
  let answered;
  const first = new Promise((resolve) => { answered = resolve; });
  const list = {
    now: ids, keys: new Map(), unbound: [],
    ids: () => list.now,
    update: () => first,
    // A pool the answer named with a fee its read does not have does not bind.
    binds: (poolId, read) => !list.keys.has(poolId) || list.keys.get(poolId) === read.poolKey.fee_pips,
    unbind: (gone) => { list.unbound.push(...gone); list.now = list.now.filter((id) => !gone.includes(id)); for (const listener of listeners) listener(); },
    subscribe: (listener) => (listeners.add(listener), () => listeners.delete(listener)),
    answer: (next, keys = new Map()) => { list.now = next; list.keys = keys; answered(); for (const listener of listeners) listener(); },
  };
  return list;
}

/** The composed stored source over a store that answers any pools asked (markets-cards.fixtures.mjs), holding the reads `held` names until their signal ends. */
function anyPools({ held = () => false } = {}) {
  const calls = [];
  const fetch = async (path, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path, body });
    if (path === '/api/read/v3/capabilities') return new Response(JSON.stringify(fixture('capabilities')), { headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': v3.CONTRACT_VERSION } });
    if (held(body)) await new Promise((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    return new Response(JSON.stringify(overviewFor(body)), { headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': v3.CONTRACT_VERSION } });
  };
  const options = { enabled: true, validators: v1, fetch };
  const source = createPublicMetadataCache(createScheduledSource(createPublicSource(createEstimateSource(options, v2), options, v3), { minIntervalMs: 0, budget: null, unspacedStored: true, width: 2 }));
  return { source, calls, overviews: () => calls.filter((call) => call.path === '/api/read/v3/overview').map((call) => call.body.poolIds) };
}
const poolIdOf = (hex) => `0x${hex.padStart(64, '0')}`;
const settled = (provider) => new Promise((resolve) => {
  const check = () => { if (provider.getSnapshot().phase === 'ready') { stop(); resolve(provider.getSnapshot()); } };
  const stop = provider.subscribe(check);
  check();
});

/** This browser's copy of an overview of `ids` (marketsPaint.ts), read a moment ago. */
function copyOf(ids) {
  const storage = memoryStorage();
  const paint = createPaintMemory(() => storage, v3);
  paint.save({ data: overviewFor({ poolIds: ids }), provenance: { transport: 'bridge', contract: v3.CONTRACT_VERSION, receivedAt: Date.now() - 1_000, attempts: 0 } });
  return paint;
}

test('without a copy the first load waits for the list, the capabilities asked meanwhile; with one it reads the copy’s pools at once, and a list with other pools starts it over', async () => {
  const [A, B] = [poolIdOf('a1'), poolIdOf('b2')];
  // No copy: nothing of the embedded list is read before the list answers, which may name other pools.
  const waiting = heldList([A]);
  const bare = anyPools();
  const first = createReadMarketsProvider({ source: bare.source, poolIds: [], pools: waiting, kind: 'bridge', refreshMs: 60_000 });
  first.ensure();
  for (let i = 0; i < 50 && !bare.calls.some((call) => call.path === '/api/read/v3/capabilities'); i++) await turn();
  assert.deepEqual(bare.calls.map((call) => call.path), ['/api/read/v3/capabilities'], 'the capabilities, and no overview yet');
  waiting.answer([B]);
  assert.deepEqual((await settled(first)).result.markets.map((row) => row.poolId), [B]);
  assert.deepEqual(bare.overviews(), [[B]], 'one overview, of the list’s pools');
  assert.equal(bare.calls.filter((call) => call.path === '/api/read/v3/capabilities').length, 1, 'the capabilities asked once');

  // The capabilities refused while the list is asked: the load uses that very answer, and asks them no second time.
  const refusing = heldList([A]);
  const gets = [];
  const options = { enabled: true, validators: v1, fetch: async (path) => {
    gets.push(path);
    return new Response(JSON.stringify({ error: 'upstream_unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': v3.CONTRACT_VERSION } });
  } };
  const down = createPublicMetadataCache(createScheduledSource(createPublicSource(createEstimateSource(options, v2), options, v3), { minIntervalMs: 0, budget: null, unspacedStored: true, width: 2 }));
  const refused = createReadMarketsProvider({ source: down, poolIds: [], pools: refusing, kind: 'bridge', refreshMs: 60_000 });
  refused.ensure();
  for (let i = 0; i < 50 && gets.length === 0; i++) await turn();
  for (let i = 0; i < 20; i++) await turn();
  refusing.answer([B]);
  await new Promise((resolve) => { const stop = refused.subscribe(() => { if (refused.getSnapshot().phase !== 'loading') { stop(); resolve(); } }); });
  // Changed on purpose 2026-09-28 (speed wave, item 3): the check itself asks a failure that can pass by itself again
  // at once, twice at most (publicSource.ts CHECK_AGAIN); the load still asks it no second time.
  assert.deepEqual(gets.filter((path) => path === '/api/read/v3/capabilities').length, 3, `one capabilities check, of three GETs: ${gets.join(', ')}`);

  // The copy names A: its overview goes out before the list answers; the list names B, so the load starts over at once.
  const list = heldList([A]);
  const store = anyPools({ held: (body) => body?.poolIds?.includes(A) });
  const provider = createReadMarketsProvider({ source: store.source, poolIds: [], pools: list, kind: 'bridge', refreshMs: 60_000, paint: copyOf([A]) });
  assert.deepEqual(provider.getSnapshot().previous.markets.map((row) => row.poolId), [A], 'the copy’s row, painted');
  provider.ensure();
  for (let i = 0; i < 50 && store.overviews().length === 0; i++) await turn();
  assert.deepEqual(store.overviews(), [[A]], 'the overview went out before the list answered');
  list.answer([B]);
  const ready = await settled(provider);
  assert.deepEqual(store.overviews(), [[A], [B]], 'the list’s own pools, at once, without waiting for the first read');
  assert.deepEqual(ready.result.markets.map((row) => row.poolId), [B]);
});

test('a row read before the list answered that the list names as another pool leaves the list', async () => {
  const A = poolIdOf('a1');
  const list = heldList([A]);
  const store = anyPools();
  const provider = createReadMarketsProvider({ source: store.source, poolIds: [], pools: list, kind: 'bridge', refreshMs: 60_000, paint: copyOf([A]) });
  provider.ensure();
  const first = await settled(provider);
  assert.deepEqual(first.result.markets.map((row) => row.poolId), [A], 'bound to the list shown when it was read');
  // The answer names A with a 0.05% fee; its read is the fixture's 0.30% pool.
  list.answer([A], new Map([[A, 500]]));
  assert.deepEqual(list.unbound, [A]);
  assert.deepEqual(provider.getSnapshot().result.markets, [], 'its row leaves with it');
});

function memoryStorage() {
  const map = new Map();
  return { map, getItem: (key) => map.get(key) ?? null, setItem: (key, value) => { map.set(key, String(value)); }, removeItem: (key) => { map.delete(key); } };
}
const overviewOk = (receivedAt, data = fixture('overview')) => ({ data, provenance: { transport: 'bridge', contract: v3.CONTRACT_VERSION, receivedAt, attempts: 0 } });

// 2026-10-01 (the chain2 workstream, part B, audit item G10): the copy's key names its chain; a copy kept under the old
// name is Robinhood Chain's, and moves to the new one the first time it is read, drawn the same.
test('the copy kept under the name before moves to the chain\'s name on its first read, and paints the same', () => {
  const { LEGACY_PAINT_KEY } = built('marketsPaint');
  assert.equal(LEGACY_PAINT_KEY, 'domino-markets:v1');
  const wall = 5_000_000;
  const before = memoryStorage();
  createPaintMemory(() => before, v3, () => wall).save(overviewOk(wall - 1_000));
  const text = before.map.get(PAINT_KEY);
  const old = memoryStorage();
  old.map.set(LEGACY_PAINT_KEY, text);
  const paint = createPaintMemory(() => old, v3, () => wall);
  assert.deepEqual(paint.load(), createPaintMemory(() => before, v3, () => wall).load(), 'painted as it was');
  assert.deepEqual([...old.map.keys()], [PAINT_KEY], 'moved: the old name is gone');
  assert.equal(old.map.get(PAINT_KEY), text);
  old.map.set(LEGACY_PAINT_KEY, '{');
  assert.ok(paint.load(), 'both kept: the chain\'s name wins');
  assert.deepEqual([...old.map.keys()], [PAINT_KEY]);
  // The prefetch (A7 a) reads through the same move.
  const fresh = memoryStorage();
  fresh.map.set(LEGACY_PAINT_KEY, text);
  assert.ok(createPaintMemory(() => fresh, v3, () => wall).prefetch()?.length > 0);
  assert.deepEqual([...fresh.map.keys()], [PAINT_KEY]);
});

test('this browser’s copy of the last overview: kept 15 minutes, only while read-v3’s runtime accepts it, never past a storage that refuses', () => {
  // Changed on purpose 2026-10-01 (the chain2 workstream, part B, audit item G10): the key names its chain.
  assert.equal(PAINT_KEY, 'domino-markets-v2:4663');
  assert.equal(PAINT_MAX_AGE_MS, 15 * 60_000);
  let wall = 5_000_000;
  const storage = memoryStorage();
  const paint = createPaintMemory(() => storage, v3, () => wall);
  assert.equal(paint.load(), null, 'nothing kept yet');
  paint.save(overviewOk(wall - 1_000));
  const kept = paint.load();
  assert.deepEqual(kept.data, fixture('overview'));
  assert.deepEqual(kept.provenance, { transport: 'bridge', contract: v3.CONTRACT_VERSION, receivedAt: wall - 1_000, attempts: 0 }, 'dated by its arrival; no monotonic time from another document');
  wall += PAINT_MAX_AGE_MS;
  assert.equal(paint.load(), null, 'too old');
  wall -= 2 * PAINT_MAX_AGE_MS;
  assert.equal(paint.load(), null, 'from this clock’s future');
  wall += PAINT_MAX_AGE_MS;
  assert.ok(paint.load(), 'the same copy stands again at its own age');
  const stored = JSON.parse(storage.map.get(PAINT_KEY));
  for (const [label, value] of [
    ['another contract', { ...stored, contract: '3.0.0-rc.0' }],
    ['another shape', { ...stored, v: 2 }],
    ['a payload the runtime refuses', { ...stored, data: { ...stored.data, pools: 'nope' } }],
    ['not JSON', '{'],
  ]) {
    storage.map.set(PAINT_KEY, typeof value === 'string' ? value : JSON.stringify(value));
    assert.equal(paint.load(), null, label);
  }
  // Added 2026-09-28 (speed wave): the same text is checked against the runtime once, however often the app asks for
  // it as it starts; new text is checked again, and the age is counted afresh at every ask.
  let checks = 0;
  const counted = { CONTRACT_VERSION: v3.CONTRACT_VERSION, validateResponse: (route, payload) => (checks += 1, v3.validateResponse(route, payload)) };
  const again = createPaintMemory(() => storage, counted, () => wall);
  storage.map.set(PAINT_KEY, JSON.stringify(stored));
  assert.ok(again.load() && again.load() && again.load());
  assert.equal(checks, 1, 'one check for the same text');
  wall += PAINT_MAX_AGE_MS;
  assert.equal(again.load(), null, 'too old, without another check');
  wall -= PAINT_MAX_AGE_MS;
  storage.map.set(PAINT_KEY, JSON.stringify({ ...stored, data: { ...stored.data, pools: 'nope' } }));
  assert.equal(again.load(), null);
  assert.equal(checks, 2, 'new text, checked');
  const blocked = createPaintMemory(() => { throw new Error('blocked'); }, v3, () => wall);
  assert.equal(blocked.load(), null);
  assert.doesNotThrow(() => blocked.save(overviewOk(wall)));
  const full = createPaintMemory(() => ({ getItem: () => null, setItem: () => { throw new Error('QuotaExceededError'); }, removeItem: () => {} }), v3, () => wall);
  assert.doesNotThrow(() => full.save(overviewOk(wall)));
});

/** A provider whose overview answers are `answers` in turn (a function each), its timers fired by the test, at wall `wall`. */
function traced(answers, { paint, wall = 5_000_000 } = {}) {
  let steady = 0;
  const timers = [];
  const reads = { now: () => wall + steady, monotonic: () => steady, random: () => 0, timer: () => () => {},
    sleep: (_ms, signal) => new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })) };
  const clock = { ...reads, timer: (ms, fire) => { timers.push({ ms, fire: () => { steady += ms; fire(); } }); return () => {}; } };
  const queued = [...answers];
  const { source, calls } = setup({ clock: reads, answer: () => queued.shift()() });
  const provider = createReadMarketsProvider({ source, poolIds: [pool], kind: 'bridge', clock, refreshMs: 60_000, paint, visibility: { hidden: () => false, onChange: () => () => {} } });
  const next = async () => {
    const before = timers.length;
    timers.at(-1).fire();
    for (let j = 0; j < 200 && timers.length === before; j++) await turn();
  };
  const settle = () => new Promise((resolve) => {
    const check = () => { if (provider.getSnapshot().phase !== 'loading') { stop(); resolve(provider.getSnapshot()); } };
    const stop = provider.subscribe(check);
    check();
  });
  return { provider, timers, next, settle, overviews: () => calls.filter((call) => call.path === '/api/read/v3/overview').length };
}
const down = () => new Response(JSON.stringify({ error: 'upstream_unavailable' }), { status: 503, headers: { 'Content-Type': 'application/json', 'X-Domino-Read-Contract': v3.CONTRACT_VERSION } });

test('the copy paints the rows before the first read, as old as they are and waiting where they have no figure; the answer replaces them and is kept', async () => {
  const wall = 5_000_000;
  const storage = memoryStorage();
  const paint = createPaintMemory(() => storage, v3, () => wall);
  const data = fixture('overview');
  paint.save(overviewOk(wall - 30_000, data));
  const { provider, settle } = traced([() => fixture('overview')], { paint, wall });
  const painted = provider.getSnapshot();
  assert.equal(painted.phase, 'loading');
  const [row] = painted.previous.markets;
  assert.equal(row.poolId, pool);
  assert.equal(row.figuresPending, true, 'what it has no figure for waits for the answer');
  assert.equal(row.tvlUsd.value, overviewRows(overviewOk(wall - 30_000, data))[0].tvlUsd.value, 'the copy’s own figure');
  assert.equal(row.provenance.market.receivedAt, wall - 30_000, 'the copy ages from its original arrival, without counting stored metric age twice');
  assert.equal(row.provenance.market.receivedMonotonic, undefined);
  const release = provider.recoverQuietly();
  provider.ensure();
  const ready = await settle();
  assert.equal(ready.phase, 'ready');
  assert.equal(ready.result.markets[0].figuresPending, undefined);
  assert.ok(JSON.parse(storage.map.get(PAINT_KEY)).receivedAt >= wall, 'the answer is the next visit’s copy');
  release();
});

test('a load that read nothing is asked again after 5 s, then 15 s and 45 s; rows the copy painted stay, stale and dated', async () => {
  assert.equal(FAILED_RETRY_MS, 5_000);
  const wall = 5_000_000;
  const storage = memoryStorage();
  const paint = createPaintMemory(() => storage, v3, () => wall);
  paint.save(overviewOk(wall - 30_000));
  const { provider, timers, next, settle, overviews } = traced([down, down, down, () => fixture('overview')], { paint, wall });
  const release = provider.recoverQuietly();
  provider.ensure();
  const failed = await settle();
  assert.equal(failed.phase, 'failed');
  assert.deepEqual(failed.retained.result.markets.map((row) => [row.poolId, row.tvlUsd.state, row.figuresPending]), [[pool, 'stale', undefined]], 'the painted row, kept as it was, never blank');
  assert.equal(timers.at(-1).ms, 5_000);
  await next();
  assert.equal(timers.at(-1).ms, 15_000);
  await next();
  assert.equal(timers.at(-1).ms, 45_000);
  await next();
  assert.equal(provider.getSnapshot().phase, 'ready');
  assert.equal(timers.at(-1).ms, 60_000, 'back to the minute');
  assert.equal(overviews(), 4);
  release();

  // With nothing painted, the same: the first load used to wait for a reload.
  const bare = traced([down, () => fixture('overview')]);
  const hold = bare.provider.recoverQuietly();
  bare.provider.ensure();
  assert.equal((await bare.settle()).phase, 'failed');
  assert.equal(bare.timers.at(-1).ms, 5_000);
  await bare.next();
  assert.equal(bare.provider.getSnapshot().phase, 'ready');
  hold();
});

test('a placeholder stands 8 s at the most; past it a row whose figures are coming shows the ones kept for it while the asks go on', async () => {
  assert.equal(CATCH_UP_SHOWN_MS, 8_000);
  // Figures, then behind at the minute: the kept ones, stale, with a placeholder where none is kept (none here); the
  // next ask falls past 8 s, so the row no longer waits on screen, and still shows the kept figures, never a gap.
  const kept = await catchUpTrace([caughtUp, behind(), behind(), caughtUp], { loads: 4 });
  const stale = (at, next, pending) => ({ at, next, pending, tvl: 'stale', apr: 'available' });
  assert.deepEqual(kept.seen, [figures(0), stale(60_000, 6_500, true), stale(66_500, 6_500, false), figures(73_000)]);
  assert.equal(kept.overviews, 4);
});

test('a pool waits afresh only once it caught up: one answer that is not behind does not bring the placeholder back each minute', async () => {
  // Behind, then its next collection two minutes off (not behind, no figures), then behind again at the minute: it
  // waited once and has not caught up since, so the row says what it has, and no placeholder comes back.
  const flapping = await catchUpTrace([behind(), behind({ inSeconds: 120 }), behind()], { loads: 3 });
  assert.deepEqual(flapping.seen, [waits(0, 6_500), says(6_500, 60_000), says(66_500, 60_000)]);
});

test('keepFigures: a row whose figures are coming shows the ones kept for it, stale and dated, and keeps its own where it has them', () => {
  const read = (data) => overviewRows(overviewOk(1_000_000, data))[0];
  const good = read(fixture('overview'));
  const coming = { ...read(withStalePools(fixture('overview'), [pool])), figuresPending: true };
  assert.equal(coming.tvlUsd.state, 'unavailable');
  const shown = keepFigures(coming, good, 1_000_000);
  assert.deepEqual([shown.tvlUsd.state, shown.tvlUsd.value, shown.volume24hUsd.state], ['stale', good.tvlUsd.value, 'stale']);
  assert.equal(shown.feeAprEstimate.retained, true, 'the kept estimate, marked as kept');
  assert.equal(shown.figuresPending, true);
  assert.equal(shown.poolState, coming.poolState, 'its own price');
  assert.deepEqual(keepFigures(good, coming, 1_000_000).tvlUsd, good.tvlUsd, 'a figure it has is never replaced');
});

// Added 2026-11-09 (core flows, the owner's sweep of a token page: "Price loading" for 45 s and more). A counterpart token
// the producer says is pending but is not working on (not refreshing, its own next attempt long overdue) holds no price as a
// placeholder; one still on its way does, until the page has waited long enough (`waitForTokens` false: the dash). The
// page's fast poll slows down after half a minute. And a provider's zero TVL is the dash its table's other gaps are.
test('a stalled or long-awaited counterpart token ends its pools’ price placeholders; the token page’s poll slows down; a provider’s zero TVL is the dash', () => {
  const { acquisitionStalled, overviewPollMs, STALLED_AFTER_S } = built('publicOverview');
  const { shownTvl, presentMetric } = require('../.test-build/app/src/lib/markets.js');
  const provenance = { transport: 'bridge', receivedAt: 100_000, receivedMonotonic: 100_000, attempts: 1 };
  const data = fixture('overview');
  const other = data.tokens.find((entry) => entry.address !== '0x0000000000000000000000000000000000000000');
  other.value = null; other.observedAt = null;
  other.acquisition = { status: 'pending', refreshing: false, reason: null, nextAttemptAt: data.generatedAt - 10 };
  assert.equal(overviewRows({ data, provenance })[0].tokensPending, true, 'still on its way: the quiet placeholder');
  assert.equal(overviewRows({ data, provenance }, undefined, false)[0].tokensPending, undefined, 'waited long enough: the dash');
  other.acquisition.nextAttemptAt = data.generatedAt - STALLED_AFTER_S - 1;
  assert.equal(acquisitionStalled(other.acquisition, data.generatedAt), true);
  assert.equal(overviewRows({ data, provenance })[0].tokensPending, undefined, 'stalled: no placeholder at all');
  other.acquisition.refreshing = true;
  assert.equal(acquisitionStalled(other.acquisition, data.generatedAt), false, 'one being worked on is not stalled');
  other.acquisition = { status: 'pending', refreshing: false, reason: null, nextAttemptAt: null };
  assert.equal(acquisitionStalled(other.acquisition, data.generatedAt), false, 'no attempt named: not stalled');
  assert.deepEqual([0, 5, 6, 7, 8, 9, 10, 40].map(overviewPollMs), [5_000, 5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
  const zero = { value: '0', state: 'provider', source: 'GeckoTerminal' };
  assert.equal(presentMetric(shownTvl(zero)).kind, 'absent', 'a provider’s zero TVL is the dash');
  assert.equal(presentMetric(shownTvl({ value: '0.00', state: 'stale', source: 'DexScreener' })).kind, 'absent');
  assert.equal(shownTvl({ value: '12.5', state: 'provider', source: 'GeckoTerminal' }).value, '12.5', 'any other figure is itself');
  assert.equal(shownTvl({ value: '0', state: 'qualified' }).value, '0', 'Domino’s own figure is itself');
});
