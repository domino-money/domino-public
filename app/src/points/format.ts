/**
 * The Points page's numbers (integ-logs/points/PROPOSAL.md §4, the owner's decision D3). points-v1 answers points as
 * decimal text with six places ("1715.000000") and US dollars with eighteen; nothing here turns either into a number
 * with a floating point. Every figure is cut, never rounded up (the service itself counts with ROUND_DOWN), so the page
 * never shows more than was counted.
 *
 *   - 100 points or more: whole points with thousands separators (`1,715`, `1,234,567`);
 *   - from 0.01 to 99.99: up to two places, no trailing zeros (`65`, `65.5`, `12.34`);
 *   - under 0.01 but not zero: `<0.01`; zero: `0`;
 *   - dollars: two places (`$0.65`, `$1,234.56`), under a cent but not zero `<$0.01`, zero `$0`;
 *   - points by kind of fee: the dollars times 1,000, the decimal point moved three places in the text (exact).
 *
 * Pure, strings in and strings out. tests/points-format.test.mjs reads this file and holds it to no float conversion.
 */

/** A non-negative decimal as points-v1 writes them: digits, then an optional point and digits. */
const DECIMAL = /^(\d+)(?:\.(\d+))?$/

const group = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
const whole = (digits: string) => digits.replace(/^0+(?=\d)/, '')

/** The parts of a decimal, or null for text that is not one (shown as a dash by the caller). */
function parts(text: string): { int: string; frac: string } | null {
  const match = DECIMAL.exec(text)
  return match ? { int: whole(match[1]), frac: match[2] ?? '' } : null
}

/** Points as the page shows them: "1715.000000" is `1,715`, "65.500000" `65.5`, "0.004000" `<0.01`. */
export function pointsText(text: string): string {
  const value = parts(text)
  if (!value) return '–'
  if (value.int === '0' && !/[1-9]/.test(value.frac)) return '0'
  if (value.int.length >= 3) return group(value.int)
  const two = value.frac.padEnd(2, '0').slice(0, 2)
  if (value.int === '0' && two === '00') return '<0.01'
  const cut = two.replace(/0+$/, '')
  return cut ? `${group(value.int)}.${cut}` : group(value.int)
}

/** US dollars, cut to the cent: "0.650000000000000000" is `$0.65`. */
export function usdText(text: string): string {
  const value = parts(text)
  if (!value) return '–'
  const cents = value.frac.padEnd(2, '0').slice(0, 2)
  if (value.int === '0' && cents === '00') return /[1-9]/.test(value.frac) ? '<$0.01' : '$0'
  return `$${group(value.int)}.${cents}`
}

/** 1,000 points per US dollar, exactly: the dollars' decimal point moved three places, with points-v1's six places. */
export function usdToPoints(text: string): string {
  const value = parts(text)
  if (!value) return '0.000000'
  const frac = value.frac.padEnd(9, '0')
  return `${whole(`${value.int}${frac.slice(0, 3)}`)}.${frac.slice(3, 9)}`
}

/** Whether a decimal is zero (or not a decimal at all). */
export const isZero = (text: string): boolean => !parts(text) || !/[1-9]/.test(text)

/** An address at a glance: `0x4a62…c569`. The whole address is the element's title. */
export const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`

/** A SHA-256 at a glance: `1657…fd98`. */
export const shortHash = (hash: string): string => `${hash.slice(0, 4)}…${hash.slice(-4)}`

const two = (n: number) => String(n).padStart(2, '0')

/** The UTC clock of a count (Unix seconds): `02:05 UTC`. */
export function utcClock(seconds: number): string {
  const at = new Date(seconds * 1000)
  return `${two(at.getUTCHours())}:${two(at.getUTCMinutes())} UTC`
}
