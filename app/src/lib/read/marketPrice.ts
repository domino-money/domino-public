/**
 * The price a markets row shows: the pool's own ratio, from the state the
 * chain holds at the block the row was read at. Never a dollar figure, never
 * a provider's number, never an executable quote.
 *
 * It is the same rule as the pool page and the range planner (poolPrice in
 * screens/poolRange.ts), applied to a table row: the tick must agree with the
 * square-root price, checked exactly in BigInt with Uniswap's TickMath; both
 * tokens' decimals must come from the row's own token reads, matched by
 * address; and the ratio must be writable as a plain number. Anything short
 * of that is unavailable, with the reason.
 *
 * Written the way a person reads a price (changed on purpose 2026-09-27,
 * r6/marketsdata, the owner: "0.000011853 cbBTC per USDG" meant nothing to a
 * beginner): one of a token, so much of the other, "1 cbBTC = 84,367 USDG".
 * Which token is the one is the app's one rule (lib/read/orientation.ts):
 * priced in USDG wherever the pool holds it, then in ETH, otherwise in the
 * pool's own order. Changed on purpose 2026-09-28 (one-sided, the owner: a
 * falling token must read and draw as falling, on every screen): a token worth
 * less than a cent was written the other way round ("1 USDG = 7,748.46
 * MARLIN") and a pair without USDG the way that read as 1 or more, so a price
 * could flip with the market; now "1 MARLIN = 0.0001291 USDG", as New position
 * and the position pages write it. The amount is the price at the pool's tick, which must agree
 * with its square-root price, written whole from 10,000, six significant
 * digits from 1, four below. Changed on purpose 2026-09-28 (round 6
 * integration): the square-root price put "1 ETH = 2,500.09 USDG" on Markets
 * beside "2,499.91 USDG for 1 ETH" on the same pool's page and in New
 * position, which price a pool at its tick (screens/poolRange.ts poolPrice),
 * as the position pages do. One pool reads one price everywhere; the two
 * differ by less than a tick (0.01%). A usable price read longer ago
 * than PRICE_STALE_MS is stale: time on this page, plus the time a stored
 * snapshot had already held the state when it served it. A row retained after
 * a failed refresh keeps the age of the read it came from, so it is never made
 * younger by being kept.
 */
import type { Instant, Market } from '../markets'
import type { TokenDisplay } from './types'
import { priceInverted } from './orientation'
import { groupedRatioText } from './ratioSeries'
import { PRICE_STALE_MS, tickAgrees, type PriceProblem } from './screens/poolRange'

export type MarketPrice =
  | {
      state: 'usable'
      /** How much `quote` one `base` is worth, grouped, never an exponent: "84,367" in "1 cbBTC = 84,367 USDG". */
      text: string
      /** The token one of which is priced. */
      base: TokenDisplay
      /** The token it is priced in. */
      quote: TokenDisplay
      block: number
      /** Read PRICE_STALE_MS or longer ago: served age plus time on screen since the row's reply arrived. */
      stale: boolean
      /** A symbol that could not be read, or token metadata the producer marked partial. */
      partial: boolean
    }
  | {
      state: 'unavailable'
      /** `not_read`: the row carries no pool state at all. */
      problem: 'not_read' | PriceProblem
      block: number | null
    }

/**
 * Milliseconds since the pool's state was read: the time it had already been
 * stored when a snapshot served it, plus the time since the row's reply
 * arrived, on the monotonic clock when both readings have it. Null when the
 * row says nothing.
 */
function stateAgeMs(market: Market, now: Instant): number | null {
  const answer = market.provenance?.market
  if (!answer) return null
  const ms = answer.receivedMonotonic !== undefined && now.monotonic !== undefined ? now.monotonic - answer.receivedMonotonic : now.wall - answer.receivedAt
  return Math.max(0, ms) + (market.poolState?.servedAgeSeconds ?? 0) * 1000
}

/**
 * An amount as the price writes it; null past what reads as a plain number: 10^15 and more, or under 10^−15. The floor
 * was added 2026-09-28 (one-sided): the price is no longer turned round to read as 1 or more, so it mirrors the ceiling,
 * and a price written one way round before can be written the other way round now.
 */
export function plainAmount(value: number): string | null {
  if (!(value >= 1e-15 && value < 1e15)) return null
  return new Intl.NumberFormat('en-US', value >= 10_000 ? { maximumFractionDigits: 0 } : { maximumSignificantDigits: value >= 1 ? 6 : 4 }).format(value)
}

/**
 * A close of a card's line (a decimal string) written as the table writes a price, so the card and the row read the
 * same figure ("84,367"); ratioText's form where it is past a plain number.
 */
export const plainClose = (close: string) => plainAmount(Number(close)) ?? groupedRatioText(close)

/**
 * The price the plain way round (see the header), from currency0's price in currency1: which currency is the one
 * priced, 0 or 1, and how much of the other it is worth. The side follows the two currencies alone, never the price.
 */
export function plainSide(price: number, currency0: string, currency1: string): { side: 0 | 1; value: number } {
  return priceInverted(currency0, currency1) ? { side: 1, value: 1 / price } : { side: 0, value: price }
}

/** currency0's price in currency1, in display units, at `tick` (tickPriceText's value, without its rounding). */
const spot = (tick: number, decimals0: number, decimals1: number) => Math.pow(1.0001, tick) * 10 ** (decimals0 - decimals1)

/** The row's token read for one of the pool's currencies, by address. */
function tokenFor(market: Market, address: string): TokenDisplay | null {
  const key = address.toLowerCase()
  return [market.tokens.base, market.tokens.quote].find((token) => token.address.toLowerCase() === key) ?? null
}

export function marketPoolPrice(market: Market, now: Instant): MarketPrice {
  const pool = market.poolState
  if (!pool) return { state: 'unavailable', problem: 'not_read', block: null }
  const block = pool.block
  let sqrt: bigint
  try {
    sqrt = BigInt(pool.sqrtPriceX96)
  } catch {
    return { state: 'unavailable', problem: 'tick_mismatch', block }
  }
  if (sqrt === 0n) return { state: 'unavailable', problem: 'not_initialized', block }
  if (!tickAgrees(pool.tick, sqrt)) return { state: 'unavailable', problem: 'tick_mismatch', block }
  const token0 = tokenFor(market, pool.currency0)
  const token1 = tokenFor(market, pool.currency1)
  if (!token0 || !token1 || token0.decimals === null || token1.decimals === null) return { state: 'unavailable', problem: 'decimals_unknown', block }
  const { side, value } = plainSide(spot(pool.tick, token0.decimals, token1.decimals), pool.currency0, pool.currency1)
  const text = plainAmount(value)
  if (text === null) return { state: 'unavailable', problem: 'beyond_display', block }
  const [base, quote] = side === 0 ? [token0, token1] : [token1, token0]
  const partial = [base, quote].some((token) => token.symbol === null || token.readStatus === 'partial')
  const age = stateAgeMs(market, now)
  return { state: 'usable', text, base, quote, block, stale: age !== null && age >= PRICE_STALE_MS, partial }
}

/** The token a row's price is of (the "1 cbBTC" of it), lowercase; null when the row cannot price its pool. */
export function plainBase(market: Market): string | null {
  const price = marketPoolPrice(market, { wall: 0 })
  return price.state === 'usable' ? price.base.address.toLowerCase() : null
}
