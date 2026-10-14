/**
 * Where the Positions screen's lists read read-v6 from (src/v2in/lists/read.ts; spec F7 rev4 §6.2; the integration
 * brief's data rule), through the integrated screens' shared transports (src/v2in/dataSource.ts createV2Transports):
 * a `live` chain's reads go to the site's route only while its capabilities say it serves them, about the wallet asked
 * (an answer about another wallet is refused, so test data never becomes the person's), and a route that is off is a
 * dash with its reason, never test data (no example rows exist any more: real data only, the owner, 2026-10-02). And the
 * shared keyed reader: one read per key, asked again by itself (no Retry button), nothing read while the
 * page is hidden.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as runtime from '../../../api-contracts/read-v6/runtime.mjs';

const require = createRequire(import.meta.url);
const read = require('../../.test-build/app/src/v2in/lists/read.js');
const data = require('../../.test-build/app/src/v2in/dataSource.js');
const { browserWakeSource, createWake } = require('../../.test-build/app/src/lib/wake.js');

const CONTRACTS = resolve(import.meta.dirname, '../../../api-contracts');
const fixture = (name) => JSON.parse(readFileSync(join(CONTRACTS, 'read-v6', 'fixtures', 'valid', name), 'utf8'));
const EXAMPLE_WALLET = '0xb1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1b1';
const PERSON = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';

/** A live chain's transports over a fake route: `answer(route, body)` is its reply, `state` the capabilities' word. */
function liveTransports({ state = { on: true, routes: ['portfolio', 'activity'] }, answer = () => ({ status: 200, body: fixture('portfolio.json') }) } = {}) {
  const posted = [];
  const probed = [];
  const transports = data.createV2Transports({ mode: 'live' }, {
    runtimes: { read: runtime, plan: {} },
    live: () => ({
      read: { kind: 'http', post: async (route, body) => (posted.push({ route, body }), answer(route, body)) },
      plan: { kind: 'http', plan: async () => ({ status: 503, body: {} }) },
      probe: { state: async (route) => (probed.push(route), state), forget() {} },
    }),
    script: () => null,
  });
  return { transports, posted, probed };
}
const source = (live) => read.createListsReads(async () => ({ live }));

test('live: the site’s route, only while its capabilities serve the read, about the wallet asked in lower case', async () => {
  const live = liveTransports();
  const reply = await source(live.transports).ownPortfolio(EXAMPLE_WALLET.toUpperCase().replace('0X', '0x'));
  assert.equal(reply.kind, 'ok');
  assert.ok(live.probed.length >= 1 && live.probed.every((route) => route === 'readV6'), 'the route’s capabilities asked first');
  assert.deepEqual(live.posted, [{ route: 'portfolio', body: { wallet: EXAMPLE_WALLET } }]);
  const activity = liveTransports({ answer: () => ({ status: 200, body: fixture('activity.json') }) });
  assert.equal((await source(activity.transports).ownActivity(EXAMPLE_WALLET, { limit: 20 })).kind, 'ok');
  assert.deepEqual(activity.posted, [{ route: 'activity', body: { wallet: EXAMPLE_WALLET, limit: 20 } }]);
});

test('live: an answer about another wallet is refused (test data is never the person’s), and nothing invalid is drawn', async () => {
  assert.deepEqual(await source(liveTransports().transports).ownPortfolio(PERSON), { kind: 'invalid', detail: 'exchange' });
  const broken = liveTransports({ answer: () => ({ status: 200, body: { ...fixture('portfolio.json'), coverage: 'complete' } }) });
  assert.deepEqual(await source(broken.transports).ownPortfolio(EXAMPLE_WALLET), { kind: 'invalid', detail: 'response' });
});

test('live: a route that is off is a dash with its reason, asked of nothing; the index down is its own reason', async () => {
  for (const reason of ['not_deployed', 'disabled', 'gate_required', 'unavailable']) {
    const off = liveTransports({ state: { on: false, reason } });
    assert.deepEqual(await source(off.transports).ownPortfolio(PERSON), { kind: 'unavailable', reason });
    assert.deepEqual(off.posted, [], `${reason}: nothing is sent`);
  }
  // On, but not serving this read.
  const portfolioOnly = liveTransports({ state: { on: true, routes: ['portfolio'] } });
  assert.deepEqual(await source(portfolioOnly.transports).ownActivity(PERSON), { kind: 'unavailable', reason: 'route_not_available' });
  const down = liveTransports({ answer: () => ({ status: 503, body: { error: 'upstream_unavailable' } }) });
  assert.deepEqual(await source(down.transports).ownPortfolio(PERSON), { kind: 'unavailable', reason: 'upstream_unavailable' });
  // No live chain: nothing of the person's is read.
  assert.deepEqual(await source(null).ownPortfolio(PERSON), { kind: 'unavailable', reason: 'gate_off' });
});

/** Timers the test moves by hand, and a page whose visibility it sets. */
function fakeTimers() {
  let now = 0;
  let visible = true;
  const queue = [];
  const wakers = new Set();
  return {
    timers: {
      now: () => now,
      set: (run, ms) => {
        const handle = { at: now + ms, run };
        queue.push(handle);
        return handle;
      },
      clear: (handle) => {
        const at = queue.indexOf(handle);
        if (at >= 0) queue.splice(at, 1);
      },
      visible: () => visible,
      onVisible: (run) => {
        wakers.add(run);
        return () => wakers.delete(run);
      },
    },
    pending: () => queue.map((handle) => handle.at - now),
    async advance(ms) {
      now += ms;
      for (const handle of queue.filter((h) => h.at <= now)) {
        queue.splice(queue.indexOf(handle), 1);
        handle.run();
      }
      await new Promise((done) => setImmediate(done));
    },
    async show(next) {
      visible = next;
      if (next) for (const run of [...wakers]) {
        wakers.delete(run);
        run();
      }
      await new Promise((done) => setImmediate(done));
    },
  };
}

test('the keyed reader: one read per key for every view, kept, asked again by itself after a failure, never while hidden', async () => {
  const clock = fakeTimers();
  const answers = [{ kind: 'unavailable', reason: 'network' }, { kind: 'ok', body: 1 }, { kind: 'ok', body: 2 }];
  const asked = [];
  const reader = read.createKeyedReader(async (key) => {
    asked.push(key);
    return answers.shift();
  }, { next: read.readAgainAfter, failed: (reply) => reply.kind !== 'ok' }, clock.timers);
  let heard = 0;
  const stopA = reader.subscribe('w', () => heard++);
  const stopB = reader.subscribe('w', () => heard++);
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(asked, ['w'], 'two views, one read');
  assert.deepEqual(reader.get('w'), { kind: 'unavailable', reason: 'network' });
  assert.equal(heard, 2);
  assert.deepEqual(clock.pending(), [5_000], 'a failure is asked again 5 s later, by itself');
  await clock.advance(5_000);
  assert.deepEqual(reader.get('w'), { kind: 'ok', body: 1 });
  assert.deepEqual(clock.pending(), [60_000], 'a good answer a minute later');
  stopA();
  stopB();
  assert.deepEqual(clock.pending(), [], 'nobody watching: nothing is asked');
  assert.deepEqual(reader.get('w'), { kind: 'ok', body: 1 }, 'the answer is kept for the next view');
  await clock.show(false);
  reader.subscribe('w', () => undefined);
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(asked, ['w', 'w'], 'hidden: not read');
  await clock.show(true);
  assert.deepEqual(asked, ['w', 'w', 'w'], 'read once the page is visible again');
  assert.deepEqual(reader.get('w'), { kind: 'ok', body: 2 });
  assert.equal(read.readAgainAfter({ kind: 'unavailable', reason: 'x' }, 2), 15_000);
  assert.equal(read.readAgainAfter({ kind: 'unavailable', reason: 'x' }, 3), 45_000);
  assert.equal(read.readAgainAfter({ kind: 'unavailable', reason: 'x' }, 9), 60_000);
  assert.equal(read.readAgainAfter({ kind: 'invalid', detail: 'response' }, 1), 300_000, 'a broken answer is not asked again soon');
  // Added 2026-10-06 (rugged's answer of 6 Oct, §1): never sooner than the Retry-After a busy reader named.
  assert.equal(read.readAgainAfter({ kind: 'unavailable', reason: 'read_capacity_busy', retryAfterSeconds: 9 }, 1), 9_000);
  assert.equal(read.readAgainAfter({ kind: 'unavailable', reason: 'read_capacity_busy', retryAfterSeconds: 2 }, 1), 5_000, 'a shorter one changes nothing');
  assert.equal(read.readAgainAfter({ kind: 'unavailable', reason: 'read_capacity_busy', retryAfterSeconds: 30 }, 2), 30_000);
});

test('confirmation during a read is not lost and a failed refresh keeps the last good snapshot', async () => {
  const clock = fakeTimers();
  const requests = [];
  const reader = read.createKeyedReader(() => new Promise((resolve) => requests.push(resolve)), { next: read.readAgainAfter, failed: (reply) => reply.kind !== 'ok' }, clock.timers);
  const off = reader.subscribe('wallet', () => {});
  reader.again('wallet');
  reader.again('wallet');
  requests[0]({ kind: 'ok', body: { block: 1 } });
  await clock.advance(0);
  assert.equal(reader.get('wallet'), null, 'pre-confirmation response never becomes the current snapshot');
  assert.equal(requests.length, 2, 'coalesced invalidations cause one follow-up read');
  requests[1]({ kind: 'ok', body: { block: 2 } });
  await clock.advance(0);
  reader.again('wallet');
  requests[2]({ kind: 'unavailable', reason: 'read_capacity_busy', retryAfterSeconds: 30 });
  await clock.advance(0);
  assert.equal(reader.get('wallet').body.block, 2, 'failure does not erase known rows');
  assert.equal(reader.getLatest('wallet').kind, 'unavailable', 'failure remains available for a quiet notice');
  reader.again('wallet');
  await clock.advance(29_999);
  assert.equal(requests.length, 3, 'confirmation cannot bypass the upstream Retry-After');
  await clock.advance(1);
  assert.equal(requests.length, 4);
  off();
});

// Changed on purpose 2026-10-14 (incident 2026-10-13, design 2.5, package Q1): a wake reads a key only once its last good
// answer is older than the key's own period; it read every watched key again at every focus, online and visibility change.
test('shared wake refreshes an active key once, only past its period, and projects observed state without another network read', async () => {
  const clock = fakeTimers();
  let wake;
  let wakesRemoved = 0;
  let reads = 0;
  // The reader's clock moves without its timers (a background tab's frozen timers).
  let skew = 0;
  const base = clock.timers.now;
  clock.timers.now = () => base() + skew;
  clock.timers.onWake = (run) => { wake = run; return () => wakesRemoved++; };
  const reader = read.createKeyedReader(async () => ({ kind: 'ok', body: ++reads }), { next: read.readAgainAfter, failed: (reply) => reply.kind !== 'ok' }, clock.timers);
  const a = reader.subscribe('wallet', () => {});
  const b = reader.subscribe('wallet', () => {});
  await clock.advance(0);
  wake();
  await clock.advance(0);
  assert.equal(reads, 1, 'a wake with an answer younger than its minute reads nothing');
  skew += 60_000;
  wake();
  await clock.advance(0);
  assert.equal(reads, 2, 'a minute old: one request shared by both consumers');
  wake();
  await clock.advance(0);
  assert.equal(reads, 2, 'and not again at once');
  reader.update((value) => ({ ...value, body: 99 }));
  assert.equal(reader.get('wallet').body, 99);
  assert.equal(reads, 2, 'public position evidence is projected locally');
  a(); b();
  assert.equal(wakesRemoved, 1, 'listeners leave no global wake handler behind');
});

// Added 2026-10-14 (incident 2026-10-13, design 2.5, package Q1): the page's one wake rule (src/lib/wake.ts) on the lists'
// reader, with a window and a document of the test's own.
test('the keyed reader on the page’s wake: focus asks nothing; back in view or online only past its period; one read, not two; rounds 10 s apart; a failure keeps its wait', async () => {
  const clock = fakeTimers();
  const win = new EventTarget();
  const doc = new EventTarget();
  let hidden = false;
  Object.defineProperty(doc, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible') });
  const wake = createWake(browserWakeSource(win, doc, () => clock.timers.now()));
  clock.timers.onWake = (run) => wake.onWake(run);
  // As in a browser: the page's state flips first, then every listener runs in the order it was added (the wake's first,
  // as it was added at the first subscription, then the timers' waiting for the page to be shown).
  clock.timers.visible = () => !hidden;
  const view = async (visible) => {
    hidden = !visible;
    doc.dispatchEvent(new Event('visibilitychange'));
    await clock.show(visible);
  };
  const event = async (type) => {
    win.dispatchEvent(new Event(type));
    await clock.advance(0);
  };
  let reads = 0;
  const reader = read.createKeyedReader(async () => ({ kind: 'ok', body: ++reads }), { next: read.readAgainAfter, failed: (reply) => reply.kind !== 'ok' }, clock.timers);
  const stop = reader.subscribe('wallet', () => {});
  await clock.advance(0);
  assert.equal(reads, 1);
  for (let i = 0; i < 20; i++) await event('focus');
  assert.equal(reads, 1, 'twenty focus events: nothing (a wallet popup closing fires one)');
  await clock.advance(1_000);
  await view(false);
  await clock.advance(5_000);
  await view(true);
  assert.equal(reads, 1, 'hidden 5 s, then visible: nothing');
  await clock.advance(24_000);
  await event('online');
  assert.equal(reads, 1, 'online 30 s after a good answer: nothing');
  await view(false);
  await clock.advance(90_000);
  assert.equal(reads, 1, 'nothing while hidden');
  await view(true);
  assert.equal(reads, 2, 'hidden 90 s, then visible: one read (its own minute ran out while hidden), not one for the wake and one for the timer');
  assert.deepEqual(reader.get('wallet'), { kind: 'ok', body: 2 }, 'and that read’s answer is the one kept');
  stop();

  // A reader with no period of its own (a test build's): the wake alone refreshes it, at most once a round.
  let plain = 0;
  const once = read.createKeyedReader(async () => ({ kind: 'ok', body: ++plain }), { next: () => null, failed: () => false }, clock.timers);
  const off = once.subscribe('w', () => {});
  await clock.advance(0);
  await clock.advance(10_000);
  await event('online');
  assert.equal(plain, 2, 'a round');
  await clock.advance(5_000);
  await event('online');
  assert.equal(plain, 2, 'another wake 5 s later is the same round');
  await clock.advance(5_000);
  await event('online');
  assert.equal(plain, 3, '10 s later, a new round');
  off();

  // A failure keeps its wait: a busy reader's Retry-After is not cut short by a wake.
  const replies = [{ kind: 'unavailable', reason: 'read_capacity_busy', retryAfterSeconds: 30 }, { kind: 'ok', body: 1 }];
  let asked = 0;
  const busy = read.createKeyedReader(async () => (asked++, replies.shift()), { next: read.readAgainAfter, failed: (reply) => reply.kind !== 'ok' }, clock.timers);
  const leave = busy.subscribe('w', () => {});
  await clock.advance(0);
  await clock.advance(10_000);
  await event('online');
  assert.equal(asked, 1, 'within its 30 s: nothing');
  await clock.advance(20_000);
  assert.equal(asked, 2, 'its own retry, on time');
  leave();
});

test('follow-up reads remain valid only for the observed visible owner and current generation', async () => {
  const clock = fakeTimers(), contexts = [];
  const reader = read.createKeyedReader(async (key, active) => { contexts.push({ key, active }); return { kind: 'ok' }; }, { next: () => null, failed: () => false }, clock.timers);
  const stop = reader.subscribe('owner-a', () => {});
  await clock.advance(0);
  assert.equal(contexts[0].active(), true);
  await clock.show(false); assert.equal(contexts[0].active(), false);
  await clock.show(true); assert.equal(contexts[0].active(), true);
  reader.again('owner-a'); await clock.advance(0);
  assert.equal(contexts[0].active(), false, 'the older generation cannot launch recovery after a newer read starts');
  assert.equal(contexts[1].active(), true);
  stop();
  const remounted = reader.subscribe('owner-a', () => {});
  assert.equal(contexts[1].active(), false, 'a remount cannot revive abandoned follow-up work');
  remounted(); reader.subscribe('owner-b', () => {}); await clock.advance(0);
  assert.equal(contexts[1].active(), false, 'changing owner cancels follow-up work for the former owner');
  assert.equal(contexts[2].active(), true);
});
