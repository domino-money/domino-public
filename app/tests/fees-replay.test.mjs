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
import { CASES, fixtureRelay, loadCase, quietProbes, stateOfCase } from './support/fees/relay-fixture.mjs';

const USDG_UFG = ['0x5fc5360d0400a0fd4f2af552add042d716f1d168', '0xefab538cf3c29237a47c6afb145d50ddf204a0a3'];

const require = createRequire(import.meta.url);
const { outOfTime, runPipeline, PROBE_WINDOWS, PROBE_SLICES } = require('../.test-build/app/src/lib/fees/pipeline.js');
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
  // Changed on purpose (2026-09-27): in windows, newest first, none read twice: the last two days, the rest of the last
  // epoch, then back to the oldest day a history may replay.
  const top = run.state.block + 31 * DAY;
  const lastDay = Math.floor(top / DAY);
  assert.deepEqual(relay.requests.map((r) => [r.kind, r.since, r.until]), [['transfer', top - 2 * DAY + 1, top], ['transfer', top - EPOCH + 1, top - 2 * DAY], ['transfer', (lastDay - 29) * DAY, top - EPOCH]]);
});

// 2026-09-25: the replay's cheap bound. Before any of the pool's history, one probe of its last PROBE_SPAN blocks: each
// kind of log at its rate there (less PROBE_SLACK logs), over the pool's life for its liquidity history and over the
// position's for its swaps. A history that projects past the budget stops there, as PONS/USDG's must (over 60 MB); a
// quiet pool, or one with a few logs in that hour, goes on and verifies.
test('the probe stops a history its budget cannot hold before any of it is read, and lets a quiet one verify', async () => {
  const PAGE = 2 * 1024 * 1024;
  // 3165100: 66 swaps in its pool's last six minutes (908 in the hour), 10.9 MB of history in all.
  const busy = await replayed('3165100', { probeHistory: true }, { budgetBytes: PAGE });
  assert.deepEqual({ ok: busy.result.ok, reason: busy.result.reason, checkpoint: busy.result.checkpoint }, { ok: false, reason: 'too_much_history', checkpoint: null });
  // Changed on purpose (2026-09-25, the price path): past the probe, the NFT's own settlements, the Swap before its mint
  // and windows of its life (the estimate's, which size the whole read); its life's Swaps are past PATH_REFINE_BYTES at
  // their rate, and the run stops there.
  const kinds = busy.relay.requests.map((r) => r.kind);
  assert.deepEqual(kinds.slice(0, 6), ['transfer', 'initialize', 'probe', 'headers', 'settlements', 'swapBefore']);
  assert.ok(kinds.slice(6).every((kind) => kind === 'span') && kinds.length > 6, 'then windows of its life only: nothing of the pool’s history');
  const windows = busy.relay.requests.filter((r) => r.kind === 'span');
  assert.ok(windows.every((r) => r.spans.length <= 4 && r.spans.every(([from, to]) => to - from + 1 <= 36_000)), 'small windows, a few a request');
  const probe = busy.relay.requests[2];
  assert.equal(probe.to, busy.run.state.block);
  assert.equal(probe.to - probe.from + 1, PROBE_SLICES[0], 'its last six minutes: a small reply, and enough');
  assert.equal(PROBE_SLICES.reduce((a, b) => a + b), fees.PROBE_SPAN, 'the slices make the last hour');
  // Changed on purpose (2026-09-25, later): any liquidity history in a sample (3136705's, nine logs) and the price path is
  // the one: none of the pool's history is read (USDG/DELTA's epochs, which its samples said would fit, were read in
  // parts for 20 s live and never finished). It lands on the chain's unclaimed fees.
  const lively = await replayed('3136705', { probeHistory: true }, { budgetBytes: PAGE, state: { ...stateOfCase(loadCase('3136705')).state, protocolFee: 4_097_000 } });
  assert.equal(lively.result.ok, true, lively.result.reason);
  assert.ok(!lively.relay.requests.some((r) => r.kind === 'pool' || r.kind === 'swaps'), 'none of the pool’s history');
  assert.ok(lively.relay.requests.some((r) => r.kind === 'span') && lively.relay.requests.some((r) => r.kind === 'settlements'));
  // 2310187 lived through most of its pool's life (twelve million of thirteen million blocks), whose history fits: the
  // exact replay of that history, bit for bit, with none of its owner's payments looked for.
  const oldHand = await replayed('2310187', { probeHistory: true }, { budgetBytes: PAGE });
  assert.equal(oldHand.result.ok, true, oldHand.result.reason);
  assert.ok(oldHand.relay.requests.some((r) => r.kind === 'pool') && !oldHand.relay.requests.some((r) => r.kind === 'settlements' || r.kind === 'span'));
  assert.deepEqual(oldHand.result.history.collected.map(String), loadCase('2310187').expect.collected);
  // An owner who traded too often for the path to look for the NFT's settlements (the relay answers too_large): the
  // pool's history fits by its samples, so the exact replay of that history is the one, bit for bit, as before.
  const busyOwner = await replayed('3136705', { probeHistory: true, script: { settlements: [{ ok: false, failure: 'too_large', retryAfterMs: 0 }] } }, { budgetBytes: PAGE });
  assert.equal(busyOwner.result.ok, true, busyOwner.result.reason);
  assert.ok(busyOwner.relay.requests.some((r) => r.kind === 'pool'), 'the pool’s history, read');
  assert.deepEqual(busyOwner.result.history.earned.map(String), loadCase('3136705').expect.earned);
  // Settlements that do not account for the position's liquidity now (here one more of its ModifyLiquidity than it has,
  // as a missed decrease would leave): the path stops before reading any Swap, and the exact replay is the one.
  // Changed on purpose (2026-09-27): payments that do not account for it are followed by the scan of every
  // ModifyLiquidity the PositionManager made in the pool over the life (`modifies`); here that does not either.
  const fixture3136705 = loadCase('3136705');
  const extra = async (request) => {
    const all = await fixtureRelay(fixture3136705).logs(request);
    const unit = all.value.units[0];
    const mint = unit.logs.find((log) => log[2] === 1) ?? unit.logs[0];
    return { ...all, value: { ...all.value, units: [{ ...unit, logs: [mint, [mint[0] + 1000, 0, ...mint.slice(2)]] }, ...all.value.units.slice(1).map((more) => ({ ...more, logs: [] }))] } };
  };
  const missed = await replayed('3136705', { probeHistory: true, script: { settlements: [extra], modifies: [extra] } }, { budgetBytes: PAGE });
  assert.equal(missed.result.ok, true, missed.result.reason);
  assert.ok(missed.relay.requests.some((r) => r.kind === 'modifies'), 'the scan was asked');
  assert.ok(!missed.relay.requests.some((r) => r.kind === 'span'), 'no Swap read on a path that cannot land');
  assert.deepEqual(missed.result.history.earned.map(String), fixture3136705.expect.earned);
  // The owner's 3135288, whose every sample is quiet: its last hour in slices, then a few minutes in each epoch it lived
  // through, newest first, all before its history; the exact replay of that history, its epochs asked whole.
  const quietOne = await replayed('3135288', { probeHistory: true }, { budgetBytes: PAGE });
  assert.equal(quietOne.result.ok, true, quietOne.result.reason);
  const probes = quietOne.relay.requests.filter((r) => r.kind === 'probe');
  const pool = loadCase('3135288').initialize[0][0];
  const lived = Math.floor(quietOne.run.state.block / EPOCH) - Math.floor(pool / EPOCH) + 1;
  assert.ok(probes.length >= PROBE_SLICES.length && probes.length <= PROBE_SLICES.length + Math.min(PROBE_WINDOWS, lived), `${probes.length} samples`);
  assert.ok(probes.every((r) => r.to - r.from + 1 <= fees.PROBE_SPAN && r.from >= pool));
  assert.ok(probes.slice(1).every((r, i) => r.to < probes[i].from), 'newest first');
  const firstEpoch = quietOne.relay.requests.findIndex((r) => r.kind === 'pool');
  assert.ok(firstEpoch > 0 && quietOne.relay.requests.slice(firstEpoch).every((r) => r.kind !== 'probe'), 'every sample before the history');
  assert.ok(quietOne.relay.requests.filter((r) => r.kind === 'pool').every((r) => r.parts === undefined), 'a quiet pool’s epochs whole');
  // A swapBefore never looks further back than the pool's Initialize (no longer a scan of the whole chain).
  const before = quietOne.relay.requests.find((r) => r.kind === 'swapBefore');
  assert.equal(before.since, pool);
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
  // Changed on purpose (2026-09-27): probes that saw no Swap, so the exact replay of the pool's history is the one here (a
  // young position in a pool whose Swaps the probe sees takes the price path since that day: pipeline.ts P5).
  const relay = fixtureRelay(fixture, { script: { probe: quietProbes(fixture) } });
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
  const roomy = fixtureRelay(fixture, { script: { probe: quietProbes(fixture) } });
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

// 2026-09-28 (review of d478979d): a position page's run whose time ran out was told to the fees store as
// too_much_history, final for the visit, whatever had slowed the lane. What the worker now tells it (pipeline.ts
// outOfTime, `late` once the page's run's time is spent): a stop by its time alone could not read the chain in time.
test('a position page’s run stopped by its time alone is told as one that could not reach the chain; a stop at its bytes, a place kept for later or a time not spent is told as it is', async () => {
  const fixture = loadCase('2310187');
  const budget = runOf(fixture).budgetBytes;
  const early = fixtureRelay(fixture);
  const before = await runPipeline({ logs: early.logs, ...quiet, timeUp: () => early.requests.some((r) => r.kind === 'pool') }, runOf(fixture));
  const late = fixtureRelay(fixture, { maxDays: 1 });
  const among = await runPipeline({ logs: late.logs, ...quiet, timeUp: () => late.requests.filter((r) => r.kind === 'swaps').length >= 3 }, runOf(fixture));
  for (const stopped of [before, among]) {
    assert.equal(stopped.reason, 'too_much_history');
    assert.deepEqual(outOfTime(stopped, budget, true), { ...stopped, reason: 'rpc_unavailable' }, 'asked again on RETRY_MS');
    assert.equal(outOfTime(stopped, budget, false), stopped, 'its time not spent: a stop of its own (MAX_SWAP_DAYS, the probe’s bound), final as before');
  }
  const spent = { ...before, bytes: budget };
  assert.equal(outOfTime(spent, budget, true), spent, 'at its byte budget: final as before');
  const later = { ...among, later: true };
  assert.equal(outOfTime(later, budget, true), later, 'a price path’s place kept: the next newer block goes on from it, as before');
  const verified = await replayed('3136705');
  for (const other of [verified.result, { ...before, reason: 'replay_mismatch' }, { ...before, reason: 'rpc_unavailable' }]) assert.equal(outOfTime(other, budget, true), other);
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

// 2026-09-25: the price path on the recorded cases the exact replay verifies (their pool's history, the swap days of
// their life): from their own settlements and the Swaps of their life alone, each lands on the chain's unclaimed fees
// within the path's rounding (a unit or two a step, below the chain's: it rounds each step's fee up), collects included
// (2310187's seven, each within 0.00002 %). 3165100's life, 15,000 Swaps, is past what a page reads: its estimate stays.
test('the price path lands on the chain’s figures for every recorded case, settlements included, within its rounding', async (t) => {
  const { runPipeline: run } = require('../.test-build/app/src/lib/fees/pipeline.js');
  const ZERO32 = `0x${'0'.repeat(64)}`;
  for (const id of CASES) {
    const fixture = loadCase(id);
    const position = fixture.state.positions[0];
    // A probe that saw a pool as busy as PONS/USDG (500 other ModifyLiquidity in its last six minutes) with its real
    // Swaps: the price path, sized by the real rate.
    const plain = fixtureRelay(fixture);
    const heavyProbe = async (request) => {
      const answer = await plain.logs(request);
      const unit = answer.value.units[0];
      const others = Array.from({ length: 500 }, (_, i) => [unit.from + (i % 3000), 9000 + i, 1, ZERO32, [position.poolId, ZERO32], `0x${'0'.repeat(64 * 3)}${'0'.repeat(63)}1`]);
      return { ...answer, value: { ...answer.value, units: [{ ...unit, logs: [...unit.logs, ...others].sort((a, b) => a[0] - b[0] || a[1] - b[1]) }] } };
    };
    const relay = fixtureRelay(fixture, { script: { probe: [heavyProbe] } });
    // The recorded answers carry no protocol fee (it joined /state later): the USDG/UFG pools' slot0, read 2026-09-25, is
    // 1,000 pips each way; in the 4 % pool a Swap's fee fits 999 as well as 1,000, and only slot0 tells them apart.
    const { state } = stateOfCase(fixture);
    const protocolFee = position.poolKey.currency0 === USDG_UFG[0] && position.poolKey.currency1 === USDG_UFG[1] ? 4_097_000 : undefined;
    const estimates = [];
    const result = await run({ logs: relay.logs, ...quiet, estimate: (e) => estimates.push(e), extend: () => {} }, runOf(fixture, { state: { ...state, protocolFee } }));
    assert.ok(!relay.requests.some((r) => r.kind === 'pool' || r.kind === 'swaps'), `${id}: none of the pool’s history`);
    if (id === '3165100') {
      assert.deepEqual([result?.ok, result?.reason], [false, 'too_much_history'], `${id}: its life is past PATH_REFINE_BYTES`);
      assert.equal(estimates.length, 1, `${id}: an estimate stays`);
      assert.deepEqual(estimates[0].history.earned, state.unclaimed);
      t.diagnostic(`${id}: estimated from ${estimates[0].history.checks.swaps} sampled Swaps`);
      continue;
    }
    assert.equal(result?.ok, true, `${id}: ${result?.reason}`);
    const near = (a, b, parts) => (a > b ? a - b : b - a) * parts <= (b > 0n ? b : 1n);
    const collected = fixture.expect.collected.map(BigInt);
    for (const side of [0, 1]) {
      assert.ok(near(result.history.collected[side], collected[side], 1_000_000n), `${id} collected ${side}: ${result.history.collected[side]} against ${collected[side]}`);
      assert.equal(result.history.earned[side] - result.history.collected[side], state.unclaimed[side], `${id}: the chain’s unclaimed, exactly, at the end`);
    }
    const settles = result.history.events.filter((event) => event.kind !== 'mint').length;
    t.diagnostic(`${id}: ${result.history.checks.swaps} swaps, ${settles} settlements, ${estimates.length ? 'estimated first' : 'read at once'}`);
    if (settles > 0) assert.deepEqual(estimates, [], `${id}: no estimate after a settlement`);
  }
});

// 2026-09-25 (review of r4/fees): each run after a verified one reads only the new logs, under a budget of its own. The
// verified checkpoint used to carry the bytes of every run before it, and 2310187's minute runs (about 210 kB each here,
// the day and the epoch still open) added up past the page's 2 MB within minutes: its run then stopped at once, each time.
test('the runs after a verified history count their own bytes: 2310187 stays verified minute after minute', async () => {
  const fixture = loadCase('2310187');
  const { state, growth } = stateOfCase(fixture);
  const relay = fixtureRelay(fixture);
  let checkpoint = null;
  for (let minute = 0; minute <= 8; minute++) {
    const result = await runPipeline({ logs: relay.logs, ...quiet }, { id: '2310187', state: { ...state, block: state.block + minute }, growth, budgetBytes: 2 * 1024 * 1024, checkpoint });
    assert.equal(result?.ok, true, `minute ${minute}: ${result?.reason}`);
    checkpoint = result.checkpoint;
  }
});
