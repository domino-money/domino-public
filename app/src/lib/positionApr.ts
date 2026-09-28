/**
 * Your APR (the owner, 2026-09-27): what ONE position's own fees earned, as a yearly rate on the money that was in it.
 * Not the pool's APR: this position's history (lib/fees, verified or estimated), nothing else.
 *
 * The rate is the fees earned in the window (collected and still to collect, each hour's fees valued at that hour's
 * closing pool price) over the time-weighted value of the position in the same window (its liquidity, as every mint,
 * increase, decrease and close changed it, valued at each hour's closing price), annualised over 365 days:
 *
 *   rate = earned × YEAR / ∑ value × seconds
 *
 * so liquidity added later (an Increase, an Auto-compound) counts only from when it was added. Values are in USDG for
 * a pair with USDG, else in the side `into`; the rate has no unit, so either gives the same figure. A historical
 * figure, never a forecast. Honest when it cannot be said: under six hours of history, no price, nothing in the
 * position, or nothing earned give a reason instead of a rate. Plain numbers: a rate, not an amount anyone is paid.
 * Pure and Node-safe.
 */
import type { FeeHistory, PositionState } from './fees/types'

/** The Fees earned card's two windows: the last 24 hours, and since the position was opened. */
export type AprWindow = '24h' | 'all'
/** Why there is no rate: too little history, no usable price, nothing in the position, nothing earned. */
export type AprMissing = 'short' | 'no_price' | 'empty' | 'zero'
export type PositionApr = { ok: true; rate: number; seconds: number } | { ok: false; reason: AprMissing; seconds: number }

const HOUR = 3_600
const DAY = 86_400
const YEAR = 365 * DAY
/** Less history than this gives no rate: a few hours of fees annualised say nothing about a year. */
export const APR_MIN_SECONDS = 6 * HOUR
const Q96 = 2 ** 96

/**
 * The position's APR over `window`. `into`: the side values are in (USDG's side of a pair with USDG, else the quote
 * side). The 24-hour window starts at the end of the last hour at least a day before the history's end, so its fees
 * and its capital cover the same hours.
 */
export function positionApr(
  history: Pick<FeeHistory, 'mintedAt' | 'hourly' | 'events'>,
  state: Pick<PositionState, 'tickLower' | 'tickUpper' | 'currencies'>,
  into: 0 | 1,
  window: AprWindow,
): PositionApr {
  const { hourly } = history
  const end = hourly.length > 0 ? hourly[hourly.length - 1].t : history.mintedAt.timestamp
  let first = 0
  if (window === '24h') while (first < hourly.length && hourly[first].t <= end - DAY) first++
  const from = first > 0 ? hourly[first - 1].t : history.mintedAt.timestamp
  const seconds = Math.max(0, end - from)
  if (seconds < APR_MIN_SECONDS) return { ok: false, reason: 'short', seconds }
  const [d0, d1] = [state.currencies[0].decimals, state.currencies[1].decimals]
  if (d0 === null || d1 === null) return { ok: false, reason: 'no_price', seconds }

  const sqrtA = Math.pow(1.0001, state.tickLower / 2)
  const sqrtB = Math.pow(1.0001, state.tickUpper / 2)
  const events = [...history.events].sort((a, b) => a.timestamp - b.timestamp)
  let next = 0
  let liquidity = 0
  // The liquidity when the window opens.
  for (; next < events.length && events[next].timestamp <= from; next++) liquidity = Math.max(0, liquidity + Number(events[next].liquidityDelta))
  let before = first > 0 ? hourly[first - 1].earned : ([0n, 0n] as const)
  let t = from
  let weighted = 0
  let earned = 0
  for (let i = first; i < hourly.length; i++) {
    const hour = hourly[i]
    const sqrtP = Number(hour.sqrtPriceX96Close) / Q96
    if (!(sqrtP > 0)) return { ok: false, reason: 'no_price', seconds }
    // The other side's price in whole tokens of `into`, at this hour's close.
    const price = sqrtP * sqrtP * Math.pow(10, d0 - d1)
    const value = (a0: number, a1: number) => (into === 1 ? a1 + a0 * price : a0 + a1 / price)
    const p = Math.min(Math.max(sqrtP, sqrtA), sqrtB)
    const worth = () => value((liquidity * (sqrtB - p)) / (p * sqrtB) / 10 ** d0, (liquidity * (p - sqrtA)) / 10 ** d1)
    // The hour in pieces, one per liquidity it held.
    for (; next < events.length && events[next].timestamp <= hour.t; next++) {
      const at = Math.max(t, events[next].timestamp)
      weighted += worth() * (at - t)
      t = at
      liquidity = Math.max(0, liquidity + Number(events[next].liquidityDelta))
    }
    weighted += worth() * Math.max(0, hour.t - t)
    t = Math.max(t, hour.t)
    earned += value(Number(hour.earned[0] - before[0]) / 10 ** d0, Number(hour.earned[1] - before[1]) / 10 ** d1)
    before = hour.earned
  }
  if (!(weighted > 0)) return { ok: false, reason: 'empty', seconds }
  if (!(earned > 0)) return { ok: false, reason: 'zero', seconds }
  return { ok: true, rate: (earned * YEAR) / weighted, seconds }
}

/** A rate as a person reads it: one decimal under 100 %, whole percents from there, and "<0.1%" for a sliver. */
export function aprText(rate: number): string {
  const percent = rate * 100
  if (percent < 0.05) return '<0.1%'
  if (percent < 100) return `${percent.toFixed(1)}%`
  return `${Math.round(percent).toLocaleString('en-US')}%`
}

/** Why there is no rate, in a few plain words. */
export const APR_MISSING: Readonly<Record<AprMissing, string>> = {
  short: 'Shows after 6 hours',
  no_price: 'No price to measure it',
  empty: 'Nothing in the position',
  zero: 'No fees earned yet',
}

/** How long a window is, as a person says it: hours under two days, days after. */
export function spanText(seconds: number): string {
  const hours = Math.max(1, Math.round(seconds / HOUR))
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`
  return `${Math.round(seconds / DAY)} days`
}
