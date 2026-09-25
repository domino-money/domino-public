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
 *
 * The list's histories are asked one at a time, in the list's order, the next
 * only once the one before verified, and none after one that did not
 * (2026-09-25): the aggregate is drawn only when every one verified, and each
 * history is now read from the RPC by the visitor's own browser, so reading
 * the rest after one failed would spend the visitor's RPC limit on nothing
 * the screen can show.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
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

const quiet = () => undefined

/** After the owner's Collect or Close on a position's page: its fees card reads the position's state again at once. */
export function refreshFeeStates(tokenIds: readonly string[]): void {
  feesStore.refresh(tokenIds)
}

/** The ids the list asks now: every one up to the first that has not verified (all of them once each one has). */
function inTurn(ids: readonly string[], views: ReadonlyMap<string, FeeHistoryView>): string {
  let upto = 0
  while (upto < ids.length - 1 && views.get(ids[upto])?.phase === 'verified') upto += 1
  return ids.slice(0, upto + 1).join(',')
}

/**
 * Several positions' views, keyed by token id, from one hook call. `null` or no ids asks nothing. On a position page
 * ('page') every id is asked at once; on the list ('list') one at a time, as said above.
 */
export function useFeeHistories(tokenIds: readonly string[] | null, scope: FeesScope): ReadonlyMap<string, FeeHistoryView> {
  // One string per id set, so a new array with the same ids is the same subscription.
  const key = tokenIds === null || tokenIds.length === 0 ? '' : tokenIds.join(',')
  const watch = useCallback((listener: () => void) => (key === '' ? quiet : feesStore.watch(key.split(','), listener)), [key])
  const snapshot = useCallback(() => (key === '' ? NONE : feesStore.views(key.split(','))), [key])
  const views = useSyncExternalStore(watch, snapshot, none)
  const asked = key === '' || scope === 'page' ? key : inTurn(key.split(','), views)
  // Asking is the store's own subscription (its listener is `watch`'s above, so this one needs none of its own).
  useEffect(() => (asked === '' ? undefined : feesStore.subscribeHistory(asked.split(','), scope, quiet)), [asked, scope])
  return views
}
