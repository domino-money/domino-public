/**
 * The page's side of a position's ledger (src/lib/fees/ledger.ts, readings.ts, lib/positionApr.ts; RPC-SPEC §11.4,
 * 2026-10-02): the ledger folded with the chain's state into Fees earned and its measured points; whether a state agrees
 * with the ledger; this browser's readings; and Your APR at today's prices, since opened and from a point a day old.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { agreement, eventsOf, foldLedger } = require('../.test-build/app/src/lib/fees/ledger.js');
const { MAX_NFTS, MAX_READINGS, MAX_LIVE_READINGS, READINGS_KEY, READING_EVERY_SECONDS, READING_MAX_AGE_SECONDS, createReadings } = require('../.test-build/app/src/lib/fees/readings.js');
const { APR_MIN_SECONDS, APR_MISSING, positionApr } = require('../.test-build/app/src/lib/positionApr.js');

const HASH = (n) => `0x${n.toString(16).padStart(64, '0')}`;
const POOL = `0x${'ab'.repeat(32)}`;
const T0 = 1_790_000_000;
const B0 = 70_000_000;
const at = (block) => T0 + Math.floor((block - B0) / 10);

/** A /state position (the ledger's own state), with `patch`. */
function statePosition(patch = {}) {
  return {
    tokenId: '7', ok: true, owner: `0x${'11'.repeat(20)}`, poolId: POOL,
    poolKey: { currency0: `0x${'01'.repeat(20)}`, currency1: `0x${'02'.repeat(20)}`, fee: 3000, tickSpacing: 60, hooks: `0x${'00'.repeat(20)}` },
    currencies: [{ address: `0x${'01'.repeat(20)}`, symbol: 'AAA', decimals: 18 }, { address: `0x${'02'.repeat(20)}`, symbol: 'BBB', decimals: 18 }],
    tickLower: -6000, tickUpper: 6000, liquidity: '3000', sqrtPriceX96: (2n ** 96n).toString(), tick: 0,
    feeGrowthInside0X128: '900', feeGrowthInside1X128: '900', feeGrowthInside0LastX128: '700', feeGrowthInside1LastX128: '800', unclaimed0: '5', unclaimed1: '6',
    ...patch,
  };
}
const entry = (block, kind, delta, fees, more = {}) => ({ block, index: 1, tx: HASH(block), t: at(block), kind, delta: String(delta), fees: fees && fees.map(String), ...more });

/** A ledger read: a mint and two settlements (a collect, then an automatic compound in one block with its collect). */
function ledgerRead({ entries, exact = true, why, block = B0 + 100_000, state = statePosition() } = {}) {
  const list = entries ?? [entry(B0, 'mint', 1000, [0, 0]), entry(B0 + 10_000, 'collect', 0, [10, 20]), { ...entry(B0 + 50_000, 'collect', 0, [30, 40], { auto: true, service: ['1', '2'] }) }, { ...entry(B0 + 50_000, 'increase', 2000, [0, 0], { auto: true }), index: 2 }];
  return { position: { tokenId: '7', ok: true, through: block, state, mint: { block: B0, tx: HASH(B0), t: at(B0) }, entries: list, exact, ...(why ? { why } : {}) }, block, timestamp: at(block) };
}
const stateAt = (read, patch = {}) => ({ block: read.block, timestamp: read.timestamp, unclaimed: [5n, 6n], sqrtPriceX96: 2n ** 96n, tick: 0, tickLower: -6000, tickUpper: 6000, liquidity: 3000n, poolId: POOL, owner: `0x${'11'.repeat(20)}`, currencies: read.position.state.currencies, ...patch });

test('live readings retain a one-atom fee immediately, stay bounded, and never accept an older or negative observation', () => {
  const readings = createReadings(() => null);
  for (let i = 0; i < MAX_LIVE_READINGS + 100; i++) readings.note('7', { block: B0 + i, t: T0 + i, unclaimed: [BigInt(i), 0n] });
  assert.ok(readings.get('7').length <= MAX_LIVE_READINGS + 1, 'bounded live points plus the first compact anchor');
  assert.equal(readings.get('7').at(-1).unclaimed[0], BigInt(MAX_LIVE_READINGS + 99));
  assert.equal(readings.note('7', { block: B0 - 1, t: T0 + 1000, unclaimed: [1n, 0n] }), false);
  assert.equal(readings.note('7', { block: B0 + 1000, t: T0 + 1000, unclaimed: [-1n, 0n] }), false);
});

test('an inexact ledger preserves its on-chain mint date independently from financial qualification', () => {
  const read = ledgerRead({ entries: [], exact: false, why: 'unseen' });
  const view = foldLedger(read, stateAt(read));
  assert.equal(view.phase, 'unclaimed-only');
  assert.deepEqual(view.mintedAt, { block: B0, timestamp: at(B0) });
  assert.equal(view.history, undefined, 'knowing creation does not invent earned fees or APR');
  assert.equal(foldLedger(read, stateAt(read, { block: B0 - 1 })).mintedAt, undefined, 'a state before mint cannot claim that date');
});

test('the measured opening-block price survives exact and inexact financial histories', () => {
  for (const exact of [true, false]) {
    const read = ledgerRead({ exact, ...(exact ? {} : { why: 'unseen' }) });
    read.position.mint.sqrtPriceX96 = (2n ** 96n).toString();
    const view = foldLedger(read, stateAt(read));
    const mint = exact ? view.history.mintedAt : view.mintedAt;
    assert.equal(mint.sqrtPriceX96, read.position.mint.sqrtPriceX96);
  }
});

test('an exact ledger folded with the state: Fees earned is every settlement’s fees plus the fees ready to collect, and the chart’s points are measured ones', () => {
  const read = ledgerRead();
  const view = foldLedger(read, stateAt(read));
  assert.equal(view.phase, 'verified');
  assert.deepEqual(view.history.collected, [40n, 60n]);
  assert.deepEqual(view.history.earned, [45n, 66n]);
  assert.deepEqual(view.history.points.map((point) => [point.kind, point.block, point.earned]), [
    ['opened', B0, [0n, 0n]],
    ['settlement', B0 + 10_000, [10n, 20n]],
    ['settlement', B0 + 50_000, [40n, 60n]],
    ['now', B0 + 100_000, [45n, 66n]],
  ], 'one point for the compound’s collect and re-add in one block');
  assert.deepEqual(view.history.mintedAt, { block: B0, timestamp: at(B0) });
  assert.equal(view.history.through, read.block);
  assert.deepEqual(view.history.events.map((event) => [event.kind, event.fees, event.liquidityDelta, event.auto === true]), [['mint', [0n, 0n], 1000n, false], ['collect', [10n, 20n], 0n, false], ['collect', [30n, 40n], 0n, true], ['increase', [0n, 0n], 2000n, true]]);
  assert.deepEqual(view.history.events[2].service, [1n, 2n]);
});

test('this browser’s readings are points between the settlements, each the fees settled to it plus its unclaimed figure; one that does not fit is left out', () => {
  const read = ledgerRead();
  const readings = [
    { block: B0 + 5_000, t: at(B0 + 5_000), unclaimed: [3n, 4n] },
    { block: B0 + 30_000, t: at(B0 + 30_000), unclaimed: [12n, 15n] },
    // Past what the next settlement says was earned by then: not a measurement this ledger agrees with.
    { block: B0 + 40_000, t: at(B0 + 40_000), unclaimed: [99n, 99n] },
    // Before the mint, at a settlement's own block, and past now: never points.
    { block: B0 - 5, t: at(B0 - 5), unclaimed: [0n, 0n] },
    { block: B0 + 10_000, t: at(B0 + 10_000), unclaimed: [1n, 1n] },
    { block: B0 + 200_000, t: at(B0 + 200_000), unclaimed: [1n, 1n] },
  ];
  const view = foldLedger(read, stateAt(read), readings);
  assert.deepEqual(view.history.points.map((point) => [point.kind, point.block, point.earned]), [
    ['opened', B0, [0n, 0n]],
    ['reading', B0 + 5_000, [3n, 4n]],
    ['settlement', B0 + 10_000, [10n, 20n]],
    ['reading', B0 + 30_000, [22n, 35n]],
    ['settlement', B0 + 50_000, [40n, 60n]],
    ['now', B0 + 100_000, [45n, 66n]],
  ]);
  assert.deepEqual(view.history.points[3].collected, [10n, 20n], 'what was collected by then');
});

test('a ledger that is not exact: Fees ready to collect only, why, and its settlements for Activity (fees null where unknown)', () => {
  const read = ledgerRead({ exact: false, why: 'manual', entries: [entry(B0, 'mint', 1000, [0, 0]), entry(B0 + 1_000, 'increase', 500, null, { why: 'manual' })] });
  const view = foldLedger(read, stateAt(read));
  assert.equal(view.phase, 'unclaimed-only');
  assert.equal(view.reason, 'not_exact');
  assert.equal(view.why, 'manual');
  assert.deepEqual(view.events.map((event) => [event.kind, event.fees]), [['mint', [0n, 0n]], ['increase', null]]);
  assert.deepEqual(eventsOf(read.position)[1].fees, null);
});

test('a state agrees with its ledger when it shows the same liquidity and fee growth settled to; an older one takes the ledger up to its block', () => {
  const read = ledgerRead();
  const own = read.position.state;
  assert.equal(agreement(read, own, read.block), 'current');
  assert.equal(agreement(read, { ...own, unclaimed0: '99' }, read.block + 600), 'current', 'more fees ready to collect is no settlement');
  assert.equal(agreement(read, { ...own, feeGrowthInside0LastX128: '901' }, read.block + 600), 'stale', 'a settlement since');
  assert.equal(agreement(read, { ...own, liquidity: '3001' }, read.block + 600), 'stale');
  assert.equal(agreement(read, { ...own, liquidity: '1000' }, B0 + 20_000), 'behind', 'before the compound: the mint’s liquidity');
  assert.equal(agreement(read, { ...own, liquidity: '3000' }, B0 + 20_000), 'stale', 'a liquidity the ledger never had then');
  assert.equal(agreement(read, { ...own, tickLower: -60 }, read.block), 'stale', 'another position altogether');
  // An older state folds the ledger's settlements up to its own block only.
  const older = foldLedger(read, stateAt(read, { block: B0 + 20_000, timestamp: at(B0 + 20_000), liquidity: 1000n, unclaimed: [1n, 1n] }));
  assert.deepEqual(older.history.collected, [10n, 20n]);
  assert.deepEqual(older.history.earned, [11n, 21n]);
});

test('readings: every confirmed block is visible immediately; only hourly anchors are persisted, bounded to thirty days', () => {
  const items = new Map();
  const storage = { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value), removeItem: (key) => void items.delete(key) };
  const readings = createReadings(() => storage);
  assert.equal(readings.note('7', { block: 100, t: T0, unclaimed: [1n, 2n] }), true);
  const savedBefore = items.get(READINGS_KEY);
  assert.equal(readings.note('7', { block: 200, t: T0 + READING_EVERY_SECONDS - 1, unclaimed: [1n, 2n] }), true, 'a new block is immediately measurable');
  assert.equal(items.get(READINGS_KEY), savedBefore, 'no storage write for each refresh');
  assert.equal(readings.note('7', { block: 90, t: T0 + READING_EVERY_SECONDS, unclaimed: [1n, 2n] }), false, 'an older block');
  assert.equal(readings.note('7', { block: 300, t: T0 + READING_EVERY_SECONDS, unclaimed: [3n, 4n] }), true);
  assert.deepEqual(readings.get('7').map((one) => one.block), [100, 200, 300]);
  // A month later the first ones go.
  readings.note('7', { block: 400, t: T0 + READING_EVERY_SECONDS + READING_MAX_AGE_SECONDS + 1, unclaimed: [5n, 5n] });
  assert.deepEqual(readings.get('7').map((one) => one.block), [400]);
  // Read back by another page, as kept.
  assert.deepEqual(createReadings(() => storage).get('7').map((one) => one.block), [400]);
  assert.ok(JSON.parse(items.get(READINGS_KEY)).identity.startsWith('1:4663:'));
  // Nonsense, another chain, a storage that throws: nothing, and no error.
  items.set(READINGS_KEY, '{"identity":"1:1:0x","nfts":{"7":[[1,1,"1","1"]]}}');
  assert.deepEqual(createReadings(() => storage).get('7'), []);
  items.set(READINGS_KEY, 'not json');
  assert.deepEqual(createReadings(() => storage).get('7'), []);
  const throwing = createReadings(() => ({ getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => {} }));
  assert.equal(throwing.note('7', { block: 1, t: T0, unclaimed: [0n, 0n] }), true);
  assert.equal(createReadings(() => null).note('x', { block: 1, t: 1, unclaimed: [0n, 0n] }), false, 'an id that is not one');
  assert.ok(MAX_READINGS >= 24 * 30 && MAX_NFTS >= 8);
});

// 2026-10-02 (the chart's periods back, lib/fees/pastReads.ts): a read of the position at a past block is one of these
// readings, kept in its place among them (readings.insert) and folded like the others.
test('a read at a past block: the fees settled up to it plus its unclaimed figure; a settlement’s own block keeps the settlement’s point; one past the next settlement’s figure is dropped', () => {
  const read = ledgerRead();
  const view = foldLedger(read, stateAt(read), [
    // Between the collect (B0+10,000: 10, 20) and the compound (B0+50,000: 40, 60 settled).
    { block: B0 + 20_000, t: at(B0 + 20_000), unclaimed: [7n, 9n] },
    // At the compound's own block: the state after it, nothing ready to collect; its point is the settlement's.
    { block: B0 + 50_000, t: at(B0 + 50_000), unclaimed: [0n, 0n] },
    // More than the compound says had been earned by then: dropped.
    { block: B0 + 40_000, t: at(B0 + 40_000), unclaimed: [31n, 41n] },
  ]);
  assert.deepEqual(view.history.points.map((point) => [point.kind, point.block, point.earned]), [
    ['opened', B0, [0n, 0n]],
    ['settlement', B0 + 10_000, [10n, 20n]],
    ['reading', B0 + 20_000, [17n, 29n]],
    ['settlement', B0 + 50_000, [40n, 60n]],
    ['now', B0 + 100_000, [45n, 66n]],
  ]);
});

test('readings.insert: a past read in block order, one per block, under the thirty days and the cap; older ones are not kept (their reader holds them)', () => {
  const items = new Map();
  const storage = { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, value), removeItem: (key) => void items.delete(key) };
  const readings = createReadings(() => storage);
  const now = T0 + 40 * 86_400;
  assert.equal(readings.note('7', { block: 900, t: now - 1_800, unclaimed: [9n, 9n] }), true);
  assert.equal(readings.insert('7', { block: 500, t: now - 7 * 86_400, unclaimed: [5n, 5n] }, now), true);
  assert.equal(readings.insert('7', { block: 700, t: now - 86_400, unclaimed: [7n, 7n] }, now), true);
  assert.equal(readings.insert('7', { block: 700, t: now - 86_400, unclaimed: [7n, 7n] }, now), true, 'one at its block already');
  assert.deepEqual(readings.get('7').map((one) => one.block), [500, 700, 900], 'in block order');
  assert.equal(readings.insert('7', { block: 100, t: now - READING_MAX_AGE_SECONDS, unclaimed: [1n, 1n] }, now), false, 'thirty days old: not kept');
  assert.equal(readings.insert('x', { block: 100, t: now, unclaimed: [1n, 1n] }, now), false);
  assert.equal(readings.insert('7', { block: 100, t: now, unclaimed: [-1n, 1n] }, now), false);
  // The newest stays the newest: the hourly reading after it is measured from it.
  assert.equal(readings.note('7', { block: 950, t: now, unclaimed: [9n, 9n] }), true, 'a live sample does not wait for the persistence interval');
  assert.deepEqual(readings.get('7').map((one) => one.block), [500, 700, 900, 950]);
  assert.deepEqual(createReadings(() => storage).get('7').map((one) => one.block), [500, 700, 900], 'stored as kept');
});

// ---------------------------------------------------------------------------
// Your APR, at today's prices
// ---------------------------------------------------------------------------

const DAY = 86_400;
const Q96 = 2n ** 96n;
/** What liquidity `l` is worth at price 1 in a range of ±6,000 ticks, both tokens of 18 decimals (lib/positionApr.ts's formula). */
const worth = (l) => {
  const sqrtA = Math.pow(1.0001, -3000);
  const sqrtB = Math.pow(1.0001, 3000);
  return (l * (sqrtB - 1)) / sqrtB / 1e18 + (l * (1 - sqrtA)) / 1e18;
};
const STATE = { tickLower: -6000, tickUpper: 6000, sqrtPriceX96: Q96, timestamp: T0 + 10 * DAY, currencies: [{ address: `0x${'01'.repeat(20)}`, symbol: 'AAA', decimals: 18 }, { address: `0x${'02'.repeat(20)}`, symbol: 'BBB', decimals: 18 }] };
const history = ({ events, points, earned }) => ({ mintedAt: { block: B0, timestamp: T0 }, events, points, earned });
const mintEvent = (l) => ({ kind: 'mint', block: B0, timestamp: T0, tx: HASH(1), fees: [0n, 0n], liquidityDelta: l });
const point = (t, earned, kind = 'settlement') => ({ block: B0 + (t - T0) * 10, t, earned, collected: earned, kind });

test('Your APR since opened: every fee earned at today’s price over the money in the position, on each stretch at today’s price', () => {
  const L = 10n ** 24n;
  const earned = [10n ** 21n, 10n ** 21n];
  const h = history({ events: [mintEvent(L)], points: [point(T0, [0n, 0n], 'opened'), point(T0 + 10 * DAY, earned, 'now')], earned });
  const apr = positionApr(h, STATE, 1, 'all');
  assert.equal(apr.ok, true);
  assert.equal(apr.seconds, 10 * DAY);
  const expected = (2_000 * 365 * DAY) / (worth(1e24) * 10 * DAY);
  assert.ok(Math.abs(apr.rate - expected) / expected < 1e-9, `${apr.rate} vs ${expected}`);
  // Liquidity added halfway counts only from then: a larger denominator, a lower rate.
  const added = history({ events: [mintEvent(L), { kind: 'increase', block: B0 + 1, timestamp: T0 + 5 * DAY, tx: HASH(2), fees: [0n, 0n], liquidityDelta: L }], points: h.points, earned });
  const half = positionApr(added, STATE, 1, 'all');
  const weighted = worth(1e24) * 5 * DAY + worth(2e24) * 5 * DAY;
  assert.ok(Math.abs(half.rate - (2_000 * 365 * DAY) / weighted) / half.rate < 1e-9);
  assert.ok(half.rate < apr.rate);
});

test('Your APR over the last 24 hours only from a measured point 20 to 28 hours old; the reasons when there is no rate', () => {
  const L = 10n ** 24n;
  const now = T0 + 10 * DAY;
  const earned = [3n * 10n ** 21n, 3n * 10n ** 21n];
  const dayAgo = point(now - 23 * 3_600, [2n * 10n ** 21n, 2n * 10n ** 21n], 'reading');
  const h = history({ events: [mintEvent(L)], points: [point(T0, [0n, 0n], 'opened'), point(now - 3 * DAY, [10n ** 21n, 10n ** 21n]), dayAgo, point(now, earned, 'now')], earned });
  const day = positionApr(h, STATE, 1, '24h');
  assert.equal(day.ok, true);
  assert.equal(day.seconds, 23 * 3_600);
  const expected = (2_000 * 365 * DAY) / (worth(1e24) * 23 * 3_600);
  assert.ok(Math.abs(day.rate - expected) / expected < 1e-9);
  // No point 20 to 28 hours old: no figure.
  const none = positionApr({ ...h, points: [h.points[0], h.points[1], h.points[3]] }, STATE, 1, '24h');
  assert.deepEqual(none, { ok: false, reason: 'no_point', seconds: 0 });
  assert.equal(APR_MISSING.no_point, 'Not measured a day ago');
  // No elapsed time; confirmed zero earned; no price; nothing in the position.
  const young = history({ events: [mintEvent(L)], points: [point(T0, [0n, 0n], 'opened'), point(T0 + APR_MIN_SECONDS - 1, [1n, 1n], 'now')], earned: [1n, 1n] });
  assert.equal(positionApr(young, STATE, 1, 'all').reason, 'short');
  const zero = history({ events: [mintEvent(L)], points: [point(T0, [0n, 0n], 'opened'), point(now, [0n, 0n], 'now')], earned: [0n, 0n] });
  assert.equal(positionApr(zero, STATE, 1, 'all').ok, true);
  assert.equal(positionApr(zero, STATE, 1, 'all').rate, 0);
  assert.equal(positionApr(h, { ...STATE, currencies: [STATE.currencies[0], { ...STATE.currencies[1], decimals: null }] }, 1, 'all').reason, 'no_price');
  const empty = history({ events: [mintEvent(0n)], points: h.points, earned });
  assert.equal(positionApr(empty, STATE, 1, 'all').reason, 'empty');
});
