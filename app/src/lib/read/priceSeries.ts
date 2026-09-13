/**
 * The close-price series behind the token price chart: which of the
 * provider's candles fall inside a chosen window, how many hours they span,
 * where each close sits in SVG space, and the change from the window's first
 * open to its last close.
 *
 * Only SVG coordinates become Numbers. Every monetary value stays the exact
 * decimal string the provider returned, and the change is BigInt arithmetic
 * on those strings, rounded half to even like every figure in decimal.ts.
 * Nothing here fills a gap, smooths a value or invents a candle: a window is
 * a filter over what was returned, and no more.
 */
import type { Candle, HistoryData } from 'api-contracts/read-v1/types'
import { parseDecimal, type Decimal } from './decimal'

export interface Pad {
  top: number
  right: number
  bottom: number
  left: number
}

export interface AreaPoint {
  x: number
  y: number
  candle: Candle
}

export interface AreaGeometry {
  points: AreaPoint[]
  /** `M x y L x y …` through every close, in start order. */
  linePath: string
  /** The line closed down to the bottom edge, for the fill under it. */
  areaPath: string
  /** The highest close shown, as the provider wrote it. */
  high: string
  /** The lowest close shown, as the provider wrote it. */
  low: string
}

export interface WindowChange {
  sign: -1 | 0 | 1
  /** `+10.00%`, `−0.50%` or `0.00%`: two places, half to even. */
  percentText: string
  fromUsd: string
  toUsd: string
}

const pow10 = (n: number) => 10n ** BigInt(n)

/** The candles in start order. The array given is left as it is. */
export const byStart = (candles: ReadonlyArray<Candle>): Candle[] => [...candles].sort((a, b) => a.startTimestamp - b.startTimestamp)

/**
 * The returned candles whose interval lies within the last `hours` hours,
 * counted back from the end of the latest returned candle; all of them when
 * `hours` is null. A gap stays a gap and a missing candle stays missing.
 */
export function windowCandles(history: HistoryData, hours: number | null): Candle[] {
  const sorted = byStart(history.candles)
  if (hours === null || sorted.length === 0) return sorted
  const end = sorted[sorted.length - 1].startTimestamp + history.intervalSeconds
  const from = end - hours * 3600
  return sorted.filter((candle) => candle.startTimestamp >= from)
}

/** The span the returned candles actually cover, in hours: last end minus first start. Zero without candles. */
export function coverageHours(history: HistoryData): number {
  const sorted = byStart(history.candles)
  if (sorted.length === 0) return 0
  return (sorted[sorted.length - 1].startTimestamp + history.intervalSeconds - sorted[0].startTimestamp) / 3600
}

/** Every value brought to one scale, so they compare and subtract as integers. */
function aligned(values: ReadonlyArray<Decimal>): { scale: number; units: bigint[] } {
  const scale = Math.max(...values.map((value) => value.scale))
  return { scale, units: values.map((value) => value.coefficient * pow10(scale - value.scale)) }
}

/** Plain fixed-point text of an integer scaled by 10^places. */
function fixedText(units: bigint, places: number): string {
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(places + 1, '0')
  const whole = digits.slice(0, digits.length - places)
  const body = places > 0 ? `${whole}.${digits.slice(digits.length - places)}` : whole
  return negative ? `-${body}` : body
}

/** Integer division rounding half to even, for either sign. */
function divideHalfEven(numerator: bigint, divisor: bigint): bigint {
  const negative = numerator < 0n !== divisor < 0n
  const n = numerator < 0n ? -numerator : numerator
  const d = divisor < 0n ? -divisor : divisor
  let quotient = n / d
  const twice = (n % d) * 2n
  if (twice > d || (twice === d && quotient % 2n === 1n)) quotient += 1n
  return negative ? -quotient : quotient
}

/** Two places are enough for a path; the point keeps its full coordinate. */
const pathNumber = (n: number) => String(Math.round(n * 100) / 100)

/**
 * SVG coordinates for the close-price line inside a `width` × `height` box
 * with `pad` kept clear on each side. The highest close sits on the top
 * edge of the inner box and the lowest on its bottom edge; x is linear in
 * start time from the first candle to the last, so a gap in the returned
 * candles is a longer straight segment, never an added point. Null without
 * candles, or when a close is not a decimal string.
 */
export function areaGeometry(candles: ReadonlyArray<Candle>, width: number, height: number, pad: Pad): AreaGeometry | null {
  const sorted = byStart(candles)
  if (sorted.length === 0) return null
  const closes: Decimal[] = []
  for (const candle of sorted) {
    const close = parseDecimal(candle.closeUsd)
    if (!close) return null
    closes.push(close)
  }
  const { units } = aligned(closes)
  let highAt = 0
  let lowAt = 0
  units.forEach((value, index) => {
    if (value > units[highAt]) highAt = index
    if (value < units[lowAt]) lowAt = index
  })
  const high = units[highAt]
  const low = units[lowAt]
  const innerWidth = width - pad.left - pad.right
  const innerHeight = height - pad.top - pad.bottom
  const first = sorted[0].startTimestamp
  const span = sorted[sorted.length - 1].startTimestamp - first
  // Sub-pixel precision without leaving integers: scale by a thousand, divide, then place.
  const rise = BigInt(Math.round(innerHeight * 1000))
  const x = (timestamp: number) => (span === 0 ? pad.left + innerWidth / 2 : pad.left + ((timestamp - first) * innerWidth) / span)
  const y = (value: bigint) => (high === low ? pad.top + innerHeight / 2 : pad.top + innerHeight - Number(((value - low) * rise) / (high - low)) / 1000)
  const points = sorted.map((candle, index) => ({ x: x(candle.startTimestamp), y: y(units[index]), candle }))
  const linePath = points.map((point, index) => `${index === 0 ? 'M' : 'L'}${pathNumber(point.x)} ${pathNumber(point.y)}`).join(' ')
  const bottom = pathNumber(height - pad.bottom)
  const areaPath = `${linePath} L${pathNumber(points[points.length - 1].x)} ${bottom} L${pathNumber(points[0].x)} ${bottom} Z`
  return { points, linePath, areaPath, high: sorted[highAt].closeUsd, low: sorted[lowAt].closeUsd }
}

export interface BarGeometry {
  /** The bar's centre, on the same time scale as areaGeometry's points. */
  cx: number
  /** Left edge: cx − width / 2. */
  x: number
  /** Top edge. */
  y: number
  width: number
  height: number
  candle: Candle
}

/**
 * SVG boxes for the hourly volume bars inside a `width` × `height` box with
 * `pad` kept clear on each side.
 *
 * Bars share areaGeometry's time scale exactly: cx (the bar centre) is linear
 * in startTimestamp over [first start, last start] inside the same pad, so
 * each bar sits under its close point on the line. The bar width is one
 * interval of that scale less `gap`, at least 1 (`innerWidth / 24` less
 * `gap` when every candle starts at the same time); x is cx − width / 2.
 * Height is proportional to volumeUsd, compared BigInt-exactly as the
 * provider wrote it and bottom-aligned to height − pad.bottom; the largest
 * volume fills the inner height, and a zero volume, like any bar that would
 * be thinner than a pixel, draws height 1. A gap in the returned candles
 * stays a gap: no bar is added for it.
 *
 * Null without candles, or when a volume is not a decimal string (a negative
 * one included: volume is never below zero). `max` is the largest volume as
 * the provider wrote it. Callers keep pad.left and pad.right ≥ width / 2.
 */
export function volumeGeometry(
  candles: ReadonlyArray<Candle>,
  intervalSeconds: number,
  width: number,
  height: number,
  pad: Pad,
  gap: number,
): { bars: BarGeometry[]; max: string } | null {
  const sorted = byStart(candles)
  if (sorted.length === 0) return null
  const volumes: Decimal[] = []
  for (const candle of sorted) {
    const volume = parseDecimal(candle.volumeUsd)
    if (!volume || volume.coefficient < 0n) return null
    volumes.push(volume)
  }
  const { units } = aligned(volumes)
  let maxAt = 0
  units.forEach((value, index) => {
    if (value > units[maxAt]) maxAt = index
  })
  const top = units[maxAt]
  const innerWidth = width - pad.left - pad.right
  const innerHeight = height - pad.top - pad.bottom
  const first = sorted[0].startTimestamp
  const span = sorted[sorted.length - 1].startTimestamp - first
  const barWidth = Math.max(1, span === 0 ? innerWidth / 24 - gap : (innerWidth * intervalSeconds) / span - gap)
  const baseline = height - pad.bottom
  // Sub-pixel precision without leaving integers: scale by a thousand, divide, then place.
  const rise = BigInt(Math.max(0, Math.round(innerHeight * 1000)))
  const bars = sorted.map((candle, index) => {
    const cx = span === 0 ? pad.left + innerWidth / 2 : pad.left + ((candle.startTimestamp - first) * innerWidth) / span
    const scaled = top === 0n ? 0 : Number((units[index] * rise) / top) / 1000
    const barHeight = Math.max(1, scaled)
    return { cx, x: cx - barWidth / 2, y: baseline - barHeight, width: barWidth, height: barHeight, candle }
  })
  return { bars, max: sorted[maxAt].volumeUsd }
}

/**
 * The exact midpoint of two decimal strings, one more place than the wider
 * of them, for the middle gridline's label. Null when either is not a decimal.
 */
export function midpoint(a: string, b: string): string | null {
  const x = parseDecimal(a)
  const y = parseDecimal(b)
  if (!x || !y) return null
  const { scale, units } = aligned([x, y])
  // (p + q) / 2 at one more place is (p + q) × 5.
  return fixedText((units[0] + units[1]) * 5n, scale + 1)
}

/**
 * Domino's change over the shown window: the earliest candle's open to the
 * latest candle's close, as a percentage of the open, exact in BigInt and
 * written to two places, half to even. The sign is that of the exact
 * difference, so a rise too small for two places still reads as `+0.00%`.
 * Null without candles, or when the first open is zero: there is no
 * percentage of nothing.
 */
export function changeOverWindow(candles: ReadonlyArray<Candle>): WindowChange | null {
  const sorted = byStart(candles)
  if (sorted.length === 0) return null
  const fromUsd = sorted[0].openUsd
  const toUsd = sorted[sorted.length - 1].closeUsd
  const from = parseDecimal(fromUsd)
  const to = parseDecimal(toUsd)
  if (!from || !to || from.coefficient === 0n) return null
  const { units } = aligned([from, to])
  const difference = units[1] - units[0]
  const sign: -1 | 0 | 1 = difference === 0n ? 0 : difference < 0n ? -1 : 1
  // difference / from × 100, kept to hundredths of a percent: × 10 000 before the one rounding division.
  const hundredths = divideHalfEven(difference * 10_000n, units[0])
  const magnitude = fixedText(hundredths < 0n ? -hundredths : hundredths, 2)
  return { sign, percentText: `${sign === -1 ? '−' : sign === 1 ? '+' : ''}${magnitude}%`, fromUsd, toUsd }
}
