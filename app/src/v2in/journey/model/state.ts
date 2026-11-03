import { presetFor, usableTicks } from '../../../lib/read/screens/poolRange'
import { slippageBpsFrom } from '../../../lib/create/slippage'
import { v2Chain } from '../../../v2/chains'
import { initialSqrtPrice, parsePriceText } from '../../../v2/plan/initialPrice'
import { parseUnitsText } from '../../../v2/plan/present'
import type { S1InitialPrice, S1PlanConsent, S1PlanRequest } from '../../../v2/plan/types'
import { ZERO_ADDRESS, type Address, type PoolRef, type V2ChainId } from '../../../v2/types'
import { JOURNEY_DEFAULT_SLIPPAGE_BPS } from '../constants'
import { JOURNEY } from '../copy'
import { CREATE } from '../../../lib/create/copy'
import { figureHint, type Decimal } from '../../../lib/create/typedFigure'
import { offeredPool, type JourneyPool } from './pools'
import { priceAt, type JourneyPriceState } from './price'

/**
 * New position on Domino's new contracts, as a pure state machine over the journey's own four steps (Pool, Range,
 * Amount, Review: components/create/StepList.tsx VISUAL_STEPS), spec F7 rev2 §2.6.1 "Cards": 1 network and pool, 2 range,
 * 3 amounts and slippage, 4 review, then the wallet's steps under the review. What each step needs before Continue, and
 * the plan request the review asks for (§2.4 "Pedido"). No React, no reads: the screens put validated reads and inputs
 * here, and nothing here signs, approves or sends.
 */

export type JourneyStep = 'pool' | 'range' | 'amount' | 'review'
export const JOURNEY_STEPS: readonly JourneyStep[] = ['pool', 'range', 'amount', 'review']
export const stepIndex = (step: JourneyStep): number => JOURNEY_STEPS.indexOf(step)

/** A range in the pool's own ticks (lower < upper, on the spacing). */
export interface TickRange {
  lower: number
  upper: number
}

/** A new pool's starting price as typed (§2.6.5): one whole `base` token is worth `text` of the other. */
export interface StartingPriceText {
  base: 'currency0' | 'currency1'
  text: string
}

/**
 * What the person puts in (§2.6.1 "o que depositar": one or both of the pool's tokens, or another token): `pool`, an
 * amount in either of the pool's tokens or both (an empty field is none of it); `other`, exactly one token outside the
 * pool, which the zap swaps. Texts by token address, as typed.
 */
export interface Amounts {
  mode: 'pool' | 'other'
  other: Address | null
  text: Readonly<Record<string, string>>
}

export interface JourneyState {
  chainId: V2ChainId
  pool: JourneyPool | null
  /** A pool with no price: the starting price the person types ("Create a new pool (advanced)"); null otherwise. */
  start: StartingPriceText | null
  range: TickRange | null
  amounts: Amounts
  /** Whole basis points as typed, as the journey keeps them (lib/create/slippage.ts): 10 to 500. */
  slippage: string
  step: JourneyStep
  furthest: JourneyStep
}

export type Check = { ok: true } | { ok: false; reason: string }
const OK: Check = { ok: true }
const fail = (reason: string): Check => ({ ok: false, reason })

export function initialJourney(chainId: V2ChainId): JourneyState {
  return { chainId, pool: null, start: null, range: null, amounts: { mode: 'pool', other: null, text: {} }, slippage: String(JOURNEY_DEFAULT_SLIPPAGE_BPS), step: 'pool', furthest: 'pool' }
}

/* ---------------------------------------------------------------------------
   Prices
--------------------------------------------------------------------------- */

/**
 * A new pool's exact starting price (§2.6.5): what the person typed, in the orientation they chose, as the exact
 * initSqrtPriceX96 and tick the zap initializes the pool with (src/v2/plan/initialPrice.ts). Null while the price is not a
 * plain positive decimal, a decimals count is unknown (never guessed), or the value falls outside TickMath's bounds.
 */
export function startingPrice(pool: Pick<JourneyPool, 'pool' | 'tokens'>, start: StartingPriceText): (S1InitialPrice & { tick: number }) | null {
  const [t0, t1] = pool.tokens
  if (t0.decimals === null || t1.decimals === null) return null
  const price = parsePriceText(start.text)
  if (!price) return null
  const exact = initialSqrtPrice({ price, base: start.base, decimals0: t0.decimals, decimals1: t1.decimals })
  if (!exact) return null
  const baseToken = start.base === 'currency0' ? pool.pool.currency0 : pool.pool.currency1
  return { price: price.text, baseToken, decimals0: t0.decimals, decimals1: t1.decimals, sqrtPriceX96: exact.sqrtPriceX96, tick: exact.tick }
}

/** The price the range is set on: the pool's own, or, for a new pool, the starting price typed. */
export function journeyPrice(state: Pick<JourneyState, 'pool' | 'start'>, now: number): JourneyPriceState | null {
  const pool = state.pool
  if (!pool) return null
  if (pool.initialized) {
    return priceAt({ chainId: pool.chainId, currency0: pool.pool.currency0, currency1: pool.pool.currency1, tokens: pool.tokens, sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick, tickSpacing: pool.pool.tickSpacing, block: pool.block, readAt: pool.readAt, now })
  }
  const exact = state.start ? startingPrice(pool, state.start) : null
  if (!exact) return null
  return priceAt({ chainId: pool.chainId, currency0: pool.pool.currency0, currency1: pool.pool.currency1, tokens: pool.tokens, sqrtPriceX96: exact.sqrtPriceX96, tick: exact.tick, tickSpacing: pool.pool.tickSpacing, block: pool.block, readAt: null, now })
}

/** The tick the range is set around: the pool's, or the starting price's; null without one. */
export function journeyTick(state: Pick<JourneyState, 'pool' | 'start'>): number | null {
  const pool = state.pool
  if (!pool) return null
  if (pool.initialized) return pool.tick
  const exact = state.start ? startingPrice(pool, state.start) : null
  return exact ? exact.tick : null
}

/** The standard width (Closer: 0.7× to 1.5× of the price as the page writes it), on a usable price; null otherwise. */
function presetOn(price: JourneyPriceState | null): TickRange | null {
  return price && price.state === 'usable' ? presetFor(price, 'standard') : null
}

/* ---------------------------------------------------------------------------
   Transitions
--------------------------------------------------------------------------- */

/** A different pool starts again from its own price: the standard width, no amounts. The same pool read again keeps them. */
export function withPool(state: JourneyState, pool: JourneyPool | null, now: number): JourneyState {
  if (pool && state.pool && pool.chainId === state.pool.chainId && pool.id === state.pool.id && pool.pool.dex === state.pool.pool.dex && pool.initialized === state.pool.initialized) return { ...state, pool }
  const next: JourneyState = { ...state, pool, start: null, range: null, amounts: { mode: 'pool', other: null, text: {} } }
  return { ...next, range: pool ? presetOn(journeyPrice(next, now)) : null }
}

/** A new starting price: the range follows it (the standard width around it). */
export function withStart(state: JourneyState, start: StartingPriceText | null, now: number): JourneyState {
  const next: JourneyState = { ...state, start }
  return { ...next, range: presetOn(journeyPrice(next, now)) }
}

export const withRange = (state: JourneyState, range: TickRange | null): JourneyState => ({ ...state, range })
export const withAmounts = (state: JourneyState, amounts: Amounts): JourneyState => ({ ...state, amounts })
export const withSlippage = (state: JourneyState, slippage: string): JourneyState => ({ ...state, slippage })

/* ---------------------------------------------------------------------------
   What each step needs
--------------------------------------------------------------------------- */

/** The tokens "Another token" offers: the chain's charge currencies, WETH and ETH, when not one of the pool's own. */
export function otherTokens(chainId: V2ChainId, pool: PoolRef): Address[] {
  const chain = v2Chain(chainId)
  const own = new Set([pool.currency0, pool.currency1].map((token) => token.toLowerCase()))
  const candidates = [...chain.chargeCurrencies.map((currency) => currency.address), chain.wrappedNative.address, ZERO_ADDRESS]
  return [...new Set(candidates)].filter((token) => !own.has(token)) as Address[]
}

/** A token's decimals as this state knows them: the pool's tokens', the profile's for ETH, WETH and the charge currencies. */
function decimalsIn(state: Pick<JourneyState, 'pool' | 'chainId'>, token: Address): number | null {
  const pool = state.pool
  if (pool && token === pool.pool.currency0) return pool.tokens[0].decimals
  if (pool && token === pool.pool.currency1) return pool.tokens[1].decimals
  if (token === ZERO_ADDRESS) return 18
  const chain = v2Chain(state.chainId)
  if (token === chain.wrappedNative.address) return 18
  return chain.chargeCurrencies.find((currency) => currency.address === token)?.decimals ?? null
}

/** What goes in, in raw units: the typed amounts, each positive; null while one is malformed or none is typed. */
export function inputsOf(state: Pick<JourneyState, 'pool' | 'chainId' | 'amounts'>): { token: Address; amount: bigint }[] | null {
  const pool = state.pool
  if (!pool) return null
  const { amounts } = state
  const tokens = amounts.mode === 'other' ? (amounts.other ? [amounts.other] : []) : [pool.pool.currency0, pool.pool.currency1]
  const out: { token: Address; amount: bigint }[] = []
  for (const token of tokens) {
    const text = (amounts.text[token] ?? '').trim()
    if (text === '') continue
    const amount = parseUnitsText(text, decimalsIn(state, token))
    if (amount === null) return null
    out.push({ token, amount })
  }
  return out.length > 0 ? out : null
}

/**
 * Why an amount field's text is refused, or null (empty is not an error: it is "none of this token"). Changed on purpose
 * 2026-11-02 (review M4): a comma the reading refuses (an ambiguous "1,250", or a decimal comma where the person's
 * language writes a dot) says what it needs (lib/create/typedFigure.ts) instead of the one line. `decimal`: for a test.
 */
export function amountProblem(state: Pick<JourneyState, 'pool' | 'chainId'>, token: Address, text: string, decimal?: Decimal): string | null {
  if (text.trim() === '') return null
  return parseUnitsText(text, decimalsIn(state, token), decimal) === null ? figureHint(text, decimal) ?? JOURNEY.amount.invalid : null
}

/** Whether a range is usable on a spacing: whole ticks, multiples of it, inside the ticks it allows, lower below upper. */
export function rangeCheckOn(range: TickRange | null, spacing: number): Check {
  if (!range) return fail(CREATE.amount.noRange)
  if (!Number.isInteger(range.lower) || !Number.isInteger(range.upper)) return fail(CREATE.amount.rangeTicks)
  if (range.lower % spacing !== 0 || range.upper % spacing !== 0) return fail(CREATE.amount.rangeSpacing)
  const { min, max } = usableTicks(spacing)
  if (range.lower < min || range.upper > max) return fail(CREATE.amount.rangeBounds)
  if (range.lower >= range.upper) return fail(CREATE.amount.rangeOrder)
  return OK
}

export function canContinue(step: JourneyStep, state: JourneyState): Check {
  const pool = state.pool
  switch (step) {
    case 'pool':
      if (!pool) return fail(CREATE.pool.needPool)
      if (!offeredPool(pool.pool)) return fail(JOURNEY.pool.unsupported)
      if (!pool.initialized && !(state.start && startingPrice(pool, state.start))) return fail(JOURNEY.newPool.needed)
      return OK
    case 'range':
      if (!pool) return fail(CREATE.pool.needPool)
      return rangeCheckOn(state.range, pool.pool.tickSpacing)
    case 'amount': {
      if (!pool) return fail(CREATE.pool.needPool)
      const tokens = state.amounts.mode === 'other' ? (state.amounts.other ? [state.amounts.other] : []) : [pool.pool.currency0, pool.pool.currency1]
      for (const token of tokens) {
        const problem = amountProblem(state, token, state.amounts.text[token] ?? '')
        if (problem) return fail(problem)
      }
      if (!inputsOf(state)) return fail(JOURNEY.amount.none)
      return slippageBpsFrom(state.slippage) === null ? fail(JOURNEY.amount.slippageInvalid) : OK
    }
    case 'review':
      return fail(CREATE.review.final)
    default:
      return step satisfies never
  }
}

/** The furthest step every earlier one allows. */
export function reachable(state: JourneyState): JourneyStep {
  for (const step of JOURNEY_STEPS) if (!canContinue(step, state).ok) return step
  return 'review'
}

/** Whether a step may be opened: reached before, and every step before it still complete. */
export function canOpen(step: JourneyStep, state: JourneyState): boolean {
  const furthest = stepIndex(state.furthest) <= stepIndex(reachable(state)) ? state.furthest : reachable(state)
  return stepIndex(step) <= stepIndex(furthest)
}

export function next(state: JourneyState): JourneyState {
  const at = stepIndex(state.step)
  if (at >= JOURNEY_STEPS.length - 1 || !canContinue(state.step, state).ok) return state
  const step = JOURNEY_STEPS[at + 1]
  return { ...state, step, furthest: stepIndex(step) > stepIndex(state.furthest) ? step : state.furthest }
}

export function back(state: JourneyState): JourneyState {
  const at = stepIndex(state.step)
  return at === 0 ? state : { ...state, step: JOURNEY_STEPS[at - 1] }
}

export function goTo(state: JourneyState, step: JourneyStep): JourneyState {
  return canOpen(step, state) ? { ...state, step } : state
}

/* ---------------------------------------------------------------------------
   The plan request
--------------------------------------------------------------------------- */

/**
 * The create request the review asks the plan service for (§2.4 "Pedido"), for one consent: the pool, the range, the
 * inputs, the slippage and, for a new pool, the starting price with the app's own exact value (check 13). No owner and
 * no recipient: the service plans for the session's wallet only. Null while a step is incomplete.
 */
export function createRequest(state: JourneyState, consent: S1PlanConsent): S1PlanRequest | null {
  const pool = state.pool
  const inputs = inputsOf(state)
  const slippageBps = slippageBpsFrom(state.slippage)
  if (!pool || !inputs || slippageBps === null || !state.range || !rangeCheckOn(state.range, pool.pool.tickSpacing).ok) return null
  const exact = !pool.initialized && state.start ? startingPrice(pool, state.start) : null
  if (!pool.initialized && !exact) return null
  return {
    chainId: state.chainId,
    action: 'create',
    consent,
    pool: pool.pool,
    tickLower: state.range.lower,
    tickUpper: state.range.upper,
    inputs,
    slippageBps,
    ...(exact ? { initialPrice: { price: exact.price, baseToken: exact.baseToken, decimals0: exact.decimals0, decimals1: exact.decimals1, sqrtPriceX96: exact.sqrtPriceX96 } } : {}),
  }
}
