/**
 * Your APR (the owner, 2026-09-27): what ONE position's own fees earned, as a yearly rate on the money that was in it.
 * Not the pool's APR: this position's verified history (lib/fees), nothing else.
 *
 * Changed on purpose 2026-10-02 (RPC-SPEC §11.4: the history is the position's ledger, measured points only, no hourly
 * prices): every amount is valued at TODAY's pool price, the price the Fees earned hero and Position value use.
 *
 *   since opened:  the value of every fee earned (collected and still to collect) × YEAR
 *                  ÷ Σ (the value of the position's liquidity on each stretch × its length)
 *
 * The stretches run between the settlements that changed its liquidity (its mint, each add, Auto-compound's re-adds,
 * each withdrawal), timed by their blocks' headers, the last one to now; so liquidity added later counts only from when it
 * was added. The last 24 hours: the same, from a measured point 20 to 28 hours old (the one nearest a day), when the chart
 * has one; otherwise no figure. Since 2026-10-02 (the chart's periods back, lib/fees/periods.ts) that point is the card's
 * own 24H start (`periodStart`), one rule for both, and may be a read of the position a day ago (lib/fees/pastReads.ts).
 * Values are in USDG for a pair with USDG, else in the side `into`; the rate has no unit.
 * A historical figure, never a forecast. Available after the first measured positive interval, without a six-hour wait.
 * No elapsed time, usable price or capital exposure gives a reason instead of a rate; measured zero fees give zero APR.
 * Short intervals can move sharply and are explained by the tile's existing information tooltip. Pure and Node-safe.
 */
import type { FeeHistory, PositionState } from './fees/types'
import { PERIODS, periodStart } from './fees/periods'
import { aprDigitsOf } from './format/apr'

/** The Fees earned card's two windows: the last 24 hours, and since the position was opened. */
export type AprWindow = '24h' | 'all'
/** Why there is no rate: no elapsed interval, usable price, capital exposure, usable arithmetic or point a day ago. */
export type AprMissing = 'short' | 'no_price' | 'empty' | 'unavailable' | 'no_point'
/** `from`: where the window starts, its time (Unix seconds) and its block (2026-10-02: the tile's line says so in its title). */
export type PositionApr = { ok: true; rate: number; seconds: number; from: { t: number; block: number } } | { ok: false; reason: AprMissing; seconds: number }

const HOUR = 3_600
const DAY = 86_400
const YEAR = 365 * DAY
/** Chain timestamps are whole seconds: zero elapsed time cannot be annualised. No additional waiting period. */
export const APR_MIN_SECONDS = 1
/** The last 24 hours start at a measured point this old, at the least and at the most: the card's 24H window. */
export const DAY_POINT_SECONDS = PERIODS['24h'].window
const Q96 = 2 ** 96

/**
 * The position's APR over `window`, at the pool's price now (`state.sqrtPriceX96`). `into`: the side values are in (USDG's
 * side of a pair with USDG, else the quote side).
 */
export function positionApr(
  history: Pick<FeeHistory, 'mintedAt' | 'points' | 'events' | 'earned'>,
  state: Pick<PositionState, 'tickLower' | 'tickUpper' | 'currencies' | 'sqrtPriceX96' | 'timestamp'>,
  into: 0 | 1,
  window: AprWindow,
): PositionApr {
  const end = history.points.length > 0 ? history.points[history.points.length - 1].t : state.timestamp
  let from = history.mintedAt.timestamp
  let block = history.mintedAt.block
  let before: readonly [bigint, bigint] = [0n, 0n]
  if (window === '24h') {
    // The card's 24H start: the measured point nearest a day before the end, 20 to 28 hours old. A position opened less
    // than 20 hours ago starts its 24H at its mint, which says no more than since opened: no figure for the line.
    const day = periodStart(history, '24h')
    if (!day || end - day.t < DAY_POINT_SECONDS.min || end - day.t > DAY_POINT_SECONDS.max) return { ok: false, reason: 'no_point', seconds: 0 }
    from = day.t
    block = day.block
    before = day.earned
  }
  const seconds = Math.max(0, end - from)
  if (!Number.isFinite(seconds)) return { ok: false, reason: 'unavailable', seconds: 0 }
  if (seconds < APR_MIN_SECONDS) return { ok: false, reason: 'short', seconds }
  const [d0, d1] = [state.currencies[0].decimals, state.currencies[1].decimals]
  const sqrtP = Number(state.sqrtPriceX96) / Q96
  if (d0 === null || d1 === null || ![d0, d1].every((d) => Number.isInteger(d) && d >= 0 && d <= 255) || !Number.isFinite(sqrtP) || !(sqrtP > 0)) return { ok: false, reason: 'no_price', seconds }
  // The other side's price in whole tokens of `into`, now.
  const price = sqrtP * sqrtP * Math.pow(10, d0 - d1)
  const value = (a0: number, a1: number) => (into === 1 ? a1 + a0 * price : a0 + a1 / price)
  const sqrtA = Math.pow(1.0001, state.tickLower / 2)
  const sqrtB = Math.pow(1.0001, state.tickUpper / 2)
  if (![price, sqrtA, sqrtB].every((n) => Number.isFinite(n) && n > 0) || sqrtA >= sqrtB) return { ok: false, reason: 'no_price', seconds }
  const p = Math.min(Math.max(sqrtP, sqrtA), sqrtB)
  const worth = (liquidity: bigint) => value((Number(liquidity) * (sqrtB - p)) / (p * sqrtB) / 10 ** d0, (Number(liquidity) * (p - sqrtA)) / 10 ** d1)

  // The liquidity on each stretch from `from` to `end`, changing at each settlement.
  if (history.events.some((event) => !Number.isFinite(event.timestamp))) return { ok: false, reason: 'unavailable', seconds }
  const events = [...history.events].sort((a, b) => a.timestamp - b.timestamp || a.block - b.block)
  let liquidity = 0n
  let t = from
  let weighted = 0
  for (const event of events) {
    if (event.timestamp > end) break
    const at = Math.max(from, event.timestamp)
    if (at > t) weighted += worth(liquidity) * (at - t)
    t = at
    liquidity += event.liquidityDelta
    if (liquidity < 0n) return { ok: false, reason: 'unavailable', seconds }
  }
  weighted += worth(liquidity) * Math.max(0, end - t)
  const amounts = [history.earned[0] - before[0], history.earned[1] - before[1]]
  const earned = value(Number(amounts[0]) / 10 ** d0, Number(amounts[1]) / 10 ** d1)
  if (amounts.some((amount) => amount < 0n) || !Number.isFinite(weighted) || !Number.isFinite(earned)) return { ok: false, reason: 'unavailable', seconds }
  if (!(weighted > 0)) return { ok: false, reason: 'empty', seconds }
  const rate = (earned * YEAR) / weighted
  // Never turn an overflow, underflow or unusable denominator into a zero or an infinite advertised return.
  if (!Number.isFinite(rate * 100) || (rate === 0 && amounts.some((amount) => amount > 0n))) return { ok: false, reason: 'unavailable', seconds }
  return { ok: true, rate, seconds, from: { t: from, block } }
}

/**
 * A rate as a person reads it: one decimal under 100 %, whole percents from there, and "<0.1%" for a sliver: the one
 * APR rule of every screen (lib/format/apr.ts, audit E21). Rounded first, then sized (audit E8, 2026-10-01): a rate of
 * 99.96% read "100.0%", and now reads "100%".
 */
export function aprText(rate: number): string {
  return rate === 0 ? '0%' : `${aprDigitsOf(rate * 100)}%`
}

/** Why there is no rate, in a few plain words. */
export const APR_MISSING: Readonly<Record<AprMissing, string>> = {
  short: 'Waiting for the first reading',
  no_price: 'No price to measure it',
  empty: 'Nothing in the position',
  unavailable: 'Not measured yet',
  no_point: 'Not measured a day ago',
}

/** How long a measured window is: do not describe a position seconds or minutes old as an hour old. */
export function spanText(seconds: number): string {
  const hours = Math.max(1, Math.round(seconds / HOUR))
  const [n, unit] = seconds < 60 ? [Math.max(0, Math.floor(seconds)), 'second']
    : seconds < HOUR ? [Math.floor(seconds / 60), 'minute']
      : hours < 48 ? [hours, 'hour'] : [Math.round(seconds / DAY), 'day']
  return `${n} ${unit}${n === 1 ? '' : 's'}`
}
