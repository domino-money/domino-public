/**
 * A pool's fee tier as every screen writes it (audit E21, 2026-10-01). Markets' rows said "Uniswap · 0.30%", its cards
 * "· Uniswap 0.30%", a pool's page "Uniswap · 0.30% fee" and New position "0.30% fee": one format now. The fee is always
 * "0.30% fee" (or "Dynamic fee" where the pool's hook sets it), so a bare percentage never reads as a yield; where the
 * exchange is named, it comes first: "Uniswap · 0.30% fee". A narrow screen may hide the exchange (markets.css), never
 * the fee.
 */

/** The exchange every Domino pool lives on. */
export const FEE_VENUE = 'Uniswap'

/** "0.30%" → "0.30% fee"; "Dynamic" or "Dynamic fee" → "Dynamic fee"; anything already ending in "fee" as it is. */
export function feeWords(fee: string): string {
  const text = fee.trim()
  if (/^dynamic(?: fee)?$/i.test(text)) return 'Dynamic fee'
  return /\bfee$/i.test(text) ? text : `${text} fee`
}

/** The venue's part of a chip, before the fee: "Uniswap · ". */
export const FEE_VENUE_PREFIX = `${FEE_VENUE} · `

/** The whole chip in one string: "Uniswap · 0.30% fee". */
export const feeChipText = (fee: string) => `${FEE_VENUE_PREFIX}${feeWords(fee)}`
