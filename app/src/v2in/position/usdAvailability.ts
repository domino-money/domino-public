import { shortDate, shortTime } from '../../lib/format/time'

// Removed on purpose 2026-10-15 (pack 7, the owner: no status notices): usdUnavailableReason, the long sentence a figure's
// title and Details said for a missing dollar ("The USD price source is temporarily unavailable.", "Waiting for a current
// position reading.", "A reliable USD price isn’t available for every token held."); no screen says why any more.

/**
 * Added 2026-10-14 (the incident of 2026-10-13, package V1; the owner: "USD unavailable" must not appear on a position).
 * Where a row or a tile has no dollar figure it shows the position's two token amounts and this one short line for why
 * (the long sentence above stays for a title and for Details). A beginner's words, no jargon.
 */
export function usdMissingShort(reason?: string | null): string {
  const reasons = reason?.split(',') ?? []
  if (reasons.includes('awaiting_receipt_block')) return 'Updating after your transaction'
  if (reasons.includes('stale_position_or_chain')) return 'Waiting for a fresh reading'
  if (reasons.some(value => ['eth_usd_stale', 'price_read_failed', 'pricing_limit_reached', 'sequencer_down'].includes(value))) return 'USD price is updating'
  // The price source said nothing of the token (it does not list this position): no judgement of the token is implied.
  if (reasons.length > 0 && reasons.every(value => value === 'token_price_unavailable')) return 'No USD price yet'
  return 'No reliable USD price'
}

/**
 * Added 2026-10-14 (package V1, decision D4): the time a dollar figure that is not current is said with, "as of 13:05
 * UTC", in the app's one way to write a time (lib/format/time.ts). `at`: Unix ms.
 *
 * Changed on purpose 2026-10-14 (package V1, review): with its day when the moment is not today by the page's clock
 * (`now`, Unix ms), "as of 10-13 22:40 UTC". It named no day, on the ground that a kept valuation is at most a day old
 * (../lists/valuation.ts POSITION_USD_MEMORY_MS); but a figure of late last night read as one of today, and an answer
 * the page still holds after a night asleep has no bound at all.
 */
export const asOfWords = (at: number, now: number = Date.now()): string => {
  const moment = Math.floor(at / 1000)
  return shortDate(moment) === shortDate(Math.floor(now / 1000)) ? `as of ${shortTime(moment)}` : `as of ${shortDate(moment)} ${shortTime(moment)}`
}
/** The same moment in full, for a title: "10-14 13:05 UTC". */
export const asOfFull = (at: number): string => `${shortDate(Math.floor(at / 1000))} ${shortTime(Math.floor(at / 1000))}`

/*
 * Added 2026-10-14 (package V1, review; the design's rule for a figure on screen: "every dollar figure names its basis
 * and, when it is not current, its time"; decision D3: "basis disclosed"). The words a figure's title, its line for a
 * screen reader and Details say of it, in one place for the list's row, the V2 page and Robinhood Chain's own page.
 * Until then the time took the place of the basis: an estimate at the pool's price said only "Last complete valuation,
 * from …" exactly while it was also old.
 */
/** "Last complete valuation, from 10-14 13:05 UTC." `at`: Unix ms. */
export const keptWords = (at: number): string => `Last complete valuation, from ${asOfFull(at)}.`
/** What a pool-price estimate is: its priced token (`anchor`, a label), whether that stood at the chain's own dollar, and the block of its reading (null: not said). */
export const poolEstimateWords = (anchor: string, dollar: boolean, block: number | null): string =>
  `Estimated from the pool price${block === null ? '' : ` at block ${block}`}, ${dollar ? `with ${anchor} at $1` : `converted with ${anchor}’s qualified USD price`}. This is not a sale quote.`
/**
 * One figure's title. `asOf`: the time it says when it is not current (Unix ms), else undefined. `estimate`: its basis
 * line when it is an estimate at the pool's price (poolEstimateWords), else undefined. `block`: of its reading, for a
 * current figure at qualified prices. The time and the basis are both said, never one in place of the other.
 */
export function usdTitleWords({ estimate }: { asOf: number | undefined; estimate: string | undefined; block: number | null }): string | undefined {
  // Changed on purpose 2026-10-15 (pack 7, the owner: no status notices, "as of 02:25 UTC" named among them): a figure that
  // is not current no longer says its time ("Last complete valuation, from 10-14 13:05 UTC."); it names its basis when it
  // is an estimate, and no block (that of a reading after it).
  // Changed on purpose 2026-10-31 (QA round 2 follow-ups, R23; N16: no block numbers in the main tooltips): a current figure
  // at qualified prices has no title; it said "Qualified valuation at block 102031092". `asOf` and `block` stay in the
  // signature for its callers.
  return estimate
}
