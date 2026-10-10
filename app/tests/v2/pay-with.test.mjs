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

test('payment discovery uses actual local assets, preserves WETH, and never invents funds', () => {
  assert.equal(model.payToken(4663, [AI, PONS], null), null);
  assert.equal(model.payToken(4663, [AI, PONS], answerOf({ 4663: { [ZERO]: [0n, null], [USDG]: [0n, null] } })), null);
  const ether = answerOf({ 4663: { [ZERO]: [E18, '4000.000000'], [USDG]: [0n, null] }, 8453: { [ZERO]: [E18, '4000'], [USDC_BASE]: [50_000_000_000n, '50000'] } });
  assert.equal(model.payToken(4663, [AI, USDG], ether).address, ZERO, 'USDG pool support must not hide local ETH');
  assert.equal(model.payToken(4663, [AI, PONS], ether).address, ZERO, 'local ETH before remote wealth');
  const wrapped = answerOf({ 4663: { [ZERO]: [REVIEW_GAS_RESERVE_WEI, '2'], [WETH_RH]: [E18, '4000'], [USDG]: [0n, null] } });
  assert.deepEqual(model.payToken(4663, [AI, USDG], wrapped), { address: WETH_RH, symbol: 'WETH', decimals: 18 });
  assert.equal(model.payToken(4663, [WETH_RH, PONS], wrapped), null, 'same token already belongs to the pair');
  const dollars = answerOf({ 4663: { [ZERO]: [E18 / 100n, '40'], [USDG]: [500_000_000n, '500'] } });
  assert.equal(model.payToken(4663, [AI, PONS], dollars).address, USDG);
  const failed = answerOf({ 4663: { [ZERO]: [E18, '4000'] } }); failed.chains[0].balances[0].status = 'unavailable';
  assert.equal(model.payToken(4663, [AI, PONS], failed), null, 'unread is not a positive balance');
});

test('remote payment fallback needs actual source funds and gas', () => {
  const empty = answerOf({ 4663: { [ZERO]: [0n, null], [USDG]: [0n, null] }, 8453: { [ZERO]: [0n, null], [USDC_BASE]: [100_000_000n, '100'] } });
  assert.equal(model.payToken(4663, [AI, PONS], empty), null, 'unusable source without gas is not ready');
  const funded = answerOf({ 4663: { [ZERO]: [0n, null], [USDG]: [0n, null] }, 8453: { [ZERO]: [REVIEW_GAS_RESERVE_WEI, '2'], [USDC_BASE]: [100_000_000n, '100'] } });
  assert.deepEqual(model.payCandidates(4663, [AI, PONS], funded).map(t => [t.address, t.origins]), [[USDG, [8453]]]);
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

test('payment refresh retains unread local offers, blocks stale funding, and accepts authoritative zero', () => {
  const { reconcilePayFacts, unavailablePayFacts, payFunding, preferredPayment } = require(`${BUILD}lib/create/payFunding.js`);
  const local = { token: ETH, raw: E18, nativeRaw: E18, usd: '4000', observedTokens: [ZERO, USDG] };
  const remote = { token: token(USDG, 'USDG', 6), raw: null, nativeRaw: null, usd: null, origins: [8453], observedTokens: [] };
  const retained = reconcilePayFacts(local, remote);
  assert.equal(retained.token.address, ZERO, 'partial remote answer cannot replace known local ETH');
  assert.equal(retained.raw, E18);
  assert.equal(retained.stale, true);
  assert.equal(retained.alternatives[0].token.address, USDG, 'newly observed remote offer remains available');
  assert.deepEqual(payFunding({ token: ETH, text: '0.5' }, retained), { kind: 'unread' }, 'retained display cannot authorize spending');
  const failed = unavailablePayFacts(local);
  assert.equal(unavailablePayFacts(undefined), null, 'initial failure exits loading without inventing an empty wallet');
  assert.equal(failed.raw, E18, 'total failure keeps the last displayed amount');
  assert.deepEqual(payFunding({ token: ETH, text: '0.5' }, failed), { kind: 'unread' });
  const recovered = reconcilePayFacts(failed, local);
  assert.notEqual(recovered.stale, true);
  assert.deepEqual(payFunding({ token: ETH, text: '0.5' }, recovered), { kind: 'ready', amount: E18 / 2n });
  assert.equal(reconcilePayFacts(local, null), null, 'authoritative no-offer response clears old funds');
  const emptied = reconcilePayFacts(local, { ...remote, raw: 0n, nativeRaw: 0n, observedTokens: [ZERO, USDG] });
  assert.equal(emptied.token.address, USDG, 'confirmed-zero ETH is not retained over the valid remote offer');
  assert.equal(emptied.alternatives.some((option) => option.token.address === ZERO), false);
  const newScope = reconcilePayFacts(undefined, remote);
  assert.equal(newScope, remote, 'a new wallet/pool/token scope cannot inherit the previous offer');
  assert.equal(newScope.raw, null, 'unread initial balance remains unknown');
  const freshStable = { ...remote, raw: 100_000_000n, nativeRaw: E18, usd: '1', observedTokens: [USDG] };
  assert.equal(preferredPayment(reconcilePayFacts(local, freshStable), '10').token.address, USDG, 'fresh usable local funds win over a retained stale offer');
});

test('a selected payment asset retains only unread fields and always applies fresh balance and gas observations', () => {
  const { reconcilePayFacts, payFunding } = require(`${BUILD}lib/create/payFunding.js`);
  const stable = token(USDG, 'USDG', 6);
  const previous = { token: stable, raw: 500_000_000n, nativeRaw: E18, usd: '1' };
  const partial = reconcilePayFacts(previous, { token: stable, raw: null, nativeRaw: 0n, usd: null, observedTokens: [ZERO] });
  assert.equal(partial.raw, previous.raw);
  assert.equal(partial.nativeRaw, 0n, 'fresh zero gas must not reuse prior positive gas');
  assert.equal(partial.stale, true);
  const empty = reconcilePayFacts(previous, { token: stable, raw: 0n, nativeRaw: E18, usd: null, observedTokens: [ZERO, USDG] });
  assert.equal(empty.raw, 0n);
  assert.equal(empty.usd, null, 'unqualified current price cannot inherit the prior price');
  assert.notEqual(empty.stale, true);
  assert.deepEqual(payFunding({ token: stable, text: '100' }, empty), { kind: 'short', have: 0n, need: 100_000_000n });
});
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
  assert.deepEqual(inputsFromV1(zap, null, stable, { ...dollars, nativeRaw: REVIEW_GAS_RESERVE_WEI - 1n }), { kind: 'gas' }, 'gas dust does not pass the amount check');
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

const { paymentEstimate, preferredPayment } = require(BUILD + 'lib/create/payFunding.js');
test('indicative payment prefill preserves a qualified USD budget without exceeding it', () => {
  const facts = { token: ETH, raw: E18, nativeRaw: E18, usd: '4000.000000000000000000' };
  assert.deepEqual(paymentEstimate('20', facts), { raw: 5_000_000_000_000_000n, text: '0.005' });
  assert.equal(paymentEstimate('20', { ...facts, usd: null }), null);
  assert.equal(paymentEstimate('20', { ...facts, usd: '0' }), null);
  assert.equal(paymentEstimate('20', { ...facts, token: { ...ETH, decimals: null } }), null);
  assert.equal(paymentEstimate('1'.repeat(80), facts), null);
  const stable = { token: token(USDG, 'USDG', 6), raw: 30_000_000n, nativeRaw: E18, usd: '1' };
  const thin = { ...facts, raw: REVIEW_GAS_RESERVE_WEI + 1n, alternatives: [stable] };
  assert.equal(preferredPayment(thin, '20').token.address, USDG, 'a sufficient local balance beats an insufficient suggestion');
  assert.equal(preferredPayment({ ...thin, alternatives: [{ ...stable, nativeRaw: 1n }] }, '20').token.address, ZERO, 'gas-less ERC20 is not a locally ready budget');
});
