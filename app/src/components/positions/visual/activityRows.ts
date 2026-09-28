/**
 * The rows of a position's Activity and their words (the owner, 2026-09-27: plain words for someone who knows nothing
 * of pools; show when Domino's automation put the fees back). Pure, so the rules are tested on their own
 * (tests/position-activity.test.mjs); visual/FeesActivity.tsx draws them.
 *
 * Only the vault's own record says a transaction was Domino's (lib/automationImpact.ts: a manual increase has the same
 * logs, and only the vault's ExecutionCompleted in the same transaction tells them apart). So a row is the automation's
 * only when its transaction is in `automatic`, the re-adds that record names; a collect and an increase in one
 * transaction without it stay two rows in neutral words, whoever sent them.
 */

/** What a settlement did (visual/model.ts FeesEvent['kind']). */
export type SettlementKind = 'mint' | 'collect' | 'increase' | 'decrease' | 'close'

/** A row's kind: a settlement, or `auto`, the automation putting the fees back into the position. */
export type RowKind = SettlementKind | 'auto'

/**
 * The rows' words (2026-09-27, changed on purpose from Minted, Collected, Increased, Decreased and Closed). "Fees added
 * back" is the automation's, in the words the Fees earned card and its chart use for it ("Auto-compound added $X back").
 */
export const ROW_VERB: Readonly<Record<RowKind, string>> = {
  mint: 'Opened',
  collect: 'Fees collected',
  increase: 'Added to position',
  decrease: 'Withdrew part',
  close: 'Closed',
  auto: 'Fees added back',
}

export interface ActivityRow<E> {
  event: E
  kind: RowKind
  /** Its figure is the fees the step took along, not the step itself: " in fees" after it. */
  inFees: boolean
}

/**
 * The rows, in the events' order (newest first). A transaction in `automatic` (the vault's re-adds) is one row: its
 * collect and increase together, as the collect, or its one increase that settled the fees itself (the vault's NET
 * action); the row's figure is what the automation put back (visual/FeesActivity.tsx). Every other event is a row of
 * its own.
 */
export function activityRows<E extends { id: string; kind: SettlementKind; tx: string }>(events: readonly E[], automatic?: { has(tx: string): boolean }): ActivityRow<E>[] {
  const out: ActivityRow<E>[] = []
  const row = (event: E, kind: RowKind) => out.push({ event, kind, inFees: kind !== 'collect' && kind !== 'auto' })
  for (let i = 0; i < events.length; i++) {
    const a = events[i]
    if (!automatic?.has(a.tx) || (a.kind !== 'collect' && a.kind !== 'increase')) {
      row(a, a.kind)
      continue
    }
    const b = events[i + 1]
    if (b && b.tx === a.tx && b.id === a.id && (b.kind === 'collect' || b.kind === 'increase') && b.kind !== a.kind) {
      row(a.kind === 'collect' ? a : b, 'auto')
      i++
    } else row(a, a.kind === 'increase' ? 'auto' : a.kind)
  }
  return out
}
