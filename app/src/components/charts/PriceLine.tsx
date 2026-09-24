import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { HistoryResponse, RatioCandle } from 'api-contracts/read-v3/types'
import { ratioGeometry, type RatioPad } from '../../lib/read/ratioSeries'
import { cx } from '../ui'

/**
 * A pool's stored price as one thin line across its window, for the Markets
 * cards: hourly closes placed by time, never joined across an hour that is
 * missing or still open (ratioGeometry), an hour on its own drawn as a dot.
 * The latest hour at rest, or the inspected one, carries a dot of its own.
 * Fills its container's width (measured with a ResizeObserver) at a fixed
 * `height`. A pointer picks the nearest hour and reports its candle through
 * `onInspect`, and null when it leaves. Provenance is the plot's title.
 */
export function PriceLineSvg({
  history,
  label,
  height,
  pad,
  title,
  onInspect,
  className,
}: {
  history: HistoryResponse
  label: string
  height: number
  pad: RatioPad
  title?: string
  onInspect?: (candle: RatioCandle | null) => void
  className?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [inspected, setInspected] = useState<number | null>(null)

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

  return (
    <div ref={box} className={cx('w-full', className)} style={{ height }} title={title}>
      {plot && marked && (
        <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label} data-price-line="" className="block overflow-visible" onPointerMove={inspect} onPointerLeave={leave}>
          {plot.paths.map((path, index) => (lone.has(path) ? null : <path key={index} d={path} className="dm-spark-line" />))}
          {plot.points.map((point) => (lone.has(`M${point.x.toFixed(2)} ${point.y.toFixed(2)}`) ? <circle key={point.candle.startTimestamp} cx={point.x} cy={point.y} r={1.5} className="dm-spark-dot" /> : null))}
          {inspected !== null && <line x1={marked.x} x2={marked.x} y1={0} y2={height} className="dm-spark-cross" />}
          <circle cx={marked.x} cy={marked.y} r={3} className="dm-spark-dot" data-accent="" data-open={marked.candle.complete ? undefined : ''} />
        </svg>
      )}
    </div>
  )
}
