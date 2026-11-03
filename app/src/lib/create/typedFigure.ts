/**
 * Added 2026-11-02 (review of the money PRs, M4: a typed "1,250" was read as 1250, a thousand times the 1.25 that someone
 * who writes a decimal comma meant). How a figure a person types for a transaction is read, an amount or a price, before
 * the field's own checks: one rule for New position's amounts and Pay with (./amountText.ts), a position's Add liquidity
 * and Change range, the zap journey's amounts and a new pool's starting price (v2/plan/present.ts parseUnitsText,
 * v2/plan/initialPrice.ts parsePriceText), the range steps (./typedPrice.ts typedPriceToTick) and a
 * vault's recovery (v2in/automate/tokens.ts rawFromText).
 *
 *   - The dot is always the decimal point: the site writes numbers the en-US way (lib/format/numberFormat.ts), and every
 *     figure it puts in a field is written that way, with no thousands separator.
 *   - Commas only the en-US way writes, which someone writing a decimal comma never would, are thousands separators, as
 *     before: two or more groups, or groups before a decimal dot ("1,250,000", "1,250.5").
 *   - One comma before exactly three digits, after one to three digits that do not start with 0, and no dot ("1,250",
 *     "12,500", "100,000"): 1250 or 1.25, depending on who typed it. Refused in every language, saying both readings;
 *     never guessed.
 *   - Any other single comma ("1,5", "0,125", "12,34") can only be a decimal comma: read as the decimal point where the
 *     person's language writes decimals with a comma (pt-BR, de, fr, es…), refused elsewhere, as before ("Use a dot for
 *     decimals, like 0.5.").
 *   - Anything else with a comma (a dot before it, "1.250,5"; commas that do not group) is refused, saying how to write it.
 * A comma is never dropped unless one of these rules accounts for it. Pure but for the browser's languages, read once.
 */

/** A language's decimal separator, as this reading tells them apart: a comma, or anything else (the dot). */
export type Decimal = '.' | ','

export type FigureReading =
  /** The figure as a plain decimal the fields' own checks take: no separator, a dot for the decimal point, trimmed. */
  | { ok: true; text: string }
  /** A minus sign: each field says it as its zero rule does. */
  | { ok: false; problem: 'negative' }
  /** "1,250": `asDecimal` 1.25 or `asWhole` 1250, depending on who typed it. */
  | { ok: false; problem: 'ambiguous'; typed: string; asDecimal: string; asWhole: string }
  /** A comma no rule reads for this language. */
  | { ok: false; problem: 'comma'; decimal: Decimal }

/** Thousands groups the en-US way: two or more, or before a decimal dot ("1,250,000", "1,250.5"). */
const GROUPED = /^[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?$/
/** One group and no dot: a thousands comma, or a decimal comma before three decimals. */
const ONE_GROUP = /^[1-9]\d{0,2},\d{3}$/
/** One comma between digits, or before them: a decimal comma, where the language writes one. */
const DECIMAL_COMMA = /^\d*,\d+$/

/** The decimal separator `locales` write (the first one the browser supports wins); '.' for a language it does not know. */
export function decimalOf(locales: string | readonly string[]): Decimal {
  try {
    const part = new Intl.NumberFormat(locales as string | string[]).formatToParts(1.5).find((one) => one.type === 'decimal')
    return part?.value === ',' ? ',' : '.'
  } catch {
    return '.'
  }
}

let person: Decimal | null = null

/**
 * The decimal separator of the person's language, as their browser lists its languages (the first first); the site's
 * own '.' when it lists none, and outside a browser (node's tests read the page's way unless they pass one). Read once.
 */
export function personDecimal(): Decimal {
  if (person !== null) return person
  let found: Decimal = '.'
  try {
    if (typeof window !== 'undefined' && typeof document !== 'undefined' && typeof navigator !== 'undefined') {
      const languages = navigator.languages?.length ? [...navigator.languages] : navigator.language ? [navigator.language] : []
      if (languages.length > 0) found = decimalOf(languages)
    }
  } catch {
    found = '.'
  }
  person = found
  return found
}

/** A typed figure as the fields read it (see above). `decimal`: the person's language's, unless a caller hands one in. */
export function readFigure(text: string, decimal: Decimal = personDecimal()): FigureReading {
  const trimmed = text.trim()
  if (trimmed.startsWith('-')) return { ok: false, problem: 'negative' }
  if (!trimmed.includes(',')) return { ok: true, text: trimmed }
  if (ONE_GROUP.test(trimmed)) {
    const [whole, part] = trimmed.split(',')
    return { ok: false, problem: 'ambiguous', typed: trimmed, asDecimal: `${whole}.${part}`.replace(/\.?0+$/, ''), asWhole: `${whole}${part}` }
  }
  if (GROUPED.test(trimmed)) return { ok: true, text: trimmed.replace(/,/g, '') }
  if (decimal === ',' && DECIMAL_COMMA.test(trimmed)) return { ok: true, text: trimmed.replace(',', '.') }
  return { ok: false, problem: 'comma', decimal }
}

/** What a refused reading says, under the field. */
export const FIGURE_TEXT = {
  /** A comma where the person's language writes decimals with a dot (QA round 2, N99's words). */
  dotForDecimals: 'Use a dot for decimals, like 0.5.',
  /** A comma this rule cannot read, where the person's language writes decimals with a comma. */
  noSeparator: 'Type the number without a thousands separator, like 1250,5.',
  /** "1,250 could mean 1.25 or 1250. Type 1.25 or 1250." */
  ambiguous: (typed: string, asDecimal: string, asWhole: string) => `${typed} could mean ${asDecimal} or ${asWhole}. Type ${asDecimal} or ${asWhole}.`,
} as const

/** The sentence for a comma a reading refused, or null when it read the figure or refused only its minus sign. */
export function figureProblemText(reading: FigureReading): string | null {
  if (reading.ok || reading.problem === 'negative') return null
  if (reading.problem === 'ambiguous') return FIGURE_TEXT.ambiguous(reading.typed, reading.asDecimal, reading.asWhole)
  return reading.decimal === ',' ? FIGURE_TEXT.noSeparator : FIGURE_TEXT.dotForDecimals
}

/** A typed figure's comma problem in words (the hint a field shows), or null when its comma is read or it has none. */
export const figureHint = (text: string, decimal: Decimal = personDecimal()): string | null => figureProblemText(readFigure(text, decimal))
