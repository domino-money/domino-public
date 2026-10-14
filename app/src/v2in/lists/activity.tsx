import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { createActivityHistory } from './activityHistory'
import { LISTS_SOURCE } from './source'
import { subscribePositionChanges } from './positionSync'
import { confirmedOperationState, noteAnswerFinality, recordConfirmedOperation, subscribeConfirmedOperations } from '../../lib/confirmedOperations'
import { indexedOperationEvidence } from './activityModel'

const refresh = !(__DOMINO_TEST_HOOKS__ && typeof window !== 'undefined' && !(window as { __dominoRefresh?: boolean }).__dominoRefresh)
// Changed on purpose 2026-10-14 (incident C2): each answer's `chains[].finalizedThrough` is handed to the confirmation
// queue (the last argument), as the portfolio's is (source.ts). The queue polls nothing by itself any more: these
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
}, refresh, answer => noteAnswerFinality(answer.chains))
subscribePositionChanges((change) => {
  if (change.kind === 'state') return
  const block = change.block === undefined ? 0 : Number(change.block)
  ACTIVITY_HISTORY.refresh(change.wallet?.toLowerCase(), block > 0 ? { chainId: change.chainId, block } : undefined)
}, true)
subscribeConfirmedOperations(operation => {
  if (operation.indexed && operation.phase !== 'reorged') return
  ACTIVITY_HISTORY.refresh(operation.wallet, operation.phase === 'reorged' ? undefined : { chainId: operation.chainId, block: operation.block, finalized: operation.phase === 'finalized' })
})
if (refresh && typeof window !== 'undefined') {
  const wake = () => { if (!document.hidden) ACTIVITY_HISTORY.refresh() }
  window.addEventListener('focus', wake)
  window.addEventListener('online', wake)
  document.addEventListener('visibilitychange', wake)
}
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
