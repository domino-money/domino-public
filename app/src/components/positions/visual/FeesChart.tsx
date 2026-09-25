import { useCallback, useMemo } from 'react'
import type { ReactNode } from 'react'
import { YAxis, XAxis } from '../../charts/Axis'
import { ChartFrame, type Plot } from '../../charts/ChartFrame'
import { ChartTooltip, ChartTooltipRow } from '../../charts/ChartTooltip'
import { AreaSeries, Baseline, BarSeries, Crosshair, EndDot, EventPips, HoverDot, InRangeStrip, LastValue, LastValueChip } from '../../charts/series'
import { Pill } from '../../ui'
import { linearScale, niceTicks } from '../../../lib/chart/scale'
import { linePath } from '../../../lib/chart/paths'
import { group } from '../../../lib/format/decimal'
import { bucketLabel, shortDate, shortTime } from '../../../lib/format/time'
import { formatUsd } from '../../../lib/format/usd'
import { useMediaQuery } from '../../../lib/useMediaQuery'
import { TokenFigure } from './FeesActivity'
import type { FeesPeriodView, FeesView } from './model'
import { dateTicks } from './ticks'
import { positive, unitsNumber, valueFigure } from './value'

/**
 * The plot's room. Desktop: the y labels and the last-value chip in a gutter
 * at the right, the in-range strip and the dates under the plot. Phone: no
 * gutter (§13.2, padding right 8): the y labels sit inside the plot and the
 * chip rides above the end dot, in the room left at the top.
 */
const PAD = { top: 16, right: 72, bottom: 44, left: 0 }
const PAD_PHONE = { top: 32, right: 8, bottom: 44, left: 0 }
/**
 * Nothing earned yet: a timeline waiting for its first fee. The flat line along the foot of a short plot (the room
 * above it is the inspection's), the mint pip at its start, the end dot at now, the first and last dates just under
 * it; no y label (the hero says $0.00) and no in-range strip (Time in range beside it already says so). Room at the
 * right for the end dot only. A phone, where the timeline sits under the summary, keeps less room above it.
 */
const PAD_ZERO = { top: 16, right: 16, bottom: 28, left: 0 }
const PAD_ZERO_PHONE = { top: 8, right: 16, bottom: 28, left: 0 }
const HEIGHT_ZERO = 48
const HEIGHT_ZERO_PHONE = 32
/** Bars stand in the bottom 28 % of the plot on their own scale (§13.2). */
const BAR_SHARE = 0.28
/** A bar takes 55 % of its bucket, centred, 2 to 12 px wide. */
const BAR_FILL = 0.55
const BAR_MAX = 12
const BAR_MIN = 2
/** A y label closer than this to the baseline's label, or to the chip, is dropped. */
const BASE_GAP = 20
const CHIP_GAP = 14

/** An axis figure for a round tick (niceTicks' 1/2/5 steps): `$1,500`, `$0.25`, `$0.002`; a quote amount without its symbol. */
function axisFigure(view: FeesView, value: number): string {
  const [whole, fraction = ''] = value.toFixed(8).split('.')
  const digits = fraction.replace(/0+$/, '')
  if (view.basis.kind === 'quote') return digits ? `${group(whole)}.${digits}` : group(whole)
  return digits ? formatUsd(`${whole}.${digits}`) : `$${group(whole)}`
}

/**
 * The baseline's own label: the period-start value as the screens write it
 * (`$605.12`), `$0` when the period starts at nothing.
 */
function baseFigure(view: FeesView, pv: FeesPeriodView): string {
  return positive(pv.base) ? valueFigure(view.basis, pv.base) : axisFigure(view, 0)
}

/** A symbol from /state, as text (untrusted): the short address when unreadable. */
const symbolOf = (currency: { address: string; symbol: string | null }) => currency.symbol ?? `${currency.address.slice(0, 6)}…${currency.address.slice(-4)}`

/**
 * The in-range stretches in pixels. A stretch narrower than 3px cannot be seen
 * as one (the strip keeps 1px between stretches): it joins the one before it.
 */
function stripSegments(strip: FeesPeriodView['strip'], x: (t: number) => number) {
  const out: { x0: number; x1: number; inRange: boolean }[] = []
  for (const stretch of strip) {
    const segment = { x0: x(stretch.t0), x1: x(stretch.t1), inRange: stretch.inRange }
    const previous = out[out.length - 1]
    if (previous && (segment.x1 - segment.x0 < 3 || previous.inRange === segment.inRange)) previous.x1 = segment.x1
    else out.push(segment)
  }
  return out
}

/** A share in percent, two decimals. */
export const percentText = (share: number) => `${(Math.min(1, Math.max(0, share)) * 100).toFixed(2)}%`

/** How many date labels a plot this wide carries: at least three, about one per 100px. */
const dateCount = (plot: Plot) => Math.max(3, Math.floor((plot.right - plot.left) / 100))

/** The zero timeline's two ends, in the activity rows' caption style: `09-23 01:09 UTC`. */
const edgeLabel = (t: number) => `${shortDate(t)} ${shortTime(t)}`

/**
 * The fees chart (DESIGN-V2 §13.2): the cumulative fees earned in the period
 * as a Tangerine area (linear between hourly points: earned only grows), the
 * earned value of each bucket as slim bars in the bottom 28 % on their own
 * scale, the settlements as pips, time in range as a strip under the plot,
 * the end dot and the current total in a chip. The y axis always names its
 * floor, the period-start value, so the area reads as growth from there.
 * Inspection snaps to bucket ends; the series layer never sees the inspected
 * bucket. With nothing earned yet (`zero`) it is a timeline waiting for its
 * first fee: the real flat line in a quiet ink from the mint pip to the end
 * dot at now, and the two dates it spans.
 *
 * 2026-09-25 (review of r4/fees): an estimated history's (`estimated`) bucket values are sampled: each one's figure
 * carries "est." in its tooltip and its label, and its sampled time in range is left out, as the card leaves it out.
 */
export function FeesChart({ view, pv, onInspect, zero, estimated = false }: { view: FeesView; pv: FeesPeriodView; onInspect: (index: number | null) => void; zero: boolean; estimated?: boolean }) {
  const phone = useMediaQuery('(max-width: 767px)')
  const height = zero ? (phone ? HEIGHT_ZERO_PHONE : HEIGHT_ZERO) : phone ? 200 : 240
  const pad = zero ? (phone ? PAD_ZERO_PHONE : PAD_ZERO) : phone ? PAD_PHONE : PAD
  const { start, end, buckets } = pv
  const baseN = unitsNumber(pv.base)
  const lastN = unitsNumber(pv.last)
  // Room above the line on a desktop (the chip sits in the gutter); on a phone the chip rides above the end, in the top padding.
  const headroom = phone ? 1.02 : 1.12
  // Nothing earned: the flat line lies on the plot's foot (the floor at the bottom, one unit of room above it).
  const topN = lastN > baseN ? baseN + (lastN - baseN) * headroom : baseN + 1
  const bottomN = baseN
  const single = view.sources.length === 1 || view.sameTokens
  const currencies = view.sources[0].state.currencies

  const scales = useCallback(
    (plot: Plot) => ({
      x: linearScale([start, Math.max(end, start + 1)], [plot.left, plot.right]),
      y: linearScale([bottomN, topN], [plot.bottom, plot.top]),
    }),
    [start, end, bottomN, topN],
  )

  const bars = useCallback(
    (plot: Plot) => {
      const { x } = scales(plot)
      return buckets.map((bucket) => {
        const x0 = x(bucket.start)
        const x1 = x(bucket.end)
        const width = Math.min(BAR_MAX, Math.max(BAR_MIN, (x1 - x0) * BAR_FILL))
        return { x: (x0 + x1) / 2 - width / 2, width, value: unitsNumber(bucket.earnedIn) }
      })
    },
    [scales, buckets],
  )

  const series = useCallback(
    (plot: Plot) => {
      const { x, y } = scales(plot)
      const line = pv.points.map((point) => ({ x: x(point.t), y: y(point.v) }))
      const endPoint = line[line.length - 1]
      const pips = <EventPips events={pv.events.map((event) => ({ x: x(event.t), y: y(event.v), kind: event.kind }))} />
      if (zero) {
        // The real flat line, in a quiet ink (nothing earned is not a series to accent), under the pips; Tangerine only at now.
        return (
          <>
            {line.length > 1 && <path d={linePath(line, 'linear')} className="dm-fees-flat" />}
            {pips}
            {endPoint && <EndDot x={endPoint.x} y={endPoint.y} />}
          </>
        )
      }
      return (
        <>
          <Baseline y={plot.bottom} left={plot.left} right={plot.right} />
          <AreaSeries segments={[line]} curve="linear" baseline={plot.bottom} />
          {/* The bars tint the area rather than show through it, and the line is drawn again over them. */}
          <BarSeries bars={bars(plot)} baseline={plot.bottom} maxHeight={(plot.bottom - plot.top) * BAR_SHARE} />
          {line.length > 1 && <path d={linePath(line, 'linear')} className="dm-series-line" />}
          {pips}
          <InRangeStrip segments={stripSegments(pv.strip, x)} y={plot.bottom + 8} />
          {endPoint && <EndDot x={endPoint.x} y={endPoint.y} />}
        </>
      )
    },
    [scales, bars, pv, zero],
  )

  const lastText = valueFigure(view.basis, pv.last)

  // The y labels: the floor (the period-start value) always, round levels above it clear of it and of the chip.
  const yLabels = useCallback(
    (plot: Plot) => {
      const { y } = scales(plot)
      const floorY = y(baseN)
      const lastY = y(lastN)
      const above = niceTicks(baseN, topN, phone ? 2 : 3).filter((tick) => tick > baseN && tick <= topN && floorY - y(tick) >= BASE_GAP && (phone || Math.abs(y(tick) - lastY) > CHIP_GAP))
      return { floor: { y: floorY, label: baseFigure(view, pv) }, levels: above.map((tick) => ({ y: y(tick), label: axisFigure(view, tick) })) }
    },
    [scales, baseN, lastN, topN, phone, view, pv],
  )

  const axes = useCallback(
    (plot: Plot) => {
      // The zero timeline: its first and last dates, flush with its two ends, and no y label.
      if (zero) {
        const edges = [
          { x: plot.left, label: edgeLabel(start) },
          { x: plot.right, label: edgeLabel(end) },
        ]
        return <XAxis ticks={end > start ? edges : edges.slice(0, 1)} anchor={plot.bottom + 22} left={plot.left} right={plot.right} />
      }
      const { x } = scales(plot)
      const dates = dateTicks(start, end, dateCount(plot)).map((tick) => ({ x: x(tick.t), label: tick.label }))
      const xAxis = <XAxis ticks={dates} anchor={plot.bottom + 36} left={plot.left} right={plot.right} />
      // A phone draws its y labels over the series (inspect layer); a desktop in the gutter.
      if (phone) return xAxis
      const { floor, levels } = yLabels(plot)
      return (
        <>
          <YAxis ticks={[floor, ...levels]} anchor={plot.right + 10} />
          {xAxis}
        </>
      )
    },
    [scales, yLabels, zero, start, end, phone],
  )

  /**
   * A phone has no gutter: the labels sit inside the plot, over the series, just above the level each names. Earned
   * only grows, so the line is low at the left and high at the right: round levels at the left, the floor at the right.
   */
  const insideLabels = (plot: Plot) => {
    const { floor, levels } = yLabels(plot)
    return (
      <g className="dm-fees-axis-inside">
        <YAxis ticks={levels.map((level) => ({ ...level, y: level.y - 10 }))} anchor={plot.left} side="right" />
        <YAxis ticks={[{ ...floor, y: floor.y - 10 }]} anchor={plot.right} side="left" />
      </g>
    )
  }

  const inspect = (plot: Plot, index: number | null) => {
    const { x, y } = scales(plot)
    const endX = x(end)
    const endY = y(lastN)
    const bucket = index === null ? null : buckets[index]
    return (
      <>
        {!zero && !phone && <LastValue x0={endX} x1={plot.width - 8} y={endY} />}
        {bucket && (
          <>
            {!zero && (
              <g className="dm-fees-hover-bars">
                <BarSeries bars={bars(plot)} baseline={plot.bottom} maxHeight={(plot.bottom - plot.top) * BAR_SHARE} hovered={index} />
              </g>
            )}
            <Crosshair x={x(bucket.end)} y={y(unitsNumber(bucket.earned))} top={plot.top} bottom={plot.bottom} left={plot.left} right={plot.right} />
            <HoverDot x={x(bucket.end)} y={y(unitsNumber(bucket.earned))} />
          </>
        )}
        {phone && !zero && insideLabels(plot)}
      </>
    )
  }

  const tokenRows = (amounts: readonly [bigint, bigint] | null): ReactNode =>
    single && amounts
      ? ([0, 1] as const).map((i) =>
          positive(amounts[i]) ? (
            <ChartTooltipRow key={i} label={symbolOf(currencies[i])}>
              <TokenFigure raw={amounts[i]} currency={currencies[i]} />
            </ChartTooltipRow>
          ) : null,
        )
      : null

  const overlay = (plot: Plot, index: number | null) => {
    const { x, y } = scales(plot)
    const bucket = index === null ? null : buckets[index]
    const share = bucket && bucket.seconds > 0 && !estimated ? bucket.inRange / bucket.seconds : null
    // Desktop: the chip in the gutter at the end's level. Phone: just above the end dot (earned only grows, so nothing is drawn there).
    const chipY = phone ? y(lastN) - 16 : y(lastN)
    return (
      <>
        {!zero && <LastValueChip yPct={(chipY / plot.height) * 100}>{lastText}</LastValueChip>}
        {bucket && (
          <ChartTooltip x={x(bucket.end)} plot={plot} head={bucketLabel(bucket.start, bucket.end)}>
            <ChartTooltipRow label="Fees earned">{`${valueFigure(view.basis, bucket.earnedIn)}${estimated ? ' est.' : ''}`}</ChartTooltipRow>
            {tokenRows(bucket.tokensIn)}
            {positive(bucket.collectedIn) && <ChartTooltipRow label="Collected">{valueFigure(view.basis, bucket.collectedIn)}</ChartTooltipRow>}
            {share !== null && <ChartTooltipRow label="Time in range">{percentText(share)}</ChartTooltipRow>}
            {share !== null && (share >= 1 || share <= 0) && (
              <span className="dm-fees-tip-pill">
                <Pill dot tone={share >= 1 ? 'in' : 'out'}>
                  {share >= 1 ? 'In range' : 'Out of range'}
                </Pill>
              </span>
            )}
          </ChartTooltip>
        )}
      </>
    )
  }

  const valueText = useMemo(
    () => (index: number) => {
      const bucket = buckets[index]
      return bucket ? `${bucketLabel(bucket.start, bucket.end)}, ${valueFigure(view.basis, bucket.earned)}${estimated ? ' est.' : ''}` : ''
    },
    [buckets, view.basis, estimated],
  )

  const indexAt = (px: number, plot: Plot) => {
    const t = start + ((px - plot.left) / Math.max(1, plot.right - plot.left)) * (end - start)
    const found = buckets.findIndex((bucket) => bucket.end >= t)
    return found === -1 ? buckets.length - 1 : found
  }

  return (
    <ChartFrame
      className="dm-fees-chart"
      height={height}
      padding={pad}
      label="Fees earned"
      points={buckets.length}
      indexAt={indexAt}
      valueText={valueText}
      onInspect={onInspect}
      revealKey={pv.period}
      axes={axes}
      series={series}
      inspect={inspect}
      overlay={overlay}
    />
  )
}
