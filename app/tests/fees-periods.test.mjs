/**
 * The Fees earned chart's periods (src/lib/fees/periods.ts; restored on purpose 2026-10-02, the owner: "the chart had 24
 * hours, 7 days and all; that went missing"): which are offered and which one a card opens on, as before they were
 * removed; where each starts, always a measured point; and Your APR's last 24 hours from the same point.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { PERIODS, defaultPeriodFor, openedOf, periodStart, periodsFor } = require('../.test-build/app/src/lib/fees/periods.js');
const { DAY_POINT_SECONDS, positionApr } = require('../.test-build/app/src/lib/positionApr.js');

const HOUR = 3_600;
const DAY = 86_400;
const T0 = 1_790_000_000;

/** A history whose points are at these ages (seconds before now), the mint `minted` seconds ago. */
function history(minted, ages, kind = 'reading') {
  const now = T0 + minted;
  const points = [
    { block: 1, t: T0, earned: [0n, 0n], collected: [0n, 0n], kind: 'opened' },
    ...ages.sort((a, b) => b - a).map((age, i) => ({ block: 10 + i, t: now - age, earned: [BigInt(i + 1), 0n], collected: [0n, 0n], kind })),
    { block: 100, t: now, earned: [100n, 0n], collected: [0n, 0n], kind: 'now' },
  ];
  return { mintedAt: { block: 1, timestamp: T0 }, points, events: [], earned: [100n, 0n] };
}

test('the periods offered, as before they were removed: 24H always, 7D past 36 hours, 30D past 8 days, and All; All alone where no past read can be made', () => {
  assert.deepEqual(periodsFor(10 * HOUR, true), ['24h', 'all']);
  assert.deepEqual(periodsFor(36 * HOUR, true), ['24h', 'all']);
  assert.deepEqual(periodsFor(36 * HOUR + 1, true), ['24h', '7d', 'all']);
  assert.deepEqual(periodsFor(8 * DAY + 1, true), ['24h', '7d', '30d', 'all']);
  assert.deepEqual(periodsFor(90 * DAY, false), ['all'], 'the route not listed: only All, no tabs');
  // The default: All under a day, 7D once offered, else 24H.
  assert.equal(defaultPeriodFor(23 * HOUR), 'all');
  assert.equal(defaultPeriodFor(DAY), '24h');
  assert.equal(defaultPeriodFor(36 * HOUR), '24h');
  assert.equal(defaultPeriodFor(36 * HOUR + 1), '7d');
  assert.equal(defaultPeriodFor(60 * DAY), '7d');
  // The windows and grids the reads use: about an hour, six hours and a day of blocks.
  assert.deepEqual(PERIODS['24h'], { seconds: DAY, window: { min: 20 * HOUR, max: 28 * HOUR }, grid: 36_000 });
  assert.deepEqual(PERIODS['7d'], { seconds: 7 * DAY, window: { min: 6.5 * DAY, max: 7.5 * DAY }, grid: 216_000 });
  assert.deepEqual(PERIODS['30d'], { seconds: 30 * DAY, window: { min: 29 * DAY, max: 31.5 * DAY }, grid: 864_000 });
});

test('a period starts at the measured point nearest its nominal start inside its window; at the mint when it reaches back to it; nowhere otherwise', () => {
  const h = history(40 * DAY, [31 * DAY, 29.5 * DAY, 7.2 * DAY, 6.9 * DAY, 25 * HOUR, 22 * HOUR, 3 * HOUR]);
  const age = (point, of = h) => of.points.at(-1).t - point.t;
  assert.equal(periodStart(h, 'all'), h.points[0], 'All: the opened point');
  assert.equal(openedOf(h), h.points[0]);
  assert.equal(age(periodStart(h, '24h')), 25 * HOUR, 'nearest a day: 25 h over 22 h');
  assert.equal(age(periodStart(h, '7d')), 6.9 * DAY, 'nearest a week: 6.9 d over 7.2 d');
  assert.equal(age(periodStart(h, '30d')), 29.5 * DAY, 'nearest 30 days: 29.5 d over 31 d');
  // Nothing in the window: no start (a read gives one).
  const sparse = history(40 * DAY, [8 * DAY, 30 * HOUR, 18 * HOUR]);
  assert.equal(periodStart(sparse, '24h'), null);
  assert.equal(periodStart(sparse, '7d'), null);
  assert.equal(periodStart(sparse, '30d'), null);
  // Now itself is never a start, and a settlement counts like a reading.
  const settled = history(10 * DAY, [7 * DAY], 'settlement');
  assert.equal(periodStart(settled, '7d').kind, 'settlement');
  // A period that reaches back to the mint starts there (nothing earned), whatever the window says.
  const young = history(5 * DAY, [26 * HOUR]);
  assert.equal(periodStart(young, '7d').kind, 'opened');
  assert.equal(periodStart(young, '30d').kind, 'opened');
  assert.equal(age(periodStart(young, '24h'), young), 26 * HOUR, 'its 24H from the reading a day old');
  assert.equal(periodStart(history(20 * HOUR, []), '24h').kind, 'opened');
  assert.equal(periodStart({ mintedAt: { block: 1, timestamp: T0 }, points: [] }, 'all'), null);
});

test('Your APR’s last 24 hours start where the card’s 24H does; a position opened under 20 hours ago has no such line', () => {
  assert.deepEqual(DAY_POINT_SECONDS, PERIODS['24h'].window);
  const L = 10n ** 12n;
  const currencies = [{ address: '0xa', symbol: 'A', decimals: 6 }, { address: '0xb', symbol: 'B', decimals: 6 }];
  const state = (end) => ({ tickLower: -600, tickUpper: 600, currencies, sqrtPriceX96: 2n ** 96n, timestamp: end });
  const h = history(3 * DAY, [30 * HOUR, 23 * HOUR, 2 * HOUR]);
  h.events = [{ kind: 'mint', block: 1, timestamp: T0, tx: '0x1', fees: [0n, 0n], liquidityDelta: L }];
  const end = h.points.at(-1).t;
  const day = positionApr(h, state(end), 1, '24h');
  const start = periodStart(h, '24h');
  assert.equal(day.ok, true);
  assert.equal(day.seconds, end - start.t);
  assert.deepEqual(day.from, { t: start.t, block: start.block }, 'the line says where it starts');
  assert.deepEqual(positionApr(h, state(end), 1, 'all').from, { t: T0, block: 1 });
  // Opened 10 hours ago: its 24H starts at the mint, which says nothing more than since opened.
  const young = history(10 * HOUR, [5 * HOUR]);
  young.events = h.events;
  assert.deepEqual(positionApr(young, state(young.points.at(-1).t), 1, '24h'), { ok: false, reason: 'no_point', seconds: 0 });
});
