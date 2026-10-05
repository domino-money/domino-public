/**
 * Amounts, tokens and chains in words for the S2 screens (spec F7 §1.7, §3.3, §3.5). Exact: raw integer strings are
 * formatted with BigInt-free string arithmetic, every digit kept, trailing zeros dropped; nothing becomes a JS number.
 * Unknown decimals are never guessed: the raw integer is shown and said to be raw. Symbols are untrusted text: control
 * and format characters (bidi overrides, zero-width marks) are dropped and the rest is cut at 24 characters; a token
 * without a readable symbol is named by its short address. No USD anywhere.
 */
import { V2_CHAINS } from '../chains'
import type { ChainNames, OriginsList, TokenBook, TokenInfo } from './types'

const RAW = /^(0|[1-9]\d*)$/
const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const ZERO = '0x0000000000000000000000000000000000000000'
const MAX_SYMBOL = 24

const group = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/** Valid decimals are a uint8, as ERC-20 `decimals()` returns. */
export const knownDecimals = (decimals: number | null | undefined): decimals is number =>
  typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 && decimals <= 255

/**
 * `raw / 10^decimals`, exactly: `("350000", 6)` → `"0.35"`, `("99571446", 6)` → `"99.571446"`,
 * `("1234500000", 6)` → `"1,234.5"`. Null when `raw` is not a canonical integer string or the decimals are not valid.
 */
export function formatUnitsExact(raw: string, decimals: number): string | null {
  if (!RAW.test(raw) || !knownDecimals(decimals)) return null
  const padded = raw.padStart(decimals + 1, '0')
  const whole = padded.slice(0, padded.length - decimals)
  const fraction = padded.slice(padded.length - decimals).replace(/0+$/, '')
  return fraction ? `${group(whole)}.${fraction}` : group(whole)
}

/** `0xaf88…5831`. */
export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

/** A token's symbol as text that is safe to show, or null when nothing readable is left. */
export function cleanSymbol(symbol: string | null | undefined): string | null {
  if (typeof symbol !== 'string') return null
  const plain = symbol.replace(/[\p{Cc}\p{Cf}]/gu, '').trim()
  if (!plain) return null
  const chars = [...plain]
  return chars.length > MAX_SYMBOL ? `${chars.slice(0, MAX_SYMBOL).join('')}…` : plain
}

/** What a token is called on screen: its cleaned symbol, else its short address. */
export const tokenLabel = (address: string, symbol: string | null | undefined): string => cleanSymbol(symbol) ?? shortAddress(address)

/**
 * An amount with its token: `"0.35 USDC"`; with unknown decimals `"350000 raw units of USDC"`. Never a guess.
 */
export function amountText(raw: string, address: string, info: TokenInfo | null): string {
  const label = tokenLabel(address, info?.symbol)
  const decimals = info?.decimals
  const units = knownDecimals(decimals) ? formatUnitsExact(raw, decimals) : null
  return units === null ? `${RAW.test(raw) ? raw : '?'} raw units of ${label}` : `${units} ${label}`
}

/**
 * The tokens this page can name: the V2 chain profiles' ETH, WETH and charge currencies (trusted, from the build),
 * then an origins listing's tokens (symbols untrusted, decimals possibly null). Keys are `chainId:lowercase address`.
 */
export function createTokenBook(origins?: OriginsList | null): TokenBook {
  const known = new Map<string, TokenInfo>()
  const key = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`
  for (const chain of V2_CHAINS) {
    known.set(key(chain.chainId, ZERO), { symbol: chain.nativeSymbol, decimals: 18 })
    known.set(key(chain.chainId, chain.wrappedNative.address), { symbol: chain.wrappedNative.symbol, decimals: chain.wrappedNative.decimals })
    for (const c of chain.chargeCurrencies) if (!c.native) known.set(key(chain.chainId, c.address), { symbol: c.symbol, decimals: c.decimals })
  }
  for (const chain of origins?.chains ?? []) {
    for (const token of chain.tokens) {
      const k = key(chain.chainId, token.address)
      if (!known.has(k)) known.set(k, { symbol: token.symbol, decimals: knownDecimals(token.decimals) ? token.decimals : null })
    }
  }
  return (chainId, address) => (ADDRESS.test(address) ? (known.get(key(chainId, address)) ?? null) : null)
}

/**
 * Chain names as S2 says them. A destination is one of V2's chains, named as its profile writes it ("Robinhood
 * Chain", "Base", "Arbitrum One"). An origin is named as the origins listing names it, which the runtime checked
 * against the package's pinned table ("Arbitrum", "Optimism"…), so the spec's "charged by Relay on Arbitrum" reads
 * as written; without a listing, a V2 chain's profile name, else null.
 */
export function createChainNames(origins?: OriginsList | null): { origin: ChainNames; destination: ChainNames } {
  const listed = new Map<number, string>()
  for (const chain of origins?.chains ?? []) listed.set(chain.chainId, chain.name)
  const v2 = (chainId: number) => V2_CHAINS.find((c) => c.chainId === chainId)?.name ?? null
  return { origin: (chainId) => listed.get(chainId) ?? v2(chainId), destination: v2 }
}

/** A chain the page cannot name. */
export const unnamedChain = (chainId: number) => `network ${chainId}`

/** "1 s", "45 s", "2 min", "1 h 5 min"; whole seconds, rounded up to the minute past one minute. */
export function durationText(seconds: number): string {
  if (!Number.isSafeInteger(seconds) || seconds < 0) return ''
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}
