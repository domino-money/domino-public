import type { DepositState } from '../../v2/crosschain/types'
import { ZERO_ADDRESS } from '../../v2/types'
import { maxSpend } from '../../lib/create/reviewPlan'

export interface TransferProgress {
  state: DepositState | null
  balance: 'updating' | 'ready' | 'unavailable'
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
