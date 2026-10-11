import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { createReceiptFollow } = require('../../.test-build/app/src/v2in/journey/receiptFollow.js');
const flush = async () => { for (let n = 0; n < 4; n++) await new Promise(resolve => setImmediate(resolve)); };
function harness() {
  let time = 0, visible = true;
  const timers = new Set();
  const follow = createReceiptFollow({ now: () => time, visible: () => visible,
    set: (run, delay) => { const timer = { run, at: time + delay }; timers.add(timer); return timer; }, clear: timer => timers.delete(timer) });
  return { follow, timers, time: () => time, visible: value => { visible = value; }, advance: value => { time += value; },
    async next() { const timer = [...timers].sort((a, b) => a.at - b.at)[0]; assert.ok(timer); timers.delete(timer); time = Math.max(time, timer.at); timer.run(); await flush(); } };
}

test('checked receipt continuation outlives its view, deduplicates the same operation and stops only on a proved outcome', async () => {
  const h = harness(), seen = []; let calls = 0, mounted = true;
  const receipts = [{ state: 'pending' }, { state: 'reorged' }, { state: 'included' }, { state: 'finalized' }];
  h.follow.follow('8453:owner:hash', { available: () => 'ready', read: async () => { calls++; return receipts.shift(); }, accept: receipt => { seen.push([mounted, receipt.state]); return receipt.state === 'finalized'; } });
  h.follow.follow('8453:owner:hash', { available: () => 'ready', read: async () => assert.fail('duplicate reader'), accept: () => true });
  mounted = false;
  for (let n = 0; n < 4; n++) await h.next();
  assert.deepEqual(seen, [[false, 'pending'], [false, 'reorged'], [false, 'included'], [false, 'finalized']]);
  assert.equal(calls, 4); assert.equal(h.timers.size, 0);
});

test('receipt continuation pauses invisible or on another chain and drops a changed account before invoking its reader', async () => {
  const h = harness(); let state = 'paused', calls = 0;
  h.follow.follow('one', { available: () => state, read: async () => { calls++; return { state: 'pending' }; }, accept: () => false });
  await h.next(); assert.equal(calls, 0);
  state = 'ready'; h.visible(false); await h.next(); assert.equal(calls, 0);
  h.visible(true); await h.next(); assert.equal(calls, 1);
  state = 'gone'; await h.next(); assert.equal(calls, 1); assert.equal(h.timers.size, 0);
});

test('receipt continuation serializes work, honors Retry-After and bounds attempts without converting delays to failure', async () => {
  const h = harness(); const calls = []; let finish;
  h.follow.follow('one', { available: () => 'ready', read: () => { calls.push(['one', h.time()]); return new Promise(resolve => { finish = resolve; }); }, accept: () => true });
  h.follow.follow('two', { available: () => 'ready', read: async () => { calls.push(['two', h.time()]); if (calls.filter(([name]) => name === 'two').length === 1) throw { retryAfterMs: 90_000 }; return { state: 'pending' }; }, accept: () => false });
  await h.next(); assert.deepEqual(calls.map(([key]) => key), ['one']);
  finish({ state: 'finalized' }); await flush();
  assert.deepEqual(calls.map(([key]) => key), ['one', 'two']);
  const first = calls.at(-1)[1]; await h.next(); assert.ok(calls.at(-1)[1] - first >= 90_000);
  for (let n = 0; h.timers.size && n < 100; n++) await h.next();
  assert.equal(calls.filter(([key]) => key === 'two').length, 80); assert.equal(h.timers.size, 0);
  h.follow.follow('expired', { available: () => 'paused', read: async () => assert.fail('expired read'), accept: () => false });
  h.advance(3_600_001); await h.next(); assert.equal(h.timers.size, 0);
});
