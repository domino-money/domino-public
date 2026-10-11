import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { createActivityHistory } from './activityHistory'
import { LISTS_SOURCE } from './source'
import { subscribePositionChanges } from './positionSync'
import { confirmedOperationState, receiptFinality, recordConfirmedOperation, subscribeConfirmedOperations } from '../../lib/confirmedOperations'

const refresh = !(__DOMINO_TEST_HOOKS__ && typeof window !== 'undefined' && !(window as { __dominoRefresh?: boolean }).__dominoRefresh)
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
}, refresh)
subscribePositionChanges((change) => {
  if (change.kind === 'state') return
  const block = change.block === undefined ? 0 : Number(change.block)
  ACTIVITY_HISTORY.refresh(change.wallet?.toLowerCase(), block > 0 ? { chainId: change.chainId, block } : undefined)
}, true)
subscribeConfirmedOperations(operation => {
  if (operation.indexed && operation.phase === 'included') return
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
    const operation = proofs.find(item => item.chainId === chainId && item.hash === hash.toLowerCase())
    return operation?.blockHash === blockHash.toLowerCase() ? operation.phase : null
  }, [proofs])
  useEffect(() => {
    if (!key || !history.answer) return
    // A reload has no local action journal. Adopt only the index's exact transaction/block pair,
    // without inventing NFT scope, automation effects or a new-operation balance barrier.
    for (const item of history.answer.items.filter(item => item.chainId === 4663 && item.tx.finality === 'unfinalized' && receiptFinality(item.chainId, item.tx.hash, item.tx.snapshot.hash) === null).slice(0, 32)) {
      recordConfirmedOperation({ indexed: true, chainId: item.chainId, wallet: key, tokenIds: [], receipt: { transactionHash: item.tx.hash, blockHash: item.tx.snapshot.hash, blockNumber: BigInt(item.tx.snapshot.number), state: 'included' } })
    }
  }, [key, history.answer])
  return { ...history, proofs, receiptFinality: finality, moreRows: () => { if (key) ACTIVITY_HISTORY.more(key) } }
}
