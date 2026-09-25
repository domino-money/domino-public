import { logScale } from './scale'

/**
 * Where a price range and the current price sit on a log price axis
 * (DESIGN-V2 §4.7). Pure and Node-safe. The domain is the range and the price
 * widened by 1.35× on each side, clamped to three decades either side of the
 * current price (or of the range's middle when the price is unknown). A bound
 * of 0 or below sits at the left edge, `Infinity` at the right edge.
 */
export interface RangeGeometry {
  lower: number
  upper: number
  current: number | null
}

const WIDEN = 1.35
const DECADES = 1000

const usable = (v: number) => Number.isFinite(v) && v > 0

export function rangeGeometry(lower: number, upper: number, current: number | null, width: number): RangeGeometry {
  const now = current !== null && usable(current) ? current : null
  const middle = now ?? (usable(lower) && usable(upper) ? Math.sqrt(lower * upper) : usable(lower) ? lower : usable(upper) ? upper : 1)
  const low = Math.min(usable(lower) ? lower : middle / DECADES, now ?? Infinity) / WIDEN
  const high = Math.max(usable(upper) ? upper : middle * DECADES, now ?? 0) * WIDEN
  const scale = logScale([Math.max(low, middle / DECADES), Math.min(high, middle * DECADES)], [0, width])
  const at = (v: number) => (v === Infinity ? width : !(v > 0) ? 0 : Math.min(width, Math.max(0, scale(v))))
  const a = at(lower)
  const b = at(upper)
  return { lower: Math.min(a, b), upper: Math.max(a, b), current: now === null ? null : at(now) }
}
