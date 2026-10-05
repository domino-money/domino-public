/**
 * TEST-ONLY S1 plans and a TEST-ONLY V2 contracts set for the V2 unit tests. The Domino addresses below are invented
 * (0x…d0d0-style), mark `fixture: true`, and exist nowhere: no deployable build reads this file.
 */
import { createRequire } from 'node:module';
import { concatHex, encodeAbiParameters, numberToHex } from 'viem';
import * as runtime from '../../../../api-contracts/position-plan-v1/runtime.mjs';

const require = createRequire(import.meta.url);
const typed = require('../../../.test-build/app/src/finance/v2/typedData.js');
const chains = require('../../../.test-build/app/src/v2/chains.js');

export const ROBINHOOD = chains.v2Chain(4663);
export const BASE = chains.v2Chain(8453);
export const ARBITRUM = chains.v2Chain(42161);
export const ZERO = '0x0000000000000000000000000000000000000000';
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
export const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
// Stand-ins for a stock token and a memecoin: not charge currencies.
export const TSLA = '0x00000000000000000000000000000000000075a1';
export const MANY = '0xf0000000000000000000000000000000000a4a10';
export const OWNER = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
export const OTHER = '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc';

/** Invented, the same on every chain as CREATE3 would make them; `fixture: true`. */
export const FAKE = {
  registry: '0x00000000000000000000000000000000d0d00001',
  autoExit: '0x00000000000000000000000000000000d0d00002',
  zapV3: '0x00000000000000000000000000000000d0d00003',
  zapV4: '0x00000000000000000000000000000000d0d00004',
  vaultFactoryV3: '0x00000000000000000000000000000000d0d00005',
  vaultFactoryV4: '0x00000000000000000000000000000000d0d00006',
};
export const contractsFor = (chainId) => ({
  chainId,
  addresses: { ...FAKE },
  codeHashes: Object.fromEntries(Object.keys(FAKE).map((name, i) => [name, `0x${(i + 1).toString(16).padStart(64, 'a')}`])),
  fixture: true,
});

export const ETH_USDG_V4 = { dex: 4, currency0: ZERO, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: ZERO };
export const USDG_MANY_V3 = { dex: 3, currency0: USDG, currency1: MANY, fee: 3000, tickSpacing: 60, hooks: ZERO };

/** A v4 path leg's data: abi.encode(PoolRef[]). */
export const v4Path = (...pools) => encodeAbiParameters([{ type: 'tuple[]', components: [
  { name: 'dex', type: 'uint8' }, { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] }], [pools]);
/** A v3 path: token, fee (3 bytes), token, … */
export const v3Path = (...parts) => concatHex(parts.map((part) => (typeof part === 'number' ? numberToHex(part, { size: 3 }) : part)));

export const NOW = 1_790_870_000;

export function intent(fields) {
  const base = {
    action: 1, pool: ETH_USDG_V4, tokenId: 0n, tickLower: -201060, tickUpper: -198060, minLiquidity: 1_000_000n,
    feeBps: 0, feeToken: ZERO, routesHash: typed.NO_LEGS_ROUTES_HASH, recipient: OWNER, nonce: 0n, deadline: BigInt(NOW + 300),
  };
  return { ...base, ...fields };
}
/** Fills routesHash and fee terms from the legs, as an honest planner does. */
export function sealed(plan, feeToken) {
  const legs = plan.legs;
  return { ...plan, intent: { ...plan.intent, routesHash: typed.routesHash(legs), feeBps: legs.length ? 65 : 0, feeToken: legs.length ? feeToken : ZERO } };
}

/** Robinhood: create ETH/USDG v4 with 1,000 USDG; the leg USDG → ETH spends 500 USDG through a v4 path (spec §2.8 ex. 1). */
export function createWithSwap(overrides = {}) {
  const legs = [{ kind: 3, router: ZERO, tokenIn: USDG, tokenOut: ZERO, amountIn: 500_000_000n, minAmountOut: 190_000_000_000_000_000n, data: v4Path(ETH_USDG_V4) }];
  return sealed({ intent: intent({}), inputs: [{ token: USDG, amount: 1_000_000_000n }], legs, amount0Max: 2n ** 127n, amount1Max: 2n ** 127n, initSqrtPriceX96: 0n, ...overrides }, USDG);
}
export const quotedFor = (legs) => legs.map((leg) => ({ expectedOut: leg.minAmountOut + leg.minAmountOut / 100n, minAmountOut: leg.minAmountOut, pools: [{ dex: 4, fee: 3000, hooks: ZERO }] }));

export const POSITION = { tokenId: 3409682n, owner: OWNER, pool: ETH_USDG_V4, tickLower: -201060, tickUpper: -198060, liquidity: 123456789012345678n };

export function increasePlan(overrides = {}) {
  return sealed({ intent: intent({ action: 2, tokenId: POSITION.tokenId }), inputs: [{ token: USDG, amount: 100_000_000n }], legs: [], amount0Max: 2n ** 127n, amount1Max: 2n ** 127n, ...overrides }, USDG);
}
export function changeRangePlan(overrides = {}) {
  return sealed({ intent: intent({ action: 3, tokenId: POSITION.tokenId, tickLower: -202020, tickUpper: -197040 }), liquidityToRemove: POSITION.liquidity, amount0MinRemoved: 1n, amount1MinRemoved: 1n, legs: [], amount0Max: 2n ** 127n, amount1Max: 2n ** 127n, burnOld: true, ...overrides }, USDG);
}
/** Exit converting to USDG: one leg ETH → USDG; the fee is USDG at the output. */
export function exitConverted(overrides = {}) {
  const legs = [{ kind: 3, router: ZERO, tokenIn: ZERO, tokenOut: USDG, amountIn: 400_000_000_000_000_000n, minAmountOut: 900_000_000n, data: v4Path(ETH_USDG_V4) }];
  return sealed({ intent: intent({ action: 4, tokenId: POSITION.tokenId, minLiquidity: POSITION.liquidity }), liquidityToRemove: POSITION.liquidity, amount0MinRemoved: 1n, amount1MinRemoved: 1n, legs, burn: true, ...overrides }, USDG);
}

// Added 2026-10-02 (Domino V2 rev2 review, F1 and F4): what the person asked for, and what the plan's minimums used.

export const WETH_USDG_V3 = { dex: 3, currency0: WETH, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: ZERO };
export const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const ETH_USDC_BASE_V4 = { dex: 4, currency0: ZERO, currency1: USDC_BASE, fee: 500, tickSpacing: 10, hooks: ZERO };
/** The fake chains' price for the pools these plans use (1.0 in raw units): what the plans' bases below say too. */
export const SQRT = 2n ** 96n;
/** The pools priced on a fake chain by default (tests/support/v2-chain.mjs `pools`). */
export const PRICED = [ETH_USDG_V4, USDG_MANY_V3, WETH_USDG_V3, ETH_USDC_BASE_V4].map((pool) => ({ pool, sqrtPriceX96: SQRT, tick: 0, liquidity: 10n ** 20n }));
/** A Universal Router leg's calldata: execute(bytes commands, bytes[] inputs, uint256 deadline), with no command. */
export const urExecute = (deadline) => concatHex(['0x3593564c', encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }, { type: 'uint256' }], ['0x', [], deadline])]);

const ACTIONS = { 1: 'create', 2: 'increase', 3: 'changeRange', 4: 'exit' };
/**
 * The request an honest plan answers (src/v2/plan/route.ts PlanTarget): its inputs; an exit converts into its last leg's
 * output, or (no legs) takes both tokens.
 */
export function targetOf({ action, plan }) {
  if (action === 'create' || action === 'increase') return { action, inputs: plan.inputs.map((input) => ({ token: input.token, amount: input.amount })) };
  if (action === 'changeRange') return { action };
  const finals = plan.legs.filter((leg, i) => !plan.legs.slice(i + 1).some((other) => other.tokenIn.toLowerCase() === leg.tokenOut.toLowerCase()));
  return { action, receive: finals.length ? { convertTo: finals[0].tokenOut } : 'both' };
}

/**
 * The basis an honest planner gives `plan` (finance/v2/plan.ts PlanBasis), its bands from the package's own
 * `bandSqrtPrice`: the pool at `poolSqrt` (none for a new pool), the mint at that price (a new pool's at its starting
 * price), the expected liquidity 2% above the minimum (the fake zap mints 1% above it), and for a change of range or an
 * exit the position the fake chain holds (`position`, POSITION by default).
 */
export function basisFor(plan, { poolSqrt = SQRT, slippageBps = 50, position, expectedLiquidity, sqrtAfter } = {}) {
  const action = ACTIONS[plan.intent.action];
  const creates = action === 'create' && (plan.initSqrtPriceX96 ?? 0n) !== 0n;
  const pool = creates ? null : poolSqrt;
  const after = action === 'exit' ? null : creates ? plan.initSqrtPriceX96 : (sqrtAfter ?? poolSqrt);
  const band = (sqrt) => ({ lower: runtime.bandSqrtPrice(sqrt, slippageBps, -2), upper: runtime.bandSqrtPrice(sqrt, slippageBps, 2) });
  const removes = action === 'changeRange' || action === 'exit';
  return {
    slippageBps,
    poolSqrtPriceX96: pool,
    sqrtPriceX96After: after,
    expectedLiquidity: expectedLiquidity ?? (action === 'exit' ? 0n : plan.intent.minLiquidity + plan.intent.minLiquidity / 50n),
    mintBand: after === null ? null : band(after),
    removalBand: removes ? band(pool) : null,
    position: removes ? (position ?? { tickLower: POSITION.tickLower, tickUpper: POSITION.tickUpper, liquidity: POSITION.liquidity }) : (position ?? null),
  };
}

/**
 * A review input as the app sends it for an honest request and planner: the request's target (`targetOf`) and the plan's
 * basis read from the fake chain `chain` (the pool's price there, the position it holds), unless the input names them.
 */
export function honestInput(input, chain) {
  const zapPlan = input?.plan;
  const plan = zapPlan?.plan;
  const out = { ...input };
  if (!('target' in out)) {
    try {
      out.target = targetOf(zapPlan);
    } catch {
      // A malformed plan names no target: the client refuses it for its shape first.
    }
  }
  if (out.quote && typeof out.quote === 'object' && !('basis' in out.quote) && plan?.intent?.pool) {
    try {
      const pool = plan.intent.pool;
      const nft = typeof plan.intent.tokenId === 'bigint' && plan.intent.tokenId > 0n ? chain.nft(pool.dex, plan.intent.tokenId) : undefined;
      out.quote = { ...out.quote, basis: basisFor(plan, { poolSqrt: chain.poolPrice(pool) ?? SQRT, position: nft ? { tickLower: nft.tickLower, tickUpper: nft.tickUpper, liquidity: nft.liquidity } : undefined }) };
    } catch {
      // A plan whose fields are not typed as the contract's has no basis: the client refuses it for its shape first.
    }
  }
  return out;
}
/** The zap client with every review made by `honestInput` (the client's other functions as they are). */
export const honest = (client, chain) => Object.freeze({ ...client, review: (input) => client.review(honestInput(input, chain)) });

/** A context that passes for `plan` on Robinhood, direct consent. */
export function context(overrides = {}) {
  return {
    chain: ROBINHOOD,
    contracts: contractsFor(4663),
    owner: OWNER,
    consent: 'direct',
    now: NOW,
    // Changed on purpose (data) 2026-10-02 (rev2 §2.4 decision #3): a quote made now, good for 3 minutes; the deadline 5 minutes after it.
    quoteRequestedAt: NOW,
    quoteExpiresAt: NOW + 180,
    rankOf: (token) => chains.profileRank(ROBINHOOD, token),
    routerVersion: (router) => (router.toLowerCase() === ROBINHOOD.uniswap.universalRouter.address ? 212 : null),
    hookedPoolsAllowed: false,
    position: POSITION,
    simulation: { ok: true, block: 77_000_000n, error: null },
    ...overrides,
  };
}
