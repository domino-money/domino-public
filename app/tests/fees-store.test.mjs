/**
 * The fees store behind useFeeHistory / useFeeHistories / useFeeStates
 * (src/lib/fees/store.ts; DESIGN-V2 §15.4–§15.6): the views a screen sees,
 * one /state read and one replay shared by every screen showing an id, the
 * worker's message protocol (every message crosses a structured clone, as it
 * does between threads), the refresh that resumes from a checkpoint, the
 * budgets per scope, and a failed worker never created again.
 *
 * The worker here is a loopback that runs pipeline.ts on the recorded relay
 * answers of tests/support/fees; the hooks are thin useSyncExternalStore
 * wrappers over exactly these calls.
 *
 * Added 2026-09-24 (P6, fees data).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { fixtureRelay, loadCase, stateOfCase } from './support/fees/relay-fixture.mjs';

const require = createRequire(import.meta.url);
const { createFeesStore, RELEASE_MS } = require('../.test-build/app/src/lib/fees/store.js');
const { runPipeline } = require('../.test-build/app/src/lib/fees/pipeline.js');
const { BUDGET_BYTES, STATE_REFRESH_MS } = require('../.test-build/app/src/lib/fees/constants.js');

const settle = () => new Promise((done) => setTimeout(done, 0));
async function until(check, what) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await settle();
  }
  assert.fail(`timed out waiting for ${what}`);
}

/** A worker that runs the pipeline in this thread on recorded answers; every message is structured-cloned both ways. */
function loopback(relays = {}) {
  const worker = {
    posted: [],
    terminated: false,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    runs: new Map(),
    postMessage(message) {
      const inbound = structuredClone(message);
      worker.posted.push(inbound);
      const previous = worker.runs.get(inbound.id);
      if (previous) previous.cancelled = true;
      if (inbound.type === 'cancel') return;
      const token = { cancelled: false };
      worker.runs.set(inbound.id, token);
      const relay = relays[inbound.id] ?? fixtureRelay(loadCase(inbound.id));
      runPipeline({ logs: relay.logs, sleep: async () => {}, cancelled: () => token.cancelled }, inbound).then((result) => {
        if (!result || token.cancelled) return;
        setTimeout(() => worker.onmessage?.({ data: structuredClone({ type: 'done', id: inbound.id, result }) }), 0);
      });
    },
    terminate() {
      worker.terminated = true;
    },
  };
  return worker;
}

/** Recorded /state answers per id (the fixtures'), with `bump` blocks added; `refuse` ids answer not_found. */
function stateService({ bump = 0, down = false, reasons = {} } = {}) {
  const service = {
    asked: [],
    bump,
    down,
    async postState(ids) {
      service.asked.push([...ids]);
      if (service.down) return { ok: false, failure: 'unavailable', retryAfterMs: 0 };
      const answers = ids.map((id) => {
        if (reasons[id]) return { tokenId: id, ok: false, reason: reasons[id] };
        try {
          return loadCase(id).state.positions[0];
        } catch {
          return { tokenId: id, ok: false, reason: 'not_found' };
        }
      });
      const base = ids.map((id) => { try { return loadCase(id).state; } catch { return null; } }).find(Boolean) ?? { block: 1, timestamp: 1 };
      return { ok: true, value: { v: 1, block: base.block + service.bump, timestamp: base.timestamp + service.bump, positions: answers }, bytes: 100 };
    },
  };
  return service;
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

function storeWith({ relays, service = stateService(), spawn } = {}) {
  const workers = [];
  const time = clock();
  const store = createFeesStore({
    spawn: spawn ?? (() => {
      const worker = loopback(relays);
      workers.push(worker);
      return worker;
    }),
    postState: (ids) => service.postState(ids),
    later: time.later,
    timer: time.timer,
  });
  return { store, workers, service, time };
}

test('one position: idle, then loading with its on-chain state, then verified; the worker gets the chain’s growth and the page budget', async () => {
  const { store, workers, service } = storeWith();
  const seen = [];
  assert.equal(store.view('3136705').phase, 'idle');
  const stop = store.subscribeHistory(['3136705'], 'page', () => seen.push(store.view('3136705').phase));
  await until(() => store.view('3136705').phase === 'verified', 'verified');
  assert.deepEqual(service.asked, [['3136705']]);
  assert.deepEqual([...new Set(seen)], ['loading', 'verified']);
  const view = store.view('3136705');
  const fixture = loadCase('3136705');
  assert.equal(view.state.block, fixture.state.block);
  assert.equal(view.state.unclaimed[0], BigInt(fixture.state.positions[0].unclaimed0));
  assert.equal(view.history.earned[0] - view.history.collected[0], view.state.unclaimed[0]);
  assert.ok(view.prices.hours.length > 0);
  const [run] = workers[0].posted;
  assert.equal(run.type, 'run');
  assert.equal(run.budgetBytes, BUDGET_BYTES.page);
  assert.equal(run.checkpoint, null);
  assert.deepEqual(run.growth, [BigInt(fixture.state.positions[0].feeGrowthInside0X128) - BigInt(fixture.state.positions[0].feeGrowthInside0LastX128), BigInt(fixture.state.positions[0].feeGrowthInside1X128) - BigInt(fixture.state.positions[0].feeGrowthInside1LastX128)].map((d) => BigInt.asUintN(256, d)));
  assert.equal(store.view('3136705'), view, 'the same object while nothing changed');
  stop();
});

test('screens showing one id share one /state read and one replay; the list aggregate is one subscription', async () => {
  const { store, workers, service } = storeWith();
  const a = store.subscribeHistory(['3136705'], 'page', () => {});
  const b = store.subscribeHistory(['3136705', '3135288'], 'list', () => {});
  const c = store.subscribeStates(['3136705'], () => {});
  await until(() => store.view('3136705').phase === 'verified' && store.view('3135288').phase === 'verified', 'both verified');
  assert.deepEqual(service.asked, [['3136705', '3135288']], 'one batched /state request');
  assert.equal(workers.length, 1);
  assert.deepEqual(workers[0].posted.map((m) => [m.type, m.id]).sort(), [['run', '3135288'], ['run', '3136705']]);
  const views = store.views(['3136705', '3135288']);
  assert.equal(store.views(['3136705', '3135288']), views, 'a stable Map while nothing changed');
  assert.deepEqual([...views.keys()], ['3136705', '3135288']);
  const [x, y] = [views.get('3136705'), views.get('3135288')];
  assert.equal(x.phase, 'verified');
  assert.deepEqual(y.history.earned, [0n, 0n], 'the owner’s zero state');
  for (const stop of [a, b, c]) stop();
});

test('useFeeStates’ answer: null until something is known, then each id’s state or null (not found, hooked)', async () => {
  const service = stateService({ reasons: { 7: 'hooked_pool' } });
  const { store } = storeWith({ service });
  const ids = ['3136705', '999', '7'];
  const stop = store.subscribeStates(ids, () => {});
  assert.equal(store.states(ids), null);
  await until(() => store.states(ids) !== null, 'states');
  const states = store.states(ids);
  assert.equal(states.get('3136705').block, loadCase('3136705').state.block);
  assert.equal(states.get('999'), null);
  assert.equal(states.get('7'), null);
  assert.equal(store.states(ids), states, 'stable');
  stop();
  const history = store.subscribeHistory(['999', '7'], 'page', () => {});
  assert.deepEqual([store.view('999'), store.view('7')], [{ phase: 'unavailable', reason: 'not_found' }, { phase: 'unavailable', reason: 'hooked_pool' }]);
  history();
});

test('/state that cannot be read shows nothing (unavailable, rpc_unavailable), and no worker is created', async () => {
  const { store, workers } = storeWith({ service: stateService({ down: true }) });
  const stop = store.subscribeHistory(['3136705'], 'page', () => {});
  await until(() => store.view('3136705').phase === 'unavailable', 'unavailable');
  assert.deepEqual(store.view('3136705'), { phase: 'unavailable', reason: 'rpc_unavailable' });
  assert.equal(workers.length, 0);
  stop();
});

test('a relay failure after /state leaves the on-chain figure (unclaimed-only), and the reason is data only', async () => {
  const fixture = loadCase('3136705');
  const relay = fixtureRelay(fixture, { script: { transfer: [{ ok: false, failure: 'unavailable', retryAfterMs: 0 }] } });
  const { store } = storeWith({ relays: { 3136705: relay } });
  const stop = store.subscribeHistory(['3136705'], 'page', () => {});
  await until(() => store.view('3136705').phase === 'unclaimed-only', 'unclaimed-only');
  const view = store.view('3136705');
  assert.equal(view.reason, 'rpc_unavailable');
  assert.equal(view.state.unclaimed[1], BigInt(fixture.state.positions[0].unclaimed1));
  stop();
});

test('a worker that fails (a stale file after a deploy) leaves every history at its unclaimed figure and is never created again', async () => {
  const workers = [];
  const { store } = storeWith({
    spawn: () => {
      const worker = { posted: [], onmessage: null, onerror: null, onmessageerror: null, terminated: false, postMessage(message) { this.posted.push(message); }, terminate() { this.terminated = true; } };
      workers.push(worker);
      return worker;
    },
  });
  const a = store.subscribeHistory(['3136705'], 'page', () => {});
  await until(() => workers[0]?.posted.length === 1, 'the run');
  workers[0].onerror?.({ message: 'Unexpected token <' });
  assert.deepEqual({ phase: store.view('3136705').phase, reason: store.view('3136705').reason }, { phase: 'unclaimed-only', reason: 'worker_failed' });
  assert.equal(workers[0].terminated, true);
  const b = store.subscribeHistory(['2310187'], 'page', () => {});
  await until(() => store.view('2310187').phase === 'unclaimed-only', 'the second id');
  assert.equal(store.view('2310187').reason, 'worker_failed');
  assert.equal(workers.length, 1, 'not respawned');
  a();
  b();
});

test('every minute while visible /state is read again; a newer block resumes from the checkpoint for the new logs only', async () => {
  const fixture = loadCase('3136705');
  const relay = fixtureRelay(fixture);
  const service = stateService();
  const { store, workers, time } = storeWith({ relays: { 3136705: relay }, service });
  const stop = store.subscribeHistory(['3136705'], 'page', () => {});
  await until(() => store.view('3136705').phase === 'verified', 'verified');
  const first = store.view('3136705');
  assert.equal(time.pending.filter((t) => t.kind === 'later' && !t.cancelled)[0].ms, STATE_REFRESH_MS);
  const asked = relay.requests.length;
  // Ten blocks later, inside the same hour (the recording has no later log, so the state is the same).
  service.bump = 10;
  assert.equal(time.fire('later'), 1);
  await until(() => store.view('3136705') !== first && store.view('3136705').phase === 'verified', 'verified again');
  const second = store.view('3136705');
  assert.equal(second.state.block, first.state.block + 10);
  const resumed = workers[0].posted.at(-1);
  assert.notEqual(resumed.checkpoint, null, 'resumed from the checkpoint');
  assert.ok(!relay.requests.slice(asked).some((r) => r.kind === 'transfer' || r.kind === 'initialize'), 'no start over');
  assert.deepEqual(second.history.earned, first.history.earned);
  stop();
});

test('the list budget stops a busy history with its place kept; a position page goes on from it with the larger budget', async () => {
  // Changed on purpose (2026-09-25, the page's budget is 2 MB): 3136705's swap days at four times their recorded size,
  // one day an answer: its first day ends past the list's 1 MB (1.2 MB), and the whole, 1.4 MB, is within the page's 2 MB.
  // Its probe answered as a quiet pool's (the probe's own stops are pipeline.ts's, tested in fees-replay.test.mjs): the
  // byte budget is what stops it here.
  const fixture = loadCase('3136705');
  const quietProbe = (request) => ({ ok: true, value: { v: 1, kind: 'probe', head: fixture.state.block + 2, units: [{ unit: null, from: request.from, to: request.to, final: false, logs: [] }], next: null }, bytes: 100 });
  const { store, workers } = storeWith({ relays: { 3136705: fixtureRelay(fixture, { maxDays: 1, swapBytes: 4, script: { probe: Array.from({ length: 20 }, () => quietProbe) } }) } });
  const list = store.subscribeHistory(['3136705'], 'list', () => {});
  await until(() => store.view('3136705').phase === 'unclaimed-only', 'stopped by the list budget');
  assert.equal(store.view('3136705').reason, 'too_much_history');
  assert.equal(workers[0].posted[0].budgetBytes, BUDGET_BYTES.list);
  const page = store.subscribeHistory(['3136705'], 'page', () => {});
  await until(() => store.view('3136705').phase === 'verified', 'verified on the page');
  const second = workers[0].posted.filter((m) => m.type === 'run')[1];
  assert.equal(second.budgetBytes, BUDGET_BYTES.page);
  assert.notEqual(second.checkpoint, null);
  list();
  page();
});

// 2026-09-25: a run that could not reach the chain is not started again at once. Each visitor now reads the chain from
// their own address, under the RPC's limit: a run asked again straight after a refusal is refused too, and the page's own
// reads with it. The next /state read with a newer block (a minute later) asks again, up to three failures a visit.
test('a run that could not reach the chain waits for the next newer block before it is asked again', async () => {
  const fixture = loadCase('3136705');
  const relay = fixtureRelay(fixture, { script: { transfer: [{ ok: false, failure: 'unavailable', retryAfterMs: 0 }] } });
  const service = stateService();
  const { store, workers, time } = storeWith({ relays: { 3136705: relay }, service });
  const stop = store.subscribeHistory(['3136705'], 'page', () => {});
  await until(() => store.view('3136705').phase === 'unclaimed-only', 'unclaimed-only');
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(workers[0].posted.filter((m) => m.type === 'run').length, 1, 'not started again at once');
  assert.equal(store.view('3136705').reason, 'rpc_unavailable');
  // A minute later /state is read again; the same block starts nothing, a newer one does.
  assert.equal(time.fire('later'), 1);
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(workers[0].posted.filter((m) => m.type === 'run').length, 1, 'the same block: still nothing');
  service.bump = 10;
  assert.equal(time.fire('later'), 1);
  await until(() => store.view('3136705').phase === 'verified', 'verified on the newer block');
  assert.equal(workers[0].posted.filter((m) => m.type === 'run').length, 2);
  stop();
});

// 2026-09-25: the budget now bounds the pool's epochs too (pipeline.ts), where a stopped run has no place to keep: a
// position page's larger budget then starts that history over.
test('a list budget spent before the swap days: a position page starts the history over with its larger budget', async () => {
  const fixture = loadCase('3136705');
  // Changed on purpose (2026-09-25, the price path): its probe answered as a quiet pool's, so the exact replay of the
  // pool's history is the one chosen under both budgets (a probe past the list's budget now leads to the price path).
  const quietProbe = (request) => ({ ok: true, value: { v: 1, kind: 'probe', head: fixture.state.block + 2, units: [{ unit: null, from: request.from, to: request.to, final: false, logs: [] }], next: null }, bytes: 100 });
  const relay = fixtureRelay(fixture, { script: { probe: Array.from({ length: 20 }, () => quietProbe) } });
  // Each of its four epochs answered at 300 kB (2026-09-25, the budgets are 1 MB and 2 MB): the list's is spent by them.
  const heavy = { logs: async (request) => { const a = await relay.logs(request); return request.kind === 'pool' && a.ok ? { ...a, bytes: 300 * 1024 } : a; } };
  const { store, workers } = storeWith({ relays: { 3136705: heavy } });
  const list = store.subscribeHistory(['3136705'], 'list', () => {});
  await until(() => store.view('3136705').phase === 'unclaimed-only', 'stopped by the list budget');
  assert.equal(store.view('3136705').reason, 'too_much_history');
  const page = store.subscribeHistory(['3136705'], 'page', () => {});
  await until(() => store.view('3136705').phase === 'verified', 'verified on the page');
  const runs = workers[0].posted.filter((m) => m.type === 'run');
  assert.deepEqual(runs.map((m) => [m.budgetBytes, m.checkpoint]), [[BUDGET_BYTES.list, null], [BUDGET_BYTES.page, null]]);
  list();
  page();
});

// 2026-09-25: the Positions list's aggregate asks its histories one at a time (useFeeHistories); `watch` is how it hears
// about every id's view without asking for any of them.
test('watch hears every change to the ids it names and asks nothing for them', async () => {
  const { store, workers, service } = storeWith();
  const heard = [];
  const unwatch = store.watch(['3136705', '2310187'], () => heard.push(store.view('3136705').phase));
  for (let i = 0; i < 20; i++) await settle();
  assert.deepEqual([service.asked, workers.length, heard], [[], 0, []], 'watching asks nothing');
  const stop = store.subscribeHistory(['3136705'], 'page', () => {});
  await until(() => store.view('3136705').phase === 'verified', 'verified');
  assert.ok(heard.includes('loading') && heard.at(-1) === 'verified', heard.join(' → '));
  assert.deepEqual(service.asked, [['3136705']], 'only the id asked for was read');
  unwatch();
  stop();
});

test('leaving: the run is cancelled a moment after the last screen goes, the worker ended a moment later; a quick return keeps both', async () => {
  const { store, workers, time } = storeWith();
  const stop = store.subscribeHistory(['2310187'], 'page', () => {});
  await until(() => workers[0]?.posted.length === 1, 'the run');
  stop();
  // StrictMode's second mount, or a quick return: nothing is cancelled.
  const again = store.subscribeHistory(['2310187'], 'page', () => {});
  assert.equal(time.fire('timer', RELEASE_MS), 0, 'the release was called off');
  again();
  assert.equal(time.fire('timer', RELEASE_MS), 1);
  assert.deepEqual(workers[0].posted.map((m) => m.type), ['run', 'cancel']);
  assert.equal(store.view('2310187').phase, 'idle');
  assert.equal(time.fire('timer', RELEASE_MS), 1);
  assert.equal(workers[0].terminated, true);
});

// Changed on purpose (2026-09-25): the public RPC answers 429 to every call from Cloudflare's edge, so client.ts no
// longer POSTs to the site's relay routes: it runs the relay's own reads (functions/_lib/fees.ts stateOnChain and
// logsOnChain) against the RPC itself, in the page and in the replay worker.
test('client.ts: no request in a build without the chain; the relay’s own reads against the public RPC, no credentials, no referrer; a refused request asks nothing; a failure is unavailable', async () => {
  const client = require('../.test-build/app/src/lib/fees/client.js');
  const { caseChain } = await import('./support/fees/case-chain.mjs');
  const original = globalThis.fetch;
  const sent = [];
  let chain = caseChain('3136705');
  globalThis.fetch = async (url, init) => {
    sent.push([url, init]);
    return chain.fetch(url, init);
  };
  try {
    globalThis.__DOMINO_DEPLOYABLE__ = false;
    globalThis.__DOMINO_TEST_HOOKS__ = false;
    assert.deepEqual(await client.chainState(['1']), { ok: false, failure: 'unavailable', retryAfterMs: 0 });
    assert.deepEqual(await client.chainLogs({ kind: 'transfer', tokenId: '1' }), { ok: false, failure: 'unavailable', retryAfterMs: 0 });
    assert.equal(sent.length, 0, 'fixture and bridge-test builds ask nothing');

    globalThis.__DOMINO_DEPLOYABLE__ = true;
    const fixture = loadCase('3136705');
    const state = await client.chainState(['3136705']);
    assert.equal(state.ok, true);
    // 2026-09-25: with the pool's protocol fee (slot0: 1,000 pips each way in the USDG/UFG pools), for the price path.
    const withFee = { ...fixture.state, positions: fixture.state.positions.map((p) => (p.ok ? { ...p, protocolFee: 4_097_000 } : p)) };
    assert.deepEqual(state.value, withFee, 'the recorded /state answer, rebuilt by the page from the same chain values');
    assert.equal(state.bytes, JSON.stringify(withFee).length);
    assert.deepEqual(chain.log.map((call) => call.method), ['eth_blockNumber', 'eth_call', 'eth_call']);
    for (const [url, init] of sent) {
      assert.equal(url, 'https://rpc.mainnet.chain.robinhood.com');
      assert.deepEqual({ ...init, body: undefined, signal: undefined }, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: undefined, signal: undefined, credentials: 'omit', referrerPolicy: 'no-referrer' });
    }
    const transfer = await client.chainLogs({ kind: 'transfer', tokenId: '3136705' });
    assert.deepEqual(transfer.value.units[0].logs, fixture.transfer, 'the relay’s compact logs, read by the page');

    // What the relay's route refuses is refused before any call.
    const before = sent.length;
    assert.deepEqual(await client.chainLogs({ kind: 'headers', blocks: [1, 2] }), { ok: false, failure: 'bad_request', retryAfterMs: 0 });
    assert.deepEqual(await client.chainState([]), { ok: false, failure: 'bad_request', retryAfterMs: 0 });
    assert.equal(sent.length, before);
    // An RPC that fails, or answers what the relay cannot take, is unavailable.
    chain = { fetch: async () => new Response('', { status: 500 }) };
    assert.deepEqual(await client.chainState(['3136705']), { ok: false, failure: 'unavailable', retryAfterMs: 5000 });
    chain = { fetch: async () => new Response('<!doctype html>', { status: 200 }) };
    assert.equal((await client.chainLogs({ kind: 'transfer', tokenId: '1' })).failure, 'unavailable');
    const controller = new AbortController();
    controller.abort();
    const asked = sent.length;
    assert.equal((await client.chainState(['3136705'], controller.signal)).failure, 'unavailable', 'a dropped read');
    assert.equal(sent.length, asked, 'makes no call');
  } finally {
    globalThis.fetch = original;
    delete globalThis.__DOMINO_DEPLOYABLE__;
    delete globalThis.__DOMINO_TEST_HOOKS__;
  }
});

// 2026-09-25: the fees history through the page's own chain reads, end to end: the relay's reads run by client.ts
// against a chain rebuilt from each recording, the worker's pipeline on them. The chart is drawn only when the replay
// equals the chain's unclaimed fees; a chain that owes one unit more is a mismatch, and nothing is drawn.
test('the page’s own chain reads rebuild each recorded history exactly, and a chain that disagrees with the replay is a mismatch', async () => {
  const client = require('../.test-build/app/src/lib/fees/client.js');
  const { caseChain } = await import('./support/fees/case-chain.mjs');
  const { stateOf } = require('../.test-build/app/src/lib/fees/store.js');
  const original = globalThis.fetch;
  globalThis.__DOMINO_DEPLOYABLE__ = true;
  const relay = require('../.test-build/app/functions/_lib/fees.js');
  // The logs as the replay worker reads them (logs.ts with its own chain code, the price path's reads included).
  const { logsWith } = require('../.test-build/app/src/lib/fees/logs.js');
  const { chainDeps, memoryCache } = require('../.test-build/app/src/lib/chain/browser.js');
  const { pathLogsOnChain } = require('../.test-build/app/functions/_lib/feesPath.js');
  const code = { chainDeps, logsOnChain: relay.logsOnChain, pathLogsOnChain };
  const through = async (chain) => {
    // One chain per recording, each at its own head: nothing read for another may be reused.
    relay.resetRelayMemory();
    client.forgetChainMemory();
    globalThis.fetch = (url, init) => chain.fetch(url, init);
    const answer = await client.chainState([chain.id]);
    assert.equal(answer.ok, true);
    const { state, growth } = stateOf(answer.value.positions[0], answer.value.block, answer.value.timestamp);
    const cache = memoryCache();
    return runPipeline({ logs: (request) => logsWith(code, cache, request), sleep: async () => {} }, { id: chain.id, state, growth, budgetBytes: 64 * 1024 * 1024, checkpoint: null });
  };
  try {
    for (const id of ['3136705', '2310187', '3165100', '3135288']) {
      const fixture = loadCase(id);
      // The exact replay of each recorded pool history (a probe that sees none of it: see case-chain.mjs quietProbe).
      const result = await through(caseChain(id, { quietProbe: true }));
      // Changed on purpose (2026-09-25): 3165100's pool swapped 908 times in its last hour, more than the page's probe
      // may read (functions/_lib/fees.ts PROBE_BYTES): its history, 10.9 MB, is never read in a browser, whatever the budget.
      // 2026-09-25, later: the probe then leads to the price path (its own settlements, the Swap before its mint), whose
      // exact read of the life is past PATH_REFINE_BYTES at that rate; with no estimate asked for, it stops there.
      if (id === '3165100') {
        assert.deepEqual([result.ok, result.reason], [false, 'too_much_history'], id);
        continue;
      }
      assert.equal(result.ok, fixture.expect.ok, `${id}: ${result.reason}`);
      if (!result.ok) continue;
      assert.deepEqual(result.history.earned.map(String), fixture.expect.earned, id);
      assert.deepEqual(result.history.collected.map(String), fixture.expect.collected, id);
      assert.equal(result.history.checks.swaps, fixture.expect.checks.swaps, id);
    }
    const off = await through(caseChain('3136705', { quietProbe: true, edit: (p) => ({ ...p, feeGrowthInside0X128: String(BigInt(p.feeGrowthInside0X128) + (1n << 128n) / BigInt(p.liquidity) + 1n) }) }));
    assert.deepEqual([off.ok, off.reason], [false, 'replay_mismatch']);
  } finally {
    globalThis.fetch = original;
    delete globalThis.__DOMINO_DEPLOYABLE__;
  }
});

test('the test servers\u2019 fees answers: every position not_found by default; the recorded route verifies end to end', async () => {
  const { feesDefault, feesFixtureRoute } = await import('./support/fees/stub.mjs');
  const client = require('../.test-build/app/src/lib/fees/client.js');
  const ask = (route, path, body) => route(new Request(`http://test${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
  const none = await ask(feesDefault, '/api/fees/v1/state', { tokenIds: ['3135288', '42'] });
  assert.deepEqual(await none.json(), { v: 1, block: 1, timestamp: 1, positions: [{ tokenId: '3135288', ok: false, reason: 'not_found' }, { tokenId: '42', ok: false, reason: 'not_found' }] });
  assert.equal((await ask(feesDefault, '/api/fees/v1/state', { tokenIds: [] })).status, 400);
  assert.equal((await ask(feesDefault, '/api/fees/v1/logs', { kind: 'transfer', tokenId: '1' })).status, 502, 'an unexpected /logs is loud');
  assert.equal(await feesDefault(new Request('http://test/api/owned/v2/positions', { method: 'POST', body: '{}' })), undefined);

  const route = feesFixtureRoute(['3136705']);
  const toAnswer = async (response, check) => {
    const text = await response.text();
    const value = JSON.parse(text);
    assert.ok(check(value), text.slice(0, 120));
    return { ok: true, value, bytes: text.length };
  };
  const service = { postState: async (ids) => toAnswer(await ask(route, '/api/fees/v1/state', { tokenIds: ids }), client.isStateResponse) };
  const relay = { logs: async (request) => toAnswer(await ask(route, '/api/fees/v1/logs', request), (value) => client.isLogsResponse(value, request.kind)) };
  const { store } = storeWith({ service, relays: { 3136705: relay } });
  const stop = store.subscribeHistory(['3136705'], 'page', () => {});
  await until(() => store.view('3136705').phase === 'verified', 'verified through the route');
  stop();
});

// 2026-09-25: a busy pool's history is drawn estimated first (the worker's `estimate` message, pipeline.ts P2), then
// exact. The estimate stays when the exact read runs out of its budget, its time or the RPC's patience; only a replay
// that disagrees with the chain takes it down; and it never takes the place of a verified history.
test('an estimate is shown until the exact history verifies; it stays past a budget or a failed read; a mismatch takes it down', async () => {
  const fixture = loadCase('3136705');
  const { state, growth } = stateOfCase(fixture);
  const verified = await runPipeline({ logs: fixtureRelay(fixture).logs, sleep: async () => {} }, { id: '3136705', state, growth, budgetBytes: BUDGET_BYTES.page, checkpoint: null });
  assert.equal(verified?.ok, true);
  const estimate = { type: 'estimate', id: '3136705', history: verified.history, prices: verified.prices };
  /** A store whose worker only records what it is asked; the test answers for it. */
  const scripted = () => {
    const workers = [];
    const { store } = storeWith({
      spawn: () => {
        const worker = { posted: [], onmessage: null, onerror: null, onmessageerror: null, terminated: false, postMessage(message) { this.posted.push(structuredClone(message)); }, terminate() { this.terminated = true; } };
        workers.push(worker);
        return worker;
      },
    });
    const send = (message) => workers[0].onmessage?.({ data: structuredClone(message) });
    return { store, workers, send };
  };

  for (const [reason, stays] of [['too_much_history', true], ['rpc_unavailable', true], ['replay_mismatch', false]]) {
    const { store, workers, send } = scripted();
    const stop = store.subscribeHistory(['3136705'], 'page', () => {});
    await until(() => workers[0]?.posted.some((m) => m.type === 'run'), 'the run');
    send(estimate);
    assert.equal(store.view('3136705').phase, 'estimated', 'the estimate is drawn at once');
    assert.equal(store.view('3136705').history.earned[0], verified.history.earned[0]);
    send({ type: 'done', id: '3136705', result: { ok: false, reason, prices: null, checkpoint: null, bytes: 1 } });
    assert.equal(store.view('3136705').phase, stays ? 'estimated' : 'unclaimed-only', `after ${reason}`);
    stop();
  }

  // The exact history replaces the estimate; a later estimate never replaces a verified one.
  const { store, workers, send } = scripted();
  const stop = store.subscribeHistory(['3136705'], 'page', () => {});
  await until(() => workers[0]?.posted.some((m) => m.type === 'run'), 'the run');
  send(estimate);
  send({ type: 'done', id: '3136705', result: verified });
  assert.equal(store.view('3136705').phase, 'verified');
  send(estimate);
  assert.equal(store.view('3136705').phase, 'verified', 'an estimate after it changes nothing');
  stop();
});

// ---------------------------------------------------------------------------
// 2026-09-25 (review of r4/fees): no run is asked again at once after a stop, and an estimate follows the chain.
// ---------------------------------------------------------------------------

/** A store whose worker only records what it is asked (the test answers for it), over a /state the test edits. */
function scriptedStore() {
  const fixture = loadCase('3136705');
  const workers = [];
  const chain = { bump: 0, unclaimed: null };
  const service = {
    async postState() {
      const p = fixture.state.positions[0];
      const position = { ...p, ...(chain.unclaimed ? { unclaimed0: String(chain.unclaimed[0]), unclaimed1: String(chain.unclaimed[1]) } : {}) };
      return { ok: true, value: { v: 1, block: fixture.state.block + chain.bump, timestamp: fixture.state.timestamp + Math.round(chain.bump / 10), positions: [position] }, bytes: 100 };
    },
  };
  const time = clock();
  const store = createFeesStore({
    spawn: () => {
      const worker = { posted: [], onmessage: null, onerror: null, onmessageerror: null, terminated: false, postMessage(message) { this.posted.push(structuredClone(message)); }, terminate() { this.terminated = true; } };
      workers.push(worker);
      return worker;
    },
    postState: (ids) => service.postState(ids),
    later: time.later,
    timer: time.timer,
  });
  const send = (message) => workers[0].onmessage?.({ data: structuredClone(message) });
  const runs = () => (workers[0]?.posted ?? []).filter((m) => m.type === 'run');
  /** The next minute's /state read, `bump` blocks past the recorded one. */
  const minute = async (bump) => {
    chain.bump = bump;
    assert.equal(time.fire('later'), 1, 'one refresh pending');
    for (let i = 0; i < 20; i++) await settle();
  };
  return { fixture, store, chain, send, runs, minute };
}

async function verifiedResult() {
  const fixture = loadCase('3136705');
  const { state, growth } = stateOfCase(fixture);
  const verified = await runPipeline({ logs: fixtureRelay(fixture).logs, sleep: async () => {} }, { id: '3136705', state, growth, budgetBytes: BUDGET_BYTES.page, checkpoint: null });
  assert.equal(verified?.ok, true);
  return verified;
}

test('a verified history whose later run stops at its budget keeps its chart and waits for a newer block, three times at most', async () => {
  const verified = await verifiedResult();
  const { store, send, runs, minute } = scriptedStore();
  const stop = store.subscribeHistory(['3136705'], 'page', () => {});
  await until(() => runs().length === 1, 'the first run');
  send({ type: 'done', id: '3136705', result: verified });
  const chart = store.view('3136705');
  assert.equal(chart.phase, 'verified');
  // The tab comes back after a night: a much newer block, whose run stops at the page's budget with nothing kept.
  const stopped = { type: 'done', id: '3136705', result: { ok: false, reason: 'too_much_history', prices: null, checkpoint: null, bytes: BUDGET_BYTES.page } };
  for (const [k, bump] of [[1, 600_000], [2, 600_010], [3, 600_020]]) {
    await minute(bump);
    assert.equal(runs().length, 1 + k, `the newer block ${bump} asks once`);
    send(stopped);
    for (let i = 0; i < 20; i++) await settle();
    assert.equal(runs().length, 1 + k, 'never again at once');
    assert.equal(store.view('3136705'), chart, 'the chart stays');
    await minute(bump);
    assert.equal(runs().length, 1 + k, 'the same block asks nothing');
  }
  await minute(600_030);
  assert.equal(runs().length, 4, 'three stops without progress: no fourth run this visit');
  assert.equal(store.view('3136705'), chart);
  stop();
});

test('a price path’s read that ran out of its run’s budget keeps its place: the next newer block goes on from it, not at once', async () => {
  const verified = await verifiedResult();
  const { store, send, runs, minute } = scriptedStore();
  const stop = store.subscribeHistory(['3136705'], 'page', () => {});
  await until(() => runs().length === 1, 'the first run');
  send({ type: 'done', id: '3136705', result: verified });
  await minute(600_000);
  assert.equal(runs().length, 2);
  const place = verified.checkpoint;
  send({ type: 'done', id: '3136705', result: { ok: false, reason: 'too_much_history', prices: null, checkpoint: place, bytes: BUDGET_BYTES.page, later: true } });
  for (let i = 0; i < 20; i++) await settle();
  assert.equal(runs().length, 2, 'not at once');
  assert.equal(store.view('3136705').phase, 'verified');
  await minute(600_010);
  assert.equal(runs().length, 3, 'the next newer block goes on');
  assert.deepEqual(runs()[2].checkpoint, place, 'from the place kept');
  send({ type: 'done', id: '3136705', result: verified });
  assert.equal(store.view('3136705').phase, 'verified');
  stop();
});

test('an estimate whose exact read stopped follows every newer /state; after a Collect the card shows the new figures, quiet', async () => {
  const verified = await verifiedResult();
  const { fixture, store, send, runs, minute, chain } = scriptedStore();
  const stop = store.subscribeHistory(['3136705'], 'page', () => {});
  await until(() => runs().length === 1, 'the first run');
  send({ type: 'estimate', id: '3136705', history: verified.history, prices: verified.prices });
  send({ type: 'done', id: '3136705', result: { ok: false, reason: 'too_much_history', prices: null, checkpoint: null, bytes: 1 } });
  assert.equal(store.view('3136705').phase, 'estimated');
  const p = fixture.state.positions[0];
  const before = [BigInt(p.unclaimed0), BigInt(p.unclaimed1)];
  // Ten minutes of newer blocks (6,000 each, past an hour's end), the fees growing: the estimate's end follows them.
  for (let k = 1; k <= 10; k++) {
    chain.unclaimed = [before[0] + BigInt(k) * 1_000_000n, before[1] + BigInt(k) * 10n ** 15n];
    await minute(6_000 * k);
    const view = store.view('3136705');
    assert.equal(view.phase, 'estimated', `minute ${k}`);
    assert.equal(view.state.block, fixture.state.block + 6_000 * k);
    assert.deepEqual(view.history.earned, chain.unclaimed, 'the end is the chain’s figures');
    assert.deepEqual(view.history.hourly.at(-1).earned, chain.unclaimed);
    assert.equal(view.history.hourly.at(-1).t, view.state.timestamp);
    assert.equal(view.history.hourly.at(-1).anchor, Math.floor(view.state.block / 36_000));
    for (let i = 1; i < view.history.hourly.length; i++) {
      const [a, b] = [view.history.hourly[i - 1], view.history.hourly[i]];
      assert.ok(b.anchor === a.anchor + 1 && b.t >= a.t && b.earned[0] >= a.earned[0] && b.earned[1] >= a.earned[1], `hour ${i} of minute ${k}`);
    }
  }
  assert.equal(runs().length, 1, 'no run: the estimate is carried, nothing read');
  // The owner's Collect: Position detail reads /state again at once; nothing is unclaimed now.
  chain.unclaimed = [0n, 0n];
  chain.bump = 60_050;
  store.refresh(['3136705']);
  for (let i = 0; i < 20; i++) await settle();
  const after = store.view('3136705');
  assert.deepEqual([after.phase, after.state.block, after.state.unclaimed], ['unclaimed-only', fixture.state.block + 60_050, [0n, 0n]], 'the quiet card with the chain’s new figures');
  assert.equal(runs().length, 1);
  stop();
});

test('an estimate drawn for an older state is carried to the state read since its run began, or gives way to the quiet card', async () => {
  const verified = await verifiedResult();
  for (const collected of [false, true]) {
    const { fixture, store, send, runs, minute, chain } = scriptedStore();
    const stop = store.subscribeHistory(['3136705'], 'page', () => {});
    await until(() => runs().length === 1, 'the first run');
    const p = fixture.state.positions[0];
    chain.unclaimed = collected ? [0n, 0n] : [BigInt(p.unclaimed0) + 5n, BigInt(p.unclaimed1) + 5n];
    await minute(700);
    assert.equal(store.view('3136705').phase, 'loading');
    send({ type: 'estimate', id: '3136705', history: verified.history, prices: verified.prices });
    const view = store.view('3136705');
    assert.equal(view.state.block, fixture.state.block + 700);
    assert.equal(view.phase, collected ? 'unclaimed-only' : 'estimated');
    if (!collected) assert.deepEqual(view.history.earned, chain.unclaimed);
    stop();
  }
});

test('carriedEstimate: the same view for an older block; null when the liquidity or the range changed or an amount fell', async () => {
  const { carriedEstimate } = require('../.test-build/app/src/lib/fees/store.js');
  const verified = await verifiedResult();
  const { state } = stateOfCase(loadCase('3136705'));
  const view = { phase: 'estimated', state, history: verified.history, prices: verified.prices };
  assert.equal(carriedEstimate(view, { ...state, block: state.block - 1 }), view);
  assert.equal(carriedEstimate(view, state), view);
  const newer = { ...state, block: state.block + 10, timestamp: state.timestamp + 1 };
  assert.equal(carriedEstimate(view, { ...newer, liquidity: state.liquidity + 1n }), null);
  assert.equal(carriedEstimate(view, { ...newer, tickLower: state.tickLower - 1 }), null);
  assert.equal(carriedEstimate(view, { ...newer, unclaimed: [state.unclaimed[0] - 1n, state.unclaimed[1]] }), null);
  const same = carriedEstimate(view, newer);
  assert.equal(same.history.hourly.length, verified.history.hourly.length, 'the same hour: its end moves');
  assert.equal(same.history.hourly.at(-1).t, newer.timestamp);
});
