import { alignDown } from './scale'

/**
 * Inspection helpers (DESIGN-V2 §4.1): which index a pointer is over, which
 * side a tooltip goes, and the UTC-aligned buckets a series is summed into.
 * Pure and Node-safe; nothing here measures the DOM.
 */

/** The index of the value in sorted `xs` nearest `x`; −1 when `xs` is empty. */
export function nearestIndex(xs: readonly number[], x: number): number {
  if (xs.length === 0) return -1
  let lo = 0
  let hi = xs.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (xs[mid] < x) lo = mid + 1
    else hi = mid
  }
  if (lo > 0 && Math.abs(xs[lo - 1] - x) <= Math.abs(xs[lo] - x)) return lo - 1
  return lo
}

/** Right of the pointer until 55 % of the plot's width, then left, so a tooltip never needs measuring. */
export function tooltipSide(x: number, plotWidth: number): 'right' | 'left' {
  return x > plotWidth * 0.55 ? 'left' : 'right'
}

/**
 * Contiguous buckets of `spanSec` covering `[startSec, endSec]`, aligned to
 * UTC (hours, six hours and days on their boundaries, weeks on Monday). The
 * first bucket starts at or before `startSec`; the last ends at or after `endSec`.
 */
export function buckets(startSec: number, endSec: number, spanSec: number): { start: number; end: number }[] {
  if (!(spanSec > 0) || !(endSec >= startSec)) return []
  const out: { start: number; end: number }[] = []
  for (let start = alignDown(startSec, spanSec); start < endSec || out.length === 0; start += spanSec) {
    out.push({ start, end: start + spanSec })
  }
  return out
}
