import { useCallback, useMemo } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { YAxis, XAxis } from '../../charts/Axis'
import { ChartFrame, type Plot } from '../../charts/ChartFrame'
import { ChartTooltip, ChartTooltipRow } from '../../charts/ChartTooltip'
import { Baseline, Crosshair, EndDot, EventPips, HoverDot, LastValue, LastValueChip, useSvgId } from '../../charts/series'
import { linearScale, niceTicks } from '../../../lib/chart/scale'
import { areaPath, linePath, type Point } from '../../../lib/chart/paths'
import { group } from '../../../lib/format/decimal'
import { bucketLabel, shortDate, shortTime } from '../../../lib/format/time'
import { formatUsd } from '../../../lib/format/usd'
import type { AutoAdd } from '../../../lib/automationImpact'
import { useMediaQuery } from '../../../lib/useMediaQuery'
import { TokenFigure } from './FeesActivity'
import type { FeesPeriodView, FeesView } from './model'
import { dateTicks } from './ticks'
import { positive, unitsNumber, valueFigure } from './value'

/**
 * The plot's room. Desktop: the y labels and the last-value chip in a gutter
 * at the right, the dates under the plot. Phone: no
 * gutter (§13.2, padding right 8): the y labels sit inside the plot and the
 * chip rides above the end dot, in the room left at the top.
 */
const PAD = { top: 16, right: 72, bottom: 40, left: 0 }
const PAD_PHONE = { top: 32, right: 8, bottom: 40, left: 0 }
const HEIGHT = 232
const HEIGHT_PHONE = 200
/** The drawn chart's whole box, which its skeleton and its quiet plot keep (2026-09-27: nothing moves when it arrives). */
export const CHART_BOX = { desktop: PAD.top + HEIGHT + PAD.bottom, phone: PAD_PHONE.top + HEIGHT_PHONE + PAD_PHONE.bottom } as const
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

const NONE: readonly AutoAdd[] = []

/**
 * Time in range in whole percents (audit E21, 2026-10-01: "100.00%" claimed a precision an hourly history does not
 * have). Never "100%" unless all of it, never "0%" unless none: a share in between reads 99% at most and "<1%" at least.
 */
export function percentText(share: number): string {
  const s = Math.min(1, Math.max(0, share))
  if (s === 1 || s === 0) return `${s * 100}%`
  const whole = Math.round(s * 100)
  return whole >= 100 ? '99%' : whole === 0 ? '<1%' : `${whole}%`
}

/** How many date labels a plot this wide carries: at least three, about one per 110px. */
const dateCount = (plot: Plot) => Math.max(3, Math.floor((plot.right - plot.left) / 110))

/** The zero timeline's two ends, in the activity rows' caption style: `09-23 01:09 UTC`. */
const edgeLabel = (t: number) => `${shortDate(t)} ${shortTime(t)}`

/** The earned value on the drawn line at `t` (linear between measured points), where an event's pip or mark sits. */
function lineAt(points: FeesPeriodView['points'], t: number): number {
  const next = points.findIndex((point) => point.t >= t)
  if (next <= 0) return points[next === 0 ? 0 : points.length - 1].v
  const a = points[next - 1]
  const b = points[next]
  return b.t > a.t ? a.v + ((b.v - a.v) * (t - a.t)) / (b.t - a.t) : b.v
}

/**
 * The collected line as steps: flat between settlements, rising at the settlement itself (the first one inside the
 * hour that holds the rise, else the hour's end), never above the earned line; the green band then closes where a
 * collect's pip or Auto-compound's mark sits, as the fees it collected stop waiting.
 */
function collectedSteps(points: FeesPeriodView['points'], settled: readonly number[]): { t: number; c: number }[] {
  const out = [{ t: points[0].t, c: Math.min(points[0].c, points[0].v) }]
  for (let i = 1; i < points.length; i++) {
    const before = points[i - 1]
    const point = points[i]
    if (point.c > before.c) {
      const at = settled.find((t) => t > before.t && t <= point.t) ?? point.t
      out.push({ t: at, c: Math.min(before.c, before.v) }, { t: at, c: Math.min(point.c, lineAt(points, at)) })
    }
    out.push({ t: point.t, c: Math.min(point.c, point.v) })
  }
  return out
}

/**
 * Auto-compound's mark (2026-09-27): a Tangerine disc with a plus, ringed in the card's colour, where it put fees back
 * into the position; the legend row under the card's split names it with the same disc.
 */
export function AutoMark({ x, y, index = 0, active = false }: { x: number; y: number; index?: number; active?: boolean }) {
  return (
    <g className="dm-fees-auto" transform={`translate(${Math.round(x * 100) / 100} ${Math.round(y * 100) / 100})`} data-active={active ? '' : undefined} style={{ '--i': index } as CSSProperties}>
      <circle r={10} className="dm-fees-auto-halo" />
      <circle r={6.5} className="dm-fees-auto-dot" />
      <path d="M-2.75 0H2.75M0 -2.75V2.75" className="dm-fees-auto-plus" />
    </g>
  )
}

/**
 * Fees earned, collected and waiting (2026-09-27): the part already collected as a Tangerine area, what is still
 * waiting to be collected as a green band over it (the legend's two colours), and everything earned as the line on top.
 */
function Split({ earned, collected, baseline }: { earned: readonly Point[]; collected: readonly Point[]; baseline: number }) {
  const id = useSvgId('dm-fees-area-')
  if (earned.length < 2) return null
  const band = `${linePath(earned, 'linear')} ${linePath([...collected].reverse(), 'linear').replace(/^M/, 'L')} Z`
  return (
    <g>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="dm-stop-top" />
          <stop offset="0.55" className="dm-stop-mid" />
          <stop offset="1" className="dm-stop-bottom" />
        </linearGradient>
        <linearGradient id={`${id}w`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" className="dm-fees-wait-top" />
          <stop offset="1" className="dm-fees-wait-bottom" />
        </linearGradient>
      </defs>
      <path d={areaPath(collected, 'linear', baseline)} fill={`url(#${id})`} className="dm-fees-collected" />
      <path d={band} fill={`url(#${id}w)`} className="dm-fees-waiting" />
      <path d={linePath(earned, 'linear')} className="dm-series-glow" />
      <path d={linePath(earned, 'linear')} className="dm-series-line" />
    </g>
  )
}

/**
 * The fees chart (DESIGN-V2 §13.2): everything earned since the mint as a
 * Tangerine line through its measured points (earned only grows), the part
 * of it already collected as a soft Tangerine area and the part still waiting
 * as a green band (2026-09-27: the legend's colours, so the split reads on the
 * chart itself), the settlements as pips, Auto-compound's re-adds as their
 * own marks, the end dot and the current total in a chip. The y axis always
 * names its floor, so the line reads as growth from there. Inspection snaps
 * to the measured points; the series layer never sees the inspected one.
 * With nothing earned yet (`zero`) it is a timeline waiting for its first
 * fee: the real flat line in a quiet ink from the mint pip to the end dot at
 * now, and the two dates it spans.
 *
 * Changed on purpose 2026-10-02 (RPC-SPEC §11.4: the history is the position's ledger): measured points only (opened,
 * each settlement, this browser's reads, now), each stretch between two of them one inspection; the straight line
 * between two is a guide, not a measurement. No in-range strip: it needed every hour of the pool. The period (24H, 7D,
 * 30D or All, back the same day) is the card's: `pv` starts at its measured start, whose earned value is the floor, and
 * a new period cross-fades in (`revealKey`).
 */
export function FeesChart({
  view,
  pv,
  onInspect,
  zero,
  automation,
}: {
  view: FeesView
  pv: FeesPeriodView
  onInspect: (index: number | null) => void
  zero: boolean
  /** The automation's re-adds (lib/automationImpact.ts), marked where they happened, its name for the tooltip and whether its fees are the ones paid. */
  automation?: { adds: readonly AutoAdd[]; by: string; exactFees: boolean }
}) {
  const adds = automation?.adds ?? NONE
  const phone = useMediaQuery('(max-width: 767px)')
  const height = zero ? (phone ? HEIGHT_ZERO_PHONE : HEIGHT_ZERO) : phone ? HEIGHT_PHONE : HEIGHT
  const pad = zero ? (phone ? PAD_ZERO_PHONE : PAD_ZERO) : phone ? PAD_PHONE : PAD
  const { start, end, buckets } = pv
  const baseN = unitsNumber(pv.base)
  const lastN = unitsNumber(pv.last)
  // Room above the line on a desktop (the chip sits in the gutter); on a phone the chip rides above the end, in the top padding.
  const headroom = phone ? 1.02 : 1.12
  // Nothing earned: the flat line lies on the plot's foot (the floor at the bottom, one unit of room above it).
  const topN = lastN > baseN ? baseN + (lastN - baseN) * headroom : baseN + 1
  const bottomN = baseN
  const currencies = view.sources[0].state.currencies
  // Auto-compound's re-adds inside the period, and the manual settlements' pips (a re-add's own collect is its mark). A
  // period that starts at a re-add has it in its floor already, as its pip (model.ts periodView).
  const all = pv.period === 'all'
  const marks = useMemo(() => adds.filter((add) => (all ? add.timestamp >= start : add.timestamp > start) && add.timestamp <= end), [adds, start, end, all])
  const automatic = useMemo(() => new Set(adds.map((add) => add.tx)), [adds])

  const scales = useCallback(
    (plot: Plot) => ({
      x: linearScale([start, Math.max(end, start + 1)], [plot.left, plot.right]),
      y: linearScale([bottomN, topN], [plot.bottom, plot.top]),
    }),
    [start, end, bottomN, topN],
  )

  const series = useCallback(
    (plot: Plot) => {
      const { x, y } = scales(plot)
      const line = pv.points.map((point) => ({ x: x(point.t), y: y(point.v) }))
      // The collected part never reads below the period's floor: what was collected before it is under the floor too.
      const settled = pv.events.filter((event) => event.kind !== 'mint').map((event) => event.t).sort((a, b) => a - b)
      const collected = collectedSteps(pv.points, settled).map((point) => ({ x: x(point.t), y: y(Math.max(bottomN, point.c)) }))
      const endPoint = line[line.length - 1]
      const pips = (
        <EventPips
          events={pv.events
            .filter((event) => event.kind === 'mint' || !automatic.has(event.tx))
            .map((event) => ({ x: x(event.t), y: y(event.kind === 'mint' ? event.v : lineAt(pv.points, event.t)), kind: event.kind }))}
        />
      )
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
          <Split earned={line} collected={collected} baseline={plot.bottom} />
          {pips}
          {marks.map((add, index) => (
            <AutoMark key={add.tx} x={x(add.timestamp)} y={y(lineAt(pv.points, add.timestamp))} index={index} />
          ))}
          {endPoint && <EndDot x={endPoint.x} y={endPoint.y} />}
        </>
      )
    },
    [scales, pv, zero, bottomN, marks, automatic],
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
      const xAxis = <XAxis ticks={dates} anchor={plot.bottom + 32} left={plot.left} right={plot.right} />
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

  /** The re-adds inside a bucket (the last bucket holds its end). */
  const addsIn = (index: number) => {
    const bucket = buckets[index]
    if (!bucket) return []
    const last = index === buckets.length - 1
    return marks.filter((add) => add.timestamp >= bucket.start && (add.timestamp < bucket.end || (last && add.timestamp <= bucket.end)))
  }

  const inspect = (plot: Plot, index: number | null) => {
    const { x, y } = scales(plot)
    const endX = x(end)
    const endY = y(lastN)
    const bucket = index === null ? null : buckets[index]
    const here = index === null ? [] : addsIn(index)
    return (
      <>
        {!zero && !phone && <LastValue x0={endX} x1={plot.width - 8} y={endY} />}
        {bucket && (
          <>
            <Crosshair x={x(bucket.end)} y={y(unitsNumber(bucket.earned))} top={plot.top} bottom={plot.bottom} left={plot.left} right={plot.right} />
            {here.map((add) => (
              <AutoMark key={add.tx} x={x(add.timestamp)} y={y(lineAt(pv.points, add.timestamp))} active />
            ))}
            <HoverDot x={x(bucket.end)} y={y(unitsNumber(bucket.earned))} />
          </>
        )}
        {phone && !zero && insideLabels(plot)}
      </>
    )
  }

  const tokenRows = (amounts: readonly [bigint, bigint] | null): ReactNode =>
    amounts
      ? ([0, 1] as const).map((i) =>
          positive(amounts[i]) ? (
            <ChartTooltipRow key={i} label={symbolOf(currencies[i])}>
              <TokenFigure raw={amounts[i]} currency={currencies[i]} />
            </ChartTooltipRow>
          ) : null,
        )
      : null

  /** Auto-compound's words for a bucket's re-adds: what it put back, and its fee on them. */
  const autoNote = (here: readonly AutoAdd[]) => {
    if (here.length === 0) return null
    const value = here.reduce((sum, add) => sum + add.value, 0n)
    const fee = here.reduce((sum, add) => sum + add.fee, 0n)
    const quote = view.basis.kind === 'quote' ? ` ${symbolOf(currencies[view.basis.into])}` : ''
    return (
      <div className="dm-fees-tip-auto" data-fees-auto-tip="">
        <span className="dm-fees-tip-auto-text">
          {automation?.by} added {valueFigure(view.basis, value)}
          {quote} back into your position{here.length > 1 ? ` (${here.length} times)` : ''}.
        </span>
        {positive(fee) && (
          <span className="dm-fees-tip-auto-fee">
            Service fee {automation?.exactFees ? '' : '≈'}
            {valueFigure(view.basis, fee)}
            {quote}
          </span>
        )}
      </div>
    )
  }

  const overlay = (plot: Plot, index: number | null) => {
    const { x, y } = scales(plot)
    const bucket = index === null ? null : buckets[index]
    // Desktop: the chip in the gutter at the end's level. Phone: just above the end dot (earned only grows, so nothing is drawn there).
    const chipY = phone ? y(lastN) - 16 : y(lastN)
    return (
      <>
        {!zero && <LastValueChip yPct={(chipY / plot.height) * 100}>{lastText}</LastValueChip>}
        {bucket && index !== null && (
          <ChartTooltip x={x(bucket.end)} plot={plot} head={bucketLabel(bucket.start, bucket.end)}>
            <ChartTooltipRow label="Fees earned">{valueFigure(view.basis, bucket.earnedIn)}</ChartTooltipRow>
            {tokenRows(bucket.tokensIn)}
            {positive(bucket.collectedIn) && <ChartTooltipRow label="Collected">{valueFigure(view.basis, bucket.collectedIn)}</ChartTooltipRow>}
            {autoNote(addsIn(index))}
          </ChartTooltip>
        )}
      </>
    )
  }

  const valueText = useMemo(
    () => (index: number) => {
      const bucket = buckets[index]
      return bucket ? `${bucketLabel(bucket.start, bucket.end)}, ${valueFigure(view.basis, bucket.earned)}` : ''
    },
    [buckets, view.basis],
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
