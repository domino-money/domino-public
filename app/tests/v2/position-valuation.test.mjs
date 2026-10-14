/**
 * The last complete valuation of a position (src/v2in/lists/valuation.ts) and the rows that read it (lists/model.ts).
 *
 * Rewritten on purpose 2026-10-14 (incident of 2026-10-13, package V1; the owner's decision D4: "the last complete figure
 * with 'as of HH:MM' in place of 'USD unavailable'"). Until then this file held the rule of #414: a valuation was kept
 * for 90 seconds, only across a failed price read, only while every amount was unchanged, and never for a row that had
 * a direct state reading. Each of those turned a late or refused read into "USD unavailable". What the cases say now:
 *   - a complete current valuation is kept with its own time, and shown with that time whenever a current one cannot
 *     be worked out (a stale reading, a stale chain, a hold after the person's action, a price read that failed);
 *   - its time is never renewed by retries, and it is of one size of position: never shown for another liquidity;
 *   - a price the source disqualified clears it, and no basis at all is no figure with a reason, never a zero.
 * The cases that held the old rule and are replaced: "retaining its original deadline" (90 s), "changed principal, fees,
 * … never borrow a previous valuation", "disqualified, stale and unread state clear USD" (stale and source outages no
 * longer clear), and "a newer direct state read cannot borrow USD" (kept as its own case: a newer reading is valued at
 * its own pool mark when it can be).
 *
 * Changed on purpose 2026-10-14 (package V1, the review of the first pass). Two assertions here held a defect and are
 * rewritten: the titles and the Details line of a figure that is not current were only "Last complete valuation, from …"
 * (an estimate at the pool's price lost its basis line exactly while it was also old: they say both now), and "as of
 * HH:MM UTC" named no day (a kept valuation can be yesterday's: the words carry the date when the moment is not today, so
 * the cases hand in the page's clock). Cases added: a kept pool-price estimate whose one priced token cannot be priced for
 * the moment (it was thrown away by the other token's standing reason), a figure that can be worked out now beside a kept
 * one, and a visitor's page taking its prices from the owner's answer this tab already holds.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { createPositionValuations, POSITION_USD_MEMORY_MS } = require('../../.test-build/app/src/v2in/lists/valuation.js');
const { USD_CURRENT_SECONDS } = require('../../.test-build/app/src/v2in/usd.js');
const { offerPositionState, positionChanged } = require('../../.test-build/app/src/v2in/lists/positionSync.js');
const { positionRows, usdAsOf } = require('../../.test-build/app/src/v2in/lists/model.js');
const { pagePrices, robinhoodPageUsd } = require('../../.test-build/app/src/v2in/position/pageValuation.js');
const { asOfFull, asOfWords, keptWords, poolEstimateWords, usdMissingShort, usdTitleWords } = require('../../.test-build/app/src/v2in/position/usdAvailability.js');
const { positionOfState, walletState } = require('../../.test-build/app/src/lib/walletCards.js');
const { basisOf, unitsText, valueOfRaw } = require('../../.test-build/app/src/components/positions/visual/value.js');
const { shortTime } = require('../../.test-build/app/src/lib/format/time.js');
const original =JSON.parse(readFileSync(new URL('../../../api-contracts/read-v6/fixtures/valid/portfolio.json', import.meta.url), 'utf8'));
const Q96 = 1n << 96n;
const E18 = 10n ** 18n;
const T0 = 1_790_000_000;

/** A memory on its own clock, and one position's inputs: 1 A at $3 and 2 B at $1.50, fees of 1 B. */
const setup = () => {
  let clock = T0 * 1000;
  const memory = createPositionValuations(() => clock);
  const ask = { key: '4663:0xmanager:1', liquidity: '1000', principal: [E18, 2n * E18], fees: [0n, E18], decimals: [18, 18], prices: ['3', '1.5'], sqrtPriceX96: 2n * Q96, readAt: T0, quotedAt: T0 + 10 };
  return { memory, ask, advance: ms => { clock += ms; } };
};

test('a complete current valuation is kept, and shown with its own time when a current one cannot be worked out', () => {
  const { memory, ask, advance } = setup();
  assert.deepEqual(memory.value(ask), { value: '6.000000000000000000', fees: '1.500000000000000000', valueBasis: 'qualified-prices', feesBasis: 'qualified-prices', at: T0 * 1000, saved: false });
  // The state route refused for five minutes: the same reading, prices five minutes newer.
  advance(300_000);
  const late = memory.value({ ...ask, quotedAt: T0 + 300 });
  assert.deepEqual(late, { value: '6.000000000000000000', fees: '1.500000000000000000', valueBasis: 'qualified-prices', feesBasis: 'qualified-prices', at: T0 * 1000, saved: true, reason: 'stale_position_or_chain' });
  // Retries never renew its time: an hour later it is still the valuation of T0.
  advance(3_600_000);
  assert.equal(memory.value({ ...ask, quotedAt: T0 + 3900 }).at, T0 * 1000);
  // A current reading replaces it, at its own time.
  const fresh = memory.value({ ...ask, readAt: T0 + 3890, quotedAt: T0 + 3900, principal: [2n * E18, 2n * E18] });
  assert.deepEqual([fresh.value, fresh.at, fresh.saved, fresh.reason], ['9.000000000000000000', (T0 + 3890) * 1000, false, undefined]);
});

test('the kept valuation is shown for a stale chain, an unknown reading time and a hold after the person’s action', () => {
  for (const [change, reason] of [
    [{ quotedAt: null }, 'stale_position_or_chain'],
    [{ readAt: null }, 'stale_position_or_chain'],
    [{ readAt: T0 - USD_CURRENT_SECONDS - 1 }, 'stale_position_or_chain'],
    [{ held: true }, 'awaiting_receipt_block'],
  ]) {
    const { memory, ask } = setup();
    assert.deepEqual(memory.value({ ...ask, ...change }), { value: null, fees: null, at: null, saved: false, reason }, 'with nothing kept: no figure, and why');
    memory.value(ask);
    const kept = memory.value({ ...ask, ...change });
    assert.deepEqual([kept.value, kept.fees, kept.at, kept.saved, kept.reason], ['6.000000000000000000', '1.500000000000000000', T0 * 1000, true, reason]);
  }
});

test('while held nothing new is worked out, even from inputs that would be current', () => {
  const { memory, ask } = setup();
  memory.value(ask);
  const held = memory.value({ ...ask, held: true, principal: [5n * E18, 0n] });
  assert.deepEqual([held.value, held.saved], ['6.000000000000000000', true], 'the valuation from before the action, with its time');
  assert.equal(memory.value(ask).saved, false, 'and the hold never cleared what was kept');
});

test('a kept valuation is of one size of position: never shown for another liquidity; amounts that moved with the price keep it', () => {
  const { memory, ask } = setup();
  memory.value(ask);
  // The pool's price moved the two amounts and the fees grew: the same position, its last complete valuation still said, dated.
  const moved = memory.value({ ...ask, quotedAt: null, principal: [2n * E18, E18], fees: [1n, 2n * E18] });
  assert.deepEqual([moved.value, moved.saved, moved.at], ['6.000000000000000000', true, T0 * 1000]);
  // A withdrawal or a compound changed its size: the figure from before would be of another position.
  assert.deepEqual(memory.value({ ...ask, quotedAt: null, liquidity: '900' }), { value: null, fees: null, at: null, saved: false, reason: 'stale_position_or_chain' });
  assert.equal(memory.value({ ...ask, quotedAt: null }).saved, true, 'a reading of the size it was worked out for (another screen may hold one) still reads it, dated');
  // Another NFT never reads it.
  memory.value(ask);
  assert.equal(memory.value({ ...ask, key: '4663:0xmanager:2', quotedAt: null }).value, null);
  assert.equal(memory.value({ ...ask, key: '8453:0xmanager:1', quotedAt: null }).value, null);
});

test('a price read that failed for the moment keeps the last valuation; a price the source disqualified clears it; a new one recovers', () => {
  for (const reason of ['price_read_failed', 'pricing_limit_reached', 'eth_usd_stale', 'sequencer_down']) {
    const { memory, ask } = setup();
    memory.value(ask);
    const kept = memory.value({ ...ask, prices: [null, null], missing: [reason, reason] });
    assert.deepEqual([kept.value, kept.saved, kept.reason], ['6.000000000000000000', true, reason], reason);
  }
  for (const reason of ['no_pool', 'pool_depth_below_floor', 'pool_depth_unmeasurable', 'decimals_unknown', 'no_qualified_price_source', 'price_below_precision']) {
    const { memory, ask } = setup();
    memory.value(ask);
    assert.deepEqual(memory.value({ ...ask, prices: [null, null], missing: [reason, reason] }), { value: null, fees: null, at: null, saved: false, reason }, reason);
    assert.equal(memory.value({ ...ask, prices: [null, null], missing: ['price_read_failed', 'price_read_failed'] }).value, null, 'a later read failure cannot undo the disqualification');
    assert.equal(memory.value(ask).saved, false);
    assert.equal(memory.value({ ...ask, quotedAt: null }).saved, true, 'a new qualified valuation is kept again');
  }
  // A disqualified currency still leaves the pair marked by the priced one at the pool's own price.
  const { memory, ask } = setup();
  memory.value(ask);
  const marked = memory.value({ ...ask, prices: ['3', null], missing: [null, 'pool_depth_below_floor'] });
  assert.deepEqual([marked.valueBasis, marked.feesBasis, marked.anchor, marked.saved], ['pool-price', 'pool-price', 0, false], 'the pool’s own price marks the unpriced side');
});

// Added 2026-10-14 (package V1, review). The owner's own kind of row, ETH / IMD, is an estimate at the pool's price: ETH
// is priced, IMD never is, and read-v6 always gives a standing reason for IMD. That standing reason cleared the kept
// valuation the moment ETH's price could not be read (the incident's own condition), so the row lost its dollars.
test('a kept pool-price estimate stays while its one priced token cannot be priced for the moment; only a disqualified price it was worked out with clears it', () => {
  for (const [passing, standing] of [['eth_usd_stale', 'pool_depth_below_floor'], ['price_read_failed', 'pool_depth_below_floor'], ['pricing_limit_reached', 'no_qualified_price_source'], ['sequencer_down', 'no_pool']]) {
    const { memory, ask, advance } = setup();
    const first = memory.value({ ...ask, block: 71, prices: ['3', null], missing: [null, standing] });
    assert.deepEqual([first.valueBasis, first.feesBasis, first.anchor, first.saved, first.reason], ['pool-price', 'pool-price', 0, false, undefined]);
    advance(60_000);
    const kept = memory.value({ ...ask, block: 99, readAt: T0 + 50, quotedAt: T0 + 60, prices: [null, null], missing: [passing, standing] });
    assert.deepEqual([kept.value, kept.fees, kept.valueBasis, kept.feesBasis, kept.anchor, kept.at, kept.saved, kept.reason], [first.value, first.fees, 'pool-price', 'pool-price', 0, T0 * 1000, true, `${passing},${standing}`], `${passing} beside ${standing}`);
    assert.equal(kept.block, 71, 'with the block it was worked out at, for its basis line');
    // A stale chain a minute later still has it to show.
    advance(60_000);
    assert.equal(memory.value({ ...ask, quotedAt: null, prices: [null, null], missing: [passing, standing] }).saved, true);
  }
  // The priced token disqualified: the estimate was worked out with its price, and goes, whatever amount of it is held.
  for (const amounts of [{}, { principal: [0n, 2n * E18], fees: [0n, E18] }]) {
    const { memory, ask } = setup();
    assert.equal(memory.value({ ...ask, ...amounts, prices: ['3', null], missing: [null, 'pool_depth_below_floor'] }).valueBasis, 'pool-price');
    assert.deepEqual(memory.value({ ...ask, ...amounts, prices: [null, null], missing: ['no_pool', 'pool_depth_below_floor'] }), { value: null, fees: null, at: null, saved: false, reason: 'no_pool,pool_depth_below_floor' });
    assert.equal(memory.value({ ...ask, ...amounts, quotedAt: null, prices: ['3', null], missing: [null, 'pool_depth_below_floor'] }).value, null, 'and it is gone for good');
  }
  // A token held in no amount when the valuation was kept had no part in it: its later disqualification clears nothing.
  const { memory, ask } = setup();
  memory.value({ ...ask, principal: [E18, 0n], fees: [E18, 0n] });
  assert.equal(memory.value({ ...ask, principal: [E18, 0n], fees: [E18, 0n], allowPoolMark: false, prices: [null, null], missing: ['price_read_failed', 'no_pool'] }).saved, true);
});

// Added 2026-10-14 (package V1, review). The kept valuation was returned whole: after Collect fees (liquidity unchanged,
// fees 0 and 0) with the prices unreadable for the moment, the row said "Fees to collect $1.50 as of HH:MM UTC" over a
// title that listed 0 + 0 tokens. A measured zero needs no price: the figure that can be worked out now is the answer
// for itself, with its own time, and only the missing one is the kept one.
test('a figure that can be worked out now is the answer for itself; only the missing one is the kept one, each with its own time', () => {
  const { memory, ask, advance } = setup();
  memory.value(ask);
  advance(90_000);
  const collected = { ...ask, readAt: T0 + 80, quotedAt: T0 + 90, fees: [0n, 0n], prices: [null, null], missing: ['price_read_failed', 'price_read_failed'] };
  assert.deepEqual(memory.value(collected), {
    value: '6.000000000000000000', fees: '0.000000000000000000', valueBasis: 'qualified-prices', feesBasis: 'qualified-prices',
    at: T0 * 1000, saved: true, now: { figure: 'fees', at: (T0 + 80) * 1000 }, reason: 'price_read_failed',
  });
  // Nothing is renewed by it: asked again later, the kept value is still the one of T0.
  advance(90_000);
  const again = memory.value({ ...collected, readAt: T0 + 170, quotedAt: T0 + 180 });
  assert.deepEqual([again.value, again.fees, again.at, again.saved, again.now], ['6.000000000000000000', '0.000000000000000000', T0 * 1000, true, { figure: 'fees', at: (T0 + 170) * 1000 }]);
  // The other way round: the value in a token that is priced, the fees in one that is not (a hooked pool: no pool mark).
  const { memory: other, ask: base } = setup();
  other.value(base);
  const half = other.value({ ...base, allowPoolMark: false, readAt: T0 + 30, quotedAt: T0 + 40, principal: [3n * E18, 0n], prices: ['3', null], missing: [null, 'price_read_failed'] });
  assert.deepEqual([half.value, half.fees, half.at, half.saved, half.now], ['9.000000000000000000', '1.500000000000000000', T0 * 1000, true, { figure: 'value', at: (T0 + 30) * 1000 }]);
  // One line says the basis of a position's estimate: two estimates of two readings are never mixed (the kept one whole).
  const { memory: marks, ask: pair } = setup();
  const first = marks.value({ ...pair, block: 71, fees: [0n, E18], prices: ['3', null], missing: [null, 'pool_depth_below_floor'] });
  assert.deepEqual([first.valueBasis, first.feesBasis], ['pool-price', 'pool-price']);
  const second = marks.value({ ...pair, block: 99, principal: null, fees: [0n, 2n * E18], prices: ['3', null], missing: [null, 'pool_depth_below_floor'] });
  assert.deepEqual([second.value, second.fees, second.saved, second.now, second.block], [first.value, first.fees, true, undefined, 71]);
});

test('with no basis ever there is no figure and a reason, never a zero; a partial figure stays partial', () => {
  const { memory, ask } = setup();
  assert.deepEqual(memory.value({ ...ask, prices: [null, null] }), { value: null, fees: null, at: null, saved: false, reason: 'token_price_unavailable' });
  assert.deepEqual(memory.value({ ...ask, prices: [null, null], missing: ['no_pool', 'pool_depth_below_floor'] }).reason, 'no_pool,pool_depth_below_floor');
  // Both currencies priced, one with unknown decimals: the fees it has none of are valued, the principal is not.
  const partial = memory.value({ ...ask, decimals: [null, 18], fees: [0n, E18] });
  assert.deepEqual(partial, { value: null, fees: '1.500000000000000000', feesBasis: 'qualified-prices', at: T0 * 1000, saved: false, reason: 'amount_unavailable' });
  assert.equal(memory.value({ ...ask, quotedAt: null }).value, null, 'a partial valuation is never kept as a complete one');
});

test('the memory is bounded: a day at most, and the oldest positions first', () => {
  const { memory, ask, advance } = setup();
  assert.equal(POSITION_USD_MEMORY_MS, 86_400_000, 'a day, as this browser’s own copy of the positions list (lib/browserCopies.ts)');
  memory.value(ask);
  advance(POSITION_USD_MEMORY_MS - 1);
  assert.equal(memory.value({ ...ask, quotedAt: null }).saved, true);
  advance(1);
  assert.equal(memory.value({ ...ask, quotedAt: null }).value, null);
  for (let id = 0; id < 600; id++) memory.value({ ...ask, key: `4663:0xmanager:${id}` });
  assert.equal(memory.value({ ...ask, key: '4663:0xmanager:0', quotedAt: null }).value, null, 'the first of 600 gave way');
  assert.equal(memory.value({ ...ask, key: '4663:0xmanager:599', quotedAt: null }).saved, true);
});

// ---------------------------------------------------------------------------
// The rows (lists/model.ts) over the same memory
// ---------------------------------------------------------------------------

const ALL = () => true;
/** The fixture's first position alone, under an id of this test's own, both of its tokens priced with decimals. */
const portfolio = (tokenId) => {
  const body = structuredClone(original);
  body.positions = [body.positions[0]];
  body.positions[0].tokenId = tokenId;
  body.positions[0].vault = null; body.vaults = []; body.mandates = [];
  body.tokens[1].decimals = 18; body.tokens[1].status = 'available';
  return body;
};
/** The state route's reading of that NFT at `block` and `timestamp`: half the indexed liquidity, fees of 1 token1. */
const stateOf = (body, block, timestamp) => {
  const position = body.positions[0], state = position.state;
  return { block, timestamp, positions: [{
    ok: true, tokenId: position.tokenId, owner: state.owner, poolId: '0x' + 'ab'.repeat(32), poolKey: state.pool,
    tickLower: state.tickLower, tickUpper: state.tickUpper, liquidity: String(BigInt(state.liquidity) / 2n),
    sqrtPriceX96: String(Q96), tick: 0, unclaimed0: '0', unclaimed1: '1000000000000000000',
    currencies: body.tokens.map(token => ({ address: token.address, symbol: token.symbol, decimals: token.decimals })),
  }] };
};

test('a newer direct state reading is valued at its own amounts and pool mark, never with the index’s older figures', () => {
  const body = portfolio('666777'), memory = createPositionValuations(() => body.servedAt * 1000);
  body.tokens[1].price = null; body.tokens[1].priceReason = 'price_read_failed';
  const indexed = positionRows(body, ALL, [], undefined, memory)[0];
  assert.equal(indexed.valueUsdBasis, 'pool-price', 'the indexed amounts at the indexed pool mark');
  offerPositionState(stateOf(body, body.positions[0].state.snapshot.number + 20, body.servedAt));
  const row = positionRows(body, ALL, [], undefined, memory)[0];
  assert.equal(row.block, body.positions[0].state.snapshot.number + 20, 'the newer direct reading is the one displayed');
  assert.equal(row.usdSavedAt, undefined);
  assert.equal(row.valueUsdBasis, 'pool-price');
  assert.equal(row.feesUsdBasis, 'pool-price');
  assert.notEqual(row.valueUsd, indexed.valueUsd, 'the previous valuation is not reused');
  assert.equal(row.feesUsd, '1000000000000.000000000000000000', 'new Q96 price converts 1e18 raw units into the 6-decimal USDG anchor, not the old pool price');
  assert.equal(row.usdAt, body.servedAt * 1000);
});

test('a state reading 90 s older than the portfolio answer still yields a figure; five minutes refused, the last valuation and its time', () => {
  const body = portfolio('666778'), memory = createPositionValuations(() => body.servedAt * 1000);
  const block = body.positions[0].state.snapshot.number + 20;
  offerPositionState(stateOf(body, block, body.servedAt - 90));
  const row = positionRows(body, ALL, [], undefined, memory)[0];
  assert.equal(row.block, block);
  assert.match(row.valueUsd, /^\d+\.\d{18}$/, '90 s is inside the two minutes: a current figure (the 60 s gate made this "USD unavailable")');
  assert.match(row.feesUsd, /^\d+\.\d{18}$/);
  assert.deepEqual([row.usdSavedAt, row.usdReason, row.usdAt], [undefined, undefined, (body.servedAt - 90) * 1000]);
  // The state route is refused for five minutes; the portfolio is read on, with new prices.
  const later = structuredClone(body);
  later.servedAt += 300;
  const kept = positionRows(later, ALL, [], undefined, memory)[0];
  assert.deepEqual([kept.valueUsd, kept.feesUsd], [row.valueUsd, row.feesUsd], 'the last complete valuation');
  assert.deepEqual([kept.usdSavedAt, kept.usdAt, kept.usdReason], [(body.servedAt - 90) * 1000, (body.servedAt - 90) * 1000, 'stale_position_or_chain'], 'with its time, and why it is not current');
  assert.ok(kept.value && kept.fees, 'the token amounts stay on the row');
  // The route answers again: current, at the new reading's time.
  offerPositionState(stateOf(body, block + 3000, later.servedAt - 5));
  const back = positionRows(later, ALL, [], undefined, memory)[0];
  assert.deepEqual([back.usdSavedAt, back.usdReason, back.usdAt], [undefined, undefined, (later.servedAt - 5) * 1000]);
});

test('with no basis the two amounts stay on the row and its reason is set; a chain that is not current never prices new amounts', () => {
  const body = portfolio('666779');
  for (const token of body.tokens) { token.price = null; token.priceReason = 'no_qualified_price_source'; }
  const none = positionRows(body, ALL, [], undefined, createPositionValuations())[0];
  assert.deepEqual([none.valueUsd, none.feesUsd, none.usdAt, none.usdSavedAt], [null, null, undefined, undefined]);
  assert.equal(none.usdReason, 'no_qualified_price_source');
  assert.deepEqual(none.value.map(amount => amount.kind), ['units', 'units'], 'both token amounts are there to draw');
  assert.deepEqual(none.fees.map(amount => amount.kind), ['units', 'zero']);
  for (const absent of [false, true]) {
    const stale = portfolio('666780');
    stale.tokens[1].price = null; stale.tokens[1].priceReason = 'pool_depth_below_floor';
    if (absent) stale.chains = [];
    else stale.chains[0].status = 'unavailable';
    const row = positionRows(stale, ALL, [], undefined, createPositionValuations())[0];
    assert.deepEqual([row.valueUsd, row.feesUsd, row.usdReason], [null, null, 'stale_position_or_chain']);
  }
});

test('after the person’s own action a held row keeps its last valuation with its time until a reading at or past the receipt’s block', () => {
  const body = portfolio('666781'), memory = createPositionValuations(() => body.servedAt * 1000);
  const position = body.positions[0], block = position.state.snapshot.number;
  const before = positionRows(body, ALL, [], undefined, memory)[0];
  assert.equal(before.usdSavedAt, undefined);
  assert.match(before.valueUsd, /^\d+\.\d{18}$/);
  positionChanged({ chainId: position.chainId, positionManager: position.positionManager, tokenIds: [position.tokenId], block: block + 50 });
  const held = positionRows(body, ALL, [], undefined, memory)[0];
  assert.deepEqual([held.valueUsd, held.feesUsd, held.usdSavedAt, held.usdReason], [before.valueUsd, before.feesUsd, before.usdAt, 'awaiting_receipt_block'], '"USD unavailable" until 2026-10-14');
  assert.equal(held.stale, 'Updating');
  offerPositionState(stateOf(body, block + 50, body.servedAt));
  const after = positionRows(body, ALL, [], undefined, memory)[0];
  assert.deepEqual([after.usdSavedAt, after.usdReason, after.block], [undefined, undefined, block + 50], 'the reading at the receipt’s block is valued as itself');
});

test('where a figure is missing or not current the words are short and plain, and never "USD unavailable"', () => {
  const said = ['awaiting_receipt_block', 'stale_position_or_chain', 'price_read_failed', 'pricing_limit_reached', 'eth_usd_stale', 'sequencer_down', 'token_price_unavailable', 'pool_depth_below_floor', 'no_pool,pool_depth_unmeasurable', 'decimals_unknown', 'amount_unavailable', undefined, null, ''].map(reason => usdMissingShort(reason));
  assert.deepEqual(said, ['Updating after your transaction', 'Waiting for a fresh reading', 'USD price is updating', 'USD price is updating', 'USD price is updating', 'USD price is updating', 'No USD price yet', 'No reliable USD price', 'No reliable USD price', 'No reliable USD price', 'No reliable USD price', 'No reliable USD price', 'No reliable USD price', 'No reliable USD price']);
  for (const words of said) {
    assert.ok(words.length <= 32 && !/unavailable/i.test(words) && !/[.:]$/.test(words), words);
  }
  // A figure that is not current: the hour and minute it is as of, in the app's one way to write a time (UTC).
  // Rewritten on purpose 2026-10-14 (package V1, review): with the day when the moment is not today by the page's clock
  // (a kept valuation lives up to a day, and a tab can sleep overnight: "as of 22:40 UTC" read as today's).
  const moment = Date.UTC(2026, 9, 14, 13, 5, 59);
  assert.equal(asOfWords(moment, Date.UTC(2026, 9, 14, 13, 8, 0)), 'as of 13:05 UTC');
  assert.equal(asOfWords(moment, Date.UTC(2026, 9, 14, 23, 59, 59)), 'as of 13:05 UTC');
  assert.equal(asOfWords(moment, Date.UTC(2026, 9, 15, 0, 0, 0)), 'as of 10-14 13:05 UTC', 'yesterday’s figure says its day');
  assert.equal(asOfWords(Date.UTC(2026, 9, 13, 22, 40, 0), Date.UTC(2026, 9, 14, 9, 0, 0)), 'as of 10-13 22:40 UTC');
  assert.equal(asOfFull(moment), '10-14 13:05 UTC');
});

test('the basis of an estimate and the time of a figure that is not current are said in the same line, never one in place of the other', () => {
  const at = Date.UTC(2026, 9, 14, 13, 5, 59);
  assert.equal(keptWords(at), 'Last complete valuation, from 10-14 13:05 UTC.');
  assert.equal(poolEstimateWords('ETH', false, 71_600_020), 'Estimated from the pool price at block 71600020, converted with ETH’s qualified USD price. This is not a sale quote.');
  assert.equal(poolEstimateWords('USDG', true, 71_600_020), 'Estimated from the pool price at block 71600020, with USDG at $1. This is not a sale quote.');
  assert.equal(poolEstimateWords('ETH', false, null), 'Estimated from the pool price, converted with ETH’s qualified USD price. This is not a sale quote.');
  assert.equal(usdTitleWords({ asOf: undefined, estimate: undefined, block: 9 }), 'Qualified valuation at block 9');
  assert.equal(usdTitleWords({ asOf: undefined, estimate: undefined, block: null }), undefined);
  assert.equal(usdTitleWords({ asOf: undefined, estimate: 'Estimated.', block: 9 }), 'Estimated.');
  assert.equal(usdTitleWords({ asOf: at, estimate: undefined, block: 9 }), 'Last complete valuation, from 10-14 13:05 UTC.');
  assert.equal(usdTitleWords({ asOf: at, estimate: 'Estimated.', block: 9 }), 'Last complete valuation, from 10-14 13:05 UTC. Estimated.');
});

// ---------------------------------------------------------------------------
// Robinhood Chain's own position page (src/v2in/position/pageValuation.ts): the same valuation as its list row
// ---------------------------------------------------------------------------

const ZERO = '0x0000000000000000000000000000000000000000';
/** The page's own read of the NFT, as it holds it (lib/walletCards.ts positionOfState), from a state reading. */
const pageOf = (answer) => ({ tokenId: answer.positions[0].tokenId, position: positionOfState(answer.positions[0]), block: answer.block, saved: false });

test('an ETH / token position shows the same dollars on its own page as in its row, at the pool’s price, with the basis said', () => {
  const body = portfolio('666790'), memory = createPositionValuations(() => body.servedAt * 1000);
  // ETH priced by read-v6 (its Chainlink price), the token not: no pair with USDG, which was all that page could value.
  const many = body.tokens[1];
  body.tokens = [{ ...many, address: ZERO, symbol: 'ETH', decimals: 18, price: { ...many.price, source: 'chainlink_eth_usd', usd: '4000.000000000000000000', pool: null, depthUsd: null } }, { ...many, price: null, priceReason: 'pool_depth_below_floor' }];
  body.positions[0].state.pool.currency0 = ZERO;
  const read = stateOf(body, body.positions[0].state.snapshot.number + 20, body.servedAt - 30);
  offerPositionState(read);
  const row = positionRows(body, ALL, [], undefined, memory)[0];
  assert.deepEqual([row.valueUsdBasis, row.feesUsdBasis, row.usdSavedAt], ['pool-price', 'pool-price', undefined]);
  const page = robinhoodPageUsd(pageOf(read), body, {}, memory);
  assert.deepEqual([page.principal, page.fees], [row.valueUsd, row.feesUsd], 'one valuation: the page and the row cannot differ');
  assert.match(page.principal, /^\d+\.\d{18}$/);
  assert.deepEqual([page.principalBasis, page.feesBasis, page.asOf, page.saved, page.why, page.quoted], ['pool-price', 'pool-price', null, false, null, true]);
  const estimate = `Estimated from the pool price at block ${read.block}, converted with ETH’s qualified USD price. This is not a sale quote.`;
  assert.deepEqual([page.principalTitle, page.feesTitle, page.detail], [estimate, estimate, estimate], 'the basis, on each figure and for Details');
  // Fees held in ETH alone need no pool mark: that figure is at ETH's own qualified price, and its title says so.
  const ethOnly = robinhoodPageUsd({ ...pageOf(read), position: { ...pageOf(read).position, unclaimedFees: ['1000000000000000', '0'] } }, body, {}, createPositionValuations());
  assert.deepEqual([ethOnly.fees, ethOnly.feesBasis, ethOnly.feesTitle, ethOnly.principalTitle], ['4.000000000000000000', 'qualified-prices', `Qualified valuation at block ${read.block}`, estimate]);
  // No newer portfolio answer for two minutes (every read failing): the same figures, saying their time.
  // Rewritten on purpose 2026-10-14 (package V1, review): the titles and Details were only "Last complete valuation,
  // from …", so the estimate lost its basis line exactly while it was also old. They say both now. The page's clock is
  // handed in, because "as of" names the day when the moment is not today.
  const now = (body.servedAt + 200) * 1000;
  const late = robinhoodPageUsd(pageOf(read), body, { late: true }, memory, now);
  assert.deepEqual([late.principal, late.asOf], [page.principal, `as of ${shortTime(body.servedAt - 30)}`]);
  const dated = `Last complete valuation, from ${asOfFull((body.servedAt - 30) * 1000)}. ${estimate}`;
  assert.deepEqual([late.principalTitle, late.feesTitle, late.detail], [dated, dated, dated], 'the time and the basis, on each figure and for Details');
  // Nor a newer reading of the NFT: the same.
  const still = robinhoodPageUsd(pageOf(read), body, { still: true }, memory, now);
  assert.deepEqual([still.asOf, still.principalTitle, still.detail], [late.asOf, dated, dated]);
  // The state route refused for five minutes, the portfolio read on: the last valuation and its time, never nothing,
  // and still said to be an estimate, of the block it was worked out at.
  const later = { ...body, servedAt: body.servedAt + 300 };
  const kept = robinhoodPageUsd(pageOf(read), later, {}, memory, later.servedAt * 1000);
  assert.deepEqual([kept.principal, kept.fees, kept.saved, kept.asOf, kept.reason], [page.principal, page.fees, true, `as of ${shortTime(body.servedAt - 30)}`, 'stale_position_or_chain']);
  assert.deepEqual([kept.principalBasis, kept.feesBasis, kept.principalTitle, kept.feesTitle, kept.detail], ['pool-price', 'pool-price', dated, dated, dated]);
  // A day later the same kept figure names its day.
  assert.equal(robinhoodPageUsd(pageOf(read), later, {}, memory, (body.servedAt + 86_000) * 1000).asOf, `as of ${asOfFull((body.servedAt - 30) * 1000)}`);
  // ETH's price cannot be read for the moment (read-v6 says "eth_usd_stale"; the token's standing reason beside it): the
  // estimate stays, with its time and its basis. It was thrown away, and the page fell back to token amounts.
  const down = structuredClone(body);
  down.tokens[0].price = null; down.tokens[0].priceReason = 'eth_usd_stale';
  const unpriced = robinhoodPageUsd(pageOf(read), down, {}, memory, now);
  assert.deepEqual([unpriced.principal, unpriced.fees, unpriced.saved, unpriced.reason], [page.principal, page.fees, true, 'eth_usd_stale,pool_depth_below_floor']);
  assert.deepEqual([unpriced.principalTitle, unpriced.detail, unpriced.why], [dated, dated, null]);
  // A copy this browser kept, or the read gateway's row, is not a reading of now: only the last valuation, dated.
  assert.deepEqual([robinhoodPageUsd({ ...pageOf(read), saved: true }, body, {}, memory).saved, robinhoodPageUsd({ ...pageOf(read), saved: true }, body, {}, createPositionValuations()).principal], [true, null]);
});

// Added 2026-10-14 (package V1, review). The same row in the list (lists/model.ts withUsd).
test('an ETH / token row keeps its dollars, their time and their basis while ETH’s price cannot be read for the moment', () => {
  const body = portfolio('666793'), memory = createPositionValuations(() => body.servedAt * 1000);
  const many = body.tokens[1];
  body.tokens = [{ ...many, address: ZERO, symbol: 'ETH', decimals: 18, price: { ...many.price, source: 'chainlink_eth_usd', usd: '4000.000000000000000000', pool: null, depthUsd: null } }, { ...many, price: null, priceReason: 'pool_depth_below_floor' }];
  body.positions[0].state.pool.currency0 = ZERO;
  const row = positionRows(body, ALL, [], undefined, memory)[0];
  const estimate = `Estimated from the pool price at block ${row.block}, converted with ETH’s qualified USD price. This is not a sale quote.`;
  assert.deepEqual([row.valueUsdBasis, row.usdSavedAt, row.usdPoolTitle], ['pool-price', undefined, estimate]);
  assert.match(row.valueUsd, /^\d+\.\d{18}$/);
  // The next answer, at a later indexed block, cannot price ETH for the moment.
  for (const reason of ['eth_usd_stale', 'price_read_failed', 'pricing_limit_reached', 'sequencer_down']) {
    const down = structuredClone(body);
    down.servedAt += 30;
    down.positions[0].state.snapshot.number += 300;
    down.tokens[0].price = null; down.tokens[0].priceReason = reason;
    const kept = positionRows(down, ALL, [], undefined, memory)[0];
    assert.deepEqual([kept.valueUsd, kept.feesUsd, kept.usdSavedAt, kept.usdReason], [row.valueUsd, row.feesUsd, body.servedAt * 1000, `${reason},pool_depth_below_floor`], reason);
    assert.deepEqual([kept.valueUsdBasis, kept.usdPoolTitle], ['pool-price', estimate], 'still said to be an estimate, of the block it was worked out at');
    assert.deepEqual([usdAsOf(kept, 'value', false), usdAsOf(kept, 'fees', false)], [body.servedAt * 1000, body.servedAt * 1000], 'each figure says its time');
  }
  // read-v6 disqualifies ETH's price: the estimate was worked out with it, and goes; the two amounts are the figure.
  const gone = structuredClone(body);
  gone.tokens[0].price = null; gone.tokens[0].priceReason = 'no_qualified_price_source';
  const none = positionRows(gone, ALL, [], undefined, memory)[0];
  assert.deepEqual([none.valueUsd, none.feesUsd, none.usdSavedAt, none.usdPoolTitle, none.usdReason], [null, null, undefined, undefined, 'no_qualified_price_source,pool_depth_below_floor']);
});

// Added 2026-10-14 (package V1, review): the list's row after Collect fees while the prices cannot be read.
test('after Collect fees with the prices unreadable the row says $0.00 of fees now, and its kept value with its time', () => {
  const body = portfolio('666794'), memory = createPositionValuations(() => body.servedAt * 1000);
  const row = positionRows(body, ALL, [], undefined, memory)[0];
  assert.match(row.feesUsd, /^0\.0\d+$/);
  assert.notEqual(row.feesUsd, '0.000000000000000000');
  const after = structuredClone(body);
  after.servedAt += 40;
  after.positions[0].state.snapshot.number += 400;
  after.positions[0].state.feesOwed = ['0', '0'];
  for (const token of after.tokens) { token.price = null; token.priceReason = 'price_read_failed'; }
  const collected = positionRows(after, ALL, [], undefined, memory)[0];
  assert.deepEqual([collected.valueUsd, collected.feesUsd, collected.usdSavedAt, collected.usdNow], [row.valueUsd, '0.000000000000000000', body.servedAt * 1000, { figure: 'fees', at: after.servedAt * 1000 }]);
  assert.deepEqual([usdAsOf(collected, 'value', false), usdAsOf(collected, 'fees', false)], [body.servedAt * 1000, undefined], 'the fees are of now: no time under them');
  assert.deepEqual([usdAsOf(collected, 'value', true), usdAsOf(collected, 'fees', true)], [body.servedAt * 1000, after.servedAt * 1000], 'and with nothing newer for two minutes, each says its own');
  // A row with nothing kept: only a current figure grown old says a time.
  assert.deepEqual([usdAsOf(row, 'value', false), usdAsOf(row, 'value', true), usdAsOf(row, 'fees', true)], [undefined, body.servedAt * 1000, body.servedAt * 1000]);
  // The page (Robinhood Chain's own) hands its two tiles the same.
  const read = stateOf(body, body.positions[0].state.snapshot.number + 500, after.servedAt - 5);
  read.positions[0].unclaimed1 = '0';
  read.positions[0].liquidity = body.positions[0].state.liquidity;
  offerPositionState(read);
  const page = robinhoodPageUsd(pageOf(read), after, {}, memory, after.servedAt * 1000);
  assert.deepEqual([page.principal, page.fees, page.saved, page.asOf, page.now], [row.valueUsd, '0.000000000000000000', true, `as of ${shortTime(body.servedAt)}`, { figure: 'fees', asOf: null }]);
  assert.deepEqual([page.principalTitle, page.feesTitle], [`Last complete valuation, from ${asOfFull(body.servedAt * 1000)}.`, `Qualified valuation at block ${read.block}`]);
});

test('with no portfolio read (no wallet connected) the page keeps its own rule: a USDG pair at the pool’s price, any other pair in tokens, no words', () => {
  const body = portfolio('666791'), memory = createPositionValuations(() => body.servedAt * 1000);
  const read = stateOf(body, body.positions[0].state.snapshot.number + 20, body.servedAt);
  offerPositionState(read);
  const reading = pageOf(read), usdg = robinhoodPageUsd(reading, null, {}, memory);
  // The page's own figures for a pair with USDG (components/positions/visual/value.ts): both amounts in USDG, 1 USDG = $1.
  const basis = basisOf(walletState(reading.position, reading.block, read.positions[0].owner));
  assert.equal(basis.kind, 'usd');
  assert.deepEqual([usdg.principal, usdg.fees], [unitsText(valueOfRaw(basis, reading.position.principal)), unitsText(valueOfRaw(basis, reading.position.unclaimedFees))], 'the very figures it has always shown');
  assert.deepEqual([usdg.principalBasis, usdg.asOf, usdg.why, usdg.quoted], ['pool-price', null, null, false], 'not read-v6’s word: the page draws its own rule itself, as before');
  assert.equal(usdg.principalTitle, `Estimated from the pool price at block ${read.block}, with USDG at $1. This is not a sale quote.`);
  // Its dollar is a constant: only its own reading can grow old, and then the figure says its time, and still its basis.
  const old = robinhoodPageUsd(reading, null, { still: true }, memory, (body.servedAt + 200) * 1000);
  assert.deepEqual([robinhoodPageUsd(reading, null, { late: true }, memory, (body.servedAt + 200) * 1000).asOf, old.asOf], [null, `as of ${shortTime(body.servedAt)}`]);
  assert.equal(old.principalTitle, `Last complete valuation, from ${asOfFull(body.servedAt * 1000)}. Estimated from the pool price at block ${read.block}, with USDG at $1. This is not a sale quote.`);
  assert.equal(old.detail, old.principalTitle);
  // read-v6 lists USDG and withholds its price: withheld here too, with its reason, never the constant over it.
  const withheld = structuredClone(body);
  for (const token of withheld.tokens) { token.price = null; token.priceReason = 'sequencer_down'; }
  assert.deepEqual((({ principal, fees, why, reason }) => [principal, fees, why, reason])(robinhoodPageUsd(reading, withheld, {}, createPositionValuations())), [null, null, 'USD price is updating', 'sequencer_down']);
  // No pair with USDG and nothing from read-v6: nothing to say; the page shows the two amounts, as before.
  const other = portfolio('666792');
  other.positions[0].state.pool.currency0 = ZERO;
  other.tokens[0] = { ...other.tokens[0], address: ZERO, symbol: 'ETH', decimals: 18 };
  const otherRead = stateOf(other, other.positions[0].state.snapshot.number + 20, other.servedAt);
  offerPositionState(otherRead);
  assert.deepEqual((({ principal, fees, why, detail, principalTitle }) => [principal, fees, why, detail, principalTitle])(robinhoodPageUsd(pageOf(otherRead), null, {}, memory)), [null, null, null, null, null]);
});

// Added 2026-10-14 (package V1, review). The page took its prices from the CONNECTED wallet's portfolio only, so "the
// page shows its row's dollars" held for an owner looking at his own position: a visitor (no wallet, or another one)
// saw the page's own USDG rule, or token amounts for ETH / token. The page now also takes the owner's answer, the one
// the owner's row is valued with, which the page's Activity already reads (the same reader and key: no request added;
// tests/v2in-browser/lists.test.mjs counts them).
test('a visitor’s page takes its prices from the owner’s portfolio answer; the connected wallet’s own word comes first', () => {
  const body = portfolio('666795'), memory = createPositionValuations(() => body.servedAt * 1000);
  const read = stateOf(body, body.positions[0].state.snapshot.number + 20, body.servedAt - 10);
  offerPositionState(read);
  const reading = pageOf(read);
  const row = positionRows(body, ALL, [], undefined, memory)[0];
  assert.equal(row.valueUsdBasis, 'qualified-prices', 'the owner’s row: both tokens at read-v6’s qualified prices');
  // A wallet that holds neither token: its portfolio lists neither.
  const mine = { ...structuredClone(body), tokens: [], positions: [] };
  assert.equal(pagePrices(reading.position, null, body), body, 'no wallet connected: the owner’s');
  assert.equal(pagePrices(reading.position, mine, body), body, 'a wallet whose answer says nothing of either token: the owner’s');
  assert.equal(pagePrices(reading.position, mine, null), mine, 'no owner’s answer held: as before');
  assert.equal(pagePrices(reading.position, null, null), null);
  const partial = { ...structuredClone(body), tokens: [body.tokens[0]] };
  assert.equal(pagePrices(reading.position, partial, body), partial, 'the connected wallet’s own answer comes first when it says anything of the pair');
  assert.equal(pagePrices(reading.position, mine, mine), mine, 'an owner’s answer that says nothing of the pair adds nothing');
  const page = robinhoodPageUsd(reading, pagePrices(reading.position, null, body), {}, memory, body.servedAt * 1000);
  assert.deepEqual([page.principal, page.fees, page.principalBasis, page.quoted, page.asOf], [row.valueUsd, row.feesUsd, 'qualified-prices', true, null], 'the row’s own dollars');
  // Without it the page falls back to its own rule: USDG at $1 and the pool's price, which is not the row's figure.
  const own = robinhoodPageUsd(reading, null, {}, createPositionValuations(() => body.servedAt * 1000), body.servedAt * 1000);
  assert.deepEqual([own.principalBasis, own.quoted], ['pool-price', false]);
  assert.notEqual(own.principal, row.valueUsd);
});
