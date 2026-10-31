/**
 * Decimal strings and raw integer strings, without `Number`.
 *
 * Every monetary and raw uint256 value in the contract is a string. A JS number
 * cannot hold a uint256 and silently rounds past 2^53, so nothing here converts
 * one. Values are parsed into a BigInt coefficient and a scale, only after the
 * package runtime has validated the payload, and formatted back to text.
 *
 * Rounding is half-to-even: 10.45M reads $10.4M.
 */

/** An exact decimal: `coefficient / 10^scale`. */
export interface Decimal {
  coefficient: bigint
  scale: number
}

const DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/
const RAW_INTEGER = /^(0|[1-9]\d*)$/

export function parseDecimal(text: string): Decimal | null {
  const match = DECIMAL.exec(text)
  if (!match) return null
  const [, sign, whole, fraction = ''] = match
  const coefficient = BigInt(whole + fraction)
  return { coefficient: sign ? -coefficient : coefficient, scale: fraction.length }
}

const pow10 = (n: number) => 10n ** BigInt(n)

/** Integer division rounding half to even. `divisor` must be positive. */
function divideHalfEven(numerator: bigint, divisor: bigint): bigint {
  const negative = numerator < 0n
  const n = negative ? -numerator : numerator
  let quotient = n / divisor
  const twice = (n % divisor) * 2n
  if (twice > divisor || (twice === divisor && quotient % 2n === 1n)) quotient += 1n
  return negative ? -quotient : quotient
}

/** The value rounded to `places` fraction digits, as a bigint scaled by 10^places. */
function scaled(value: Decimal, places: number): bigint {
  if (value.scale <= places) return value.coefficient * pow10(places - value.scale)
  return divideHalfEven(value.coefficient, pow10(value.scale - places))
}

/** Plain fixed-point text of a scaled integer. */
function fixedText(units: bigint, places: number): string {
  const negative = units < 0n
  const digits = (negative ? -units : units).toString().padStart(places + 1, '0')
  const whole = digits.slice(0, digits.length - places)
  const body = places > 0 ? `${whole}.${digits.slice(digits.length - places)}` : whole
  return negative ? `-${body}` : body
}

/**
 * Digit grouping for the integer part, the way `toLocaleString('en-US')` writes it. Exported 2026-10-31 (QA round 2
 * follow-ups, N2) for the pool page's precise APR estimate, so it reads "1,205.5927" as every other percent is grouped.
 */
export function grouped(text: string): string {
  const [whole, fraction] = text.split('.')
  const sign = whole.startsWith('-') ? '-' : ''
  const digits = sign ? whole.slice(1) : whole
  const withCommas = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${withCommas}${fraction !== undefined ? `.${fraction}` : ''}`
}

/** A decimal string to `places` digits, half to even. Null when it is not a decimal. */
export function toFixed(text: string, places: number): string | null {
  const value = parseDecimal(text)
  return value ? fixedText(scaled(value, places), places) : null
}

export const isZero = (value: Decimal) => value.coefficient === 0n

/**
 * Compact USD for table cells: $12.00B, $10.4M, $582.7K, $42.50.
 *
 * A positive amount below one cent keeps six places, the workbench's rule for
 * money, so a real but tiny figure never reads as $0.00;
 * one too small even for that reads <$0.000001. A measured zero is $0.00.
 * Null for anything that is not a decimal string.
 */
export function formatUsdCompact(text: string): string | null {
  const value = parseDecimal(text)
  if (!value) return null
  const negative = value.coefficient < 0n
  const abs: Decimal = { coefficient: negative ? -value.coefficient : value.coefficient, scale: value.scale }
  const sign = negative ? '-' : ''
  const atLeast = (threshold: bigint) => abs.coefficient >= threshold * pow10(abs.scale)
  const steps: Array<[bigint, number, string, number]> = [
    [1_000_000_000n, 9, 'B', 2],
    [1_000_000n, 6, 'M', 1],
    [1_000n, 3, 'K', 1],
  ]
  const inUnit = ([, exponent, suffix, places]: [bigint, number, string, number]) => {
    const units = scaled({ coefficient: abs.coefficient, scale: abs.scale + exponent }, places)
    return { text: `${sign}$${fixedText(units, places)}${suffix}`, full: units >= 1_000n * pow10(places) }
  }
  // Rounded first, then sized (audit E8, 2026-10-01): $999,950 read "$1000.0K" and is "$1.0M".
  let unit = steps.findIndex(([threshold]) => atLeast(threshold))
  if (unit !== -1) {
    let shown = inUnit(steps[unit])
    while (shown.full && unit > 0) {
      unit -= 1
      shown = inUnit(steps[unit])
    }
    return shown.text
  }
  const cents = abs.coefficient > 0n && abs.coefficient * 100n < pow10(abs.scale)
  const places = cents ? 6 : 2
  const units = scaled(abs, places)
  // Too small even for six places is still not zero.
  if (units === 0n && abs.coefficient > 0n) return negative ? '>-$0.000001' : '<$0.000001'
  return `${sign}$${grouped(fixedText(units, places))}`
}

const NON_NEGATIVE = /^(\d+)(?:\.(\d+))?$/

/** `units / 10^scale` to `places` fraction digits, half up, as a bigint scaled by 10^places. `units` is not negative. */
function roundHalfUp(units: bigint, scale: number, places: number): bigint {
  if (scale <= places) return units * pow10(places - scale)
  const divisor = pow10(scale - places)
  const quotient = units / divisor
  return (units % divisor) * 2n >= divisor ? quotient + 1n : quotient
}

/**
 * A USD price from a provider decimal string, for chart labels and the readout: "$2,492.94".
 *
 * Grouping with commas; at least 2 decimals. A value of 1 or more is written to
 * exactly two places ("$2,492.94", "$1.00"); a value below 1 keeps up to 6
 * significant digits, with trailing zeros dropped but never fewer than two
 * places ("$0.0004123", "$0.99985", "$0.50"). Rounds half up on the string
 * digits, and a value that rounds up to 1 is written as "$1.00"; zero is
 * "$0.00". Null when `value` is not a non-negative decimal string ("-1", "1e6",
 * ".5" and "" are all null). String and BigInt arithmetic only, like everything
 * in this file: a JS number never holds the value.
 */
export function formatUsdPrice(value: string): string | null {
  const match = NON_NEGATIVE.exec(value)
  if (!match) return null
  const [, whole, fraction = ''] = match
  const scale = fraction.length
  const units = BigInt(whole + fraction)
  if (units >= pow10(scale)) return `$${grouped(fixedText(roundHalfUp(units, scale, 2), 2))}`
  if (units === 0n) return '$0.00'
  // Below one: the places that hold six significant digits, counted from the first non-zero digit.
  const places = scale - units.toString().length + 6
  const rounded = roundHalfUp(units, scale, places)
  if (rounded >= pow10(places)) return '$1.00'
  const text = fixedText(rounded, places)
  const [integer, digits] = text.split('.')
  const kept = digits.replace(/0+$/, '').padEnd(2, '0')
  return `$${integer}.${kept}`
}

/**
 * `a / b` to `places` digits, half to even, or null when b is zero or either
 * side is not a decimal. Exact: both sides are brought to one scale as BigInt.
 */
export function ratio(a: string, b: string, places: number): string | null {
  const x = parseDecimal(a)
  const y = parseDecimal(b)
  if (!x || !y || y.coefficient === 0n) return null
  // x/y = (xc / 10^xs) / (yc / 10^ys) = (xc * 10^ys) / (yc * 10^xs)
  let numerator = x.coefficient * pow10(y.scale) * pow10(places)
  let denominator = y.coefficient * pow10(x.scale)
  if (denominator < 0n) {
    numerator = -numerator
    denominator = -denominator
  }
  return fixedText(divideHalfEven(numerator, denominator), places)
}

/** Compare two decimal strings. Null when either is not a decimal. */
export function compare(a: string, b: string): -1 | 0 | 1 | null {
  const x = parseDecimal(a)
  const y = parseDecimal(b)
  if (!x || !y) return null
  const scale = Math.max(x.scale, y.scale)
  const left = x.coefficient * pow10(scale - x.scale)
  const right = y.coefficient * pow10(scale - y.scale)
  return left === right ? 0 : left < right ? -1 : 1
}

export type UnitsText =
  | { kind: 'units'; text: string }
  /** Decimals unknown: the raw integer, which must be labelled raw where it is shown. */
  | { kind: 'raw'; text: string }

/**
 * A raw token amount in display units. With decimals unknown the raw integer
 * is returned as such, never guessed into units. Trailing fraction zeros are
 * dropped; zero is "0".
 */
export function formatUnits(raw: string, decimals: number | null): UnitsText | null {
  if (!RAW_INTEGER.test(raw)) return null
  if (decimals === null) return { kind: 'raw', text: grouped(raw) }
  if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255) return null
  const units = fixedText(BigInt(raw), decimals)
  const trimmed = units.includes('.') ? units.replace(/0+$/, '').replace(/\.$/, '') : units
  return { kind: 'units', text: grouped(trimmed) }
}
