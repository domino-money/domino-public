import { CREATE } from './copy'
import { figureProblemText, readFigure, type Decimal } from './typedFigure'

export type AmountText = { ok: true; text: string } | { ok: false; reason: string }

/** A plain amount as the checks take one: digits, no leading zero, an optional fraction (lib/create/journey.ts DECIMAL_TEXT). */
const PLAIN = /^(0|[1-9]\d*)(\.\d+)?$/

/**
 * Added 2026-10-30 (QA round 2, N75): a plain amount with thousands separators, the way the page writes figures
 * ("12500.5" reads "12,500.5"), for a field nobody is typing in. Text only, never through a number: the fraction keeps
 * every digit exactly as typed (a token amount, not cents), and anything else (empty, half typed, already grouped, a
 * decimal comma) is returned as it is. Display only (Changed on purpose 2026-11-02, review M4): a field keeps its text as
 * typed, since a grouped "1,250" is no longer read back as 1250 (./typedFigure.ts).
 */
export function groupedAmount(text: string): string {
  const match = PLAIN.exec(text)
  if (!match) return text
  return `${match[1].replace(/\B(?=(\d{3})+$)/g, ',')}${match[2] ?? ''}`
}

/**
 * Added 2026-10-30 (QA round 2, N99): a typed amount as the checks read it. Spaces around it are dropped, and a minus
 * sign is said as the zero rule says it. The text kept in the field is never changed here: only what is checked and
 * converted. Changed on purpose 2026-10-30 (QA round 2, N99, pass 3): an amount typed to pay with another token is read
 * the same way (src/v2in/funds/model.ts amountRawOf).
 *
 * Changed on purpose 2026-11-02 (review of the money PRs, M4): commas are read by ./typedFigure.ts's rule. A page-style
 * "1,000.50" or "1,250,000" still loses its separators, but "1,250" was read as 1250, a thousand times what someone who
 * writes a decimal comma meant: it is refused now, saying both readings; "1,5" is 1.5 where the person's language writes
 * decimals with a comma, and still asks for a dot elsewhere. `decimal`: that language's separator (tests hand one in).
 */
export function amountText(text: string, decimal?: Decimal): AmountText {
  const read = readFigure(text, decimal)
  if (read.ok) return { ok: true, text: read.text }
  return { ok: false, reason: figureProblemText(read) ?? CREATE.amount.zero }
}
