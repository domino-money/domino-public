/**
 * What the Positions Wallet card shows of a wallet's token list (owner,
 * 2026-09-25): only the main holdings, largest first, by their USD value.
 *
 * - With prices (lib/walletPrices.ts): every token whose balance was read in
 *   whole units and is worth at least $1 at a qualified price, largest first;
 *   the first SHOWN_HOLDINGS are the card, the rest wait behind "Show N more",
 *   and the total is the sum of them all. A zero balance, dust under $1, a
 *   token with no qualified price, a balance worth more than the whole pair
 *   the price came from, and a look-alike of a main token (a symbol that
 *   reads as ETH, WETH, USDG or a selected pool's token on another contract)
 *   are left out.
 * - Without prices (the provider did not answer): the main tokens only,
 *   native ETH, WETH and USDG by their exact addresses, with their amounts.
 * - The total stands for the wallet only when the list it sums is whole
 *   (`totalWithheld`): every page read, every balance read, every held token
 *   asked about and answered. Anything less and the card shows its rows with
 *   no total, so no figure claims to be the wallet's value (review of
 *   2026-09-25).
 *
 * Two holdings that still read alike are marked `twin`, so the card can name
 * each by its address, quietly. Exact bigint arithmetic; pure and Node-safe.
 */
import { catalogueTokens } from '../config/selectedPoolCatalogue'
import type { WalletRow } from './read/pagers'
import { parseScaled } from './format/decimal'
import { PRICE_BATCH } from './tokenArtwork'
import { NATIVE, USDG, USDG_QUOTE, WETH, type TokenQuote } from './walletPrices'

/** Holdings on the card before "Show N more". */
export const SHOWN_HOLDINGS = 5
/** USD values are bigints of 10^-18 dollars. */
export const USD_SCALE = 18
const ONE_DOLLAR = 10n ** BigInt(USD_SCALE)

export interface Holding {
  row: WalletRow
  /** The balance's USD value in 10^-18 dollars; null when the card shows amounts. */
  value: bigint | null
  quote: TokenQuote | null
  /** Another listed holding reads alike: the card names this one by its address too. */
  twin: boolean
}

export type HoldingsView =
  | {
      mode: 'values'
      total: bigint
      shown: Holding[]
      rest: Holding[]
      /** Held tokens whose price was never answered (not asked, or the GET failed): the total would leave them out. */
      unanswered: number
    }
  | { mode: 'amounts'; shown: Holding[] }

// Letters that only look Latin (Cyrillic and Greek capitals), and digits that pass for letters, as the Latin letter they imitate.
const LOOKS: Readonly<Record<string, string>> = {
  // Cyrillic
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041A': 'K', '\u041C': 'M', '\u041D': 'H', '\u041E': 'O', '\u0420': 'P', '\u0421': 'C', '\u0422': 'T', '\u0425': 'X', '\u0423': 'Y', '\u0406': 'I', '\u0405': 'S',
  // Greek
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H', '\u0399': 'I', '\u039A': 'K', '\u039C': 'M', '\u039D': 'N', '\u039F': 'O', '\u03A1': 'P', '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X',
  // Digits and signs
  '0': 'O', '1': 'I', L: 'I', '|': 'I', '5': 'S', '$': 'S',
}

/**
 * A symbol as it reads: compatibility forms and precomposed letters taken
 * apart (NFKD), invisible and combining marks and spaces dropped, upper case,
 * look-alike letters and digits mapped. "PONS" with a zero-width space inside
 * it, "P0NS", "ÜSDG" and "USDĢ" read "PONS" and "USDG".
 */
export function symbolReading(symbol: string): string {
  const plain = symbol.normalize('NFKD').replace(/[\p{Cf}\p{Mn}\p{Me}\p{Z}\s]/gu, '').toUpperCase()
  return [...plain].map((ch) => LOOKS[ch] ?? ch).join('')
}

/** The main tokens by how their symbol reads: native ETH, WETH and the selected pools' tokens, each bound to its one address. */
const MAIN_BY_READING: ReadonlyMap<string, string> = new Map([
  [symbolReading('ETH'), NATIVE],
  ...catalogueTokens().map((token) => [symbolReading(token.label), token.address] as const),
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

/** A row whose balance was read in whole units and is not zero. */
const held = (row: WalletRow) => row.amount.state === 'value' && /^\d+$/.test(row.raw) && BigInt(row.raw) > 0n

/** The address a held row's price is asked by: WETH's for native ETH, none for USDG ($1) or a look-alike (never shown). */
function priceSource(row: WalletRow): string | null {
  const address = row.token.address.toLowerCase()
  if (address === USDG || isLookAlike(row)) return null
  return address === NATIVE ? WETH : address
}

/**
 * The card's view of `rows`: values when `quotes` is given (the provider
 * answered), amounts of the main tokens when it is null.
 */
export function walletHoldings(rows: readonly WalletRow[], quotes: ReadonlyMap<string, TokenQuote | null> | null): HoldingsView {
  if (quotes === null) {
    const order = [NATIVE, WETH, USDG]
    const shown = rows
      .filter((row) => held(row) && order.includes(row.token.address.toLowerCase()))
      .sort((a, b) => order.indexOf(a.token.address.toLowerCase()) - order.indexOf(b.token.address.toLowerCase()))
      .map((row) => ({ row, value: null, quote: null, twin: false }))
    return { mode: 'amounts', shown }
  }
  const valued: Holding[] = []
  const seen = new Set<string>()
  let unanswered = 0
  for (const row of rows) {
    const address = row.token.address.toLowerCase()
    if (seen.has(address) || !held(row) || isLookAlike(row)) continue
    seen.add(address)
    // USDG is $1 whatever was asked; native ETH is at WETH's price.
    const source = priceSource(row)
    const answered = source === null ? USDG_QUOTE : quotes.get(source)
    if (answered === undefined) unanswered += 1
    const quote = answered ?? null
    if (quote === null) continue
    const value = usdValue(row.raw, row.token.decimals, quote)
    if (value === null || value < ONE_DOLLAR) continue
    // More than the whole pair holds is not a price anyone could get.
    if (quote.liquidityUsd !== null && value > BigInt(Math.floor(quote.liquidityUsd)) * ONE_DOLLAR) continue
    valued.push({ row, value, quote, twin: false })
  }
  valued.sort((a, b) => (a.value === b.value ? 0 : (a.value ?? 0n) > (b.value ?? 0n) ? -1 : 1))
  const all = markTwins(valued)
  const total = all.reduce((sum, h) => sum + (h.value ?? 0n), 0n)
  return { mode: 'values', total, shown: all.slice(0, SHOWN_HOLDINGS), rest: all.slice(SHOWN_HOLDINGS), unanswered }
}

/**
 * The addresses to price for `rows`, at most PRICE_BATCH (one GET), most
 * important first: WETH when native ETH or WETH is held, then the selected
 * pools' tokens the list holds, then every other token it holds, in list
 * order. Only what the wallet holds: a zero balance, USDG ($1, never asked
 * for), a look-alike (never shown) and a token the list does not hold are
 * left out, so the provider hears about no more than the card can show.
 * None when nothing needs a price.
 */
export function addressesToPrice(rows: readonly WalletRow[]): string[] {
  const holds = new Set(rows.filter(held).map(priceSource).filter((address): address is string => address !== null))
  const main = [WETH, ...catalogueTokens().map((token) => token.address)].filter((address) => holds.has(address))
  return [...new Set([...main, ...holds])].slice(0, PRICE_BATCH)
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
  /** The price GET for the list as it is now is still on the wire. */
  pricing: boolean
}

/**
 * Why the card may not show a total as the wallet's value, as a closed code
 * for a data attribute (never printed), or null when it may: the list is
 * whole and every holding it lists was valued or answered as unpriced.
 */
export function totalWithheld(list: ListWholeness, holdings: HoldingsView): string | null {
  if (holdings.mode !== 'values') return 'no_prices'
  if (list.reading) return 'reading'
  if (list.failed) return 'read_failed'
  if (list.morePages) return 'more_pages'
  if (list.capped) return 'capped'
  if (list.unread > 0) return 'unread_balances'
  if (list.earlier) return 'earlier_rows'
  if (list.skipped > 0) return 'skipped_candidates'
  if (list.pricing) return 'pricing'
  if (holdings.unanswered > 0) return 'unanswered_prices'
  if (holdings.shown.length === 0) return 'nothing_valued'
  return null
}
