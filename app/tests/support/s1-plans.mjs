/**
 * TEST-ONLY. `position-plan-v1` `1.0.0-rc.2` plan answers (spec F7 rev2 §2.4) built from a plan REQUEST's wire form, the
 * way the real planner answers it, with the package's own runtime (api-contracts/position-plan-v1/runtime.mjs): the
 * request echoed with the owner, the zap struct, the routes hash, the fee terms by F1b's rule from the ranks named, every
 * minimum at the worst price within ±s (`planMinimums`), the intent hash, the direct call data or the Permit2 typed data,
 * the readiness, the simulation and the L1 data fee. Every answer it builds passes the package's `validateResponse`
 * (tests/v2/s1-plan.test.mjs holds it to that), so the app's own checks are what a test exercises.
 *
 * Shared by the node tests (tests/v2/s1-*.test.mjs) and the browser suites (tests/v2-browser/s1*.test.mjs), whose page
 * asks a node responder through an exposed function. Nothing here reaches a network; the wallets are Anvil's public ones.
 */
import { createHash } from 'node:crypto';
import { encodeAbiParameters, keccak256 } from 'viem';
import * as runtime from '../../../api-contracts/position-plan-v1/runtime.mjs';
import { CONSTANTS } from '../../../api-contracts/position-plan-v1/schema-data.mjs';

export const ZERO = '0x0000000000000000000000000000000000000000';
export const VERSION = '1.0.0-rc.2';
export const MAX_UINT128 = String((1n << 128n) - 1n);

const POOLS = [{ type: 'tuple[]', components: [
  { name: 'dex', type: 'uint8' }, { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
  { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
] }];
const POOL_KEY = [{ type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }];

/** A v4 path leg's data: abi.encode(PoolRef[]). */
export const v4Path = (...pools) => encodeAbiParameters(POOLS, [pools]);
/** A v4 pool's id. */
export const poolIdOf = (pool) => keccak256(encodeAbiParameters(POOL_KEY, [{ currency0: pool.currency0, currency1: pool.currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks ?? ZERO }]));
const lower = (value) => String(value).toLowerCase();
const floorBy = (amount, bps) => (BigInt(amount) * BigInt(10_000 - bps)) / 10_000n;
const sqrtAt = runtime.sqrtAtTick;
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);
/** The canonical JSON the service hashes for `requestFingerprint` (keys sorted), SHA-256. */
const fingerprint = (value) => createHash('sha256').update(JSON.stringify(sortKeys(value))).digest('hex');

/** The request as the service echoes it: every field, null where the action takes none, the owner, the slippage. */
export function echoOf(wire, owner) {
  const keys = ['chainId', 'action', 'consent', 'pool', 'position', 'tickLower', 'tickUpper', 'inputs', 'liquidityToRemove', 'burn', 'receive', 'initialPrice', 'slippageBps'];
  const echo = Object.fromEntries(keys.map((key) => [key, wire[key] ?? null]));
  if (wire.receive) echo.receive = { mode: wire.receive.mode, token: wire.receive.token ?? null };
  echo.slippageBps = wire.slippageBps ?? 50;
  echo.owner = lower(owner);
  return echo;
}

/**
 * A plan answer for `wire` (a request's wire form), valid under the package's runtime. `o`:
 *   owner, zap        the session's wallet and the chain's zap for the pool's DEX
 *   now               unix seconds the plan is made at (requestedAt; expiresAt = now + 180, deadline = now + 300)
 *   legs              [{ kind: 'v4_pool'|'v3_pool'|'universal_router', tokenIn, tokenOut, amountIn, expectedOut, pools?, data? }]
 *   ranks             token → registry rank (the profile's charge currencies when absent)
 *   pool              the pool's state: { sqrtPriceX96, tick, liquidity } (a new pool: none, see `initialPrice`)
 *   positionPool      the PoolRef of the position (increase, change range, exit)
 *   position          { tokenId, tickLower, tickUpper, liquidity, feesOwed: [a, b], approved?, subscriber?, manager }
 *   initialPrice      a new pool's { sqrtPriceX96, tick, price0In1, price1In0, decimals0, decimals1 } (request's initialPrice)
 *   expected          { liquidity?, amounts?: [a, b], returned?: [{ token, amountRaw }], sqrtPriceX96After? }
 *   nonce             Permit2: { word, bit } (the nonce is word << 8 | bit)
 *   simulation, l1DataFee, warnings, gasUnits, l1GasUnits: overrides
 */
export function planAnswer(wire, o) {
  const chainId = wire.chainId;
  // Added 2026-11-07 (Elysium's screens): `o.chains`, the chain rows of the package a build bundles: day 9's for Elysium
  // (./elysium-day9.mjs PLAN_DAY9.CONSTANTS.chains), the package's own otherwise.
  const chain = (o.chains ?? CONSTANTS.chains)[String(chainId)];
  const owner = lower(o.owner);
  const zap = lower(o.zap);
  const now = o.now;
  const s = wire.slippageBps;
  const action = wire.action;
  const pool = action === 'create'
    ? { ...wire.pool }
    : { ...o.positionPool, currency0: lower(o.positionPool.currency0), currency1: lower(o.positionPool.currency1), hooks: lower(o.positionPool.hooks ?? ZERO) };
  const rankOf = (token) => (o.ranks && Object.hasOwn(o.ranks, lower(token)) ? o.ranks[lower(token)] : (chain.chargeCurrencies.find((c) => c.token === lower(token))?.rank ?? 0));
  const legPool = (p) => ({ dex: p.dex, currency0: p.currency0, currency1: p.currency1, fee: p.fee, tickSpacing: p.tickSpacing, hooks: p.hooks, id: p.dex === 4 ? poolIdOf(p) : '0x' + '3'.repeat(40) });
  // Legs, each minimum floor(expectedOut × (1 − s)).
  const legs = (o.legs ?? []).map((leg) => {
    const kind = { universal_router: 1, v3_pool: 2, v4_pool: 3 }[leg.kind ?? 'v4_pool'];
    const min = floorBy(leg.expectedOut, s);
    return {
      kind, router: kind === 1 ? chain.universalRouter : ZERO, tokenIn: lower(leg.tokenIn), tokenOut: lower(leg.tokenOut),
      amountIn: String(leg.amountIn), minAmountOut: String(min > 0n ? min : 1n), data: leg.data ?? v4Path(pool),
    };
  });
  const views = (o.legs ?? []).map((leg, i) => ({
    kind: leg.kind ?? 'v4_pool', tokenIn: legs[i].tokenIn, tokenOut: legs[i].tokenOut, amountInRaw: legs[i].amountIn,
    expectedOutRaw: String(leg.expectedOut), minAmountOutRaw: legs[i].minAmountOut, source: leg.source ?? 'local_simulation',
    pools: leg.pools ?? [legPool(pool)], priceImpactPercent: null,
  }));
  // Fee terms by F1b's rule, from the ranks named (every token the legs touch, in order).
  const seen = [];
  legs.forEach((l) => [l.tokenIn, l.tokenOut].forEach((t) => { if (!seen.includes(t)) seen.push(t); }));
  let fee = { bps: 0, token: ZERO, place: 'none', basisRaw: '0', amountRaw: '0', ranks: [] };
  if (legs.length) {
    const [token, place] = runtime.feeToken(legs, rankOf);
    const basis = runtime.swappedAmount(legs, views.map((v) => v.expectedOutRaw), token);
    fee = { bps: 65, token, place, basisRaw: String(basis), amountRaw: String((basis * 65n) / 10000n), ranks: seen.map((t) => ({ token: t, rank: rankOf(t) })) };
  }
  const deadline = String(now + CONSTANTS.deadlineSeconds);
  const nonce = wire.consent === 'permit2' ? ((BigInt(o.nonce?.word ?? 7) << 8n) | BigInt(o.nonce?.bit ?? 0)) : 0n;
  const position = o.position ?? null;
  const remove = wire.liquidityToRemove === undefined || wire.liquidityToRemove === null ? null : wire.liquidityToRemove === 'all' ? String(position.liquidity) : String(wire.liquidityToRemove);
  const initial = o.initialPrice ?? null;
  const ticks = action === 'create' || action === 'changeRange' ? [wire.tickLower, wire.tickUpper] : [position.tickLower, position.tickUpper];
  const intent = {
    action: { create: 1, increase: 2, changeRange: 3, exit: 4 }[action],
    pool: { dex: pool.dex, currency0: pool.currency0, currency1: pool.currency1, fee: pool.fee, tickSpacing: pool.tickSpacing, hooks: pool.hooks },
    tokenId: action === 'create' ? '0' : String(position.tokenId), tickLower: ticks[0], tickUpper: ticks[1], minLiquidity: '0',
    feeBps: fee.bps, feeToken: fee.token, routesHash: runtime.routesHash(legs), recipient: owner, nonce: String(nonce), deadline,
  };
  const inputs = (wire.inputs ?? []).map((x) => ({ token: lower(x.token), amount: x.amountRaw }));
  let zapPlan;
  if (action === 'create') zapPlan = { intent, inputs, legs, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128, initSqrtPriceX96: initial ? String(initial.sqrtPriceX96) : '0' };
  else if (action === 'increase') zapPlan = { intent, inputs, legs, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128 };
  else if (action === 'changeRange') zapPlan = { intent, liquidityToRemove: remove, amount0MinRemoved: '0', amount1MinRemoved: '0', legs, amount0Max: MAX_UINT128, amount1Max: MAX_UINT128, burnOld: wire.burn };
  else zapPlan = { intent, liquidityToRemove: remove, amount0MinRemoved: '0', amount1MinRemoved: '0', legs, burn: wire.burn };

  const state = o.pool ?? null;
  const removes = action === 'changeRange' || action === 'exit';
  const poolSqrt = initial ? null : BigInt(state.sqrtPriceX96);
  // What the removal pays at the pool's price (principal), and the fees owed.
  let principal = [null, null];
  if (removes) {
    const [a0, a1] = runtime.amountsForLiquidity(poolSqrt, sqrtAt(position.tickLower), sqrtAt(position.tickUpper), BigInt(remove), false);
    principal = [String(a0), String(a1)];
  }
  const expected = {
    liquidity: String(o.expected?.liquidity ?? (action === 'exit' ? 0n : 1n)),
    amount0Raw: String(o.expected?.amounts?.[0] ?? 0n),
    amount1Raw: String(o.expected?.amounts?.[1] ?? 0n),
    sqrtPriceX96After: String(initial ? initial.sqrtPriceX96 : (o.expected?.sqrtPriceX96After ?? poolSqrt)),
    principal0Raw: removes ? principal[0] : null,
    principal1Raw: removes ? principal[1] : null,
    fees0Raw: removes ? String(position.feesOwed[0]) : null,
    fees1Raw: removes ? String(position.feesOwed[1]) : null,
    returned: o.expected?.returned ?? [],
  };
  const poolView = initial
    ? { ...legPool(pool), initialized: false, sqrtPriceX96: null, tick: null, liquidity: null, swapFeePips: null }
    : { ...legPool(pool), initialized: true, sqrtPriceX96: String(state.sqrtPriceX96), tick: state.tick, liquidity: String(state.liquidity ?? 10n ** 20n), swapFeePips: { zeroForOne: pool.fee, oneForZero: pool.fee } };
  const positionView = position
    ? {
        tokenId: String(position.tokenId), manager: lower(position.manager), tickLower: position.tickLower, tickUpper: position.tickUpper,
        liquidity: String(position.liquidity), liquidityToRemove: removes ? remove : null, feesOwed0Raw: String(position.feesOwed[0]),
        feesOwed1Raw: String(position.feesOwed[1]), inRange: true, approved: lower(position.approved ?? ZERO),
        subscriber: pool.dex === 4 ? lower(position.subscriber ?? ZERO) : null,
      }
    : null;
  const block = { number: String(o.block ?? 77_000_000), hash: '0x' + 'b'.repeat(64), timestamp: String(now) };
  const nitro = chain.l1DataFeeSource === 'nitro_node_interface';
  const l1DataFee = o.l1DataFee ?? (nitro
    ? { status: 'ok', source: 'nitro_node_interface', block: block.number, weiRaw: String(BigInt(o.l1GasUnits ?? 0) * 20_000_000n), upperBoundWeiRaw: null, l1GasUnits: String(o.l1GasUnits ?? 0), l2BaseFeeWei: '20000000', transactionBytes: null }
    : { status: 'ok', source: 'op_gas_price_oracle', block: block.number, weiRaw: '10345963635', upperBoundWeiRaw: '43331441130', l1GasUnits: null, l2BaseFeeWei: null, transactionBytes: 1845 });
  if (o.l1DataFee) o.l1DataFee.block = block.number;
  const d = {
    schemaVersion: 1, source: 'position_plan_v1', chainId, action, consent: wire.consent, owner, zap, block,
    requestedAt: now, retrievedAt: now, expiresAt: now + CONSTANTS.quoteLifetimeSeconds, deadline,
    requestFingerprint: fingerprint(echoOf(wire, owner)), request: echoOf(wire, owner),
    pool: poolView,
    initialPrice: initial
      ? { sqrtPriceX96: String(initial.sqrtPriceX96), tick: initial.tick, price0In1: initial.price0In1, price1In0: initial.price1In0, decimals0: initial.decimals0, decimals1: initial.decimals1, decimalsVerified: true, baseToken: lower(wire.initialPrice.baseToken), price: wire.initialPrice.price }
      : null,
    position: positionView,
    zapPlan, routesHash: intent.routesHash, intentHash: '', call: null, signature: null, legs: views, fee, expected,
    minimums: { liquidity: '0', slippageBps: s, amount0RemovedRaw: null, amount1RemovedRaw: null, mintBand: null, removalBand: null },
    routing: { router: { status: 'not_configured', reason: null }, advantageBps: 10 },
    readiness: null, simulation: null, l1DataFee, warnings: o.warnings ?? [],
  };
  // The minimums at the worst price within ±s, with the zap's exact math (the package's own planMinimums).
  const m = runtime.planMinimums(d);
  intent.minLiquidity = String(m.liquidity);
  if (removes) {
    zapPlan.amount0MinRemoved = String(m.amount0Removed);
    zapPlan.amount1MinRemoved = String(m.amount1Removed);
  }
  if (action !== 'exit' && BigInt(expected.liquidity) < m.liquidity) expected.liquidity = String(m.liquidity + m.liquidity / 50n);
  d.minimums = {
    liquidity: String(m.liquidity), slippageBps: s, amount0RemovedRaw: removes ? String(m.amount0Removed) : null,
    amount1RemovedRaw: removes ? String(m.amount1Removed) : null, mintBand: m.mintBand, removalBand: m.removalBand,
  };
  d.intentHash = runtime.intentHash(chainId, zap, intent);
  const fn = CONSTANTS.functions[action][wire.consent];
  const direct = wire.consent === 'direct';
  d.call = { to: zap, function: fn.name, selector: fn.selector, valueRaw: direct ? String(runtime.directValue(zapPlan)) : '0', data: direct ? runtime.callData(action, zapPlan) : null };
  if (wire.consent === 'permit2') {
    const permit = { permitted: inputs, nonce: intent.nonce, deadline };
    d.signature = { kind: 'permit2', permit, typedData: runtime.permit2TypedData(chainId, zap, permit, intent), digest: runtime.permit2Digest(chainId, zap, permit, intent) };
  }
  const manager = position ? lower(position.manager) : null;
  d.readiness = {
    account: { kind: 'eoa', delegate: null, consents: ['create', 'increase'].includes(action) ? ['direct', 'permit2'] : ['direct'] },
    balances: [],
    approvals: [],
    positionApproval: position ? { manager, tokenId: String(position.tokenId), approved: lower(position.approved ?? ZERO), approvedForAll: false, sufficient: lower(position.approved ?? ZERO) === zap } : null,
    nonce: wire.consent === 'permit2' ? { kind: 'permit2', word: String(o.nonce?.word ?? 7), bit: o.nonce?.bit ?? 0, nonce: intent.nonce } : null,
    steps: [...(wire.consent === 'permit2' ? [{ kind: 'sign_permit2', to: null, valueRaw: '0', data: null }] : []), { kind: 'send_action', to: zap, valueRaw: d.call.valueRaw, data: null }],
  };
  d.simulation = o.simulation ?? {
    status: 'ok', reason: null, method: 'eth_simulateV1', error: null, gasUnits: String(o.gasUnits ?? 500_000),
    result: { tokenId: action === 'create' ? '5000001' : String(position.tokenId), liquidity: expected.liquidity, amount0: expected.amount0Raw, amount1: expected.amount1Raw, feeToken: fee.token, feeAmount: fee.amountRaw },
  };
  return { contractVersion: VERSION, plan: d };
}

/** An error answer of the plan API, as the service sends it. */
export const planError = (code) => ({ status: runtime.ERROR_STATUS_BY_CODE[code], body: { error: code } });
