/**
 * The price path (2026-09-25; src/lib/fees/replay.ts `path`, pipeline.ts P1
 * and P2, estimate.ts, functions/_lib/feesPath.ts): a busy pool's position
 * replayed from the Swaps of its own life and its own ModifyLiquidity events,
 * on the owner's three busy positions recorded read-only that day
 * (tests/support/fees/path-*.json.gz): USDG/DELTA 3203538 (171 Swaps in its
 * life) and PONS/USDG 3202568 and 3204536 (4,395). Each must land on the
 * chain's own unclaimed fees; PONS/USDG's is drawn estimated first, from a
 * few windows, and then exact.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { PATH_CASES, loadPath, pathRelay, pathState } from './support/fees/path-fixture.mjs';
import { addressTopic, fakeChain, fees, owned, rpcLog, word } from './support/fees/fake-chain.mjs';
import { fixtureRelay, loadCase, quietProbes, stateOfCase } from './support/fees/relay-fixture.mjs';

const require = createRequire(import.meta.url);
const { runPipeline } = require('../.test-build/app/src/lib/fees/pipeline.js');
const { FeeReplay, Timeline, protocolPart } = require('../.test-build/app/src/lib/fees/replay.js');
const { estimateHistory } = require('../.test-build/app/src/lib/fees/estimate.js');
const constants = require('../.test-build/app/src/lib/fees/constants.js');
const feesPath = require('../.test-build/app/functions/_lib/feesPath.js');

const HOUR = 36_000;
const PAGE = constants.BUDGET_BYTES.page;
const quiet = { sleep: async () => {} };
const own = (log, id) => log[2] === 1 && BigInt(`0x${log[5].slice(2 + 3 * 64, 2 + 4 * 64)}`) === BigInt(id);

test('a refused settlements prerequisite does not spend requests on timeline headers', async () => {
  const fixture = loadPath('path-delta');
  const id = '3203538';
  const relay = pathRelay(fixture, id);
  const { state, growth } = pathState(fixture, id);
  const asked = [];
  const result = await runPipeline({ ...quiet, logs: async (request) => {
    asked.push(request.kind);
    return request.kind === 'settlements' ? { ok: false, failure: 'unavailable', retryAfterMs: 0 } : relay.logs(request);
  } }, { id, state, growth, budgetBytes: PAGE, checkpoint: null });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'rpc_unavailable');
  assert.ok(asked.includes('settlements'));
  assert.equal(asked.includes('headers'), false, 'timestamps are needed only after the position events can be reconciled');
});

function monotonic(history, label) {
  for (let i = 1; i < history.hourly.length; i++) {
    const [a, b] = [history.hourly[i - 1], history.hourly[i]];
    assert.ok(b.t >= a.t, `${label}: time goes forward`);
    assert.ok(b.earned[0] >= a.earned[0] && b.earned[1] >= a.earned[1], `${label}: earned never falls (hour ${i})`);
  }
}

/** The recorded case's logs in chain order, as the replay takes them: the Swap before the mint, then the life. */
function lifeOf(fixture, id) {
  const mint = fixture.positions[id].mintBlock;
  const before = fixture.logs.filter((log) => log[2] === 3 && log[0] < mint);
  return [before[before.length - 1], ...fixture.logs.filter((log) => log[0] >= mint && (log[2] !== 1 || own(log, id)))];
}

test('protocolPart solves the swap fee for the protocol’s share: 0 when none, the least that fits, null when nothing does', () => {
  assert.equal(protocolPart(3000n, 3000n), 0n);
  // PONS/USDG 0.30 % with 500 pips to the protocol, USDG/DELTA 1.99 % with 1,000 (slot0, read 2026-09-25).
  assert.equal(protocolPart(3000n + 500n - (500n * 3000n) / 1_000_000n, 3000n), 500n);
  assert.equal(protocolPart(19_900n + 1000n - (1000n * 19_900n) / 1_000_000n, 19_900n), 1000n);
  assert.equal(protocolPart(2_999n, 3000n), null, 'below the LP fee: no protocol share gives it');
  assert.equal(protocolPart(5_000n, 3000n), null, 'past the most a protocol fee may add');
});

for (const [id, name] of Object.entries(PATH_CASES)) {
  test(`NFT ${id}: the price path of its own life lands on the chain’s unclaimed fees`, () => {
    const fixture = loadPath(name);
    const { state } = pathState(fixture, id);
    const init = fixture.initialize[5];
    const lpFee = Number(BigInt(`0x${init.slice(2, 66)}`));
    const tickSpacing = Number(BigInt.asIntN(24, BigInt(`0x${init.slice(66, 130)}`)));
    const replay = FeeReplay.start({ tokenId: BigInt(id), tickLower: state.tickLower, tickUpper: state.tickUpper, tickSpacing, fee: lpFee, path: true }, 0n, 0);
    const timeline = new Timeline([...Object.entries(fixture.headers).map(([block, t]) => [Number(block), t])]);
    for (const log of lifeOf(fixture, id)) if (log[0] <= state.block) replay.apply(log, timeline);
    const owed = replay.owed();
    const allowed = replay.rounding();
    for (const side of [0, 1]) {
      const diff = owed[side] > state.unclaimed[side] ? owed[side] - state.unclaimed[side] : state.unclaimed[side] - owed[side];
      // Measured on 2026-09-25: to the unit, both tokens, all three positions.
      assert.equal(diff, 0n, `token ${side}: ${owed[side]} against the chain’s ${state.unclaimed[side]} (allowance ${allowed[side]})`);
    }
    assert.equal(replay.pool().price, state.sqrtPriceX96, 'the pool’s price at the state block');
    assert.equal(replay.pool().tick, state.tick);
    assert.equal(replay.positionLiquidity(), state.liquidity);
    assert.deepEqual([replay.checks.tickMismatch, replay.checks.liquidityMismatch, replay.checks.swapFeeMismatch], [0, 0, 0]);
  });
}

test('NFT 3203538 (USDG/DELTA): the probe chooses the price path, its life is read at once and verified, no pool epoch or swap day is asked', async () => {
  const fixture = loadPath('path-delta');
  const relay = pathRelay(fixture, '3203538', { busyProbe: true });
  const { state, growth } = pathState(fixture, '3203538');
  const estimates = [];
  const result = await runPipeline({ logs: relay.logs, ...quiet, estimate: (e) => estimates.push(e) }, { id: '3203538', state, growth, budgetBytes: PAGE, checkpoint: null });
  assert.equal(result?.ok, true, `not verified: ${result?.reason}`);
  const { history } = result;
  assert.deepEqual(history.earned, state.unclaimed, 'earned since the mint = the chain’s unclaimed fees (no settlement since)');
  assert.deepEqual(history.collected, [0n, 0n]);
  assert.deepEqual(history.hourly.at(-1).earned, state.unclaimed);
  assert.equal(history.hourly.at(-1).t, state.timestamp);
  assert.equal(history.events[0].kind, 'mint');
  assert.equal(history.events.length, 1);
  assert.equal(history.near, undefined, 'no settlement: every figure is the chain’s');
  monotonic(history, '3203538');
  assert.ok(history.timeInRange.inSeconds > 0 && history.timeInRange.inSeconds <= history.timeInRange.totalSeconds);
  const kinds = new Set(relay.requests.map((request) => request.kind));
  assert.ok(kinds.has('settlements') && kinds.has('span'), [...kinds].join(', '));
  assert.ok(!kinds.has('pool') && !kinds.has('swaps'), 'neither the pool’s history nor whole days');
  // Its probe slice holds no Swap (recorded): since 2026-09-25 (release review, P4) that rate is not known, and the
  // estimate's windows measure it first; they say a life this small (104 kB) is read at once, with no estimate drawn.
  assert.deepEqual(estimates, [], 'a life this small is read at once: no estimate first');
  const spans = relay.requests.filter((request) => request.kind === 'span');
  assert.ok(spans.length <= 12 && relay.cut === 0, `${spans.length} span requests, ${relay.cut} cut`);
  const settle = relay.requests.find((request) => request.kind === 'settlements');
  assert.deepEqual(settle.holders, ['0xf6184f814543b88dd867c34ce6e9f56ab7d18c0a'], 'its owner, from its Transfers');
  assert.equal(settle.from, fixture.positions['3203538'].mintBlock);
  assert.equal(result.checkpoint !== null, true, 'a verified path keeps its place');
});

// 2026-09-27 (the owner: the Fees earned chart took far too long): his Auto-compound position 3325113, USDG/UFG 4 %, a
// day old, recorded read-only that day (tests/support/fees/3325113.json.gz, its exact history's every relay unit). Its
// pool's liquidity looked quiet in every sample, so the exact replay read the pool's whole history first: 866 kB of the
// RPC's JSON at the paced lane's 96 kB/s, 12.9 s to a verified chart live. Young in a pool whose Swaps the probe saw, it
// now takes the price path of its own life. Its five settlements paid no owner (a compound collects and adds back inside
// the PoolManager; the chain answered the settlements read with the mint alone, live), so the path looks for them among
// the PositionManager's ModifyLiquidity over its life, and lands on the exact replay's figures.
test('NFT 3325113 (the owner’s Auto-compound, a day old): its own life on the price path, its settlements found among the pool’s ModifyLiquidity though none paid its owner, a seventh of the exact replay’s bytes', async (t) => {
  const fixture = loadCase('3325113');
  const position = fixture.state.positions[0];
  const { state, growth } = stateOfCase(fixture);
  const run = { id: '3325113', state: { ...state, protocolFee: position.protocolFee }, growth, budgetBytes: PAGE, checkpoint: null };
  // As the chain answered it live: no payment between the PoolManager and its owner, so the mint alone (its own block).
  const mintOnly = async (request) => {
    const all = await fixtureRelay(fixture).logs(request);
    const unit = all.value.units[0];
    return { ...all, value: { ...all.value, units: [{ ...unit, logs: unit.logs.filter((log) => log[0] === request.from) }] } };
  };
  const counted = (relay) => {
    const out = { bytes: 0, logs: async (request) => { const answer = await relay.logs(request); if (answer.ok) out.bytes += answer.bytes; return answer; } };
    return out;
  };
  const relay = fixtureRelay(fixture, { script: { settlements: [mintOnly] } });
  const path = counted(relay);
  const result = await runPipeline({ logs: path.logs, ...quiet }, run);
  assert.equal(result?.ok, true, result?.reason);
  const kinds = relay.requests.map((request) => request.kind);
  assert.deepEqual(kinds, ['transfer', 'initialize', 'probe', 'probe', 'probe', 'settlements', 'modifies', 'headers', 'swapBefore', 'span', 'span']);
  assert.ok(relay.requests.filter((request) => request.kind === 'probe').every((probe) => probe.to - probe.from + 1 <= 25_200 && probe.to > state.block - 36_000), 'the pool’s last hour only: it showed Swaps, and a young position’s path needs no more');
  const { history } = result;
  // Every settlement the exact replay found, in its block, and what each collected to the path's rounding.
  assert.deepEqual(history.events.map((event) => [event.kind, event.block]), fixture.expect.events.map(([kind, block]) => [kind, block]));
  const close = (a, b) => (a > b ? a - b : b - a) * 1_000_000n <= (b > 0n ? b : 1n);
  history.events.forEach((event, i) => {
    for (const side of [0, 1]) assert.ok(close(event.fees[side], BigInt(fixture.expect.events[i][3][side])), `${event.kind} at ${event.block}, token ${side}: ${event.fees[side]} against ${fixture.expect.events[i][3][side]}`);
  });
  for (const side of [0, 1]) {
    assert.ok(close(history.collected[side], BigInt(fixture.expect.collected[side])), `collected ${side}`);
    assert.equal(history.earned[side] - history.collected[side], state.unclaimed[side], 'the chain’s unclaimed fees, exactly, at the end');
  }
  assert.equal(history.near, true, 'what each settlement collected is the path’s own figure (“≈” on screen)');
  monotonic(history, '3325113');
  // The same history by the exact replay of its pool's history (a probe that saw no Swap): bit for bit, and seven times the bytes.
  const exactRelay = fixtureRelay(fixture, { script: { probe: quietProbes(fixture) } });
  const exact = counted(exactRelay);
  const whole = await runPipeline({ logs: exact.logs, ...quiet }, run);
  assert.equal(whole?.ok, true, whole?.reason);
  assert.deepEqual(whole.history.collected.map(String), fixture.expect.collected);
  assert.deepEqual(whole.history.earned.map(String), fixture.expect.earned);
  assert.ok(exactRelay.requests.some((request) => request.kind === 'pool'));
  assert.ok(path.bytes * 5 < exact.bytes, `the path read ${path.bytes} B, the exact replay ${exact.bytes} B`);
  t.diagnostic(`3325113: the path ${relay.requests.length} requests, ${path.bytes} B; the exact replay ${exactRelay.requests.length} requests, ${exact.bytes} B`);
  // The next state block's run goes on from the checkpoint, and looks for new settlements where these were found.
  const later = fixtureRelay(fixture);
  const next = await runPipeline({ logs: later.logs, ...quiet }, { ...run, state: { ...run.state, block: state.block + 60, timestamp: state.timestamp + 6 }, checkpoint: result.checkpoint });
  assert.equal(next?.ok, true, next?.reason);
  assert.ok(later.requests.some((request) => request.kind === 'modifies') && !later.requests.some((request) => request.kind === 'settlements' || request.kind === 'transfer' || request.kind === 'probe'), later.requests.map((request) => request.kind).join(', '));
});

for (const id of ['3202568', '3204536']) {
  test(`NFT ${id} (PONS/USDG): an estimate from windows of its life first, ending on the chain’s figures; then the exact history`, async (t) => {
    const fixture = loadPath('path-pons');
    const relay = pathRelay(fixture, id);
    const { state, growth } = pathState(fixture, id);
    let bytes = 0;
    const counted = async (request) => {
      const answer = await relay.logs(request);
      if (answer.ok) bytes += answer.bytes;
      return answer;
    };
    const estimates = [];
    const extended = [];
    const result = await runPipeline(
      { logs: counted, ...quiet, estimate: (e) => estimates.push({ ...e, bytes, requests: relay.requests.length }), extend: (ms) => extended.push(ms) },
      { id, state, growth, budgetBytes: PAGE, checkpoint: null },
    );
    assert.equal(estimates.length, 1, 'one estimate');
    const [estimate] = estimates;
    assert.deepEqual(estimate.history.earned, state.unclaimed, 'the estimate ends on the chain’s unclaimed fees');
    assert.deepEqual(estimate.history.hourly.at(-1).earned, state.unclaimed);
    assert.deepEqual(estimate.history.collected, [0n, 0n]);
    monotonic(estimate.history, `${id} estimate`);
    assert.ok(estimate.bytes < 450 * 1024, `the estimate was drawn after ${estimate.bytes} B (the page’s own reads come first in the lane)`);
    assert.deepEqual(extended, [constants.PATH_REFINE_MS], 'then the run asks for the time of the exact read');
    assert.equal(result?.ok, true, `not verified: ${result?.reason}`);
    assert.deepEqual(result.history.earned, state.unclaimed);
    monotonic(result.history, `${id} exact`);
    assert.equal(result.history.hourly.length, estimate.history.hourly.length, 'the same hours');
    // How far the estimate's shape was from the exact one, in the value of both tokens at the pool's price now.
    const p = Number(state.sqrtPriceX96) / 2 ** 96;
    const value = (e) => Number(e[0]) * p * p + Number(e[1]);
    const total = value(state.unclaimed);
    const worst = Math.max(...result.history.hourly.map((hour, i) => Math.abs(value(hour.earned) - value(estimate.history.hourly[i].earned)) / total));
    t.diagnostic(`${id}: estimate after ${estimate.bytes} B in ${estimate.requests} requests; exact after ${bytes} B; the estimate's cumulative curve was at most ${(worst * 100).toFixed(1)} % of the total away from the exact one`);
    assert.ok(worst < 0.6, `the estimate’s shape: at most ${(worst * 100).toFixed(1)} % off`);
    assert.ok(!relay.requests.some((request) => request.kind === 'pool' || request.kind === 'swaps'));
  });
}

// 2026-09-25 (review): live, a probe that met a quiet moment of PONS/USDG sized the estimate's windows wide, and three
// requests of four were cut at the reply's cap (each cut is a reply the visitor's address paid for, and the lane's rest
// after it): the estimate came at 31 s. The windows are now sized by what they read.
for (const id of ['3202568', '3204536']) {
  test(`NFT ${id}: a probe that met a quiet moment of a busy pool; the estimate's windows are never cut at the reply's cap and read about SAMPLE_BYTES`, async (t) => {
    const fixture = loadPath('path-pons');
    const relay = pathRelay(fixture, id, { busyProbe: true, quietProbe: 8 });
    const { state, growth } = pathState(fixture, id);
    let atEstimate = null;
    const result = await runPipeline(
      { logs: relay.logs, ...quiet, estimate: () => void (atEstimate ??= { spanBytes: relay.spanBytes, cut: relay.cut, spans: relay.requests.filter((r) => r.kind === 'span').length }), extend: () => {} },
      { id, state, growth, budgetBytes: PAGE, checkpoint: null },
    );
    assert.ok(atEstimate, 'an estimate was drawn');
    t.diagnostic(`${id}: estimate after ${atEstimate.spans} span requests, ${atEstimate.spanBytes} B of windows; the whole read ${relay.spanBytes} B in ${relay.requests.filter((r) => r.kind === 'span').length} span requests, ${relay.cut} cut`);
    assert.equal(atEstimate.cut, 0, 'no request of windows was cut at the cap');
    assert.ok(atEstimate.spanBytes <= 1.25 * constants.SAMPLE_BYTES, `the windows read ${atEstimate.spanBytes} B`);
    assert.equal(relay.cut, 0, 'nor any span of the exact read');
    assert.equal(result?.ok, true, `not verified: ${result?.reason}`);
    assert.deepEqual(result.history.earned, state.unclaimed);
  });
}

// 2026-09-25 (release review, P4): live, PONS/USDG's probe slice (its last six minutes) held 7 other LPs'
// ModifyLiquidity and no Swap. The probe stops at its first slice with any liquidity log, so it said a rate of 0, and
// the run took P1: its first span was the whole life (sized from that 0), cut at the reply's cap four times, and the
// page's 30 s ran out with no estimate drawn. A rate of 0 is now one not known: the estimate's windows measure it.

/** A probe answer: the recorded logs of its blocks without their Swaps, and `lps` other LPs' ModifyLiquidity. */
function quietProbe(fixture, lps) {
  const someone = fixture.logs.find((log) => log[2] === 1);
  return (request) => {
    const recorded = fixture.logs.filter((log) => log[2] !== 3 && log[0] >= request.from && log[0] <= request.to);
    const others = Array.from({ length: lps }, (_, i) => [request.from + 10 + i, 900, 1, someone[3], someone[4], `${someone[5].slice(0, 2 + 3 * 64)}${'0'.repeat(63)}1`]);
    const logs = [...recorded, ...others].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const value = { v: 1, kind: 'probe', head: request.to + 2, units: [{ unit: null, from: request.from, to: request.to, final: false, logs }], next: null };
    return { ok: true, value, bytes: JSON.stringify(value).length };
  };
}

/** Runs `id` with the page's time as 30 span requests (about a second each through the lane) until an estimate extends it. */
async function pageRun(relay, id, state, growth) {
  let spans = 0;
  let extended = false;
  const estimates = [];
  const logs = async (request) => {
    if (request.kind === 'span') spans += 1;
    return relay.logs(request);
  };
  const result = await runPipeline(
    { logs, ...quiet, estimate: (e) => estimates.push(e), extend: () => void (extended = true), timeUp: () => !extended && spans >= 30 },
    { id, state, growth, budgetBytes: PAGE, checkpoint: null },
  );
  return { result, estimates };
}

for (const id of ['3202568', '3204536']) {
  test(`NFT ${id}: a probe slice with another LP's ModifyLiquidity and no Swap is a rate not known; an estimate, no reply cut, then the exact history`, async () => {
    const fixture = loadPath('path-pons');
    const relay = pathRelay(fixture, id, { script: { probe: [quietProbe(fixture, 1)] } });
    const { state, growth } = pathState(fixture, id);
    const { result, estimates } = await pageRun(relay, id, state, growth);
    assert.equal(relay.requests.filter((request) => request.kind === 'probe').length, 1, 'the probe stopped at its first slice');
    assert.equal(estimates.length, 1, 'an estimate was drawn');
    assert.deepEqual(estimates[0].history.earned, state.unclaimed);
    assert.equal(relay.cut, 0, 'no reply was cut at the cap');
    assert.equal(result?.ok, true, `not verified: ${result?.reason}${result?.later ? ' (later)' : ''}`);
    assert.deepEqual(result.history.earned, state.unclaimed);
  });
}

// The same, as live: a state 13,202 blocks after the pool's last recorded Swap (its longest quiet stretch in the
// recording), so the estimate's first window, at the state block, holds no Swap either: only the windows before it
// can tell the rate, and the plan waits for them.
for (const id of ['3202568', '3204536']) {
  test(`NFT ${id}: at a quiet moment of the chain itself (no Swap in its last 13,202 blocks, 7 other LPs' logs in the probe), the estimate is drawn and the exact history verifies`, async () => {
    const fixture = loadPath('path-pons');
    const { state: recorded, growth } = pathState(fixture, id);
    const swaps = fixture.logs.filter((log) => log[2] === 3);
    const gaps = swaps.slice(1).map((log, i) => [log[0] - swaps[i][0], log[0]]).sort((a, b) => b[0] - a[0]);
    const block = gaps[0][1] - 1;
    assert.ok(gaps[0][0] > 7_200 && block > fixture.positions[id].mintBlock + 20 * HOUR, 'a quiet stretch longer than the probe’s first two slices, late in the life');
    // The state at that block: the path up to it (landed to the unit on the recorded state, above).
    const init = fixture.initialize[5];
    const replay = FeeReplay.start({ tokenId: BigInt(id), tickLower: recorded.tickLower, tickUpper: recorded.tickUpper, tickSpacing: 60, fee: Number(BigInt(`0x${init.slice(2, 66)}`)), path: true, protocolFee: recorded.protocolFee }, 0n, 0);
    const timeline = new Timeline(Object.entries(fixture.headers).map(([at, t]) => [Number(at), t]));
    for (const log of lifeOf(fixture, id)) if (log[0] <= block) replay.apply(log, timeline);
    const state = { ...recorded, block, timestamp: timeline.at(block), unclaimed: replay.owed(), sqrtPriceX96: replay.pool().price, tick: replay.pool().tick };
    const relay = pathRelay(fixture, id, { script: { probe: [quietProbe(fixture, 7)] } });
    const { result, estimates } = await pageRun(relay, id, state, growth);
    const first = relay.requests.find((request) => request.kind === 'span');
    assert.equal(first.spans[0][1], block, 'the estimate’s first window ends at the state block');
    assert.equal(swaps.filter((log) => log[0] >= first.spans[0][0] && log[0] <= block).length, 0, 'and holds no Swap');
    assert.equal(estimates.length, 1, 'an estimate was drawn');
    assert.deepEqual(estimates[0].history.earned, state.unclaimed);
    assert.equal(relay.cut, 0, 'no reply was cut at the cap');
    assert.equal(result?.ok, true, `not verified: ${result?.reason}${result?.later ? ' (later)' : ''}`);
    assert.deepEqual(result.history.earned, state.unclaimed);
  });
}

test('an estimate stays when the exact read runs out of time, and none is made after a settlement (its collected fees would be a guess)', async () => {
  const fixture = loadPath('path-pons');
  const id = '3202568';
  const { state, growth } = pathState(fixture, id);
  let late = false;
  const estimates = [];
  const relay = pathRelay(fixture, id);
  const result = await runPipeline(
    { logs: relay.logs, ...quiet, estimate: (e) => { estimates.push(e); late = true; }, timeUp: () => late },
    { id, state, growth, budgetBytes: PAGE, checkpoint: null },
  );
  assert.equal(estimates.length, 1);
  assert.deepEqual(result && { ok: result.ok, reason: result.reason }, { ok: false, reason: 'too_much_history' }, 'the exact read stopped at its time: the estimate is what the card keeps');

  // A collect in the middle of the life (the owner's own ModifyLiquidity with no liquidity change): no estimate, and the
  // exact history verifies only against what is unclaimed since it.
  const mint = fixture.positions[id].mintBlock;
  const middle = fixture.logs.find((log) => log[2] === 3 && log[0] > mint + 400_000);
  const mintLog = fixture.logs.find((log) => own(log, id));
  const collect = [middle[0], middle[1] + 1, 1, `0x${'77'.repeat(32)}`, mintLog[4], `0x${mintLog[5].slice(2, 2 + 2 * 64)}${'0'.repeat(64)}${mintLog[5].slice(2 + 3 * 64)}`];
  const withCollect = { ...fixture, logs: [...fixture.logs, collect].sort((a, b) => a[0] - b[0] || a[1] - b[1]) };
  // What the collect settled: the path up to it.
  const init = fixture.initialize[5];
  const replay = FeeReplay.start({ tokenId: BigInt(id), tickLower: state.tickLower, tickUpper: state.tickUpper, tickSpacing: 60, fee: Number(BigInt(`0x${init.slice(2, 66)}`)), path: true }, 0n, 0);
  const timeline = new Timeline(Object.entries(fixture.headers).map(([block, t]) => [Number(block), t]));
  for (const log of lifeOf(withCollect, id)) if (log[0] <= state.block && (log[0] < collect[0] || (log[0] === collect[0] && log[1] <= collect[1]))) replay.apply(log, timeline);
  const settled = replay.save().settled;
  assert.ok(settled[0] > 0n, 'the collect settled some fees');
  const since = { ...state, unclaimed: [state.unclaimed[0] - settled[0], state.unclaimed[1] - settled[1]] };
  const noEstimate = [];
  // A foreground run explicitly grants refinement, as the page worker does; background runs keep their own cap.
  const exact = await runPipeline({ logs: pathRelay(withCollect, id).logs, ...quiet, estimate: (e) => noEstimate.push(e), extend: () => {} }, { id, state: since, growth, budgetBytes: PAGE, checkpoint: null });
  assert.deepEqual(noEstimate, [], 'no estimate after a settlement');
  assert.equal(exact?.ok, true, `not verified: ${exact?.reason}`);
  assert.deepEqual(exact.history.collected, settled, 'the collect’s fees, exactly');
  assert.deepEqual(exact.history.earned, state.unclaimed, 'collected + unclaimed = all it earned since the mint');
  assert.deepEqual(exact.history.events.map((event) => event.kind), ['mint', 'collect']);
  // 2026-09-25 (review): what the collect settled is the path's own figure, within its rounding of the chain's.
  assert.equal(exact.history.near, true);
  // Against the chain's figure from before the collect, the same replay disagrees: no history is drawn.
  const wrong = await runPipeline({ logs: pathRelay(withCollect, id).logs, ...quiet, extend: () => {} }, { id, state, growth, budgetBytes: PAGE, checkpoint: null });
  assert.deepEqual(wrong && { ok: wrong.ok, reason: wrong.reason }, { ok: false, reason: 'replay_mismatch' });
});

test('a verified path’s next run reads only the settlements and Swaps after it, and lands on the new state again', async () => {
  const fixture = loadPath('path-delta');
  const id = '3203538';
  const { state, growth } = pathState(fixture, id);
  // The first run as of an earlier state: the recorded life cut an hour before its end.
  const cut = state.block - HOUR;
  const replay = FeeReplay.start({ tokenId: BigInt(id), tickLower: state.tickLower, tickUpper: state.tickUpper, tickSpacing: 199, fee: 19_900, path: true }, 0n, 0);
  const timeline = new Timeline(Object.entries(fixture.headers).map(([block, t]) => [Number(block), t]));
  const swapsTo = (block) => fixture.logs.filter((log) => log[2] === 3 && log[0] <= block);
  for (const log of lifeOf(fixture, id)) if (log[0] <= cut) replay.apply(log, timeline);
  const lastSwap = swapsTo(cut).at(-1);
  const earlier = { ...state, block: cut, timestamp: timeline.at(cut), unclaimed: replay.owed(), sqrtPriceX96: replay.pool().price, tick: replay.pool().tick };
  assert.equal(earlier.sqrtPriceX96, BigInt(`0x${lastSwap[5].slice(2 + 2 * 64, 2 + 3 * 64)}`));
  const first = await runPipeline({ logs: pathRelay(fixture, id, { busyProbe: true }).logs, ...quiet }, { id, state: earlier, growth, budgetBytes: PAGE, checkpoint: null });
  assert.equal(first?.ok, true, `first run: ${first?.reason}`);
  const relay = pathRelay(fixture, id);
  const second = await runPipeline({ logs: relay.logs, ...quiet }, { id, state, growth, budgetBytes: PAGE, checkpoint: first.checkpoint });
  assert.equal(second?.ok, true, `second run: ${second?.reason}`);
  assert.deepEqual(second.history.earned, state.unclaimed);
  assert.deepEqual(relay.requests.map((request) => request.kind).filter((kind) => kind !== 'headers'), ['settlements', 'span'], 'only what came after');
  assert.ok(relay.requests.filter((request) => request.kind === 'span').every((request) => request.spans[0][0] === cut + 1));
});

test('the estimate alone: windows that cover every hour give the exact history’s shape, and it always ends on the figures it is given', () => {
  const fixture = loadPath('path-delta');
  const id = '3203538';
  const { state } = pathState(fixture, id);
  const mint = fixture.positions[id].mintBlock;
  const timeline = new Timeline(Object.entries(fixture.headers).map(([block, t]) => [Number(block), t]));
  const first = Math.floor(mint / HOUR);
  const last = Math.floor(state.block / HOUR);
  const slots = [];
  for (let anchor = first; anchor <= last; anchor++) {
    const from = Math.max(mint + 1, anchor * HOUR);
    const to = Math.min(state.block, anchor * HOUR + HOUR - 1);
    // Each window starts at the last Swap before it, so its first Swap's move counts too.
    const before = fixture.logs.filter((log) => log[2] === 3 && log[0] < from).at(-1);
    slots.push({ firstAnchor: anchor, lastAnchor: anchor, from: before[0], to, logs: fixture.logs.filter((log) => log[2] === 3 && ((log[0] >= from && log[0] <= to) || log === before)) });
  }
  const estimated = estimateHistory({ tickLower: state.tickLower, tickUpper: state.tickUpper, lpFee: 19_900, liquidity: state.liquidity, mint: { block: mint, tx: `0x${'00'.repeat(32)}` }, top: state.block, topTime: state.timestamp, earned: state.unclaimed, slots, timeline });
  assert.ok(estimated);
  assert.deepEqual(estimated.history.earned, state.unclaimed);
  assert.deepEqual(estimated.history.hourly.at(-1).earned, state.unclaimed);
  monotonic(estimated.history, 'estimate');
  assert.equal(estimated.history.hourly.length, last - first + 1);
  assert.deepEqual(estimated.history.events.map((event) => event.kind), ['mint']);
  // No window read at all: nothing to draw.
  assert.equal(estimateHistory({ tickLower: state.tickLower, tickUpper: state.tickUpper, lpFee: 19_900, liquidity: state.liquidity, mint: { block: mint, tx: `0x${'00'.repeat(32)}` }, top: state.block, topTime: state.timestamp, earned: state.unclaimed, slots: slots.map((slot) => ({ ...slot, logs: null })), timeline }), null);
});

// 2026-09-25 (review): the exact read that runs out of its run's budget or time keeps its place (`later`), and later
// runs, each with a budget of its own, go on from it until the history verifies; none starts over.
test('NFT 3202568: an exact read stopped by its time keeps its place; later runs go on from it, each on its own budget, to the exact history', async () => {
  const fixture = loadPath('path-pons');
  const id = '3202568';
  const { state, growth } = pathState(fixture, id);
  const relay = pathRelay(fixture, id);
  let estimated = false;
  let spansAfter = 0;
  const counting = async (request) => {
    if (estimated && request.kind === 'span') spansAfter += 1;
    return relay.logs(request);
  };
  // The first run's time ends ten spans into its exact read.
  const first = await runPipeline(
    { logs: counting, ...quiet, estimate: () => void (estimated = true), extend: () => {}, timeUp: () => spansAfter >= 10 },
    { id, state, growth, budgetBytes: PAGE, checkpoint: null },
  );
  assert.deepEqual(first && [first.ok, first.reason, first.later, first.checkpoint !== null], [false, 'too_much_history', true, true], 'stopped, its place kept for any later run');
  let checkpoint = first.checkpoint;
  let result = null;
  const through = [];
  for (let run = 1; run <= 4 && !result?.ok; run++) {
    const again = pathRelay(fixture, id);
    result = await runPipeline({ logs: again.logs, ...quiet }, { id, state, growth, budgetBytes: PAGE, checkpoint });
    assert.ok(!again.requests.some((request) => request.kind === 'transfer' || request.kind === 'probe' || request.kind === 'initialize'), 'no start over');
    // 2026-09-25 (release review, P4): its first span is sized by the rate its checkpoint kept, not from a rate of 0 (a
    // day of PONS/USDG, cut at the reply's cap).
    assert.equal(again.cut, 0, `run ${run}: no reply cut at the cap`);
    const spans = again.requests.filter((request) => request.kind === 'span');
    through.push(spans[0].spans[0][0]);
    if (!result.ok) {
      assert.deepEqual([result.reason, result.later], ['too_much_history', true]);
      assert.ok(result.bytes <= PAGE + 256 * 1024, `run ${run} read ${result.bytes} B, its own budget`);
      checkpoint = result.checkpoint;
    }
  }
  assert.equal(result?.ok, true, `not verified: ${result?.reason}`);
  assert.deepEqual(result.history.earned, state.unclaimed);
  assert.ok(through.every((block, i) => i === 0 || block > through[i - 1]), `each run starts further on: ${through.join(', ')}`);
});

// ---------------------------------------------------------------------------
// The two reads (functions/_lib/feesPath.ts), on a fake RPC
// ---------------------------------------------------------------------------

const POOL = '0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a';
const OWNER = '0xf6184f814543b88dd867c34ce6e9f56ab7d18c0a';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const PONS = '0x39dbed3a2bd333467115de45665cc57f813c4571';

test('path requests are exact: spans sorted, disjoint and at most a day, at most 16; settlements with 1..4 owners, two currencies, at most 30 days', () => {
  const ok = { kind: 'span', poolId: POOL, spans: [[10, 20], [30, 40]] };
  assert.deepEqual(feesPath.pathRequestOf(ok), ok);
  for (const body of [
    { ...ok, spans: [] },
    { ...ok, spans: [[30, 40], [10, 20]] },
    { ...ok, spans: [[10, 20], [20, 30]] },
    { ...ok, spans: [[0, feesPath.SPAN_BLOCKS]] },
    { ...ok, spans: Array.from({ length: 17 }, (_, i) => [i * 10, i * 10 + 1]) },
    { ...ok, spans: [[10, 9]] },
    { ...ok, poolId: POOL.toUpperCase() },
    { ...ok, extra: 1 },
  ]) assert.equal(feesPath.pathRequestOf(body), null, JSON.stringify(body).slice(0, 100));
  const settle = { kind: 'settlements', poolId: POOL, tokenId: '3202568', holders: [OWNER], currencies: [PONS, USDG], from: 100, to: 200 };
  assert.deepEqual(feesPath.pathRequestOf(settle), settle);
  for (const body of [
    { ...settle, holders: [] },
    { ...settle, holders: [OWNER, OWNER] },
    { ...settle, holders: Array.from({ length: 5 }, (_, i) => `0x${String(i).repeat(40)}`) },
    { ...settle, holders: [OWNER.toUpperCase()] },
    { ...settle, currencies: [PONS] },
    { ...settle, to: 99 },
    { ...settle, to: 100 + feesPath.SETTLE_SPAN },
    { ...settle, tokenId: '01' },
  ]) assert.equal(feesPath.pathRequestOf(body), null, JSON.stringify(body).slice(0, 100));
  // 2026-09-27: modifies, the NFT's own settlements among the PositionManager's ModifyLiquidity: a token id and spans as a
  // span request's.
  const scan = { kind: 'modifies', poolId: POOL, tokenId: '3325113', spans: [[10, 20], [30, 40]] };
  assert.deepEqual(feesPath.pathRequestOf(scan), scan);
  for (const body of [
    { ...scan, spans: [] },
    { ...scan, spans: [[30, 40], [10, 20]] },
    { ...scan, spans: [[0, feesPath.SPAN_BLOCKS]] },
    { ...scan, spans: Array.from({ length: 17 }, (_, i) => [i * 10, i * 10 + 1]) },
    { ...scan, tokenId: '01' },
    { ...scan, tokenId: 3325113 },
    { ...scan, holders: [OWNER] },
    { kind: 'modifies', poolId: POOL, spans: [[10, 20]] },
  ]) assert.equal(feesPath.pathRequestOf(body), null, JSON.stringify(body).slice(0, 100));
  // The relay's routes answer none of the three kinds.
  assert.equal(fees.logsRequestOf(ok), null);
  assert.equal(fees.logsRequestOf(settle), null);
  assert.equal(fees.logsRequestOf(scan), null);
});

test('span: the pool’s Swaps and Donates in each span, one batch; a reply past SPAN_BYTES is too large', async () => {
  const swap = (block, index = 0) => rpcLog({ topics: [fees.TOPIC.Swap, POOL, addressTopic('0x1111111111111111111111111111111111111111')], data: `0x${[0n, 0n, 1n << 96n, 10n ** 18n, 0n, 3499n].map(word).join('')}`, block, index });
  const chain = fakeChain({ head: 1_000_000, logs: [swap(100), swap(150, 2), swap(400), swap(900)] });
  const answer = await feesPath.pathLogsOnChain({ deps: chain.deps, cache: null }, { kind: 'span', poolId: POOL, spans: [[100, 200], [800, 999]] });
  assert.equal(answer.ok, true);
  assert.deepEqual(answer.value.units.map((unit) => [unit.from, unit.to, unit.logs.map((log) => log[0])]), [[100, 200, [100, 150]], [800, 999, [900]]]);
  const batches = chain.log.filter((call) => call.method === 'eth_getLogs');
  assert.equal(batches.length, 2, 'one batch of two');
  assert.deepEqual(batches[0].params[0].topics, [[fees.TOPIC.Swap, fees.TOPIC.Donate], POOL]);
  const big = fakeChain({ head: 1_000_000, logs: Array.from({ length: 900 }, (_, i) => swap(100 + i)) });
  const refused = await feesPath.pathLogsOnChain({ deps: big.deps, cache: null }, { kind: 'span', poolId: POOL, spans: [[100, 1_100]] });
  assert.deepEqual(refused, { ok: false, failure: 'too_large', retryAfterMs: 0 });
});

// 2026-09-27: the owner's Auto-compound settlements pay no owner (its compounds collect and add back inside the
// PoolManager): the scan finds them among every ModifyLiquidity the PositionManager made in the pool, one batch of spans.
test('modifies: the NFT’s own ModifyLiquidity among the PositionManager’s in the pool, each span in one batch; a reply past MODIFIES_BYTES is too large', async () => {
  const pm = addressTopic(owned.POSITION_MANAGER);
  const modify = (block, salt, index = 0, sender = pm) => rpcLog({ topics: [fees.TOPIC.ModifyLiquidity, POOL, sender], data: `0x${[-60n, 60n, 5n, BigInt(salt)].map(word).join('')}`, block, index });
  const logs = [modify(100, 3325113), modify(100, 999, 1), modify(300, 3325113, 2), modify(300, 3325113, 3), modify(700, 999), modify(900, 3325113)];
  const chain = fakeChain({ head: 1_000_000, logs });
  const answer = await feesPath.pathLogsOnChain({ deps: chain.deps, cache: null }, { kind: 'modifies', poolId: POOL, tokenId: '3325113', spans: [[100, 500], [600, 800]] });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.value.units.map((unit) => [unit.from, unit.to, unit.logs.map((log) => [log[0], log[1]])]), [[100, 500, [[100, 0], [300, 2], [300, 3]]], [600, 800, []]], 'the NFT’s own, in chain order; not the other NFT’s, not past the spans');
  const asked = chain.log.filter((call) => call.method === 'eth_getLogs').map((call) => call.params[0]);
  assert.deepEqual(asked.map((filter) => [Number(filter.fromBlock), Number(filter.toBlock), filter.address, filter.topics]), [[100, 500, fees.POOL_MANAGER, [fees.TOPIC.ModifyLiquidity, POOL, pm]], [600, 800, fees.POOL_MANAGER, [fees.TOPIC.ModifyLiquidity, POOL, pm]]]);
  assert.ok(answer.bytes >= JSON.stringify(answer.value).length, 'what the RPC sent is what it cost');
  const busy = fakeChain({ head: 1_000_000, logs: Array.from({ length: 400 }, (_, i) => modify(100 + i, 999)) });
  const refused = await feesPath.pathLogsOnChain({ deps: busy.deps, cache: null }, { kind: 'modifies', poolId: POOL, tokenId: '3325113', spans: [[100, 600]] });
  assert.deepEqual(refused, { ok: false, failure: 'too_large', retryAfterMs: 0 });
  assert.ok(feesPath.MODIFIES_BYTES < 400 * 700, 'four hundred logs are past the cap');
});

test('settlements: the owner’s own ModifyLiquidity in the mint’s block and in each block where the pool’s currencies moved between the PoolManager and an owner', async () => {
  const pm = addressTopic(owned.POSITION_MANAGER);
  const modify = (block, salt, index = 0) => rpcLog({ topics: [fees.TOPIC.ModifyLiquidity, POOL, pm], data: `0x${[-60n, 60n, 0n, BigInt(salt)].map(word).join('')}`, block, index });
  const transfer = (token, from, to, block) => rpcLog({ address: token, topics: [fees.TOPIC.Transfer, addressTopic(from), addressTopic(to)], data: `0x${word(5n)}`, block });
  const logs = [
    modify(100, 3202568),
    modify(100, 999, 1),
    // A collect paid to the owner, a swap by the owner (no ModifyLiquidity of the NFT), someone else's collect.
    transfer(USDG, fees.POOL_MANAGER, OWNER, 300),
    modify(300, 3202568, 2),
    transfer(PONS, OWNER, fees.POOL_MANAGER, 500),
    transfer(USDG, fees.POOL_MANAGER, '0x2222222222222222222222222222222222222222', 700),
    modify(700, 3202568, 1),
  ];
  const chain = fakeChain({ head: 1_000_000, logs, tokens: [USDG, PONS] });
  const answer = await feesPath.pathLogsOnChain({ deps: chain.deps, cache: null }, { kind: 'settlements', poolId: POOL, tokenId: '3202568', holders: [OWNER], currencies: [PONS, USDG], from: 100, to: 900 });
  assert.equal(answer.ok, true, JSON.stringify(answer));
  assert.deepEqual(answer.value.units[0].logs.map((log) => log[0]), [100, 300], 'the mint and the owner’s collect; not the other NFT, not a stranger’s payment');
  const asked = chain.log.filter((call) => call.method === 'eth_getLogs').map((call) => call.params[0]);
  assert.deepEqual(asked[0].address, [PONS, USDG]);
  // Two filters with the owners in one place each (one with the PoolManager on both sides timed out on the node).
  assert.deepEqual(asked[0].topics, [fees.TOPIC.Transfer, addressTopic(fees.POOL_MANAGER), [addressTopic(OWNER)]]);
  assert.deepEqual(asked[1].topics, [fees.TOPIC.Transfer, [addressTopic(OWNER)], addressTopic(fees.POOL_MANAGER)]);
  assert.deepEqual(asked.slice(2).map((filter) => [Number(filter.fromBlock), Number(filter.toBlock)]), [[100, 100], [300, 300], [500, 500]], 'the mint’s block and each block the owner paid or was paid in');
});
