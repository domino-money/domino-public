/**
 * The fees history of position NFTs, for the position screens (DESIGN-V2 §15.4, §15.6): a view over the shared fees
 * store (spawn.ts), through useSyncExternalStore, so no effect sets state and every screen showing an id shares one /state
 * read and one ledger read.
 *
 *   idle            nothing asked (a null id, or a build with no relay)
 *   loading         /state or the ledger is on its way (`state` once /state answered)
 *   unclaimed-only  only the on-chain unclaimed figure may be shown (`reason` says why)
 *   verified        the ledger is exact and agrees with the chain: Fees earned and its measured points may be drawn
 *   cached          a previous visit's verified history, saved in this browser
 *   unavailable     nothing may be shown
 *
 * `scope`: 'page' (a position page: its state read every minute, and its ledger) or 'list' (the Positions list's rows:
 * their ledgers alone, eight ids a request; Changed on purpose 2026-10-02, RPC-SPEC §11.4: the list asked one replay at a
 * time, and its rows waited for each other).
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { freshState } from './client'
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

/**
 * After the owner's Collect or Close on a position's page: its fees card reads the position's state again at once, and
 * (2026-10-01, the RPC switch's integration) every state read of it for a few seconds asks the route fresh, so neither the
 * card nor the page takes an answer the route kept from before the action (client.ts freshState). A state that shows the
 * settlement then asks the ledger again, fresh (store.ts).
 */
export function refreshFeeStates(tokenIds: readonly string[]): void {
  freshState(tokenIds)
  feesStore.refresh(tokenIds)
}

/** Several positions' views, keyed by token id, from one hook call. `null` or no ids asks nothing. */
export function useFeeHistories(tokenIds: readonly string[] | null, scope: FeesScope): ReadonlyMap<string, FeeHistoryView> {
  // One string per id set, so a new array with the same ids is the same subscription.
  const key = tokenIds === null || tokenIds.length === 0 ? '' : tokenIds.join(',')
  const watch = useCallback((listener: () => void) => (key === '' ? quiet : feesStore.watch(key.split(','), listener)), [key])
  const snapshot = useCallback(() => (key === '' ? NONE : feesStore.views(key.split(','))), [key])
  const views = useSyncExternalStore(watch, snapshot, none)
  // Asking is the store's own subscription (its listener is `watch`'s above, so this one needs none of its own).
  useEffect(() => (key === '' ? undefined : feesStore.subscribeHistory(key.split(','), scope, quiet)), [key, scope])
  return views
}
