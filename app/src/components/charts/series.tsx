import { useId } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { areaPath, curveFor, linePath, type Curve, type Point } from '../../lib/chart/paths'

/*
 * Series parts (DESIGN-V2 §4.3): `<g>` pieces for a ChartFrame layer or any
 * existing <svg>. Hand-written SVG; paint servers are attributes with ids from
 * useId, their stop colours come from classes (charts.css). No <title>, no
 * digits, never a data-metric. Animated parts have transform-box: fill-box.
 */

/** An SVG id from useId, without the characters an id reference cannot carry. */
export function useSvgId(prefix: string): string {
  return `${prefix}${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
}

const n = (value: number) => String(Math.round(value * 100) / 100)

/** Continuous pieces as paths; a piece of one point is returned apart, to be drawn as a dot. */
function pieces(segments: ReadonlyArray<ReadonlyArray<Point>>, curve: Curve) {
  const lines: { d: string; pts: ReadonlyArray<Point> }[] = []
  const lone: Point[] = []
  for (const segment of segments) {
    if (segment.length === 1) lone.push(segment[0])
    else if (segment.length > 1) lines.push({ d: linePath(segment, curveFor(segment.length, curve)), pts: segment })
  }
  return { lines, lone }
}

/**
 * The Tangerine area: a three-stop gradient down to `baseline`, a soft glow
 * (visible in dark only, by token) and a 2px line. Segments are never joined
 * across a gap; a segment of one point is a small dot. `neutral` is a plain
 * 1.5px muted line with no area and no glow.
 */
export function AreaSeries({
  segments,
  curve = 'monotone',
  baseline,
  tone = 'primary',
  dots,
}: {
  segments: ReadonlyArray<ReadonlyArray<Point>>
  curve?: Curve
  baseline: number
  tone?: 'primary' | 'neutral'
  /** Isolated points to mark (for example hours with no neighbour). */
  dots?: ReadonlyArray<Point>
}) {
  const id = useSvgId('dm-area-')
  const { lines, lone } = pieces(segments, curve)
  const marks = [...lone, ...(dots ?? [])]
  const primary = tone === 'primary'
  return (
    <g>
      {primary && (
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" className="dm-stop-top" />
            <stop offset="0.4" className="dm-stop-mid" />
            <stop offset="1" className="dm-stop-bottom" />
          </linearGradient>
        </defs>
      )}
      {primary && lines.map((line, index) => <path key={`a${index}`} d={areaPath(line.pts, curveFor(line.pts.length, curve), baseline)} fill={`url(#${id})`} />)}
      {primary && lines.map((line, index) => <path key={`g${index}`} d={line.d} className="dm-series-glow" />)}
      {lines.map((line, index) => (
        <path key={`l${index}`} d={line.d} className="dm-series-line" data-tone={primary ? undefined : 'neutral'} />
      ))}
      {marks.map((point, index) => (
        <circle key={`d${index}`} cx={point.x} cy={point.y} r={1.5} className="dm-series-dot" data-tone={primary ? undefined : 'neutral'} />
      ))}
    </g>
  )
}

/** A 1.5px line: `neutral` (muted), `faint` or `primary`; `dashed` draws it 4 4. */
export function LineSeries({
  segments,
  curve = 'linear',
  tone,
  dashed = false,
}: {
  segments: ReadonlyArray<ReadonlyArray<Point>>
  curve?: Curve
  tone: 'neutral' | 'faint' | 'primary'
  dashed?: boolean
}) {
  const { lines, lone } = pieces(segments, curve)
  return (
    <g>
      {lines.map((line, index) => (
        <path key={index} d={line.d} className="dm-series-line" data-tone={tone === 'primary' ? undefined : tone} data-weight="thin" data-dashed={dashed ? '' : undefined} />
      ))}
      {lone.map((point, index) => (
        <circle key={`d${index}`} cx={point.x} cy={point.y} r={1.5} className="dm-series-dot" data-tone={tone === 'primary' ? undefined : tone} />
      ))}
    </g>
  )
}

/** A bar with a 2px rounded top and a square foot. */
function barPath(x: number, y: number, width: number, height: number) {
  const r = Math.min(2, width / 2, height)
  const right = x + width
  const bottom = y + height
  return `M${n(x)} ${n(bottom)}V${n(y + r)}Q${n(x)} ${n(y)} ${n(x + r)} ${n(y)}H${n(right - r)}Q${n(right)} ${n(y)} ${n(right)} ${n(y + r)}V${n(bottom)}Z`
}

/**
 * Bars on their own scale (the tallest is `maxHeight`), standing on
 * `baseline`. Faint; the `hovered` index in Tangerine. A zero draws nothing.
 */
export function BarSeries({
  bars,
  baseline,
  maxHeight,
  hovered = null,
}: {
  bars: ReadonlyArray<{ x: number; width: number; value: number }>
  baseline: number
  maxHeight: number
  hovered?: number | null
}) {
  const max = bars.reduce((top, bar) => (Number.isFinite(bar.value) && bar.value > top ? bar.value : top), 0)
  if (max <= 0) return <g />
  return (
    <g>
      {bars.map((bar, index) => {
        if (!(bar.value > 0)) return null
        const h = Math.max(1, (bar.value / max) * maxHeight)
        return <path key={index} d={barPath(bar.x, baseline - h, Math.max(1, bar.width), h)} className="dm-bar" data-hovered={index === hovered ? '' : undefined} />
      })}
    </g>
  )
}

/** A vertical hairline at `x`; a horizontal one at `y` when given. Inspection is instant: no transition. */
export function Crosshair({ x, y, top, bottom, left, right }: { x: number; y?: number; top: number; bottom: number; left: number; right: number }) {
  return (
    <g>
      <line x1={x} x2={x} y1={top} y2={bottom} className="dm-crosshair" />
      {y !== undefined && <line x1={left} x2={right} y1={y} y2={y} className="dm-crosshair" data-axis="y" />}
    </g>
  )
}

/** The inspected point: a Tangerine dot ringed in the card's colour, in a soft halo. */
export function HoverDot({ x, y }: { x: number; y: number }) {
  return (
    <g>
      <circle cx={x} cy={y} r={8} className="dm-hover-halo" />
      <circle cx={x} cy={y} r={5} className="dm-hover-dot" />
    </g>
  )
}

/**
 * The latest point: a dot that pops after the first draw. `live` adds two
 * rings that breathe three times and rest (never infinite: cards are links).
 */
export function EndDot({ x, y, live = false }: { x: number; y: number; live?: boolean }) {
  return (
    <g>
      {live && (
        <>
          <circle cx={x} cy={y} r={3.5} className="dm-live-ring" />
          <circle cx={x} cy={y} r={3.5} className="dm-live-ring" />
        </>
      )}
      <circle cx={x} cy={y} r={3.5} className="dm-end-dot" />
    </g>
  )
}

/** The last value's dashed line, from the end dot to the plot's right edge (inspect layer). */
export function LastValue({ x0, x1, y }: { x0: number; x1: number; y: number }) {
  return <line x1={x0} x2={x1} y1={y} y2={y} className="dm-last-line" />
}

/** The last value's chip at the plot's right edge (overlay layer), at `yPct` % of the frame's height. Callers hide any y label within 14px of it. */
export function LastValueChip({ yPct, children }: { yPct: number; children: ReactNode }) {
  return (
    <span className="dm-last-chip" style={{ top: `${yPct}%` }}>
      {children}
    </span>
  )
}

/** A 1px floor. */
export function Baseline({ y, left, right }: { y: number; left: number; right: number }) {
  return <line x1={left} x2={right} y1={y} y2={y} className="dm-baseline" />
}

/**
 * A range as a band: horizontal (`y1`..`y2` across `left`..`right`, a price
 * range over time) or vertical (`x1`..`x2` from `top` to `bottom`). Its two
 * edges are Tangerine; `dashed` on price-vs-time, solid on range visuals.
 */
export function RangeBand(
  props: ({ y1: number; y2: number; left: number; right: number } | { x1: number; x2: number; top: number; bottom: number }) & { dashed?: boolean },
) {
  const dashed = props.dashed ? '' : undefined
  if ('y1' in props) {
    const top = Math.min(props.y1, props.y2)
    const height = Math.abs(props.y2 - props.y1)
    return (
      <g>
        <rect x={props.left} y={top} width={Math.max(0, props.right - props.left)} height={height} className="dm-band" />
        <line x1={props.left} x2={props.right} y1={props.y1} y2={props.y1} className="dm-band-edge" data-dashed={dashed} />
        <line x1={props.left} x2={props.right} y1={props.y2} y2={props.y2} className="dm-band-edge" data-dashed={dashed} />
      </g>
    )
  }
  const left = Math.min(props.x1, props.x2)
  const width = Math.abs(props.x2 - props.x1)
  return (
    <g>
      <rect x={left} y={props.top} width={width} height={Math.max(0, props.bottom - props.top)} className="dm-band" />
      <line x1={props.x1} x2={props.x1} y1={props.top} y2={props.bottom} className="dm-band-edge" data-dashed={dashed} />
      <line x1={props.x2} x2={props.x2} y1={props.top} y2={props.bottom} className="dm-band-edge" data-dashed={dashed} />
    </g>
  )
}

export type PipKind = 'mint' | 'collect' | 'increase' | 'decrease' | 'close'

/**
 * Event pips: the only motif borrowed from the tile. They differ in shape, not
 * only colour: collect a filled Tangerine disc, mint a hollow disc, increase
 * and decrease a small muted disc, close a hollow square. `active` grows one
 * and gives it a halo. They pop in after the first draw, 40ms apart.
 */
export function EventPips({ events }: { events: ReadonlyArray<{ x: number; y: number; kind: PipKind; active?: boolean }> }) {
  return (
    <g>
      {events.map((event, index) => {
        const grow = event.active ? 1.5 : 0
        const style = { '--i': index } as CSSProperties
        const r = (event.kind === 'increase' || event.kind === 'decrease' ? 3 : 4) + grow
        return (
          <g key={index}>
            {event.active && <circle cx={event.x} cy={event.y} r={r + 4} className="dm-pip-halo" />}
            {event.kind === 'close' ? (
              <rect x={event.x - 3.5 - grow} y={event.y - 3.5 - grow} width={7 + 2 * grow} height={7 + 2 * grow} rx={1} className="dm-pip" data-kind="close" style={style} />
            ) : (
              <circle cx={event.x} cy={event.y} r={r} className="dm-pip" data-kind={event.kind} style={style} />
            )}
          </g>
        )
      })}
    </g>
  )
}

/** Time in range as a strip: in range green at .65, out of range a quiet fill, 1px apart, radius 3. */
export function InRangeStrip({ segments, y, height = 6 }: { segments: ReadonlyArray<{ x0: number; x1: number; inRange: boolean }>; y: number; height?: number }) {
  return (
    <g>
      {segments.map((segment, index) => {
        const width = Math.max(0, segment.x1 - segment.x0 - 1)
        if (width <= 0) return null
        return <rect key={index} x={segment.x0} y={y} width={width} height={height} rx={Math.min(3, height / 2)} className="dm-inrange" data-in={segment.inRange ? '' : undefined} />
      })}
    </g>
  )
}
