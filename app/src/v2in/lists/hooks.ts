import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { V2ChainId } from '../../v2/types'
import type { KeyedReader } from './read'
import { listsGate, type ListsGate, type ListsMode } from './source'
import { CREATED_POSITIONS, type CreatedPosition } from './createdPositions'

const NO_CREATIONS: readonly CreatedPosition[] = Object.freeze([])
export function useCreatedPositions(wallet: string | null) {
  const subscribe = useCallback((listener: () => void) => wallet ? CREATED_POSITIONS.subscribe(wallet, listener) : () => undefined, [wallet])
  const snapshot = useCallback(() => wallet ? CREATED_POSITIONS.get(wallet) : NO_CREATIONS, [wallet])
  return useSyncExternalStore(subscribe, snapshot, () => NO_CREATIONS)
}

/** The lists' gate per chain (./source.ts listsGate), or null while it is worked out. */
export function useListsGate(): ListsGate | null {
  const [value, setValue] = useState<ListsGate | null>(null)
  useEffect(() => {
    let alive = true
    void listsGate().then((next) => {
      if (alive) setValue(next)
    })
    return () => {
      alive = false
    }
  }, [])
  return value
}

/** Whether any chain is in `mode`. */
export const anyIn = (gate: ListsGate | null, mode: ListsMode): boolean => gate !== null && (Object.values(gate) as ListsMode[]).includes(mode)

/** The chains in `mode`, as a test for the model's `open`. */
export const chainsIn = (gate: ListsGate | null, mode: ListsMode) => (chainId: V2ChainId): boolean => gate !== null && gate[chainId] === mode

/** One keyed read's last answer (shared by every view of the same key); `key` null reads nothing. */
export function useKeyed<T>(reader: KeyedReader<T>, key: string | null): T | null {
  const subscribe = useCallback((listener: () => void) => (key === null ? () => undefined : reader.subscribe(key, listener)), [reader, key])
  const snapshot = useCallback(() => (key === null ? null : reader.get(key)), [reader, key])
  return useSyncExternalStore(subscribe, snapshot, () => null)
}

/** Last attempt separately from the retained good value, so a refresh failure never masquerades as current data. */
export function useKeyedLatest<T>(reader: KeyedReader<T>, key: string | null): T | null {
  const subscribe = useCallback((listener: () => void) => key === null ? () => undefined : reader.subscribe(key, listener), [reader, key])
  const snapshot = useCallback(() => key === null ? null : reader.getLatest(key), [reader, key])
  return useSyncExternalStore(subscribe, snapshot, () => null)
}
