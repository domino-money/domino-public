import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { HistoryResponse, RatioCandle } from 'api-contracts/read-v3/types'
import { groupedRatioText, ratioGeometry, type RatioPad } from '../../lib/read/ratioSeries'
import { curveFor, linePath, type Point } from '../../lib/chart/paths'
import { nearestIndex } from '../../lib/chart/inspect'
import { sparkGeometry, type SparkRun } from '../../lib/chart/spark'
import { shortTime } from '../../lib/format/time'
import { cx } from '../ui'
import { EndDot, HoverDot, useSvgId } from './series'

/** The points of an `M x y L x y …` path. */
function pointsOf(path: string): Point[] {
  const numbers = path.match(/-?\d*\.?\d+/g) ?? []
  const points: Point[] = []
  for (let i = 0; i + 1 < numbers.length; i += 2) points.push({ x: Number(numbers[i]), y: Number(numbers[i + 1]) })
  return points
}

/** Room the tooltip keeps above the inspected point before it goes under it instead. */
const TIP_ROOM = 44
/** Room the tooltip takes beside the crosshair: it stays on the right (over the line past the pointer) while it fits. */
const TIP_WIDTH = 124

/**
 * Which edges of a run's area fade out (charts.css): an edge inside the plot, never the card's own left edge where
 * the area runs full bleed. The fade is a gradient on that one path's own box, so an area never stripes.
 */
function fadeOf(run: SparkRun, width: number): 'start' | 'end' | 'both' | undefined {
  const start = run.start.x > 0.5
  const end = run.end.x < width - 0.5
  return start && end ? 'both' : start ? 'start' : end ? 'end' : undefined
}

/**
 * A pool's stored price across its window, for the Markets cards. Fills its
 * container's width (measured with a ResizeObserver) at a fixed `height`. A
 * pointer picks the nearest real hour and reports its candle through
 * `onInspect`, and null when it leaves. Provenance is the plot's title.
 *
 * `variant="line"` draws hourly closes placed by time, never joined across an
 * hour that is missing (ratioGeometry), an hour on its own as a dot.
 *
 * `variant="area"` (2026-09-25, the cards' chart) draws a smooth line
 * (lib/chart/spark.ts: monotone from the first close, the last close held
 * across hours with no swap and to the right edge, broken where the history
 * has not covered an interval), one area under each run of it on a soft
 * vertical gradient that fades to nothing (and sideways where it starts or
 * ends inside the plot), with `level` a quiet dashed line at the first close
 * (the level the card's change is measured from), and an end dot that pops
 * once the line has wiped in; `live` lets it breathe three times, then rest.
 * `tone` follows the card's change: up and down in the calm semantic
 * colours, Tangerine when the card shows no change. Pointing (or a held
 * touch) draws a crosshair and a small tooltip with the hour's close and
 * time; the line past the pointer steps back.
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
  tone,
  level = false,
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
  /** The line variant's curve; the area variant is always monotone. */
  curve?: 'linear' | 'monotone'
  /** The area variant's colour: the direction of the change the card shows; Tangerine when it shows none. */
  tone?: 'up' | 'down' | 'flat'
  /** The area variant's dashed level at the first close: only where the card shows the change it measures. */
  level?: boolean
  live?: boolean
  inspectDot?: boolean
  reveal?: boolean
}) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [inspected, setInspected] = useState<number | null>(null)
  const id = useSvgId('dm-price-')

  useLayoutEffect(() => {
    const node = box.current
    if (!node) return
    const measure = () => setWidth(Math.floor(node.getBoundingClientRect().width))
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    // A press held on the line inspects it: a touch's long press opens no link menu over the card (Android; iOS's
    // preview is off in charts.css). A mouse's right click keeps the link's own menu.
    let touch = false
    const down = (event: PointerEvent) => {
      touch = event.pointerType === 'touch'
    }
    const menu = (event: Event) => {
      if (touch || (event as PointerEvent).pointerType === 'touch') event.preventDefault()
    }
    node.addEventListener('pointerdown', down)
    node.addEventListener('contextmenu', menu)
    return () => {
      observer?.disconnect()
      node.removeEventListener('pointerdown', down)
      node.removeEventListener('contextmenu', menu)
    }
  }, [])

  const choose = (candle: RatioCandle) => {
    if (candle.startTimestamp === inspected) return
    setInspected(candle.startTimestamp)
    onInspect?.(candle)
  }
  const leave = () => {
    if (inspected === null) return
    setInspected(null)
    onInspect?.(null)
  }

  if (variant === 'area') {
    const spark = width > 0 ? sparkGeometry(history, width, height, pad) : null
    const marked = spark && inspected !== null ? (spark.points.find((point) => point.candle.startTimestamp === inspected) ?? null) : null
    const inspect = (event: ReactPointerEvent<SVGSVGElement>) => {
      if (!spark) return
      const x = event.clientX - event.currentTarget.getBoundingClientRect().left
      const index = nearestIndex(
        spark.points.map((point) => point.x),
        x,
      )
      if (index >= 0) choose(spark.points[index].candle)
    }
    // Up to the pointer the series is whole; past it, a quieter copy of the same line and areas. A run of one hour
    // (between two intervals the history has not covered) is a dot, with no area under it (DESIGN-V2 §4.1).
    const series = spark && (
      <>
        {spark.runs.map((run, index) =>
          run.area ? <path key={index} d={run.area} fill={`url(#${id})`} className="dm-spark-area" data-fade={fadeOf(run, width)} /> : null,
        )}
        <path d={spark.line} className="dm-spark-line" />
        {spark.runs.map((run, index) => (run.area ? null : <circle key={index} cx={run.start.x} cy={run.start.y} r={2.5} className="dm-spark-lone" />))}
      </>
    )
    const tipSide = marked && marked.x + TIP_WIDTH > width ? 'left' : 'right'
    return (
      <div ref={box} className={cx('dm-price-wrap dm-spark-wrap w-full', className)} style={{ height }} title={title} data-reveal={reveal && spark ? '' : undefined}>
        {spark && (
          <svg
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            role="img"
            aria-label={label}
            data-price-line=""
            data-tone={tone}
            data-inspecting={marked ? '' : undefined}
            className="dm-spark block overflow-visible"
            onPointerMove={inspect}
            onPointerDown={inspect}
            onPointerLeave={leave}
            onPointerCancel={leave}
          >
            <defs>
              {/* Anchored to the plot, not to each area's box, so every run's area has one strength at one height. */}
              <linearGradient id={id} gradientUnits="userSpaceOnUse" x1="0" y1={spark.crest} x2="0" y2={height}>
                <stop offset="0" className="dm-spark-stop-top" />
                <stop offset="0.6" className="dm-spark-stop-mid" />
                <stop offset="1" className="dm-spark-stop-bottom" />
              </linearGradient>
              {marked && (
                <>
                  <clipPath id={`${id}-lit`}>
                    <rect x={-8} y={-8} width={marked.x + 8} height={height + 16} />
                  </clipPath>
                  <clipPath id={`${id}-past`}>
                    <rect x={marked.x} y={-8} width={Math.max(0, width - marked.x + 8)} height={height + 16} />
                  </clipPath>
                </>
              )}
            </defs>
            {/* Under the series: the level the change is measured from, from the first close to the end dot. */}
            {level && !spark.flat && <line x1={spark.points[0].x} x2={spark.end.x} y1={spark.baseline} y2={spark.baseline} className="dm-spark-base" />}
            {marked ? (
              <>
                <g clipPath={`url(#${id}-past)`} className="dm-spark-past">
                  {series}
                </g>
                <g clipPath={`url(#${id}-lit)`}>{series}</g>
              </>
            ) : (
              <g>{series}</g>
            )}
            <g className="dm-spark-end">
              <EndDot x={spark.end.x} y={spark.end.y} live={live} />
            </g>
            {/* The crosshair stops short of the plot's foot, where a caption may sit under the line. */}
            {marked && <line x1={marked.x} x2={marked.x} y1={0} y2={Math.min(height, spark.bottom + 10)} className="dm-crosshair dm-spark-cross" />}
            {marked && inspectDot && <HoverDot x={marked.x} y={marked.y} />}
          </svg>
        )}
        {spark && marked && (
          <span
            aria-hidden="true"
            className="dm-spark-tip"
            data-side={tipSide}
            data-place={marked.y - spark.top < TIP_ROOM ? 'below' : 'above'}
            style={{ left: marked.x, top: marked.y }}
          >
            <span className="dm-spark-tip-price">{groupedRatioText(marked.candle.close)}</span>
            <span className="dm-spark-tip-time">{shortTime(marked.candle.startTimestamp)}</span>
          </span>
        )}
      </div>
    )
  }

  const plot = width > 0 ? ratioGeometry(history, width, height, pad) : null
  const marked = plot ? (plot.points.find((point) => point.candle.startTimestamp === inspected) ?? plot.points[plot.points.length - 1]) : null
  // A path of one point draws nothing: that hour gets a dot instead.
  const lone = new Set(plot ? plot.paths.filter((path) => !path.includes(' L')) : [])
  const inspect = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!plot || plot.points.length === 0) return
    const x = event.clientX - event.currentTarget.getBoundingClientRect().left
    let nearest = plot.points[0]
    for (const point of plot.points) if (Math.abs(point.x - x) < Math.abs(nearest.x - x)) nearest = point
    choose(nearest.candle)
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
