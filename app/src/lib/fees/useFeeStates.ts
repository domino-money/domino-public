/**
 * The on-chain state of position NFTs from POST /api/fees/v1/state (DESIGN-V2
 * §15.2, §15.4): unclaimed fees, price, range, liquidity and currencies at
 * one block, read at most eight ids a request, shared with the fees store
 * (spawn.ts) and read again every minute while the page is visible.
 *
 * The answer is null while nothing is known yet (or nothing was asked: a null
 * or empty list); then a Map from each answered id to its state, or null when
 * that id could not be read (not found, a hooked pool, the relay unavailable).
 * Ids not answered yet are absent from the Map.
 */
import { useCallback, useSyncExternalStore } from 'react'
import { feesStore } from './spawn'
import type { PositionState } from './types'

const unknown = () => null

/** Each id's state (null when it could not be read), or null while nothing is known or nothing was asked. */
export function useFeeStates(tokenIds: readonly string[] | null): ReadonlyMap<string, PositionState | null> | null {
  const key = tokenIds === null || tokenIds.length === 0 ? '' : tokenIds.join(',')
  const subscribe = useCallback((listener: () => void) => (key === '' ? () => undefined : feesStore.subscribeStates(key.split(','), listener)), [key])
  const snapshot = useCallback(() => (key === '' ? null : feesStore.states(key.split(','))), [key])
  return useSyncExternalStore(subscribe, snapshot, unknown)
}
