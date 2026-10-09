import { scaledText } from './decimal'

/**
 * A pool's price from its `sqrtPriceX96`, exactly (DESIGN-V2 §6.2): currency1
 * per currency0 in whole tokens, as a decimal string with 18 fraction digits,
 * truncated. Bigint fixed point throughout; never a float.
 */
export const PRICE_SCALE = 18

const Q192 = 1n << 192n

export function priceFromSqrt(sqrtPriceX96: bigint, dec0: number, dec1: number): string {
  if (sqrtPriceX96 <= 0n) throw new RangeError('sqrtPriceX96 must be positive')
  const shift = PRICE_SCALE + dec0 - dec1
  const square = sqrtPriceX96 * sqrtPriceX96
  const units = shift >= 0 ? (square * 10n ** BigInt(shift)) / Q192 : square / (Q192 * 10n ** BigInt(-shift))
  return scaledText(units, PRICE_SCALE)
}

/**
 * The same price the way the app writes the pool's (lib/read/orientation.ts, 2026-09-28): currency1 per currency0, or,
 * for a pool read the other way round (`inverted`), currency0 per currency1, 2¹⁹² / sqrt², in the same eighteen
 * fraction digits, truncated.
 */
export function priceFromSqrtIn(sqrtPriceX96: bigint, dec0: number, dec1: number, inverted: boolean): string {
  if (sqrtPriceX96 <= 0n) throw new RangeError('sqrtPriceX96 must be positive')
  if (!inverted) return priceFromSqrt(sqrtPriceX96, dec0, dec1)
  const shift = PRICE_SCALE + dec1 - dec0
  const square = sqrtPriceX96 * sqrtPriceX96
  const units = shift >= 0 ? (Q192 * 10n ** BigInt(shift)) / square : Q192 / (square * 10n ** BigInt(-shift))
  return scaledText(units, PRICE_SCALE)
}

/**
 * The value of both amounts in one of the pair's currencies (`into`), at one
 * pool price: that currency's own amount plus the other one converted at
 * `sqrtPriceX96`. Raw integer amounts in, a decimal string with 18 fraction
 * digits out (truncated).
 */
export function valueIn({
  amounts,
  decimals,
  into,
  sqrtPriceX96,
  fractionDigits = PRICE_SCALE,
}: {
  amounts: readonly [bigint, bigint]
  decimals: readonly [number, number]
  into: 0 | 1
  sqrtPriceX96: bigint
  /** Extra precision for chart geometry of atomic fees, without rounding a positive amount up. */
  fractionDigits?: number
}): string {
  if (sqrtPriceX96 <= 0n) throw new RangeError('sqrtPriceX96 must be positive')
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 336) throw new RangeError('Invalid value precision')
  const square = sqrtPriceX96 * sqrtPriceX96
  const [raw0, raw1] = amounts
  const scale = 10n ** BigInt(fractionDigits)
  // Both amounts in `into`'s raw units, as a fraction numerator / denominator.
  const numerator = into === 1 ? raw1 * Q192 + raw0 * square : raw0 * square + raw1 * Q192
  const denominator = (into === 1 ? Q192 : square) * 10n ** BigInt(decimals[into])
  return scaledText((numerator * scale) / denominator, fractionDigits)
}
