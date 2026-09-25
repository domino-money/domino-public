/*
 * Axis labels (DESIGN-V2 §4.3): 12px `--fg-subtle`, tabular, no grid lines and
 * no tick marks. The label texts are the caller's (numbers and dates only).
 */

/** Y labels, one per tick, at `anchor` (an x): left-aligned on the right side of a plot, right-aligned on the left. */
export function YAxis({ ticks, anchor, side = 'right' }: { ticks: ReadonlyArray<{ y: number; label: string }>; anchor: number; side?: 'left' | 'right' }) {
  return (
    <g>
      {ticks.map((tick, index) => (
        <text key={index} x={anchor} y={tick.y} dominantBaseline="middle" textAnchor={side === 'right' ? 'start' : 'end'} className="dm-axis">
          {tick.label}
        </text>
      ))}
    </g>
  )
}

/**
 * X labels at `anchor` (a y, the text baseline). A label within 32px of the
 * plot's left or right edge is aligned to that edge so it never hangs off it.
 */
export function XAxis({ ticks, anchor, left = 0, right }: { ticks: ReadonlyArray<{ x: number; label: string }>; anchor: number; left?: number; right?: number }) {
  return (
    <g>
      {ticks.map((tick, index) => {
        const align = tick.x - left < 32 ? 'start' : right !== undefined && right - tick.x < 32 ? 'end' : 'middle'
        return (
          <text key={index} x={tick.x} y={anchor} textAnchor={align} className="dm-axis">
            {tick.label}
          </text>
        )
      })}
    </g>
  )
}
