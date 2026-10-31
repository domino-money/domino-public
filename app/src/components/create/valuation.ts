import { USDG } from '../../config/mainTokens'
import { CREATE } from '../../lib/create/copy'
import { align, parseScaled, scaledText, type Scaled } from '../../lib/format/decimal'
import { PRICE_SCALE, priceFromSqrtIn, valueIn } from '../../lib/format/price'
import { formatUsd, usdgValue } from '../../lib/format/usd'
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
 * is USDG (since 2026-10-06 also at the qualified prices a pool carries,
 * `usdOf`). Module helpers, so every bigint stays out of render. Nothing here
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

/**
 * One end's price as the steps write it, in the page's frame (`price` is shownPrice's): 0 or ∞ at the pool's usable tick
 * limit on its side, as a position's card writes a full-range end (lib/read/screens/positions.ts rangeEnd), else the
 * figure (`boundPrice`, null beyond display). Added 2026-10-30 (QA round 2, N73: Full range).
 */
export function endPrice(tick: number, which: 'lower' | 'upper', price: Usable): string | null {
  const { min, max } = usableTicks(price.tickSpacing)
  if (which === 'lower' ? tick <= min : tick >= max) return which === 'lower' ? '0' : '∞'
  return boundPrice(tick, price)
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
    lowerText: endPrice(view.lower, 'lower', shown),
    upperText: endPrice(view.upper, 'upper', shown),
    ticks: { pool: shown.tick, lower: view.lower, upper: view.upper },
  }
}

/**
 * Which side of the pair is USDG (0 or 1), or null: USD is shown for USDG pairs only (§0.7). Changed on purpose 2026-10-06:
 * and for a pool on Base or Arbitrum One that carries its qualified prices (`usdPrices`, `qualifiedUsd` below).
 * Changed on purpose 2026-10-06 (the owner: "USD estimate unavailable" on ETH/CASHCAT, AI/PONS and CASHCAT/AI: "when it is
 * two coins that are not USD, USDG, ETH and the like, the price isn't fetched"): §0.7 no longer limits it to USDG pairs.
 * A Robinhood Chain pool without USDG carries its currencies' qualified prices too, as Domino's service reads them
 * (read-v6 chain-pools: the owner's decision #22, F7 §6.3; ./usePricedPool.ts), and is valued as a pool on Base or
 * Arbitrum One is (`qualifiedUsd`). A USDG pair is valued as before.
 */
export function usdgSide(pool: PoolOption): 0 | 1 | null {
  const usdg = USDG
  if (pool.currencies[0].address.toLowerCase() === usdg) return 0
  if (pool.currencies[1].address.toLowerCase() === usdg) return 1
  return null
}

/** A qualified price as the pool carries it (18 decimals), when there is one above zero. */
function priceOfSide(prices: readonly [string | null, string | null], index: 0 | 1) {
  const text = prices[index]
  const price = text === null ? null : parseScaled(text)
  return price && price.units > 0n ? price : null
}

/** `raw` units of a token with `decimals` at `price` USD per whole token, at PRICE_SCALE, rounded down; null without decimals. */
const atPrice = (raw: bigint, decimals: number | null, price: Scaled): bigint | null =>
  decimals === null || raw < 0n ? null : (raw * price.units * 10n ** BigInt(PRICE_SCALE)) / 10n ** BigInt(price.scale + decimals)

/**
 * Added 2026-10-06 (the amount paid with one other token, ./PairedAmounts.tsx): `raw` units (a raw integer string, as the
 * amount step holds it) of a token at its qualified `price` (USD per whole token, 18 decimals), rounded down; null without
 * a price or decimals (never a zero, never a guess).
 */
export function usdAt(raw: string, decimals: number | null, price: string | null): string | null {
  const scaled = priceOfSide([price, null], 0)
  const value = scaled && atPrice(BigInt(raw), decimals, scaled)
  return value == null ? null : scaledText(value, PRICE_SCALE)
}

/**
 * Added 2026-10-06 (rugged97's delta of 5 Oct, item 4): the USD value of raw amounts at the qualified prices Domino's service
 * read for a pool on Base or Arbitrum One (PoolOption `usdPrices`, 18 decimals), each term rounded down; null when an amount
 * above zero has no price or no decimals (a dash, never a zero), or when the pool carries no prices.
 * Changed on purpose 2026-10-06 (the owner: "USD estimate unavailable" for a pair whose second token has no qualified
 * price, such as a token with no deep pool against ETH or the dollar): when only ONE of the two has a qualified price and
 * the other side holds something, both amounts are valued in the priced one at this pool's own price (sqrtPriceX96), then
 * at its price, exactly the rule a USDG pair is valued by (`usdOf`: at the pool's own price, 1 USDG = $1). A side holding
 * nothing still needs neither a price nor its decimals (the review of 2026-10-06: an ETH panel beside a token whose
 * decimals could not be read keeps its figure). Null when neither has one, or when a decimals count the value needs is
 * unknown: never a zero, never a guess.
 */
function qualifiedUsd(pool: PoolOption, amounts: readonly [bigint, bigint]): string | null {
  const prices = pool.usdPrices
  if (!prices) return null
  const priced = [priceOfSide(prices, 0), priceOfSide(prices, 1)] as const
  // The one side priced, when the other side, unpriced, holds something.
  const lone = priced[0] ? (priced[1] || amounts[1] === 0n ? null : 0) : priced[1] && amounts[0] !== 0n ? 1 : null
  if (lone !== null) return atPoolPrice(pool, amounts, lone, priced[lone] as Scaled)
  let total = 0n
  for (const index of [0, 1] as const) {
    const raw = amounts[index]
    if (raw === 0n) continue
    const price = priced[index]
    const value = price && atPrice(raw, pool.currencies[index].decimals, price)
    if (value == null) return null
    total += value
  }
  return scaledText(total, PRICE_SCALE)
}

/**
 * Added 2026-10-06: both amounts in the priced side's units at the pool's own price (lib/format/price.ts valueIn, the one
 * a USDG pair's value is), at that side's USD price, rounded down; null when that side's decimals are unknown or the price
 * cannot be read. valueIn reads the decimals of the side it values into alone (the other side is converted in raw units at
 * the pool's price), so the unpriced side's own decimals are not needed (the review of 2026-10-06).
 */
function atPoolPrice(pool: PoolOption, amounts: readonly [bigint, bigint], side: 0 | 1, price: Scaled): string | null {
  const decimals = pool.currencies[side].decimals
  if (decimals === null || amounts[0] < 0n || amounts[1] < 0n) return null
  try {
    const value = parseScaled(valueIn({ amounts, decimals: [decimals, decimals], into: side, sqrtPriceX96: BigInt(pool.sqrtPriceX96) }))
    const usd = value && atPrice(value.units, value.scale, price)
    return usd == null ? null : scaledText(usd, PRICE_SCALE)
  } catch {
    return null
  }
}

/**
 * The USD value of raw amounts of the pool's two currencies at the pool's own price, 1 USDG = $1; null for any other pair.
 * Changed on purpose 2026-10-06: a pool on Base or Arbitrum One with its qualified prices is valued at them (`qualifiedUsd`).
 * Changed on purpose 2026-10-06 (the owner, see `usdgSide`): so is a Robinhood Chain pool without USDG, and a pool whose one
 * currency alone is priced is valued at its own price in that one (`qualifiedUsd`).
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
  /** Its USD value (`usdOf`), or null. */
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
  // Paid with one other token (2026-10-06, lib/create/journey.ts PayWith): what its swap buys is the plan's to say.
  if (!pool || state.payWith) return null
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
  const sides = [side(0), side(1)] as const
  return { sides, total: shownTotal(sides[0].usd, sides[1].usd) ?? usdOf(pool, amounts), estimate, wallet, only }
}

/** A USD value as the page writes it (formatUsd: cents from $1, four significant digits below), as a decimal again. */
const asShown = (usd: string): Scaled | null => parseScaled(formatUsd(usd).replace(/[$,]/g, ''))

/**
 * Added 2026-10-30 (QA round 2, Q22): the total as the two figures beside it are written, added exactly, so the lines
 * always add up to it (each rounded alone, then the exact sum rounded, drifted a cent: $1,160.62 + $1,031.93 under a
 * total of $2,192.54). Null unless both sides are valued; display only, nothing signed or sent reads it.
 */
export function shownTotal(first: string | null, second: string | null): string | null {
  const a = first === null ? null : asShown(first)
  const b = second === null ? null : asShown(second)
  if (!a || !b) return null
  const [x, y, scale] = align(a, b)
  return scaledText(x + y, scale)
}

/** The smallest deposit New position takes, in USD (QA round 2, N54, the owner's decision of 2026-10-29: US$ 1). */
export const MIN_DEPOSIT_USD = '1'

/** Whether a USD value is under the minimum deposit; false when it cannot be read (no value, no block). */
export function underMinimum(usd: string | null): boolean {
  const value = usd === null ? null : parseScaled(usd)
  const floor = parseScaled(MIN_DEPOSIT_USD)
  if (!value || !floor) return false
  const [x, y] = align(value, floor)
  return x < y
}

/**
 * Added 2026-10-30 (QA round 2, N51): the share of the pool a deposit of `totalUsd` would be, beside its reported TVL
 * (a USD decimal): total / (TVL + total), between 0 and 1. Null without both figures, or with a TVL that is not above
 * zero. The TVL is the whole pool's, so the share is approximate and is always said with "about".
 */
export function poolShare(tvlUsd: string | null, totalUsd: string | null): number | null {
  if (tvlUsd === null || totalUsd === null) return null
  const tvl = Number(tvlUsd)
  const total = Number(totalUsd)
  if (!Number.isFinite(tvl) || !Number.isFinite(total) || tvl <= 0 || total <= 0) return null
  return total / (tvl + total)
}

/**
 * The share as the page says it, "97%", only from 10% up (the owner's decision: a plain sentence above about 10%,
 * nothing below it); never "100%", since the pool keeps what it holds.
 */
export function poolShareWords(share: number | null): string | null {
  if (share === null) return null
  const percent = Math.min(99, Math.round(share * 100))
  return percent >= 10 ? `${percent}%` : null
}

/** Whether a deposit of `totalUsd` is more than everything the pool reports holding (Q20): false without both figures. */
export function beyondPool(tvlUsd: string | null, totalUsd: string | null): boolean {
  if (tvlUsd === null || totalUsd === null) return false
  const tvl = Number(tvlUsd)
  const total = Number(totalUsd)
  return Number.isFinite(tvl) && Number.isFinite(total) && tvl > 0 && total > tvl
}

/**
 * The one plain sentence said beside a deposit's total, on Amount and on Review alike (QA round 2 review, N51 and Q20): a
 * second look when it is more than the whole pool holds, else its share from about 10%, else nothing.
 */
export function poolSizeLine(tvlUsd: string | null, totalUsd: string | null): string | null {
  if (beyondPool(tvlUsd, totalUsd)) return CREATE.amount.beyondPool
  const words = poolShareWords(poolShare(tvlUsd, totalUsd))
  return words ? CREATE.amount.poolShare(words) : null
}

/** Whether a range covers every price the pool allows (its usable tick limits): New position's Full range (N73). */
export function coversFullRange(range: TickRange | null, tickSpacing: number): boolean {
  if (!range) return false
  const { min, max } = usableTicks(tickSpacing)
  return range.lower <= min && range.upper >= max
}

/** The pool's reported TVL as a USD decimal, when its figure carries one; null otherwise (never a zero, never a guess). */
export function reportedTvl(pool: PoolOption): string | null {
  const figure = pool.liquidity
  return figure.state === 'attributed' || figure.state === 'attributed_stale' ? figure.raw : null
}

