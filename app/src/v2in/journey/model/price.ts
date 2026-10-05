import { tickAgrees, tickPriceIn, type PoolPrice } from '../../../lib/read/screens/poolRange'
import type { TokenDisplay } from '../../../lib/read/types'
import { profileRank, v2Chain } from '../../../v2/chains'
import type { Address, V2ChainId } from '../../../v2/types'
import { JOURNEY_PRICE_STALE_MS } from '../constants'
import type { JourneyToken } from '../tokens'
import type { JourneyPool } from './pools'

/**
 * A V2 pool's price as New position writes it, on any of the three networks, in the very shape the journey's range
 * helpers take (lib/read/screens/poolRange.ts: presets, bounds, steps, typed prices, the page's frame), so the range step
 * looks and behaves as the Robinhood one does.
 *
 * Which way round (lib/read/orientation.ts's rule, made per chain): "1 BASE = X QUOTE", the quote being the token value
 * is counted in: the chain's stable first (its rank-1 charge currency: USDG on Robinhood Chain, USDC on Base and
 * Arbitrum One, from the chain profile, by address), then ETH or WETH, else the pool's own order. The chain itself is
 * never read the other way round: ticks, sqrt prices and every call stay in the pool's order.
 *
 * Pure: nothing is read here, nothing invented (an unknown decimals count leaves the price unavailable, never guessed).
 */
export type JourneyPrice = Extract<PoolPrice, { state: 'usable' }>
export type JourneyPriceState = JourneyPrice | Extract<PoolPrice, { state: 'unavailable' }>

/** How strongly a token is the one a price is counted in on a chain: 2 its stable, 1 ETH and WETH, 0 any other. */
export function quoteRankOn(chainId: V2ChainId, address: string): number {
  const rank = profileRank(v2Chain(chainId), address)
  return rank === 1 ? 2 : rank === 2 ? 1 : 0
}

/** Whether the page writes this pool's price the other way round from the pool (its first currency is the quote). */
export const priceInvertedOn = (chainId: V2ChainId, currency0: string, currency1: string): boolean => quoteRankOn(chainId, currency0) > quoteRankOn(chainId, currency1)

/**
 * A V2 token in the read layer's display shape, for the range helpers and SymbolText only (they read its symbol and
 * nothing of its chain). Never handed to TokenMark, whose artwork lookup is Robinhood Chain's: the journey draws V2
 * tokens with its own mark (../parts.tsx TokenDisc).
 */
export function displayToken(token: JourneyToken): TokenDisplay {
  return {
    origin: 'read',
    chainId: 4663,
    address: token.address.toLowerCase(),
    symbol: token.symbol,
    decimals: token.decimals,
    readStatus: token.decimals === null ? 'partial' : 'available',
    artwork: null,
  }
}

/**
 * The price at a sqrt price and its tick, for a pool on a chain: usable when the tick agrees with the sqrt price, both
 * decimals are known and the price can be written; else unavailable with its reason. `readAt` (page clock, ms) marks it
 * stale past five minutes, as the range step judges the Robinhood pools' prices.
 */
export function priceAt(args: {
  chainId: V2ChainId
  currency0: Address
  currency1: Address
  tokens: readonly [JourneyToken, JourneyToken]
  sqrtPriceX96: bigint
  tick: number
  tickSpacing: number
  block: bigint
  readAt: number | null
  now: number
}): JourneyPriceState {
  const block = Number(args.block)
  if (args.sqrtPriceX96 === 0n) return { state: 'unavailable', problem: 'not_initialized', block }
  if (!tickAgrees(args.tick, args.sqrtPriceX96)) return { state: 'unavailable', problem: 'tick_mismatch', block }
  const [t0, t1] = args.tokens
  if (t0.decimals === null || t1.decimals === null) return { state: 'unavailable', problem: 'decimals_unknown', block }
  const inverted = priceInvertedOn(args.chainId, args.currency0, args.currency1)
  const text = tickPriceIn(args.tick, [t0.decimals, t1.decimals], inverted)
  if (text === null) return { state: 'unavailable', problem: 'beyond_display', block }
  const [base, quote] = inverted ? [t1, t0] : [t0, t1]
  return {
    state: 'usable',
    block,
    tick: args.tick,
    tickSpacing: args.tickSpacing,
    text,
    base: displayToken(base),
    quote: displayToken(quote),
    inverted,
    decimals: [t0.decimals, t1.decimals],
    partial: t0.symbol === null || t1.symbol === null,
    stale: args.readAt !== null && args.now - args.readAt >= JOURNEY_PRICE_STALE_MS,
  }
}

/** A chosen pool's own price (its read sqrt price and tick). */
export function poolPrice(pool: JourneyPool, now: number): JourneyPriceState {
  return priceAt({ chainId: pool.chainId, currency0: pool.pool.currency0, currency1: pool.pool.currency1, tokens: pool.tokens, sqrtPriceX96: pool.sqrtPriceX96, tick: pool.tick, tickSpacing: pool.pool.tickSpacing, block: pool.block, readAt: pool.readAt, now })
}
