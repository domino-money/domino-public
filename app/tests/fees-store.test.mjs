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
import { txOf } from './support/fees/ledger-chain.mjs';
import { feesDefault } from './support/fees/stub.mjs';

const require = createRequire(import.meta.url);
const { AFTER_ACTION_MS, LEDGER_WAIT_MS, LIST_LOADING_MS, MAX_READING, RELEASE_MS, RETRY_MS, createFeesStore } = require('../.test-build/app/src/lib/fees/store.js');
const { rowAprs } = require('../.test-build/app/src/components/positions/listApr.js');
const { LEDGER_READING_MS, STATE_REFRESH_MS, LIST_STATE_REFRESH_MS } = require('../.test-build/app/src/lib/fees/constants.js');
const { createHistoryCache } = require('../.test-build/app/src/lib/fees/historyCache.js');
const { createReadings } = require('../.test-build/app/src/lib/fees/readings.js');
const routes = require('../.test-build/app/functions/_lib/chainRoutes.js');
const { browserWakeSource, createWake, WAKE_GAP_MS } = require('../.test-build/app/src/lib/wake.js');

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
  const { chain, spec } = ledgerWorld(options);
  const fetch = edgeFetch({ fetch: (_url, init) => chain.fetch(RPC_URL, init), now: () => 1_000_000, sleep: async () => {} });
  const post = async (path, body) => (await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
  return { state: await post('/api/fees/v1/state', { tokenIds: [ID], automation: true }), ledger: await post('/api/fees/v2/ledger', { tokenIds: [ID], mintHints: [{ tokenId: ID, block: spec.mint.block, tx: spec.mint.tx ?? txOf(spec.mint.block) }] }), chain };
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

test('an action invalidated during an in-flight read queues a new read and rejects blocks before its receipt', async () => {
  const svc = service();
  const pending = [];
  svc.postState = async (ids) => {
    svc.asked.push([...ids]);
    return new Promise((done) => pending.push(done));
  };
  const { store } = storeWith({ svc });
  const stop = store.subscribeStates([ID], () => {});
  await until(() => pending.length === 1, 'initial state');
  const receiptBlock = ANSWERS.state.block + 100;
  store.refresh([ID], receiptBlock);
  pending[0]({ ok: true, value: ANSWERS.state, bytes: 100 });
  await until(() => pending.length === 2, 'refresh queued after the in-flight request');
  assert.equal(store.position(ID), null, 'pre-action snapshot cannot undo the receipt');
  const closed = laterState(ANSWERS.state, 100, { liquidity: '0' });
  pending[1]({ ok: true, value: closed, bytes: 100 });
  await until(() => store.position(ID)?.block === receiptBlock, 'confirmed post-action snapshot');
  store.offer({ ok: true, value: ANSWERS.state, bytes: 100 });
  store.offer({ ok: true, value: { ...ANSWERS.state, positions: [{ tokenId: ID, ok: false, reason: 'not_found' }] }, bytes: 100 });
  assert.equal(store.position(ID).position.liquidity, '0', 'late positive or missing answers cannot reopen/erase it');
  stop();
});

test('a ledger refusal from before a receipt or newer state never settles the history as missing', async () => {
  for (const confirmed of [false, true]) {
    const svc = service();
    let finish;
    const postLedger = svc.postLedger;
    svc.postLedger = async (ids, fresh) => {
      if (svc.ledgers.length) return postLedger(ids, fresh);
      svc.ledgers.push({ ids: [...ids], fresh });
      return new Promise(done => { finish = done; });
    };
    const { store, time } = storeWith({ svc });
    const stop = store.subscribeHistory([ID], 'page', () => {});
    await until(() => finish && store.position(ID), 'current state and in-flight ledger');
    const block = ANSWERS.state.block + 100;
    svc.state = laterState(ANSWERS.state, 100);
    svc.ledger = { ...ANSWERS.ledger, block, timestamp: svc.state.timestamp };
    if (confirmed) store.refresh([ID], block);
    else store.offer({ ok: true, value: svc.state, bytes: 100 });
    finish({ ok: true, value: { ...ANSWERS.ledger, positions: [{ tokenId: ID, ok: false, reason: 'not_found' }] }, bytes: 10 });
    await until(() => time.pending.some(one => !one.cancelled && one.kind === 'later' && one.ms === RETRY_MS[0]), 'bounded fresh retry');
    assert.notEqual(store.view(ID).reason, 'not_found', 'last good state survives a late absence');
    time.fire('later', RETRY_MS[0]);
    await until(() => store.view(ID).phase === 'verified', 'new ledger is accepted');
    assert.equal(svc.ledgers.at(-1).fresh, true, 'a stale cached refusal is bypassed');
    stop();
  }
});

// Changed on purpose (owner's D8, 2026-10-15): a position page's state every 10 s (was 5 s); its six ticks are a minute
// now, so the list's 30 s batch comes twice in them (once in the six 5 s ticks before), never once per tick.
test('detail refreshes every ten seconds while list-only state refreshes in shared thirty-second batches', async () => {
  const { store, svc, time } = storeWith();
  const detail = store.subscribeHistory([ID], 'page', () => {});
  const list = store.subscribeHistory(['999'], 'list', () => {});
  await until(() => svc.asked.length === 1, 'initial shared batch');
  svc.asked.length = 0;
  assert.equal(STATE_REFRESH_MS, 10_000);
  assert.equal(LIST_STATE_REFRESH_MS, 30000);
  for (let i = 0; i < 6; i++) {
    assert.equal(time.fire('later', STATE_REFRESH_MS), 1);
    await settle();
  }
  assert.equal(svc.asked.filter((ids) => ids.includes(ID)).length, 6);
  assert.equal(svc.asked.filter((ids) => ids.includes('999')).length, 2, 'list refresh is not multiplied by detail ticks');
  detail(); list();
});

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
    postLedger: (ids, fresh, signal, hints) => svc.postLedger(ids, fresh, signal, hints),
    later: time.later,
    timer: time.timer,
    now,
    ...(storage ? { historyCache: createHistoryCache(() => storage, now), readings } : {}),
    ...(pastReadings ? { pastReadings } : {}),
  });
  return { store, svc, time, readings };
}

test('indexed mint evidence supersedes a slow cold read without letting its later failure overwrite the result', async () => {
  const svc = service();
  const pending = [];
  svc.postLedger = (ids, fresh, signal, hints) => new Promise(resolve => pending.push({ ids, fresh, signal, hints, resolve }));
  const { store } = storeWith({ svc });
  const stop = store.subscribeHistory([ID], 'page', () => {});
  await until(() => pending.length === 1, 'cold read');
  const mint = ANSWERS.ledger.positions.find(item => item.tokenId === ID).mint;
  const hint = { tokenId: ID, block: mint.block, tx: mint.tx };
  store.offerMint({ ...hint, block: -1 });
  store.offerMint({ ...hint, tx: 'unknown' });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(pending.length, 1, 'malformed hints start nothing');
  store.offerMint(hint);
  await until(() => pending.length === 2, 'hinted read starts without waiting for cold timeout');
  assert.deepEqual(pending[1].hints, [hint]);
  assert.equal(pending[1].fresh, true);
  store.offerMint(hint);
  pending[1].resolve({ ok: true, value: ANSWERS.ledger, bytes: 100 });
  await until(() => store.view(ID).phase === 'verified', 'hinted history');
  const verified = store.view(ID);
  pending[0].resolve({ ok: false, failure: 'unavailable', retryAfterMs: 0 });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(store.view(ID), verified, 'obsolete failure does not replace financial history');
  assert.equal(pending.length, 2, 'same indexed event never loops');
  stop();
});

test('a new indexed mint retries a previously unqualified ledger without declaring the hint exact', async () => {
  const svc = service();
  svc.ledger = { ...svc.ledger, positions: svc.ledger.positions.map(item => item.ok ? { ...item, exact: false, why: 'unseen', entries: [] } : item) };
  const { store } = storeWith({ svc });
  const stop = store.subscribeHistory([ID], 'page', () => {});
  await until(() => store.view(ID).phase === 'unclaimed-only', 'old unqualified ledger');
  const mint = ANSWERS.ledger.positions.find(item => item.tokenId === ID).mint;
  store.offerMint({ tokenId: ID, block: mint.block, tx: mint.tx });
  await until(() => svc.ledgers.length === 2, 'retry with mint');
  assert.equal(store.view(ID).phase, 'unclaimed-only', 'only the server can qualify the financial history');
  stop();
});

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

test('the list batches shared state and ledger reads, so current fees/APR do not wait for a historical refresh', async () => {
  const { store, svc } = storeWith();
  const ids = [ID, ...Array.from({ length: 9 }, (_, i) => String(100 + i))];
  const stop = store.subscribeHistory(ids, 'list', () => {});
  // 2026-10-02 (review of the rules, finding 11): each row is being read, with no state yet: its skeleton, not a dash.
  assert.deepEqual(store.view(ID), { phase: 'loading', state: null });
  await until(() => store.view(ID).phase === 'verified', 'the row’s history');
  assert.deepEqual(svc.asked.map((ids) => ids.length), [8, 2], 'one shared state batch, never one request per row');
  assert.deepEqual(svc.ledgers.map((one) => one.ids.length), [8, 2]);
  assert.equal(store.view(ID).state.block, ANSWERS.ledger.block, 'the ledger’s own state');
  assert.equal(store.view('100').phase, 'unavailable', 'an id the chain does not know');
  stop();
});

test('a list row whose ledger read fails retains confirmed current fees and retries its history', async () => {
  const { store, svc, time } = storeWith();
  svc.scripted.push({ ok: false, failure: 'unavailable', retryAfterMs: 0 });
  const stop = store.subscribeHistory([ID], 'list', () => {});
  assert.equal(store.view(ID).phase, 'loading');
  await until(() => store.view(ID).phase === 'unclaimed-only', 'confirmed current fees');
  assert.deepEqual(store.view(ID).state.unclaimed, ANSWERS.state.positions.map((p) => [BigInt(p.unclaimed0), BigInt(p.unclaimed1)])[0]);
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

// Added on purpose 2026-11-09 (core flows, the owner: nothing may be slow): the ids still `reading` were each asked again
// alone, each on its own timer, after the first batch answered.
test('the ids still `reading` are asked again together: one timer, one request for them all', async () => {
  const OTHER = '3325114';
  const both = (one) => [one, { ...one, tokenId: OTHER }];
  const svc = service({ state: { ...ANSWERS.state, positions: both(ANSWERS.state.positions[0]) }, ledger: { ...ANSWERS.ledger, positions: both(ANSWERS.ledger.positions[0]) } });
  const { store, time } = storeWith({ svc });
  svc.scripted.push({ ok: true, value: { ...READING, positions: both(READING.positions[0]) }, bytes: 10 });
  const list = store.subscribeHistory([ID, OTHER], 'list', () => {});
  const due = () => time.pending.filter((entry) => !entry.cancelled && entry.kind === 'later' && entry.ms === LEDGER_READING_MS);
  await until(() => svc.ledgers.length === 1 && due().length > 0, 'the reading retry');
  assert.deepEqual([...svc.ledgers[0].ids].sort(), [ID, OTHER].sort());
  assert.equal(due().length, 1, 'one timer for both');
  assert.equal(time.fire('later', LEDGER_READING_MS), 1);
  await until(() => store.view(ID).phase === 'verified' && store.view(OTHER).phase === 'verified', 'both verified');
  assert.equal(svc.ledgers.length, 2);
  assert.deepEqual([...svc.ledgers[1].ids].sort(), [ID, OTHER].sort(), 'both in one request');
  list();
});

test('a screen that leaves takes its ids out of the shared wait; the ids another screen still shows are asked again', async () => {
  const OTHER = '3325114';
  const both = (one) => [one, { ...one, tokenId: OTHER }];
  const svc = service({ state: { ...ANSWERS.state, positions: both(ANSWERS.state.positions[0]) }, ledger: { ...ANSWERS.ledger, positions: both(ANSWERS.ledger.positions[0]) } });
  const { store, time } = storeWith({ svc });
  svc.scripted.push({ ok: true, value: { ...READING, positions: both(READING.positions[0]) }, bytes: 10 });
  const page = store.subscribeHistory([ID], 'page', () => {});
  const list = store.subscribeHistory([OTHER], 'list', () => {});
  await until(() => svc.ledgers.length === 1 && time.pending.some((entry) => !entry.cancelled && entry.kind === 'later' && entry.ms === LEDGER_READING_MS), 'the reading retry');
  list();
  time.fire('timer', RELEASE_MS);
  assert.equal(time.fire('later', LEDGER_READING_MS), 1);
  await until(() => store.view(ID).phase === 'verified', 'the page’s verified');
  assert.deepEqual(svc.ledgers[1].ids, [ID], 'only the id still shown');
  page();
});

// Added on purpose 2026-11-09 (core flows, the owner: nothing may load forever): a list row's APR was a skeleton for as long
// as its ledger was read (up to MAX_READING answers).
test('a list row’s APR is a skeleton for LIST_LOADING_MS, then a dash while its ledger is read on; the rate takes its place once read', async () => {
  const { store, svc, time } = storeWith();
  svc.scripted.push({ ok: true, value: READING, bytes: 10 });
  const list = store.subscribeHistory([ID], 'list', () => {});
  await until(() => svc.ledgers.length === 1 && time.pending.some((entry) => !entry.cancelled && entry.kind === 'later' && entry.ms === LEDGER_READING_MS), 'the reading retry');
  const cell = () => rowAprs([ID], store.views([ID])).get(ID);
  assert.equal(store.view(ID).phase, 'loading');
  assert.equal(cell().kind, 'loading', 'a skeleton at first');
  assert.equal(LIST_LOADING_MS, 5_000);
  assert.equal(time.fire('timer', LIST_LOADING_MS), 1, 'one wait, however many loading views it went through');
  assert.deepEqual([store.view(ID).phase, store.view(ID).waited], ['loading', true]);
  assert.deepEqual(cell(), { kind: 'missing', words: 'Not measured yet', short: 'reading' }, 'a dash, no notice');
  // The read goes on, silently: the next answer draws the rate in the dash's place.
  assert.equal(time.fire('later', LEDGER_READING_MS), 1);
  await until(() => store.view(ID).phase === 'verified', 'verified');
  assert.equal(cell().kind, 'rate');
  assert.equal(time.pending.filter((entry) => !entry.cancelled && entry.kind === 'timer' && entry.ms === LIST_LOADING_MS).length, 0, 'no wait left');
  list();
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
  const { chain, spec } = ledgerWorld();
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
    const mintHints = [{ tokenId: ID, block: spec.mint.block, tx: txOf(spec.mint.block) }];
    const { result, sent } = await withEdge(deps, () => client.chainLedger([ID], false, undefined, mintHints));
    assert.equal(result.ok, true);
    assert.equal(result.value.positions[0].exact, true);
    assert.deepEqual(sent.map((one) => [one.path, one.body]), [['/api/fees/v2/ledger', { tokenIds: [ID], mintHints }]]);
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

// Added 2026-10-30 (QA round 2, N45 a): the Fees card and the list's APR stayed a skeleton for the visit when the ledger
// kept answering `reading`, or when its fresh read for the newest state still did not hold a settlement (a close by
// Auto-exit or a vault). Both now show Fees ready to collect only, `why: 'unseen'`; the store keeps asking.
test('N45 a: a ledger still `reading` past MAX_READING answers in a row shows Fees ready to collect only (unseen); the ladder asks on and verifies once read through', async () => {
  const { store, svc, time } = storeWith();
  for (let i = 0; i <= MAX_READING; i++) svc.scripted.push({ ok: true, value: READING, bytes: 10 });
  const stop = store.subscribeHistory([ID], 'page', () => {});
  await until(() => svc.ledgers.length === 1 && time.pending.some((entry) => !entry.cancelled && entry.ms === LEDGER_READING_MS), 'the first reading retry');
  for (let i = 1; i <= MAX_READING; i++) {
    assert.equal(store.view(ID).phase, 'loading', `still read after ${i} answers`);
    assert.equal(time.fire('later', LEDGER_READING_MS), 1);
    await until(() => svc.ledgers.length === i + 1 && time.pending.some((entry) => !entry.cancelled && entry.kind === 'later' && entry.ms === LEDGER_READING_MS), `reading answer ${i + 1}`);
  }
  const view = store.view(ID);
  assert.deepEqual([view.phase, view.reason, view.why, view.state?.block > 0], ['unclaimed-only', 'not_exact', 'unseen', true], 'no skeleton for the visit');
  assert.equal(view.events, undefined, 'no settlements claimed');
  // The ladder's next ask (RETRY_MS[0], the same 2 s) reads it through: verified.
  assert.equal(RETRY_MS[0], LEDGER_READING_MS);
  assert.equal(time.fire('later', RETRY_MS[0]), 1);
  await until(() => store.view(ID).phase === 'verified', 'verified');
  assert.equal(svc.ledgers.length, MAX_READING + 2);
  stop();
});

test('N45 a: a fresh ledger that still does not hold the newest state’s settlement shows Fees ready to collect only (unseen), never a skeleton; a drawn history stays', async () => {
  const position = ANSWERS.state.positions[0];
  const collected = { unclaimed0: '0', unclaimed1: '0', feeGrowthInside0LastX128: position.feeGrowthInside0X128, feeGrowthInside1LastX128: position.feeGrowthInside1X128 };
  // A first visit after a settlement the ledger does not hold: the fresh read answers the same older ledger.
  const { store, svc, time } = storeWith();
  svc.state = laterState(ANSWERS.state, 600, collected);
  // Each ledger read answers when the test says: the first once the newest state is known, then the fresh one.
  let first;
  let release;
  svc.postLedger = (ids, fresh) => {
    svc.ledgers.push({ ids: [...ids], fresh });
    return new Promise((done) => {
      const answer = () => done({ ok: true, value: svc.ledger, bytes: 100 });
      if (fresh) release = answer;
      else first = answer;
    });
  };
  const stop = store.subscribeHistory([ID], 'page', () => {});
  await until(() => first && store.position(ID)?.block === svc.state.block, 'the newest state, the ledger on its way');
  first();
  await until(() => release, 'the fresh ledger read on its way');
  assert.equal(store.view(ID).phase, 'loading', 'a skeleton while the fresh read is on its way');
  release();
  await until(() => store.view(ID).phase === 'unclaimed-only', 'Fees ready to collect only');
  const view = store.view(ID);
  assert.deepEqual([view.reason, view.why, view.state.block, view.state.unclaimed], ['not_exact', 'unseen', svc.state.block, [0n, 0n]]);
  assert.deepEqual(svc.ledgers.map((one) => one.fresh), [false, true], 'one fresh read for this state');
  // The same state again: no other read, the view unchanged.
  assert.equal(time.fire('later', STATE_REFRESH_MS), 1);
  await settle();
  assert.equal(store.view(ID), view);
  assert.equal(svc.ledgers.length, 2);
  // A newer state the ledger agrees with: verified.
  svc.state = laterState(ANSWERS.state, 1_200);
  assert.equal(time.fire('later', STATE_REFRESH_MS), 1);
  await until(() => store.view(ID).phase === 'verified', 'verified');
  stop();

  // A verified card whose newer state shows a settlement the fresh ledger still does not hold: the card stays.
  const drawn = storeWith();
  const shown = drawn.store.subscribeHistory([ID], 'page', () => {});
  await until(() => drawn.store.view(ID).phase === 'verified', 'verified');
  const before = drawn.store.view(ID);
  drawn.svc.state = laterState(ANSWERS.state, 600, collected);
  assert.equal(drawn.time.fire('later', STATE_REFRESH_MS), 1);
  await until(() => drawn.svc.ledgers.length === 2, 'the fresh ledger read');
  await settle();
  await settle();
  assert.equal(drawn.svc.ledgers[1].fresh, true);
  assert.equal(drawn.store.view(ID), before, 'the drawn history stays');
  shown();
});

// Fixed 2026-10-30 after review (N45 a): a fresh question asked while a failed ledger read's retry waits was dropped, so
// the card took `unseen` before any fresh read for that state, and the retry asked a ledger that may predate it.
test('N45 a: a fresh question asked while a retry waits is asked by that retry, and the card shows unseen only once it answered', async () => {
  const position = ANSWERS.state.positions[0];
  const collected = { unclaimed0: '0', unclaimed1: '0', feeGrowthInside0LastX128: position.feeGrowthInside0X128, feeGrowthInside1LastX128: position.feeGrowthInside1X128 };
  const { store, svc, time } = storeWith();
  // A first visit after a settlement the ledger does not hold; the fresh read for it fails once.
  svc.state = laterState(ANSWERS.state, 600, collected);
  svc.scripted.push(null, { ok: false, failure: 'unavailable', retryAfterMs: 0 });
  const stop = store.subscribeHistory([ID], 'page', () => {});
  await until(() => svc.ledgers.length === 2 && time.pending.some((entry) => !entry.cancelled && entry.kind === 'later' && entry.ms === RETRY_MS[0]), 'the failed fresh read, its retry waiting');
  assert.deepEqual(svc.ledgers.map((one) => one.fresh), [false, true]);
  assert.deepEqual([store.view(ID).phase, store.view(ID).reason], ['unclaimed-only', 'rpc_unavailable'], 'the unclaimed figure, calmly');
  // A newer state that still disagrees, while the retry waits: nothing asked yet, and not unseen before a fresh read.
  svc.state = laterState(ANSWERS.state, 1_200, collected);
  assert.equal(time.fire('later', STATE_REFRESH_MS), 1);
  await until(() => store.position(ID)?.block === svc.state.block, 'the newer state');
  await settle();
  assert.equal(svc.ledgers.length, 2, 'the retry still waits');
  assert.notEqual(store.view(ID).why, 'unseen', 'no fresh read for this state yet');
  // The retry asks fresh; its answer still lacks the settlement: unseen.
  assert.equal(time.fire('later', RETRY_MS[0]), 1);
  await until(() => store.view(ID).why === 'unseen', 'unseen once the fresh read answered');
  assert.deepEqual(svc.ledgers.map((one) => one.fresh), [false, true, true], 'the retry asked fresh');
  assert.equal(store.view(ID).state.block, svc.state.block);
  stop();
});

// 2026-10-02 (the chart's periods back, lib/fees/pastReads.ts): every ledger answer keeps its own state as one of this
// browser's readings (a measured point at no cost), and the store folds a position's view again when a read at a past
// block was kept (`redraw`), with the reads too old to keep that the runner holds (`pastReadings`). Changed on purpose
// the same day (review of the chart's tabs, finding 4): the list's answers only for a position this browser already keeps
// readings of; readings keep the MAX_NFTS positions read last, and a list of more pushed out what its pages had kept.
test('a ledger answer’s own state is kept as a reading: a page’s, and the list’s only for a position whose page this browser keeps; redraw folds the view again with a past read; held reads are folded in', async () => {
  const storage = memoryStorage();
  const held = [];
  // The list alone, for a position this browser keeps no reading of: nothing kept.
  const cold = storeWith({ storage });
  const listed = cold.store.subscribeHistory([ID], 'list', () => {});
  await until(() => cold.store.view(ID).phase === 'verified', 'verified');
  assert.deepEqual(cold.readings.get(ID), [], 'the list’s answer is not kept for a position never opened here');
  listed();
  // Its page: its reads are kept (the /state read and the ledger's own, at most one an hour).
  const visit = storeWith({ storage });
  const page = visit.store.subscribeHistory([ID], 'page', () => {});
  await until(() => visit.store.view(ID).phase === 'verified', 'verified');
  assert.equal(visit.readings.get(ID).length, 1, 'the page’s read, kept');
  page();
  // A later visit's list, two hours on: kept, its page having kept readings.
  const later = { ...ANSWERS.ledger, block: ANSWERS.ledger.block + 72_000, timestamp: ANSWERS.ledger.timestamp + 7_200 };
  const svc = service({ ...ANSWERS, ledger: later });
  const { store, readings } = storeWith({ storage, svc, pastReadings: () => held });
  const stop = store.subscribeHistory([ID], 'list', () => {});
  await until(() => store.view(ID).phase === 'verified', 'verified');
  assert.equal(readings.get(ID).at(-1).block, later.block, 'the list’s ledger answer, kept');
  assert.equal(readings.get(ID).length, 2);
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

// 2026-10-02 (review of the chart's tabs, finding 1: the preview's log showed visits that asked no ledger, and a log line
// says nothing of what a ledger answered): each id's ledger requests this visit and how the last one ended, for the
// screens' data attributes (data-ledger-asks, data-ledger-last); the same Map while nothing changed.
test('traces: each id’s ledger requests this visit and how the last ended (exact, a why, a failure, unanswered); the same Map while nothing changed', async () => {
  const { store, svc, time } = storeWith();
  const none = store.traces([ID]);
  assert.deepEqual([...none], [[ID, { asks: 0, last: null }]], 'nothing asked yet');
  assert.equal(store.traces([ID]), none, 'the same Map');
  // A first request that fails, then the ladder's: the failure, then exact.
  svc.scripted.push({ ok: false, failure: 'rate_limited', retryAfterMs: 0 });
  const heard = [];
  const stop = store.subscribeHistory([ID], 'page', () => heard.push(store.traces([ID]).get(ID)));
  await until(() => store.traces([ID]).get(ID).last === 'rate_limited', 'the failure');
  assert.deepEqual(store.traces([ID]).get(ID), { asks: 1, last: 'rate_limited' });
  assert.ok(heard.some((trace) => trace.asks === 1 && trace.last === null), 'told as it is sent');
  assert.equal(time.fire('later', RETRY_MS[0]), 1);
  await until(() => store.view(ID).phase === 'verified', 'verified');
  const exact = store.traces([ID]);
  assert.deepEqual(exact.get(ID), { asks: 2, last: 'exact' });
  assert.equal(store.traces([ID]), exact, 'the same Map while nothing changed');
  stop();
  // A ledger that cannot measure this position: its why. A request that never answers: unanswered.
  const other = storeWith();
  other.svc.scripted.push({ ok: true, value: { ...ANSWERS.ledger, positions: ANSWERS.ledger.positions.map((one) => ({ ...one, exact: false, why: 'manual' })) }, bytes: 10 });
  const page = other.store.subscribeHistory([ID], 'page', () => {});
  await until(() => other.store.traces([ID]).get(ID).last === 'manual', 'its why');
  page();
  const hung = storeWith();
  hung.svc.postLedger = () => new Promise(() => {});
  const shown = hung.store.subscribeHistory([ID], 'list', () => {});
  await settle();
  assert.equal(hung.time.fire('timer', LEDGER_WAIT_MS), 1);
  await until(() => hung.store.traces([ID]).get(ID).last === 'unanswered', 'unanswered');
  assert.deepEqual(hung.store.traces([ID]).get(ID), { asks: 1, last: 'unanswered' });
  shown();
});

// ---------------------------------------------------------------------------
// The page's one wake rule (incident 2026-10-13, design 2.5, package Q1)
// ---------------------------------------------------------------------------

/**
 * A page on a fake clock: its window and document (EventTargets), its visibility, the store's `later` as
 * quietRead.ts whenVisibleAfter behaves (a timer that falls due while the page is hidden runs once it is shown again) and
 * the store wired to the page's wake as spawn.ts wires it (lib/wake.ts). `requests`: every /state request, with its time.
 */
function pageOf({ svc = service(), ids = [ID], scope = 'page' } = {}) {
  let now = 1_800_000_000_000;
  let hidden = false;
  const win = new EventTarget();
  const doc = new EventTarget();
  Object.defineProperty(doc, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible') });
  const timers = [];
  const later = (ms, run) => {
    let cancelled = false;
    let waiting = null;
    const entry = { at: now + ms, done: false };
    entry.run = () => {
      if (cancelled) return;
      if (!hidden) return run();
      waiting = () => {
        if (hidden) return;
        doc.removeEventListener('visibilitychange', waiting);
        if (!cancelled) run();
      };
      doc.addEventListener('visibilitychange', waiting);
    };
    timers.push(entry);
    return () => {
      cancelled = true;
      entry.done = true;
      if (waiting) doc.removeEventListener('visibilitychange', waiting);
    };
  };
  const timer = (ms, run) => {
    const entry = { at: now + ms, done: false, run };
    timers.push(entry);
    return () => void (entry.done = true);
  };
  const requests = [];
  const postState = svc.postState;
  svc.postState = (asked) => {
    requests.push({ at: now, ids: [...asked] });
    return postState(asked);
  };
  const store = createFeesStore({ postState: (asked) => svc.postState(asked), postLedger: (asked, fresh) => svc.postLedger(asked, fresh), later, timer, now: () => now });
  const wake = createWake(browserWakeSource(win, doc, () => now));
  const stopWake = wake.onWake(() => store.resume());
  const stop = store.subscribeHistory(ids, scope, () => {});
  return {
    store,
    svc,
    requests,
    win,
    doc,
    now: () => now,
    /** Moves the clock by `ms`, running every timer that falls due on the way, in order. */
    async advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((entry) => !entry.done && entry.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = Math.max(now, due.at);
        due.done = true;
        due.run();
        await settle();
      }
      now = end;
      await settle();
    },
    async show(visible) {
      hidden = !visible;
      doc.dispatchEvent(new Event('visibilitychange'));
      await settle();
    },
    close() {
      stop();
      stopWake();
    },
  };
}

// Changed on purpose (2026-10-14, Q1 alone): at the periods before Q1, 5 s for a page and 30 s for a list (the owner's
// decisions D8 and D4 not taken): twelve requests a minute on a page, every 5 s, and two a minute per eight rows on a list,
// where Q1 alone counted six (every 10 s) and one (every 60 s).
// Changed on purpose (owner's D8, 2026-10-15): the page every 10 s, six requests a minute (was twelve); the list's 30 s is
// unchanged (D4 not taken).
test('wake rule: a visible position page asks /state six times a minute; a visible list twice a minute per eight rows', async () => {
  const page = pageOf();
  await until(() => page.requests.length === 1, 'the first read');
  await page.advance(60_000);
  assert.equal(page.requests.length - 1, 6, 'six a minute (10 s, the owner’s decision D8)');
  assert.ok(page.requests.slice(1).every((request, i) => request.at - page.requests[i].at === 10_000), 'every 10 s');
  page.close();
  // Sixteen rows: two requests of eight, then two every 30 s.
  const svc = service();
  const rows = [ID, ...Array.from({ length: 15 }, (_, i) => String(500 + i))];
  svc.state = { ...svc.state, positions: rows.map((tokenId) => ({ ...ANSWERS.state.positions[0], tokenId })) };
  const list = pageOf({ svc, ids: rows, scope: 'list' });
  await until(() => list.requests.length === 2, 'the first batches');
  assert.deepEqual(list.requests.map((request) => request.ids.length), [8, 8]);
  await list.advance(LIST_STATE_REFRESH_MS - 1);
  assert.equal(list.requests.length, 2, 'nothing before the half minute');
  await list.advance(1);
  assert.equal(list.requests.length, 4, 'half a minute later, one request per eight rows');
  await list.advance(270_000);
  assert.equal(list.requests.length, 22, 'and so on: five minutes, twenty requests after the first two for sixteen rows');
  list.close();
});

// Changed on purpose (2026-10-14, Q1 alone): the page's period is 5 s (was 10 s in Q1 alone), so "back while the figure is
// young" is back after 3 s, and the page's own read follows at 5 s.
// Changed on purpose (owner's D8, 2026-10-15): the page's period is 10 s, so its own read follows at 10 s.
test('wake rule: twenty focus events ask nothing; hidden 3 s then visible asks nothing; hidden 90 s then visible asks once', async () => {
  const page = pageOf();
  await until(() => page.requests.length === 1, 'the first read');
  await page.advance(1_000);
  for (let i = 0; i < 20; i++) {
    page.win.dispatchEvent(new Event('focus'));
    await settle();
  }
  assert.equal(page.requests.length, 1, 'focus is not a wake (a wallet popup closing fires it)');
  await page.show(false);
  await page.advance(3_000);
  await page.show(true);
  assert.equal(page.requests.length, 1, 'back after 3 s: the last answer is younger than the page’s 10 s');
  await page.advance(5_999);
  assert.equal(page.requests.length, 1, 'nothing before the page’s 10 s');
  await page.advance(1);
  assert.equal(page.requests.length, 2, 'the page’s own 10 s read, on time');
  await page.show(false);
  await page.advance(90_000);
  assert.equal(page.requests.length, 2, 'nothing while hidden');
  await page.show(true);
  assert.equal(page.requests.length, 3, 'back after 90 s: one read, not one per waiting timer and wake');
  await page.advance(STATE_REFRESH_MS - 1);
  assert.equal(page.requests.length, 3, 'and the next one a period later');
  await page.advance(1);
  assert.equal(page.requests.length, 4);
  page.close();
});

// Changed on purpose (2026-10-14, Q1 alone): the page's period is 5 s (was 10 s in Q1 alone); the wake rounds stay at
// least 10 s apart.
test('wake rule: online with a young figure asks nothing, a hidden page has no wake, and a failure keeps its wait', async () => {
  assert.equal(WAKE_GAP_MS, 10_000);
  const page = pageOf();
  await until(() => page.requests.length === 1, 'the first read');
  page.win.dispatchEvent(new Event('online'));
  await settle();
  assert.equal(page.requests.length, 1, 'back online with an answer younger than 10 s: nothing');
  await page.show(false);
  await page.advance(40_000);
  page.win.dispatchEvent(new Event('online'));
  await settle();
  assert.equal(page.requests.length, 1, 'hidden: no wake at all');
  await page.show(true);
  assert.equal(page.requests.length, 2, 'shown again 40 s later: one read');
  await page.advance(STATE_REFRESH_MS);
  assert.equal(page.requests.length, 3, 'then every 10 s');
  page.svc.down = true;
  await page.advance(STATE_REFRESH_MS);
  assert.equal(page.requests.length, 4, 'a refresh that fails');
  for (let i = 0; i < 3; i++) {
    page.win.dispatchEvent(new Event('online'));
    await settle();
  }
  assert.equal(page.requests.length, 4, 'a failure waits out its own retry: a wake never speeds it up');
  page.svc.down = false;
  await page.advance(RETRY_MS[0]);
  assert.equal(page.requests.length, 5, 'its retry, on its own time');
  page.close();
});
