/**
 * The site's main tokens, frozen: native ETH, WETH and USDG, each bound to its
 * one address on Robinhood Chain (chain 4663).
 *
 * Added 2026-09-26 (featured pools v1 §11.4, handoff §3.1). Anything that
 * decides what "USDG" or "WETH" is (the wallet card's look-alike rule, its
 * price shortcuts, the USD valuation of a USDG pair, the wallet lists'
 * fallback tokens) takes the address from here, never from a list that can
 * change: a daily featured list is data from a service, and a token on it
 * calling itself "USDG" must never re-point the real one. Nothing here is
 * built from another list, and nothing can add to it at run time.
 */
import type { ArtworkKey } from '../lib/read/types'
import { symbolReading } from '../lib/symbolReading'

/** Native ETH: the zero address, as a Uniswap v4 pool key names it. */
export const NATIVE_ETH = '0x0000000000000000000000000000000000000000'
/** Wrapped ether on Robinhood Chain. */
export const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
/** USDG, the dollar every selected pool trades against; $1 by definition across the app (DESIGN-V2 §22.8). */
export const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168'

export interface MainToken {
  /** Lowercase. */
  readonly address: string
  readonly symbol: 'ETH' | 'WETH' | 'USDG'
  readonly artwork: ArtworkKey
}

export const MAIN_TOKENS: readonly MainToken[] = Object.freeze([
  Object.freeze({ address: NATIVE_ETH, symbol: 'ETH', artwork: 'ETH' } as const),
  Object.freeze({ address: WETH, symbol: 'WETH', artwork: 'WETH' } as const),
  Object.freeze({ address: USDG, symbol: 'USDG', artwork: 'USDG' } as const),
])

/** The main token at `address` (any case), or null. */
export function mainTokenAt(address: string): MainToken | null {
  const key = address.toLowerCase()
  return MAIN_TOKENS.find((token) => token.address === key) ?? null
}

const BY_READING: ReadonlyMap<string, string> = new Map(MAIN_TOKENS.map((token) => [symbolReading(token.symbol), token.address]))

/**
 * Whether `symbol` reads as a main token's (symbolReading) while `address` is
 * not that token's: a look-alike. Native ETH and WETH both read as ether, so
 * either address is the real one for either symbol.
 */
export function readsAsMainToken(symbol: string, address: string): boolean {
  const owner = BY_READING.get(symbolReading(symbol))
  if (owner === undefined) return false
  const key = address.toLowerCase()
  if (owner === NATIVE_ETH || owner === WETH) return key !== NATIVE_ETH && key !== WETH
  return key !== owner
}
