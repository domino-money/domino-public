/**
 * USD prices for the Positions Wallet card. The owner asked for the main
 * tokens by USD value (2026-09-25), then, in round 6 (2026-09-27), for every
 * token in the wallet converted to USD, the top 3 always shown.
 *
 * - USDG, the one token every selected pool holds, is $1 by definition, as
 *   everywhere else in the app (DESIGN-V2 §22.8). It is never asked for.
 * - Native ETH is valued at WETH's price.
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
 * - One GET names up to 30 addresses (the provider's limit,
 *   tokenArtwork.tokenPrices). Round 6: a wallet holding more asks for all of
 *   them at once, in PRICE_GETS GETs at most, side by side. Before, only the
 *   first 30 were ever asked: the owner holds about 40 tokens, so UFG, his
 *   largest holding, was never priced and never shown, and the card withheld
 *   its total. Answers, a "no qualified price" included, are kept in memory
 *   for PRICE_TTL_MS, each with the time it was answered; a GET that failed
 *   is not kept, and the next ask repeats it. The card keeps its own last
 *   answers per address in the browser, with those times (lib/walletMemory.ts),
 *   never this module.
 * - The same reply names each token's artwork, which is handed to the
 *   artwork resolver, so the card's rows ask no token-pairs GET of their own.
 * - Changed on purpose 2026-10-14 (incident of 2026-10-13, package D1): where
 *   the answer is our edge's per-token one (tokenArtwork.tokenPrices), each
 *   token is priced from its own pairs and dated by when the edge retrieved
 *   them, never by when the answer reached the page. The edge may now keep an
 *   answer for a day, and the card counts a price for an hour after its time
 *   (lib/walletMemory.ts): dated on arrival, a kept price would have looked
 *   new. A token the answer leaves out has no price yet and is asked again by
 *   the next ask, as a failed GET's are. An answered price is still reused for
 *   PRICE_TTL_MS from when the page read it.
 *
 * These prices are indicative, shown in that card only: never an amount, a
 * quote, a position figure, or anything sent anywhere.
 */
import { NATIVE_ETH, USDG as MAIN_USDG, WETH as MAIN_WETH } from '../config/mainTokens'
import { parseScaled, scaledText } from './format/decimal'
import { PRICE_BATCH, artworkFromPairs, tokenArtwork } from './tokenArtwork'

// The main tokens' own addresses (config/mainTokens.ts, frozen): never a list's label for them.
export const NATIVE = NATIVE_ETH
export const WETH = MAIN_WETH
export const USDG = MAIN_USDG
/** The least liquidity (USD) a provider pair needs for its price to count. */
export const MIN_LIQUIDITY_USD = 10_000
/** How long an answered price is reused in this visit. */
export const PRICE_TTL_MS = 300_000
/** The most price GETs one ask sends, side by side: 120 tokens. */
export const PRICE_GETS = 4

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
  /**
   * When the provider answered each of `quotes`, on `now`'s clock (review of round 6, 2026-09-28: the card keeps each
   * price with the time it was answered, so an answer reused from this visit's memory never looks newer than it is).
   */
  at: ReadonlyMap<string, number>
  /** The provider was asked and no GET gave a usable answer. */
  failed: boolean
}

export interface WalletPriceDeps {
  /** One provider GET for up to PRICE_BATCH addresses: its parsed body, or null. */
  get: (addresses: readonly string[], signal?: AbortSignal) => Promise<unknown>
  /** Hands a token's artwork, found in the same reply, to the artwork resolver. */
  seed: (address: string, image: string | null) => void
  /** A clock, in ms: the app's is the wall clock, since the times it gives are kept in the browser (lib/walletMemory.ts). */
  now: () => number
}

/**
 * Our edge's per-token answer as tokenArtwork.tokenPrices hands it on (2026-10-14): each answered address with its own
 * pairs and the wall time the edge retrieved them. Null for any other body (the provider's one list, read directly).
 */
function perToken(body: unknown): Record<string, { pairs?: unknown; retrievedAt?: unknown } | null | undefined> | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body) || !('tokens' in body)) return null
  const tokens = (body as { tokens: unknown }).tokens
  return tokens !== null && typeof tokens === 'object' && !Array.isArray(tokens) ? (tokens as Record<string, { pairs?: unknown; retrievedAt?: unknown } | null | undefined>) : null
}

export function createWalletPrices(deps: WalletPriceDeps) {
  // `at`: when the price was retrieved, which is what the card is told (2026-10-14: our edge's own time for it, where the
  // answer gives one); `read`: when this page read it, which is what PRICE_TTL_MS counts from.
  const kept = new Map<string, { quote: TokenQuote | null; at: number; read: number }>()
  // The GET each address is on the wire in: a later ask naming it waits for that GET instead of sending it again (round
  // 6: the card asks as each page names new tokens, and a page can land before the prices of the one before it do).
  type Wire = { result: Promise<boolean>; controller: AbortController; users: number; settled: boolean }
  const onWire = new Map<string, Wire>()

  /** Reads one batch and keeps what it answered (and hands on its artwork); false when the provider gave no usable answer. */
  async function read(batch: readonly string[], signal: AbortSignal): Promise<boolean> {
    const body = await deps.get(batch, signal).catch(() => null)
    if (signal.aborted || body === null) return false
    /** The reply names the token's artwork when the token is a base there: its one image, or none. A token no pair names at all is one the provider does not know. */
    const seed = (pairs: PairShape[], source: unknown, address: string) => {
      if (pairs.some((pair) => baseOf(pair, address))) deps.seed(address, artworkFromPairs(source, address))
      else if (!pairs.some((pair) => quoteOf(pair, address))) deps.seed(address, null)
    }
    // Our edge's per-token answer (2026-10-14): each token from its own pairs, at its own retrieval time, never later
    // than now. A token it leaves out, or writes any other way, was not answered: no price yet, asked again next time.
    const tokens = perToken(body)
    if (tokens) {
      const now = deps.now()
      let answered = 0
      for (const address of batch) {
        const own = tokens[address]
        if (!own || !Array.isArray(own.pairs) || typeof own.retrievedAt !== 'number' || !Number.isFinite(own.retrievedAt)) continue
        answered += 1
        kept.set(address, { quote: quotesFromTokens(own.pairs, [address]).get(address) ?? null, at: Math.min(now, own.retrievedAt), read: now })
        seed(pairsOf(own.pairs), own.pairs, address)
      }
      return answered > 0
    }
    const partial = !Array.isArray(body) && typeof body === 'object' && 'pairs' in body && 'unavailable' in body
      ? body as { pairs: unknown; unavailable: unknown } : null
    const source = partial?.pairs ?? body
    if (!Array.isArray(source) || (partial && (!Array.isArray(partial.unavailable) || !partial.unavailable.every(value => typeof value === 'string')))) return false
    // A partial provider read is not proof that the unanswered token has no qualified market.
    const unavailable = new Set((partial?.unavailable as string[] | undefined)?.map(value => value.toLowerCase()))
    const answered = batch.filter(address => !unavailable.has(address))
    if (answered.length === 0) return false
    const at = deps.now()
    const pairs = pairsOf(source)
    for (const [address, quote] of quotesFromTokens(source, answered)) {
      kept.set(address, { quote, at, read: at })
      // The reply names the token's artwork when the token is a base there: its one image, or none. A token no pair names
      // at all is one the provider does not know (round 6: the card lists those too): no artwork, and no GET per row.
      seed(pairs, source, address)
    }
    return true
  }

  /** One GET for `ask`, each of its addresses marked on the wire until it is answered. */
  function send(ask: readonly string[]): Wire {
    const controller = new AbortController()
    const wire: Wire = { result: read(ask, controller.signal), controller, users: 0, settled: false }
    for (const address of ask) onWire.set(address, wire)
    void wire.result.finally(() => {
      wire.settled = true
      for (const address of ask) if (onWire.get(address) === wire) onWire.delete(address)
    })
    return wire
  }

  /**
   * Quotes for `addresses` (in the caller's order of importance): USDG at $1,
   * native ETH at WETH's price, the rest from this visit's memory, an address
   * already on the wire from its GET (a second view, StrictMode's second
   * mount, the next page's ask all join it), and what is left in GETs of
   * PRICE_BATCH addresses (PRICE_GETS at most), all at once. `failed` when
   * every GET waited for gave no usable answer. Never throws.
   */
  async function price(addresses: readonly string[], options: { signal?: AbortSignal; onProgress?: (answer: PriceAnswer) => void } = {}): Promise<PriceAnswer> {
    const want = [...new Set(addresses.map((address) => address.toLowerCase()).filter((address) => ADDRESS.test(address)))]
    const sourceOf = (address: string) => (address === NATIVE ? WETH : address)
    const fresh = (address: string) => {
      const entry = kept.get(address)
      return entry !== undefined && deps.now() - entry.read < PRICE_TTL_MS ? entry : null
    }
    const snapshot = (failed = false): PriceAnswer => {
      const quotes = new Map<string, TokenQuote | null>()
      const at = new Map<string, number>()
      for (const address of want) {
        const source = sourceOf(address)
        const entry = source === USDG ? { quote: USDG_QUOTE, at: deps.now() } : fresh(source)
        if (entry) {
          quotes.set(address, entry.quote)
          at.set(address, entry.at)
        }
      }
      return { quotes, at, failed }
    }
    if (options.signal?.aborted) return snapshot()
    const needed = [...new Set(want.map(sourceOf))].filter((source) => source !== USDG && fresh(source) === null)
    const wires = new Set(needed.flatMap((source) => onWire.get(source) ?? []))
    const ask = needed.filter((source) => !onWire.has(source)).slice(0, PRICE_BATCH * PRICE_GETS)
    for (let i = 0; i < ask.length; i += PRICE_BATCH) wires.add(send(ask.slice(i, i + PRICE_BATCH)))
    for (const wire of wires) wire.users++
    let active = true
    const publish = () => {
      if (active && !options.signal?.aborted) options.onProgress?.(snapshot())
    }
    let cancel: () => void = () => undefined
    const cancelled = new Promise<null>((resolve) => { cancel = () => resolve(null) })
    options.signal?.addEventListener('abort', cancel, { once: true })
    try {
      publish()
      const completed = Promise.all([...wires].map((wire) => wire.result.then((ok) => { publish(); return ok })))
      const answered = await Promise.race([completed, cancelled])
      return snapshot(answered !== null && answered.length > 0 && !answered.includes(true))
    } finally {
      active = false
      options.signal?.removeEventListener('abort', cancel)
      for (const wire of wires) {
        wire.users--
        // A remount/new page may join in this turn. Cancel only after the last consumer really left.
        queueMicrotask(() => {
          if (wire.users > 0 || wire.settled) return
          wire.controller.abort()
          for (const [address, current] of onWire) if (current === wire) onWire.delete(address)
        })
      }
    }
  }

  return { price }
}

/** The app's one price memory, for this visit. */
export const walletPrices = createWalletPrices({
  get: (addresses, signal) => tokenArtwork.tokenPrices(addresses, signal),
  seed: (address, image) => tokenArtwork.seed(4663, address, image),
  now: () => Date.now(),
})
