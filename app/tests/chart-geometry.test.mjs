// Added 2026-09-24 (V2 foundation, DESIGN-V2 §4.1, §4.7 and R-19): the pure chart geometry in src/lib/chart.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { linearScale, logScale, niceTicks, timeTicks } = require('../.test-build/app/src/lib/chart/scale.js');
const { linePath, areaPath, areaUnder, curveFor } = require('../.test-build/app/src/lib/chart/paths.js');
const { nearestIndex, tooltipSide, buckets } = require('../.test-build/app/src/lib/chart/inspect.js');
const { rangeGeometry } = require('../.test-build/app/src/lib/chart/range.js');
// Added 2026-09-25 (r3 charts): the Markets cards' price line.
const { sparkGeometry } = require('../.test-build/app/src/lib/chart/spark.js');

const HOUR = 3600;
const DAY = 86400;

test('scales: linear, a zero-width domain in the middle, log with nothing at or below zero', () => {
  const x = linearScale([0, 10], [100, 200]);
  assert.equal(x(0), 100);
  assert.equal(x(5), 150);
  assert.equal(linearScale([3, 3], [0, 50])(99), 25);
  const log = logScale([1, 100], [0, 200]);
  assert.ok(Math.abs(log(10) - 100) < 1e-9);
  assert.equal(log(0), 0);
  assert.equal(log(-5), 0);
  assert.equal(logScale([0, 10], [0, 40])(5), 20, 'a domain that is not positive maps to the middle');
});

test('niceTicks lands on 1/2/5 steps inside the range; timeTicks align to UTC hours, 6 hours, days or weeks', () => {
  assert.deepEqual(niceTicks(0, 10, 3), [0, 5, 10]);
  assert.deepEqual(niceTicks(0.1, 0.35, 3), [0.1, 0.2, 0.3]);
  assert.deepEqual(niceTicks(5, 5), [5]);
  assert.deepEqual(timeTicks(0, DAY, 5), [0, 6 * HOUR, 12 * HOUR, 18 * HOUR, DAY]);
  assert.deepEqual(timeTicks(30 * 60, 4 * HOUR + 10, 5), [HOUR, 2 * HOUR, 3 * HOUR, 4 * HOUR]);
  const weeks = timeTicks(0, 40 * DAY, 6);
  assert.ok(weeks.length > 0 && weeks.length <= 6);
  for (const t of weeks) assert.equal(new Date(t * 1000).getUTCDay(), 1, 'weeks start on a Monday');
});

test('paths: linear under 20 points, monotone curves never overshoot, areas close to the baseline', () => {
  assert.equal(curveFor(19), 'linear');
  assert.equal(curveFor(20), 'monotone');
  assert.equal(curveFor(40, 'linear'), 'linear');
  assert.equal(linePath([{ x: 0, y: 0 }, { x: 1, y: 2 }]), 'M0 0 L1 2');
  assert.equal(linePath([{ x: 3, y: 4 }]), 'M3 4');
  assert.equal(areaPath([{ x: 0, y: 0 }, { x: 1, y: 2 }], 'linear', 10), 'M0 0 L1 2 L1 10 L0 10 Z');
  assert.equal(areaUnder('M1.00 2.00 L3.00 4.00', 10), 'M1.00 2.00 L3.00 4.00 L3.00 10 L1.00 10 Z');
  assert.equal(areaUnder('M1.00 2.00', 10), '', 'one point closes nothing');
  // A monotone series with a flat stretch: every control point stays between its segment's ends.
  const ys = [0, 10, 10, 30, 31, 60, 60, 60, 90, 100];
  const pts = ys.map((y, i) => ({ x: i * 10, y }));
  const d = linePath(pts, 'monotone');
  const segments = d.split(' C').slice(1).map((part) => part.trim().split(/[ ,]+/).map(Number));
  assert.equal(segments.length, pts.length - 1);
  segments.forEach(([, c1y, , c2y], i) => {
    const lo = Math.min(ys[i], ys[i + 1]);
    const hi = Math.max(ys[i], ys[i + 1]);
    assert.ok(c1y >= lo - 1e-9 && c1y <= hi + 1e-9 && c2y >= lo - 1e-9 && c2y <= hi + 1e-9, `segment ${i} stays within ${lo}..${hi}`);
  });
});

test('inspection: nearest index, the tooltip side without measuring, contiguous UTC buckets', () => {
  assert.equal(nearestIndex([], 3), -1);
  assert.equal(nearestIndex([0, 10, 20], 14), 1);
  assert.equal(nearestIndex([0, 10, 20], 16), 2);
  assert.equal(nearestIndex([0, 10, 20], -5), 0);
  assert.equal(nearestIndex([0, 10, 20], 99), 2);
  assert.equal(tooltipSide(50, 100), 'right');
  assert.equal(tooltipSide(56, 100), 'left');
  assert.deepEqual(buckets(1.5 * HOUR, 4 * HOUR, HOUR), [
    { start: HOUR, end: 2 * HOUR },
    { start: 2 * HOUR, end: 3 * HOUR },
    { start: 3 * HOUR, end: 4 * HOUR },
  ]);
  const days = buckets(DAY + 5, 3 * DAY, DAY);
  assert.deepEqual(days.map((b) => b.start), [DAY, 2 * DAY]);
  assert.deepEqual(buckets(10, 5, HOUR), []);
});

test('rangeGeometry puts the band and the price on a log axis, edges and unknowns handled', () => {
  const g = rangeGeometry(1, 4, 2, 400);
  assert.ok(g.lower > 0 && g.lower < g.current && g.current < g.upper && g.upper < 400, JSON.stringify(g));
  assert.ok(Math.abs(g.current - (g.lower + g.upper) / 2) < 1e-9, 'the geometric middle of the band is its visual middle');
  const open = rangeGeometry(1, Infinity, 2, 400);
  assert.equal(open.upper, 400, 'an unbounded upper edge is drawn to the edge');
  const full = rangeGeometry(0, Infinity, 2, 400);
  assert.deepEqual([full.lower, full.upper], [0, 400]);
  assert.equal(rangeGeometry(1, 4, null, 400).current, null, 'no price, no marker');
  const out = rangeGeometry(1, 4, 100, 400);
  assert.ok(out.current > out.upper, 'a price above the range sits to its right');
});

// ---------------------------------------------------------------------------
// The Markets cards' price line (2026-09-25, lib/chart/spark.ts)
// ---------------------------------------------------------------------------

const SPARK_PAD = { left: 0, right: 20, top: 14, bottom: 40 };
/** A 24h hourly history ending 14 minutes into its last hour; `closes` maps hours after the first whole one to closes. */
function sparkHistory(closes, gaps = []) {
  const end = 1_790_255_659;
  const start = end - DAY;
  const first = Math.ceil(start / HOUR) * HOUR;
  const candles = Object.entries(closes).map(([hour, close]) => {
    const startTimestamp = first + Number(hour) * HOUR;
    return { startTimestamp, open: close, high: close, low: close, close, swapCount: 3, complete: startTimestamp + HOUR <= end };
  });
  return { resolutionSeconds: HOUR, requestedWindow: { startTimestamp: start, endTimestamp: end }, gaps, candles };
}
/** Every x, y pair of a path's numbers. */
const pairs = (d) => {
  const numbers = (d.match(/-?\d*\.?\d+/g) ?? []).map(Number);
  const out = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) out.push({ x: numbers[i], y: numbers[i + 1] });
  return out;
};

test('the card line is one smooth path across the card: from the first whole hour to the right edge, never past the pad', () => {
  const closes = Object.fromEntries(Array.from({ length: 24 }, (_, hour) => [hour, String(2600 + ((hour * 37) % 50))]));
  const g = sparkGeometry(sparkHistory(closes), 360, 164, SPARK_PAD);
  assert.equal((g.line.match(/M/g) ?? []).length, 1, 'one path');
  assert.equal(g.runs.length, 1);
  assert.ok(g.line.includes(' C'), 'monotone cubic segments');
  assert.equal(g.points.length, 24);
  assert.equal(g.points[0].x, 0, 'the first whole hour at the left edge');
  assert.equal(g.end.x, 340, 'the latest close at the right edge, inside the right pad');
  for (const { y } of pairs(g.line)) assert.ok(y >= 14 - 1e-9 && y <= 124 + 1e-9, `y ${y} stays between the pads`);
  assert.equal(g.baseline, g.points[0].y, 'the level is the first close');
  assert.equal(g.crest, 14, 'the area’s gradient starts at the highest close');
  assert.match(g.runs[0].area, / L340 164 L0 164 Z$/, 'one area, closed down to the plot’s floor');
  assert.equal(g.flat, false);
});

/** The x span of every drawn segment of a path (`M` starts a subpath; each `C` or `L` ends a segment at its last pair). */
function segments(d) {
  const out = [];
  let at = null;
  for (const [, command, args] of d.matchAll(/([MLC])([^MLC]*)/g)) {
    const numbers = (args.match(/-?\d*\.?\d+/g) ?? []).map(Number);
    const end = numbers[numbers.length - 2];
    if (command !== 'M' && at !== null) out.push([at, end]);
    at = end;
  }
  return out;
}

test('hours with no swap hold the last close, invisibly; the curve never joins across an uncovered interval', () => {
  // Swaps at hours 0, 1 and 6: hours 2 to 5 had none, so the close of hour 1 holds until hour 5.
  const quiet = sparkGeometry(sparkHistory({ 0: '10', 1: '12', 6: '8' }), 360, 164, SPARK_PAD);
  const drawn = pairs(quiet.line);
  const hour5 = quiet.points[1].x + 4 * ((quiet.points[2].x - quiet.points[1].x) / 5);
  const held = drawn.find((point) => Math.abs(point.x - hour5) < 0.02);
  assert.ok(held, 'the curve passes the hour before the next close');
  assert.ok(Math.abs(held.y - quiet.points[1].y) < 0.02, 'at the earlier close');
  assert.equal((quiet.line.match(/M/g) ?? []).length, 1, 'still one path: no break, no dotted stretch');
  // Closes at hours 0, 1, 10 and 23; hours 2 to 10 were never collected (the collector was behind or down).
  const history = sparkHistory({ 0: '10', 1: '12', 10: '8', 23: '9' });
  const first = history.candles[0].startTimestamp;
  const x = (at) => ((at - first) / (history.requestedWindow.endTimestamp - first)) * 340;
  const gap = { startTimestamp: first + 2 * HOUR, endTimestamp: first + 10 * HOUR };
  const open = sparkGeometry({ ...history, gaps: [gap] }, 360, 164, SPARK_PAD);
  assert.equal(open.runs.length, 2, 'the line ends before the interval and starts again after it');
  assert.equal((open.line.match(/M/g) ?? []).length, 2);
  assert.deepEqual(open.runs[0].end, { x: open.points[1].x, y: open.points[1].y }, 'the first run ends at the close before the gap (hour 1 is the last whole hour before it)');
  assert.deepEqual(open.runs[1].start, { x: open.points[2].x, y: open.points[2].y }, 'the second starts at the first close after it');
  for (const [a, b] of segments(open.line)) assert.ok(!(a <= x(gap.startTimestamp) + 1e-6 && b >= x(gap.endTimestamp) - 1e-6), `no segment spans the gap (${a} → ${b})`);
  // Each run has its own area, closed down to the floor under that run only.
  const floor = (area) => pairs(area.replace(/ Z$/, '')).slice(-2);
  assert.deepEqual(floor(open.runs[0].area).map((point) => point.y), [164, 164]);
  assert.ok(Math.abs(floor(open.runs[0].area)[0].x - open.points[1].x) < 0.01 && floor(open.runs[0].area)[1].x === 0, 'the first area ends under hour 1');
  assert.ok(Math.abs(floor(open.runs[1].area)[1].x - open.points[2].x) < 0.01 && floor(open.runs[1].area)[0].x === 340, 'the second starts under hour 10');
  assert.equal(open.end.x, 340, 'the latest close still holds to the right edge');
  // Covered quiet hours before a gap: the close holds through the last whole hour before it, and no further.
  const late = sparkGeometry({ ...history, gaps: [{ startTimestamp: first + 5 * HOUR + 1200, endTimestamp: first + 10 * HOUR }] }, 360, 164, SPARK_PAD);
  assert.equal(late.runs.length, 2);
  assert.ok(Math.abs(late.runs[0].end.x - x(first + 4 * HOUR)) < 0.02 && late.runs[0].end.y === late.points[1].y, 'hour 4 is the last whole hour covered: held there');
  for (const [a, b] of segments(late.line)) assert.ok(!(a <= x(first + 5 * HOUR + 1200) && b >= x(first + 10 * HOUR)), 'no segment spans the gap');
  // One hour between two gaps is a lone point: no line, no area (a dot, DESIGN-V2 §4.1).
  const lone = sparkGeometry({ ...history, gaps: [gap, { startTimestamp: first + 11 * HOUR, endTimestamp: first + 23 * HOUR }] }, 360, 164, SPARK_PAD);
  assert.equal(lone.runs.length, 3);
  assert.equal(lone.runs[1].area, '');
  assert.match(lone.runs[1].line, /^M[\d.]+ [\d.]+$/);
  // A history not collected up to its end: the curve ends at the last close, not at the right edge.
  const behind = sparkGeometry({ ...sparkHistory({ 0: '10', 1: '12' }), gaps: [{ startTimestamp: first + 2 * HOUR, endTimestamp: history.requestedWindow.endTimestamp }] }, 360, 164, SPARK_PAD);
  assert.equal(behind.runs.length, 1);
  assert.equal(behind.end.x, behind.points[1].x);
});

test('a stable pair rests near a level line; a pair that moved uses the whole height', () => {
  const stable = sparkGeometry(sparkHistory({ 0: '1.0000', 12: '1.0004', 23: '1.0002' }), 360, 164, SPARK_PAD);
  const ys = stable.points.map((point) => point.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) < 110 * 0.2, `a 0.04 % day spans ${Math.max(...ys) - Math.min(...ys)} px of 110`);
  const moved = sparkGeometry(sparkHistory({ 0: '0.60', 12: '0.66', 23: '0.62' }), 360, 164, SPARK_PAD);
  assert.deepEqual([Math.min(...moved.points.map((p) => p.y)), Math.max(...moved.points.map((p) => p.y))], [14, 124]);
  // Opens are never drawn, so an open never widens the scale.
  const opened = sparkHistory({ 0: '0.60', 12: '0.66', 23: '0.62' });
  opened.candles[0] = { ...opened.candles[0], open: '0.90', high: '0.90' };
  const scaled = sparkGeometry(opened, 360, 164, SPARK_PAD);
  assert.deepEqual([Math.min(...scaled.points.map((p) => p.y)), Math.max(...scaled.points.map((p) => p.y))], [14, 124]);
});

test('quiet first hours draw nothing: the line starts at the first close; one price all day is a level line at mid-height', () => {
  // Nothing traded before hour 6. Its open (10) is the price AFTER its first swap (backend public_history.py), so the
  // hours before it held a price the history does not give: nothing is drawn there, and the open widens nothing.
  const quiet = sparkHistory({ 6: '12', 7: '11' });
  quiet.candles[0] = { ...quiet.candles[0], open: '10', low: '10' };
  const late = sparkGeometry(quiet, 360, 164, SPARK_PAD);
  const drawn = pairs(late.line);
  assert.equal(late.runs.length, 1);
  assert.deepEqual(drawn[0], { x: Math.round(late.points[0].x * 100) / 100, y: 14 }, 'the first close, the day’s high, where its hour is');
  assert.ok(late.points[0].x > 80, 'well inside the card');
  assert.ok(drawn.every((point) => point.x >= drawn[0].x), 'nothing left of the first close');
  assert.ok(drawn.every((point) => point.y <= 124 + 1e-9 && point.y >= 14 - 1e-9), 'the closes alone set the scale');
  assert.equal(late.baseline, late.points[0].y, 'the level stays the first close');
  assert.equal(late.end.x, 340);
  const one = sparkGeometry(sparkHistory({ 23: '5' }), 360, 164, SPARK_PAD);
  assert.equal(one.flat, true);
  assert.equal(pairs(one.line)[0].x, Math.round(one.points[0].x * 100) / 100, 'one close: from its own hour, nothing before it');
  assert.ok(pairs(one.line).every((point) => point.y === 69), 'at mid-height');
  assert.equal(one.end.x, 340);
  const same = sparkGeometry(sparkHistory({ 0: '5', 9: '5.00', 23: '5' }), 360, 164, SPARK_PAD);
  assert.equal(same.flat, true);
  assert.equal(pairs(same.line)[0].x, 0);
  assert.ok(pairs(same.line).every((point) => point.y === 69));
  assert.equal(sparkGeometry(sparkHistory({}), 360, 164, SPARK_PAD), null, 'no close, nothing to draw');
  assert.equal(sparkGeometry(sparkHistory({ 0: 'x' }), 360, 164, SPARK_PAD), null, 'an unreadable close draws nothing');
  const unread = sparkHistory({ 0: '5', 1: '6' });
  unread.candles[0] = { ...unread.candles[0], open: 'x' };
  assert.notEqual(sparkGeometry(unread, 360, 164, SPARK_PAD), null, 'an open is never read');
});

// 2026-10-02 (the owner: the 24H / 7D / 30D / All tabs went missing): the fees card's periods are back, each cut from its
// measured start (lib/fees/periods.ts periodStart) by components/positions/visual/model.ts periodView.
test('the fees chart’s periods: the points from each measured start on, its earned value the floor, the settlements after it, All from the mint', () => {
  const { feesView, periodView } = require('../.test-build/app/src/components/positions/visual/model.js');
  const { basisOf } = require('../.test-build/app/src/components/positions/visual/value.js');
  const { periodStart } = require('../.test-build/app/src/lib/fees/periods.js');
  const T = 1_790_000_000;
  const now = T + 10 * DAY;
  const pair = (n) => [BigInt(n) * 1_000_000n, BigInt(n) * 1_000_000n];
  const point = (age, n, kind, collected = 0) => ({ block: Math.round((now - age - T) * 10) + 100, t: now - age, earned: pair(n), collected: pair(collected), kind });
  const points = [point(10 * DAY, 0, 'opened'), point(8 * DAY, 2, 'settlement', 2), point(7.1 * DAY, 3, 'reading', 2), point(25 * HOUR, 8, 'reading', 2), point(12 * HOUR, 9, 'settlement', 9), point(0, 10, 'now', 9)];
  const event = (p, kind, n) => ({ kind, block: p.block, timestamp: p.t, tx: `0x${String(p.block).padStart(64, '0')}`, fees: pair(n), liquidityDelta: kind === 'mint' ? 1000n : 0n });
  const history = { mintedAt: { block: 100, timestamp: T }, earned: pair(10), collected: pair(9), points, events: [event(points[0], 'mint', 0), event(points[1], 'collect', 2), event(points[4], 'collect', 7)], through: points[5].block };
  const currencies = [{ address: `0x${'0a'.repeat(20)}`, symbol: 'AAA', decimals: 6 }, { address: `0x${'0b'.repeat(20)}`, symbol: 'BBB', decimals: 6 }];
  const state = { block: points[5].block, timestamp: now, unclaimed: pair(1), sqrtPriceX96: 2n ** 96n, tick: 0, tickLower: -600, tickUpper: 600, liquidity: 1000n, poolId: `0x${'ab'.repeat(32)}`, currencies };
  const basis = basisOf(state);
  const view = feesView({ id: '7', state, history, basis });
  const cut = (period) => periodView(view, period, periodStart(history, period));
  const all = cut('all');
  assert.equal(all.period, 'all');
  assert.equal(all.from.kind, 'opened');
  assert.equal(all.base, 0n);
  assert.equal(all.points.length, 6);
  assert.deepEqual(all.events.map((one) => one.kind), ['mint', 'collect', 'collect'], 'the mint’s pip, where All starts, and each settlement');
  const week = cut('7d');
  assert.equal(week.period, '7d');
  assert.equal(week.from.kind, 'reading');
  assert.equal(week.start, now - 7.1 * DAY);
  assert.equal(week.end, now);
  assert.equal(week.points.length, 4, 'from the week’s start: two readings, a settlement and now');
  assert.equal(week.buckets.length, 3);
  assert.equal(week.base, view.earned * 3n / 10n, 'the floor: what was earned by the start');
  assert.equal(week.last, view.earned);
  assert.deepEqual(week.events.map((one) => one.kind), ['collect'], 'only the settlement after it; the one before is in the floor');
  assert.equal(week.points[0].t, week.start, 'the line starts at the start, on the floor');
  assert.ok(week.points[0].v > 0 && week.points[0].v < week.points.at(-1).v);
  const day = cut('24h');
  assert.equal(day.from.kind, 'reading');
  assert.equal(day.start, now - 25 * HOUR);
  assert.equal(day.points.length, 3);
  assert.equal(day.last - day.base, view.earned * 2n / 10n, 'the day’s growth: 8 to 10');
  // Each stretch's own figures: what was earned in it, and what was collected.
  assert.equal(day.buckets[0].earnedIn, view.earned / 10n);
  assert.equal(day.buckets[0].collectedIn, view.earned * 7n / 10n);
  assert.equal(day.buckets.at(-1).end, now);
});
