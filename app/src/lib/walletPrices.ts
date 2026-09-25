/**
 * USD prices for the Positions Wallet card (owner, 2026-09-25): "only the main
 * tokens, a few at most", each by its USD value, "if that doesn't cause too
 * much load". One provider GET per page view at most; nothing else asked.
 *
 * - USDG, the one token every selected pool holds, is $1 by definition, as
 *   everywhere else in the app (DESIGN-V2 §22.8). It is never asked for.
 * - Native ETH is valued at WETH's price, and WETH is always in the batch.
 * - Any other token's price comes from the provider's (DEX Screener) pair
 *   for that token with the most reported liquidity, and only when that
 *   liquidity is at least MIN_LIQUIDITY_USD. A pool holding a few dollars
 *   quotes whatever price its creator likes, which is how an airdropped
 *   look-alike would otherwise show a fortune. Where the token is the pair's
 *   BASE, the price is the pair's `priceUsd`; where it is the QUOTE (a
 *   stablecoin most pairs are quoted in), it is `priceUsd / priceNative`, the
 *   quote's own dollar price the provider derived the base's from
 *   (2026-09-25). A price the provider writes any other way than a plain
 *   positive decimal is none.
 * - One GET names up to 30 addresses (tokenArtwork.tokenPrices), with the
 *   artwork's bounded deadline. Its answers, a "no qualified price" included,
 *   are kept in memory for PRICE_TTL_MS, for this visit only: never in the
 *   browser's storage. A GET that failed is not kept: the card shows amounts
 *   for that view, and the next view asks again.
 * - The same reply names each token's artwork, which is handed to the
 *   artwork resolver, so the card's rows ask no token-pairs GET of their own.
 *
 * These prices are indicative, shown in that card only: never an amount, a
 * quote, a position figure, or anything sent anywhere.
 */
import { SELECTED_POOLS_COMMON_TOKEN } from '../config/selectedPoolCatalogue'
import { parseScaled, scaledText } from './format/decimal'
import { PRICE_BATCH, artworkFromPairs, tokenArtwork } from './tokenArtwork'

export const NATIVE = '0x0000000000000000000000000000000000000000'
export const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73'
export const USDG = SELECTED_POOLS_COMMON_TOKEN
/** The least liquidity (USD) a provider pair needs for its price to count. */
export const MIN_LIQUIDITY_USD = 10_000
/** How long an answered price is reused in this visit. */
export const PRICE_TTL_MS = 300_000

const ADDRESS = /^0x[0-9a-f]{40}$/

export interface TokenQuote {
  /** USD per whole token, a plain decimal string ("1" for USDG). */
  usd: string
  /** The liquidity the provider reports for the pair the price is from, in USD; null for USDG's fixed $1. */
  liquidityUsd: number | null
}

export const USDG_QUOTE: TokenQuote = { usd: '1', liquidityUsd: null }

interface PairShape {
  chainId?: unknown
  baseToken?: { address?: unknown } | null
  quoteToken?: { address?: unknown } | null
  priceUsd?: unknown
  priceNative?: unknown
  liquidity?: { usd?: unknown } | null
}

/** The pairs of a provider body, or none: anything but a bounded array is no answer about any token. */
function pairsOf(body: unknown): PairShape[] {
  return Array.isArray(body) && body.length <= 300 ? body.filter((pair): pair is PairShape => typeof pair === 'object' && pair !== null) : []
}

/** Whether a pair is on Robinhood Chain with `address` (lowercase) as its base token. */
const baseOf = (pair: PairShape, address: string) => pair.chainId === 'robinhood' && typeof pair.baseToken?.address === 'string' && pair.baseToken.address.toLowerCase() === address
/** Whether a pair is on Robinhood Chain with `address` (lowercase) as its quote token. */
const quoteOf = (pair: PairShape, address: string) => pair.chainId === 'robinhood' && typeof pair.quoteToken?.address === 'string' && pair.quoteToken.address.toLowerCase() === address

/** Digits kept for a price worked out by division (a quote token's): 10^-18 of a dollar. */
const DERIVED_SCALE = 18

/** A provider price field as a plain positive decimal, or null for anything else (an exponent, a sign, a zero, junk). */
function plainPositive(value: unknown): { text: string; units: bigint; scale: number } | null {
  const text = typeof value === 'string' && value.length <= 48 ? value.trim() : ''
  const parsed = /^\d+(\.\d+)?$/.test(text) ? parseScaled(text) : null
  return parsed && parsed.units > 0n ? { text, ...parsed } : null
}

/** A pair's dollar price for `address` as its base (`priceUsd`) or its quote (`priceUsd / priceNative`, rounded down); null when neither is plain. */
function pairPrice(pair: PairShape, address: string): string | null {
  if (baseOf(pair, address)) return plainPositive(pair.priceUsd)?.text ?? null
  if (!quoteOf(pair, address)) return null
  const usd = plainPositive(pair.priceUsd)
  const native = plainPositive(pair.priceNative)
  if (!usd || !native) return null
  // (usd.units / 10^usd.scale) / (native.units / 10^native.scale), to DERIVED_SCALE digits.
  const units = (usd.units * 10n ** BigInt(native.scale + DERIVED_SCALE)) / (native.units * 10n ** BigInt(usd.scale))
  if (units <= 0n) return null
  return scaledText(units, DERIVED_SCALE).replace(/\.?0+$/, '')
}

/**
 * Each asked address's quote from a provider `tokens` body: the pair naming
 * it (as base or as quote) with the most reported liquidity, at least
 * MIN_LIQUIDITY_USD, with a plain positive price for it (pairPrice); null
 * when no pair qualifies. Pure.
 */
export function quotesFromTokens(body: unknown, asked: readonly string[]): Map<string, TokenQuote | null> {
  const pairs = pairsOf(body)
  const out = new Map<string, TokenQuote | null>()
  for (const raw of asked) {
    const address = raw.toLowerCase()
    let best: TokenQuote | null = null
    for (const pair of pairs) {
      const liquidity = pair.liquidity?.usd
      if (typeof liquidity !== 'number' || !Number.isFinite(liquidity) || liquidity < MIN_LIQUIDITY_USD) continue
      if (best !== null && liquidity <= (best.liquidityUsd ?? 0)) continue
      const usd = pairPrice(pair, address)
      if (usd !== null) best = { usd, liquidityUsd: liquidity }
    }
    out.set(address, best)
  }
  return out
}

export interface PriceAnswer {
  /** A quote, or null for "no qualified price", for every asked address that was answered (now or earlier in this visit). */
  quotes: ReadonlyMap<string, TokenQuote | null>
  /** The provider was asked and gave no usable answer: the card shows amounts instead of values. */
  failed: boolean
}

export interface WalletPriceDeps {
  /** One provider GET for up to PRICE_BATCH addresses: its parsed body, or null. */
  get: (addresses: readonly string[]) => Promise<unknown>
  /** Hands a token's artwork, found in the same reply, to the artwork resolver. */
  seed: (address: string, image: string | null) => void
  /** A monotonic clock, in ms. */
  now: () => number
}

export function createWalletPrices(deps: WalletPriceDeps) {
  const kept = new Map<string, { quote: TokenQuote | null; at: number }>()
  /** One GET per set of addresses on the wire, answered once: a second view of the same set joins it (StrictMode mounts twice). */
  const onWire = new Map<string, Promise<boolean>>()

  /** Reads one batch and keeps what it answered (and hands on its artwork); false when the provider gave no usable answer. */
  async function read(batch: readonly string[]): Promise<boolean> {
    const body = await deps.get(batch).catch(() => null)
    if (body === null || !Array.isArray(body)) return false
    const at = deps.now()
    const pairs = pairsOf(body)
    for (const [address, quote] of quotesFromTokens(body, batch)) {
      kept.set(address, { quote, at })
      // The reply names the token's artwork when the token is a base there: its one image, or none.
      if (pairs.some((pair) => baseOf(pair, address))) deps.seed(address, artworkFromPairs(body, address))
    }
    return true
  }

  /**
   * Quotes for `addresses` (in the caller's order of importance): USDG at $1,
   * native ETH at WETH's price, the rest from this visit's memory, and what is
   * left in ONE GET of at most PRICE_BATCH addresses. Never throws.
   */
  async function price(addresses: readonly string[]): Promise<PriceAnswer> {
    const want = [...new Set(addresses.map((address) => address.toLowerCase()).filter((address) => ADDRESS.test(address)))]
    const sourceOf = (address: string) => (address === NATIVE ? WETH : address)
    const fresh = (address: string) => {
      const entry = kept.get(address)
      return entry !== undefined && deps.now() - entry.at < PRICE_TTL_MS ? entry : null
    }
    const ask: string[] = []
    for (const address of want) {
      const source = sourceOf(address)
      if (source !== USDG && fresh(source) === null && !ask.includes(source)) ask.push(source)
    }
    let failed = false
    if (ask.length > 0) {
      const batch = ask.slice(0, PRICE_BATCH)
      const key = [...batch].sort().join(',')
      let wire = onWire.get(key)
      if (!wire) {
        wire = read(batch)
        onWire.set(key, wire)
        void wire.finally(() => onWire.delete(key))
      }
      failed = !(await wire)
    }
    const quotes = new Map<string, TokenQuote | null>()
    for (const address of want) {
      const source = sourceOf(address)
      if (source === USDG) quotes.set(address, USDG_QUOTE)
      else {
        const entry = fresh(source)
        if (entry) quotes.set(address, entry.quote)
      }
    }
    return { quotes, failed }
  }

  return { price }
}

/** The app's one price memory, for this visit. */
export const walletPrices = createWalletPrices({
  get: (addresses) => tokenArtwork.tokenPrices(addresses),
  seed: (address, image) => tokenArtwork.seed(4663, address, image),
  now: () => performance.now(),
})
