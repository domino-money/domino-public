/**
 * New position's zap path, its pure model (src/v2in/journey/model, the integrated journey of 2026-10-02; spec F7 rev2
 * §1.2, §1.4, §2.4, §2.6.1, §2.6.5, §7.5, §8.2 "S1, criar"): which journey a network gets under each gate mode (no
 * network choice exists: the owner, 2026-10-02 night); the pools a person may indicate (sorted currencies, no native ETH
 * on v3, Base's extra v3 tiers, v4's four pairs, hooked pools never offered); V1's list pools taken as PoolRefs; the price
 * written per chain (the chain's stable as the quote); the journey machine's checks; and the plan request it forms (the
 * §7.5 starting price exact). No fixture plans and no test examples (real data only, the owner, 2026-10-02): the model
 * carries none, and this file asks for none.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as runtime from '../../../api-contracts/position-plan-v1/runtime.mjs';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const routing = require(`${BUILD}v2in/journey/model/routing.js`);
const pools = require(`${BUILD}v2in/journey/model/pools.js`);
const price = require(`${BUILD}v2in/journey/model/price.js`);
const machine = require(`${BUILD}v2in/journey/model/state.js`);
const { planRequestWire } = require(`${BUILD}v2/plan/request.js`);
const constants = require(`${BUILD}v2in/journey/constants.js`);

const ZERO = '0x0000000000000000000000000000000000000000';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';

// Changed on purpose 2026-10-05 (the owner: his New position screens, as he built them): Robinhood Chain keeps his journey
// whatever its gate says; the zap path's screens only behind "Create a new pool (advanced)" (2026-10-04's switch undone).
test('routing: Robinhood Chain keeps the owner\'s journey whatever its gate says; Base and Arbitrum One open with their gate', () => {
  assert.equal(constants.SETUP_STAYS_WHILE_PREVIEW, true);
  assert.equal(constants.JOURNEY_STAYS_ON_ROBINHOOD, true, 'his journey on Robinhood Chain, live gate included');
  assert.equal(routing.routeFor(4663, 'off'), 'setup');
  assert.equal(routing.routeFor(4663, 'preview'), 'setup');
  assert.equal(routing.routeFor(4663, 'live'), 'setup');
  assert.equal(routing.routeFor(4663, 'live', true, false), 'zap', 'the zap path\'s screens, one constant away');
  assert.equal(routing.routeFor(4663, 'preview', false, false), 'zap', 'and under preview, two constants away');
  for (const chainId of [8453, 42161]) {
    assert.equal(routing.routeFor(chainId, 'off'), 'closed');
    assert.equal(routing.routeFor(chainId, 'preview'), 'zap');
    assert.equal(routing.routeFor(chainId, 'live'), 'zap');
  }
  assert.equal(routing.robinhoodFinderOpen('preview'), true, 'pools today\'s journey cannot open (v3, a new pool) take the zap path wherever the gate is open');
  assert.equal(routing.robinhoodFinderOpen('off'), false);
  assert.equal(routing.networkChoices, undefined, 'no network choice exists (the owner, 2026-10-02 night)');
});

test('pools a person indicates: currencies sorted, native ETH first on v4, none on v3; the same token twice refused', () => {
  assert.deepEqual(pools.poolOf(4, USDC_BASE, ZERO, 500, 10), { dex: 4, currency0: ZERO, currency1: USDC_BASE, fee: 500, tickSpacing: 10, hooks: ZERO });
  assert.deepEqual(pools.poolOf(3, USDC_BASE, WETH_BASE, 500, 10), { dex: 3, currency0: WETH_BASE, currency1: USDC_BASE, fee: 500, tickSpacing: 10, hooks: ZERO });
  assert.equal(pools.poolOf(3, ZERO, USDC_BASE, 500, 10), null, 'v3 holds no native ETH');
  assert.equal(pools.poolOf(4, USDC_BASE, USDC_BASE.toUpperCase().replace('0X', '0x'), 500, 10), null);
});

test('fee tiers: v3 the profile\'s, Base\'s extra 0.02/0.03/0.04% (fee 200/300/400 → spacing 4/6/8) on Base only; v4 the four v3 pairs (decision #26)', () => {
  const base = pools.tiersOf(8453, 3)
  assert.deepEqual(base, [{ fee: 100, tickSpacing: 1 }, { fee: 200, tickSpacing: 4 }, { fee: 300, tickSpacing: 6 }, { fee: 400, tickSpacing: 8 }, { fee: 500, tickSpacing: 10 }, { fee: 3000, tickSpacing: 60 }, { fee: 10000, tickSpacing: 200 }]);
  for (const chainId of [4663, 42161]) assert.deepEqual(pools.tiersOf(chainId, 3).map((t) => t.fee), [100, 500, 3000, 10000]);
  for (const chainId of [4663, 8453, 42161]) assert.deepEqual(pools.tiersOf(chainId, 4), [{ fee: 100, tickSpacing: 1 }, { fee: 500, tickSpacing: 10 }, { fee: 3000, tickSpacing: 60 }, { fee: 10000, tickSpacing: 200 }]);
  assert.equal(pools.feePercent(200), '0.02%');
  assert.equal(pools.feePercent(3000), '0.3%');
});

test('hooked v4 pools are never offered (decision #6); V1\'s list pools become the same PoolRef, and a hooked or malformed one none', () => {
  assert.equal(constants.JOURNEY_HOOKED_POOLS_SHOWN, false);
  assert.equal(pools.offeredPool({ hooks: ZERO }), true);
  assert.equal(pools.offeredPool({ hooks: '0x00000000000000000000000000000000000000c0' }), false);
  const option = {
    key: '0x' + 'ab'.repeat(32),
    currencies: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: USDG, symbol: 'USDG', decimals: 6 }],
    feePips: 3000, tickSpacing: 60, hooks: ZERO, tick: -199020, sqrtPriceX96: '3756254281219003000000000', block: 78_000_000, readAt: 1000,
  };
  const pool = pools.poolFromList(option);
  assert.deepEqual(pool.pool, { dex: 4, currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: ZERO });
  assert.equal(pool.chainId, 4663);
  assert.equal(pool.source, 'list');
  assert.equal(pool.initialized, true);
  assert.equal(pools.poolFromList({ ...option, hooks: '0x00000000000000000000000000000000000000c0' }), null);
  assert.equal(pools.poolFromList({ ...option, sqrtPriceX96: 'nope' }), null);
});

test('prices per chain: the chain\'s stable is the quote (USDC on Base and Arbitrum One, USDG on Robinhood Chain), then ETH/WETH, else the pool\'s order', () => {
  assert.equal(price.quoteRankOn(8453, USDC_BASE), 2);
  assert.equal(price.quoteRankOn(8453, WETH_BASE), 1);
  assert.equal(price.quoteRankOn(8453, ZERO), 1);
  assert.equal(price.quoteRankOn(8453, USDG), 0, 'Robinhood\'s stable is no quote on Base');
  assert.equal(price.priceInvertedOn(8453, WETH_BASE, USDC_BASE), false, '1 WETH = X USDC, the pool\'s own order');
  assert.equal(price.priceInvertedOn(8453, ZERO, USDC_BASE), false);
  const tokens = [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: USDC_BASE, symbol: 'USDC', decimals: 6 }];
  const at = price.priceAt({ chainId: 8453, currency0: ZERO, currency1: USDC_BASE, tokens, sqrtPriceX96: 3961408125713216879677197n, tick: -198080, tickSpacing: 10, block: 1n, readAt: null, now: 0 });
  assert.equal(at.state, 'usable');
  assert.match(at.text, /^≈2,49\d/);
  assert.equal(at.base.symbol, 'ETH');
  assert.equal(at.quote.symbol, 'USDC');
  const unknown = price.priceAt({ chainId: 8453, currency0: ZERO, currency1: USDC_BASE, tokens: [tokens[0], { ...tokens[1], decimals: null }], sqrtPriceX96: 3961408125713216879677197n, tick: -198080, tickSpacing: 10, block: 1n, readAt: null, now: 0 });
  assert.deepEqual(unknown, { state: 'unavailable', problem: 'decimals_unknown', block: 1 }, 'decimals never guessed');
});

const ethUsdc = (over = {}) => ({
  chainId: 8453, pool: { dex: 4, currency0: ZERO, currency1: USDC_BASE, fee: 500, tickSpacing: 10, hooks: ZERO }, id: '0x' + '12'.repeat(32), exists: true, initialized: true,
  sqrtPriceX96: 3961408125713216879677197n, tick: -198080, tokens: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: USDC_BASE, symbol: 'USDC', decimals: 6 }], block: 1n, readAt: 0, source: 'wallet', ...over,
});

test('the journey machine: a pool, a range on its spacing, at least one amount and a slippage of 0.1% to 5% before Review; Review never continues', () => {
  let state = machine.initialJourney(8453);
  assert.equal(machine.canContinue('pool', state).ok, false);
  state = machine.withPool(state, ethUsdc(), 0);
  assert.equal(machine.canContinue('pool', state).ok, true);
  assert.ok(state.range && state.range.lower % 10 === 0 && state.range.upper % 10 === 0 && state.range.lower < -198080 && state.range.upper > -198080, 'the standard width around the price, on the spacing');
  assert.equal(state.slippage, '50', 'decision #2: 0.5% by default');
  assert.equal(machine.canContinue('amount', state).ok, false, 'no amount yet');
  state = machine.withAmounts(state, { mode: 'pool', other: null, text: { [USDC_BASE]: '1000' } });
  assert.equal(machine.canContinue('amount', state).ok, true, 'one token alone is enough: the zap swaps');
  assert.deepEqual(machine.inputsOf(state), [{ token: USDC_BASE, amount: 1_000_000_000n }]);
  state = machine.withAmounts(state, { mode: 'pool', other: null, text: { [USDC_BASE]: '1000', [ZERO]: '0.1' } });
  assert.deepEqual(machine.inputsOf(state), [{ token: ZERO, amount: 100_000_000_000_000_000n }, { token: USDC_BASE, amount: 1_000_000_000n }]);
  assert.equal(machine.canContinue('amount', machine.withAmounts(state, { mode: 'pool', other: null, text: { [USDC_BASE]: '1.0000001' } })).ok, false, 'more places than the token has');
  assert.equal(machine.canContinue('amount', machine.withSlippage(state, '5')).ok, false, 'below 0.1%');
  assert.equal(machine.canContinue('amount', machine.withSlippage(state, '501')).ok, false, 'above 5%');
  assert.equal(machine.canContinue('amount', machine.withSlippage(state, '500')).ok, true);
  assert.equal(machine.canContinue('review', state).ok, false);
  assert.deepEqual(machine.otherTokens(8453, state.pool.pool), [WETH_BASE], 'another token: what the chain charges in and is not in the pool');
  const other = machine.withAmounts(state, { mode: 'other', other: WETH_BASE, text: { [WETH_BASE]: '0.5' } });
  assert.deepEqual(machine.inputsOf(other), [{ token: WETH_BASE, amount: 500_000_000_000_000_000n }], 'exactly one token outside the pool');
  assert.equal(machine.canContinue('range', machine.withRange(state, { lower: -198085, upper: -198000 })).ok, false, 'off the spacing');
});

test('the request: a create with the pool, the range, the inputs and the slippage, no owner and no recipient; the wire form the package admits', () => {
  let state = machine.withPool(machine.initialJourney(8453), ethUsdc(), 0);
  state = machine.withAmounts(state, { mode: 'pool', other: null, text: { [USDC_BASE]: '1000' } });
  const request = machine.createRequest(state, 'permit2');
  assert.deepEqual(Object.keys(request).sort(), ['action', 'chainId', 'consent', 'inputs', 'pool', 'slippageBps', 'tickLower', 'tickUpper']);
  assert.equal(request.action, 'create');
  assert.equal(request.consent, 'permit2');
  const wire = planRequestWire(request);
  assert.ok(runtime.validateRequest('plan', wire), 'the package takes it');
  assert.equal(machine.createRequest(machine.initialJourney(8453), 'direct'), null, 'nothing before the steps are complete');
});

test('§2.6.5 and §7.5: a pool with no price needs a starting price; 2,500 USDG per ETH, typed either way round, is 3961408125713216879677197 at tick -198080, and the request carries it for check 13', () => {
  const rh = { ...ethUsdc(), chainId: 4663, pool: { dex: 4, currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: ZERO }, tokens: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: USDG, symbol: 'USDG', decimals: 6 }], initialized: false, exists: false, sqrtPriceX96: 0n, tick: 0 };
  let state = machine.withPool(machine.initialJourney(4663), rh, 0);
  assert.equal(machine.canContinue('pool', state).ok, false);
  assert.equal(machine.canContinue('pool', state).reason, 'Set a starting price to continue.');
  assert.equal(state.range, null, 'no range without a price');
  const forward = machine.startingPrice(rh, { base: 'currency0', text: '2,500' });
  assert.equal(forward.sqrtPriceX96, 3961408125713216879677197n);
  assert.equal(forward.tick, -198080);
  const inverse = machine.startingPrice(rh, { base: 'currency1', text: '0.0004' });
  assert.equal(inverse.sqrtPriceX96, forward.sqrtPriceX96);
  assert.equal(inverse.tick, -198080);
  state = machine.withStart(state, { base: 'currency0', text: '2500' }, 0);
  assert.equal(machine.canContinue('pool', state).ok, true);
  assert.ok(state.range && state.range.lower < -198080 && state.range.upper > -198080, 'the range is set at the starting price');
  state = machine.withAmounts(state, { mode: 'pool', other: null, text: { [USDG]: '1000' } });
  const request = machine.createRequest(state, 'direct');
  assert.deepEqual(request.initialPrice, { price: '2500', baseToken: ZERO, decimals0: 18, decimals1: 6, sqrtPriceX96: 3961408125713216879677197n });
  assert.equal(machine.startingPrice({ ...rh, tokens: [rh.tokens[0], { ...rh.tokens[1], decimals: null }] }, { base: 'currency0', text: '2500' }), null, 'decimals never guessed');
  assert.equal(machine.startingPrice(rh, { base: 'currency0', text: '0' }), null);
});

test('real data only (the owner, 2026-10-02): the model carries no test example and no fixture plan, and a pool comes from the wallet or V1\'s list alone', () => {
  assert.equal(machine.withExample, undefined, 'no example fills the steps');
  assert.equal(machine.exactText, undefined, 'nothing writes a fixture\'s raw amounts into the fields');
  assert.equal('example' in machine.initialJourney(4663), false, 'the state remembers no example');
  for (const gone of ['fixturePlans', 'previewPlan']) assert.equal(existsSync(new URL(`../../src/v2in/journey/model/${gone}.ts`, import.meta.url)), false, `${gone}: gone with the fixtures`);
  assert.equal(readdirSync(new URL('../../src/v2in/journey/model/', import.meta.url)).some((name) => /fixture|example|preview/i.test(name)), false, 'no fixture module under the model');
  const listed = pools.poolFromList({
    key: '0x' + 'ab'.repeat(32),
    currencies: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: USDG, symbol: 'USDG', decimals: 6 }],
    feePips: 3000, tickSpacing: 60, hooks: ZERO, tick: -199020, sqrtPriceX96: '3756254281219003000000000', block: 78_000_000, readAt: null,
  });
  assert.equal(listed.source, 'list');
  assert.equal(listed.readAt, null, 'a list that did not say when it read: null, never a guess');
});

// Added 2026-10-05 (the owner: his New position screens, with Domino V2 connected behind them): what his journey chose,
// read for the plan (src/v2in/journey/model/fromV1.ts), as JourneyCreateV2 asks it on his Review.
test('the owner\'s journey on V2: its pool, range and slippage as chosen; what the wallet puts in from its own funding; the request the package admits', () => {
  const fromV1 = require(`${BUILD}v2in/journey/model/fromV1.js`);
  const option = {
    key: '0x' + 'ab'.repeat(32),
    currencies: [{ address: ZERO, symbol: 'ETH', decimals: 18 }, { address: USDG, symbol: 'USDG', decimals: 6 }],
    feePips: 3000, tickSpacing: 60, hooks: ZERO, tick: -199020, sqrtPriceX96: '3756254281219003000000000', block: 78_000_000, readAt: 1,
  };
  const v1 = { pool: option, range: { lower: -199200, upper: -198840 }, slippageBps: '50' };
  const zap = fromV1.zapStateFromV1(v1);
  assert.equal(zap.chainId, 4663);
  assert.deepEqual(zap.range, v1.range);
  assert.equal(zap.slippage, '50');
  assert.equal(zap.start, null, 'V1 lists priced pools only');
  assert.equal(zap.pool.pool.dex, 4);
  assert.equal(fromV1.zapStateFromV1({ ...v1, range: null }), null);
  assert.equal(fromV1.zapStateFromV1({ ...v1, pool: { ...option, hooks: '0x00000000000000000000000000000000000000c0' } }), null, 'never a hooked pool');
  // Both of the pool's tokens at the amounts the amount step showed (need), never the deposit's slippage room.
  const both = fromV1.inputsFromV1(zap, { need: [10n ** 17n, 250_000_000n], plan: { kind: 'both', amount0: 10n ** 17n + 5n, amount1: 250_100_000n } });
  assert.deepEqual(both, { kind: 'inputs', inputs: [{ token: ZERO, amount: 10n ** 17n }, { token: USDG, amount: 250_000_000n }] });
  // One token alone: all of it, for the planner to swap in.
  assert.deepEqual(fromV1.inputsFromV1(zap, { need: [0n, 0n], plan: { kind: 'swap', from: 1, deposit: 500_000_000n, swap: 250_000_000n, receive: 10n ** 17n } }), { kind: 'inputs', inputs: [{ token: USDG, amount: 500_000_000n }] });
  assert.deepEqual(fromV1.inputsFromV1(zap, { need: [10n ** 17n, 0n], plan: { kind: 'both', amount0: 10n ** 17n, amount1: 0n } }), { kind: 'inputs', inputs: [{ token: ZERO, amount: 10n ** 17n }] }, 'a zero side is no input');
  assert.deepEqual(fromV1.inputsFromV1(zap, { need: [0n, 0n], plan: { kind: 'short', token: 1, have: 5n, need: 9n } }), { kind: 'short', token: USDG, have: 5n, need: 9n });
  assert.deepEqual(fromV1.inputsFromV1(zap, { need: [1n, 1n], plan: null }), { kind: 'wait' }, 'balances not read yet');
  assert.deepEqual(fromV1.inputsFromV1(zap, null), { kind: 'wait' });
  const request = fromV1.requestFromV1(zap, both, 'direct');
  assert.deepEqual(
    { action: request.action, chainId: request.chainId, tickLower: request.tickLower, tickUpper: request.tickUpper, slippageBps: request.slippageBps, inputs: request.inputs },
    { action: 'create', chainId: 4663, tickLower: -199200, tickUpper: -198840, slippageBps: 50, inputs: both.inputs },
  );
  assert.ok(runtime.validateRequest('plan', planRequestWire(request)), 'the package takes it');
  assert.equal(fromV1.requestFromV1(zap, { kind: 'wait' }, 'direct'), null);
  assert.equal(fromV1.requestFromV1({ ...zap, range: { lower: -199201, upper: -198840 } }, both, 'direct'), null, 'off the pool\'s spacing');
});
