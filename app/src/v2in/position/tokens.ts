/**
 * The tokens the position page's Domino V2 parts can name on one chain, by address (copied from the S1 reference,
 * the former src/v2ui/s1/tokens.ts): native ETH, WETH and the chain's charge currencies from its profile (trusted names), then what
 * the page read (V1's chain read on Robinhood, read-v6 elsewhere; a symbol is untrusted text, already cleaned; decimals
 * null when unread, never guessed). Identity is chain + address; a symbol is only a label.
 *
 * Pure: no React, no wallet.
 */
import { v2Chain } from '../../v2/chains'
import { formatUnitsText, shortAddress } from '../../v2/plan/present'
import { ZERO_ADDRESS, type Address, type V2ChainId } from '../../v2/types'
import { COPY } from './copy'

export interface PositionToken {
  address: Address
  symbol: string | null
  decimals: number | null
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
    if (!known || (known.decimals === null && token.decimals !== null)) book.set(address, { address, symbol: cleanSymbol(token.symbol), decimals: token.decimals })
  }
  book.set(ZERO_ADDRESS, { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 })
  book.set(chain.wrappedNative.address, { address: chain.wrappedNative.address, symbol: 'WETH', decimals: 18 })
  for (const currency of chain.chargeCurrencies) book.set(currency.address, { address: currency.address, symbol: currency.symbol, decimals: currency.decimals })
  return book
}

/** A token's label: its symbol, else its short address. */
export function labelOf(book: TokenBook, token: Address): string {
  if (token.toLowerCase() === ZERO_ADDRESS) return 'ETH'
  return book.get(token.toLowerCase())?.symbol ?? shortAddress(token)
}

export function decimalsOf(book: TokenBook, token: Address): number | null {
  return book.get(token.toLowerCase())?.decimals ?? null
}

/** "1,234.5 USDG", or "1234500 raw units of 0x1234…abcd" when the decimals are unknown (never guessed). */
export function amountText(book: TokenBook, token: Address, raw: bigint, maxFraction = 6): string {
  const decimals = decimalsOf(book, token)
  const label = labelOf(book, token)
  if (decimals === null) return `${formatUnitsText(raw, null)} ${COPY.form.rawUnits} of ${label}`
  return `${formatUnitsText(raw, decimals, maxFraction)} ${label}`
}
