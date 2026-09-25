/**
 * Chart scales and ticks (DESIGN-V2 §4.1). Pure and Node-safe. Values here
 * are screen geometry, so plain numbers are right: exact figures stay strings
 * in the page and only their positions are floats.
 */

export type Scale = (v: number) => number

/** A linear map from `domain` to `range`. A zero-width domain maps everything to the middle of the range. */
export function linearScale(domain: readonly [number, number], range: readonly [number, number]): Scale {
  const [d0, d1] = domain
  const [r0, r1] = range
  const width = d1 - d0
  if (!Number.isFinite(width) || width === 0) {
    const middle = (r0 + r1) / 2
    return () => middle
  }
  const k = (r1 - r0) / width
  return (v) => r0 + (v - d0) * k
}

/**
 * A log map for price axes. The domain must be positive (a non-positive or
 * zero-width domain maps to the middle); a value ≤ 0 has no place on a log
 * axis and is put at the range's start. `Infinity` maps past the end, so a
 * caller clamps it to the edge.
 */
export function logScale(domain: readonly [number, number], range: readonly [number, number]): Scale {
  const [d0, d1] = domain
  const [r0, r1] = range
  if (!(d0 > 0) || !(d1 > 0) || d0 === d1 || !Number.isFinite(d0) || !Number.isFinite(d1)) {
    const middle = (r0 + r1) / 2
    return () => middle
  }
  const l0 = Math.log(d0)
  const k = (r1 - r0) / (Math.log(d1) - l0)
  return (v) => (v > 0 ? r0 + (Math.log(v) - l0) * k : r0)
}

/** "Nice" ticks inside `[min, max]` on a 1/2/5 × 10^k step, about `count` of them. */
export function niceTicks(min: number, max: number, count = 3): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return []
  if (min === max) return [min]
  const lo = Math.min(min, max)
  const hi = Math.max(min, max)
  const raw = (hi - lo) / Math.max(1, count)
  const power = 10 ** Math.floor(Math.log10(raw))
  const error = raw / power
  // The usual thresholds (√50, √10, √2): the step whose tick count lands nearest the one asked for.
  const step = (error >= 7.07 ? 10 : error >= 3.16 ? 5 : error >= 1.41 ? 2 : 1) * power
  const first = Math.ceil(lo / step - 1e-9)
  const last = Math.floor(hi / step + 1e-9)
  const ticks: number[] = []
  // Multiplying the integer index keeps 0.1 + 0.2 drift out of the labels.
  for (let i = first; i <= last; i++) ticks.push(Number((i * step).toPrecision(12)))
  return ticks
}

const HOUR = 3600
const DAY = 86_400
const WEEK = 7 * DAY
/** 1970-01-05 was a Monday: weeks are aligned to Monday 00:00 UTC. */
const MONDAY = 4 * DAY
const STEPS = [HOUR, 6 * HOUR, DAY, WEEK]

/** The UTC-aligned start of the step that holds `sec`. */
export function alignDown(sec: number, step: number): number {
  const offset = step === WEEK ? MONDAY : 0
  return Math.floor((sec - offset) / step) * step + offset
}

/**
 * Time ticks inside `[startSec, endSec]` on the smallest of an hour, six
 * hours, a day or a week that gives at most `count` ticks, aligned to UTC.
 */
export function timeTicks(startSec: number, endSec: number, count = 5): number[] {
  if (!(endSec > startSec)) return []
  const span = endSec - startSec
  const step = STEPS.find((s) => span / s <= count) ?? Math.ceil(span / count / WEEK) * WEEK
  const ticks: number[] = []
  let t = alignDown(startSec, step)
  if (t < startSec) t += step
  for (; t <= endSec; t += step) ticks.push(t)
  return ticks
}
