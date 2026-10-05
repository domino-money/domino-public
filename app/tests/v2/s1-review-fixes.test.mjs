/**
 * Domino V2 rev2 review of the S1 (zap) money and signing paths, 2026-10-02: each confirmed finding held by tests that
 * fail without its fix, against the fake V2 chain (tests/support/v2-chain.mjs) and the package's own runtime.
 *
 *   F1  a swap leg's OUTPUT is tied to what the person asked (src/v2/plan/route.ts; finance/v2/plan.ts checkPlan;
 *       src/v2/plan/parse.ts): a converted exit converts into the token asked for only, an exit to both tokens swaps
 *       nothing, a create/increase/change of range ends in the pool's own currencies, every leg spends what is held.
 *   F2  the shared sender keeps the wallet's answer (a hash, a batch id) when the wallet changes after giving it.
 *   F3  an owner-wide, per-chain record of actions handed to the wallet with no known outcome
 *       (finance/v2/zapUnsettled.ts): no new review, action or batch until the chain settles it, or the person says, while
 *       the chain shows nothing pending, that they rejected it in the wallet.
 *   F4  the plan's minimums tied to the app's own reads (the pool's price inside the plan's band, the position's range
 *       and liquidity) and to its own simulation (the ActionResult against the minimum and the expected liquidity).
 *   L2  only a root its vault reads ARMED pauses automation (vault.rootArmed(), root()).
 *   L3  a Universal Router leg's own deadline is not before the intent's.
 *   L5  no "chosen recipient": the recipient is the connected wallet, always.
 *
 * Nothing here touches a network; the keys are Anvil's public dev keys, on a fake chain only.
 */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { concatHex, encodeAbiParameters, encodeFunctionData, parseAbi } from 'viem';
import * as runtime from '../../../api-contracts/position-plan-v1/runtime.mjs';
import { createV2Chain, walletOf } from '../support/v2-chain.mjs';
import { planAnswer } from '../support/s1-plans.mjs';
import * as fx from './support/plans.mjs';

const require = createRequire(import.meta.url);
const BUILD = '../../.test-build/app/src/';
const plan = require(`${BUILD}finance/v2/plan.js`);
const route = require(`${BUILD}v2/plan/route.js`);
const { createZapClient, ZapRefusal } = require(`${BUILD}finance/v2/zap.js`);
const { forgetV2DeploymentChecks } = require(`${BUILD}finance/v2/deployment.js`);
const { createTransactor } = require(`${BUILD}finance/v2/transact.js`);
const { createUnsettledActions, isUnsettledAction, zapUnsettledKey, ZAP_UNSETTLED_PREFIX } = require(`${BUILD}finance/v2/zapUnsettled.js`);
const { parsePlanAnswer } = require(`${BUILD}v2/plan/parse.js`);
const { planRequestWire } = require(`${BUILD}v2/plan/request.js`);
const chains = require(`${BUILD}v2/chains.js`);

const GAS = { maxGas: 8_000_000n, maxFeePerGas: 200_000_000n, maxPriorityFeePerGas: 0n, reserveWei: 0n };
const HASH = /^0x[0-9a-f]{64}$/;
const VAULT = '0x00000000000000000000000000000000000000aa';
const PRINCIPAL = [5n * 10n ** 17n, 2_000_000_000n];
const V4_POSITION = { dex: 4, tokenId: fx.POSITION.tokenId, pool: fx.ETH_USDG_V4, tickLower: fx.POSITION.tickLower, tickUpper: fx.POSITION.tickUpper, liquidity: fx.POSITION.liquidity, principal: PRINCIPAL, fees: [10n ** 15n, 1_000_000n] };
/** A v4 pool of ETH and the stand-in stock token: where a hostile converted exit would send the withdrawn ETH. */
const ETH_TSLA_V4 = { dex: 4, currency0: fx.ZERO, currency1: fx.TSLA, fee: 3000, tickSpacing: 60, hooks: fx.ZERO };

function setup(options = {}, { wallet = {}, unsettled, clock = () => fx.NOW } = {}) {
  forgetV2DeploymentChecks();
  const chain = createV2Chain({ balances: { [fx.USDG]: 5_000_000_000n }, pools: fx.PRICED, ...options });
  const w = walletOf(chain, wallet);
  const raw = createZapClient(w, chains.v2Chain(chain.home), chain.contracts, clock, undefined, unsettled);
  return { chain, wallet: w, raw, client: fx.honest(raw, chain) };
}
const quoteOf = (zapPlan, extra = {}) => ({ requestedAt: fx.NOW, expiresAt: fx.NOW + 180, legs: fx.quotedFor(zapPlan.legs), simulation: { ok: true, block: 77_000_000n, error: null }, ...extra });
const reviewOf = (client, action, zapPlan, { quote = {}, input = {} } = {}) => client.review({ chainId: 4663, plan: { action, plan: zapPlan }, consent: 'direct', quote: quoteOf(zapPlan, quote), ...input });
const sends = (chain) => chain.log.filter((method) => method === 'eth_sendTransaction' || method === 'wallet_sendCalls').length;
/** The page's batch latch in memory (finance/nonce.ts's semantics). */
function memoryLatch() {
  const map = new Map();
  return {
    batchOffered: (key) => (map.has(key) ? map.get(key).id ?? '' : null),
    async claimBatch(key) { if (map.has(key)) throw new Error('wallet_batch_already_offered'); const claim = `claim-${map.size}`; map.set(key, { claim }); return claim; },
    async recordBatch(key, claim, id) { if (map.get(key)?.claim === claim) map.get(key).id = id; },
    async releaseBatch(key, claim) { const entry = map.get(key); if (entry && (entry.claim === claim || entry.id === claim)) map.delete(key); },
    async expireBatch() { return false; },
  };
}
/** Another plan for the same create (another quote: its intent, and so its intentHash, differ). */
const another = () => fx.createWithSwap({ intent: fx.intent({ minLiquidity: 1_000_001n }) });
/** A converted exit whose one leg sends the withdrawn ETH into TSLA (a valid v4 path), sealed with the rank rule's fee. */
const hostileExit = () => {
  const exit = fx.exitConverted();
  return fx.sealed({ ...exit, legs: [{ ...exit.legs[0], tokenOut: fx.TSLA, data: fx.v4Path(ETH_TSLA_V4) }] }, fx.ZERO);
};

// ---------------------------------------------------------------------------------------------------------------------
// F1: swap-leg outputs tied to the request
// ---------------------------------------------------------------------------------------------------------------------

test('F1 route rules: every leg leads to what the request names, spends what is held; an exit to both tokens swaps nothing', () => {
  const W = fx.ROBINHOOD.wrappedNative.address;
  assert.equal(W, fx.WETH);
  const legs = (...pairs) => pairs.map(([tokenIn, tokenOut]) => ({ tokenIn, tokenOut }));
  const exitTo = (token) => ({ action: 'exit', receive: { convertTo: token } });
  // A converted exit from the ETH/USDG pool to USDG: straight, or through a hop; never into a token nobody asked for.
  assert.deepEqual(route.routeProblems(legs([fx.ZERO, fx.USDG]), exitTo(fx.USDG), fx.ETH_USDG_V4, W), []);
  assert.deepEqual(route.routeProblems(legs([fx.ZERO, fx.TSLA], [fx.TSLA, fx.USDG]), exitTo(fx.USDG), fx.ETH_USDG_V4, W), [], 'TSLA is a hop a later leg spends');
  assert.deepEqual(route.routeProblems(legs([fx.ZERO, fx.TSLA]), exitTo(fx.USDG), fx.ETH_USDG_V4, W), ['plan_route_target']);
  assert.deepEqual(route.routeProblems(legs([fx.USDG, fx.ZERO]), exitTo(fx.USDG), fx.ETH_USDG_V4, W), ['plan_route_target'], 'converting away from the token asked for');
  // A leg that spends what nothing delivered yet (a later leg's output, or a token outside the position).
  assert.ok(route.routeProblems(legs([fx.TSLA, fx.USDG], [fx.ZERO, fx.TSLA]), exitTo(fx.USDG), fx.ETH_USDG_V4, W).includes('plan_route_source'));
  assert.deepEqual(route.routeProblems(legs([fx.MANY, fx.USDG]), exitTo(fx.USDG), fx.ETH_USDG_V4, W), ['plan_route_source']);
  // Exit to both tokens (§2.6.4: legs = []).
  assert.deepEqual(route.routeProblems([], { action: 'exit', receive: 'both' }, fx.ETH_USDG_V4, W), []);
  assert.deepEqual(route.routeProblems(legs([fx.ZERO, fx.USDG]), { action: 'exit', receive: 'both' }, fx.ETH_USDG_V4, W), ['plan_route_target']);
  // Create, increase, change of range: the swaps end in the pool's own currencies; the inputs and the pool's are held.
  const create = { action: 'create', inputs: [{ token: fx.TSLA, amount: 1n }] };
  assert.deepEqual(route.routeProblems(legs([fx.TSLA, fx.USDG], [fx.USDG, fx.ZERO]), create, fx.ETH_USDG_V4, W), []);
  assert.deepEqual(route.routeProblems(legs([fx.TSLA, fx.MANY]), create, fx.ETH_USDG_V4, W), ['plan_route_target']);
  assert.deepEqual(route.routeProblems(legs([fx.MANY, fx.USDG]), create, fx.ETH_USDG_V4, W), ['plan_route_source'], 'MANY is neither an input nor the pool’s');
  assert.deepEqual(route.routeProblems(legs([fx.USDG, fx.ZERO]), { action: 'changeRange' }, fx.ETH_USDG_V4, W), []);
  assert.deepEqual(route.routeProblems(legs([fx.USDG, fx.TSLA]), { action: 'changeRange' }, fx.ETH_USDG_V4, W), ['plan_route_target']);
  // §2.7: on a v3 pool with WETH, ETH that reaches the mint is wrapped first; on a v4 ETH pool, WETH is not ETH.
  const increase = { action: 'increase', inputs: [{ token: fx.USDG, amount: 1n }] };
  assert.deepEqual(route.routeProblems(legs([fx.USDG, fx.ZERO]), increase, fx.WETH_USDG_V3, W), []);
  assert.deepEqual(route.routeProblems(legs([fx.USDG, W]), increase, fx.ETH_USDG_V4, W), ['plan_route_target']);
  // The request's own target.
  assert.deepEqual(route.planTargetOf({ action: 'exit', receive: { convertTo: fx.USDG.toUpperCase().replace('0X', '0x') } }), { action: 'exit', receive: { convertTo: fx.USDG } });
  assert.deepEqual(route.planTargetOf({ action: 'exit', receive: 'both' }), { action: 'exit', receive: 'both' });
  assert.equal(route.planTargetOf({ action: 'exit' }), null);
});

test('F1 checkPlan: a converted exit whose leg delivers another token than the one asked is refused; so are inputs that are not the request\'s', () => {
  const exit = fx.exitConverted();
  const ctx = fx.context({ quotedLegs: fx.quotedFor(exit.legs), expectedRemoved: [5n * 10n ** 17n, 2_000_000_000n] });
  const toUsdg = { action: 'exit', receive: { convertTo: fx.USDG } };
  assert.deepEqual(plan.checkPlan({ action: 'exit', plan: exit }, { ...ctx, target: toUsdg }).failures, []);
  assert.deepEqual(plan.checkPlan({ action: 'exit', plan: exit }, { ...ctx, target: { action: 'exit', receive: { convertTo: fx.ZERO } } }).failures, ['plan_route_target'], 'ETH asked, USDG delivered');
  assert.deepEqual(plan.checkPlan({ action: 'exit', plan: exit }, { ...ctx, target: { action: 'exit', receive: 'both' } }).failures, ['plan_route_target'], 'both tokens asked, a swap planned');
  // The hostile plan of the finding: the withdrawn ETH routed into TSLA. Every other check passes.
  const hostile = hostileExit();
  assert.deepEqual(plan.checkPlan({ action: 'exit', plan: hostile }, { ...ctx, quotedLegs: fx.quotedFor(hostile.legs), target: toUsdg }).failures, ['plan_route_target']);
  // Inputs: exactly the request's, in order; the target's action is the plan's; a target is required.
  const create = fx.createWithSwap();
  const createCtx = fx.context({ quotedLegs: fx.quotedFor(create.legs) });
  assert.deepEqual(plan.checkPlan({ action: 'create', plan: create }, { ...createCtx, target: fx.targetOf({ action: 'create', plan: create }) }).failures, []);
  assert.deepEqual(plan.checkPlan({ action: 'create', plan: create }, { ...createCtx, target: { action: 'create', inputs: [{ token: fx.USDG, amount: 999_999_999n }] } }).failures, ['plan_target']);
  assert.deepEqual(plan.checkPlan({ action: 'create', plan: create }, { ...createCtx, target: { action: 'increase', inputs: create.inputs } }).failures, ['plan_target']);
  assert.deepEqual(plan.checkPlan({ action: 'create', plan: create }, { ...createCtx, target: undefined }).failures, ['plan_target']);
});

test('F1 zap client: the hostile converted exit is refused at review, before anything is asked of the wallet; a review needs the request\'s target', async () => {
  const { chain, raw } = setup({ positions: [V4_POSITION] });
  const hostile = hostileExit();
  await assert.rejects(
    raw.review(fx.honestInput({ chainId: 4663, plan: { action: 'exit', plan: hostile }, consent: 'direct', quote: quoteOf(hostile, { expectedRemoved: PRINCIPAL }), target: { action: 'exit', receive: { convertTo: fx.USDG } } }, chain)),
    (error) => error instanceof ZapRefusal && error.failures.includes('plan_route_target'),
  );
  const exit = fx.exitConverted();
  const input = fx.honestInput({ chainId: 4663, plan: { action: 'exit', plan: exit }, consent: 'direct', quote: quoteOf(exit, { expectedRemoved: PRINCIPAL }) }, chain);
  delete input.target;
  await assert.rejects(raw.review(input), (error) => error instanceof ZapRefusal && error.failures.includes('plan_target'));
  const honest = await raw.review({ ...input, target: { action: 'exit', receive: { convertTo: fx.USDG } } });
  assert.equal(honest.action, 'exit');
  assert.equal(sends(chain), 0);
});

test('F1 parse: a plan answer the package accepts, whose converted exit ends in another token than `receive`, is invalid (route)', () => {
  const chain = fx.ROBINHOOD;
  const request = { chainId: 4663, action: 'exit', consent: 'direct', position: { dex: 4, tokenId: fx.POSITION.tokenId }, liquidityToRemove: 'all', burn: false, receive: { convertTo: fx.USDG }, slippageBps: 50 };
  const wire = planRequestWire(request);
  const position = { tokenId: fx.POSITION.tokenId, manager: chain.uniswap.v4.positionManager, tickLower: fx.POSITION.tickLower, tickUpper: fx.POSITION.tickUpper, liquidity: fx.POSITION.liquidity, feesOwed: [0n, 0n] };
  const base = { owner: fx.OWNER, zap: fx.FAKE.zapV4, now: fx.NOW, pool: { sqrtPriceX96: fx.SQRT, tick: 0 }, positionPool: fx.ETH_USDG_V4, position };
  const context = { owner: fx.OWNER, zaps: { 3: fx.FAKE.zapV3, 4: fx.FAKE.zapV4 }, permit2: chain.permit2, managers: { 3: chain.uniswap.v3.positionManager, 4: chain.uniswap.v4.positionManager }, now: fx.NOW + 1 };
  const honest = planAnswer(wire, { ...base, legs: [{ tokenIn: fx.ZERO, tokenOut: fx.USDG, amountIn: 10n ** 9n, expectedOut: 1_000n, data: fx.v4Path(fx.ETH_USDG_V4) }] });
  assert.equal(runtime.validateResponse('plan', honest), true);
  const ok = parsePlanAnswer({ status: 200, body: honest }, request, wire, context, runtime);
  assert.equal(ok.kind, 'ok');
  const hostile = planAnswer(wire, { ...base, legs: [{ tokenIn: fx.ZERO, tokenOut: fx.TSLA, amountIn: 10n ** 9n, expectedOut: 1_000n, data: fx.v4Path(ETH_TSLA_V4) }] });
  assert.equal(runtime.validateResponse('plan', hostile), true, 'the package\'s request match does not read `receive`: the gap the app closes');
  assert.deepEqual(parsePlanAnswer({ status: 200, body: hostile }, request, wire, context, runtime), { kind: 'invalid', detail: 'route' });
  // Asked for both tokens, answered with a swap: invalid too.
  const bothRequest = { ...request, receive: 'both' };
  const bothWire = planRequestWire(bothRequest);
  const swapping = planAnswer(bothWire, { ...base, legs: [{ tokenIn: fx.ZERO, tokenOut: fx.USDG, amountIn: 10n ** 9n, expectedOut: 1_000n, data: fx.v4Path(fx.ETH_USDG_V4) }] });
  assert.equal(runtime.validateResponse('plan', swapping), true);
  assert.deepEqual(parsePlanAnswer({ status: 200, body: swapping }, bothRequest, bothWire, context, runtime), { kind: 'invalid', detail: 'route' });
  // The quote carries what the minimums were computed from (F4).
  const basis = ok.reply.quote.basis;
  assert.deepEqual([basis.slippageBps, basis.poolSqrtPriceX96, basis.position.liquidity], [50, fx.SQRT, fx.POSITION.liquidity]);
  assert.deepEqual(basis.removalBand, { lower: BigInt(honest.plan.minimums.removalBand.lowerSqrtPriceX96), upper: BigInt(honest.plan.minimums.removalBand.upperSqrtPriceX96) });
  assert.equal(basis.mintBand, null);
});

// ---------------------------------------------------------------------------------------------------------------------
// L3 and L5
// ---------------------------------------------------------------------------------------------------------------------

test('L3: a Universal Router leg\'s own deadline is not before the intent\'s; calldata whose deadline cannot be read is refused', () => {
  const ur = fx.ROBINHOOD.uniswap.universalRouter.address;
  const base = fx.createWithSwap();
  const withData = (data) => fx.sealed({ ...base, legs: [{ kind: 1, router: ur, tokenIn: fx.USDG, tokenOut: fx.ZERO, amountIn: 500_000_000n, minAmountOut: 1n, data }] }, fx.USDG);
  const failures = (p) => plan.checkPlan({ action: 'create', plan: p }, fx.context({ quotedLegs: fx.quotedFor(p.legs), target: fx.targetOf({ action: 'create', plan: p }) })).failures;
  const deadline = base.intent.deadline;
  assert.deepEqual(failures(withData(fx.urExecute(deadline))), [], 'the same deadline');
  assert.deepEqual(failures(withData(fx.urExecute(deadline + 3_600n))), [], 'a later one');
  assert.deepEqual(failures(withData(fx.urExecute(deadline - 1n))), ['plan_leg_router_deadline'], 'one second before the intent\'s');
  const noDeadline = concatHex(['0x24856bc3', encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], ['0x', []])]);
  assert.deepEqual(failures(withData(noDeadline)), ['plan_leg_router_deadline'], 'execute(bytes,bytes[]) has no deadline to check');
  assert.deepEqual(failures(withData('0x3593564c')), ['plan_leg_router_deadline'], 'cut short');
  assert.equal(plan.urDeadline(fx.urExecute(123n)), 123n);
  assert.equal(plan.urDeadline('0xdeadbeef'), null);
});

test('L5: no "chosen recipient" reaches the zap client: a plan paying another account is refused on the direct path too', async () => {
  const { chain, client } = setup();
  const p = fx.createWithSwap();
  const toOther = { ...p, intent: { ...p.intent, recipient: fx.OTHER } };
  await assert.rejects(reviewOf(client, 'create', toOther, { input: { chosenRecipient: fx.OTHER } }), (error) => error instanceof ZapRefusal && error.failures.includes('plan_recipient'));
  assert.equal(sends(chain), 0);
});

// ---------------------------------------------------------------------------------------------------------------------
// F4: minimums tied to the app's own reads and simulation
// ---------------------------------------------------------------------------------------------------------------------

test('F4 math: the app\'s band is the package\'s, exactly (bandSqrtPrice, isqrt)', () => {
  for (const sqrt of [fx.SQRT, 4295128740n, 3961408125713216879677197n, 1461446703485210103287273052203988822378723970341n, fx.SQRT * 7n + 13n]) {
    for (const s of [10, 50, 200, 500]) {
      for (const step of [-2, -1, 0, 1, 2]) assert.equal(plan.bandSqrtPrice(sqrt, s, step), runtime.bandSqrtPrice(sqrt, s, step), `${sqrt} ${s} ${step}`);
    }
  }
  for (const n of [0n, 1n, 2n, 3n, 4n, 99n, 10n ** 40n + 7n]) assert.equal(plan.isqrt(n), runtime.isqrt(n));
});

test('F4 basis: the price read inside the plan\'s band, its bands ±s around its own prices, the position its removal used', () => {
  const create = fx.createWithSwap();
  const zc = { action: 'create', plan: create };
  const reads = { poolSqrtPriceX96: fx.SQRT, position: null };
  const basis = fx.basisFor(create);
  assert.deepEqual(plan.basisProblems(zc, basis, reads, false), []);
  const band = plan.bandAround(fx.SQRT, 50);
  assert.deepEqual(plan.basisProblems(zc, basis, { ...reads, poolSqrtPriceX96: band.upper }, false), [], 'the band\'s edge');
  assert.deepEqual(plan.basisProblems(zc, basis, { ...reads, poolSqrtPriceX96: band.upper + 1n }, false), ['plan_price_moved']);
  assert.deepEqual(plan.basisProblems(zc, basis, { ...reads, poolSqrtPriceX96: band.lower - 1n }, false), ['plan_price_moved']);
  assert.deepEqual(plan.basisProblems(zc, basis, { ...reads, poolSqrtPriceX96: null }, false), ['plan_pool_unpriced']);
  // A lying planner: its minimums computed at another price than the chain's.
  assert.deepEqual(plan.basisProblems(zc, fx.basisFor(create, { poolSqrt: fx.SQRT * 2n }), reads, false), ['plan_price_moved']);
  // Bands that are not ±s around the plan's own prices; an expected liquidity under the minimum.
  assert.deepEqual(plan.basisProblems(zc, { ...basis, mintBand: { lower: basis.mintBand.lower - 1n, upper: basis.mintBand.upper } }, reads, false), ['plan_basis']);
  assert.deepEqual(plan.basisProblems(zc, { ...basis, slippageBps: 100 }, reads, false), ['plan_basis']);
  assert.deepEqual(plan.basisProblems(zc, { ...basis, expectedLiquidity: create.intent.minLiquidity - 1n }, reads, false), ['plan_basis']);
  // No leg through the pool (an increase with no swap): the mint meets the price read, so the post-swap price is it.
  const increase = fx.increasePlan();
  const zi = { action: 'increase', plan: increase };
  assert.deepEqual(plan.basisProblems(zi, fx.basisFor(increase), reads, false), []);
  assert.deepEqual(plan.basisProblems(zi, fx.basisFor(increase, { sqrtAfter: fx.SQRT + 1_000n }), reads, false), ['plan_basis']);
  assert.equal(plan.legsCrossPool(create.legs, fx.ETH_USDG_V4), true);
  assert.equal(plan.legsCrossPool(create.legs, { ...fx.ETH_USDG_V4, fee: 500, tickSpacing: 10 }), false);
  const v3leg = { kind: 2, router: fx.ZERO, tokenIn: fx.USDG, tokenOut: fx.MANY, amountIn: 1n, minAmountOut: 1n, data: fx.v3Path(fx.USDG, 3000, fx.MANY) };
  assert.equal(plan.legsCrossPool([v3leg], fx.USDG_MANY_V3), true);
  assert.equal(plan.legsCrossPool([{ ...v3leg, data: fx.v3Path(fx.USDG, 500, fx.MANY) }], fx.USDG_MANY_V3), false, 'another tier is another pool');
  // A removal: the position's range and liquidity are the ones its minimums used.
  const exit = fx.exitConverted();
  const ze = { action: 'exit', plan: exit };
  const read = { ...fx.POSITION };
  assert.deepEqual(plan.basisProblems(ze, fx.basisFor(exit), { poolSqrtPriceX96: fx.SQRT, position: read }, false), []);
  assert.deepEqual(plan.basisProblems(ze, fx.basisFor(exit), { poolSqrtPriceX96: fx.SQRT, position: { ...read, liquidity: read.liquidity / 2n } }, false), ['plan_position_changed']);
  assert.deepEqual(plan.basisProblems(ze, fx.basisFor(exit), { poolSqrtPriceX96: fx.SQRT, position: { ...read, tickUpper: read.tickUpper + 60 } }, false), ['plan_position_changed']);
  assert.deepEqual(plan.basisProblems(ze, { ...fx.basisFor(exit), position: null }, { poolSqrtPriceX96: fx.SQRT, position: read }, false), ['plan_basis']);
  // A new pool: unpriced, its band at the app's own starting price.
  const init = 3961408125713216879677197n;
  const creating = fx.createWithSwap({ initSqrtPriceX96: init });
  assert.deepEqual(plan.basisProblems({ action: 'create', plan: creating }, fx.basisFor(creating), { poolSqrtPriceX96: null, position: null }, true), []);
  assert.deepEqual(plan.basisProblems({ action: 'create', plan: creating }, { ...fx.basisFor(creating), poolSqrtPriceX96: fx.SQRT }, { poolSqrtPriceX96: null, position: null }, true), ['plan_basis']);
});

test('F4 simulation: the ActionResult is this plan\'s, at least its minimum, and within its tolerance of the expected liquidity', () => {
  const create = fx.createWithSwap();
  const zc = { action: 'create', plan: create };
  const min = create.intent.minLiquidity;
  const basis = fx.basisFor(create, { expectedLiquidity: min + min / 50n });
  const result = (over = {}) => ({ tokenId: 9n, liquidity: min + min / 100n, amount0: 1n, amount1: 1n, feeToken: fx.USDG, feeAmount: 1n, ...over });
  assert.deepEqual(plan.actionResultProblems(zc, basis, result()), []);
  assert.deepEqual(plan.actionResultProblems(zc, basis, result({ liquidity: min - 1n })), ['plan_simulated_below_minimum']);
  assert.deepEqual(plan.actionResultProblems(zc, basis, result({ liquidity: min + min / 50n + min / 50n + 1n })), ['plan_simulated_off_expected'], 'further above the expected than its tolerance');
  assert.deepEqual(plan.actionResultProblems(zc, { ...basis, expectedLiquidity: min }, result()), ['plan_simulated_off_expected'], 'no tolerance');
  assert.deepEqual(plan.actionResultProblems(zc, basis, result({ tokenId: 0n })), ['plan_simulated_result']);
  assert.deepEqual(plan.actionResultProblems(zc, basis, result({ feeToken: fx.ZERO })), ['plan_simulated_result']);
  assert.deepEqual(plan.actionResultProblems(zc, basis, null), ['plan_simulated_result']);
  const exit = fx.exitConverted();
  const exitResult = { tokenId: fx.POSITION.tokenId, liquidity: exit.liquidityToRemove, amount0: 1n, amount1: 1n, feeToken: fx.USDG, feeAmount: 1n };
  assert.deepEqual(plan.actionResultProblems({ action: 'exit', plan: exit }, fx.basisFor(exit), exitResult), []);
  assert.deepEqual(plan.actionResultProblems({ action: 'exit', plan: exit }, fx.basisFor(exit), { ...exitResult, liquidity: exit.liquidityToRemove - 1n }), ['plan_simulated_result']);
  const encoded = encodeAbiParameters([{ type: 'tuple', components: [{ name: 'tokenId', type: 'uint256' }, { name: 'liquidity', type: 'uint128' }, { name: 'amount0', type: 'uint256' }, { name: 'amount1', type: 'uint256' }, { name: 'feeToken', type: 'address' }, { name: 'feeAmount', type: 'uint256' }] }], [result()]);
  assert.deepEqual(plan.actionResultOf(encoded), result());
  assert.equal(plan.actionResultOf('0x'), null);
});

test('F4 zap client: a pool price moved past the plan\'s band, or a position changed since the plan, refuses the review', async () => {
  const p = fx.createWithSwap();
  const moved = setup();
  // The plan's minimums were taken at 1.0; the chain is 1.2% above (the band is ±0.5% at the default slippage).
  moved.chain.initializePool(fx.ETH_USDG_V4, (fx.SQRT * 1006n) / 1000n);
  await assert.rejects(reviewOf(moved.client, 'create', p, { quote: { basis: fx.basisFor(p) } }), (error) => error instanceof ZapRefusal && error.failures.includes('plan_price_moved'));
  // A planner that misstates the price: its bands around a price twice the chain's.
  const lying = setup();
  await assert.rejects(reviewOf(lying.client, 'create', p, { quote: { basis: fx.basisFor(p, { poolSqrt: fx.SQRT * 2n }) } }), (error) => error.failures.includes('plan_price_moved'));
  // A pool with no price for a plan that does not create it.
  const unpriced = setup({ pools: [] });
  await assert.rejects(reviewOf(unpriced.client, 'create', p, { quote: { basis: fx.basisFor(p) } }), (error) => error.failures.includes('plan_pool_unpriced'));
  // The position halved since the plan: its removal minimums no longer hold.
  const exit = fx.exitConverted({ liquidityToRemove: fx.POSITION.liquidity / 2n, burn: false, intent: fx.intent({ action: 4, tokenId: fx.POSITION.tokenId, minLiquidity: fx.POSITION.liquidity / 2n }) });
  const sealed = fx.sealed(exit, fx.USDG);
  const changed = setup({ positions: [{ ...V4_POSITION, liquidity: fx.POSITION.liquidity / 2n }] });
  await assert.rejects(reviewOf(changed.client, 'exit', sealed, { quote: { expectedRemoved: PRINCIPAL, basis: fx.basisFor(sealed) } }), (error) => error.failures.includes('plan_position_changed'));
  // Honest plans pass (the bases read from the same chain).
  assert.ok(await reviewOf(setup().client, 'create', p));
  assert.equal(sends(moved.chain) + sends(lying.chain) + sends(changed.chain), 0);
});

test('F4 zap client: the action\'s own simulation is checked against the plan when it is prepared, as a step or in a batch', async () => {
  const p = fx.createWithSwap();
  const tight = fx.basisFor(p, { expectedLiquidity: p.intent.minLiquidity });
  // The fake zap mints 1% above the minimum; a plan that expects exactly the minimum has no tolerance for it.
  const { chain, client } = setup({ atomic: 'supported', simulateV1: true });
  const review = await reviewOf(client, 'create', p, { quote: { basis: tight } });
  await client.send(await client.prepareStep(review, 0, GAS), true);
  await assert.rejects(client.prepareStep(review, 1, GAS), (error) => error instanceof ZapRefusal && error.failures.includes('plan_simulated_off_expected'));
  await assert.rejects(client.prepareBatch(review, GAS), (error) => error instanceof ZapRefusal && error.failures.includes('plan_simulated_off_expected'));
  assert.equal(chain.sends.length, 1, 'only the approval');
  // The honest plan: prepared, as a step and as a batch.
  const ok = setup({ atomic: 'supported', simulateV1: true });
  const fine = await reviewOf(ok.client, 'create', p);
  assert.ok(await ok.client.prepareBatch(fine, GAS));
  await ok.client.send(await ok.client.prepareStep(fine, 0, GAS), true);
  assert.ok(await ok.client.prepareStep(fine, 1, GAS));
});

test('F4 transact: the step\'s simulation is handed to the caller\'s check at prepare and right before the send, before any nonce is claimed', async () => {
  const chain = createV2Chain({ balances: { [fx.USDG]: 10n ** 9n } });
  const wallet = walletOf(chain);
  const t = createTransactor(wallet, chains.v2Chain(4663), () => fx.NOW);
  const draft = { kind: 'approve', to: fx.USDG, value: 0n, data: encodeFunctionData({ abi: parseAbi(['function approve(address,uint256) returns (bool)']), functionName: 'approve', args: [fx.FAKE.zapV4, 1n] }), summary: ['Approve.'] };
  const seen = [];
  const prepared = await t.bounded(async (rpc) => { await t.identity(rpc); return t.prepare(rpc, draft, GAS, (returned) => seen.push(returned)); });
  assert.equal(seen.length, 1);
  assert.equal(BigInt(seen[0]), 1n, 'approve returned true');
  await assert.rejects(t.send(prepared, true, undefined, { inspect: () => { throw new Error('plan_simulated_result'); } }), /plan_simulated_result/);
  assert.deepEqual(wallet.claims, [], 'no nonce claimed');
  assert.equal(chain.sends.length, 0);
  await assert.rejects(t.bounded(async (rpc) => { await t.identity(rpc); return t.prepare(rpc, draft, GAS, () => { throw new Error('refused'); }); }), /refused/);
});

// ---------------------------------------------------------------------------------------------------------------------
// F2: the wallet's answer kept
// ---------------------------------------------------------------------------------------------------------------------

test('F2 transact: the hash is kept when the account or the chain changes right after the wallet answered; a read still stops', async () => {
  const chain = createV2Chain({ balances: { [fx.USDG]: 10n ** 9n } });
  let connected = true;
  const wallet = walletOf(chain, { current: () => connected });
  const t = createTransactor(wallet, chains.v2Chain(4663), () => fx.NOW);
  const approve = (amount) => ({ kind: 'approve', to: fx.USDG, value: 0n, data: encodeFunctionData({ abi: parseAbi(['function approve(address,uint256) returns (bool)']), functionName: 'approve', args: [fx.FAKE.zapV4, amount] }), summary: ['Approve.'] });
  const prepare = (draft) => t.bounded(async (rpc) => { await t.identity(rpc); return t.prepare(rpc, draft, GAS); });
  const first = await prepare(approve(1n));
  chain.once('eth_sendTransaction', () => { connected = false; });
  const hash = await t.send(first, true);
  connected = true;
  assert.match(hash, HASH, 'the account changed after the answer: the hash is kept, not thrown away');
  assert.equal((await t.receipt(hash)).state, 'finalized', 'and followed to its receipt');
  assert.equal(t.wasOffered(first), true);
  const second = await prepare(approve(2n));
  chain.once('eth_sendTransaction', () => chain.switchTo(8453));
  const other = await t.send(second, true);
  chain.switchTo(4663);
  assert.match(other, HASH, 'the chain changed after the answer: kept too');
  assert.equal(chain.sends.length, 2);
  // Any other call still stops the operation when the wallet changed after its answer.
  await assert.rejects(t.bounded(async (rpc) => {
    chain.once('eth_chainId', () => { connected = false; });
    await rpc('eth_chainId', []);
  }), /wallet_identity_changed/);
  connected = true;
});

test('F2 batch: the wallet\'s batch id is kept when the wallet changes right after answering, and the batch is followed', async () => {
  let connected = true;
  const { chain, client } = setup({ atomic: 'supported', simulateV1: true }, { wallet: { current: () => connected } });
  const latch = memoryLatch();
  const review = await reviewOf(client, 'create', fx.createWithSwap());
  const batch = await client.prepareBatch(review, GAS);
  chain.once('wallet_sendCalls', () => { connected = false; });
  const id = await client.sendBatch(batch, true, () => latch);
  connected = true;
  assert.equal(typeof id, 'string');
  assert.equal(chain.batches.length, 1);
  assert.equal((await client.batchReceipt(id, () => latch)).state, 'finalized');
});

// ---------------------------------------------------------------------------------------------------------------------
// F3: the owner-wide record of actions with no known outcome
// ---------------------------------------------------------------------------------------------------------------------

/** Answers the next send (or batch offer) with nothing usable, without the fake chain running it: the wallet may still hold it. */
function loseNext(chain, method, reply = { result: null }) {
  const answers = chain.request;
  chain.request = async (m, params) => {
    if (m !== method) return answers(m, params);
    chain.request = answers;
    chain.log.push(m);
    return reply;
  };
}

test('F3: a step handed to the wallet with no answer holds every new review, action and batch of this owner on this chain; "I rejected it" lets it go', async () => {
  const { chain, wallet, raw, client } = setup({ atomic: null });
  const review = await reviewOf(client, 'create', fx.createWithSwap());
  await client.send(await client.prepareStep(review, 0, GAS), true);
  const action = await client.prepareStep(review, 1, GAS);
  loseNext(chain, 'eth_sendTransaction');
  await assert.rejects(client.send(action, true), /wallet_result_unknown/);
  const [held] = raw.unsettled();
  assert.deepEqual({ ...held, at: 0 }, { chainId: 4663, zap: fx.FAKE.zapV4, intentHash: review.intentHash, fromBlock: review.block.toString(), deadline: review.deadline.toString(), kind: 'step', hash: null, batchId: null, nonce: '1', at: 0 });
  // Another plan for the same thing (a re-review): refused, said as "already sent, check your wallet".
  const again = another();
  await assert.rejects(reviewOf(client, 'create', again), /zap_action_unsettled/);
  // The person says they rejected it, while the chain shows nothing pending (its nonce still the next one): let go,
  // with its nonce latch; nothing is sent.
  assert.equal(wallet.nonceOffered(4663, 1n), true);
  const before = chain.sends.length;
  assert.equal(await raw.forgetUnsettled(), 'forgotten');
  assert.equal(chain.sends.length, before, 'nothing sent');
  assert.equal(wallet.nonceOffered(4663, 1n), false);
  assert.deepEqual(raw.unsettled(), []);
  const fresh = await reviewOf(client, 'create', again);
  assert.ok(await client.prepareStep(fresh, fresh.steps.findIndex((step) => step.kind === 'action'), GAS), 'a new action can be prepared');
  assert.equal(await raw.forgetUnsettled(), 'none');
});

test('F3: while a step is held, an earlier review\'s action is neither prepared, sent nor batched', async () => {
  const { chain, client } = setup({ atomic: 'supported', simulateV1: true });
  // Review B is made first; then review A's action is handed to the wallet and its answer lost.
  const b = await reviewOf(client, 'create', another());
  const a = await reviewOf(client, 'create', fx.createWithSwap());
  await client.send(await client.prepareStep(a, 0, GAS), true);
  const action = await client.prepareStep(a, 1, GAS);
  loseNext(chain, 'eth_sendTransaction');
  await assert.rejects(client.send(action, true), /wallet_result_unknown/);
  const bAction = b.steps.findIndex((step) => step.kind === 'action');
  await assert.rejects(client.prepareStep(b, bAction, GAS), /zap_action_unsettled/);
  await assert.rejects(client.prepareBatch(b, GAS), /zap_action_unsettled/);
});

test('F3: while a step is held, no Permit2 signature is given for another plan (a signed permit can be submitted by anyone)', async () => {
  const { chain, client } = setup({ atomic: null, allowances: [{ token: fx.USDG, spender: fx.ROBINHOOD.permit2, amount: 10n ** 10n }, { token: fx.USDG, spender: fx.FAKE.zapV4, amount: 10n ** 10n }] });
  const signed = fx.sealed({ ...fx.createWithSwap(), intent: { ...fx.createWithSwap().intent, nonce: 7n << 8n } }, fx.USDG);
  const b = await client.review({ chainId: 4663, plan: { action: 'create', plan: signed }, consent: 'permit2', quote: quoteOf(signed) });
  assert.deepEqual(b.steps.map((step) => step.kind), ['sign-permit', 'action']);
  const a = await reviewOf(client, 'create', fx.createWithSwap());
  const action = await client.prepareStep(a, a.steps.findIndex((step) => step.kind === 'action'), GAS);
  loseNext(chain, 'eth_sendTransaction');
  await assert.rejects(client.send(action, true), /wallet_result_unknown/);
  await assert.rejects(client.signPermit(b), /zap_action_unsettled/);
  assert.equal(chain.signed.length, 0, 'never prompted');
});

test('F3: the chain settles a held action by itself: its receipt, its event by intentHash, its nonce taken, or its deadline passed', async () => {
  // Its receipt: the wallet ran it and its answer (the hash) was kept (F2), then the page did not follow it.
  const kept = setup({ atomic: null });
  const r1 = await reviewOf(kept.client, 'create', fx.createWithSwap());
  await kept.client.send(await kept.client.prepareStep(r1, 0, GAS), true);
  const hash = await kept.client.send(await kept.client.prepareStep(r1, 1, GAS), true);
  assert.equal(kept.raw.unsettled()[0].hash, hash);
  assert.ok(await reviewOf(kept.client, 'create', another()), 'its receipt settles it');
  assert.deepEqual(kept.raw.unsettled(), []);
  // Its event by intentHash: a batch the wallet ran, whose id never came back.
  const ran = setup({ atomic: 'supported', simulateV1: true });
  const r2 = await reviewOf(ran.client, 'create', fx.createWithSwap());
  const batch = await ran.client.prepareBatch(r2, GAS);
  const answers = ran.chain.request;
  ran.chain.request = async (method, params) => {
    const reply = await answers(method, params);
    if (method === 'wallet_sendCalls') { ran.chain.request = answers; return { result: {} }; }
    return reply;
  };
  await assert.rejects(ran.client.sendBatch(batch, true, () => memoryLatch()), /wallet_result_unknown/);
  assert.equal(ran.raw.unsettled()[0].kind, 'batch');
  assert.ok(await reviewOf(ran.client, 'create', another()), 'its PositionLiquidityChanged settles it');
  // Its deadline passed: a late inclusion could only revert (PlanExpired).
  const late = setup({ atomic: null });
  const r3 = await reviewOf(late.client, 'create', fx.createWithSwap());
  await late.client.send(await late.client.prepareStep(r3, 0, GAS), true);
  const action = await late.client.prepareStep(r3, 1, GAS);
  loseNext(late.chain, 'eth_sendTransaction');
  await assert.rejects(late.client.send(action, true), /wallet_result_unknown/);
  await assert.rejects(reviewOf(late.client, 'create', another()), /zap_action_unsettled/);
  late.chain.warp(400);
  assert.ok(await reviewOf(late.client, 'create', another()), 'past its deadline');
  assert.deepEqual(late.raw.unsettled(), []);
});

test('F3: a batch the wallet still reports pending holds every new review, and "I rejected it" is not heard until the wallet lets it go', async () => {
  const { chain, raw, client } = setup({ atomic: 'supported', simulateV1: true });
  const review = await reviewOf(client, 'create', fx.createWithSwap());
  const batch = await client.prepareBatch(review, GAS);
  // The wallet takes the batch and queues it (it does not run on the fake chain): status 100 while it holds it.
  let status = 100;
  const answers = chain.request;
  chain.request = async (method, params) => {
    if (method === 'wallet_sendCalls') { chain.log.push(method); return { result: { id: 'queued-1' } }; }
    if (method === 'wallet_getCallsStatus' && params[0] === 'queued-1') return { result: { version: '2.0.0', id: 'queued-1', status, atomic: true } };
    return answers(method, params);
  };
  const id = await client.sendBatch(batch, true, () => memoryLatch());
  assert.equal(id, 'queued-1');
  assert.equal(raw.unsettled()[0].batchId, 'queued-1');
  // The finding's case: the batch still queued in the wallet, and a re-review of the same action.
  await assert.rejects(reviewOf(client, 'create', another()), /zap_action_unsettled/);
  assert.equal(await raw.forgetUnsettled(), 'pending', 'the wallet still holds it');
  // The wallet says it will never run (400): settled.
  status = 400;
  assert.equal(await raw.forgetUnsettled(), 'settled');
  assert.ok(await reviewOf(client, 'create', another()));
});

test('F3: "I rejected it" is heard only while nothing is pending on chain for this owner', async () => {
  const { chain, raw, client } = setup({ atomic: null });
  const review = await reviewOf(client, 'create', fx.createWithSwap());
  await client.send(await client.prepareStep(review, 0, GAS), true);
  const action = await client.prepareStep(review, 1, GAS);
  loseNext(chain, 'eth_sendTransaction');
  await assert.rejects(client.send(action, true), /wallet_result_unknown/);
  const answers = chain.request;
  chain.request = async (method, params) => {
    if (method === 'eth_getTransactionCount' && params[1] === 'pending') return { result: '0x2' };
    return answers(method, params);
  };
  assert.equal(await raw.forgetUnsettled(), 'pending');
  assert.equal(raw.unsettled().length, 1);
  chain.request = answers;
  assert.equal(await raw.forgetUnsettled(), 'forgotten');
});

test('F3: the record is the page\'s: another client of the same page (or the page after a reload) is held by it too', async () => {
  const memory = new Map();
  const storage = { getItem: (key) => (memory.has(key) ? memory.get(key) : null), setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) };
  const store = createUnsettledActions(storage);
  const first = setup({ atomic: null }, { unsettled: store });
  const review = await reviewOf(first.client, 'create', fx.createWithSwap());
  await first.client.send(await first.client.prepareStep(review, 0, GAS), true);
  const action = await first.client.prepareStep(review, 1, GAS);
  loseNext(first.chain, 'eth_sendTransaction');
  await assert.rejects(first.client.send(action, true), /wallet_result_unknown/);
  // The page reloads: a new store over the same storage, a new client on the same chain and wallet.
  const reloaded = createUnsettledActions(storage);
  assert.equal(reloaded.list(4663, fx.OWNER).length, 1);
  forgetV2DeploymentChecks();
  const client = fx.honest(createZapClient(walletOf(first.chain), chains.v2Chain(4663), first.chain.contracts, () => fx.NOW, undefined, reloaded), first.chain);
  await assert.rejects(reviewOf(client, 'create', another()), /zap_action_unsettled/);
  // Another chain, or another owner, is not held by it.
  assert.deepEqual(reloaded.list(8453, fx.OWNER), []);
  assert.deepEqual(reloaded.list(4663, fx.OTHER), []);
  // Public data only, under a hashed name; anything else read back is left out.
  const [key] = [...memory.keys()];
  assert.equal(key, zapUnsettledKey(4663, fx.OWNER));
  assert.ok(key.startsWith(ZAP_UNSETTLED_PREFIX) && !key.includes(fx.OWNER.slice(2)));
  const stored = JSON.parse(memory.get(key));
  assert.deepEqual(Object.keys(stored[0]).sort(), ['at', 'batchId', 'chainId', 'deadline', 'fromBlock', 'hash', 'intentHash', 'kind', 'nonce', 'zap']);
  memory.set(key, JSON.stringify([{ ...stored[0], amount: '1' }, { ...stored[0], kind: 'other' }, stored[0]]));
  assert.equal(createUnsettledActions(storage).list(4663, fx.OWNER).length, 1, 'closed check on read-back');
  assert.equal(isUnsettledAction({ ...stored[0], intentHash: '0x12' }), false);
  assert.throws(() => store.put(fx.OWNER, { ...stored[0], nonce: 'x' }), /invalid_unsettled_action/);
});

test('F3: every tab sees what another tab holds (storage is read first); a storage that refuses a write still holds it for this page', () => {
  const memory = new Map();
  const storage = { getItem: (key) => (memory.has(key) ? memory.get(key) : null), setItem: (key, value) => memory.set(key, value), removeItem: (key) => memory.delete(key) };
  const record = (intentHash, nonce) => ({ chainId: 4663, zap: fx.FAKE.zapV4, intentHash, fromBlock: '4096', deadline: String(fx.NOW + 300), kind: 'step', hash: null, batchId: null, nonce, at: fx.NOW });
  const tab1 = createUnsettledActions(storage);
  const tab2 = createUnsettledActions(storage);
  // Tab 1 holds and lets go of one (its memory has written), then tab 2 holds another: tab 1 sees it.
  tab1.put(fx.OWNER, record(`0x${'1'.repeat(64)}`, '3'));
  tab1.drop(4663, fx.OWNER, `0x${'1'.repeat(64)}`);
  tab2.put(fx.OWNER, record(`0x${'2'.repeat(64)}`, '4'));
  assert.deepEqual(tab1.list(4663, fx.OWNER).map((entry) => entry.nonce), ['4']);
  // Storage that refuses writes: this page's hold stays in its memory, and what storage holds is still seen.
  let refusing = false;
  const flaky = { getItem: storage.getItem, setItem: (key, value) => { if (refusing) throw new Error('QuotaExceededError'); storage.setItem(key, value); }, removeItem: storage.removeItem };
  const tab3 = createUnsettledActions(flaky);
  refusing = true;
  tab3.put(fx.OWNER, record(`0x${'3'.repeat(64)}`, '5'));
  assert.deepEqual(tab3.list(4663, fx.OWNER).map((entry) => entry.nonce).sort(), ['4', '5']);
  // No storage at all: memory only.
  const bare = createUnsettledActions(null);
  bare.put(fx.OWNER, record(`0x${'4'.repeat(64)}`, '6'));
  assert.deepEqual(bare.list(4663, fx.OWNER).map((entry) => entry.nonce), ['6']);
});

// ---------------------------------------------------------------------------------------------------------------------
// L2: only an ARMED root pauses automation
// ---------------------------------------------------------------------------------------------------------------------

test('L2: a root its vault reads disarmed pauses nothing (change range allowed), yet its vault is named for the reserves; an armed one still pauses', async () => {
  // v4: a root disarmed earlier keeps the vault as its subscriber.
  const disarmed = setup({ positions: [{ ...V4_POSITION, subscriber: VAULT }], vaults: [VAULT], disarmed: [VAULT] });
  const change = await reviewOf(disarmed.client, 'changeRange', fx.changeRangePlan());
  assert.deepEqual([change.pausesAutomation, change.vaultRoot], [null, VAULT]);
  const exit = await reviewOf(disarmed.client, 'exit', fx.exitConverted(), { quote: { expectedRemoved: PRINCIPAL } });
  assert.deepEqual([exit.pausesAutomation, exit.vaultRoot], [null, VAULT]);
  assert.ok(await disarmed.client.prepareStep(exit, 0, GAS), 'nothing to acknowledge');
  assert.ok(disarmed.chain.asked.some(({ method, params }) => method === 'eth_call' && params[0].to === VAULT), 'the vault itself was asked');
  // The same subscription, armed: a change of range is refused, an exit waits for the warning.
  const armed = setup({ positions: [{ ...V4_POSITION, subscriber: VAULT }], vaults: [VAULT] });
  await assert.rejects(reviewOf(armed.client, 'changeRange', fx.changeRangePlan()), (error) => error.failures.includes('position_vault_root'));
  const armedExit = await reviewOf(armed.client, 'exit', fx.exitConverted(), { quote: { expectedRemoved: PRINCIPAL } });
  assert.deepEqual([armedExit.pausesAutomation, armedExit.vaultRoot], [VAULT, VAULT]);
  await assert.rejects(armed.client.prepareStep(armedExit, 0, GAS), /automation_pause_unacknowledged/);
  // Disarmed since (the vault says so now): the next review pauses nothing.
  armed.chain.disarm(VAULT);
  assert.equal((await reviewOf(armed.client, 'changeRange', fx.changeRangePlan())).pausesAutomation, null);
  // A vault whose root is ANOTHER position: this position is no root of it.
  const OTHER_ID = 4_242n;
  const elsewhere = setup({ positions: [{ ...V4_POSITION, tokenId: OTHER_ID, approved: VAULT }, { ...V4_POSITION, subscriber: VAULT }], vaults: [VAULT] });
  const notRoot = await reviewOf(elsewhere.client, 'changeRange', fx.changeRangePlan());
  assert.deepEqual([notRoot.pausesAutomation, notRoot.vaultRoot], [null, null]);
  // The probe the direct exits use (finance/v2/direct.ts) is the client's own.
  assert.equal(typeof armed.raw.rootProbe, 'function');
});
