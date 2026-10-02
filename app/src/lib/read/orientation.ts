/**
 * Which way round the app writes a pool's price: one rule for every screen, so a token's price reads the same on
 * Markets, a pool's page, New position and a position's page, and a chart of it falls when the token falls.
 *
 * Added 2026-09-28 (one-sided, the owner: "UFG's price is falling, but the range on my UFG position is rising. It must
 * be the opposite"). Before it, New position and a position's page wrote every pool in its own order (currency1 per
 * currency0), so a pool whose first currency is USDG read "1 USDG = 392 MANY": MANY cheaper was a higher figure, a
 * range "above today" held MANY's lower prices, and MANY's falling price drew a rising line.
 *
 * The rule: always "1 BASE = X QUOTE", the quote being the token a person counts value in.
 *  1. USDG, the app's dollar (config/mainTokens.ts). Another USD stablecoin, when the chain has one Domino lists, is
 *     added to QUOTE_RANK beside it, by its address: a symbol is untrusted text and never decides.
 *  2. Native ETH or WETH.
 *  3. Otherwise (two tokens of the same rank: two ordinary tokens, or ETH and WETH), the pool's own order: its first
 *     currency priced in its second, as Uniswap writes it. The pool's order never changes, so a pool never flips from
 *     one reading to the other when its price crosses 1, and a chart of it keeps one direction.
 *
 * The chain is never read the other way round: ticks, square-root prices, amounts and every contract call stay in the
 * pool's own order. Only what is written and drawn follows this rule.
 */
import { NATIVE_ETH, USDG, WETH } from '../../config/mainTokens'

/** How strongly a token is the one a price is counted in: the dollar first, then ether, then any other token. */
const QUOTE_RANK: ReadonlyMap<string, number> = new Map([
  [USDG, 2],
  [NATIVE_ETH, 1],
  [WETH, 1],
])

/** A token's rank as a quote (2 for USDG, 1 for ETH and WETH, 0 for any other), by its address in any case. */
export const quoteRank = (address: string): number => QUOTE_RANK.get(address.toLowerCase()) ?? 0

/**
 * Whether the app writes this pool's price the other way round from the pool: its second currency priced in its first
 * (the first is the quote, "1 MANY = 0.0025 USDG" in a USDG/MANY pool). False in the pool's own order.
 */
export const priceInverted = (currency0: string, currency1: string): boolean => quoteRank(currency0) > quoteRank(currency1)

/** The index, in the pool's order, of the token a price is written for: 0 in the pool's own order, 1 when inverted. */
export const baseIndex = (currency0: string, currency1: string): 0 | 1 => (priceInverted(currency0, currency1) ? 1 : 0)

/** The index, in the pool's order, of the token a price is written in. */
export const quoteIndex = (currency0: string, currency1: string): 0 | 1 => (priceInverted(currency0, currency1) ? 0 : 1)

/**
 * A pair's two sides in the order its price is written, "TOKEN/USDG" beside "1 TOKEN = X USDG" (audit E21, 2026-10-01):
 * one name for a pool on every screen, the ticker, the tables, the cards and its page, whatever the pool's own order.
 * `first` and `second` are in the pool's order.
 */
export function pricePair<T extends { address: string }>(first: T, second: T): { base: T; quote: T } {
  return priceInverted(first.address, second.address) ? { base: second, quote: first } : { base: first, quote: second }
}
