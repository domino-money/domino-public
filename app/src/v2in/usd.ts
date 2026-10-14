import { USDG } from '../config/mainTokens'
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

/**
 * Added 2026-10-14 (the incident of 2026-10-13, package V1; the owner's decision D4): how far apart the time a position's
 * amounts were read and the time its USD prices were served may be for their product to be a current figure: about two
 * minutes. Until then a list row with its own state reading lost its dollars 60 s after that reading, so one late or
 * refused read wrote "USD unavailable" on every Robinhood row. Further apart nothing new is worked out (amounts of one
 * moment never meet the prices of another unsaid): the last complete valuation is shown with its time instead
 * (./lists/valuation.ts).
 *
 * It is four periods of each of the two reads it compares, as they are today (the list's state read, lib/fees/
 * constants.ts LIST_STATE_REFRESH_MS, and the portfolio read, ./lists/source.ts: 30 s each). It must stay at least two
 * periods of the slower one, or a healthy page would say "as of" between two reads: whoever slows either read (the
 * design's Q1 and Q2) raises this with it, with the owner's word (D4).
 *
 * Written down on purpose 2026-10-14 (package V1, review), for the packages that follow. This is also how long a figure
 * goes without anything newer arriving before it says its time (./lists/valuation.ts usdAged: counted from when this
 * page took its amounts and its prices). The design's Q2 sets the idle portfolio period to 120 s, which equals it: left
 * as it is, every healthy idle row would flash "as of HH:MM UTC" once per cycle (the answer lands at 120 s plus the
 * request's own time), and a state reading up to 60 s old beside a portfolio answer up to 120 s old also crosses the two
 * minutes. So Q2 must raise this in the same change (about 240 s, the owner's word), and add the test that a healthy
 * idle list, read at its new periods for ten minutes, never shows "as of".
 */
export const USD_CURRENT_SECONDS = 120

/**
 * What one valuation reads: a position's principal and fees with the pool mark of the same read, the USD price of each
 * of its two currencies (pool order), and when each side was read. A time of null: not known, or not current by its
 * own source's word (read-v6 calls its reading stale, or its chain is not current).
 */
export interface UsdInputs {
  principal: readonly [bigint, bigint] | null
  fees: readonly [bigint, bigint] | null
  decimals: readonly [number | null, number | null]
  prices: readonly [string | null | undefined, string | null | undefined]
  sqrtPriceX96: bigint | string | null
  allowPoolMark?: boolean
  /** Unix seconds. */
  readAt: number | null
  quotedAt: number | null
}

export interface CurrentUsd {
  value: PoolUsdValue | null
  fees: PoolUsdValue | null
  /** What the figures are as of (Unix seconds): the older of the amounts and the prices. */
  at: number
}

/**
 * The one valuation of a position, for the list's row, Robinhood Chain's own position page and the V2 page alike (the
 * same position showed dollars in the list and token amounts on its page until 2026-10-14): each of its two figures by
 * usdOfPoolAmounts above, while its amounts and its prices are within USD_CURRENT_SECONDS of each other. Null when they
 * are not, or when either time is unknown. A figure of null inside the answer: current, and no basis for that figure.
 * Pure.
 */
export function currentUsd(inputs: UsdInputs): CurrentUsd | null {
  const { readAt, quotedAt } = inputs
  if (readAt === null || quotedAt === null || !Number.isFinite(readAt) || !Number.isFinite(quotedAt) || Math.abs(quotedAt - readAt) > USD_CURRENT_SECONDS) return null
  const worth = (amounts: readonly [bigint, bigint] | null) => usdOfPoolAmounts({ amounts, decimals: inputs.decimals, prices: inputs.prices, sqrtPriceX96: inputs.sqrtPriceX96, allowPoolMark: inputs.allowPoolMark })
  return { value: worth(inputs.principal), fees: worth(inputs.fees), at: Math.min(readAt, quotedAt) }
}

/**
 * Added 2026-10-14 (package V1): the chain's own dollar, for a position read-v6 says nothing about (the site's own
 * inventory of Robinhood positions, or the Robinhood page with no portfolio read): Robinhood Chain's USDG at 1, the rule
 * that page has valued a USDG pair by since 2026-09 (components/positions/visual/value.ts). Never used over what read-v6
 * says of a token: a price it withholds stays withheld.
 */
export const chainDollar = (chainId: number, address: string): string | null => (chainId === 4663 && address.toLowerCase() === USDG ? '1' : null)

/** Raw integer strings as the contract writes them, or null for anything else. */
export function rawAmounts(values: readonly (string | null)[]): bigint[] | null {
  if (values.some((value) => value === null || !/^\d+$/.test(value))) return null
  return values.map((value) => BigInt(value as string))
}
