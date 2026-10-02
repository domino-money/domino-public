import { STATE_REFRESH_MS } from './constants'
import type { FeeHistoryView } from './types'

/** Two normal refresh windows: tolerate one slow refresh, never refresh a snapshot's age by reading it from memory. */
export const HISTORY_CURRENT_MS = 2 * STATE_REFRESH_MS

/** A verified history proves its figures at a block, not that this block is still recent. Persisted copies are never current. */
export function historyIsCurrent(view: FeeHistoryView, now = Date.now()): boolean {
  if (view.phase !== 'verified') return false
  const age = now - view.state.timestamp * 1_000
  return Number.isFinite(age) && age >= 0 && age <= HISTORY_CURRENT_MS
}

/** Readiness describes the figure actually drawn; stale in-memory histories count as reused, just like saved snapshots. */
export function historyLoadQuality(view: FeeHistoryView, now = Date.now()): 'current' | 'cached' | null {
  if (view.phase === 'cached') return 'cached'
  if (view.phase !== 'verified') return null
  return historyIsCurrent(view, now) ? 'current' : 'cached'
}
