/**
 * Added 2026-10-06 (the owner, on production's New position: AI/PONS and CASHCAT/AI short on Robinhood Chain, and no offer
 * to bring anything, since neither token is one a deposit from another network delivers): paying with ONE other token, the
 * network's ETH or its stable, which Domino V2's zap swaps for the pool's two (position-plan-v1: "the pool's tokens, or
 * exactly one other token"), in the owner's amount step. What is pure of it:
 *   - which token the line names (src/v2in/funds/model.ts payToken): none while a token of the pool can be brought; ETH,
 *     or the stable when the wallet holds more value in dollars than in ether, here and elsewhere, at qualified prices;
 *   - what paying it lacks here, sized as the zap path's offer sizes its inputs (payLacks: the amount, plus the gas Review
 *     keeps for ETH, less the balance the service read);
 *   - the step's own machine (src/lib/create/journey.ts PayWith): Continue on its amount, reset with the pool;
 *   - the plan's inputs (src/v2in/journey/model/fromV1.ts inputsFromV1): exactly that one token, at the amount typed.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const model = require(`${BUILD}v2in/funds/model.js`);
const journey = require(`${BUILD}lib/create/journey.js`);
const { inputsFromV1, zapStateFromV1 } = require(`${BUILD}v2in/journey/model/fromV1.js`);
const { heldAmounts } = require(`${BUILD}components/create/valuation.js`);
const { REVIEW_GAS_RESERVE_WEI } = require(`${BUILD}lib/create/reviewPlan.js`);

const ZERO = '0x0000000000000000000000000000000000000000';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const WETH_RH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const AI = '0x1111111111111111111111111111111111111111';
const PONS = '0x2222222222222222222222222222222222222222';
const E18 = 10n ** 18n;

/** A chain-balances answer as the model reads it: per chain, each token's raw balance and USD value (null: none). */
function answerOf(chains) {
  return {
    chains: Object.entries(chains).map(([id, balances]) => ({
      chainId: Number(id),
      status: 'current',
      reason: null,
      snapshot: null,
      totalUsd: null,
      balances: Object.entries(balances).map(([address, [raw, valueUsd, usd = null]]) => ({ address, balanceRaw: String(raw), status: 'read', valueUsd, price: usd === null ? null : { usd } })),
    })),
  };
}

test('the token "Pay with … instead" names: none while a pool token can be brought; ETH, or the dollar when it is worth more', () => {
  // AI/PONS on Robinhood Chain: no token a deposit delivers. Nothing read yet: ETH.
  assert.deepEqual(model.payToken(4663, [AI, PONS], null), { address: ZERO, symbol: 'ETH', decimals: 18 });
  // A pool with ETH, WETH or USDG: the offer to bring that token stands, no line.
  for (const pool of [[ZERO, AI], [AI, USDG], [WETH_RH, PONS]]) assert.equal(model.payToken(4663, pool, null), null, pool.join('/'));
  // More value in dollars than in ether, here and on another network: USDG.
  const dollars = answerOf({ 4663: { [ZERO]: [E18 / 100n, '40.000000'], [USDG]: [500_000_000n, '500.000000'] }, 8453: { [USDC_BASE]: [100_000_000n, '100.000000'] } });
  assert.deepEqual(model.payToken(4663, [AI, PONS], dollars), { address: USDG, symbol: 'USDG', decimals: 6 });
  // More in ether (its value counted on every network): ETH.
  const ether = answerOf({ 4663: { [ZERO]: [E18, '4000.000000'], [USDG]: [500_000_000n, '500.000000'] } });
  assert.equal(model.payToken(4663, [AI, PONS], ether).address, ZERO);
  // A holding with no value: the comparison is not known, so ETH.
  const unvalued = answerOf({ 4663: { [ZERO]: [E18, null], [USDG]: [500_000_000n, '500.000000'] } });
  assert.equal(model.payToken(4663, [AI, PONS], unvalued).address, ZERO);
  // Base: its USDC is its dollar.
  const base = answerOf({ 8453: { [ZERO]: [0n, null], [USDC_BASE]: [100_000_000n, '100.000000'] } });
  assert.deepEqual(model.payToken(8453, [AI, PONS], base), { address: USDC_BASE, symbol: 'USDC', decimals: 6 });
});

test('what paying lacks here: the amount, the gas Review keeps for ETH, less the balance read; nothing when covered or unread', () => {
  // 0.5 ETH typed, 0.1 ETH here: 0.4 ETH and the gas allowance, brought as ETH.
  const [lack] = model.payLacks(4663, ZERO, '0.5', 18, E18 / 10n);
  assert.deepEqual([lack.token, lack.symbol, lack.side, lack.shortRaw], [ZERO, 'ETH', 0, (4n * E18) / 10n + REVIEW_GAS_RESERVE_WEI]);
  assert.deepEqual(model.payLacks(4663, ZERO, '0.5', 18, E18), [], 'covered');
  assert.deepEqual(model.payLacks(4663, ZERO, '0.5', 18, null), [], 'unread: never said to lack');
  assert.deepEqual(model.payLacks(4663, ZERO, '', 18, 0n), [], 'nothing typed');
  // 100 USDG typed, 40 here: 60.
  assert.deepEqual(model.payLacks(4663, USDG, '100', 6, 40_000_000n).map((l) => [l.token, l.shortRaw]), [[USDG, 60_000_000n]]);
});

test('a balance as the service read it, with its price; none where the network or the balance was not read', () => {
  const answer = answerOf({ 4663: { [ZERO]: [E18, '4000.000000', '4000.000000000000000000'] } });
  assert.deepEqual(model.balanceOn(answer, 4663, ZERO), { raw: E18, usd: '4000.000000000000000000' });
  assert.equal(model.balanceOn(answer, 4663, USDG), null);
  assert.equal(model.balanceOn(answer, 8453, ZERO), null);
  assert.equal(model.nativeOn(answer, 4663), E18);
});

const token = (address, symbol, decimals) => ({ origin: 'read', chainId: 4663, address, symbol, decimals, readStatus: 'available', artwork: null });
const candidate = (address, decimals, symbol) => ({ key: address, wire: address, token: token(address, symbol, decimals), kind: 'erc20_candidate', why: null, reasonCode: null, decimalsUnavailable: false, source: 'pasted', wallet: null, balance: null, page: null, old: false, block: 1 });
const figure = { state: 'unavailable', provider: 'dexscreener', reason: 'no_provider_figures' };
const POOL = {
  key: `0x${'a'.repeat(64)}`, kind: 'discovery', currencies: [token(AI, 'AI', 18), token(PONS, 'PONS', 18)], fee: '0.30%', feePips: 3000, tickSpacing: 60, tick: 0,
  sqrtPriceX96: '79228162514264337593543950336', readAt: 0, hooks: ZERO, integration: 'hookless_fixed_fee', block: 700, catalogue: null, requestedById: false,
  liquidity: figure, volume: figure, providerNote: null, aprReason: 'reconciled_fee_history_unavailable', tokenMetadata: 'available', providerConflict: false,
};
const ETH = token(ZERO, 'ETH', 18);
/** AI/PONS chosen, a range around the price, 1,000 AI typed: the wallet short of both. */
const typed = () => journey.withBudget(journey.withRange(journey.withPool(journey.next(journey.withToken(journey.initialState(), candidate(AI, 18, 'AI')), 0), POOL, 0), { lower: -600, upper: 600 }), '1000');

test('the step\'s machine: Continue on the amount paid, the pool\'s tokens kept for the way back, reset with the pool', () => {
  const state = typed();
  assert.equal(state.payWith, null);
  assert.equal(journey.initialState().payWith, null);
  const paying = journey.withPayWith(state, { token: ETH, text: '' });
  assert.deepEqual(journey.canContinue('amount', paying, 0), { ok: false, reason: 'Enter an amount to continue.' });
  assert.deepEqual(journey.canContinue('amount', journey.withPayWith(state, { token: ETH, text: '0.5.1' }), 0).ok, false);
  const half = journey.withPayWith(state, { token: ETH, text: '0.5' });
  assert.deepEqual(journey.canContinue('amount', half, 0), { ok: true });
  // Its own amount decides, not the pool token's: an empty budget does not stop it.
  assert.deepEqual(journey.canContinue('amount', journey.withBudget(half, ''), 0), { ok: true });
  assert.equal([0, 1, 2].reduce((moved) => journey.next(moved, 0), half).stage, 'review', 'Continue works as today: through the balance stage to Review');
  // The way back: the pool's tokens and the amount typed in them, as they were.
  const back = journey.withPayWith(half, null);
  assert.deepEqual([back.payWith, back.budget], [null, '1000']);
  // The same pool read again keeps it; another pool, or none, drops it; a token the pool holds keeps it, another drops it.
  assert.deepEqual(journey.withPool(half, { ...POOL, tick: 6 }, 0).payWith, half.payWith);
  assert.equal(journey.withPool(half, { ...POOL, key: `0x${'b'.repeat(64)}` }, 0).payWith, null);
  assert.equal(journey.withPool(half, null, 0).payWith, null);
  assert.deepEqual(journey.withToken(half, candidate(PONS, 18, 'PONS')).payWith, half.payWith);
  assert.equal(journey.withToken(half, candidate('0x3333333333333333333333333333333333333333', 18, 'X')).payWith, null);
  // Nothing of the pool's tokens is claimed for it before the plan: no amounts, no USD.
  assert.equal(heldAmounts(half, { status: 'ready', balances: null, budgets: {} }), null);
});

test('the plan\'s inputs: exactly the one token paid with, at the amount typed; nothing while its amount is not one', () => {
  const half = journey.withPayWith(typed(), { token: ETH, text: '0.5' });
  const zap = zapStateFromV1(half);
  assert.ok(zap);
  // Whatever Review's plan for the pool's tokens says (here: short), the inputs are the token paid with alone.
  const short = { need: [1n, 1n], plan: { kind: 'short', token: 0, have: 0n, need: 1n } };
  assert.deepEqual(inputsFromV1(zap, short, half.payWith, { token: ETH, raw: E18, usd: null }), { kind: 'inputs', inputs: [{ token: ZERO, amount: E18 / 2n }] });
  assert.deepEqual(inputsFromV1(zap, null, { token: token(USDG, 'USDG', 6), text: '250.5' }, { token: token(USDG, 'USDG', 6), raw: 300_000_000n, nativeRaw: E18, usd: null }), { kind: 'inputs', inputs: [{ token: USDG, amount: 250_500_000n }] });
  assert.deepEqual(inputsFromV1(zap, null, { token: ETH, text: '' }), { kind: 'wait' });
  assert.deepEqual(inputsFromV1(null, null, half.payWith), { kind: 'wait' }, 'no pool');
  // Without it, the pool's own funding as before.
  assert.deepEqual(inputsFromV1(zap, short), { kind: 'short', token: AI, have: 0n, need: 1n });
});


test('external funding waits for its own chain/token balance and protects the exact typed amount plus native gas', () => {
  const half = journey.withPayWith(typed(), { token: ETH, text: '0.5' });
  const zap = zapStateFromV1(half);
  const facts = { token: ETH, raw: E18 / 2n, nativeRaw: E18 / 2n, usd: null };
  assert.deepEqual(inputsFromV1(zap, null, half.payWith), { kind: 'wait' });
  assert.deepEqual(inputsFromV1(zap, null, half.payWith, null), { kind: 'unread' });
  assert.deepEqual(inputsFromV1(zap, null, half.payWith, facts), { kind: 'short', token: ZERO, have: E18 / 2n - REVIEW_GAS_RESERVE_WEI, need: E18 / 2n });
  assert.deepEqual(inputsFromV1(zap, null, half.payWith, { ...facts, token: { ...ETH, chainId: 8453 } }), { kind: 'unread' }, 'another chain is not this wallet balance');
  assert.deepEqual(inputsFromV1(zap, null, half.payWith, { ...facts, token: token(USDG, 'USDG', 6) }), { kind: 'unread' }, 'a late recommendation never funds the chosen ETH');
  const stable = { token: token(USDG, 'USDG', 6), text: '250.5' };
  const dollars = { token: stable.token, raw: 300_000_000n, usd: null };
  assert.deepEqual(inputsFromV1(zap, null, stable, dollars), { kind: 'unread' }, 'unknown gas balance is not ready');
  assert.deepEqual(inputsFromV1(zap, null, stable, { ...dollars, nativeRaw: 0n }), { kind: 'gas' });
  assert.deepEqual(inputsFromV1(zap, null, stable, { ...dollars, nativeRaw: E18 }), { kind: 'inputs', inputs: [{ token: USDG, amount: 250_500_000n }] }, 'excess funds never increase the amount typed');
});

test('a background price crossing the range keeps the typed token, quantity, ticks and slippage', () => {
  const state = typed();
  const fresh = { ...POOL, tick: 12_000, sqrtPriceX96: '144358793897561188941933813476', readAt: 30_000 };
  const next = journey.withFreshPool(state, fresh);
  assert.equal(next.pool, fresh);
  for (const field of ['token', 'budget', 'range', 'slippageBps', 'payWith']) assert.deepEqual(next[field], state[field], field);
  assert.equal(journey.withFreshPool(state, { ...fresh, key: 'another' }), state, 'an older pool response cannot overwrite a new selection');
  assert.equal(journey.withFreshPool(state, { ...fresh, block: POOL.block - 1 }), state, 'an older snapshot cannot move the price backwards');
  assert.equal(journey.withFreshPool(state, { ...fresh, currencies: fresh.currencies.map((t) => ({ ...t, chainId: 8453 })) }), state, 'same identifier on another chain is a different pool');
});
