import { useCallback, useSyncExternalStore } from 'react'
import { createActivityHistory } from './activityHistory'
import { LISTS_SOURCE } from './source'

const refresh = !(__DOMINO_TEST_HOOKS__ && typeof window !== 'undefined' && !(window as { __dominoRefresh?: boolean }).__dominoRefresh)
export const ACTIVITY_HISTORY = createActivityHistory((wallet, page) => LISTS_SOURCE.ownActivity(wallet, page), {
  set: (run, ms) => setTimeout(run, ms),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
  visible: () => !document.hidden,
  onVisible(run) {
    const wake = () => { if (!document.hidden) { document.removeEventListener('visibilitychange', wake); run() } }
    document.addEventListener('visibilitychange', wake)
    return () => document.removeEventListener('visibilitychange', wake)
  },
}, refresh)
const EMPTY = { answer: null, error: null, loading: false, more: false, catchingUp: false } as const

export function useActivityHistory(wallet: string | null) {
  const key = wallet?.toLowerCase() ?? null
  const subscribe = useCallback((listener: () => void) => key === null ? () => undefined : ACTIVITY_HISTORY.subscribe(key, listener), [key])
  const snapshot = useCallback(() => key === null ? EMPTY : ACTIVITY_HISTORY.get(key), [key])
  const history = useSyncExternalStore(subscribe, snapshot, () => EMPTY)
  return { ...history, moreRows: () => { if (key) ACTIVITY_HISTORY.more(key) } }
}
