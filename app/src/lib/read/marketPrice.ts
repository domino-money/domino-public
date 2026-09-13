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
 * Orientation is the pool's: currency1 per currency0, written by
 * tickPriceText with its `≈` and six significant digits ("≈2,492.36" USDG
 * per WETH). A usable price read longer ago than PRICE_STALE_MS on this page
 * is stale; a row retained after a failed refresh keeps the age of the read
 * it came from, so it is never made younger by being kept.
 */
import type { Instant, Market } from '../markets'
import type { TokenDisplay } from './types'
import { PRICE_STALE_MS, tickAgrees, type PriceProblem } from './screens/poolRange'
import { tickPriceText } from './screens/positions'

export type MarketPrice =
  | {
      state: 'usable'
      /** currency1 per currency0, from tickPriceText: "≈" and six significant digits, never an exponent. */
      text: string
      /** The pool's currency0: the unit the price is per. */
      base: TokenDisplay
      /** The pool's currency1: the unit the price is in. */
      quote: TokenDisplay
      block: number
      /** On screen for PRICE_STALE_MS or longer since the row's reply arrived. */
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

/** Milliseconds since the row's reply arrived, on the monotonic clock when both readings have it; null when the row says nothing. */
function onScreenMs(market: Market, now: Instant): number | null {
  const answer = market.provenance?.market
  if (!answer) return null
  const ms = answer.receivedMonotonic !== undefined && now.monotonic !== undefined ? now.monotonic - answer.receivedMonotonic : now.wall - answer.receivedAt
  return Math.max(0, ms)
}

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
  const base = tokenFor(market, pool.currency0)
  const quote = tokenFor(market, pool.currency1)
  if (!base || !quote || base.decimals === null || quote.decimals === null) return { state: 'unavailable', problem: 'decimals_unknown', block }
  const text = tickPriceText(pool.tick, base.decimals, quote.decimals)
  if (text === null) return { state: 'unavailable', problem: 'beyond_display', block }
  const partial = [base, quote].some((token) => token.symbol === null || token.readStatus === 'partial')
  const age = onScreenMs(market, now)
  return { state: 'usable', text, base, quote, block, stale: age !== null && age >= PRICE_STALE_MS, partial }
}
