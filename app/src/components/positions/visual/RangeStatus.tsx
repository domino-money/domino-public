import { createContext, type CSSProperties } from 'react'
import { statusWords, type RangeFacts } from '../../../lib/chart/priceFacts'
import { useMediaQuery } from '../../../lib/useMediaQuery'
import { rem } from '../../../lib/rootScale'
import { TokenLabel } from '../../read/TokenLabel'
import { Skeleton } from '../../ui'
import { positionPlotHeight, usePositionChartOptions } from '../PositionChartOptions'

/**
 * The Price range card's own parts that load with the page (2026-10-03, the owner's point 10): the page's facts handed
 * down to the chart, the chart's box, its status and unit, and what stands in the chart's place while its code loads.
 * The chart itself (PriceVsRange.tsx, its axis, labels and line, and the pool's history) is its own chunk, loaded on a
 * position's page only (PositionRange.tsx), so the Positions list and the screens around it never carry it.
 */

/**
 * (QA round 2, N69) The pool chart's own shimmer (pool.css .dm-pool-plot-baseline: its wave under the skeleton sweep), in
 * the box of a Price range chart that has nothing to draw yet: while its code loads, and while the pool's history is first
 * read. First load only: an answered history is kept through every refresh, so it never comes back; a read that fails
 * leaves the box quietly empty, as before. `style` places it (the plot's own rectangle, or the whole box).
 */
export function RangeSkeleton({ style }: { style?: CSSProperties }) {
  return (
    <div aria-hidden="true" className="dm-pool-plot-empty" data-pvr-skeleton="" style={{ minHeight: 0, padding: 0, ...style }}>
      <Skeleton className="dm-pool-plot-baseline" />
    </div>
  )
}

/** Handed down by the page's Price range (PositionRange) to the chart inside it. */
export const RangeFactsContext = createContext<RangeFacts | null>(null)

/** The chart's box (px): its plot's height on a desktop and on a phone, and the room above it and under it for the dates. */
// V4 (2026-10-17, site/position.html .c-range): 300 design px, 420 expanded (360 on a phone); a Base or Arbitrum
// position's recorded chart (position-base.html) 260, 380 expanded.
export const PLOT_HEIGHT = 300
export const PLOT_HEIGHT_PHONE = 300
export const PLOT_BIG = 420
export const PLOT_BIG_PHONE = 360
export const RECORDED_PLOT = 260
export const RECORDED_BIG = 380
export const PAD_TOP = 16
export const PAD_BOTTOM = 30
/** The chart's whole box (design px), which the frame that waits for it keeps. */
export const rangeChartBox = (phone: boolean, expanded: boolean, recorded = false) => PAD_TOP + rangePlotHeight(phone, expanded, recorded) + PAD_BOTTOM
/** The plot's height for this chart: Robinhood's, or a recorded (Base, Arbitrum) one's; expanded, its larger one. */
export const rangePlotHeight = (phone: boolean, expanded: boolean, recorded = false) => recorded
  ? positionPlotHeight(RECORDED_PLOT, phone, expanded, RECORDED_BIG)
  : positionPlotHeight(phone ? PLOT_HEIGHT_PHONE : PLOT_HEIGHT, phone, expanded, phone ? PLOT_BIG_PHONE : PLOT_BIG)

/**
 * The card's one plain status, in words and colour (lib/chart/priceFacts.ts statusWords): "Earning fees — the price is
 * inside your range", "Not earning — the price is above your range" and how far it must move to come back, or
 * "Closed"; then the unit every price on the card is in.
 */
export function RangeHead({ facts }: { facts: RangeFacts }) {
  const status = statusWords(facts)
  return (
    <div className="dm-pvr-head">
      <div className="dm-pvr-status" data-tone={status.tone}>
        <p className="dm-pvr-says">
          <span aria-hidden="true" className="dm-pvr-status-dot" />
          <span>
            <strong>{status.title}</strong><span className="sr-only"> — {status.detail}</span>
          </span>
        </p>
        {status.move && <p className="dm-pvr-move">{status.move}</p>}
      </div>
      <p className="dm-pvr-unit">
        <TokenLabel token={facts.quote} /> per <TokenLabel token={facts.base} />
      </p>
    </div>
  )
}

/**
 * The chart's place while its code loads (a moment, and only the first time: a position's page asks for it as soon as
 * it opens): the same status and unit, an empty box of the chart's own height and its legend's line, so nothing on the
 * page moves when the chart arrives. `failed`: the place of a chart whose code could not load (2026-10-15, pack 7: it no
 * longer says so).
 */
export function RangeChartWaiting({ facts, failed = false, recorded = false }: { facts: RangeFacts; failed?: boolean; recorded?: boolean }) {
  const phone = useMediaQuery('(max-width: 767px)')
  const { expanded } = usePositionChartOptions()
  return (
    <div className="dm-pvr-wrap" data-pvr-waiting={failed ? undefined : ''} data-pvr-unavailable={failed ? '' : undefined} aria-busy={failed ? undefined : true}>
      <RangeHead facts={facts} />
      {/* In design px through rem, as ChartFrame sizes the chart that replaces it (lib/rootScale.ts), so nothing moves. */}
      <div className="dm-pvr" style={{ height: rem(rangeChartBox(phone, expanded, recorded)) }}>
        {!failed && <RangeSkeleton style={{ height: '100%' }} />}
      </div>
      <div className="dm-pvr-legend">
        <span className="dm-pvr-key" data-key="range">
          <span aria-hidden="true" className="dm-pvr-swatch" />
          Your range
        </span>
        {/* Changed on purpose 2026-10-15 (pack 7, the owner: no status notices): the legend's line stays, empty; it said "Reading this position’s price history…", or why the chart could not load. */}
        <span className="dm-pvr-note" />
      </div>
    </div>
  )
}
