/**
 * What a position's page says of its range and its price, pure and Node-safe: the figures as a person reads them
 * (readablePrice), the range and the price now from the page's own read (rangeFacts), and the one plain status the
 * Price range card writes (statusWords). Split on purpose 2026-10-03 from lib/chart/priceRange.ts (the chart's axis,
 * labels and line), so the screens that only write prices (the key figures, the range's ends, the list) carry this
 * small part, and the chart's own code loads with the chart, on a position's page only (PositionRange.tsx).
 */
import { numberFormat } from '../format/numberFormat'
import { hasFormatCharacter } from '../symbolReading'
import { shownCardRange, shownCardTick, type CardPoolPrice, type ChainPositionCard } from '../read/screens/positions'
import type { TokenDisplay } from '../read/types'

// ---------------------------------------------------------------------------
// The figures, as a person reads them
// ---------------------------------------------------------------------------

export const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉'
export const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹'
const digitsIn = (set: string, value: number) => [...String(value)].map((digit) => set[Number(digit)]).join('')

/** A mantissa from a whole number's digits: `digits` with a point after `at` of them, and no trailing zero. */
function mantissa(digits: string, at: number): string {
  const head = digits.slice(0, at)
  const tail = digits.slice(at).replace(/0+$/, '')
  return tail ? `${head}.${tail}` : head
}

/**
 * A price as the position's page writes it (the owner, 2026-10-03: tokens from $0.001 to $1,000,000): the page's own
 * text (lib/read/screens/positions.ts tickPriceText: six significant digits, the whole part grouped), with
 *  - four zeros or more after the point counted in a subscript, as DEX screens write tiny prices:
 *    "0.000000710148" is "0.0₆710148" (six zeros after the point, then the digits);
 *  - a whole part of a billion or more in billions or trillions ("2.5B", "12.3457T"), and from 10^15 as a power of ten
 *    ("1.23457 × 10¹⁸");
 *  - anything else as it is ("0.00252025", "120,345").
 * Display only: never parsed back, and the page's exact text stays in the title. Its "≈" is dropped, as the key
 * figures drop it.
 */
export function readablePrice(text: string): string {
  const plain = text.startsWith('≈') ? text.slice(1) : text
  const tiny = /^0\.(0{4,})([1-9]\d*)$/.exec(plain)
  if (tiny) return `0.0${digitsIn(SUBSCRIPT, tiny[1].length)}${tiny[2]}`
  const whole = /^(\d{1,3}(?:,\d{3})*|\d+)(\.\d+)?$/.exec(plain)
  if (!whole) return plain
  const digits = whole[1].replace(/,/g, '')
  if (digits.length >= 16) return `${mantissa(digits, 1)} × 10${digitsIn(SUPERSCRIPT, digits.length - 1)}`
  if (digits.length >= 13) return `${mantissa(digits, digits.length - 12)}T`
  if (digits.length >= 10) return `${mantissa(digits, digits.length - 9)}B`
  return plain
}

// ---------------------------------------------------------------------------
// The range and the price now, from the page's own read
// ---------------------------------------------------------------------------

/** Where the price is against the range, in the words the card writes; a closed position earns nothing wherever it is. */
export type Where = 'inside' | 'under' | 'over' | 'closed'

/**
 * What the page's own read says of the range and the price now (2026-09-27, review): the chart draws them at once,
 * before any history, and writes them exactly as the key figures do, so one screen never shows two prices now.
 */
export interface RangeFacts {
  /** The actual current-price snapshot, never inferred from a historical line's timestamp. */
  block: number
  base: TokenDisplay
  quote: TokenDisplay
  /** The range's ends as prices, for geometry only: 0 and Infinity at the pool's limits. */
  lower: number
  upper: number
  /** The ends as the key figures write them (`161.959`, `0`, `∞`); null for an end written as its tick. */
  lowerText: string | null
  upperText: string | null
  /** The price now as the key figures write it (`350.55`), and at its tick, for geometry. */
  now: number
  nowText: string
  where: Where
}

/** A figure without its "≈", as the key figures write it (components/positions/KeyFigures.tsx `plain`). */
const plain = (text: string) => (text.startsWith('≈') ? text.slice(1) : text)

type RangeCard = Pick<Extract<ChainPositionCard, { kind: 'live' }>, 'currencies' | 'range' | 'tickSpacing' | 'hasLiquidity'>

/**
 * The facts of a position's page, from its card and its pool price; null when a price or a decimal is missing (the
 * page's bar stands in). The app's one way round (lib/read/orientation.ts): prices of `base` in `quote`, the range's
 * lowest first, in the page's frame. 1.0001^tick × 10^(decimals) stays finite for every tick v4 allows and every
 * decimals a token can report (10^±255 × 1.0001^±887272 is inside a double), and a price the page cannot write as a
 * plain number is already unusable (chainPoolPrice: beyond 10^±24).
 */
export function rangeFacts(card: RangeCard, price: CardPoolPrice | null): RangeFacts | null {
  const { base, quote, low, high, ticks } = shownCardRange(card)
  if (price?.state !== 'usable' || base.decimals === null || quote.decimals === null) return null
  const shift = Math.pow(10, base.decimals - quote.decimals)
  const at = (tick: number) => Math.pow(1.0001, tick) * shift
  const lower = low.end.kind === 'limit' ? 0 : at(ticks.lower)
  const upper = high.end.kind === 'limit' ? Infinity : at(ticks.upper)
  const now = at(shownCardTick(price))
  if (!(now > 0) || !Number.isFinite(now) || !(lower >= 0) || !(upper > lower)) return null
  return {
    block: price.block,
    base,
    quote,
    lower,
    upper,
    lowerText: low.end.kind === 'tick' ? null : plain(low.end.text),
    upperText: high.end.kind === 'tick' ? null : plain(high.end.text),
    now,
    nowText: plain(price.text),
    where: !card.hasLiquidity ? 'closed' : price.position === 'inside' ? 'inside' : price.position === 'below' ? 'under' : 'over',
  }
}

/** How far the price must move to come back into the range, as a person says it: "25%", "4.2%", "less than 1%". */
export function moveText(share: number): string {
  const percent = share * 100
  if (!(percent > 0) || !Number.isFinite(percent)) return 'less than 1%'
  if (percent < 1) return 'less than 1%'
  if (percent < 10) return `${numberFormat({ maximumFractionDigits: 1 }).format(percent)}%`
  return `${numberFormat({ maximumFractionDigits: 0 }).format(percent)}%`
}

/** How close to an end of the range the price must be, as a share of that end, for the status to say what happens past it. */
export const NEAR_END = 0.1

/**
 * The card's one plain status (the owner, 2026-10-03: "a beginner must understand it"): a few words in bold, what they
 * mean, and, out of range, how far the price must move to come back into it.
 * Changed on purpose 2026-10-30 (QA round 2, N68, the owner's decision): in range and within 10% of an end, what happens
 * past that end, with the end as the key figures and the chart write it (readablePrice) and the token the position then
 * holds ("Near the lower end: below 161.959, it stops earning and becomes all ETH."); nothing when that end has no
 * written price or its token no symbol. The ends are named as Auto-exit names them ("Lower end", "Upper end").
 */
export function statusWords(facts: Pick<RangeFacts, 'where' | 'now' | 'lower' | 'upper' | 'lowerText' | 'upperText' | 'base' | 'quote'>): { tone: 'in' | 'out' | 'closed'; title: string; detail: string; move: string | null } {
  const { where, now, lower, upper } = facts
  switch (where) {
    case 'inside':
      return { tone: 'in', title: 'Earning fees', detail: 'the price is inside your range', move: nearEnd(facts) }
    case 'under':
      return { tone: 'out', title: 'Not earning', detail: 'the price is below your range', move: lower > 0 ? `It must rise ${moveText(lower / now - 1)} to come back into your range.` : null }
    case 'over': {
      const fall = Number.isFinite(upper) ? 1 - upper / now : 0
      const said = fall > 0.99 ? 'more than 99%' : moveText(fall)
      return { tone: 'out', title: 'Not earning', detail: 'the price is above your range', move: Number.isFinite(upper) ? `It must fall ${said} to come back into your range.` : null }
    }
    case 'closed':
      return { tone: 'closed', title: 'Closed', detail: 'this position no longer earns fees', move: null }
    default:
      return where satisfies never
  }
}

/** The most of a symbol the status writes, as TokenLabel caps it on screen (14ch). */
export const SYMBOL_CHARS = 14
/** FIRST STRONG ISOLATE and POP DIRECTIONAL ISOLATE, by code point: they are invisible in the source. */
const ISOLATE = String.fromCodePoint(0x2068)
const ISOLATE_END = String.fromCodePoint(0x2069)

/**
 * A token's symbol inside a sentence, as TokenLabel draws it beside one: isolated (U+2068 … U+2069, the text form of its
 * <bdi>), so a right-to-left symbol never reorders the words around it, and cut at SYMBOL_CHARS with an ellipsis; null
 * for none, or for one holding a format character, which could break out of the isolation (audit I2's rule).
 */
export function symbolInText(symbol: string | null): string | null {
  if (!symbol || hasFormatCharacter(symbol)) return null
  const chars = [...symbol]
  return `${ISOLATE}${chars.length > SYMBOL_CHARS ? `${chars.slice(0, SYMBOL_CHARS - 1).join('')}…` : symbol}${ISOLATE_END}`
}

/**
 * In range, near an end (NEAR_END): below the lower end the position becomes all `base` (the token priced), above the
 * upper end all `quote`. Null away from both ends, at an end that is the pool's limit, or without that end's written
 * price or its token's symbol (symbolInText).
 */
function nearEnd({ now, lower, upper, lowerText, upperText, base, quote }: Pick<RangeFacts, 'now' | 'lower' | 'upper' | 'lowerText' | 'upperText' | 'base' | 'quote'>): string | null {
  if (lower > 0 && now / lower - 1 < NEAR_END) {
    const symbol = symbolInText(base.symbol)
    return lowerText !== null && symbol ? `Near the lower end: below ${readablePrice(lowerText)}, it stops earning and becomes all ${symbol}.` : null
  }
  if (Number.isFinite(upper) && 1 - now / upper < NEAR_END) {
    const symbol = symbolInText(quote.symbol)
    return upperText !== null && symbol ? `Near the upper end: above ${readablePrice(upperText)}, it stops earning and becomes all ${symbol}.` : null
  }
  return null
}
