import type { HistoryResponse, RatioCandle } from 'api-contracts/read-v3/types'
import { parseDecimal } from '../read/decimal'
import { linePath, type Point } from './paths'

/**
 * The Markets card's price line (2026-09-25): smooth monotone curves over the
 * card's 24 hours, the way an exchange's explore cards draw a pair. Pure and
 * Node-safe; only positions are numbers, every close is compared as an exact
 * decimal.
 *
 * Only closes are drawn. A pool's price moves only on a swap, so an hour with
 * no swap closed where the hour before it did: across such hours the curve
 * holds the last close (one level stretch, never a dashed or dotted one) and
 * eases into the next close within the hour before it. When the hours since
 * the last close had no swap, that close is the price now, held to the plot's
 * right edge, so every card ends at one x. Nothing is drawn before the first
 * close: a candle's `open` is the price after its hour's first swap (backend
 * public_history.py `aggregate`), not the price before it, so the history
 * never says what the window's quiet first hours held.
 *
 * Where the history has an interval it has not covered (`gaps`), the curve
 * ends and a new run starts at the first close after it: DESIGN-V2 §4.1's
 * "never joined across a gap", kept. A run's last close is held only through
 * the whole hours covered before the gap. Inside a run the curve is monotone
 * cubic (Fritsch–Carlson) whatever its length, which the card's brief asks
 * for over §4.1's "linear under 20 points" (2026-09-25): it never overshoots,
 * so it never shows a price outside the two closes it joins.
 */

export interface SparkPad {
  left: number
  right: number
  top: number
  bottom: number
}

export interface SparkPoint extends Point {
  candle: RatioCandle
}

/** One stretch the history covers, drawn on its own. */
export interface SparkRun {
  /** Its curve: `M…C…` (`M…L…` for two points); a lone hour is a bare `M x y`, drawn as a dot. */
  line: string
  /** The same curve closed down to the plot's floor (its full height); empty for a lone hour. */
  area: string
  /** Its first and last drawn point. */
  start: Point
  end: Point
}

export interface SparkGeometry {
  width: number
  height: number
  left: number
  right: number
  top: number
  bottom: number
  /** The real hours, placed: the only ones the pointer names. */
  points: SparkPoint[]
  /** The runs, in time order: one unless the history has an interval it has not covered. */
  runs: SparkRun[]
  /** Every run's curve as one path, a subpath each: `M…C… M…C…`. */
  line: string
  /** The highest any run reaches (its least y): where the area's gradient starts, one strength for every run. */
  crest: number
  /** The first close's y: the level the window's change is measured from. */
  baseline: number
  /** Where the curve ends: the latest close, at the right edge when the hours since it had no swap. */
  end: Point
  /** Every close is the same price. */
  flat: boolean
}

/**
 * The least spread the vertical scale shows, in parts per million of the
 * middle price: a stable pair moving 0.04 % in a day rests near a level line
 * instead of filling the card with noise; anything moving more than 0.25 %
 * uses the plot's whole height.
 */
export const SPARK_MIN_SPREAD_PPM = 2500n

const n = (value: number) => Math.round(value * 100) / 100

export function sparkGeometry(history: HistoryResponse, width: number, height: number, pad: SparkPad): SparkGeometry | null {
  const candles = [...history.candles].sort((a, b) => a.startTimestamp - b.startTimestamp)
  if (candles.length === 0 || !(width > pad.left + pad.right) || !(height > pad.top + pad.bottom)) return null
  const decimals = candles.map((candle) => parseDecimal(candle.close))
  if (decimals.some((value) => !value || value.coefficient <= 0n)) return null
  const scale = Math.max(...decimals.map((value) => value!.scale))
  // Six more digits than the finest close, so the least spread below keeps its precision on any price.
  const values = decimals.map((value) => value!.coefficient * 10n ** BigInt(scale - value!.scale + 6))

  // The time domain: from the window's first whole hour (or an earlier first candle) to the window's end.
  const step = history.resolutionSeconds
  const { startTimestamp: start, endTimestamp: end } = history.requestedWindow
  const from = Math.min(candles[0].startTimestamp, Math.ceil(start / step) * step)
  const to = Math.max(end, candles[candles.length - 1].startTimestamp)
  const left = pad.left
  const right = width - pad.right
  const x = (timestamp: number) => (to <= from ? right : left + ((timestamp - from) / (to - from)) * (right - left))
  /** The earliest interval the history has not covered between two instants, if any. */
  const gapBetween = (a: number, b: number) =>
    history.gaps.filter((gap) => gap.startTimestamp < b && gap.endTimestamp > a).sort((p, q) => p.startTimestamp - q.startTimestamp)[0]

  let high = values[0]
  let low = high
  for (const value of values) {
    if (value > high) high = value
    if (value < low) low = value
  }
  // The vertical domain: the closes' own range, widened about its middle to the least spread.
  const middle = (high + low) / 2n
  const least = (middle * SPARK_MIN_SPREAD_PPM) / 1_000_000n
  const floor = high - low < least ? middle - least / 2n : low
  const ceiling = high - low < least ? floor + least : high
  const top = pad.top
  const bottom = height - pad.bottom
  const rise = BigInt(Math.round((bottom - top) * 1000))
  const y = (value: bigint) => (ceiling === floor ? (top + bottom) / 2 : bottom - Number(((value - floor) * rise) / (ceiling - floor)) / 1000)

  const points: SparkPoint[] = candles.map((candle, index) => ({ x: x(candle.startTimestamp), y: y(values[index]), candle }))
  const runs: Point[][] = [[]]
  // The covered hours after a close, up to a gap, had no swap: it held through the last whole hour before the gap.
  const holdBefore = (run: Point[], point: SparkPoint, gapStart: number) => {
    const held = Math.floor(gapStart / step) * step - step
    if (held > point.candle.startTimestamp) run.push({ x: x(held), y: point.y })
  }
  points.forEach((point, index) => {
    const previous = points[index - 1]
    if (previous) {
      const gap = gapBetween(previous.candle.startTimestamp, point.candle.startTimestamp)
      if (gap) {
        holdBefore(runs[runs.length - 1], previous, gap.startTimestamp)
        runs.push([])
      } else {
        // Hours with no swap between two closes: the earlier close, held to the hour before the next one.
        const held = point.candle.startTimestamp - step
        if (held > previous.candle.startTimestamp) runs[runs.length - 1].push({ x: x(held), y: previous.y })
      }
    }
    runs[runs.length - 1].push({ x: point.x, y: point.y })
  })
  const last = points[points.length - 1]
  const tail = runs[runs.length - 1]
  const after = gapBetween(last.candle.startTimestamp, end)
  if (after) holdBefore(tail, last, after.startTimestamp)
  else if (right - last.x > 0.5) tail.push({ x: right, y: last.y })
  // A window with no width (every hour at one x): a level line across the plot rather than a dot.
  if (runs.length === 1 && tail[tail.length - 1].x - tail[0].x < 1) {
    const level = tail[tail.length - 1].y
    tail.splice(0, tail.length, { x: left, y: level }, { x: right, y: level })
  }

  const base = n(height)
  const drawn: SparkRun[] = runs.map((run) => {
    const line = linePath(run, 'monotone')
    const first = run[0]
    const final = run[run.length - 1]
    return {
      line,
      area: run.length > 1 ? `${line} L${n(final.x)} ${base} L${n(first.x)} ${base} Z` : '',
      start: { x: first.x, y: first.y },
      end: { x: final.x, y: final.y },
    }
  })
  const ending = drawn[drawn.length - 1].end
  return {
    width,
    height,
    left,
    right,
    top,
    bottom,
    points,
    runs: drawn,
    line: drawn.map((run) => run.line).join(' '),
    crest: Math.min(...runs.flat().map((point) => point.y)),
    baseline: points[0].y,
    end: { x: ending.x, y: ending.y },
    flat: high === low,
  }
}
