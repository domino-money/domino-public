/**
 * The Fees earned chart's periods on a screen (2026-10-02, the chart's periods back): whether a period of a position can
 * be drawn (its start known, being read, not readable now, or not offered), over the page's one past-reads runner
 * (spawn.ts pastReads, lib/fees/pastReads.ts). Subscribing is what asks for a period's start: a screen that shows it.
 */
import { useCallback, useSyncExternalStore } from 'react'
import type { FeesPeriod } from './periods'
import type { PastStatus } from './pastReads'
import { pastReads } from './spawn'

const OFF = (): PastStatus => 'off'

/**
 * `period` of `id` while the calling screen shows it; `null` asks nothing and stays 'off'. `fills`: the screen draws the
 * period (the chart), so its long stretches are filled too; false for its start alone (Your APR's last 24 hours).
 */
export function usePastReads(id: string | null, period: FeesPeriod, fills = true): PastStatus {
  const subscribe = useCallback((listener: () => void) => (id === null ? () => undefined : pastReads.subscribe(id, period, listener, fills)), [id, period, fills])
  const snapshot = useCallback(() => (id === null ? 'off' : pastReads.status(id, period)), [id, period])
  return useSyncExternalStore(subscribe, snapshot, OFF)
}

const listed = () => pastReads.listed()
const unknown = () => null
const onListed = (listener: () => void) => pastReads.onListed(listener)

/** Whether past reads can be made here: true, false, or null while that is being asked. */
export function usePastReadsListed(): boolean | null {
  return useSyncExternalStore(onListed, listed, unknown)
}
