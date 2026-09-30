import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fixtureRelay, loadCase, stateOfCase } from './support/fees/relay-fixture.mjs';

const require = createRequire(import.meta.url);
const { createFeesStore, RETRY_MS } = require('../.test-build/app/src/lib/fees/store.js');
const { createHistoryCache, HISTORY_MAX_AGE_MS } = require('../.test-build/app/src/lib/fees/historyCache.js');
const { runPipeline } = require('../.test-build/app/src/lib/fees/pipeline.js');
const { BUDGET_BYTES } = require('../.test-build/app/src/lib/fees/constants.js');
const { historyIsCurrent, HISTORY_CURRENT_MS } = require('../.test-build/app/src/lib/fees/freshness.js');
const id = '3136705';
const fixture = loadCase(id);
const { state, growth } = stateOfCase(fixture);
const result = await runPipeline({ logs: fixtureRelay(fixture).logs, sleep: async () => {} }, { id, state, growth, budgetBytes: 16 * 1024 * 1024, checkpoint: null });
assert.equal(result.ok, true);
const verified = { phase: 'verified', state, history: result.history, prices: result.prices };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function setup({ saved = true, pending = false, down = false } = {}) {
  const now = state.timestamp * 1000 + 1000;
  const values = new Map();
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  const historyCache = createHistoryCache(() => storage, () => now);
  if (saved) historyCache.save(id, verified);
  const timers = [], reads = [], waiting = [];
  const timer = kind => (ms, run) => { const item = { kind, ms, run, cancelled: false }; timers.push(item); return () => { item.cancelled = true; }; };
  const worker = { posted: [], onmessage: null, onerror: null, onmessageerror: null, postMessage(message) { this.posted.push(message); }, terminate() {} };
  let responseState = fixture.state;
  const answer = ids => ({ ok: true, value: { ...responseState, positions: ids.map(tokenId => ({ ...responseState.positions[0], tokenId })) }, bytes: 100 });
  const store = createFeesStore({
    historyCache, now: () => now, spawn: () => worker, timer: timer('timer'), later: timer('later'),
    postState(ids) { reads.push(ids); if (down) return Promise.resolve({ ok: false, failure: 'unavailable', retryAfterMs: 0 }); if (pending) return new Promise(resolve => waiting.push(() => resolve(answer(ids)))); return Promise.resolve(answer(ids)); },
  });
  return {
    store, historyCache, values, worker, timers, reads, waiting,
    respondWith: value => { responseState = value; },
    send(value, tokenId = id) { worker.onmessage?.({ data: { type: 'done', id: tokenId, runId: worker.posted.findLast((m) => m.type === 'run' && m.id === tokenId)?.runId, result: value } }); },
    offer(position, block = fixture.state.block) { store.offer({ ok: true, value: { ...fixture.state, block, positions: [position] }, bytes: 100 }); },
    runs: () => worker.posted.filter(m => m.type === 'run'),
    fire(kind, ms) { const selected = timers.filter(t => !t.cancelled && t.kind === kind && t.ms === ms); for (const t of selected) { t.cancelled = true; t.run(); } return selected.length; },
  };
}
test('restore is synchronous presentation only; an independent fresh state and full replay still run', async () => {
  const f = setup({ pending: true });
  const stop = f.store.subscribeHistory([id], 'page', () => {});
  assert.equal(f.store.view(id).phase, 'cached');
  assert.equal(f.store.position(id), null);
  assert.equal(f.store.states([id]), null);
  assert.equal(f.runs().length, 0);
  await flush();
  assert.deepEqual(f.reads, [[id]]);
  f.waiting[0](); await flush();
  assert.equal(f.runs().length, 1);
  assert.equal(f.runs()[0].checkpoint, null, 'cached history is never an accounting checkpoint');
  assert.deepEqual(f.runs()[0].growth, growth, 'only fresh chain growth is used');
  assert.equal(f.store.view(id).phase, 'cached', 'fresh state alone cannot certify the old chart');
  f.send(result);
  assert.equal(f.store.view(id).phase, 'verified');
  stop();
});

test('an old in-memory verified APR does not complete a revalidating prefetch before a new state and replay arrive', async () => {
  const f = setup({ saved: false, pending: true });
  f.offer(fixture.state.positions[0]);
  const stopPage = f.store.subscribeHistory([id], 'page', () => {});
  f.send(result); stopPage();
  assert.equal(f.store.view(id).phase, 'verified');
  const now = state.timestamp * 1000 + HISTORY_CURRENT_MS + 1_000;
  let ready = 0;
  const stop = f.store.prefetchHistory(id, () => { if (historyIsCurrent(f.store.view(id), now)) ready += 1; }, { revalidate: true });
  assert.equal(historyIsCurrent(f.store.view(id), now), false);
  assert.equal(f.runs().length, 1, 'only the already completed old run; no replay of the old state');
  await flush();
  assert.deepEqual(f.reads, [[id]], 'exactly one new state request');
  assert.equal(ready, 0);
  f.respondWith({ ...fixture.state, block: state.block + 1, timestamp: Math.floor(now / 1000) });
  f.waiting[0](); await flush();
  assert.equal(f.runs().length, 2);
  assert.equal(f.runs()[1].state.block, state.block + 1);
  assert.equal(f.runs()[1].budgetBytes, BUDGET_BYTES.list);
  assert.equal(ready, 0, 'fresh state alone does not relabel the old verified history');
  f.send(result);
  assert.equal(ready, 1);
  stop();
});

test('cancellation or opening a detail withdraws a queued background revalidation before any extra state request', async () => {
  for (const detail of [false, true]) {
    const f = setup({ saved: false });
    f.offer(fixture.state.positions[0]);
    let stop;
    stop = f.store.prefetchHistory(id, end => { if (end) stop?.(); }, { revalidate: true });
    const page = detail ? f.store.subscribeHistory(['2'], 'page', () => {}) : null;
    if (!detail) stop();
    await flush();
    assert.ok(!f.reads.some(ids => ids.includes(id)), 'no new call for the prefetch after it was abandoned');
    assert.ok(!f.runs().some(run => run.id === id));
    page?.();
  }
});
test('initial state/RPC outage retains the labelled snapshot and still retries; no fabricated current state', async () => {
  const f = setup({ down: true });
  const stop = f.store.subscribeHistory([id], 'page', () => {});
  const saved = f.store.view(id);
  await flush();
  assert.equal(f.store.view(id), saved);
  assert.equal(f.store.position(id), null);
  assert.equal(f.store.states([id]).get(id), null);
  assert.equal(f.fire('later', RETRY_MS[0]), 1);
  await flush();
  assert.equal(f.reads.length, 2);
  assert.equal(f.runs().length, 0);
  stop();
});
test('fresh state incompatibility and absence remove the saved display and persistence', async () => {
  for (const changes of [
    { liquidity: (state.liquidity + 1n).toString() },
    { poolId: `0x${'a'.repeat(64)}` },
    { sqrtPriceX96: (state.sqrtPriceX96 + 1n).toString() },
    { ok: false, reason: 'not_found' },
    { ok: false, reason: 'hooked_pool' },
  ]) {
    const f = setup({ pending: true });
    const stop = f.store.subscribeHistory([id], 'page', () => {});
    f.offer({ ...fixture.state.positions[0], ...changes });
    assert.equal(f.historyCache.load(id), null);
    assert.notEqual(f.store.view(id).phase, 'cached');
    stop();
  }
});
test('replay mismatch rejects the persisted display, while a transient worker failure does not', async () => {
  for (const reason of ['rpc_unavailable', 'worker_failed', 'replay_mismatch']) {
    const f = setup();
    const stop = f.store.subscribeHistory([id], 'page', () => {}); await flush();
    f.send({ ok: false, reason, prices: null, checkpoint: null, bytes: 0 });
    assert.equal(f.store.view(id).phase, reason === 'replay_mismatch' ? 'unclaimed-only' : 'cached');
    assert.equal(!!f.historyCache.load(id), reason !== 'replay_mismatch');
    stop();
  }
});
test('an action invalidates a saved snapshot immediately and an older live run cannot repersist it', async () => {
  const f = setup();
  const stop = f.store.subscribeHistory([id], 'page', () => {}); await flush();
  f.store.refresh([id]);
  assert.equal(f.historyCache.load(id), null);
  assert.notEqual(f.store.view(id).phase, 'cached');
  assert.ok(f.worker.posted.some(m => m.type === 'cancel'));
  stop();
  const live = setup({ saved: false });
  const stopLive = live.store.subscribeHistory([id], 'page', () => {}); await flush();
  live.store.refresh([id]);
  live.send(result);
  assert.equal(live.store.view(id).phase, 'verified', 'current visit behavior preserved');
  assert.equal(live.historyCache.load(id), null, 'pre-action replay is not persisted again');
  stopLive();
});
test('an already restored snapshot expires during a long open visit, without cancelling a fresh replay', async () => {
  const f = setup();
  const stop = f.store.subscribeHistory([id], 'page', () => {}); await flush();
  assert.equal(f.fire('timer', HISTORY_MAX_AGE_MS - 1000), 1);
  assert.notEqual(f.store.view(id).phase, 'cached');
  assert.equal(f.historyCache.load(id), null);
  assert.equal(f.worker.posted.filter(m => m.type === 'cancel').length, 0);
  f.send(result);
  assert.equal(f.store.view(id).phase, 'verified');
  stop();
});
test('safe transient worker checkpoint resumes in memory at the same block after backoff, never as cached/verified', async () => {
  const f = setup({ saved: false });
  const stop = f.store.subscribeHistory([id], 'page', () => {}); await flush();
  const prefix = { ...result.checkpoint, bytes: 0 };
  f.send({ ok: false, reason: 'rpc_unavailable', prices: null, checkpoint: prefix, later: true, bytes: 100 });
  assert.equal(f.store.view(id).phase, 'unclaimed-only');
  assert.equal(f.values.size, 0);
  f.fire('later', RETRY_MS[0]);
  assert.equal(f.runs().length, 2);
  assert.equal(f.runs()[1].state.block, f.runs()[0].state.block);
  assert.equal(f.runs()[1].checkpoint, prefix);
  stop();
});
test('prefetch uses the existing list budget, yields immediately to a detail and never cancels its page subscriber', async () => {
  const f = setup({ saved: false });
  const events = [];
  let stopBackground;
  stopBackground = f.store.prefetchHistory(id, end => { if (end) { events.push(end); stopBackground?.(); } });
  assert.equal(typeof stopBackground, 'function'); await flush();
  assert.equal(f.runs()[0].budgetBytes, BUDGET_BYTES.list);
  const stopPage = f.store.subscribeHistory(['2'], 'page', () => {}); await flush();
  assert.deepEqual(events, ['yielded']);
  assert.ok(f.worker.posted.some(m => m.type === 'cancel' && m.id === id));
  assert.equal(f.store.prefetchHistory('3', () => {}), null);
  stopPage();
  assert.equal(f.runs().filter(m => m.id === id).length, 1, 'cancelled background does not restart');
  const same = setup({ saved: false });
  const cancel = same.store.prefetchHistory(id, () => {}); await flush();
  const close = same.store.subscribeHistory([id], 'page', () => {});
  cancel();
  assert.equal(same.worker.posted.filter(m => m.type === 'cancel').length, 0, 'page owns the shared run now');
  close();
});
test('prefetch failure signals stop even when saved history remains displayed; no background retry survives', async () => {
  const f = setup();
  const events = [];
  let stop;
  stop = f.store.prefetchHistory(id, end => { if (end) { events.push(end); stop?.(); } }); await flush();
  f.send({ ok: false, reason: 'rpc_unavailable', prices: null, checkpoint: null, bytes: 0 });
  assert.deepEqual(events, ['failed']);
  assert.equal(f.store.view(id).phase, 'cached');
  assert.equal(f.timers.filter(t => !t.cancelled && t.ms === RETRY_MS[0]).length, 0);
});
