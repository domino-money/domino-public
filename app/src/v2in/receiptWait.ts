/**
 * How the integrated screens wait for a transaction the person sent to be in a block (incident 2026-10-13, package C3:
 * waiting never locks; screens finish at inclusion). Pure: no wallet, no network, no timer of its own.
 *
 * Before 2026-10-14 a wait asked every 1.5 s, and any failed read but three wallet codes ended it: a refused or lost
 * confirmation read during the second it takes Robinhood Chain to include a transaction locked Create, Add, Change range
 * and Withdraw with "Sent to your wallet. Check your wallet's activity…", although the transaction succeeded. Now:
 *   - a failed read is "ask again". Only the money clients' codes that say the transaction read back is not the one
 *     reviewed end a wait (the list automation's steps already used, automate/session.tsx); nothing is ever offered again;
 *   - the pause grows: 0.4, 0.8, 1.5, 3, 5, then 10 s, with up to a quarter more at random so tabs do not ask together.
 *     After a failed read it is never less than 1 s, doubling to a minute while reads keep failing (an error slows a
 *     reader down, never speeds it up). A wait an answer names (Retry-After) is honoured where the question is asked:
 *     lib/edge/confirmation.ts asks nothing of that question before it, and the person's wallet is asked instead;
 *   - after 20 s the step says it is sent and still waiting to be seen on the network, with its explorer link.
 */

/** The money clients' codes that say the transaction read back is not the one reviewed: waiting changes nothing. */
export const RECEIPT_SETTLED_CODES: ReadonlySet<string> = new Set(['receipt_not_from_this_review', 'transaction_does_not_match_review', 'invalid_receipt', 'receipt_duplicate_action'])
export const receiptSettled = (error: unknown): boolean => error instanceof Error && RECEIPT_SETTLED_CODES.has(error.message)

/**
 * Added 2026-10-14 (C3 review): a read that failed because the wallet is now on another network (`chain`) or another
 * account (`account`). It is still "ask again", but the page cannot see the step through the wallet until it is back, so
 * the step says so (before C3 these codes locked the step; after it, the step waited with nothing to say why).
 */
export function receiptWalletAway(error: unknown): 'chain' | 'account' | null {
  if (!(error instanceof Error)) return null
  return error.message === 'wallet_wrong_chain' ? 'chain' : error.message === 'wallet_identity_changed' ? 'account' : null
}

/** The pauses before each read of a wait, then the longest one; and a failed read's floor and its ceiling. */
export const RECEIPT_PACE_MS: readonly number[] = Object.freeze([400, 800, 1_500, 3_000, 5_000])
export const RECEIPT_PACE_MAX_MS = 10_000
export const RECEIPT_FAILED_MS = 1_000
export const RECEIPT_FAILED_MAX_MS = 60_000
/** How long a wait goes before the step says it is still waiting to be seen on the network. */
export const RECEIPT_STILL_WAITING_MS = 20_000

/** The pause before read `attempt` (0 first), after `failures` failed reads in a row; `random` in [0, 1) adds up to a quarter. */
export function receiptPause(attempt: number, failures: number, random: () => number = Math.random): number {
  const pace = RECEIPT_PACE_MS[attempt] ?? RECEIPT_PACE_MAX_MS
  const backoff = failures > 0 ? Math.min(RECEIPT_FAILED_MAX_MS, RECEIPT_FAILED_MS * 2 ** (failures - 1)) : 0
  const base = Math.max(pace, backoff)
  return Math.round(base * (1 + 0.25 * Math.min(Math.max(random(), 0), 0.999)))
}
