import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { createAprPrefetchQueue, APR_PREFETCH } = require('../.test-build/app/src/components/positions/aprPrefetchQueue.js');

function setup({ ready = new Set(), immediate = null, decline = false } = {}) {
  let now = 0, next = 0, peak = 0;
  const timers = new Map(), live = new Set(), calls = [], completed = new Map(), cancelled = [];
  const later = (ms, run) => { const id = ++next; timers.set(id, { at: now + ms, run }); return () => timers.delete(id); };
  const queue = createAprPrefetchQueue({
    later, ready: (id) => ready.has(id),
    start(id, done) {
      calls.push(id);
      if (decline) return null;
      live.add(id);
      peak = Math.max(peak, live.size);
      completed.set(id, done);
      if (immediate) done(immediate);
      return () => { live.delete(id); cancelled.push(id); };
    },
  });
  function tick(ms) {
    const until = now + ms;
    for (;;) {
      const due = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, timer] = due;
      now = timer.at; timers.delete(id); timer.run();
    }
    now = until;
  }
  return { queue, tick, calls, completed, cancelled, live, ready, timers, peak: () => peak };
}

test('visible APRs warm serially after paint, in viewport order, with two attempts maximum even after Show more', () => {
  const h = setup();
  h.queue.update(['3', '1', '2'], true);
  h.tick(APR_PREFETCH.quietMs - 1);
  assert.deepEqual(h.calls, []);
  h.tick(1);
  assert.deepEqual(h.calls, ['3']);
  h.tick(200);
  assert.deepEqual(h.calls, ['3'], 'zero fan-out while a history is being read');
  h.completed.get('3')('ready');
  h.tick(APR_PREFETCH.betweenMs - 1);
  assert.deepEqual(h.calls, ['3']);
  h.tick(1);
  assert.deepEqual(h.calls, ['3', '1']);
  h.completed.get('1')('ready');
  h.queue.update(['2', '4', '5', '6'], true);
  h.tick(60_000);
  assert.deepEqual(h.calls, ['3', '1'], 'never walks the entire wallet or next page');
  assert.equal(h.peak(), 1);
  assert.equal(h.live.size, 0);
});

test('only visible candidates are read and a current history skips the budget, unlike a persisted display copy', () => {
  const h = setup({ ready: new Set(['fresh']) });
  h.queue.update(['fresh', 'saved'], true);
  h.tick(APR_PREFETCH.quietMs);
  assert.deepEqual(h.calls, ['saved']);
  h.completed.get('saved')('ready');
  h.queue.update(['fresh', 'saved', 'newly-visible'], true);
  h.tick(APR_PREFETCH.betweenMs);
  assert.deepEqual(h.calls, ['saved', 'newly-visible']);
  assert.equal(h.peak(), 1);
});

test('hidden, offline or refund pause cancels immediately, and resuming never retries a cancelled position', () => {
  const h = setup();
  h.queue.update(['1', '2'], true);
  h.tick(APR_PREFETCH.quietMs);
  h.queue.update(['1', '2'], false);
  assert.deepEqual(h.cancelled, ['1']);
  assert.equal(h.live.size, 0);
  h.tick(60_000);
  assert.deepEqual(h.calls, ['1']);
  h.completed.get('1')('ready'); // A reply racing its abort is ignored.
  h.queue.update(['1', '2'], true);
  h.tick(APR_PREFETCH.quietMs);
  assert.deepEqual(h.calls, ['1', '2']);
  assert.equal(h.peak(), 1);
});

test('scrolling away yields that run; navigation or wallet change disposes all timers before a detail can start', () => {
  const h = setup();
  h.queue.update(['1'], true);
  h.tick(APR_PREFETCH.quietMs);
  h.queue.update(['2', '3'], true);
  assert.deepEqual(h.cancelled, ['1']);
  h.tick(APR_PREFETCH.quietMs);
  assert.deepEqual(h.calls, ['1', '2']);
  h.queue.dispose();
  assert.deepEqual(h.cancelled, ['1', '2']);
  assert.equal(h.live.size, 0);
  assert.equal(h.timers.size, 0);
  h.completed.get('2')('ready');
  h.queue.update(['3'], true);
  h.tick(60_000);
  assert.deepEqual(h.calls, ['1', '2']);
});

test('a refusal, budget failure, preemption or timeout stops the visit instead of fanning out or retrying', () => {
  for (const result of ['failed', 'yielded', 'timeout']) {
    const h = setup();
    h.queue.update(['1', '2', '3'], true);
    h.tick(APR_PREFETCH.quietMs);
    if (result === 'timeout') h.tick(APR_PREFETCH.timeoutMs);
    else h.completed.get('1')(result);
    assert.deepEqual(h.cancelled, ['1'], result);
    h.queue.update(['1', '2', '3'], true);
    h.tick(300_000);
    assert.deepEqual(h.calls, ['1'], result);
    assert.equal(h.timers.size, 0, result);
  }
});

test('foreground refusal and synchronous completion cannot leak a subscription or start parallel work', () => {
  const refused = setup({ decline: true });
  refused.queue.update(['1', '2'], true);
  refused.tick(60_000);
  assert.deepEqual(refused.calls, ['1']);
  assert.equal(refused.timers.size, 0);
  for (const immediate of ['ready', 'failed']) {
    const h = setup({ immediate });
    h.queue.update(['1', '2', '3'], true);
    h.tick(60_000);
    assert.deepEqual(h.calls, immediate === 'ready' ? ['1', '2'] : ['1']);
    assert.equal(h.peak(), 1);
    assert.equal(h.live.size, 0);
  }
});

test('the browser adapter uses visibility, network and navigation cancellation, and never subscribes page-budget history', () => {
  const source = readFileSync(new URL('../src/components/positions/useAprPrefetch.ts', import.meta.url), 'utf8');
  assert.match(source, /feesStore\.prefetchHistory\(id, inspect, \{ revalidate: true \}\)/);
  assert.match(source, /return historyIsCurrent\(view\)/);
  assert.match(source, /if \(historyIsCurrent\(view\)\) done\('ready'\)/);
  assert.doesNotMatch(source, /subscribeHistory|useFeeHistor(?:y|ies)\(/);
  for (const token of ['IntersectionObserver', 'visibilitychange', 'navigator.onLine', "'offline'", "'hashchange'", "'click'", 'addEventListener(event, react, true)', 'removeEventListener(event, react, true)']) assert.ok(source.includes(token), token);
  const owned = readFileSync(new URL('../src/components/positions/OwnedPositions.tsx', import.meta.url), 'utf8');
  assert.match(owned, /useAprPrefetch\(measured, fresh && tab === 'open' && !refunding\)/);
});
