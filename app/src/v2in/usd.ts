import { parseScaled, scaledText } from '../lib/format/decimal'
import { valueIn } from '../lib/format/price'

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

export type PoolUsdValue =
  | { value: string; basis: 'qualified-prices' }
  | { value: string; basis: 'pool-price'; anchor: 0 | 1 }

/**
 * A display estimate for one pool's amounts. Prefer each currency's qualified USD price. When exactly one currency
 * has a qualified price, mark both amounts into that currency at this pool's observed sqrtPriceX96, then into USD:
 * the owner-approved New position rule (components/create/valuation.ts, 2026-10-06), also used by USDG positions.
 *
 * The caller supplies a fresh, coherent position observation, and only qualified read prices (chain + address).
 * A pool mark is NOT an independent qualified price for the other currency, a swap quote, or an APR input. Its basis
 * and anchor are returned for disclosure; no token price or source qualification is changed here. Callers exclude
 * unsupported/hooked pools with allowPoolMark=false. Zero amounts need neither decimals nor prices.
 */
export function usdOfPoolAmounts({ amounts, decimals, prices, sqrtPriceX96, allowPoolMark = true }: {
  amounts: readonly [bigint, bigint] | null
  decimals: readonly [number | null, number | null]
  prices: readonly [string | null | undefined, string | null | undefined]
  sqrtPriceX96: bigint | string | null
  allowPoolMark?: boolean
}): PoolUsdValue | null {
  if (!amounts || amounts.some(raw => raw < 0n)) return null
  const knownDecimals = decimals.map(value => value !== null && Number.isInteger(value) && value >= 0 && value <= 255 ? value : null)
  const qualified = prices.map(text => {
    const price = text ? parseScaled(text) : null
    return price && price.units > 0n ? text! : null
  })
  const direct = usdOfRaw(amounts.map((raw, index) => ({ raw, decimals: knownDecimals[index], usd: qualified[index] })))
  if (direct !== null) return { value: direct, basis: 'qualified-prices' }

  const anchor = qualified[0] !== null && qualified[1] === null ? 0 : qualified[1] !== null && qualified[0] === null ? 1 : null
  if (!allowPoolMark || anchor === null || knownDecimals[anchor] === null || sqrtPriceX96 === null) return null
  try {
    const sqrt = BigInt(sqrtPriceX96)
    if (sqrt <= 0n || sqrt >= 1n << 160n) return null
    const targetDecimals = knownDecimals[anchor] as number
    // The ratio converts raw units, so only the priced currency's decimals are needed. Keep New position's exact
    // truncation: first the whole-token amount at 18 places, then that amount at the qualified USD price.
    const marked = parseScaled(valueIn({ amounts, decimals: [targetDecimals, targetDecimals], into: anchor, sqrtPriceX96: sqrt }))
    if (!marked) return null
    const value = usdOfRaw([{ raw: marked.units, decimals: marked.scale, usd: qualified[anchor] }])
    return value === null ? null : { value, basis: 'pool-price', anchor }
  } catch {
    return null
  }
}

/** Raw integer strings as the contract writes them, or null for anything else. */
export function rawAmounts(values: readonly (string | null)[]): bigint[] | null {
  if (values.some((value) => value === null || !/^\d+$/.test(value))) return null
  return values.map((value) => BigInt(value as string))
}
