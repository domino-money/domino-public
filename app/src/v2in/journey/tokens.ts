import { v2Chain } from '../../v2/chains'
import { formatUnitsText, shortAddress } from '../../v2/plan/present'
import { ZERO_ADDRESS, type Address, type V2ChainId } from '../../v2/types'
import { JOURNEY } from './copy'

/**
 * The tokens New position can name on one network, by address (copied from the #/v2 screens' src/v2ui/s1/tokens.ts,
 * which this area never imports): native ETH, WETH and the chain's charge currencies from its profile (trusted), then
 * what a list or a token's own `decimals()`/`symbol()` said (its symbol untrusted text, already cleaned; its decimals
 * null when unread, never guessed). Identity is chain + address; a symbol is only a label.
 */
export interface JourneyToken {
  address: Address
  symbol: string | null
  decimals: number | null
}

export type TokenBook = ReadonlyMap<string, JourneyToken>

export function tokenBook(chainId: V2ChainId, extra: readonly JourneyToken[] = []): TokenBook {
  const chain = v2Chain(chainId)
  const book = new Map<string, JourneyToken>()
  for (const token of extra) {
    const known = book.get(token.address)
    // A later entry with decimals fills an earlier one without; the profile's names win below.
    if (!known || (known.decimals === null && token.decimals !== null)) book.set(token.address, token)
  }
  book.set(ZERO_ADDRESS, { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 })
  book.set(chain.wrappedNative.address, { address: chain.wrappedNative.address, symbol: 'WETH', decimals: 18 })
  for (const currency of chain.chargeCurrencies) book.set(currency.address, { address: currency.address, symbol: currency.symbol, decimals: currency.decimals })
  return book
}

/** The tokens the profile names on a chain (ETH, WETH, then its other charge currencies), each once: the pool finder's list. */
export function profileTokens(chainId: V2ChainId): JourneyToken[] {
  const chain = v2Chain(chainId)
  const out: JourneyToken[] = [
    { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18 },
    { address: chain.wrappedNative.address, symbol: 'WETH', decimals: 18 },
  ]
  for (const currency of chain.chargeCurrencies) {
    if (out.some((token) => token.address === currency.address)) continue
    out.push({ address: currency.address, symbol: currency.symbol, decimals: currency.decimals })
  }
  return out
}

/** A token's label: its symbol, else its short address. */
export function labelOf(book: TokenBook, token: Address): string {
  if (token.toLowerCase() === ZERO_ADDRESS) return 'ETH'
  return book.get(token.toLowerCase())?.symbol ?? shortAddress(token)
}

export function decimalsOf(book: TokenBook, token: Address): number | null {
  return book.get(token.toLowerCase())?.decimals ?? null
}

/** A token's own symbol() as read: control and invisible characters dropped, at most 64; null for none (untrusted text). */
export function cleanSymbol(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const clean = Array.from(value).filter((ch) => {
    const c = ch.codePointAt(0) as number
    return !(c <= 0x1f || (c >= 0x7f && c <= 0x9f) || (c >= 0x200b && c <= 0x200f) || (c >= 0x2028 && c <= 0x202e) || (c >= 0x2060 && c <= 0x2069) || c === 0xfeff)
  }).join('').trim()
  return clean ? Array.from(clean).slice(0, 64).join('') : null
}

/**
 * "1,234.5 USDG", or "1,234,500 raw units of 0x1234…abcd" when the decimals are unknown (never guessed). `round` 'up' for
 * a fee or an amount to allow, never shown lower than it is (v2/plan/present.ts formatUnitsText, 2026-10-06).
 */
export function amountText(book: TokenBook, token: Address, raw: bigint, maxFraction = 6, round: 'down' | 'up' = 'down'): string {
  const decimals = decimalsOf(book, token)
  const label = labelOf(book, token)
  if (decimals === null) return `${formatUnitsText(raw, null)} ${JOURNEY.amount.rawUnits} of ${label}`
  return `${formatUnitsText(raw, decimals, maxFraction, round)} ${label}`
}

/** The figure alone ("1,234.5"), raw digits when the decimals are unknown. */
export function figureText(book: TokenBook, token: Address, raw: bigint, maxFraction = 6): string {
  return formatUnitsText(raw, decimalsOf(book, token), maxFraction)
}
