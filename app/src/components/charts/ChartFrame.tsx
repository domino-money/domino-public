import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from 'react'
import { cx } from '../ui'
import { useMediaQuery } from '../../lib/useMediaQuery'
import { rem, useRootScale } from '../../lib/rootScale'

/**
 * The plot a chart draws into: the frame's full box (`width`, `height`) and
 * the plot area inside it (`left`..`right`, `top`..`bottom`), in design px.
 *
 * Changed on purpose 2026-10-03 (the owner: the site looks too big at 100%; at 80% it looks right): design px are CSS
 * px over the root's scale (lib/rootScale.ts). The frame's SVG layers draw them through a viewBox and its overlay places
 * them in rem, so the paddings, label offsets and gutters a chart writes in px scale with the rest of the page.
 */
export interface Plot {
  width: number
  height: number
  left: number
  right: number
  top: number
  bottom: number
}

export type ChartPadding = { top: number; right: number; bottom: number; left: number }

/** Room around the plot: the right side holds the y labels on a desktop; a phone has none. */
const PAD_DESKTOP: ChartPadding = { top: 12, right: 56, bottom: 24, left: 0 }
const PAD_PHONE: ChartPadding = { top: 12, right: 8, bottom: 24, left: 0 }

/**
 * A chart's frame (DESIGN-V2 §4.2): it measures its width, stacks four
 * layers (static axes, the series, the inspection marks, an HTML overlay for
 * tooltips and chips) and owns inspection. A pointer or the keyboard picks an
 * index through the caller's `indexAt`; pointer moves are coalesced to one
 * update per frame, and the series layer never sees the inspected index, so
 * inspecting never re-renders the series. The first `revealKey` wipes the
 * series in; a later key cross-fades it. With `points` 0 it is a plain image.
 */
export function ChartFrame({
  height,
  padding,
  label,
  points,
  indexAt,
  valueText,
  onInspect,
  revealKey,
  axes,
  series,
  inspect,
  overlay,
  className,
}: {
  /** The plot's height; the axes' room is added around it. */
  height: number
  /** Default desktop {12, 56, 24, 0}, phone {12, 8, 24, 0}. */
  padding?: Partial<ChartPadding>
  /** The accessible name (existing words, or the §0.2 words). */
  label: string
  /** How many indices can be inspected; 0 makes the chart a plain role="img". */
  points: number
  /** The caller's x → index. */
  indexAt: (x: number, plot: Plot) => number
  /** aria-valuetext for an index. */
  valueText?: (index: number) => string
  onInspect?: (index: number | null) => void
  /** The first key wipes in; later keys cross-fade. */
  revealKey?: string
  /** Static SVG layer. */
  axes?: (plot: Plot) => ReactNode
  /** The series SVG layer. Pass a stable function (useCallback on the data): it re-renders only with it and the plot's size. */
  series: (plot: Plot) => ReactNode
  /** SVG layer over the series: crosshair, hover dot, last-value line. */
  inspect?: (plot: Plot, index: number | null) => ReactNode
  /** HTML layer: tooltip, last-value chip, HTML labels. */
  overlay?: (plot: Plot, index: number | null) => ReactNode
  className?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  const [inspected, setInspected] = useState<number | null>(null)
  const [mountKey] = useState(revealKey)
  const phone = useMediaQuery('(max-width: 767px)')
  const scale = useRootScale()
  const pending = useRef<number | null>(null)
  const frame = useRef(0)
  // The inspected index as the handlers last set it, so a coalesced pointer frame compares without re-rendering.
  const current = useRef<number | null>(null)

  useLayoutEffect(() => {
    const node = box.current
    if (!node) return
    const measure = () => setWidth(Math.floor(node.getBoundingClientRect().width))
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(node)
    return () => observer?.disconnect()
  }, [])

  useEffect(() => () => cancelAnimationFrame(frame.current), [])

  const base = phone ? PAD_PHONE : PAD_DESKTOP
  const top = padding?.top ?? base.top
  const right = padding?.right ?? base.right
  const bottom = padding?.bottom ?? base.bottom
  const left = padding?.left ?? base.left
  const total = top + height + bottom
  // `width` is the box's measured width in CSS px; the plot is in design px.
  const plotWidth = width / scale
  const plot = useMemo<Plot | null>(
    () => (width > 0 ? { width: plotWidth, height: total, left, right: Math.max(left, plotWidth - right), top, bottom: top + height } : null),
    [width, plotWidth, total, left, right, top, height],
  )
  const drawn = useMemo(() => (plot ? series(plot) : null), [plot, series])

  const interactive = points > 0
  const clampIndex = (index: number) => Math.min(points - 1, Math.max(0, Math.round(index)))
  const report = (next: number | null) => {
    current.current = next
    setInspected(next)
    onInspect?.(next)
  }

  const move = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!interactive || !plot) return
    const x = (event.clientX - event.currentTarget.getBoundingClientRect().left) / scale
    pending.current = clampIndex(indexAt(x, plot))
    if (frame.current) return
    frame.current = requestAnimationFrame(() => {
      frame.current = 0
      const next = pending.current
      if (next !== current.current) report(next)
    })
  }
  const leave = () => {
    cancelAnimationFrame(frame.current)
    frame.current = 0
    if (current.current !== null) report(null)
  }
  const key = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!interactive) return
    const at = inspected ?? points - 1
    const step: Record<string, number> = { ArrowLeft: at - 1, ArrowRight: at + 1, PageUp: at - 24, PageDown: at + 24, Home: 0, End: points - 1 }
    if (event.key === 'Escape') {
      if (inspected !== null) report(null)
      return
    }
    if (!(event.key in step)) return
    event.preventDefault()
    const next = inspected === null && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') ? points - 1 : clampIndex(step[event.key])
    if (next !== inspected) report(next)
  }

  const now = inspected ?? points - 1
  const layer = (content: ReactNode) =>
    plot && (
      <svg className="dm-chart-layer" width={width} height={plot.height * scale} viewBox={`0 0 ${plot.width} ${plot.height}`} aria-hidden="true" focusable="false">
        {content}
      </svg>
    )
  const reveal = revealKey === mountKey
  // A slider while there is something to inspect (keyboard and pointer), otherwise a plain image.
  const role = interactive
    ? {
        role: 'slider' as const,
        tabIndex: 0,
        'aria-valuemin': 1,
        'aria-valuemax': points,
        'aria-valuenow': now + 1,
        'aria-valuetext': valueText ? valueText(now) : undefined,
        onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => {
          event.currentTarget.focus({ preventScroll: true })
          move(event)
        },
        onPointerMove: move,
        onPointerLeave: (event: ReactPointerEvent<HTMLDivElement>) => {
          if (event.pointerType !== 'touch') leave()
        },
        onPointerCancel: leave,
        onKeyDown: key,
        onBlur: leave,
      }
    : { role: 'img' as const }

  return (
    <div ref={box} className={cx('dm-chart', className)} style={{ height: rem(total) }} aria-label={label} {...role}>
      {plot && (
        <>
          {axes && layer(axes(plot))}
          <div key={revealKey ?? ''} className="dm-chart-series" data-reveal={reveal ? '' : undefined} data-swap={reveal ? undefined : ''}>
            {layer(drawn)}
          </div>
          {inspect && layer(inspect(plot, inspected))}
          {overlay && <div className="dm-chart-overlay">{overlay(plot, inspected)}</div>}
        </>
      )}
    </div>
  )
}
