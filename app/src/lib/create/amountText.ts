import { CREATE } from './copy'

/** A figure written the way the page writes one, with thousands separators: "1,000" or "2,500.25". */
const GROUPED = /^\d{1,3}(?:,\d{3})+(?:\.\d+)?$/

export type AmountText = { ok: true; text: string } | { ok: false; reason: string }

/** A plain amount as the checks take one: digits, no leading zero, an optional fraction (lib/create/journey.ts DECIMAL_TEXT). */
const PLAIN = /^(0|[1-9]\d*)(\.\d+)?$/

/**
 * Added 2026-10-30 (QA round 2, N75): a plain amount with thousands separators, the way the page writes figures
 * ("12500.5" reads "12,500.5"), for a field nobody is typing in. Text only, never through a number: the fraction keeps
 * every digit exactly as typed (a token amount, not cents), and anything else (empty, half typed, already grouped, a
 * decimal comma) is returned as it is. amountText reads the grouped form back to the same amount.
 */
export function groupedAmount(text: string): string {
  const match = PLAIN.exec(text)
  if (!match) return text
  return `${match[1].replace(/\B(?=(\d{3})+$)/g, ',')}${match[2] ?? ''}`
}

/**
 * Added 2026-10-30 (QA round 2, N99): a typed amount as the checks read it. Spaces around it are dropped, and the
 * thousands separators of a figure written the way the page writes one ("1,000.50"). A minus sign is said as the
 * zero rule says it, and any other comma ("0,5") asks for a dot, instead of the one line for every bad shape. The
 * text kept in the field is never changed here: only what is checked and converted. Changed on purpose 2026-10-30 (QA
 * round 2, N99, pass 3): an amount typed to pay with another token is read the same way, separators and all, since its
 * funds offer reads grouped text through here too (src/v2in/funds/model.ts amountRawOf), so a typed "1,000" gets its offer.
 */
export function amountText(text: string): AmountText {
  const trimmed = text.trim()
  if (trimmed.startsWith('-')) return { ok: false, reason: CREATE.amount.zero }
  if (GROUPED.test(trimmed)) return { ok: true, text: trimmed.replace(/,/g, '') }
  if (trimmed.includes(',')) return { ok: false, reason: CREATE.amount.decimalComma }
  return { ok: true, text: trimmed }
}
