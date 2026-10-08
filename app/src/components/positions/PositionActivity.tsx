import { lazy, Suspense, useMemo } from 'react'
import { automationImpact, useVaultRecord, type AutoAdd } from '../../lib/automationImpact'
import type { AutomationView } from '../../lib/automationState'
import { useFeeHistory } from '../../lib/fees/useFeeHistory'
import { AUTOMATION_NAME } from './visual/AutomationImpact'
import { FeesActivity } from './visual/FeesActivity'
import { feesEvents } from './visual/model'
import { basisOf } from './visual/value'

const PositionHistory = __DOMINO_V2__ ? lazy(() => import('../../v2in/lists/PositionHistory')) : null

/** The automation's re-adds into the position (each its transaction and what it put back), and the automation's name. */
export type AutomaticAdds = { adds: readonly Pick<AutoAdd, 'tx' | 'value'>[]; by: string }

/**
 * The automation's re-adds into `tokenId` (2026-09-27, the owner: show when Domino's automation put the fees back),
 * from its vault's own ExecutionCompleted logs (lib/automationImpact.ts, the Fees earned card's reading of them): the
 * vault's record is read once for the visit and shared with the card, from the same fees history. Undefined for a
 * position no sequence holds, and when the automation added nothing back. Null while the rows must wait
 * (integration, 2026-09-27, as the Fees earned card waits in r5/charts): the chip's read has not answered, or a vault
 * holds the NFT and its first read has not answered or failed, so no row is drawn in the owner's words and then
 * renamed the automation's.
 */
export function useAutomaticAdds(tokenId: string, automation: AutomationView): AutomaticAdds | undefined | null {
  const fees = useFeeHistory(tokenId)
  const sequence = automation.phase === 'ready' && automation.state.automation !== 'plain' && automation.state.automation !== 'other' ? automation.state : null
  const own = fees.phase === 'verified' ? fees : null
  // The card's own range (FeesCard): from the NFT's mint to its latest settlement, so the one read serves both.
  const from = own ? own.history.mintedAt.block : 0
  const to = own ? own.history.events.reduce((top, event) => Math.max(top, event.block), from) : 0
  const pair = own ? ([own.state.currencies[0].address, own.state.currencies[1].address] as const) : null
  const { record, settled } = useVaultRecord(sequence && own ? sequence.vault : null, tokenId, pair, from, to)
  const waiting = automation.phase === 'loading' || (sequence !== null && own !== null && !settled)
  return useMemo(() => {
    if (waiting) return null
    const basis = own && basisOf(own.state)
    const impact = sequence && own && record && basis ? automationImpact({ tokenId, kind: sequence.automation, history: own.history, state: own.state, basis, record }) : null
    return impact && impact.adds.length > 0 ? { adds: impact.adds, by: AUTOMATION_NAME[impact.kind] } : undefined
  }, [waiting, sequence, own, record, tokenId])
}

/**
 * A position's Activity (the owner, 2026-09-27: the page reads top to bottom as its figures, Fees earned, Price range,
 * then what happened): its settlements from the same ledger the Fees earned card draws (the fees store's one read,
 * shared), in a card of its own after Price range. `automatic`: the automation's re-adds (useAutomaticAdds), the only
 * rows that name it. Nothing until the ledger is in and `automatic` is known (not null). Changed on purpose 2026-10-02
 * (RPC-SPEC §11.4): a ledger that cannot measure the fees earned (an owner's add or withdrawal) still lists the
 * settlements it found, with no figure where it has none.
 */
export function PositionActivity({ tokenId, automatic, owner, onMint }: { tokenId: string; automatic?: AutomaticAdds | null; owner?: string; onMint?: (mint: import('../../lib/chart/positionOpened').ActivityMint) => void }) {
  const fees = useFeeHistory(tokenId)
  const events = useMemo(() => {
    const list = fees.phase === 'verified' ? fees.history.events : fees.phase === 'unclaimed-only' ? fees.events : null
    if (!list || (fees.phase !== 'verified' && fees.phase !== 'unclaimed-only')) return null
    const basis = basisOf(fees.state)
    return basis && feesEvents(tokenId, list, basis, fees.state.currencies)
  }, [fees, tokenId])
  const legacy = !events || events.length === 0 || automatic === null ? null : (
    <section className="dm-card dm-pos-card dm-pos-activity" aria-labelledby="position-activity-title" data-position-activity="">
      <h2 id="position-activity-title" className="dm-title">
        Activity
      </h2>
      <FeesActivity events={events} bare automatic={automatic} />
    </section>
  )
  return PositionHistory ? <Suspense fallback={legacy}><PositionHistory wallet={owner ?? null} position={{ chainId: 4663, dex: 4, tokenId }} events={automatic === null ? [] : events ?? []} automatic={automatic} onMint={onMint} /></Suspense> : legacy
}
