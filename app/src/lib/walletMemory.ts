/**
 * The Wallet card's last list per address, kept in this browser (owner,
 * round 6, 2026-09-27: the tokens took far too long to appear). The card
 * draws it at once, then reads the list again and replaces it; a read that
 * fails leaves it on screen, so the card never shrinks to nothing.
 *
 * What is kept, under one localStorage key: for at most WALLET_MEMORY_ADDRESSES
 * addresses, the tokens the address held when its list was last read to the
 * end (address, symbol, decimals, raw balance, block; at most
 * WALLET_MEMORY_ROWS), whether that list was whole, and the prices answered
 * for them, each with the time the provider answered it. All of it is public
 * chain and market data about a public address: no session, no signature, no
 * continuation handle. An entry older than WALLET_MEMORY_MAX_AGE_MS is never
 * drawn. Every value is checked again when it is read back (a symbol stays
 * untrusted text); anything else is dropped. Every storage access may throw (a
 * private window, blocked site data), and none is needed: the card reads the
 * list either way.
 *
 * Review of round 6 (2026-09-28): a price counts for WALLET_PRICE_MAX_AGE_MS
 * after it was answered, and no longer. Writing the list back keeps each
 * price's own time, so no price ever looks newer than its answer (before, with
 * the provider unreachable for days, the card showed a total at week-old
 * prices as if they were current). An older price gives no value and no
 * total; it only keeps its token where it last stood by value (the hints of
 * lib/walletHoldings.ts), so a token that lost its price never falls behind
 * an airdrop.
 */
import { ROBINHOOD_ID } from '../config/chainIdentity'
import { chainKey, movedScoped } from './chainStorage'
import { amountFact, type WalletRow } from './read/pagers'
import { identityKey, unreadToken } from './read/project'
import { NATIVE, PRICE_TTL_MS, WETH, type PriceAnswer, type TokenQuote } from './walletPrices'

/**
 * The one key, which names the chain the lists are of (2026-10-01, the chain2 workstream, part B, audit item G10):
 * `domino-wallet-v2:4663`, so a wallet remembered on one chain is never drawn on another for the same address. What was
 * kept under LEGACY_WALLET_MEMORY_KEY is Robinhood Chain's, and moves here the first time it is read (lib/chainStorage.ts
 * movedScoped); lib/browserCopies.ts ages and forgets both names.
 */
export const WALLET_MEMORY_KEY = chainKey('domino-wallet-v2', ROBINHOOD_ID)
/** The name the card kept its lists under until 2026-10-01, with no chain in it. */
export const LEGACY_WALLET_MEMORY_KEY = 'domino-wallet-v1'
/**
 * How long a remembered list may be drawn before its read answers: a day (a week until 2026-10-01, I6: lib/browserCopies.ts
 * says what this browser keeps and for how long, deletes what is past its age as the site opens, and deletes this copy
 * when the wallet is disconnected here).
 */
export const WALLET_MEMORY_MAX_AGE_MS = 86_400_000
export const WALLET_MEMORY_ADDRESSES = 4
export const WALLET_MEMORY_ROWS = 200
/** How long a price counts after the provider answered it: an hour. */
export const WALLET_PRICE_MAX_AGE_MS = 12 * PRICE_TTL_MS

/** A price the card holds (null: no qualified price), with the wall time, in ms, the provider answered it. */
export interface Stamped {
  quote: TokenQuote | null
  at: number
  /** Previous qualified price, only for stable ordering when the new price is missing or cannot value the balance. */
  hint?: { quote: TokenQuote; at: number }
}

/** Every price the card holds, by price source, and the time before which an answer no longer counts. */
export interface PriceBook {
  prices: ReadonlyMap<string, Stamped>
  since: number
}

/** The book the card starts from when nothing is remembered. */
export const NO_PRICES: PriceBook = { prices: new Map(), since: 0 }

/** The book's prices that count (`quotes`), and the older ones, which only order rows (`hints`). Pure. */
export function bookQuotes(book: PriceBook, now?: number): { quotes: Map<string, TokenQuote | null>; hints: Map<string, TokenQuote | null> } {
  const quotes = new Map<string, TokenQuote | null>()
  const hints = new Map<string, TokenQuote | null>()
  const since = Math.max(book.since, now === undefined ? book.since : now - WALLET_PRICE_MAX_AGE_MS)
  const oldestHint = since + WALLET_PRICE_MAX_AGE_MS - WALLET_MEMORY_MAX_AGE_MS
  for (const [source, { quote, at, hint }] of book.prices) {
    if (at >= since) quotes.set(source, quote)
    else if (at >= oldestHint) hints.set(source, quote)
    if (hint && hint.at >= oldestHint && (quote === null || at >= since)) hints.set(source, hint.quote)
  }
  return { quotes, hints }
}

/**
 * The book with an answer over it, each price at the time it was answered (never later than `now`), at wall time
 * `now`: from then on, a price answered more than WALLET_PRICE_MAX_AGE_MS before `now` no longer counts. Pure.
 */
export function withAnswer(book: PriceBook, answer: Pick<PriceAnswer, 'quotes' | 'at'>, now: number): PriceBook {
  const prices = new Map(book.prices)
  for (const [source, quote] of answer.quotes) {
    const at = Math.min(answer.at.get(source) ?? now, now)
    const before = prices.get(source)
    if (at >= (before?.at ?? -1)) {
      const hint = before?.quote ? { quote: before.quote, at: before.at } : before?.hint
      prices.set(source, { quote, at, ...(hint && now - hint.at <= WALLET_MEMORY_MAX_AGE_MS ? { hint } : {}) })
    }
  }
  return { prices, since: now - WALLET_PRICE_MAX_AGE_MS }
}

export interface RememberedList {
  /** Wall time, in ms, when the list was read to its end. */
  at: number
  /** The list was whole then: every page, every balance, nothing skipped. */
  whole: boolean
  rows: WalletRow[]
}

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  /** The browser's always can; without it, a copy kept under the old name is copied, not moved. */
  removeItem?(key: string): void
}

type Kept = { at: number; whole: boolean; rows: [string, string | null, number | null, string, number, number?, boolean?][]; quotes: [source: string, usd: string | null, liquidity: number | null, at: number, hintUsd?: string, hintLiquidity?: number | null, hintAt?: number][] }

const ADDRESS = /^0x[0-9a-f]{40}$/
const RAW = /^[1-9]\d{0,79}$/
const PRICE = /^\d{1,30}(\.\d{1,40})?$/

/** This browser's storage, or null where there is none to use. */
export function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

function readAll(storage: StorageLike | null): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(movedScoped(storage, WALLET_MEMORY_KEY, LEGACY_WALLET_MEMORY_KEY) ?? 'null')
    const wallets = parsed !== null && typeof parsed === 'object' && (parsed as { v?: unknown }).v === 1 ? (parsed as { wallets?: unknown }).wallets : null
    return wallets !== null && typeof wallets === 'object' && !Array.isArray(wallets) ? (wallets as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** One kept row as the pager would have made it, or null when any part of it is not what was kept. */
function reviveRow(item: unknown, at: number): WalletRow | null {
  if (!Array.isArray(item) || (item.length !== 5 && item.length !== 7)) return null
  const [address, symbol, decimals, raw, block] = item as unknown[]
  if (typeof address !== 'string' || !ADDRESS.test(address) || typeof raw !== 'string' || !RAW.test(raw)) return null
  if (!(symbol === null || (typeof symbol === 'string' && symbol.length > 0 && symbol.length <= 64))) return null
  if (!(decimals === null || (Number.isInteger(decimals) && (decimals as number) >= 0 && (decimals as number) <= 255))) return null
  if (!Number.isSafeInteger(block) || (block as number) < 0) return null
  const priorAt = item.length === 7 ? item[5] as unknown : at
  const old = item.length === 7 ? item[6] : false
  if (typeof priorAt !== 'number' || !Number.isFinite(priorAt) || priorAt < 0 || priorAt > at || typeof old !== 'boolean') return null
  const places = decimals as number | null
  return {
    key: identityKey(address),
    token: { ...unreadToken(address), symbol: symbol as string | null, decimals: places, readStatus: places === null ? 'partial' : 'available' },
    amount: amountFact({ amountRaw: raw, decimals: places }),
    raw,
    page: 1,
    pageRetrievedAt: Math.floor(priorAt / 1000),
    old,
    via: 'page',
    block: block as number,
  }
}

/** A kept price as [source, stamped], or null when any part of it is not what was kept (a price kept without its time included). */
function reviveQuote(item: unknown): [string, Stamped] | null {
  if (!Array.isArray(item) || (item.length !== 4 && item.length !== 7)) return null
  const [address, usd, liquidity, at] = item as unknown[]
  if (typeof address !== 'string' || !ADDRESS.test(address) || !Number.isSafeInteger(at) || (at as number) < 0) return null
  if (usd !== null && (typeof usd !== 'string' || !PRICE.test(usd) || !/[1-9]/.test(usd))) return null
  if (!(liquidity === null || (typeof liquidity === 'number' && Number.isFinite(liquidity) && liquidity >= 0))) return null
  const stamped: Stamped = { quote: usd === null ? null : { usd: usd as string, liquidityUsd: liquidity as number | null }, at: at as number }
  if (item.length === 7) {
    const hint = reviveQuote([address, item[4], item[5], item[6]])?.[1]
    if (!hint?.quote || hint.at > stamped.at) return null
    stamped.hint = { quote: hint.quote, at: hint.at }
  }
  return [address, stamped]
}

/** Whether something kept at `at` may still be used at `now`: at most a week old, and not from more than a minute ahead. */
const keepable = (at: number, now: number) => now - at <= WALLET_MEMORY_MAX_AGE_MS && at - now <= 60_000

/**
 * The list remembered for `address`, with the prices kept beside it as a book at `now` (a price answered more than
 * WALLET_PRICE_MAX_AGE_MS before `now` no longer counts), or null (none, too old, or not readable).
 */
export function recallWallet(address: string, now: number = Date.now(), storage: StorageLike | null = browserStorage()): (RememberedList & { book: PriceBook }) | null {
  const kept = readAll(storage)[address.toLowerCase()] as Partial<Kept> | undefined
  if (!kept || typeof kept !== 'object' || typeof kept.at !== 'number' || !Number.isFinite(kept.at) || !keepable(kept.at, now)) return null
  if (!Array.isArray(kept.rows) || kept.rows.length > WALLET_MEMORY_ROWS || !Array.isArray(kept.quotes) || kept.quotes.length > WALLET_MEMORY_ROWS) return null
  const rows = kept.rows.map((row) => reviveRow(row, kept.at as number))
  const quotes = kept.quotes.map(reviveQuote)
  if (rows.includes(null) || quotes.includes(null)) return null
  const prices = new Map((quotes as [string, Stamped][]).filter(([, price]) => keepable(price.at, now)))
  const currentRows = (rows as WalletRow[]).filter((row) => !row.old || keepable(row.pageRetrievedAt * 1000, now))
  return { at: kept.at, whole: kept.whole === true && !currentRows.some((row) => row.old), rows: currentRows, book: { prices, since: now - WALLET_PRICE_MAX_AGE_MS } }
}

/**
 * Keeps `list` for `address`, with the prices in `prices` for its tokens only
 * (by price source: WETH's for native ETH), each at the time it was answered,
 * never a later one. The oldest addresses beyond WALLET_MEMORY_ADDRESSES, and
 * entries and prices past their age, are let go.
 */
export function rememberWallet(address: string, list: RememberedList, prices: ReadonlyMap<string, Stamped>, storage: StorageLike | null = browserStorage(), now: number = Date.now()): void {
  const key = address.toLowerCase()
  if (!ADDRESS.test(key) || storage === null) return
  const rows = list.rows.filter((row) => !row.old || keepable(row.pageRetrievedAt * 1000, now)).slice(0, WALLET_MEMORY_ROWS).map((row): Kept['rows'][number] => {
    const keptRow: Kept['rows'][number] = [row.token.address.toLowerCase(), row.token.symbol, row.token.decimals, row.raw, row.block]
    if (row.old) keptRow.push(Math.min(row.pageRetrievedAt * 1000, list.at), true)
    return keptRow
  })
  const sources = new Set(rows.map(([token]) => (token === NATIVE ? WETH : token)))
  const kept: Kept = {
    at: list.at,
    whole: list.whole,
    rows,
    quotes: [...prices].filter(([token, price]) => sources.has(token) && keepable(price.at, now)).map(([token, { quote, at, hint }]) => {
      const keptQuote: Kept['quotes'][number] = [token, quote?.usd ?? null, quote?.liquidityUsd ?? null, at]
      if (hint && keepable(hint.at, now)) keptQuote.push(hint.quote.usd, hint.quote.liquidityUsd, hint.at)
      return keptQuote
    }),
  }
  const wallets = { ...readAll(storage), [key]: kept }
  const fresh = Object.entries(wallets)
    .filter(([, entry]) => typeof (entry as Partial<Kept>)?.at === 'number' && keepable((entry as Kept).at, now))
    .sort(([, a], [, b]) => (b as Kept).at - (a as Kept).at)
    .slice(0, WALLET_MEMORY_ADDRESSES)
  try {
    storage.setItem(WALLET_MEMORY_KEY, JSON.stringify({ v: 1, wallets: Object.fromEntries(fresh) }))
  } catch {
    // Full or blocked: the card reads the list again next time.
  }
}
