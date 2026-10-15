import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import type { V2ChainId } from '../../v2/types'
import type { KeyedReader } from './read'
import { listsGateNow, type ListsGate, type ListsMode } from './source'
import { CREATED_POSITIONS, type CreatedPosition } from './createdPositions'
import { SESSION_RECEIPTS, type SessionReceipt } from './sessionReceipts'
import { USD_CURRENT_SECONDS } from '../usd'
import { usdAged } from './valuation'

const NO_CREATIONS: readonly CreatedPosition[] = Object.freeze([])
export function useCreatedPositions(wallet: string | null) {
  const subscribe = useCallback((listener: () => void) => wallet ? CREATED_POSITIONS.subscribe(wallet, listener) : () => undefined, [wallet])
  const snapshot = useCallback(() => wallet ? CREATED_POSITIONS.get(wallet) : NO_CREATIONS, [wallet])
  return useSyncExternalStore(subscribe, snapshot, () => NO_CREATIONS)
}

const NO_RECEIPTS: readonly SessionReceipt[] = Object.freeze([])
/** (2026-10-15, pack 8): this tab's session receipts of the wallet (./sessionReceipts.ts), as they are recorded. */
export function useSessionReceipts(wallet: string | null) {
  const subscribe = useCallback((listener: () => void) => wallet ? SESSION_RECEIPTS.subscribe(wallet, listener) : () => undefined, [wallet])
  const snapshot = useCallback(() => wallet ? SESSION_RECEIPTS.get(wallet) : NO_RECEIPTS, [wallet])
  return useSyncExternalStore(subscribe, snapshot, () => NO_RECEIPTS)
}

/**
 * The lists' gate per chain (./source.ts listsGate). Changed on purpose (2026-10-15, pack 8, the Positions page's first
 * visit): worked out in the first render (it is the origin's admission, known at once), so the list's first reads are
 * asked by the render that first draws it. It was null for that render and set by an effect a render later, which put
 * the portfolio's read (and with it every row's dollars) one render behind the site's own inventory. The return type
 * keeps its null for its callers.
 */
export function useListsGate(): ListsGate | null {
  const [value] = useState<ListsGate>(listsGateNow)
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

/**
 * Added 2026-10-14 (the incident of 2026-10-13, package V1; decision D4): whether each of `seen` (when this page took a
 * reading or an answer, by its own clock, ms; null or undefined never is) is older than a figure is current for
 * (./valuation.ts usdAged, ../usd.ts USD_CURRENT_SECONDS). Then nothing newer has arrived, and a figure worked out from
 * it says its time ("as of 13:05 UTC"). One failed read changes nothing: a figure is current for about two minutes
 * whatever the newest attempt did. Never a comparison of the page's clock with a server's (a device a few minutes off
 * would date every figure): only how long ago, here, it arrived.
 *
 * Changed on purpose 2026-10-14 (package V1, review): it was `useUnchangedFor(stamp, ms)`, which counted from the mount
 * of the component that asked. The readers keep the last good answer across remounts (./read.ts), so every way back to
 * a screen gave an old answer two more minutes as current (the list said "as of 13:05 UTC"; the position opened from
 * it showed the same 13:05 figures with no time). The moments are kept where the answers arrive (./positionSync.ts), so
 * an old one is old at mount; the component renders again by itself at the moment the next one crosses.
 */
export function useUsdAged(seen: readonly (number | null | undefined)[]): boolean[] {
  const [now, setNow] = useState(() => Date.now())
  const limit = USD_CURRENT_SECONDS * 1000
  // The next crossing ahead of what was last drawn; one already behind the page's clock is drawn a moment later.
  const next = seen.reduce<number | null>((soonest, at) => (typeof at === 'number' && at + limit >= now && (soonest === null || at + limit < soonest) ? at + limit : soonest), null)
  useEffect(() => {
    if (next === null) return
    // Past the crossing for certain, also where a timer runs a moment early.
    const timer = setTimeout(() => setNow(Math.max(Date.now(), next + 1)), Math.max(0, next - Date.now()) + 1)
    return () => clearTimeout(timer)
  }, [next])
  return seen.map((at) => usdAged(at, now))
}
