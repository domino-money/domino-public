import { USDG } from '../../config/mainTokens'
import { parseScaled, scaledText } from '../../lib/format/decimal'
import { PRICE_SCALE, priceFromSqrtIn } from '../../lib/format/price'
import { usdgValue } from '../../lib/format/usd'
import type { JourneyState, TickRange } from '../../lib/create/journey'
import { reviewPlan, type ReviewPlan } from '../../lib/create/reviewPlan'
import { formatUnits } from '../../lib/read/decimal'
import { boundPrice, rangePosition, shownPrice, shownRange, usableTicks, type PoolPrice } from '../../lib/read/screens/poolRange'
import type { PoolOption } from '../../lib/read/screens/poolsList'
import type { PairBalancesState } from './usePairBalances'

/*
 * What the New position preview and the steps draw from the Journey state
 * (DESIGN-V2 §10.1, §6.2): a range as prices on the pool's own axis, the two
 * amounts the position holds, and their USD value when one side of the pair
 * is USDG. Module helpers, so every bigint stays out of render. Nothing here
 * reads, and nothing here invents: a missing input is null, never a guess.
 */

type Usable = Extract<PoolPrice, { state: 'usable' }>

/**
 * A range as the preview draws it: prices as the page writes them (the app's one way round, lib/read/orientation.ts,
 * 2026-09-28: `base` in `quote`, lowest first), 0 and Infinity at the pool's tick limits.
 */
export interface RangeView {
  lower: number
  upper: number
  /** The pool's price from its own `sqrtPriceX96`; null when it cannot be written. */
  current: number | null
  inRange: boolean
  /** The texts the range step already writes: `≈0.430178`, or its words beyond display. */
  lowerText: string | null
  upperText: string | null
  /** The pool's tick and the range's two ends in the page's frame (poolRange.ts shownRange), for their distances. */
  ticks: { pool: number; lower: number; upper: number }
}

/** The price at a tick of the page's frame (`shown` is shownPrice's): its `base` in its `quote`. */
const tickPrice = (tick: number, shown: Usable) => Math.pow(1.0001, tick) * Math.pow(10, shown.decimals[0] - shown.decimals[1])

/** The pool's price as a number for drawing only, from the exact decimal `priceFromSqrt` writes, the page's way round. */
function currentPrice(pool: PoolOption, price: Usable): number | null {
  try {
    const value = parseFloat(priceFromSqrtIn(BigInt(pool.sqrtPriceX96), price.decimals[0], price.decimals[1], price.inverted === true))
    return Number.isFinite(value) && value > 0 ? value : null
  } catch {
    return null
  }
}

export function rangeView(range: TickRange, price: Usable, pool: PoolOption): RangeView {
  const { min, max } = usableTicks(price.tickSpacing)
  const shown = shownPrice(price)
  const view = shownRange(range, price.inverted === true)
  return {
    lower: view.lower <= min ? 0 : tickPrice(view.lower, shown),
    upper: view.upper >= max ? Infinity : tickPrice(view.upper, shown),
    current: currentPrice(pool, price),
    inRange: rangePosition(range, price.tick) === 'inside',
    lowerText: boundPrice(view.lower, shown),
    upperText: boundPrice(view.upper, shown),
    ticks: { pool: shown.tick, lower: view.lower, upper: view.upper },
  }
}

/**
 * Which side of the pair is USDG (0 or 1), or null: USD is shown for USDG pairs only (§0.7). Changed on purpose 2026-10-06:
 * and for a pool on Base or Arbitrum One that carries its qualified prices (`usdPrices`, `qualifiedUsd` below).
 */
export function usdgSide(pool: PoolOption): 0 | 1 | null {
  const usdg = USDG
  if (pool.currencies[0].address.toLowerCase() === usdg) return 0
  if (pool.currencies[1].address.toLowerCase() === usdg) return 1
  return null
}

/**
 * Added 2026-10-06 (rugged97's delta of 5 Oct, item 4): the USD value of raw amounts at the qualified prices Domino's service
 * read for a pool on Base or Arbitrum One (PoolOption `usdPrices`, 18 decimals), each term rounded down; null when an amount
 * above zero has no price or no decimals (a dash, never a zero), or when the pool carries no prices.
 */
function qualifiedUsd(pool: PoolOption, amounts: readonly [bigint, bigint]): string | null {
  const prices = pool.usdPrices
  if (!prices) return null
  let total = 0n
  for (const index of [0, 1] as const) {
    const raw = amounts[index]
    if (raw === 0n) continue
    const price = prices[index] === null ? null : parseScaled(prices[index] as string)
    const decimals = pool.currencies[index].decimals
    if (!price || price.units < 0n || decimals === null || raw < 0n) return null
    total += (raw * price.units * 10n ** BigInt(PRICE_SCALE)) / (10n ** BigInt(price.scale + decimals))
  }
  return scaledText(total, PRICE_SCALE)
}

/**
 * The USD value of raw amounts of the pool's two currencies at the pool's own price, 1 USDG = $1; null for any other pair.
 * Changed on purpose 2026-10-06: a pool on Base or Arbitrum One with its qualified prices is valued at them (`qualifiedUsd`).
 */
export function usdOf(pool: PoolOption, amounts: readonly [bigint, bigint]): string | null {
  const side = usdgSide(pool)
  const [d0, d1] = [pool.currencies[0].decimals, pool.currencies[1].decimals]
  if (side === null) return qualifiedUsd(pool, amounts)
  if (d0 === null || d1 === null) return null
  try {
    return usdgValue({ amounts, decimals: [d0, d1], usdgIndex: side, sqrtPriceX96: BigInt(pool.sqrtPriceX96) })
  } catch {
    return null
  }
}

/** The USD value of one raw amount of one of the pool's currencies (a raw string, as the amount step holds it). */
export function usdOfSide(pool: PoolOption, side: 0 | 1, raw: string | null): string | null {
  if (raw === null || !/^\d+$/.test(raw)) return null
  const amount = BigInt(raw)
  return usdOf(pool, side === 0 ? [amount, 0n] : [0n, amount])
}

/** The raw balances the read service reported for the pool's two tokens, in pool order, or null until it answered. */
export const rawBalances = (balances: PairBalancesState): readonly [string | null, string | null] | null =>
  balances.status === 'ready' && balances.balances ? [balances.balances[0].raw, balances.balances[1].raw] : null

/** One side of the position, as the amount step and Review write it. */
export interface HeldSide {
  /** The amount in whole tokens, grouped (`9.004652116466694467`, `3,797,063,508`). */
  text: string
  /** Its USD value (USDG pairs only), or null. */
  usd: string | null
}

export interface Held {
  sides: readonly [HeldSide, HeldSide]
  /** Both sides together, when both are valued. */
  total: string | null
  /** The one-token plan's amounts after its swap: estimates, before the pool's price impact. */
  estimate: boolean
  /** The one-token plan's deposit, what Review says comes "From your wallet": its side and amount; null for any other plan. */
  wallet: { side: 0 | 1; text: string } | null
  /**
   * The one token the position holds, when it holds one alone (a range wholly above or below the price, or a deposit
   * swapped whole for the token such a range takes, 2026-09-28): the steps and the picture name that token alone, never
   * "0" of the other. Null when it holds both.
   */
  only: 0 | 1 | null
}

const textOf = (raw: bigint, decimals: number | null) => {
  const units = formatUnits(raw.toString(), decimals)
  return units && units.kind === 'units' ? units.text : raw.toString()
}

/**
 * What the position holds of each token, raw, in pool order, by Review's plan: the typed amount and the one the range
 * pairs with it; when the wallet funds it from one token, the amounts after the swap (the deposit less what is swapped,
 * and what that buys). Added 2026-10-06 (the final check's F4, a second look; no change of behaviour here): the one
 * reading heldAmounts below and Domino V2's Review before its quote has figures (src/v2in/journey/JourneyCreateV2.tsx)
 * both write, so Review's headline never says more than the amount step's row above it.
 */
export function heldRaw(planned: Pick<ReviewPlan, 'need' | 'plan'>): readonly [bigint, bigint] {
  const plan = planned.plan
  if (!plan || plan.kind !== 'swap') return planned.need
  const kept = plan.deposit - plan.swap
  return plan.from === 0 ? [kept, plan.receive] : [plan.receive, kept]
}

/**
 * What the position holds, in pool order: the typed amount and the one the
 * range pairs with it, exactly the amount step's two figures. When the wallet
 * funds it from one token, the amounts after the swap instead, on every step,
 * as Review's headline says them: the paired need would be more than the
 * wallet holds and never what is deposited. Null while a choice is missing.
 */
export function heldAmounts(state: JourneyState, balances: PairBalancesState): Held | null {
  const pool = state.pool
  if (!pool) return null
  const planned = reviewPlan(state, rawBalances(balances))
  if (!planned) return null
  const plan = planned.plan
  const amounts = heldRaw(planned)
  let estimate = false
  let wallet: Held['wallet'] = null
  if (plan && plan.kind === 'swap') {
    estimate = true
    wallet = { side: plan.from, text: textOf(plan.deposit, pool.currencies[plan.from].decimals) }
  }
  const side = (index: 0 | 1): HeldSide => ({
    text: textOf(amounts[index], pool.currencies[index].decimals),
    usd: usdOf(pool, index === 0 ? [amounts[0], 0n] : [0n, amounts[1]]),
  })
  const only = amounts[0] === 0n && amounts[1] > 0n ? 1 : amounts[1] === 0n && amounts[0] > 0n ? 0 : null
  return { sides: [side(0), side(1)], total: usdOf(pool, amounts), estimate, wallet, only }
}

