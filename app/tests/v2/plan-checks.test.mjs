/**
 * The twelve checks an S1 plan passes before any consent is asked (spec F7 §2.4), and the per-action rules of §2.3,
 * §2.5 and §2.6 (src/finance/v2/plan.ts). Each check gets a plan that fails it and only it.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import * as fx from './support/plans.mjs';

const require = createRequire(import.meta.url);
const plan = require('../../.test-build/app/src/finance/v2/plan.js');
const typed = require('../../.test-build/app/src/finance/v2/typedData.js');

/**
 * checkPlan with the request's target an honest request gives the plan (fx.targetOf), unless the context names one.
 * Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review, F1): checkPlan takes the request's target.
 */
const check = (zapPlan, ctx) => plan.checkPlan(zapPlan, { target: fx.targetOf(zapPlan), ...ctx });
const create = (p = fx.createWithSwap(), ctx = {}) => check({ action: 'create', plan: p }, fx.context({ quotedLegs: fx.quotedFor(p.legs), ...ctx }));
const failuresOf = (verdict) => [...verdict.failures].sort();

test('a sound create passes every check, names zap.v4 and carries no ETH (its input is USDG)', () => {
  const verdict = create();
  assert.deepEqual(verdict.failures, []);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.zap, fx.FAKE.zapV4);
  assert.equal(verdict.value, 0n);
});

test('check 1: the zap comes from the plan chain\'s manifest, by DEX; another chain\'s manifest is refused', () => {
  assert.equal(plan.zapFor(fx.contractsFor(4663), 4663, fx.USDG_MANY_V3), fx.FAKE.zapV3);
  assert.equal(plan.zapFor(fx.contractsFor(4663), 4663, fx.ETH_USDG_V4), fx.FAKE.zapV4);
  const verdict = create(fx.createWithSwap(), { contracts: fx.contractsFor(8453) });
  assert.deepEqual(failuresOf(verdict), ['plan_wrong_chain']);
  assert.equal(verdict.zap, null);
});

test('check 2: a v4 pool with a hook is refused while hookedPoolsAllowed() is false', () => {
  const hooked = { ...fx.ETH_USDG_V4, hooks: '0x0000000000000000000000000000000000004444' };
  const p = fx.createWithSwap({ intent: fx.intent({ pool: hooked }) });
  const sealed = fx.sealed(p, fx.USDG);
  assert.deepEqual(failuresOf(create(sealed)), ['plan_pool_hooked']);
  assert.deepEqual(failuresOf(create(sealed, { hookedPoolsAllowed: true })), []);
  // A v3 pool never has a hook.
  const v3 = fx.sealed({ ...fx.createWithSwap(), intent: fx.intent({ pool: { ...fx.USDG_MANY_V3, hooks: '0x0000000000000000000000000000000000004444' } }), legs: [] }, fx.USDG);
  assert.ok(create(v3).failures.includes('plan_pool_hooks'));
});

test('check 3: a routesHash that is not the legs\' is refused', () => {
  const p = fx.createWithSwap();
  const tampered = { ...p, legs: [{ ...p.legs[0], minAmountOut: 1n }] };
  assert.ok(create(tampered, { quotedLegs: fx.quotedFor(tampered.legs) }).failures.includes('plan_routes_hash'));
  assert.equal(typed.routesHash(tampered.legs) === p.intent.routesHash, false);
});

test('check 4: fee terms are the rank rule\'s (65 in USDG here), and none without legs', () => {
  const p = fx.createWithSwap();
  assert.deepEqual(failuresOf(create({ ...p, intent: { ...p.intent, feeToken: fx.ZERO } })), ['plan_fee_terms'], 'ETH instead of USDG');
  assert.deepEqual(failuresOf(create({ ...p, intent: { ...p.intent, feeBps: 30 } })), ['plan_fee_terms']);
  const noLegs = fx.sealed({ ...p, legs: [] }, fx.USDG);
  assert.deepEqual(failuresOf(create(noLegs, { quotedLegs: [] })), []);
  assert.deepEqual(failuresOf(create({ ...noLegs, intent: { ...noLegs.intent, feeBps: 65, feeToken: fx.USDG } }, { quotedLegs: [] })), ['plan_fee_terms']);
});

test('check 5: per-action fields — action code, tokenId, ticks', () => {
  const p = fx.createWithSwap();
  assert.ok(create({ ...p, intent: { ...p.intent, action: 2 } }).failures.includes('plan_action'));
  assert.ok(create({ ...p, intent: { ...p.intent, tokenId: 5n } }).failures.includes('plan_token_id'), 'a create names no tokenId');
  assert.ok(create({ ...p, intent: { ...p.intent, tickLower: -201061 } }).failures.includes('plan_range_spacing'));
  assert.ok(create({ ...p, intent: { ...p.intent, tickLower: -198060, tickUpper: -201060 } }).failures.includes('plan_range'));
  // Increase and exit keep the position's current range; change range names the new one.
  const inc = fx.increasePlan();
  const ok = check({ action: 'increase', plan: inc }, fx.context({ quotedLegs: [] }));
  assert.deepEqual(ok.failures, []);
  const moved = { ...inc, intent: { ...inc.intent, tickUpper: -198000 } };
  assert.ok(check({ action: 'increase', plan: moved }, fx.context({ quotedLegs: [] })).failures.includes('plan_ticks_not_current'));
  const otherToken = { ...inc, intent: { ...inc.intent, tokenId: 7n } };
  assert.ok(check({ action: 'increase', plan: otherToken }, fx.context({ quotedLegs: [] })).failures.includes('plan_token_id'));
  assert.ok(check({ action: 'increase', plan: inc }, fx.context({ quotedLegs: [], position: undefined })).failures.includes('plan_position_unread'));
  assert.ok(check({ action: 'increase', plan: inc }, fx.context({ quotedLegs: [], position: { ...fx.POSITION, owner: fx.OTHER } })).failures.includes('plan_not_owner'));
  assert.ok(check({ action: 'increase', plan: inc }, fx.context({ quotedLegs: [], position: { ...fx.POSITION, pool: fx.USDG_MANY_V3 } })).failures.includes('plan_position_pool'));
});

test('check 5 (change range and exit): full removal to burn; collect only removes nothing; exit at least its minimum', () => {
  const cr = fx.changeRangePlan();
  assert.deepEqual(check({ action: 'changeRange', plan: cr }, fx.context({ quotedLegs: [] })).failures, []);
  const partialBurn = { ...cr, liquidityToRemove: fx.POSITION.liquidity - 1n };
  assert.ok(check({ action: 'changeRange', plan: partialBurn }, fx.context({ quotedLegs: [] })).failures.includes('plan_partial_burn'));
  assert.deepEqual(check({ action: 'changeRange', plan: { ...partialBurn, burnOld: false } }, fx.context({ quotedLegs: [] })).failures, []);
  assert.ok(check({ action: 'changeRange', plan: { ...cr, liquidityToRemove: 0n, burnOld: false } }, fx.context({ quotedLegs: [] })).failures.includes('plan_liquidity_to_remove'));

  const exit = fx.exitConverted();
  const exitCtx = fx.context({ quotedLegs: fx.quotedFor(exit.legs), expectedRemoved: [500_000_000_000_000_000n, 2_000_000_000n] });
  assert.deepEqual(check({ action: 'exit', plan: exit }, exitCtx).failures, []);
  const below = { ...exit, liquidityToRemove: fx.POSITION.liquidity - 1n, burn: false };
  assert.ok(check({ action: 'exit', plan: below }, exitCtx).failures.includes('plan_exit_below_minimum'));
  const collect = fx.sealed({ ...exit, legs: [], liquidityToRemove: 0n, burn: false, intent: { ...exit.intent, minLiquidity: 0n } }, fx.USDG);
  assert.deepEqual(check({ action: 'exit', plan: collect }, fx.context({ quotedLegs: [] })).failures, []);
  const collectBurn = { ...collect, burn: true };
  assert.ok(check({ action: 'exit', plan: collectBurn }, fx.context({ quotedLegs: [] })).failures.includes('plan_partial_burn'));
});

test('a removal (change range, exit) carries at least one principal minimum: zero on both is no price protection', () => {
  const exit = fx.exitConverted({ amount0MinRemoved: 0n, amount1MinRemoved: 0n });
  const ctx = fx.context({ quotedLegs: fx.quotedFor(exit.legs), expectedRemoved: [500_000_000_000_000_000n, 2_000_000_000n] });
  assert.deepEqual(check({ action: 'exit', plan: exit }, ctx).failures, ['plan_removal_minimums']);
  assert.deepEqual(check({ action: 'exit', plan: { ...exit, amount1MinRemoved: 1n } }, ctx).failures, []);
  const cr = fx.changeRangePlan({ amount0MinRemoved: 0n, amount1MinRemoved: 0n });
  assert.deepEqual(check({ action: 'changeRange', plan: cr }, fx.context({ quotedLegs: [] })).failures, ['plan_removal_minimums']);
  // Collecting only removes nothing, and needs none.
  const collect = fx.sealed({ ...exit, legs: [], liquidityToRemove: 0n, burn: false, intent: { ...exit.intent, minLiquidity: 0n } }, fx.USDG);
  assert.deepEqual(check({ action: 'exit', plan: collect }, fx.context({ quotedLegs: [] })).failures, []);
});

test('exit converted: legs spend at most the expected withdrawal, and only what leaves the position', () => {
  const exit = fx.exitConverted();
  const tight = fx.context({ quotedLegs: fx.quotedFor(exit.legs), expectedRemoved: [399_999_999_999_999_999n, 2_000_000_000n] });
  assert.ok(check({ action: 'exit', plan: exit }, tight).failures.includes('plan_conversion_exceeds_removal'));
  assert.ok(check({ action: 'exit', plan: exit }, fx.context({ quotedLegs: fx.quotedFor(exit.legs) })).failures.includes('plan_conversion_unbounded'));
});

// Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review, L5): a recipient of the person's choosing was removed from
// the client and the checks (the plan API plans for the session's wallet only): the recipient is the wallet, always.
test('check 6: the recipient is the connected wallet, always, on every path; a "chosen recipient" is no longer heard', () => {
  const p = fx.createWithSwap();
  const toOther = { ...p, intent: { ...p.intent, recipient: fx.OTHER } };
  assert.ok(create(toOther).failures.includes('plan_recipient'), 'a recipient nobody chose');
  assert.ok(create(toOther, { chosenRecipient: fx.OTHER }).failures.includes('plan_recipient'), 'the direct path pays no other account, even when asked');
  const permit = { permitted: p.inputs, nonce: p.intent.nonce, deadline: p.intent.deadline };
  assert.ok(create(toOther, { consent: 'permit2', permit }).failures.includes('plan_recipient'), 'Permit2: the signer only');
  assert.ok(create({ ...p, intent: { ...p.intent, recipient: fx.ZERO } }).failures.includes('plan_recipient'));
  assert.ok(create({ ...p, intent: { ...p.intent, recipient: fx.FAKE.zapV4 } }).failures.includes('plan_recipient'), 'never the zap');
  assert.deepEqual(create(p).failures, [], 'the connected wallet');
});

// Changed on purpose (data) 2026-10-02 (rev2 §2.4 decision #3): a quote is good for 3 minutes, the deadline is 5 minutes
// after the quote was made; the old rule (deadline ≤ the quote's expiry) refused every position-plan-v1 rc.2 plan.
test('check 7: the deadline is in the future and at most 5 minutes after the quote; no consent at or after the quote\'s expiry', () => {
  const p = fx.createWithSwap();
  assert.ok(create({ ...p, intent: { ...p.intent, deadline: BigInt(fx.NOW) } }).failures.includes('plan_deadline'));
  assert.ok(create(p, { quoteRequestedAt: fx.NOW - 1 }).failures.includes('plan_deadline'), 'one second more than 5 minutes after the quote');
  assert.deepEqual(create(p, { quoteRequestedAt: fx.NOW }).failures, [], 'exactly requestedAt + 300');
  assert.deepEqual(create(p, { quoteExpiresAt: fx.NOW + 1 }).failures, [], 'a second left on the quote');
  assert.ok(create(p, { quoteExpiresAt: fx.NOW }).failures.includes('plan_quote_expired'), 'at its expiry');
});

test('check 8: a Permit2 batch is exactly the ERC-20 inputs, with the intent\'s nonce and deadline; no native input', () => {
  const p = fx.createWithSwap();
  const permit = { permitted: p.inputs, nonce: p.intent.nonce, deadline: p.intent.deadline };
  assert.deepEqual(create(p, { consent: 'permit2', permit }).failures, []);
  assert.ok(create(p, { consent: 'permit2', permit: { ...permit, nonce: 99n } }).failures.includes('plan_permit_nonce'));
  assert.ok(create(p, { consent: 'permit2', permit: { ...permit, deadline: permit.deadline - 1n } }).failures.includes('plan_permit_deadline'));
  assert.ok(create(p, { consent: 'permit2', permit: { ...permit, permitted: [{ token: fx.USDG, amount: 999_999_999n }] } }).failures.includes('plan_permit_inputs'));
  assert.ok(create(p, { consent: 'permit2' }).failures.includes('plan_permit_missing'));
  const withEth = fx.sealed({ ...p, inputs: [{ token: fx.ZERO, amount: 10n ** 17n }] }, fx.USDG);
  const ethPermit = { permitted: withEth.inputs, nonce: 0n, deadline: withEth.intent.deadline };
  assert.ok(create(withEth, { consent: 'permit2', permit: ethPermit }).failures.includes('plan_permit_native'), 'Paying with ETH needs a direct transaction');
  // Direct: the native inputs are the call's value.
  assert.equal(create(withEth).value, 10n ** 17n);
  // Change of range and exit take no Permit2; create and increase are never relayed.
  assert.ok(check({ action: 'exit', plan: fx.exitConverted() }, fx.context({ consent: 'permit2', quotedLegs: fx.quotedFor(fx.exitConverted().legs), expectedRemoved: [10n ** 18n, 10n ** 10n] })).failures.includes('plan_consent'));
  assert.ok(create(p, { consent: 'relayed' }).failures.includes('plan_consent'));
});

test('check 9: Universal Router legs go only to the chain\'s 2.1.2 router, admitted by the registry', () => {
  const ur = fx.ROBINHOOD.uniswap.universalRouter.address;
  // Changed on purpose (data) 2026-10-02 (Domino V2 rev2 review, L3): the router's calldata carries its deadline.
  const leg = { kind: 1, router: ur, tokenIn: fx.USDG, tokenOut: fx.ZERO, amountIn: 500_000_000n, minAmountOut: 1n, data: fx.urExecute(BigInt(fx.NOW + 300)) };
  const p = fx.sealed({ ...fx.createWithSwap(), legs: [leg] }, fx.USDG);
  assert.deepEqual(create(p, { quotedLegs: fx.quotedFor(p.legs) }).failures, []);
  const old = fx.sealed({ ...p, legs: [{ ...leg, router: '0x8876789976decbfcbbbe364623c63652db8c0904' }] }, fx.USDG);
  assert.ok(create(old, { quotedLegs: fx.quotedFor(old.legs) }).failures.includes('plan_leg_router'), 'UR 2.1.1 is switched off on 2026-10-21');
  assert.ok(create(p, { quotedLegs: fx.quotedFor(p.legs), routerVersion: () => 211 }).failures.includes('plan_leg_router_not_admitted'));
  assert.ok(create(p, { quotedLegs: fx.quotedFor(p.legs), routerVersion: () => null }).failures.includes('plan_leg_router_not_admitted'));
  // Base's router on Robinhood is another chain's router.
  const baseRouter = fx.sealed({ ...p, legs: [{ ...leg, router: fx.BASE.uniswap.universalRouter.address }] }, fx.USDG);
  assert.ok(create(baseRouter, { quotedLegs: fx.quotedFor(baseRouter.legs) }).failures.includes('plan_leg_router'));
});

test('check 10: every leg has a minimum, and create/increase/change range a minimum liquidity', () => {
  const p = fx.createWithSwap();
  const noMin = fx.sealed({ ...p, legs: [{ ...p.legs[0], minAmountOut: 0n }] }, fx.USDG);
  assert.ok(create(noMin, { quotedLegs: [{ expectedOut: 1n, minAmountOut: 0n, pools: [] }] }).failures.includes('plan_leg_minimum'));
  assert.ok(create({ ...p, intent: { ...p.intent, minLiquidity: 0n } }).failures.includes('plan_min_liquidity'));
  const inc = fx.increasePlan();
  assert.ok(check({ action: 'increase', plan: { ...inc, intent: { ...inc.intent, minLiquidity: 0n } } }, fx.context({ quotedLegs: [] })).failures.includes('plan_min_liquidity'));
});

test('the zap\'s own leg rules: at most 8, distinct tokens, positive amounts, well-formed paths', () => {
  const p = fx.createWithSwap();
  const leg = p.legs[0];
  const nine = fx.sealed({ ...p, legs: Array.from({ length: 9 }, () => leg) }, fx.USDG);
  assert.ok(create(nine, { quotedLegs: fx.quotedFor(nine.legs) }).failures.includes('plan_legs_too_many'));
  const sameToken = fx.sealed({ ...p, legs: [{ ...leg, tokenOut: fx.USDG }] }, fx.USDG);
  assert.ok(create(sameToken, { quotedLegs: fx.quotedFor(sameToken.legs) }).failures.includes('plan_leg_same_token'));
  const badPath = fx.sealed({ ...p, legs: [{ ...leg, data: fx.v4Path(fx.USDG_MANY_V3) }] }, fx.USDG);
  assert.ok(create(badPath, { quotedLegs: fx.quotedFor(badPath.legs) }).failures.includes('plan_leg_path'), 'a path that does not lead from tokenIn to tokenOut');
  const v3 = { kind: 2, router: fx.ZERO, tokenIn: fx.USDG, tokenOut: fx.MANY, amountIn: 1n, minAmountOut: 1n, data: fx.v3Path(fx.USDG, 3000, fx.MANY) };
  assert.deepEqual(plan.legProblems([v3], fx.ROBINHOOD, () => null), []);
  assert.deepEqual(plan.legProblems([{ ...v3, data: fx.v3Path(fx.USDG, 3000, fx.TSLA) }], fx.ROBINHOOD, () => null), ['plan_leg_path']);
  assert.deepEqual(plan.legProblems([{ ...v3, tokenIn: fx.ZERO, data: fx.v3Path(fx.ZERO, 3000, fx.MANY) }], fx.ROBINHOOD, () => null), ['plan_leg_path'], 'v3 paths are ERC-20 only');
  assert.deepEqual(plan.legProblems([{ ...v3, data: fx.v3Path(fx.USDG, 3000, fx.TSLA, 3000, fx.WETH, 3000, fx.TSLA, 3000, fx.WETH, 3000, fx.MANY) }], fx.ROBINHOOD, () => null), ['plan_leg_path'], 'five hops');
  assert.deepEqual(plan.legProblems([{ ...v3, router: fx.OTHER }], fx.ROBINHOOD, () => null), ['plan_leg_router'], 'a pool path names no router');
});

test('check 11: the plan\'s simulation must have passed', () => {
  assert.ok(create(fx.createWithSwap(), { simulation: { ok: false, block: 1n, error: 'SwapEffectMismatch' } }).failures.includes('plan_simulation'));
  assert.ok(create(fx.createWithSwap(), { simulation: undefined }).failures.includes('plan_simulation'));
});

test('check 12: the review shows every leg, from a quote with one leg per plan leg and the plan\'s own minimums', () => {
  const p = fx.createWithSwap();
  const rows = plan.reviewLegs(p.legs, fx.quotedFor(p.legs));
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].tokenIn, rows[0].tokenOut, rows[0].minAmountOut, rows[0].asQuoted], [fx.USDG, fx.ZERO, p.legs[0].minAmountOut, false]);
  assert.ok(create(p, { quotedLegs: [] }).failures.includes('plan_review_legs'));
  assert.ok(create(p, { quotedLegs: [{ ...fx.quotedFor(p.legs)[0], minAmountOut: 5n }] }).failures.includes('plan_review_legs'), 'a quote that shows another minimum');
});

test('pools: currencies sorted, v3 spacing from the tier table (Base\'s extra tiers too), no native on v3', () => {
  assert.deepEqual(plan.poolProblems(fx.ETH_USDG_V4, fx.ROBINHOOD), []);
  assert.deepEqual(plan.poolProblems({ ...fx.ETH_USDG_V4, currency0: fx.USDG, currency1: fx.ZERO }, fx.ROBINHOOD), ['plan_pool_order']);
  assert.deepEqual(plan.poolProblems({ ...fx.USDG_MANY_V3, tickSpacing: 10 }, fx.ROBINHOOD), ['plan_pool_spacing']);
  assert.deepEqual(plan.poolProblems({ ...fx.USDG_MANY_V3, fee: 300, tickSpacing: 6 }, fx.BASE), [], 'Base 0.03% → spacing 6');
  assert.deepEqual(plan.poolProblems({ ...fx.USDG_MANY_V3, fee: 300, tickSpacing: 5 }, fx.BASE), ['plan_pool_spacing']);
  assert.deepEqual(plan.poolProblems({ dex: 3, currency0: fx.ZERO, currency1: fx.USDG, fee: 3000, tickSpacing: 60, hooks: fx.ZERO }, fx.ROBINHOOD), ['plan_pool_native_v3']);
});

test('the relayed action signs exactly the plan\'s fields; an exit signs zero caps', () => {
  const exit = fx.exitConverted();
  const action = plan.relayedActionOf({ action: 'exit', plan: exit });
  assert.deepEqual([action.amount0Max, action.amount1Max, action.burn, action.liquidityToRemove], [0n, 0n, true, exit.liquidityToRemove]);
  const cr = fx.changeRangePlan({ amount0Max: 5n, amount1Max: 6n });
  const crAction = plan.relayedActionOf({ action: 'changeRange', plan: cr });
  assert.deepEqual([crAction.amount0Max, crAction.amount1Max, crAction.burn], [5n, 6n, true]);
});
