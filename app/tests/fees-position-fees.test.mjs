/**
 * Fees earned and Your APR from read-v6 1.2.0-rc.1's `position-fees` (src/lib/fees/positionFees.ts; the owner, 2026-11-04:
 * every chain the same as Robinhood Chain): the package's own fixtures as the view Robinhood Chain's card and tile draw,
 * its periods and rate from the same code, and every state that has no figure saying none.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as runtime from '../../api-contracts/read-v6/runtime.mjs';

const require = createRequire(import.meta.url);
const { positionFeesView, stateOfNow } = require('../.test-build/app/src/lib/fees/positionFees.js');
const { periodStart, periodsFor } = require('../.test-build/app/src/lib/fees/periods.js');
const { positionApr } = require('../.test-build/app/src/lib/positionApr.js');
const { basisOf, valueNumber, valueUnits, unitsText } = require('../.test-build/app/src/components/positions/visual/value.js');
const { feesEvents, feesView, periodView } = require('../.test-build/app/src/components/positions/visual/model.js');

const fixture = (name) => JSON.parse(readFileSync(new URL(`../../api-contracts/read-v6/fixtures/1.2.0-rc.1/valid/${name}.json`, import.meta.url), 'utf8'));
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const tokenOf = (address) => (address === WETH ? { symbol: 'WETH', decimals: 18 } : address === USDC ? { symbol: 'USDC', decimals: 6 } : { symbol: null, decimals: null });

test('the fixtures this test reads are the contract\'s', () => {
  for (const name of ['position-fees', 'position-fees-reading', 'position-fees-burned', 'position-fees-not-followed', 'position-fees-inexact', 'position-fees-truncated']) {
    assert.equal(runtime.validateResponse('position-fees', fixture(name)), true, name);
  }
});

test('a followed v4 position is the verified history Robinhood Chain\'s card draws: settled plus unsettled, measured points only', () => {
  const position = fixture('position-fees').positions[0];
  const view = positionFeesView(position, tokenOf);
  assert.equal(view.phase, 'verified');
  const { history, state } = view;
  assert.deepEqual(history.earned, [BigInt(position.now.earned[0]), BigInt(position.now.earned[1])]);
  assert.deepEqual(history.collected, [BigInt(position.now.settled[0]), BigInt(position.now.settled[1])]);
  assert.deepEqual(state.unclaimed, [BigInt(position.now.collectable[0]), BigInt(position.now.collectable[1])]);
  assert.equal(history.earned[0], history.collected[0] + state.unclaimed[0], 'earned = collected + ready to collect');
  assert.equal(history.earned[1], history.collected[1] + state.unclaimed[1]);
  assert.equal(history.fromFloor, undefined);
  assert.deepEqual(history.mintedAt, { block: position.since.block.number, timestamp: position.since.block.timestamp });
  // Opened (nothing), then the settlements and the stored points, then now. The fixture's day point reads less than the
  // settlement before it: earned only grows, so that point is left out, as ./ledger.ts foldLedger leaves out such a reading.
  assert.deepEqual(history.points.map((point) => point.kind), ['opened', 'settlement', 'settlement', 'reading', 'reading', 'now']);
  assert.deepEqual(history.points[0].earned, [0n, 0n]);
  for (let i = 1; i < history.points.length; i++) {
    assert.ok(history.points[i].t > history.points[i - 1].t, 'time only goes forward');
    assert.ok(history.points[i].earned[0] >= history.points[i - 1].earned[0], 'earned only grows');
  }
  assert.equal(history.points.at(-1).block, position.now.snapshot.number);
  // The mint's increase is the mint; an automatic compound keeps its service fee.
  assert.deepEqual(history.events.map((event) => event.kind), ['mint', 'collect', 'increase']);
  assert.equal(history.events[2].auto, true);
  assert.deepEqual(history.events[2].service, [BigInt(position.events[2].serviceFee[0]), BigInt(position.events[2].serviceFee[1])]);
  assert.equal(state.currencies[0].symbol, 'WETH');
  assert.equal(state.poolId, position.now.poolId);
});

test('its periods and its rate come from the code Robinhood Chain uses, with no read at a past block', () => {
  const position = fixture('position-fees').positions[0];
  const { history, state } = positionFeesView(position, tokenOf);
  const span = history.points.at(-1).t - history.mintedAt.timestamp;
  assert.deepEqual(periodsFor(span, true), ['24h', '7d', 'all']);
  assert.equal(periodStart(history, 'all'), history.points[0]);
  assert.ok(periodStart(history, '7d'), 'a stored point stands for the start of 7D');
  const all = positionApr(history, state, 1, 'all');
  assert.equal(all.ok, true);
  assert.ok(all.rate > 0);
  assert.equal(all.seconds, position.now.snapshot.timestamp - position.since.block.timestamp);
  const basis = basisOf(state, undefined, { into: 1, usd: '1.000000000000000000' });
  const view = feesView({ id: '8453:4:41', state, history, basis });
  const pv = periodView(view, 'all', periodStart(history, 'all'));
  assert.equal(pv.points.length, history.points.length);
  assert.equal(pv.buckets.length, history.points.length - 1);
});

test('a v3 position minted before the floor: exact since then, with what it already held counted for the rate and listed nowhere', () => {
  const position = fixture('position-fees').positions[1];
  const view = positionFeesView(position, tokenOf);
  assert.equal(view.phase, 'verified');
  assert.equal(view.history.fromFloor, true);
  assert.equal(view.history.events[0].kind, 'collect');
  assert.equal(view.history.events[0].liquidityDelta, BigInt(position.events[0].liquidity) - BigInt(position.events[0].liquidityDelta));
  const basis = basisOf(view.state, undefined, { into: 1, usd: '1.000000000000000000' });
  assert.deepEqual(feesEvents('x', view.history.events, basis, view.state.currencies).map((event) => event.kind), ['collect'], 'only the real collect is listed');
  assert.equal(positionApr(view.history, view.state, 1, 'all').ok, true);
  // On v3 what a collect pays now holds `tokensOwed`: it is not collected yet, and the split still adds up to Fees earned.
  assert.deepEqual(view.state.unclaimed, [BigInt(position.now.collectable[0]), BigInt(position.now.collectable[1])]);
  assert.equal(view.history.collected[0] + view.state.unclaimed[0], view.history.earned[0]);
});

test('every state without a figure says none: still reading, burned, nobody following, not exact', () => {
  const only = (name) => fixture(name).positions[0];
  assert.deepEqual(positionFeesView(only('position-fees-reading'), tokenOf), { phase: 'loading', state: null });
  assert.deepEqual(positionFeesView(only('position-fees-burned'), tokenOf), { phase: 'unavailable', reason: 'not_found' });
  assert.deepEqual(positionFeesView(only('position-fees-not-followed'), tokenOf), { phase: 'unavailable', reason: 'not_found' });
  const inexact = positionFeesView(only('position-fees-inexact'), tokenOf);
  assert.equal(inexact.phase, 'unclaimed-only');
  assert.equal(inexact.reason, 'not_exact');
  assert.ok(['same_block', 'liquidity'].includes(inexact.why));
  assert.ok(inexact.events.some((event) => event.fees === null));
});

test('a truncated answer keeps its exact figures, and the liquidity before its oldest event', () => {
  const position = fixture('position-fees-truncated').positions[0];
  const view = positionFeesView(position, tokenOf);
  assert.equal(view.phase, 'verified');
  assert.deepEqual(view.history.earned, [BigInt(position.now.earned[0]), BigInt(position.now.earned[1])]);
  assert.equal(positionApr(view.history, view.state, 1, 'all').ok, true);
});

test('points sharing a chain second keep one, the settlement after both of a block', () => {
  const base = fixture('position-fees').positions[0];
  const stamped = structuredClone(base);
  stamped.points = [];
  stamped.events[2].block.timestamp = stamped.events[1].block.timestamp;
  const { history } = positionFeesView(stamped, tokenOf);
  assert.deepEqual(history.points.map((point) => point.kind), ['opened', 'settlement', 'now']);
  assert.deepEqual(history.points[1].earned, [BigInt(base.events[2].settled[0]), BigInt(base.events[2].settled[1])]);
});

test('a qualified price values a pair with no USDG in USD; none leaves it in its quote token', () => {
  const state = stateOfNow(fixture('position-fees').positions[0].now, tokenOf);
  const quote = basisOf(state);
  assert.equal(quote.kind, 'quote');
  assert.equal(quote.usd, undefined);
  const stable = basisOf(state, undefined, { into: 1, usd: '1.000000000000000000' });
  assert.equal(stable.kind, 'usd');
  assert.equal(stable.into, 1);
  assert.equal(stable.symbol, null);
  const usdc = 2_000_000n;
  assert.equal(unitsText(valueUnits(stable, [0n, usdc])), unitsText(valueUnits({ ...stable, usd: undefined }, [0n, usdc])), 'the stable at 1 changes nothing');
  assert.equal(Number(unitsText(valueUnits(stable, [0n, usdc]))), 2);
  const eth = basisOf(state, undefined, { into: 0, usd: '3000.000000000000000000' });
  assert.equal(Number(unitsText(valueUnits(eth, [10n ** 18n, 0n]))), 3000);
  assert.equal(valueNumber(eth, [10n ** 18n, 0n]), 3000);
  assert.equal(basisOf(state, undefined, { into: 0, usd: '0' }).kind, 'quote', 'a price that is not one is not used');
  assert.equal(basisOf(state, undefined, { into: 0, usd: 'x' }).kind, 'quote');
  assert.equal(basisOf(state, undefined, null).kind, 'quote');
});
