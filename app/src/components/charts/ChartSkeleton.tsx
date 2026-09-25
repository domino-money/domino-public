import { cx } from '../ui'

/**
 * A chart on its way (DESIGN-V2 §4.5): a fixed wave under the shimmer, three
 * y-tick and four x-tick bubbles, and the header's value and date bubbles.
 * aria-hidden; no digits, no axis text, never a data-metric. `head={false}`
 * where the figure above the chart has its own skeleton.
 */
export function ChartSkeleton({ height, axes = true, head = true, className }: { height: number; axes?: boolean; head?: boolean; className?: string }) {
  return (
    <div aria-hidden="true" className={cx('dm-chart-skel', className)} data-axes={String(axes)}>
      {head && (
        <div className="dm-chart-skel-head">
          <span className="dm-skel" style={{ width: 180, maxWidth: '100%', height: 32 }} />
          <span className="dm-skel" style={{ width: 80, height: 12 }} />
        </div>
      )}
      <div className="dm-chart-skel-plot" style={{ height }}>
        <span className="dm-skel dm-chart-skel-wave" />
        {axes && (
          <>
            <span className="dm-chart-skel-y">
              {[0, 1, 2].map((tick) => (
                <span key={tick} className="dm-skel" style={{ width: 24, height: 6, borderRadius: 3 }} />
              ))}
            </span>
            <span className="dm-chart-skel-x">
              {[0, 1, 2, 3].map((tick) => (
                <span key={tick} className="dm-skel" style={{ width: '7%', height: 6, borderRadius: 3 }} />
              ))}
            </span>
          </>
        )}
      </div>
    </div>
  )
}
