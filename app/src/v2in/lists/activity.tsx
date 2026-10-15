import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { createActivityHistory, type ActivityItem } from './activityHistory'
import { LISTS_SOURCE } from './source'
import { subscribePositionChanges } from './positionSync'
import { confirmedOperationState, noteAnswerFinality, recordConfirmedOperation, subscribeConfirmedOperations } from '../../lib/confirmedOperations'
import { indexedOperationEvidence, quietWallet } from './activityModel'
import { pageWake } from '../../lib/wake'
import { CREATED_POSITIONS } from './createdPositions'
import { LOCAL_RECEIPTS } from './localReceipts'

const refresh = !(__DOMINO_TEST_HOOKS__ && typeof window !== 'undefined' && !(window as { __dominoRefresh?: boolean }).__dominoRefresh)
/**
 * (2026-10-15, pack 7): when this browser last saw an action of its own, in any of its tabs (ms), so another tab's head keeps
 * its minute for a while after it (activityModel.ts OWN_ACTION_QUIET_MS). Kept in this browser's storage; nothing is sent.
 */
const OWN_ACTION_KEY = 'domino:own-action-at:v1'
const noteOwnAction = () => { try { localStorage.setItem(OWN_ACTION_KEY, String(Date.now())) } catch { /* Storage may be unavailable: this tab's own head still knows (activityHistory.ts `touched`). */ } }
const ownActionAt = (): number | null => {
  try {
    const text = localStorage.getItem(OWN_ACTION_KEY)
    return text !== null && /^\d{1,16}$/.test(text) ? Number(text) : null
  } catch {
    // Unreadable storage: as if an action had just happened, so the head keeps its minute.
    return Date.now()
  }
}
/** (2026-10-15, pack 7): whether the wallet's head may take its idle period (activityHistory.ts IDLE_HEAD_DELAY). */
const idleWallet = (wallet: string, items: readonly ActivityItem[]) => quietWallet(wallet, items, {
  operations: confirmedOperationState(), created: CREATED_POSITIONS.get(wallet).length, local: LOCAL_RECEIPTS.get(wallet), ownActionAt: ownActionAt(), now: Date.now(),
})
// Changed on purpose 2026-10-14 (incident C2): each answer's `chains[].finalizedThrough` is handed to the confirmation
// queue (the fourth argument), as the portfolio's is (source.ts). The queue polls nothing by itself any more: these
// answers are how it learns that a block may be final.
export const ACTIVITY_HISTORY = createActivityHistory((wallet, page) => LISTS_SOURCE.ownActivity(wallet, page), {
  set: (run, ms) => setTimeout(run, ms),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  visible: () => !document.hidden,
  now: () => Date.now(),
  onVisible(run) {
    const wake = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', wake); run() } }
    document.addEventListener('visibilitychange', wake)
    return () => document.removeEventListener('visibilitychange', wake)
  },
}, refresh, answer => noteAnswerFinality(answer.chains), idleWallet)
subscribePositionChanges((change) => {
  if (change.kind === 'state') return
  noteOwnAction()
  const block = change.block === undefined ? 0 : Number(change.block)
  ACTIVITY_HISTORY.refresh(change.wallet?.toLowerCase(), block > 0 ? { chainId: change.chainId, block } : undefined)
}, true)
subscribeConfirmedOperations(operation => {
  noteOwnAction()
  if (operation.indexed && operation.phase !== 'reorged') return
  ACTIVITY_HISTORY.refresh(operation.wallet, operation.phase === 'reorged' ? undefined : { chainId: operation.chainId, block: operation.block, finalized: operation.phase === 'finalized' })
})
// Changed on purpose 2026-10-14 (incident 2026-10-13, design 2.5, package Q1): the page's one wake rule (lib/wake.ts), not
// every focus, online and visibility change: a head is read again at a wake only when its last good answer is older than
// its own period (activityHistory.ts wake). The test builds' refresh switch stays as it was.
if (refresh) pageWake.onWake(() => ACTIVITY_HISTORY.wake())
// (2026-10-15, pack 7 review): an action in another tab of this browser (its note in this browser's storage, which only the
// other tabs hear) puts this tab's idle head back on main's minute at once, with no read of its own (activityHistory.ts calm).
if (refresh && typeof window !== 'undefined') window.addEventListener('storage', (event) => { if (event.key === OWN_ACTION_KEY) ACTIVITY_HISTORY.calm() })
const EMPTY = { answer: null, error: null, loading: false, more: false, catchingUp: false } as const

export function useActivityHistory(wallet: string | null) {
  const key = wallet?.toLowerCase() ?? null
  const subscribe = useCallback((listener: () => void) => key === null ? () => undefined : ACTIVITY_HISTORY.subscribe(key, listener), [key])
  const snapshot = useCallback(() => key === null ? EMPTY : ACTIVITY_HISTORY.get(key), [key])
  const history = useSyncExternalStore(subscribe, snapshot, () => EMPTY)
  const proofs = useSyncExternalStore(subscribeConfirmedOperations, confirmedOperationState, confirmedOperationState)
  const finality = useCallback((chainId: number, hash: string, blockHash: string) => {
    const operation = proofs.find(item => item.wallet === key && item.chainId === chainId && item.hash === hash.toLowerCase())
    return operation?.blockHash === blockHash.toLowerCase() ? operation.phase : null
  }, [key, proofs])
  useEffect(() => {
    if (!key || !history.answer) return
    // Changed on purpose 2026-10-14 (incident C2): only an operation this browser sent is completed from the index. A
    // receipt it merely lists is no longer recorded, so opening this list starts no read of the node (activityModel.ts).
    for (const evidence of indexedOperationEvidence(key, history.answer, confirmedOperationState())) recordConfirmedOperation(evidence)
  }, [key, history.answer])
  return { ...history, proofs, receiptFinality: finality, moreRows: () => { if (key) ACTIVITY_HISTORY.more(key) } }
}
