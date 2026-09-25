import { useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import { XAxis, YAxis } from '../../charts/Axis'
import { ChartFrame, type Plot } from '../../charts/ChartFrame'
import { ChartTooltip, ChartTooltipRow } from '../../charts/ChartTooltip'
import { Crosshair, EndDot, HoverDot, LineSeries, RangeBand } from '../../charts/series'
import { Pill } from '../../ui'
import { logScale, niceTicks } from '../../../lib/chart/scale'
import { nearestIndex } from '../../../lib/chart/inspect'
import type { FeeHistoryView, HourlyPrices, PositionState } from '../../../lib/fees/types'
import { useFeeHistory } from '../../../lib/fees/useFeeHistory'
import { shortAmount } from '../../../lib/format/amount'
import { group } from '../../../lib/format/decimal'
import { priceFromSqrt } from '../../../lib/format/price'
import { shortDate, shortTime } from '../../../lib/format/time'
import { useMediaQuery } from '../../../lib/useMediaQuery'
import { dateTicks } from './ticks'

const HOUR = 3_600

/** One point of the pool's price: the close at `t` (currency1 per currency0, the page's orientation) and whether it sat in the range. */
interface PricePoint {
  t: number
  price: number
  text: string
  inRange: boolean
}

export interface PriceSeries {
  points: ReadonlyArray<PricePoint>
  /** The index where the known hours stop and only the current price follows (an unfinished history); -1 when continuous. */
  gapAt: number
  lower: number
  upper: number
  state: PositionState
}

/** A price at most six significant digits, grouped, nothing rounded up (`407.278`, `0.00245312`). */
function priceText(decimal: string): string {
  const [whole, fraction = ''] = decimal.split('.')
  return shortAmount(`${group(whole)}.${fraction}`).short
}

const tickPrice = (tick: number, d0: number, d1: number) => Math.pow(1.0001, tick) * Math.pow(10, d0 - d1)

/**
 * The pool's hourly closes since the mint as a line the chart can draw (a
 * module helper: bigint square roots become plain numbers here, for geometry
 * only). An hour with no swap did not move the price, so the line holds flat
 * through it and moves inside the hour that traded. When the history is not
 * verified, the closes stop where the replay stopped: the current price then
 * stands alone at the end, never joined to them.
 */
function priceSeries(prices: HourlyPrices, state: PositionState, verified: boolean): PriceSeries | null {
  const [c0, c1] = state.currencies
  if (c0.decimals === null || c1.decimals === null || prices.hours.length === 0) return null
  const d0 = c0.decimals
  const d1 = c1.decimals
  const point = (t: number, sqrt: bigint, tick: number): PricePoint => {
    const decimal = priceFromSqrt(sqrt, d0, d1)
    return { t, price: Number(decimal), text: priceText(decimal), inRange: tick >= state.tickLower && tick < state.tickUpper }
  }
  const points: PricePoint[] = []
  for (const hour of prices.hours) {
    const previous = points[points.length - 1]
    // Flat through the quiet hours, then the traded hour's move.
    if (previous && hour.t - HOUR > previous.t) points.push({ ...previous, t: hour.t - HOUR })
    points.push(point(hour.t, hour.sqrtPriceX96Close, hour.tickClose))
  }
  const last = points[points.length - 1]
  const now = point(state.timestamp, state.sqrtPriceX96, state.tick)
  let gapAt = -1
  if (now.t > last.t) {
    if (verified) {
      if (now.t - HOUR > last.t) points.push({ ...last, t: now.t - HOUR })
    } else gapAt = points.length
    points.push(now)
  }
  return { points, gapAt, lower: tickPrice(state.tickLower, d0, d1), upper: tickPrice(state.tickUpper, d0, d1), state }
}

/** The price line of a position's pool, when its fees history has read one (§12.1); null otherwise. */
export function usePriceSeries(tokenId: string | null): PriceSeries | null {
  const view: FeeHistoryView = useFeeHistory(tokenId, 'page')
  return useMemo(() => {
    if (view.phase === 'verified') return priceSeries(view.prices, view.state, true)
    if (view.phase === 'unclaimed-only' && view.prices) return priceSeries(view.prices, view.state, false)
    return null
  }, [view])
}

/**
 * The price axis: the closes, and the range's band where it is near them; a
 * range far off is drawn to the edge rather than flattening the line.
 */
function domainOf(points: ReadonlyArray<PricePoint>, lower: number, upper: number): [number, number] {
  const prices = points.map((point) => point.price)
  const lo = Math.min(...prices)
  const hi = Math.max(...prices)
  const floor = Math.min(lo, lower > 0 ? Math.max(lower, lo / 4) : lo)
  const ceiling = Math.max(hi, Number.isFinite(upper) ? Math.min(upper, hi * 4) : hi)
  const span = Math.log(ceiling / floor) || 0.02
  return [floor / Math.exp(span * 0.12), ceiling * Math.exp(span * 0.12)]
}

/** An axis price for a round tick. */
function axisPrice(value: number): string {
  const [whole, fraction = ''] = value.toFixed(10).split('.')
  const digits = fraction.replace(/0+$/, '')
  return digits ? `${group(whole)}.${digits}` : group(whole)
}

/** Labels on the price axis stay this far apart. */
const LABEL_GAP = 28

/**
 * Round prices for a log axis: 1, 2 and 5 of each decade inside the domain
 * (equal steps on this axis), or a linear 1/2/5 set when the domain is too
 * narrow to hold two of them; then at most three, spread over the axis, each
 * at least LABEL_GAP px from the one before.
 */
function priceTicks(domain: readonly [number, number], y: (v: number) => number): number[] {
  const [lo, hi] = domain
  if (!(lo > 0) || !(hi > lo) || !Number.isFinite(hi)) return []
  const decades: number[] = []
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of [1, 2, 5]) {
      const v = Number((m * 10 ** e).toPrecision(12))
      if (v > lo && v < hi) decades.push(v)
    }
  }
  const candidates = decades.length >= 2 ? decades : niceTicks(lo, hi, 3).filter((tick) => tick > lo && tick < hi)
  const spread = candidates.length <= 3 ? candidates : [candidates[0], candidates[Math.floor((candidates.length - 1) / 2)], candidates[candidates.length - 1]]
  const kept: number[] = []
  for (const tick of spread) if (kept.every((other) => Math.abs(y(other) - y(tick)) >= LABEL_GAP)) kept.push(tick)
  return kept
}

/**
 * Price vs range (DESIGN-V2 §12.1): the pool's hourly closes as a quiet line,
 * Tangerine where they sat inside the position's range, over the range drawn
 * as a band with dashed edges. Log price axis; dates under it, three prices
 * at the right. The tooltip says the hour, the pool price and in range or out.
 */
export function PriceVsRange({ series, unit }: { series: PriceSeries; unit?: ReactNode }) {
  const { points, gapAt, lower, upper } = series
  // A phone keeps a narrower gutter for the price labels.
  const phone = useMediaQuery('(max-width: 767px)')
  const start = points[0].t
  const end = points[points.length - 1].t
  const domain = useMemo(() => domainOf(points, lower, upper), [points, lower, upper])
  const xs = useMemo(() => points.map((point) => point.t), [points])

  const scales = useCallback(
    (plot: Plot) => ({
      x: (t: number) => plot.left + ((t - start) / Math.max(1, end - start)) * (plot.right - plot.left),
      y: logScale(domain, [plot.bottom, plot.top]),
    }),
    [start, end, domain],
  )

  const series_ = useCallback(
    (plot: Plot) => {
      const { x, y } = scales(plot)
      const clampY = (v: number) => Math.min(plot.bottom, Math.max(plot.top, y(v)))
      // Runs of in-range and out-of-range closes, each joined to the next so the line never breaks, and never joined across the gap.
      const runs: { inRange: boolean; pts: { x: number; y: number }[] }[] = []
      points.forEach((point, index) => {
        const xy = { x: x(point.t), y: y(point.price) }
        const run = runs[runs.length - 1]
        if (index === gapAt || !run) runs.push({ inRange: point.inRange, pts: [xy] })
        else if (run.inRange === point.inRange) run.pts.push(xy)
        else {
          run.pts.push(xy)
          runs.push({ inRange: point.inRange, pts: [xy] })
        }
      })
      const last = points[points.length - 1]
      return (
        <>
          <RangeBand y1={lower > 0 ? clampY(lower) : plot.bottom} y2={Number.isFinite(upper) ? clampY(upper) : plot.top} left={plot.left} right={plot.right} dashed />
          <LineSeries segments={runs.filter((run) => !run.inRange).map((run) => run.pts)} tone="neutral" />
          <LineSeries segments={runs.filter((run) => run.inRange).map((run) => run.pts)} tone="primary" />
          <EndDot x={x(last.t)} y={y(last.price)} />
        </>
      )
    },
    [scales, points, gapAt, lower, upper],
  )

  const axes = useCallback(
    (plot: Plot) => {
      const { x, y } = scales(plot)
      const ticks = priceTicks(domain, y)
      return (
        <>
          <YAxis ticks={ticks.map((tick) => ({ y: y(tick), label: axisPrice(tick) }))} anchor={plot.right + (phone ? 6 : 10)} />
          <XAxis ticks={dateTicks(start, end, Math.max(3, Math.floor((plot.right - plot.left) / 100))).map((tick) => ({ x: x(tick.t), label: tick.label }))} anchor={plot.bottom + 20} left={plot.left} right={plot.right} />
        </>
      )
    },
    [scales, start, end, domain, phone],
  )

  const inspect = (plot: Plot, index: number | null) => {
    if (index === null) return null
    const { x, y } = scales(plot)
    const point = points[index]
    return (
      <>
        <Crosshair x={x(point.t)} y={y(point.price)} top={plot.top} bottom={plot.bottom} left={plot.left} right={plot.right} />
        <HoverDot x={x(point.t)} y={y(point.price)} />
      </>
    )
  }

  const overlay = (plot: Plot, index: number | null) => {
    if (index === null) return null
    const { x } = scales(plot)
    const point = points[index]
    return (
      <ChartTooltip x={x(point.t)} plot={plot} head={`${shortDate(point.t)} ${shortTime(point.t)}`}>
        <ChartTooltipRow label="Pool price">
          {point.text}
          {unit && <span className="dm-pvr-unit"> {unit}</span>}
        </ChartTooltipRow>
        <span className="dm-fees-tip-pill">
          <Pill dot tone={point.inRange ? 'in' : 'out'}>
            {point.inRange ? 'In range' : 'Out of range'}
          </Pill>
        </span>
      </ChartTooltip>
    )
  }

  return (
    <ChartFrame
      className="dm-pvr"
      height={200}
      padding={{ top: 12, right: phone ? 44 : 64, bottom: 28, left: 0 }}
      label="Price range"
      points={points.length}
      indexAt={(px, plot) => nearestIndex(xs, start + ((px - plot.left) / Math.max(1, plot.right - plot.left)) * (end - start))}
      valueText={(index) => `${shortDate(points[index].t)} ${shortTime(points[index].t)}, ${points[index].text}`}
      revealKey="price"
      axes={axes}
      series={series_}
      inspect={inspect}
      overlay={overlay}
    />
  )
}
