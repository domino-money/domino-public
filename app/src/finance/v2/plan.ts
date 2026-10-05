import { decodeAbiParameters, type Address, type Hex } from 'viem'
import { v3TickSpacing, type V2Chain } from '../../v2/chains'
import { feeTermsMatch, expectedFeeTerms, type RankOf } from '../../v2/feeRule'
import { routeProblems, type PlanTarget } from '../../v2/plan/route'
import { ACTION, LEG_KIND, ZERO_ADDRESS, type ActionName, type ChangeRangePlan, type CreatePlan, type ExitPlan, type IncreasePlan, type PermitBatch, type PoolRef, type PositionIntent, type SwapLeg, type V2Contracts, type ZapPlan } from '../../v2/types'
import { routesHash } from './typedData'

/**
 * The checks the app makes on an S1 plan before it asks for any consent, even with the plan built by a server
 * (spec F7 §2.4, all twelve, and the per-action rules of §2.3, §2.5, §2.6). Pure: every input is given, nothing is read
 * here. The client (./zap.ts) reads what they need through the wallet, runs them, and refuses a plan with any failure;
 * it also simulates the exact call (check 11's on-chain half) before the wallet is asked.
 *
 * A failure is a closed code (`plan_*`), never a sentence: the screen words it. Every failure is listed, so a plan bug
 * is reported whole.
 */

export type Consent = 'direct' | 'permit2' | 'relayed'

/** What the chain says of the position an increase, change of range or exit acts on, read at one block. */
export interface PositionOnChain {
  tokenId: bigint
  owner: Address
  pool: PoolRef
  tickLower: number
  tickUpper: number
  liquidity: bigint
}

/** A leg of the quote, as the review shows it (spec §2.4 response `quote.legs`): what it should and must deliver, and its pools. */
export interface QuotedLeg {
  expectedOut: bigint
  minAmountOut: bigint
  pools: readonly { dex: 3 | 4; fee: number; hooks: Address }[]
}

export interface PlanContext {
  /** The chain the wallet must be on: the plan's. */
  chain: V2Chain
  /** That chain's Domino contracts, from its pinned manifest only. */
  contracts: V2Contracts
  /** The connected wallet: the owner, the payer, the signer. */
  owner: Address
  consent: Consent
  /** Unix seconds now. */
  now: number
  /**
   * The quote's `requestedAt` and `expiresAt` (position-plan-v1: expiresAt = requestedAt + 180, deadline = requestedAt +
   * 300). Changed on purpose (data) 2026-10-02 (rev2 §2.4 decision #3): the deadline is at most requestedAt + 300, and
   * no consent is asked at or after expiresAt; the old rule (deadline ≤ expiresAt) refused every rc.2 plan.
   */
  quoteRequestedAt: number
  quoteExpiresAt: number
  /** Charge-currency ranks: `registry.chargeCurrencyRank`, or the chain profile's until a deployment exists. */
  rankOf: RankOf
  /** `registry.routerVersion(router)` as read, null when unread. */
  routerVersion: (router: Address) => number | null
  /** `zap.hookedPoolsAllowed()` as read (false today). */
  hookedPoolsAllowed: boolean
  /** The position acted on (increase, change range, exit), read on chain. */
  position?: PositionOnChain
  /**
   * What the person asked for (the plan request): the plan's inputs must be exactly the request's, and every swap leg
   * must lead to what the request names (../../v2/plan/route.ts). Changed on purpose (data) 2026-10-02 (Domino V2 rev2
   * review, F1). The recipient is always the connected owner: a recipient of the person's choosing was removed (L5).
   */
  target: PlanTarget
  /** The Permit2 batch to be signed (consent 'permit2'). */
  permit?: PermitBatch
  /** The quote's legs, one per plan leg, for the review (check 12). */
  quotedLegs?: readonly QuotedLeg[]
  /** The server's simulation of the plan (check 11's first half): ok at a block, or its error. */
  simulation?: { ok: boolean; block: bigint; error: string | null }
  /**
   * What a change of range or an exit is expected to take out of the position (principal and fees), per currency, from
   * the quote: conversion legs may spend at most that much of each (spec §2.6.4: each leg spends exactly its signed
   * amountIn, no more than the expected withdrawal).
   */
  expectedRemoved?: readonly [bigint, bigint]
}

export interface PlanVerdict {
  ok: boolean
  failures: readonly string[]
  /** The zap the call goes to (3 → zap.v3, 4 → zap.v4), from the manifest of the plan's chain. */
  zap: Address | null
  /** ETH the direct call carries: the sum of the native inputs. */
  value: bigint
}

const MIN_TICK = -887272
const MAX_TICK = 887272
const MIN_SQRT_PRICE = 4295128739n
const MAX_SQRT_PRICE = 1461446703485210103287273052203988822378723970342n
/** Decision #3 (rev2 §2.4, §2.9): a quote is good for 3 minutes; the intent's and the permit's deadline is 5 minutes after it was made. */
export const PLAN_QUOTE_S = 180
export const PLAN_DEADLINE_S = 300
const MAX_UINT128 = (1n << 128n) - 1n
const MAX_UINT64 = (1n << 64n) - 1n
const ADDRESS = /^0x[0-9a-f]{40}$/
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const isAddress = (value: unknown): value is Address => typeof value === 'string' && ADDRESS.test(value.toLowerCase())

/** The intent's action code for a plan kind. */
export const actionCode = (name: ActionName) => ACTION[name]

/** Check 1: the zap of the pool's DEX on the plan's chain, from that chain's manifest; null when they disagree. */
export function zapFor(contracts: V2Contracts, chainId: number, pool: PoolRef): Address | null {
  if (contracts.chainId !== chainId) return null
  if (pool.dex === 3) return contracts.addresses.zapV3
  if (pool.dex === 4) return contracts.addresses.zapV4
  return null
}

/** A pool well formed for its DEX on this chain: sorted currencies, v3 hookless and with its tier's spacing, no native on v3. */
export function poolProblems(pool: PoolRef, chain: V2Chain): string[] {
  const problems: string[] = []
  if (pool.dex !== 3 && pool.dex !== 4) return ['plan_pool_dex']
  if (!isAddress(pool.currency0) || !isAddress(pool.currency1) || !isAddress(pool.hooks)) return ['plan_pool_address']
  if (BigInt(pool.currency0) >= BigInt(pool.currency1)) problems.push('plan_pool_order')
  if (!Number.isInteger(pool.fee) || pool.fee < 0 || pool.fee > 1_000_000) problems.push('plan_pool_fee')
  if (!Number.isInteger(pool.tickSpacing) || pool.tickSpacing < 1 || pool.tickSpacing > 32_767) problems.push('plan_pool_spacing')
  if (pool.dex === 3) {
    if (!same(pool.hooks, ZERO_ADDRESS)) problems.push('plan_pool_hooks')
    if (same(pool.currency0, ZERO_ADDRESS)) problems.push('plan_pool_native_v3')
    const spacing = v3TickSpacing(chain, pool.fee)
    // A tier outside the profile's table is read from the factory before a plan is built on it.
    if (spacing !== null && spacing !== pool.tickSpacing) problems.push('plan_pool_spacing')
  }
  return problems
}

/** A range valid for a pool: ordered, inside TickMath's bounds, on the pool's spacing. */
export function rangeProblems(tickLower: number, tickUpper: number, tickSpacing: number): string[] {
  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper) || tickLower >= tickUpper || tickLower < MIN_TICK || tickUpper > MAX_TICK) return ['plan_range']
  if (tickLower % tickSpacing !== 0 || tickUpper % tickSpacing !== 0) return ['plan_range_spacing']
  return []
}

/** A v3 path, `token, fee, token, …`: its hops' tokens, or null when malformed (20 + 23·n bytes, 1 ≤ n ≤ 4). */
export function v3PathTokens(data: Hex): Address[] | null {
  const hex = data.slice(2).toLowerCase()
  if (!/^[0-9a-f]*$/.test(hex) || hex.length % 2 !== 0) return null
  const bytes = hex.length / 2
  if (bytes < 43 || (bytes - 20) % 23 !== 0) return null
  const hops = (bytes - 20) / 23
  if (hops > 4) return null
  const tokens: Address[] = []
  for (let i = 0; i <= hops; i++) tokens.push(`0x${hex.slice(i * 46, i * 46 + 40)}` as Address)
  return tokens
}

/** A v4 path, `abi.encode(PoolRef[])`: the tokens it walks from `tokenIn`, or null when malformed or longer than 4 hops. */
export function v4PathTokens(data: Hex, tokenIn: Address): Address[] | null {
  let pools: readonly { dex: number; currency0: string; currency1: string }[]
  try {
    ;[pools] = decodeAbiParameters([{ type: 'tuple[]', components: [
      { name: 'dex', type: 'uint8' }, { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
      { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
    ] }], data)
  } catch {
    return null
  }
  if (pools.length < 1 || pools.length > 4) return null
  const tokens: Address[] = [tokenIn.toLowerCase() as Address]
  for (const pool of pools) {
    const at = tokens[tokens.length - 1]
    if (pool.dex !== 4) return null
    if (same(pool.currency0, at)) tokens.push(pool.currency1.toLowerCase() as Address)
    else if (same(pool.currency1, at)) tokens.push(pool.currency0.toLowerCase() as Address)
    else return null
  }
  return tokens
}

/** Checks 9 and 10 on the legs, and the zap's own leg rules (F1b `_executeLegs`): at most 8, each well formed. */
export function legProblems(legs: readonly SwapLeg[], chain: V2Chain, routerVersion: PlanContext['routerVersion']): string[] {
  const problems = new Set<string>()
  if (legs.length > 8) problems.add('plan_legs_too_many')
  for (const leg of legs) {
    if (!isAddress(leg.tokenIn) || !isAddress(leg.tokenOut) || !isAddress(leg.router)) { problems.add('plan_leg_address'); continue }
    if (same(leg.tokenIn, leg.tokenOut)) problems.add('plan_leg_same_token')
    if (leg.amountIn <= 0n || leg.amountIn > MAX_UINT128) problems.add('plan_leg_amount')
    // Check 10: the contract requires a minimum on every leg, and without one there is no price protection.
    if (leg.minAmountOut <= 0n || leg.minAmountOut > MAX_UINT128) problems.add('plan_leg_minimum')
    if (leg.kind === LEG_KIND.universalRouter) {
      // Check 9: only the chain's Universal Router 2.1.2, admitted by the registry (routerVersion ≥ 212).
      const version = routerVersion(leg.router)
      if (!same(leg.router, chain.uniswap.universalRouter.address)) problems.add('plan_leg_router')
      else if (version === null || version < 212) problems.add('plan_leg_router_not_admitted')
    } else if (leg.kind === LEG_KIND.v3Path) {
      if (!same(leg.router, ZERO_ADDRESS)) problems.add('plan_leg_router')
      const tokens = v3PathTokens(leg.data)
      if (!tokens || !same(tokens[0], leg.tokenIn) || !same(tokens[tokens.length - 1], leg.tokenOut) || tokens.some((t) => same(t, ZERO_ADDRESS))) problems.add('plan_leg_path')
    } else if (leg.kind === LEG_KIND.v4Path) {
      if (!same(leg.router, ZERO_ADDRESS)) problems.add('plan_leg_router')
      const tokens = v4PathTokens(leg.data, leg.tokenIn)
      if (!tokens || !same(tokens[tokens.length - 1], leg.tokenOut)) problems.add('plan_leg_path')
    } else {
      problems.add('plan_leg_kind')
    }
  }
  return [...problems]
}

/** Universal Router `execute(bytes commands, bytes[] inputs, uint256 deadline)`. */
const UR_EXECUTE_WITH_DEADLINE = '0x3593564c'

/**
 * Check 7's recommendation (rev2 §2.4), kept as a rule (Domino V2 rev2 review, L3): the deadline inside a Universal
 * Router leg's calldata, or null when the data is not `execute(bytes,bytes[],uint256)` (then no deadline can be checked,
 * and the leg is refused).
 */
export function urDeadline(data: Hex): bigint | null {
  if (typeof data !== 'string' || !data.toLowerCase().startsWith(UR_EXECUTE_WITH_DEADLINE)) return null
  try {
    const [, , deadline] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }, { type: 'uint256' }], `0x${data.slice(10)}`)
    return deadline
  } catch {
    return null
  }
}

/** Check 8: a Permit2 batch is exactly the plan's ERC-20 inputs, in order, with the intent's nonce and deadline. */
export function permitProblems(permit: PermitBatch | undefined, inputs: readonly { token: Address; amount: bigint }[], intent: PositionIntent): string[] {
  if (!permit) return ['plan_permit_missing']
  const problems: string[] = []
  if (inputs.length === 0) problems.push('plan_permit_no_inputs')
  if (inputs.some((input) => same(input.token, ZERO_ADDRESS))) problems.push('plan_permit_native')
  if (permit.permitted.length !== inputs.length || permit.permitted.some((p, i) => !same(p.token, inputs[i].token) || p.amount !== inputs[i].amount)) problems.push('plan_permit_inputs')
  if (permit.nonce !== intent.nonce) problems.push('plan_permit_nonce')
  // The spec's recommendation, kept as a rule: one deadline for both, so neither outlives the other.
  if (permit.deadline !== intent.deadline) problems.push('plan_permit_deadline')
  return problems
}

/** Check 12: the review's legs, one quoted leg per plan leg, with the plan's own minimum. */
export function reviewLegs(legs: readonly SwapLeg[], quoted: readonly QuotedLeg[] | undefined): { tokenIn: Address; tokenOut: Address; amountIn: bigint; expectedOut: bigint; minAmountOut: bigint; pools: QuotedLeg['pools']; asQuoted: boolean }[] | null {
  if (legs.length === 0) return []
  if (!quoted || quoted.length !== legs.length) return null
  if (quoted.some((q, i) => q.minAmountOut !== legs[i].minAmountOut || q.expectedOut < q.minAmountOut)) return null
  return legs.map((leg, i) => ({
    tokenIn: leg.tokenIn, tokenOut: leg.tokenOut, amountIn: leg.amountIn,
    expectedOut: quoted[i].expectedOut, minAmountOut: leg.minAmountOut, pools: quoted[i].pools,
    // A Universal Router leg's pools come from the quote, not from the chain: the review labels them "as quoted".
    asQuoted: leg.kind === LEG_KIND.universalRouter,
  }))
}

const planInputs = (zapPlan: ZapPlan) => (zapPlan.action === 'create' || zapPlan.action === 'increase' ? zapPlan.plan.inputs : [])

/**
 * Every check of §2.4 on one plan, with the per-action rules. `ok` only with no failure; `zap` and `value` are what the
 * call is built with.
 */
export function checkPlan(zapPlan: ZapPlan, ctx: PlanContext): PlanVerdict {
  const failures = new Set<string>()
  const add = (codes: string | readonly string[]) => { for (const code of typeof codes === 'string' ? [codes] : codes) failures.add(code) }
  const { intent } = zapPlan.plan
  const { pool } = intent
  const legs = zapPlan.plan.legs
  const inputs = planInputs(zapPlan)

  // 1. Contract and chain: the pool's DEX picks the zap, from the manifest of the plan's chain.
  const zap = zapFor(ctx.contracts, ctx.chain.chainId, pool)
  if (!zap) add('plan_wrong_chain')
  add(poolProblems(pool, ctx.chain))
  // 2. Pool: no hook (positions in hooked v4 pools are refused until the owner allows them).
  if (!same(pool.hooks, ZERO_ADDRESS) && !ctx.hookedPoolsAllowed) add('plan_pool_hooked')
  // 3. Route: the signed routesHash is the legs'.
  if (intent.routesHash.toLowerCase() !== routesHash(legs).toLowerCase()) add('plan_routes_hash')
  // 4. Fee terms: none without legs, 65 bps in the rank rule's token with them.
  try {
    if (!feeTermsMatch(legs, ctx.rankOf, intent.feeBps, intent.feeToken)) add('plan_fee_terms')
  } catch {
    add('plan_fee_terms')
  }
  // 5. Per-action fields (§2.3).
  if (intent.action !== actionCode(zapPlan.action)) add('plan_action')
  const position = ctx.position
  if (zapPlan.action === 'create') {
    if (intent.tokenId !== 0n) add('plan_token_id')
    add(rangeProblems(intent.tickLower, intent.tickUpper, pool.tickSpacing))
    const create: CreatePlan = zapPlan.plan
    // Not zero initializes a pool with no price (rev2 §2.6.5, decision #7): inside TickMath's bounds. Changed on purpose
    // (data) 2026-10-02 (rev2 §2.6.5 decision #7): pool creation is offered, so the round-2 refusal of any non-zero
    // value is gone; the money client checks the pool read unpriced and the value the app computed (check 13).
    if (create.initSqrtPriceX96 !== 0n && (create.initSqrtPriceX96 < MIN_SQRT_PRICE || create.initSqrtPriceX96 >= MAX_SQRT_PRICE)) add('plan_init_price')
  } else {
    if (!position) add('plan_position_unread')
    else {
      if (intent.tokenId !== position.tokenId || intent.tokenId <= 0n) add('plan_token_id')
      // Every action on an existing position needs its current owner (spec §2.2), as sender or signer.
      if (!same(position.owner, ctx.owner)) add('plan_not_owner')
      if (!samePool(position.pool, pool)) add('plan_position_pool')
      if (zapPlan.action === 'increase' || zapPlan.action === 'exit') {
        if (intent.tickLower !== position.tickLower || intent.tickUpper !== position.tickUpper) add('plan_ticks_not_current')
      } else {
        add(rangeProblems(intent.tickLower, intent.tickUpper, pool.tickSpacing))
      }
      if (zapPlan.action === 'changeRange') {
        const plan: ChangeRangePlan = zapPlan.plan
        if (plan.liquidityToRemove <= 0n || plan.liquidityToRemove > position.liquidity) add('plan_liquidity_to_remove')
        if (plan.burnOld && plan.liquidityToRemove !== position.liquidity) add('plan_partial_burn')
        // A removal with no minimum at all has no price protection (spec §2.9; the relayed path signs them for this
        // reason). At least one; their size (floor(expected × (1 − s))) needs the plan API's expected principal.
        if (plan.liquidityToRemove > 0n && plan.amount0MinRemoved === 0n && plan.amount1MinRemoved === 0n) add('plan_removal_minimums')
      }
      if (zapPlan.action === 'exit') {
        const plan: ExitPlan = zapPlan.plan
        if (plan.liquidityToRemove < 0n || plan.liquidityToRemove > position.liquidity) add('plan_liquidity_to_remove')
        if (plan.liquidityToRemove < intent.minLiquidity) add('plan_exit_below_minimum')
        if (plan.burn && plan.liquidityToRemove !== position.liquidity) add('plan_partial_burn')
        if (plan.liquidityToRemove > 0n && plan.amount0MinRemoved === 0n && plan.amount1MinRemoved === 0n) add('plan_removal_minimums')
        // Collecting only: nothing removed, no minimum, no burn.
        if (plan.liquidityToRemove === 0n && (intent.minLiquidity !== 0n || plan.burn)) add('plan_collect_only')
      }
    }
  }
  // 10 (liquidity half): a minimum on what create, increase and change range add; the v4 refuses zero anyway.
  if (zapPlan.action !== 'exit' && (intent.minLiquidity <= 0n || intent.minLiquidity > MAX_UINT128)) add('plan_min_liquidity')
  // 6. Recipient: the connected wallet, always (the plan API plans for the session's wallet only, rev2 §2.4). Changed on
  // purpose (data) 2026-10-02 (Domino V2 rev2 review, L5): a recipient of the person's choosing (direct path) was removed.
  const recipientOk = isAddress(intent.recipient) && !same(intent.recipient, ZERO_ADDRESS) && !(zap && same(intent.recipient, zap))
  if (!recipientOk || !same(intent.recipient, ctx.owner)) add('plan_recipient')
  // 7. Deadline (decision #3): in the future and at most 5 minutes after the quote was made; no consent at or after the
  // quote's expiry (3 minutes). Changed on purpose (data) 2026-10-02 (rev2 §2.4 decision #3).
  if (intent.deadline <= BigInt(Math.floor(ctx.now)) || intent.deadline > BigInt(Math.floor(ctx.quoteRequestedAt) + PLAN_DEADLINE_S) || intent.deadline > MAX_UINT64) add('plan_deadline')
  if (Math.floor(ctx.now) >= Math.floor(ctx.quoteExpiresAt)) add('plan_quote_expired')
  // 8. Permit2: ERC-20 inputs only, the permit equal to the inputs, its nonce and deadline the intent's.
  if (ctx.consent === 'permit2') {
    if (zapPlan.action !== 'create' && zapPlan.action !== 'increase') add('plan_consent')
    else add(permitProblems(ctx.permit, inputs, intent))
  }
  if (ctx.consent === 'relayed' && zapPlan.action !== 'changeRange' && zapPlan.action !== 'exit') add('plan_consent')
  // Inputs: positive, at most uint128, each token once; native is address(0).
  const seen = new Set<string>()
  for (const input of inputs) {
    if (!isAddress(input.token) || input.amount <= 0n || input.amount > MAX_UINT128 || seen.has(input.token.toLowerCase())) add('plan_inputs')
    seen.add(input.token.toLowerCase())
  }
  if ((zapPlan.action === 'create' || zapPlan.action === 'increase') && inputs.length === 0) add('plan_inputs')
  // 9 and 10 on the legs.
  add(legProblems(legs, ctx.chain, ctx.routerVersion))
  // Check 7's recommendation, as a rule (Domino V2 rev2 review, L3): a Universal Router leg's own deadline is not before
  // the intent's; calldata whose deadline cannot be read is refused.
  for (const leg of legs) {
    if (leg.kind !== LEG_KIND.universalRouter) continue
    const deadline = urDeadline(leg.data)
    if (deadline === null || deadline < intent.deadline) add('plan_leg_router_deadline')
  }
  // The request it answers (Domino V2 rev2 review, F1): the plan's inputs are the request's, and every leg leads to what
  // the request names (../../v2/plan/route.ts): an exit to one token converts into that token only, an exit to both
  // tokens swaps nothing, and what a create, an increase or a change of range swaps ends in the pool's own currencies.
  const target = ctx.target
  if (!target || target.action !== zapPlan.action) add('plan_target')
  else {
    if (target.action === 'create' || target.action === 'increase') {
      if (target.inputs.length !== inputs.length || target.inputs.some((asked, i) => !same(asked.token, inputs[i].token) || asked.amount !== inputs[i].amount)) add('plan_target')
    }
    add(routeProblems(legs, target, pool, ctx.chain.wrappedNative.address))
  }
  // A change of range or an exit swaps only what leaves the position: its legs spend at most the expected withdrawal.
  if ((zapPlan.action === 'changeRange' || zapPlan.action === 'exit') && legs.length > 0) {
    if (!ctx.expectedRemoved) add('plan_conversion_unbounded')
    else {
      const spent = (token: Address) => legs.filter((leg) => same(leg.tokenIn, token)).reduce((sum, leg) => sum + leg.amountIn, 0n)
      const [removed0, removed1] = ctx.expectedRemoved
      if (spent(pool.currency0) > removed0 || spent(pool.currency1) > removed1) add('plan_conversion_exceeds_removal')
      if (legs.some((leg) => !same(leg.tokenIn, pool.currency0) && !same(leg.tokenIn, pool.currency1) && !legs.some((other) => same(other.tokenOut, leg.tokenIn)))) add('plan_conversion_foreign_input')
    }
  }
  // 11. The plan's own simulation must have passed (the client simulates the exact call itself before the wallet).
  if (!ctx.simulation || !ctx.simulation.ok || ctx.simulation.error !== null) add('plan_simulation')
  // 12. The review shows every leg: the quote must carry one per plan leg, with the plan's own minimums.
  if (reviewLegs(legs, ctx.quotedLegs) === null) add('plan_review_legs')
  // Amount caps: what enters the position is capped, never negative.
  const caps = zapPlan.action === 'create' || zapPlan.action === 'increase' || zapPlan.action === 'changeRange' ? [zapPlan.plan.amount0Max, zapPlan.plan.amount1Max] : []
  if (caps.some((cap) => cap < 0n || cap > MAX_UINT128)) add('plan_amount_caps')
  const value = ctx.consent === 'direct' ? inputs.filter((input) => same(input.token, ZERO_ADDRESS)).reduce((sum, input) => sum + input.amount, 0n) : 0n
  return { ok: failures.size === 0, failures: [...failures], zap, value }
}

/** The same pool, field by field (addresses in any case). */
export function samePool(a: PoolRef, b: PoolRef): boolean {
  return a.dex === b.dex && same(a.currency0, b.currency0) && same(a.currency1, b.currency1) && a.fee === b.fee && a.tickSpacing === b.tickSpacing && same(a.hooks, b.hooks)
}

// ---------------------------------------------------------------------------------------------------------------------
// The plan's minimums tied to the app's own reads (Domino V2 rev2 review, F4). Added on purpose (data) 2026-10-02.
//
// position-plan-v1's `planMinimums` (rc.2) computes `minLiquidity` and the removal minimums from the answer's own pool
// price, position and post-swap price, and the package's validator recomputes them from the same answer: a server that
// misstates the chain gets minimums that protect nothing. So, before any consent, the app ties them to what IT reads
// through the wallet at the review's block, and to what its own simulation of the exact call returns.
// ---------------------------------------------------------------------------------------------------------------------

/** A band of sqrt prices, both ends included: the plan's minimums hold between them (rev2 §2.9). */
export interface SqrtBand {
  lower: bigint
  upper: bigint
}

/**
 * What the plan's minimums were computed from (position-plan-v1 `request.slippageBps`, `pool.sqrtPriceX96`,
 * `expected.sqrtPriceX96After`, `expected.liquidity`, `minimums.mintBand` / `removalBand`, `position`).
 */
export interface PlanBasis {
  slippageBps: number
  /** The pool's price the plan read at its block; null for a pool with no price (a new pool, rev2 §2.6.5). */
  poolSqrtPriceX96: bigint | null
  /** The pool's price once the legs ran, which the mint meets (null for an exit). */
  sqrtPriceX96After: bigint | null
  /** The liquidity the plan expects the main step to mint (create, increase, change range). */
  expectedLiquidity: bigint
  mintBand: SqrtBand | null
  removalBand: SqrtBand | null
  /** The position as the plan read it (increase, change range, exit). */
  position: { tickLower: number; tickUpper: number; liquidity: bigint } | null
}

/** What the app itself read through the wallet at the review's block. */
export interface PlanReads {
  /** The pool's price now (v3 slot0, v4 StateView.getSlot0); null when the pool has none. */
  poolSqrtPriceX96: bigint | null
  /** The position acted on, as read (increase, change range, exit). */
  position: PositionOnChain | null
}

/** The zap's ActionResult (spec §2.1): what the main step did, decoded from a simulation's return data. */
export interface ActionResult {
  tokenId: bigint
  liquidity: bigint
  amount0: bigint
  amount1: bigint
  feeToken: Address
  feeAmount: bigint
}

/** The integer square root, floor (position-plan-v1 runtime.mjs `isqrt`, the same Newton steps). */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new Error('isqrt_negative')
  if (n < 2n) return n
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2))
  for (;;) {
    const y = (x + n / x) >> 1n
    if (y >= x) return x
    x = y
  }
}

/** The sqrt price of `price × (1 + step × s / 2)`, inside TickMath's bounds (position-plan-v1 runtime.mjs `bandSqrtPrice`). */
export function bandSqrtPrice(sqrtPriceX96: bigint, slippageBps: number, step: number): bigint {
  const value = isqrt((sqrtPriceX96 * sqrtPriceX96 * BigInt(20000 + step * slippageBps)) / 20000n)
  return value <= MIN_SQRT_PRICE ? MIN_SQRT_PRICE + 1n : value >= MAX_SQRT_PRICE ? MAX_SQRT_PRICE - 1n : value
}

/** The ±s band around a sqrt price, as position-plan-v1 writes `mintBand` and `removalBand`. */
export const bandAround = (sqrtPriceX96: bigint, slippageBps: number): SqrtBand => ({ lower: bandSqrtPrice(sqrtPriceX96, slippageBps, -2), upper: bandSqrtPrice(sqrtPriceX96, slippageBps, 2) })

/**
 * Whether a leg swaps through the position's own pool (and so moves the price the mint meets): a v3 path hop with the
 * pool's two tokens and tier, a v4 path entry equal to the pool. A Universal Router leg never crosses it (rev2 §2.4: the
 * planner never picks one that does), so the app takes its pools as not crossing, and the price must then be unmoved.
 */
export function legsCrossPool(legs: readonly SwapLeg[], pool: PoolRef): boolean {
  return legs.some((leg) => {
    if (leg.kind === LEG_KIND.v3Path && pool.dex === 3) {
      const hex = leg.data.slice(2).toLowerCase()
      const tokens = v3PathTokens(leg.data)
      if (!tokens) return false
      for (let i = 0; i + 1 < tokens.length; i++) {
        const fee = Number.parseInt(hex.slice(i * 46 + 40, i * 46 + 46), 16)
        const pair = [tokens[i], tokens[i + 1]]
        if (fee === pool.fee && pair.some((t) => same(t, pool.currency0)) && pair.some((t) => same(t, pool.currency1))) return true
      }
      return false
    }
    if (leg.kind === LEG_KIND.v4Path && pool.dex === 4) {
      try {
        const [entries] = decodeAbiParameters([{ type: 'tuple[]', components: [
          { name: 'dex', type: 'uint8' }, { name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' },
          { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' },
        ] }], leg.data)
        return entries.some((entry) => samePool({ dex: entry.dex as 3 | 4, currency0: entry.currency0, currency1: entry.currency1, fee: entry.fee, tickSpacing: entry.tickSpacing, hooks: entry.hooks }, pool))
      } catch {
        return false
      }
    }
    return false
  })
}

/**
 * The plan's basis against the app's own reads at the review's block (F4). Closed codes:
 *   - `plan_basis`: the basis is not the one the plan's own minimums need (a band that is not ±s around its price, a
 *     missing band or price, an expected liquidity under the minimum, a post-swap price that moved with no leg through
 *     the pool, a new pool's band not at its starting price);
 *   - `plan_pool_unpriced`: the pool the plan acts on has no price at the review's block;
 *   - `plan_price_moved`: the price the app reads is outside the ±s band around the price the plan's minimums used;
 *   - `plan_position_changed`: the position's range or liquidity is not what the plan's removal minimums used.
 */
export function basisProblems(zapPlan: ZapPlan, basis: PlanBasis, reads: PlanReads, createsPool: boolean): string[] {
  const problems = new Set<string>()
  const s = basis.slippageBps
  if (!Number.isSafeInteger(s) || s < 10 || s > 500) return ['plan_basis']
  const action = zapPlan.action
  const intent = zapPlan.plan.intent
  const mints = action !== 'exit'
  const removes = action === 'changeRange' || action === 'exit'
  const sameBand = (band: SqrtBand | null, sqrt: bigint | null) => band !== null && sqrt !== null && sqrt > 0n && band.lower === bandSqrtPrice(sqrt, s, -2) && band.upper === bandSqrtPrice(sqrt, s, 2)
  if (mints && (!sameBand(basis.mintBand, basis.sqrtPriceX96After) || basis.expectedLiquidity < intent.minLiquidity)) problems.add('plan_basis')
  if (removes && !sameBand(basis.removalBand, basis.poolSqrtPriceX96)) problems.add('plan_basis')
  if (createsPool) {
    // A new pool (rev2 §2.6.5): unpriced at the review (check 13), its mint band around the app's own starting price.
    if (zapPlan.action !== 'create' || basis.poolSqrtPriceX96 !== null || basis.sqrtPriceX96After !== zapPlan.plan.initSqrtPriceX96) problems.add('plan_basis')
    return [...problems]
  }
  if (reads.poolSqrtPriceX96 === null || reads.poolSqrtPriceX96 === 0n) problems.add('plan_pool_unpriced')
  else if (basis.poolSqrtPriceX96 === null) problems.add('plan_basis')
  else {
    // The price the app reads is inside the ±s band around the price the plan's minimums used (for a removal, exactly
    // its removal band); a mint that no leg moves meets that same price, so the plan's post-swap price must be it.
    const band = bandAround(basis.poolSqrtPriceX96, s)
    if (reads.poolSqrtPriceX96 < band.lower || reads.poolSqrtPriceX96 > band.upper) problems.add('plan_price_moved')
    if (mints && !legsCrossPool(zapPlan.plan.legs, intent.pool) && basis.sqrtPriceX96After !== basis.poolSqrtPriceX96) problems.add('plan_basis')
  }
  if (action !== 'create') {
    const claimed = basis.position
    if (removes && claimed === null) problems.add('plan_basis')
    const read = reads.position
    if (claimed && read && (claimed.tickLower !== read.tickLower || claimed.tickUpper !== read.tickUpper || claimed.liquidity !== read.liquidity)) problems.add('plan_position_changed')
  }
  return [...problems]
}

const ACTION_RESULT = [{ type: 'tuple', components: [
  { name: 'tokenId', type: 'uint256' }, { name: 'liquidity', type: 'uint128' }, { name: 'amount0', type: 'uint256' },
  { name: 'amount1', type: 'uint256' }, { name: 'feeToken', type: 'address' }, { name: 'feeAmount', type: 'uint256' },
] }] as const

/** The ActionResult a simulation of a zap action returned, or null when its return data is not one. */
export function actionResultOf(data: Hex): ActionResult | null {
  if (typeof data !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data) || (data.length - 2) / 2 !== 6 * 32) return null
  try {
    const [result] = decodeAbiParameters(ACTION_RESULT, data)
    return { tokenId: result.tokenId, liquidity: result.liquidity, amount0: result.amount0, amount1: result.amount1, feeToken: result.feeToken.toLowerCase() as Address, feeAmount: result.feeAmount }
  } catch {
    return null
  }
}

/**
 * The app's own simulation of the exact call (check 11) against the plan (F4). Closed codes:
 *   - `plan_simulated_result`: no ActionResult, or not this plan's (another position, another fee token, an exit that
 *     removes another amount of liquidity);
 *   - `plan_simulated_below_minimum`: the simulated liquidity is under `minLiquidity` (the call would revert);
 *   - `plan_simulated_off_expected`: the simulated liquidity is further from the plan's expected liquidity than the
 *     plan's own tolerance (expected − minimum): the plan's figures do not describe the chain.
 */
export function actionResultProblems(zapPlan: ZapPlan, basis: PlanBasis, result: ActionResult | null): string[] {
  if (!result) return ['plan_simulated_result']
  const intent = zapPlan.plan.intent
  const problems = new Set<string>()
  if (!same(result.feeToken, intent.feeToken)) problems.add('plan_simulated_result')
  switch (zapPlan.action) {
    case 'create': if (result.tokenId === 0n) problems.add('plan_simulated_result'); break
    case 'increase': if (result.tokenId !== intent.tokenId) problems.add('plan_simulated_result'); break
    case 'changeRange': if (result.tokenId === 0n || result.tokenId === intent.tokenId) problems.add('plan_simulated_result'); break
    case 'exit': if (result.tokenId !== intent.tokenId || result.liquidity !== zapPlan.plan.liquidityToRemove) problems.add('plan_simulated_result'); break
  }
  if (zapPlan.action !== 'exit') {
    const minimum = intent.minLiquidity
    const expected = basis.expectedLiquidity
    if (result.liquidity < minimum) problems.add('plan_simulated_below_minimum')
    else if (expected < minimum) problems.add('plan_basis')
    else {
      const tolerance = expected - minimum
      const distance = result.liquidity > expected ? result.liquidity - expected : expected - result.liquidity
      if (distance > tolerance) problems.add('plan_simulated_off_expected')
    }
  }
  return [...problems]
}

/** The fee terms a plan should carry, for the review and for a plan the app builds itself (no server). */
export { expectedFeeTerms }

/** The RelayedPositionAction a relayed change of range or exit signs: exactly the plan's fields (spec §2.5.3). */
export function relayedActionOf(zapPlan: Extract<ZapPlan, { action: 'changeRange' | 'exit' }>) {
  if (zapPlan.action === 'changeRange') {
    const plan = zapPlan.plan
    return { intent: plan.intent, liquidityToRemove: plan.liquidityToRemove, amount0MinRemoved: plan.amount0MinRemoved, amount1MinRemoved: plan.amount1MinRemoved, amount0Max: plan.amount0Max, amount1Max: plan.amount1Max, burn: plan.burnOld }
  }
  const plan = zapPlan.plan
  // An exit signs zero caps (spec §2.5.3).
  return { intent: plan.intent, liquidityToRemove: plan.liquidityToRemove, amount0MinRemoved: plan.amount0MinRemoved, amount1MinRemoved: plan.amount1MinRemoved, amount0Max: 0n, amount1Max: 0n, burn: plan.burn }
}

export type { CreatePlan, IncreasePlan, ChangeRangePlan, ExitPlan }
