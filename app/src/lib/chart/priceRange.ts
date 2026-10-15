/**
 * The Price range chart's own maths, pure and Node-safe (components/positions/visual/PriceVsRange.tsx draws it).
 *
 * Changed on purpose 2026-10-03 (the owner's point 10: "The Price range chart doesn't work. Tokens go from $0.001 to
 * $1,000,000 and none of these charts work. Sometimes it sits way down at the bottom, sometimes it doesn't show the
 * history … no beginner will understand it"). What was wrong, measured on the chart as it stood (c3b41b8b):
 *  - its price axis was the price now and the range's ends, each end held within four times the price: a range more
 *    than four times away had both edges pinned to one edge of the plot, so the band had no height and no number, and
 *    the price sat alone near the plot's foot or top (an out-of-range position far from its range drew an empty box);
 *    a range wider than that filled the plot, edge to edge, with no number either; and any range around the price took
 *    1/1.28 of the plot, so a band filled the card (the owner's closed ETH/MANY position: 162 of 208 px);
 *  - its numbers were the key figures' six significant digits as they are ("0.000000710148"), and the gutter grew
 *    with them (120 px for that one, half a phone's plot for 0.0000000000032003);
 *  - it drew no line: the pool's hourly closes came from the fees replay's reads of the pool's Swaps, gone on
 *    2026-10-02 (RPC-SPEC §11.4, rugged97's rule 2).
 * Now the axis always holds the whole band and the whole line with room above and below (priceDomain), the line is the
 * pool's own stored hourly closes from the read service (read-v3 `history`, historyLine), and the numbers are written
 * the way DEX screens write tiny and huge prices (readablePrice), the same way on the page's key figures.
 */
import type { HistoryResponse } from 'api-contracts/read-v3/types'
import { numberFormat } from '../format/numberFormat'
import type { PoolPriceObservations } from './positionOpened'
import { SUBSCRIPT, SUPERSCRIPT, readablePrice } from './priceFacts'

// The page's figures, its range and its status (lib/chart/priceFacts.ts), for the chart and its tests in one place.
export { SUBSCRIPT, SUPERSCRIPT, moveText, rangeFacts, readablePrice, statusWords, type RangeFacts, type Where } from './priceFacts'

// ---------------------------------------------------------------------------
// The history's figures
// ---------------------------------------------------------------------------

/** A price the chart computed (a candle's close), in the page's own six significant digits, then as readablePrice writes it. */
export function priceFigure(value: number): string {
  if (!(value > 0) || !Number.isFinite(value)) return '—'
  return readablePrice(numberFormat({ maximumSignificantDigits: 6 }).format(value))
}

// ---------------------------------------------------------------------------
// The price axis
// ---------------------------------------------------------------------------

/** The narrowest stretch of prices the axis shows, as a ratio's log: 2%, so a line that barely moves is drawn barely moving. */
export const MIN_SPAN = Math.log(1.02)
/** The room kept above the highest and under the lowest thing drawn, as a share of what is drawn. */
export const EDGE_ROOM = 0.18

const usable = (value: number) => value > 0 && Number.isFinite(value)

/**
 * The price axis, a log scale (equal steps are equal moves in percent, so a band keeps its true shape at any price):
 * every price drawn (the line and the price now) and both of the range's ends that are prices, with EDGE_ROOM of that
 * stretch above and below, so the band is never the whole plot and nothing touches an edge. An end at 0 or ∞ is no
 * place on the axis: the band runs off that edge. Nothing is held back or pinned: a range far from the price is drawn
 * far from it, in full.
 */
export function priceDomain(lower: number, upper: number, prices: readonly number[]): [number, number] {
  const values = [...prices, lower, upper].filter(usable)
  if (values.length === 0) return [1 / 1.1, 1.1]
  let lo = Math.min(...values)
  let hi = Math.max(...values)
  let span = Math.log(hi / lo)
  if (!(span >= MIN_SPAN)) {
    const middle = Math.sqrt(lo) * Math.sqrt(hi)
    lo = middle / Math.exp(MIN_SPAN / 2)
    hi = middle * Math.exp(MIN_SPAN / 2)
    span = MIN_SPAN
  }
  const room = Math.exp(span * EDGE_ROOM)
  return [lo / room, hi * room]
}

// ---------------------------------------------------------------------------
// The labels at the plot's right
// ---------------------------------------------------------------------------

export interface LabelAsk {
  key: string
  /** Where the label would sit (its centre), in px. */
  at: number
  /** Its height, in px. */
  size: number
  /** The price now's chip: it keeps its place while the others make room. */
  fixed?: boolean
}

/**
 * Places labels on one axis, in the order given (top first): each as near its own place as it can be, none over
 * another (`gap` apart), all within `from`..`to`. A `fixed` label keeps its place unless the edge leaves no room; the
 * others step away from it. Where the room is too small for all of them, they keep their order and overlap the least.
 */
export function placeLabels(asks: readonly LabelAsk[], from: number, to: number, gap = 2): Record<string, number> {
  const count = asks.length
  if (count === 0) return {}
  const half = asks.map((ask) => ask.size / 2)
  const pos = asks.map((ask, index) => Math.min(to - half[index], Math.max(from + half[index], ask.at)))
  const apart = (a: number, b: number) => half[a] + half[b] + gap
  const fixed = asks.findIndex((ask) => ask.fixed)
  if (fixed >= 0) {
    for (let index = fixed - 1; index >= 0; index -= 1) pos[index] = Math.min(pos[index], pos[index + 1] - apart(index, index + 1))
    for (let index = fixed + 1; index < count; index += 1) pos[index] = Math.max(pos[index], pos[index - 1] + apart(index, index - 1))
  } else {
    for (let index = 1; index < count; index += 1) pos[index] = Math.max(pos[index], pos[index - 1] + apart(index, index - 1))
  }
  // Back inside the room: down from the top, then up from the foot.
  if (pos[0] < from + half[0]) {
    pos[0] = from + half[0]
    for (let index = 1; index < count; index += 1) pos[index] = Math.max(pos[index], pos[index - 1] + apart(index, index - 1))
  }
  if (pos[count - 1] > to - half[count - 1]) {
    pos[count - 1] = to - half[count - 1]
    for (let index = count - 2; index >= 0; index -= 1) pos[index] = Math.min(pos[index], pos[index + 1] - apart(index, index + 1))
  }
  return Object.fromEntries(asks.map((ask, index) => [ask.key, pos[index]]))
}

/**
 * About how wide a figure is at the chart's 12px tabular digits, in px: for the room at the plot's right, which holds
 * the widest figure it shows within GUTTER limits (an estimate: the page never measures text before it draws).
 */
export function figureWidth(text: string): number {
  let width = 0
  for (const char of text) width += /[0-9]/.test(char) ? 7.1 : /[.,]/.test(char) ? 3.2 : SUBSCRIPT.includes(char) || SUPERSCRIPT.includes(char) ? 4.8 : char === ' ' ? 3.2 : 7.6
  return Math.ceil(width)
}

// ---------------------------------------------------------------------------
// The pool's price history (read-v3 `history`)
// ---------------------------------------------------------------------------

/** The window the position's page asks for: the last 7 days, hour by hour (168 candles; the contract allows 600). */
export const HISTORY_WINDOW_SECONDS = 604_800
export const HISTORY_RESOLUTION_SECONDS = 3_600
/** A stored history whose snapshot is older than this is stale (the pool chart's rule, PoolHistoryChart.tsx). */
const STALE_SECONDS = 120

/** One hourly close, as the chart inspects it. */
export interface PricePoint {
  /** When the close was the pool's price: the end of its hour, or the history's end for the hour still open. */
  t: number
  price: number
  /** The close as readablePrice writes it, and in the page's plain six significant digits (for a title or a screen reader). */
  text: string
  exact: string
  inRange: boolean
}

export interface PriceHistory {
  /** The window drawn, in seconds. */
  start: number
  end: number
  /** The hourly closes, oldest first: what a pointer or the keyboard inspects. */
  points: PricePoint[]
  /**
   * The line, as runs of points each drawn joined: between two closes a stretch with no trade keeps the earlier close
   * (a pool's price moves only when someone trades in it), and a stretch the service has not collected breaks the line.
   * Nothing is filled in where nothing was collected.
   */
  runs: { t: number; price: number }[][]
  /** Some of the window is not collected. */
  missing: boolean
  /** The service's snapshot is older than two minutes. */
  stale: boolean
  /** Includes actual block-price observations; the segments between measurements are guides. */
  observed?: boolean
}

/** Add actual creation/current block prices in the chart's orientation. Never project the current price back to mint,
 * bridge an uncollected history gap, or join isolated snapshots more than one hour apart. */
export function observedPriceLine(verdict: HistoryVerdict | null, data: HistoryResponse | null, ask: { poolId: string; base: string; quote: string }, range: { lower: number; upper: number }, openedAt: number | null, observations: PoolPriceObservations | null): HistoryVerdict | null {
  if (!observations || observations.poolId.toLowerCase() !== ask.poolId.toLowerCase() || observations.opened.t !== openedAt) return verdict
  const { currencies, opened, current } = observations
  const [a, b] = currencies
  if (a.decimals === null || b.decimals === null || !(current.t > opened.t) || !Number.isSafeInteger(opened.t) || opened.t <= 0 || !Number.isSafeInteger(current.t)) return verdict
  const forward = a.address.toLowerCase() === ask.base.toLowerCase() && b.address.toLowerCase() === ask.quote.toLowerCase()
  const reverse = b.address.toLowerCase() === ask.base.toLowerCase() && a.address.toLowerCase() === ask.quote.toLowerCase()
  if (!forward && !reverse) return verdict
  const sample = (value: typeof opened): PricePoint | null => {
    if (!/^[1-9][0-9]{0,48}$/.test(value.sqrtPriceX96) || BigInt(value.sqrtPriceX96) >= (1n << 160n)) return null
    const ratio = (Number(value.sqrtPriceX96) / 2 ** 96) ** 2 * 10 ** (a.decimals! - b.decimals!)
    const price = forward ? ratio : 1 / ratio
    return usable(price) ? { t: value.t, price, text: priceFigure(price), exact: numberFormat({ maximumSignificantDigits: 6 }).format(price), inRange: price >= range.lower && price < range.upper } : null
  }
  const first = sample(opened), last = sample(current)
  if (!first || !last) return verdict
  const old = verdict?.kind === 'line' ? verdict.history : null
  if (!old) {
    const joined = last.t - first.t <= HISTORY_RESOLUTION_SECONDS
    return { kind: 'line', history: { start: first.t, end: last.t, points: [first, last], runs: joined ? [[first, last]] : [[first], [last]], missing: !joined, stale: false, observed: true } }
  }
  const points = [...old.points], runs = old.runs.map((run) => [...run])
  if (first.t === old.start && first.t < points[0].t) {
    const next = points[0]
    const covered = data?.covered.some((span) => span.startTimestamp <= first.t && span.endTimestamp >= next.t)
    if (next.t - first.t <= HISTORY_RESOLUTION_SECONDS && covered) runs[0].unshift(first)
    else runs.unshift([first])
    points.unshift(first)
  }
  const prior = points[points.length - 1]
  if (last.t > Math.max(prior.t, runs[runs.length - 1].at(-1)!.t)) {
    // Only extend the recent tail. A missing interval stays visibly broken.
    const gap = data?.gaps.some((span) => span.endTimestamp > prior.t && span.startTimestamp < last.t)
    if (last.t - prior.t <= HISTORY_RESOLUTION_SECONDS && !gap) {
      const tail = runs[runs.length - 1].filter((point) => point.t < last.t)
      runs[runs.length - 1] = [...tail, last]
    } else runs.push([last])
    points.push(last)
  }
  return { kind: 'line', history: { ...old, end: Math.max(old.end, last.t), points, runs, observed: true } }
}

export type HistoryVerdict =
  | { kind: 'line'; history: PriceHistory }
  /** Why no line: still being collected, not available for this pool, no trade in the window, or an answer the chart cannot use. */
  | { kind: 'none'; reason: 'not_built' | 'unavailable' | 'no_trades' | 'mismatch' | 'unreadable' | 'unknown_mint' | 'no_position_history' }

/** The pool keeps trading after an NFT closes. Its later prices are not this position's history. */
export function closedPriceLine(verdict: HistoryVerdict | null, closedAt: number | null): HistoryVerdict | null {
  if (verdict?.kind !== 'line' || closedAt === null || !Number.isSafeInteger(closedAt) || closedAt <= 0) return verdict
  const history = verdict.history
  const points = history.points.filter((point) => point.t <= closedAt)
  if (!points.length) return { kind: 'none', reason: 'no_position_history' }
  return { kind: 'line', history: { ...history, end: Math.min(history.end, closedAt), points, runs: history.runs.map((run) => run.filter((point) => point.t <= closedAt)).filter((run) => run.length > 0) } }
}

/**
 * The pool's stored price history (read-v3 `history`: the pool's own ratio, built by the read service from its Swaps on
 * Robinhood Chain, never read from a node by the page) as the chart's line, in the page's orientation: the history is
 * asked for `base` (the token the page prices), and its quote must be the page's `quote`, or it is not used. Its closes
 * are exact decimal texts; only their places on the plot are floats. `nowSeconds` is the page's clock, for staleness and
 * for where the window ends when the snapshot is behind.
 */
export function historyLine(data: HistoryResponse, ask: { base: string; quote: string }, range: { lower: number; upper: number }, nowSeconds: number, openedAt?: number | null, openedBefore?: number | null): HistoryVerdict {
  // (2026-10-15, pack 7) With no mint, a proven bound on it (positionOpened.ts ledgerOpenedBefore: minted at or before
  // this time) at or before the window's start makes the whole window this NFT's own; it is never an opening time.
  const before = openedAt === null && typeof openedBefore === 'number' && Number.isSafeInteger(openedBefore) && openedBefore > 0 && openedBefore <= data.requestedWindow.startTimestamp
  // The page must know when THIS NFT was minted before presenting the pool's prices as its history.
  if (openedAt !== undefined && !before && (openedAt === null || !Number.isSafeInteger(openedAt) || openedAt <= 0)) return { kind: 'none', reason: 'unknown_mint' }
  if (data.currency.toLowerCase() !== ask.base.toLowerCase() || (data.quoteCurrency !== null && data.quoteCurrency.toLowerCase() !== ask.quote.toLowerCase())) return { kind: 'none', reason: 'mismatch' }
  if (data.status === 'not_built') return { kind: 'none', reason: 'not_built' }
  if (data.status === 'unavailable') return { kind: 'none', reason: 'unavailable' }
  if (data.candles.length === 0) return { kind: 'none', reason: 'no_trades' }
  const step = data.resolutionSeconds
  const { startTimestamp: requestedStart, endTimestamp: windowEnd } = data.requestedWindow
  const start = Math.max(requestedStart, openedAt ?? requestedStart)
  // Keep measured closes only. Never interpolate a mint price or carry a pre-mint close into this NFT's line.
  const candles = data.candles.filter((candle) => Math.min(candle.startTimestamp + step, windowEnd) >= start)
  if (!candles.length) return { kind: 'none', reason: 'no_position_history' }
  const closes = candles.map((candle) => Number(candle.close))
  if (closes.some((close) => !usable(close))) return { kind: 'none', reason: 'unreadable' }
  // The collected stretches, those that touch merged into one, so a stretch is collected when one of them holds it whole.
  const spans: { from: number; to: number }[] = []
  for (const one of data.covered) {
    const prior = spans[spans.length - 1]
    if (prior && one.startTimestamp <= prior.to) prior.to = Math.max(prior.to, one.endTimestamp)
    else spans.push({ from: one.startTimestamp, to: one.endTimestamp })
  }
  const covered = (from: number, to: number) => to <= from || spans.some((one) => one.from <= from && to <= one.to)
  const inRange = (price: number) => price >= range.lower && price < range.upper
  const points: PricePoint[] = candles.map((candle, index) => ({
    t: Math.min(candle.startTimestamp + step, windowEnd),
    price: closes[index],
    text: priceFigure(closes[index]),
    exact: numberFormat({ maximumSignificantDigits: 6 }).format(closes[index]),
    inRange: inRange(closes[index]),
  }))
  const runs: { t: number; price: number }[][] = []
  let run: { t: number; price: number }[] = []
  points.forEach((point, index) => {
    const candle = candles[index]
    const previous = index > 0 ? points[index - 1] : null
    // Joined to the close before: the quiet hours between were collected (no trade, so its close held) and so is this hour.
    if (previous && covered(previous.t, candle.startTimestamp) && covered(candle.startTimestamp, point.t)) {
      if (previous.t < candle.startTimestamp) run.push({ t: candle.startTimestamp, price: previous.price })
      run.push({ t: point.t, price: point.price })
      return
    }
    if (run.length) runs.push(run)
    run = [{ t: point.t, price: point.price }]
  })
  // The last close held until the history's end, where that stretch was collected.
  const last = points[points.length - 1]
  if (last.t < windowEnd && covered(last.t, windowEnd)) run.push({ t: windowEnd, price: last.price })
  runs.push(run)
  return {
    kind: 'line',
    history: {
      start,
      // To the page's clock when the snapshot is behind it (a day at the most), so the line ends where its data does.
      end: Math.max(windowEnd, Math.min(nowSeconds, windowEnd + 86_400)),
      points,
      runs,
      missing: data.gaps.some((gap) => gap.endTimestamp > start && gap.startTimestamp < windowEnd) || (data.status === 'partial' && data.gaps.length === 0),
      stale: data.status === 'stale' || (data.snapshot !== null && nowSeconds - data.snapshot.timestamp > STALE_SECONDS),
    },
  }
}
