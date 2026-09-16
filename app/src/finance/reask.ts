/**
 * How the private screens (receipts and managed positions) ask again on their
 * own after a read failed: a few times, waiting twice as long each time, only
 * while the tab is visible, and never for a failure that asking again cannot
 * fix before a deploy. Showing the tab again, a new sign-in or a good answer
 * starts the count over, so a service switched on while the page is open is
 * found the next time the owner comes back to it, not by a timer that runs for
 * as long as the tab stays open.
 */

/** How many more times a failed read is asked on its own before the screen waits for the owner to come back. */
export const REASK_TRIES = 3

/**
 * Failures that cannot change without a deploy: a route or page that is not
 * there, a contract this page does not speak, an answer it cannot trust, or a
 * request the service will always refuse.
 */
export const FINAL_FAILURES: ReadonlySet<string> = new Set([
  'route_not_available',
  'feature_unavailable',
  'contract_mismatch',
  'upstream_contract_mismatch',
  'invalid_response',
  'owner_or_cursor_mismatch',
  'owner_mismatch',
  'epoch_mismatch',
  'invalid_request',
  'json_required',
  'method_not_allowed',
  'request_too_large',
])

/**
 * The wait before the next automatic ask after a failure with `reason`, when
 * `tried` asks have already followed failures: `firstMs`, then twice as long
 * each time. Null when the failure is final or the tries are spent.
 */
export function reaskWait(reason: string, tried: number, firstMs: number): number | null {
  if (FINAL_FAILURES.has(reason) || tried >= REASK_TRIES) return null
  return firstMs * 2 ** tried
}
