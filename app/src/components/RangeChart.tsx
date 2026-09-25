import { useEffect, useMemo, useRef, useState } from 'react'
import { previewPosition } from 'core/position'
import { DEFAULT_DOMAIN, priceAt } from '../lib/geometry'
import type { Domain } from '../lib/geometry'
import { UNIT, times } from '../lib/scenario'
import { useSvgId } from './charts/series'

const POINTS = 96

export type CurvePoint = { price: number; share: number }

/** The position's token share across every price, computed with the real maths, in relative terms. */
export function useComposition(lower: number, upper: number, domain: Domain = DEFAULT_DOMAIN): CurvePoint[] {
  const [lo, hi] = domain
  return useMemo(() => {
    const out: CurvePoint[] = []
    for (let i = 0; i <= POINTS; i++) {
      const price = lo + ((hi - lo) * i) / POINTS
      try {
        const p = previewPosition({ amount: UNIT, lower, upper, startingPrice: 1, scenarioPrice: price })
        out.push({ price, share: p.tokenShare })
      } catch {
        out.push({ price, share: price <= lower ? 1 : 0 })
      }
    }
    return out
  }, [lower, upper, lo, hi])
}

/**
 * Whether the element has been in view at least once. Nothing to observe
 * (no IntersectionObserver) counts as seen, so the drawing never waits.
 */
function useSeenOnce<T extends Element>(threshold: number) {
  const ref = useRef<T>(null)
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    const node = ref.current
    if (seen || !node) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect()
          setSeen(true)
        }
      },
      { threshold },
    )
    observer.observe(node)
    return () => observer.disconnect()
  }, [seen, threshold])
  return [ref, seen] as const
}

/** The curve's vertical room: share 1 sits 6% under the top, share 0 6% over the bottom, so neither flat runs along an edge. */
const TOP = 6
const SPAN = 88
const yOf = (share: number) => TOP + (1 - share) * SPAN

/** The token share at `price`, read off the drawn curve (linear between its samples). */
function shareAt(curve: CurvePoint[], price: number): number {
  if (curve.length === 0) return 0
  const first = curve[0]
  const last = curve[curve.length - 1]
  if (price <= first.price) return first.share
  if (price >= last.price) return last.share
  const step = (last.price - first.price) / (curve.length - 1)
  const at = Math.min(curve.length - 2, Math.floor((price - first.price) / step))
  const a = curve[at]
  const b = curve[at + 1]
  const t = (price - a.price) / (b.price - a.price)
  return a.share + (b.share - a.share) * t
}

/**
 * Token share against price, with the range as a band (DESIGN-V2 §7.1-6). The
 * whole plot is the handle: press anywhere and drag to move the price. The
 * domain is a fixed prop for the whole gesture, so a pointer held still holds
 * the price still. Prices are multiples of the start price. The marker's chip
 * is the only `.tnum` inside the drag surface; the axis below it names the
 * range and never moves with the price.
 *
 * The curve draws itself in (a left-to-right wipe) the first time the chart is
 * in view, and a change of range reshapes it and slides the band. The price
 * marker and its knob follow the pointer at once, never eased.
 */
export function RangeChart({
  curve,
  lower,
  upper,
  price,
  onPrice,
  domain = DEFAULT_DOMAIN,
}: {
  curve: CurvePoint[]
  lower: number
  upper: number
  price: number
  onPrice: (p: number) => void
  domain?: Domain
}) {
  const [lo, hi] = domain
  const box = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const [frame, seen] = useSeenOnce<HTMLDivElement>(0.35)
  const gradient = useSvgId('dm-rc-area')

  const x = (p: number) => ((p - lo) / (hi - lo)) * 100
  const line = curve.map((s, i) => `${i ? 'L' : 'M'}${x(s.price).toFixed(3)},${yOf(s.share).toFixed(3)}`).join(' ')
  const area = `${line} L100,100 L0,100 Z`
  const bandLeft = x(lower)
  const bandWidth = Math.max(0, x(upper) - bandLeft)

  const apply = (clientX: number) => {
    const r = box.current?.getBoundingClientRect()
    if (r) onPrice(priceAt(clientX, r.left, r.width, domain))
  }

  return (
    <div ref={frame} className="dm-rc">
      <div
        ref={box}
        data-testid="range-chart-price"
        data-seen={seen ? '' : undefined}
        className="dm-rc-plot"
        onPointerDown={(e) => {
          dragging.current = true
          e.currentTarget.setPointerCapture(e.pointerId)
          apply(e.clientX)
        }}
        onPointerMove={(e) => dragging.current && apply(e.clientX)}
        onPointerUp={() => {
          dragging.current = false
        }}
        onPointerCancel={() => {
          dragging.current = false
        }}
      >
        {/* The grid is its own layer, so its edge fade never covers the curve or the marker. */}
        <div aria-hidden="true" className="dm-dots-chart dm-rc-grid" />
        <div aria-hidden="true" className="dm-rc-band" style={{ left: `${bandLeft}%`, width: `calc(${bandWidth}% + 2px)` }} />
        <div aria-hidden="true" className="dm-rc-series">
          <svg viewBox="0 0 100 100" preserveAspectRatio="none">
            <defs>
              <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" className="dm-stop-top" />
                <stop offset="40%" className="dm-stop-mid" />
                <stop offset="100%" className="dm-stop-bottom" />
              </linearGradient>
            </defs>
            <path className="dm-rc-area" d={area} fill={`url(#${gradient})`} />
            <path className="dm-series-glow dm-rc-curve" d={line} />
            <path className="dm-series-line dm-rc-curve" d={line} />
          </svg>
        </div>
        <div aria-hidden="true" className="dm-rc-price" style={{ left: `${x(price)}%` }} />
        <div aria-hidden="true" className="dm-rc-knob" style={{ left: `${x(price)}%`, top: `${yOf(shareAt(curve, price))}%` }} />

        {/* The marker's chip rides above the plot, on the price line. */}
        <div className="dm-rc-marker" style={{ left: `${x(price)}%` }}>
          <span className="tnum dm-rc-chip">{times(price)}</span>
        </div>
      </div>

      <div className="dm-rc-axis" data-range-axis="">
        <span className="tnum">{times(lo)}</span>
        <span className="tnum dm-rc-axis-band" style={{ left: `${bandLeft + bandWidth / 2}%` }}>
          range {times(lower)} to {times(upper)}
        </span>
        <span className="tnum">{times(hi)}</span>
      </div>
    </div>
  )
}
