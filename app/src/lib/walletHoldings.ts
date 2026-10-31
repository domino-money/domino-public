/**
 * What the Positions Wallet card shows of a wallet's token list. The owner
 * asked (round 6, 2026-09-27): convert the values to USD and ALWAYS show the
 * top 3 tokens by USD value; every other token behind a quiet "Show all".
 *
 * - Every token the wallet holds is listed: a balance read in whole units (or
 *   in raw units, when its decimals were not read) that is not zero.
 * - A token with a qualified price (lib/walletPrices.ts) carries its USD
 *   value, dust included. Priced tokens come first, largest first; the ones
 *   with no price follow (native ETH and WETH first, then the selected
 *   pools' tokens, then by symbol). A price that would make a balance worth
 *   more than the whole pair it comes from is no price.
 * - Review of round 6 (2026-09-28): a price too old to count (lib/walletMemory.ts)
 *   is a hint. It gives no value and no total, but its token keeps the place
 *   that price gave it among the others, so the rows stay in their last known
 *   order by value while prices are missing, and an unpriced airdrop never
 *   takes a top-3 place.
 * - The first SHOWN_HOLDINGS are the card; "Show all" opens the rest.
 * - The total is the sum of every value, and it stands for the wallet only
 *   when the list it sums is whole (`totalWithheld`): every page read, every
 *   balance read, every held token asked about and answered. Anything less
 *   and the card shows its rows with no total, so no figure claims to be the
 *   wallet's value (review of 2026-09-25).
 * - A look-alike of a main token (a symbol that reads as ETH, WETH, USDG or a
 *   selected pool's token on another contract) is left out: an airdropped
 *   "USDG" is not USDG, and listing it would say the wallet holds some.
 *
 * Changed on purpose (round 6): until then the card left out every token
 * without a price and every holding under $1, showed five, and valued only
 * the first 30 tokens it could name in one GET. The owner holds about 40, so
 * his largest (UFG) was never priced, never shown, and the total was
 * withheld. Two holdings that still read alike are marked `twin`, so the card
 * can name each by its address, quietly. Exact bigint arithmetic; pure and
 * Node-safe.
 *
 * Changed on purpose 2026-10-14 (incident of 2026-10-13, package D2; the
 * owner: "people will have 500, 600, 700 tokens"). Production showed "Wallet
 * value unavailable." for the owner's 63 tokens. The cause was the total rule
 * above: one held token whose provider pool no longer qualified (a price it
 * had earlier in the day, kept as a hint, and none now) counted as
 * "unanswered", and one unanswered token withheld the whole total, for up to
 * a day; so did any token beyond the 120 asked, or one whose GET failed. A
 * wallet of hundreds of tokens, most with no market, could never show one.
 * Now:
 * - The total is the sum of the tokens with a price, shown whenever the
 *   balances are whole (`totalWithheld`: still none while the list is read,
 *   after a failed or unfinished read, with balances unread or from an
 *   earlier list, without discovery, or with not a cent priced). A token with
 *   no price (no market, a pool too thin, a lost price, not asked or not
 *   answered yet) is never counted as zero in silence: `totalLeavesOut` says
 *   how many held tokens the total leaves out, and whether the list itself was
 *   cut (`capped`, or candidates the read skipped), and the card says so under
 *   the figure.
 * - The card prices a bounded set per load (`addressesToPrice`, `nextAsk`):
 *   PRICED_PER_LOAD tokens, the ones Domino knows first, then the largest
 *   holdings by the value this browser remembers, then the rest in list order,
 *   the ones remembered with no market last. Opening "Show all" prices the
 *   rest, PRICED_PER_LOAD at a time, up to PRICE_BATCH × PRICE_GETS. A wallet
 *   of 700 tokens costs the requests of a wallet of 30. Domino's own held
 *   tokens (`knownHeld`, six today at most) are asked past that bound whenever
 *   they appear (review of D2, 2026-10-14).
 */
import { ROBINHOOD_ID } from '../config/chainIdentity'
import { MAIN_TOKENS, RESERVED_SYMBOLS } from '../config/mainTokens'
import { catalogueTokens } from '../config/selectedPoolCatalogue'
import type { WalletRow } from './read/pagers'
import { parseScaled } from './format/decimal'
import { symbolReading, unsafeSymbol } from './symbolReading'
import { PRICE_BATCH } from './tokenArtwork'
import { NATIVE, PRICE_GETS, USDG, USDG_QUOTE, WETH, type TokenQuote } from './walletPrices'
import { bookQuotes, NO_PRICES, WALLET_MEMORY_MAX_AGE_MS, WALLET_PRICE_MAX_AGE_MS, type PriceBook } from './walletMemory'

/** Holdings on the card before "Show all" (owner, 2026-09-27: always the top 3). */
export const SHOWN_HOLDINGS = 3
/** USD values are bigints of 10^-18 dollars. */
export const USD_SCALE = 18
const ONE_DOLLAR = 10n ** BigInt(USD_SCALE)

export interface Holding {
  row: WalletRow
  /** The balance's USD value in 10^-18 dollars; null when the token has no price. */
  value: bigint | null
  quote: TokenQuote | null
  /** Where it sorts: its value, else its value at its hint (a price too old to count), else null (last). */
  rank: bigint | null
  /** Its price is not answered yet (never asked, on the wire, or its GET failed). */
  due: boolean
  /** Another listed holding reads alike: the card names this one by its address too. */
  twin: boolean
}

export interface HoldingsView {
  /** Every held token: the priced ones by value, largest first, then the ones with no price. */
  all: Holding[]
  /** The sum of every value. */
  total: bigint
  /** How many of `all` carry a value. */
  valued: number
  /**
   * Held tokens whose price was never answered (not asked yet, or the GET failed), or answered with none where a price
   * of the last day valued them (a lost price). The total leaves them out; since 2026-10-14 (D2) it is shown all the
   * same, saying so (totalLeavesOut).
   */
  unanswered: number
}

export { symbolReading }

/**
 * The main tokens by how their symbol reads, each bound to its one address: the embedded selected pools' tokens,
 * then native ETH, WETH and USDG from config/mainTokens.ts, which come last so no label can re-point them. Only the
 * embedded list (config/selectedPoolCatalogue.ts): a daily featured list never adds to this (2026-09-26).
 */
const MAIN_BY_READING: ReadonlyMap<string, string> = new Map([
  ...catalogueTokens().map((token) => [symbolReading(token.label), token.address] as const),
  ...MAIN_TOKENS.map((token) => [symbolReading(token.symbol), token.address] as const),
])

/** Every address the main tokens above are bound to: the addresses Domino knows on Robinhood Chain. */
const KNOWN_ADDRESSES: ReadonlySet<string> = new Set(MAIN_BY_READING.values())
/** How the reserved symbols (config/mainTokens.ts RESERVED_SYMBOLS) read. */
const RESERVED_READINGS: ReadonlySet<string> = new Set(RESERVED_SYMBOLS.map(symbolReading))
/** A symbol of plain capital letters, which reads as a reserved one only by being it (isLookAlike). */
const PLAIN_CAPITALS = /^[A-Z]+$/

/**
 * A token whose symbol reads as a main token's but lives at another address. Since 2026-10-30 (QA round 2, N64: an
 * airdropped "USDC 45 = $0.01" on the Wallet card) also a Robinhood Chain token whose symbol reads as a reserved one
 * (USDC, USDT, DAI, WBTC, EURC) at an address Domino does not know. A symbol of plain capital letters counts only when
 * it is that very symbol: the reading maps L to I because a small l passes for a capital I, which a capital L never
 * does, so a real ticker such as DAL is listed while "DAl", "dai", "DA1" or a "USDC" with a Cyrillic C are not.
 */
export function isLookAlike(row: WalletRow): boolean {
  if (row.token.symbol === null) return false
  // A misleading name, or one with a format character that can reorder the text beside it, is left out too (audit I2).
  if (unsafeSymbol(row.token.symbol)) return true
  const reading = symbolReading(row.token.symbol)
  const owner = MAIN_BY_READING.get(reading)
  const address = row.token.address.toLowerCase()
  if (owner === undefined) {
    return row.token.chainId === ROBINHOOD_ID && RESERVED_READINGS.has(reading) && !KNOWN_ADDRESSES.has(address) && (!PLAIN_CAPITALS.test(row.token.symbol) || RESERVED_SYMBOLS.includes(row.token.symbol))
  }
  // Native ETH and WETH both read as ether: either address is the real one for either symbol.
  if (owner === NATIVE || owner === WETH) return address !== NATIVE && address !== WETH
  return address !== owner
}

/** A balance's USD value at a quote, in 10^-18 dollars (rounded down); null when either is not a plain amount. */
export function usdValue(raw: string, decimals: number | null, quote: TokenQuote): bigint | null {
  if (decimals === null || !/^\d+$/.test(raw)) return null
  const price = parseScaled(quote.usd)
  if (!price || price.units <= 0n) return null
  // raw / 10^decimals × units / 10^scale, in 10^-18.
  const numerator = BigInt(raw) * price.units * ONE_DOLLAR
  return numerator / 10n ** BigInt(decimals + price.scale)
}

/** Marks holdings whose symbols read alike (two contracts that both call themselves HUMANITY). */
function markTwins(holdings: Holding[]): Holding[] {
  const counts = new Map<string, number>()
  const readingOf = (h: Holding) => (h.row.token.symbol === null ? `@${h.row.token.address}` : symbolReading(h.row.token.symbol))
  for (const h of holdings) counts.set(readingOf(h), (counts.get(readingOf(h)) ?? 0) + 1)
  return holdings.map((h) => ({ ...h, twin: (counts.get(readingOf(h)) ?? 0) > 1 }))
}

/** A row whose balance was read (in whole or raw units) and is not zero. */
export const held = (row: WalletRow) => (row.amount.state === 'value' || row.amount.state === 'raw') && /^\d+$/.test(row.raw) && BigInt(row.raw) > 0n

/** Discovery can omit a holding; only an actual balance read (including zero) supersedes it. */
export function reconcileWalletRows(kept: readonly WalletRow[], fresh: readonly WalletRow[], now: number, freshAt = now): WalletRow[] {
  const rows = new Map(kept.filter((row) => now - row.pageRetrievedAt * 1000 <= 86_400_000).map((row) => [row.key, { ...row, old: true }]))
  if (now - freshAt <= 86_400_000) for (const row of fresh) rows.set(row.key, row)
  return [...rows.values()]
}

/** The address a held row's price is asked by: WETH's for native ETH, none for USDG ($1) or a look-alike (never shown). */
export function priceSource(row: WalletRow): string | null {
  const address = row.token.address.toLowerCase()
  if (address === USDG || isLookAlike(row)) return null
  return address === NATIVE ? WETH : address
}

/** Where a token with no price sits among the others: native ETH, WETH, the selected pools' tokens, then the rest. */
const UNPRICED_FIRST = [NATIVE, WETH, ...catalogueTokens().map((token) => token.address)]
const unpricedRank = (h: Holding) => {
  const at = UNPRICED_FIRST.indexOf(h.row.token.address.toLowerCase())
  return at < 0 ? UNPRICED_FIRST.length : at
}
const symbolOf = (h: Holding) => (h.row.token.symbol ?? '').toLowerCase()

/** Largest rank first; no rank after every rank, in UNPRICED_FIRST order, then by symbol, then by address. */
function byValue(a: Holding, b: Holding): number {
  if (a.rank !== null && b.rank !== null && a.rank !== b.rank) return a.rank > b.rank ? -1 : 1
  if ((a.rank === null) !== (b.rank === null)) return a.rank === null ? 1 : -1
  if (a.rank === null) {
    const rank = unpricedRank(a) - unpricedRank(b)
    if (rank !== 0) return rank
  }
  return symbolOf(a) < symbolOf(b) ? -1 : symbolOf(a) > symbolOf(b) ? 1 : a.row.token.address < b.row.token.address ? -1 : 1
}

/** A held row's value at `quote`, or null: none, not a plain amount, or more than the whole pair holds (no price anyone could get). */
function valueAt(row: WalletRow, quote: TokenQuote | null | undefined): bigint | null {
  const value = quote ? usdValue(row.raw, row.token.decimals, quote) : null
  return value !== null && quote?.liquidityUsd != null && value > BigInt(Math.floor(quote.liquidityUsd)) * ONE_DOLLAR ? null : value
}

/**
 * The card's view of `rows`, at `quotes` (by price source; USDG is $1 whatever is given), with `hints` (prices too old
 * to count, by price source) placing the tokens `quotes` does not answer.
 */
export function walletHoldings(rows: readonly WalletRow[], quotes: ReadonlyMap<string, TokenQuote | null>, hints: ReadonlyMap<string, TokenQuote | null> = new Map()): HoldingsView {
  const list: Holding[] = []
  const seen = new Set<string>()
  let unanswered = 0
  for (const row of rows) {
    const address = row.token.address.toLowerCase()
    if (seen.has(address) || !held(row) || isLookAlike(row)) continue
    seen.add(address)
    // USDG is $1 whatever was asked; native ETH is at WETH's price.
    const source = priceSource(row)
    const answered = source === null ? USDG_QUOTE : quotes.get(source)
    const due = answered === undefined
    const hint = source !== null ? valueAt(row, hints.get(source)) : null
    // A lost qualified quote must not silently turn yesterday's largest holding into a zero-valued airdrop.
    const quoted = valueAt(row, answered)
    if (due || (quoted === null && hint !== null)) unanswered += 1
    const value = row.old ? null : quoted
    list.push({ row, value, quote: value === null ? null : (answered ?? null), rank: quoted ?? hint, due, twin: false })
  }
  const all = markTwins(list.sort(byValue))
  const valued = all.filter((h) => h.value !== null)
  return { all, total: valued.reduce((sum, h) => sum + (h.value ?? 0n), 0n), valued: valued.length, unanswered }
}

/**
 * How many tokens the card prices per page load (2026-10-14, package D2): one PRICE_BATCH, three asks of our edge,
 * whatever the wallet holds. "Show all" prices the rest, this many at a time, up to PRICE_BATCH × PRICE_GETS.
 */
export const PRICED_PER_LOAD = PRICE_BATCH
/** The most tokens the card prices in one visit, "Show all" opened included. */
export const PRICED_AT_MOST = PRICE_BATCH * PRICE_GETS

/** The tokens Domino knows, by price source: WETH (for native ETH too), then the embedded selected pools' tokens. */
const KNOWN_SOURCES = [WETH, ...catalogueTokens().map((token) => token.address)]

/**
 * The tokens Domino knows that `rows` holds, by price source, in KNOWN_SOURCES order: WETH when native ETH or WETH is
 * held, then the held selected pools' tokens (five today; USDG is $1, never asked). Review of D2 (2026-10-14): they are
 * priced whatever the load's bound (`nextAsk`'s `always`), so one the wallet starts holding after the load's ask filled
 * (on a page the remembered list did not have, or brought by a collect or a withdraw) is never left out.
 */
export function knownHeld(rows: readonly WalletRow[]): string[] {
  const holds = new Set(rows.flatMap((row) => (held(row) ? (priceSource(row) ?? []) : [])))
  return KNOWN_SOURCES.filter((address) => holds.has(address))
}

/**
 * The addresses to price for `rows`, most important first, at most `limit`
 * (PRICED_PER_LOAD unless given):
 * 1. the tokens Domino knows (knownHeld): WETH when native ETH or WETH is
 *    held, then the selected pools' tokens the list holds;
 * 2. the holdings `book` (this browser's prices, lib/walletMemory.ts) gives a
 *    value at the balance held now, largest first, a price too old to count
 *    included (2026-10-14, D2: the largest holdings first, before any is asked);
 * 3. every other held token, in list order;
 * 4. the ones `book` last saw with no qualified price, in list order.
 * Only what the wallet holds: a zero balance, USDG ($1, never asked for), a
 * look-alike (never shown) and a token the list does not hold are left out,
 * so the provider hears about no more than the card can show. None when
 * nothing needs a price.
 */
export function addressesToPrice(rows: readonly WalletRow[], { book = NO_PRICES, now, limit = PRICED_PER_LOAD }: { book?: PriceBook; now?: number; limit?: number } = {}): string[] {
  const { quotes, hints } = bookQuotes(book, now)
  const holds = new Set<string>()
  const remembered = new Map<string, bigint>()
  for (const row of rows) {
    const source = held(row) ? priceSource(row) : null
    if (source === null) continue
    holds.add(source)
    const value = valueAt(row, quotes.get(source)) ?? valueAt(row, hints.get(source))
    if (value !== null && value > (remembered.get(source) ?? -1n)) remembered.set(source, value)
  }
  const known = KNOWN_SOURCES.filter((address) => holds.has(address))
  const largest = [...remembered].sort(([, a], [, b]) => (a === b ? 0 : a > b ? -1 : 1)).map(([source]) => source)
  // Then the list's order, the ones last seen with no qualified price (and no value remembered) after the rest.
  const rest = [...holds].filter((source) => book.prices.get(source)?.quote !== null)
  return [...new Set([...known, ...largest, ...rest, ...holds])].slice(0, limit)
}

/**
 * What the card asks in this load (2026-10-14, D2): what it asked already, in the same order, then the next of `order`
 * (addressesToPrice's, unbounded) it has not asked, until `bound` in all. Never takes one back, so a later page of the
 * list, or a price that lands, never sends a token the load had no room for. Pure.
 *
 * Review of D2 (2026-10-14): then every one of `always` (knownHeld: Domino's own tokens the list holds, six today at most)
 * not asked yet, past the bound. A full ask took no token in, so a selected pool's token on a page the remembered list
 * did not have, or one a collect or a withdraw brought into a card already on screen, was never priced in the load.
 */
export const nextAsk = (asked: readonly string[], order: readonly string[], bound: number, always: readonly string[] = []): string[] =>
  [...new Set([...[...new Set([...asked, ...order])].slice(0, Math.max(bound, asked.length)), ...always])]

/** What the card knows about how whole its list is, besides the holdings themselves. */
export interface ListWholeness {
  /** A step of the list is still on the wire (the first read, Load more, a restart). */
  reading: boolean
  /** The list has more pages it was not read to (a page failed, or a handle lapsed). */
  morePages: boolean
  /** The list reached WALLET_PAGE_CAP pages with more after them. */
  capped: boolean
  /** The last step failed. */
  failed: boolean
  /** Assets on the list's pages whose balance could not be read, and that no later row answered. */
  unread: number
  /** Rows kept from an earlier list the pager restarted from (their balances are not this list's). */
  earlier: boolean
  /** Provider candidates the pages skipped (never listed, so never valued). */
  skipped: number
  /** Discovery was unavailable, not configured or not requested; known addresses are only a subset. */
  discoveryMissing?: boolean
}

/** A list with nothing missing: what a remembered whole list stands for while it is read again. */
export const WHOLE_LIST: ListWholeness = { reading: false, morePages: false, capped: false, failed: false, unread: 0, earlier: false, skipped: 0 }

/** Why a list is not whole, as a closed code, or null when it is. */
export function listGap(list: ListWholeness): string | null {
  if (list.reading) return 'reading'
  if (list.failed) return 'read_failed'
  if (list.morePages) return 'more_pages'
  if (list.capped) return 'capped'
  if (list.unread > 0) return 'unread_balances'
  if (list.earlier) return 'earlier_rows'
  if (list.skipped > 0) return 'skipped_candidates'
  if (list.discoveryMissing) return 'inventory_unavailable'
  return null
}

/**
 * Why the card may not show a total, as a closed code for a data attribute
 * (never printed), or null when it may.
 *
 * Changed on purpose 2026-10-14 (incident of 2026-10-13, package D2): only
 * what puts the balances themselves in doubt withholds it: the list still
 * read, a read that failed or did not reach its end, balances that could not
 * be read, balances from an earlier list, no discovery (in listGap's order);
 * and not a cent priced (no "$0.00" headline). A held token with no price, a
 * list cut at WALLET_PAGE_CAP pages and candidates the read skipped no longer
 * do: the total is then the priced tokens', and `totalLeavesOut` says what it
 * leaves out. It was any held token not answered (`unanswered_prices`), which a
 * single token that lost its pool kept up for a day, and any list too long to
 * read whole (`capped`).
 */
export function totalWithheld(list: ListWholeness, holdings: HoldingsView): string | null {
  const gap = listGap({ ...list, capped: false, skipped: 0 })
  if (gap !== null) return gap
  // Nothing priced, or not a cent in all: no "$0.00" headline.
  if (holdings.total < ONE_DOLLAR / 100n) return 'nothing_valued'
  return null
}

/**
 * What a shown total leaves out (2026-10-14, D2): how many held tokens it has no price for (no market, a pool too thin
 * to count, a price lost or too old, not asked in this load or not answered yet), and whether the list itself was cut
 * (more pages than the card reads, or candidates the read skipped). Nothing left out: the total is the whole list's.
 */
export function totalLeavesOut(list: ListWholeness, holdings: HoldingsView): { unpriced: number; cut: boolean } {
  return { unpriced: holdings.all.length - holdings.valued, cut: list.capped || list.skipped > 0 }
}

/**
 * One valuation as it was shown, never a sum of refreshed rows and earlier prices. Its original provenance stays
 * accessible. Since 2026-10-14 (D2) it may be the priced tokens' total: `unpriced` says how many held tokens it left out.
 */
export interface WalletTotalSnapshot {
  total: bigint
  until: number
  unpriced: number
  balances: ReadonlyMap<string, string>
  holdings: ReadonlyMap<string, Holding>
}

export function walletTotalSnapshot(rows: readonly WalletRow[], book: PriceBook, at: number, now: number): WalletTotalSnapshot | null {
  const { quotes, hints } = bookQuotes(book, now)
  const holdings = walletHoldings(rows, quotes, hints)
  if (rows.some(row => row.old) || totalWithheld(WHOLE_LIST, holdings) !== null) return null
  // A holding placed by a price too old to count and not answered since would make the total look smaller than the
  // next answer will (2026-10-14, D2): no valuation to keep from it.
  if (holdings.all.some((holding) => holding.due && holding.rank !== null)) return null
  // Each original price answer keeps its own expiry. Re-reading the list cannot renew it. Only the prices the total
  // counts set it (2026-10-14, D2): a token with none, never asked, is not in it.
  const counted = holdings.all.flatMap((holding) => (holding.value === null ? [] : [priceSource(holding.row)])).filter((source): source is string => source !== null)
  const until = Math.min(at + WALLET_MEMORY_MAX_AGE_MS, ...counted.map(source => (book.prices.get(source)?.at ?? 0) + WALLET_PRICE_MAX_AGE_MS))
  return until > now ? { total: holdings.total, until, unpriced: holdings.all.length - holdings.valued, balances: new Map(rows.filter(held).map(row => [row.key, row.raw])), holdings: new Map(holdings.all.map(holding => [holding.row.key, holding])) } : null
}

/** A read change, including an explicit zero, invalidates the snapshot before the rest of the pages finish. */
export function walletSnapshotValid(snapshot: WalletTotalSnapshot | null, fresh: readonly WalletRow[], now: number): boolean {
  return snapshot !== null && now < snapshot.until && !fresh.some(row => !row.old
    && (held(row) || (row.amount.state === 'zero' && snapshot.balances.has(row.key))) && snapshot.balances.get(row.key) !== row.raw)
}
