import { previewPosition } from 'core/position'

/**
 * Backdrop for the hero: our own signature rather than borrowed token art.
 *
 * A faint dot grid, a soft tangerine light, and the position's composition
 * curve (the same maths the product runs) drawn very large and very quiet
 * across the whole width, with the active range shaded. It reads as a
 * liquidity chart from across the room and stays out of the headline's way.
 */

const LOWER = 0.7
const UPPER = 1.5
const FROM = 0.3
const TO = 2.7

/** Share of the position held in the volatile token at a given price. */
function shareAt(price: number): number {
  try {
    return previewPosition({ amount: 1000, lower: LOWER, upper: UPPER, startingPrice: 1, scenarioPrice: price }).tokenShare
  } catch {
    // Outside the guarded domain the position is entirely one asset.
    return price <= LOWER ? 1 : 0
  }
}

/** Computed once at module load: the shape never changes. */
const CURVE = Array.from({ length: 121 }, (_, i) => {
  const price = FROM + ((TO - FROM) * i) / 120
  const x = (i / 120) * 1000
  const y = 60 + (1 - shareAt(price)) * 260
  return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
}).join(' ')

const x = (p: number) => ((p - FROM) / (TO - FROM)) * 1000

export function HeroBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
      <div
        className="absolute inset-0 opacity-[0.5]"
        style={{
          backgroundImage: 'radial-gradient(color-mix(in srgb, var(--fg) 9%, transparent) 1px, transparent 1px)',
          backgroundSize: '22px 22px',
        }}
      />
      <div className="absolute left-1/2 top-[10%] h-[520px] w-[900px] -translate-x-1/2 rounded-full opacity-[0.16] blur-[130px]" style={{ background: 'var(--primary)' }} />

      <svg viewBox="0 0 1000 400" preserveAspectRatio="none" className="absolute inset-x-0 bottom-0 h-[72%] w-full">
        <defs>
          <linearGradient id="dm-hero-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.22" />
            <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
          </linearGradient>
          <linearGradient id="dm-hero-fade" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--bg)" stopOpacity="1" />
            <stop offset="12%" stopColor="var(--bg)" stopOpacity="0" />
            <stop offset="88%" stopColor="var(--bg)" stopOpacity="0" />
            <stop offset="100%" stopColor="var(--bg)" stopOpacity="1" />
          </linearGradient>
        </defs>
        <rect x={x(LOWER)} y="0" width={x(UPPER) - x(LOWER)} height="400" fill="var(--primary)" opacity="0.06" />
        {[LOWER, UPPER].map((b) => (
          <line key={b} x1={x(b)} y1="0" x2={x(b)} y2="400" stroke="var(--primary)" strokeOpacity="0.25" strokeDasharray="6 8" vectorEffect="non-scaling-stroke" />
        ))}
        <path d={`${CURVE} L1000,400 L0,400 Z`} fill="url(#dm-hero-fill)" />
        <path d={CURVE} fill="none" stroke="var(--primary)" strokeOpacity="0.55" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <rect x="0" y="0" width="1000" height="400" fill="url(#dm-hero-fade)" />
      </svg>

      <div className="absolute inset-x-0 bottom-0 h-40" style={{ background: 'linear-gradient(to bottom, transparent, var(--bg))' }} />
    </div>
  )
}
