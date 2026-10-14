/**
 * Added 2026-10-14 (incident C1; the owner's decision D0): what a receipt row says of its transaction, one wording for
 * the three kinds of row (./receiptParts.tsx, ./SessionActivityRow.tsx, ./LocalReceiptRow.tsx).
 *
 * "Confirmed" means in a block of the chain with a success status: the row carries its check from that moment. Until
 * this change the check waited for the chain's finalized block under a pill "Confirming", which is about 16 minutes on
 * Robinhood Chain (measured 2026-10-13: 9,357 blocks behind the head at 9.73 blocks a second) and 15 to 20 on Base and
 * Arbitrum One, with nothing wrong. Finality is one line of the opened receipt, never a pill and never a wait. All three
 * networks become final on Ethereum, so the line names it; no number of minutes is said, because none is computed from
 * the answer. "Confirming" is left for a transaction that is sent and not in a block yet.
 */
export const RECEIPT_WORDS = {
  /** The check's name. */
  confirmed: 'Confirmed',
  /** The pill of a transaction that is not in a block yet. */
  confirming: 'Confirming',
  /** The opened receipt's Status line: not in a block yet, in a block, in a final block. */
  waiting: 'Waiting for the network',
  notFinal: 'Confirmed. Not final on Ethereum yet.',
  final: 'Final.',
} as const

/** The opened receipt's Status line. `finalized` keeps its meaning: at or below the chain's finalized block. */
export function receiptStatus(state: { confirmed: boolean; finalized: boolean }): string {
  return state.finalized ? RECEIPT_WORDS.final : state.confirmed ? RECEIPT_WORDS.notFinal : RECEIPT_WORDS.waiting
}
