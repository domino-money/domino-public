import type { ReactNode } from 'react'
import { ChartSkeleton } from '../../charts/ChartSkeleton'
import { useMediaQuery } from '../../../lib/useMediaQuery'
import { CHART_BOX } from './FeesChart'

/**
 * The fees module on its way (DESIGN-V2 §13.4): the hero, the split bar, its
 * two legend rows and the time-in-range row as bubbles, in the loaded
 * layout's order and heights, and the chart's wave. `unclaimed` is the real
 * on-chain Unclaimed row when the state is already known. aria-hidden
 * bubbles, no digits, no data-position-*.
 */
export function FeesSkeleton({ unclaimed }: { unclaimed?: ReactNode }) {
  // The loaded chart's own box (2026-09-27), so nothing moves when it is drawn in the skeleton's place.
  const phone = useMediaQuery('(max-width: 767px)')
  return (
    <div className="dm-fees-body" aria-busy="true">
      <div className="dm-fees-summary">
        <span aria-hidden="true" className="dm-fees-skel-hero">
          <span className="dm-skel" style={{ width: 180, height: 40 }} />
        </span>
        <span aria-hidden="true" className="dm-skel dm-fees-skel-bar" />
        <div className="dm-fees-legend">
          <span aria-hidden="true" className="dm-fees-skel-row">
            <span className="dm-skel" style={{ width: 88, height: 12 }} />
            <span className="dm-skel" style={{ width: 64, height: 12 }} />
          </span>
          {unclaimed ?? (
            <span aria-hidden="true" className="dm-fees-skel-row">
              <span className="dm-skel" style={{ width: 80, height: 12 }} />
              <span className="dm-skel" style={{ width: 72, height: 12 }} />
            </span>
          )}
        </div>
        <span aria-hidden="true" className="dm-fees-tir dm-fees-skel-tir">
          <span className="dm-fees-skel-row">
            <span className="dm-skel" style={{ width: 96, height: 12 }} />
            <span className="dm-skel" style={{ width: 56, height: 12 }} />
          </span>
          <span className="dm-skel dm-fees-skel-tirbar" />
        </span>
      </div>
      <ChartSkeleton height={phone ? CHART_BOX.phone : CHART_BOX.desktop} head={false} className="dm-fees-chart-skel" />
    </div>
  )
}
