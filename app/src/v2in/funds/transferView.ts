import type { StopReason } from '../../v2/crosschain/polling'
import type { DepositState } from '../../v2/crosschain/types'
import { ZERO_ADDRESS } from '../../v2/types'
import { maxSpend } from '../../lib/create/reviewPlan'

export interface TransferProgress {
  state: DepositState | null
  balance: 'updating' | 'ready' | 'unavailable'
  /** Added 2026-11-02 (review M3): why this deposit will not complete as followed, when it will not (`stuckDeposit`). */
  stuck?: StuckDeposit | null
}

/** Added 2026-11-02 (review M3): how long a deposit the bridge has not seen is followed before the person may remove it. */
export const UNSEEN_DEPOSIT_MS = 30 * 60_000

/**
 * Added 2026-11-02 (review M3: "a deposit that never completes cannot be dismissed, and holds every later transfer to its
 * destination"): only `filled` and `refunded` ended a deposit, so one whose own transaction reverted, was dropped, or was
 * replaced in the wallet under another hash was followed, and held its destination, for good. Why one will not complete:
 *   - `reverted`: its own transaction reverted on the origin (this page read it): nothing left the wallet for the bridge.
 *     Final: it no longer holds its destination, its transfer may go on, and it may be removed.
 *   - `refund_failed`: the bridge's own refund failed; its words say how to reclaim it. It may be removed.
 *   - `unfollowable`: the status service stopped following it (`not_found`, `unexpected`, `bug`). It may be removed, once
 *     the person has checked the wallet's activity: it may still have gone through.
 *   - `unseen`: the bridge has not seen it for UNSEEN_DEPOSIT_MS of this page's following. Likewise.
 * Null while it is moving, or once it is done. Only `reverted` lets go of anything by itself: the others may still be on
 * their way, and are let go by the person (Remove).
 */
export type StuckDeposit = 'reverted' | 'refund_failed' | 'unfollowable' | 'unseen'
export function stuckDeposit(input: { state: DepositState | null; stopped: StopReason | null; receipt: 'pending' | 'included' | 'finalized' | 'reverted' | null; unseenMs: number | null }): StuckDeposit | null {
  if (input.state === 'filled' || input.state === 'refunded') return null
  if (input.receipt === 'reverted') return 'reverted'
  if (input.state === 'refund_failed') return 'refund_failed'
  if (input.stopped === 'not_found' || input.stopped === 'unexpected' || input.stopped === 'bug') return 'unfollowable'
  if ((input.state === null || input.state === 'awaiting_deposit') && input.unseenMs !== null && input.unseenMs >= UNSEEN_DEPOSIT_MS) return 'unseen'
  return null
}

/** Tracking completion and current spending power are separate facts. */
export function transferTitle(state: DepositState | null, destination: string): string {
  if (state === null) return 'Checking your transfer'
  if (state === 'filled') return `Funds arrived on ${destination}`
  if (state === 'refunded') return 'Funds returned'
  if (state === 'failed' || state === 'refund_pending') return 'Returning your funds'
  if (state === 'refund_failed') return 'Your transfer needs attention'
  return `Transferring to ${destination}`
}

/** Display spendable funds, not a receipt or an instruction to spend the wallet. */
export function availableBalance(token: string, raw: string): string {
  return maxSpend(BigInt(raw), token.toLowerCase() === ZERO_ADDRESS).toString()
}
