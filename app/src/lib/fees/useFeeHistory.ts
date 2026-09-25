/**
 * The fees history of position NFTs, for the position screens (DESIGN-V2
 * §15.4, §15.6): a view over the shared fees store (spawn.ts), through
 * useSyncExternalStore, so no effect sets state and every screen showing an id
 * shares one /state read and one replay.
 *
 *   idle            nothing asked (a null id, or a build with no relay)
 *   loading         /state or the replay is on its way (`state` once /state answered)
 *   unclaimed-only  only the on-chain unclaimed figure may be shown (`reason` says why)
 *   verified        the replay equals the chain bit for bit: the history may be drawn
 *   unavailable     nothing may be shown
 *
 * `scope` sets the download budget: 'page' (a position page, 24 MB) or 'list'
 * (the Positions list's aggregate, 6 MB). A list history stopped by its budget
 * goes on from where it stopped once a position page shows the same id.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { feesStore } from './spawn'
import type { FeeHistoryView, FeesScope } from './types'

const IDLE: FeeHistoryView = { phase: 'idle' }
const NONE: ReadonlyMap<string, FeeHistoryView> = new Map()
const idle = () => IDLE
const none = () => NONE

/** One position's fees view. `null` asks nothing and stays `idle`. */
export function useFeeHistory(tokenId: string | null, scope: FeesScope = 'page'): FeeHistoryView {
  const subscribe = useCallback((listener: () => void) => (tokenId === null ? () => undefined : feesStore.subscribeHistory([tokenId], scope, listener)), [tokenId, scope])
  const snapshot = useCallback(() => (tokenId === null ? IDLE : feesStore.view(tokenId)), [tokenId])
  return useSyncExternalStore(subscribe, snapshot, idle)
}

/** Several positions' views, keyed by token id, from one hook call (the Positions list's aggregate). `null` or no ids asks nothing. */
export function useFeeHistories(tokenIds: readonly string[] | null, scope: FeesScope): ReadonlyMap<string, FeeHistoryView> {
  // One string per id set, so a new array with the same ids is the same subscription.
  const key = tokenIds === null || tokenIds.length === 0 ? '' : tokenIds.join(',')
  const subscribe = useCallback((listener: () => void) => (key === '' ? () => undefined : feesStore.subscribeHistory(key.split(','), scope, listener)), [key, scope])
  const snapshot = useCallback(() => (key === '' ? NONE : feesStore.views(key.split(','))), [key])
  return useSyncExternalStore(subscribe, snapshot, none)
}
