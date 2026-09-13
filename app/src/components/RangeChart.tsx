import { useMemo, useRef } from 'react'
import type { CSSProperties } from 'react'
import { previewPosition } from 'core/position'
import { DEFAULT_DOMAIN, priceAt } from '../lib/geometry'
import type { Domain } from '../lib/geometry'
import { UNIT, times } from '../lib/scenario'

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

/** The dotted plot sits on the card's own surface, so its dots dissolve into that ground at the top and bottom. */
const PLOT_GROUND = { '--chart-ground': 'var(--surface-2)' } as CSSProperties

/**
 * Token share against price, with the range shaded. The whole chart surface
 * is the handle: press anywhere and drag to move the price. The domain is a
 * fixed prop for the whole gesture, so a pointer held still holds the price
 * still. Prices are multiples of the start price. The marker's label is the
 * first `.tnum` inside the drag surface; the axis below it names the range and
 * never moves with the price.
 */
export function RangeChart({
  curve,
  lower,
  upper,
  price,
  onPrice,
  domain = DEFAULT_DOMAIN,
  height = 160,
}: {
  curve: CurvePoint[]
  lower: number
  upper: number
  price: number
  onPrice: (p: number) => void
  domain?: Domain
  height?: number
}) {
  const H = height
  const [lo, hi] = domain
  const box = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  const x = (p: number) => ((p - lo) / (hi - lo)) * 100
  const y = (share: number) => H - share * H
  const line = curve.map((s, i) => `${i ? 'L' : 'M'}${x(s.price)},${y(s.share)}`).join(' ')
  const area = `${line} L100,${H} L0,${H} Z`

  const apply = (clientX: number) => {
    const r = box.current?.getBoundingClientRect()
    if (r) onPrice(priceAt(clientX, r.left, r.width, domain))
  }

  return (
    <div>
      <div
        ref={box}
        data-testid="range-chart-price"
        className="relative mt-8 cursor-ew-resize select-none touch-none"
        style={{ height: H }}
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
        <div aria-hidden="true" className="dm-dots-chart pointer-events-none absolute inset-0 rounded-[var(--radius-sm)]" style={PLOT_GROUND} />
        <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full overflow-visible" aria-hidden="true">
          <defs>
            <linearGradient id="dm-token-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.28" />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          <rect x={x(lower)} y="0" width={Math.max(0, x(upper) - x(lower))} height={H} fill="var(--primary)" fillOpacity="0.07" />
          <path d={area} fill="url(#dm-token-fill)" />
          <path d={line} fill="none" stroke="var(--primary-ink)" strokeWidth="1.75" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          {[lower, upper].map((b) => (
            <line key={b} x1={x(b)} y1="0" x2={x(b)} y2={H} stroke="var(--primary-ink)" strokeOpacity="0.6" strokeWidth={1} strokeDasharray="3 4" vectorEffect="non-scaling-stroke" />
          ))}
          <line x1={x(price)} y1="0" x2={x(price)} y2={H} stroke="var(--fg)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>

        {/* Price marker: the label rides above the plot, the knob sits on its baseline. */}
        <div className="pointer-events-none absolute bottom-full mb-2 -translate-x-1/2" style={{ left: `${x(price)}%` }}>
          <span className="tnum block whitespace-nowrap rounded-[var(--radius-pill)] bg-surface-3 px-2 py-0.5 text-chip font-medium text-fg shadow-[inset_0_0_0_1px_var(--border)]">
            {times(price)}
          </span>
        </div>
        <div
          className="pointer-events-none absolute size-3 -translate-x-1/2 rounded-full bg-surface-2"
          style={{ left: `${x(price)}%`, top: H - 6, boxShadow: 'inset 0 0 0 2px var(--fg), var(--elev-button)' }}
        />
      </div>

      <div className="mt-3 flex justify-between text-caption text-fg-subtle" data-range-axis="">
        <span className="tnum">{times(lo)}</span>
        <span className="tnum text-primary-ink">
          range {times(lower)} to {times(upper)}
        </span>
        <span className="tnum">{times(hi)}</span>
      </div>
    </div>
  )
}
