import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import * as runtime from '../../api-contracts/performance-v2/runtime.mjs';
const require = createRequire(import.meta.url);
const { createPerformanceController } = require('../.test-build/app/src/finance/performance.js');
const fixture = path => JSON.parse(readFileSync(new URL(`../../api-contracts/performance-v2/fixtures/${path}.json`, import.meta.url)));
const epochs = fixture('responses/epochs'), cards = fixture('responses/cards');
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
function harness(handler) {
  let now = 0, visible = true, identity = { kind: 'signed_in', owner: epochs.owner, chainId: 4663, epoch: 1, connectorUid: 'one' };
  const timers = new Map(), listeners = new Set(), calls = []; let serial = 0;
  const clock = { monoMs: () => now, wallMs: () => now, setTimer(fn, ms) { const id = serial++; timers.set(id, { fn, at: now + ms }); return () => timers.delete(id); } };
  const session = { csrfAccess: true, getSnapshot: () => identity, subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    withCsrf: async (_epoch, fn) => fn('never-persist-this'), reportDenial() {} };
  const controller = createPerformanceController({ session, runtime, clock, visible: () => visible,
    fetch: async (url, init) => { calls.push({ url, init }); if (handler) return handler(url, init);
      return new Response(JSON.stringify(url.endsWith('/epochs') ? epochs : cards), { status: 200, headers: { 'Content-Type': 'application/json', 'X-Domino-Performance-Contract': runtime.CONTRACT_VERSION } }); } });
  const stop = controller.start();
  return { controller, calls, stop, async advance(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.at <= now) { timers.delete(id); timer.fn(); } await flush(); },
    identity(value) { identity = value; for (const fn of listeners) fn(); },
    visibility(value) { visible = value; controller.visibilityChanged(); } };
}
test('private cards preserve decimal strings, bind epochs and refresh within 60s with no overlap', async () => {
  const h = harness(); await flush();
  assert.equal(h.controller.getSnapshot().state, 'ready');
  assert.equal(h.controller.getSnapshot().cards[0].metrics.netFeeIncomeUsd, cards.cards[0].metrics.netFeeIncomeUsd);
  assert.equal(h.calls.length, 2);
  assert.deepEqual(JSON.parse(h.calls[1].init.body), { epochIds: epochs.enrollments.map(e => e.epochId) });
  assert.equal(h.calls[0].init.headers['X-Domino-CSRF'], 'never-persist-this');
  assert.equal(h.calls[0].init.credentials, 'same-origin');
  await h.controller.refresh(); await h.advance(59999); assert.equal(h.calls.length, 2);
  await h.advance(1); assert.equal(h.calls.length, 4); h.stop();
});
test('switching accounts clears private state immediately and drops the late former-owner reply', async () => {
  let resolve;
  const h = harness(() => new Promise(r => { resolve = r; })); await flush();
  h.identity({ kind: 'signed_out' });
  resolve(new Response(JSON.stringify(epochs), { headers: { 'Content-Type': 'application/json', 'X-Domino-Performance-Contract': runtime.CONTRACT_VERSION } })); await flush();
  assert.equal(h.controller.getSnapshot().state, 'signed_out'); assert.deepEqual(h.controller.getSnapshot().cards, []); assert.equal(h.calls.length, 1); h.stop();
});
test('foreign owner response never triggers cards or appears in the UI', async () => {
  const h = harness(() => new Response(JSON.stringify({ ...epochs, owner: '0x' + 'aa'.repeat(20) }), { headers: { 'Content-Type': 'application/json', 'X-Domino-Performance-Contract': runtime.CONTRACT_VERSION } }));
  await flush(); assert.equal(h.controller.getSnapshot().reason, 'owner_mismatch'); assert.equal(h.calls.length, 1); assert.deepEqual(h.controller.getSnapshot().cards, []); h.stop();
});
test('hidden tabs stop work, clear old numbers, and perform one bounded refresh on return', async () => {
  const h = harness(); await flush(); h.visibility(false); assert.deepEqual(h.controller.getSnapshot().cards, []);
  await h.advance(600000); assert.equal(h.calls.length, 2); h.visibility(true); await flush(); assert.equal(h.calls.length, 4); h.stop();
});
test('20s deadline aborts a stalled network and preserves a 60s retry budget', async () => {
  const h = harness((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new Error('aborted')))));
  await h.advance(20000); assert.equal(h.controller.getSnapshot().state, 'unavailable'); assert.equal(h.calls.length, 1);
  await h.advance(59999); assert.equal(h.calls.length, 1); await h.advance(1); assert.equal(h.calls.length, 2); h.stop();
});
test('incomplete financial coverage keeps APR null in the producer fixture', () => {
  const value = fixture('variants/unqualified-prices');
  assert.ok(runtime.validateResponse('cards', value));
  assert.equal(value.cards[0].metrics.grossFeeAprPercent, null); assert.equal(value.cards[0].metrics.netFeeAprPercent, null);
});
