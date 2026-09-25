/**
 * The fees history replay (src/lib/fees/replay.ts, pipeline.ts, series.ts;
 * DESIGN-V2 §15.5, §15.7), on the four validation cases of
 * spec/fees-evolution.md §3, recorded read-only from Robinhood Chain on
 * 2026-09-24 (tests/support/fees/*.json.gz): the replay of every Swap since
 * the mint must land on the chain's own unclaimed fees and fee growth bit for
 * bit, with every Swap's end tick, liquidity and fee matching.
 *
 * Added 2026-09-24 (P6, fees data).
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { CASES, fixtureRelay, loadCase, stateOfCase } from './support/fees/relay-fixture.mjs';

const require = createRequire(import.meta.url);
const { runPipeline, PROBE_WINDOWS, PROBE_SLICES } = require('../.test-build/app/src/lib/fees/pipeline.js');
const series = require('../.test-build/app/src/lib/fees/series.js');
const { FeeReplay, Timeline, sqrtAtTick } = require('../.test-build/app/src/lib/fees/replay.js');

const BIG = 64 * 1024 * 1024;
const DAY = 864_000;
const EPOCH = 3_600_000;
// 2026-09-25: the relay's probe span, beside the page's (compared in tests/fees-topics.test.mjs).
const fees = require('../.test-build/app/functions/_lib/fees.js');
const HOUR = 36_000;
const quiet = { sleep: async () => {} };

function runOf(fixture, overrides = {}) {
  const { state, growth } = stateOfCase(fixture);
  return { id: fixture.id, state, growth, budgetBytes: BIG, checkpoint: null, ...overrides };
}

async function replayed(id, relayOptions = {}, runOverrides = {}) {
  const fixture = loadCase(id);
  const relay = fixtureRelay(fixture, relayOptions);
  const run = runOf(fixture, runOverrides);
  const result = await runPipeline({ logs: relay.logs, ...quiet }, run);
  return { fixture, relay, run, result };
}

const unclaimedOf = (history) => [history.earned[0] - history.collected[0], history.earned[1] - history.collected[1]];

for (const id of CASES) {
  test(`NFT ${id}: the replay lands on the chain's unclaimed fees and fee growth bit for bit`, async () => {
    const { result, run, fixture } = await replayed(id);
    assert.equal(result?.ok, true, `not verified: ${result?.reason}`);
    const { history, prices } = result;
    // The gate itself: unclaimed equal, growth delta equal, no per-swap mismatch.
    assert.deepEqual(unclaimedOf(history), [...run.state.unclaimed]);
    assert.deepEqual(history.checks, { ...history.checks, tickMismatch: 0, liquidityMismatch: 0, swapFeeMismatch: 0, inconsistentLastStep: 0 });
    // The recorded capture printed the same figures.
    assert.deepEqual(history.earned.map(String), fixture.expect.earned);
    assert.deepEqual(history.collected.map(String), fixture.expect.collected);
    assert.equal(history.checks.swaps, fixture.expect.checks.swaps);
    // Every hour from the mint's to the state block's, cumulative, never falling.
    const first = Math.floor(history.mintedAt.block / HOUR);
    const last = Math.floor(run.state.block / HOUR);
    assert.deepEqual(history.hourly.map((hour) => hour.anchor), Array.from({ length: last - first + 1 }, (_, i) => first + i));
    for (let i = 1; i < history.hourly.length; i++) {
      const [a, b] = [history.hourly[i - 1], history.hourly[i]];
      assert.ok(b.t >= a.t, 'time goes forward');
      assert.ok(b.earned[0] >= a.earned[0] && b.earned[1] >= a.earned[1], 'earned never falls');
      assert.ok(b.collected[0] >= a.collected[0] && b.collected[1] >= a.collected[1], 'collected never falls');
    }
    const end = history.hourly[history.hourly.length - 1];
    assert.equal(end.t, run.state.timestamp);
    assert.deepEqual(end.earned, history.earned);
    assert.equal(end.sqrtPriceX96Close, run.state.sqrtPriceX96);
    assert.equal(end.tickClose, run.state.tick);
    assert.equal(history.events[0].kind, 'mint');
    assert.equal(history.events[0].block, history.mintedAt.block);
    assert.ok(history.timeInRange.inSeconds <= history.timeInRange.totalSeconds);
    assert.equal(history.hourly.reduce((sum, hour) => sum + hour.inRangeSeconds, 0), history.timeInRange.inSeconds);
    // Hourly closes come from Swaps only, from the mint's hour on.
    assert.ok(prices.hours.every((hour) => hour.anchor >= first && hour.anchor <= last));
    assert.equal(result.checkpoint !== null, true, 'a verified run keeps its place for the next state block');
  });
}

test('NFT 3135288 (the owner’s, a 79.28 % pool nobody trades): zero earned, the designed zero state is real', async () => {
  const { result } = await replayed('3135288');
  const { history, prices } = result;
  assert.deepEqual(history.earned, [0n, 0n]);
  assert.deepEqual(history.collected, [0n, 0n]);
  assert.equal(history.checks.swaps, 0);
  assert.deepEqual(prices.hours, []);
  assert.deepEqual(history.events.map((event) => event.kind), ['mint']);
  assert.ok(history.timeInRange.totalSeconds > 30 * 3600);
  assert.equal(history.timeInRange.inSeconds, history.timeInRange.totalSeconds, '100 % of the time in range');
});

test('NFT 3136705 (Domino-minted, USDG/UFG 4 %): hundreds of swaps, and flat stretches while out of range', async () => {
  const { result } = await replayed('3136705');
  const { history } = result;
  assert.ok(history.checks.swaps >= 452, `${history.checks.swaps} swaps (452 at the PoC's block)`);
  assert.deepEqual(history.collected, [0n, 0n]);
  const share = history.timeInRange.inSeconds / history.timeInRange.totalSeconds;
  assert.ok(share > 0.3 && share < 0.5, `in range ${(share * 100).toFixed(2)} %`);
  // Hours entirely out of range earn nothing: the flat stretch the in-range strip explains.
  const out = history.hourly.filter((hour) => hour.inRangeSeconds === 0);
  assert.ok(out.length >= 12, `${out.length} hours out of range`);
  for (const hour of out) {
    const i = history.hourly.indexOf(hour);
    if (i > 0) assert.deepEqual(hour.earned, history.hourly[i - 1].earned, `hour ${hour.anchor} earned while out of range`);
  }
});

test('NFT 2310187 (seven collects): every collect equals the PoolManager payout the PoC read from its receipt', async () => {
  const { result } = await replayed('2310187');
  const { history } = result;
  const paid = history.events.filter((event) => event.kind === 'collect' && (event.fees[0] > 0n || event.fees[1] > 0n));
  // spec/out-2310187.txt: "PoolManager paid out …" per collect transaction (USDG has 6 decimals).
  assert.deepEqual(paid.map((event) => event.fees[0]), [110_493716n, 116_549925n, 44_051091n, 34_557191n, 44_348263n, 47_638591n, 339_951114n]);
  assert.deepEqual(paid.map((event) => event.tx.slice(0, 10)), ['0xec9be287', '0x3648206e', '0x85e4b561', '0xd2ee9c0a', '0xd47d72a2', '0x5701d928', '0x32eb8001']);
  // The PoC's total collected: 737.589891 USDG + 286129.7612320910… UFG.
  assert.equal(history.collected[0], 737_589891n);
  assert.equal(history.collected[1] / 10n ** 8n, 286129_7612320910n);
  assert.deepEqual(history.collected, paid.reduce((sum, event) => [sum[0] + event.fees[0], sum[1] + event.fees[1]], [0n, 0n]));
  // Increases after collects settle nothing more.
  for (const event of history.events.filter((e) => e.kind === 'increase')) assert.deepEqual(event.fees, [0n, 0n]);
});

test('NFT 3165100 (WETH/USDG 0.02 %, the busiest pool): thousands of swaps, exact, 100 % in range', async () => {
  const { result } = await replayed('3165100', { maxDays: 1 });
  const { history } = result;
  assert.ok(history.checks.swaps > 12_404, `${history.checks.swaps} swaps (12,404 at the PoC's block)`);
  assert.equal(history.timeInRange.inSeconds, history.timeInRange.totalSeconds);
  assert.deepEqual(history.collected, [0n, 0n]);
});

test('a single altered Swap fails the gate: replay_mismatch, never a drawn history', async () => {
  const fixture = loadCase('3136705');
  const day = Number(Object.keys(fixture.swaps).find((d) => fixture.swaps[d].some((log) => log[2] === 3 && log[0] > loadCase('3136705').expect.mintedAt.block)));
  const tamper = (logs, d) => {
    if (d !== day) return logs;
    const i = logs.findIndex((log) => log[2] === 3 && log[0] > fixture.expect.mintedAt.block);
    const copy = logs.map((log) => [...log]);
    // One more unit of liquidity after that swap than the pool had.
    const data = copy[i][5];
    const liquidity = BigInt(`0x${data.slice(2 + 3 * 64, 2 + 4 * 64)}`) + 1n;
    copy[i][5] = `${data.slice(0, 2 + 3 * 64)}${liquidity.toString(16).padStart(64, '0')}${data.slice(2 + 4 * 64)}`;
    return copy;
  };
  const { result } = await replayed('3136705', { tamper });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'replay_mismatch');
  assert.equal(result.checkpoint, null);
});

test('a history over MAX_SWAP_DAYS stops before any swap is asked (too_much_history, no checkpoint)', async () => {
  const fixture = loadCase('3135288');
  const run = runOf(fixture);
  const relay = fixtureRelay(fixture);
  const result = await runPipeline({ logs: relay.logs, ...quiet }, { ...run, state: { ...run.state, block: run.state.block + 31 * DAY } });
  assert.deepEqual({ ok: result.ok, reason: result.reason, checkpoint: result.checkpoint }, { ok: false, reason: 'too_much_history', checkpoint: null });
  // Changed on purpose (2026-09-25): the mint is looked for in the last epoch, then as far back as a history that can still
  // be replayed; found in neither, the mint is older than that, and nothing else is asked.
  const top = run.state.block + 31 * DAY;
  const lastDay = Math.floor(top / DAY);
  assert.deepEqual(relay.requests.map((r) => [r.kind, r.since]), [['transfer', top - EPOCH + 1], ['transfer', (lastDay - 29) * DAY]]);
});

// 2026-09-25: the replay's cheap bound. Before any of the pool's history, one probe of its last PROBE_SPAN blocks: each
// kind of log at its rate there (less PROBE_SLACK logs), over the pool's life for its liquidity history and over the
// position's for its swaps. A history that projects past the budget stops there, as PONS/USDG's must (over 60 MB); a
// quiet pool, or one with a few logs in that hour, goes on and verifies.
test('the probe stops a history its budget cannot hold before any of it is read, and lets a quiet one verify', async () => {
  const PAGE = 2 * 1024 * 1024;
  // 3165100: 66 swaps in its pool's last six minutes (908 in the hour), 10.9 MB of history in all.
  const busy = await replayed('3165100', {}, { budgetBytes: PAGE });
  assert.deepEqual({ ok: busy.result.ok, reason: busy.result.reason, checkpoint: busy.result.checkpoint }, { ok: false, reason: 'too_much_history', checkpoint: null });
  assert.deepEqual(busy.relay.requests.map((r) => r.kind), ['transfer', 'initialize', 'probe'], 'nothing of the pool’s history is read');
  const probe = busy.relay.requests[2];
  assert.equal(probe.to, busy.run.state.block);
  assert.equal(probe.to - probe.from + 1, PROBE_SLICES[0], 'its last six minutes: a small reply, and enough');
  assert.equal(PROBE_SLICES.reduce((a, b) => a + b), fees.PROBE_SPAN, 'the slices make the last hour');
  // 3136705 and 2310187 (0.6 and 1.2 MB in all, nine logs each in the sample) and the owner's 3135288 (none): each verifies.
  for (const id of ['3136705', '3135288', '2310187']) {
    const quietOne = await replayed(id, {}, { budgetBytes: PAGE });
    assert.equal(quietOne.result.ok, true, `${id}: ${quietOne.result.reason}`);
    // Its last hour in slices, then a few minutes in each epoch it lived through, newest first, all before its history.
    const probes = quietOne.relay.requests.filter((r) => r.kind === 'probe');
    const pool = loadCase(id).initialize[0][0];
    const lived = Math.floor(quietOne.run.state.block / EPOCH) - Math.floor(pool / EPOCH) + 1;
    assert.ok(probes.length >= PROBE_SLICES.length && probes.length <= PROBE_SLICES.length + Math.min(PROBE_WINDOWS, lived), `${id}: ${probes.length} samples`);
    assert.ok(probes.every((r) => r.to - r.from + 1 <= fees.PROBE_SPAN && r.from >= pool), id);
    assert.ok(probes.slice(1).every((r, i) => r.to < probes[i].from), `${id}: newest first`);
    const firstEpoch = quietOne.relay.requests.findIndex((r) => r.kind === 'pool');
    assert.ok(quietOne.relay.requests.slice(firstEpoch).every((r) => r.kind !== 'probe'), `${id}: every sample before the history`);
  }
  // A pool with no liquidity history in its samples (the owner's 3135288's) has its epochs asked whole, one reply each;
  // one with any (3136705's) has them asked in capped parts: liquidity comes in bursts that samples do not see.
  const quietPool = await replayed('3135288', {}, { budgetBytes: PAGE });
  assert.ok(quietPool.relay.requests.filter((r) => r.kind === 'pool').every((r) => r.parts === undefined), 'a quiet pool’s epochs whole');
  const livelyPool = await replayed('3136705', {}, { budgetBytes: PAGE });
  const epochs = livelyPool.relay.requests.filter((r) => r.kind === 'pool');
  assert.ok(epochs.length > 0 && epochs.every((r) => r.parts === true), 'the other’s in capped parts');
  assert.equal(livelyPool.result.ok, true, livelyPool.result.reason);
  // A swapBefore never looks further back than the pool's Initialize (no longer a scan of the whole chain).
  const owner = await replayed('3135288', {}, { budgetBytes: PAGE });
  const before = owner.relay.requests.find((r) => r.kind === 'swapBefore');
  assert.equal(before.since, loadCase('3135288').initialize[0][0]);
});

test('the budget stops a run with its checkpoint, and a larger budget resumes it to the same history', async () => {
  const straight = (await replayed('3165100')).result;
  const fixture = loadCase('3165100');
  // 2026-09-25: a probe that saw a quiet hour lets the run start (3165100's own would stop it at once, above).
  const quietProbe = (request) => ({ ok: true, value: { v: 1, kind: 'probe', head: fixture.state.block + 2, units: [{ unit: null, from: request.from, to: request.to, final: false, logs: [] }], next: null }, bytes: 100 });
  const first = fixtureRelay(fixture, { maxDays: 1, script: { probe: Array.from({ length: 10 }, () => quietProbe) } });
  const stopped = await runPipeline({ logs: first.logs, ...quiet }, runOf(fixture, { budgetBytes: 3 * 1024 * 1024 }));
  assert.equal(stopped.ok, false);
  assert.equal(stopped.reason, 'too_much_history');
  assert.notEqual(stopped.checkpoint, null, 'the place is kept');
  const second = fixtureRelay(fixture, { maxDays: 1 });
  const resumed = await runPipeline({ logs: second.logs, ...quiet }, runOf(fixture, { checkpoint: stopped.checkpoint }));
  assert.equal(resumed.ok, true, resumed.reason);
  assert.deepEqual(resumed.history, straight.history);
  assert.deepEqual(resumed.prices, straight.prices);
  assert.ok(!second.requests.some((r) => r.kind === 'transfer' || r.kind === 'initialize'), 'a resumed run does not start over');
});

// 2026-09-25: the budget bounds every step. A busy pool's liquidity history (PONS/USDG's is over 60 MB decoded) was read
// to its end before the budget was ever looked at, and each visitor now reads it from the RPC under their own address's
// limit (src/lib/chain/browser.ts chainLane).
test('the budget bounds the pool’s epochs too: a busy pool stops the run before any swap is asked, with nothing to keep', async () => {
  const fixture = loadCase('3136705');
  const relay = fixtureRelay(fixture);
  // Each epoch answered at 2 MB, as a busy pool's are.
  const heavy = async (request) => {
    const answer = await relay.logs(request);
    return request.kind === 'pool' && answer.ok ? { ...answer, bytes: 2 * 1024 * 1024 } : answer;
  };
  const result = await runPipeline({ logs: heavy, ...quiet }, runOf(fixture, { budgetBytes: 3 * 1024 * 1024 }));
  assert.deepEqual({ ok: result.ok, reason: result.reason, checkpoint: result.checkpoint }, { ok: false, reason: 'too_much_history', checkpoint: null });
  assert.equal(relay.requests.filter((r) => r.kind === 'pool').length, 2, 'no epoch is asked once the budget is spent');
  assert.ok(!relay.requests.some((r) => r.kind === 'swaps' || r.kind === 'headers' || r.kind === 'swapBefore'), 'nor anything after the epochs');
  // With room for them, the same epochs verify.
  const roomy = fixtureRelay(fixture);
  const whole = await runPipeline({ logs: async (request) => { const a = await roomy.logs(request); return request.kind === 'pool' && a.ok ? { ...a, bytes: 2 * 1024 * 1024 } : a; }, ...quiet }, runOf(fixture, { budgetBytes: 24 * 1024 * 1024 }));
  assert.equal(whole.ok, true, whole.reason);
});

// 2026-09-25: the replay worker gives each run a time budget as well (constants.ts BUDGET_MS): paced below the RPC's
// limit, a busy history would otherwise keep a card loading for minutes before its byte budget stopped it.
test('a run whose time is spent stops as at its byte budget: before the swap days with nothing kept, among them with its place kept', async () => {
  const fixture = loadCase('2310187');
  const early = fixtureRelay(fixture);
  const before = await runPipeline({ logs: early.logs, ...quiet, timeUp: () => early.requests.some((r) => r.kind === 'pool') }, runOf(fixture));
  assert.deepEqual({ ok: before.ok, reason: before.reason, checkpoint: before.checkpoint }, { ok: false, reason: 'too_much_history', checkpoint: null });
  assert.equal(early.requests.filter((r) => r.kind === 'pool').length, 1);

  const late = fixtureRelay(fixture, { maxDays: 1 });
  const stopped = await runPipeline({ logs: late.logs, ...quiet, timeUp: () => late.requests.filter((r) => r.kind === 'swaps').length >= 3 }, runOf(fixture));
  assert.equal(stopped.reason, 'too_much_history');
  assert.notEqual(stopped.checkpoint, null, 'the place is kept');
  assert.equal(late.requests.filter((r) => r.kind === 'swaps').length, 3);
  const resumed = await runPipeline({ logs: fixtureRelay(fixture, { maxDays: 1 }).logs, ...quiet }, runOf(fixture, { checkpoint: stopped.checkpoint }));
  assert.equal(resumed.ok, true, resumed.reason);
  assert.deepEqual(resumed.history.earned.map(String), fixture.expect.earned);
});

test('a verified checkpoint at the same block needs no log at all to verify again', async () => {
  const { result, fixture } = await replayed('3136705');
  const relay = fixtureRelay(fixture);
  const again = await runPipeline({ logs: relay.logs, ...quiet }, runOf(fixture, { checkpoint: result.checkpoint }));
  assert.equal(again.ok, true);
  assert.deepEqual(again.history, result.history);
  assert.ok(relay.requests.every((r) => r.kind === 'pool' || r.kind === 'swaps' || r.kind === 'headers'));
});

test('a hooked pool is refused, and relay failures stop the run as rpc_unavailable', async () => {
  const fixture = loadCase('3135288');
  const hooked = fixture.initialize.map((log) => [...log]);
  hooked[0][5] = `${hooked[0][5].slice(0, 2 + 2 * 64)}${'1'.padStart(64, '0')}${hooked[0][5].slice(2 + 3 * 64)}`;
  const relay = fixtureRelay({ ...fixture, initialize: hooked });
  const refused = await runPipeline({ logs: relay.logs, ...quiet }, runOf(fixture));
  assert.equal(refused.reason, 'hooked_pool');

  const down = { ok: false, failure: 'unavailable', retryAfterMs: 0 };
  const failed = await runPipeline({ logs: fixtureRelay(fixture, { script: { pool: [down] } }).logs, ...quiet }, runOf(fixture));
  assert.deepEqual({ ok: failed.ok, reason: failed.reason }, { ok: false, reason: 'rpc_unavailable' });
});

test('rate limits are waited out, a lagging relay is asked once more, and an answer with no whole day is asked again', async () => {
  const fixture = loadCase('3136705');
  const slept = [];
  const limited = { ok: false, failure: 'rate_limited', retryAfterMs: 5000 };
  const behind = (request) => ({ ok: true, value: { v: 1, kind: request.kind, behind: true }, bytes: 40 });
  const empty = (request) => ({ ok: true, value: { v: 1, kind: 'swaps', head: fixture.state.block + 2, units: [], next: request.day }, bytes: 60 });
  const relay = fixtureRelay(fixture, { script: { transfer: [limited, limited], pool: [behind], swaps: [empty] } });
  const result = await runPipeline({ logs: relay.logs, sleep: async (ms) => void slept.push(ms) }, runOf(fixture));
  assert.equal(result.ok, true, result.reason);
  assert.deepEqual(slept.slice(0, 2), [5000, 5000], 'Retry-After honoured when longer than the back-off');
  assert.ok(slept.includes(2000), 'a lagging relay is asked again after 2 s');

  const always = fixtureRelay(fixture, { script: { transfer: [limited, limited, limited] } });
  const gaveUp = await runPipeline({ logs: always.logs, ...quiet }, runOf(fixture));
  assert.equal(gaveUp.reason, 'rpc_unavailable');
  assert.equal(always.requests.length, 3, 'three tries, then the unclaimed figure only');
});

test('a cancelled run posts nothing back', async () => {
  const fixture = loadCase('3136705');
  let asked = 0;
  const relay = fixtureRelay(fixture);
  const result = await runPipeline({ logs: (request) => (asked++, relay.logs(request)), cancelled: () => asked >= 2, ...quiet }, runOf(fixture));
  assert.equal(result, null);
});

test('periods and buckets of a real history add up to it (series.ts, no valuation)', async () => {
  const { result } = await replayed('2310187');
  const { history } = result;
  assert.deepEqual(series.periodsFor(history), ['24h', '7d', '30d', 'all']);
  assert.equal(series.defaultPeriodFor(history), '7d');
  assert.equal(series.bucketSecondsFor(history, 'all'), 86_400, 'a little over 14 days of history: daily');
  const all = series.slicePeriod(history, 'all');
  assert.deepEqual(all.base.earned, [0n, 0n]);
  const buckets = series.bucketize(all, series.bucketSecondsFor(history, 'all'));
  const sum = buckets.reduce((acc, b) => [acc[0] + b.earnedIn[0], acc[1] + b.earnedIn[1]], [0n, 0n]);
  assert.deepEqual(sum, history.earned);
  assert.deepEqual(buckets.reduce((acc, b) => [acc[0] + b.collectedIn[0], acc[1] + b.collectedIn[1]], [0n, 0n]), history.collected);
  assert.ok(buckets.every((b) => b.earnedIn[0] >= 0n && b.earnedIn[1] >= 0n), 'earned only grows');
  assert.equal(buckets.reduce((acc, b) => acc + b.inRangeSeconds, 0), history.timeInRange.inSeconds);
  const day = series.slicePeriod(history, '24h');
  assert.equal(day.end - day.start, 86_400);
  const hourly = series.bucketize(day, 3600);
  assert.ok(hourly.length >= 24 && hourly.length <= 25, `${hourly.length} hourly buckets`);
  const inDay = hourly.reduce((acc, b) => [acc[0] + b.earnedIn[0], acc[1] + b.earnedIn[1]], [0n, 0n]);
  assert.deepEqual([day.base.earned[0] + inDay[0], day.base.earned[1] + inDay[1]], history.earned);

  const young = (await replayed('3165100')).result.history;
  assert.deepEqual(series.periodsFor(young), ['24h', 'all']);
  assert.equal(series.bucketSecondsFor(young, 'all'), 3600);
});

test('TickMath and the timeline: exact at the known points, interpolated between', () => {
  assert.equal(sqrtAtTick(0), 1n << 96n);
  assert.equal(sqrtAtTick(-887272), 4295128739n);
  assert.equal(sqrtAtTick(887272), 1461446703485210103287273052203988822378723970342n);
  const timeline = new Timeline([[72_000, 1000], [36_000, 100], [80_000, 1400]]);
  assert.equal(timeline.at(36_000), 100);
  assert.equal(timeline.at(54_000), 550);
  assert.equal(timeline.at(80_000), 1400);
  assert.throws(() => timeline.at(80_001));
  assert.throws(() => timeline.at(35_999));
  // A replay's data survives a structured clone (the worker boundary) whole.
  const replay = FeeReplay.start({ tokenId: 1n, tickLower: -60, tickUpper: 60, tickSpacing: 60, fee: 3000 }, 1n << 96n, 0);
  assert.deepEqual(structuredClone(replay.save()), replay.save());
});

test('a busy pool epoch answered in parts (no whole unit yet) is asked again until it is whole', async () => {
  const fixture = loadCase('3136705');
  const empty = (request) => ({ ok: true, value: { v: 1, kind: 'pool', head: fixture.state.block + 2, units: [], next: request.epoch }, bytes: 60 });
  const slept = [];
  const relay = fixtureRelay(fixture, { script: { pool: [empty, empty] } });
  const result = await runPipeline({ logs: relay.logs, sleep: async (ms) => void slept.push(ms) }, runOf(fixture));
  assert.equal(result.ok, true, result.reason);
  assert.equal(slept.filter((ms) => ms === 1000).length, 2);
  // One epoch that never comes whole.
  const first = Math.min(...Object.keys(fixture.pool).map(Number));
  const stuck = fixtureRelay(fixture);
  const gaveUp = await runPipeline({ logs: (request) => (request.kind === 'pool' && request.epoch === first ? empty(request) : stuck.logs(request)), ...quiet }, runOf(fixture));
  assert.equal(gaveUp.reason, 'rpc_unavailable', 'six answers with nothing whole: the unclaimed figure only');
});
