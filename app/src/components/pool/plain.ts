import { USDG } from '../../config/mainTokens'
import { quoteIndex } from '../../lib/read/orientation'
import { tickPriceText } from '../../lib/read/screens/positions'
import { numberFormat } from '../../lib/format/numberFormat'
import { APR_SLIVER, aprDigitsOf } from '../../lib/format/apr'

/*
 * The pool page in plain words (round 6, the owner: "Domino is for people who know nothing about liquidity pools"):
 * which way a price is written, a yearly rate said as a person says it, what an amount could earn at the pool's recent
 * rate, and a typical range as two prices. Pure functions of what the page already read; nothing here reads, and no
 * figure is made up: every number comes from the pool's own figures.
 */

/**
 * The side a person prices the pool in, the app's one rule (lib/read/orientation.ts): USDG where the pool holds it,
 * so "1 PONS = 0.62 USDG" reads as a dollar price, then ETH; otherwise the pool's own order (its second token per its
 * first). Changed on purpose 2026-09-28 (one-sided): a pool of ETH and another token is priced in ETH, as every screen
 * now writes it.
 */
export function quoteSide(currencies: readonly [{ address: string }, { address: string }]): 0 | 1 {
  return quoteIndex(currencies[0].address, currencies[1].address)
}

/** Whether an address is USDG's, the one token the page values at $1. */
export const isUsdg = (address: string) => address.toLowerCase() === USDG

/** A price with no "≈": the page writes plain figures, the exact value in a title. */
export const plainPrice = (text: string) => (text.startsWith('≈') ? text.slice(1) : text)

/** The price at `tick` written as `quote` per the other token, six significant digits; null when it cannot be written. */
export function priceAt(tick: number, decimals: readonly [number, number], quote: 0 | 1): string | null {
  const text = quote === 1 ? tickPriceText(tick, decimals[0], decimals[1]) : tickPriceText(-tick, decimals[1], decimals[0])
  return text === null ? null : plainPrice(text)
}

/** A decimal string as a number, or null. */
export function numberOf(text: string | null | undefined): number | null {
  if (text === null || text === undefined) return null
  const value = Number(text.replace(/[,\s$]/g, ''))
  return Number.isFinite(value) ? value : null
}

/**
 * A yearly rate as a person says it: "27.2%", "1,428%", "less than 0.1%". The one APR rule of every screen
 * (lib/format/apr.ts, audit E21, 2026-10-01), so the sentence says the figure the APR tile beside it shows.
 */
export function aboutPercent(value: number): string {
  if (!(value > 0)) return '0%'
  return aboutDigits(aprDigitsOf(value))
}

/**
 * The same, from the digits the APR tile itself shows (QA round 2, N8): the tile rounds the read service's decimal and
 * this sentence used to round its number again, so "38.8% est." sat over "about 38.9% a year". The tile's digits now go
 * into the sentence as they are; the figure and its formula are unchanged (D9).
 */
export function aboutDigits(digits: string): string {
  return digits === APR_SLIVER ? 'less than 0.1%' : `${digits}%`
}

/** The largest amount the estimate takes, in dollars. */
export const AMOUNT_LIMIT = 1e9

/**
 * An amount typed in dollars ("1,000", "$250.5"), or null when it is not one. At most a billion. Changed on purpose
 * 2026-10-30 (QA round 2, Q21): a comma before one or two last digits is a decimal comma ("1000,50", "1,5"), never a
 * thousands comma, so it is not an amount here; it used to be read as 100050 and 15, an estimate 100 or 10 times too high.
 */
export function parseAmount(text: string): number | null {
  if (/,\d{1,2}(?!\d)/.test(text)) return null
  const clean = text.replace(/[,\s$]/g, '')
  if (!/^\d{1,10}(\.\d{0,2})?$/.test(clean)) return null
  const value = Number(clean)
  return value > 0 && value <= AMOUNT_LIMIT ? value : null
}

/**
 * Why typed text is not an amount, where that can be said (QA round 2, Q21): written with a decimal comma or a dot for
 * thousands, or with more than two decimals ("1.000,50", "1000,50", "1.000", "10.125": `format`); above the limit
 * (`large`); zero or below (`small`). Null for anything else, and for text parseAmount takes.
 */
export function amountProblem(text: string): 'format' | 'large' | 'small' | null {
  const bare = text.replace(/[\s$]/g, '')
  if (bare === '' || parseAmount(text) !== null) return null
  if (/^[-−]/.test(bare)) return 'small'
  if (/,\d{1,2}$/.test(bare) || /\.\d{3,}/.test(bare)) return 'format'
  const digits = bare.replace(/,/g, '')
  if (!/^\d+(\.\d*)?$/.test(digits)) return null
  const value = Number(digits)
  return value > AMOUNT_LIMIT ? 'large' : value > 0 ? null : 'small'
}

/**
 * What `amount` dollars could earn per day, month and year at the pool's yearly rate `aprPercent`, no compounding. The
 * rate is the pool's fees over the money in it (`tvl`): money added shares the same fees, amount / (TVL + amount) of
 * them (round 6 review: $10,000 in a $13.4K pool at 181% earns about $10.4K a year, not $18.1K). No TVL, the plain rate.
 */
export function earnings(amount: number, aprPercent: number, tvl: number | null = null) {
  const year = tvl !== null && tvl > 0 ? ((aprPercent / 100) * tvl * amount) / (tvl + amount) : (amount * aprPercent) / 100
  return { day: year / 365, month: year / 12, year }
}

/** Dollars as the estimate writes them: cents below $1,000, whole dollars above, "less than $0.01" for a crumb. */
export function usdText(value: number): string {
  if (value > 0 && value < 0.01) return 'less than $0.01'
  return numberFormat({ style: 'currency', currency: 'USD', maximumFractionDigits: value >= 1000 ? 0 : 2, minimumFractionDigits: value >= 1000 ? 0 : 2 }).format(value)
}

/** A signed distance from the price now, "−30%" or "+50%", as the range guide says it. */
export function distanceText(ratio: number): string {
  const percent = (ratio - 1) * 100
  const rounded = Math.abs(percent) < 0.5 ? 0 : Math.round(percent)
  return rounded === 0 ? '0%' : `${rounded > 0 ? '+' : '−'}${Math.abs(rounded)}%`
}

export interface RangeGuide {
  /** The range's two ends, low then high, as `quote` per the other token. */
  low: string
  high: string
  /** How far each end is from the price now, "−30%" and "+50%". */
  below: string
  above: string
  /** The price now and both ends as numbers, for the drawing only. */
  values: { now: number; low: number; high: number }
}

/**
 * A range (two ticks) as a person reads it: its two ends as prices in the page's direction, low first, and how far
 * each is from the price now. When the page writes prices the other way round from the pool (USDG first in the pool),
 * the pool's upper tick is the low end.
 */
export function rangeGuide(range: { lower: number; upper: number }, tick: number, decimals: readonly [number, number], quote: 0 | 1): RangeGuide | null {
  const [lowTick, highTick] = quote === 1 ? [range.lower, range.upper] : [range.upper, range.lower]
  const low = priceAt(lowTick, decimals, quote)
  const high = priceAt(highTick, decimals, quote)
  const now = priceAt(tick, decimals, quote)
  if (low === null || high === null || now === null) return null
  const sign = quote === 1 ? 1 : -1
  const ratio = (end: number) => Math.pow(1.0001, sign * (end - tick))
  const values = { now: numberOf(now) ?? 0, low: numberOf(low) ?? 0, high: numberOf(high) ?? 0 }
  if (!(values.now > 0 && values.low > 0 && values.high > values.low)) return null
  return { low, high, below: distanceText(ratio(lowTick)), above: distanceText(ratio(highTick)), values }
}

/** Where `value` sits between `from` and `to` on a log scale, 0 to 1 (clamped). */
export function logShare(value: number, from: number, to: number): number {
  if (!(value > 0 && from > 0 && to > from)) return 0.5
  const share = (Math.log(value) - Math.log(from)) / (Math.log(to) - Math.log(from))
  return Math.min(1, Math.max(0, share))
}

/** The last day's prices as the chart read them: its low, its high and its first and last close, in the page's direction. */
export interface DaySpan {
  /** The token the prices are for (the chart's base), so a flipped chart is never read the other way round. */
  base: string
  low: string
  high: string
  first: string
  last: string
  /** Whether the first hour opens the day, so a change from it is the whole day's. */
  whole: boolean
}

/** The part of a history the last day's span reads: its hourly candles and the window they were asked for. */
interface DayHistory {
  candles: ReadonlyArray<{ startTimestamp: number; high: string; low: string; close: string }>
  requestedWindow: { startTimestamp: number }
  resolutionSeconds: number
}

/** A 24-hour history as the range guide and the activity summary read it: its low and high, its first and last close. */
export function daySpan(data: DayHistory, base: string): DaySpan | null {
  const candles = data.candles
  const lows = candles.map((candle) => Number(candle.low)).filter((value) => value > 0)
  const highs = candles.map((candle) => Number(candle.high)).filter((value) => value > 0)
  if (!candles.length || !lows.length || !highs.length) return null
  return {
    base,
    low: String(Math.min(...lows)),
    high: String(Math.max(...highs)),
    first: candles[0].close,
    last: candles[candles.length - 1].close,
    whole: candles.length > 1 && candles[0].startTimestamp - data.requestedWindow.startTimestamp <= data.resolutionSeconds,
  }
}

/** "rose 3.2%", "fell 8.7%" or "barely moved" between two prices. */
export function moveWords(from: number, to: number): string {
  if (!(from > 0 && to > 0)) return 'barely moved'
  const percent = ((to - from) / from) * 100
  if (Math.abs(percent) < 0.1) return 'barely moved'
  const text = numberFormat({ maximumFractionDigits: Math.abs(percent) < 10 ? 1 : 0 }).format(Math.abs(percent))
  return `${percent > 0 ? 'rose' : 'fell'} ${text}%`
}

/** A count as words read it: "5,799". */
export const countText = (value: number) => numberFormat().format(value)

/** A USD figure written short, "$18.8K", "$6.2M", for a sentence. */
export function usdShort(value: number): string {
  if (!(value >= 0)) return '$0'
  if (value < 1000) return usdText(value)
  return `$${numberFormat({ notation: 'compact', maximumFractionDigits: 1 }).format(value)}`
}
