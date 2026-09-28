/**
 * Your APR on the Your positions table (src/components/positions/listApr.ts, round 6, 2026-09-27: the owner asked for
 * each position's APR on the list). The figure is the page's own (lib/positionApr.ts on the same fees history), shown at
 * once when the fees store already holds that history, and the others are measured lazily: one position at a time, only
 * the rows on the screen, only while the tab is visible, each let go as soon as it can be drawn, cannot be, or at its
 * cap, with a rest after a refusal and nothing asked twice for a pool whose history is too much. These drive the queue
 * with a fake fees store and a fake clock, and (2026-09-28, review) with the real fees store and a hand-answered worker.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { loadCase } from './support/fees/relay-fixture.mjs';

const require = createRequire(import.meta.url);
const { AGAIN_MS, CAP_MS, GAP_MS, REST_MS, SETTLE_MS, aprOfView, createAprQueue, rowAprs } = require('../.test-build/app/src/components/positions/listApr.js');
const { APR_MISSING, aprText, positionApr } = require('../.test-build/app/src/lib/positionApr.js');
const { LANE_PACE } = require('../.test-build/app/src/lib/chain/browser.js');
const { BUDGET_MS } = require('../.test-build/app/src/lib/fees/constants.js');
const { RELEASE_MS, createFeesStore } = require('../.test-build/app/src/lib/fees/store.js');

const HOUR = 3_600;
const T0 = 1_790_000_000;
const Q96 = 2n ** 96n;
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

/** A position's state (USDG its second side, 6 decimals both, price 1) and a history of `hours` hours earning 1 USDG an hour. */
function drawn(phase, hours = 48) {
  const state = { block: 100, timestamp: T0 + hours * HOUR, unclaimed: [0n, 0n], sqrtPriceX96: Q96, tick: 0, tickLower: -600, tickUpper: 600, liquidity: 10n ** 12n, poolId: `0x${'aa'.repeat(32)}`, owner: '0x1', currencies: [{ address: '0xa', symbol: 'A', decimals: 6 }, { address: USDG, symbol: 'USDG', decimals: 6 }] };
  const hourly = Array.from({ length: hours }, (_, i) => ({ anchor: i, t: T0 + (i + 1) * HOUR, earned: [0n, BigInt((i + 1) * 1e6)], collected: [0n, 0n], inRangeSeconds: HOUR, sqrtPriceX96Close: Q96, tickClose: 0 }));
  const history = { mintedAt: { block: 1, timestamp: T0 }, earned: [0n, BigInt(hours * 1e6)], collected: [0n, 0n], timeInRange: { inSeconds: hours * HOUR, totalSeconds: hours * HOUR }, hourly, events: [{ kind: 'mint', block: 1, timestamp: T0, tx: '0x1', fees: [0n, 0n], liquidityDelta: 10n ** 12n }], checks: {} };
  return { phase, state, history, prices: { hours: [] } };
}

test('the list’s APR is the page’s own: the same history, the same arithmetic, the same words', () => {
  const view = drawn('verified');
  const expected = positionApr(view.history, view.state, 1, 'all');
  assert.equal(expected.ok, true);
  assert.deepEqual(aprOfView(view), { kind: 'rate', text: aprText(expected.rate), estimated: false });
  assert.equal(aprOfView(view), aprOfView(view), 'worked out once per history');
  assert.deepEqual(aprOfView(drawn('estimated')), { kind: 'rate', text: aprText(expected.rate), estimated: true }, 'a busy pool’s estimate says so');
  // Under six hours: no rate, and the page's own reason.
  assert.deepEqual(aprOfView(drawn('verified', 3)), { kind: 'missing', words: APR_MISSING.short });
  for (const phase of ['idle', 'loading', 'unclaimed-only', 'unavailable']) assert.equal(aprOfView({ phase, state: null, reason: 'rpc_unavailable' }), null);
});

test('the queue’s bounds sit inside the fees store’s and the lane’s own', () => {
  // A position let go at its cap is stopped by the store RELEASE_MS later, before the page's own time is up, so no run
  // stops at its budget with a place kept for a later one (which would hold a page opened later back a minute).
  assert.ok(CAP_MS + RELEASE_MS + 2_000 < BUDGET_MS.page, `${CAP_MS} + ${RELEASE_MS} against ${BUDGET_MS.page}`);
  // 2026-09-28 (review): the cap is the page's own time less the store's stop and a margin (it was 14 s, which let the
  // owner's own 3325113 go for good when the RPC answered in 400 ms a call, while its page drew it in 19.6 s).
  assert.ok(CAP_MS >= BUDGET_MS.page - RELEASE_MS - 3_000, `${CAP_MS}`);
  // A run still on its way when its position is let go is stopped by the store before the next position starts.
  assert.ok(SETTLE_MS > RELEASE_MS, `${SETTLE_MS} against ${RELEASE_MS}`);
  assert.equal(REST_MS, LANE_PACE.restMs, 'after a refusal, the lane’s own rest');
  assert.ok(GAP_MS >= 1_000 && AGAIN_MS >= 60_000);
});

/** A fake clock whose timers run in order as the test moves it on. */
function fakeClock() {
  let now = 0;
  const timers = [];
  return {
    now: () => now,
    timer: (ms, run) => {
      const timer = { at: now + ms, run, live: true };
      timers.push(timer);
      return () => (timer.live = false);
    },
    /** Moves the clock on by `ms`, running every timer due on the way, in order. */
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.live && t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        due.live = false;
        due.run();
      }
      now = end;
    },
  };
}

/** A fake fees store (the view, subscribeHistory and refresh the queue uses), clock and tab for the queue. */
function harness() {
  const clock = fakeClock();
  const views = new Map();
  const listeners = new Map();
  const held = [];
  const released = [];
  const refreshed = [];
  const h = {
    visible: true,
    held,
    released,
    refreshed,
    now: clock.now,
    tick: clock.tick,
    deps: {
      store: {
        view: (id) => views.get(id) ?? { phase: 'idle' },
        subscribeHistory: ([id], scope, listener) => {
          assert.equal(scope, 'page', 'the page’s own scope: the run its page would start');
          if (!listeners.has(id)) listeners.set(id, new Set());
          listeners.get(id).add(listener);
          held.push(id);
          h.onHold?.(id);
          return () => {
            listeners.get(id).delete(listener);
            released.push(id);
          };
        },
        refresh: (ids) => refreshed.push(...ids),
      },
      timer: clock.timer,
      visible: () => h.visible,
      now: clock.now,
    },
    set(id, view) {
      views.set(id, view);
      for (const listener of [...(listeners.get(id) ?? [])]) listener();
    },
  };
  return h;
}

const rows = (...ids) => ids.map((id) => ({ id, pool: id.startsWith('p') ? 'busy-pool' : `pool-${id}` }));
const quiet = (reason) => ({ phase: 'unclaimed-only', state: {}, reason, prices: null });

// 2026-09-28 (review): after a busy pool's estimate the next position waits SETTLE_MS, no longer GAP_MS: the estimate's
// exact read goes on until the store stops it RELEASE_MS after the let-go, and two runs never share the worker.
test('one position at a time, in the list’s order, each let go as soon as its history can be drawn', () => {
  const h = harness();
  const queue = createAprQueue(h.deps);
  queue.want(rows('1', '2', '3'));
  assert.deepEqual(h.held, ['1'], 'only the first');
  assert.equal(queue.pending('2', 'pool-2'), true, 'the others wait calmly for their turn');
  h.set('1', { phase: 'loading', state: null });
  h.tick(5_000);
  assert.deepEqual(h.held, ['1'], 'nothing else while it is measured');
  h.set('1', drawn('verified'));
  assert.deepEqual(h.released, ['1'], 'let go at once');
  assert.equal(queue.pending('1', 'pool-1'), false);
  h.tick(GAP_MS - 1);
  assert.deepEqual(h.held, ['1'], 'a pause between two');
  h.tick(1);
  assert.deepEqual(h.held, ['1', '2']);
  // A busy pool's estimate is the page's own first figure: drawn, let go (the store stops its exact read).
  h.set('2', drawn('estimated'));
  assert.deepEqual(h.released, ['1', '2']);
  h.tick(SETTLE_MS - 1);
  assert.deepEqual(h.held, ['1', '2'], 'not while the estimate’s exact read may still run');
  h.tick(1);
  assert.deepEqual(h.held, ['1', '2', '3']);
  h.set('3', { phase: 'unavailable', reason: 'not_found' });
  h.tick(60_000);
  assert.deepEqual(h.held, ['1', '2', '3'], 'each asked once');
  assert.equal(queue.pending('3', 'pool-3'), false, 'one that could not be drawn is a dash');
});

test('a history the fees store already holds (its page was opened) is shown with nothing asked', () => {
  const h = harness();
  h.set('1', drawn('verified'));
  h.set('2', drawn('estimated'));
  const queue = createAprQueue(h.deps);
  queue.want(rows('1', '2', '3'));
  assert.deepEqual(h.held, ['3']);
  const aprs = rowAprs(rows('1', '2', '3'), new Map([['1', drawn('verified')], ['2', drawn('estimated')], ['3', { phase: 'idle' }]]), queue);
  assert.equal(aprs.get('1').kind, 'rate');
  assert.equal(aprs.get('2').estimated, true);
  assert.deepEqual(aprs.get('3'), { kind: 'waiting' });
  assert.deepEqual(rowAprs(rows('3'), new Map(), null).get('3'), { kind: 'none' }, 'no queue (a test build that did not ask): a dash');
});

// Changed on purpose (2026-09-28, review: at 400 ms a call the list let the owner's own 3325113 go for good at its 14 s
// cap, while its page drew it in 19.6 s): the cap is the page's own time less the store's stop, the next position waits
// until the capped run is stopped, and a capped position gets one more try once the rows never asked are done and the
// lane has rested. Its cell keeps its calm pulse between the two tries, never a dash first.
test('a position that takes too long is let go at its cap, the next waits for its run to stop, and it gets one more try after the others', () => {
  const h = harness();
  const queue = createAprQueue(h.deps);
  queue.want(rows('1', '2', '3'));
  h.set('1', { phase: 'loading', state: {} });
  h.tick(CAP_MS - 1);
  assert.deepEqual(h.released, []);
  h.tick(1);
  assert.deepEqual(h.released, ['1']);
  const capped = h.now();
  assert.equal(queue.pending('1', 'pool-1'), true, 'a second try is to come: the calm pulse stays');
  h.tick(SETTLE_MS - 1);
  assert.deepEqual(h.held, ['1'], 'not while its run may still be on its way');
  // The store stopped it (RELEASE_MS after the let-go).
  h.set('1', { phase: 'idle' });
  h.tick(1);
  assert.deepEqual(h.held, ['1', '2']);
  h.set('2', drawn('verified'));
  h.tick(GAP_MS);
  assert.deepEqual(h.held, ['1', '2', '3'], 'the rows never asked go first');
  h.set('3', drawn('verified'));
  h.tick(capped + REST_MS - 1 - h.now());
  assert.deepEqual(h.held, ['1', '2', '3'], 'the lane rests first');
  h.tick(1);
  assert.deepEqual(h.held, ['1', '2', '3', '1'], 'one more try');
  assert.deepEqual(h.refreshed, [], 'its state was read: only its history is asked again');
  h.set('1', { phase: 'loading', state: {} });
  h.tick(CAP_MS);
  assert.deepEqual(h.released, ['1', '2', '3', '1']);
  assert.equal(queue.pending('1', 'pool-1'), false, 'a dash once both tries are over');
  h.set('1', { phase: 'idle' });
  h.tick(10 * 60_000);
  assert.deepEqual(h.held, ['1', '2', '3', '1'], 'never a third time');
});

// Changed on purpose (2026-09-28, review): a refused position's cell keeps its calm pulse until its second try is over,
// never a dash in between (the cell went from a dash back to a pulse a minute later).
test('a refusal: nothing asked for the lane’s rest, and the refused position once more a minute later at the earliest', () => {
  const h = harness();
  const queue = createAprQueue(h.deps);
  queue.want(rows('1', '2'));
  h.set('1', { phase: 'loading', state: {} });
  h.set('1', quiet('rpc_unavailable'));
  assert.deepEqual(h.released, ['1']);
  h.tick(REST_MS - 1);
  assert.deepEqual(h.held, ['1'], 'the lane rests: nothing is asked');
  assert.equal(queue.pending('1', 'pool-1'), true, 'its second try is to come: a calm pulse meanwhile');
  h.tick(1);
  assert.deepEqual(h.held, ['1', '2']);
  h.set('2', drawn('verified'));
  h.tick(AGAIN_MS - REST_MS - 1);
  assert.deepEqual(h.held, ['1', '2']);
  h.tick(1);
  assert.deepEqual(h.held, ['1', '2', '1'], 'asked once more');
  assert.deepEqual(h.refreshed, [], 'its state was read (its history run was refused): the store asks the run again itself');
  // Its old quiet answer is not this run's: the queue waits for the new one.
  assert.deepEqual(h.released, ['1', '2']);
  h.set('1', quiet('rpc_unavailable'));
  assert.equal(queue.pending('1', 'pool-1'), false, 'a dash once both tries are over');
  h.tick(10 * 60_000);
  assert.deepEqual(h.held, ['1', '2', '1'], 'and never a third time');
});

test('a pool whose history is too much even for a page is not asked again for its other positions', () => {
  const h = harness();
  const queue = createAprQueue(h.deps);
  queue.want(rows('p1', 'p2', '3'));
  h.set('p1', quiet('too_much_history'));
  h.tick(GAP_MS);
  assert.deepEqual(h.held, ['p1', '3'], 'p2 shares p1’s pool');
  assert.equal(queue.pending('p2', 'busy-pool'), false);
});

// 2026-09-28 (review): a row that leaves mid-way leaves its run to the store's stop: the next waits SETTLE_MS.
test('only rows on the screen, only while the tab is visible: one that leaves is let go and asked again when back', () => {
  const h = harness();
  const queue = createAprQueue(h.deps);
  h.visible = false;
  queue.want(rows('1', '2'));
  assert.deepEqual(h.held, [], 'a hidden tab asks nothing');
  h.visible = true;
  queue.wake();
  assert.deepEqual(h.held, ['1']);
  h.visible = false;
  queue.wake();
  assert.deepEqual(h.released, ['1'], 'hidden: let go');
  h.tick(60_000);
  assert.deepEqual(h.held, ['1']);
  h.visible = true;
  queue.wake();
  assert.deepEqual(h.held, ['1', '1'], 'shown again: the same position, since it had no answer');
  // Scrolled away: let go, and the next on the screen is measured once the store has stopped the run left behind.
  queue.want(rows('2'));
  assert.deepEqual(h.released, ['1', '1']);
  h.tick(SETTLE_MS - 1);
  assert.deepEqual(h.held, ['1', '1']);
  h.tick(1);
  assert.deepEqual(h.held, ['1', '1', '2']);
  // The list is left: everything let go.
  queue.want([]);
  assert.deepEqual(h.released, ['1', '1', '2']);
  h.tick(60_000);
  assert.equal(h.held.length, 3);
});

test('a store that answers while it is being asked (it knew the position could not be read) is let go at once', () => {
  const h = harness();
  h.onHold = (id) => h.set(id, { phase: 'unavailable', reason: 'not_found' });
  const queue = createAprQueue(h.deps);
  let told = 0;
  queue.subscribe(() => (told += 1));
  const before = queue.version();
  queue.want(rows('1'));
  assert.deepEqual([h.held, h.released], [['1'], ['1']]);
  assert.ok(told > 0 && queue.version() > before, 'the cells are told');
  assert.equal(queue.pending('1', 'pool-1'), false);
});

// The list reads itself again every 30 s (OwnedPositions.tsx REFRESH): each read hands the queue the same rows again,
// in the same order. That never starts a position twice, never lets one go mid-way, and never asks one already drawn.
test('the list’s 30 s refresh (the same rows handed again) neither restarts, repeats nor lets go a measurement', () => {
  const h = harness();
  const queue = createAprQueue(h.deps);
  queue.want(rows('1', '2'));
  h.set('1', { phase: 'loading', state: {} });
  for (let i = 0; i < 3; i += 1) queue.want(rows('1', '2'));
  assert.deepEqual([h.held, h.released], [['1'], []], 'the one on its way stays held, once');
  h.set('1', drawn('verified'));
  queue.want(rows('1', '2'));
  assert.deepEqual(h.held, ['1'], 'a refresh right after one is drawn keeps the pause between two');
  h.tick(GAP_MS);
  assert.deepEqual(h.held, ['1', '2']);
  h.set('2', drawn('verified'));
  for (let i = 0; i < 3; i += 1) {
    queue.want(rows('1', '2'));
    h.tick(30_000);
  }
  assert.deepEqual(h.held, ['1', '2'], 'nothing drawn is asked again');
  // A refresh keeps the store's views (the same objects): each cell is the very same answer, so nothing is redrawn.
  const views = new Map([['1', drawn('verified')], ['2', drawn('verified')]]);
  const before = rowAprs(rows('1', '2'), views, queue);
  const after = rowAprs(rows('1', '2'), views, queue);
  assert.deepEqual([before.get('1').kind, before.get('2').kind], ['rate', 'rate']);
  assert.ok(before.get('1') === after.get('1') && before.get('2') === after.get('2'));
});

// --- 2026-09-28 (review): the queue on the REAL fees store (lib/fees/store.ts), with a worker the test answers by hand
// and /state reads it answers from a recorded case, on the queue's own fake clock. A fake store could not show that a
// /state refusal stays the store's answer (the retry asked nothing), nor when the store really stops a run.

const flush = () => new Promise((done) => setImmediate(done));

/** The real store; `refusals`: how many /state reads the RPC refuses first. `timeline`: runs, cancels and dones, in order. */
function realStore(h, { refusals = 0 } = {}) {
  const timeline = [];
  const asked = [];
  let worker = null;
  const { state } = loadCase('3136705');
  const store = createFeesStore({
    spawn: () => (worker = { postMessage: (message) => timeline.push(`${message.type} ${message.id}`), terminate() {}, onmessage: null, onerror: null, onmessageerror: null }),
    postState: async (ids) => {
      asked.push(ids.join());
      if (refusals > 0) {
        refusals -= 1;
        return { ok: false, failure: 'unavailable', retryAfterMs: 0 };
      }
      return { ok: true, bytes: 1, value: { ...state, positions: ids.map((tokenId) => ({ ...state.positions[0], tokenId })) } };
    },
    later: h.deps.timer,
    timer: h.deps.timer,
  });
  const send = (data) => {
    if (data.type === 'done') timeline.push(`done ${data.id}`);
    worker.onmessage({ data });
  };
  const done = (id) => send({ type: 'done', id, result: { ok: true, history: drawn('verified').history, prices: { hours: [] }, checkpoint: null, bytes: 1 }, wait: 0 });
  return { store, timeline, asked, send, done };
}

/** Moves the fake clock on by `ms` in small steps, letting the store's promises settle at each. */
async function pass(h, ms) {
  for (let left = ms; left > 0; left -= 250) {
    h.tick(Math.min(250, left));
    await flush();
  }
}

test('a /state read the RPC refused is asked again on the second try, and the position is then measured (the real fees store)', async () => {
  const h = harness();
  const real = realStore(h, { refusals: 1 });
  const queue = createAprQueue({ ...h.deps, store: real.store });
  queue.want(rows('1'));
  await flush();
  assert.deepEqual(real.asked, ['1']);
  assert.deepEqual(real.store.view('1'), { phase: 'unavailable', reason: 'rpc_unavailable' });
  assert.equal(queue.pending('1', 'pool-1'), true, 'a second try is to come');
  await pass(h, AGAIN_MS - 250);
  assert.deepEqual(real.asked, ['1'], 'nothing asked before its minute');
  await pass(h, 250);
  assert.deepEqual(real.asked, ['1', '1'], 'its /state asked again');
  assert.equal(real.store.view('1').phase, 'loading');
  assert.deepEqual(real.timeline, ['run 1'], 'then its history');
  real.done('1');
  assert.equal(real.store.view('1').phase, 'verified');
  assert.equal(queue.pending('1', 'pool-1'), false);
});

test('a position whose view is already a refused /state read (from its page, earlier in the visit) is asked, its /state first', async () => {
  const h = harness();
  const real = realStore(h, { refusals: 1 });
  // Its page was opened and left: the RPC refused its /state read there.
  const page = real.store.subscribeHistory(['1'], 'page', () => {});
  await flush();
  page();
  await pass(h, 10_000);
  assert.deepEqual(real.store.view('1'), { phase: 'unavailable', reason: 'rpc_unavailable' });
  const queue = createAprQueue({ ...h.deps, store: real.store });
  queue.want(rows('1'));
  assert.equal(queue.pending('1', 'pool-1'), true, 'waits calmly: it will be asked');
  await flush();
  assert.deepEqual(real.asked, ['1', '1']);
  assert.deepEqual(real.timeline, ['run 1']);
  real.done('1');
  assert.equal(real.store.view('1').phase, 'verified');
});

test('never two runs at once: the next position goes to the worker only once the store stopped the one let go; a capped one is tried once more (the real fees store)', async () => {
  const h = harness();
  const real = realStore(h);
  const queue = createAprQueue({ ...h.deps, store: real.store });
  queue.want(rows('1', '2', '3'));
  await flush();
  assert.deepEqual(real.timeline, ['run 1']);
  // A busy pool's estimate: drawn and let go, while its exact read goes on until the store stops it.
  real.send({ type: 'estimate', id: '1', history: drawn('estimated').history, prices: { hours: [] } });
  assert.equal(real.store.view('1').phase, 'estimated');
  assert.equal(queue.pending('1', 'pool-1'), false);
  await pass(h, SETTLE_MS);
  assert.deepEqual(real.timeline, ['run 1', 'cancel 1', 'run 2']);
  // The next never answers: let go at its cap, and the third starts once the store stopped it.
  await pass(h, CAP_MS + SETTLE_MS);
  assert.deepEqual(real.timeline, ['run 1', 'cancel 1', 'run 2', 'cancel 2', 'run 3']);
  assert.equal(queue.pending('2', 'pool-2'), true, 'the capped one waits calmly for its second try');
  real.done('3');
  // Its second try, after the lane's rest.
  await pass(h, REST_MS);
  assert.deepEqual(real.timeline.slice(5), ['done 3', 'run 2']);
  real.done('2');
  assert.equal(real.store.view('2').phase, 'verified');
  // At every run sent, no other was on its way.
  const live = new Set();
  for (const entry of real.timeline) {
    const [type, id] = entry.split(' ');
    if (type === 'run') {
      assert.equal(live.size, 0, `${entry} while ${[...live].join()} ran`);
      live.add(id);
    } else live.delete(id);
  }
  await pass(h, 10 * 60_000);
  assert.equal(real.timeline.filter((entry) => entry.startsWith('run')).length, 4, 'nothing more');
});
