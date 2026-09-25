/**
 * The fees store behind useFeeHistory / useFeeHistories / useFeeStates
 * (src/lib/fees/store.ts; DESIGN-V2 §15.4–§15.6): the views a screen sees,
 * one /state read and one replay shared by every screen showing an id, the
 * worker's message protocol (every message crosses a structured clone, as it
 * does between threads), the refresh that resumes from a checkpoint, the
 * budgets per scope, and a failed worker never created again.
 *
 * The worker here is a loopback that runs pipeline.ts on the recorded relay
 * answers of tests/support/fees; the hooks are thin useSyncExternalStore
 * wrappers over exactly these calls.
 *
 * Added 2026-09-24 (P6, fees data).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fixtureRelay, loadCase } from './support/fees/relay-fixture.mjs';

const require = createRequire(import.meta.url);
const { createFeesStore, RELEASE_MS } = require('../.test-build/app/src/lib/fees/store.js');
const { runPipeline } = require('../.test-build/app/src/lib/fees/pipeline.js');
const { BUDGET_BYTES, STATE_REFRESH_MS } = require('../.test-build/app/src/lib/fees/constants.js');

const settle = () => new Promise((done) => setTimeout(done, 0));
async function until(check, what) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await settle();
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A worker that runs the pipeline in this thread on recorded answers; every message is structured-cloned both ways. */
function loopback(relays = {}) {
  const worker = {
    posted: [],
    terminated: false,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    runs: new Map(),
    postMessage(message) {
      const inbound = structuredClone(message);
      worker.posted.push(inbound);
      const previous = worker.runs.get(inbound.id);
      if (previous) previous.cancelled = true;
      if (inbound.type === 'cancel') return;
      const token = { cancelled: false };
      worker.runs.set(inbound.id, token);
      const relay = relays[inbound.id] ?? fixtureRelay(loadCase(inbound.id));
      runPipeline({ logs: relay.logs, sleep: async () => {}, cancelled: () => token.cancelled }, inbound).then((result) => {
        if (!result || token.cancelled) return;
        setTimeout(() => worker.onmessage?.({ data: structuredClone({ type: 'done', id: inbound.id, result }) }), 0);
      });
    },
    terminate() {
      worker.terminated = true;
    },
  };
  return worker;
}

/** Recorded /state answers per id (the fixtures'), with `bump` blocks added; `refuse` ids answer not_found. */
function stateService({ bump = 0, down = false, reasons = {} } = {}) {
  const service = {
    asked: [],
    bump,
    down,
    async postState(ids) {
      service.asked.push([...ids]);
      if (service.down) return { ok: false, failure: 'unavailable', retryAfterMs: 0 };
      const answers = ids.map((id) => {
        if (reasons[id]) return { tokenId: id, ok: false, reason: reasons[id] };
        try {
          return loadCase(id).state.positions[0];
        } catch {
          return { tokenId: id, ok: false, reason: 'not_found' };
        }
      });
      const base = ids.map((id) => { try { return loadCase(id).state; } catch { return null; } }).find(Boolean) ?? { block: 1, timestamp: 1 };
      return { ok: true, value: { v: 1, block: base.block + service.bump, timestamp: base.timestamp + service.bump, positions: answers }, bytes: 100 };
    },
  };
  return service;
}

/** Manual timers: `later` and `timer` calls are kept and fired by the test. */
function clock() {
  const pending = [];
  const add = (kind) => (ms, run) => {
    const entry = { kind, ms, run, cancelled: false };
    pending.push(entry);
    return () => void (entry.cancelled = true);
  };
  return {
    pending,
    later: add('later'),
    timer: add('timer'),
    fire(kind, ms) {
      const due = pending.filter((entry) => !entry.cancelled && entry.kind === kind && (ms === undefined || entry.ms === ms));
      for (const entry of due) {
        entry.cancelled = true;
        entry.run();
      }
      return due.length;
    },
  };
}

function storeWith({ relays, service = stateService(), spawn } = {}) {
  const workers = [];
  const time = clock();
  const store = createFeesStore({
    spawn: spawn ?? (() => {
      const worker = loopback(relays);
      workers.push(worker);
      return worker;
    }),
    postState: (ids) => service.postState(ids),
    later: time.later,
    timer: time.timer,
  });
  return { store, workers, service, time };
}

test('one position: idle, then loading with its on-chain state, then verified; the worker gets the chain’s growth and the page budget', async () => {
  const { store, workers, service } = storeWith();
  const seen = [];
  assert.equal(store.view('3136705').phase, 'idle');
  const stop = store.subscribeHistory(['3136705'], 'page', () => seen.push(store.view('3136705').phase));
  await until(() => store.view('3136705').phase === 'verified', 'verified');
  assert.deepEqual(service.asked, [['3136705']]);
  assert.deepEqual([...new Set(seen)], ['loading', 'verified']);
  const view = store.view('3136705');
  const fixture = loadCase('3136705');
  assert.equal(view.state.block, fixture.state.block);
  assert.equal(view.state.unclaimed[0], BigInt(fixture.state.positions[0].unclaimed0));
  assert.equal(view.history.earned[0] - view.history.collected[0], view.state.unclaimed[0]);
  assert.ok(view.prices.hours.length > 0);
  const [run] = workers[0].posted;
  assert.equal(run.type, 'run');
  assert.equal(run.budgetBytes, BUDGET_BYTES.page);
  assert.equal(run.checkpoint, null);
  assert.deepEqual(run.growth, [BigInt(fixture.state.positions[0].feeGrowthInside0X128) - BigInt(fixture.state.positions[0].feeGrowthInside0LastX128), BigInt(fixture.state.positions[0].feeGrowthInside1X128) - BigInt(fixture.state.positions[0].feeGrowthInside1LastX128)].map((d) => BigInt.asUintN(256, d)));
  assert.equal(store.view('3136705'), view, 'the same object while nothing changed');
  stop();
});

test('screens showing one id share one /state read and one replay; the list aggregate is one subscription', async () => {
  const { store, workers, service } = storeWith();
  const a = store.subscribeHistory(['3136705'], 'page', () => {});
  const b = store.subscribeHistory(['3136705', '3135288'], 'list', () => {});
  const c = store.subscribeStates(['3136705'], () => {});
  await until(() => store.view('3136705').phase === 'verified' && store.view('3135288').phase === 'verified', 'both verified');
  assert.deepEqual(service.asked, [['3136705', '3135288']], 'one batched /state request');
  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].posted.map((m) => [m.type, m.id]).sort(), [['run', '3135288'], ['run', '3136705']]);
  const views = store.views(['3136705', '3135288']);
  assert.equal(store.views(['3136705', '3135288']), views, 'a stable Map while nothing changed');
  assert.deepEqual([...views.keys()], ['3136705', '3135288']);
  const [x, y] = [views.get('3136705'), views.get('3135288')];
  assert.equal(x.phase, 'verified');
  assert.deepEqual(y.history.earned, [0n, 0n], 'the owner’s zero state');
  for (const stop of [a, b, c]) stop();
});

test('useFeeStates’ answer: null until something is known, then each id’s state or null (not found, hooked)', async () => {
  const service = stateService({ reasons: { 7: 'hooked_pool' } });
  const { store } = storeWith({ service });
  const ids = ['3136705', '999', '7'];
  const stop = store.subscribeStates(ids, () => {});
  assert.equal(store.states(ids), null);
  await until(() => store.states(ids) !== null, 'states');
  const states = store.states(ids);
  assert.equal(states.get('3136705').block, loadCase('3136705').state.block);
  assert.equal(states.get('999'), null);
  assert.equal(states.get('7'), null);
  assert.equal(store.states(ids), states, 'stable');
  stop();
  const history = store.subscribeHistory(['999', '7'], 'page', () => {});
  assert.deepEqual([store.view('999'), store.view('7')], [{ phase: 'unavailable', reason: 'not_found' }, { phase: 'unavailable', reason: 'hooked_pool' }]);
  history();
});

test('/state that cannot be read shows nothing (unavailable, rpc_unavailable), and no worker is created', async () => {
  const { store, workers } = storeWith({ service: stateService({ down: true }) });
  const stop = store.subscribeHistory(['3136705'], 'page', () => {});
  await until(() => store.view('3136705').phase === 'unavailable', 'unavailable');
  assert.deepEqual(store.view('3136705'), { phase: 'unavailable', reason: 'rpc_unavailable' });
  assert.equal(workers.length, 0);
  stop();
});

test('a relay failure after /state leaves the on-chain figure (unclaimed-only), and the reason is data only', async () => {
  const fixture = loadCase('3136705');
  const relay = fixtureRelay(fixture, { script: { transfer: [{ ok: false, failure: 'unavailable', retryAfterMs: 0 }] } });
  const { store } = storeWith({ relays: { 3136705: relay } });
  const stop = store.subscribeHistory(['3136705'], 'page', () => {});
  await until(() => store.view('3136705').phase === 'unclaimed-only', 'unclaimed-only');
  const view = store.view('3136705');
  assert.equal(view.reason, 'rpc_unavailable');
  assert.equal(view.state.unclaimed[1], BigInt(fixture.state.positions[0].unclaimed1));
  stop();
});

test('a worker that fails (a stale file after a deploy) leaves every history at its unclaimed figure and is never created again', async () => {
  const workers = [];
  const { store } = storeWith({
    spawn: () => {
      const worker = { posted: [], onmessage: null, onerror: null, onmessageerror: null, terminated: false, postMessage(message) { this.posted.push(message); }, terminate() { this.terminated = true; } };
      workers.push(worker);
      return worker;
    },
  });
  const a = store.subscribeHistory(['3136705'], 'page', () => {});
  await until(() => workers[0]?.posted.length === 1, 'the run');
  workers[0].onerror?.({ message: 'Unexpected token <' });
  assert.deepEqual({ phase: store.view('3136705').phase, reason: store.view('3136705').reason }, { phase: 'unclaimed-only', reason: 'worker_failed' });
  assert.equal(workers[0].terminated, true);
  const b = store.subscribeHistory(['2310187'], 'page', () => {});
  await until(() => store.view('2310187').phase === 'unclaimed-only', 'the second id');
  assert.equal(store.view('2310187').reason, 'worker_failed');
  assert.equal(workers.length, 1, 'not respawned');
  a();
  b();
});

test('every minute while visible /state is read again; a newer block resumes from the checkpoint for the new logs only', async () => {
  const fixture = loadCase('3136705');
  const relay = fixtureRelay(fixture);
  const service = stateService();
  const { store, workers, time } = storeWith({ relays: { 3136705: relay }, service });
  const stop = store.subscribeHistory(['3136705'], 'page', () => {});
  await until(() => store.view('3136705').phase === 'verified', 'verified');
  const first = store.view('3136705');
  assert.equal(time.pending.filter((t) => t.kind === 'later' && !t.cancelled)[0].ms, STATE_REFRESH_MS);
  const asked = relay.requests.length;
  // Ten blocks later, inside the same hour (the recording has no later log, so the state is the same).
  service.bump = 10;
  assert.equal(time.fire('later'), 1);
  await until(() => store.view('3136705') !== first && store.view('3136705').phase === 'verified', 'verified again');
  const second = store.view('3136705');
  assert.equal(second.state.block, first.state.block + 10);
  const resumed = workers[0].posted.at(-1);
  assert.notEqual(resumed.checkpoint, null, 'resumed from the checkpoint');
  assert.ok(!relay.requests.slice(asked).some((r) => r.kind === 'transfer' || r.kind === 'initialize'), 'no start over');
  assert.deepEqual(second.history.earned, first.history.earned);
  stop();
});

test('the list budget stops a busy history with its place kept; a position page goes on from it with the larger budget', async () => {
  // The relay answers one busy day at a time, as its 8 MB answer cap makes it do for this pool, at its untrimmed size.
  const { store, workers } = storeWith({ relays: { 3165100: fixtureRelay(loadCase('3165100'), { maxDays: 1, swapBytes: 3 }) } });
  const list = store.subscribeHistory(['3165100'], 'list', () => {});
  await until(() => store.view('3165100').phase === 'unclaimed-only', 'stopped by the list budget');
  assert.equal(store.view('3165100').reason, 'too_much_history');
  assert.equal(workers[0].posted[0].budgetBytes, BUDGET_BYTES.list);
  const page = store.subscribeHistory(['3165100'], 'page', () => {});
  await until(() => store.view('3165100').phase === 'verified', 'verified on the page');
  const second = workers[0].posted.filter((m) => m.type === 'run')[1];
  assert.equal(second.budgetBytes, BUDGET_BYTES.page);
  assert.notEqual(second.checkpoint, null);
  list();
  page();
});

test('leaving: the run is cancelled a moment after the last screen goes, the worker ended a moment later; a quick return keeps both', async () => {
  const { store, workers, time } = storeWith();
  const stop = store.subscribeHistory(['2310187'], 'page', () => {});
  await until(() => workers[0]?.posted.length === 1, 'the run');
  stop();
  // StrictMode's second mount, or a quick return: nothing is cancelled.
  const again = store.subscribeHistory(['2310187'], 'page', () => {});
  assert.equal(time.fire('timer', RELEASE_MS), 0, 'the release was called off');
  again();
  assert.equal(time.fire('timer', RELEASE_MS), 1);
  assert.deepEqual(workers[0].posted.map((m) => m.type), ['run', 'cancel']);
  assert.equal(store.view('2310187').phase, 'idle');
  assert.equal(time.fire('timer', RELEASE_MS), 1);
  assert.equal(workers[0].terminated, true);
});

test('client.ts: no request in a build without a relay; a page, a refusal or a malformed answer is unavailable; the request is a fixed same-origin POST', async () => {
  const client = require('../.test-build/app/src/lib/fees/client.js');
  const original = globalThis.fetch;
  const sent = [];
  let reply = () => new Response('<!doctype html><title>Domino</title>', { status: 200, headers: { 'Content-Type': 'text/html' } });
  globalThis.fetch = async (url, init) => {
    sent.push([url, init]);
    return reply();
  };
  try {
    globalThis.__DOMINO_DEPLOYABLE__ = false;
    globalThis.__DOMINO_TEST_HOOKS__ = false;
    assert.deepEqual(await client.postState(['1']), { ok: false, failure: 'unavailable', retryAfterMs: 0 });
    assert.deepEqual(await client.postLogs({ kind: 'transfer', tokenId: '1' }), { ok: false, failure: 'unavailable', retryAfterMs: 0 });
    assert.equal(sent.length, 0, 'fixture and bridge-test builds ask nothing');

    globalThis.__DOMINO_DEPLOYABLE__ = true;
    assert.equal((await client.postState(['1'])).failure, 'unavailable', 'index.html from a static server');
    assert.deepEqual(sent[0], ['/api/fees/v1/state', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"tokenIds":["1"]}', credentials: 'same-origin', cache: 'no-store', signal: undefined }]);
    reply = () => new Response('{"v":1,"error":"rate_limited"}', { status: 429, headers: { 'Content-Type': 'application/json', 'Retry-After': '3' } });
    assert.deepEqual(await client.postLogs({ kind: 'transfer', tokenId: '1' }), { ok: false, failure: 'rate_limited', retryAfterMs: 3000 });
    assert.equal(sent[1][0], '/api/fees/v1/logs');
    reply = () => new Response('{"error":"beta_access_required"}', { status: 401, headers: { 'Content-Type': 'application/json' } });
    assert.equal((await client.postState(['1'])).failure, 'unavailable');
    const fixture = loadCase('3136705');
    reply = () => Response.json(fixture.state);
    const good = await client.postState(['3136705']);
    assert.equal(good.ok, true);
    assert.deepEqual(good.value, fixture.state);
    reply = () => Response.json({ ...fixture.state, positions: [{ ...fixture.state.positions[0], unclaimed0: '-1' }] });
    assert.equal((await client.postState(['3136705'])).failure, 'unavailable', 'a malformed figure is not taken');
    reply = () => Response.json({ v: 1, kind: 'swaps', head: 5, units: [{ unit: 1, from: 864000, to: 5, final: false, logs: [] }], next: null });
    assert.equal((await client.postLogs({ kind: 'swaps', poolId: `0x${'0'.repeat(64)}`, day: 1, count: 1 })).failure, 'unavailable', 'a unit that ends before it starts');
    reply = () => Response.json({ v: 1, kind: 'transfer', behind: true });
    assert.equal((await client.postLogs({ kind: 'transfer', tokenId: '1' })).ok, true);
    reply = () => Response.json({ v: 1, kind: 'pool', behind: true });
    assert.equal((await client.postLogs({ kind: 'transfer', tokenId: '1' })).ok, false, 'an answer of another kind');
  } finally {
    globalThis.fetch = original;
    delete globalThis.__DOMINO_DEPLOYABLE__;
    delete globalThis.__DOMINO_TEST_HOOKS__;
  }
});

test('the test servers\u2019 fees answers: every position not_found by default; the recorded route verifies end to end', async () => {
  const { feesDefault, feesFixtureRoute } = await import('./support/fees/stub.mjs');
  const client = require('../.test-build/app/src/lib/fees/client.js');
  const ask = (route, path, body) => route(new Request(`http://test${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  const none = await ask(feesDefault, '/api/fees/v1/state', { tokenIds: ['3135288', '42'] });
  assert.deepEqual(await none.json(), { v: 1, block: 1, timestamp: 1, positions: [{ tokenId: '3135288', ok: false, reason: 'not_found' }, { tokenId: '42', ok: false, reason: 'not_found' }] });
  assert.equal((await ask(feesDefault, '/api/fees/v1/state', { tokenIds: [] })).status, 400);
  assert.equal((await ask(feesDefault, '/api/fees/v1/logs', { kind: 'transfer', tokenId: '1' })).status, 502, 'an unexpected /logs is loud');
  assert.equal(await feesDefault(new Request('http://test/api/owned/v2/positions', { method: 'POST', body: '{}' })), undefined);

  const route = feesFixtureRoute(['3136705']);
  const toAnswer = async (response, check) => {
    const text = await response.text();
    const value = JSON.parse(text);
    assert.ok(check(value), text.slice(0, 120));
    return { ok: true, value, bytes: text.length };
  };
  const service = { postState: async (ids) => toAnswer(await ask(route, '/api/fees/v1/state', { tokenIds: ids }), client.isStateResponse) };
  const relay = { logs: async (request) => toAnswer(await ask(route, '/api/fees/v1/logs', request), (value) => client.isLogsResponse(value, request.kind)) };
  const { store } = storeWith({ service, relays: { 3136705: relay } });
  const stop = store.subscribeHistory(['3136705'], 'page', () => {});
  await until(() => store.view('3136705').phase === 'verified', 'verified through the route');
  stop();
});
