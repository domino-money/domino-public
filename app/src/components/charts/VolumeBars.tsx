import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Candle } from 'api-contracts/read-v1/types'
import { volumeGeometry, type BarGeometry } from '../../lib/read/priceSeries'
import { cx } from '../ui'
import { rem, useRootScale } from '../../lib/rootScale'

/**
 * Hourly volume bars, shared by the Markets cards and the pool chart
 * (DESIGN.md H.7). Bars are drawn from `volumeGeometry`, so they sit on the
 * price line's time scale when both use the same width and pad. Idle bars are
 * faint; the latest closed hour (at rest) or the inspected hour carries the
 * informational Tangerine; an hour still open is drawn lighter. No <title>
 * elements: the caller's caption is the readout, and provenance goes in the
 * group's `title` attribute.
 */

/** One bar with a rounded top and a square foot. */
function barPath({ x, y, width, height }: BarGeometry) {
  const r = Math.min(2, width / 2, height)
  const right = x + width
  const bottom = y + height
  const n = (value: number) => String(Math.round(value * 100) / 100)
  return `M${n(x)} ${n(bottom)}V${n(y + r)}Q${n(x)} ${n(y)} ${n(x + r)} ${n(y)}H${n(right - r)}Q${n(right)} ${n(y)} ${n(right)} ${n(y + r)}V${n(bottom)}Z`
}

/** The startTimestamp of the last closed candle, or null. */
function latestClosed(bars: ReadonlyArray<BarGeometry>) {
  for (let index = bars.length - 1; index >= 0; index--) if (bars[index].candle.closed) return bars[index].candle.startTimestamp
  return null
}

/**
 * A `<g>` of bars for embedding in a parent svg. `inspected` is the inspected
 * candle's startTimestamp (never an index), matching `data-volume-bar` and the
 * pool chart's own inspection; null when nothing is inspected.
 */
export function VolumeBarsGroup({
  bars,
  inspected,
  accentLatestClosed = true,
  animate = true,
  title,
}: {
  bars: BarGeometry[]
  inspected: number | null
  accentLatestClosed?: boolean
  animate?: boolean
  /** Provenance for the bars, as a title attribute on the group. */
  title?: string
}) {
  const inspecting = inspected !== null && bars.some((bar) => bar.candle.startTimestamp === inspected)
  const resting = accentLatestClosed ? latestClosed(bars) : null
  const provenance = title === undefined ? undefined : { title }
  return (
    <g className="dm-vbars" data-inspecting={inspecting ? '' : undefined} data-animate={animate ? '' : undefined} {...provenance}>
      {bars.map((bar, index) => {
        const start = bar.candle.startTimestamp
        const accent = inspecting ? start === inspected : start === resting
        return (
          <path
            key={start}
            d={barPath(bar)}
            className="dm-vbar"
            data-volume-bar={start}
            data-accent={accent ? '' : undefined}
            data-open={bar.candle.closed ? undefined : ''}
            style={{ '--i': index } as React.CSSProperties}
          />
        )
      })}
    </g>
  )
}

/** The bar whose centre is nearest a horizontal position, or null without bars. */
function nearest(bars: ReadonlyArray<BarGeometry>, x: number) {
  let best: BarGeometry | null = null
  for (const bar of bars) {
    if (best === null || Math.abs(bar.cx - x) < Math.abs(best.cx - x)) best = bar
  }
  return best
}

/**
 * Standalone bars that fill their container's width (measured with a
 * ResizeObserver) at a fixed `height`. A pointer picks the nearest hour and
 * reports its candle through `onInspect`, and null when it leaves.
 */
export function VolumeBarsSvg({
  candles,
  intervalSeconds,
  label,
  height,
  title,
  onInspect,
  className,
}: {
  candles: ReadonlyArray<Candle>
  intervalSeconds: number
  label: string
  height: number
  /** Provenance, set on the bars group (for example the provider title of the figures). */
  title?: string
  onInspect?: (candle: Candle | null) => void
  className?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  // The box's width in CSS px; the bars are drawn in design px (`wide`) through a viewBox (lib/rootScale.ts).
  const [width, setWidth] = useState(0)
  const [inspected, setInspected] = useState<number | null>(null)
  const scale = useRootScale()
  const wide = width / scale

  useLayoutEffect(() => {
    const node = box.current
    if (!node) return
    const measure = () => setWidth(Math.floor(node.getBoundingClientRect().width))
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    return () => observer?.disconnect()
  }, [])

  // Half a bar of room at each end, so the first and last bars sit wholly inside.
  const starts = candles.map((candle) => candle.startTimestamp)
  const first = starts.length > 0 ? Math.min(...starts) : 0
  const last = starts.length > 0 ? Math.max(...starts) : 0
  const steps = intervalSeconds > 0 && last > first ? (last - first) / intervalSeconds : 23
  const side = width > 0 ? wide / (2 * (steps + 1)) : 0
  const geometry = width > 0 ? volumeGeometry(candles, intervalSeconds, wide, height, { top: 0, right: side, bottom: 0, left: side }, 3) : null

  const inspect = (event: ReactPointerEvent<SVGSVGElement>) => {
    if (!geometry) return
    const rect = event.currentTarget.getBoundingClientRect()
    const bar = nearest(geometry.bars, (event.clientX - rect.left) / scale)
    const start = bar ? bar.candle.startTimestamp : null
    if (start === inspected) return
    setInspected(start)
    onInspect?.(bar ? bar.candle : null)
  }
  const leave = () => {
    if (inspected === null) return
    setInspected(null)
    onInspect?.(null)
  }

  return (
    <div ref={box} className={cx('w-full', className)} style={{ height: rem(height) }}>
      {geometry && (
        <svg width={width} height={height * scale} viewBox={`0 0 ${wide} ${height}`} role="img" aria-label={label} className="block overflow-visible" onPointerMove={inspect} onPointerLeave={leave}>
          <VolumeBarsGroup bars={geometry.bars} inspected={inspected} title={title} />
        </svg>
      )}
    </div>
  )
}
