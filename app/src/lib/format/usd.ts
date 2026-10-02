import { divRound, group, parseScaled, scaledText } from './decimal'
import { valueIn } from './price'

/**
 * USD next to token amounts (DESIGN-V2 §6.2, §0.7): only when one side of the
 * pair is USDG, valued at that pool's own price with 1 USDG = $1. Everything
 * is exact bigint arithmetic on decimal strings; only `formatUsd` rounds, and
 * only for display.
 */

type Valuation = {
  /** Raw integer amounts of currency0 and currency1. */
  amounts: readonly [bigint, bigint]
  decimals: readonly [number, number]
  sqrtPriceX96: bigint
}

/** USDG amount plus the other amount at the pool price (USDG per other), as a decimal string. */
export function usdgValue({ usdgIndex, ...rest }: Valuation & { usdgIndex: 0 | 1 }): string {
  return valueIn({ ...rest, into: usdgIndex })
}

/** The same in the pair's quote token (non-USDG pairs, §13). */
export function quoteValue({ quoteIndex, ...rest }: Valuation & { quoteIndex: 0 | 1 }): string {
  return valueIn({ ...rest, into: quoteIndex })
}

/**
 * `$1,234.56` at 1 and above; four significant digits below 1 (`$0.004213`);
 * `$0.00` for exactly zero. Rounded half away from zero. An unparsable value
 * comes back as it came in, never as an invented figure.
 */
export function formatUsd(value: string): string {
  const parsed = parseScaled(value)
  if (!parsed) return value
  const negative = parsed.units < 0n
  const units = negative ? -parsed.units : parsed.units
  const sign = negative ? '-' : ''
  if (units === 0n) return '$0.00'
  if (units < 10n ** BigInt(parsed.scale)) {
    // Below 1: four significant digits, never fewer than two fraction digits ($0.50, $0.004213).
    const keep = parsed.scale - units.toString().length + 4
    const rounded = rescale(units, parsed.scale, keep)
    if (rounded < 10n ** BigInt(keep)) {
      const text = scaledText(rounded, keep).replace(/0+$/, '')
      const [, fraction = ''] = text.split('.')
      return `${sign}$0.${fraction.padEnd(2, '0')}`
    }
    // It rounded up to 1: written in cents below.
  }
  const [whole, fraction] = scaledText(rescale(units, parsed.scale, 2), 2).split('.')
  return `${sign}$${group(whole)}.${fraction}`
}

/**
 * A position screen's dollar figure (audit E7, 2026-10-01): as formatUsd, but a positive amount under a cent reads
 * "<$0.01" rather than "$0.000005", as the Wallet card writes it. The exact figure is formatUsd's, for the title.
 */
export function formatUsdFloor(value: string): string {
  const parsed = parseScaled(value)
  if (!parsed || parsed.units <= 0n) return formatUsd(value)
  // A cent in the value's own units: 10^(scale − 2); a value with fewer than two places is a cent or more already.
  return parsed.scale > 2 && parsed.units < 10n ** BigInt(parsed.scale - 2) ? '<$0.01' : formatUsd(value)
}

/** `units / 10^from` as a count of 10^-to, rounded half away from zero when digits are dropped. */
function rescale(units: bigint, from: number, to: number): bigint {
  return to >= from ? units * 10n ** BigInt(to - from) : divRound(units, 10n ** BigInt(from - to))
}
