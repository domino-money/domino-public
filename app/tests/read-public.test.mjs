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
