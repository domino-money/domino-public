import { rem } from '../../lib/rootScale'

/**
 * A chart on its way (DESIGN-V2 §4.5): a fixed wave under the shimmer, three
 * y-tick and four x-tick bubbles. The figure above the chart has its own skeleton.
 * aria-hidden; no digits, no axis text, never a data-metric. `height` is in design px, drawn in rem.
 */
export function ChartSkeleton({ height }: { height: number }) {
  return (
    <div aria-hidden="true" className="dm-chart-skel dm-fees-chart-skel" data-axes="true">
      <div className="dm-chart-skel-plot" style={{ height: rem(height) }}>
        <span className="dm-skel dm-chart-skel-wave" />
        <span className="dm-chart-skel-y">
          {[0, 1, 2].map((tick) => (
            <span key={tick} className="dm-skel" style={{ width: rem(24), height: rem(6), borderRadius: rem(3) }} />
          ))}
        </span>
        <span className="dm-chart-skel-x">
          {[0, 1, 2, 3].map((tick) => (
            <span key={tick} className="dm-skel" style={{ width: '7%', height: rem(6), borderRadius: rem(3) }} />
          ))}
        </span>
      </div>
    </div>
  )
}
