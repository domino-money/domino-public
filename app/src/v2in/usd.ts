import { parseScaled, scaledText } from '../lib/format/decimal'

/**
 * Added 2026-10-06 (rugged97's delta of 5 Oct, item 4: read-v6 1.1.0-rc.1's qualified USD, by the owner's rules of
 * decision #22): what raw token amounts are worth at the USD prices read-v6 gave their tokens (per whole token, 18
 * decimals), each term rounded down, as a decimal string at 18 places. Null when an amount above zero has no price or no
 * decimals: then no figure at all, never a zero (an amount of zero needs neither). Pure.
 */
export function usdOfRaw(parts: readonly { raw: bigint; decimals: number | null; usd: string | null | undefined }[]): string | null {
  let total = 0n
  for (const part of parts) {
    if (part.raw === 0n) continue
    const price = part.usd ? parseScaled(part.usd) : null
    if (part.raw < 0n || part.decimals === null || !price || price.units < 0n) return null
    total += (part.raw * price.units * 10n ** 18n) / 10n ** BigInt(price.scale + part.decimals)
  }
  return scaledText(total, 18)
}

/** Raw integer strings as the contract writes them, or null for anything else. */
export function rawAmounts(values: readonly (string | null)[]): bigint[] | null {
  if (values.some((value) => value === null || !/^\d+$/.test(value))) return null
  return values.map((value) => BigInt(value as string))
}
