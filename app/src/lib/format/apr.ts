/**
 * A yearly rate as every screen writes it (audit E21, 2026-10-01): one decimal under 100%, whole percents from there
 * ("27.2%", "1,428%"), and "<0.1" for a positive sliver. Markets wrote two decimals ("27.18% est."), Your APR one
 * ("18.4%") and a pool's page "about 27%": one rule now. Rounded first, then sized (audit E8): 99.96% reads "100%",
 * never "100.0%". These are the digits only; the caller adds "%" and its own word ("est.", "about").
 */
import { compare, toFixed } from '../read/decimal'

/** The marker a positive rate too small for one decimal reads as. */
export const APR_SLIVER = '<0.1'

const group = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
/**
 * Added on purpose 2026-11-09 (core flows: "1.7,957…e+26%" reached a screen): from 1e21 on, String() writes a number in
 * exponent form and `group` put commas in it. Intl writes every whole digit, grouped, at any size.
 */
const WHOLE = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0, useGrouping: true })
const wholeText = (n: number) => (Math.abs(n) < 1e21 ? group(String(n)) : WHOLE.format(n))

/** A rate in percent, from a decimal string ("27.18" → "27.2", "529.83" → "530", "0.02" → "<0.1"). Null when it is not one. */
export function aprDigits(percent: string): string | null {
  const sign = compare(percent, '0')
  if (sign === null) return null
  if (sign !== 1) return toFixed(percent, 1)
  if (compare(percent, '0.05') !== 1) return APR_SLIVER
  const tenths = toFixed(percent, 1)
  if (tenths === null) return null
  if (compare(tenths, '100') === -1) return tenths
  const whole = toFixed(percent, 0)
  return whole === null ? null : group(whole)
}

/** The same from a number of percent, for rates worked out in the browser (Your APR, a pool page's sentence). */
export function aprDigitsOf(percent: number): string {
  if (!Number.isFinite(percent)) return '—'
  if (percent <= 0) return '0.0'
  // At or under 0.05, as the decimal rule above: half to even writes 0.05 as 0.0, and it is not zero.
  if (percent <= 0.05) return APR_SLIVER
  const tenths = Math.round(percent * 10) / 10
  if (tenths < 100) return tenths.toFixed(1)
  return wholeText(Math.round(percent))
}
