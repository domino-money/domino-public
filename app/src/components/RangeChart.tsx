import { useMemo, useRef } from 'react'
import { previewPosition, usd } from 'core/position'
import { DEFAULT_DOMAIN, domainFor, priceAt, round2 } from '../lib/geometry'
import type { Domain } from '../lib/geometry'

const SAMPLES = 96

export { domainFor, DEFAULT_DOMAIN }
export type { Domain }

export type Sample = { price: number; share: number }
/** The position's composition across every price, computed with the real maths. */
export function useComposition(amount: number, lower: number, upper: number, domain: Domain = DEFAULT_DOMAIN): Sample[] {
  const [lo, hi] = domain
  return useMemo(() => {
    const out: Sample[] = []
    for (let i = 0; i <= SAMPLES; i++) {
      const price = lo + ((hi - lo) * i) / SAMPLES
      try {
        const p = previewPosition({ amount, lower, upper, startingPrice: 1, scenarioPrice: price })
        out.push({ price, share: p.tokenShare })
      } catch {
        out.push({ price, share: price <= lower ? 1 : 0 })
      }
    }
    return out
  }, [amount, lower, upper, lo, hi])
}


/**
 * Token share against price, with the range shaded. Drag the price line to
 * explore, or, when `onBounds` is given, drag either edge of the range to
 * change it. The whole chart surface is the handle.
 */
export function RangeChart({
  samples,
  lower,
  upper,
  price,
  onPrice,
  onBounds,
  onGesture,
  domain = DEFAULT_DOMAIN,
  height = 160,
  compact = false,
}: {
  samples: Sample[]
  lower: number
  upper: number
  price: number
  onPrice?: (p: number) => void
  onBounds?: (lower: number, upper: number) => void
  /** Told when a drag begins and ends, so the caller can hold the domain still. */
  onGesture?: (active: boolean) => void
  domain?: Domain
  height?: number
  compact?: boolean
}) {
  const H = height
  const [lo, hi] = domain
  const box = useRef<HTMLDivElement>(null)
  const drag = useRef<'price' | 'lower' | 'upper' | null>(null)

  const x = (p: number) => ((p - lo) / (hi - lo)) * 100
  const y = (share: number) => H - share * H
  const line = samples.map((s, i) => `${i ? 'L' : 'M'}${x(s.price)},${y(s.share)}`).join(' ')
  const area = `${line} L100,${H} L0,${H} Z`

  const pointerPrice = (clientX: number) => {
    const r = box.current?.getBoundingClientRect()
    return r ? priceAt(clientX, r.left, r.width, domain) : price
  }

  const pxOf = (p: number) => {
    const r = box.current?.getBoundingClientRect()
    return r ? r.left + (x(p) / 100) * r.width : 0
  }

  const apply = (clientX: number) => {
    const p = pointerPrice(clientX)
    if (drag.current === 'price' && onPrice) onPrice(p)
    if (drag.current === 'lower' && onBounds) onBounds(round2(Math.min(0.99, Math.max(lo + 0.01, p))), upper)
    if (drag.current === 'upper' && onBounds) onBounds(lower, round2(Math.max(1.01, Math.min(hi - 0.01, p))))
  }

  return (
    <div>
      <div
        ref={box}
        className="relative cursor-ew-resize select-none touch-none"
        style={{ height: H }}
        onPointerDown={(e) => {
          const cx = e.clientX
          let target: typeof drag.current = onPrice ? 'price' : null
          if (onBounds) {
            const dl = Math.abs(cx - pxOf(lower))
            const du = Math.abs(cx - pxOf(upper))
            if (Math.min(dl, du) < 18 || !onPrice) target = dl <= du ? 'lower' : 'upper'
          }
          if (!target) return
          drag.current = target
          e.currentTarget.setPointerCapture(e.pointerId)
          onGesture?.(true)
          apply(cx)
        }}
        onPointerMove={(e) => drag.current && apply(e.clientX)}
        onPointerUp={() => {
          drag.current = null
          onGesture?.(false)
        }}
        onPointerCancel={() => {
          drag.current = null
          onGesture?.(false)
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
            <line key={b} x1={x(b)} y1="0" x2={x(b)} y2={H} stroke="var(--primary)" strokeOpacity="0.7" strokeWidth={onBounds ? 2 : 1} strokeDasharray={onBounds ? undefined : '4 4'} vectorEffect="non-scaling-stroke" />
          ))}
          {onPrice && <line x1={x(price)} y1="0" x2={x(price)} y2={H} stroke="var(--fg)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />}
          {!onPrice && <line x1={x(price)} y1="0" x2={x(price)} y2={H} stroke="var(--fg)" strokeOpacity="0.5" strokeDasharray="3 3" vectorEffect="non-scaling-stroke" />}
        </svg>

        {/* Range edge handles */}
        {onBounds &&
          [
            ['lower', lower, 'Min'],
            ['upper', upper, 'Max'],
          ].map(([key, val, label]) => (
            <div key={key as string} className="pointer-events-none absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: `${x(val as number)}%` }}>
              <div className="flex h-9 w-5 items-center justify-center rounded-[6px] border bg-surface-2 shadow-[0_4px_14px_-4px_rgba(0,0,0,0.5)]" style={{ borderColor: 'var(--primary)' }}>
                <span className="h-4 w-[2px] rounded-full" style={{ background: 'var(--primary)' }} />
              </div>
              <span className="absolute left-1/2 top-full mt-1 -translate-x-1/2 font-mono text-[10px]" style={{ color: 'var(--primary)' }}>{label}</span>
            </div>
          ))}

        {/* Price marker */}
        <div className="pointer-events-none absolute top-0 -translate-x-1/2" style={{ left: `${x(price)}%` }}>
          <span className="tnum -mt-3 block rounded-[var(--radius-pill)] border bg-surface-3 px-2 py-0.5 font-mono text-[11px]">{usd(price)}</span>
        </div>
        {onPrice && (
          <div className="pointer-events-none absolute -translate-x-1/2 rounded-full border-2 bg-surface-2" style={{ left: `${x(price)}%`, top: H - 9, width: 18, height: 18, borderColor: 'var(--primary)' }} />
        )}
      </div>

      {!compact && (
        <div className="mt-4 flex justify-between font-mono text-[11px] text-fg-subtle">
          <span>{usd(lo)}</span>
          <span style={{ color: 'var(--primary)' }}>range {usd(lower)} to {usd(upper)}</span>
          <span>{usd(hi)}</span>
        </div>
      )}
    </div>
  )
}
