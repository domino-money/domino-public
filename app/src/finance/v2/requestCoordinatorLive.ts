import { realClock } from '../../lib/clock'
import { createAuthenticatedRequestCoordinator, type RequestBudgetStorage } from './requestCoordinator'

let coordinator: ReturnType<typeof createAuthenticatedRequestCoordinator> | null = null

/** The sole persisted values are admission timestamps and Retry-After deadlines, keyed by public account. */
export function coordinatedRequests() {
  if (coordinator) return coordinator
  let storage: RequestBudgetStorage | undefined
  try { if (typeof window !== 'undefined') storage = window.localStorage } catch { /* Private storage can be unavailable. */ }
  coordinator = createAuthenticatedRequestCoordinator({
    // Cross-tab admission timestamps are advisory; quote validity uses its separate monotonic clock.
    clock: { now: () => realClock.wallMs(), setTimer: realClock.setTimer },
    storage,
    ...(typeof navigator !== 'undefined' && navigator.locks
      ? { lock: <T>(key: string, work: () => T) => navigator.locks.request(key, work) }
      : {}),
  })
  if (typeof window !== 'undefined') {
    window.addEventListener('storage', (event) => {
      if (event.key?.startsWith('domino.request-budget.v1.')) coordinator?.wake()
    })
  }
  return coordinator
}
