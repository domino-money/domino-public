import type { ReactNode } from 'react'
import { tooltipSide } from '../../lib/chart/inspect'
import type { Plot } from './ChartFrame'
import { rem } from '../../lib/rootScale'

/**
 * The chart tooltip (DESIGN-V2 §4.4), in a ChartFrame's overlay: 12px right of
 * the inspected x and 8px under the plot's top; past 55 % of the width it
 * flips to the left. No measuring, no state, no exit animation; it fades in
 * once when inspection starts. Line 1 (`head`) is the date or bucket range;
 * then label/value rows (ChartTooltipRow). Placed in rem: the plot is in design px (ChartFrame).
 */
export function ChartTooltip({ x, plot, head, children }: { x: number; plot: Plot; head?: ReactNode; children?: ReactNode }) {
  return (
    <div className="dm-chart-tooltip" data-side={tooltipSide(x, plot.width)} style={{ left: rem(x + 12), top: rem(plot.top + 8) }}>
      {head && <div className="dm-chart-tooltip-head">{head}</div>}
      {children}
    </div>
  )
}

/** One label and its value, the value right-aligned and tabular. */
export function ChartTooltipRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="dm-chart-tooltip-row">
      <span>{label}</span>
      <span>{children}</span>
    </div>
  )
}
