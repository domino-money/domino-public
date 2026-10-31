/**
 * New position's kept plans (2026-10-30, QA round 2, INST-2, the owner's "New position faster";
 * src/v2in/journey/model/planCache.ts), with the plan service and the clock in the test's hands:
 *   - a usable plan is handed out again for the same key while its quote has at least PLAN_REUSE_MIN_LEFT_S (two minutes)
 *     left, never when the caller does not allow it, never past that margin, and never an answer that was not a plan;
 *   - a plan still being asked for the same key is joined, never asked twice;
 *   - one caller giving up leaves the shared request to the others, and the request stops only when nobody waits for it;
 *   - a forgotten key is asked again, and at most PLAN_CACHE_MAX keys are kept.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createPlanCache, PLAN_REUSE_MIN_LEFT_S, PLAN_CACHE_MAX } = require('../../.test-build/app/src/v2in/journey/model/planCache.js');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const ok = (expiresAt, quoteExpiresAt = expiresAt) => ({ kind: 'ok', reply: { facts: { expiresAt }, quote: { expiresAt: quoteExpiresAt } } });

/** A plan service the test answers by hand: each ask waits until the test settles it. */
function service() {
  const asks = [];
  const ask = (signal) => new Promise((resolve) => {
    const entry = { signal, resolve, aborted: false };
    signal.addEventListener('abort', () => { entry.aborted = true; });
    asks.push(entry);
  });
  return { asks, ask };
}

test('a usable plan is handed out again for the same key while two minutes are left, and only when the caller allows it', async () => {
  assert.equal(PLAN_REUSE_MIN_LEFT_S, 120, 'more than the idle refresh (30 s left) plus an approval then the position');
  let now = 1_000;
  const cache = createPlanCache(() => now);
  const plans = service();
  const first = cache.plan('k', plans.ask, { signal: new AbortController().signal, reuse: true });
  assert.equal(plans.asks.length, 1);
  plans.asks[0].resolve(ok(1_180));
  assert.deepEqual(await first, { result: ok(1_180), kept: false });
  // Back, then Continue: the same choices take the kept plan, with no new ask.
  now = 1_050;
  const again = await cache.plan('k', plans.ask, { signal: new AbortController().signal, reuse: true });
  assert.deepEqual(again, { result: ok(1_180), kept: true });
  assert.equal(plans.asks.length, 1, 'not asked again');
  // A quote asked again (the price moved, the quote ran out) never takes it: a new ask.
  const requote = cache.plan('k', plans.ask, { signal: new AbortController().signal, reuse: false });
  assert.equal(plans.asks.length, 2);
  plans.asks[1].resolve(ok(1_300));
  assert.equal((await requote).kept, false);
  // Less than the margin left: asked again.
  now = 1_300 - PLAN_REUSE_MIN_LEFT_S + 1;
  const late = cache.plan('k', plans.ask, { signal: new AbortController().signal, reuse: true });
  assert.equal(plans.asks.length, 3, 'a plan about to expire is never handed out');
  plans.asks[2].resolve(ok(now + 180));
  assert.equal((await late).kept, false);
  // Exactly the margin left is still enough; a second less is not.
  const boundary = now + 180 - PLAN_REUSE_MIN_LEFT_S;
  now = boundary;
  assert.equal((await cache.plan('k', plans.ask, { signal: new AbortController().signal, reuse: true })).kept, true);
  now = boundary + 1;
  const past = cache.plan('k', plans.ask, { signal: new AbortController().signal, reuse: true });
  assert.equal(plans.asks.length, 4, 'one second under the margin: asked again');
  plans.asks[3].resolve(ok(now + 180));
  assert.equal((await past).kept, false);
});

test('the earlier of the reply\'s two expiries decides', async () => {
  let now = 0;
  const cache = createPlanCache(() => now);
  const plans = service();
  const first = cache.plan('k', plans.ask, { signal: new AbortController().signal, reuse: true });
  plans.asks[0].resolve(ok(300, 100));
  await first;
  now = 50;
  const again = cache.plan('k', plans.ask, { signal: new AbortController().signal, reuse: true });
  assert.equal(plans.asks.length, 2, 'the quote expires at 100: under the margin at 50, though the facts last until 300');
  plans.asks[1].resolve(ok(400));
  await again;
});

test('an answer that is not a plan is never kept', async () => {
  const cache = createPlanCache(() => 0);
  const plans = service();
  for (const answer of [{ kind: 'unavailable', reason: 'network' }, { kind: 'refused', code: 'position_plan_capacity_busy', status: 503 }, { kind: 'expired' }]) {
    const asked = cache.plan('k', plans.ask, { signal: new AbortController().signal, reuse: true });
    plans.asks.at(-1).resolve(answer);
    assert.deepEqual(await asked, { result: answer, kept: false });
  }
  assert.equal(plans.asks.length, 3, 'each asked anew');
});

test('a plan still being asked for the same key is joined, never asked twice', async () => {
  const cache = createPlanCache(() => 0);
  const plans = service();
  const a = cache.plan('k', plans.ask, { signal: new AbortController().signal, reuse: true });
  const b = cache.plan('k', plans.ask, { signal: new AbortController().signal, reuse: false });
  const other = cache.plan('other', plans.ask, { signal: new AbortController().signal, reuse: true });
  assert.equal(plans.asks.length, 2, 'one ask per key');
  plans.asks[0].resolve(ok(500));
  plans.asks[1].resolve(ok(600));
  assert.deepEqual(await a, { result: ok(500), kept: false });
  assert.deepEqual(await b, { result: ok(500), kept: false });
  assert.deepEqual(await other, { result: ok(600), kept: false });
});

test('one caller giving up leaves the shared request to the others; it stops only when nobody waits for it', async () => {
  const cache = createPlanCache(() => 0);
  const plans = service();
  const first = new AbortController();
  const second = new AbortController();
  const a = cache.plan('k', plans.ask, { signal: first.signal, reuse: true });
  const b = cache.plan('k', plans.ask, { signal: second.signal, reuse: true });
  first.abort();
  assert.deepEqual(await a, { result: { kind: 'unavailable', reason: 'aborted' }, kept: false }, 'the one who gave up hears at once');
  assert.equal(plans.asks[0].aborted, false, 'the other still waits: the request goes on');
  plans.asks[0].resolve(ok(500));
  assert.deepEqual(await b, { result: ok(500), kept: false });
  // Nobody waits any more: the request itself stops, and nothing of it is kept.
  const lone = new AbortController();
  const c = cache.plan('j', plans.ask, { signal: lone.signal, reuse: true });
  lone.abort();
  assert.equal((await c).result.reason, 'aborted');
  assert.equal(plans.asks[1].aborted, true, 'the plan request is stopped');
  plans.asks[1].resolve(ok(500));
  await flush();
  const d = cache.plan('j', plans.ask, { signal: new AbortController().signal, reuse: true });
  assert.equal(plans.asks.length, 3, 'a stopped request is never handed out');
  plans.asks[2].resolve(ok(500));
  await d;
  // A caller already aborted asks nothing.
  const gone = new AbortController();
  gone.abort();
  assert.equal((await cache.plan('n', plans.ask, { signal: gone.signal, reuse: true })).result.reason, 'aborted');
  assert.equal(plans.asks.length, 3);
});

test('a forgotten key is asked again; at most PLAN_CACHE_MAX keys are kept, the least recently used going first', async () => {
  const cache = createPlanCache(() => 0);
  let asks = 0;
  const ask = async () => {
    asks++;
    return ok(1_000);
  };
  const take = (key) => cache.plan(key, ask, { signal: new AbortController().signal, reuse: true });
  assert.equal((await take('k')).kept, false);
  assert.equal((await take('k')).kept, true);
  assert.equal(asks, 1);
  cache.forget('k');
  assert.equal((await take('k')).kept, false, 'forgotten: asked again');
  assert.equal(asks, 2);
  for (let i = 0; i < PLAN_CACHE_MAX; i++) await take(`key-${i}`);
  assert.equal((await take('k')).kept, false, 'the oldest key went first');
  assert.equal((await take(`key-${PLAN_CACHE_MAX - 1}`)).kept, true, 'a recent key stays');
});
