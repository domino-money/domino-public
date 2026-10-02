/**
 * The fees store with this browser's saved histories (src/lib/fees/store.ts and historyCache.ts): a saved copy is
 * presentation only, drawn at once and replaced by the chain's own; the state and the ledger are read regardless; a
 * change in the position takes the copy down; an action does too; and a long visit lets an old copy go.
 * Changed on purpose 2026-10-02 (RPC-SPEC §11.4): the history is the position's ledger, not a worker's replay.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { ID, ledgerRead, statePosition, verifiedView } from './support/fees/verified.mjs';

const require = createRequire(import.meta.url);
const { createFeesStore, RETRY_MS } = require('../.test-build/app/src/lib/fees/store.js');
const { createHistoryCache, HISTORY_MAX_AGE_MS } = require('../.test-build/app/src/lib/fees/historyCache.js');
const verified = verifiedView();
const read = ledgerRead();
const flush = async () => { for (let i = 0; i < 3; i++) await new Promise((done) => setTimeout(done, 0)); };

/** The /state answer at the ledger's block, its position patched. */
const stateAnswer = (patch = {}, block = read.block) => ({ ok: true, value: { v: 1, block, timestamp: read.timestamp + (block - read.block), positions: [statePosition(patch)] }, bytes: 100 });
const ledgerAnswer = () => ({ ok: true, value: { v: 1, block: read.block, timestamp: read.timestamp, positions: [read.position] }, bytes: 100 });

function setup({ saved = true, pending = false, down = false } = {}) {
  const now = read.timestamp * 1000 + 1000;
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const historyCache = createHistoryCache(() => storage, () => now);
  if (saved) historyCache.save(ID, verified);
  const timers = [];
  const reads = [];
  const ledgers = [];
  const waiting = [];
  const timer = (kind) => (ms, run) => { const item = { kind, ms, run, cancelled: false }; timers.push(item); return () => { item.cancelled = true; }; };
  const store = createFeesStore({
    historyCache, now: () => now, timer: timer('timer'), later: timer('later'),
    postState(ids) { reads.push(ids); if (down) return Promise.resolve({ ok: false, failure: 'unavailable', retryAfterMs: 0 }); if (pending) return new Promise((resolve) => waiting.push(() => resolve(stateAnswer()))); return Promise.resolve(stateAnswer()); },
    postLedger(ids, fresh) { ledgers.push({ ids, fresh }); if (down) return Promise.resolve({ ok: false, failure: 'unavailable', retryAfterMs: 0 }); return pending ? new Promise((resolve) => waiting.push(() => resolve(ledgerAnswer()))) : Promise.resolve(ledgerAnswer()); },
  });
  return {
    store, historyCache, values, timers, reads, ledgers, waiting,
    fire(kind, ms) { const selected = timers.filter((t) => !t.cancelled && t.kind === kind && t.ms === ms); for (const t of selected) { t.cancelled = true; t.run(); } return selected.length; },
  };
}

test('restore is synchronous presentation only; the state and the ledger are still read, and the chain’s own view replaces the copy', async () => {
  const f = setup({ pending: true });
  const stop = f.store.subscribeHistory([ID], 'page', () => {});
  assert.equal(f.store.view(ID).phase, 'cached');
  assert.equal(f.store.position(ID), null);
  assert.equal(f.store.states([ID]), null);
  await flush();
  assert.deepEqual(f.reads, [[ID]]);
  assert.deepEqual(f.ledgers, [{ ids: [ID], fresh: false }]);
  // The state alone cannot certify the old chart.
  f.waiting[0]();
  await flush();
  assert.equal(f.store.view(ID).phase, 'cached');
  f.waiting[1]();
  await flush();
  assert.equal(f.store.view(ID).phase, 'verified');
  stop();
});

test('an outage at first keeps the labelled copy and still asks again; no current state is made up', async () => {
  const f = setup({ down: true });
  const stop = f.store.subscribeHistory([ID], 'page', () => {});
  const saved = f.store.view(ID);
  await flush();
  assert.equal(f.store.view(ID), saved);
  assert.equal(f.store.position(ID), null);
  assert.equal(f.store.states([ID]).get(ID), null);
  assert.ok(f.fire('later', RETRY_MS[0]) >= 1);
  await flush();
  assert.ok(f.reads.length >= 2);
  stop();
});

test('a state that no longer fits the copy, or a position gone, takes the copy down from the screen and from the browser', async () => {
  for (const changes of [
    { liquidity: '3001' },
    { poolId: `0x${'a'.repeat(64)}` },
    { sqrtPriceX96: (2n ** 96n + 1n).toString() },
    { ok: false, reason: 'not_found' },
    { ok: false, reason: 'hooked_pool' },
  ]) {
    const f = setup({ pending: true });
    const stop = f.store.subscribeHistory([ID], 'page', () => {});
    f.store.offer(stateAnswer(changes));
    assert.equal(f.historyCache.load(ID), null, JSON.stringify(changes));
    assert.notEqual(f.store.view(ID).phase, 'cached');
    stop();
  }
});

test('an action takes a saved copy down at once; the next verified view is saved again', async () => {
  const f = setup();
  const stop = f.store.subscribeHistory([ID], 'page', () => {});
  await flush();
  assert.equal(f.store.view(ID).phase, 'verified');
  f.store.refresh([ID]);
  assert.equal(f.historyCache.load(ID), null);
  await flush();
  stop();
});

test('a copy restored for a long open visit lets go when it grows too old, and the chain’s own view stays', async () => {
  const f = setup({ pending: true });
  const stop = f.store.subscribeHistory([ID], 'page', () => {});
  assert.equal(f.fire('timer', HISTORY_MAX_AGE_MS - 1000), 1);
  assert.notEqual(f.store.view(ID).phase, 'cached');
  assert.equal(f.historyCache.load(ID), null);
  await flush();
  for (const go of f.waiting.splice(0)) go();
  await flush();
  assert.equal(f.store.view(ID).phase, 'verified');
  stop();
});
