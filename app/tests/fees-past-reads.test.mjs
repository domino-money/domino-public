/**
 * Reads of a position at chosen past blocks for the Fees earned chart's periods (src/lib/fees/pastReads.ts; restored on
 * purpose 2026-10-02, the owner: "the chart had 24 hours, 7 days and all; that went missing"): the block at a time from
 * the headers the page holds, the blocks a start and a fill are read at, the answers it takes and the ones it lets go,
 * and the runner: what it reads, how many, how far apart, one at a time, only for a verified view, and what it keeps.
 *
 * The world here is a position earning steadily on a chain of ten blocks a second, its ledger folded by the page's own
 * fold (lib/fees/ledger.ts) with this browser's readings (readings.ts), and a read source that answers read-v1
 * `nft-positions` at a block as rugged97's gateway does: the state the chain had there.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const past = require('../.test-build/app/src/lib/fees/pastReads.js');
const { BLOCKS_PER_SECOND, FILL_SPACING_MS, MAX_FILLS, MAX_READS_PER_VIEW, PAST_RELEASE_MS, START_RETRY_MS, START_SPACING_MS, anchorsOf, blockAt, createPastReads, fillTarget, parsePastRead, startTarget } = past;
const { PERIODS, periodStart } = require('../.test-build/app/src/lib/fees/periods.js');
const { foldLedger } = require('../.test-build/app/src/lib/fees/ledger.js');
const { READINGS_KEY, createReadings } = require('../.test-build/app/src/lib/fees/readings.js');
const { POSITION_MANAGER } = require('../.test-build/app/src/lib/fees/constants.js');

const ID = '3325113';
const DAY = 86_400;
const HOUR = 3_600;
const B0 = 70_000_000;
const T0 = 1_790_000_000;
const POOL = `0x${'ab'.repeat(32)}`;
const OWNER = `0x${'11'.repeat(20)}`;
const L = 10n ** 18n;
const settle = async () => { for (let i = 0; i < 6; i++) await new Promise((done) => setImmediate(done)); };

/** A memory storage for this browser's readings. */
function memoryStorage() {
  const items = new Map();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => void items.set(key, String(value)), removeItem: (key) => void items.delete(key), items };
}

/**
 * A position minted `days` ago at B0 on a chain of ten blocks a second, earning 3 and 5 units a block, settled (its
 * owner's collects) at `settledAt` (days before now). `at(block)` is a block's time (`clock` to bend it).
 */
function chainWorld({ days = 10, settledAt = [9, 8], at = (block) => T0 + Math.floor((block - B0) / 10) } = {}) {
  const head = B0 + days * 864_000;
  const blockOf = (age) => head - Math.round(age * 864_000);
  const settlements = settledAt.map(blockOf).sort((a, b) => a - b);
  const earnedAt = (block) => [3n * BigInt(block - B0), 5n * BigInt(block - B0)];
  const settledTo = (block) => settlements.filter((one) => one <= block).at(-1) ?? null;
  const unclaimedAt = (block) => {
    const last = settledTo(block);
    const [e, s] = [earnedAt(block), last === null ? [0n, 0n] : earnedAt(last)];
    return [e[0] - s[0], e[1] - s[1]];
  };
  let previous = B0;
  const entries = [{ block: B0, index: 1, tx: `0x${'01'.padStart(64, '0')}`, t: at(B0), kind: 'mint', delta: String(L), fees: ['0', '0'] }];
  for (const block of settlements) {
    const [a, b] = [earnedAt(block), earnedAt(previous)];
    entries.push({ block, index: 1, tx: `0x${block.toString(16).padStart(64, '0')}`, t: at(block), kind: 'collect', delta: '0', fees: [String(a[0] - b[0]), String(a[1] - b[1])] });
    previous = block;
  }
  const unclaimed = unclaimedAt(head);
  const ledgerState = {
    tokenId: ID, ok: true, owner: OWNER, poolId: POOL,
    poolKey: { currency0: `0x${'01'.repeat(20)}`, currency1: `0x${'02'.repeat(20)}`, fee: 3000, tickSpacing: 60, hooks: `0x${'00'.repeat(20)}` },
    currencies: [{ address: `0x${'01'.repeat(20)}`, symbol: 'AAA', decimals: 18 }, { address: `0x${'02'.repeat(20)}`, symbol: 'BBB', decimals: 18 }],
    tickLower: -6000, tickUpper: 6000, liquidity: String(L), sqrtPriceX96: (2n ** 96n).toString(), tick: 0,
    feeGrowthInside0X128: '0', feeGrowthInside1X128: '0', feeGrowthInside0LastX128: '0', feeGrowthInside1LastX128: '0', unclaimed0: String(unclaimed[0]), unclaimed1: String(unclaimed[1]),
  };
  const ledger = { position: { tokenId: ID, ok: true, through: head, state: ledgerState, mint: { block: B0, tx: entries[0].tx, t: at(B0) }, entries, exact: true }, block: head, timestamp: at(head) };
  const state = { block: head, timestamp: at(head), unclaimed, sqrtPriceX96: 2n ** 96n, tick: 0, tickLower: -6000, tickUpper: 6000, liquidity: L, poolId: POOL, owner: OWNER, currencies: ledgerState.currencies };
  /** read-v1 nft-positions at `block`, as the gateway answers it. */
  const answer = (block, patch = {}, snapshot = {}) => ({
    state: 'ok',
    data: {
      schemaVersion: 1,
      snapshot: { number: block, hash: `0x${'cd'.repeat(32)}`, timestamp: at(block), ...snapshot },
      items: [{ tokenId: ID, status: 'owner_verified_at_snapshot', owner: OWNER, positionManager: POSITION_MANAGER, poolId: POOL, tickLower: -6000, tickUpper: 6000, liquidityRaw: String(L), unsettledFeesRaw: unclaimedAt(block).map(String), principalRaw: ['1', '1'], ...patch }],
    },
  });
  return { head, now: at(head), at, blockOf, ledger, state, answer, unclaimedAt, earnedAt, settlements };
}

/** Manual time: `later` and `timer` waits, and the reads' own replies, fired in time order by `run`. */
function clock() {
  let now = 1_000_000;
  const pending = [];
  const add = (kind) => (ms, fire) => {
    const entry = { kind, due: now + ms, fire, cancelled: false };
    pending.push(entry);
    return () => void (entry.cancelled = true);
  };
  return {
    pending,
    now: () => now,
    later: add('later'),
    timer: add('timer'),
    reply: add('reply'),
    /** Fires every wait due by `until` (ms from now), in time order; `hidden`: the page is hidden, so `later` waits never fire. */
    async run(until = 10 * 60_000, { hidden = false } = {}) {
      const end = now + until;
      for (;;) {
        await settle();
        const next = pending.filter((entry) => !entry.cancelled && entry.due <= end && !(hidden && entry.kind === 'later')).sort((a, b) => a.due - b.due)[0];
        if (!next) break;
        now = Math.max(now, next.due);
        next.cancelled = true;
        next.fire();
      }
      now = Math.max(now, end);
      await settle();
    },
  };
}

/**
 * The runner over `world`: a fees store's view (the fold of its ledger with this browser's readings and the runner's
 * memory), the read source (`answer(block)` by default, each reply 400 ms later), the route listed (`listed`).
 */
function runnerFor(world, { storage = memoryStorage(), listed = true, answer = (block) => world.answer(block), phase = 'verified', time = clock() } = {}) {
  const readings = createReadings(() => storage);
  const reads = [];
  let inFlight = 0;
  let most = 0;
  const listeners = new Set();
  let runner;
  const fold = () => foldLedger(world.ledger, world.state, [...readings.get(ID), ...runner.held(ID)]);
  let view;
  const viewOf = () => {
    const now = typeof phase === 'function' ? phase() : phase;
    if (now === 'verified') return view;
    if (now === 'cached') return { ...view, phase: 'cached', savedAt: 1, source: 'public-chain-ledger' };
    if (now === 'loading') return { phase: 'loading', state: world.state };
    return { phase: now, state: world.state, reason: 'not_exact' };
  };
  runner = createPastReads({
    listed: async () => listed,
    read: (id, block) => {
      reads.push({ id, block, at: time.now() });
      inFlight += 1;
      most = Math.max(most, inFlight);
      return new Promise((done) => time.reply(400, () => {
        inFlight -= 1;
        done(answer(block, reads.length));
      }));
    },
    view: () => viewOf(),
    watch: (_id, listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    keep: (id, reading, now) => readings.insert(id, reading, now),
    redraw: () => {
      view = fold();
      for (const listener of [...listeners]) listener();
    },
    later: time.later,
    timer: time.timer,
    now: time.now,
  });
  view = fold();
  /** The store's view changed (its watchers are told). */
  const changed = () => { for (const listener of [...listeners]) listener(); };
  return { runner, reads, time, readings, storage, view: () => viewOf(), most: () => most, changed };
}

const ageOf = (world, block) => (world.now - world.at(block)) / DAY;

test('blockAt: between the headers the page holds, linear; past either end at 9.9 blocks a second; 3325113’s recorded hours within half a percent a day back', () => {
  assert.equal(BLOCKS_PER_SECOND, 9.9);
  const anchors = [{ block: 100, t: 1_000 }, { block: 1_100, t: 1_100 }];
  assert.equal(blockAt(anchors, 1_050), 600);
  assert.equal(blockAt(anchors, 1_000), 100);
  assert.equal(blockAt(anchors, 1_200), 1_100 + 990);
  assert.equal(blockAt(anchors, 900), 100 - 990);
  assert.ok(Number.isNaN(blockAt([], 1)));
  // The owner's main position as recorded on 2026-09-27: 25 hourly headers, and its state (block, time) at the head.
  const recorded = JSON.parse(gunzipSync(readFileSync(resolve(import.meta.dirname, 'support/fees/3325113.json.gz'))));
  const headers = Object.entries(recorded.headers).map(([block, t]) => ({ block: Number(block), t }));
  const head = { block: recorded.state.block, t: recorded.state.timestamp };
  assert.equal(headers.length, 25);
  for (const header of headers) {
    // From the head alone, at 9.9 blocks a second: within half a percent of the blocks back to it.
    const alone = blockAt([head], header.t);
    assert.ok(Math.abs(alone - header.block) <= 0.005 * (head.block - header.block), `${header.block}: ${alone}`);
    // Between the first hour and the head: closer still.
    const between = blockAt([headers[0], head], header.t);
    assert.ok(Math.abs(between - header.block) <= 0.002 * (head.block - headers[0].block), `${header.block}: ${between}`);
  }
  // A day back from the head: within a quarter hour of blocks.
  const day = headers.find((header) => head.t - header.t >= DAY);
  assert.ok(Math.abs(blockAt([head], day.t) - day.block) < 9_000);
  // Anchors: the mint, each settlement and each point, one per block, oldest first.
  const world = chainWorld();
  const view = foldLedger(world.ledger, world.state, []);
  assert.deepEqual(anchorsOf(view.history).map((anchor) => anchor.block), [B0, ...world.settlements, world.head]);
});

test('a start is read on its period’s grid, at least the period’s age; none where the opened point starts it; a fill at the middle of the longest stretch past a quarter of the period', () => {
  const world = chainWorld({ days: 40, settledAt: [39] });
  const history = foldLedger(world.ledger, world.state, []).history;
  for (const period of ['24h', '7d', '30d']) {
    const block = startTarget(history, period);
    const rule = PERIODS[period];
    assert.equal(block % rule.grid, 0, `${period} on its grid`);
    const age = world.now - world.at(block);
    assert.ok(age >= rule.seconds && age <= rule.window.max, `${period}: ${age / HOUR} hours`);
  }
  // A position younger than the period: its opened point starts it, nothing is read.
  const young = foldLedger(chainWorld({ days: 5, settledAt: [] }).ledger, chainWorld({ days: 5, settledAt: [] }).state, []).history;
  assert.equal(startTarget(young, '7d'), null);
  assert.notEqual(startTarget(young, '24h'), null);
  // Fills: the longest stretch first, at the grid block nearest its middle; none once no stretch is past a quarter.
  const start = { block: world.blockOf(7), t: world.now - 7 * DAY, earned: world.earnedAt(world.blockOf(7)), collected: [0n, 0n], kind: 'reading' };
  const withStart = foldLedger(world.ledger, world.state, [{ block: start.block, t: world.at(start.block), unclaimed: world.unclaimedAt(start.block) }]).history;
  const from = periodStart(withStart, '7d');
  const fill = fillTarget(withStart, '7d', from);
  assert.equal(fill % PERIODS['7d'].grid, 0);
  assert.ok(Math.abs(ageOf(world, fill) - 3.5) < 0.25, `the middle: ${ageOf(world, fill)} days`);
  const filled = foldLedger(world.ledger, world.state, [start.block, ...[5.5, 4, 2.5, 1].map(world.blockOf)].map((block) => ({ block, t: world.at(block), unclaimed: world.unclaimedAt(block) }))).history;
  assert.equal(fillTarget(filled, '7d', periodStart(filled, '7d')), null, 'every stretch a quarter or less');
});

test('an answer is taken only as the position the ledger has at that block; anything else is let go', () => {
  const world = chainWorld();
  const { history } = foldLedger(world.ledger, world.state, []);
  const block = world.blockOf(7);
  const good = parsePastRead(world.answer(block), ID, block, history, world.state);
  assert.deepEqual(good, { block, t: world.at(block), unclaimed: world.unclaimedAt(block) });
  const bad = {
    'not ok': { state: 'busy', retryAfterSeconds: 3 },
    'another block': world.answer(block + 1),
    'another snapshot': world.answer(block, {}, { number: block - 1 }),
    'not live there': world.answer(block, { status: 'position_info_empty_at_snapshot' }),
    'another id': world.answer(block, { tokenId: '7' }),
    'another PositionManager': world.answer(block, { positionManager: `0x${'99'.repeat(20)}` }),
    'another pool': world.answer(block, { poolId: `0x${'ef'.repeat(32)}` }),
    'another range': world.answer(block, { tickLower: -6060 }),
    'another liquidity': world.answer(block, { liquidityRaw: String(L + 1n) }),
    'before the mint': world.answer(B0 - 10),
    'a time past now': world.answer(block, {}, { timestamp: world.now + 1 }),
    'a time before the mint': world.answer(block, {}, { timestamp: T0 - 1 }),
    'amounts that do not parse': world.answer(block, { unsettledFeesRaw: ['-1', '2'] }),
    'one amount': world.answer(block, { unsettledFeesRaw: ['1'] }),
    'two items': { state: 'ok', data: { ...world.answer(block).data, items: [world.answer(block).data.items[0], world.answer(block).data.items[0]] } },
  };
  for (const [what, outcome] of Object.entries(bad)) assert.equal(parsePastRead(outcome, ID, block, history, world.state), null, what);
  // Asked at a block before the mint, an answer there is let go too.
  assert.equal(parsePastRead(world.answer(B0 - 10), ID, B0 - 10, history, world.state), null, 'before the mint');
});

test('route not listed, a saved copy, a history that is not exact: nothing is read; the periods a copy’s kept points start are drawn, the others not offered', async () => {
  const world = chainWorld();
  for (const options of [{ listed: false }, { listed: null }, { phase: 'cached' }, { phase: 'unclaimed-only' }]) {
    const s = runnerFor(world, options);
    const stop = ['24h', '7d', 'all'].map((period) => s.runner.subscribe(ID, period, () => {}));
    await s.time.run();
    assert.equal(s.reads.length, 0, JSON.stringify(options));
    assert.equal(s.runner.status(ID, '7d'), 'off', JSON.stringify(options));
    assert.equal(s.runner.status(ID, 'all'), options.phase === 'unclaimed-only' ? 'off' : 'drawn');
    if (options.listed === false) assert.equal(s.runner.listed(), false);
    if (options.listed === null) assert.equal(s.runner.listed(), false, 'a check that could not answer is “not here” for now');
    for (const one of stop) one();
  }
  // A saved copy whose kept points start its 24H draws it, with no read.
  const kept = runnerFor(world, { phase: 'cached' });
  const day = world.blockOf(1);
  kept.readings.insert(ID, { block: day, t: world.at(day), unclaimed: world.unclaimedAt(day) }, world.now);
  const s = runnerFor(world, { phase: 'cached', storage: kept.storage });
  s.runner.subscribe(ID, '24h', () => {});
  await s.time.run();
  assert.equal(s.runner.status(ID, '24h'), 'drawn');
  assert.equal(s.reads.length, 0);
});

test('a cold position page, default 7D: its week’s start and Your APR’s day start (2 reads), then at most 2 fills of the week; one at a time, 1.5 s and 6 s apart; a warm return reads no start', async () => {
  const world = chainWorld({ days: 10, settledAt: [9.5, 9] });
  const s = runnerFor(world);
  const seen = [];
  const card = s.runner.subscribe(ID, '7d', () => seen.push(s.runner.status(ID, '7d')));
  const apr = s.runner.subscribe(ID, '24h', () => {}, false);
  assert.equal(s.runner.status(ID, '7d'), 'reading', 'its skeleton while the start is read');
  await s.time.run(5 * 60_000);
  const starts = s.reads.slice(0, 2).map((read) => ageOf(world, read.block));
  assert.ok(starts.some((age) => age >= 1 && age <= 28 / 24), `a day back: ${starts}`);
  assert.ok(starts.some((age) => age >= 7 && age <= 7.5), `a week back: ${starts}`);
  assert.equal(s.reads.length, 4, `2 starts and 2 fills: ${s.reads.map((read) => ageOf(world, read.block).toFixed(2))}`);
  assert.equal(s.most(), 1, 'one read on its way at a time');
  assert.ok(s.reads[1].at - s.reads[0].at >= START_SPACING_MS);
  assert.ok(s.reads[2].at - s.reads[1].at >= FILL_SPACING_MS && s.reads[3].at - s.reads[2].at >= FILL_SPACING_MS);
  assert.equal(s.runner.status(ID, '7d'), 'drawn');
  assert.equal(s.runner.status(ID, '24h'), 'drawn');
  assert.ok(seen.includes('drawn'));
  // Every read is kept: the chart's points from now on, and on the next visit.
  const points = s.view().history.points.filter((point) => point.kind === 'reading').map((point) => point.block);
  assert.deepEqual(points.sort(), s.reads.map((read) => read.block).sort());
  assert.equal(JSON.parse(s.storage.getItem(READINGS_KEY)).nfts[ID].length, 4);
  // 24H wants its start only here (Your APR): no fill of the day.
  assert.ok(s.reads.slice(2).every((read) => ageOf(world, read.block) > 1.2), 'the fills are the week’s');
  card();
  apr();
  // A return within hours: both starts are kept points; nothing is read for them.
  const again = runnerFor(world, { storage: s.storage });
  again.runner.subscribe(ID, '7d', () => {});
  again.runner.subscribe(ID, '24h', () => {}, false);
  assert.equal(again.runner.status(ID, '7d'), 'drawn');
  assert.equal(again.runner.status(ID, '24h'), 'drawn');
  await again.time.run(5 * 60_000);
  assert.ok(again.reads.every((read) => ageOf(world, read.block) < 7 && ageOf(world, read.block) > 1), 'only a fill of the week, if any');
  assert.ok(again.reads.length <= 1, `at most one more fill: ${again.reads.length}`);
  // Once every stretch is a quarter of the week or less, a return reads nothing at all.
  const third = runnerFor(world, { storage: again.storage });
  third.runner.subscribe(ID, '7d', () => {});
  third.runner.subscribe(ID, '24h', () => {}, false);
  await third.time.run(5 * 60_000);
  assert.equal(third.reads.length, 0);
});

test('at most 8 reads of one NFT while a screen shows it; a new view after it leaves may read again', async () => {
  // Forty days and nothing settled since the mint: every period needs its start, and every stretch a fill.
  const world = chainWorld({ days: 40, settledAt: [] });
  const s = runnerFor(world);
  const stop = ['24h', '7d', '30d', 'all'].map((period) => s.runner.subscribe(ID, period, () => {}));
  await s.time.run(10 * 60_000);
  assert.equal(s.reads.length, MAX_READS_PER_VIEW);
  assert.equal(MAX_READS_PER_VIEW, 8);
  assert.equal(MAX_FILLS, 2);
  for (const one of stop) one();
  await s.time.run(PAST_RELEASE_MS + 1);
  // A screen that subscribes after the release starts a new view.
  s.runner.subscribe(ID, 'all', () => {});
  await s.time.run(10 * 60_000);
  assert.ok(s.reads.length > MAX_READS_PER_VIEW, 'a new view');
});

test('a start that fails is asked again after 10, 30, 60 and 120 s (never sooner than a busy answer’s Retry-After), shown unavailable meanwhile, and unavailable for the view after the last', async () => {
  const world = chainWorld({ days: 10, settledAt: [9] });
  const s = runnerFor(world, { answer: (_block, n) => (n === 1 ? { state: 'busy', retryAfterSeconds: 40 } : { state: 'unavailable' }) });
  const seen = [];
  s.runner.subscribe(ID, '7d', () => seen.push(s.runner.status(ID, '7d')));
  await s.time.run(20 * 60_000);
  assert.equal(s.reads.length, 1 + START_RETRY_MS.length);
  const said = seen.indexOf('unavailable');
  const gaps = s.reads.slice(1).map((read, i) => read.at - s.reads[i].at);
  assert.ok(gaps[0] >= 40_000, `the busy answer's 40 s: ${gaps[0]}`);
  assert.ok(gaps[1] >= START_RETRY_MS[1] && gaps[2] >= START_RETRY_MS[2] && gaps[3] >= START_RETRY_MS[3], `the ladder: ${gaps}`);
  assert.deepEqual(START_RETRY_MS, [10_000, 30_000, 60_000, 120_000]);
  assert.equal(s.runner.status(ID, '7d'), 'unavailable');
  assert.ok(said > 0 && !seen.slice(said).includes('reading'), `never back to a skeleton once it said it can’t be read: ${seen}`);
  // An answer that is not this position as the ledger has it is not asked again.
  const wrong = runnerFor(world, { answer: (block) => world.answer(block, { liquidityRaw: '1' }) });
  wrong.runner.subscribe(ID, '7d', () => {});
  await wrong.time.run(20 * 60_000);
  assert.equal(wrong.reads.length, 1);
  assert.equal(wrong.runner.status(ID, '7d'), 'unavailable');
});

test('an answer outside the window is kept as a point, and one corrected read is made with it; a second miss leaves the period unavailable', async () => {
  // The chain was slow about a week ago (one block a second for a day and a half): the straight line between the
  // settlement and now puts the week's nominal start's block too late, so the first answer is younger than 6.5 days.
  const head = B0 + 10 * 864_000;
  const slowFrom = head - 7.2 * 864_000;
  const slowTo = slowFrom + 129_600;
  const at = (block) => {
    if (block <= slowFrom) return T0 + Math.floor((block - B0) / 10);
    const base = T0 + (slowFrom - B0) / 10;
    if (block <= slowTo) return Math.floor(base + (block - slowFrom));
    return Math.floor(base + 129_600 + (block - slowTo) / 10);
  };
  const world = chainWorld({ days: 10, settledAt: [9.8], at });
  const s = runnerFor(world);
  s.runner.subscribe(ID, '7d', () => {}, false);
  await s.time.run(5 * 60_000);
  assert.equal(s.reads.length, 2, 'the read and one correction');
  const [first, second] = s.reads.map((read) => (world.now - world.at(read.block)) / DAY);
  assert.ok(first < 6.5 || first > 7.5, `the first missed: ${first}`);
  assert.ok(second >= 6.5 && second <= 7.5, `the correction landed: ${second}`);
  assert.equal(s.runner.status(ID, '7d'), 'drawn');
  assert.ok(s.view().history.points.some((point) => point.block === s.reads[0].block), 'the miss is a point too');
  // A gateway whose times never land in the window: two reads, then unavailable.
  const off = runnerFor(world, { answer: (block) => world.answer(block, {}, { timestamp: world.now - 3 * DAY - (block % 1000) }) });
  off.runner.subscribe(ID, '7d', () => {}, false);
  await off.time.run(10 * 60_000);
  assert.equal(off.reads.length, 2);
  assert.equal(off.runner.status(ID, '7d'), 'unavailable');
});

test('nothing is read after the screen leaves, nor while the page is hidden; a read on its way is kept', async () => {
  const world = chainWorld({ days: 10, settledAt: [9] });
  const left = runnerFor(world);
  const stop = left.runner.subscribe(ID, '7d', () => {});
  stop();
  await left.time.run(5 * 60_000);
  assert.equal(left.reads.length, 0, 'left before the first read was due');
  const hidden = runnerFor(world);
  hidden.runner.subscribe(ID, '7d', () => {});
  await hidden.time.run(5 * 60_000, { hidden: true });
  assert.equal(hidden.reads.length, 0, 'a hidden page reads nothing');
  await hidden.time.run(5 * 60_000);
  assert.ok(hidden.reads.length > 0, 'shown again, it reads');
  // Left while the read is on its way: its answer is still kept for the next visit, and nothing more is read.
  const going = runnerFor(world);
  const off = going.runner.subscribe(ID, '7d', () => {});
  await going.time.run(100);
  assert.equal(going.reads.length, 1);
  off();
  await going.time.run(5 * 60_000);
  assert.equal(going.reads.length, 1);
  assert.ok(going.readings.get(ID).some((reading) => reading.block === going.reads[0].block));
});

test('a 30D start older than this browser keeps its readings is held in memory for the visit, never stored', async () => {
  const world = chainWorld({ days: 40, settledAt: [39] });
  const s = runnerFor(world);
  s.runner.subscribe(ID, '30d', () => {}, false);
  await s.time.run(5 * 60_000);
  assert.equal(s.reads.length, 1);
  const block = s.reads[0].block;
  assert.ok(ageOf(world, block) >= 30);
  assert.equal(s.runner.status(ID, '30d'), 'drawn');
  assert.deepEqual(s.runner.held(ID).map((one) => one.block), [block]);
  assert.equal(s.storage.getItem(READINGS_KEY), null, 'nothing stored');
  assert.ok(s.view().history.points.some((point) => point.block === block && point.kind === 'reading'));
});

test('an answer that comes while the history is not verified (a fresh ledger on its way) ends nothing: the start is read again once it is', async () => {
  const world = chainWorld({ days: 10, settledAt: [9] });
  let phase = 'verified';
  const s = runnerFor(world, { phase: () => phase });
  s.runner.subscribe(ID, '7d', () => {}, false);
  await s.time.run(100);
  assert.equal(s.reads.length, 1, 'the start on its way');
  // A settlement since: the store asks a fresh ledger, its view loading meanwhile; the read answers then.
  phase = 'loading';
  s.changed();
  await s.time.run(1_000);
  assert.equal(s.runner.status(ID, '7d'), 'off');
  assert.equal(s.reads.length, 1, 'nothing read while there is no verified history');
  // Verified again: the start is asked again, and drawn.
  phase = 'verified';
  s.changed();
  await s.time.run(5_000);
  assert.equal(s.reads.length, 2);
  assert.equal(s.runner.status(ID, '7d'), 'drawn');
});
