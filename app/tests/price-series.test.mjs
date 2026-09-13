import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
const require = createRequire(import.meta.url);
const { windowCandles, coverageHours, areaGeometry, volumeGeometry, changeOverWindow, midpoint } = require('../.test-build/app/src/lib/read/priceSeries.js');

const HOUR = 3600;
const candle = (hour, open, close, extra = {}) => ({ startTimestamp: hour * HOUR, openUsd: open, highUsd: close, lowUsd: open, closeUsd: close, volumeUsd: '0', closed: true, ...extra });
const history = (candles) => ({ intervalSeconds: HOUR, candles });
const PAD = { top: 18, right: 64, bottom: 26, left: 8 };

test('windowCandles keeps the last N hours by time, never a candle count, and fills no gap', () => {
  // Thirty hours, with the twenty-sixth missing: 29 candles spanning 30 hours.
  const hours = [...Array(30).keys()].filter((hour) => hour !== 25);
  const returned = hours.map((hour) => candle(hour, '1', '1'));
  const shuffled = [...returned].reverse();
  const before = JSON.stringify(shuffled);
  const day = windowCandles(history(shuffled), 24);
  assert.equal(JSON.stringify(shuffled), before, 'the input is left as it was');
  // The window ends at hour 30 and starts at hour 6: 24 slots, one of them empty.
  assert.deepEqual(day.map((c) => c.startTimestamp / HOUR), hours.filter((hour) => hour >= 6));
  assert.equal(day.length, 23);
  assert.deepEqual(windowCandles(history(shuffled), null).map((c) => c.startTimestamp / HOUR), hours, 'null is everything, in start order');
  assert.deepEqual(windowCandles(history(shuffled), 1).map((c) => c.startTimestamp / HOUR), [29]);
  assert.deepEqual(windowCandles(history(shuffled), 168).length, 29, 'a window wider than the coverage is still only what was returned');
  assert.deepEqual(windowCandles(history([]), 24), []);
});

test('coverageHours is the span actually returned: last end minus first start', () => {
  assert.equal(coverageHours(history([candle(0, '1', '1')])), 1);
  assert.equal(coverageHours(history([candle(5, '1', '1'), candle(0, '1', '1'), candle(2, '1', '1')])), 6, 'unsorted input, and the gaps count as span');
  assert.equal(coverageHours(history([...Array(24).keys()].map((hour) => candle(hour, '1', '1')))), 24);
  assert.equal(coverageHours(history([])), 0);
});

test('changeOverWindow: exact BigInt percent to two places, from the earliest open to the latest close', () => {
  assert.deepEqual(changeOverWindow([candle(0, '100', '105'), candle(1, '105', '110')]), { sign: 1, percentText: '+10.00%', fromUsd: '100', toUsd: '110' });
  assert.deepEqual(changeOverWindow([candle(0, '200', '199')]), { sign: -1, percentText: '−0.50%', fromUsd: '200', toUsd: '199' });
  assert.deepEqual(changeOverWindow([candle(0, '3.30', '3.3')]), { sign: 0, percentText: '0.00%', fromUsd: '3.30', toUsd: '3.3' });
  assert.equal(changeOverWindow([candle(0, '0', '5')]), null, 'no percentage of a zero open');
  assert.equal(changeOverWindow([candle(0, '0.000', '5')]), null);
  assert.equal(changeOverWindow([]), null);
});

test('changeOverWindow rounds at the third decimal, half to even, and never through a float', () => {
  const from = (open, close) => changeOverWindow([candle(0, open, close)]).percentText;
  assert.equal(from('1000', '1123.45'), '+12.34%', 'exactly half, even neighbour: stays');
  assert.equal(from('1000', '1123.55'), '+12.36%', 'exactly half, odd neighbour: rounds up');
  assert.equal(from('1000', '1123.46'), '+12.35%', 'past half: rounds up');
  assert.equal(from('1000', '1123.44'), '+12.34%', 'short of half: stays');
  assert.equal(from('1000', '876.55'), '−12.34%', 'the same rule on a fall, on the magnitude');
  assert.equal(from('1.000000000000000001', '1.05'), '+5.00%', 'mixed scales are aligned exactly');
  assert.equal(from('3', '3.00001'), '+0.00%', 'a rise too small for two places keeps its sign');
  assert.equal(changeOverWindow([candle(0, '3', '3.00001')]).sign, 1);
  assert.equal(from('0.1', '0.3'), '+200.00%', 'floats would say 199.99999999999997');
});

test('changeOverWindow orders unsorted candles by start before choosing first and last', () => {
  const unsorted = [candle(2, '50', '60'), candle(0, '100', '90'), candle(1, '90', '50')];
  assert.deepEqual(changeOverWindow(unsorted), { sign: -1, percentText: '−40.00%', fromUsd: '100', toUsd: '60' });
});

test('areaGeometry puts every close on its exact value and names the high and low as returned', () => {
  const candles = [candle(0, '1', '1'), candle(1, '1', '3'), candle(2, '3', '2')];
  const before = JSON.stringify(candles);
  const g = areaGeometry(candles, 640, 260, PAD);
  assert.equal(JSON.stringify(candles), before);
  assert.deepEqual(g.points.map((p) => p.candle), candles, 'the same candle objects, in order');
  assert.deepEqual(g.points.map((p) => p.x), [8, 292, 576], 'x is linear in start time across the inner width');
  assert.deepEqual(g.points.map((p) => p.y), [234, 18, 126], 'highest close on the top edge, lowest on the bottom edge, 2 exactly between');
  assert.equal(g.high, '3');
  assert.equal(g.low, '1');
  assert.equal(g.linePath, 'M8 234 L292 18 L576 126');
  assert.equal(g.areaPath, 'M8 234 L292 18 L576 126 L576 234 L8 234 Z');
});

test('areaGeometry keeps the provider strings, scales BigInt-exactly, and treats a gap as time', () => {
  const candles = [candle(0, '1.50', '1.50'), candle(1, '1.5', '1.5'), candle(3, '1.5', '1.500000000000000001')];
  const g = areaGeometry(candles, 640, 260, PAD);
  assert.equal(g.high, '1.500000000000000001', 'a difference in the eighteenth place is still the high');
  assert.equal(g.low, '1.50', 'ties keep the first string as returned');
  assert.deepEqual(g.points.map((p) => p.x), [8, 8 + 568 / 3, 576], 'the missing hour is a longer segment, not a point');
  assert.equal(g.points.length, 3);
  assert.deepEqual(g.points.map((p) => p.y), [234, 234, 18]);
  const flat = areaGeometry([candle(0, '2', '2'), candle(1, '2', '2')], 640, 260, PAD);
  assert.deepEqual(flat.points.map((p) => p.y), [126, 126], 'one value sits mid-height');
  assert.equal(flat.high, flat.low);
  const single = areaGeometry([candle(4, '2', '2.25')], 100, 50, { top: 5, right: 5, bottom: 5, left: 5 });
  assert.deepEqual(single.points.map((p) => [p.x, p.y]), [[50, 25]]);
  assert.equal(areaGeometry([], 640, 260, PAD), null);
  assert.equal(areaGeometry([candle(0, '1', 'n/a')], 640, 260, PAD), null, 'a non-decimal close is not drawn as anything');
  const unsorted = areaGeometry([candle(2, '1', '9'), candle(0, '1', '1')], 640, 260, PAD);
  assert.deepEqual(unsorted.points.map((p) => p.candle.startTimestamp), [0, 2 * HOUR]);
});

test('volumeGeometry centres every bar under its close point, on areaGeometry’s time scale, bottom-aligned', () => {
  const candles = [candle(0, '1', '1', { volumeUsd: '10' }), candle(1, '1', '3', { volumeUsd: '40' }), candle(2, '3', '2', { volumeUsd: '20' })];
  const before = JSON.stringify(candles);
  const v = volumeGeometry(candles, HOUR, 640, 260, PAD, 2);
  assert.equal(JSON.stringify(candles), before);
  assert.deepEqual(v.bars.map((b) => b.candle), candles, 'the same candle objects, in order');
  assert.deepEqual(v.bars.map((b) => b.cx), areaGeometry(candles, 640, 260, PAD).points.map((p) => p.x), 'each bar sits under its close point');
  assert.deepEqual(v.bars.map((b) => b.width), [282, 282, 282], 'one interval of the time scale, less the gap');
  assert.deepEqual(v.bars.map((b) => b.x), [8 - 141, 292 - 141, 576 - 141], 'x is cx − width / 2');
  assert.deepEqual(v.bars.map((b) => b.height), [54, 216, 108], 'the largest volume fills the inner height, the others in proportion');
  assert.deepEqual(v.bars.map((b) => b.y + b.height), [234, 234, 234], 'every bar stands on height − pad.bottom');
  assert.equal(v.max, '40');
});

test('volumeGeometry draws a zero volume one pixel high, and every bar so when nothing traded', () => {
  const some = volumeGeometry([candle(0, '1', '1', { volumeUsd: '0' }), candle(1, '1', '1', { volumeUsd: '5' })], HOUR, 640, 260, PAD, 2);
  assert.deepEqual(some.bars.map((b) => [b.height, b.y]), [[1, 233], [216, 18]]);
  assert.equal(some.max, '5');
  const none = volumeGeometry([candle(0, '1', '1', { volumeUsd: '0' }), candle(1, '1', '1', { volumeUsd: '0.00' })], HOUR, 640, 260, PAD, 2);
  assert.deepEqual(none.bars.map((b) => [b.height, b.y]), [[1, 233], [1, 233]], 'no division by a zero top');
  assert.equal(none.max, '0', 'ties keep the first string as returned');
});

test('volumeGeometry with one candle: the bar is mid-width like the single point, a 24th of the inner width wide, never below 1', () => {
  const pad = { top: 5, right: 5, bottom: 5, left: 5 };
  const single = volumeGeometry([candle(4, '2', '2.25', { volumeUsd: '7' })], HOUR, 100, 50, pad, 1);
  assert.deepEqual(single.bars.map((b) => [b.cx, b.x, b.width, b.y, b.height]), [[50, 48.625, 2.75, 5, 40]]);
  assert.equal(single.bars[0].cx, areaGeometry([candle(4, '2', '2.25')], 100, 50, pad).points[0].x);
  assert.equal(single.max, '7');
  assert.equal(volumeGeometry([candle(4, '2', '2.25', { volumeUsd: '7' })], HOUR, 100, 50, pad, 10).bars[0].width, 1, 'a gap wider than the slot still leaves a 1px bar');
});

test('volumeGeometry keeps the provider strings, scales BigInt-exactly, and treats a gap as time, never as a bar', () => {
  const candles = [candle(0, '1', '1', { volumeUsd: '1.50' }), candle(1, '1', '1', { volumeUsd: '1.5' }), candle(3, '1', '1', { volumeUsd: '1.500000000000000001' })];
  const v = volumeGeometry(candles, HOUR, 640, 260, PAD, 2);
  assert.equal(v.bars.length, 3, 'no bar is added for the missing hour');
  assert.deepEqual(v.bars.map((b) => b.cx), [8, 8 + 568 / 3, 576], 'the missing hour is space on the time scale, as in areaGeometry');
  assert.deepEqual(v.bars.map((b) => b.width), [568 / 3 - 2, 568 / 3 - 2, 568 / 3 - 2], 'one interval of the longer span');
  assert.deepEqual(v.bars.map((b) => b.height), [215.999, 215.999, 216], 'a difference in the eighteenth place still decides the top');
  assert.equal(v.max, '1.500000000000000001');
  const unsorted = volumeGeometry([candle(2, '1', '9', { volumeUsd: '3' }), candle(0, '1', '1', { volumeUsd: '6' })], HOUR, 640, 260, PAD, 2);
  assert.deepEqual(unsorted.bars.map((b) => b.candle.startTimestamp), [0, 2 * HOUR]);
});

test('volumeGeometry is null without candles, or when a volume is not a non-negative decimal string', () => {
  assert.equal(volumeGeometry([], HOUR, 640, 260, PAD, 2), null);
  assert.equal(volumeGeometry([candle(0, '1', '1', { volumeUsd: 'n/a' })], HOUR, 640, 260, PAD, 2), null, 'a non-decimal volume is not drawn as anything');
  assert.equal(volumeGeometry([candle(0, '1', '1', { volumeUsd: '5' }), candle(1, '1', '1', { volumeUsd: '-1' })], HOUR, 640, 260, PAD, 2), null, 'nor is a negative one');
});

test('midpoint is exact, one more place than the wider operand', () => {
  assert.equal(midpoint('1.1', '0.9'), '1.00');
  assert.equal(midpoint('3', '1'), '2.0');
  assert.equal(midpoint('0.000001', '0'), '0.0000005');
  assert.equal(midpoint('1.500000000000000001', '1.50'), '1.5000000000000000005');
  assert.equal(midpoint('x', '1'), null);
});
