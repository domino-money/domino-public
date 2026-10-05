import { useCallback, useContext, useMemo } from 'react'
import { XAxis } from '../../charts/Axis'
import { ChartFrame, type Plot } from '../../charts/ChartFrame'
import { ChartTooltip, ChartTooltipRow } from '../../charts/ChartTooltip'
import { Crosshair, useSvgId } from '../../charts/series'
import { Pill } from '../../ui'
import { TokenLabel } from '../../read/TokenLabel'
import { nearestIndex } from '../../../lib/chart/inspect'
import { linePath } from '../../../lib/chart/paths'
import { figureWidth, historyLine, placeLabels, priceDomain, readablePrice, statusWords, type HistoryVerdict, type LabelAsk, type RangeFacts } from '../../../lib/chart/priceRange'
import { logScale } from '../../../lib/chart/scale'
import { shortDate, shortTime } from '../../../lib/format/time'
import { useMediaQuery } from '../../../lib/useMediaQuery'
import { rem } from '../../../lib/rootScale'
import { PAD_BOTTOM, PAD_TOP, PLOT_HEIGHT, PLOT_HEIGHT_PHONE, RangeFactsContext, RangeHead } from './RangeStatus'
import { dateTicks, spacedTimeTicks } from './ticks'
import { usePoolHistory, type PoolHistory, type PoolHistoryAsk } from './usePoolHistory'

/** The labels' room at the plot's right: wide enough for the widest figure it shows, within these. */
const GUTTER_MIN = 76
const GUTTER_MAX = 128
const GUTTER_MAX_PHONE = 104
/** The price now's dot, clear of the plot's right edge, so it is always whole inside the plot. */
const NOW_INSET = 10
/** A Max or Min label (its word over its figure), and the price now's chip, as tall as they are drawn. */
const LABEL_SIZE = 30
const CHIP_SIZE = 36
/** The thinnest band drawn (px): a range far narrower than the price's moves stays a visible strip, centred on itself. */
const BAND_MIN = 4

/** What the line's words say, by the history's state (one short line, so the card never changes its height). */
function historyNote(history: PoolHistory, verdict: HistoryVerdict | null, openedAt: number | null, enabled: boolean): string {
  if (enabled && openedAt === null) return 'Opening time isn’t available yet. Showing the price now.'
  if (verdict?.kind === 'line') {
    const window = verdict.history.start === openedAt ? 'Since opened' : 'Last 7 days'
    return verdict.history.missing ? `${window} · Some hours are missing.` : `${window} · Hourly prices`
  }
  if (verdict?.kind === 'none') {
    if (verdict.reason === 'not_built') return 'Price history is still being collected.'
    if (verdict.reason === 'no_position_history' || verdict.reason === 'no_trades') return 'No price history since this position opened yet.'
    return 'Price history isn’t available yet.'
  }
  if (history.phase === 'reading') return 'Reading this position’s price history…'
  if (history.phase === 'failed') return 'Price history couldn’t load just now.'
  // A pool the read service keeps no history for (another chain, Uniswap v3): none will come.
  if (history.phase === 'off') return 'Price history isn’t available for this pool.'
  return 'Price history isn’t available yet.'
}

/**
 * Price vs range (DESIGN-V2 §12.1). Changed on purpose 2026-10-03 (the owner's point 10: "The Price range chart doesn't
 * work … Sometimes it sits way down at the bottom, sometimes it doesn't show the history … no beginner will understand
 * it"), redrawn for someone who knows nothing of liquidity pools:
 *  - one plain status first, in words and colour: "Earning fees — the price is inside your range", "Not earning — the
 *    price is above your range" (and how far it must move to come back), or "Closed";
 *  - the position's range as a Tangerine band whose two ends are labelled at the plot's right, "Max" and "Min" over
 *    their prices ("0" and "∞" at the pool's limits, where the band runs off the plot);
 *  - the pool's price over the last 7 days, hour by hour (read-v3 `history`, usePoolHistory.ts), green while inside the
 *    range and red while outside it (grey for a closed position), on a price axis that always holds the whole band and
 *    the whole line with room above and below (lib/chart/priceRange.ts priceDomain): nothing is pinned to an edge;
 *  - the price now as a dot at the line's end, always inside the plot, and a chip "Now" in the status colour;
 *  - every price written as the page's key figures write it (readablePrice: "0.0₆7101", "120,345", "2.5B").
 * Without a history (not listed, still collected, or a pool the read service keeps none for) the band and the price now
 * stand alone, with the price now as a level across the plot, and one short line says why. Everything but the line is
 * the page's own read (RangeFactsContext), drawn at once in the chart's final box; the line fills in when it arrives.
 * This module is its own chunk, loaded on a position's page only (PositionRange.tsx); its status and its box are
 * RangeStatus.tsx's, which the page draws in its place for the moment it loads.
 */
export function PriceVsRange({ history = null, openedAt = null }: { history?: PoolHistoryAsk | null; openedAt?: number | null }) {
  const facts = useContext(RangeFactsContext)
  return facts ? <PriceChart facts={facts} ask={history} openedAt={openedAt} /> : null
}

function PriceChart({ facts, ask, openedAt }: { facts: RangeFacts; ask: PoolHistoryAsk | null; openedAt: number | null }) {
  const { base, quote, lower, upper, lowerText, upperText, now, nowText, where } = facts
  const phone = useMediaQuery('(max-width: 767px)')
  const knownMint = openedAt !== null && Number.isSafeInteger(openedAt) && openedAt > 0 ? openedAt : null
  const history = usePoolHistory(knownMint === null ? null : ask)
  const verdict = useMemo<HistoryVerdict | null>(
    () => (history.phase === 'answered' ? historyLine(history.data, { base: base.address, quote: quote.address }, { lower, upper }, history.at / 1000, knownMint) : null),
    [history, base.address, quote.address, lower, upper, knownMint],
  )
  const line = verdict?.kind === 'line' ? verdict.history : null
  const points = useMemo(() => line?.points ?? [], [line])
  const drawn = line !== null
  const start = line?.start ?? 0
  const end = line?.end ?? 1
  const domain = useMemo(() => priceDomain(lower, upper, [now, ...(line ? line.runs.flat().map((point) => point.price) : [])]), [lower, upper, now, line])
  const xs = useMemo(() => points.map((point) => point.t), [points])
  const status = statusWords(facts)
  const tone = status.tone
  const closed = where === 'closed'
  const hasLower = lower > 0
  const hasUpper = Number.isFinite(upper)
  // The figures at the plot's right, as the key figures write them; an end written as its tick has none.
  const figures = { max: upperText === null ? null : readablePrice(upperText), min: lowerText === null ? null : readablePrice(lowerText), now: readablePrice(nowText) }
  const widest = [figures.max, figures.min, figures.now].reduce((most, text) => Math.max(most, text ? figureWidth(text) : 0), 0)
  const gutter = Math.min(phone ? GUTTER_MAX_PHONE : GUTTER_MAX, Math.max(GUTTER_MIN, 30 + widest))
  const inId = useSvgId('dm-pvr-in-')
  const outId = useSvgId('dm-pvr-out-')
  const bandId = useSvgId('dm-pvr-band-')

  const scales = useCallback(
    (plot: Plot) => ({
      x: (t: number) => plot.left + ((t - start) / Math.max(1, end - start)) * Math.max(0, plot.right - NOW_INSET - plot.left),
      y: logScale(domain, [plot.bottom, plot.top]),
    }),
    [start, end, domain],
  )

  /**
   * The band's two edges in px: a price end where it is (always inside the plot), an end at 0 or ∞ the plot's own edge;
   * a band thinner than BAND_MIN drawn that thick about its own middle.
   */
  const edges = useCallback(
    (plot: Plot) => {
      const { y } = scales(plot)
      const top = hasUpper ? y(upper) : plot.top
      const bottom = hasLower ? y(lower) : plot.bottom
      if (bottom - top >= BAND_MIN) return { top, bottom }
      const middle = (top + bottom) / 2
      return { top: middle - BAND_MIN / 2, bottom: middle + BAND_MIN / 2 }
    },
    [scales, hasUpper, hasLower, upper, lower],
  )

  const layer = useCallback(
    (plot: Plot) => {
      const { x, y } = scales(plot)
      const band = edges(plot)
      const runs = line ? line.runs.map((run) => run.map((point) => ({ x: x(point.t), y: y(point.price) }))) : []
      const paths = runs.filter((run) => run.length > 1).map((run) => linePath(run))
      const lone = runs.filter((run) => run.length === 1).map((run) => run[0])
      const wide = { x: plot.left - 8, width: plot.right - plot.left + 16 }
      const strokes = (kind: 'in' | 'out' | 'closed') => (
        <>
          {paths.map((d, index) => <path key={index} d={d} className="dm-pvr-line" data-tone={kind} />)}
          {lone.map((point, index) => <circle key={`d${index}`} cx={point.x} cy={point.y} r={2.5} className="dm-pvr-lone" data-tone={kind} />)}
        </>
      )
      return (
        <>
          <defs>
            <linearGradient id={bandId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--primary-line)" stopOpacity="0.11" />
              <stop offset="0.5" stopColor="var(--primary-line)" stopOpacity="0.035" />
              <stop offset="1" stopColor="var(--primary-line)" stopOpacity="0.085" />
            </linearGradient>
            {/* The line is green inside the band and red outside it: the same line twice, each clipped to its part of the plot. */}
            <clipPath id={inId}>
              <rect x={wide.x} y={band.top} width={wide.width} height={Math.max(0, band.bottom - band.top)} />
            </clipPath>
            <clipPath id={outId}>
              <rect x={wide.x} y={plot.top - 16} width={wide.width} height={Math.max(0, band.top - plot.top + 16)} />
              <rect x={wide.x} y={band.bottom} width={wide.width} height={Math.max(0, plot.bottom + 16 - band.bottom)} />
            </clipPath>
          </defs>
          <rect x={plot.left} y={band.top} width={Math.max(0, plot.right - plot.left)} height={Math.max(1, band.bottom - band.top)} rx={4} className="dm-pvr-band" style={{ fill: `url(#${bandId})`, fillOpacity: 1 }} />
          {line && start === knownMint && <line x1={plot.left} x2={plot.left} y1={plot.top} y2={plot.bottom} className="dm-position-chart-guide" data-pvr-mint-guide="" />}
          {hasUpper && <line x1={plot.left} x2={plot.right} y1={band.top} y2={band.top} className="dm-pvr-edge" data-edge="max" />}
          {hasLower && <line x1={plot.left} x2={plot.right} y1={band.bottom} y2={band.bottom} className="dm-pvr-edge" data-edge="min" />}
          {closed ? (
            strokes('closed')
          ) : (
            <>
              <g clipPath={`url(#${outId})`}>{strokes('out')}</g>
              <g clipPath={`url(#${inId})`}>{strokes('in')}</g>
            </>
          )}
        </>
      )
    },
    [scales, edges, line, closed, inId, outId, bandId, hasUpper, hasLower, start, knownMint],
  )

  const axes = useCallback(
    (plot: Plot) => {
      if (!drawn) return null
      const { x } = scales(plot)
      const ticks = dateTicks(start, end, Math.max(2, Math.floor((plot.right - plot.left) / 96)))
      const opened = start === knownMint
      const candidates = [...(opened ? [{ x: plot.left, label: 'Opened' }] : []), ...ticks.map((tick) => ({ x: x(tick.t), label: tick.label }))]
      return <XAxis ticks={spacedTimeTicks(candidates, plot.left, plot.right - NOW_INSET)} anchor={plot.bottom + 22} left={plot.left} right={plot.right - NOW_INSET} />
    },
    [scales, drawn, start, end, knownMint],
  )

  /** The labels at the plot's right: the range's Max and Min at its edges and the price now's chip, none over another. */
  const labels = (plot: Plot) => {
    const { y } = scales(plot)
    const band = edges(plot)
    const nowY = y(now)
    // Top to bottom: a price just at the range's top end is over it, so its chip goes first.
    const asks: (LabelAsk & { rank: number })[] = [
      ...(figures.max ? [{ key: 'max', at: band.top, size: LABEL_SIZE, rank: 1 }] : []),
      { key: 'now', at: nowY, size: CHIP_SIZE, fixed: true, rank: where === 'over' ? 0 : 2 },
      ...(figures.min ? [{ key: 'min', at: band.bottom, size: LABEL_SIZE, rank: 3 }] : []),
    ].sort((a, b) => a.at - b.at || a.rank - b.rank)
    const placed = placeLabels(asks, 2, plot.bottom + PAD_BOTTOM - 2)
    return { asks, placed, nowY }
  }

  const inspect = (plot: Plot, index: number | null) => {
    const { x, y } = scales(plot)
    const { asks, placed, nowY } = labels(plot)
    const nowX = plot.right - NOW_INSET
    const point = index === null || !drawn ? null : points[index]
    return (
      <>
        {/* Each label's short leader from its level at the plot's edge to where it sits. */}
        {asks.map((ask) => (
          <line key={ask.key} x1={plot.right} x2={plot.right + 6} y1={ask.at} y2={placed[ask.key]} className="dm-pvr-leader" data-leader={ask.key} data-tone={ask.key === 'now' ? tone : undefined} />
        ))}
        {/* The price now: a level across the plot while there is no line, a guide from the line's end otherwise, and the dot. */}
        <line x1={drawn ? nowX : plot.left} x2={plot.right} y1={nowY} y2={nowY} className="dm-pvr-now-line" data-tone={tone} />
        <circle cx={nowX} cy={nowY} r={5} className="dm-pvr-now-dot" data-tone={tone} />
        {point && (
          <>
            <Crosshair x={x(point.t)} top={plot.top} bottom={plot.bottom} left={plot.left} right={plot.right} />
            <circle cx={x(point.t)} cy={y(point.price)} r={5} className="dm-pvr-hover" data-tone={closed ? 'closed' : point.inRange ? 'in' : 'out'} />
          </>
        )}
      </>
    )
  }

  const overlay = (plot: Plot, index: number | null) => {
    const { x } = scales(plot)
    const { placed } = labels(plot)
    const left = plot.right + 8
    const point = index === null || !drawn ? null : points[index]
    const endLabel = (key: 'max' | 'min', word: string, figure: string | null, exact: string | null, open: boolean) =>
      figure !== null && exact !== null ? (
        <span className="dm-pvr-label" data-pvr-end={key} data-pvr-open={open ? '' : undefined} style={{ top: rem(placed[key]), left: rem(left) }}>
          <span className="dm-pvr-label-word">{word}</span>
          <span className="dm-pvr-label-fig" data-pvr-price={exact} title={exact}>
            {figure}
          </span>
        </span>
      ) : null
    return (
      <>
        {endLabel('max', 'Max', figures.max, upperText, !hasUpper)}
        {endLabel('min', 'Min', figures.min, lowerText, !hasLower)}
        <span className="dm-pvr-chip" data-tone={tone} style={{ top: rem(placed.now), left: rem(left) }}>
          <span className="dm-pvr-chip-word">Now</span>
          <span className="dm-pvr-chip-fig" data-pvr-now="" data-pvr-price={nowText} title={nowText}>
            {figures.now}
          </span>
        </span>
        {point && (
          <ChartTooltip x={x(point.t)} plot={plot} head={`${shortDate(point.t)} ${shortTime(point.t)}`}>
            <ChartTooltipRow label={<>1 <TokenLabel token={base} /></>}>
              {point.text} <TokenLabel token={quote} />
            </ChartTooltipRow>
            <span className="dm-fees-tip-pill">
              <Pill dot tone={point.inRange ? 'in' : 'out'}>
                {point.inRange ? 'Inside your range' : 'Outside your range'}
              </Pill>
            </span>
          </ChartTooltip>
        )}
      </>
    )
  }

  const words = `Your range ${lowerText ?? 'unknown'} to ${upperText ?? 'unknown'}; the price now ${nowText}, ${status.detail}`
  return (
    <div className="dm-pvr-wrap" data-pvr-where={where} data-pvr-line={drawn ? '' : undefined} data-pvr-history={ask && knownMint === null ? 'unknown_mint' : verdict?.kind === 'none' ? verdict.reason : history.phase} data-pvr-stale={line?.stale ? '' : undefined} data-pvr-opened={knownMint ?? undefined} data-pvr-start={line?.start} data-pvr-first={points[0]?.t}>
      <RangeHead facts={facts} />
      <ChartFrame
        className="dm-pvr"
        height={phone ? PLOT_HEIGHT_PHONE : PLOT_HEIGHT}
        padding={{ top: PAD_TOP, right: gutter, bottom: PAD_BOTTOM, left: 0 }}
        label={`Price range chart. ${words}.`}
        points={drawn ? points.length : 0}
        indexAt={(px, plot) => nearestIndex(xs, start + ((px - plot.left) / Math.max(1, plot.right - NOW_INSET - plot.left)) * (end - start))}
        valueText={(index) => `${shortDate(points[index].t)} ${shortTime(points[index].t)}, ${points[index].exact}, ${points[index].inRange ? 'inside' : 'outside'} your range`}
        revealKey={drawn ? 'line' : 'now'}
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
        {drawn && closed && (
          <span className="dm-pvr-key" data-key="price">
            <span aria-hidden="true" className="dm-pvr-swatch" />
            Price
          </span>
        )}
        {/* A key for each colour the line has. */}
        {drawn && !closed && points.some((point) => point.inRange) && (
          <span className="dm-pvr-key" data-key="in">
            <span aria-hidden="true" className="dm-pvr-swatch" />
            Price inside it
          </span>
        )}
        {drawn && !closed && points.some((point) => !point.inRange) && (
          <span className="dm-pvr-key" data-key="out">
            <span aria-hidden="true" className="dm-pvr-swatch" />
            Price outside it
          </span>
        )}
        {!drawn && (
          <span className="dm-pvr-key" data-key="now" data-tone={tone}>
            <span aria-hidden="true" className="dm-pvr-swatch" />
            Price now
          </span>
        )}
        <span className="dm-pvr-note" title={knownMint ? `Opened ${shortDate(knownMint)} ${shortTime(knownMint)}` : undefined}>{historyNote(history, verdict, knownMint, ask !== null)}</span>
      </div>
    </div>
  )
}
