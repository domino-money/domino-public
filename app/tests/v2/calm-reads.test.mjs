/**
 * Added 2026-10-15 (pack 7, calm reads): an idle open tab asks less, and nothing after the person's own action changes.
 * Every case counts requests on a fake clock, against what main (e84abedb) sends in the same path.
 *
 * - The read-v6 capabilities: a probe keeps an answer that the read route is on five minutes (it was one), unless a read
 *   of the route is refused as not there (404 / 405): then that answer is kept no longer than its minute, as before.
 *   Everything else the probe keeps (a route that is off, the plan and crosschain routes) keeps its minute.
 * - The read-v1/v3 capabilities (lib/read/bridgeSource.ts): the same five minutes for an answer that lists routes; a read
 *   refused as `route_not_available` brings it back to its minute.
 * - The activity head: two minutes apart, not one, while the tab is idle (nothing happened in this browser, every chain
 *   current, every receipt final, no catch-up page due). Anything at all puts it back on main's pace for good.
 * - Hidden tabs read nothing; coming back reads once what fell due.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import * as runtimeV6 from '../../../api-contracts/read-v6/runtime.mjs';
import * as runtimeV1 from '../../../api-contracts/read-v1/runtime.mjs';

const require = createRequire(import.meta.url);
const routes = require('../../.test-build/app/src/v2/routes.js');
const data = require('../../.test-build/app/src/v2in/dataSource.js');
const read = require('../../.test-build/app/src/v2in/lists/read.js');
const { createActivityHistory } = require('../../.test-build/app/src/v2in/lists/activityHistory.js');
const activityModel = require('../../.test-build/app/src/v2in/lists/activityModel.js');
const { createBridgeSource } = require('../../.test-build/app/src/lib/read/bridgeSource.js');

const CONTRACTS = resolve(import.meta.dirname, '../../../api-contracts');
const v6 = (name) => JSON.parse(readFileSync(join(CONTRACTS, 'read-v6', 'fixtures', 'valid', name), 'utf8'));
const v1 = (name) => JSON.parse(readFileSync(join(CONTRACTS, 'read-v1', 'fixtures', 'gateway', `${name}.json`), 'utf8'));
const flush = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
const MIN = 60_000;

// ---------------------------------------------------------------------------
// The read-v6 capabilities
// ---------------------------------------------------------------------------

const CAPS = {
  readV6: { contractVersion: routes.V2_ROUTE_SPECS.readV6.version, dataMode: 'live_read_only', chainIds: [4663, 8453, 42161], enabledReads: ['portfolio', 'activity'], walletAuthentication: false, privateAccounts: false, ownerTransactions: false, automation: false },
  readV6Off: { contractVersion: routes.V2_ROUTE_SPECS.readV6.version, dataMode: 'disabled', chainIds: [4663, 8453, 42161], enabledReads: [], walletAuthentication: false, privateAccounts: false, ownerTransactions: false, automation: false },
  plan: { contractVersion: routes.V2_ROUTE_SPECS.plan.version, dataMode: 'live', enabledRoutes: ['plan'] },
  crosschain: { contractVersion: routes.V2_ROUTE_SPECS.crosschain.version, dataMode: 'live', enabledRoutes: ['origins', 'quote', 'status'] },
};
const reply = (route, body) => ({ kind: 'reply', reply: { status: 200, opaqueRedirect: false, contentType: 'application/json', contractHeader: routes.V2_ROUTE_SPECS[route].version, requestIdHeader: null, retryAfterHeader: null, body: { kind: 'text', text: JSON.stringify(body) } } });

/** A probe over a fake GET and clock; `gets` lists each capabilities GET as [route, ms]. */
function probeOn(answers = {}) {
  let now = 0;
  const gets = [];
  const probe = routes.createV2RouteProbe({ now: () => now, get: async (path) => {
    const route = Object.keys(routes.V2_ROUTE_SPECS).find((name) => routes.V2_ROUTE_SPECS[name].path === path);
    gets.push([route, now]);
    return reply(route, (answers[route] ?? (() => CAPS[route]))());
  } });
  return { probe, gets, at: (ms) => { now = ms; }, now: () => now };
}

test('the read route said on is kept five minutes; off, the plan and crosschain routes keep their minute', async () => {
  const { probe, gets, at } = probeOn();
  for (let ms = 0; ms <= 10 * MIN; ms += 30_000) { at(ms); await probe.state('readV6'); await probe.state('plan'); await probe.state('crosschain'); }
  const of = (route) => gets.filter(([name]) => name === route).map(([, ms]) => ms / 1000);
  assert.deepEqual(of('readV6'), [0, 300, 600], 'read-v6 on: once per five minutes (main: every minute, 11 GETs)');
  assert.deepEqual(of('plan'), [0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600], 'the plan route: its minute, as main');
  assert.deepEqual(of('crosschain'), of('plan'), 'the crosschain route: its minute, as main');
  const off = probeOn({ readV6: () => CAPS.readV6Off });
  for (let ms = 0; ms <= 3 * MIN; ms += 30_000) { off.at(ms); await off.probe.state('readV6'); }
  assert.deepEqual(off.gets.map(([, ms]) => ms / 1000), [0, 60, 120, 180], 'a route that is off is asked again each minute, as main: a route switched on is seen as soon as before');
});

test('a read refused as not there brings the kept answer back to its minute, never sooner than main asks', async () => {
  const { probe, gets, at } = probeOn();
  at(0); await probe.state('readV6');
  at(20_000); probe.shorten('readV6');
  at(59_999); await probe.state('readV6');
  assert.equal(gets.length, 1, 'still inside the minute of its answer: nothing asked');
  at(60_000); await probe.state('readV6');
  assert.deepEqual(gets.map(([, ms]) => ms), [0, 60_000], 'asked again a minute after its answer, as main');
  // A shorten with nothing kept, or long after, asks nothing by itself.
  at(400_000); probe.shorten('readV6'); probe.shorten('plan');
  assert.equal(gets.length, 2);
});

/** The lists' source over the real probe, a fake read route and a fake clock: `posted` has each POST as [route, ms]. */
function listsOver(status = () => 200) {
  const p = probeOn();
  const posted = [];
  const portfolio = v6('portfolio.json');
  const transports = data.createV2ReadTransports({
    runtimes: { read: runtimeV6, plan: {} },
    live: () => ({
      read: { kind: 'http', post: async (route) => {
        posted.push([route, p.now()]);
        const code = status(p.now());
        return code === 200 ? { status: 200, body: portfolio } : code === 404 ? { status: 404, body: { error: 'route_not_available' } } : { status: 405, body: { error: 'method_not_allowed' } };
      } },
      plan: { kind: 'http', plan: async () => ({ status: 503, body: {} }) },
      probe: p.probe,
    }),
    script: () => null,
  });
  return { ...p, posted, source: read.createListsReads(async () => ({ live: transports })), wallet: portfolio.wallet };
}

test('an idle list reading its portfolio every 30 s asks the read-v6 capabilities once per five minutes (main: each minute)', async () => {
  const lists = listsOver();
  for (let ms = 0; ms < 10 * MIN; ms += 30_000) { lists.at(ms); assert.equal((await lists.source.ownPortfolio(lists.wallet)).kind, 'ok'); }
  assert.equal(lists.posted.length, 20, 'every portfolio read is sent, as main');
  assert.deepEqual(lists.gets.map(([, ms]) => ms / 1000), [0, 300], 'two capabilities GETs in ten minutes; main sends ten');
});

test('a portfolio read refused 404 or 405 keeps the capabilities answer no longer than its minute', async () => {
  for (const code of [404, 405]) {
    const lists = listsOver((ms) => (ms === 30_000 ? code : 200));
    for (let ms = 0; ms <= 3 * MIN; ms += 30_000) { lists.at(ms); await lists.source.ownPortfolio(lists.wallet); }
    assert.deepEqual(lists.gets.map(([, ms]) => ms / 1000), [0, 60], `${code}: asked again at the minute of its answer, as main would; kept five minutes after that good answer`);
  }
});

// ---------------------------------------------------------------------------
// The read-v1/v3 capabilities
// ---------------------------------------------------------------------------

function bridgeOver(answer = () => 200) {
  let steady = 0;
  const wire = [];
  const token = v1('token.success');
  const caps = v1('capabilities.live_read_only');
  const fetch = async (path, init) => {
    wire.push([init.method, path.replace('/api/read/v1/', ''), steady]);
    const status = init.method === 'GET' ? 200 : answer(steady);
    const body = init.method === 'GET' ? caps : status === 200 ? token : { error: 'route_not_available' };
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Domino-Read-Contract': runtimeV1.CONTRACT_VERSION } });
  };
  const clock = { now: () => steady, monotonic: () => steady, random: () => 0, timer: () => () => {}, sleep: async () => {} };
  const source = createBridgeSource({ enabled: true, validators: runtimeV1, fetch, clock });
  return { source, wire, at: (ms) => { steady = ms; }, request: { token: token.asset.address } };
}

test('read-v1/v3: a read each minute asks the capabilities once per five minutes (main: once per read past its minute)', async () => {
  const bridge = bridgeOver();
  for (let ms = 0; ms <= 10 * MIN; ms += MIN) { bridge.at(ms); assert.equal((await bridge.source.read('token', bridge.request)).state, 'ok'); await flush(); }
  const gets = bridge.wire.filter(([method]) => method === 'GET').map(([, , ms]) => ms / 1000);
  assert.deepEqual(gets, [0, 300, 600], 'three GETs in ten minutes; main sends eleven');
  assert.equal(bridge.wire.filter(([method]) => method === 'POST').length, 11, 'every read is sent, as main');
});

test('read-v1/v3: a read refused route_not_available keeps the capabilities answer no longer than its minute', async () => {
  const bridge = bridgeOver((ms) => (ms === 30_000 ? 404 : 200));
  for (let ms = 0; ms <= 2 * MIN; ms += 30_000) { bridge.at(ms); await bridge.source.read('token', bridge.request); await flush(); }
  const gets = bridge.wire.filter(([method]) => method === 'GET').map(([, , ms]) => ms / 1000);
  assert.deepEqual(gets, [0, 60], 'asked again a minute after its answer, as main');
});

// ---------------------------------------------------------------------------
// The activity head
// ---------------------------------------------------------------------------

const activity = v6('activity.json');
const wallet = activity.wallet;
const CURRENT = activity.chains.map((chain) => ({ ...chain, status: 'current', reason: null }));
const item = (n, finality = 'finalized') => ({ ...structuredClone(activity.items[0]), id: `4663:${n}:1`, chainId: 4663,
  tx: { ...structuredClone(activity.items[0].tx), hash: `0x${n.toString(16).padStart(64, '0')}`, snapshot: { number: n, hash: `0x${n.toString(16).padStart(64, '0')}`, timestamp: n }, finality } });
const page = (extra = {}) => ({ kind: 'ok', body: { ...structuredClone(activity), items: [item(30), item(29)], nextCursor: null, coverage: 'complete', chains: CURRENT, ...extra } });

function clock() {
  let now = 0, visible = true;
  const jobs = new Set(), wake = new Set();
  return {
    now: () => now,
    timers: { now: () => now, set(fn, ms) { const job = { fn, at: now + ms }; jobs.add(job); return job; }, clear(job) { jobs.delete(job); }, visible: () => visible,
      onVisible(fn) { wake.add(fn); return () => wake.delete(fn); } },
    async to(ms) {
      for (;;) {
        const next = [...jobs].filter((job) => job.at <= ms).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        now = Math.max(now, next.at); jobs.delete(next); next.fn(); await flush();
      }
      now = ms; await flush();
    },
    show(next) { visible = next; if (next) for (const fn of [...wake]) { wake.delete(fn); fn(); } },
  };
}

/** Main's history and this pack's, side by side in the same world: `events` happen at their times to both. */
async function sideBySide({ answer = () => page(), idle = () => true, events = [], until = 15 * MIN }) {
  const worlds = [];
  for (const calm of [false, true]) {
    const time = clock(), reads = [];
    const history = createActivityHistory(async (_, request) => { reads.push(time.now()); return answer(time.now(), request); }, time.timers, true, () => undefined, calm ? idle : undefined);
    worlds.push({ time, reads, history, stop: history.subscribe(wallet, () => {}) });
  }
  await flush();
  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    for (const world of worlds) { await world.time.to(event.at); event.run(world.history, world.time); await flush(); }
  }
  for (const world of worlds) { await world.time.to(until); world.stop(); }
  return { main: worlds[0].reads, calm: worlds[1].reads };
}
const seconds = (reads) => reads.map((ms) => ms / 1000);
/** At no second has the pack read more than main. */
function neverMore(main, calm, label) {
  for (let s = 0; s <= 1800; s++) {
    const a = calm.filter((ms) => ms <= s * 1000).length, b = main.filter((ms) => ms <= s * 1000).length;
    assert.ok(a <= b, `${label}: ${a} reads by ${s} s, main ${b}`);
  }
}

test('an idle visible tab reads the activity head two minutes apart (main: one minute)', async () => {
  const { main, calm } = await sideBySide({ until: 10 * MIN });
  assert.deepEqual(seconds(calm), [0, 120, 240, 360, 480, 600]);
  assert.equal(main.length, 11);
  neverMore(main, calm, 'idle');
});

test('anything that happened puts the head back on main\'s pace for good, the after-action reads unchanged', async () => {
  const confirmation = { at: 150_000, run: (history) => history.refresh(wallet, { chainId: 4663, block: 40 }) };
  // The index lists the step at 170 s.
  const answer = (ms) => page(ms >= 170_000 ? { chains: CURRENT.map((chain) => ({ ...chain, indexedThrough: { ...chain.indexedThrough, number: 40 } })) } : { chains: CURRENT.map((chain) => ({ ...chain, indexedThrough: { ...chain.indexedThrough, number: 30 } })) });
  for (const [label, event] of [['a confirmed step', confirmation], ['a change with no block', { at: 150_000, run: (history) => history.refresh(wallet) }], ['a change for every wallet', { at: 150_000, run: (history) => history.refresh() }]]) {
    const { main, calm } = await sideBySide({ answer, events: [event] });
    const after = (reads) => seconds(reads.filter((ms) => ms >= 150_000));
    assert.deepEqual(after(calm), after(main), `${label}: from the moment it happened, every read as main`);
    assert.equal(after(calm)[0], 150, `${label}: read at once`);
    neverMore(main, calm, label);
  }
});

test('the head keeps main\'s minute unless every chain is current, every receipt final, no page is due and the wallet is quiet', async () => {
  const cases = [
    ['a chain behind', () => page({ chains: CURRENT.map((chain, i) => (i === 1 ? { ...chain, status: 'stale', reason: 'head_not_observed_recently' } : chain)) }), () => true],
    ['a chain out', () => page({ chains: CURRENT.map((chain, i) => (i === 2 ? { ...chain, status: 'unavailable', reason: 'deployment_not_registered' } : chain)) }), () => true],
    ['a receipt not final yet', () => page({ items: [item(30, 'unfinalized'), item(29)] }), () => true],
    ['the wallet not quiet (an operation of this browser, a created position, an unproven close, another tab\'s action)', () => page(), () => false],
  ];
  for (const [label, answer, idle] of cases) {
    const { main, calm } = await sideBySide({ answer, idle, until: 5 * MIN });
    assert.deepEqual(seconds(calm), seconds(main), label);
    assert.deepEqual(seconds(calm), [0, 60, 120, 180, 240, 300], label);
  }
});

test('the quiet predicate sees the items the head holds, and the head\'s own answer decides each period', async () => {
  const seen = [];
  const { calm } = await sideBySide({ idle: (who, items) => { seen.push([who, items.length]); return true; }, until: 2 * MIN });
  assert.deepEqual(seconds(calm), [0, 120]);
  assert.deepEqual(seen[0], [wallet, 2]);
});

test('failures, Retry-After, wakes and a hidden tab never make the idle head read more than main', async () => {
  // Busy from 130 s to 200 s with a 45 s Retry-After, then good again.
  const answer = (ms) => (ms >= 130_000 && ms < 200_000 ? { kind: 'unavailable', reason: 'read_capacity_busy', retryAfterSeconds: 45 } : page());
  const wakes = [70_000, 125_000, 250_000, 300_000, 480_000].map((at) => ({ at, run: (history) => history.wake() }));
  const hidden = [{ at: 500_000, run: (_, time) => time.show(false) }, { at: 800_000, run: (_, time) => time.show(true) }];
  const { main, calm } = await sideBySide({ answer, events: [...wakes, ...hidden], until: 20 * MIN });
  neverMore(main, calm, 'failures, wakes and a hidden tab');
  assert.ok(!calm.some((ms) => ms > 500_000 && ms < 800_000), 'nothing read while hidden');
  assert.ok(calm.includes(800_000), 'shown again past its period: read once at once');
  assert.ok(!seconds(calm).some((s) => s > 70 && s < 120), 'a wake inside the idle period reads nothing');
});

test('activityModel.quietWallet: quiet only with nothing of this browser\'s own about the wallet', () => {
  const close = { wallet, chainId: 8453, positionManager: '0x03a520b32c04bf3beef7beb72e919cf822ed34f1', dex: 3, hash: `0x${'a'.repeat(64)}`, block: 9, blockHash: `0x${'b'.repeat(64)}`, tokenIds: ['7'], amounts: [], at: null, state: 'included' };
  const base = { operations: [], created: 0, local: [], ownActionAt: null, now: 10 * MIN };
  assert.equal(activityModel.quietWallet(wallet, [], base), true);
  assert.equal(activityModel.quietWallet(wallet, [], { ...base, operations: [{ wallet: wallet.toUpperCase().replace('0X', '0x') }] }), false, 'an operation this browser sent');
  assert.equal(activityModel.quietWallet(wallet, [], { ...base, operations: [{ wallet: `0x${'9'.repeat(40)}` }] }), true, 'another wallet\'s operation');
  assert.equal(activityModel.quietWallet(wallet, [], { ...base, created: 1 }), false, 'a created position not yet listed');
  assert.equal(activityModel.quietWallet(wallet, [], { ...base, local: [close] }), false, 'a close the index has not proven');
  assert.equal(activityModel.quietWallet(wallet, [], { ...base, ownActionAt: 10 * MIN - 1_000 }), false, 'an action of this browser\'s, in any tab, ten minutes ago or less');
  assert.equal(activityModel.quietWallet(wallet, [], { ...base, ownActionAt: 0 }), true, 'more than ten minutes ago');
});

// (2026-10-15, pack 7 review): an action in another tab of this browser. Its note in this browser's storage makes the
// quiet predicate say no (activityModel.ts quietWallet `ownActionAt`), and activity.tsx hears the storage event and calls
// calm(): the idle head goes back to main's minute at once, with no read of its own.
test('an action in another tab: a hidden idle tab shown 70 s after its last read reads at once, as main', async () => {
  let acted = false;
  const idle = () => !acted;
  const storage = { at: 30_000, run: (history) => { acted = true; history.calm(); } };
  const hide = { at: 10_000, run: (_, time) => time.show(false) };
  const show = { at: 70_000, run: (history, time) => { time.show(true); history.wake(); } };
  const { main, calm } = await sideBySide({ idle, events: [hide, storage, show], until: 5 * MIN });
  assert.deepEqual(seconds(calm).slice(0, 2), [0, 70], 'read at once when shown, 70 s after its last read');
  assert.deepEqual(seconds(calm), seconds(main), 'every read as main from then on (the predicate now says not quiet)');
  neverMore(main, calm, 'another tab\'s action, hidden');
});

test('an action in another tab: the storage event alone reads nothing; the head is then due a minute after its last read', async () => {
  let acted = false;
  const { main, calm } = await sideBySide({ idle: () => !acted, events: [{ at: 30_000, run: (history) => { acted = true; history.calm(); } }], until: 3 * MIN });
  assert.ok(!calm.includes(30_000), 'nothing read at the storage event');
  assert.deepEqual(seconds(calm), [0, 60, 120, 180], 'due a minute after its last read, as main');
  assert.deepEqual(seconds(calm), seconds(main));
});

test('a wake asks the quiet predicate again: with no storage event heard, a visibility wake 70 s after the last read reads at once, as main', async () => {
  let acted = false;
  const hide = { at: 10_000, run: (_, time) => time.show(false) };
  const act = { at: 30_000, run: () => { acted = true; } };
  const show = { at: 70_000, run: (history, time) => { time.show(true); history.wake(); } };
  const { main, calm } = await sideBySide({ idle: () => !acted, events: [hide, act, show], until: 5 * MIN });
  assert.deepEqual(seconds(calm).slice(0, 2), [0, 70]);
  assert.deepEqual(seconds(calm), seconds(main));
  // Still quiet: the same wake inside the idle period reads nothing (the pack's two minutes stand).
  const quiet = await sideBySide({ idle: () => true, events: [{ at: 70_000, run: (history) => history.wake() }], until: 100_000 });
  assert.deepEqual(seconds(quiet.calm), [0]);
});

// (2026-10-15, pack 8 review, bug c): a portfolio answer that shows automation on is one wallet's (activity.tsx
// onPortfolioAnswer): only that wallet's idle head goes back to main's minute; another wallet's quiet head keeps its two.
test('a portfolio answer with automation on calms its own wallet\'s head only', async () => {
  const other = `0x${'7e'.repeat(20)}`;
  const time = clock(), reads = { [wallet]: [], [other]: [] };
  let automated = false;
  const history = createActivityHistory(async (who) => { reads[who].push(time.now()); const answer = page(); answer.body.wallet = who; return answer; },
    time.timers, true, () => undefined, (who) => who === wallet ? !automated : true);
  const stops = [history.subscribe(wallet, () => {}), history.subscribe(other, () => {})];
  await flush();
  await time.to(30_000);
  automated = true;
  history.calm(wallet);
  await flush();
  await time.to(5 * MIN);
  for (const stop of stops) stop();
  assert.deepEqual(seconds(reads[wallet]), [0, 60, 120, 180, 240, 300], 'the automated wallet: main\'s minute at once');
  assert.deepEqual(seconds(reads[other]), [0, 120, 240], 'the other wallet keeps its idle two minutes');
});
