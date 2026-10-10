import type { FundingIntent } from './fundingIntent'

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
