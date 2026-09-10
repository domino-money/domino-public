import { SCENARIO_MAX, SCENARIO_MIN } from './pair'

/** Inclusive price window a chart is drawn over. */
export type Domain = [number, number]

export const DEFAULT_DOMAIN: Domain = [SCENARIO_MIN, SCENARIO_MAX]

export const round2 = (v: number) => Math.round(v * 100) / 100

/** Bounds a range edge can hold. The band must always straddle the start price. */
export const clampLower = (v: number) => round2(Math.min(0.99, Math.max(0.01, v)))
export const clampUpper = (v: number) => round2(Math.max(1.01, Math.min(100, v)))

/** A price domain wide enough to show the given bounds with some room. */
export function domainFor(lower: number, upper: number): Domain {
  const lo = Math.min(SCENARIO_MIN, Math.floor(lower * 0.7 * 100) / 100)
  const hi = Math.max(SCENARIO_MAX, Math.ceil(upper * 1.3 * 100) / 100)
  return [Math.max(0.01, lo), hi]
}

/**
 * Price under a horizontal pointer position, clamped to the domain.
 *
 * Kept pure and separate from the chart so the drag behaviour can be tested
 * without a DOM: the bound-drag regression is entirely a question of whether
 * the domain passed in here changes between pointer events.
 */
export function priceAt(clientX: number, left: number, width: number, domain: Domain): number {
  const [lo, hi] = domain
  if (width <= 0) return lo
  const ratio = (clientX - left) / width
  return Math.min(hi, Math.max(lo, lo + ratio * (hi - lo)))
}

/** Position of a price within a domain, as a percentage of the chart width. */
export function positionOf(price: number, domain: Domain): number {
  const [lo, hi] = domain
  if (hi <= lo) return 0
  return ((price - lo) / (hi - lo)) * 100
}
