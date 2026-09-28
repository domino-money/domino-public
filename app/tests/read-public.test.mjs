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
  assert.ok(Math.abs(row.provenance.market.receivedAt - (read.provenance.receivedAt - 40_000)) < 1);
  const option = overviewPoolOption(read, pool);
  assert.equal(option.kind, 'stored'); assert.equal(option.block, data.pools[0].value.market.snapshot.number);
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
  assert.match(load, /const asked = \{ signal, priority: 'first' as const \}/);
});

/**
 * One provider over a store whose overview answers are `answers` in turn (then `after`), held by a table as Home and
 * Markets hold it, its timers fired one at a time. Each look: the timer planned after a load (ms), whether the row
 * waits for its figures, its TVL state, its estimate's status, and the monotonic ms when that load settled.
 */
async function catchUpTrace(answers, { loads = answers.length, after = () => fixture('overview'), holder = true } = {}) {
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
  const look = () => seen.push({ at: steady, next: timers.at(-1)?.ms ?? null, pending: row().figuresPending === true, tvl: row().tvlUsd.state, apr: row().feeAprEstimate.data?.status });
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
  // The provider never gave this pool figures: a collection brings none back.
  const never = await catchUpTrace([behind({ neverCovered: true })], { loads: 2, after: behind({ neverCovered: true }) });
  assert.deepEqual(never.seen, [says(0, 60_000), says(60_000, 60_000)]);
  assert.equal(never.overviews, 2, 'no extra overview POST');
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
  const source = { transport: 'bridge', read: async (route, request, opts = {}) => {
    starts.push([route, clock.monotonic()]);
    await new Promise((open) => gates.set(`${route}:${request.poolId ?? ''}`, open));
    opts.onAttempt?.();
    return { route, state: 'ok', data: {}, provenance: {} };
  } };
  const open = async (route, i) => { gates.get(`${route}:${i === undefined ? '' : historyOf(i).poolId}`)(); await turn(); await turn(); };
  const queue = createScheduledSource(source, { clock, unspacedStored: true, storedWidth: 2, budget: { burst: 3, perMinute: 30 } });
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
    { clock: instant, unspacedStored: true, storedWidth: 2, budget: { burst: 2, perMinute: 30 } });
  for (let i = 0; i < 4; i++) await silent.read('history', historyOf(i));
  assert.equal(instant.monotonic(), 0);

  // Without a width, one at a time, as before.
  const serial = steppedClock();
  const one = startsOn(serial, () => new Promise((resolve) => setTimeout(resolve, 5)));
  const serialQueue = createScheduledSource(one.source, { clock: serial, unspacedStored: true, budget: null });
  const both = [serialQueue.read('featured-pools', {}), serialQueue.read('overview', { poolIds: [pool] })];
  await turn();
  assert.deepEqual(one.starts.map(([route]) => route), ['featured-pools']);
  await Promise.all(both);
  assert.deepEqual(one.starts.map(([route]) => route), ['featured-pools', 'overview']);
});

test('a read whose reader left before its attempt gives its budget back once, and an attempt that still goes out spends its own', async () => {
  // A source that does not stop at the abort: its attempt goes out after the reader has left.
  const clock = steppedClock();
  const late = [];
  const source = { transport: 'bridge', read: async (route, request, opts = {}) => {
    await new Promise((go) => late.push(() => { opts.onAttempt?.(); go(); }));
    return { route, state: 'ok', data: {}, provenance: {} };
  } };
  const queue = createScheduledSource(source, { clock, unspacedStored: true, storedWidth: 2, budget: { burst: 2, perMinute: 30 } });
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
  const source = createPublicMetadataCache(createScheduledSource(createPublicSource(createEstimateSource(options, v2), options, v3), { minIntervalMs: 0, budget: null, unspacedStored: true, storedWidth: 2 }));
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
  const down = createPublicMetadataCache(createScheduledSource(createPublicSource(createEstimateSource(options, v2), options, v3), { minIntervalMs: 0, budget: null, unspacedStored: true, storedWidth: 2 }));
  const refused = createReadMarketsProvider({ source: down, poolIds: [], pools: refusing, kind: 'bridge', refreshMs: 60_000 });
  refused.ensure();
  for (let i = 0; i < 50 && gets.length === 0; i++) await turn();
  for (let i = 0; i < 20; i++) await turn();
  refusing.answer([B]);
  await new Promise((resolve) => { const stop = refused.subscribe(() => { if (refused.getSnapshot().phase !== 'loading') { stop(); resolve(); } }); });
  assert.deepEqual(gets.filter((path) => path === '/api/read/v3/capabilities').length, 1, `one capabilities GET: ${gets.join(', ')}`);

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

test('this browser’s copy of the last overview: kept 15 minutes, only while read-v3’s runtime accepts it, never past a storage that refuses', () => {
  assert.equal(PAINT_KEY, 'domino-markets:v1');
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
  assert.equal(row.provenance.market.receivedAt, wall - 30_000 - (data.generatedAt - data.pools[0].observedAt) * 1000, 'dated from the copy’s arrival, less the store’s own age');
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
