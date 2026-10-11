import type { FundingIntent } from './fundingIntent'
import type { CrosschainJournalRecord } from '../../v2/crosschain/steps'

/** A hash is only meaningful with its origin and destination; journal reads already isolate the owner. */
export const fundingDepositKey = (record: Pick<CrosschainJournalRecord, 'originChainId' | 'destinationChainId' | 'depositTxHash'>): string =>
  `${record.originChainId}:${record.destinationChainId}:${record.depositTxHash.toLowerCase()}`

export const fundingTerminal = (state: CrosschainJournalRecord['lastState']): boolean => state === 'filled' || state === 'refunded'

/** A saved arrival never belongs to a new position merely because it uses the same wallet/network. */
export function fundingOwnsDeposit(intent: FundingIntent | null, record: CrosschainJournalRecord): boolean {
  return intent !== null && intent.destinationChainId === record.destinationChainId && intent.legs.some((leg) =>
    leg.originChainId === record.originChainId && leg.depositTxHash === record.depositTxHash.toLowerCase())
}

/** Terminal metadata retires tracking, never establishes a spendable balance or a successful fill. */
export function fundingFinished(intent: FundingIntent, records: readonly CrosschainJournalRecord[]): boolean {
  return intent.legs.length > 0 && intent.legs.every((leg) => leg.depositTxHash !== null &&
    (leg.state === 'settled' || records.some((record) => record.destinationChainId === intent.destinationChainId &&
      record.originChainId === leg.originChainId && record.depositTxHash === leg.depositTxHash && fundingTerminal(record.lastState))))
}

/** Accepted does not mean sent: only these states can be replaced without losing transfer tracking. */
export function fundingNeverSent(intent: FundingIntent): boolean {
  return intent.legs.length > 0 && intent.legs.every((leg) =>
    (leg.state === 'ready' || leg.state === 'stopped') && leg.depositTxHash === null)
}

/** Call with storage and journal snapshots read inside the wallet's exclusive funding lock. */
export function canDiscardFunding(intent: FundingIntent | null, scope: string, activity: {
  running: boolean
  deposits: number
  pending: number
  unsettled: number
}): boolean {
  return intent !== null && intent.scope !== scope && fundingNeverSent(intent) &&
    !activity.running && activity.deposits === 0 && activity.pending === 0 && activity.unsettled === 0
}
