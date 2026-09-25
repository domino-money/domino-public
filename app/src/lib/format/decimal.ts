/**
 * Exact decimal strings as scaled bigints, for the formatting helpers in this
 * folder. Pure and Node-safe: no DOM, no locale, no floating point on values.
 * A "decimal" here is what the app writes: an optional sign, digits with
 * optional `,` grouping, an optional fraction (`-1,234.5678`).
 */

export interface Scaled {
  /** The value times 10^scale, sign included. */
  units: bigint
  scale: number
}

const DECIMAL = /^([+\-−]?)(\d[\d,]*)?(?:\.(\d+))?$/

/** A decimal string as a scaled bigint, or null when it is not one. Grouping commas are ignored. */
export function parseScaled(text: string): Scaled | null {
  const match = DECIMAL.exec(text.trim())
  if (!match) return null
  const [, sign, whole = '', fraction = ''] = match
  if (whole === '' && fraction === '') return null
  const digits = `${whole.replaceAll(',', '')}${fraction}` || '0'
  const units = BigInt(digits)
  return { units: sign === '-' || sign === '−' ? -units : units, scale: fraction.length }
}

/** Both values at one scale, so they compare and add as bigints. */
export function align(a: Scaled, b: Scaled): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale)
  return [a.units * 10n ** BigInt(scale - a.scale), b.units * 10n ** BigInt(scale - b.scale), scale]
}

/** `units / 10^scale` written out exactly, with no grouping and no trailing-zero trimming. */
export function scaledText(units: bigint, scale: number): string {
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(scale + 1, '0')
  const whole = digits.slice(0, digits.length - scale)
  const fraction = scale > 0 ? `.${digits.slice(digits.length - scale)}` : ''
  return `${negative ? '-' : ''}${whole}${fraction}`
}

/** Divides and rounds half away from zero. */
export function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError('division by zero')
  const negative = numerator < 0n !== denominator < 0n
  const n = numerator < 0n ? -numerator : numerator
  const d = denominator < 0n ? -denominator : denominator
  const q = (n * 2n + d) / (2n * d)
  return negative ? -q : q
}

/** Groups a string of whole digits with commas: `1234567` → `1,234,567`. */
export function group(whole: string): string {
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}
