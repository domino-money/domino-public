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
