import { useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { cx } from '../ui'
import { rangeGeometry } from '../../lib/chart/range'

/** A label's position: centred on `x` (or ending, or starting, there), kept inside the preview. */
const place = (x: number, width: number, align: 'center' | 'end' | 'start'): string => {
  const shift = align === 'center' ? '50%' : align === 'end' ? '100%' : '0%'
  return `clamp(0px, calc(${x}px - ${shift}), calc(${width}px - 100%)) 0`
}

/**
 * A price range at a glance (DESIGN-V2 §4.7): on a log price axis, the band
 * from `lower` to `upper` with Tangerine edges, and the current price as a
 * dotted line with a dot on the band's centre line. Out of range the band
 * turns quiet. `current` null draws no price (never a guess); `axisOnly` is
 * the empty slot before a pool is chosen. Labels (the caller's own texts) sit
 * under the band's ends and, in a chip, over the price; below 40px there are
 * none. The band and the dot move with translate and a clip, 250ms, and stand
 * still when motion is stilled. aria-hidden: the words sit next to it.
 */
export function RangePreview({
  lower,
  upper,
  current,
  inRange,
  height = 120,
  labels,
  axisOnly = false,
  className,
}: {
  /** Prices (quote per base) > 0; Infinity is drawn to the edge. */
  lower: number
  upper: number
  current: number | null
  inRange: boolean | null
  /** 120 by default; 56 in review; 24 as a row mini. */
  height?: number
  labels?: { lower?: ReactNode; upper?: ReactNode; current?: ReactNode }
  axisOnly?: boolean
  className?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)

  useLayoutEffect(() => {
    const node = box.current
    if (!node) return
    const measure = () => setWidth(Math.floor(node.getBoundingClientRect().width))
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    return () => observer?.disconnect()
  }, [])

  const geo = width > 0 && !axisOnly ? rangeGeometry(lower, upper, current, width) : null
  const bandTop = Math.round(height * 0.3)
  const bandHeight = Math.max(4, Math.round(height * 0.4))
  const middle = bandTop + bandHeight / 2
  const words = height >= 40 && labels !== undefined
  // A narrow band puts its end labels outside its edges, so they never overlap.
  const narrow = geo !== null && geo.upper - geo.lower < 96
  const corner = bandHeight >= 20 ? Math.min(6, bandHeight / 2) : 0
  const edge = (x: number): CSSProperties => ({ top: bandTop + corner, height: bandHeight - 2 * corner, translate: `${x}px 0` })

  return (
    <div ref={box} aria-hidden="true" className={cx('dm-range-preview', className)} style={{ height }} data-in={inRange === false ? 'false' : 'true'}>
      <span className="dm-range-preview-axis" style={{ top: Math.round(middle) }} />
      {geo && (
        <>
          <span
            className="dm-range-preview-band"
            style={{ top: bandTop, height: bandHeight, clipPath: `inset(0 ${width - geo.upper}px 0 ${geo.lower}px round ${Math.min(6, bandHeight / 2)}px)` }}
          />
          <span className="dm-range-preview-edge" style={edge(geo.lower)} />
          <span className="dm-range-preview-edge" style={edge(geo.upper)} />
          {geo.current !== null && (
            <>
              <span className="dm-range-preview-now" style={{ top: Math.max(0, bandTop - 6), height: bandHeight + 12, translate: `${geo.current}px 0` }} />
              <span className="dm-range-preview-dot" style={{ top: middle, translate: `${geo.current}px 0` }} />
            </>
          )}
          {words && labels.lower && (
            <span className="dm-range-preview-label" data-end="lower" style={{ top: bandTop + bandHeight + 6, translate: place(geo.lower, width, narrow ? 'end' : 'center') }}>
              {labels.lower}
            </span>
          )}
          {words && labels.upper && (
            <span className="dm-range-preview-label" data-end="upper" style={{ top: bandTop + bandHeight + 6, translate: place(geo.upper, width, narrow ? 'start' : 'center') }}>
              {labels.upper}
            </span>
          )}
          {words && labels.current && geo.current !== null && (
            <span className="dm-range-preview-label" data-end="current" style={{ top: Math.max(0, bandTop - 26), translate: place(geo.current, width, 'center') }}>
              {labels.current}
            </span>
          )}
        </>
      )}
    </div>
  )
}
