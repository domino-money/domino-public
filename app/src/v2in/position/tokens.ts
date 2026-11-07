/**
 * The tokens the position page's Domino V2 parts can name on one chain, by address (copied from the S1 reference,
 * the former src/v2ui/s1/tokens.ts): native ETH, WETH and the chain's charge currencies from its profile (trusted names), then what
 * the page read (V1's chain read on Robinhood, read-v6 elsewhere; a symbol is untrusted text, already cleaned; decimals
 * null when unread, never guessed). Identity is chain + address; a symbol is only a label.
 *
 * Pure: no React, no wallet.
 */
import { v2Chain } from '../../v2/chains'
import { formatUnitsText, shortAddress, significantUnitsText } from '../../v2/plan/present'
import { ZERO_ADDRESS, type Address, type V2ChainId } from '../../v2/types'
import { usdOfRaw } from '../usd'
import { COPY } from './copy'

export interface PositionToken {
  address: Address
  symbol: string | null
  decimals: number | null
  /**
   * Added 2026-10-06 (rugged97's delta of 5 Oct, item 4: read-v6 1.1.0-rc.1's qualified USD): its USD price per whole
   * token as read-v6 gave it (18 decimals; the stable at 1, ETH and WETH at Chainlink's ETH/USD, any other token at its
   * deepest qualified pool), while the page shows USD (./constants.ts USD_SHOWN); null or absent: none.
   */
  usd?: string | null
}

export type TokenBook = ReadonlyMap<string, PositionToken>

/** A token's symbol as read: control and invisible characters dropped, at most 64; null for none. */
export function cleanSymbol(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const clean = Array.from(value).filter((ch) => {
    const c = ch.codePointAt(0) as number
    return !(c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff)
  }).join('').trim()
  return clean ? Array.from(clean).slice(0, 64).join('') : null
}

/** The chain's book: what the page read first (a later entry with decimals fills one without), then the profile's names. */
export function tokenBook(chainId: V2ChainId, extra: readonly PositionToken[] = []): TokenBook {
  const chain = v2Chain(chainId)
  const book = new Map<string, PositionToken>()
  for (const token of extra) {
    const address = token.address.toLowerCase() as Address
    const known = book.get(address)
    if (!known || (known.decimals === null && token.decimals !== null)) book.set(address, { address, symbol: cleanSymbol(token.symbol), decimals: token.decimals, usd: token.usd ?? known?.usd ?? null })
  }
  // The profile's names win; a price read for them is kept (2026-10-06).
  const priced = (address: string) => book.get(address)?.usd ?? null
  // The chain's own native currency and wrapped token (ETH and WETH; HYPE and WHYPE on a HYPE-native chain, 2026-11-06).
  book.set(ZERO_ADDRESS, { address: ZERO_ADDRESS, symbol: chain.nativeSymbol, decimals: 18, usd: priced(ZERO_ADDRESS) })
  book.set(chain.wrappedNative.address, { address: chain.wrappedNative.address, symbol: chain.wrappedNative.symbol, decimals: 18, usd: priced(chain.wrappedNative.address) })
  for (const currency of chain.chargeCurrencies) book.set(currency.address, { address: currency.address, symbol: currency.symbol, decimals: currency.decimals, usd: priced(currency.address) })
  return book
}

/**
 * Added 2026-10-06 (rugged97's delta of 5 Oct, item 4): what raw amounts of a pool's two tokens are worth at the prices
 * read-v6 gave, each term rounded down, as a decimal string; null when an amount above zero has no price or no decimals
 * (then no figure at all, never a zero), or when there are no amounts.
 */
export function usdOfAmounts(book: TokenBook, tokens: readonly [Address, Address], amounts: readonly [bigint, bigint] | null): string | null {
  if (!amounts) return null
  return usdOfRaw(tokens.map((token, index) => {
    const known = book.get(token.toLowerCase())
    return { raw: amounts[index], decimals: known?.decimals ?? null, usd: known?.usd ?? null }
  }))
}

/** A token's label: its symbol, else its short address; the native currency's is the book's (the chain's own, tokenBook). */
export function labelOf(book: TokenBook, token: Address): string {
  if (token.toLowerCase() === ZERO_ADDRESS) return book.get(ZERO_ADDRESS)?.symbol ?? 'ETH'
  return book.get(token.toLowerCase())?.symbol ?? shortAddress(token)
}

export function decimalsOf(book: TokenBook, token: Address): number | null {
  return book.get(token.toLowerCase())?.decimals ?? null
}

/**
 * "1,234.5 USDG", or "1234500 raw units of 0x1234…abcd" when the decimals are unknown (never guessed). `round` 'up' for a
 * fee or an amount to allow, never shown lower than it is (v2/plan/present.ts formatUnitsText, 2026-10-06).
 */
export function amountText(book: TokenBook, token: Address, raw: bigint, maxFraction = 6, round: 'down' | 'up' = 'down'): string {
  const decimals = decimalsOf(book, token)
  const label = labelOf(book, token)
  if (decimals === null) return `${formatUnitsText(raw, null)} ${COPY.form.rawUnits} of ${label}`
  return `${formatUnitsText(raw, decimals, maxFraction, round)} ${label}`
}

/**
 * (QA round 2, N2: one number format) "10,345.7 PRIORS": an amount at six significant digits, as New position's Review and
 * receipt write one (../journey/tokens.ts shortAmountText, v2/plan/present.ts significantUnitsText; below one, at most six
 * decimals, so dust still reads "<0.000001"), or raw units when the decimals are unknown (never guessed). `round` 'up' for
 * a fee or an amount to allow, never shown lower than it is. Every digit stays in the title (amountText at EXACT_FRACTION).
 */
export function shortAmountText(book: TokenBook, token: Address, raw: bigint, round: 'down' | 'up' = 'down'): string {
  const decimals = decimalsOf(book, token)
  const label = labelOf(book, token)
  if (decimals === null) return `${formatUnitsText(raw, null)} ${COPY.form.rawUnits} of ${label}`
  return `${significantUnitsText(raw, decimals, round)} ${label}`
}
