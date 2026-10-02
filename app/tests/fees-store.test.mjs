/**
 * The fees store behind useFeeHistory / useFeeHistories / useFeeStates (src/lib/fees/store.ts; DESIGN-V2 §15.4–§15.6):
 * the views a screen sees, one /state read and one ledger read shared by every screen showing an id, the list's ledgers
 * alone, a newer state that shows a settlement the ledger does not hold (asked again, fresh), a ledger still being read,
 * the calm retries, this browser's readings, a saved copy, and the client's two routes (client.ts).
 *
 * Changed on purpose 2026-10-02 (RPC-SPEC §11.4, rugged97's rule 2): there is no replay worker any more; a history is the
 * position's own ledger (functions/_lib/feesLedger.ts) folded with its state (lib/fees/ledger.ts). The answers here are
 * the routes' own, read once from a fake chain at the edge (tests/support/fees/ledger-world.mjs), then served by fakes.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { edgeFetch } from './support/edge-routes.mjs';
import { RPC_URL } from './support/browser-chain.mjs';
import { withEdge } from './support/fees/edge.mjs';
import { ledgerWorld } from './support/fees/ledger-world.mjs';
import { feesDefault } from './support/fees/stub.mjs';

const require = createRequire(import.meta.url);
const { AFTER_ACTION_MS, LEDGER_WAIT_MS, MAX_READING, RELEASE_MS, RETRY_MS, createFeesStore } = require('../.test-build/app/src/lib/fees/store.js');
const { LEDGER_READING_MS, STATE_REFRESH_MS } = require('../.test-build/app/src/lib/fees/constants.js');
const { createHistoryCache } = require('../.test-build/app/src/lib/fees/historyCache.js');
const { createReadings } = require('../.test-build/app/src/lib/fees/readings.js');
const routes = require('../.test-build/app/functions/_lib/chainRoutes.js');

const ID = '3325113';
const settle = () => new Promise((done) => setTimeout(done, 0));
async function until(check, what) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await settle();
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** The routes' own answers for one world (its /state and its ledger), read once at the edge. */
async function answersOf(options = {}) {
  routes.resetChainRouteMemory();
  const { chain } = ledgerWorld(options);
  const fetch = edgeFetch({ fetch: (_url, init) => chain.fetch(RPC_URL, init), now: () => 1_000_000, sleep: async () => {} });
  const post = async (path, body) => (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  return { state: await post('/api/fees/v1/state', { tokenIds: [ID], automation: true }), ledger: await post('/api/fees/v2/ledger', { tokenIds: [ID] }), chain };
}
const ANSWERS = await answersOf();

/** A /state answer `blocks` later, its position changed by `patch`. */
const laterState = (answer, blocks, patch = {}) => ({ ...answer, block: answer.block + blocks, timestamp: answer.timestamp + Math.round(blocks / 10), positions: answer.positions.map((position) => ({ ...position, ...patch })) });

/** The two reads, served from `answers`; `down`, `ledgerDown` and `scripted` (answers given first) change them. */
function service(answers = ANSWERS) {
  const s = {
    state: answers.state,
    ledger: answers.ledger,
    asked: [],
    ledgers: [],
    down: false,
    scripted: [],
    async postState(ids) {
      s.asked.push([...ids]);
      if (s.down) return { ok: false, failure: 'unavailable', retryAfterMs: 0 };
      return { ok: true, value: { ...s.state, positions: ids.map((id) => s.state.positions.find((one) => one.tokenId === id) ?? { tokenId: id, ok: false, reason: 'not_found' }) }, bytes: 100 };
    },
    async postLedger(ids, fresh) {
      s.ledgers.push({ ids: [...ids], fresh });
      const scripted = s.scripted.shift();
      if (scripted) return scripted;
      return { ok: true, value: { ...s.ledger, positions: ids.map((id) => s.ledger.positions.find((one) => one.tokenId === id) ?? { tokenId: id, ok: false, reason: 'not_found' }) }, bytes: 100 };
    },
  };
  return s;
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

/** A memory storage for the browser's copies. */
function memoryStorage() {
  const items = new Map();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, String(value)), removeItem: (key) => void items.delete(key), items };
}

function storeWith({ svc = service(), storage = null, now = () => ANSWERS.state.timestamp * 1000, pastReadings } = {}) {
  const time = clock();
  const readings = storage ? createReadings(() => storage) : null;
  const store = createFeesStore({
    postState: (ids) => svc.postState(ids),
    postLedger: (ids, fresh, signal) => svc.postLedger(ids, fresh, signal),
    later: time.later,
    timer: time.timer,
    now,
    ...(storage ? { historyCache: createHistoryCache(() => storage, now), readings } : {}),
    ...(pastReadings ? { pastReadings } : {}),
  });
  return { store, svc, time, readings };
}

test('one position: loading with its on-chain state, then verified from its ledger; one /state read and one ledger read', async () => {
  const { store, svc } = storeWith();
  const seen = [];
  const stop = store.subscribeHistory([ID], 'page', () => seen.push(store.view(ID).phase));
  assert.equal(store.view(ID).phase, 'idle');
  await until(() => store.view(ID).phase === 'verified', 'verified');
  const view = store.view(ID);
  assert.deepEqual(svc.asked, [[ID]]);
  assert.deepEqual(svc.ledgers, [{ ids: [ID], fresh: false }]);
  assert.deepEqual(view.history.earned, [22_523_160n, 6_935_401_632_110_906_894_871n], 'collected + ready to collect, exact');
  assert.deepEqual(view.history.collected, [22_429_360n, 3_267_262_595_399_790_062_762n]);
  assert.deepEqual(view.state.unclaimed, [93_800n, 3_668_139_036_711_116_832_109n]);
  assert.ok(seen.includes('loading') || seen.includes('verified'));
  stop();
});

test('screens showing one id share one /state read and one ledger read; useFeeStates’ answer comes from the same read', async () => {
  const { store, svc } = storeWith();
  const a = store.subscribeHistory([ID], 'page', () => {});
  const b = store.subscribeHistory([ID], 'page', () => {});
  const c = store.subscribeStates([ID, '42'], () => {});
  await until(() => store.view(ID).phase === 'verified', 'verified');
  assert.equal(svc.ledgers.length, 1);
  assert.equal(svc.asked.length, 1);
  assert.deepEqual(svc.asked[0].sort(), [ID, '42'].sort());
  const states = store.states([ID, '42']);
  assert.equal(states.get(ID).block, ANSWERS.state.block);
  assert.equal(states.get('42'), null, 'not found');
  a();
  b();
  c();
});

test('the list asks the ledgers alone, eight ids a request, and draws each row from its ledger’s own state; no /state read', async () => {
  const { store, svc } = storeWith();
  const ids = [ID, ...Array.from({ length: 9 }, (_, i) => String(100 + i))];
  const stop = store.subscribeHistory(ids, 'list', () => {});
  // 2026-10-02 (review of the rules, finding 11): each row is being read, with no state yet: its skeleton, not a dash.
  assert.deepEqual(store.view(ID), { phase: 'loading', state: null });
  await until(() => store.view(ID).phase === 'verified', 'the row’s history');
  assert.deepEqual(svc.asked, [], 'the list reads no /state');
  assert.deepEqual(svc.ledgers.map((one) => one.ids.length), [8, 2]);
  assert.equal(store.view(ID).state.block, ANSWERS.ledger.block, 'the ledger’s own state');
  assert.equal(store.view('100').phase, 'unavailable', 'an id the chain does not know');
  stop();
});

test('a list row whose ledger read fails goes from its skeleton to a calm dash, and is asked again', async () => {
  const { store, svc, time } = storeWith();
  svc.scripted.push({ ok: false, failure: 'unavailable', retryAfterMs: 0 });
  const stop = store.subscribeHistory([ID], 'list', () => {});
  assert.equal(store.view(ID).phase, 'loading');
  await until(() => store.view(ID).phase === 'unavailable', 'a calm dash');
  assert.equal(time.fire('later', RETRY_MS[0]), 1);
  await until(() => store.view(ID).phase === 'verified', 'verified');
  assert.equal(svc.ledgers.length, 2);
  stop();
});

test('a ledger that cannot measure the position: Fees ready to collect only, its settlements kept for Activity, not asked again', async () => {
  const answers = await answersOf({ vault: null, steps: [{ block: 73_400_000, kind: 'increase', delta: 10n ** 15n }] });
  const { store, svc, time } = storeWith({ svc: service(answers) });
  const stop = store.subscribeHistory([ID], 'page', () => {});
  await until(() => store.view(ID).phase === 'unclaimed-only', 'unclaimed-only');
  const view = store.view(ID);
  assert.equal(view.reason, 'not_exact');
  assert.equal(view.why, 'manual');
  assert.deepEqual(view.events.map((event) => [event.kind, event.fees]), [['mint', [0n, 0n]], ['increase', null]]);
  assert.equal(time.fire('later'), 1, 'only the minute’s state read is set');
  await settle();
  assert.equal(svc.ledgers.length, 1, 'nothing more of the ledger');
  stop();
});

test('a ledger read that fails shows the unclaimed figure calmly and is asked again after 2, 10, 30 s, never sooner than its wait; then verified', async () => {
  const { store, svc, time } = storeWith();
  svc.scripted.push({ ok: false, failure: 'unavailable', retryAfterMs: 0 }, { ok: false, failure: 'rate_limited', retryAfterMs: 15_000 });
  const stop = store.subscribeHistory([ID], 'page', () => {});
  await until(() => store.view(ID).phase === 'unclaimed-only', 'the calm card');
  assert.equal(store.view(ID).reason, 'rpc_unavailable');
  assert.equal(time.fire('later', RETRY_MS[0]), 1);
  await until(() => svc.ledgers.length === 2, 'the second ledger read');
  await settle();
  assert.equal(time.fire('later', 15_000), 1, 'the route’s Retry-After over the ladder’s 10 s');
  await until(() => store.view(ID).phase === 'verified', 'verified');
  assert.equal(svc.ledgers.length, 3);
  stop();
});

test('a ledger too large for one answer: Fees ready to collect only, for the visit; a position the chain does not know: unavailable', async () => {
  const { store, svc, time } = storeWith();
  svc.scripted.push({ ok: false, failure: 'too_large', retryAfterMs: 0 });
  const stop = store.subscribeHistory([ID], 'page', () => {});
  await until(() => store.view(ID).phase === 'unclaimed-only', 'unclaimed-only');
  assert.equal(store.view(ID).reason, 'not_exact');
  assert.equal(time.pending.filter((entry) => !entry.cancelled && entry.ms !== STATE_REFRESH_MS).length, 0, 'no retry');
  stop();
  const other = storeWith();
  const gone = other.store.subscribeHistory(['42'], 'page', () => {});
  await until(() => other.store.view('42').phase === 'unavailable', 'unavailable');
  assert.equal(other.store.view('42').reason, 'not_found');
  gone();
});

test('a ledger still being read: the card loads, the ledger is asked again in a moment, and verifies once read through', async () => {
  const { store, svc, time } = storeWith();
  const partial = { ...ANSWERS.ledger, positions: ANSWERS.ledger.positions.map((one) => ({ ...one, exact: false, why: 'reading', through: one.through - 1_000 })) };
  svc.scripted.push({ ok: true, value: partial, bytes: 10 });
  const stop = store.subscribeHistory([ID], 'page', () => {});
  await until(() => svc.ledgers.length === 1 && time.pending.some((entry) => !entry.cancelled && entry.ms === LEDGER_READING_MS), 'the next read set');
  assert.equal(store.view(ID).phase, 'loading');
  assert.equal(time.fire('later', LEDGER_READING_MS), 1);
  await until(() => store.view(ID).phase === 'verified', 'verified');
  assert.equal(svc.ledgers.length, 2);
  assert.ok(MAX_READING >= 10);
  stop();
});

test('a newer state that shows a settlement the ledger does not hold asks the ledger again, fresh, once; what is shown stays meanwhile', async () => {
  const { store, svc, time } = storeWith();
  const stop = store.subscribeHistory([ID], 'page', () => {});
  await until(() => store.view(ID).phase === 'verified', 'verified');
  const before = store.view(ID);
  // A minute later the owner collected: no unclaimed fees, and the fee growth settled to moved.
  const position = ANSWERS.state.positions[0];
  svc.state = laterState(ANSWERS.state, 600, { unclaimed0: '0', unclaimed1: '0', feeGrowthInside0LastX128: position.feeGrowthInside0X128, feeGrowthInside1LastX128: position.feeGrowthInside1X128 });
  svc.scripted.push(new Promise(() => {}));
  assert.equal(time.fire('later', STATE_REFRESH_MS), 1);
  await until(() => svc.ledgers.length === 2, 'the fresh ledger read');
  assert.deepEqual(svc.ledgers[1], { ids: [ID], fresh: true });
  assert.equal(store.view(ID), before, 'the verified card stays while the ledger is read');
  // The same state again (the next minute): no second fresh read for it.
  assert.equal(time.fire('later', STATE_REFRESH_MS), 1);
  await settle();
  assert.equal(svc.ledgers.length, 2);
  stop();
});

test('every minute while visible /state is read again; its new block moves the card’s figures on with no ledger read', async () => {
  const { store, svc, time } = storeWith();
  const stop = store.subscribeHistory([ID], 'page', () => {});
  await until(() => store.view(ID).phase === 'verified', 'verified');
  svc.state = laterState(ANSWERS.state, 600, { unclaimed0: '100000', unclaimed1: '4000000000000000000000' });
  assert.equal(time.fire('later', STATE_REFRESH_MS), 1);
  await until(() => store.view(ID).state.block === ANSWERS.state.block + 600, 'the newer block');
  const view = store.view(ID);
  assert.equal(view.phase, 'verified');
  assert.deepEqual(view.history.earned, [22_429_360n + 100_000n, 3_267_262_595_399_790_062_762n + 4_000_000_000_000_000_000_000n]);
  assert.equal(svc.ledgers.length, 1, 'nothing settled since: the ledger holds');
  assert.equal(view.history.points.at(-1).kind, 'now');
  assert.equal(view.history.points.at(-1).block, ANSWERS.state.block + 600);
  stop();
});

test('a position page keeps its state reads, at most hourly, as points of its chart; a saved copy is restored on a later visit as `cached`', async () => {
  const storage = memoryStorage();
  let nowMs = ANSWERS.state.timestamp * 1000;
  const { store, svc, time } = storeWith({ storage, now: () => nowMs });
  const stop = store.subscribeHistory([ID], 'page', () => {});
  await until(() => store.view(ID).phase === 'verified', 'verified');
  // Two hours later the page reads again: a reading at the first read, the chart's points measured around it.
  svc.state = laterState(ANSWERS.state, 72_000, { unclaimed0: '200000', unclaimed1: '5000000000000000000000' });
  nowMs += 7_200_000;
  assert.equal(time.fire('later', STATE_REFRESH_MS), 1);
  await until(() => store.view(ID).state.block === ANSWERS.state.block + 72_000, 'the later read');
  const kinds = store.view(ID).history.points.map((point) => point.kind);
  assert.deepEqual(kinds, ['opened', 'settlement', 'settlement', 'settlement', 'reading', 'now']);
  assert.deepEqual(store.view(ID).history.points[4].earned, [22_523_160n, 6_935_401_632_110_906_894_871n], 'the first read’s figure, exact then');
  stop();
  // Another visit: the saved copy at once, as a copy.
  const next = storeWith({ storage, svc: service(), now: () => nowMs });
  next.svc.scripted.push(new Promise(() => {}));
  next.svc.down = true;
  const again = next.store.subscribeHistory([ID], 'page', () => {});
  assert.equal(next.store.view(ID).phase, 'cached');
  assert.equal(next.store.view(ID).source, 'public-chain-ledger');
  again();
});

test('a page’s own /state read, offered to the store: its card starts from it, and the store’s newest read is the page’s to follow', async () => {
  const { store, svc } = storeWith();
  store.offer({ ok: true, value: ANSWERS.state, bytes: 100 });
  assert.deepEqual(store.position(ID), { position: ANSWERS.state.positions[0], block: ANSWERS.state.block });
  const stop = store.subscribeHistory([ID], 'page', () => {});
  await until(() => store.view(ID).phase === 'verified', 'verified');
  assert.deepEqual(svc.asked, [], 'the card read nothing: the page’s read was its');
  store.offer({ ok: false, failure: 'unavailable', retryAfterMs: 0 });
  assert.equal(store.position(ID).block, ANSWERS.state.block);
  assert.equal(store.position('1'), null);
  stop();
});

test('after the owner’s action its state is read at once and once more a moment later; leaving stops the retries a moment after the last screen', async () => {
  const { store, svc, time } = storeWith();
  const stop = store.subscribeHistory([ID], 'page', () => {});
  await until(() => store.view(ID).phase === 'verified', 'verified');
  store.refresh([ID]);
  await settle();
  assert.equal(svc.asked.length, 2);
  assert.equal(time.fire('timer', AFTER_ACTION_MS), 1);
  await settle();
  assert.equal(svc.asked.length, 3);
  svc.scripted.push({ ok: false, failure: 'unavailable', retryAfterMs: 0 });
  // A failing ledger read's retry, then the screen leaves: its retry goes a moment later.
  const position = ANSWERS.state.positions[0];
  svc.state = laterState(ANSWERS.state, 600, { feeGrowthInside0LastX128: position.feeGrowthInside0X128 });
  store.refresh([ID]);
  await until(() => svc.ledgers.length === 2, 'the fresh ledger read');
  await settle();
  const retry = time.pending.find((entry) => !entry.cancelled && entry.kind === 'later' && entry.ms === RETRY_MS[0]);
  assert.ok(retry, 'a retry set');
  stop();
  assert.equal(time.fire('timer', RELEASE_MS), 1);
  assert.equal(retry.cancelled, true);
});

test('state batches cancel only after their last consumer leaves; remount ignores the abandoned answer', async () => {
  const jobs = [];
  const time = clock();
  const store = createFeesStore({
    postLedger: async () => assert.fail('state only'), later: time.later, timer: time.timer,
    postState: (ids, signal) => new Promise((resolve) => jobs.push({ ids: [...ids], signal, resolve })),
  });
  const a = store.subscribeStates([ID], () => {});
  const b = store.subscribeStates([ID, '3135288'], () => {});
  await settle();
  assert.equal(jobs.length, 1);
  a();
  assert.equal(jobs[0].signal.aborted, false, 'another consumer still needs the batch');
  b();
  assert.equal(jobs[0].signal.aborted, true);
  const c = store.subscribeStates([ID], () => {});
  await settle();
  assert.equal(jobs.length, 2);
  jobs[0].resolve({ ok: false, failure: 'unavailable', retryAfterMs: 0 });
  await settle();
  const d = store.subscribeStates([ID], () => {});
  await settle();
  assert.equal(jobs.length, 2, 'the old answer did not clear the new in-flight marker');
  assert.equal(store.states([ID]), null, 'the abandoned answer is not applied');
  c();
  d();
  assert.equal(jobs[1].signal.aborted, true);
  jobs[1].resolve({ ok: false, failure: 'unavailable', retryAfterMs: 0 });
});

test('a state read queued by a subscription is not sent after that subscription leaves; an explicit refresh retains its read', async () => {
  let reads = 0;
  const time = clock();
  const quiet = createFeesStore({ postLedger: async () => assert.fail('state only'), postState: async () => { reads++; return { ok: false, failure: 'unavailable', retryAfterMs: 0 }; }, later: time.later, timer: time.timer });
  quiet.subscribeStates([ID], () => {})();
  await settle();
  assert.equal(reads, 0);
  const jobs = [];
  const store = createFeesStore({ postLedger: async () => assert.fail('state only'), later: time.later, timer: time.timer, postState: (ids, signal) => new Promise((resolve) => jobs.push({ ids: [...ids], signal, resolve })) });
  store.offer({ ok: true, value: ANSWERS.state, bytes: 100 });
  const stop = store.subscribeStates([ID], () => {});
  store.refresh([ID]);
  stop();
  await settle();
  assert.equal(jobs.length, 1, 'the explicit refresh was not withdrawn with its screen');
  assert.equal(jobs[0].signal.aborted, false);
  jobs[0].resolve({ ok: true, value: laterState(ANSWERS.state, 10), bytes: 100 });
  await settle();
  assert.equal(store.position(ID).block, ANSWERS.state.block + 10);
});

test('watch hears every change to the ids it names and asks nothing for them', async () => {
  const { store, svc } = storeWith();
  let heard = 0;
  const unwatch = store.watch([ID], () => heard++);
  await settle();
  assert.equal(svc.asked.length + svc.ledgers.length, 0);
  const stop = store.subscribeHistory([ID], 'page', () => {});
  await until(() => store.view(ID).phase === 'verified', 'verified');
  assert.ok(heard > 0);
  stop();
  unwatch();
});

// ---------------------------------------------------------------------------
// client.ts: the two routes
// ---------------------------------------------------------------------------

test('client.ts: no request in a build without the chain; the site’s own state and ledger routes, same origin, the routes’ answers checked; a failure is unavailable', async () => {
  const client = require('../.test-build/app/src/lib/fees/client.js');
  const { chain } = ledgerWorld();
  routes.resetChainRouteMemory();
  const deps = { fetch: (url, init) => chain.fetch(url, init), sleep: async () => {}, now: () => Date.now() };
  const UNAVAILABLE = { ok: false, failure: 'unavailable', retryAfterMs: 0 };
  try {
    globalThis.__DOMINO_DEPLOYABLE__ = false;
    globalThis.__DOMINO_TEST_HOOKS__ = false;
    const none = await withEdge(deps, async () => [await client.chainState(['1']), await client.chainLedger(['1'])]);
    assert.deepEqual(none.result, [UNAVAILABLE, UNAVAILABLE]);
    assert.equal(none.sent.length, 0, 'fixture and bridge-test builds ask nothing');
    globalThis.__DOMINO_DEPLOYABLE__ = true;
    const { result, sent } = await withEdge(deps, () => client.chainLedger([ID]));
    assert.equal(result.ok, true);
    assert.equal(result.value.positions[0].exact, true);
    assert.deepEqual(sent.map((one) => [one.path, one.body]), [['/api/fees/v2/ledger', { tokenIds: [ID] }]]);
    assert.deepEqual({ ...sent[0].init, body: undefined, signal: undefined }, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: undefined, signal: undefined, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    const fresh = await withEdge(deps, () => client.chainLedger([ID], true));
    assert.deepEqual(fresh.sent.map((one) => one.body), [{ tokenIds: [ID], fresh: true }]);
    // An answer that names another id than asked is not taken.
    const wrong = await withEdge(deps, () => client.chainLedger(['42']));
    assert.equal(wrong.result.ok, true, 'an unknown id is its own not_found');
    assert.deepEqual(wrong.result.value.positions, [{ tokenId: '42', ok: false, reason: 'not_found' }]);
    const broken = { fetch: async () => new Response('<!doctype html>', { status: 200 }) };
    routes.resetChainRouteMemory();
    assert.equal((await withEdge({ ...deps, fetch: (url, init) => broken.fetch(url, init) }, () => client.chainLedger([ID]))).result.failure, 'unavailable');
    const controller = new AbortController();
    controller.abort();
    const dropped = await withEdge(deps, () => client.chainLedger([ID], false, controller.signal));
    assert.equal(dropped.result.failure, 'unavailable');
    assert.equal(dropped.sent.length, 0, 'a dropped read makes no request');
  } finally {
    delete globalThis.__DOMINO_DEPLOYABLE__;
    delete globalThis.__DOMINO_TEST_HOOKS__;
  }
});

test('the test servers’ fees answers: every position not_found by default, on both routes; anything else is not theirs', async () => {
  const ask = async (path, body) => feesDefault(new Request(`http://test${path}`, { method: 'POST', body: JSON.stringify(body) }));
  const none = await ask('/api/fees/v1/state', { tokenIds: [ID, '42'] });
  assert.deepEqual((await none.json()).positions.map((one) => one.reason), ['not_found', 'not_found']);
  const ledger = await ask('/api/fees/v2/ledger', { tokenIds: [ID], fresh: true });
  assert.deepEqual((await ledger.json()).positions, [{ tokenId: ID, ok: false, reason: 'not_found' }]);
  assert.equal((await ask('/api/fees/v1/state', { tokenIds: [] })).status, 400);
  assert.equal(await feesDefault(new Request('http://test/api/fees/v1/logs', { method: 'POST', body: '{}' })), undefined, 'the logs route is gone');
});

// 2026-10-02 (the owner's preview: the ledger was asked once per page load, and a position's page then never asked it, its
// card and Your APR skeletons for the visit). A ledger the route answers `reading` (feesLedger.ts: past LEDGER_STEP's
// lookups, or past the question's byte budget) is asked again 2 s later only while a screen shows its id; when none does
// (the list left for another row's page, the page's chunk not in yet) the kept `reading` ledger must not count as the
// id's ledger: the next screen that shows it asks again.
const READING = { ...ANSWERS.ledger, positions: ANSWERS.ledger.positions.map((one) => ({ ...one, exact: false, why: 'reading', through: one.through - 1_000 })) };

test('a ledger still `reading` whose retry fired with no screen showing it is asked again by the next screen that shows it', async () => {
  const { store, svc, time } = storeWith();
  svc.scripted.push({ ok: true, value: READING, bytes: 10 });
  const list = store.subscribeHistory([ID], 'list', () => {});
  await until(() => svc.ledgers.length === 1 && time.pending.some((entry) => !entry.cancelled && entry.ms === LEDGER_READING_MS), 'the list’s reading retry');
  // The click into the position: the list leaves, and the 2 s retry fires before the page is mounted.
  list();
  assert.equal(time.fire('later', LEDGER_READING_MS), 1);
  assert.equal(svc.ledgers.length, 1, 'no screen shows it: nothing asked');
  const page = store.subscribeHistory([ID], 'page', () => {});
  store.offer(await svc.postState([ID]));
  await until(() => store.view(ID).phase === 'verified', 'verified');
  assert.equal(svc.ledgers.length, 2, 'asked again by the page');
  page();
});

test('a `reading` ledger that answers after the last screen left is asked again by the next screen that shows it', async () => {
  const { store, svc, time } = storeWith();
  let answer;
  const slow = new Promise((done) => (answer = done));
  const real = svc.postLedger;
  svc.postLedger = (ids, fresh) => (svc.ledgers.length === 0 ? (svc.ledgers.push({ ids: [...ids], fresh }), slow) : real(ids, fresh));
  const list = store.subscribeHistory([ID], 'list', () => {});
  await until(() => svc.ledgers.length === 1, 'the list’s ledger read on its way');
  list();
  answer({ ok: true, value: READING, bytes: 10 });
  await settle();
  time.fire('timer', RELEASE_MS);
  const page = store.subscribeHistory([ID], 'page', () => {});
  await until(() => store.view(ID).phase === 'verified', 'verified');
  assert.equal(svc.ledgers.length, 2, 'asked again by the page');
  page();
});

// 2026-10-02 (the chart's periods back, lib/fees/pastReads.ts): every ledger answer keeps its own state as one of this
// browser's readings (the list's too: a measured point at no cost), and the store folds a position's view again when a
// read at a past block was kept (`redraw`), with the reads too old to keep that the runner holds (`pastReadings`).
test('a ledger answer’s own state is kept as a reading, from the list too; redraw folds the view again with a past read; held reads are folded in', async () => {
  const storage = memoryStorage();
  const held = [];
  const { store, readings } = storeWith({ storage, pastReadings: () => held });
  const stop = store.subscribeHistory([ID], 'list', () => {});
  await until(() => store.view(ID).phase === 'verified', 'verified');
  assert.deepEqual(readings.get(ID).map((one) => one.block), [ANSWERS.ledger.block], 'the list’s ledger answer, kept');
  const first = store.view(ID);
  // A read a little after the mint: before the first compound, a fraction of what it settled.
  const timeOf = (block) => ANSWERS.ledger.timestamp + Math.floor((block - ANSWERS.ledger.block) / 10);
  const block = 73_300_000;
  assert.equal(readings.insert(ID, { block, t: timeOf(block), unclaimed: [1_000_000n, 10n ** 20n] }, ANSWERS.ledger.timestamp), true);
  assert.equal(store.view(ID), first, 'nothing changes until it is folded again');
  store.redraw(ID);
  const after = store.view(ID);
  assert.notEqual(after, first);
  assert.equal(after.phase, 'verified');
  assert.deepEqual(after.history.points.find((point) => point.block === block)?.earned, [1_000_000n, 10n ** 20n]);
  // A read older than the readings keep, held by the runner, is a point too.
  const old = 73_250_000;
  held.push({ block: old, t: timeOf(old), unclaimed: [10n, 10n] });
  store.redraw(ID);
  assert.equal(store.view(ID).history.points.find((point) => point.block === old)?.kind, 'reading');
  // An id no screen shows: nothing to fold, no error.
  store.redraw('999');
  stop();
});

// 2026-10-02 (the owner's preview: an iPhone session logged no ledger answer at all). A ledger request that never answers
// held its id for the visit (askLedger skips an id whose read is on its way): it is dropped after LEDGER_WAIT_MS and taken
// as a read that could not reach the chain, so the ladder asks again.
test('a ledger request that hangs is dropped after its wait and asked again on the ladder; a request that answers stops its wait', async () => {
  const { store, svc, time } = storeWith();
  const real = svc.postLedger;
  let hung = null;
  svc.postLedger = (ids, fresh, signal) => {
    if (!hung) {
      svc.ledgers.push({ ids: [...ids], fresh });
      hung = signal;
      return new Promise(() => {});
    }
    return real(ids, fresh);
  };
  const stop = store.subscribeHistory([ID], 'page', () => {});
  await until(() => svc.ledgers.length === 1 && store.view(ID).phase === 'loading' && store.view(ID).state, 'the ledger on its way');
  assert.equal(LEDGER_WAIT_MS, 45_000);
  assert.equal(time.fire('timer', LEDGER_WAIT_MS), 1);
  assert.equal(hung.aborted, true, 'the hung request is dropped');
  await until(() => store.view(ID).phase === 'unclaimed-only', 'the unclaimed figure, calmly');
  assert.equal(store.view(ID).reason, 'rpc_unavailable');
  assert.equal(time.fire('later', RETRY_MS[0]), 1);
  await until(() => store.view(ID).phase === 'verified', 'verified');
  assert.equal(svc.ledgers.length, 2, 'asked again');
  assert.ok(time.pending.filter((entry) => entry.kind === 'timer' && entry.ms === LEDGER_WAIT_MS).every((entry) => entry.cancelled), 'the answered request’s wait is stopped');
  stop();
});
