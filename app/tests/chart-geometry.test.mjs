// Added 2026-09-24 (V2 foundation, DESIGN-V2 §4.1, §4.7 and R-19): the pure chart geometry in src/lib/chart.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { linearScale, logScale, niceTicks, timeTicks } = require('../.test-build/app/src/lib/chart/scale.js');
const { linePath, areaPath, areaUnder, curveFor } = require('../.test-build/app/src/lib/chart/paths.js');
const { nearestIndex, tooltipSide, buckets } = require('../.test-build/app/src/lib/chart/inspect.js');
const { rangeGeometry } = require('../.test-build/app/src/lib/chart/range.js');

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
