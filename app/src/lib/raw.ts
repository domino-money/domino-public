/**
 * Exact arithmetic on raw integer strings and the decimal strings the
 * onboarding and deposit contracts use, for the previews (#38) and the deposit
 * consumer (#40/#44). Nothing here converts an amount to a JS number: a uint256
 * does not fit one. Unit formatting is the read adapter's `formatUnits`.
 *
 * The one `Number(...)` is `parseSafeInteger`, for policy integers a user
 * types (ticks, basis points) and for `Retry-After`; it refuses anything that
 * is not a canonical safe integer.
 */
import { formatUnits } from './read/decimal'

const RAW = /^(0|[1-9]\d*)$/
const SAFE_INTEGER = /^-?(0|[1-9]\d{0,15})$/
const DECIMAL = /^(0|[1-9]\d*)(?:\.(\d+))?$/

export const UINT256_MAX = (1n << 256n) - 1n

/** A canonical non-negative integer string. */
export const isRaw = (value: unknown): value is string => typeof value === 'string' && RAW.test(value)

/** A canonical raw integer that fits in a uint256. */
export const isUint256 = (value: unknown): value is string => isRaw(value) && BigInt(value) <= UINT256_MAX

/**
 * A canonical safe integer from text, or null. No exponent, fraction, sign on
 * zero, leading zero or whitespace is accepted.
 */
export function parseSafeInteger(text: string): number | null {
  if (!SAFE_INTEGER.test(text)) return null
  const value = Number(text) // raw-guard: integer-policy-field
  return Number.isSafeInteger(value) && !Object.is(value, -0) ? value : null
}

/** Digit grouping, `1234567` → `1,234,567`. */
export function groupRaw(raw: string): string {
  return raw.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

export function mulRaw(a: string, b: string): string {
  return (BigInt(a) * BigInt(b)).toString()
}

export function addRaw(a: string, b: string): string {
  return (BigInt(a) + BigInt(b)).toString()
}

export function cmpRaw(a: string, b: string): -1 | 0 | 1 {
  const x = BigInt(a)
  const y = BigInt(b)
  return x === y ? 0 : x < y ? -1 : 1
}

/** Wei as exact ETH text, `33000000` → `0.000000000033 ETH`. Null for anything that is not raw. */
export function formatWeiEth(raw: string): string | null {
  const units = formatUnits(raw, 18)
  return units && units.kind === 'units' ? `${units.text} ETH` : null
}

/**
 * A raw token amount for display. With decimals unknown, the raw integer is
 * shown and labelled as raw units: decimals are never guessed.
 */
export function formatTokenAmount(raw: string, decimals: number | null, symbol: string | null): string {
  const units = formatUnits(raw, decimals)
  if (!units) return raw
  const unit = symbol ?? 'units'
  return units.kind === 'units' ? `${units.text} ${unit}` : `${units.text} raw units (decimals unknown)`
}

/**
 * A value in hundredths of a percent (basis points, which onboarding-v1 marks
 * `x-hundredths`) as percent text, by moving the decimal point two places:
 * `"25"` → `"0.25"`, `"10000"` → `"100"`, `"0.5"` → `"0.005"`. Exact for any
 * number of fraction digits. Null when the text is not a decimal string.
 */
export function hundredthsToPercentText(value: string): string | null {
  const match = DECIMAL.exec(value)
  if (!match) return null
  const fraction = match[2] ?? ''
  const digits = match[1] + fraction
  const scale = fraction.length + 2
  const padded = digits.padStart(scale + 1, '0')
  const whole = padded.slice(0, padded.length - scale).replace(/^0+(?=\d)/, '')
  const rest = padded.slice(padded.length - scale).replace(/0+$/, '')
  return rest ? `${whole}.${rest}` : whole
}
