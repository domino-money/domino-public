/**
 * Token amounts at a readable length (DESIGN-V2 §6.1). The whole part is never
 * cut and keeps its grouping; the fraction keeps digits until six significant
 * digits in total; nothing is rounded up. `head + tail === full` always, so a
 * caller can dim the tail instead of dropping it.
 */

export interface ShortAmount {
  /** At most six significant digits, trailing fraction zeros and a trailing `.` removed. */
  short: string
  /** The exact prefix of `full` that holds the six significant digits. */
  head: string
  /** The rest of `full`. */
  tail: string
  full: string
  /** Whether `short` differs from `full`. */
  cut: boolean
}

const SIGNIFICANT = 6
const AMOUNT = /^([≈~]?[+\-−]?)(\d[\d,]*)(\.\d*)?$/

export function shortAmount(text: string): ShortAmount {
  const full = text
  const match = AMOUNT.exec(full)
  if (!match) return { short: full, head: full, tail: '', full, cut: false }
  const [, prefix, whole, fraction = ''] = match
  const wholeDigits = whole.replaceAll(',', '')
  const firstNonZero = wholeDigits.search(/[1-9]/)
  let significant = firstNonZero === -1 ? 0 : wholeDigits.length - firstNonZero
  let kept = 0
  if (significant < SIGNIFICANT && fraction.length > 1) {
    const digits = fraction.slice(1)
    for (; kept < digits.length && significant < SIGNIFICANT; kept++) {
      if (significant > 0 || digits[kept] !== '0') significant++
    }
  }
  // With no fraction digit kept, the point goes to the tail too.
  const headLength = prefix.length + whole.length + (kept > 0 ? kept + 1 : 0)
  const head = full.slice(0, headLength)
  const tail = full.slice(headLength)
  const short = head.includes('.') ? head.replace(/0+$/, '').replace(/\.$/, '') : head
  return { short, head, tail, full, cut: short !== full }
}
