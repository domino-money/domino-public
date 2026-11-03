import { amountText } from '../../components/positions/walletSteps'
import { edgePrice } from '../autoexit/form'
import { MAX_TICK, MIN_TICK, sqrtPriceAtTick } from '../../lib/read/screens/poolRange'
import { readFigure, type Decimal } from '../../lib/create/typedFigure'
import type { V2Chain } from '../../v2/chains'
import { safeText } from '../../v2/errors'
import { orientationOf, type PriceOrientation } from '../../v2/trigger'
import { ZERO_ADDRESS, type Address } from '../../v2/types'

/**
 * How the automation screens name a token and write an amount or a price (spec F7 §1.7 "Tokens", §5.5, §6.3). Pure.
 *
 * A token's identity is its chain and address. Its name and decimals come from the chain's own profile when it is one
 * of the chain's charge currencies or its wrapped native token (api-contracts/v2/chains, read at build time), else from
 * the V2 read API's metadata, whose symbol is untrusted text: control and bidirectional characters stripped, bounded,
 * and never more than text. With neither, the short address names it and its decimals stay unknown: an amount is then
 * written in raw units, never guessed.
 *
 * Domino V2 integration (2026-10-02): the logic of src/v2ui/vault/tokens.ts, copied for the integrated screens. A V1
 * position's tokens (lib/walletPositions.ts WalletToken: what the chain said, symbol untrusted) are named through
 * `tokenView` with their own metadata (`walletTokenMeta`).
 */

/** What the read API says of a token (read-v6 `tokens`): its symbol is untrusted text, its decimals null when unread. */
export interface TokenMeta {
  address: Address
  symbol: string | null
  decimals: number | null
}

export interface TokenView {
  address: Address
  /** What the screen calls it: a symbol (the profile's, or the API's as untrusted text), or the short address. */
  label: string
  decimals: number | null
  /** The label comes from the chain profile (the app's own data), not from a token contract or an API. */
  known: boolean
}

export const shortAddress = (address: string): string => `${address.slice(0, 6)}…${address.slice(-4)}`

/** A token on a chain, named as above. */
export function tokenView(chain: V2Chain, address: Address, meta?: TokenMeta | null): TokenView {
  const token = address.toLowerCase() as Address
  if (token === ZERO_ADDRESS) return Object.freeze({ address: token, label: chain.nativeSymbol, decimals: 18, known: true })
  const charge = chain.chargeCurrencies.find((c) => c.address === token)
  if (charge) return Object.freeze({ address: token, label: charge.symbol, decimals: charge.decimals, known: true })
  if (chain.wrappedNative.address === token) return Object.freeze({ address: token, label: chain.wrappedNative.symbol, decimals: chain.wrappedNative.decimals, known: true })
  const symbol = meta && meta.address === token ? safeText(meta.symbol, 24) : null
  const decimals = meta && meta.address === token ? meta.decimals : null
  return Object.freeze({ address: token, label: symbol ?? shortAddress(token), decimals, known: false })
}

/**
 * A V1 position's tokens as metadata for `tokenView` (lib/walletPositions.ts WalletToken: the address the chain gave,
 * lowercase, its symbol as untrusted text and its decimals, null when unread). The zero address is native ETH.
 */
export function walletTokenMeta(tokens: readonly { address: string; symbol: string | null; decimals: number | null }[]): (address: Address) => TokenMeta | null {
  return (address) => {
    const wanted = address.toLowerCase()
    const token = tokens.find((t) => t.address.toLowerCase() === wanted)
    return token ? { address: wanted as Address, symbol: token.symbol, decimals: token.decimals } : null
  }
}

/** The pair of a pool's tokens, in pool order, with the read API's metadata for each when it has any. */
export function poolTokens(chain: V2Chain, pool: { currency0: Address; currency1: Address }, meta?: (address: Address) => TokenMeta | null): readonly [TokenView, TokenView] {
  return [tokenView(chain, pool.currency0, meta?.(pool.currency0)), tokenView(chain, pool.currency1, meta?.(pool.currency1))] as const
}

/**
 * An amount of a token: "1.5 USDG" (six significant digits, cut, never rounded up; components/positions/walletSteps.ts),
 * or "1500000 raw units of 0x12…34" when its decimals are unknown. `exact` has every digit.
 */
export function amountWords(raw: bigint, token: TokenView): { text: string; exact: string; raw: boolean } {
  const shown = token.decimals === null ? null : amountText(raw, token.decimals)
  if (!shown) return { text: `${raw.toString()} raw units of ${token.label}`, exact: `${raw.toString()} raw units of ${token.address}`, raw: true }
  return { text: `${shown.text} ${token.label}`, exact: `${shown.exact} ${token.label}`, raw: false }
}

/**
 * An amount the person typed in a token's units, as raw units; null when it cannot be read or has too many decimals.
 * Changed on purpose 2026-11-02 (review of the money PRs, M4): read by the rule every typed figure for a transaction is
 * read by (lib/create/typedFigure.ts): a page-style "1,250.5" loses its separators, "1,5" is 1.5 where the person's
 * language writes a decimal comma, and an ambiguous "1,250" is refused. It refused every comma. `decimal`: for a test.
 */
export function rawFromText(text: string, decimals: number, decimal?: Decimal): bigint | null {
  const read = readFigure(text, decimal)
  if (!read.ok) return null
  const match = /^(0|[1-9]\d{0,59})(?:\.(\d+))?$/.exec(read.text)
  if (!match) return null
  const [, integer, fraction = ''] = match
  if (fraction.length > decimals) return null
  return BigInt(integer + fraction.padEnd(decimals, '0'))
}

/** A whole number typed as text (a position number, a raw amount), as a bigint; null when it is not one. */
export function wholeFromText(text: string, maxDigits = 78): bigint | null {
  const t = text.trim()
  return t.length <= maxDigits && /^(?:0|[1-9][0-9]*)$/.test(t) ? BigInt(t) : null
}

/** A raw amount as the exact text a person could type back (every decimal), for an input's starting value. */
export function textFromRaw(raw: bigint, decimals: number): string {
  if (decimals === 0) return raw.toString()
  const digits = raw.toString().padStart(decimals + 1, '0')
  const integer = digits.slice(0, digits.length - decimals)
  const fraction = digits.slice(digits.length - decimals).replace(/0+$/, '')
  return fraction ? `${integer}.${fraction}` : integer
}

/**
 * The orientation a vault's prices are shown in (spec §5.2 "Modo Domino", §5.5): the reference currency
 * (`quoteCurrency()`) per unit of the pool's other token. "token1PerToken0" when the reference is currency1.
 */
export function referenceOrientation(pool: { currency0: Address; currency1: Address }, quoteCurrency: Address): PriceOrientation | null {
  const quote = quoteCurrency.toLowerCase()
  if (quote === pool.currency1) return orientationOf(pool, pool.currency0)
  if (quote === pool.currency0) return orientationOf(pool, pool.currency1)
  return null
}

/**
 * A tick's price in an orientation, as the screens write a price (autoexit/form.ts edgePrice). Changed on purpose
 * 2026-10-30 (QA round 2, N2): src/v2/plan/present.ts priceText's rule ("2,998.90", "3.40"), where it was six
 * significant digits ("2,998.9") beside V2 Review's and the position page's two decimals.
 */
const priceAtTick = (tick: number, tokens: readonly [TokenView, TokenView], orientation: PriceOrientation): string | null =>
  edgePrice(sqrtPriceAtTick(tick), { decimals0: tokens[0].decimals, decimals1: tokens[1].decimals }, orientation)

/**
 * A position's range in the vault's reference orientation (spec §5.5): "1 ETH = 2,000.00 to 3,500.00 USDG", lowest price
 * first. Null when a token's decimals are unknown (never guessed), the orientation is not one of the pool's two tokens,
 * or a tick is outside Uniswap's bounds.
 */
export function rangeWords(tickLower: number, tickUpper: number, tokens: readonly [TokenView, TokenView], orientation: PriceOrientation | null): string | null {
  if (orientation === null || tokens[0].decimals === null || tokens[1].decimals === null) return null
  if (!Number.isInteger(tickLower) || !Number.isInteger(tickUpper) || tickLower < MIN_TICK || tickUpper > MAX_TICK || tickLower >= tickUpper) return null
  const a = priceAtTick(tickLower, tokens, orientation)
  const b = priceAtTick(tickUpper, tokens, orientation)
  // Token1 per token0 rises with the tick; the inverse falls. Lowest first either way.
  if (a === null || b === null) return null
  const [low, high] = orientation === 'token1PerToken0' ? [a, b] : [b, a]
  const [base, quote] = orientation === 'token1PerToken0' ? [tokens[0], tokens[1]] : [tokens[1], tokens[0]]
  return `1 ${base.label} = ${low} to ${high} ${quote.label}`
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** Unix seconds as "2 November 2026, 14:05 UTC": a fixed time zone, so the same order reads the same everywhere. */
export function dateWords(seconds: bigint | number): string {
  const ms = Number(seconds) * 1000
  if (!Number.isFinite(ms) || ms < 0 || ms > 8.64e15) return `${String(seconds)} (Unix time)`
  const d = new Date(ms)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`
}
