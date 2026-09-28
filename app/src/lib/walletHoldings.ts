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
 */
import { MAIN_TOKENS } from '../config/mainTokens'
import { catalogueTokens } from '../config/selectedPoolCatalogue'
import type { WalletRow } from './read/pagers'
import { parseScaled } from './format/decimal'
import { symbolReading } from './symbolReading'
import { PRICE_BATCH } from './tokenArtwork'
import { NATIVE, PRICE_GETS, USDG, USDG_QUOTE, WETH, type TokenQuote } from './walletPrices'

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
  /** Held tokens whose price was never answered (not asked yet, or the GET failed): the total would leave them out. */
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

/** A token whose symbol reads as a main token's but lives at another address. */
export function isLookAlike(row: WalletRow): boolean {
  if (row.token.symbol === null) return false
  const owner = MAIN_BY_READING.get(symbolReading(row.token.symbol))
  // Native ETH and WETH both read as ether: either address is the real one for either symbol.
  if (owner === undefined) return false
  const address = row.token.address.toLowerCase()
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

/** The address a held row's price is asked by: WETH's for native ETH, none for USDG ($1) or a look-alike (never shown). */
function priceSource(row: WalletRow): string | null {
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
    if (due) unanswered += 1
    const value = valueAt(row, answered)
    list.push({ row, value, quote: value === null ? null : (answered ?? null), rank: value ?? (due && source !== null ? valueAt(row, hints.get(source)) : null), due, twin: false })
  }
  const all = markTwins(list.sort(byValue))
  const valued = all.filter((h) => h.value !== null)
  return { all, total: valued.reduce((sum, h) => sum + (h.value ?? 0n), 0n), valued: valued.length, unanswered }
}

/**
 * The addresses to price for `rows`, most important first: WETH when native
 * ETH or WETH is held, then the selected pools' tokens the list holds, then
 * every other token it holds, in list order; at most PRICE_GETS GETs' worth.
 * Only what the wallet holds: a zero balance, USDG ($1, never asked for), a
 * look-alike (never shown) and a token the list does not hold are left out,
 * so the provider hears about no more than the card can show. None when
 * nothing needs a price.
 */
export function addressesToPrice(rows: readonly WalletRow[]): string[] {
  const holds = new Set(rows.filter(held).map(priceSource).filter((address): address is string => address !== null))
  const main = [WETH, ...catalogueTokens().map((token) => token.address)].filter((address) => holds.has(address))
  return [...new Set([...main, ...holds])].slice(0, PRICE_BATCH * PRICE_GETS)
}

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
  return null
}

/**
 * Why the card may not show a total as the wallet's value, as a closed code
 * for a data attribute (never printed), or null when it may: the list is
 * whole and every holding it lists was valued or answered as unpriced.
 */
export function totalWithheld(list: ListWholeness, holdings: HoldingsView): string | null {
  const gap = listGap(list)
  if (gap !== null) return gap
  if (holdings.unanswered > 0) return 'unanswered_prices'
  // Nothing priced, or not a cent in all: no "$0.00" headline.
  if (holdings.total < ONE_DOLLAR / 100n) return 'nothing_valued'
  return null
}
