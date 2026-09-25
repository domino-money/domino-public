import { align, divRound, parseScaled, scaledText } from './decimal'

/**
 * Comparing and changing figures as the page shows them (DESIGN-V2 §6.3):
 * exact decimal arithmetic on strings, never floats.
 */

/** −1, 0 or 1 as `a` is below, equal to or above `b`; 0 when either is not a decimal. */
export function compareDecimal(a: string | null, b: string | null): -1 | 0 | 1 {
  const x = a === null ? null : parseScaled(a)
  const y = b === null ? null : parseScaled(b)
  if (!x || !y) return 0
  const [p, q] = align(x, y)
  return p < q ? -1 : p > q ? 1 : 0
}

/**
 * The number inside a figure's text: `$1,234.56` → `1234.56`, `≈0.617502 USDG per PONS` → `0.617502`,
 * `−1.23%` → `-1.23`. `$`, `,`, `≈`, `%`, spaces and unit words are dropped. Null when there is no number.
 */
export function numericPart(text: string): string | null {
  const cleaned = text.replace(/[$,≈%\s]/g, '')
  const match = /[+\-−]?\d+(?:\.\d+)?/.exec(cleaned)
  if (!match) return null
  return match[0].replace('−', '-').replace(/^\+/, '')
}

/** Compares two displayed figures by their numbers. */
export function compareDisplayed(a: string, b: string): -1 | 0 | 1 {
  return compareDecimal(numericPart(a), numericPart(b))
}

/**
 * The change from one decimal to another in percent, two decimals, rounded
 * half away from zero: `{ sign: 1, text: '1.23%' }` (the text is unsigned; the
 * sign travels separately). A change that rounds to zero has sign 0 and reads
 * `0.00%`. Null when `from` is zero or either side is not a decimal.
 */
export function percentChange(from: string, to: string): { sign: -1 | 0 | 1; text: string } | null {
  const a = parseScaled(from.replaceAll(',', ''))
  const b = parseScaled(to.replaceAll(',', ''))
  if (!a || !b || a.units === 0n) return null
  const [p, q] = align(a, b)
  // Hundredths of a percent: (q − p) / p × 100 × 100.
  const hundredths = divRound((q - p) * 10_000n, p)
  const sign = hundredths > 0n ? 1 : hundredths < 0n ? -1 : 0
  return { sign, text: `${scaledText(hundredths < 0n ? -hundredths : hundredths, 2)}%` }
}
