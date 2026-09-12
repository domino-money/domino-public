import { useMemo, useRef } from 'react'
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

/**
 * Token share against price, with the range shaded. The whole chart surface
 * is the handle: press anywhere and drag to move the price. The domain is a
 * fixed prop for the whole gesture, so a pointer held still holds the price
 * still. Prices are multiples of the start price.
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
        className="relative cursor-ew-resize select-none touch-none"
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
        <svg viewBox={`0 0 100 ${H}`} preserveAspectRatio="none" className="absolute inset-0 h-full w-full" aria-hidden="true">
          <defs>
            <linearGradient id="dm-token-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.45" />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.04" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="100" height={H} fill="var(--fg)" opacity="0.04" />
          <rect x={x(lower)} y="0" width={Math.max(0, x(upper) - x(lower))} height={H} fill="var(--accent)" opacity="0.55" />
          <path d={area} fill="url(#dm-token-fill)" />
          <path d={line} fill="none" stroke="var(--primary)" strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
          {[lower, upper].map((b) => (
            <line key={b} x1={x(b)} y1="0" x2={x(b)} y2={H} stroke="var(--primary)" strokeOpacity="0.7" strokeWidth={1} strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
          ))}
          <line x1={x(price)} y1="0" x2={x(price)} y2={H} stroke="var(--fg)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        </svg>

        {/* Price marker */}
        <div className="pointer-events-none absolute top-0 -translate-x-1/2" style={{ left: `${x(price)}%` }}>
          <span className="tnum -mt-3 block rounded-[var(--radius-pill)] border bg-surface-3 px-2 py-0.5 font-mono text-[11px]">{times(price)}</span>
        </div>
        <div className="pointer-events-none absolute -translate-x-1/2 rounded-full border-2 bg-surface-2" style={{ left: `${x(price)}%`, top: H - 9, width: 18, height: 18, borderColor: 'var(--primary)' }} />
      </div>

      <div className="mt-4 flex justify-between font-mono text-[11px] text-fg-subtle" data-range-axis="">
        <span>{times(lo)}</span>
        <span style={{ color: 'var(--primary)' }}>
          range {times(lower)} to {times(upper)}
        </span>
        <span>{times(hi)}</span>
      </div>
    </div>
  )
}
