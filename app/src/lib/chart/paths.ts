/**
 * SVG path strings for chart series (DESIGN-V2 §4.1). Pure and Node-safe.
 *
 * Curve rule: a continuous segment of fewer than 20 points, or any data with
 * gaps, is drawn `linear` inside each segment and never joined across a gap;
 * 20 points or more may be `monotone` (Fritsch–Carlson: no overshoot, so a
 * curve never shows a value the data does not have). Cumulative fee series
 * are always linear.
 */

export interface Point {
  x: number
  y: number
}
export type Curve = 'linear' | 'monotone'

const n = (value: number) => String(Math.round(value * 100) / 100)

/** The curve to use for one continuous segment. */
export function curveFor(points: number, preferred: Curve = 'monotone'): Curve {
  return points >= 20 ? preferred : 'linear'
}

/** Tangents for a monotone cubic through `pts` (sorted by x). */
function tangents(pts: readonly Point[]): number[] {
  const count = pts.length
  const slopes: number[] = []
  for (let i = 0; i < count - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x
    slopes.push(dx === 0 ? 0 : (pts[i + 1].y - pts[i].y) / dx)
  }
  const m: number[] = Array.from({ length: count }, () => 0)
  m[0] = slopes[0]
  m[count - 1] = slopes[count - 2]
  for (let i = 1; i < count - 1; i++) m[i] = slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2
  // Fritsch–Carlson: keep every tangent inside the circle of radius 3 so the curve stays monotone per interval.
  for (let i = 0; i < count - 1; i++) {
    if (slopes[i] === 0) {
      m[i] = 0
      m[i + 1] = 0
      continue
    }
    const a = m[i] / slopes[i]
    const b = m[i + 1] / slopes[i]
    const h = a * a + b * b
    if (h > 9) {
      const t = 3 / Math.sqrt(h)
      m[i] = t * a * slopes[i]
      m[i + 1] = t * b * slopes[i]
    }
  }
  return m
}

/** A line through `pts`: `M x y L …` (linear) or cubic segments (monotone). One point is a bare `M`. */
export function linePath(pts: readonly Point[], curve: Curve = 'linear'): string {
  if (pts.length === 0) return ''
  const head = `M${n(pts[0].x)} ${n(pts[0].y)}`
  if (pts.length === 1) return head
  if (curve === 'linear' || pts.length < 3) return head + pts.slice(1).map((p) => ` L${n(p.x)} ${n(p.y)}`).join('')
  const m = tangents(pts)
  let d = head
  for (let i = 0; i < pts.length - 1; i++) {
    const p = pts[i]
    const q = pts[i + 1]
    const dx = (q.x - p.x) / 3
    d += ` C${n(p.x + dx)} ${n(p.y + m[i] * dx)} ${n(q.x - dx)} ${n(q.y - m[i + 1] * dx)} ${n(q.x)} ${n(q.y)}`
  }
  return d
}

/** The area under a line, closed down to `baselineY`. */
export function areaPath(pts: readonly Point[], curve: Curve, baselineY: number): string {
  if (pts.length < 2) return ''
  const first = pts[0]
  const last = pts[pts.length - 1]
  return `${linePath(pts, curve)} L${n(last.x)} ${n(baselineY)} L${n(first.x)} ${n(baselineY)} Z`
}

/**
 * Closes an existing line path (an `M…L…` string such as `ratioGeometry`'s
 * paths) down to `baselineY`. The first two numbers are its start, the last
 * two its end. A path with fewer than two points closes nothing.
 */
export function areaUnder(linePathD: string, baselineY: number): string {
  const numbers = linePathD.match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []
  if (numbers.length < 4) return ''
  const firstX = numbers[0]
  const lastX = numbers[numbers.length - 2]
  return `${linePathD} L${lastX} ${n(baselineY)} L${firstX} ${n(baselineY)} Z`
}
