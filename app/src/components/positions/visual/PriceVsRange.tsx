import { createContext, useCallback, useContext, useMemo } from 'react'
import type { ReactNode } from 'react'
import { XAxis } from '../../charts/Axis'
import { ChartFrame, type Plot } from '../../charts/ChartFrame'
import { ChartTooltip, ChartTooltipRow } from '../../charts/ChartTooltip'
import { Crosshair, HoverDot, LineSeries } from '../../charts/series'
import { Pill } from '../../ui'
import { TokenLabel } from '../../read/TokenLabel'
import { logScale } from '../../../lib/chart/scale'
import { nearestIndex } from '../../../lib/chart/inspect'
import type { FeeHistoryView, HourlyPrices, PositionState } from '../../../lib/fees/types'
import { useFeeHistory } from '../../../lib/fees/useFeeHistory'
import { shortAmount } from '../../../lib/format/amount'
import { group } from '../../../lib/format/decimal'
import { priceFromSqrt } from '../../../lib/format/price'
import { shortDate, shortTime } from '../../../lib/format/time'
import type { CardPoolPrice } from '../../../lib/read/screens/positions'
import type { TokenDisplay } from '../../../lib/read/types'
import type { LiveCard } from '../../../lib/walletCards'
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
  state: PositionState
}

/** A price at most six significant digits, grouped, nothing rounded up (`407.278`, `0.00245312`). */
function priceText(decimal: string): string {
  const [whole, fraction = ''] = decimal.split('.')
  return shortAmount(`${group(whole)}.${fraction}`).short
}

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
  return { points, gapAt, state }
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

/** Where the price is against the range, in the words the card writes above the chart; a closed position earns nothing wherever it is. */
type Where = 'inside' | 'under' | 'over' | 'closed'

/**
 * What the page's own read says of the range and the price now (2026-09-27, review): the chart draws them at once,
 * before any history, and writes them exactly as the header does, so one screen never shows two prices now.
 */
export interface RangeFacts {
  base: TokenDisplay
  quote: TokenDisplay
  /** The range's ends as prices, for geometry only: 0 and Infinity at the pool's limits. */
  lower: number
  upper: number
  /** The ends as the key figures write them (`161.959`); null at a limit or for an end written as its tick: no label. */
  lowerText: string | null
  upperText: string | null
  /** The price now as the key figures write it (`350.55`), and at its tick, for geometry. */
  now: number
  nowText: string
  where: Where
}

/**
 * A figure as the page's key figures write it (components/positions/KeyFigures.tsx `plain`): without its "≈" (the
 * integration, 2026-09-27: r5/position writes plain figures, and r5/charts' chip repeats the header's text exactly).
 */
const plain = (text: string) => (text.startsWith('≈') ? text.slice(1) : text)

/** The facts of a position's page, from its card and its pool price; null when a price or a decimal is missing (the page's bar stands in). */
export function rangeFacts(card: LiveCard, price: CardPoolPrice | null): RangeFacts | null {
  const [base, quote] = card.currencies
  if (price?.state !== 'usable' || base.decimals === null || quote.decimals === null) return null
  const shift = Math.pow(10, base.decimals - quote.decimals)
  const at = (tick: number) => Math.pow(1.0001, tick) * shift
  const { ends, tickLower, tickUpper } = card.range
  return {
    base,
    quote,
    lower: ends.lower.kind === 'limit' ? 0 : at(tickLower),
    upper: ends.upper.kind === 'limit' ? Infinity : at(tickUpper),
    lowerText: ends.lower.kind === 'price' ? plain(ends.lower.text) : null,
    upperText: ends.upper.kind === 'price' ? plain(ends.upper.text) : null,
    now: at(price.tick),
    nowText: plain(price.text),
    where: !card.hasLiquidity ? 'closed' : price.position === 'inside' ? 'inside' : price.position === 'below' ? 'under' : 'over',
  }
}

/** Handed down by the page's Price range (PositionRange) to the chart inside it. */
export const RangeFactsContext = createContext<RangeFacts | null>(null)

/**
 * The price axis: the prices drawn and the range's ends, each end held within four times the prices' own span (a
 * range far off is drawn to the edge rather than flattening the line). An end at 0 or ∞ is no end to reach: the band
 * runs off that edge, with a quarter beyond its other end kept in view so it reads as a band, not a hairline.
 */
function domainOf(prices: readonly number[], lower: number, upper: number): [number, number] {
  const lo = Math.min(...prices)
  const hi = Math.max(...prices)
  const open = [lower > 0 && !Number.isFinite(upper) ? lower * 1.25 : 0, upper > 0 && Number.isFinite(upper) && !(lower > 0) ? upper / 1.25 : 0]
  const ends = [lower, upper, ...open].filter((end) => end > 0 && Number.isFinite(end)).map((end) => Math.min(hi * 4, Math.max(lo / 4, end)))
  const floor = Math.min(lo, ...ends)
  const ceiling = Math.max(hi, ...ends)
  const span = Math.log(ceiling / floor) || 0.02
  return [floor / Math.exp(span * 0.14), ceiling * Math.exp(span * 0.14)]
}

const SAYS: Readonly<Record<Where, string>> = {
  inside: 'The price is inside your range, so this position is earning fees.',
  under: 'The price is under your range, so this position is not earning fees right now.',
  over: 'The price is over your range, so this position is not earning fees right now.',
  closed: 'This position is closed, so it is not earning fees.',
}

/** Room kept between the chip of the price now and a range end's number in the gutter. */
const CHIP_ROOM = 20

/**
 * Price vs range (DESIGN-V2 §12.1, redrawn 2026-09-27 for someone who knows
 * nothing of liquidity pools, the owner's "péssimo"): the position's range as
 * a calm band, the pool's hourly closes as a line over it (Tangerine while
 * inside the range, a muted ink outside), and the price now as a dot and a
 * chip at the right, green while it earns fees and red while it does not.
 * One plain sentence above the plot says which; a legend under it names the
 * band ("Your range") and the line, and writes the unit once ("Prices in UFG
 * for 1 USDG"). A log price axis: equal steps are equal moves in percent, so
 * the band keeps its true shape; the only numbers on it are the range's two
 * ends, at its edges, and the price now. The tooltip says the hour, the price as
 * "1 USDG = 332.36 UFG" and in range or out.
 *
 * 2026-09-27 (review): everything but the line is the page's own read (RangeFactsContext), drawn at once in the
 * chart's final box, with no `series` (no history yet, or none that can be drawn); the hourly line fills in when the
 * history arrives. The price now and the range's ends are the key figures' own texts ("350.55"; nothing at 0 or ∞), and
 * an end whose edge lies beyond the plot is not labelled (the band runs to the edge).
 */
export function PriceVsRange({ series }: { series: PriceSeries | null; unit?: ReactNode }) {
  const facts = useContext(RangeFactsContext)
  return facts ? <PriceChart facts={facts} series={series} /> : null
}

function PriceChart({ facts, series }: { facts: RangeFacts; series: PriceSeries | null }) {
  const { base, quote, lower, upper, lowerText, upperText, now, nowText, where } = facts
  const phone = useMediaQuery('(max-width: 767px)')
  // The line, its last point the price now as the header has it (one price now on the screen).
  const points = useMemo(() => (series ? [...series.points.slice(0, -1), { ...series.points[series.points.length - 1], price: now, text: nowText, inRange: where === 'inside' }] : []), [series, now, nowText, where])
  const gapAt = series?.gapAt ?? -1
  const drawn = points.length > 1
  const start = drawn ? points[0].t : 0
  const end = drawn ? points[points.length - 1].t : 1
  const domain = useMemo(() => domainOf(drawn ? points.map((point) => point.price) : [now], lower, upper), [drawn, points, now, lower, upper])
  const xs = useMemo(() => points.map((point) => point.t), [points])
  const earning = where === 'inside'
  // The gutter holds the chip of the price now clear of its dot: wide enough for its text (about 7px a character at 12px, and its padding).
  const gutter = Math.max(phone ? 64 : 76, 22 + 7 * nowText.length)
  const hasLower = lower > 0
  const hasUpper = Number.isFinite(upper)

  const scales = useCallback(
    (plot: Plot) => ({
      x: (t: number) => plot.left + ((t - start) / Math.max(1, end - start)) * (plot.right - plot.left),
      y: logScale(domain, [plot.bottom, plot.top]),
    }),
    [start, end, domain],
  )

  /** The band's two edges in px, each held inside the plot, and whether it is truly there (a range far off runs to the edge). */
  const edges = useCallback(
    (plot: Plot) => {
      const { y } = scales(plot)
      const top = hasUpper ? y(upper) : -Infinity
      const bottom = hasLower ? y(lower) : Infinity
      return {
        top: Math.min(plot.bottom, Math.max(plot.top, top)),
        bottom: Math.min(plot.bottom, Math.max(plot.top, bottom)),
        topShown: top >= plot.top && top <= plot.bottom,
        bottomShown: bottom >= plot.top && bottom <= plot.bottom,
      }
    },
    [scales, hasUpper, hasLower, upper, lower],
  )

  const layer = useCallback(
    (plot: Plot) => {
      const { x, y } = scales(plot)
      const band = edges(plot)
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
      const nowX = drawn ? x(end) : plot.right
      const nowY = y(now)
      return (
        <>
          <rect x={plot.left} y={band.top} width={Math.max(0, plot.right - plot.left)} height={Math.max(0, band.bottom - band.top)} rx={6} className="dm-pvr-band" />
          {band.topShown && <line x1={plot.left} x2={plot.right} y1={band.top} y2={band.top} className="dm-pvr-edge" />}
          {band.bottomShown && <line x1={plot.left} x2={plot.right} y1={band.bottom} y2={band.bottom} className="dm-pvr-edge" />}
          {drawn && <LineSeries segments={runs.filter((run) => !run.inRange).map((run) => run.pts)} tone="neutral" />}
          {drawn && <LineSeries segments={runs.filter((run) => run.inRange).map((run) => run.pts)} tone="primary" />}
          {/* The price now: a dotted guide to the chip in the gutter, and the dot. */}
          <line x1={nowX} x2={plot.right + 6} y1={nowY} y2={nowY} className="dm-pvr-now-line" data-in={earning ? '' : undefined} data-closed={where === 'closed' ? '' : undefined} />
          <circle cx={nowX} cy={nowY} r={4.5} className="dm-pvr-now-dot" data-in={earning ? '' : undefined} data-closed={where === 'closed' ? '' : undefined} />
        </>
      )
    },
    [scales, edges, points, gapAt, drawn, end, now, earning, where],
  )

  const axes = useCallback(
    (plot: Plot) => {
      if (!drawn) return null
      const { x } = scales(plot)
      return <XAxis ticks={dateTicks(start, end, Math.max(3, Math.floor((plot.right - plot.left) / 110))).map((tick) => ({ x: x(tick.t), label: tick.label }))} anchor={plot.bottom + 22} left={plot.left} right={plot.right} />
    },
    [scales, drawn, start, end],
  )

  const inspect = (plot: Plot, index: number | null) => {
    if (index === null || !drawn) return null
    const { x, y } = scales(plot)
    const point = points[index]
    return (
      <>
        <Crosshair x={x(point.t)} top={plot.top} bottom={plot.bottom} left={plot.left} right={plot.right} />
        <HoverDot x={x(point.t)} y={y(point.price)} />
      </>
    )
  }

  const overlay = (plot: Plot, index: number | null) => {
    const { x, y } = scales(plot)
    const band = edges(plot)
    const nowY = y(now)
    const point = index === null || !drawn ? null : points[index]
    // The gutter's numbers: the range's two ends at its edges (the only prices on the axis), and the price now in its
    // chip; an end the chip would cover steps just clear of it, on its own side (the price just under a range keeps
    // the range's floor readable above it). An end beyond the plot, or at 0 or ∞, has no number.
    const clear = (at: number) => (Math.abs(at - nowY) >= CHIP_ROOM ? at : at > nowY ? nowY + CHIP_ROOM : nowY - CHIP_ROOM)
    const ends = [
      { key: 'max', text: band.topShown ? upperText : null, top: Math.min(band.top, band.bottom - CHIP_ROOM) },
      { key: 'min', text: band.bottomShown ? lowerText : null, top: band.bottom },
    ].flatMap((one) => (one.text ? [{ key: one.key, text: one.text, top: clear(one.top) }] : []))
    return (
      <>
        {ends.map((one) => (
          <span key={one.key} className="dm-pvr-end" data-pvr-end={one.key} style={{ top: one.top }}>
            {one.text}
          </span>
        ))}
        <span className="dm-pvr-chip" data-in={earning ? '' : undefined} data-closed={where === 'closed' ? '' : undefined} style={{ top: nowY }} data-pvr-now="">
          <span>{nowText}</span>
        </span>
        {point && (
          <ChartTooltip x={x(point.t)} plot={plot} head={`${shortDate(point.t)} ${shortTime(point.t)}`}>
            <ChartTooltipRow label={<>1 <TokenLabel token={base} /></>}>
              {point.text} <TokenLabel token={quote} />
            </ChartTooltipRow>
            <span className="dm-fees-tip-pill">
              <Pill dot tone={point.inRange ? 'in' : 'out'}>
                {point.inRange ? 'In range' : 'Out of range'}
              </Pill>
            </span>
          </ChartTooltip>
        )}
      </>
    )
  }

  return (
    <div className="dm-pvr-wrap" data-pvr-where={where} data-pvr-line={drawn ? '' : undefined}>
      <p className="dm-pvr-says">
        {where === 'closed' ? (
          <Pill dot>Closed</Pill>
        ) : (
          <Pill dot tone={earning ? 'in' : 'out'}>
            {earning ? 'In range' : 'Out of range'}
          </Pill>
        )}
        <span>{SAYS[where]}</span>
      </p>
      <ChartFrame
        className="dm-pvr"
        height={phone ? 180 : 208}
        padding={{ top: 12, right: gutter, bottom: 30, left: 0 }}
        label="Price range"
        points={drawn ? points.length : 0}
        indexAt={(px, plot) => nearestIndex(xs, start + ((px - plot.left) / Math.max(1, plot.right - plot.left)) * (end - start))}
        valueText={(index) => `${shortDate(points[index].t)} ${shortTime(points[index].t)}, ${points[index].text}`}
        revealKey={drawn ? 'price' : 'now'}
        axes={axes}
        series={layer}
        inspect={inspect}
        overlay={overlay}
      />
      <div className="dm-pvr-legend">
        <span className="dm-pvr-key" data-key="range">
          <span aria-hidden="true" className="dm-pvr-swatch" />
          Your range
        </span>
        <span className="dm-pvr-key" data-key="price">
          <span aria-hidden="true" className="dm-pvr-swatch" />
          Price
        </span>
        <span className="dm-pvr-unit">
          Prices in <TokenLabel token={quote} /> for 1 <TokenLabel token={base} />
        </span>
      </div>
    </div>
  )
}
