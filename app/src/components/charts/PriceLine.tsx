import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { HistoryResponse, RatioCandle } from 'api-contracts/read-v3/types'
import { ratioGeometry, type RatioPad } from '../../lib/read/ratioSeries'
import { areaUnder, curveFor, linePath, type Point } from '../../lib/chart/paths'
import { cx } from '../ui'
import { EndDot, HoverDot, useSvgId } from './series'

/** The points of an `M x y L x y …` path. */
function pointsOf(path: string): Point[] {
  const numbers = path.match(/-?\d*\.?\d+/g) ?? []
  const points: Point[] = []
  for (let i = 0; i + 1 < numbers.length; i += 2) points.push({ x: Number(numbers[i]), y: Number(numbers[i + 1]) })
  return points
}

const n = (value: number) => String(Math.round(value * 100) / 100)
/** A path without its opening `M x y`, to continue another path from that point. */
const onward = (d: string) => d.replace(/^M[^LC]*/, '')

type Plot = NonNullable<ReturnType<typeof ratioGeometry>>
type Placed = Plot['points'][number]
/** The area's strength under held hours and under the open hour: quieter, never gone, eased in and out. */
const HELD = 0.62
const OPEN = 0.75

/**
 * The area variant's drawing (DESIGN-V2 §4.5, thin data). A pool's price moves only on a swap, so an hour with no
 * swap closed where the hour before it did: across such hours the last close is held (a quiet dashed line over a
 * quieter area), then joins the next close like any hour-to-hour step. The last close is held to the plot's
 * right edge the same way when the hours since it had no swap, so the end dot sits where every card's does. Nothing
 * is held across an interval the history has not covered (`gaps`): the line breaks there and its area fades. The
 * pointer still names only real hours.
 */
function drawing(history: HistoryResponse, plot: Plot, curve: 'linear' | 'monotone', baseline: number) {
  const step = history.resolutionSeconds
  const { startTimestamp: start, endTimestamp: end } = history.requestedWindow
  const hourWidth = ((plot.right - plot.left) * step) / Math.max(1, end - start)
  const uncovered = (from: number, to: number) => history.gaps.some((gap) => gap.startTimestamp < to && gap.endTimestamp > from)
  // Each ratioGeometry path is one run of consecutive points, in order.
  const runs: Placed[][] = []
  let taken = 0
  for (const path of plot.paths) {
    const count = path.split(' L').length
    runs.push(plot.points.slice(taken, taken + count))
    taken += count
  }
  const solid: string[] = []
  const open: string[] = []
  const carry: string[] = []
  const areas: { d: string; fade?: 'start' | 'end' | 'both' }[] = []
  const dim: { x0: number; x1: number; level: number }[] = []
  const lone: Placed[] = []
  let chain = ''
  let chainPoints = 0
  let chainFirst: Placed | null = null
  let line = ''
  const closeLine = () => {
    if (line.includes('L') || line.includes('C')) solid.push(line)
    line = ''
  }
  const closeChain = (fadeEnd: boolean) => {
    closeLine()
    if (chainPoints > 1 && chainFirst) {
      const fadeStart = chainFirst.x - plot.left > hourWidth / 2
      const fade = fadeStart && fadeEnd ? 'both' : fadeStart ? 'start' : fadeEnd ? 'end' : undefined
      areas.push({ d: areaUnder(chain, baseline), fade })
    } else if (chainFirst) lone.push(chainFirst)
  }
  runs.forEach((run, index) => {
    const d = run.length > 1 ? linePath(run, curveFor(run.length, curve)) : `M${n(run[0].x)} ${n(run[0].y)}`
    const previous = index > 0 ? runs[index - 1][runs[index - 1].length - 1] : null
    const b = run[0]
    if (!previous || uncovered(previous.candle.startTimestamp, b.candle.startTimestamp)) {
      if (previous) closeChain(true)
      chain = d
      chainPoints = run.length
      chainFirst = b
      line = d
      return
    }
    const held = b.candle.startTimestamp - previous.candle.startTimestamp > step
    const from = held ? { x: Math.max(previous.x, b.x - hourWidth), y: previous.y } : previous
    if (held) {
      carry.push(`M${n(previous.x)} ${n(previous.y)} L${n(from.x)} ${n(from.y)}`)
      dim.push({ x0: previous.x, x1: from.x, level: HELD })
    }
    const join = `M${n(from.x)} ${n(from.y)} L${n(b.x)} ${n(b.y)}`
    if (!previous.candle.complete || !b.candle.complete) {
      // An open hour (the one still running) joins lighter, its area too.
      closeLine()
      open.push(join)
      dim.push({ x0: from.x, x1: b.x, level: OPEN })
      line = d
    } else if (held) {
      closeLine()
      line = join + onward(d)
    } else line += ` L${n(b.x)} ${n(b.y)}${onward(d)}`
    chain += `${held ? ` L${n(from.x)} ${n(from.y)}` : ''} L${n(b.x)} ${n(b.y)}${onward(d)}`
    chainPoints += run.length
  })
  // The hours since the last close had no swap: that close is the price now, held to the plot's right edge.
  const last = plot.points[plot.points.length - 1]
  let endAt = { x: last.x, y: last.y }
  if (last.candle.startTimestamp + step < end && !uncovered(last.candle.startTimestamp, end) && plot.right - last.x > 1) {
    carry.push(`M${n(last.x)} ${n(last.y)} L${n(plot.right)} ${n(last.y)}`)
    dim.push({ x0: last.x, x1: plot.right, level: HELD })
    chain += ` L${n(plot.right)} ${n(last.y)}`
    chainPoints += 1
    endAt = { x: plot.right, y: last.y }
  }
  closeChain(endAt.x < plot.right - hourWidth)
  return { solid, open, carry, areas, dim, lone, end: endAt }
}

/**
 * A pool's stored price as one line across its window, for the Markets cards:
 * hourly closes placed by time, never joined across an hour that is missing
 * (ratioGeometry), an hour on its own drawn as a dot. The latest hour at rest,
 * or the inspected one, carries a dot of its own. Fills its container's width
 * (measured with a ResizeObserver) at a fixed `height`. A pointer picks the
 * nearest hour and reports its candle through `onInspect`, and null when it
 * leaves. Provenance is the plot's title.
 *
 * V2 (DESIGN-V2 §4.6): `variant="area"` draws the Tangerine area, its glow and
 * the line, holds the last close across hours with no swap (`drawing`), joins
 * the open hour lighter, ends in an EndDot (`live` breathes three times) and
 * wipes in once (`reveal`). `curve="monotone"` smooths runs of 20 hours or more.
 */
export function PriceLineSvg({
  history,
  label,
  height,
  pad,
  title,
  onInspect,
  className,
  variant = 'line',
  curve = 'linear',
  live = false,
  inspectDot = true,
  reveal = true,
}: {
  history: HistoryResponse
  label: string
  height: number
  pad: RatioPad
  title?: string
  onInspect?: (candle: RatioCandle | null) => void
  className?: string
  variant?: 'line' | 'area'
  curve?: 'linear' | 'monotone'
  live?: boolean
  inspectDot?: boolean
  reveal?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [inspected, setInspected] = useState<number | null>(null)
  const gradient = useSvgId('dm-price-')

  useLayoutEffect(() => {
    const node = box.current
    if (!node) return
    const measure = () => setWidth(Math.floor(node.getBoundingClientRect().width))
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    return () => observer?.disconnect()
  }, [])

  const plot = width > 0 ? ratioGeometry(history, width, height, pad) : null
  const marked = plot ? (plot.points.find((point) => point.candle.startTimestamp === inspected) ?? plot.points[plot.points.length - 1]) : null
  // A path of one point draws nothing: that hour gets a dot instead.
  const lone = new Set(plot ? plot.paths.filter((path) => !path.includes(' L')) : [])

  const inspect = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!plot || plot.points.length === 0) return
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left
    let nearest = plot.points[0]
    for (const point of plot.points) if (Math.abs(point.x - x) < Math.abs(nearest.x - x)) nearest = point
    if (nearest.candle.startTimestamp === inspected) return
    setInspected(nearest.candle.startTimestamp)
    onInspect?.(nearest.candle)
  }
  const leave = () => {
    if (inspected === null) return
    setInspected(null)
    onInspect?.(null)
  }

  if (variant === 'area') {
    const baseline = plot ? plot.bottom + pad.bottom : height
    const drawn = plot && plot.points.length > 0 ? drawing(history, plot, curve, baseline) : null
    // Held and open stretches keep their area at a lower strength: a horizontal luminance ramp, soft at each edge.
    const stops: { at: number; level: number }[] = []
    if (drawn && drawn.dim.length > 0) {
      stops.push({ at: 0, level: 1 })
      for (const range of [...drawn.dim].sort((a, b) => a.x0 - b.x0)) {
        const ramp = Math.min(12, (range.x1 - range.x0) / 2)
        stops.push({ at: range.x0, level: 1 }, { at: range.x0 + ramp, level: range.level }, { at: range.x1 - ramp, level: range.level }, { at: range.x1, level: 1 })
      }
      stops.push({ at: width, level: 1 })
    }
    const gray = (level: number) => { const v = Math.round(level * 255); return `rgb(${v},${v},${v})` }
    return (
      <div ref={box} className={cx('dm-price-wrap w-full', className)} style={{ height }} title={title} data-reveal={reveal && plot ? '' : undefined}>
        {plot && marked && drawn && (
          <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} data-price-line="" className="dm-price-line block overflow-visible" onPointerMove={inspect} onPointerLeave={leave}>
            <defs>
              <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0" className="dm-stop-top" />
                <stop offset="0.4" className="dm-stop-mid" />
                <stop offset="1" className="dm-stop-bottom" />
              </linearGradient>
              {stops.length > 0 && (
                <>
                  <linearGradient id={`${gradient}-held`} gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={width} y2="0">
                    {stops.map((stop, index) => (
                      <stop key={index} offset={Math.max(0, Math.min(1, stop.at / Math.max(1, width)))} stopColor={gray(stop.level)} />
                    ))}
                  </linearGradient>
                  <mask id={`${gradient}-mask`} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={height}>
                    <rect x="0" y="0" width={width} height={height} fill={`url(#${gradient}-held)`} />
                  </mask>
                </>
              )}
            </defs>
            <g mask={stops.length > 0 ? `url(#${gradient}-mask)` : undefined}>
              {drawn.areas.map((area, index) => (
                <path key={`a${index}`} d={area.d} fill={`url(#${gradient})`} className="dm-spark-area" data-fade={area.fade} />
              ))}
            </g>
            {drawn.solid.map((d, index) => (
              <path key={`g${index}`} d={d} className="dm-series-glow" />
            ))}
            {drawn.carry.map((d, index) => (
              <path key={`c${index}`} d={d} className="dm-spark-carry" />
            ))}
            {drawn.solid.map((d, index) => (
              <path key={`l${index}`} d={d} className="dm-spark-line dm-series-line" />
            ))}
            {drawn.open.map((d, index) => (
              <path key={`o${index}`} d={d} className="dm-spark-line dm-series-line" data-open="" />
            ))}
            {drawn.lone.map((point) => (
              <circle key={point.candle.startTimestamp} cx={point.x} cy={point.y} r={1.5} className="dm-series-dot" />
            ))}
            {inspected !== null && <line x1={marked.x} x2={marked.x} y1={0} y2={height} className="dm-spark-cross dm-crosshair" />}
            <EndDot x={drawn.end.x} y={drawn.end.y} live={live} />
            {inspected !== null && inspectDot && <HoverDot x={marked.x} y={marked.y} />}
          </svg>
        )}
      </div>
    )
  }

  return (
    <div ref={box} className={cx('w-full', className)} style={{ height }} title={title}>
      {plot && marked && (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} data-price-line="" className="block overflow-visible" onPointerMove={inspect} onPointerLeave={leave}>
          {plot.paths.map((path, index) => (lone.has(path) ? null : <path key={index} d={curve === 'monotone' ? linePath(pointsOf(path), curveFor(pointsOf(path).length, curve)) : path} className="dm-spark-line" />))}
          {plot.points.map((point) => (lone.has(`M${point.x.toFixed(2)} ${point.y.toFixed(2)}`) ? <circle key={point.candle.startTimestamp} cx={point.x} cy={point.y} r={1.5} className="dm-spark-dot" /> : null))}
          {inspected !== null && <line x1={marked.x} x2={marked.x} y1={0} y2={height} className="dm-spark-cross" />}
          {inspectDot && <circle cx={marked.x} cy={marked.y} r={3} className="dm-spark-dot" data-accent="" data-open={marked.candle.complete ? undefined : ''} />}
        </svg>
      )}
    </div>
  )
}
