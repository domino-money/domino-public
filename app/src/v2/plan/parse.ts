/**
 * A `position-plan-v1` answer, read (spec F7 rev2 §2.4): first the package's own validator (runtime.mjs
 * `validateResponse`, the closed schema plus `checkPlan`, which recomputes from the answer itself the fee terms, the
 * routes hash, the intent hash, the Permit2 typed data and digest, the direct call data and value, the minimums at the
 * worst price within ±s with the zap's exact math, the L1 data fee's source, the deadlines and the request it answers);
 * then what only the app can check:
 *
 *   1. every Domino address in it (`zap`, `call.to`, the typed data's `spender`, the approvals' spenders and the
 *      approve steps' calldata) is the chain's pinned manifest's, and every Uniswap or Permit2 address the chain
 *      profile's: the answer is checked against them, never used as a source;
 *   2. `fee.ranks` against the registry: handed on in the quote, the zap client compares them with what it reads;
 *   3. a new pool's `initSqrtPriceX96` is what the app computed from the typed price (check 13);
 *   and: the request it answers is exactly the one sent, for the connected wallet (the session's: owner and recipient);
 *   the plan arrives before its `expiresAt` (else `expired`, re-quoted without a word).
 *
 * The server's simulation (`simulation`): `ok` is taken; `not_run` ONLY with `approvals_missing` is taken too (an APP
 * CHOICE, decision of 2026-10-02: the app's own simulation of the exact call runs before the wallet is asked, after the
 * approvals are confirmed, or `eth_simulateV1` for a batch); `reverted`, the `simulated_liquidity_below_minimum`
 * warning, and every other `not_run` reason are refused (`reverted` carries the error's selector and name for
 * src/v2/errors.ts).
 *
 * An error answer is `refused` with its code once the package's `validateError` accepts it; anything else that is not a
 * contract body is `unavailable`. Nothing here draws a plan that failed any of it.
 *
 * Pure: no viem, no wallet. The runtime is handed in.
 */
import type { PlanDocument, PositionPlanErrorCode } from 'api-contracts/position-plan-v1/types'
import { v2Chain } from '../chains'
import { ZERO_ADDRESS, type ActionCode, type Address, type Dex, type Hex, type LegKind, type PositionIntent, type SwapLeg, type TokenAmount, type ZapPlan } from '../types'
import { planTargetOf, routeProblems } from './route'
import { S1_PLAN_CONTRACT_VERSION, type S1L1DataFee, type S1PlanContext, type S1PlanFacts, type S1PlanRequest, type S1PlanResult, type S1PlanValidators, type S1Quote, type S1SqrtBand } from './types'

/** The one `not_run` reason the app takes (see above). */
export const S1_ACCEPTED_NOT_RUN = 'approvals_missing'
/** InsufficientLiquidity(uint128,uint128): what a plan whose simulated liquidity is below its minimum would revert with. */
const INSUFFICIENT_LIQUIDITY = '0xe49b763d'
const APPROVE = '0x095ea7b3'

class Invalid extends Error {}
const bad = (detail: string): never => {
  throw new Invalid(detail)
}
const lower = (value: string): Address => value.toLowerCase() as Address
const same = (a: string | null | undefined, b: string | null | undefined) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase()
const canonical = (value: unknown): string =>
  Array.isArray(value)
    ? `[${value.map(canonical).join(',')}]`
    : value !== null && typeof value === 'object'
      ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
      : typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value) ? JSON.stringify(value.toLowerCase()) : JSON.stringify(value)

/** The request as the service echoes it: every field, null where the action takes none, and the owner. */
function echoOf(wire: Record<string, unknown>, owner: Address): Record<string, unknown> {
  const keys = ['chainId', 'action', 'consent', 'pool', 'position', 'tickLower', 'tickUpper', 'inputs', 'liquidityToRemove', 'burn', 'receive', 'initialPrice', 'slippageBps']
  const echo: Record<string, unknown> = Object.fromEntries(keys.map((key) => [key, wire[key] ?? null]))
  const receive = wire.receive as { mode: string; token?: string } | undefined
  if (receive) echo.receive = { mode: receive.mode, token: receive.token ?? null }
  echo.owner = owner
  return echo
}

const pair = (a: string | null, b: string | null): readonly [bigint, bigint] | null => (a === null || b === null ? null : [BigInt(a), BigInt(b)])

function intentOf(i: PlanDocument['zapPlan']['intent']): PositionIntent {
  return {
    action: i.action as ActionCode,
    pool: { dex: i.pool.dex, currency0: lower(i.pool.currency0), currency1: lower(i.pool.currency1), fee: i.pool.fee, tickSpacing: i.pool.tickSpacing, hooks: lower(i.pool.hooks) },
    tokenId: BigInt(i.tokenId),
    tickLower: i.tickLower,
    tickUpper: i.tickUpper,
    minLiquidity: BigInt(i.minLiquidity),
    feeBps: i.feeBps,
    feeToken: lower(i.feeToken),
    routesHash: i.routesHash.toLowerCase() as Hex,
    recipient: lower(i.recipient),
    nonce: BigInt(i.nonce),
    deadline: BigInt(i.deadline),
  }
}

const legsOf = (legs: readonly { kind: number; router: string; tokenIn: string; tokenOut: string; amountIn: string; minAmountOut: string; data: string }[]): SwapLeg[] =>
  legs.map((leg) => ({ kind: leg.kind as LegKind, router: lower(leg.router), tokenIn: lower(leg.tokenIn), tokenOut: lower(leg.tokenOut), amountIn: BigInt(leg.amountIn), minAmountOut: BigInt(leg.minAmountOut), data: leg.data.toLowerCase() as Hex }))
const inputsOf = (inputs: readonly { token: string; amount: string }[]): TokenAmount[] => inputs.map((input) => ({ token: lower(input.token), amount: BigInt(input.amount) }))

/** The zap struct of the answer, in the money client's shape. */
export function zapPlanOf(d: PlanDocument): ZapPlan {
  const p = d.zapPlan as unknown as Record<string, unknown> & { intent: PlanDocument['zapPlan']['intent'] }
  const intent = intentOf(p.intent)
  const legs = legsOf(p.legs as Parameters<typeof legsOf>[0])
  const big = (key: string) => BigInt(p[key] as string)
  switch (d.action) {
    case 'create':
      return { action: 'create', plan: { intent, inputs: inputsOf(p.inputs as Parameters<typeof inputsOf>[0]), legs, amount0Max: big('amount0Max'), amount1Max: big('amount1Max'), initSqrtPriceX96: big('initSqrtPriceX96') } }
    case 'increase':
      return { action: 'increase', plan: { intent, inputs: inputsOf(p.inputs as Parameters<typeof inputsOf>[0]), legs, amount0Max: big('amount0Max'), amount1Max: big('amount1Max') } }
    case 'changeRange':
      return { action: 'changeRange', plan: { intent, liquidityToRemove: big('liquidityToRemove'), amount0MinRemoved: big('amount0MinRemoved'), amount1MinRemoved: big('amount1MinRemoved'), legs, amount0Max: big('amount0Max'), amount1Max: big('amount1Max'), burnOld: p.burnOld as boolean } }
    case 'exit':
      return { action: 'exit', plan: { intent, liquidityToRemove: big('liquidityToRemove'), amount0MinRemoved: big('amount0MinRemoved'), amount1MinRemoved: big('amount1MinRemoved'), legs, burn: p.burn as boolean } }
  }
}

function l1Of(l1: PlanDocument['l1DataFee']): S1L1DataFee {
  if (l1.status !== 'ok' || l1.weiRaw === null) return { status: 'unavailable', source: l1.source }
  if (l1.source === 'op_gas_price_oracle') return { status: 'ok', source: l1.source, wei: BigInt(l1.weiRaw), upperBoundWei: l1.upperBoundWeiRaw === null ? null : BigInt(l1.upperBoundWeiRaw) }
  if (l1.l1GasUnits === null || l1.l2BaseFeeWei === null) return { status: 'unavailable', source: l1.source }
  return { status: 'ok', source: l1.source, wei: BigInt(l1.weiRaw), l1GasUnits: BigInt(l1.l1GasUnits), l2BaseFeeWei: BigInt(l1.l2BaseFeeWei) }
}

/** The spender an `approve(address,uint256)` call data names, or null when the data is not one. */
function approveSpender(data: string | null): Address | null {
  if (!data || !data.toLowerCase().startsWith(APPROVE) || data.length !== 2 + 8 + 128) return null
  const word = data.slice(10, 74)
  return /^0{24}[0-9a-fA-F]{40}$/.test(word) ? (`0x${word.slice(24).toLowerCase()}` as Address) : null
}

/**
 * Added 2026-11-09 (core flows, errors): every token a checked plan moves, once each, lowercase: the pool's two in its
 * order, then any other it is paid with, then any a swap leg reaches.
 */
function movedTokens(d: PlanDocument): readonly Address[] {
  const pool = d.zapPlan.intent.pool
  const inputs = (d.zapPlan as { inputs?: readonly { token: string }[] }).inputs ?? []
  const all = [pool.currency0, pool.currency1, ...inputs.map((input) => input.token), ...d.zapPlan.legs.flatMap((leg) => [leg.tokenIn, leg.tokenOut])]
  return Object.freeze([...new Set(all.filter((token) => /^0x[0-9a-fA-F]{40}$/.test(token)).map(lower))])
}

/** App checks 1 and 3 and the request it answers (see the module's comment); throws Invalid with the first that fails. */
function appChecks(d: PlanDocument, request: S1PlanRequest, wire: Record<string, unknown>, ctx: S1PlanContext): void {
  // The request it answers: exactly the one sent, for this wallet, on this chain.
  if (!same(d.owner, ctx.owner)) bad('owner')
  if (canonical(d.request) !== canonical(echoOf(wire, ctx.owner))) bad('request')
  if (d.chainId !== request.chainId || d.action !== request.action || d.consent !== request.consent) bad('request')
  const dex = d.pool.dex as Dex
  if (request.position && request.position.dex !== dex) bad('position_dex')
  if (request.pool && request.pool.dex !== dex) bad('pool_dex')
  // 1. Domino addresses: the manifest's; Uniswap's and Permit2's: the profile's.
  const zap = ctx.zaps[dex]
  if (!zap || !same(d.zap, zap) || !same(d.call.to, zap)) bad('zap')
  if (!same(d.zapPlan.intent.recipient, ctx.owner)) bad('recipient')
  const sig = d.signature
  if (d.consent === 'direct' && sig !== null) bad('signature')
  if (d.consent === 'permit2') {
    if (!sig || sig.kind !== 'permit2') return bad('signature')
    if (!same(sig.typedData.domain.verifyingContract, ctx.permit2) || !same(sig.typedData.message.spender, zap)) bad('typed_data_address')
  }
  const tokenSpender = d.consent === 'direct' ? zap : ctx.permit2
  for (const approval of d.readiness.approvals) {
    if (!same(approval.spender, approval.spenderKind === 'zap' ? zap : ctx.permit2) || !same(approval.spender, tokenSpender)) bad('approval_spender')
  }
  const inputTokens = new Set(((d.zapPlan as { inputs?: { token: string }[] }).inputs ?? []).map((input) => input.token.toLowerCase()).filter((token) => token !== ZERO_ADDRESS))
  for (const step of d.readiness.steps) {
    if (step.kind === 'approve_token') {
      if (!step.to || !inputTokens.has(step.to.toLowerCase()) || !same(approveSpender(step.data), tokenSpender)) bad('approve_step')
    } else if (step.kind === 'approve_position') {
      if (!same(step.to, ctx.managers[dex]) || !same(approveSpender(step.data), zap)) bad('approve_position_step')
    } else if (step.kind === 'send_action') {
      if (!same(step.to, zap)) bad('zap')
    } else if (step.kind !== 'sign_permit2' || d.consent !== 'permit2') bad('steps')
  }
  const approval = d.readiness.positionApproval
  if (approval && !same(approval.manager, ctx.managers[dex])) bad('position_manager')
  if (d.position && !same(d.position.manager, ctx.managers[dex])) bad('position_manager')
  // 3. A new pool's starting price: the app's own exact value (check 13), and only when the app asked for one.
  const asked = request.initialPrice
  if (asked) {
    if (!d.initialPrice || d.initialPrice.sqrtPriceX96 !== asked.sqrtPriceX96.toString(10)) bad('initial_price')
    if ((d.zapPlan as { initSqrtPriceX96?: string }).initSqrtPriceX96 !== asked.sqrtPriceX96.toString(10)) bad('initial_price')
  } else if (d.initialPrice !== null || (d.action === 'create' && (d.zapPlan as { initSqrtPriceX96?: string }).initSqrtPriceX96 !== '0')) bad('initial_price')
  // The swaps lead to what was asked (Domino V2 rev2 review, F1; ./route.ts): the package's request match does not read
  // `receive`, nor where a leg's output goes. An exit converts into the token asked for only, an exit to both tokens swaps
  // nothing, and what a create, an increase or a change of range swaps ends in the pool's own currencies.
  const target = planTargetOf(request)
  if (!target) return bad('route')
  if (routeProblems(d.zapPlan.legs, target, d.pool, v2Chain(d.chainId).wrappedNative.address).length > 0) bad('route')
}

/**
 * The answer for `request` (written as `wire`), read as the module's comment says; `ctx.now` is unix seconds.
 * `{ kind: 'ok' }` carries the plan in the zap client's shape, the quote in its `ZapQuote` shape, and the figures for
 * the review.
 */
export function parsePlanAnswer(answer: { status: number; body: unknown }, request: S1PlanRequest, wire: Record<string, unknown>, ctx: S1PlanContext, runtime: S1PlanValidators): S1PlanResult {
  if (runtime.CONTRACT_VERSION !== S1_PLAN_CONTRACT_VERSION) return { kind: 'invalid', detail: 'contract_version' }
  if (answer.status !== 200) {
    if (runtime.validateError(answer.status, answer.body)) return { kind: 'refused', code: (answer.body as { error: PositionPlanErrorCode }).error, status: answer.status }
    return { kind: 'unavailable', reason: Number.isSafeInteger(answer.status) && answer.status >= 100 && answer.status <= 599 ? `http_${answer.status}` : 'http' }
  }
  if (!runtime.validateResponse('plan', answer.body)) return { kind: 'invalid', detail: 'contract' }
  const d = (answer.body as { plan: PlanDocument }).plan
  try {
    appChecks(d, request, wire, ctx)
  } catch (error) {
    if (error instanceof Invalid) return { kind: 'invalid', detail: error.message }
    throw error
  }
  // The quote's life: never consent at or after expiresAt (decision #3).
  if (Math.floor(ctx.now) >= d.expiresAt) return { kind: 'expired' }
  // The server's simulation (the module's comment). Changed on purpose 2026-11-09 (core flows, errors): a revert carries
  // the tokens the plan moves (`movedTokens`), checked above, for the screen to name them when the error's own token is
  // not reported (a selector alone).
  const sim = d.simulation
  if (sim.status === 'reverted') return { kind: 'reverted', selector: (sim.error?.selector?.toLowerCase() as Hex | undefined) ?? null, name: sim.error?.name ?? null, tokens: movedTokens(d) }
  if (sim.status === 'not_run' && sim.reason !== S1_ACCEPTED_NOT_RUN) return { kind: 'unsimulated', reason: sim.reason ?? 'unknown' }
  if (d.warnings.includes('simulated_liquidity_below_minimum') || d.warnings.includes('simulation_reverted')) return { kind: 'reverted', selector: INSUFFICIENT_LIQUIDITY, name: 'InsufficientLiquidity(uint128,uint128)', tokens: movedTokens(d) }

  const plan = zapPlanOf(d)
  const removes = d.action === 'changeRange' || d.action === 'exit'
  const principal = pair(d.expected.principal0Raw, d.expected.principal1Raw)
  const fees = pair(d.expected.fees0Raw, d.expected.fees1Raw)
  const expectedRemoved = removes && principal && fees ? ([principal[0] + fees[0], principal[1] + fees[1]] as const) : undefined
  const band = (value: { lowerSqrtPriceX96: string; upperSqrtPriceX96: string } | null): S1SqrtBand | null => (value ? { lower: BigInt(value.lowerSqrtPriceX96), upper: BigInt(value.upperSqrtPriceX96) } : null)
  const quote: S1Quote = {
    requestedAt: d.requestedAt,
    expiresAt: d.expiresAt,
    legs: d.legs.map((leg) => ({
      expectedOut: BigInt(leg.expectedOutRaw),
      minAmountOut: BigInt(leg.minAmountOutRaw),
      pools: leg.pools.map((p) => ({ dex: p.dex, fee: p.fee, hooks: lower(p.hooks ?? ZERO_ADDRESS) })),
    })),
    simulation: { ok: true, block: BigInt(d.block.number), error: null },
    ...(expectedRemoved ? { expectedRemoved } : {}),
    ranks: d.fee.ranks.map((rank) => ({ token: lower(rank.token), rank: rank.rank })),
    // What the minimums were computed from (Domino V2 rev2 review, F4): the zap client ties it to its own reads.
    basis: {
      slippageBps: d.minimums.slippageBps,
      poolSqrtPriceX96: d.pool.sqrtPriceX96 === null ? null : BigInt(d.pool.sqrtPriceX96),
      sqrtPriceX96After: d.expected.sqrtPriceX96After === null ? null : BigInt(d.expected.sqrtPriceX96After),
      expectedLiquidity: BigInt(d.expected.liquidity),
      mintBand: band(d.minimums.mintBand),
      removalBand: band(d.minimums.removalBand),
      position: d.position ? { tickLower: d.position.tickLower, tickUpper: d.position.tickUpper, liquidity: BigInt(d.position.liquidity) } : null,
    },
  }
  const removed = pair(d.minimums.amount0RemovedRaw, d.minimums.amount1RemovedRaw)
  const facts: S1PlanFacts = {
    contractVersion: S1_PLAN_CONTRACT_VERSION,
    block: { number: BigInt(d.block.number), timestamp: Number(d.block.timestamp) },
    requestedAt: d.requestedAt,
    retrievedAt: d.retrievedAt,
    expiresAt: d.expiresAt,
    deadline: BigInt(d.deadline),
    expected: {
      liquidity: BigInt(d.expected.liquidity),
      amounts: [BigInt(d.expected.amount0Raw), BigInt(d.expected.amount1Raw)],
      sqrtPriceX96After: d.expected.sqrtPriceX96After === null ? null : BigInt(d.expected.sqrtPriceX96After),
      principal,
      fees,
      returned: d.expected.returned.map((item) => ({ token: lower(item.token), amount: BigInt((item as unknown as { amountRaw: string }).amountRaw) })),
    },
    minimums: { liquidity: BigInt(d.minimums.liquidity), slippageBps: d.minimums.slippageBps, removed },
    fee: d.fee.bps === 0 ? null : { token: lower(d.fee.token), place: d.fee.place as 'input' | 'output' | 'hop' | 'fallback', basis: BigInt(d.fee.basisRaw), amount: BigInt(d.fee.amountRaw) },
    gasUnits: sim.gasUnits === null ? null : BigInt(sim.gasUnits),
    l1DataFee: l1Of(d.l1DataFee),
    pool: { id: d.pool.id.toLowerCase() as Hex, initialized: d.pool.initialized, sqrtPriceX96: d.pool.sqrtPriceX96 === null ? null : BigInt(d.pool.sqrtPriceX96), tick: d.pool.tick },
    initialPrice: d.initialPrice ? { sqrtPriceX96: BigInt(d.initialPrice.sqrtPriceX96), tick: d.initialPrice.tick, price0In1: d.initialPrice.price0In1, price1In0: d.initialPrice.price1In0 } : null,
    position: d.position
      ? { tokenId: BigInt(d.position.tokenId), tickLower: d.position.tickLower, tickUpper: d.position.tickUpper, liquidity: BigInt(d.position.liquidity), feesOwed: [BigInt(d.position.feesOwed0Raw), BigInt(d.position.feesOwed1Raw)], inRange: d.position.inRange }
      : null,
    legs: d.legs.map((leg) => ({ source: leg.source, pools: leg.pools.map((p) => ({ dex: p.dex, fee: p.fee })) })),
    routing: d.routing.router.status,
    simulation: { status: sim.status, reason: sim.reason, method: sim.method },
    warnings: [...d.warnings],
  }
  return { kind: 'ok', reply: { plan, quote, facts, document: d } }
}
